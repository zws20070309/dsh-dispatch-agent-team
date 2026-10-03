#!/usr/bin/env node
/**
 * selftest.cjs —— 本插件的纯逻辑回归测试（无外部依赖，直接跑真代码）
 *
 * 覆盖 `lib/roster.js` 与 `lib/playbook.js` 的导出与不变量。这两份模块不 import 任何 dsh 包，
 * 所以可以在插件源码目录直接用 node 跑（不需要安装期的 node_modules junction）。
 * 涉及 dsh 运行时的部分（runtime/tools/index/preset/client）不能在这里测：
 * `lib/tools.js` 静态 import `@deepseek-ai/dsh-tools`，`lib/runtime.js` 又 import 它，
 * 所以那几个模块由 tools/drift-check.cjs 做静态对齐、并在安装后做真链路验证。
 *
 * 本文件重点守住的三条不变量（都是「一破就悄悄烧钱/悄悄失效」的那种）：
 *   1. 队员卡与角色无关 → 所有队员的系统提示词逐字节相同（提示词缓存前缀才可共用）；
 *   2. 队员工具名单 = 九个团队工具减去 Lead 专属，且 TEAMMATE_TOOL_DENY 不误伤团队工具名；
 *   3. PLAYBOOK 的角色表与 lib/roster.js 逐行一致（不是「包含 id 就算过」）。
 *
 *   node tools/selftest.cjs
 *
 * 退出码：0 = 全通过；1 = 有失败。
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
    // 队员工具 = 九个官方团队工具 − Lead 专属 + 我们自己的队员专用工具（report_result 等）。
    // 2026-09-30：report_result 是**队员专用**（Lead 不注册），所以它不在 TEAM_TOOL_NAMES 里。
    const memberOnly = roster.MEMBER_TEAM_TOOL_NAMES.filter((name) => !teamTools.has(name));
    assert.deepEqual(memberOnly, [roster.REPORT_TOOL_NAME], `队员专用工具名单变了：${memberOnly.join(', ')}`);
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

  await check('deriveRole：<role> 与 <role>-N 都能推导，非法名返回 undefined', () => {
    assert.equal(roster.deriveRole('scout'), 'scout');
    assert.equal(roster.deriveRole('verify-2'), 'verify');
    assert.equal(roster.deriveRole('visual-critic-17'), 'visual-critic');
    assert.equal(roster.deriveRole(' lead '), undefined);
    assert.equal(roster.deriveRole('lead'), undefined);
    assert.equal(roster.deriveRole('unknown-role'), undefined);
    assert.equal(roster.deriveRole('scout-'), undefined);
    assert.equal(roster.deriveRole(''), undefined);
    assert.equal(roster.deriveRole(42), undefined);
  });

  await check('isValidTeammateName：拒绝 lead / 未知角色 / -0 / -1 / 超长', () => {
    assert.equal(roster.isValidTeammateName('scout'), true);
    assert.equal(roster.isValidTeammateName('scout-2'), true);
    assert.equal(roster.isValidTeammateName('scout-99'), true);
    assert.equal(roster.isValidTeammateName('lead'), false);
    assert.equal(roster.isValidTeammateName('scout-0'), false);
    assert.equal(roster.isValidTeammateName('scout-1'), false);
    assert.equal(roster.isValidTeammateName('nope'), false);
    assert.equal(roster.isValidTeammateName('a'.repeat(65)), false);
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
    assert.equal(PLAYBOOK_HAS_TEMPLATE_BRACES(playbook.PLAYBOOK), false, 'PLAYBOOK 里出现了 {{…}} 变量语法');
    assert.equal(PLAYBOOK_HAS_TEMPLATE_BRACES(playbook.TEAM_POLICY), false, 'TEAM_POLICY 里出现了 {{…}} 变量语法');
    assert.equal(PLAYBOOK_HAS_TEMPLATE_BRACES(playbook.TEAMMATE_CARD), false, 'TEAMMATE_CARD 里出现了 {{…}} 变量语法');
    for (const roleId of roster.ROLE_IDS) {
      assert.equal(PLAYBOOK_HAS_TEMPLATE_BRACES(playbook.teammateBrief(roleId, roleId)), false, `角色简报 ${roleId} 里出现了 {{…}} 变量语法`);
    }
    assert.equal(PLAYBOOK_HAS_TEMPLATE_BRACES(playbook.teamCommandLine('x')), false);
    assert.equal(PLAYBOOK_HAS_TEMPLATE_BRACES(playbook.wakeInstruction('scout', '只做调研')), false);
  });

  await check('PLAYBOOK 含分轮面试式提问的关键要素（设计树/前沿/分轮/格式/等答复/事实归 Lead）', () => {
    const text = playbook.PLAYBOOK;
    for (const marker of ['设计树', '前沿', '❓', '➡️', '找事实是你的工作', '不要替用户拍板', '用户明确说', '共享理解']) {
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

  // ── 提示词卫生（2026-09-30 用户要求：干净、有条理、简洁而作用大）────────────────
  await check('提示词预算：系统提示词前缀不许膨胀（每多一个字，每次请求都多付一次钱）', () => {
    const budget = {
      PLAYBOOK: 4100,        // 调度模式方法论（Lead 与所有请求的前缀）
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
    assert.ok(woke.includes('输出上限'), '续写指令要说明为什么被叫醒');
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
    const start = source.indexOf('export function controlToolDefinitions');
    assert.ok(start >= 0, '找不到 controlToolDefinitions');
    const body = source.slice(start);
    for (const needle of ['pushInstruction(', '.followup(', '.send(']) {
      assert.ok(!body.includes(needle), `controlToolDefinitions 里又出现了 ${needle}（会把消息排进用户输入框）`);
    }
    assert.ok(body.includes('diagnostics.push('), '状态说明应当走工具返回值 diagnostics');
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
  console.log('lib/tools.js（report_result 的形状校验）');

  const tools = await load('tools.js');

  await check('report_result：completed 必须带证据，未决项/长度上限被强制', () => {
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

  await check('formatReport：把状态/未决项渲染成 Lead 一眼能判的文本', () => {
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
  if (failures.length > 0) {
    console.log('');
    console.log('失败项：');
    for (const failure of failures) console.log(`  - ${failure.name}: ${failure.message}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((error) => {
  console.error('[selftest] 自测本身崩了：', error);
  process.exit(1);
});

/** 检测严格变量插值的模板语法：任何 `{{` 都会在 prompt 渲染期被当成变量引用。 */
function PLAYBOOK_HAS_TEMPLATE_BRACES(text) {
  return typeof text !== 'string' || text.includes('{{');
}