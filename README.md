# 调度模式智能体团队

一个 DSH 桌面端插件 + 一个 agent preset。它把官方实验性的 Agent Teams 改造成一套
**「先把需求问清楚，再动手」**的团队工作方式。

- **调度模式（dispatch-mode）preset**：Lead 先分轮把需求问清楚再落地 —— 每轮把问题一次列完、
  每题给出推荐答案、等用户答复；没有静默假设、用户确认共享理解之前不动手。「找事实」由 Lead
  自己查或派队员查，不问用户。
- **12 个队员角色**（按工作流阶段排列，按需叫、不必叫满）：外部调研、探索调研、前沿审查、计划审查、
  执行落地、集成落地、复现回归、逻辑审查、对抗审查、美术审查、反思优化、文档术语。
- **模型配置**：插件详情页可以**一次性给全部角色选同一个模型**（省得逐行点），也可以逐角色单独指定模型与思考强度；不用编辑 YAML，默认全部「跟随 Lead」。
- **队员的能力面自动收窄**：自动摘掉目标工具与子代理工具，只保留它本职需要的团队工具。
- **结构化汇报**：队员做完必须调 `report_result`（状态 / 证据 / 验收 / 未决项），
  插件会把它投递给 Lead —— 「没有结构化报告就当没完成」不再只是一句纪律。
- **`/team` 开启团队**，默认关闭（团队会真的多花模型预算）。开关按会话记忆，
  宿主重启后会自动把开过团的会话装回来。
- **缓存友好**：所有队员共用同一份系统提示词（逐字相同），角色差异只走 Lead 派活时写的那段提示词，
  队员之间因此能共用同一份提示词与工具目录前缀。

## 要求

| 项 | 要求 |
|---|---|
| DSH 桌面端 | 0.2.0-rc.2 或更新（更早的版本请先跑 `node tools/drift-check.cjs` 看兼容性） |
| Node.js | ≥ 18 |
| 官方 bundle | 需在插件页启用 `@deepseek-ai/dsh-experimental-agent-team-profile`（本插件复用它不可替代的持久化域服务；工具面与界面由本插件接管） |

## 安装

**先完全退出 DSH 桌面端**（官方要求 desktop profile 的操作在它退出后进行），然后在本目录执行：

```bash
node tools/install.cjs
```

然后重启桌面端 → 新建会话 → 推理模式选「**调度模式**」→ 输入 `/team`。

- 只想看这条命令会做什么、不改任何东西：`node tools/install.cjs --dry-run`
- **界面安装**（等价路径）：插件 → 已安装 → 添加插件 → 填本目录的**绝对路径**，
  然后再跑一次 `node tools/repair.cjs --apply`。

> 为什么装完还要补跑一次 `repair.cjs --apply`：官方安装器不负责两件必需品 ——
> 包内指向 `~/.dsh/profiles/node_modules` 的依赖 junction（缺了插件行在**加载期**就起不来），
> 以及 profile 层的 `agent-team` 容量覆盖（缺了有效容量退回官方默认 8，8 次派活之后团队就派不出人）。
> `install.cjs` 会自动串跑它；走界面安装时才需要手动补一次。

> 注意：安装会把 profile 指向**你运行 `install.cjs` 的那个目录**。如果你另外留着一份副本，
> 那份就是死代码 —— 改它不会生效。用 `node tools/repair.cjs` 可以确认 profile 实际链接到哪一份。

### 装完后哪里找

- **插件 → 已安装 → 调度模式智能体团队**：配置页（每个角色的模型 / 思考强度）。
- **推理模式选择器**：多出「调度模式」。
  本插件**不**改新会话的默认 preset（安全选择：preset 配错会让新建会话直接失败），
  要用调度模式请手选一次；已开始过的会话不能切换 preset，需要新建会话。

### 改代码后的生效方式

| 改动 | 生效方式 |
|---|---|
| `lib/*.js`（宿主半） | **重启 DSH** |
| `lib/client.js`（浏览器半） | 刷新页面即可 |
| `presets/*.patch.yml`、`cordis.patch.yml` | 重新加载插件后生效 |

如果源码目录与桌面端实际加载的那份是两个目录，改完要同步一次：
`node tools/sync-to-dsh.cjs`（`--dry-run` 只看差异）。

## 使用

### 开启与关闭团队

这些入口**只在「调度模式」的会话里**出现（别的 preset 看不到、也开不了本插件的团队）。

| 操作 | 怎么做 |
|---|---|
| 开启 | 输入 `/team`（推荐，`/` 菜单里能搜到），或直接说「组队」「开团队」让 Lead 自己开 |
| 关闭 | 直接说「关掉团队」「解散团队」，Lead 会调 `disable_agent_team` |

- **没有 `/team-off`**：团队开关只有一个斜杠命令 `/team` 与两个模型工具，不需要记第二个命令。
- 命令执行后命令行只显示 `>_ team`，**不会**再追加一段横幅；紧跟其后的用户气泡就是你打的那一行。
- **不要用 `/智能体团队` 这类自造斜杠命令**：命令名在宿主侧只允许 ASCII，未注册的 `/xxx`
  会被客户端命令面板吞掉 —— 既不报错也不发给模型，也就是什么都不会发生。
