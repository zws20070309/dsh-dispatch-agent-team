#!/usr/bin/env node
/**
 * ops-enable.cjs —— 把 dsh-ops 四个组件在 **profile 层**钉成启用（2026-10-15）。
 *
 * 为什么需要它：本包不再内嵌 ops（见 lib/ops-adapter.js 头部），四个组件的开关住在
 * dsh-ops 自己 bundle patch 里，而它默认关着 background 与 ptc 两行。要在**不碰只读
 * app.asar、不碰别人插件包内文件**的前提下让四组件全开，唯一可靠的落点是 profile 的
 * cordis.patch.yml：patch 按 bundles 顺序应用，profile 层在所有 bundle 层**之后**
 * （dsh-app-boot applyEntryPatches 的 overrides 循环逐键赋值 disabled:false），
 * 与用户的启用顺序无关。
 *
 * 为什么需要「可重跑」：profile 的 cordis.patch.yml 在崩溃恢复时会被**改名**（本机
 * 2026-10-10 真发生过，profiles/desktop/ 里还留着 .bak-*-pre-dshops）。托管块有
 * lib/self-heal.js 兜底，但那四行属于 dsh-ops 的领域、不该由本包塞进托管块 ——
 * 于是给一条命令：node tools/ops-enable.cjs（重启生效）。
 *
 * 用法：
 *   node tools/ops-enable.cjs            # 需要时补齐/翻转（默认动作）
 *   node tools/ops-enable.cjs --check    # 只报告，不写盘（退出码 1 = 需要处理）
 *   node tools/ops-enable.cjs --revert   # 删掉这四行（回到 dsh-ops 自带默认）
 *
 * 边界（与 lib/self-heal.js 同一套纪律）：
 *   * 只动 dsh-ops-shell / dsh-ops-file / dsh-ops-background / dsh-ops-ptc 四行，别的行原样保留；
 *   * 写前先备份 .bak-<ts>-pre-ops-enable；
 *   * 已经是 disabled:false 的行不重复追加（幂等）；true 的行就地翻转；
 *   * 没有 disabled 键的行（dsh-ops 自带 patch 里 shell/file 就属于这种）视为已启用，不插键；
 *   * 缺的行追加到文件**末尾**：这里不是哨兵区结构，末尾不会被宿主 AST 追加吞掉
 *     （吞掉事故只发生在「哨兵区在末尾」的场景，见 self-heal.js 的 2026-10-10 P0）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** 四行（config 与 dsh-ops 0.3.0 自带 patch 同值 + 两处刻意偏离，注释见 INTERFACES.md §3.8）。 */
const ROWS = [
  { id: 'dsh-ops-shell', lines: [
    '- id: dsh-ops-shell',
    '  disabled: false',
    '  config:',
    '    promptPolicy: true',
    '    publishBashTool: false',
    '    shellPolicy: advise',
    '    allowSystemShellFallback: false',
  ] },
  { id: 'dsh-ops-file', lines: [
    '- id: dsh-ops-file',
    '  disabled: false',
    '  config:',
    '    promptPolicy: true',
    '    enableShellTools: false',
    '    required: false',
    '    toolCallTimeoutMs: 300000',
  ] },
  { id: 'dsh-ops-background', lines: [
    '- id: dsh-ops-background',
    '  disabled: false',
    '  config:',
    '    promptPolicy: true',
    '    enableShellTools: true',
    '    required: false',
    '    toolCallTimeoutMs: 300000',
    '    allowSystemShellFallback: true',
  ] },
  { id: 'dsh-ops-ptc', lines: [
    '- id: dsh-ops-ptc',
    '  disabled: false',
    '  config:',
    '    required: false',
  ] },
];
const IDS = ROWS.map((row) => row.id);

