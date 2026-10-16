# 智能体团队 × dsh-ops 真机验证清单

**用法**：按第 0 步设好开关 → 重启 DSH → 开一个调度模式的智能体团队会话 → 把「要贴的提示词」整段贴给 Lead。
它会跑完 4 件事并把结果写成表格。你只要看那张表，把与预期不符的地方原样发我。

## 你这次测试（session-00001006）暴露并已修的两个问题

| # | 现象（实测） | 根因 | 修法 |
|---|---|---|---|
| P0-1 | **三名 agent 都没有 `ops_bash`**：Lead 状态文件 `visibleTools` 只有 file 四件套；两名队员 wire 里 `ops_*` 各 8 个、无 `ops_bash` | profile 的 `dsh-ops-shell` 行缺 `bashPath`，而它 `allowSystemShellFallback: false`，本机又没装 `@dsh-ops/bash-win32-x64` → ops 的 `resolveShells` 返回 `bash.available=false / source=disabled` → 按 `lib/shells.js:1213` 直接不发布。**而我的离线验收 D 段自己手写了一份带 `bashPath` 的配置**，比生产多一个键 → 照样打 ✓ = 假绿灯 | ① `ops-enable` 给 shell 行也写 `bashPath`（`bashPath` 在共享白名单 `lib/config.js:151,196`，任何行都接受；fallback 保持 false，pwsh 仍用随包 PS7，实测不变）；② **D 段改成从 `ROWS` 解析配置**，生产写什么这里就挂什么；③ 变异 M20 验证：把 shell 行的 `bashPath` 拿掉 → D 立刻变红 |
| P0-2 | **researcher-ops 逐请求呈现档翻转**：`native(76) → ptc(1) → native(76) → ptc(1)`。它因此第一轮看到 76 个工具、没有 `run_code`、没有 `ops_batch`，就把「通路没通」当事实报给 Lead，第二轮才自我更正（Lead 还专门追问了它数字对不上） | 「预设 ptc + 关批量」这一支旧实现**什么都不做**，等异步的预设重绑把档带过来；但官方在 `agent/created` 之后没有可 await 的装配前钩子，第一次装配于是用了继承来的 native 组合。对照：scout-ops（本包**同步**声明 both）是 `both(77) → both(79)` 稳定 —— 差别就在自己那层有没有钉住 | `applyMemberBatch` 关批量那一支：预设是 `ptc` 时**同步** `presentAs('ptc')`（新 `declareMemberMode`，与 both 支对称、同样先探 `ptcRuntime`）。集成测试新增 4 条断言（含**故意不 await** 只判同步那一刻），变异 M21/M22 验证都会咬；探针判据也换了（见下） |

**探针的判据本身是错的，也修了**：旧版只看「`selected` 的 seq 早于第一条请求的 seq」就宣布「无竞态」。
researcher-ops 恰好是 `selected seq7 < 首请求 seq13` —— 旧判据打 OK，可它第一次请求确实是旧组合。
现在改成**逐请求算呈现档**、比较第一次与最后一次（工具数在请求之间增减是正常的，只比档不比数量）。
对同一份真机日志，新判据如实报出 `✗ 呈现档晚到：第一次请求是 native(76)，稳态是 ptc`。

---

> 上一次重启加载的五个提交（`09708df`/`f217184`/`bab0256`/`222eea5`/`240f1c2`）：
> ① profile 退回链漏 `.dsh` —— 修之前**每个队员都收不到 ops 指引段**（状态文件 `package: null` 而四个
> 组件行都挂着，就是这么暴露的）；② `ops_batch` 缺席告警凭可见性误报 Lead / 批量档队员。

## 第 0 步：角色配置（**你截图里那套就是对的，不用改**）

| 角色 | agent 预设 | 批量调用 | 得到什么档 |
|---|---|---|---|
| researcher（外部调研） | PTC 模式 | **关** | **纯 PTC 档** —— 送模型只剩 `run_code`；ops 的 PTC 组件因此把 `ops_batch`/`ops_result` 注册给他（在 run_code 程序里可调） |
| scout（探索调研） | PTC 模式 | **开** | **both 批量档** —— 原生工具全部直调 + 多一个 `run_code`；按 ops 原版设计**拿不到** `ops_batch`/`ops_result` |

一名纯 PTC、一名批量档，正好一条通路两种档同时验 —— 这是最理想的对照，比我原先设想的「scout 用 standard」更好
（我第一版清单里那句「把 researcher 的批量调用关掉」是多余的：你早就关了；那句「scout 保持 standard」
也与你的实际配置不符，已按截图订正）。

注意语义：**只对新派出的队员生效**，已在跑的队员不会换档。

---

## 要贴的提示词（整段复制给 Lead）

