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

// 定位统一走 tools/lib-dsh-home.cjs（P1-7）：漂移检测必须对着真正在用的 profile 校验，
// 否则报告错对象。
const PROFILE_DIR = require('./lib-dsh-home.cjs').resolveProfileDir({ explicit: argValue('--profile') }).profileDir;

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
/**
 * 报告器契约（2026-10-04 审查 P2-19 收紧，改之前先读）：
 *   * 返回 true            -> PASS
 *   * 返回**非空字符串**    -> FAIL（字符串就是原因）
 *   * 返回 skipCheck(...)   -> SKIP：既不算过也不算失败，单列计数
 *   * 什么都不返回          -> 仍按 PASS，但会打一条告警：漏写 return 的检查是**假绿灯**，
 *                             旧版把它静默当成通过（P2-19 的一条根因）
 */
const SKIP_PREFIX = '\u0000dsh-skip\u0000';
function skipCheck(reason) {
  return SKIP_PREFIX + String(reason ?? '未说明');
}
function isSkip(value) {
  return typeof value === 'string' && value.startsWith(SKIP_PREFIX);
}
function check(name, fn) {
  try {
    const outcome = fn();
    if (isSkip(outcome)) {
      results.push({ name, ok: true, skipped: true, detail: outcome.slice(SKIP_PREFIX.length) });
      return;
    }
    if (outcome === void 0) {
      results.push({ name, ok: true, detail: '', missingReturn: true });
      return;
    }
    results.push({ name, ok: outcome === true, detail: outcome === true ? '' : String(outcome) });
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
  // P2-19④：要求 `name: "x"` 这一定义形状，而不是裸 `"x"` 子串 —— 后者连
  // 「名字只出现在注释或错误文案里」都算命中。实测今日九个全部以该形状出现。
  const missing = OFFICIAL_TEAM_TOOL_NAMES.filter((name) => !officialTool.includes(`name: "${name}"`));
  return missing.length === 0 ? true : `官方工具包里找不到这些工具定义：${missing.join(', ')} —— 本插件的 lib/tools.js 需要对齐`;
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
  // P2-19④：旧写法判据是 `name + '('`，那**不区分定义与调用点**——官方内部大量互相调用
  // （如 roster 里的 `this.tryMembership(agent)`、`this.ctx.subagents.interrupt(target.id, …)`），
  // 所以哪怕域服务上那个方法整个被删，检查也照样绿。改成要求「行首缩进 + (async )?名字 + (」
  // 这一**定义**形状；实测今日 11 个方法全部命中（397/387/1755/1764/1773/1782/1791/1799/1808/1818/503）。
  const missing = methods.filter((name) => !new RegExp('^\\s{0,10}(?:async\\s+)?' + name + '\\s*\\(', 'mu').test(officialDomain));
  return missing.length === 0 ? true : '域服务里找不到这些**方法定义**：' + missing.join(', ');
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

// 6b) 命令附件闸：宿主按 `definition.input.attachments === true` 决定收不收附件
//     （2026-10-07 用户实测：/team 贴图被拒「不接受附件，请先移除附件」，判据在
//      dsh-commands/lib/types/index.js:330）。本插件靠 `input: {attachments: true}` 过闸，
//      所以这个字段名与这条判据必须钉住：宿主一旦改名（比如 acceptsAttachments），
//      我们的声明会**静默失效** —— 插件照常加载、/team 照常能用，只有带附件时又变回那条报错。
const commandsTypes = asar.read('dsh/node_modules/@deepseek-ai/dsh-commands/lib/types/index.js') || '';
check('宿主仍按 definition.input.attachments 决定命令可否收附件（/team 的声明依赖它）', () => {
  if (commandsTypes === '') return '读不到 dsh-commands/lib/types/index.js';
  if (!commandsTypes.includes('input?.attachments !== true')) {
    return '判据写法变了：确认宿主是否仍用 input.attachments 这个字段名 —— 若改名，'
      + 'lib/preset.js 里 /team 的 `input: {attachments: true}` 会静默失效（带附件又被拒）';
  }
  if (!commandsTypes.includes('does not accept attachments')) {
    return '宿主不再返回「does not accept attachments」：附件闸可能已整体移除（那是改进，可去掉我们的顾虑）';
  }
  return true;
});
check('官方 /plan、/goal 仍声明 attachments: true（我们照抄的先例仍然成立）', () => {
  const plan = asar.read('dsh/node_modules/@deepseek-ai/dsh-plan-mode/lib/index.js') || '';
  const goal = asar.read('dsh/node_modules/@deepseek-ai/dsh-command-goal/lib/index.js') || '';
  if (plan === '' || goal === '') return '读不到 dsh-plan-mode 或 dsh-command-goal 的 lib/index.js';
  const missing = [['/plan', plan], ['/goal', goal]].filter(([, text]) => !text.includes('attachments: true')).map(([n]) => n);
  if (missing.length > 0) {
    return `${missing.join('、')} 不再声明 attachments: true —— 这个字段可能已被官方废弃，检查 /team 的写法`;
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

// 8c) 工作区入口依赖的官方 DOM 标记与槽位（2026-10-08 落地时加的闸门）。
// 入口「进入工作区」是注入进**官方成员面板**的（面板整体在只读 app.asar 里，我们改不动它的 JSX），
// 靠的是三个官方事实：面板根的 data-team-panel、触发器的 data-team-action、
// 以及我们注册的槽 conversation.session.header.actions 会注入的 sessionId prop。
// 官方任何一处改名都会让按钮**静默不出现**（用户看不到入口，也没有任何报错）——
// 所以这三条必须钉成可跑断言，飘了就红，而不是等用户报「入口没了」。
const officialTeamUi = asar.read('dsh/node_modules/@deepseek-ai/dsh-experimental-client-ui-agent-team/lib/client.js') || '';
const officialUiSession = asar.read('dsh/node_modules/@deepseek-ai/dsh-client-ui-session/lib/client.js') || '';
check('工作区入口依赖的官方面板标记与 sessionId prop 仍在（改名会让按钮静默消失）', () => {
  if (officialTeamUi === '') return '读不到 dsh-experimental-client-ui-agent-team/lib/client.js';
  if (officialUiSession === '') return '读不到 dsh-client-ui-session/lib/client.js';
  const missing = [];
  if (!officialTeamUi.includes('"data-team-panel"')) missing.push('面板根 data-team-panel');
  if (!officialTeamUi.includes('"data-team-action"')) missing.push('触发器 data-team-action');
  if (!officialTeamUi.includes('"conversation.session.header.actions"')) missing.push('槽 conversation.session.header.actions');
  // sessionId 是 session 作用域的标准注入 prop（BUILTIN_SOURCE.props）；锚点靠它拿权威会话 id。
  if (!/props:\s*\[\s*"sessionId"/u.test(officialUiSession)) missing.push('session 作用域注入的 sessionId prop');
  return missing.length === 0 ? true : `官方这些标记变了，lib/client.js 的入口注入要跟着改：${missing.join('、')}`;
});

// 8d) 工作区画布读取的官方**团队事件字段名**（2026-10-08 落地时加的闸门）。
// lib/graph.js 折叠会话日志时按字段名取值：读错了不会抛错，只会让某条通道**静默变成 0**
// （实测踩过两次：team/message/delivered 是扁平形状、不带 message 包装，按 data.message 读
// 让投递回执一直是死代码）。官方改名时这条闸门必须先红，而不是等用户发现「线不见了」。
const officialTeamCore = asar.read('dsh/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/index.js') || '';
check('工作区读取的官方团队事件字段名仍在（改名会让画布的边/统计静默变 0）', () => {
  if (officialTeamCore === '') return '读不到 dsh-experimental-agent-team/lib/index.js';
  const missing = [];
  // team/message/queued：data.message.{id,senderName,targetId}（lib/graph.js 的 msgFrom/msgSender 依赖）
  if (!/senderName:\s*[A-Za-z_$][\w$]*\.name/u.test(officialTeamCore) && !officialTeamCore.includes('senderName:')) {
    missing.push('team/message 的 senderName');
  }
  if (!officialTeamCore.includes('targetId')) missing.push('team/message 的 targetId');
  // team/message/delivered：**扁平**（version/teamId/messageId/targetId），不是 message 包装。
  if (!/appendAndFlush\([^)]*"team\/message\/delivered"/u.test(officialTeamCore)) {
    missing.push('team/message/delivered 的落盘点');
  }
  if (!officialTeamCore.includes('messageId')) missing.push('team/message/delivered 的 messageId');
  // team/member：data.member.{id,name}（节点名来源）
  if (!officialTeamCore.includes('"team/member"')) missing.push('team/member 事件名');
  return missing.length === 0
    ? true
    : `官方团队事件的字段/事件名变了，lib/graph.js 的折叠要跟着改（否则画布静默缺边或统计为 0）：${missing.join('、')}`;
});

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
  // P2-19①：必须锚定到**非注释的 YAML 行**上的 `- id:`。旧正则的裸子串会命中注释里的
  // 同名字样 —— 官方把行删了、注释还提它，就会假 PASS。
  const nonComment = officialProfilePatch.split('\n').filter((line) => !/^\s*#/u.test(line)).join('\n');
  const missing = ['agent-team', 'tool-agent-team', 'ui-agent-team']
    .filter((id) => !new RegExp(`^\\s*-\\s+id:\\s*${id}\\s*$`, 'mu').test(nonComment));
  return missing.length === 0 ? true : `官方 insert 里缺行 id：${missing.join(', ')}`;
});


// 8b) 我们自己重新挂载官方 UI 包的那一行必须还在（2026-10-04 审查 P1-8 步骤 3）。
// 为什么需要这条：README 曾经把「我们已不再重复挂载」写成事实（P1-8），后来 panel 行加回，
// 靠的是人工发现。若将来有人按那份旧 README 把行删掉，**没有任何闸门会响**，
// 用户关掉官方 ui-agent-team 行时成员列表/任务看板会静默消失。只读文本级断言，够了。
check('本包 cordis.patch.yml 仍用自有行 id 重新挂载官方 UI 包（删掉它看板会静默消失）', () => {
  if (oursPatch === '') return '读不到 cordis.patch.yml';
  const panelRow = /-\s*id:\s*dispatch-agent-team-panel\b[\s\S]{0,200}?name:\s*'?(@deepseek-ai\/dsh-experimental-client-ui-agent-team)'?/u.exec(oursPatch);
  if (panelRow === null) {
    return 'cordis.patch.yml 里找不到 dispatch-agent-team-panel 行（或它的 name 不再是官方 UI 包）——'
      + ' MAINTAINER-NOTES.md §1.4 明确靠这一行保证「用户关掉官方 ui-agent-team 时成员列表与看板仍在」，删掉即功能静默降级';
  }
  return true;
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

// 10f) dsh-ops 原生链接（2026-10-15 改版：不再内嵌，两插件各自启用）。
// 本包侧的静态事实（cordis.patch.yml 不得再有自带 ops 行）+ profile 侧的挂载事实
// （四行 disabled:false）+ 装机 dsh-ops 侧的实现事实（工具前缀/注册点/PTC 门已放宽）。
// bundle 层顺序不可靠（谁在前取决于用户启用顺序），profile 层是唯一顺序无关的落点。
check('dsh-ops 原生链接：本包无自带 ops 行 + profile 四行 disabled:false', () => {
  const oursPatch = fs.readFileSync(path.join(PLUGIN_DIR, 'cordis.patch.yml'), 'utf8');
  if (/^\s*-\s*id:\s*ops-file\s*$/m.test(oursPatch)) {
    return '本包 cordis.patch.yml 又出现了自带的 ops-file 行：2026-10-15 已按用户要求删除内嵌，' +
          + 'ops_* 的唯一来源是独立 dsh-ops 插件（留着这行会与它的 dsh-ops-file 行重复注册 ops_*）。';
  }
  const profilePatchPath = path.join(PROFILE_DIR, 'cordis.patch.yml');
  if (!fs.existsSync(profilePatchPath)) return `读不到 ${profilePatchPath}：无法验证四组件的启用状态`;
  // 判据复用 tools/ops-enable.cjs 的 plan()（同一份真值，不在这里重写一遍正则 ——
  // 两处各写一份就会各自漂，那是本仓库反复栽过的坑）。plan 报"要翻转/要补行"= 不健康。
  const { plan, splitRows } = require('./ops-enable.cjs');
  const planResult = plan(fs.readFileSync(profilePatchPath, 'utf8'));
  if (planResult.flipped.length > 0) {
    return 'profile 层这些行仍是 disabled: true：' + planResult.flipped.join(', ')
      + ' —— 组件不会挂载（交付要求四组件全开）。修法：node tools/ops-enable.cjs 然后重启 DSH。';
  }
  if (planResult.appended.length > 0) {
    return 'profile 层缺这些行：' + planResult.appended.join(', ')
      + ' —— 会退回 dsh-ops 自带默认（background/ptc 是关的）。修法：node tools/ops-enable.cjs 然后重启 DSH。';
  }
  // 逐键不齐也算不健康：plan() 会把已有行的 config 与 ROWS 对齐（publishBashTool /
  // extraGuidance / bashPath / 迁移标记）。漏掉这一条就会出现「ROWS 改了、真 profile 没跟上、
  // 而 drift 仍报绿」—— 本仓库 2026-10-16 真的这样假绿灯过一次（ops-enable --check 说齐备，
  // 实际 shell 行还停在 publishBashTool: false）。
  if (planResult.patched.length > 0) {
    return 'profile 层这些行的 config 与本包期望不一致（plan 会补齐）：' + planResult.patched.join(', ')
      + '。修法：node tools/ops-enable.cjs 然后重启 DSH。';
  }
  // 迁移标记（P1，2026-10-15 实测）：dsh-ops 的 updatedConfig()（lib/config-updates.js:9-14）会把
  // 「没有 configUpdateVersion 且 allowSystemShellFallback: true」的行改成 false 并**写回 profile**
  // （mountConfigUpdates 里的 entry.parent.tree.write()）。而 background 那四个 job 工具的发布门
  // 正好要这个 true（lib/tools.js:311-316）—— 不声明标记 = 首次启动就被静默关掉。
  // 行块切分复用 ops-enable 的 splitRows()（同一份真值，且这里刻意不新写正则：往测试里塞
  // 带反斜杠的正则会被多层转义吃掉，本仓库已为此返工两次）。
  const profileLines = fs.readFileSync(profilePatchPath, 'utf8').split(String.fromCharCode(10));
  const blockOf = (id) => {
    const hit = splitRows(profileLines).find((row) => row.id === id);
    return hit === undefined ? null : profileLines.slice(hit.start, hit.end + 1).join(String.fromCharCode(10));
  };
  for (const id of ['dsh-ops-shell', 'dsh-ops-file', 'dsh-ops-background']) {
    const block = blockOf(id);
    if (block === null) return 'profile 里没有 ' + id + ' 行（上面的 plan 判据没抓到？）';
    if (block.indexOf('configUpdateVersion: 1') < 0) {
      return 'profile 的 ' + id + ' 行缺 configUpdateVersion: 1 —— dsh-ops 的配置迁移会改写这一行'
        + '（background 的 allowSystemShellFallback 被翻成 false，四个 job 工具静默消失）。'
        + '修法：node tools/ops-enable.cjs 后重启 DSH。';
    }
  }
  // bashPath（条件闸门）：没有 Git bash 的机器不该误报，但写了就必须存在 ——
  // 一个指向不存在文件的 bashPath 比没有更糟（ops 会直接 available:false，四个 job 工具消失）。
  {
    const { detectBash } = require('./ops-enable.cjs');
    const found = detectBash();
    const bgBlock = blockOf('dsh-ops-background');
    const declared = /bashPath:\s*(\S.*)$/m.exec(bgBlock);
    if (found !== null && declared === null) {
      return '本机探测到可用 bash（' + found + '）但 profile 的 dsh-ops-background 行没有 bashPath：'
        + 'PATH 兜底会选中 WindowsApps 的 WSL 启动器（dsh-ops 只排除 System32 那个，lib/shells.js:481-487），'
        + 'FastCtx 实测拒绝执行。修法：node tools/ops-enable.cjs 后重启 DSH。';
    }
    if (declared !== null) {
      const raw = declared[1].trim().replace(/^["']|["']$/g, '');
      if (!fs.existsSync(raw)) {
        return 'profile 的 dsh-ops-background 行写了 bashPath 但那个文件不存在：' + raw
          + ' —— ops 会解析成 available:false，四个 job 工具全部消失。删掉这一行或改成真实路径，然后重启。';
      }
    }
  }

  if (blockOf('dsh-ops-background').indexOf('allowSystemShellFallback: true') < 0) {
    return 'profile 的 dsh-ops-background 行没有 allowSystemShellFallback: true —— 它的发布门要 bash 可解析'
      + '（dsh-ops lib/tools.js:311-316），本机没装 @dsh-ops/bash-win32-x64，缺这一条那四个 job 工具一个都不出。';
  }
  const ptcBlock = blockOf('dsh-ops-ptc');
  if (ptcBlock !== null && ptcBlock.indexOf('configUpdateVersion') >= 0) {
    return 'profile 的 dsh-ops-ptc 行带了 configUpdateVersion —— resolvePtcConfig 只认 binaryPath/required，'
      + '多给键会抛 Unknown PTC config key、整行挂载失败（本机实测：ptcRejectsMarker）。';
  }
  // 本包不得再依赖 vendor：目录与 exports 子路径都必须不存在。
  if (fs.existsSync(path.join(PLUGIN_DIR, 'vendor'))) return 'vendor/ 目录又出现了：内嵌 ops 已按用户要求删除';
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'));
  if (pkg.exports?.['./ops-file'] !== undefined) return 'package.json 又出现了 ./ops-file 导出（vendor 入口）';
  return true;
});

// 10g) 装机 dsh-ops 的实现事实：工具前缀与注册点没改名 + PTC 门已放宽到 ptc+both。
// 这一条把「别人下载本插件后能不能用 ops」的前提钉住：ops 一旦升级，判据可能变化。
check('装机 dsh-ops 的 ops_* 口径与 PTC 呈现档门（适配层的依赖面）', () => {
  const { createRequire } = require('node:module');
  let pkgJson;
  try {
    pkgJson = createRequire(path.join(PROFILE_DIR, 'package.json')).resolve('dsh-ops/package.json');
  } catch {
    return true; // 没装 dsh-ops：本包不依赖它，适配层自动静默，无需报失败。
  }
  const root = path.dirname(pkgJson);
  const version = JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version ?? '?';
  const policy = fs.readFileSync(path.join(root, 'lib', 'policy.js'), 'utf8');
  if (!/export const TOOL_PREFIX = 'ops_'/.test(policy)) return `dsh-ops ${version} 的 TOOL_PREFIX 变了：lib/ops-adapter.js 的 OPS_TOOL_NAMES 需要逐名重核`;
  for (const [needle, what] of [
    ["FILE_TOOLS = Object.freeze(['inspect_local_file', 'grep', 'glob', 'replace'])", 'file 组件的四个工具名'],
    ["BACKGROUND_TOOLS = Object.freeze(['run_background', 'job_output', 'job_list', 'job_kill'])", 'background 组件的四个工具名'],
  ]) {
    if (!policy.includes(needle)) return `dsh-ops ${version} 的 ${what} 与本包适配层的名单不一致（OPS_TOOL_NAMES 需要重核）`;
  }
  // 本包**不改 dsh-ops 的源码**（用户 2026-10-15 明令）。这里只核对两件事：
  // ① 装机那份的注册门仍是原版形状（只认纯 ptc）—— 若哪天它变了，本包的
  //    「预设 ptc + 关批量档 = 拿到 ops_batch/ops_result」这条杠杆的说明就要重核；
  // ② 宿主侧的装配段名没漂（本包判断呈现档只用这两个公开段名）。
  const ptcIndex = fs.readFileSync(path.join(root, 'lib', 'ptc', 'index.js'), 'utf8');
  if (!ptcIndex.includes("assembly.tools.length === 1 && assembly.tools[0].name === 'run_code'")) {
    return 'dsh-ops ' + version + ' 的 PTC 注册门不再是原版形状（只认纯 ptc 那条判据没找到）：' 
      + '本包 INTERFACES §3.8 与 lib/ops-adapter.js 里「纯 PTC 档才给 ops_batch/ops_result」的说明需要重核。';
  }
  const toolsSrc = asar.read('dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js') || '';
  if (toolsSrc === '') return '读不到 app.asar 里的 dsh-tools：无法验证呈现档的装配段名';
  if (!/name:\s*"tools:sdk"/.test(toolsSrc) || !/name:\s*"tools:ptc-only"/.test(toolsSrc)) {
    return '宿主 dsh-tools 的装配段名变了（tools:sdk / tools:ptc-only）：本包按呈现档给的指引与检测判据需要重核';
  }
  return true;
});
// 10e) 依赖解析接线：本包以 link: 安装时 Node 解析到真实路径，需要一个指向
// <dshHome>/profiles/node_modules 的 junction，否则 @deepseek-ai/dsh-tools 在
// **模块加载期**解析失败，host 行无法激活（首次安装实测就是这么失败的）。
check('依赖解析 junction 可用（加载期硬依赖 + 体检脚本的依赖逐个可解析）', () => {
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
  const { createRequire } = require('node:module');
  const req = createRequire(path.join(PLUGIN_DIR, 'lib', 'tools.js'));
  // 注意：2026-10-05：以前**只探 dsh-tools 一个包**。结果是「体检全绿」与
  // 「integration-test exit 2」并存——本机实测 cordis 解析不到（junction 目录里没有这条），
  // 而 integration-test 需要五个包。同一条假绿灯在 repair.cjs 里也修了；
  // 下面那条 10e-2 闸门保证两份清单不会各自漂。
  try {
    const resolved = req.resolve('@deepseek-ai/dsh-tools');
    if (!resolved.includes('dsh-tools')) return `解析到了意外路径：${resolved}`;
  } catch (error) {
    return `仍不可解析（${error.code || error.message}）：host 行会在 import 阶段失败`;
  }
  return true;
});

check('体检脚本的依赖清单与本插件的探测清单一致（两份清单不许各自漂）', () => {
  const repairSource = readFileOr(path.join(PLUGIN_DIR, 'tools', 'repair.cjs'));
  const integrationSource = readFileOr(path.join(PLUGIN_DIR, 'tools', 'integration-test.cjs'));
  if (repairSource === '' || integrationSource === '') return '读不到 repair.cjs 或 integration-test.cjs';
  const probes = new Set([...repairSource.matchAll(/\{ name: '(@deepseek-ai\/[a-z0-9-]+)', hard: (true|false) \}/gu)].map((m) => m[1]));
  if (probes.size === 0) return 'repair.cjs 里找不到 DEPENDENCY_PROBES 清单（形状变了？）';
  const needed = new Set([...integrationSource.matchAll(/from '(@deepseek-ai\/[a-z0-9-]+)'/gu)].map((m) => m[1]));
  const missing = [...needed].filter((name) => !probes.has(name));
  if (missing.length > 0) {
    return `integration-test.cjs 依赖但这些包不在体检探测清单里：${missing.join(', ')}`
      + ' —— 探测清单漏了包，体检就会再次出现「这边报 OK、那边 exit 2」的假绿灯';
  }
  return true;
});

// 10f) 本插件对官方包的使用面：@deepseek-ai/dsh-tools 的 defineTool 仍导出。
// 旧版本只判「文件在不在」——官方删掉这个导出它照样 PASS，等于一条假绿灯。
const HOST_TOOLS_INDEX = 'dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
check('@deepseek-ai/dsh-tools 仍导出 defineTool', () => {
  const source = asar.read(HOST_TOOLS_INDEX);
  if (source === void 0) return 'dsh-tools 包不在安装闭包里';
  // P2-19④：裸 /defineTool/ 连「只有注释里提到」都算过。要求看到**定义**形状
  // （function defineTool / const defineTool =）或 **export 块里有它**，二者满足其一。
  const declared = /function defineTool\b/u.test(source) || /const defineTool\b/u.test(source);
  const exported = /export \{[^}]*\bdefineTool\b[^}]*\}/u.test(source);
  if (!declared && !exported) {
    return 'defineTool 的定义/导出都找不到了 —— lib/tools.js 的静态 import 会拿到 undefined，九个工具全部注册失败';
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
// 注意最后那条是**注释金丝雀**：它判的是官方源码里的英文注释原文，不是行为。
// 官方只改措辞（语义没变）也会让这一条 FAIL —— 那不是回归，是提醒「去重读一遍实现」。
check('dsh-tools 仍提供 restrict() 且仍是「只过滤继承面」的语义（末条为注释金丝雀，可能只是措辞变化）', () => {
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
  if (profilePatch === '' || ourPresetPatch === '') return skipCheck('读不到 profile 或本包的 patch：本项无对象可比');
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
  if (section === '') return skipCheck('读不到极简灰度那一段：本项无对象可比');
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
// 注意：不许在 preset 作用域里 `tools.restrict` 那九个官方工具名：官方是给**每个 agent 自己的
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
// 角色/模型参数全丢。只能靠 profile 层（在所有 bundle 层之后应用）关掉，见 MAINTAINER-NOTES.md §8.7。
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
  const playbookText = readFileOr(path.join(PLUGIN_DIR, 'lib', 'playbook.js')).replace(/禁止：[^\n]*/gu, '');
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
        // TEAMMATE_TOOL_DENY 里的 ask_user_question 出处在这里（2026-10-04 P2-30 加入名单）。
        asar.read('dsh/node_modules/@deepseek-ai/dsh-tool-ask-user/lib/index.js') || '',
        // skill 的出处（2026-10-07 补）：`skill` 由 preset 行 tool-skill 注册在 **preset 作用域**，
        // 而 restrict 的 restrictableNames 取自「全局 + 作用域链祖先」（dsh-tools view() :2960-2973），
        // 所以队员作用域**摘得掉**它 —— 这条名单必须认得出它，否则 12g 的报警会混进一条
        // 「找不到出处」的假因（本轮实测：两个 FAIL 一起报，真因被埋在假因里）。
        asar.read('dsh/node_modules/@deepseek-ai/dsh-tool-skill/lib/index.js') || '',
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
      // P2-19②：段名 -> 官方包用**显式映射表**（旧写法「含 goal 就查 goal 包、否则一律查 workflow」，
      // 新增第三类段就会查错源）。也不再拿「源码里出现 tool:${toolName} 模板」当**无条件** PASS ——
      // 那会让「官方改了默认值」或「我们在 preset 里覆盖了 toolName」这两种真漂移照样绿。
      // 模板段名的正确判据：反查该包 toolName 的默认值拼出的段名 == mute.name，且我们那一行没覆盖 toolName。
      const MUTE_SOURCES = {
        'tool:goal': { entry: 'dsh/node_modules/@deepseek-ai/dsh-tool-goal/lib/index.js', row: 'tool-goal' },
        'tool:workflow': { entry: 'dsh/node_modules/@deepseek-ai/dsh-tool-workflow/lib/index.js', row: 'tool-workflow' },
      };
      const problems = [];
      for (const mute of roster.TEAMMATE_SECTION_MUTES) {
        const source = MUTE_SOURCES[mute.name];
        if (source === undefined) { problems.push(mute.name + '：映射表里没有这个段名（新增 mutes 要同时补映射）'); continue; }
        const text = asar.read(source.entry) || '';
        if (text === '') { problems.push(mute.name + '：读不到对应的官方包'); continue; }
        if (text.includes('"' + mute.name + '"')) continue; // 官方注册的就是这个逐字段名（dsh-tool-goal 的现状）
        // 只剩「模板段名」这一种合法可能：`tool:${toolName}`（dsh-tool-workflow 的现状）。
        if (!text.includes('`tool:' + String.fromCharCode(36) + '{toolName}`')) { problems.push(mute.name + '：官方侧既没有这个逐字段名，也不是模板段名'); continue; }
        const defaulted = /toolName: z\.string\(\)\.default\("([a-z0-9_-]+)"\)/u.exec(text);
        if (defaulted === null) { problems.push(mute.name + '：官方用模板段名，但 toolName 默认值找不到了'); continue; }
        if ('tool:' + defaulted[1] !== mute.name) { problems.push(mute.name + '：官方默认 toolName 现在拼出的是 tool:' + defaulted[1]); continue; }
        // 我们自己那一行若覆盖了 toolName，段名就跟着变了 —— 必须按**行块**查，不能全文扫
        // （preset 里 subagent 那几行本来就有 toolName 覆盖，全文扫会误报）。
        const rowBlock = new RegExp('id: ' + source.row + '[\\s\\S]{0,240}?\\n\\s*- id:', 'u').exec(ourPresetPatch);
        if (rowBlock !== null && /toolName:/.test(rowBlock[0])) problems.push(mute.name + '：我们的 preset 给 ' + source.row + ' 行覆盖了 toolName，段名不再是 ' + mute.name + ' —— mutes 要跟着改');
      }
      return problems.length === 0 ? true : '段名对不上：' + problems.join('；');
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

    // 12g) skill：队员必须保留它，且官方「工具可见性 ↔ 技能目录」的绑定必须仍然成立。
    //
    // 为什么要有这一组（2026-10-07）：`skill` 由 preset 行带来（presets/dispatch-mode.patch.yml:142-146），
    // 不在 TEAMMATE_TOOL_DENY 里（lib/roster.js:570），所以队员天然能用 —— 这件事此前**零闸门**。
    // 失效方式与 2026-10-07 修掉的「/team 静默拒收附件」同类：插件照常加载、/team 照常可用，
    // 只是全队再也不会用技能（目录不注入 = 模型不知道有哪些技能，工具还在也等于没用）。
    // 官方实现是**两处**共同决定的，所以这里分两条钉：判据（工具身份比较）+ 事件作用域（按 agent 过滤）。
    check('TEAMMATE_TOOL_DENY 里没有 skill（摘掉它会连带取消技能目录，且是静默的）', () => {
      if (roster.TEAMMATE_TOOL_DENY.includes('skill')) {
        return 'TEAMMATE_TOOL_DENY 含 skill：官方只在 skill 工具可见时注入 <available_skills>'
          + '（dsh-tool-skill/lib/index.js:207），所以队员会**同时**失去工具与技能目录 ——'
          + ' 插件照常加载、/team 照常可用，只是全队再也不会用技能。若确实要禁止队员用技能，'
          + '请同时改掉 tools/integration-test.cjs §2.5 那组断言并在这里写明理由';
      }
      // preset 行是 skill 能力的来源：行被删掉时队员当然也没有 skill，但那属于「能力面缺一行」，
      // 由 11a/11b 的行比对负责；这里只确认我们没在**收窄名单**里主动摘掉它。
      return true;
    });

    check('官方 skill 目录仍按「skill 工具可见性」绑定（我们靠这条语义让队员自动拿到目录）', () => {
      const skillToolSource = asar.read('dsh/node_modules/@deepseek-ai/dsh-tool-skill/lib/index.js') || '';
      if (skillToolSource === '') return '读不到 dsh-tool-skill/lib/index.js';
      // 判据原文：`ctx.tools.get(skillTool.name, agent) === skillTool ? … : { skills: [] }`
      // 即「解析到的定义不是我这个注册对象 → 目录为空」。身份比较（===）是这条语义的核心：
      // 改成「非 undefined」会让同名遮蔽出来的另一份定义也拿到目录。
      if (!skillToolSource.includes('ctx.tools.get(skillTool.name, agent) === skillTool')) {
        return 'skill 目录的可见性判据变了（不再是 `ctx.tools.get("skill", agent) === skillTool`）——'
          + ' 队员能不能自动拿到技能目录这件事需要重新核对，lib/roster.js 的收窄名单要跟着复核';
      }
      if (!skillToolSource.includes('"agent/pre-step"')) {
        return 'skill 目录不再挂在 agent/pre-step 上 —— 注入时机变了，integration-test §2.5 的仿真要重写';
      }
      if (!skillToolSource.includes('kind: "skill-catalog"')) {
        return '目录消息的 source.kind 不再是 "skill-catalog" —— integration-test 按这个字段找目录，会变成空断言';
      }
      return true;
    });

    check('agent/pre-step 仍按 agent 作用域过滤（队员各自拿一份目录的前提）', () => {
      const invariant = asar.read('dsh/node_modules/@deepseek-ai/dsh-scope/lib/invariant.js') || '';
      if (invariant === '') return '读不到 dsh-scope/lib/invariant.js';
      // 没有这条过滤器，agent/pre-step 会变成全局广播：一个队员装配时**所有** agent 都会收到
      // 目录（甚至包括已经关闭团队的会话）。integration-test 里两条「队员/Lead 各自收到目录」
      // 的断言依赖它就是按 agent 过滤的。
      if (!/"agent\/pre-step":\s*\(args\)\s*=>\s*args\[0\]\["agent"\]/u.test(invariant)) {
        return 'agent/pre-step 的作用域过滤器不再是 `args[0]["agent"]` —— 目录注入会广播给所有 agent，'
          + 'integration-test §2.5 的断言前提不成立';
      }
      return true;
    });

    check('技能目录的注入形态仍是 user 消息（所以不会破坏队员共用的系统提示词前缀）', () => {
      const skillToolSource = asar.read('dsh/node_modules/@deepseek-ai/dsh-tool-skill/lib/index.js') || '';
      if (skillToolSource === '') return '读不到 dsh-tool-skill/lib/index.js';
      // 这条是**缓存纪律**的闸门：目录以 user/message 注入（而不是 systemPrompt 段）时，
      // 它落在消息序列里，队员之间共用的系统提示词前缀逐字节不变 —— lib/playbook.js 的
      // TEAMMATE_CARD 设计（所有队员同一份前缀）才继续成立。
      // 官方哪天改成注册 systemPrompt 段，目录就会进入**系统提示词**，前缀会随技能集变化。
      if (!skillToolSource.includes('createUserMessage(')) {
        return '技能目录不再用 createUserMessage 注入 —— 若改成系统提示词段，队员的共享前缀会随技能集变化，'
          + 'lib/playbook.js 的 TEAMMATE_CARD 缓存前提要重新评估';
      }
      return true;
    });

    // 12h) preset 里必须真的装着 skill 两件套（工具 + 文件系统 provider）。
    // 只查「行还在」不够：两行是一对 —— 少了 skill-filesystem，skill 工具能调但永远查不到任何技能
    // （ctx.skills 没有 provider），失败同样是静默的。
    // 判据复用 11a 的 rowSignatures（行锚定解析 id/name），不自己拼正则：包名里有 `@` 与 `/`，
    // 手写转义会引入无效转义（本轮真踩过：Invalid regular expression: Invalid escape）。
    check('调度模式 preset 仍声明 skill-filesystem + tool-skill 这一对', () => {
      const rows = new Map(rowSignatures(ourPresetPatch).map((row) => [row.id, row]));
      const problems = [];
      for (const [id, name] of [['skill-filesystem', '@deepseek-ai/dsh-skill-filesystem'], ['tool-skill', '@deepseek-ai/dsh-tool-skill']]) {
        const row = rows.get(id);
        if (row === undefined) { problems.push(`preset 里没有 ${id} 这一行`); continue; }
        if (row.name !== name) { problems.push(`${id} 的 name 变成了 ${row.name || '(空)'}，期望 ${name}`); continue; }
        if (row.disabled) problems.push(`${id} 被 disabled 了`);
      }
      if (problems.length > 0) {
        return problems.join('；') + ' —— 少 skill-filesystem 时 skill 工具永远查不到技能，'
          + '少 tool-skill 时技能目录不会注入；两种都是静默的';
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
      if (!toolsJs.includes('const memberOnly = new Set([REPORT_TOOL_NAME, ASK_LEAD_TOOL_NAME])')) return '找不到「队员专用」的过滤逻辑（report_result / ask_lead 都该在里面）';
      if (!toolsJs.includes('!memberOnly.has(definition.name)')) return 'Lead 的工具目录没有排除队员专用工具';
      if (!roster.MEMBER_TEAM_TOOL_NAMES.includes(roster.REPORT_TOOL_NAME)) return 'MEMBER_TEAM_TOOL_NAMES 里没有 report_result';
      if (roster.TEAM_TOOL_NAMES.includes(roster.REPORT_TOOL_NAME)) return 'report_result 混进了官方九工具名单（会污染同名冲突判定）';
      return true;
    });
  }

  // 13) 两道容量帽（2026-10-05 新增）。
  //
  // 为什么要有这一组：本插件此前只登记了 `maxMembers`（累计帽），宿主**同时在线**那道
  // `maxActiveSubagents` 零登记。而那道帽管到本插件**完全依赖一个官方实现细节**：
  // 官方建队员走的是 `ctx.subagents.startContinuable(...)`（continuable 池），不是 one-shot。
  // 官方哪天改成 one-shot 派发，这道帽就自动消失、MAINTAINER-NOTES.md §4.2.1 会悄悄变成错的。
  // 这三条检查就是那个前提的报警器。
  const agentTeamIndex = asar.read('dsh/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/index.js') || '';

  check('官方建队员仍走 startContinuable（同时在线帽 maxActiveSubagents 的存在前提）', () => {
    if (agentTeamIndex === '') return '读不到 dsh-experimental-agent-team/lib/index.js';
    if (!agentTeamIndex.includes('this.ctx.subagents.startContinuable({')) {
      return '官方不再用 startContinuable 建队员 —— MAINTAINER-NOTES.md §4.2.1「同时在线帽管到本插件」这条结论失效，'
        + 'lib/tools.js 的 ACTIVATION_LIMIT_REACHED 翻译可能再也命中不了，请重新核对官方派发方式';
    }
    return true;
  });

  check('官方仍以 TEAM_MEMBER_LIMIT 表达累计帽（lib/tools.js 按错误码翻译的前提）', () => {
    if (agentTeamIndex === '') return '读不到 dsh-experimental-agent-team/lib/index.js';
    // 本插件的 translateSpawnFailure 按 error.code 路由（不 parse message），三个码缺一不可。
    const required = ['TEAM_MEMBER_LIMIT', 'TEAM_MEMBER_NAME_TAKEN'];
    const missing = required.filter((code) => !agentTeamIndex.includes(code));
    if (missing.length > 0) return `官方不再抛这些错误码：${missing.join(', ')} —— 按码翻译的分支会失效（只剩原样透传）`;
    return true;
  });

  check('宿主仍以 ACTIVATION_LIMIT_REACHED 表达同时在线帽，且容量取自 maxActiveSubagents', () => {
    const subagentIndex = asar.read('dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js') || '';
    if (subagentIndex === '') return '读不到 dsh-subagent/lib/index.js';
    if (!subagentIndex.includes('ACTIVATION_LIMIT_REACHED')) {
      return '找不到 ACTIVATION_LIMIT_REACHED —— lib/tools.js 的「先收人再派活」提示失去触发点，'
        + '请回读 dsh-subagent 的容量拒绝路径';
    }
    if (!subagentIndex.includes('maxActiveSubagents')) return '找不到 maxActiveSubagents —— 状态文件采集的那两行要跟着改';
    return true;
  });

  check('宿主仍在会话里落 llm/retry 事件，且字段仍是插件记账用到的那些', () => {
    // lib/runtime.js 的 noteRetryEvent 按这个形状取值（只观测，不改变行为）。
    // 依据是装机 dsh-llm-retry/lib/index.js:116-150：agent.session.append("llm/retry", {...})。
    const retryIndex = asar.read('dsh/node_modules/@deepseek-ai/dsh-llm-retry/lib/index.js') || '';
    if (retryIndex === '') return '读不到 dsh-llm-retry/lib/index.js';
    const missing = ['"llm/retry"', 'agent.session.append', 'delayMs', 'provider'].filter((needle) => !retryIndex.includes(needle));
    if (missing.length > 0) {
      return `dsh-llm-retry 的重试事件形状变了（找不到 ${missing.join('、')}）`
        + ' —— lib/runtime.js 的 noteRetryEvent 会读到空值，list_agents 上的重试标志会静默失效';
    }
    return true;
  });

  check('package.json 的 files 声明都在 sync 清单里（否则已安装副本会留过期文档）', () => {
    // 动机（2026-10-05）：tools/sync-to-dsh.cjs 的文件头写着「同步源码与文档」，但它的 FILES
    // 清单漏了 README.md 与 INTERFACES.md —— 这两个是 package.json 的 files 里声明、正式安装时
    // 会被拷进插件目录的东西。漏了它们，已安装副本里会留一份过期的 README，看起来像
    // 「源码改了没同步成功」，而且是**静默**的（sync 自己不会报）。与下一条是同一类问题
    // （清单与真实文件集脱节），只是对象换成了 package.json 的声明。
    const manifest = readFileOr(path.join(PLUGIN_DIR, 'package.json'));
    const syncSource = readFileOr(path.join(PLUGIN_DIR, 'tools', 'sync-to-dsh.cjs'));
    if (manifest === '' || syncSource === '') return '读不到 package.json 或 tools/sync-to-dsh.cjs';
    let listed;
    try {
      listed = JSON.parse(manifest).files;
    } catch (error) {
      return 'package.json 不是合法 JSON：' + String(error && error.message ? error.message : error);
    }
    if (!Array.isArray(listed) || listed.length === 0) return 'package.json 的 files 不是非空数组';
    // files 里会写目录（lib / tools / presets / locale）；这里只核对**单个文件**的条目
    // （目录展开由下一条管）。
    const fileEntries = listed.filter((entry) => typeof entry === 'string' && /\.[a-z0-9]+$/iu.test(entry));
    const missing = fileEntries.filter((entry) => !syncSource.includes("'" + entry + "'"));
    if (missing.length > 0) {
      return `package.json 声明了这些文件但 sync-to-dsh.cjs 的 FILES 没列：${missing.join(', ')}`
        + ' —— 已安装（或已同步）的那份会留过期副本，而脚本自己不会报';
    }
    return true;
  });

  check('lib/*.js 的每个文件都在两份清单里（repair 的 PACKAGE_FILES + sync 的 FILES）', () => {
    // 为什么要有这条（2026-10-05）：审查 P1-3 记录过同一类缺口 ——
    // 「旧清单只有 6 个文件，漏了 runtime/tools/roster/playbook，缺了核心模块它照样打印
    //  『状态完好』」。本轮新增 lib/text-clip.js 时，两份清单又都漏了它（我手工补的）。
    // 这个失败模式是**静默**的：漏了 PACKAGE_FILES，体检不会报缺件；
    // 漏了 sync 的 FILES，工作区改了这个文件也永远不会同步到 DSH 实际加载的那份。
    const libDir = path.join(PLUGIN_DIR, 'lib');
    let actual;
    try {
      actual = fs.readdirSync(libDir).filter((name) => name.endsWith('.js')).sort();
    } catch {
      return '读不到 lib/ 目录';
    }
    if (actual.length === 0) return 'lib/ 里一个 .js 都没有，路径不对？';
    const repairSource = readFileOr(path.join(PLUGIN_DIR, 'tools', 'repair.cjs'));
    const syncSource = readFileOr(path.join(PLUGIN_DIR, 'tools', 'sync-to-dsh.cjs'));
    if (repairSource === '' || syncSource === '') return '读不到 repair.cjs 或 sync-to-dsh.cjs';
    const problems = [];
    for (const file of actual) {
      const entry = `'lib/${file}'`;
      if (!repairSource.includes(entry)) problems.push(`repair.cjs 的 PACKAGE_FILES 缺 lib/${file}`);
      if (!syncSource.includes(entry)) problems.push(`sync-to-dsh.cjs 的 FILES 缺 lib/${file}`);
    }
    if (problems.length > 0) {
      return `${problems.join('；')} —— 缺 PACKAGE_FILES 时体检不报缺件，`
        + '缺 sync 的 FILES 时工作区改动永远同步不到 DSH 加载的那份（两者都是静默的）';
    }
    return true;
  });

  check('cordis 的 inject 隔离语义仍在（integration-test 手写仿真所依据的那句话）', () => {
    // 为什么要有这条（2026-10-05 审查 §1-⑨）：tools/integration-test.cjs 用**手写的 Proxy**
    // 复刻 cordis 的 inject 隔离（loaderLikeCtx，硬编码 10 个 GUARDED_SERVICES，自己抛
    // `cannot get property "x" without inject`），而本地不走真实 plugin-loader（全量 grep 零命中）。
    // 那份仿真清单**没有任何闸门校验它与 cordis 是否仍一致** —— 官方改了错误文案或判定语义，
    // 仿真会继续演一出已经不存在的行为，测试照样绿。参照项目被审出的同类真问题是
    // 「测试测的不是发布物，修法是测真实加载的那个入口」；本地无构建步骤，这个机制不可移植，
    // 但**同一教训的正确形态**是：从装机 asar 断言那句判据仍在（与本地既有 12 个官方包读取通道同法）。
    const cordisIndex = asar.read('dsh/node_modules/@deepseek-ai/cordis/lib/index.js') || '';
    if (cordisIndex === '') return '读不到 cordis/lib/index.js';
    if (!cordisIndex.includes('without inject')) {
      return 'cordis 的 inject 隔离文案里找不到 `without inject` —— integration-test 的 loaderLikeCtx'
        + ' 仿真的是旧语义，需要回读 cordis 的 reflect 代理后重写那段仿真';
    }
    const integration = readFileOr(path.join(PLUGIN_DIR, 'tools', 'integration-test.cjs'));
    if (integration === '') return '读不到 tools/integration-test.cjs';
    if (!integration.includes('without inject')) {
      return 'integration-test.cjs 里那段 inject 仿真消失了 —— 2026-09-28 的「/team 静默不存在」故障会重新变成盲区';
    }
    return true;
  });

  check('插件自己的队员名口径 = 官方 MEMBER_NAME（不再凭空收紧）', () => {
    // 2026-10-05 用户实测：`scout-core` 被本插件拒掉而官方完全接受。这条闸门钉住两边等价。
    const official = asar.read('dsh/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/types/roster.js') || '';
    if (official === '') return '读不到官方 roster.js';
    const match = /const MEMBER_NAME = (\/.*?\/u?);/u.exec(official);
    if (match === null) return '官方 MEMBER_NAME 的定义形状变了（不是 `const MEMBER_NAME = /.../;`）';
    const rosterText = readFileOr(path.join(PLUGIN_DIR, 'lib', 'roster.js'));
    if (rosterText === '') return '读不到 lib/roster.js';
    const mine = /const OFFICIAL_MEMBER_NAME = (\/.*?\/u?);/u.exec(rosterText);
    if (mine === null) return 'lib/roster.js 里找不到 OFFICIAL_MEMBER_NAME（名字形状的口径丢了）';
    if (mine[1] !== match[1]) {
      return `队员名形状与官方不一致：官方 ${match[1]}，本插件 ${mine[1]}`
        + ' —— 两边不一致就会出现「官方接受、插件拒绝」的假失败（或反过来漏出官方会拒的名字）';
    }
    // 官方长度上限：>64 才拒（memberName 里是 value.length > 64）。
    if (!/value\.length > 64/u.test(official)) return '官方的 64 长度上限不见了这个形状，lib/roster.js 的对应判断要重核';
    return true;
  });

  check('工具行标签表与官方 locale 逐字一致（zh 与 en 两侧都比对）', () => {
    // lib/graph.js 的 OFFICIAL_TOOL_TITLES / _EN 是浮窗里每一行工具调用的标签。
    // 用户 2026-10-09 的原话就是「一定要正确，和我用官方的对话框没太大区别」，
    // 所以这两张表**必须是官方 locale 的真值**，不是我觉得顺手的措辞 ——
    // 而「是官方真值」这件事不能靠注释里写一句「脚本抽的」就成立（注释会过时，
    // 代码不会）。这里逐键逐值比对，官方改了我们就红。
    const conv = asar.read('dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js') || '';
    if (conv === '') return '读不到 dsh-client-ui-conversation/lib/client.js';
    // 官方 locale 块里每个 key 出现两次：先 zh 后 en。判据不靠顺序猜：
    // 两份都必须**恰好**出现一次（第三份=官方加了新语言，要人工决定跟哪份）。
    const pairs = new Map();
    const re = /"tool\.title\.([A-Za-z]+)":\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(conv)) !== null) {
      if (!pairs.has(m[1])) pairs.set(m[1], []);
      pairs.get(m[1]).push(m[2]);
    }
    if (pairs.size === 0) return '官方 locale 里找不到任何 tool.title.*（键的写法变了？抽表脚本与这条都要重核）';
    const officialZh = new Map();
    const officialEn = new Map();
    for (const [key, values] of pairs) {
      if (values.length !== 2) {
        return `官方 tool.title.${key} 出现 ${values.length} 次（预期 zh/en 各一次），两侧语言无法确定`;
      }
      const [a, b] = values;
      const aCjk = /[\u4e00-\u9fff]/.test(a);
      const bCjk = /[\u4e00-\u9fff]/.test(b);
      // 一份必须含中文、一份必须不含 —— 否则就是官方换了语言数，不能靠位置猜。
      if (aCjk === bCjk) return `tool.title.${key} 的两份值语言属性相同（${a} / ${b}），无法判定哪份是 zh`;
      officialZh.set(key, aCjk ? a : b);
      officialEn.set(key, aCjk ? b : a);
    }
    const graphText = readFileOr(path.join(PLUGIN_DIR, 'lib', 'graph.js'));
    if (graphText === '') return '读不到 lib/graph.js';
    const parse = (name) => {
      const at = graphText.indexOf('const ' + name + ' = {');
      if (at < 0) return null;
      const end = graphText.indexOf('\n};', at);
      if (end < 0) return null;
      const out = new Map();
      const inner = graphText.slice(at, end);
      for (const kv of inner.matchAll(/([A-Za-z]+):\s*'([^']*)'/g)) out.set(kv[1], kv[2]);
      return out;
    };
    for (const [tableName, official] of [['OFFICIAL_TOOL_TITLES', officialZh], ['OFFICIAL_TOOL_TITLES_EN', officialEn]]) {
      const mine = parse(tableName);
      if (mine === null) return `lib/graph.js 里找不到 ${tableName}（改名或换写法了？同步这条闸门与抽表脚本）`;
      // 别名表 TOOL_TITLE_ALIAS 指向的是**同两张表的键**，键集合比对只看这两张表本身。
      const ghost = [...mine.keys()].filter((k) => !official.has(k));
      const missing = [...official.keys()].filter((k) => !mine.has(k));
      if (ghost.length > 0) return `${tableName} 里有官方没有的键：${ghost.join(', ')}（自造标签=与官方对话框不一样）`;
      if (missing.length > 0) return `官方新增了 ${missing.join(', ')}，${tableName} 没跟上了`;
      const driftKeys = [...mine.keys()].filter((k) => mine.get(k) !== official.get(k));
      const drift = driftKeys.map((k) => k + ': 本插件「' + mine.get(k) + '」/ 官方「' + official.get(k) + '」');
      if (drift.length > 0) return `${tableName} 与官方文案不一致：${drift.join(' | ')}`;
    }
    // 两侧键集合必须相同：少一个键，另一种语言就查不到、回退成工具原名。
    const zhTable = parse('OFFICIAL_TOOL_TITLES');
    const enTable = parse('OFFICIAL_TOOL_TITLES_EN');
    // （箭头函数体不加花括号时，换行后的 .concat 会挂到 has(k) 的返回值上 —— 布尔没有 concat。
    //  同一个笔误我在这条闸门里犯了两次，写成分行表达式就得加括号。）
    const onlyZh = [...zhTable.keys()].filter((k) => !enTable.has(k));
    const onlyEn = [...enTable.keys()].filter((k) => !zhTable.has(k));
    const asym = onlyZh.concat(onlyEn);
    if (asym.length > 0) return '两张表键集合不相等：' + asym.join(', ');
    return true;
  });

  // ── 本轮（弹窗等价 + i18n）新依赖的官方实现 ─────────────────────────────
  // 这些都是**我们照着抄/照着判**的形状。官方一改，我们的失败方式是静默的
  // （标签查不到、展开层空白、停止键没了、语言不切），所以每条都要钉。
  check('官方工具行：resultText / formatToolBody / toolRowModel / expandable 四个形状仍在', () => {
    const tool = asar.read('dsh/node_modules/@deepseek-ai/dsh-client-ui-tool/lib/client.js') || '';
    if (tool === '') return '读不到 dsh-client-ui-tool/lib/client.js';
    // lib/graph.js 的 resultText/formatToolBody 是这两个函数的**移植**（同输入同输出）。
    for (const needle of ['function resultText(', 'function formatToolBody(', 'function toolRowModel(']) {
      if (!tool.includes(needle)) return '官方少了 ' + needle + ' —— graph.js 的同名移植失去了依据，必须重读官方实现';
    }
    // 「有没有得展开」官方是这么判的（我们据此决定给不给箭头）：
    if (!tool.includes('const expandable = state !== "preparing"')) {
      return '官方 expandable 的判据变了（原：state !== "preparing" 且有输入/输出/卡片）—— 弹窗的箭头给法要重核';
    }
    return true;
  });

  check('官方没有「成串工具调用折叠成一组」这回事（我们那个组是自己加的）', () => {
    // 2026-10-14 我曾断言「官方也是把成串工具调用收进一个可展开组」—— 实读后**错了**：
    // 官方逐条渲染（ToolCallTree 在 dsh-client-ui-tool 里存在， ActivityGroup /
    // ToolCallGroup / collapseTool 三个包里都是 0 次）。既然折叠组是本插件自己的
    // 产品判断，那组里的每一条必须**可达**（点开能看见），否则就是藏信息。
    // selftest 的另一条钉的是「组里有 rows、句子在客户端拼」，这条钉的是外部依据：
    // 哪天官方真加了折叠，我们要改的是**对齐官方**而不是继续自造。
    const tool = asar.read('dsh/node_modules/@deepseek-ai/dsh-client-ui-tool/lib/client.js') || '';
    const conv = asar.read('dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js') || '';
    if (tool === '' || conv === '') return '读不到官方 tool/conversation bundle';
    for (const needle of ['ActivityGroup', 'ToolCallGroup', 'collapseTool']) {
      if (tool.includes(needle) || conv.includes(needle)) {
        return '官方新增了 ' + needle + '（工具折叠机制）—— 本插件的 toolgroup 应当改为对齐官方而不是自成一派';
      }
    }
    if (!tool.includes('ToolCallTree')) return '官方 ToolCallTree 不见了（工具行渲染大改）—— 弹窗的工具行口径要整体重读';
    return true;
  });

  check('官方 MarkdownText 流式期间也渲 markdown（弹窗那句「官方流式是纯文本」的依据已订正）', () => {
    const prim = asar.read('dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js') || '';
    if (prim === '') return '读不到 dsh-client-ui-primitives/lib/index.js';
    if (!prim.includes('streaming = false')) return 'MarkdownText 的 streaming 形参默认值形状变了';
    if (!prim.includes('new StreamingRenderer')) return '官方流式渲染器 StreamingRenderer 不见了（半截语法的表现要重判）';
    const chat = asar.read('dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js') || '';
    // 官方正文/思考确实把它打开：streaming: running（chat-client.js:5822/:5911/:6005）。
    if (chat !== '' && !chat.includes('streaming: running')) {
      return '官方不再传 streaming: running —— 弹窗「流式期间也走 markdown」的依据要重核';
    }
    return true;
  });

  check('停止生成走的那条路：cancel() 仍按 address 分流 interruptByParent / session.cancel', () => {
    // 弹窗那颗停止键调的是**官方 session.cancel()**（不是插件自己的通道）。
    const cli = asar.read('dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js') || '';
    if (cli === '') return '读不到 dsh-api-session-controller/lib/client.js';
    if (!cli.includes('async cancel()')) return 'session.cancel() 不在了 —— 弹窗的停止键必须换通道';
    if (!cli.includes('interruptByParent')) return 'cancel() 不再走 subagents.interruptByParent 分流（子会话寻址口径变了）';
    // 「在跑」的真值也在这份文件里：this.running 由 :1971-1972 写。
    if (!cli.includes('this.running = running')) return 'running 字段的写法变了 —— 按钮显隐判据（session.running）要重读';
    return true;
  });

  check('计划审批的匹配键：plan-review / Approve / Keep planning 三个常量逐字未变', () => {
    // 弹窗按计划判「批准」时发的批次必须与官方读取端**逐字**一致，
    // 否则官方 :289 那一串比较不通过，计划会永远停在「等批准」。
    const plan = asar.read('dsh/node_modules/@deepseek-ai/dsh-plan-mode/lib/index.js') || '';
    if (plan === '') return '读不到 dsh-plan-mode/lib/index.js';
    for (const needle of [
      'const REVIEW_ID = "plan-review"', 'const APPROVE_LABEL = "Approve"',
      'const KEEP_PLANNING_LABEL = "Keep planning"', 'entry.id === REVIEW_ID',
      'item.selected[0] !== APPROVE_LABEL', 'item.custom !== void 0',
    ]) {
      if (!plan.includes(needle)) return '官方计划审批的判据少了「' + needle + '」—— 弹窗发的答案批次要按新判据重写';
    }
    // 这三个字符串是**协议**，不是文案：插件的 PLAN_REVIEW 常量必须保持官方英文原样。
    const graph = readFileOr(path.join(PLUGIN_DIR, 'lib', 'graph.js'));
    for (const needle of ["id: 'plan-review'", "'Approve'", "'Keep planning'"]) {
      if (!graph.includes(needle)) return 'lib/graph.js 的计划常量不再逐字等于官方（' + needle + '）';
    }
    return true;
  });

  check('官方 locale 面：bind / getSnapshot / subscribe 三个方法仍给插件用', () => {
    // i18n 的全部改动压在这三个方法上（localeText 查 bind，active 读 getSnapshot，
    // 重刷靠 subscribe）。少任何一个，浮窗就退回「恒读 zh」或「切语言不重画」。
    const loc = asar.read('dsh/node_modules/@deepseek-ai/dsh-client-locale/lib/client.js') || '';
    if (loc === '') return '读不到 dsh-client-locale/lib/client.js';
    for (const needle of ['getSnapshot() {', 'subscribe(fn) {', 'bind(ns) {']) {
      if (!loc.includes(needle)) return '官方 locale 少了 ' + needle + ' —— localeText/wsRelanguage 的依据要重读';
    }
    if (!loc.includes('active: this.resolveActive()')) return '快照里的 active 取法变了（弹窗按它判中英）';
    return true;
  });

  // ── 工作区弹窗与官方界面等价所依赖的官方实现（2026-10-13 新增）──────────────
  // 弹窗的「实时」与「等价」不是走公开 API 契约，而是**复用官方前端自己在用的对象**
  // （同一份 eventSource、同一张 PendingQuestion 卡）。官方一改形状，我们的失败方式
  // 是静默的（画不出流式内容 / 取不到卡 → 悄悄退回消息投递），所以每条都要钉住。
  check('uiSession.sessionStatus 快照仍带 pendingInteraction（弹窗取官方提问卡的入口）', () => {
    const uiSession = asar.read('dsh/node_modules/@deepseek-ai/dsh-client-ui-session/lib/client.js') || '';
    if (uiSession === '') return '读不到 dsh-client-ui-session/lib/client.js';
    // 弹窗靠 sessionStatus.getSnapshot().get(sessionId).pendingInteraction 拿那张卡
    // （lib/client.js 的 bridgeQuestionCard）。官方把它改名或挪出快照 ⇒ 取不到卡
    // ⇒ 弹窗回答**静默退回消息投递**，正是用户 2026-10-13 报的那个症状。
    if (!/sessionStatus = \{/.test(uiSession)) return 'UiSession 上的 sessionStatus 字段形状变了';
    if (!/pendingInteraction: this\.pendingSnapshot\.get\(id\)/.test(uiSession)) {
      return 'sessionStatus 快照里不再挂 pendingInteraction —— 弹窗取不到官方提问卡，'
        + '回答会退回消息投递（等价性丢失）。需要改 lib/client.js 的 bridgeQuestionCard 的取法';
    }
    if (!/registerPendingInteraction\(precedence\)/.test(uiSession)) {
      return 'registerPendingInteraction 的签名形状变了（提问卡域的注册入口）';
    }
    return true;
  });

  check('官方 PendingQuestion 仍有 answer() 与 callId（弹窗按 callId 精确回答）', () => {
    const uq = asar.read('dsh/node_modules/@deepseek-ai/dsh-client-ui-user-questions/lib/client.js') || '';
    if (uq === '') return '读不到 dsh-client-ui-user-questions/lib/client.js';
    // 弹窗提交回答调的就是这个 answer()（官方 composer 用的同一个方法）：
    // 未超时走前端 waterfall.resolve，已超时走 RPC —— 这两条都在它内部。
    if (!/answer\(answer\) \{/.test(uq)) {
      return 'PendingQuestion.answer() 的形状变了 —— 弹窗没有等价通道可走，'
        + '回答会退回消息投递（官方卡不关）';
    }
    if (!/this\.callId = callId/.test(uq)) {
      return '卡上不再有 callId 字段 —— 弹窗无法按调用精确匹配，'
        + '可能替用户答掉另一个问题（bridgeQuestionCard 的判据失效）';
    }
    if (!/keyOf\(sessionId, callId\)/.test(uq)) return '卡的键构造方式变了（keyOf），取卡判据要重核';
    // 通道内部的两条路（waterfall / continued+rpc）必须还在，否则「等价」的含义变了。
    if (!/#state === "continued" && rpc !== void 0/.test(uq)) {
      return 'answer() 里 continued→RPC 那条分支形状变了，弹窗回答的语义需要重新核对';
    }
    return true;
  });

  check('sessions.retain 仍给 binding.eventSource，且 assistantStream 无条件开（弹窗实时的来源）', () => {
    const sc = asar.read('dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js') || '';
    if (sc === '') return '读不到 dsh-api-session-controller/lib/client.js';
    if (!/retain\(target, options\)/.test(sc)) return 'ClientSessions.retain 的签名形状变了';
    // binding 里必须还带 eventSource（弹窗订阅的就是它）。
    if (!/eventSource: session\.eventSource/.test(sc)) {
      return 'binding 里没有 eventSource 了 —— 弹窗拿不到官方那份事件窗口，'
        + '思考与工具调用会退回「整步结算才出现」（用户 2026-10-13 报的症状）';
    }
    // 关键前提：follow 无条件带 assistantStream: true。官方若改成「按需 opt-in」，
    // 我们 retain 的会话就拿不到 transient 行，弹窗会静默变成不实时。
    if (!/assistantStream: true/.test(sc)) {
      return 'follow() 不再无条件带 assistantStream: true —— transient 流可能缺席，'
        + '弹窗的流式覆盖层会静默失效（需要显式 opt-in 或换数据源）';
    }
    if (!/"assistant\/live-chunk"/.test(sc)) {
      return 'transient 行的事件类型改名了（原 "assistant/live-chunk"）—— lib/client.js 的 wsFoldLive 要跟着改'
    }
    return true;
  });

  check('wsFoldLive 的分块规则仍与官方 BlockAssembler 一致（chunk 类型与 name 赋值语义）', () => {
    const assembler = asar.read('dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/assembler.js') || '';
    if (assembler === '') return '读不到 dsh-llm/lib/types/assembler.js';
    for (const kind of ["case 'block-start'", "case 'text-delta'", "case 'reasoning-delta'", "case 'tool-call-delta'", "case 'block-end'"]) {
      if (!assembler.includes(kind)) return `官方 BlockAssembler 的分支少了 ${kind} —— 覆盖层分块要跟着改`;
    }
    // 名字是**赋值**、参数是**累加**：本插件的 wsFoldLive 必须同语义，
    // 否则 provider 重复带名字时会拼出 "readread" 这种标签。
    if (!/partial\.toolCallName = chunk\.name/.test(assembler)) {
      return '官方 toolCallName 不再是赋值语义 —— 核对 lib/client.js 的 wsFoldLive 是否仍一致'
    }
    if (!/argumentsDelta/.test(assembler)) return 'argumentsDelta 字段不见了（覆盖层的参数摘要靠它）';
    const mine = readFileOr(path.join(PLUGIN_DIR, 'lib', 'client.js'));
    if (mine === '') return '读不到 lib/client.js';
    if (!/block\.name = chunk\.name/.test(mine)) {
      return '本插件的 tool-call 名字不再是赋值 —— 与官方不一致，会拼出重复标签';
    }
    return true;
  });

  check('官方 userQuestions.answer 仍只认 continued 态（弹窗为何必须走前端卡）', () => {
    const host = asar.read('dsh/node_modules/@deepseek-ai/dsh-user-questions/lib/index.js') || '';
    if (host === '') return '读不到 dsh-user-questions/lib/index.js';
    // 这条钉的是**根因**：宿主 answer() 只从 continued(agent) 里找问题，
    // 而 timed 未超时的提问是 open 态 ⇒ 恒 false。这正是弹窗过去只能退成消息投递的原因，
    // 也是「必须在前端拿那张卡」这条设计的依据。官方若哪天支持 open 态，
    // 通道⓪ 仍然正确，但 lib/runtime.js 上面那段解释要重写。
    if (!/continued\(agent\) \{/.test(host)) return 'UserQuestionService.continued() 形状变了';
    if (!/answer\(agent, callId, answer\) \{/.test(host)) return '宿主 answer() 签名形状变了';
    if (!/this\.continued\(agent\)\.find/.test(host)) {
      return '宿主 answer() 不再只从 continued(agent) 里找问题 —— 本插件「弹窗必须走前端卡」的'
        + '根因解释已过时，需要更新 lib/runtime.js 的 teamAnswer 注释与通道顺序';
    }
    return true;
  });

  check('官方 submitDrafts 仍是「没填自定义就不出现 custom 键」的形状（答案批次唯一真值）', () => {
    const uq = asar.read('dsh/node_modules/@deepseek-ai/dsh-client-ui-user-questions/lib/client.js') || '';
    if (uq === '') return '读不到 dsh-client-ui-user-questions/lib/client.js';
    // 弹窗的答案批次是**照抄**官方 submitDrafts 的（lib/client.js 提交处理器）。
    // 官方哪天改成写 undefined，我们照抄的那份就得跟着改；更常出事的是反过来 ——
    // 官方仍是条件展开，而我们漂回了 `custom: undefined`（那就是本次报障）。
    if (!/\.\.\.custom === "" \? \{\} : \{ custom \}/.test(uq)) {
      return '官方 submitDrafts 的 custom 键形状变了（原：条件展开）—— 必须重核弹窗答案批次：'
        + '载荷里出现嵌套 undefined 会被网关拒，ask_user_question 当场以 isError 结算'
        + '（实测 session-00001004 seq 22）';
    }
    if (!/const answer = \{ answers: questions\.map/.test(uq)) {
      return '官方批次外层形状变了（原：{ answers: questions.map(...) }）';
    }
    return true;
  });

  check('网关仍校验远程事件返回值的 lossless-JSON（弹窗载荷为何不许含 undefined）', () => {
    const gw = asar.read('dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/client.js') || '';
    if (gw === '') return '读不到 dsh-api-gateway/lib/client.js';
    // 这条钉的是「答案批次必须用条件展开」的**根因**：answer() → waterfall.resolve(answer)，
    // 这个 answer 作为远程事件的返回值回传宿主并被下面这行校验；嵌套 undefined 判 false
    // ⇒ 抛错 ⇒ 工具调用以 isError 结算（提问被打死）。
    if (!/is not lossless JSON data/.test(gw)) {
      return '网关不再校验远程事件返回值 —— 弹窗答案批次的 undefined 约束可能已放宽，'
        + 'lib/client.js 的注释与 tools/selftest.cjs 的对应闸门需要重核';
    }
    if (!/function visitJsonValue/.test(gw)) return 'visitJsonValue 不见了（校验实现改名/重构）';
    // 它仍然把非 object（含 undefined）判 false —— 这就是嵌套 undefined 致命的依据。
    if (!/if \(typeof value !== "object"\) return false;/.test(gw)) {
      return 'visitJsonValue 对非 object（含 undefined）的处理变了 —— 重核弹窗批次形状约束';
    }
    // 并且 answer() 依然「永远 resolve」：所以弹窗必须自己验结算（bridgeQuestionOutcome）。
    const uq = asar.read('dsh/node_modules/@deepseek-ai/dsh-client-ui-user-questions/lib/client.js') || '';
    if (!/waterfall\.resolve\(answer\)/.test(uq)) {
      return '官方 answer() 不再只是 waterfall.resolve(answer) —— 若它现在会回报失败，'
        + '弹窗的 bridgeQuestionOutcome 验结算可以简化，但语义要重新核对';
    }
    return true;
  });

  // ── 队员 agent 预设重绑所依赖的官方实现（2026-10-15 新增）──────────────────
  // 「让 12 个队员各选一份预设」不是我们自己的机制：它完全建立在官方注册表的
  // mount/select/bind/rebind + 作用域链读时求值之上。官方任何一处改版，本功能会
  // **静默退化**成「队员还是调度模式」，所以逐条钉住。
  check('官方 agentPresets 仍给 list / composedPreset / mount / select 四个方法', () => {
    const reg = asar.read('dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js') || '';
    if (reg === '') return '读不到 dsh-agent-preset-registry/lib/index.js';
    for (const needle of ['async list() {', 'composedPreset(ctx) {', 'async mount(ctx, id) {', 'async select(agent, agentPreset) {']) {
      if (!reg.includes(needle)) return '官方注册表少了 ' + needle + ' —— 配置页的预设表/重绑的依据要重读';
    }
    return true;
  });

  check('重绑的落点：bind() 仍用 binding.parent.rebind(新代际.key) 换父', () => {
    const reg = asar.read('dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js') || '';
    if (reg === '') return '读不到 dsh-agent-preset-registry/lib/index.js';
    if (!reg.includes('binding.parent.rebind(generation.key)')) {
      return 'bind() 不再走 rebind 换父 —— 换预设的机制变了，lib/runtime.js 的 rebindMemberPreset 要重读（可能已不需要，也可能根本做不到）';
    }
    if (!reg.includes('this.join(ctx, key, generation)')) return 'join() 的调用形状变了';
    return true;
  });

  check('dsh-scope：rebind 仍是一等能力，且父链是**读时**遍历（换父立刻生效）', () => {
    const scope = asar.read('dsh/node_modules/@deepseek-ai/dsh-scope/lib/index.js') || '';
    if (scope === '') return '读不到 dsh-scope/lib/index.js';
    if (!scope.includes('return { rebind(next) {')) return 'bindScopeParent 不再返回 rebind 句柄 —— 换父这条路没了';
    if (!scope.includes('for (const key of scopeChainOf(scope).reverse())')) {
      return 'chainLayers 不再每次读时走 scopeChainOf —— 换父后工具/提示词可能不重算，队员预设会「改了没反应」';
    }
    const tools = asar.read('dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js') || '';
    if (tools === '') return '读不到 dsh-tools/lib/index.js';
    if (!tools.includes('const layers = this.layers.chainLayers(scope);')) {
      return 'tools.view() 不再用 chainLayers(scope) —— 继承面算法变了，本插件对「换 preset = 换工具」的判断要重读';
    }
    // own 层豁免也是前提：我们注册的团队工具/队员卡必须不受重绑影响。
    if (!/and never what its OWN layer registers/.test(tools)) return 'restrict/view 的 own 层豁免注释变了 —— 重读「重绑不伤 own 层」这条断言的依据';
    return true;
  });

  check('子代理仍**硬编码**继承父的实时 preset（所以必须我们重绑，官方没给参数）', () => {
    const child = asar.read('dsh/node_modules/@deepseek-ai/dsh-subagent/lib/types/child-agent.js') || '';
    if (child === '') return '读不到 dsh-subagent/lib/types/child-agent.js';
    if (!child.includes("childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx)")) {
      return 'applyChildComposition 的继承写法变了 —— 若官方哪天给了 per-child preset 参数，'
        + 'lib/runtime.js 的重绑就该换成官方入口（我们这套是绕不过去时才需要的）';
    }
    if (!child.includes("const agentPreset = parent.ctx.get('agentPresets')?.composedPreset(parent.ctx)")) {
      return 'childSessionMeta 不再把父的 preset 写进子的 header —— 恢复分支（以日志为准对齐）的依据要重读';
    }
    return true;
  });

  check('会话重建读 agentPreset **投影**（header + selected 事件），所以我们落的事件有效', () => {
    const reg = asar.read('dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js') || '';
    if (reg === '') return '读不到 dsh-agent-preset-registry/lib/index.js';
    if (!reg.includes('key: "agentPreset"')) return 'agentPreset 投影的键变了（lib/runtime.js 读 sessionProjections 的那个键要跟着改）';
    if (!reg.includes('init: (header) => header.agentPreset ?? null')) return '投影初值不再取自 header —— 恢复分支的判断要重读';
    if (!reg.includes('event.type === "agent-preset/selected"')) return '投影不再由 selected 事件推进 —— 我们落盘那条就白写了';
    return true;
  });

  check('官方 select() 仍用 turnBoundary 锁住已开播的会话（我们不绕这条）', () => {
    const reg = asar.read('dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js') || '';
    if (reg === '') return '读不到 dsh-agent-preset-registry/lib/index.js';
    if (!reg.includes('boundary.openTurnStartSeq !== null || boundary.lastTurn > 0')) {
      return 'select() 的锁定判据变了 —— 插件里「已开播就记下次派活生效」那条分支要按新判据重写';
    }
    if (!reg.includes('"agent-preset/locked"')) return '锁定错误码改名：lib/runtime.js 的 /locked|already started/ 匹配要更新';
    return true;
  });

  check('内置组合的显示名仍由官方 locale 出（我们抄的是键名表，不是文案）', () => {
    const cli = asar.read('dsh/node_modules/@deepseek-ai/dsh-client-ui-agent-preset/lib/client.js') || '';
    if (cli === '') return '读不到 dsh-client-ui-agent-preset/lib/client.js';
    if (!cli.includes('const BUILT_IN_PRESET_KEYS = {')) return '官方那张 id→键名 表改名/重构 —— presetLabel 的退路要重读';
    for (const needle of ['presetStandardName', 'presetPtcName', 'presetMinimalName', 'presetCordisName']) {
      if (!cli.includes(needle)) return '官方 locale 键 ' + needle + ' 不在了（本文件 BUILT_IN_PRESET_NAME_KEYS 与字典里的 presetName* 要跟着改）';
    }
    // 我们那份映射必须与官方那张逐字一致，否则内置组合在页面上会退回显示裸 id。
    const client = readFileOr(path.join(PLUGIN_DIR, 'lib', 'client.js'));
    for (const pair of [["standard: 'presetStandardName'", "ptc: 'presetPtcName'"], ["minimal: 'presetMinimalName'", "cordis: 'presetCordisName'"]]) {
      for (const needle of pair) {
        if (!client.includes(needle)) return 'lib/client.js 的 BUILT_IN_PRESET_NAME_KEYS 少了 ' + needle + '（与官方那张表不再逐字一致）';
      }
    }
    return true;
  });

    // ── 批量调用档（both）所依赖的官方形状（2026-10-15 用户选路径 1）──────────────
    // 本插件不开新预设、不改官方文件，只在队员自己的作用域喊一句 presentAs('both')。
    // 这句话的全部效力都压在下面这几行官方代码上 —— 它们任一变动，功能就静默变成
    // 「开关拨了但什么都没发生」，所以逐条钉住。
    const batchTools = asar.read('dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js') || '';
    const batchScope = asar.read('dsh/node_modules/@deepseek-ai/dsh-scope/lib/index.js') || '';
    const batchPres = asar.read('dsh/node_modules/@deepseek-ai/dsh-agent-tool-presentation/lib/index.js') || '';
    const batchMcp = asar.read('dsh/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js') || '';

    check('官方仍有第三档 both，且 both = 全部工具 + run_code（批量调用档就挂在这一行上）', () => {
      if (batchTools === '') return '读不到 dsh-tools';
      if (!batchTools.includes('"both"')) return 'dsh-tools 的 mode 联合类型里没有 both 了：这一档没有承载物，功能必须改道';
      if (!batchTools.includes('knownNames: [...view.knownNames, RUN_CODE_NAME]')) {
        return 'both 分支不再是「继承面全部名字 + run_code」：本插件的判据与 §7.10 的断言要按新形状重写';
      }
      if (!batchTools.includes('schemas.filter((schema) => schema.name === RUN_CODE_NAME)')) {
        return 'ptc 分支不再是「只留 run_code」：用户报的那个报错现象已经变了，§7.10 的对照基线要重写';
      }
      return true;
    });

    check('presentAs 仍是 per-scope 声明口，modeFor 仍是「最近的一层赢」', () => {
      if (!batchTools.includes('presentAs(mode) {')) return 'ctx.tools.presentAs 不见了或改名了：applyMemberBatch 会走「取不到就记诊断」那条降级路';
      if (!batchTools.includes('for (let index = layers.length - 1; index >= 0; index -= 1)')) {
        return 'modeFor 不再是「从最近一层往前找第一个声明」：自己那层压不住预设那层，路径 1 的前提没了';
      }
      if (!batchScope.includes('farthest ancestor first and the exact scope last')) {
        return 'dsh-scope 的 chainLayers 顺序注释变了（顺序一旦翻转，上面那条判据就是假的，功能会反过来被预设压住）';
      }
      return true;
    });

    check('装配期仍要求 ptcRuntime —— 本插件那条守卫的理由还成立', () => {
      if (!batchTools.includes('requires a PTC runtime')) {
        return 'dsh-tools 不再因缺 PTC 运行时抛错：applyMemberBatch 里的守卫可以删（删之前请同步 §7.10 那条负对照）';
      }
      if (!batchTools.includes('mode !== "native"')) return 'run_code 的注入条件变了（不再是「非 native 就注入」）：both 档拿不到 run_code 时 §7.10 会先红';
      if (!batchTools.includes('is the only tool you can call directly')) {
        return '官方 PTC_ONLY 文案变了：§7.10 拿它当钥匙，both/ptc 两条断言会假绿或假红，按新文案改判据';
      }
      return true;
    });

    check('呈现档声明包仍把 native|ptc|both 转成 presentAs（官方自己的换档机制没变）', () => {
      if (batchPres === '') return '读不到 dsh-agent-tool-presentation';
      for (const value of ['"native"', '"ptc"', '"both"']) {
        if (!batchPres.includes(value)) return '声明包的 Config 联合类型里少了 ' + value;
      }
      if (!batchPres.includes('tools.presentAs(config.mode)')) return '声明包不再调 presentAs：官方换档机制变了，本插件直接 presentAs 的前提要重新核';
      return true;
    });

    check('MCP 工具仍注册进调用方作用域（用户后加的 MCP 要能被队员看到，这一档才有意义）', () => {
      if (batchMcp === '') return '读不到 dsh-mcp-client：MCP 工具进不来，用户那条「以后加的 MCP 也要能看到」失效';
      if (!batchMcp.includes('ctx.tools.register(definition)')) return 'MCP 工具不再走 ctx.tools.register：它落在哪一层要重新核（both 档可能看不见它）';
      if (!batchMcp.includes('const publicName = publicToolName(opts.serverName, tool.name)')) {
        return 'MCP 工具的公开名规则变了：文档里写的 mcp__<server>__<tool> 与 §7.10 之外的判据都要跟着改';
      }
      return true;
    });

  check('白名单三个 id 在本机真的注册着（standard/ptc 来自官方 bundle，极简灰度来自 profile patch）', () => {
    const roster = readFileOr(path.join(PLUGIN_DIR, 'lib', 'roster.js'));
    const ids = ['ptc', 'standard', 'minimal-grayscale'];
    for (const id of ids) {
      if (!roster.includes("'" + id + "'")) return 'TEAMMATE_PRESET_IDS 里不再有 ' + id + ' —— 本闸门的判据要按新名单重写';
    }
    for (const [id, file] of [['standard', 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'], ['ptc', 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/ptc.patch.yml']]) {
      const text = asar.read(file) || '';
      if (text === '') return '读不到 ' + file + '（内置组合的声明位置变了？）';
      // 不用 \b（在字符串字面量里它会被解析成退格符，正则永远匹配不上）：直接要求 id 后面
      // 不能再是标识符字符或短横线，等价于「整段 id 精确匹配」。
      if (!new RegExp('id: ' + id + '[^\wA-Za-z0-9_-]').test(text + ' ')) return
    }
    const profile = readFileOr(path.join(PROFILE_DIR, 'cordis.patch.yml'));
    if (!profile.includes('preset-minimal-grayscale')) {
      return 'profile patch 里没有 preset-minimal-grayscale：白名单第三项在这台机器上不存在。'
        + '配置页会把它标成「本机没装」（这是正确降级），但用户点名要的三个模式少了一个 —— 要么改名单，要么把那份预设装回来';
    }
    return true;
  });

  // ── 输出 ───────────────────────────────────────────────────────────────────
  let failed = 0;
  let skipped = 0;
  console.log('结果：');
  for (const result of results) {
    if (result.skipped === true) {
      skipped += 1;
      console.log(`  SKIP  ${result.name}`);
      console.log(`        · ${result.detail}`);
      continue;
    }
    if (result.ok) {
      console.log(`  PASS  ${result.name}`);
      // 漏写 return 的检查等于「永远绿」——不能和真 PASS 混在一起（P2-19 根因之一）。
      if (result.missingReturn === true) console.log('        · 注意：该检查没有显式 return，按 PASS 处理但请补上返回值');
    } else {
      failed += 1;
      console.log(`  FAIL  ${result.name}`);
      console.log(`        → ${result.detail}`);
    }
  }
  console.log('');
  const executed = results.length - skipped;
  console.log(`${executed - failed}/${executed} 通过。` + (skipped > 0 ? `（另有 ${skipped} 项因环境/对象缺席而 SKIP，未计入）` : ''));

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