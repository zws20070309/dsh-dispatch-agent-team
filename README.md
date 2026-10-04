# 调度模式智能体团队（@zws/dsh-dispatch-agent-team）

一个 DSH 桌面端插件 + 一个 agent preset。它把官方实验性 Agent Teams **改良**成一套以「先问清楚再动手」
为核心的团队工作方式：

- **调度模式 preset**：Lead 先分轮把需求问清楚再落地（设计树 / 每题给推荐答案 / 等用户答复 /
  没有静默假设且用户确认共享理解之前不动手），并把「找事实」派给队员，而不是问用户。
- **12 个可选队员角色**（按工作流阶段排列）：外部调研、探索调研、前沿审查、计划审查、执行落地、
  集成落地、复现回归、逻辑审查、对抗审查、美术审查、反思优化、文档术语。
- **队员共用同一份系统提示词**（逐字节相同），角色差异**只走 Lead 派活时的提示词**。
  这是**为缓存命中率做的硬设计**：队员之间共用同一份提示词与工具目录前缀，详见 §4.5。
- **队员的工具面主动收窄**：自动摘掉 `create_goal/update_goal`、`subagent/subagent_fork/workflow`
  与 Lead 专属的团队开关，并只给 9 个团队工具（官方九个减去 `spawn_teammate`/`interrupt_agent`，再加队员专用的 `report_result` 与 `ask_lead`；`wake_teammate`/`broadcast_message` 也是 Lead 专属）。
- **每个队员可配模型与思考强度**，默认与 Lead 完全一致。配置在**插件页**里点着改，不用编辑 YAML。
- **`/team` 开启团队**；默认关闭，因为团队会真的多花模型预算。
  团队开关**按会话记忆**（2026-10-01）：宿主重启后会自动把开过团的会话装回来，不用再打一次 `/team`。详见 §2.1。
- **`wake_teammate`：队员被输出上限截断时由 Lead 叫它续写**（2026-10-01），
  不用你再手动打「继续」。详见 §2.5。
- **严格的作用域边界**：`/team` 与两个开关工具**只属于「调度模式」**——别的 preset（极简灰度等）既看不到
  这些入口、也开不了本插件的团队。反过来，调度模式里也**只有**本插件的团队（官方那两行工具/UI 一直由我们
  关闭着），两套团队永不混用。详见 §4.6。
- **只有一个斜杠命令 `/team`**（**没有** `/team-off`）：关闭团队用自然语言让 Lead 调 `disable_agent_team`。
- **缓存保活**（2026-09-30）：Lead 等队员时，插件用**完全相同的前缀**发一个只要 1 token 回复的小请求，
  让提示词缓存不过期（机制来自开源项目 dsh-model-fusion，我们改掉了它几个会白花钱的地方）。
  默认策略保守：DeepSeek 线路**关**、未知线路 `auto`（先由线路自己证明有缓存命中才开）、
  连续 2 次未命中就停；面板里能看到真实数字。详见 §10。
- **结构化汇报**：队员做完必须调 `report_result`（完成/受阻/待决 + 证据 + 验收 + **未决项**），
  插件自己把这份报告投递给 Lead —— 「没有结构化报告就当没完成」不再是口号。详见 §2.4。

历次改动的根因与验证都记在本文件的 **§8 事故记录**（§8.1–§8.12）与 **§4/§10** 里。

---

## 快速开始

```bash
# 1) 完全退出 DSH 桌面端（官方要求：desktop profile 的操作要在它退出后进行）
# 2) 在本目录下执行
node tools/install.cjs
# 3) 重启 DSH 桌面端 → 新建会话 → 推理模式选「调度模式」→ 输入 /team
```

没装 pnpm、或不想用命令行？在桌面端里：**插件 → 已安装 → 添加插件 → 填本目录的绝对路径**，
然后跑一次 `node tools/repair.cjs --apply`（原因见 §1.3）。
想先看命令会做什么：`node tools/install.cjs --dry-run`。

> ⚠️ **安装会把 profile 指向「你运行 install.cjs 的那个目录」**（pnpm 的 `link:` 依赖）。
> 如果你另外还留着一份副本（例如 `~/.dsh/plugins/dsh-dispatch-agent-team`），那份就变成**死代码**：
> 改它不会生效，却看起来像生效了。请只保留一份作为工作目录，或明确知道哪一份是活的
> （`node tools/repair.cjs` 会打印 profile 里 `@zws/...` 实际链接到的路径）。

要求：DSH 桌面端 **0.2.0-rc.2** 或更新（其它版本请先跑 `node tools/drift-check.cjs` 看兼容性），
Node.js ≥ 18。

---

## 1. 安装

### 1.1 一条命令（推荐）

先**完全退出 DSH 桌面端**（官方对 desktop profile 的每次操作都在 `package.json` 的文件锁里跑 pnpm，
它自己的提示就是「fully quit it before running dsh plugin --profile desktop」），然后在本目录执行：

```
node tools\install.cjs
```

它做的事：

1. 调**官方**的 `dsh plugin --profile desktop add <本目录绝对路径>`（不自己写 profile 文件）。
   默认用桌面端自带的那份 CLI：`<安装目录>\resources\runtime\cli\bin\dsh.cmd` ——
   它以 `manageDesktopProfile: true` 启动，因此**允许**管 desktop profile，并且用内置 pnpm，
   连 PATH 里装没装 pnpm 都不要求。
   ⚠️ **PATH 上常见的 `dsh` 是独立 CLI，它会直接拒绝 desktop profile**
   （`profile "desktop" is managed exclusively by the Electron application`），所以脚本按
   「`--cli` 指定 → 桌面自带 → PATH」顺序试，并在失败时说明原因。
2. 官方命令成功后自动跑 `node tools\repair.cjs --apply`，补上官方 reconcile **不管**的两件硬前置
   （见 §1.3）。

想看将要执行什么而不改任何东西：`node tools\install.cjs --dry-run`。
卸载：`node tools\install.cjs --uninstall`。

### 1.2 界面安装（等价路径）

插件 → 已安装 → **添加插件** → 填本目录的**绝对路径** → 启用 → 然后跑一次
`node tools\repair.cjs --apply`（这一步不能省，原因见 §1.3）。

### 1.3 为什么必须再跑一次 `repair.cjs --apply`

它补的两件事，官方安装器都不负责，缺了会出真实故障：

* **包内 `node_modules` junction** → `~/.dsh/profiles/node_modules`。
  本地路径被 pnpm 装成 `link:`，Node 于是按**真实路径**解析 import，向上找不到任何含
  `@deepseek-ai/dsh-tools` 的 `node_modules` → 静态 import 在**模块加载期**失败 →
  插件行起不来（首次安装实测就是这个报错：`dispatch-agent-team: failed to import`）。
* **profile 层的 `tool-agent-team: disabled` + `agent-team` 容量覆盖**（`maxMembers: 48` 等）。
  官方用 `insert` 新建那三行，而 bundle patch 按 `dsh.profile.bundles` 顺序应用 ——
  我们的 bundle 排在官方之前时，写在包内的覆盖会**静默失效**，有效容量退回官方默认 8
  （8 次 spawn 之后团队就派不出人），且官方九个工具会与本插件的九个同名工具撞在同一个 agent
  作用域（见 §8.6 / §8.7）。profile 的 `cordis.patch.yml` 在所有 bundle 层之后应用，是唯一顺序无关的落点。

前置：DSH 桌面端已启用官方 `@deepseek-ai/dsh-experimental-agent-team-profile`（本插件复用它的
`agentTeams` 域服务；工具面与 UI 面由本插件接管）。**缺失时 `repair.cjs` 只会提示，不会替你添加**——
请到插件页手动启用官方 bundle，本插件不去改它的启用状态。

### 1.4 生效方式

- **首次安装是热的** —— profile patch 默认开启实时重载，组合会立刻生效（实测
  `plugin_manager` 返回 `application: applied`）。
- 但**改 `lib/*.js`（host 侧代码）之后需要重启 DSH**：`dsh-base` 的 `hmr` 行只开
  「profile 配置重载」，模块 root 是 opt-in（`root: []`），host 模块不会热替换。
- **改 `lib/client.js`（浏览器半）不需要重启**，刷新页面即可。

装好后：

- **插件 → 已安装** 里会出现「调度模式智能体团队」，点进去就是配置页（角色 / 模型 / 思考强度 / 保存）。
- **推理模式选择器**里会出现新的 preset「**调度模式**」。
  ⚠️ 本插件**不**把 `selectedDefault` 改成调度模式（2026-09-27 事故后的安全选择，见 §8.1）：
  新会话默认仍是原来的 preset，要手选一次。想改默认：把 profile 的 `cordis.patch.yml` 里
  `agent-preset-registry.selectedDefault` 改成 `dispatch-mode`。理由见 §8.1 教训第 2 条 ——
  preset 找不到会让**新建会话直接失败**，故障面远大于「默认 preset 不是你想要的」。
  注意：**已经开始过的会话不能切换 preset**（`agent-preset/locked`），要新建会话。

### 1.5 装完体检（全部只读；改完代码建议跑一遍）

```
node tools\repair.cjs             # 安装状态体检（bundles / junction / 文件齐全 / 崩溃恢复痕迹）
node tools\drift-check.cjs        # 50 项官方实现假设校验（升级后必跑）
node tools\selftest.cjs           # 纯逻辑回归（角色表 / 配置净化 / 保活策略 / 文本不变量）
node tools\integration-test.cjs   # 真链路：真 cordis + dsh-tools + systemPrompt + llm/stream 瀑布
node tools\client-smoke-test.cjs  # 浏览器半渲染冒烟（迷你 React 替身，真渲染组件）
```

⚠️ 只有 `client-smoke-test` 完全不需要依赖解析；`selftest`（会 import `lib/tools.js`）与
`integration-test`、`drift-check` 都要先有 §1.3 那个 junction，否则报 `ERR_MODULE_NOT_FOUND`
—— 那是「还没跑 repair --apply」，不是插件坏了。


---

## 2. 使用

### 2.1 开启团队

**只有在「调度模式」的会话里**才有这些入口（别的 preset 看不到，见 §4.6）：

| 入口 | 说明 |
|---|---|
| 输入 `/team` | **推荐**。真命令，直接开启并注入指令；`/` 菜单里能搜到 |
| 让 Lead 自己开 | 说「组队」「开团队」「起个团队」——调度模式的提示词要求 Lead 此时调用 `enable_agent_team` |

**关闭团队**：直接说「关掉团队」/「解散团队」，Lead 会调用 `disable_agent_team`。
**没有 `/team-off`**（2026-09-28 按用户要求去掉）：团队开关只有 `enable_agent_team` / `disable_agent_team`
两个模型工具 + 一个斜杠命令 `/team`，不需要记第二个命令。

**会话里会看到什么**（2026-10-01 按用户反馈改过，见 §8.11）：

- 命令行只显示 `>_ team`，**不再追加**「智能体团队已开启：队员角色表见系统提示…」那种横幅
  （成功结果不带 text，客户端退回它自己的中性文案；命令失败时仍会显示原因）。
- 紧跟其后的用户气泡就是**你打的那一行**（`/team 我需要你用智能体团队做…`），不会再被改写成
  `[系统] 用户显式要求开启…` 的长段落 —— 界面与模型的上下文逐字一致。
- 只有 `/team` 会追加一条 user 消息（否则你打的字永远进不了模型上下文）。**模型自己调
  `enable_agent_team` 时一条消息都不注入**：状态说明走工具返回值、纪律走系统提示词 ——
  避免「输入框上方突然多出一条排队消息、还得点一次『插入』」（2026-10-01 18:26 用户反馈，见 §8.11）。

**团队开关按会话记忆**（2026-10-01 新增，解决「宿主重启后团队工具消失」）：

- `/team` 成功且工具真的装上后，插件会把**这个会话 id**记进
  `~/.dsh/dispatch-agent-team-sessions.json`（原子写；TTL 7 天；最多 200 条）。
