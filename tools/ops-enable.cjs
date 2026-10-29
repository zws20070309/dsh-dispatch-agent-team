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

/**
 * dsh-ops 的**迁移版本号**，从装机那份源码读，不自带一份。
 *
 * 2026-10-21 真事故：这里原来写死 `configUpdateVersion: 1`。dsh-ops 0.3.2 把
 * CONFIG_UPDATE_VERSION 升到了 **2**（lib/config-updates.js:7），于是本脚本的 `plan()`
 * 对一份**已经迁移好**的 profile 判决「需要补齐」，随后把它**降级**写回 1 ——
 * 修法反而造成了损坏。同时 dsh-ops 自己下次启动又会把它迁回 2，两边来回改同一个文件。
 * 判据必须来自上游：读不到就**拒绝行动**（退出码 2），绝不猜一个数字写进用户配置。
 * @returns {number|null} 迁移版本号；读不到时 null。
 */
function detectConfigVersion() {
  const pkg = resolveOpsPackageJson();
  if (pkg === null) return null;
  try {
    const src = fs.readFileSync(path.join(path.dirname(pkg), 'lib', 'config-updates.js'), 'utf8');
    const match = /export const CONFIG_UPDATE_VERSION = (\d+)/u.exec(src);
    if (match === null) return null;
    const value = Number.parseInt(match[1], 10);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * profile 目录候选（与 locatePatch 同一条链，顺序一致：显式 > desktop > web）。
 * @returns {string[]}
 */
function profileCandidates() {
  const dirs = [];
  if (process.env.DSH_PROFILE_DIR) dirs.push(process.env.DSH_PROFILE_DIR);
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  dirs.push(path.join(home, 'profiles', 'desktop'), path.join(home, 'profiles', 'web'));
  return dirs;
}

/** 装机 dsh-ops 的 package.json 路径；没装返回 null（本包不依赖它）。 */
function resolveOpsPackageJson() {
  for (const dir of profileCandidates()) {
    const candidate = path.join(dir, 'node_modules', 'dsh-ops', 'package.json');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const CONFIG_UPDATE_VERSION = detectConfigVersion();
const MARKER = CONFIG_UPDATE_VERSION === null ? null : ('    configUpdateVersion: ' + CONFIG_UPDATE_VERSION);

/**
 * dsh-ops 自己的 bundle patch 还 insert 不 insert 这四个遗留组件行。
 *
 * ── 为什么必须问这一句（2026-10-29 真机，本脚本当场给出了**假绿灯**）──────────────
 * 本脚本的判据一直是「profile 里这四行在不在、config 齐不齐」。dsh-ops **0.5.0** 起
 * 它的 cordis.patch.yml 不再 insert 这四行（改成 insert `dsh-ops-mode-*` 行族 + discovery，
 * 源码注释原话 "Legacy component modules … are no longer inserted here"）。
 * 于是 profile 里那四行成了**没有对应 insert 的孤立覆盖**：patch 找不到目标只会 warn
 * `patch: entry %C not found` 然后跳过 —— 它们一个字节都不生效。
 *
 * 实测（本机 2026-10-29）：`--check` 报「已启用且配置齐备」，而 loader 里真正在跑的
 * 是 5 个 mode 行；那四行既不在 loader 里，也不影响任何东西。用户看到「齐备」，
 * 却不知道这个工具管的已经是**上一代的开关**。
 *
 * 所以 README / --check 的输出必须如实说明：不是「坏了」，是「这四行在新版上不再是
 * 开关的载体」。修法不是去改 dsh-ops（用户明令不改别人源码），而是把事实说准。
 *
 * @returns {boolean|null} true = 上游仍 insert 四行；false = 已改版；null = 读不到（没装）。
 */
function legacyRowsStillInserted() {
  const pkg = resolveOpsPackageJson();
  if (pkg === null) return null;
  try {
    const text = fs.readFileSync(path.join(path.dirname(pkg), 'cordis.patch.yml'), 'utf8');
    const inserted = [...text.matchAll(/^\s*-\s*id:\s*(\S+)/gmu)].map((match) => match[1]);
    if (inserted.length === 0) return null;
    return IDS.some((id) => inserted.includes(id));
  } catch {
    return null;
  }
}

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
  // 2026-10-21：**不再写 enableShellTools / toolCallTimeoutMs**。
  // dsh-ops 0.3.2 的 lib/config.js:20 把这两个键列进 LEGACY_FASTCTX_KEYS，
  // 迁移第 2 步（config-updates.js:17）会把它们**从配置里删掉**。
  // 我们继续写 = 每次 plan() 都判「缺键」、补上、对方下次启动又删掉，来回改同一个文件；
  // 而且 `--check` 永远报一条假的「需要处理」。file 组件现在读的是 required 等键。
  { id: 'dsh-ops-file', lines: [
    '- id: dsh-ops-file',
    '  disabled: false',
    '  config:',
    '    promptPolicy: true',
    '    required: false',
    MARKER,
  ] },
  // ⚠️ 2026-10-21：background 行**故意不带 MARKER**。
  // dsh-ops 0.3.2 的 config-updates.js:22 原话：
  //   `dsh-ops/background` is a no-op stub that reads no config, so it needs no migration.
  // 该组件已被移除（只剩一个只 warn 一次的空壳），它**不读任何配置**。
  // 我们仍替它写 configUpdateVersion 会造成两件事：plan() 对它报「缺迁移标记」的假缺失，
  // 而那个数字在上游没有任何语义。行留着只为兼容老 profile（老版本的 background 真的读配置）。
  { id: 'dsh-ops-background', noMarker: true, staleKeys: ['configUpdateVersion'], lines: [
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
  // ⚠️ 2026-10-21：**不能**用 JSON.stringify 拼 YAML 标量。
  // JSON.stringify('C:\\Program Files\\Git\\bin\\bash.exe') 得到的是
  //   "C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe"   （带双引号、反斜杠被转义两遍）
  // YAML 双引号标量里 `\\\\` 表示**一个字面反斜杠**，解析出来仍是同一个路径，所以功能没坏；
  // 但它是**与 profile 里那行不同的文本**（profile 写的是裸 `C:\Program Files\...`），
  // 于是「按值比较」永远不相等 → 每次 --check 都报「补齐 bashPath」并把那一行重写一遍，
  // 与 dsh-plugin-manager 的 YAML AST 重写互相来回改同一个文件。
  // 正确写法：YAML 里含空格/冒号的标量用**单引号**包裹（单引号内反斜杠是字面量，不做转义）。
  const line = '    bashPath: ' + yamlScalar(bashPath);
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

/**
 * 把一个字符串渲染成安全的 YAML 单行标量。
 *
 * 规则（只覆盖本脚本真正会写的那几类值）：
 *   * 不需要引号就能安全表示（无空格、无 `:#`、首字符不是 `-?&*!|>%@` 之类）→ 裸写；
 *   * 其余 → **单引号**包裹，并把值里已有的单引号按 YAML 规则写成两个单引号。
 * 单引号标量内反斜杠是字面量，所以 Windows 路径原样保留、不需要转义 ——
 * 这正是 JSON.stringify 那条路错掉的地方（它会产出 `\\\\`）。
 * @param {string} value - 原始值。
 * @returns {string} 单行 YAML 文本。
 */
function yamlScalar(value) {
  const text = String(value);
  const plainSafe = text !== '' && !/[\s:#'"\\]/u.test(text) && !/^[-?&*!|>%@`{[]/u.test(text);
  return plainSafe ? text : ("'" + text.replace(/'/gu, "''") + "'");
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

/**
 * 路径类标量的归一化：去包裹引号、反斜杠统一成正斜杠、去尾斜杠。
 *
 * 只用于 bashPath 这类**文件路径**键 —— 它们的值里空格是数据的一部分，
 * 不能用「把连续空白压成一个」的规则比（那会把 `Program Files` 与 `Program  Files`
 * 判成相等，也会让带引号与不带的两种写法永远不相等）。
 * @param {string} value - 归一化前的值文本。
 * @returns {string}
 */
function normalizePathValue(value) {
  let text = String(value).trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  return text.replace(/\\/gu, '/').replace(/\/+$/u, '');
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
        // bashPath 这类**含空格的路径**不能用「空白归一化」比较：
        // 期望值 `C:\Program Files\Git\bin\bash.exe` 归一化后变成 `C:\Program Files\Git\bin\bash.exe`
        // 的空格被压成一个，而 profile 里那份是带引号/未引号的原样文本 —— 两边永远不相等，
        // 于是每次 --check 都报「补齐 bashPath」并把同一行重写一遍（2026-10-21 真机实测到这条）。
        // 路径键按**去引号 + 反斜杠归一**比较，其余标量仍走原来的空白归一化（extraGuidance 折行要靠它）。
        const isPathKey = key === 'bashPath';
        const current = isPathKey
          ? normalizePathValue(scalarValue(working, span))
          : scalarValue(working, span);
        const wanted = isPathKey ? normalizePathValue(wantedValue(want)) : wantedValue(want);
        if (current !== wanted) {
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
    // 这一行**不该有**的键要清掉（2026-10-21）：plan 原来只会补/改，不会删，
    // 于是「早先版本写进去的 configUpdateVersion」会永远留在 background 行上，
    // 而 dsh-ops 0.3.2 明说该行不读任何配置、不需要迁移（config-updates.js:22）。
    // 只删我们**自己曾经写过**、且已经不该存在的键 —— 用户手加的其它键一律不动。
    for (const staleKey of (row.staleKeys ?? [])) {
      const blocksNow = splitRows(working);
      const now = blocksNow.find((entry) => entry.id === row.id);
      if (now === undefined) break;
      const at = working.findIndex((line, index) => index >= now.start && index <= now.end
        && new RegExp('^\\s+' + staleKey + ':\\s*').test(line));
      if (at < 0) continue;
      const span = scalarSpan(working, at, now.end);
      working.splice(span.start, span.end - span.start + 1);
      changes.push('-' + staleKey);
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

/**
 * 只认识的三个开关。**任何别的参数一律拒绝**（2026-10-21 真事故）。
 *
 * 原实现只做 `includes('--check')` / `includes('--revert')`：于是 `--help`、`--dry-run`、
 * 手滑的 `--c heck` 全都**静默落进默认动作 = 写盘**。我当天就是这么踩的：
 * 想先看用法，结果它把用户的 profile patch 改了两行（configUpdateVersion 2→1），
 * 还顺手把 dsh-ops 的 shell 段降级。一个会改用户配置的脚本，绝不能把「不认识的参数」
 * 当成「按默认执行」。
 * @param {string[]} argv - process.argv（含 node 与脚本路径）。
 * @returns {string[]} 不认识的参数（空 = 全部认识）。
 */
function unknownArgs(argv) {
  const known = new Set(['--check', '--revert', '--apply', '--help', '-h']);
  return argv.slice(2).filter((arg) => !known.has(arg));
}

function main() {
  const argv = process.argv;
  // 读不到 dsh-ops 的迁移版本号就不动手：写死一个数字等于赌上游没升过版，
  // 2026-10-21 就是这么把 2 降成 1 的（见 detectConfigVersion 的注释）。
  if (MARKER === null) {
    console.error('定位不到装机 dsh-ops 的 lib/config-updates.js（或里面没有 CONFIG_UPDATE_VERSION）。');
    console.error('本脚本要靠它决定写哪个迁移版本号；读不到就拒绝改用户配置。先确认 dsh-ops 装好了，或用 --check 看现状。');
    return 2;
  }
  const bad = unknownArgs(argv);
  if (bad.length > 0) {
    console.error('不认识的参数：' + bad.join(' ') + '（本脚本会改 profile 配置，未知参数一律不执行）');
    console.error('用法：node tools/ops-enable.cjs [--check | --revert]   # 不带参数 = 补齐/翻转并写盘');
    return 2;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法：node tools/ops-enable.cjs [--check | --revert]');
    console.log('  （不带参数）  需要时补齐/翻转这四行并写盘；重启 DSH 生效');
    console.log('  --check      只报告，不写盘（退出码 1 = 需要处理）');
    console.log('  --revert     删掉这四行（回到 dsh-ops 自带默认）');
    // 版本前提必须写在帮助里：0.5.0 之后这四行已不是开关载体，
    // 用户照着「补齐/翻转」去维护会得到一份看着齐备、实际不生效的 profile。
    if (legacyRowsStillInserted() === false) {
      console.log('');
      console.log('⚠ 本机 dsh-ops 已改版：它的 bundle patch 不再 insert 这四个遗留行，');
      console.log('  改装 dsh-ops-mode-{minimal,standard,ptc,cordis} + dsh-ops-discovery。');
      console.log('  本脚本的写盘动作对那一版**没有意义**（那四行只是没有目标的孤儿覆盖）；');
      console.log('  开关以插件页的 mode 行为准，状态见 ~/.dsh/dispatch-agent-team-status.json 的 opsIntegration。');
    }
    return 0;
  }
  const check = argv.includes('--check');
  const revert = argv.includes('--revert');
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
  // 上游是否还 insert 这四行（见 legacyRowsStillInserted 的注释）。
  // false = 这四行在 profile 里只是**没有目标的孤儿覆盖**，一个字节都不生效；
  // 此时「齐备」这句话本身就是误导，必须换成事实说明。
  const legacy = legacyRowsStillInserted();
  if (need === 0) {
    if (legacy === false) {
      console.log('profile 里这四行确实都在、config 也齐（' + file + '），但它们**已经不再是开关的载体**：');
      console.log('装机 dsh-ops 的 bundle patch 不再 insert dsh-ops-shell/file/background/ptc，');
      console.log('改成了 dsh-ops-mode-{minimal,standard,ptc,cordis} + dsh-ops-discovery 行族。');
      console.log('patch 找不到目标只会 warn 并跳过 —— 这四行现在不生效，也不需要再维护。');
      console.log('实际的开关状态请看插件页的 dsh-ops 行，或状态文件的 opsIntegration 字段。');
      return 0;
    }
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
module.exports = { plan, splitRows, rowLines, detectBash, locatePatch, IDS, ROWS, MARKER, SHELL_OVERRIDE_TEXT, yamlScalar, normalizePathValue, CONFIG_UPDATE_VERSION, legacyRowsStillInserted };
