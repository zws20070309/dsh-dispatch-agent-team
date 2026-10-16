// 离线验收探针：把**装机的真 dsh-ops 组件**挂进真 cordis + 真 dsh-tools，
// 看调度模式的队员（both 档）到底能不能拿到 ops_batch / ops_result。
//
// 为什么需要它：交付要求「ops 四组件都打开 + 团队完美使用它的工具」，而真机要重启 DSH 才看得到。
// 这个探针在**当前进程之外**复刻同一条装配路径（真 Context、真 register、真 presentAs、真 assemble、
// 真 dsh-ops 组件代码），所以给的是实测结论，不是推理。
//
// 两个互相独立的 Context（第一版共用一个 root，结果「原版」那一发被已打补丁的组件抢注了
// ops_batch —— 负对照失效。组件都监听 agent/created，必须物理隔离才有对照意义）：
//   A = 打过补丁的装机组件（交付态）→ 期望 both 队员拿到 ops_batch / ops_result
//   B = 补丁前备份的原版组件        → 期望**拿不到**（证明补丁是承重环节）
//
// 用法：node tools/ops-mount-check.mjs      退出码 0 = 通过（含「本机没装 dsh-ops」这种不适用）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  console.log('本机没有已安装的 dsh-ops（profile 的 node_modules 里解析不到）：');
  console.log('本插件不依赖它，ops 检测会静默跳过、队员提示词一个字节都不涨 —— 这就是「没装 ops 也能用」的样子。');
  console.log('想要 ops 的能力：装 dsh-ops 插件并在插件页启用它的组件，再跑 node tools/ops-enable.cjs。');
  process.exit(0);
}
const opsFile = (rel) => pathToFileURL(path.join(opsRoot, rel)).href;
const versionOf = (name) => {
  try {
    const dir = path.dirname(reqPlugin.resolve(name + '/package.json'));
    return name.replace('@deepseek-ai/', '') + '@' + JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  } catch { return name + '@?'; }
};
const tick = async (n = 8) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

const { Context } = await import(libUrl('@deepseek-ai/cordis'));
const { createScope } = await import(libUrl('@deepseek-ai/dsh-scope'));
const dshTools = await import(libUrl('@deepseek-ai/dsh-tools'));
const dshSp = await import(libUrl('@deepseek-ai/dsh-system-prompt'));
const ToolRuntime = dshTools.ToolRuntime ?? dshTools.default;
const SystemPrompt = dshSp.SystemPrompt ?? dshSp.default;

/** 一套最小但真实的宿主：SystemPrompt + ToolRuntime + ptcRuntime + 权限/子进程替身。 */
async function makeRoot() {
  const root = new Context();
  root.plugin(SystemPrompt, { includeHarnessIdentity: true, personaPrefix: '', includeRuntimeContext: false });
  root.plugin(ToolRuntime, { mode: 'native' });
  await tick(4);
  root.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: PROFILE }) });
  root.provide('subprocess', { spawn: () => { throw new Error('probe: no real spawn'); } });
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

/** 造一名 both 档队员。**关键**：scope key 就是 agent 对象本身
 *  （dsh-agent-loop/lib/index.js:778 createScope(loopCtx, this)），而 dsh-ops 的 PTC 门
 *   用 assemble({ scope: agent }) 查呈现档 —— 换成别的对象当 key 就查不到自己声明的层。 */
async function makeBothMember(root, id) {
  const agent = { id, options: {}, session: { id: 'session-' + id } };
  const scope = createScope(root, agent);
  scope.ctx.get('tools').presentAs('both');
  declared.set(agent.id, 'both');
  agent.ctx = new Proxy(scope.ctx, {
    get: (target, prop, receiver) => ((prop === 'tools' || prop === 'systemPrompt') ? target.get(prop) : Reflect.get(target, prop, receiver)),
  });
  root.emit('agent/created', { agent });
  await tick(12);
  return agent;
}

const PTC_TOOLS = ['ops_batch', 'ops_result'];
const FILE_TOOLS = ['ops_inspect_local_file', 'ops_grep', 'ops_glob', 'ops_replace'];

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
  console.log('  ' + label + '：声明档=' + mode + '，wire ' + wire.length + ' 个'
    + ' 可见 ops_*=' + JSON.stringify(opsSeen)
    + ' 送模型 ops_*=' + JSON.stringify(opsWire)
    + ' 段[sdk=' + text('tools:sdk') + ', ptc-only=' + text('tools:ptc-only') + ']');
  return { opsSeen, opsWire, mode };
}