- 宿主重启（或重新打开该会话）时，只要它记录在案、且当前仍是**调度模式**，插件会在 agent 创建的
  同步路径上把团队工具、队员卡、模型覆盖一起装回来 —— 你**不需要**再打一次 `/team`。
- 别的会话不受影响（记录按会话 id）；说「关掉团队」会立刻删掉这条记录，下次重启不会自己开回来。
- 怎么确认它在工作：插件配置页底部「会话记忆」一行（见 §10.5）。

> ⚠️ **不要用 `/智能体团队` 这类自造斜杠命令**：命令名在 host 侧只允许 ASCII
> （`/^[a-z][a-z0-9_-]*$/u`），而未注册的 `/xxx` 输入会被 Web 客户端的命令面板**吞掉**——
> 既不报错，也不会发给模型，也就是**什么都不会发生**。详见 §5.1。

### 2.2 配置队员的模型与思考强度

插件 → 已安装 → 调度模式智能体团队 → 详情页：

- 每个角色一行：**模型**（按 provider 分组）+ **思考强度**（只列该模型真正广告的档位）。
- 默认每行都是「跟随 Lead」，即**不配置 = 不加任何覆盖**：队员的模型与思考强度跟着 **Lead 当前的选择**走
  （Lead 中途换模型，队员下一次请求就跟着换 —— 这条是官方 `spawn` provider 的继承语义，日志里能验证）。
- 保存后立即生效：Lead 之后派出的队员会带上配置；**已经在跑的队员也在下一次请求就用上新路由**
  （角色配置是每次请求重新读的，不需要重启）。把某一行改回「跟随 Lead」同样立刻生效。
- 唯一的例外是 `spawn_teammate` 的**显式参数**（`provider`/`model`/`reasoning_effort`）：那是「这一次 spawn
  的命令」，会钉在该队员身上直到它被销毁；不给这些参数就完全跟随配置/Lead。
  2026-10-01 修过一个 bug：旧版把**角色配置解析出来的路由**也一起钉住了，于是面板上改回「跟随 Lead」
  对已经在跑的队员永远不生效（它一直用 spawn 那一刻的旧模型）—— 证据与修法见 §8.12。

配置文件落在 `~/.dsh/dispatch-agent-team.json`，长这样：

```json
{
  "version": 1,
  "roles": {
    "scout": { "provider": "qwen3-8-flash", "model": "qwen3.8-flash", "reasoningEffort": "high" }
  }
}
```

### 2.3 典型的协作节奏

1. 用户说需求（可能很模糊）。
2. Lead 派 1–3 个 `scout`（本仓库）或 `researcher`（仓库之外）去查事实。
3. Lead 把不依赖这些事实的问题**一次性**列成一轮（「**Q1 — 标题**：正文」+ 下一行「推荐：答案」），等用户答复。
4. 答复改变设计树 → 重算前沿 → 下一轮。前沿快空时派 `frontier-auditor` 复核有没有被跳过的分支，
   直到前沿为空 **且用户确认共享理解**。
5. Lead 切写域、在任务板上建任务（`write_scopes` 必须真正不相交）、派 `builder`。
6. 有 2 个以上写域时派 `integrator` 接线并跑通端到端；缺陷用 `tester` 先落成最小失败用例。
7. 声称完成后派 `verify` 走**真实调用链路**验证；高风险改动加 `red-team` 主动证伪；
   有可视产出加 `visual-critic`。
8. 通过后按需 `refiner` 简化、`scribe` 写 `CONTEXT.md` / `docs/adr/`。
9. Lead 自己复核关键结论后给最终答案。

**2026-09-30 加的纪律**（来自开源项目 dsh-model-fusion 的对照）：

- **谁贵谁只做判断**：Lead 默认不写批量实现、不反复跑测试；实现/修 bug/跑验收交给队员，
  Lead 只做设计、简报、审查、逐条裁决与**一两处**小修。三种情况才自己动手：
  改动比写简报还便宜 / 同一队员连续两轮返工仍不通过或它 blocked / 用户明确要求。接管后把活交回队员。
- **先记基线再验收**：动手前跑一次验收命令，把「原本就失败的项」记下来，验收只要求**不新增失败**。
- **冻结验收文件**：简报里点名的验收命令与验收文件（测试/脚本）队员**只读**；确实必须改时，
  在报告中点名，Lead 必须确认并在最终答复里说明。
- **返工回同一个队员**：它保留着上一轮的上下文，比新建一个便宜；只有角色不对或它失联才换人。
- **逐条裁决**：用户每条硬性要求都要单独给结论与证据（`文件:行号` / 命令原文 / 测试计数）。

### 2.4 队员的结构化汇报（`report_result`）

队员做完任务必须调 `report_result`（它只注册给队员，Lead 的工具面里没有）：

```jsonc
{
  "status": "completed",            // completed | blocked | needs_decision
  "summary": "改了 x.js 的解析分支",
  "evidence": ["node --test → 12 passed", "lib/x.js:88 已改"],   // completed 时**必须**非空
  "acceptance": "node --test → 12 passed（原样跑过一次）",
  "unresolved": [],                 // 每一项都会阻止验收
  "changed_files": ["lib/x.js"]
}
```

插件会：① 校验（`completed` 没有证据直接拒绝执行）；② 记进插件状态（面板与
`~/.dsh/dispatch-agent-team-status.json` 可见）；③ **自己**把这份报告投递给 `lead`
（一条形状固定的消息）。于是 Lead 拿到的不是散文，而是可以逐条判的结构；`unresolved` 非空 =
不算完成。

### 2.5 队员被输出上限截断时：`wake_teammate`（2026-10-01 新增）

一些模型（尤其是第三方线路）会在长回答中间撞到**输出上限**：那一轮直接结束、队员状态变成
inactive、`report_result` 也没发出来。以前只能由**用户在输入框里手打「继续」**；现在 Lead 有一个
专属工具：

```
wake_teammate({ target: "scout" })                       # 或 { agent_id: "<list_agents 给出的 id>" }
wake_teammate({ target: "scout", note: "只补 §3 与验收命令" })
```

它发出的正文是固定措辞（`lib/playbook.js` 的 `wakeInstruction`）：

> [系统] scout：你上一个 turn 已结束，但没有交付 report_result。
> 先用一句话说明你已完成到哪一步、**为什么停下**（撞输出上限 / 遇到障碍 / 以为已经做完）；
> 任务没做完就**从断点接着写/接着做**，不要重头再来、不要复述已经写过的内容，然后照常调 report_result 交付。

- 只有 Lead 有它（队员的工具面里没有 `wake_teammate`，也没有 `spawn_teammate` / `interrupt_agent`）。
- 它是一次**普通的消息投递**（和 `send_message` 同一条链路）：跑着的队员在最近步边界收到，
  停下的队员被唤醒开新 turn。
- **为什么不做「自动续写」**：截断是可检测的（`turn/end.reason.kind === 'max-tokens'`），但第三方线路
  实测一天里 4 个队员会话各撞了 2 次（`node tools/session-probe.cjs --grep '"kind":"max-tokens"'` 可复查），
  自动续写会变成无界烧钱。决定权交给 Lead，
  再配一条提示词纪律：队员停了又没交报告 → 用 `wake_teammate` 叫它续写，别让用户手动打「继续」。
- `send_message` / `interrupt_agent` 也接受官方的 `agent_id` 写法（会翻译成队员名）；
  同时给 `target` 与 `agent_id` 且不一致时**拒绝**，不猜目标。

---

## 3. 目录结构

```
dsh-dispatch-agent-team/
├── package.json                    # bundle patch + client 声明 + icon
├── cordis.patch.yml                # host 平面：关官方两行、insert 我们的 host 行 + 官方 UI 行
├── presets/dispatch-mode.patch.yml # 调度模式 preset（极简灰度全量行 + /preset 行）
├── icon.svg
├── locale/{zh,en}.json             # 插件卡片标题与描述
├── lib/
│   ├── roster.js                   # 12 角色表 + 配置模型 + 队员能力面常量（共享真值，零 dsh 依赖）
│   ├── playbook.js                 # PLAYBOOK / TEAM_POLICY / 共享队员卡 TEAMMATE_CARD / teammateBrief
│   │                               #   / teamCommandLine / wakeInstruction（工具路径不再注入任何消息）
│   ├── resume.js                   # 会话级团队开关记忆（重启后自动恢复；纯逻辑可单测，零 dsh 依赖）
│   ├── cache.js                    # 缓存保活 + 缓存统计（纯策略层可单测；控制器挂 llm/stream 瀑布）
│   ├── runtime.js                  # 配置读写、模型目录、preflight、enable/disable、队员收窄与遮蔽、
│   │                               #   会话记忆恢复（restoreRemembered）
│   ├── tools.js                    # 官方九个团队工具（可只注册子集）+ wake_teammate + 两个开关工具 + report_result
│   ├── index.js                    # host 入口：HTTP 路由（含 revision CAS）+ 控制面注册 + 生命周期接线
│   ├── preset.js                   # preset 入口：**只**注册调度模式提示词段（apply）；控制面由
│   │                               #   `registerControls()` 导出、交由 host 入口在宿主平面注册
│   └── client.js                   # 浏览器半：插件详情页配置表单（手写 lazy-CJS，无需构建）
├── tools/
│   ├── install.cjs                 # ★ 一条命令装进桌面端 profile（走官方 dsh plugin，见 §1.1）
│   ├── drift-check.cjs             # 官方升级漂移检测（50 项，升级后必跑）
│   ├── repair.cjs                  # 安装状态体检 / 崩溃恢复后的修复
│   ├── emergency-disable.cjs       # DSH 起不来时的一键退出
│   ├── history-audit.cjs           # 只读：某个斜杠命令在本机到底有没有活过（判「历史 vs 活命令」）
│   ├── asar-probe.cjs              # 只读：在官方 app.asar 里列条目 / 找字符串 / 导出单文件
│   ├── session-probe.cjs           # 只读：从会话日志里只抽团队调度事实（工具面增删 / 调用与返回 /
│   │                               #   turn/end 截断 / 各工具真实次数 / 跨会话字面量检索）
│   ├── selftest.cjs                # 纯逻辑回归（零 dsh 依赖）
│   ├── integration-test.cjs        # 真链路集成测试（真 cordis + dsh-tools + dsh-system-prompt）
│   └── client-smoke-test.cjs       # 浏览器半渲染冒烟（迷你 React 替身 + 可编程 fetch）
└── INTERFACES.md                   # 实现契约（含活体 API 实测记录 + 2026-09-28 起 41 条勘误表）
```

> **控制面注册在哪、为什么**（2026-09-28 边界修正，覆盖了 09-27 的「搬到宿主平面」）：
> `/team`、`enable_agent_team`、`disable_agent_team` **注册在调度模式的 preset 子树里**
> （`lib/preset.js` 的 `apply`）。理由是官方的分层语义：
> * `dsh-commands` 的 `view(agent)` = **全局层 + 该 agent 的作用域链**，`dsh-tools` 的 `view(scope)` 同理；
> * ctx 的方法调用会被 cordis 的 traceable 代理**重绑到调用者自己的作用域**，所以在哪个作用域调用
>   `register`，就注册进哪个层。
>
> 于是：**preset 子树注册 = 只有调度模式的会话能看到**（这是用户要的）；**宿主平面注册 = 全局层 = 所有
> preset 都能看到**（2026-09-28 用户实测到的越界：极简灰度模式里也能调 `/team`）。
> 现成的同类证据：`/goal`、`/compact` 就是各自 preset 行注册出来的命令，只在对应 preset 里出现。
>
> preset 子树的固有风险（子树里抛错 → 整份 preset 变 broken）用两层兜住：只做叶子注册
> （`systemPrompt.section` / `commands.register` / `tools.register`，**不发布任何服务**），
> 且每项都包 `try/catch`、失败只写进 `runtime` 的诊断环；诊断会落进
> `~/.dsh/dispatch-agent-team-status.json`，排查不用猜。

