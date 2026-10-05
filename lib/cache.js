// 缓存保活（cache keepalive）+ 缓存统计 —— 只读观察与"1 token 续命"。
//
// ── 这个文件解决什么问题 ───────────────────────────────────────────────────────
// 提示词缓存按**前缀**命中。Lead 派完活等队员时，它那一段对话前缀可能几分钟到几十分钟
// 没有被再次读取，缓存条目过期后，下一次真实请求要把整段前缀按**全价**重读一遍。
// 保活的做法：在等待期间，用**完全相同的前缀**再发一次请求（输出只要 1 个 token），
// 让缓存条目"被使用一次"，从而续命。
//
// 机制来源：开源项目 dsh-model-fusion 的 `src/host/native-keepalive.ts`（Apache-2.0）。
// 我们保留了它的核心（从 `llm/stream` 瀑布里抓**真实请求**，原样重放 + 只改 maxTokens），
// 并按下面这些判断改掉了它的弱点（逐条对照见 MAINTAINER-NOTES.md §10.1）：
//   1. 它的间隔 285s 贴着"5 分钟 TTL"（安全边际 15s）；我们改成 `0.7 × TTL`（默认 210s）。
//   2. 它没有抖动，多条线路会在同一秒齐发；我们加 ±7% 抖动。
//   3. 它"保活连续没命中就缩短间隔"——那只会烧更多钱；我们**连续 2 次没命中就停**并记录原因。
//   4. 它保留 reasoningEffort（1 token 上限在推理模型上可能只产出思维链或直接报错）；
//      我们的 ping 不带 reasoningEffort / temperature / stop。
//   5. 它只有"每个系列 11 次"这一个上限；我们同时有：每轮等待次数、每会话次数、
//      每会话读取 token 上限。
//   6. 它的 DeepSeek 默认是 off（磁盘缓存按小时~天计）—— 我们保持这个默认，并把它写进
//      线路表 + 面板可覆盖，避免在"缓存本来就不会过期"的线路上白花钱。
//
// ── 安全底线（改这个文件前先读） ───────────────────────────────────────────────
//   * `llm/stream` 监听器在**每一次模型请求**的路径上。它必须：不修改 options、
//     不吞异常、不用 await 阻塞、内部任何错误都只记诊断并把下游流原样交出去。
//   * ping 只在"Lead 没有在途请求"时发；ping 期间来了真实请求 → 立刻放弃（不排队、不并发）。
//   * ping 的响应**只排空**：文本/工具调用永不进会话、永不执行。
//   * 没有 API key / 没有 llm 服务 / 线路不支持 → 一律静默降级成 "off"，绝不抛错。
//
// ── 为什么在插件自己的 ctx 上注册就能收到 llm/stream（0.2.0-rc.2 核对） ─────────
// dsh-llm 派发时写的是 `this.ctx.waterfall(this, "llm/stream", options, next)`
// （`dsh-llm/lib/index.js:2371`），第一个参数（thisArg）是 **Llm 服务实例**，不带 `Context.filter`；
// 而 cordis 的 dispatch 是 `hook.global || !filter || filter.call(thisArg, hook.ctx)`
// （`@deepseek-ai/cordis/lib/index.js:258-264`）——**没有过滤器就等于全局广播**，
// 与监听器注册在 ctx 树的哪一层无关。所以插件在 `apply(ctx)` 拿到的子作用域里注册即可收到。
// 集成测试里专门用「子作用域注册 + 父作用域派发」钉住了这条前提（官方哪天给 llm/stream
// 加上作用域过滤，那条断言会立刻红）。DSH 的 `dsh-scope` 只对**带 agent 的**派发做过滤
// （例如 `agent/request`），llm/stream 不在其中。

import { randomUUID } from 'node:crypto';

/** 保活三种模式：auto = 等线路自己证明有缓存命中后再开；on = 一有等待就开；off = 从不。 */
export const KEEPALIVE_MODES = Object.freeze(['auto', 'on', 'off']);

/** ping 的输出上限。1 个 token 够用来"使用"一次前缀，又不可能产生副作用文本。 */
export const PING_MAX_TOKENS = 1;

/** 间隔下限/上限（秒）。下限防止把等待变成请求轰炸；上限让长等待仍有覆盖。 */
export const MIN_INTERVAL_SECONDS = 60;
export const MAX_INTERVAL_SECONDS = 3540;

/** 间隔 = TTL × 这个系数。0.7 比上游的 0.95 保守得多：宁可多续一次，也不赌边界。 */
export const INTERVAL_FRACTION = 0.7;

/** 间隔抖动比例（±7%）：避免同一进程里多条线路/多个会话在同一秒齐发。 */
export const INTERVAL_JITTER = 0.07;

