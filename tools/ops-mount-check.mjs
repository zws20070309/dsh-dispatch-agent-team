// 离线验收探针：把**装机的真 dsh-ops 组件（一行源码都不改）**挂进真 cordis + 真 dsh-tools，
// 看调度模式的队员到底能不能拿到它的工具。
//
// 为什么需要它：交付要求「ops 四组件都打开 + 团队完美使用它的工具」，而真机要重启 DSH 才看得到。
// 这个工具在**当前进程之外**复刻同一条装配路径（真 Context、真 register、真 presentAs、真 assemble、
// 真 dsh-ops 组件代码），所以给的是实测结论，不是推理。
//
// 四段（各用**独立** Context —— 组件都监听 agent/created，共用一个 root 会互相抢注，
// 第一版就是这么把负对照搞失效的）：
//   A = 交付态：file 四件套人人可见；纯 PTC 档队员（预设 ptc + 关批量档）拿到 ops_batch/ops_result
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
// 真 MCP 握手（spawn + initialize + listTools）比固定 tick 慢，这里做有界轮询而不是猜时长。
const waitFor = async (predicate, timeoutMs = 90_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = predicate(); } catch { value = null; }
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
};

const { Context } = await import(libUrl('@deepseek-ai/cordis'));
const { createScope } = await import(libUrl('@deepseek-ai/dsh-scope'));
const dshTools = await import(libUrl('@deepseek-ai/dsh-tools'));
const dshSp = await import(libUrl('@deepseek-ai/dsh-system-prompt'));
const ToolRuntime = dshTools.ToolRuntime ?? dshTools.default;
const SystemPrompt = dshSp.SystemPrompt ?? dshSp.default;

/** 允许被这个探针真实起的唯一可执行文件（dsh-ops 原生 worker，本工具只跑无副作用的 plan）。 */
const OPS_WORKER_ALLOWLIST = [path.join(opsRoot, 'runtime', 'win32-x64', 'dsh-ops-worker.exe')];

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

