#!/usr/bin/env node
/**
 * asar-probe.cjs —— 只读：在官方桌面端的 `app.asar` 里查文件与字符串。
 *
 * 为什么需要它：本插件的判据**必须**是运行中那一版官方代码，而不是记忆或旧笔记。
 * 但 `app.asar` 是归档文件：`rg`/`glob`/`read` 都进不去（`read` 会报
 * `Cannot mix BigInt and other types`），于是每次都要临时写脚本解包 —— 这个文件把
 * 那件事固化下来，官方升级后可以直接复核（见 MAINTAINER-NOTES.md）。
 *
 * 用法：
 *   node tools/asar-probe.cjs --list "dsh-llm/"                  # 列出匹配的条目
 *   node tools/asar-probe.cjs --grep "llm/stream"                # 哪些文件含这个字符串
 *   node tools/asar-probe.cjs --grep "cacheReadTokens" --list "dsh-agent/"
 *   node tools/asar-probe.cjs --extract "dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js" out.js
 *   node tools/asar-probe.cjs --version                          # 宿主版本
 *
 * 选项：
 *   --asar <path>   指定 app.asar（默认自动找 DeepSeek Harness 的安装目录）
 *   --list <regex>  只对路径匹配的条目做后续处理
 *   --grep <text>   在条目内容里找字符串（UTF-8），输出 `路径:出现次数`
 *   --extract <p> <dest>  把某个条目写到磁盘（用于精读）
 *   --max <n>       最多输出多少行（默认 40）
 *
 * 只读：除了 --extract 明确指定的目标文件外不写任何东西。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_ASAR = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
  'Programs',
  'DeepSeek Harness',
  'resources',
  'app.asar',
);

function parseArgs(argv) {
  const out = { list: null, grep: null, extract: null, dest: null, asar: null, max: 40, version: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') out.list = argv[++i];
    else if (arg === '--grep') out.grep = argv[++i];
    else if (arg === '--asar') out.asar = argv[++i];
    else if (arg === '--max') out.max = Number(argv[++i]);
    else if (arg === '--version') out.version = true;
    else if (arg === '--extract') {
      out.extract = argv[++i];
      out.dest = argv[++i];
    } else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

/** asar 头：| u32 4 | u32 headerPickleSize | u32 payloadLen | u32 jsonLen | json |，数据区从 8 + headerPickleSize 开始 */
function readArchive(asarPath) {
  const buf = fs.readFileSync(asarPath);
  const headerSize = buf.readUInt32LE(4);
  const dataBase = 8 + headerSize;
  const jsonLen = buf.readUInt32LE(12);
  const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'));
  return { buf, dataBase, header, unpackedRoot: `${asarPath}.unpacked` };
}

function readEntry(archive, prefix, node) {
  if (node.unpacked) return fs.readFileSync(path.join(archive.unpackedRoot, prefix));
  const off = archive.dataBase + Number(node.offset);
  return archive.buf.subarray(off, off + node.size);
}

function entries(archive) {
  const out = [];
  const walk = (node, prefix) => {
    if (!node || typeof node !== 'object') return;
    if (node.files) {
      for (const [name, child] of Object.entries(node.files)) walk(child, prefix ? `${prefix}/${name}` : name);
      return;
    }
    if (typeof node.size === 'number') out.push({ prefix, node });
  };
  walk(archive.header, '');
  return out;
}

function hostVersion(archive) {
  try {
    const pkg = JSON.parse(readEntry(archive, 'package.json', findNode(archive, 'package.json')).toString('utf8'));
    return pkg.version ?? '(no version)';
  } catch {
    return '(unreadable)';
  }
}

function findNode(archive, prefix) {
  return entries(archive).find((e) => e.prefix === prefix)?.node;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    return;
  }
  const asarPath = args.asar ?? DEFAULT_ASAR;
  if (!fs.existsSync(asarPath)) {
    console.log(`找不到 app.asar：${asarPath}`);
    console.log('用 --asar <路径> 指定，或确认桌面端装在默认位置。');
    process.exit(1);
  }
  const archive = readArchive(asarPath);
  const all = entries(archive);
  console.log(`asar: ${asarPath}`);
  console.log(`宿主版本: ${hostVersion(archive)} · 条目 ${all.length} 个`);

  if (args.version && args.grep === null && args.list === null && args.extract === null) return;

  if (args.extract !== null) {
    const found = all.find((e) => e.prefix === args.extract);
    if (found === undefined) {
      console.log(`没有这个条目：${args.extract}`);
      process.exit(1);
    }
    const dest = args.dest ?? path.basename(args.extract);
    fs.writeFileSync(dest, readEntry(archive, found.prefix, found.node));
    console.log(`已写出 ${dest}（${found.node.size} 字节）`);
    return;
  }

  const filter = args.list === null ? null : new RegExp(args.list);
  const candidates = filter === null ? all : all.filter((e) => filter.test(e.prefix));

  if (args.list !== null && args.grep === null) {
    console.log(`匹配 ${candidates.length} 个条目：`);
    for (const e of candidates.slice(0, args.max)) console.log(`  ${e.prefix}  (${e.node.size}B)`);
    if (candidates.length > args.max) console.log(`  … 其余 ${candidates.length - args.max} 个省略`);
    return;
  }

  if (args.grep === null) {
    console.log('什么都没做：给一个 --list 或 --grep。');
    return;
  }

  const needle = Buffer.from(args.grep, 'utf8');
  let hits = 0;
  for (const e of candidates) {
    let content;
    try {
      content = readEntry(archive, e.prefix, e.node);
    } catch {
      continue;
    }
    let count = 0;
    let from = 0;
    for (;;) {
      const at = content.indexOf(needle, from);
      if (at < 0) break;
      count += 1;
      from = at + needle.length;
    }
    if (count > 0) {
      hits += 1;
      if (hits <= args.max) console.log(`  ${e.prefix}  ×${count}`);
    }
  }
  console.log(`命中文件 ${hits} 个`);
}

main();
