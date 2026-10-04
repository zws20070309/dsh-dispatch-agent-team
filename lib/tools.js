// 调度模式智能体团队 —— 九个团队工具 + 两个开关工具
//
// 九个工具的**蓝本**是官方 0.1.7-rc.2 源码（照抄 schema、description、错误处理与 jsonOutput 渲染）：
//   <本地 asar 解包快照>\official-agent-team\dsh\node_modules\@deepseek-ai\dsh-experimental-tool-agent-team\lib\index.js
// 逐字对应关系（官方行号 → 本文件函数）：
//   spawn_teammate   官方 :242-294（**本文件唯一有行为改动**：role/name/model/provider/reasoning_effort
//                    与 preflight，见 INTERFACES §4）
//   send_message     官方 :295-321
//   list_agents      官方 :322-330
//   wait_agent       官方 :331-352
//   interrupt_agent  官方 :353-365
//   team_task_create 官方 :366-400
//   team_task_list   官方 :401-444
//   team_task_get    官方 :445-457
//   team_task_update 官方 :458-523
//   jsonOutput()     官方 :214-222；callingAgent() 官方 :224-228；modelMember() 官方 :73-79
//   ACTIVE_WAIT_STATUSES / NO_ACTIVE_PEER_MESSAGE 官方 :28-29
//
// 值 schema 会在**运行时**被校验：dsh-tools/lib/index.js:3543-3544 用 output.schema 校验工具返回值，
// 违反 additionalProperties/required 会抛 ToolOutputError。所以任何新增返回字段都必须同时进 schema。
//
// 允许的静态 import（Lead 裁决）：**只剩** @deepseek-ai/dsh-tools 与 ./ 内部模块。
// ⚠️ 它由安装期 node_modules **junction 解析到全局 CLI 的闭包**（本机实测 0.1.5-rc.2），
// **不是**宿主 0.2.0-rc.1 那一份（同一先例：mcp-manager 也走这条路，真机跑通）。
// 两份 defineTool 的差异目前只有加法（0.2.0 多 projectContent / deferLoading），
// 但这条耦合是静默的，所以 drift-check 有专门的字段闸门（INTERFACES 勘误表第 22 条）。
//
// 为什么不再 import @deepseek-ai/dsh-experimental-agent-team 的 TeamTaskId：
//   官方实现就是恒等函数（`export function TeamTaskId(id) { return id; }`，
//   dsh-experimental-agent-team/lib/types/types.js:15-17），运行期不做任何校验。
//   而该包的入口会连带 import @deepseek-ai/dsh-subagent/internal、@deepseek-ai/dsh-brand、zod、
//   @deepseek-ai/schemastery —— 为一个恒等函数付出四份加载期依赖是不划算的。
//   tools/drift-check.cjs 会持续校验官方 TeamTaskId 是否仍是恒等函数；一旦官方给它加了真实
//   校验，就说明这里必须改回 import（脚本会 FAIL 并给出提示）。

import { defineTool } from '@deepseek-ai/dsh-tools';

import { teammateBrief, wakeInstruction } from './playbook.js';
import {
  ASK_LEAD_TOOL_NAME,
  BROADCAST_TOOL_NAME,
  MEMBER_TEAM_TOOL_NAMES,
  REPORT_TOOL_NAME,
  ROLE_IDS,
  TEAM_TOOL_NAMES,
  WAKE_TOOL_NAME,
  annotateTruncatedMembers,
  askLeadMessage,
  deriveRole,
  isValidTeammateName,
  nextTeammateName,
  planBroadcastTargets,
  resolveRoleRoute,
} from './roster.js';

// TEAM_TOOL_NAMES 的**真值在 lib/roster.js**（那个模块没有 @deepseek-ai 依赖，脚本能直接读）。
// 这里只做转发，兼容既有的 `import { TEAM_TOOL_NAMES } from './tools.js'`。
export { TEAM_TOOL_NAMES };

/** `wake_teammate` 的补充指令上限（字符）：续写指令必须短，长了会挤掉队员自己的上下文。 */
const WAKE_NOTE_LIMIT = 600;
/**
 * broadcast_message 的正文上限。为什么需要它：广播把同一份正文复制进**每个**目标的邮箱，
 * 官方每成员待投递消息数与消息字节数都有上限（maxPendingMessagesPerMember / maxMessageBytes），
 * 一份任意长的文本按人数放大既可能撞官方上限、也会让每个队员的上下文里塞进同一大段。
 * 4000 字足够写下一条协议变更或契约 delta；更长的东西应该是文件或任务，不是聊天正文。
 */
const BROADCAST_MESSAGE_LIMIT = 4000;
/** ask_lead 的问题上限（同 broadcast 口径：问题该短，长内容属于报告或文件）。 */
const ASK_LEAD_QUESTION_LIMIT = 2000;

/** 等待类工具认为「还有活人」的状态集合（官方 :28）。 */
const ACTIVE_WAIT_STATUSES = new Set(['running', 'provisioning']);
/** 没有可推进的对端时的固定说明（官方 :29）。 */
const NO_ACTIVE_PEER_MESSAGE = 'No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again.';
/**
 * 把任务 id 品牌化。**与官方逐字等价**：官方实现是恒等函数
 * （`export function TeamTaskId(id) { return id; }`，
 * dsh-experimental-agent-team/lib/types/types.js:15-17），运行期不校验。
 * 这里本地实现以去掉一份加载期依赖；drift-check 会持续校验官方是否仍是恒等函数。
 * @param id - 任务 id 字符串。
 * @returns 同一个字符串。
 */
function TeamTaskId(id) {
  return id;
}

/** 报告里每个字段的长度上限（防止把整份日志塞进一条消息）。 */
export const REPORT_LIMITS = Object.freeze({
  summary: 4000,
  evidenceItem: 2000,
  evidenceCount: 24,
  unresolvedItem: 1000,
  unresolvedCount: 24,
  changedFiles: 64,
  acceptance: 2000,
});

/** `report_result` 的返回值形状。 */
const REPORT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    delivered: { type: 'boolean', required: true },
    status: { type: 'string', required: true, enum: ['completed', 'blocked', 'needs_decision'] },
    unresolved: { type: 'array', required: true, items: { type: 'string' } },
    report: { type: 'string', required: true },
    diagnostics: { type: 'array', required: true, items: { type: 'string' } },
  },
};

/** 把一个字符串数组净化成「非空、去空白、有上限」的列表。 */
function cleanList(raw, itemLimit, countLimit, label) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`report_result 失败：${label} 必须是数组`);
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw new Error(`report_result 失败：${label} 里每一项都必须是字符串`);
    const trimmed = item.trim();
    if (trimmed === '') continue;
    if (trimmed.length > itemLimit) throw new Error(`report_result 失败：${label} 里有一项超过 ${itemLimit} 字符（把细节压缩成结论）`);
    out.push(trimmed);
    if (out.length >= countLimit) break;
  }
  return out;
}

