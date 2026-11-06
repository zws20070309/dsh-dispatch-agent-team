// 离线验收探针：把**装机的真 dsh-ops 组件（一行源码都不改）**挂进真 cordis + 真 dsh-tools，
// 看调度模式的队员到底能不能拿到它的工具。
//
// 为什么需要它：交付要求「ops 四组件都打开 + 团队完美使用它的工具」，而真机要重启 DSH 才看得到。
// 这个工具在**当前进程之外**复刻同一条装配路径（真 Context、真 register、真 presentAs、真 assemble、
// 真 dsh-ops 组件代码），所以给的是实测结论，不是推理。
//
// 四段（各用**独立** Context —— 组件都监听 agent/created，共用一个 root 会互相抢注，
// 第一版就是这么把负对照搞失效的）：
//   A = 交付态：file 四件套人人可见；纯 PTC 档队员拿到 ops_batch/ops_result
//       （2026-10-21 语义：本包「批量调用 开」= ptc 档 → 拿得到；关 = native → 拿不到）
//   B = 负对照：同一份原版组件，只差呈现档 —— ptc 档拿到 / both 档拿不到
//             ⇒ 因果在**本包能配的那一项**上，不需要也不允许去改 ops
//   C = background 组件真起 FastCtx 服务器，四个 job 工具确实发布，并真调一次 ops_run_background
//   D = shell 组件：ops_bash 已发布 + ops 原文与本包 extraGuidance 同时进段
//
// 用法：node tools/ops-mount-check.mjs      退出码 0 = 通过（含「本机没装 dsh-ops」这种不适用）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROFILE = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
// 官方运行时从插件自己的 node_modules（junction → profiles/node_modules）解析 ——
// 与 tools/integration-test.cjs 同一基准；dsh-ops 用 profile 的 node_modules（装机那份）。
const reqPlugin = createRequire(path.join(PLUGIN, 'package.json'));
const reqProfile = createRequire(path.join(PROFILE, 'package.json'));
const libUrl = (name) => pathToFileURL(reqPlugin.resolve(name)).href;
// 没装 dsh-ops = 本插件照常工作（ops 是可选的），这里如实说明并退 0，不算失败。
let opsRoot;
try {
  opsRoot = path.dirname(reqProfile.resolve('dsh-ops/package.json'));
} catch {
  say('本机没有已安装的 dsh-ops（profile 的 node_modules 里解析不到）：');
  say('本插件不依赖它，ops 检测会静默跳过、队员提示词一个字节都不涨 —— 这就是「没装 ops 也能用」的样子。');
  say('想要 ops 的能力：装 dsh-ops 插件并在插件页启用它的组件，再跑 node tools/ops-enable.cjs。');
  process.exit(0);
}
const opsFile = (rel) => pathToFileURL(path.join(opsRoot, rel)).href;
const versionOf = (name) => {
  try {
    const dir = path.dirname(reqPlugin.resolve(name + '/package.json'));
    return name.replace('@deepseek-ai/', '') + '@' + JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  } catch { return name + '@?'; }
};
// 结果同时写一份日志文件：C 段会起真 FastCtx 子进程，管道句柄可能让 Node 不退出
// （实测卡过一次）—— 有文件就不必等进程结束，也不会把结论吞掉。
const LOG = path.join(PLUGIN, '.probe-tmp', 'mount-check.log');
try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.writeFileSync(LOG, '', 'utf8'); } catch { /* 日志写不了不影响判定 */ }
const say = (line) => { console.log(line); try { fs.appendFileSync(LOG, line + String.fromCharCode(10), 'utf8'); } catch { /* 同上 */ } };

const tick = async (n = 8) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

const { Context } = await import(libUrl('@deepseek-ai/cordis'));
const { createScope } = await import(libUrl('@deepseek-ai/dsh-scope'));
const dshTools = await import(libUrl('@deepseek-ai/dsh-tools'));
const dshSp = await import(libUrl('@deepseek-ai/dsh-system-prompt'));
const ToolRuntime = dshTools.ToolRuntime ?? dshTools.default;
const SystemPrompt = dshSp.SystemPrompt ?? dshSp.default;

/**
 * 宿主 subprocess 契约的忠实实现（argv 已由调用方按白名单校验）。
 * 契约来自装机 dsh-ops lib/ptc/worker.js:61-66：spawn({argv,cwd,stdio,graceMs,signal})
 *   -> { done: Promise<{exitCode,signal}>, collected:{stdout:{readFrom,lossy},stderr:{readFrom}} }。
 * @param argv - 已校验的参数数组。
 * @param options - 宿主的 spawn 选项。
 * @returns 宿主契约要求的 handle。
 */