```
我们在验证「智能体团队插件原生链接 dsh-ops 插件」这条通路。做 4 件事，每件都把实测值原样报出来，不要总结成"正常/异常"：

1. 报你自己的工具清单里所有以 ops_ 开头的名字（逐个列，不要省略）。
2. 派队员 scout-ops，让它用 ops_grep 在本工作区找一个真实存在的东西并回报结果。然后报：它工具清单里以 ops_ 开头的名字；以及它的系统提示词里有没有一段标题是「# ops 工具（检测到 dsh-ops 插件，已接入本团队）」的文字（有/没有，并把该段前两行原文贴出来）。
3. 派队员 researcher-ops（这个角色是 PTC 模式 + 批量调用关 = 纯 PTC 档：送给模型的工具只有 run_code 一个 —— 所以**这一步不许用"工具清单里有没有 ops_"来判断**，那永远是空，属于判据用错）。让它按下面两步做，参数要**它自己定位**、不要照抄我给的示例路径：
   (a) 先用 ops_glob 在它自己的 cwd 里找一个**确实存在**的文件（例如 pattern "*.json" 或 "*.md"，取第一个命中）。
   (b) 再在 run_code 程序里执行下面这条，把 path 换成 (a) 找到的那个相对路径、to 换成**同一个目录**下的一个新文件名：
      const r = await tools.ops_batch({ action: "plan", operations: [{ op: "copy", path: "<(a) 的真实相对路径>", to: "<同目录>/<随便一个新名字>.probe" }] })
   然后把返回里的 id、status、done、total、failed 原样报回来（plan 是**无副作用预检**，不落盘、不建目录，不是真复制）。同时让它报：它的系统提示词里那段「# ops 工具（检测到 dsh-ops 插件，已接入本团队）」在不在。
   为什么必须自己定位（上一轮踩过的两个坑）：实测 plan 会预检**源文件存在**、且**不会为目标创建父目录**，
   所以 path 指向不存在的文件、或 to 指向不存在的目录，都会返回 status:"error" + NOT_FOUND ——
   那是**参数问题**，不是通路没通。判成功的唯一标准是 status:"planned" 且有 id。
   （"不建父目录"这条来自上一轮 researcher-ops 的对照实验：源文件相同、只换 to 的目录，
   不存在的目录报 NOT_FOUND、存在的目录返回 planned。它是**实测推断**，我没有读它的实现。）
4. 若第 3 步里 tools.ops_batch 调用失败（报 unknown tool 或压根不在清单里），**不要改任何插件源码**，只把报错原文和你的观察报回来。

最后给我一张表：
| 谁 | 可见 ops_* | ops 指引段在不在 | run_code 在不在 | ops_batch 实调结果 |
并单独说明 researcher-ops 送给模型的工具面到底有几个、名字是什么。
```

---

## 判读表（这是关键，档位不同判据就不同）

| 谁 | 应该看到 | 为什么 |
|---|---|---|
| **Lead**（原生档） | `ops_grep`/`ops_glob`/`ops_inspect_local_file`/`ops_replace`（file 四件套，全局层）+ `ops_bash`；会话是完全访问时还有四个 `ops_run_background`/`ops_job_*`。**没有** `ops_batch`/`ops_result` | file 组件注册在全局层，人人可见；ops 的 PTC 门只放行「组合恰好只有一个 run_code」的作用域（装机包 `lib/ptc/index.js:20`），Lead 是原生档 → 按设计拿不到。**这不是缺陷** |
| **scout-ops**（PTC 模式 + 批量**开** = both 档） | 与 Lead 同一批 ops_*（file 四件套、job 四件套、`ops_bash`），清单里有 `run_code`；**没有** `ops_batch`/`ops_result`；**有** ops 指引段；**逐请求呈现档应始终是 both**（`both→both`，不翻转） | 本包在队员自己那层同步声明 both。both 的组合工具数 >1 → 被 ops 的 PTC 门挡在外面（离线实测同一份原版组件：ptc 档拿到 / both 档拿到空） |
| **researcher-ops**（PTC 模式 + 批量**关** = 纯 PTC 档） | 送给模型的清单**只有 `run_code`**，所以在清单里找 `ops_batch` 一定找不到；但第 3 步那次 `await tools.ops_batch(...)` **必须调用成功**（报回 id 与 status）；**逐请求呈现档应始终是 ptc**（`ptc→ptc`，不再 `native→ptc→native→ptc` 翻转） | 纯 PTC 档把送模型的 schema 裁成一个 run_code（宿主 `dsh-tools/lib/index.js:2840-2843`），而 ops 的 PTC 组件把两个工具注册进这名队员**自己的层**、在 run_code 程序里可调。**判据是"能不能调用"，不是"清单里有没有"** |

**一句话判交付**：researcher-ops 那一次 `ops_batch` 报回 id + status ⇒ 四个组件的工具全部适配完成。

---

## 状态文件硬指标（重启后跑一次，PowerShell）

```powershell
$s = Get-Content "$env:USERPROFILE\.dsh\dispatch-agent-team-status.json" -Raw | ConvertFrom-Json
$s.opsIntegration | ConvertTo-Json -Depth 5
```

