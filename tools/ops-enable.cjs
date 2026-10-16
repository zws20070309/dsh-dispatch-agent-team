#!/usr/bin/env node
/**
 * ops-enable.cjs —— 把 dsh-ops 四个组件在 **profile 层**钉成启用（2026-10-15）。
 *
 * 为什么需要它：本包不再内嵌 ops（见 lib/ops-adapter.js 头部），四个组件的开关住在
 * dsh-ops 自己 bundle patch 里，而它默认关着 background 与 ptc 两行。要在**不碰只读
 * app.asar、不碰别人插件包内文件**的前提下让四组件全开，唯一可靠的落点是 profile 的
 * cordis.patch.yml：patch 按 bundles 顺序应用，profile 层在所有 bundle 层**之后**
 * （dsh-app-boot applyEntryPatches 的 overrides 循环逐键赋值），与用户的启用顺序无关。
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
 *   * 已经是 disabled:false 且配置齐的行不重复写（幂等）；true 的行就地翻转；
 *   * 没有 disabled 键的行（dsh-ops 自带 patch 里 shell/file 就属于这种）视为已启用，不插键；
 *   * 缺的行追加到文件**末尾**：这里不是哨兵区结构，末尾不会被宿主 AST 追加吞掉
 *     （吞掉事故只发生在「哨兵区在末尾」的场景，见 self-heal.js 的 2026-10-10 P0）。
 *
 * 每行都带 configUpdateVersion: 1 —— dsh-ops 的 updatedConfig()（lib/config-updates.js:9-14）
 * 会把「没有该标记且 allowSystemShellFallback: true」的行**迁移成 false 并写回 profile**
 * （mountConfigUpdates 的 entry.parent.tree.write()）。不声明标记 = background 那四个 job
 * 工具在首次启动就被静默关掉，且我们的文件被改。标记的语义就是「本行迁移已完成」
 * （lib/config.js:157-160 接受并校验该键）；ptc 行不能带（resolvePtcConfig 只认
 * binaryPath/required，多给键会抛 Unknown PTC config key，本机实测）。
 *
 * background 行还带 bashPath（探测到真 bash 时）—— 见 detectBash 的注释。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const LF = String.fromCharCode(10);
const MARKER = '    configUpdateVersion: 1';

/**
 * shell 段的追加指引（走 dsh-ops 自己的公开扩展点 extraGuidance，lib/config.js 接受、
 * lib/policy.js:64 把它拼到该段末尾 —— 不改它一行源码）。
 *
 * 为什么需要：ops 的 shell 段会写「Prefer bash for command execution … do not switch
 * shells」（lib/policy.js:61），与本团队 preset 给每个 agent 装的 persistent-pwsh
 * （presets/dispatch-mode.patch.yml:114-126）矛盾，模型会在两个执行器之间摇摆。
 * 上一版的处理是干脆不开 ops_bash（publishBashTool: false）—— 那等于少一个工具。
 * 现在开工具 + 用官方扩展点把口径说清：默认仍是持久 PowerShell，ops_bash 只用于
 * 一次性 POSIX 命令。实测（shell 组件真挂载 + 生产同形的 assemble 上下文）：
 * ops_bash 可见，且这段文字确实出现在 shell 段末尾。
 */
const SHELL_OVERRIDE_TEXT = 'OPS-TEAM OVERRIDE: persistent PowerShell (pwsh) is this team\'s default command executor. '
  + 'Use ops_bash for one-shot POSIX commands only; do not rewrite PowerShell scripts as bash.';
const SHELL_GUIDANCE = '    extraGuidance: ' + JSON.stringify(SHELL_OVERRIDE_TEXT);

/** 四行的完整文本（background 的 bashPath 由 rowLines 按需插入）。 */
const ROWS = [
  { id: 'dsh-ops-shell', lines: [
    '- id: ' + 'dsh-ops-shell',
    '  disabled: false',
    '  config:',
    '    promptPolicy: true',
    '    publishBashTool: true',
    '    shellPolicy: advise',
    '    allowSystemShellFallback: false',
    SHELL_GUIDANCE,
    MARKER,
  ] },
  { id: 'dsh-ops-file', lines: [
    '- id: dsh-ops-file',
    '  disabled: false',
    '  config:',
    '    promptPolicy: true',
    '    enableShellTools: false',
    '    required: false',
    '    toolCallTimeoutMs: 300000',
    MARKER,
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
    MARKER,
  ] },
  { id: 'dsh-ops-ptc', lines: [
    '- id: dsh-ops-ptc',
    '  disabled: false',
    '  config:',
    '    required: false',
  ] },
];
const IDS = ROWS.map((row) => row.id);

