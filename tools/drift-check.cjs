#!/usr/bin/env node
/**
 * drift-check.cjs —— 官方升级漂移检测（本插件的「抗官方更新」保险）
 *
 * 本插件的正确性依赖若干**官方实现细节**。官方升级 DSH 后这些细节可能变化，
 * 而失败方式往往是静默的（例如官方改了行 id，我们的 disabled 覆盖就空转，
 * 官方工具悄悄回来；官方改了 waterfall 名，我们的模型覆盖就静默失效）。
 *
 * 本脚本把这些假设逐条对着**装机的 app.asar** 重新验证，并打印 PASS/FAIL。
 * 建议：每次 DSH 升级后、以及任何团队行为异常时先跑它。
 *
 *   node tools/drift-check.cjs
 *   node tools/drift-check.cjs --asar "C:\\path\\to\\app.asar" --profile "C:\\Users\\X\\.dsh\\profiles\\desktop"
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL（需要按报告修本插件）；2 = 环境/参数问题。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

/**
 * 官方工具包里那九个工具名（**官方侧**的真值，用于验证官方没改名）。
 * 本插件侧的名单真值在 lib/roster.js 的 TEAM_TOOL_NAMES；下面 12b 会把两边对上，
 * 所以这里不是「第二份手工真值」，而是「被交叉验证的一份」。
 */
const OFFICIAL_TEAM_TOOL_NAMES = [
  'spawn_teammate',
  'send_message',
  'list_agents',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
];

// ── 参数 ─────────────────────────────────────────────────────────────────────
function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : void 0;
}

const ASAR_CANDIDATES = [
  argValue('--asar'),
  path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'Programs',
    'DeepSeek Harness',
    'resources',
    'app.asar',
  ),
].filter(Boolean);

const PROFILE_DIR =
  argValue('--profile') || path.join(os.homedir(), '.dsh', 'profiles', 'desktop');

const PLUGIN_DIR = path.resolve(__dirname, '..');

// ── 极简 asar 读取（无依赖）──────────────────────────────────────────────────
function openAsar(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const size = head.readUInt32LE(12);
  const headerBuf = Buffer.alloc(size);
  fs.readSync(fd, headerBuf, 0, size, 16);
  const json = JSON.parse(headerBuf.toString('utf8', 0, headerBuf.length).replace(/\0+$/, ''));
  const raw = 16 + size;
  const dataOffset = raw + ((4 - (raw % 4)) % 4);
  return {
    fd,
    dataOffset,
    json,
    read(entryPath) {
      let node = this.json;
      for (const segment of entryPath.split('/').filter(Boolean)) {
        node = node?.files?.[segment];
        if (node === void 0) return void 0;
      }
      if (node === void 0 || node.files !== void 0) return void 0;
      if (node.unpacked === true) return void 0;
      const buf = Buffer.alloc(node.size);
      if (node.size > 0) fs.readSync(this.fd, buf, 0, node.size, this.dataOffset + Number(node.offset));
      return buf.toString('utf8');
    },
    readJson(entryPath) {
      const text = this.read(entryPath);
      return text === void 0 ? void 0 : JSON.parse(text);
    },
    has(entryPath) {
      let node = this.json;
      for (const segment of entryPath.split('/').filter(Boolean)) {
        node = node?.files?.[segment];
        if (node === void 0) return false;
      }
      return node !== void 0;
    },
    close() {
      fs.closeSync(this.fd);
    },
  };
}

// ── 报告器 ───────────────────────────────────────────────────────────────────
const results = [];
function check(name, fn) {
  try {
    const outcome = fn();
    if (outcome === true || outcome === void 0) {
      results.push({ name, ok: true, detail: '' });
    } else {
      results.push({ name, ok: false, detail: String(outcome) });
    }
  } catch (error) {
    results.push({ name, ok: false, detail: `检查本身抛错：${error && error.message ? error.message : String(error)}` });
  }
}

const readFileOr = (file, fallback = '') => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fallback);

/**
 * 切出某个**顶层函数**的函数体（用于「接线还在不在」这类断言：只看调用点，不看定义）。
 * 插件里所有顶层函数都以列 0 的 `}` 结束，所以这个切法安全。
 * @param source - 文件内容。
 * @param needle - 函数签名片段，例如 `function installRouteOverride(`。
 * @returns 函数体文本；找不到签名时返回空串。
 */
