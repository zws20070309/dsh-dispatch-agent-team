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
 *   的层，装机 0.3.0 实读 lib/ptc/index.js:52）
 *
 * -- PTC 增强组件（ops_batch / ops_result）怎么拿到，且**不改 ops 一行源码** ------
 * 原版门只把这两个工具注册给**纯 PTC 呈现档**的作用域（lib/ptc/index.js:16-22：装配工具恰好
 * 只有 run_code，且 tools:ptc-only 段非空）。本包队员默认是**批量调用档 both**
 * （原生直调 + run_code 并存，lib/runtime.js applyMemberBatch），所以默认档下这两个工具不在。
 * 这是 ops 自己的设计，本包不动它（用户 2026-10-15 明令"别改 ops 的源码"）。
 *
 * 合法杠杆完全在本包手里，而且已经存在：角色**预设选 ptc** 且**关掉该角色的批量档**
 * （batch: false）-> 那名队员就是纯 PTC 档 -> 原版 ops 自己把 ops_batch / ops_result 给他。
 * 实测（原版组件 + 真宿主注册表，四个独立 Context）：
 *   呈现档 ptc  -> 拿到 ops_batch/ops_result；呈现档 both -> 拿不到。
 * 这条杠杆的前提是**第一次装配就得是纯 PTC**：那一支由 runtime.js 的 declareMemberMode 在队员
 * 自己那层**同步** presentAs('ptc') 钉住。不能等异步的预设重绑 —— 2026-10-16 真机实测过那个后果：
 * researcher-ops 逐请求是 native(76)->ptc(1)->native(76)->ptc(1)，第一次请求跑在继承来的组合上，
 * 于是它把「没有 run_code、没有 ops_batch」当事实报给 Lead，白跑一轮再自我更正。
 * 所以 detectOpsComponents 只在"PTC 组件挂着**且该作用域是纯 PTC 档**却看不到这两个工具"时报警，修法是
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
export const OPS_LINK_TEXT = [
'# ops 工具（检测到 dsh-ops 插件，已接入本团队）',
'',
'你的工具清单里若有 ops_*（Rust 实现，来自 dsh-ops 插件），它们与宿主工具同级、能力一致；但**能不能直接调用取决于你这一档**，先自查：',
'- 清单里除 run_code 外还看得到 ops_* → 可以直接调用。',
'- 清单里**只有 run_code**（纯 PTC 档）→ 直调任何 ops_* 都会被拒（unknown tool … only run_code is callable directly）。这不是坏了：在 run_code 程序里 await tools.ops_x(...) 调用，能力完全相同。**别因为直调被拒就判定通路不通。**',
'- 找文件 / 搜内容 / 读文件 / 批量替换优先用 ops_glob、ops_grep、ops_inspect_local_file、ops_replace：更快、输出更省 token。',
'- 参数严格：只传声明过的字段（多余的字段会被 Rust 侧直接拒掉）；path 相对当前会话 cwd，用 / 分隔；报错就改参数重试，不要退回 shell 绕路。',
'- ops_batch / ops_result（若可见）：跨文件 copy/move/remove 先 plan 再用同一个 id resume；大结果用 ops_result 分页引用，别把几千行塞进汇报。',
'- ops_run_background / ops_job_*（若可见）：只操作本会话自己启动的 job id。取 id **只认 "job <id> started" 那一段**：本会话**此前有过别的任务**（在跑的或已结束的都算）时，返回开头会多一行 `(Background: …)` 列出那些 job —— 那种情况下抓第一个 `j-` 会拿到别人的 id；本会话这是第一个任务时**没有这一行**。两种形状都以 `job <id> started` 里的 id 为准。',
'- ops_job_list **默认只列运行中的**（status 缺省 running）：任务跑完就从列表消失，那不是「注册表不一致」。要看过往任务传 status: "all"（合法值 running/finished/all）。',
'- 命令行执行：本团队给队员配的是持久 PowerShell（pwsh）；若你同时有 ops_bash，一次性 POSIX 命令用它，两者不要混着写语法。',
'上面写「若可见」的，以你自己的工具清单为准：清单里没有的 ops_* 一律不要臆造、不要试调。',
].join('\n');

/**
 * profile 目录候选（DSH_PROFILE_DIR -> <DSH 主目录>/profiles/{desktop,web}）。
 *
 * P1（2026-10-16 真机抓出来的）：这里的退回链必须补 .dsh 这一段。上一版写的是
 *   const home = process.env.DSH_HOME ?? homedir();   // 错：DSH_HOME 没设时 home = C:\Users\ZWS
 *   join(home, "profiles", "desktop")                 // 于是去看 C:\Users\ZWS\profiles\desktop
 * 那个目录不存在。宿主 Electron 进程就是「没设 DSH_HOME」的情形（本机实测：状态文件
 * package:null 而四个 dsh-ops 组件行 phase:2 全挂着）判成「没装 dsh-ops」
 * linkOpsForMember 提前返回 false，一个队员都拿不到 ops 指引段。
 * 这正是本仓库 tools/lib-dsh-home.cjs:34-53 立的规矩（2026-10-04 审查 P1-7）：DSH_HOME = 主目录本身，
 * 没给就是 homedir()/.dsh。测试当时用 DSH_PROFILE_DIR 注入假目录，从不走这条退回链，
 * 所以闸门全绿、真机是坏的 —— 所以这里导出成**可注入 env/home 的纯函数**，那条路径才有得测。
 * @param [env] - 环境对象（默认 process.env），测试可注入。
 * @param [home] - 主目录（默认 homedir()），测试可注入。
 * @returns {string[]} 候选 profile 目录（按优先级）。
 */
