// 团队域服务的**双代宿主兼容层**（rc.2 ⇄ rc.3）
//
// ── 为什么需要它（2026-11-15，0.2.2-rc.3）────────────────────────────────────
// rc.2 及以前，本插件的团队工具直接吃 ctx.agentTeams 那套 API：
//   spawnTeammate(caller, {name, description, prompt, context, provider, signal})
//   sendMessage(caller, {target, content, signal})   → {messageId}
//   listMembers(agent)                                → roster 行
//   listTasks / getTask / createTask / updateTask
// rc.3 把上面这些**大半删了**（官方升级指南 docs/upgrade-guide/v0.2.1-rc.2/
// agent-team-subagents：「移除 spawn_teammate 以及 Team 作用域的 send_message、
// list_agents 和 interrupt_agent」「ctx.agentTeams 移除创建、通信、中断、名册、
// 成员关系和等待 API」）。实测 app.asar：spawnTeammate / tryMembership /
// listMembers / waitForChange 在 dsh-agent-team 里 **0 命中**；
// 任务板四件套（createTask/getTask/listTasks/updateTask）**仍在**。
//
// 所以「团队成员」这件事在 rc.3 要分两半看：
//   * 任务板        → 仍是 ctx.agentTeams（没变，继续用）
//   * 成员/通信/中断 → 搬到 ctx.subagents（rootOf / listDescendants /
//                     startActivation / sendMessage / interrupt）
// 这个模块把两代宿主收敛成**同一套函数**，lib/tools.js 只调这里，不再直接摸官方形状。
//
// ── 一条必须记住的语义差异 ──────────────────────────────────────────────────
// rc.2 的 spawnTeammate 建的是「**常驻队员**」：返回时队员已在册、名字已占用、
// 之后可以反复 sendMessage。
// rc.3 的 startActivation 返回的是**这一次执行**的句柄（含 result: Promise）。
// 队员的常驻身份在于「它是 parent-delivery 的 continuable 子会话」——
// 也就是 delivery:'parent' + 可续跑。我们照这个语义构造，返回与 rc.2 同形的
// { member } 对象，调用方一行都不用改。

/**
 * 取一个可选服务（与 runtime.js 的 pick 同义，但这里刻意不 import runtime，
 * 避免 runtime ⇄ tools ⇄ team-api 的循环依赖）。
 * @param {object} ctx - 任意作用域 ctx。
 * @param {string} name - 服务名。
 * @returns {any}
 */
function pick(ctx, name) {
  if (ctx === undefined || ctx === null) return undefined;
  if (typeof ctx.get === 'function') {
    try {
      const found = ctx.get(name);
      if (found !== undefined && found !== null) return found;
    } catch {
      // 服务缺失/取值抛错一律当没有：调用方会走降级分支。
    }
  }
  try {
    return ctx[name] ?? undefined;
  } catch {
    return undefined;
  }
}

/** 从 agent 取会话 id（官方硬约束 agent.id === agent.session.id）。 */
function sessionIdOf(agent) {
  if (agent === null || typeof agent !== 'object') return undefined;
  const fromSession = agent.session?.id;
  if (typeof fromSession === 'string' && fromSession !== '') return fromSession;
  return typeof agent.id === 'string' && agent.id !== '' ? agent.id : undefined;
}

/**
 * 这个宿主是不是 rc.3 形状（域服务没有 spawnTeammate，但 subagents 有 startActivation）。
 * @param {object} agentTeams - ctx.get('agentTeams')。
 * @param {object} subagents - ctx.get('subagents')。
 * @returns {boolean}
 */
export function usesSubagentActivation(agentTeams, subagents) {
  if (typeof agentTeams?.spawnTeammate === 'function') return false;
  return typeof subagents?.startActivation === 'function';
}

