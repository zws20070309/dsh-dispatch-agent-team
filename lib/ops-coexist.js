/**
 * ops-coexist.js —— dsh-ops 共存自愈：防止 ops_* 工具被注册两次。
 *
 * ── 为什么需要它（2026-10-11 组件合并的配套，用户要求「别人装了 ops 也能兼容不报错」）──
 * 本包 cordis.patch.yml 的第 4 组件 `ops-file` 行指向本包 vendor 的 dsh-ops file 组件实现。
 * 如果用户**同时**安装了独立 dsh-ops 插件且它的 bundle 处于启用状态，它自己的
 * `dsh-ops-file` 行也会挂载同一个实现 —— 两行各自向宿主工具注册表注册同一套
 * `ops_grep / ops_glob / ops_inspect_local_file / ops_replace / read_image`，
 * 第二次注册报 `tool "x" is already registered in this scope`，file 组件挂掉。
 *
 * bundle 层无法可靠解决：patch 按 dsh.profile.bundles 顺序应用，dsh-ops 可能排在本包
 * 之前也可能之后（取决于用户启用顺序），针对彼此的 disable 在错误的顺序下静默失效
 * （2026-09-28 托管块事故的同一类根因）。profile 层在所有 bundle 层之后应用，
 * 是唯一顺序无关的落点。
 *
 * ── 做法（与 self-heal.js 同机制）──────────────────────────────────────────────
 * 插件 apply 时读 profile 的 cordis.patch.yml：
 *   * 已有 `- id: dsh-ops-file / disabled: true` → 什么都不做（正常路径零开销）；
 *   * 没有 → 追加两行（disable + 注释说明），先备份。追加位置：文件**末尾** ——
 *     这里刻意不用「文件开头」：本条目不是哨兵区结构，写末尾不会被宿主 AST 追加
 *     吞掉（吞掉事故只发生在「哨兵区在末尾」的场景，见 self-heal.js 的 2026-10-10 P0）；
 *     幂等性由「先查后写」保证。
 *
 * ⚠️ 边界（诚实标注，与 self-heal 相同）：
 *   * profile patch 在 worker 启动时读入，本次进程仍是旧状态 → 自愈效果**重启一次生效**。
 *   * 全程不抛错：任何失败只记诊断，绝不让插件加载挂掉。
 *   * 只动 `dsh-ops-file` 这一行，不碰 dsh-ops 的 shell/background 行（用户的独立
 *     dsh-ops 功能不受影响），也不碰其它任何行。
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 要钉掉的行（只此一行：dsh-ops 自己的 file 组件行）。 */
const COEXIST_ROW = '- id: dsh-ops-file\n  disabled: true';

/** 行说明注释（写进 profile patch，让未来读这个文件的人知道为什么）。 */
const COEXIST_COMMENT = [
  '# ── dsh-ops 共存防护（由 @zws/dsh-dispatch-agent-team 的 ops-coexist 自愈维护）──',
  '# 本 profile 装了 @zws/dsh-dispatch-agent-team，其第 4 组件 ops-file 内置了',
  '# dsh-ops file 组件实现（vendor）。下面这行关掉独立 dsh-ops 插件自带的',
  '# dsh-ops-file 行，避免同一套 ops_* 工具注册两次（"already registered"）。',
  '# 只关这一行；dsh-ops 的 shell / background 组件不受影响。',
].join('\n');

/**
 * profile patch 是否已经「安全」：dsh-ops-file 行存在且 disabled，或根本没有该行
 * （用户没装独立 dsh-ops，或它的 bundle 未启用 —— 两种情况都无重复注册风险）。
 * @param {string} text - profile patch 全文。
 * @returns {boolean}
 */
export function opsCoexistHealthy(text) {
  const rows = splitTopLevelRows(text);
  const row = rows.find((r) => r.id === 'dsh-ops-file');
  if (row === undefined) return true;
  return row.lines.some((line) => /^\s*disabled:\s*true\s*$/u.test(line));
}