function spawnWorkerBridge(argv, options) {
  const child = nodeSpawn(argv[0], argv.slice(1), { cwd: options.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const cap = (limit) => {
    const parts = []; let size = 0; let lossy = false;
    return {
      push: (buf) => {
        if (size + buf.length > limit) {
          lossy = true;
          const room = limit - size;
          if (room > 0) { parts.push(buf.subarray(0, room)); size = limit; }
          return;
        }
        parts.push(buf); size += buf.length;
      },
      readFrom: () => ({ text: Buffer.concat(parts).toString('utf8'), lossy }),
    };
  };
  const out = cap((options.stdio && options.stdio.stdout && options.stdio.stdout.maxBytes) || 128 * 1024);
  const err = cap((options.stdio && options.stdio.stderr && options.stdio.stderr.maxBytes) || 16 * 1024);
  child.stdout.on('data', (b) => out.push(b));
  child.stderr.on('data', (b) => err.push(b));
  if (options.stdio && options.stdio.stdin && options.stdio.stdin.data !== undefined) child.stdin.end(options.stdio.stdin.data);
  else child.stdin.end();
  const done = new Promise((resolve) => {
    child.on('close', (code, sig) => resolve({ exitCode: code, signal: sig }));
    child.on('error', (e) => resolve({ exitCode: null, signal: String((e && e.message) || e) }));
  });
  if (options.signal && typeof options.signal.addEventListener === 'function') {
    options.signal.addEventListener('abort', () => { try { child.kill(); } catch { /* 已退出 */ } }, { once: true });
  }
  return { done, collected: { stdout: out, stderr: err } };
}

const OPS_WORKER_FILE = (() => {
  // 与 dsh-ops 自己的候选顺序一致：runtime/<platform>-<arch>/ ← native/target/release/
  const name = process.platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker';
  const candidates = [
    path.join(opsRoot, 'runtime', process.platform + '-' + process.arch, name),
    path.join(opsRoot, 'native', 'target', 'release', name),
  ];
  return candidates.find((candidate) => { try { return fs.existsSync(candidate); } catch { return false; } }) ?? null;
})();

/**
 * 一套最小但真实的宿主：SystemPrompt + ToolRuntime + ptcRuntime + 权限/子进程替身。
 *
 * ⚠️ `fs` / `sandbox` 两个服务是 **dsh-ptc-runtime-node 的 inject 依赖**，缺一个它就不激活。
 * 2026-10-29 真踩：装机 dsh-ops 0.5.0 上本探针**整段崩溃**（A 段第一句 `wireSchemas` 抛
 * 「mode "ptc" requires a PTC runtime」）。根因不是 ops 改了，而是这里少给了服务：
 *   * `@deepseek-ai/dsh-ptc-runtime-node/lib/index.js` 的 `NodePtcRuntime.inject = ['fs','subprocess','sandbox','sandboxPolicy']`；
 *   * cordis 的 inject 语义是「缺依赖 → fiber 停在 pending、不 publish 服务」；
 *   * 于是 `ctx.get('ptcRuntime')` 永远是 undefined，dsh-tools 的 ptc 档一用就抛。
 * 实测判据：补齐这两个服务后 fiber.state 从 0 变 2，`ptcRuntime` 立刻可取。
 * 两个替身都是**空实现**：本探针从不让它们真干活（沙箱解析走 sandboxPolicy 的替身）。
 */
async function makeRoot() {
  const root = new Context();
  root.plugin(SystemPrompt, { includeHarnessIdentity: true, personaPrefix: '', includeRuntimeContext: false });
  root.plugin(ToolRuntime, { mode: 'native' });
  await tick(4);
  // dsh-ptc-runtime-node 的 inject 依赖（见上方注释）：缺一个它就永不发布 ptcRuntime。
  root.provide('fs', {});
  root.provide('sandbox', {});
  root.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: PROFILE, sessionId: 'probe-session' }) });
  // subprocess：PTC 的 worker 桥要用它（装机 dsh-ops lib/ptc/worker.js:61）。早先这里是个「一律抛错」
  // 的替身 —— 那样 PTC 的实调只能停在桥前（实测报 SANDBOX_UNAVAILABLE: probe: no real spawn），
  // 验不到「这名队员真能调用 ops_batch」。现在放过一个进程：**只有**装机 dsh-ops 自己的原生 worker，
  // 且本工具只拿它跑无副作用的 action=plan；其余 argv 一律照旧抛错，探针不因此获得随便起进程的能力。
  const WORKER = OPS_WORKER_FILE;
  root.provide('subprocess', { spawn: (options) => {
    // 装机没有原生 worker 时**一律拒绝**：没有可放行的二进制，放行任何进程都是错的。
    if (WORKER === null) throw new Error('probe: 本机 dsh-ops 没有原生 worker，不允许起任何进程');
    const argv = Array.isArray(options && options.argv) ? options.argv : [];
    if (argv.length === 0 || path.resolve(argv[0]) !== path.resolve(WORKER)) {
      throw new Error('probe: 只允许起 dsh-ops 原生 worker，收到 ' + JSON.stringify(argv).slice(0, 160));
    }
    return spawnWorkerBridge(argv, options);
  } });
  root.provide('jobs', { start: () => { throw new Error('probe: no jobs'); } });
  try {
    const nodePtc = await import(libUrl('@deepseek-ai/dsh-ptc-runtime-node'));
    root.plugin(nodePtc.default ?? nodePtc);
  } catch {
    // 官方实现解析不到时退回最小替身：判据只需要 ptcRuntime 服务在位（dsh-tools 用 ctx.get 取）。
    root.provide('ptcRuntime', { language: 'typescript', resolve: (s) => s, run: async () => ({ output: '', diagnostics: [] }) });
  }
  await tick(4);
  return root;
}

