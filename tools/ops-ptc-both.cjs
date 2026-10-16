#!/usr/bin/env node
/**
 * ops-ptc-both.cjs —— 给已安装的 dsh-ops 的 **PTC 增强组件**放宽注册门（2026-10-15）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * dsh-ops 0.3.0 的 lib/ptc/index.js 只在**纯 PTC 呈现档**下注册 ops_batch / ops_result：
 *   return assembly.tools.length === 1 && assembly.tools[0].name === 'run_code'
 *     && assembly.sections.some(s => s.name === 'tools:ptc-only' && s.text.trim() !== '')
 * 而调度模式智能体团队的队员默认是**批量调用档（both）**：原生工具照常直调 + run_code 并存
 * （lib/runtime.js applyMemberBatch -> tools.presentAs('both')）。both 下
 * dsh-tools wireSchemas（:2844-2847）返回**全部工具 + run_code**，所以 assembly.tools.length
 * 远大于 1 → 原版门把 ops_batch / ops_result 挡在每一个队员之外 —— PTC 增强组件对本团队
 * 等于没装。这就是"要适配"的真正落点（用户 2026-10-15 点名：尤其是 PTC 加强组件）。
 *
 * ── 改法（只用公开装配事实，不碰私有面）──────────────────────────────────
 * 把"恰好 1 个 run_code"放宽为"run_code 在装配结果里 + 有 PTC 系段"，三态判定：
 *   native —— 没有 run_code：不注册（与原版一致）
 *   ptc    —— 只有 run_code 且 tools:ptc-only 段非空（原版判据，逐字保留）
 *   both   —— 有 run_code 且 tools:sdk 段非空（both 档官方就注册这段；
 *             tools:ptc-only 在 both 下被官方渲染成空文本 -> 不会误判成 ptc）
 * 仍然**只用** systemPrompt.assemble 的公开返回值（ops 自己的注释就要求这样做：
 * "never inspect private modeFor/layers"），并在每次调用时复核，语义不降级。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────
 *   node tools/ops-ptc-both.cjs            # 检测 + 需要时打补丁（写 .bak-<ts>-pre-ptc-both）
 *   node tools/ops-ptc-both.cjs --check    # 只检查，不写（drift-check 用）
 *   node tools/ops-ptc-both.cjs --revert   # 还原成原版
 * 退出码：0 = 已是目标态/打好/无需处理；1 = 目标文件不在预期形状（拒绝盲改）。
 * 没装 dsh-ops 时：打印说明并退 0（本仓库不依赖它）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TARGET_REL = path.join('lib', 'ptc', 'index.js');
/** 标记补丁已生效（三态判定函数名）。 */
const MARKER = 'function ptcPresentation(';

// ── 原版片段（逐字取自 0.3.0；任何一处不匹配就拒绝盲改）────────────────────
const ORIGIN_PTC_ONLY = [
  'async function ptcOnly(ctx, agent, signal) {',
  "  if (!agent?.ctx || !ctx.get('ptcRuntime')) return false",
  "  const assembly = await ctx.get('systemPrompt').assemble({ scope: agent, signal })",
  '  // Host wire presentation distinguishes ptc (only reserved transport) from both/native.',
  "  return assembly.tools.length === 1 && assembly.tools[0].name === 'run_code'",
  "    && assembly.sections.some(section => section.name === 'tools:ptc-only' && section.text.trim() !== '')",
  '}',
].join('\n');

const PATCHED_PTC_ONLY = [
  '/** Effective presentation from public assembly facts: native | ptc | both. */',
  'function ptcPresentation(assembly) {',
  "  const transport = assembly.tools.some(tool => tool.name === 'run_code')",
  "  const ptcOnlySection = assembly.sections.some(section => section.name === 'tools:ptc-only' && section.text.trim() !== '')",
  "  const sdkSection = assembly.sections.some(section => section.name === 'tools:sdk' && section.text.trim() !== '')",
  "  if (!transport) return 'native'",
  "  if (ptcOnlySection) return 'ptc'",
  "  return sdkSection ? 'both' : 'native'",
  '}',
  '',
  '/** PTC-family gate: pure ptc (original) OR the batch-call mode (both), which the',
  ' * dispatch agent team turns on for teammates by default. Never inspect private',
  ' * modeFor/layers -- the public assembly is authoritative, as upstream intended.',
  " * Widened by @zws/dsh-dispatch-agent-team (tools/ops-ptc-both.cjs); revert with --revert. */",
  'async function ptcOnly(ctx, agent, signal) {',
  "  if (!agent?.ctx || !ctx.get('ptcRuntime')) return false",
  "  const assembly = await ctx.get('systemPrompt').assemble({ scope: agent, signal })",
  "  return ptcPresentation(assembly) !== 'native'",
  '}',
].join('\n');

const ORIGIN_DENY_COMMENT = '        // Native/both child scopes must not inherit PTC-only capabilities from ancestors.';
const PATCHED_DENY_COMMENT = '        // Native child scopes must not inherit PTC-family capabilities from ancestors.';
const ORIGIN_DENY = "            const deny = PTC_TOOLS.map(publicToolName).filter(n => names.includes(n))";
// deny 行本身不用改；改的是它上面的注释（both 现在属于 ready 集合）。

