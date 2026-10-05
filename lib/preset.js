// 调度模式 preset 半 —— 两件事，**都在 preset 子树里**（这是「只属于调度模式」的实现方式）：
//   1. `apply(ctx)`：注册调度模式提示词段 + 控制面（一个 `/team` 命令 + enable/disable_agent_team 两个工具）。
//      注册落在**本 preset 的层**，所以只有选了「调度模式」的会话能看到、能调用；
//      别的 preset（极简灰度等）既看不到 `/team`，也拿不到开关工具，更拿不到团队工具。
//      禁止：没有 `/team-off`：关闭团队用模型工具 `disable_agent_team`（用户明确要求去掉这个斜杠命令）。
//   2. 整段包 try/catch：preset 子树里任何一处抛错都会让整份 preset 变 broken
//      （只 warn、桌面端不落盘），所以这里只做「叶子注册」，且失败只记诊断、绝不外抛。
//
// 它**不持有可变状态**：所有状态与持久化都在 lib/runtime.js 里，
// 本文件只按 INTERFACES §3/§4 的签名调用。三个 host 模块共用同一份 runtime 单例
// （Node ESM 模块缓存按文件 URL 去重）。
//
// 全部 API 均以 0.1.7（app.asar / 运行时实测）为准，行号见各调用点上方注释。

import { randomUUID } from 'node:crypto';

import { PLAYBOOK, teamCommandLine } from './playbook.js';
import { OFFICIAL_TEAM_POLICY_SECTION } from './roster.js';
import * as runtime from './runtime.js';
import { controlToolDefinitions } from './tools.js';

export const name = '@zws/dsh-dispatch-agent-team/preset';

/**
 * preset 层需要的宿主服务；缺任何一个都不 apply（Cordis 标准 inject 语义）。
 *
 * **故意不 inject `agents` / `agentTeams`**：`@deepseek-ai/dsh-experimental-agent-team-profile`
 * 是可选 bundle，用户可以在插件页关掉它，届时域服务消失。若 preset 半硬依赖 `agentTeams`，
 * 整个 preset 半不会 apply —— 调度模式的提示词段与 `/team` 命令会**一起消失**，用户只会看到
 * 一个莫名其妙的「命令不存在」。去掉之后：提示词段与命令照常存在，`/team` 返回 runtime.enable
 * 给出的可执行报错（builder-host 在 runtime 里用 `ctx.get('agentTeams')` 判空并提示
 * 「请在插件页启用官方 agent-team 行」）。本文件也**从不**直接访问 `ctx.agents` / `ctx.agentTeams`。
 */
export const inject = ['systemPrompt'];

/** Lead 方法论的段落名；队员 agent scope 会用**同名空段**遮蔽它（INTERFACES §3.1 第 4 步）。 */
const PLAYBOOK_SECTION = 'dispatch:playbook';

/**
 * 挂载 preset 半。
 *
 * 禁止：**硬约束：preset 子树里绝对不许发布服务**——不许出现 `ctx.provide(...)` / `ctx.set(...)` /
 * 任何把自己的能力挂成宿主服务的写法。preset 是被 registry 组合进会话配置的，子树里泄漏服务
 * 会让整份 preset 以 `leakedServices` 被判为 broken 并**整份拒绝**（不只是这个插件失效）。
 * 本函数只做三种「叶子注册」：提示词段、命令、工具；可变状态与持久化全部在 lib/runtime.js 里，
 * 由 host 半持有。后人若需要共享状态，走 lib/runtime.js 的模块单例，不要新增服务。
 *
 * ── 为什么命令与开关工具**必须**注册在 preset 子树（2026-09-28 的边界修正） ──────────────
 * `dsh-commands` 的 `view(agent)` = `layers.merge(agent, …)`，也就是「全局层 + 该 agent 的
 * **作用域链**」；`dsh-tools` 的 `view(scope)` 同理。而 ctx 的方法调用会被 traceable 代理重绑到
 * **调用者自己的作用域**（`getTraceable` / `createShadowMethod`），所以：
 *   * 在这里（preset scope）注册 → 进 **本 preset 的层** → 只有选了这个 preset 的会话能看到；
 *   * 在 host 平面注册（以前的写法）→ 进**全局层** → 每一个 preset 的会话都能看到。
 * 用户要的边界正是前者：`/team` 与开关工具**只属于调度模式**，别的 preset 看不到、也调不到。
 * 现成的同类证据：`/goal`、`/compact` 就是各自 preset 行注册出来的命令，它们只在对应 preset 里出现。
 * @param ctx - preset scope 的宿主上下文。
 */
