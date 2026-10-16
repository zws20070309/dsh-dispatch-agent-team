#!/usr/bin/env node
/**
 * cache-prefix-audit.cjs —— **只读**：从会话日志量化「提示词前缀到底命中多少」。
 *
 * 它回答两个**不同**的问题，两个数都要看：
 *   ① 实测命中率 —— 直接读 `assistant/message.data.usage` 里的 cacheReadTokens / inputTokens
 *      （宿主 provider 上报的真值）。公式与 lib/cache.js:262-264 同式：
 *          命中率 = cacheReadTokens / (cacheReadTokens + inputTokens)
 *      这是「缓存到底命中没有」的唯一实测口径。按「这次请求之前 system 有没有变过」分三档：
 *      首次请求 / 前缀变了的那一次 / 其余（前缀没变的续跑）。
 *   ② 装配对模型 —— 不看 usage，只按相邻两次 `request/header`（宿主**装配变化**时才记一条）
 *      的 system 与工具清单是否逐字节相同，推算断裂点在哪一段、值多少字节。它**不是**命中率：
 *      宿主按固定 token 间隔落盘公共前缀，实测命中率通常远高于这个模型。它的用途是**定位断裂点**。
 *
 * 2026-10-17 更正（本脚本第一版的错，留在这里以免再犯）：第一版只有 ②，我据此在会话里对用户
 * 说过「会话日志里没有 usage 字段，拿不到实测命中率，只能做理论分析」—— 那是**假话**。
 * `assistant/message.data.usage` 一直带 cacheReadTokens：本机 143 个队员会话共 8606 条
 * assistant/message，其中 8603 条带 usage、8041 条带 cacheReadTokens；本包自己的 lib/graph.js:168 与
 * lib/cache.js:240 也一直在读它。所以「理论命中率 27.6%」被当成了缓存现状汇报，而同一批会话的
 * **实测**命中率是 94.9%（8603 次带 usage 的请求；最近 40 个会话那一档是 96.8%）。
 * 现在 ① 是主口径，② 退回到它真正的用途：定位断裂点。
 *
 * 另一个必须写下来的事实（第一版把 ② 的数说成「相邻请求对」，错了）：`request/header` 不是每个
 * 请求都记，而是**装配变化时**才记 —— 实测 session-00001011 有 7 条 assistant/message（7 次请求）
 * 但只有 2 条 request/header（initial + change）。所以 ② 的数只能叫「相邻装配对」，它衡量的是
 * 「换装配有多频繁、每次损失多大」，不能当请求数用。① 才是按请求算的。
 *
 * 它读什么：~/.dsh/sessions/<slug>/<session>/session.v4.jsonl.zstd（多个 zstd 帧首尾相接，
 * Node 的 zstdDecompressSync 只解第一帧，所以自己按 magic 切帧 —— 与 tools/session-probe.cjs
 * 同款逻辑）。用到四类事件：
 *   * system/message      —— 宿主**实际发出去**的那份 system 文本的快照（变化时才记一条）
 *   * request/header      —— 每次**装配**的头（provider/model + 工具数组）
 *   * assistant/message   —— 每次**请求**的 usage（实测命中率的唯一来源）
 *   * user|assistant|tool —— 历史正文（用来估「这段前缀值多少字节」）
 *
 * 只读：不改任何文件、不发消息、不跑任务。加 --all 连非本插件的会话一起看；
 * 加 --tail N 只看最近 N 个会话（默认 40）。
 *
 * 用法：
 *   node tools/cache-prefix-audit.cjs                 # 本插件队员会话，最近 40 个
 *   node tools/cache-prefix-audit.cjs --all --tail 200
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const MARKER = '智能体团队的一名队员';   // 本插件队员卡的开头（lib/playbook.js 的 TEAMMATE_CARD）
const PIN = 'You are a coding agent.';   // 本包钉住的 persona（lib/roster.js 的 MEMBER_PERSONA_PIN）

function decodeSessionLog(file) {
  const buf = fs.readFileSync(file);
  const events = [];
  let cursor = 0;
  for (;;) {
    const at = buf.indexOf(ZSTD_MAGIC, cursor);
    if (at < 0) break;
    const next = buf.indexOf(ZSTD_MAGIC, at + 4);
    const end = next < 0 ? buf.length : next;
    cursor = end;
    try {
      const text = zlib.zstdDecompressSync(buf.subarray(at, end)).toString('utf8');
      for (const line of text.split(String.fromCharCode(10))) {
        const t = line.trim();
        if (t === '') continue;
        try { events.push(JSON.parse(t)); } catch (error) { /* 半行：末尾未闭合，忽略 */ }
      }
    } catch (error) { /* 不完整帧：跳过这一帧 */ }
  }
  return events;
}

