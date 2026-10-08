// 调度模式智能体团队 —— host 侧共享单例（runtime）
//
// 本模块是**唯一持有可变状态**的地方：配置（<dshHome>/dispatch-agent-team.json）、
// 「哪些 Lead 开启了团队」、以及每个 agent 作用域上已注册的提示词段/工具/模型覆盖的
// disposer 账本。`lib/index.js`（宿主入口）与 `lib/preset.js`（preset 入口）都 import 它；
// 两者解析到同一文件 URL，Node ESM 模块缓存保证是同一实例。
//
// 只依赖 node 内置 + 本包内的 roster.js / playbook.js / tools.js。
// 本模块**不** import 任何 @deepseek-ai/* 包（模型目录等能力一律走 ctx.get(name) 取活体服务）。
//
// 关键活体 API 证据（行号取自 0.1.7-rc.2 解包源码快照；2026-09-28 桌面端升到 0.2.0-rc.1 后
// 已用 tools/drift-check.cjs 对着新 app.asar 逐条复核，全部未变，见 INTERFACES 勘误表第 21-24 条）：
//   * ctx.get(name)                       —— 取可选服务：dsh-subagent/lib/index.js:472 等
//   * ctx.agents.list()                   —— dsh-agent/lib/index.js:612
//   * ctx.agents.isOwnedBy(id, owner)     —— dsh-agent/lib/index.js:605（本模块未用，改用 membership.root）
//   * agent.id / agent.ctx / agent.session—— dsh-agent-loop/lib/index.js:749/757/779
//   * agent.followup(input)               —— dsh-agent-loop/lib/index.js:806
//   * agent/request waterfall payload      —— dsh-agent/lib/index.js:243-246（注入 agent 字段）+ :268
//   * agent/request 分发点                 —— dsh-agent-loop/lib/index.js:1179（prepareRequest 内；:1164-1168 只是同一函数开头的 route 种子）
//   * 监听器写法蓝本                       —— dsh-agent/lib/types/model-selection.js:61-75
//   * systemPrompt.section({name,order,text}) —— dsh-system-prompt/lib/index.js:240-243
//   * tools.register(definition)           —— dsh-tools/lib/index.js:2878-2886
//   * ctx.effect(fn, label)                —— dsh-agent/lib/index.js:490
//   * ctx.on('agent/created'|'agent/disposed') —— 官方 dsh-experimental-tool-agent-team/lib/index.js:544-550
//   * ctx.llm.listProviders/listModels/resolveModelInfo —— dsh-llm/lib/index.js:1899/2073/2098
//   * LlmProviderInfo/LlmModelInfo/LlmResolvedModelInfo —— dsh-llm/lib/typert.host.js:385/377/393
//   * ctx.settings.prepareDocument()       —— dsh-settings/lib/index.js:406-408；服务名 "settings" :330
//   * agentTeams 服务与方法                —— dsh-experimental-agent-team/lib/index.js:1704("agentTeams")/1747/1755/1764/1836
//   * tools.restrict({allow,deny})         —— dsh-tools/lib/index.js:2790(0.1.5)/:2895(0.1.7-rc.2)；语义见 view() 的
//     「A restriction filters what a scope inherits … and never what its OWN layer registers」，
//     未知名字抛 `names unknown global tool`。官方同型用法：dsh-subagent/lib/index.js:522
//     （applyChildComposition 里的 `childCtx.tools.restrict(composition.toolFilter)`）。

import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  CONFIG_FILENAME,
  LEAD_TEAM_TOOL_NAMES,
  MEMBER_TEAM_TOOL_NAMES,
  TEAMMATE_SECTION_MUTES,
  TEAMMATE_TOOL_DENY,
  defaultConfig,
  deriveRole,
  resolveMemberRoute,
  resolveRoleRoute,
  sanitizeConfig,
} from './roster.js';
import { LEAD_MARKER, TEAMMATE_CARD, TEAMMATE_MARKER, TEAM_POLICY } from './playbook.js';
import { createKeepalive } from './cache.js';
import { clipText } from './text-clip.js';
import { teamToolDefinitions } from './tools.js';
import { collectGraph, extractQuestions, readConversationTail } from './graph.js';
import {
  isEnabledSession,
  markDisabled,
  markEnabled,
  sessionMemoryStats,
  touchSession,
} from './resume.js';

/** 团队协作策略段的排序值。取 600 = 官方 TEAM_POLICY 槽位（dsh-system-prompt/lib/index.js:14）。
 *  官方那段由 `lib/preset.js` 在调度模式的 preset 作用域里用**同名空段**遮蔽（见那里的长注释），
 *  本插件的策略段则接在同一个槽位上，所以两边共用这一个常量。 */
export const TEAM_POLICY_ORDER = 600;
/** 队员卡段的排序值。与策略段同区（600）：先读策略，紧接着读「你是队员、请跳过 Lead 编排章节」。 */
const TEAMMATE_CARD_ORDER = 600;
/** 被清空的段用一个固定 order 兜底（`getSectionOrder` 拿不到官方槽位时用）。 */
const MUTE_FALLBACK_ORDER = 2600;
/** preset 层 Lead 方法论段的段名；队员作用域里注册同名空段以尽力遮蔽它。 */
const PLAYBOOK_SECTION = 'dispatch:playbook';
/** 官方 agent-team bundle 的 fresh/fork 子代理 provider（官方默认值，tool-agent-team/lib/index.js:17-18）。 */
const FRESH_PROVIDER = 'spawn';
const FORK_PROVIDER = 'fork';
/** 诊断环上限，防止长会话里无限增长。 */
const DIAGNOSTIC_CAP = 50;

/**
 * 模块级共享状态。
 * - config / configStat：最近一次成功读到的配置与它的 (mtimeMs,size) 指纹。
 * - roots：已开启团队的 Lead agent id 集合。
 * - installed：agentId -> {ownerId, role, disposers[], diagnostics[]}，所有我们注册进 agent 作用域的东西。
 * - watch：宿主 ctx 上的 agent 生命周期订阅（幂等，只注册一次）。
 */
const state = {
  config: defaultConfig(),
  configPath: undefined,
  home: undefined,
  configStat: undefined,
  loaded: false,
  loadPromise: undefined,
  roots: new Set(),
  installed: new Map(),
  watch: undefined,
  /** 故障通道：真的出错了才写这里（配置坏掉、注入失败…）。页面只对这条通道报红色告警。 */
  diagnostics: [],
  /** 信息通道：正常事实（DSH 主目录、配置文件路径、控制面注册成功）。页面用中性样式展示。 */
  notes: [],
  /** 最近一次 `ctx.get('agentTeams')` 的观察结果：undefined = 还没观察过（status 里报 null）。 */
  domainAvailable: undefined,
  /** 保活观察器（llm/stream）的 disposer 账本：插件卸载时由 lib/index.js 回卷。 */
  keepaliveDisposers: [],
  /** 本进程内按会话记忆恢复过几次团队（排查用；恢复细节见 lib/resume.js）。 */
  sessionsRestored: 0,
};

/**
 * **显式** spawn 参数的两个钉子（队员名 → 值）：只有 `spawn_teammate` 的**工具调用参数**里
 * 明确写了 provider/model（或 reasoning_effort）才进这里。
 *
 * 为什么必须与「角色配置」分开：角色配置是**用户随时会改**的东西（面板上改模型、或改回「跟随 Lead」），
 * 每次请求都要重读（`resolveMemberRoute(explicit, resolveRoleRoute(peekConfig(), role), effortPin)`）。
 * 曾经把角色配置解析出来的路由也钉进 `spawnRoutes` —— 结果「跟随 Lead」永远不生效，队员一直跑旧模型
 * （用户 2026-10-01 报的 bug，证据见 MAINTAINER-NOTES.md §8.12）。
 */
const spawnRoutes = new Map();
/** 本次 spawn 显式给的思考强度（可以与模型无关地单独存在）。 */
const spawnEfforts = new Map();

/** 已确认「该模型广告了哪些思考档位」的缓存：`provider\u0000model` → Set<effortId>；失败不进缓存。 */
const advertisedEfforts = new Map();

/**
 * 上一轮 turn 因输出上限结束的队员（agentId → true）。
 * 来源是官方 turn/end 事件：dsh-agent-loop/lib/index.js:1151 产生 max-tokens、
 * :979 在 turn 内聚合、:1027-1030 以 append("turn/end", { turn, reason }) 落进会话日志；
 * 事件本身经宿主 ctx 的 session/event 广播拿到（dsh-scope/lib/invariant.js:26 把 session/event
 * 标为 null = 不按 agent 过滤；官方 agent-team 自己就这么监听：dsh-experimental-agent-team/lib/index.js:1720-1722）。
 * 用途：list_agents 给 Lead 一行固定诊断，把 wake_teammate 的触发从「猜」变成「看标志」
 * （2026-10-04 审查 §8 建议 A）。每个队员的**最近一次** turn/end 覆盖这条记录，不累积。
 */
const truncatedMembers = new Set();

/**
 * 队员的**最近一条** llm/retry 记录（agentId → 一行可读摘要）。
 *
 * 为什么需要它（2026-10-05 审查 §1-⑥）：宿主**本来就在自动退避**
 * （dsh-llm/lib/index.js 的 DEFAULT_MAX_RETRIES=5 / initialDelayMs=500 / maxDelayMs=1e4 /
 * jitterRatio=.1，可重试码集合含 RATE_LIMIT）；而这条路此前在插件里**整个被丢掉**
 * （session/event 监听器第一行就是 `if (event.type !== 'turn/end') return;`，全仓 grep llm/retry 零命中）。
 * 后果：队员被 429 打死后，表现是「看起来只是停下来了」，与「干完了忘了交报告」
 * 「撞了输出上限」在状态面上**不可区分**；唯一区分手段是 Lead 去读队员正文。
 *
 * 观测口径（只报事实，不推断）：记 provider / 第几次重试 / 等待多久 / 失败码。
 * 事件形状依据装机 0.2.0-rc.2 的 dsh-llm-retry/lib/index.js:116-150：
 * `agent.session.append("llm/retry", {retryId, turn, step, provider, mode, policyKey, retry,
 * maxRetries, delayMs, failure})` —— maxRetries 只在 mode==='normal' 时才带。
 * 每个队员的**最近一次**覆盖这条记录，不累积（同 truncatedMembers 的手法）。
 */
const retriedMembers = new Map();

/** 保留重试摘要里的字段上限（防一条畸形事件把状态文件撑大）。 */
const RETRY_FIELD_LIMIT = 120;

/**
 * 记录一条队员的 llm/retry（由 session/event 监听器调用）。永不抛错。
 * @param agentId - 会话/agent id。
 * @param data - 事件的 data 字段。
 */
export function noteRetryEvent(agentId, data) {
  if (typeof agentId !== 'string' || agentId === '') return;
  const failure = data?.failure ?? void 0;
  const code = typeof failure?.code === 'string' && failure.code !== '' ? failure.code : (typeof failure?.name === 'string' ? failure.name : '未知失败码');
  const retry = Number.isFinite(data?.retry) ? data.retry : void 0;
  const maxRetries = Number.isFinite(data?.maxRetries) ? data.maxRetries : void 0;
  const delayMs = Number.isFinite(data?.delayMs) ? data.delayMs : void 0;
  const provider = typeof data?.provider === 'string' ? clipText(data.provider, RETRY_FIELD_LIMIT) : '';
  const parts = [`失败码 ${clipText(code, RETRY_FIELD_LIMIT)}`];
  if (provider !== '') parts.push(`线路 ${provider}`);
  if (retry !== void 0) parts.push(maxRetries === void 0 ? `第 ${retry} 次重试` : `第 ${retry}/${maxRetries} 次重试`);
  if (delayMs !== void 0) parts.push(`等 ${Math.round(delayMs)}ms`);
  retriedMembers.set(agentId, parts.join(' · '));
}

/**
 * 清掉某个队员的重试记录（新一轮开始时调用）。
 * @param agentId - 会话/agent id。
 */
export function clearRetryEvent(agentId) {
  if (typeof agentId !== 'string' || agentId === '') return;
  retriedMembers.delete(agentId);
}

/** 读重试记录（list_agents 标注用）：agentId → 最近一次的重试摘要。 */
export function retriedMemberIds() {
  return new Map(retriedMembers);
}

/**
 * 状态文件刷新钩子（由 lib/index.js 在宿主半 apply 时注册，卸载时清掉）。
 * runtime 不能自己写状态文件（那需要 host ctx 与 writeStatusFile），所以反向调用宿主半注册的回调；
 * 没注册时是空操作。用途见 refreshStatusFile()。
 */
let statusRefresh;

/** 把任意异常变成可读字符串；本模块不允许吞掉错误，只允许把它变成诊断。 */
function messageOf(error) {
  if (error === undefined || error === null) return '未知错误';
  if (typeof error === 'string') return error;
  return String(error.message ?? error);
}

/**
 * 往一条通道里压一条记录（带上限，防止长会话里无限增长）。
 *
 * **相邻同文本去重**（2026-10-04 审查 P2-12）：本机实测 op=get 返回的 notes 里，
 * 「调度模式控制面已注册…」与「已在本 preset 遮蔽官方 team:policy 段…」各出现两次，
 * 而 diagnostics 为空。成因未完全定位，但已排除「preset 子树按会话重跑」这一种：
 * 官方 dsh-agent-preset-registry 里 mountPreset 只在 activate() 调一次（:262 定义、:534 唯一调用），
 * bind/join（:661-686）只把 agent scope 挂到共享 generation 上，collect（:569-573）只销毁
 * retired 且 users===0 的 generation——所以逐会话绑定不会重新 apply 子树。
 * 无论重复来自哪一种挂载路径，同一条事实被记 N 遍都不该原样堆进通道。
 * 只去**相邻**重复而不是全局去重：两条之间只要夹了别的内容（例如「DSH 主目录」行）
 * 就仍算两条独立事实，不能压掉。
 * @param ring - state.diagnostics 或 state.notes。
 * @param message - 任意可读文本。
 */
function push(ring, message) {
  const text = String(message);
  if (ring.length > 0 && ring[ring.length - 1] === text) return;
  ring.push(text);
  if (ring.length > DIAGNOSTIC_CAP) ring.splice(0, ring.length - DIAGNOSTIC_CAP);
}

/**
 * 记一条**故障**诊断，供 status()/返回值/HTTP 路由展示。
 *
 * 注意：只记真的出问题的事：这条通道直接渲染成页面上的红色告警（client.js 的 diagnosticsTitle
 * 写的是「配置文件可能有问题」）。把「一切正常」的事实写进来，用户就会在**没有任何问题**的时候
 * 一直看到一条红色警告 —— 2026-09-28 的截图就是这么来的。
 * @param message - 任意可读文本。
 */