export function apply(ctx) {
  // 禁止：只允许这四种叶子注册：ctx.effect / ctx.systemPrompt.section / ctx.commands.register /
  //    ctx.tools.register。**禁止**任何服务发布（ctx.provide / ctx.set）——见上方 hard constraint。
  //    ctx 另外只作为宿主上下文原样转交给 runtime.enable/disable，不在这里探活任何域服务。

  // 1) 提示词段。整段包 try/catch：preset 子树里抛出去会让整份 preset 变 broken。
  //
  // 注意：服务必须在**进 effect 之前**用 serviceOf 取好（与下面 registerControls 同一手法）。
  // 为什么：`ctx.effect(callback)` 里 cordis 会把回调放在它自己的 fiber 上执行，回调用**属性访问**
  // 取服务时会按那个 fiber 的 inject 列表判定合法性 —— 回调和我们的 apply 不是同一个 ctx，
  // 于是 `ctx.systemPrompt` 可能抛 `cannot get property "systemPrompt" without inject`，
  // 整段提示词就**静默消失**（只有一条诊断做痕迹）。2026-09-28 的集成测试就是这么抓到的：
  // 调度模式的提示词里没有 PLAYBOOK。ctx.get 走全局 store 查询，不受 inject 约束。
  const systemPrompt = serviceOf(ctx, 'systemPrompt');
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') {
    note('宿主没有可用的 systemPrompt 服务：调度模式的 PLAYBOOK 段未注册（提示词里不会有 Lead 方法论）');
  } else {
    try {
      ctx.effect(
        () => systemPrompt.section({ name: PLAYBOOK_SECTION, order: 1, text: PLAYBOOK }),
        'dispatch-preset: playbook',
      );
    } catch (error) {
      note(`preset 子树注册 dispatch:playbook 段失败：${errorText(error)}`);
    }
  }

  // 2) 控制面：`/team` + enable_agent_team / disable_agent_team —— **只在本 preset 里可见**。
  //    走 ctx.inject 是因为 commands / tools 由 dsh-base 在宿主平面提供：这里等它们就绪再注册，
  //    注册仍然落在 preset 层（回调 ctx 继承本作用域）。没有 ctx.inject 的运行时退回立即注册。
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['commands', 'tools'], (scoped) => {
        try {
          const control = registerControls(scoped);
          for (const diagnostic of control.diagnostics) note(`控制面注册降级：${diagnostic}`);
          // 「注册成功」是正常事实 → 信息通道；否则页面会在一切正常时按故障样式报出来。
          if (control.ok === true) note(`调度模式控制面已注册（仅本 preset 可见）：${control.registered.join(', ')}`, 'info');
        } catch (error) {
          note(`调度模式控制面注册失败（/team 将不可用）：${errorText(error)}`);
        }
        // 3) 官方策略段的遮蔽：同样只落在这个 preset 的层里（见 suppressOfficialTeam 的长注释）。
        try {
          const suppression = suppressOfficialTeam(scoped);
          for (const message of suppression.notes) note(message);
          if (suppression.applied === true) {
            note(`已在本 preset 遮蔽官方 ${OFFICIAL_TEAM_POLICY_SECTION} 段（官方行若已关闭则是空操作）`, 'info');
          }
        } catch (error) {
          note(`遮蔽官方策略段失败（官方 Team Lead 方法论可能进本模式的提示词）：${errorText(error)}`);
        }
      });
    } else {
      const control = registerControls(ctx);
      for (const diagnostic of control.diagnostics) note(`控制面注册降级：${diagnostic}`);
    }
  } catch (error) {
    note(`调度模式控制面注册无法排队（/team 将不可用）：${errorText(error)}`);
  }
}

