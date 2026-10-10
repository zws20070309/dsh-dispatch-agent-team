// 调度模式智能体团队 —— 宿主入口（host plane）
//
// 这个文件只做四件事，所有状态与逻辑都在 lib/runtime.js：
//   1. 注册 `POST /zws-dispatch-agent-team/api`（配置页的唯一数据通道）；
//   2. 启动时预热配置（peekConfig 是 agent/request 热路径，必须已有值）、
//      给已存在的队员补装覆盖、订阅 agent/created；
//   3. 插件卸载时整体回卷 agent 作用域上的注册；
//   4. 提供 `name` / `inject` / `apply` 三个导出（官方 0.1.7 包用命名导出，
//      dsh-experimental-tool-agent-team/lib/index.js:557 `export { Config, apply, inject, name }`）。
//
// HTTP 路由的写法照本 profile 里**跑通的**先例（某个第三方插件）：
//   <DSH 主目录>/profiles/desktop/node_modules/<某个第三方插件>/lib/index.js
//   * inject 里声明 webServer（:17），ctx.webServer.register 放在 ctx.effect 里（:1349-1352、:1422）
//   * POST-only + `x-dsh-plugin` 自定义头作为 CSRF 主闸（:1366-1375）+ Origin 同源兜底（:1376-1391）
//   * 1 MiB 请求体上限（:1332-1347）
//   * 所有业务失败都走 HTTP 200 + {ok:false,error}（:1392-1420）
// 服务名与签名证据：`webServer.register(route): () => void`（重复 (kind,path) 抛错）——
// dsh-host-webserver/lib/types/index.d.ts:34-38(WebRoute)/:85-90(register)（本机为 0.1.5 的类型声明，
// 但真实运行行为已由 INTERFACES §7.5 实测 + mcp-manager 真机跑通双重确认；桌面端现为 0.2.0-rc.1）。
//
// 注意：**不 inject agentTeams**。官方 agent-team-profile 是可选 bundle，硬依赖会让整个插件
// （含配置页）一起挂掉；runtime.js 一律用 ctx.get('agentTeams') 惰性取用并降级。

import { ROLES, CONFIG_VERSION, defaultConfig, ROLE_IDS } from './roster.js';
import { KEEPALIVE_MODES, MAX_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS, ROUTE_FAMILIES, DEFAULT_FAMILY } from './cache.js';
import * as runtime from './runtime.js';
import { healManagedBlock } from './self-heal.js';
// 注意：故意**不** import lib/preset.js：控制面（/team 与开关工具）由 preset 子树自己注册，
// 宿主平面一旦也注册一次就会落进**全局层**，那等于让每一个 preset 都能调 /team（2026-09-28 修掉的越界）。

/** Cordis 插件名。 */
export const name = '@zws/dsh-dispatch-agent-team';

/**
 * 需要宿主先就绪的服务。
 * **刻意只有 webServer**：desktop/web profile 必有它，而配置页路由必须可靠注册。
 * 除它以外的依赖一律走 ctx.get(...) 惰性取用并降级（runtime.js 的 pick()）：
 *   * `settings`（定位 DSH 主目录，dsh-settings/lib/index.js:330 服务名 "settings"）——缺了就退回 DSH_HOME / ~/.dsh；
 *   * `agentTeams`（官方可选 bundle）、`llm`、`agents` —— 全部可选，缺了只降级不崩。
 * 把可选依赖写进 inject 会让「那一行被禁用 = 我们整个插件（含团队能力与配置页）都不 apply」，与降级设计冲突。
 */
export const inject = ['webServer'];

/** 配置页与 host 半约定的 CSRF 门头值（client 半必须带同一个值）。 */
const PLUGIN_GATE = 'zws-dispatch-agent-team';
/** 路由路径（精确匹配）。 */
const API_PATH = '/zws-dispatch-agent-team/api';
/** 请求体上限：这个 API 没有合法的巨大负载，无上限缓冲等于给本地攻击者一个内存放大面。 */
const MAX_BODY = 1024 * 1024;

/** 日志：优先用 Cordis 的 ctx.logger，缺失时退回 console（绝不静默）。 */
function warn(ctx, message) {
  try {
    if (ctx?.logger !== undefined && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn(`[${name}] ${message}`);
      return;
    }
  } catch {
    /* logger 本身不可用时退回 console */
  }
  console.warn(`[${name}] ${message}`);
}

