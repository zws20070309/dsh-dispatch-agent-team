#!/usr/bin/env node
/**
 * repair.cjs —— 安装状态体检与修复（应对「崩溃恢复」把 profile 重置的情况）
 *
 * 背景（有代码依据）：
 *   * DSH 桌面每次启动只在 profile 的 cordis.patch.yml **不存在时**才创建它，
 *     崩溃恢复对话框里的 disableAllPlugins() 则会把这个 patch **改名**成
 *     cordis.patch.yml.bak-<epoch>，并把 dsh.profile.bundles 重置成 shipped 模板。
 *   * 本插件的 preset 与行覆盖由**自己的 bundle patch** 承载；
 *     **但域服务的容量参数（agent-team 的 maxMembers 等）必须落在 profile 的 patch 层**：
 *     patch 按 dsh.profile.bundles 顺序应用，而官方 agent-team bundle 用 `insert` 新建那三行，
 *     我们的 bundle 若排在它之前，`- id: agent-team, config:` 就落在还不存在的行上、**静默失效**
 *     （2026-09-28 实测：maxMembers 被官方默认值 8 顶掉，8 次 spawn 后团队派不出人）。
 *     profile 的 cordis.patch.yml 在**所有 bundle 层之后**应用（dsh-app-boot 的 readProfilePatches），
 *     所以这一层的覆盖一定生效。见 README §8.6 与 INTERFACES 勘误表第 25 条。
 *
 * 用法：
 *   node tools/repair.cjs                      # 只体检，不改任何文件
 *   node tools/repair.cjs --apply              # 缺什么补什么（会先备份 package.json / cordis.patch.yml）
 *   node tools/repair.cjs --profile <dir>
 *
 * 退出码：0 = 状态完好；1 = 有问题（--apply 下若已修复则 0）；2 = 环境问题。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PACKAGE_NAME = '@zws/dsh-dispatch-agent-team';

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : void 0;
}
const apply = process.argv.includes('--apply');
const profileDir = argValue('--profile') || path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
const pluginDir = path.resolve(__dirname, '..');

console.log(`[repair] profile   : ${profileDir}`);
console.log(`[repair] plugin dir: ${pluginDir}`);
console.log(`[repair] mode      : ${apply ? 'APPLY（会写文件）' : '只读体检'}`);
console.log('');

const problems = [];
const notes = [];

// 1) profile 存在吗
if (!fs.existsSync(profileDir)) {
  console.error(`[repair] profile 目录不存在：${profileDir}`);
  process.exit(2);
}

// 2) 本包是否已装进 profile 的 node_modules（pnpm 安装产物）
const installedDir = path.join(profileDir, 'node_modules', ...PACKAGE_NAME.split('/'));
const installed = fs.existsSync(path.join(installedDir, 'package.json'));
console.log(`- 本包在 profile 的 node_modules：${installed ? '是' : '否'}`);
if (!installed) {
  problems.push(`本包未安装到 ${installedDir}。请用插件页「添加插件」或 plugin_manager 的 install_bundle，spec 用绝对路径 ${pluginDir}`);
}

// 3) 是否被 pnpm 以本地路径安装，且装的是不是我们这份源码
if (installed) {
  let installedVersion = '?';
  try {
    installedVersion = JSON.parse(fs.readFileSync(path.join(installedDir, 'package.json'), 'utf8')).version;
  } catch { /* 读不到就记为 ? */ }
  // 源码 package.json 也可能坏掉/缺失：不许抛栈（本脚本承诺 2 = 环境问题）。
  let sourceVersion = '?';
  try {
    sourceVersion = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8')).version;
  } catch (error) {
    console.error(`[repair] 读不到源码 package.json 的 version：${error.message}`);
    process.exit(2);
  }
  console.log(`- 已装版本 / 源码版本：${installedVersion} / ${sourceVersion}`);
  if (installedVersion !== sourceVersion) {
    notes.push(`版本不一致：profile 里是 ${installedVersion}，源码是 ${sourceVersion}。改完源码要重新安装（或改完直接改 profile 里的那份并刷新页面）。`);
  }
  // link:/junction 安装时上面两行读的是**同一个文件**，比较恒等 → 这里额外报一次真实路径，
  // 免得「版本一致」被误读成「profile 里那份就是我这份源码」。
  try {
    const realInstalled = fs.realpathSync(path.join(installedDir, 'package.json'));
    const realSource = fs.realpathSync(path.join(pluginDir, 'package.json'));
    console.log(`- 安装方式是同一份文件：${realInstalled === realSource ? '是（link/junction）' : `否（profile=${realInstalled}）`}`);
  } catch { /* realpath 失败不影响体检结论 */ }
}