/** 造一名指定呈现档的队员。**关键**：scope key 就是 agent 对象本身
 *  （dsh-agent-loop/lib/index.js:778 createScope(loopCtx, this)），而 dsh-ops 的 PTC 门
 *   用 assemble({ scope: agent }) 查呈现档 —— 换成别的对象当 key 就查不到自己声明的层。 */
async function makeMember(root, id, mode) {
  const agent = { id, options: {}, session: { id: 'session-' + id } };
  const scope = createScope(root, agent);
  scope.ctx.get('tools').presentAs(mode);
  declared.set(agent.id, mode);
  agent.ctx = new Proxy(scope.ctx, {
    get: (target, prop, receiver) => ((prop === 'tools' || prop === 'systemPrompt') ? target.get(prop) : Reflect.get(target, prop, receiver)),
  });
  root.emit('agent/created', { agent });
  await tick(12);
  return agent;
}

const PTC_TOOLS = ['ops_batch', 'ops_result'];
const FILE_TOOLS = ['ops_inspect_local_file', 'ops_grep', 'ops_glob', 'ops_replace'];

// ── 装机 dsh-ops 的**能力面**（判据全部由它派生，不在这里写死）────────────────────
// 2026-10-29：0.5.0 把 bundle patch 从「四个遗留组件行」改成「一条预设一档的 mode 行族」，
// 并把 file 工具从「全部常驻」改成 discoverable。探针必须**按装机那代的真实装配**去挂，
// 否则测的是 profile 已经不挂的东西（旧版 A 段就是这么对着一份 0.5.0 打 ✗ 的）。
const OPS_PATCH_TEXT = (() => {
  try { return fs.readFileSync(path.join(opsRoot, 'cordis.patch.yml'), 'utf8'); } catch { return ''; }
})();

/**
 * 解析 dsh-ops 自己 patch 里 insert 的行（id / name / disabled / config）。
 *
 * 只认本文件真正需要的形状（缩进块 + 标量/空数组），**不写一个 YAML 解析器**：
 * 探针要的是「这一版到底会挂哪些行、配了什么」，够用即可；解析不到就如实报错，
 * 绝不用一份手写的默认配置去冒充生产（2026-10-16 的假绿灯就是这么来的）。
 * @returns {Array<{id:string,name?:string,disabled:boolean,config:Record<string,unknown>}>}
 */
function insertedOpsRows() {
  const rows = [];
  let current = null;
  let inConfig = false;
  const TOP = 4; // "- id:" 的缩进（位于 - insert: 之下）
  for (const line of OPS_PATCH_TEXT.split(String.fromCharCode(10))) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.length - line.replace(/^\s+/u, '').length;
    const idMatch = new RegExp('^\\s{2,' + TOP + '}-\\s*id:\\s*(\\S+)\\s*$', 'u').exec(line);
    if (idMatch !== null) {
      current = { id: idMatch[1], disabled: false, config: {} };
      rows.push(current);
      inConfig = false;
      continue;
    }
    if (current === null) continue;
    if (indent <= TOP - 3) { current = null; inConfig = false; continue; }
    const keyMatch = /^\s*(\S+?):\s*(.*)$/u.exec(line);
    if (keyMatch === null) continue;
    const [, key, rawValue] = keyMatch;
    if (key === 'id') continue;
    if (key === 'config') { inConfig = true; continue; }
    if (key === 'name') { current.name = rawValue.trim(); continue; }
    if (key === 'disabled') { current.disabled = rawValue.trim() === 'true'; continue; }
    if (!inConfig) continue;
    const raw = rawValue.trim();
    if (raw === '[]') current.config[key] = [];
    else if (raw === 'true') current.config[key] = true;
    else if (raw === 'false') current.config[key] = false;
    else if (/^-?\d+$/u.test(raw)) current.config[key] = Number(raw);
    else if (raw !== '') current.config[key] = raw;
  }
  return rows;
}

