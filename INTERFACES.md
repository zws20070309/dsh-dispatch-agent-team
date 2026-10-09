# 接口冻结文档（v1）—— 实现者必须严格遵守

> **注意：时效性（2026-09-28 修订）**：本文件冻结于 2026-09-27 17:35，代码在 2026-09-28 01:4x 做过一次
> 整体改造（12 角色 / 共享队员卡 / 队员工具收窄 / 配置页 revision CAS）。**下面 §0.1 是勘误表：
> 凡与勘误表冲突，一律以 `lib/` 现行代码与勘误表为准。** 各被否证的章节内也加了行内提示。
> 未列入勘误表的条目（例如 webServer / dsh-commands / dsh-llm / `plugins.bundle.config` 槽位 /
> `agent/request` payload 形状）已逐条复核过，仍然有效。

本文件由 Lead 冻结。**不要修改本文件，也不要修改已存在的 `lib/roster.js` / `lib/playbook.js` /
`package.json` / `cordis.patch.yml` / `presets/*.yml`**。需要接口变更时向 `lead` 发消息。

## 0.1 勘误表（2026-09-28 起；44 条，全部有 `file:line` 依据）

| # | 本文档原文位置 | 现在的真相 |
|---|---|---|
| 1 | §0:18-19「可以直接 import 的只有 dsh-tools 与 dsh-experimental-agent-team」 | `lib/tools.js:22-34` 允许的静态 import **只剩** `@deepseek-ai/dsh-tools` 与 `./` 内部模块；`TeamTaskId` 已本地实现，不再 import 官方包 |
| 2 | §0:9-11 的 0.1.5/0.1.7 判断 | **正确**，但要补一条：从插件目录 `import.meta.resolve('@deepseek-ai/dsh-llm')` **是成功的**（解析到全局 CLI 的 0.1.5 副本），失败模式不是 `ERR_MODULE_NOT_FOUND` 而是**静默绑到另一份模块实例**。所以「不要 import」这条结论仍成立，理由要按这句写 |
| 3 | §1:28 的 `ROLES` 与 §1 导出清单 | 现在是 **12 个角色**（`lib/roster.js:29-198`），并按工作流阶段排序；另新增 7 个导出：`TEAM_TOOL_NAMES` / `LEAD_ONLY_TEAM_TOOL_NAMES` / `MEMBER_TEAM_TOOL_NAMES` / `TEAMMATE_TOOL_DENY` / `TEAMMATE_SECTION_MUTES` / `LEAD_TEAM_TOOL_NAMES`（Lead 的完整工具名单 = 官方九个 + `wake_teammate`）/ `WAKE_TOOL_NAME`（2026-10-01 新增，见第 38 条） |
| 4 | §2:45 `teammateCard(roleId)` | **该 API 已删除**。现在是与角色无关的常量 `TEAMMATE_CARD`（`lib/playbook.js`）+ 角色简报 `teammateBrief(roleId, name)`（走 Lead 派活提示词）。理由见 MAINTAINER-NOTES.md §4.5 |
| 5 | §3:56「所有函数都接受宿主 ctx 作为第一个参数」 | 与同段签名自相矛盾：`peekConfig()` / `isEnabled(agent)` / `status(agent)` / `peekRevision()` 都不收 ctx |
| 6 | §3.1:80/85 策略段与队员卡段 `order: 60` | **代码是 600**（`lib/runtime.js` 的 `TEAM_POLICY_ORDER` / `TEAMMATE_CARD_ORDER`），官方槽位 `TEAM_POLICY = 600`（dsh-system-prompt `SECTION_ORDERS`）。按 60 实现会把两段插到错误位置 |
| 7 | §3.1「顺序固定」清单 | 队员侧现在多了三步：**清空工具用法段**（`muteToolSections`）、**收窄继承面工具**（`restrictTeammateTools`）、**只注册队员子集团队工具**（`MEMBER_TEAM_TOOL_NAMES`） |
| 8 | §3.1:81/86 + §4:135/167-168「队员也是九个团队工具」 | 队员有 **9 个**（九个减去 `spawn_teammate` / `interrupt_agent`，再加队员专用的 `report_result` 与 `ask_lead`），见 `MEMBER_TEAM_TOOL_NAMES` |
| 9 | §3.2:100-107、319-325「监听器必须写成」 | 现行实现多两件事：本次 spawn 的**显式路由钉** `spawnRoutes`，以及**只有模型真的广告该档位才写** `reasoningEffort`（`effortAdvertised`） |
| 10 | §3.3:120-122「`prepareDocument()` 取 dirname 即 DSH 主目录」 | **错**。`prepareDocument()` 返回的是 **profile 的 patch 路径**；现行实现按 `<home>/profiles/<profile>/<file>` 剥三段，再用 `<候选>/profiles` 是否为目录确认（`lib/runtime.js` 的 `resolveDshHome`） |
| 11 | §4:164「identity prefix 照抄官方英文」 | 已整体替换为中文 `teammateBrief`（`lib/playbook.js`），并且把角色简报拼在 Lead 写的任务正文**之前** |
| 12 | §4:169-170「`TeamTaskId` 从官方包 import」 | 已本地实现（`lib/tools.js`），drift-check 会持续校验官方是否仍是恒等函数 |
| 13 | §4:182 `teamToolDefinitions({runtime, agentTeams, config})` | 多一个可选 `include`（工具名单子集），队员侧用它过滤 |
| 14 | §4:184 `TEAM_TOOL_NAMES` 定义在 tools.js | 真值已搬到**零 dsh 依赖**的 `lib/roster.js`（这样 selftest / drift-check 能直接读），`lib/tools.js` 只做转发 |
| 15 | §5:191 `inject = ['systemPrompt','commands','tools','agents','agentTeams']` | **代码是 `['systemPrompt']`**（`lib/preset.js`）。多声明会让「那条可在插件页被关掉」变成整个 preset 半不 apply |
| 16 | §4:172 + §5.2:211-217 + §5.3:248「命令与开关工具注册在 preset scope」 | **错，而且危险**：它们现在注册在**宿主平面**（`lib/preset.js` 的 `registerControls()`，由 `lib/index.js` 调用），`apply()` 只注册一个提示词段。在 preset 子树里发布能力/注册命令会把整份 preset 判成 broken（README §8.2 的事故） |
| 17 | §6:258 `exports.inject = ['slots']` | 现在是 `['slots','locale']`；§6:275 签名里的 `subject` 不存在（官方只给 `plugins.detail.*` 传 subject）；§6:291 的 `N/7` 现在是 `N/12`（动态 `roles.length`） |
| 18 | §6:279-290 ops 响应形状 | `get` 现在额外返回 `revision` / `diagnostics`；`set` 支持 **revision CAS**（不一致时 `{ok:false, conflict:true, revision}`）；`reset` 也返回 `revision`。只按本文档实现客户端会丢掉乐观并发保护 |
| 19 | §5:191 / §5.2 / §5.3「控制面取服务的方式」 | **2026-09-28 的真实故障**：cordis 的 ctx 属性访问要求服务在**本 fiber 的 inject 列表**里，而宿主平面的 `commands` / `tools` 是**兄弟 fiber**（`dsh-base/cordis.patch.yml:286` / `:461`）提供的 → `ctx.commands` 抛 `cannot get property "commands" without inject`，异常被 try/catch 吞成一条 warn，于是插件正常加载、配置页正常，但 **`/team` 与两个开关工具全部消失**。现行写法：`lib/preset.js` 用 `ctx.inject(['commands','tools'], cb)` + `serviceOf(ctx, name)`（优先 `ctx.get`）。对照物：mcp-manager 把所有服务都写进了 inject（`lib/index.js:17`）。详见 README §8.3 |
| 20 | §5.2 / §5.3「命令与开关工具注册在 preset scope」+ 命令清单 | **用户 2026-09-28 划的边界，现已落地**：控制面**必须**注册在调度模式的 preset 子树（`lib/preset.js` 的 `apply`）——「在哪个作用域 `register` 就注册进哪个层」：preset 层 = 只有该 preset 的会话可见；宿主平面 = 全局层 = **所有 preset 都能看到**（这正是当时的越界：极简灰度也能调 `/team`）。`lib/index.js` **不再**注册任何控制面。命令只剩 **`/team`**，**`/team-off` 已删除**（关闭团队走 `disable_agent_team` 工具）。另加运行时断言 `assertDispatchPreset`（`lib/runtime.js`）：`enable()` 读 `agentPresets.composedPreset(agent.ctx)`，不是 `dispatch-mode` 就拒绝并给出可执行提示 |
| 21 | §0:53-57「判据以 0.1.7 的解包物为准」 | 桌面端已升级：`app.asar` 根包是 **`@deepseek-ai/dsh-desktop@0.2.0-rc.1`**，运行时 **`@deepseek-ai/dsh-desktop-runtime@0.2.0-rc.1`**（不再是 0.1.7-rc.2）。本文档里 0.1.7 的行号是**取证快照**（写这些行时跑的确实是 0.1.7-rc.2），现行判据是 0.2.0-rc.1 的 `app.asar`；`tools/drift-check.cjs` 开头会把**宿主版本**与**插件依赖（junction）版本**一起打出来。2026-09-28 对着 0.2.0-rc.1 逐条复核：官方 agent-team 三包与三行 id、九个工具名、域服务全部被调用方法、`agent/request` waterfall、`ctx.llm` 三方法、命令名正则、`plugins.bundle.config` 槽位、`restrict` 语义、`TeamTaskId` 恒等性 **全部未变**（drift-check 29/29）；新增两条闸门见第 22、23 条 |
| 22 | §0:59-64「`defineTool` 在 0.1.5/0.1.7 都接受我们的形状」 | 补一条**跨版本耦合**事实：本插件静态 import 解析到的仍是 junction 那份 **0.1.5-rc.2**（`<npm 全局目录>\...\node_modules\@deepseek-ai\dsh-tools`），而宿主是 **0.2.0-rc.1**。两份 `defineTool` 逐句比对结论：0.2.0 只多 `projectContent` / `deferLoading`（我们都没用），`parameters` / `output.render` / `execute` / `ToolArgsError` 校验逐句相同 → **今天不丢功能**；但这是**静默**耦合（旧实现编译工具对象，新宿主消费）。新增闸门：drift-check 逐个断言这 8 个依赖字段在**两份源码**里都存在，任一份少了就 FAIL |
| 23 | §0.1 第 18 条（§6:279-290 ops 响应形状） | `get` 现在把**故障**与**信息**分成两条通道：`diagnostics`（真故障 → 页面渲染成「配置文件可能有问题」的红色告警）与 `notes`（正常事实：DSH 主目录、配置文件路径、控制面注册结果、团队开/关回执、安装回执）。同两份也落进状态文件（`dispatch-agent-team-status.json` 的 `diagnostics` / `notes`）。为什么必须分开：把「一切正常」的事实写进故障通道，页面就会在**没有任何问题**的时候常驻一条红色告警（用户 2026-09-28 的截图，见 README §8.4） |
| 24 | §0.1 第 10 条（§3.3`resolveDshHome`） | 定位 DSH 主目录 / 配置文件路径的两个函数原先有 **check-then-act 竞态**：判断（`state.home !== undefined`）在 `await settings.prepareDocument()` **之前**，赋值在 await **之后**；而宿主启动时 `apply()` 会 fire-and-forget 地同时起两条路径（`lib/index.js:282` 的 `loadConfig` 与 `lib/index.js:336→:369` 的 `getConfigPath`），第二个调用者从同一个窗口挤进来把同一次定位重算并重记一遍 → 截图里「主目录 ×2 + 配置文件 ×2」。现行实现把「进行中的那一次」用 promise 缓存（`homePromise` / `configPathPromise`），并发调用共享同一次；回归测试用**独立模块实例**在 `tools/integration-test.cjs` 复现两种时序（同 tick 结算 / 隔 tick 结算） |
| 25 | §0.1 第 16、20 条与 §5「控制面/patch 的关系」 | **patch 层的顺序是语义的一部分（2026-09-28 的 P0）**。官方 `agent-team-profile` 的 patch 用 `- insert:` **新建** `agent-team` / `tool-agent-team` / `ui-agent-team`；patch 层按 `dsh.profile.bundles` 顺序应用（`dsh-app-boot` 的 `loadProfileDirectory` → `readProfilePatches` → `composeEntries`），而 DSH 插件页启用 bundle 时是 **append**（`dsh-plugin-manager` 的 `selectBundle`）。所以本包 patch 里的 `- id: tool-agent-team, disabled: true` 与 `- id: agent-team, config: {maxMembers: 48}` 在本机**都是静默无效的**（我们的 bundle 排在官方之前）→ 有效 `maxMembers` 退回官方默认 **8**（roster 是历史累计，8 次 spawn 后派不出人）。现行做法：**容量覆盖落在 profile 自己的 `cordis.patch.yml`**（在所有 bundle 层之后应用，`tools/repair.cjs --apply` 维护，`repair.cjs` / `drift-check.cjs` 都校验两份一致），本包 patch 里**不许**再出现顺序依赖的 `disabled` |
| 26 | §0.1 第 16、20 条（官方团队面的关闭方式） | 官方**工具面/策略段**不再靠 bundle patch 关闭，而是在**调度模式的 preset 作用域**里抑制（`lib/preset.js` 的 `suppressOfficialTeam`）：逐个 `tools.restrict({ deny:[TEAM_TOOL_NAMES] })` 摘掉九个**同名**的官方工具（restrict 只过滤**继承面**；本作用域自己注册的 `/team`+开关工具与更深作用域自己注册的队员团队工具不受影响），再注册同名空段遮蔽 `team:policy`（`renderPrompt` 丢空段，`lib/client.js` 无关）。结果是**只有调度模式**看得到/继承不到官方那一套，**别的 preset 照旧**（这修正了第 16/20 条里「关闭官方工具行」的说法）。官方 **UI 行与域服务行保持启用**；新增常量 `OFFICIAL_TEAM_POLICY_SECTION = 'team:policy'`（`lib/roster.js`，官方段名真值） |
| 27 | §3.1「顺序固定」清单（第 7 条） | 补一条**注册陷阱**：`ctx.effect(() => ctx.systemPrompt.section(...))` 里用**属性访问**取服务会按 **effect 回调所在 fiber** 的 `inject` 列表判定合法性 —— 回调与 `apply` 不是同一个 ctx，可能抛 `cannot get property "systemPrompt" without inject`，于是整段 PLAYBOOK **静默消失**（只留一条诊断）。现行写法：先在 `apply` 里 `serviceOf(ctx,'systemPrompt')` 取好服务再进 effect（`registerControls` 早就是这个手法）。集成测试断言「调度模式的提示词里**有** PLAYBOOK」，这条就是它的闸门 |
| 28 | §0.1 第 26 条（官方团队面的关闭方式） | **第 26 条的做法被实测否证并已改掉**：官方九个团队工具**不在全局层** —— `dsh-experimental-tool-agent-team/lib/index.js:539-546` 的 `maybeInstall` 给**每一个** live agent 装进**它自己的 agent 作用域**（:225 注释逐字原话 "Team tools are registered only in an exact Agent scope"；:229 是近义句），而域服务 `tryMembership`（`dsh-experimental-agent-team/lib/index.js:397-426`）对任意非子代理 agent 都返回 `{role:"lead"}`。所以 preset 作用域的 `tools.restrict({deny:[名字]})` **必然全部失败**（restrict 只认全局层：`names unknown global tool "x"`；用户看到的就是那 9 条红字），而且 restrict 从不影响本作用域自己的注册。现行做法：**profile 的 patch 层整行 `disabled: true` 关掉官方 `tool-agent-team`**（`tools/repair.cjs --apply` 维护，顺序无关），调度模式只保留「同名空段遮蔽 `team:policy`」；`drift-check` 禁止 `lib/preset.js` 里再出现 `restrict`。注意：附带事实：两边**同名同作用域**会抛 `tool "x" is already registered in this scope`，即官方行开着时本插件的九个工具**装不上**（角色/模型参数全丢）—— `lib/runtime.js` 的 `installTeamTools` 现在把这种情况记成**故障**（红色通道）并给出修法 |
| 29 | §0.1 第 20 条（`/team-off` 已删除） | 补一条**会话日志的硬约束**，它决定了「删命令 ≠ 删历史」：会话日志 append-only 且 **seq 必须从 0 连续** —— `dsh-session/lib/types/surface.js:400`（`session event seq N is not contiguous; expected M`）、`dsh-session-persistence/lib/index.js:230`（`append seq mismatch`）、`dsh-session/lib/types/index.js:429`（seed 要求 `seq === index`）。所以「旧会话里已渲染的斜杠命令气泡」**不能靠删事件消除**（会让整份会话读不出来，重新编号还要动 `messageSeqs` / `sourceEventSeqs` / 投影缓存）。判「历史 vs 活命令」的唯一判据是会话日志里的 `command/run`：`tools/history-audit.cjs`（只读）一次给出时间线 + 与现行 `lib/` mtime 的对比 |
| 30 | §0.1 第 21 条（0.2.0 逐条复核） | 追加两条 **0.2.0-rc.2** 实测事实（本轮从 `app.asar` 解包核对，12 967 文件 / 372 MB 全量）：① `dsh-experimental-agent-team` / `tool-agent-team` / `client-ui-agent-team` / `agent-team-profile` **不含任何斜杠命令注册**（`name:`/`registerCommand` 零命中，只有注释里的 task commands）→ 命令面 `team` 100% 属于本插件，`/team-off` 在任何官方版本里都不存在；② 全量扫 `team-off` **0 命中**。据此，页面上再出现 `/team-off` 只可能是**旧实例或旧会话历史**，不可能是官方行为 |
| 31 | §7.5 `ctx.llm`（新增低层 API） | **`llm/stream` 瀑布与 `ctx.llm.stream(options)`**（缓存保活用，0.2.0-rc.2 实测）：`dsh-llm/lib/index.js:2367-2372` 的 `stream(options) { return this.streamWithRegistration(options) }` → `:2371` `this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared))`。监听器签名 `(options, next)`，**必须把 `next()` 的结果原样交出去**（可包一层但不得改内容）；`options` 至少含 `{provider, model, messages, tools?, system?, maxTokens?, temperature?, reasoningEffort?, stop?, signal?}`（`:2314-2320` 的 projectedOptions）。`dsh-agent-loop/lib/index.js:1072` 是真实调用点（`this.loopCtx.llm.stream(request)`）。因此插件**可以**在进程内发一次与真实请求同前缀的调用；本插件只用它做「1 token 续缓存」（`lib/cache.js`），且对非 Lead 请求完全旁路。drift-check 有两条闸门钉住这个事件名与 dispatch 形状。**另需注意作用域语义**：dsh-llm 的 thisArg 是 Llm 服务实例（不带 `Context.filter`），而 cordis 的 dispatch 是 `hook.global \|\| !filter \|\| filter.call(thisArg, hook.ctx)`（`@deepseek-ai/cordis/lib/index.js:258-264`）——**没有过滤器就是全局广播**，所以插件在 `apply(ctx)` 的子作用域里注册也能收到 `llm/stream`；集成测试用「子作用域注册 + 父作用域派发」把这条前提钉住了。`dsh-scope` 只对带 agent 的派发（`agent/request` 等）做过滤 |
| 32 | §7.5（usage 形状） | **provider 上报的缓存字段叫 `cacheReadTokens` / `cacheWriteTokens`**：`dsh-token-meter/lib/types/usage-projection.js:14-18` 的分桶（`uncachedInputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`），来源是会话事件 `assistant/message` 的 `data.usage`（`index.js:391-394`）与助手流里的 `usage` chunk（`turn-usage.js:19-21`）。**「这条线路有没有缓存命中」的唯一判据就是 `cacheReadTokens > 0`** —— 本插件的 auto 模式与「连续未命中即停」都读它，面板显示的命中率也是它（`lib/cache.js` 的 `foldUsage` / `hitRatio`） |
| 33 | §4（团队工具） | **`ctx.agentTeams.sendMessage(caller, {target, content, signal})`** 是官方 `send_message` 工具的实现（`dsh-experimental-tool-agent-team/lib/index.js:312-319`）→ 插件可以让**工具自己**把结构化报告投递给 Lead，而不是要求队员再手动发一条（`lib/tools.js` 的 `report_result`）。`content` 是 DSH 的消息块数组（`[{type:'text', text}]`），`caller` 必须是 peer 身份（用 `exec.agent`） |
| 34 | §3.1 / §4（工具定义） | **`defineTool` 的输出 schema 里每个 `type:'object'` 都必须显式写 `additionalProperties`**，否则注册期直接抛 `unsupported JSON schema: schema.additionalProperties must be explicitly true or false` —— 而这个错发生在**安装**路径上：整个 Agent 的团队工具都装不上（2026-09-30 真踩，集成测试表现为「队员缺 7 个团队工具」）。参数里的数组形状是 `{type:'array', items:{type:'string'}}`（官方 `team_task_create` 同形）。drift-check 现在会扫 `lib/tools.js` 里所有 `*_SCHEMA` |
| 35 | §3.1（工具面变化是**日志事件**） | 会话里那行「移除：spawn_teammate, team_task_create, …」不是 UI 文案，而是**开发消息**：`dsh-agent-loop/lib/index.js:1202-1248` 在每次 `request/header` 落盘时，把当前组装出的工具名集合与**上一次 header** 比差集，非空就 append 一条 `developer/message`（`source.kind = 'tool-registry'`，内容块 `tool-addition` / `tool-removal`）。UI 由 `dsh-client-ui-chat` 的 `ContextInjectionRow` 渲染（`message.toolsRemoved` = `移除：{names}`，`client.js:6035` 附近与 `:5477`）。**判据**：它出现 = 该请求的工具面与上一次**真的不同**；它**不**说明工具被卸载（2026-10-01 的根因是宿主重启后**没再装上**，见第 36 条）。排查入口：`node tools/session-probe.cjs --tools`（逐条 header 的工具名与增删） |
| 36 | §5（agent 生命周期与 id） | **`agent.id === agent.session.id`**，且重启/恢复会话时 `agent/created` 会**重发一次**：`dsh-agent/lib/index.js:512` 明确 `if (id !== agent.session.id) throw …`；`dsh-agent-loop/lib/index.js:1748-1752` 先 `sessions.enter` / `agents.enter` 再 `agents.announce(agent, source, signal)`，`source` 在启动路径是 `"startup"`（`:1867`）、在持久化会话恢复路径是 `"resume"`（`:1970`）。因此插件可以「按会话 id 记住团队开关，重启后在 `agent/created` 里同步补装」——**同步**很关键：`announce` 是 serial 分发、首个 turn 在它之后才投递，所以恢复后的**第一个** request header 就带上团队工具（否则用户会先看到一行「移除：…」再看到它们回来）。实现见 `lib/resume.js`，集成测试 §8.2 用「新模块实例 + reconcileAgents」复刻整次重启 |
| 37 | §7.5（同名工具的真实来源） | **`send_message` / `interrupt_agent` / `list_agents` 这三个名字由官方 `@deepseek-ai/dsh-tool-subagent-control` 在宿主平面提供**：`lib/index.js:22-92` 注册 `send_message`（参数 `agent_id` **required**；输出 render 是 `message delivered to agent ${args.agent_id}`）与 `interrupt_agent`；`lib/types/list-agents.js:1971` 的 `name: 'list_agents'` 走可独立加载的子模块。我们那三个同名工具在更深的作用域里**遮蔽**它们，所以「我们的安装消失后露出来的是官方那份、参数形状不同」——2026-10-01 现场 `send_message({agent_id,…})` 成功、而 `{message}`（我们的形状）报 `missing required property "agent_id"`，两种形状在同一个会话里先后出现就是这个原因。对策：`lib/tools.js` 的 `resolveTarget()` 同时收 `target`（队员名）与 `agent_id`，并按名字翻译（官方域服务的 `resolveActiveMember` **只认名字**：`dsh-experimental-agent-team/lib/index.js:350-362`） |
| 38 | §3.2（斜杠命令的注入与显示） | **命令的可见文案与注入文本**：`parseCommand` 的 `rawInput = line.slice(match[0].length)`（`dsh-commands/lib/types/index.js:73-82`，注释写明「不规范化尾部输入」）；handler 必须返回 `{kind:'success'\|'error', text?}`（`:171-200`，**success 允许不带 text**）。客户端 `GenericCommandCard` 只在有 text 时显示「>_ <name> · <text>」，没有就退回中性文案 `command.done`（`dsh-client-ui-chat/lib/client.js:6035-6110`）。因此 2026-10-01 起：`/team` 成功结果**不带 text**（用户要求别再出现「智能体团队已开启…」那行），注入给 Lead 的 user 消息就是**用户原文那一行** `/team …`（`lib/playbook.js` 的 `teamCommandLine`），不再改写成 `[系统] …` 长段落；模型自己调 `enable_agent_team` 时**不再注入任何消息**（状态说明走工具返回值，见第 40 条）。**`enableInstruction(rawInput)` / `ENABLE_INSTRUCTION` / `DISABLE_INSTRUCTION` 这三个导出都已删除**，由 `teamCommandLine()` + `wakeInstruction()`（`wake_teammate` 的正文）取代。命令生命周期仍落 `command/run`（含 `args = rawInput`）与 `command/done`（`:302-327`） |
| 39 | §7.5（插件往会话日志写自定义事件） | **仓库外事件必须带 `ignorable` 标记**才会被持久化读路径解释：`dsh-session/lib/types/known-event-types.js:7-20` 原话「Downstream (out-of-repo) plugin events are outside this list by construction… The persisted `SessionEvent.ignorable` marker is the compatibility mechanism；event-name registration was rejected」。本插件因此**不**往会话日志写自定义事件：「哪个会话开着团队」存在插件自己的小文件 `<DSH 主目录>/dispatch-agent-team-sessions.json`（`lib/resume.js`：TTL 7 天 / 上限 200 条 / 原子写 / 读写失败只记诊断），用户显式关团时立刻删除该条记录 |
| 40 | §5（给 agent 投递消息的三种语义） | **`agent.send(message, target, wakeup)` 的三个目标不是一回事**（`dsh-agent-loop/lib/index.js:800-814`）：`followup(input)` = `send(input, 'next-turn', true)`、`steer(input)` = `send(input, 'next-step', true)`、`inject(input)` = `send(input, 'next-step', false)`。**`next-turn` 那一条会显示在用户界面上**：客户端 `QueueDock` 从 Session 的 `inbox` 投影**读取 `next-turn`**（`dsh-client-ui-conversation/README.zh.md` 原话），用户在输入框上方看到排队行、还要点「插入/插话」——2026-10-01 18:26 我们注入的「团队已开启」就是这么跑到用户输入框里的（用户原话：「不要突然排队一句话行不？」）。**判据**：只有**用户自己打的字**才允许走 `followup`（本插件只有 `/team` 的注入）；插件想让模型知道的状态一律放进**工具返回值**，要打断当前轮用 `steer`。另：系统提示词与工具目录**每个 step 重新组装**（`:907` 的 preStep → `systemPrompt.assemble()`，`:1063` 的 `buildRequest(…, assembly.tools, …)`），所以「开团后必须注入一句提醒」这个前提本身是错的。drift-check 有闸门钉住这三条 |
| 41 | §4（队员的模型/强度覆盖） | **队员模型覆盖的优先级**（2026-10-01 修正）：只有 `spawn_teammate` 的**显式参数**（`provider`+`model` / `reasoning_effort`）才允许被钉住（`lib/runtime.js` 的 `spawnRoutes` 与 `spawnEfforts` 两个账本，agent 销毁时清空）；**角色配置必须每次请求实时读**（`resolveRoleRoute(peekConfig(), role)`），合成用纯函数 `resolveMemberRoute(explicit, roleRoute, explicitEffort)`（`lib/roster.js`），返回 `undefined` = 不覆盖 = 跟随 Lead。旧写法把**角色配置解析出来的路由**也钉进 `spawnRoutes`，于是「跟随 Lead」/改配置对**已经在跑的队员**永远不生效（用户 2026-10-01 报的：面板改回「跟随 Lead」后队员仍跑 spawn 时刻的旧模型）。对照事实：官方 `spawn` provider 让子代理**每请求**跟随父代理当前选择（用户日志里 `red-team` 在 Lead 换模型后 2 分钟内跟着换），所以「不覆盖」就是正确的「跟随 Lead」；而 `spawn_teammate` 显式给的路由仍必须真的生效，否则返回值里的 `route` 是假的 |
| 42 | §0.1 / §7.5（**本轮审查新增的官方事实，全部从 0.2.0-rc.2 的 `app.asar` 复核**） | ① **`ReactLoopAgent` 实例上没有 `name` 字段**（`dsh-agent-loop/lib/index.js:747-789` 的构造只赋 `id`/`session`/`options`/`ctx`）：任何「从 agent 拿名字」的写法都会拿到 `undefined`，队员名只能从 `ctx.agentTeams.tryMembership(agent)` 取——它返回 `{role, name, id, root}`（`dsh-experimental-agent-team/lib/index.js:405-410`）。本插件唯一踩这个坑的是 `report_result` 的报告头（已改为从 membership 取，`lib/tools.js` 的 `callerName`）；派活署名那条**不是缺陷**——`installMember` 一直用的就是 `membership.name`（`lib/runtime.js:1045-1053`），审查时被否证的子代理结论不再照抄。 ② `session/event` 是**不按 agent 过滤的全局广播**（`dsh-scope/lib/invariant.js:26` 把它标为 `null`），官方 agent-team 自己就监听它（`:1720-1722`），所以插件可以合法地用它记账：`turn/end` 的 `reason.kind === 'max-tokens'`（`:1151` 产生、`:979` 聚合、`:1027-1030` 落事件）现已驱动 §2.6 的截断标志。 ③ `agentPresets.compositionInventory()` 在**任何 await 之前**同步快照各 preset 的定义（`dsh-agent-preset-registry/lib/index.js:793`），所以状态文件里 preset 行内容的「准」只取决于快照时刻——本插件改为 boot/settled 两阶段写 + `ctx.loader.await()` 事件时机（官方先例：`dsh-app-boot/lib/index.js:3489`、`:4084`）。 ④ `ask_user_question` 对委派调用者是**硬拒**：`dsh-user-questions/lib/index.js:531-535` 的 `assertLiveRoot` 抛 `DELEGATED_CALLER`，但弹窗已在宿主全局排队；因此它进了 `TEAMMATE_TOOL_DENY`。 ⑤ `mountPreset` 只在 preset 的 `activate()` 里调一次（`:262`、`:534`），`agent/bind`/`session/join` **不会**重放它——「preset 子树每会话跑一次」是错的，实测口径见 README §6.1。 |
| 44 | §3.5（技能）与 §3.1 第 4 步（队员收窄） | **`skill` 对队员是「能用且目录自动注入」，不是「按名字点名才可用」**（2026-10-07 查证并补闸门）。① 工具来源：preset 行 `skill-filesystem` + `tool-skill`（`presets/dispatch-mode.patch.yml:142-146`），**不在** `TEAMMATE_TOOL_DENY` 里（`lib/roster.js:472-482`）；`lib/tools.js:621-622` 的 `include` 只过滤本插件自己那 15 个团队工具（注释原话「名单外的工具连 schema 都不注册」），**不动** preset 继承来的工具面。② 目录注入：`dsh-tool-skill/lib/index.js:203-236` 挂在 `agent/pre-step`，注入一条 **user 消息**（`source.kind = "skill-catalog"`，内含 `<available_skills>`，描述截 500 字符），判据是 `:207` 的 `ctx.tools.get("skill", agent) === skillTool`——**身份比较**，即「谁能调这个工具，谁才有目录」；该事件按 agent 过滤（`dsh-scope/lib/invariant.js:17` `"agent/pre-step": (args) => args[0]["agent"]`），所以每个 agent 各一份，队员也有。③ 因为是 user 消息而非系统提示词段，队员共用的提示词前缀**不受影响**（§2 的缓存纪律 / `TEAMMATE_CARD` 逐字节相同仍成立）。④ **失效方式**：把 `skill` 加进 `TEAMMATE_TOOL_DENY` 会让队员**同时**失去工具与目录，而插件照常加载、`/team` 照常可用——与 2026-10-07 修掉的「`/team` 静默拒收附件」同类，故新增 `drift-check` 12g 五条 + `integration-test` §2.5 五条（含负对照：显式 `deny: ['skill']` 后工具与目录同时消失）。⑤ 附带事实：`SKILL.md` 写 `disable-model-invocation: true` 时不进目录（`:217` 的 `filter(isModelInvocable)`），按名字调**直接抛错** `skill "X" is not available for model invocation`（`:147`/`:150`）；旧键名（`disableModelInvocation` / `modelInvocable` / `userInvocable`）被官方拒掉（`dsh-skill-filesystem:850-852` 报 unsupported），只能用短横线写法。⑥ 顺带修掉一处**假因**：`drift-check` 12b 的「名字出处」来源清单原先没有 `dsh-tool-skill`，于是「把 skill 加进名单」时会同时报出「找不到出处」这条假原因，把真因（12g）埋在噪音里——已把该包补进来源清单。 |
| 43 | §2（新增能力）与 §0.1（工具面计数） | **2026-10-04 落地三件团队工具 + 一条工程纪律**，全部有真跑断言：① `broadcast_message`（Lead 专属，`lib/roster.js` 的 `planBroadcastTargets` + `lib/tools.js`）：一次把同一条消息发给多个队员；**默认只发 running/provisioning**，因为官方 `send_message` 对 inactive 目标会启动新 turn（投递链 `dispatchOnce` → `steerHostSubagentPrompt` → `deliverFollowup` 的 coldResume），「广播全体」会把停着的队员全部拉起来干活；被跳过的目标逐个给出可操作理由，要唤醒必须显式 `include_inactive: true`；**显式点名**（`targets`）不受该闸门限制——点名本身就是 Lead 的决定，等价于单独 `send_message`。② `ask_lead`（队员专属，`lib/roster.js` 的 `askLeadMessage`）：队员中途提需要拍板的问题；走官方 `sendMessage(→ lead)` 并加固定前缀 `[阻塞·等答复]`/`[可继续]` + `[需 Lead 决策]`，因为官方投递框架只写发件人（`dsh-experimental-agent-team/lib/index.js:971-976`）没有类型位；投递失败不静默，返回 `ok:false` + diagnostics 指路 `report_result` 的 `needs_decision`。③ **截断标志**（`lib/runtime.js` 的 `noteTurnEndReason`/`truncatedMemberIds` + `lib/roster.js` 的 `annotateTruncatedMembers`）：监听 `session/event` 的 `turn/end`，`reason.kind === 'max-tokens'` 时记账（正常收尾/中止/报错都清除），`list_agents` 把固定文案并进该队员行的 **diagnostics** 字段——不新增字段是因为 `diagnostics` 官方 schema 里已有，从而**不动 Lead 的工具目录 = 不动每次请求的缓存前缀**。写入点是监听器与集成测试**共用的同一个函数**，被测的就是生产路径。④ 队员工具面因此从 8 个变 **9 个**（+`ask_lead`），`TEAMMATE_TOOL_DENY` 增 `ask_user_question`（官方 `dsh-user-questions/lib/index.js:531-535` 的 `assertLiveRoot` 对委派调用者抛 `DELEGATED_CALLER`，弹窗却已在宿主全局排队）。⑤ PLAYBOOK 预算闸门按报告 P2-10 的建议从 `≤4100` 收到 `≤3800`（实测 3783，含 §一/§六 去重、§五 字段用法下沉、长句瘦身；27 个必备关键词全部保留）。⑥ 工程纪律（本轮事故的防复发）：测量提示词长度必须用**模块运行时值**（`import` 后读 `.length`），不许用字符串切片——本轮曾据此误判 `TEAMMATE_CARD` 超限并做「压缩」，用字符串替换误伤模板字符串、删掉整个 `teammateBrief`，导致模块语法崩。现已回滚并加结构完整性闸门（`tools/selftest.cjs`：三常量 + `teammateBrief` + `wakeInstruction` + 反引号成对 + 正文长度下限）。 |