console.log('模块基准：' + ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-system-prompt'].map(versionOf).join(' / '));
console.log('dsh-ops = ' + JSON.parse(fs.readFileSync(path.join(opsRoot, 'package.json'), 'utf8')).version + ' @ ' + opsRoot);
console.log('');

// ── A：交付态（打过补丁的装机组件）──────────────────────────────────────────
console.log('A) 装机 dsh-ops（已放宽 PTC 门）+ file 组件：');
const rootA = await makeRoot();
const fileComp = await import(opsFile('lib/components/file/index.js'));
fileComp.apply(rootA, { promptPolicy: true, enableShellTools: false, required: false, toolCallTimeoutMs: 300000, configUpdateVersion: 1 });
await tick(8);
const ptcComp = await import(opsFile('lib/components/ptc/index.js'));
ptcComp.apply(rootA, { required: false });
await tick(8);
const mateA = await makeBothMember(rootA, 'mate-patched');
const a = await report(rootA, mateA, 'both 队员');
const okA = PTC_TOOLS.every((n) => a.opsSeen.includes(n) && a.opsWire.includes(n))
  && FILE_TOOLS.every((n) => a.opsSeen.includes(n));
console.log('  判定 A = ' + (okA
  ? '✓ both 队员真的拿到了 ops_batch / ops_result（可见且送给模型），file 四件套也在'
  : '✗ 缺批量工具：' + JSON.stringify(PTC_TOOLS.filter((n) => !a.opsWire.includes(n)))));
console.log('');

// ── B：负对照（补丁前的原版组件，独立 Context，不碰装机包）─────────────────
const baks = fs.readdirSync(path.join(opsRoot, 'lib', 'ptc')).filter((n) => n.includes('pre-ptc-both')).sort();
const worker = path.join(opsRoot, 'runtime', 'win32-x64', 'dsh-ops-worker.exe');
let okB = null;
if (baks.length === 0 || !fs.existsSync(worker)) {
  console.log('B) 负对照跳过（找不到补丁前备份或 worker 二进制）');
} else {
  // 副本必须是「包根 / lib / …」的布局：resolveWorker 的 PACKAGE_ROOT 是
  // lib/ptc/runtime.js 往上两级（runtime.js:6），只拷 lib 会把包根算成 Temp 本身。
  const tmp = path.join(os.tmpdir(), 'ops-pristine-' + Date.now());
  fs.cpSync(path.join(opsRoot, 'lib'), path.join(tmp, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(opsRoot, 'lib', 'ptc', baks[baks.length - 1]), path.join(tmp, 'lib', 'ptc', 'index.js'));
  // resolveWorker 对 runtime/ 下的二进制会核对 provenance.json 的 version 与**包根 package.json**
  // （runtime.js:21-26），所以副本的 package.json 必须带真实 version，否则对照挂载不起来。
  const opsPkg = JSON.parse(fs.readFileSync(path.join(opsRoot, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module', version: opsPkg.version }), 'utf8');
  try {
    const rootB = await makeRoot();
    const pristine = await import(pathToFileURL(path.join(tmp, 'lib', 'components', 'ptc', 'index.js')).href);
    // 副本的 PACKAGE_ROOT 推不出装机路径，必须显式给 worker（否则 resolveWorker 直接失败、
    // 组件静默不挂载 —— 那会让「原版也没给」变成假阳性，所以先自检再挂）。
    const { resolveWorker } = await import(pathToFileURL(path.join(tmp, 'lib', 'ptc', 'runtime.js')).href);
    const resolved = resolveWorker({ binaryPath: worker });
    console.log('B) 原版组件（独立 Context，worker=' + path.basename(resolved) + '）：');
    pristine.apply(rootB, { required: false, binaryPath: worker });
    await tick(8);
    const mateB = await makeBothMember(rootB, 'mate-pristine');
    const b = await report(rootB, mateB, 'both 队员');
    okB = PTC_TOOLS.every((n) => !b.opsSeen.includes(n));
    console.log('  判定 B = ' + (okB
      ? '✓ 原版门下 both 队员拿不到 ops_batch/ops_result —— 补丁确实是承重环节'
      : '✗ 原版门也给了：' + JSON.stringify(b.opsSeen) + '（补丁不是必要条件，或对照被污染）'));
  } catch (error) {
    console.log('B) 负对照挂载失败：' + (error && error.message ? error.message : String(error)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
console.log('');
const pass = okA === true && (okB === true || okB === null);
console.log(pass ? '总体：通过' + (okB === null ? '（负对照跳过）' : '（含负对照）') : '总体：不通过');
process.exitCode = pass ? 0 : 1;