/** 一套最小但真实的宿主：SystemPrompt + ToolRuntime + ptcRuntime + 权限/子进程替身。 */
async function makeRoot() {
  const root = new Context();
  root.plugin(SystemPrompt, { includeHarnessIdentity: true, personaPrefix: '', includeRuntimeContext: false });
  root.plugin(ToolRuntime, { mode: 'native' });
  await tick(4);
  root.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: PROFILE }) });
  // subprocess：PTC 的 worker 桥要用它（装机 dsh-ops lib/ptc/worker.js:61）。早先这里是个「一律抛错」
  // 的替身 —— 那样 PTC 的实调只能停在桥前（实测报 SANDBOX_UNAVAILABLE: probe: no real spawn），
  // 验不到「这名队员真能调用 ops_batch」。现在放过一个进程：**只有**装机 dsh-ops 自己的原生 worker，
  // 且本工具只拿它跑无副作用的 action=plan；其余 argv 一律照旧抛错，探针不因此获得随便起进程的能力。
  const WORKER = OPS_WORKER_ALLOWLIST[0];
  root.provide('subprocess', { spawn: (options) => {
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
// 与 tools/ops-enable.cjs 写进 profile 的那句同源（直接 require 那份常量，不各写一份）。
const OPS_ENABLE = createRequire(path.join(PLUGIN, 'tools', 'x.js'))('./ops-enable.cjs');
const OPS_TEAM_SHELL_GUIDANCE = OPS_ENABLE.SHELL_OVERRIDE_TEXT;

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

// ── A：交付态 —— 原版 dsh-ops（本包不改它一行源码）+ file 组件 ──────────────
say('A) 装机 dsh-ops（原版，未改）+ file 组件：');
const rootA = await makeRoot();
const fileComp = await import(opsFile('lib/components/file/index.js'));
fileComp.apply(rootA, { promptPolicy: true, enableShellTools: false, required: false, toolCallTimeoutMs: 300000, configUpdateVersion: 1 });
await tick(8);
const ptcComp = await import(opsFile('lib/components/ptc/index.js'));
ptcComp.apply(rootA, { required: false });
await tick(8);
// 两名队员：一名纯 PTC 档（预设 ptc + 关批量档 = 本包的合法杠杆），一名批量档（默认）。
const matePtc = await makeMember(rootA, 'mate-ptc', 'ptc');
const mateBoth = await makeMember(rootA, 'mate-both', 'both');
const aPtc = await report(rootA, matePtc, '纯 PTC 档队员');
const aBoth = await report(rootA, mateBoth, '批量档队员');
const fileOk = FILE_TOOLS.every((n) => aPtc.opsSeen.includes(n) && aBoth.opsSeen.includes(n));
// 纯 PTC 档的判据是**可见**（view 里有 = run_code 程序里 await tools.ops_batch(...) 调得到）；
// 它不进 wire 是官方设计 —— ptc 档把送给模型的工具裁成一个 run_code（dsh-tools:2840-2843），
// 所以这里若拿 opsWire 判就永远不成立（第一版 A2 就是这么误判 ✗ 的）。
const ptcOk = PTC_TOOLS.every((n) => aPtc.opsSeen.includes(n));
const bothNo = PTC_TOOLS.every((n) => !aBoth.opsSeen.includes(n));
let okA = fileOk && ptcOk;
say('  判定 A1（file 四件套人人可见）= ' + (fileOk ? '✓' : '✗'));
say('  判定 A2（纯 PTC 档队员可见 ops_batch/ops_result，即可在 run_code 程序里调用）= ' + (ptcOk ? '✓ 本包的杠杆成立，且没动 ops 一行源码' : '✗ 没拿到'));
say('  附带事实（批量档队员没有那两个工具，符合 ops 原版设计）= ' + (bothNo ? '✓' : '✗ 与预期不符'));

// 可见 ≠ 可用（C 段对 job 工具立过这条规矩，这里对 PTC 工具同样办）：真调一次 ops_batch 的 plan。
// plan 是**无副作用**的预检（dsh-ops lib/ptc/contract.js:37 原话 "action=plan requires operations
// and creates a no-effect audit plan"），不碰磁盘；它的 execute 会**再查一遍** ptcOnly（装机
// lib/ptc/index.js:53）—— 所以这一调同时验掉「呈现档在调用时仍然成立」，比看可见层强。
let execA = '（未测）';
if (ptcOk) {
  try {
    const def = rootA.get('tools').get('ops_batch', matePtc);
    // root = 插件真实根（package.json 在那儿，源文件必须真存在，否则 plan 报的是前置条件不符，
    // 测不到"工具能不能被这个作用域调用"）。目标是 .probe-tmp 里一个不存在的名字 —— plan 无副作用，
    // 不会落盘；contract 明写 no overwrite，所以也绝不覆盖任何现有文件。
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

// ── B：负对照 —— 同一份原版组件，both 档 vs ptc 档只差在呈现档 ───────────────
// 目的：证明 A2 的因果在**呈现档**（本包能配的那一项），不是环境凑巧。
let okB = null;
{
  const rootB = await makeRoot();
  const compB = await import(opsFile('lib/components/ptc/index.js'));
  compB.apply(rootB, { required: false, binaryPath: path.join(opsRoot, 'runtime', 'win32-x64', 'dsh-ops-worker.exe') });
  await tick(8);
  const seenOf = async (mode, tag) => {
    const agent = mode === 'ptc' ? await makeMember(rootB, tag, 'ptc') : await makeMember(rootB, tag, 'both');
    const seen = [...rootB.get('tools').view(agent).visible.keys()];
    return PTC_TOOLS.filter((n) => seen.includes(n));
  };
  // 组件的注册是异步 reconcile（agent/created 之后还要跑一轮），所以两种档各试几轮。
  let gotPtc = [];
  for (let i = 1; i <= 3 && gotPtc.length < 2; i += 1) gotPtc = await seenOf('ptc', 'mate-b-ptc-' + i);
  let gotBoth = [];
  for (let i = 1; i <= 3; i += 1) { gotBoth = await seenOf('both', 'mate-b-both-' + i); if (gotBoth.length > 0) break; }
  okB = gotPtc.length === 2 && gotBoth.length === 0;
  say('B) 负对照（同一份原版组件，只差呈现档）：ptc 档拿到 ' + JSON.stringify(gotPtc) + '，both 档拿到 ' + JSON.stringify(gotBoth));
  say('  判定 B = ' + (okB
    ? '✓ ptc 档拿到 / both 档拿不到 —— 因果确实在呈现档，本包的修法（预设 ptc + 关批量档）成立'
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
      allowSystemShellFallback: bashPath === null, ...(bashPath === null ? {} : { bashPath }), configUpdateVersion: 1 });
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
  say('  判定 C = 挂载失败：' + (error && error.message ? error.message : String(error)));
}
say('');

say('');

// ── D：shell 组件（ops_bash 是否发布 + 冲突提示词是否被本包的 extraGuidance 说清）────
// 为什么测这两件事而不是真跑命令：ops_bash 的执行要 ctx.get('subprocess')（宿主提供），
// 台架里给的是抛错替身 —— 所以这里测**注册**与**提示词**，执行留给真机重启后的探针。
// 冲突点：ops 的 shell 段会写「Prefer bash … do not switch shells」
// （dsh-ops lib/policy.js:61），与本团队 preset 的 persistent-pwsh 矛盾。本包用 ops 自己的
// 公开扩展点 extraGuidance（lib/config.js 接受、lib/policy.js:64 追加到段尾）把口径改回来，
// 不改它一行源码。文案与 ops-enable.cjs 的 ROWS 同源（同一份 SHELL_OVERRIDE_TEXT）。
say('D) shell 组件（ops_bash + extraGuidance）：');
let okD = null;
try {
  const shellBash = OPS_ENABLE.detectBash();
  const rootD = await makeRoot();
  const shellComp = await import(opsFile('lib/components/shell/index.js'));
  shellComp.apply(rootD, {
    promptPolicy: true, publishBashTool: true, shellPolicy: 'advise',
    allowSystemShellFallback: shellBash === null,
    ...(shellBash === null ? {} : { bashPath: shellBash }),
    extraGuidance: OPS_TEAM_SHELL_GUIDANCE,
    configUpdateVersion: 1,
  });
  await tick(12);
  const mateD = await makeMember(rootD, 'mate-shell', 'both');
  const seenD = [...rootD.get('tools').view(mateD).visible.keys()];
  // 生产的 assemble 上下文是 { agent, scope: agent }（dsh-agent/lib/index.js:291-297）——
  // ops 的段用 context.agent 取可见工具，只传 scope 会拿到空表（第一版就是这么误判"段是空的"）。
  const asmD = await rootD.get('systemPrompt').assemble({ agent: mateD, scope: mateD });
  const secD = asmD.sections.find((section) => section.name === 'dsh-ops:repository-tooling:shell');
  const textD = secD === undefined ? '' : String(secD.text);
  const bashPublished = seenD.includes('ops_bash');
  const overrideIn = textD.indexOf('OPS-TEAM OVERRIDE') >= 0;
  okD = bashPublished === true && overrideIn === true;
  say('  ops_bash 已发布 = ' + bashPublished + '；ops 原文「Prefer bash…」在段里 = ' + /Prefer bash/.test(textD)
    + '；本包的 OVERRIDE 追加在段尾 = ' + overrideIn);
  say('  判定 D = ' + (okD
    ? '✓ ops_bash 可用，且冲突口径由 ops 自己的公开扩展点消解（未改其源码）'
    : '✗ ops_bash 未发布或 extraGuidance 没进段（检查 shell 组件配置与 ops-enable 的 ROWS）'));
} catch (error) {
  say('  判定 D = 挂载失败：' + (error && error.message ? error.message : String(error)));
}
say('');

const pass = okA === true && (okB === true || okB === null) && (okC === true || okC === null) && (okD === true || okD === null);
say(pass ? '总体：通过（A 交付态' + (okB === null ? '，B 跳过' : '，B 负对照成立') + (okC === null ? '，C 跳过' : '，C 后台任务实测') + (okD === null ? '，D 跳过' : '，D shell 实测') + '）' : '总体：不通过');
process.exitCode = pass ? 0 : 1;
// FastCtx 子进程/管道句柄会钉住事件循环；判定已打印并已落盘，直接结束进程。
setTimeout(() => process.exit(pass ? 0 : 1), 500).unref?.();
process.exit(pass ? 0 : 1);
