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
 *     所以这一层的覆盖一定生效。见 MAINTAINER-NOTES.md §8.6 与 INTERFACES 勘误表第 25 条。
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

const PACKAGE_NAME = '@zws/dsh-dispatch-agent-team';

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : void 0;
}

// 原子写（tmp + rename）：tools/ 里唯一的实现，emergency-disable.cjs 共用（P2-17）。
const { writeAtomic } = require('./lib-atomic-write.cjs');
const apply = process.argv.includes('--apply');
/** 回收模式：删掉本插件写进 profile 的托管块，把官方 tool-agent-team 行与容量还给用户。 */
const revert = process.argv.includes('--revert');
// DSH 主目录/profile 的定位统一走 tools/lib-dsh-home.cjs（P1-7：以前这里硬编码
// ~/.dsh/profiles/desktop，设置了 DSH_HOME 的机器上 --apply 会把托管块写进错的 profile）。
const dshPaths = require('./lib-dsh-home.cjs').resolveProfileDir({ explicit: argValue('--profile') });
const profileDir = dshPaths.profileDir;
const pluginDir = path.resolve(__dirname, '..');

console.log(`[repair] profile   : ${require('./lib-dsh-home.cjs').describeSource(dshPaths)}`);
console.log(`[repair] plugin dir: ${pluginDir}`);
console.log(`[repair] mode      : ${revert ? 'REVERT（回收 profile 层托管块，会写文件）' : apply ? 'APPLY（会写文件）' : '只读体检'}`);
console.log('');

// 托管块的常量定义在这里（revert 早退分支与下方 --apply 分支共用）。
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

/**
 * 本包**会被加载/执行**的文件清单（源码目录与已安装副本都要查，见第 7 节）。
 *
 * 2026-10-04 审查 P1-3/子代理复审补：旧清单漏了 lib/cache.js 与 lib/resume.js ——
 * 两者都被 lib/runtime.js 静态 import（:53、:55-61），缺了会让 host 行在加载期崩，
 * 而这一节恰恰是来防这件事的；tools/lib-dsh-home.cjs 是 repair/drift-check/
 * emergency-disable/install 四个脚本共用的定位模块，缺了它们全部直接抛栈。
 */
const PACKAGE_FILES = [
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
  'lib/cache.js',
  'lib/resume.js',
  'lib/text-clip.js',
  'lib/client.js',
  'tools/drift-check.cjs',
  'tools/selftest.cjs',
  'tools/integration-test.cjs',
  'tools/client-smoke-test.cjs',
  'tools/emergency-disable.cjs',
  'tools/install.cjs',
  'tools/repair.cjs',
  'tools/lib-dsh-home.cjs',
  'tools/lib-atomic-write.cjs',
  'tools/session-probe.cjs',
  'tools/history-audit.cjs',
  'tools/asar-probe.cjs',
];

const problems = [];
const notes = [];

// 1) profile 存在吗
if (!fs.existsSync(profileDir)) {
  console.error(`[repair] profile 目录不存在：${profileDir}`);
  process.exit(2);
}

