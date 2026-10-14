# dsh-tool-watchdog —— 工具执行看门狗

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的工具调用加一个**真正会生效**的超时。

**一句话**：任何工具卡住，都不会再把整个会话冻死；你**不必再强杀 dsh**。

---

## 一、它解决什么问题

DSH 的工具超时与取消是**协作式**的 —— 系统只是给工具发一句"请停下"，然后**无限期等它自己收手**：

| 位置 | 现状 |
|---|---|
| `dsh-tool-call-timeout-policy` | 先 `await next()`，**工具返回之后**才判超时 ⇒ 工具不返回，超时永不触发 |
| `dsh-tools` | 注释明写 "Cancellation never abandons the body"（取消不抛弃正在跑的体） |
| `dsh-agent-loop` | 等工具收尾的 `while (inFlight.size > 0)` **没有 abort 退出条件** |

**后果链**：工具卡住 → 这一轮（turn）永不结束 → 会话永久"运行中" → 停止按钮点了无效（`session/cancel` 同步返回 `accepted`，但效果不落地）→ **只能强杀 dsh**。

**实测**（2026-08-15 ~ 10-14，241 个会话）：9 次「回合没正常结束就被进程终止」，其中 8 次现场就是「工具调用已写盘、结果永远没写盘」。卡住的工具：`dev_reload_package` 3 次、`pwsh` 2 次、`job_output` 2 次、`dev_inject_plugin` 1 次。**全部是本地重活，没有一个是网络工具。**

本插件挂在 dsh 公开扩展点 `tools/execute`（waterfall）上做**真竞速**：预算耗尽就返回结构化错误结果，**让会话立刻解冻**。

---

## 二、它做什么 / 不做什么

**做**：
- 预算耗尽 → 返回 `isError` 结果（错误码 `TOOL_WATCHDOG_TIMEOUT`），会话继续往下走
- 同时**尽力 abort 下游 signal** —— 尊重 `exec.signal` 的工具会**真正结束**
- 把不尊重 signal 的工具记为**孤儿**（仍在后台跑），计数并写日志

**不做**：
- ❌ 不真正杀掉底层操作（`pwsh` 子进程可能还在跑）。**孤儿会占资源**，用日志观测
- ❌ 不注册任何工具 → **工具声明零变化** → 不破坏 KV 缓存前缀（与 `dsh-tool-freeze` 共存友好）
- ❌ 不改变正常工具的语义（预算内路径与未装本插件时**完全一致**）

---

## 三、预算怎么算（优先级从高到低）

1. **调用方参数里的 timeout**（`timeout_ms` / `timeoutMs` / `timeout`）+ 宽限 60 秒
   —— 例如 `job_output {wait:true, timeout_ms:180000}` → 预算 240 秒。
   *注：该参数在 DSH 里实测**没有生效**（挂了 6.74 小时），本插件用参数值兜底正好补上这个坑。*
2. **`perTool` 显式配置**
3. **兜底 `defaultTimeoutMs`**，默认 **300000（5 分钟）**
   —— 比 `pwsh` 内建的 120 秒长，不抢它的活；与 dsh 自身 LLM 空闲看门狗（`MESSAGES_IDLE` 默认 5 分钟）同节奏。

**豁免（绝不截断）**：`ask_user_question`、`exit_plan_mode`、`subagent`、`subagent_fork`、`workflow`
—— 这些在**等人**，等待时长由人决定。

---

## 四、安装

作为 bundle 装配（推荐，随实例启动）：

```bash
dsh plugin --profile <profile> add 'link:/path/to/dsh-tool-watchdog'
```

或运行时注入（不碰配置、不重启）：用 `dev_inject_plugin` 指向本目录。

本插件**源码直跑**（`package.json` 的 `main` 指向 `src/index.ts`，本机 Node 原生支持 TypeScript 类型剥离），**没有构建步骤**。

---

## 五、配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: tool-watchdog
  config:
    enabled: true
    defaultTimeoutMs: 300000     # 兜底预算
    paramGraceMs: 60000          # 调用方参数超时后的宽限
    exempt: []                   # 追加豁免工具名
    perTool:                     # 按工具覆盖
      dev_reload_package: 120000
      dev_inject_plugin: 120000
    verbose: true
```

> ⚠️ patch 语义是**整字段替换**（不是深合并）：写了 `config` 就要把想保留的字段一起写全。

---

## 六、观测

- stderr（经 `ctx.logger`）：`[tool-watchdog] detached "pwsh" after 300000ms（孤儿 1，峰值 1，累计 1）`
- 文件：`$DSH_HOME/tool-watchdog.log`（一行一条，便于事后统计）

**读法**：`孤儿` 是当前仍在后台跑的数量（降回 0 说明卡住的操作最终自己结束了）；`累计` 是历史解冻次数。

---

## 七、已知边界

| 情况 | 行为 |
|---|---|
| 工具卡住且**不理会** signal | 会话解冻 ✅；底层操作变孤儿，仍在后台跑 ⚠️ |
| 工具卡住但**尊重** signal | 会话解冻 ✅ 且工具真正结束 ✅ |
| 模型看到"超时"想重试 | 错误文本明确写"不要盲目重试，先验证外部状态" |
| `ask_user_question` 等等人的工具 | 豁免，不受影响 |
| 工具声明了自己的 `timeoutMs` | 本插件不读它（只按参数/perTool/兜底），避免与官方 timeout-policy 语义打架 |

---

## 八、目录

```
package.json        包声明（dsh.bundle.patch → cordis.patch.yml）
cordis.patch.yml    bundle 层：把本插件插进 profile 组合
src/index.ts        全部实现（无构建步骤）
```