/** 线路 TTL 未知时的兜底 TTL（秒）。取各家文档里最短的那个（5 分钟）。 */
export const DEFAULT_TTL_SECONDS = 300;

/** 一轮等待（= 从最后一次真实请求到下一次真实请求）最多 ping 多少次。24 × 210s ≈ 84 分钟。 */
export const PINGS_PER_WAIT_CAP = 24;

/** 一个会话最多 ping 多少次 / 最多读多少 token（保险丝，防止长时间挂机烧钱）。 */
export const PINGS_PER_SESSION_CAP = 300;
export const PING_TOKEN_CAP = 5_000_000;

/** 连续多少次 ping 报"零缓存命中"就停掉这条线路（并把原因写进诊断）。 */
export const MISS_STOP_THRESHOLD = 2;

/** 单次 ping 的超时（毫秒）：超时就中止，绝不挂住。 */
export const PING_TIMEOUT_MS = 120_000;

/** 一次真实请求结束后，至少隔多久才允许 ping（毫秒）。防止刚答完就 ping。 */
export const MIN_QUIET_MS = 30_000;

/**
 * 线路族表：决定默认模式与 TTL。
 *
 * `mode: 'off'` 的两类：
 *   * `deepseek` —— 官方文档写明是**磁盘缓存**、最后一次使用后按小时~天清除，等待期（几分钟）
 *     根本不会过期；且本机的 `deepseek-account` 是订阅/账号线路，ping 会占请求额度。
 *   * 其它未列出线路 —— 走 `DEFAULT_*` 兜底（auto + 300s），不猜。
 */
export const ROUTE_FAMILIES = Object.freeze([
  Object.freeze({
    id: 'deepseek',
    match: /deepseek/i,
    mode: 'off',
    ttlSeconds: null,
    why: 'DeepSeek 是磁盘缓存、最后一次使用后按小时~天清除（等待几分钟不会过期）；账号/订阅线路还按请求计费',
  }),
  Object.freeze({ id: 'claude', match: /claude/i, mode: 'auto', ttlSeconds: 300, why: 'Anthropic 显式缓存 TTL 5 分钟' }),
  Object.freeze({ id: 'gpt', match: /\b(gpt|o[1-9]|chatgpt|codex)\b/i, mode: 'auto', ttlSeconds: 300, why: 'OpenAI 自动前缀缓存，文档值 5~10 分钟' }),
  Object.freeze({ id: 'gemini', match: /gemini/i, mode: 'auto', ttlSeconds: 300, why: 'Google 隐式缓存，未公布精确 TTL，按最短值保守处理' }),
  Object.freeze({ id: 'grok', match: /grok/i, mode: 'auto', ttlSeconds: 300, why: 'xAI 隐式缓存，未公布精确 TTL' }),
  Object.freeze({ id: 'glm', match: /glm|zhipu|chatglm/i, mode: 'auto', ttlSeconds: 300, why: '智谱隐式缓存，未公布精确 TTL' }),
  Object.freeze({ id: 'kimi', match: /kimi|moonshot/i, mode: 'auto', ttlSeconds: 300, why: 'Moonshot 隐式缓存，未公布精确 TTL' }),
  Object.freeze({ id: 'qwen', match: /qwen|tongyi|dashscope/i, mode: 'auto', ttlSeconds: 300, why: '通义隐式缓存，未公布精确 TTL' }),
]);

/** 兜底族（未命中的线路）。 */
export const DEFAULT_FAMILY = Object.freeze({
  id: 'generic',
  match: null,
  mode: 'auto',
  ttlSeconds: DEFAULT_TTL_SECONDS,
  why: '未列出线路：按最短的文档 TTL（5 分钟）保守处理，等线路自己证明有缓存命中后再开',
});

/** 把任意输入夹到合法间隔（秒）。非有限数 → undefined。 */
export function clampIntervalSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < MIN_INTERVAL_SECONDS) return MIN_INTERVAL_SECONDS;
  if (rounded > MAX_INTERVAL_SECONDS) return MAX_INTERVAL_SECONDS;
  return rounded;
}

/** provider/model → 线路族。空值走兜底族。 */
export function routeFamilyOf(provider, model) {
  const text = `${typeof provider === 'string' ? provider : ''}/${typeof model === 'string' ? model : ''}`;
  for (const family of ROUTE_FAMILIES) if (family.match.test(text)) return family;
  return DEFAULT_FAMILY;
}

/**
 * 解析某条线路的保活策略：用户覆盖 > 线路族默认。
 *
 * @param args - {provider, model, overrides}；overrides 形如
 *   `{ 'provider/model': {mode, intervalSeconds}, 'deepseek': {mode} }`（键可以是整条线路，
 *   也可以是 provider 或族 id —— 按"越具体越优先"匹配）。
 * @returns {{mode, intervalSeconds, ttlSeconds, family, why, source}}
 */