function recordDiagnostic(message) {
  push(state.diagnostics, message);
}

/**
 * 记一条**信息**（正常事实，不是故障）。与故障分开两条通道，页面样式与语义都不混。
 * @param message - 任意可读文本。
 */
export function recordNote(message) {
  push(state.notes, message);
}

/** 读信息快照（浅拷贝，外部改不到内部数组）。 */
export function notes() {
  return [...state.notes];
}

/** 读故障快照（浅拷贝，外部改不到内部数组）。 */
export function diagnostics() {
  return [...state.diagnostics];
}

/**
 * 记录一条**注册期**记录（preset 子树与 host 半共用同一条通道）。
 * 用途：preset 子树里注册失败时不能抛（抛出去会让整份 preset 变 broken，而且宿主导看不到原因），
 * 只能把原因记到这里，再由 host 半写进状态文件 / 配置页。
 * @param message - 任意可读文本。
 * @param kind - `'info'` 走信息通道；其余（含省略）= 故障通道。
 */
export function recordBootNote(message, kind) {
  if (kind === 'info') recordNote(message);
  else recordDiagnostic(message);
}

/**
 * 取一个可选服务：`ctx.get(name)` 是 Cordis 的显式逃生口（服务缺失返回 undefined 而不是抛错）。
 * 只有拿不到 `get` 时才退回属性访问，且属性访问失败也降级为 undefined。
 * @param ctx - 任意作用域的宿主/preset ctx。
 * @param name - 服务名。
 * @returns 服务实例或 undefined。
 */
function pick(ctx, name) {
  if (ctx === undefined || ctx === null) return undefined;
  if (typeof ctx.get === 'function') {
    try {
      return ctx.get(name) ?? undefined;
    } catch (error) {
      recordDiagnostic(`ctx.get("${name}") 失败：${messageOf(error)}`);
    }
  }
  try {
    return ctx[name] ?? undefined;
  } catch {
    return undefined;
  }
}

/** agent 的稳定 id；不是活体 agent 形状就返回 undefined。 */
function agentIdOf(agent) {
  return agent !== null && typeof agent === 'object' && typeof agent.id === 'string' && agent.id !== '' ? agent.id : undefined;
}

/**
 * 取 agent 的**会话 id**（= 会话日志目录名），用于会话级记忆（lib/resume.js）。
 *
 * 依据：`agent.id === agent.session.id` 是官方硬约束 —— dsh-agent/lib/index.js:512
 * `if (id !== agent.session.id) throw new Error(...)`，且注册表把 agent id 当 session id 查
 * （同上 :591-595「The shared agent/session id to look up」）。所以优先读 `agent.session.id`，
 * 取不到再退回 `agent.id`；两者都没有就返回 undefined（不猜）。
 * @param agent - 任意 agent。
 * @returns {string|undefined}
 */
function sessionIdOf(agent) {
  if (agent === null || typeof agent !== 'object') return undefined;
  const id = agent.session?.id;
  if (typeof id === 'string' && id !== '') return id;
  return agentIdOf(agent);
}

/**
 * 取官方 Agent Teams 域服务，并记录「是否可用」供 status()/配置页排查。
 * **永不硬依赖**：`@deepseek-ai/dsh-experimental-agent-team-profile` 是可选 bundle，
 * 用户关掉它之后本插件的 patch 项会被跳过、域服务消失，此时必须降级而不是崩。
 * @param ctx - 任意作用域 ctx。
 * @returns 域服务或 undefined。
 */
function agentTeamsOf(ctx) {
  const teams = pick(ctx, 'agentTeams');
  state.domainAvailable = teams !== undefined;
  return teams;
}

/**
 * 解析一个 agent 的团队身份，永不抛错。
 * 域服务对任何非子代理的活体 agent 都会返回 `{root,id,role:'lead'|'teammate',name}`，
 * 只有「不是团队成员的子代理」才返回 undefined（dsh-experimental-agent-team/lib/index.js:397-430）。
 */
function safeMembership(agentTeams, agent) {
  if (agentTeams === undefined || agent === undefined || agent === null) return undefined;
  if (typeof agentTeams.tryMembership !== 'function') return undefined;
  try {
    return agentTeams.tryMembership(agent) ?? undefined;
  } catch (error) {
    recordDiagnostic(`tryMembership 失败：${messageOf(error)}`);
    return undefined;
  }
}

// ── DSH 主目录与配置文件路径 ────────────────────────────────────────────────

/**
 * 定位 DSH 主目录（`<dshHome>`）。
 *
 * ── 并发语义（2026-09-28 修） ────────────────────────────────────────────────
 * 这里的检查 (`state.home !== undefined`) 与赋值之间**隔着 `await`**，所以必须把「正在进行的那一次」
 * 也缓存下来：宿主启动时 `apply()` 会 fire-and-forget 地同时起两条路径
 * （lib/index.js:282 的 `loadConfig` 与 lib/index.js:336→:369 的 `getConfigPath`），
 * 第二个调用者会在第一个还没回来时从同一个窗口挤进来，把同一次定位**重算一遍**，于是
 * 「DSH 主目录 / 配置文件」各被记两遍（用户截图里那 4 行重复就是这么来的）。
 * 旧实现的判断在 await 之前、赋值在 await 之后，属于典型的 check-then-act 竞态。
 * @param ctx - 宿主 ctx（需要其中的 settings 服务）。
 * @returns Promise<`<dshHome>` 绝对路径>。
 */
async function resolveDshHome(ctx) {
  if (state.home !== undefined) return state.home;
  if (homePromise === undefined) homePromise = locateDshHome(ctx);
  try {
    return await homePromise;
  } finally {
    // 只清「进行中」的引用：失败（本函数不抛，但有兜底）后下一次调用能重试；
    // 成功时 state.home 已经落定，后续调用直接短路。
    homePromise = undefined;
  }
}

/** 进行中的主目录定位：并发调用共享同一次（见 resolveDshHome 的并发语义）。 */
let homePromise;

/**
 * 真正干活的定位逻辑：只被 resolveDshHome 单一入口调用一次。
 *
 * 0.1.7 的 `ctx.settings.prepareDocument()` 返回的是 **profile 的 patch 文件路径**
 * （`dsh-settings/lib/index.js:406-408` → `documentPath`，本机实测为
 * `<DSH 主目录>\profiles\desktop\cordis.patch.yml`）。所以直接取 dirname 得到的是
 * profile 目录而不是 DSH 主目录；这里先按 `<home>/profiles/<profile>/<file>` 的形状剥掉
 * `profiles/<profile>/<file>` 三段，再用「<候选>/profiles 是不是目录」做存在性确认。
 * 0.2.0-rc.1 的 `dsh-settings` 里 `prepareDocument` / `documentPath` 都还在（drift-check 守着）。
 *
 * 候选顺序：文档推导 → `DSH_HOME` 环境变量 → `os.homedir()/.dsh`。
 * @param ctx - 宿主 ctx（需要其中的 settings 服务）。
 * @returns Promise<`<dshHome>` 绝对路径>。
 */
async function locateDshHome(ctx) {
  /** 候选顺序（Lead 裁决）：文档剥离推导 → DSH_HOME → ~/.dsh → 最后退回 profile 目录本身。 */
  const candidates = [];
  let profileDir;
  const settings = pick(ctx, 'settings');
  if (settings !== undefined && typeof settings.prepareDocument === 'function') {
    try {
      const document = await settings.prepareDocument();
      if (typeof document === 'string' && document !== '') {
        const absolute = path.resolve(document);
        profileDir = path.dirname(absolute);
        const parts = absolute.split(path.sep);
        // <home>/profiles/<profile>/cordis.patch.yml → 剥掉 profiles/<profile>/<file> 三段
        const profilesIndex = parts.lastIndexOf('profiles');
        if (profilesIndex > 0 && parts.length - profilesIndex === 3) {
          candidates.push(parts.slice(0, profilesIndex).join(path.sep) || path.sep);
        }
      }
    } catch (error) {
      recordDiagnostic(`settings.prepareDocument() 失败，改用环境变量定位 DSH 主目录：${messageOf(error)}`);
    }
  }
  const envHome = process.env.DSH_HOME;
  if (typeof envHome === 'string' && envHome.trim() !== '') candidates.push(path.resolve(envHome.trim()));
  candidates.push(path.join(homedir(), '.dsh'));
  if (profileDir !== undefined && path.isAbsolute(profileDir)) candidates.push(profileDir);

  const usable = candidates.filter((candidate) => path.isAbsolute(candidate));
  // 先在候选里找「<candidate>/profiles 确实是目录」的那个（本机命中 ~/.dsh）。
  for (const candidate of usable) {
    if (isDirectory(path.join(candidate, 'profiles'))) {
      state.home = candidate;
      recordNote(`DSH 主目录：${state.home}（由 <home>/profiles 存在性确认）`);
      return state.home;
    }
  }
  state.home = usable[0] ?? path.join(homedir(), '.dsh');
  recordDiagnostic(`无法确认 DSH 主目录（候选里都没有 profiles 目录），按候选顺序取 "${state.home}"`);
  return state.home;
}

/** 同步的存在性探测，只在目录定位时用。 */
function isDirectory(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 配置文件绝对路径：`<dshHome>/dispatch-agent-team.json`。
 *
 * 与 resolveDshHome 同样的并发语义：检查与实际算之间隔着 await，必须缓存「进行中的那一次」，
 * 否则同一个进程里并发进来的第二个调用者会把路径重算并重记一遍。
 * @param ctx - 宿主/preset ctx。
 * @returns Promise<string>。
 */
export async function getConfigPath(ctx) {
  if (state.configPath !== undefined) return state.configPath;
  if (configPathPromise === undefined) configPathPromise = locateConfigPath(ctx);
  try {
    return await configPathPromise;
  } finally {
    configPathPromise = undefined;
  }
}

/** 进行中的配置文件路径定位：并发调用共享同一次。 */
let configPathPromise;

/**
 * 真正算路径的那一次（只被 getConfigPath 单一入口调用）。
 * @param ctx - 宿主/preset ctx。
 * @returns Promise<string>。
 */
async function locateConfigPath(ctx) {
  const home = await resolveDshHome(ctx);
  const file = path.join(home, CONFIG_FILENAME);
  state.configPath = file;
  recordNote(`配置文件：${file}`);
  return file;
}

// ── 配置读写 ────────────────────────────────────────────────────────────────

/**
 * 读取并净化配置。以磁盘为准；mtime+size 未变时直接用缓存。
 * 永不抛错：文件不存在 → 空配置；读失败 → 保留上一次成功值并记诊断。
 * @param ctx - 宿主/preset ctx。
 * @returns Promise<净化后的配置>。
 */
export async function loadConfig(ctx) {
  if (state.loadPromise !== undefined) return state.loadPromise;
  state.loadPromise = (async () => {
    const file = await getConfigPath(ctx);
    let fingerprint;
    try {
      const info = await stat(file);
      fingerprint = { mtimeMs: info.mtimeMs, size: info.size };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        state.config = defaultConfig();
        state.configStat = undefined;
        state.loaded = true;
        return state.config;
      }
      recordDiagnostic(`读取配置失败（保留上次值）：${messageOf(error)}`);
      return state.config;
    }
    if (state.loaded && state.configStat !== undefined && state.configStat.mtimeMs === fingerprint.mtimeMs && state.configStat.size === fingerprint.size) {
      return state.config;
    }
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      recordDiagnostic(`读取配置失败（保留上次值）：${messageOf(error)}`);
      return state.config;
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      recordDiagnostic(`配置文件不是合法 JSON，已按空配置处理：${messageOf(error)}`);
      state.config = defaultConfig();
      state.configStat = fingerprint;
      state.loaded = true;
      return state.config;
    }
    const config = sanitizeConfig(raw, (message) => recordDiagnostic(`配置：${message}`));
    state.config = config;
    state.configStat = fingerprint;
    state.loaded = true;
    return config;
  })();
  try {
    return await state.loadPromise;
  } finally {
    state.loadPromise = undefined;
  }
}

/**
 * 最近一次成功读到的配置（**同步**热路径，永不抛错）。
 * 未读过任何文件时返回空配置（= 全部角色跟随 Lead）。
 * @returns 净化后的配置。
 */
export function peekConfig() {
  return state.config;
}

/**
 * 磁盘配置的版本指纹（**同步**；必须在 loadConfig/get 之后读才是新鲜的）。
 *
 * 为什么需要它：配置页会整份替换 roles，两个会话同时改就是静默 last-write-wins
 * ——后保存的一方把前一方刚加的配置整段抹掉，而且双方都看到「已保存」。
 * 客户端把读到的指纹带回来，`set` 比对不一致就拒绝并让它重新载入。
 *
 * 形状 `'<mtimeMs>:<size>'`；文件不存在时返回 `''`（= 还没有配置，任何非空指纹都算冲突）。
 * @returns 版本指纹。
 */
export function peekRevision() {
  const info = state.configStat;
  if (info === undefined) return '';
  return `${info.mtimeMs}:${info.size}`;
}

/**
 * 净化后原子落盘（同目录 tmp + rename），并立即更新 peekConfig()。
 * @param ctx - 宿主/preset ctx。
 * @param raw - 客户端/命令提交的任意值。
 * @returns Promise<{ok:true, config, diagnostics}|{ok:false, error}>。
 */
export async function saveConfig(ctx, raw) {
  const notes = [];
  const config = sanitizeConfig(raw, (message) => notes.push(`配置：${message}`));
  const file = await getConfigPath(ctx);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
  } catch (error) {
    try {
      await unlink(tmp);
    } catch {
      /* tmp 可能根本没创建成功，忽略清理失败 */
    }
    return { ok: false, error: `写入配置失败：${messageOf(error)}` };
  }
  state.config = config;
  state.loaded = true;
  try {
    const info = await stat(file);
    state.configStat = { mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    state.configStat = undefined;
  }
  // 保活策略来自配置：保存后立刻重算（新的 mode/间隔对当前会话生效，不用重启）。
  reconfigureKeepalive();
  return { ok: true, config, diagnostics: notes };
}

// ── 模型目录与路由预检 ──────────────────────────────────────────────────────