function textOf(message) {
  if (message === undefined || message === null) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part.text === 'string' ? part.text : '')).join('');
  return '';
}

function lcpBytes(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.codePointAt(i) === b.codePointAt(i)) i += 1;
  return i;
}

/** 一次 provider 上报的 usage → {hit, miss}。miss 用 inputTokens（未命中那部分），与
 *  lib/cache.js:239-244 的读法一致；缺字段按 0。
 *
 *  **这是本脚本唯一的实测来源**：把它拆成独立函数是为了能被断言（见下 module.exports 与
 *  tools/selftest.cjs 那条行为门）。第一版没有这个函数，实测口径整个缺失。
 *  @param {object} event - 一条 assistant/message 事件。
 *  @returns {{hit:number, miss:number}|undefined} 没有 usage 时 undefined。
 */
function usageOf(event) {
  const usage = event.data === undefined || event.data === null ? undefined : event.data.usage;
  if (usage === undefined || usage === null) return undefined;
  const hit = Number.isFinite(Number(usage.cacheReadTokens)) ? Number(usage.cacheReadTokens) : 0;
  const miss = Number.isFinite(Number(usage.inputTokens)) ? Number(usage.inputTokens) : 0;
  return { hit, miss };
}

/** 命中率 = hit / (hit + miss)。**必须与 lib/cache.js:262-264 同式**（那里是
 *  stats.cacheReadTokens / (stats.cacheReadTokens + stats.uncachedInputTokens)）。
 *  分母为 0 时回 null（调用方渲染成「—」），不编一个 0% 出来。
 *  @param {{hit:number,miss:number}} b - 任意 {hit,miss} 桶。
 *  @returns {number|null} 0~100 的百分数。
 */
function hitRateOf(b) {
  const total = b.hit + b.miss;
  return total > 0 ? b.hit / total * 100 : null;
}

/** 把**一个会话**的事件流折成请求/装配两份表。纯函数：不读文件、不写任何东西。
 *  selftest 用它做行为断言（喂真形状的事件、看实测命中率算不算得出来）。
 *  @param {Array<object>} events - 该会话按 seq 升序的事件。
 *  @returns {{requests:Array<object>, headers:Array<object>}} 见下面字段说明。
 */
function summarizeSession(events) {
  let system = '';
  let history = 0;
  let sysVersion = -1;         // 每变一次 system 就 +1
  let sysChangedSinceRequest = false;
  const requests = [];         // 每次**请求**（assistant/message 带 usage）一条
  const headers = [];          // 每次**装配**（request/header）一条
  let usageMissing = 0;        // 带 message 但没有 usage 的 assistant/message 条数（如实计入，不当 0 命中）
  let requestIndex = 0;
  for (const event of events) {
    if (event.type === 'system/message') {
      const next = textOf(event.data.message);
      if (next !== system) { system = next; sysVersion += 1; sysChangedSinceRequest = true; }
      continue;
    }
    if (event.type === 'request/header') {
      const tools = event.data.header.tools || [];
      headers.push({
        seq: event.seq,
        reason: event.data.reason,
        model: String(event.data.header.config && event.data.header.config.model),
        ntools: tools.length,
        toolsBytes: JSON.stringify(tools).length,
        system,
        systemBytes: system.length,
        history,
        sysVersion,
      });
      continue;
    }
    if (event.type === 'assistant/message') {
      const u = usageOf(event);
      if (u === undefined) usageMissing += 1;
      if (u !== undefined) {
        requestIndex += 1;
        requests.push({
          seq: event.seq,
          index: requestIndex,
          hit: u.hit,
          miss: u.miss,
          system,
          systemBytes: system.length,
          sysVersion,
          afterSystemChange: sysChangedSinceRequest,
        });
        sysChangedSinceRequest = false;
      }
    }
    const message = event.data && event.data.message;
    if (message && (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result')) {
      history += textOf(message).length;
    }
  }
  return { requests, headers, usageMissing };
}

/** 扫描 + 汇报。包成函数是为了让本文件能被 require 而不产生副作用（selftest 只取纯函数）。 */
function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const tailAt = args.indexOf('--tail');
  const tail = tailAt >= 0 ? Number(args[tailAt + 1]) : 40;

  const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions');
  if (!fs.existsSync(sessionsRoot)) {
    console.log('读不到会话目录：' + sessionsRoot);
    return;
  }

const files = [];
(function walk(dir, depth) {
  if (depth > 3) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, depth + 1);
    else if (entry.name === 'session.v4.jsonl.zstd') files.push(full);
  }
})(sessionsRoot, 0);