/**
 * 找一个**真能用**的 bash（background 组件的 job 工具要它）。
 *
 * 为什么不能只靠 allowSystemShellFallback：dsh-ops 的 PATH 兜底只排除 %SystemRoot%
 * 下那个 bash.exe（lib/shells.js:481-487 的 isWslBashLauncher），**不排除**
 * %LOCALAPPDATA% 下 Microsoft/WindowsApps 那一个 —— 那同样是 WSL 启动器。
 * 本机实测：兜底选中的正是 WindowsApps 那个，而 FastCtx 直接拒绝执行
 * （"not a working bash ... points to the Windows/WSL launcher or a WindowsApps shim"）。
 * 所以显式探测一个真 bash（Git for Windows）；探测不到就退回兜底，让 ops 自己给修法。
 * 全程只用 path.join，不写反斜杠字面量（多层转义是本仓库反复踩的坑）。
 * @param {{platform?: string, env?: object, exists?: Function}} [options]
 * @returns {string|null} 可用的 bash 绝对路径，或 null。
 */
function detectBash(options) {
  const opts = options || {};
  const platform = opts.platform !== undefined ? opts.platform : process.platform;
  const env = opts.env !== undefined ? opts.env : process.env;
  const exists = opts.exists !== undefined ? opts.exists : (file) => fs.existsSync(file);
  if (platform !== 'win32') return null;
  const programFiles = env.ProgramFiles || path.join('C:', 'Program Files');
  const candidates = [
    path.join(programFiles, 'Git', 'bin', 'bash.exe'),
    path.join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
  ];
  for (const file of candidates) {
    if (exists(file)) return file;
  }
  return null;
}

/**
 * 给 shell 与 background 两行补 bashPath（放在各自的锚点之后，保持可读顺序）。
 *
 * 为什么 shell 行也要（2026-10-16 真机 P0）：shell 行的 `publishBashTool: true` 只是「允许发布」，
 * 真正决定发不发的是 `resolveShells` 能不能解析到 bash。本机 `@dsh-ops/bash-win32-x64` 没装
 * （ops 的 bundledShell 拿不到），而 shell 行我们刻意写 `allowSystemShellFallback: false`
 * （不想让 pwsh 也去吃 PATH 兜底），于是 `bash.available=false / source=disabled` →
 * **ops_bash 从来没发布过**。装机实测：Lead 与两名队员的 wire 里都没有 ops_bash，
 * 状态文件 visibleTools 也只有 file 四件套。而 ops-mount-check 的 D 段当时**自己传了** bashPath，
 * 与生产配置不同形 → 那条 ✓ 是假绿灯（见该文件 D 段的注释与闸门）。
 * 修法：shell 行同样带显式 bashPath（`bashPath` 在共享白名单里，dsh-ops `lib/config.js:151,196`
 * 任何行都接受），fallback 保持 false —— pwsh 仍只用随包 PS7，不受影响（实测 pwsh 解析
 * 仍是 bundled）。探测不到 bash 时不写这个键，行为回到「不发布 ops_bash」，与旧版一致。
 * @param {{id:string, lines:string[]}} row - ROWS 里的一项。
 * @param {string|null} bashPath - detectBash() 的结果。
 * @returns {string[]} 该行的文本行。
 */
function rowLines(row, bashPath) {
  if (typeof bashPath !== 'string' || bashPath === '') return row.lines;
  const line = '    bashPath: ' + JSON.stringify(bashPath);
  if (row.id === 'dsh-ops-shell') {
    const at = row.lines.indexOf('    allowSystemShellFallback: false');
    if (at < 0) return row.lines;
    const next = row.lines.slice();
    next.splice(at + 1, 0, line);
    return next;
  }
  if (row.id !== 'dsh-ops-background') return row.lines;
  const at = row.lines.indexOf('    allowSystemShellFallback: true');
  if (at < 0) return row.lines;
  const next = row.lines.slice();
  next.splice(at + 1, 0, line);
  return next;
}

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