// 4) bundles 列表里有没有本包
const profilePkgPath = path.join(profileDir, 'package.json');
if (!fs.existsSync(profilePkgPath)) {
  console.error(`[repair] 找不到 ${profilePkgPath}`);
  process.exit(2);
}
let profilePkg;
try {
  profilePkg = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'));
} catch (error) {
  console.error(`[repair] profile package.json 不是合法 JSON：${error.message}`);
  process.exit(2);
}
const bundles = profilePkg?.dsh?.profile?.bundles;
if (!Array.isArray(bundles)) {
  problems.push('profile package.json 里没有 dsh.profile.bundles 数组');
} else {
  const has = bundles.includes(PACKAGE_NAME);
  console.log(`- 在 dsh.profile.bundles 里：${has ? '是' : '否'}`);
  console.log(`- 当前 bundles：${bundles.join(', ')}`);
  if (!has) {
    problems.push(`dsh.profile.bundles 缺少 ${PACKAGE_NAME}`);
    if (apply) {
      const backup = `${profilePkgPath}.bak-${Date.now()}-pre-dispatch-team-repair`;
      fs.copyFileSync(profilePkgPath, backup);
      bundles.push(PACKAGE_NAME);
      fs.writeFileSync(profilePkgPath, `${JSON.stringify(profilePkg, null, 2)}\n`, 'utf8');
      console.log(`  → 已追加并备份到 ${path.basename(backup)}`);
      problems.pop();
    }
  }
  // 官方 agent-team bundle 是否还在（我们的域服务复用它）
  const OFFICIAL = '@deepseek-ai/dsh-experimental-agent-team-profile';
  if (!bundles.includes(OFFICIAL)) {
    notes.push(`官方 ${OFFICIAL} 不在 bundles 里。本插件的 cordis.patch.yml 假定它的 agent-team 域服务行处于启用状态；` +
      `若确实要移除官方 bundle，需要把 agent-team 行自己 insert 进我们的 cordis.patch.yml。`);
  }
}

// 4.5) profile 层必须有的两段覆盖（顺序无关的生效落点）：
//   (1) `tool-agent-team` 必须 **disabled**；
//   (2) `agent-team` 的容量必须放大。
// 两件事都必须写在这一层，理由见文件头与 README §8.6/§8.7。
const PROFILE_PATCH = path.join(profileDir, 'cordis.patch.yml');
/** 与 cordis.patch.yml 里的值必须一致（drift-check 也校验这两份相等）。 */
const AGENT_TEAM_CONFIG = {
  maxMembers: 48,
  maxTasks: 512,
  maxPendingMessagesPerMember: 64,
  maxMessageBytes: 65536,
  disposalTimeoutMs: 5000,
};
const MANAGED_START = '# ── dispatch-agent-team:managed:start（由 tools/repair.cjs 维护，勿手改）──';
const MANAGED_END = '# ── dispatch-agent-team:managed:end ──';
const MANAGED_BLOCK = [
  MANAGED_START,
  '# 为什么这两条必须写在这一层：bundle 的 patch 按 dsh.profile.bundles 顺序应用，官方',
  '# agent-team-profile 用 `insert` 新建这三行；我们的 bundle 排在它之前时，针对这些行的',
  '# 覆盖会**静默失效**（2026-09-28 实测）。本文件在所有 bundle 层之后应用，顺序无关。',
  '#',
  '# 为什么必须关掉官方工具行：官方 `tool-agent-team` 给**每一个** live agent 都装九个团队工具',
  '# （dsh-experimental-tool-agent-team/lib/index.js:539-546 的 maybeInstall；tryMembership 对任意',
  '# 非子代理 agent 都返回 lead 身份 :420-426），而本插件在**同一个 agent 作用域**注册同样的九个',
  '# 名字 → `tool "x" is already registered in this scope`，本插件的工具装不上，角色/模型参数丢失。',
  '- id: tool-agent-team',
  '  disabled: true',
  '',
  ...['- id: agent-team', '  config:', ...Object.entries(AGENT_TEAM_CONFIG).map(([key, value]) => `    ${key}: ${value}`)],
  MANAGED_END,
].join('\n');