（`opsIntegration` 是团队会话落定时重拍的，所以重启后**要先派过一次队员/跑完一轮**这里才是新的。）

> 本机实测参考：状态文件 = `~/.dsh/dispatch-agent-team-status.json`；插件目录 = 你 clone/安装的位置。

| 字段 | 应该是 | 说明 |
|---|---|---|
| `package` | `{"installed":true,"version":"0.3.0",...}` | 修之前这里是 `null`（漏 `.dsh` 那个 P1），现在必须解析得到 |
| `rows` | 4 条，全部 `disabled:false`、`phase:2` | 四组件真挂载 |
| `mounted` | `["shell","file","background","ptc"]` | |
| `visibleTools` | 含 file 四件套（尽量含 `ops_bash`/job 四件套） | 这是 **Lead 作用域**的视图 |
| `missingPtcTools` | **false 或不存在** | 修之前它是 `true`（对 Lead 误报）；现在这个告警只对纯 PTC 档作用域才允许出现 |
| `summary` | 不该出现「需要处理」/缺席提示 | 同上 |

---

## 异常怎么办

| 现象 | 结论 |
|---|---|
| `package: null` 但四行 `phase:2` | `.dsh` 退回链又漂了 —— 直接发我，P1 |
| 队员连 file 四件套都没有 | 跑 `node tools/ops-enable.cjs --check`；插件页确认四行真启用 + 确实重启过 |
| 有 file 四件套但没有 job 四件套 | 会话不是「完全访问」（ops 的发布门要它，`lib/tools.js:311-316`）。切完全访问后派**新**队员 |
| **所有**队员都没有那段 ops 指引文字 | 链接没通。把状态文件的 `opsIntegration` 输出 + 一名队员的可见 ops_* 清单发我 |
| researcher-ops 清单里有 `run_code` 且工具数 >1 | 批量调用开关还没关（或这是关之前派的老队员）。关掉→保存→**重新派**一名 |
| researcher-ops 只有 run_code，但 `ops_batch` 返回 `NOT_FOUND` | **参数问题**（源文件不存在，或 `to` 的父目录不存在 —— plan 不建目录），不是通路问题。让它按第 3 步 (a) 先用 ops_glob 定位真实文件再试 |
| researcher-ops 只有 run_code，但 `ops_batch` 报 `unknown tool` / `POLICY_DENIED` | ops 的 PTC 门没放行（组件未启用 / 版本变了）。发我报错原文与它的 dsh-ops 版本号，**不要改 ops 源码** |
| Lead 的清单里出现 `ops_batch`/`ops_result` | 与我给的事实相反 —— 发我，我重查 |

---

## 不想实调时的替代验证（不用重启 DSH）

```powershell
cd <本插件目录>   # 例：git clone 出来的 dsh-dispatch-agent-team
node tools/ops-mount-check.mjs
```

它挂真 dsh-ops 组件 + 真宿主注册表跑 A/B/C/D 四段（组件一行都不改，是装机那份原版）。2026-10-16 12:26 最后一次实测：
`总体：通过（A 交付态，B 负对照成立，C 后台任务实测，D shell 实测）`

| 段 | 实测到什么 |
|---|---|
| A | 纯 PTC 档队员的**可见层**有 `ops_batch`+`ops_result`；并**真调一次** `ops_batch(action=plan)` → `id=j-3d5a8663… / failed=0 / logicalBytes=2163`。事后核对目标文件**没被创建**、worker 写的审计存根里 `state:"pending"` ⇒ plan 确属无副作用 |
| B | 同一份原版组件，只差呈现档：ptc 档拿到两个、both 档拿到空 ⇒ 因果就在本包能配的「预设 ptc + 关批量调用」上 |
| C | 真起 FastCtx 服务器 + **真调一次** `ops_run_background`（发布 ≠ 可用，bashPath 指到 Git bash） |
| D | `ops_bash` 已发布，且 ops 原文「Prefer bash…」与本包的口径覆盖文字同时进段 |

### 两个已知无害现象（别当 bug）

1. 那次 plan 会在插件根目录生成 `.dsh-ops/`（dsh-ops 原生 worker 自己的 job manifest 存根，
   `state:"pending"`、不落业务数据）—— 已进 `.gitignore`，是正常的审计产物。
2. 插件页关掉再打开某个组件只重写 `disabled` 那一键，我们配的 `configUpdateVersion` / `bashPath` /
   `extraGuidance` 会留着（模拟过官方 `writePluginEnabled` 的往返）。
3. profile 目录里那几个 `.bak-*-pre-ops-enable` 是改 profile 前的备份，要不要清由你决定。

另有 `.probe/preset-order-probe.mjs <队员id前缀>` 直读那名队员的日志。它对**纯 PTC 档会明确打印「这份日志判不了」**（wire 被裁成一个 run_code，见上），这是本轮刚修的一个误判点：以前它会谎报「ops 工具 = (无)」。