/** 把文本切成顶层行块：一行 "- id: x" 开一块，后续行归属它。 */
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

/** 一行的缩进宽度（前导空白数）。 */
function keyIndent(line) {
  return line.length - line.replace(/^\s+/u, '').length;
}

/**
 * 找出某个 `key: value` 行的**完整标量跨度**（含被宿主折行的续行）。
 * 续行判据：缩进比本行更深、且在同一个块内（空行/更浅缩进 = 标量结束）。
 * @param lines - 全文行数组。
 * @param at - key 行的下标。
 * @param blockEnd - 本行的最后一行下标。
 * @returns {{start:number, end:number}}
 */
function scalarSpan(lines, at, blockEnd) {
  const ind = keyIndent(lines[at]);
  let end = at;
  for (let i = at + 1; i <= blockEnd; i += 1) {
    const line = lines[i];
    if (line.trim() === '') break;
    if (keyIndent(line) <= ind) break;
    end = i;
  }
  return { start: at, end };
}

/** 取一个标量跨度的**值文本**（折行按 YAML 折叠语义用单空格接回去）。 */
function scalarValue(lines, span) {
  const parts = [];
  for (let i = span.start; i <= span.end; i += 1) {
    if (i === span.start) {
      const m = /: (.*)$/u.exec(lines[i]);
      parts.push(m === null ? '' : m[1]);
    } else {
      parts.push(lines[i].trim());
    }
  }
  return parts.join(' ').replace(/\s+/gu, ' ').trim();
}

/** 把 ROWS 里期望的那一行拆成同样的"值文本"（与 scalarValue 同一套归一化）。 */
function wantedValue(wantLine) {
  const m = /: (.*)$/u.exec(wantLine);
  return (m === null ? '' : m[1]).replace(/\s+/gu, ' ').trim();
}
/**
 * 计算目标文本与将要发生的动作。纯函数（不碰盘），便于被闸门直接复用。
 * @param {string} text - profile patch 全文。
 * @param {{bashPath?: string|null}} [options] - 探测到的真 bash（有则写进 background 行）。
 * @returns {{text: string, flipped: string[], appended: string[], patched: string[], kept: string[]}}
 */
