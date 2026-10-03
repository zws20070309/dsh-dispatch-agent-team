/**
 * resume.js —— **会话级**团队开关记忆：宿主重启后，用户之前开着团队的会话要能自动恢复。
 *
 * 为什么需要它（2026-10-01 的现场证据，不是推测）：
 *   团队开关只存在内存里（`lib/runtime.js` 的 `state.roots`，文件头写明「开启状态不跨重启持久化」）。
 *   于是一次宿主重启之后，同一份会话日志里出现两条相邻事件：
 *     seq=360  request/header  reason=resume series  工具 72 个  -[spawn_teammate, team_task_create, …]
 *     seq=361  developer/message（tool-registry）     -[spawn_teammate, team_task_create, …]
 *   紧接着 Lead 的团队工具调用全部失败：
 *     spawn_teammate → `Error: unknown tool "spawn_teammate"`
 *     wait_agent     → `Error: unknown tool "wait_agent"`
 *     send_message   → `Error: invalid arguments: missing required property "agent_id"`
 *   （第三条是**阴影消失**的后果：`send_message` / `list_agents` / `interrupt_agent` 这三个名字
 *   由官方的 `@deepseek-ai/dsh-tool-subagent-control` 在宿主平面提供、参数形状不同；我们装上时
 *   在更深的 agent 作用域里遮蔽它们，卸载后露出来的就是官方那份。）
 *   用户看到的就是会话里一行「移除：spawn_teammate, team_task_create, …」（截图 2026-10-01）。
 *
 * 为什么不用「往会话日志里写自定义事件 + sessionProjections 折叠」这条更原生的路：
 *   `dsh-session/lib/types/known-event-types.js:8-20` 明确要求**仓库外的事件**必须带
 *   `SessionEvent.ignorable` 标记才会被持久化读路径解释；插件写事件要自己拼信封、还要
 *   保证 resume 时投影早于 agent 创建就绪。收益只是「状态跟着会话文件走」，而代价是
 *   在别人的会话日志里写入非官方事件。这里选**插件自己的小状态文件**：失败面小、可读、
 *   可手工删，且**不碰**任何会话日志。
 *
 * 边界（保证不会把团队泄漏到别的会话）：
 *   - 只按**会话 id**记：新建会话的 id 不在文件里 → 团队默认仍是关的；
 *   - 只在**调度模式** preset 的会话里恢复（恢复前照样过 `assertDispatchPreset`）；
 *   - 用户显式关团（`disable_agent_team` / 说「关掉团队」）→ 立刻删掉该会话的记录；
 *   - 记录有 TTL 与条数上限，长期不用的会话会被清掉（见 SESSION_TTL_MS / MAX_SESSIONS）；
 *   - 任何读写失败都只记诊断，绝不让 enable/disable/agent 创建失败。
 *
 * 本文件只依赖 node 内建模块（不 import 任何 @deepseek-ai 包），所以 selftest / drift-check
 * 可以直接 import 它做纯函数断言。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** 状态文件名（放在 DSH 主目录下，与 dispatch-agent-team.json 同级）。 */
export const SESSIONS_FILENAME = 'dispatch-agent-team-sessions.json';
/** 记录版本号：形状变了就 +1，旧版本整份丢弃（宁可让用户重开一次团队，也不猜旧形状）。 */
export const SESSIONS_VERSION = 1;
/** 多久没用过的会话记录就作废（7 天）。 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 最多记多少条会话（超出按最后使用时间淘汰最旧的）。 */
export const MAX_SESSIONS = 200;
/** 单条记录的字段白名单（其余字段在 sanitize 时丢掉，防止文件被人手改坏后带进运行时）。 */
const SESSION_FIELDS = Object.freeze(['enabledAt', 'lastSeenAt', 'source']);

/**
 * 同步解析 DSH 主目录。
 *
 * 为什么这里**不能**用 `lib/runtime.js` 的 `locateDshHome()`：那条路要 `await settings.prepareDocument()`，
 * 而本模块的调用点之一是 `agent/created` 的**同步**监听器（`lib/runtime.js` 的 watchAgents，
 * 注释说明了为什么必须同步安装）。所以这里只走同步候选：`DSH_HOME` → `~/.dsh`。
 * 生产里两者同值；测试里用 `DSH_HOME` 指到临时目录（与 integration-test 的隔离手法一致）。
 * @returns {string} 绝对路径。
 */
export function sessionsHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return path.resolve(env.trim());
  return path.join(homedir(), '.dsh');
}

/** 状态文件绝对路径。 */
export function sessionsPath(home = sessionsHome()) {
  return path.join(home, SESSIONS_FILENAME);
}

/** 空状态。 */
function emptyStore() {
  return { version: SESSIONS_VERSION, updatedAt: 0, sessions: {} };
}

