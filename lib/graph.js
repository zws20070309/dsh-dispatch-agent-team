// 调度模式智能体团队 —— 工作区画布的图数据（host 半）
//
// 这里只做一件事：把「一个团队会话」的真实运行状态折叠成画布能直接消费的
// {nodes, edges, tasks, totals}。所有字段都有明确来源，**不编造**：
//
//   * 成员与角色        —— ctx.agentTeams.listMembers(lead)（dsh-experimental-agent-team/lib/index.js:1755）
//   * 任务与 TODO       —— ctx.agentTeams.listTasks(lead)（同上 :1799）+ 各会话的 todo/write 事件
//   * 模型 / 上下文窗口 —— 会话事件 model/selection、request/context（实测形状见下）
//   * token / 缓存命中  —— assistant/message 的 data.usage，按 token-meter 同款 last-wins 去重
//   * 运行时 / TPS      —— turn/start…turn/end 的 time 差值累计；TPS = outputTokens / 运行秒
//   * 上下文占用（环）  —— 最近一次 usage 的 prompt 侧（input+cacheRead+cacheWrite）/ contextWindow
//   * 派活边（Lead→员） —— Lead 会话里的 team/message/queued（senderName==='lead'，按 targetId 记）
//   * 交付边（员→Lead） —— 同一份账里 senderName===队员名 且发给 Lead 的消息（report_result/ask_lead
//                          实测落在 Lead 的会话日志，按发件人可查）；有则成员线转绿
//   * 承接边（员↔员）   —— A 的 tool/call(edit|write).file_path ∩ B 的 tool/call(read).file_path
//
// 事件读取走 `agent.session.eventAt(seq)` + `session.seq`（dsh-session/lib/index.js:1363/1401），
// 与官方 token-meter 的增量折叠同一套（dsh-token-meter/lib/index.js:718-721），不读磁盘、不碰 zstd。
// 每个会话的折叠结果按 sessionId 缓存，记录已消费到的 seq；再次请求只补增量。
//
// 依赖：纯函数部分只用 lib/text-clip.js（代理对安全截断，全插件统一走它）；
// live 部分只用 runtime 已验证过的 ctx 门面。

import { clipText } from './text-clip.js';

/**
 * 会话 id 归一：目录/事件里的 Lead id 带 `session-` 前缀，域服务的 member.id 不带。
 * 比较 targetId 时统一去掉前缀（实测：team/message 的 targetId = `session-<uuid>`，
 * 而 team/member 的 member.id = `<uuid>`）。
 * @param {string} id
 * @returns {string}
 */
export function normId(id) {
  return typeof id === 'string' ? id.replace(/^session-/, '') : '';
}

/** 事件类型常量（全部来自实测日志，见文件头）。 */
const EV_ASSISTANT = 'assistant/message';
const EV_ATTEMPT = 'assistant/attempt';
const EV_RETRY_START = 'llm/retry-started';
const EV_REQUEST_CONTEXT = 'request/context';
const EV_MODEL_SELECTION = 'model/selection';
const EV_TODO_WRITE = 'todo/write';
const EV_TOOL_CALL = 'tool/call';
const EV_TURN_START = 'turn/start';
const EV_TURN_END = 'turn/end';
const EV_USER_MESSAGE = 'user/message';
const EV_TEAM_MESSAGE_QUEUED = 'team/message/queued';
const EV_TEAM_MESSAGE_DELIVERED = 'team/message/delivered';
const EV_TEAM_MEMBER = 'team/member';

const WRITE_TOOLS = new Set(['edit', 'write', 'search_replace', 'create_file']);
const READ_TOOLS = new Set(['read', 'read_file', 'view_file']);

/**
 * 派活工具名（Lead 用它把队员派出去）。
 *
 * ⚠️ 为什么派活账必须包含它：实测（2026-10-08，session-898e4c64）Lead 用 `spawn_teammate`
 * 派了 3 个队员（seq 76/133/211），而 `team/message` 只有 2 条**后续补充消息**。
 * 只数 team/message 时：scout-slots 与 verify-copyid 都显示「Lead 派活 0 条」——
 * 但它们明明是 Lead 派的活。用户看到的就是这个（截图 #3）。
 * 判据：`tool/call` 且 `name` 在这个集合里，参数里的 `name` 字段就是队员名。
 */
const SPAWN_TOOLS = new Set(['spawn_teammate', 'spawn_agent']);

/**
 * 规范化文件路径用于跨成员比对：去掉盘符，保留最后 4 段。
 * 与 .probe/extract-deps.mjs 的判据逐字一致（承接边的唯一真值来源）。
 * @param {unknown} p - tool/call 参数里的 file_path / path / filePath / notebook_path。
 * @returns {string|null}
 */
export function normalizePath(p) {
  if (typeof p !== 'string' || p === '') return null;
  let s = p.replace(/\\/g, '/').replace(/^[A-Za-z]:\//, '');
  const parts = s.split('/').filter(Boolean);
  return parts.length === 0 ? null : parts.slice(-4).join('/');
}

/** 一个会话的初始折叠状态（幂等，可反复 reset）。 */
export function emptyStats() {
  return {
    consumedSeq: 0,
    firstTime: undefined,
    lastTime: undefined,
    /** provider 上报的四桶累计（last-wins 去重后）。 */
    usage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    /** 上一条 assistant 结算的 {turn, step, buckets}，用于替换语义（重试会重写同一 turn/step）。 */
    usageLast: null,
    provider: undefined,
    model: undefined,
    effort: undefined,
    contextWindow: undefined,
    /** 最近一次 usage 的 prompt 侧占用（驱动上下文环）。 */
    pressureTokens: undefined,
    /** 该会话自己那份 todo/write 的计数：done / running / total。 */
    todo: { done: 0, running: 0, total: 0 },
    wrote: new Set(),
    read: new Set(),
    /** 运行秒累计（turn/start → turn/end）。 */
    runtimeMs: 0,
    /** 未闭合的 turn 起点：turn → time。 */
    openTurns: new Map(),
    /** Lead 会话里的团队消息账（targetId → {dispatched, delivered}）。 */
    teamMsg: new Map(),
    /**
     * Lead 用 spawn 工具派出队员的账（队员名 → 次数）。
     * 与 teamMsg 分开记：一个数「派出去几次」、一个数「后续发了几条消息」，
     * 浮窗里显示的是两者之和（见 buildGraph 的 dispatch 边）。
     */
    spawnByName: new Map(),
    /**
     * Lead 日志里**非 lead 发件人**的消息账（senderName → targetId → 条数）。
     * 团队域日志集中在 Lead 会话（TeamJournal 以 Lead 为根），所以「谁向 Lead 交过话」
     * 以这份账为准；targetId 有的带 session- 前缀有的不带，比较时统一（normId）。
     */
    msgFrom: new Map(),
    /** messageId → {senderName, targetId}：delivered 事件扁平，靠这张表回连发件人。 */
    msgSender: new Map(),
    /** 成员 id → name（Lead 会话里的 team/member 事件）。 */
    memberNames: new Map(),
    /** 最近一次 turn/end 的 reason.kind（截断/正常/中止），排查用。 */
    lastTurnEndReason: undefined,
  };
}

/**
 * 团队消息入账（queued / delivered 共用）。
 * senderName==='lead' → 记到 teamMsg（Lead 派出去的账，按 targetId）；
 * 其它发件人 → 记到 msgFrom（队员发往谁的账，按 senderName → normId(targetId)）。
 * @param stats - emptyStats() 形状。
 * @param senderName - 发件人名（delivered 事件里取不到时是空串，跳过）。
 * @param targetId - 收件会话 id。
 * @param delivered - true = 投递确认，false = 排队。
 */
function accountMessage(stats, senderName, targetId, delivered) {
  if (senderName === 'lead') {
    const row = stats.teamMsg.get(targetId) ?? { dispatched: 0, delivered: 0 };
    if (delivered) row.delivered += 1; else row.dispatched += 1;
    stats.teamMsg.set(targetId, row);
    return;
  }
  if (senderName === '') return;
  const byTarget = stats.msgFrom.get(senderName) ?? new Map();
  const key = normId(targetId);
  const row = byTarget.get(key) ?? { queued: 0, delivered: 0 };
  if (delivered) row.delivered += 1; else row.queued += 1;
  byTarget.set(key, row);
  stats.msgFrom.set(senderName, byTarget);
}

/** 从 usage 对象取四桶（缺字段按 0，永不 NaN）。 */
function bucketsOf(usage) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    uncachedInputTokens: n(usage.inputTokens),
    outputTokens: n(usage.outputTokens),
    cacheReadTokens: n(usage.cacheReadTokens),
    cacheWriteTokens: n(usage.cacheWriteTokens),
  };
}