/**
 * 把请求体读成字符串，超过上限立即拒绝。
 *
 * 必须**按字节**收、最后一次性解码：以前逐块 `String(chunk)` 是每个 Buffer 各自做一次
 * utf8 解码，一个多字节字符被分块切开时两块都会解出替换符（U+FFFD），中文描述会被静默改写。
 * 上限也按字节算，`text.length` 数的是字符，一个 1 MiB 的 UTF-8 请求体可能只算 300 KB 字符。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      size += buffer.length;
      if (size > MAX_BODY) {
        settled = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/** 写一个 JSON 响应。 */
function respond(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** 可读的错误文本。 */
function messageOf(error) {
  return error === undefined || error === null ? '未知错误' : String(error.message ?? error);
}

/**
 * `set` 的 `cache` 入参校验：**不猜**。
 *
 * 形状（全部可选，缺省 = 不动）：
 *   `{ keepalive: { routes: { '<provider>/<model>' | '<provider>' | '<族id>': {mode, intervalSeconds} } } }`
 *
 * 为什么要自己校验一遍：`sanitizeConfig` 的语义是「坏字段丢掉 + 记 log」（永不拒绝），
 * 而配置页需要**明确的失败原因**——用户填了 `mode: 'always'` 时必须看到「只能是 auto/on/off」，
 * 而不是保存成功、字段静默消失。
 *
 * @param raw - payload.args.cache。
 * @returns {ok:true, cache: object|undefined} 或 {ok:false, error}。
 */
function validateCache(raw) {
  if (raw === undefined || raw === null) return { ok: true, cache: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'cache 必须是一个对象' };
  const keepalive = raw.keepalive;
  if (keepalive === undefined || keepalive === null) return { ok: true, cache: { keepalive: { routes: {} } } };
  if (typeof keepalive !== 'object' || Array.isArray(keepalive)) return { ok: false, error: 'cache.keepalive 必须是一个对象' };
  const routes = keepalive.routes;
  if (routes === undefined || routes === null) return { ok: true, cache: { keepalive: { routes: {} } } };
  if (typeof routes !== 'object' || Array.isArray(routes)) return { ok: false, error: 'cache.keepalive.routes 必须是一个对象' };
  const clean = {};
  for (const [key, value] of Object.entries(routes)) {
    const trimmed = String(key).trim();
    if (trimmed === '') return { ok: false, error: 'cache.keepalive.routes 的键不能是空串' };
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: `cache.keepalive.routes["${trimmed}"] 必须是对象（如 {mode:"auto", intervalSeconds:210}）` };
    }
    const entry = {};
    if (value.mode !== undefined && value.mode !== null && value.mode !== '') {
      if (typeof value.mode !== 'string' || !KEEPALIVE_MODES.includes(value.mode)) {
        return { ok: false, error: `cache.keepalive.routes["${trimmed}"].mode 只能是 ${KEEPALIVE_MODES.join(' / ')}` };
      }
      entry.mode = value.mode;
    }
    if (value.intervalSeconds !== undefined && value.intervalSeconds !== null && value.intervalSeconds !== '') {
      const interval = Number(value.intervalSeconds);
      if (!Number.isFinite(interval) || interval < MIN_INTERVAL_SECONDS || interval > MAX_INTERVAL_SECONDS) {
        return { ok: false, error: `cache.keepalive.routes["${trimmed}"].intervalSeconds 必须在 ${MIN_INTERVAL_SECONDS}~${MAX_INTERVAL_SECONDS} 秒之间` };
      }
      entry.intervalSeconds = Math.round(interval);
    }
    if (Object.keys(entry).length === 0) return { ok: false, error: `cache.keepalive.routes["${trimmed}"] 里没有任何有效字段（mode / intervalSeconds）` };
    clean[trimmed] = entry;
  }
  return { ok: true, cache: { keepalive: { routes: clean } } };
}

/**
 * `set` 的入参校验：**不猜**。
 * provider/model 必须成对；未知角色 id 直接拒绝（否则客户端的数据会被静默丢掉）。
 * @param raw - payload.args.roles。
 * @returns 合法返回 {ok:true, roles}，否则 {ok:false, error}。
 */