function functionBodyOf(source, needle) {
  const start = source.indexOf(needle);
  if (start < 0) return '';
  const end = source.indexOf('\n}\n', start);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
const asarPath = ASAR_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (asarPath === void 0) {
  console.error('[drift-check] 找不到 app.asar。已尝试：');
  for (const candidate of ASAR_CANDIDATES) console.error('  -', candidate);
  console.error('用 --asar <path> 显式指定。');
  process.exit(2);
}

console.log(`[drift-check] app.asar  : ${asarPath}`);
console.log(`[drift-check] profile   : ${PROFILE_DIR}`);
console.log(`[drift-check] plugin dir: ${PLUGIN_DIR}`);
console.log('');

const asar = openAsar(asarPath);

/**
 * 版本透明化（2026-09-28 桌面端 0.1.7-rc.2 → 0.2.0-rc.1 之后加）：
 * 本插件 `lib/tools.js` 的静态 import 由**安装期 junction** 解析（指向全局 CLI 的依赖闭包），
 * 而宿主进程跑的是 app.asar 里那一份 —— 两者**不是同一份代码**。所以两个版本都必须打出来：
 * 「这条 PASS 是对着谁验的」全靠这两行，否则很容易把 `defineTool` 的存在当成形状兼容。
 */
function asarVersion(entryPath) {
  try {
    const text = asar.read(entryPath);
    if (text === void 0) return '(不在 asar 里)';
    const parsed = JSON.parse(text);
    return `${parsed.name}@${parsed.version}`;
  } catch (error) {
    return `(读不到：${error && error.message ? error.message : String(error)})`;
  }
}
function junctionVersion(specifier) {
  try {
    const { createRequire } = require('node:module');
    const entry = createRequire(path.join(PLUGIN_DIR, 'lib', 'tools.js')).resolve(specifier);
    let dir = path.dirname(entry);
    for (let depth = 0; depth < 6; depth += 1) {
      const manifest = path.join(dir, 'package.json');
      if (fs.existsSync(manifest)) {
        const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (typeof parsed.version === 'string') return `${parsed.name}@${parsed.version}`;
      }
      dir = path.dirname(dir);
    }
    return `${specifier}@?`;
  } catch (error) {
    return `${specifier}@(解析不到：${error && error.code ? error.code : 'unknown'})`;
  }
}
console.log(`[drift-check] 宿主版本  : ${asarVersion('package.json')} → ${asarVersion('dsh/package.json')}`);
console.log(`[drift-check] 插件依赖  : ${junctionVersion('@deepseek-ai/dsh-tools')}（junction → 全局 CLI 的闭包，**不是**宿主那一份）`);
console.log('');

// 1) 官方 agent-team bundle 的三行 id 是否还在
const officialProfilePatch =
  asar.read('dsh/node_modules/@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml') || '';
check('官方 agent-team-profile 的 patch 仍存在且含三行 id', () => {
  if (officialProfilePatch === '') return '读不到 dsh-experimental-agent-team-profile/cordis.patch.yml';
  for (const id of ['agent-team', 'tool-agent-team', 'ui-agent-team']) {
    if (!new RegExp(`(^|\\n)\\s*-?\\s*id:\\s*${id}\\s*$`, 'm').test(officialProfilePatch)) {
      return `官方 patch 里找不到行 id "${id}" —— 我们的 disabled 覆盖会空转，官方工具可能悄悄回来`;
    }
  }
  return true;
});

// 2) 官方工具包仍导出九工具与我们依赖的成员
const officialTool = asar.read('dsh/node_modules/@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js') || '';
check('官方工具包仍含九个工具名', () => {
  if (officialTool === '') return '读不到 dsh-experimental-tool-agent-team/lib/index.js';
  const missing = OFFICIAL_TEAM_TOOL_NAMES.filter((name) => !officialTool.includes(`"${name}"`));
  return missing.length === 0 ? true : `官方工具包缺：${missing.join(', ')} —— 本插件的 lib/tools.js 需要对齐`;
});

// 3) 官方域服务仍提供 agentTeams 及我们调用到的方法
const officialDomain = asar.read('dsh/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/index.js') || '';
check('官方域服务仍提供 agentTeams 与全部被调用方法', () => {
  if (officialDomain === '') return '读不到 dsh-experimental-agent-team/lib/index.js';
  if (!officialDomain.includes('"agentTeams"')) return '域服务不再发布 agentTeams';
  const methods = [
    'tryMembership',
    'membership',
    'listMembers',
    'spawnTeammate',
    'sendMessage',
    'createTask',
    'getTask',
    'listTasks',
    'updateTask',
    'waitForChange',
    'interrupt',
  ];
  const missing = methods.filter((name) => !officialDomain.includes(`${name}(`));
  return missing.length === 0 ? true : `域服务缺方法：${missing.join(', ')}`;
});

// 4) agent/request waterfall 仍在（队员模型/强度覆盖的唯一支点）
const agentLoop = asar.read('dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js') || '';
check('dsh-agent-loop 仍分发 "agent/request" waterfall', () => {
  if (agentLoop === '') return '读不到 dsh-agent-loop/lib/index.js';
  return agentLoop.includes('"agent/request"')
    ? true
    : '"agent/request" 消失 —— 队员模型/思考强度覆盖会静默失效，必须改本插件的覆盖机制';
});

// 5) ctx.llm 目录 API 仍在
const llmIndex = asar.read('dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js') || '';
check('dsh-llm 仍提供 listProviders / listModels / resolveModelInfo', () => {
  if (llmIndex === '') return '读不到 dsh-llm/lib/index.js';
  const missing = ['listProviders', 'listModels', 'resolveModelInfo'].filter((name) => !llmIndex.includes(`${name}(`));
  return missing.length === 0 ? true : `dsh-llm 缺：${missing.join(', ')} —— lib/runtime.js 的 listModelCatalog/preflightRoute 需要重写`;
});

// 6) 命令名正则（中文命令不可行的前提）是否变化
const commandsIndex = asar.read('dsh/node_modules/@deepseek-ai/dsh-commands/lib/index.js') || '';
check('dsh-commands 的命令名正则未变（仍是 ASCII-only）', () => {
  if (commandsIndex === '') return '读不到 dsh-commands/lib/index.js';
  if (!commandsIndex.includes('/^[a-z][a-z0-9_-]*$/u')) {
    return '正则变了！如果现在允许中文命令名，可以考虑把命令入口换成中文名（升级带来的改进机会）';
  }
  return true;
});

// 7) 客户端槽位 plugins.bundle.config 仍由 plugin-manager 声明
const pluginManagerClient = asar.read('dsh/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js') || '';
check('plugins.bundle.config 槽位仍存在', () => {
  if (pluginManagerClient === '') return '读不到 dsh-client-ui-plugin-manager/lib/client.js';
  if (!pluginManagerClient.includes('"plugins.bundle.config"')) {
    return '槽位消失 —— lib/client.js 的配置页挂不上去，需要找新的挂载点';
  }
  return true;
});

// 8) 我们重新挂载的官方 UI 包是否还在
check('官方团队 UI 包仍存在（我们用它做成员列表/看板）', () =>
  (asar.has('dsh/node_modules/@deepseek-ai/dsh-experimental-client-ui-agent-team/lib/client.js')
    ? true
    : 'dsh-experimental-client-ui-agent-team 消失 —— cordis.patch.yml 里 dispatch-agent-team-panel 行需要删掉或换实现'));

// 9) patch 层的**顺序语义**（2026-09-28 的 P0 教训）。
// 官方 agent-team-profile 用 `- insert:` **新建** agent-team / tool-agent-team / ui-agent-team 三行；
// patch 层按 `dsh.profile.bundles` 顺序应用，而 DSH 插件页启用 bundle 时是 **append 到末尾**。
// 所以「我们的 bundle 排在官方之前还是之后」完全取决于用户的启用顺序：
//   * 在此之前我们靠 `- id: tool-agent-team, disabled: true` 关官方工具行 —— 排在官方之前时**静默失效**
//     （实测：官方九工具在所有 preset 里都可见）；
//   * 同理 `- id: agent-team, config: {maxMembers: 48}` 也被官方 insert 的默认值 8 顶掉。
// 现在：官方工具面/策略段的抑制在**调度模式的 preset 作用域**（lib/preset.js 的 suppressOfficialTeam），
// 域服务容量覆盖则**必须同时**出现在 profile 自己的 patch 层（在所有 bundle 层之后应用）。
const oursPatch = readFileOr(path.join(PLUGIN_DIR, 'cordis.patch.yml'));
check('官方 team bundle 用 insert 新建三行（所以 id 覆盖必须落在它之后的层）', () => {
  if (officialProfilePatch === '') return '读不到官方 agent-team-profile 的 patch';
  if (!/-\s*insert:/u.test(officialProfilePatch)) {
    return '官方 patch 不再用 insert：patch 的组合顺序语义变了，必须重读 dsh-app-boot 的 loadProfileDirectory/readProfilePatches';
  }
  const missing = ['agent-team', 'tool-agent-team', 'ui-agent-team']
    .filter((id) => !new RegExp(`id:\\s*${id}\\b`, 'u').test(officialProfilePatch));
  return missing.length === 0 ? true : `官方 insert 里缺行 id：${missing.join(', ')}`;
});

check('本包 cordis.patch.yml **不**写顺序依赖的 disabled（官方行的抑制改在 preset 作用域）', () => {
  if (oursPatch === '') return '读不到 cordis.patch.yml';
  const offenders = ['tool-agent-team', 'ui-agent-team']
    .filter((id) => new RegExp(`-\\s*id:\\s*${id}\\s*\\n\\s*disabled:\\s*true`, 'u').test(oursPatch));
  if (offenders.length > 0) {
    return `${offenders.join(', ')} 仍靠 bundle patch 关闭 —— 这是**顺序依赖**的写法：我们的层排在官方 insert 之前时白写（静默失效），排在之后又会把官方团队从别的 preset 里一起拿掉`;
  }
  return true;
});

check('官方策略段名仍是 "team:policy"（preset 作用域的遮蔽依赖这个名字）', () => {
  if (officialTool === '') return '读不到官方工具包';
  if (!officialTool.includes('"team:policy"')) {
    return '官方策略段名变了：lib/roster.js 的 OFFICIAL_TEAM_POLICY_SECTION 必须同步，'
      + '否则调度模式的提示词里会叠加一份官方 Team Lead 方法论（并且静默多花钱）';
  }
  return true;
});

// 10) 本插件的角色表真值只有一处（lib/roster.js）。这里**不再写死一份角色 id 副本**：
// 旧版本写死 7 个 id 且只做 ⊆ 比较，roster 扩编时它永不报警；同时 client.js 的
// 「7 个角色」文案也没人管。现在改成两条真检查：
//   * client.js / locale / preset / package.json 里出现的「N 个角色 / N 类队员」必须等于真实角色数；
//   * client.js 里不许出现任何角色 id 字面量（角色表必须由宿主 get 返回）。
// 需要真值 → 走动态 import（本脚本是 CJS，lib/*.js 是 ESM），见文件尾的 12) 段。
const clientJs = readFileOr(path.join(PLUGIN_DIR, 'lib', 'client.js'));

// 10b) package.json 的 exports 必须覆盖三条独立解析路径。
// 缺 "." → host 行起不来；缺 "./client" → client-modules 硬抛「declares dsh.client but exports no
// "./client" bundle」；缺 "./preset" → preset 行 import 失败，整份 dispatch-mode preset 变 broken。
check('package.json exports 覆盖 "." / "./client" / "./preset"', () => {
  const manifest = path.join(PLUGIN_DIR, 'package.json');
  if (!fs.existsSync(manifest)) return '读不到 package.json';
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const exportsMap = pkg.exports;
  if (exportsMap === void 0 || typeof exportsMap !== 'object') return 'package.json 没有 exports 映射';
  const missing = ['.', './client', './preset'].filter((key) => exportsMap[key] === void 0);
  return missing.length === 0 ? true : `exports 缺：${missing.join(', ')}（会导致对应的插件行/浏览器半静默失效）`;
});

// 10c) 我们 patch 里对官方 agent-team 行的 config 覆盖必须是「整段」（5 个字段全在），
// 且 maxMembers 要大于角色数——官方 roster 的 maxMembers 计的是**历史累计**（队员名永不复用）。
check('agent-team 行 config 覆盖完整且 maxMembers 够用', () => {
  const patch = readFileOr(path.join(PLUGIN_DIR, 'cordis.patch.yml'));
  if (patch === '') return '读不到 cordis.patch.yml';
  const block = patch.split(/\n- id: agent-team\s*\n/)[1];
  if (block === void 0) return 'cordis.patch.yml 里没有 `- id: agent-team` 的 config 覆盖（capacity 会退回官方值）';
  const tail = block.split(/\n- (?:id|insert):/)[0];
  const fields = ['maxMembers', 'maxTasks', 'maxPendingMessagesPerMember', 'maxMessageBytes', 'disposalTimeoutMs'];
  const missing = fields.filter((field) => !tail.includes(`${field}:`));
  if (missing.length > 0) {
    return `config 覆盖缺字段：${missing.join(', ')} —— patch 是按 id **整段替换**，省略的字段会退回 schema 默认值`;
  }
  const match = /maxMembers:\s*(\d+)/u.exec(tail);
  const maxMembers = match === null ? 0 : Number(match[1]);
  // 角色数真值在 roster.js（见文件尾 12)），这里只做「至少能覆盖每个角色各叫一次」的下限检查，
  // 精确比对放在 12c（那里能读到 ROLES.length）。
  if (maxMembers < 8) return `maxMembers=${maxMembers} 太小（官方默认就是 8；它是历史累计计数，队员名永不复用）`;
  return true;
});

// 10c-2) 容量覆盖必须**同时**在 profile 自己的 patch 层里。
// 这是 2026-09-28 的 P0：官方 insert 的默认 maxMembers=8 把我们 bundle patch 里那份顶掉了，
// 而官方 roster 的 maxMembers 是**历史累计**（队员名永不复用）——12 个角色各叫一次就废了。
// profile 的 cordis.patch.yml 在所有 bundle 层之后应用（dsh-app-boot 的 readProfilePatches），
// 所以那一层是唯一顺序无关的落点。修法：tools/repair.cjs --apply。
check('profile 层 patch 也有 agent-team 容量覆盖，且与本包一致（顺序无关的生效路径）', () => {
  const profilePatchPath = path.join(PROFILE_DIR, 'cordis.patch.yml');
  if (!fs.existsSync(profilePatchPath)) {
    return `读不到 ${profilePatchPath}：容量覆盖没有生效落点（跑 tools/repair.cjs --apply 补齐）`;
  }
  const text = fs.readFileSync(profilePatchPath, 'utf8');
  const block = text.split(/\n- id: agent-team\s*\n/)[1];
  if (block === void 0) {
    return 'profile 的 cordis.patch.yml 里没有 `- id: agent-team` 覆盖：maxMembers 会退回官方默认 8，'
      + '12 个角色各叫一次之后团队再也派不出人 —— 跑 tools/repair.cjs --apply';
  }
  const tail = block.split(/\n- (?:id|insert):/)[0];
  const profileValue = Number((/maxMembers:\s*(\d+)/u.exec(tail) ?? [])[1] ?? 0);
  const ourValue = Number((/maxMembers:\s*(\d+)/u.exec(oursPatch) ?? [])[1] ?? 0);
  if (profileValue !== ourValue) {
    return `profile 层 maxMembers=${profileValue} 与本包 ${ourValue} 不一致：两份真值会各飘各的（改一处忘另一处）`;
  }
  if (profileValue < 8) return `profile 层 maxMembers=${profileValue} 太小（官方默认就是 8）`;
  return true;
});

// 10d) 硬前置：官方 agent-team-profile 必须仍在 profile 的 bundle 列表里，否则域服务消失
// （我们的 patch 只是 id 覆盖，没有自己 insert 域服务行）。
check('硬前置：官方 agent-team-profile 仍被 profile 选中', () => {
  const pkgPath = path.join(PROFILE_DIR, 'package.json');
  if (!fs.existsSync(pkgPath)) return `读不到 ${pkgPath}`;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const bundles = pkg?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) return 'profile package.json 没有 dsh.profile.bundles';
  if (!bundles.includes('@deepseek-ai/dsh-experimental-agent-team-profile')) {
    return '官方 agent-team-profile 不在 bundles 里：agentTeams 域服务会不存在，本插件的团队功能只会给出可执行报错。' +
      '修法：插件页启用它（至少保留 agent-team 行），或用 tools/repair.cjs 检查。';
  }
  return true;
});

