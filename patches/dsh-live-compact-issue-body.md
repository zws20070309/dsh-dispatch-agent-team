## 环境

- dsh-live-compact **1.1.0**（DSH 桌面端 profiles/desktop 安装）
- DeepSeek Harness 0.2.2-rc.1 / Electron 44.7.0 / Node 24.21.0 / Windows 11 x64（zh-CN）
- DSH host 进程**以普通（非提升）权限运行**——这是 DSH 的正常启动方式

## 现象

DSH 间歇性无法启动，弹「应用无法启动或已意外停止」。crash log（host）：

```text
dsh: fatal load failure: Error: spine: shadow permission action failed; backup refused
  code: 'ESHADOWACCESS'
  [cause]: Command failed: icacls.exe C:\Users\<user>\.dsh\compaction-spine /restore ...\spine-acl-xxx\access.acl /q
    at tightenShadow (dsh-live-compact/shadow.js:272)
    at ensureShadowDir (dsh-live-compact/shadow.js:283)
    at SpineCompactionEngine.captureOne (dsh-live-compact/index.js:764)
    at SpineCompactionEngine.finishTurn (dsh-live-compact/index.js:478)
    at ReactLoopAgent.kick (dsh-agent-loop/lib/index.js:658)
```

icacls 的实际错误是 **exit 1300**：「并非所有被引用的特权或组都分配给呼叫方」（ERROR_NOT_ALL_ASSIGNED），并伴随「已成功处理 0 个文件; 处理 0 个文件时失败」。

## 根因

`defaultShadowAccessRunner` 在 Windows 用 `icacls <父目录> /restore <acl文件>` 收紧 spine 目录 ACL。**`icacls /restore` 需要 SeRestorePrivilege，而该特权只在提升（elevated）token 里启用**；DSH host 非提升运行 → restore **恒失败**，与 SDDL 内容无关。

`tightenShadow` 把 runner 失败包装成 `ESHADOWACCESS` 抛出；该异常沿 cordis `apply` 传播为 **fatal load failure** → host 进程退出（exit 1）→ 整个应用无法使用。触发点是 **Lead turn 收尾的压缩（finishTurn）**，所以表现为「某一轮跑完压缩后，下一次启动就崩」的间歇形态。

## 排除实验（证明与 SDDL 内容无关）

在非提升 PowerShell 里对同一目录实测 `/restore`，三种 SDDL 变体**全部 exit 1300**：

| 变体 | SDDL | 结果 |
|---|---|---|
| 原版 | `D:P(A;OICI;FA;;;<user>)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)` | 1300 |
| 去 P 标志 | `D:(A;OICI;FA;;;<user>)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)` | 1300 |
| 仅 owner | `D:P(A;OICI;FA;;;<user>)` | 1300 |

## 修复建议（已在本机验证可行）

`/restore` 换成**不需要特权的等效操作**——`/inheritance:r` 去继承 + `/grant:r` 重授同样三条 ACE（`plan.grant` 里现成的），最终 ACL 与 `D:P` 目标一致：

```js
// defaultShadowAccessRunner 的 try 块，替换 restore 调用：
execFile(
  "icacls.exe",
  [target, "/inheritance:r", "/grant:r", ...plan.grant],  // target = resolve(path)，即 spine 目录本身
  { stdio: "pipe", windowsHide: true },
);
```

非提升环境实测 **exit=0**，结果 ACL 与 `/restore` 的 `D:P` 目标完全一致（owner/SYSTEM/Administrators 全控制、去继承）。更完整的做法是先探测 `SeRestorePrivilege` 是否启用，可用则维持 restore、不可用则降级到 grant 路径。

## 补充

- 临时 acl 文件的 `\ufeff` BOM + UTF-16LE 编码本身没问题（icacls 能正确读取）
- 该失败只在 `finishTurn` 时爆发（首次触发压缩的那一轮），此前安装后未触发过压缩的用户不会遇到，容易被误判为「DSH 自身启动问题」