const ORIGIN_FAILURE_MSG = "return failure('POLICY_DENIED', 'The calling scope must be in authoritative PTC-only presentation.')";
const PATCHED_FAILURE_MSG = "return failure('POLICY_DENIED', 'The calling scope must be in an authoritative PTC presentation (ptc or both).')";

// ── 定位已安装的 dsh-ops ───────────────────────────────────────────────────
function candidateProfiles() {
  const dirs = [];
  if (process.env.DSH_PROFILE_DIR) dirs.push(process.env.DSH_PROFILE_DIR);
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  dirs.push(path.join(home, 'profiles', 'desktop'), path.join(home, 'profiles', 'web'));
  return dirs;
}

function locateTarget() {
  for (const dir of candidateProfiles()) {
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    try {
      const req = require('module').createRequire(manifest);
      const pkgJson = req.resolve('dsh-ops/package.json');
      const target = path.join(path.dirname(pkgJson), TARGET_REL);
      if (fs.existsSync(target)) return { target, pkgJson };
    } catch { /* 下一个 profile */ }
  }
  return null;
}

function build(text, mode) {
  const hasMarker = text.includes(MARKER);
  if (mode === 'check') {
    return { status: hasMarker ? 'patched' : 'pristine', changed: false, text };
  }
  if (mode === 'revert') {
    if (!hasMarker) return { status: 'pristine', changed: false, text };
    let next = text;
    // 反向替换：先要求当前形状是"我们打过补丁"的形状。
    const parts = [
      [PATCHED_PTC_ONLY, ORIGIN_PTC_ONLY],
      [PATCHED_DENY_COMMENT, ORIGIN_DENY_COMMENT],
      [PATCHED_FAILURE_MSG, ORIGIN_FAILURE_MSG],
    ];
    for (const [from, to] of parts) {
      if (!next.includes(from)) return { status: 'unknown-shape', detail: from.slice(0, 60), changed: false, text };
      next = next.split(from).join(to);
    }
    return { status: 'reverted', changed: true, text: next };
  }
  // apply
  if (hasMarker) return { status: 'patched', changed: false, text };
  let next = text;
  const parts = [
    [ORIGIN_PTC_ONLY, PATCHED_PTC_ONLY],
    [ORIGIN_DENY_COMMENT, PATCHED_DENY_COMMENT],
    [ORIGIN_FAILURE_MSG, PATCHED_FAILURE_MSG],
  ];
  for (const [from, to] of parts) {
    if (!next.includes(from)) return { status: 'unknown-shape', detail: from.slice(0, 60), changed: false, text };
    next = next.split(from).join(to);
  }
  return { status: 'patched', changed: true, text: next };
}

function main() {
  const argv = process.argv.slice(2);
  const mode = argv.includes('--check') ? 'check' : argv.includes('--revert') ? 'revert' : 'apply';
  const found = locateTarget();
  if (found === null) {
    console.log('dsh-ops 未安装（在 profile 的 node_modules 里解析不到 dsh-ops/package.json）：无需适配，退出 0。');
    return 0;
  }
  let version = null;
  try { version = JSON.parse(fs.readFileSync(found.pkgJson, 'utf8')).version ?? null; } catch { /* 如实留 null */ }
  const text = fs.readFileSync(found.target, 'utf8');
  const result = build(text, mode);
  if (result.status === 'unknown-shape') {
    console.error('拒绝盲改：dsh-ops ' + (version ?? '?') + ' 的 lib/ptc/index.js 与补丁预期的形状不一致（找不到片段：' + result.detail + '...）。');
    console.error('目标文件：' + found.target);
    console.error('要么 ops 已升级到新版本（需要按新版重新核对判据），要么本机文件被改过。请人工核对后再跑。');
    return 1;
  }
  if (mode === 'check') {
    console.log('dsh-ops ' + (version ?? '?') + ' PTC 组件呈现档判定：' + (result.status === 'patched' ? '已放宽（ptc + both）' : '原版（只认纯 ptc）'));
    console.log('目标：' + found.target);
    return result.status === 'patched' ? 0 : 1;
  }
  if (!result.changed) {
    console.log('无需改动：dsh-ops ' + (version ?? '?') + ' 已处于目标状态（' + result.status + '）。');
    console.log('目标：' + found.target);
    return 0;
  }
  if (mode === 'apply') {
    fs.copyFileSync(found.target, found.target + '.bak-' + Date.now() + '-pre-ptc-both');
  }
  fs.writeFileSync(found.target, result.text, 'utf8');
  console.log((mode === 'revert' ? '已还原为原版' : '已放宽 PTC 注册门（ptc + both）') + '：dsh-ops ' + (version ?? '?'));
  console.log('目标：' + found.target);
  console.log('⚠ 需要重启 DSH 才会生效（组件在启动时挂载）。');
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { build, locateTarget, MARKER, ORIGIN_PTC_ONLY, PATCHED_PTC_ONLY };