// 1.5) --revert：回收本插件写进 profile 的托管块（2026-10-04 审查 P1-5）。
//      为什么必须有这条路：--apply 会写「关闭官方 tool-agent-team 行 + agent-team 容量覆盖」，
//      而官方 bundle 用 insert 新建那三行——一旦本插件被卸载/应急禁用，托管块留在 profile 里
//      继续生效，官方九个团队工具就在**所有 preset** 里永久静默消失，用户没有任何对称的回收入口。
//      revert 只干「删托管块」这一件事然后就结束：bundles/依赖/文件清单那些检查在卸载语境下
//      没有意义（bundles 里没有本包恰是预期结果）。
//      没有哨兵块时是幂等空操作（exit 0），所以 install --uninstall 可以无条件串跑它。
if (revert) {
  if (!fs.existsSync(PROFILE_PATCH)) {
    console.log('- profile patch 不存在：无需回收');
    process.exit(0);
  }
  const patchText = fs.readFileSync(PROFILE_PATCH, 'utf8');
  const start = patchText.indexOf(MANAGED_START);
  const end = patchText.indexOf(MANAGED_END);
  if (start < 0 || end <= start) {
    console.log('- 未发现 dispatch-agent-team 托管块：无需回收（官方工具行未被本插件关过，或已回收/手工处理）');
    process.exit(0);
  }
  // 删哨兵包住的整段；块前/块后各自折叠多余空行，不碰别的行。
  // （哨兵外若还留着 2026-09-28 之前旧版写入的裸注释头，那是 YAML 注释、无害，不越权删。）
  const head = patchText.slice(0, start).replace(/(?:\n[ \t]*)+$/u, '\n');
  const tail = patchText.slice(end + MANAGED_END.length).replace(/^(?:\n[ \t]*)+/u, '\n');
  const next = `${head}${tail}`;
  const backup = `${PROFILE_PATCH}.bak-${Date.now()}-pre-dispatch-team-revert`;
  try {
    fs.copyFileSync(PROFILE_PATCH, backup);
    writeAtomic(PROFILE_PATCH, next);
  } catch (error) {
    console.error(`[repair] 回收失败（已保留原文件，备份在 ${backup}）：${error.message}`);
    process.exit(1);
  }
  console.log(`- 已回收 profile 层托管块（关官方 tool-agent-team 行 + agent-team 容量覆盖），备份：${path.basename(backup)}`);
  console.log('  重启 DSH 后，官方 Agent Teams 的九个团队工具在所有 preset 里恢复。');
  process.exit(0);
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
    const sameFile = realInstalled === realSource;
    console.log(`- 安装方式是同一份文件：${sameFile ? '是（link/junction）' : `否（profile=${realInstalled}）`}`);
    if (!sameFile) {
      // 这是「改源码不会生效」的实锤（2026-10-04 审查 P1-3：宿主跑的是安装副本，
      // 源码目录的修改停在原地）。只打印路径太容易被无视，所以把**具体哪几个模块不一致**列出来，
      // 并直接升为问题项（不是提示），逼着用户去同步或重装。
      //
      // 判据是**内容**，不是 mtime（2026-10-07 修正）：旧实现比 `mtimeMs`，于是
      // 「install.cjs 复制时保留了源文件 mtime」「两边都改过但改得一样」「sync 之后又 touch 过」
      // 这些情况都会报出**内容其实一致**的文件「不同步」——哭狼一次，用户就学会无视这条红字，
      // 而这条红字本来是用来防「改了源码没生效」的真问题的。sync-to-dsh.cjs 比的就是内容
      // （readFileSync 逐字节），两个脚本口径必须一致，否则同一个状态一边说一致一边说不一致。
      //
      // 清单用 PACKAGE_FILES（drift-check 有闸门守着它不漏 lib/*.js），不再另抄一份硬编码列表：
      // 旧的那份只列了 10 个 lib 文件，漏了 presets/locale/tools，且新增文件时闸门查不到它。
      const drifted = [];
      for (const relative of PACKAGE_FILES) {
        try {
          const a = fs.readFileSync(path.join(pluginDir, relative));
          const b = fs.readFileSync(path.join(realInstalled, '..', relative));
          if (!a.equals(b)) drifted.push(`${relative}（源码 ${a.length}B vs 已装 ${b.length}B）`);
        } catch { /* 任一侧没这个文件：由下面的文件清单检查报，别在这里重复 */ }
      }
      const syncHint = '修法：完全退出 DSH 后 node tools/sync-to-dsh.cjs（比内容、只写差异文件），再重启。';
      if (drifted.length > 0) {
        // 内容真的不一致 = 源码里有改动没进 DSH 加载的那份 = 真故障，保持 problem。
        problems.push(`profile 加载的不是这份源码目录，且**两边内容不一致：源码里的这些修改不会生效**：${drifted.join('、')}。`
          + `已装：${realInstalled}。` + syncHint
          + '（若是换了目录/首次安装，则在**源码目录**跑 node tools/install.cjs —— pnpm 会把 link: 指到你运行命令的那个目录。）');
      } else {
        // 两份文件但内容一致：这是 sync-to-dsh.cjs 规定的正常工作流（真实目录 + 同步；
        // junction 指向工作区被该脚本文件头明确判为不可行）。报 problem 会让这条红字**永远亮着**，
        // 用户于是学会无视它，真出问题时同样没人看 —— 所以降级为提示。
        notes.push(`profile 加载的是安装副本（${realInstalled}），不是这份源码目录；**当前两边内容一致**，所以现有改动没有丢。`
          + '但改完 `lib/*.js` 不会自动生效：' + syncHint
          + '（改 `lib/client.js` 只需刷新页面；改 `presets/*.patch.yml` 重新加载插件即可。）');
      }
    }
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
      writeAtomic(profilePkgPath, `${JSON.stringify(profilePkg, null, 2)}\n`);
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
// 两件事都必须写在这一层，理由见文件头与 MAINTAINER-NOTES.md §8.6/§8.7。
// （PROFILE_PATCH / AGENT_TEAM_CONFIG / MANAGED_START / MANAGED_END 定义在文件上方，revert 分支共用。）
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
        // 注意：必须补一个换行：`match[0]` 已经把那一行的结尾换行吃掉了，不补的话下一行会被
        // 我们块尾的注释吞掉（2026-09-28 实际发生过：`ui-skin-claude-style` 那一行被注释掉）。
        next = patchText.replace(match[0], `${MANAGED_BLOCK}\n`);
      } else {
        next = `${patchText.replace(/\s*$/u, '')}\n\n${MANAGED_BLOCK}\n`;
      }
      writeAtomic(PROFILE_PATCH, next);
      // 写完立刻自检：解析一遍，确认块尾没有把下一行粘进注释里。
      const reparsed = next.split('\n').some((line) => line.includes(MANAGED_END) && line.trim() !== MANAGED_END);
      console.log(reparsed
        ? '  注意：自检：managed 块尾与下一行粘在一起了，请把这段贴给 lead'
        : '  → 自检：managed 块尾换行正常');
      console.log(`  → 已写入并备份到 ${path.basename(backup)}`);
    } else {
      problems.push(`${why}。加 --apply 可自动补齐（会先备份）。`);
    }
  }
}