**验证为对、可以继续依据的条目**（本次逐条复核过）：§7.5 的 `agent/request` payload 形状与
`mode=waterfall`、`ctx.llm` 六个方法、`ctx.webServer.register` 契约、`plugins.bundle.config` 槽位与
`registration` 声明、`dsh-commands` 的 `COMMAND_NAME` 正则与 `normalizeResult`、
`createUserMessage` 的 message 形状、mcp-manager 的 API 通道写法、`agent/created` 的安装时机
（0.1.7 是 `await ctx.serial(...)`，逐个 await 监听器；`create()` 的调用者要等它 resolve）。

## 0. 运行环境事实（先读，避免写错 API）

- **运行中的桌面端是 `@deepseek-ai/dsh-desktop 0.2.0-rc.2` / 运行时同代**（2026-10-04 本机实测；
  2026-09-28 升到 0.2.0-rc.1、其后又升到 rc.2，此前是 0.1.7-rc.2）。本文档里出现的 `0.1.7`
  行号是**取证快照**，不是「现在跑的那一版」；现行判据是 0.2.0-rc.2 的 `app.asar`
  （`tools/drift-check.cjs` 开头会把宿主版本与插件依赖版本都打印出来）。
- `<DSH 主目录>\profiles\node_modules\@deepseek-ai\*` 是**陈旧的 0.1.5 树**（每个 package.json 的
  `version` 都是 `0.1.5-rc.2`），里面的 `installSection` / `settings.plugin.item` /
  `dsh-client-schema-form` 在这个运行时里**不存在**。
  **判断 API 是否存在，必须以 `app.asar`（0.2.0-rc.2）里的那一份为准。**
  注意：反过来也成立：**这些包在插件目录里能被 `import.meta.resolve` 成功解析**（junction 到全局 CLI 的
  0.1.5 副本）。所以「解析得到」不等于「是运行中的那一份」——这是一条静默的版本错配风险，
  不是 `ERR_MODULE_NOT_FOUND`。`tools/integration-test.cjs` 会在开头把实际解析到的版本打印出来，
  `tools/drift-check.cjs` 则把**两份**都打印出来。
