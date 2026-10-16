/**
 * ops-adapter.js -- 智能体团队 <-> dsh-ops 插件的原生链接适配层（2026-10-15 改版）。
 *
 * -- 历史（为什么曾经内嵌，为什么现在删掉）------------------------------------
 * 2026-10-11 曾把 dsh-ops 的 file 组件 vendor 进本包（vendor/ops/ + 第 4 组件 ops-file 行
 * + lib/ops-coexist.js 防重复注册自愈）。2026-10-15 用户定案：**不再内嵌、也不改 ops 源码**
 * —— 两个插件各自安装、各自启用，本包只负责"检测到 ops 就把它的工具用起来"。
 * vendor、ops-file 行、ops-coexist 已全部删除；ops_* 工具的唯一来源是独立 dsh-ops 插件。
 *
 * -- 本模块承担的两件事 -------------------------------------------------------
 * (1) detectOpsComponents(ctx, scope)：采集 dsh-ops 四个组件行（shell/file/background/ptc）
 *     的挂载事实 + 该作用域实际可见的 ops_* 清单 -> 写进状态文件（页面/排查看得到）。
 *     全程只读、永不抛错：没装 dsh-ops 的用户这里就是 package:null、mounted:[]。
 * (2) linkOpsForMember(ctx, scoped, agent, notes, disposers)：在**队员**作用域上注册一段
 *     ops 使用指引（所有队员逐字节相同 -> 不吃缓存前缀），并把安装时点可见的 ops_* 记进 notes。
 *     ops 不在场时一个字节都不加。
 *
 * -- 工具面事实（逐名读自装机 dsh-ops 0.3.0 的注册点，2026-10-15 实测）----------
 * * file 组件   -> ops_inspect_local_file / ops_grep / ops_glob / ops_replace
 *   （dsh-ops lib/file/runtime.js:21-23 与 lib/tools.js:621 都注册在**全局层**，人人可见）
 * * shell 组件  -> ops_bash（每授权 agent 一层，lib/session-shells.js:72）+ 把宿主
 *   pwsh-sandbox 指向随包 PowerShell 7（lib/session-pwsh.js，不新增工具名）
 * * background  -> ops_run_background / ops_job_output / ops_job_list / ops_job_kill
 *   （每授权 agent 一层，lib/tools.js:358-366；门 = bash 可解析 + 会话 danger-full-access，
 *   lib/tools.js:311-316）
 * * ptc 组件    -> ops_batch / ops_result（lib/ptc/contract.js PTC_TOOLS，注册在 agent 自己
 *   的层，lib/ptc/index.js:64）
 *
 * -- PTC 增强组件（ops_batch / ops_result）怎么拿到，且**不改 ops 一行源码** ------
 * 原版门只把这两个工具注册给**纯 PTC 呈现档**的作用域（lib/ptc/index.js:16-22：装配工具恰好
 * 只有 run_code，且 tools:ptc-only 段非空）。本包队员默认是**批量调用档 both**
 * （原生直调 + run_code 并存，lib/runtime.js applyMemberBatch），所以默认档下这两个工具不在。
 * 这是 ops 自己的设计，本包不动它（用户 2026-10-15 明令"别改 ops 的源码"）。
 *
 * 合法杠杆完全在本包手里，而且已经存在：角色**预设选 ptc** 且**关掉该角色的批量档**
 * （batch: false）-> 那名队员就是纯 PTC 档 -> 原版 ops 自己把 ops_batch / ops_result 给他。
 * 实测（原版组件 + 真宿主注册表，两个独立 Context 各测一轮）：
 *   呈现档 ptc  -> 拿到 ops_batch/ops_result；呈现档 both -> 拿不到。
 * 所以 detectOpsComponents 在"PTC 组件挂着但该作用域看不到这两个工具"时，给出的修法是
 * **改本插件的角色配置**（预设 + 批量开关），不是去改别人的插件。
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** dsh-ops bundle 自己 insert 的四行（读自 dsh-ops/cordis.patch.yml:3-31，0.3.0）。 */
export const OPS_ROWS = Object.freeze([
  Object.freeze({ id: 'dsh-ops-shell', component: 'shell' }),
  Object.freeze({ id: 'dsh-ops-file', component: 'file' }),
  Object.freeze({ id: 'dsh-ops-background', component: 'background' }),
  Object.freeze({ id: 'dsh-ops-ptc', component: 'ptc' }),
]);

