#!/usr/bin/env node
/**
 * selftest.cjs —— 本插件的纯逻辑回归测试（无外部依赖，直接跑真代码）
 *
 * 覆盖 `lib/roster.js` 与 `lib/playbook.js` 的导出与不变量。这两份模块不 import 任何 dsh 包，
 * 所以可以在插件源码目录直接用 node 跑（不需要安装期的 node_modules junction）。
 * 除下面 report_result 那一组外都零依赖：`lib/tools.js` 静态 import `@deepseek-ai/dsh-tools`，
 * 只有安装期的 node_modules junction 能解析到它。该组在依赖坏掉时**显式 SKIP 并以 exit 2 报出**
 * （2026-10-04 审查 P1-4：以前这里直接崩掉整个自测，丢汇总还伪装成回归失败）。
 * `lib/runtime.js` / index / preset / client 需要真宿主，不在这里测：
 * 由 tools/drift-check.cjs 做静态对齐、tools/integration-test.cjs 做真链路验证。
 *
 * 本文件重点守住的三条不变量（都是「一破就悄悄烧钱/悄悄失效」的那种）：
 *   1. 队员卡与角色无关 → 所有队员的系统提示词逐字节相同（提示词缓存前缀才可共用）；
 *   2. 队员工具名单 = 九个团队工具减去 Lead 专属，且 TEAMMATE_TOOL_DENY 不误伤团队工具名；
 *   3. PLAYBOOK 的角色表与 lib/roster.js 逐行一致（不是「包含 id 就算过」）。
 *
 *   node tools/selftest.cjs
 *
 * 退出码：0 = 全通过；1 = 有断言失败；2 = 断言全过但环境不满足（有检查组被 SKIP）。
 */

'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LIB = path.join(__dirname, '..', 'lib');
const PLUGIN_DIR = path.join(__dirname, '..');
let passed = 0;
const failures = [];
/** 环境不满足而未执行的检查组数（junction 悬空等）。非 0 时退出码用 2，与「真实回归失败」的 1 区分开。 */
let envSkipped = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, message: error && error.message ? error.message : String(error) });
    console.log(`  FAIL  ${name}`);
    console.log(`        → ${error && error.message ? error.message : String(error)}`);
  }
}

const load = (file) => import(pathToFileURL(path.join(LIB, file)).href);

/**
 * 切出一个顶层函数的函数体（从 needle 到下一个行首 `\n}`）。
 * 与 tools/drift-check.cjs 的同名实现同法：源码扫描型断言必须限定在目标函数内，
 * 否则 `slice(start)` 扫到文件尾会把后面的无关函数一起纳入判断（2026-10-04 审查 P2-27）。
 * @param source - 文件全文。
 * @param needle - 函数声明的锚点文本。
 * @returns 函数体文本；找不到 needle 时返回空串。
 */
function functionBodyOf(source, needle) {
  const start = source.indexOf(needle);
  if (start < 0) return '';
  const end = source.indexOf('\n}\n', start);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}

