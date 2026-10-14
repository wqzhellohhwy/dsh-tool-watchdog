# CHANGELOG —— dsh-tool-watchdog

面向 agent：只记**现状与可执行操作**。每条注明时间（精确到分钟）。

## 0.0.1 — 2026-10-14 21:40

新增（初始版本）。

- 文件：`src/index.ts`（无构建步骤，`main` 直指 `src/index.ts`）、`cordis.patch.yml`、`package.json`、`README.md`、`.gitignore`
- 挂点：`tools/execute`（waterfall），`inject: ['tools']`
- 行为：预算耗尽 → 返回 `isError` 结果（`error.info.code = TOOL_WATCHDOG_TIMEOUT`）并 `controller.abort()`；把未结束的工具记为孤儿（计数、写 `$DSH_HOME/tool-watchdog.log`）
- 预算优先级：调用方参数（`timeout_ms`/`timeoutMs`/`timeout`）+ `paramGraceMs`(60000) → `perTool[tool]` → `defaultTimeoutMs`(300000)
- 默认豁免：`ask_user_question`、`exit_plan_mode`、`subagent`、`subagent_fork`、`workflow`
- 不注册任何工具（工具声明零变化，不破坏 KV 缓存前缀）
- 环境：junction `node_modules/@deepseek-ai/{cordis,dsh-tools,dsh-llm,dsh-session,dsh-host-webserver}` → `C:\dsh-runtime\0.2.0-rc.2\node_modules\@deepseek-ai\*`