/**
 * 全部 ops_* 公开名（按这张表判断"哪些 ops 工具真的活着"；与 ops 0.3.0 的注册点逐名对齐）。
 * 注意 ops_run 在 0.3.0 任何组合下都不发布（docs/manual-validation.md:17），所以不在表里。
 */
export const OPS_TOOL_NAMES = Object.freeze([
  'ops_inspect_local_file', 'ops_grep', 'ops_glob', 'ops_replace',
  'ops_bash',
  'ops_run_background', 'ops_job_output', 'ops_job_list', 'ops_job_kill',
  'ops_batch', 'ops_result',
]);

/** PTC 增强组件的那两个工具（判"这个作用域拿没拿到"用）。 */
export const OPS_PTC_TOOLS = Object.freeze(['ops_batch', 'ops_result']);

/** 每个组件的代表工具（探针名）。per-agent 组件只在传了 scope 时才取得到。 */
export const OPS_PROBE_TOOLS = Object.freeze({
  shell: 'ops_bash',
  file: 'ops_grep',
  background: 'ops_run_background',
  ptc: 'ops_batch',
});

/** 队员侧 ops 指引段名与排序值（紧跟队员卡 600，同区）。 */
export const OPS_LINK_SECTION = 'dispatch:ops-link';
const OPS_LINK_ORDER = 601;

/**
 * 指引正文。**必须与具体队员无关**（逐字节相同）—— 队员共享系统提示词前缀是缓存命中的
 * 前提（lib/playbook.js 的设计纪律），所以这里绝不枚举"你当前可见的 ops 工具"（那会因
 * 角色而异），只讲口径；每个队员实际有什么，ops 自己的 dsh-ops:repository-tooling:* 段
 * 会按作用域如实渲染（那是 ops 的公开段，我们不改写它）。
 */
const OPS_LINK_TEXT = [
  '# ops 工具（检测到 dsh-ops 插件，已接入本团队）',
  '',
  '你的工具清单里若有 ops_*（Rust 实现，来自 dsh-ops 插件），它们与宿主工具同级，放心直调：',
  '- 找文件 / 搜内容 / 读文件 / 批量替换优先用 ops_glob、ops_grep、ops_inspect_local_file、ops_replace：更快、输出更省 token。',
  '- 参数严格：只传声明过的字段（多余的字段会被 Rust 侧直接拒掉）；path 相对当前会话 cwd，用 / 分隔；报错就改参数重试，不要退回 shell 绕路。',
  '- 有 run_code 时（批量调用档）：这些工具在程序里同样可以 await tools.ops_grep(...) 调用，批量与并行在一个程序里做完。',
  '- ops_batch / ops_result（若可见）：跨文件 copy/move/remove 先 plan 再用同一个 id resume；大结果用 ops_result 分页引用，别把几千行塞进汇报。',
  '- ops_run_background / ops_job_*（若可见）：只操作本会话自己启动的 job id。',
  '- 命令行执行：本团队给队员配的是持久 PowerShell（pwsh）；若你的清单里同时有 ops_bash，一次性 POSIX 命令用它，两者不要混着写语法。',
  '上面括号里写"若可见"的，以你的工具清单为准：清单里没有的 ops_* 一律不要臆造、不要试调。',
].join('\n');

/** profile 目录候选（env -> ~/.dsh/profiles/{desktop,web}）。 */
function profileDirs() {
  const dirs = [];
  if (typeof process !== 'undefined' && process.env) {
    const explicit = process.env.DSH_PROFILE_DIR;
    if (typeof explicit === 'string' && explicit !== '') dirs.push(explicit);
    const home = process.env.DSH_HOME ?? homedir();
    if (typeof home === 'string' && home !== '') dirs.push(join(home, 'profiles', 'desktop'), join(home, 'profiles', 'web'));
  }
  return dirs;
}

/** dsh-ops 是否可从 profile 解析（installed 判据 + 版本号）。只读，拿不到返回 null。 */
export function resolveOpsPackage() {
  for (const dir of profileDirs()) {
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const req = createRequire(manifest);
      const pkgPath = req.resolve('dsh-ops/package.json');
      const version = JSON.parse(readFileSync(pkgPath, 'utf8'))?.version ?? null;
      return { installed: true, version, path: pkgPath };
    } catch { /* 下一个候选 profile */ }
  }
  return null;
}

/**
 * (1) 组件体检：dsh-ops 四行的挂载事实 + 该作用域实际可见的 ops_* 清单。
 * 永不抛错（调用方还有一层兜底）；每一项都是实测事实，拿不到就写 null。
 * @param ctx - 宿主 ctx。
 * @param [scope] - 可选 agent 作用域：传了才取得到 per-agent 组件注册的工具。
 */