// 4.9) pnpm 安装残留：profile 的 node_modules/@zws 下若有 *_tmp_* 目录，说明上一次
//      link/junction 重建没收尾（2026-10-04 审查 P2-18）。它占空间、看起来像另一份在用安装，
//      但 repair 不擅自删目录 —— 只报出来让人确认。
const zwsDir = path.join(profileDir, 'node_modules', '@zws');
try {
  if (fs.existsSync(zwsDir)) {
    const leftovers = fs.readdirSync(zwsDir).filter((name) => /_tmp_\d+(_\d+)?$/u.test(name));
    if (leftovers.length > 0) {
      notes.push('profile 的 node_modules/@zws 下有安装残留目录：' + leftovers.join(', ')
        + '。确认不是另一份在用安装后可删除（只删 *_tmp_* 结尾的）：Remove-Item -Recurse -Force '
        + path.join(zwsDir, leftovers[0]));
    }
  }
} catch { /* 读不了目录不该影响体检其余部分 */ }

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
//
// 注意：2026-10-05 修正（审查 §6 第 2 条的「体检假绿灯」）：这里**只探过一个包**时，
// 体检会报「依赖 OK」，而 `tools/integration-test.cjs` 实际静态 import 的是**五个**包
// （@deepseek-ai/cordis / dsh-commands / dsh-scope / dsh-system-prompt / dsh-tools）。
// 本机实测：dsh-tools 解析得到，而 cordis 当时解析不到（junction 目录里没有这个条目）——
// 于是 integration-test 直接 exit 2，体检却全绿。现在逐个探、并把失联的包点名。
// 注意区分两种：`@deepseek-ai/dsh-tools` 是本插件**加载期**的硬依赖（解析不到 host 行会挂），
// 其余四个只有体检脚本需要（解析不到 = 少跑一项验证，不是插件坏了），所以只提示不报故障。
if (junctionOk) {
  const { createRequire } = require('node:module');
  const req = createRequire(path.join(pluginDir, 'lib', 'tools.js'));
  /** 本插件加载期硬依赖 + 体检脚本的依赖（`tools/integration-test.cjs` 的静态 import 面）。
   *  这份清单必须与 integration-test.cjs 的 import 行同步；drift-check 有一条闸门比对两者。 */
  const DEPENDENCY_PROBES = [
    { name: '@deepseek-ai/dsh-tools', hard: true },
    { name: '@deepseek-ai/cordis', hard: false },
    { name: '@deepseek-ai/dsh-commands', hard: false },
    { name: '@deepseek-ai/dsh-scope', hard: false },
    { name: '@deepseek-ai/dsh-system-prompt', hard: false },
  ];
  const missingOptional = [];
  for (const probe of DEPENDENCY_PROBES) {
    try {
      const resolved = req.resolve(probe.name);
      console.log(`- ${probe.name} 解析到：${resolved}`);
    } catch (error) {
      if (!probe.hard) { missingOptional.push(probe.name); continue; }
      reportDependencyFailure(error, { req, junctionPath, pluginDir });
    }
  }
  if (missingOptional.length > 0) {
    console.log(`- 体检脚本的依赖缺 ${missingOptional.length} 个：${missingOptional.join(', ')}`);
    problems.push(`tools/integration-test.cjs 需要但解析不到：${missingOptional.join(', ')}。`
      + '后果是**少跑一项真链路验证**（不是插件坏了）：该脚本会以 exit 2 明确报出，'
      + '但此前体检只探过 dsh-tools 一个包，于是这里报「依赖 OK」、那边 exit 2 —— 自相矛盾。'
      + '修法：给 profiles/node_modules/@deepseek-ai 补上这些条目（见本脚本打印的 junction 目标）。');
  }
}

