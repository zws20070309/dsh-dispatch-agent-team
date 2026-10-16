# 第三轮测试提示词（验 plan→resume 真执行、job 生命周期、以及我那个可证伪预言）

**为什么还要第三轮**：前两轮只验到 `action:"plan"`（无副作用预检）。`resume` 才真写盘、
`ops_result` 分页、job 全生命周期、`ops_replace` 真替换、`ops_bash` 真执行 —— 这些**一次都没在队员身上验过**。
另外我上一轮断言「subagent 泄漏但被 maxDepth=1 挡住、不是权限洞」，那是**推断**，要拿真机证伪或证实。

## 参数形状全部由我本人实测（15:29–15:33，我自己就是纯 PTC 档，直接在 run_code 里跑的）

| 调用 | 实测结果 | 给队员时的坑（我草稿里就踩了） |
|---|---|---|
| `ops_batch({action:"plan"})` | `status:"planned"` + `id` + `detailsRef` | 判成功看 `status` |
| `ops_batch({action:"resume", id})` | `status:"completed"` `done:1/1` `failed:0` `unknown:0`，**目标文件真被创建** | resume 要 `id`，且**会真写盘** |
| `ops_result({action:"page", id, limit})` | 顶层键只有 `complete/id/items/nextOffset/omitted/total/sandbox` | **没有 `status` 字段** —— 照 plan 的判据看 `status` 会误判成失败 |
| `ops_result({action:"release", id})` | `POLICY_DENIED: Job audit records cannot be released by this tool` | 这是 ops 的设计（job 审计只读），**不是故障**，别当 bug 报 |
| `ops_replace({path, pattern, replacement})` | `status:"completed"` `changed:1` `matched:1`，文件真被改 | 字段是 `pattern`/`replacement`；我草稿写的 `operations:[{find,replace}]` 被拒：`unknown field operations, expected one of path, pattern, replacement, glob, maxReplacements, dryRun` |
| `ops_replace({... , dryRun:true})` | `status:"completed"` `matched:1` **`changed:0`**，复核文件**未被修改** | 所以第 1(e) 步让队员带 `dryRun:true` 是安全的：能验到工具可用，又不动它的文件 |
| `ops_run_background({command})` | `job j-hc409u started` + 日志路径 | 返回是 `{content:[{text}]}` 文本信封，**job id 要自己从文本里抠** |
| `ops_job_output({job_id})` | `JOB_ROUND3_DONE` + `exited 0; 1 line total` | 参数名是 `job_id` |
| `ops_job_list({})` | `0 owned jobs` | **必须传 `{}`**；不传参数在绑定层就被拒（`binding arguments must be lossless JSON`） |
| `ops_bash({command})` | exit 0、`MINGW64_NT-10.0-26200`、POSIX 路径 | PowerShell 语法正确失败（exit 127），别混着写 |

---

## 要贴给 Lead 的提示词（整段复制）

```
第三轮验证，重点是"真执行"，不是"能不能看见"。做 5 件事，每件都把原始返回照抄，不要替我判断对错、不要总结：

1. 派队员 scout-ops3（角色 scout：PTC 模式 + 批量调用开 = both 档，可以直调工具）。让它按顺序做完并逐条回报原文：
   (a) 直调 ops_bash({command: "echo SCOUT3_OK; pwd"}) —— 报 exitCode 与 stdout 原文。
   (b) 直调 ops_run_background({command: "sleep 2; echo BG_SCOUT3"}) —— 把返回原文贴出来，并从里面抠出 job id。
   (c) 用 ops_job_output 查那个 job id（参数名是 job_id），等它跑完，报 stdout 与退出码原文。
   (d) 调 ops_job_list({}) —— 注意**必须传一个空对象 {}**，不传参数会报绑定错误。报返回原文。
   (e) 先 ops_grep 或 ops_glob 找一个它 cwd 里真实存在的小文本文件，然后直调 ops_replace({path: <那个文件>, pattern: <文件里确实存在的一个短词>, replacement: <加个后缀>, dryRun: true}) —— 用 dryRun: true，**不许真改文件**。报 matched/changed 原文。

2. 派队员 researcher-ops3（角色 researcher：PTC 模式 + 批量调用关 = 纯 PTC 档，只有 run_code 可直调）。
   下面全部放在**一个 run_code 程序里**做，逐步贴原文：
   (a) 先用 tools.ops_glob({path: ".", pattern: ["*.json","*.md","*.txt"]}) 找一个真实存在的小文件，取第一个命中。
   (b) plan：await tools.ops_batch({action: "plan", operations: [{op: "copy", path: <(a)的相对路径>, to: <同目录>/r3-probe<扩展名>}]})，报 status/id。
   (c) **真执行**：await tools.ops_batch({action: "resume", id: <(b)的 id>})，报 status/done/total/failed/unknown/error 原文。
   (d) 核实落盘：await tools.ops_glob({path: ".", pattern: [<(b)的 to 文件名>]})，报 matched 与 items —— 这一步是验 resume 真的写了盘。
   (e) 清理：await tools.ops_batch({action: "plan", operations: [{op: "remove", path: <(b)的 to 文件名>}]}) 再 resume 那个新 id，把两步的 status 都报回来；然后再 ops_glob 一次确认 matched=0。
   (f) 分页：用 (c) 那个 id 调 await tools.ops_result({action: "page", id: <id>, limit: 3})，报**顶层键名列表**、total、complete、items 长度。注意它**没有 status 字段**，别拿 status 判成败。
   (g) 边界：调 await tools.ops_result({action: "release", id: <id>})，把返回原文贴回来（预期是被拒，那是 ops 的设计，不是故障）。

3. 关键一条，单独做：让 researcher-ops3 在它自己的 run_code 程序里执行
   const keys = Object.keys(tools).filter(k => k.startsWith("ops_")).sort(); return JSON.stringify({n: keys.length, keys, hasSubagent: Object.keys(tools).includes("subagent")});
   把原文贴回来。我要数 ops_* 到底几个、有没有 subagent。

4. 复验一条我已经实测过的预言（请独立再验一次，如实报，不要为了顺着我而改写）：
   让 scout-ops3 直调 subagent 工具，派一个最简单的子任务（例如 prompt: "只回复四个字：子代理成功"）。
   把**完整返回或报错原文**贴回来，一个字都别改。
   我的预言是：它会**失败**，报的是深度上限那一类错误（官方原文形状：`subagent depth 2 exceeds maxDepth 1`），而不是真的派出一个子代理。
（这条是**可证伪的推断**，不是我验过的事实：maxDepth 是 `.volatile()` 的用户设置，本机没有 settings.yaml 落盘，所以我按 zod 默认 1 算。）
   如果它**成功**派出了子代理，那就是我错了，请明确写「预言被推翻：子代理真的起来了」。

5. 最后给我一张表：
| 谁 | 调用 | 结果（原文关键字段） | 是否符合预期 |
把上面每一条都列进去，包括失败的。然后单独回答：
Q1：resume 之后 ops_glob 有没有命中那个新文件？remove 之后是不是又没了？
Q2：ops_result page 的顶层键有哪些？有没有 status？
Q3：第 4 条我的预言成立还是被推翻？
```