// 10e) 依赖解析接线：本包以 link: 安装时 Node 解析到真实路径，需要一个指向
// <dshHome>/profiles/node_modules 的 junction，否则 @deepseek-ai/dsh-tools 在
// **模块加载期**解析失败，host 行无法激活（首次安装实测就是这么失败的）。
check('依赖解析 junction 可用（@deepseek-ai/dsh-tools 可解析）', () => {
  const junctionPath = path.join(PLUGIN_DIR, 'node_modules');
  let linked = false;
  try {
    linked = fs.lstatSync(junctionPath).isSymbolicLink();
  } catch {
    linked = false;
  }
  if (!linked) {
    return `缺少 ${junctionPath}（应是指向 <dshHome>/profiles/node_modules 的 junction）。` +
      '修法：node tools/repair.cjs --apply';
  }
  try {
    const { createRequire } = require('node:module');
    const resolved = createRequire(path.join(PLUGIN_DIR, 'lib', 'tools.js')).resolve('@deepseek-ai/dsh-tools');
    if (!resolved.includes('dsh-tools')) return `解析到了意外路径：${resolved}`;
  } catch (error) {
    return `仍不可解析（${error.code || error.message}）：host 行会在 import 阶段失败`;
  }
  return true;
});

// 10f) 本插件对官方包的使用面：@deepseek-ai/dsh-tools 的 defineTool 仍导出。
// 旧版本只判「文件在不在」——官方删掉这个导出它照样 PASS，等于一条假绿灯。
const HOST_TOOLS_INDEX = 'dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
check('@deepseek-ai/dsh-tools 仍导出 defineTool', () => {
  const source = asar.read(HOST_TOOLS_INDEX);
  if (source === void 0) return 'dsh-tools 包不在安装闭包里';
  if (!/defineTool/u.test(source)) {
    return '找不到 defineTool —— lib/tools.js 的静态 import 会拿到 undefined，九个工具全部注册失败';
  }
  return true;
});

// 10f-1) 形状兼容（2026-09-28 桌面端升到 0.2.0-rc.1 后加）。
// 真实情况：我们调用的是 **junction 那份旧实现**（本机实测 0.1.5-rc.2）来编译工具对象，
// 再把编译结果交给 **宿主 0.2.0-rc.1** 的注册表。两份 defineTool 唯一差异是加法
// （0.2.0 多了 projectContent / deferLoading），所以今天不丢功能；但这条耦合是**静默**的：
// 官方哪天改掉我们依赖的字段（parameters / output.render / execute 形状），
// 旧实现会照样编译出一份新宿主不认的对象，而加载期没有任何报错。
// 这里把我们依赖的字段逐个在**两份源码**里都对一遍。
const DEFINE_TOOL_ANCHORS = [
  'name: options.name',
  'parameters,',
  'output: {',
  'render(args, value)',
  'async execute(args, exec)',
  'parameterSchemaSpecToJsonSchema(options.parameters)',
  'valueSchemaSpecToJsonSchema(options.output.schema)',
  'new ToolArgsError(violations)',
];
check('defineTool 依赖字段在 junction 那份与宿主那份里都还在（跨版本耦合闸门）', () => {
  const host = asar.read(HOST_TOOLS_INDEX);
  if (host === void 0) return 'dsh-tools 包不在安装闭包里';
  let local = '';
  try {
    const { createRequire } = require('node:module');
    local = fs.readFileSync(createRequire(path.join(PLUGIN_DIR, 'lib', 'tools.js')).resolve('@deepseek-ai/dsh-tools'), 'utf8');
  } catch (error) {
    return `读不到 junction 那份 dsh-tools（${error && error.code ? error.code : 'unknown'}）—— 安装期 junction 坏了，host 行会在 import 阶段失败`;
  }
  const missedHost = DEFINE_TOOL_ANCHORS.filter((anchor) => !host.includes(anchor));
  if (missedHost.length > 0) {
    return `宿主那份 defineTool 少了我们依赖的形状：${missedHost.join(' | ')} —— `
      + '必须重读官方实现并同步 lib/tools.js（旧实现编译出的工具对象会被新宿主误读）';
  }
  const missedLocal = DEFINE_TOOL_ANCHORS.filter((anchor) => !local.includes(anchor));
  if (missedLocal.length > 0) {
    return `junction 那份 defineTool 少了：${missedLocal.join(' | ')} —— 工具对象形状与预期不符`;
  }
  return true;
});

// 10f-3) 配置页定位 DSH 主目录靠 `settings.prepareDocument()`：0.2.0 里它还在
// （dsh-settings/lib/index.js 的 prepareDocument + documentPath）。它一旦消失，
// resolveDshHome 会退回环境变量/家目录探测 —— 能跑，但配置文件可能落到意料之外的目录。
check('dsh-settings 仍有 prepareDocument()/documentPath（DSH 主目录定位的前提）', () => {
  const source = asar.read('dsh/node_modules/@deepseek-ai/dsh-settings/lib/index.js');
  if (source === void 0) return 'dsh-settings 包不在安装闭包里';
  const missing = ['prepareDocument', 'documentPath'].filter((name) => !source.includes(name));
  return missing.length === 0
    ? true
    : `dsh-settings 缺：${missing.join(', ')} —— lib/runtime.js 的 locateDshHome 需要改走别的定位方式`;
});

