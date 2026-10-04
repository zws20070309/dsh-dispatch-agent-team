#!/usr/bin/env node
/**
 * sync-to-dsh.cjs —— 把本工作区的改动同步到 DSH 实际加载的那份插件目录。
 *
 * ── 为什么需要它（2026-10-04 实测得出的硬约束）────────────────────────────────
 * DSH 加载 profile 插件时走的是 dsh-app-boot 的 profile-resolution 拦截路由
 * （dsh-app-boot/lib/worker/profile-resolution-bootstrap.js）：它按**路径前缀**判断
 * 某个模块请求是否属于 profile，属于就把官方包请求路由到 app.asar 里那一份。
 * 因此插件的**真实文件位置必须在 profile 的登记路径内**：
 *
 *   * 可行：<DSH 主目录>\.dsh\plugins\<包名> 是**真实目录**
 *   * 不可行：把该目录做成 junction 指向工作区（D 盘等）——
 *     realpathSync 会解析到 profile 之外，拦截路由不生效，而
 *     <DSH 主目录>\.dsh\profiles\node_modules 下的官方包是**悬空 junction**
 *     （指向已被清空的全局 CLI 目录），于是 import '@deepseek-ai/dsh-tools' 直接
 *     ERR_MODULE_NOT_FOUND，插件整个加载失败、预设显示「加载失败」。
 *
 * 所以工作流固定为：**在工作区改代码 → 跑本脚本同步 → 重启桌面端**。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────────
 *   node tools/sync-to-dsh.cjs            # 同步（默认目标 = DSH 主目录下的同名插件目录）
 *   node tools/sync-to-dsh.cjs --dry-run  # 只列出会变动的文件，不写盘
 *   node tools/sync-to-dsh.cjs --check    # 只报告两边差异，不写盘（退出码 1 = 有差异）
 *   node tools/sync-to-dsh.cjs --target <dir>   # 指定目标目录
 *
 * 只同步**源码文件**（下面的 FILES 清单）；node_modules、.git 与目标目录里
 * 独有的文件（例如 REVIEW-*.md 审查历史）**一律不碰**。
 *
 * 退出码：0 成功/无差异；1 有差异（--check）或同步失败；2 环境不满足。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const pluginDir = path.resolve(__dirname, '..');
const dshPaths = require('./lib-dsh-home.cjs').resolveProfileDir({});
const dshHome = dshPaths.home;

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : void 0;
}

const dryRun = process.argv.includes('--dry-run');
const checkOnly = process.argv.includes('--check');
const target = path.resolve(argValue('--target') ?? path.join(dshHome, 'plugins', path.basename(pluginDir)));

/** 要同步的相对路径清单（源码与文档，不含依赖与 git）。 */
const FILES = [
  'package.json',
  'cordis.patch.yml',
  'presets/dispatch-mode.patch.yml',
  'icon.svg',
  'LICENSE',
  '.gitattributes',
  '.gitignore',
  'locale/zh.json',
  'locale/en.json',
  'lib/index.js',
  'lib/preset.js',
  'lib/runtime.js',
  'lib/tools.js',
  'lib/roster.js',
  'lib/playbook.js',
  'lib/cache.js',
  'lib/resume.js',
  'lib/client.js',
  'tools/drift-check.cjs',
  'tools/selftest.cjs',
  'tools/integration-test.cjs',
  'tools/client-smoke-test.cjs',
  'tools/emergency-disable.cjs',
  'tools/install.cjs',
  'tools/repair.cjs',
  'tools/sync-to-dsh.cjs',
  'tools/lib-dsh-home.cjs',
  'tools/lib-atomic-write.cjs',
  'tools/session-probe.cjs',
  'tools/history-audit.cjs',
  'tools/asar-probe.cjs',
];

function main() {
  if (!fs.existsSync(target)) {
    console.error('[sync] 目标目录不存在：' + target);
    console.error('[sync] 先用 node tools/install.cjs 安装一次，或用 --target 指定。');
    process.exit(2);
  }
  if (fs.lstatSync(target).isSymbolicLink()) {
    console.error('[sync] 目标是一个链接：' + target);
    console.error('[sync] DSH 的 profile-resolution 需要**真实目录**（见文件头「为什么需要它」）。');
    process.exit(2);
  }

  const changed = [];
  const added = [];
  const missing = [];
  for (const relative of FILES) {
    const source = path.join(pluginDir, ...relative.split('/'));
    const dest = path.join(target, ...relative.split('/'));
    if (!fs.existsSync(source)) { missing.push(relative); continue; }
    if (!fs.existsSync(dest)) { added.push(relative); continue; }
    if (fs.readFileSync(dest, 'utf8') !== fs.readFileSync(source, 'utf8')) changed.push(relative);
  }

  console.log('[sync] 工作区 : ' + pluginDir);
  console.log('[sync] 目标   : ' + target);
  console.log('[sync] 新增 ' + added.length + ' · 变更 ' + changed.length + ' · 未变 ' + (FILES.length - added.length - changed.length));
  if (missing.length > 0) console.log('[sync] 工作区缺这些文件（跳过）：' + missing.join(', '));

  if (checkOnly || dryRun) {
    for (const f of added) console.log('  + ' + f);
    for (const f of changed) console.log('  ~ ' + f);
    console.log(checkOnly ? '[sync] --check：没有写盘。' : '[sync] --dry-run：没有写盘。');
    process.exit(checkOnly && added.length + changed.length > 0 ? 1 : 0);
  }

  let written = 0;
  for (const relative of added.concat(changed)) {
    const parts = relative.split('/');
    const dest = path.join(target, ...parts);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(pluginDir, ...parts), dest);
    written += 1;
  }
  console.log('[sync] 已写入 ' + written + ' 个文件。');
  if (written > 0) console.log('[sync] 桌面端有模块缓存：**完全退出并重启**后新代码才生效。');
  else console.log('[sync] 两边已经一致，无需重启。');
}

main();