- 0.1.7 的解包快照曾在 `<本地 asar 解包快照>\asar-017\`（历史证据，已被 0.2.0-rc.1 取代；
  现在读官方源码请直接用 `app.asar`：`tools/drift-check.cjs` 里有零依赖的 asar 读取实现可复用）。
- 任意 asar 条目：`node <本地 asar 解包快照>\asar-extract.cjs list|extract /dsh/node_modules/@deepseek-ai/<pkg> <dest>`
- **可以直接依赖并 import 的只有**：`@deepseek-ai/dsh-tools`（`defineTool`，已被同 profile 的
  `某个第三方插件/lib/index.js:13` 证明可行）、node 内置模块。
  **不要 import** `@deepseek-ai/cordis` / `schemastery` / `dsh-settings` / `dsh-subagent` /
  `dsh-experimental-agent-team`——我们不声明 Config schema，也不走 settings 体系。
  （`TeamTaskId` 已本地实现；`dsh-tools` 的 `defineTool` 在 0.1.5 / 0.2.0 都要求
  `output.render` 是函数，两版都接受我们 `{ schema, render }` 的形状——但**两份实现不是同一份**，
  0.2.0 多 `projectContent` / `deferLoading`，耦合由 drift-check 的字段闸门守着，见勘误表第 22 条。）

## 1. `lib/roster.js`（已存在，只读）

```js
export const CONFIG_VERSION = 1;
export const CONFIG_FILENAME = 'dispatch-agent-team.json';
export const ROLES;                 // [{id,label,labelEn,mission,duties[],writes,when}] —— 现在 12 个，按工作流阶段排序
export const ROLE_IDS;              // string[]
export const ROLE_BY_ID;            // Record<id, role>
// 注意：以下 5 个为 2026-09-28 新增（队员能力面真值，与角色无关；见 §0.1 第 3 条）：
export const TEAM_TOOL_NAMES;             // 九个团队工具名（真值在这里，不在 lib/tools.js）
export const LEAD_ONLY_TEAM_TOOL_NAMES;   // ['spawn_teammate','interrupt_agent']
export const MEMBER_TEAM_TOOL_NAMES;      // 队员可见的 9 个 = 九个减去上面两个，再加队员专用的 report_result 与 ask_lead
export const TEAMMATE_TOOL_DENY;          // 队员身上要摘掉的工具名（继承面来的）。**不许含 'skill'**：见 §3.5
export const TEAMMATE_SECTION_MUTES;      // 队员身上要清空的提示词段（[{name,orderKey,fallbackOrder}]）
// 以下 4 个是 2026-09-30 起的既有导出（工具名与 Lead 名单的真值都在这里）：
export const WAKE_TOOL_NAME;              // 'wake_teammate'（Lead 专属）
export const REPORT_TOOL_NAME;            // 'report_result'（队员专用）
export const LEAD_TEAM_TOOL_NAMES;        // Lead 的安装名单（官方九个 + 本插件为 Lead 加的两个）
export const OFFICIAL_TEAM_POLICY_SECTION;// 官方 team:policy 段名（preset 作用域遮蔽它）
// 注意：以下 5 个为 2026-10-04 新增（§8 三条建议落地）：
export const BROADCAST_TOOL_NAME;         // 'broadcast_message'（Lead 专属）
export const ASK_LEAD_TOOL_NAME;          // 'ask_lead'（队员专用）
export const TRUNCATED_DIAGNOSTIC;        // 截断标志的固定文案（进成员行 diagnostics）
export function planBroadcastTargets(members, {targets?, includeInactive?, callerName?});
                                    // -> {targets[], skipped[{target,reason}]}；纯函数，selftest 直测
