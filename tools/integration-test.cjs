#!/usr/bin/env node
/**
 * integration-test.cjs —— 真链路集成测试（跑真的 cordis + 真的 dsh-tools / dsh-system-prompt / dsh-scope）
 *
 * 为什么需要它：selftest.cjs 只能证明「文本与常量自洽」，证明不了「这套机制在运行时真的生效」。
 * 本脚本用**官方运行时模块**搭一个最小但真实的组合：
 *
 *   root(ctx)
 *     ├── systemPrompt（官方注册表）   ├── tools（官方工具注册表）
 *     └── preset scope（模拟 preset 平面：策略段 + 第三方工具 + 工具用法段）
 *           ├── lead scope        ← 跑 runtime.enable() 真实安装路径
 *           ├── scout scope       ← 跑 runtime.enable() 的「给已存在队员补装」真实路径
 *           └── builder scope
 *
 * 然后用真 API 断言六件「坏了也不报错、只会悄悄烧钱」的事：
 *   1. 队员真的拿不到 create_goal / get_goal / update_goal / subagent / subagent_fork / workflow
 *      / enable_agent_team / disable_agent_team，而 Lead 拿得到；
 *   2. 队员自己作用域注册的团队工具不受 restrict 影响（官方语义：restrict 只过滤继承面），
 *      且队员只拿到 MEMBER_TEAM_TOOL_NAMES 那 9 个（官方九个去掉 spawn_teammate / interrupt_agent，再加队员专用的 report_result 与 ask_lead）；
 *   3. preset 层写死的 `tool:goal` / `tool:workflow` 用法段被队员的同名空段真的压掉了；
 *   4. 两个不同角色的队员：最终**系统提示词逐字节相同 + 工具目录完全相同**（缓存前缀可共用），
 *      而 Lead 的与队员的不同（这是应有的差异）；
 *   5. 角色差异只出现在 teammateBrief 里，且同一角色的简报稳定；
 *   6. disable 之后收窄与提示词段被干净回卷。
 *
 * ── 版本与保真度说明（重要，别当成「跑的就是桌面端那一份」） ────────────────────────
 * 本脚本从插件目录解析 `@deepseek-ai/*`，命中的是 `~/.dsh/profiles/node_modules` 的 junction，
 * 也就是全局 CLI 的 **0.1.5-rc.2** 副本；桌面端实际运行的是 app.asar 里的 **0.1.7-rc.2**。
 * 本测试依赖的四条实现路径两份**逐字一致**（已逐行核对，行号见下），所以结论对运行版本同样成立：
 *   * `tools.view()`     祖先层参与过滤、own 层无条件可见   —— 0.1.5 :2854-2873 / 0.1.7 :2959-2978
 *   * `tools.restrict()` 未知名字抛错、只过滤继承面         —— 0.1.5 :2790-2805 / 0.1.7 :2895-2910
 *   * `systemPrompt.assemble()` 用 merge 取最近同名段       —— 0.1.5/0.1.7 同构（dsh-scope merge :177-181）
 *   * `renderPrompt()` 丢弃空段                            —— 0.1.5/0.1.7 同为 `filter(text => text.length > 0)`
 * `tools/drift-check.cjs` 另外直接从 app.asar 校验 0.1.7 侧 `restrict` 的存在与语义注释。
 * 另外本脚本用 `ctx.get('systemPrompt')` 取服务、再用一层 proxy 把 `agent.ctx.systemPrompt`
 * 这样的属性访问转发到 `get()`：生产里它们由 agent 工厂的 `static inject` 提供
 * （dsh-agent-loop/lib/index.js:1481-1488 的 inject 里就有 tools / systemPrompt），
 * 这里补上同样的可见性，其余语义（作用域链、层、收窄、装配）都是真的。
 *
 *   node tools/integration-test.cjs
 *
 * 退出码：0 = 全通过；1 = 有断言失败；2 = 环境不满足（缺依赖接线 / 官方 API 形状变了）。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PLUGIN_DIR = path.resolve(__dirname, '..');
const libUrl = (file) => pathToFileURL(path.join(PLUGIN_DIR, 'lib', file)).href;

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const outcome = fn();
    if (outcome === true || outcome === undefined) {
      passed += 1;
      console.log(`  PASS  ${name}`);
      return;
    }
    failures.push({ name, detail: String(outcome) });
    console.log(`  FAIL  ${name}`);
    console.log(`        → ${String(outcome)}`);
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}`);
    console.log(`        → 断言抛错：${detail}`);
  }
}

/** 让 cordis 的 plugin fiber 进入 active（服务才可被取到）。 */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** 读一个已解析模块的版本，供「我到底测的是哪一份」透明化。 */
function versionOf(specifier) {
  try {
    const entry = require.resolve(specifier);
    let dir = path.dirname(entry);
    for (let depth = 0; depth < 6; depth += 1) {
      const manifest = path.join(dir, 'package.json');
      if (fs.existsSync(manifest)) {
        const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (typeof parsed.version === 'string') return `${parsed.name}@${parsed.version}`;
      }
      dir = path.dirname(dir);
    }
  } catch {
    return `${specifier}@?`;
  }
  return `${specifier}@?`;
}

