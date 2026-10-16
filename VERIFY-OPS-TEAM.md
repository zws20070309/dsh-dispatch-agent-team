# 智能体团队 × dsh-ops 真机验证清单

**用法**：按第 0 步设好开关 → 重启 DSH → 开一个调度模式的智能体团队会话 → 把「要贴的提示词」整段贴给 Lead。
它会跑完 4 件事并把结果写成表格。你只要看那张表，把与预期不符的地方原样发我。

> 本次重启加载的包含刚修的五个提交（`09708df`/`f217184`/`bab0256`/`222eea5`/`240f1c2`）：
> ① profile 退回链漏 `.dsh` —— 修之前**每个队员都收不到 ops 指引段**（状态文件 `package: null` 而四个
> 组件行都挂着，就是这么暴露的）；② `ops_batch` 缺席告警凭可见性误报 Lead / 批量档队员。

---

## 第 0 步：先设好一个「纯 PTC 档」的角色（不这么做，PTC 增强那条腿验不了）

插件页 → 智能体团队 → 角色 **researcher**：
- 预设 = `ptc`（你机器上已经是了）
- **「批量调用」开关关掉**（你机器上现在还是默认开着 —— 这就是 PTC 腿验不通的唯一原因）

保留对照角色：**scout** 预设 `standard`、批量调用**开着**（默认）。两个角色一起验，正好一条通路两种档。
改完保存 —— 注意**只对新派出的队员生效**，已在跑的队员不会换档。

---

## 要贴的提示词（整段复制给 Lead）

```
我们在验证「智能体团队插件原生链接 dsh-ops 插件」这条通路。做 4 件事，每件都把实测值原样报出来，不要总结成"正常/异常"：

1. 报你自己的工具清单里所有以 ops_ 开头的名字（逐个列，不要省略）。
2. 派队员 scout-ops，让它用 ops_grep 在本工作区找一个真实存在的东西并回报结果。然后报：它工具清单里以 ops_ 开头的名字；以及它的系统提示词里有没有一段标题是「# ops 工具（检测到 dsh-ops 插件，已接入本团队）」的文字（有/没有，并把该段前两行原文贴出来）。
3. 派队员 researcher-ops（这个角色我已把预设设为 ptc 并关掉批量调用，所以它是纯 PTC 档：送给模型的工具只有 run_code 一个 —— 所以**这一步不许用"工具清单里有没有 ops_"来判断**，那样永远是空，属于判据用错）。让它只做一件事：在 run_code 程序里执行
   const r = await tools.ops_batch({ action: "plan", operations: [{ op: "copy", path: "package.json", to: ".probe-tmp/ops-batch-probe.json" }] })
   然后把返回里的 id、status、done/total/failed 原样报回来（plan 是**无副作用预检**，不落盘，不是真复制）。同时让它报：它的系统提示词里那段「# ops 工具（检测到 dsh-ops 插件，已接入本团队）」在不在。
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
| **scout-ops**（standard + 批量开 = both 档） | 与 Lead 同一批 ops_*（含 file 四件套、`ops_bash`、job 四件套），清单里有 `run_code`；**没有** `ops_batch`/`ops_result`；**有** ops 指引段 | both 的组合是「全部原生工具 + run_code」，工具数 >1 → 被 ops 的 PTC 门挡在外面（离线实测同一份原版组件：ptc 档拿到 / both 档拿到空） |
| **researcher-ops**（ptc + 批量关 = 纯 PTC 档） | 送给模型的清单**只有 `run_code`**，所以在清单里找 `ops_batch` 一定找不到；但第 3 步那次 `await tools.ops_batch(...)` **必须调用成功**（报回 id 与 status） | 纯 PTC 档把送模型的 schema 裁成一个 run_code（宿主 `dsh-tools/lib/index.js:2840-2843`），而 ops 的 PTC 组件把两个工具注册进这名队员**自己的层**、在 run_code 程序里可调。**判据是"能不能调用"，不是"清单里有没有"** |

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
| researcher-ops 只有 run_code，但 `ops_batch` 调用失败 | ops 的 PTC 门没放行（组件未启用 / 版本变了）。发我报错原文与它的 dsh-ops 版本号，**不要改 ops 源码** |
| Lead 的清单里出现 `ops_batch`/`ops_result` | 与我给的事实相反 —— 发我，我重查 |

---

## 不想实调时的替代验证（不用重启 DSH）

```powershell
cd <本插件目录>   # 例：git clone 出来的 dsh-dispatch-agent-team
node tools/ops-mount-check.mjs
```

它挂真 dsh-ops 组件 + 真宿主注册表跑 A/B/C/D 四段。今天最后一次实测结果：
`总体：通过（A 交付态，B 负对照成立，C 后台任务实测，D shell 实测）`
—— A 段纯 PTC 档可见 `ops_batch`+`ops_result`；B 段同一份原版组件 both 档为空；C 段真起后台任务（job `j-vhs04r`，并**真调用**了一次）；D 段 `ops_bash` 已发布、口径覆盖文字确实进段。

另有 `.probe/preset-order-probe.mjs <队员id前缀>` 直读那名队员的日志。它对**纯 PTC 档会明确打印「这份日志判不了」**（wire 被裁成一个 run_code，见上），这是本轮刚修的一个误判点：以前它会谎报「ops 工具 = (无)」。