/** 是不是一个非空字符串 id。 */
function usableId(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 纯函数：把磁盘上（或任何来源）的原始对象净化成可用状态。
 *
 * 规则：版本不符 → 整份丢弃；不是对象的记录 → 丢掉；字段白名单外 → 丢掉；
 * 时间戳不是有限正数 → 用 now 顶上（宁可续一次，也不要因为一个坏字段让整份失效）；
 * 过期（now - lastSeenAt > TTL）→ 丢掉；超出 MAX_SESSIONS → 按 lastSeenAt 淘汰最旧的。
 *
 * @param raw - 任意解析结果。
 * @param now - 当前时间（毫秒）；测试注入。
 * @returns {{version:number, updatedAt:number, sessions:Object<string,{enabledAt:number,lastSeenAt:number,source?:string}>}}
 */
export function sanitizeStore(raw, now = Date.now()) {
  if (raw === null || typeof raw !== 'object' || raw.version !== SESSIONS_VERSION) return emptyStore();
  const source = raw.sessions !== null && typeof raw.sessions === 'object' ? raw.sessions : {};
  const kept = [];
  for (const [id, value] of Object.entries(source)) {
    if (!usableId(id)) continue;
    if (value === null || typeof value !== 'object') continue;
    const clean = {};
    for (const field of SESSION_FIELDS) {
      if (value[field] === undefined) continue;
      if (field === 'source') {
        if (typeof value[field] === 'string' && value[field].trim() !== '') clean.source = value[field];
        continue;
      }
      clean[field] = Number.isFinite(value[field]) && value[field] > 0 ? value[field] : now;
    }
    if (!Number.isFinite(clean.lastSeenAt)) clean.lastSeenAt = now;
    if (!Number.isFinite(clean.enabledAt)) clean.enabledAt = clean.lastSeenAt;
    if (now - clean.lastSeenAt > SESSION_TTL_MS) continue;
    kept.push([id, clean]);
  }
  kept.sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt);
  const sessions = {};
  for (const [id, value] of kept.slice(0, MAX_SESSIONS)) sessions[id] = value;
  return { version: SESSIONS_VERSION, updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0, sessions };
}

/**
 * 读状态文件。任何失败（不存在、坏 JSON、权限）都返回空状态 —— 调用方只需要「有没有记录」。
 * @param file - 状态文件路径；默认 `sessionsPath()`。
 * @param now - 当前时间（毫秒）。
 * @returns 净化后的状态。
 */
export function readStore(file = sessionsPath(), now = Date.now()) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return emptyStore();
  }
  try {
    return sanitizeStore(JSON.parse(text), now);
  } catch {
    return emptyStore();
  }
}

/**
 * 原子写状态文件：先写 `<file>.tmp` 再 rename（同目录 rename 在同一卷上是原子的）。
 * @param file - 目标路径。
 * @param store - 已净化的状态。
 * @returns {boolean} 是否写成功（失败不抛，调用方记诊断）。
 */
export function writeStore(file, store) {
  const temp = `${file}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}

/** 读 → 改 → 写；返回 {ok, changed}。所有异常都收敛成 ok:false（调用方记诊断）。 */
function mutate(file, now, change) {
  try {
    const store = readStore(file, now);
    const next = change(store) ?? store;
    if (next === store) return { ok: true, changed: false };
    next.updatedAt = now;
    return { ok: writeStore(file, next), changed: true };
  } catch {
    return { ok: false, changed: false };
  }
}

/**
 * 记下「这个会话开着团队」。
 * @param sessionId - 会话 id（= Lead agent id，见 INTERFACES「agent.id === agent.session.id」）。
 * @param options - {file, now, source}：测试注入用；source 只作可读备注。
 * @returns {{ok:boolean, changed:boolean}}
 */
export function markEnabled(sessionId, options = {}) {
  if (!usableId(sessionId)) return { ok: false, changed: false };
  const file = options.file ?? sessionsPath();
  const now = options.now ?? Date.now();
  const source = typeof options.source === 'string' && options.source.trim() !== '' ? options.source : undefined;
  return mutate(file, now, (store) => {
    const previous = store.sessions[sessionId];
    const record = {
      enabledAt: previous?.enabledAt ?? now,
      lastSeenAt: now,
      ...(source === undefined ? (previous?.source === undefined ? {} : { source: previous.source }) : { source }),
    };
    if (previous !== undefined
      && previous.lastSeenAt === record.lastSeenAt
      && previous.enabledAt === record.enabledAt
      && previous.source === record.source) return store;
    return { ...store, sessions: { ...store.sessions, [sessionId]: record } };
  });
}

/** 刷新 lastSeenAt（不改变 enabledAt / source）。 */
export function touchSession(sessionId, options = {}) {
  if (!usableId(sessionId)) return { ok: false, changed: false };
  const file = options.file ?? sessionsPath();
  const now = options.now ?? Date.now();
  return mutate(file, now, (store) => {
    const previous = store.sessions[sessionId];
    if (previous === undefined) return store;
    if (now - previous.lastSeenAt < 60 * 1000) return store; // 一分钟内的重复刷新没有信息量，省磁盘写
    return { ...store, sessions: { ...store.sessions, [sessionId]: { ...previous, lastSeenAt: now } } };
  });
}

/** 忘掉一个会话（用户显式关团，或会话记录已无意义）。 */
export function markDisabled(sessionId, options = {}) {
  if (!usableId(sessionId)) return { ok: false, changed: false };
  const file = options.file ?? sessionsPath();
  const now = options.now ?? Date.now();
  return mutate(file, now, (store) => {
    if (store.sessions[sessionId] === undefined) return store;
    const sessions = { ...store.sessions };
    delete sessions[sessionId];
    return { ...store, sessions };
  });
}

/**
 * 这个会话的记录里是不是「开着团队」。过期与坏记录都当没有。
 * @param sessionId - 会话 id。
 * @param options - {file, now}。
 * @returns {boolean}
 */
export function isEnabledSession(sessionId, options = {}) {
  if (!usableId(sessionId)) return false;
  const file = options.file ?? sessionsPath();
  const now = options.now ?? Date.now();
  return readStore(file, now).sessions[sessionId] !== undefined;
}

/** 只读快照：给状态文件/排查用（含记录数，不含任何会话内容）。 */
export function sessionMemoryStats(options = {}) {
  const file = options.file ?? sessionsPath();
  const store = readStore(file, options.now ?? Date.now());
  return { file, tracked: Object.keys(store.sessions).length, version: store.version };
}
