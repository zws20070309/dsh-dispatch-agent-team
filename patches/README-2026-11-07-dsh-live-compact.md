# dsh-live-compact shadow.js 补丁说明（2026-11-07）

## 事故

DSH 无法启动：`应用无法启动或已意外停止`，crash log（host）：

```
dsh: fatal load failure: Error: spine: shadow permission action failed; backup refused
  code: 'ESHADOWACCESS'
  [cause]: Command failed: icacls.exe C:\Users\ZWS\.dsh\compaction-spine /restore ...\access.acl /q
  （exit 1300：并非所有被引用的特权或组都分配给呼叫方）
    at tightenShadow (dsh-live-compact/shadow.js:272)
    at SpineCompactionEngine.finishTurn (dsh-live-compact/index.js:478)
```

## 根因

`dsh-live-compact/shadow.js` 的 `defaultShadowAccessRunner` 在 Windows 用
`icacls <父目录> /restore <acl文件>` 收紧 compaction-spine 目录 ACL。
**`icacls /restore` 需要 SeRestorePrivilege，该特权只在提升（elevated）token 里启用**；
DSH 的 host 进程非提升运行 → restore **恒失败**（exit 1300，与 SDDL 内容无关——
去掉 BA/SY ACE、去掉 P 标志、只留 owner 三种变体全部 1300 实证）→
`tightenShadow` 抛 `ESHADOWACCESS` → cordis apply 致命 → host 退出。
触发时机：Lead turn 收尾的压缩（finishTurn），所以表现为"上一轮还好，下轮启动就崩"。

## 修法（等效、无特权要求）

`/restore` 换成 `/inheritance:r /grant:r <三条 ACE>`（plan.grant 本来就有）：
最终 ACL 与 restore 的 `D:P` 目标一致（owner/SYSTEM/Admins 全控制、去继承），
非提升实机验证 exit=0。patch 已直接写入
`~/.dsh/profiles/desktop/node_modules/dsh-live-compact/shadow.js`（本文件同名 `.patched` 是副本）。

## 注意

- **dsh-live-compact 升级会覆盖本补丁**——升级后若复发同款崩溃，重放：
  把 shadow.js 里 `defaultShadowAccessRunner` 的 try 块换成
  `execFile("icacls.exe", [target, "/inheritance:r", "/grant:r", ...plan.grant], {stdio:"pipe", windowsHide:true})`
  （target = resolve(path)，即 spine 目录本身；不再需要临时 acl 文件）。
- 已同步向上游报告的建议：非提升环境应探测特权可用性后降级到 grant 路径。
  上报正文见同目录 [`dsh-live-compact-issue-body.md`](./dsh-live-compact-issue-body.md)：
  环境版本、完整 crash log、三种 SDDL 变体全部 exit 1300 的排除实验、以及本机已验证的修法。
  那份是**可直接提交给上游**的独立文本，不含本仓库信息。
