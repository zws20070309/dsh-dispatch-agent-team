#!/usr/bin/env node
/**
 * emergency-disable.cjs —— 一键把本插件从 profile 的 bundle 列表里摘掉。
 *
 * 什么时候用：打开 DSH 时弹出「应用无法启动或已意外停止 / web boot: N entry did not activate」，
 * 而提示里点名了 `@zws/dsh-dispatch-agent-team`。在**任意终端**执行：
 *
 *   node "<DSH 主目录>\plugins\dsh-dispatch-agent-team\tools\emergency-disable.cjs"
 *
 * 然后重启 DSH。它只做一件事：把本包名从 profile 的 `dsh.profile.bundles` 里移除
 * （会先备份 package.json）。**不删除包、不改你的其它配置**；插件页里仍可再启用。
 *
 *   --profile <dir>    指定 profile（默认 ~/.dsh/profiles/desktop）
 *   --patch-report     只报告 patch 备份情况（**完全只读**）
 *   --restore-patch    用某个 patch 备份覆盖 cordis.patch.yml（危险动作，需显式指定）
 *   --from <序号|文件名>  指定恢复哪一个备份；候选多于一个时**必须**给，否则脚本拒绝执行
 *   --dry-run          只报「会做什么」，不写任何文件
 *   --remove-bundle    显式要求从 bundles 里摘掉本包（与其它开关同用时才需要写）
 *
 * 动作选择（重要，2026-09-28 修）：
 *   * **裸执行**（不带任何上面的开关）= 从 bundles 里摘掉本包 —— 这是应急路径，故意没有二次确认，
 *     因为「DSH 起不来」时用户需要一个能盲敲的命令。它只改 profile 的 package.json，且一定先备份。
 *   * **带了 --patch-report / --restore-patch 时不再顺手摘 bundle**。旧实现做到了「带 --patch-report
 *     也照样摘」——而 README 与本文件的用法说明都写着 --patch-report 不改任何文件，
 *     于是「只想看一眼」会静默禁用插件。这类「文档说不改、实际改了」比功能缺失危险得多。
 *
 * 退出码：0 = 已禁用（或本来就已禁用）；1 = 有问题（例如恢复目标不唯一，未改任何文件）；2 = 环境问题。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
// 注：DSH 主目录的定位在下面经由 tools/lib-dsh-home.cjs 解析（P1-7），不再直接用 os.homedir()。

const PACKAGE_NAME = '@zws/dsh-dispatch-agent-team';
/** 本插件声明的 preset id：如果 selectedDefault 指向它，而我们被禁用，会话创建会失败。 */
const OUR_PRESET_ID = 'dispatch-mode';

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : void 0;
}
// 定位统一走 tools/lib-dsh-home.cjs（P1-7）：应急摘除必须作用在**真正在用**的 profile 上，
// 硬编码 ~/.dsh 会在 DSH_HOME 机器上摘错对象。
const dshHomeModule = require('./lib-dsh-home.cjs');
const dshPaths = dshHomeModule.resolveProfileDir({ explicit: argValue('--profile') });
const profileDir = dshPaths.profileDir;
const patchReport = process.argv.includes('--patch-report');
const restorePatch = process.argv.includes('--restore-patch');
const dryRun = process.argv.includes('--dry-run');
/**
 * 摘 bundle 的条件：**裸执行**（没有任何模式开关）或显式 --remove-bundle。
 * 带 --patch-report / --restore-patch / --dry-run 时默认不动 bundles ——
 * 这三个开关的语义都是「只想看 / 只做这一件事」，顺手禁用插件属于越权。
 */
const modeSwitchGiven = patchReport || restorePatch || dryRun;
const explicitRemove = process.argv.includes('--remove-bundle');
const removeBundle = explicitRemove || !modeSwitchGiven;

if (!fs.existsSync(profileDir)) {
  console.error(`[emergency-disable] profile 目录不存在：${profileDir}`);
  process.exit(2);
}
const pkgPath = path.join(profileDir, 'package.json');
if (!fs.existsSync(pkgPath)) {
  console.error(`[emergency-disable] 找不到 ${pkgPath}`);
  process.exit(2);
}

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
} catch (error) {
  console.error(`[emergency-disable] package.json 不是合法 JSON：${error.message}`);
  process.exit(2);
}