/**
 * 建一个队员（两代宿主同一套入参/返回）。
 *
 * @param {object} options
 * @param {object} options.agentTeams - ctx.get('agentTeams')。
 * @param {object} options.subagents - ctx.get('subagents')（rc.3 用）。
 * @param {object} options.caller - 调用者（Lead）agent。
 * @param {string} options.name - 队员名。
 * @param {string} options.description - 一句话描述（写进 catalog label）。
 * @param {Array<object>} options.prompt - ContentBlock[]（已是完整正文）。
 * @param {'fresh'|'fork'} options.context - fresh=全新上下文；fork=继承父历史。
 * @param {string} [options.provider] - 宿主 provider 名（spawn / fork）。
 * @param {AbortSignal} [options.signal] - 取消信号。
 * @returns {Promise<{member:object}>} 与 rc.2 spawnTeammate 同形的回包。
 * @throws 失败时原样抛官方错误（调用方的 translateSpawnFailure 按 code 翻译）。
 */
export async function spawnTeammate(options) {
  const { agentTeams, subagents, caller, name, description, prompt, context, provider, signal, agentPreset, agentOptions } = options ?? {};
  if (typeof agentTeams?.spawnTeammate === 'function') {
    // ── rc.2：原样转发 ──
    // rc.2 的 spawnTeammate 没有 agentPreset/agentOptions 这两个口（它们随 rc.3 的
    // SubagentStartRequest 才出现），所以这一段一个字段都不加 —— 加了会被 rc.2 的
    // schemastery 判成未知键或直接忽略，两种都不如实。
    return await agentTeams.spawnTeammate(caller, {
      name,
      description,
      prompt,
      context,
      ...(provider === undefined ? {} : { provider }),
      signal,
    });
  }
  if (typeof subagents?.startActivation !== 'function') {
    throw new Error('spawn_teammate 失败：当前宿主既没有 agentTeams.spawnTeammate（rc.2）也没有 subagents.startActivation（rc.3）—— 无法创建队员');
  }
  // ── rc.3：用 startActivation 复现「常驻队员」语义 ──
  //
  // delivery:'parent' 是关键：只有 parent-delivery 的子会话才进父的 catalog、
  // 才有名字、才能之后被 sendMessage 反复唤醒（dsh-subagent/src/manager.ts:440
  //   const reservation = delivery === 'parent' ? this.reserveName(...) : undefined）。
  // caller-delivery 不进目录、没名字，那就不是「队员」了。
  const chosenProvider = typeof provider === 'string' && provider !== ''
    ? provider
    : (context === 'fork' ? 'fork' : 'spawn');
  const activation = await subagents.startActivation({
    // label 必填（SubagentActivationSpec.label）—— 用队员描述当它。
    label: typeof description === 'string' && description !== '' ? description : name,
    ...(typeof name === 'string' && name !== '' ? { name } : {}),
    prompt,
    parent: caller,
    provider: chosenProvider,
    delivery: 'parent',
    // ── 创建时就把「组合」与「路由」定下来（2026-11-17 真机 session-f0ff263b 的 P0）──
    //
    // 这两项是**官方给创建窗口的口**（dsh-subagent/src/types.ts:152 的 agentPreset、
    // :177 的 agentOptions），它们在 `agents.create` 的 setup 期就生效，
    // 早于 announce、更早于第一次装配 —— 而本插件的 installMember 只能在
    // 队员**已经存在**之后才跑（agent/created 在 rc.3 上赶不上，见 forceSyncMember 的长注释）。
    // 于是「装得太晚」这个竞态会同时打坏两件事：
    //   ① 第一步的工具面（组合还是继承来的那份 → 163 个原生工具，第二步才切成 run_code）；
    //   ② 第一步的模型（角色路由要等 installMember 装拦截器才生效，晚一步就是被官方
    //      agent/request 校验打死的那个 P0）。
    // 把两件事都在创建时交代清楚，第一步就是对的，不再依赖「装得快不快」。
    ...(agentPreset === undefined ? {} : { agentPreset }),
    ...(agentOptions === undefined ? {} : { agentOptions }),
    // ⚠️ rc.3 的 SubagentActivationSpec.signal 是**必填**（types.ts:43），
    // 不是可选。真机上 exec.signal 总是有值所以没炸，但替身/边界调用可能没有 ——
    // 缺了会被 provider 直接拒（"missing required property signal" 之类的错误），
    // 而那时队员其实还没建。这里兜一个**永不触发**的 signal：
    // 它是「没有取消渠道」的如实表达，不是假装可取消。
    signal: signal ?? new AbortController().signal,
  });
  // ── 形状对齐 rc.2 的 member 行（调用方读 name / status / role / diagnostics）──
  // ⚠️ 2026-11-15 真机 P0：这里原来**没有 role**，而 SPAWN_VALUE_SCHEMA 里
  // member 复用的是 MEMBER_VIEW_SCHEMA（role 是 required）→ 每一次成功派队员
  // 都被宿主判成 ToolOutputError：
  //   Error: tool "spawn_teammate" returned invalid output:
  //     missing required property "value.member.role"
  // 队员其实**已经创建成功了**，模型却看到一条报错 —— 它会以为失败并重试，
  // 于是同一个角色被派两次（实测 session-987dedcf 里 researcher-alpha 被派了两遍）。
  // 现在把 schema 要求的三个 required(role/status/target 由 modelMember 补) 一次补齐。
  return {
    member: {
      id: activation?.childId,
      name: typeof activation?.name === 'string' && activation.name !== '' ? activation.name : name,
      // rc.3 的 startActivation 建出来的就是**队员**（delivery:'parent' 的常驻子会话）。
      role: 'teammate',
      description,
      status: 'running',
      diagnostics: [],
    },
  };
}