export function resolveKeepalivePolicy({ provider, model, overrides } = {}) {
  const family = routeFamilyOf(provider, model);
  const base = {
    mode: family.mode,
    intervalSeconds: undefined,
    ttlSeconds: family.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    family: family.id,
    why: family.why,
    source: `route-family:${family.id}`,
  };
  const table = overrides !== undefined && overrides !== null && typeof overrides === 'object' ? overrides : {};
  const providerId = typeof provider === 'string' ? provider : '';
  const modelId = typeof model === 'string' ? model : '';
  const keys = [`${providerId}/${modelId}`, modelId, providerId, family.id];
  for (const key of keys) {
    if (key === '' || key === '/') continue;
    const entry = table[key];
    if (entry === undefined || entry === null || typeof entry !== 'object') continue;
    if (typeof entry.mode === 'string' && KEEPALIVE_MODES.includes(entry.mode)) {
      base.mode = entry.mode;
      base.source = `override:${key}`;
    }
    const interval = clampIntervalSeconds(entry.intervalSeconds);
    if (interval !== undefined) base.intervalSeconds = interval;
    break;
  }
  if (base.intervalSeconds === undefined) {
    base.intervalSeconds = clampIntervalSeconds(base.ttlSeconds * INTERVAL_FRACTION);
  }
  return base;
}

/**
 * 计算本次间隔（毫秒，含抖动）。`random` 可注入（测试用）。
 * @returns 合法范围内的整数毫秒。
 */
export function jitteredIntervalMs(policy, random = Math.random) {
  const baseSeconds = clampIntervalSeconds(policy?.intervalSeconds) ?? MIN_INTERVAL_SECONDS;
  const baseMs = baseSeconds * 1000;
  const roll = typeof random === 'function' ? random() : 0.5;
  const bounded = Number.isFinite(roll) ? Math.min(1, Math.max(0, roll)) : 0.5;
  const factor = 1 + (bounded * 2 - 1) * INTERVAL_JITTER;
  const ms = Math.round(baseMs * factor);
  return Math.max(MIN_INTERVAL_SECONDS * 1000, Math.min(MAX_INTERVAL_SECONDS * 1000, ms));
}

/**
 * ping 的纯决策函数：**只有**它说 ok 才允许发请求。
 *
 * 这个函数故意做成纯的（没有 ctx、没有定时器）：所有"什么时候不该 ping"的判断
 * 都能在 selftest 里逐条钉死，真机上就只剩"照做"。
 *
 * @param state - {
 *   active,            // 本会话团队是否已开启（Lead 已知）
 *   mode,              // auto | on | off
 *   armed,             // auto 模式下是否已经观察到过缓存命中
 *   inflight,          // 在途的真实 Lead 请求数（必须为 0）
 *   lastRequestAt,     // 最后一次真实 Lead 请求的时间戳（ms）
 *   now,               // 当前时间戳（ms）
 *   intervalMs,        // 本次间隔（含抖动）
 *   waiters,           // 正在 running/provisioning 的队员数（= 真的有等待）
 *   attemptsInWait,    // 本轮等待已 ping 次数
 *   attemptsInSession, // 本会话已 ping 次数
 *   pingTokens,        // 本会话 ping 已读取 token
 *   misses,            // 连续未命中次数
 *   stopped,           // 已停原因（字符串）或 undefined
 * }
 * @returns {{ok: boolean, reason: string}}
 */
export function decidePing(state) {
  const s = state ?? {};
  if (s.stopped !== undefined && s.stopped !== null) return { ok: false, reason: `stopped:${s.stopped}` };
  if (s.active !== true) return { ok: false, reason: 'team-not-active' };
  if (s.mode !== 'on' && s.mode !== 'auto') return { ok: false, reason: 'mode-off' };
  if (s.mode === 'auto' && s.armed !== true) return { ok: false, reason: 'no-cache-evidence-yet' };
  if (!(s.inflight === 0 || s.inflight === undefined)) return { ok: false, reason: 'request-inflight' };
  if (!(s.waiters > 0)) return { ok: false, reason: 'no-waiting-teammate' };
  if (!(s.attemptsInWait < PINGS_PER_WAIT_CAP)) return { ok: false, reason: 'wait-attempt-limit' };
  if (!(s.attemptsInSession < PINGS_PER_SESSION_CAP)) return { ok: false, reason: 'session-attempt-limit' };
  if (!(s.pingTokens < PING_TOKEN_CAP)) return { ok: false, reason: 'session-token-limit' };
  if (!(s.misses < MISS_STOP_THRESHOLD)) return { ok: false, reason: 'repeated-misses' };
  const last = typeof s.lastRequestAt === 'number' ? s.lastRequestAt : 0;
  const now = typeof s.now === 'number' ? s.now : 0;
  const intervalMs = typeof s.intervalMs === 'number' && s.intervalMs > 0 ? s.intervalMs : MIN_INTERVAL_SECONDS * 1000;
  if (now - last < Math.max(intervalMs, MIN_QUIET_MS)) return { ok: false, reason: 'too-soon' };
  return { ok: true, reason: 'ok' };
}