/** prompt 侧占用：input + cacheRead + cacheWrite（与 token-meter 的 pressureFrom 同式）。 */
function pressureFrom(buckets) {
  return buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens;
}

/**
 * 把一批事件折进 stats（就地更新）。纯函数语义：不读外部状态、不抛错（坏事件跳过）。
 * @param {object} stats - emptyStats() 的形状。
 * @param {Array<{type:string, seq:number, time:number, data:object}>} events - 按 seq 升序。
 * @returns {object} 同一个 stats（便于链式）。
 */
export function foldEvents(stats, events) {
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    if (typeof event.time === 'number') {
      if (stats.firstTime === undefined) stats.firstTime = event.time;
      stats.lastTime = event.time;
    }
    const data = event.data ?? {};
    switch (event.type) {
      case EV_RETRY_START: {
        // 同 turn/step 的重试开始：**只关掉替换槽，不扣账**（官方 token-meter :422-425 同义）。
        // 语义：重试的那次是真实发生的消耗，两条 usage 都要计入总额；
        // 关槽只是让「重试后的结算」不再覆盖「重试前的结算」。没有重试事件时，
        // 同一 turn/step 的重复结算（attempt→message）仍然按替换处理（见 EV_ASSISTANT 分支）。
        if (stats.usageLast?.turn === data.turn && stats.usageLast?.step === data.step) {
          stats.usageLast = null;
        }
        break;
      }
      case EV_ASSISTANT:
      case EV_ATTEMPT: {
        const usage = usageOf(event);
        if (usage === undefined) break;
        const buckets = bucketsOf(usage);
        const turn = Number.isFinite(data.turn) ? data.turn : undefined;
        const step = Number.isFinite(data.step) ? data.step : undefined;
        const prev = stats.usageLast !== null && stats.usageLast.turn === turn && stats.usageLast.step === step
          ? stats.usageLast.buckets : undefined;
        for (const key of Object.keys(stats.usage)) {
          stats.usage[key] += buckets[key] - (prev?.[key] ?? 0);
        }
        stats.usageLast = { turn, step, buckets };
        stats.pressureTokens = pressureFrom(buckets);
        break;
      }
      case EV_REQUEST_CONTEXT: {
        if (Number.isFinite(data.contextWindow)) stats.contextWindow = data.contextWindow;
        if (typeof data.provider === 'string') stats.provider = data.provider;
        if (typeof data.model === 'string') stats.model = data.model;
        break;
      }
      case EV_MODEL_SELECTION: {
        if (typeof data.provider === 'string') stats.provider = data.provider;
        if (typeof data.model === 'string') stats.model = data.model;
        if (typeof data.reasoningEffort === 'string') stats.effort = data.reasoningEffort;
        break;
      }
      case EV_TODO_WRITE: {
        const todos = Array.isArray(data.todos) ? data.todos : [];
        let done = 0;
        let running = 0;
        for (const todo of todos) {
          if (todo?.status === 'completed') done += 1;
          else if (todo?.status === 'in_progress') running += 1;
        }
        stats.todo = { done, running, total: todos.length };
        break;
      }      case EV_TOOL_CALL: {
        const args = parseToolArgs(data.arguments);
        // 派活：`spawn_teammate({name})` 也算一次派活（见 SPAWN_TOOLS 的注释）。
        // 放在路径解析**之前**：spawn 参数里没有文件路径，走不到下面的 wrote/read。
        if (SPAWN_TOOLS.has(data.name)) {
          const spawned = typeof args?.name === 'string' ? args.name.trim() : '';
          if (spawned !== '') stats.spawnByName.set(spawned, (stats.spawnByName.get(spawned) ?? 0) + 1);
          break;
        }
        const path = args === undefined ? null
          : normalizePath(args.file_path ?? args.path ?? args.filePath ?? args.notebook_path);
        if (path === null) break;
        if (WRITE_TOOLS.has(data.name)) stats.wrote.add(path);
        else if (READ_TOOLS.has(data.name)) stats.read.add(path);
        break;
      }
      case EV_TURN_START: {
        if (Number.isFinite(data.turn) && typeof event.time === 'number') {
          stats.openTurns.set(data.turn, event.time);
        }
        // TODO 属于**当前这一轮**：新一轮开始时清空上一轮留下的清单。
        //
        // 为什么必须清（用户 2026-10-08 报的问题）：Lead 给队员发第二条团队消息 → 队员开 turn 2，
        // 而 turn 2 里**没有** todo/write。真实数据（session-898e4c64 的 builder-copyid）：
        // turn 1 在 seq=520 结束、turn 2 在 seq=523 开始，最后一次 todo/write 在 seq=514（4/0/4）。
        // 不清的话，第二轮画布上仍显示第一轮的 4/0/4 —— 用户看到的就是「明明这轮没列 TODO，
        // 却还挂着上一轮的」。清空后语义是「这一轮还没写 TODO」，与事实一致；
        // 这一轮真写了 todo/write 就立刻填回来（单轮会话完全不受影响：turn/start 在 todo/write 之前）。
        stats.todo = { done: 0, running: 0, total: 0 };
        break;
      }
      case EV_TURN_END: {
        if (Number.isFinite(data.turn)) {
          const start = stats.openTurns.get(data.turn);
          if (start !== undefined && typeof event.time === 'number') {
            stats.runtimeMs += Math.max(0, event.time - start);
            stats.openTurns.delete(data.turn);
          }
        }
        stats.lastTurnEndReason = data?.reason?.kind;
        break;
      }      case EV_TEAM_MEMBER: {
        const member = data.member;
        if (member !== undefined && typeof member.id === 'string' && typeof member.name === 'string') {
          stats.memberNames.set(member.id, member.name);
        }
        break;
      }
      case EV_TEAM_MESSAGE_QUEUED: {
        const message = data.message;
        if (message === undefined) break;
        const targetId = typeof message.targetId === 'string' ? message.targetId : '';
        const senderName = typeof message.senderName === 'string' ? message.senderName : '';
        // messageId → 发件人：delivered 事件是**扁平形状**（只有 messageId/targetId，没有 message 包装，
        // 实测 dsh-experimental-agent-team/lib/index.js:958-962），靠这张表回连是谁发的。
        if (typeof message.id === 'string' && message.id !== '') {
          stats.msgSender.set(message.id, { senderName, targetId });
        }
        accountMessage(stats, senderName, targetId, false);
        break;
      }
      case EV_TEAM_MESSAGE_DELIVERED: {
        // 扁平：{version, teamId, messageId, targetId}。发件人从 queued 时记的表里取。
        const messageId = typeof data.messageId === 'string' ? data.messageId : '';
        const targetId = typeof data.targetId === 'string' ? data.targetId : '';
        const sender = stats.msgSender.get(messageId);
        const senderName = sender === undefined ? '' : sender.senderName;
        accountMessage(stats, senderName, targetId, true);
        break;
      }
      default:
        break;
    }
  }
  return stats;
}