export function annotateTruncatedMembers(rows, truncatedIds);
                                    // -> 新数组；被记账户里的队员行追加 TRUNCATED_DIAGNOSTIC，不改入参
export const RETRY_DIAGNOSTIC_PREFIX;     // '最近一次请求被宿主自动重试：'（同样进成员行 diagnostics）
export function annotateRetriedMembers(rows, retryBy);
                                    // -> 新数组；有重试记录的队员行追加该前缀 + 摘要，不改入参
export function askLeadMessage(question, blocking);  // -> 投递给 lead 的正文（含固定前缀）
export function deriveRole(name);   // 'verify-2' / 'verify-deep' -> 'verify'（最长角色前缀）；
                                    // 形状不是官方队员名 -> undefined（'scout-' / 'Scout' / 'lead'）
export function isValidTeammateName(name);
export function nextTeammateName(role, taken);
export function defaultConfig();    // {version, roles:{}}
export function sanitizeConfig(raw, log?);   // 永不抛错；坏字段丢弃并 log(msg)
export function resolveRoleRoute(config, role); // {provider,model,reasoningEffort?}|undefined
export function resolveMemberRoute(explicitRoute, roleRoute, explicitEffort);
    // -> {provider,model,reasoningEffort?}|undefined；2026-10-01 修复的优先级：显式参数 >
    //    角色配置 > 两者都无(=undefined=跟随 Lead)。钉子**只**由显式参数产生（lib/runtime.js），
    //    否则「跟随 Lead」永不生效（勘误第 41 条）。
