/**
 * self-heal.js —— 启动期自愈：把「profile 层托管块丢失」这个故障自动修回来。
 *
 * ── 为什么需要它（用户 2026-10-10 报的真实事故）────────────────────────────────
 * 用户做了一个插件把 DSH 搞崩了，重启时选「关闭所有插件并重启」——
 * 那个流程会**重写/重置 profile 的 cordis.patch.yml**，于是本插件写在里面的
 * `dispatch-agent-team:managed` 托管块（关掉官方 tool-agent-team 行 + agent-team 容量覆盖）
 * **整段消失**。后果：
 *   * 官方 `tool-agent-team` 行重新启用 → 它把同样九个工具名装进每个 agent 作用域
 *     → 与本插件的九个工具**同名冲突**：`tool "spawn_teammate" is already registered in this scope`
 *     （用户截图里的 NamedEntries.duplicateError）；
 *   * agent-team 容量退回官方默认 maxMembers=8（本插件要 48）；
 *   * 界面显示「Team 暂不可用」。
 *
 * 在此之前唯一的修法是用户手动跑 `node tools/repair.cjs --apply` 再重启 ——
 * 但用户**不可能知道要这么做**，而且他刚经历过一次崩溃，更不该再被要求做手工操作。
 *
 * ── 做法 ─────────────────────────────────────────────────────────────────────
 * 插件 apply 时检查托管块是否还在（读 profile 的 cordis.patch.yml）：
 *   * 在 → 什么都不做（正常路径零开销）。
 *   * 不在 → **自动补齐**（与 repair.cjs --apply 写的内容完全一致，先备份），
 *     并在诊断里明确写「下次重启 DSH 后生效」。
 *
 * ⚠️ 边界（必须诚实标注）：
 *   * 写入发生在**插件加载期**，而 profile 的 patch 是**加载时读入**的 ⇒
 *     本次进程仍然是被重置后的状态（官方工具仍占着名字）。所以自愈的效果
 *     要**重启一次**才体现。这是架构决定的，无法在插件内部绕过
 *     （profile patch 由 dsh-app-boot 在 worker 启动时读）。
 *   * 因此自愈的**主要价值**是：用户重启一次就恢复，而不是「必须手动跑脚本再重启」。
 *   * 全程不抛错：任何失败都只记诊断（插件加载绝不能因为自愈失败而挂掉）。
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 托管块的标记（与 tools/repair.cjs 完全一致，两边必须同步）。 */
export const MANAGED_START = '# ── dispatch-agent-team:managed:start（由 tools/repair.cjs 维护，勿手改）──';
export const MANAGED_END = '# ── dispatch-agent-team:managed:end ──';

/**
 * 托管块正文（与 tools/repair.cjs 的 buildManagedBlock 逐字一致）。
 *
 * ⚠️ 改这里必须同步改 tools/repair.cjs —— 否则自愈写进去的内容与 repair 体检的期望不符，
 * 会出现「自愈说修好了、repair --check 仍报缺」的矛盾。selftest 有闸门守这条一致性。
 */
export const MANAGED_BODY = `${MANAGED_START}
# 为什么这两条必须写在这一层：bundle 的 patch 按 dsh.profile.bundles 顺序应用，官方
# agent-team-profile 用 \`insert\` 新建这三行；我们的 bundle 排在它之前时，针对这些行的
# 覆盖会**静默失效**（2026-09-28 实测）。本文件在所有 bundle 层之后应用，顺序无关。
#
# 为什么必须关掉官方工具行：官方 \`tool-agent-team\` 给**每一个** live agent 都装九个团队工具
# （dsh-experimental-tool-agent-team/lib/index.js:539-546 的 maybeInstall；tryMembership 对任意
# 非子代理 agent 都返回 lead 身份 :420-426），而本插件在**同一个 agent 作用域**注册同样的九个
# 名字 → \`tool "x" is already registered in this scope\`，本插件的工具装不上，角色/模型参数丢失。
- id: tool-agent-team
  disabled: true

- id: agent-team
  config:
    maxMembers: 48
    maxTasks: 512
    maxPendingMessagesPerMember: 64
    maxMessageBytes: 65536
    disposalTimeoutMs: 5000
${MANAGED_END}`;

/**
 * 定位 profile 的 cordis.patch.yml。
 *
 * 优先用宿主给的 home（`ctx.get('dshHome')` 之类不一定有），退回到
 * `process.env.DSH_HOME`，最后用 `~/.dsh` 约定（与 tools/lib-dsh-home.cjs 同源逻辑）。
 * @param {object} ctx - 宿主 ctx。
 * @returns {string|null} 文件绝对路径；定位不到返回 null。
 */