/**
 * 校验 `report_result` 的入参，返回规范化报告。
 *
 * 这里有**两条硬规则**（不是建议）：
 *   * `status === 'completed'` 必须有至少一条证据 —— 「做完了但没有任何证据」不接受；
 *   * `unresolved` 里的每一项都会被 Lead 当成「未完成」处理（所以它非空时 status 通常是 blocked）。
 *
 * @param args - 工具入参。
 * @returns {{status, summary, evidence, acceptance, unresolved, changedFiles}}
 */
export function validateReport(args) {
  const raw = args !== undefined && args !== null && typeof args === 'object' ? args : {};
  const status = raw.status;
  if (status !== 'completed' && status !== 'blocked' && status !== 'needs_decision') {
    throw new Error('report_result 失败：status 只能是 completed / blocked / needs_decision');
  }
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  if (summary === '') throw new Error('report_result 失败：summary 不能为空');
  if (summary.length > REPORT_LIMITS.summary) throw new Error(`report_result 失败：summary 超过 ${REPORT_LIMITS.summary} 字符（给结论，不要贴原文）`);
  const evidence = cleanList(raw.evidence, REPORT_LIMITS.evidenceItem, REPORT_LIMITS.evidenceCount, 'evidence');
  const unresolved = cleanList(raw.unresolved, REPORT_LIMITS.unresolvedItem, REPORT_LIMITS.unresolvedCount, 'unresolved');
  const changedFiles = cleanList(raw.changed_files, 500, REPORT_LIMITS.changedFiles, 'changed_files');
  const acceptanceRaw = raw.acceptance;
  let acceptance = '未提供（按未验证处理）';
  if (acceptanceRaw !== undefined && acceptanceRaw !== null && acceptanceRaw !== '') {
    if (typeof acceptanceRaw !== 'string') throw new Error('report_result 失败：acceptance 必须是字符串');
    const trimmed = acceptanceRaw.trim();
    if (trimmed.length > REPORT_LIMITS.acceptance) throw new Error(`report_result 失败：acceptance 超过 ${REPORT_LIMITS.acceptance} 字符`);
    if (trimmed !== '') acceptance = trimmed;
  }
  if (status === 'completed' && evidence.length === 0) {
    throw new Error('report_result 失败：status=completed 时必须至少给一条 evidence（真实命令与输出 / 文件:行号）。没有证据就报 blocked 或 needs_decision。');
  }
  return { status, summary, evidence, acceptance, unresolved, changedFiles };
}

/**
 * 把报告渲染成投递给 Lead 的文本。格式固定，便于 Lead（与排查者）一眼看出未决项。
 * @param name - 队员名。
 * @param report - validateReport 的返回值。
 */
export function formatReport(name, report) {
  const lines = [
    `【report_result】${name} · ${report.status}`,
    '',
    `摘要：${report.summary}`,
    `验收：${report.acceptance}`,
  ];
  if (report.evidence.length > 0) {
    lines.push('', '证据：');
    for (const item of report.evidence) lines.push(`- ${item}`);
  }
  if (report.changedFiles.length > 0) {
    lines.push('', `改动文件（${report.changedFiles.length}）：`);
    for (const item of report.changedFiles) lines.push(`- ${item}`);
  }
  lines.push('', report.unresolved.length > 0
    ? `未决项（${report.unresolved.length}，每一项都阻止验收）：`
    : '未决项：无');
  for (const item of report.unresolved) lines.push(`- ${item}`);
  return lines.join('\n');
}

/**
 * 一个成员的模型可见行（官方 :35-71）。
 * Lead 伪行省略只有队员才有的 provisioning 字段，所以只要求 identity/role/status/diagnostics。
 */
const MEMBER_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: { type: 'string', required: true },
    role: { type: 'string', required: true, enum: ['lead', 'teammate'] },
    status: { type: 'string', required: true, enum: ['running', 'inactive', 'provisioning', 'failed'] },
    description: { type: 'string' },
    provider: { type: 'string' },
    context: { type: 'string', enum: ['fresh', 'fork'] },
    model: { type: 'string' },
    diagnostics: { type: 'array', required: true, items: { type: 'string' } },
  },
};

/** 把成员行暴露成模型可见的 target（官方 :73-79）。 */
function modelMember(member) {
  const { id: _id, name, ...details } = member;
  return { target: name, ...details };
}

/** 一条共享任务（官方 :81-132）。 */
const TASK_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    subject: { type: 'string', required: true },
    description: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed', 'deleted'] },
    ownerName: { type: 'string' },
    blockedBy: { type: 'array', required: true, items: { type: 'string' } },
    writeScopes: { type: 'array', required: true, items: { type: 'string' } },
    ready: { type: 'boolean', required: true },
    writeScopeWarnings: { type: 'array', required: true, items: { type: 'string' } },
  },
};

/**
 * spawn_teammate 的返回值：官方 `{member}` + 本插件附加的 `role` / `route` / `diagnostics`
 * （INTERFACES §4 第 4 条：让 Lead 确认模型/强度真的生效；被丢掉的 effort 写进 diagnostics）。
 */
const SPAWN_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    member: { ...MEMBER_VIEW_SCHEMA, required: true },
    role: { type: 'string' },
    route: {
      type: 'object',
      additionalProperties: false,
      properties: {
        provider: { type: 'string', required: true },
        model: { type: 'string', required: true },
        reasoningEffort: { type: 'string' },
      },
    },
    diagnostics: { type: 'array', items: { type: 'string' } },
  },
};

/** 成员列表的返回值（官方 :141-144）。 */
const MEMBER_LIST_VALUE_SCHEMA = { type: 'array', items: MEMBER_VIEW_SCHEMA };

/** send_message 的返回值（官方 :145-159）。 */
const SEND_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    messageId: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['accepted', 'queued'] },
  },
};

/** wait_agent 的返回值；`noProgress` 只在跳过等待的快捷路径上出现（官方 :160-185）。 */
const WAIT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    timedOut: { type: 'boolean', required: true },
    noProgress: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', required: true, const: 'no-active-peer' },
        message: { type: 'string', required: true },
      },
    },
  },
};

/** interrupt_agent 的返回值（官方 :186-194）。 */
const INTERRUPT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { previousStatus: { type: 'string', required: true, enum: ['running', 'inactive'] } },
};

/** team_task_list 的返回值（官方 :195-206）。 */
const TASK_LIST_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tasks: { type: 'array', required: true, items: TASK_VIEW_SCHEMA },
    nextCursor: { type: 'integer' },
  },
};

/**
 * ask_lead 的返回值。`question` 回显实际投递出去的正文（含固定前缀），
 * 队员能据此确认 Lead 看到的是哪一句。
 */
const ASK_LEAD_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    delivered: { type: 'boolean', required: true },
    question: { type: 'string', required: true },
    message_id: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['accepted', 'queued'] },
    diagnostics: { type: 'array', required: true, items: { type: 'string' } },
  },
};

