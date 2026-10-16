#!/usr/bin/env node
/**
 * cache-prefix-audit.cjs —— **只读**：从会话日志量化「提示词前缀能不能命中缓存」。
 *
 * 为什么要有这个脚本：DeepSeek 类前缀缓存只认「完整匹配一个已落盘的缓存前缀单元」，
 * 所以一次请求能不能命中，取决于它上一轮的**整段前缀**（system + 工具清单 + 历史）有没有
 * 一字不变地重复过。这件事无法从面板看出来，只能对着真实发出去的字节算 —— 本脚本就算这个。
 *
 * 它读什么：~/.dsh/sessions/<slug>/<session>/session.v4.jsonl.zstd（多个 zstd 帧首尾相接，
 * Node 的 zstdDecompressSync 只解第一帧，所以自己按 magic 切帧 —— 与 tools/session-probe.cjs
 * 同款逻辑）。用到三类事件：
 *   * system/message      —— 宿主**实际发出去**的那份 system 文本的快照（变化时才记一条）
 *   * request/header      —— 每次请求的装配头（provider/model + 工具数组）
 *   * user|assistant|tool —— 历史正文（用来估「这段前值多少钱」：断裂时丢掉的就是它）
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

const args = process.argv.slice(2);
const all = args.includes('--all');
const tailAt = args.indexOf('--tail');
const tail = tailAt >= 0 ? Number(args[tailAt + 1]) : 40;

const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions');
if (!fs.existsSync(sessionsRoot)) {
  console.log('读不到会话目录：' + sessionsRoot);
  process.exit(0);
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
  let system = '';
  let history = 0;
  const perRequest = [];
  for (const event of events) {
    if (event.type === 'system/message') system = textOf(event.data.message);
    else if (event.type === 'request/header') {
      const tools = event.data.header.tools || [];
      perRequest.push({
        seq: event.seq,
        reason: event.data.reason,
        model: String(event.data.header.config && event.data.header.config.model),
        ntools: tools.length,
        toolsBytes: JSON.stringify(tools).length,
        system,
        systemBytes: system.length,
        history,
      });
    } else {
      const message = event.data && event.data.message;
      if (message && (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result')) {
        history += textOf(message).length;
      }
    }
  }
  if (perRequest.length === 0) continue;
  rows.push({ dir: path.basename(path.dirname(file)), mtime: fs.statSync(file).mtimeMs, requests: perRequest });
}

rows.sort((a, b) => b.mtime - a.mtime);
const picked = Number.isFinite(tail) && tail > 0 ? rows.slice(0, tail) : rows;

let pairs = 0;
let fullReuse = 0;
let systemBreak = 0;
let toolsBreak = 0;
let hitSum = 0;
let totalSum = 0;
let pinnedRequests = 0;
let worstLoss = 0;
const perSession = [];

for (const row of picked) {
  const reqs = row.requests;
  let sessFull = 0;
  let sessBreak = 0;
  for (let i = 1; i < reqs.length; i += 1) {
    const prev = reqs[i - 1];
    const cur = reqs[i];
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
  if (reqs.some((r) => r.system.includes(PIN))) pinnedRequests += 1;
  perSession.push({ dir: row.dir, n: reqs.length, full: sessFull, breaks: sessBreak,
    systemBytes: reqs[reqs.length - 1].systemBytes, pinned: reqs[reqs.length - 1].system.includes(PIN) });
}

console.log('会话（' + (all ? '全部' : '本插件队员') + '）= ' + picked.length + ' 个，相邻请求对 = ' + pairs);
console.log('  前缀完整可复用 = ' + fullReuse + (pairs ? ' (' + (fullReuse / pairs * 100).toFixed(1) + '%)' : ''));
console.log('  system 断裂    = ' + systemBreak + (pairs ? ' (' + (systemBreak / pairs * 100).toFixed(1) + '%)' : ''));
console.log('  tools 断裂     = ' + toolsBreak + (pairs ? ' (' + (toolsBreak / pairs * 100).toFixed(1) + '%)' : ''));
if (pairs > 0) {
  console.log('  字节加权理论命中率 = ' + (hitSum / totalSum * 100).toFixed(1) + '%   （单次最大损失 = ' + worstLoss.toLocaleString('en-US') + ' 字符）');
}
console.log('  已用上新 persona 钉住的会话 = ' + pinnedRequests + ' 个（钉住的文本出现在 system 里 = 新代码已经在跑）');
console.log('');
console.log('明细（最近 25 个会话）：');
for (const s of perSession.slice(0, 25)) {
  console.log('  ' + s.dir.slice(0, 22) + '  请求=' + s.n + '  完整复用=' + s.full + '  断裂=' + s.breaks
    + '  system=' + s.systemBytes + 'B  persona钉住=' + (s.pinned ? '是' : '否'));
}
if (pinnedRequests === 0 && !all) {
  console.log('');
  console.log('提示：没有一个会话的 system 里出现钉住的那句 persona —— 说明跑这些队员的还是旧代码。');
  console.log('      本包改的是宿主半（lib/*.js），要**重启 DSH** 才生效；重启后重派队员再看这里。');
}
process.exit(0);