/**
 * 给某个队员（或 Lead）发一条消息。
 *
 * @param {object} options
 * @param {object} options.agentTeams - ctx.get('agentTeams')。
 * @param {object} options.subagents - ctx.get('subagents')。
 * @param {object} options.caller - 发送者 agent。
 * @param {string} options.target - 目标**名字**（rc.2 语义）或会话 id。
 * @param {Array<object>} options.content - ContentBlock[]。
 * @param {AbortSignal} [options.signal] - 取消信号。
 * @returns {Promise<{messageId?:string}>}
 */
export async function sendMessage(options) {
  const { agentTeams, subagents, caller, target, content, signal } = options ?? {};
  if (typeof agentTeams?.sendMessage === 'function') {
    // ── rc.2：target 是名字，官方自己解析 ──
    return await agentTeams.sendMessage(caller, {
      target,
      content,
      ...(signal === undefined ? {} : { signal }),
    });
  }
  if (typeof subagents?.sendMessage !== 'function') {
    throw new Error('send_message 失败：当前宿主既没有 agentTeams.sendMessage（rc.2）也没有 subagents.sendMessage（rc.3）');
  }
  // ── rc.3：target 必须是**会话 id**，名字得先解析 ──
  //
  // 官方给了 resolveName(caller, name)：'lead' / 相对根的完整路径名 / 裸 id 都认
  // （dsh-subagent/lib/index.js:3072）。用它做名字→id 的翻译，不要自己猜。
  const targetId = await resolveTargetId(subagents, caller, target, signal);
  const messageId = await subagents.sendMessage(caller, targetId, content, {
    ...(signal === undefined ? {} : { signal }),
  });
  return { messageId };
}