/**
 * assistant 结算里的 usage：优先 data.usage，退回流末的 usage chunk。
 *
 * ⚠️ 官方流记录的形状是**两层**：`{type:'chunk', chunk:{type:'usage', usage:{...}}}`
 * （dsh-llm/lib/types/assistant-stream.js:304-311），usage 嵌在 `record.chunk.usage` 里。
 * 只判 `record.type === 'usage'` / `record.usage` 两种扁平形状时**永远匹配不上** → 兜底恒为
 * undefined（审查实测：全库 8 条带 usage 的 assistant/attempt 里，1 条是真数且没有对应的
 * assistant/message，于是那个会话少算 17374 input token）。所以三种形状都要认。
 * @param {object} event - assistant/message 或 assistant/attempt 事件。
 * @returns {object|undefined} usage 对象。
 */
function usageOf(event) {
  if (event.data?.usage !== undefined) return event.data.usage;
  const stream = event.data?.stream;
  if (!Array.isArray(stream)) return undefined;
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const record = stream[i];
    if (record === null || record === undefined) continue;
    // ① 官方两层形状：{type:'chunk', chunk:{type:'usage', usage}}
    if (record.chunk?.type === 'usage' && record.chunk.usage !== undefined) return record.chunk.usage;
    // ② 扁平形状（防御：将来官方若拍平）
    if (record.type === 'usage' && record.usage !== undefined) return record.usage;
    // ③ 更宽松的兜底：任何带 usage 字段的记录
    if (record.usage !== undefined && typeof record.usage === 'object') return record.usage;
    if (record.chunk?.usage !== undefined && typeof record.chunk.usage === 'object') return record.chunk.usage;
  }
  return undefined;
}