const rows = [];
for (const file of files) {
  let events;
  try { events = decodeSessionLog(file); } catch (error) { continue; }
  const isMember = events.some((e) => e.type === 'system/message' && textOf(e.data.message).includes(MARKER));
  if (!all && !isMember) continue;
  events.sort((a, b) => a.seq - b.seq);
  const { requests, headers, usageMissing } = summarizeSession(events);
  if (requests.length === 0 && headers.length === 0) continue;
  const versions = new Set(requests.map((r) => r.system)).size;
  rows.push({ dir: path.basename(path.dirname(file)), mtime: fs.statSync(file).mtimeMs, requests, headers, versions, usageMissing });
}

rows.sort((a, b) => b.mtime - a.mtime);
const picked = Number.isFinite(tail) && tail > 0 ? rows.slice(0, tail) : rows;

// ── ① 实测命中率（唯一真口径，按请求算）───────────────────────────────────────
const zero = () => ({ hit: 0, miss: 0, n: 0 });
const real = { total: zero(), first: zero(), afterFlip: zero(), steady: zero(), usageMissing: 0 };
for (const row of picked) {
  real.usageMissing += row.usageMissing;
  for (const r of row.requests) {
    const bucket = r.index === 1 ? real.first : (r.afterSystemChange ? real.afterFlip : real.steady);
    bucket.hit += r.hit;
    bucket.miss += r.miss;
    bucket.n += 1;
    real.total.hit += r.hit;
    real.total.miss += r.miss;
    real.total.n += 1;
  }
}
// 展示用：与 lib/cache.js 同式（走 hitRateOf），没有分母时渲染「—」而不是编一个 0%。
const pctOf = (b) => {
  const pct = hitRateOf(b);
  return pct === null ? '—' : pct.toFixed(1) + '%';
};

// ── ② 装配对模型（定位断裂点用，不是命中率）──────────────────────────────────
let pairs = 0;
let fullReuse = 0;
let systemBreak = 0;
let toolsBreak = 0;
let hitSum = 0;
let totalSum = 0;
let pinnedSessions = 0;
let worstLoss = 0;
const perSession = [];

for (const row of picked) {
  const hs = row.headers;
  let sessFull = 0;
  let sessBreak = 0;
  for (let i = 1; i < hs.length; i += 1) {
    const prev = hs[i - 1];
    const cur = hs[i];
    const prevWire = prev.systemBytes + prev.toolsBytes + prev.history;
    pairs += 1;
    totalSum += prevWire;
    let hit;
    if (prev.system !== cur.system) {
      systemBreak += 1;
      sessBreak += 1;
      hit = lcpBytes(prev.system, cur.system);           // 从 system 分叉处起后面全不算
    } else if (prev.toolsBytes !== cur.toolsBytes || prev.ntools !== cur.ntools) {
      toolsBreak += 1;
      sessBreak += 1;
      hit = prev.systemBytes;                            // tools 段还在 system 之后，system 整段仍可用
    } else {
      fullReuse += 1;
      sessFull += 1;
      hit = prevWire;                                    // 纯追加：上一轮整段前缀都能复用
    }
    hitSum += hit;
    if (prevWire - hit > worstLoss) worstLoss = prevWire - hit;
  }
  if (row.requests.some((r) => r.system.includes(PIN))) pinnedSessions += 1;
  const lastSys = hs.length > 0 ? hs[hs.length - 1].systemBytes : (row.requests.length > 0 ? row.requests[row.requests.length - 1].systemBytes : 0);
  const pinned = (hs.length > 0 ? hs[hs.length - 1].system : (row.requests.length > 0 ? row.requests[row.requests.length - 1].system : '')).includes(PIN);
  perSession.push({ dir: row.dir, n: row.requests.length, assemblies: hs.length, full: sessFull, breaks: sessBreak,
    versions: row.versions, systemBytes: lastSys, pinned });
}