/** 空统计。per-route 与 per-agent 都用这个形状。 */
export function emptyStats() {
  return {
    requests: 0,
    cacheReadTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    pings: 0,
    pingHits: 0,
    pingMisses: 0,
    pingTokensRead: 0,
  };
}

/** 把一次 provider 上报的 usage 折进统计。usage 形状见 dsh-token-meter/lib/types/usage-projection.js。 */
export function foldUsage(stats, usage, kind) {
  if (stats === undefined || stats === null || usage === undefined || usage === null) return stats;
  const input = Number(usage.inputTokens);
  const cacheRead = Number(usage.cacheReadTokens);
  const output = Number(usage.outputTokens);
  const uncached = Number.isFinite(input) ? input : 0;
  const read = Number.isFinite(cacheRead) ? cacheRead : 0;
  const out = Number.isFinite(output) ? output : 0;
  if (kind === 'ping') {
    stats.pings += 1;
    stats.pingTokensRead += read + uncached;
    if (read > 0) stats.pingHits += 1;
    else stats.pingMisses += 1;
    return stats;
  }
  stats.requests += 1;
  stats.cacheReadTokens += read;
  stats.uncachedInputTokens += uncached;
  stats.outputTokens += out;
  return stats;
}

/** 缓存命中率（按 token 加权）。没有任何输入 token 时返回 undefined（不是 0）。 */
export function hitRatio(stats) {
  if (stats === undefined || stats === null) return undefined;
  const total = stats.cacheReadTokens + stats.uncachedInputTokens;
  if (total <= 0) return undefined;
  return stats.cacheReadTokens / total;
}

/** 从消息列表里取"系统提示词文本"（system 字段或 role=system 的消息），用于识别 Lead。 */
export function systemTextOf(options) {
  const direct = options?.system;
  if (typeof direct === 'string' && direct !== '') return direct;
  const messages = Array.isArray(options?.messages) ? options.messages : [];
  const parts = [];
  for (const message of messages) {
    if (message?.role !== 'system') continue;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/**
 * 从一份 options 里挑出"构成缓存前缀"的字段，做一份防御性拷贝。
 * 只拷贝 provider/model/messages/tools/system —— 其它调用参数（temperature / reasoningEffort /
 * stop / maxTokens）不进 ping：它们不影响前缀命中，而 reasoningEffort 在推理模型上会让
 * 1-token 的 ping 只产出思维链或直接报错。
 *
 * @returns {{ok: true, request} | {ok: false, error}}
 */
export function captureRequest(options) {
  if (options === undefined || options === null || typeof options !== 'object') return { ok: false, error: 'options 不是对象' };
  const provider = options.provider;
  const model = options.model;
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
    return { ok: false, error: 'options 缺少 provider/model' };
  }
  if (!Array.isArray(options.messages) || options.messages.length === 0) return { ok: false, error: 'options 没有 messages' };
  let messages;
  let tools;
  let system;
  try {
    messages = structuredClone(options.messages);
    tools = options.tools === undefined ? undefined : structuredClone(options.tools);
    system = typeof options.system === 'string' ? options.system : undefined;
  } catch (error) {
    return { ok: false, error: `前缀拷贝失败（不重放不可克隆的请求）：${error?.message ?? error}` };
  }
  const request = { provider, model, messages };
  if (tools !== undefined) request.tools = tools;
  if (system !== undefined) request.system = system;
  return { ok: true, request };
}

/** 给 ping 追加的尾部 user 消息。形状对齐官方 createUserMessage（dsh-llm/lib/types/message.js:45）。 */
export function pingTailMessage(text = 'continue') {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:dsh-dispatch-agent-team' },
    id: randomUUID(),
  };
}

/** 定时器上限：一次最多睡这么久再复查（避免用超长 timeout 表达"很久以后"）。 */
const MAX_TIMER_MS = 60_000;
/** 在途计数超过这个时长还没归零 → 认为计数卡住（包装器没被消费），按 0 处理并记一条。 */
const INFLIGHT_STALE_MS = 30 * 60_000;

