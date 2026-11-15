// 团队成员行枚举 —— 新旧宿主同一套形状（rc.3 兼容层）
//
// ── 为什么必须有这个模块（2026-11-15，0.2.2-rc.3 升级）────────────────────────
// rc.2 及以前，团队成员名单来自 `ctx.agentTeams.listMembers(lead)`（同步，返回 roster 行）。
// rc.3 把那个方法**整个删掉了**（官方升级指南 docs/upgrade-guide/v0.2.1-rc.2/
// agent-team-subagents：「ctx.agentTeams 移除创建、通信、中断、名册、成员关系和等待 API」）。
// 成员关系改由 `ctx.subagents` 表达：
//   * `rootOf(agent)`         —— agent 所在子代理树的根（本身就是根时返回它自己）
//   * `listDescendants(id)`   —— 递归列出整棵树的行（kind:'child' | 'diagnostic'），async
// 插件里有一批地方（工作区画布、配置页、会话白名单、保活计数）都吃 roster 行，
// 所以要有一个**统一**的取法，而不是每处各写一遍新旧两条分支。
//
// ── 为什么单独一个模块而不是放 runtime.js ─────────────────────────────────────
// lib/runtime.js 已经 import 了 lib/graph.js（见 runtime.js 顶部）。把兼容层写在
// runtime.js 里、再让 graph.js 反过来 import runtime.js，就成了循环依赖 ——
// ESM 下会拿到未初始化的绑定，动静取决于加载顺序，是最难查的那类 bug。
// 所以两边共用的小工具放这里：它不 import 任何本包模块，谁都能安全引用。

/**
 * 从活体 agent 取会话 id。
 *
 * 依据：`agent.id === agent.session.id` 是官方硬约束（dsh-agent/lib/index.js:512
 * `if (id !== agent.session.id) throw ...`），所以优先 `session.id`，退回 `agent.id`。
 * @param {object} agent - 任意 agent。
 * @returns {string|undefined}
 */
export function sessionIdOfAgent(agent) {
  if (agent === null || typeof agent !== 'object') return undefined;
  const id = agent.session?.id;
  if (typeof id === 'string' && id !== '') return id;
  const fallback = agent.id;
  return typeof fallback === 'string' && fallback !== '' ? fallback : undefined;
}

/**
 * 枚举一个团队**当前在册**的成员行，新旧宿主同一套形状。
 *
 * 返回行字段与官方 rc.2 的 `listMembers` 对齐（`{id, name, role, status, ...}`），
 * 调用方的折叠逻辑一行都不用改。
 *
 * @param {object} options
 * @param {object} [options.agentTeams] - 官方域服务（rc.2 用；可缺）。
 * @param {object} [options.subagents] - `ctx.subagents`（rc.3 用；可缺）。
 * @param {object} options.lead - 团队根 agent。
 * @param {(message: string) => void} [options.onError] - 只读诊断回调（不抛）。
 * @returns {Promise<Array<object>>} 成员行；读不到返回空数组。
 */
export async function listMemberRows({ agentTeams, subagents, lead, onError }) {
  if (lead === undefined || lead === null) return [];
  const report = typeof onError === 'function' ? onError : () => {};

  // ① rc.2 及以前：官方 roster 行最准，有就用它。
  if (agentTeams !== undefined && agentTeams !== null && typeof agentTeams.listMembers === 'function') {
    try {
      const rows = agentTeams.listMembers(lead);
      if (Array.isArray(rows)) return rows;
    } catch (error) {
      report('listMembers 失败：' + String(error?.message ?? error));
    }
  }

  // ② rc.3：从子代理树枚举。
  if (subagents === undefined || subagents === null || typeof subagents.listDescendants !== 'function') return [];
  const rootId = sessionIdOfAgent(lead);
  if (rootId === undefined) return [];
  try {
    const descendants = await subagents.listDescendants(rootId);
    const rows = [{
      id: rootId,
      name: 'lead',
      role: 'lead',
      status: 'running',
    }];
    for (const entry of Array.isArray(descendants) ? descendants : []) {
      // diagnostic 行表示那条分支读不出来（corrupt/unsupported/unavailable），不是成员。
      if (entry?.kind !== 'child') continue;
      rows.push({
        id: entry.id,
        name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : String(entry.id),
        role: 'teammate',
        // rc.3 只有 running / inactive 两态；本插件只关心「是不是还在跑」。
        status: entry.activity === 'running' ? 'running' : 'inactive',
        path: entry.path,
        depth: entry.depth,
      });
    }
    return rows;
  } catch (error) {
    report('listDescendants 失败：' + String(error?.message ?? error));
    return [];
  }
}