---

## 4. 与官方插件的关系（重要）

| 官方 bundle 的行 | 我们的处理 | 为什么 |
|---|---|---|
| `agent-team`（域服务 `ctx.agentTeams`） | **保留官方实现**，容量参数由 **profile 的 patch 层**覆盖（不是我们的 bundle patch，原因见 §8.6） | durable roster / 邮箱 / 任务 DAG / revision CAS 都在这 1871 行里。重造它才是「官方一升级就坏」的最大风险 |
| `tool-agent-team`（九个官方工具 + `team:policy` 段） | 由 **profile 的 patch 层整行关闭**（`tools/repair.cjs --apply` 维护）；调度模式的 preset 作用域再遮蔽它的 `team:policy` 段 | ⛔ 它与本插件的九个工具**同名、同作用域**（官方给每个 agent 都装，源码行号见 §8.7），两边不可能共存：不关它，本插件的工具就装不上，角色/模型参数全丢 |
| `ui-agent-team`（成员列表 / 任务看板） | 官方行保持启用；我们另用自有行 id `dispatch-agent-team-panel` **再挂一份同一个包**（`cordis.patch.yml:43-48`） | 客户端模块按 specifier 去重执行（dsh-client-modules 的 executedBundleUrls），两行并存不会双渲染；这样即使用户关掉官方 `ui-agent-team` 行，成员列表与任务看板也还在 |

也就是说：**本插件的团队功能（角色 / 模型 / 思考强度 / 工具收窄 / 派活提示词）100% 由本插件提供，
官方只提供不可替代的持久化域服务与那份 UI**。

### 4.6 作用域边界：哪一套团队属于哪个 preset

用户 2026-09-28 明确划的线，实现方式是「控制面注册在 preset 层」+「官方工具行在 profile 层关闭」
+「调度模式遮蔽官方策略段」+「`enable()` 里的 preset 断言」：

| 会话的 preset | `/team` 命令 | `enable_agent_team` / `disable_agent_team` | 官方 Agent Teams | 本插件的团队 |
|---|---|---|---|---|
| **调度模式** | ✅ 能看到 | ✅ 能看到 | ❌ 工具行在 profile 层被关闭（官方域服务与 UI 仍在），策略段另被同名空段遮蔽 | ✅ **唯一的团队**（角色 / 模型 / 收窄的工具面都由本插件提供） |
| 极简灰度 / 标准 / 其它 | ❌ 看不到 | ❌ 看不到 | ❌ 与调度模式同样不可用（那是**关掉**，不是强加） | ❌ 用不了（`runtime.enable` 还会再挡一次） |

三道闸：

1. **注册位置**（主闸）：控制面注册在调度模式的 preset 作用域 → 别的 preset 的会话在
   `commands.list(agent)` / `tools.view(scope)` 里根本查不到这些命令与工具，`/` 菜单里自然也没有。
2. **官方工具行在 profile 层关闭**（`tools/repair.cjs --apply` 维护这一段）：官方九个团队工具与我们
   **同名**，而且官方是把它们装进**每个 agent 自己的作用域**（§8.7 有源码行号）。同一作用域同名
   注册会抛 `tool "x" is already registered in this scope` —— 不关官方行，本插件的工具就装不上，
   角色 / 模型 / 强度参数全部丢失。⛔ 不要试图用 preset 作用域的 `tools.restrict` 去摘它们：
   restrict 只认**全局层**的名字（官方报错原文 `names unknown global tool "x"`），必然全部失败并刷出
   9 条假故障（2026-09-28 用户实际看到的就是这 9 条）。`drift-check` 有闸门禁止 `lib/preset.js` 里
   出现 `restrict`。
3. **运行时断言**（纵深防御，`lib/runtime.js` 的 `assertDispatchPreset`）：`enable()` 会问
   `agentPresets.composedPreset(agent.ctx)`「这个会话是哪个 preset」，不是 `dispatch-mode` 就拒绝，
   并回一句可执行的话：「本会话的 preset 是 X，不是调度模式……请新建会话时选调度模式」。
   取不到 `agentPresets` 时**放行**（fail-open）：那时无法判断，而误拒会让整个功能失效；
   此时控制面本来就只可能在调度模式里存在。
4. **撞车即故障**（纵深防御，`lib/runtime.js` 的 `installTeamTools`）：万一官方工具行又被打开，
   我们的注册会失败并**回滚已注册的全部**，同时把它记成**红色故障** + 给出修法（`repair.cjs --apply`），
   而不是静默降级成官方工具。

`integration-test.cjs` 用**真的** `dsh-commands` / `dsh-tools` / `dsh-system-prompt` 注册表断言了这张表：
调度模式会话查得到 `/team`、别的 preset 查不到；`team:policy` 段被调度模式遮蔽而别的 preset 照旧有；
以及**同名同作用域注册必然抛错**、我们的 `enable` 在那种情况下给的是**可执行的故障**而不是静默降级。

### 4.1 硬前置（必须满足，否则团队功能只会给出可执行报错）

官方 `@deepseek-ai/dsh-experimental-agent-team-profile` 是一个**可选 bundle**，它必须保持被 profile 选中——
我们**没有自己 insert 域服务行**（自己 insert 会与官方行在同一 realm 抢 `agentTeams` 服务名而炸）；
容量参数由 profile 层的 patch 覆盖它。若它被整个关掉：

- `ctx.get('agentTeams')` 为 `undefined`；
- 此时 `/team` 与 `enable_agent_team` **不会崩**，而是回一条明确提示：
  「官方 Agent Teams 域服务未挂载：请在插件页启用 @deepseek-ai/dsh-experimental-agent-team-profile」。

`node tools\repair.cjs` 与 `node tools\drift-check.cjs` 都会检查这个前置。

### 4.2 容量：`maxMembers` 必须在 **profile 的 patch 层**放大

官方 roster 的 `state.members` 是**不可变的历史记录**：队员名**永不复用**，`phase` 只会转
`failed`/`active`，不会移除；`maxMembers` 计的是**历史累计**而不是同时在线数。官方默认 8
意味着「角色各叫一次」就把额度用完了，之后再也派不出 `scout-2`。

所以我们对 `agent-team` 行的 config 做了**整段覆盖**（patch 按 id 是整段替换、不深合并，
因此 5 个字段全部显式重申），把 `maxMembers` 提到 **48**（12 个角色 × 4 次），`maxTasks` 提到 **512**。

⚠️ **这份覆盖必须落在 `~/.dsh/profiles/<profile>/cordis.patch.yml`（profile 自己的 patch 层）**，
因为官方是用 `- insert:` **新建** `agent-team` 行的，而 bundle 的 patch 按 `dsh.profile.bundles`
顺序应用 —— 我们的 bundle 若排在官方之前，这份 config 就落在「还不存在的行」上、**静默失效**
（2026-09-28 实测：有效 `maxMembers` 退回 8。见 §8.6）。
`node tools\repair.cjs --apply` 会补齐这一层；`repair.cjs` 与 `drift-check.cjs` 都会校验
「本包 patch 与 profile 层两份值一致」，`repair.cjs` 还会打印**运行时有效值**（来自状态文件）。
同一个 managed 段里还有**关闭官方 `tool-agent-team` 行**（`disabled: true`）—— 原因是同名工具撞车，
见 §4.6 第 2 条与 §8.7。

### 4.3 我们接受了的一个真实代价（诚实记录）

官方那 9 个工具（`send_message` / `wait_agent` / `interrupt_agent` / `team_task_*` 的
revision 与 inbox 语义）在本插件里是**机械照抄官方 0.1.7 源码**，不是为了自创接口。代价是：
官方改了工具语义后，我们要跟着改（否则只是语义落后，不会崩）。我们为什么仍然选择自己拥有这 9 个工具：

1. 你的要求是「关掉官方团队插件、用我们自己的命令开启团队」——官方工具是**无条件**装在
   每个 root 会话上的，没有开关可言，只能由我们接管。
2. `spawn_teammate` 必须能带**角色**（并在 schema 层校验）与**每队员模型/思考强度**，官方版本不带。

风险控制：`tools\drift-check.cjs` 会核对官方工具名与域服务方法是否还在；同名冲突有防御
（见下），最坏情况是**降级**而不是崩溃。

### 4.4 同名工具冲突的防御

如果你在插件页把官方的 `tool-agent-team` 行**重新打开**，官方与我们的同名工具会落在**同一个
agent scope** 上，`dsh-tools` 会抛「already registered in this scope」。本插件对此的处理是：

- 工具**逐个**注册并包 try/catch，任一失败就回滚本次全部注册；
- 该会话仍可用官方团队工具，但 `enable_agent_team` / `/team` 的结果里会明确写出
  「本次使用的是官方团队工具，角色与模型覆盖可能不完整」；
- `agent/created` 的处理器整体也有 try/catch，任何异常只记诊断，**绝不把 agent 创建打挂**。

也就是说：最坏情况是功能降级 + 一条可读提示，不是新建会话失败。

### 4.5 队员的能力面与缓存设计（本插件最核心的取舍）

三件事必须一起看，它们是同一条设计：

**(1) 队员的系统提示词逐字节相同。**
提示词缓存按**前缀**命中，每个 agent 的固定前缀 = 系统提示词 + 工具目录。旧实现给每个角色注册一张
带角色名的「角色卡」，于是 7 个角色 = 7 份不同的前缀，队员之间完全不共用缓存。现在：

- 队员的系统提示词只有一份与角色无关的 `TEAMMATE_CARD`（`lib/playbook.js`），
  `tools/selftest.cjs` 会断言**任何角色 id / 队员名占位都不许出现在这张卡里**；
- 角色的使命、纪律、写权限改由 **Lead 派活时的提示词**携带：`spawn_teammate` 会把
  `teammateBrief(role, name)` 自动拼在 Lead 写的任务正文之前，成为队员的第一条 user 消息；
- 角色差异落在共享前缀**之后**，所以它不会破坏前缀命中；
- `integration-test.cjs` 用真运行时断言「两个不同角色的队员：提示词逐字节相同 + 工具目录完全相同」。

代价是角色信息必须由 Lead 带上（不再「写一次卡，所有队员自动知道」），收益是队员之间共用一份缓存。

**(2) 队员主动摘掉不该有的工具。**
官方 `ctx.tools.restrict({deny})` 过滤的是**继承面**（全局层 + 作用域链上的祖先层，也就是 preset 行的
贡献），**本作用域自己注册的不受影响**——这正是官方为「per-child capability filter」留的口子
（`view()` 的注释原话），官方 `applyChildComposition` 给子代理装 `toolFilter` 用的就是同一个 API。
名单在 `lib/roster.js` 的 `TEAMMATE_TOOL_DENY`：

| 摘掉的工具 | 为什么 |
|---|---|
| `create_goal` / `get_goal` / `update_goal` | 目标是 Lead 的编排手段；队员的目标就是它那一条任务 |
| `subagent` / `subagent_fork` / `workflow` | 不给队员「再派子代理」的权限：多一层递归只会烧预算、让汇报链断掉 |
| `enable_agent_team` / `disable_agent_team` | Lead 专属开关，队员调用只会拿到拒绝 |

三点实现细节，都不是随便选的：

- **逐名调用 + try/catch**：`restrict` 对**不存在的名字会抛错**（`names unknown global tool`），
  而用户可能关掉某个 preset 行。逐个调用后，少一个名字只是「少摘一个」，绝不会让队员建不出来。
  多条 restriction 取交集，所以逐个调用与一次性调用语义等价。