/**
 * 保活控制器：把上面那套纯策略接到真实运行时上。
 *
 * 依赖全部可注入（`ctx` / `llmOf` / `waitersOf` / `now` / `setTimeoutFn` / `random`），
 * 所以集成测试里可以用替身把"抓取 → 决策 → ping → 统计"整条链路跑通，而不碰真模型。
 *
 * 用法（lib/index.js）：
 *   `const keepalive = createKeepalive({...}); ctx.effect(() => { const off = ctx.on('llm/stream', keepalive.handleStream); return () => off(); });`
 * 团队开启时 `keepalive.attach({agentId, sessionId, provider, model})`；关闭时 `detach('team-disabled')`。
 *
 * @param deps - {
 *   log, note,            // 诊断 / 信息回调（runtime.recordDiagnostic / recordNote）
 *   llmOf,                // () => llm 服务（可空）
 *   waitersOf,            // () => 正在 running/provisioning 的队员数
 *   leadMarker,           // Lead 系统提示词里的独有标记
 *   teammateMarker,       // 队员系统提示词里的独有标记（命中即忽略）
 *   overridesOf,          // () => 用户覆盖表（来自插件配置）
 *   now, setTimeoutFn, clearTimeoutFn, random,
 * }
 */
export function createKeepalive(deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : () => void 0;
  const note = typeof deps.note === 'function' ? deps.note : () => void 0;
  const llmOf = typeof deps.llmOf === 'function' ? deps.llmOf : () => undefined;
  const waitersOf = typeof deps.waitersOf === 'function' ? deps.waitersOf : () => 0;
  const overridesOf = typeof deps.overridesOf === 'function' ? deps.overridesOf : () => ({});
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const scheduleFn = typeof deps.setTimeoutFn === 'function' ? deps.setTimeoutFn : setTimeout;
  const cancelFn = typeof deps.clearTimeoutFn === 'function' ? deps.clearTimeoutFn : clearTimeout;
  const random = typeof deps.random === 'function' ? deps.random : Math.random;
  const leadMarker = typeof deps.leadMarker === 'string' ? deps.leadMarker : '';
  const teammateMarker = typeof deps.teammateMarker === 'string' ? deps.teammateMarker : '';

  const state = {
    active: false,
    lead: undefined,        // {agentId, sessionId}
    policy: resolveKeepalivePolicy({}),
    intervalMs: MIN_INTERVAL_SECONDS * 1000,
    captured: undefined,    // {request, provider, model, at}
    armed: false,
    inflight: 0,
    inflightSince: 0,
    lastRequestAt: 0,
    attemptsInWait: 0,
    attemptsInSession: 0,
    pingTokens: 0,
    misses: 0,
    stopped: undefined,
    lastReason: 'idle',
    timer: undefined,
    pingAbort: undefined,
    reentrant: false,
    stats: emptyStats(),
    events: [],             // 最近若干条状态变化（状态文件/面板用）
  };

  function pushEvent(text) {
    state.events.push(`${new Date(now()).toISOString()} ${text}`);
    if (state.events.length > 20) state.events.splice(0, state.events.length - 20);
  }

  function clearTimer() {
    if (state.timer !== undefined) {
      try {
        cancelFn(state.timer);
      } catch {
        /* 取消失败只吞异常本身 */
      }
      state.timer = undefined;
    }
  }

  /** 当前是否该认为"没有在途请求"（含卡住计数的兜底）。 */
  function effectiveInflight() {
    if (state.inflight > 0 && now() - state.inflightSince > INFLIGHT_STALE_MS) {
      state.inflight = 0;
      pushEvent('在途计数超时未归零，按 0 处理（包装器可能没被消费）');
    }
    return state.inflight;
  }

  /** 组装决策输入（纯函数 decidePing 的唯一入口）。 */
  function decisionInput() {
    return {
      active: state.active,
      mode: state.policy.mode,
      armed: state.armed,
      inflight: effectiveInflight(),
      lastRequestAt: state.lastRequestAt,
      now: now(),
      intervalMs: state.intervalMs,
      waiters: state.active ? Number(waitersOf()) || 0 : 0,
      attemptsInWait: state.attemptsInWait,
      attemptsInSession: state.attemptsInSession,
      pingTokens: state.pingTokens,
      misses: state.misses,
      stopped: state.stopped,
    };
  }

  /**
   * 按**当前真实生效的路由**重算保活策略。
   *
   * 为什么必须有这一步（2026-10-04 审查 P1-9）：
   *   `attach` 时拿不到 Lead 的真实路由——插件配置里 `roles` 只接受 12 个角色 id
   *   （`lib/roster.js` 的 `sanitizeConfig` 只遍历 `ROLE_IDS`），'lead' 不是合法键，
   *   所以 `resolveRoleRoute(config,'lead')` 恒为 undefined，attach 只能落到兜底的 generic 族。
   *   于是线路族表里「deepseek 默认 off」（磁盘缓存按小时~天计、账号线路按请求计费，见 ROUTE_FAMILIES 注释）
   *   在真实运行中永远命中不到：Lead 用 DeepSeek 账号线路时会每 ~210s 白烧一次 ping。
   *   第一个真实请求的 options.provider/model 才是准确路由（用户中途切模型也照样跟上），
   *   所以在这里重算；用户手工覆盖表 overridesOf() 照旧参与，优先级不变。
   *
   * @param provider - 真实请求的 provider（可 undefined）。
   * @param model - 真实请求的 model（可 undefined）。
   * @param reason - 写进事件日志的触发来源。
   * @param force - 即使策略未变也重排间隔（配置保存后的重算需要）。
   * @returns 生效的策略。
   */
  function applyPolicy(provider, model, reason, force = false) {
    const next = resolveKeepalivePolicy({ provider, model, overrides: overridesOf() });
    const changed = next.family !== state.policy.family
      || next.mode !== state.policy.mode
      || next.source !== state.policy.source
      || next.ttlSeconds !== state.policy.ttlSeconds;
    state.policy = next;
    if (changed || force) state.intervalMs = jitteredIntervalMs(next, random);
    if (changed) {
      pushEvent(`保活策略按${reason}修正：${provider ?? '?'}/${model ?? '?'} → ${next.family}（${next.mode}，${next.source}，间隔 ${next.intervalSeconds}s）`);
      // 变成 off：立刻停掉在跑的定时器与在途 ping，别等下一次 tick 才发现。
      if (next.mode === 'off') {
        clearTimer();
        if (state.pingAbort !== undefined) {
          try {
            state.pingAbort.abort();
          } catch {
            /* abort 失败只吞异常本身 */
          }
        }
        state.lastReason = 'mode-off';
      }
    }
    return next;
  }

  /** 排下一次复查。任何状态变化后都调它（幂等：先清旧定时器）。 */
  function schedule() {
    clearTimer();
    if (!state.active || state.stopped !== undefined || state.policy.mode === 'off') return;
    const waiters = Number(waitersOf()) || 0;
    const base = Math.max(state.lastRequestAt + state.intervalMs, now() + 1_000);
    // 没人在跑队员时不需要盯着——队员一启动，runtime 会调 notifyActivity()。
    const due = waiters > 0 ? base : Math.max(base, now() + MAX_TIMER_MS);
    const delay = Math.max(1_000, Math.min(due - now(), MAX_TIMER_MS));
    state.timer = scheduleFn(() => {
      state.timer = undefined;
      void tick();
    }, delay);
    // 定时器不该把进程钉住（Node 环境；浏览器/测试替身没有 unref 也没关系）。
    state.timer?.unref?.();
  }

  /** 一次定时到点：要么 ping，要么记下原因继续等。 */
  async function tick() {
    const input = decisionInput();
    const decision = decidePing(input);
    state.lastReason = decision.reason;
    if (decision.ok !== true) {
      if (decision.reason === 'mode-off' || decision.reason === 'team-not-active') return;
      schedule();
      return;
    }
    await ping();
  }

  /** 发一次 ping。任何异常都只记诊断：保活失败绝不许影响会话。 */
  async function ping() {
    const captured = state.captured;
    if (captured === undefined) {
      state.lastReason = 'no-captured-prefix';
      schedule();
      return;
    }
    const llm = llmOf();
    if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
      state.stopped = 'llm-unavailable';
      state.lastReason = state.stopped;
      pushEvent('llm 服务不可用，保活停用');
      return;
    }
    const base = captured.request;
    const request = { ...base, messages: [...base.messages, pingTailMessage()], maxTokens: PING_MAX_TOKENS };
    const controller = new AbortController();
    state.pingAbort = controller;
    state.reentrant = true;
    const timeout = scheduleFn(() => {
      try {
        controller.abort();
      } catch {
        /* abort 失败只吞异常本身 */
      }
    }, PING_TIMEOUT_MS);
    timeout?.unref?.();
    let usage;
    let failure;
    try {
      const stream = llm.stream({ ...request, signal: controller.signal });
      for await (const chunk of stream) {
        if (chunk?.type === 'usage' && chunk.usage !== undefined) usage = chunk.usage;
        if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') failure = chunk.reason;
      }
    } catch (error) {
      failure = { kind: 'error', message: error?.message ?? String(error) };
    } finally {
      cancelFn(timeout);
      state.reentrant = false;
      state.pingAbort = undefined;
    }
    state.attemptsInWait += 1;
    state.attemptsInSession += 1;
    if (usage !== undefined) {
      foldUsage(state.stats, usage, 'ping');
      state.pingTokens = state.stats.pingTokensRead;
      const read = Number(usage.cacheReadTokens) || 0;
      if (read > 0) {
        state.misses = 0;
        state.armed = true;
        pushEvent(`ping 命中缓存（读 ${read} token）`);
      } else {
        state.misses += 1;
        pushEvent(`ping 未命中缓存（第 ${state.misses} 次）`);
        if (state.misses >= MISS_STOP_THRESHOLD) {
          state.stopped = 'repeated-misses';
          state.lastReason = state.stopped;
          note('缓存保活：连续 2 次 ping 都没有缓存命中 → 本条线路停止保活（避免白花钱）。');
          pushEvent('连续未命中，保活停用');
          return;
        }
      }
    } else {
      state.misses += 1;
      pushEvent(`ping 没有返回 usage${failure === undefined ? '' : `（${failure.message ?? failure.kind ?? '失败'}）`}`);
      if (state.misses >= MISS_STOP_THRESHOLD) {
        state.stopped = 'ping-failed';
        state.lastReason = state.stopped;
        note('缓存保活：连续 2 次 ping 失败 → 停止保活（不重试、不退避，下一次真实请求会重新评估）。');
        return;
      }
    }
    if (failure !== undefined) pushEvent(`ping 失败：${failure.message ?? failure.kind ?? 'unknown'}`);
    schedule();
  }

  /** 判定这段系统提示词是不是 Lead 的。 */
  function roleOfSystemText(text) {
    if (typeof text !== 'string' || text === '') return 'unknown';
    if (teammateMarker !== '' && text.includes(teammateMarker)) return 'teammate';
    if (leadMarker !== '' && text.includes(leadMarker)) return 'lead';
    return 'other';
  }

  /**
   * `llm/stream` 瀑布监听器本体。
   *
   * 契约（见 dsh-llm/lib/index.js:2367-2371 的 `streamWithRegistration`）：
   * 监听器收到 (options, next)，**必须**把 next() 的结果原样返回（可包一层但不得改变内容）。
   */
  function handleStream(options, next) {
    let downstream;
    try {
      downstream = next();
    } catch (error) {
      // 下游自己抛错：不是我们的责任，照原样抛回去。
      throw error;
    }
    try {
      if (state.reentrant) return downstream;                 // 我们自己发的 ping
      if (!state.active) return downstream;                    // 团队没开：完全旁路
      const role = roleOfSystemText(systemTextOf(options));
      if (role !== 'lead') return downstream;                  // 队员/其它模式：完全旁路
      // 上一次是**偶发失败**（provider 抖了一下）→ 新的一代真实请求可以再试；
      // 但 'repeated-misses' 是**证据性**结论（这条线路的缓存留不住），保持粘住不重试，
      // 避免"每次真实请求都重新开始烧 ping"。重新 arm 的唯一途径是用户改配置或重开团队。
      if (state.stopped === 'ping-failed') {
        state.stopped = undefined;
        state.misses = 0;
        pushEvent('上一次 ping 是偶发失败，新请求到来后重新开始评估');
      }
      if (state.stopped !== undefined) return downstream;      // 其它停止原因：连前缀都不抓
      // 真实请求来了：在途的 ping 立刻让路（同一条线路上不做并发）。
      if (state.pingAbort !== undefined) {
        try {
          state.pingAbort.abort();
        } catch {
          /* abort 失败只吞异常本身 */
        }
      }
      const captured = captureRequest(options);
      if (captured.ok !== true) {
        log(`缓存保活：无法抓取前缀（${captured.error}）`);
        return downstream;
      }
      state.captured = { request: captured.request, provider: options.provider, model: options.model, at: now() };
      // 线路族以**真实请求**为准：attach 时拿不到 Lead 的真实路由，用户中途切模型也要跟上（P1-9）。
      applyPolicy(options.provider, options.model, '真实请求');
      state.lastRequestAt = now();
      state.attemptsInWait = 0;      // 新的等待窗口开始
      state.misses = 0;
      state.intervalMs = jitteredIntervalMs(state.policy, random);
      state.inflight += 1;
      state.inflightSince = now();
      schedule();
    } catch (error) {
      log(`缓存保活：观察请求时出错（已忽略）：${error?.message ?? error}`);
      return downstream;
    }
    return wrapStream(downstream);
  }

  /** 包装真实请求的流：只为记 usage（前缀是否命中），绝不改变 chunk。 */
  function wrapStream(stream) {
    const finish = () => {
      state.inflight = Math.max(0, state.inflight - 1);
      schedule();
    };
    if (stream === undefined || stream === null || typeof stream[Symbol.asyncIterator] !== 'function') {
      finish();
      return stream;
    }
    return tapStream(
      stream,
      (chunk) => {
        if (chunk?.type === 'usage' && chunk.usage !== undefined) {
          foldUsage(state.stats, chunk.usage, 'request');
          const read = Number(chunk.usage.cacheReadTokens) || 0;
          if (read > 0 && state.armed !== true) {
            state.armed = true;
            pushEvent('线路已证明有缓存命中（auto 模式的开启条件满足）');
          }
          if (read > 0 && state.misses > 0) state.misses = 0;
        }
      },
      finish,
    );
  }

  return {
    /** 注册观察器（返回 disposer）。 */
    observe(ctx) {
      if (ctx === undefined || typeof ctx.on !== 'function') throw new Error('keepalive.observe 需要带 on() 的 ctx');
      const off = ctx.on('llm/stream', handleStream);
      return typeof off === 'function' ? off : () => void 0;
    },
    /**
     * `llm/stream` 瀑布监听器本体（`observe` 注册的就是它）。
     * 单独暴露出来是为了让集成测试能直接驱动它（不必依赖真模型的调用），
     * 也方便排查「为什么这次请求没被抓到」。
     */
    handleStream,
    /** 团队开启：绑定 Lead。 */
    attach({ agentId, sessionId, provider, model } = {}) {
      state.active = true;
      state.lead = { agentId, sessionId };
      state.stopped = undefined;
      state.attemptsInWait = 0;
      state.misses = 0;
      state.captured = undefined;
      state.lastRequestAt = 0;
      // 挂载时的 provider/model 只是初值（runtime 那边拿不到 Lead 的真实路由，见 applyPolicy 的注释）；
      // 真实族判定在第一个被抓取的请求上完成（handleStream → applyPolicy）。
      applyPolicy(provider, model, '挂载', true);
      pushEvent(`保活挂载：${provider ?? '?'}/${model ?? '?'} → ${state.policy.mode}（${state.policy.source}，间隔 ${state.policy.intervalSeconds}s）`);
      schedule();
      return this.stats();
    },
    /** 团队关闭 / 插件卸载：停掉一切。 */
    detach(reason = 'detach') {
      clearTimer();
      if (state.pingAbort !== undefined) {
        try {
          state.pingAbort.abort();
        } catch {
          /* abort 失败只吞异常本身 */
        }
      }
      state.active = false;
      state.captured = undefined;
      state.inflight = 0;
      state.lastReason = reason;
      pushEvent(`保活卸载：${reason}`);
    },
    /** 队员状态变化时叫一声，让定时器提前复查（不唤醒任何人，只是重排定时器）。 */
    notifyActivity() {
      if (state.active && state.stopped === undefined && state.policy.mode !== 'off') schedule();
    },
    /** 用户改了配置：重算策略与间隔。 */
    reconfigure() {
      // 用户改了覆盖表：按已抓到的真实路由重算（还没抓到过请求时退回初值）。
      applyPolicy(state.captured?.provider, state.captured?.model, '配置重算', true);
      state.stopped = undefined;
      state.misses = 0;
      schedule();
      return this.stats();
    },
    /** 状态快照（状态文件 / 面板 / 诊断用）。 */
    stats() {
      const stats = { ...state.stats, hitRatio: hitRatio(state.stats) };
      return {
        active: state.active,
        mode: state.policy.mode,
        family: state.policy.family,
        source: state.policy.source,
        why: state.policy.why,
        intervalSeconds: state.policy.intervalSeconds,
        provider: state.captured?.provider,
        model: state.captured?.model,
        armed: state.armed,
        stopped: state.stopped,
        lastReason: state.lastReason,
        attemptsInWait: state.attemptsInWait,
        attemptsInSession: state.attemptsInSession,
        pingTokens: state.pingTokens,
        misses: state.misses,
        inflight: effectiveInflight(),
        stats,
        events: [...state.events],
      };
    },
    /** 只给测试用：直接暴露内部决策输入。 */
    _decisionInput: decisionInput,
  };
}