/**
 * broadcast_message 的返回值：每个目标独立成功/失败，汇总成 lossless JSON。
 * 官方 dsh-tools 会用 output.schema 校验工具返回值（dsh-tools/lib/index.js:3543-3544），
 * 所以这里声明的字段必须与 execute 实际返回的形状完全一致。
 */
const BROADCAST_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    sent: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', required: true },
          messageId: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['accepted', 'queued'] },
        },
      },
    },
    failed: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', required: true },
          error: { type: 'string', required: true },
        },
      },
    },
    skipped: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', required: true },
          reason: { type: 'string', required: true },
        },
      },
    },
  },
};

/** 两个开关工具的返回值（本插件定义；schema 必须覆盖所有返回字段，见文件头）。 */
const CONTROL_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    enabled: { type: 'boolean', required: true },
    members: { type: 'array', items: { type: 'string' } },
    diagnostics: { type: 'array', required: true, items: { type: 'string' } },
  },
};

/**
 * 声明规范输出 schema + 紧凑的模型可见 JSON（官方 :214-222 逐字）。
 * @param schema - 单个工具的值 schema。
 * @returns defineTool 接受的 output 声明。
 */
function jsonOutput(schema) {
  return {
    schema,
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  };
}

/** 取回 Agent 作用域工具发现保证的精确调用者（官方 :224-228 逐字）。 */
function callingAgent(agent, toolName) {
  /* v8 ignore next 2 -- Team tools are registered only in an exact Agent scope, so discovery supplies this carrier. */
  if (agent === void 0) throw new Error(`${toolName} requires a calling Agent`);
  return agent;
}

/** 域服务缺失时给出可读错误，而不是 `undefined.spawnTeammate is not a function`。 */
function requireTeam(agentTeams, toolName) {
  if (agentTeams === undefined || agentTeams === null) {
    throw new Error(`${toolName} 失败：ctx.agentTeams 不可用（官方 agent-team 行未启用？）`);
  }
  return agentTeams;
}

/**
 * 安全解析调用者的团队身份，永不抛错（诊断文本取值不许把交付路径带崩）。
 * @param agentTeams - 官方域服务（可缺）。
 * @param agent - 调用者 agent。
 * @returns membership 或 undefined。
 */
