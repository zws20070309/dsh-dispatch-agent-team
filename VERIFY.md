# 真机验收指南

> 这份文件回答一个问题：**改完代码之后，怎么用真实会话证明它真的能用。**
> 它不是发布清单（那个在 `README.md` 的「维护」节），也不是实现契约（那个在
> [`INTERFACES.md`](./INTERFACES.md)）。这里只讲"怎么测、看什么才算过"。

## 零、先决条件（不满足就别测，否则测的是空气）

| 项 | 要求 | 为什么 |
|---|---|---|
| **重启 DSH 桌面端** | 必须 | 宿主半（`lib/*.js`）只在启动时加载。改了不重启 = 测的是旧代码，这条踩过多次 |
| 浏览器刷新 | 改了 `lib/client.js` 时必须 | 浏览器半随页面加载 |
| 会话权限 | **完全访问** | `ops_bash` 与四个 job 工具的发布门要求它 |
| 推理模式 | **调度模式** | 只有这个 preset 会注册本插件的团队工具 |

> 判断"到底加载的是哪份代码"：`node tools/repair.cjs` 会告诉你 profile 链到哪个目录。
> 目录必须是你的源码目录，否则改的地方和跑的地方是两回事。

## 一、两档工具面（这是最容易测错的地方）

「批量调用」这个开关决定队员**拿到什么工具**，与它的角色无关：

| 开关 | 呈现档 | 队员实际拿到的 | 按推荐配置属于这档的角色 |
|---|---|---|---|
| **开**（默认） | `ptc` | **只有 `run_code`**；原生工具不可见。只有这档能拿到 dsh-ops 的 `ops_batch`/`ops_result` | researcher · scout · frontier-auditor · plan-critic · verify · red-team · visual-critic |
| **关** | `native` | 全套原生 `edit`/`write`/`read`/`grep`/`pwsh`…；**没有** `run_code` | builder · integrator · tester · refiner · scribe |

**配置页点一次「推荐」按钮**就会按上表填好。

> ⚠️ 官方已删掉 `both`（原生 + `run_code` 并存）这一档。历史文档里凡是提到 "both 档"
> 的都是 2026-10-21 之前的旧口径，不要照着配。

怎么看队员**真的**拿到了什么：`node tools/session-probe.cjs --tools --session <会话子串>`

## 二、主验收提示词（一次覆盖全部关键路径）

把下面整段贴给 Lead。**每一行括号里的内容是我要看的证据**，缺一行就算没测到。

```text
/team 【真机验收】只在 .probe-tmp/verify/ 下写，不要改 lib/、tools/、presets/、README.md。

1. 不传 name 派一个 builder，记下自动分配的名字。
   （证据：实际名字）
2. 故意用 name="builder-1" 派一个，把报错全文一字不改抄下来。
   （证据：报错全文。要能看到「现在就能用的名字："X" 或 "Y"」，
     且 X/Y 互不相同、都不是已占用或历史用过的名字）
3. 故意用 name="chain-a" 再派一个，同样抄全文。
   （证据：报错全文。应当只给一套答案，不许出现「改成 builder-2」这种与候选段打架的句子）
4. 用第 2 步报错里给的第一个候选名真派出去，确认成功。
   （证据：成功/失败 + 返回的 member）
5. 建 3 条任务，写域写成具体文件（verify/a.mjs、verify/b.mjs、verify/c.mjs），不要写目录。
   （证据：创建返回里 writeScopeWarnings 是空数组；官方面板上没有红字 overlap）
6. 先 complete 一条还没 claim 的任务，抄下报错全文。
   （证据：报错里必须有「下一步：…先 claim…」）
7. 用 send_message 给单个队员发指令 2 次。
   （证据：两次都返回 accepted:true；全程不许出现 INVALID_TOOL_OUTPUT）
8. 做一次「定向指令误用广播」：文案写「【builder-x 请执行·其他人忽略】……」，但不传 targets。
   （证据：返回值 diagnostics 里有「改用 send_message」那句提醒）
9. 派一名 verify 实跑核验第 4/5 步的产出。
   （证据：verify 的 report_result 状态与验收结论）
10. 收尾把任务板全部闭环。
   （证据：team_task_list 里 open 数为 0）
```

## 三、判过标准（逐条对，不许"差不多"）

| # | 通过条件 | 失败通常意味着什么 |
|---|---|---|
| 1 | 自动分配了形如 `builder` / `builder-2` 的名字 | 命名算法坏了 |
| 2 | 候选名**互不相同**且**都空闲**（含历史名单） | 判重口径错了（只用活体名单就会撞历史） |
| 3 | 报错里**只有一套**建议 | 提示拼了两处、互不一致 |
| 4 | 照建议改真能成功 | 建议的名字不可用 —— 这比不给建议更坏 |
| 5 | 写域是具体文件、无 overlap 告警 | 写域填成目录（官方按路径前缀判重叠） |
| 6 | 报错带可执行的「下一步」 | 错误码翻译丢了 |
| 7 | 无 `INVALID_TOOL_OUTPUT` | 工具返回值与 `output.schema` 不一致（曾导致每次成功投递都报错） |
| 8 | 出现定向广播提醒 | 护栏没接线 |
| 9 | verify 有独立证据、状态正确 | 队员在走过场 |
| 10 | 未闭环 0 条 | 收尾没做完 |

## 四、出错时抓什么回来

1. **会话 ID**（`session-xxxxxxxx-…`，Lead 那个）
2. 跑的是哪一段提示词、当时的配置（哪档开关）
3. 你肉眼看到的异常（截图最好）

拿到会话 ID 后可直接定位：

```bash
node tools/session-probe.cjs --tools --session <会话子串>   # 该会话真实的工具面
node tools/session-probe.cjs --calls --session <会话子串>   # 它的工具调用明细
node tools/cache-prefix-audit.cjs --all --tail 200           # 缓存命中与断点（按会话滚动）
```

## 五、只读体检（不需要人工会话，随时可跑）

```bash
node tools/selftest.cjs           # 纯逻辑回归（零 dsh 依赖）
node tools/drift-check.cjs        # 官方实现假设校验（升级 DSH 后必跑）
node tools/integration-test.cjs   # 真链路集成
node tools/client-smoke-test.cjs  # 浏览器半渲染冒烟
node tools/repair.cjs             # 安装状态体检
node tools/ops-mount-check.mjs    # dsh-ops 四组件挂载（不用重启）
```

> 除 `client-smoke-test` 外，其余都要先有安装期那个依赖 junction
> （跑过 `repair.cjs --apply`），否则报 `ERR_MODULE_NOT_FOUND` ——
> 那是"还没装好"，不是插件坏了。
