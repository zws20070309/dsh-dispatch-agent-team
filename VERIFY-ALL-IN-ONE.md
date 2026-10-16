# 智能体团队 × dsh-ops 全方位检测（新对话用，自包含）

## 一、开测前先配好（照这个配，别改）

| 项 | 必须的值 | 为什么 |
|---|---|---|
| 会话权限 | **完全访问**（danger-full-access） | `ops_bash` 与四个 job 工具的发布门要它；不是完全访问就**根本看不到**这些工具 |
| 模式 | **调度模式** + 智能体团队 | 本插件的 preset |
| 角色 `scout`（探索调研） | agent 预设 = **PTC 模式**，**批量调用 = 开** | → **both 档**：原生工具可直调 + 多一个 run_code |
| 角色 `researcher`（外部调研） | agent 预设 = **PTC 模式**，**批量调用 = 关** | → **纯 PTC 档**：送模型只剩 run_code，因而拿到 `ops_batch`/`ops_result` |
| 模型 / 思考强度 | 随意 | 不影响 ops 通路 |

自己核一遍当前配置（别信文档里的快照，配置随时在变）：

```powershell
# 实测可用（PowerShell 原生写法；node -e 那种在 pwsh 下引号会被吃掉，别用）
$j = Get-Content "$HOME\.dsh\dispatch-agent-team.json" -Raw | ConvertFrom-Json
foreach ($k in @("scout","researcher")) {
  $r = $j.roles.$k
  "$k => preset=$($r.preset) batch=$($r.batch) model=$($r.model)"
}
```

（bash / cmd 下用这条等价写法，我实测过：
`node -e "const fs=require('fs'),os=require('os'),p=require('path');const c=JSON.parse(fs.readFileSync(p.join(os.homedir(),'.dsh','dispatch-agent-team.json'),'utf8'));for(const k of ['scout','researcher'])console.log(k,JSON.stringify(c.roles[k]))"`）

应当看到 `scout` 是 `preset:"ptc"`（没有 batch 键 = 批量开着），`researcher` 是 `preset:"ptc"` + `batch:false`：
`researcher: preset=ptc batch=False`、`scout: preset=ptc batch=缺省=开`，其余 10 个角色都是 ptc+关。

## 二、开测前自检（30 秒，先确认代码是最新的）

派完任意一名队员后，在插件目录跑：

```powershell
cd <本插件目录>
node .probe/preset-order-probe.mjs <那名队员的id前缀>
```

必须看到这一行是 **true**，否则说明进程没加载最新代码（要重启），别往下测：

```
ops 指引段与本包当前源码逐字相同 = true（期望 N 字）
```

（那个 N 由探针**现场从本包源码算出来**，不写在文档里 —— 文案一改，文档里的数字就会变成假事实。）

## 三、要贴给 Lead 的提示词（整段复制到新对话）