- **同名遮蔽工具用法段**：`restrict` 只过滤工具 schema，「怎么用这个工具」是各工具行**独立**注册的
  提示词段。工具摘了段还在，提示词就在教队员调用它没有的工具。所以队员作用域里还会用**同名空段**
  清掉 `tool:goal` / `tool:workflow`（`TEAMMATE_SECTION_MUTES`）。`merge` 取最近的同名段，
  `renderPrompt` 丢弃空段，所以祖先文本被真正压掉、也不会留下空行。
- **只给 9 个团队工具**：`spawn_teammate` / `interrupt_agent` / `wake_teammate` / `broadcast_message` 是 Lead 专属，
  队员拿到的是 `MEMBER_TEAM_TOOL_NAMES`（= 官方九个减前两个，再加队员专用的 `report_result` 与 `ask_lead`）。
  工具面从 schema 层就没有，
  而不是注册了再靠权限拒绝——后者会把目录撑大、还要在提示词里解释它们为什么不能用。

**(3) 顺手关掉了「中途改系统提示词就掉缓存」的那个坑（其实是官方帮我们关的）。**
`deepseek-flash` 的路由声明了 `systemPromptUpdate: in-history` 与 `toolUpdate: addition-only`：
前者让「系统提示词变了」变成**在历史尾部追加一条 system 消息**，而不是重写 message 0；
后者让 `startsSeries` 不再因为工具目录变化而重启请求序列
（`dsh-agent-loop/lib/index.js:1054` 的 `preparedCall?.toolUpdate === void 0 && this.toolsChanged(...)`）。
所以 `/team` 中途开启时新增的团队工具与策略段**不会**把之前的前缀缓存全部作废。

> 一句话总结：**队员之间的差异只允许出现在 Lead 的派活提示词里**。任何往队员系统提示词或队员工具面里
> 塞「随队员/随角色变化的东西」的改动，都会静默打掉缓存命中率——`selftest.cjs` 与
> `integration-test.cjs` 各有一条断言守着这件事。

### 4.5.1 提示词卫生（2026-09-30 第二轮：干净、有条理、简洁而作用大）

系统提示词是**每一次请求都要重付的前缀**，也是模型真正读的那份"工作手册"。所以要像代码一样管：

- **分工**：`PLAYBOOK` 只放**纪律**（该怎么做），`TEAM_POLICY` 只放**运行期语义**（工具返回什么、
  状态是什么意思）。同一件事写两遍 = 多付钱 + 迟早自相矛盾。`selftest.cjs` 有一条闸门：
  `noProgress`/`inactive`/`已持久化`/`revision` 只许出现在 `TEAM_POLICY`，
  `设计树`/`写域`/`返工回同一个队员`/`逐条裁决` 只许出现在 `PLAYBOOK`。
- **预算**（闸门写死在 `selftest.cjs`，超了就 FAIL）：

  | 文本 | 预算 | 当前 | 谁在读 |
  |---|---|---|---|
  | `PLAYBOOK` | ≤ 3900 | **3891** | 调度模式的**每一次**请求（Lead） |
  | `TEAM_POLICY` | ≤ 800 | **575** | 团队开启后的 Lead |
  | `TEAMMATE_CARD` | ≤ 1150 | **1134** | 每个队员的固定前缀 |
  | Lead 侧合计 | ≤ 4900 | **4466** | |
  | 队员侧合计（卡 + 角色简报） | ≤ 1550 | **1509** | 简报是第一条 user 消息，同样进前缀 |

- **不重复注入**：`integration-test.cjs` 用真运行时渲染提示词，断言 `PLAYBOOK` / 队员卡 / 团队事实段
  在渲染结果里**各只出现一次**（`enable` 被调两次、段注册两次都会当场红）。
- 2026-09-30 那一轮的实测收缩：`PLAYBOOK` 4858 → 3945（−19%）、`TEAM_POLICY` 901 → 575（−36%）、
  `TEAMMATE_CARD` 1444 → 1018（−29%），而**规则一条没少**（合并同类项 + 把语义搬去 `TEAM_POLICY`）。
  2026-10-01 为了加两条纪律（`/team` 用户消息的判据、队员被截断后叫它续写）又长了 150 字符（3945 → 4095），
  同时压掉了三处重复表述（「而你的 token 更贵」与 §6 重复、两处冗词），**净增仍在预算内**。

---

## 5. 已知边界（不是 bug，是当前运行时的硬事实）

### 5.1 为什么命令入口是 ASCII 的 `/team`

0.1.7 的命令名校验是 `/^[a-z][a-z0-9_-]*$/u`（`dsh-commands/lib/index.js:78`，`:150` 不匹配直接
`TypeError`）——所以**中文命令名不可能注册**。

更关键的是实测结论：Web 客户端里未注册的 `/xxx` 输入派发到 `undefined` 分支后，
**会被命令面板吞掉，既不发模型也不报错**（用户实测：打 `/智能体团队` 什么都不会发生）。
所以「用提示词让 Lead 识别中文斜杠命令」这条路**走不通**，已放弃：

- 唯一入口是 ASCII 的 **`/team`**（`/` 菜单里可搜到，描述是中文，**且只在调度模式里出现**）；**没有 `/team-off`**（关闭团队走 `disable_agent_team` 工具）；
- 非斜杠的自然语言（「组队」「开团队」）仍然有效，因为那是普通消息；
- 调度模式的提示词里明确写了「不要等待任何其它斜杠入口」，避免 Lead 干等。

### 5.1.1 为什么命令只在调度模式里出现

因为是**注册在调度模式的 preset 作用域里**（见 §4.6）：`dsh-commands` 的有效命令 = 全局层 + 该会话
agent 的作用域链合并，preset 层对它自己的会话可见、对别的 preset 不可见。副作用是好的：
`/` 菜单在别的 preset 里干净（不会多出一个你在这个模式里用不了的命令）。

### 5.2 队员无法使用字面上不同的 preset

子会话的 preset 被硬编码为继承父 agent 的**实时** preset，没有配置项也没有 spawn 参数
（`dsh-subagent/lib/types/child-agent.js:113,158`；descriptor v3 白名单禁止该字段）。
改它需要动 5+ 处、跨 2–3 个包并 bump descriptor 版本，而这些包在**只读的 `app.asar`** 里。

本插件的等价做法：调度模式的插件行 = **「极简灰度模式」的全量行** + 团队行；
队员额外拿到一张**与角色无关的共享队员卡**，并由插件在自己的作用域里**收窄工具面**
（`ctx.tools.restrict`，见 §4.5），所以队员的能力面 = 极简灰度 **减去** 目标/子代理/Lead 专属开关。
角色差异不进系统提示词，只走 Lead 的派活提示词。
`drift-check.cjs` 会检查两者是否漂移（行身份 + 开关状态 + 顺序 + 行数）。

### 5.3 思考强度只有声明过的模型可选

强度不是固定档位：pi-ai 适配器 7 档（`off/minimal/low/medium/high/xhigh/max`），
内置 DeepSeek 适配器 4 档（`off/low/high/max`）。**只有模型条目里声明了 `reasoningEfforts` 的模型
才广告档位**；显式传一个不被支持的档位会直接抛 `UNSUPPORTED_REASONING_EFFORT`
（`dsh-llm/lib/index.js` 的 `resolveCallConfig`）。

- 配置页**只列该模型真正广告的档位**；没有元数据的模型不显示强度行（这是官方规则）。
- 本插件在派队员前会**预检**：不被支持的档位会被丢掉并写进诊断，而不是让队员创建失败。
- 本机目前只有 `qwen3-8-flash / qwen3.8-flash` 声明的强度可选。想让别的路由也能选，
  需要在 `~/.dsh/profiles/desktop/cordis.patch.yml` 的模型条目里加
  `compat.supportsReasoningEffort: true` 与 `reasoningEfforts`（照抄 `qwen3-8-flash` 那段）。

### 5.4 配置为什么不用官方的 settings 体系

0.1.7 的 `dsh-settings` 已经**没有** `installSection`（那是 0.1.5 的 API）：表单只从插件 Config 里
声明了 `.volatile()` 的字段投影出来，键是**本地 loader entry id**，而且**写入会落到 profile 的
cordis patch**——那正好是崩溃恢复会改名备份的文件。

所以本插件走的是本 profile 里已被验证过的第三方路线（`某个第三方插件` 同款）：

- **自己的 JSON 配置文件**（`~/.dsh/dispatch-agent-team.json`，原子写）；
- **自己的 host HTTP 路由** `POST /zws-dispatch-agent-team/api`（带 `x-dsh-plugin` 跨站闸门头）；
- 客户端半仍然注册在**官方那个槽位** `plugins.bundle.config` 上，所以它出现在官方「插件 → 已安装 →
  详情页」的同一个位置，视觉与官方一致；只是保存语义由我们自己保证（不做「已覆盖/恢复默认」标记）。

代价：官方 settings 的 revision 冲突栅栏与 overridden 标记没有；换来的是零依赖、不被崩溃恢复牵连、
不依赖 0.1.5 的死 API。这是有意的取舍。

### 5.5 其他

- **共享同一个工作目录**：所有成员看到同一份文件。写域切分只靠纪律，不是锁。
- **队员名被限制为 `<角色id>` 或 `<角色id>-N`**：角色是从名字推导的，冷恢复也一致。
- 官方 `agent-team` 的 `maxMembers` 默认是 8（**历史累计**，队员名永不复用）；本插件把它提到 48，
  否则 12 个角色各叫一次就把额度用完了。
- **调度模式 preset 的 `selectedDefault` 当前是 `minimal-grayscale`**（安全选择，理由见 §1 与 §8.1）。
  这不是缺陷；要用调度模式就在推理模式选择器里选一次。

---

## 6. 维护（官方升级后必做）

```
node tools\drift-check.cjs      # 50 项：逐条验证本插件依赖的官方实现细节是否还在
node tools\repair.cjs           # 安装状态体检（bundles / junction / 文件齐全 / 恢复痕迹）
node tools\selftest.cjs         # 纯逻辑回归（角色表 / 配置净化 / 缓存策略 / 报告校验 / 文本不变量）
node tools\integration-test.cjs # 真链路（真 cordis + dsh-tools + dsh-system-prompt + llm/stream 瀑布）
node tools\client-smoke-test.cjs# 浏览器半渲染冒烟
node tools\asar-probe.cjs --grep "<字符串>" --list "dsh-llm/lib"   # 只读探针：官方包里到底有没有 / 是什么
node tools\session-probe.cjs --tools --session <会话子串>          # 只读探针：会话里团队工具面的真实增删
```

`drift-check` 覆盖的假设包括：官方三行 id 是否还在、九个工具名是否还在、
`agentTeams` 方法是否还在、`agent/request` waterfall 是否还在、`ctx.llm` 目录 API 是否还在、
命令名正则是否变化（**如果哪天允许中文命令名了，可以把入口换成中文名**）、
`plugins.bundle.config` 槽位是否还在、`package.json` 的 exports 是否齐全、
`agent-team` 容量覆盖是否完整、官方 `TeamTaskId` 是否仍是恒等函数、
依赖解析 junction 是否可用、**`tools.restrict` 是否还在且仍是「只过滤继承面」的语义**、
**队员收窄名单里的每个名字在官方侧是否有出处**、**被清空的段名是否仍与官方注册的一致**、
**所有文案里的角色数量是否等于真实角色数**、preset 是否落后于极简灰度（行身份 + 开关 + 顺序 + 行数），
2026-09-30 新增的 8 条闸门（`llm/stream` 瀑布与 dispatch 点、监听器契约、保活默认策略、保活硬闸门、
系统提示词指纹、宿主平面观察器、**每个输出 schema 是否显式声明 `additionalProperties`** 见 §8.9、
`report_result` 仍是队员专用），以及 2026-10-01 新增的 5 条闸门：
`agent.id === agent.session.id`（会话记忆的 key 依据）、resume 路径仍 `announce`（恢复判据的来源）、
官方 `dsh-tool-subagent-control` 仍提供同名三工具 + `agent_id`（`agent_id` 别名的理由）、
`lib/runtime.js` 里 `syncAgent`/`enable`/`disable` **三个调用点**是否都还在、
`wake_teammate` 与 `LEAD_TEAM_TOOL_NAMES` 是否仍在（且 Lead 的安装确实用了这张名单）。

