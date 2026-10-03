#!/usr/bin/env node
/**
 * install.cjs —— 一条命令把本插件装进 DSH **桌面端** profile。
 *
 *   node tools/install.cjs              # 安装
 *   node tools/install.cjs --dry-run    # 只打印将要执行的命令，什么都不改
 *   node tools/install.cjs --uninstall  # 卸载
 *   node tools/install.cjs --cli <路径> # 指定 dsh 可执行文件（默认自动找桌面端自带的那份）
 *   node tools/install.cjs --force      # 明知桌面端在运行仍继续（不推荐）
 *
 * ── 为什么走官方 CLI，而不是自己写 profile 的 package.json ───────────────────
 * `dsh plugin` 就是这件事的**唯一受支持入口**：它把参数原样转给 pnpm 在 profile 目录里跑，
 * 再按「依赖解析到的包有没有声明 `dsh.bundle`」reconcile `dsh.profile.bundles`
 * （@deepseek-ai/dsh 的 lib/bin.js:116-117 的 plugin 子命令，与 lib/plugin-*.js 里的
 * runPlugin / reconcilePlugins）。自己改 package.json 会绕开它的文件锁与 pnpm 步骤。
 *
 * ── 为什么默认用「桌面端自带的那份 dsh」，而不是 PATH 上的 dsh ───────────────
 * 实测（0.2.0-rc.2 本机）：桌面端自带 `resources\runtime\cli\bin\dsh.cmd`，它把调用转给
 * `@deepseek-ai/dsh-desktop-host/lib/cli.js`，而那份 cli 以 `manageDesktopProfile: true`
 * 启动 runCli，因此**允许** `--profile desktop`；它的 packageManager 还指向内置的
 * `runtime\pnpm\bin\pnpm.mjs`，所以连 PATH 里的 pnpm 都不需要。
 * 反过来，PATH 上常见的 `dsh`（npm 全局装的 @deepseek-ai/dsh）是**独立 CLI**，它的 bin.js 里写着
 * `if (profile.toLowerCase() === "desktop") program.error('profile "desktop" is managed
 * exclusively by the Electron application')` —— 用它装桌面端插件必然失败。
 * 所以本脚本按「--cli 指定 → 桌面自带 → PATH」的顺序试，并在失败时说明原因。
 *
 * ── 为什么要求「完全退出桌面端」 ─────────────────────────────────────────────
 * 官方对 desktop profile 的每次操作都在 `withFileLock(<profile>/package.json)` 里跑 pnpm，
 * 它自己的提示原文是「Open DeepSeek Harness Desktop once to initialize its profile, then fully
 * quit it before running dsh plugin --profile desktop.」。运行中的实例已加载旧一代模块，
 * 边跑边装会出现「profile 已改、内存里还是旧组合」的错配。因此动手前先检测进程，检出就拒绝。
 *
 * 退出码：0 成功 / 1 失败 / 2 环境不满足（找不到 CLI、桌面端在运行、profile 不存在）。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const PACKAGE_NAME = '@zws/dsh-dispatch-agent-team';
const pluginDir = path.resolve(__dirname, '..');

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : void 0;
}

const dryRun = process.argv.includes('--dry-run');
const uninstall = process.argv.includes('--uninstall');
const force = process.argv.includes('--force');
const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? path.resolve(process.env.DSH_HOME.trim())
  : path.join(os.homedir(), '.dsh');
const profileDir = path.join(dshHome, 'profiles', 'desktop');

function die(message, code = 1) {
  console.error(`[install] ${message}`);
  process.exit(code);
}

/** 按优先级给出可尝试的 dsh 入口。 */
function candidateClis() {
  const out = [];
  const explicit = argValue('--cli');
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const file = path.resolve(explicit.trim());
    if (!fs.existsSync(file)) die(`--cli 指定的文件不存在：${file}`, 2);
    out.push({ kind: 'explicit', label: '--cli 指定的 dsh', file });
    return out;
  }
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  out.push({
    kind: 'desktop',
    label: '桌面端自带的 dsh（能管 desktop profile）',
    file: path.join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
  });
  out.push({ kind: 'path', label: 'PATH 上的 dsh', file: process.platform === 'win32' ? 'dsh.cmd' : 'dsh' });
  return out;
}

/** 桌面端是否在运行。查不到就返回 false（宁可让官方 CLI 自己去报锁冲突）。 */
function desktopRunning() {
  if (process.platform !== 'win32') return false;
  const probe = spawnSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], { encoding: 'utf8' });
  if (probe.error !== undefined && probe.error !== null) return false;
  return String(probe.stdout ?? '').toLowerCase().includes('deepseek harness.exe');
}

