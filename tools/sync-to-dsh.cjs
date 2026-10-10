#!/usr/bin/env node
/**
 * sync-to-dsh.cjs —— 把本工作区的改动同步到 DSH 实际加载的那份插件目录。
 *
 * ── 2026-10-09 重要更新：现在推荐 **junction 模式**，本脚本退化为兜底 ──────────
 *
 * 用户要求「不要粘贴一份源码在 .dsh\plugins，要从 D:\Desktop\插件\... 链接过去」。
 * 我按官方代码逐条核实后确认**可行**（此前的「不可行」结论已过时）：
 *
 *   官方 dsh-app-boot 有专门的 linked-root 机制，为「链接进来的插件」服务：
 *     * lib/index.js:629 `linkedProfileRoots(profile, profilesDir)` —— 扫描
 *       `<profile.dir>/node_modules` 下的**链接**，解析 realPath 后登记为 linkedRoots
 *       （排除 profiles 树内部的链接；缺失目标会被跳过）。
 *     * lib/index.js:80 `linkedPaths = linkedRoots.flatMap(root => prefixes(root.realPath))`
 *       —— `prefixes()` 同时返回原始路径与 realpath，两者都算合法前缀。
 *     * worker/profile-resolution-bootstrap.js:101 `findInterceptionLayer`：
 *       `if (!startsWithin(path, resolution.linkedPaths)) return void 0;` → 命中则
 *       返回 `{kind:'linked'}`，由 `:306 routeLinked` 走链接专用路由。
 *
 *   也就是说：**realpath 解析到 profile 之外不再是问题** —— 只要那个路径被登记进
 *   linkedRoots（由 profile/node_modules 下的链接自动产生），官方就认。
 *
 *   实测（.probe/verify-junction-loading.cjs 逐条复刻官方算法）：
 *     ✅ 本插件已登记为 linkedRoot：@zws/dsh-dispatch-agent-team → D:\Desktop\插件\...
 *     ✅ 插件入口命中 linkedPaths（官方会给它拦截层）
 *     ✅ 包内 node_modules junction → profiles\node_modules，@deepseek-ai/dsh-tools 可达
 *
 *   两层链接的完整形态（改完目录结构后 repair.cjs 体检「状态完好」）：
 *     profiles\desktop\node_modules\@zws\dsh-dispatch-agent-team   ← 官方登记层
 *       → C:\Users\ZWS\.dsh\plugins\dsh-dispatch-agent-team
 *           → D:\Desktop\插件\dsh-dispatch-agent-team              ← 源码（本仓库）
 *
 *   所以现在**改代码不需要跑同步**：DSH 直接读的就是这份源码目录。
 *   本脚本保留给两种场景：① 万一退回「复制模式」；② `--check` 快速核对两边一致性。
 *
 * ── 旧结论（保留作历史，已被上面的实测推翻）─────────────────────────────────
 * 早期版本记录：「把 .dsh\plugins\<包名> 做成 junction 指向工作区不可行 —— realpathSync
 * 会解析到 profile 之外，拦截路由不生效」。那是**官方加 linkedRoots 之前**的事实；
 * 现在官方专门为这种用法开了 linked 路由。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────────
 *   node tools/sync-to-dsh.cjs            # 同步（仅复制模式需要；junction 模式下是空操作）
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
  'lib/text-clip.js',
  'lib/graph.js',
  'lib/client.js',
  'lib/self-heal.js',
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
  // 下面两个是 package.json 的 files 里声明的文档，正式安装时也会被拷进去；
  // 少了它们，已安装副本里会留着一份**过期的 README**，看起来像源码没同步成功。
  'README.md',
  'INTERFACES.md',
];

function main() {
  if (!fs.existsSync(target)) {
    console.error('[sync] 目标目录不存在：' + target);
    console.error('[sync] 先用 node tools/install.cjs 安装一次，或用 --target 指定。');
    process.exit(2);
  }
  // junction 模式：目标就是本仓库自己（或指向它）⇒ 无需同步，直接报告。
  // 见文件头「2026-10-09 重要更新」：官方 linkedRoots 机制让 junction 成为**推荐**形态。
  let targetReal = null;
  try { targetReal = fs.realpathSync(target); } catch { /* */ }
  let selfReal = null;
  try { selfReal = fs.realpathSync(pluginDir); } catch { /* */ }
  if (targetReal !== null && selfReal !== null && targetReal === selfReal) {
    console.log('[sync] 工作区 : ' + pluginDir);
    console.log('[sync] 目标   : ' + target);
    console.log('[sync] 目标就是本仓库（junction 模式）——DSH 直接读这份源码，**无需同步**。');
    if (checkOnly || dryRun) console.log('[sync] --check：两边是同一个目录，差异 0。');
    process.exit(0);
  }
  // 目标是指向**别处**的链接：可能是别人手建的 junction，也可能指向另一个工作区。
  // 不直接拒绝（旧的硬拒绝已过时），但要说清两边关系，避免误同步到意外位置。
  if (fs.lstatSync(target).isSymbolicLink()) {
    console.log('[sync] 注意：目标是链接 → ' + String(fs.readlinkSync(target)));
    console.log('[sync] 它指向的不是本仓库；下面按「复制模式」比较并写入该目标。');
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