export function configuredRoleCount(config);
```

## 2. `lib/playbook.js`（已存在，只读）

```js
export const PLAYBOOK;            // 调度模式主提示词（preset scope）
export const TEAM_POLICY;         // 团队协作策略（agent scope，开启后）
export const TEAMMATE_CARD;                // 注意：已替代 teammateCard(roleId)：与角色无关的共享队员卡（见 §0.1 第 4 条）
export function teammateBrief(roleId, name); // 角色简报，由 spawn_teammate 拼进 Lead 的派活提示词
export function enableInstruction(rawInput); // 否 已删除（见 §0.1 第 38 条）：命令路径改用 teamCommandLine(rawInput)，工具路径不再注入
export const DISABLE_INSTRUCTION;            // 否 已删除（见 §0.1 第 38/40 条）：工具路径的状态说明改走工具返回值 diagnostics
export function teamCommandLine(rawInput);   // 是 /team 注入的 user 消息正文 = 用户原文那一行（可能是 '/team'）
export function wakeInstruction(name, note); // 是 wake_teammate 发给队员的正文（固定「从断点续」措辞）
```

### 2.1 提示词预算（闸门在 `tools/selftest.cjs`，超了就 FAIL）

系统提示词是**每一次请求都要重付的前缀**，所以这些文本要像代码一样管预算。
分工固定：`PLAYBOOK` 只放**纪律**（该怎么做），`TEAM_POLICY` 只放**运行期语义**（工具返回什么、
状态是什么意思），两者都不许重复对方的内容。

| 文本 | 预算 | 当前 | 谁在读 |
|---|---|---|---|
| `PLAYBOOK` | ≤ 3900 | **3848** | 调度模式的**每一次**请求（Lead） |
| `TEAM_POLICY` | ≤ 800 | **758** | 团队开启后的 Lead |
| `TEAMMATE_CARD` | ≤ 1250 | **1199** | 每个队员的固定前缀 |
| Lead 侧合计 | ≤ 5000 | **4606** | |
| 队员侧合计（卡 + 角色简报） | ≤ 1650 | **1574** | 简报是第一条 user 消息，同样进前缀 |

> 2026-10-09 上调上限（3800→3900、1150→1200、合计 4900→5000 / 1550→1600）：新增用户要求的
> PTC 借鉴纪律（批量取证 / 先过滤后汇报），并修回同一次压缩中**误删的细节**（URL、「不知道就说
> 不知道」、`ask_lead` 之外的备选路径、blocked 的判据、冻结文件的举例与「让 Lead 判断」）。
> **教训**：压缩要合并同义表述，不许删事实——为守住上限而删信息是本末倒置。selftest 里同时
> 有专项断言钉住那些细节不许再消失。

改这四段文本后必须重跑 `node tools/selftest.cjs`：那条闸门会拿上面的数字与模块实测长度对账
（`README` 里的旧副本已随文档精简移除，现在这份表是唯一真值）。

## 3. `lib/runtime.js`（`builder-host` 写）—— 三模块共用单例

**这是唯一持有可变状态的模块。** `lib/index.js` 与 `lib/preset.js` 都 `import` 它；
两者解析到同一文件 URL，因此 Node ESM 模块缓存保证是**同一实例**。

```js
/** 注意：只对了一半：只有需要 ctx 的函数才收 ctx（见 §0.1 第 5 条）。本模块不 import 任何 dsh 包。 */

export async function getConfigPath(ctx);        // -> Promise<string>；<dshHome>/dispatch-agent-team.json
export async function loadConfig(ctx);           // -> 净化后的配置（磁盘为准，带 mtime 缓存）
export function peekConfig();                    // -> 最近一次成功读到的配置（同步，永不抛错；未读过返回 defaultConfig()）
export async function saveConfig(ctx, raw);      // -> {ok:true, config} | {ok:false, error:string}
                                                 //    净化后原子落盘（write tmp + rename），并立即更新 peekConfig()
export async function listModelCatalog(ctx);     // -> {groups:[{id,name,models:[{id,name,reasoning?:{efforts:[{id,name}],defaultEffort?}}]}], failures:[]}
export async function preflightRoute(ctx, route);// -> {ok:boolean, route, diagnostics:string[]}
                                                 //    有 reasoningEffort 但该模型未广告 / 不在列表里 => 丢掉该字段并记 diagnostics，
                                                 //    route 仍可用（ok 保持 true）。provider/model 无法解析 => ok:false。
export function isEnabled(agent);                // -> boolean（按 agent.id 记账；root 开启后其后代视为继承开启）
export async function enable(ctx, agent, opts);  // opts: {source:'command'|'tool'|'boot', rawInput?:string, extra?:string}
                                                 // -> {ok:boolean, enabled:boolean, member:boolean, diagnostics:string[]}
export function disable(ctx, agent);             // -> {ok:boolean, wasEnabled:boolean}
export function status(agent);                   // -> {enabled:boolean, role:string|undefined, route:object|undefined,
                                                 //    domain:boolean|null, restrictedTools:string[]|undefined, diagnostics:string[]}

// —— 以下是**其它模块以代码形式调用**的契约。selftest 有一条双向对账会验证这张表：
//    别人用了而这里没登记 -> FAIL；这里写了而 runtime 没有 -> FAIL。改名/新增必须同步。
export const TEAM_POLICY_ORDER = 600;      // 团队事实段的 order（官方槽位同为 600；写 60 会插错位置，§0.1 第 6 条）
export function peekRevision();            // -> number；配置文件的修订号（HTTP 保存的 revision CAS 用它）
export function notes();                   // -> string[]；注册期信息快照（浅拷贝）
export function diagnostics();             // -> string[]；故障快照（浅拷贝，外部改不到内部数组）
export function recordBootNote(message, kind); // 记一条注册期记录；kind='info' 走信息通道，其余走故障通道
export function inject(agent, text, attachments?); // 把 text（+ 可选的宿主已准入附件块）作为 user 消息
                                           //    投给该 agent 的下一个 turn；**抛错**而非返回 {ok:false}，
                                           //    否则 preset.js 的 tryInject 会把失败当成功（静默吞错）。
                                           //    附件块放在正文**之前**，与官方 /plan 注入同形（§5.2）
export function pinSpawnRoute(name, route);// 给某个队员钉路由；**只**由 spawn 的显式参数产生（§0.1 第 41 条）
export function watchAgents(ctx);          // 幂等订阅 agent/created、agent/disposed、session/event（截断记账的入口）
export function reconcileAgents(ctx);      // 给所有活体 agent 补齐安装：冷恢复 + 补装的统一入口
export function disposeAll();              // 卸载全部注册并清内部状态（含截断账本与保活计时器）
export function setStatusRefresh(fn);      // 注入「重算并写状态文件」的回调（lib/index.js 用它做 settled 阶段重写）
export function installKeepalive(ctx);     // 挂 llm/stream 瀑布（缓存保活 + 统计）；幂等
export function keepaliveStats();          // -> 保活/缓存命中统计快照（插件页与状态文件都读它）
export function recentReports();           // -> {items[], dropped, cap}；items 是最近的队员报告（浅拷贝）
                                            //    dropped = 被记录上限挤掉的条数（面板要如实说「另有 N 条未展示」）
export function recordReport(name, report);// 记一条队员报告：report_result 的落账口；**返回记录对象**（供下面那条补写）
export function markReportDelivered(entry, delivered);
                                            // 投递**之后**补写该记录的 delivered：
                                            //   插件页记录与 Lead 邮箱是两套口径，不补写就会出现
                                            //   「页面显示已交报告、Lead 从未收到」（2026-10-05 审查 §1-⑤）
export function truncatedMemberIds();      // -> Set<agentId>；上一轮撞输出上限且未交付的队员（list_agents 标注用）
export function retriedMemberIds();         // -> Map<agentId, 摘要>；最近一次 llm/retry 的记录（list_agents 标注用）
export function noteRetryEvent(agentId, data); // 重试账本的唯一写入点（监听器与测试共用）
export function clearRetryEvent(agentId);   // 新一轮开始时作废旧码（不跨轮沿用）
export function noteTurnEndReason(agentId, kind); // 截断账本的唯一写入点（监听器与测试共用）
export function sessionMemory();           // -> 会话级团队记忆快照（含 restoredThisProcess）
export async function teamGraph(ctx, sessionId);      // 工作区画布数据源：从任一成员会话回到 Lead，
                                            //    折叠出 {nodes, edges, tasks, totals}（lib/graph.js）。
                                            //    未开团队 → {ok:false, notEnabled:true}，页面据此提示先 /team。
                                            //    **口径**：每个会话只统计「它自己的事件」，必须跳过
                                            //    fork 继承来的父会话前缀（官方 eventAt(seq) 是裸下标、
                                            //    含前缀；ownEvents()/isOwnSeq() 才是排掉它的 API）。
                                            //    不跳的后果（2026-10-08 实测）：3 个 fork 成员各带
                                            //    884 条 Lead 历史 → 底栏总 token 多算 40659870（+28.8%）、
                                            //    承接边 32（真值 14）、队员的 wrote/read/todo 全是 Lead 的。
                                            //    判据：session.inheritedEventCount，拿不到就扫
                                            //    subagent/descriptor 的位置（ownStartSeq/ownStartOfEvents）。