任何一项 FAIL，都按它给出的「→」提示改本插件，**不要改 `app.asar`**。

> **`session-probe.cjs` 是干什么的**：会话日志一份几万行（含全部正文与正文流），把整份读进上下文
> 既贵又没用；而「团队到底怎么跑的」只取决于少数几类事件。它把这些抽成一行一条的时间线：
>
> ```powershell
> node tools\session-probe.cjs --sessions                              # 有哪些会话日志
> node tools\session-probe.cjs --tools --session <会话-2>              # 每次 request/header 的工具面与增删
> node tools\session-probe.cjs --calls --session <会话-2>              # 团队工具调用 + 每次的返回原文
> node tools\session-probe.cjs --stops --session <会话-2>              # turn/end 的 reason（max-tokens = 被输出上限截断）
> node tools\session-probe.cjs --counts --session <会话-2>             # 每个工具的真实调用次数（只数 tool/call）
> node tools\session-probe.cjs --models --session <会话-1>             # Lead 与每个队员**实际跑的模型**（含换模型时间线）
> node tools\session-probe.cjs --grep '"kind":"max-tokens"'            # 跨全部会话检索字面量
> ```
>
> 只读：不写任何文件、不改会话日志。§8.10–§8.12 的会话证据都是它跑出来的。

> **`asar-probe.cjs` 是干什么的**：官方代码在 `app.asar` 里，而 `rg` / `glob` / 文件读取都进不去
> （`read` 会报 `Cannot mix BigInt and other types`），以前每次核对都要临时写解包脚本。
> 现在一条命令就能回答「官方那一版里到底有没有这个事件 / 这个方法 / 这个字符串」：
>
> ```powershell
> node tools\asar-probe.cjs --version                                  # 宿主版本 + 条目数
> node tools\asar-probe.cjs --grep "llm/stream" --list "dsh-llm/lib"   # 哪些文件含这个字符串
> node tools\asar-probe.cjs --extract "dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js" host-llm.js
> ```
>
> 它是只读的（除 `--extract` 明确指定的目标文件外不写任何东西），`drift-check` 内部用的是同一套解析。

### 6.1 改代码后必须做什么

| 改动 | 生效方式 |
|---|---|
| `lib/*.js`（host 半） | **必须重启 DSH**（`dsh-base` 的 hmr 行只开 profile 配置重载，模块 root 是 opt-in） |
| `lib/client.js`（浏览器半） | 刷新页面即可 |
| `presets/*.patch.yml`、`cordis.patch.yml` | 走 bundle patch，重新加载插件后生效 |
| 角色表 / 队员名单 / 提示词段 | 改完跑 `selftest` + `drift-check` + `integration-test`，然后重启 |

改完代码先跑这三条再重启，可以避免「重启后才发现 host 行起不来」（§8.1 就是这么发生的）：

```
node --check lib\index.js && node --check lib\runtime.js && node --check lib\tools.js
node tools\selftest.cjs && node tools\drift-check.cjs && node tools\integration-test.cjs
```

### 升级鲁棒性设计

- preset、行覆盖、团队组合全部由**本包自己的 bundle patch** 承载 → 官方升级不覆盖。
- 代码全部在 `~/.dsh/plugins/` 与 profile 的 `node_modules` 里 → 不在 `app.asar` 内。
- **零改官方包**：队员的模型/强度覆盖走官方支持的 `agent/request` waterfall（每个 agent 作用域），
  不是 fork。
- 唯一的脆弱点是「崩溃恢复」：那个动作会把 profile 的 `cordis.patch.yml` 改名备份并重置
  `dsh.profile.bundles`。`tools/repair.cjs --apply` 能把 bundles 列表补回来（本插件不依赖
  profile 的 patch，所以 preset 不会因此丢）。

---

## 7. 卸载 / 回退

1. 卸载（三选一）：
   * `node tools\install.cjs --uninstall`（推荐：走官方 CLI，先退出桌面端）；
   * 界面：插件 → 已安装 → 调度模式智能体团队 → 卸载；
   * 直接 `dsh plugin --profile desktop remove @zws/dsh-dispatch-agent-team` —— 注意**必须**用
     桌面端自带的那份 `dsh.cmd`（见 §1.1），PATH 上的独立 CLI 会拒绝 desktop profile。
2. 回到推理模式选择器，把默认 preset 换回你原来的那个（新会话默认值存在
   `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `agent-preset-registry.selectedDefault`）。
3. 恢复官方 Agent Teams 的完整行为：`node tools\install.cjs --uninstall` 会在卸载成功后**自动串跑**
   `tools/repair.cjs --revert`，删掉 profile 层那段 `dispatch-agent-team:managed` 块
   （`tool-agent-team: disabled` + `agent-team` 容量覆盖），并留下 `.bak-<时间戳>-pre-dispatch-team-revert`
   备份。它是幂等的（没有托管块就是空操作）。走界面卸载、或 `emergency-disable.cjs` 应急摘 bundle 时
   **不会**自动回收，需自己跑一次：`node tools\repair.cjs --revert`
   （或手工删 `# ── dispatch-agent-team:managed:start/end ──` 两行之间的整段，删前备份）。

卸载后 `~/.dsh/dispatch-agent-team.json`（角色配置）与 `dispatch-agent-team-sessions.json`
（会话记忆）会留下，可以手动删。

---

## 8. 事故记录与应急处理

### 8.1 2026-09-27：应用无法启动（已修复）

**症状**：装好本插件后重启 DSH，弹出「应用无法启动或已意外停止 / web boot: 1 entry did not
activate / `@zws/dsh-dispatch-agent-team`: import failed」；同时插件页报
`新建会话失败：agent-preset/not-found: Unknown agent preset: dispatch-mode`。

**根因（renderer 控制台里能看到精确报错）**：
```
Uncaught SyntaxError: Identifier 'factory' has already been declared
  /plugins/??…,某个第三方插件/client.js,@zws/dsh-dispatch-agent-team/client.js,…
```
多个 client bundle 会被客户端**拼成一个脚本**执行。mcp-manager 与本插件的 `lib/client.js`
**都在顶层写 `const factory = (require) => {…}`** → 同一个脚本里重复声明同名 `const` →
语法错误 → **整个拼合脚本（含官方 bundle）一起失败** → 应用起不来。
官方 bundle 的写法是「把匿名箭头直接内联进 `load({ factory })`」，顶层零绑定。

**修复**：[lib/client.js](lib/client.js) 改为内联匿名箭头（顶层零声明、只有一条 `load()` 语句）。
验证方式是把**真实故障 URL 里的 10 个 client bundle 按同样顺序拼起来跑语法检查**（exit 0）。
[`tools/drift-check.cjs`](tools/drift-check.cjs) 现在多了一条硬校验：客户端半出现任何顶层
`const/let/var/function/class` 直接 FAIL。

**次生损伤**：那次启动失败触发了两轮崩溃恢复，`cordis.patch.yml` 被改名成
`cordis.patch.yml.bak-<epoch>`、`dsh.profile.bundles` 被重置成 shipped 模板 —— 也就是
**你的 provider / MCP / preset 配置一度全部失效**。已从最新完整备份恢复（471 行），
并把 `selectedDefault` 改回 `minimal-grayscale`：这样**即使插件出问题也不会再卡住新建会话**。

**教训（写进纪律）**：
1. `lib/client.js` 永远不许有顶层声明 —— 有 drift-check 守着。
2. **不要把某个 preset 设成 `selectedDefault`，除非它的提供者一定在**：preset 找不到会让
   新建会话直接失败，故障面远大于「默认 preset 不是你想要的」。用 preset 选择器一次点击切换即可。

### 8.2 2026-09-27 晚：选中「调度模式」但 `/` 菜单里没有 team（已修复）

**症状**：新建会话选中调度模式，输入 `/` 只有 file/goal/plan/feedback/compact/permission/model/export，
**没有 team**；同时会话日志显示 preset 被**反复来回切**：

```
17:22:43 → minimal-grayscale      21:33:23 → dispatch-mode
17:22:46 → dispatch-mode          21:33:27 → minimal-grayscale
18:11:39 → minimal-grayscale      22:55:40 → dispatch-mode
                                  22:55:45 → minimal-grayscale
                                  00:37:45 → dispatch-mode
```

**两个独立原因**：

1. **默认 preset 在和用户手选互相覆盖**：`agent-preset-registry.selectedDefault` 是
   `minimal-grayscale`，客户端会在某些时机把它重新应用到会话上，于是「你刚选 调度模式，几秒后又被顶回
   极简灰度」。修法：把 `selectedDefault` 改成 `dispatch-mode`（在 profile 的 `cordis.patch.yml`），
   让自动应用与手选**一致**。
2. **命令注册在 preset 子树里，子树一旦 broken 就什么都不剩**：preset 子树里的异常只会变成
   `record.broken` + 一条宿主 warn，桌面端不落盘 → 表现就是「静默没命令」。修法见 §3 的引用块：
   控制面搬到宿主平面 + preset 子树只留一次 try/catch 的 section 注册 + 启动写状态文件。

**教训**：
- 不要把「用户可见的能力入口」放在 preset 子树里 —— 它的失败是静默的、且会让整份 preset 一起死。
- `selectedDefault` 只能有一个真值来源；它和手选不一致时会出现「反复横跳」。
- 排查这类问题不能靠猜：先看 `~/.dsh/dispatch-agent-team-status.json` 与
  `~/.dsh/sessions/**/session.v4.jsonl.zstd` 里的 `agent-preset/selected` 序列（多帧 zstd，按
  magic `28 B5 2F FD` 分帧解码）。

---

### 8.3 2026-09-28：输入 `/team` 「没有这个指令」（已修复）

**症状**：在调度模式里输入 `/team`，命令面板里没有 `team`；**没有任何报错**；插件页正常、配置页能读能存、
`~/.dsh/dispatch-agent-team-status.json` 里 `diagnostics` 还是**空的**、我们的行 `phase: 2`（active）。

**根因（两层，缺一层都修不好）**：

1. **cordis 的 ctx 属性访问要求服务出现在「本 fiber 的 inject 列表」里。** 未 inject 时它抛
   `cannot get property "commands" without inject` —— reflect 代理的 `internal/get` 只沿**祖先** fiber
   的 store 往上找，而宿主平面的 `commands` / `tools` 是**兄弟 fiber** 提供的
   （`dsh-base/cordis.patch.yml:286` 的 `commands`、`:461` 的 `tools`、`:465` 的 `system-prompt`），
   从本插件的 ctx 往上走找不到它们。同 profile 里唯一跑通的第三方插件
   `某个第三方插件` 正是因此把所有服务都写进了 inject
   （`lib/index.js:17`，它自己的注释 `:41-42` 就是这句话）。
2. **2026-09-27 深夜那次「控制面搬到宿主平面」的重构只改了注册位置、没改取服务的方式**：
   `lib/index.js` 的 `inject` 仍是 `['webServer']`，而 `registerControls()` 直接写 `ctx.commands` /
   `ctx.tools`。于是 `apply()` 第一步就抛，异常被那层 try/catch 吞成一条 **console warn**
   （Electron 的 stdout 没人看）→ 插件照常加载、配置页照常可用，但
   **`/team`、`/team-off`、`enable_agent_team`、`disable_agent_team` 四个入口一个都不存在。**
   也就是说「搬到宿主平面后 / 菜单里就能搜到 team」这个结论当时**从未被真正验证过**。

**修法**（见 `lib/index.js` 控制面注册处的长注释）：