/**
 * 把「目标」（名字 或 会话 id）解析成会话 id（rc.3）。
 *
 * 顺序：'lead' → 根自身；否则走官方 resolveName（它同时接受名字与 id）。
 * @param {object} subagents - ctx.get('subagents')。
 * @param {object} caller - 发送者 agent。
 * @param {string} target - 名字或 id。
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
async function resolveTargetId(subagents, caller, target, signal) {
  const text = typeof target === 'string' ? target.trim() : '';
  if (text === '') throw new Error('send_message 失败：缺少目标');
  if (text === 'lead') {
    const root = subagents.rootOf(caller);
    const rootId = sessionIdOf(root);
    if (rootId === undefined) throw new Error('send_message 失败：解析不到团队根会话 id');
    return rootId;
  }
  if (typeof subagents.resolveName === 'function') {
    return await subagents.resolveName(caller, text, signal);
  }
  // 没有 resolveName（更早的 rc.3 快照）：把 target 当 id 直接交出去，
  // 官方 sendMessage 会以 UNAUTHORIZED / not-in-tree 拒绝并给出可路由的错误码。
  return text;
}

/**
 * 中断一个队员。
 * @param {object} options
 * @param {object} options.subagents - ctx.get('subagents')。
 * @param {object} options.caller - 发起中断的 agent（必须是**祖先**）。
 * @param {string} options.target - 队员名或会话 id。
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{accepted:boolean}>}
 */
export async function interruptAgent(options) {
  const { subagents, caller, target, signal } = options ?? {};
  if (typeof subagents?.interrupt !== 'function') {
    throw new Error('interrupt_agent 失败：当前宿主没有 subagents.interrupt');
  }
  const targetId = await resolveTargetId(subagents, caller, target, signal);
  // interrupt 是**同步**的 fire-and-return；authority 必须是 exact live ancestor。
  subagents.interrupt(targetId, { kind: 'ancestor', agent: caller });
  return { accepted: true };
}

/**
 * 列当前在册成员（两代同一套行形状）。
 *
 * @param {object} options
 * @param {object} options.agentTeams - ctx.get('agentTeams')。
 * @param {object} options.subagents - ctx.get('subagents')。
 * @param {object} options.lead - 团队根 agent。
 * @returns {Promise<Array<object>>} {id,name,role,status,...}[]
 */
export async function listMembers(options) {
  const { agentTeams, subagents, lead } = options ?? {};
  if (typeof agentTeams?.listMembers === 'function') {
    try {
      const rows = agentTeams.listMembers(lead);
      if (Array.isArray(rows)) return rows;
    } catch {
      // 落到 rc.3 路径。
    }
  }
  if (typeof subagents?.listDescendants !== 'function') return [];
  const rootId = sessionIdOf(lead);
  if (rootId === undefined) return [];
  const descendants = await subagents.listDescendants(rootId);
  const rows = [{ id: rootId, name: 'lead', role: 'lead', status: 'running' }];
  for (const entry of Array.isArray(descendants) ? descendants : []) {
    if (entry?.kind !== 'child') continue;
    rows.push({
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : String(entry.id),
      role: 'teammate',
      // rc.3 只有 running / inactive 两态。
      status: entry.activity === 'running' ? 'running' : 'inactive',
      path: entry.path,
      depth: entry.depth,
    });
  }
  return rows;
}

/**
 * 等「下一步会有新输入」（两代同一套入参/返回）。
 *
 * ── 为什么 rc.3 必须换成 inbox 等待（2026-11-15）──────────────────────────
 * rc.2：`agentTeams.waitForChange(caller, timeoutMs, signal)` —— 域服务自己记账，
 *       任何成员状态 / 邮箱 / 任务板变化都会唤醒它。
 * rc.3：`waitForChange` **已被官方删除**（实测 dsh-agent-team 里 0 命中）。
 *       官方自己那个 `wait_agent` 改成等**调用者自己的 inbox**：
 *       `ctx.on('agent/inbox/inserted', ({agent}) => agent === 自己 → resolve)`
 *       （dsh-tool-subagent-control/src/wait-agent.ts:26-78）。
 *       语义变成「等一条真正会进我上下文的新消息」——比 rc.2 更准确：
 *       rc.2 那些「谁的状态变了」的唤醒，本来也不会给 Lead 带来新信息。
 *
 * 所以 rc.3 下我们照官方的做法实现（同一套事件、同一套返回形状），
 * 任务的**变化**不再唤醒等待——这正好与官方升级指南一致：
 * 「Task changes do not end wait_agent calls」。
 *
 * @param {object} options
 * @param {object} options.agentTeams - ctx.get('agentTeams')。
 * @param {object} options.caller - 等待者 agent。
 * @param {number} options.timeoutMs - 等待上限（毫秒）。
 * @param {AbortSignal} [options.signal] - 调用方取消信号。
 * @returns {Promise<{timedOut:boolean}>}
 */