function validateRoles(raw) {
  if (raw === undefined || raw === null) return { ok: true, roles: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'roles 必须是一个对象' };
  const roles = {};
  for (const [roleId, entry] of Object.entries(raw)) {
    if (!ROLE_IDS.includes(roleId)) return { ok: false, error: `未知角色 id: ${roleId}` };
    if (entry === null || entry === undefined) continue;
    if (typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, error: `角色 ${roleId} 的配置必须是一个对象` };
    const hasProvider = typeof entry.provider === 'string' && entry.provider.trim() !== '';
    const hasModel = typeof entry.model === 'string' && entry.model.trim() !== '';
    if (hasProvider !== hasModel) {
      return { ok: false, error: `角色 ${roleId} 的 provider 与 model 必须成对给出（只给一半会猜错路由，所以直接拒绝）` };
    }
    if (!hasProvider && !hasModel) {
      if (entry.reasoningEffort !== undefined && entry.reasoningEffort !== null && entry.reasoningEffort !== '') {
        return { ok: false, error: `角色 ${roleId} 只给了 reasoningEffort 却没给 provider/model` };
      }
      continue; // 只给空对象 = 该角色跟随 Lead
    }
    roles[roleId] = {
      provider: entry.provider.trim(),
      model: entry.model.trim(),
      ...(typeof entry.reasoningEffort === 'string' && entry.reasoningEffort !== '' ? { reasoningEffort: entry.reasoningEffort } : {}),
    };
  }
  return { ok: true, roles };
}

/**
 * 处理一次 API 调用。所有失败都返回 HTTP 200 + {ok:false,error}（不把 HTTP 当错误通道）。
 * @param ctx - 宿主 ctx。
 * @param req - node IncomingMessage。
 * @param res - node ServerResponse。
 */
