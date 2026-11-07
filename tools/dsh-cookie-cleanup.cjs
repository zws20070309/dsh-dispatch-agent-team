#!/usr/bin/env node
/**
 * dsh-cookie-cleanup.cjs —— DSH 启动失败（"desktop welcome: Web authentication failed"）的自愈脚本。
 *
 * 根因（2026-11-07 实机定位）：DSH 的 Desktop Host 每次启动都签发一枚新的 `dsh-auth-*`
 * 认证 cookie（host=127.0.0.1，is_persistent=1），旧的**从不清理**。Chromium cookie jar
 * 里逐次累积；启动时 `net.fetch(ready.url, {credentials:"include"})` 会把 jar 里**全部**
 * dsh-auth cookie 带上——积累到几十个后，认证请求头撑爆或被 host 校验拒绝（非 2xx），
 * shell 抛 `desktop welcome: Web authentication failed`，应用无法启动。
 * 官方 crash log 的插件操作记录只是 context，与插件无关。
 *
 * 修法：在 **DSH 完全退出**时，从 Chromium cookie 库删掉 127.0.0.1 的全部 dsh-auth-*
 * cookie（一次性认证凭据，host 下次启动会重新签发），再启动即恢复。
 *
 * 用法：node tools/dsh-cookie-cleanup.cjs
 *   * 先检测 DSH 进程：还在运行就拒绝（cookie 库被锁，且删除中的库会被覆盖回去）。
 *   * 删除前自动备份 Cookies → Cookies.bak-<时间戳>（同目录）。
 * 永不改动 .dsh 下的任何数据；只动 Roaming 的 cookie 库。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const COOKIE_DB = path.join(
  process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'),
  '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies',
);

function dshRunning() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "(Get-Process -Name \'DeepSeek Harness\' -ErrorAction SilentlyContinue | Measure-Object).Count"',
      { encoding: 'utf8', timeout: 20000 },
    );
    return Number(out.trim()) > 0;
  } catch {
    return true; // 探测失败按"在运行"处理，宁可拒绝也不冒险
  }
}

function main() {
  if (!fs.existsSync(COOKIE_DB)) {
    console.error(`找不到 cookie 库：${COOKIE_DB}`);
    process.exitCode = 1;
    return;
  }
  if (dshRunning()) {
    console.error('DeepSeek Harness 还在运行——请先完全退出（含错误对话框点「退出」），再跑本脚本。');
    process.exitCode = 1;
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${COOKIE_DB}.bak-${stamp}`;
  fs.copyFileSync(COOKIE_DB, backup);
  console.log(`已备份：${backup}`);

  const db = new DatabaseSync(COOKIE_DB);
  const before = db
    .prepare("SELECT COUNT(*) AS n FROM cookies WHERE host_key = '127.0.0.1' AND name LIKE 'dsh-auth-%'")
    .get();
  const deleted = db
    .prepare("DELETE FROM cookies WHERE host_key = '127.0.0.1' AND name LIKE 'dsh-auth-%'")
    .run().changes;
  db.close();
  console.log(`删除 dsh-auth cookie：${deleted} 个（删除前 ${before.n} 个）。`);
  console.log('现在可以启动 DeepSeek Harness 了——host 会重新签发认证 cookie。');
  if (deleted === 0) {
    console.log('（本次没有可删的积累 cookie；启动失败另有原因，请看 crash log。）');
  }
}

main();