/**
 * 列 provider → model → reasoning.efforts 目录，供配置页下拉。
 * 依据 0.1.7 的 ctx.llm：`listProviders()`（dsh-llm/lib/index.js:1899 → `{id,name}`，形状见
 * typert.host.js:385）→ `listModels(provider)`（:2073）→ `resolveModelInfo(provider,model)`
 * （:2098，reasoning 形状见 :2143-2149）。
 * **拿不到 reasoning 元数据的模型一律不给 efforts**（官方硬规则）。
 * @param ctx - 宿主/preset ctx。
 * @returns Promise<{groups:[{id,name,models:[{id,name,reasoning?}]}], failures:[{id,name,message}]}>。
 */
export async function listModelCatalog(ctx) {
  const failures = [];
  const llm = pick(ctx, 'llm');
  if (llm === undefined) {
    failures.push({ id: 'llm', name: 'ctx.llm', message: 'ctx.llm 服务不可用，无法列举模型目录' });
    return { groups: [], failures };
  }
  if (typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    failures.push({ id: 'llm', name: 'ctx.llm', message: 'ctx.llm 缺少 listProviders/listModels，无法列举模型目录' });
    return { groups: [], failures };
  }
  let providers;
  try {
    providers = await llm.listProviders();
  } catch (error) {
    failures.push({ id: 'llm', name: 'ctx.llm', message: `listProviders 失败：${messageOf(error)}` });
    return { groups: [], failures };
  }
  const groups = [];
  for (const provider of Array.isArray(providers) ? providers : []) {
    const providerId = typeof provider?.id === 'string' ? provider.id : undefined;
    const providerName = typeof provider?.name === 'string' && provider.name !== '' ? provider.name : providerId;
    if (providerId === undefined) {
      failures.push({ id: 'unknown', name: 'unknown', message: 'provider 条目缺少 id，已跳过' });
      continue;
    }
    let models;
    try {
      models = await llm.listModels(providerId);
    } catch (error) {
      failures.push({ id: providerId, name: providerName ?? providerId, message: `listModels 失败：${messageOf(error)}` });
      continue;
    }
    const rows = [];
    for (const model of Array.isArray(models) ? models : []) {
      const modelId = typeof model?.id === 'string' ? model.id : undefined;
      if (modelId === undefined || modelId === '') {
        failures.push({ id: providerId, name: providerName ?? providerId, message: 'model 条目缺少 id，已跳过' });
        continue;
      }
      const modelName = typeof model.name === 'string' && model.name !== '' ? model.name : modelId;
      const row = { id: modelId, name: modelName };
      if (typeof llm.resolveModelInfo === 'function') {
        try {
          const info = await llm.resolveModelInfo(providerId, modelId);
          const reasoning = info?.reasoning;
          const efforts = reasoning?.efforts;
          if (Array.isArray(efforts) && efforts.length > 0) {
            row.reasoning = {
              efforts: efforts
                .filter((effort) => typeof effort?.id === 'string' && effort.id !== '')
                .map((effort) => ({ id: effort.id, name: typeof effort.name === 'string' && effort.name !== '' ? effort.name : effort.id })),
              ...(typeof reasoning.defaultEffort === 'string' && reasoning.defaultEffort !== '' ? { defaultEffort: reasoning.defaultEffort } : {}),
            };
          }
        } catch (error) {
          // 单个模型拿不到元数据不影响目录本身：该模型就是「无思考强度」。
          failures.push({ id: modelId, name: modelName, message: `resolveModelInfo 失败（该模型不显示思考强度）：${messageOf(error)}` });
        }
      }
      rows.push(row);
    }
    if (rows.length > 0) groups.push({ id: providerId, name: providerName ?? providerId, models: rows });
  }
  return { groups, failures };
}

/**
 * 派队员前预检一条路由。
 * 规则（INTERFACES §3）：
 *   * provider/model 必须成对且非空，且能被 `ctx.llm.resolveModelInfo` 解析；解析失败 → ok:false。
 *   * 给了 reasoningEffort 但该模型没有广告这个档位（或压根没有 reasoning 元数据）→ **丢掉该字段**
 *     并记 diagnostics，route 仍可用（ok 保持 true）。理由是官方不做钳制/别名：
 *     显式传不支持的档位会让请求直接抛 UNSUPPORTED_REASONING_EFFORT
 *     （dsh-llm/lib/index.js:2177-2178）。
 *   * ctx.llm 不可用时无法校验：保留 ok:true、丢掉 effort 并记诊断（不能因为校验能力缺失就阻断派队员）。
 * @param ctx - 宿主/preset ctx。
 * @param route - {provider, model, reasoningEffort?} 或 undefined。
 * @returns Promise<{ok:boolean, route:object|undefined, diagnostics:string[]}>。
 */
export async function preflightRoute(ctx, route) {
  const notes = [];
  if (route === undefined || route === null) return { ok: true, route: undefined, diagnostics: notes };
  const provider = typeof route.provider === 'string' ? route.provider.trim() : '';
  const model = typeof route.model === 'string' ? route.model.trim() : '';
  if (provider === '' || model === '') {
    return { ok: false, route, diagnostics: ['provider/model 必须成对且非空'] };
  }
  const clean = { provider, model };
  const requested = typeof route.reasoningEffort === 'string' && route.reasoningEffort !== '' ? route.reasoningEffort : undefined;
  const llm = pick(ctx, 'llm');
  let info;
  if (llm !== undefined && typeof llm.resolveModelInfo === 'function') {
    try {
      info = await llm.resolveModelInfo(provider, model);
    } catch (error) {
      return {
        ok: false,
        route: clean,
        diagnostics: [`无法解析 provider "${provider}" / model "${model}"：${messageOf(error)}`],
      };
    }
  } else {
    notes.push('ctx.llm 不可用：无法校验模型元数据，已丢弃思考强度（不猜、不钳制）');
  }
  if (requested === undefined) return { ok: true, route: clean, diagnostics: notes };
  if (info === undefined) return { ok: true, route: clean, diagnostics: notes };
  const efforts = info?.reasoning?.efforts;
  const advertised = Array.isArray(efforts) ? efforts.some((effort) => effort?.id === requested) : false;
  if (!advertised) {
    notes.push(`模型 ${provider}/${model} 未广告思考强度 "${requested}"，已丢弃该字段`);
    return { ok: true, route: clean, diagnostics: notes };
  }
  clean.reasoningEffort = requested;
  return { ok: true, route: clean, diagnostics: notes };
}

// ── agent 作用域安装 / 卸载 ─────────────────────────────────────────────────

/** 收一个 disposer：同步函数记入账本；不是函数就记诊断（绝不静默）。 */
function keepDisposer(disposers, disposer, label, notes) {
  if (typeof disposer === 'function') {
    disposers.push(disposer);
    return;
  }
  notes.push(`${label}：注册未返回 disposer，卸载时无法回卷`);
}

/** 调用一个 disposer，吞掉的是「清理失败」这个异常本身，但必须记成诊断。 */
function runDisposer(disposer, label) {
  try {
    const result = disposer();
    if (result !== undefined && typeof result?.catch === 'function') {
      result.catch((error) => recordDiagnostic(`${label}：卸载失败 ${messageOf(error)}`));
    }
  } catch (error) {
    recordDiagnostic(`${label}：卸载抛错 ${messageOf(error)}`);
  }
}

/**
 * 注册团队工具到某个 agent 作用域。
 *
 * P0：官方 `dsh-experimental-tool-agent-team` 也在 **agent 作用域**注册同样九个名字 ——
 * 而且它是给**每一个** live agent 都装（`lib/index.js:539-546` 的 maybeInstall + 域服务
 * `tryMembership` 对任意非子代理 agent 返回 lead 身份 `:397-426`）。两层落在**同一个作用域**时
 * dsh-tools 会抛 `tool "x" is already registered in this scope`，本插件的工具就装不上，
 * 角色/模型参数全部丢失（这是**故障**，不是提示 —— 所以进 problems 通道并进页面红色告警）。
 * 因此这里**逐个 try/catch，任何一个失败就回滚本次已注册的全部**，并且绝不向外抛
 * （否则会打掉 agent 创建）。返回是否成功装上了本插件的工具。
 * @param scoped - agent 作用域 ctx（必须有 tools 服务）。
 * @param ctx - 用于取服务/预检的 ctx。
 * @param agentTeams - 官方域服务。
 * @param agent - 调用者/被安装的 agent。
 * @param notes - 诊断累积数组（调用方的；会回给 Lead）。
 * @param disposers - disposer 账本（调用方的）。
 * @param include - 只注册名单内的工具；不传 = 九个全给（Lead 用）。
 * @param problems - 故障累积数组（调用方的；会进页面的红色告警通道）。
 * @returns {ok:boolean, message?:string}
 */
function installTeamTools(scoped, ctx, agentTeams, agent, notes, disposers, include, problems) {
  const fail = (message) => {
    notes.push(message);
    if (Array.isArray(problems) && !problems.includes(message)) problems.push(message);
  };
  if (scoped?.tools === undefined || typeof scoped.tools.register !== 'function') {
    fail('该作用域没有 tools 服务，团队工具未安装');
    return { ok: false, message: '该作用域没有 tools 服务，团队工具未安装' };
  }
  const definitions = teamToolDefinitions({
    runtime: runtimeApi,
    agentTeams,
    agent,
    config: { freshProvider: FRESH_PROVIDER, forkProvider: FORK_PROVIDER },
    ...include === void 0 ? {} : { include },
  });
  const registered = [];
  for (const definition of definitions) {
    try {
      const disposer = scoped.tools.register(definition);
      if (typeof disposer !== 'function') {
        notes.push(`工具 ${definition.name}：注册未返回 disposer，卸载时无法回卷`);
        registered.push(undefined);
        continue;
      }
      registered.push(disposer);
    } catch (error) {
      // 回滚本次已注册的全部，避免留下「装了一半」的工具面。
      for (const rollback of [...registered].reverse()) {
        if (typeof rollback === 'function') runDisposer(rollback, `回滚工具 ${definition.name}`);
      }
      const message = `团队工具注册失败（${definition.name}）：${messageOf(error)}。`
        + '最可能的原因：官方 @deepseek-ai/dsh-experimental-agent-team-profile 的 tool-agent-team 行仍处于启用状态 ——'
        + '它会把同样九个名字装进同一个 agent 作用域，两边不可能共存。'
        + '修法：node tools\\repair.cjs --apply（在 profile 层关掉那一行）后重启 DSH；'
        + '不修的话本会话只能用官方工具，角色与模型/强度参数都不会生效。';
      fail(message);
      return { ok: false, message };
    }
  }
  for (const disposer of registered) disposers.push(disposer);
  return { ok: true };
}

/**
 * 读「该模型是否广告了某档位」，带正向缓存（失败的查询不缓存，下次重试）。
 * 校验点：dsh-llm/lib/index.js:2177-2178 在模型无 reasoning 元数据却收到 reasoningEffort 时
 * 直接抛 UNSUPPORTED_REASONING_EFFORT；:2182 是档位不在广告集合里也抛。
 * @returns Promise<boolean>
 */
async function effortAdvertised(ctx, provider, model, effort) {
  const key = `${provider}\u0000${model}`;
  const cached = advertisedEfforts.get(key);
  if (cached !== undefined) return cached.has(effort);
  const llm = pick(ctx, 'llm');
  if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return false;
  let efforts;
  try {
    const info = await llm.resolveModelInfo(provider, model);
    efforts = info?.reasoning?.efforts;
  } catch (error) {
    recordDiagnostic(`思考强度校验失败（本次不写 effort，下次请求重试）：Provider "${provider}" model "${model}"：${messageOf(error)}`);
    return false;
  }
  const set = new Set(Array.isArray(efforts) ? efforts.filter((item) => typeof item?.id === 'string').map((item) => item.id) : []);
  advertisedEfforts.set(key, set);
  return set.has(effort);
}

/**
 * 在**队员自己的 agent 作用域**上装模型/强度覆盖（核心机制，零改官方包）。
 * 每次请求都重新 resolve（配置中途改了，下一次请求就生效），写法照
 * dsh-agent/lib/types/model-selection.js:61-75；waterfall 分发点 dsh-agent-loop/lib/index.js:1179。
 *
 * P0：`reasoningEffort` **只在模型真的广告该档位时**才写进请求；模型没有 reasoning 元数据、
 * 或档位不在 `reasoning.efforts` 里 → 返回的对象里**根本没有这个键**（不设成 undefined，
 * 因为 spread 出来的 undefined 键会覆盖掉别的语义）。校验结果正向缓存。
 *
 * @param agent - 队员（或 Lead）agent。
 * @param name - 队员名（用于查本次 spawn 的显式路由钉）。
 * @param role - 由队员名推导出的角色 id；undefined 表示不覆盖（与 Lead 一致）。
 * @param ctx - 任一能取到 ctx.llm 的 ctx。
 */
function installRouteOverride(agent, name, role, ctx, notes, disposers) {
  if (role === undefined && !spawnRoutes.has(name) && !spawnEfforts.has(name)) return;
  if (agent?.ctx === undefined || typeof agent.ctx.on !== 'function') {
    notes.push('该 agent 没有可用的 agent.ctx，模型/强度覆盖未安装');
    return;
  }
  const llmCtx = ctx ?? agent.ctx;
  try {
    const disposer = agent.ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next();
      try {
        // 每次请求**实时**解析：显式 spawn 参数（钉子）优先，其次读当前角色配置。
        // 注意：这里曾经把「角色配置解析出来的路由」也钉进 spawnRoutes，导致面板上改成「跟随 Lead」
        // 之后已在跑的队员永远用旧模型（用户 2026-10-01 报的 bug）。现在钉子只由显式参数产生，
        // 角色配置每次请求重读（用户在面板上改完，队员下一次请求就生效）。
        const explicit = spawnRoutes.get(name);
        const roleRoute = explicit === undefined ? resolveRoleRoute(peekConfig(), role) : undefined;
        const route = resolveMemberRoute(explicit, roleRoute, spawnEfforts.get(name));
        if (route === undefined) return resolved;
        const { reasoningEffort: _inherited, ...rest } = resolved ?? {};
        // 只给了强度（没给模型）时：模型用继承了的那份，只换强度。
        const provider = route.provider ?? rest.provider;
        const model = route.model ?? rest.model;
        const override = { ...rest, ...(provider === undefined ? {} : { provider }), ...(model === undefined ? {} : { model }) };
        if (route.reasoningEffort !== undefined && (await effortAdvertised(llmCtx, provider, model, route.reasoningEffort))) {
          override.reasoningEffort = route.reasoningEffort;
        }
        return override;
      } catch (error) {
        // 覆盖逻辑本身出错时退回未改动的请求配置：宁可少一个覆盖，也不能让队员的请求失败。
        recordDiagnostic(`模型/强度覆盖失败（本次请求使用原配置）：${messageOf(error)}`);
        return resolved;
      }
    });
    keepDisposer(disposers, disposer, `角色 ${role ?? name} 的模型/强度覆盖`, notes);
  } catch (error) {
    notes.push(`注册角色 ${role ?? name} 的模型/强度覆盖失败：${messageOf(error)}`);
  }
}