if (!fs.existsSync(PROFILE_PATCH)) {
  console.log(`- profile patch：不存在（${PROFILE_PATCH}）`);
  problems.push(`profile 缺 ${path.basename(PROFILE_PATCH)}：容量覆盖与官方工具行关闭都没地方落`);
} else {
  const patchText = fs.readFileSync(PROFILE_PATCH, 'utf8');
  // (1) 官方工具行是否被关掉
  const toolRowDisabled = /-\s*id:\s*tool-agent-team\s*\n\s*disabled:\s*true/u.test(patchText);
  console.log(`- profile 层关闭官方 tool-agent-team 行：${toolRowDisabled ? '是' : '**否**'}`);
  // (2) 容量覆盖是否齐备（抓 `- id: agent-team` 之后紧跟的 config 块）
  const match = /-\s*id:\s*agent-team\s*\n\s*config:\s*\n((?:\s{4}\w+:.*\n?)+)/u.exec(patchText);
  const effective = {};
  if (match !== null) {
    for (const line of match[1].split('\n')) {
      const pair = /^\s*(\w+):\s*(\d+)\s*$/u.exec(line);
      if (pair !== null) effective[pair[1]] = Number(pair[2]);
    }
  }
  const missing = Object.entries(AGENT_TEAM_CONFIG).filter(([key, value]) => effective[key] !== value);
  console.log(`- profile 层 agent-team 容量覆盖：${missing.length === 0 ? '齐备' : `缺/不一致 ${missing.map(([key]) => key).join(', ')}`}`);

  if (!toolRowDisabled || missing.length > 0) {
    const why = [
      toolRowDisabled ? '' : '官方 tool-agent-team 行还开着：它会把九个同名工具装进每个会话的 agent 作用域，本插件的工具装不上（角色/模型参数不可用）',
      missing.length === 0 ? '' : `agent-team 容量缺/不一致（${missing.map(([key, value]) => `${key} 应为 ${value}，实际 ${effective[key] ?? '缺'}`).join('；')}）：顺序不利时 maxMembers 会退回官方默认 8，团队 8 次 spawn 后派不出人`,
    ].filter((line) => line !== '').join('；');
    if (apply) {
      const backup = `${PROFILE_PATCH}.bak-${Date.now()}-pre-dispatch-team-managed`;
      fs.copyFileSync(PROFILE_PATCH, backup);
      // 有哨兵 → 整段替换；有旧的裸 agent-team 块 → 替换它并补上工具行；都没有 → 追加。
      let next;
      const start = patchText.indexOf(MANAGED_START);
      const end = patchText.indexOf(MANAGED_END);
      if (start >= 0 && end > start) {
        next = patchText.slice(0, start) + MANAGED_BLOCK + patchText.slice(end + MANAGED_END.length);
      } else if (match !== null) {
        // ⚠️ 必须补一个换行：`match[0]` 已经把那一行的结尾换行吃掉了，不补的话下一行会被
        // 我们块尾的注释吞掉（2026-09-28 实际发生过：`ui-skin-claude-style` 那一行被注释掉）。
        next = patchText.replace(match[0], `${MANAGED_BLOCK}\n`);
      } else {
        next = `${patchText.replace(/\s*$/u, '')}\n\n${MANAGED_BLOCK}\n`;
      }
      fs.writeFileSync(PROFILE_PATCH, next, 'utf8');
      // 写完立刻自检：解析一遍，确认块尾没有把下一行粘进注释里。
      const reparsed = next.split('\n').some((line) => line.includes(MANAGED_END) && line.trim() !== MANAGED_END);
      console.log(reparsed
        ? '  ⚠️ 自检：managed 块尾与下一行粘在一起了，请把这段贴给 lead'
        : '  → 自检：managed 块尾换行正常');
      console.log(`  → 已写入并备份到 ${path.basename(backup)}`);
    } else {
      problems.push(`${why}。加 --apply 可自动补齐（会先备份）。`);
    }
  }
}