export async function waitForChange(options) {
  const { agentTeams, caller, timeoutMs, signal } = options ?? {};
  // rc.2：官方自己记账，直接委托。
  if (typeof agentTeams?.waitForChange === 'function') {
    return await agentTeams.waitForChange(caller, timeoutMs, signal);
  }
  // rc.3：等调用者自己的 inbox（与官方 wait_agent 同一套语义）。
  const ctx = caller?.ctx;
  if (ctx === undefined || ctx === null || typeof ctx.on !== 'function') {
    throw new Error('wait_agent 失败：当前宿主既没有 agentTeams.waitForChange（rc.2），也拿不到 agent.ctx（rc.3 的 inbox 等待入口）');
  }
  return await waitForInbox(ctx, caller, timeoutMs, signal);
}

/**
 * rc.3 的 inbox 等待（照 dsh-tool-subagent-control/src/wait-agent.ts 的 waitForInput 移植）。
 *
 * 与官方的两处刻意差异：
 *   * 不维护「同一次调用里已报告过的 id」——本插件的工具一次调用只等一次，
 *     没有官方 run_code 里那种循环等待的重复问题；
 *   * 增加 `lifetime`（调用方 signal）之外不做额外 abort。
 * 其余（先订阅再读、结束必清资源、agent 被销毁即拒绝）与官方一致 ——
 * 少任何一条都会漏事件或泄漏监听器。
 *
 * @param {object} ctx - 携带 events 的任意作用域 ctx。
 * @param {object} caller - 等待者 agent。
 * @param {number} timeoutMs - 等待上限。
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {Promise<{timedOut:boolean}>}
 */
function waitForInbox(ctx, caller, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    // ⚠️ 这三个变量必须**先声明**再用（2026-11-15 第七轮真机 P0）。
    // 原来它们声明在下面（let offInbox / let offDisposed / let timer，紧挨着 ctx.on 那一行），
    // 而 cleanup() 是闭包、在上面就引用了 timer —— 于是任何「先 finish 再走到声明」的路径
    // 都会撞上 TDZ：
    //   Error: Cannot access 'timer' before initialization
    // 真机（session-987dedcf turn 7 seq 1305）：Lead 调 wait_agent 等一个正在跑的队员，
    // 那一刻 inbox 里恰好已有待处理输入，于是走「立刻返回」那一支 → finish → cleanup
    // → 读 timer → 崩。工具整个失败，Lead 主循环断在那里。
    // 这一支是**确定性的**，不是偶发：只要有待处理输入就必崩（见 selftest 的复现用例）。
    let offInbox;
    let offDisposed;
    let timer;
    const cleanup = () => {
      // timer 可能是 undefined（连 setTimeout 都还没跑到就 finish 了），clearTimeout(undefined) 是安全的。
      clearTimeout(timer);
      if (typeof offInbox === 'function') offInbox();
      if (typeof offDisposed === 'function') offDisposed();
      if (signal !== undefined && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    };
    const finish = (settle) => {
      if (settled) return;
      settled = true;
      cleanup();
      settle();
    };
    // 已经有待处理的输入：立刻返回（与官方 onInput() 的首次调用等价）。
    const pending = caller?.inbox?.nextStep;
    if (Array.isArray(pending) && pending.length > 0) {
      finish(() => resolve({ timedOut: false }));
      return;
    }
    const onAbort = () => finish(() => reject(signal?.reason));
    offInbox = ctx.on('agent/inbox/inserted', ({ agent: recipient }) => {
      if (recipient === caller) finish(() => resolve({ timedOut: false }));
    });
    offDisposed = ctx.on('agent/disposed', ({ agent: disposed }) => {
      if (disposed === caller) finish(() => reject(new Error('wait_agent ended because the calling agent was disposed')));
    });
    if (signal !== undefined && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => finish(() => resolve({ timedOut: true })), timeoutMs);
    if (signal?.aborted === true) onAbort();
  });
}