/** 与 lib/self-heal.js 同源的 profile 定位链。 */
function locatePatch() {
  const dirs = [];
  if (process.env.DSH_PROFILE_DIR) dirs.push(process.env.DSH_PROFILE_DIR);
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  dirs.push(path.join(home, 'profiles', 'desktop'), path.join(home, 'profiles', 'web'));
  for (const dir of dirs) {
    const file = path.join(dir, 'cordis.patch.yml');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** 把文本切成顶层行块：一行 '- id: x' 开一块，后续行归属它。 */
function splitRows(lines) {
  const blocks = [];
  let current = null;
  lines.forEach((line, index) => {
    const match = /^-\s*id:\s*(\S+)\s*$/u.exec(line);
    if (match !== null) { current = { id: match[1], start: index, end: index }; blocks.push(current); }
    else if (current !== null) { current.end = index; }
  });
  return blocks;
}

/**
 * 计算目标文本与将要发生的动作。纯函数（不碰盘），便于被闸门直接调用。
 * @returns {{text: string, flipped: string[], appended: string[], kept: string[]}}
 */
function plan(text) {
  let working = text.split('\n');
  const blocks = splitRows(working);
  const flipped = [];
  const kept = [];
  for (const id of IDS) {
    const block = blocks.find((row) => row.id === id);
    if (block === undefined) continue;
    const disabledIndex = working.findIndex((line, index) =>
      index >= block.start && index <= block.end && /^\s*disabled:\s*(true|false)\s*$/u.test(line));
    if (disabledIndex >= 0 && /^\s*disabled:\s*true\s*$/u.test(working[disabledIndex])) {
      working = working.slice();
      working[disabledIndex] = '  disabled: false';
      flipped.push(id);
    } else {
      kept.push(id);
    }
  }
  const missing = IDS.filter((id) => !blocks.some((row) => row.id === id));
  if (missing.length === 0) return { text: working.join('\n'), flipped, appended: [], kept };
  const header = [
    '# ── dsh-ops 四组件启用（由 @zws/dsh-dispatch-agent-team 的 tools/ops-enable.cjs 维护）──',
    '# 本包已不再内嵌 ops；这四行只把独立 dsh-ops 插件自己的组件钉成启用，',
    '# 不碰它包内的任何文件。翻转/补齐：node tools/ops-enable.cjs（重启生效）。',
  ].join('\n');
  const body = ROWS.filter((row) => missing.includes(row.id)).map((row) => row.lines.join('\n')).join('\n\n');
  const next = working.join('\n').replace(/\s*$/u, '') + '\n\n' + header + '\n' + body + '\n';
  return { text: next, flipped, appended: missing, kept };
}

function main() {
  const check = process.argv.includes('--check');
  const revert = process.argv.includes('--revert');
  const file = locatePatch();
  if (file === null) {
    console.error('定位不到 profile 的 cordis.patch.yml（试过 DSH_PROFILE_DIR / DSH_HOME/profiles/{desktop,web}）。');
    return 2;
  }
  const text = fs.readFileSync(file, 'utf8');
  if (revert) {
    const lines = text.split('\n');
    const drop = new Set();
    for (const block of splitRows(lines).filter((row) => IDS.includes(row.id))) {
      for (let index = block.start; index <= block.end; index += 1) drop.add(index);
    }
    if (drop.size === 0) { console.log('无需还原：profile 里没有这四行（已是 dsh-ops 自带默认）。'); return 0; }
    fs.copyFileSync(file, file + '.bak-' + Date.now() + '-pre-ops-enable');
    fs.writeFileSync(file, lines.filter((_, index) => !drop.has(index)).join('\n'), 'utf8');
    console.log('已删掉 profile 里的这四行（shell/file 回到 dsh-ops 自带默认=启用，background/ptc=关闭）。');
    console.log('⚠ 重启 DSH 生效。备份在同目录 .bak-*-pre-ops-enable。');
    return 0;
  }
  const result = plan(text);
  if (result.flipped.length === 0 && result.appended.length === 0) {
    console.log('已启用：四行都在 profile 层且没有 disabled:true（' + file + '）。');
    return 0;
  }
  if (check) {
    console.log('需要处理：翻转 ' + (result.flipped.join(', ') || '无') + '；补行 ' + (result.appended.join(', ') || '无'));
    return 1;
  }
  fs.copyFileSync(file, file + '.bak-' + Date.now() + '-pre-ops-enable');
  fs.writeFileSync(file, result.text, 'utf8');
  console.log('已写入 ' + file);
  if (result.flipped.length > 0) console.log('  翻转 disabled: ' + result.flipped.join(', '));
  if (result.appended.length > 0) console.log('  追加行: ' + result.appended.join(', '));
  console.log('⚠ 需要重启 DSH 才生效（profile patch 在启动时读入）。备份在同目录 .bak-*-pre-ops-enable。');
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { plan, splitRows, locatePatch, IDS, ROWS };
