#!/usr/bin/env node
/**
 * session-probe.cjs —— 只读诊断：从会话日志里**只抽团队调度相关的事实**，不打印正文。
 *
 * 为什么需要它：会话日志一份几万行，把整份塞进上下文既贵又没用。而“团队到底怎么跑的”
 * 只取决于少数几类事件：命令调用、请求头（工具面变化）、工具调用、结束原因、开发消息。
 * 本工具把这些抽成一行一条的紧凑时间线。
 *
 * 用法：
 *   node tools/session-probe.cjs --types                      # 事件类型直方图（先看有什么）
 *   node tools/session-probe.cjs --sessions                   # 列出所有会话日志与大小
 *   node tools/session-probe.cjs --team --session <子串>       # 团队时间线（默认最近一份）
 *   node tools/session-probe.cjs --tools --session <子串>      # 请求头工具面增删时间线
 *   node tools/session-probe.cjs --calls --session <子串>      # 工具调用时间线（团队工具高亮）
 *   node tools/session-probe.cjs --stops --session <子串>      # 结束原因（截断/输出上限）
 *   node tools/session-probe.cjs --dump <eventType> --limit 3 # 看某类事件的原始形状（截断打印）
 *   DSH_HOME=D:\x node tools/session-probe.cjs ...
 *
 * 只读：不写文件、不改日志、不碰配置。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const LOG_NAME = 'session.v4.jsonl.zstd';

/** 团队工具名（含官方同名单，用于时间线高亮）。 */
const TEAM_TOOL_NAMES = new Set([
  'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_list', 'team_task_update', 'team_task_get',
  'report_result', 'enable_agent_team', 'disable_agent_team', 'wake_teammate',
]);

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
}

/** 会话日志是「多个 zstd 帧首尾相接」，Node 的 zstdDecompressSync 只解第一帧 → 自己切帧。 */
function decodeSessionLog(file) {
  const buf = fs.readFileSync(file);
  const offsets = [];
  let cursor = 0;
  for (;;) {
    const at = buf.indexOf(ZSTD_MAGIC, cursor);
    if (at < 0) break;
    offsets.push(at);
    cursor = at + ZSTD_MAGIC.length;
  }
  const parts = [];
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)));
    } catch {
      /* 半个帧（写入中断残留）跳过 */
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

function walkLogs(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkLogs(full, out);
    else if (entry.name === LOG_NAME) out.push(full);
  }
  return out;
}

function fmt(time) {
  if (typeof time !== 'number') return '(无时间)';
  return new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function clip(text, max) {
  const one = String(text ?? '').replace(/\s+/g, ' ');
  return one.length <= max ? one : one.slice(0, max) + '…';
}

/** 读一份日志的所有事件（跳过坏行）。 */
function readEvents(file) {
  const text = decodeSessionLog(file);
  const events = [];
  for (const line of text.split('\n')) {
    if (line === '' || line[0] !== '{') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* 坏行跳过 */
    }
  }
  events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return events;
}

/** 从任意事件里挖出模型结束原因（不同版本字段名不同，全部兼容）。 */
function finishReasonOf(event) {
  const data = event?.data ?? {};
  const message = data.message ?? data;
  return data.finishReason ?? data.stopReason ?? message?.finishReason ?? message?.stopReason ?? message?.stop_reason;
}

function toolNamesOfHeader(header) {
  const tools = header?.tools ?? header?.data?.header?.tools;
  return Array.isArray(tools)
    ? tools.map((tool) => (typeof tool === 'string' ? tool : tool?.name)).filter((name) => typeof name === 'string')
    : [];
}

function headerOf(event) {
  return event?.data?.header ?? event?.data ?? {};
}

function blockNames(content) {
  if (!Array.isArray(content)) return [];
  const names = [];
  for (const block of content) {
    if (block?.type === 'tool-call' || block?.type === 'tool-use' || block?.type === 'tool_use') {
      const name = block.name ?? block.toolName;
      if (typeof name === 'string') names.push(name);
    }
  }
  return names;
}

/** assistant/message 里的工具块名字（兼容 content 直接是数组 / 在 message 下两种形状）。 */
function toolCallNamesOfMessage(event) {
  const data = event?.data ?? {};
  return [...blockNames(data.content), ...blockNames(data.message?.content)];
}