const label = all ? '全部' : '本插件队员';
console.log('会话（' + label + '）= ' + picked.length + ' 个'
  + (all ? '' : '，其中 system 出现过多版本 = ' + picked.filter((r) => r.versions > 1).length + ' 个'));
console.log('');
console.log('① 实测命中率（读 assistant/message.usage；公式同 lib/cache.js:262-264）');
console.log('  总体          = ' + pctOf(real.total) + '   请求数 ' + real.total.n
  + '（命中 ' + real.total.hit.toLocaleString('en-US') + ' / 未命中 ' + real.total.miss.toLocaleString('en-US') + '）');
console.log('  第一次请求    = ' + pctOf(real.first) + '   请求数 ' + real.first.n);
console.log('  前缀变了的请求 = ' + pctOf(real.afterFlip) + '   请求数 ' + real.afterFlip.n + '   ← persona/装配翻面落在这一档');
console.log('  前缀没变的请求 = ' + pctOf(real.steady) + '   请求数 ' + real.steady.n);
if (real.usageMissing > 0) {
  console.log('  注：另有 ' + real.usageMissing + ' 条 assistant/message 不带 usage —— 没有测量就是没有测量，未按 0 计入上面任何一档');
}
console.log('');
console.log('② 装配对模型（只看字节是否相同，用来定位断裂点；不是命中率）');
console.log('  相邻装配对 = ' + pairs);
console.log('  前缀完整可复用 = ' + fullReuse + (pairs ? ' (' + (fullReuse / pairs * 100).toFixed(1) + '%)' : ''));
console.log('  system 断裂    = ' + systemBreak + (pairs ? ' (' + (systemBreak / pairs * 100).toFixed(1) + '%)' : ''));
console.log('  tools 断裂     = ' + toolsBreak + (pairs ? ' (' + (toolsBreak / pairs * 100).toFixed(1) + '%)' : ''));
if (pairs > 0) {
  console.log('  字节加权复用率 = ' + (hitSum / totalSum * 100).toFixed(1) + '%   （单次最大损失 = ' + worstLoss.toLocaleString('en-US') + ' 字符）');
}
console.log('  已用上新 persona 钉住的会话 = ' + pinnedSessions + ' 个（钉住的文本出现在 system 里 = 新代码已经在跑）');
console.log('');
console.log('明细（最近 25 个会话）：');
for (const s of perSession.slice(0, 25)) {
  console.log('  ' + s.dir.slice(0, 22) + '  请求=' + s.n + '  装配=' + s.assemblies + '  system版本=' + s.versions
    + '  完整复用=' + s.full + '  断裂=' + s.breaks + '  system=' + s.systemBytes + 'B  persona钉住=' + (s.pinned ? '是' : '否'));
}
if (pinnedSessions === 0 && !all) {
  console.log('');
    console.log('提示：没有一个会话的 system 里出现钉住的那句 persona —— 说明跑这些队员的还是旧代码。');
    console.log('      本包改的是宿主半（lib/*.js），要**重启 DSH** 才生效；重启后重派队员再看这里。');
  }
}

if (require.main === module) main();

// 纯函数导出：selftest 直接调它们做行为断言。
// 为什么必须导出：第一版的闸门是扫源码文本（"有没有出现 cacheReadTokens"），我把它保护的那句
// `const u = usageOf(event)` 改成 `const u = undefined` 后闸门照样绿 —— 文本门会被「读了但没用」骗过。
module.exports = { usageOf, hitRateOf, summarizeSession, lcpBytes, textOf, decodeSessionLog };