// 5) 崩溃恢复痕迹
const backups = fs.existsSync(profileDir)
  ? fs.readdirSync(profileDir).filter((name) => name.startsWith('cordis.patch.yml.bak-'))
  : [];
if (backups.length > 0) {
  notes.push(`发现 ${backups.length} 个崩溃恢复备份：${backups.join(', ')}。` +
    `profile 层的 patch 会被崩溃恢复改名（上面的容量检查就是查它）；bundles 若被重置，第 4 项会报出来。`);
}

// 5.5) 运行时的**有效**状态（状态文件由 host 半在启动时写）：这是唯一能证明
// 「patch 真的生效了」而不是「我们的 patch 文件里写了」的证据。
const statusPath = path.join(path.dirname(path.dirname(profileDir)), 'dispatch-agent-team-status.json');
try {
  if (fs.existsSync(statusPath)) {
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    const rows = Array.isArray(status.rows) ? status.rows : [];
    const agentTeam = rows.find((row) => row?.id === 'agent-team');
    const officialToolRow = rows.find((row) => row?.id === 'tool-agent-team');
    console.log(`- 状态文件：${path.basename(statusPath)}（${status.generatedAt ?? '无时间戳'}）`);
    if (agentTeam !== undefined) {
      const capacity = agentTeam.maxMembers;
      console.log(`- 运行时 agent-team 有效 maxMembers：${capacity ?? '(状态文件里没有：DSH 需要在本次修复后重启一次)'}`);
      if (typeof capacity === 'number' && capacity < AGENT_TEAM_CONFIG.maxMembers) {
        notes.push(`运行时 maxMembers=${capacity} 小于本插件需要的 ${AGENT_TEAM_CONFIG.maxMembers}：` +
          '说明容量覆盖还没落到运行时（改完 profile patch 需要**重启 DSH**），或者还有更靠后的层把它顶掉了。');
      }
    }
    if (officialToolRow !== undefined) {
      // 这是「官方九工具会不会占住 agent 作用域」的运行时判据。
      console.log(`- 运行时官方 tool-agent-team 行：${officialToolRow.disabled === true ? '已关闭（正确）' : '**仍启用** —— 本插件的九个工具装不上，角色/模型参数不可用'}`);
      if (officialToolRow.disabled !== true) {
        notes.push('运行时官方 tool-agent-team 行仍启用：改完 profile patch 需要**重启 DSH** 才会生效。');
      }
    }
  } else {
    console.log('- 状态文件：还没生成（DSH 启动时会写 ~/.dsh/dispatch-agent-team-status.json）');
  }
} catch (error) {
  notes.push(`读状态文件失败（不影响其余体检）：${error.message}`);
}