if (uninstall) {
  console.log(`[install] 卸载 ${PACKAGE_NAME}`);
} else {
  const sourceManifest = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
    } catch (error) {
      return die(`读不到本包 package.json（本脚本必须待在本插件目录内跑）：${error.message}`);
    }
  })();
  if (sourceManifest.name !== PACKAGE_NAME) {
    die(`本包 name 是 "${String(sourceManifest.name)}"，与安装器期望的 ${PACKAGE_NAME} 不一致`);
  }
  // 官方判定 bundle 的唯一硬条件（dsh-app-boot 读 dsh.bundle.patch；缺了会被当普通依赖并告警）。
  if (sourceManifest.dsh?.bundle?.patch === undefined) {
    die('本包 package.json 没声明 dsh.bundle.patch —— 官方 loader 不会把它当 profile 层');
  }
  console.log(`[install] 插件目录：${pluginDir}`);
}

if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
  die(`找不到桌面端 profile：${profileDir}\n[install] 先启动一次 DSH 桌面端（它会创建 profile），或用 DSH_HOME 指定主目录。`, 2);
}
if (desktopRunning() && !dryRun && !force) {
  die('检测到 DSH 桌面端正在运行。官方要求先完全退出它再操作 desktop profile。\n[install] 退出桌面端后重跑；确认要强行继续就加 --force。', 2);
}
if (desktopRunning() && dryRun) {
  console.warn('[install] 提示：桌面端正在运行。真跑（去掉 --dry-run）前需要先完全退出它，或加 --force。');
}

// 本地目录 spec 必须是绝对路径（官方 install-spec 明确拒绝相对路径）；卸载用包名。
const pnpmArgs = uninstall ? ['remove', PACKAGE_NAME] : ['add', pluginDir];
const attempts = candidateClis();
let lastFailure = '没有可用的 dsh 入口';

for (const candidate of attempts) {
  const args = ['plugin', '--profile', 'desktop', ...pnpmArgs];
  const quoted = args.map((item) => (/\s/.test(item) ? `"${item}"` : item));
  const isCmdFile = /\.cmd$/i.test(candidate.file);
  const display = isCmdFile ? `"${candidate.file}" ${quoted.join(' ')}` : [candidate.file, ...args].join(' ');
  console.log(`[install] 用${candidate.label}：`);
  console.log(`  ${display}`);
  if (dryRun) {
    console.log('[install] --dry-run：未执行任何命令，什么都没改。');
    process.exit(0);
  }
  // .cmd 必须经 cmd.exe 启动（Node 出于安全不再直接 spawn .cmd）；其余直接 spawn。
  const result = isCmdFile
    ? spawnSync(display, { stdio: 'inherit', shell: true })
    : spawnSync(candidate.file, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  const missing = result.error !== undefined && result.error !== null && result.error.code === 'ENOENT';
  const status = missing ? 127 : (result.status ?? 1);
  if (status === 0) {
    console.log('[install] 官方 plugin 命令成功：依赖与 dsh.profile.bundles 都由它维护。');
    lastFailure = '';
    break;
  }
  lastFailure = missing ? `找不到可执行文件：${candidate.file}` : `退出码 ${status}`;
  console.warn(`[install] 该入口失败（${lastFailure}）。`);
  if (candidate.kind === 'path') {
    console.warn('[install] 若报的是「profile "desktop" is managed exclusively by the Electron application」：');
    console.warn('[install] 那是 PATH 上的独立 CLI 的固有门禁，与插件无关。改用桌面端自带的那份 dsh.cmd（本脚本默认就试它），');
    console.warn('[install] 或在界面里装：插件 → 已安装 → 添加插件 → 填绝对路径。');
  }
}

if (lastFailure !== '') {
  die(`所有 dsh 入口都失败了（最后一次：${lastFailure}）。\n[install] 兜底：界面安装 —— 插件 → 已安装 → 添加插件 → 填 ${pluginDir}`);
}

// 官方 reconcile **不管**的两件硬前置（包内依赖 junction、profile 层的工具行关闭与容量）交给 repair。
const repairPath = path.join(pluginDir, 'tools', 'repair.cjs');
if (!uninstall && fs.existsSync(repairPath)) {
  console.log('[install] 跑 tools/repair.cjs --apply');
  const repaired = spawnSync(process.execPath, [repairPath, '--apply', '--profile', profileDir], { stdio: 'inherit' });
  if ((repaired.status ?? 1) !== 0) {
    console.warn('[install] repair.cjs 没有全绿：按它打印的提示处理，否则插件可能起不来、或 8 次 spawn 后派不出人。');
  }
}

console.log('');
console.log(uninstall
  ? '[install] 卸载完成。重启 DSH 桌面端后生效。'
  : [
    '[install] 安装完成。接下来：',
    '  1) **重启 DSH 桌面端**（host 侧模块不热替换）。',
    '  2) 插件 → 已安装 里应出现「调度模式智能体团队」；推理模式选择器里应出现「调度模式」。',
    '  3) 只读体检：node tools/repair.cjs && node tools/drift-check.cjs',
    '  4) 新建会话、推理模式选「调度模式」，打 /team 开团队。',
  ].join('\n'));