async function main() {
  let cordis;
  let scopePkg;
  let dshTools;
  let dshSystemPrompt;
  // 技能三件套：preset 里真实声明了 skill-filesystem / tool-skill（dispatch-mode.patch.yml:142-146），
  // 所以它们和上面四个一样是**硬依赖** —— 解析不到就是安装期接线坏了。
  let dshSkill;
  let skillFs;
  let toolSkill;
  try {
    cordis = await import('@deepseek-ai/cordis');
    scopePkg = await import('@deepseek-ai/dsh-scope');
    dshTools = await import('@deepseek-ai/dsh-tools');
    dshSystemPrompt = await import('@deepseek-ai/dsh-system-prompt');
    dshSkill = await import('@deepseek-ai/dsh-skill');
    skillFs = await import('@deepseek-ai/dsh-skill-filesystem');
    toolSkill = await import('@deepseek-ai/dsh-tool-skill');
  } catch (error) {
    console.error('[integration-test] 解析不到官方运行时模块，先修依赖接线：');
    console.error(`  ${error && error.message ? error.message : String(error)}`);
    console.error(`  修法：node "${path.join(__dirname, 'repair.cjs')}" --apply`);
    process.exit(2);
  }

  const { Context } = cordis;
  const { createScope } = scopePkg;
  const { defineTool } = dshTools;
  const SystemPrompt = dshSystemPrompt.SystemPrompt ?? dshSystemPrompt.default;
  const ToolRuntime = dshTools.ToolRuntime ?? dshTools.default;
  const { renderPrompt } = dshSystemPrompt;

  const roster = await import(libUrl('roster.js'));
  const playbook = await import(libUrl('playbook.js'));
  const runtime = await import(libUrl('runtime.js'));
  const resume = await import(libUrl('resume.js'));

  // ── 隔离必须先于任何 enable：会话记忆是**同步**写 DSH 主目录的 ──────────────
  // 为什么不能只在 §7 才设 DSH_HOME（2026-09-28 的教训 + 2026-10-01 新增的写盘点）：
  //   lib/resume.js 的 sessionsHome() 只走同步候选（DSH_HOME → ~/.dsh），而它的调用点之一是
  //   `agent/created` 的同步监听器；而 `runtime.enable()`（本文件第 240 行附近）会记一条会话记录。
  //   如果那时 DSH_HOME 还没设，这条记录就写进**真实的 ~/.dsh** —— 正是 2026-09-28 写坏用户配置
  //   的那一类事故。所以临时主目录在**跑任何 enable 之前**就建好。
  const tempHome = require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'dispatch-itest-home-'));
  require('node:fs').mkdirSync(path.join(tempHome, 'profiles'), { recursive: true });
  process.env.DSH_HOME = tempHome;

  // 技能夹具（2026-10-07 新增 §2.5）：两个 SKILL.md，一个正常、一个 `disable-model-invocation: true`。
  // 为什么要用**真的** SKILL.md 而不是 stub：这条闸门要证明的是「谁能调 skill」与「目录注入」
  // 由**同一个可见性判据**决定，而 `disable-model-invocation` 的过滤发生在官方 provider 里
  // （dsh-skill-filesystem/lib/index.js:853-856 → invocation.modelInvocable:false），
  // 用 stub 就把这一段换成了我自己写的等价物，测的就不是官方那条路径了。
  const skillFixture = require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'dispatch-itest-skills-'));
  const skillsRoot = path.join(skillFixture, 'skills');
  const writeSkill = (dir, frontmatter, body) => {
    require('node:fs').mkdirSync(path.join(skillsRoot, dir), { recursive: true });
    require('node:fs').writeFileSync(path.join(skillsRoot, dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8');
  };
  writeSkill('probe-visible', 'name: probe-visible\ndescription: 集成测试夹具：模型可调用的技能', '# 正文\n夹具正文。');
  writeSkill('probe-hidden', 'name: probe-hidden\ndescription: 集成测试夹具：禁止模型调用\ndisable-model-invocation: true', '# 正文\n不该进目录。');

  // 临时目录登记 + **进程退出兜底清理**：本文件有好几条早退路径（解析不到官方模块、隔离断言不成立、
  // 断言失败后 process.exit(1)）。只靠末尾那一次 rmSync 会留下垃圾目录 —— 2026-10-01 实测在 %TEMP%
  // 里攒了 5 个 `dispatch-itest-home-*` 与 40+ 个 `dispatch-itest-race-*`。这里统一兜住。
  const tempDirs = [tempHome, skillFixture];
  process.on('exit', () => {
    for (const dir of tempDirs) {
      try { require('node:fs').rmSync(dir, { recursive: true, force: true }); } catch { /* 收尾失败不影响结论 */ }
    }
  });

  console.log('模块版本（不是桌面端那一份，见文件头说明）：');
  console.log(`  ${versionOf('@deepseek-ai/cordis')}`);
  console.log(`  ${versionOf('@deepseek-ai/dsh-tools')}`);
  console.log(`  ${versionOf('@deepseek-ai/dsh-system-prompt')}`);
  console.log(`  ${versionOf('@deepseek-ai/dsh-scope')}`);
  console.log('');

  // ── 最小工具定义（preset 平面上的「第三方工具」，用来验证收窄真的发生） ──────
  const syntheticTool = (name) => defineTool({
    name,
    description: `synthetic ${name} used by the integration test`,
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: () => [{ type: 'text', text: '{}' }],
    },
    execute: () => ({}),
  });

  /** preset 平面注册的「继承面」工具。send_message 特意与团队工具同名，用来验证「own 层压过继承面」。 */
  const PRESET_TOOL_NAMES = [...roster.TEAMMATE_TOOL_DENY, 'send_message', 'read', 'pwsh'];

  const root = new Context();
  root.plugin(SystemPrompt, { includeHarnessIdentity: true, personaPrefix: '', includeRuntimeContext: true });
  await tick();
  root.plugin(ToolRuntime, { mode: 'native' });
  await tick();

  if (root.get('systemPrompt') === undefined || root.get('tools') === undefined) {
    console.error('[integration-test] systemPrompt / tools 服务没起来，官方 API 形状可能变了。');
    process.exit(2);
  }

  // ── fake 域服务 + agents 注册表（enable/disable 只通过 ctx.get 惰性取用） ────
  const agents = [];
  const membershipById = new Map();
  const fakeDomain = {
    tryMembership(agent) { return membershipById.get(agent && agent.id); },
    listMembers(agent) {
      const info = membershipById.get(agent && agent.id);
      const rootAgent = info === undefined ? undefined : info.root;
      return agents
        .filter((candidate) => candidate === rootAgent || (membershipById.get(candidate.id) || {}).root === rootAgent)
        .map((candidate) => {
          const own = membershipById.get(candidate.id);
          return { id: candidate.id, name: own.name, role: own.role, status: 'inactive' };
        });
    },
    spawnTeammate() { throw new Error('integration-test: spawnTeammate 不在本测试范围内'); },
  };
  root.plugin({
    name: 'fake-team-domain',
    apply(ctx) {
      ctx.provide('agentTeams', fakeDomain);
      // get(id) 与真 dsh-agent 注册表同语义（agent.id === session.id，dsh-agent/lib/index.js:591-595）：
      // lib/graph.js 按成员 id 取活体 agent，缺了 get 会让所有队员都走持久兜底分支。
      ctx.provide('agents', { list: () => [...agents], get: (id) => agents.find((candidate) => candidate.id === id) });
    },
  });
  await tick();

  if (root.get('agentTeams') === undefined) {
    console.error('[integration-test] fake agentTeams 服务没起来（cordis provide 语义可能变了）。');
    process.exit(2);
  }

  // ── 作用域 key 必须是对象（官方用 WeakMap 存父子关系） ──────────────────────
  const KEY = { preset: { name: 'preset' }, lead: { name: 'lead' }, scout: { name: 'scout' }, builder: { name: 'builder' } };

  const preset = createScope(root, KEY.preset);
  // preset 平面的注册：一律走 ctx.get(...)，因为测试用的作用域 fiber 没有声明 inject
  // （生产里每个 preset 行都有自己的 inject；见文件头说明）。
  const presetSp = preset.ctx.get('systemPrompt');
  const presetTools = preset.ctx.get('tools');

  presetSp.section({
    name: 'deployment:persona-prefix',
    order: presetSp.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: 'You are a helpful software engineer assistant.',
  });
  presetSp.section({ name: 'dispatch:playbook', order: 1, text: playbook.PLAYBOOK });
  presetSp.section({ name: 'tool:goal', order: presetSp.getSectionOrder('TOOL_GOAL'), text: 'USE create_goal / get_goal / update_goal to manage goals.' });
  presetSp.section({ name: 'tool:workflow', order: presetSp.getSectionOrder('TOOL_WORKFLOW'), text: 'USE workflow to fan out across many subagents.' });
  presetSp.section({
    name: 'tool:subagent',
    order: presetSp.getSectionOrder('TOOL_SUBAGENT'),
    text: (context) => (root.get('tools').get('subagent', context.scope) === undefined ? '' : 'USE subagent in the background by default.'),
  });
  for (const name of PRESET_TOOL_NAMES) presetTools.register(syntheticTool(name));

  // ── preset 平面上的技能三件套（照生产形状：dispatch-mode.patch.yml:142-146 就是这么两行）──
  // 为什么必须放在 preset 平面而不是 root：`tool-skill` 是 preset 行的贡献，队员作用域是它的
  // **子作用域** —— 只有这个形状才能证明「收窄队员时 skill 会怎样」。挂在 root 上就变成了
  // 「全局工具被摘」，测不到本插件真正依赖的那条继承语义。
  root.plugin(dshSkill.SkillRegistry ?? dshSkill.default, {});
  await tick();
  preset.ctx.plugin(skillFs, {
    dshHome: tempHome,
    agentsHome: path.join(skillFixture, 'agents'),
    bundledSkillDir: path.join(skillFixture, 'bundled'),
    // 关掉默认根：否则会去扫真实的 ~/.agents/skills 与 ~/.dsh —— 测试结论会随用户机器上的
    // 技能数量变化，而且会把用户自己的技能名带进断言。
    includeDefaultRoots: false,
    customSkillDirs: [skillsRoot],
    watch: false,
  });
  await tick();
  preset.ctx.plugin(toolSkill, {});
  await tick();
  await tick();

  // ── agent 作用域：Lead + 两个不同角色的队员（同一个 preset 祖先） ─────────────
  const leadScope = createScope(root, KEY.lead, { parent: KEY.preset });
  const scoutScope = createScope(root, KEY.scout, { parent: KEY.preset });
  const builderScope = createScope(root, KEY.builder, { parent: KEY.preset });

  /** 生产里 agent.ctx 的 fiber 声明了 inject: ['tools','systemPrompt',…]（dsh-agent-loop:1481-1488），
   *  所以属性访问可用；测试作用域 fiber 没有 inject，这里补一层等价转发，其余语义都是真的。 */
  const agentCtx = (scopeCtx) => new Proxy(scopeCtx, {
    get(target, prop, receiver) {
      if (prop === 'systemPrompt' || prop === 'tools') return target.get(prop);
      return Reflect.get(target, prop, receiver);
    },
  });

  const leadAgent = { id: 'lead-agent', ctx: agentCtx(leadScope.ctx), options: {} };
  const scoutAgent = { id: 'scout-agent', ctx: agentCtx(scoutScope.ctx), options: {} };
  const builderAgent = { id: 'builder-agent', ctx: agentCtx(builderScope.ctx), options: {} };
  agents.push(leadAgent, scoutAgent, builderAgent);
  membershipById.set(leadAgent.id, { root: leadAgent, id: leadAgent.id, role: 'lead', name: 'lead' });
  membershipById.set(scoutAgent.id, { root: leadAgent, id: scoutAgent.id, role: 'teammate', name: 'scout' });
  membershipById.set(builderAgent.id, { root: leadAgent, id: builderAgent.id, role: 'teammate', name: 'builder' });

  // ── 跑真实安装路径：enable() 装 Lead，并给「已存在的队员」补装 ───────────────
  const enabled = await runtime.enable(root, leadAgent, { source: 'integration-test' });
  if (enabled === null || typeof enabled !== 'object' || enabled.ok !== true) {
    console.error('[integration-test] runtime.enable 未成功：', JSON.stringify(enabled));
    process.exit(2);
  }
  await tick();

  const visibleNames = (scopeKey) => [...root.get('tools').view(scopeKey).visible.keys()].sort();
  const leadTools = visibleNames(KEY.lead);
  const scoutTools = visibleNames(KEY.scout);
  const builderTools = visibleNames(KEY.builder);

  console.log('lib 真链路（cordis + dsh-tools + dsh-system-prompt）');

  // ── 1) 收窄真的发生 ─────────────────────────────────────────────────────────
  check('队员拿不到 goal / 子代理 / Lead 专属开关；Lead 拿得到', () => {
    const leaked = roster.TEAMMATE_TOOL_DENY.filter((name) => scoutTools.includes(name));
    if (leaked.length > 0) return `队员竟然还能看到：${leaked.join(', ')}（restrict 没生效）`;
    const leadMissing = roster.TEAMMATE_TOOL_DENY.filter((name) => !leadTools.includes(name));
    if (leadMissing.length > 0) return `Lead 反而看不到：${leadMissing.join(', ')}（不该被收窄）`;
    return true;
  });

  check('收窄只影响该队员：另一个队员同样收窄，preset 平面本身不受影响', () => {
    const builderLeak = roster.TEAMMATE_TOOL_DENY.filter((name) => builderTools.includes(name));
    if (builderLeak.length > 0) return `builder 队员漏了：${builderLeak.join(', ')}`;
    const presetStillHas = roster.TEAMMATE_TOOL_DENY.filter((name) => !root.get('tools').view(KEY.preset).visible.has(name));
    if (presetStillHas.length > 0) return `preset 平面的工具被误删：${presetStillHas.join(', ')}`;
    return true;
  });

  // ── 2) 队员自己的团队工具子集 ──────────────────────────────────────────────
  check('队员只拿到 MEMBER_TEAM_TOOL_NAMES 那 9 个团队工具（继承面同名的那份被遮蔽）', () => {
    const missing = roster.MEMBER_TEAM_TOOL_NAMES.filter((name) => !scoutTools.includes(name));
    if (missing.length > 0) return `队员缺团队工具：${missing.join(', ')}`;
    const extra = roster.TEAM_TOOL_NAMES
      .filter((name) => !roster.MEMBER_TEAM_TOOL_NAMES.includes(name))
      .filter((name) => scoutTools.includes(name));
    if (extra.length > 0) return `队员不该有的团队工具出现了：${extra.join(', ')}`;
    // report_result 是队员专用：队员必须有，Lead 必须没有（Lead 没有汇报对象；工具目录也要稳定）。
    if (!scoutTools.includes(roster.REPORT_TOOL_NAME)) return `队员没有 ${roster.REPORT_TOOL_NAME}`;
    if (leadTools.includes(roster.REPORT_TOOL_NAME)) return `Lead 也拿到了 ${roster.REPORT_TOOL_NAME}（应当只给队员）`;
    // own 层注册的 send_message 压过 preset 平面同名的那份；restrict 也摘不掉 own 层。
    const own = root.get('tools').view(KEY.scout).visible.get('send_message');
    if (own === undefined) return 'own 层的 send_message 不见了（作用域分层语义变了）';
    if (own.description.includes('synthetic')) return 'preset 层的 send_message 压过了 own 层注册（分层方向反了）';
    return true;
  });

  check('restrict 摘的是继承面：未列入名单的 preset 工具对队员仍可见', () => {
    for (const name of ['read', 'pwsh']) {
      if (!scoutTools.includes(name)) return `队员丢了未被收窄的 preset 工具：${name}`;
      if (!leadTools.includes(name)) return `Lead 丢了 preset 工具：${name}`;
    }
    return true;
  });

  check('队员注册的 own 层工具不受同名 deny 影响（官方语义：own 层永不被 restrict 摘掉）', () => {
    // 直接对 own 层名字再下一次 deny：restrict 接受（它在继承面里也有同名），但 own 层那份必须还在。
    const scopedTools = scoutScope.ctx.get('tools');
    scopedTools.restrict({ deny: ['send_message'] });
    const after = root.get('tools').view(KEY.scout).visible.get('send_message');
    if (after === undefined) return 'own 层的 send_message 被 restrict 摘掉了 —— 官方语义不是这样，设计前提不成立';
    if (after.description.includes('synthetic')) return 'restrict 把继承面的同名工具放行回来了（应当是 own 层赢）';
    return true;
  });

  // ── 2.5) skill：队员能调，且「工具可见性 ↔ 技能目录」绑定（2026-10-07 新增）──────
  //
  // 为什么要有这一组：`skill` 是 preset 行带来的工具（presets/dispatch-mode.patch.yml:142-146），
  // 本插件的 TEAMMATE_TOOL_DENY 里**没有**它（lib/roster.js:472-482），所以队员天然保留它 ——
  // 于是「队员能不能用 skill」这件事**没有任何闸门**。谁哪天把 skill 加进 deny 名单，队员会
  // 同时失去工具**和**技能目录，而插件照常加载、/team 照常可用、配置页照常渲染：与 2026-10-07
  // 修掉的「/team 静默拒收附件」是同一类失效模式（坏了不报，只是能力没了）。
  //
  // 官方机制（对着装机 0.2.0-rc.2 逐行核过）：dsh-tool-skill/lib/index.js:203-236 在
  // `agent/pre-step` 上注入一条 **user 消息**（source.kind = "skill-catalog"），而 :207 的判据是
  // `ctx.tools.get("skill", agent) === skillTool` —— **谁能调这个工具，谁才有目录**；
  // 该事件的作用域过滤器就是 agent 本身（dsh-scope/lib/invariant.js:17 `"agent/pre-step": (args) => args[0]["agent"]`）。
  // 因为它是 user 消息而不是提示词段，队员的共享系统提示词前缀不受影响（缓存设计不动）。
  //
  // 生产里 agent 的 scope key 就是 agent 自己（dsh-agent-loop:778 `createScope(loopCtx, this)`），
  // 而本文件的夹具用独立 KEY 对象当 key —— 两者是同一件事。所以这里把 session 挂在**既有的 KEY**
  // 上，让它在瀑布里同时充当「作用域 key」与「agent」：夹具身份与上面所有断言完全一致（不新建作用域，
  // 也不改动任何既有断言的输入）。
  const skillKeyOf = (key, id) => {
    key.session = {
      id,
      header: { cwd: skillFixture },
      // 目录历史的三件套（dsh-tool-skill:332-336 读 session.surface.nodes / seq / eventAt）：
      // 空历史 + seq 0 = 「本会话还没发过目录」，正是首步要走的发布分支。
      surface: { nodes: [] },
      seq: 0,
      eventAt: () => undefined,
    };
    return key;
  };
  skillKeyOf(KEY.lead, 'lead-agent');
  skillKeyOf(KEY.scout, 'scout-agent');
  skillKeyOf(KEY.builder, 'builder-agent');

  const skillTool = root.get('tools').view(KEY.preset).visible.get('skill');
  check('skill 三件套真的装上了（夹具自检：否则下面几条会变成空断言）', () => {
    if (skillTool === undefined) return 'preset 平面上没有 skill 工具 —— 夹具没装成，本组断言无意义';
    if (root.get('skills') === undefined) return 'skills 服务没起来（SkillRegistry 没装上）';
    return true;
  });

  check('队员与 Lead 都保留 skill 工具（TEAMMATE_TOOL_DENY 不该含它）', () => {
    if (roster.TEAMMATE_TOOL_DENY.includes('skill')) {
      return 'TEAMMATE_TOOL_DENY 里出现了 skill —— 队员会同时失去 skill 工具与技能目录（官方按可见性绑定），'
        + '而这是静默的：插件照常加载，只是全队再也不会用技能';
    }
    for (const [label, key] of [['Lead', KEY.lead], ['队员 scout', KEY.scout], ['队员 builder', KEY.builder]]) {
      // 用 `!== skillTool` 而不是「非 undefined」：可见性判据本身是**身份**比较
      // （dsh-tool-skill:207），同名遮蔽出来的另一个对象会让目录静默不注入。
      if (root.get('tools').get('skill', key) !== skillTool) return `${label} 看不到 skill 工具（被收窄摘掉了？）`;
    }
    return true;
  });

  const runPreStep = async (agent) => {
    const controller = new AbortController();
    return root.waterfall(
      'agent/pre-step',
      { agent, messages: [], signal: controller.signal },
      () => ({ kind: 'enter', messages: [] }),
    );
  };
  /** 取这一步被注入的技能目录正文；没有注入返回 undefined。 */
  const catalogTextOf = (decision) => {
    const message = (decision.messages || []).find((item) => item.source !== undefined && item.source.kind === 'skill-catalog');
    return message === undefined ? undefined : message.content.map((block) => block.text ?? '').join('\n');
  };

  const scoutCatalog = catalogTextOf(await runPreStep(KEY.scout));
  const leadCatalog = catalogTextOf(await runPreStep(KEY.lead));

  check('队员的上下文里真的有技能目录（不是「按名字点名才能用」）', () => {
    if (scoutCatalog === undefined) {
      return '队员没收到 <available_skills> —— 官方只在 skill 工具可见时注入目录（dsh-tool-skill:207），'
        + '说明队员这条路径上的可见性判据已经不成立';
    }
    if (!scoutCatalog.includes('<available_skills>')) return `收到的目录消息里没有 <available_skills>：${scoutCatalog.slice(0, 160)}`;
    if (!scoutCatalog.includes('probe-visible')) return `目录里没有夹具技能 probe-visible：${scoutCatalog.slice(0, 160)}`;
    // `disable-model-invocation: true` 的技能必须被过滤掉（dsh-skill-filesystem:853-856 把它
    // 翻成 modelInvocable:false，dsh-tool-skill:217 再 filter(isModelInvocable)）——
    // 它在目录里出现 = 队员会照着调一个必然抛错的技能（:147/:150 抛 "not available for model invocation"）。
    if (scoutCatalog.includes('probe-hidden')) {
      return 'disable-model-invocation 的技能混进了目录 —— 队员会调它然后拿到 not available for model invocation';
    }
    return true;
  });

  check('Lead 的上下文里也有技能目录（目录是按 agent 各发一份，不是只给队员）', () => {
    if (leadCatalog === undefined) return 'Lead 没收到技能目录';
    if (!leadCatalog.includes('probe-visible')) return `Lead 的目录里没有夹具技能：${leadCatalog.slice(0, 160)}`;
    return true;
  });

  // 负对照：证明上面两条断言真的会因为「skill 不可见」而红，而不是恒真。
  const KEY_SKILL_DENIED = { name: 'skill-denied-agent' };
  const skillDeniedScope = createScope(root, KEY_SKILL_DENIED, { parent: KEY.preset });
  skillDeniedScope.ctx.get('tools').restrict({ deny: ['skill'] });
  await tick();
  skillKeyOf(KEY_SKILL_DENIED, 'skill-denied-agent');
  const deniedCatalog = catalogTextOf(await runPreStep(KEY_SKILL_DENIED));
  check('负对照：摘掉 skill 后工具与技能目录**同时**消失（这就是上面几条要拦的静默失效）', () => {
    if (root.get('tools').get('skill', KEY_SKILL_DENIED) !== undefined) {
      return 'deny skill 没生效 —— 负对照不成立，上面两条断言可能是假绿灯';
    }
    if (deniedCatalog !== undefined) {
      return '工具摘了但目录还在 —— 「可见性绑定」不成立，本组断言的前提要重写（dsh-tool-skill:207）';
    }
    return true;
  });

  // ── 3) 段遮蔽 ──────────────────────────────────────────────────────────────
  const promptOf = async (scopeKey) => renderPrompt(await root.get('systemPrompt').assemble({ scope: scopeKey }));

  const leadPrompt = await promptOf(KEY.lead);
  const scoutPrompt = await promptOf(KEY.scout);
  const builderPrompt = await promptOf(KEY.builder);

  check('Lead 的系统提示词里看得见方法论与工具用法段', () => {
    if (!leadPrompt.includes('调度模式')) return 'Lead 看不到 PLAYBOOK';
    if (!leadPrompt.includes('USE create_goal')) return 'Lead 看不到 tool:goal 用法段';
    if (!leadPrompt.includes('USE workflow')) return 'Lead 看不到 tool:workflow 用法段';
    return true;
  });

  check('队员的系统提示词里没有 Lead 方法论，也没有被摘掉工具的用法段', () => {
    if (scoutPrompt.includes('调度模式（Dispatch Mode）')) return '队员仍然看得到 Lead 的 PLAYBOOK（遮蔽没生效）';
    if (scoutPrompt.includes('USE create_goal')) return '队员仍然看得到 tool:goal 用法段（同名空段没压住）';
    if (scoutPrompt.includes('USE workflow')) return '队员仍然看得到 tool:workflow 用法段';
    if (scoutPrompt.includes('USE subagent')) return '队员仍然看得到 subagent 用法段（它的文本函数应当自查可见性）';
    if (!scoutPrompt.includes('你不是 Lead')) return `队员看不到共享队员卡；实际提示词：${scoutPrompt.slice(0, 200)}`;
    return true;
  });

  // ── 3.5) 提示词卫生：不重复注入、前缀规模有预算 ─────────────────────────────
  {
    const countOf = (text, needle) => text.split(needle).length - 1;
    const ownLead = playbook.PLAYBOOK.length + playbook.TEAM_POLICY.length;
    const ownMate = playbook.TEAMMATE_CARD.length + playbook.teammateBrief('scout', 'scout').length;
    console.log(`  渲染后的系统提示词：Lead ${leadPrompt.length} 字符 · 队员 ${scoutPrompt.length} 字符（本插件贡献 ${ownLead} / ${ownMate}）`);

    check('提示词没有重复注入：PLAYBOOK / 队员卡 / 团队事实各只出现一次', () => {
      if (countOf(leadPrompt, playbook.LEAD_MARKER) !== 1) return `Lead 提示词里 PLAYBOOK 出现 ${countOf(leadPrompt, playbook.LEAD_MARKER)} 次`;
      if (countOf(scoutPrompt, playbook.TEAMMATE_MARKER) !== 1) return `队员提示词里队员卡出现 ${countOf(scoutPrompt, playbook.TEAMMATE_MARKER)} 次`;
      if (countOf(leadPrompt, 'Agent Teams 已在本会话开启') !== 1) return `Lead 提示词里团队事实段出现 ${countOf(leadPrompt, 'Agent Teams 已在本会话开启')} 次（enable 重复注入了？）`;
      if (scoutPrompt.includes('Agent Teams 已在本会话开启')) return '队员也看到了 Lead 的团队事实段（它只该在 Lead 的 agent scope）';
      return true;
    });

    check('系统提示词前缀规模在预算内（这段前缀每次请求都要付钱）', () => {
      if (ownLead > 4900) return `Lead 侧自有段落 ${ownLead} 字符 > 4900`;
      if (ownMate > 1550) return `队员侧自有段落 ${ownMate} 字符 > 1550`;
      if (leadPrompt.length < ownLead) return '渲染结果比源文本还短（PLAYBOOK/策略段没注册上？）';
      // 注意：队员的**角色简报不在系统提示词里**（它是第一条 user 消息），所以这里只对队员卡。
      if (scoutPrompt.length < playbook.TEAMMATE_CARD.length) return '渲染结果比队员卡还短（卡没注册上？）';
      if (scoutPrompt.length > 2000) return `队员系统提示词 ${scoutPrompt.length} 字符 > 2000（除了队员卡，多出来的部分是谁的？）`;
      return true;
    });
  }

  // ── 4) 缓存前缀：两个角色的队员逐字节相同 ───────────────────────────────────
  check('两个不同角色的队员：系统提示词逐字节相同', () => {
    if (scoutPrompt !== builderPrompt) {
      const at = [...scoutPrompt].findIndex((char, index) => char !== builderPrompt[index]);
      return `队员提示词不一致（首个差异在第 ${at} 个字符）：scout=${JSON.stringify(scoutPrompt.slice(at, at + 60))} builder=${JSON.stringify(builderPrompt.slice(at, at + 60))}`;
    }
    return true;
  });

  check('两个不同角色的队员：工具目录完全相同（名字与顺序）', () => {
    if (scoutTools.join(',') !== builderTools.join(',')) {
      return `scout=[${scoutTools.join(',')}] builder=[${builderTools.join(',')}]`;
    }
    return true;
  });

  check('队员前缀与 Lead 前缀确实不同（角色区分靠派活提示词，不靠系统提示词）', () => {
    if (scoutPrompt === leadPrompt) return 'Lead 与队员的系统提示词完全相同 —— 队员卡或遮蔽根本没装上';
    if (scoutTools.join(',') === leadTools.join(',')) return 'Lead 与队员的工具目录完全相同 —— 收窄没生效';
    return true;
  });

  check('角色差异只出现在 teammateBrief 里（不同角色不同、同一角色稳定、不含 Lead 方法论）', () => {
    const a = playbook.teammateBrief('scout', 'scout');
    const b = playbook.teammateBrief('builder', 'builder');
    if (a === b) return '两个角色的派活简报相同（角色区分丢失）';
    if (playbook.teammateBrief('scout', 'scout') !== a) return '同一角色的简报不稳定';
    if (a.includes('调度模式')) return '派活简报里混进了 Lead 方法论';
    return true;
  });

  // ── 5) 状态查询 ────────────────────────────────────────────────────────────
  check('runtime.status() 报告该队员实际被摘掉的工具', () => {
    const status = runtime.status(scoutAgent);
    if (!Array.isArray(status.restrictedTools) || status.restrictedTools.length === 0) {
      return 'status().restrictedTools 是空的 —— 排查「队员为什么没有某个工具」时没有依据';
    }
    if (status.role !== 'scout') return `status().role=${status.role}，应为 scout`;
    return true;
  });

  // ── 6) 关闭团队后回卷干净 ───────────────────────────────────────────────────
  const disabled = runtime.disable(root, leadAgent);
  await tick();
  check('disable 返回 ok:true', () => (disabled.ok === true ? true : `disable 返回 ${JSON.stringify(disabled)}`));
  check('disable 后队员的工具目录退回 preset 面', () => {
    const after = visibleNames(KEY.scout);
    const stillDenied = roster.TEAMMATE_TOOL_DENY.filter((name) => !after.includes(name));
    if (stillDenied.length > 0) return `收窄没有回卷：${stillDenied.join(', ')} 仍然不可见`;
    const stillOurs = roster.MEMBER_TEAM_TOOL_NAMES.filter((name) => after.includes(name) && name !== 'send_message');
    if (stillOurs.length > 0) return `团队工具没有卸载：${stillOurs.join(', ')}`;
    return true;
  });
  // 先 await 装配，再交给同步的 check（check() 不做 await，传 async 函数会变成假失败）。
  const promptAfterDisable = renderPrompt(await root.get('systemPrompt').assemble({ scope: KEY.scout }));
  check('disable 后队员不再看到队员卡', () => {
    if (promptAfterDisable.includes('你不是 Lead')) return '队员卡段没有回卷';
    return true;
  });

  // ── 7) 宿主入口 apply()：控制面注册 + HTTP 路由（含 revision CAS） ───────────
  // 这是 loader 真正调用的那个入口，改动最容易在这里埋雷（一个拼错的引用就能让插件起不来）。
  // 配置读写必须落在**临时 DSH_HOME**，绝不能碰真实的 ~/.dsh/dispatch-agent-team.json。
  //
  // 注意：踩过的坑（2026-09-28，真的写坏过用户的配置文件）：只设 `process.env.DSH_HOME` **不够**。
  // `resolveDshHome()` 的候选顺序是「settings 推导 → DSH_HOME → ~/.dsh」，而它用
  // 「<候选>/profiles 是不是目录」做**存在性确认** —— 临时目录下没有 profiles/，于是它会跳过
  // DSH_HOME、选中真实存在的 ~/.dsh，测试里的 set/reset 就写到了真配置上。
  // 现在两重保险：① 临时 DSH_HOME 下先建出 profiles/ 目录；② 断言解析出来的配置路径确实在临时目录里。
  const os = require('node:os');
  const fsSync = require('node:fs');
  const { EventEmitter } = require('node:events');
  // tempHome 已在 main() 开头建好并设为 DSH_HOME（见那里的注释：会话记忆是同步写盘的）。

  const resolvedConfigPath = await runtime.getConfigPath(root);
  const configPathIsTemp = path.resolve(resolvedConfigPath).startsWith(path.resolve(tempHome) + path.sep);
  check('测试隔离：配置路径解析到临时 DSH_HOME（不是真实的 ~/.dsh）', () => (
    configPathIsTemp ? true : `解析到 ${resolvedConfigPath}，不在 ${tempHome} 下 —— 拒绝继续，避免写坏真实配置`
  ));
  if (!configPathIsTemp) {
    try { fsSync.rmSync(tempHome, { recursive: true, force: true }); } catch { /* 收尾失败不影响结论 */ }
    delete process.env.DSH_HOME;
    console.log('');
    console.log(`${passed}/${passed + failures.length} 通过。（§7 宿主入口测试已跳过：隔离断言不成立）`);
    process.exit(1);
  }

  // ── 7.5) 诊断通道：健康时不许报故障；并发定位只许记一条 ──────────────────────
  // 复现 2026-09-28 用户截到的「宿主诊断（配置文件可能有问题）」假警报：
  //   ① 信息性记录（DSH 主目录 / 配置文件）与真故障共用一条通道，页面在**一切正常**时
  //      也渲染成红色告警；
  //   ② 同一句被记了两遍 —— apply() 里 `loadConfig()`（lib/index.js:282）与
  //      `writeStatusFile()`（lib/index.js:336 → :369 `getConfigPath`）都是 fire-and-forget，
  //      而旧实现把「已算过」的检查放在 `await settings.prepareDocument()` **之前**、
  //      赋值放在 await **之后**，于是第二个调用者从同一个窗口挤进来又算了一遍。
  // 这里用**全新的模块实例**（带 query 的 URL = 新的 ESM 记录），否则会被上面 §7 已缓存的 state 影响。
  const raceHome = fsSync.mkdtempSync(path.join(os.tmpdir(), 'dispatch-itest-race-'));
  tempDirs.push(raceHome);
  fsSync.mkdirSync(path.join(raceHome, 'profiles', 'desktop'), { recursive: true });
  const raceRuntime = await import(`${libUrl('runtime.js')}?race=${Date.now()}`);
  /** 宿主的 settings 服务是异步的（要读盘），这条 await 就是上面那个窗口。 */
  const raceSettings = {
    async prepareDocument() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return path.join(raceHome, 'profiles', 'desktop', 'cordis.patch.yml');
    },
  };
  const raceCtx = { get: (name) => (name === 'settings' ? raceSettings : void 0) };
  await Promise.all([raceRuntime.loadConfig(raceCtx), raceRuntime.getConfigPath(raceCtx)]);
  /** 旧实现没有 notes()：那时信息与故障确实同通道，回退到 diagnostics() 正是当时的事实。 */
  const raceNotes = typeof raceRuntime.notes === 'function' ? raceRuntime.notes() : raceRuntime.diagnostics();
  const raceProblems = raceRuntime.diagnostics();

  check('诊断通道：一切正常时故障通道为空（截图里的红色假警报）', () => (
    raceProblems.length === 0 ? true : `故障通道里有 ${raceProblems.length} 条：${raceProblems.join(' | ')}`
  ));
  check('诊断通道：并发定位 DSH 主目录/配置文件各只记一条（不是两条）', () => {
    const home = raceNotes.filter((line) => line.startsWith('DSH 主目录'));
    const file = raceNotes.filter((line) => line.startsWith('配置文件'));
    if (home.length !== 1) return `「DSH 主目录」记了 ${home.length} 条：${home.join(' | ')}`;
    if (file.length !== 1) return `「配置文件」记了 ${file.length} 条：${file.join(' | ')}`;
    if (!file[0].includes(raceHome)) return `配置路径没落在临时目录里：${file[0]}`;
    return true;
  });

  // 另一种时序：`prepareDocument()` 命中缓存、在同一个 tick 里结算 —— 两次记录会**连在一起**，
  // 也就是用户截图里看到的「主目录 ×2，然后 配置文件 ×2」那种形状（另一种时序是交错排列）。
  // 两种都得只有一条，所以两种都测。
  const raceTick = await import(`${libUrl('runtime.js')}?race-tick=${Date.now()}`);
  const raceTickSettings = { async prepareDocument() { return path.join(raceHome, 'profiles', 'desktop', 'cordis.patch.yml'); } };
  const raceTickCtx = { get: (name) => (name === 'settings' ? raceTickSettings : void 0) };
  await Promise.all([raceTick.loadConfig(raceTickCtx), raceTick.getConfigPath(raceTickCtx)]);
  check('诊断通道：同 tick 结算时也不重复（截图里那种连在一起的两行）', () => {
    const tickNotes = typeof raceTick.notes === 'function' ? raceTick.notes() : raceTick.diagnostics();
    const paths = tickNotes.filter((line) => line.startsWith('DSH 主目录') || line.startsWith('配置文件'));
    if (paths.length !== 2) return `期望 2 条（主目录 1 + 配置文件 1），实得 ${paths.length} 条：${paths.join(' | ')}`;
    if (raceTick.diagnostics().length !== 0) return `故障通道非空：${raceTick.diagnostics().join(' | ')}`;
    return true;
  });

  // 用**真的** dsh-commands 服务（不是替身）：只有真注册表才有作用域分层，
  // 「/team 只属于调度模式」这条边界必须靠真分层来验证。
  const CommandRuntime = (await import('@deepseek-ai/dsh-commands')).default;
  const fakeWebServer = { routes: [], register(route) { this.routes.push(route); return () => {}; } };
  /** 每个 preset 作用域 → preset id（模拟官方 `agentPresets.composedPreset(ctx)` 的返回：**字符串**）。 */
  const presetIdByScope = new Map();
  const fakeAgentPresets = {
    composedPreset(agentCtx) { return presetIdByScope.get(scopePkg.scopeOf(agentCtx)); },
  };
  root.plugin(CommandRuntime, {});
  root.plugin({
    name: 'fake-host-services',
    apply(ctx) {
      ctx.provide('webServer', fakeWebServer);
      ctx.provide('agentPresets', fakeAgentPresets);
      ctx.provide('logger', { warn() {}, info() {}, error() {} });
      // 附件准入需要它（dsh-commands/lib/types/index.js:333 `ctx.get('attachments')`；
      // 缺了会返回「no attachment store is composed」而不是走准入）。
      // 本用例只提交 file 类型，admitCommandAttachments 对 file 不碰 store，故空对象足够。
      ctx.provide('attachments', {});
    },
  });
  await tick();
  if (root.get('commands') === undefined) {
    console.error('[integration-test] 真 commands 服务没起来，官方 API 形状可能变了。');
    process.exit(2);
  }

  const indexModule = await import(libUrl('index.js'));
  const presetModule = await import(libUrl('preset.js'));
  const appliedBefore = root.get('tools').view(KEY.lead).visible.size;

  /**
   * 复刻**官方 loader 下的 ctx 语义**：属性访问一个不在本 fiber inject 列表里的服务会抛
   * `cannot get property "x" without inject`（cordis reflect 代理的 internal/get 只沿**祖先** fiber
   * 的 store 往上找；宿主平面的 commands/tools 是兄弟 fiber 提供的，所以找不到）。
   *
   * 为什么必须这样测：2026-09-28 的真实故障就是 `lib/index.js` 用 `ctx.commands` / `ctx.tools`
   * 属性访问宿主平面服务，异常被 try/catch 吞成一条 warn → 插件照常加载、配置页照常可用，
   * 只是 `/team` 与两个开关工具**一个都不存在**（用户看到的是「输入 /team 没有这个指令」）。
   * 而普通的 root ctx 上属性访问是通的（无 loader 时 cordis 走 reflect.get 兜底），
   * 所以**不带这层守卫的测试会给出假绿灯** —— 这正是它第一次没被测出来的原因。
   * @param target - 真实 ctx。
   * @param allowed - 允许属性访问的服务名（等价于该 fiber 的 inject 列表）。
   */
  const GUARDED_SERVICES = ['commands', 'tools', 'systemPrompt', 'agentTeams', 'agents', 'settings', 'llm', 'webServer', 'skills', 'agentPresets'];
  const loaderLikeCtx = (target, allowed) => new Proxy(target, {
    get(object, prop, receiver) {
      if (typeof prop === 'string' && GUARDED_SERVICES.includes(prop) && !allowed.includes(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`);
      }
      return Reflect.get(object, prop, receiver);
    },
  });

  // 本插件行只声明了 webServer（与 cordis.patch.yml / INTERFACES 现状一致）。
  indexModule.apply(loaderLikeCtx(root, ['webServer']), {});
  await tick();
  await tick();
  await tick();

  const route = fakeWebServer.routes.find((candidate) => candidate.kind === 'exact' && candidate.path === '/zws-dispatch-agent-team/api');
  const commands = root.get('commands');
  const commandNames = (scopeKey) => commands.list(scopeKey).map((descriptor) => descriptor.name);
  const toolExists = (name, scopeKey) => root.get('tools').get(name, scopeKey) !== undefined;

  check('host apply()：注册了配置页路由，且没打挂已有的工具注册面', () => {
    if (route === undefined) return `没有注册 /zws-dispatch-agent-team/api，已注册：${JSON.stringify(fakeWebServer.routes)}`;
    if (typeof route.handler !== 'function') return 'route.handler 不是函数';
    if (root.get('tools').view(KEY.lead).visible.size < appliedBefore) return 'apply() 反而弄丢了工具';
    return true;
  });

  // 问「宿主半有没有把它注册进全局层」，要用一个**没有任何作用域层**的 key：
  // 传 KEY.lead 会连测试自己铺的 preset 夹具一起看到（夹具里正好有同名的 deny-target）。
  const GLOBAL_ONLY = { name: 'no-scope-layer' };
  check('边界：宿主半**不再**注册控制面（全局层里不该有 /team 或开关工具）', () => {
    const globalTools = [...root.get('tools').view(GLOBAL_ONLY).visible.keys()];
    for (const name of ['enable_agent_team', 'disable_agent_team']) {
      if (globalTools.includes(name)) {
        return `全局层出现了 ${name} —— 每一个 preset 的会话都会看到它，这正是要修掉的越界`;
      }
    }
    const globalNames = commands.list(GLOBAL_ONLY).map((descriptor) => descriptor.name);
    if (globalNames.includes('team')) return `全局层出现了 team 命令：${globalNames.join(', ')}`;
    return true;
  });

  // ── 建两个 preset：调度模式（跑 apply）与另一个 preset（什么都不跑） ─────────
  // 两者都挂在 `KEY_OFFICIAL` 这个「宿主层」下面：它就是官方 `tool-agent-team` 行所在的位置
  // （九个官方工具 + 官方 `team:policy` 段在那里注册，所有 preset 都能继承到）。
  const KEY_OFFICIAL = { name: 'official-team-plane' };
  const officialScope = createScope(root, KEY_OFFICIAL);
  const KEY_DISPATCH = { name: 'preset-dispatch' };
  const KEY_OTHER = { name: 'preset-other' };
  const dispatchPresetScope = createScope(root, KEY_DISPATCH, { parent: KEY_OFFICIAL });
  const otherPresetScope = createScope(root, KEY_OTHER, { parent: KEY_OFFICIAL });
  const KEY_DISPATCH_AGENT = { name: 'dispatch-agent' };
  const KEY_OTHER_AGENT = { name: 'other-agent' };
  const dispatchAgentScope = createScope(root, KEY_DISPATCH_AGENT, { parent: KEY_DISPATCH });
  const otherAgentScope = createScope(root, KEY_OTHER_AGENT, { parent: KEY_OTHER });
  presetIdByScope.set(KEY_DISPATCH_AGENT, 'dispatch-mode');
  presetIdByScope.set(KEY_OTHER_AGENT, 'minimal-grayscale');

  // ── 官方团队面的替身：宿主层注册九个官方工具 + 官方 `team:policy` 策略段 ──────
  // 为什么要有它：官方 `tool-agent-team` 行就是这么注册的（九工具 + `name: "team:policy"`，
  // order = TEAM_POLICY 槽位）。本轮之前我们靠 bundle patch 里 `- id: tool-agent-team, disabled: true`
  // 去关那一行 —— 2026-09-28 实测那是**顺序依赖**的（官方 bundle 用 `insert` 新建该行，我们的层若在它
  // 之前就静默失效），所以改成在**调度模式的 preset 作用域**里抑制。这个替身就是用来证明那条抑制真的发生，
  // 而且**没有越界**（别的 preset 仍应看得到官方工具与官方策略段）。
  const OFFICIAL_POLICY_TEXT = 'OFFICIAL TEAM POLICY: you are the Team Lead — create teammates with spawn_teammate, coordinate through team tasks.';
  const officialTools = officialScope.ctx.get('tools');
  const officialSp = officialScope.ctx.get('systemPrompt');
  for (const name of roster.TEAM_TOOL_NAMES) officialTools.register(syntheticTool(name));
  officialSp.section({
    name: roster.OFFICIAL_TEAM_POLICY_SECTION,
    order: officialSp.getSectionOrder('TEAM_POLICY'),
    text: OFFICIAL_POLICY_TEXT,
  });

  // 只有调度模式的 preset 子树跑我们的 apply。preset 行在官方 loader 里声明 inject: ['systemPrompt']
  // （见 preset.js 的 export const inject），所以这里用同样的守卫+允许清单，才与生产一致。
  presetModule.apply(loaderLikeCtx(dispatchPresetScope.ctx, ['systemPrompt']));
  await tick();
  await tick();
  await tick();

  check('边界：调度模式会话能看到 /team（preset 层注册生效）', () => {
    const names = commandNames(KEY_DISPATCH_AGENT);
    if (!names.includes('team')) return `调度模式会话看不到 /team，实际命令：${names.join(', ') || '(无)'}`;
    if (commands.find(KEY_DISPATCH_AGENT, 'team') === undefined) return 'commands.find 取不到 team';
    return true;
  });

  check('边界：别的 preset 会话**看不到** /team（这就是用户实测到的越界，现在必须为 false）', () => {
    const names = commandNames(KEY_OTHER_AGENT);
    if (names.includes('team')) return `非调度模式会话竟然能看到 /team：${names.join(', ')}`;
    if (commands.find(KEY_OTHER_AGENT, 'team') !== undefined) return 'commands.find 在非调度模式会话里也能取到 team';
    return true;
  });

  check('边界：开关工具 enable/disable_agent_team 同样只在调度模式会话可见', () => {
    for (const name of ['enable_agent_team', 'disable_agent_team']) {
      if (!toolExists(name, KEY_DISPATCH_AGENT)) return `调度模式会话看不到 ${name}`;
      if (toolExists(name, KEY_OTHER_AGENT)) return `非调度模式会话竟然能看到 ${name}`;
    }
    return true;
  });

  // 官方九工具与我们**同名**，而且官方把它们装进**每个 agent 自己的作用域**
  // （dsh-experimental-tool-agent-team/lib/index.js:539-546 的 maybeInstall + 域服务 tryMembership
  // 对任意非子代理 agent 返回 lead 身份 :397-426）。所以：
  //   * preset 作用域的 `tools.restrict` **摘不掉**它们（restrict 只认全局层的名字，官方报错原文
  //     `names unknown global tool "x"` —— 2026-09-28 用户看到的那 9 条红字就是这么来的）；
  //   * 唯一确定的做法是在 profile patch 层把官方那一行**整行关掉**（tools/repair.cjs 维护）。
  // 下面两条断言把「为什么必须关」钉住：同名同作用域注册会抛错，装不上就是角色/模型参数全丢。
  check('同作用域重复注册同名工具会抛错（这就是必须关掉官方 tool-agent-team 行的原因）', () => {
    const probeScope = createScope(root, { name: 'dup-probe-agent' });
    const scoped = probeScope.ctx.get('tools');
    const name = 'spawn_teammate';
    scoped.register(syntheticTool(name));
    try {
      scoped.register(syntheticTool(name));
      return '第二次注册同名工具竟然成功了 —— 与官方注释（registered only in an exact Agent scope）不符，需重读 dsh-tools';
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      return /already registered|duplicate/iu.test(message) ? true : `抛错了但文案不是「同名已注册」：${message.slice(0, 160)}`;
    }
  });

  {
    // 复刻现场：官方 tool-agent-team 行开着时，那九个名字已经在本会话的 agent 作用域里。
    // 期望：我们的 enable 给出**可执行的故障**（进红色通道 + 告诉用户跑 repair.cjs），而不是静默降级。
    for (const name of roster.TEAM_TOOL_NAMES) dispatchAgentScope.ctx.get('tools').register(syntheticTool(name));
    const collisionLead = { id: 'collision-lead', ctx: agentCtx(dispatchAgentScope.ctx), options: {} };
    agents.push(collisionLead);
    membershipById.set(collisionLead.id, { root: collisionLead, id: collisionLead.id, role: 'lead', name: 'lead' });
    const collisionResult = await runtime.enable(root, collisionLead, { source: 'integration-test' });
    const ringAfterCollision = runtime.diagnostics().join(' | ');
    const textAfterCollision = (collisionResult.diagnostics ?? []).join('；');
    // 收拾现场，免得影响后面的检查（agent 会离开列表，directives 也随之回卷）。
    runtime.disable(root, collisionLead);
    agents.pop();
    membershipById.delete(collisionLead.id);
    check('官方工具占住 agent 作用域时：我们的 enable 报可执行故障（不是静默降级）', () => {
      if (!/repair\.cjs/u.test(textAfterCollision)) return `故障诊断里没有给出修法（repair.cjs）：${textAfterCollision.slice(0, 200)}`;
      if (!/团队工具注册失败/u.test(ringAfterCollision)) return `故障没有进红色通道（页面上会看不到）：${ringAfterCollision.slice(-200)}`;
      return true;
    });
  }

  // 段名遮蔽是「最近同名段胜出」：调度模式的 preset 作用域注册同名空段 → 官方那段被 renderPrompt 丢掉。
  const dispatchPromptWithOfficial = await promptOf(KEY_DISPATCH_AGENT);
  const otherPromptWithOfficial = await promptOf(KEY_OTHER_AGENT);
  /** 从 PLAYBOOK 里取一段标记文本（不写死内容，改文案时这条断言自动跟着走）。 */
  const playbookMarker = (playbook.PLAYBOOK.split('\n').find((line) => line.trim().length > 12) ?? '').trim();
  check('边界：官方 team:policy 段不进调度模式的提示词，别的 preset 照旧有', () => {
    if (dispatchPromptWithOfficial.includes(OFFICIAL_POLICY_TEXT)) return '调度模式提示词里仍有官方 Team Lead 方法论段（叠加了两份方法论）';
    if (!otherPromptWithOfficial.includes(OFFICIAL_POLICY_TEXT)) return '别的 preset 的提示词里官方策略段也被吃掉了（遮蔽越界）';
    if (playbookMarker === '' || !dispatchPromptWithOfficial.includes(playbookMarker)) {
      const probes = ['调度模式', 'researcher', 'frontier-auditor', 'Lead', '队员'];
      const hits = probes.filter((probe) => dispatchPromptWithOfficial.includes(probe));
      return `调度模式提示词里没有我们的 PLAYBOOK（标记：${playbookMarker.slice(0, 40)}…；`
        + `命中探针=${hits.join(',') || '(无)'}；提示词长度=${dispatchPromptWithOfficial.length}`
        + `；实际内容=${JSON.stringify(dispatchPromptWithOfficial.slice(0, 120))}）—— 遮蔽把不该遮的也遮了`;
    }
    return true;
  });

  check('命令交互：只注册 /team，**没有** /team-off', () => {
    const names = commandNames(KEY_DISPATCH_AGENT);
    if (names.includes('team-off')) return '/team-off 仍然被注册了（用户明确要求去掉）';
    if (commands.find(KEY_DISPATCH_AGENT, 'team-off') !== undefined) return 'commands.find 能取到 team-off';
    return true;
  });

  {
    // 让「另一个 preset」的那条会话尝试开团队：控制面本来就看不到，
    // 这里直接调 runtime.enable，验证第二道闸（preset 边界）也会拦住。
    const otherAgent = { id: 'other-preset-agent', ctx: agentCtx(otherAgentScope.ctx), options: {} };
    agents.push(otherAgent);
    membershipById.set(otherAgent.id, { root: otherAgent, id: otherAgent.id, role: 'lead', name: 'lead' });
    const refused = await runtime.enable(root, otherAgent, { source: 'integration-test' });
    check('runtime.enable 拒绝非调度模式会话，且提示怎么写对', () => {
      if (refused.ok === true) return 'enable 竟然成功了 —— preset 边界没生效';
      const text = (refused.diagnostics ?? []).join('；');
      if (!text.includes('minimal-grayscale')) return `诊断里没有说明当前 preset：${text}`;
      if (!text.includes('调度模式')) return `诊断里没有给出该怎么做：${text}`;
      return true;
    });
  }

  /** 造一个最小的 req/res，然后走真实路由 handler。 */
  async function callApi(method, headers, payload) {
    const req = new EventEmitter();
    req.method = method;
    req.headers = headers;
    const res = {
      status: 0,
      body: '',
      writeHead(status) { this.status = status; },
      end(text) { this.body = text; },
    };
    setImmediate(() => {
      req.emit('data', Buffer.from(JSON.stringify(payload === undefined ? {} : payload), 'utf8'));
      req.emit('end');
    });
    await route.handler(req, res);
    let parsed;
    try { parsed = JSON.parse(res.body); } catch { parsed = undefined; }
    return { status: res.status, payload: parsed };
  }
  const GATE = { 'x-dsh-plugin': 'zws-dispatch-agent-team' };

  const got = await callApi('POST', GATE, { op: 'get' });
  check('GET op：返回 12 个角色 + 配置 + revision', () => {
    if (got.status !== 200) return `status=${got.status}`;
    if (got.payload === undefined || got.payload.ok !== true) return JSON.stringify(got.payload);
    if (!Array.isArray(got.payload.roles) || got.payload.roles.length !== roster.ROLES.length) {
      return `roles 数量 ${got.payload.roles === undefined ? '(无)' : got.payload.roles.length}，应为 ${roster.ROLES.length}`;
    }
    if (typeof got.payload.revision !== 'string') return `revision=${JSON.stringify(got.payload.revision)}`;
    return true;
  });

  // 页面看到的那一份必须和上面的通道划分一致：正常事实（DSH 主目录 / 配置文件路径 /
  // 团队开关 / 安装回执）不许出现在故障通道里 —— 那正是用户截图里那 5 行的错位。
  check('GET op：正常事实不在故障通道里、信息走 notes（截图那 5 行的正确归属）', () => {
    if (got.payload === undefined || got.payload.ok !== true) return JSON.stringify(got.payload);
    const problems = got.payload.diagnostics;
    if (!Array.isArray(problems)) return `diagnostics 不是数组：${JSON.stringify(problems)}`;
    // 本轮测试**故意**制造过故障（preset 子树降级注册、官方工具占名），所以这里不能断言
    // 「一条都没有」；断言的是那几类**纯信息**不许漏进故障通道。
    // 注意 `Lead …` / `队员 …` 两个前缀**两条通道都可能出现**：装好了的记录是信息（回执），
    // 装不上（同名工具被占）是真的故障 —— 后者必须留在红色通道里，所以这里不把它们算漏。
    const leaked = problems.filter((line) => typeof line === 'string'
      && (/^(DSH 主目录|配置文件)[:：]/u.test(line) || line.startsWith('团队已')));
    if (leaked.length > 0) return `正常事实漏进故障通道：${leaked.join(' | ')}`;
    const hostNotes = got.payload.notes;
    if (!Array.isArray(hostNotes) || hostNotes.length === 0) return `notes 为空：${JSON.stringify(hostNotes)}`;
    if (!hostNotes.some((line) => typeof line === 'string' && line.startsWith('配置文件：'))) {
      return `notes 里没有配置文件路径：${hostNotes.join(' | ')}`;
    }
    if (!hostNotes.some((line) => typeof line === 'string' && line.startsWith('团队已开启'))) {
      return `notes 里没有「团队已开启」这条回执：${hostNotes.join(' | ')}`;
    }
    return true;
  });

  const badGate = await callApi('POST', {}, { op: 'get' });
  check('缺少闸门头 → 403（CSRF 主闸生效）', () => (badGate.status === 403 ? true : `status=${badGate.status}`));

  const badMethod = await callApi('GET', GATE, { op: 'get' });
  check('非 POST → 405', () => (badMethod.status === 405 ? true : `status=${badMethod.status}`));

  const badRole = await callApi('POST', GATE, { op: 'set', args: { roles: { nope: { provider: 'a', model: 'b' } } } });
  check('未知角色 id → 明确拒绝（不静默丢掉）', () => (badRole.payload !== undefined && badRole.payload.ok === false ? true : JSON.stringify(badRole.payload)));

  const halfRoute = await callApi('POST', GATE, { op: 'set', args: { roles: { scout: { provider: 'a' } } } });
  check('provider/model 只给一半 → 拒绝（不猜路由）', () => (halfRoute.payload !== undefined && halfRoute.payload.ok === false ? true : JSON.stringify(halfRoute.payload)));

  const saved = await callApi('POST', GATE, {
    op: 'set',
    args: { roles: { scout: { provider: 'p', model: 'm' } }, revision: got.payload.revision },
  });
  check('带正确 revision 保存 → ok，并回传新的 revision', () => {
    if (saved.payload === undefined || saved.payload.ok !== true) return JSON.stringify(saved.payload);
    if (typeof saved.payload.revision !== 'string' || saved.payload.revision === '') return `revision=${JSON.stringify(saved.payload.revision)}`;
    if (saved.payload.config.roles.scout.model !== 'm') return JSON.stringify(saved.payload.config);
    return true;
  });

  const stale = await callApi('POST', GATE, {
    op: 'set',
    args: { roles: { scout: { provider: 'p2', model: 'm2' } }, revision: got.payload.revision },
  });
  check('带过期 revision 保存 → conflict:true 且不写入', () => {
    if (stale.payload === undefined || stale.payload.conflict !== true) return JSON.stringify(stale.payload);
    return true;
  });

  const afterStale = await callApi('POST', GATE, { op: 'get' });
  check('conflict 之后磁盘上的值没被覆盖（仍是 p/m，不是 p2/m2）', () => {
    const roles = afterStale.payload.config.roles;
    return roles.scout !== undefined && roles.scout.model === 'm'
      ? true
      : `磁盘上是 ${JSON.stringify(roles.scout)}`;
  });

  const noRevision = await callApi('POST', GATE, { op: 'set', args: { roles: {} } });
  check('不带 revision 的调用方仍可保存（旧客户端/脚本不被这条闸门挡住）', () => (noRevision.payload !== undefined && noRevision.payload.ok === true ? true : JSON.stringify(noRevision.payload)));

  const reset = await callApi('POST', GATE, { op: 'reset' });
  check('reset → ok 且清空所有角色配置', () => {
    if (reset.payload === undefined || reset.payload.ok !== true) return JSON.stringify(reset.payload);
    if (Object.keys(reset.payload.config.roles).length !== 0) return JSON.stringify(reset.payload.config);
    return true;
  });

  const unknownOp = await callApi('POST', GATE, { op: 'no-such-op' });
  check('未知 op → {ok:false} 而不是挂住连接', () => (unknownOp.payload !== undefined && unknownOp.payload.ok === false ? true : JSON.stringify(unknownOp.payload)));

  const bigBody = await callApi('POST', GATE, { op: 'set', args: { roles: {}, pad: 'x'.repeat(1024 * 1024 + 10) } });
  check('超过 1 MiB 的请求体 → 明确拒绝（不是 OOM 或挂住）', () => {
    if (bigBody.payload === undefined || bigBody.payload.ok !== false) return JSON.stringify(bigBody.payload);
    return /过大|too large/.test(String(bigBody.payload.error)) ? true : `error=${bigBody.payload.error}`;
  });

  // ── 缓存保活（lib/cache.js）：真 cordis 瀑布 + 真控制器 + 替身 llm ──────────
  //
  // 这里不碰真模型（测试环境没有 key），但走的是**真代码路径**：观察器注册进真 cordis、
  // 由真 `ctx.waterfall('llm/stream', …)` 触发、控制器用自己的定时器与 decision 函数。
  // 时间用注入的假时钟，所以「到点才 ping」这类断言是确定的，不靠 sleep。
  console.log('');
  console.log('缓存保活（lib/cache.js：观察器 + 控制器）');

  const cache = await import(libUrl('cache.js'));

  /** 造一段假流（chunk 形状对齐 dsh-llm 的 stream 协议）。 */
  const fakeStream = (usage) => (async function* fake() {
    yield { type: 'text', text: 'x' };
    if (usage !== undefined) yield { type: 'usage', usage };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();

  const LEAD_SYSTEM = `${playbook.LEAD_MARKER}\n\n（集成测试用的 Lead 系统提示词）`;
  const MATE_SYSTEM = `${playbook.TEAMMATE_MARKER}\n\n（集成测试用的队员系统提示词）`;
  const leadOptions = (system = LEAD_SYSTEM) => ({
    provider: 'our-free-model',
    model: 'space-bunny-free',
    system,
    tools: [{ name: 'read' }, { name: 'edit' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 4096,
    reasoningEffort: 'high',
  });

  const calls = [];
  let llmUsage = { inputTokens: 100, cacheReadTokens: 900, outputTokens: 5 };
  const llmStub = {
    stream(options) {
      calls.push(options);
      return fakeStream(llmUsage);
    },
  };

  let clock = 1_000_000;
  let waiters = 0;
  const timers = [];
  const ka = cache.createKeepalive({
    log: () => {},
    note: () => {},
    llmOf: () => llmStub,
    waitersOf: () => waiters,
    overridesOf: () => ({}),
    leadMarker: playbook.LEAD_MARKER,
    teammateMarker: playbook.TEAMMATE_MARKER,
    now: () => clock,
    setTimeoutFn: (callback, delay) => {
      const handle = { callback, delay, unref() {} };
      timers.push(handle);
      return handle;
    },
    clearTimeoutFn: (handle) => {
      const at = timers.indexOf(handle);
      if (at >= 0) timers.splice(at, 1);
    },
    random: () => 0.5,
  });

  /** 跑掉最早的那个假定时器（= 控制器到点复查），并等 ping 的异步流程走完。 */
  const fireTimer = async () => {
    const handle = timers.shift();
    if (handle === undefined) return false;
    handle.callback();
    // tick() 内部是 `void tick()`（不 await），ping 自己还要 for await 假流 —— 多等几轮。
    for (let round = 0; round < 8; round += 1) await tick();
    return true;
  };

  const offObserver = ka.observe(preset.ctx);
  ka.attach({ agentId: leadAgent.id, sessionId: 'session-1' });

  // A) 真 cordis 瀑布：监听器必须被调用，且下游流逐字通过
  //
  // 注意：这里刻意**在子作用域（preset.ctx）注册**、从**父作用域（root）派发** —— 这正是生产里的形状：
  // 插件在 `apply(ctx)` 拿到的 ctx 上注册，而 dsh-llm 在自己的 ctx 上
  // `this.ctx.waterfall(this, "llm/stream", …)` 派发（`thisArg` 是 Llm 服务实例，不带作用域过滤器）。
  // cordis 的 dispatch 是「hook.global || !filter || filter(...)」——没有过滤器就**全局广播**，
  // 所以子作用域的监听器也能收到。这条断言就是那个前提的闸门（官方哪天给 llm/stream 加上
  // 作用域过滤，这里会立刻红）。
  await (async () => {
    const options = leadOptions();
    const downstream = root.waterfall('llm/stream', options, () => fakeStream({ inputTokens: 100, cacheReadTokens: 900, outputTokens: 5 }));
    const chunks = [];
    for await (const chunk of downstream) chunks.push(chunk.type);
    check('真 cordis 瀑布 llm/stream：子作用域注册的观察器收得到父作用域派发，且不改变 chunk 顺序', () => (chunks.join(',') === 'text,usage,finish' ? true : `chunks=${chunks.join(',')}`));
  })();

  check('观察器抓 Lead 请求并把 usage 折进统计（auto 模式因此被"证明"才允许保活）', () => {
    const snapshot = ka.stats();
    if (snapshot.stats.requests !== 1) return `requests=${snapshot.stats.requests}`;
    if (snapshot.stats.cacheReadTokens !== 900) return `cacheReadTokens=${snapshot.stats.cacheReadTokens}`;
    if (snapshot.armed !== true) return '线路报告了缓存命中，armed 仍为 false';
    const ratio = snapshot.stats.hitRatio;
    if (!(ratio > 0.89 && ratio < 0.91)) return `hitRatio=${ratio}`;
    return true;
  });

  check('队员请求完全旁路（不抓前缀、不包装、不产生任何 llm 调用）', () => {
    const before = calls.length;
    const mateStream = fakeStream({ inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 });
    const returned = ka.handleStream(leadOptions(MATE_SYSTEM), () => mateStream);
    if (returned !== mateStream) return '队员请求被包装了（应当原样返回 next()）';
    if (calls.length !== before) return '队员请求触发了 llm 调用';
    return true;
  });

  // B) 到点 ping：maxTokens=1、前缀逐字相同、只多一条尾部 user 消息
  await (async () => {
    clock += 300_000; // 超过 210s 间隔
    waiters = 1;      // 真的有队员在跑（否则不该 ping）
    if (!(await fireTimer())) {
      check('到点发 ping（maxTokens=1 + 尾部消息，前缀逐字相同）', () => '没有排到定时器');
      return;
    }
    check('到点发 ping（maxTokens=1 + 尾部消息，前缀逐字相同）', () => {
      // 注意：真实请求走的是 `next()` 回调（上一步那个），所以 calls 里只会有 ping。
      if (calls.length !== 1) return `ping 次数=${calls.length}（期望 1）`;
      const ping = calls[0];
      if (ping.maxTokens !== 1) return `maxTokens=${ping.maxTokens}`;
      if (ping.provider !== 'our-free-model' || ping.model !== 'space-bunny-free') return `路由被改了：${ping.provider}/${ping.model}`;
      if (ping.reasoningEffort !== undefined) return 'ping 不该带 reasoningEffort（1 token 上限在推理模型上会翻车）';
      if (JSON.stringify(ping.tools) !== JSON.stringify(leadOptions().tools)) return 'ping 的工具目录与真实请求不一致（前缀就不一样了）';
      if (ping.system !== LEAD_SYSTEM) return 'ping 的系统提示词与真实请求不一致';
      if (ping.messages.length !== 2) return `messages=${ping.messages.length}（期望 前缀 1 条 + 尾部 1 条）`;
      const tail = ping.messages[ping.messages.length - 1];
      if (tail.role !== 'user') return `尾部消息 role=${tail.role}`;
      if (ping.messages[0].content[0].text !== 'hi') return '前缀被改动了';
      return true;
    });
    check('ping 自己不会被再抓一次（重入保护）', () => (ka.stats().stats.requests === 1 ? true : `requests=${ka.stats().stats.requests}`));
    check('ping 的 token 计入 pingTokens，命中计入 pingHits', () => {
      const snapshot = ka.stats();
      if (snapshot.stats.pings !== 1) return `pings=${snapshot.stats.pings}`;
      if (snapshot.stats.pingHits !== 1) return `pingHits=${snapshot.stats.pingHits}`;
      if (snapshot.pingTokens !== 1000) return `pingTokens=${snapshot.pingTokens}`;
      return true;
    });
  })();

  // C) 连续未命中 → 停（不是"缩短间隔继续烧"，那正是上游的毛病）
  await (async () => {
    llmUsage = { inputTokens: 800, cacheReadTokens: 0, outputTokens: 1 };
    clock += 300_000;
    await fireTimer();
    clock += 300_000;
    await fireTimer();
    const stoppedCorrectly = ka.stats().stopped === 'repeated-misses';
    const before = calls.length;
    clock += 300_000;
    const fired = timers.shift();
    if (fired !== undefined) fired.callback();
    for (let round = 0; round < 8; round += 1) await tick();
    check('连续 2 次 ping 未命中 → 停掉保活（不再发第三次）', () => {
      if (!stoppedCorrectly) return `stopped=${ka.stats().stopped}`;
      if (calls.length !== before) return '停掉之后仍然发了请求';
      return true;
    });
  })();

  // D) auto 模式的闸门：线路没证明过缓存命中 → 到期也不 ping
  await (async () => {
    const fresh = cache.createKeepalive({
      log: () => {}, note: () => {},
      llmOf: () => llmStub,
      waitersOf: () => 1,
      overridesOf: () => ({}),
      leadMarker: playbook.LEAD_MARKER,
      teammateMarker: playbook.TEAMMATE_MARKER,
      now: () => clock,
      setTimeoutFn: (callback, delay) => {
        const handle = { callback, delay, unref() {} };
        timers.push(handle);
        return handle;
      },
      clearTimeoutFn: (handle) => {
        const at = timers.indexOf(handle);
        if (at >= 0) timers.splice(at, 1);
      },
      random: () => 0.5,
    });
    fresh.attach({ agentId: leadAgent.id, provider: 'our-free-model', model: 'space-bunny-free' });
    llmUsage = { inputTokens: 500, cacheReadTokens: 0, outputTokens: 1 };
    const before = calls.length;
    // 第一次真实请求：没有任何缓存命中 → auto 不 arm（这次请求走 next() 回调，不进 calls）
    for await (const _chunk of fresh.handleStream(leadOptions(), () => fakeStream(llmUsage))) { /* 消费掉 */ }
    clock += 600_000;
    await fireTimer();
    check('auto 模式：线路还没报告过缓存命中 → 到期也不 ping（不白花钱）', () => {
      if (calls.length !== before) return `多发了 ${calls.length - before} 次请求（期望 0）`;
      if (fresh.stats().armed !== false) return 'auto 模式不该在无命中证据时 arm';
      return true;
    });
    fresh.detach('test-done');
  })();

  check('runtime.installKeepalive：接线可用（幂等，返回快照）', () => {
    const snapshot = runtime.installKeepalive(root);
    if (snapshot.installed !== true) return JSON.stringify(snapshot);
    const again = runtime.keepaliveStats();
    if (again.installed !== true) return JSON.stringify(again);
    return true;
  });

  // E) 偶发 ping 失败 → 停；下一个真实请求重新评估（但"连续未命中"是证据性结论，保持粘住）
  await (async () => {
    timers.length = 0;
    let failStream = false;
    const ka2Calls = [];
    const ka2 = cache.createKeepalive({
      log: () => {},
      note: () => {},
      llmOf: () => ({
        stream(options) {
          ka2Calls.push(options);
          if (failStream) throw new Error('boom');
          return fakeStream({ inputTokens: 1, cacheReadTokens: 1, outputTokens: 1 });
        },
      }),
      waitersOf: () => 1,
      overridesOf: () => ({ 'our-free-model/space-bunny-free': { mode: 'on' } }),
      leadMarker: playbook.LEAD_MARKER,
      teammateMarker: playbook.TEAMMATE_MARKER,
      now: () => clock,
      setTimeoutFn: (callback, delay) => {
        const handle = { callback, delay, unref() {} };
        timers.push(handle);
        return handle;
      },
      clearTimeoutFn: (handle) => {
        const at = timers.indexOf(handle);
        if (at >= 0) timers.splice(at, 1);
      },
      random: () => 0.5,
    });
    ka2.attach({ agentId: leadAgent.id, provider: 'our-free-model', model: 'space-bunny-free' });
    for await (const _chunk of ka2.handleStream(leadOptions(), () => fakeStream({ inputTokens: 10, cacheReadTokens: 0, outputTokens: 1 }))) { /* 消费 */ }
    failStream = true;
    clock += 300_000;
    await fireTimer();
    clock += 300_000;
    await fireTimer();
    const stopped = ka2.stats().stopped;
    // 下一个真实请求（走 next() 回调）：应当把"偶发失败"这个停止原因清掉
    for await (const _chunk of ka2.handleStream(leadOptions(), () => fakeStream(undefined))) { /* 消费 */ }
    check('偶发 ping 失败 → 停；下一个真实请求会重新评估（"连续未命中"则保持粘住）', () => {
      if (stopped !== 'ping-failed') return `stopped=${stopped}`;
      if (ka2.stats().stopped !== undefined) return '真实请求之后仍然停着（偶发失败应当可以重试）';
      return true;
    });
    ka2.detach('test-done');
  })();

  offObserver();
  ka.detach('test-done');

  // ── report_result：队员的结构化报告由插件自己投递给 Lead ─────────────────────
  console.log('');
  console.log('结构化汇报（lib/tools.js 的 report_result）');

  const toolsModule = await import(libUrl('tools.js'));
  const sentMessages = [];
  const reportRuntime = {
    peekConfig: () => runtime.peekConfig(),
    // 参数顺序是 (ctx, route)——漏掉第一个参数会把 ctx 当 route 传回去。
    preflightRoute: async (_ctx, route) => ({ ok: true, route, diagnostics: [] }),
    pinSpawnRoute: () => {},
    recordReport: (name, report) => runtime.recordReport(name, report),
    markReportDelivered: (entry, delivered) => runtime.markReportDelivered(entry, delivered),
    // 截断账本的读口也委托给真 runtime：noteTurnEndReason 是它的写入点，
    // list_agents 通过这里取值（被测的就是生产路径）。
    truncatedMemberIds: () => runtime.truncatedMemberIds(),
  };
  const reportTeams = {
    // 与真域服务同形：队员名只能从 membership 拿（ReactLoopAgent 上没有 name 字段，
    // 官方 dsh-agent-loop/lib/index.js:747-789）。report_result 的报告头靠它（2026-10-04 审查 P1-1）。
    tryMembership(agent) { return membershipById.get(agent && agent.id); },
    // 与真域服务同形：行里有 id（截断标注按 id 匹配），且状态由测试自己控制。
    // lead 记 running、两个队员记 inactive —— 正好用来验「默认广播不唤醒 inactive 队员」。
    listMembers() {
      return [
        { id: 'lead-agent', name: 'lead', role: 'lead', status: 'running', diagnostics: [] },
        { id: 'scout-agent', name: 'scout', role: 'teammate', status: 'inactive', diagnostics: [] },
        { id: 'builder-agent', name: 'builder', role: 'teammate', status: 'inactive', diagnostics: [] },
      ];
    },
    sendMessage(caller, request) {
      sentMessages.push({ caller, request });
      return { ok: true, messageId: 'team-message-test', status: 'accepted' };
    },
  };
  const memberDefinitions = toolsModule.teamToolDefinitions({ runtime: reportRuntime, agentTeams: reportTeams, include: roster.MEMBER_TEAM_TOOL_NAMES });
  const reportTool = memberDefinitions.find((definition) => definition.name === roster.REPORT_TOOL_NAME);
  const leadDefinitions = toolsModule.teamToolDefinitions({ runtime: reportRuntime, agentTeams: reportTeams });

  check('report_result 只注册给队员（Lead 的工具面里没有它）', () => {
    if (reportTool === undefined) return '队员的工具面里没有 report_result';
    if (leadDefinitions.some((definition) => definition.name === roster.REPORT_TOOL_NAME)) return 'Lead 也拿到了 report_result（应当只给队员）';
    return true;
  });

  await (async () => {
    const result = await reportTool.execute(
      {
        status: 'completed',
        summary: '改了 x.js',
        evidence: ['node -e "1+1" → 2'],
        acceptance: 'node --test → 3 passed',
        unresolved: [],
        changed_files: ['x.js'],
      },
      // 故意**不给** agent.name：生产里 Agent 对象没有这个名字字段，给了就会把
      // 「名字其实来自域服务」这条真实依赖掩盖掉（P1-1 的根因正是这个假设）。
      { agent: { id: 'scout-agent' } },
    );
    check('report_result：校验 → 记录 → 自己投递给 lead（一条固定形状的消息）', () => {
      if (result.ok !== true || result.delivered !== true) return JSON.stringify(result);
      if (sentMessages.length !== 1) return `sendMessage 调用 ${sentMessages.length} 次`;
      const message = sentMessages[0].request;
      if (message.target !== 'lead') return `target=${message.target}`;
      const text = message.content[0].text;
      if (!text.startsWith('【report_result】scout · completed')) return text.slice(0, 80);
      if (!text.includes('未决项：无')) return '完成态报告缺「未决项：无」';
      const reports = runtime.recentReports();
      const last = reports.items[reports.items.length - 1];
      if (last === undefined || last.name !== 'scout' || last.status !== 'completed') return JSON.stringify(reports.items.slice(-1));
      // 投递成功时记录里必须补上 delivered=true（2026-10-05 审查 §1-⑤ 的顺序修复）。
      if (last.delivered !== true) return `投递成功后记录里的 delivered=${String(last.delivered)}（应为 true）`;
      if (reports.dropped !== 0) return `dropped 应为 0，实为 ${reports.dropped}`;
      return true;
    });

    // 投递失败的那条路径：记录里必须留下 delivered=false，而不是显示成一条正常的报告。
    // 这正是修复前的问题——「插件页记录」与「Lead 邮箱」两套口径不一致。
    {
      const failingRuntime = {
        ...reportRuntime,
        recordReport: (name, report) => runtime.recordReport(name, report),
      };
      const failingTools = toolsModule.teamToolDefinitions({
        runtime: failingRuntime,
        agentTeams: {
          ...reportTeams,
          sendMessage() { throw new Error('mailbox full'); },
        },
        // 必须显式给队员名单：report_result 是**队员专用**，不带 include 时它连 schema 都不注册
        // （Lead 的工具目录里没有它），find 会拿到 undefined。
        include: roster.MEMBER_TEAM_TOOL_NAMES,
      });
      const failingTool = failingTools.find((definition) => definition.name === 'report_result');
      const failed = await failingTool.execute(
        { status: 'completed', summary: '投不出去', evidence: ['证据'], unresolved: [], changed_files: [] },
        { agent: { id: 'scout-agent' } },
      );
      check('report_result：投递失败时记录里留下 delivered=false（不再假显示成一条正常汇报）', () => {
        if (failed.ok !== false || failed.delivered !== false) return `ok=${String(failed.ok)} delivered=${String(failed.delivered)}`;
        const items = runtime.recentReports().items;
        const last = items[items.length - 1];
        if (last === undefined || last.name !== 'scout') return JSON.stringify(items.slice(-1));
        if (last.delivered !== false) return `delivered=${String(last.delivered)}（投递失败时必须为 false）`;
        return true;
      });
    }

    let rejected = false;
    try {
      await reportTool.execute({ status: 'completed', summary: '做完了' }, { agent: { id: 'scout-agent' } });
    } catch {
      rejected = true;
    }
    check('report_result：completed 但没有 evidence → 直接拒绝（不产生空报告）', () => (rejected ? true : '竟然通过了'));

  // ── 2026-10-04 新增三件套：broadcast_message / ask_lead / list_agents 的截断标注 ────────────
  const broadcastTool = leadDefinitions.find((definition) => definition.name === roster.BROADCAST_TOOL_NAME);
  const askTool = memberDefinitions.find((definition) => definition.name === roster.ASK_LEAD_TOOL_NAME);
  const listTool = leadDefinitions.find((definition) => definition.name === 'list_agents');
  check('新工具的注册面：broadcast 只给 Lead，ask_lead 只给队员', () => {
    if (broadcastTool === undefined) return 'Lead 的工具面里没有 broadcast_message';
    if (memberDefinitions.some((d) => d.name === roster.BROADCAST_TOOL_NAME)) return 'broadcast_message 泄漏给队员';
    if (askTool === undefined) return '队员的工具面里没有 ask_lead';
    if (leadDefinitions.some((d) => d.name === roster.ASK_LEAD_TOOL_NAME)) return 'ask_lead 泄漏给 Lead（它没有汇报对象）';
    if (listTool === undefined) return 'Lead 拿不到 list_agents';
    return true;
  });

  await (async () => {
    sentMessages.length = 0;
    const before = sentMessages.length;
    const res = await broadcastTool.execute(
      { message: '协议升级 v1.1：sticks 语义变了' },
      // caller 用真的 Lead：它自己在 fakeDomain 里是 role=lead / name=lead。
      { agent: leadAgent, signal: new AbortController().signal },
    );
    check('broadcast_message：默认只打 running/provisioning 队员，lead 与自己都不进目标', () => {
      // fakeDomain.listMembers 给的 status 恒是 inactive（测试替身没有活体），所以默认路径
      // 应该**一个都不发**并逐个给出理由 —— 这正是「不许意外把所有人拉起来」的成本闸门。
      if (res.sent.length !== 0) return `不该发的也发了：${JSON.stringify(res.sent)}`;
      if (res.ok !== false) return '零投递却返回 ok:true';
      const skipped = res.skipped.map((item) => item.target).sort();
      if (!skipped.includes('scout') || !skipped.includes('builder')) return JSON.stringify(skipped);
      // lead 既不该收到、也不该以「includeInactive」为由被跳（它是「不是队员」）。
      const leadSkip = res.skipped.find((item) => item.target === 'lead');
      if (leadSkip === undefined || !leadSkip.reason.includes('不是队员')) return JSON.stringify(leadSkip ?? null);
      if (before !== 0 || sentMessages.length !== 0) return `sendMessage 被调了 ${sentMessages.length} 次`;
      // 被成本闸门挡下的队员，理由必须给出可操作下一步。
      for (const name of ['scout', 'builder']) {
        const item = res.skipped.find((candidate) => candidate.target === name);
        if (item === undefined || !item.reason.includes('includeInactive')) return '缺可操作理由：' + JSON.stringify(item ?? null);
      }
      return true;
    });

    const res2 = await broadcastTool.execute(
      { message: '协议升级 v1.1', targets: ['scout', 'ghost-404'] },
      { agent: leadAgent, signal: new AbortController().signal },
    );
    check('broadcast_message：显式目标生效，找不到的如实报原因（不静默丢）', () => {
      if (res2.sent.length !== 1 || res2.sent[0].target !== 'scout') return JSON.stringify(res2.sent);
      if (res2.sent[0].status !== 'accepted') return JSON.stringify(res2.sent[0]);
      if (!res2.skipped.some((item) => item.target === 'ghost-404')) return JSON.stringify(res2.skipped);
      if (sentMessages.length !== 1) return `sendMessage 次数=${sentMessages.length}`;
      if (sentMessages[0].request.target !== 'scout') return `target=${sentMessages[0].request.target}`;
      if (sentMessages[0].request.content[0].text !== '协议升级 v1.1') return '正文被改写';
      return true;
    });

    const res3 = await broadcastTool.execute(
      { message: '全员注意', include_inactive: true },
      { agent: leadAgent, signal: new AbortController().signal },
    );
    check('broadcast_message：include_inactive=true 才拉起 inactive 队员（显式承担成本）', () => {
      if (res3.sent.length !== 2) return JSON.stringify(res3.sent.map((s) => s.target));
      return true;
    });

    // 显式点名的 inactive 队员不该被二次拦截（点名 = Lead 的明确决定）。
    const res4 = await broadcastTool.execute(
      { message: '只看这一条', targets: ['builder'] },
      { agent: leadAgent, signal: new AbortController().signal },
    );
    check('broadcast_message：skipped 与 failed 各自独立（被跳过≠投递失败）', () => {
      // 2026-10-04 独立探针抓出的真缺陷：早先把 skipped 也塞进 failed，而名单里**永远**有 lead 伪行，
      // 于是 failed 恒非空、ok 恒为 false —— 模型会以为广播失败并重发。
      // 这一用例里三个目标全都没发（lead 不是队员、scout/builder 都 inactive 且没开闸），
      // 所以 ok:false 是**正确**语义（一条都没送出去），关键是它们必须出现在 skipped 而**不是** failed。
      if (res.failed.length !== 0) return '被跳过的目标不该进 failed：' + JSON.stringify(res.failed);
      if (res.skipped.length !== 3) return 'lead 与两个 inactive 队员都该在 skipped：' + JSON.stringify(res.skipped);
      if (res.ok !== false) return '一条都没发出去时 ok 必须为 false（否则模型会以为广播成功）';
      return true;
    });

    // 正向情形：真的发出去至少一条时 ok 必须为 true（此时仍有 skipped，但不该影响 ok）。
    sentMessages.length = 0;
    const okTrue = await broadcastTool.execute(
      { targets: ['scout'], message: '只发给一个', include_inactive: true },
      { agent: leadAgent, signal: new AbortController().signal },
    );
    check('broadcast_message：真发成功时 ok:true，且 skipped 里仍有 lead 伪行', () => {
      if (okTrue.sent.length !== 1 || okTrue.sent[0].target !== 'scout') return JSON.stringify(okTrue.sent);
      if (okTrue.failed.length !== 0) return '不该有 failed：' + JSON.stringify(okTrue.failed);
      if (okTrue.ok !== true) return '发出去了却 ok:false';
      return true;
    });

    const emptyMsg = await broadcastTool.execute({ message: '   ' }, { agent: leadAgent, signal: new AbortController().signal })
      .then((v) => 'accepted:' + JSON.stringify(v), (e) => 'rejected:' + e.message);
    check('broadcast_message：空正文被拒（不做静默截断/不投无意义消息）', () => {
      if (!String(emptyMsg).startsWith('rejected:')) return '空白 message 竟然通过了：' + emptyMsg;
      if (!String(emptyMsg).includes('不能为空')) return String(emptyMsg).slice(0, 120);
      return true;
    });

    const hugeMsg = await broadcastTool.execute({ message: 'x'.repeat(4001) }, { agent: leadAgent, signal: new AbortController().signal })
      .then((v) => 'accepted', (e) => 'rejected:' + e.message);
    check('broadcast_message：超长正文被拒（广播会复制给每个队员，按人数放大）', () => {
      if (!String(hugeMsg).startsWith('rejected:')) return '4001 字竟然通过了';
      if (!String(hugeMsg).includes('4000')) return String(hugeMsg).slice(0, 120);
      return true;
    });
    check('broadcast_message：显式点名不受 inactive 闸门二次拦截', () => {
      if (res4.sent.length !== 1 || res4.sent[0].target !== 'builder') return JSON.stringify(res4);
      return true;
    });
    // 本段测试结束后清空投递记录，别把后面的 report_result 断言的计数污染掉。
    sentMessages.length = 0;
  })();

  await (async () => {
    sentMessages.length = 0;
    const res = await askTool.execute(
      { question: '字体栈用系统默认还是内嵌？' },
      { agent: scoutAgent, signal: new AbortController().signal },
    );
    check('ask_lead：默认阻塞、带固定前缀、投递给 lead', () => {
      if (res.ok !== true || res.delivered !== true) return JSON.stringify(res);
      if (sentMessages.length !== 1) return `sendMessage ${sentMessages.length} 次`;
      if (sentMessages[0].request.target !== 'lead') return `target=${sentMessages[0].request.target}`;
      const text = sentMessages[0].request.content[0].text;
      if (!text.startsWith('[阻塞·等答复][需 Lead 决策] 字体栈')) return text.slice(0, 60);
      if (!res.diagnostics.some((d) => d.includes('不要再自行推进'))) return JSON.stringify(res.diagnostics);
      return true;
    });

    const res2 = await askTool.execute(
      { question: '要不要顺带加导出？', blocking: false },
      { agent: scoutAgent, signal: new AbortController().signal },
    );
    const emptyQ = await askTool.execute({ question: '  ' }, { agent: scoutAgent, signal: new AbortController().signal })
      .then(() => 'accepted', (e) => 'rejected:' + e.message);
    const hugeQ = await askTool.execute({ question: 'x'.repeat(2001) }, { agent: scoutAgent, signal: new AbortController().signal })
      .then(() => 'accepted', (e) => 'rejected:' + e.message);
    check('ask_lead：空白问题与超长问题都被拒（问题该短，长背景属于报告）', () => {
      if (!String(emptyQ).startsWith('rejected:') || !String(emptyQ).includes('不能为空')) return 'empty -> ' + emptyQ;
      if (!String(hugeQ).startsWith('rejected:') || !String(hugeQ).includes('2000')) return 'huge -> ' + hugeQ;
      return true;
    });
    check('ask_lead：blocking=false 走「可继续」前缀且不附加停手指令', () => {
      if (!res2.question.startsWith('[可继续][需 Lead 决策]')) return res2.question.slice(0, 40);
      if (res2.diagnostics.length !== 0) return JSON.stringify(res2.diagnostics);
      return true;
    });

    let threw = false;
    try { await askTool.execute({ question: 'x' }, { agent: scoutAgent, signal: new AbortController().signal }); }
    catch { threw = true; }
    // check() 不 await 异步断言（见其实现），所以先把投递失败的调用跑完、再同步判定。
    const brokenTeams = {
      tryMembership: (agent) => membershipById.get(agent && agent.id),
      sendMessage() { throw new Error('TEAM_MAILBOX_FULL'); },
    };
    const brokenAsk = toolsModule.teamToolDefinitions({
      runtime: reportRuntime,
      agentTeams: brokenTeams,
      include: roster.MEMBER_TEAM_TOOL_NAMES,
    }).find((definition) => definition.name === roster.ASK_LEAD_TOOL_NAME);
    const failedAsk = await brokenAsk.execute({ question: '投递不了的测试' }, { agent: scoutAgent, signal: new AbortController().signal });
    check('ask_lead：投递失败不静默（diagnostics 指路 report_result 的 needs_decision）', () => {
      if (threw) return '正常路径不该抛错';
      if (failedAsk.ok !== false || failedAsk.delivered !== false) return JSON.stringify(failedAsk);
      if (!failedAsk.diagnostics.some((d) => d.includes('needs_decision'))) return JSON.stringify(failedAsk.diagnostics);
      return true;
    });
  })();

  // 真实链路：noteTurnEndReason 就是 session/event 监听器调的那个写入点（lib/runtime.js），
  // 测试与生产共用同一函数；list_agents 必须据此把标志并进 diagnostics。
  // check() 不 await（见其实现），所以三次调用全部先跑完，回调里只做同步判定。
  const plainRows = await listTool.execute({}, { agent: leadAgent, signal: new AbortController().signal });
  runtime.noteTurnEndReason('scout-agent', 'max-tokens');
  const markedRows = await listTool.execute({}, { agent: leadAgent, signal: new AbortController().signal });
  runtime.noteTurnEndReason('scout-agent', 'completed');
  const clearedRows = await listTool.execute({}, { agent: leadAgent, signal: new AbortController().signal });
  check('list_agents 把截断标志并入 diagnostics（Lead 据此选 wake_teammate 而非 send_message）', () => {
    const findScout = (rows) => rows.find((row) => row.target === 'scout');
    const before = findScout(plainRows);
    const after = findScout(markedRows);
    const done = findScout(clearedRows);
    if (before === undefined || after === undefined || done === undefined) return JSON.stringify(markedRows.map((row) => row.target));
    if ((before.diagnostics || []).length !== 0) return '记账前就有 diagnostics：测试前提不成立';
    if (!after.diagnostics.some((d) => d.includes('wake_teammate'))) return JSON.stringify(after.diagnostics);
    const builder = markedRows.find((row) => row.target === 'builder');
    if (builder === undefined || (builder.diagnostics || []).length !== 0) return '未被记账的队员被误标注：' + JSON.stringify(builder);
    if ((done.diagnostics || []).length !== 0) return '正常收尾后标志没被清掉：' + JSON.stringify(done.diagnostics);
    return true;
  });
  // ── 工具返回值的**形状**校验（官方同一个校验器）────────────────────────────────────
  // 为什么单列一段：上面所有断言都是直调 definition.execute(...)，而**生产路径**上
  // dsh-tools 的 createSuccessResult 会先 validateJsonSchemaValue(tool.output.schema, value)
  // （@deepseek-ai/dsh-tools/lib/index.js:3541-3544），不合 schema 就抛 ToolOutputError ——
  // 也就是说「execute 返回值对了」不等于「模型真能拿到」。这一步补上那段空白。
  const shapeCases = [
    ['broadcast_message', broadcastTool, { message: 'shape' }, leadAgent],
    ['broadcast_message(点名)', broadcastTool, { targets: ['scout', 'ghost'], message: 'shape' }, leadAgent],
    ['broadcast_message(含 inactive)', broadcastTool, { message: 'shape', include_inactive: true }, leadAgent],
    ['ask_lead', askTool, { question: 'shape' }, scoutAgent],
    ['ask_lead(非阻塞)', askTool, { question: 'shape', blocking: false }, scoutAgent],
    ['list_agents', listTool, {}, leadAgent],
  ];
  const shapeResults = [];
  for (const [label, definition, args, agent] of shapeCases) {
    try {
      const value = await definition.execute(args, { agent, signal: new AbortController().signal });
      const violations = dshTools.validateJsonSchemaValue(definition.output.schema, value, 'value');
      shapeResults.push({ label, violations, value });
    } catch (error) {
      shapeResults.push({ label, violations: ['execute 抛错：' + (error && error.message)], value: null });
    }
  }
  check('每个新工具的返回值都过官方 schema 校验（否则模型侧会拿到 ToolOutputError）', () => {
    const bad = shapeResults.filter((item) => item.violations.length > 0);
    if (bad.length > 0) return bad.map((item) => `${item.label}: ${JSON.stringify(item.violations).slice(0, 200)}`).join('\n        ');
    if (shapeResults.length !== shapeCases.length) return `只跑了 ${shapeResults.length}/${shapeCases.length} 个用例`;
    return true;
  });
  sentMessages.length = 0;

  })();

  // ── 2026-10-04 审查 P2-20：任务板 / wait / interrupt 的**插件自有逻辑**真路径 ──────────
  // 划清边界：官方 createTask/updateTask/waitForChange 的域语义**不在这里测**（那是官方自己的
  // 测试范围，本文件也造不出真 journal）。这里测的是**我们这一层**——上面每一行参数映射与
  // 分支都是插件代码，写错了官方域服务再正确也没用：
  //   team_task_create/update 的 snake_case → camelCase 映射与「缺省字段必须整个不传」
  //   team_task_list 的 status/owner(含 unowned)/ready 三条件过滤器 + cursor/limit 分页 + nextCursor
  //   wait_agent 的 no-active-peer 短路（它决定 Lead 会不会白等 30 秒）
  //   interrupt_agent / wake_teammate 的 resolveTarget（agent_id 别名翻译 + 二者冲突必拒）
  const board = [];
  const boardCalls = [];
  const waitCalls = [];
  const interruptCalls = [];
  let memberStatus = new Map([['lead-agent', 'running'], ['scout-agent', 'inactive'], ['builder-agent', 'inactive']]);
  const boardTeams = {
    tryMembership: (agent) => membershipById.get(agent && agent.id),
    listMembers: (caller) => [
      { id: 'lead-agent', name: 'lead', role: 'lead', status: memberStatus.get('lead-agent') ?? 'inactive', diagnostics: [] },
      { id: 'scout-agent', name: 'scout', role: 'teammate', status: memberStatus.get('scout-agent') ?? 'inactive', diagnostics: [] },
      { id: 'builder-agent', name: 'builder', role: 'teammate', status: memberStatus.get('builder-agent') ?? 'inactive', diagnostics: [] },
    ],
    createTask(caller, request) { boardCalls.push({ method: 'createTask', caller, request }); const task = { id: 'task-1', revision: 0, subject: request.subject, description: request.description, status: 'pending', blockedBy: request.blockedBy ?? [], writeScopes: request.writeScopes ?? [], ready: (request.blockedBy ?? []).length === 0, writeScopeWarnings: [] }; board.push(task); return task; },
    listTasks(caller) { boardCalls.push({ method: 'listTasks', caller }); return board.map((task) => ({ ...task })); },
    getTask(caller, taskId) { boardCalls.push({ method: 'getTask', caller, taskId }); return board.find((task) => task.id === taskId); },
    updateTask(caller, request) { boardCalls.push({ method: 'updateTask', caller, request }); const task = board.find((row) => row.id === request.taskId); if (task === undefined) throw new Error('TEAM_TASK_NOT_FOUND'); if (request.expectedRevision !== task.revision) throw new Error('TEAM_TASK_STALE_REVISION'); task.revision += 1; if (typeof request.subject === 'string') task.subject = request.subject; return { ...task }; },
    waitForChange(caller, timeoutMs, signal) { waitCalls.push({ caller, timeoutMs }); return { timedOut: true }; },
    interrupt(caller, target) { interruptCalls.push({ caller, target }); return { previousStatus: memberStatus.get(target === 'scout' ? 'scout-agent' : 'lead-agent') === 'running' ? 'running' : 'inactive' }; },
    sendMessage: () => ({ messageId: 'm', status: 'accepted' }),
  };
  const boardRuntime = { ...reportRuntime };
  const boardDefinitions = new Map(toolsModule.teamToolDefinitions({ runtime: boardRuntime, agentTeams: boardTeams }).map((definition) => [definition.name, definition]));
  for (const definition of toolsModule.teamToolDefinitions({ runtime: boardRuntime, agentTeams: boardTeams, include: roster.MEMBER_TEAM_TOOL_NAMES })) {
    if (!boardDefinitions.has(definition.name)) boardDefinitions.set(definition.name, definition);
  }
  const signalOf = () => new AbortController().signal;
  const leadExec = { agent: leadAgent, signal: signalOf() };

  await (async () => {
    boardCalls.length = 0;
    const created = await boardDefinitions.get('team_task_create').execute(
      { subject: '做 A', description: '细节', blocked_by: ['task-0'], write_scopes: ['src/a/'] },
      leadExec,
    );
    const sent = boardCalls[0].request;
    const keys = Object.keys(sent).sort().join(',');
    check('team_task_create：snake_case 参数映射为域服务的 camelCase，且未给的字段整个不传', () => {
      if (keys !== 'blockedBy,description,subject,writeScopes') return '域服务收到的键不对：' + keys;
      if (JSON.stringify(sent.blockedBy) !== '["task-0"]') return 'blocked_by 没翻成 blockedBy：' + JSON.stringify(sent);
      if (created === undefined || created.id !== 'task-1') return JSON.stringify(created);
      return true;
    });
    const bare = await boardDefinitions.get('team_task_create').execute({ subject: 'B', description: 'd' }, leadExec);
    check('team_task_create：不给 blocked_by / write_scopes 时**不会**出现值为 undefined 的键（官方按 hasOwnProperty 判定）', () => {
      const second = boardCalls[boardCalls.length - 1].request;
      if ('blockedBy' in second || 'writeScopes' in second) return JSON.stringify(Object.keys(second));
      if (second.id !== undefined || bare === undefined) return '第二次创建异常';
      return true;
    });
  })();

  await (async () => {
    board.length = 0;
    board.push(
      { id: 't1', revision: 0, subject: 's1', description: 'd', status: 'pending', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] },
      { id: 't2', revision: 0, subject: 's2', description: 'd', status: 'in_progress', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] },
      { id: 't3', revision: 0, subject: 's3', description: 'd', status: 'pending', blockedBy: ['t1'], writeScopes: [], ready: false, writeScopeWarnings: [], ownerName: 'scout' },
      { id: 't4', revision: 0, subject: 's4', description: 'd', status: 'completed', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [], ownerName: 'builder' },
    );
    const listTool = boardDefinitions.get('team_task_list');
    const ids = (result) => result.tasks.map((task) => task.id).join(',');
    const all = await listTool.execute({}, leadExec);
    check('team_task_list：无过滤时返回全部，并带 cursor/limit 默认分页（limit 50 内不出现 nextCursor）', () => {
      if (ids(all) !== 't1,t2,t3,t4') return ids(all);
      if ('nextCursor' in all) return '不该有 nextCursor：' + JSON.stringify(all.nextCursor);
      return true;
    });
    const byStatus = await listTool.execute({ status: 'pending' }, leadExec);
    const byOwner = await listTool.execute({ owner: 'unowned' }, leadExec);
    const byScout = await listTool.execute({ owner: 'scout' }, leadExec);
    const byReady = await listTool.execute({ ready: false }, leadExec);
    check('team_task_list：status / owner(含 unowned 魔法值) / ready 三个过滤器各自生效', () => {
      if (ids(byStatus) !== 't1,t3') return 'status=pending -> ' + ids(byStatus);
      if (ids(byOwner) !== 't1,t2') return 'owner=unowned -> ' + ids(byOwner);
      if (ids(byScout) !== 't3') return 'owner=scout -> ' + ids(byScout);
      if (ids(byReady) !== 't3') return 'ready=false -> ' + ids(byReady);
      return true;
    });
    const page1 = await listTool.execute({ limit: 2 }, leadExec);
    const page2 = await listTool.execute({ limit: 2, cursor: 2 }, leadExec);
    check('team_task_list：分页翻到底 + 有剩余时给 nextCursor', () => {
      if (ids(page1) !== 't1,t2' || page1.nextCursor !== 2) return JSON.stringify(page1);
      if (ids(page2) !== 't3,t4' || 'nextCursor' in page2) return JSON.stringify(page2);
      return true;
    });
    const badCursor = await listTool.execute({ cursor: -1 }, leadExec).then(() => null, (error) => error.message);
    const badLimit = await listTool.execute({ limit: 0 }, leadExec).then(() => null, (error) => error.message);
    const bigLimit = await listTool.execute({ limit: 101 }, leadExec).then(() => null, (error) => error.message);
    check('team_task_list：坏 cursor / 越界 limit 直接拒（不静默返回空页）', () => {
      if (typeof badCursor !== 'string' || !badCursor.includes('cursor')) return 'cursor=-1 没拒：' + String(badCursor);
      if (typeof badLimit !== 'string' || !badLimit.includes('limit')) return 'limit=0 没拒';
      if (typeof bigLimit !== 'string' || !bigLimit.includes('limit')) return 'limit=101 没拒';
      return true;
    });
  })();

  await (async () => {
    boardCalls.length = 0;
    await boardDefinitions.get('team_task_get').execute({ task_id: 't7' }, leadExec);
    check('team_task_get：task_id 经 TeamTaskId 品牌化后原样透传（不加工成数字）', () => {
      const call = boardCalls[boardCalls.length - 1];
      if (call.method !== 'getTask' || call.taskId !== 't7') return JSON.stringify(call);
      return true;
    });
    board.length = 0;
    board.push({ id: 't9', revision: 3, subject: 'old', description: 'd', status: 'pending', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] });
    const updated = await boardDefinitions.get('team_task_update').execute(
      { task_id: 't9', expected_revision: 3, action: 'claim', subject: 'new', blocked_by: ['t8'] },
      leadExec,
    );
    const upd = boardCalls[boardCalls.length - 1].request;
    check('team_task_update：CAS 三要素 + 可选字段映射（expected_revision→expectedRevision、blocked_by→blockedBy）', () => {
      if (upd.taskId !== 't9' || upd.expectedRevision !== 3 || upd.action !== 'claim') return JSON.stringify(upd);
      if (upd.subject !== 'new' || JSON.stringify(upd.blockedBy) !== '["t8"]') return JSON.stringify(upd);
      if (updated.revision !== 4) return '返回值不是域服务更新后的：' + JSON.stringify(updated);
      return true;
    });
    const stale = await boardDefinitions.get('team_task_update')
      .execute({ task_id: 't9', expected_revision: 1, action: 'claim' }, leadExec)
      .then(() => null, (error) => error.message);
    check('team_task_update：stale revision 由官方 CAS 拒绝，插件**不吞掉**这个错误', () => {
      if (typeof stale !== 'string' || !stale.includes('STALE_REVISION')) return '过期 revision 竟然通过了：' + String(stale);
      return true;
    });
  })();

  await (async () => {
    waitCalls.length = 0;
    const waitTool = boardDefinitions.get('wait_agent');
    // caller=scout：判据排除自己，所以**除它以外全 inactive** 才构成「无人可等」——lead 在跑就算对端。
    memberStatus = new Map([['lead-agent', 'inactive'], ['scout-agent', 'inactive'], ['builder-agent', 'inactive']]);
    const idle = await waitTool.execute({}, { agent: scoutAgent, signal: signalOf() });
    check('wait_agent：没有活着的对端时**短路**返回 no-active-peer，不去调 waitForChange（否则 Lead 白等 30 秒）', () => {
      if (waitCalls.length !== 0) return 'waitForChange 被调了 ' + waitCalls.length + ' 次';
      if (idle.timedOut !== false) return JSON.stringify(idle);
      if (idle.noProgress === undefined || idle.noProgress.reason !== 'no-active-peer') return JSON.stringify(idle);
      if (!idle.noProgress.message.includes('wake each required inactive teammate')) return '说明文字丢了下一步动作';
      return true;
    });
    memberStatus = new Map([['lead-agent', 'running'], ['scout-agent', 'inactive'], ['builder-agent', 'running']]);
    waitCalls.length = 0;
    const active = await waitTool.execute({ timeout_ms: 15000 }, { agent: scoutAgent, signal: signalOf() });
    check('wait_agent：有 running 对端时正常转给 waitForChange，并把 timeout_ms 原样传下去', () => {
      if (waitCalls.length !== 1) return 'waitForChange 调用 ' + waitCalls.length + ' 次';
      if (waitCalls[0].timeoutMs !== 15000) return JSON.stringify(waitCalls[0]);
      if (active.timedOut !== true || active.noProgress !== undefined) return JSON.stringify(active);
      return true;
    });
    // provisioning 也算「活着」——刚 spawn 还没起跑的队员不该被当成没人可等。
    waitCalls.length = 0;
    memberStatus = new Map([['lead-agent', 'running'], ['scout-agent', 'inactive'], ['builder-agent', 'provisioning']]);
    await waitTool.execute({}, { agent: scoutAgent, signal: signalOf() });
    check('wait_agent：provisioning 也算活跃对端（刚派出还没起跑的队员不该被当成无人可等）', () => {
      if (waitCalls.length !== 1) return '短路了：waitForChange 没被调';
      if (waitCalls[0].timeoutMs !== 30000) return '默认超时不是 30s：' + waitCalls[0].timeoutMs;
      return true;
    });
    memberStatus = new Map([['lead-agent', 'running'], ['scout-agent', 'inactive'], ['builder-agent', 'inactive']]);
  })();

  await (async () => {
    interruptCalls.length = 0;
    const interruptTool = boardDefinitions.get('interrupt_agent');
    const byName = await interruptTool.execute({ target: 'scout' }, leadExec);
    const byId = await interruptTool.execute({ agent_id: 'scout-agent' }, leadExec);
    check('interrupt_agent：target 用名字，agent_id 别名被翻译成名字（模型会照抄官方同名工具的形状）', () => {
      if (interruptCalls[0].target !== 'scout') return 'target 原样失败：' + JSON.stringify(interruptCalls[0]);
      if (interruptCalls[1].target !== 'scout') return 'agent_id 没翻译：' + JSON.stringify(interruptCalls[1]);
      if (byName.previousStatus !== 'inactive' || byId.previousStatus !== 'inactive') return JSON.stringify([byName, byId]);
      return true;
    });
    const bothConflict = await interruptTool.execute({ target: 'scout', agent_id: 'builder-agent' }, leadExec).then(() => null, (error) => error.message);
    const bothSame = await interruptTool.execute({ target: 'scout', agent_id: 'scout' }, leadExec).then((value) => value, (error) => error.message);
    const none = await interruptTool.execute({}, leadExec).then(() => null, (error) => error.message);
    check('interrupt_agent：target 与 agent_id 都缺、或都给且不一致 → 拒绝；都给且一致 → 放行', () => {
      if (typeof bothConflict !== 'string' || !bothConflict.includes('不一致')) return '冲突没拒：' + String(bothConflict);
      if (typeof none !== 'string' || !none.includes('缺少目标')) return '空目标没拒：' + String(none);
      if (interruptCalls[interruptCalls.length - 1].target !== 'scout') return '一致时不该拒：' + JSON.stringify(bothSame);
      return true;
    });
    const leadTarget = await boardDefinitions.get('wake_teammate').execute({ target: 'lead' }, leadExec).then((v) => v, (e) => e.message);
    check('wake_teammate：target=lead 原样透传（不拿去和队员名单比，否则官方错误信息会误导）', () => {
      if (typeof leadTarget === 'string') return '被拒了：' + leadTarget;
      return true;
    });
  })();


  // ── 8) 2026-10-01 修复的三件事：/team 的显示、宿主重启后团队工具被移除、队员唤醒 ─────────
  // 现场证据（两份真实会话日志，tools/session-probe.cjs --tools 可复现）：
  //   seq=360 request/header reason=resume series 工具 72 个 -[spawn_teammate, team_task_create, …]
  //   seq=361 developer/message（tool-registry）              -[spawn_teammate, team_task_create, …]
  //   随后 spawn_teammate / wait_agent 报 `unknown tool`，send_message 报
  //   `missing required property "agent_id"`（我们那三个工具消失后露出官方 dsh-tool-subagent-control 的同名版本）。
  console.log('');
  console.log('§8 /team 显示 + 会话记忆恢复 + wake_teammate');

  const KEY_CMD = { name: 'cmd-agent' };
  const KEY_RESUME_OLD = { name: 'resume-old' };
  const KEY_RESUME_NEW = { name: 'resume-new' };
  const KEY_FRESH = { name: 'fresh-agent' };
  const cmdScope = createScope(root, KEY_CMD, { parent: KEY_DISPATCH });
  const resumeOldScope = createScope(root, KEY_RESUME_OLD, { parent: KEY_DISPATCH });
  const resumeNewScope = createScope(root, KEY_RESUME_NEW, { parent: KEY_DISPATCH });
  const freshScope = createScope(root, KEY_FRESH, { parent: KEY_DISPATCH });
  for (const key of [KEY_CMD, KEY_RESUME_OLD, KEY_RESUME_NEW, KEY_FRESH]) presetIdByScope.set(key, 'dispatch-mode');

  // ── 8.1) /team：注入的正文必须是用户原文那一行；成功时不再回一句「已开启」横幅 ──────────
  const injected = [];
  const cmdAgent = {
    id: 'cmd-session-1',
    session: { id: 'cmd-session-1' },
    ctx: agentCtx(cmdScope.ctx),
    followup(message) { injected.push(message); },
  };
  agents.push(cmdAgent);
  membershipById.set(cmdAgent.id, { root: cmdAgent, id: cmdAgent.id, role: 'lead', name: 'lead' });
  const teamCommand = commands.find(KEY_CMD, 'team');
  check('命令面：真注册表里能取到 /team 的 handler（先证明下面测的是同一条链）', () => (
    typeof teamCommand?.handler === 'function' ? true : 'commands.find(KEY_CMD, "team") 取不到 handler'
  ));
  const commandResult = teamCommand === undefined
    ? undefined
    : await teamCommand.handler({ commandId: 'c1', agent: cmdAgent, rawInput: '  只做调研  ', attachments: [], signal: new AbortController().signal });

  check('/team：注入用户原文（界面里看到的就是他打的 /team …），且成功后不再带「已开启」那段话', () => {
    if (commandResult?.kind !== 'success') return JSON.stringify(commandResult);
    if (commandResult.text !== undefined) return `成功结果不该再带 text：${String(commandResult.text).slice(0, 80)}`;
    if (injected.length !== 1) return `注入 ${injected.length} 条消息（应恰好 1 条）`;
    const message = injected[0];
    if (message?.role !== 'user') return `注入的不是 user 消息：${String(message?.role)}`;
    const text = message?.content?.[0]?.text;
    if (text !== '/team 只做调研') return `注入正文是 ${JSON.stringify(text)}`;
    return true;
  });

  check('/team：真的把团队工具装上了（Lead 的完整名单，含 wake_teammate，且没有 report_result）', () => {
    const names = visibleNames(KEY_CMD);
    const missing = [...roster.LEAD_TEAM_TOOL_NAMES].filter((name) => !names.includes(name));
    if (missing.length > 0) return `缺 ${missing.join(', ')}`;
    if (names.includes(roster.REPORT_TOOL_NAME)) return 'Lead 竟然拿到了 report_result';
    return true;
  });

  // ── 8.1b) /team 必须**接受附件**（2026-10-07 用户实测：贴图 + /team 被宿主拒
  //      「/team 不接受附件，请先移除附件」）。
  //
  //      判据在宿主执行器里，不在本插件：dsh-commands/lib/types/index.js:330
  //      `if (command.definition.input?.attachments !== true) return settle({kind:'error', ...})`，
  //      客户端把它渲染成 notice.attachmentsUnsupported（dsh-client-ui-commands/lib/client.js:111）。
  //      所以这里必须**穿过真 execute()** 打一遍：只调 handler 会绕过这道判据、给假绿灯。
  //
  //      注意 `view(agent)` = `layers.merge(agent)`（:401）把 agent **本身**当 scope key
  //      （官方 dsh-scope/README.md:34 `createScope(ctx, agent)` 同形），所以探针的 agent
  //      直接用自己的对象；全局注册的命令对任意 scope 都可见（merge 先铺 global 层）。
  {
    const commandsService = root.get('commands');
    const fileRef = Object.freeze({
      id: 'att-1', name: 'shot.png', bytes: 1234, digest: 'sha256:abc',
      hostPath: '/tmp/att-1', mediaType: 'image/png',
    });
    const releaseResolver = commandsService.registerFileReceiptResolver(() => fileRef);
    const submission = [{ type: 'file', receiptId: 'r-1' }];
    const probeAgent = { id: 'attach-probe-agent', session: { id: 'attach-probe-session', append() {} } };
    const seen = [];
    const disposer = commandsService.register({
      name: 'attach-probe',
      description: 'probe: 与 /team 同形状的 attachments 声明（宿主准入行为由它代表）',
      input: { hint: 'probe', attachments: true },
      handler: (invocation) => { seen.push(invocation.attachments); return { kind: 'success' }; },
    });
    const exec = await commandsService.execute(
      probeAgent, '/attach-probe 看这张图', submission, new AbortController().signal);
    // 探针定义**先不回收**：下面还要用同一条声明测图片分支（提前 disposer 会让 execute
    // 因命令不存在返回 undefined，从而把「没测到」伪装成「通过」）。

    check('宿主准入：声明了 input.attachments:true 的命令，附件被准入成持久块交给 handler', () => {
      if (exec?.result?.kind !== 'success') {
        return `宿主返回 ${exec?.result?.kind}：${String(exec?.result?.text).slice(0, 140)}`;
      }
      const blocks = seen[0] ?? [];
      if (blocks.length !== 1 || blocks[0]?.type !== 'file' || blocks[0]?.attachment?.name !== 'shot.png') {
        return `handler 收到的 attachments 不对：${JSON.stringify(blocks)}`;
      }
      return true;
    });

    // 负向对照：不声明的命令，宿主**确实**拒 —— 证明上一条 PASS 不是恒真、判据仍然在。
    const rejectedAgent = { id: 'noattach-agent', session: { id: 'noattach-session', append() {} } };
    const rejectDisposer = commandsService.register({
      name: 'noattach-probe',
      description: 'probe: 不声明 attachments',
      input: { hint: 'probe' },
      handler: () => ({ kind: 'success' }),
    });
    const rejected = await commandsService.execute(
      rejectedAgent, '/noattach-probe x', submission, new AbortController().signal);
    rejectDisposer();
    check('负向对照：未声明 attachments 的命令 + 附件，宿主仍拒（判据没被绕过）', () => {
      if (rejected?.result?.kind !== 'error') {
        return `未声明附件的命令竟然被放行：${JSON.stringify(rejected?.result)}`;
      }
      if (!String(rejected.result.text).includes('does not accept attachments')) {
        return `拒因不是附件判据：${String(rejected.result.text).slice(0, 140)}`;
      }
      return true;
    });
    releaseResolver();

    // 用户的真实场景是**贴图**：图片走的是另一条准入分支（宿主 admitEncodedImages）。
    // 这里不 mock 宿主内部的规范化流水线（那只会自我确认），只钉住关键事实：
    // 图片提交**不再被附件闸拒**。断言先要求宿主真的应答了（undefined = 命令没注册，
    // 那是「没测到」不是「通过」），再排除附件拒因。
    const imageOutcome = await commandsService.execute(probeAgent, '/attach-probe 看图',
      [{ type: 'image', mediaType: 'image/png', data: 'not-real-base64' }],
      new AbortController().signal);
    disposer();
    check('图片提交同样过了附件闸（用户场景是贴图，不是只有 file 类型）', () => {
      if (imageOutcome === undefined) {
        return '宿主没有应答（探针命令未注册？）——这是没测到，不能算通过';
      }
      const text = String(imageOutcome.result?.text ?? '');
      if (text.includes('does not accept attachments')) {
        return `图片提交仍被附件闸拒：${text.slice(0, 140)}`;
      }
      return true;
    });

    // 真正的回归守卫：/team 自己的定义必须带上这个声明（缺了就是用户截图那条报错）。
    check('/team 的定义声明了 input.attachments:true（用户贴图被拒的根因）', () => {
      const definition = commandsService.find(KEY_CMD, 'team');
      if (definition?.input?.attachments !== true) {
        return `input.attachments = ${JSON.stringify(definition?.input?.attachments)} —— 宿主会拒带附件的 /team`;
      }
      return true;
    });
    check('/team 的 descriptor 把 attachments 能力透给客户端（允许贴图，而不是提交后才报错）', () => {
      const desc = commandsService.list(KEY_CMD).find((d) => d.name === 'team');
      if (desc === undefined) return 'list() 里没有 /team';
      if (desc.input?.attachments !== true) return `descriptor.input.attachments = ${JSON.stringify(desc.input?.attachments)}`;
      return true;
    });

    // 注入形状：附件必须跟着用户那一行进同一条 user 消息（否则宿主放行了、模型却看不到图）。
    const injectAgent = { id: 'inject-attach', session: { id: 'inject-attach' }, followup(m) { this.msg = m; } };
    runtime.inject(injectAgent, '/team 看这张图', Object.freeze([Object.freeze({ type: 'file', attachment: fileRef })]));
    check('runtime.inject：附件在前、用户原文在后并入同一条 user 消息（与官方 /plan 同形）', () => {
      const content = injectAgent.msg?.content ?? [];
      if (content.length !== 2) return `content 长度 ${content.length}：${JSON.stringify(content.map((b) => b?.type))}`;
      if (content[0]?.type !== 'file' || content[0]?.attachment?.name !== 'shot.png') return `第 1 块不是附件：${JSON.stringify(content[0])}`;
      if (content[1]?.type !== 'text' || content[1]?.text !== '/team 看这张图') return `第 2 块不是正文：${JSON.stringify(content[1])}`;
      return true;
    });
    check('runtime.inject：不传附件时形状与旧版逐字一致（不影响既有 8.1 断言）', () => {
      const plain = { id: 'inject-plain', session: { id: 'inject-plain' }, followup(m) { this.msg = m; } };
      runtime.inject(plain, '/team');
      const content = plain.msg?.content ?? [];
      if (content.length !== 1) return `content 长度 ${content.length}（应为 1）`;
      if (content[0]?.type !== 'text' || content[0]?.text !== '/team') return JSON.stringify(content[0]);
      return true;
    });
  }

  {
    // 2026-10-01 18:26 现场（用户截图）：模型自己调 enable_agent_team 时，我们曾用 agent.followup 注入一句
    // 「[系统] 智能体团队已开启…」。followup = send(input, 'next-turn', true)，而客户端 QueueDock 读的就是
    // `next-turn` 收件箱（dsh-client-ui-conversation README），于是那句话**排队在用户输入框上方**，
    // 用户还得多点一次「插入」。现在改为把状态说明放进**工具返回值**，一条消息都不注入。
    const enableToolDef = root.get('tools').get('enable_agent_team', KEY_CMD);
    const toolResult = enableToolDef === undefined ? undefined : await enableToolDef.execute({}, { agent: cmdAgent });
    const injectedAfterTool = injected.length;
    const disableToolDef = root.get('tools').get('disable_agent_team', KEY_CMD);
    const disableResult = disableToolDef === undefined ? undefined : await disableToolDef.execute({}, { agent: cmdAgent });
    check('工具面：enable/disable_agent_team **一条消息都不注入**（否则会排队进用户的输入框）', () => {
      if (toolResult?.ok !== true) return JSON.stringify(toolResult);
      if (injectedAfterTool !== 1) return `enable 之后注入变成 ${injectedAfterTool} 条（应仍是 1 条）`;
      if (injected.length !== 1) return `disable 之后注入变成 ${injected.length} 条（应仍是 1 条）`;
      if (disableResult?.ok !== true || disableResult.enabled !== false) return JSON.stringify(disableResult);
      return true;
    });
    check('工具面：状态说明改走工具返回值 diagnostics（模型看得到、用户看不到排队）', () => {
      const enabledNote = (toolResult?.diagnostics ?? []).join(' | ');
      const disabledNote = (disableResult?.diagnostics ?? []).join(' | ');
      if (!enabledNote.includes('团队已开启')) return `enable 的 diagnostics 里没有状态说明：${enabledNote || '(空)'}`;
      if (!disabledNote.includes('团队已关闭')) return `disable 的 diagnostics 里没有状态说明：${disabledNote || '(空)'}`;
      return true;
    });
  }

  // ── 8.2) 会话记忆：宿主重启后按会话记录把团队装回来（这正是「移除：spawn_teammate…」的根因） ──
  const resumeOld = { id: 'resume-session-1', session: { id: 'resume-session-1' }, ctx: agentCtx(resumeOldScope.ctx) };
  agents.push(resumeOld);
  membershipById.set(resumeOld.id, { root: resumeOld, id: resumeOld.id, role: 'lead', name: 'lead' });
  const enabledForResume = await runtime.enable(root, resumeOld, { source: 'integration-test' });

  check('会话记忆：开团后落盘（重启恢复的唯一依据）', () => {
    if (enabledForResume.ok !== true) return JSON.stringify(enabledForResume);
    if (!resume.isEnabledSession('resume-session-1')) return `记录没写进 ${resume.sessionsPath()}`;
    if (resume.isEnabledSession('never-enabled-session')) return '没开过团的会话也被记了';
    return true;
  });

  // 模拟宿主重启：旧进程的 agent 全部消失（这正是重启的含义），换一个**全新的模块实例**
  // （带 query 的 URL = 新的 ESM 记录 → state.roots 是空的，与真实重启后的情形一致）。
  agents.splice(0, agents.length);
  const revived = { id: 'resume-session-1', session: { id: 'resume-session-1' }, ctx: agentCtx(resumeNewScope.ctx) };
  const untouched = { id: 'fresh-session-1', session: { id: 'fresh-session-1' }, ctx: agentCtx(freshScope.ctx) };
  agents.push(revived, untouched);
  membershipById.set(revived.id, { root: revived, id: revived.id, role: 'lead', name: 'lead' });
  membershipById.set(untouched.id, { root: untouched, id: untouched.id, role: 'lead', name: 'lead' });
  const restarted = await import(`${libUrl('runtime.js')}?restart=${Date.now()}`);
  const reconciled = restarted.reconcileAgents(root);

  check('宿主重启后：记录在案的会话自动恢复（团队工具与队员卡重新装上）', () => {
    const names = visibleNames(KEY_RESUME_NEW);
    const missing = [...roster.LEAD_TEAM_TOOL_NAMES].filter((name) => !names.includes(name));
    if (missing.length > 0) return `恢复后仍缺 ${missing.join(', ')}（reconcile=${JSON.stringify(reconciled)}）`;
    if (restarted.sessionMemory().restoredThisProcess < 1) return 'sessionMemory() 没记下恢复次数';
    return true;
  });

  check('宿主重启后：没有记录的会话不被恢复（团队不会泄漏给新会话），且恢复过程不进故障通道', () => {
    // 判据必须用 `wake_teammate`（只有我们会注册这个名字）：上面 §6 的官方替身在宿主层注册了**同名九个**，
    // 任何 preset 的子作用域都能继承到它们 —— 那正是 2026-10-01 现场「三个名字还在、六个不见了」的原因
    // （send_message / list_agents / interrupt_agent 由官方 dsh-tool-subagent-control 在宿主平面提供）。
    // 所以「新会话没被开团」要看的不是名字在不在，而是**我们有没有为它装过**。
    const names = visibleNames(KEY_FRESH);
    if (names.includes(roster.WAKE_TOOL_NAME)) return `新会话竟被装了我们的团队工具：${names.join(', ')}`;
    const problems = restarted.diagnostics();
    if (problems.length > 0) return `恢复过程记了故障：${problems.join(' | ')}`;
    return true;
  });

  restarted.disable(root, revived);
  check('关团后：会话记录被删除（否则下次重启会自己开回来）', () => (
    resume.isEnabledSession('resume-session-1') === false ? true : '记录还在磁盘上'
  ));

  // ── 8.2.1) 工作区画布的宿主接线（teamGraph / teamConversation / leadForSession） ──
  // 这些是纯函数单测（selftest 的 lib/graph.js 那组）够不到的部分：闸门、成员→Lead 解析、
  // 越权拒绝、以及「没有活体 agent 且无持久化」时的如实降级。全走**真 runtime 导出**。
  {
    // 先重新开一个团队（上面 disable 把 revived 关了），并造一个「只有域服务认识、但没有活体 agent」的队员。
    const graphLead = { id: 'graph-session-1', session: { id: 'graph-session-1' }, ctx: agentCtx(resumeOldScope.ctx) };
    agents.push(graphLead);
    membershipById.set(graphLead.id, { root: graphLead, id: graphLead.id, role: 'lead', name: 'lead' });
    // 队员：有 membership（root=graphLead）。live 队员进 agents 数组（走活体统计），
    // 无活体队员（graph-ghost-1）故意不进，模拟「域日志记得它、但进程里没有它」的重启后情形。
    const graphMember = { id: 'graph-member-1', session: { id: 'graph-member-1', seq: 0, eventAt: () => undefined }, ctx: agentCtx(resumeOldScope.ctx) };
    membershipById.set(graphMember.id, { root: graphLead, id: graphMember.id, role: 'teammate', name: 'scout' });
    membershipById.set('graph-ghost-1', { root: graphLead, id: 'graph-ghost-1', role: 'teammate', name: 'builder' });
    agents.push(graphMember);
    const realListMembers = fakeDomain.listMembers;
    fakeDomain.listMembers = (agent) => {
      const rows = realListMembers.call(fakeDomain, agent);
      if (agent === graphLead) rows.push({ id: graphMember.id, name: 'scout', role: 'teammate', status: 'inactive' });
      if (agent === graphLead) rows.push({ id: 'graph-ghost-1', name: 'builder', role: 'teammate', status: 'inactive' });
      return rows;
    };
    await restarted.enable(root, graphLead, { source: 'integration-test' });

    const graphOnLead = await restarted.teamGraph(root, 'graph-session-1');
    check('teamGraph：开团的 Lead 会话能出图，无活体的队员走持久兜底并如实记一条 note（不是静默 0）', () => {
      if (graphOnLead.ok !== true) return JSON.stringify(graphOnLead);
      const names = graphOnLead.graph.nodes.map((n) => n.name);
      if (!names.includes('lead')) return `没有 lead 节点：${names.join(',')}`;
      if (!names.includes('scout') || !names.includes('builder')) return `两个队员没都画出来：${names.join(',')}`;
      const notes = graphOnLead.notes ?? [];
      // 无活体（graph-ghost-1）+ 无 sessionPersistence → 必须记降级 note；有活体的 graph-member-1 不该记。
      if (!notes.some((line) => line.includes('graph-ghost-1') && line.includes('sessionPersistence'))) {
        return `没记降级 note（读不到持久化必须说明，不能显示成 0）：${JSON.stringify(notes)}`;
      }
      if (notes.some((line) => line.includes('graph-member-1'))) return `有活体的队员不该被记成降级：${JSON.stringify(notes)}`;
      return true;
    });

    const leadFromMember = await restarted.leadForSession(root, 'graph-member-1');
    check('leadForSession：从有活体的队员会话回溯到 Lead（成员面板在队员会话里也显示，入口必须能打开）', () => {
      if (leadFromMember.ok !== true) return JSON.stringify(leadFromMember);
      if (leadFromMember.lead?.id !== 'graph-session-1') return `回溯到错的 Lead：${leadFromMember.lead?.id}`;
      return true;
    });

    const graphFromMember = await restarted.teamGraph(root, 'graph-member-1');
    check('teamGraph：从队员会话也能出同一张图（leadForSession→Lead→采集，不只 Lead 会话可开）', () => {
      if (graphFromMember.ok !== true) return JSON.stringify(graphFromMember);
      if (graphFromMember.leadSessionId !== 'graph-session-1') return `leadSessionId=${graphFromMember.leadSessionId}`;
      return true;
    });

    const graphNotEnabled = await restarted.teamGraph(root, 'fresh-session-1');
    check('teamGraph：没开团的会话 → notEnabled（页面据此提示先 /team，而不是画一张空图）', () => {
      if (graphNotEnabled.ok !== false) return JSON.stringify(graphNotEnabled);
      if (graphNotEnabled.notEnabled !== true && !String(graphNotEnabled.error).includes('没有活体') && !String(graphNotEnabled.error).includes('未开启')) {
        return `notEnabled 标志缺失：${JSON.stringify(graphNotEnabled)}`;
      }
      return true;
    });

    const convoForeign = await restarted.teamConversation(root, 'graph-session-1', 'someone-elses-session');
    check('teamConversation：越权 targetId 被拒（只能读本团队成员，不能拿这个 op 翻别的会话）', () => {
      if (convoForeign.ok !== false) return JSON.stringify(convoForeign);
      if (!convoForeign.error.includes('本团队')) return convoForeign.error;
      return true;
    });

    const convoSelf = await restarted.teamConversation(root, 'graph-session-1', 'graph-session-1');
    check('teamConversation：Lead 自己的会话允许读（无活体日志时如实返回空 rows + note，不报越权）', () => {
      if (convoSelf.ok !== true) return JSON.stringify(convoSelf);
      if (!Array.isArray(convoSelf.rows)) return 'rows 不是数组';
      return true;
    });

    fakeDomain.listMembers = realListMembers;
    restarted.disable(root, graphLead);
    const gi = agents.indexOf(graphLead);
    if (gi >= 0) agents.splice(gi, 1);
    membershipById.delete(graphLead.id);
    membershipById.delete('graph-member-1');
  }

  // ── 8.3) wake_teammate：Lead 专属的「叫醒被输出上限截断的队员」 ─────────────────────
  const aliasSent = [];
  const aliasTeams = {
    listMembers: () => [
      { id: 'scout-agent', name: 'scout', role: 'teammate', status: 'inactive' },
      { id: 'lead-agent', name: 'lead', role: 'lead', status: 'inactive' },
    ],
    sendMessage: async (caller, request) => {
      aliasSent.push(request);
      return { messageId: `m-${aliasSent.length}`, status: 'accepted' };
    },
  };
  const aliasDefinitions = toolsModule.teamToolDefinitions({ runtime: {}, agentTeams: aliasTeams, include: roster.LEAD_TEAM_TOOL_NAMES });
  const byName = new Map(aliasDefinitions.map((definition) => [definition.name, definition]));
  const wakeDefinition = byName.get(roster.WAKE_TOOL_NAME);

  check('wake_teammate：只在 Lead 的工具面里（队员名单里没有它）', () => {
    if (wakeDefinition === undefined) return 'Lead 的名单里没有 wake_teammate';
    const memberDefinitions = toolsModule.teamToolDefinitions({ runtime: {}, agentTeams: aliasTeams, include: roster.MEMBER_TEAM_TOOL_NAMES });
    if (memberDefinitions.some((definition) => definition.name === roster.WAKE_TOOL_NAME)) return '队员也拿到了 wake_teammate';
    return true;
  });

  await (async () => {
    const caller = { id: 'lead-agent', name: 'lead' };
    const wakeResult = await wakeDefinition.execute({ agent_id: 'scout-agent' }, { agent: caller });
    check('wake_teammate：agent_id 写法被翻成队员名，正文是固定的续写指令（不许重头再来）', () => {
      if (wakeResult?.status !== 'accepted') return JSON.stringify(wakeResult);
      const request = aliasSent[aliasSent.length - 1];
      if (request.target !== 'scout') return `target=${String(request.target)}（应把 agent id 翻译成队员名）`;
      const text = request.content[0].text;
      for (const marker of ['输出上限', '不要重头再来', 'report_result']) {
        if (!text.includes(marker)) return `续写指令缺少「${marker}」：${text.slice(0, 140)}`;
      }
      return true;
    });

    const sendDefinition = byName.get('send_message');
    await sendDefinition.execute({ agent_id: 'scout-agent', message: 'x' }, { agent: caller });
    check('send_message：target / agent_id 两种写法都收（官方那份的 agent_id 形状也认）', () => (
      aliasSent[1]?.target === 'scout' ? true : `agent_id 写法没被翻译：${JSON.stringify(aliasSent[1]?.target)}`
    ));

    let missingTarget = '';
    try {
      await sendDefinition.execute({ message: 'x' }, { agent: caller });
    } catch (error) {
      missingTarget = String(error?.message ?? error);
    }
    check('send_message：两种目标写法都没给 → 明确报错（不静默发错人）', () => (
      missingTarget.includes('缺少目标') ? true : `报错文案：${missingTarget || '(没有报错)'}`
    ));

    let conflict = '';
    try {
      await sendDefinition.execute({ target: 'scout', agent_id: 'other-agent', message: 'x' }, { agent: caller });
    } catch (error) {
      conflict = String(error?.message ?? error);
    }
    check('send_message：target 与 agent_id 同时给出且不一致 → 拒绝（不猜目标）', () => (
      conflict.includes('不一致') ? true : `报错文案：${conflict || '(没有报错)'}`
    ));
  })();

  // ── 8.4) 队员模型：**只有显式 spawn 参数**才钉住；角色配置留给运行期实时读 ──────────────────
  // 2026-10-01 用户报的 bug：把角色改回「跟随 Lead」后，已经在跑的队员仍然用旧模型。
  // 根因：spawn_teammate 把**角色配置解析出来的路由**也钉进了 runtime 的 spawnRoutes，
  // 而队员的覆盖监听器是 `spawnRoutes.get(name) ?? resolveRoleRoute(peekConfig(), role)` —— 钉子永远赢。
  // 修法：只有工具调用显式写的 provider/model（以及单独的 reasoning_effort）才钉。
  await (async () => {
    const pinned = [];
    const spawnedRequests = [];
    const spawnRuntime = {
      peekConfig: () => ({ version: 1, roles: { builder: { provider: 'p1', model: 'm1' } }, cache: { keepalive: { routes: {} } } }),
      // 注意：参数顺序是 (ctx, route)：漏掉第一个参数会把 ctx 当 route 传回去（这里踩过一次，route 变成 undefined）。
      preflightRoute: async (_ctx, route) => ({ ok: true, route, diagnostics: [] }),
      pinSpawnRoute: (name, route) => pinned.push({ name, route }),
    };
    const spawnTeams = {
      listMembers: () => [],
      spawnTeammate: async (caller, request) => {
        spawnedRequests.push(request);
        return {
          member: {
            id: `agent-${String(request.name)}`,
            name: request.name,
            role: 'teammate',
            status: 'inactive',
            description: request.description,
            provider: String(request.provider),
            context: String(request.context),
            diagnostics: [],
          },
        };
      },
    };
    const spawnDefinitions = toolsModule.teamToolDefinitions({ runtime: spawnRuntime, agentTeams: spawnTeams, include: roster.LEAD_TEAM_TOOL_NAMES });
    const spawnTool = spawnDefinitions.find((definition) => definition.name === 'spawn_teammate');
    const caller = { id: 'lead-agent', name: 'lead' };

    const implicit = await spawnTool.execute({ role: 'builder', description: 'x', prompt: 'y' }, { agent: caller });
    const explicit = await spawnTool.execute(
      { role: 'builder', name: 'builder-2', description: 'x', prompt: 'y', provider: 'p9', model: 'm9' },
      { agent: caller },
    );
    const effortOnly = await spawnTool.execute(
      { role: 'builder', name: 'builder-3', description: 'x', prompt: 'y', reasoning_effort: 'high' },
      { agent: caller },
    );

    check('spawn_teammate：没给显式 provider/model 时**不钉**路由（角色配置实时生效，「跟随 Lead」才有意义）', () => {
      if (implicit?.role !== 'builder') return JSON.stringify(implicit);
      if (pinned[0]?.route !== undefined) return `竟然钉住了 ${JSON.stringify(pinned[0].route)}（应该什么都不钉）`;
      // 回执里仍要显示「本次 spawn 生效的路由」= 角色配置那份（给 Lead 看的信息不能少）
      if (implicit.route?.provider !== 'p1' || implicit.route?.model !== 'm1') return `回执里的 route 不对：${JSON.stringify(implicit.route)}`;
      return true;
    });

    check('spawn_teammate：显式给了 provider/model → 钉住这一对（这一次 spawn 的命令必须生效）', () => (
      pinned[1]?.route?.provider === 'p9' && pinned[1]?.route?.model === 'm9'
        ? true
        : `钉的是 ${JSON.stringify(pinned[1]?.route)}`
    ));

    check('spawn_teammate：只给了 reasoning_effort → 只钉强度（模型仍跟随 Lead / 角色配置）', () => {
      const pin = pinned[2]?.route;
      if (pin?.reasoningEffort !== 'high') return `钉的是 ${JSON.stringify(pin)}`;
      if (pin.provider !== undefined || pin.model !== undefined) return `不应带上 provider/model：${JSON.stringify(pin)}`;
      if (!String((effortOnly?.diagnostics ?? []).join(' ')).includes('思考强度')) return '回执里没说清楚只钉了强度';
      return true;
    });

    // ── 失败路径（2026-10-05 补：这条路径此前没有任何用例，我的 scope 笔误就是从这儿漏出去的）──
    // 事实：Agent Teams 的 roster 是**历史累计**记录，队员名永不复用（官方 roster.js:243-244），
    // 撞上时官方只抛一句英文 `teammate name "X" was already used in this Team`。
    // 插件应当把它翻译成带**下一个可用名**的中文；这里用与真域服务同形的假服务验这条链路。
    const nameTakenError = new Error('teammate name "builder-2" was already used in this Team');
    nameTakenError.code = 'TEAM_MEMBER_NAME_TAKEN';
    const limitError = new Error('Team member limit 48 reached');
    limitError.code = 'TEAM_MEMBER_LIMIT';
    const activationError = new Error('subagent limit reached (active child limit: 15); wait for an existing child to finish');
    activationError.code = 'ACTIVATION_LIMIT_REACHED';

    /** 造一个「spawnTeammate 必抛某个官方错误码」的工具面；taken 决定预检能否提前拦住。 */
    const spawnWithFailure = (failure, members) => {
      const tools = toolsModule.teamToolDefinitions({
        runtime: spawnRuntime,
        agentTeams: {
          listMembers: () => members,
          spawnTeammate: async () => { throw failure; },
        },
        include: roster.LEAD_TEAM_TOOL_NAMES,
      });
      return tools.find((definition) => definition.name === 'spawn_teammate');
    };

    const takenRow = { id: 'builder-agent', name: 'builder-2', role: 'teammate', status: 'inactive' };
    const thrown = {};
    for (const [label, failure, members] of [
      ['重名（预检提前拦）', nameTakenError, [takenRow]],
      ['重名（预检没拦住，官方兜底）', nameTakenError, []],
      ['累计帽', limitError, []],
      ['同时在线帽', activationError, []],
    ]) {
      try {
        await spawnWithFailure(failure, members).execute(
          { role: 'builder', name: 'builder-2', description: 'x', prompt: 'y' },
          { agent: caller },
        );
        thrown[label] = null;
      } catch (error) {
        thrown[label] = error;
      }
    }

    check('spawn_teammate：重名在插件侧就被拦下，并给出下一个可用名（不把官方英文原文丢给模型）', () => {
      const error = thrown['重名（预检提前拦）'];
      if (error === null || error === undefined) return '竟然派出去了（名单里 builder-2 已存在）';
      if (error instanceof ReferenceError) return `失败路径自己抛了 ReferenceError：${error.message}`;
      if (!error.message.includes('已经用过')) return error.message;
      // 建议的名字必须是**真的可用**的：从报错里抠出来再验一遍（断言比写死 builder-3 更强——
      // 这条名单里 builder 本来就空着，写死具体值会把「算法变了」误判成失败）。
      const suggested = /改成 "([a-z0-9-]+)"/u.exec(error.message)?.[1];
      if (suggested === undefined) return `没给出下一个可用名：${error.message}`;
      if (suggested === 'builder-2') return '建议了一个已被占用的名字';
      if (!roster.isValidTeammateName(suggested)) return `建议的名字本身不合法：${suggested}`;
      return true;
    });

    check('spawn_teammate：官方错误码被翻译成可执行中文（重名/累计帽/同时在线帽）', () => {
      const fallback = thrown['重名（预检没拦住，官方兜底）'];
      if (fallback === null || fallback === undefined) return '官方抛错却没被捕获';
      // 这条最容易踩的坑：翻译函数在 execute 作用域里引用了 resolveSpawn 的局部变量（role/taken），
      // 于是每次 spawn 失败都变成 ReferenceError —— 比原始的英文报错更糟。
      if (fallback instanceof ReferenceError) return `翻译路径抛了 ReferenceError：${fallback.message}`;
      if (!fallback.message.includes('已经用过')) return `没翻译成中文：${fallback.message}`;
      const limit = thrown['累计帽'];
      if (limit === null || limit === undefined) return '累计帽错误没被捕获';
      if (!limit.message.includes('历史成员额度已满')) return limit.message;
      const activation = thrown['同时在线帽'];
      if (activation === null || activation === undefined) return '同时在线帽错误没被捕获';
      if (!activation.message.includes('同时在线队员额度已满')) return activation.message;
      if (!activation.message.includes('先 wait_agent')) return `没给出下一步动作：${activation.message}`;
      return true;
    });

    // 用户实测的两个报错：name "scout-core" / name "scout-validate" 不是合法的队员名。
    // 这里走**真工具**执行路径，证明它们现在能一路走到 spawnTeammate（旧实现全在插件层被拒）。
    const accepted = [];
    const relaxedTools = toolsModule.teamToolDefinitions({
      runtime: spawnRuntime,
      agentTeams: {
        listMembers: () => [],
        spawnTeammate: async (_caller, request) => {
          accepted.push(request.name);
          return { member: { id: `agent-${request.name}`, name: request.name, role: 'teammate', status: 'inactive', diagnostics: [] } };
        },
      },
      include: roster.LEAD_TEAM_TOOL_NAMES,
    });
    const relaxedTool = relaxedTools.find((definition) => definition.name === 'spawn_teammate');
    const relaxErrors = [];
    for (const [role, name] of [['scout', 'scout-core'], ['scout', 'scout-validate'], ['plan-critic', 'plan-critic-verify']]) {
      try {
        await relaxedTool.execute({ role, name, description: 'x', prompt: 'y' }, { agent: caller });
      } catch (error) {
        relaxErrors.push(`${name}: ${error.message}`);
      }
    }
    check('spawn_teammate：放宽后的名字也能派出（scout-core / plan-critic-verify 这类过去被插件自己拒掉）', () => {
      if (relaxErrors.length > 0) return `这些名字仍被拒：${relaxErrors.join('；')}`;
      const expected = ['scout-core', 'scout-validate', 'plan-critic-verify'];
      if (JSON.stringify(accepted) !== JSON.stringify(expected)) return `实际派出：${JSON.stringify(accepted)}`;
      // 角色必须推导正确（plan-critic-verify 不能被误判成 plan——最长前缀匹配的意义）。
      if (roster.deriveRole('plan-critic-verify') !== 'plan-critic') return 'plan-critic-verify 的角色推导错了';
      if (roster.deriveRole('scout-core') !== 'scout') return 'scout-core 的角色推导错了';
      return true;
    });
  })();

  // 临时目录收尾：不留任何东西在磁盘上。
  try { fsSync.rmSync(tempHome, { recursive: true, force: true }); } catch { /* 收尾失败不影响结论 */ }
  delete process.env.DSH_HOME;
  // ── 收尾 ───────────────────────────────────────────────────────────────────
  console.log('');
  console.log(`${passed}/${passed + failures.length} 通过。`);
  if (failures.length > 0) {
    console.log('');
    console.log('失败项：');
    for (const failure of failures) console.log(`  - ${failure.name}: ${failure.detail}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error('[integration-test] 测试本身崩了：', error);
  process.exit(2);
});