function safeMembership(agentTeams, agent) {
  if (agentTeams === undefined || agentTeams === null || typeof agentTeams.tryMembership !== 'function') return undefined;
  try {
    return agentTeams.tryMembership(agent) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 调用者（队员）的**模型可见名字**。唯一可靠来源是域服务：
 * ReactLoopAgent 上没有 name 字段（官方 dsh-agent-loop/lib/index.js:747-789 的字段清单），
 * 而 tryMembership 对队员返回 {root, id, role: 'teammate', name}
 * （官方 dsh-experimental-agent-team/lib/index.js:405-410）。拿不到时如实退回 id，不猜。
 * @param agentTeams - 官方域服务（可缺）。
 * @param caller - 调用者 agent。
 * @returns 队员名，或退化的 id 文本。
 */
function callerName(agentTeams, caller) {
  const membership = safeMembership(agentTeams, caller);
  return typeof membership?.name === 'string' && membership.name !== ''
    ? membership.name
    : String(caller?.id ?? 'teammate');
}

/** 现有队员名集合（含 lead），供 nextTeammateName 去重；域服务不可用/查询失败时退化为只有 lead。 */
function takenNames(agentTeams, agent) {
  const taken = new Set(['lead']);
  if (agentTeams === undefined) return taken;
  try {
    const rows = agentTeams.listMembers(agent);
    for (const row of Array.isArray(rows) ? rows : []) {
      if (typeof row?.name === 'string' && row.name !== '') taken.add(row.name);
    }
  } catch {
    // 名单查不到不该阻断创建：名字冲突由域服务自己再判一次。
  }
  return taken;
}

/**
 * 解析工具的目标成员：同时接受 `target`（队员名，官方语义）与 `agent_id`（agent id 写法）。
 *
 * 为什么要有 `agent_id` 这个别名（2026-10-01 现场）：官方的
 * `@deepseek-ai/dsh-tool-subagent-control` 也提供 `send_message` / `list_agents` / `interrupt_agent`
 * 三个**同名**工具，但它的参数是 `agent_id`、`list_agents` 输出的是裸 agent id。我们那三个工具
 * 在更深的 agent 作用域里遮蔽它；一旦我们的安装缺失（宿主重启，修法见 lib/resume.js），
 * 露出来的就是官方那份 —— 会话里于是留下 `send_message({agent_id: …})` 这种调用形状。
 * 模型会照着上下文里的旧形状再调一次，所以这里把两种写法都收下，并按名字翻译：
 * 官方域服务的 `resolveActiveMember` 只认**名字**（dsh-experimental-agent-team/lib/index.js:350-362
 * `state.members.find(candidate => candidate.name === name)`），所以 id 必须先翻译成名字。
 *
 * @param args - 工具参数。
 * @param agentTeams - 官方域服务（可能 undefined）。
 * @param caller - 调用者 agent（列成员用）。
 * @param toolName - 报错文案里的工具名。
 * @returns {string} 可直接交给域服务的队员名（或 'lead'）。
 */
function resolveTarget(args, agentTeams, caller, toolName) {
  const byName = typeof args?.target === 'string' ? args.target.trim() : '';
  const byId = typeof args?.agent_id === 'string' ? args.agent_id.trim() : '';
  if (byName !== '' && byId !== '' && byName !== byId) {
    throw new Error(`${toolName} 失败：target 与 agent_id 同时给出且不一致（二者指同一个成员，只给一个）`);
  }
  const raw = byName !== '' ? byName : byId;
  if (raw === '') throw new Error(`${toolName} 失败：缺少目标（给 target（队员名）或 agent_id（agent id））`);
  if (raw === 'lead') return raw;
  // 名字优先原样使用；只有当它不像任何队员名时，才尝试当 id 翻译（避免多一次 listMembers 调用）。
  if (agentTeams === undefined || agentTeams === null || typeof agentTeams.listMembers !== 'function') return raw;
  let members;
  try {
    members = agentTeams.listMembers(caller);
  } catch {
    return raw; // 名单查不到就把原样交给域服务，让它的错误信息说话
  }
  const rows = Array.isArray(members) ? members : [];
  if (rows.some((row) => row?.name === raw)) return raw;
  const byAgentId = rows.find((row) => row?.id === raw);
  return typeof byAgentId?.name === 'string' && byAgentId.name !== '' ? byAgentId.name : raw;
}

/**
 * 构建九个团队工具（每个 agent 作用域一份新实例；官方 install() 也是每作用域新建）。
 *
 * `spawn_teammate` 的执行顺序（INTERFACES §4）：
 *   1. role 合法；name 若给了必须是 `<角色id>` 或 `<角色id>-N` 且 deriveRole(name) === role；
 *      没给就用 nextTeammateName(role, 现有队员名 + 'lead')。
 *   2. 路由：显式 provider/model/reasoning_effort > 角色配置 > 不覆盖（继承 Lead）；
 *      显式只给一半 → 报错；先 preflightRoute，ok:false → 报错；被丢掉的 effort 进 diagnostics。
 *   3. ctx.agentTeams.spawnTeammate(...)，provider 由 context 决定（fresh→spawn / fork→fork）。
 *   4. 返回 {member, role, route, diagnostics}。
 *
 * 派活提示词的内容 = `teammateBrief(name, role)`（角色使命/纪律/写权限）**拼在** Lead 写的
 * 自包含任务正文之前，成为队员的第一条 user 消息。这是整套设计里唯一承载角色差异的地方：
 * 队员的系统提示词对所有角色逐字节相同（见 lib/playbook.js 文件头的缓存纪律）。
 *
 * @param options - {runtime, agentTeams, agent?, config?, include?}。
 *   runtime 需提供 peekConfig / preflightRoute / pinSpawnRoute（runtime.js 的模块命名空间或 runtimeApi 都满足）。
 *   include 可选：只注册名单内的工具（队员用 MEMBER_TEAM_TOOL_NAMES，Lead 不传 = 全部九个）。
 * @returns ToolDefinition[]（顺序固定，便于缓存前缀稳定）。
 */
export function teamToolDefinitions({ runtime, agentTeams, config, include } = {}) {
  const freshProvider = config?.freshProvider ?? 'spawn';
  const forkProvider = config?.forkProvider ?? 'fork';
  /** 名字过滤器：不传 = 九个全给；传了 = 只给名单里的（名单外的工具连 schema 都不注册）。 */
  const allowed = include === void 0 ? undefined : new Set(include);

  /**
   * 解析本次 spawn 的最终路由 + 队员名（异步：preflightRoute 要问 ctx.llm）。
   *
   * 返回值里的 `route` 是**本次 spawn 生效的路由**（用于回执与预检）；
   * `explicit` 只含**工具调用参数显式写的东西**（provider/model/reasoning_effort），
   * 它是唯一允许被钉住（`pinSpawnRoute`）的部分 —— 角色配置必须留给运行期实时读，
   * 否则用户在面板上改回「跟随 Lead」对已存在的队员永远不生效（2026-10-01 修）。
   *
   * @returns Promise<{name, route, explicit, diagnostics}>
   */
  async function resolveSpawn(args, caller, hostCtx) {
    const diagnostics = [];
    const role = args.role;
    if (typeof role !== 'string' || !ROLE_IDS.includes(role)) {
      throw new Error(`spawn_teammate 失败：role "${String(role)}" 不是合法角色（可选：${ROLE_IDS.join(', ')}）`);
    }
    let name = args.name;
    if (name === undefined) {
      name = nextTeammateName(role, takenNames(agentTeams, caller));
    } else {
      const trimmed = String(name).trim();
      if (!isValidTeammateName(trimmed)) {
        throw new Error(`spawn_teammate 失败：name "${trimmed}" 不是合法的队员名（必须是 <角色id> 或 <角色id>-N，N>=2）`);
      }
      if (deriveRole(trimmed) !== role) {
        throw new Error(`spawn_teammate 失败：name "${trimmed}" 推导出的角色是 "${String(deriveRole(trimmed))}"，与 role "${role}" 不一致`);
      }
      name = trimmed;
    }

    const hasProvider = typeof args.provider === 'string' && args.provider.trim() !== '';
    const hasModel = typeof args.model === 'string' && args.model.trim() !== '';
    if (hasProvider !== hasModel) {
      throw new Error('spawn_teammate 失败：provider 与 model 必须成对给出（只给一半会猜错路由，所以直接拒绝）');
    }
    const effort = typeof args.reasoning_effort === 'string' && args.reasoning_effort.trim() !== '' ? args.reasoning_effort.trim() : undefined;
    /** 只有工具调用显式给出的部分会被钉住；角色配置留给运行期实时解析。 */
    const explicit = {
      ...(hasProvider && hasModel ? { provider: args.provider.trim(), model: args.model.trim() } : {}),
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    };

    let route;
    if (hasProvider && hasModel) {
      route = { provider: args.provider.trim(), model: args.model.trim(), ...(effort === undefined ? {} : { reasoningEffort: effort }) };
      diagnostics.push(`本次 spawn 使用显式路由 ${route.provider}/${route.model}${effort === undefined ? '' : ` (${effort})`}`);
    } else {
      route = resolveRoleRoute(typeof runtime?.peekConfig === 'function' ? runtime.peekConfig() : undefined, role);
      if (route === undefined) {
        if (effort !== undefined) {
          diagnostics.push(`未给 provider/model 且角色 "${role}" 没有配置：本次 spawn 只把思考强度钉为 "${effort}"，模型仍跟随 Lead（能生效才会写进请求，模型不支持时自动忽略）`);
        }
      } else if (effort !== undefined) {
        route = { ...route, reasoningEffort: effort };
        diagnostics.push(`本次 spawn 在角色配置之上覆盖思考强度为 "${effort}"`);
      } else {
        diagnostics.push(`本次 spawn 使用角色 "${role}" 的配置路由 ${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : ` (${route.reasoningEffort})`}（角色配置是实时的：面板上改了，这个队员下一次请求就跟着变）`);
      }
    }

    if (route !== undefined) {
      if (typeof runtime?.preflightRoute !== 'function') {
        throw new Error('spawn_teammate 失败：runtime.preflightRoute 不可用，无法预检路由（不预检就可能派出一个请求必失败的队员）');
      }
      const checked = await runtime.preflightRoute(hostCtx, route);
      if (checked?.ok !== true) {
        throw new Error(`spawn_teammate 失败：路由不可用 —— ${(checked?.diagnostics ?? []).join('；')}`);
      }
      for (const note of checked.diagnostics ?? []) diagnostics.push(note);
      route = checked.route;
    }
    return { name, route, explicit, diagnostics };
  }

  const definitions = [
    defineTool({
      name: 'spawn_teammate',
      description: 'Create one named, durable teammate with a role. Only the Team Lead may call this tool. The role decides the teammate\'s duties, write scope, and default model/effort; the role brief is prepended to the prompt you pass, so do not restate duties — write the task itself.',
      parameters: {
        role: {
          type: 'string',
          required: true,
          enum: [...ROLE_IDS],
          description: 'Teammate role id; the teammate name is derived from it.',
        },
        name: {
          type: 'string',
          description: 'Optional; must be <role-id> or <role-id>-N. Omit to auto-pick an unused name.',
        },
        description: { type: 'string', required: true, description: 'Short description of the delegated responsibility.' },
        prompt: {
          type: 'string',
          required: true,
          description: 'Self-contained initial task: goal / known facts with file:line / what to do / boundaries and write scope / acceptance criteria / reply format / how to report back.',
        },
        context: {
          type: 'string',
          enum: ['fresh', 'fork'],
          description: 'fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.',
        },
        model: { type: 'string', description: 'Optional override of that role\'s model; must be paired with provider.' },
        provider: { type: 'string', description: 'Optional override of that role\'s provider; must be paired with model.' },
        reasoning_effort: { type: 'string', description: 'Optional override of that role\'s reasoning effort; must be one the model advertises.' },
      },
      output: jsonOutput(SPAWN_VALUE_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'spawn_teammate');
        const context = args.context ?? 'fresh';
        const { name, route, explicit, diagnostics } = await resolveSpawn(args, caller, resolveHostContext(exec));
        // 只钉**工具调用显式给出的**那份（`explicit`）：角色配置必须留给运行期每次请求实时读，
        // 否则面板上把角色改回「跟随 Lead」对已经在跑的队员永远不生效（用户 2026-10-01 报的 bug）。
        if (typeof runtime?.pinSpawnRoute === 'function') {
          runtime.pinSpawnRoute(name, Object.keys(explicit).length === 0 ? undefined : explicit);
        }
        let member;
        try {
          member = (await requireTeam(agentTeams, 'spawn_teammate').spawnTeammate(caller, {
            name,
            description: args.description,
            prompt: [
              { type: 'text', text: teammateBrief(args.role, name) },
              { type: 'text', text: args.prompt },
            ],
            context,
            provider: context === 'fork' ? forkProvider : freshProvider,
            signal: exec.signal,
          })).member;
        } catch (error) {
          if (typeof runtime?.pinSpawnRoute === 'function') runtime.pinSpawnRoute(name, undefined);
          throw error;
        }
        return {
          member: modelMember(member),
          role: args.role,
          ...(route === undefined ? {} : { route }),
          diagnostics,
        };
      },
    }),
    defineTool({
      name: 'send_message',
      description: 'Send one durable message to another Team member. A running target receives it at the nearest step boundary; an inactive target starts or resumes a turn.',
      parameters: {
        target: { type: 'string', description: 'Member name from list_agents or spawn_teammate, including lead. Give exactly one of target / agent_id.' },
        agent_id: { type: 'string', description: 'Member agent id, accepted as an alias of target (the host lists bare agent ids).' },
        message: { type: 'string', required: true, description: 'Self-contained message for the target.' },
      },
      output: jsonOutput(SEND_VALUE_SCHEMA),
      execute(args, exec) {
        const caller = callingAgent(exec.agent, 'send_message');
        return requireTeam(agentTeams, 'send_message').sendMessage(caller, {
          target: resolveTarget(args, agentTeams, caller, 'send_message'),
          content: [{ type: 'text', text: args.message }],
          signal: exec.signal,
        });
      },
    }),
    defineTool({
      name: 'list_agents',
      description: 'List the Lead and every durable teammate with an addressable target and current availability. inactive means no turn is executing, not a task result. provisioning and failed describe member creation.',
      parameters: {},
      output: jsonOutput(MEMBER_LIST_VALUE_SCHEMA),
      execute(_args, exec) {
        const caller = callingAgent(exec.agent, 'list_agents');
        // 先标注再投影：截断标志来自插件自己的 session/event 记账（runtime.truncatedMemberIds），
        // 写进成员行已有的 diagnostics 字段，Lead 据此区分「该 wake_teammate」与「该 send_message」。
        const rows = annotateTruncatedMembers(requireTeam(agentTeams, 'list_agents').listMembers(caller), runtime?.truncatedMemberIds?.() ?? []);
        return Promise.resolve(rows.map(modelMember));
      },
    }),
    defineTool({
      name: 'wait_agent',
      description: 'Wait for the next teammate status, mailbox, or shared-task change after this call starts. This never wakes inactive members and returns noProgress immediately when no other member is running or provisioning. Re-list after wakeup or timeout instead of polling.',
      parameters: {
        timeout_ms: { type: 'integer', description: 'Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000.' },
      },
      output: jsonOutput(WAIT_VALUE_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'wait_agent');
        const team = requireTeam(agentTeams, 'wait_agent');
        const timeoutMs = args.timeout_ms ?? 3e4;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1e4 || timeoutMs > 36e5) return await team.waitForChange(caller, timeoutMs, exec.signal);
        if (!team.listMembers(caller).some((member) => member.id !== caller.id && ACTIVE_WAIT_STATUSES.has(member.status))) {
          return {
            timedOut: false,
            noProgress: { reason: 'no-active-peer', message: NO_ACTIVE_PEER_MESSAGE },
          };
        }
        return await team.waitForChange(caller, timeoutMs, exec.signal);
      },
    }),
    defineTool({
      name: 'interrupt_agent',
      description: 'Interrupt one teammate\'s current turn while preserving its pending inbox. Team Lead only.',
      parameters: {
        target: { type: 'string', description: 'Teammate name from list_agents or spawn_teammate. Give exactly one of target / agent_id.' },
        agent_id: { type: 'string', description: 'Teammate agent id, accepted as an alias of target.' },
      },
      output: jsonOutput(INTERRUPT_VALUE_SCHEMA),
      execute(args, exec) {
        const caller = callingAgent(exec.agent, 'interrupt_agent');
        return Promise.resolve(requireTeam(agentTeams, 'interrupt_agent').interrupt(caller, resolveTarget(args, agentTeams, caller, 'interrupt_agent')));
      },
    }),
    defineTool({
      name: WAKE_TOOL_NAME,
      description: 'Wake one teammate whose previous turn was cut off by the model output limit, so it continues from where it stopped instead of starting over. Use it when list_agents shows the member inactive but it never delivered a report_result. Team Lead only. This is a normal durable message: it starts or resumes the member\'s turn.',
      parameters: {
        target: { type: 'string', description: 'Teammate name from list_agents (or agent_id).' },
        agent_id: { type: 'string', description: 'Teammate agent id, accepted as an alias of target.' },
        note: { type: 'string', description: 'Optional extra instruction appended after the standard continuation wording, e.g. the exact file to finish.' },
      },
      output: jsonOutput(SEND_VALUE_SCHEMA),
      execute(args, exec) {
        const caller = callingAgent(exec.agent, WAKE_TOOL_NAME);
        const target = resolveTarget(args, agentTeams, caller, WAKE_TOOL_NAME);
        const note = typeof args.note === 'string' ? args.note.trim().slice(0, WAKE_NOTE_LIMIT) : '';
        return requireTeam(agentTeams, WAKE_TOOL_NAME).sendMessage(caller, {
          target,
          content: [{ type: 'text', text: wakeInstruction(target, note) }],
          signal: exec.signal,
        });
      },
    }),
    defineTool({
      name: BROADCAST_TOOL_NAME,
      description: 'Send one identical message to several teammates in a single call (protocol or contract changes). Only the Team Lead may call this tool. Omit targets to reach every teammate that is currently running or provisioning: an inactive teammate is SKIPPED by default, because sending to one would start a new turn for it and cost another full run; pass include_inactive=true when waking everyone really is intended. One rejected target never blocks the others - every result is reported separately.',
      parameters: {
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional teammate names (or agent ids) from list_agents. Omit to broadcast to all running/provisioning teammates. The Lead itself is never a target.',
        },
        message: { type: 'string', required: true, description: 'Self-contained message every target receives verbatim.' },
        include_inactive: { type: 'boolean', description: 'Default false. true also wakes inactive teammates (each wake costs them a new turn).' },
      },
      output: jsonOutput(BROADCAST_VALUE_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, BROADCAST_TOOL_NAME);
        const team = requireTeam(agentTeams, BROADCAST_TOOL_NAME);
        // 正文限长：广播会把它复制进**每个**目标的邮箱（官方 maxPendingMessagesPerMember=64、
        // maxMessageBytes 也有上限），一份巨型文本按人数放大。超限直接拒，不做静默截断
        // ——静默截断会让部分队员收到半句话，比报错危险得多（2026-10-04 独立探针）。
        const message = typeof args.message === 'string' ? args.message : '';
        if (message.trim() === '') throw new Error(`${BROADCAST_TOOL_NAME} 失败：message 不能为空`);
        if (message.length > BROADCAST_MESSAGE_LIMIT) {
          throw new Error(`${BROADCAST_TOOL_NAME} 失败：message 超过 ${BROADCAST_MESSAGE_LIMIT} 字符（广播会复制给每个队员；把长文写成文件或任务，让队员自己读）`);
        }
        // 目标解析是纯函数（lib/roster.js 的 planBroadcastTargets）：排除 lead、去重、
        // 默认不唤醒 inactive，并把每个被跳过的原因如实报出来。
        let rows = [];
        try {
          rows = Array.isArray(team.listMembers(caller)) ? team.listMembers(caller) : [];
        } catch (error) {
          rows = [];
        }
        const plan = planBroadcastTargets(rows, {
          ...(Array.isArray(args.targets) ? { targets: args.targets } : {}),
          includeInactive: args.include_inactive === true,
          callerName: callerName(agentTeams, caller),
        });
        const sent = [];
        const failed = [];
        // 2026-10-04 独立探针抓出的缺陷：「被跳过」不是「投递失败」。早先把 skipped 也塞进 failed，
        // 于是只要名单里有 lead 伪行（**始终**有）就 failed.length > 0，ok 永远为 false ——
        // 模型看到 ok:false 会以为广播失败并重发。现在三者各自独立：
        //   sent    = 真投出去的
        //   failed  = 真调用 sendMessage 且抛错的（邮箱满、目标消失…）
        //   skipped = 按规则没发的（不是队员 / 你自己 / inactive 未开闸 / 名单里没有）
        // ok 的语义：**至少发出一条，且没有任何一条真投递失败**。全被跳过（例如全员 inactive 且没开闸）
        // 时 ok=false 是正确的 —— 那条消息确实一条都没送出去。
        for (const target of plan.targets) {
          // 每个目标独立 try/catch：邮箱满(TEAM_MAILBOX_FULL)、目标消失(TEAM_MEMBER_NOT_FOUND)
          // 之类只该影响这一个收件人，绝不带走整批。
          try {
            const result = await team.sendMessage(caller, {
              target,
              content: [{ type: 'text', text: message }],
              signal: exec.signal,
            });
            sent.push({ target, messageId: String(result?.messageId ?? ''), status: result?.status === 'queued' ? 'queued' : 'accepted' });
          } catch (error) {
            failed.push({ target, error: error instanceof Error ? error.message : String(error) });
          }
        }
        return {
          ok: sent.length > 0 && failed.length === 0,
          sent,
          failed,
          skipped: plan.skipped,
        };
      },
    }),
    defineTool({
      name: ASK_LEAD_TOOL_NAME,
      description: 'Ask the Team Lead one question that only the Lead (or the user) can settle, while you are still working. Every teammate may call this; the Lead does not have it. A decision you need now must go through here - asking the end user directly is not available to you, and guessing wrong is worse than waiting. Set blocking=false when you can keep working on the parts that do not depend on the answer.',
      parameters: {
        question: { type: 'string', required: true, description: 'The concrete question, self-contained: what you tried, what you are stuck on, and what options the Lead can choose between.' },
        blocking: { type: 'boolean', description: 'Default true = you stop and wait for an answer. false = you continue with work that does not depend on it.' },
      },
      output: jsonOutput(ASK_LEAD_VALUE_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, ASK_LEAD_TOOL_NAME);
        // 走官方 sendMessage(-> lead)，只加一个固定前缀让 Lead 能区分「等决策」与进度汇报：
        // 官方投递框架本身只写发件人（dsh-experimental-agent-team/lib/index.js:971-976），没有类型位。
        // 空白问题直接拒：探针显示原来会投出一条「（队员没有写清问题，请让它补充）」给 Lead，
        // 那对 Lead 是纯噪音（它无从判断到底想问什么）。非空但**过长**由 askLeadMessage 的
        // 调用方限长——这里与 broadcast 同口径（问题该短，长内容属于报告）。
        const question = typeof args.question === 'string' ? args.question : '';
        if (question.trim() === '') throw new Error(`${ASK_LEAD_TOOL_NAME} 失败：question 不能为空（写清你卡在哪、有哪些选项）`);
        if (question.length > ASK_LEAD_QUESTION_LIMIT) {
          throw new Error(`${ASK_LEAD_TOOL_NAME} 失败：question 超过 ${ASK_LEAD_QUESTION_LIMIT} 字符（问题要短；长背景写进 report_result 或让它去读文件）`);
        }
        const text = askLeadMessage(question, args.blocking !== false);
        const diagnostics = [];
        let delivered = false;
        let messageId = '';
        let status = 'queued';
        try {
          const result = await requireTeam(agentTeams, ASK_LEAD_TOOL_NAME).sendMessage(caller, {
            target: 'lead',
            content: [{ type: 'text', text }],
            signal: exec.signal,
          });
          delivered = true;
          messageId = String(result?.messageId ?? '');
          status = result?.status === 'accepted' ? 'accepted' : 'queued';
        } catch (error) {
          diagnostics.push('把问题投递给 lead 失败：' + (error instanceof Error ? error.message : String(error)) + '。把它写进 report_result 的 unresolved 里，状态用 needs_decision。');
        }
        if (args.blocking !== false) {
          diagnostics.push('已按阻塞处理：不要再自行推进依赖这个答案的部分；等 Lead 回消息后再继续。');
        }
        return { ok: delivered, delivered, question: text, message_id: messageId, status, diagnostics };
      },
    }),
    defineTool({
      name: 'team_task_create',
      description: 'Create one unowned pending task on the shared Team task board.',
      parameters: {
        subject: { type: 'string', required: true, description: 'Concise task title.' },
        description: { type: 'string', required: true, description: 'Complete task details and acceptance criteria.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task ids that must complete first.' },
        write_scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Advisory workspace-relative file or directory prefixes this task expects to modify.',
        },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        return await requireTeam(agentTeams, 'team_task_create').createTask(callingAgent(exec.agent, 'team_task_create'), {
          subject: args.subject,
          description: args.description,
          ...(args.blocked_by === void 0 ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) }),
          ...(args.write_scopes === void 0 ? {} : { writeScopes: args.write_scopes }),
        });
      },
    }),
    defineTool({
      name: 'team_task_list',
      description: 'List shared tasks, including readiness, owner, revision, blockers, and write-scope warnings.',
      parameters: {
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Optional exact status filter.' },
        owner: { type: 'string', description: 'Optional member target from spawn_teammate or list_agents, matching ownerName; use unowned for tasks without an owner.' },
        ready: { type: 'boolean', description: 'Optional readiness filter.' },
        cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
        limit: { type: 'integer', description: 'Number of rows, 1 through 100. Defaults to 50.' },
      },
      output: jsonOutput(TASK_LIST_VALUE_SCHEMA),
      execute(args, exec) {
        const team = requireTeam(agentTeams, 'team_task_list');
        const status = args.status;
        const filtered = team.listTasks(callingAgent(exec.agent, 'team_task_list')).filter((task) => (status === void 0 || task.status === status) && (args.owner === void 0 || (args.owner === 'unowned' ? task.ownerName === void 0 : task.ownerName === args.owner)) && (args.ready === void 0 || task.ready === args.ready));
        const cursor = args.cursor ?? 0;
        const limit = args.limit ?? 50;
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor must be a non-negative safe integer');
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 through 100');
        return Promise.resolve({
          tasks: filtered.slice(cursor, cursor + limit),
          ...(cursor + limit < filtered.length ? { nextCursor: cursor + limit } : {}),
        });
      },
    }),
    defineTool({
      name: 'team_task_get',
      description: 'Read the complete latest value of one shared task before changing or executing it.',
      parameters: { task_id: { type: 'string', required: true, description: 'Shared task id.' } },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        return Promise.resolve(requireTeam(agentTeams, 'team_task_get').getTask(callingAgent(exec.agent, 'team_task_get'), TeamTaskId(args.task_id)));
      },
    }),
    defineTool({
      name: 'team_task_update',
      description: 'Compare-and-set a shared task action using the latest revision from team_task_get or team_task_list.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Shared task id.' },
        expected_revision: { type: 'integer', required: true, description: 'Current task revision used as the CAS precondition.' },
        action: {
          type: 'string',
          required: true,
          enum: ['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete'],
          description: 'Task transition to apply.',
        },
        subject: { type: 'string', description: 'Replacement title for edit.' },
        description: { type: 'string', description: 'Replacement details for edit.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Complete blocker list for set_dependencies.' },
        write_scopes: { type: 'array', items: { type: 'string' }, description: 'Replacement advisory write scopes for edit.' },
        owner: { type: 'string', description: 'Member target from spawn_teammate or list_agents for Lead-only reassign; omit to unassign.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        return await requireTeam(agentTeams, 'team_task_update').updateTask(callingAgent(exec.agent, 'team_task_update'), {
          taskId: TeamTaskId(args.task_id),
          expectedRevision: args.expected_revision,
          action: args.action,
          ...(args.subject === void 0 ? {} : { subject: args.subject }),
          ...(args.description === void 0 ? {} : { description: args.description }),
          ...(args.blocked_by === void 0 ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) }),
          ...(args.write_scopes === void 0 ? {} : { writeScopes: args.write_scopes }),
          ...(args.owner === void 0 ? {} : { owner: args.owner }),
        });
      },
    }),
  ];

  /**
   * `report_result` —— **队员专用**的结构化汇报工具。
   *
   * 为什么需要它（形状与投递行为见 README §2.4）：
   * 只靠提示词要求「如实汇报」，验收方拿到的是散文；散文里没有办法机器判定
   * 「有没有未决项 / 有没有验收证据 / 有没有动冻结的验收文件」。把它做成工具以后：
   *   1. 形状固定（status / summary / evidence / acceptance / unresolved / changed_files），
   *      插件可以**自己**检查（completed 必须有证据、unresolved 非空就会阻止验收）；
   *   2. 插件**自己把报告投递给 Lead**（`agentTeams.sendMessage`），所以「没有结构化报告 = 未完成」
   *      这条纪律不依赖队员是否记得再发一条消息；
   *   3. 报告进 runtime 的记录（状态文件里能看到最近几份），排查「它到底报了什么」不用翻会话。
   *
   * Lead 不注册这个工具（它没有汇报对象），所以它只在队员的工具目录里。
   */
  const reportDefinition = defineTool({
    name: REPORT_TOOL_NAME,
    description: 'Submit the structured delivery report for your assignment. Every teammate must call this before reporting back: it records status/summary/evidence/acceptance/unresolved and is delivered to the lead for you. A delivery without this report is treated as unfinished. ok=true means the report was generated AND delivered to the lead; ok=false means it was not delivered - follow the diagnostics and resend via send_message.',
    parameters: {
      status: {
        type: 'string',
        required: true,
        enum: ['completed', 'blocked', 'needs_decision'],
        description: 'completed = done and verified; blocked = hard obstacle (needs lead decision or missing condition); needs_decision = the task itself is ambiguous and guessing would be wrong.',
      },
      summary: { type: 'string', required: true, description: 'What you did or what happened, bounded (conclusions, not raw logs).' },
      evidence: {
        type: 'array',
        items: { type: 'string' },
        description: 'Concrete evidence: real commands with their real output, file:line references, URLs. Required (non-empty) when status is completed.',
      },
      acceptance: { type: 'string', description: 'The acceptance command you ran with its real result (include test counts when it is a suite). "not run" is a valid honest answer — say why.' },
      unresolved: {
        type: 'array',
        items: { type: 'string' },
        description: 'Every requirement not yet satisfied, assumption not verified, or shortcut taken. Each item blocks acceptance — never hide one to look done.',
      },
      changed_files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Workspace-relative files you changed. Frozen acceptance files you had to touch must appear here AND be explained in unresolved.',
      },
    },
    output: jsonOutput(REPORT_VALUE_SCHEMA),
    async execute(args, exec) {
      const caller = callingAgent(exec.agent, REPORT_TOOL_NAME);
      const report = validateReport(args);
      const name = callerName(agentTeams, caller);
      const text = formatReport(name, report);
      const diagnostics = [];
      if (typeof runtime?.recordReport === 'function') {
        try {
          runtime.recordReport(name, report);
        } catch (error) {
          diagnostics.push(`报告已生成，但写入插件记录失败（已吞掉异常本身）：${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        diagnostics.push('runtime.recordReport 不可用：报告没有进插件记录（仍会尝试投递给 Lead）');
      }
      let delivered = false;
      try {
        await requireTeam(agentTeams, REPORT_TOOL_NAME).sendMessage(caller, {
          target: 'lead',
          content: [{ type: 'text', text }],
          signal: exec.signal,
        });
        delivered = true;
      } catch (error) {
        diagnostics.push(`把报告投递给 lead 失败：${error instanceof Error ? error.message : String(error)}。请改用 send_message({target:"lead"}) 把上面这份报告原文发过去。`);
      }
      return {
        // ok 的语义 = 「报告已生成**且**已成功投递给 Lead」。投递失败时它是 false，
        // 与 delivered 一致；模型只看 ok 就不会误以为 Lead 收到了（2026-10-04 审查 P2-25）。
        ok: delivered,
        delivered,
        status: report.status,
        unresolved: report.unresolved,
        report: text,
        diagnostics,
      };
    },
  });

  // 队员拿到的是**子集**：spawn_teammate / interrupt_agent 是 Lead 专属，report_result 是队员专属。
  // 过滤放在最后，保证「名单外的工具连 schema 都不注册」，而不是注册了再靠权限拒绝——后者会把
  // 队员（或 Lead）的工具目录撑大、prompt 里还要解释它们为什么不能用。
  //
  // ⚠️ Lead 的目录里**不含** report_result：这里用 `!=` 显式把队员专属工具从「全部」里摘掉。
  // 这一点对缓存也重要：工具目录是提示词前缀的一部分，目录必须逐次请求完全一致。
  const memberOnly = new Set([REPORT_TOOL_NAME, ASK_LEAD_TOOL_NAME]);
  const allowedDefinitions = allowed === void 0
    ? definitions.filter((definition) => !memberOnly.has(definition.name))
    : definitions.filter((definition) => allowed.has(definition.name));
  const withReport = allowed !== void 0 && allowed.has(REPORT_TOOL_NAME) ? [...allowedDefinitions, reportDefinition] : allowedDefinitions;
  return withReport;
}

/**
 * 构建两个开关工具（注册在 **preset scope**，由 lib/preset.js 调用）。
 *
 * ⚠️ 这两个工具**不再往会话里注入任何消息**（2026-10-01 18:26 现场）：
 * 以前开团成功后会用 `agent.followup(...)` 塞一句「团队已开启…」，而 `followup` 的语义是
 * `send(input, 'next-turn', true)`（`dsh-agent-loop/lib/index.js:806-808`）——消息进的是 Session 的
 * `next-turn` 收件箱，客户端的 **QueueDock 正是从那里读**，于是那句话**排队在用户的输入框上方**，
 * 用户还得手动点一次「插入」。而它本来就不必要：系统提示词与工具目录**每个 step 都会重新组装**
 * （`dsh-agent-loop/lib/index.js:907` 的 preStep → `systemPrompt.assemble()`，`:1063` 的
 * `buildRequest(..., assembly.tools, …)`），所以模型在本轮的下一个 step 就拿着新工具与新策略段了。
 *
 * 现在改为把一句**状态说明放进工具返回值**（`diagnostics`）：它随工具结果回到模型，
 * 不进收件箱、不出现在用户输入框、也不占对话气泡。
 *
 * @param options - {runtime}。runtime 需提供 enable / disable（enable: async，disable: 同步）。
 * @returns 两个 ToolDefinition。
 */
export function controlToolDefinitions({ runtime } = {}) {
  /** 列当前队员名（best effort；只用于给 Lead 一个确认清单）。 */
  function memberNames(hostCtx, agent) {
    const teams = hostCtx?.get?.('agentTeams');
    if (teams === undefined || typeof teams.listMembers !== 'function') return [];
    try {
      return (teams.listMembers(agent) ?? [])
        .filter((row) => row?.role === 'teammate' && typeof row?.name === 'string')
        .map((row) => row.name);
    } catch {
      return [];
    }
  }

  return [
    defineTool({
      name: 'enable_agent_team',
      description: 'Enable Agent Teams collaboration for this session: install the team tools and policy, then keep working as the Team Lead. Only the Lead may call this.',
      parameters: { note: { type: 'string', description: 'Optional extra intent from the user, e.g. "research only" or "review the plan first".' } },
      output: jsonOutput(CONTROL_VALUE_SCHEMA),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'enable_agent_team');
        if (runtime === undefined || typeof runtime.enable !== 'function') {
          return { ok: false, enabled: false, members: [], diagnostics: ['runtime.enable 不可用：本插件的 host 半未加载'] };
        }
        const hostCtx = resolveHostContext(exec);
        const result = await runtime.enable(hostCtx, agent, {
          source: 'tool',
          rawInput: typeof args.note === 'string' ? args.note : undefined,
        });
        const diagnostics = Array.isArray(result?.diagnostics) ? [...result.diagnostics] : [];
        if (result?.ok === true) {
          // 状态说明走工具返回值（模型看得到、用户不会被排队打断）。纪律在 PLAYBOOK 里，不在这里复述。
          diagnostics.push('团队已开启：队员卡与团队工具从下一个 step 起生效，按调度模式继续（先查事实 → 需要用户拍板的问题一次性列全并给推荐答案 → 计划与写域定好再派 builder）。');
        }
        return {
          ok: result?.ok === true,
          enabled: result?.enabled === true,
          members: memberNames(hostCtx, agent),
          diagnostics,
        };
      },
    }),
    defineTool({
      name: 'disable_agent_team',
      description: 'Disable Agent Teams collaboration for this session: uninstall the team tools. Only the Lead may call this.',
      parameters: {},
      output: jsonOutput(CONTROL_VALUE_SCHEMA),
      async execute(_args, exec) {
        const agent = callingAgent(exec.agent, 'disable_agent_team');
        if (runtime === undefined || typeof runtime.disable !== 'function') {
          return { ok: false, enabled: false, members: [], diagnostics: ['runtime.disable 不可用：本插件的 host 半未加载'] };
        }
        const result = await runtime.disable(resolveHostContext(exec), agent);
        const diagnostics = Array.isArray(result?.diagnostics) ? [...result.diagnostics] : [];
        if (result?.ok === true && result.wasEnabled === true) {
          // 同样只走工具返回值：告诉模型「工具面已经在下一个 step 卸掉」，纪律见 PLAYBOOK §2。
          diagnostics.push('团队已关闭：团队工具从下一个 step 起不再可用。不要再创建或指挥队员；已派出的队员产出仍可采纳，后续工作自己完成（需要并行查事实时用 subagent / subagent_fork）。');
        }
        return {
          ok: result?.ok === true,
          enabled: false,
          members: [],
          diagnostics,
        };
      },
    }),
  ];
}

/**
 * 两个开关工具注册在 preset scope，但 runtime.enable/disable 需要宿主 ctx 才能取服务。
 * 工具执行时 `exec` 上没有宿主 ctx，所以退化用 `exec.agent.ctx`（agent scope 同样能 `ctx.get(...)`
 * 到 agentTeams/llm/agents —— Cordis 的服务容器对任意作用域 ctx 都可见），并优先使用 exec.ctx（若存在）。
 */
function resolveHostContext(exec) {
  if (exec !== undefined && exec !== null && exec.ctx !== undefined && exec.ctx !== null) return exec.ctx;
  return exec?.agent?.ctx;
}