/**
 * dsh-tool-watchdog —— 工具执行看门狗（真超时）
 *
 * 解决的问题（DSH 0.2.x 实测）：工具的超时与取消都是**协作式**的——
 *   · dsh-tool-call-timeout-policy 先 `await next()` 再判超时，工具不返回则超时永不触发；
 *   · dsh-tools 明示 "Cancellation never abandons the body"；
 *   · dsh-agent-loop 的 runGroup 循环（`while (inFlight.size > 0)`）没有 abort 退出条件。
 * 后果：只要有一个工具卡在不可中断的操作上，整个 turn 永不结束 → 会话永久"运行中"、
 * 停止按钮点了无效（cancel 同步返回 accepted 但效果不落地）→ 用户只能强杀 dsh。
 *
 * 本插件挂在 DSH 公开扩展点 `tools/execute`（waterfall）上做**真竞速**：
 * 预算耗尽即返回一个结构化错误结果，让会话解冻；同时尽力 abort 下游 signal——
 * 尊重 signal 的工具会真正结束，不尊重它的成为"孤儿"（仍在后台跑，被计数观测）。
 *
 * 设计约束：
 *   · **不注册任何工具** → 工具声明零变化 → 不破坏 KV 缓存前缀（本机另装 dsh-tool-freeze）。
 *   · 零轮询：每个工具调用一个 setTimeout，工具结束即清。
 *   · 豁免"等人"的工具（ask_user_question 等），避免误伤。
 *   · 调用方参数里声明的 timeout 优先（例如 job_output 的 timeout_ms），并留宽限。
 *
 * @module @dsh-external/dsh-tool-watchdog
 */

import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'cordis'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'tool-watchdog'
/** 依赖的工具注册表服务。 */
export const inject = ['tools']

/** 兜底预算：5 分钟。与 DSH 自身的 LLM 空闲看门狗（MESSAGES_IDLE 默认 3e5）同节奏。 */
const DEFAULT_TIMEOUT_MS = 300_000
/** 调用方在参数里给了 timeout 时的额外宽限（收尾/写盘用）。 */
const DEFAULT_PARAM_GRACE_MS = 60_000
/** 结构化错误码：本插件自有，便于重试策略/回放按 code 路由。 */
const TOOL_WATCHDOG_TIMEOUT = 'TOOL_WATCHDOG_TIMEOUT'

/**
 * 默认豁免名单：这些工具在**等人**（用户回答、子 agent、workflow），
 * 等待时长由人决定，**绝不能**被看门狗截断。
 */
const DEFAULT_EXEMPT = [
  'ask_user_question',
  'exit_plan_mode',
  'subagent',
  'subagent_fork',
  'workflow',
]

/** 工具参数里表达"我愿意等多久"的键名（调用方意图优先）。 */
const PARAM_TIMEOUT_KEYS = ['timeout_ms', 'timeoutMs', 'timeout']

/** 本插件的配置（cordis.patch.yml 的 config 段可覆盖）。 */
export interface WatchdogConfig {
  /** 总开关，默认 true。 */
  enabled?: boolean
  /** 兜底预算（毫秒），默认 300000；<=0 表示不设兜底。 */
  defaultTimeoutMs?: number
  /** 调用方参数超时的额外宽限（毫秒），默认 60000。 */
  paramGraceMs?: number
  /** 追加到默认豁免名单的工具名。 */
  exempt?: string[]
  /** 按工具名覆盖预算（毫秒），优先级高于兜底、低于调用方参数。 */
  perTool?: Record<string, number>
  /** 是否写诊断日志（stderr 与 $DSH_HOME/tool-watchdog.log），默认 true。 */
  verbose?: boolean
}

/** 解析工具调用的参数（可能已是对象，也可能是 JSON 字符串）。取不到就返回 undefined。 */
function parseArguments(raw: unknown): Record<string, unknown> | undefined {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw === 'string') {
    try {
      const value: unknown = JSON.parse(raw)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>
      }
    } catch {
      return undefined
    }
  }
  return undefined
}

/** 组装超时替换结果：结构对齐 DSH 的工具结果契约，措辞借鉴其 TOOL_OUTCOME_UNKNOWN。 */
function watchdogResult(toolName: string, budgetMs: number): unknown {
  const message =
    `tool call "${toolName}" exceeded the watchdog budget of ${budgetMs}ms and was detached from this turn.`
  return {
    content: [{
      type: 'text',
      text:
        `Error: ${message}\n` +
        'The session was unblocked, but the underlying operation may still be running.\n' +
        'Its outcome is unknown — do not retry blindly. Retry only if the operation is ' +
        'read-only or idempotent; otherwise verify external state first, or ask the user.',
    }],
    isError: true,
    error: {
      message,
      info: {
        name: 'ToolWatchdogTimeout',
        code: TOOL_WATCHDOG_TIMEOUT,
        timeoutMs: budgetMs,
      },
    },
  }
}