async function handleApi(ctx, req, res) {
  const header = (headerName) => {
    const value = req.headers?.[headerName];
    return Array.isArray(value) ? value[0] ?? '' : value ?? '';
  };

  if (String(req.method || 'POST').toUpperCase() !== 'POST') {
    respond(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }
  // CSRF 主闸：浏览器跨站请求无法在不触发 CORS 预检的前提下带上自定义头，而本路由不应答预检。
  if (header('x-dsh-plugin') !== PLUGIN_GATE) {
    respond(res, 403, { ok: false, error: 'missing plugin gate header' });
    return;
  }
  // 纵深防御：Origin 存在时必须与 Host 同源或本机回环。
  const origin = header('origin');
  if (origin !== '') {
    let sameOrigin = false;
    try {
      const url = new URL(origin);
      const hostHeader = header('host');
      sameOrigin = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname) || url.host === hostHeader;
    } catch {
      /* Origin 不可解析 → 按不同源拒绝 */
    }
    if (!sameOrigin) {
      respond(res, 403, { ok: false, error: 'cross-origin request rejected' });
      return;
    }
  }

  let payload = {};
  try {
    payload = JSON.parse((await readBody(req)) || '{}');
  } catch (error) {
    if (messageOf(error).includes('body too large')) {
      respond(res, 200, { ok: false, error: '请求体过大' });
      return;
    }
    respond(res, 200, { ok: false, error: `请求体不是合法 JSON：${messageOf(error)}` });
    return;
  }

  const op = typeof payload?.op === 'string' ? payload.op : '';
  const args = payload?.args !== undefined && payload.args !== null && typeof payload.args === 'object' ? payload.args : {};
  try {
    switch (op) {
      case 'get': {
        await runtime.loadConfig(ctx);
        const configPath = await runtime.getConfigPath(ctx);
        respond(res, 200, {
          ok: true,
          config: runtime.peekConfig(),
          roles: ROLES,
          path: configPath,
          /** 磁盘版本指纹：客户端保存时带回来，用来发现「另一个会话刚改过」。 */
          revision: runtime.peekRevision(),
          /** 故障通道：非空才由页面渲染成告警。 */
          diagnostics: runtime.diagnostics(),
          /** 信息通道：DSH 主目录 / 配置文件路径 / 控制面注册结果，页面用中性样式展示。 */
          notes: runtime.notes(),
          /** 缓存保活：策略 + 统计（面板显示「这条线路到底省没省」）。 */
          cache: runtime.keepaliveStats(),
          /**
           * 保活的线路默认表（面板在没有活动会话时也要能显示「哪些线路默认开/关、为什么」）。
           * 顺序即匹配优先级；`match` 是正则，不下发（客户端只用 id/mode/ttl/why）。
           */
          cacheFamilies: [...ROUTE_FAMILIES, DEFAULT_FAMILY].map((family) => ({
            id: family.id,
            mode: family.mode,
            ttlSeconds: family.ttlSeconds,
            why: family.why,
          })),
          /** 最近的结构化汇报（队员 report_result 的产物）+ 被上限挤掉的条数。 */
          reports: runtime.recentReports(),
          /** 会话级团队开关记忆：宿主重启后哪几个会话会被自动恢复（见 lib/resume.js）。 */
          sessions: runtime.sessionMemory(),
        });
        return;
      }
      case 'list-models': {
        const catalog = await runtime.listModelCatalog(ctx);
        respond(res, 200, { ok: true, groups: catalog.groups, failures: catalog.failures });
        return;
      }
      case 'set': {
        const checked = validateRoles(args.roles);
        if (checked.ok !== true) {
          respond(res, 200, { ok: false, error: checked.error });
          return;
        }
        const cacheChecked = validateCache(args.cache);
        if (cacheChecked.ok !== true) {
          respond(res, 200, { ok: false, error: cacheChecked.error });
          return;
        }
        // 乐观并发：客户端带上它读到的磁盘指纹。比对不一致 → 拒绝，而不是静默覆盖别人的改动。
        // 不传 revision 的调用方（旧客户端/脚本）保持原语义，不会被这条闸门挡住。
        const expected = typeof args.revision === 'string' ? args.revision : undefined;
        if (expected !== undefined) {
          await runtime.loadConfig(ctx);
          const actual = runtime.peekRevision();
          if (actual !== expected) {
            respond(res, 200, {
              ok: false,
              conflict: true,
              revision: actual,
              error: '磁盘上的配置在这期间被改过，本次保存已取消',
            });
            return;
          }
        }
        // 合并语义：本次请求没带的字段**保持不变**（只改保活设置时不该把角色配置清空，反之亦然）。
        const current = runtime.peekConfig();
        const saved = await runtime.saveConfig(ctx, {
          version: CONFIG_VERSION,
          roles: args.roles === undefined ? (current?.roles ?? {}) : checked.roles,
          cache: cacheChecked.cache === undefined ? current?.cache : cacheChecked.cache,
        });
        if (saved.ok !== true) {
          respond(res, 200, { ok: false, error: saved.error });
          return;
        }
        respond(res, 200, {
          ok: true,
          config: saved.config,
          revision: runtime.peekRevision(),
          diagnostics: saved.diagnostics ?? [],
        });
        return;
      }
      case 'reset': {
        const saved = await runtime.saveConfig(ctx, defaultConfig());
        if (saved.ok !== true) {
          respond(res, 200, { ok: false, error: saved.error });
          return;
        }
        respond(res, 200, { ok: true, config: saved.config, revision: runtime.peekRevision() });
        return;
      }
      // 工作区画布：团队图（成员/统计/承接关系/汇总）。sessionId 由客户端从官方成员面板
      // 的 DOM 归属（data-conversation-session）拿到，服务端只认「本团队」。
      case 'team-graph': {
        const result = await runtime.teamGraph(ctx, typeof args.sessionId === 'string' ? args.sessionId : '');
        if (result.ok !== true) {
          respond(res, 200, { ok: false, error: result.error, ...(result.notEnabled ? { notEnabled: true } : {}) });
          return;
        }
        respond(res, 200, { ok: true, graph: result.graph, leadSessionId: result.leadSessionId, notes: result.notes ?? [] });
        return;
      }
      // 浮动窗口：某个团队成员的对话尾部。服务端校验 target 属于该会话所在团队。
      case 'team-conversation': {
        const result = await runtime.teamConversation(
          ctx,
          typeof args.sessionId === 'string' ? args.sessionId : '',
          typeof args.targetId === 'string' ? args.targetId : '',
          Number.isFinite(Number(args.limit)) ? Number(args.limit) : 120,
        );
        respond(res, 200, result);
        return;
      }
      // 工作区聊天框：读某个成员「向用户提过的问」（用户报「他提问时我在工作区看不到」）。
      case 'team-questions': {
        const result = await runtime.teamQuestions(
          ctx,
          typeof args.sessionId === 'string' ? args.sessionId : '',
          typeof args.targetId === 'string' ? args.targetId : '',
        );
        respond(res, 200, result);
        return;
      }
      // 工作区聊天框：向某个成员发一条用户消息（Lead 走 prompt，队员走 subagent delivery）。
      case 'team-send': {
        const result = await runtime.teamSend(
          ctx,
          typeof args.sessionId === 'string' ? args.sessionId : '',
          typeof args.targetId === 'string' ? args.targetId : '',
          typeof args.text === 'string' ? args.text : '',
        );
        respond(res, 200, result);
        return;
      }
      // 工作区提问卡：回答一次 ask_user_question（先 userQuestions.answer，兜底转消息）。
      case 'team-answer': {
        const result = await runtime.teamAnswer(
          ctx,
          typeof args.sessionId === 'string' ? args.sessionId : '',
          typeof args.targetId === 'string' ? args.targetId : '',
          typeof args.callId === 'string' ? args.callId : '',
          Array.isArray(args.answers) ? args.answers : [],
        );
        respond(res, 200, result);
        return;
      }
      default: {
        respond(res, 200, { ok: false, error: `未知操作: ${op || '(空)'}` });
        return;
      }
    }
  } catch (error) {
    // 任何未预期异常都必须变成可读错误，不能把连接挂着，也不能静默。
    warn(ctx, `API op "${op}" 失败：${messageOf(error)}`);
    respond(res, 200, { ok: false, error: messageOf(error) });
  }
}

