# 事故记录：崩溃恢复流程抹掉托管块（2026-10-09/10）

> 这份文档记录一次**真实事故的完整因果链**与修复方式。以后再遇到
> 「智能体团队不可用 / tool "x" is already registered in this scope」先看这里。

## 现象（用户 2026-10-10 报）

1. 界面显示 **「Team 暂不可用」**，调度模式里智能体团队整块不能用。
2. 点队员弹窗发消息失败：`发送失败：Cannot read properties of undefined (reading 'throwIfAborted')`。
3. 打开官方实验性插件时报：
   ```
   启用失败：dsh: warning: 1 entry did not activate tool-agent-team
   (@deepseek-ai/dsh-experimental-tool-agent-team): Error: tool "spawn_teammate"
   is already registered in this scope at NamedEntries.duplicateError
   ```

## 完整因果链（每一步都有日志/文件证据）

**第一步：另一个插件让 DSH 启动崩溃。**

崩溃日志（`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-2026-10-09T16-02-52-988Z-web-boot.log`）原文：

```
--- error ---
Error: web boot: 1 entry did not activate
@zws/dsh-token-heatmap: failed
```

崩的是用户自己做的 **`@zws/dsh-token-heatmap`**（token 热力图），**不是本插件**。

**第二步：用户点「禁用第三方插件、备份 profile patch 并重启」。**

这是 DSH 崩溃恢复界面提供的按钮。它的行为是：**重置 profile 的
`cordis.patch.yml`**（先改名备份、再写入一份干净的）—— 于是本插件写在里面的
`dispatch-agent-team:managed` 托管块**整段消失**。

证据：事故后 `cordis.patch.yml` 里 `dispatch-agent-team:managed:start` 匹配结果为 false，
且目录里留下了一串崩溃恢复备份（`cordis.patch.yml.bak-1791561799890` 之类）。

**第三步：托管块消失 → 官方九个团队工具与本插件同名冲突。**

托管块里那一行 `- id: tool-agent-team / disabled: true` 是**唯一**能关掉官方工具行的机制
（为什么不能靠 `tools.restrict()` —— 见 `lib/preset.js` 的 `suppressOfficialTeam` 长注释：
官方那九个工具是装进**每个 agent 自己的作用域**，而 restrict 只过滤**继承面**、只认全局层名字）。

它没了以后：

* 官方 `tool-agent-team` 重新启用 → 把 `spawn_teammate` 等九个名字装进同一个 agent 作用域；
* 本插件的九个工具 `register` 时撞名 → `tool "spawn_teammate" is already registered in this scope`；
* 本插件 `installTeamTools` 回滚全部注册、返回失败 → 「Team 暂不可用」；
* `agent-team` 容量退回官方默认 `maxMembers: 8`（本插件要 48）→ 团队 8 次 spawn 后派不出人。

## 修复

### 已落地：启动期自愈（`lib/self-heal.js`）

插件 `apply()` 时检查托管块是否还在：

| 情况 | 行为 |
|---|---|
| 在 | 什么都不做（正常路径零开销） |
| 不在 | **自动补齐**（先备份、内容与 `repair.cjs --apply` 逐字一致），并记诊断 |
| 定位不到 profile / 写入失败 | 只记诊断，**绝不抛错**（插件加载不能因为自愈失败而挂） |

**⚠️ 关键限制（必须诚实说明）**：写入发生在**插件加载期**，而 profile 的 patch 是
**worker 启动时读入**的 ⇒ 本次进程仍是重置后的状态（官方工具仍占着名字）。
所以自愈的效果**要再重启一次**才体现。这是架构决定的，插件内部无法绕过。

自愈的价值：用户**重启一次**就恢复，而不是「必须知道要手动跑 `repair.cjs --apply` 再重启」。

### 手动兜底

```powershell
# ① 完全退出 DSH（profile patch 启动时读入，开着改无效）
# ② 补齐托管块
node "<插件目录>\tools\repair.cjs" --apply
# ③ 启动 DSH
```

判据：`repair.cjs --check` 应打印
`运行时 agent-team 有效 maxMembers：48` 且 `运行时官方 tool-agent-team 行：已关闭（正确）`。

`repair.cjs` 现在会**主动检测 DSH 是否在运行**，在跑时明确警告「先完全退出 DSH，
否则改了不生效」—— 用户本次的困惑（「修了怎么还是不可用」）正源于此。

## 为什么弹窗发消息会崩（同一时间报的另一个 bug，独立原因）

```
Cannot read properties of undefined (reading 'throwIfAborted')
```

根因：官方签名是 `subagents.prompt(request, signal)` —— **signal 是第二个位置参数**
（`dsh-subagent/lib/index.js:3010`），而 `lib/runtime.js` 的 `teamSend` 只传了 `request`。
`signal === undefined` 传到官方 `materialize()` 的 `inputs.signal.throwIfAborted()`
（同文件 `:967`）就抛。

修：补传 signal 并加 60s 超时（`SUBAGENT_SEND_TIMEOUT_MS`）。

## 给以后排查的人

遇到「Team 暂不可用」按这个顺序查：

1. `node tools/repair.cjs --check` —— 它会直接点出「关闭官方 tool-agent-team 行：否」
   或「容量覆盖：缺」，并说明是否要重启。
2. 看 `cordis.patch.yml` 里有没有 `dispatch-agent-team:managed:start`。
   没有 → 被崩溃恢复抹掉了，跑 `--apply`（或直接启动，插件会自愈）。
3. 若有 `crash-*-web-boot.log`，先确认崩的是**哪个** entry —— 本次是别的插件，
   与本插件无关，但**恢复流程的副作用**波及了本插件。