function latestLog(logs) {
  return [...logs].sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function main() {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    console.log('本机 node 不支持 zstd（需要 Node ≥ 22.15）。');
    process.exit(2);
  }
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(name);
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
  };
  const limit = Number.parseInt(value('--limit') ?? '5', 10);

  const sessionsRoot = path.join(dshHome(), 'sessions');
  let logs = walkLogs(sessionsRoot);
  if (logs.length === 0) {
    console.log(`读不到会话日志目录：${sessionsRoot}`);
    process.exit(1);
  }

  if (flag('--sessions')) {
    console.log(`会话日志 ${logs.length} 份（${sessionsRoot}）：`);
    for (const file of [...logs].sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)) {
      const stat = fs.statSync(file);
      console.log(`  ${fmt(stat.mtimeMs)}  ${String(stat.size).padStart(9)}B  ${path.basename(path.dirname(file))}`);
    }
    return;
  }

  const filter = value('--session');
  if (typeof filter === 'string' && filter !== '') {
    logs = logs.filter((file) => file.includes(filter));
    if (logs.length === 0) {
      console.log(`没有匹配 --session ${filter} 的日志`);
      process.exit(1);
    }
  } else {
    logs = [latestLog(logs)];
  }

  const grepText = value('--grep');
  if (typeof grepText === 'string' && grepText !== '') {
    // 跨会话字面量检索（跳过 --session 过滤）：先解压再 indexOf，命中数按会话聚合。
    const all = walkLogs(sessionsRoot);
    let sessions = 0;
    for (const file of all) {
      let text;
      try { text = decodeSessionLog(file); } catch { continue; }
      let count = 0;
      let from = 0;
      for (;;) {
        const at = text.indexOf(grepText, from);
        if (at < 0) break;
        count += 1;
        from = at + grepText.length;
      }
      if (count === 0) continue;
      sessions += 1;
      console.log(`  ${String(count).padStart(5)}  ${path.basename(path.dirname(file))}  (${fmt(fs.statSync(file).mtimeMs)})`);
    }
    console.log(`含 "${grepText}" 的会话 ${sessions} 份 / 共扫 ${all.length} 份`);
    return;
  }

  if (flag('--models')) {
    // 「队员到底用的哪个模型」：assistant/message 的 source 里带着**每一条回答的真实 provider/model**
    // （dsh-agent-loop 把它写成 {kind:'model', provider, model}），比 model/selection 更接近事实
    // （后者是会话的选择事件，可能被覆盖多次）。团队成员的会话 id = 其 agent id（agent.id === session.id），
    // 所以从 Lead 的 team/member 事件里取出成员 id，就能逐个对比 Lead 与每个队员实际跑的模型。
    const byId = new Map();
    for (const file of walkLogs(sessionsRoot)) byId.set(path.basename(path.dirname(file)), file);
    for (const file of logs) {
      const seedId = path.basename(path.dirname(file));
      const events = readEvents(file);
      const memberIds = [];
      for (const event of events) {
        if (event.type !== 'team/member') continue;
        const member = event.data?.member;
        if (member !== undefined && typeof member.id === 'string' && !memberIds.includes(member.id)) memberIds.push(member.id);
      }
      const summarize = (id, target) => {
        const list = readEvents(target);
        const answers = new Map();
        const selections = new Map();
        /** 按时间顺序的「模型连续段」：换模型那一刻就是关键证据（谁在什么时候切换了）。 */
        const runs = [];
        for (const event of list) {
          if (event.type === 'assistant/message') {
            const source = event.data?.message?.source;
            const key = `${String(source?.provider ?? '?')}/${String(source?.model ?? '?')}`;
            answers.set(key, (answers.get(key) ?? 0) + 1);
            const last = runs[runs.length - 1];
            if (last !== undefined && last.key === key) last.count += 1;
            else runs.push({ key, count: 1, at: event.time });
          }
          if (event.type === 'model/selection') {
            const key = `${String(event.data?.provider ?? '?')}/${String(event.data?.model ?? '?')}${event.data?.reasoningEffort === undefined ? '' : ` (${String(event.data.reasoningEffort)})`}`;
            selections.set(key, (selections.get(key) ?? 0) + 1);
          }
        }
        const fmtCounts = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => `${key}×${count}`).join(', ') || '(无)';
        console.log(`  ${id === seedId ? 'Lead ' : '队员 '}${id}`);
        console.log(`        实际回答用的模型：${fmtCounts(answers)}`);
        console.log(`        model/selection：${fmtCounts(selections)}`);
        if (runs.length > 1) {
          const shown = runs.length <= 8 ? runs : [...runs.slice(0, 4), { key: '…', count: 0, at: 0 }, ...runs.slice(-4)];
          console.log(`        换模型时间线：${shown.map((run) => (run.key === '…' ? '…' : `${fmt(run.at)} 起 ${run.key}×${run.count}`)).join(' | ')}`);
        }
      };
      console.log(`\n=== ${seedId} 及其团队成员 ===`);
      summarize(seedId, file);
      for (const id of memberIds) {
        const target = byId.get(id);
        if (target === undefined) { console.log(`  队员 ${id}（找不到会话日志）`); continue; }
        summarize(id, target);
      }
    }
    return;
  }

  if (flag('--counts')) {
    // 只数 `tool/call` 事件（一次真实调用一条）；不要用 assistant 工具块计数，那会把同一次调用算两遍。
    for (const file of logs) {
      const events = readEvents(file);
      const counts = new Map();
      let turns = 0;
      let userMessages = 0;
      let assistantMessages = 0;
      for (const event of events) {
        if (event.type === 'tool/call' && typeof event.data?.name === 'string') {
          counts.set(event.data.name, (counts.get(event.data.name) ?? 0) + 1);
        }
        if (event.type === 'turn/start') turns += 1;
        if (event.type === 'user/message') userMessages += 1;
        if (event.type === 'assistant/message') assistantMessages += 1;
      }
      const team = [...counts.entries()].filter(([name]) => TEAM_TOOL_NAMES.has(name)).sort((a, b) => b[1] - a[1]);
      const teamTotal = team.reduce((sum, [, count]) => sum + count, 0);
      console.log(`\n${path.basename(path.dirname(file))}`);
      console.log(`  turn/start ${turns} · user/message ${userMessages} · assistant/message ${assistantMessages} · tool/call ${[...counts.values()].reduce((a, b) => a + b, 0)}`);
      console.log(`  团队工具调用 ${teamTotal} 次：${team.map(([name, count]) => `${name}×${count}`).join(', ') || '(无)'}`);
      console.log(`  全部工具：${[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}×${count}`).join(', ')}`);
    }
    return;
  }

  if (flag('--types')) {    for (const file of logs) {
      const events = readEvents(file);
      const counts = new Map();
      for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
      console.log(`\n${path.basename(path.dirname(file))} —— ${events.length} 事件`);
      for (const [type, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(count).padStart(6)}  ${type}`);
      }
    }
    return;
  }

  const dumpType = value('--dump');
  if (dumpType !== undefined) {
    for (const file of logs) {
      const events = readEvents(file).filter((event) => event.type === dumpType);
      console.log(`\n${path.basename(path.dirname(file))} —— ${dumpType} × ${events.length}（打 ${Math.min(limit, events.length)} 条）`);
      for (const event of events.slice(0, limit)) {
        console.log(JSON.stringify(event).slice(0, 2400));
        console.log('  ---');
      }
    }
    return;
  }

  for (const file of logs) {
    const events = readEvents(file);
    console.log(`\n=== ${path.basename(path.dirname(file))} · ${events.length} 事件 ===`);

    if (flag('--team') || flag('--tools')) {
      let previous = null;
      console.log('\n[工具面：request/header 变化 + tool-registry 开发消息]');
      for (const event of events) {
        if (event.type === 'request/header') {
          const names = toolNamesOfHeader(headerOf(event));
          const set = new Set(names);
          const reason = event.data?.reason ?? event.data?.header?.reason ?? headerOf(event).reason ?? '?';
          const added = previous === null ? [] : names.filter((name) => !previous.has(name));
          const removed = previous === null ? [] : [...previous].filter((name) => !set.has(name));
          const started = event.data?.startsSeries === true || headerOf(event).startsSeries === true ? ' series' : '';
          const interesting = added.length > 0 || removed.length > 0 || started !== '';
          if (flag('--team') && !interesting && !flag('--names')) continue;
          console.log(
            `  seq=${String(event.seq).padStart(5)} ${fmt(event.time)}  ${reason}${started}  工具 ${names.length} 个`
            + (added.length > 0 ? `  +[${added.join(', ')}]` : '')
            + (removed.length > 0 ? `  -[${removed.join(', ')}]` : ''),
          );
          if (flag('--names')) {
            const team = names.filter((name) => TEAM_TOOL_NAMES.has(name));
            console.log(`        团队工具在位：${team.join(', ') || '(无)'}`);
            console.log(`        全量：${names.join(', ')}`);
          }
          previous = set;
        }
        if (event.type === 'developer/message') {
          const content = event.data?.message?.content ?? [];
          const source = event.data?.message?.source;
          const toolBlocks = Array.isArray(content)
            ? content.filter((block) => block?.type === 'tool-addition' || block?.type === 'tool-removal')
            : [];
          if (toolBlocks.length === 0) continue;
          const added = toolBlocks.filter((b) => b.type === 'tool-addition').map((b) => b.toolName);
          const removed = toolBlocks.filter((b) => b.type === 'tool-removal').map((b) => b.toolName);
          console.log(
            `  seq=${String(event.seq).padStart(5)} ${fmt(event.time)}  开发消息（${source?.kind ?? '?'}）`
            + (added.length > 0 ? `  +[${added.join(', ')}]` : '')
            + (removed.length > 0 ? `  -[${removed.join(', ')}]` : ''),
          );
        }
      }
    }

    if (flag('--team') || flag('--calls')) {
      console.log('\n[工具调用：只列团队工具 + 每次都列的 turn 位置]');
      // 先建 callId → 结果首段 的映射，这样时间线上能直接看出「这次团队工具调用成了没」。
      const results = new Map();
      for (const event of events) {
        if (event.type !== 'tool/result') continue;
        const callId = event.data?.message?.toolCallId ?? event.data?.callId;
        if (typeof callId !== 'string') continue;
        const content = event.data?.message?.content;
        const text = Array.isArray(content)
          ? content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join(' ')
          : '';
        results.set(callId, clip(text, 200));
      }
      let callCount = 0;
      const perName = new Map();
      for (const event of events) {
        const type = event.type;
        if (type === 'tool/call' || type === 'tool-call') {
          const name = event.data?.name ?? event.data?.toolName ?? event.data?.call?.name;
          if (typeof name !== 'string') continue;
          perName.set(name, (perName.get(name) ?? 0) + 1);
          if (TEAM_TOOL_NAMES.has(name)) {
            callCount += 1;
            const input = clip(typeof event.data?.arguments === 'string' ? event.data.arguments : JSON.stringify(event.data?.input ?? {}), 150);
            const result = results.get(event.data?.callId) ?? '(无结果事件)';
            console.log(`  seq=${String(event.seq).padStart(5)} ${fmt(event.time)}  ${name}  ${input}`);
            console.log(`        → ${result}`);
          }
          continue;
        }
        if (type === 'assistant/message') {
          const names = toolCallNamesOfMessage(event);
          for (const name of names) {
            perName.set(name, (perName.get(name) ?? 0) + 1);
            if (TEAM_TOOL_NAMES.has(name)) {
              callCount += 1;
              console.log(`  seq=${String(event.seq).padStart(5)} ${fmt(event.time)}  ${name}（assistant 工具块）`);
            }
          }
        }
      }
      console.log(`  团队工具调用共 ${callCount} 次（含 assistant 工具块重复计数）`);
      const top = [...perName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
      console.log(`  全部工具调用 top：${top.map(([n, c]) => `${n}×${c}`).join(', ') || '(无)'}`);
    }

    if (flag('--team') || flag('--stops')) {
      // 截断的**权威信号**是 `turn/end` 的 `reason.kind === 'max-tokens'`
      // （客户端就是靠它渲染「已达到输出 token 上限」那段提示：dsh-client-ui-chat/lib/client.js
      //  的 turn-max-tokens 贡献，match 条件是 `event.data.reason.kind === "max-tokens"`）。
      console.log('\n[结束原因：turn/end 的 reason.kind（max-tokens = 撞输出上限被截断）]');
      const counts = new Map();
      for (const event of events) {
        if (event.type !== 'turn/end') continue;
        const kind = event.data?.reason?.kind ?? '(无)';
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
        if (kind === 'max-tokens') {
          console.log(`  seq=${String(event.seq).padStart(5)} ${fmt(event.time)}  max-tokens  turn=${event.data?.turn}`);
        }
      }
      for (const [kind, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(count).padStart(5)}  ${kind}`);
      }
    }

    if (flag('--team')) {
      console.log('\n[命令调用 / 用户消息 / 团队开关事件]');
      for (const event of events) {
        if (event.type === 'command/run') {
          console.log(`  seq=${String(event.seq).padStart(5)} ${fmt(event.time)}  /${event.data?.name} ${clip(event.data?.args ?? '', 140)}`);
          continue;
        }
        if (event.type === 'user/message') {
          const content = event.data?.message?.content ?? event.data?.content ?? [];
          const text = Array.isArray(content)
            ? content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ')
            : String(content ?? '');
          if (text.includes('智能体团队') || text.includes('关掉团队') || text.includes('/team')) {
            console.log(`  seq=${String(event.seq).padStart(5)} ${fmt(event.time)}  用户消息：${clip(text, 200)}`);
          }
        }
      }
    }
  }
}

main();