/**
 * 挂载宿主半。
 * @param ctx - 宿主 ctx。
 * @param config - 本插件行的 config（cordis.patch.yml 里给了 {configFile, maxMembers}；
 *   这两个字段由官方 agent-team 行负责，本插件不消费，只在此说明以免被误认为遗漏）。
 */
export function apply(ctx, config) {
  void config;
  // 1. 预热配置：peekConfig() 会被 agent/request 热路径同步读取，启动时就先读一次磁盘。
  //    runtime.loadConfig 契约是永不抛错；这里再兜一层，避免启动期未处理的 rejection。
  runtime.loadConfig(ctx).catch((error) => warn(ctx, `启动预热配置失败（不影响插件加载）：${messageOf(error)}`));

  // 2. 生命周期接线：agent/created 必须在**同步**回调里安装模型/强度覆盖
  //    （dsh-agent/lib/index.js:572-588 的 serial 分发；首个 turn 在 materialize 返回后才投递）。
  try {
    runtime.watchAgents(ctx);
  } catch (error) {
    warn(ctx, `订阅 agent 生命周期失败（团队覆盖可能不生效）：${messageOf(error)}`);
  }
  // 冷恢复/补装：当前进程里已存在的活体 agent 按已开启的 root 记账补齐（启动瞬间通常为空）。
  try {
    runtime.reconcileAgents(ctx);
  } catch (error) {
    warn(ctx, `启动补装失败（已吞掉）：${messageOf(error)}`);
  }
  // 域服务缺失时明确记一条诊断，供配置页与排查使用（不抛、不硬依赖）。
  if (ctx.get('agentTeams') === undefined) {
    warn(ctx, '官方 Agent Teams 域服务未挂载：请在插件页启用 @deepseek-ai/dsh-experimental-agent-team-profile（至少保留 agent-team 行），否则 /team 会明确失败');
  }

  // 2.2 启动期**自愈**：profile 层的托管块丢失时自动补回来。
  //
  // 为什么需要（用户 2026-10-10 的真实事故）：他做的插件把 DSH 搞崩，重启时选
  // 「关闭所有插件并重启」—— 那个流程会重置 profile 的 cordis.patch.yml，于是
  // 本插件写的托管块（关掉官方 tool-agent-team 行 + agent-team 容量 48）**整段消失**，
  // 后果是官方九个团队工具与本插件同名冲突（tool "spawn_teammate" is already registered
  // in this scope）、界面显示「Team 暂不可用」。此前唯一修法是用户手动跑 repair.cjs，
  // 但用户不可能知道。现在插件自己检测并补齐（写入后**需再重启一次**才生效 ——
  // profile patch 在启动时读入，这是架构决定的，注释见 lib/self-heal.js）。
  try {
    const healed = healManagedBlock(ctx);
    if (healed.status === 'healed') warn(ctx, healed.message ?? '托管块已自动补齐');
    else if (healed.status === 'failed') warn(ctx, `托管块自愈失败：${healed.message ?? ''}`);
    // 'ok' / 'skipped' 都是正常路径，不打扰用户（skipped 的原因已在返回值里，供排查）。
  } catch (error) {
    // 自愈绝不能影响插件加载。
    warn(ctx, `托管块自愈异常（已吞掉，不影响加载）：${messageOf(error)}`);
  }

  // 2.5 缓存保活观察器（llm/stream 瀑布）。
  //
  // 为什么在宿主平面注册：`llm/stream` 由 dsh-llm 在自己的 ctx 上派发
  // （dsh-llm/lib/index.js:2367-2371），只有宿主平面的监听器能收到全部模型请求。
  // 我们对**非 Lead 请求完全旁路**（直接 return next()），并且团队没开时一行代码都不做；
  // 真正的挂载/卸载跟着 `enable_agent_team` / `disable_agent_team` 走（runtime.attachKeepalive）。
  // 观察器自身出任何错都只记信息，绝不影响模型请求（lib/cache.js 的 handleStream 全包了）。
  try {
    runtime.installKeepalive(ctx);
  } catch (error) {
    warn(ctx, `缓存保活安装失败（团队功能不受影响）：${messageOf(error)}`);
  }

  // 3. 禁止：控制面（`/team`、enable_agent_team、disable_agent_team）**不在这里注册**。
  //
  //    2026-09-28 的边界修正（用户要求：「/team 是调度模式专属，别的 preset 不许调」）：
  //    控制面必须注册在**调度模式的 preset 子树**里（lib/preset.js 的 apply），因为
  //      * `dsh-commands` 的 `view(agent)` = 全局层 + 该 agent 的**作用域链**；
  //        `dsh-tools` 的 `view(scope)` 同理；
  //      * ctx 的方法调用会被 traceable 代理重绑到**调用者自己的作用域**，
  //        所以「在哪个作用域调用 register，就注册进哪个层」。
  //    在宿主平面注册 = 进全局层 = **每一个 preset 的会话都能看到 `/team` 与开关工具**，
  //    这正是用户实测到的越界（极简灰度模式下也能调 /team）。
  //
  //    这里只保留宿主平面的两件与 preset 无关的事：配置页路由（步骤 4）与状态文件（步骤 5）。
  //    注意：`dsh-tools` / `dsh-commands` 是宿主平面服务，本插件行**不把它们写进 inject** ——
  //    否则「服务缺席 = 整个插件不 apply」，连配置页都会一起消失（这也是 preset 子树里用
  //    `ctx.inject` + `ctx.get` 而不是属性访问的原因，详见 lib/preset.js）。

  // 4. 配置页数据通道。register 不自动绑定生命周期，必须放进 ctx.effect（mcp-manager :1349-1352、:1422）。
  try {
    ctx.effect(
      () => ctx.webServer.register({
        kind: 'exact',
        path: API_PATH,
        handler: (req, res) => handleApi(ctx, req, res),
      }),
      'dispatch-agent-team: api route',
    );
  } catch (error) {
    // 路由注册失败不能打掉整个插件（预设半与团队能力仍然可用）。
    warn(ctx, `webServer 路由注册失败（配置页将不可用）：${messageOf(error)}`);
  }

  // 5. 写状态文件，供排查「/team 没出现 / 调度模式 preset 是否挂上」这类问题。
  //    为什么需要它：preset 子树的 broken 原因只在宿主的 logger.warn 里，桌面端不落盘、看不到。
  //    这里把 agentPresets.compositionInventory() 的结果与我们的注册结果一起落成 JSON。
  //
  //    注意：时机（2026-10-04 审查 P1-6）：compositionInventory() 读的是 agentPresets 服务当下的
  //    definitions（官方 dsh-agent-preset-registry/lib/index.js:500-509，register 发生在每个
  //    preset 行的 Service.init），而 loader 的挂载是**异步**的：本行 apply 时，同配置文件里
  //    后面的 preset 行（含 preset-dispatch-mode）还没注册进来。只写一次的状态文件于是
  //    对「调度模式 preset 到底挂没挂上」这个它唯一的用途系统性失明。
  //    准确根因（2026-10-04 修复阶段实测细化）：compositionInventory() 在**任何 await 之前**
  //    就同步快照了 definitions（官方 registry:793 的 [...this.definitions.values()]），
  //    它内部的 diagnostic() 自己会 await loader.await()（registry:563）也只能重审计「已经注册」
  //    的那些 preset——快照里根本没有的行，等多久都补不进来。所以修法必须是
  //    「等 loader settle 之后再重新调用一次」，而不是等同一次调用返回。
  //    处理：① 立即写一份 phase='boot' 的快照（证明 host 半活着）；
  //          ② 等 ctx.loader.await() 结束后写 phase='settled'（官方时机：dsh-app-boot:3489、
  //             :4084 就是这么用的；loader.await 只等各行的 import/生命周期 init 任务，
  //             已存活的 fiber 不在等待集合里，所以不会等自己）；
  //          ③ 拿不到 loader 服务时退回定时器兜底；
  //          ④ enable/disable 成功时也重写（那条路径上 preset 必然已挂好——
  //             /team 只存在于调度模式的 preset 层，见 lib/preset.js）。
  writeStatusFile(ctx, 'boot').catch((error) => warn(ctx, `写状态文件失败：${messageOf(error)}`));
  runtime.setStatusRefresh(() => {
    writeStatusFile(ctx, 'settled').catch((error) => warn(ctx, `刷新状态文件失败：${messageOf(error)}`));
  });
  const loaderSettled = ctx.get('loader');
  if (loaderSettled !== undefined && typeof loaderSettled.await === 'function') {
    loaderSettled.await()
      .then(() => writeStatusFile(ctx, 'settled'))
      .catch((error) => warn(ctx, `等 loader settle 后重写状态文件失败：${messageOf(error)}`));
  }
  // 兜底：loader 服务缺席（或 await 永不 resolve）时，定时器保证状态文件最终会有一份 settled。
  // 与上面并发也无害——两份都是同一套采集逻辑的快照，后写的覆盖前写的。
  const settledTimer = setTimeout(() => {
    writeStatusFile(ctx, 'settled').catch((error) => warn(ctx, `重写状态文件失败：${messageOf(error)}`));
  }, STATUS_SETTLE_DELAY_MS);
  // 定时器不许钉住进程（退出时还有挂起的 timer 会让 Node 等它）。
  settledTimer.unref?.();

  // 6. 卸载回卷：agent.ctx 上的注册不会随本插件卸载自动回卷，必须自己收口。
  ctx.effect(() => () => {
    try {
      runtime.disposeAll();
    } catch (error) {
      warn(ctx, `卸载回卷失败：${messageOf(error)}`);
    }
  }, 'dispatch-agent-team: dispose agent-scope registrations');
}