```
做一次智能体团队与 dsh-ops 插件的全方位通路检测。规则：
（A）派两名队员：scout-qa（角色 scout）和 researcher-qa（角色 researcher）。
（B）每个测试项都把**原始返回**照抄进你的汇总，不要总结成"正常/异常"、不要替我判断对错。
（C）**不要把我下面写的预期转述给队员** —— 它们只该照做和照报，预期由我来判。
（D）涉及 ops_batch 的写盘测试，做完必须清理，且只准删自己创建的那个文件。

=== 测试 1：Lead 自己（不派队员）===
报你工具清单里所有以 ops_ 开头的名字，逐个列出不省略。并回答：有没有 ops_bash？有没有 run_code？有没有 ops_batch 或 ops_result？

=== 测试 2：scout-qa（both 档，可直调）===
让它依次做 2.1–2.9，逐条回报原文：
  2.1 ops_bash({command: "echo QA_BASH; uname -s; pwd"}) —— 报 stdout 原文。
  2.2 ops_grep 在它 cwd 里搜一个真实存在的词（先 ops_glob 看有什么文件），报 matched/total/changed/failed。
  2.3 ops_run_background({command: "sleep 2; echo QA_BG_DONE"}) —— 报返回原文，并说明你从哪一段取的 job id。
  2.4 用 ops_job_output 查那个 job id（参数名 job_id），报 stdout 与退出码原文。
  2.5 ops_job_list({}) 与 ops_job_list({status: "all"}) 各调一次 —— 报两次返回的**原文差异**。
  2.6 找一个它 cwd 里真实存在的小文本文件，对它调 ops_replace({path: <该文件>, pattern: <文件里确实存在的一个短词>, replacement: <随便一个词>, dryRun: true}) —— 报 matched/changed/dryRun，并**再读一次那个文件确认没被改**。
  2.7 报它的工具清单里 ops_ 开头的名字、有没有 run_code。
  2.8 **再在 run_code 程序里**枚举一次：Object.keys(tools).filter(k => k.startsWith("ops_")).sort() 与 Object.keys(tools).length。
      （必须做这一步 —— 3.1 也是用 run_code 内枚举，两边口径要一致才好比。）
  2.9 报它的系统提示词里 ops 指引段的**标题行 + 紧随其后的第一个非空正文行**，共两行，逐字照抄（别改写、别省标题）。
      注意：总数（Object.keys(tools).length）在两名队员之间**不必相同**、也不是判据（per-agent 组件异步注册，
      第三轮实测同一档位两次枚举是 79 与 81）；只比 ops_ 开头那个**集合**的内容。run_code 本身也不会出现在键里（它是外层载体）。

=== 测试 3：researcher-qa（纯 PTC 档，只有 run_code 可直调）===
下面全部放在**一个 run_code 程序里**做，逐步贴原文：
  3.1 先报一个事实：typeof tools.ops_batch 是什么？tools 里 ops_ 开头的键有几个、分别是什么？（Object.keys 枚举）
  3.2 外层直调一次 ops_grep（**故意**在 run_code 外面调）—— 把拒绝原文照抄。
  3.3 用 tools.ops_glob({path: ".", pattern: ["*.json","*.md","*.txt"]}) 找一个真实存在的小文件，取第一个命中。
  3.4 plan：tools.ops_batch({action: "plan", operations: [{op: "copy", path: <3.3 的相对路径>, to: <同目录>/qa-probe<扩展名>}]}) —— 报 status/id/done/total/failed/omitted/complete。
  3.5 resume：tools.ops_batch({action: "resume", id: <3.4 的 id>}) —— 报 status/done/total/failed/unknown/complete。
  3.6 核实落盘：tools.ops_glob 查 <3.4 的 to 文件名> —— 报 matched 与 items。
  3.7 分页：tools.ops_result({action: "page", id: <3.5 的 detailsRef 或 id>, limit: 5}) —— 报**顶层键名列表**、total、complete、items 长度，以及每项的 state。
  3.8 清理：plan 一个 remove（path 只填 3.4 那个文件名）→ resume 它 → 再 ops_glob 确认 matched=0。报每步 status。
  3.9 报它的系统提示词里 ops 指引段的**标题行 + 紧随其后的第一个非空正文行**，共两行，逐字照抄。

=== 测试 4：交叉核对（不要转述给队员，由你比对）===
  4.1 把 **2.8 与 3.1** 两份「run_code 程序内 Object.keys(tools) 枚举出的 ops_*」放在一起比：谁多谁少、差的是哪几个。
      （口径必须一致：2.7 是「送给模型的清单」、3.1 是「程序内可用的清单」，这两个面本来就不同 —— **不要**拿 2.7 去比 3.1。）
  4.2 把 **2.9 与 3.9** 两份「标题行 + 第一个非空正文行」放在一起比：**是否逐字相同**？（应当完全一样 —— 两名队员档位不同但共用同一段提示词前缀）
  4.3 明确回答：researcher-qa 在**第一次回报里**就成功调用了 ops_batch 吗？还是它先说"没有"、到第二轮才行？

=== 测试 5：一条预言（请如实报，不要为了顺着我而改写）===
让 scout-qa 直调一次 subagent 工具（prompt 写"只回复两个字：好"），把**完整返回或报错原文**照抄，一个字别改，失败不要重试。
我的预期：它会**失败**，报错形如 subagent depth 2 exceeds maxDepth 1。如果它**成功**派出了子代理，请明确写「预言被推翻」。

=== 最后交付 ===
给我一张表：| 测试项 | 谁 | 原始结果关键字段 | 一句话事实 |
四列都要填，失败的项也要填、不要省略。然后单独回答 4.1 / 4.2 / 4.3 / 测试5 的结论。
再单独报：两名队员各自是什么**呈现档**。你（Lead）看不到队员的工具清单，所以只能**从它们回报的原文推**：
scout-qa 若 2.1 直调成功 = 原生工具可直调；researcher-qa 若 3.2 被拒且拒绝理由写着 only run_code is callable directly = 纯 PTC 档。
把依据的原文一起报，不要凭空断言。
```

---

## 四、判读表（你拿 Lead 的表对着看）