export async function teamConversation(ctx, sessionId, targetId, limit?);
                                            //    浮动窗口的对话尾部。**只**允许读该会话所在团队
                                            //    （Lead 或任一成员）的会话，越权 targetId 直接拒绝。
                                            //    同样跳过 fork 继承前缀（否则浮窗里显示的是 Lead 的对话）。
export async function teamQuestions(ctx, sessionId, targetId);
                                            //    工作区聊天框：读某个成员「向用户提过的问」
                                            //    （`ask_user_question` 工具调用）。数据源是**会话日志**
                                            //    而不是官方 `userQuestions` 投影 —— 后者只跟踪
                                            //    `mode: "timed"`，本机默认 legacy → 投影恒空且不报错
                                            //    （dsh-user-questions/lib/types/projection.js:200-215）。
export async function teamSend(ctx, sessionId, targetId, text);
                                            //    工作区聊天框：发一条用户消息。**必须按会话类型分流**：
                                            //    Lead → `sessionController.prompt({sessionId,content,mode:'queue',requestId})`
                                            //      （dsh-api-session-controller/lib/index.js:850）；
                                            //    队员（origin==='subagent'）→ prompt 恒被拒
                                            //      （同文件 :126-132 对 origin 恒 true → `session/agent-busy`），
                                            //      改走 `subagents.prompt({parentSessionId,childSessionId,
                                            //      mode:'continuable',delivery:'queue',content})`
                                            //      （dsh-subagent/lib/index.js:3011），且父会话必须活着。
export async function teamAnswer(ctx, sessionId, targetId, callId, answers);
                                             //    工作区提问卡：回答一次 ask_user_question。两条通道依次：
                                             //    ① `userQuestions.answer(agent, callId, {answers})`
                                             //      （dsh-user-questions/lib/index.js:552）—— 只对
                                             //      **continued** 态有效（:554），答案写成
                                             //      `user-question-reply` 用户消息（:561-582，官方投影
                                             //      判「已回答」的同一条记录，projection.js:261-267）；
                                             //      队员抛 DELEGATED_CALLER（assertLiveRoot :531-535）。
                                             //    ② 兜底：格式化成一条消息走 teamSend（queue 投递，
                                             //      **不打断当前轮**）。返回 {ok, via:'userQuestions'|'message'}。
                                             //    ⚠️ 不做「插件注册 user-questions/request waterfall 抢答」：
                                             //      官方 client 已占该席位（dsh-client-ui-user-questions/
                                             //      lib/client.js:1927），抢单会挤掉官方提问卡造成双答案。
                                             //    已回答判定在**数据层**：extractQuestions 配对
                                             //      tool/result 的 answers 批次（实测已答提问都有 result）。
export async function leadForSession(ctx, sessionId); // 上面几个共用的「成员会话 → Lead agent」解析：
                                            //    先按 id（含/不含 session- 前缀两种键）找活体 agent，
                                            //    再用域服务 membership.root 回到 Lead。