/**
 * 在本 preset 的作用域里**遮蔽官方 `team:policy` 策略段**（同名空段，`renderPrompt` 丢空段）。
 *
 * ── 注意：为什么这里**不**去 restrict 官方那九个工具（2026-09-28 实测，用户看到 9 条红字） ────
 * 官方 `tool-agent-team` **不是**把九个工具注册到全局层，而是给**每一个 live agent** 装进**它自己的
 * agent 作用域**：
 *   * `dsh-experimental-tool-agent-team/lib/index.js:539-546` 的 `maybeInstall`：
 *     `tryMembership(agent) === undefined` 才跳过；而
 *     `dsh-experimental-agent-team/lib/index.js:397-426` 的 `tryMembership` 对**任意非子代理 agent**
 *     都返回 `{root: agent, role: "lead", name: "lead"}` —— 所以每个会话都会装上；
 *   * 同一份源码 :225 的注释原话：「Team tools are registered only in an exact Agent scope」（:229 是近义句）。
 * 于是：
 *   * `tools.restrict()` 只认**全局层**的名字（官方报错原文：`names unknown global tool "x"`），
 *     在 preset 作用域里逐个 deny 那九个名字 **必然全部失败** —— 那就是那 9 条红字；
 *   * 而且 restrict 的语义是「只过滤继承面，从不影响本作用域自己注册的东西」，agent 自己那一层
 *     永远过滤不掉。
 * **正确做法**：在 **profile 的 patch 层**把官方 `tool-agent-team` 行整个关掉
 * （`tools/repair.cjs --apply` 维护，顺序无关；见 MAINTAINER-NOTES.md §8.6/§8.7）。这两个集合同名、同层，
 * 不可能共存：官方那一行开着时，本插件的九个工具会因 `already registered in this scope` 装不上，
 * 角色/模型参数全部丢失（`lib/runtime.js` 的 `installTeamTools` 有明确的故障诊断）。
 *
 * 段遮蔽仍然保留：它是**幂等且无害**的（官方行关了就是多注册一个空段，被 renderPrompt 丢掉）。
 * @param scoped - preset 作用域的 ctx（已 inject commands/tools）。
 * @returns {applied:boolean, notes:string[]}
 */
function suppressOfficialTeam(scoped) {
  const notes = [];
  const systemPrompt = serviceOf(scoped, 'systemPrompt');
  if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
    try {
      systemPrompt.section({ name: OFFICIAL_TEAM_POLICY_SECTION, order: runtime.TEAM_POLICY_ORDER, text: '' });
      return { applied: true, notes };
    } catch (error) {
      notes.push(`清空官方 ${OFFICIAL_TEAM_POLICY_SECTION} 段失败（官方方法论仍会进本模式的提示词）：${errorText(error)}`);
    }
  } else {
    notes.push(`该作用域没有 systemPrompt：官方 ${OFFICIAL_TEAM_POLICY_SECTION} 段仍会进本模式的提示词`);
  }
  return { applied: false, notes };
}

/**
 * 记一条**注册期**记录：绝不向外抛（preset 子树里抛错会让整份 preset 变 broken）。
 * @param message - 任意可读文本。
 * @param kind - `'info'` = 正常事实（信息通道）；省略 = 故障通道。
 */
function note(message, kind) {
  try {
    runtime.recordBootNote(message, kind);
  } catch {
    /* 诊断通道自身不可用时也不能抛 */
  }
}