| 项 | 预期 | 若不符说明什么 |
|---|---|---|
| 1 Lead | 有 file 四件套 + `ops_bash` + 四个 job 工具；**没有** `run_code`、没有 `ops_batch`/`ops_result` | 没有 `ops_bash` → 会话不是完全访问，或 profile 的 shell 行缺 `bashPath`（跑 `node tools/ops-enable.cjs --check`） |
| 2.1–2.9 scout | 2.1–2.6 全部成功（2.6 的 `changed=0`、文件未被改）；2.7/2.8/2.9 是如实回报 | 2.5 两次返回**应当不同**：默认只列运行中的，`status:"all"` 才看得见刚结束的那个（ops 的设计，不是 bug） |
| 4.1（2.8 vs 3.1 的 ops_* 集合差） | 差集**恰好**是 `{ops_batch, ops_result}`，且 scout 无独有项（第三轮实测：9 个是 11 个的真子集） | scout 也有这两个 = ops 的 PTC 门变了（发我版本号）；researcher 缺这两个 = 门没放行（查插件页 ptc 组件 + `ops-enable --check`） |
| 3.1 researcher | `typeof tools.ops_batch === "function"`，ops_* **11 个**（含 batch/result） | 只有 9 个（缺 batch/result）→ PTC 组件没放行，看 `ops-enable --check` 与插件页 ptc 组件是否启用 |
| 3.2 | 被拒：`unknown tool "ops_grep": only run_code is callable directly` | 竟然成功 → 它不是纯 PTC 档（批量调用开关没关，或这是旧队员） |
| 3.4–3.6 | `planned` → `completed` `done=1/1 failed=0` → glob `matched=1` | `NOT_FOUND` = 参数问题（源文件不存在，或 `to` 的父目录不存在 —— plan **不建目录**），不是通路问题 |
| 3.7 | 顶层键 `complete/id/items/nextOffset/omitted/total/sandbox`，**没有 `status`** | 有 status → ops 版本变了 |
| 3.8 | remove 后 `matched=0` | 删不掉 → 把两步 status 原文发我 |
| 4.2 | 两名队员报的「标题行 + 第一个非空正文行」**逐字相同**，且标题行是 `# ops 工具（检测到 dsh-ops 插件，已接入本团队）` | 两人**取行口径**不同（一个省了标题、把 `- ` 前缀抄丢）= 转述问题，不是提示词问题：判 4.2 以**日志字节**为准（`node .probe/preset-order-probe.mjs <id>` 那行，或 Lead 自己从两份 system/message 切片算 sha）。真不同 = 指引段按角色分叉，会切碎提示词缓存前缀，是缺陷 |
| 4.3 | **第一次回报就成功** | 第一轮说"没有"、第二轮才行 = 呈现档没在第一次装配钉住，是 P0，发我 |
| 5 | 失败：`subagent depth 2 exceeds maxDepth 1` | 成功派出子代理 = 我错了（maxDepth 生效值不是 1），发我原文 |

## 五、三条已知无害现象（别当 bug 报）

1. `ops_result({action:"release"})` 会被拒（`POLICY_DENIED: Job audit records cannot be released by this tool`）—— 这是 ops 的设计，写在它自己的描述里（装机 `lib/ptc/contract.js:38`：Job audits are read-only）。
2. `ops_batch` 会在插件根目录生成 `.dsh-ops/` 审计存根（分片是同一 job 的状态历史，mtime 递增）。已进 `.gitignore`，是正常产物。
3. 插件页关掉再打开某组件只重写 `disabled` 那一键，我们配的 `configUpdateVersion`/`bashPath`/`extraGuidance` 会留着。

## 六、我这边的状态（全部给可复现命令，别信我写的时刻）

- 指引段文案又改了一次（把「(Background:) 开头常另起一行 / 本轮实测 5 次皆有」这句**被证伪的话**换成出现条件）→ **必须重启 DSH**，新对话才拿得到；判据用上面那条 `逐字相同 = true`，别信我这句陈述。
- 启用态自查：`node tools/ops-enable.cjs --check`（应报已启用且配置齐备）。
- **profile 有没有被 ops 迁移改写**：`git diff --stat cordis.patch.yml` 之类看不到的话，比对该文件的 mtime 与你上次
  动它的时间；被改写说明 ops 的 updatedConfig 迁移跑了（那条 P1 陷阱）。
- 闸门计数会随功能变，别把数字当判据；跑就行：`node tools/selftest.cjs`、`node tools/drift-check.cjs`、
  `node tools/integration-test.cjs`、`node tools/client-smoke-test.cjs`、`node tools/ops-mount-check.mjs`。