(async () => {
  const roster = await load('roster.js');
  const playbook = await load('playbook.js');
  const cache = await load('cache.js');

  console.log('lib/roster.js');

  await check('角色表：id 唯一、字段完备、顺序固定、可作队员名前缀', () => {
    // 角色**数量**的真值只有一处（lib/roster.js），这里不再复制一份 id 列表：
    // 复制出来的那份在扩编时只会各飘各的（本文件的旧版本就是这么坏的）。
    // 这里断言的是**结构不变量**，以及「PLAYBOOK 的角色表 = ROLES」这条跨文件一致性（见下面）。
    assert.ok(roster.ROLES.length >= 7, `角色数 ${roster.ROLES.length} 少于 7`);
    // 上面那条款只是兜底「别缩太多」；真正的防漂移是**跨文件对账**：插件页文案里写死的
    // 「N 类队员」必须等于 ROLES.length（2026-10-04 审查 P2-27：旧下限 7 与真实 12 差了 5，
    // 缩编到 8-11 都不会报警）。断言从文案里**读出**数字，而不是在这里再抄一份真值。
    const localeZh = JSON.parse(readFileSync(path.join(PLUGIN_DIR, 'locale', 'zh.json'), 'utf8'));
    const claimed = /为\s*(\d+)\s*类队员/u.exec(String(localeZh?.meta?.description ?? ''));
    assert.ok(claimed !== null, 'locale/zh.json 的描述里找不到「N 类队员」这句数量声明');
    assert.equal(Number(claimed[1]), roster.ROLES.length, `locale 写的队员类数(${claimed[1]})与 ROLES.length(${roster.ROLES.length})不一致`);
    // 英文文案同一真值同一条断言（两份 locale 各写一次数字，正是最容易各飘各的地方）。
    const localeEn = JSON.parse(readFileSync(path.join(PLUGIN_DIR, 'locale', 'en.json'), 'utf8'));
    const claimedEn = /(\d+)\s+teammate roles/u.exec(String(localeEn?.meta?.description ?? ''));
    assert.ok(claimedEn !== null, 'locale/en.json 的描述里找不到 "N teammate roles" 这句数量声明');
    assert.equal(Number(claimedEn[1]), roster.ROLES.length, `en.json 写的角色数(${claimedEn[1]})与 ROLES.length(${roster.ROLES.length})不一致`);
    assert.equal(roster.ROLE_IDS.length, roster.ROLES.length);
    assert.equal(new Set(roster.ROLE_IDS).size, roster.ROLES.length, '角色 id 有重复');
    assert.deepEqual(Object.keys(roster.ROLE_BY_ID), roster.ROLE_IDS, 'ROLE_BY_ID 与 ROLE_IDS 不一致');
    for (const role of roster.ROLES) {
      assert.ok(role.id && role.label && role.mission && role.writes && role.when, `角色 ${role.id} 字段不全`);
      assert.ok(Array.isArray(role.duties) && role.duties.length > 0, `角色 ${role.id} 没有 duties`);
      assert.notEqual(role.labelEn, undefined, `角色 ${role.id} 缺 labelEn`);
      // 角色 id 必须能通过 domain 的 MEMBER_NAME 形状（小写、短横线）
      assert.match(role.id, /^[a-z][a-z0-9-]*$/u, `角色 id ${role.id} 不是合法的队员名前缀`);
      // 名字推导必须能回来：`<role>` 与 `<role>-2` 都要推出自己
      assert.equal(roster.deriveRole(role.id), role.id, `deriveRole('${role.id}') 推不出自己`);
      assert.equal(roster.deriveRole(`${role.id}-2`), role.id, `deriveRole('${role.id}-2') 推不出自己`);
      assert.equal(roster.isValidTeammateName(role.id), true);
      assert.equal(roster.isValidTeammateName(`${role.id}-2`), true);
    }
  });

  await check('队员能力面常量：队员工具 = 九个团队工具减去 Lead 专属；deny 不含团队工具名', () => {
    const teamTools = new Set(roster.TEAM_TOOL_NAMES);
    const leadOnly = new Set(roster.LEAD_ONLY_TEAM_TOOL_NAMES);
    const memberTools = new Set(roster.MEMBER_TEAM_TOOL_NAMES);

    assert.equal(teamTools.size, roster.TEAM_TOOL_NAMES.length, 'TEAM_TOOL_NAMES 有重复');
    assert.equal(memberTools.size, roster.MEMBER_TEAM_TOOL_NAMES.length, 'MEMBER_TEAM_TOOL_NAMES 有重复');
    for (const name of leadOnly) assert.ok(teamTools.has(name), `Lead 专属工具 ${name} 不在团队工具名单里`);
    // 队员工具 = 九个官方团队工具 − Lead 专属 + 我们自己的队员专用工具。
    // 2026-09-30：report_result 是**队员专用**（Lead 不注册），所以它不在 TEAM_TOOL_NAMES 里。
    // 2026-10-04：ask_lead 同为队员专用（审查 §8 建议 C）——Lead 没有汇报对象，也不该有。
    // 这条断言**故意**钉死名单：加队员专用工具必须同时改这里 + lib/tools.js 的 memberOnly + 文档计数。
    const memberOnly = roster.MEMBER_TEAM_TOOL_NAMES.filter((name) => !teamTools.has(name));
    assert.deepEqual(memberOnly, [roster.REPORT_TOOL_NAME, roster.ASK_LEAD_TOOL_NAME], `队员专用工具名单变了：${memberOnly.join(', ')}`);
    assert.ok(!roster.LEAD_TEAM_TOOL_NAMES.includes(roster.ASK_LEAD_TOOL_NAME), 'ask_lead 泄漏给了 Lead 名单');
    assert.ok(!roster.TEAM_TOOL_NAMES.includes(roster.ASK_LEAD_TOOL_NAME), 'ask_lead 不该进官方镜子名单 TEAM_TOOL_NAMES');
    const expected = [...roster.TEAM_TOOL_NAMES.filter((name) => !leadOnly.has(name)), ...memberOnly];
    assert.deepEqual([...roster.MEMBER_TEAM_TOOL_NAMES], expected, '队员工具名单 ≠ 九个团队工具减去 Lead 专属，再加队员专用工具');
    // 队员**没有**再派子代理的权限：这是本次设计的硬要求，单独钉一条。
    assert.ok(!memberTools.has('spawn_teammate'), '队员拿到了 spawn_teammate');
    assert.ok(!memberTools.has('interrupt_agent'), '队员拿到了 interrupt_agent');
    // Lead 不该拿到 report_result（它没有汇报对象；工具目录里多一个只会污染缓存前缀）。
    assert.ok(!leadOnly.has(roster.REPORT_TOOL_NAME), 'report_result 不应该是 Lead 专属工具');

    assert.equal(new Set(roster.TEAMMATE_TOOL_DENY).size, roster.TEAMMATE_TOOL_DENY.length, 'TEAMMATE_TOOL_DENY 有重复');
    for (const name of roster.TEAMMATE_TOOL_DENY) {
      // 摘掉的名字必须是**继承面**上的第三方工具；团队工具由我们自己在 own layer 注册，
      // restrict 对 own layer 无效，写进去只会得到一条「无法回卷」的诊断。
      assert.ok(!teamTools.has(name), `TEAMMATE_TOOL_DENY 里不应出现团队工具名：${name}`);
      assert.match(name, /^[a-z][a-z0-9_-]*$/u, `工具名形状可疑：${name}`);
    }
    // 用户明确要求的两条：不给队员目标、不给队员再派子代理的权限。
    for (const name of ['create_goal', 'get_goal', 'update_goal', 'subagent', 'subagent_fork', 'workflow']) {
      assert.ok(roster.TEAMMATE_TOOL_DENY.includes(name), `TEAMMATE_TOOL_DENY 缺少 ${name}`);
    }

    const muteNames = roster.TEAMMATE_SECTION_MUTES.map((mute) => mute.name);
    assert.equal(new Set(muteNames).size, muteNames.length, 'TEAMMATE_SECTION_MUTES 段名有重复');
    for (const mute of roster.TEAMMATE_SECTION_MUTES) {
      assert.match(mute.name, /^[a-z][a-z0-9:_-]*$/u, `段名形状可疑：${mute.name}`);
      assert.equal(typeof mute.orderKey, 'string');
      assert.ok(Number.isFinite(mute.fallbackOrder), `段 ${mute.name} 缺 fallbackOrder`);
    }
  });

  await check('配置版本/文件名常量存在且被 sanitize 使用', () => {
    assert.equal(typeof roster.CONFIG_VERSION, 'number');
    assert.match(roster.CONFIG_FILENAME, /^[a-z0-9.-]+\.json$/u);
    assert.equal(roster.defaultConfig().version, roster.CONFIG_VERSION);
  });

  await check('deriveRole：<role> / <role>-N / <role>-<后缀> 都能推导，非法名返回 undefined', () => {
    assert.equal(roster.deriveRole('scout'), 'scout');
    assert.equal(roster.deriveRole('verify-2'), 'verify');
    assert.equal(roster.deriveRole('visual-critic-17'), 'visual-critic');
    // 2026-10-05 放宽：角色 id 是**最长前缀**，非数字后缀是自由标签。
    // 用户实测报错 `name "scout-core" 不是合法的队员名` 就是这条规则过窄造成的。
    assert.equal(roster.deriveRole('scout-core'), 'scout');
    assert.equal(roster.deriveRole('scout-validate'), 'scout');
    assert.equal(roster.deriveRole('plan-critic-verify'), 'plan-critic', '必须取最长前缀：plan-critic 优先于 plan');
    assert.equal(roster.deriveRole('frontier-auditor-check'), 'frontier-auditor');
    // 形状闸门：官方根本造不出来的名字不许被认领（否则冷恢复会对一个不存在的角色装覆盖）。
    assert.equal(roster.deriveRole(' lead '), undefined);
    assert.equal(roster.deriveRole('lead'), undefined);
    assert.equal(roster.deriveRole('lead-2'), undefined, 'lead 不是任何角色 id 的前缀');
    assert.equal(roster.deriveRole('unknown-role'), undefined);
    assert.equal(roster.deriveRole('scout-'), undefined);
    assert.equal(roster.deriveRole('scout--2'), undefined);
    assert.equal(roster.deriveRole('Scout'), undefined);
    assert.equal(roster.deriveRole('scout_core'), undefined);
    assert.equal(roster.deriveRole(''), undefined);
    assert.equal(roster.deriveRole(42), undefined);
    // 「deriveRole 认领」必须与「isValidTeammateName 放行」严格等价（除了 -0/-1 那条更严的后缀规则）。
    for (const name of ['scout', 'scout-2', 'scout-core', 'plan-critic-verify', 'scout-']) {
      assert.equal(roster.deriveRole(name) !== undefined, roster.isValidTeammateName(name), `两条口径在 "${name}" 上不一致`);
    }
  });

  await check('isValidTeammateName：只比官方更严一条（必须以角色开头），形状逐字对齐官方', () => {
    assert.equal(roster.isValidTeammateName('scout'), true);
    assert.equal(roster.isValidTeammateName('scout-2'), true);
    assert.equal(roster.isValidTeammateName('scout-99'), true);
    assert.equal(roster.isValidTeammateName('scout-core'), true);
    assert.equal(roster.isValidTeammateName('plan-critic-verify'), true);
    assert.equal(roster.isValidTeammateName('red-team-alpha'), true);
    assert.equal(roster.isValidTeammateName('lead'), false);
    // 纯数字后缀是本插件自动命名的命名空间，从 2 起（非数字后缀不受这条约束）。
    assert.equal(roster.isValidTeammateName('scout-0'), false);
    assert.equal(roster.isValidTeammateName('scout-1'), false);
    // 末尾只要是纯数字后缀就受这条管（`scout-core-0` 的末尾也是 -0）；
    // 非数字后缀不受约束（`scout-core` 合法），这是「一条规则一句话」的取舍。
    assert.equal(roster.isValidTeammateName('scout-core-0'), false);
    assert.equal(roster.isValidTeammateName('scout-core-2'), true);
    assert.equal(roster.isValidTeammateName('nope'), false);
    // 官方 MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/ —— 形状不一致的必须拒。
    assert.equal(roster.isValidTeammateName('scout-'), false);
    assert.equal(roster.isValidTeammateName('-scout'), false);
    assert.equal(roster.isValidTeammateName('scout--2'), false);
    assert.equal(roster.isValidTeammateName('Scout'), false);
    assert.equal(roster.isValidTeammateName('scout core'), false);
    assert.equal(roster.isValidTeammateName('scout_core'), false);
    assert.equal(roster.isValidTeammateName('a'.repeat(65)), false);
    const longest = `scout-${'x'.repeat(58)}`; // 64 码元整
    assert.equal(longest.length, 64);
    assert.equal(roster.isValidTeammateName(longest), true, '官方上限是 >64 才拒');
    assert.equal(roster.isValidTeammateName(`${longest}x`), false);
    assert.equal(roster.isValidTeammateName(undefined), false);
  });

  await check('nextTeammateName：占用后取 -2、-3…', () => {
    assert.equal(roster.nextTeammateName('scout', []), 'scout');
    assert.equal(roster.nextTeammateName('scout', ['scout']), 'scout-2');
    assert.equal(roster.nextTeammateName('scout', ['scout', 'scout-2']), 'scout-3');
    assert.equal(roster.nextTeammateName('scout', ['lead', 'scout-2']), 'scout');
    // 99 个用尽后抛错，而不是返回重复名
    const taken = ['scout', ...Array.from({ length: 98 }, (_, index) => `scout-${index + 2}`)];
    assert.throws(() => roster.nextTeammateName('scout', taken), /用尽/u);
  });

  await check('defaultConfig / sanitizeConfig：坏输入永不抛错并给出诊断', () => {
    // 空配置的**完整形状**（cache.keepalive.routes 是 2026-09-30 加上的保活覆盖表）。
    const EMPTY_CONFIG = { version: 1, roles: {}, cache: { keepalive: { routes: {} } } };
    assert.deepEqual(roster.defaultConfig(), EMPTY_CONFIG);
    const logs = [];
    const log = (message) => logs.push(message);

    assert.deepEqual(roster.sanitizeConfig(undefined, log), EMPTY_CONFIG);
    assert.deepEqual(roster.sanitizeConfig('nonsense', log), EMPTY_CONFIG);
    assert.deepEqual(roster.sanitizeConfig([1, 2], log), EMPTY_CONFIG);
    assert.deepEqual(roster.sanitizeConfig({ roles: 'x' }, log), EMPTY_CONFIG);
    assert.ok(logs.length >= 3, '坏输入应该有诊断');

    // 未知角色键被丢掉（防止宿主写入我们不认识的 key）
    assert.deepEqual(
      roster.sanitizeConfig({ version: 1, roles: { nope: { provider: 'a', model: 'b' } } }, log),
      EMPTY_CONFIG,
    );
    // provider/model 必须成对
    assert.deepEqual(roster.sanitizeConfig({ roles: { scout: { provider: 'a' } } }, log), EMPTY_CONFIG);
    assert.deepEqual(roster.sanitizeConfig({ roles: { scout: { model: 'b' } } }, log), EMPTY_CONFIG);
    assert.deepEqual(roster.sanitizeConfig({ roles: { scout: { provider: '', model: 'b' } } }, log), EMPTY_CONFIG);
    // 合法项被保留并 trim
    assert.deepEqual(roster.sanitizeConfig({ roles: { scout: { provider: ' p ', model: ' m ' } } }, log), {
      version: 1,
      roles: { scout: { provider: 'p', model: 'm' } },
      cache: { keepalive: { routes: {} } },
    });
    // 非法 effort 形状被丢掉，但模型配置保留
    assert.deepEqual(
      roster.sanitizeConfig({ roles: { scout: { provider: 'p', model: 'm', reasoningEffort: 'HIGH!' } } }, log),
      { version: 1, roles: { scout: { provider: 'p', model: 'm' } }, cache: { keepalive: { routes: {} } } },
    );
    assert.deepEqual(
      roster.sanitizeConfig({ roles: { scout: { provider: 'p', model: 'm', reasoningEffort: 'xhigh' } } }, log),
      { version: 1, roles: { scout: { provider: 'p', model: 'm', reasoningEffort: 'xhigh' } }, cache: { keepalive: { routes: {} } } },
    );
    // 版本不符只提示，不丢数据
    const migrated = roster.sanitizeConfig({ version: 99, roles: { builder: { provider: 'p', model: 'm' } } }, log);
    assert.equal(migrated.roles.builder.model, 'm');
  });

  await check('resolveRoleRoute：未配置 → undefined（= 继承 Lead）；配置 → 路由对象', () => {
    const config = roster.sanitizeConfig({ roles: { verify: { provider: 'p', model: 'm' } } });
    assert.equal(roster.resolveRoleRoute(config, 'verify').provider, 'p');
    assert.equal(roster.resolveRoleRoute(config, 'verify').reasoningEffort, undefined);
    assert.equal(roster.resolveRoleRoute(config, 'scout'), undefined);
    assert.equal(roster.resolveRoleRoute(undefined, 'scout'), undefined);
    assert.equal(roster.resolveRoleRoute({ roles: {} }, 'scout'), undefined);
    assert.equal(roster.resolveRoleRoute({ roles: {} }, 'not-a-role'), undefined);
    const withEffort = roster.sanitizeConfig({ roles: { builder: { provider: 'p', model: 'm', reasoningEffort: 'low' } } });
    assert.equal(roster.resolveRoleRoute(withEffort, 'builder').reasoningEffort, 'low');
  });

  await check('configuredRoleCount：数被覆盖的角色', () => {
    assert.equal(roster.configuredRoleCount(roster.defaultConfig()), 0);
    assert.equal(
      roster.configuredRoleCount(roster.sanitizeConfig({ roles: { scout: { provider: 'p', model: 'm' }, verify: { provider: 'p', model: 'm2' } } })),
      2,
    );
    assert.equal(roster.configuredRoleCount(undefined), 0);
  });

  console.log('lib/playbook.js');

  await check('全部模型可见文本都不含双花括号（persona 会把它当变量严格插值）', () => {
    assert.equal(hasTemplateBraces(playbook.PLAYBOOK), false, 'PLAYBOOK 里出现了 {{…}} 变量语法');
    assert.equal(hasTemplateBraces(playbook.TEAM_POLICY), false, 'TEAM_POLICY 里出现了 {{…}} 变量语法');
    assert.equal(hasTemplateBraces(playbook.TEAMMATE_CARD), false, 'TEAMMATE_CARD 里出现了 {{…}} 变量语法');
    for (const roleId of roster.ROLE_IDS) {
      assert.equal(hasTemplateBraces(playbook.teammateBrief(roleId, roleId)), false, `角色简报 ${roleId} 里出现了 {{…}} 变量语法`);
    }
    assert.equal(hasTemplateBraces(playbook.teamCommandLine('x')), false);
    assert.equal(hasTemplateBraces(playbook.wakeInstruction('scout', '只做调研')), false);
  });

  await check('模型可见文本零 emoji（用户硬要求；代码注释里的不算）', () => {
    // 覆盖全部会注入模型的文本：三段提示词 + 每个角色的派活简报 + 唤醒文案 + 命令行。
    // 修复前的现场：PLAYBOOK 曾命令 Lead 用 问号/箭头 排版（2026-10-04 审查 P1-2）。
    for (const [label, text] of visibleModelTexts(playbook, roster)) {
      const found = text.match(MODEL_TEXT_EMOJI);
      assert.ok(found === null, label + ' 含 emoji：' + JSON.stringify([...new Set(found || [])]));
    }
  });

  await check('PLAYBOOK 含分轮面试式提问的关键要素（设计树/前沿/分轮/格式/等答复/事实归 Lead）', () => {
    const text = playbook.PLAYBOOK;
    for (const marker of ['设计树', '前沿', '推荐：', '找事实是你的工作', '不要替用户拍板', '用户明确说', '共享理解']) {
      assert.ok(text.includes(marker), `PLAYBOOK 缺少标记：${marker}`);
    }
    assert.ok(/Q1/u.test(text) && /Q2/u.test(text), 'PLAYBOOK 缺少 Q1/Q2 的排版示例');
  });

  await check('PLAYBOOK：只提 /team，不提已删除的 /team-off，并交代用 disable_agent_team 关团队', () => {
    const text = playbook.PLAYBOOK;
    assert.ok(text.includes('/team'), 'PLAYBOOK 没有交代 /team 这个入口');
    assert.ok(!text.includes('/team-off'), 'PLAYBOOK 还在提 /team-off（那个命令已按用户要求删除）');
    assert.ok(text.includes('disable_agent_team'), 'PLAYBOOK 没有交代「关掉团队」的新做法（调 disable_agent_team）');
    assert.ok(text.includes('只属于调度模式'), 'PLAYBOOK 没有写清「这套团队只属于调度模式」这条边界');
  });

  await check('PLAYBOOK 的角色编制表与 lib/roster.js 逐行一致（顺序 + id 都要对）', () => {
    // 旧版本只做 includes(roleId)，而散文里也逐个写着角色 id → 把整张表删掉都照样通过。
    // 现在真的去解析表行：`| \`<id>\` | …`，并按顺序比对。
    const rows = [];
    for (const line of playbook.PLAYBOOK.split('\n')) {
      const match = /^\|\s*`([a-z][a-z0-9-]*)`\s*\|/u.exec(line.trim());
      if (match !== null) rows.push(match[1]);
    }
    assert.deepEqual(rows, [...roster.ROLE_IDS], 'PLAYBOOK 的角色表行与 ROLES 不一致（顺序/缺项/多项）');
    // 每一行的「名称 / 使命 / 写权限 / 什么时候叫」都要来自角色定义本身，而不是另写一份散文。
    for (const role of roster.ROLES) {
      const line = playbook.PLAYBOOK.split('\n').find((candidate) => candidate.trim().startsWith(`| \`${role.id}\` |`));
      assert.ok(line !== undefined, `PLAYBOOK 缺 ${role.id} 的行`);
      assert.ok(line.includes(role.label), `${role.id} 行缺 label`);
      assert.ok(line.includes(role.when), `${role.id} 行缺 when`);
    }
    assert.ok(playbook.PLAYBOOK.includes('/team'), 'PLAYBOOK 没有交代 /team 这个入口');
    assert.ok(!playbook.PLAYBOOK.includes('/智能体团队'), 'PLAYBOOK 不该再提 /智能体团队（Web 客户端会吞掉未注册的斜杠输入）');
    assert.ok(playbook.PLAYBOOK.includes('enable_agent_team'), 'PLAYBOOK 没有要求 Lead 调 enable_agent_team');
    assert.ok(playbook.PLAYBOOK.includes('subagent'), 'PLAYBOOK 没有交代「团队没开时用一次性子代理查事实」这条路');
  });

  await check('TEAMMATE_CARD 对所有队员逐字节相同（缓存命中率的硬前提）', () => {
    const card = playbook.TEAMMATE_CARD;
    assert.equal(typeof card, 'string');
    assert.ok(card.length > 0);
    assert.ok(card.includes('你不是 Lead'), '队员卡没有身份否证');
    assert.ok(card.includes('send_message'), '队员卡没有交代汇报方式');
    assert.ok(card.includes('FS_STALE_VERSION'), '队员卡没有交代版本守卫冲突的处理方式');
    // 关键不变量：卡里不许出现任何角色 id、也不许出现任何「随队员变化」的占位。
    for (const roleId of roster.ROLE_IDS) {
      assert.ok(!card.includes(roleId), `队员卡里出现了角色 id "${roleId}" —— 这会让每个角色的提示词前缀各不相同，缓存命中率直接掉下来`);
    }
    for (const token of ['${', '{name}', '{role}']) {
      assert.ok(!card.includes(token), `队员卡里出现了随队员变化的占位 ${token}`);
    }
    // 按角色分叉的老 API 必须消失：留着它早晚有人接回去。
    assert.equal(playbook.teammateCard, undefined, 'teammateCard 又回来了：队员卡必须与角色无关');
  });

  await check('teammateBrief：每个角色都有使命/纪律/写权限，且角色之间确实不同', () => {
    const seen = new Map();
    for (const role of roster.ROLES) {
      const brief = playbook.teammateBrief(role.id, role.id);
      assert.equal(typeof brief, 'string');
      assert.ok(brief.includes(role.mission), `${role.id} 的简报缺使命`);
      assert.ok(brief.includes(role.writes), `${role.id} 的简报缺写权限`);
      for (const duty of role.duties) assert.ok(brief.includes(duty), `${role.id} 的简报缺纪律：${duty}`);
      assert.ok(brief.includes(`"${role.id}"`), `${role.id} 的简报没有写队员名`);
      seen.set(role.id, brief);
    }
    // 角色差异只允许出现在这里，所以这里必须真的不同。
    assert.equal(new Set(seen.values()).size, roster.ROLES.length, '有两个角色的简报完全相同');
    // 未知角色也要给可读兜底，而不是拼出一个假角色。
    const unknown = playbook.teammateBrief('not-a-role', 'nope');
    assert.ok(unknown.length > 0 && unknown.includes('nope'));
    assert.ok(!unknown.includes('## 你的使命'), '未知角色不该凭空编出使命');
  });

  await check('lib/playbook.js 结构完整：三个常量都在、teammateBrief 在、模板字符串闭合', () => {
    // 动机（2026-10-04 事故）：一次「压缩」用字符串替换误伤了 TEAMMATE_CARD，注入 `= ` 前缀
    // 并删掉整个 teammateBrief，导致模块语法崩（selftest/integration 双双 Invalid token）。
    // 这条闸门直接认结构不认文本，任何替换事故都会当场红。
    const source = readFileSync(path.join(PLUGIN_DIR, 'lib', 'playbook.js'), 'utf8');
    for (const name of ['PLAYBOOK', 'TEAM_POLICY', 'TEAMMATE_CARD']) {
      assert.ok(new RegExp('^export const ' + name + ' = `', 'm').test(source), `playbook.js 少了 ${name} 的定义`);
    }
    assert.ok(/^export function teammateBrief\(/m.test(source), 'playbook.js 少了 teammateBrief 定义（角色差异唯一载体）');
    assert.ok(/^export function wakeInstruction\(/m.test(source), 'playbook.js 少了 wakeInstruction 定义');
    // 模板字符串闭合：每个 `export const X = ` 之后必须能找到同级的 `` `; ``。
    for (const match of source.matchAll(/^export const (\w+) = `([\s\S]*?)^`;/gm)) {
      assert.ok(match[2].length > 100, `${match[1]} 的正文只有 ${match[2].length} 字，像是被替换打断了`);
    }
    // 反引号必须成对（把转义 \` 排除后计数）。
    const raw = source.split('\\`').join('');
    assert.equal((raw.match(/`/g) || []).length % 2, 0, '反引号不成对——模板字符串没闭合');
    // 导出的常量长度必须与运行时值一致（防止「定义被截断但语法仍合法」）。
    assert.equal(playbook.PLAYBOOK.length >= 3000, true, `PLAYBOOK 实测只有 ${playbook.PLAYBOOK.length} 字`);
    assert.equal(playbook.TEAM_POLICY.length >= 300, true, `TEAM_POLICY 实测只有 ${playbook.TEAM_POLICY.length} 字`);
    assert.equal(playbook.TEAMMATE_CARD.length >= 800, true, `TEAMMATE_CARD 实测只有 ${playbook.TEAMMATE_CARD.length} 字`);
  });
  // ── 提示词卫生（2026-09-30 用户要求：干净、有条理、简洁而作用大）────────────────
  // 2026-10-05：预算表从 README 迁到 INTERFACES §2.1 —— README 改成面向使用者的简明文档，
  // 而这条对账需要一份**长期存在**的实现文档来承载。判据本身没变（仍是模块实测 .length）。
  await check('INTERFACES §2.1 提示词预算表的「当前」列 == 实测长度（防手抄漂移）', () => {
    const doc = readFileSync(path.join(PLUGIN_DIR, 'INTERFACES.md'), 'utf8');
    const measured = {
      PLAYBOOK: playbook.PLAYBOOK.length,
      TEAM_POLICY: playbook.TEAM_POLICY.length,
      TEAMMATE_CARD: playbook.TEAMMATE_CARD.length,
    };
    for (const label of ['PLAYBOOK', 'TEAM_POLICY', 'TEAMMATE_CARD']) {
      const value = measured[label];
      const pattern = '\\| `' + label + '` \\| ≤ (\\d+) \\| \\*\\*(\\d+)\\*\\*';
      const row = new RegExp(pattern).exec(doc);
      assert.ok(row !== null, '预算表里找不到 ' + label + ' 那一行');
      assert.equal(Number(row[2]), value, 'INTERFACES §2.1 预算表写 ' + label + ' 当前 ' + row[2] + '，实测 ' + value);
      assert.ok(value <= Number(row[1]), label + ' 实测 ' + value + ' 超过预算 ' + row[1]);
    }
    const leadRowPattern = '\\| Lead 侧合计 \\| ≤ (\\d+) \\| \\*\\*(\\d+)\\*\\*';
    const leadRow = new RegExp(leadRowPattern).exec(doc);
    assert.ok(leadRow !== null, '预算表里找不到 Lead 侧合计那一行');
    assert.equal(Number(leadRow[2]), playbook.PLAYBOOK.length + playbook.TEAM_POLICY.length, 'INTERFACES 的 Lead 侧合计与实测不符');
    // 队员侧合计也要对账（2026-10-04）：它 = 共享卡 + 该角色的简报。各角色简报长度不同，
    // 表里写的是**代表性样本**（scout），所以按这一口径核；超预算则直接 FAIL。
    const mateRow = new RegExp('\\| 队员侧合计（卡 \\+ 角色简报） \\| ≤ (\\d+) \\| \\*\\*(\\d+)\\*\\*').exec(doc);
    assert.ok(mateRow !== null, '预算表里找不到队员侧合计那一行');
    const mateMeasured = playbook.TEAMMATE_CARD.length + playbook.teammateBrief('scout', 'scout').length;
    assert.equal(Number(mateRow[2]), mateMeasured, 'INTERFACES 的队员侧合计与实测不符（卡 + scout 简报）');
    assert.ok(mateMeasured <= Number(mateRow[1]), '队员侧合计 ' + mateMeasured + ' 超过预算 ' + mateRow[1]);
  });

  await check('每个已注册团队工具都在**对应角色**的提示词里被提到（防装了没人用）', () => {
    // 动机（2026-10-04 §8）：新工具加进工具面却没告诉模型，它会一直躺在目录里占缓存前缀，
    // 谁也不会调 —— 集成测试全绿也发现不了。反过来，把 Lead 专属工具写进队员卡更糟：
    // 队员照做只会拿到一次失败调用。
    const leadText = playbook.PLAYBOOK + playbook.TEAM_POLICY;
    for (const name of roster.LEAD_TEAM_TOOL_NAMES) {
      // team_task_* 在提示词里是合并写的（一个前缀代表四个工具），按前缀判。
      const mentioned = leadText.includes(name) || (name.startsWith('team_task_') && leadText.includes('team_task_'));
      assert.ok(mentioned, 'Lead 提示词没提 ' + name + '：装了却不告诉它，等于白占每次请求的前缀');
    }
    for (const name of [roster.REPORT_TOOL_NAME, roster.ASK_LEAD_TOOL_NAME]) {
      assert.ok(playbook.TEAMMATE_CARD.includes(name), '队员卡没提队员专用工具 ' + name);
    }
    // Lead 专属工具不许出现在队员卡里（队员调不通, 只会浪费一轮）。
    for (const name of ['spawn_teammate', 'interrupt_agent', roster.WAKE_TOOL_NAME, roster.BROADCAST_TOOL_NAME]) {
      assert.ok(!playbook.TEAMMATE_CARD.includes(name), '队员卡泄漏了 Lead 专属工具 ' + name);
    }
  });


  await check('工具 description 与控制面回执文案零 emoji（模型可见，同一条硬要求）', () => {
    // lib/tools.js 需要 @deepseek-ai/dsh-tools 才能加载，junction 坏时拿不到定义；
    // 这里退化为**源码级**扫描：把所有 description: '...' 与控制面 diagnostics.push('...')
    // 的字面量取出来判 emoji，不依赖模块能加载。
    const source = readFileSync(path.join(PLUGIN_DIR, 'lib', 'tools.js'), 'utf8');
    const literals = [...source.matchAll(/description: (['"])((?:\\.|(?!\1)[^\\\n])*)\1/gu)].map((match) => match[2]);
    for (const match of source.matchAll(/diagnostics\.push\(['`"]([^'"`\n]*)['`"]/gu)) literals.push(match[1]);
    assert.ok(literals.length >= 20, `只扫到 ${literals.length} 条文案字面量，正则漂了？`);
    for (const text of literals) {
      const found = text.match(MODEL_TEXT_EMOJI);
      assert.ok(found === null, `工具文案含 emoji：${JSON.stringify([...new Set(found || [])])} <- ${text.slice(0, 60)}`);
    }
  });

  await check('import 边界：纯逻辑模块只许 import node: 与 ./（把散在 4 处的说法变成可跑断言）', () => {
    // 动机（2026-10-05 审查 §1-⑧）：这条事实此前散在 MAINTAINER-NOTES.md 与 INTERFACES 的、INTERFACES 的
    // 许可清单、各文件头三处**散文**里，代码级守卫是 0 命中。而它是有承重作用的：
    // selftest / drift-check 能在**没有安装期 junction** 的机器上直接 import 这几个模块
    // （selftest 文件头就是这么写的：零依赖、直接跑真代码）。一旦有人在 roster.js 里
    // 顺手 import 一个 @deepseek-ai 包，体检脚本会在别的机器上直接崩，而这里是唯一会先红的地方。
    // 注意：参照项目的教训（ARCHITECTURE.md:110-112）：纯文档的边界声明会滞后失效——
    // 所以这里借的是「可跑断言」那一半，不抄一份文档。
    const PURE_MODULES = ['roster.js', 'playbook.js', 'cache.js', 'resume.js', 'text-clip.js', 'graph.js'];
    const offenders = [];
    for (const file of PURE_MODULES) {
      const source = readFileSync(path.join(LIB, file), 'utf8');
      for (const match of source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gmu)) {
        const specifier = match[1];
        if (specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../')) continue;
        offenders.push(`${file} -> ${specifier}`);
      }
      // 动态 import 与 require 同样算（`await import('@deepseek-ai/...')` 一样会崩）。
      for (const match of source.matchAll(/(?:await\s+import|require)\(\s*['"]([^'"]+)['"]/gu)) {
        const specifier = match[1];
        if (specifier.startsWith('node:') || specifier.startsWith('./')) continue;
        offenders.push(`${file} -> ${specifier}（动态）`);
      }
    }
    assert.deepEqual(offenders, [], `这些纯逻辑模块 import 了非 node 内建的东西（会让零依赖体检脚本在别的机器上崩）：${offenders.join(', ')}`);
    // 反向：真正的宿主耦合模块**必须**能解析到那些包（否则 host 行起不来）——
    // 这条不在这里断言（需要 junction），由 drift-check 的第 10e 条负责。
  });

  await check('INTERFACES §1 的 roster 契约清单与真实导出逐项对账（双向）', () => {
    // 动机：这份清单是别人改插件时的**唯一接口文档**，飘了就等于骗人。
    // 2026-10-04 审查 P2-26/27：只做单向检查抓不到「代码加了导出、文档没补」，
    // 所以两侧都要判：文档有 / 代码无 -> FAIL；代码有 / 文档无 -> FAIL。
    const doc = readFileSync(path.join(PLUGIN_DIR, 'INTERFACES.md'), 'utf8');
    const section = doc.slice(doc.indexOf('## 1. '), doc.indexOf('## 2. '));
    const documented = new Set([...section.matchAll(/^export (?:const|let|function) (\w+)/gmu)].map((match) => match[1]));
    // 判据用「块里能解析出 roster 的已知符号」，不用 length/关键字黑名单：§1 的注释里本来就
    // 合法地写着 `-> undefined`（deriveRole 的返回值），拿裸字符串当守卫会误报。
    assert.ok(section.includes('lib/roster.js') && documented.has('ROLES'), '抓不到 INTERFACES §1 的整块（标题漂了？）');
    const actual = new Set(Object.keys(roster));
    assert.ok(documented.size >= 20, `只从文档解析出 ${documented.size} 个导出名，正则漂了？`);
    const ghost = [...documented].filter((name) => !actual.has(name));
    const undocumented = [...actual].filter((name) => !documented.has(name));
    assert.deepEqual(ghost, [], `文档列了但代码里没有（假接口）：${ghost.join(', ')}`);
    assert.deepEqual(undocumented, [], `代码导出了但文档没列（别人按文档改就会漏）：${undocumented.join(', ')}`);
    // 清单里写死的数量注释也必须为真（MEMBER=9 个、官方九个）。
    assert.equal(roster.MEMBER_TEAM_TOOL_NAMES.length, 9, '§1 注释写着队员 9 个');
    assert.equal(roster.TEAM_TOOL_NAMES.length, 9, '§1 注释写着官方九个团队工具');
    assert.equal(roster.LEAD_TEAM_TOOL_NAMES.length, 11, '§1 注释写着 Lead = 官方九个 + 为 Lead 加的两个');
    assert.equal(roster.TEAMMATE_TOOL_DENY.length, 9, '§1 的 deny 表(MAINTAINER-NOTES.md §4.5)列了 9 个名字');
  });

  await check('tools.js 用到的每个 runtime.<name> 都必须在 runtimeApi 门面上（缺键=静默失效）', () => {
    // lib/runtime.js 的 installTeamTools 传给工具定义的是 **runtimeApi 门面**，不是整个模块命名空间。
    // 而 tools.js 的调用形如 `runtime?.truncatedMemberIds?.() ?? []`：门面上少一个键，它不会抛错，
    // 只会**静默**变成「这个功能永远不生效」——截断标志、报告落账都属于这一类。
    // 所以每个被 tools.js 以代码形式调用的名字，都必须同时是 runtimeApi 的键（2026-10-04 审查 P2-21）。
    const source = readFileSync(path.join(PLUGIN_DIR, 'lib', 'runtime.js'), 'utf8');
    const facadeBlock = /const runtimeApi = \{[\s\S]*?\n\};/.exec(source);
    assert.ok(facadeBlock !== null, '抓不到 runtimeApi 门面（改名或换写法了？同步这条断言）');
    const facade = new Set([...facadeBlock[0].matchAll(/^  (\w+),?$/gm)].map((match) => match[1]));
    const toolsSource = readFileSync(path.join(PLUGIN_DIR, 'lib', 'tools.js'), 'utf8');
    const used = new Set();
    for (const line of toolsSource.split('\n')) {
      if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue; // 注释里提到不等于依赖
      for (const match of line.matchAll(/\bruntime\??\.([A-Za-z_]\w*)/g)) {
        const name = match[1];
        if (name === 'js' || name === 'enable' || name === 'disable') continue; // 开关工具走的是 host ctx 路径
        if (/^typeof runtime\??\./.test(line.trim()) && !line.includes('runtime.' + name + '(')) continue;
        used.add(name);
      }
    }
    assert.ok(used.size >= 4, `只解析出 ${used.size} 个依赖名，正则漂了？`);
    const missing = [...used].filter((name) => !facade.has(name));
    assert.deepEqual(missing, [], `门面上没有这些键，功能会静默失效：${missing.join(', ')}（在 lib/runtime.js 的 runtimeApi 里补上）`);
  });

  await check('INTERFACES §3 的 runtime 契约覆盖了**其它模块真正调用**的每个成员（双向）', () => {
    // 判据不是「列出全部导出」——runtime.js 有 30+ 个导出，多数是模块内部细节，全塞进文档
    // 只会让文档变噪音。真正的契约是**跨模块调用面**：index.js / preset.js / tools.js 里
    // 以代码形式写了 `runtime.<name>` 的每一个名字，§3 都必须登记；文档写了而代码没有的，
    // 就是假接口（2026-10-04 审查 P2-21/26）。
    // 注释里的 `runtime.<name>` **不算**（第一版算进来了，把一句解释当成契约，误报）。
    const source = readFileSync(path.join(PLUGIN_DIR, 'lib', 'runtime.js'), 'utf8');
    const actual = new Set([...source.matchAll(/^export (?:async )?function (\w+)|^export const (\w+)|^export \{ (\w+) \}/gm)].map((match) => match[1] ?? match[2] ?? match[3]));
    const doc = readFileSync(path.join(PLUGIN_DIR, 'INTERFACES.md'), 'utf8');
    const sec3 = doc.slice(doc.indexOf('## 3. `lib/runtime.js`'), doc.indexOf('### 3.1'));
    const documented = new Set([...sec3.matchAll(/^export (?:async )?function (\w+)|^export const (\w+)/gm)].map((match) => match[1] ?? match[2]));
    assert.ok(sec3.includes('lib/runtime.js') && documented.has('status'), '抓不到 INTERFACES §3 的契约块（标题漂了？）');
    const ghost = [...documented].filter((name) => !actual.has(name));
    assert.deepEqual(ghost, [], `§3 列了但 runtime 没有（假接口）：${ghost.join(', ')}`);
    const used = new Set();
    for (const file of ['index.js', 'preset.js', 'tools.js']) {
      const text = readFileSync(path.join(PLUGIN_DIR, 'lib', file), 'utf8');
      for (const line of text.split('\n')) {
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue; // 整行注释: 提到不等于依赖
        for (const match of line.matchAll(/\bruntime\??\.([A-Za-z_]\w*)/g)) {
          if (match[1] !== 'js') used.add(match[1]); // 排掉 'runtime.js' 文件名里的假命中
        }
      }
    }
    const undocumented = [...used].filter((name) => !documented.has(name));
    assert.deepEqual(undocumented, [], `别的模块在用但 §3 没登记（改了会静默崩）：${undocumented.join(', ')}`);
    // status() 的返回形状：文档必须与真实字段一致（它是插件页与状态文件的读接口）。
    const statusBlock = /export function status\(agent\)[\s\S]*?\n  \};/.exec(source);
    assert.ok(statusBlock !== null, '抓不到 status() 的函数体（形状变了？）');
    for (const field of ['enabled', 'role', 'route', 'domain', 'restrictedTools', 'diagnostics']) {
      // 允许**简写属性**（status() 里就是 `role,` 而不是 `role:`）：字段名后跟冒号或直接到逗号。
      assert.ok(new RegExp('[{,\\s]' + field + '(\\s*:|\\s*,)').test(statusBlock[0]), `status() 少了字段 ${field}`);
      assert.ok(sec3.includes(field), `§3 的 status() 契约没写 ${field}（消费方按它渲染）`);
    }
  });

  await check('broadcast 目标规划：排除 lead、默认不唤醒 inactive、id 兼容、逐个理由可解释', () => {
    const rows = [
      { id: 'lead-id', name: 'lead', role: 'lead', status: 'running', diagnostics: [] },
      { id: 'a-id', name: 'builder', role: 'teammate', status: 'running', diagnostics: [] },
      { id: 'b-id', name: 'builder-2', role: 'teammate', status: 'inactive', diagnostics: [] },
      { id: 'c-id', name: 'scout', role: 'teammate', status: 'provisioning', diagnostics: [] },
    ];
    // 默认：只打 running/provisioning，lead 永不进目标。
    const auto = roster.planBroadcastTargets(rows, { callerName: 'lead' });
    assert.deepEqual(auto.targets, ['builder', 'scout'], '默认应只覆盖 running/provisioning 队员');
    assert.ok(auto.skipped.some((item) => item.target === 'builder-2' && item.reason.includes('includeInactive')), '被跳过的 inactive 队员必须带可操作的理由');
    // includeInactive 才拉起停着的队员（那要额外开一次 turn）。
    assert.deepEqual(roster.planBroadcastTargets(rows, { includeInactive: true }).targets, ['builder', 'builder-2', 'scout']);
    // 显式目标：认名字也认 agent id；对不上的如实报原因（与插件既有的 agent_id 兼容策略一致）。
    assert.deepEqual(roster.planBroadcastTargets(rows, { targets: ['b-id', 'ghost'], includeInactive: true }).targets, ['builder-2']);
    const ghost = roster.planBroadcastTargets(rows, { targets: ['ghost'] });
    assert.equal(ghost.skipped.length, 1, '不存在的目标要被报出来而不是静默丢掉');
    // 去重与自我排除。
    assert.deepEqual(roster.planBroadcastTargets(rows, { targets: ['builder', 'builder', 'lead'] }).targets, ['builder']);
    assert.deepEqual(roster.planBroadcastTargets([], {}).targets, []);
    assert.equal(roster.BROADCAST_TOOL_NAME, 'broadcast_message');
    assert.ok(roster.LEAD_TEAM_TOOL_NAMES.includes(roster.BROADCAST_TOOL_NAME), 'broadcast 不在 Lead 名单里 = 装不上');
    assert.ok(!roster.MEMBER_TEAM_TOOL_NAMES.includes(roster.BROADCAST_TOOL_NAME), 'broadcast 泄漏给了队员');
    assert.ok(!roster.TEAM_TOOL_NAMES.includes(roster.BROADCAST_TOOL_NAME), '自造工具不许进官方镜子名单（drift-check 靠它对齐官方）');
  });

  await check('截断标志：只标注被记账户里的队员，且不改入参（缓存前缀纪律）', () => {
    const rows = [
      { id: 'lead-id', name: 'lead', role: 'lead', status: 'running', diagnostics: [] },
      { id: 'a-id', name: 'builder', role: 'teammate', status: 'inactive', diagnostics: ['boom'] },
      { id: 'b-id', name: 'scout', role: 'teammate', status: 'inactive', diagnostics: [] },
    ];
    const marked = roster.annotateTruncatedMembers(rows, new Set(['a-id']));
    assert.equal(marked[1].diagnostics.length, 2, '标志要追加，不能吞掉官方已有的 diagnostics');
    assert.ok(marked[1].diagnostics.includes(roster.TRUNCATED_DIAGNOSTIC));
    assert.equal(marked[2].diagnostics.length, 0, '没被记账的队员不许被标注');
    assert.equal(marked[0], rows[0], '未受影响的行必须原样复用（不产生新对象）');
    assert.deepEqual(rows[1].diagnostics, ['boom'], '入参必须不被修改（该数组同时是 Lead 请求前缀的一部分）');
    // 幂等：重复标注不加第二份。
    assert.equal(roster.annotateTruncatedMembers(marked, new Set(['a-id']))[1].diagnostics.length, 2);
    // 空账本 = 原样返回（Lead 的团队没出截断时零副作用）。
    assert.equal(roster.annotateTruncatedMembers(rows, []).length, rows.length);
    assert.ok(roster.TRUNCATED_DIAGNOSTIC.includes('wake_teammate'), '标志文案要直接给出下一步动作');
  });
  await check('重试标志：只标注被记录里的队员、不改入参、幂等（与截断标志同一条缓存纪律）', () => {
    // 依据（2026-10-05 审查 §1-⑥）：插件此前把 llm/retry 整个丢掉，于是「被限流打死的队员」
    // 与「干完没交报告的队员」在状态面上不可区分。这条把它变成 list_agents 上可见的一行。
    const rows = [
      { id: 'lead-id', name: 'lead', role: 'lead', status: 'running', diagnostics: [] },
      { id: 'a-id', name: 'builder', role: 'teammate', status: 'inactive', diagnostics: ['创建失败原因'] },
      { id: 'b-id', name: 'scout', role: 'teammate', status: 'inactive', diagnostics: [] },
    ];
    const marked = roster.annotateRetriedMembers(rows, new Map([['a-id', '失败码 RATE_LIMIT · 第 2/5 次重试 · 等 800ms']]));
    assert.equal(marked[1].diagnostics.length, 2, '标志要追加，不能吞掉官方已有的 diagnostics');
    assert.ok(marked[1].diagnostics[1].startsWith(roster.RETRY_DIAGNOSTIC_PREFIX), '要带固定前缀，Lead 才认得出');
    assert.ok(marked[1].diagnostics[1].includes('RATE_LIMIT'), '失败码必须原样带上（不翻译、不推断）');
    assert.equal(marked[2].diagnostics.length, 0, '没被记录的队员不许被标注');
    assert.equal(marked[0], rows[0], '未受影响的行必须原样复用（不产生新对象）');
    assert.deepEqual(rows[1].diagnostics, ['创建失败原因'], '入参必须不被修改（该数组同时是 Lead 请求前缀的一部分）');
    // 空账本 = 原样返回（没有重试时不产生任何副作用）。
    assert.equal(roster.annotateRetriedMembers(rows, new Map()).length, rows.length);
    assert.equal(roster.annotateRetriedMembers(rows, {}).length, rows.length);
    assert.equal(roster.annotateRetriedMembers(rows, null)[1], rows[1], '空账本时连对象都不该重建');
    // 幂等：重复标注不加第二份。
    assert.equal(roster.annotateRetriedMembers(marked, new Map([['a-id', '失败码 RATE_LIMIT · 第 2/5 次重试 · 等 800ms']]))[1].diagnostics.length, 2);
    // 被标注的名字必须与截断标志能共存（两个标注器串联是生产路径）。
    const both = roster.annotateRetriedMembers(roster.annotateTruncatedMembers(rows, new Set(['b-id'])), new Map([['a-id', 'x']]));
    assert.equal(both[1].diagnostics.length, 2);
    assert.equal(both[2].diagnostics.length, 1);
    assert.ok(both[2].diagnostics[0] === roster.TRUNCATED_DIAGNOSTIC);
  });

  await check('提示词预算：系统提示词前缀不许膨胀（每多一个字，每次请求都多付一次钱）', () => {
    const budget = {
      PLAYBOOK: 3800,        // 调度模式方法论（Lead 与所有请求的前缀）。2026-10-04 从 4100 收到 3900、2026-10-04 再按审查 P2-10 收到 3800：只防「超预算」不防「贴边」，留余量给以后新增的纪律
      TEAM_POLICY: 800,      // 团队运行期事实（开后才有）
      TEAMMATE_CARD: 1150,   // 队员卡（每个队员的固定前缀）
    };
    const actual = {
      PLAYBOOK: playbook.PLAYBOOK.length,
      TEAM_POLICY: playbook.TEAM_POLICY.length,
      TEAMMATE_CARD: playbook.TEAMMATE_CARD.length,
    };
    const over = Object.entries(budget).filter(([name, limit]) => actual[name] > limit);
    assert.equal(
      over.length,
      0,
      `超预算：${over.map(([name, limit]) => `${name} ${actual[name]}>${limit}`).join('，')} —— 先删再加，别往上堆`,
    );
    const lead = actual.PLAYBOOK + actual.TEAM_POLICY;
    const mate = actual.TEAMMATE_CARD + playbook.teammateBrief('scout', 'scout').length;
    assert.ok(lead <= 4900, `Lead 侧提示词 ${lead} > 4900 字符`);
    assert.ok(mate <= 1550, `队员侧提示词 ${mate} > 1550 字符`);
  });

  await check('纪律只在 PLAYBOOK、运行期语义只在 TEAM_POLICY（重复写 = 多付钱 + 迟早自相矛盾）', () => {
    // 这些是**工具语义/状态语义**，只允许出现在 TEAM_POLICY（团队开启后才注入）。
    for (const marker of ['noProgress', 'inactive', '已持久化', 'revision']) {
      assert.ok(playbook.TEAM_POLICY.includes(marker), `TEAM_POLICY 缺少运行期语义：${marker}`);
      assert.ok(!playbook.PLAYBOOK.includes(marker), `PLAYBOOK 里重复了运行期语义「${marker}」——那属于 TEAM_POLICY`);
    }
    // 这些是**纪律**，只允许出现在 PLAYBOOK。
    for (const marker of ['设计树', '写域', '返工回同一个队员', '逐条裁决']) {
      assert.ok(playbook.PLAYBOOK.includes(marker), `PLAYBOOK 缺少纪律：${marker}`);
      assert.ok(!playbook.TEAM_POLICY.includes(marker), `TEAM_POLICY 里重复了纪律「${marker}」——那属于 PLAYBOOK`);
    }
  });

  await check('用户可见文本：/team 用用户原文、续写指令固定措辞、**没有**会被排队的注入说明', () => {
    // `/team <args>` 注入给 Lead 的就是**用户自己那一行**（2026-10-01 用户反馈：会话里必须看到 /team，
    // 不能变成一段用户没打过的系统口吻气泡）。rawInput 的形状依据 dsh-commands 的 parseCommand。
    assert.equal(playbook.teamCommandLine(''), '/team', '空补充意图时注入 /team 本身');
    assert.equal(playbook.teamCommandLine(undefined), '/team');
    assert.equal(playbook.teamCommandLine('  只做调研  '), '/team 只做调研', '两端空白去掉、原文保留');
    assert.equal(playbook.teamCommandLine('a\nb'), '/team a\nb', '内部换行原样保留');
    // 2026-10-01 18:26 现场：模型自己开团后我们注入的说明会**排队在用户输入框**（followup → next-turn →
    // QueueDock），用户还得多点一次「插入」。那两个常量已删除，这里钉住「不许再加回来」。
    assert.equal(playbook.ENABLE_INSTRUCTION, undefined, 'ENABLE_INSTRUCTION 必须保持删除（否则会排队打断用户）');
    assert.equal(playbook.DISABLE_INSTRUCTION, undefined, 'DISABLE_INSTRUCTION 必须保持删除（同上）');
    // wake_teammate 的正文：必须说清「从断点续、不重头再来」，并且带上 Lead 的补充要求。
    const woke = playbook.wakeInstruction('scout', '只补 §3');
    // 「为什么停下」必须由队员自己判断：文案可以把输出上限列为候选原因，但不许把它写成既成事实
    // （2026-10-04 审查 P2-11：旧文案「你上一条回答被模型输出上限截断」会在其它停因下误导队员重做）。
    assert.ok(woke.includes('为什么停下'), '续写指令要把归因交回队员');
    assert.ok(!woke.includes('被模型**输出上限**截断'), '不许把输出上限写成既成事实');
    assert.ok(woke.includes('不要重头再来'), '续写指令必须禁止重做');
    assert.ok(woke.includes('report_result'), '续写指令必须要求照常交付');
    assert.ok(woke.includes('scout') && woke.includes('只补 §3'), '续写指令要带队员名与 Lead 的补充要求');
    assert.ok(!playbook.wakeInstruction('scout', '').includes('Lead 补充要求'), '没有补充要求时不留空段落');
    assert.ok(playbook.TEAM_POLICY.includes('spawn_teammate'));
    assert.ok(playbook.TEAM_POLICY.includes('FS_STALE_VERSION') || playbook.TEAMMATE_CARD.includes('FS_STALE_VERSION'));
    // TEAM_POLICY 只放运行期事实，不再复述 PLAYBOOK 已经讲过的纪律（两处各写一遍早晚互相矛盾）。
    assert.ok(!playbook.TEAM_POLICY.includes('设计树'), 'TEAM_POLICY 不该重复 PLAYBOOK 的方法论');
  });

  await check('开关工具不再自带注入器（工具路径只能靠返回值告诉模型状态）', () => {
    // 源码级判据：`controlToolDefinitions` 里不许出现 followup / inject( / pushInstruction 这类调用，
    // 否则又会往 next-turn 收件箱写东西 → 用户输入框上方多一条排队消息（用户 2026-10-01 明确要求不要）。
    const source = readFileSync(path.join(PLUGIN_DIR, 'lib', 'tools.js'), 'utf8');
    const body = functionBodyOf(source, 'export function controlToolDefinitions');
    for (const needle of ['pushInstruction(', '.followup(', '.send(']) {
      assert.ok(!body.includes(needle), `controlToolDefinitions 里又出现了 ${needle}（会把消息排进用户输入框）`);
    }
    assert.ok(body.includes('diagnostics.push('), '状态说明应当走工具返回值 diagnostics');
  });

  // ── lib/resume.js：会话级团队开关记忆的关键时间量（2026-10-05 审查 §1-③）─────────────
  //
  // 为什么要专门测这一组：resume.js **早就支持注入时钟**（sanitizeStore 收 now 参数），
  // 但此前没有任何测试走这条路 —— 全仓 grep 'resume' 于 selftest 是零命中，
  // integration-test 只在真实时钟下用它（写与读在同一次运行内，记录年龄≈0）。
  // 于是 `7 * 24 * 60 * 60 * 1000` 少写一个 `* 1000`（7 天写成 7 分钟）这类一行笔误，
  // 38 项 selftest + 56 项 drift-check + integration 全都不会红，
  // 表现却是「用户过几天重启 DSH，团队没自动恢复」——正是 MAINTAINER-NOTES.md §8.10 已经发生过一次的事故类型。
  // 这组用例全部走**纯函数** sanitizeStore（完全不落盘），与 selftest 的零依赖形态一致。
  await check('resume.sanitizeStore：TTL 边界两侧（注入时钟，防「7 天写成 7 分钟」这类笔误）', async () => {
    const resume = await load('resume.js');
    const now = 1_800_000_000_000;
    const withAge = (ageMs) => resume.sanitizeStore({
      version: resume.SESSIONS_VERSION,
      updatedAt: now,
      sessions: { 'session-old': { enabledAt: now - ageMs, lastSeenAt: now - ageMs, source: 'command' } },
    }, now).sessions;
    // TTL 的两侧：刚过期与还没过期必须分叉（把常量改动锚到行为上，而不是断言常量等于某个数）。
    assert.equal(Object.keys(withAge(resume.SESSION_TTL_MS - 1)).length, 1, 'TTL 内 1 毫秒的记录必须保留');
    assert.equal(Object.keys(withAge(resume.SESSION_TTL_MS + 1)).length, 0, '刚过 TTL 的记录必须丢掉');
    assert.equal(Object.keys(withAge(0)).length, 1, '刚写的记录必须保留');
    // 量级锚点：TTL 是「天」级、不是「分钟」级。7*24*60*60*1000 写少一个 *1000 会变成 7 分钟，
    // 这条断言会在那一刻红（11 分钟大的记录：正确实现保留，7 分钟实现丢弃）。
    assert.equal(Object.keys(withAge(11 * 60 * 1000)).length, 1, 'TTL 至少要有小时级——10 分钟级的 TTL 是笔误');
    assert.ok(resume.SESSION_TTL_MS >= 24 * 60 * 60 * 1000, 'TTL 必须 >= 1 天（团队记忆至少要跨一个工作日）');
  });

  await check('resume.sanitizeStore：版本不符整份丢弃、字段白名单、坏时间戳用 now 顶上', async () => {
    const resume = await load('resume.js');
    const now = 1_800_000_000_000;
    const row = { enabledAt: now, lastSeenAt: now, source: 'tool' };
    // 版本不符 → 整份丢弃（宁可让用户重开一次团队，也不猜旧形状）。
    assert.deepEqual(resume.sanitizeStore({ version: resume.SESSIONS_VERSION + 1, sessions: { a: row } }, now).sessions, {});
    assert.deepEqual(resume.sanitizeStore(null, now).sessions, {});
    assert.deepEqual(resume.sanitizeStore({ version: resume.SESSIONS_VERSION, sessions: [] }, now).sessions, {});
    // 字段白名单：非白名单字段不进结果（文件被手改坏也不带入运行时）。
    const dirty = resume.sanitizeStore({
      version: resume.SESSIONS_VERSION,
      updatedAt: now,
      sessions: {
        'session-a': { enabledAt: now, lastSeenAt: now, source: 'command', evil: 'x', __proto__: { polluted: 1 } },
        'session-b': { lastSeenAt: 'not-a-number', enabledAt: -5 },
        '': row,
        'session-c': 'not-an-object',
      },
    }, now);
    assert.deepEqual(Object.keys(dirty.sessions).sort(), ['session-a', 'session-b'], '空 id 与非对象记录必须丢掉');
    assert.equal(dirty.sessions['session-a'].evil, undefined, '白名单外的字段不许进结果');
    assert.equal(dirty.sessions['session-a'].source, 'command');
    assert.equal(dirty.sessions['session-b'].lastSeenAt, now, '坏时间戳用 now 顶上（不让一个坏字段废掉整份）');
    assert.equal(dirty.sessions['session-b'].enabledAt, now);
    assert.equal(Object.prototype.polluted, undefined, '不允许原型污染');
  });

  await check('resume.sanitizeStore：超过 MAX_SESSIONS 时淘汰最旧的、且保序（新的在前）', async () => {
    const resume = await load('resume.js');
    const now = 1_800_000_000_000;
    const sessions = {};
    for (let index = 0; index < resume.MAX_SESSIONS + 25; index += 1) {
      // 越早的 index 越旧：lastSeenAt 递增。
      sessions[`session-${index}`] = { enabledAt: now, lastSeenAt: now - (resume.MAX_SESSIONS + 25 - index) * 1000 };
    }
    const kept = resume.sanitizeStore({ version: resume.SESSIONS_VERSION, updatedAt: now, sessions }, now).sessions;
    const ids = Object.keys(kept);
    assert.equal(ids.length, resume.MAX_SESSIONS, '超出上限必须裁到 MAX_SESSIONS');
    assert.equal(ids[0], `session-${resume.MAX_SESSIONS + 24}`, '最新的必须排在最前（淘汰顺序依赖它）');
    assert.equal(kept[`session-0`], undefined, '最旧的必须被淘汰');
    // 保序的另一面：留着的那批仍按 lastSeenAt 从新到旧。
    for (let index = 1; index < ids.length; index += 1) {
      assert.ok(kept[ids[index - 1]].lastSeenAt >= kept[ids[index]].lastSeenAt, '保留项必须按 lastSeenAt 降序');
    }
  });

  await check('resolveMemberRoute：显式 spawn > 实时角色配置 > 跟随 Lead（2026-10-01 修的「跟随 Lead 不生效」）', () => {
    const config = { version: 1, roles: { builder: { provider: 'p1', model: 'm1' } }, cache: { keepalive: { routes: {} } } };
    const roleRoute = roster.resolveRoleRoute(config, 'builder');
    // ① 工具调用显式给了 provider/model：钉死这次 spawn（显式 > 角色配置）。
    assert.deepEqual(
      roster.resolveMemberRoute({ provider: 'p9', model: 'm9' }, roleRoute, undefined),
      { provider: 'p9', model: 'm9' },
    );
    // ② 只有角色配置：跟着**实时**配置走（面板改了，下一次请求就是这个新值）。
    assert.deepEqual(roster.resolveMemberRoute(undefined, roleRoute, undefined), { provider: 'p1', model: 'm1' });
    // ③ 面板上把角色改回「跟随 Lead」（配置里没有这条了）→ 必须返回 undefined = 不覆盖。
    assert.equal(roster.resolveMemberRoute(undefined, roster.resolveRoleRoute({ roles: {} }, 'builder'), undefined), undefined);
    // ④ 只显式给思考强度：只覆盖强度，模型仍跟着 Lead/角色配置（不再像旧版那样被忽略）。
    assert.deepEqual(roster.resolveMemberRoute(undefined, undefined, 'high'), { reasoningEffort: 'high' });
    assert.deepEqual(roster.resolveMemberRoute({ provider: 'p9', model: 'm9' }, undefined, 'high'), { provider: 'p9', model: 'm9', reasoningEffort: 'high' });
    // ⑤ 角色配置里自带强度，显式强度优先。
    const withEffort = roster.resolveRoleRoute({ roles: { builder: { provider: 'p1', model: 'm1', reasoningEffort: 'low' } } }, 'builder');
    assert.deepEqual(roster.resolveMemberRoute(undefined, withEffort, undefined), { provider: 'p1', model: 'm1', reasoningEffort: 'low' });
    assert.deepEqual(roster.resolveMemberRoute(undefined, withEffort, 'xhigh'), { provider: 'p1', model: 'm1', reasoningEffort: 'xhigh' });
  });

  console.log('');
  console.log('lib/cache.js（缓存保活：纯策略部分）');

  await check('线路族：DeepSeek 默认 off（磁盘缓存，等待期不会过期），其它线路 auto + 300s', () => {
    const deepseek = cache.resolveKeepalivePolicy({ provider: 'deepseek-account', model: 'deepseek-flash' });
    assert.equal(deepseek.mode, 'off', 'DeepSeek 线路必须默认关闭保活');
    assert.equal(deepseek.family, 'deepseek');
    const claude = cache.resolveKeepalivePolicy({ provider: 'anthropic', model: 'claude-x' });
    assert.equal(claude.mode, 'auto');
    assert.equal(claude.ttlSeconds, 300);
    assert.equal(claude.intervalSeconds, 210, '间隔必须是 0.7 × TTL（比上游的 285/300 保守）');
    const unknown = cache.resolveKeepalivePolicy({ provider: 'our-free-model', model: 'space-bunny-free' });
    assert.equal(unknown.mode, 'auto');
    assert.equal(unknown.family, 'generic');
  });

  await check('用户覆盖：越具体越优先，非法值不生效，间隔被夹到 [60, 3540]', () => {
    const overrides = {
      generic: { mode: 'off' },
      'our-free-model': { mode: 'on' },
      'our-free-model/space-bunny-free': { mode: 'auto', intervalSeconds: 99999 },
    };
    const exact = cache.resolveKeepalivePolicy({ provider: 'our-free-model', model: 'space-bunny-free', overrides });
    assert.equal(exact.mode, 'auto', '整条线路的覆盖必须赢过 provider 级与族级');
    assert.equal(exact.source, 'override:our-free-model/space-bunny-free');
    assert.equal(exact.intervalSeconds, 3540, '超过上限的间隔要被夹住');
    const provider = cache.resolveKeepalivePolicy({ provider: 'our-free-model', model: 'other', overrides });
    assert.equal(provider.mode, 'on');
    // 非法 mode 不生效（sanitizeConfig 会先丢掉它，这里再钉一次防御层）
    const bogus = cache.resolveKeepalivePolicy({ provider: 'x', model: 'y', overrides: { x: { mode: 'always' } } });
    assert.equal(bogus.source, 'route-family:generic');
  });

  await check('间隔抖动：在 ±7% 内，且永不越界', () => {
    const policy = { intervalSeconds: 300 };
    assert.equal(cache.jitteredIntervalMs(policy, () => 0.5), 300_000, '中位随机数必须给出基准间隔');
    const low = cache.jitteredIntervalMs(policy, () => 0);
    const high = cache.jitteredIntervalMs(policy, () => 1);
    assert.ok(low >= 300_000 * 0.9 && low <= 300_000, `下界抖动越界：${low}`);
    assert.ok(high >= 300_000 && high <= 300_000 * 1.1, `上界抖动越界：${high}`);
    assert.equal(cache.jitteredIntervalMs({ intervalSeconds: 60 }, () => 0), 60_000, '下限不能被抖动压到 60s 以下');
  });

  await check('decidePing：只有「真在等人 + 没有在途请求 + 到期」才允许发 ping', () => {
    const base = {
      active: true, mode: 'auto', armed: true, inflight: 0,
      lastRequestAt: 0, now: 1_000_000, intervalMs: 210_000,
      waiters: 1, attemptsInWait: 0, attemptsInSession: 0, pingTokens: 0, misses: 0,
    };
    assert.equal(cache.decidePing(base).ok, true);
    const cases = [
      [{ active: false }, 'team-not-active'],
      [{ mode: 'off' }, 'mode-off'],
      [{ mode: 'auto', armed: false }, 'no-cache-evidence-yet'],
      [{ inflight: 1 }, 'request-inflight'],
      [{ waiters: 0 }, 'no-waiting-teammate'],
      [{ attemptsInWait: cache.PINGS_PER_WAIT_CAP }, 'wait-attempt-limit'],
      [{ attemptsInSession: cache.PINGS_PER_SESSION_CAP }, 'session-attempt-limit'],
      [{ pingTokens: cache.PING_TOKEN_CAP }, 'session-token-limit'],
      [{ misses: cache.MISS_STOP_THRESHOLD }, 'repeated-misses'],
      [{ stopped: 'repeated-misses' }, 'stopped:repeated-misses'],
      [{ lastRequestAt: 1_000_000 - 1_000 }, 'too-soon'],
    ];
    for (const [patch, reason] of cases) {
      const decision = cache.decidePing({ ...base, ...patch });
      assert.equal(decision.ok, false, `${reason} 场景不该允许 ping`);
      assert.equal(decision.reason, reason, `期望 reason=${reason}，实际 ${decision.reason}`);
    }
    // mode=on 时不要求先证明缓存命中（用户显式要求）
    assert.equal(cache.decidePing({ ...base, mode: 'on', armed: false }).ok, true);
  });

  await check('captureRequest：只带前缀字段、不克隆不可克隆对象、保留 tools/system', () => {
    const options = {
      provider: 'p', model: 'm', maxTokens: 4096, temperature: 0.7, reasoningEffort: 'high',
      system: 'sys', tools: [{ name: 't' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    const captured = cache.captureRequest(options);
    assert.equal(captured.ok, true);
    assert.deepEqual(Object.keys(captured.request).sort(), ['messages', 'model', 'provider', 'system', 'tools']);
    assert.equal(captured.request.reasoningEffort, undefined, 'reasoningEffort 不能进 ping（1 token 上限在推理模型上会翻车）');
    assert.equal(captured.request.maxTokens, undefined, 'maxTokens 由 ping 自己设成 1');
    // 入参被改不会影响已抓取的前缀（深拷贝）
    options.messages.push({ role: 'user', content: [] });
    assert.equal(captured.request.messages.length, 1);
    // 坏输入不抛错，返回可读原因
    assert.equal(cache.captureRequest({ provider: 'p' }).ok, false);
    assert.equal(cache.captureRequest(undefined).ok, false);
  });

  await check('decidePing 的默认值：未知线路也先要求「线路自己证明有缓存命中」', () => {
    assert.equal(cache.resolveKeepalivePolicy({}).mode, 'auto');
    assert.equal(cache.resolveKeepalivePolicy({}).source, 'route-family:generic');
    assert.equal(cache.DEFAULT_TTL_SECONDS, 300);
  });

  console.log('');
  console.log('lib/graph.js（工作区画布：事件折叠与建图，全部是真实数据的判据）');

  const graph = await load('graph.js');

  await check('normId / normalizePath：id 去前缀、路径取尾 4 段且拒空', () => {
    assert.equal(graph.normId('session-abc'), 'abc');
    assert.equal(graph.normId('abc'), 'abc');
    assert.equal(graph.normId(''), '');
    assert.equal(graph.normalizePath('D:\\x\\y\\z\\w\\lib\\client.js'), 'z/w/lib/client.js');
    assert.equal(graph.normalizePath('C:/a/b/c/d/e.txt'), 'b/c/d/e.txt');
    assert.equal(graph.normalizePath(''), null);
    assert.equal(graph.normalizePath(undefined), null);
  });

  await check('foldEvents：usage 按 token-meter 同款 last-wins 去重（同 turn/step 覆盖不是累加）', () => {
    const s = graph.foldSession([
      { type: 'assistant/message', seq: 1, time: 10, data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 0 } } },
      // 同一 turn/step 的第二次结算（重试后修正）：替换，不叠加。
      { type: 'assistant/message', seq: 2, time: 20, data: { turn: 1, step: 1, usage: { inputTokens: 120, outputTokens: 8, cacheReadTokens: 900, cacheWriteTokens: 0 } } },
    ]);
    assert.equal(s.usage.uncachedInputTokens, 120);
    assert.equal(s.usage.outputTokens, 8);
    assert.equal(s.usage.cacheReadTokens, 900);
    // pressureFrom = input + cacheRead + cacheWrite（prompt 侧，不含 output），与官方同式。
    assert.equal(s.pressureTokens, 120 + 900);
  });

  await check('foldEvents：llm/retry-started 关掉替换槽，让重试的那次重新计入', () => {
    const base = { type: 'assistant/message', data: { turn: 2, step: 1, usage: { inputTokens: 50, outputTokens: 3, cacheReadTokens: 10, cacheWriteTokens: 0 } } };
    const s = graph.foldSession([
      { ...base, seq: 1, time: 1 },
      { type: 'llm/retry-started', seq: 2, time: 2, data: { turn: 2, step: 1 } },
      { ...base, seq: 3, time: 3, data: { turn: 2, step: 1, usage: { inputTokens: 60, outputTokens: 4, cacheReadTokens: 10, cacheWriteTokens: 0 } } },
    ]);
    // 关掉替换槽后第二条不再被当成「同 turn/step 的替换」，而是各自计入 → 50+60。
    assert.equal(s.usage.uncachedInputTokens, 110);
  });

  await check('foldEvents：todo/write 计 done/running/total（画布 TODO 的唯一真值）', () => {
    const s = graph.foldSession([
      { type: 'todo/write', seq: 1, time: 1, data: { todos: [
        { content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' },
      ] } },
      // 后写覆盖前写（todo/write 是整表快照，不是增量）。
      { type: 'todo/write', seq: 2, time: 2, data: { todos: [{ content: 'a', status: 'completed' }] } },
    ]);
    assert.deepEqual(s.todo, { done: 1, running: 0, total: 1 });
  });

  await check('foldEvents：tool/call 的写/读文件进 wrote/read 集（承接边的原料），坏 JSON 跳过不猜', () => {
    const s = graph.foldSession([
      { type: 'tool/call', seq: 1, time: 1, data: { name: 'edit', arguments: JSON.stringify({ file_path: 'D:/p/q/r/s/a.ts' }) } },
      { type: 'tool/call', seq: 2, time: 2, data: { name: 'write', arguments: { file_path: 'p/q/r/s/b.ts' } } },
      { type: 'tool/call', seq: 3, time: 3, data: { name: 'read', arguments: JSON.stringify({ file_path: 'p/q/r/s/a.ts' }) } },
      { type: 'tool/call', seq: 4, time: 4, data: { name: 'read', arguments: '{坏 JSON' } },
      { type: 'tool/call', seq: 5, time: 5, data: { name: 'pwsh', arguments: JSON.stringify({ command: 'ls' }) } },
    ]);
    assert.ok(s.wrote.has('q/r/s/a.ts'), '盘符去掉、留最后 4 段');
    assert.ok(s.wrote.has('q/r/s/b.ts'));
    assert.ok(s.read.has('q/r/s/a.ts'));
    assert.equal(s.read.size, 1, '坏 JSON 与无 file_path 的调用都不该进读集');
  });

  await check('foldEvents：runtimeMs = Σ(turn/end − turn/start)，未闭合的 turn 不计', () => {
    const s = graph.foldSession([
      { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
      { type: 'turn/end', seq: 2, time: 3500, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 3, time: 4000, data: { turn: 2 } }, // 没有对应 end
    ]);
    assert.equal(s.runtimeMs, 2500);
    assert.equal(s.lastTurnEndReason, 'completed');
  });

  await check('foldEvents：Lead 派活按 targetId、队员交付按 senderName 分账（team/message 集中记在 Lead 会话）', () => {
    const s = graph.foldSession([
      { type: 'team/message/queued', seq: 1, time: 1, data: { message: { id: 'q1', senderName: 'lead', targetId: 'm1', content: [] } } },
      { type: 'team/message/queued', seq: 2, time: 2, data: { message: { id: 'q2', senderName: 'm1', targetId: 'session-lead', content: [] } } },
      { type: 'team/message/queued', seq: 3, time: 3, data: { message: { id: 'q3', senderName: 'm2', targetId: 'session-lead', content: [] } } },
    ]);
    assert.equal(s.teamMsg.get('m1').dispatched, 1);
    assert.equal(s.msgFrom.get('m1').get('lead').queued, 1);
    assert.equal(s.msgFrom.get('m2').get('lead').queued, 1);
  });

  await check('foldEvents：team/message/delivered 是**扁平形状**（只有 messageId/targetId），靠 queued 的表回连发件人', () => {
    // 回归：旧实现按 data.message 读 delivered，而官方 delivered 根本没有 message 包装
    // （dsh-experimental-agent-team/lib/index.js:958-962）→ 投递回执一直是死代码，delivered 永远 0。
    const s = graph.foldSession([
      { type: 'team/message/queued', seq: 1, time: 1, data: { message: { id: 'q1', senderName: 'lead', targetId: 'm1', content: [] } } },
      { type: 'team/message/queued', seq: 2, time: 2, data: { message: { id: 'q2', senderName: 'm1', targetId: 'session-lead', content: [] } } },
      // delivered：扁平，无 message 包装。
      { type: 'team/message/delivered', seq: 3, time: 3, data: { messageId: 'q1', targetId: 'm1' } },
      { type: 'team/message/delivered', seq: 4, time: 4, data: { messageId: 'q2', targetId: 'session-lead' } },
    ]);
    assert.equal(s.teamMsg.get('m1').delivered, 1, 'Lead 派出去的投递计数');
    assert.equal(s.msgFrom.get('m1').get('lead').delivered, 1, '队员投递回执按 messageId 回连到发件人');
    assert.equal(s.msgFrom.get('m1').get('lead').queued, 1, '排队与投递各自独立计数');
  });

  await check('buildGraph：双向承接合并成一条边（both=true、权重相加、files 有界）', () => {
    const stats = (writes, reads) => { const s = graph.emptyStats(); s.wrote = new Set(writes); s.read = new Set(reads); return s };
    const bySession = new Map([
      ['lead', graph.emptyStats()],
      ['a', stats(['x/f1', 'x/f2'], ['x/f3', 'x/f4'])],
      ['b', stats(['x/f3', 'x/f4'], ['x/f1', 'x/f2'])],
    ]);
    const members = [{ id: 'a', name: 'a', role: 'teammate' }, { id: 'b', name: 'b', role: 'teammate' }];
    const g = graph.buildGraph({ leadId: 'lead', leadName: 'lead', members, statsBySession: bySession, tasks: [] });
    const handoff = g.edges.filter((e) => e.kind === 'handoff');
    assert.equal(handoff.length, 1, 'a↔b 两个方向合并成一条');
    assert.equal(handoff[0].both, true);
    assert.equal(handoff[0].weight, 4, 'a写b读2 + b写a读2');
    assert.ok(handoff[0].files.length <= 3, '样例文件名有界（tooltip 不撑大响应）');
  });

  await check('buildGraph：交付线由 Lead 账本里「该队员发给 lead 的消息」点亮（不是投递回执）', () => {
    const lead = graph.emptyStats();
    lead.msgFrom.set('a', new Map([['lead', { queued: 2, delivered: 0 }]]));
    const bySession = new Map([['lead', lead], ['a', graph.emptyStats()], ['b', graph.emptyStats()]]);
    const members = [{ id: 'a', name: 'a', role: 'teammate' }, { id: 'b', name: 'b', role: 'teammate' }];
    const g = graph.buildGraph({ leadId: 'lead', leadName: 'lead', members, statsBySession: bySession, tasks: [] });
    const dispatch = g.edges.filter((e) => e.kind === 'dispatch');
    const edgeA = dispatch.find((e) => e.to === 'a');
    const edgeB = dispatch.find((e) => e.to === 'b');
    assert.equal(edgeA.delivered, true);
    assert.equal(edgeA.reported, 2);
    assert.equal(edgeB.delivered, false, '没交过话的队员不该被点亮');
    assert.equal(dispatch.length, 2, '每个成员都有一条线（spawn 即派活），哪怕权重为 0');
  });

  await check('buildGraph：汇总 cacheHit = 全队 cacheRead / (cacheRead+新输入)，output 单列', () => {
    const mk = (out, inp, cache) => { const s = graph.emptyStats(); s.usage = { uncachedInputTokens: inp, outputTokens: out, cacheReadTokens: cache, cacheWriteTokens: 0 }; return s };
    const bySession = new Map([['lead', mk(10, 40, 60)], ['a', mk(5, 10, 90)]]);
    const g = graph.buildGraph({ leadId: 'lead', leadName: 'lead', members: [{ id: 'a', name: 'a', role: 'teammate' }], statsBySession: bySession, tasks: [] });
    // 总 cacheRead=150，总 prompt 侧 = (40+60)+(10+90)=200 → 150/200=0.75
    assert.ok(Math.abs(g.totals.cacheHit - 0.75) < 1e-9, `cacheHit=${g.totals.cacheHit}`);
    assert.equal(g.totals.outputTokens, 15);
    assert.equal(g.totals.totalTokens, 215);
  });

  await check('extractConversation：过滤框架注入、工具调用聚合成计数、正文有界、按 limit 取尾部', () => {
    const long = 'x'.repeat(5000);
    const rows = graph.extractConversation([
      // 框架注入：都不该出现在对话里（用户 2026-10-08 报的 #1）
      { type: 'user/message', data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: '<system-reminder>工作区指令' }] } },
      { type: 'user/message', data: { source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '<system-reminder>技能目录' }] } },
      { type: 'user/message', data: { source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 1' }] } },
      // 真人输入
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } },
      // 队员派活简报（source.kind 是 user，但内容是本插件生成的使命提示词）→ 也要过滤
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '<system-reminder>\n你是智能体团队的队员 "x"，角色 builder' }] } },
      // 助手正文 + 两次工具调用（应聚合成一行计数）
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: long }, { type: 'tool-call', name: 'read', arguments: '{"file_path":"a"}' }, { type: 'tool-call', name: 'write', arguments: '{"file_path":"b"}' }] } } },
      // 团队消息（成员日志里的 user/message 形状）
      { type: 'user/message', data: { source: { kind: 'team-message', messageId: 'm1' }, content: [{ type: 'text', text: 'lead → 补充情报' }] } },
      // 同一条团队消息的 queued 版本（Lead 日志）→ 靠 messageId 去重，只显示一次
      { type: 'team/message/queued', data: { message: { id: 'm1', senderName: 'lead', targetId: 'x', content: [{ type: 'text', text: '补充情报' }] } } },
    ], 10);
    assert.ok(rows.some((r) => r.kind === 'user' && r.text === '你好'), '真人输入没抽出来');
    assert.ok(!rows.some((r) => /system-reminder|Time sampled|技能目录|工作区指令|你是智能体团队的队员/.test(r.text)),
      `框架注入漏进了对话：${JSON.stringify(rows.map((r) => r.text.slice(0, 40)))}`);
    const asst = rows.find((r) => r.kind === 'assistant');
    assert.ok(asst.text.length <= 2001 && asst.text.endsWith('…'), '正文按 LINE_MAX 截断（代理对安全）');
    // 工具调用聚合成一行计数（不再逐条刷屏）
    const toolRows = rows.filter((r) => r.kind === 'tools');
    assert.equal(toolRows.length, 1, `工具调用应聚合成 1 行，实际 ${toolRows.length} 行`);
    assert.equal(toolRows[0].count, 2, `计数应为 2，实际 ${toolRows[0].count}`);
    assert.ok(!rows.some((r) => /read\(\{/.test(r.text)), '工具调用参数不该逐条列出');
    // 团队消息去重：m1 只出现一次
    assert.equal(rows.filter((r) => r.kind === 'team').length, 1, '同一条团队消息应去重');
  });

  await check('collectGraph：持久兜底必须走 ctx.get()（属性访问未 inject 的服务会抛错 → 兜底恒失效）', async () => {
    // 回归：原实现写 `ctx.sessionPersistence ?? ctx.get('sessionPersistence')`。
    // cordis 里属性访问一个不在本 fiber inject 列表里的服务会抛
    // `cannot get property "x" without inject`，于是属性访问先抛、`??` 被 try 吞掉，
    // persistence 恒为 undefined → 宿主重启后**所有队员的统计都显示成 0**（假数据）。
    // 这条断言用一个「只提供 get、属性访问抛错」的 ctx 替身把它钉住。
    const TEAM = 'selftest-lead';
    const MEMBER = 'selftest-member';
    const leadEvents = [
      { type: 'team/member', seq: 0, time: 1, data: { member: { id: MEMBER, name: 'builder-z', phase: 'active' } } },
      { type: 'team/message/queued', seq: 1, time: 2, data: { message: { id: 'q1', senderName: 'lead', targetId: MEMBER, content: [] } } },
    ];
    const memberEvents = [
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
      { type: 'assistant/message', seq: 1, time: 2000, data: { turn: 1, step: 1, usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 4500, cacheWriteTokens: 0 } } },
      { type: 'turn/end', seq: 2, time: 4000, data: { turn: 1, reason: { kind: 'completed' } } },
    ];
    const session = (id, events) => ({ id, seq: events.length, eventAt: (s) => events[s] });
    const leadSession = session(TEAM, leadEvents);
    const persistence = {
      open: async (id) => (id === MEMBER
        ? { header: {}, inheritedEventCount: 0, read: async () => ({ events: memberEvents }), close: async () => {} }
        : (() => { throw new Error('not persisted'); })()),
    };
    const ctx = {
      agents: { list: () => [{ id: TEAM, session: leadSession }], get: (id) => (id === TEAM ? { id: TEAM, session: leadSession } : undefined) },
      get: (name) => (name === 'sessionPersistence' ? persistence : undefined),
      // 关键：属性访问必须抛错（复刻 cordis 的 without inject 行为）。
      get sessionPersistence() { throw new Error('cannot get property "sessionPersistence" without inject'); },
    };
    const agentTeams = {
      listMembers: () => [
        { id: TEAM, name: 'lead', role: 'lead', status: 'active' },
        { id: MEMBER, name: 'builder-z', role: 'teammate', status: 'inactive' },
      ],
      listTasks: () => [],
    };
    const result = await graph.collectGraph({ ctx, agentTeams, leadAgent: { id: TEAM, session: leadSession }, isTeamEnabled: () => true });
    assert.equal(result.ok, true, JSON.stringify(result));
    const node = result.graph.nodes.find((n) => n.name === 'builder-z');
    assert.ok(node !== undefined, '无活体的队员没被画出来');
    assert.equal(node.totalTokens, 5050, '持久兜底没生效 → 统计成了 0（假数据）');
    assert.ok(Math.abs(node.cacheHit - 0.9) < 1e-9, `cacheHit=${node.cacheHit}`);
    assert.equal(node.runtimeMs, 3000);
  });

  await check('collectGraph：fork 队员的继承前缀不能被算成它自己的产出（活体 + 持久两条路径）', async () => {
    // 回归：官方 eventAt(seq) 是裸数组下标、**包含** fork 继承来的父会话前缀
    // （dsh-session/lib/index.js:1363-1365），官方专门有 ownEvents()/isOwnSeq()
    // （同文件 :1389-1391 / :1397-1399）来排掉它。
    // 实测（真实团队 session-4158e662）：3 个 fork 成员各带 884 条继承事件（97 条 assistant/message
    // 就是 Lead 自己的）→ 底栏总 token 多算 40659870（+28.8%）、承接边 32→14、
    // 队员的 wrote/read/todo 全是 Lead 的。这条断言把「必须切前缀」钉死。
    const TEAM = 'fork-lead';
    const MEMBER = 'fork-member';
    // 前缀 = 父会话历史（含 1 条有 usage 的 assistant 消息 + 1 条 tool/call 写文件）
    const prefix = [
      { type: 'assistant/message', seq: 0, time: 1000, data: { turn: 1, step: 1, usage: { inputTokens: 900000, outputTokens: 50000, cacheReadTokens: 5000000, cacheWriteTokens: 0 } } },
      { type: 'tool/call', seq: 1, time: 1100, data: { name: 'write', arguments: '{"file_path":"/parent/only.txt"}' } },
      { type: 'todo/write', seq: 2, time: 1200, data: { todos: [{ content: 'p', status: 'completed' }] } },
    ];
    // 自己的事件（descriptor 之后）
    const own = [
      { type: 'subagent/descriptor', seq: 3, time: 2000, data: {} },
      { type: 'assistant/message', seq: 4, time: 3000, data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 0 } } },
      { type: 'tool/call', seq: 5, time: 3100, data: { name: 'write', arguments: '{"file_path":"/own/only.txt"}' } },
    ];
    const log = [...prefix, ...own];
    const leadEvents = [
      { type: 'team/member', seq: 0, time: 1, data: { member: { id: MEMBER, name: 'forked', phase: 'active' } } },
      { type: 'team/message/queued', seq: 1, time: 2, data: { message: { id: 'q1', senderName: 'lead', targetId: MEMBER, content: [] } } },
    ];
    const leadSession = { id: TEAM, seq: leadEvents.length, inheritedEventCount: 0, eventAt: (s) => leadEvents[s] };
    // 活体：官方 Session 的字段名就是 inheritedEventCount（ownEvents 靠它）
    const memberSession = { id: MEMBER, seq: log.length, inheritedEventCount: prefix.length, eventAt: (s) => log[s] };
    const ctx = {
      agents: {
        list: () => [{ id: TEAM, session: leadSession }, { id: MEMBER, session: memberSession }],
        get: (id) => (id === TEAM ? { id: TEAM, session: leadSession } : id === MEMBER ? { id: MEMBER, session: memberSession } : undefined),
      },
      get: () => undefined,
    };
    const agentTeams = {
      listMembers: () => [
        { id: TEAM, name: 'lead', role: 'lead', status: 'active' },
        { id: MEMBER, name: 'forked', role: 'teammate', status: 'active' },
      ],
      listTasks: () => [],
    };
    const result = await graph.collectGraph({ ctx, agentTeams, leadAgent: { id: TEAM, session: leadSession }, isTeamEnabled: () => true });
    assert.equal(result.ok, true, JSON.stringify(result));
    const node = result.graph.nodes.find((n) => n.name === 'forked');
    assert.ok(node !== undefined, 'fork 队员没被画出来');
    // 只该算自己的 100 input / 20 output / 300 cacheRead
    assert.equal(node.usage.uncachedInputTokens, 100, `把父会话的 input 算进来了：${node.usage.uncachedInputTokens}`);
    assert.equal(node.usage.outputTokens, 20);
    assert.equal(node.usage.cacheReadTokens, 300);
    assert.equal(node.todo.total, 0, '把父会话的 TODO 算成队员的了');
    // 承接边：只有 /own/only.txt，不该有父会话的 /parent/only.txt
    const handoffs = result.graph.edges.filter((e) => e.kind === 'handoff');
    assert.equal(handoffs.length, 0, `父会话前缀伪造出了承接边：${JSON.stringify(handoffs)}`);
    // 浮动窗口的对话也不能含父会话内容
    const convo = await graph.readConversationTail(MEMBER, memberSession, undefined, 50);
    assert.ok(!convo.rows.some((r) => /parent/.test(r.text)), '浮窗里出现了父会话的内容');
  });

  await check('buildGraph：Lead 派活条数 = spawn 次数 + 后续 team/message 条数（用户 #3）', () => {
    // 回归：实测（session-898e4c64）Lead 用 spawn_teammate 派了 3 个队员，
    // 而 team/message 只有 2 条补充消息。只数 team/message 时另外两个队员显示「Lead 派活 0 条」。
    const LEAD = 'lead-1';
    const A = 'a-1';
    const B = 'b-1';
    const leadEvents = [
      { type: 'tool/call', seq: 0, time: 1, data: { name: 'spawn_teammate', arguments: '{"name":"alpha","role":"builder"}' } },
      { type: 'tool/call', seq: 1, time: 2, data: { name: 'spawn_teammate', arguments: '{"name":"beta","role":"verify"}' } },
      { type: 'team/member', seq: 2, time: 3, data: { member: { id: A, name: 'alpha' } } },
      { type: 'team/member', seq: 3, time: 4, data: { member: { id: B, name: 'beta' } } },
      // 只给 alpha 发两条后续消息
      { type: 'team/message/queued', seq: 4, time: 5, data: { message: { id: 'q1', senderName: 'lead', targetId: A, content: [] } } },
      { type: 'team/message/queued', seq: 5, time: 6, data: { message: { id: 'q2', senderName: 'lead', targetId: A, content: [] } } },
    ];
    const leadStats = graph.foldSession(leadEvents);
    const g = graph.buildGraph({
      leadId: LEAD, leadName: 'lead',
      members: [{ id: A, name: 'alpha', role: 'teammate' }, { id: B, name: 'beta', role: 'teammate' }],
      statsBySession: new Map([[LEAD, leadStats]]),
      tasks: [],
    });
    const ea = g.edges.find((e) => e.kind === 'dispatch' && e.to === 'alpha');
    const eb = g.edges.find((e) => e.kind === 'dispatch' && e.to === 'beta');
    assert.equal(ea.weight, 3, `alpha 应为 1 spawn + 2 消息 = 3，实际 ${ea.weight}`);
    assert.equal(ea.spawned, 1);
    assert.equal(ea.messaged, 2);
    assert.equal(eb.weight, 1, `beta 应为 1 spawn + 0 消息 = 1（旧实现显示 0），实际 ${eb.weight}`);
    assert.equal(eb.spawned, 1);
    assert.equal(eb.messaged, 0);
  });

  await check('foldSession：TODO 只反映当前轮（新一轮开始清空上一轮）（用户 #6）', () => {
    // 回归：实测 builder-copyid 的 turn 1 在 seq=520 结束、turn 2 在 seq=523 开始，
    // 最后一次 todo/write 在 seq=514（4/0/4）。不清空的话第二轮仍显示 4/0/4。
    const twoTurns = graph.foldSession([
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
      { type: 'todo/write', seq: 1, time: 1100, data: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }] } },
      { type: 'turn/end', seq: 2, time: 2000, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 3, time: 3000, data: { turn: 2 } },
      // turn 2 没有 todo/write
    ]);
    assert.equal(twoTurns.todo.total, 0, `第二轮没写 TODO 就该是 0/0/0，实际 ${JSON.stringify(twoTurns.todo)}`);
    // 单轮会话不受影响：turn/start 在 todo/write 之前，写完立刻填回来
    const oneTurn = graph.foldSession([
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
      { type: 'todo/write', seq: 1, time: 1100, data: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }] } },
    ]);
    assert.equal(oneTurn.todo.done, 1);
    assert.equal(oneTurn.todo.running, 1);
    assert.equal(oneTurn.todo.total, 3);
  });

  await check('effectiveRuntimeMs：未闭合 turn 也要算运行时长（额度中断后不再显示「—」）（用户 #4）', () => {
    // 回归：runtimeMs 原本只在 turn/end 结算；额度耗尽/被杀的会话永远没有 turn/end，
    // 于是 runtime=0 → 卡片与浮窗都显示「—」，可它明明跑了几十分钟。
    const cut = graph.foldSession([
      { type: 'turn/start', seq: 0, time: 10000, data: { turn: 1 } },
      { type: 'assistant/message', seq: 1, time: 40000, data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 60, cacheReadTokens: 900, cacheWriteTokens: 0 } } },
      // 没有 turn/end（额度耗尽）
    ]);
    assert.equal(cut.runtimeMs, 0, '前提：闭合部分确实是 0');
    assert.equal(cut.openTurns.size, 1, '前提：确实有一个未闭合 turn');
    // 最后一条事件时间 40000 − turn 起点 10000 = 30000ms
    assert.equal(graph.effectiveRuntimeMs(cut), 30000, `有效运行时长应为 30000ms，实际 ${graph.effectiveRuntimeMs(cut)}`);
    // buildGraph 必须用有效值 → 节点有 runtime 与 tps
    const g = graph.buildGraph({
      leadId: 'L', leadName: 'lead', members: [],
      statsBySession: new Map([['L', cut]]), tasks: [],
    });
    assert.equal(g.nodes[0].runtimeMs, 30000);
    assert.ok(g.nodes[0].tps > 0, `tps 应 > 0，实际 ${g.nodes[0].tps}`);
    assert.equal(g.nodes[0].openTurns, 1, '未闭合 turn 数要如实暴露给客户端');
  });

  await check('buildGraph：承接边方向按主导信息流，不随名单顺序漂移（用户 #7）', () => {
    // 回归：旧实现把 pair 内**先遇到的**那条当 from（由名单顺序决定）→ 双向边里约一半流光反着播。
    const mk = (wrote, read) => {
      const s = graph.emptyStats();
      for (const f of wrote) s.wrote.add(f);
      for (const f of read) s.read.add(f);
      return s;
    };
    // zeta 写了 3 个文件被 alpha 读；alpha 只写 1 个被 zeta 读 → 主导方向 zeta → alpha
    const zeta = mk(['f1', 'f2', 'f3'], ['g1']);
    const alpha = mk(['g1'], ['f1', 'f2', 'f3']);
    const build = (order) => graph.buildGraph({
      leadId: 'L', leadName: 'lead',
      members: order === 1
        ? [{ id: 'a', name: 'alpha', role: 'teammate' }, { id: 'z', name: 'zeta', role: 'teammate' }]
        : [{ id: 'z', name: 'zeta', role: 'teammate' }, { id: 'a', name: 'alpha', role: 'teammate' }],
      statsBySession: new Map([['L', graph.emptyStats()], ['a', alpha], ['z', zeta]]),
      tasks: [],
    });
    const e1 = build(1).edges.find((e) => e.kind === 'handoff');
    const e2 = build(2).edges.find((e) => e.kind === 'handoff');
    assert.equal(e1.from, 'zeta', `主导方向应为 zeta → alpha，实际 ${e1.from} → ${e1.to}`);
    assert.equal(e2.from, 'zeta', `名单顺序变了方向不该变，实际 ${e2.from} → ${e2.to}`);
    assert.equal(e1.weight, 4, `两个方向合计 4 个文件，实际 ${e1.weight}`);
    assert.equal(e1.both, true, '双向边必须标记 both（客户端据此播反向流光）');
  });

  await check('leadForSession：团队结束后从日志 header.parentSession 恢复 Lead（用户 #5）', async () => {
    // 回归：额度耗尽 → 队员 agent 全部销毁 → 用户点队员会话打开工作区时
    // 报「找不到会话 … 对应的活动 agent」，整页打不开。
    //
    // ⚠️ 这条断言的关键是**替身必须复刻官方 jsonl 后端的形状**：
    // session 头是日志第 1 行，被 scanLog 当 meta 消费（dsh-session-persistence-jsonl:2801），
    // `read()` 只返回 events（同文件 :2825 / :62）→ **events 里没有 type==='session'**。
    // 第一版替身把 session 头留在 events 里，于是掩盖了「读 events 找不到 parentSession」的死代码。
    const runtimeMod = await load('runtime.js');
    const LEAD = 'session-recover-lead';
    const MEMBER = 'recover-member';
    const memberEvents = [
      { type: 'subagent/descriptor', seq: 0, time: 1, data: {} },
      { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 90, cacheWriteTokens: 0 } } },
    ];
    const leadEvents = [
      { type: 'team/member', seq: 0, time: 3, data: { member: { id: MEMBER, name: 'builder-r' } } },
      { type: 'turn/start', seq: 1, time: 4, data: { turn: 1 } },
      { type: 'turn/end', seq: 2, time: 5000, data: { turn: 1, reason: { kind: 'completed' } } },
    ];
    const persistence = {
      open: async (id) => {
        const key = String(id).replace(/^session-/, '');
        const isMember = key === MEMBER;
        const events = isMember ? memberEvents : leadEvents;
        return {
          // 官方形状：header 单独一份（第 1 行），events 不含 session 头。
          header: isMember ? { type: 'session', id: MEMBER, parentSession: LEAD } : { type: 'session', id: LEAD },
          inheritedEventCount: 0,
          read: async () => ({ events }),
          close: async () => {},
        };
      },
    };
    // 场景：**没有任何活体 agent**（额度耗尽后全部销毁）。
    const ctx = {
      agents: { list: () => [], get: () => undefined },
      get: (name) => (name === 'sessionPersistence' ? persistence : undefined),
    };
    const found = await runtimeMod.leadForSession(ctx, MEMBER);
    assert.equal(found.ok, true, `恢复失败：${JSON.stringify(found)}`);
    assert.equal(found.historyOnly, true, '要标记成历史快照');
    assert.equal(found.lead.id, LEAD, `Lead id 应为 ${LEAD}，实际 ${found.lead?.id}`);
    // 合成的 lead **不能**带假 session：带了会让 statsForSession 走活体增量路径 → 统计全 0。
    assert.equal(found.lead.session, undefined, '合成 lead 不许带 session（否则持久路径被短路，统计变 0）');
    // 沿 parentSession 恢复出的 lead 必须能画出成员（走 collectGraph 的持久路径）
    const g = await graph.collectGraph({
      ctx,
      agentTeams: { listMembers: () => { throw new Error('TEAM_NOT_MEMBER'); }, listTasks: () => [] },
      leadAgent: found.lead,
      isTeamEnabled: () => true,
    });
    assert.equal(g.ok, true, JSON.stringify(g));
    const names = g.graph.nodes.map((n) => n.name).sort().join(',');
    assert.equal(names, 'builder-r,lead', `应从 Lead 日志重建成员，实际 ${names}`);
    assert.ok(g.notes.some((n) => n.includes('重建')), '要如实说明这是历史快照');
  });

  await check('collectGraph：刚派出的队员不能因本地账本未登记而被跳过（用户报的实时更新问题）', async () => {
    // 用户原话（2026-10-08）：「我在只有两个队员的时候点进去工作区，他又派了一个队员，
    // 但是工作区没有同时及时更新……还是只能看到两个队员，重进才能看到三个」。
    //
    // 根因：本插件的启用账本（state.installed）挂在 agent 生命周期事件上，而域服务的成员名单
    // 会**更早**出现这个新队员。旧写法一律 `isTeamEnabled(agent) !== true → continue`，
    // 于是新队员被整条跳过；重进工作区时账本已补齐，所以又能看到。
    // 现在的判据：Lead 自己的日志里记着这个成员（team/member 事件）就认它。
    const LEAD = 'lag-lead';
    const OLD = 'lag-old';
    const NEW = 'lag-new';
    const leadEvents = [
      { type: 'team/member', seq: 0, time: 1, data: { member: { id: OLD, name: 'builder-old' } } },
      { type: 'team/member', seq: 1, time: 2, data: { member: { id: NEW, name: 'builder-new' } } },
      { type: 'turn/start', seq: 2, time: 3, data: { turn: 1 } },
      { type: 'turn/end', seq: 3, time: 9000, data: { turn: 1, reason: { kind: 'completed' } } },
    ];
    const leadSession = { id: LEAD, seq: leadEvents.length, inheritedEventCount: 0, eventAt: (s) => leadEvents[s] };
    const mkSession = (id) => ({ id, seq: 1, inheritedEventCount: 0, eventAt: () => ({ type: 'turn/start', time: 100, data: { turn: 1 } }) });
    const agents = {
      [LEAD]: { id: LEAD, session: leadSession },
      [OLD]: { id: OLD, session: mkSession(OLD) },
      [NEW]: { id: NEW, session: mkSession(NEW) },
    };
    const ctx = { agents: { list: () => Object.values(agents), get: (id) => agents[id] }, get: () => undefined };
    const agentTeams = {
      // 域服务**已经**把新队员列进来了（它比本地账本快）
      listMembers: () => [
        { id: LEAD, name: 'lead', role: 'lead', status: 'active' },
        { id: OLD, name: 'builder-old', role: 'teammate', status: 'active' },
        { id: NEW, name: 'builder-new', role: 'teammate', status: 'provisioning' },
      ],
      listTasks: () => [],
    };
    const r = await graph.collectGraph({
      ctx, agentTeams, leadAgent: agents[LEAD],
      // 只认老队员：模拟「账本还没跟上刚派出去的新队员」
      isTeamEnabled: (agent) => agent?.id === LEAD || agent?.id === OLD,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    const names = r.graph.nodes.map((n) => n.name).sort().join(',');
    assert.equal(names, 'builder-new,builder-old,lead', `新队员被跳过了（旧实现的实际表现）：${names}`);
    // 对照：**不在 Lead 日志里**的成员仍然要被跳过（不能为了修这个把幽灵节点放进来）
    const agentTeamsGhost = {
      listMembers: () => [
        { id: LEAD, name: 'lead', role: 'lead', status: 'active' },
        { id: OLD, name: 'builder-old', role: 'teammate', status: 'active' },
        { id: 'ghost-1', name: 'builder-ghost', role: 'teammate', status: 'active' },
      ],
      listTasks: () => [],
    };
    const agentsGhost = { ...agents, 'ghost-1': { id: 'ghost-1', session: mkSession('ghost-1') } };
    const ctxGhost = { agents: { list: () => Object.values(agentsGhost), get: (id) => agentsGhost[id] }, get: () => undefined };
    const g2 = await graph.collectGraph({
      ctx: ctxGhost, agentTeams: agentTeamsGhost, leadAgent: agentsGhost[LEAD],
      isTeamEnabled: (agent) => agent?.id === LEAD || agent?.id === OLD,
    });
    const names2 = g2.graph.nodes.map((n) => n.name).sort().join(',');
    assert.ok(!names2.includes('ghost'), `不属于本团队的幽灵成员必须被跳过，实际 ${names2}`);
  });

  await check('leadForSession：带 session- 前缀的队员 id 与 Lead 自己会话都能恢复（用户 #5 缺口②③）', async () => {
    // 两个真实缺口（2026-10-08 用真日志实测发现）：
    //   ② 持久层按目录名**精确匹配**，而队员目录是裸 uuid、Lead 目录带 session- 前缀
    //      （实测 `open('session-ca6e6ecd-…')` 抛、`open('ca6e6ecd-…')` 成功）
    //      → open 必须前缀双试，否则带前缀的队员 id 打不开。
    //   ③ **Lead 自己的会话没有 parentSession**，而官方成员面板在 Lead 会话里也显示入口
    //      → 「在 Lead 会话里点进入工作区」在团队结束后必须也能恢复（靠投影缓存判 members>1）。
    const runtimeMod = await load('runtime.js');
    const LEAD = 'session-recover-lead2';
    const MEMBER = 'recover-member2';
    const memberEvents = [{ type: 'assistant/message', seq: 0, time: 2, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 90, cacheWriteTokens: 0 } } }];
    const leadEvents = [
      { type: 'team/member', seq: 0, time: 3, data: { member: { id: MEMBER, name: 'builder-r2' } } },
      { type: 'turn/start', seq: 1, time: 4, data: { turn: 1 } },
      { type: 'turn/end', seq: 2, time: 5000, data: { turn: 1, reason: { kind: 'completed' } } },
    ];
    // 严格复刻官方形状：header 单独一份；**只认精确目录名**（所以前缀双试才有意义）。
    const persistence = {
      open: async (id) => {
        const isLead = id === LEAD;
        const isMember = id === MEMBER;
        if (!isLead && !isMember) throw new Error(`no log for ${id}`);
        return {
          header: isMember ? { type: 'session', id: MEMBER, parentSession: LEAD } : { type: 'session', id: LEAD },
          inheritedEventCount: 0,
          read: async () => ({ events: isMember ? memberEvents : leadEvents }),
          close: async () => {},
        };
      },
    };
    // 投影缓存：**只有 Lead 的会话**有 members（>1）。这是缺口③ 的唯一判据。
    const projectionCache = {
      cachedSnapshot: (header) => (header?.id === LEAD
        ? { values: { agentTeam: { members: [{ id: LEAD, role: 'lead', name: 'lead' }, { id: MEMBER, role: 'teammate', name: 'builder-r2' }], tasks: [{ id: 'task-1', status: 'pending' }] } }, asOfSeq: 9 }
        : undefined),
    };
    const ctx = {
      agents: { list: () => [], get: () => undefined },
      get: (name) => (name === 'sessionPersistence' ? persistence : name === 'sessionProjectionCache' ? projectionCache : undefined),
    };
    // ② 带前缀的队员 id
    const prefixed = await runtimeMod.leadForSession(ctx, `session-${MEMBER}`);
    assert.equal(prefixed.ok, true, `带前缀的队员 id 应能恢复：${JSON.stringify(prefixed)}`);
    assert.equal(prefixed.lead.id, LEAD);
    // ③ Lead 自己的会话
    const asLead = await runtimeMod.leadForSession(ctx, LEAD);
    assert.equal(asLead.ok, true, `Lead 自己的会话应能恢复：${JSON.stringify(asLead)}`);
    assert.equal(asLead.historyOnly, true);
    assert.equal(asLead.lead.id, LEAD);
    assert.equal(asLead.lead.session, undefined, '合成 lead 不许带 session');
    // 负对照：不存在的 id 必须失败（不能因为兜底把什么都当团队）
    const missing = await runtimeMod.leadForSession(ctx, 'nope-9999');
    assert.equal(missing.ok, false, '不存在的 id 必须失败');
    // 负对照：投影缓存里 members 只有 lead 一个 → 不算团队
    const loneCache = { cachedSnapshot: () => ({ values: { agentTeam: { members: [{ id: LEAD, role: 'lead' }] } } }) };
    const ctxLone = {
      agents: { list: () => [], get: () => undefined },
      get: (name) => (name === 'sessionPersistence' ? persistence : name === 'sessionProjectionCache' ? loneCache : undefined),
    };
    const lone = await runtimeMod.leadForSession(ctxLone, LEAD);
    assert.equal(lone.ok, false, 'members 只有 lead 一个时不该判成团队（实测 213 份缓存里只有 9 份 members 非空）');
  });

  console.log('');
  console.log('lib/tools.js（report_result 的形状校验）');

  // lib/tools.js 静态 import @deepseek-ai/dsh-tools，只有安装期的 node_modules junction 能解析到它。
  // 那份闭包坏掉时（2026-10-04 实测：全局 CLI 目录被清空 → junction 全部悬空），
  // 旧写法会把整个 selftest 崩掉：既丢汇总，又让「环境坏了」看起来像「代码回归了」。
  // 现在显式 SKIP 这两组并以 exit 2 报出环境问题。
  let tools;
  try {
    tools = await load('tools.js');
  } catch (error) {
    if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
      envSkipped += 2;
      console.log('  SKIP  lib/tools.js 无法加载：' + String(error.message ?? error).split('\n')[0]);
      console.log('        → 依赖闭包不可解析（junction 悬空？）。修法：npm i -g @deepseek-ai/dsh，再跑 node tools/repair.cjs --apply。');
    } else {
      throw error;
    }
  }

  if (tools !== undefined) await check('report_result：completed 必须带证据，未决项/长度上限被强制', () => {
    assert.throws(() => tools.validateReport({ status: 'completed', summary: '做完了' }), /evidence/u);
    assert.throws(() => tools.validateReport({ status: 'nope', summary: 'x' }), /status/u);
    assert.throws(() => tools.validateReport({ status: 'blocked', summary: '' }), /summary/u);
    assert.throws(() => tools.validateReport({ status: 'blocked', summary: 'x', evidence: 'not-array' }), /数组/u);
    assert.throws(() => tools.validateReport({ status: 'blocked', summary: 'x', evidence: [42] }), /字符串/u);
    const ok = tools.validateReport({
      status: 'completed',
      summary: '  改了 a.js  ',
      evidence: [' node -e "1+1" → 2 ', ''],
      acceptance: 'pytest -q → 12 passed',
      unresolved: [],
      changed_files: ['a.js'],
    });
    assert.equal(ok.summary, '改了 a.js');
    assert.deepEqual(ok.evidence, ['node -e "1+1" → 2'], '空字符串证据要被丢掉');
    assert.equal(ok.acceptance, 'pytest -q → 12 passed');
    // 没给 acceptance 时必须显式标注「按未验证处理」，而不是留空
    assert.match(tools.validateReport({ status: 'blocked', summary: 'x' }).acceptance, /未验证/u);
  });

  if (tools !== undefined) await check('formatReport：把状态/未决项渲染成 Lead 一眼能判的文本', () => {
    const text = tools.formatReport('builder', tools.validateReport({
      status: 'blocked',
      summary: '缺依赖',
      evidence: ['pip install x → 网络不可达'],
      unresolved: ['依赖装不上', '测试没跑'],
    }));
    assert.match(text, /^【report_result】builder · blocked/u);
    assert.match(text, /未决项（2，每一项都阻止验收）/u);
    assert.match(text, /- 测试没跑/u);
  });

  console.log('');
  console.log(`${passed}/${passed + failures.length} 通过。`);
  if (envSkipped > 0) console.log(`（另有 ${envSkipped} 组因环境不满足未执行）`);
  if (failures.length > 0) {
    console.log('');
    console.log('失败项：');
    for (const failure of failures) console.log(`  - ${failure.name}: ${failure.message}`);
    process.exit(1);
  }
  // 断言全过但环境缺件：这不是「全绿」，用 exit 2 明确区分（与 integration-test/drift-check 的约定一致）。
  if (envSkipped > 0) {
    console.log('');
    console.log('[selftest] 断言全部通过，但环境不满足：修复依赖闭包后重跑才能覆盖 lib/tools.js。');
    process.exit(2);
  }
  process.exit(0);
})().catch((error) => {
  console.error('[selftest] 自测本身崩了：', error);
  process.exit(1);
});