/**
 * 取一个宿主服务：**优先 `ctx.get(name)`**，退回属性访问，两条都失败就返回 undefined。
 *
 * 为什么不能直接写 `ctx.commands`：属性访问要求该服务出现在**本 fiber 的 inject 列表**里，
 * 否则抛 `cannot get property "commands" without inject`（cordis 的 reflect 代理：在祖先 fiber
 * 的 store 里命中不了就抛）。宿主平面上的 `commands` / `tools` 由**兄弟 fiber** 提供，从本插件
 * 的 ctx 往上走找不到它 —— 2026-09-28 实际就是这么坏的（详见 lib/index.js 控制面注册处的注释）。
 * `ctx.get` 走全局 store 查询，不受 inject 约束。
 * @param ctx - 任意作用域 ctx。
 * @param name - 服务名。
 * @returns 服务实例或 undefined。
 */
function serviceOf(ctx, name) {
  if (ctx === undefined || ctx === null) return void 0;
  if (typeof ctx.get === 'function') {
    try {
      const value = ctx.get(name);
      if (value !== undefined) return value;
    } catch {
      /* get 本身失败时退回属性访问；属性访问失败也返回 undefined */
    }
  }
  try {
    return ctx[name] ?? void 0;
  } catch {
    return void 0;
  }
}

/**
 * 注册模型/人类可见的**控制面**：一个 `/team` 命令（**没有** `/team-off`）与
 * `enable_agent_team` / `disable_agent_team` 两个工具。
 *
 * 注意：调用者必须是**调度模式的 preset scope**：这些注册会落在调用者所在的层，
 * 因此只有该 preset 的会话可见（见 apply() 上方的边界说明）。宿主平面调用会变成「所有 preset 共享」，
 * 那正是 2026-09-28 修掉的越界行为。
 * 逐项包 try/catch：任何一项注册失败都只记诊断，绝不让调用方（preset 子树）抛错。
 *
 * @param ctx - 宿主平面 ctx（需要有 commands / tools 服务，用 serviceOf 宽容取用）。
 * @returns {ok:boolean, registered:string[], diagnostics:string[]}
 */
export function registerControls(ctx) {
  const registered = [];
  const diagnostics = [];
  const injectUserMessage = typeof runtime.inject === 'function' ? runtime.inject : injectUserText;

  const note = (message) => {
    diagnostics.push(message);
    try {
      runtime.recordBootNote(message);
    } catch {
      /* 诊断通道不可用时不抛 */
    }
  };

  const commands = serviceOf(ctx, 'commands');
  if (commands === undefined || typeof commands.register !== 'function') {
    // 以前这里不可能是 undefined —— 它是**抛异常**，被 try/catch 吞成一条 console warn，
    // 于是「/team 不存在、开关工具也不存在」在现场完全没有痕迹。
    // 现在它会变成一条能进状态文件的诊断。
    note('ctx.commands 不可用：/team 未注册（宿主平面缺少 commands 服务？）');
  } else {
    // 只有一个命令：`/team`。**没有** `/team-off`（用户 2026-09-28 明确要求去掉）：
    // 关闭团队交给模型工具 `disable_agent_team`，用户用自然语言说「关掉团队」即可，不需要记第二个斜杠命令。
    const definitions = [
      {
        name: 'team',
        description: '智能体团队（仅调度模式）：为当前会话开启 Agent Teams 协作。关闭：直接说「关掉团队」，Lead 会调用 disable_agent_team。',
        input: { hint: '可选：补充你的意图，例如「只做调研」「先审计划」' },
        handler: (invocation) => runEnable(ctx, invocation, injectUserMessage),
      },
    ];
    for (const definition of definitions) {
      try {
        ctx.effect(() => commands.register(definition), `dispatch-control: /${definition.name}`);
        registered.push(`command:${definition.name}`);
      } catch (error) {
        note(`注册命令 /${definition.name} 失败：${errorText(error)}`);
      }
    }
  }

  const tools = serviceOf(ctx, 'tools');
  if (tools === undefined || typeof tools.register !== 'function') {
    note('ctx.tools 不可用：enable_agent_team / disable_agent_team 未注册（宿主平面缺少 tools 服务？）');
  } else {
    let definitions;
    try {
      definitions = controlToolDefinitions({ runtime });
    } catch (error) {
      note(`构建开关工具定义失败：${errorText(error)}`);
      definitions = [];
    }
    for (const definition of definitions) {
      try {
        ctx.effect(() => tools.register(definition), `dispatch-control: tool ${definition.name}`);
        registered.push(`tool:${definition.name}`);
      } catch (error) {
        note(`注册工具 ${definition.name} 失败：${errorText(error)}`);
      }
    }
  }

  return { ok: diagnostics.length === 0, registered, diagnostics };
}