/**
 * 钉住**本次 spawn 显式给出**的路由（队员名 → 路由）；显式给 undefined 表示清掉旧钉。
 * 由 lib/tools.js 的 spawn_teammate 在 spawn 前调用、spawn 失败时清掉。
 *
 * 注意：只许钉「工具调用里显式写的 provider/model/reasoning_effort」：
 * 角色配置解析出来的路由**不能**钉（钉了就再也不会跟着面板走 —— 2026-10-01 的 bug）。
 * 现在分成两个账本：`spawnRoutes`（显式 provider/model）与 `spawnEfforts`（显式强度），
 * 后者可以单独存在（只覆盖思考强度、模型仍跟随 Lead 或角色配置）。
 *
 * @param name - 队员名。
 * @param route - `{provider?, model?, reasoningEffort?}` 或 undefined（= 清掉该队员的两个钉子）。
 */
export function pinSpawnRoute(name, route) {
  if (typeof name !== 'string' || name === '') return;
  if (route === undefined || route === null) {
    spawnRoutes.delete(name);
    spawnEfforts.delete(name);
    return;
  }
  const hasRoute = typeof route.provider === 'string' && route.provider !== '' && typeof route.model === 'string' && route.model !== '';
  if (hasRoute) spawnRoutes.set(name, { provider: route.provider, model: route.model });
  else spawnRoutes.delete(name);
  if (typeof route.reasoningEffort === 'string' && route.reasoningEffort !== '') spawnEfforts.set(name, route.reasoningEffort);
  else spawnEfforts.delete(name);
}

/** 取官方槽位 order；拿不到（官方改了槽位名/没这个槽位）时退回常量，绝不因为一个排序值放弃遮蔽。 */
function sectionOrderOf(scoped, orderKey, fallbackOrder) {
  try {
    if (typeof scoped?.systemPrompt?.getSectionOrder === 'function') {
      const order = scoped.systemPrompt.getSectionOrder(orderKey);
      if (Number.isFinite(order)) return order;
    }
  } catch (error) {
    recordDiagnostic(`读取官方槽位 ${orderKey} 的 order 失败（退回 ${fallbackOrder}）：${messageOf(error)}`);
  }
  return fallbackOrder;
}

/**
 * 在队员作用域里把「它已经拿不到的工具」的用法段清空。
 *
 * 为什么必须有这一步：`tools.restrict` 只过滤**工具 schema**，而「工具怎么用」是各工具行
 * 自己用 `systemPrompt.section` 注册的**独立**提示词段。工具摘了、段还在，系统提示词就会
 * 教队员调用一个它没有的工具——既浪费 token（每个队员都白读一遍），又会诱发注定失败的调用。
 *
 * 做法是**同名遮蔽**：在队员自己的作用域里注册同名段、文本为空。`dsh-system-prompt` 的
 * `merge` 取作用域链上最近的同名段，而 `renderPrompt` 会丢掉渲染后为空的段
 * （dsh-system-prompt/lib/index.js:114 `filter(text => text.length > 0)`），所以祖先那份
 * 文本被真正压掉，不会在成品提示词里留下一个空行。
 *
 * 段名不在上游时（用户关掉了对应 preset 行）只是多注册一个空段，依然被丢弃 → 无害，
 * 因此这里不需要逐项 try/catch，但仍然逐项包一层以免一处异常带走整张队员卡。
 */
function muteToolSections(scoped, notes, disposers) {
  for (const mute of TEAMMATE_SECTION_MUTES) {
    const order = sectionOrderOf(scoped, mute.orderKey, mute.fallbackOrder ?? MUTE_FALLBACK_ORDER);
    try {
      keepDisposer(
        disposers,
        scoped.systemPrompt.section({ name: mute.name, order, text: '' }),
        `${mute.name} 清空段`,
        notes,
      );
    } catch (error) {
      notes.push(`清空 ${mute.name} 段失败（队员仍会看到它的用法说明）：${messageOf(error)}`);
    }
  }
}

/**
 * 在队员作用域里摘掉它不该有的工具（目标 / 子代理 / Lead 专属开关）。
 *
 * 依据：`ctx.tools.restrict({ deny })`（dsh-tools 的 `restrict(filter)`）过滤的是**继承面**
 * ——全局层 + 作用域链上的祖先层，也就是 preset 行的贡献；本作用域自己注册的不受影响。
 * 这正是官方为「per-child capability filter」留的口子（`view()` 的注释原话），
 * 也是官方 `applyChildComposition` 给子代理装 `toolFilter` 用的同一个 API。
 *
 * 注意：逐名调用而不是一次性传整张名单，因为 `restrict` 对**不存在的名字会抛错**
 * （`names unknown global tool ...`）而不是忽略。逐个调用 + try/catch 后：用户关掉某个
 * preset 行时我们只是少摘一个，绝不会因为一个名字消失就让队员建不出来。
 * 多条 restriction 是**取交集**的，所以逐个调用与一次性调用语义等价。
 *
 * @returns 摘掉的名字（供返回值/状态文件展示）。
 */
function restrictTeammateTools(scoped, notes, disposers) {
  const removed = [];
  if (scoped?.tools === undefined || typeof scoped.tools.restrict !== 'function') {
    notes.push('该作用域没有 tools.restrict，队员仍会拿到 goal/子代理工具');
    return removed;
  }
  for (const name of TEAMMATE_TOOL_DENY) {
    try {
      const disposer = scoped.tools.restrict({ deny: [name] });
      if (typeof disposer === 'function') disposers.push(disposer);
      else notes.push(`摘掉工具 ${name}：restrict 未返回 disposer，卸载时无法回卷`);
      removed.push(name);
    } catch (error) {
      // 最常见的「失败」其实是正常情况：该 preset 根本没有这个工具。
      notes.push(`未摘掉工具 ${name}（该名字不在继承面里，通常是这个 preset 没有它）：${messageOf(error)}`);
    }
  }
  return removed;
}

/** 在 Lead 的 agent 作用域上装团队协作策略段 + 团队工具。 */
function installRoot(ctx, agent, agentTeams) {
  const notes = [];
  const disposers = [];
  const scoped = agent.ctx;
  // 会话记忆：装一次就算「这个会话还在用团队」，刷新 TTL（记录不存在时是空操作）。
  touchSessionMemory(sessionIdOf(agent));
  if (scoped?.systemPrompt !== undefined && typeof scoped.systemPrompt.section === 'function') {
    try {
      keepDisposer(
        disposers,
        scoped.systemPrompt.section({ name: 'dispatch:team-policy', order: TEAM_POLICY_ORDER, text: TEAM_POLICY }),
        'dispatch:team-policy 段',
        notes,
      );
    } catch (error) {
      notes.push(`注册 dispatch:team-policy 段失败：${messageOf(error)}`);
    }
  } else {
    notes.push('该作用域没有 systemPrompt 服务，团队策略段未安装');
  }
  const problems = [];
  const tools = installTeamTools(scoped, ctx, agentTeams, agent, notes, disposers, LEAD_TEAM_TOOL_NAMES, problems);
  // Lead 自己的名字是 "lead"，deriveRole 推不出角色 → 天然不覆盖（保持与「默认 = 与 Lead 相同」一致）。
  installRouteOverride(agent, 'lead', deriveRole('lead'), ctx, notes, disposers);
  state.installed.set(agent.id, { ownerId: agent.id, role: undefined, name: 'lead', disposers, diagnostics: notes });
  // 安装过程记录走**信息通道**：它描述「装了什么/哪一步没装成」，是给 Lead 看的操作回执
  // （完整清单仍随返回值回给调用方），不是「配置文件可能有问题」那种用户要处理的故障。
  // 规则：故障通道只放「宿主/配置/注册真的坏了」且要用户在这个页面上处理的事。
  // 例外：`problems` 里的条目是**真的装不上**（例如官方团队行占住了同名工具的 agent 作用域），
  // 那属于要用户动手的事（跑 repair.cjs --apply + 重启），所以进红色通道。
  for (const problem of problems) recordDiagnostic(`Lead ${agent.id}：${problem}`);
  for (const note of notes) if (!problems.includes(note)) recordNote(`Lead ${agent.id}：${note}`);
  return { toolsOk: tools.ok, toolsMessage: tools.message, notes };
}

/**
 * 在队员的 agent 作用域上装：
 *   1. **共享的**队员卡（所有队员逐字节相同 → 提示词前缀可共用缓存，见 lib/playbook.js）；
 *   2. 遮蔽 Lead 方法论的 `dispatch:playbook` 段；
 *   3. 清空它拿不到的工具的用法段；
 *   4. 摘掉它不该有的工具（目标 / 子代理 / Lead 专属开关）；
 *   5. **队员子集**的团队工具；
 *   6. 模型/强度覆盖。
 *
 * 注意 1–5 全部与角色无关：角色差异只走 Lead 的派活提示词（lib/playbook.js 的 teammateBrief）。
 * 任何「按角色分叉」的改动都会把队员的共享前缀切碎，直接打掉缓存命中率。
 */
function installMember(owner, agent, name, ctx, agentTeams) {
  const notes = [];
  const disposers = [];
  const scoped = agent.ctx;
  const role = deriveRole(name);
  if (scoped?.systemPrompt !== undefined && typeof scoped.systemPrompt.section === 'function') {
    try {
      keepDisposer(
        disposers,
        scoped.systemPrompt.section({ name: 'dispatch:teammate-card', order: TEAMMATE_CARD_ORDER, text: TEAMMATE_CARD }),
        'dispatch:teammate-card 段',
        notes,
      );
    } catch (error) {
      notes.push(`注册队员卡失败：${messageOf(error)}`);
    }
    // 遮蔽 preset 层（Lead 可见）的 dispatch:playbook 段：同名段在更深的作用域里覆盖它。
    // 官方语义是「同层同名重复才抛错」，跨作用域同名是遮蔽（dsh-system-prompt/lib/index.js:232-243）。
    // 万一这里抛错，只是队员仍能看到 Lead 方法论段，不影响团队可用性。
    try {
      keepDisposer(
        disposers,
        scoped.systemPrompt.section({ name: PLAYBOOK_SECTION, order: 1, text: '' }),
        `${PLAYBOOK_SECTION} 遮蔽段`,
        notes,
      );
    } catch (error) {
      notes.push(`遮蔽 ${PLAYBOOK_SECTION} 段失败（队员仍能看到 Lead 方法论段）：${messageOf(error)}`);
    }
    muteToolSections(scoped, notes, disposers);
  } else {
    notes.push('该作用域没有 systemPrompt 服务，队员卡未安装');
  }
  const restricted = restrictTeammateTools(scoped, notes, disposers);
  const problems = [];
  const tools = installTeamTools(scoped, ctx, agentTeams, agent, notes, disposers, MEMBER_TEAM_TOOL_NAMES, problems);
  installRouteOverride(agent, name, role, ctx, notes, disposers);
  if (role === undefined) notes.push(`队员名 "${name}" 推不出角色 id，模型/强度覆盖未安装（保持与 Lead 一致）`);
  state.installed.set(agent.id, { ownerId: owner.id, role, name, disposers, diagnostics: notes, restricted });
  // 同 installRoot：装队员的记录是操作回执，走信息通道；`problems` 里的（装不上）走故障通道。
  for (const problem of problems) recordDiagnostic(`队员 ${agent.id}（${name}）：${problem}`);
  for (const note of notes) if (!problems.includes(note)) recordNote(`队员 ${agent.id}（${name}）：${note}`);
  notifyKeepalive();
  return { toolsOk: tools.ok, toolsMessage: tools.message, notes };
}

/** 卸载某个 agent 作用域上的全部注册（含清掉该队员的显式路由钉）。 */
function disposeInstalled(agentId) {
  const entry = state.installed.get(agentId);
  if (entry === undefined) return false;
  state.installed.delete(agentId);
  truncatedMembers.delete(agentId);
  if (typeof entry.name === 'string' && entry.name !== 'lead') {
    spawnRoutes.delete(entry.name);
    spawnEfforts.delete(entry.name);
  }
  for (const disposer of [...entry.disposers].reverse()) runDisposer(disposer, entry.role === undefined ? `agent ${agentId}` : `队员 ${agentId}`);
  if (entry.name === 'lead' && keepaliveLead === agentId) detachKeepalive('lead-disposed');
  return true;
}

/** 按 agent 的团队身份补齐安装（幂等）。返回 {handled, toolsOk, toolsMessage}。 */
function syncAgent(ctx, agent, agentTeams) {
  const membership = safeMembership(agentTeams, agent);
  const agentId = agentIdOf(agent);
  if (agentId === undefined) return { handled: false };
  if (membership !== undefined && membership.role === 'teammate') {
    const ownerId = agentIdOf(membership.root);
    if (ownerId === undefined || !state.roots.has(ownerId)) return { handled: false };
    const existing = state.installed.get(agentId);
    if (existing !== undefined) return { handled: true, toolsOk: true };
    const result = installMember(membership.root, agent, membership.name, ctx, agentTeams);
    return { handled: true, toolsOk: result.toolsOk, toolsMessage: result.toolsMessage };
  }
  if (state.roots.has(agentId)) {
    if (state.installed.has(agentId)) return { handled: true, toolsOk: true };
    const result = installRoot(ctx, agent, agentTeams);
    return { handled: true, toolsOk: result.toolsOk, toolsMessage: result.toolsMessage };
  }
  // 会话记忆恢复：宿主重启后 state.roots 是空的，靠 lib/resume.js 的按会话记录把团队装回来。
  // `membership === undefined`（域服务还没认这个 agent）也走这条路：恢复的判据是**会话记录**，
  // 不是域服务当下的回答；装之前照样过 preset 边界。
  const restored = restoreRemembered(ctx, agent, agentTeams);
  if (restored !== undefined) return restored;
  if (membership === undefined) return { handled: false };
  return { handled: true, toolsOk: true };
}

/**
 * 记下「这个会话开着团队」（会话级记忆）。任何失败都只记**故障**诊断：写不进去意味着
 * 下次宿主重启本会话会掉团队工具（2026-10-01 现场就是这么坏的），用户需要知道。
 * @param agent - 被开启团队的 Lead。
 * @param source - 'command' | 'tool' | 'boot' 等，仅作可读备注。
 */