- `lib/index.js` 改用 **`ctx.inject(['commands','tools'], cb)`**：等依赖就绪后回调，回调 ctx 声明了
  这两个依赖所以属性访问合法；同时**不**把它们写进本插件行的 `inject`（否则「这两个服务缺席 =
  整个插件不 apply」，配置页会跟着消失 —— 这正是当初只 inject `webServer` 的理由）。
- `lib/preset.js` 的 `registerControls` 改用 `serviceOf(ctx, name)`：**优先 `ctx.get(name)`**
  （全局 store 查询，不受 inject 约束），退回属性访问，两条都失败才记一条诊断。
- 顺带把控制面注册结果写进 `runtime.recordBootNote` 并补写状态文件：**这类故障的特征就是
  「一切都正常，只是能力不见了」**，必须让它在状态文件里留下痕迹。

**测试为什么第一次没抓住**：集成测试用的是 `new Context()` 建的真实 ctx，没有 loader 时
`ctx.fiber.runtime` 为空 → cordis 走 `reflect.get` 兜底 → **属性访问是通的**，于是测试通过而线上失败。
现在测试里加了一层 `loaderLikeCtx`（复刻 loader 语义：未 inject 的属性访问**抛错**），
`drift-check` 另加一条静态检查（`lib/index.js` 必须走 `ctx.inject`/写进 inject；`lib/preset.js` 不许出现
裸的 `ctx.commands` / `ctx.tools`）。

**教训**：
- 「异常被 try/catch 吞成 warn」+「warn 只进 Electron stdout」= 一个**静默丢能力**的组合。凡是
  try/catch 兜住的能力注册，都必须把结果写进**能被读到**的地方（状态文件 / 诊断环）。
- 测试里的 ctx 必须复刻**真实 loader 的语义**，否则给出假绿灯 —— 尤其是 cordis 这种
  「同一个对象在 loader 内外行为不同」的容器。同 profile 的 `某个第三方插件` 就是现成对照。
- 同一症状可以有完全不同的原因：§8.2 是 preset 子树 broken，§8.3 是控制面注册抛错。
  排查顺序应当是「状态文件 → `/` 菜单 → 工具列表」，不要猜。

### 8.4 2026-09-28：插件页常驻一条红色「宿主诊断（配置文件可能有问题）」（已修复）

**症状**（用户截图，5 行）：标题是红的「宿主诊断（配置文件可能有问题）：」，内容是

```
调度模式控制面已注册（仅本 preset 可见）：command:team, tool:enable_agent_team, tool:disable_agent_team
DSH 主目录：<DSH 主目录>（由 <home>/profiles 存在性确认）      ← 两遍
配置文件：<DSH 主目录>\dispatch-agent-team.json                ← 两遍
```

**结论先说：什么也没坏。** 那 5 行全是**正常事实**，一行故障都没有。真实缺陷有两个，都在我们这边：

1. **通道用错了**：`recordDiagnostic()` 同时承载「故障」与「一切正常的事实」，而页面把整条通道
   渲染在「配置文件可能有问题」这个红色标题下（`lib/client.js` 的 `diagnosticsTitle`）。
   于是只要插件在跑，用户就**永远**看到一条红色告警。团队开/关的回执、安装回执、被 preset 边界
   拒绝的调用也都写在这条通道里 —— 用完 `/team` 之后页面会再多几行红字。
2. **同一句被记了两遍**：定位 DSH 主目录 / 配置文件路径的两个函数是典型的
   **check-then-act 竞态** —— 判断（`state.home !== undefined`）在 `await settings.prepareDocument()`
   **之前**，赋值在 await **之后**。而宿主启动时 `apply()` 会 fire-and-forget 地同时起两条路径
   （`lib/index.js:282` 的 `loadConfig` 与 `lib/index.js:336→:369` 的 `writeStatusFile → getConfigPath`），
   第二个调用者从同一个窗口挤进来，把同一次定位**重算并重记**一遍。
   两种时序都复现过：两个 await 隔 tick 结算时交错排列，同 tick 结算时**连在一起**
   ——后者正是截图里的形状（主目录 ×2，然后 配置文件 ×2）。

**修法**：

- 通道一分为二（`lib/runtime.js`）：`diagnostics` 只放「宿主/配置/注册真的坏了、需要用户在这个页面上
  处理」的故障；`notes` 放正常事实（主目录、配置文件路径、控制面注册结果、团队开/关回执、安装回执）。
  两条通道都进 HTTP `get` 响应与状态文件；页面把 `notes` 渲染成**中性信息块**，红色告警只在
  `diagnostics` 非空时出现。`preset.js` 的 `recordBootNote(message, kind)` 多了 `kind`
  （`'info'` = 信息通道），`/team` 注册成功那条走 `'info'`。
  规则写在 `lib/runtime.js` 的 `recordDiagnostic` 注释里，避免后人再混。
- 竞态用 **promise 缓存**收掉：`homePromise` / `configPathPromise` 缓存「进行中的那一次」，
  并发调用共享同一次定位（与 `loadConfig` 的 `loadPromise` 同一手法）。
- 回归测试：`tools/integration-test.cjs` 用**独立模块实例**（带 query 的 ESM URL）复现两种时序，
  断言「各只记一条 + 故障通道为空」；再加一条走**真 HTTP 路由**的断言，确认 `get` 返回的
  `diagnostics` 里**没有**正常事实、`notes` 里有配置文件路径与「团队已开启」。
  `tools/client-smoke-test.cjs` 断言 `notes` 渲染成中性块且**不**出现红色标题。

**教训**：
- 「日志/诊断通道」的**语义**必须和渲染它的**样式**对齐。一条通道两种语义，迟早会在
  「什么都没坏」的时候报警 —— 报警疲劳比不报警更糟。
- 带 `await` 的惰性初始化（lazy init）**默认就是竞态**。凡是「算一次、缓存住」的异步函数，
  缓存必须缓存**进行中的 Promise**，而不是只缓存结果。
- 桌面端 0.2.0-rc.1 升级**不是**这条告警的原因（本缺陷自 `writeStatusFile` 引入就存在，
  与版本无关）；升级本身逐条复核过，官方假设全部未变，见 INTERFACES 勘误表第 21-24 条。

### 8.5 应急：DSH 起不来时的一键退出

```
node "<DSH 主目录>\plugins\dsh-dispatch-agent-team\tools\emergency-disable.cjs"
```

**裸执行**（不带任何开关）只做一件事：把本包名从 profile 的 `dsh.profile.bundles` 里移除
（先备份 `package.json`），然后重启 DSH 即可。这是应急路径，故意没有二次确认。

其它开关都**不会顺手摘 bundle**（2026-09-28 修：旧实现带 `--patch-report` 也照样摘，
而文档写着它只读 —— 「文档说不改、实际改了」比功能缺失危险得多）：

| 开关 | 作用 |
|---|---|
| `--patch-report` | 只列出 patch 备份与当前 patch 大小，**完全只读** |
| `--restore-patch --from <序号\|文件名>` | 用指定备份覆盖 `cordis.patch.yml`（先 guard 备份当前文件） |
| `--restore-patch`（不给 `--from`） | 候选多于一个时**拒绝执行**并列出候选，exit 1，不写任何文件 |
| `--dry-run` | 只报「会做什么」，不写任何文件 |
| `--remove-bundle` | 与其它开关同用时，才显式要求摘 bundle |

它还会检查 `selectedDefault` 是否指向本插件的 preset（这会卡住新建会话）并给出改法。

**已在沙箱 profile 上实测 12 项**：`--patch-report` 不写盘、候选不唯一时拒绝、`--from` 恢复生效并留 guard 备份、
`--from` 无效值 exit 2、裸执行才摘 bundle 且先备份、各模式都不碰不相关的文件。

### 8.6 2026-09-28：bundle patch 的 `disabled: true` / `config` 被官方 bundle **静默顶掉**（已修复）

**怎么发现的**：用户升级桌面端到 **0.2.0-rc.1** 后贴来插件页截图（问「什么情况，有问题么？」）。
查截图里那条「宿主信息」的同时，顺手读了 host 半写的状态文件
`~/.dsh/dispatch-agent-team-status.json`，发现运行时的行状态与我们文档写的**完全相反**：

```
rows:
  tool-agent-team  disabled: false  phase: 2   ← 我们一直以为它被我们关着
  ui-agent-team    disabled: false  phase: 2   ← 同上
  agent-team       disabled: false  phase: 2   （状态文件当时还没记 maxMembers）
```

旁证（不需要看状态文件就能确认）：**当前这个会话（默认 preset = 极简灰度模式）的工具表里就有
`spawn_teammate` / `send_message` / `wait_agent` / `team_task_*`** —— 那是官方 `tool-agent-team` 注册的；
系统提示词里也带着官方的 Team Lead 方法论段。也就是说官方团队面**全程都是开着的**。

**根因（顺序，不是版本）**：官方 `@deepseek-ai/dsh-experimental-agent-team-profile` 的 patch 用
`- insert: [...]` **新建** `agent-team` / `tool-agent-team` / `ui-agent-team` 三行；而 patch 层按
`dsh.profile.bundles` 顺序应用（`dsh-app-boot` 的 `loadProfileDirectory` →
`readProfilePatches` → `composeEntries`）。本机的 bundles 顺序是：

```
dsh-base, dsh-web-app, @zws/dsh-dispatch-agent-team, @deepseek-ai/dsh-experimental-agent-team-profile, …
                                  ↑ 我们在官方之前
```

于是我们的 `- id: tool-agent-team, disabled: true` 落在「**还不存在的行**」上 → 静默无效；
`- id: agent-team, config: { maxMembers: 48 … }` 同样被官方 insert 的默认值 **8 / 256** 覆盖。
为什么顺序会是这样：**DSH 插件页启用一个 bundle 时是 append 到 `bundles` 末尾**
（`dsh-plugin-manager` 的 `selectBundle`：`[...previous, name]`）——所以「谁在后面」取决于
**用户的启用顺序**，这种写法天生不可靠。（官方自己的 patch 也依赖这个语义：它用
`- id: tool-subagent*, disabled: true` 关掉 `dsh-base` 先建的四行，那是「后写覆盖先写」。）

**影响**：
1. **P0（快到了）**：有效 `maxMembers = 8`，而官方 roster 是**历史累计**、队员名永不复用 ——
   12 个角色各叫一次就把额度用完，之后派不出任何队员（§4.2 讲的正是这个坑）。
2. **P1**：调度模式里同时存在两套团队（官方九工具 + 我们的），提示词里叠加两份 Lead 方法论
   （官方 `team:policy` 段 + 我们的 PLAYBOOK）——多花 token，而且模型不知道该听谁的；
   用户明确要求「调度模式只能用我的插件智能体团队」。

**修法（两条路各自只做自己能做到的事）**：

1. **容量覆盖 → profile 自己的 patch 层**（`~/.dsh/profiles/<profile>/cordis.patch.yml`）：
   它在所有 bundle 层之后应用（`readProfilePatches` 的顺序：各 bundle 层 → profile 层 →
   `<dshHome>/cordis.patch.yml` → overlays），所以顺序无关。
   `tools/repair.cjs --apply` 负责写入/修复，并在有状态文件时打印**运行时有效值**。
2. **官方工具面 / 策略段的抑制 → 调度模式的 preset 作用域**（`lib/preset.js` 的
   `suppressOfficialTeam`）：逐个 `tools.restrict({ deny:[name] })` 摘掉九个**同名的**官方工具
   （restrict 只过滤**继承面**，本作用域与更深作用域自己注册的东西不受影响），
   再注册一个同名的空 `team:policy` 段遮蔽官方方法论（`renderPrompt` 丢空段）。
   于是**只有调度模式**变干净，别的 preset 照旧能用官方团队 —— 与用户划的线一致。
   本包 `cordis.patch.yml` 里那两条 `disabled: true` 已删除（顺序依赖的写法不允许再出现，
   `drift-check` 有闸门）。

**顺带修掉的两个东西**：