/**
 * 任务板：两代都在 ctx.agentTeams 上，但 rc.3 **要求先 setEnabled**。
 *
 * rc.3 的 TeamTaskBoard.state() 第一行就是
 *   if (state.enabled !== true) throw TEAM_DISABLED
 * （dsh-agent-team/lib/index.js:436，get/list 都走它）。
 * 所以「用 /team 开了插件团队但没开官方开关」时这四个工具会全部抛错。
 * runtime.enable() 现在会顺手把官方开关拨上，见 lib/runtime.js。
 * @param {object} agentTeams - ctx.get('agentTeams')。
 * @returns {object|undefined}
 */
export function taskBoardOf(agentTeams) {
  if (agentTeams === undefined || agentTeams === null) return undefined;
  const hasAny = ['createTask', 'getTask', 'listTasks', 'updateTask']
    .some((name) => typeof agentTeams[name] === 'function');
  return hasAny ? agentTeams : undefined;
}

/**
 * 回环闸：本插件**自己**拨开关时置位，避免监听器把自己写的事件当成「用户操作」再拨回去。
 *
 * 场景：F1 里 /team 调 setEnabled(true) → 官方 append team/mode → 我们的
 * session/event 监听器看到 enabled:true → 又想 enable 一次……无限回环。
 * 时序上 append 是同步广播（dsh-session/src/index.ts:972-992 的 commit()），
 * 所以在 await setEnabled 之前置位、之后（含 finally）清位就能盖住那次广播。
 * @type {boolean}
 */
let applyingOfficialMode = false;

/**
 * 本插件是否正在写官方开关（供监听器判回环）。
 * @returns {boolean}
 */
export function isApplyingOfficialMode() {
  return applyingOfficialMode;
}

/**
 * 把官方团队开关拨到指定状态（rc.3 的公开方法，幂等）。
 *
 * 依据：async setEnabled(agent, enabled, signal)（dsh-agent-team/lib/index.js:789）
 * 内部判 if (this.isEnabled(root) !== enabled) append('team/mode') —— 重复调用无副作用。
 * @param {object} agentTeams - ctx.get('agentTeams')。
 * @param {object} agent - 团队根 agent。
 * @param {boolean} enabled - 目标状态。
 * @returns {Promise<{ok:boolean, changed:boolean, reason?:string}>}
 */
export async function setOfficialTeamMode(agentTeams, agent, enabled) {
  if (agentTeams === undefined || agentTeams === null) {
    return { ok: false, changed: false, reason: 'agentTeams 域服务不可用' };
  }
  if (typeof agentTeams.setEnabled !== 'function') {
    return { ok: false, changed: false, reason: '该宿主没有 setEnabled（rc.2 及以前没有团队开关）' };
  }
  if (typeof agentTeams.isEnabled === 'function') {
    let current;
    try {
      current = agentTeams.isEnabled(agent);
    } catch {
      current = undefined;
    }
    if (current === enabled) return { ok: true, changed: false };
  }
  // 置位跨越整个 await：append 是同步广播，flush 才是异步。
  // 位标志在 finally 里清，保证抛错也不会把开关「焊死」在监听器忽略状态。
  applyingOfficialMode = true;
  try {
    await agentTeams.setEnabled(agent, enabled);
    return { ok: true, changed: true };
  } catch (error) {
    return { ok: false, changed: false, reason: String(error?.message ?? error) };
  } finally {
    applyingOfficialMode = false;
  }
}