// 6) 依赖解析接线：本包被 pnpm 以 `link:` 安装时，Node 会解析到**真实路径**
//    （~/.dsh/plugins/dsh-dispatch-agent-team），从那里向上找不到任何含
//    @deepseek-ai/dsh-tools 的 node_modules —— 静态 import 会在模块加载期崩，
//    host 行起不来（这正是首次安装时报 "failed to import" 的原因）。
//    修法：在包内放一个 node_modules junction 指向 <dshHome>/profiles/node_modules
//    （本 profile 里真实跑通的第三方插件 某个第三方插件 走的是同一条 walk-up）。
const homeDir = path.dirname(path.dirname(profileDir));
const junctionPath = path.join(pluginDir, 'node_modules');
const junctionTarget = path.join(homeDir, 'profiles', 'node_modules');
let junctionOk = false;
try {
  const stat = fs.lstatSync(junctionPath);
  const target = fs.readlinkSync(junctionPath);
  junctionOk = stat.isSymbolicLink() && path.resolve(target) === path.resolve(junctionTarget);
  if (junctionOk) {
    console.log(`- 依赖解析 junction：${junctionPath} -> ${target}`);
  } else {
    console.log(`- 依赖解析 junction 指向了别处：${target}（期望 ${junctionTarget}）`);
  }
} catch {
  console.log(`- 依赖解析 junction：缺失（${junctionPath}）`);
}
if (!junctionOk) {
  if (apply) {
    try {
      fs.symlinkSync(junctionTarget, junctionPath, 'junction');
      console.log(`  → 已创建 junction -> ${junctionTarget}`);
      junctionOk = true;
    } catch (error) {
      problems.push(`创建依赖解析 junction 失败：${error.message}。手动执行：` +
        `New-Item -ItemType Junction -Path "${junctionPath}" -Target "${junctionTarget}"`);
    }
  } else {
    problems.push(`缺少依赖解析 junction。手动执行：` +
      `New-Item -ItemType Junction -Path "${junctionPath}" -Target "${junctionTarget}"`);
  }
}
// 真实解析一次，证明 import 不会再在加载期崩。
if (junctionOk) {
  try {
    const { createRequire } = require('node:module');
    const req = createRequire(path.join(pluginDir, 'lib', 'tools.js'));
    const resolved = req.resolve('@deepseek-ai/dsh-tools');
    console.log(`- @deepseek-ai/dsh-tools 解析到：${resolved}`);
  } catch (error) {
    problems.push(`依赖仍不可解析（${error.code || error.message}）：host 行会在 import 阶段失败`);
  }
}

// 7) 本包自检：**每一个会被 loader 加载的模块**都要在清单里。
//    旧清单只有 6 个文件，漏了 runtime/tools/roster/playbook 与 locale/en.json ——
//    缺了核心模块它照样打印「状态完好」，等于一条假绿灯。
for (const relative of [
  'package.json',
  'cordis.patch.yml',
  'presets/dispatch-mode.patch.yml',
  'icon.svg',
  'locale/zh.json',
  'locale/en.json',
  'lib/index.js',
  'lib/preset.js',
  'lib/runtime.js',
  'lib/tools.js',
  'lib/roster.js',
  'lib/playbook.js',
  'lib/client.js',
  'tools/drift-check.cjs',
  'tools/selftest.cjs',
  'tools/integration-test.cjs',
  'tools/client-smoke-test.cjs',
  'tools/emergency-disable.cjs',
]) {
  const file = path.join(pluginDir, relative);
  if (!fs.existsSync(file)) problems.push(`本包缺文件：${relative}`);
}
console.log('');

// ── 结论 ─────────────────────────────────────────────────────────────────────
if (notes.length > 0) {
  console.log('提示：');
  for (const note of notes) console.log(`  * ${note}`);
  console.log('');
}
if (problems.length === 0) {
  console.log('状态完好。');
  process.exit(0);
}
console.log('问题：');
for (const problem of problems) console.log(`  ! ${problem}`);
console.log('');
if (!apply) console.log('加 --apply 可自动修复「bundles 列表缺失」与「profile 层 agent-team 容量覆盖」这两类问题（其余需要按提示手动处理）。');
process.exit(1);