export function profileDirs(env, home) {
  const environment = env === undefined ? (typeof process !== "undefined" && process.env ? process.env : {}) : env;
  const dirs = [];
  const explicit = typeof environment.DSH_PROFILE_DIR === "string" ? environment.DSH_PROFILE_DIR.trim() : "";
  if (explicit !== "") dirs.push(explicit);
  const fromEnv = typeof environment.DSH_HOME === "string" ? environment.DSH_HOME.trim() : "";
  const base = fromEnv !== "" ? fromEnv : join(home === undefined ? homedir() : home, ".dsh");
  dirs.push(join(base, "profiles", "desktop"), join(base, "profiles", "web"));
  return dirs;
}

/** dsh-ops 是否可从 profile 解析（installed 判据 + 版本号）。只读，拿不到返回 null。env/home 透传给 profileDirs（测试注入用）。 */
export function resolveOpsPackage(env, home) {
  for (const dir of profileDirs(env, home)) {
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
 * @param [purePtc] - 这个作用域是不是**纯 PTC 档**（预设 ptc + 关批量调用）。见下面 missingPtc 的注释。
 */
export function detectOpsComponents(ctx, scope, purePtc) {
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
  // PTC 那两个工具注册在**每个 agent 自己的层**（`dsh-ops/lib/ptc/index.js:52`，装机 0.3.0 实读），原版门只服务
  // 纯 PTC 档（`lib/ptc/index.js:16-22`：assembly.tools 恰好只有一个 run_code）。于是：
  //   · Lead 是原生档（无 run_code）——看不到 ops_batch/ops_result 是**设计使然**，不是缺陷；
  //   · 批量档队员（both）同样看不到 —— 也是设计使然（本插件 runtime.js applyMemberBatch 的互斥裁决）；
  //   · 只有 purePtc === true 的作用域看不到，才是真问题（ops 没装上/没启用/门改了）。
  // 所以这一项由调用方按**该作用域自己的呈现档**传进来，绝不凭可见性猜——猜就会给 Lead 误报「需要处理」。
  const missingPtc = purePtc === true && mounted.includes('ptc') && visibleTools !== null
    && OPS_PTC_TOOLS.some((toolName) => !visibleTools.includes(toolName));
  let summary;
  if (pkg === null) summary = undefined; // 没装 ops：静默（本包不依赖它）
  else if (mounted.length === 0) summary = 'dsh-ops 已安装但四个组件都没挂载（插件页打开需要的组件；改完要重启 DSH）';
  else {
    summary = 'dsh-ops ' + (pkg.version ?? '?') + '：在挂载 ' + mounted.join('/')
      + (visibleTools !== null ? '；' + (scope === undefined ? '根作用域' : '该作用域') + '可见 ' + visibleTools.length + ' 个 ops_* 工具' : '');
    // 根作用域**天然只看得到全局层**（file 四件套）：shell/background/ptc 三个组件的工具注册在
    // 每个 agent 自己的层里（dsh-ops lib/session-shells.js:72、lib/tools.js:358-366、lib/ptc/index.js:52），
    // 根作用域永远数不到它们 —— 这是 ops 的分层设计，不是缺陷。早先这里写「当前作用域可见 N 个」
    // 会让人以为 ops_bash 没生效（真机 2026-10-16 14:09 就是这样：状态文件报 4 个，而 Lead 与队员
    // 手上都有 ops_bash）。所以根作用域这一路必须点名，免得又被当成判据。
    if (scope === undefined && visibleTools !== null && visibleTools.length < OPS_TOOL_NAMES.length) {
      summary += '（根作用域只覆盖全局层；ops_bash / 四个 job 工具 / ops_batch+ops_result 注册在各 agent'
        + '自己的层，要按具体队员实测，别拿这个数当「ops 没生效」的证据）';
    }
    if (missingPtc) {
      // 只报事实 + 给**本插件**的修法：ops 的 PTC 组件按设计只服务纯 PTC 档，
      // 要拿到 ops_batch/ops_result 就把这个角色预设设成 ptc 并关掉它的批量调用档。
      summary += '；PTC 组件挂着，但这个纯 PTC 档作用域看不到 ops_batch/ops_result'
        + '（ops 的 PTC 门没放行：确认 dsh-ops 的 ptc 组件在插件页是启用的，或它的版本变了）。';
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
export function linkOpsForMember(ctx, scoped, agent, notes, disposers, purePtc) {
  try {
    const probe = detectOpsComponents(ctx, agent, purePtc);
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
    if (probe.missingPtcTools) notes.push('ops 链接：该队员是纯 PTC 档但拿不到 ops_batch/ops_result（ops 的 PTC 门没放行）');
    else if (purePtc !== true && probe.mounted.includes('ptc')) { notes.push('ops 链接：该队员不是纯 PTC 档，按 ops 的设计不含 ops_batch/ops_result（要它们：预设 ptc + 关闭批量调用）'); }
    return true;
  } catch (error) {
    notes.push('ops 链接失败（不影响队员其余能力）：' + (error?.message ?? String(error)));
    return false;
  }
}