const bundles = pkg?.dsh?.profile?.bundles;
if (!Array.isArray(bundles)) {
  console.error('[emergency-disable] package.json 里没有 dsh.profile.bundles 数组');
  process.exit(2);
}

// ── 1) 报告 selectedDefault 是否指向我们的 preset（会导致「新建会话失败」）────────
const patchPath = path.join(profileDir, 'cordis.patch.yml');
let selectedDefault = '(读不到)';
if (fs.existsSync(patchPath)) {
  const source = fs.readFileSync(patchPath, 'utf8');
  const match = /selectedDefault:\s*(\S+)/u.exec(source);
  selectedDefault = match === null ? '(未设置)' : match[1];
  console.log(`[emergency-disable] cordis.patch.yml 的 selectedDefault = ${selectedDefault}`);
  if (selectedDefault === OUR_PRESET_ID) {
    console.log('');
    console.log(`  注意：selectedDefault 指向本插件的 preset "${OUR_PRESET_ID}"。一旦本插件被禁用，`);
    console.log('     新建会话会报 `agent-preset/not-found: Unknown agent preset: dispatch-mode`。');
    console.log('     请把那一行改成 `selectedDefault: minimal-grayscale`（或删掉该行）。');
    console.log('');
  }
}

// ── 2) 摘掉 bundle（仅在裸执行或显式 --remove-bundle 时）──────────────────────
if (!removeBundle) {
  console.log('');
  console.log('[emergency-disable] 本次带了模式开关，**不动 bundles**（要摘掉本包请裸执行，或加 --remove-bundle）。');
} else if (!bundles.includes(PACKAGE_NAME)) {
  console.log(`[emergency-disable] ${PACKAGE_NAME} 本来就不在 bundles 列表里，无需处理。`);
} else if (dryRun) {
  console.log(`[emergency-disable] --dry-run：本应从 bundles 移除 ${PACKAGE_NAME}（未写任何文件）。`);
} else {
  const backup = `${pkgPath}.bak-${Date.now()}-pre-emergency-disable`;
  fs.copyFileSync(pkgPath, backup);
  const next = bundles.filter((name) => name !== PACKAGE_NAME);
  pkg.dsh.profile.bundles = next;
  // 原子写（tmp + rename）：这个文件坏了 DSH 就起不来，不能就地截断重写（P2-17）。
  try {
    require('./lib-atomic-write.cjs').writeAtomic(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  } catch (error) {
    console.error(`[emergency-disable] 写 package.json 失败（原文件未改动，备份在 ${path.basename(backup)}）：${error.message}`);
    process.exit(2);
  }
  console.log(`[emergency-disable] 已从 bundles 移除 ${PACKAGE_NAME}`);
  console.log(`[emergency-disable] package.json 备份 -> ${path.basename(backup)}`);
  console.log(`[emergency-disable] 现在的 bundles：${next.join(', ')}`);
  console.log('');
  console.log('现在重启 DSH 即可正常启动。想再启用本插件：插件页 → 已安装 → 调度模式智能体团队 → 启用。');
  // 应急场景刻意**不**自动改 cordis.patch.yml（保持「最小动作」），但必须把后果讲清楚（P1-5）：
  // 托管块还留在 profile 层，官方 Agent Teams 的九个团队工具会继续处于被关闭状态。
  console.log('');
  console.log('注意：本工具没有动 profile 的 cordis.patch.yml。如果之前跑过 repair.cjs --apply，');
  console.log('   那段 dispatch-agent-team:managed 托管块仍在生效——它会**继续关闭官方** tool-agent-team 行，');
  console.log('   于是官方 Agent Teams 的九个团队工具在所有 preset 里都不可用。');
  console.log(`   要恢复官方团队：node "${path.join(__dirname, 'repair.cjs')}" --revert --profile "${profileDir}"`);
  console.log('   （或在插件页编辑 profile 的 cordis.patch.yml，删掉 dispatch-agent-team:managed:start 到 :end 之间整段，删前备份。）');
}

// ── 3) 可选的 patch 体检 / 恢复 ──────────────────────────────────────────────
// 备份枚举必须容错：目录里可能有正在被别的进程删掉的文件，statSync 抛错不该把整个
// 应急脚本带崩（这是「DSH 起不来时用的最后一招」，它自己不能崩）。
const backups = [];
for (const name of fs.readdirSync(profileDir)) {
  if (!name.startsWith('cordis.patch.yml.bak')) continue;
  const full = path.join(profileDir, name);
  try {
    const stat = fs.statSync(full);
    backups.push({ name, full, size: stat.size, mtime: stat.mtimeMs });
  } catch {
    /* 枚举期间被删掉：跳过 */
  }
}
backups.sort((a, b) => b.mtime - a.mtime);

const fromArg = argValue('--from');
/** 判据：> 4 KB 的备份才可能是「完整配置」（崩溃恢复重置出来的是空壳）。 */
const candidates = backups.filter((entry) => entry.size > 4096);

if (patchReport || restorePatch) {
  console.log('');
  console.log('[emergency-disable] patch 备份（按时间倒序）：');
  for (const entry of backups.slice(0, 8)) {
    console.log(`  ${String(Math.round(entry.size / 1024)).padStart(5)} KB  ${entry.name}`);
  }
  const liveSize = fs.existsSync(patchPath) ? fs.statSync(patchPath).size : 0;
  console.log(`  当前 cordis.patch.yml 大小：${Math.round(liveSize / 1024)} KB`);
  if (liveSize < 4096 && candidates.length > 0) {
    console.log('');
    console.log('  当前 patch 看起来是被崩溃恢复重置过的空壳，而存在内容完整的备份。');
  }
}

if (restorePatch) {
  // 旧实现是「按 mtime 取第一个 > 4 KB 的备份」直接整份覆盖 —— 本机有 7 个备份，
  // 其中好几个都满足这个条件，选错就把无关的历史配置写回 live 文件，且没有任何提示。
  // 现在：候选多于一个时必须显式 --from 指定，否则拒绝并列出候选（不写盘）。
  let chosen;
  if (fromArg !== undefined) {
    chosen = /^\d+$/u.test(fromArg) ? candidates[Number(fromArg)] : candidates.find((entry) => entry.name === fromArg);
    if (chosen === undefined) {
      console.error('');
      console.error(`[emergency-disable] --from ${fromArg} 不对应任何一个候选备份。候选：`);
      candidates.forEach((entry, index) => console.error(`  [${index}] ${entry.name}`));
      process.exit(2);
    }
  } else if (candidates.length === 1) {
    chosen = candidates[0];
  } else if (candidates.length === 0) {
    console.error('');
    console.error('[emergency-disable] 没有找到任何 > 4 KB 的 patch 备份，无法恢复（不改任何文件）。');
    process.exit(1);
  } else {
    console.error('');
    console.error(`[emergency-disable] 有 ${candidates.length} 个候选备份，无法替你选（不改任何文件）。`);
    console.error('  请显式指定要恢复哪一个：');
    candidates.forEach((entry, index) => console.error(`    [${index}] ${entry.name}  (${Math.round(entry.size / 1024)} KB, ${new Date(entry.mtime).toLocaleString()})`));
    console.error(`  然后运行：node "${__filename}" --restore-patch --from <序号或文件名>`);
    process.exit(1);
  }

  if (dryRun) {
    console.log('');
    console.log(`[emergency-disable] --dry-run：本应使用 ${chosen.name} 覆盖 cordis.patch.yml（未写任何文件）。`);
    process.exit(0);
  }
  const guard = `${patchPath}.bak-${Date.now()}-pre-restore`;
  try {
    if (fs.existsSync(patchPath)) fs.copyFileSync(patchPath, guard);
    // 原子替换：直接 copyFile 覆写 live 文件，中途失败会留下半份 patch（P2-17）。
    require('./lib-atomic-write.cjs').writeAtomic(patchPath, fs.readFileSync(chosen.full, 'utf8'));
  } catch (error) {
    console.error(`[emergency-disable] 恢复失败：${error.message}`);
    process.exit(2);
  }
  console.log('');
  console.log(`  已用 ${chosen.name} 覆盖 cordis.patch.yml（原文件备份 -> ${path.basename(guard)}）`);
  console.log('  注意：如果该备份里 selectedDefault 指向 dispatch-mode，请一并改回 minimal-grayscale。');
}

process.exit(0);