/**
 * 观察器：包一层 async 迭代器，把 usage 摘出来，再把 chunk 原样放行。
 *
 * 三件事必须成立：① 不改变 chunk；② 消费方提前 return/抛错时，内层迭代器也要被关闭；
 * ③ 观察代码自己抛错不许影响数据流。
 */
export function tapStream(stream, onChunk, onDone) {
  const finish = () => {
    if (typeof onDone === 'function') {
      try {
        onDone();
      } catch {
        /* 完成回调失败不影响数据流 */
      }
    }
  };
  return (async function* tapped() {
    let iterator;
    try {
      iterator = stream[Symbol.asyncIterator]();
    } catch {
      // 不是异步可迭代对象：原样交回去，绝不假装能包。
      finish();
      return;
    }
    try {
      for (;;) {
        const step = await iterator.next();
        if (step.done === true) return;
        try {
          if (typeof onChunk === 'function') onChunk(step.value);
        } catch {
          /* 观察失败不影响数据流 */
        }
        yield step.value;
      }
    } finally {
      const close = iterator.return?.bind(iterator);
      if (typeof close === 'function') {
        try {
          await close();
        } catch {
          /* 关闭失败只吞异常本身；调用方已经拿到它的结果 */
        }
      }
      finish();
    }
  })();
}