/** 硬依赖解析失败时，把整条链摸一遍再给针对性修法（P1-4③）。 */
function reportDependencyFailure(error, { junctionPath }) {
  // junction 在、目标闭包却是空的（2026-10-04 本机现状：npm 全局 CLI 目录被清空）。
  // 光报「不可解析」用户不知道下一步做什么，所以把整条链摸一遍再给针对性修法（P1-4③）。
  let chain = `依赖仍不可解析（${error.code || error.message}）：host 行会在 import 阶段失败`;
  try {
    const viaJunction = path.resolve(fs.realpathSync(junctionPath));
    const toolsDir = path.join(viaJunction, '@deepseek-ai', 'dsh-tools');
    if (!fs.existsSync(path.join(toolsDir, 'package.json'))) {
      let targetState = '不存在';
      try {
        const inner = fs.readlinkSync(toolsDir);
        targetState = `junction -> ${inner}${fs.existsSync(inner) ? '（目标存在？）' : '（**目标不存在**）'}`;
      } catch { /* 不是 link 或根本不存在 */ }
      chain += `。链路上断点在 profiles/node_modules：${toolsDir} ${targetState}。`
        + ' 修法：重装全局 CLI —— npm i -g @deepseek-ai/dsh --registry=https://registry.npmmirror.com，'
        + ' 然后重跑 node tools/repair.cjs（宿主本体不受影响：它从 app.asar 解析裸包名）。';
    } else {
      chain += '。profiles/node_modules 里那份在，但从本包解析不到：检查 junction 指向与 --profile 是否同一个 DSH 主目录。';
    }
  } catch {
    chain += '。修法：npm i -g @deepseek-ai/dsh 后重跑本脚本。';
  }
  problems.push(chain);
}

// 7) 本包自检：**每一个会被 loader 加载的模块**都要在清单里。
//    旧清单只有 6 个文件，漏了 runtime/tools/roster/playbook 与 locale/en.json ——
//    缺了核心模块它照样打印「状态完好」，等于一条假绿灯。
//    清单常量 PACKAGE_FILES 定义在文件上方；源码目录与**已安装副本**都要查
//    （宿主加载的是后者，只查前者就是子代理复审点出的假绿灯）。
let manifestMissing = 0;
for (const relative of PACKAGE_FILES) {
  const file = path.join(pluginDir, relative);
  if (!fs.existsSync(file)) {
    problems.push(`本包缺文件：${relative}`);
    manifestMissing += 1;
  }
}
// 已安装副本（宿主真正加载的那一份）查同一张清单：非 link 安装时它是一份独立拷贝，
// 缺文件同样会崩 host 行，只查源码树就是假绿灯（2026-10-04 子代理复审 P1-3）。
if (installed && fs.existsSync(installedDir)) {
  let realInstalledDir = installedDir;
  try {
    realInstalledDir = path.dirname(fs.realpathSync(path.join(installedDir, 'package.json')));
  } catch { /* realpath 失败就用原路径 */ }
  try {
    if (fs.realpathSync(realInstalledDir) !== fs.realpathSync(pluginDir)) {
      const missingThere = PACKAGE_FILES.filter((relative) => !fs.existsSync(path.join(realInstalledDir, relative)));
      if (missingThere.length > 0) {
        problems.push(`已安装副本缺文件：${missingThere.join('、')}（${realInstalledDir}）。修法：完全退出 DSH 后在源码目录重跑 node tools/install.cjs。`);
      } else {
        console.log(`- 已安装副本文件清单：齐备（${realInstalledDir}）`);
      }
    } else {
      console.log('- 已安装副本与源码是同一目录：清单已按源码检查');
    }
  } catch { /* 副本路径不可解析：上面的存在性检查已经报过了 */ }
}
if (manifestMissing === 0) console.log('- 源码文件清单：齐备');
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