- `lib/roster.js` 新增 `OFFICIAL_TEAM_POLICY_SECTION = 'team:policy'`（官方段名的唯一真值，
  drift-check 守着它没变）。
- **`ctx.effect(() => ctx.systemPrompt.section(...))` 是个陷阱**：cordis 会把 effect 回调放在
  自己的 fiber 上执行，回调里用**属性访问**取服务时按那个 fiber 的 `inject` 列表判定 ——
  回调和 `apply` 不是同一个 ctx，于是这一句可能抛 `cannot get property "systemPrompt" without inject`，
  整段 PLAYBOOK **静默消失**（只留一条诊断做痕迹）。集成测试正是抓到了这个（调度模式提示词里没有
  PLAYBOOK，长度只有 48 字节的 harness identity）。现在改成先在 `apply` 里用 `serviceOf(ctx,…)`
  取好服务、再进 effect（与 `registerControls` 同一手法）。用户现场那份状态文件里没有这条失败记录，
  所以线上此前是好的 —— 但这条依赖太脆，不能在代码里留着。

**教训**：

- **patch 层的顺序是语义的一部分**。「我写了 `disabled: true`」≠「它被关掉了」；
  凡是 id 覆盖，都要问一句「这一层是在那一行**被创建之前**还是之后应用的」。
- **不要用别人的 `insert` 行当自己的开关**。官方随时可以改 insert 的内容/顺序，
  而我们的失效方式是**静默**的（没有报错、没有日志，只有运行时行为不对）。
- **文档里写下的「已关闭 / 已覆盖」必须有运行时可观测的证据**：这次是状态文件里的
  `disabled` / `phase` / `maxMembers` 与「本会话工具表」把假绿灯照出来的。
  为此状态文件现在还额外记录 `agent-team` 的**有效** `maxMembers` / `maxTasks`。

### 8.7 2026-09-28（当晚第二例）：插件页刷出 9 条「未抑制官方工具 …」（已修复）

**症状**（用户重启后截图）：红色「宿主诊断（配置文件可能有问题）」下面 9 行，每行形如

```
未抑制官方工具 spawn_teammate（该名字不在本 preset 的继承面里）：
  tools.restrict() names unknown global tool "spawn_teammate"; known global tools: list_mcp_resource_templates, …
```

**两层根因**：

1. **我把 suppress 的报错接错了通道**：`lib/preset.js` 里那 9 条是「正常情况」的说明（我自己在代码
   注释里就是这么写的），但 `note(message)` 没带 `'info'` → 全进了**故障**通道 → 页面按红色告警渲染。
   （同一次改动里我已经给「控制面注册成功」加了 `'info'`，这 9 条漏了。）
2. **更重要：这个抑制手段本身是错的**。官方 `tool-agent-team` **不是**把九个工具注册到全局层，而是
   给**每一个 live agent** 装进**它自己的 agent 作用域**：
   - `dsh-experimental-tool-agent-team/lib/index.js:539-546`：`maybeInstall` 只在
     `tryMembership(agent) === undefined` 时跳过；源码 :225 的注释原话是
     「Team tools are registered only in an exact Agent scope」；
   - `dsh-experimental-agent-team/lib/index.js:397-426`：`tryMembership` 对**任意非子代理 agent**
     都返回 `{root: agent, role: "lead", name: "lead"}` —— 所以每个会话都会被装上。
   于是 `tools.restrict()`（只认**全局层**名字，官方报错原文 `names unknown global tool "x"`）
   在 preset 作用域里逐个 deny 这九个名字 **必然全部失败**；而且 restrict 的语义是「只过滤继承面，
   从不影响本作用域自己注册的东西」，agent 自己那一层永远过滤不掉。

**这还牵出一个 P0**：官方那九个工具与本插件的九个工具**同名、同作用域** → 同名注册会抛
`tool "x" is already registered in this scope`（集成测试里有断言钉住了这个事实）→
**本插件的工具装不上**，于是 `spawn_teammate` 用的是官方 schema：没有 `role` / `model` /
`reasoning_effort` 参数 —— 角色与模型配置**全部不生效**。`lib/runtime.js` 的 `installTeamTools`
本来就会回滚并给出这条诊断，但它落在信息通道里，所以表现为「页面上只有那 9 条红字，真正要命的那条
反而看不见」。

**修法**：

- **profile patch 层把官方 `tool-agent-team` 行整行关掉**（与容量覆盖同一个 managed 段，
  `tools/repair.cjs --apply` 维护，顺序无关）。关掉之后官方不再往任何 agent 作用域装同名工具，
  本插件的九个工具才能干净地装上去。官方 `agent-team` 域服务行与 `ui-agent-team` UI 行保持启用。
- `lib/preset.js` **删掉**那 9 次 `restrict` 尝试，只保留「同名空段遮蔽 `team:policy`」
  （幂等且无害：官方行关了就是多注册一个空段，被 `renderPrompt` 丢掉）。
  `drift-check` 加闸门：`lib/preset.js` 里**不许**再出现 `restrict`。
- `lib/runtime.js`：工具撞车从信息通道改到**故障通道**（`problems`），文案直接给出修法
  （`node tools\repair.cjs --apply` + 重启）；`drift-check` 断言这条接线还在。
- `tools/repair.cjs`：把「profile 层关掉官方工具行」纳入体检与 `--apply`，并打印**运行时**判据
  （读状态文件里 `tool-agent-team` 的 `disabled`）。写入后用哨兵注释 + 自检，避免再发生
  「块尾换行被吃掉、下一行被注释吞掉」这种事（这一次真的发生过一次，已修）。

**教训**：

- **`tools.restrict` 只能摘「全局层」的名字**。官方把工具装进 agent 自己那一层时，唯一的确定性手段是
  **不让那一行启动**（在更靠后的 patch 层 disable 它），而不是在别的作用域里想办法过滤。
- **「同名同作用域」是硬冲突，不是遮蔽**。凡是我们与官方提供同名工具的地方，都要先问一句
  「它们注册到哪一层」。
- **我自己写的「这是正常情况」的注释，必须与代码里的通道一致**：注释说正常、代码却送进故障通道，
  用户看到的就是 9 行红字。现在这两条都由 drift-check 的接线断言守着。

### 8.8 2026-09-29：会话里还挂着 4 行 `/team-off · 本会话的智能体团队本来就未开启，无需关闭。`

**先说结论：这 4 行是 2026-09-28 的历史记录，不是活命令。** 现行代码里没有 `/team-off`
（2026-09-28 22:20 删除，有 selftest / drift-check / integration-test 三道闸门），
本机**所有**会话日志里最后一次 `/team-off` 调用是 **2026-09-28 17:09:43**。

**判据（都可复现，`node tools\history-audit.cjs` 一次跑完）**：

| 事实 | 数值 / 位置 |
| --- | --- |
| 本机 `/team-off` 调用总次数 | **4 次**，全在 2026-09-28 12:36:45 / 16:59:52 / 17:00:06 / 17:09:43（会话《询问助手模型身份》`session-bb3f223f`） |
| 现行 `lib/` 最新改动 | 2026-09-28 22:20:43 —— **晚于**上面每一次调用（即删掉命令之后没有任何一次调用） |
| 当前运行实例（宿主 2026-09-29 22:41:01 启动）注册的命令面 | `dispatch-agent-team-status.json` 的 notes：`调度模式控制面已注册（仅本 preset 可见）：command:team, tool:enable_agent_team, tool:disable_agent_team` —— **只有 `team`** |
| 桌面端 0.2.0-rc.2 的 `app.asar` | 12 967 个文件 / 372 MB 全量扫过：`team-off` **0 命中**；官方 `dsh-experimental-agent-team*` 三包**不含任何斜杠命令注册** |

**为什么气泡不会自己消失**：会话日志是 append-only，且**要求 seq 从 0 连续**——
`dsh-session/lib/types/surface.js:400`（`session event seq N is not contiguous; expected M`）、
`dsh-session-persistence/lib/index.js:230`（append 时 `append seq mismatch`）。
删掉历史事件会让整份会话读不出来，所以本插件**不做**这件事。那 4 行只能跟着那个会话一起被删掉，
代价是丢整段聊天记录 —— 我们不替你做这个决定。

**你现在能做的验证**：在任意模式里输入 `/team-off` → 客户端把未注册的命令直接吞掉，
**什么都不会出现**（连报错都没有），这正是你要的「不用提示」。

```powershell
node tools\history-audit.cjs            # 查 team-off 的全部历史调用 + 与现行代码的时间对比
node tools\history-audit.cjs --all      # 本机出现过的所有斜杠命令与次数
```

### 8.9 2026-09-30：一个新工具的 schema 写错，**整个 Agent 的团队工具都装不上**

**症状**：集成测试里「队员缺 7 个团队工具」，而宿主日志里是一句
`unsupported JSON schema: schema.additionalProperties must be explicitly true or false`。

**根因**：新增的 `report_result` 输出 schema 写成了 `{type:'object', properties:{…}}`，
漏了 `additionalProperties: false`。DSH 的 `defineTool` 在**注册期**就拒绝它，而注册是**整批**做的
（`installTeamTools` 一次注册十个定义），于是**一个 schema 写错 = 整批都装不上**。
更糟的是失败被 `enable_agent_team` 吞成一条诊断，表面上只是「工具少了几个」。

**修法与闸门**：

- 修：`REPORT_VALUE_SCHEMA` 补 `additionalProperties: false`（并给每个字段补 `required`）。
- 闸门：`tools/drift-check.cjs` 现在扫描 `lib/tools.js` 里**所有** `*_SCHEMA` 常量，
  任何 `type:'object'` 少写 `additionalProperties` 直接 FAIL；集成测试断言队员拿到的团队工具
  **等于** `MEMBER_TEAM_TOOL_NAMES`（多一个少一个都算失败）。
- 这条也写进了 `INTERFACES.md` 勘误表第 34 条（附官方 `team_task_create` 的数组参数写法）。

### 8.10 2026-10-01：宿主重启后，团队工具**在会话里被移除**（已修复）

**症状**：用户截图里会话中出现一行「移除：spawn_teammate, team_task_create, 1…」；随后 Lead 的
`spawn_teammate` / `wait_agent` 报 `Error: unknown tool`，`send_message` 报
`Error: invalid arguments: missing required property "agent_id"`。

**根因**（两份会话日志逐条对齐，见 §8.10）：

1. 团队开关只在**内存**里（`lib/runtime.js` 的 `state.roots`）。宿主重启后 `state.roots` 为空，
   `syncAgent()` 的补装条件 `state.roots.has(agentId)` 不成立 → **我们那 9 个工具一个都没装回来**。
2. 会话里仍有 `send_message` / `list_agents` / `interrupt_agent` 三个名字 —— 那是官方
   `@deepseek-ai/dsh-tool-subagent-control` 在**宿主平面**提供的同名工具（参数是 `agent_id`），
   我们装上时在更深的 agent 作用域遮蔽它，卸载后露出来的就是它。于是「名字还在、形状变了」。
3. 那行「移除：…」是 `dsh-agent-loop` 的**开发消息**：每次 `request/header` 落盘时会与上一次
   header 比工具名差集（`lib/index.js:1202-1248`），非空就记一条 `tool-registry` 消息。
   它只是**记录**，不是原因。

**后果**（MATLAB 会话 12:24–14:56）：任务板与 `wait_agent` 全丢，12:36 想派 `builder-core` 被拒，
Lead 只能自己写代码并改用 `list_agents` 轮询。

**修法**（三处）：

- `lib/resume.js`（新增）：按**会话 id** 记住「这个会话开着团队」，落盘
  `<DSH 主目录>/dispatch-agent-team-sessions.json`（原子写 / TTL 7 天 / 上限 200 条 / 失败只记诊断）；
  用户显式关团立刻删记录。