function rememberSession(agent, source) {
  const sessionId = sessionIdOf(agent);
  if (sessionId === undefined) return;
  const outcome = markEnabled(sessionId, { source });
  if (outcome.ok !== true) {
    recordDiagnostic(`会话 ${sessionId} 的团队开关记忆写入失败：宿主重启后本会话不会自动恢复团队工具（团队本次已开启）`);
  }
}

/** 刷新某会话的最后使用时间（TTL 用）；失败只记诊断。 */
function touchSessionMemory(sessionId) {
  if (sessionId === undefined) return;
  const outcome = touchSession(sessionId);
  if (outcome.ok !== true) recordDiagnostic(`会话 ${sessionId} 的团队开关记忆刷新失败（记录会在 TTL 到期后被清掉）`);
}

/** 忘掉一个会话的团队记录（用户显式关团）。 */
function forgetSession(sessionId) {
  if (sessionId === undefined) return;
  const outcome = markDisabled(sessionId);
  if (outcome.ok !== true) recordDiagnostic(`会话 ${sessionId} 的团队开关记忆删除失败：下次宿主重启它可能又自动开团`);
}

/**
 * 宿主重启后按会话记忆恢复团队：只有「记录在案 + 当前 preset 仍是调度模式 + 不是队员」三条同时成立才装。
 *
 * 为什么必须在这里（而不是只在 reconcileAgents）：`agent/created` 是 serial 分发、首个 turn 在它之后
 * 才投递（dsh-agent/lib/index.js:499-521、dsh-agent-loop/lib/index.js:1748-1752 先 `sessions.enter`/
 * `agents.enter` 再 `announce`）。同步恢复就能让恢复后的**第一个** request header 里就带上团队工具 ——
 * 否则用户会先在会话里看到一行「移除：spawn_teammate, team_task_create, …」再看到它们回来。
 *
 * @param ctx - 宿主/preset ctx。
 * @param agent - 刚创建的 agent。
 * @param agentTeams - 官方域服务。
 * @returns {{handled:true, restored:true, toolsOk:boolean, toolsMessage?:string}|undefined} 未恢复时 undefined。
 */
function restoreRemembered(ctx, agent, agentTeams) {
  const sessionId = sessionIdOf(agent);
  if (sessionId === undefined) return undefined;
  if (!isEnabledSession(sessionId)) return undefined;
  const agentId = agentIdOf(agent);
  if (agentId === undefined) return undefined;
  const membership = safeMembership(agentTeams, agent);
  if (membership !== undefined && membership.role === 'teammate') return undefined;
  const boundary = assertDispatchPreset(ctx, agent);
  if (boundary.allowed !== true) {
    recordNote(`会话 ${sessionId} 有团队记录，但当前 preset 是 "${String(boundary.presetId)}"：不恢复（记录保留，切回调度模式再恢复）`);
    return undefined;
  }
  state.roots.add(agentId);
  state.sessionsRestored += 1;
  let result;
  try {
    result = installRoot(ctx, agent, agentTeams);
  } catch (error) {
    recordDiagnostic(`按会话记录恢复团队时安装失败（已吞掉，团队处于降级状态）：${messageOf(error)}`);
    result = { toolsOk: false, toolsMessage: '安装过程抛错，已吞掉' };
  }
  attachKeepalive(agent);
  recordNote(`团队已按会话记录恢复开启（Lead ${agentId}，session ${sessionId}）`);
  return { handled: true, restored: true, toolsOk: result.toolsOk, ...(result.toolsMessage === undefined ? {} : { toolsMessage: result.toolsMessage }) };
}

/**
 * 记一次 turn 结束：只有「撞输出上限」进账本，任何一次正常收尾/中止/报错都清掉它。
 *
 * 这是截断标志的**唯一写入点**：session/event 的 turn/end 监听器与集成测试都走这里，
 * 被测的就是生产路径本身，而不是为测试另造的假入口。
 * 官方语义：dsh-agent-loop/lib/index.js:1151 产生 max-tokens、:979 turn 内聚合、
 * :1027-1030 以 append("turn/end", { turn, reason }) 落事件。
 * @param agentId - 结束 turn 的 agent id（= session id）。
 * @param kind - turn/end 的 reason.kind。
 */
export function noteTurnEndReason(agentId, kind) {
  if (typeof agentId !== 'string' || agentId === '') return;
  if (kind === 'max-tokens') truncatedMembers.add(agentId);
  else truncatedMembers.delete(agentId);
}

/**
 * 当前被判定「上一轮撞了输出上限且未交付」的队员 agent id 快照（list_agents 用它标注）。
 * @returns 新的 Set，调用方改不到内部账本。
 */
export function truncatedMemberIds() {
  return new Set(truncatedMembers);
}

/** 会话级记忆的只读快照（状态文件/排查用）。 */
export function sessionMemory() {
  const stats = sessionMemoryStats();
  return { ...stats, restoredThisProcess: state.sessionsRestored };
}

/**
 * 在宿主 ctx 上订阅 agent 生命周期（幂等）。
 * 必须在**同步**回调里安装：agent/created 是 serial 分发（dsh-agent/lib/index.js:572-588），
 * 首个 turn 在 materialize 返回之后才投递，所以同步安装不会与首次请求竞态。
 * @param ctx - 宿主 ctx。
 */
export function watchAgents(ctx) {
  if (state.watch !== undefined) return;
  // 订阅必须落在**全局** ctx 上：agent/created 是按 scope carrier 过滤分发的，
  // 若把监听器挂在某个 agent 作用域上，它只会收到那个 agent 的事件。
  // Cordis 的 `ctx.root` 是根上下文（cordis/lib/index.js:1681，子上下文原型继承这个属性），
  // 因此 enable() 从 agent 作用域被调用时也能拿到全局订阅点。拿不到 root 就退回传入的 ctx。
  const target = (ctx !== undefined && ctx !== null && ctx.root !== undefined && ctx.root !== null) ? ctx.root : ctx;
  const disposers = [];
  try {
    disposers.push(
      target.on('agent/created', ({ agent } = {}) => {
        // 整个回调包 try/catch：这里抛出去会让 agent 创建失败（agent/created 是 serial 分发）。
        try {
          syncAgent(target, agent, agentTeamsOf(target));
        } catch (error) {
          recordDiagnostic(`agent/created 处理失败（已吞掉以避免打掉 agent 创建）：${messageOf(error)}`);
        }
      }),
    );
  } catch (error) {
    recordDiagnostic(`订阅 agent/created 失败：${messageOf(error)}`);
  }
  try {
    disposers.push(
      target.on('agent/disposed', ({ agent } = {}) => {
        try {
          const agentId = agentIdOf(agent);
          if (agentId === undefined) return;
          if (state.roots.has(agentId)) state.roots.delete(agentId);
          if (state.installed.has(agentId)) disposeInstalled(agentId);
        } catch (error) {
          recordDiagnostic(`agent/disposed 处理失败：${messageOf(error)}`);
        }
      }),
    );
  } catch (error) {
    recordDiagnostic(`订阅 agent/disposed 失败：${messageOf(error)}`);
  }
  try {
    disposers.push(
      target.on('session/event', (session, event) => {
        // 只记本插件已安装的队员；整个回调不许抛（它在每一次会话事件的路径上）。
        try {
          if (session === undefined || session === null || event === undefined || event === null) return;
          const agentId = typeof session.id === 'string' ? session.id : undefined;
          if (agentId === undefined) return;
          const entry = state.installed.get(agentId);
          // 只关心队员：Lead 那一条记录 name 恒为 'lead'（installRoot），队员恒为队员名。
          if (entry === undefined || entry.name === undefined || entry.name === 'lead') return;
          // llm/retry：**只观测，不改变任何行为**（2026-10-05 审查 §1-⑥）。
          // 宿主本来就在自动退避（dsh-llm 的 maxRetries=5 / 500ms 起 / 1e4 上限 / 抖动 .1，
          // 可重试码含 RATE_LIMIT），插件要做的是**让 Lead 看得见**它发生过——
          // 否则「被限流打死的队员」与「干完没交报告的队员」在状态面上长得一模一样。
          // 注意：审查报告明确列了「不该借参照的退避重排队」：本地队员是常驻 continuable 会话，
          // 重排队要么杀会话（丢掉「返工回同一个队员」这条纪律），要么挂着继续占名额。
          // 参照自己那份「开启前 4 条实机确认」里还有 2 条本地未验证 ⇒ 未确认前只做观测。
          if (event.type === 'llm/retry') {
            noteRetryEvent(agentId, event?.data);
            return;
          }
          // 新一轮开始 = 上一条重试记录作废。参照的采集内核特意点过这个细节
          //（src/rate-limit-signal.ts 的「不跨轮沿用旧码」）：一个十分钟前被限流、
          // 现在跑得好好的队员，不该继续挂着那条旧码——那会让 Lead 误判它还在挨限流。
          if (event.type === 'turn/start') {
            clearRetryEvent(agentId);
            return;
          }
          if (event.type !== 'turn/end') return;
          noteTurnEndReason(agentId, event?.data?.reason?.kind);
        } catch (error) {
          recordDiagnostic(`session/event 记账失败（已吞掉）：${messageOf(error)}`);
        }
      }),
    );
  } catch (error) {
    recordDiagnostic(`订阅 session/event 失败（截断标志不可用，团队功能不受影响）：${messageOf(error)}`);
  }
  state.watch = disposers;
}

/**
 * 按当前已开启的 root 记账，给所有活体 agent 补齐安装（幂等）。
 * 由 lib/index.js 在宿主启动时调用；启动瞬间通常还没有 root 被开启（团队默认关闭、
 * 开启状态不跨重启持久化），所以它是「冷恢复 + 补装」的统一入口，而不是持久化开关。
 * @param ctx - 宿主 ctx。
 * @returns 每个 agent 的处理结果（供日志/排查）。
 */
export function reconcileAgents(ctx) {
  const agentTeams = agentTeamsOf(ctx);
  const results = [];
  for (const candidate of liveAgents(ctx)) {
    try {
      const result = syncAgent(ctx, candidate, agentTeams);
      if (result.handled === true) results.push({ agentId: agentIdOf(candidate), ...result });
    } catch (error) {
      recordDiagnostic(`补装 agent ${agentIdOf(candidate) ?? '?'} 失败（已吞掉）：${messageOf(error)}`);
    }
  }
  return results;
}

// ── 工作区画布（lib/graph.js 的接线）────────────────────────────────────────

/**
 * 找到某个会话所属团队的 Lead agent。
 * 官方成员面板在**队员会话**里也会显示（openTeammate 用 parentSessionId 回到 Lead），
 * 所以画布的入口同样必须从队员会话打得开：先按 sessionId 找活体 agent，
 * 再用域服务的 membership.root 回到 Lead；找不到就退回「这个会话自己就是 Lead」。
 * @param ctx - 宿主 ctx。
 * @param sessionId - 客户端报来的会话 id（可能带 session- 前缀，也可能不带）。
 * @returns {Promise<{ok:boolean, lead?:object, error?:string}>}
 */
export async function leadForSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, error: '缺少 sessionId' };
  const agentTeams = agentTeamsOf(ctx);
  const bare = normSessionId(sessionId);
  let self;
  for (const agent of liveAgents(ctx)) {
    const id = normSessionId(agentIdOf(agent) ?? '');
    const sid = normSessionId(sessionIdOf(agent) ?? '');
    if (id === bare || sid === bare) { self = agent; break; }
  }
  if (self === undefined) {
    // ── 团队已结束（额度耗尽 / 会话中断）时的兜底 ────────────────────────────
    //
    // 用户 2026-10-08 报的 #5（原话）：「我的额度没有了，对话断了，这很正常，
    // 但是工作区为啥看不了了？」截图错误：「找不到会话 ca6e6ecd-… 对应的活动 agent」。
    //
    // 根因：额度耗尽后**队员 agent 全部销毁**，而用户是在**队员会话**里打开工作区的
    // （官方成员面板在队员会话里也显示），于是 liveAgents 里找不到这个会话 → 直接失败 →
    // 画布整页打不开。可历史事实全在日志里，画布完全可以按「历史快照」画出来。
    //
    // 判据：读该会话日志的 `session` 头，取 `parentSession`（队员 → 父会话）；
    // 若父会话本身也是某人的子会话就继续向上（有界 8 层，防环）。
    // 拿到的顶层 id 就是 Lead 会话 id —— 用它合成一个**只带 session 的假 agent**：
    // 统计与成员名单都从日志折出来（lib/graph.js 的持久路径），不需要任何活体 agent。
    const recovered = await recoverEndedTeam(ctx, sessionId, bare);
    if (recovered !== undefined) return recovered;
    if (state.roots.has(sessionId) || state.roots.has(bare) || state.roots.has(`session-${bare}`)) {
      return { ok: false, error: '该会话的 Lead 当前没有活体 agent（团队可能已结束）' };
    }
    return { ok: false, error: `找不到会话 ${sessionId} 对应的活动 agent（团队未开启或已切换会话）` };
  }
  if (agentTeams === undefined) return { ok: true, lead: self };
  const membership = safeMembership(agentTeams, self);
  if (membership !== undefined && membership.root !== undefined && membership.root !== null) {
    return { ok: true, lead: membership.root };
  }
  return { ok: true, lead: self };
}

/** 从日志恢复已结束团队的顶层会话 id 时，向上追溯的最大层数（防环/防坏数据）。 */
const RECOVER_MAX_DEPTH = 8;

/**
 * 团队已结束时的兜底：沿 `parentSession` 找到顶层（Lead）会话，合成一个「只读历史」的 Lead agent。
 *
 * 返回的 agent 带 `session: undefined`（没有活体会话）与一个 `historyOnly: true` 标记，
 * 让上层（collectGraph）知道「这是从日志恢复的历史快照」而不是活体团队。
 *
 * ⚠️ 合成的 agent **绝对不能**带 `session`：`statsForSession` 见 `session != null` 就走
 * **活体增量**路径，而假 session 折不到任何事件 → 持久路径被短路 → 全部统计变 0
 * （实测：给假 session 后只剩 lead 一个节点、全 0；不给则是 4 节点 30166059 token）。
 *
 * 三条恢复路径（缺一条就会让某类用户打不开工作区，均已用真实日志验证）：
 *   ① 队员会话 → 沿 header.parentSession 上溯到 Lead；
 *   ② id 前缀双试：队员目录是**裸 uuid**、Lead 目录**带 session- 前缀**，
 *      真实目录里 `session-ca6e6ecd-…` 并不存在 → 原样 open 会失败（实测）；
 *   ③ **Lead 自己的会话**（没有 parentSession）→ 用官方持久投影缓存判「这是不是某个团队的 Lead」，
 *      否则「在 Lead 会话里点进入工作区」这条常规路径在额度耗尽后仍然报错（实测）。
 * @param ctx - 宿主 ctx。
 * @param sessionId - 原始会话 id（可能带 session- 前缀）。
 * @param {string} bare - 去掉前缀的 id。
 * @returns {Promise<{ok:true, lead:object, historyOnly:true}|undefined>} 恢复失败返回 undefined。
 */
