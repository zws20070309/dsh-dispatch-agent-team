#!/usr/bin/env node
/**
 * history-audit.cjs —— 只读诊断：某个斜杠命令在本机**到底有没有活过**。
 *
 * 为什么需要它：命令删掉之后，**旧会话里已经渲染出来的气泡不会消失**（会话日志是 append-only，
 * `dsh-session/lib/types/surface.js:400` 与 `dsh-session-persistence/lib/index.js:230` 都要求
 * seq 从 0 连续，删事件 = 会话损坏）。所以「页面上还看得到某个命令的输出」既可能是历史记录，
 * 也可能是当前实例真的还注册着它 —— 这两件事必须分开判，判据只有会话日志里的 `command/run`。
 *
 * 用法：
 *   node tools/history-audit.cjs                       # 默认查 team-off
 *   node tools/history-audit.cjs team-off team         # 查多个命令名
 *   node tools/history-audit.cjs --all                 # 列出所有 command/run 的命令名与次数
 *   DSH_HOME=D:\somewhere node tools/history-audit.cjs # 换 DSH 主目录
 *
 * 只读：不写任何文件，不改会话日志，不碰配置。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const LOG_NAME = 'session.v4.jsonl.zstd';

/** DSH 主目录：优先 DSH_HOME，其次 ~/.dsh */
function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
}

/** 会话日志是「多个 zstd 帧首尾相接」的文件，Node 的 zstdDecompressSync 只解第一帧 → 自己切帧 */
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

/** 插件 host 半的最新改动时间：用来判「这条记录是不是在现行代码之前」 */
function newestHostMtime(pluginRoot) {
  let newest = 0;
  const libDir = path.join(pluginRoot, 'lib');
  for (const name of fs.readdirSync(libDir)) {
    if (!name.endsWith('.js')) continue;
    newest = Math.max(newest, fs.statSync(path.join(libDir, name)).mtimeMs);
  }
  return newest;
}

function main() {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    console.log('本机 node 不支持 zstd（需要 Node ≥ 22.15）。用 DSH 自带的那份跑（<安装目录> 换成你的 DeepSeek Harness 安装位置）：');
    console.log('  "<安装目录>\\resources\\bin\\node.exe" tools\\history-audit.cjs');
    process.exit(2);
  }

  const argv = process.argv.slice(2);
  const listAll = argv.includes('--all');
  const names = argv.filter((a) => !a.startsWith('--'));
  if (names.length === 0 && !listAll) names.push('team-off');

  const sessionsRoot = path.join(dshHome(), 'sessions');
  const logs = walkLogs(sessionsRoot);
  if (logs.length === 0) {
    console.log(`读不到会话日志目录：${sessionsRoot}`);
    console.log('（如果 DSH 主目录不在 ~/.dsh，用 DSH_HOME=... 指过去）');
    process.exit(1);
  }

  const runs = []; // {name, args, seq, time, session}
  const counters = new Map(); // 命令名 -> 次数（--all 用）
  for (const file of logs) {
    let text;
    try {
      text = decodeSessionLog(file);
    } catch {
      continue;
    }
    const session = path.basename(path.dirname(file));
    for (const line of text.split('\n')) {
      if (!line.includes('"command/run"')) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type !== 'command/run' || typeof event.data?.name !== 'string') continue;
      counters.set(event.data.name, (counters.get(event.data.name) ?? 0) + 1);
      if (names.includes(event.data.name)) {
        runs.push({
          name: event.data.name,
          args: typeof event.data.args === 'string' ? event.data.args.trim() : '',
          seq: event.seq,
          time: event.time,
          session,
        });
      }
    }
  }

  console.log(`会话日志：${logs.length} 份（${sessionsRoot}）`);
  if (listAll) {
    console.log('\n本机出现过的全部斜杠命令：');
    for (const [name, count] of [...counters.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(6)} 次  /${name}`);
    }
    return;
  }

  runs.sort((a, b) => a.time - b.time);
  console.log(`\n查询：${names.map((n) => '/' + n).join(' , ')}`);
  if (runs.length === 0) {
    console.log('  本机**没有任何一次**调用记录 → 这个命令在当前代码里不存在（页面上的旧气泡只能是历史）。');
    return;
  }

  const pluginRoot = path.resolve(__dirname, '..');
  const codeTime = newestHostMtime(pluginRoot);
  console.log(`  共 ${runs.length} 次调用：`);
  for (const run of runs) {
    console.log(`  ${fmt(run.time)}  seq=${String(run.seq).padStart(4)}  /${run.name}${run.args ? ' ' + run.args : ''}  ${run.session}`);
  }

  const latest = runs[runs.length - 1];
  console.log(`\n最后一次：${fmt(latest.time)}（${latest.session}）`);
  console.log(`现行宿主代码最新改动：${fmt(codeTime)}（${path.join(pluginRoot, 'lib')}）`);
  if (latest.time <= codeTime) {
    console.log('判定：所有记录都**早于**现行代码 → 这些只可能是历史残留，现行实例不会再产生新的。');
  } else {
    console.log('判定：有记录**晚于**现行代码 → 当前运行实例仍在注册这个命令，需要按 file:line 排查注册点。');
  }
}

main();