export function detectOpsComponents(ctx, scope) {
  const pkg = resolveOpsPackage();
  const rows = [];
  try {
    const loader = ctx.get('loader');
    if (loader !== undefined && typeof loader.entries === 'function') {
      for (const entry of loader.entries()) {
        const id = entry?.options?.id;
        const hit = OPS_ROWS.find((row) => row.id === id);
        if (hit === undefined) continue;
        rows.push({
          id,
          component: hit.component,
          name: entry?.options?.name,
          disabled: entry?.disabled === true,
          phase: entry?.fiber?.state ?? null,
        });
      }
    }
  } catch { /* loader 缺席：如实留空 rows */ }
  let visibleTools = null;
  try {
    const tools = ctx.get('tools');
    if (tools !== undefined && typeof tools.get === 'function') {
      visibleTools = OPS_TOOL_NAMES.filter((toolName) => tools.get(toolName, scope) !== undefined);
    }
  } catch { /* tools 服务缺席 */ }
  const mounted = rows.filter((row) => row.disabled === false && row.phase !== null).map((row) => row.component);
  const missingPtc = mounted.includes('ptc') && visibleTools !== null
    && OPS_PTC_TOOLS.some((toolName) => !visibleTools.includes(toolName));
  let summary;
  if (pkg === null) summary = undefined; // 没装 ops：静默（本包不依赖它）
  else if (mounted.length === 0) summary = 'dsh-ops 已安装但四个组件都没挂载（插件页打开需要的组件；改完要重启 DSH）';
  else {
    summary = 'dsh-ops ' + (pkg.version ?? '?') + '：在挂载 ' + mounted.join('/')
      + (visibleTools !== null ? '；当前作用域可见 ' + visibleTools.length + ' 个 ops_* 工具' : '');
    if (missingPtc) {
      // 只报事实 + 给**本插件**的修法：ops 的 PTC 组件按设计只服务纯 PTC 档，
      // 要拿到 ops_batch/ops_result 就把这个角色预设设成 ptc 并关掉它的批量调用档。
      summary += '；PTC 组件挂着但该作用域没有 ops_batch/ops_result（它只服务纯 PTC 档）。'
        + '要这两个工具：在插件页把该角色预设设为 ptc 并关掉「批量调用」，再重启该队员。';
    }
  }
  return { package: pkg, rows, mounted, visibleTools, missingPtcTools: missingPtc, summary };
}

/**
 * (2) 队员链接：注册逐字节相同的 ops 指引段 + 把安装时点可见的 ops_* 记进 notes。
 * ops 不在场直接返回 false（不加任何字节）。任何失败只进 notes，绝不影响队员安装
 * （调用方语义与 applyMemberBatch 一致）。
 * @returns boolean 是否注册了指引段。
 */
export function linkOpsForMember(ctx, scoped, agent, notes, disposers) {
  try {
    const probe = detectOpsComponents(ctx, agent);
    if (probe.package === null || probe.mounted.length === 0) return false;
    if (scoped?.systemPrompt !== undefined && typeof scoped.systemPrompt.section === 'function') {
      const disposer = scoped.systemPrompt.section({ name: OPS_LINK_SECTION, order: OPS_LINK_ORDER, text: OPS_LINK_TEXT });
      if (typeof disposer === 'function') disposers.push(disposer);
      else notes.push('ops 链接：section 未返回 disposer，卸载时无法回卷');
    } else {
      notes.push('ops 链接：该作用域没有 systemPrompt 服务，ops 指引段未注册');
    }
    // 安装时点的工具面快照。per-agent 组件（bash / background / ptc）的注册是异步 reconcile，
    // 此刻可能还没落进队员自己的层 -> 这里只如实记"当时看到什么"，不是终态。
    const visible = probe.visibleTools ?? [];
    notes.push('ops 链接：dsh-ops ' + (probe.package.version ?? '?') + ' 在场（' + probe.mounted.join('/')
      + '），安装时点可见 ops_* = ' + (visible.length > 0 ? visible.join(', ') : '暂无（per-agent 组件异步挂载中，或该角色的预设/批量档不暴露它们）'));
    if (probe.missingPtcTools) notes.push('ops 链接：该队员拿不到 ops_batch/ops_result —— 需要纯 PTC 档（预设 ptc + 关闭批量调用）');
    return true;
  } catch (error) {
    notes.push('ops 链接失败（不影响队员其余能力）：' + (error?.message ?? String(error)));
    return false;
  }
}