async function recoverEndedTeam(ctx, sessionId, bare) {
  const persistence = pick(ctx, 'sessionPersistence');
  if (persistence === undefined || persistence === null || typeof persistence.open !== 'function') return undefined;
  let current = sessionId;
  let moved = false;
  for (let depth = 0; depth < RECOVER_MAX_DEPTH; depth += 1) {
    const parent = await readParentSession(persistence, current);
    if (typeof parent !== 'string' || parent === '') {
      // 没有父会话了：current 就是顶层。
      // 若第一轮就没有 parent（depth === 0 且没上溯过），说明请求的**就是 Lead 会话**本身
      // —— 还要确认它真的是某个团队的 Lead（见 ③），否则会把「一个普通会话」当成团队。
      break;
    }
    if (normSessionId(parent) === normSessionId(current)) break;   // 自环
    current = parent;
    moved = true;
  }
  const rootBare = normSessionId(current);
  if (rootBare === '') return undefined;
  if (!moved) {
    // 没上溯过：请求的就是顶层会话。只有它确实是某个团队的 Lead 才恢复。
    if (bare === rootBare && !(await isTeamLeadSession(ctx, persistence, current))) return undefined;
  }
  // 合成 agent：没有活体 session（session 留 undefined），collectGraph 会全走持久路径。
  return { ok: true, lead: { id: current, historyOnly: true }, historyOnly: true };
}

/**
 * 判断一个**顶层会话**（没有 parentSession）是不是某个团队的 Lead 会话。
 *
 * 判据：官方持久投影缓存里的 `agentTeam` 视图有 **>1 个成员**（lead + 至少一个队员）。
 * 为什么不用「有 agentTeam 行」当判据：实测 213 份缓存记录里只有 9 份 `members` 非空，
 * 其余是空行 —— 用「有行」会把普通会话误判成团队。
 * 为什么读缓存而不是折日志：官方把成员与任务都投影在 `agentTeam` 里（一次拿到两样），
 * 且与官方面板读的是同一份权威数据。
 * @param ctx - 宿主 ctx。
 * @param {object} persistence - sessionPersistence 服务。
 * @param {string} sessionId - 顶层会话 id。
 * @returns {Promise<boolean>}
 */
async function isTeamLeadSession(ctx, persistence, sessionId) {
  const cache = pick(ctx, 'sessionProjectionCache');
  if (cache === undefined || cache === null || typeof cache.cachedSnapshot !== 'function') return false;
  try {
    const handle = await openWithPrefixFallback(persistence, sessionId);
    if (handle === undefined) return false;
    try {
      // cachedSnapshot 的 meta 参数是**存储头**（不是 session 对象）。
      const snapshot = cache.cachedSnapshot(handle.header, ['agentTeam']);
      const members = snapshot?.values?.agentTeam?.members;
      return Array.isArray(members) && members.length > 1;
    } finally {
      if (typeof handle.close === 'function') await handle.close();
    }
  } catch {
    return false;
  }
}

/**
 * 打开一个会话句柄，**id 前缀双试**。
 *
 * 为什么必须双试（实测 2026-10-08）：持久层按目录名**精确匹配**，而真实目录里
 * 队员是裸 uuid（`ca6e6ecd-…`）、Lead 带前缀（`session-898e4c64-…`）。
 * 客户端报上来的 id 可能带也可能不带前缀，只试一种就会有一半路径 open 失败。
 * @param {object} persistence - sessionPersistence 服务。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<object|undefined>} handle 或 undefined。
 */
async function openWithPrefixFallback(persistence, sessionId) {
  const bare = normSessionId(sessionId);
  const candidates = [sessionId];
  if (bare !== sessionId) candidates.push(bare);
  else candidates.push(`session-${bare}`);
  for (const id of candidates) {
    if (typeof id !== 'string' || id === '') continue;
    try {
      return await persistence.open(id, 'read', {});
    } catch {
      /* 试下一种写法 */
    }
  }
  return undefined;
}

/**
 * 读一个会话日志的 `parentSession`（没有则空串）。
 *
 * ⚠️ **必须读 `handle.header`，不能扫 `handle.read()` 的 events**。
 * 实测证据链（2026-10-08）：
 *   * 会话日志是 jsonl，`session` 头就是**第 1 行**
 *     （`{"type":"session","version":4,"id":"ca6e6ecd-…","parentSession":"session-898e4c64-…",…}`）；
 *   * 官方 jsonl 后端 `scanLog(buffer)` 把第 1 行解析成 `meta`，events 只从第 2 行开始
 *     （dsh-session-persistence-jsonl/lib/index.js:2801，随后 :2825 `const { events, ...rest } = parsed`
 *      把 meta 剥掉）；
 *   * `handle.read()` 只返回 `{ eventState, events }`（同文件 :62-92）。
 * 所以「在 events 里找 type==='session'」**一次都命中不了** —— 我第一版就是这么写的，
 * 恢复功能静默失效（这个错误只有用真后端跑才能发现，纯读代码看不出来）。
 * 官方自己也读 header：dsh-experimental-agent-team 的 readPersistedSession 返回 `header: handle.header`。
 * @param {object} persistence - sessionPersistence 服务。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<string>} 父会话 id 或空串。
 */
async function readParentSession(persistence, sessionId) {
  const handle = await openWithPrefixFallback(persistence, sessionId);
  if (handle === undefined) return '';
  try {
    // 权威位置：header。同时兜住「header 缺失但 events 里真有」的其它后端实现。
    const fromHeader = handle.header?.parentSession;
    if (typeof fromHeader === 'string' && fromHeader !== '') return fromHeader;
    const { events } = await handle.read(0, void 0, {});
    if (!Array.isArray(events)) return '';
    for (const event of events.slice(0, 40)) {
      if (event?.type !== 'session') continue;
      const parent = event.parentSession ?? event.data?.parentSession;
      if (typeof parent === 'string' && parent !== '') return parent;
    }
    return '';
  } catch {
    return '';
  } finally {
    if (typeof handle.close === 'function') await handle.close();
  }
}

/**
 * 采集团队画布图（工作区页的唯一数据源）。
 * @param ctx - 宿主 ctx。
 * @param sessionId - 发起会话 id（Lead 或任一队员）。
 * @returns {Promise<object>} {ok:true, graph, leadSessionId} 或 {ok:false, error}。
 */
export async function teamGraph(ctx, sessionId) {
  const found = await leadForSession(ctx, sessionId);
  if (found.ok !== true) return found;
  const agentTeams = agentTeamsOf(ctx);
  // 历史快照（团队已结束、从日志恢复）：此时**允许域服务缺席** ——
  // 成员与任务都从持久投影缓存/日志恢复（collectGraph 的兜底路径），
  // 拿不到域服务不该让用户看不到历史拓扑。
  if (agentTeams === undefined && found.historyOnly !== true) {
    return { ok: false, error: '官方 Agent Teams 域服务不可用（agent-team 行被禁用？）' };
  }
  // 历史快照：isEnabled 查的是活体 agent 的账，这里没有活体，所以跳过这道闸门 ——
  // 能恢复出 parentSession / 投影缓存里有成员，本身就证明「这个会话属于某个团队」。
  if (found.historyOnly !== true && !isEnabled(found.lead)) {
    return { ok: false, error: '该会话还没有开启团队：先用 /team 开启，再进入工作区。', notEnabled: true };
  }
  return collectGraph({ ctx, agentTeams, leadAgent: found.lead, isTeamEnabled: isEnabled });
}

/**
 * 团队已结束时恢复成员 id 列表（给 `teamConversation` 的白名单用）。
 *
 * 两条来源，先缓存后日志：
 *   ① 官方持久投影缓存的 `agentTeam.members`（一次拿到权威成员名单）；
 *   ② 退回折 Lead 会话日志里的 `team/member` 事件（缓存不可用时）。
 * 拿不到就返回空数组 —— 调用方据此按原错误失败（**不放开**白名单，避免越权读别的会话）。
 * @param ctx - 宿主 ctx。
 * @param {string} leadId - Lead 会话 id。
 * @returns {Promise<string[]>} 成员 id 列表（不含 Lead）。
 */
async function recoverMemberIds(ctx, leadId) {
  const persistence = pick(ctx, 'sessionPersistence');
  if (persistence === undefined || persistence === null || typeof persistence.open !== 'function') return [];
  const ids = [];
  // ① 投影缓存
  const cache = pick(ctx, 'sessionProjectionCache');
  if (cache !== undefined && cache !== null && typeof cache.cachedSnapshot === 'function') {
    try {
      const handle = await openWithPrefixFallback(persistence, leadId);
      if (handle !== undefined) {
        try {
          const members = cache.cachedSnapshot(handle.header, ['agentTeam'])?.values?.agentTeam?.members;
          if (Array.isArray(members)) {
            for (const row of members) {
              if (typeof row?.id === 'string' && row.id !== '' && row.role !== 'lead') ids.push(row.id);
            }
          }
        } finally {
          if (typeof handle.close === 'function') await handle.close();
        }
      }
    } catch {
      /* 落到 ② */
    }
  }
  if (ids.length > 0) return ids;
  // ② Lead 日志里的 team/member 事件
  try {
    const handle = await openWithPrefixFallback(persistence, leadId);
    if (handle === undefined) return [];
    try {
      const { events } = await handle.read(0, void 0, {});
      if (!Array.isArray(events)) return [];
      for (const event of events) {
        if (event?.type !== 'team/member') continue;
        const id = event.data?.member?.id;
        if (typeof id === 'string' && id !== '') ids.push(id);
      }
    } finally {
      if (typeof handle.close === 'function') await handle.close();
    }
  } catch {
    return [];
  }
  return [...new Set(ids)];
}

/**
 * 读某个成员会话的对话尾部（浮动窗口用）。
 * 权限：只允许读**本团队**的会话（Lead 或任一成员 id），防止拿这个 op 翻别的会话。
 * @param ctx - 宿主 ctx。
 * @param sessionId - 发起会话 id。
 * @param targetId - 要读对话的成员会话 id。
 * @param limit - 行数上限。
 * @returns {Promise<object>}
 */
export async function teamConversation(ctx, sessionId, targetId, limit = 120) {
  const found = await leadForSession(ctx, sessionId);
  if (found.ok !== true) return found;
  const agentTeams = agentTeamsOf(ctx);
  if (agentTeams === undefined) return { ok: false, error: '官方 Agent Teams 域服务不可用' };
  if (typeof targetId !== 'string' || targetId === '') return { ok: false, error: '缺少 targetId' };
  // 权限：只允许读**本团队**的会话（Lead 或任一成员）。id 的 session- 前缀在实测里
  // 两边都有（Lead 的会话 id 带前缀、域服务的 member.id 不带），所以两边都归一后再比。
  const leadId = sessionIdOf(found.lead) ?? agentIdOf(found.lead);
  const allowed = new Set([normSessionId(leadId)]);
  try {
    for (const row of agentTeams.listMembers(found.lead) ?? []) {
      if (typeof row?.id === 'string') allowed.add(normSessionId(row.id));
    }
  } catch (error) {
    // 团队已结束时域服务必抛 TEAM_NOT_MEMBER（成员都销毁了）。
    // 这时**不能**直接失败：白名单退回到「从日志恢复的成员名单」，否则
    // 用户点开浮窗读对话仍然报错（团队结束 ≠ 不许看历史对话）。
    const recovered = await recoverMemberIds(ctx, leadId);
    if (recovered.length === 0) return { ok: false, error: `listMembers 失败：${messageOf(error)}` };
    for (const id of recovered) allowed.add(normSessionId(id));
  }
  const wanted = normSessionId(targetId);
  if (wanted === '' || !allowed.has(wanted)) {
    return { ok: false, error: '只能查看本团队成员的对话' };
  }
  // ⚠️ 用 pick()（= ctx.get 逃生口）取 agents：cordis 属性访问未 inject 的服务会抛错，
  // 而 `ctx.agents?.get?.(...)` 的可选链捕获不了抛错的 getter（这里以前也没有 try/catch，
  // 异常会一路冒到 handleApi 变成 {ok:false} → 浮窗读不到对话）。
  const registry = pick(ctx, 'agents');
  const agent = registry?.get?.(wanted) ?? registry?.get?.(targetId);
  // 活体优先、持久兜底：宿主重启后队员没有活体 agent，但它的日志还在（判据同 statsForSession）。
  // ⚠️ 必须先试 pick()（= ctx.get）：cordis 里属性访问未 inject 的服务会抛错，
  // 写成 `ctx.sessionPersistence ?? pick(...)` 时属性访问先抛、整个表达式被 try 吞掉 →
  // persistence 恒为 undefined → 兜底从未生效（和 lib/graph.js 里同一个坑）。
  let persistence = pick(ctx, 'sessionPersistence');
  if (persistence === undefined) {
    try {
      persistence = ctx.sessionPersistence ?? undefined;
    } catch {
      persistence = undefined;
    }
  }
  const result = await readConversationTail(wanted, agent?.session, persistence, limit);
  return { ok: true, rows: result.rows, ...(result.note === undefined ? {} : { note: result.note }) };
}

/**
 * 读某个成员会话「向用户提过的问」（`ask_user_question`）。
 *
 * 用户 2026-10-08 原话：「他提问的时候我在工作区看不到也收不到任何的提问信息，
 * 所以需要把界面直接接到聊天框里面」。
 *
 * 数据来源是**会话日志**（不是官方 `userQuestions` 投影）：实测全库 16 次
 * `ask_user_question` 调用都在日志里带完整问题与选项；而官方投影只跟踪 `mode: "timed"`，
 * 本机默认 legacy → 投影恒为空且不报错（靠它会静默失效，见 lib/graph.js 的 extractQuestions）。
 * @param ctx - 宿主 ctx。
 * @param sessionId - 发起会话 id。
 * @param targetId - 要看谁的提问。
 * @returns {Promise<{ok:boolean, questions?:Array, error?:string, note?:string}>}
 */