// 10f-2) 队员能力面收窄依赖 `ctx.tools.restrict()`。它是**载重依赖**：一旦官方删掉/改语义，
// 队员就会静默恢复成「和目标工具、子代理工具、Lead 专属开关全都有」，而没有任何报错。
check('dsh-tools 仍提供 restrict() 且仍是「只过滤继承面」的语义', () => {
  const source = asar.read('dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js');
  if (source === void 0) return 'dsh-tools 包不在安装闭包里';
  if (!/restrict\(filter\)/u.test(source)) {
    return 'tools.restrict(filter) 消失 —— 队员的工具收窄会静默失效（TEAMMATE_TOOL_DENY 变成空转）';
  }
  if (!source.includes('restrictableNames')) {
    return 'restrict 的 known-name 校验（restrictableNames）不见了 —— 逐个 try/catch 调用的前提变了，请重新读官方实现';
  }
  if (!/never what its OWN layer registers|A restriction filters what a scope inherits/u.test(source)) {
    return 'restrict 的语义注释变了：不再是「过滤继承面、放行本作用域自己的注册」。'
      + '这会让队员工具名单（我们注册在 own layer）+ 收窄名单（继承面）的组合产生非预期结果，必须重读官方实现';
  }
  return true;
});

// 10g) 官方 TeamTaskId 仍是恒等函数（我们已按此本地实现，不再 import 官方包）
check('官方 TeamTaskId 仍是恒等函数（本插件本地实现了它）', () => {
  const source = asar.read('dsh/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/types/types.js') || '';
  if (source === '') return '读不到 dsh-experimental-agent-team/lib/types/types.js';
  if (!/function TeamTaskId\(id\)\s*\{\s*return id;?\s*\}/u.test(source)) {
    return '官方 TeamTaskId 不再是无校验恒等函数 —— 必须改回从 @deepseek-ai/dsh-experimental-agent-team import，' +
      '否则我们的任务 id 品牌化可能与官方语义脱节（见 lib/tools.js 顶部注释）';
  }
  return true;
});

// 10h) 客户端半的**致命不变量**：不得有任何顶层声明。
// 多个 client bundle 会被客户端拼成**一个脚本**执行
// （实测 URL：/plugins/??a/client.js,b/client.js,…）。顶层 `const factory` 会与别的
// bundle 撞名 → `Uncaught SyntaxError: Identifier 'factory' has already been declared`
// → 整个拼合脚本（**含官方 bundle**）一起失败 → 应用无法启动。
// 2026-09-27 真实发生过：我们的 client.js 与 某个第三方插件 的顶层
// `const factory` 撞名，导致 DSH 弹「应用无法启动或已意外停止」。
check('客户端半零顶层声明，且只做一次 load() 注册', () => {
  const source = readFileOr(path.join(PLUGIN_DIR, 'lib', 'client.js'));
  if (source === '') return '读不到 lib/client.js';
  const lines = source.split(/\r?\n/);
  const offenders = [];
  for (const [index, line] of lines.entries()) {
    if (/^(const|let|var|function|class)\s/u.test(line)) offenders.push(`第 ${index + 1} 行：${line.trim().slice(0, 70)}`);
  }
  if (offenders.length > 0) {
    return `发现顶层声明 —— 它会被拼合脚本判为重复标识符，直接让 DSH 无法启动：\n        ${offenders.join('\n        ')}`;
  }
  const loads = source.match(/window\.__ModuleLoader__\.load\(/gu);
  if (loads === null || loads.length !== 1) {
    return `window.__ModuleLoader__.load(...) 出现 ${loads === null ? 0 : loads.length} 次，应恰好 1 次`;
  }
  // 更强的不变量：整份文件除了注释/空行，第一个可执行语句就必须是那次 load()。
  // 顶层声明不一定顶格写（缩进两格的 `const x = 1` 同样在模块作用域），所以「只看第 0 列」
  // 会漏检；改成「load() 之前不许有任何非注释、非空白的行」。
  const loadIndex = lines.findIndex((line) => line.includes('window.__ModuleLoader__.load('));
  for (let index = 0; index < loadIndex; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
    return `第 ${index + 1} 行在 load() 之前出现了可执行语句 —— 顶层零声明被破坏：${trimmed.slice(0, 70)}`;
  }
  if (!source.includes("id: '@zws/dsh-dispatch-agent-team'")) {
    return '注册 id 必须等于本包 package.json 的 name（client-modules 按解析出的包名建图）';
  }
  return true;
});

// 11) 调度模式 preset 的行是否落后于「极简灰度模式」
const profilePatch = readFileOr(path.join(PROFILE_DIR, 'cordis.patch.yml'));
const ourPresetPatch = readFileOr(path.join(PLUGIN_DIR, 'presets', 'dispatch-mode.patch.yml'));

/**
 * 把一段 preset 的 plugins 列表拆成**有序行签名**：`<id>|<name>|<disabled>`。
 *
 * 为什么不能只比 name 集合（旧版本的写法）：`cordis:group` 在一份 preset 里出现 4 次，
 * 集合只算 1 个 —— 整组删掉也照样 PASS；`disabled` 翻转、行数变化、行顺序变化全都看不见。
 * 这里不求完整 YAML 解析（本脚本不能依赖 js-yaml：junction 缺失时 require 会直接崩），
 * 只取「行身份 + 开关状态」这两件真正决定能力面的事；**config 正文差异不在覆盖范围内**，
 * 这一条限制写进 presets/dispatch-mode.patch.yml 的注释里，不再声称「逐行比对」。
 */
function rowSignatures(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const idMatch = /^(\s*)-\s*id:\s*([A-Za-z0-9._@/-]+)\s*$/u.exec(lines[index]);
    if (idMatch === null) continue;
    const indent = idMatch[1].length;
    let name = '';
    let disabled = false;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() === '') continue;
      const lineIndent = line.length - line.trimStart().length;
      // 兄弟行/下一条 patch 条目 → 本行结束
      if (lineIndent <= indent) break;
      // 只认本行自己的键（indent + 2）。嵌套子行（indent + 4 的 `- id:`）有自己的签名，
      // 否则 `delegation` 会被它子行里的 `disabled: true` 误判成 disabled。
      if (lineIndent !== indent + 2) continue;
      const nameMatch = /^name:\s*['"]?([^'"\s]+)['"]?\s*$/u.exec(line.trim());
      if (nameMatch !== null && name === '') name = nameMatch[1];
      if (/^disabled:\s*true\s*$/u.test(line.trim())) disabled = true;
    }
    rows.push({ id: idMatch[2], name, disabled, signature: `${idMatch[2]}|${name}|${disabled ? 'off' : 'on'}` });
  }
  return rows;
}

/** preset 声明行本身（`- id: preset-*`）不是能力行：它的 id/name/order 本来就该不同，比对时排除。 */
const isPresetContainerRow = (row) => /^preset-/u.test(row.id);

/**
 * 取 profile patch 里某个 preset 那一段（**行锚定**，不再用 indexOf 字符串锚点：
 * 注释里出现同名标记时会把段落切错，2026-09-27 的写法就有这个隐患）。
 * @param presetId - 例如 'preset-minimal-grayscale'。
 * @returns 该段落文本（含 `- insert:` 与 preset 行）；找不到返回 ''。
 */
function presetSection(presetId) {
  const lines = profilePatch.split(/\r?\n/);
  const anchor = lines.findIndex((line) => new RegExp(`^\\s*-\\s*id:\\s*${presetId}\\s*$`, 'u').test(line));
  if (anchor < 0) return '';
  // 往回吃掉紧邻的 `- insert:` 行（preset 行挂在它下面）
  let from = anchor;
  for (let index = anchor - 1; index >= 0; index -= 1) {
    if (lines[index].trim() === '') continue;
    if (/^\s*-\s*insert:\s*$/u.test(lines[index])) from = index;
    break;
  }
  // 往后截到下一个**列 0** 的 patch 条目
  let to = lines.length;
  for (let index = anchor + 1; index < lines.length; index += 1) {
    if (/^-\s/u.test(lines[index])) { to = index; break; }
  }
  return lines.slice(from, to).join('\n');
}