```

### 3.1 `enable()` 必须做的事（顺序固定）

对**调用者 agent**（root）：
1. 幂等：已开启则直接返回。
2. 记 `enabledRoots.add(rootId)`；把 rootId→disposers[] 存起来。
3. 在 **`agent.ctx`**（不是宿主 ctx）上注册：
   - `ctx.systemPrompt.section({ name: 'dispatch:team-policy', order: 600, text: TEAM_POLICY })`  ← 注意：是 **600**，不是 60（§0.1 第 6 条）
   - 九个团队工具（见 §4）
   - `agent/request` waterfall 监听（仅当 root 自己也有角色配置时；一般没有，可跳过）
4. 对所有 `ctx.agents.list()` 里**已经存在**的本团队队员补装（冷恢复/重开同理）；
   并对 root 的**每个** `agent/created` 以后创建的队员，在其 `agent.ctx` 上注册（注意：现行实现比本文档多三步，见 §0.1 第 7/8 条）：
   - 共享队员卡段 `ctx.systemPrompt.section({ name: 'dispatch:teammate-card', order: 600, text: TEAMMATE_CARD })`
     —— **与角色无关**，所有队员逐字节相同（旧写法 `teammateCard(deriveRole(name))` 已删除）
   - **清空**被摘掉工具的用法段（`TEAMMATE_SECTION_MUTES`：`tool:goal` / `tool:workflow`，同名空段遮蔽）
   - **收窄继承面工具** `ctx.tools.restrict({ deny: [name] })`，逐个名字 try/catch（`TEAMMATE_TOOL_DENY`）
     —— **`skill` 故意不在名单里**（见 §3.4）
   - 只有 **9 个**团队工具（`MEMBER_TEAM_TOOL_NAMES`；= 官方九个去掉 `spawn_teammate` / `interrupt_agent`，再加队员专用的 `report_result` 与 `ask_lead`）
   - **模型/强度覆盖**（见 §3.2）
   - 另外尽力注册一个**同名空段** `dispatch:playbook`（order 1、text `''`）来遮蔽 preset 层的
     Lead 方法论段；**如果注册抛错就吞掉并记 diagnostic**，不要因此让 enable 失败。
5. 注册必须经过 `agent.ctx.effect(...)` 或把 disposer 收进本 root 的记录里——
   **插件卸载不会自动回卷 agent.ctx 上的注册**（官方 tool-agent-team 就是这么做的）。

### 3.2 队员模型/强度覆盖（核心机制，零改官方包）

在**队员自己的 agent scope** 上装一个 `agent/request` waterfall。写法照 0.1.7 官方
`dsh-agent/lib/types/model-selection.js` 的 `installModelSelection`（同目录同名，官方在
`dsh-agent-loop/lib/index.js:1179` 调用这个 waterfall）：

```js
const dispose = agent.ctx.on('agent/request', async (_payload, next) => {
  const resolved = await next();
  const route = /* 该队员的最终路由；没有覆盖就返回 resolved */;
  if (route === undefined) return resolved;
  const { reasoningEffort: _inherited, ...rest } = resolved;   // 先丢掉继承来的强度
  return { ...rest, provider: route.provider, model: route.model,
           ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) };
});
```

路由来源：`deriveRole(队员名)` → `resolveRoleRoute(peekConfig(), role)`；**undefined = 保持与 Lead 一致**。
若 config 在会话中途被改，下一次请求就要用新值 → 监听器里**每次请求都重新 resolve**，不要缓存死值。

**必须在 `agent/created` 的同步回调里注册**（0.1.7 `dsh-agent/lib/index.js` 的 `agent/created` 是同步派发，
首个 turn 在 `materialize()` 返回之后才投递，所以同步注册是安全的；异步 `recompose/select` 才是竞态）。

### 3.3 配置持久化

- 文件：`<dshHome>/dispatch-agent-team.json`，内容就是 `sanitizeConfig` 的形状：
  `{"version":1,"roles":{"scout":{"provider":"qianwen300","model":"qwen3.8-flash","reasoningEffort":"high"}}}`
- `<dshHome>` 取法（照 `某个第三方插件/lib/index.js:351-364`）：
  `await ctx.settings.prepareDocument()` 返回的是 **profile 的 patch 路径**（不是 DSH 主目录）；
  现行实现先按 `<home>/profiles/<profile>/<file>` 剥三段，再用 `<候选>/profiles` 是否为目录确认
  （`lib/runtime.js` 的 `resolveDshHome`，见 §0.1 第 10 条）。
  该调用失败时回退到环境变量 `DSH_HOME`，再失败则 `os.homedir()/.dsh`。
- 写盘必须原子（同目录 tmp + `fs.rename`）；目录不存在先 `mkdir -p`。
- `peekConfig()` 必须是**同步**且永不抛错——它会被 `agent/request` 热路径调用。

### 3.4 模型目录

`listModelCatalog(ctx)` 用于配置页的下拉。优先用宿主 `ctx.llm` 的能力自建；
若 0.1.7 的 `ctx.llm` 没有列举接口，就**从已配置的 provider 适配器**列（`ctx.llm` 上的
provider/adapter 集合），并为每个 provider/model 调 `ctx.llm.resolveModelInfo(provider, model)`
拿 `reasoning.efforts`。**拿不到 reasoning 元数据的模型就不要给 efforts**（官方硬规则：
`dsh-client-ui-model-selection/README.md:32`「An adapter without reasoning metadata leaves the Effort row absent」）。
**先把这一步真跑通再往下写**：在同 profile 里用真实调用验证（写个临时脚本或先跑 host 路由的 GET）。

### 3.5 技能（skill）：队员**保留**它，且目录会自动注入

**结论**：Lead 与每个队员都能调 `skill`，而且**不需要用户点名** —— 技能目录会注入到每个 agent 的上下文里。
两条官方事实（对着装机 0.2.0-rc.2 复核）：

1. `skill` 工具由 preset 行带来（`presets/dispatch-mode.patch.yml:142-146` 的
   `skill-filesystem` + `tool-skill`），**不在** `TEAMMATE_TOOL_DENY` 里（`lib/roster.js:472-482`）。
   注意 `lib/tools.js:621-622` 的 `include` 名单只过滤**本插件自己那 15 个团队工具**
   （注释原话：「名单外的工具连 schema 都不注册」），**不动** preset 继承来的工具面。
2. 目录注入在 `dsh-tool-skill/lib/index.js:203-236`：挂在 `agent/pre-step` 上，注入一条
   **user 消息**（`source.kind = "skill-catalog"`，内含 `<available_skills>`，描述截 500 字符），
   判据是 `:207` 的 `ctx.tools.get("skill", agent) === skillTool` —— **谁能调这个工具，谁才有目录**。
   该事件按 agent 过滤（`dsh-scope/lib/invariant.js:17` `"agent/pre-step": (args) => args[0]["agent"]`），
   所以每个 agent 各拿一份，队员也有。

**为什么这个设计对本插件友好**：目录是 **user 消息**而不是系统提示词段，所以它**不影响**队员共用的
系统提示词前缀（§2 的缓存纪律 / `TEAMMATE_CARD` 逐字节相同那条）。**不要**为了「让队员看到技能」
去注册什么提示词段 —— 那会打掉缓存命中率，而且完全没必要。

**两条硬约束（改这里之前先读）**：

- **不要把 `skill` 加进 `TEAMMATE_TOOL_DENY`**：可见性是**绑定**的，队员会**同时**失去工具与目录，
  而插件照常加载、`/team` 照常可用 —— 静默失效。`drift-check` 12g 与 `integration-test` §2.5 各有一条闸门。
- `SKILL.md` 的 frontmatter 写 `disable-model-invocation: true` 时：它**不进目录**
  （`dsh-tool-skill:217` 的 `filter(isModelInvocable)`），且**按名字调会直接抛错**
  `skill "X" is not available for model invocation`（`:147`/`:150`）。这类技能只能用户本人调用。
  旧键名（`disableModelInvocation` / `modelInvocable` / `userInvocable`）会被官方拒掉
  （`dsh-skill-filesystem:850-852` 报 unsupported），只能用短横线写法。

**测试怎么覆盖的**：`integration-test` §2.5 用**真的** `SKILL.md` 夹具 + 真的
`SkillRegistry` / `skill-filesystem` / `tool-skill` 装在 **preset 平面**（生产形状），
断言队员与 Lead 都拿到目录、`disable-model-invocation` 的技能被过滤掉，并有负对照
（显式 `deny: ['skill']` 后工具与目录**同时**消失）。

## 4. `lib/tools.js`（`builder-host` 写）—— 九个团队工具 + 两个开关工具

九个工具的**蓝本是官方 0.1.7 源码**（照抄，不要自创）：
`<本地 asar 解包快照>\official-agent-team\dsh\node_modules\@deepseek-ai\dsh-experimental-tool-agent-team\lib\index.js`

要改的只有 `spawn_teammate`：

```js
name: 'spawn_teammate'
parameters: {
  role: { type:'string', required:true, enum: ROLE_IDS, description:'队员角色 id；队员名由此决定。' },
  name: { type:'string', description:'可选，必须以角色 id 开头（<角色id> / <角色id>-<后缀>）；省略时自动取未占用的名字。' },
  description: { type:'string', required:true, description:'这个队员负责什么（一句话）。' },
  prompt: { type:'string', required:true, description:'自包含的初始任务：目标/已知事实+文件行号/要做什么/边界与写域/验收标准/回复格式/汇报方式。' },
  context: { type:'string', enum:['fresh','fork'], description:'默认 fresh。' },
  model: { type:'string', description:'可选，覆盖该角色的模型；必须与 provider 成对。' },
  provider: { type:'string', description:'可选，覆盖该角色的 provider；必须与 model 成对。' },
  reasoning_effort: { type:'string', description:'可选，覆盖该角色的思考强度；必须是该模型广告的档位。' }
}
```

`execute` 逻辑：
1. `role` 必须合法；`name` 若给了必须 `isValidTeammateName` 且 `deriveRole(name) === role`，
   否则报错。**显式给名字时也会查一次已占用名单**（同一个 `takenNames`），撞名直接给出下一个可用名
   —— 官方的 roster 是历史累计、名字永不复用，撞上时官方只抛一句英文
   `teammate name "X" was already used in this Team`（2026-10-05）。
   没给则用 `nextTeammateName(role, 现有队员名 + 'lead')`。
   `spawnTeammate` 抛出的官方错误码还会被翻译成带下一步动作的中文：
   `TEAM_MEMBER_NAME_TAKEN` / `TEAM_MEMBER_LIMIT`（累计帽）/ `ACTIVATION_LIMIT_REACHED`
   （同时在线帽，`maxActiveSubagents`，进程级共享、满了不排队）。
2. 路由：工具显式 `provider/model/reasoning_effort` > `resolveRoleRoute(peekConfig(), role)` > 不覆盖（继承 Lead）。
   显式给了 provider 或 model 其中一个而另一个缺失 → 报错。**先 `preflightRoute`**，
   `ok:false` 就报错，被丢掉的 effort 要写进返回值 diagnostics。
3. 调 `ctx.agentTeams.spawnTeammate(agent, {name, description, prompt: <identity prefix + 任务>, context, provider, signal})`，
   `provider` 由 `context` 决定（`fresh` → `spawn`，`fork` → `fork`）。
   identity prefix 照抄官方（`You are teammate "<name>".` 那段），并把角色名加进去。
4. 返回值就是官方 `{member}` 形状，再附加 `role` 与该队员最终路由（便于 Lead 确认真的生效）。

其余八个工具（`send_message` / `list_agents` / `wait_agent` / `interrupt_agent` /
`team_task_create` / `team_task_list` / `team_task_get` / `team_task_update`）**逐字照抄官方**，
包括 schema、description、错误处理与 `jsonOutput` 渲染方式。`TeamTaskId` 从
`@deepseek-ai/dsh-experimental-agent-team` import（官方就是这么做的）。

两个开关工具（注册在 **preset scope**，由 `lib/preset.js` 调用本模块导出）：
- `enable_agent_team`：无必填参数，可选 `note`（用户随命令给的补充意图）。
  → `runtime.enable(ctx, exec.agent, {source:'tool', rawInput: note})`，
  成功后 `exec.agent.followup(createUserMessage(...enableInstruction(note)...))`（见 §5.2 的注入写法），
  返回 `{ok, enabled, members: [...], diagnostics: [...]}`。
- `disable_agent_team`：→ `runtime.disable(ctx, exec.agent)`，成功后注入 `DISABLE_INSTRUCTION`。

导出形状（供 `lib/preset.js` 使用）：

```js
export function teamToolDefinitions({ runtime, agentTeams, config, include });  // -> ToolDefinition[]（include 给名单时只返回子集）
export function controlToolDefinitions({ runtime, inject });           // -> ToolDefinition[]（两个开关）
export { TEAM_TOOL_NAMES };                                            // 名字真值在 lib/roster.js，本模块只转发（§0.1 第 14 条）
```

## 5. `lib/preset.js`（`builder-preset` 写）

> 注意：**本节与 §5.2 / §5.3 已过时且危险，先读 §0.1 第 15/16 条**：
> `apply()` **只注册一个提示词段**，`inject` 只有 `['systemPrompt']`；
> 两个命令与两个开关工具由 `registerControls(ctx)` 导出、在**宿主平面**注册
> （`lib/index.js` 调用）。在 preset 子树里发布能力会让**整份 preset 变 broken**（MAINTAINER-NOTES.md §8.2）。

```js
export const name = '@zws/dsh-dispatch-agent-team/preset';
export const inject = ['systemPrompt'];   // 注意：只有这一个（旧写法多声明四个服务，会让 preset 半整体不 apply）
export function apply(ctx) { ... }        // 注册提示词段 + 控制面（preset 层，只对本 preset 可见），整段 try/catch
export function registerControls(ctx);    // 只由 apply() 在**调度模式的 preset scope** 里调用（宿主平面调用 = 越界）
```

### 5.1 提示词段
```js
ctx.effect(() => ctx.systemPrompt.section({
  name: 'dispatch:playbook', order: 1, text: PLAYBOOK,
}), 'dispatch-preset: playbook');
```

### 5.2 命令入口：**只有** `/team`（**没有** `/team-off`）

注意：命令与开关工具由 `apply()` 在 preset 子树里注册（见 §0.1 第 19/20 条）：
**注册作用域决定可见范围**——preset 层只有调度模式的会话能看到，宿主平面会变成所有 preset 都能看到（越界）。
**关闭团队不用命令**：用户说「关掉团队」，Lead 调 `disable_agent_team` 工具。

0.1.7 硬校验：`dsh-commands/lib/index.js:78` `const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u;`，
`:150` 不匹配就 `TypeError`。中文命令名**不可能**，别再试。

**并且（2026-09-27 实测修正）**：Web 客户端里未注册的 `/xxx` 输入会被命令面板**吞掉**——
既不发模型也不报错。所以不能靠「提示词识别中文斜杠命令」来兜底；唯一入口就是 ASCII 命令名。

```js
ctx.effect(() => ctx.commands.register({
  name: 'team',
  description: '智能体团队（仅调度模式）：为当前会话开启 Agent Teams 协作。关闭：直接说「关掉团队」，Lead 会调用 disable_agent_team。',
  input: { hint: '可选：补充你的意图，例如「只做调研」「先审计划」', attachments: true },
  async handler(invocation) { /* invocation.agent / invocation.rawInput / invocation.attachments */ },
}), 'dispatch-preset: /team');
```

**`input.attachments: true` 是必需的（2026-10-07 用户实测）**：宿主执行器按这一位判定要不要收附件
（`dsh-commands/lib/types/index.js:330` `if (command.definition.input?.attachments !== true)
return settle({kind:'error', text:'/x does not accept attachments'})`），客户端把它渲染成
「/team 不接受附件，请先移除附件」（`dsh-client-ui-commands/lib/client.js:111`
`notice.attachmentsUnsupported`）。**不声明 = 用户贴图 + `/team` 直接被拒**，
而「贴一张截图让团队查」恰恰是调度模式最常见的入口之一。官方 `/plan`、`/goal` 都声明了它
（`dsh-plan-mode/lib/index.js:187`、`dsh-command-goal/lib/index.js:181`）。

声明后宿主会先做**准入**（`:338` `admitCommandAttachments`）再把已持久化的块交给 handler：
图片规范化落盘成 `ImageBlock`，文件按只读路径引用成 `FileBlock`（`dsh-attachment` README：
非图片文件不设类型与大小限制）。所以 handler 拿到的 `invocation.attachments` 是
**冻结的持久块数组**，不是浏览器原始数据；无附件时是空数组（`:48` `NO_ATTACHMENTS` 共享常量）。
本插件的做法与官方 `/plan` 逐字同形：**附件在前、用户原文在后，并入同一条 user 消息**
（`dsh-plan-mode/lib/index.js:217-223`）。

`handler` 要做：
1. `const agent = invocation.agent`；拿不到就返回一条 `success` 说明无法定位会话。
2. `const result = await runtime.enable(ctx, agent, {source:'command', rawInput: invocation.rawInput})`。
3. 成功后把 `teamCommandLine(rawInput)` **连同 `invocation.attachments`** 作为**一条 user 消息注入**，
   让 Lead 立刻按团队方式继续（附件必须一起进，否则宿主放行了、模型却看不到图）。
   **注入写法已定（builder-preset 实测后裁定）**：**自造 message 对象**，不要 import
   `@deepseek-ai/dsh-llm`：
   ```js
   const message = {
     id: <randomUUID()>,            // node:crypto 的 randomUUID()
     role: 'user',
     content: [{ type: 'text', text: enableInstruction(raw) }],
     source: { kind: 'user' },
   };
   agent.followup(message);          // 0.1.7 dsh-agent-loop/lib/index.js:806
   ```
   理由（实测）：从插件源码目录 `import.meta.resolve('@deepseek-ai/dsh-llm')` → `ERR_MODULE_NOT_FOUND`；
   而 profile 的 node_modules 链上那个是**全局 CLI 0.1.5 的 junction**，与运行中的 0.1.7 版本不一致；
   静态 import 一旦解析失败就是**模块加载期硬崩**，会连带打掉命令与配置页。
   形状与官方 `createUserMessage` 同形（`dsh-llm/lib/types/message.js:34-58`），且 `MessageId`
   是纯类型品牌、运行时不校验。
4. 返回 `CommandResult`：**`{ kind: 'success' | 'error', text: string }`**。
   注意：0.1.7 `dsh-commands/lib/index.js:184-204` 的 `normalizeResult()`：**没有 `kind` 字段直接抛
   `TypeError`（"handler must return a CommandResult"）**；`kind:'success'` 时 `text` 可选但必须是
   string；`kind:'error'` 时 `text` 必须非空。**不要返回 `{ok:true,text}`。**

`team-off` **已删除**（§0.1 第 20 条）：关闭团队改由模型工具 `disable_agent_team` 完成
（`lib/tools.js` 的 `controlToolDefinitions` 里那一个工具，走 `runtime.disable` + 注入 `DISABLE_INSTRUCTION`）。

### 5.3 两个开关工具（`enable_agent_team` / `disable_agent_team`）
```js
for (const definition of controlToolDefinitions({ runtime, inject: ... })) ctx.effect(() => ctx.tools.register(definition), '...');
```
在 `apply()` 里、**与命令同一个 preset 作用域**注册（所以别的 preset 看不到、也调不到）。
`runtime.enable` 另有 `assertDispatchPreset` 断言：不是 `dispatch-mode` 会话直接拒绝。

## 6. `lib/client.js`（`builder-ui` 写）—— 浏览器半

- **手写 lazy-CJS factory，不需要任何构建**（先例：`某个第三方插件/lib/client.js:1-9` 与尾部 `:488-494`）：
  ```js
  window.__ModuleLoader__.load({ id: '@zws/dsh-dispatch-agent-team', factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');
    exports.inject = ['slots', 'locale'];   // 注意：两个（§0.1 第 17 条）
    exports.apply = function (ctx) { ... };
    return module.exports;
  }});
  ```
  必须同时以**裸包名**注册（`dsh-client-modules` 把浏览器半挂到「specifier 是裸包名」的 loader 行）。
- 页面注册（0.1.7 真实挂载点，keyed = **本包 package.json 的 name**）：
  ```js
  ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: '@zws/dsh-dispatch-agent-team',
    locale: 'dispatchAgentTeam',
  }, RosterPage)), 'dispatch-team: config page');
  ```
  槽位声明证据：`<本地 asar 解包快照>\asar-pkgs\dsh\node_modules\@deepseek-ai\dsh-client-ui-plugin-manager\lib\client.js:30-34, :3449-3452`。
  **不要**注册 `plugins.item` / `plugins.row.config`（那是别的 subject）。
- 组件签名：`({ t, view }) => ReactNode`。`subject` **不存在**（官方只给 `plugins.detail.*` 传它）。
  `view === 'summary'` 分支是防御性的：官方只在 `plugins.bundle.config` 槽位上以 `{ view: 'page' }` 渲染本组件。
  bundle 详情页的**基本信息（图标/标题/版本/包名/描述）由页面白送**（plugin-manager README + `:1908-1947`），
  你只做：角色列表 + 模型/强度选择 + 保存/放弃 + 状态提示。
- 数据与写入**全部走我们自己的 host 路由**（先例：mcp-manager 的 `apiCall()`，`lib/client.js:90-101`）：
  - `POST /zws-dispatch-agent-team/api`，header 必须带 `content-type: application/json`
    与 `x-dsh-plugin: zws-dispatch-agent-team`（CSRF 门，照 mcp-manager `:94`）。
  - ops（注意：现行实现比这里多 `revision` / `diagnostics`，见 §0.1 第 18 条）：
    `{op:'get'}` → `{ok:true, config, roles:[...], path, revision, diagnostics}`；
    `{op:'list-models'}` → `{ok:true, groups, failures}`；
    `{op:'set', args:{roles, revision}}` → `{ok:true, config, revision}`，revision 不一致时
    `{ok:false, conflict:true, revision, error}`；`{op:'reset'}` → `{ok:true, config, revision}`；
    `{op:'team-graph', args:{sessionId}}` → `{ok:true, graph:{nodes,edges,tasks,totals}, leadSessionId, notes}`
    （工作区画布的唯一数据源，见 §3 的 teamGraph；未开团队时 `{ok:false, notEnabled:true}`）；
    `{op:'team-conversation', args:{sessionId, targetId, limit}}` → `{ok:true, rows:[{kind,text,time}]}`
    （浮动窗口的对话尾部；targetId 不属于该团队 → `{ok:false}`）。
- UI 要求（「原版 UI 味道」：灰阶、细边框、12–13px、克制，**不要花哨、不要浓 AI 味**）：
  - 用 `var(--dsw-alias-border-l2, rgba(128,128,128,.45))` 一类主题变量（mcp-manager 的 CSS 可抄）。
  - 每个角色一行：角色名（中文）+ 角色 id（等宽小字）+ 使命一句话；「模型」下拉；「思考强度」下拉。
  - 下拉用原生 `<select>` 即可（官方等价物 `Menu` 需要 ui-primitives，本包**不注入**它以降低失败面）。
    模型选项 value 用 `provider + '\u0000' + model` 不透明键，label 用 `provider / model`；
    每行第一个选项是「跟随 Lead（默认）」。
  - **思考强度行只在所选模型有 efforts 时渲染**；没有时显示一行灰字说明
    「该模型未广告思考强度（官方规则）；只有声明了 reasoningEfforts 的模型可选」。
  - 顶部一行状态：`已配置 {count}/{total} 个角色`（**total 是动态的 `roles.length`**，不是写死的 7/12）；
    保存成功/失败/冲突都要有可见反馈；保存中禁用按钮；有未保存改动时提示；
    **宿主的 diagnostics 必须显示出来**（配置文件坏掉时宿主会退回空配置并记一条诊断，
    页面若忽略它，用户看到的就是「全部跟随 Lead」的假象，随手一保存就把残留内容整份覆盖）。
  - 底部一段说明：默认（不配置）= 与 Lead 完全相同的模型与思考强度。
- **绝对不要**：写 `context.mutate` 之外的通道、注入本包没声明的服务、import 本包没声明的模块。

## 7. `locale/zh.json` / `locale/en.json`（`builder-ui` 写）

`meta.title` / `meta.description`，插件页与「已安装」列表卡片用它们：
```json
{ "meta": { "title": "调度模式智能体团队", "description": "为 12 类队员分别指定模型与思考强度；保存后由调度模式的 Lead 在派队员时使用。" } }
```

## 7.5 活体 API 契约（Lead 用运行时 Inspect Provider 实测，**以此为准，不要再猜**）

### `agent/request` waterfall（队员模型/强度覆盖用）
```
'agent/request'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; signal: AbortSignal },
                next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