- 状态文件 `opsIntegration`：四组件全 `phase:2`、`missingPtcTools: false`、summary 已带「根作用域只覆盖全局层」的说明。
- 五套闸门全绿：selftest 115/115、drift 98/98、integration 204/204、smoke 67/67、mount-check A/B/C/D。

## 七、第五轮（session-00001005）实测结论：全绿，但抓出四个我插件侧的问题

测试本身全部符合预期（Lead 还自己写脚本回日志算了 sha）。
真正有价值的是它顺带暴露的四件事，**都已修**（本条之后）：

1. **P1 假文案**：指引段说 `ops_run_background` 返回「开头常另起一行 (Background:)，本轮实测 5 次皆有」。
   scout-qa 照抄原文时如实报了**没有这一行**。我做对照实验：单任务 →
   `(Complete: job j-xxxxxx started; …)` 一行；同会话再起第二个（前一个还在跑）才出现
   `(Background: j-xxxxxx running 0s.)\n(Complete: …)`。所以那句是**无条件断言，错了**；
   「5 次皆有」是我从别的轮次搬来的观测，搬来时没在本轮复核。
2. **P1 list_agents 报错误数据**：两名队员的行都写 `model: model-a`（= Lead 的模型），
   而它们的 `request/header.header.config` 与 `request/context` 全是 `provider-b/model-b`。
   根因是官方 `listMembers` 取 `live?.options.model ?? root.options.model`
   （dsh-experimental-agent-team/lib/index.js:698、:449）—— `options.model` 是**继承**来的那份，
   而本包的角色路由覆盖发生在 `agent/request` 拦截器里，**不回写** options.model。
   修法：runtime 记「真的合进请求对象的那份路由」（唯一写入点 noteAppliedRoute，
   覆盖失败退回原配置的那一支**不记**），list_agents 用 annotateMemberModels 只改写
   **已有的** model 字段（不新增字段 = 不动 Lead 的工具目录 = 不动缓存前缀），
   并断言校正后的行仍过官方返回值校验器。前端画布不受影响（lib/graph.js 的 model
   本来就优先取 request/context 的真值）。
   **生效时机（别当成没修好）**：账本落在 `agent/request` 拦截器里（lib/runtime.js 的
   installRouteOverride），也就是**这名队员真的发出第一个请求**之后才有；annotateMemberModels
   查不到条目时按纪律**不动那一行**。所以刚 spawn、还没开跑的那一瞬间，list_agents 仍显示
   继承来的模型 = 「还没有数据」，不是修复失效。派出去「本该用什么模型」看 spawn_teammate
   返回值里的 `route`（那个在 spawn 当时就给出）。
   本轮有现成铁证（session-00001005 seq23/seq80，原文照抄）：同一条 spawn_teammate 返回里
   `member.model = "model-a"` 与 `route.model = "model-b"` **并存** —— 一个是继承来的，
   一个是真要用的。所以 Lead 拿 route 判、别拿 member.model 判。
   
   **这条修复要重启 DSH 才在真机生效**（改的是 lib/*.js，进程加载的是启动时那份）。
   本轮那两名队员跑的是修复前的代码，所以它们的 list_agents 仍是 model-a —— 那是预期，
   不是没修好。重启后派**新**队员、让它先跑出一两步，再 list_agents 看 model 是否变成
   角色配置里的那个。
3. **P2 探针假陈述**：`MCP 工具 = (无：这个进程里 MCP 服务器的工具没注册进来)`。纯 PTC 档的
   wire 被裁成一个 run_code（宿主 dsh-tools/lib/index.js:2840-2843），MCP 工具同样不进 wire ——
   同一进程里 both 档队员在 run_code 程序内枚举到 **37 个** `mcp__matlab__*`。探针改成
   「仅指这份日志的 wire 清单」，纯 PTC 档明说这不等于没注册。
4. **P2 文档口径歧义**：「报前两行原文」没定义（标题与正文之间有一个空行），本轮两人取的行
   就不一样（researcher 报 1+2 行、scout 报 2+3 行且抄丢了 `- ` 前缀）。已改成
   「标题行 + 紧随其后的第一个非空正文行」，并在判读表里写明：口径不同 = 转述问题，
   判 4.2 以日志字节为准。

另外两条**观察**（未改，也不该改）：

- scout-qa 连调三次 `report_result` 才成功：第一次 `"evidence" must be an array`（宿主参数层）、
  第二次「completed 必须至少给一条 evidence」。这是校验按设计工作、模型自己纠正 —— 不是缺陷。
- `ops_batch` 在 `status=completed / phase=settled` 时 `complete` 仍为 `false`：它的语义是
  「这一份**响应**带没带全条目明细」，不是任务成功与否（详见前几轮记录）。