check('调度模式 preset 与「极简灰度模式」的插件行未漂移（行身份 + 开关状态 + 顺序）', () => {
  if (profilePatch === '' || ourPresetPatch === '') return '读不到 profile 或本包的 patch（跳过）';
  const section = presetSection('preset-minimal-grayscale');
  if (section === '') return '在 profile patch 里没找到 preset-minimal-grayscale 的插件行（用户可能改了 preset 结构）';
  const minimalRows = rowSignatures(section).filter((row) => !isPresetContainerRow(row));
  if (minimalRows.length === 0) return '解析不出极简灰度的插件行（YAML 形状变了？）';
  const oursRows = rowSignatures(ourPresetPatch).filter((row) => !isPresetContainerRow(row));
  const ours = new Map(oursRows.map((row) => [row.id, row]));
  const missing = [];
  const changed = [];
  for (const row of minimalRows) {
    const mine = ours.get(row.id);
    if (mine === undefined) { missing.push(row.id); continue; }
    if (mine.signature !== row.signature) changed.push(`${row.id}: 极简=[${row.signature}] 我们=[${mine.signature}]`);
  }
  if (missing.length > 0) {
    return `极简灰度有而调度模式缺这些行：${missing.join(', ')} —— 若要保持能力对齐，请把它们补进 presets/dispatch-mode.patch.yml`;
  }
  if (changed.length > 0) {
    return `同一行 id 的行定义不一致（name 或 disabled 变了）：\n        ${changed.join('\n        ')}`;
  }
  return true;
});

// 11b) 行数也要对得上：只比签名会漏掉「同一 id 出现两次」这种结构差异。
check('调度模式 preset 的能力行数 = 极简灰度 + 1（我们自己的 dispatch-preset）', () => {
  const section = presetSection('preset-minimal-grayscale');
  if (section === '') return '读不到极简灰度那一段（跳过）';
  const minimalCount = rowSignatures(section).filter((row) => !isPresetContainerRow(row)).length;
  const oursCount = rowSignatures(ourPresetPatch).filter((row) => !isPresetContainerRow(row)).length;
  if (oursCount !== minimalCount + 1) {
    return `能力行数 ${oursCount} ≠ 极简灰度 ${minimalCount} + 1（dispatch-preset 行）。`
      + ' 少一行说明能力面缺了东西，多一行说明多了没记录的行';
  }
  return true;
});

// 11c) 本插件「队员收窄」的接线必须在 lib/runtime.js 里真的存在。
// 这一条防的是「名单还在、接线被删掉」——那会让所有队员静默拿到全套工具。
check('lib/runtime.js 仍真的消费队员能力面常量（接线未被删除）', () => {
  const runtime = readFileOr(path.join(PLUGIN_DIR, 'lib', 'runtime.js'));
  if (runtime === '') return '读不到 lib/runtime.js';
  const required = [
    ['TEAMMATE_CARD', '共享队员卡'],
    ['TEAMMATE_TOOL_DENY', '队员工具收窄名单'],
    ['TEAMMATE_SECTION_MUTES', '队员提示词段清空名单'],
    ['MEMBER_TEAM_TOOL_NAMES', '队员团队工具子集'],
    ['tools.restrict', '收窄 API 调用'],
  ];
  const missing = required.filter(([needle]) => !runtime.includes(needle)).map(([, label]) => label);
  return missing.length === 0 ? true : `lib/runtime.js 里找不到：${missing.join('、')}`;
});

// 11c-3) 会话记忆（lib/resume.js，2026-10-01 新增）的两个前提 + 接线必须还在。
// 现场证据：宿主重启后同一份会话日志出现 `request/header reason=resume` 紧跟一条 tool-registry
// 开发消息「移除：spawn_teammate, team_task_create, …」，随后 spawn_teammate / wait_agent 报
// unknown tool。修复方式是「按会话 id 记住开关，重启后再装回来」，它依赖下面两条官方事实。
const agentIndex = asar.read('dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js') || '';
check('dsh-agent 仍保证 agent.id === agent.session.id（会话记忆取 session id 的依据）', () => {
  if (agentIndex === '') return '读不到 dsh-agent/lib/index.js';
  if (!agentIndex.includes('agent.session.id')) {
    return '这条恒等式不见了 —— lib/runtime.js 的 sessionIdOf() 需要重新核对 key 的来源';
  }
  return true;
});

check('dsh-agent-loop 仍在 resume 路径上 announce（恢复判据：重启后同一会话会再发一次 agent/created）', () => {
  if (agentLoop === '') return '读不到 dsh-agent-loop/lib/index.js';
  const missing = ['"resume"', 'agents.announce'].filter((needle) => !agentLoop.includes(needle));
  return missing.length === 0
    ? true
    : `找不到 ${missing.join('、')} —— lib/resume.js 依赖「resume 时重新创建 agent」来补装团队工具`;
});

// 11c-5) 「注入会排队进用户输入框」这条机制判断（2026-10-01 18:26 用户截图的根因）必须仍然成立：
//   * `followup(input)` = `send(input, "next-turn", true)`（:806-808）→ 消息进 Session 的 next-turn 收件箱，
//     而客户端 QueueDock 正是从 next-turn 读（dsh-client-ui-conversation 的 README.zh.md：QueueDock 从
//     Session 的 inbox 投影读取 next-turn）→ 用户会看到一条排队行并需要点「插入」；
//   * 所以**只有用户自己打的话**才允许走 followup（即 `/team` 的注入）；工具路径改为走工具返回值；
//   * 而工具路径**本来就不需要注入**：系统提示词与工具目录每个 step 都重新组装
//     （preStep 的 assemble → step 里 `buildRequest(config, preparedCall, assembly.tools, …)`）。
// 这三条一旦变了，lib/playbook.js 末尾那段决策说明必须重写。
check('agent-loop 的投递语义未变（followup → next-turn 收件箱；工具每 step 重新组装）', () => {
  if (agentLoop === '') return '读不到 dsh-agent-loop/lib/index.js';
  if (!agentLoop.includes('send(input, "next-turn", true)')) {
    return 'followup 的目标不再是 next-turn —— 「注入会排队进用户输入框」的判据要重新核对（见 lib/playbook.js 末尾）';
  }
  if (!agentLoop.includes('send(input, "next-step", true)')) {
    return 'steer 的目标不再是 next-step —— 「需要打断当前轮时该用 steer」这条结论要重读 agent-loop';
  }
  if (!agentLoop.includes('assembly.tools')) {
    return '找不到 assembly.tools —— 工具目录可能不再每 step 重新组装，那样工具路径就必须注入消息（会排队）';
  }
  return true;
});

const subagentControl = asar.read('dsh/node_modules/@deepseek-ai/dsh-tool-subagent-control/lib/index.js') || '';
const subagentListAgents = asar.read('dsh/node_modules/@deepseek-ai/dsh-tool-subagent-control/lib/types/list-agents.js') || '';check('官方 dsh-tool-subagent-control 仍提供同名三工具 + agent_id 参数（我们收 agent_id 别名的原因）', () => {
  if (subagentControl === '') return '读不到 dsh-tool-subagent-control/lib/index.js';
  if (subagentListAgents === '') return '读不到 dsh-tool-subagent-control/lib/types/list-agents.js';
  // 分工（2026-10-01 实读）：lib/index.js 注册 send_message / interrupt_agent（都是 agent_id 参数），
  // list_agents 在可独立加载的子模块 lib/types/list-agents.js 里。
  const missing = ['send_message', 'interrupt_agent'].filter((name) => !subagentControl.includes(`"${name}"`));
  if (missing.length > 0) return `lib/index.js 不再注册 ${missing.join(', ')} —— 「重启后只剩三个名字」的归因需要重查`;
  if (!subagentControl.includes('agent_id')) return 'agent_id 参数不见了 —— lib/tools.js 的 target/agent_id 别名可以删掉';
  if (!subagentListAgents.includes("name: 'list_agents'")) return 'list_agents 不在这个包了 —— 「重启后只剩三个名字」的归因需要重查';
  return true;
});

check('lib/runtime.js 仍真的消费会话记忆（接线未被删除）', () => {
  const runtime = readFileOr(path.join(PLUGIN_DIR, 'lib', 'runtime.js'));
  if (runtime === '') return '读不到 lib/runtime.js';
  // 只看**调用点**，不看定义：光有 `restoreRemembered(` 这个名字（函数还在、但没人调）说明不了接线还在。
  // 顶层函数以列 0 的 `}` 结束，所以可以安全地切出函数体（插件里所有顶层函数都遵循这个缩进）。
  const bodyOf = (needle) => functionBodyOf(runtime, needle);
  const required = [
    ['function syncAgent(', 'restoreRemembered(ctx, agent, agentTeams)', 'syncAgent 里的恢复调用'],
    ['function enable(', 'rememberSession(agent, source)', 'enable() 里的落盘调用'],
    ['function disable(', 'forgetSession(sessionIdOf(agent))', 'disable() 里的删除调用'],
  ];
  const missing = required
    .filter(([fn, call]) => !bodyOf(fn).includes(call))
    .map(([, , label]) => label);
  return missing.length === 0 ? true : `lib/runtime.js 里找不到：${missing.join('、')}`;
});