---

## 判读

| 现象 | 结论 |
|---|---|
| `resume` 返回 `status:"completed"`、`done:1/1`、随后 `ops_glob` 命中新文件 | ops_batch **真执行**链路通（前两轮只验到预检，这是最后一块） |
| `remove` 后 `ops_glob` `matched=0` | 清理也通，且证明它没留垃圾 |
| `ops_result page` 有 `total/complete/items` | 分页引用通（大结果不塞进汇报那条成立） |
| `release` 报 `POLICY_DENIED: Job audit records cannot be released` | **正常**，ops 的设计是 job 审计只读；不是故障 |
| `subagent` 报深度上限错（`exceeds maxDepth`） | 我上一轮的判断成立：泄漏只是「清单里多一个用不上的工具」，**不是权限洞**。依据（本轮逐层查过）：启用的 `tool-subagent` 行（`dsh-base/cordis.patch.yml:370`）config 是 `provider: spawn / toolName: subagent / backgroundMode: continuable`，**里面没有 `maxDepth`**；带 `maxDepth: provider-managed` 的那两行（codex / claude-code）是 `disabled: true`，不算。所以 `config.maxDepth === undefined` → `resolveMaxDepth` 回落到宿主设置 `this.config.maxDepth.get()`，而 `~/.dsh` 与 profile 目录里**都没有 settings.yaml**（只有 0 字节的 `settings.yaml.imported`）→ 取 zod 默认 **1**。队员 `session.delegationDepth=1`，`resolveChildDepth` = 1+1=2 > 1 → 抛 `SubagentDepthError` |
| `subagent` **成功**派出子代理 | **我错了**，maxDepth 不是 1（可能设置页改过）。那才是真问题，把原文发我，我去查真实生效值 |
| `ops_job_list` 不传参数报 `lossless JSON` | 已知：必须传 `{}`。我的绑定层限制，不是 ops 的问题 |

## 安全边界（这三条请你也确认给队员）

1. `resume` **会真写盘**，所以只允许在队员自己 cwd 下 copy 出一个带 `r3-probe` 名字的新文件，做完必须 `remove` 掉。
2. `ops_replace` 一律带 `dryRun: true`，不许真改任何现有文件。
3. 第 4 条派子代理是**故意**要它失败的一次；如果它真起来了，让它自然结束，不要递归再派。

---

## 附：第 4 条我已经自己复现过一次（15:41，不占你的测试）

我（深度 0）用 `subagent` 派出一名深度 1 的子代理，让它在 run_code 里再调 `tools.subagent`（= 深度 2），
要求它原样贴回返回值。实测结果逐字：

```
{ "outcome": "FAILED", "message": "subagent depth 2 exceeds maxDepth 1" }
```

与官方 `resolveChildDepth` 的抛出形状（`subagent depth ${attemptedDepth} exceeds maxDepth ${maxDepth}`）
完全一致，`maxDepth` 生效值确实是 **1** —— 所以我上一轮那句「不是权限洞」从**推断**升级为**实测事实**：
队员清单里那个 `subagent` 用不了，代价只是误导模型 + 白烧 token。

**为什么还要你测一遍**：我那名子代理是 `subagent` 工具派出来的，而你的队员是 `spawn_teammate` 派出来的
—— 两者深度都是 1（我读过 scout-ops2 的 `session.delegationDepth=1`），走的也是同一个深度守卫，
但**派生路径不同**。所以第 4 条是对「队员这条路径」的直接确认，不是重复劳动。

顺带一个我自己踩到的事实：我是纯 PTC 档，所以刚才**直调 `subagent` 也被拒**
（`unknown tool "subagent": only run_code is callable directly`）—— 必须放进 run_code 里调。
这正是本轮修掉的那句文案问题，现场又演示了一遍。