export function profilePatchPath(ctx) {
  const candidates = [];
  const fromCtx = pickString(ctx, 'dshHome') ?? pickString(ctx, 'home');
  if (fromCtx !== undefined) candidates.push(fromCtx);
  if (typeof process !== 'undefined' && process.env !== undefined) {
    for (const key of ['DSH_HOME', 'DSH_DIR', 'DSH_DATA_DIR']) {
      const v = process.env[key];
      if (typeof v === 'string' && v !== '') candidates.push(v);
    }
    const userProfile = process.env.USERPROFILE ?? process.env.HOME;
    if (typeof userProfile === 'string' && userProfile !== '') candidates.push(join(userProfile, '.dsh'));
  }
  for (const home of candidates) {
    // 两种布局都试：<home>/profiles/desktop/... 与 <home>/profiles/<唯一子目录>/...
    const base = join(home, 'profiles');
    const direct = join(base, 'desktop', 'cordis.patch.yml');
    if (existsSync(direct)) return direct;
    try {
      for (const name of readdirSync(base)) {
        const p = join(base, name, 'cordis.patch.yml');
        try {
          if (statSync(p).isFile()) return p;
        } catch { /* 跳过 */ }
      }
    } catch { /* 目录不存在：继续下一个候选 */ }
  }
  return null;
}

