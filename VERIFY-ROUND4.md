# 第四轮测试（**必须先重启 DSH**）

## 为什么第三轮的文案部分等于白测（我的疏漏）

你没重启就测了第三轮。时间线（本机实测，不是估的）：

```
DSH 进程启动        14:08:36
指引段修正提交      14:52  ← 晚于进程启动 = 没加载
restrict 诊断措辞   15:21  ← 同上
指引段两条 job 坑   16:02  ← 同上
```

探针现在会直接告诉你答案（拿第三轮的旧日志跑，如实报）：

```
ops 指引段与本包当前源码逐字相同 = false（期望 1021 字）
  首个差异在第 81 字：
  队员实际看到: "sh-ops 插件），它们与宿主工具同级，放心直调：…"
  当前源码期望: "sh-ops 插件），它们与宿主工具同级、能力一致；但**能不能直接调用取决于你这一档**…"
=> 该进程加载的不是当前源码的文案（最常见原因：改完没重启 DSH）。
```

**注意**：第三轮真正要验的东西（`resume` 真执行、job 生命周期、`ops_replace dryRun`、
`subagent` 深度预言）**不依赖文案版本**，那些结论仍然有效。只有「新文案有没有生效」这一项没测到。

---

## 第 0 步：重启 DSH，然后先跑这一条确认加载到了新文案

```powershell
cd <本插件目录>
node .probe/preset-order-probe.mjs <随便一名新队员的id前缀>
```

看 `ops 指引段与本包当前源码逐字相同 = true`。**是 false 就别往下测了**（说明还是旧进程）。
探针不硬编码特征串，它 import 当前源码当期望值，所以以后我改文案它会自动跟。

---

## 要贴给 Lead 的提示词（整段复制）

```
第四轮。前几轮已验过：ops_bash 能执行、呈现档不再翻转、plan→resume 真写盘、job 全链路、dryRun 不落盘。
这轮只验三件**还没验过**的事。每件都把原始返回照抄，不要总结、不要替我判断对错：

1. 派队员 scout-ops4（角色 scout：PTC 模式 + 批量调用开 = both 档，可直调）。
   (a) 直调 ops_bash({command: "echo R4_OK; uname -s"}) —— 报 stdout 原文。
   (b) 直调 ops_batch({action: "plan", operations: [{op: "copy", path: "package.json", to: "r4-probe.json"}]})。
       注意：这是**故意**让它在 both 档队员身上调 batch —— 我的预期是它**不该有这个工具**
       （ops 的 PTC 门只放行纯 PTC 档）。把返回原文或报错照抄，一个字别改。
   (c) 报它的系统提示词里 ops 指引段的**前两行原文**，以及有没有这一句：
       「清单里除 run_code 外还看得到 ops_* → 可以直接调用」（新文案才有）。

2. 派队员 researcher-ops4（角色 researcher：PTC 模式 + 批量调用关 = 纯 PTC 档）。
   全部在 run_code 程序里做：
   (a) 先贴一句事实：await tools.ops_batch 是不是 function？（typeof）
   (b) 用 tools.ops_glob({path: ".", pattern: ["*.json","*.md","*.txt"]}) 找一个真实存在的小文件。
   (c) plan → resume 真执行一次（to 用同目录下一个 r4-probe 开头的新文件名），
       然后立刻用 tools.ops_glob 核实它**真的落盘**了，报 matched 与 items。
   (d) **这次不自己清理**：把 (c) 创建的文件名原样报给我，留着我要看它出现在哪。
   (e) 报它的系统提示词里 ops 指引段的前两行原文（和 1(c) 同一判据，两名队员应当逐字节相同）。

3. 交叉核对（这条最重要）：把 1(c) 与 2(e) 贴出的**指引段前两行**放在一起比，
   告诉我它们是不是逐字相同。两名队员档位不同（both / 纯 PTC），但指引段必须完全一样 ——
   因为它是共享前缀，一旦按角色分叉，提示词缓存就碎了。

最后给我一张表：| 谁 | 指引段前两行 | ops_batch 可用性 | resume 落盘核实 | 结论 |
并单独回答：
Q1：scout-ops4（both 档）调 ops_batch 的结果是什么？（成功 / 报错原文）
Q2：两名队员的指引段前两行是否逐字相同？
Q3：researcher-ops4 那个 r4-probe 文件叫什么名字（我要留着核）？
```

---

## 判读

| 现象 | 结论 |
|---|---|
| 探针 `逐字相同 = true` | 新文案已加载，本轮才有效 |
| 1(b) scout 调 `ops_batch` 报 unknown tool / 不在清单 | **符合预期**：ops 的 PTC 门只放行纯 PTC 档（装机 `lib/ptc/index.js:20`） |
| 1(b) scout 竟然调成功了 | 与我给的事实相反 —— 发我，我重查（可能是 ops 版本变了） |
| Q2 = 是 | 共享前缀纪律成立（本轮第一次在**新文案**下验它） |
| Q2 = 否 | 真缺陷：指引段按角色分叉了，会把缓存前缀切碎 —— 发我两段的差异 |
| 3(c) `matched=1` 且报出了文件名 | resume 真写盘再次成立（第三轮已验过，这是新进程下的复验） |

## 第 2(d) 步为什么要留文件（以及一句我要收回的话）

**我上一条草稿里写过「审计存根长什么样我一次都没看过」—— 那是假的，现在收回**：
本机 `.dsh-ops/` 里已有 21 个存根，我 12:26 就读过第一个（那次是 mount-check 的 plan）。
写没见过的东西当测试动机，是我最不该犯的错误。

留文件的**真实**理由：存根是**分片追加**的状态历史，最新一片才是落定值 —— 我要核的是「最新分片
里那一项的 `state`」与**磁盘实际**是否一致。实测（本机 `.dsh-ops/`，16:18 那次两操作 resume）：

```
.000002  c1=completed  c2=pending      mtime 08:18:06.219Z
.000003  c1=completed  c2=unknown      mtime 08:18:06.221Z   （该项 error=RESULT_UNKNOWN）
.000004  c1=completed  c2=completed    mtime 08:18:06.233Z
```

分片编号与 mtime 都严格递增；另一个单操作 job `j-1434539e` 是同样规律
（`.000000 pending → .000001 unknown → .000002 completed`）。两个独立样本一致。

**只报观测、不解释机制**：中间那片为什么带 `unknown`/`RESULT_UNKNOWN`，我没读 Rust worker
（那句英文在 JS 层搜不到，是编译进 exe 的），所以不下结论。另外分片编号**不一定从 000000 开始**
（这个 job 就从 000002 起）—— 别拿编号推总数。

存根顶层键是 `version/id/root/root_identity/scope/created/protect/items`，**没有**顶层 state；
状态在**每项** `items[].state` 里。这也给出第三轮未决项 `complete=false` 的实物答案：
`complete` 说的是「这份返回有没有把明细都带回来」（resume 时 `omitted=2`、分页取回后 `omitted=0 complete=true`），
跟任务成没成功无关；判成败看 `status/done/failed/unknown`。

测完我自己删，或者你说一声我删。