check('lib/tools.js 的 wake_teammate 与 Lead 名单仍在（用户 2026-10-01 要的「队员唤醒」）', () => {
  const tools = readFileOr(path.join(PLUGIN_DIR, 'lib', 'tools.js'));
  if (tools === '') return '读不到 lib/tools.js';
  if (!tools.includes('WAKE_TOOL_NAME')) return 'wake_teammate 的定义不见了';
  const roster = readFileOr(path.join(PLUGIN_DIR, 'lib', 'roster.js'));
  if (!roster.includes('LEAD_TEAM_TOOL_NAMES')) return 'LEAD_TEAM_TOOL_NAMES 不见了';
  if (!roster.includes("WAKE_TOOL_NAME")) return 'WAKE_TOOL_NAME 不在 roster.js 里';
  const runtime = readFileOr(path.join(PLUGIN_DIR, 'lib', 'runtime.js'));
  if (!runtime.includes('LEAD_TEAM_TOOL_NAMES')) return 'Lead 的安装没有用 LEAD_TEAM_TOOL_NAMES（名单会漂移）';
  return true;
});

// 11c-6) 队员模型覆盖的优先级接线（2026-10-01 修的「面板上改回『跟随 Lead』不生效」）：
//   * `installRouteOverride` 必须**每次请求实时**读角色配置（`resolveRoleRoute(peekConfig()`），
//     并且用 `resolveMemberRoute(显式钉, 角色配置, 显式强度)` 合成；
//   * `spawn_teammate` 只许钉**工具调用显式给出的**参数（`pinSpawnRoute(name, …explicit…)`），
//     把角色配置一起钉住 = 那个队员永远不跟着面板走（用户报的正是这个）。
check('队员模型覆盖：显式 spawn 钉 > 实时角色配置 > 跟随 Lead（接线未被改回旧语义）', () => {
  const runtime = readFileOr(path.join(PLUGIN_DIR, 'lib', 'runtime.js'));
  if (runtime === '') return '读不到 lib/runtime.js';
  const listener = functionBodyOf(runtime, 'function installRouteOverride(');
  if (listener === '') return '找不到 installRouteOverride';
  const required = [
    ['resolveRoleRoute(peekConfig()', '每个请求实时读角色配置'],
    ['spawnEfforts.get(name)', '显式强度的单独账本'],
    ['resolveMemberRoute(explicit, roleRoute', '统一的优先级合成'],
  ];
  const missing = required.filter(([needle]) => !listener.includes(needle)).map(([, label]) => label);
  if (missing.length > 0) return `installRouteOverride 里找不到：${missing.join('、')}`;

  const tools = readFileOr(path.join(PLUGIN_DIR, 'lib', 'tools.js'));
  const spawn = functionBodyOf(tools, 'async execute(args, exec) {\n        const caller = callingAgent(exec.agent, \'spawn_teammate\')');
  if (spawn === '') return '找不到 spawn_teammate 的 execute';
  if (!spawn.includes('pinSpawnRoute(name, Object.keys(explicit).length === 0 ? undefined : explicit)')) {
    return 'spawn_teammate 不再只钉显式参数 —— 角色配置会被钉死，面板改成「跟随 Lead」对老队员就永远不生效';
  }
  return true;
});

// 11c-2) 「调度模式只有我们的团队」这条边界的接线必须在 lib/preset.js 里真的存在 ——
// 但**只允许**用「同名空段遮蔽官方 team:policy」这一种手段。
// ⚠️ 不许在 preset 作用域里 `tools.restrict` 那九个官方工具名：官方是给**每个 agent 自己的
// 作用域**装工具（不是全局层），restrict 只认全局层名字 → 必然全部失败，刷出 9 条假故障
// （2026-09-28 用户实际看到的红字）。真正的手段是在 profile patch 层关掉官方那一行（见 11c-3）。
check('lib/preset.js 仍遮蔽官方 team:policy 段，且没有误用 tools.restrict', () => {
  const preset = readFileOr(path.join(PLUGIN_DIR, 'lib', 'preset.js'));
  if (preset === '') return '读不到 lib/preset.js';
  const required = [
    ['suppressOfficialTeam', '遮蔽函数本体'],
    ['OFFICIAL_TEAM_POLICY_SECTION', '官方策略段名（同名空段遮蔽）'],
  ];
  const missing = required.filter(([needle]) => !preset.includes(needle)).map(([, label]) => label);
  if (missing.length > 0) return `lib/preset.js 里找不到：${missing.join('、')}`;
  // 只看**代码**，不看注释：这段的注释里正解释「为什么不能用 restrict」，不能被它误判。
  const codeOnly = preset.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line)).join('\n');
  if (/\brestrict\s*\(/u.test(codeOnly)) {
    return 'lib/preset.js 里出现了 tools.restrict —— 官方团队工具不在全局层，restrict 摘不掉它们，'
      + '只会刷出「未抑制官方工具 …」这类假故障（正确手段是 profile patch 层 disable 官方 tool-agent-team 行）';
  }
  return true;
});

// 11c-3) 官方工具行必须在 **profile 的 patch 层**被关掉。理由：官方 `tool-agent-team`
// 给每一个 live agent 都装九个工具（dsh-experimental-tool-agent-team :539-546 的 maybeInstall +
// 域服务 tryMembership 对任意非子代理 agent 返回 lead 身份），而本插件在**同一个 agent 作用域**
// 注册同样九个名字 → `tool "x" is already registered in this scope`，本插件的工具装不上、
// 角色/模型参数全丢。只能靠 profile 层（在所有 bundle 层之后应用）关掉，见 README §8.7。
check('profile 层 patch 里官方 tool-agent-team 行被关闭（否则本插件的九个工具装不上）', () => {
  const profilePatchPath = path.join(PROFILE_DIR, 'cordis.patch.yml');
  if (!fs.existsSync(profilePatchPath)) return `读不到 ${profilePatchPath}：跑 tools/repair.cjs --apply`;
  const text = fs.readFileSync(profilePatchPath, 'utf8');
  if (!/-\s*id:\s*tool-agent-team\s*\n\s*disabled:\s*true/u.test(text)) {
    return 'profile 的 cordis.patch.yml 里没有 `- id: tool-agent-team` + `disabled: true`：'
      + '官方九个工具会占住每个会话 agent 作用域的同名工具名，本插件的团队工具装不上（角色/模型参数不可用）。'
      + '跑 tools/repair.cjs --apply';
  }
  return true;
});

// 11c-4) 「工具撞车」必须被识别成**故障**（进红色通道），不许静默降级成官方工具。
check('lib/runtime.js 保留「同名工具撞车 → 可执行故障」的接线', () => {
  const runtime = readFileOr(path.join(PLUGIN_DIR, 'lib', 'runtime.js'));
  if (runtime === '') return '读不到 lib/runtime.js';
  const required = [
    ['团队工具注册失败', '失败文案'],
    ['problems', '故障通道数组'],
    ['repair.cjs', '修法提示'],
  ];
  const missing = required.filter(([needle]) => !runtime.includes(needle)).map(([, label]) => label);
  return missing.length === 0 ? true : `lib/runtime.js 里找不到：${missing.join('、')}`;
});