const OPS_INSERTED_ROWS = insertedOpsRows();
/** 装机那代：'mode'（0.5.0+）还是 'legacy'（0.3.x 的四组件行）。 */
const OPS_GENERATION = OPS_INSERTED_ROWS.some((row) => /^dsh-ops-mode-/u.test(row.id)) ? 'mode' : 'legacy';

// 与 tools/ops-enable.cjs 写进 profile 的那句同源（直接 require 那份常量，不各写一份）。
const OPS_ENABLE = createRequire(path.join(PLUGIN, 'tools', 'x.js'))('./ops-enable.cjs');
const OPS_TEAM_SHELL_GUIDANCE = OPS_ENABLE.SHELL_OVERRIDE_TEXT;

/**
 * 把 ops-enable ROWS 里某一行的 config 解析成对象 —— **生产写什么，这里就挂什么**。
 * 只认 4 空格缩进的 key: value 行；值支持 true/false/数字/带引号字符串/裸字符串。
 * @param id - ROWS 里的行 id。
 * @returns 配置对象（id 不存在时抛错：宁可测试崩，也不许静默用另一份配置）。
 */
function rowConfigOf(id) {
  const row = OPS_ENABLE.ROWS.find((entry) => entry.id === id);
  if (row === undefined) throw new Error('ops-enable ROWS 里没有 ' + id);
  const bashPath = OPS_ENABLE.detectBash();
  const out = {};
  for (const line of OPS_ENABLE.rowLines(row, bashPath)) {
    const m = /^\s{4}(\S+?):\s*(.*)$/u.exec(line);
    if (m === null) continue;
    const raw = m[2].trim();
    let value;
    if (raw === 'true') value = true;
    else if (raw === 'false') value = false;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
    else if (raw.length > 1 && raw[0] === '"' && raw[raw.length - 1] === '"') value = JSON.parse(raw);
    // 单引号 YAML 标量：ops-enable 从 2026-10-21 起用**单引号**写 bashPath
    // （JSON.stringify 会产出双反斜杠转义，与 profile 里的裸路径永不相等 -> 每次 --check 重写）。
    // YAML 单引号内不做反斜杠转义，用 ' 表示一个单引号。这里必须跟着认，
    // 否则 bashPath 会被当成字面量 "'C:\\...'"（带引号的假路径），D 段整段假红。
    else if (raw.length > 1 && raw[0] === "'" && raw[raw.length - 1] === "'") value = raw.slice(1, -1).replace(/''/gu, "'");
    else value = raw;
    out[m[1]] = value;
  }
  return out;
}


const declared = new Map();

async function report(root, agent, label) {
  const tools = root.get('tools');
  const visible = [...tools.view(agent).visible.keys()];
  const wire = tools.wireSchemas(agent).knownNames;
  const assembly = await root.get('systemPrompt').assemble({ scope: agent });
  const text = (name) => {
    const hit = assembly.sections.find((section) => section.name === name);
    return hit === undefined ? '(absent)' : (String(hit.text).trim() === '' ? '(empty)' : '(non-empty)');
  };
  const opsSeen = visible.filter((n) => n.startsWith('ops_')).sort();
  const opsWire = wire.filter((n) => n.startsWith('ops_')).sort();
  // 呈现档按**声明**报（我们调过 presentAs），不要用 wire.length 反推：
  // 第一版用 wire.length>1 判 both，结果 B 场景（没挂 file 组件、wire 只剩 run_code）被误标成 ptc。
  const mode = declared.get(agent.id) ?? '?';
  say('  ' + label + '：声明档=' + mode + '，wire ' + wire.length + ' 个'
    + ' 可见 ops_*=' + JSON.stringify(opsSeen)
    + ' 送模型 ops_*=' + JSON.stringify(opsWire)
    + ' 段[sdk=' + text('tools:sdk') + ', ptc-only=' + text('tools:ptc-only') + ']');
  return { opsSeen, opsWire, mode };
}