/** 状态文件名（与配置文件同目录）。 */
const STATUS_FILENAME = 'dispatch-agent-team-status.json';
/**
 * settled 快照的延迟（毫秒）。经验值：本机冷启动到 loader 全行挂载远小于这个数；
 * cordis loader 没有公开的「全部行已就绪」事件（见 writeStatusFile 的注释），
 * 所以用定时器兜底，并由 enable/disable 的钩子提供事件驱动的那一路。
 */
const STATUS_SETTLE_DELAY_MS = 15000;

/**
 * 采集并写出诊断状态文件：我们的注册结果、域服务可用性、**每个 preset 的组合健康度**
 * （含 `broken` 原因）、以及我们自己的 loader 行状态。
 * `diagnostics`（故障）与 `notes`（正常事实）分两条通道落盘，和页面看到的一致。
 * 永不抛错（调用方还会再兜一层）；写不进去只 warn。
 * @param ctx - 宿主 ctx。
 * @param phase - 'boot'（apply 当场）或 'settled'（loader 挂载完成 / 开团关团之后）。
 * @returns Promise<void>
 */
async function writeStatusFile(ctx, phase = 'boot') {
  const status = {
    generatedAt: new Date().toISOString(),
    /** 'boot' = apply 当场拍的（preset 行可能还没注册进来）；'settled' = loader 挂载完成后重拍的。 */
    phase,
    plugin: name,
    agentTeams: ctx.get('agentTeams') === undefined ? null : true,
    diagnostics: runtime.diagnostics(),
    notes: runtime.notes(),
    presets: null,
    rows: null,
    configPath: null,
    /** 缓存保活状态与统计（重启后复查「保活到底有没有在跑、有没有命中」直接看这里）。 */
    cache: runtime.keepaliveStats(),
    /** 会话级团队开关记忆（宿主重启后靠它恢复；见 lib/resume.js）。 */
    sessions: runtime.sessionMemory(),
    /** 最近的结构化汇报（队员交付的证据链）+ dumped 计数（面板要如实说「另有 N 条没展示」）。 */
    reports: runtime.recentReports(),
  };
  try {
    status.configPath = await runtime.getConfigPath(ctx);
  } catch (error) {
    status.configPath = `(取不到：${messageOf(error)})`;
  }
  // preset 组合健康度：`broken` 就是那一份「为什么整份 preset 被拒」的原因。
  try {
    const agentPresets = ctx.get('agentPresets');
    if (agentPresets !== undefined && typeof agentPresets.compositionInventory === 'function') {
      const inventory = await agentPresets.compositionInventory();
      status.presets = (Array.isArray(inventory) ? inventory : []).map((entry) => ({
        id: entry?.id,
        name: entry?.name,
        isDefault: entry?.isDefault === true,
        broken: entry?.broken === undefined ? null : String(entry.broken),
        rowCount: Array.isArray(entry?.rows) ? entry.rows.length : null,
      }));
    }
  } catch (error) {
    status.presets = `(取不到：${messageOf(error)})`;
  }
  // 我们自己的 loader 行状态。
  try {
    const loader = ctx.get('loader');
    if (loader !== undefined && typeof loader.entries === 'function') {
      status.rows = [...loader.entries()]
        .filter((entry) => {
          const entryId = entry?.options?.id;
          const entryName = entry?.options?.name;
          if (entryId === 'agent-team' || entryId === 'tool-agent-team' || entryId === 'ui-agent-team') return true;
          // `subagent` 是**第二道容量帽**的所在行（maxActiveSubagents，本机 15）：
          // 队员是 continuable 子代理，这道帽管着同时在线数，且池是进程级共享的。
          // 此前本地只登记了 maxMembers 那道，同时在线这道零登记（2026-10-05 审查 §2）。
          if (entryId === 'subagent') return true;
          if (entryId === 'dispatch-agent-team' || entryId === 'dispatch-agent-team-panel') return true;
          return typeof entryName === 'string' && entryName.includes('dsh-dispatch-agent-team');
        })
        .map((entry) => {
          const id = entry?.options?.id;
          const config = entry?.options?.config;
          return {
            id,
            name: entry?.options?.name,
            disabled: entry?.disabled === true,
            phase: entry?.fiber?.state ?? null,
            // `agent-team` 的 maxMembers 是**承重参数**：它的 roster 是累计上限，被顶回官方默认 8
            // 之后 8 次 spawn 就再也派不出人。2026-09-28 它就是这样被静默顶掉的（MAINTAINER-NOTES.md §8.6），
            // 所以把 patch **之后的有效值**记进可观测的状态文件，而不是只信我们自己 patch 里那份。
            ...(id === 'agent-team' && config !== null && typeof config === 'object'
              ? { maxMembers: config.maxMembers, maxTasks: config.maxTasks }
              : {}),
            // 第二道帽：maxActiveSubagents 是 continuable 池的容量（宿主默认 8，本机 15）。
            // 与上面 maxMembers 同法——记 **patch 之后的有效值**，才能发现「被顶回默认」。
            // 它是 .volatile() 的（dsh-subagent/lib/index.js:2823），设置页可改，
            // 所以这里如实采集、不猜、不写死。
            ...(id === 'subagent' && config !== null && typeof config === 'object'
              ? { maxActiveSubagents: config.maxActiveSubagents, maxDepth: config.maxDepth }
              : {}),
          };
        });
    }
  } catch (error) {
    status.rows = `(取不到：${messageOf(error)})`;
  }
  const path = status.configPath !== null && !String(status.configPath).startsWith('(')
    ? String(status.configPath).replace(/dispatch-agent-team\.json$/u, STATUS_FILENAME)
    : void 0;
  if (path === void 0) return;
  const fs = await import('node:fs/promises');
  await fs.writeFile(path, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
}

/**
 * 具名导出 + default 导出同形：官方包用命名导出（tool-agent-team:557），
 * 本 profile 里跑通的 某个第三方插件 用 default 导出（:15-18），两种 loader 形态都实测可用。
 *
 * 注意：维护约束（2026-10-04 审查 P2-26）：default 里的三个成员必须**始终**指向上面同一组
 * name/inject/apply 实现。若将来 apply 带上模块级状态，两处各写一份就会出现「loader 走哪条
 * 路径行为不同」的静默分叉 —— 加这条注释是为了让下一次改动时看得见这个约束。
 */
export default { name, inject, apply };