- 团队开关**按会话记忆**：`/team` 成功后这个会话会被记下来，宿主重启或重开该会话时自动把团队装回来，
  你不用再打一次 `/team`。说「关掉团队」会立刻删掉这条记录。

### 配置队员的模型与思考强度

插件 → 已安装 → 调度模式智能体团队 → 详情页。

页面顶部有一个**统一选择队员模型**：选一次就把下面**所有**角色的模型都改成这一个；
只想给某个角色特殊待遇时，再单独改它那一行。角色逐行的控件是「模型 + 思考强度」。

- 默认每行都是**跟随 Lead**：不配置 = 不加任何覆盖，队员跟着 Lead 当前的选择走。
- 统一选择时，思考强度会按新模型重算：仍然支持的档位保留，不支持的退回「模型默认」。
- 改完**立即生效**：已经在跑的队员也在下一次请求就用上新路由，不需要重启。
- 唯一的例外是 `spawn_teammate` 的显式参数（`provider`/`model`/`reasoning_effort`）——
  那是「这一次派活」的命令，会钉在该队员身上。
- 配置文件在 `~/.dsh/dispatch-agent-team.json`。

### 典型的协作节奏

1. 你说需求（可以很模糊）。
2. Lead 派 1–3 个 `scout`（查本仓库）或 `researcher`（查仓库之外）去查事实。
3. Lead 把不依赖这些事实的问题**一次性**列成一轮，等你答复；答复改变设计树后重算下一轮。
4. 前沿快空时派 `frontier-auditor` 复核有没有被跳过的分支，直到你确认共享理解。
5. Lead 切写域、在任务板上建任务、派 `builder` 落地；多写域时派 `integrator` 接线。
6. 声称完成后派 `verify` 走真实链路验证，高风险改动加 `red-team` 主动证伪。
7. Lead 自己复核关键结论后给你最终答案。

### Lead 能用的工具

| 工具 | 作用 |
|---|---|
| `spawn_teammate` | 创建一个具名队员（带角色；可选覆盖模型 / 思考强度） |
| `send_message` / `broadcast_message` | 给一个 / 多个队员发消息 |
| `list_agents` / `wait_agent` / `interrupt_agent` | 看成员状态、等变化、打断某个队员 |
| `team_task_create` / `team_task_list` / `team_task_get` / `team_task_update` | 共享任务板（含写域与依赖） |
| `wake_teammate` | 队员被输出上限截断、没交报告时叫它**从断点续写**（不用你手动打「继续」） |

队员看到的是另一份子集：没有 `spawn_teammate` / `interrupt_agent`（只有 Lead 能创建或打断），
多一个 `report_result`（交付报告）与 `ask_lead`（中途向 Lead 提问），也没有目标与子代理工具。

## 卸载

```bash
node tools/install.cjs --uninstall          # 推荐：走官方 CLI（先退出桌面端）
```

- 界面卸载：插件 → 已安装 → 调度模式智能体团队 → 卸载。
- 卸载后把推理模式选择器里的默认 preset 换回你原来的那个。
- 界面卸载或应急摘除**不会**自动回收 profile 层那段托管块（`tool-agent-team: disabled` +
  `agent-team` 容量覆盖），需要自己补一次：`node tools/repair.cjs --revert`（幂等）。
- 角色配置与会话记忆文件会留在 `~/.dsh/` 下，可以手动删。
- DSH 起不来时的应急路径：`node tools/emergency-disable.cjs`（把本插件从 bundles 里摘掉）。

## 维护

改完代码、以及每次官方升级 DSH 之后，建议跑一遍（全部只读）：

```bash
node tools/selftest.cjs           # 纯逻辑回归（零 dsh 依赖）
node tools/drift-check.cjs        # 官方实现假设校验（升级后必跑）
node tools/integration-test.cjs   # 真链路集成测试
node tools/client-smoke-test.cjs  # 浏览器半渲染冒烟
node tools/repair.cjs             # 安装状态体检（bundles / junction / 文件齐全）
```

注意：除 `client-smoke-test` 外，其余脚本都需要先有安装期那个依赖 junction
（也就是跑过 `repair.cjs --apply`），否则会报 `ERR_MODULE_NOT_FOUND` —— 那是「还没装好」，不是插件坏了。

还有两个只读探针，排查问题时很有用：

```bash
node tools/session-probe.cjs --tools --session <会话子串>          # 会话里团队工具面的真实增删
node tools/asar-probe.cjs --grep "<字符串>" --list "dsh-llm/lib"   # 官方安装包里到底有没有这个东西
```

## 开发者文档

实现契约、精确的 API 签名与官方行为实测记录（`agent/request` waterfall 形状、`ctx.webServer.register`、
`plugins.bundle.config` 槽位契约、以及一份逐条标注「原文哪里错了」的勘误表）都在
[`INTERFACES.md`](./INTERFACES.md)。**改这个插件之前先读它。**

设计取舍与历史事故（为什么这样切缓存、为什么必须关掉官方同名工具行、
两道容量帽分别是什么、历次故障的根因与修法）不在本文件里 —— 那些属于维护者笔记，
按本仓库约定不进版本库（见 `.gitignore`）。README 只讲怎么用。

## 许可

MIT
