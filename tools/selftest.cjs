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
const { readFileSync, existsSync, readdirSync } = require('node:fs');
const os = require('node:os');
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
    const outcome = await fn();
    // 返回**非空字符串**也算失败（与 tools/drift-check.cjs 的报告器同一契约）。
    // 旧写法只看「有没有抛错」，于是用 return 原因字符串 表达的断言**永远绿** —— 2026-10-15
    // 新加的两条预设闸门就是这么空转了一轮，靠变异测试（把被检代码改坏、看闸门咬不咬）才抓出来。
    if (typeof outcome === 'string' && outcome !== '') throw new Error(outcome);
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

  await check('角色预设配置：sanitizeConfig 允许「只配预设不配模型」，resolveRolePreset 只认白名单', () => {
    const logs = [];
    const log = (message) => logs.push(message);
    const onlyPreset = roster.sanitizeConfig({ version: 1, roles: { scout: { preset: 'standard' } } }, log);
    if (onlyPreset.roles.scout === undefined) return '只配预设的角色被整条丢掉了（旧实现 provider/model 不配对就 continue）：' + JSON.stringify(onlyPreset.roles);
    if (onlyPreset.roles.scout.preset !== 'standard') return 'preset 没被留下：' + JSON.stringify(onlyPreset.roles.scout);
    if (roster.resolveRolePreset(onlyPreset, 'scout') !== 'standard') return 'resolveRolePreset 读不回 standard';
    // 白名单外：丢字段 + 记一条诊断，绝不静默接受（也不抛错）。
    const bogus = roster.sanitizeConfig({ version: 1, roles: { scout: { preset: 'cordis' } } }, log);
    if (bogus.roles.scout !== undefined) return '白名单外的预设竟然留下了：' + JSON.stringify(bogus.roles.scout);
    if (!logs.some((line) => /cordis/.test(line))) return '丢掉白名单外的预设时没留下任何诊断：' + logs.join(' | ');
    // 空串 = 跟随 Lead：不落键（这样「取消某角色的预设」与「从没配过」在磁盘上是同一个形状）。
    const cleared = roster.sanitizeConfig({ version: 1, roles: { scout: { preset: '' } } }, log);
    if (cleared.roles.scout !== undefined) return '空串预设应该等于跟随 Lead（不落键）：' + JSON.stringify(cleared.roles.scout);
    if (roster.resolveRolePreset(cleared, 'scout') !== undefined) return 'resolveRolePreset 对未配置的角色必须回 undefined';
    // 未净化的对象也不能被信任（防调用方把 raw 传进来）。
    if (roster.resolveRolePreset({ roles: { scout: { preset: 'evil' } } }, 'scout') !== undefined) return 'resolveRolePreset 没再挡一次白名单';
    // 三个 id 是用户点名要的那三个，顺序即下拉顺序；改动会同时影响配置页与运行时。
    if (JSON.stringify(roster.TEAMMATE_PRESET_IDS) !== JSON.stringify(['ptc', 'standard', 'minimal-grayscale'])) {
      return 'TEAMMATE_PRESET_IDS 与用户定案的名单不一致：' + roster.TEAMMATE_PRESET_IDS.join(', ');
    }
    return true;
  });

  await check('草稿行只有一个构造口 makeRow，四个维度（模型/强度/预设/批量）都在里面', () => {
    const cli = readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8')
    // 2026-10-15 加预设列时踩过「十几处各自写字面量、漏一处就静默丢配置」；同日加第四维（batch）
    // 时把构造口收成一个 makeRow。所以这条闸门从「禁两字段形状」升级成**禁任何绕过 makeRow 的
    // 行字面量** —— 判据用真实文本，不用正则（上一版写正则，转义在多层 here-string 里被吃掉，
    // 闸门空转了一整轮才由变异测试抓出来）。
    if (!cli.includes('function makeRow(key, effort, preset, batch)')) return 'makeRow 构造口没了（回到十几处字面量 = 老坑复发）';
    if (!cli.includes('batch: batch !== false,')) return 'makeRow 不再把 batch 归一成布尔（默认开 = 只有显式 false 才关）';
    const forbidden = [
      '{ key: row.key, effort: row.effort }',
      "{ key: '', effort: '' } : draft[role.id]",
      '{ key: row.key, effort: row.effort, preset:',
      '{ key: row.key, effort, preset:',
      '{ key, effort, preset }',
      "{ key: '', effort: '', preset }",
      "{ key: '', effort: '', preset: keep }",
      'out[roleId] = { key: row.key',
      'next[roleId] = { key',
      'draft[roleId] = { key',
    ];
    const hits = forbidden.filter((needle) => cli.includes(needle));
    if (hits.length > 0) return '这些草稿行绕过了 makeRow：' + hits.join(' ; ');
    if (cli.includes("if (key === '') delete next[roleId]")) return 'changeModel 清模型时连带删掉整行';
    for (const needle of ['changePreset', 'changeAllPresets', 'renderPreset', 'normalizePresets',
      'changeBatch', 'changeAllBatch', 'entry.batch = false', 'rowIsEmpty(nextRow)']) {
      if (!cli.includes(needle)) return '客户端少了 ' + needle + '（批量调用那一维被删了？）';
    }
    // 第四维必须进指纹：否则「只拨开关」永远不算未保存改动，用户以为保存过了。
    if (!cli.includes("row.batch === false ? '0' : '1'")) return 'draftSignature 没带上 batch 维度';
    return true;
  });

  await check('统一选择那一排的 CSS：顶对齐 + 恒定提示槽 + 勾选格与下拉格等高', () => {
    const cli = readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8')
    // 版面 bug 的另一半在 CSS 里，结构闸门看不见（把 align-items 改回 flex-end，67 条冒烟全绿），
    // 所以这里钉住三条**决定对齐**的声明。改布局的人要同时改这里，改不动就说明对齐被破坏了。
    if (cli.includes('.dat-bulk-ctl{display:flex;gap:8px 14px;flex-wrap:wrap;align-items:flex-start}')) {
      // 现状
    } else if (cli.includes('align-items:flex-end')) {
      return '.dat-bulk-ctl 又回到底对齐了：带提示语的那一格会把整排顶歪（2026-10-15 用户第二次报版面）';
    } else {
      return '.dat-bulk-ctl 的声明形状变了，本条判据要按新 CSS 重写';
    }
    if (!cli.includes('.dat-hintslot{display:block;min-height:16px')) return '提示槽的恒定行高没了（没话时那一格会矮一截）';
    if (!cli.includes('.dat-checkline{display:flex;align-items:center;gap:7px;height:24px')) return '勾选格不再与下拉格等高（24px 那条）';
    return true;
  });
  await check('批量调用档（roster 层）：默认开，只有显式 false 才关，非布尔不猜意图', () => {
    const logs = [];
    const log = (line) => logs.push(line);
    assert.equal(roster.roleBatchOn(roster.defaultConfig(), 'scout'), true, '空配置默认应为开');
    assert.equal(roster.roleBatchOn(void 0, 'scout'), true, '连配置都没有时也应为开');
    assert.equal(roster.roleBatchOn({ roles: { scout: { batch: false } } }, 'scout'), false, '显式 false 应为关');
    assert.equal(roster.roleBatchOn({ roles: { scout: { batch: true } } }, 'scout'), true, '显式 true 应为开');
    assert.equal(roster.roleBatchOn({ roles: { builder: { batch: false } } }, 'scout'), true, '别的角色关掉不该牵连 scout');
    const only = roster.sanitizeConfig({ roles: { scout: { batch: false } } }, log);
    assert.deepEqual(only.roles.scout, { batch: false }, '只配 batch:false 的行被整条丢掉了（等于关不掉）');
    const on = roster.sanitizeConfig({ roles: { scout: { batch: true, preset: 'ptc' } } }, log);
    assert.deepEqual(on.roles.scout, { preset: 'ptc' }, 'batch:true 与不写等价，不该落键：' + JSON.stringify(on.roles.scout));
    logs.length = 0;
    const junk = roster.sanitizeConfig({ roles: { scout: { batch: 'no' } } }, log);
    assert.equal(junk.roles.scout, void 0, '非布尔 batch 不该落盘：' + JSON.stringify(junk.roles));
    assert.equal(logs.length, 1, '非布尔 batch 必须留下一条诊断：' + JSON.stringify(logs));
    const pair = roster.sanitizeConfig({ roles: { scout: { provider: 'p', model: 'm', batch: false } } }, log);
    assert.deepEqual(pair.roles.scout, { provider: 'p', model: 'm', batch: false }, '模型与 batch 互相挤掉了：' + JSON.stringify(pair.roles.scout));
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
    // 钉给队员的 persona 是**模型可见文本**，而且它会送进官方那个严格插值的槽位：
    // 一句带 {{…}} 的文本会让每次装配都尝试解一个不存在的变量。
    assert.equal(hasTemplateBraces(roster.MEMBER_PERSONA_PIN), false, 'MEMBER_PERSONA_PIN 里出现了 {{…}} 变量语法');
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

  await check('PLAYBOOK 含分轮面试式提问的关键要素（设计树/前沿/卡片提问/事实归 Lead）——用户 2026-10-13', () => {
    const text = playbook.PLAYBOOK;
    for (const marker of ['设计树', '前沿', '找事实是你的工作', '不要替用户拍板', '用户明确说', '共享理解']) {
      assert.ok(text.includes(marker), `PLAYBOOK 缺少标记：${marker}`);
    }
    assert.ok(/Q1/u.test(text) && /Q2/u.test(text), 'PLAYBOOK 缺少 Q1/Q2 的编号约定');
    // ⚠️ 这条断言是 2026-10-13 换掉的：旧文本要求「编号（Q1、Q2…）并给出推荐答案，然后
    // **停下来等**」+ 正文排版「**Q1 — <标题>**：<正文>」/「推荐：<推荐答案>」——
    // 那套排版**就是 bug 本身**：Lead 照做就把问题写成了正文，回合随即结束，
    // 用户必须再发一条才能继续（实测 session-038a25ac：seq 19 正文提问 → seq 21 turn/end
    // → seq 26 用户不得不自己打字「不是中断会话向我提问，是聊天界面跳弹窗跟我提问啊」
    // → seq 27 才改用 ask_user_question 卡片）。
    // 现在钉的是新契约：必须用卡片问，且不许只写在正文里。
    assert.ok(text.includes('ask_user_question'),
      'PLAYBOOK 没让 Lead 用 ask_user_question 弹卡片提问 —— 它会退回正文提问，回合结束 = 会话断');
    assert.ok(/问题不许只写在正文里/.test(text),
      'PLAYBOOK 缺少「问题不许只写在正文里」这条硬约束（正文提问就是断会话的那条路）');
    assert.ok(/会话断/.test(text),
      'PLAYBOOK 必须把「为什么」留在文本里（正文提问 = 会话断）：没有理由模型不会遵守');
    assert.ok(!/停下来等/.test(text),
      'PLAYBOOK 又出现了「停下来等」——旧措辞会诱导模型把问题写成正文后结束回合');
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

  await check('派活简报不再中英同框：模型只读一份（英文角色名 = id 的重述，零新增信息）', () => {
    // 用户 2026-10-15 明确选了「去掉英文侧」，理由是他自己提出的：双语会让模型
    // 「读一遍中文，读一遍英文」。本轮实跑量了账（不是估的）：
    //   * 12 个角色的 labelEn 里 **11 个就是 role.id 的 Title-Case 改写**
    //     （scout→Scout、plan-critic→Plan Critic、red-team→Red Team…），
    //     唯一不同的 verify→Verifier 也只是同词形变化；
    //   * 而 id 在同一行里**已经用反引号给了**，所以英文侧对模型是纯粹的重述 ——
    //     删掉不丢任何信息；
    //   * 承载区分度的是中文 label：五个审查类角色（前沿/计划/逻辑/对抗/美术审查）
    //     的英文侧全是 … Auditor / Critic / Verifier，中文侧才是各自的分工说明；
    //   * 字节：每个队员省 8~19 字符（平均 12），12 个角色合计 143 字符；
    //     这条前缀每个队员每一轮都要重付（缓存未命中时）。
    // labelEn **不删**：配置页（lib/client.js:2700）与 ROLES 契约（INTERFACES §1）
    // 仍在用它给人看英文名。这里断的是「不许进模型读的那半」。
    const leadText = playbook.PLAYBOOK + playbook.TEAM_POLICY + playbook.TEAMMATE_CARD;
    for (const role of roster.ROLES) {
      const brief = playbook.teammateBrief(role.id, role.id);
      assert.ok(brief.includes(role.label), role.id + ' 的简报丢了中文 label（那才是给人和模型看的分工名）');
      assert.ok(!brief.includes(role.labelEn),
        role.id + ' 的简报里又出现英文角色名 ' + role.labelEn + '（模型每轮多读一份重述）');
      // 首行形状：角色 id 必须还在（模型要靠它对齐工具面与角色表）。
      assert.ok(brief.includes('角色 ' + String.fromCharCode(96) + role.id + String.fromCharCode(96)),
        role.id + ' 的简报首行不再带角色 id（删英文侧时把 id 一起删了）');
    }
    // 三个常量是 Lead 与队员每轮都读的前缀，同样不许夹英文角色名。
    for (const role of roster.ROLES) {
      assert.ok(!leadText.includes(role.labelEn),
        '常量里夹了英文角色名 ' + role.labelEn + '（PLAYBOOK / TEAM_POLICY / TEAMMATE_CARD 是每轮前缀）');
    }
    // 兜住这条改动的真正风险：**角色区分**。删错一侧（删中文留英文）会当场失去区分度，
    // 而 12 个英文侧几乎同形（五个都是 …Auditor/Critic），比中文更难分。
    const briefs = roster.ROLES.map((role) => playbook.teammateBrief(role.id, role.id));
    assert.equal(new Set(briefs).size, roster.ROLES.length, '删英文侧后有两个角色的简报变得完全相同');
    assert.equal(new Set(roster.ROLES.map((role) => role.label)).size, roster.ROLES.length,
      '中文 label 出现重名（那才是简报里的角色区分来源）');
    // 配置页那半边必须照旧拿得到英文名（删的是提示词，不是字段）。
    const cli = readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
    assert.ok(/role\.labelEn === '' \? null : React\.createElement/.test(cli),
      '配置页的角色英文名渲染点变了：labelEn 若真没人用就该整条删掉，而不是留个死字段');
    assert.ok(roster.ROLES.every((role) => typeof role.labelEn === 'string' && role.labelEn !== ''),
      'ROLES 里有角色的 labelEn 空了（配置页会显示空白）');
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

  await check('队员 model 校正：官方给的是继承模型，必须换成请求真正用的那份（session-3c654f6e 的 P1）', () => {
    // 现场（2026-10-16 session-3c654f6e，逐条从会话日志核出）：两名队员的 list_agents 行都写
    // model=qfmodel（= Lead 自己的模型），而它们的 request/header.header.config 与 request/context
    // 全是 workbuddy/step-5-preview（角色配置里的模型）。根因是官方 listMembers 取
    // live?.options.model ?? root.options.model（dsh-experimental-agent-team/lib/index.js:698、:449），
    // options.model 是继承来的那份；本包的角色覆盖发生在 agent/request 拦截器（installRouteOverride），
    // 不回写 options.model —— 所以 Lead 问到的是**错的数据**，不是显示滞后。
    const rows = [
      { id: 'lead-id', name: 'lead', role: 'lead', status: 'running', model: 'qfmodel', diagnostics: [] },
      { id: 'a-id', name: 'builder', role: 'teammate', status: 'inactive', model: 'qfmodel', diagnostics: [] },
      { id: 'b-id', name: 'scout', role: 'teammate', status: 'inactive', model: 'qfmodel', diagnostics: [] },
    ];
    const fixed = roster.annotateMemberModels(rows, new Map([['a-id', { provider: 'workbuddy', model: 'step-5-preview' }]]));
    assert.equal(fixed[1].model, 'step-5-preview', '记到路由的队员要显示真模型');
    assert.equal(fixed[0], rows[0], 'Lead 行不许动（它没有覆盖，官方那份就是它的真值）');
    assert.equal(fixed[2], rows[2], '没记账的队员不许猜：保持官方原值，也别产生新对象');
    assert.equal(rows[1].model, 'qfmodel', '入参必须不被修改');
    assert.equal(roster.annotateMemberModels(fixed, new Map([['a-id', { model: 'step-5-preview' }]]))[1], fixed[1], '已经对了就不重建对象（幂等）');
    // 空账本 = 零副作用。
    assert.equal(roster.annotateMemberModels(rows, new Map())[1], rows[1]);
    assert.equal(roster.annotateMemberModels(rows, {})[1], rows[1]);
    assert.equal(roster.annotateMemberModels(rows, null)[2], rows[2]);
    assert.equal(roster.annotateMemberModels(null, new Map([['a-id', { model: 'm' }]])).length, 0, 'rows 不是数组时退化成空表，不抛');
    // 记到了但 model 是脏值：一律不动那一行（宁可退回官方那份）。
    assert.equal(roster.annotateMemberModels(rows, new Map([['a-id', {}]]))[1], rows[1], '没有 model 就不校正');
    assert.equal(roster.annotateMemberModels(rows, new Map([['a-id', { model: '' }]]))[1], rows[1], '空串 model 不校正');
    assert.equal(roster.annotateMemberModels(rows, new Map([['a-id', { model: 42 }]]))[1], rows[1], '非字符串 model 不校正');
    // 只改 model 这一个已有字段：不许新增字段（新增 = 改 Lead 工具目录 = 动缓存前缀）。
    const only = roster.annotateMemberModels(rows, new Map([['a-id', { provider: 'p', model: 'm', reasoningEffort: 'high' }]]))[1];
    assert.deepEqual(Object.keys(only).sort(), ['diagnostics', 'id', 'model', 'name', 'role', 'status'], '校正只写 model 一个已有字段');
  });

  await check('「推荐」表：恰好覆盖全部角色、预设 id 在白名单里、batch 是布尔（按钮的取值真值）', async () => {
    // 为什么钉这条：配置页那个「推荐」按钮的取值来自 lib/roster.js，页面只照抄。
    // 漏一个角色 = 那个角色**静默不被填**（按钮看起来生效了，实际少改一行）；
    // 预设 id 写错 = 派队员时拿到官方的 agent-preset/not-found，退回跟随 Lead。
    // 两者都不会在页面上报错，所以必须在这里钉住。
    const roster = await load('roster.js');
    const rec = roster.ROLE_RECOMMENDATIONS;
    const ids = roster.ROLE_IDS;
    assert.deepEqual(Object.keys(rec).slice().sort(), ids.slice().sort(),
      '推荐表与角色表不是同一批角色（漏 = 静默不填，多 = 死条目）');
    for (const roleId of ids) {
      const item = rec[roleId];
      assert.equal(typeof item, 'object', roleId + ' 没有推荐条目');
      assert.ok(roster.TEAMMATE_PRESET_IDS.includes(item.preset),
        roleId + ' 的推荐预设 ' + item.preset + ' 不在可指派白名单里（派出来会 not-found 退回跟随 Lead）');
      assert.equal(typeof item.batch, 'boolean', roleId + ' 的推荐 batch 不是布尔');
      // 推荐值必须能被 recommendedRoleConfig 原样取回（它是页面/路由唯一的取值口）
      assert.deepEqual(roster.recommendedRoleConfig(roleId), { preset: item.preset, batch: item.batch },
        roleId + ' 经 recommendedRoleConfig 取回的值与表里不一致');
    }
    assert.equal(roster.recommendedRoleConfig('no-such-role'), undefined, '不存在的角色必须回 undefined');
    assert.equal(roster.recommendedRoleConfig('__proto__'), undefined, '原型键不许被当成有推荐（hasOwnProperty 守卫）');
    assert.ok(roster.RECOMMENDATION_RULE.includes('纯 PTC') && roster.RECOMMENDATION_RULE.includes('模型'),
      '规则文本要同时说清「填什么」与「不填什么」，否则用户不知道按钮动了哪几格');
    // 分组本身也是判据：只读/汇报型 = 关批量，写域型 = 开批量（这条划分是这张表的全部理由）。
    const pure = ids.filter((roleId) => rec[roleId].batch === false);
    const both = ids.filter((roleId) => rec[roleId].batch === true);
    assert.deepEqual(pure.slice().sort(), ['frontier-auditor', 'plan-critic', 'red-team', 'researcher', 'scout', 'verify', 'visual-critic'],
      '纯 PTC 那一档的角色集合变了：' + JSON.stringify(pure));
    assert.deepEqual(both.slice().sort(), ['builder', 'integrator', 'refiner', 'scribe', 'tester'],
      '保留批量调用那一档的角色集合变了：' + JSON.stringify(both));
  });

  await check('persona 钉住的取值形状：槽位名/排序值钉死，句子单行、无变量、无模型名、不按角色分叉', async () => {
    // 为什么钉这一条：这三样是「装配出来的第一屏对所有队员逐字节相同」的全部条件。
    // 槽位名写错 = 注册出一个新段，persona 照旧翻面（还会多出一段废话）；order 写错 =
    // 这句跑到别的位置上去，遮蔽关系不变但前缀形状变了；带模型名 = 换模型即翻面（正是
    // 这次要修的第二条断裂源）；按角色分叉 = 把 §0.1 第 3 条「全队一份前缀」直接切碎。
    const roster = await load('roster.js');
    assert.equal(roster.MEMBER_PERSONA_SECTION, 'deployment:persona-prefix',
      'persona 槽位名与官方 PERSONA_PREFIX_SECTION 不再一致（dsh-persona/lib/index.js:2、dsh-system-prompt/lib/index.js:55）');
    assert.equal(roster.MEMBER_PERSONA_ORDER, 0,
      'persona 的排序值不再是官方 DEPLOYMENT_PERSONA_PREFIX 那一个（由 drift-check 对着 asar 钉）');
    const pin = roster.MEMBER_PERSONA_PIN;
    assert.equal(typeof pin, 'string', 'persona 不是字符串');
    assert.equal(pin.includes('\n'), false, '钉住的 persona 必须是单行（多行会把后面的段顶开）');
    assert.equal(pin.trim(), pin, 'persona 首尾不许留空白（装配时按段拼接，空白会落进前缀）');
    assert.equal(/[{}]/.test(pin), false, 'persona 里不许出现花括号（官方插值是严格变量制）');
    const lowered = pin.toLowerCase();
    for (const word of ['model', 'qwen', 'deepseek', 'gpt', 'claude', 'gemini']) {
      assert.equal(lowered.includes(word), false, 'persona 里出现了模型字样「' + word + '」：换模型就会翻面，这条正是要修的');
    }
    for (const roleId of roster.ROLE_IDS) {
      assert.equal(lowered.includes(roleId), false, 'persona 里出现了角色名 ' + roleId + '：按角色分叉会把队员的共享前缀切碎');
    }
  });

  await check('钉 persona 必须排在换继承面的 await 之前（晚一句就赶不上这名队员的第一次装配）', () => {
    // 官方没有「装配前」钩子：systemPrompt.assemble（dsh-agent-loop/lib/index.js:907）前面没有
    // await 点，而 installMember 不 await 重绑。所以唯一能保证「第一次请求就用上钉好的
    // persona」的做法，是把注册写在 select/mount 这两个 await **之前**。
    // 这一条是纯静态门：把注释剥掉再看代码顺序，注释里出现「await」不算。
    const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const src = strip(readFileSync(path.join(PLUGIN_DIR, 'lib', 'runtime.js'), 'utf8'));
    const start = src.indexOf('async function rebindMemberPreset');
    assert.ok(start >= 0, '读不到 rebindMemberPreset：换预设的机制变了，这条门要重读');
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end < 0 ? src.length : end);
    const swaps = [...body.matchAll(/await\s+agentPresets\.(select|mount)\(/g)].map((m) => m.index);
    assert.equal(swaps.length, 2, '换继承面的两处 await 数量变了（实得 ' + swaps.length + '）：本门的判据要重读');
    const pins = [...body.matchAll(/pinMemberPersona\(/g)].map((m) => m.index);
    assert.ok(pins.length >= 2, '两处换预设前都要钉一句，实得 ' + pins.length + ' 处');
    for (const pinAt of pins) {
      const nextSwap = swaps.find((at) => at > pinAt);
      assert.notEqual(nextSwap, undefined, '有一句 pinMemberPersona 落在两处换继承面之后（等于永远赶不上第一次装配）');
      const between = body.slice(pinAt, nextSwap);
      assert.equal(/await\s+agentPresets\./.test(between.replace(/pinMemberPersona\([^)]*\)/, '')), false,
        '钉住与它对应的那次换预设之间还夹了一个 await：那一步已经把装配让出去了');
    }
  });

  await check('官方锁判据的镜像必须逐字对齐，且只有真会换继承面才钉（锁住的队员不许多钉一句）', () => {
    const src = readFileSync(path.join(PLUGIN_DIR, 'lib', 'runtime.js'), 'utf8');
    assert.ok(/boundary\.openTurnStartSeq !== null \|\| boundary\.lastTurn > 0/.test(src),
      'memberSessionStarted 与官方 select() 的锁判据不再同形（dsh-agent-preset-registry/lib/index.js:755-759）—— 预判会把该钉的队员漏掉或不该钉的钉了');
    assert.ok(/if \(!memberSessionStarted\(projections, session\)\) pinMemberPersona\(agent, notes, disposers\);/.test(src),
      '线 1（select 支）的钉住没有走「会话已开播就不钉」预判：官方必然拒绝的队员被凭空多换了一次第一屏');
    assert.ok(/\n\s+pinMemberPersona\(agent, notes, disposers\);/.test(src),
      '线 2（mount 恢复支）没有无条件钉：恢复的老队员每次冷重启都要整段前缀重算');
  });

  await check('钉住的注册必须可回卷、绝不外抛，而且只管队员（Lead 的 persona 一个字节都不许动）', () => {
    const src = readFileSync(path.join(PLUGIN_DIR, 'lib', 'runtime.js'), 'utf8');
    const start = src.indexOf('function pinMemberPersona');
    assert.ok(start >= 0, '读不到 pinMemberPersona');
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end);
    assert.ok(body.includes('keepDisposer('), '注册没走 keepDisposer：卸载时回卷不掉，队员死了那段作用域还留着一句 persona');
    assert.equal(/\bthrow\b/.test(body), false, 'pinMemberPersona 里出现了 throw：钉不住就该记诊断，不许把这名队员打掉');
    assert.equal(/catch \(error\)/.test(body), true, '没有 try/catch：同名段撞车会把这名队员打掉');
    assert.equal(body.includes('MEMBER_PERSONA_PIN'), true, '钉的文本必须来自 roster 那一份真值');
    // Lead 侧：installRoot 这条路径一次都不许调用它。
    const rootStart = src.indexOf('function installRoot');
    const rootEnd = src.indexOf('\n}', rootStart);
    assert.ok(rootStart >= 0 && rootEnd > rootStart, '读不到 installRoot，这条反向门没意义');
    assert.equal(/pinMemberPersona\(/.test(src.slice(rootStart, rootEnd)), false,
      'Lead 的安装路径里出现了 pinMemberPersona：用户主会话的 persona 被本包改了');
    // 调用点必须在 rebindMemberPreset 内（只有它知道「要不要换继承面」）。
    const rebindStart = src.indexOf('async function rebindMemberPreset');
    const rebindEnd = src.indexOf('\n}', rebindStart);
    const inRebind = src.slice(rebindStart, rebindEnd);
    // 只数**调用**（后面跟分号）；函数定义那一行 'pinMemberPersona(agent, notes, disposers) {'
    // 长得一样，第一版把它也数进来了 —— 那是闸门自己咬错，不是代码有问题。
    const outCalls = [...src.matchAll(/pinMemberPersona\(agent, notes, disposers\);/g)]
      .filter((m) => !(m.index > rebindStart && m.index < rebindEnd));
    assert.equal(outCalls.length, 0, '有 ' + outCalls.length + ' 处钉 persona 落在 rebindMemberPreset 之外（判据失控）');
    assert.ok(inRebind.includes('pinMemberPersona(agent, notes, disposers)'), 'rebindMemberPreset 里反倒没有钉住调用（上一条门的意义就没了）');
  });

  await check('全仓 systemPrompt.section 注册的 text 只能是常量标识符或字面量（禁止实时状态进段）', () => {
    // 为什么：段文本每轮都重算 = 每轮翻面 = 前缀缓存归零。这是 §0.1 第 3 条「全队一份前缀」
    // 的机读版本；把它做成反向门，而不是写在注释里。
    const files = ['runtime.js', 'ops-adapter.js', 'preset.js', 'playbook.js', 'roster.js'];
    const offenders = [];
    for (const file of files) {
      const src = readFileSync(path.join(LIB, file), 'utf8');
      for (const m of src.matchAll(/section\(\{[^}]*?text:\s*([^,}\n]+)/g)) {
        const value = m[1].trim();
        const ok = /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(value) || /^''/.test(value) || /^'[^']*'$/.test(value);
        if (!ok) offenders.push(file + ' -> ' + value.slice(0, 60));
      }
    }
    assert.deepEqual(offenders, [], '这些段的 text 不是标识符/字面量（实时状态进 system = 每轮翻面）：' + offenders.join(' | '));
  });

  await check('cache-prefix-audit 的实测口径必须真的能算：喂真形状事件，命中率算得对（行为门）', () => {
    // 为什么是行为门而不是扫源码：第一版我写的是文本门（"源码里有没有出现 cacheReadTokens"），
    // 然后把被保护的那句 `const u = usageOf(event)` 改成 `const u = undefined` —— 文本门照样绿。
    // 那条变异把「读了但没用」这种假绿暴露了出来，所以这里改成**直接调用导出的纯函数**。
    // 背景：脚本第一版只有「前缀是否逐字节相同」的推算模型，我据此在会话里对用户说过「会话日志里
    // 没有 usage 字段，拿不到实测命中率，只能做理论分析」—— 那是**假话**：assistant/message.data.usage
    // 一直带 cacheReadTokens（本机 143 个队员会话 8603 条 assistant/message 全部带 usage、8041 条带
    // cacheReadTokens），本包 lib/graph.js:265 与 lib/cache.js:240 也一直在读它。
    const audit = require(path.join(PLUGIN_DIR, 'tools', 'cache-prefix-audit.cjs'));
    assert.equal(typeof audit.usageOf, 'function', '脚本不再导出 usageOf：实测口径又变成不可断言的了');
    assert.equal(typeof audit.summarizeSession, 'function', '脚本不再导出 summarizeSession');
    // ① usageOf：字段读对，缺字段按 0，没有 usage 时 undefined。
    assert.deepEqual(audit.usageOf({ data: { usage: { cacheReadTokens: 900, inputTokens: 100 } } }), { hit: 900, miss: 100 });
    assert.deepEqual(audit.usageOf({ data: { usage: { inputTokens: 50 } } }), { hit: 0, miss: 50 }, '没有 cacheReadTokens 时要按 0，不是 NaN');
    assert.equal(audit.usageOf({ data: {} }), undefined, '没有 usage 必须回 undefined（不能编一个 0 命中）');
    assert.equal(audit.usageOf({}), undefined);
    // ② hitRateOf：与 lib/cache.js:262-264 同式，分母 0 时 null。
    assert.equal(audit.hitRateOf({ hit: 900, miss: 100 }), 90);
    assert.equal(audit.hitRateOf({ hit: 0, miss: 0 }), null, '分母为 0 时必须回 null（渲染成「—」），不许编 0%');
    // ③ 端到端：一个两请求的会话 —— 第 1 次 system 变了、第 2 次没变，两档要分得开。
    const events = [
      { type: 'system/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'AAA' }] } } },
      { type: 'user/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'hi' }] } } },
      { type: 'request/header', seq: 3, data: { reason: 'initial', header: { config: { model: 'm' }, tools: [{ name: 'a' }] } } },
      { type: 'assistant/message', seq: 4, data: { usage: { cacheReadTokens: 100, inputTokens: 900 } } },
      { type: 'system/message', seq: 5, data: { message: { content: [{ type: 'text', text: 'BBB' }] } } },
      { type: 'request/header', seq: 6, data: { reason: 'change', header: { config: { model: 'm' }, tools: [{ name: 'a' }] } } },
      { type: 'assistant/message', seq: 7, data: { usage: { cacheReadTokens: 0, inputTokens: 1000 } } },
      { type: 'assistant/message', seq: 8, data: { usage: { cacheReadTokens: 800, inputTokens: 200 } } },
    ];
    const s = audit.summarizeSession(events);
    assert.equal(s.requests.length, 3, '三次带 usage 的 assistant/message 要折成三条请求，实得 ' + s.requests.length);
    assert.equal(s.headers.length, 2, '两次 request/header 要折成两条装配，实得 ' + s.headers.length);
    assert.equal(s.requests[0].afterSystemChange, true, '第一条请求前面有 system 快照，要标成「前缀变了」');
    assert.equal(s.requests[1].afterSystemChange, true, '第二条请求前面 system 变过，要标成「前缀变了」');
    assert.equal(s.requests[2].afterSystemChange, false, '第三条请求前 system 没变，要标成「前缀没变」');
    assert.equal(s.requests[0].hit, 100);
    assert.equal(s.requests[0].miss, 900);
    assert.equal(s.requests[1].hit, 0, '翻面那一次必须如实记 0 命中（这是本门要保的事实）');
    assert.equal(s.requests[2].hit, 800);
    // ④ 公式与 lib/cache.js 同式（那边是 cacheReadTokens / (cacheReadTokens + uncachedInputTokens)）。
    const cacheSrc = readFileSync(path.join(LIB, 'cache.js'), 'utf8');
    assert.ok(/stats\.cacheReadTokens \+ stats\.uncachedInputTokens/.test(cacheSrc),
      'lib/cache.js 的命中率公式变了：本脚本的公式要跟着重读（两者必须同式）');
    // ⑤ 两个口径在输出里必须分开命名（读的人会把推算模型当现状 —— 这正是我犯的错）。
    const src = readFileSync(path.join(PLUGIN_DIR, 'tools', 'cache-prefix-audit.cjs'), 'utf8');
    assert.ok(src.includes('实测命中率'), '脚本输出里没有「实测命中率」这个口径名：读的人会把推算模型当现状');
    assert.ok(src.includes('装配对') && src.includes('不是命中率'),
      '脚本没有把「装配对模型」与「命中率」分开标注');
    // ⑥ 而且 `usageOf` 真的被扫描路径用上了（不是导出给人看、内部却不用）。
    // 判据必须带**解构前缀**：第一版写成 /summarizeSession\(events\)/，结果匹配到的是
    // `function summarizeSession(events) {` 这个**定义头** —— 把调用整行删掉它照样绿（M33-e 咬出来的）。
    // 判据写成「const { … } = summarizeSession(events);」：解构里多一个字段（比如 usageMissing）
    // 不该把门判红（2026-10-17 我自己加字段时就红了一次），但**必须**是解构赋值而不是定义头。
    assert.ok(/const \{[^}]*\} = summarizeSession\(events\);/.test(src),
      '扫描路径没有调用 summarizeSession 折表：实测口径又空了');
  });

  await check('文档必须写明**实测**命中率，不许退回「日志没有 usage / 只能理论分析」那套陈述', () => {
    // 这是上一条的文档侧：代码报得对、文档还写着旧结论，等于没改。
    // 判据取正向（必须出现实测口径与那个数），不用反向禁词 —— 因为**更正的文字里会引用旧错话**，
    // 反向禁词会把更正本身判红（第一版就这么咬过自己）。
    const interfaces = readFileSync(path.join(PLUGIN_DIR, 'INTERFACES.md'), 'utf8');
    assert.ok(interfaces.includes('实测命中率'),
      'INTERFACES.md 里没有「实测命中率」：缓存这一节又只剩推算模型了');
    // 数字必须与 `node tools/cache-prefix-audit.cjs` 的默认输出一致（全部 143 个会话那一档）。
    // 判据只钉「94.9%」这个可复现的总数 + 两个分档名；不钉最近 40 个会话那一档（它会随日志增长漂）。
    assert.ok(interfaces.includes('94.9%'),
      'INTERFACES.md 没写实测总数 94.9%（`node tools/cache-prefix-audit.cjs --tail 0` 的输出）；'
      + '把推算模型当现状汇报正是上一轮那个错，数字必须能一眼对上');
    assert.ok(interfaces.includes('前缀变了的那一次'),
      'INTERFACES.md 没写「前缀变了的那一次」这一档：读者会以为实测命中率是均匀的');
    assert.ok(/cacheReadTokens/.test(interfaces),
      'INTERFACES.md 没写实测命中率的来源字段 cacheReadTokens：读者无法复核');
    const readme = readFileSync(path.join(PLUGIN_DIR, 'README.md'), 'utf8');
    assert.ok(readme.includes('cache-prefix-audit.cjs'),
      'README 的探针清单里没有 cache-prefix-audit.cjs：用户不知道有这个核对命令');
  });

  await check('cache-prefix-audit 的「没看到钉住」提示必须分清两种原因（没重启 / 重启了但没派队员）', () => {
    // 起因（2026-10-17 真机踩到）：用户重启 DSH 后我跑这个脚本，它照样打印
    // 「跑这些队员的还是旧代码，要重启才生效」—— 那是**错的**：进程启动于 08:02:03，
    // 晚于代码最后一次改动，只是重启后还没有队员跑过。这条提示会把人引去白重启一次。
    // 所以判据改用**进程启动时刻**（状态文件的 generatedAt），三个分支各自有断言。
    const audit = require(path.join(PLUGIN_DIR, 'tools', 'cache-prefix-audit.cjs'));
    assert.equal(typeof audit.pinHintBranch, 'function', '脚本不再导出 pinHintBranch：这条提示又变成不可断言的了');
    const b = audit.pinHintBranch;
    assert.equal(b({ codeMs: 100, bootMs: 200, newestMemberMs: 50 }), 'not-dispatched',
      '代码旧、进程新、没有新队员 → 应判「重启了但还没派队员」');
    assert.equal(b({ codeMs: 300, bootMs: 200, newestMemberMs: 50 }), 'not-restarted',
      '代码比进程新 → 应判「还没重启」');
    assert.equal(b({ codeMs: 100, bootMs: 200, newestMemberMs: 250 }), 'stale-members',
      '有比进程还新的队员会话却没钉住 → 那才是真的没生效，不能报成「没派队员」');
    assert.equal(b({ codeMs: null, bootMs: 200, newestMemberMs: 50 }), 'unknown',
      '读不到代码时刻时必须回 unknown（不猜）');
    assert.equal(b({ codeMs: 100, bootMs: null, newestMemberMs: 50 }), 'unknown',
      '读不到进程启动时刻时必须回 unknown（不猜）');
    // 文案侧：三支都必须存在，否则两个原因又会被合并成一句。
    const src2 = readFileSync(path.join(PLUGIN_DIR, 'tools', 'cache-prefix-audit.cjs'), 'utf8');
    assert.ok(src2.includes('重启之后还没有任何队员跑过'), '缺「重启了但还没派队员」那一支的文案');
    assert.ok(src2.includes('还没重启'), '缺「代码比进程新 = 还没重启」那一支的文案');
    assert.ok(src2.includes('generatedAt'), '启动时刻不是读状态文件的 generatedAt');
  });

  await check('路由账本写入点：脏值不进账本、空对象不进、读口返回副本（宁缺毋滥）', async () => {
    // 为什么单独测写入点：annotateMemberModels 自己也会拦脏 model（纵深防御的第二道），
    // 于是「noteAppliedRoute 不校验 model 空串」这种变异会被下游吸收、集成测试照样绿 ——
    // 这条闸门让**上游那道校验**有独立的可咬性（变异 M26）。
    const rt = await load('runtime.js');
    const id = 'gate-agent-' + Math.random().toString(36).slice(2);
    rt.noteAppliedRoute(id, { model: '' });
    rt.noteAppliedRoute(id, { provider: '   ' });
    rt.noteAppliedRoute(id, {});
    rt.noteAppliedRoute(id, null);
    rt.noteAppliedRoute('', { model: 'm' });
    if (rt.appliedMemberRoutes().has(id)) return '脏值被写进了账本：' + JSON.stringify(rt.appliedMemberRoutes().get(id));
    rt.noteAppliedRoute(id, { provider: 'workbuddy', model: 'step-5-preview', reasoningEffort: 'high' });
    const got = rt.appliedMemberRoutes().get(id);
    if (got === undefined) return '合法路由没进账本';
    if (got.model !== 'step-5-preview' || got.provider !== 'workbuddy') return JSON.stringify(got);
    // 读口必须是副本：Lead 侧改它不该动内部账本。
    const snap = rt.appliedMemberRoutes();
    snap.delete(id);
    if (!rt.appliedMemberRoutes().has(id)) return 'appliedMemberRoutes 返回的是内部 Map 本身（可被调用方改坏）';
    rt.clearAppliedRoute(id);
    if (rt.appliedMemberRoutes().has(id)) return 'clearAppliedRoute 没作废';
  });

  await check('任务板闭环提示：只算未闭环、只标 Lead 行、不改入参、幂等（session-dfd6c62d 的闸门）', () => {
    // 现场（2026-10-14 session-dfd6c62d，逐条从会话日志核出）：Lead 建了 4 条任务后全程没回看，
    // 7 个队员都交了 completed 报告，任务板停在 pending。用户来问「是不是显示 bug」——
    // 不是：面板如实投影账本。缺的是把这件事摆到 Lead 眼前，这一条就是那个提示的真值来源。
    const rows = [
      { id: 'lead-id', name: 'lead', role: 'lead', status: 'running', diagnostics: [] },
      { id: 'a-id', name: 'builder', role: 'teammate', status: 'inactive', diagnostics: ['boom'] },
    ];
    const tasks = [
      { id: 'task-1', revision: 1, status: 'pending' },
      { id: 'task-2', revision: 2, status: 'in_progress', ownerName: 'builder' },
      { id: 'task-3', revision: 3, status: 'completed', ownerName: 'builder' },
      { id: 'task-4', revision: 1, status: 'deleted' },
    ];
    const note = roster.boardClosureNote(tasks);
    assert.equal(typeof note, 'string', '有未闭环条目时必须给提示');
    assert.ok(note.startsWith(roster.BOARD_CLOSURE_PREFIX), '提示要带固定前缀，Lead 才认得出');
    assert.ok(note.includes('未闭环 2 条'), 'completed 与 deleted 都不算未闭环：' + note);
    assert.ok(note.includes('无 owner 1 条'), '要分清「从没被 claim」与「claim 了没交」：' + note);
    assert.ok(note.includes('task-1') && note.includes('task-2'), '要点名条目：' + note);
    assert.ok(!note.includes('task-3') && !note.includes('task-4'), '已闭环的不许进名单：' + note);
    assert.ok(note.includes('team_task_update'), '必须直接给出下一步动作：' + note);
    assert.equal(roster.boardClosureNote([tasks[2], tasks[3]]), undefined, '全闭环时不许产生提示（长期噪音会被模型忽略）');
    assert.equal(roster.boardClosureNote([]), undefined, '空任务板不许抛错');
    assert.equal(roster.boardClosureNote(undefined), undefined, 'listTasks 拿不到时按无提示处理');
    assert.equal(roster.boardClosureNote('不是数组'), undefined, '非数组入参不许抛错');
    const many = [];
    for (let i = 0; i < 9; i += 1) many.push({ id: 't' + String(i), revision: 1, status: 'pending' });
    const manyNote = String(roster.boardClosureNote(many, 3));
    assert.ok(manyNote.includes('未闭环 9 条') && manyNote.includes('t0'), '上限版仍要给总数与首批条目：' + manyNote);
    assert.ok(manyNote.includes('…（共 9 条）'), '超出上限要标注省略：' + manyNote);
    assert.equal(manyNote.includes('t3'), false, '超过 idLimit 的条目不许列出');
    const marked = roster.annotateBoardClosure(rows, note);
    assert.equal(marked[0].diagnostics.length, 1, '提示只挂 Lead 行');
    assert.equal(marked[1], rows[1], '队员行不许被塞与它无关的账（收尾是 Lead 的责任）');
    assert.deepEqual(rows[0].diagnostics, [], '入参必须不被修改（成员行同时是 Lead 的请求内容）');
    assert.equal(roster.annotateBoardClosure(marked, note)[0].diagnostics.length, 1, '幂等：重复标注不加第二份');
    assert.equal(roster.annotateBoardClosure(rows, undefined).length, 2, '无提示时原样返回');
    assert.equal(roster.annotateBoardClosure(rows, '').length, 2, '空提示原样返回');
    assert.equal(roster.annotateBoardClosure(null, note).length, 0, '非数组行集合按空处理，不抛错');
    const bare = roster.annotateBoardClosure([{ id: 'l', name: 'lead', role: 'lead', status: 'running' }], note);
    assert.equal(bare[0].diagnostics.length, 1, '行里没有 diagnostics 键时也要挂得上（官方 lead 伪行不保证带它）');
  });


  await check('提示词预算：系统提示词前缀不许膨胀（每多一个字，每次请求都多付一次钱）', () => {
    const budget = {
      // 2026-10-09 上调 3800→3900 / 1150→1200：这两处增长都有明确来源，不是「往上堆」——
      //   ① 新增用户要求的 PTC 借鉴纪律（批量取证 + 先过滤再汇报，见下面的专项断言）；
      //   ② 修回 2026-10-09 压缩事故中误删的细节（URL、「不知道就说不知道」、
      //      「（它对你不可用）」的原因、blocked 的判据、冻结文件的举例与「让 Lead 判断」）。
      // 教训记在这里：那次为守住 3800/1150 而删掉的是**信息**，不是冗余；压缩该合并同义表述，
      // 不该删事实。上调幅度只覆盖真实新增 + 一点余量，不开口子。
      // 2026-10-13 上调 3900→4000（PLAYBOOK 实测 3988）：唯一来源是第一章那条**新信息** ——
      //   提问必须用 `ask_user_question` 弹**卡片**，不许把问题写成正文再结束回合。
      //   旧文本更短（它写的是排版样式「Q1 — <标题>」，而那正是导致会话断的错指令），
      //   所以这次不是往上堆，是把一条错指令换成一条对指令 + 它必须留在文本里的理由：
      //   模型只有知道「正文提问 = 回合结束 = 用户得再发一条」才会遵守卡片。
      // 2026-10-14 上调（PLAYBOOK 3988→4214、TEAM_POLICY 758→841、CARD 1199→1365，
      // 合计 4746→5055 / 1574→1740）：唯一来源是**任务板闭环**这一条新纪律（用户 2026-10-14 要求）。
      // 依据是 session-dfd6c62d 的日志：Lead 建了 4 条任务（seq 81/84/87/90）到会话结束（seq 1697）
      // 一条都没再动过，而 7 个队员全部交了 completed 报告 —— 提示词提过 team_task_create 的名字，
      // 却从没要求「用它收尾」，所以这条增长是**新信息**，不是往上堆。
      // 2026-10-17 上调（CARD 1365→1395，队员侧合计 1732→1762）：唯一来源是**第二轮真机验收
      // 抓到的误读** —— builder-2 把队员卡那句「没有向最终用户提问的工具」读成「手上没有任何提问手段」，
      // 于是上报「卡片与实测不符」（实际上同一句里就写了用 ask_lead）。改法不是加长，是把话说准：
      // 点名 `ask_user_question` 不可用（调它报 DELEGATED_CALLER），并写明 `ask_lead` 是发给 Lead 的。
      // 这条同时被 selftest 的细节闸门钉住（「它对你不可用」「或在报告里写清楚」），删一个字都会红。
      // 2026-10-17 第三轮再加一次（CARD 1395→1399，队员侧 1762→1766）：来源是**测试 3 的量测**——
      // 队员用相对路径写文件时落在**会话 cwd**（那次是 D:\Desktop\临时，不是仓库根），而原句
      // 「共享同一个工作目录」会让队员以为相对路径 = 仓库根。改成「与 Lead 共享 cwd（未必是仓库根）：
      // 新建文件用绝对路径」，并把「有版本守卫」压成「有守卫」、「重读该文件、重基后再写」压成
      // 「重读、重基后再写」腾出字节（信息一条没删）。依据：session-d7eb7e28 第三轮 builder-3 实写
      // `.probe-tmp/round3-rel.md` → 落点 D:\Desktop\临时\.probe-tmp\round3-rel.md（verify-3 独立 stat 确认），
      // 仓库内候选路径全程不存在。
      // 同时已按「先删再加」合并过一处同义表述（队员卡「别灌整段 dump」与「不贴整段日志、整个文件
      // 或长篇代码」同义，删前者留后者），并逐句收紧了新文案。
      PLAYBOOK: 4250,        // 调度模式方法论（Lead 与所有请求的前缀）
      TEAM_POLICY: 880,      // 团队运行期事实（开后才有）
      TEAMMATE_CARD: 1400,   // 队员卡（每个队员的固定前缀）；留 ~35 余量，避免再次为「贴边」删信息
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
    assert.ok(lead <= 5150, `Lead 侧提示词 ${lead} > 5150 字符`);
    assert.ok(mate <= 1800, `队员侧提示词 ${mate} > 1800 字符`);
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

  await check('任务板闭环纪律在提示词里（光提工具名字不够：2026-10-14 现场就是这么漏的）', () => {
    // 与「每个已注册团队工具都在提示词里被提到」同一条思路，但那条只管**提到名字**：
    // 现场里 PLAYBOOK 确实提了 team_task_create，却没有任何一句要求收尾 —— 于是 Lead 建完 4 条
    // 任务就再没回看（seq 81→1697 之间零条 team/task 记录）。这一条管**要求去做**。
    const card = playbook.TEAMMATE_CARD;
    for (const marker of ['team_task_get', 'team_task_update', 'claim', 'complete', 'release', '别碰任务板']) {
      assert.ok(card.includes(marker), '队员卡缺少任务板纪律：' + marker);
    }
    // 队员调 reassign 必被官方拒（TEAM_LEAD_REQUIRED，task-board.js:158-159）：教了就是骗它。
    assert.ok(!card.includes('reassign'), '队员卡不许出现 reassign（Lead 专属，队员调它一定失败）');
    assert.ok(playbook.PLAYBOOK.includes('收敛任务板'), 'PLAYBOOK 缺少「最终答复前收敛任务板」这条纪律');
    assert.ok(playbook.PLAYBOOK.includes('task_id'), 'PLAYBOOK 没提 spawn_teammate 的 task_id：不绑定就会再出现「建了没人动」');
    assert.ok(playbook.TEAM_POLICY.includes('只接受 in_progress'), 'TEAM_POLICY 缺 complete 的前置语义（不知道就会白调一次然后困惑）');
    assert.ok(playbook.TEAM_POLICY.includes('调用者自己'), 'TEAM_POLICY 缺 claim 的归属语义（替别人接条目要用 reassign）');
  });

  await check('闭环联动的源码接线：四个落点都在（防止日后被重构成静默）', () => {
    const source = readFileSync(path.join(PLUGIN_DIR, 'lib', 'tools.js'), 'utf8');
    assert.ok(source.includes('reportBoardFollowUps(safeTasks(agentTeams, caller), name, report.status)'),
      'report_result 不再对账任务板（completed 不 complete / blocked 不 release 都没人提醒了）');
    assert.ok(source.includes("action: 'reassign'"), 'spawn_teammate 不再绑定 task_id');
    assert.ok(source.includes('callerIsLead(agentTeams, caller) ? boardClosureNote(safeTasks(agentTeams, caller)) : undefined'),
      'list_agents / wait_agent 的闭环提示接线不见了');
    assert.ok(source.includes('annotateBoardClosure(rows, note)'), 'list_agents 不再把提示挂到 Lead 行');
    const waitSchema = /const WAIT_VALUE_SCHEMA = \{[\s\S]*?\n\};/.exec(source);
    assert.ok(waitSchema !== null, '找不到 WAIT_VALUE_SCHEMA');
    assert.ok(waitSchema[0].includes("diagnostics: { type: 'array', items: { type: 'string' } }"),
      'wait_agent 的 diagnostics 没进 schema —— 官方按 output.schema 校验返回值，漏声明就是模型侧一次 ToolOutputError');
    // 诊断/提示路径必须容错：任务板读不到不许把交付路径带崩。
    assert.ok(source.includes('function safeTasks(agentTeams, caller) {'), 'safeTasks 的容错包装不见了');
    const safeTasksBlock = source.slice(source.indexOf('function safeTasks'), source.indexOf('/** 调用者是不是这个团队的 Lead'));
    assert.ok(safeTasksBlock.includes('catch'), 'safeTasks 必须吞掉 listTasks 的异常（任务板读不到不该把交付路径带崩）');
    assert.ok(safeTasksBlock.includes("return Array.isArray(rows) ? rows : []"), 'listTasks 返回非数组时也要退化成空表');
  });

  await check('队员/Lead 提示词的**关键细节**不许再被压缩删掉（2026-10-09 压缩事故的永久闸门）', () => {
    // 事故经过：为把 TEAMMATE_CARD 压回 1150，我删掉了一批**信息**（不是冗余），
    // 事后逐字 diff 才发现。这些点各自都有真实用途，逐条钉住：
    //   * URL —— researcher 引外部来源、web 类结论的唯一凭据形式；
    //   * 「不知道就说不知道」—— 诚实纪律，去掉后模型倾向于硬编一个答案；
    //   * 「或在报告里写清楚」—— ask_lead 之外的**备选上报路径**（不可用时不至于卡死）；
    //   * 「（它对你不可用）」—— 解释原因，否则队员会以为是自己没找到那个工具；
    //   * blocked 的判据「需要 Lead 决策或外部条件」—— 没判据就会滥用/误用该状态；
    //   * 冻结文件的举例「（测试、验收脚本）」+「让 Lead 判断」—— 决定谁来裁决；
    //   * PLAYBOOK 的「（工具面强制）」「不许当事实」「真实调用链验证」。
    const card = playbook.TEAMMATE_CARD;
    for (const marker of ['URL', '不知道就说不知道', '或在报告里写清楚', '它对你不可用',
      '需要 Lead 决策或外部条件', '测试、验收脚本', '让 Lead 判断', '标 blocking=false']) {
      assert.ok(card.includes(marker), `队员卡丢了这个细节：「${marker}」——它是信息，不是冗余`);
    }
    const pb = playbook.PLAYBOOK;
    for (const marker of ['（工具面强制）', '不许当事实', '真实调用链验证',
      '冻结的验收文件（只读）', '工具会把该角色的使命/纪律/写权限自动拼在你正文之前',
      // 「（推荐）」= 卡片里推荐项的标注约定（2026-10-13 取代旧的正文排版「推荐：<推荐答案>」，
      // 那套正文排版正是断会话的错指令；信息本身没丢，只是搬进了卡片字段）。
      '（推荐）', '答案以**工具结果**回来']) {
      assert.ok(pb.includes(marker), `PLAYBOOK 丢了这个细节：「${marker}」——它是信息，不是冗余`);
    }
  });

  await check('PTC 借鉴纪律：批量取证 / 先过滤后汇报，Lead 与队员两侧都在（防以后被当噪音删掉）', () => {
    // 用户 2026-10-09 要求把 PTC（Programmatic Tool Calling）的方法论借鉴进团队。
    // 官方 PTC 预设与 standard 的唯一实质差异是 `tool-presentation: {mode: ptc}`
    // （dsh-web-app/presets/ptc.patch.yml）—— 它改的是「模型怎么调工具」，不是工具集。
    // 本插件不能按队员切 preset（子会话强制继承 Lead 的 preset），所以只借鉴**方法**：
    // ① 一次调用取一批（合并命令 / 交替模式 grep / 循环），别拆成 N 次往返；
    // ② 原始输出先自己筛算合并，只把结论与关键行带进上下文。
    // 两侧都必须有：队员卡管队员自己的取证方式，PLAYBOOK 管 Lead 对派活的要求
    // （只写一边会出现「Lead 不问、队员不做」的缺口）。
    assert.ok(playbook.TEAMMATE_CARD.includes('一次调用取一批'), '队员卡缺少「一次调用取一批」纪律');
    assert.ok(playbook.TEAMMATE_CARD.includes('原始输出自己筛算合并'), '队员卡缺少「先过滤再进上下文」纪律');
    assert.ok(playbook.TEAMMATE_CARD.includes('别拆成 N 次往返'), '队员卡缺少「别拆成 N 次往返」的明确反例');
    assert.ok(playbook.PLAYBOOK.includes('批量取证'), 'PLAYBOOK 缺少对队员的「批量取证」要求');
    assert.ok(playbook.PLAYBOOK.includes('先过滤再汇报'), 'PLAYBOOK 缺少对队员的「先过滤再汇报」要求');
    // 反面对照：纪律不许散落到 TEAM_POLICY（那里只放运行期语义，写重复 = 多付钱 + 自相矛盾）。
    assert.ok(!playbook.TEAM_POLICY.includes('一次调用取一批'), 'TEAM_POLICY 不该出现取证纪律');
    assert.ok(!playbook.TEAM_POLICY.includes('批量取证'), 'TEAM_POLICY 不该出现取证纪律');
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

  await check('turn/end 的错误正文与错误码不再被丢掉（P1-4，就是这次报障的本体）', () => {
    // 2026-10-12 用户报「队员罢工没人察觉」之后，插件把 turn/end 的 reason.kind 上墙成了
    // 一个「上一轮报错」，但**错误正文与错误码整个丢掉**（lib/graph.js:280 原先只存 reason?.kind）。
    // 真机数据（.probe/real-events.json，seq 349/362/371/382/527 五条）：
    //   reason:{kind:'error',error:{message:'opencode: 所有通道对该模型均受限…',code:'QUOTA_EXCEEDED'}}
    // 那是用户唯一需要的信息（额度受限 → 换模型/换通道），却被压成三个字「上一轮报错」。
    // 官方给的是整块 TurnErrorItem（.probe-tmp/messageitem.js.txt:94-118：标题 +
    // failureMessage(message, code) + <code>{node.code}</code>）。我们不复制那一整套样式，
    // 但**message 与 code 一个都不能少**。
    const stats = graph.foldSession([
      { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
      { type: 'turn/end', seq: 2, time: 2000, data: { turn: 1,
        reason: { kind: 'error', error: { message: '所有通道对该模型均受限', code: 'QUOTA_EXCEEDED' } } } },
    ]);
    assert.equal(stats.lastTurnEndReason, 'error', 'kind 仍要在（画布的红点判据用它）');
    assert.equal(stats.lastTurnErrorMessage, '所有通道对该模型均受限', '错误正文必须留得下来');
    assert.equal(stats.lastTurnErrorCode, 'QUOTA_EXCEEDED', '错误码必须留得下来');
    // 正常收尾不留脏值：上一轮的错误不能在这一轮还挂着（否则红点与「罢工」文案会赖着不走）
    const clean = graph.foldSession([
      { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
      { type: 'turn/end', seq: 2, time: 2000, data: { turn: 1,
        reason: { kind: 'error', error: { message: 'boom', code: 'X' } } } },
      { type: 'turn/start', seq: 3, time: 3000, data: { turn: 2 } },
      { type: 'turn/end', seq: 4, time: 4000, data: { turn: 2, reason: { kind: 'completed' } } },
    ]);
    assert.equal(clean.lastTurnEndReason, 'completed');
    assert.equal(clean.lastTurnErrorMessage, undefined, '本轮正常收尾却不该还挂着上一轮的错误正文');
    assert.equal(clean.lastTurnErrorCode, undefined);
    // max-tokens（罢工续跑那条）同样带上正文
    const mt = graph.foldSession([
      { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
      { type: 'turn/end', seq: 2, time: 2000, data: { turn: 1, reason: { kind: 'max-tokens' } } },
    ]);
    assert.equal(mt.lastTurnEndReason, 'max-tokens');
    assert.equal(mt.lastTurnErrorMessage, undefined, '没有 error 时不许编正文');
    // 对话流里也要出现这一行：官方画 TurnErrorItem，我们此前对话区**一条都没有**
    const rows = graph.extractConversation([
      { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
      { type: 'assistant/message', seq: 2, time: 1500, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '我先看结构' }] } } },
      { type: 'turn/end', seq: 3, time: 2000, data: { turn: 1,
        reason: { kind: 'error', error: { message: '所有通道对该模型均受限', code: 'QUOTA_EXCEEDED' } } } },
    ], 20);
    const notice = rows.find((r) => r.kind === 'turnend');
    assert.ok(notice, '回合结局要成行（否则用户只看到一个绿点/红点，不知道为什么）：' + JSON.stringify(rows.map((r) => r.kind)));
    // 契约（2026-10-14 定）：后端只发**事实字段**，句子由客户端按当前语言拼 ——
    // 服务端写死中文的话，英文界面下这一行就是整段对话里唯一的中文。
    // 断言因此落在字段上：错误正文与错误码一个都不许丢（那正是这条要修的 bug）。
    assert.equal(notice.reason, 'error');
    assert.equal(notice.message, '所有通道对该模型均受限', '错误正文必须带到前端');
    assert.equal(notice.code, 'QUOTA_EXCEEDED', '错误码必须带到前端');
    assert.equal(notice.error, true, 'error 结局要标出来（渲染层据此走红色）');
    assert.ok(!('text' in notice), '后端不再拼句子：' + JSON.stringify(notice));
    // max-tokens 结局：没有 error 也要成行，且不编造 message/code
    const stopRow = graph.extractConversation([
      { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
      { type: 'turn/end', seq: 2, time: 2000, data: { turn: 1, reason: { kind: 'max-tokens' } } },
    ], 20).find((r) => r.kind === 'turnend');
    assert.equal(stopRow.reason, 'max-tokens');
    assert.equal(stopRow.error, false, '撞上限不是报错，别画成红的');
    assert.ok(!('message' in stopRow) && !('code' in stopRow), '没有就不给，不许编：' + JSON.stringify(stopRow));
    // completed 不制造噪音：正常收尾**不**出一行
    const quiet = graph.extractConversation([
      { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
      { type: 'turn/end', seq: 2, time: 2000, data: { turn: 1, reason: { kind: 'completed' } } },
    ], 20);
    assert.ok(!quiet.some((r) => r.kind === 'turnend'), '正常收尾别插一行废话');
  });
  await check('taskTipOf / buildGraph：任务归属进节点，且只算这个人名下的未删除条目', () => {
    // 2026-10-14：现场 session-dfd6c62d 里 Lead 建了 4 条任务、派了 7 个队员，两边零引用，
    // 画布上同样看不出「谁该收哪条」。归属由服务端算，客户端只画。
    // ⚠️ 同一天再改一次**返回形状**：原来服务端拼一整句中文，等于把界面语言焊死在宿主半
    // —— 而知道语言的只有浏览器。现在发结构化 rows，句子由客户端按当前语言拼。
    const tasks = [
      { id: 'task-1', revision: 3, status: 'in_progress', ownerName: 'a', subject: '都市天际线场景 src/scene-city.js' },
      { id: 'task-2', revision: 5, status: 'completed', ownerName: 'a', subject: '第二条' },
      { id: 'task-3', revision: 1, status: 'pending', subject: '没人认领的' },
      { id: 'task-4', revision: 2, status: 'deleted', ownerName: 'a', subject: '删掉的' },
    ];
    const tip = graph.taskTipOf(tasks, 'a');
    assert.equal(tip.total, 2, JSON.stringify(tip));
    assert.equal(tip.rows.length, 2, '默认上限内要全带');
    assert.deepEqual(tip.rows[0], { id: 'task-1', status: 'in_progress', revision: 3, subject: '都市天际线场景 src/scene-city.js' });
    assert.equal(tip.rows[1].id, 'task-2');
    assert.ok(!JSON.stringify(tip.rows).includes('task-3') && !JSON.stringify(tip.rows).includes('task-4'),
      '别人的 / 没认领的 / 已删除的不许混进来：' + JSON.stringify(tip.rows));
    assert.equal(graph.taskTipOf(tasks, 'nobody').total, 0, '名下没有条目时 total=0（客户端据此不挂 tooltip）');
    assert.deepEqual(graph.taskTipOf(tasks, 'nobody').rows, []);
    assert.equal(graph.taskTipOf(undefined, 'a').total, 0, '任务板读不到时不许抛错');
    assert.equal(graph.taskTipOf(tasks, '').total, 0, '没有名字就不算');
    const many = [];
    for (let i = 0; i < 6; i += 1) many.push({ id: 't' + String(i), revision: 1, status: 'completed', ownerName: 'a', subject: 's' });
    const capped = graph.taskTipOf(many, 'a');
    assert.equal(capped.rows.length, 4, '默认上限 4 条：' + capped.rows.length);
    assert.equal(capped.omitted, 2, '被折掉的条数要如实给出（省略句由客户端拼）：' + capped.omitted);
    assert.equal(capped.total, 6, '总数是全部，不是带上来的那几条');
    // Lead 名下条目走官方 ownerName='lead' 口径（task-view.js 把 ownerId == 团队 id 翻成 'lead'）
    assert.equal(graph.taskTipOf([{ id: 't9', revision: 1, status: 'in_progress', ownerName: 'lead' }], 'lead').rows[0].id, 't9',
      'Lead 自己接的条目也要能显示');
    // subject 里的换行/制表要压平（它是多行 tooltip 的一行）
    const messy = graph.taskTipOf([{ id: 't1', revision: 1, status: 'in_progress', ownerName: 'a', subject: '第一行\n第二行\t制表' }], 'a');
    assert.ok(!messy.rows[0].subject.includes('\t') && !messy.rows[0].subject.includes('\n'),
      'subject 里的控制符要压平：' + JSON.stringify(messy.rows[0].subject));
    // 服务端算好、客户端只画：buildGraph 必须把清单挂到每个节点上
    const bySession = new Map([['lead', graph.emptyStats()], ['a', graph.emptyStats()]]);
    const g = graph.buildGraph({ leadId: 'lead', leadName: 'lead', members: [{ id: 'a', name: 'a', role: 'teammate' }], statsBySession: bySession, tasks });
    const nodeA = g.nodes.find((node) => node.name === 'a');
    const nodeLead = g.nodes.find((node) => node.role === 'lead');
    assert.equal(nodeA.taskTip.rows[0].id, 'task-1', '队员节点没拿到自己的任务归属');
    assert.equal(nodeLead.taskTip.total, 0, 'Lead 名下没有条目时不该有假提示');
  });

  await check('画布把任务归属画出来：tooltip 在 wsNodeCard 与 wsUpdateCard 两处都接上', () => {
    const src = readFileSync(path.join(PLUGIN_DIR, 'lib', 'client.js'), 'utf8');
    // 2026-10-14 契约变更：服务端发**结构化**归属清单，句子由客户端拼（语言在浏览器）。
    // 所以这里钉的是「两处都调 wsTaskTip(…) 且都带上 node.name」——
    // 名字不传，标题行就成了「任务板：2 条归 」（官方 ownerName 只到服务端那一层）。
    assert.ok(src.includes('el.title = wsTaskTip(node.taskTip, node.name)'),
      'wsNodeCard 不再把任务归属挂到卡片 tooltip（新卡片悬停看不到）');
    assert.ok(src.includes('const tip = wsTaskTip(node.taskTip, node.name)')
      && src.includes('if (el.title !== tip) el.title = tip'),
      'wsUpdateCard 不刷新 tooltip（claim / complete 之后要重开卡片才更新）');
    const tipFn = src.slice(src.indexOf('function wsTaskTip('), src.indexOf('function wsNodeCard('));
    assert.ok(tipFn.length > 60, '抓不到 wsTaskTip 函数体');
    assert.ok(/wsTaskTipHead/.test(tipFn) && /wsTaskTipMore/.test(tipFn),
      'tooltip 的标题行与省略行必须走字典（写死中文=英文界面翻不到）');
    // （用 includes 而不是正则：那句里有裸括号，写成正则字面量会当场语法错。）
    assert.ok(tipFn.includes("rows.length === 0) return ''"),
      '名下没有条目必须回空串（据此不挂 tooltip，不编一个空标题出来）');
    for (const gone of ['wsDrawerRelations', 'wsDrawerNoRel', 'wsDrawerTasks', 'wsDrawerNoTask']) {
      assert.ok(!src.includes(gone + ':'), '死文案 ' + gone + ' 又回来了（浮窗只放「指标 + 对话」是用户 2026-10-08 的决定）');
    }
    // 采集链不许断：collectGraph 必须把它读到的任务列表交给 buildGraph，
    // 否则 node.taskTip 恒为空串 —— 客户端接得再好也只会显示「没有任务」。
    const gsrc = readFileSync(path.join(PLUGIN_DIR, 'lib', 'graph.js'), 'utf8');
    const call = /const graph = buildGraph\(\{[\s\S]*?\n  \}\);/.exec(gsrc);
    assert.ok(call !== null, '找不到 collectGraph 里的 buildGraph 调用（改名或换写法了？同步这条闸门）');
    assert.ok(call[0].includes('tasks,'), 'collectGraph 没把 tasks 传给 buildGraph：节点上的任务归属会永远是空');
    // Lead 节点的 name 必须是 'lead'：官方 ownerName 对 Lead 自己的条目就是翻成 'lead'
    // （task-view.js），两边不同口径时 Lead 名下条目会一条都匹配不上。
    assert.ok(call[0].includes("leadName: 'lead'"), 'Lead 节点名字不再是 lead：与官方 ownerName 口径分叉，归属会匹配不上');
  });

  await check('仓库内的行号指针必须仍指得到它声称的东西（2026-10-15 清掉一批失效后加的闸门）', () => {
    // 起因：我先在文档里写了一句**假指针**（「见 §6」，而 §6 通篇没提那个字段），自查时
    // 意识到这是本仓库最容易复发的一类错 —— **行号会被别人的编辑挪走**。全仓按本闸门
    // 同一套规则数（可复跑）：正文自引用 17 处 = 速记 2 + 判不了 5 + **可判 10**（现在）。
    // **HEAD 上可判的是 9 条，其中 5 条已经指错**（lib/runtime.js 对 index.js:282/:336/:539
    // 与 integration-test 对 index.js:282/:336 —— 更早的欠账）。本轮 `git diff` 可复跑：含行号的
    // 引用句共改动 8 行 / 9 条指针 = 那 5 条旧账 + 被我自己这几轮**当场弄坏**的 4 条
    // （往 client.js 插 800 行后「lib/client.js:2123-2126」飘到 React.createElement；roster.js
    // 加几十行后 HEAD 里一直对的 :472-482 也飘了）。所以这条闸门存在的理由是
    // **写的时候对 ≠ 以后一直对**，而不是「改完就永远对了」。
    //
    // 判据（只核机器判得了的，宁可少判也不误判 —— 第一版我自己的正则太窄，
    // 把我造的两个变异放过去了，白 PASS 两轮，教训记在这儿）：
    //   * 目标写作 lib/X.js:NN 或 tools/X.js:NN，且 X 是本仓库真实文件；
    //   * 引用句里必须点得出**符号名**：反引号里的（\u0060clipLine\u0060）或驼峰/下划线
    //     形状的裸标识符（LINE_MAX、TEAMMATE_TOOL_DENY、getConfigPath…）；都没有就跳过；
    //   * 目标文件 NN 的 **±8 行窗口**里至少出现一个那些符号。取窗口而不是整文件：
    //     整文件永远命中（符号在别处也出现过），那等于没判。
    // 四条**合法**跳过，各有依据：
    //   * 勘误表整行（形如 | 42 |）：那是日期化的**历史记录**，行号是当时核实的样子，
    //     改它等于篡改历史；当前性指针只允许写在正文。
    //   * 指针前面是「/」：官方包全路径的尾巴（…/dsh-llm/lib/index.js:2367）。
    //   * 上一行以「/」收尾：官方包路径**跨行折断**写的（dsh-client-ui-user-questions/
    //     换行 lib/client.js:1668-1677）。实测有 2 处这种写法，不跳就误报。
    //   * 句中出现 mcp-manager / dsh-xxx / 第三方插件：**非本仓库**文件的速记。例：§6 那句
    //     「先例：@xxxyz/dsh-mcp-manager 的 apiCall()，lib/client.js:91-101」指的是那个第三方包
    //     （本机 ~/.dsh/profiles/web/node_modules/…，2026-10-17 逐字读过）的 91-101，
    //     不是我们自己的 client.js（我们的 90-101 是 bridgeService）。不跳就会误报。
    //     注意：这类引用**在别人机器上不一定存在**（第三方插件），所以文档里要写明它是第三方、
    //     并把本机路径给出来，别让读者以为那是官方包或本仓库文件。
    const ROOT = path.join(__dirname, '..');
    const files = ['lib/client.js', 'lib/graph.js', 'lib/runtime.js', 'lib/index.js', 'lib/playbook.js',
      'lib/roster.js', 'lib/tools.js', 'tools/selftest.cjs', 'tools/integration-test.cjs',
      'tools/drift-check.cjs', 'INTERFACES.md'];
    const ownBase = new Set(['client.js', 'graph.js', 'runtime.js', 'index.js', 'playbook.js',
      'roster.js', 'tools.js', 'selftest.cjs', 'integration-test.cjs', 'drift-check.cjs']);
    const cache = new Map();
    const linesOf = (rel) => {
      if (cache.has(rel) === false) cache.set(rel, readFileSync(path.join(ROOT, rel), 'utf8').split('\n'));
      return cache.get(rel)
    };
    const CITE = /(?:lib|tools)\/([\w-]+\.(?:js|cjs)):(\d+)/g;
    const FOREIGN = /mcp-manager|dsh-[a-z]|某个第三方插件|第三方插件/;
    const ERRATA = /^\s*\|\s*\d+\s*\|/;
    const WRAPPED = /\/\s*$/;
    const CAMEL = /[a-z][A-Z]/;
    // 反引号对里的标识符：用 \u0060 而不是裸反引号，免得这个正则本身被当字符串截断。
    const TICKED = /[\u0060]([A-Za-z_][A-Za-z0-9_]{2,})(?:\(\))?[\u0060]/g;
    const BARE = /[A-Za-z_][A-Za-z0-9_]*/g;
    const STOP = new Set(['javascript', 'undefined', 'interface', 'boolean', 'string', 'number',
      'object', 'promise', 'function', 'react', 'createelement', 'https', 'http', 'json', 'node',
      'window', 'document', 'assert', 'includes', 'indexof', 'readfile', 'splice', 'filter',
      'replace', 'typeof', 'problems', 'offenders', 'params', 'targets', 'symbols', 'strings',
      'notes', 'client', 'graph', 'runtime', 'index', 'playbook', 'roster', 'tools', 'selftest',
      'drift', 'check', 'inter', 'section', 'sections', 'matchall']);
    const symbolsOf = (line) => {
      const set = new Set();
      for (const m of line.matchAll(TICKED)) set.add(m[1]);
      for (const m of line.matchAll(BARE)) {
        const t = m[0];
        if (t.length < 4 || STOP.has(t.toLowerCase())) continue;
        if (t.indexOf('_') >= 0 || CAMEL.test(t)) set.add(t);
      }
      return [...set]
    };
    const problems = [];
    let judged = 0;
    for (const f of files) {
      const lines = linesOf(f);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (ERRATA.test(line)) continue;                                  // 勘误表：历史不核
        let m;
        CITE.lastIndex = 0;
        while ((m = CITE.exec(line)) !== null) {
          if (line[Math.max(0, m.index - 1)] === '/') continue;           // 官方全路径尾巴
          if (i > 0 && WRAPPED.test(lines[i - 1])) continue;              // 官方路径跨行折断
          if (ownBase.has(m[1]) === false) continue;
          if (FOREIGN.test(line)) continue;                               // 官方速记
          const symbols = symbolsOf(line);
          if (symbols.length === 0) continue;                             // 判不了就跳
          const rel = (/^(client|graph|runtime|index|playbook|roster|tools)\./.test(m[1]) ? 'lib/' : 'tools/') + m[1];
          const target = linesOf(rel);
          const n = Number(m[2]);
          judged += 1;
          if (n > target.length) {
            problems.push(f + ':' + (i + 1) + ' 指 ' + rel + ':' + n + ' 越界（该文件只有 ' + target.length + ' 行）');
            continue
          }
          const win = target.slice(Math.max(0, n - 1 - 8), n + 8).join('\n');
          if (symbols.some((s) => win.indexOf(s) >= 0) === false) {
            problems.push(f + ':' + (i + 1) + ' 指 ' + rel + ':' + n + '，但那几行里没有 '
              + symbols.slice(0, 3).join('/') + ' 任何一个（现在那行是 '
              + JSON.stringify(target[n - 1].trim().slice(0, 56)) + '）');
          }
        }
      }
    }
    // 能机器判的只有「句里点得出符号」的那些（实测 11 处上下）；纯行号引用（「见 :1117」）
    // 机器无从知道它指什么。下限按真实可达数写 —— 写个够不着的高数就是自欺。
    assert.ok(judged >= 6, '这条闸门只判了 ' + judged + ' 处，判据漂了');
    assert.deepEqual(problems, [], '这些行号指针已经指不到它声称的东西：\n' + problems.join('\n'));
  });
  await check('浮窗必须认当前语言（P1：wsText 此前恒读 zh，英文界面下整个工作区仍是中文）', () => {
    // 上一轮我把这条报成「zh 183 键 vs en 78 键的翻译缺口」—— 那个描述**不完整**。
    // 这次先查真实读取路径再定契约：
    //   * 配置页（React）走 makeText(props.t) → 官方 locale 查找链，本来就跟语言；
    //   * 工作区浮窗（命令式 DOM）119 处全走 wsText(key)，实现是
    //     typeof zh[key] === 'string' ? zh[key] : key（改动前在 lib/client.js:2123-2126；
    //     本闸门就是为修它而加，现行实现见同文件 localeText）——
    //     **恒读 zh**，连查都没查官方 locale。所以光把 en 补齐也不会变英文。
    //   同一形状的还有 fallbackText（改动前在 :1158-1161，宿主错误回执走它）。
    // 官方能力（本轮实读 dsh-client-locale/lib/client.js）：
    //   getSnapshot() :1250-1252 带 active；subscribe(fn) :1260-1265 每次快照变化通知
    //   （语言切换**与字典注册**都会 publish：:1443 与 :1397）；
    //   translate :1423-1427 按 active 的 fallbackChain 查，缺键回 key 本身。
    // 契约：wsText / fallbackText 先问官方链，拿不到（或原样回 key）才退本文件 zh，
    // 再退 key。退 zh 而不是退 key 是刻意的：宁可给用户一句中文，也不给一串 camelCase。
    const cli = readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
    const at = cli.indexOf('function wsText(');
    assert.ok(at > 0, '抓不到 wsText（改名了？同步这条闸门）');
    const wsTextBody = cli.slice(at, cli.indexOf('function TeamEntryAnchor(', at));
    assert.ok(wsTextBody.length > 40 && wsTextBody.length < 2600, 'wsText 函数体形状不对');
    assert.ok(/locale/i.test(wsTextBody),
      'wsText 又不读当前语言了：英文界面下整个工作区浮窗会退回全中文');
    const fbAt = cli.indexOf('function fallbackText(');
    assert.ok(fbAt > 0, '抓不到 fallbackText');
    assert.ok(/locale/i.test(cli.slice(fbAt, fbAt + 800)),
      'fallbackText 也必须走同一套语言解析（宿主错误回执走它）');
    // 切换语言必须让**已经打开**的浮窗跟着换字：覆盖层是命令式 DOM，官方那次
    // React 重渲染不会顺手刷它。官方留 subscribe 正是给这个用的（同包先例：
    // dsh-client-ui-conversation/lib/client.js:18014 ctx.locale.subscribe(refreshViews)）。
    assert.ok(/locale\.subscribe\(/.test(cli),
      '没有订阅 locale 变化：用户切语言后，开着的浮窗仍是旧语言');
  });

  await check('浮窗逐行时间与复制按钮：只给用户/助手行（官方就这么定，不多不少）', () => {
    // P1-3（用户：弹窗要和官方聊天窗口等价）。官方实现本轮实读：
    //   * 规则 .probe-tmp/chat-client.js:1057-1068 formatMessageClock(time, t, now)：
    //     当天只给 HH:mm；同年给 clock.md + 空格 + HH:mm；跨年给 clock.ymd + HH:mm。
    //   * 官方文案 dsh-client-locale/lib/client.js:933-934/979-980（实读 asar）：
    //     copy=复制/Copy，copied=复制成功/Copied；clock.md={m}月{d}日 / {m}/{d}；
    //     clock.ymd={y}年{m}月{d}日 / {y}-{m}-{d}（两份都是真值，不是自造措辞）。
    //   * **谁有**这两样：UserMessageNodeView（chat-client.js:1458-1464，time+clock=start）、
    //     助手回合尾（:6596-6599，time+clock=end）。而工具行**没有**时间：
    //     .probe-tmp/tool-client.js 里 formatMessageClock 出现 0 次，
    //     official-conversation-client.js 里也是 0 次。PendingSteeringBubble（:1398-1403）
    //     有复制键但**不传 time**（官方 :1144 `time === void 0 ? null` 就不画钟）。
    //   → 所以「给每一行都加时间」是**超出官方**的做法，会把工具行搞成官方没有的样子；
    //     这里钉的是「用户/助手行有，工具行没有」。
    const cli = readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
    const at = cli.indexOf('function wsFormatClock(');
    assert.ok(at > 0, '没有 wsFormatClock（逐行时间的官方规则移植丢了？）');
    const body = cli.slice(at, cli.indexOf('\n  }', at) + 4);
    assert.ok(body.length > 200 && body.length < 2400, 'wsFormatClock 函数体形状不对');
    // 官方三档都在，且日期串走字典（不写死「月/日」—— 英文界面要 {m}/{d}）。
    assert.ok(/wsClockYmd|wsClockMd/.test(body), '跨年/同年必须走 clock.md / clock.ymd 两条键');
    assert.ok(/getHours\(\)/.test(body) && /getMinutes\(\)/.test(body) && /pad/.test(body),
      '必须是 24 小时制 HH:mm（官方 pad2(getHours()):pad2(getMinutes())）');
    assert.ok(/getFullYear\(\)/.test(body) && /getMonth\(\)/.test(body) && /getDate\(\)/.test(body),
      '同年判定要按本地日历（官方 :1061 三件套），不能按「相差 24 小时」');
    // 复制：官方标签 + 成功后短暂回显（:1137-1141 setCopied(true) + 1e3 ms 复位）
    assert.ok(/wsCopyLabel|'wsCopy'/.test(cli), '没有复制按钮的字典键接线');
    assert.ok(/'wsCopied'/.test(cli), '复制成功后的回显文案缺失（官方 copied）');
    assert.ok(/navigator\.clipboard/.test(cli) && /execCommand/.test(cli),
      '剪贴板必须有 execCommand 兜底：官方 writeClipboard 就这么写（非安全上下文里 clipboard 不可用，' +
      '只写 clipboard 的话用户点了没反应）');
    // 谁有：用户/助手行接 wsRowClock/复制，工具行**不许**接。
    assert.ok(/wsRowMeta|wsClockEl|wsCopyBtn/.test(cli), '没找到行内时间/复制的挂载点');
    const clockCalls = [...cli.matchAll(/wsFormatClock\(/g)].length;
    assert.ok(clockCalls >= 2 && clockCalls <= 12, 'wsFormatClock 调用点数量异常（' + clockCalls + '）：要么没接上，要么到处乱贴');
  });
  await check('宿主提示 notes 走结构化 code（双语的前提：服务端不拼句子）', () => {
    // 上一轮我给用户的建议原话是「宿主只发 code/count/reason 这类事实、句子挪到浏览器拼」，
    // 用户 2026-10-15 点头做的是这条。范围**只有画布底栏那批 notes**（lib/graph.js）：
    // lib/runtime.js / lib/preset.js 里的同名 notes 是**另一个通道**（配置页 + 磁盘状态文件），
    // 那边有 40 多个推送点、且大部分是排障用语，不在这次范围内（如实记在这儿，不假装全修了）。
    const graph = readFileSync(path.join(PLUGIN_DIR, 'lib', 'graph.js'), 'utf8');
    const cli = readFileSync(path.join(PLUGIN_DIR, 'lib', 'client.js'), 'utf8');

    // ① graph.js 的每一处 notes.push 必须是 { code, params }，不许再拼中文句子。
    const pushes = [];
    const scan = (from) => {
      // 从 notes.push( 之后扫到配对的 )（字符串里的括号按引号跳过）。
      let depth = 1; let i = from; let quote = null;
      while (i < graph.length && depth > 0) {
        const c = graph[i];
        if (quote !== null) {
          if (c === '\\') { i += 2; continue }
          if (c === quote) quote = null;
          i += 1; continue;
        }
        if (c === "'" || c === '"' || c === String.fromCharCode(96)) { quote = c; i += 1; continue }
        if (c === '(' || c === '{' || c === '[') depth += 1;
        else if (c === ')' || c === '}' || c === ']') depth -= 1;
        i += 1;
      }
      return graph.slice(from, i - 1);
    };
    let at = 0;
    while ((at = graph.indexOf('notes.push(', at)) >= 0) {
      const body = scan(at + 'notes.push('.length);
      pushes.push(body);
      at += 1;
    }
    assert.ok(pushes.length >= 7, 'notes.push 只找到 ' + pushes.length + ' 处（七个降级事实都在 graph.js 里，数量变了要重核这条闸门）');
    const codes = [];
    for (const body of pushes) {
      assert.ok(!new RegExp('[\\u4e00-\\u9fff]').test(body),
        'notes.push 里又出现中文字面量（等于把界面语言焊回宿主半）：' + body.trim().slice(0, 90));
      const m = /^\s*\{\s*code:\s*'([A-Za-z][A-Za-z0-9]*)'/.exec(body);
      assert.ok(m !== null, 'notes.push 必须是 { code: 名字, params: {…} } 形状：' + body.trim().slice(0, 90));
      codes.push(m[1]);
    }
    const uniqueCodes = [...new Set(codes)];
    assert.equal(codes.length, uniqueCodes.length, '同一个 code 被推了两遍（每种降级事实应各一个）：' + codes.join(','));

    // ② 客户端的 WS_NOTE_CODES 必须与之**双向相等**：少一个映射，那条提示就显示成裸 code。
    const mapAt = cli.indexOf('const WS_NOTE_CODES = {');
    assert.ok(mapAt > 0, 'client.js 找不到 WS_NOTE_CODES 表（语言切换后宿主提示无句可拼）');
    const mapBlock = cli.slice(mapAt, cli.indexOf('\n  }', mapAt));
    const mapped = [...mapBlock.matchAll(/^\s{4}([A-Za-z][A-Za-z0-9]*):/gm)].map((x) => x[1]);
    const missingMap = uniqueCodes.filter((c) => !mapped.includes(c));
    const orphanMap = mapped.filter((c) => !uniqueCodes.includes(c));
    assert.deepEqual(missingMap, [], 'graph.js 发了但客户端没有映射的 code（画布上会显示成 ' + 'code 原文）：' + missingMap.join(','));
    assert.deepEqual(orphanMap, [], 'WS_NOTE_CODES 里有 graph.js 不再发的死映射：' + orphanMap.join(','));

    // ③ 每个映射指向的字典键，zh 与 en 两本都得有（缺一本 = 那种「补齐也没用」的谎）。
    const lines = cli.split('\n');
    const dictKeys = (dict) => {
      const start = lines.findIndex((l) => l.trim().startsWith('const ' + dict + ' = {'));
      assert.ok(start >= 0, '找不到字典 ' + dict);
      let end = start;
      while (end + 1 < lines.length && lines[end].trim() !== '}') end += 1;
      const out = new Set();
      for (let i = start + 1; i < end; i += 1) {
        const l = lines[i];
        if (!l.startsWith('    ')) continue;
        const cut = l.indexOf(':');
        if (cut <= 4) continue;
        const name = l.slice(4, cut);
        if (name.trim() === name && /^[A-Za-z0-9_]+$/.test(name)) out.add(name);
      }
      return out;
    };
    const zh = dictKeys('zh');
    const en = dictKeys('en');
    const targets = [...mapBlock.matchAll(/^\s{4}[A-Za-z][A-Za-z0-9]*:\s*'([^']+)'/gm)].map((x) => x[1]);
    assert.equal(targets.length, mapped.length, 'WS_NOTE_CODES 的某一项值不是字典键名（写成了句子？）');
    for (const key of targets) {
      assert.ok(zh.has(key), '宿主提示的中文文案缺键：' + key);
      assert.ok(en.has(key), '宿主提示的英文文案缺键：' + key);
    }

    // ④ 渲染处必须过 wsNoteText（原来两处直接 state.notes.join('\n') —— 那会把对象渲染成 [object Object]）。
    assert.ok(/function wsNoteText/.test(cli), '没有 wsNoteText（结构化 code 拿不到句子）');
    assert.ok(/function wsNotesText/.test(cli), '没有 wsNotesText（整批提示的组装点）');
    assert.ok(!/state\.notes\.join\(/.test(cli), '还有地方把 state.notes 直接 join 上屏（对象会变成 [object Object]）');
    // 兼容旧宿主半（浏览器刷新但 DSH 没重启 → notes 还是字符串）：不许当场报错。
    const fn = cli.slice(cli.indexOf('function wsNoteText'), cli.indexOf('function wsNotesText'));
    assert.ok(/typeof note === 'string'/.test(fn), 'notes 是字符串（旧宿主半）时必须有直通分支');
  });

  await check('两本字典的键集合必须严格相等（缺一边就是「补齐也没用」的那种谎）', () => {
    // 上一轮只报「zh 比 en 多 105 键」，容易读成「补翻译就行」。
    // 真正的下限是两边键集合**相等**：多出来的键在另一种语言里必然渲染成中文或裸键名。
    // 解析判据与上面死键闸门同源（同一套 block/keyOf），不留两套各说各话。
    const cli = readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
    const lines = cli.split('\n');
    const range = (dict) => {
      const start = lines.findIndex((line) => line.trim().startsWith('const ' + dict + ' = {'));
      assert.ok(start >= 0, '找不到字典 ' + dict);
      let end = start;
      while (end + 1 < lines.length && lines[end].trim() !== '}') end += 1;
      return { start, end };
    };
    const keyOf = (line) => {
      if (!line.startsWith('    ')) return '';
      const cut = line.indexOf(':');
      if (cut <= 4) return '';
      const name = line.slice(4, cut);
      if (name === '' || name.trim() !== name) return '';
      for (const ch of name) if (!/^[A-Za-z0-9_]+$/.test(ch)) return '';
      return name;
    };
    const collect = (dict) => {
      const r = range(dict);
      const out = new Set();
      for (let i = r.start + 1; i < r.end; i += 1) {
        const name = keyOf(lines[i]);
        if (name !== '') out.add(name);
      }
      return out;
    };
    const zhKeys = collect('zh');
    const enKeys = collect('en');
    assert.ok(zhKeys.size >= 190, 'zh 只解析出 ' + zhKeys.size + ' 个键，判据漂了？');
    const missingEn = [...zhKeys].filter((name) => !enKeys.has(name)).sort();
    const missingZh = [...enKeys].filter((name) => !zhKeys.has(name)).sort();
    assert.deepEqual(missingEn, [], '这些键英文界面会渲染成中文或裸键名：' + missingEn.join(', '));
    assert.deepEqual(missingZh, [], '这些键只有英文有（中文界面会看到 key）：' + missingZh.join(', '));
  });

  await check('字典之外不许出现硬编码中文（否则补齐 en 也翻不到那几句）', () => {
    // 2026-10-14 全文件实扫：字典区与注释**之外**仍有中文字符串字面量（按钮 title、
    // 上下文环的悬停说明、协作核展开标题、读取失败、图片张数单位等）。
    // 它们不在字典里，英文界面下就是一句孤零零的中文 —— 补多少条翻译都没用。
    const cli = readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
    const lines = cli.split('\n');
    const range = (dict) => {
      const start = lines.findIndex((line) => line.trim().startsWith('const ' + dict + ' = {'));
      assert.ok(start >= 0, '找不到字典 ' + dict);
      let end = start;
      while (end + 1 < lines.length && lines[end].trim() !== '}') end += 1;
      return { start, end };
    };
    const ranges = [range('zh'), range('en')];
    const CJK = new RegExp('[\\u4e00-\\u9fff]');
    const DQ = String.fromCharCode(34);
    const BT = String.fromCharCode(96);
    // 扫一行里**真正是字符串字面量**的片段，跳过行注释与块注释。
    // 只按 split 粗剥不够：本文件的注释一律是中文，而块注释也常出现在行尾
    // （catch 里那种「已经掉了」），第一版就是这么误报了 5 处。
    const stringLiterals = (code) => {
      const found = [];
      let quote = null;
      let text = '';
      let inBlock = false;
      for (let j = 0; j < code.length; j += 1) {
        const c = code[j];
        const next = code[j + 1];
        if (inBlock) {
          if (c === '*' && next === '/') { inBlock = false; j += 1 }
          continue;
        }
        if (quote === null) {
          if (c === '/' && next === '/') break;
          if (c === '/' && next === '*') { inBlock = true; j += 1; continue }
          if (c === "'" || c === DQ || c === BT) { quote = c; text = ''; continue }
          continue;
        }
        if (c === '\\') { text += c + (next === undefined ? '' : next); j += 1; continue }
        if (c === quote) { found.push(text); quote = null; continue }
        text += c;
      }
      // 跨行模板串：收尾时仍处于引号内，就把攒下的这段也算进去。
      if (quote !== null) found.push(text);
      return found;
    };
    const offenders = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (ranges.some((r) => i >= r.start && i <= r.end)) continue;
      const t = lines[i].trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      const hit = stringLiterals(lines[i]).filter((s) => CJK.test(s));
      if (hit.length > 0) offenders.push((i + 1) + ': ' + hit[0].slice(0, 40));
    }
    assert.deepEqual(offenders, [], '这些中文没进字典，英文界面翻不到：' + offenders.join(' | '));
  });
  await check('client.js 的两本内联字典里不许有零引用文案（2026-10-14 清掉 6 条死键后钉死这一类）', () => {
    const src = readFileSync(path.join(PLUGIN_DIR, 'lib', 'client.js'), 'utf8');
    const lines = src.split('\n');
    const blockRange = (dict) => {
      const start = lines.findIndex((line) => line.trim().startsWith('const ' + dict + ' = {'));
      if (start < 0) return null;
      let end = start;
      while (end + 1 < lines.length && lines[end].trim() !== '}') end += 1;
      return { dict, start, end };
    };
    const ranges = [];
    for (const dict of ['zh', 'en']) {
      const range = blockRange(dict);
      if (range === null) return '找不到字典 ' + dict + '（写法变了？同步这条闸门）';
      ranges.push(range);
    }
    const keyOf = (line) => {
      if (!line.startsWith('    ')) return '';
      const cut = line.indexOf(':');
      if (cut <= 4) return '';
      const name = line.slice(4, cut);
      if (name === '' || name.trim() !== name) return '';
      for (const ch of name) if (!/^[A-Za-z0-9_]+$/.test(ch)) return '';
      return name;
    };
    // 判据：键名以**字符串字面量**出现在两本字典之外。本文件唯一的取键方式是 zh[key] / t('key')，
    // 全文没有 'ws' + 变量 这类动态拼键（2026-10-14 逐行扫过），所以字面量判据是充分的。
    const outside = lines.map((line, i) => (ranges.some((range) => i > range.start && i <= range.end) ? '' : line)).join('\n');
    const keys = [];
    for (const range of ranges) {
      for (let i = range.start + 1; i < range.end; i += 1) {
        const name = keyOf(lines[i]);
        if (name !== '') keys.push({ dict: range.dict, line: i + 1, name });
      }
    }
    assert.ok(keys.length > 200, '只解析出 ' + keys.length + ' 个字典键，判据漂了？');
    const dead = keys.filter((item) => (outside.split("'" + item.name + "'").length - 1) === 0);
    assert.deepEqual(dead.map((item) => item.dict + ':' + item.line + ' ' + item.name), [],
      '这些文案定义了却没人引用（删渲染忘了删文案 = 下次改 UI 的人无从判断还有没有用）');
  });


  await check('extractConversation：过滤注入、工具逐条成官方风格行、正文有界、按 limit 取尾部', () => {
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
      // 助手正文 + 两次工具调用。⚠️ 2026-10-09 起工具调用**逐条成行**（用户：「弹窗要能看到
      // 读取文件、修改文件、调用工具」）；行以 tool/call 事件为准（实测 7/7 会话里
      // assistant 块的 callId 与事件一一对应，见 .probe/probe-blocks-vs-events.cjs）。
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: long }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"a"}' }, { type: 'tool-call', id: 'c2', name: 'write', arguments: '{"file_path":"b"}' }] } } },
      { type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{"file_path":"a"}' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'ok' }], isError: false } } },
      { type: 'tool/call', data: { callId: 'c2', name: 'write', arguments: '{"file_path":"b"}' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'text', text: 'boom' }], isError: true } } },
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
    // 工具行：官方标签 + 目标摘要；assistant 内嵌的块不重复成行。
    const toolRows = rows.filter((r) => r.kind === 'tool');
    assert.equal(toolRows.length, 2, `两条工具调用应各成一行，实际 ${toolRows.length} 行`);
    assert.equal(toolRows[0].text, '读取', `read 应映射官方文案「读取」，实际 ${toolRows[0].text}`);
    assert.equal(toolRows[0].detail, 'a', '工具行应带目标摘要');
    assert.equal(toolRows[1].text, '写入', `write 应映射官方文案「写入」，实际 ${toolRows[1].text}`);
    assert.equal(toolRows[1].error, true, 'isError 的 result 应把行标成失败');
    assert.ok(!rows.some((r) => /read\(\{|tool-call/.test(r.text)), '工具参数不该裸 JSON 刷屏');
    // 团队消息去重：m1 只出现一次
    assert.equal(rows.filter((r) => r.kind === 'team').length, 1, '同一条团队消息应去重');
    // 连续 >8 条工具行折叠中段（防止把正文挤出屏幕）
    const many = [];    for (let i = 0; i < 12; i += 1) many.push({ type: 'tool/call', data: { callId: 'x' + i, name: 'read', arguments: '{}' } });
    const folded = graph.extractConversation(many, 50);
    assert.ok(folded.some((r) => r.kind === 'toolgroup'), '12 条连续工具应折叠中段');
    assert.equal(folded.filter((r) => r.kind === 'tool').length, 6, '折叠后保留头 4 + 尾 2');
  });

  await check('detailOf：浮窗展开层的数据源 —— 按 callId / turn:step 取到官方那份输入与输出', () => {
    // 用户 2026-10-09 原话：「弹窗要像在原始界面看到的界面一样，能看到读取文件、修改文件、
    // 调用工具等等」「一定要正确，和我用官方的对话框没太大区别」。
    // 官方每一行工具调用是**可展开**的：折叠时一行标签+目标，展开是「输入」与「输出」
    // （.probe-tmp/tool-client.js:1495 注释原文 render one localized tool summary and
    //  lazily mounted result card；:1662/:1676 渲 row.input / row.output；:1518 可展开判据）。
    // 本插件此前折到「读取 · package.json」为止：lib/graph.js:1711-1714 处理 tool/result
    // 时**只**写 row.error = true，结果正文一个字节都没取。
    const events = [
      { type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{\"file_path\":\"a/b.md\"}' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: '第一行\n第二行' }], isError: false } } },
      // 非文本块：官方 resultText 对不是 text 的块 JSON.stringify(block, null, 2)，不静默丢
      { type: 'tool/call', data: { callId: 'c2', name: 'grep', arguments: '{\"pattern\":\"x\"}' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'image', attachment: { attachmentId: 'sha256:zz' } }], isError: false } } },
      // 失败且正文为空：官方回退 name: code（同文件 :183），不能显示成空白
      { type: 'tool/call', data: { callId: 'c3', name: 'bash', arguments: '{\"command\":\"ls\"}' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'c3' }, content: [], isError: true, error: { name: 'QuotaError', code: 'QUOTA_EXCEEDED' } } } },
      // 正文全文按 turn:step 取（行内被 clipLine 截过，展开看整段）
      { type: 'assistant/message', data: { turn: 3, step: 5, message: { content: [{ type: 'text', text: 'y'.repeat(2600) }] } } },
    ];
    const one = graph.detailOf(events, 'call:c1');
    assert.equal(one.ok, true, '按 callId 取详情必须命中：' + JSON.stringify(one));
    assert.equal(one.input, JSON.stringify({ file_path: 'a/b.md' }, null, 2), '输入 = 官方 formatToolBody 的序列化（:263 JSON.stringify(parsed, null, 2)）');
    assert.equal(one.output, '第一行\n第二行', '输出 = result 的 text 块');
    assert.equal(one.error, false);
    const img = graph.detailOf(events, 'call:c2');
    assert.ok(img.output.indexOf('\"image\"') >= 0 && img.output.indexOf('sha256:zz') >= 0,
      '非文本块要按官方那样序列化出来：' + img.output);
    const dead = graph.detailOf(events, 'call:c3');
    assert.equal(dead.error, true);
    assert.ok(dead.output.indexOf('QuotaError') >= 0 && dead.output.indexOf('QUOTA_EXCEEDED') >= 0,
      '空正文的失败调用要给错误身份：' + dead.output);
    const body = graph.detailOf(events, 'turn:3:5');
    assert.equal(body.ok, true, '按 turn:step 取正文全文必须命中：' + JSON.stringify(body));
    assert.equal(body.output.length, 2600, '展开层拿到的是**全文**，不是 2000 截断版');
    // 读不到时如实失败，不编内容；畸形 key 不抛错
    assert.equal(graph.detailOf(events, 'call:nope').ok, false);
    assert.equal(graph.detailOf(events, '').ok, false);
    assert.equal(graph.detailOf(events, 'bogus').ok, false);
    assert.equal(graph.detailOf(events, 'turn:9:9').ok, false);
    assert.equal(graph.detailOf(null, 'call:c1').ok, false, '事件读不到时不许抛错');
    // 真人输入与队员汇报**同样会被截**（实测 session-dfd6c62d：最长 user 行 12,897 码元、
    // 最长 team 汇报 12,815，都超 LINE_MAX=2000）。行身份用消息 id（两类事件都带）。
    const msgs = [
      { type: 'user/message', data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '用'.repeat(2600) }] } },
      { type: 'team/message/queued', data: { message: { id: 'm1', senderName: 'lead', targetId: 'x', content: [{ type: 'text', text: '汇报正文' }] } } },
    ];
    assert.equal(graph.detailOf(msgs, 'msg:u1').output.length, 2600, '真人输入按消息 id 取全文');
    assert.equal(graph.detailOf(msgs, 'msg:m1').output, '汇报正文', '队员汇报按 message.id 取全文');
    assert.equal(graph.detailOf(msgs, 'msg:nope').ok, false);
    const marked = graph.extractConversation(msgs, 10);
    const urow = marked.find((r) => r.kind === 'user');
    assert.equal(urow.detailKey, 'msg:u1', '截过的 user 行要带可展开身份：' + JSON.stringify(urow));
    assert.equal(urow.hasDetail, true);
    assert.equal(urow.truncated, true);
    // 有界：单次返回的正文不得无上限（官方是 lazily mount 一整块，我们走路由要设界）
    const huge = graph.detailOf([{ type: 'tool/call', data: { callId: 'h', name: 'read', arguments: '{}' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'h' }, content: [{ type: 'text', text: 'z'.repeat(200000) }], isError: false } } }], 'call:h');
    assert.ok(huge.output.length <= 33000, '输出有上限（防把上下文与带宽打满）：' + huge.output.length);
    assert.ok(huge.truncated === true, '截过要如实标 truncated');
  });

  await check('extractConversation：行带 hasDetail / truncated，折叠组那几条点得开（不许空头承诺）', () => {
    const rows = graph.extractConversation([
      { type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{\"file_path\":\"a\"}' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] } } },
      { type: 'tool/call', data: { callId: 'c2', name: 'todo_write', arguments: '' } },
      { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '短正文' }] } } },
      { type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'w'.repeat(2400) }] } } },
    ], 20);
    assert.equal(rows.find((r) => r.callId === 'c1').hasDetail, true, '有参数有结果的工具行该能展开');
    assert.ok(!rows.find((r) => r.callId === 'c2').hasDetail, '没参数没结果不该有箭头：点了没反应的按钮比没有按钮更糟');
    const short = rows.find((r) => r.text === '短正文');
    assert.ok(!short.hasDetail && !short.truncated, '没截断的正文不该有箭头');
    const long = rows.find((r) => r.kind === 'assistant' && r.step === 2);
    assert.equal(long.truncated, true, '被 LINE_MAX 截过的行必须标 truncated');
    assert.equal(long.hasDetail, true, '截过的行要能展开看全文');
    // 折叠组：中间那几条必须**带着数据**回来（点开就看到），且文案不再承诺一个不存在的「查看」
    const many = [];
    for (let k = 0; k < 12; k += 1) many.push({ type: 'tool/call', data: { callId: 'x' + k, name: 'read', arguments: '{}' } });
    const folded = graph.extractConversation(many, 50);
    const group = folded.find((r) => r.kind === 'toolgroup');
    assert.ok(group, '12 条连续工具应折叠中段');
    assert.ok(Array.isArray(group.rows) && group.rows.length === 6, '折叠掉的 6 条要带在行上供展开：' + JSON.stringify(group.rows));
    assert.equal(group.rows[0].callId, 'x4', '折叠的是中段（头 4 + 尾 2 保留）');
    assert.equal(group.count, 6, '数量是事实，随行走');
    // 措辞归客户端（i18n）；而旧文案那句「可在「查看」中读取」是**空头承诺** ——
    // 官方有 Inspect 按钮（tool-client.js:1684-1688），本插件没有，照抄就是骗人。
    assert.ok(!('text' in group), '后端不再拼句子：' + JSON.stringify(group));
  });
  await check('team 行：sender 走结构化字段，正文保持纯净 markdown（弹窗乱码修复）', () => {
    // 用户 2026-10-11 报障：弹窗里 `##`、`**`、反引号全部裸显（「乱码」）。
    // 根因（真实会话 session-7ac4a2ae seq=66 实测）：队员的 report_result 报告正文**就是
    // markdown**（`## 3) 抽查复核`、`**P2**`、`` `dev/...` ``），但有两处叠加问题：
    //   ① 渲染层（client.js）只给 assistant 行走 wsMarkdown，team 行 textContent 直出；
    //   ② 数据层（graph.js）把 `sender → ` 拼在正文最前面 —— 即使 ① 修了，
    //      「plan-critic → ## 3) 抽查复核」的第一行也会因行首混入非 markdown 前缀
    //      而把标题语法破坏掉。
    //
    // 本闸门钉住 ②（数据层契约）：team 行必须有结构化 senderName，正文**不得**再带
    // `sender → ` 前缀。①由 client-smoke-test 与渲染分支覆盖（"assistant|team|notice" 分支）。
    const rows = graph.extractConversation([
      { type: 'team/message/queued', data: { message: { id: 'r1', senderName: 'plan-critic', targetId: 'lead', content: [{ type: 'text', text: '## 3) 抽查复核\n- **P2** `a.m:1` 存在\n\nVERDICT: ACCEPT' }] } } },
    ], 10);
    assert.equal(rows.length, 1, `应成 1 行，实际 ${rows.length}`);
    const row = rows[0];
    assert.equal(row.kind, 'team');
    assert.equal(row.senderName, 'plan-critic', 'senderName 必须是结构化字段（渲染层据此显示 who 标签）');
    assert.ok(!row.text.startsWith('plan-critic → '), '正文不得再拼 sender 前缀（会破坏首行 markdown）');
    assert.ok(row.text.startsWith('## 3)'), `正文第一行必须保持 markdown 原样，实际 ${JSON.stringify(row.text.slice(0, 20))}`);
    assert.ok(row.text.includes('**P2**') && row.text.includes('VERDICT'), '正文内容不能丢');

    // 反例：sender 缺失时用 '?'，依然不拼进正文。
    const rows2 = graph.extractConversation([
      { type: 'team/message/queued', data: { message: { id: 'r2', targetId: 'lead', content: [{ type: 'text', text: '## 标题' }] } } },
    ], 10);
    assert.equal(rows2[0].senderName, '?', 'senderName 缺失时回退 "?"');
    assert.ok(rows2[0].text.startsWith('## 标题'), '正文依然纯净');
  });

  await check('extractConversation：工具行带 callId、正文行带 turn/step（弹窗流式层的去重判据）', () => {
    // 2026-10-13 弹窗实时化的配套：覆盖层要判断「这条流式内容是不是已经进持久行了」。
    // 判据只能是 callId 与 (turn, step) —— 名字与目标都可能重复（连续两次 read 同一文件）。
    const rows = graph.extractConversation([
      { type: 'assistant/message', data: { turn: 2, step: 3, message: { content: [{ type: 'text', text: '正文' }] } } },
      { type: 'tool/call', data: { turn: 2, step: 3, callId: 'call-x', name: 'read', arguments: '{"file_path":"a/b.md"}' } },
    ], 10);
    const asst = rows.find((r) => r.kind === 'assistant');
    assert.equal(asst.turn, 2, 'assistant 行没带 turn');
    assert.equal(asst.step, 3, 'assistant 行没带 step');
    const tool = rows.find((r) => r.kind === 'tool');
    assert.equal(tool.callId, 'call-x', '工具行没带 callId');
    // reasoning 兜底行同样要带（它和正文行是同一回合的两种形态）
    const onlyR = graph.extractConversation([
      { type: 'assistant/message', data: { turn: 5, step: 1, message: { content: [{ type: 'reasoning', text: '在想' }] } } },
    ], 10);
    assert.equal(onlyR[0].turn, 5, 'reasoning 行没带 turn');
    assert.equal(onlyR[0].step, 1, 'reasoning 行没带 step');
  });

  await check('settledStepsOf：整步结算的名单准确，且不受工具行折叠影响', () => {
    // 折叠判据必须吃**完整事件**：extractConversation 会把成串工具行折成一条计数行，
    // 被吞掉的行其 turn/step 就不在返回结果里 —— 前端只看行会漏判、重复显示。
    const many = [];
    for (let i = 0; i < 12; i += 1) {
      many.push({ type: 'tool/call', data: { turn: 1, step: 2, callId: 'c' + i, name: 'read', arguments: '{"file_path":"f' + i + '"}' } });
    }
    const steps = graph.settledStepsOf(many);
    assert.ok(steps.includes('1:2'), 'tool/call 没算进结算名单：' + JSON.stringify(steps));
    assert.equal(graph.extractConversation(many, 50).filter((r) => r.kind === 'tool').length < 12, true,
      '前提不成立：这批工具行没被折叠，测不到「折叠导致漏判」');
    assert.deepEqual(graph.settledStepsOf([]), [], '空事件该给空名单');
    assert.deepEqual(graph.settledStepsOf(null), [], 'null 不该抛错');
    // 没有 turn/step 的事件（如 user/message）不进名单
    assert.deepEqual(graph.settledStepsOf([{ type: 'tool/call', data: { name: 'read' } }]), [], '缺 turn/step 不该进名单');
  });

  await check('toolLabelTable：给全驼峰与下划线两种键，且与 toolRowLabel 同口径', () => {
    // 浏览器半的流式覆盖层要用它给「正在生成的工具调用」出标签；
    // 事件里的名字是 read_image，官方表编的是 readImage —— 两种键都得在。
    const table = graph.toolLabelTable();
    assert.equal(typeof table.generic, 'string', '缺 generic 兜底');
    assert.equal(table.titles.read, graph.toolRowLabel('read'), '驼峰键与 toolRowLabel 不一致');
    assert.equal(table.titles.read_image, graph.toolRowLabel('read_image'), '下划线键与 toolRowLabel 不一致');
    assert.equal(table.titles.grep, graph.toolRowLabel('grep'), 'grep 标签不一致');
    // 别名工具（官方表里没有、本机确实存在）也要能查到
    assert.equal(table.titles.web_search, graph.toolRowLabel('web_search'), '别名工具没进表');
    assert.equal(table.titles.report_result, graph.toolRowLabel('report_result'), '团队工具没进表');
    // 原型键不能是**自己的**键：这张表要过 JSON 边界送到浏览器，宿主这边只能保证
    // 「只写真实工具名」。读到 constructor/toString 这类值时的兜底在浏览器那一侧
    // （wsToolLabel 用 typeof === 'string' 过滤），由 .probe/verify-p1p2.mjs 端到端验。
    assert.equal(Object.prototype.hasOwnProperty.call(table.titles, 'constructor'), false,
      '原型键不该是自己的键');
    assert.ok(Object.values(table.titles).every((v) => typeof v === 'string'), '表里混进了非字符串值');
  });

  await check('extractConversation：被中止的回合只有 reasoning 块时，对话不能整片空白', () => {
    // 用户 2026-10-10 报障：「工作区里面空的，看不到回复」。
    // 根因（真实会话 session-93e1ac65 seq=19 实测）：用户 `/team` 后中止那一轮，
    // DSH 落盘的 assistant/message 里 content **只有一个 reasoning 块**
    // （`[{type:'reasoning', text:<37428 字符>}]`，data.stream 只有 2 条记录：
    //  `chunk/block-start(blockType:reasoning)` 与 `reasoning-chunks`，没有任何 usage）。
    // 而 textOfBlocks 只认 `type === 'text'` ⇒ 返回空串 ⇒ 对话详情**整片空白**，
    // 用户看不到任何内容，尽管模型确实产出了 3.7 万字。
    //
    // 这条闸门钉住修复：reasoning-only 的 assistant 消息必须成行，且**必须带
    // reasoning:true 标记**（渲染层据此如实标注「仅思考内容」，避免被当成正式回复）。
    const onlyReasoning = [
      { type: 'assistant/message', data: { turn: 1, step: 1, interrupted: true, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'Let me think about this task carefully.' }] } } },
    ];
    const rows = graph.extractConversation(onlyReasoning, 10);
    assert.equal(rows.length, 1, `reasoning-only 的回合必须成 1 行，实际 ${rows.length} 行（回归：对话会整片空白）`);
    assert.equal(rows[0].kind, 'assistant');
    assert.equal(rows[0].reasoning, true, 'reasoning 兜底行必须带 reasoning:true，渲染层据此标注');
    assert.ok(rows[0].text.includes('Let me think'), 'reasoning 文本要真的进去');

    // 反例（2026-10-13 改口径）：**有正文**时思考也显示，但是**折叠行**，
    // 且绝不顶替正文 —— 官方界面就是把 reasoning 做成可展开的披露行
    // （dsh-client-ui-chat 的 ReasoningRow），实测 session-99c20ab2 每条
    // assistant/message 都是 reasoning + text 并存。旧断言「有正文只成 1 行」
    // 会让弹窗的流式思考在结算后凭空消失，所以换成下面这三条：
    const withText = [
      { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: '内部推理' }, { type: 'text', text: '正式回复' }] } } },
    ];
    const rows2 = graph.extractConversation(withText, 10);
    assert.equal(rows2.length, 2, '有正文时思考与正文各成一行，实际 ' + rows2.length + ' 行');
    assert.equal(rows2[0].reasoning, true, '思考行在前（与官方顺序一致）');
    assert.equal(rows2[0].collapsed, true, '有正文时思考行必须标 collapsed（渲染层据此折叠）');
    assert.equal(rows2[1].text, '正式回复', '有 text 块时必须用 text，不能被 reasoning 顶替');
    assert.equal(rows2[1].reasoning, undefined, '正文行不许带 reasoning 标记');
    // 没有正文（被中止）时思考行仍然在，但**不折叠** —— 那时它是唯一内容
    assert.equal(graph.extractConversation(onlyReasoning, 10)[0].collapsed, false,
      'reasoning-only 的行不该折叠（折叠了就没有任何可见内容了）');

    // 空 content 不能凭空造行。
    const empty = [{ type: 'assistant/message', data: { message: { content: [] } } }];
    assert.equal(graph.extractConversation(empty, 10).length, 0, '空 content 不该成行');
  });

  await check('hasUsage：没有 provider usage 时必须为 false（「没测量」不能画成「测到 0」）', () => {
    // 用户 2026-10-10 报障：「卡片看不到基本信息」（0/0/0 TODO、0 out、0 cache、0% hit）。
    // 根因（真实会话 session-93e1ac65 seq=19 实测）：被中止的回合没有产生 usage chunk
    // ⇒ data.usage === undefined、data.stream 只有 block-start 与 reasoning-chunks
    // ⇒ 四桶全停在 0。旧渲染把「**没有测量**」画成「**测到 0**」，
    // 而同一屏的「输出速度」却显示 `—`（client.js 用 tps>0 判定），两处口径自相矛盾。
    //
    // 这条闸门钉住 hasUsage 的语义：只有**真的**收到过 usage 才为 true。
    const noUsage = [
      { type: 'model/selection', data: { provider: 'raccoon', model: 'sn-glm-5-3' } },
      { type: 'request/context', data: { provider: 'raccoon', model: 'sn-glm-5-3', contextWindow: 1000000 } },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'assistant/message', data: { turn: 1, step: 1, interrupted: true, message: { content: [{ type: 'reasoning', text: 'x' }] }, stream: [{ type: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } }, { type: 'reasoning-chunks', index: 0, dt: [1, 2] }] } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    ];
    const stats = graph.foldSession(noUsage);
    const g = graph.buildGraph({ leadId: 'L', leadName: 'lead', members: [], statsBySession: new Map([['L', stats]]), tasks: [] });
    assert.equal(g.nodes[0].hasUsage, false, '没有任何 usage 时必须 hasUsage=false（否则卡片会显示骗人的 0）');
    assert.equal(g.totals.hasUsage, false, 'totals.hasUsage 必须同为 false（底栏同一口径）');

    // 有 usage 时必须为 true，且数值进四桶。
    const withUsage = [
      { type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 0 } } },
    ];
    const s2 = graph.foldSession(withUsage);
    const g2 = graph.buildGraph({ leadId: 'L', leadName: 'lead', members: [], statsBySession: new Map([['L', s2]]), tasks: [] });
    assert.equal(g2.nodes[0].hasUsage, true, '收到过 usage 时必须 hasUsage=true');
    assert.equal(g2.nodes[0].usage.outputTokens, 50, 'outputTokens 要进桶');
    assert.equal(g2.nodes[0].usage.cacheReadTokens, 900, 'cacheReadTokens 要进桶');
    assert.equal(g2.totals.hasUsage, true, 'totals.hasUsage 必须同为 true');

    // 官方两层形状（{type:'chunk', chunk:{type:'usage', usage}}）也必须认。
    const twoLayer = [
      { type: 'assistant/message', data: { turn: 1, step: 1, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } } }] } },
    ];
    const s3 = graph.foldSession(twoLayer);
    const g3 = graph.buildGraph({ leadId: 'L', leadName: 'lead', members: [], statsBySession: new Map([['L', s3]]), tasks: [] });
    assert.equal(g3.nodes[0].hasUsage, true, '两层形状的 usage 也要认（否则回退成 undefined）');
    assert.equal(g3.nodes[0].usage.outputTokens, 3, '两层形状的 outputTokens 要进桶');
  });

  await check('dispatch-mode preset 必须把 tool-ask-user 设为 mode: timed（否则弹窗回答关不掉官方提问卡）', () => {
    // 用户 2026-10-10 报障：「我在弹窗里回答了问题，点发送后显示已回答，
    // 但退出工作区后官方页面仍显示等待我回答」。
    //
    // 根因（官方源码 + 真实会话复算）：
    //   官方 ask_user_question 有两条互不相通的路径，由工具 schema 是否声明
    //   `timeout` 决定（dsh-user-questions/lib/index.js:190 的 timed 判定）：
    //     * legacy（无 config 的默认）：:200 `if (!fold.timed || ...) return fold`
    //       —— 投影整条跳过，提问走 :681 `ctx.waterfall("user-questions/request")`，
    //       答案只能由持有该 waterfall 的一方给出（只存在于官方前端内存：
    //       dsh-client-ui-user-questions/lib/client.js:1927 + :1795）。
    //       宿主侧 `userQuestions.answer()` 于是 :554 找不到 → :555 return false
    //       ⇒ **插件根本无法关闭官方提问卡**。
    //     * timed（本 preset 的 config）：提问进投影记 continued，
    //       官方卡片自己的提交路径也变成 RPC（同文件 :396-405
    //       `#state === "continued" && rpc !== void 0 → rpc.answer(...)`），
    //       与插件走**同一条** userQuestions.answer ⇒ 弹窗回答能真正 settle。
    //
    // 实测判据（.probe/verify-timed-legacy-real.cjs）：本机 session-3cc0092d 的
    // request/header 里 ask_user_question 参数只有 ["questions"] ⇒ legacy。
    //
    // 这条闸门防止有人删掉 mode: timed 而无人察觉（症状是「弹窗说已回答、官方还在等」，
    // 从代码表面完全看不出来）。
    const yml = readFileSync(path.join(__dirname, '..', 'presets', 'dispatch-mode.patch.yml'), 'utf8');
    const at = yml.indexOf('- id: tool-ask-user');
    assert.ok(at >= 0, 'dispatch-mode preset 里找不到 tool-ask-user 行');
    // 取该行往后 8 行作为这个条目的块
    const block = yml.slice(at).split('\n').slice(0, 8).join('\n');
    assert.ok(/^\s*mode:\s*timed\s*$/m.test(block),
      'tool-ask-user 必须设 mode: timed —— 否则提问走 legacy waterfall，'
      + '插件（以及工作区弹窗）永远无法关闭官方提问卡，用户会看到「已回答但官方仍等待」');
    // 默认期限允许 -1（无限等）或正整数秒。2026-10-13 从 600 改成 -1：
    // 有限期限到期时返回 {"pending":true} ⇒ **模型在没有答案的情况下被放行**，
    // 用户之后的答案以另一条 user 消息在新回合送达 —— 对「没答复不能往下走」的
    // 分轮面试就是「会话断了」。实测本机 4 个会话真出现过 pending。
    assert.ok(/^\s*timeout:\s*(-1|\d+)\s*$/m.test(block),
      'mode: timed 必须同时给一个默认 timeout（-1 无限等，或正整数秒），否则官方按未配置处理');
    assert.ok(/^\s*timeout:\s*-1\s*$/m.test(block),
      '默认 timeout 必须是 -1：有限期限到期会把模型放行（pending），会话就断了');
  });

  await check('增量折叠游标：必须推进到「连续可读」的位置，不能按条数、也不能按 session.seq', () => {
    // ── 用户 2026-10-10 报障「工作区没有实时更新」的根因之一（P1）────────────────
    // 活体增量折叠用 `consumedSeq` 当游标，而 `session.seq`（已分配序号）与
    // `eventAt(seq)`（已落盘日志）在写入过程中会短暂不一致 —— 空洞（undefined）。
    // 三种推进口径的后果实测（模拟 seq 0..9、3/4 缺失、第 2 轮后补齐）：
    //   * `consumedSeq += events.length`（**旧实现**）：游标与 seq 空间累积偏差 ⇒
    //     空洞在**中间**时游标落后 ⇒ 同一批事件被反复折叠（token/时长/TODO 重复累加）。
    //     实测：seq 3/4 缺失时第一轮得 8 条 → 游标 0→8 而真实已扫到 9 ⇒ 下一轮重折 seq 8。
    //   * `consumedSeq = session.seq`：空洞被**永久跳过** ⇒ 后补落盘的事件再也读不到。
    //     实测：漏掉 2 条 ⇒ outputTokens 少算 200（800 而非 1000）。
    //   * `consumedSeq = safeUntil`（**现实现**）：只推进到连续读到处 ⇒ 两种场景都正确。
    //
    // 这条闸门用「中间有空洞 + 后补落盘」的真实场景钉住现实现的行为。
    const mk = (seq) => ({
      type: 'assistant/message', seq, time: 1000 + seq,
      data: { turn: seq, step: 1, usage: { inputTokens: 0, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    });
    const END = 10;
    const store = new Map();
    for (let i = 0; i < END; i += 1) { if (i === 3 || i === 4) continue; store.set(i, mk(i)) }

    // 复刻现实现的口径（safeUntil）
    const readSafe = (from) => {
      const out = [];
      let safeUntil = from;
      for (let seq = from; seq < END; seq += 1) {
        const e = store.get(seq);
        if (e === undefined) break;
        out.push(e);
        safeUntil = seq + 1;
      }
      return { events: out, safeUntil };
    };
    const stats = graph.emptyStats();
    let cursor = 0;
    for (let round = 1; round <= 4; round += 1) {
      const { events, safeUntil } = readSafe(cursor);
      graph.foldEvents(stats, events);
      if (safeUntil > cursor) cursor = safeUntil;
      if (round === 2) for (let i = 0; i < END; i += 1) if (!store.has(i)) store.set(i, mk(i));
    }
    assert.equal(cursor, END, `游标最终应推进到 ${END}，实际 ${cursor}`);
    assert.equal(stats.usage.outputTokens, END * 100,
      `中间有空洞时不能漏读也不能重复折叠：期望 ${END * 100}，实际 ${stats.usage.outputTokens}`);

    // 反例 1：按条数推进（旧实现）在有空洞且空洞在**中间**时游标落后 ⇒ 同一事件被折叠两次。
    // ⚠️ 判据必须用「同一 seq 的事件被折了几次」，不能看 outputTokens 是否变大 ——
    //    foldEvents 对同 turn/step 是 **last-wins 替换**语义，重复折叠不会累加（反而会抵消）。
    //    所以这里直接数「同一 seq 被喂进 foldEvents 的次数」。
    {
      const s2 = new Map();
      for (let i = 0; i < END; i += 1) { if (i === 5) continue; s2.set(i, mk(i)) } // 空洞在中间（seq 5）
      const readByLength = (from) => {
        const out = []
        for (let seq = from; seq < END; seq += 1) { const e = s2.get(seq); if (e !== undefined) out.push(e) }
        return out
      }
      const seenByLength = new Map()
      let cur = 0
      for (let round = 1; round <= 3; round += 1) {
        const evs = readByLength(cur)
        for (const e of evs) seenByLength.set(e.seq, (seenByLength.get(e.seq) ?? 0) + 1)
        cur += evs.length   // 旧口径
      }
      const dup = [...seenByLength.entries()].filter(([, n]) => n > 1).map(([seq, n]) => `seq${seq}×${n}`)
      assert.ok(dup.length > 0,
        `旧口径（+= events.length）在空洞位于中间时应当把后续事件**重复读入**（这正是要修掉的 bug）；`
        + `实际没有任何重复：${JSON.stringify([...seenByLength.entries()])}`)
    }

    // 反例 2：按 session.seq 推进会永久跳过空洞 —— 用「同一 seq 被读到的次数」判据：
    // 空洞（seq 3/4）永远读不到 ⇒ 它们从未进入折叠。
    {
      const s3 = new Map();
      for (let i = 0; i < END; i += 1) { if (i === 3 || i === 4) continue; s3.set(i, mk(i)) }
      const readToEnd = (from) => {
        const out = []
        for (let seq = from; seq < END; seq += 1) { const e = s3.get(seq); if (e !== undefined) out.push(e) }
        return out
      }
      const seen = new Set()
      let cur = 0
      for (let round = 1; round <= 3; round += 1) {
        for (const e of readToEnd(cur)) seen.add(e.seq)
        cur = END   // 旧口径 2
        if (round === 1) for (let i = 0; i < END; i += 1) if (!s3.has(i)) s3.set(i, mk(i))
      }
      assert.ok(!seen.has(3) || !seen.has(4),
        `按 session.seq 推进应当**永久跳过**空洞（这正是不能采用它的原因）；`
        + `实际读到的 seq：${JSON.stringify([...seen].sort((a, b) => a - b))}`)
    }
  });

  await check('托管块自愈：lib/self-heal.js 与 tools/repair.cjs 的常量必须逐字一致', () => {
    // 用户 2026-10-10 的事故：他做的插件让 DSH 崩溃，重启时选「关闭所有插件并重启」，
    // 那个流程重置了 profile 的 cordis.patch.yml ⇒ 本插件的托管块（关掉官方
    // tool-agent-team 行 + agent-team 容量 48）整段消失 ⇒ 官方九个团队工具与本插件
    // 同名冲突（tool "spawn_teammate" is already registered in this scope）、
    // 界面显示「Team 暂不可用」。
    // 修法：插件启动时自愈（lib/self-heal.js 的 healManagedBlock）。
    //
    // 这条闸门守**两份定义的一致性**：自愈写进去的块必须与 repair.cjs 期望的完全相同，
    // 否则会出现「自愈说修好了、repair --check 仍报缺」这种自相矛盾的状态。
    const healSrc = readFileSync(path.join(__dirname, '..', 'lib', 'self-heal.js'), 'utf8');
    const repairSrc = readFileSync(path.join(__dirname, 'repair.cjs'), 'utf8');
    const markerRe = /const MANAGED_(START|END) = '([^']+)'/g;
    const fromHeal = {};
    const fromRepair = {};
    for (const m of healSrc.matchAll(markerRe)) fromHeal[m[1]] = m[2];
    for (const m of repairSrc.matchAll(markerRe)) fromRepair[m[1]] = m[2];
    assert.equal(fromHeal.START, fromRepair.START, 'MANAGED_START 两份定义不一致');
    assert.equal(fromHeal.END, fromRepair.END, 'MANAGED_END 两份定义不一致');
    for (const key of ['maxMembers', 'maxTasks', 'maxPendingMessagesPerMember', 'maxMessageBytes', 'disposalTimeoutMs']) {
      const inRepair = new RegExp(key + ':\\s*(\\d+)').exec(repairSrc);
      const inHeal = new RegExp(key + ':\\s*(\\d+)').exec(healSrc);
      assert.ok(inRepair !== null, `repair.cjs 里找不到 ${key}`);
      assert.ok(inHeal !== null, `self-heal.js 里找不到 ${key}`);
      assert.equal(inHeal[1], inRepair[1], `${key} 两份定义不一致（repair=${inRepair[1]} self-heal=${inHeal[1]}）`);
    }
    assert.ok(healSrc.includes('- id: tool-agent-team') && healSrc.includes('disabled: true'),
      'self-heal.js 的托管块必须包含「关掉官方 tool-agent-team 行」');
    const indexSrc = readFileSync(path.join(__dirname, '..', 'lib', 'index.js'), 'utf8');
    assert.ok(indexSrc.includes('healManagedBlock'), 'lib/index.js 必须调用 healManagedBlock（否则自愈形同虚设）');
  });

  await check('dsh-ops 原生链接（2026-10-15 改版）：内嵌 ops 已删干净，且本包不含任何改 ops 源码的东西', () => {
    // 用户 2026-10-15 的要求：不再内嵌 —— 两插件各自安装各自启用，本包检测到 ops 就用它的工具。
    // 闸门两头都要盯：① 旧内嵌形态的任何残留（vendor/ops-file/ops-coexist）不得复活；
    // ② 新适配层（lib/ops-adapter.js + tools/ops-enable.cjs + tools/ops-mount-check.mjs）齐备且接线；
    const patch = readFileSync(path.join(__dirname, '..', 'cordis.patch.yml'), 'utf8');
    assert.ok(!/^-\s*id:\s*ops-file\s*$/m.test(patch) && !/dsh-dispatch-agent-team\/ops-file/.test(patch),
      'cordis.patch.yml 不得再有本包自带的 ops-file 组件行（内嵌已按用户要求删除）');
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.equal(pkg.exports?.['./ops-file'], undefined, 'package.json 不得再有 ./ops-file 导出（vendor 入口）');
    assert.ok(!pkg.files?.includes('vendor'), 'package.json files 不得再含 vendor');
    assert.ok(!existsSync(path.join(__dirname, '..', 'vendor')), 'vendor/ 目录必须已删除');
    assert.ok(!existsSync(path.join(__dirname, '..', 'lib', 'ops-coexist.js')), 'lib/ops-coexist.js 必须已删除（钉 dsh-ops-file 的旧自愈，留着会把真 ops 的 file 组件误关）');

    // ② 适配层：检测 + 队员链接，四组件与 11 个公开工具名逐名对齐 ops 0.3.0。
    const adapterSrc = readFileSync(path.join(__dirname, '..', 'lib', 'ops-adapter.js'), 'utf8');
    assert.ok(adapterSrc.includes('export function detectOpsComponents'), 'ops-adapter 必须导出 detectOpsComponents（体检）');
    assert.ok(adapterSrc.includes('export function linkOpsForMember'), 'ops-adapter 必须导出 linkOpsForMember（队员链接）');
    for (const id of ['dsh-ops-shell', 'dsh-ops-file', 'dsh-ops-background', 'dsh-ops-ptc']) {
      assert.ok(adapterSrc.includes("id: '" + id + "', component:"), 'ops-adapter 的 OPS_ROWS 必须覆盖 ' + id);
    }
    for (const tool of ['ops_inspect_local_file', 'ops_grep', 'ops_glob', 'ops_replace', 'ops_bash',
      'ops_run_background', 'ops_job_output', 'ops_job_list', 'ops_job_kill', 'ops_batch', 'ops_result']) {
      assert.ok(adapterSrc.includes("'" + tool + "'"), 'ops-adapter 的 OPS_TOOL_NAMES 必须含 ' + tool);
    }
    // 文案真实性闸门（2026-10-16 第二轮真机，researcher-ops2 自己抓出来的）：
    // 旧文案写「与宿主工具同级，放心直调」，但纯 PTC 档队员**直调任何 ops_* 一律被拒**
    // （实测原文：unknown tool "ops_glob": only run_code is callable directly）。它据此把
    // 「提示词与实际行为不一致」列成未决项 —— 那是我们自己的文案在骗模型。
    // 所以这里钉住：不许再出现「放心直调」这类无条件直调的说法，且必须含档无关的自查指引。
    assert.ok(!adapterSrc.includes('放心直调'),
      'ops 指引段又出现无条件的「放心直调」（纯 PTC 档直调会被拒，这句在骗模型）');
    // 文案真实性闸门第二弹（2026-10-16 真机 session-3c654f6e + 本会话对照实验）：
    // 上一版写「返回开头常另起一行 (Background: …) 通知（报告其它已结束/在跑的任务，本轮实测 5 次皆有）」。
    // 对照实验证伪了它：只起一个任务时**没有**这一行（R1 原文 = "(Complete: job j-lhvnbs started; …)"），
    // 第二个任务在跑时才出现（R2 开头 "(Background: j-lhvnbs running 0s.)"）。
    // scout-qa 那轮 5 次都是单任务，返回里就没有 Background 行 —— 它照抄原文时如实报了没有，
    // 而我们的文案在骗模型「开头常另起一行」。「5 次皆有」那句话还是我从**别的**一轮的观测搬过来的，
    // 搬来时没在本轮复核：本轮 2.3 只跑了一次 ops_run_background。
    assert.ok(!adapterSrc.includes('5 次皆有') && !adapterSrc.includes('常另起一行'),
      'ops 指引段又出现「(Background:) 开头常另起一行 / 5 次皆有」这种无条件断言（对照实验：单任务时那行不存在）');
    // 而且我**第一版修正本身也是错的**（写成「只有当本会话还有别的任务在跑时」）。
    // 同一条会话里后来起的第三次调用打出 (Background: j-lhvnbs exited 0, j-djf7lx exited 0.)
    // —— 那两个任务**都已经结束了**。ops 自己的 jobs.js:21-29 也是按「本会话拥有过的 job」筛
    // （ENTRY 正则同时认 running / exited / killed / interrupted），不是只认在跑的。
    // 所以判据锁这两句：出现条件 = 本会话此前有过别的任务（在跑或已结束都算），且首个任务没有这行。
    assert.ok(adapterSrc.includes('此前有过别的任务') && adapterSrc.includes('在跑的或已结束的都算') && adapterSrc.includes('没有这一行'),
      'ops 指引段对 (Background:) 行的判据必须是「本会话此前有过别的任务（在跑或已结束都算）」+「首个任务没有这一行」；「只在还有任务在跑时出现」是我犯过的第二个错');
    assert.ok(!adapterSrc.includes('还有别的任务在跑'),
      'ops 指引段又回到「只有当本会话还有别的任务在跑」这个错的中间版（实测已结束的任务同样进 Background 行）');
    assert.ok(adapterSrc.includes('只有 run_code') && adapterSrc.includes('别因为直调被拒就判定通路不通'),
      'ops 指引段缺少「纯 PTC 档直调被拒是正常的」这条自查（两名队员共用同一段，必须档无关）');
    // 这段必须对所有队员逐字节相同（共享前缀纪律）：不得含角色名/队员身份插值。    // 队员指引段必须与具体队员无关（共享前缀纪律）：文本里不得出现角色/名字插值。
    assert.ok(adapterSrc.includes("name: OPS_LINK_SECTION") && adapterSrc.includes('OPS_LINK_ORDER'),
      'linkOpsForMember 必须注册 dispatch:ops-link 段');

    const indexSrc = readFileSync(path.join(__dirname, '..', 'lib', 'index.js'), 'utf8');
    assert.ok(indexSrc.includes("from './ops-adapter.js'"), 'lib/index.js 必须 import ops-adapter');
    assert.ok(/detectOpsComponents\(ctx, void 0, false\)/.test(indexSrc), 'lib/index.js 启动期必须做 ops 组件检测（Lead 作用域 + purePtc=false）');
    assert.ok(!indexSrc.includes('healOpsCoexist'), 'lib/index.js 不得再调用 healOpsCoexist（旧共存自愈）');
    assert.ok(indexSrc.includes('status.opsIntegration = detectOpsComponents('), 'writeStatusFile 必须落盘 opsIntegration（状态文件是唯一真值来源）');
    // 告警判据必须由**调用方按该作用域的呈现档**给，不许 detectOpsComponents 自己凭可见性猜：
    // 猜了就会给 Lead（原生档）和 both 队员（批量档）误报「拿不到 ops_batch 需要处理」，而那是设计使然。
    // 2026-10-21：判据从 mounted 改成 **liveMounted**（剔除 0.3.2 已移除的 background 组件）。
    // 断言的**意图**不变：missingPtc 必须由调用方给的呈现档决定，不许凭可见性猜。
    assert.ok(/purePtc === true && liveMounted\.includes\('ptc'\)/.test(adapterSrc),
      'ops-adapter 的 missingPtc 必须以 purePtc === true 为前提（否则按可见性误报）');
    assert.ok(/OPS_REMOVED_COMPONENTS/.test(adapterSrc),
      'ops-adapter 必须知道 dsh-ops 0.3.2 已移除 background 组件（否则会报假的缺失）');
    assert.ok(/!purePtc && mounted\.includes\('ptc'\)/.test(adapterSrc) === false,
      'ops-adapter 里不得出现引用未定义变量 mounted 的判据（linkOpsForMember 作用域只有 probe.mounted）');
    assert.ok(/probe\.mounted\.includes\('ptc'\)/.test(adapterSrc),
      'linkOpsForMember 的非纯 PTC 档记录必须走 probe.mounted（作用域内真值）');
    const runtimeSrc = readFileSync(path.join(__dirname, '..', 'lib', 'runtime.js'), 'utf8');
    assert.ok(runtimeSrc.includes('linkOpsForMember(ctx, scoped, agent, notes, disposers, purePtc)'),
      'installMember 必须给每名队员接 ops 链接**并传实测呈现档**（Lead 不接：那是用户主会话，ops 自己全局可见）');
    assert.ok(/const purePtc = !batchDeclared && resolveRolePreset\(peekConfig\(\), role\) === 'ptc';/.test(runtimeSrc),
      'purePtc 必须由「本层没声明成 both」+「该角色预设是 ptc」两件事共同决定（不能只看预设：both 会压住 ptc 档）');
    assert.ok(/const batchDeclared = applyMemberBatch\(ctx, agent, role, notes, disposers\) === true;/.test(runtimeSrc),
      'applyMemberBatch 的返回值必须被接住（both 是否真声明成功是 purePtc 的前提）');
    // 2026-10-16 真机 P0（researcher-ops 白跑一轮 + 每步翻转）：预设 ptc + 关批量的队员，
    // 必须在**自己那层同步** presentAs('ptc')。只靠异步预设重绑会带来两个后果：第一次请求跑在
    // 继承来的 native 组合上；而且实测不是「晚一次」而是**每步翻转**（native→ptc→native→ptc）。
    // 对照证据：scout-ops（批量开着，本包同步声明 both）逐请求是 both→both 稳定；
    // researcher-ops（本包什么都没声明）是 native(76)→ptc(1)→native(76)→ptc(1)。
    // 差别就在「自己那层有没有钉住」—— 所以这里钉住源码形状。
    const dmAt = runtimeSrc.indexOf('function declareMemberMode');
    assert.ok(dmAt >= 0, 'runtime.js 必须有 declareMemberMode（纯 PTC 档的同步声明口）');
    const dmBody = runtimeSrc.slice(dmAt, dmAt + 2200);
    assert.ok(/pick\(ctx, 'ptcRuntime'\) === undefined/.test(dmBody) && /presentAs\(mode\)/.test(dmBody),
      'declareMemberMode 必须先探 ptcRuntime 再声明：modeFor 解析成 ptc 时装配会走 requirePtcRuntime（dsh-tools:2863-2865），拿不到就抛 —— 那会让这名队员每一次请求都失败');
    const branchRe = /if \(resolveRolePreset\(peekConfig\(\), role\) === 'ptc'\) declareMemberMode\(ctx, agent, 'ptc', who, notes, disposers\);/;
    assert.ok(branchRe.test(runtimeSrc),
      'applyMemberBatch 关掉批量的那一支必须给预设 ptc 的队员同步声明 ptc 档（否则第一次请求跑在旧组合上 = 真机那个 P0）');
    const batchBodyStart = runtimeSrc.indexOf('批量调用（both）已开启');
    assert.ok(batchBodyStart >= 0 && runtimeSrc.slice(batchBodyStart, batchBodyStart + 500).includes('return true;'),
      'applyMemberBatch 成功路径必须 return true（purePtc 判据依赖这个返回值）');

    // ②c 队员 model 显示链路（2026-10-16 session-3c654f6e P1 的形状闸门）：
    //     runtime 必须在**真的把覆盖写进请求对象之后**才记账（记早了会把「解析出但没采用」的写进去），
    //     list_agents 必须消费这份账（否则 Lead 拿到的还是继承来的模型 = 错数据）。
    const rtForModel = runtimeSrc;
    const ioAt = rtForModel.indexOf('function installRouteOverride');
    assert.ok(ioAt >= 0, 'runtime.js 必须有 installRouteOverride');
    const ioBody = rtForModel.slice(ioAt, ioAt + 3600);
    assert.ok(ioBody.includes('noteAppliedRoute(agent.id,'), 'installRouteOverride 必须经唯一写入点记路由（不许散写 appliedRoutes.set）');
    assert.ok(ioBody.indexOf('noteAppliedRoute(agent.id,') < ioBody.indexOf('return override;'),
      '记账必须在 return override 之前、且在覆盖真的合进请求对象之后（catch 分支里不许记 = 宁缺毋滥）');
    assert.ok(!/catch[\s\S]{0,240}noteAppliedRoute/.test(ioBody),
      'catch 分支（覆盖失败退回原配置）里不许记路由：记了就是把没用上的东西报成用过');
    assert.ok(/export function noteAppliedRoute\(agentId, route\)/.test(rtForModel), '必须有唯一写入点 noteAppliedRoute');
    assert.ok(/export function clearAppliedRoute\(agentId\)/.test(rtForModel), '必须有唯一作废点 clearAppliedRoute');
    assert.ok(!/function installRouteOverride[\s\S]{0,3000}appliedRoutes\.set/.test(rtForModel),
      'installRouteOverride 里不许绕过写入点直接 set 账本');
    // 2026-10-17 更正：旧断言要求 disposeInstalled **必须**清掉路由账本 —— 那条断言本身是错的。
    // 真机 session-d7eb7e28 实测：可续期子代理每轮结束都触发 agent/disposed，清了账本之后
    // list_agents 对 inactive 队员退回「继承自 Lead 的模型」（同一次调用里 running 的对、inactive 的全错）。
    // 现在的要求反过来：**不许**在 disposeInstalled 里清，只允许在插件整体卸载（disposeAll）时清。
    const disposeBody = rtForModel.slice(rtForModel.indexOf('function disposeInstalled'), rtForModel.indexOf('function disposeInstalled') + 1200);
    assert.ok(!disposeBody.includes('clearAppliedRoute('),
      'disposeInstalled 不许清路由账本：可续期子代理每轮结束都触发 agent/disposed，清了就会让 list_agents 对已结束的队员报回继承模型（2026-10-17 真机 P1）');
    assert.ok(rtForModel.includes('appliedRoutes.clear()'), 'disposeAll 必须清空记账（插件整体卸载时才回收）');
    assert.ok(rtForModel.includes('appliedRoutes.clear()'), 'disposeAll 必须清空记账');
    assert.ok(/export function appliedMemberRoutes\(\) \{/ .test(rtForModel), 'runtime 必须导出 appliedMemberRoutes()');
    // ── 2026-10-17 更正：账本必须在「队员结束」之后仍然存在 ──────────────────────
    // 起因（真机 session-d7eb7e28）：可续期子代理每轮结束都会触发 agent/disposed
    // （官方 dsh-subagent 的 finishDisposal 结算后调 activation.handle.dispose()，
    //  dsh-agent 的 detachEntered 随即 emit agent/disposed），于是 disposeInstalled 被调用。
    // 旧实现里它 clearAppliedRoute —— 结果 list_agents 对**已结束**的队员退回继承模型：
    // 实测同一次 list_agents 里 running 的 builder/verify = step-5-preview（对），
    // inactive 的 researcher = deepseek-v4.1-flash（= Lead 的模型，错）。
    assert.ok(/appliedMemberRoutes,\n/.test(rtForModel), 'appliedMemberRoutes 必须进 runtimeApi');
    const toolsSrc = readFileSync(path.join(__dirname, '..', 'lib', 'tools.js'), 'utf8');
    assert.ok(toolsSrc.includes("annotateMemberModels(withRetries, runtime?.appliedMemberRoutes?.() ?? new Map())"),
      'list_agents 必须消费 appliedMemberRoutes（不接 = Lead 继续看到继承模型）');
    assert.ok(!/model:\s*\{[^\n]*required/.test(toolsSrc.split('MEMBER_VIEW_SCHEMA')[1]?.slice(0, 1200) ?? ''),
      '不许把 model 变成必填字段（那是改 Lead 的工具目录）');

    // ②a 纪律闸门（用户 2026-10-15 明令「别改 ops 的源码」）：本仓库不得再出现任何
    //     修改 dsh-ops 包内文件的工具、判据字面或备份痕迹。适配只能发生在本包这一侧。
    const repoFiles = [];
    (function collect(dir, depth) {
      if (depth > 3) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', '.probe-tmp', '%SystemDrive%', 'NVIDIA Corporation'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { collect(full, depth + 1); continue; }
        if (/\.(js|cjs|mjs|json|yml|md)$/.test(entry.name)) repoFiles.push(full);
      }
    })(path.join(__dirname, '..'), 0);
    // needle 用拼接写：这个闸门文件本身不该被自己的字面量命中。
    const FORBIDDEN = ['ops' + '-ptc-both', 'ptc' + 'Presentation', 'pre-' + 'ptc-both'];
    const offenders = [];
    for (const file of repoFiles) {
      const text = readFileSync(file, 'utf8');
      for (const needle of FORBIDDEN) {
        if (text.includes(needle)) offenders.push(path.relative(path.join(__dirname, '..'), file) + ' 含 ' + needle);
      }
    }
    assert.deepEqual(offenders, [], '本仓库不得含修改 dsh-ops 源码的东西（适配只在本包这一侧）：' + offenders.join(' ; '));
    // ②b profile 启用工具：四行钉 disabled:false，且 drift-check 复用它的 plan()（单一真值）。
    const enableSrc = readFileSync(path.join(__dirname, '..', 'tools', 'ops-enable.cjs'), 'utf8');
    assert.ok(enableSrc.includes('module.exports = { plan, splitRows'), 'ops-enable.cjs 必须导出 plan/splitRows（drift-check 要复用同一份判据）');
    for (const id of ['dsh-ops-shell', 'dsh-ops-file', 'dsh-ops-background', 'dsh-ops-ptc']) {
      assert.ok(enableSrc.includes("id: '" + id + "'"), 'ops-enable 的 ROWS 必须覆盖 ' + id);
    }
    assert.ok(enableSrc.includes('--revert') && enableSrc.includes('pre-ops-enable'), 'ops-enable 必须可还原且写前备份');
    // 迁移标记（P1）：ops 的 updatedConfig 会把无标记行的 allowSystemShellFallback 翻成 false 并写回。
    const enableRows = enableSrc.slice(enableSrc.indexOf('const ROWS = ['));
    const rowBlockOf = (id) => { const at = enableRows.indexOf("id: '" + id + "'"); return at < 0 ? '' : enableRows.slice(at, at + 600); };
    // 2026-10-21 改判据：MARKER 的**值**不再写死 1，而是从装机 dsh-ops 的
    // lib/config-updates.js 读 CONFIG_UPDATE_VERSION（0.3.2 已是 2）。
    // 原来这里断言字面量 `configUpdateVersion: 1` —— 那条断言本身就是在保护那个 bug：
    // 它逼着实现写死 1，于是 ops 升到 2 之后本脚本会把用户的**已迁移**配置降级写回 1。
    assert.ok(enableSrc.includes('CONFIG_UPDATE_VERSION') && enableSrc.includes('detectConfigVersion'),
      'ops-enable 必须从装机 dsh-ops 读 CONFIG_UPDATE_VERSION（不许写死迁移版本号）');
    assert.ok(!/configUpdateVersion: 1'/u.test(enableSrc),
      'ops-enable 里又出现了写死的 configUpdateVersion: 1（上游升到 2 时会把用户配置降级）');
    // shell / file 两行要带标记；background **不许带**（0.3.2 的 config-updates.js:22 明写
    // 「`dsh-ops/background` is a no-op stub that reads no config, so it needs no migration」）。
    for (const id of ['dsh-ops-shell', 'dsh-ops-file']) {
      const block = rowBlockOf(id);
      assert.ok(block.includes('MARKER,'),
        'ops-enable 的 ' + id + ' 行必须带迁移标记（否则 ops 迁移会改写这一行）');
    }
    assert.ok(!rowBlockOf('dsh-ops-background').includes('MARKER,'),
      '背景行不许带迁移标记：0.3.2 已移除该组件，它不读任何配置，标记只会制造假缺失');
    assert.ok(!rowBlockOf('dsh-ops-ptc').slice(0, 300).includes('configUpdateVersion'), 'ops-enable 的 ptc 行不得带 configUpdateVersion（resolvePtcConfig 会抛 Unknown PTC config key）');
    assert.ok(rowBlockOf('dsh-ops-background').includes('allowSystemShellFallback: true'), 'ops-enable 的 background 行必须 allowSystemShellFallback: true（job 工具的发布门）');
    const driftSrc = readFileSync(path.join(__dirname, '..', 'tools', 'drift-check.cjs'), 'utf8');
    assert.ok(driftSrc.includes("require('./ops-enable.cjs')"), 'drift-check 必须复用 ops-enable 的 plan()（两处各写一份正则就会各自漂）');
    for (const listFile of ['repair.cjs', 'sync-to-dsh.cjs']) {
      const listSrc = readFileSync(path.join(__dirname, '..', 'tools', listFile), 'utf8');
      assert.ok(listSrc.includes("'tools/ops-enable.cjs'"), listFile + ' 的文件清单必须含 ops-enable.cjs（漏了 = 装到别人机器上没这条修复命令）');
      assert.ok(!listSrc.includes("'lib/ops-coexist.js'"), listFile + ' 不得再列已删除的 ops-coexist.js');
      assert.ok(listSrc.includes("'tools/ops-mount-check.mjs'"), listFile + ' 的文件清单必须含 ops-mount-check.mjs（离线验收工具要能随包分发）');
    }
  });
  await check('ops-adapter 的 profile 退回链必须有 .dsh 那一段（2026-10-16 真机 P1 回归闸门）', async () => {
    // 真机抓出来的过程：状态文件里四个 dsh-ops 组件行都 phase:2 挂着，但 opsIntegration.package = null。
    // 上一版 profileDirs()：`const home = process.env.DSH_HOME ?? homedir()` 然后 join(home,'profiles','desktop')
    // —— 宿主 Electron 进程**没设 DSH_HOME**，于是 base = C:\Users\ZWS，去看 C:\Users\ZWS\profiles\desktop
    // （不存在）→ 判成「没装 dsh-ops」→ linkOpsForMember 提前返回 → **每个队员都收不到 ops 指引段**。
    // 规矩本身早就写在 tools/lib-dsh-home.cjs:34-53（2026-10-04 审查 P1-7，同一类 bug 在 tools 侧修过），
    // 这次是 lib 侧另写一份、把它漂掉了。测试当时只用 DSH_PROFILE_DIR 注入假目录，从不走退回链 → 闸门全绿。
    const mod = await load('ops-adapter.js');
    const probeHome = path.join(process.platform === 'win32' ? 'C:\\' : '/', 'FakeHomeForGate');
    const dirs = mod.profileDirs({}, probeHome);
    assert.ok(dirs.includes(path.join(probeHome, '.dsh', 'profiles', 'desktop')),
      '空 env 必须退回 <homedir>/.dsh/profiles/desktop（少 .dsh 就是真机那个 P1）：' + JSON.stringify(dirs));
    assert.ok(dirs.includes(path.join(probeHome, '.dsh', 'profiles', 'web')), '也要覆盖 web profile：' + JSON.stringify(dirs));
    assert.ok(!dirs.includes(path.join(probeHome, 'profiles', 'desktop')),
      '又生成 <homedir>/profiles/desktop 了（P1 复发：少了 .dsh 段）：' + JSON.stringify(dirs));
    assert.deepStrictEqual(mod.profileDirs({ DSH_HOME: 'D:\\altHome' }, probeHome),
      [path.join('D:\\altHome', 'profiles', 'desktop'), path.join('D:\\altHome', 'profiles', 'web')],
      'DSH_HOME 是**主目录本身**：不得再补 .dsh，也不得被 homedir 顶掉');
    assert.strictEqual(mod.profileDirs({ DSH_PROFILE_DIR: '   ' }, probeHome)[0],
      path.join(probeHome, '.dsh', 'profiles', 'desktop'), '空白 DSH_PROFILE_DIR 要当没给');
    assert.strictEqual(mod.profileDirs({ DSH_PROFILE_DIR: 'X:\\p' }, probeHome)[0], 'X:\\p',
      '显式 DSH_PROFILE_DIR 必须排第一');
    // lib 与 tools 两侧必须是同一条规矩（这次漂的就是 lib 那份）
    const dshHome = require(path.join(__dirname, 'lib-dsh-home.cjs'));
    // 注意 lib-dsh-home.cjs:34/:47 的 homedir 形参是**主目录字符串**（默认值才是 os.homedir()），不是函数。
    assert.strictEqual(dshHome.resolveProfileDir({ env: {}, homedir: probeHome }).profileDir,
      path.join(probeHome, '.dsh', 'profiles', 'desktop'),
      'tools/lib-dsh-home.cjs 的退回链与 profileDirs 不一致（同一台机器两套答案就是这次的 P1）');
    // 真机事实（**按本机安装情况分流，别让没装 ops 的机器假红**）：清掉两个 env、只给真实主目录。
    // 用户 2026-10-15 的前提是「别人下载本插件，有无 ops 都要能跑」，所以这条只能是条件断言：
    //   装了 → 必须解析到（这正是宿主进程的真实条件，也是这次 P1 的现场）；
    //   没装 → 必须返回 null（零影响的另一头）。
    const realHome = os.homedir();
    const installedSomewhere = ['desktop', 'web'].some((profile) => existsSync(
      path.join(realHome, '.dsh', 'profiles', profile, 'node_modules', 'dsh-ops', 'package.json')));
    const real = mod.resolveOpsPackage({}, realHome);
    if (installedSomewhere) {
      assert.ok(real !== null && real.installed === true && /^\d+\.\d+\.\d+/.test(String(real.version)),
        '本机装了 dsh-ops，但空 env 的退回链没解析到它（就是 2026-10-16 那个 P1）：' + JSON.stringify(real));
    } else {
      assert.strictEqual(real, null, '本机没装 dsh-ops 却解析出了包（凭空捏造在场）：' + JSON.stringify(real));
      envSkipped += 0; // 这一支照常通过：它就是「无 ops」那半边的正解
    }
    assert.strictEqual(mod.resolveOpsPackage({}, path.join(probeHome, 'NoSuchUserDir')), null,
      '主目录不存在时必须如实返回 null（不许假装装着）');
  });
  await check('托管块结构（2026-10-10 P0）：块必须在文件开头，且切片重写不得吞掉哨兵区内的外来行', async () => {
    // 用户 2026-10-10 报障的根因（已用真实 profile 复现）：托管块原本 append 在**文件末尾**，
    // 而宿主 dsh-plugin-manager 切换插件组件时用 YAML AST 的 document.add() 追加新行 ——
    // add() 落在**最后一个序列项之后、尾部注释之前**，也就是**哨兵区内部**。
    // 随后 --apply/--revert 的整段切片把 permission(325-338) / llm-pi-ai(339-351) 一起删掉
    // （实测 16623 → 15096 字节，dsh-permission-presets / JIYUAN_API_KEY 全没了），
    // 而体检两条正则都通过、self-heal 只查 includes(MANAGED_START) ⇒ 谁都没发现。
    //
    // 本闸门用**真代码**（self-heal.js 的导出）跑四个行为断言，任一条退化即红：
    //   ① 块在末尾的文本判为不健康；② 归一化把块搬到开头；
    //   ③ 哨兵区内的外来行在归一化后**必须还在**；④ 归一化幂等（第二次完全不变）。
    const heal = await import(pathToFileURL(path.join(LIB, 'self-heal.js')).href);
    const { MANAGED_START, MANAGED_END } = heal;
    assert.equal(typeof heal.managedBlockHealthy, 'function', 'self-heal.js 必须导出 managedBlockHealthy');
    assert.equal(typeof heal.normalizeManagedBlock, 'function', 'self-heal.js 必须导出 normalizeManagedBlock');

    // 造一份「块在末尾 + 区内混入外来行」的文本（复刻用户现场的最小形状）。
    const foreign = ['- id: permission', '  name: "@deepseek-ai/dsh-permission-presets"', '',
      '- id: llm-pi-ai', '  name: "@deepseek-ai/dsh-llm-pi-ai"', '  config:', '    apiKeyEnv: JIYUAN_API_KEY'];
    const blockAtEnd = [
      '# profile head comment',
      '- id: ui-settings',
      '  config:',
      '    enabled: true',
      '',
      MANAGED_START,
      '- id: tool-agent-team',
      '  disabled: true',
      '',
      '- id: agent-team',
      '  config:',
      '    maxMembers: 48',
      ...foreign,
      MANAGED_END,
    ].join('\n');

    assert.equal(heal.managedBlockHealthy(blockAtEnd), false,
      '块写在文件末尾必须判为不健康（否则宿主 AST 追加会再次把外来行塞进哨兵区）');

    const fixed = heal.normalizeManagedBlock(blockAtEnd);
    assert.equal(heal.managedBlockHealthy(fixed), true, '归一化后必须健康');
    // ① 块在文件开头：MANAGED_START 必须出现在第一个顶层条目之前。
    const firstRow = fixed.split('\n').findIndex((line) => /^-\s*(?:id:|insert:)/u.test(line));
    const startLine = fixed.split('\n').findIndex((line) => line === MANAGED_START);
    assert.ok(startLine >= 0 && startLine < firstRow,
      `托管块必须排在第一个顶层条目之前（块在第 ${startLine + 1} 行、首个条目在第 ${firstRow + 1} 行）`);
    // ② 哨兵区内只允许本插件那两条。
    const bodyStart = fixed.indexOf(MANAGED_START) + MANAGED_START.length;
    const bodyEnd = fixed.indexOf(MANAGED_END);
    const inside = [...fixed.slice(bodyStart, bodyEnd).matchAll(/^-\s*id:\s*(\S+)/gmu)].map((m) => m[1]);
    assert.deepEqual(inside, ['tool-agent-team', 'agent-team'],
      `哨兵区内只应有本插件两条行，实际：${inside.join(', ')}`);
    // ③ 外来行一条都不能丢（这是本次 P0 的核心）。
    for (const key of ['dsh-permission-presets', 'llm-pi-ai', 'JIYUAN_API_KEY']) {
      assert.ok(fixed.includes(key), `归一化把外来内容删掉了：${key} 不见了`);
    }
    // ④ 幂等：对已健康的文本再归一化必须逐字不变（否则 repair --apply 每次都重写）。
    assert.equal(heal.normalizeManagedBlock(fixed), fixed, '归一化必须幂等（第二次调用逐字不变）');

    // ⑤ 两份实现必须一致：repair.cjs 也必须导出/实现同样的两个概念（防只修一边）。
    const repairSrc = readFileSync(path.join(__dirname, 'repair.cjs'), 'utf8');
    assert.ok(repairSrc.includes('function removeManagedBlock'), 'repair.cjs 必须有 removeManagedBlock（救出外来行）');
    assert.ok(repairSrc.includes('managedBlockPrefix'), 'repair.cjs 必须把块写进文件开头（managedBlockPrefix）');
    assert.ok(repairSrc.includes('function managedRegion'), 'repair.cjs 必须有 managedRegion');
    assert.ok(/MANAGED_ROW_IDS\s*=\s*\[[^\]]*'tool-agent-team'[^\]]*'agent-team'/u.test(repairSrc),
      'repair.cjs 的 MANAGED_ROW_IDS 必须同时含 tool-agent-team 与 agent-team');
    assert.ok(/MANAGED_ROW_IDS\s*=\s*Object\.freeze\(\[[^\]]*'tool-agent-team'[^\]]*'agent-team'/u.test(
      readFileSync(path.join(LIB, 'self-heal.js'), 'utf8')),
      'self-heal.js 的 MANAGED_ROW_IDS 必须同时含 tool-agent-team 与 agent-team');
  });

  await check('markdown 表格渲染：解析器存在且成表（用户 2026-10-09 截图报「表格渲染有问题」）', () => {
    // 用户截图里 `| 检查项 | 结果 |` / `|---|---|` 原样显示成乱码 —— 渲染器缺表格支持。
    // 完整的**行为**断言在 .probe/test-table.cjs 与 .probe/ws-e2e.mjs（需要浏览器 DOM）；
    // 这里做静态闸门：解析器必须在，且被 wsMarkdown 调用（防有人删掉后无人察觉）。
    const src = readFileSync(require('node:path').join(__dirname, '..', 'lib', 'client.js'), 'utf8');
    assert.ok(src.includes('function wsTableAt('), 'client.js 缺少 wsTableAt 表格解析器');
    assert.ok(src.includes('const table = wsTableAt(lines, i)'), 'wsMarkdown 必须调用 wsTableAt');
    assert.ok(src.includes('.dat-ws .md table{'), '缺少表格样式（.dat-ws .md table）');
    assert.ok(src.includes('md-table'), '缺少表格容器样式（.md-table，用于横向滚动）');
  });

  await check('抽屉工具调用「放大查看」：面板随视口自适应，展开层高度不再写死（用户 2026-10-15 报「固定容器太窄」）', () => {
    const src = readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
    // ① 展开层高度必须**随视口**，旧的写死值不许回来（写死 260px 就是这次报障的正面原因）。
    // 展开层高度必须随视口（2026-10-21 从 min(52vh,480px) 改成 70vh：用户要「展开即见代码」，
    // 52vh 在一个 760px 高的窗口里只有 ~395px，长输出的后半段仍要另开面板才读得到）。
    assert.ok(src.includes('max-height:70vh'), '展开层高度没随视口自适应（仍是写死的 px）');
    assert.ok(!src.includes('max-height:260px'), '旧的写死高度 max-height:260px 又回来了');
    // ② 面板本体：CSS 与三个函数都必须在。
    assert.ok(src.includes('.dat-ws .ws-zoom{'), '缺少放大面板的 CSS（.ws-zoom）');
    assert.ok(src.includes('width:min(1180px,100%)'), '面板宽度不是自适应的（写死宽度 = 又一次「固定容器」）');
    for (const fn of ['function wsOpenDetailZoom(', 'function wsCloseDetailZoom(', 'function wsDetailZoomBar(']) {
      assert.ok(src.includes(fn), '缺少 ' + fn);
    }
    // ③ 挂在 .dat-ws 根节点上：挂抽屉里会被它的 transform 夹住宽度（那正是要逃出去的东西）。
    assert.ok(src.includes('const host = state.root'), '放大面板没挂在 .dat-ws 根节点上');
    // ④ 工具条插在展开层**开头**：.dzb 是 sticky 的，排在后面就钉不住上沿。
    assert.ok(src.includes('box.insertBefore(wsDetailZoomBar(state, row, parts), box.firstChild)'),
      '「放大查看」工具条没插在展开层开头');
    // ⑤ 点击必须拦冒泡：不拦的话同一次点击顺带把那一行收起，面板一闪就没。
    const barAt = src.indexOf('function wsDetailZoomBar(');
    assert.ok(barAt >= 0 && src.slice(barAt, barAt + 1400).includes('event.stopPropagation()'),
      '工具条没拦 stopPropagation（点开会被所在行的折叠逻辑关掉）');
    // ⑥ 关闭路径：Esc **先**关面板再关抽屉；关抽屉顺手关面板。顺序错了就是留残骸。
    const keyAt = src.indexOf('const onKey = (event) =>');
    const keyBlock = keyAt < 0 ? '' : src.slice(keyAt, keyAt + 700);
    assert.ok(keyBlock.includes('wsCloseDetailZoom(state)')
      && keyBlock.indexOf('wsCloseDetailZoom') < keyBlock.indexOf('state.drawer.classList.contains'),
      'Esc 没优先关放大面板（先关抽屉会把它孤零零留在画布上）');
    const closeAt = src.indexOf('function wsCloseDrawer(state) {');
    assert.ok(closeAt >= 0 && src.slice(closeAt, closeAt + 400).includes('wsCloseDetailZoom(state)'),
      '关抽屉没顺手关掉放大面板');
  });

  await check('抽屉展开层不许被 flex 列压扁成一条缝（用户 2026-10-21 报「展开是一条缝」）', () => {
    // 症状与根因（真机 + headless Chrome 实测）：.cv 是 display:flex;flex-direction:column 的
    // 滚动容器，子项默认 flex-shrink:1。展开一层会往这一列里塞两个子项（.trow + .dbox），
    // 总高超过可视高时浏览器按比例压扁它们 —— 8 个展开时每个 .dbox 只剩 **27px**（用户看到的缝）。
    // 实测对照（同一份 CSS、1400×760）：flex:none 后 8 个展开全是 149~155px，滚动交给 .cv。
    const src = readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
    assert.ok(/\.dat-ws \.dbox\{flex:none;/.test(src), '.dbox 没有 flex:none —— 展开层会被 flex 列压扁成一条缝');
    assert.ok(/\.dat-ws \.trow\{flex:none\}/.test(src), '.trow 没有 flex:none —— 行高塌陷会连带把正文压没');
    // 只要 .cv 仍是 flex 列（这条是它的定义），上面两条就是必需的；它若改回普通块级流，
    // 这两条 flex:none 变成无害冗余，但断言仍成立，不会假红。
    assert.ok(/\.dat-ws \.cv\{[^}]*display:flex;flex-direction:column/.test(src),
      '.cv 不再是 flex 列 —— 失效的收缩前提变了，请重跑 .probe/deep/asar-test/height3.mjs 重新取值');
    // 展开文本用等宽字体：工具输入是 JSON、输出是命令回显，比例字体下引号/花括号对不齐。
    assert.ok(/\.dat-ws \.dbox pre\{[^}]*font-family:var\(--dsw-font-family-mono/.test(src),
      '展开层正文没走等宽字体（用户要「展开后就能看到代码」）');
  });

  await check('批量调用（both）档必须探测宿主还认不认这一档（DSH 0.2.1-rc.2 把它删了）', () => {
    // 2026-10-21 复核：DSH 0.2.1-rc.2 的 tools 行把呈现档从 native|ptc|both 收窄成 native|ptc。
    // 台架实测（宿主真身 dsh-tools/lib/index.js 解出来后直接喂 Config）：
    //   Config({mode:'native'}) ok / Config({mode:'ptc'}) ok / Config({mode:'both'}) 抛
    //   "$.mode expected \"native\" | \"ptc\" but got \"both\""。
    // 而 presentAs() **不校验取值**（只把字符串写进 layer.mode），所以旧代码不会在这一步抛错：
    // 开关拨了、诊断写着「已开启」，实际装配行为两边都不匹配 —— 静默退化。
    const runtimeSrc = readFileSync(path.join(__dirname, '..', 'lib', 'runtime.js'), 'utf8');
    const at = runtimeSrc.indexOf('function presentationModeSupported');
    assert.ok(at >= 0, 'runtime.js 必须有 presentationModeSupported（问注册表自己认不认这一档）');
    const body = runtimeSrc.slice(at, at + 1200);
    // 判据必须是「喂给 Config schema」：那是官方对合法取值的唯一声明。
    assert.ok(/schema\(\{ mode \}\)/.test(body), '探测必须把候选值喂给 tools 行的 Config schema');
    assert.ok(/constructor\?\.Config/.test(body), 'schema 要从 tools 服务的构造函数上取（实例上没有 Config）');
    // 取不到 schema 时必须返回 undefined（不知道），让调用方退回老行为 —— 不许当成 false 把功能关掉。
    assert.ok(/return undefined;/.test(body), '取不到 schema 必须返回 undefined（不知道），不能当成不支持');
    // 守卫必须在 presentAs('both') **之前**，且失败时如实记一条「看得见」的说明。
    const gate = runtimeSrc.indexOf("presentationModeSupported(ctx, 'both')");
    const call = runtimeSrc.indexOf("tools.presentAs('both')");
    assert.ok(gate >= 0 && call > gate, "both 的能力探测必须排在 presentAs('both') 之前");
    assert.ok(runtimeSrc.slice(gate, call).includes('noteCapabilityOnce('),
      '不支持时必须让用户看得见（否则开关拨了没反应，与旧缺陷一模一样）');
    // 客户端那格开关的说明也要跟着说准：它现在只在「宿主支持 both」时才有意义。
    const clientSrc = readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
    assert.ok(clientSrc.includes('batchTip'), '批量开关的说明文案必须仍在（配置页那一格）');
  });

  await check('会改用户配置的脚本：不认识的参数必须拒绝，不许落进默认写盘动作（2026-10-21 真事故）', () => {
    // 事故原貌：想先看用法，跑了 `node tools/ops-enable.cjs --help` —— 它只做 includes('--check')/
    // includes('--revert')，于是 --help 静默落进**默认动作 = 写盘**，把用户 profile 里两行
    // configUpdateVersion 从 2 改回 1、并把 dsh-ops 的 shell 段降级。
    // 判据：未知参数一律退出码 2 且不写；--help 打印用法且不写。这里只做静态断言
    // （真跑一次要动用户 profile，放进 run 里跑会污染环境），行为验证见提交说明里的实测输出。
    const src = readFileSync(path.join(__dirname, 'ops-enable.cjs'), 'utf8');
    const at = src.indexOf('function unknownArgs');
    assert.ok(at >= 0, 'ops-enable.cjs 必须有 unknownArgs 白名单校验');
    const body = src.slice(at, at + 900);
    for (const known of ["'--check'", "'--revert'", "'--help'", "'-h'"]) {
      assert.ok(body.includes(known), '白名单少了 ' + known);
    }
    // 拒绝分支必须 return 2（不是 undefined = 继续往下写盘）且排在默认动作之前。
    const guard = src.indexOf('if (bad.length > 0)');
    const checkAt = src.indexOf("const check = argv.includes('--check')");
    assert.ok(guard >= 0 && checkAt > guard, '未知参数守卫必须排在默认动作之前');
    assert.ok(/if \(bad\.length > 0\)[\s\S]{0,400}return 2;/u.test(src), '未知参数必须以退出码 2 拒绝');
    // --help 必须自己开一条只打印的分支，不能靠「没有 --check」落到写盘。
    assert.ok(/argv\.includes\('--help'\)[\s\S]{0,600}return 0;/u.test(src), '--help 必须单独走「只打印、直接返回」');
  });

  await check('toolRowLabel：逐字用官方 tool.title.* 真值（不许再自造「已读取文件」这类文案）', () => {
    // 用户 2026-10-09：「一定要正确，和我用官方的对话框没太大区别」。
    // 官方真值来自 dsh-client-ui-conversation/lib/client.js 的 locale 块，
    // 提取脚本 .probe/extract-tool-titles-zh.cjs（58 条）。
    // 旧实现是自造文案（「已读取文件」「修改了文件」「已搜索代码」）—— 与官方不一致。
    const expect = {
      read: '读取', read_image: '读取图片', grep: '搜索文件内容', glob: '查找文件',
      write: '写入', edit: '编辑', apply_patch: '编辑', bash: '运行命令', pwsh: '运行命令',
      web_search: '网页搜索', web_fetch: '网页获取', subagent: '创建子智能体',
      spawn_teammate: '创建队友', send_message: '发送消息', list_agents: '查看子智能体',
      wait_agent: '等待子智能体', team_task_create: '创建团队任务', get_team_task: '读取团队任务',
      read_terminal: '读取终端', lsp: '查询代码符号', find_references: '查找引用',
    };
    for (const [tool, label] of Object.entries(expect)) {
      assert.equal(graph.toolRowLabel(tool), label, `${tool} 应为官方文案「${label}」`);
    }
    // 认不出来的工具回退到官方 generic（「工具调用」），**不许自造新词**。
    assert.equal(graph.toolRowLabel('some_unknown_tool'), '工具调用', '未知工具应回退官方 generic 文案');
    // 反面对照：自造文案一个都不许再出现。
    for (const banned of ['已读取文件', '已写入文件', '修改了文件', '已搜索代码', '执行了命令', '已调用工具']) {
      const hit = Object.keys(expect).some((k) => graph.toolRowLabel(k) === banned);
      assert.ok(!hit, `官方文案里没有「${banned}」，不该出现`);
    }
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

  await check('effectiveRuntimeMs / buildGraph：活体会话的运行时长按**墙钟**推进（用户 2026-10-12 报「运行 0 秒、不实时」）', () => {
    // 回归两层（同一个函数的两条分支）：
    //   ① 活体（传 now）→ 基准是**现在**：长思考 / 长工具调用期间数字也在走，
    //      而不是只在有新事件落地时才跳一格；
    //   ② 已死（不传 now，或 liveAt 过期）→ 基准仍是最后一条事件时间：
    //      绝不把「会话已经停了多久」算进运行时长（否则宿主重启后的历史队员集体虚增）。
    const now = Date.now();
    const open = graph.emptyStats();
    open.runtimeMs = 5000;                        // 已闭合回合累计
    open.openTurns = new Map([[1, now - 60000]]); // 未闭合回合：60 秒前开始
    open.lastTime = now - 10000;                  // 最后一条事件：10 秒前
    open.liveAt = now;                            // 本轮刚读到活体 session
    const statsOf = (s) => {
      const g = graph.buildGraph({ leadId: 'L', leadName: 'lead', members: [], statsBySession: new Map([['L', s]]), tasks: [] });
      return g.nodes[0].runtimeMs;
    };
    const liveMs = statsOf(open);
    assert.ok(liveMs >= 65000 && liveMs <= 66000,
      `活体：应为 5000+(now−起点)=65000ms 量级（墙钟），实际 ${liveMs}`);
    // 不传 now 的纯函数口径不变（旧的「最后事件时间 − 起点」）
    assert.equal(graph.effectiveRuntimeMs(open), 55000, '不传 now：基准 = 最后事件时间（5000+50000）');
    // liveAt 过期（队员 agent 已消失）→ 必须回落到事件时间，不得虚增
    const expired = { ...open, liveAt: now - 10 * 60 * 1000 };
    assert.equal(statsOf(expired), 55000, '窗口过期后必须回落到「最后事件时间 − 起点」');
    // now 早于最后事件时不得倒退
    assert.equal(graph.effectiveRuntimeMs(open, now - 60000), 55000, 'now 早于最后事件时取两者较大，不得倒退');
  });

  await check('tps 的分母必须扣掉工具调用时长（用户 2026-10-21 的口径）', () => {
    // 用户原话：「tps 似乎是总 token/对话时长，但应该为 总token/(对话时长-工具调用时长)」。
    // 现象核验（真机 session-15aadf53，32 轮 / 1132 次工具调用）：
    //   turn 累计 75,609 秒，其中工具占用 61,165 秒（81%）⇒ 旧口径 5.95 tps、新口径 31.14 tps。
    // 一个把 81% 时间花在等工具上的会话，「输出速度」显示 5.95 是在量「含工具等待的吞吐」。
    const s = graph.foldSession([
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'tool/call', seq: 1, time: 1000, data: { turn: 1, step: 1, callId: 'a', name: 'pwsh', arguments: '{}' } },
      { type: 'tool/result', seq: 2, time: 9000, data: { turn: 1, step: 1, message: { toolCallId: 'a', content: [], isError: false } } },
      { type: 'assistant/message', seq: 3, time: 10000, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
      { type: 'turn/end', seq: 4, time: 10000, data: { turn: 1, reason: { kind: 'completed' } } },
    ]);
    assert.equal(graph.effectiveRuntimeMs(s), 10000, '前提：回合 0→10000 = 10 秒');
    assert.equal(graph.toolBusyMs(s), 8000, '前提：一次工具调用占了 8 秒');
    assert.equal(graph.generatingMs(s), 2000, '生成时长必须 = 10000 − 8000');
    const g = graph.buildGraph({ leadId: 'L', leadName: 'lead', members: [], statsBySession: new Map([['L', s]]), tasks: [] });
    const node = g.nodes[0];
    assert.equal(node.toolBusyMs, 8000, '节点要把工具占用如实带给前端（悬停解释分母用）');
    assert.equal(node.generatingMs, 2000, '节点要把生成时长带给前端');
    // 300 token / 2 秒 = 150 tps；旧口径会是 300/10 = 30 tps。
    assert.ok(Math.abs(node.tps - 150) < 1e-6, `tps 应按生成时长算 = 150，实际 ${node.tps}`);
    // 底栏两档只统计**队员**（Lead 自己单列）：夹具里是 Lead，所以这里断言的是「不被误算进去」，
    // 再由下一个断言核对：把同一份统计挂到队员名下时，两个口径必须都给出 150。
    assert.equal(g.totals.avgTps, 0, '底栏均值只统计队员，Lead 不参与');
    const asMember = graph.buildGraph({
      leadId: 'L', leadName: 'lead', members: [{ id: 'M', name: 'builder-a', role: 'teammate', status: 'active' }],
      statsBySession: new Map([['L', graph.emptyStats()], ['M', s]]), tasks: [],
    });
    assert.ok(Math.abs(asMember.totals.avgTps - 150) < 1e-6, '底栏均值同口径（队员档）');
    assert.ok(Math.abs(asMember.totals.tps - 150) < 1e-6, '底栏全队速度同口径（token 合计 ÷ 生成时长合计）');
    assert.equal(asMember.totals.toolBusyMs, 8000, '底栏要带工具占用（与节点同口径）');
  });

  await check('tps 的工具时长必须**合并重叠**（并行工具不能扣两遍，否则分母会被扣成负数）', () => {
    // 官方 maxParallelToolCalls 默认 10：同一 step 里并发发的工具调用时间区间互相重叠，
    // 「把每次调用时长相加」会把同一段时间扣 10 次。实测 session-15aadf53 的重叠只有 2 秒，
    // 但这笔账没有上限 —— 一批并行调用就能把生成时长算成负数，tps 变成无穷大。
    const s = graph.foldSession([
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'tool/call', seq: 1, time: 1000, data: { turn: 1, step: 1, callId: 'a', name: 'pwsh', arguments: '{}' } },
      { type: 'tool/call', seq: 2, time: 2000, data: { turn: 1, step: 1, callId: 'b', name: 'pwsh', arguments: '{}' } },
      { type: 'tool/call', seq: 3, time: 3000, data: { turn: 1, step: 1, callId: 'c', name: 'pwsh', arguments: '{}' } },
      { type: 'tool/result', seq: 4, time: 9000, data: { turn: 1, step: 1, message: { toolCallId: 'a', content: [], isError: false } } },
      { type: 'tool/result', seq: 5, time: 9000, data: { turn: 1, step: 1, message: { toolCallId: 'b', content: [], isError: false } } },
      { type: 'tool/result', seq: 6, time: 9000, data: { turn: 1, step: 1, message: { toolCallId: 'c', content: [], isError: false } } },
      { type: 'turn/end', seq: 7, time: 10000, data: { turn: 1, reason: { kind: 'completed' } } },
    ]);
    // 三次调用区间 [1000,9000] × 3：合并后是 8000，相加会是 24000（比回合还长）。
    assert.equal(graph.toolBusyMs(s), 8000, `合并后应为 8000ms，实际 ${graph.toolBusyMs(s)}`);
    assert.equal(graph.generatingMs(s), 2000, '生成时长不能为负');
    // 不相邻的两段必须分开算（中间那段是模型在生成，不能被吞掉）。
    const split = graph.foldSession([
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'tool/call', seq: 1, time: 1000, data: { turn: 1, step: 1, callId: 'x', name: 'pwsh', arguments: '{}' } },
      { type: 'tool/result', seq: 2, time: 4000, data: { turn: 1, step: 1, message: { toolCallId: 'x', content: [], isError: false } } },
      { type: 'tool/call', seq: 3, time: 6000, data: { turn: 1, step: 1, callId: 'y', name: 'pwsh', arguments: '{}' } },
      { type: 'tool/result', seq: 4, time: 7000, data: { turn: 1, step: 1, message: { toolCallId: 'y', content: [], isError: false } } },
      { type: 'turn/end', seq: 5, time: 10000, data: { turn: 1, reason: { kind: 'completed' } } },
    ]);
    assert.equal(graph.toolBusyMs(split), 4000, '3000 + 1000 两段，中间 2 秒是生成时间');
    assert.equal(graph.generatingMs(split), 6000, '10000 − 4000');
  });

  await check('tps 口径的三处消费方必须同源（节点 / 底栏 / 悬停说明）', () => {
    // 口径改了一半最糟：卡片按旧口径、浮窗按新口径，两个数字互相打架且都没法核对。
    const src = readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
    assert.ok(/tps\.title = wsTpsTip\(node\)/.test(src), '卡片上的 tps 必须挂分母说明');
    assert.ok(/footCells\[1\]\.title !== tpsTip/.test(src), '刷新路径也要更新说明（冷启动与轮询两条路）');
    assert.ok(/function wsTpsTip\(/.test(src), '说明必须只有一个来源（wsTpsTip）');
    assert.ok(src.includes('wsTpsFormula'), '文案键要在字典里');
    const graphSrc = readFileSync(path.join(__dirname, '..', 'lib', 'graph.js'), 'utf8');
    assert.ok(/const generating = Math\.max\(0, runtimeMs - busyMs\)/.test(graphSrc),
      'tps 的分母必须是 runtimeMs − busyMs');
    assert.ok(!/const tps = runtimeSec > 0\.5 \? s\.usage\.outputTokens \/ runtimeSec/.test(graphSrc),
      '旧的「总 token ÷ 对话总时长」口径必须已经删掉');
  });

  await check('工作区实时刷新：浮窗打开不得冻结卡片与浮窗指标（用户 2026-10-12 报「弹窗一开就不更新」）', () => {
    // 症状：点了 lead 卡片开浮窗后，工作区卡片的「运行 0 秒」与浮窗指标格永远不变。
    // 根因（实测复现，见 .probe/repro-freeze.mjs）：wsLoad 在浮窗打开时**整轮跳过**刷新
    // （旧注释担心「重绘让抽屉引用变陈旧」，但刷新本来就就地更新、不重建节点），
    // 而浮窗指标格又是「建一次 DOM 就不再取值」⇒ 两者叠加 = 打开浮窗后所有数字冻结。
    const src = readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
    assert.ok(!/state\.drawer\.classList\.contains\('on'\)\)\s*return/.test(src),
      'wsLoad 不得因「浮窗开着」跳过刷新（会让卡片与浮窗指标冻死在开窗那一刻）');
    assert.ok(/function wsSyncDrawerCells\(/.test(src), '缺少 wsSyncDrawerCells（浮窗指标的就地同步器）');
    assert.ok(/state\.drawerCells = cellValues/.test(src), 'wsOpenDrawer 必须登记浮窗指标单元格');
    assert.ok(/wsSyncDrawerCells\(state\.drawerCells, shown\)/.test(src),
      'wsApplyGraph 必须把每一帧数据同步进已打开的浮窗指标格');
    assert.ok(/state\.drawerCells = undefined/.test(src), '关窗必须撤销登记（否则对已关的浮窗空跑）');
  });

  await check('弹窗回答必须走官方提问卡（等价，不是消息投递）——用户 2026-10-13', () => {
    // 症状（截图 131622 / 130722）：弹窗里回答 Lead 的提问，答案变成一条
    // `【回答提问】…` 的**普通消息**插进对话，官方提问卡还挂着等。
    // 实测 session-99c20ab2 seq 21/22：两条这样的插话，因为用户又点了一次提交。
    // 根因：宿主平面只有两条通道 —— userQuestions.answer（只认 continued 态，
    // timed 未超时的提问是 open 态 → 恒 false）与「拼一条消息发出去」。
    // 修法：弹窗在前端拿官方那张 PendingQuestion 卡，调它**自己的** answer()
    // （dsh-client-ui-user-questions/lib/client.js:396-406）—— 与在聊天界面点提交
    // 是同一个方法、同一个对象，这才是等价。
    const src = readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
    assert.ok(/function bridgeQuestionCard\(/.test(src), '缺少 bridgeQuestionCard（从 uiSession 快照取官方提问卡）');
    assert.ok(/card\.callId === callId/.test(src),
      '取卡必须按 callId 精确匹配：否则会替用户答掉另一个问题');
    // 提交路径上，官方卡必须排在 team-answer 之前（先卡、拿不到卡才兜底）
    const submitAt = src.indexOf('submit.addEventListener');
    const cardAt = src.indexOf('bridgeQuestionCard(node.id, callId)', submitAt);
    const hostAt = src.indexOf("apiCall('team-answer'", submitAt);
    assert.ok(cardAt > 0 && hostAt > cardAt,
      '提交回答必须先试官方卡、再退宿主通道（顺序错了就还是消息投递）');
    assert.ok(/await official\.answer\(\{ answers \}\)/.test(src),
      '必须把整批答案交给官方卡的 answer()（官方 composer 同款批次形状）');
    // 官方卡失败时不得静默降级成消息投递（那正是用户反对的「以为回答了其实没回答」）
    assert.ok(/wsQCardFailed/.test(src), '官方卡失败要如实报错，不能偷偷改走投递');
    // 本地记一笔已答：宿主日志要等整步结算才有答案，期间不能把刚答完的卡画回可点
    assert.ok(/const cardAnswered = new Map\(\)/.test(src), '缺少 cardAnswered（本地已答记录）');
    assert.ok(/cardAnswered\.has\(q\.callId\)/.test(src),
      '提问盒的签名/未答计数必须认本地已答记录（否则刚答完的卡会退回可点）');
  });

  await check('浮窗能停止正在跑的回合（P1-1，走官方 stop 的同一条通道）', () => {
    // 官方输入框在 running 时那个方块就是「停止生成」（locale：
    // official-conversation-client.js:14487 \"input.stop\": \"停止生成\"；:17402-17410 primaryStops → stop?.()），
    // 落到同文件 :18022-18024 的 stop = (sessionId) => scopedConversation(sessions, sessionId).cancel()。
    // 本插件此前整条链都没有：lib/client.js 里 cancel( 出现次数 0（2026-10-14 审查 P1-1）。
    // 代价很具体：用户在画布上发现某个队员在跑歪方向，官方界面能立刻叫停，
    // 浮窗里只能干等 —— 而浮窗正是他「盯着这个人干活」时看的那个窗口。
    const cli = readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
    // ① session 必须从 retain 里带出来（cancel 就在它身上，binding 本来就在手里）
    assert.ok(/session: binding\.session,/.test(cli),
      'bridgeRetain 不再往外带 session：浮窗没有 cancel() 可调用');
    // ② 调的是官方那个 cancel()，不是自己另发明一条停止通道
    assert.ok(/\.session\.cancel\(\)|session\.cancel\(\)/.test(cli), '必须走官方 session.cancel()');
    // ③ 按钮 + 只在真在跑时可点（官方也按 running 切：:17402 primaryStops = running && …）
    assert.ok(/wsStopRun/.test(cli), '缺少停止按钮的文案键');
    assert.ok(/state\.drawerStop/.test(cli), '停止按钮必须随图刷新同步可用性（wsApplyGraph 那条链）');
    // ④ 失败要如实报，不能按了没反应
    assert.ok(/wsStopFailed/.test(cli), '停止失败要给原因');
  });

  await check('取官方卡必须认 kind：审批卡的 answer() 收的是 outcome 字符串', () => {
    // bridgeQuestionCard 原来只验 typeof card.answer === 'function' && card.callId === callId。
    // 可官方挂进**同一个** pending-interaction 快照的不止提问卡：审批卡也是
    // （dsh-client-ui-approval/lib/client.js:152-252 PendingApproval，同样带 callId、同样有 answer()），
    // 而它 answer(outcome) 期望 'allowed-once' | 'rejected'
    // （同文件 :214-220 + dsh-user-approval/lib/index.js:30-35 的 OUTCOMES）。
    // 把 {answers:[…]} 交给它就是喂错类型。
    // 今天默认档（danger-full-access → approval: never，dsh-user-approval/lib/index.js:175
    // 直接 return 'rejected'）不会弹审批，所以撞不上；但用户一切到 workspace-write 档，
    // 这条路的**形状**就成立了 —— 判据得自己关上门，不能指望配置永远不变。
    const cli = readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
    const at = cli.indexOf('function bridgeQuestionCard(');
    const to = cli.indexOf('function bridgePlanReviewCard(');
    assert.ok(at > 0 && to > at, '两座桥的相对位置变了？同步这条闸门');
    const fn = cli.slice(at, to);
    assert.ok(/card\.kind === 'question'/.test(fn),
      '按 callId 取到卡却不认 kind：万一是审批卡，答案会被喂给期望 outcome 的 answer()');
  });
  await check('计划审批在浮窗里看得到计划、答得上官方那张卡（P0-3）', () => {
    // 两个半边各自都可能悄悄失效，所以都钉住。
    const src = readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
    // ① 渲：官方把 detail 渲在**选项之上**（dsh-client-ui-user-questions/lib/client.js:1077-1082）。
    //    没有这一句就是「给用户两个按钮却让他看不到要批什么」。
    assert.ok(/q\.detail/.test(src) && /qdetail/.test(src),
      '提问卡不再渲染 detail（计划审批退化成只有按钮的盲签）');
    // ② 答：计划审批那张官方卡**没有 callId**（plan-mode 调 ask() 不带 wait，
    //    卡由 QuestionCards.ensure 建，callId 为 undefined：
    //    dsh-client-ui-user-questions/lib/client.js:1672-1677「A request without a
    //    call id always gets a fresh card」）。所以按 callId 取卡的 bridgeQuestionCard
    //    **永远取不到它** —— 必须有按 kind 取的那条路，否则弹窗里的 Approve 只能
    //    退成消息投递，官方那张卡还挂着（正是用户 2026-10-13 骂过的症状）。
    assert.ok(/function bridgePlanReviewCard\(/.test(src), '缺少按 kind 取计划审批卡的桥');
    assert.ok(/kind === 'plan-review'/.test(src), '取计划审批卡必须认官方 kind 字段（不是猜 header 文案）');
    // 计划卡与提问卡走**同一个** answer()：批次形状一致（官方按 entry.id 匹配，
    // dsh-plan-mode/lib/index.js:287），不许为计划另开一条投递通道。
    const planAt = src.indexOf('bridgePlanReviewCard(node.id)');
    const answerAt = src.indexOf('await official.answer({ answers })');
    assert.ok(planAt > 0 && answerAt > 0 && planAt < answerAt,
      '提交时必须先按 kind 试官方计划卡，再走原批次通道');
  });
  await check('答案批次不得含 undefined —— 含就把提问当场打死（2026-10-13 实测）', () => {
    // 这条闸门是上一次「等价」修法**自己**的 bug，也是最贵的一条：
    // 浏览器探针 23 项全绿，真机却坏了。症状（截图 192100/192148）：
    // 弹窗里点提交，官方卡**没关**，答案变成 `【回答提问】n_count：8` 的插话。
    //
    // 根因链（全部实测，session-a0705a45）：
    //   1. 旧写法 `custom: 空 ? undefined : 值` 造出一个**自有键 + undefined 值**的对象；
    //   2. 官方 answer() 只是 waterfall.resolve，载荷作为**远程事件返回值**回传宿主；
    //   3. dsh-api-gateway/lib/client.js:880 用 isRemoteJsonValue 校验，
    //      visitJsonValue(:93-96) 对**嵌套 undefined** 直接判 false；
    //   4. 于是抛 "Remote event listener result is not lossless JSON data"
    //      ⇒ seq 22 的 tool/result isError:true ⇒ **提问当场死掉**；
    //   5. 而 answer() 永远 resolve ⇒ 弹窗谎报「已通过官方提问卡回答」。
    // 官方自己的 submitDrafts（dsh-client-ui-user-questions/lib/client.js:936-948）
    // 用的是条件展开：没填自定义就**整个键都不出现**。照它写。
    const src = readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
    const submitAt = src.indexOf('submit.addEventListener');
    assert.ok(submitAt > 0, '找不到提交处理器');
    const buildAt = src.indexOf('const answers = items.map', submitAt);
    assert.ok(buildAt > 0, '找不到答案批次的构造点');
    const build = src.slice(buildAt, src.indexOf('void (async () =>', buildAt));
    assert.ok(!/custom:\s*[^\n]*undefined/.test(build),
      '答案批次里出现了 `custom: …undefined`：嵌套 undefined 会被网关拒，'+
      'ask_user_question 当场以 isError 结算（提问被打死）。必须用条件展开 '+
      '`...(custom === \'\' ? {} : { custom })`，没填时整个键都不出现');
    assert.ok(/\.\.\.\(custom === '' \? \{\} : \{ custom \}\)/.test(build),
      '答案批次必须用官方同款条件展开构造 custom 键');
    // 光有载荷正确还不够：answer() 会 resolve，必须**验结算**才能报「已回答」。
    assert.ok(/function bridgeQuestionOutcome\(/.test(src),
      '缺少 bridgeQuestionOutcome：answer() 永远 resolve，不验结算就是谎报已回答');
    assert.ok(/bridgeQuestionOutcome\(live, callId\)/.test(src),
      '提交后必须查这次工具调用的结算结果（answered/dead/unknown）');
    assert.ok(/outcome === 'dead'/.test(src), "必须区分「提问已死」这条路径");
    const deadAt = src.indexOf("outcome === 'dead'");
    // 只看 dead 分支**自己**那一段（到它的 return 为止）：再往后就是成功路径，
    // 那里当然有 cardAnswered.set，别把窗口开大了误伤。
    const deadBlock = src.slice(deadAt, src.indexOf('return', deadAt) + 6);
    assert.ok(!/cardAnswered\.set/.test(deadBlock),
      '提问已死时**不许**写 cardAnswered：那等于把没被接受的答案记成已回答');
    assert.ok(/wsQCardDead/.test(src), '提问已死要有如实的界面措辞');
    // note 必须留在 DOM 里：markCardAnswered 会 textContent='' 重建整张卡，
    // 之前把说明写进已脱离 DOM 的节点，用户从来没看见过那句实话。
    const markDef = src.slice(src.indexOf('const markCardAnswered'), src.indexOf('const loadQuestions'));
    assert.ok(/if \(keep !== undefined && keep !== null\) cardEl\.appendChild\(keep\)/.test(markDef),
      'markCardAnswered 重建卡后必须把状态提示节点接回 DOM（否则那句实话没人看得见）');
    // 调用里嵌套了 items.map(...)，所以按行匹配，别用 [^)]* 那种跨不过 ')' 的正则。
    const noteKept = src.split('\n').filter((line) => /markCardAnswered\(card,/.test(line) && /,\s*note\)/.test(line)).length;
    assert.ok(noteKept >= 2,
      '两条回答通道收卡时都要把 note 传进去（实测抓到 ' + noteKept + ' 处，需要 ≥2）');
  });

  await check('弹窗实时：必须订阅官方 eventSource 并成对释放引用——用户 2026-10-13', () => {
    // 症状：首 token 前进弹窗只看得到自己发的消息，思考要等 Lead 提问时才一次性涌出。
    // 根因：弹窗只读**持久日志**，而 assistant/message 与 tool/call 都是整步结算才落盘
    // （实测 session-99c20ab2 seq 19/20 同一毫秒）⇒ 结算前那个数据源里根本没有思考。
    // 修法：retain 目标会话，订阅官方对话自己在用的 eventSource —— 它带 transient 的
    // assistant/live-chunk（dsh-api-session-controller/lib/client.js:428-432 无条件
    // 带 assistantStream:true；:2128-2131 每个 token append 一行）。
    const src = readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
    assert.ok(/function wsFoldLive\(/.test(src), '缺少 wsFoldLive（transient 流 → 对话行）');
    assert.ok(/bridgeRetain\(node\.id\)/.test(src), '弹窗必须 retain 目标会话吃官方对象层');
    assert.ok(/live\.eventSource\.subscribe\(onFeed\)/.test(src), '必须订阅官方那份窗口');
    // retain 是引用计数：开一次放一次，漏放就永久多占一格
    assert.ok((src.match(/state\.drawerLive/g) || []).length >= 4,
      'drawerLive 句柄要在开/关两处都处理（订阅、释放、防抖计时器）');
    assert.ok(/live\.release\(\)/.test(src), '关窗必须 release retain 引用');
    // 绝不能复用 mainView：那会把用户正在看的聊天页切走
    assert.ok(!/source:\s*['"]mainView['"]/.test(src),
      '不得用 mainView 作 retain 来源（会抢走用户的主视图）');
    assert.ok(/BRIDGE_RETAIN_SOURCE/.test(src), 'retain 来源必须是自定义标签');
    // 订阅回调里不许直接打宿主接口（每个 token 都会同步回调）
    const feedAt = src.indexOf('const onFeed = () =>');
    const feedBody = src.slice(feedAt, src.indexOf('let unsubscribe', feedAt));
    assert.ok(!/apiCall\(/.test(feedBody),
      'eventSource 回调里不得直接发请求（每个 token 都回调，会打爆宿主）');
    assert.ok(/setTimeout\(\(\) => \{/.test(feedBody), '结算后的补拉必须走防抖');
    // 兜底轮询链**只能有一个启动点**：scheduleDrawer 每次把 state.drawerTimer 覆盖成
    // 最新那个 handle，于是关窗时 clearTimeout 只能停掉一条 —— 多出来的那条会一直
    // 按秒打宿主接口（本次开发就引入过这个 bug：同步 kickoff 与 .then 里的 kickoff 并存）。
    // 合法形状只有 `.then(成功回调, 失败回调)` 这两处引用（互斥，只会执行一个）；
    // 任何「单独成一行」的 kickoffDrawer() 调用都是第二个启动点。
    const standaloneKickoff = src.split('\n').some((line) => /^\s*kickoffDrawer\(\)\s*$/.test(line));
    assert.equal(standaloneKickoff, false,
      'kickoffDrawer 不许单独成行调用 —— 那会与 .then 里的启动点并存，形成两条独立轮询链'
      + '（关窗只能停掉一条，另一条继续按秒打宿主接口）');
    assert.equal((src.match(/\bkickoffDrawer\(\)/g) || []).length, 2,
      'kickoffDrawer 应当只出现在 .then 的成功/失败两个回调里（各一次）');
    // 去重判据：工具按 callId、正文按 (turn,step)，两者缺一就会重复显示
    assert.ok(/paintedCalls\.has\(row\.callId\)/.test(src), '工具行去重必须按 callId');
    assert.ok(/settledSteps\.has\(String\(row\.turn\)/.test(src), '正文去重必须按 (turn,step)');
    // 拿不到桥必须还能用（退回轮询持久日志），不能空白
    assert.ok(/state\.drawerLive !== undefined && state\.drawerLive\.hasFeed === true/.test(src),
      '轮询档位要认覆盖层是否存在：没桥时仍按快档盯日志');
    // 宿主半要**重启 DSH** 才生效，浏览器半只要刷新页面 —— 两者可能不同版本。
    // 旧宿主回的是旧形状（没有 settledSteps、工具行没有 callId），去重判据会全部失效，
    // 已经结算的流式内容会与持久行同时画两遍。所以必须有协议闸门，缺位时退回只轮询。
    assert.ok(/let hostLiveCapable = false/.test(src), '缺少宿主协议能力标志');
    assert.ok(/if \(Array\.isArray\(result\.settledSteps\)\) hostLiveCapable = true/.test(src),
      '能力判定必须落在 team-conversation 的回执上（带 settledSteps 才算新宿主）');
    assert.ok(/if \(!hostLiveCapable \|\| liveRows\.length === 0\) return base/.test(src),
      '旧宿主时必须**不画**覆盖层（否则同一段思考显示两遍）');
    assert.ok(/hasFeed === true && hostLiveCapable/.test(src),
      '轮询降档也要认能力闸门：旧宿主下覆盖层被丢掉，实时性还得靠轮询');
  });

  await check('lib/client.js 没有未闭合的 JSDoc 块（node --check 抓不到这类吞代码的错）', () => {
    // 真实事故（2026-10-13 本次开发）：写注释时开了 `/**` 却用 `//` 续行、
    // 也没有 `*/` 收尾 ⇒ 从那一行起整段被当成注释，**紧跟其后的 const 声明被吃掉**。
    // 语法完全合法（node --check 与 45 个冒烟用例全绿），只有真浏览器运行时才炸：
    //   ReferenceError: BRIDGE_RETAIN_SOURCE is not defined
    // 本仓库的 client.js 是手写 bundle、没有构建期类型检查，所以这条只能靠源码扫描钉住。
    const files = ['client.js', 'graph.js', 'runtime.js', 'tools.js', 'roster.js', 'playbook.js', 'index.js', 'preset.js'];
    const offenders = [];
    for (const file of files) {
      const lines = readFileSync(path.join(LIB, file), 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        // 只认「行首是 /**、本行没有 */」的块开头
        if (!/^\s*\/\*\*/.test(line) || line.includes('*/')) continue;
        let closed = false;
        for (let k = i + 1; k < lines.length; k += 1) {
          if (lines[k].includes('*/')) { closed = true; break }
          // 续行必须是 * 开头；出现 // 或代码就说明这个块从来没打算闭合
          if (!/^\s*\*/.test(lines[k])) break;
        }
        if (!closed) offenders.push(file + ':' + (i + 1) + '  ' + line.trim().slice(0, 70));
      }
    }
    assert.deepEqual(offenders, [], '未闭合的 JSDoc 会吃掉后面的代码：\n      ' + offenders.join('\n      '));
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
    // 2026-10-15：note 改发结构化 {code, params}（句子挪到浏览器拼）。
    // 原来这条断的是中文字子里的「重建」—— 那正是这次要拆掉的耦合：
    // 断 code 才是断「有没有如实说明」，断字样只是在断文案。
    assert.ok(g.notes.some((n) => n.code === 'recoveredFromLog'),
      '要如实说明这是历史快照（结构化 code）：' + JSON.stringify(g.notes));
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

  await check('extractQuestions：认出计划审批（exit_plan_mode），计划全文进卡（不再让用户盲签）', () => {
    // 2026-10-14 审查 P0-3：官方 dsh-plan-mode/lib/index.js:254-298 在退出计划模式时
    // 用 userQuestions.ask 挂一张**计划审批卡**，问题里带 `detail: args.plan`（整份计划），
    // 前端 dsh-client-ui-user-questions/lib/client.js:1077-1080 用 MarkdownText 把 detail
    // 渲在选项**之上**。本插件的 extractQuestions 只认 ask_user_question，计划审批于是
    // 在浮窗里退化成一张只有 Approve / Keep planning 两个按钮、**读不到计划本身**的卡
    // —— 等于让用户签字却看不到文件内容。
    // 真机证据（session-d67b00d3，本次实扫 274 份会话中唯一真出现过计划审批的一份）：
    //   seq 453 tool/call name=exit_plan_mode callId=call_324ec7aa0b384e2da59e2264
    //           arguments='{"plan":"# 调度模式（Dispatch Mode）实现计划\n\n## 0. …"}' 长 6021
    // 所以计划的真值来源就是**这条 tool/call 的 arguments.plan**，不是 intent/detail
    // （intent 只存在于官方那张活体卡上，日志里没有）。
    const plan = '# 标题\n\n## 依据\n\n- 第一条\n- **加粗的一条**';
    const callEvent = { type: 'tool/call', seq: 453, time: 1000, data: {
      callId: 'call_plan', name: 'exit_plan_mode', arguments: JSON.stringify({ plan }),
    } };
    const rows = graph.extractQuestions([
      { type: 'tool/call', seq: 1, time: 50, data: { name: 'read', arguments: '{\"file_path\":\"a\"}' } },
      callEvent,
    ], 10);
    assert.equal(rows.length, 1, `计划审批应成一条待答卡，实际 ${rows.length}：` + JSON.stringify(rows.map((r) => r.id)));
    const row = rows[0];
    assert.equal(row.planReview, true, '必须标出这是计划审批（渲染层据此走 markdown + 官方措辞）');
    // 措辞与选项逐字取官方 dsh-plan-mode/lib/index.js:37-41 的常量，不自造：
    // REVIEW_ID='plan-review'、header='Plan review'、question='Approve this plan and leave plan mode?'
    // APPROVE_LABEL='Approve'、KEEP_PLANNING_LABEL='Keep planning'。
    // 这不是翻译问题：答案批次要按 id 匹配（同文件 :287 `entry.id === REVIEW_ID`），
    // 选项要按 label 匹配（:289 `item.selected[0] !== APPROVE_LABEL`），改一个字就答不上。
    assert.equal(row.id, 'plan-review', '题目 id 必须是官方 REVIEW_ID');
    assert.equal(row.header, 'Plan review');
    assert.equal(row.question, 'Approve this plan and leave plan mode?');
    assert.deepEqual(row.options.map((o) => o.label), ['Approve', 'Keep planning']);
    assert.equal(row.callId, 'call_plan');
    assert.equal(row.answered, false);
    assert.equal(row.detail, plan, '计划全文必须原样带上（含换行，markdown 要靠它排版）');
    assert.ok(row.detail.includes('\n'), 'detail 不许被 clipLine 压成一行');
    // 已批准的批次（官方答案判据 :287-292）
    const answered = graph.extractQuestions([
      callEvent,
      { type: 'tool/result', time: 2000, data: { message: { source: { kind: 'tool', callId: 'call_plan' },
        content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'plan-review', selected: ['Approve'] }] }) }] } } },
    ], 10);
    assert.equal(answered[0].answered, true, '有答案批次就必须只读');
    assert.equal(answered[0].answer, 'Approve');
    // 被拒（Keep planning 会以 isError 结算）：也算已答完，不能再给一次可点的按钮
    const rejected = graph.extractQuestions([
      callEvent,
      { type: 'tool/result', time: 2000, data: { message: { source: { kind: 'tool', callId: 'call_plan' },
        content: [{ type: 'text', text: 'The user chose to keep planning; revise the plan and present it again.' }], isError: true } } },
    ], 10);
    assert.equal(rejected[0].answered, true, '拒绝也是结算：不许留着按钮等第二次点击');
    // 超长计划有界（真机实测 6,021 码元，本闸门给一份 40k 的）
    const big = graph.extractQuestions([{ type: 'tool/call', time: 1, data: {
      callId: 'call_big', name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# t\n' + 'p'.repeat(40000) }) },
    }], 10);
    assert.ok(big[0].detail.length <= 32000, '计划正文同样要有界：' + big[0].detail.length);
    assert.equal(big[0].detailTruncated, true, '截过要如实标');
    // 坏 JSON / 缺 plan：不编一条假审批卡
    assert.equal(graph.extractQuestions([{ type: 'tool/call', time: 1, data: { callId: 'c', name: 'exit_plan_mode', arguments: '{bad' } }], 5).length, 0,
      '参数解析不出来就不该造卡');
    assert.equal(graph.extractQuestions([{ type: 'tool/call', time: 1, data: { callId: 'c', name: 'exit_plan_mode', arguments: '{}' } }], 5).length, 0,
      '没有 plan 字段就不该造卡');
  });

  await check('extractQuestions：抽提问 + 配对 tool/result 判定已回答（用户：回答过不能再答）', () => {
    // 用户 2026-10-08：「他提问的时候我在工作区看不到也收不到任何的提问信息」。
    // 数据源必须是**会话日志**而不是官方 userQuestions 投影 —— 后者只跟踪 mode:'timed'，
    // 本机默认 legacy → 投影恒空且不报错（dsh-user-questions/.../projection.js:200-215）。
    // 用户 2026-10-09：「我已经回答过了，为什么还能回答？设计问题非常的大！！」→
    // 已回答的判据 = 该 callId 有 tool/result 且内容含 answers 批次
    // （真实日志实测：session-898e4c64 的 3 次提问全都有 result，形如
    //  {"answers":[{"id":"ui","selected":["纯图标…"]}]}，见 .probe/probe-result-shape.cjs）。
    const ask = (seq, callId, id, question) => ({
      type: 'tool/call', seq, time: 100 + seq,
      data: {
        callId,
        name: 'ask_user_question',
        arguments: JSON.stringify({
          questions: [{
            id,
            header: '远程仓库',
            question,
            multi_select: false,
            options: [
              { label: 'git + Private（推荐）', description: '私有，之后可一条命令改公开。' },
              { label: 'git + Public', description: '公开，任何人可见。' },
            ],
          }],
        }),
      },
    });
    const result = (callId, answers) => ({
      type: 'tool/result', time: 999,
      data: { message: { source: { kind: 'tool', callId }, content: [{ type: 'text', text: JSON.stringify({ answers }) }] } },
    });
    const rows = graph.extractQuestions([
      { type: 'tool/call', seq: 0, time: 50, data: { name: 'read', arguments: '{"file_path":"a"}' } },
      ask(1, 'call_open', 'repo_visibility', '远程仓库用哪个名字和可见性？'),
      ask(2, 'call_done', 'email', 'commit 作者邮箱用哪个？'),
      result('call_done', [{ id: 'email', selected: ['用 GitHub noreply 邮箱（推荐）'] }]),
    ], 10);
    assert.equal(rows.length, 2, `应抽出 2 条提问，实际 ${rows.length}`);
    const open = rows.find((r) => r.callId === 'call_open');
    assert.equal(open.answered, false, '没有 result 的提问必须是未回答');
    assert.equal(open.id, 'repo_visibility');
    assert.equal(open.header, '远程仓库');
    assert.equal(open.options.length, 2, `选项数应为 2，实际 ${open.options.length}`);
    assert.ok(open.options[0].label.includes('Private'));
    assert.equal(open.multi, false);
    const done = rows.find((r) => r.callId === 'call_done');
    assert.equal(done.answered, true, '有 answers result 的提问必须标成已回答');
    assert.equal(done.answer, '用 GitHub noreply 邮箱（推荐）', `已回答卡应带答案文本，实际 ${done.answer}`);
    // 普通提问也可以带 detail（官方 QuestionComposer 对**每一题**都渲 question.detail：
    // dsh-client-ui-user-questions/lib/client.js:1077-1082，MarkdownText，不分是不是计划审批）。
    // 本插件此前逐题只读 id/header/question/options/multi_select，detail 整个字段被丢掉。
    const withDetail = graph.extractQuestions([
      { type: 'tool/call', seq: 1, time: 10, data: { callId: 'call_d', name: 'ask_user_question', arguments: JSON.stringify({
        questions: [{ id: 'q1', header: 'h', question: '选哪个？', detail: '## 背景\n\n- 证据 A\n- **证据 B**', options: [{ label: 'A' }, { label: 'B' }] }],
      }) } },
    ], 5);
    assert.equal(withDetail[0].detail, '## 背景\n\n- 证据 A\n- **证据 B**', 'detail 必须原样带上（含换行，渲染层靠它排版 markdown）');
    assert.equal(withDetail[0].planReview, undefined, '普通提问不该被误标成计划审批');
    // 自定义回答形状（selected 空、custom 有值）
    const customRows = graph.extractQuestions([
      ask(1, 'call_c', 'install', '装到哪？'),
      result('call_c', [{ id: 'install', selected: [], custom: '链接到 C 盘插件目录' }]),
    ], 10);
    assert.equal(customRows[0].answered, true);
    assert.equal(customRows[0].answer, '链接到 C 盘插件目录', 'custom 答案要能显示');
    // 非 ask 工具调用不该产出任何问题
    const none = graph.extractQuestions([{ type: 'tool/call', seq: 0, time: 1, data: { name: 'read', arguments: '{}' } }], 10);
    assert.equal(none.length, 0);
    // 坏 JSON / 缺 questions 字段也不能抛
    assert.equal(graph.extractQuestions([{ type: 'tool/call', seq: 0, time: 1, data: { name: 'ask_user_question', arguments: '{bad' } }], 10).length, 0);
    assert.equal(graph.extractQuestions([{ type: 'tool/call', seq: 0, time: 1, data: { name: 'ask_user_question', arguments: '{}' } }], 10).length, 0);
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

  await check('statsForSession：持久快照冻住的 openTurns 视为可疑并冷却重读自愈（2026-10-12 真机幻影灰点根因）', async () => {
    // 真机取证（session-8b0321b3，宿主 21:12 启动后未重启）：队员 agent 被回收的瞬间，
    // 最后一行 turn/end 还没落盘（researcher 的 turn 2 在 22:42:18 闭合，快照只折到
    // 22:42:11）→ 持久缓存 openTurns=1 永久冻结，工作区把它画成灰色「空闲」。
    // 修法：openTurns>0 的持久缓存 = 可疑，冷却（FAILED_RETRY_MS）后重读；
    // 重读到 openTurns=0 即自愈并停止重读；真死在半路的成员重读依旧 >0（节流兜底）。
    const graph = await load('graph.js');
    graph.resetStatsCacheForTest();
    const t0 = 1_000_000;
    const partial = [
      { type: 'turn/start', seq: 0, time: t0, data: { turn: 1 } },
      { type: 'assistant/message', seq: 1, time: t0 + 3000, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
      { type: 'step/end', seq: 2, time: t0 + 3500, data: { turn: 1, step: 1 } },
    ];
    const closed = [...partial, { type: 'turn/end', seq: 3, time: t0 + 4000, data: { turn: 1, reason: { kind: 'completed' } } }];
    let events = partial;
    let reads = 0;
    const persistence = {
      open: async () => ({
        inheritedEventCount: 0,
        read: async () => { reads += 1; return { events }; },
        close: async () => {},
      }),
    };
    const notes = [];
    // ① 首折：agent 刚消失、日志还没写完 → openTurns=1（当时的「真相」）
    const s1 = await graph.statsForSession('member-phantom', undefined, persistence, notes, t0 + 4000);
    assert.equal(s1.openTurns.size, 1, 'agent 消瞬间的快照确实带着未闭合 turn');
    assert.equal(reads, 1);
    // ② 冷却期内不重读（防每 1.2s 轮询整读大日志）
    const s2 = await graph.statsForSession('member-phantom', undefined, persistence, notes, t0 + 5000);
    assert.equal(reads, 1, '冷却期内不得重读');
    assert.equal(s2.openTurns.size, 1);
    // ③ 日志补全（turn/end 落盘）+ 冷却过期 → 重读自愈
    events = closed;
    const s3 = await graph.statsForSession('member-phantom', undefined, persistence, notes, t0 + 20000);
    assert.equal(reads, 2, '冷却过期后应重读一次');
    assert.equal(s3.openTurns.size, 0, '重读后 turn 已闭合（幻影消除）');
    assert.equal(s3.runtimeMs, 4000, '运行时长按闭合 turn 结算');
    // ④ 自愈后不再是可疑缓存：不再重读
    await graph.statsForSession('member-phantom', undefined, persistence, notes, t0 + 21000);
    assert.equal(reads, 2, '自愈后不得继续重读');
    graph.resetStatsCacheForTest();
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
    ['MEMBER_PERSONA_PIN', roster.MEMBER_PERSONA_PIN],
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