- `lib/runtime.js`：`syncAgent()` 新增 `restoreRemembered()`，在 `agent/created` 里**同步**补装
  （同步的原因：`announce` 是 serial 分发、首个 turn 在它之后才投递，所以恢复后的第一个 request header
  就带上团队工具，用户不会再看到「移除：…」那一行）；`enable()` 落盘、`disable()` 删记录。
- `lib/tools.js`：`send_message` / `interrupt_agent` 也收 `agent_id`（翻译成队员名），
  两种写法冲突时拒绝 —— 纵深防御，避免「官方那份露出来」时模型继续用错形状。

**闸门**：`drift-check` 新增 5 条（`agent.id === agent.session.id`、resume 路径仍 `announce`、
官方同名三工具与 `agent_id`、`syncAgent`/`enable`/`disable` 三个调用点、`wake_teammate` 与 Lead 名单）；
集成测试新增 §8.2（**丢掉全部旧 agent、换全新模块实例**再 `reconcileAgents`，复刻整次重启）。
勘误表第 35–37 条记下了这里用到的官方事实。

### 8.11 2026-10-01 18:26：模型开团后，一句话**排队**在输入框上方（已修复）

**症状**（用户截图，某可视交付任务会话 18:26）：对话进行中，输入框上方突然多出一条排队的消息
`[系统] 智能体团队已开启：团队工具与队员卡已生效。按调度模式继续（…）`，用户还得多点一次「插入」。

**根因**：那句话是我们自己注入的（模型调 `enable_agent_team` 时 `pushInstruction` → `runtime.inject`
→ `agent.followup(text)`）。而 `followup(input)` 的语义是 **`send(input, 'next-turn', true)`**
（`dsh-agent-loop/lib/index.js:806-808`），消息进的是 Session 的 **`next-turn` 收件箱**；
客户端的 **QueueDock 正是从 `next-turn` 读**（`dsh-client-ui-conversation` 的 README.zh.md：
「QueueDock 从 Session 的 `inbox` 投影读取 `next-turn`…」）→ 于是它不是出现在对话里，而是**排队在输入框上方**。

**而且那次注入本来就不必要**：系统提示词与工具目录**每个 step 都会重新组装**
（`dsh-agent-loop/lib/index.js:907` 的 `preStep` → `systemPrompt.assemble()`，
`:1063` 的 `buildRequest(config, preparedCall, assembly.tools, …)`），所以模型在本轮的下一个 step
就已经拿着团队工具与新策略段了。

**修法**：

- `lib/tools.js`：两个开关工具**不再注入任何消息**，改为把一句状态说明放进**工具返回值**
  （`diagnostics`：`团队已开启…` / `团队已关闭…`）——模型看得到，用户界面不受打扰。
- `lib/playbook.js`：删除 `ENABLE_INSTRUCTION` / `DISABLE_INSTRUCTION` 两个常量，
  并在文件末写下判据：**任何不是用户输入的文本都不许走 `followup`**；真要打断当前轮，官方语义是
  `agent.steer()`（`send(input, 'next-step', true)`，同文件 `:809-811`）。
- 命令路径 `/team` 保持注入（用户打的字**只有**这条路径能进模型上下文），注入的是用户原文那一行。

**闸门**：`selftest` 断言那两个常量**保持删除**、并扫 `controlToolDefinitions` 里不许出现
`followup`/`send(`；集成测试断言 enable/disable 之后注入条数不变、状态说明出现在返回值里；
`drift-check` 新增「agent-loop 投递语义未变」（`followup → next-turn`、`steer → next-step`、
`assembly.tools` 每 step 组装）。勘误表第 40 条。

### 8.12 2026-10-01：「跟随 Lead」不生效 —— 队员一直用 spawn 那一刻的旧模型（已修复）

**症状**（用户报告）：把某个角色的模型改成「跟随 Lead」（或换成别的模型）后，**已经在跑的队员**还是用
之前那个模型。

**根因**：`spawn_teammate` 把**角色配置解析出来的路由**也钉进了 runtime 的 `spawnRoutes`
（`lib/tools.js` 旧代码 `runtime.pinSpawnRoute(name, route)`，而 `route` 可能来自
`resolveRoleRoute(peekConfig(), role)`），而队员的覆盖监听器是
`spawnRoutes.get(name) ?? resolveRoleRoute(peekConfig(), role)` —— **钉子永远赢**。
于是「角色配置」对那个队员从此失效：改配置、改回跟随 Lead 都不起作用，只有进程重启（钉子在内存里）才恢复。

**证据（用户自己的会话日志，`tools/session-probe.cjs --models`）**：某可视交付任务会话里
`builder-4` 从 9-30 17:44 起一直跑 `第三方线路B/模型b`（198 条回答），而 Lead 18:02 就换到了
`第三方线路A/模型a`；`builder-2` 同样卡在 `第三方线路B/模型b`（84 条）到 19:46 才切回。
反过来也验证了「跟随 Lead」的定义是对的：没有钉住的队员（`red-team` / `verify` / `builder-4` 后来）
在 Lead 23:22 换模型后 2 分钟内就跟着换了。

**修法**：

- `lib/roster.js` 新增纯函数 `resolveMemberRoute(explicit, roleRoute, explicitEffort)`，
  优先级**显式 spawn 参数 > 实时角色配置 > 不覆盖（跟随 Lead）**；只给强度时只覆盖强度。
- `lib/runtime.js`：`installRouteOverride` 每次请求实时 `resolveRoleRoute(peekConfig(), role)`；
  钉子拆成两个账本 `spawnRoutes`（显式 provider/model）与 `spawnEfforts`（显式强度），
  销毁 agent 时两个都清。
- `lib/tools.js`：`spawn_teammate` 只钉**工具调用显式写的那部分**（`explicit`），
  角色配置一个字都不钉；回执里的 `route` 仍是「本次 spawn 生效的路由」。

**闸门**：`selftest` 六条 `resolveMemberRoute` 优先级断言；集成测试三条
（不钉角色配置 / 显式钉住 / 只钉强度）；`drift-check` 一条源码级接线闸门。勘误表第 41 条。

---

## 9. 实现契约

实现细节、精确的 API 签名、运行时实测记录（`agent/request` waterfall 签名、`ctx.llm` 目录 API、
`ctx.webServer.register`、`plugins.bundle.config` 槽位契约）都在
[`INTERFACES.md`](./INTERFACES.md)。改动本插件前先读它。

---

## 10. 缓存保活（2026-09-30）—— 机制、默认值、怎么验

### 10.1 它解决什么问题

提示词缓存按**前缀**命中。Lead 派完活等队员时，它那段对话前缀可能几分钟到几十分钟没被再次读取；
缓存条目一旦过期，下一次真实请求要把整段前缀按**全价**重读。保活 = 在等待期间用**完全相同的前缀**
再发一次请求（输出只要 1 个 token），让缓存条目「被使用一次」，从而续命。

机制来源：开源项目 [`aa2246740/dsh-model-fusion`](https://github.com/aa2246740/dsh-model-fusion)
的 `src/host/native-keepalive.ts`（Apache-2.0）。核心手法（抓真实请求 → 尾部追加一条消息 → `maxTokens: 1`）
我们照抄；下面这些**它做得不对或没说清**的地方我们改掉了：

| 它 | 我们 | 为什么 |
| --- | --- | --- |
| 间隔 285s（贴 5 分钟 TTL，余量 15s） | `0.7 × TTL`（默认 210s） | 不赌边界；多续一次的成本远小于一次全价重读 |
| 无抖动 | ±7% 抖动 | 多线路/多会话同秒齐发容易被限流 |
| 连续未命中 → **缩短**间隔 | 连续 2 次未命中 → **停** | 未命中说明「这条线路的缓存根本没留住」或「前缀变了」，缩短只会烧更多钱 |
| ping 带 `reasoningEffort` | ping 只带前缀字段（provider/model/messages/tools/system） | 1 token 上限在推理模型上可能只产出思维链，甚至直接报错 |
| 只有「每系列 11 次」 | 每轮 24 次 + 每会话 300 次 + 每会话 500 万读取 token | 挂机场景需要保险丝 |
| 收益证据把「固定工具目录」与「保活」混在一起 | 我们只承诺机制，收益**由面板上的真实数字说话** | 它家 `docs/EVIDENCE.md:113` 是两项一起改的结果，没有单独验证 |

### 10.2 默认策略（线路族表）

> **线路族按真实请求判定**（2026-10-04 修复 P1-9）：开团挂载时插件拿不到 Lead 的真实路由
> （配置里的 `roles` 只认 12 个角色 id，没有 `lead` 这个键），所以策略先落在兜底族，
> 等抓到**第一个真实模型请求**时按它的 `provider/model` 重算（用户中途切模型也同样跟上）。
> 副作用一条：以前贴在 `generic` 键上的手工覆盖，在真实族被识别后不再命中该线路，
> 需要把覆盖键改写成具体的 `provider`、`provider/model` 或族 id（如 `deepseek`）。

| 线路族 | 默认 | TTL | 理由 |
| --- | --- | --- | --- |
| `deepseek` | **off** | —（磁盘缓存，小时~天） | 等待几分钟根本不会过期；账号/订阅线路还按请求计费 |
| `claude` / `gpt` / `gemini` / `grok` / `glm` / `kimi` / `qwen` | `auto` | 300s | 各家隐式/显式缓存，文档 TTL 最短 5 分钟 |
| 其它未列出线路 | `auto` | 300s | 不猜：先由线路自己证明有缓存命中 |

`auto` 的含义：**先观察到这条线路报过一次 `cacheReadTokens > 0`，才开始 ping**；没有证据就不花钱。
想强制/关掉某条线路，在插件页「缓存保活」段加一条覆盖（键可以是 `provider/model`、`provider` 或族 id）。

### 10.3 什么时候**不**会 ping（都在 `lib/cache.js` 的 `decidePing` 里，可单测）

团队没开 / 模式 off / auto 还没 arm / 有真实请求在途 / 没有队员在跑 / 本轮次数用尽 /
本会话次数用尽 / 本会话读取 token 用尽 / 连续未命中 / 距上次真实请求还没到间隔。
另外：真实请求一来，**在途的 ping 会被立刻中止**（同线路不并发）；ping 的响应只排空，
文本与工具调用永不进会话、永不执行；任何内部错误只记信息，绝不影响模型请求。

### 10.4 怎么验证它真的在工作

1. 插件页「缓存保活」段：当前线路 / 模式与来源 / 间隔 / 是否 arm / 停止原因 /
   `保活 N 次（命中 M，读 X token）` / `本会话真实请求 K 次，缓存命中率 P%`。
2. `~/.dsh/dispatch-agent-team-status.json` 里的 `cache` 字段（重启后复查不用猜）。
3. 判定「值不值」的方法：看**真实请求的缓存命中率**在开保活的会话里是否更高、以及
   `pingTokens`（保活自己读掉的 token，按缓存价计）是否远小于它避免的全价重读。
   面板给的是真实数字，不给「已经帮你省了 X%」这种没有证据的结论。

### 10.5 怎么验证「会话记忆」在工作（2026-10-01 新增）

1. 插件页底部、缓存保活段下面会有一行：
   `会话记忆（宿主重启后自动恢复开团的会话）：N 个会话在案 · 本进程已恢复 M 次`。
   `M > 0` 就说明这次启动真的把某个会话的团队装回来了。
2. `~/.dsh/dispatch-agent-team-status.json` 的 `sessions` 字段（`{file, tracked, version, restoredThisProcess}`）。
3. 记录文件本身：`~/.dsh/dispatch-agent-team-sessions.json`（键是会话 id，值是 `enabledAt/lastSeenAt/source`）。
   手工删掉它 = 所有会话都不再自动恢复团队（下次要用 `/team` 重新开）。
4. 会话里的判据：重启后回到那个会话，工具面里应当**立刻**有 `spawn_teammate` / `wait_agent` / `wake_teammate`，
   且不会出现「移除：spawn_teammate…」那一行。