// 11d) 控制面的**作用域边界**：`/team` 与开关工具必须注册在调度模式的 preset 子树里，
//      **不许**在宿主平面注册 —— 在哪个作用域调用 `register` 就注册进哪个层，宿主平面 = 全局层
//      = 每一个 preset 的会话都能看到（2026-09-28 用户实测到的越界：极简灰度模式也能调 /team）。
//
//      两条历史原因叠在一起，所以这条检查值得留着：
//        * cordis 的 ctx 属性访问要求服务在**本 fiber 的 inject 列表**里；宿主平面的
//          commands / tools 是兄弟 fiber 提供的 → `ctx.commands` 抛
//          `cannot get property ... without inject`，异常被 try/catch 吞成一条 warn
//          （2026-09-28 的「输入 /team 没有这个指令」就是这么来的）；
//        * 在 preset 子树注册 → 只对该 preset 的会话可见（`dsh-commands` 的
//          `view(agent)` = 全局层 + 该 agent 的作用域链；`dsh-tools` 同理）。
check('控制面注册在 preset 子树（不是宿主平面），且没有 /team-off', () => {
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^[^\n]*?\/\/[^\n]*$/gmu, '');
  const indexSource = stripComments(readFileOr(path.join(PLUGIN_DIR, 'lib', 'index.js')));
  const presetSource = stripComments(readFileOr(path.join(PLUGIN_DIR, 'lib', 'preset.js')));
  if (indexSource === '' || presetSource === '') return '读不到 lib/index.js 或 lib/preset.js';

  if (/registerControls/u.test(indexSource)) {
    return 'lib/index.js 又调用了 registerControls —— 宿主平面注册会让**每一个 preset** 都能看到 /team（越界）';
  }
  if (/ctx\.(commands|tools)\b/u.test(indexSource)) {
    return 'lib/index.js 里出现了 ctx.commands / ctx.tools —— 宿主半不应该再碰控制面注册';
  }
  const hasInjectCall = /ctx\.inject\(\s*\[[^\]]*?['"]commands['"][^\]]*?['"]tools['"]/u.test(presetSource)
    || /ctx\.inject\(\s*\[[^\]]*?['"]tools['"][^\]]*?['"]commands['"]/u.test(presetSource);
  if (!hasInjectCall) {
    return "lib/preset.js 没有 ctx.inject(['commands','tools'], …) —— 它是「等依赖就绪 + 注册落在 preset 层」的唯一写法";
  }
  if (!/serviceOf\(ctx,/u.test(presetSource)) {
    return 'lib/preset.js 没有用 serviceOf(ctx, …) 取服务（它是唯一不依赖调用方 inject 的取法）';
  }

  // 命令面：只有 team，没有 team-off（用户 2026-09-28 明确要求去掉）。
  const libText = ['index.js', 'preset.js', 'tools.js', 'runtime.js', 'playbook.js', 'roster.js', 'client.js']
    .map((file) => readFileOr(path.join(PLUGIN_DIR, 'lib', file)))
    .join('\n');
  if (/name:\s*['"]team-off['"]/u.test(libText)) return 'lib/ 里仍然注册了 team-off 命令（用户明确要求去掉）';
  if (!/name:\s*['"]team['"]/u.test(libText)) return 'lib/ 里找不到命令定义 name: "team"';
  // 提示词也要跟着改：不许再教模型去用 `/team-off`（那个命令已经不存在）。
  const playbookText = readFileOr(path.join(PLUGIN_DIR, 'lib', 'playbook.js')).replace(/⛔[^\n]*/gu, '');
  if (playbookText.includes('`/team-off`')) {
    return 'lib/playbook.js 的提示词里仍然教模型用 `/team-off`（那个命令已经不存在了）';
  }
  if (!playbookText.includes('disable_agent_team')) {
    return 'lib/playbook.js 没有交代「关闭团队」的新做法（调 disable_agent_team）';
  }
  return true;
});
// ── 12) 依赖 lib/roster.js 真值的检查 ────────────────────────────────────────
// 本脚本是 CJS，lib/*.js 是 ESM → 只能动态 import。放在最后一段，避免影响上面的同步检查。
(async () => {
  let roster = null;
  try {
    roster = await import(pathToFileURL(path.join(PLUGIN_DIR, 'lib', 'roster.js')).href);
  } catch (error) {
    results.push({
      name: '动态 import lib/roster.js',
      ok: false,
      detail: `失败：${error && error.message ? error.message : String(error)}`,
    });
  }

  if (roster !== null) {
    const roleIds = [...roster.ROLE_IDS];
    const roleCount = roleIds.length;

    // 12a) 本插件的团队工具名单必须与官方工具包互相覆盖（消除「两份真值各飘各的」）
    check('本插件 TEAM_TOOL_NAMES 与官方工具包的名字完全一致', () => {
      const missing = [...roster.TEAM_TOOL_NAMES].filter((name) => !officialTool.includes(`"${name}"`));
      if (missing.length > 0) return `官方工具包里没有这些名字：${missing.join(', ')}（改名了？）`;
      const extra = OFFICIAL_TEAM_TOOL_NAMES.filter((name) => !roster.TEAM_TOOL_NAMES.includes(name));
      if (extra.length > 0) return `官方有而本插件没实现的名字：${extra.join(', ')}`;
      return true;
    });

    // 12b) 队员收窄名单里的每个名字都必须**有出处**。名字不存在时 restrict 会抛错，
    // runtime 逐个 try/catch 后只是「少摘一个」——静默降级正是这里要拦住的东西。
    // 三种合法出处：官方包里的工具名 / 我们 preset 行里配的 toolName / 本插件 host 平面自己注册的开关。
    check('TEAMMATE_TOOL_DENY 里的每个工具名都有出处（官方包 / preset toolName / 本插件开关）', () => {
      const sources = [
        asar.read('dsh/node_modules/@deepseek-ai/dsh-tool-goal/lib/index.js') || '',
        asar.read('dsh/node_modules/@deepseek-ai/dsh-tool-subagent/lib/index.js') || '',
        asar.read('dsh/node_modules/@deepseek-ai/dsh-tool-workflow/lib/index.js') || '',
      ];
      // preset 里 `toolName: subagent_fork` 这种：名字来自行 config，不在官方包源码里。
      const declaredToolNames = new Set(
        [...ourPresetPatch.matchAll(/toolName:\s*([A-Za-z0-9_-]+)/gu)].map((match) => match[1]),
      );
      // 本插件自己在 host 平面注册的开关工具（enable_agent_team / disable_agent_team）
      // 定义在 lib/tools.js 的 controlToolDefinitions 里，不在 preset.js。
      const oursControl = readFileOr(path.join(PLUGIN_DIR, 'lib', 'tools.js'))
        + readFileOr(path.join(PLUGIN_DIR, 'lib', 'preset.js'));
      const unknown = [];
      for (const name of roster.TEAMMATE_TOOL_DENY) {
        const fromOfficial = sources.some((source) => source.includes(`"${name}"`));
        const fromPreset = declaredToolNames.has(name);
        const fromOurs = oursControl.includes(`'${name}'`);
        if (!fromOfficial && !fromPreset && !fromOurs) unknown.push(name);
      }
      return unknown.length === 0
        ? true
        : `这些名字找不到出处：${unknown.join(', ')} —— 它们会被 restrict 拒绝，等于没收窄（静默）`;
    });

    // 12c) 被清空的提示词段名必须仍与官方注册的段名一致，否则我们清了一个不存在的段，
    // 队员的系统提示词里会留着「怎么用 create_goal / workflow」。
    check('TEAMMATE_SECTION_MUTES 的段名仍与官方注册的段名一致', () => {
      const goal = asar.read('dsh/node_modules/@deepseek-ai/dsh-tool-goal/lib/index.js') || '';
      const workflow = asar.read('dsh/node_modules/@deepseek-ai/dsh-tool-workflow/lib/index.js') || '';
      const problems = [];
      for (const mute of roster.TEAMMATE_SECTION_MUTES) {
        const source = mute.name.includes('goal') ? goal : workflow;
        if (source === '') { problems.push(`${mute.name}：读不到对应的官方包`); continue; }
        if (!source.includes(`"${mute.name}"`) && !source.includes(`tool:\${toolName}`) && !source.includes('`tool:${toolName}`')) {
          problems.push(`${mute.name}：官方侧找不到这个段名`);
        }
      }
      return problems.length === 0 ? true : `段名对不上：${problems.join('；')}`;
    });

    // 12d) 角色数量在**所有会写数字的文案**里都必须一致。
    // 旧版本这里是死代码：只判文件里出现包名，于是 client.js 写着「7 个角色」永远没人管。
    check(`所有文案里的角色数量都等于真实角色数 ${roleCount}`, () => {
      const files = {
        'lib/client.js': readFileOr(path.join(PLUGIN_DIR, 'lib', 'client.js')),
        'locale/zh.json': readFileOr(path.join(PLUGIN_DIR, 'locale', 'zh.json')),
        'locale/en.json': readFileOr(path.join(PLUGIN_DIR, 'locale', 'en.json')),
        'presets/dispatch-mode.patch.yml': ourPresetPatch,
        'package.json': readFileOr(path.join(PLUGIN_DIR, 'package.json')),
      };
      const wrong = [];
      const patterns = [
        /(\d+)\s*个角色/gu,
        /(\d+)\s*类队员/gu,
        /(\d+)\s*teammate roles/gu,
        /each of the (\d+)/gu,
      ];
      for (const [file, text] of Object.entries(files)) {
        if (text === '') continue;
        for (const pattern of patterns) {
          for (const match of text.matchAll(pattern)) {
            if (Number(match[1]) !== roleCount) wrong.push(`${file}: "${match[0]}"`);
          }
        }
      }
      return wrong.length === 0 ? true : `角色数写错（真实=${roleCount}）：${wrong.join('、')}`;
    });

    // 12e) 浏览器半不许硬编码角色表：角色表只能由宿主 get 返回（roster.js 是唯一真值）。
    check('lib/client.js 不含任何角色 id 字面量', () => {
      if (clientJs === '') return '读不到 lib/client.js';
      const offenders = roleIds.filter((id) => new RegExp(`['"\`]${id}['"\`]`, 'u').test(clientJs));
      return offenders.length === 0 ? true : `client.js 里出现了角色 id 字面量：${offenders.join(', ')}`;
    });

    // 12f) maxMembers 必须覆盖「每个角色各叫 3 次以上」——历史累计计数，队员名永不复用。
    check('agent-team 的 maxMembers 够覆盖每个角色多次', () => {
      const patch = readFileOr(path.join(PLUGIN_DIR, 'cordis.patch.yml'));
      const match = /maxMembers:\s*(\d+)/u.exec(patch);
      const maxMembers = match === null ? 0 : Number(match[1]);
      const needed = roleCount * 3;
      if (maxMembers < needed) {
        return `maxMembers=${maxMembers} < 角色数 ${roleCount} × 3 = ${needed}：长任务里会撞 TEAM_MEMBER_LIMIT（历史累计，名字不复用）`;
      }
      return true;
    });

    // ── 13) 缓存保活（2026-09-30 新增）────────────────────────────────────────
    // 保活钩的是官方 dsh-llm 的 `llm/stream` 瀑布。官方换个事件名/换成分发点，保活就**静默失效**
    // （不报错、只是再也不 ping），所以必须对着装机的 asar 钉住。
    const cacheJs = readFileOr(path.join(PLUGIN_DIR, 'lib', 'cache.js'));
    const toolsJs = readFileOr(path.join(PLUGIN_DIR, 'lib', 'tools.js'));
    const playbookJs = readFileOr(path.join(PLUGIN_DIR, 'lib', 'playbook.js'));
    const indexJs = readFileOr(path.join(PLUGIN_DIR, 'lib', 'index.js'));

    check('dsh-llm 仍有 "llm/stream" 瀑布，且 dispatch 点仍在 stream()', () => {
      const llm = asar.read('dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js') || '';
      if (llm === '') return '读不到 dsh-llm/lib/index.js';
      if (!llm.includes('"llm/stream"')) return 'dsh-llm 里找不到 "llm/stream" —— 保活的观察器永远收不到请求';
      if (!/stream\(options\)\s*\{\s*return this\.streamWithRegistration\(options\)/u.test(llm)) {
        return 'dsh-llm 的 stream(options) 形状变了 —— 复查 lib/cache.js 的重放前提（ctx.llm.stream 仍可调用）';
      }
      return true;
    });

    check('llm/stream 的监听器契约未变（瀑布：next() 的返回值即下游流）', () => {
      const llm = asar.read('dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js') || '';
      if (!llm.includes('this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared))')) {
        return 'waterfall 的调用形状变了 —— 监听器签名 (options, next) 可能不再成立';
      }
      return true;
    });

    check('保活默认策略：DeepSeek 线路仍是 off（磁盘缓存 + 可能按请求计费）', () => {
      if (cacheJs === '') return '读不到 lib/cache.js';
      const deepseek = /id:\s*'deepseek'[\s\S]{0,200}?mode:\s*'off'/u.test(cacheJs);
      if (!deepseek) return 'lib/cache.js 里 DeepSeek 线路族的 mode 不再是 off —— 那会在"缓存本来不会过期"的线路上白花钱';
      if (!cacheJs.includes("const DEFAULT_FAMILY") || !/mode:\s*'auto'/u.test(cacheJs)) return '兜底线路族不再是 auto（未知线路应当先要求缓存命中的证据）';
      return true;
    });

    check('保活的两条硬闸门仍在代码里：重入保护 + 连续未命中即停', () => {
      if (cacheJs === '') return '读不到 lib/cache.js';
      const problems = [];
      if (!cacheJs.includes('state.reentrant')) problems.push('找不到重入保护（ping 会被自己再抓一次）');
      if (!cacheJs.includes('MISS_STOP_THRESHOLD')) problems.push('找不到「连续未命中即停」的常量');
      if (!cacheJs.includes('PINGS_PER_SESSION_CAP') || !cacheJs.includes('PING_TOKEN_CAP')) problems.push('找不到会话级保险丝');
      if (!cacheJs.includes('maxTokens: PING_MAX_TOKENS')) problems.push('ping 没有固定 maxTokens=1');
      return problems.length === 0 ? true : problems.join('；');
    });

    check('Lead/队员 系统提示词指纹仍在（保活靠它区分是谁的请求）', () => {
      if (playbookJs === '') return '读不到 lib/playbook.js';
      const leadMarker = /export const LEAD_MARKER = '([^']+)'/u.exec(playbookJs);
      const mateMarker = /export const TEAMMATE_MARKER = '([^']+)'/u.exec(playbookJs);
      if (leadMarker === null || mateMarker === null) return 'lib/playbook.js 里缺少 LEAD_MARKER / TEAMMATE_MARKER';
      const playbook = readFileOr(path.join(PLUGIN_DIR, 'lib', 'playbook.js'));
      if (!playbook.includes(leadMarker[1])) return `LEAD_MARKER "${leadMarker[1]}" 不在文本里 —— 保活会认不出 Lead`;
      if (!playbook.includes(mateMarker[1])) return `TEAMMATE_MARKER "${mateMarker[1]}" 不在文本里 —— 保活会把队员请求当 Lead`;
      if (!cacheJs.includes('leadMarker') || !cacheJs.includes('teammateMarker')) return 'lib/cache.js 没有使用这两个指纹';
      return true;
    });

    check('宿主平面确实安装了保活观察器（lib/index.js 调 runtime.installKeepalive）', () => {
      if (indexJs === '') return '读不到 lib/index.js';
      if (!indexJs.includes('runtime.installKeepalive(ctx)')) return 'lib/index.js 没有安装保活观察器 —— 面板会一直显示未安装';
      return true;
    });

    // 工具 schema 的坑（2026-09-30 真踩过）：DSH 的 defineTool 要求每个 object schema 显式声明
    // additionalProperties。漏一个 → **整个 Agent 的工具安装失败**（队员拿不到任何团队工具），
    // 而且报错只出现在安装日志里。这条闸门扫所有 `_SCHEMA` 常量。
    check('lib/tools.js 的每个输出 schema 都显式声明 additionalProperties', () => {
      if (toolsJs === '') return '读不到 lib/tools.js';
      const blocks = [...toolsJs.matchAll(/const ([A-Z_]+_SCHEMA) = \{[\s\S]*?\n\};/gu)];
      if (blocks.length === 0) return '一个 *_SCHEMA 都没扫到（正则漂了？）';
      const missing = blocks
        .filter((block) => /type:\s*'object'/u.test(block[0]) && !/additionalProperties/u.test(block[0]))
        .map((block) => block[1]);
      return missing.length === 0 ? true : `这些 schema 缺 additionalProperties（会让整套工具装不上）：${missing.join(', ')}`;
    });

    check('report_result 仍是队员专用（不进 Lead 的工具目录）', () => {
      if (toolsJs === '') return '读不到 lib/tools.js';
      if (!toolsJs.includes('const memberOnly = new Set([REPORT_TOOL_NAME])')) return '找不到「队员专用」的过滤逻辑';
      if (!toolsJs.includes('!memberOnly.has(definition.name)')) return 'Lead 的工具目录没有排除队员专用工具';
      if (!roster.MEMBER_TEAM_TOOL_NAMES.includes(roster.REPORT_TOOL_NAME)) return 'MEMBER_TEAM_TOOL_NAMES 里没有 report_result';
      if (roster.TEAM_TOOL_NAMES.includes(roster.REPORT_TOOL_NAME)) return 'report_result 混进了官方九工具名单（会污染同名冲突判定）';
      return true;
    });
  }

  // ── 输出 ───────────────────────────────────────────────────────────────────
  let failed = 0;
  console.log('结果：');
  for (const result of results) {
    if (result.ok) {
      console.log(`  PASS  ${result.name}`);
    } else {
      failed += 1;
      console.log(`  FAIL  ${result.name}`);
      console.log(`        → ${result.detail}`);
    }
  }
  console.log('');
  console.log(`${results.length - failed}/${results.length} 通过。`);

  if (failed > 0) {
    console.log('');
    console.log('有 FAIL：官方实现与本插件的假设已经不一致。按上面每条的「→」提示修本插件，');
    console.log('不要改 app.asar（升级会被覆盖）。修完重跑本脚本。');
  }

  asar.close();
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error('[drift-check] 检查流程本身崩了：', error);
  try { asar.close(); } catch { /* 已经关掉了 */ }
  process.exit(2);
});