/**
 * 注册看门狗。挂在 `tools/execute` waterfall 上：解析预算 → 真竞速 → 超时替换结果。
 *
 * @param ctx - 宿主 Context（须已 provide `tools`）。
 * @param config - 见 {@link WatchdogConfig}。
 */
export function apply(ctx: Context, config: WatchdogConfig = {}): void {
  const enabled = config.enabled !== false
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const paramGraceMs = config.paramGraceMs ?? DEFAULT_PARAM_GRACE_MS
  const exempt = new Set<string>([...DEFAULT_EXEMPT, ...(config.exempt ?? [])])
  const perTool = config.perTool ?? {}
  const verbose = config.verbose !== false

  const logger = (ctx as { logger?: { warn?: (msg: string) => void; info?: (msg: string) => void } }).logger
  const logFile = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'tool-watchdog.log')

  let orphanCount = 0
  let orphanPeak = 0
  let detachedTotal = 0

  /** 诊断日志：stderr（经 ctx.logger）+ 追加文件；文件写失败绝不影响主流程。 */
  function note(line: string): void {
    if (!verbose) return
    try {
      logger?.warn?.(`[tool-watchdog] ${line}`)
    } catch { /* 日志失败不影响主流程 */ }
    try {
      appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
    } catch { /* 写盘失败忽略 */ }
  }

  /** 调用方在参数里声明的耐心（毫秒）；没有则 undefined。 */
  function paramTimeoutMs(exec: { arguments?: unknown; args?: unknown }): number | undefined {
    const args = parseArguments(exec.arguments ?? exec.args)
    if (args === undefined) return undefined
    for (const key of PARAM_TIMEOUT_KEYS) {
      const value = args[key]
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
    }
    return undefined
  }

  /** 解析本次调用的预算；undefined 表示不干预（直接放行）。 */
  function budgetFor(exec: { name?: unknown; arguments?: unknown; args?: unknown }): number | undefined {
    const toolName = typeof exec.name === 'string' ? exec.name : ''
    if (toolName === '' || exempt.has(toolName)) return undefined
    // 1) 调用方参数优先：尊重它声明的耐心，再加宽限。
    const fromParam = paramTimeoutMs(exec)
    if (fromParam !== undefined) return fromParam + paramGraceMs
    // 2) 按工具显式配置。
    const configured = perTool[toolName]
    if (typeof configured === 'number' && configured > 0) return configured
    // 3) 兜底。
    return defaultTimeoutMs > 0 ? defaultTimeoutMs : undefined
  }

  ctx.on('tools/execute', async (exec: unknown, next: () => Promise<unknown>) => {
    if (!enabled) return next()
    const target = exec as {
      name?: unknown
      arguments?: unknown
      args?: unknown
      signal?: AbortSignal | undefined
    }
    const budget = budgetFor(target)
    if (budget === undefined) return next()

    const toolName = typeof target.name === 'string' ? target.name : '(unknown)'
    const upstream = target.signal
    const controller = new AbortController()
    // 上游取消与本插件超时融合后交给工具：尊重 signal 的工具会真正结束。
    target.signal = upstream === undefined
      ? controller.signal
      : AbortSignal.any([upstream, controller.signal])

    let fired = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<unknown>((resolve) => {
      timer = setTimeout(() => {
        fired = true
        try {
          controller.abort(new Error(`tool-watchdog: detached after ${budget}ms`))
        } catch { /* abort 失败不阻断解冻 */ }
        resolve(watchdogResult(toolName, budget))
      }, budget)
      // 不因看门狗定时器而拖住事件循环/进程退出。
      if (typeof timer.unref === 'function') timer.unref()
    })

    // 工具真正结束（无论成败）都清定时器；rejection 继续向上传播。
    const work = Promise.resolve().then(() => next()).then(
      (value) => {
        if (timer !== undefined) clearTimeout(timer)
        return value
      },
      (error: unknown) => {
        if (timer !== undefined) clearTimeout(timer)
        throw error
      },
    )

    try {
      const outcome = await Promise.race([work, expiry])
      if (!fired) return outcome

      // 超时分支：work 仍在跑。计数为孤儿，并挂 handler ——
      // 既避免 unhandled rejection，也在它真正结束时回收计数。
      orphanCount += 1
      detachedTotal += 1
      if (orphanCount > orphanPeak) orphanPeak = orphanCount
      note(
        `detached "${toolName}" after ${budget}ms（孤儿 ${orphanCount}，峰值 ${orphanPeak}，累计 ${detachedTotal}）`,
      )
      const release = (): void => {
        orphanCount -= 1
      }
      work.then(release, release)
      return outcome
    } finally {
      target.signal = upstream
    }
  })
}

export { DEFAULT_TIMEOUT_MS, DEFAULT_PARAM_GRACE_MS, DEFAULT_EXEMPT, TOOL_WATCHDOG_TIMEOUT }