/** tool/call.arguments 可能是字符串或对象；坏 JSON 返回 undefined（跳过，不猜）。 */
function parseToolArgs(raw) {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 从一份完整事件数组建会话统计（单测与冷启动用）。
 * @param {Array} events
 * @returns {object} stats
 */
export function foldSession(events) {
  return foldEvents(emptyStats(), events);
}

/**
 * 会话的**有效运行时长**：已闭合 turn 的累计 + 仍未闭合 turn 的已耗时。
 *
 * 为什么必须有它（用户 2026-10-08 报的 #4：卡片上运行时间/TPS 显示「—」）：
 * `runtimeMs` 只在 `turn/end` 结算，而真实会话经常没有 turn/end ——
 * 额度耗尽、用户中断、宿主被杀，turn 就永远挂着，于是 runtimeMs 保持 0，
 * 卡片与浮窗都显示「— —」，可它明明已经跑了几十分钟（用户截图里的 lead 就是这样）。
 *
 * 为什么在**读取时**算而不是在折叠时写回：活体路径是**每轮增量折叠**的，
 * 若在折叠时把「未闭合 turn 的已耗时」写进 runtimeMs，下一轮会再算一次 → 重复计数。
 * 读取时按「最后一条事件时间 − turn 起点」现算，永远只算一次，且随时间自然增长。
 * @param {object} stats - 折叠统计。
 * @returns {number} 毫秒。
 */
export function effectiveRuntimeMs(stats) {
  let ms = Number.isFinite(stats?.runtimeMs) ? stats.runtimeMs : 0;
  const last = Number.isFinite(stats?.lastTime) ? stats.lastTime : undefined;
  if (last !== undefined && stats?.openTurns !== undefined) {
    for (const [, start] of stats.openTurns) {
      if (Number.isFinite(start)) ms += Math.max(0, last - start);
    }
  }
  return ms;
}

/**
 * 由 Lead + 成员统计构建画布图。纯函数，输入决定输出，便于断言。
 * @param {object} input
 * @param {string} input.leadId - Lead 会话 id。
 * @param {string} input.leadName - 通常 'lead'。
 * @param {Array<{id:string,name:string,role:string,status:string,model?:string,provider?:string,description?:string}>} input.members - listMembers 输出。
 * @param {Map<string,object>} input.statsBySession - sessionId → 折叠统计。
 * @param {Array<object>} input.tasks - listTasks 输出（含 ownerName/blockedBy/status/ready）。
 * @returns {{nodes: Array, edges: Array, tasks: Array, totals: object}}
 */
export function buildGraph({ leadId, leadName, members, statsBySession, tasks }) {
  const nodes = [];
  const leadStats = statsBySession.get(leadId) ?? emptyStats();

  const nodeOf = (id, name, role, meta) => {
    const s = statsBySession.get(id) ?? emptyStats();
    const totalInput = s.usage.uncachedInputTokens + s.usage.cacheReadTokens + s.usage.cacheWriteTokens;
    const totalTokens = totalInput + s.usage.outputTokens;
    const cacheHit = totalInput > 0 ? s.usage.cacheReadTokens / totalInput : 0;
    // 运行时长用**有效值**（含未闭合 turn 的已耗时），否则额度中断/被杀的会话会显示「—」。
    const runtimeMs = effectiveRuntimeMs(s);
    const runtimeSec = runtimeMs / 1000;
    const tps = runtimeSec > 0.5 ? s.usage.outputTokens / runtimeSec : 0;
    const contextRatio = s.contextWindow && s.pressureTokens !== undefined
      ? Math.min(1, s.pressureTokens / s.contextWindow) : 0;
    return {
      id,
      name,
      role,
      status: meta?.status ?? (role === 'lead' ? 'active' : 'unknown'),
      model: s.model ?? meta?.model,
      provider: s.provider ?? meta?.provider,
      effort: s.effort,
      description: meta?.description,
      usage: { ...s.usage },
      totalTokens,
      cacheHit,
      runtimeMs,
      tps,
      contextWindow: s.contextWindow,
      pressureTokens: s.pressureTokens,
      contextRatio,
      todo: { ...s.todo },
      firstTime: s.firstTime,
      lastTime: s.lastTime,
      /** 未闭合的 turn 数（>0 = 会话被打断/仍在跑；浮窗据此如实说明）。 */
      openTurns: s.openTurns?.size ?? 0,
    };
  };

  nodes.push(nodeOf(leadId, leadName, 'lead', { status: 'active' }));
  // 先过滤成「形状完整且不是 Lead」的成员集合：节点、边、memberIds 三处共用同一份，
  // 任何一处各算各的都会画出悬空边（边指向一个不存在的节点）。
  const teammateRows = members.filter((member) => member !== undefined && member !== null
    && typeof member.id === 'string' && member.id !== ''
    && typeof member.name === 'string' && member.name !== ''
    && member.id !== leadId && member.role !== 'lead');
  for (const member of teammateRows) {
    nodes.push(nodeOf(member.id, member.name, 'teammate', member));
  }

  // 派活 / 交付边：Lead 会话里的两本账 —— **spawn 派出次数** + **后续 team/message 条数**。
  //
  // ⚠️ 两本账都必须算：实测（2026-10-08，session-898e4c64）Lead 用 spawn_teammate 派了 3 个队员，
  // 但 team/message 只有 2 条补充消息。只数 team/message 时 scout-slots 与 verify-copyid 都显示
  // 「Lead 派活 0 条」，而它们明明是 Lead 派的活（用户截图 #3 就是这个）。
  const edges = [];
  const memberIds = new Set(teammateRows.map((m) => m.id));
  const nameById = new Map(teammateRows.map((m) => [m.id, m.name]));
  nameById.set(leadId, leadName);

  for (const id of memberIds) {
    const name = nameById.get(id);
    const row = leadStats.teamMsg.get(id) ?? leadStats.teamMsg.get(`session-${id}`);
    const messaged = row?.dispatched ?? 0;
    const spawned = leadStats.spawnByName.get(name) ?? 0;
    const dispatched = spawned + messaged;
    // 交付判据：Lead 日志里该队员**发给 Lead** 的消息（report_result / ask_lead / send_message）。
    // 团队消息账集中在 Lead 会话，按 senderName 记（见 foldEvents 的 msgFrom）。
    const to = (leadStats.msgFrom.get(name) ?? new Map()).get(normId(leadId));
    const reported = to?.queued ?? 0;
    edges.push({
      from: leadName,
      to: name,
      fromId: leadId,
      toId: id,
      kind: 'dispatch',
      weight: dispatched,
      spawned,
      messaged,
      delivered: reported > 0,
      reported,
    });
  }

  // 承接边：成员两两之间「A 写 ∩ B 读」。
  //
  // ⚠️ 方向必须按**主导信息流**定，不能按遍历顺序定。
  // 用户 2026-10-08 报的 #7：「这个流光的方向问题，应该从右往左的，但是真实流光是从左往右的！」
  // 旧实现把 pair 内**先遇到的那条**当作 from（外层 a、内层 b 的循环顺序），
  // 于是「谁在名单里靠前」决定了流光方向 —— 与真实信息流无关，双向边里约一半会反着播。
  // 现在显式记两个方向的权重（a→b 与 b→a），最后让 **权重大的方向当 from→to**；
  // 权重相同时按名字排序（稳定、可复现，不随名单顺序漂移）。
  const memberStats = [...memberIds].map((id) => ({ id, name: nameById.get(id), s: statsBySession.get(id) ?? emptyStats() }));
  const pairSeen = new Map();
  for (const a of memberStats) {
    for (const b of memberStats) {
      if (a.id === b.id) continue;
      const shared = [];
      for (const f of a.s.wrote) if (b.s.read.has(f)) shared.push(f);
      if (shared.length === 0) continue;
      const key = [a.name, b.name].sort().join('\u0000');
      const existing = pairSeen.get(key);
      if (existing === undefined) {
        const edge = {
          from: a.name, to: b.name, fromId: a.id, toId: b.id,
          kind: 'handoff', weight: shared.length, both: false, files: shared.slice(0, 3),
          // 两个方向的真实权重（决定 from→to 与「双向」标记）。
          fwd: shared.length, bwd: 0,
        };
        pairSeen.set(key, edge);
        edges.push(edge);
      } else {
        // 反向也成立：累加该方向的权重，并保留两个方向的原始计数。
        if (a.name === existing.from && b.name === existing.to) existing.fwd += shared.length;
        else existing.bwd += shared.length;
        existing.both = true;
        existing.weight = existing.fwd + existing.bwd;
        // 样例文件名保持有界（tooltip 只展示前几个；全量会把响应撑大）。
        for (const f of shared) {
          if (existing.files.length >= 3) break;
          if (!existing.files.includes(f)) existing.files.push(f);
        }
      }
    }
  }
  // 定方向：主导方向（权重大的那侧）当 from→to。相同时按名字排序，保证稳定。
  for (const edge of pairSeen.values()) {
    if (edge.bwd > edge.fwd) {
      const from = edge.from; const fromId = edge.fromId;
      edge.from = edge.to; edge.fromId = edge.toId;
      edge.to = from; edge.toId = fromId;
      const t = edge.fwd; edge.fwd = edge.bwd; edge.bwd = t;
    } else if (edge.bwd === edge.fwd && edge.from > edge.to) {
      const from = edge.from; const fromId = edge.fromId;
      edge.from = edge.to; edge.fromId = edge.toId;
      edge.to = from; edge.toId = fromId;
    }
  }

  // 汇总（底栏）：全队累计 token、整体缓存命中、平均 TPS（按有产出的成员）。
  let sumInput = 0;
  let sumCacheRead = 0;
  let sumOutput = 0;
  let sumTokens = 0;
  let sumRuntime = 0;
  let tpsCount = 0;
  let tpsSum = 0;
  for (const node of nodes) {
    sumInput += node.usage.uncachedInputTokens + node.usage.cacheWriteTokens;
    sumCacheRead += node.usage.cacheReadTokens;
    sumOutput += node.usage.outputTokens;
    sumTokens += node.totalTokens;
    if (node.role === 'teammate') {
      sumRuntime += node.runtimeMs;
      if (node.tps > 0) { tpsSum += node.tps; tpsCount += 1; }
    }
  }
  const totalPrompt = sumInput + sumCacheRead;
  const totals = {
    totalTokens: sumTokens,
    cacheHit: totalPrompt > 0 ? sumCacheRead / totalPrompt : 0,
    avgTps: tpsCount > 0 ? tpsSum / tpsCount : 0,
    runtimeMs: sumRuntime,
    members: memberIds.size,
    outputTokens: sumOutput,
  };

  return { nodes, edges, tasks: tasks ?? [], totals };
}

// ─────────────────────────────────────────────────────────────────────────────
// 活体采集：从 ctx 走到真实 agent / session，增量折叠并缓存
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 每个会话的折叠缓存（sessionId → stats）。只在本进程活着，团队关掉/agent 销毁后
 * 残留条目由 sweep 清掉（见 collectGraph 里的 alive 集合）。
 * 为什么缓存：一次画布刷新要扫 18 个会话、每份几千事件；全量重放会让 API 请求变成秒级。
 * 增量正确性依据：会话日志 append-only 且 seq 连续（INTERFACES.md §0.1 第 29 条），
 * 所以「从 consumedSeq 续读」永远等价于「全量重放」。
 */
const cacheBySession = new Map();

/** 持久读取失败后的冷却时长：冷却期内复用空结果，避免每轮重读大日志；过后自动重试（自愈）。 */
const FAILED_RETRY_MS = 15000;

/**
 * 读一个 session 从 fromSeq 起的新事件；任何缺失都返回空数组（不猜）。
 *
 * ⚠️ **必须从「本会话自己的第一条」开始**（`inheritedEventCount`），不能从 0：
 * fork 出来的队员会话，日志开头是**父会话历史的整段拷贝**（实测：本团队 3 个 fork 成员
 * 各带 884 条继承事件，其中 97 条 assistant/message 就是 Lead 自己的）。
 * 官方 `eventAt(seq)` 是裸数组下标（dsh-session/lib/index.js:1363-1365），**包含继承前缀**；
 * 官方专门给了 `ownEvents()` / `isOwnSeq()`（同文件 :1389-1391 / :1397-1399）来排掉它。
 * 从 0 折的后果（实测）：Lead 的 token/时长/文件读写被同时记到 3 个 fork 队员头上 ——
 * 底栏总 token 多算 40659870（+28.8%）、承接边 32→14（前缀里的 tool/call 伪造了 18 条）、
 * 队员的 wrote/read/todo 全是 Lead 的。
 * @param {object} session - 活体 Session。
 * @param {number} fromSeq - 起点（调用方传的已经是「自己的」seq 空间）。
 * @returns {Array} 事件数组。
 */
function readNewEvents(session, fromSeq) {
  if (session === null || session === undefined) return [];
  if (typeof session.eventAt !== 'function' || typeof session.seq !== 'number') return [];
  const out = [];
  const end = session.seq;
  for (let seq = fromSeq; seq < end; seq += 1) {
    const event = session.eventAt(seq);
    if (event !== undefined) out.push(event);
  }
  return out;
}

/**
 * 取会话「自己的事件」起点（跳过 fork 继承来的父会话前缀）。
 *
 * 优先用官方的 `inheritedEventCount`（dsh-session/lib/index.js:1389-1399 的 ownEvents/isOwnSeq
 * 就是靠它）；拿不到时**退回到扫描 `subagent/descriptor`**（每个队员会话自己的第一条事件，
 * 实测：18 个成员里 15 个 index 0 就是它、3 个 fork 成员在 index 884）。
 * 两条判据都拿不到 → 返回 0（不猜，保持原行为）。
 * @param {object} session - 活体 Session。
 * @returns {number} 自己的事件起点 seq。
 */
function ownStartSeq(session) {
  if (session === null || session === undefined) return 0;
  const inherited = Number(session.inheritedEventCount);
  if (Number.isFinite(inherited) && inherited > 0) return inherited;
  if (typeof session.eventAt !== 'function' || typeof session.seq !== 'number') return 0;
  // 退回扫描：descriptor 之前的事件都属于父会话。
  const end = Math.min(session.seq, 2000);   // 有界：只扫前 2000 条（实测前缀最长 884）
  for (let seq = 0; seq < end; seq += 1) {
    const event = session.eventAt(seq);
    if (event?.type === 'subagent/descriptor') return seq;
  }
  return 0;
}

/**
 * 从**已经读出来的事件数组**里求「自己的起点」（持久路径用；与 ownStartSeq 同判据）。
 * @param {Array} events - 整份事件（含可能的继承前缀）。
 * @param {number|undefined} inheritedFromHandle - 持久句柄给的 inheritedEventCount。
 * @returns {number} 下标。
 */
function ownStartOfEvents(events, inheritedFromHandle) {
  const inherited = Number(inheritedFromHandle);
  if (Number.isFinite(inherited) && inherited > 0) return inherited;
  const limit = Math.min(events.length, 2000);
  for (let i = 0; i < limit; i += 1) {
    if (events[i]?.type === 'subagent/descriptor') return i;
  }
  return 0;
}

/**
 * 活体优先、持久兜底的折叠（collectGraph 用；persistence 缺省时等同纯活体）。
 *
 * 为什么必须有持久路径：宿主重启后只有 Lead 被 lib/resume.js 装回来，**队员没有活体 agent**。
 * 这时如果只认活体，画布上 18 个队员会全部显示 0 token / 0 时长 —— 那是假的。
 * 判据与官方队员恢复完全同一条路（dsh-experimental-agent-team/lib/index.js:248-260
 * readPersistedSession：persistence.open(id,'read') → handle.read(0) → 切掉 inheritedEventCount
 * 前缀）：会话日志 append-only 且 seq 从 0 连续，所以「整份读一次折一遍」与活体增量折叠等价。
 * 死会话不会再追加事件 → 持久快照折一次就缓存复用；队员被唤醒（活体回归）时丢掉持久快照
 * 重折一遍（一次性成本，发生在唤醒瞬间），避免两种来源的 consumedSeq 混用。
 * @param {string} sessionId - 域服务给的成员 id（裸 uuid；官方 readPersistedSession 同款键）。
 * @param {object|undefined} session - 活体 Session；undefined = 该会话此刻没有活体 agent。
 * @param {object|undefined} persistence - ctx.sessionPersistence（可选 bundle，缺了如实降级）。
 * @param {string[]} notes - 非致命事实的收集处（画布如实显示「读取失败」，不静默）。
 */
async function statsForSession(sessionId, session, persistence, notes) {
  const entry = cacheBySession.get(sessionId);
  if (session !== undefined && session !== null) {
    if (entry !== undefined && entry.persisted === true) cacheBySession.delete(sessionId);
    let live = cacheBySession.get(sessionId);
    if (live === undefined) {
      // 起点 = **本会话自己的第一条**（跳过 fork 继承来的父会话前缀），
      // 否则 Lead 的产出会被记到 fork 队员头上（实测多算 28.8% 的 token）。
      live = { stats: emptyStats(), persisted: false, ownStart: ownStartSeq(session) };
      live.stats.consumedSeq = live.ownStart;
      cacheBySession.set(sessionId, live);
    }
    const events = readNewEvents(session, live.stats.consumedSeq);
    if (events.length > 0) {
      foldEvents(live.stats, events);
      live.stats.consumedSeq += events.length;
    }
    return live.stats;
  }
  // 失败重试的冷却：既不能永久冻结在 0（自愈），也不能每 1.2 秒重读一份大日志（成本有界）。
  if (entry !== undefined) {
    if (entry.failedAt === undefined) return entry.stats;
    if (Date.now() - entry.failedAt < FAILED_RETRY_MS) return entry.stats;
  }
  if (persistence === undefined || persistence === null || typeof persistence.open !== 'function') {
    // ⚠️ **不缓存**这个空结果：sessionPersistence 可能是稍后才就绪的服务（或用户中途启用），
    // 缓存了就会永久停在 0（下一轮 entry !== undefined 直接早返回，再也不会重试）。
    // 每轮重新判断的成本只是一次 typeof，而「能自愈」比省这一次判断重要得多。
    notes.push(`会话 ${sessionId} 没有活体 agent，且 sessionPersistence 不可用：它的统计显示为 0（不是真的没跑过）`);
    return emptyStats();
  }
  try {
    const handle = await persistence.open(sessionId, 'read', {});
    try {
      const { events } = await handle.read(0, void 0, {});
      const all = Array.isArray(events) ? events : [];
      // 切掉 fork 继承前缀：优先官方 inheritedEventCount，拿不到就扫 subagent/descriptor
      // （与活体路径 ownStartSeq 同一判据，保证两条路径口径一致）。
      const stats = emptyStats();
      const own = all.slice(ownStartOfEvents(all, handle.inheritedEventCount));
      foldEvents(stats, own);
      stats.consumedSeq = all.length;
      cacheBySession.set(sessionId, { stats, persisted: true });
      return stats;
    } finally {
      if (typeof handle.close === 'function') await handle.close();
    }
  } catch (error) {
    // 记录失败时刻并**在冷却期内复用这份空结果**：持久日志可能正被写入/临时锁定，
    // 永久缓存成 0 会让这个队员在整个会话里一直显示 0 token（假数据且永不恢复）；
    // 但每轮都重读一份大日志又是性能事故 —— 所以「失败 → 记时刻 → 冷却 15 秒后重试」。
    notes.push(`会话 ${sessionId} 的持久日志读取失败：${String(error?.message ?? error)}（统计显示为 0，稍后自动重试）`);
    const failed = { stats: emptyStats(), persisted: true, failedAt: Date.now() };
    cacheBySession.set(sessionId, failed);
    return failed.stats;
  }
}

/**
 * 取 sessionPersistence 服务（可选的官方 bundle）。
 *
 * ⚠️ 必须**先试 ctx.get()**：cordis 里属性访问一个不在本 fiber inject 列表里的服务会抛
 * `cannot get property "x" without inject`，而 `ctx.get(name)` 是官方给的显式逃生口
 * （缺服务返回 undefined 而不是抛错）。写成 `ctx.sessionPersistence ?? ctx.get(...)` 时，
 * 属性访问先抛，整个 `??` 被 try 吞掉 → persistence 恒为 undefined → 持久兜底**从未生效**，
 * 宿主重启后所有队员的统计都会显示成 0（假数据）。实测就是这么坏的。
 * 两步都要试：get 拿不到时仍退回属性访问（不同宿主平面两种都可能有效）。
 * @param {object} ctx - 宿主 ctx。
 * @returns {object|undefined} 服务实例。
 */
function persistenceOf(ctx) {
  if (ctx === undefined || ctx === null) return undefined;
  try {
    if (typeof ctx.get === 'function') {
      const got = ctx.get('sessionPersistence');
      if (got !== undefined && got !== null) return got;
    }
  } catch {
    /* 落到属性访问 */
  }
  try {
    return ctx.sessionPersistence ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 从官方持久投影缓存恢复「已结束团队」的成员与任务。
 *
 * 为什么优先用它：一次调用同时拿到成员 + 任务，零活体依赖，且与官方面板读的是同一份权威投影。
 * 判据（缺一不可，均来自实测）：
 *   * 缓存服务存在（`sessionProjectionCache` 是可选 bundle，拿不到就返回 undefined 走日志兜底）；
 *   * `agentTeam.members.length > 1` —— **不能**用「有 agentTeam 行」当判据：
 *     实测 213 份缓存记录里含 agentTeam 行的有 172 份，而 members 非空的只有 9 份（其余是 lead 自己）。
 * @param ctx - 宿主 ctx。
 * @param {object|undefined} persistence - sessionPersistence（读存储头用）。
 * @param {string} leadId - Lead 会话 id。
 * @returns {Promise<{members:Array, tasks:Array}|undefined>}
 */
async function readProjectedTeam(ctx, persistence, leadId) {
  if (persistence === undefined || persistence === null || typeof persistence.open !== 'function') return undefined;
  let cache;
  try {
    cache = typeof ctx.get === 'function' ? ctx.get('sessionProjectionCache') : ctx.sessionProjectionCache;
  } catch {
    cache = undefined;
  }
  if (cache === undefined || cache === null || typeof cache.cachedSnapshot !== 'function') return undefined;
  let handle;
  try {
    // id 前缀双试：队员目录是裸 uuid、Lead 目录带 session- 前缀（实测）。
    for (const id of [leadId, normId(leadId), `session-${normId(leadId)}`]) {
      if (typeof id !== 'string' || id === '') continue;
      try { handle = await persistence.open(id, 'read', {}); break; } catch { /* 试下一种 */ }
    }
    if (handle === undefined) return undefined;
    // cachedSnapshot 的 meta 参数是**存储头**（不是 session 对象）。
    const team = cache.cachedSnapshot(handle.header, ['agentTeam'])?.values?.agentTeam;
    const members = Array.isArray(team?.members) ? team.members : [];
    if (members.length <= 1) return undefined;
    return {
      members: members
        .filter((row) => row !== null && row !== undefined && typeof row.id === 'string' && row.id !== '')
        .filter((row) => row.role !== 'lead')
        .map((row) => ({
          id: row.id,
          name: typeof row.name === 'string' && row.name !== '' ? row.name : String(row.id),
          role: row.role ?? 'teammate',
          status: row.status ?? 'inactive',
          model: row.model,
        })),
      tasks: Array.isArray(team?.tasks) ? team.tasks : [],
    };
  } catch {
    return undefined;
  } finally {
    if (handle !== undefined && typeof handle.close === 'function') {
      try { await handle.close(); } catch { /* 关闭失败不影响结果 */ }
    }
  }
}

/**
 * 采集一个团队的画布图。
 * @param {object} deps
 * @param {object} deps.ctx - 宿主 ctx（取 agents / sessionPersistence）。
 * @param {object} deps.agentTeams - 官方域服务。
 * @param {object} deps.leadAgent - Lead agent。
 * @param {(agent:object)=>boolean} deps.isTeamEnabled - runtime.isEnabled（用于排除非本插件的团队）。
 * @returns {Promise<{ok:true, graph:object, leadSessionId:string, notes:string[]} | {ok:false, error:string}>}
 */
export async function collectGraph({ ctx, agentTeams, leadAgent, isTeamEnabled }) {
  if (leadAgent === undefined || leadAgent === null) {
    return { ok: false, error: '缺少 Lead agent，无法采集团队图' };
  }
  // 域服务可以缺席**仅当**这是「团队已结束」的历史快照（leadAgent.historyOnly）：
  // 那时成员与任务都从持久投影缓存 / Lead 日志恢复，不需要域服务。
  if (agentTeams === undefined && leadAgent.historyOnly !== true) {
    return { ok: false, error: '缺少域服务或 Lead agent，无法采集团队图' };
  }
  const leadId = typeof leadAgent.session?.id === 'string' ? leadAgent.session.id : leadAgent.id;
  if (typeof leadId !== 'string') return { ok: false, error: 'Lead 没有可用的会话 id' };

  let rows;
  const notes = [];
  try {
    rows = agentTeams?.listMembers?.(leadAgent) ?? [];
  } catch (error) {
    rows = [];
    notes.push(`成员名单读取失败：${String(error?.message ?? error)}`);
  }

  // ── 团队已结束时的兜底 ─────────────────────────────────────────────────────
  //
  // 为什么需要它（用户 2026-10-08 报的 #5）：「我的额度没有了，对话断了，这很正常，
  // 但是工作区为啥看不了了？」—— 额度耗尽后队员 agent 全部销毁，域服务的成员名单空了
  // （或 listMembers 抛错），于是画布只剩 Lead 一个节点甚至整页报错。
  //
  // 两条恢复来源，**先投影缓存、后日志**：
  //   ① 官方持久投影缓存的 `agentTeam` 视图：一次同时拿到**成员 + 任务**（与官方面板同源）。
  //      判据必须是 `members.length > 1`，不能是「有 agentTeam 行」——
  //      实测 213 份缓存记录里含 agentTeam 行的有 172 份，而 members 非空的只有 9 份。
  //   ② 退回折 Lead 会话日志里的 `team/member` 事件（缓存不可用时）。
  // 画出来的是**历史快照**（notes 里如实说明），不是假装团队还活着。
  const persistence = persistenceOf(ctx);
  const recoveredTeam = rows.length === 0 ? await readProjectedTeam(ctx, persistence, leadId) : undefined;
  if (recoveredTeam !== undefined) {
    rows = recoveredTeam.members;
    notes.push(`域服务里没有在册成员（团队可能已结束）：已从持久投影缓存恢复 ${rows.length} 个历史成员`
      + `${recoveredTeam.tasks.length > 0 ? ` 与 ${recoveredTeam.tasks.length} 条任务` : ''}，显示的是最后一次记录到的状态`);
  } else if (rows.length === 0) {
    const leadStatsForRoster = await statsForSession(
      leadId,
      leadAgent.session,
      persistence,
      notes,
    );
    if (leadStatsForRoster.memberNames.size > 0) {
      rows = [...leadStatsForRoster.memberNames.entries()].map(([id, name]) => ({
        id, name, role: 'teammate', status: 'inactive',
      }));
      notes.push(`域服务里没有在册成员（团队可能已结束）：已从 Lead 会话日志重建 ${rows.length} 个历史成员，显示的是最后一次记录到的状态`);
    } else if (leadAgent.session === undefined) {
      // 既没有域服务名单、也没有历史成员记录：如实说明，别让用户看一张只有 lead 的图却不知为何。
      notes.push('读不到历史成员名单：Lead 会话日志缺失或损坏，画布只显示 Lead');
    }
  }

  let tasks = recoveredTeam?.tasks ?? [];
  if (tasks.length === 0 && agentTeams !== undefined) {
    try {
      tasks = agentTeams.listTasks(leadAgent) ?? [];
    } catch (error) {
      // 任务板坏了不该让整张图画不出来：如实带着错误继续，客户端会显示「任务不可用」。
      tasks = [];
      notes.push(`任务板读取失败：${String(error?.message ?? error)}`);
    }
  }

  const members = [];
  const statsBySession = new Map();
  const alive = new Set([leadId]);

  statsBySession.set(leadId, await statsForSession(leadId, leadAgent.session, persistence, notes));

  for (const row of rows) {
    if (row === undefined || row === null) continue;
    if (row.role === 'lead' || row.id === leadId || normId(row.id) === normId(leadId)) continue;
    // 成员 id 在域服务里是裸 uuid，而 agent 注册表按 agent.id===session.id 查（实测目录/事件里
    // 既有 `session-<uuid>` 也有裸 `<uuid>`），两种键都试，取到的那个才算活体。
    //
    // ⚠️ 必须用 ctx.get 取 agents，不能写 `ctx.agents?.get?.(...)`：
    // cordis 的上下文是 Proxy，属性访问未 inject 的服务会**抛错**
    // （cordis/lib/index.js:673-698：`cannot get property "x" without inject`），
    // 而可选链 `?.` 捕获不了抛错的 getter —— 于是整个 try/catch 静默吞掉，
    // agent 恒为 undefined，18 个成员**永远走持久兜底**（数字仍对，但每轮整读日志）。
    // ctx.get(name) 是官方逃生口：服务缺失返回 undefined 而不是抛错。
    // 两步都要试：get 拿不到时仍退回属性访问（宿主平面不同，两种都可能有效）。
    let registry;
    try {
      if (typeof ctx.get === 'function') registry = ctx.get('agents') ?? undefined;
    } catch {
      registry = undefined;
    }
    if (registry === undefined) {
      try {
        registry = ctx.agents ?? undefined;
      } catch {
        registry = undefined;
      }
    }
    let agent;
    try {
      agent = registry?.get?.(row.id) ?? registry?.get?.(`session-${row.id}`);
    } catch {
      agent = undefined;
    }
    // 域服务认它、但本插件没装过它（例如官方团队自己开的会话）→ 不画：
    // 画出来只会是一个没有任何统计的幽灵节点，还会把别人的团队当成我们的。
    if (agent !== undefined && typeof isTeamEnabled === 'function' && isTeamEnabled(agent) !== true) continue;
    members.push(row);
    const session = agent?.session;
    alive.add(row.id);
    if (typeof session?.id === 'string') alive.add(session.id);
    statsBySession.set(row.id, await statsForSession(row.id, session, persistence, notes));
  }

  // 清掉**已不在名单里**的会话缓存（团队散伙/成员被移除）；
  // 在册但此刻没有活体 agent 的成员**必须保留**它的持久快照 —— 否则 5 秒一轮的刷新
  // 会把同一份日志反复整读一遍，画布自己变成性能事故。
  for (const key of [...cacheBySession.keys()]) if (!alive.has(key)) cacheBySession.delete(key);

  const graph = buildGraph({
    leadId,
    leadName: 'lead',
    members,
    statsBySession,
    tasks,
  });
  return { ok: true, graph, leadSessionId: leadId, notes };
}

// ─────────────────────────────────────────────────────────────────────────────
// 对话流：给浮动窗口用。只取**尾部**若干条，绝不为了刷新而全量重扫。
// ─────────────────────────────────────────────────────────────────────────────

/** 一条对话行的上限（码元）；超出走 clipText（代理对安全，见 lib/text-clip.js）。 */
const LINE_MAX = 2000;

/**
 * 对话抽取的**内容来源白名单**（`user/message` 的 `data.source.kind`）。
 *
 * 为什么需要它（用户 2026-10-08 报的 #1：原话「不要放这些没用的什么记忆文件注入，消息啥的」）：
 * 实测 `builder-copyid` 抽出的 180 行里，`user` 行几乎全是**框架注入**而不是人说的话 ——
 *   `agent-instructions`（工作区 AGENTS.md 注入）、`skill-catalog`（技能目录）、
 *   `time-context`（"Time sampled while preparing turn N, step M…" + "Browser time zone…"）。
 * 这些是给模型看的上下文，不是对话内容，塞进浮窗纯属噪音。
 * 官方在事件里已经标好了 `source.kind`，所以用白名单（而不是靠正则猜文本）：
 *   user / team-message / subagent-settled 才是人看得懂的内容。
 * 判据来源：全库抽样 `user/message` 的 data 键与 source 形状（见 .probe/probe-user-msg.mjs）。
 */
const CONVO_SOURCE_KINDS = new Set(['user', 'team-message', 'subagent-settled', 'team-task']);

/**
 * 从会话事件里抽对话行。
 *
 * 输出只包含**人能读的对话**：真人输入 / 助手正文 / 团队消息 / 子代理完成通知。
 * 工具调用**不逐条列出**（实测占 88%：180 行里 159 行是 `read({...})` 之类），
 * 而是聚合成一条「工具调用 ×N」计数行 —— 保留「它干了多少活」的信息，去掉刷屏。
 * 框架注入（工作区指令 / 技能目录 / 时间上下文）整类过滤。
 * @param {Array} events
 * @param {number} limit - 最多返回多少行（取尾部）。
 * @returns {Array<{kind:string, text:string, time:number}>}
 */
export function extractConversation(events, limit = 120) {
  const rows = [];
  // 去重：同一条团队消息既可能是 `team/message/queued`（Lead 日志里），
  // 也可能是成员日志里的 `user/message`（source.kind='team-message' 且带 messageId）。
  const seenMessageIds = new Set();
  let toolRun = 0;
  let toolTime = 0;
  /** 把累计的工具调用冲成一行计数（在遇到下一条可读内容时调用）。 */
  const flushTools = () => {
    if (toolRun === 0) return;
    rows.push({ kind: 'tools', text: `工具调用 ×${toolRun}`, time: toolTime, count: toolRun });
    toolRun = 0;
  };
  for (const event of events) {
    const data = event?.data;
    if (data === undefined || data === null) continue;
    if (event.type === EV_USER_MESSAGE || event.type === 'developer/message' || event.type === 'system/message') {
      const kindOfSource = data.source?.kind;
      // 白名单：没有 source（旧日志）时按文本兜底判断，避免把注入当对话显示。
      if (typeof kindOfSource === 'string') {
        if (!CONVO_SOURCE_KINDS.has(kindOfSource)) continue;
      } else if (looksLikeInjection(textOfBlocks(data.content))) continue;
      // 同一条团队消息只显示一次（queued 事件已记过 messageId）。
      const messageId = data.source?.messageId;
      if (typeof messageId === 'string' && messageId !== '') {
        if (seenMessageIds.has(messageId)) continue;
        seenMessageIds.add(messageId);
      }
      const text = textOfBlocks(data.content);
      if (text === '') continue;
      // 队员的派活简报（本插件自己生成的使命提示词）不当对话显示，见 isTeammateBriefing。
      if (isTeammateBriefing(data, text)) continue;
      flushTools();
      // 团队消息单独一类（浮窗里显示「谁 → 内容」），其余是真人/系统输入。
      const kind = kindOfSource === 'team-message' ? 'team'
        : kindOfSource === 'subagent-settled' ? 'notice'
          : event.type === EV_USER_MESSAGE ? 'user' : 'system';
      rows.push({ kind, text: clipLine(text), time: event.time ?? 0 });
      continue;
    }
    if (event.type === EV_ASSISTANT) {
      const text = textOfBlocks(data.message?.content);
      if (text !== '') {
        flushTools();
        rows.push({ kind: 'assistant', text: clipLine(text), time: event.time ?? 0 });
      }
      // 工具调用只累计，不逐条成行（见函数头注释）。
      const calls = toolCallsOf(data.message?.content);
      if (calls.length > 0) {
        toolRun += calls.length;
        if (toolTime === 0) toolTime = event.time ?? 0;
      }
      continue;
    }
    if (event.type === EV_TEAM_MESSAGE_QUEUED) {
      const message = data.message;
      if (message === undefined) continue;
      if (typeof message.id === 'string' && message.id !== '') {
        if (seenMessageIds.has(message.id)) continue;
        seenMessageIds.add(message.id);
      }
      const text = textOfBlocks(message.content);
      if (text === '') continue;
      flushTools();
      const sender = typeof message.senderName === 'string' && message.senderName !== '' ? message.senderName : '?';
      rows.push({ kind: 'team', text: clipLine(`${sender} → ${text}`), time: event.time ?? 0 });
    }
  }
  flushTools();
  return rows.length > limit ? rows.slice(-limit) : rows;
}

/**
 * 兜底判据：没有 `source.kind` 的旧日志里，靠开头特征认出框架注入。
 * @param {string} text
 * @returns {boolean} true = 是注入，不该当对话显示。
 */
function looksLikeInjection(text) {
  const t = text.trimStart();
  return t.startsWith('<system-reminder>')
    || t.startsWith('Time sampled while preparing turn')
    || t.startsWith('Browser time zone');
}

/**
 * 派活简报（队员的第一条输入）算不算「对话」？——**不算**。
 *
 * 实测：`spawn_teammate` 派出去的队员，第一条 `user/message` 的 `source.kind` 是 `'user'`，
 * 但内容是**本插件自己生成的队员使命提示词**（「你是智能体团队的队员 "X"，角色 builder…」，
 * 见 lib/roster.js 的 TEAMMATE_CARD）。它是系统给模型的指令，不是人说的话 ——
 * 用户 2026-10-08 说的「不要放这些没用的什么记忆文件注入」正包括它。
 * 判据：source.kind === 'user' 且正文以本插件的简报开头标记起头。
 * @param {object} data - user/message 的 data。
 * @param {string} text - 已抽出的正文。
 * @returns {boolean}
 */
function isTeammateBriefing(data, text) {
  if (data?.source?.kind !== 'user') return false;
  const t = text.trimStart();
  return t.startsWith('<system-reminder>\n你是智能体团队的队员')
    || t.startsWith('你是智能体团队的队员')
    || /^<system-reminder>\s*你是智能体团队的队员/u.test(t);
}

/** 消息块数组里的全部 text 块拼一行（非文本块只标形状，不猜内容）。 */
function textOfBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[图片]');
  }
  return parts.join('\n').trim();
}

/** 助手内容里的工具调用（名字 + 有界参数摘要）。 */
function toolCallsOf(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (block?.type !== 'tool-call' && block?.type !== 'tool_use') continue;
    const name = typeof block.name === 'string' ? block.name : '?';
    const args = typeof block.arguments === 'string' ? block.arguments : '';
    out.push(args === '' ? `${name}()` : `${name}(${args.slice(0, 160)})`);
  }
  return out;
}