/**
 * 模型可见文本的 emoji 判定：Emoji_Presentation/杂项符号(2600-27BF,含 注意：问号箭头)/装饰符/变体选择符 U+FE0F。
 * 不含箭头区段 2190-21FF：`→`(U+2192) 是普通箭头、无 emoji 呈现，审查报告的判定是它不违反字面要求。
 * 只用于「会注入模型」的文本；代码注释里的 注意：/禁止：不在此列（它们不进系统提示词）。
 */
const MODEL_TEXT_EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2753}\u{2754}\u{27A1}]/gu;

/**
 * 枚举插件注入模型的全部文本：三段提示词 + 每个角色简报 + 唤醒文案 + 命令行。
 * @param playbook - lib/playbook.js 的模块命名空间。
 * @param roster - lib/roster.js 的模块命名空间。
 * @returns [标签, 文本] 数组。
 */
function visibleModelTexts(playbook, roster) {
  const out = [
    ['PLAYBOOK', playbook.PLAYBOOK],
    ['TEAM_POLICY', playbook.TEAM_POLICY],
    ['TEAMMATE_CARD', playbook.TEAMMATE_CARD],
    ['wakeInstruction', playbook.wakeInstruction('scout', '只做调研')],
    ['teamCommandLine', playbook.teamCommandLine('x')],
  ];
  for (const roleId of roster.ROLE_IDS) out.push(['teammateBrief(' + roleId + ')', playbook.teammateBrief(roleId, roleId)]);
  return out;
}

/** 检测严格变量插值的模板语法：任何 `{{` 都会在 prompt 渲染期被当成变量引用。 */
function hasTemplateBraces(text) {
  return typeof text !== 'string' || text.includes('{{');
}