/**
 * 检查并在必要时补齐共存防护行。
 * @param {object} ctx - 宿主 ctx（用于定位 profile patch，与 self-heal 同源）。
 * @returns {{status:'ok'|'healed'|'failed'|'skipped', path?:string, message?:string}}
 */
export function healOpsCoexist(ctx) {
  let patchPath = null;
  try {
    // 复用 self-heal 的定位逻辑（同源候选链：ctx → env → ~/.dsh）。
    patchPath = profilePatchPath(ctx);
  } catch (error) {
    return { status: 'failed', message: `定位 profile patch 失败：${messageOf(error)}` };
  }
  if (patchPath === null) {
    return { status: 'skipped', message: '定位不到 profile 的 cordis.patch.yml（不影响本次加载）' };
  }
  let text = '';
  try {
    text = readFileSync(patchPath, 'utf8');
  } catch (error) {
    return { status: 'failed', path: patchPath, message: `读 ${patchPath} 失败：${messageOf(error)}` };
  }

  if (opsCoexistHealthy(text)) return { status: 'ok', path: patchPath };

  // 不健康：dsh-ops-file 行存在且未 disabled → 追加防护行（先备份）。
  try {
    copyFileSync(patchPath, `${patchPath}.bak-${Date.now()}-pre-ops-coexist`);
  } catch { /* 备份失败不阻塞修复 */ }
  const next = `${text.replace(/\s*$/u, '')}\n\n${COEXIST_COMMENT}\n${COEXIST_ROW}\n`;
  try {
    writeFileSync(patchPath, next, 'utf8');
  } catch (error) {
    return {
      status: 'failed', path: patchPath,
      message: `写 ${patchPath} 失败：${messageOf(error)}。手工修法：在 profile patch 末尾加
${COEXIST_ROW}`,
    };
  }
  return {
    status: 'healed', path: patchPath,
    message: '检测到独立 dsh-ops 插件的 dsh-ops-file 行未停用（与本包内置的 ops-file 组件重复注册 '
      + 'ops_* 工具）——已在 profile 层追加 disabled 行，独立 dsh-ops 的 shell/background 组件不受影响。'
      + '⚠️ 需要**再重启一次 DSH** 才会生效（profile patch 在启动时读入）。',
  };
}

// ── 内部：profile patch 定位与行切分（与 self-heal.js 同源逻辑，独立成函数避免耦合）──

/**
 * 定位 profile 的 cordis.patch.yml（候选链与 self-heal.profilePatchPath 相同）。
 * @param {object} ctx - 宿主 ctx。
 * @returns {string|null}
 */
function profilePatchPath(ctx) {
  const candidates = [];
  const fromCtx = pickString(ctx, 'dshHome') ?? pickString(ctx, 'home');
  if (fromCtx !== undefined) candidates.push(fromCtx);
  if (typeof process !== 'undefined' && process.env !== undefined) {
    for (const key of ['DSH_HOME', 'DSH_DIR', 'DSH_DATA_DIR']) {
      const v = process.env[key];
      if (typeof v === 'string' && v !== '') candidates.push(v);
    }
    const userProfile = process.env.USERPROFILE ?? process.env.HOME;
    if (typeof userProfile === 'string' && userProfile !== '') candidates.push(userProfile, join(userProfile, '.dsh'));
  }
  for (const home of candidates) {
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
    } catch { /* 目录不存在：继续 */ }
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

/**
 * 把文本按「顶层条目」切开：一条顶层 `- id:` 行开启一个新块（缩进行归属当前块）。
 * @param {string} text
 * @returns {{id: string, lines: string[]}[]}
 */
function splitTopLevelRows(text) {
  const rows = [];
  let current = null;
  for (const line of text.split('\n')) {
    const m = /^-\s*id:\s*(\S+)\s*$/u.exec(line);
    if (m !== null) {
      current = { id: m[1], lines: [line] };
      rows.push(current);
    } else if (current !== null) {
      current.lines.push(line);
    }
  }
  return rows;
}

function messageOf(error) {
  if (error === null || error === undefined) return '未知错误';
  return String(error.message ?? error);
}