function clipLine(text) {
  return clipText(text, LINE_MAX);
}

/** 尾部扫描窗口：最多读这么多事件来凑 limit 行（对话行密度远低于事件密度，够用且有界）。 */
const TAIL_WINDOW = 6000;

/**
 * 读一个会话的对话尾部（浮动窗口用）。**不**走折叠缓存：缓存里没有正文，
 * 而且画布刷新不该被正文读取拖慢，所以这是独立的按需 op。
 * 活体优先、持久兜底（宿主重启后队员没有活体 agent，但日志还在 —— 与 statsForSession 同理）。
 * @param {string} sessionId - 域服务给的成员 id（裸 uuid）。
 * @param {object|undefined} session - 活体 Session；undefined = 此刻没有活体 agent。
 * @param {object|undefined} persistence - ctx.sessionPersistence（缺了如实降级）。
 * @param {number} limit - 行数上限。
 * @returns {Promise<{rows:Array, note?:string}>}
 */
export async function readConversationTail(sessionId, session, persistence, limit = 120) {
  const capped = Math.max(1, Math.min(400, Number(limit) || 120));
  if (session !== undefined && session !== null
    && typeof session.eventAt === 'function' && typeof session.seq === 'number') {
    const end = session.seq;
    // ⚠️ 下界必须 ≥ 本会话自己的起点：fork 队员的日志开头是**父会话历史的整段拷贝**
    // （实测 visual-critic-wxd 的 884 条前缀里含 47 条 Lead 的 user/message 与 68 条 team/message，
    // 而它自己的只有 2 条 / 0 条）。不切前缀 → 浮窗里显示的是 **Lead 的对话**。
    // 持久路径本来就用 handle.inheritedEventCount 切了，两条路径必须同口径。
    const ownStart = ownStartSeq(session);
    const from = Math.max(ownStart, end - TAIL_WINDOW);
    const events = [];
    for (let seq = from; seq < end; seq += 1) {
      const event = session.eventAt(seq);
      if (event !== undefined) events.push(event);
    }
    return { rows: extractConversation(events, capped) };
  }
  if (persistence === undefined || persistence === null || typeof persistence.open !== 'function') {
    return { rows: [], note: `会话 ${sessionId} 没有活体 agent，且 sessionPersistence 不可用：对话读不到` };
  }
  try {
    const handle = await persistence.open(sessionId, 'read', {});
    try {
      const { events } = await handle.read(0, void 0, {});
      const all = Array.isArray(events) ? events : [];
      const own = all.slice(ownStartOfEvents(all, handle.inheritedEventCount));
      const tail = own.length > TAIL_WINDOW ? own.slice(-TAIL_WINDOW) : own;
      return { rows: extractConversation(tail, capped) };
    } finally {
      if (typeof handle.close === 'function') await handle.close();
    }
  } catch (error) {
    return { rows: [], note: `会话 ${sessionId} 的持久日志读取失败：${String(error?.message ?? error)}` };
  }
}