mode: waterfall
scope-filtered dispatch (@deepseek-ai/dsh-scope): agent-scoped listeners receive only that agent
```
> "Replace the frozen call configuration. `await next()` yields the config the machine would use (agent options on
> the first request, the logged header afterwards); return a replacement to switch. … On step admission, this runs
> after assembly and `step/start`, before the system prompt and accepted user batch are committed."
`LlmCallConfig = { provider, model, reasoningEffort?, temperature?, maxTokens?, stop? }`

**因此监听器必须写成**（与 0.1.7 `dsh-agent/lib/types/model-selection.js` 一致）：
```js
agent.ctx.on('agent/request', async (_payload, next) => {
  const resolved = await next();
  if (route === undefined) return resolved;
  const { reasoningEffort: _inherited, ...rest } = resolved;
  return { ...rest, provider: route.provider, model: route.model,
           ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) };
});
```

### `ctx.llm`（模型目录与 preflight，宿主侧）
```
@Remote listProviders(): LlmProviderInfo[]                         // [{id, name}]
@Remote listConfigurableProviders(): LlmConfigurableProvider[]
async listModels(provider: string): Promise<LlmModelInfo[]>        // [{provider,id,name,description?,inputModalities?}]
async resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>
        // { ...LlmModelInfo, context?, defaultMaxTokens?, reasoning?: { efforts: [{id,name,description?}], defaultEffort? } }
async resolveCallConfig(config: LlmCallConfig, signal?): Promise<LlmCallConfig>
        // 校验；不支持的 effort 会抛 LlmError(code='UNSUPPORTED_REASONING_EFFORT')，不做钳制/别名
```
`listModelCatalog(ctx)` 就按 `listProviders()` → 对每个 provider `listModels()` → 对每个 model
`resolveModelInfo()` 组装；`failures` 收集失败的 provider。**没有 `reasoning` 的模型一律不给 efforts。**
`preflightRoute` 可以用 `resolveModelInfo` 判定 effort 是否在 `reasoning.efforts` 里（不要用会抛错的 `resolveCallConfig` 做主判定，
但它可以用来做最终确认——注意两者都会碰适配器，注意 signal 与异常处理）。

### `ctx.webServer`（宿主 HTTP 路由）
```
register(route: { kind: 'exact'|'prefix'; path: string; handler: (req, res) => void|Promise<void> }): () => void
```
重复的 (kind, path) 会抛错；`register` 不会自动绑定生命周期，**必须**放进 `ctx.effect(...)`。
`res` 是 `ServerResponse`（node `http.ServerResponse`）。

### `plugins.bundle.config` 槽位（客户端，运行时实测）
```
name: "plugins.bundle.config"   kind: "keyed"   scope: "root"
registration: [{ name: "key", type: "string", required: true }]
purpose: "A bundle's own configuration, keyed by the bundle's package name and rendered on the
          bundle's page between its description and its rows (`view: 'page'` only)."
ownerProps: { view: 'summary' | 'page'; form?: ConfigPageForm }
```
URL 级事实：**必须**用 `key: '@zws/dsh-dispatch-agent-team'`；`view: 'summary'` 返回一行文本，
`view: 'page'` 返回完整表单。`form` 可能不存在（我们的行不声明 Config schema）——**不要依赖它**。

## 8. 通用纪律（所有人）

- 只写自己名下的文件；**不要**动别人名下的文件，也不要动本文件与已冻结文件。
- 每个 JS 文件写完后跑 `node --check <file>`（`lib/client.js` 会被 `node --check` 当作 CJS，
  它用了 `window`——用 `node --check` 仍可语法校验，若要更稳可只跑语法检查不看运行）。
- **不允许幻觉 API**：任何你 import 或调用的 API，必须在 0.1.7 的解包源码里能找到行号，
  并把 `文件路径:行号` 写进你的完成汇报。
- 不确定就停下来问 `lead`，不要猜着写下去。
- 完成汇报（`send_message` 给 `lead`）必须包含：改了哪些文件、每个关键 API 的证据行号、
  你实际跑过什么验证、还剩什么没验证。