function plan(text, options) {
  const bashPath = options && typeof options.bashPath === 'string' && options.bashPath !== ''
    ? options.bashPath : null;
  let working = text.split(LF);
  const blocks = splitRows(working);
  const flipped = [];
  const patched = [];
  const kept = [];
  for (const row of ROWS) {
    const block = blocks.find((entry) => entry.id === row.id);
    if (block === undefined) continue;
    const body = working.slice(block.start, block.end + 1);
    const disabledAt = body.findIndex((line) => /^\s*disabled:\s*(true|false)\s*$/u.test(line));
    if (disabledAt >= 0 && /^\s*disabled:\s*true\s*$/u.test(body[disabledAt])) {
      working = working.slice();
      working[block.start + disabledAt] = '  disabled: false';
      flipped.push(row.id);
      continue;
    }
    // 已启用：把这一行的 config 与 ROWS（唯一真值）**逐键对齐**。
    // 只检查个别键是不够的 —— 上一版就因此对真 profile 报「齐备」，而 shell 行的
    // publishBashTool 还停在 false（ROWS 改了、已有 profile 不收敛 = 静默失真）。
    // 语义：这四行归本工具所有，所以期望键值不同时**就地改写**；用户自己加的其它键不动。
    const wanted = rowLines(row, bashPath).filter((line) => /^\s{4}\S/.test(line));
    const changes = [];
    working = working.slice();
    const keyOf = (line) => { const m = /^\s+(\S+?):\s*/.exec(line); return m === null ? null : m[1]; };
    for (const want of wanted) {
      const key = keyOf(want);
      if (key === null) continue;
      // 重新定位块尾（上一轮可能已经插过行）。
      const blocksNow = splitRows(working);
      const now = blocksNow.find((entry) => entry.id === row.id);
      if (now === undefined) break;
      const at = working.findIndex((line, index) => index >= now.start && index <= now.end && keyOf(line) === key);
      if (at >= 0) {
        // **按值比较，不按整行文本比较**（2026-10-16 真机）。宿主 dsh-plugin-manager 保存 profile
        // 时是用 YAML AST 重写的，会把长标量折行 —— 本机实测：extraGuidance 那句被折成 4 行
        // （值逐字节不变，.probe-tmp/parse-profile.cjs 解析核对过）。旧写法 `working[at] !== want`
        // 于是每次 --check 都报「需要处理：补齐键 dsh-ops-shell(extraGuidance)」，而它其实是对的；
        // 更要紧的是它会**把折行改回单行**，与宿主互相改写。现在读值时把折叠的续行也吃进来，
        // 归一化空白后比对：值相同就什么都不做（幂等），值真不同才重写（重写时顺手清掉续行）。
        const span = scalarSpan(working, at, now.end);
        const current = scalarValue(working, span);
        if (current !== wantedValue(want)) {
          working.splice(span.start, span.end - span.start + 1, want);
          changes.push(key);
        }
      } else {
        let insertAt = now.end;
        for (let i = now.end; i > now.start; i -= 1) {
          if (/^\s{4}\S/.test(working[i - 1])) { insertAt = i; break; }
        }
        working.splice(insertAt, 0, want);
        changes.push(key);
      }
    }
    if (changes.length === 0) { kept.push(row.id); continue; }
    patched.push(row.id + '(' + changes.join('+') + ')');
  }
  const missing = IDS.filter((id) => !blocks.some((entry) => entry.id === id));
  if (missing.length === 0) {
    return { text: working.join(LF), flipped, patched, appended: [], kept };
  }
  const header = [
    '# ── dsh-ops 四组件启用（由 @zws/dsh-dispatch-agent-team 的 tools/ops-enable.cjs 维护）──',
    '# 本包已不再内嵌 ops；这四行只把独立 dsh-ops 插件自己的组件钉成启用，',
    '# 不碰它包内的任何文件。翻转/补齐：node tools/ops-enable.cjs（重启生效）。',
  ].join(LF);
  const body = ROWS.filter((row) => missing.includes(row.id))
    .map((row) => rowLines(row, bashPath).join(LF))
    .join(LF + LF);
  const next = working.join(LF).replace(/\s*$/u, '') + LF + LF + header + LF + body + LF;
  return { text: next, flipped, patched, appended: missing, kept };
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
    const lines = text.split(LF);
    const drop = new Set();
    for (const block of splitRows(lines).filter((row) => IDS.includes(row.id))) {
      for (let index = block.start; index <= block.end; index += 1) drop.add(index);
    }
    if (drop.size === 0) { console.log('无需还原：profile 里没有这四行（已是 dsh-ops 自带默认）。'); return 0; }
    fs.copyFileSync(file, file + '.bak-' + Date.now() + '-pre-ops-enable');
    fs.writeFileSync(file, lines.filter((_, index) => !drop.has(index)).join(LF), 'utf8');
    console.log('已删掉 profile 里的这四行（shell/file 回到 dsh-ops 自带默认=启用，background/ptc=关闭）。');
    console.log('⚠ 重启 DSH 生效。备份在同目录 .bak-*-pre-ops-enable。');
    return 0;
  }
  const result = plan(text, { bashPath: detectBash() });
  const need = result.flipped.length + result.appended.length + result.patched.length;
  if (need === 0) {
    console.log('已启用且配置齐备：四行都在 profile 层，没有 disabled:true，且每行的 config 与 ROWS 逐键一致（' + file + '）。');
    return 0;
  }
  if (check) {
    console.log('需要处理：翻转 ' + (result.flipped.join(', ') || '无')
      + '；补行 ' + (result.appended.join(', ') || '无')
      + '；补齐键 ' + (result.patched.join(', ') || '无'));
    return 1;
  }
  fs.copyFileSync(file, file + '.bak-' + Date.now() + '-pre-ops-enable');
  fs.writeFileSync(file, result.text, 'utf8');
  console.log('已写入 ' + file);
  if (result.flipped.length > 0) console.log('  翻转 disabled: ' + result.flipped.join(', '));
  if (result.appended.length > 0) console.log('  追加行: ' + result.appended.join(', '));
  if (result.patched.length > 0) console.log('  逐键补齐/改写（与 ROWS 对齐）: ' + result.patched.join(', '));
  console.log('⚠ 需要重启 DSH 才生效（profile patch 在启动时读入）。备份在同目录 .bak-*-pre-ops-enable。');
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { plan, splitRows, rowLines, detectBash, locatePatch, IDS, ROWS, MARKER, SHELL_OVERRIDE_TEXT };