function pickString(ctx, name) {
  if (ctx === undefined || ctx === null) return undefined;
  try {
    const v = typeof ctx.get === 'function' ? ctx.get(name) : ctx[name];
    return typeof v === 'string' && v !== '' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** 托管块的行 id 白名单：只有本插件写的这两条，其余都算外来行。 */
const MANAGED_ROW_IDS = Object.freeze(['tool-agent-team', 'agent-team']);

/** 托管块区间；没有成对哨兵时返回 null。 */
function managedRegion(text) {
  const start = text.indexOf(MANAGED_START);
  const end = text.indexOf(MANAGED_END);
  if (start < 0 || end <= start) return null;
  return { start, bodyStart: start + MANAGED_START.length, bodyEnd: end };
}

/**
 * 把一段文本按「顶层条目」切开：一条顶层 `- id:` / `- insert:` 行开启一个新块。
 * @param {string} text - 待切分的文本。
 * @returns {{id: string, lines: string[]}[]} 顶层条目。
 */
function splitRows(text) {
  const rows = [];
  let current = null;
  for (const line of text.split('\n')) {
    const m = /^-\s*(?:id:\s*(\S+)|(insert):)/.exec(line);
    if (m !== null) {
      current = { id: m[1] === undefined ? 'insert' : m[1], lines: [line] };
      rows.push(current);
    } else if (current !== null) {
      current.lines.push(line);
    }
  }
  return rows;
}

/**
 * 第一个顶层条目（`- id:` / `- insert:`）的**字符偏移**；没有则 -1。
 *
 * 注意必须是字符偏移而不是行号：判定「块是否在开头」要比较字符位置，
 * 2026-10-10 初版把行号传给了 `String.slice`，导致块明明在第 1 行却判成不健康（自愈反复重写）。
 * @param {string} text - 待检查的文本。
 * @returns {number} 字符偏移，或 -1。
 */
function firstTopLevelRowOffset(text) {
  let offset = 0;
  for (const line of text.split('\n')) {
    if (/^-\s*(?:id:|insert:)/u.test(line)) return offset;
    offset += line.length + 1;
  }
  return -1;
}

/**
 * 块是否**健康**：存在、写在文件开头、且哨兵区内没有外来行。
 *
 * 三者任一不满足都要重写：位置不对是「未来会被污染」，区内有外来行是「已经会被误删」。
 * @param {string} text - profile patch 全文。
 * @returns {boolean} 健康返回 true。
 */
export function managedBlockHealthy(text) {
  const region = managedRegion(text);
  if (region === null) return false;
  const firstRow = firstTopLevelRowOffset(text);
  const atTop = firstRow < 0 || text.indexOf(MANAGED_START) < firstRow;
  if (!atTop) return false;
  return splitRows(text.slice(region.bodyStart, region.bodyEnd))
    .every((row) => MANAGED_ROW_IDS.includes(row.id));
}

/**
 * 归一化：把托管块放到文件开头，正文里的外来行原样保留。
 *
 * 语义与 tools/repair.cjs --apply 的写入路径一致（selftest 有闸门守这条一致性）。
 * @param {string} text - profile patch 全文。
 * @returns {string} 归一化后的全文。
 */
export function normalizeManagedBlock(text) {
  const region = managedRegion(text);
  let body;
  if (region === null) {
    body = text;
  } else {
    const rescued = splitRows(text.slice(region.bodyStart, region.bodyEnd))
      .filter((row) => !MANAGED_ROW_IDS.includes(row.id))
      .map((row) => row.lines.join('\n').replace(/\s+$/u, ''))
      .filter((chunk) => chunk.trim() !== '');
    const outside = (text.slice(0, region.start) + text.slice(region.bodyEnd + MANAGED_END.length))
      .replace(/(?:\n[ \t]*)+$/u, '\n');
    body = rescued.length === 0
      ? outside
      : `${outside.replace(/\s*$/u, '')}\n\n${rescued.join('\n\n')}\n`;
  }
  return `${MANAGED_BODY}\n\n${body.replace(/^\s*\n/u, '')}`;
}

/**
 * 检查并（必要时）补齐托管块。
 *
 * ── 2026-10-10 P0：块必须写在文件**开头**，并且要检测哨兵区被污染 ──────────────
 * profile 的 cordis.patch.yml 是顶层 YAML 序列，宿主 dsh-plugin-manager 在插件页切换
 * 任一组件时走 `writePluginEnabled`，其 `document.add()` 把新条目追加在**最后一个序列项
 * 之后、尾部注释之前**。旧实现把托管块 append 在文件末尾（MANAGED_END 是最后一行），
 * 于是新插件行被插进哨兵区**内部**，随后 --apply/--revert 的整段切片把它们静默删掉
 * （2026-10-10 用真实 profile 复现：permission 第 325-338 行、llm-pi-ai 第 339-351 行
 * 都落在 managed:start(306) 与 managed:end(353) 之间；--revert 后
 * dsh-permission-presets / llm-pi-ai / JIYUAN_API_KEY 全部消失，16623 → 15096 字节）。
 *
 * 现在两条修法：
 *   * **结构**：块写到文件开头 —— AST 追加永远发生在块之后，不可能再进哨兵区；
 *   * **幂等**：块已在开头且哨兵区内无外来行时什么都不做（正常路径零开销）；
 *     块存在但位置不对 / 区内有外来行时，走与 repair.cjs --apply 一致的归一化重写。
 *
 * @param {object} ctx - 宿主 ctx（用于定位 DSH 主目录）。
 * @returns {{status:'ok'|'healed'|'failed'|'skipped', path?:string, message?:string}}
 *   * `ok`      —— 块已在开头且哨兵区干净，无需动作（正常路径）。
 *   * `healed`  —— 曾缺失或结构不健康，已归一化重写（**下次重启 DSH 生效**）。
 *   * `failed`  —— 定位不到文件或写入失败（message 里带原因与手工修法）。
 *   * `skipped` —— 运行环境不支持（如浏览器半）。
 */
export function healManagedBlock(ctx) {
  let patchPath = null;
  try {
    patchPath = profilePatchPath(ctx);
  } catch (error) {
    return { status: 'failed', message: `定位 profile patch 失败：${messageOf(error)}` };
  }
  if (patchPath === null) {
    return {
      status: 'skipped',
      message: '定位不到 profile 的 cordis.patch.yml（不影响本次加载；若团队工具装不上，'
        + '手工跑 node tools\\repair.cjs --apply）',
    };
  }
  let text = '';
  try {
    text = readFileSync(patchPath, 'utf8');
  } catch (error) {
    return { status: 'failed', path: patchPath, message: `读 ${patchPath} 失败：${messageOf(error)}` };
  }

  if (managedBlockHealthy(text)) return { status: 'ok', path: patchPath };

  // 缺失 / 位置不对 / 区内有外来行 → 归一化重写：块放开头，外来行原样留在正文。
  try {
    copyFileSync(patchPath, `${patchPath}.bak-${Date.now()}-pre-selfheal`);
  } catch { /* 备份失败不阻塞修复，但要继续尝试写入 */ }
  let next;
  try {
    next = normalizeManagedBlock(text);
  } catch (error) {
    return {
      status: 'failed', path: patchPath,
      message: `归一化托管块失败：${messageOf(error)}。手工修法：node tools\\repair.cjs --apply`,
    };
  }
  try {
    writeFileSync(patchPath, next, 'utf8');
  } catch (error) {
    return {
      status: 'failed', path: patchPath,
      message: `写 ${patchPath} 失败：${messageOf(error)}。手工修法：node tools\\repair.cjs --apply`,
    };
  }
  return {
    status: 'healed', path: patchPath,
    message: '检测到 profile 层的 dispatch-agent-team 托管块**缺失或结构不健康**（通常是「关闭所有插件并重启」'
      + '重置了 profile patch，或宿主切换插件组件时把外来行追加进了哨兵区）——已归一化重写为'
      + '「块放文件开头 + 关闭官方 tool-agent-team 行 + agent-team 容量 48」，外来插件行原样保留。'
      + '⚠️ 需要**再重启一次 DSH** 才会生效（profile patch 在启动时读入）。',
  };
}

function messageOf(error) {
  if (error === null || error === undefined) return '未知错误';
  return String(error.message ?? error);
}