export async function teamQuestions(ctx, sessionId, targetId) {
  const found = await leadForSession(ctx, sessionId);
  if (found.ok !== true) return found;
  if (typeof targetId !== 'string' || targetId === '') return { ok: false, error: '缺少 targetId' };
  const wanted = normSessionId(targetId);
  if (wanted === '') return { ok: false, error: '缺少 targetId' };
  const registry = pick(ctx, 'agents');
  const agent = registry?.get?.(wanted) ?? registry?.get?.(targetId);
  const persistence = pick(ctx, 'sessionPersistence');
  // 问题需要**整份**事件（ask 可能很早），用专门的读取路径而不是对话尾部窗口。
  const events = await readOwnEvents(wanted, agent?.session, persistence);
  if (events === null) {
    return { ok: true, questions: [], note: `会话 ${wanted} 的事件读不到（没有活体 agent 且持久日志不可用）` };
  }
  return { ok: true, questions: extractQuestions(events, 20) };
}

/**
 * 读一个会话的「自己的事件」（跳过 fork 继承前缀）。读不到返回 null。
 * @param sessionId - 会话 id（裸 uuid）。
 * @param session - 活体 session（可能 undefined）。
 * @param persistence - sessionPersistence（可能 undefined）。
 * @returns {Promise<Array|null>}
 */