/**
 * 把一段文本作为**一条 user 消息**追加到指定 agent，并在它空闲时唤醒它。
 *
 * 注意：现在**只有 `/team` 命令路径**用它（`lib/tools.js` 的两个开关工具已改为把状态说明放进
 * 工具返回值，不再注入消息）：原因见 `lib/playbook.js` 文件末的长注释 —— `followup` 进的是
 * Session 的 `next-turn` 收件箱，而客户端 **QueueDock 读的就是 `next-turn`**，
 * 于是「注入」会变成用户输入框上方一条**排队的消息**，用户还得多点一次「插入」。
 * 命令路径必须注入（否则用户打的字永远进不了模型上下文），而那条正文就是**用户自己的原文**
 * （`teamCommandLine`），排队也符合 DSH 对「忙碌时发送」的既有语义。
 *
 * @param agent - 目标 agent；必须有 followup()。
 * @param text - 非空字符串。
 */
function injectUserText(agent, text) {
  if (agent === null || agent === undefined || typeof agent.followup !== 'function') {
    throw new TypeError('dispatch team: 无法注入 user 消息——没有拿到带 followup() 的 agent');
  }
  if (typeof text !== 'string' || text === '') {
    throw new TypeError('dispatch team: 注入内容必须是非空字符串');
  }
  // agent.followup(input) => send(input, 'next-turn', true)：排到下一轮并唤醒
  // （dsh-agent-loop/lib/index.js:806-808；send 本体 :800-805）。空闲时它会开启新 turn。
  agent.followup(teamUserMessage(text));
}

/**
 * 自造与官方 createUserMessage **同形**的 user 消息对象。
 *
 * 为什么不 import `@deepseek-ai/dsh-llm` 的 createUserMessage：
 *   1. 本插件源码目录（`~/.dsh/plugins/dsh-dispatch-agent-team/lib`）解析不到它
 *      （实测 `import.meta.resolve('@deepseek-ai/dsh-llm')` → ERR_MODULE_NOT_FOUND）；
 *   2. 若插件被装进 profile，能解析到的那份是 junction 到**全局 CLI 0.1.5** 的副本
 *      （profiles/node_modules/@deepseek-ai/dsh-llm → AppData/Roaming/npm/.../@deepseek-ai/dsh/
 *      node_modules/@deepseek-ai/dsh-llm，version 0.1.5-rc.2），与运行中的 0.2.0-rc.1 不一致；
 *   3. 静态 import 解析失败发生在**模块加载期**，会连带打掉命令与配置页。
 *
 * 形状依据（0.1.7）：
 *   - MessageBase = {id: MessageId, content: readonly ContentBlock[], source: MessageSource}
 *     —— dsh-llm/lib/typert.host.js:401
 *   - MessageRoleMap.user = UserMessage 且 UserMessage extends MessageBase 带 role:'user'
 *     —— typert.host.js:409 / :569
 *   - MessageSourceMap.user = { kind: 'user' } —— typert.host.js:417
 *   - TextBlock = { type: 'text', text: string } —— typert.host.js:525
 *   - createUserMessage(input) = createMessage({...input, role:'user'})，
 *     createMessage = deepFreeze(structuredClone({...input, id: brandString(randomUUID())}))
 *     —— dsh-llm/lib/types/message.js:34-58
 *   - MessageId = Branded<'MessageId'> 是**纯类型品牌**，运行时不校验
 *     （typert.host.js:405；dsh-llm/lib/types/brand.js:32 原话 "no validation is performed"），
 *     所以明文 uuid 字符串即可；该 id 只用于 inbox 去重（agent-loop/lib/index.js:191-193）。
 *
 * @param text - 消息正文。
 * @returns 冻结的 user 消息。
 */
function teamUserMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'user' }),
  });
}

/**
 * `/team`：开启本会话团队，成功后把**用户原文那一行**（`teamCommandLine`）注入成一条 user 消息，
 * 让 Lead 按团队方式继续。注意：只有这条路径注入（用户打的字否则进不了模型上下文）；
 * 两个开关工具**一条消息都不注入**（原因见 lib/playbook.js 文件末的长注释）。
 * @param ctx - preset scope 上下文（runtime 的宿主 ctx 参数）。
 * @param invocation - 命令调用对象。
 * @param inject - 注入器 `inject(agent, text)`（与开关工具共用同一个）。
 * @returns CommandResult：命令 handler 必须返回 {kind:'success'|'error', text}
 *   （dsh-commands/lib/index.js:184-204：缺 kind 直接 TypeError；error.text 必须非空）。
 */
async function runEnable(ctx, invocation, inject) {
  const agent = invocation?.agent;
  if (agent === null || agent === undefined) {
    return { kind: 'error', text: '无法定位当前会话（命令未携带 agent），智能体团队未开启。' };
  }

  // runtime.enable(ctx, agent, {source, rawInput}) —— INTERFACES §3；
  // -> {ok, enabled, member, diagnostics}。
  let result;
  try {
    result = await runtime.enable(ctx, agent, { source: 'command', rawInput: invocation.rawInput });
  } catch (error) {
    return { kind: 'error', text: `开启智能体团队失败：${errorText(error)}` };
  }
  if (result === null || result === undefined || result.ok !== true) {
    return { kind: 'error', text: `开启智能体团队失败：${diagnosticsText(result)}` };
  }

  const notice = tryInject(agent, teamCommandLine(invocation.rawInput), inject);
  // 成功时**故意不给 text**：客户端只在有 text 时显示「>_ team · <text>」这一行，
  // 没有 text 就退回它自己的中性文案（GenericCommandCard 的 command.done，dsh-client-ui-chat）。
  // 用户 2026-10-01 的要求：开团之后不要再来一句「智能体团队已开启：队员角色表见系统提示…」。
  return { kind: 'success', ...(notice === '' ? {} : { text: notice.trim() }) };
}

/** 注入失败不回滚已经生效的开关状态，而是把失败明确写进命令结果（不静默吞错）。 */
function tryInject(agent, text, inject) {
  try {
    inject(agent, text);
    return '';
  } catch (error) {
    return `\n注意：团队状态已改变，但没能向本会话注入后续指令（${errorText(error)}）；请你手动说明团队已开/已关。`;
  }
}

/** 把 runtime 返回的 diagnostics 渲染成一句可读文本。 */
function diagnosticsText(result) {
  const diagnostics = Array.isArray(result?.diagnostics) ? result.diagnostics.filter((item) => typeof item === 'string' && item !== '') : [];
  return diagnostics.length === 0 ? '未提供诊断信息。' : diagnostics.join('；');
}

/** 渲染任意抛出值，不用 String() 去碰不可渲染对象。 */
function errorText(error) {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return '<无法渲染的抛出值>';
  }
}