say('模块基准：' + ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-system-prompt'].map(versionOf).join(' / '));
say('dsh-ops = ' + JSON.parse(fs.readFileSync(path.join(opsRoot, 'package.json'), 'utf8')).version + ' @ ' + opsRoot);
say('');

// ── A：交付态 —— 按**装机那一代**的真实装配挂原版 dsh-ops（本包不改它一行源码）──
//
// 0.3.x：bundle patch insert 的是四个遗留组件行（shell/file/background/ptc）；
// 0.5.0：改成「一条预设一档」的 mode 行族 + discovery，遗留组件行**不再被 insert**。
// 探针必须按装机那一代挂，否则测的是 profile 已经不挂的东西（旧 A 段就是这么对
// 一份 0.5.0 打 ✗ 的：它还在 apply(`lib/components/file/index.js`)，而那一行早已不在 patch 里）。
const mountGenerationCore = async (root) => {
  if (OPS_GENERATION === 'legacy') {
    const fileComp = await import(opsFile('lib/components/file/index.js'));
    fileComp.apply(root, { promptPolicy: true, required: false });
    await tick(8);
    const ptcComp = await import(opsFile('lib/components/ptc/index.js'));
    ptcComp.apply(root, { required: false });
    await tick(8);
    return;
  }
  // mode 代：把 patch 里**默认启用**的 mode 行原样挂上（config 逐键来自装机 patch，不手写）。
  for (const row of OPS_INSERTED_ROWS) {
    if (row.disabled) continue;
    if (!/^dsh-ops-(mode-|discovery)/u.test(row.id)) continue;
    const component = row.id === 'dsh-ops-discovery' ? 'discovery' : row.id.replace('dsh-ops-', '');
    const mod = await import(opsFile('lib/components/' + component + '/index.js'));
    mod.apply(root, row.config);
    await tick(8);
  }
};

say('A) 装机 dsh-ops（原版，未改）· 装配代数 = ' + OPS_GENERATION
  + (OPS_WORKER_FILE === null ? ' · 原生 worker = 未安装' : ' · 原生 worker = ' + path.basename(OPS_WORKER_FILE)) + '：');
const rootA = await makeRoot();
await mountGenerationCore(rootA);
// 两名队员：一名纯 PTC 档（本包「批量调用 开」的装配结果），一名原生档。
// 注意这两名是**测试台架直接 presentAs 出来的**，不经过 applyMemberBatch —— 它们验的是 ops 的门，
// 不是本包的开关映射（后者由 integration-test 的装配断言负责）。
const matePtc = await makeMember(rootA, 'mate-ptc', 'ptc');
const mateNtv = await makeMember(rootA, 'mate-native', 'native');
const aPtc = await report(rootA, matePtc, '纯 PTC 档队员');
const aNtv = await report(rootA, mateNtv, '原生档队员');

// 判据按**能力是否可能发布**分叉：没有原生 worker 时 file/PTC 工具按设计就不发布
// （dsh-ops lib/ptc/runtime.js 的 resolveWorker 抛错 → 组件 warn 后不发布任何工具）。
// 那种情况下把它报成「适配失败」是错的 —— 本插件的适配对象是**行与呈现档**，不是别人的二进制。
const fileOk = FILE_TOOLS.every((n) => aPtc.opsSeen.includes(n) && aNtv.opsSeen.includes(n));
const ptcOk = PTC_TOOLS.every((n) => aPtc.opsSeen.includes(n));
const nativeNoPtc = PTC_TOOLS.every((n) => !aNtv.opsSeen.includes(n));
if (OPS_WORKER_FILE === null) {
  // 无 worker：这一段的 file/PTC 判据**不适用**（null = 跳过，不是失败）。
  say('  判定 A1（file 工具可见）= 跳过（本机 dsh-ops 没装原生 worker：runtime/ 与 native/target/ 都不存在，'
    + 'file 与 PTC 工具按设计不发布 —— 这是**装机缺件**，不是本插件适配坏了）');
  say('  判定 A2（纯 PTC 档可见 ops_batch/ops_result）= 跳过（同上）');
} else {
  say('  判定 A1（file 工具人人可见）= ' + (fileOk ? '✓' : '✗'));
  // 纯 PTC 档的判据是**可见**（view 里有 = run_code 程序里 await tools.ops_batch(...) 调得到）；
  // 它不进 wire 是官方设计 —— ptc 档把送给模型的工具裁成一个 run_code。
  say('  判定 A2（纯 PTC 档可见 ops_batch/ops_result，即可在 run_code 程序里调用）= '
    + (ptcOk ? '✓ 本包的杠杆成立，且没动 ops 一行源码' : '✗ 没拿到'));
}
say('  附带事实（原生档没有那两个工具，符合 ops 原版设计）= ' + (nativeNoPtc ? '✓' : '✗ 与预期不符'));
let okA = OPS_WORKER_FILE === null ? null : (fileOk && ptcOk);
if (okA === null && nativeNoPtc !== true) okA = false;

// 可见 ≠ 可用：真调一次 ops_batch 的 plan。plan 是**无副作用**的预检
// （dsh-ops lib/ptc/contract.js 原话 "action=plan … creates a no-effect audit plan"），不碰磁盘；
// 它的 execute 会**再查一遍**呈现档 —— 所以这一调同时验掉「呈现档在调用时仍然成立」，比看可见层强。
let execA = '（未测）';
if (ptcOk) {
  try {
    const def = rootA.get('tools').get('ops_batch', matePtc);
    const plan = await def.execute({
      root: fs.realpathSync(PLUGIN),
      action: 'plan',
      operations: [{ op: 'copy', path: 'package.json', to: '.probe-tmp/ops-batch-probe.json' }],
    }, { agent: matePtc, signal: new AbortController().signal });
    // 判据看**结构化字段**，不看 JSON 里有没有 "error" 这个子串（成功的 plan 里 error:null 也会命中子串）。
    const failed = plan === null || typeof plan !== 'object'
      || plan.status === 'failed' || (plan.error && plan.error.code)
      || plan.failed > 0 || plan.unknown > 0;
    const snapshot = JSON.stringify(plan).slice(0, 260);
    execA = (failed ? '✗ 被拒/失败：' : '✓ 调用成功（无副作用 plan，且 execute 里二次校验了呈现档）：') + snapshot;
    if (failed) okA = false;
  } catch (error) {
    execA = '✗ 调用抛错：' + (error && error.message ? error.message : String(error));
    okA = false;
  }
}
say('  真调一次 ops_batch(action=plan，无副作用) = ' + execA);
say('');

// ── B：负对照 —— 同一份原版组件，只差呈现档 ───────────────────────────────────
// 目的：证明 A2 的因果在**呈现档**（本包能配的那一项），不是环境凑巧。
// 没有 worker 时 PTC 工具在两种档下都不会出现 —— 此时这段**不适用**（okB = null），
// 而不是把「两者都拿不到」报成「负对照不成立」。
let okB = null;
if (OPS_WORKER_FILE === null) {
  say('B) 负对照：跳过（本机没有原生 worker，PTC 工具在任何呈现档下都不会发布 —— 用它做负对照证明不了任何事）');
  say('');
} else {
  const rootB = await makeRoot();
  const ptcCompB = await import(opsFile('lib/components/ptc/index.js'));
  ptcCompB.apply(rootB, { required: false });
  await tick(8);
  const seenOf = async (mode, tag) => {
    const agent = await makeMember(rootB, tag, mode);
    const seen = [...rootB.get('tools').view(agent).visible.keys()];
    return PTC_TOOLS.filter((n) => seen.includes(n));
  };
  // 组件的注册是异步 reconcile（agent/created 之后还要跑一轮），所以两种档各试几轮。
  let gotPtc = [];
  for (let i = 1; i <= 3 && gotPtc.length < 2; i += 1) gotPtc = await seenOf('ptc', 'mate-b-ptc-' + i);
  let gotNative = [];
  for (let i = 1; i <= 3; i += 1) { gotNative = await seenOf('native', 'mate-b-native-' + i); if (gotNative.length > 0) break; }
  okB = gotPtc.length === 2 && gotNative.length === 0;
  say('B) 负对照（同一份原版组件，只差呈现档）：ptc 档拿到 ' + JSON.stringify(gotPtc) + '，native 档拿到 ' + JSON.stringify(gotNative));
  say('  判定 B = ' + (okB
    ? '✓ ptc 档拿到 / native 档拿不到 —— 因果确实在呈现档。'
      + '（2026-10-21 语义：本包「批量调用 开」= ptc 档 → 拿得到这两个工具；关 = native → 拿不到）'
    : '✗ 与预期不符：说明 ops 的门或本包的杠杆需要重新核对'));
  say('');
}


// ── C：background 组件（真 spawn FastCtx 服务器）───────────────────────────────
// 为什么必须实测它：四个组件里只有它的发布门最长 —— 要 fastctx 二进制 + bash 可解析
// + 会话 danger-full-access 三样同时成立（dsh-ops lib/tools.js:311-316），
// 而本机 @dsh-ops/bash-win32-x64 没装，靠 profile 那行的 allowSystemShellFallback: true
// 让 Git bash 顶上。这一条不实测就没人知道那四个 job 工具到底在不在。
// FastCtx 走裸 spawn（dsh-ops lib/handshake.js:134），不经 ctx.get('subprocess')，
// 所以离线台架能真的把它挂起来。
say('C) background 组件（真起 FastCtx 服务器）：');
let okC = null;
try {
  // 2026-10-21：dsh-ops 0.3.2 **整体移除**了 background 组件（FastCtx）。
  // lib/binary.js 也已经不在了，所以这一段原本只会抛「Cannot find module」。
  // 判据改成：装机那份里还有没有 background 的真实实现 —— 没有就如实跳过，
  // 并说明为什么跳过（而不是把「模块没了」当成一次失败挂在报告里）。
  if (!fs.existsSync(opsFile('lib/components/background/worker/index.js'))
    && !fs.existsSync(opsFile('lib/binary.js'))) {
    say('  判定 C = 跳过（dsh-ops ' + (JSON.parse(fs.readFileSync(path.join(opsRoot, 'package.json'), 'utf8')).version ?? '?') + ' 已移除 background / FastCtx 组件：'
      + 'lib/components/background/index.js 只剩一个只 warn 一次的空壳，不再发布 ops_run_background / ops_job_*）');
    // 用 okC = null 表示「跳过」（总体判定接受 null），**不能抛对象** ——
    // 下面那个 catch 会把任何抛出的东西都记成「挂载失败」，于是跳过会显示成失败。
    okC = null;
    throw new Error('__OPS_C_SKIPPED__');
  }
  const { resolveBinary, probeBinary } = await import(opsFile('lib/binary.js'));
  const { resolveShells } = await import(opsFile('lib/shells.js'));
  const rt = resolveBinary({ packageRoot: opsRoot });
  const probe = probeBinary(rt.file);
  // 用**本包真正会写进 profile 的那份配置**（detectBash 与 ops-enable 共用，不各写一份）：
  // 只给 allowSystemShellFallback 会让 PATH 兜底选中 WindowsApps 的 WSL 启动器，
  // 而 FastCtx 明确拒绝它 —— 那样测的就不是交付态。
  const { detectBash } = createRequire(path.join(PLUGIN, 'package.json'))('./tools/ops-enable.cjs');
  const bashPath = detectBash();
  const shells = resolveShells({ bashPath: bashPath ?? undefined, allowSystemShellFallback: bashPath === null, publishBashTool: true, shellPolicy: 'advise' });
  say('  fastctx = ' + path.basename(rt.file) + '（' + rt.source + '，probe ' + (probe.ok ? 'ok' : 'FAIL') + ' ' + (probe.version ?? '') + '）');
  say('  bash = ' + (shells.bash.available ? shells.bash.file : '(不可解析：' + String(shells.bash.detail).slice(0, 60) + ')'));
  if (probe.ok !== true) {
    say('  判定 C = 跳过（fastctx 不可用：' + probe.detail + '）');
  } else {
    const rootC = await makeRoot();
    const bgComp = await import(opsFile('lib/components/background/index.js'));
    bgComp.apply(rootC, { promptPolicy: true, enableShellTools: true, required: false, toolCallTimeoutMs: 300000,
      allowSystemShellFallback: bashPath === null, ...(bashPath === null ? {} : { bashPath }), configUpdateVersion: OPS_ENABLE.CONFIG_UPDATE_VERSION });
    const jobTools = ['ops_run_background', 'ops_job_output', 'ops_job_list', 'ops_job_kill'];
    // 后台工具注册在**这名队员自己的层**上（dsh-ops lib/tools.js:358-366），而注册动作发生在
    // attachAgent → refreshAgents；FastCtx 握手（spawn + initialize + listTools，约 4-6s）完成前
    // bashAvailable 还是 false（lib/tools.js:477），那一发就会空手。
    // 生产里队员永远在插件启动完成之后才被派出，所以这里**连派几名**（每派一名都触发一次刷新）：
    // 第一发撞上启动窗口、后续拿到 = 正常；全都拿不到 = 门真没过。
    let c = null;
    let gotC = [];
    let attempts = 0;
    let mateC = null;
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      attempts += 1;
      mateC = await makeMember(rootC, 'mate-bg-' + attempts, 'both');
      const seen = [...rootC.get('tools').view(mateC).visible.keys()];
      gotC = jobTools.filter((n) => seen.includes(n));
      c = await report(rootC, mateC, 'both 队员 #' + attempts);
      if (gotC.length === jobTools.length) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    say('  尝试次数 = ' + attempts + '（每发都是一名新队员，与生产同一条路径）');
    okC = gotC.length === jobTools.length;
    // 发布 ≠ 可用：真调一次 run_background，让 FastCtx 自己裁决这个 bash 行不行。
    let execNote = '（未测）';
    if (okC) {
      try {
        const def = rootC.get('tools').get('ops_run_background', mateC);
        // dsh-ops 的 execute 只要 exec.agent.session（权限门从 ctx.get('sandboxPolicy')
        // 按 session 解析，lib/tools.js:666-669）+ exec.signal；cwd 缺省取 session.header.cwd。
        const exec = { agent: mateC, signal: new AbortController().signal };
        const result = await def.execute({ command: 'echo ops-mount-check-ok' }, exec);
        const text = JSON.stringify(result).slice(0, 260);
        const bad = /POLICY_DENIED|not a working bash|error/i.test(text);
        execNote = (bad ? '✗ 调用被拒：' : '✓ 调用成功：') + text;
        okC = !bad;
      } catch (error) {
        execNote = '✗ 调用抛错：' + (error && error.message ? error.message : String(error));
        okC = false;
      }
    }
    say('  真调一次 ops_run_background = ' + execNote);
    say('  判定 C = ' + (okC
      ? '✓ 四个 job 工具全部发布且真能跑（bashPath 指到可用 bash + danger-full-access 门过）'
      : '✗ 只拿到 ' + JSON.stringify(gotC) + '（bash 解析或权限门没过 —— 检查 profile 的 allowSystemShellFallback 与迁移标记）'));
    // 收尾：FastCtx 有父进程监视（FASTCTX_NO_PARENT_WATCH=0），进程退出即回收。
    if (typeof rootC.dispose === 'function') rootC.dispose();
  }
} catch (error) {
  if (error && error.message === '__OPS_C_SKIPPED__') {
    // 上面那条「已移除 background」的说明已经打印过了，这里不再重复一条失败。
    okC = null;
  } else say('  判定 C = 挂载失败：' + (error && error.message ? error.message : String(error)));
}
say('');

say('');

// ── D：shell 通道（ops_bash 是否发布 + 冲突口径是否被本包的 extraGuidance 消解）────
//
// 冲突点：ops 的 routing 段写「Prefer ops_bash … do not switch shells」，与本团队 preset 的
// persistent-pwsh 矛盾。本包用 ops 自己的**公开扩展点** extraGuidance 把口径改回来（不改其源码）。
//
// 为什么这里不做「挂组件 + 读 assemble 段」：0.5.0 的段文本函数在
// `entries.get(agent)` 为空时**按设计返回空串**（lib/modes/native.js：`if (!entry || entry.owned.size === 0) return '';`），
// 而 entries 要原生 worker 才能填。本机没 worker → 段恒为空 → 拿 assemble 判就永远是假红
// （第一版 D 段就是这样对一份 0.5.0 打 ✗ 的）。改用 ops 自己渲染段的那个函数本身：
// `renderToolingPolicy({published, shellComponent, extraGuidance})` 是**纯函数**，
// 参数取本机实测的发布集合，判据因此确定且可复现。
say('D) shell 通道（ops_bash + extraGuidance）· 装配代数 = ' + OPS_GENERATION + '：');
let okD = null;
try {
  // ① ops_bash 在真实装配里是否真的发布（A 段那次 mount 的实测结果，不另起一套装配）。
  const bashPublished = aNtv.opsSeen.includes('ops_bash') || aPtc.opsSeen.includes('ops_bash');
  // ② 本包的 extraGuidance 是否真的被 ops 的渲染函数追加到段尾。
  const policyMod = await import(opsFile('lib/policy.js'));
  const publishedForRender = [...new Set([...aNtv.opsSeen, ...aPtc.opsSeen])].filter((n) => n.startsWith('ops_'));
  const rendered = String(policyMod.renderToolingPolicy({
    published: publishedForRender,
    shellComponent: true,
    extraGuidance: OPS_TEAM_SHELL_GUIDANCE,
  }) || '');
  const overrideIn = rendered.indexOf('OPS-TEAM OVERRIDE') >= 0;
  const originalIn = /Prefer ops_bash/u.test(rendered);
  okD = bashPublished === true && overrideIn === true;
  say('  本机实际发布的 ops_* = ' + JSON.stringify(publishedForRender));
  say('  ops_bash 已发布 = ' + bashPublished);
  say('  ops 原文「Prefer ops_bash…」在段里 = ' + originalIn
    + '；本包的 OVERRIDE 追加在段里 = ' + overrideIn);
  if (overrideIn) {
    const tail = rendered.slice(Math.max(0, rendered.indexOf('OPS-TEAM OVERRIDE') - 40));
    say('  段尾（OVERRIDE 那一段）= ' + JSON.stringify(tail.slice(0, 160)));
  }
  say('  判定 D = ' + (okD
    ? '✓ ops_bash 可用，且冲突口径由 ops 自己的公开扩展点消解（未改其源码）'
    : '✗ ops_bash 未发布，或 extraGuidance 没进渲染结果（检查 SHELL_OVERRIDE_TEXT 与 ops 的 renderToolingPolicy）'));
} catch (error) {
  say('  判定 D = 失败：' + (error && error.message ? error.message : String(error)));
}
say('');


// 总体判定：null = **不适用**（跳过），与 true 同样放行；false = 真失败。
// 2026-10-29 修：旧式写的是 `okA === true && ...`，于是 A 段一旦跳过（本机没原生 worker）
// 总体就恒为「不通过」—— 把「环境缺件」报成了「插件坏了」。四个判定语义统一成三值。
const verdict = (value) => value !== false;
const parts = [
  ['A ' + (okA === null ? '跳过' : '交付态'), okA],
  ['B ' + (okB === null ? '跳过' : '负对照'), okB],
  ['C ' + (okC === null ? '跳过' : '后台任务'), okC],
  ['D ' + (okD === null ? '跳过' : 'shell'), okD],
];
const pass = parts.every(([, value]) => verdict(value));
const failedParts = parts.filter(([, value]) => value === false).map(([label]) => label);
say(pass
  ? '总体：通过（' + parts.map(([label]) => label).join(' / ') + '）'
  : '总体：不通过（失败项：' + failedParts.join(' / ') + '）');
process.exitCode = pass ? 0 : 1;
// FastCtx 子进程/管道句柄会钉住事件循环；判定已打印并已落盘，直接结束进程。
setTimeout(() => process.exit(pass ? 0 : 1), 500).unref?.();
process.exit(pass ? 0 : 1);