async function readOwnEvents(sessionId, session, persistence) {
  if (session !== undefined && session !== null
    && typeof session.eventAt === 'function' && typeof session.seq === 'number') {
    const out = [];
    for (let seq = 0; seq < session.seq; seq += 1) {
      const event = session.eventAt(seq);
      if (event !== undefined) out.push(event);
    }
    return out;
  }
  if (persistence === undefined || persistence === null || typeof persistence.open !== 'function') return null;
  try {
    const handle = await openWithPrefixFallback(persistence, sessionId);
    if (handle === undefined) return null;
    try {
      const { events } = await handle.read(0, void 0, {});
      if (!Array.isArray(events)) return null;
      return events;
    } finally {
      if (typeof handle.close === 'function') await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * 从工作区向某个会话发一条用户消息（等价于用户在官方输入框里打字回车）。
 *
 * ⚠️ 两条投递路径，**必须按会话类型分流**（2026-10-08 查证官方源码）：
 *   * Lead（普通会话）→ `sessionController.prompt(request)`
 *     （dsh-api-session-controller/lib/index.js:850，服务名 `sessionController`）；
 *   * **队员（origin==='subagent'）→ 会被 prompt 直接拒**：
 *     `resolve()` 里 `hasApiSessionSubagentOwner` 对 `origin==='subagent'` 恒为 true
 *     （同文件 :126-132），返回 `session/agent-busy` + reason
 *     "use subagent delivery for this child session"。官方给的唯一路径是
 *     `subagents.prompt({parentSessionId, childSessionId, mode:'continuable', delivery, content})`
 *     （dsh-subagent/lib/index.js:3011，服务名 `subagents`），且要求**父会话有活体 agent**。
 * @param ctx - 宿主 ctx。
 * @param sessionId - 发起会话 id（工作区所在会话）。
 * @param targetId - 要发给谁。
 * @param text - 消息正文。
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function teamSend(ctx, sessionId, targetId, text) {
  const found = await leadForSession(ctx, sessionId);
  if (found.ok !== true) return found;
  if (typeof targetId !== 'string' || targetId === '') return { ok: false, error: '缺少 targetId' };
  const body = typeof text === 'string' ? text.trim() : '';
  if (body === '') return { ok: false, error: '消息不能为空' };
  if (body.length > 8000) return { ok: false, error: '消息过长（上限 8000 字符）' };
  const wanted = normSessionId(targetId);
  const leadId = sessionIdOf(found.lead) ?? agentIdOf(found.lead);
  const isLead = normSessionId(leadId ?? '') === wanted;
  const content = [{ type: 'text', text: body }];
  const requestId = `dat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const tz = safeTimeZone();
  // ① Lead：走官方普通 prompt 通道。
  if (isLead) {
    const controller = pick(ctx, 'sessionController');
    if (controller === undefined || typeof controller.prompt !== 'function') {
      return { ok: false, error: 'sessionController 服务不可用，无法发送' };
    }
    try {
      const result = await controller.prompt({
        sessionId: leadId,
        content,
        mode: 'queue',
        requestId,
        ...(tz === undefined ? {} : { clientTimeZone: tz }),
      });
      return { ok: true, accepted: result?.accepted !== false };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }
  // ② 队员：走官方 subagent delivery（prompt 通道对 subagent 恒拒）。
  const subagents = pick(ctx, 'subagents');
  if (subagents === undefined || typeof subagents.prompt !== 'function') {
    return { ok: false, error: 'subagents 服务不可用，无法给队员发消息' };
  }
  try {
    const result = await subagents.prompt({
      requestId,
      parentSessionId: leadId,
      childSessionId: targetId,
      mode: 'continuable',
      delivery: 'queue',
      content,
      ...(tz === undefined ? {} : { clientTimeZone: tz }),
    });
    return { ok: true, accepted: true, messageId: result?.messageId };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/** 本机时区（官方 prompt 的 clientTimeZone 是可选字段，拿不到就不传）。 */
function safeTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** 去掉 session- 前缀的 id。 */
function normSessionId(id) {
  return typeof id === 'string' ? id.replace(/^session-/, '') : '';
}

/** 插件卸载时的整体回卷：卸载全部 agent 作用域注册、退订生命周期、清空开启记录与缓存。 */
export function disposeAll() {
  for (const agentId of [...state.installed.keys()]) disposeInstalled(agentId);
  state.roots.clear();
  spawnRoutes.clear();
  spawnEfforts.clear();
  advertisedEfforts.clear();
  truncatedMembers.clear();
  if (state.watch !== undefined) {
    for (const disposer of [...state.watch].reverse()) runDisposer(disposer, 'agent 生命周期订阅');
    state.watch = undefined;
  }
  // 缓存保活：先停控制器（清定时器、中止在途 ping），再摘掉 llm/stream 观察器。
  detachKeepalive('plugin-disposed');
  if (state.keepaliveDisposers.length > 0) {
    for (const disposer of [...state.keepaliveDisposers].reverse()) runDisposer(disposer, 'llm/stream 保活观察器');
    state.keepaliveDisposers.length = 0;
  }
  // 丢掉控制器本身：插件被重新 apply（HMR/重载）时要能重新建一个，而不是返回一个观察器已摘掉的旧实例。
  keepalive = undefined;
  keepaliveCtx = undefined;
  keepaliveLead = undefined;
  // 状态文件刷新钩子由宿主半持有，插件被卸载/HMR 重载后必须丢掉，
  // 否则 enable/disable 会去调一个已经失效的 writeStatusFile（它闭包里的 ctx 已 dispose）。
  statusRefresh = undefined;
}

// ── enable / disable / status ───────────────────────────────────────────────

/** 是否是活体 agent 形状（有 id 和 agent 作用域 ctx）。 */
function isAgentLike(agent) {
  return agentIdOf(agent) !== undefined && agent.ctx !== undefined && agent.ctx !== null;
}

/**
 * 按 agent.id 记账：root 开启后，其后代（队员）在安装时也记入 enabled。
 * 同步、永不抛错。
 * @param agent - 任意 agent。
 */
export function isEnabled(agent) {
  const agentId = agentIdOf(agent);
  if (agentId === undefined) return false;
  return state.roots.has(agentId) || state.installed.has(agentId);
}

/** 我们插件的 preset id：只有它能看到 /team 与开关工具（见 lib/preset.js 的边界说明）。 */
const DISPATCH_PRESET_ID = 'dispatch-mode';

/**
 * 判断调用者会话跑的是不是「调度模式」preset。
 *
 * 这是**纵深防御**，不是唯一闸门：控制面（`/team` 与开关工具）只注册在调度模式的 preset 层里，
 * 别的 preset 根本看不到它们。但「看不到」靠的是注册位置，一旦将来有人把注册挪回宿主平面，
 * 这个判断就能在运行时挡住越界，并给出一句可执行的说明。
 *
 * 取不到 `agentPresets` 服务时**放行**（fail-open）：那时无法判断，而误拒会让整个团队功能失效；
 * 放行是安全的，因为此时控制面本来就只可能在调度模式里存在。
 * @param ctx - 任意作用域 ctx。
 * @param agent - 调用者 agent。
 * @returns {allowed:boolean, presetId:string|undefined, reason?:string}
 */
function assertDispatchPreset(ctx, agent) {
  const agentPresets = pick(ctx, 'agentPresets');
  if (agentPresets === undefined || typeof agentPresets.composedPreset !== 'function') {
    return { allowed: true, presetId: void 0 };
  }
  let composed;
  try {
    composed = agentPresets.composedPreset(agent.ctx);
  } catch (error) {
    recordDiagnostic(`读取当前 preset 失败（本次不做边界拦截）：${messageOf(error)}`);
    return { allowed: true, presetId: void 0 };
  }
  // `composedPreset(agentCtx)` 返回的是 **preset id 字符串**
  // （dsh-agent-presets/lib/index.js:1550-1552 → standingMountFor(agentCtx)?.presetId）；
  // 这里同时容忍「返回 {id}」的实现，免得官方哪天换形状就误判。
  const presetId = typeof composed === 'string' && composed !== ''
    ? composed
    : (typeof composed?.id === 'string' ? composed.id : void 0);
  if (presetId === void 0) return { allowed: true, presetId: void 0 };
  if (presetId === DISPATCH_PRESET_ID) return { allowed: true, presetId };
  return {
    allowed: false,
    presetId,
    reason: `本会话的 preset 是 "${presetId}"，不是「调度模式」（${DISPATCH_PRESET_ID}）——`
      + '本插件的智能体团队只属于调度模式。请在新建会话时把推理模式选成「调度模式」再开团队。',
  };
}

/**
 * 为调用者（Lead）开启团队：安装团队策略段与九个工具、给已存在的队员补装、
 * 并订阅生命周期以便后续创建的队员被自动覆盖。
 * @param ctx - 宿主/preset ctx。
 * @param agent - 调用者 agent（必须是 Lead；队员调用会被拒绝）。
 * @param opts - {source:'command'|'tool'|'boot', rawInput?:string, extra?:string}。
 * @returns {ok, enabled, member, diagnostics}
 */
export async function enable(ctx, agent, opts = {}) {
  const notes = [];
  const source = typeof opts?.source === 'string' ? opts.source : 'tool';
  if (!isAgentLike(agent)) {
    return { ok: false, enabled: false, member: false, diagnostics: ['无法定位调用会话：工具/命令没有拿到调用者 agent'] };
  }
  // 边界：只有调度模式的会话能开本插件的团队（别的 preset 去用官方团队，不混用）。
  const boundary = assertDispatchPreset(ctx, agent);
  if (boundary.allowed !== true) {
    // 一次被边界拒绝的调用：调用方拿到的 diagnostics 里有完整原因（见下一行返回值），
    // 这里只记信息 —— 否则别的 preset 里的一次尝试会以红色告警出现在本页面上。
    recordNote(`已按 preset 边界拒绝开启团队：调用会话的 preset 是 "${String(boundary.presetId)}"`);
    return { ok: false, enabled: false, member: false, diagnostics: [boundary.reason ?? '本会话的 preset 不是调度模式，已拒绝开启团队'] };
  }
  if (boundary.presetId === void 0) {
    notes.push('无法读取当前 preset（agentPresets 不可用），未做 preset 边界拦截；控制面本身只在调度模式注册');
  }
  const agentTeams = agentTeamsOf(ctx);
  const agentId = agent.id;
  if (agentTeams === undefined) {
    // P1：域服务是可选 bundle。缺了就明确失败（不抛），不装半套工具。
    return {
      ok: false,
      enabled: false,
      member: false,
      diagnostics: ['官方 Agent Teams 域服务未挂载：请在插件页启用 @deepseek-ai/dsh-experimental-agent-team-profile（至少保留 agent-team 行）'],
    };
  }
  const membership = safeMembership(agentTeams, agent);
  if (membership !== undefined && membership.role === 'teammate') {
    return { ok: false, enabled: true, member: true, diagnostics: ['当前会话是团队成员，只有 Lead 能开启团队'] };
  }
  if (state.roots.has(agentId)) {
    // 幂等：已经开启过；顺手把可能漏装的队员补齐（例如上次 enable 时机早于队员恢复）。
    for (const candidate of liveAgents(ctx)) {
      try {
        syncAgent(ctx, candidate, agentTeams);
      } catch (error) {
        notes.push(`补齐已存在队员失败（已吞掉）：${messageOf(error)}`);
      }
    }
    // 也补一次会话记忆：万一第一次 enable 时工具没装上（同名撞车），后来补装成功，
    // 这条会话照样应该能在宿主重启后恢复（markEnabled 本身幂等）。
    if (state.installed.has(agentId)) rememberSession(agent, source);
    return { ok: true, enabled: true, member: false, diagnostics: notes };
  }
  state.roots.add(agentId);
  // 直接给调用者安装，**不经过 syncAgent/membership**：域服务的 tryMembership 在
  // 「该 agent 还不在注册表里/不是它认识的身份」时会返回 undefined
  // （dsh-experimental-agent-team/lib/index.js:397-399），若依赖它来判断就可能在
  // 返回 ok:true 的同时**什么都没装**。调用者是 Lead 这一点由命令/工具本身保证。
  let rootTools;
  try {
    rootTools = state.installed.has(agentId) ? { toolsOk: true } : installRoot(ctx, agent, agentTeams);
  } catch (error) {
    notes.push(`安装团队工具面失败（已吞掉，团队处于降级状态）：${messageOf(error)}`);
    rootTools = { handled: true, toolsOk: false, toolsMessage: '安装过程抛错，已吞掉' };
  }
  for (const candidate of liveAgents(ctx)) {
    try {
      syncAgent(ctx, candidate, agentTeams);
    } catch (error) {
      notes.push(`给已存在的队员补装失败（已吞掉）：${messageOf(error)}`);
    }
  }
  watchAgents(ctx);
  if (rootTools.toolsOk === false) {
    // P0：工具注册撞车不能让 enable 失败——最坏是降级到官方工具，而不是崩溃。
    notes.push(`本插件的团队工具没有装上，本会话使用的是官方团队工具：队员卡/工具收窄/模型强度覆盖可能不完整。原因：${rootTools.toolsMessage ?? '未提供'}`);
  } else {
    // 只有真的装上了才记「这个会话开着团队」：记了一个装不上的会话，重启后只会反复恢复失败。
    rememberSession(agent, source);
  }
  recordNote(`团队已开启（Lead ${agentId}，source=${source}）`);
  attachKeepalive(agent);
  refreshStatusFile();
  return { ok: true, enabled: true, member: false, diagnostics: notes };
}

/**
 * 开团/关团成功后重拍一份 settled 状态快照：那条路径上 preset 必然已经挂好
 * （/team 与开关工具只存在于调度模式的 preset 层），比纯靠定时器更早拿到完整的
 * preset 清单（2026-10-04 审查 P1-6）。
 */
export function setStatusRefresh(fn) {
  statusRefresh = typeof fn === 'function' ? fn : undefined;
}

/** 调一次刷新钩子；钩子自己出任何错都不许影响开团/关团这条主路径。 */
function refreshStatusFile() {
  if (statusRefresh === undefined) return;
  try {
    statusRefresh();
  } catch (error) {
    recordNote(`状态文件刷新钩子失败（已吞掉）：${messageOf(error)}`);
  }
}

/** 读活体 agent 列表；永不抛错。 */
function liveAgents(ctx) {
  const agents = pick(ctx, 'agents');
  if (agents === undefined || typeof agents.list !== 'function') {
    recordDiagnostic('ctx.agents 不可用，无法给已存在的队员补装');
    return [];
  }
  try {
    const list = agents.list();
    return Array.isArray(list) ? list : [];
  } catch (error) {
    recordDiagnostic(`ctx.agents.list() 失败：${messageOf(error)}`);
    return [];
  }
}

/**
 * 关闭调用者会话的团队：卸载该 Lead 与其全部队员的注册。
 * 同步（不等待卸载完成），队员调用会被拒绝。
 * @param ctx - 宿主/preset ctx。
 * @param agent - 调用者 agent。
 * @returns {ok, wasEnabled}
 */
export function disable(ctx, agent) {
  const agentId = agentIdOf(agent);
  if (agentId === undefined) return { ok: false, wasEnabled: false };
  const membership = safeMembership(agentTeamsOf(ctx), agent);
  if (membership !== undefined && membership.role === 'teammate') {
    return { ok: false, wasEnabled: true };
  }
  const wasEnabled = state.roots.has(agentId) || state.installed.has(agentId);
  // 会话记忆：无论当前有没有装着，用户显式关团就把记录删掉 —— 否则它会在下次重启时自己开回来。
  forgetSession(sessionIdOf(agent));
  if (!wasEnabled) return { ok: true, wasEnabled: false };
  state.roots.delete(agentId);
  for (const [installedId, entry] of [...state.installed.entries()]) {
    if (entry.ownerId === agentId) disposeInstalled(installedId);
  }
  // 兜底：万一某个 agent 的 ownerId 记账丢失，也把自己那份卸载掉。
  if (state.installed.has(agentId)) disposeInstalled(agentId);
  detachKeepalive('team-disabled');
  recordNote(`团队已关闭（Lead ${agentId}）`);
  refreshStatusFile();
  return { ok: true, wasEnabled: true };
}

/**
 * 同步状态查询：是否开启、该 agent 的角色与最终路由、域服务是否可用、
 * 该队员实际被摘掉了哪些工具，以及在安装/遮蔽过程中产生的诊断。
 * @param agent - 任意 agent。
 */
export function status(agent) {
  const agentId = agentIdOf(agent);
  const entry = agentId === undefined ? undefined : state.installed.get(agentId);
  const role = entry?.role;
  return {
    enabled: isEnabled(agent),
    role,
    route: role === undefined ? undefined : resolveRoleRoute(state.config, role),
    /** 官方 Agent Teams 域服务是否可用；null = 还没观察过。缺它时整个团队功能不可用。 */
    domain: state.domainAvailable === undefined ? null : state.domainAvailable,
    /** 该队员被摘掉的工具名（Lead 为 undefined）。排查「队员为什么没有某个工具」看这里。 */
    restrictedTools: entry?.restricted,
    diagnostics: entry?.diagnostics ?? [],
  };
}

/**
 * 把一条文本作为 user 消息注入 agent 的下一个 turn（**唯一实现**，preset.js 优先用它）。
 *
 * 失败语义与 lib/preset.js 的兜底完全一致：**抛错**而不是返回 {ok:false}，
 * 否则 preset.js 的 tryInject 会把失败当成功（静默吞错）。
 *
 * 写法依据 0.1.7：`agent.followup(input)` = `send(input, 'next-turn', true)`
 * （dsh-agent-loop/lib/index.js:806-808）；消息身份由 `randomUUID()` 生成
 * （与 dsh-llm 的 createMessage 同形，dsh-llm/lib/types/message.js:34-38）。
 * **不 import @deepseek-ai/dsh-llm**：从插件源码目录解析到的是版本不一致的 0.1.5 junction，
 * 静态 import 会在模块加载期硬崩。
 * @param agent - 目标 agent。
 * @param text - 要注入的非空文本。
 * @param attachments - 宿主已准入的附件块（`invocation.attachments`）；按原顺序放在正文之前。
 * @throws TypeError 调用者形状不对或文本为空。
 */
export function inject(agent, text, attachments = []) {
  if (agent === undefined || agent === null || typeof agent.followup !== 'function') {
    throw new TypeError('dispatch team: 无法注入 user 消息——没有拿到带 followup() 的 agent');
  }
  if (typeof text !== 'string' || text === '') {
    throw new TypeError('dispatch team: 注入内容必须是非空字符串');
  }
  const blocks = Array.isArray(attachments) ? attachments.filter((block) => block !== null && block !== undefined) : [];
  // 与 lib/preset.js 兜底的形状逐字一致（Lead 裁决）：冻结的 user 消息；
  // 附件在前、正文在后，与官方 /plan 的注入同形（dsh-plan-mode/lib/index.js:217-223）。
  agent.followup(Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([...blocks, Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'user' }),
  }));
}

/** 传给 lib/tools.js 的 runtime 门面（tools.js 只需要这几个函数，避免它 import 本模块造成环）。 */
const runtimeApi = {
  peekConfig,
  preflightRoute,
  enable,
  disable,
  isEnabled,
  status,
  loadConfig,
  getConfigPath,
  inject,
  pinSpawnRoute,
  watchAgents,
  reconcileAgents,
  diagnostics,
  recordReport,
  markReportDelivered,
  truncatedMemberIds,
  retriedMemberIds,
  noteTurnEndReason,
};

export { runtimeApi };

// ─────────────────────────────────────────────────────────────────────────────
// 缓存保活（lib/cache.js 的接线）与结构化汇报记录
// ─────────────────────────────────────────────────────────────────────────────

/** 保活控制器单例（插件进程内唯一）。 */
let keepalive;
/** 保活挂载时的宿主 ctx（取 llm / agents / agentTeams 用；不持有 agent 引用）。 */
let keepaliveCtx;
/** 当前挂了保活的 Lead agent id；undefined = 没有会话开着团队。 */
let keepaliveLead;

/** 最近的结构化汇报（队员 report_result 的产物），有界。 */
const REPORTS_CAP = 20;
const reports = [];

/** 被上限挤掉的汇报条数（面板显示「另有 N 条更早的汇报未展示」，而不是假装只有这些）。 */
let reportsDropped = 0;

/**
 * 记录一份结构化报告（lib/tools.js 的 report_result 调用）。
 *
 * 注意：顺序纪律（2026-10-05 审查 §1-⑤）：投递结果由调用方在**投递之后**补写（`delivered`），
 * 因为「插件页记录」与「Lead 邮箱」是两套状态：本函数先落记录、投递却可能失败，
 * 那时页面上会有一条“已交报告”而 Lead 从未收到。补写 delivered 才能让两套口径对齐。
 * @param name - 队员名。
 * @param report - validateReport 的产物。
 * @returns 记录对象（调用方可用它补写 delivered）。
 */
export function recordReport(name, report) {
  const entry = {
    at: new Date().toISOString(),
    name: typeof name === 'string' ? name : String(name ?? 'teammate'),
    status: report?.status,
    summary: report?.summary,
    acceptance: report?.acceptance,
    evidence: Array.isArray(report?.evidence) ? [...report.evidence] : [],
    unresolved: Array.isArray(report?.unresolved) ? [...report.unresolved] : [],
    changedFiles: Array.isArray(report?.changedFiles) ? [...report.changedFiles] : [],
    /** 三态：true 已投递给 Lead / false 投递失败（正文要照 Lead 邮箱口径读）/ undefined 还没投完。 */
    delivered: void 0,
  };
  reports.push(entry);
  if (reports.length > REPORTS_CAP) {
    reportsDropped += reports.length - REPORTS_CAP;
    reports.splice(0, reports.length - REPORTS_CAP);
  }
  const statusText = typeof report?.status === 'string' ? report.status : 'unknown';
  const unresolved = Array.isArray(report?.unresolved) ? report.unresolved.length : 0;
  recordNote(`收到队员 ${String(name)} 的结构化报告：${statusText}${unresolved > 0 ? `（未决项 ${unresolved} 条，阻止验收）` : ''}`);
  return entry;
}

/** 投递结束后补写这一条记录的 delivered（找不到就走 no-op；永不抛错）。 */
export function markReportDelivered(entry, delivered) {
  if (entry === null || typeof entry !== 'object') return;
  entry.delivered = delivered === true;
}

/**
 * 读最近的结构化报告（状态文件 / 面板用）。
 * @returns {{items: object[], dropped: number, cap: number}}
 */
export function recentReports() {
  return {
    items: reports.map((item) => ({ ...item, evidence: [...item.evidence], unresolved: [...item.unresolved], changedFiles: [...item.changedFiles] })),
    dropped: reportsDropped,
    cap: REPORTS_CAP,
  };
}

/**
 * 统计「正在 running / provisioning 的队员数」——保活用它判断「Lead 是不是真的在等人」。
 * 没有队员在跑时不 ping（等待窗口不存在，ping 只会白花钱）。
 * 这里**不**调 liveAgents()（那条路径在 agents 服务缺失时会记诊断），只走 agentTeams.listMembers。
 */
function activeMemberCount() {
  if (keepaliveCtx === undefined || keepaliveLead === undefined) return 0;
  const teams = agentTeamsOf(keepaliveCtx);
  if (teams === undefined || typeof teams.listMembers !== 'function') return 0;
  const agents = pick(keepaliveCtx, 'agents');
  if (agents === undefined || typeof agents.list !== 'function') return 0;
  try {
    const lead = agents.list().find((agent) => agentIdOf(agent) === keepaliveLead);
    if (lead === undefined) return 0;
    let count = 0;
    for (const member of teams.listMembers(lead)) {
      if (member?.role !== 'teammate') continue;
      if (member.status === 'running' || member.status === 'provisioning') count += 1;
    }
    return count;
  } catch (error) {
    recordNote(`缓存保活：统计队员状态失败（按 0 处理）：${messageOf(error)}`);
    return 0;
  }
}

/**
 * 安装保活观察器（幂等；由 lib/index.js 的 apply 调用一次）。
 *
 * `ctx.on('llm/stream', handler)` 的语义：这是 dsh-llm 的瀑布（dsh-llm/lib/index.js:2367-2371
 * `streamWithRegistration` → `this.ctx.waterfall(this, "llm/stream", options, …)`），
 * 监听器必须把 next() 的结果原样交出去。我们对**非 Lead 请求完全旁路**（直接返回 next()）。
 *
 * @param ctx - 宿主根 ctx。
 */
export function installKeepalive(ctx) {
  if (keepalive !== undefined) return keepaliveStats();
  keepaliveCtx = ctx;
  keepalive = createKeepalive({
    log: (message) => recordNote(`缓存保活：${message}`),
    note: (message) => recordNote(message),
    llmOf: () => pick(ctx, 'llm'),
    waitersOf: () => activeMemberCount(),
    overridesOf: () => state.config?.cache?.keepalive?.routes ?? {},
    leadMarker: LEAD_MARKER,
    teammateMarker: TEAMMATE_MARKER,
  });
  try {
    const off = keepalive.observe(ctx);
    keepDisposer(state.keepaliveDisposers, off, 'llm/stream 保活观察器', []);
  } catch (error) {
    recordNote(`缓存保活：注册 llm/stream 观察器失败（保活不可用，团队功能不受影响）：${messageOf(error)}`);
  }
  return keepaliveStats();
}

/** 团队开启时挂载保活（Lead 已知）。 */
function attachKeepalive(agent) {
  if (keepalive === undefined) return;
  const agentId = agentIdOf(agent);
  keepaliveLead = agentId;
  // 挂载初值取**最后一次真实请求**的 header（官方 dsh-agent-loop/lib/index.js:1165-1171 读的就是
  // session.requestHeader().config 上的 provider/model）：恢复会话或 Lead 已跑过若干请求后再开团时，
  // 这一步就能拿到真实线路。**不要用 resolveRoleRoute(config,'lead')**——'lead' 不在 ROLE_IDS 里，
  // sanitizeConfig 根本不存这个键，那条路恒 undefined，线路族判定会一直错到第一个真实请求
  // （2026-10-04 审查 P1-9）。首请求之前 requestHeader() 为 undefined，交给 cache.js 的
  // handleStream → applyPolicy 在抓到真实请求时校准。
  const headerConfig = agent?.session?.requestHeader?.()?.config;
  try {
    keepalive.attach({
      agentId,
      sessionId: agent?.session?.id,
      provider: typeof headerConfig?.provider === 'string' && headerConfig.provider !== '' ? headerConfig.provider : undefined,
      model: typeof headerConfig?.model === 'string' && headerConfig.model !== '' ? headerConfig.model : undefined,
    });
  } catch (error) {
    recordNote(`缓存保活：挂载失败（已吞掉，团队功能不受影响）：${messageOf(error)}`);
  }
}

/** 团队关闭 / 卸载时停掉保活。 */
function detachKeepalive(reason) {
  if (keepalive === undefined) return;
  keepaliveLead = undefined;
  try {
    keepalive.detach(reason);
  } catch (error) {
    recordNote(`缓存保活：卸载失败（已吞掉）：${messageOf(error)}`);
  }
}

/** 队员状态可能变了：让保活重排定时器（不会唤醒任何人）。 */
export function notifyKeepalive() {
  if (keepalive === undefined) return;
  try {
    keepalive.notifyActivity();
  } catch (error) {
    recordNote(`缓存保活：重排定时器失败（已吞掉）：${messageOf(error)}`);
  }
}

/** 配置变化后重算保活策略。 */
export function reconfigureKeepalive() {
  if (keepalive === undefined) return undefined;
  try {
    return keepalive.reconfigure();
  } catch (error) {
    recordNote(`缓存保活：重算策略失败（已吞掉）：${messageOf(error)}`);
    return undefined;
  }
}

/** 保活状态快照（状态文件 / HTTP / 面板）。 */
export function keepaliveStats() {
  if (keepalive === undefined) return { installed: false };
  try {
    return { installed: true, ...keepalive.stats() };
  } catch (error) {
    return { installed: true, error: messageOf(error) };
  }
}