// 调度模式智能体团队 —— 浏览器半（手写 lazy-CJS bundle，无构建步骤）。
//
// 挂载点：插件 →「已安装」→「调度模式智能体团队」详情页。
// 槽位 `plugins.bundle.config`，key = 本包 package.json 的 name。
// 基本信息（图标/标题/版本/包名/描述/启用开关）由官方 plugin-manager 页面白送，
// 本文件只做：每个角色一行的「模型 / 思考强度」+ 保存/放弃/重载/恢复默认 + 诊断与状态提示。
// 角色数量不写死在这里 —— 角色表由宿主路由的 `get` 返回（lib/roster.js 是唯一真值）。
//
// 运行时证据（行号取自 0.1.7 解包源码快照，不猜 API；桌面端 0.2.0-rc.1 上本页面实测可用，
// drift-check 会对着新 app.asar 继续校验 plugins.bundle.config 槽位）：
//   * 槽位声明  SLOTS：dsh-client-ui-plugin-manager/lib/client.js:30-34
//               children 声明：同文件 :3449-3452；:3470 注册页面组件
//   * 本槽位渲染：同文件 :1973
//               renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })
//   * 组件 props：dsh-client-ui-plugin-manager/README.md:54-62 的注册示例 —— ({ t, view })
//               「A bundle's browser half registers the same way」同段
//   * 字典注册：dsh-experimental-client-ui-agent-team/lib/client.js:470
//               ctx.effect(() => ctx.locale.register(NS, { zh, en }), ...)  → :495 locale: NS
//   * 文案缺键时官方查找链「…before showing the key itself」：
//               dsh-client-locale/lib/types/client/index.d.ts:86-90
//               register(ns, dicts)/bind：同文件 :188-215
//   * lazy-CJS factory 头与裸包名注册：某个第三方插件/lib/client.js:1-9, :488-494
//   * 宿主路由 apiCall + CSRF 头 + 注入 CSS：同文件 :90-101, :68-77
//
// 契约：数据与写入全部走宿主自己的路由 POST /zws-dispatch-agent-team/api（同源）。
// 本文件不 import 任何 dsh 包、不注入 ui-primitives、不读 context.mutate。
// 注意：注册必须在**单条语句内**完成，且不得有任何顶层声明。
// 多个 client bundle 会被客户端拼成**一个脚本**执行
// （实测 URL：/plugins/??@deepseek-ai/dsh-client-file-upload/client.js,…,某个第三方插件/client.js,@zws/dsh-dispatch-agent-team/client.js,…），
// 所以顶层 `const`/`let`/`function` 会与别的 bundle 撞名。
// 实测事故（2026-09-27）：本文件原用 `const factory = (require) => {…}` + 末尾 `load({ factory })`，
// 与 某个第三方插件 的同名顶层 `const factory` 撞名 →
// `Uncaught SyntaxError: Identifier 'factory' has already been declared` →
// 整个拼合脚本（**含官方 bundle**）一起失败 → 应用无法启动。
// 官方 bundle 的写法就是「内联匿名箭头」，照它写，顶层零绑定。
window.__ModuleLoader__.load({
  id: '@zws/dsh-dispatch-agent-team',
  factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports
  Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
  const React = require('react')

  /** 宿主路由（lib/index.js 用 ctx.webServer.register 注册的 exact path）。 */
  const API_PATH = '/zws-dispatch-agent-team/api'
  /** 跨站（CSRF）闸门头：跨源页面无法在不触发 preflight 的情况下带上它。 */
  const PLUGIN_HEADER = 'zws-dispatch-agent-team'
  /** 本包 UI 文案的 locale 命名空间（随 slots.register 的 locale 选项传给组件）。 */
  const NS = 'dispatchAgentTeam'
  /** 不透明模型键的分隔符（INTERFACES.md §6 指定），provider/model 里都不会出现它。 */
  const SEP = '\u0000'
  // 统一选择控件的「各角色当前不一致」占位值。含分隔符，不可能与真实模型键撞车。
  const MIXED_KEY = SEP + 'mixed'

  // ── 宿主桥：官方聊天界面的同一份对象层 ─────────────────────────────────────
  // 弹窗要与官方聊天界面**等价**，就得吃同一份数据、走同一条回答通道，而不是自己
  // 再读一遍会话日志。两件事都从这个桥进（用户 2026-10-13 的两条报障）：
  //
  //   ① 实时流：sessions 服务（ClientSessions）retain 目标会话之后，
  //      binding.session.eventSource 就是**官方对话自己在用的那份连续事件窗口**。
  //      它里面除了持久事件，还含 transient 的 assistant/live-chunk 行 ——
  //      证据：dsh-api-session-controller/lib/client.js:428-432 对每个打开的会话都
  //      无条件带 assistantStream: true；:2128-2131 把每一个 token 折成 transient 行
  //      并 eventSource.append()；:1129-1209 这个类每次变更都同步 publish。
  //      而旧的 team-conversation 读的是**持久日志**，assistant/message 只在整步结算
  //      时才落盘 ⇒ 用户看到的「思考要等到提问时才一次性涌出」。
  //
  //   ② 提问卡：uiSession.sessionStatus 的快照里带着官方那张 PendingQuestion
  //      （dsh-client-ui-session/lib/client.js:148-156 暴露 getSnapshot/subscribe；
  //       dsh-client-ui-user-questions/lib/client.js:1900 把卡注册进这个域）。
  //      卡上的 answer() 就是官方 composer 提交用的**同一个方法**（同文件 :396-406）：
  //      timed 未超时 → 前端 waterfall.resolve（阻塞中的工具调用当场拿到结果、官方
  //      卡片自己关）；continued → userQuestions.answer RPC。所以从弹窗点「提交回答」
  //      与在官方界面点的是同一件事 —— 不再是消息投递 / 插话。
  //
  // 取服务一律走 ctx.reflect.get(name, false)：cordis 的属性访问要求服务在本 fiber
  // 的 inject 列表里（cordis/lib/index.js:673-698 抛 cannot get property "x" without
  // inject，而可选链捕获不了抛错的 getter —— 这个坑本仓库踩过两次），reflect.get 是
  // 官方逃生口（同文件 :755-765「Read a service from the store without the inject
  // requirement」）。全部可选：拿不到桥就退回原来的日志轮询（功能不丢，只是不实时），
  // 绝不抛错、绝不让画布打不开。
  const bridge = { ctx: null, resolved: new Map() }
  /**
   * retain 的来源标签。**绝不能复用 mainView** —— 那是「主视图」的归属，拿它 retain
   * 队员会话会把用户正在看的聊天页切走（dsh-api-session-controller/lib/client.js:283
   * 的 publishMain 就认这个键）。
   */
  const BRIDGE_RETAIN_SOURCE = 'dispatchAgentTeamWorkspace'

  /** 惰性取一个宿主服务。取不到返回 undefined；不缓存失败（官方 bundle 可能晚于我们加载）。 */
  function bridgeService(name) {
    const ctx = bridge.ctx
    if (ctx === null || ctx === undefined) return undefined
    const hit = bridge.resolved.get(name)
    if (hit !== undefined) return hit
    let found
    try {
      const reflect = ctx.reflect
      found = reflect !== undefined && reflect !== null && typeof reflect.get === 'function'
        ? reflect.get(name, false)
        : undefined
    } catch { found = undefined }
    if (found !== undefined && found !== null) bridge.resolved.set(name, found)
    return found
  }

  /**
   * 借一个会话的活体对象层（与官方打开该会话时同一条路径）。
   *
   * ⚠️ 只 retain、不 await reference.ready：retain() 已经**同步**拿到 binding
   * （get binding() 只在 record.live === false 时抛，dsh-api-session-controller/
   * lib/client.js:3110-3113），而 ready 要等事件流 open 完成 —— 弹窗不该被网络挂住。
   * open 完成后 eventSource 自己会 publish 一次 replace，覆盖层那时再重画。
   *
   * @param {string} targetId - 会话 id（Lead 带 session- 前缀、队员是裸 uuid，两种都试）。
   * @returns {object|null} {sessionId, eventSource, release}
   */
  function bridgeRetain(targetId) {
    const sessions = bridgeService('sessions')
    if (sessions === undefined || typeof sessions.retain !== 'function') return null
    const id = String(targetId === undefined || targetId === null ? '' : targetId)
    if (id === '') return null
    const forms = [id]
    if (id.indexOf('session-') === 0) forms.push(id.slice(8)); else forms.push('session-' + id)
    for (const form of forms) {
      let reference
      try {
        // 队员会话：官方 openTeammate 用的是「父+子+mode」的地址（dsh-experimental-
        // client-ui-agent-team/lib/client.js:485-489）。查得到地址就按地址 retain，
        // 查不到退回裸 id（Lead 走这条）。
        let target = form
        try {
          const addr = typeof sessions.subagentAddress === 'function' ? sessions.subagentAddress(form) : undefined
          if (addr !== undefined && addr !== null) target = addr
        } catch { /* 退回裸 id */ }
        reference = sessions.retain(target, { source: BRIDGE_RETAIN_SOURCE })
      } catch { reference = undefined }
      if (reference === undefined || reference === null) continue
      let binding
      try { binding = reference.binding } catch { binding = undefined }
      if (binding === undefined || binding === null || binding.eventSource === undefined) {
        try { reference.release() } catch { /* 已经掉了 */ }
        continue
      }
      // ready 的失败在官方构造里已经 catch 过（:3108），这里再挂一层防未处理拒绝。
      try { if (reference.ready !== undefined) reference.ready.catch(() => {}) } catch { /* 非 promise */ }
      return {
        sessionId: reference.sessionId,
        eventSource: binding.eventSource,
        // ⚠️ session 也带出来（2026-10-14）：**停止生成**的 cancel() 就在它身上，
        // 而 binding 已经在我们手里 —— 官方就是这么走的：
        //   dsh-client-ui-conversation/lib/client.js:18022-18024
        //     const stop = (sessionId) => { scopedConversation(sessions, sessionId).cancel().catch(…) }
        //   同文件 :3666-3669 cancel() → this.scopedSession("cancel").cancel()
        //   dsh-api-session-controller/lib/client.js:1804-1815
        //     有 subagent 地址 → remote.subagents.interruptByParent(child, parent, 'continuable')
        //     否则        → remote.session.cancel(...)
        // 队员会话同样成立：上面已经按 sessions.subagentAddress(form) 寻过址，
        // 拿到的就是官方那条 interruptByParent 路径。
        session: binding.session,
        release: () => { try { reference.release() } catch { /* 重复释放无害 */ } },
      }
    }
    return null
  }

  /**
   * 找官方为某次 ask_user_question 挂着的提问卡（弹窗回答必须走它才与官方等价）。
   * @param {string} sessionId - 提问那个会话的客户端 id。
   * @param {string} callId - ask_user_question 的工具调用 id。
   * @returns {object|null} PendingQuestion 卡（带 answer()）；没有则 null。
   */
  function bridgeQuestionCard(sessionId, callId) {
    const ui = bridgeService('uiSession')
    const status = ui === undefined || ui === null ? undefined : ui.sessionStatus
    if (status === undefined || status === null || typeof status.getSnapshot !== 'function') return null
    let snapshot
    try { snapshot = status.getSnapshot() } catch { return null }
    if (snapshot === undefined || snapshot === null || typeof snapshot.get !== 'function') return null
    const ids = [sessionId]
    const sid = String(sessionId === undefined || sessionId === null ? '' : sessionId)
    if (sid !== '') { if (sid.indexOf('session-') === 0) ids.push(sid.slice(8)); else ids.push('session-' + sid) }
    for (const id of ids) {
      let row
      try { row = snapshot.get(id) } catch { row = undefined }
      const card = row === undefined || row === null ? undefined : row.pendingInteraction
      // 卡按 tool call 建（PendingQuestion.keyOf(sessionId, callId)）。callId 对不上
      // 就不是这一次提问，**绝不能顺手回答** —— 那会替用户答掉另一个问题。
      // ⚠️ 还必须先认 kind（2026-10-14 审查 P0-4）：官方挂进**同一个** pending-interaction
      // 快照的不止提问卡 —— 审批卡 PendingApproval 也带 sessionId / callId / answer()
      // （dsh-client-ui-approval/lib/client.js:178-220），而它的 answer(outcome) 期望的是
      // 'allowed-once' | 'rejected'（dsh-user-approval/lib/index.js:30-35 的 OUTCOMES）。
      // 把 {answers:[…]} 喂给它就是喂错类型。默认档（approval: never → 宿主直接 return
      // 'rejected'，同文件 :175）今天撞不上，但判据不能指望配置永远不变。
      if (card !== undefined && card !== null && card.kind === 'question'
        && typeof card.answer === 'function' && card.callId === callId) return card
    }
    return null
  }

  /**
   * 查一次 ask_user_question 的**结算结果**。弹窗回答之后必须验一次，
   * 不能信 answer() 的 resolve。
   *
   * 为什么必须验：官方卡的 answer() 只是 `waterfall.resolve(answer)`
   * （dsh-client-ui-user-questions/lib/client.js:396-406），而 settlePendingComposer
   * 只 catch **同步**抛错；真正的载荷校验发生在回传宿主时
   * （dsh-api-gateway/lib/client.js:880）—— 也就是说 answer() **永远 resolve**，
   * 哪怕这个答案把工具调用当场打死。实测 session-00001004：seq 22 就是
   * isError:true 的 tool/result，而弹窗当时显示「已通过官方提问卡回答」。
   *
   * @param {object|null} feed - bridgeRetain 的返回值（有 eventSource 才查得到）。
   * @param {string} callId - ask_user_question 的工具调用 id。
   * @returns {'unknown'|'answered'|'continued'|'dead'} answered = 拿到答案批次；
   *   continued = 提问已超时、转成 continued 态（result 是 pending:true）。
   *     这时 answer() 走的是它内部的 RPC 分支（同文件 :401-404），那条**会**回报
   *     accepted/false，所以不必再等结算；
   *   dead = 这次调用以 isError 结算（提问已死，绝不能报「已回答」）；
   *   unknown = 还没结算或读不到。
   */
  function bridgeQuestionOutcome(feed, callId) {
    if (feed === null || feed === undefined) return 'unknown'
    const es = feed.eventSource
    if (es === undefined || es === null || typeof es.getSnapshot !== 'function') return 'unknown'
    let snapshot
    try { snapshot = es.getSnapshot() } catch { return 'unknown' }
    const entries = snapshot === undefined || snapshot === null ? null : snapshot.entries
    if (!Array.isArray(entries)) return 'unknown'
    for (const entry of entries) {
      const ev = entry === null || typeof entry !== 'object' ? null : entry.event
      if (ev === null || ev === undefined || ev.type !== 'tool/result') continue
      const msg = ev.data === null || typeof ev.data !== 'object' ? null : ev.data.message
      if (msg === null || msg === undefined) continue
      const cid = typeof msg.toolCallId === 'string' ? msg.toolCallId
        : (msg.source !== null && typeof msg.source === 'object'
          && typeof msg.source.callId === 'string' ? msg.source.callId : '')
      if (cid !== callId) continue
      // 官方投影的同款判据（dsh-user-questions/lib/index.js:229）：
      // isError ⇒ 这批答案没有被接受，这次提问已经死了。
      if (msg.isError === true) return 'dead'
      const blocks = Array.isArray(msg.content) ? msg.content : []
      for (const b of blocks) {
        if (b === null || typeof b !== 'object' || b.type !== 'text' || typeof b.text !== 'string') continue
        let parsed
        try { parsed = JSON.parse(b.text) } catch { continue }
        if (Array.isArray(parsed === null || parsed === undefined ? null : parsed.answers)) return 'answered'
        // 超时挂起（pending:true）：提问已经转成 continued 态。这个标记在用户回答
        // **之前**就在日志里了，所以不能当「还没结算」继续等 —— 那会白转 2 秒。
        if (parsed !== null && typeof parsed === 'object' && parsed.pending === true) return 'continued'
      }
      return 'answered'
    }
    return 'unknown'
  }

  /**
   * 取官方那张**计划审批**卡（2026-10-14，审查 P0-3）。
   *
   * 为什么不能复用 bridgeQuestionCard：那张桥按 callId 精确匹配（同文件 :162-181，
   * 「callId 对不上就不是这一次提问，绝不能顺手回答」）。而计划审批那张卡**没有 callId** ——
   * dsh-plan-mode/lib/index.js:261-282 调的是 ask({questions, agent, signal})，不带 wait，
   * 卡由 QuestionCards.ensure(sessionId, questions, undefined) 创建，官方注释写得很清楚：
   * 「A request without a call id always gets a fresh card」（dsh-client-ui-user-questions/
   * lib/client.js:1668-1677）。所以按 callId 永远取不到它，弹窗里的 Approve 只能退成
   * 消息投递，而官方那张卡继续挂着 —— 正是用户 2026-10-13 报过的那个症状。
   *
   * 判据因此换成官方自己那个判别字段 `kind === 'plan-review'`（PendingQuestion 构造里
   * 由 planReviewOf(questions) 定，同文件 :185），不是猜 header 文案。每个会话在
   * pending-interaction 快照里**只有一张**卡（uiSession 按 precedence 取最大者，
   * dsh-client-ui-session/lib/client.js:299-313；plan-review 是 2、question 是 1），
   * 所以「同会话 + kind 对得上」就是那一张，不存在替用户答掉别的问题。
   * @param {string} sessionId - 提问那个会话的客户端 id。
   * @returns {object|null} PendingQuestion 卡（带 answer()）；没有则 null。
   */
  function bridgePlanReviewCard(sessionId) {
    const ui = bridgeService('uiSession')
    const status = ui === undefined || ui === null ? undefined : ui.sessionStatus
    if (status === undefined || status === null || typeof status.getSnapshot !== 'function') return null
    let snapshot
    try { snapshot = status.getSnapshot() } catch { return null }
    if (snapshot === undefined || snapshot === null || typeof snapshot.get !== 'function') return null
    const ids = [sessionId]
    const sid = String(sessionId === undefined || sessionId === null ? '' : sessionId)
    if (sid !== '') { if (sid.indexOf('session-') === 0) ids.push(sid.slice(8)); else ids.push('session-' + sid) }
    for (const id of ids) {
      let row
      try { row = snapshot.get(id) } catch { row = undefined }
      const card = row === undefined || row === null ? undefined : row.pendingInteraction
      if (card === undefined || card === null) continue
      if (card.kind === 'plan-review' && typeof card.answer === 'function') return card
    }
    return null
  }

  /**
   * 计划审批的结算判决（approved / rejected / unknown）。
   *
   * 为什么不能直接用 bridgeQuestionOutcome：它把 isError 一律判成 'dead'（提问被打死）。
   * 对计划审批来说那是**正常结果** —— 用户选 Keep planning 时官方就是抛错结算的
   * （dsh-plan-mode/lib/index.js:289-292，正文 'The user chose to keep planning…'）。
   * 照 'dead' 报就会把「用户拒了这版计划」说成「你的回答出错了」，那是假话。
   * @param {object|null} feed - bridgeRetain 的返回值。
   * @param {string} callId - exit_plan_mode 那次调用的 callId（日志里的真值）。
   * @returns {'approved'|'rejected'|'unknown'}
   */
  function bridgePlanReviewOutcome(feed, callId) {
    if (feed === null || feed === undefined) return 'unknown'
    const es = feed.eventSource
    if (es === undefined || es === null || typeof es.getSnapshot !== 'function') return 'unknown'
    let snapshot
    try { snapshot = es.getSnapshot() } catch { return 'unknown' }
    const entries = snapshot === undefined || snapshot === null ? null : snapshot.entries
    if (!Array.isArray(entries)) return 'unknown'
    for (const entry of entries) {
      const ev = entry === null || typeof entry !== 'object' ? null : entry.event
      if (ev === null || ev === undefined || ev.type !== 'tool/result') continue
      const msg = ev.data === null || typeof ev.data !== 'object' ? null : ev.data.message
      if (msg === null || msg === undefined) continue
      const cid = typeof msg.toolCallId === 'string' ? msg.toolCallId
        : (msg.source !== null && typeof msg.source === 'object' && typeof msg.source.callId === 'string'
          ? msg.source.callId : '')
      if (cid !== callId) continue
      // 批准走 answers 批次（:287-292 判 selected[0] === 'Approve'）；拒绝走 isError。
      if (msg.isError === true) return 'rejected'
      const blocks = Array.isArray(msg.content) ? msg.content : []
      for (const b of blocks) {
        if (b === null || typeof b !== 'object' || b.type !== 'text' || typeof b.text !== 'string') continue
        let parsed
        try { parsed = JSON.parse(b.text) } catch { continue }
        const batch = Array.isArray(parsed?.answers) ? parsed.answers : []
        const hit = batch.find((a) => a !== null && typeof a === 'object' && a.id === 'plan-review')
        const picked = Array.isArray(hit?.selected) ? hit.selected : []
        if (picked.length === 1 && picked[0] === 'Approve') return 'approved'
        if (hit !== undefined) return 'rejected'
      }
      return 'unknown'
    }
    return 'unknown'
  }

  /** 订阅「官方提问卡挂着没有」的变化，让弹窗卡片立刻跟上，不等轮询。 */
  function bridgeWatchQuestions(listener) {
    const ui = bridgeService('uiSession')
    const status = ui === undefined || ui === null ? undefined : ui.sessionStatus
    if (status === undefined || status === null || typeof status.subscribe !== 'function') return () => {}
    let stop = () => {}
    try { stop = status.subscribe(listener) } catch { return () => {} }
    return typeof stop === 'function' ? stop : () => {}
  }

  // ── 流式覆盖层（问题 2 的修法）─────────────────────────────────────────────
  // 把 eventSource 窗口里**还没结算**的那段（transient 的 assistant/live-chunk）折成
  // 对话行，接在宿主给的持久行后面。为什么只折 transient：
  //   * dsh-api-session-controller/lib/client.js:2128-2131 —— 每一个 token 折成一行
  //     transient 并 eventSource.append()，它就是官方界面正在打的那些字；
  //   * 同文件 :1192-1205 settleAssistant() 在 step/end 时把这些 transient 行**原地删掉**
  //     换成持久的 assistant/message ⇒ 快照里活着的 transient 行恰好等于「还没进正文的」；
  //   * 但成功的 attempt 的 transient 行会**保留到 step/end**（:1502-1509 retainedAttempt），
  //     期间持久的 assistant/message 也已经 append 进同一份快照 —— 所以必须按 (turn, step)
  //     把「已结算」的剔掉，否则同一段正文显示两遍。
  // 分块规则照抄官方 dsh-llm 的 BlockAssembler（lib/types/assembler.js:33-84）：按
  // chunk.index 分块，block-start 定类型，text/reasoning/tool-call delta 累加。

  /**
   * @param {Array} entries - eventSource 快照的 entries（durable 与 transient 混在一起）。
   * @param {object} labels - 宿主随图给的官方工具标签表 {titles, generic}。
   * @returns {Array<object>} 覆盖层对话行（与宿主 team-conversation 的行同形）。
   */
  function wsFoldLive(entries, labels) {
    if (!Array.isArray(entries) || entries.length === 0) return []
    // attemptId -> {turn, step, time, order:[], blocks:Map}
    const attempts = new Map()
    for (const entry of entries) {
      const ev = entry === null || typeof entry !== 'object' ? null : entry.event
      if (ev === null || ev === undefined || ev.type !== 'assistant/live-chunk') continue
      const d = ev.data === null || typeof ev.data !== 'object' ? {} : ev.data
      const attemptId = String(d.attemptId)
      let attempt = attempts.get(attemptId)
      if (attempt === undefined) {
        attempt = { turn: d.turn, step: d.step, time: ev.time === undefined ? 0 : ev.time, blocks: new Map(), order: [] }
        attempts.set(attemptId, attempt)
      }
      const chunk = d.chunk === null || typeof d.chunk !== 'object' ? null : d.chunk
      if (chunk === null) continue
      const index = Number.isFinite(chunk.index) ? chunk.index : 0
      const blockOf = (type) => {
        let block = attempt.blocks.get(index)
        if (block === undefined) {
          block = { type: type, text: '', args: '', name: '', id: '' }
          attempt.blocks.set(index, block)
          attempt.order.push(index)
        }
        if (block.type !== type) block.type = type
        return block
      }
      if (chunk.type === 'block-start') {
        blockOf(chunk.blockType === 'reasoning' ? 'reasoning' : chunk.blockType === 'tool-call' ? 'tool-call' : 'text')
      } else if (chunk.type === 'text-delta') {
        if (typeof chunk.text === 'string') blockOf('text').text += chunk.text
      } else if (chunk.type === 'reasoning-delta') {
        if (typeof chunk.text === 'string') blockOf('reasoning').text += chunk.text
      } else if (chunk.type === 'tool-call-delta') {
        const block = blockOf('tool-call')
        if (typeof chunk.id === 'string' && block.id === '') block.id = chunk.id
        // 名字用**赋值**而不是累加 —— 与官方 BlockAssembler 逐字一致
        // （dsh-llm/lib/types/assembler.js:58-61 `if (chunk.name) partial.toolCallName = chunk.name`）。
        // 只有 argumentsDelta 才是累加的。名字若在多个 delta 里重复出现，
        // 累加会拼出 "readread" 这种标签。
        if (typeof chunk.name === 'string' && chunk.name !== '') block.name = chunk.name
        if (typeof chunk.argumentsDelta === 'string') block.args += chunk.argumentsDelta
      }
      // block-end / usage / finish 不带来新文本，覆盖层不需要处理。
    }
    const rows = []
    for (const attempt of attempts.values()) {
      for (const index of attempt.order) {
        const block = attempt.blocks.get(index)
        if (block === undefined) continue
        const base = { live: true, turn: attempt.turn, step: attempt.step, time: attempt.time }
        if (block.type === 'tool-call') {
          // 提问不成工具行：它渲染成下面的选择型提问卡（与宿主的 extractConversation 同口径）。
          if (block.name === 'ask_user_question' || block.name === 'request_user_input') continue
          rows.push(Object.assign(base, {
            kind: 'tool', name: block.name, callId: block.id,
            text: wsToolLabel(block.name, labels),
            detail: wsToolTarget(block.name, block.args),
          }))
          continue
        }
        if (block.text === '') continue
        if (block.type === 'reasoning') rows.push(Object.assign(base, { kind: 'assistant', reasoning: true, text: block.text }))
        else rows.push(Object.assign(base, { kind: 'assistant', text: block.text }))
      }
    }
    return rows
  }

  /** 工具行标签：查宿主随图给的官方表（同一份真值，不在前端再抄一遍）。 */
  function wsToolLabel(name, labels) {
    // 宿主给的是**两种语言各一份**（graph.toolLabelTable 的 titles / titlesEn）。
    // 服务端不知道界面语言，所以它两份都发、由这里挑 —— 之前是服务端直接下发中文
    // 标签，那等于把语言焊死在宿主半（英文界面下每行工具调用都是中文）。
    const en = localeIsEnglish() && labels !== undefined && labels !== null
      && labels.titlesEn !== undefined && labels.titlesEn !== null
    const titles = labels === undefined || labels === null ? null : (en ? labels.titlesEn : labels.titles)
    // 兜底标签走字典（原来写死 '工具调用'：官方表读不到时英文界面仍是中文）。
    const genericKey = en && typeof labels.genericEn === 'string' ? 'genericEn' : 'generic'
    const fallback = titles === null || typeof labels[genericKey] !== 'string' ? wsText('wsToolCallGeneric') : labels[genericKey]
    const raw = typeof name === 'string' ? name : ''
    if (titles !== null) {
      const camel = raw.replace(/_([a-z0-9])/g, (_, c) => String(c).toUpperCase())
      if (typeof titles[camel] === 'string') return titles[camel]
      if (typeof titles[raw] === 'string') return titles[raw]
      if (raw.indexOf('terminal_') === 0 && typeof titles.readTerminal === 'string') return titles.readTerminal
      if (raw.indexOf('subagent') === 0 && typeof titles.subagent === 'string') return titles.subagent
    }
    return fallback
  }

  /**
   * 一行工具调用的标签。
   *
   * ⚠️ 优先**按工具名现查双语表**，而不是直接用宿主下发好的 text：
   * extractConversation 在服务端就把标签拼进了行里（那是中文侧的表），
   * 直接画 text 的话，英文界面下每一条**已结算**的工具行都还是中文
   * —— 只有流式覆盖层（这里本来就走 wsToolLabel）会变成英文，
   * 同一屏里两种语言混排，比全中文更难解释。
   * 宿主没给表（旧宿主 / 图还没刷出来）时退回行里已有的 text，不空。
   * @param {object} row - 对话行（{name, text}）。
   * @param {object} state - 工作区状态（toolLabels 挂在上面）。
   * @returns {string}
   */
  function wsRowToolLabel(row, state) {
    const labels = state.toolLabels
    if (labels === undefined || labels === null || typeof row.name !== 'string' || row.name === '') {
      return String(row.text ?? '')
    }
    return wsToolLabel(row.name, labels)
  }

  /**
   * 工具调用的目标摘要。**参数是流式增量**，多数时候 JSON 还不完整：先试 parse，
   * 失败再退成正则抠第一个值（官方行也是「标签 + 一个目标」）。
   * @param {string} name - 工具名。
   * @param {string} raw - 已到达的参数增量。
   * @returns {string}
   */
  function wsToolTarget(name, raw) {
    if (typeof raw !== 'string' || raw.trim() === '') return ''
    const targetKey = name === 'grep' || name === 'glob' || name === 'ops_grep' || name === 'ops_glob'
      ? 'pattern'
      : (name === 'bash' || name === 'pwsh' || name === 'run_code' || name === 'exec_command'
        ? 'command' : 'file_path')
    let args = null
    try { args = JSON.parse(raw) } catch { args = null }
    if (args !== null && typeof args === 'object') {
      const value = targetKey === 'file_path'
        ? (args.file_path !== undefined ? args.file_path : (args.path !== undefined ? args.path : args.notebook_path))
        : args[targetKey]
      if (typeof value !== 'string' || value === '') return ''
      const head = targetKey === 'command' ? value.split('\n')[0] : value.split(/[\\/]/).slice(-1)[0]
      return head.slice(0, 200)
    }
    // 半截 JSON：抠 "file_path": "…" / "pattern": "…" / "command": "…" 的第一个值。
    const m = new RegExp('"' + targetKey + '"[\\s:]*"((?:[^"\\\\]|\\\\.)*)').exec(raw)
    if (m === null) return ''
    const head = targetKey === 'command' ? m[1].split('\n')[0] : m[1].split(/[\\/]/).slice(-1)[0]
    return head.slice(0, 200)
  }



  const CSS =
    '.dat-wrap{font-size:13px;line-height:1.6;display:flex;flex-direction:column;gap:12px;padding:2px 0;color:inherit}' +
    '.dat-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:12px;opacity:.85}' +
    '.dat-unsaved{opacity:.9}' +
    '.dat-msg{font-size:12px;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.45));border-radius:6px;line-height:1.65;word-break:break-word}' +
    '.dat-msg.ok{border-color:rgba(46,160,67,.55)}' +
    '.dat-msg.err{border-color:rgba(248,81,73,.6)}' +
    '.dat-msg.warn{border-color:rgba(219,154,4,.6)}' +
    '.dat-note{font-size:11px;opacity:.6}' +
    '.dat-diag{margin:4px 0 0;padding-left:18px;font-size:11px;opacity:.85;max-height:160px;overflow:auto}' +
    '.dat-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));border-radius:8px}' +
    // 统一选择队员模型（2026-10-06）：放在角色列表**之上**，语义上它就属于那一列角色。
    '.dat-bulk{display:flex;flex-direction:column;gap:8px;padding:10px 12px;margin-bottom:-4px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));border-bottom-left-radius:0;border-bottom-right-radius:0;border-bottom:none}' +
    '.dat-bulk-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}' +
    '.dat-bulk-spacer{flex:1 1 auto}' +
    '.dat-btn-recommend{align-self:center;flex:0 0 auto}' +
    '.dat-bulk-note{font-size:11px;color:var(--dsw-alias-label-secondary,#63636a);align-self:center}' +
    '.dat-bulk-title{font-weight:600}' +
    '.dat-bulk-ctl{display:flex;gap:8px 14px;flex-wrap:wrap;align-items:flex-start}' +
    '.dat-bulk-ctl .dat-field{flex:1 1 170px;min-width:158px}' +
    // 提示槽：恒定存在、恒定一行高。没有话也说空串 —— 这样四格的**控件**永远在同一水平线，
    // 也不会因为某格忽然多一句原因就把整块顶高（版面跳动）。
    '.dat-hintslot{display:block;min-height:16px;font-size:11px;line-height:16px;opacity:.6;text-align:left}' +
    '.dat-bulk-hint{font-size:11px;opacity:.6;line-height:1.6}' +
    '.dat-row{display:flex;gap:10px 16px;flex-wrap:wrap;align-items:flex-start;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))}' +
    '.dat-row:first-child{border-top:none}' +
    '.dat-role{flex:1 1 260px;min-width:0;display:flex;flex-direction:column;gap:2px}' +
    '.dat-role-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}' +
    '.dat-name{font-weight:600}' +
    '.dat-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;opacity:.6;word-break:break-all}' +
    '.dat-mission{font-size:12px;opacity:.78}' +
    '.dat-ctl{flex:0 1 232px;min-width:200px;display:flex;flex-direction:column;gap:6px}' +
    // 批量调用那一格：窄、自己占一列，与右边的下拉列顶对齐（同一套 11px 小标题 + 控件）。
    '.dat-batch{flex:0 0 auto;display:flex;flex-direction:column;gap:6px;min-width:74px;padding-top:1px}' +
    '.dat-checkline{display:flex;align-items:center;gap:7px;height:24px;box-sizing:border-box;padding:0 8px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.5));border-radius:5px;background:transparent}' +
    '.dat-check{width:15px;height:15px;margin:0;flex:none;cursor:pointer;accent-color:var(--dsw-alias-state-business-primary,#2563eb)}' +
    '.dat-check:disabled{cursor:default;opacity:.5}' +
    '.dat-field{display:flex;flex-direction:column;gap:3px;min-width:0}' +
    '.dat-label{font-size:11px;opacity:.65}' +
    '.dat-select{font-size:12px;padding:3px 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.5));background:transparent;color:inherit;width:100%;box-sizing:border-box}' +
    '.dat-select:disabled{opacity:.5}' +
    '.dat-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
    '.dat-btn{font-size:12px;padding:3px 10px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.5));background:transparent;color:inherit;cursor:pointer;white-space:nowrap}' +
    '.dat-btn:disabled{opacity:.5;cursor:default}' +
    '.dat-foot{font-size:11px;opacity:.6;line-height:1.75}' +
    '.dat-summary{font-size:12px;opacity:.78}' +
    // ── 工作区画布（团队拓扑页）─────────────────────────────────────────────
    // 结构色全部走 --dsw-alias-* 令牌（宿主主题切换时自动翻转，官方 onboarding CSS 同款做法）；
    // 语义强调色（蓝/绿/紫/琥珀/红）没有现成 alias，按 body[data-ds-dark-theme] 覆写
    // ——这是宿主主题服务的**官方选择器**（dsh-client-ui-theme 的 onboarding/gradient CSS 都用它），
    // 不是我们发明的暗色开关。
    '.dat-ws{--dat-blue:var(--dsw-alias-state-business-primary,#2563eb);--dat-green:var(--dsw-alias-state-success-primary,#15a34a);' +
    '--dat-violet:#7c3aed;--dat-amber:var(--dsw-alias-state-warn-primary,#d97706);--dat-red:var(--dsw-alias-state-error-primary,#dc2626);' +
    '--dat-blue-soft:color-mix(in srgb, var(--dat-blue) 12%, transparent);--dat-ink-muted:var(--dsw-alias-label-tertiary,#9a9aa1);' +
    // 顶部让出宿主的 frameless 标题栏带（Windows 的 −□× 与 macOS 的红黄绿都画在这条带里，
    // 且宿主窗口控件的层级低于本覆盖层的 z-index，不让就会被盖住点不动）。
    // 取值链：--dsh-frame-chrome-top（html[data-windows-titlebar]=40px、任意平台全屏=0px）
    //   → --dsh-frame-top-clearance（darwin 非全屏=48px，chrome-top 在这个情形**没定义**）
    //   → 0px（纯 Web，没有自绘标题栏）。自定义属性沿 DOM 继承给遮罩/抽屉。
    '--dat-chrome-top:var(--dsh-frame-chrome-top, var(--dsh-frame-top-clearance, 0px));' +
    'position:fixed;top:var(--dat-chrome-top);left:0;right:0;bottom:0;z-index:9000;' +
    'display:flex;flex-direction:column;font-size:13px;line-height:1.55;' +
    'background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#191919)}' +
    'body[data-ds-dark-theme] .dat-ws{--dat-violet:#a78bfa;--dat-blue-soft:color-mix(in srgb, var(--dat-blue) 22%, transparent)}' +
    '.dat-ws .ws-top{display:flex;align-items:center;gap:9px;padding:9px 14px;flex:none;' +
    'border-bottom:1px solid var(--dsw-alias-border-l2,#e5e5e6);background:var(--dsw-alias-bg-layer-2,#fafafa);position:relative;z-index:5}' +
    '.dat-ws .ws-top .t{font-weight:600}.dat-ws .ws-top .s{color:var(--dat-ink-muted);font-size:12px}' +
    '.dat-ws .ws-top .sp{flex:1}' +
    '.ws-btn{font:inherit;font-size:12px;padding:4px 11px;border-radius:6px;cursor:pointer;' +
    'border:1px solid var(--dsw-alias-border-l2,#e5e5e6);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit}' +
    '.ws-btn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,#f4f4f5))}' +
    '.ws-btn.ghost{border-color:transparent;color:var(--dsw-alias-label-secondary,#63636a)}' +
    '.ws-btn.on{border-color:var(--dat-blue);background:var(--dat-blue-soft);color:var(--dat-blue)}' +
    '.ws-btn.primary{border-color:var(--dat-blue);background:var(--dat-blue);color:#fff}' +
    '.ws-ctl{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dat-ink-muted)}' +
    '.ws-ctl input[type=range]{width:88px}' +
    '.dat-ws .ws-stage{flex:1;min-height:0;position:relative;overflow:auto;background:var(--dsw-alias-bg-base,#fff)}' +
    '.dat-ws .ws-canvas{position:relative;transform-origin:0 0}' +
    '.dat-ws svg.ws-wires{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}' +
    '.ws-node{position:absolute;width:196px;height:142px;border:1px solid var(--dsw-alias-border-l2,#e5e5e6);border-radius:9px;' +
    'background:var(--dsw-alias-bg-layer-1,#fff);cursor:pointer;transition:box-shadow .12s,border-color .12s;overflow:hidden;' +
    'display:flex;flex-direction:column;color:var(--dsw-alias-label-primary,#191919)}' +
    '.ws-node:hover{border-color:var(--dat-blue);box-shadow:0 6px 20px rgba(0,0,0,.14);z-index:3}' +
    '.ws-node.lead{border-color:var(--dat-blue);box-shadow:0 0 0 3px var(--dat-blue-soft)}' +
    '.ws-node .hd{display:flex;align-items:center;gap:5px;padding:6px 9px;border-bottom:1px solid var(--dsw-alias-border-l1,#efeff0)}' +
    // 新队员入场动画（用户要求「每创建一个队友都会实时显示到工作区里面」——出现要看得见）。
    '.ws-node.ws-enter{animation:ws-enter .85s cubic-bezier(.2,.8,.3,1) both}' +
    '@keyframes ws-enter{from{opacity:0;transform:scale(.86)}to{opacity:1;transform:none}}' +
    '@media (prefers-reduced-motion: reduce){.ws-node.ws-enter{animation:none}}' +
    '.ws-dot{width:7px;height:7px;border-radius:50%;flex:none;background:#c6c6cc}' +
    '.ws-dot.running{background:var(--dat-blue);animation:ws-pulse 1.5s ease-in-out infinite}' +
    '.ws-dot.done{background:var(--dat-green)}.ws-dot.failed{background:var(--dat-red)}' +
    '@keyframes ws-pulse{0%,100%{opacity:1}50%{opacity:.28}}' +
    '.ws-node .nm{font-weight:600;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.ws-node .rl{font-size:9.5px;color:var(--dat-ink-muted);margin-left:auto;flex:none}' +
    '.ws-node .bd{padding:6px 9px;display:flex;flex-direction:column;gap:5px;flex:1;justify-content:center}' +
    '.ws-node .model{font-size:10px;color:var(--dsw-alias-label-secondary,#63636a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
    'font-family:ui-monospace,Consolas,monospace}' +
    '.ws-tl{display:flex;align-items:center;gap:5px;font-size:10px}' +
    '.ws-tl .lb{color:var(--dat-ink-muted)}' +
    '.ws-tl .ct{font-weight:600;font-variant-numeric:tabular-nums}' +
    '.ws-tl .bar{flex:1;height:3px;border-radius:2px;background:var(--dsw-alias-border-l1,#efeff0);overflow:hidden;display:flex}' +
    '.ws-tl .bar i{display:block;height:100%}' +
    '.ws-tl .bar i.d{background:var(--dat-green)}.ws-tl .bar i.r{background:var(--dat-blue)}' +
    '.ws-mx{display:flex;gap:8px;font-size:10px;color:var(--dsw-alias-label-secondary,#63636a);white-space:nowrap}' +
    '.ws-mx b{font-weight:600;color:inherit;font-variant-numeric:tabular-nums}' +
    '.ws-mx .hit{margin-left:auto}' +
    '.ws-node .ft{display:flex;align-items:center;gap:6px;padding:5px 9px;border-top:1px solid var(--dsw-alias-border-l1,#efeff0);' +
    'background:var(--dsw-alias-bg-layer-2,#fafafa);flex:none}' +
    '.ws-node .ft .d{font-size:9.5px;color:var(--dat-ink-muted);font-variant-numeric:tabular-nums;white-space:nowrap}' +
    '.ws-node .ft .rg{margin-left:auto;display:flex;align-items:center;gap:5px}' +
    // 流光：**深色实心色块**沿路径移动。
    //
    // 用户 2026-10-09 原话：「把流光改回第一版…一个深色的色块即可，不用什么光晕了，改回去！」
    // 所以回到 v1 的 dasharray 短划模型：pathLength=100 + '9 91'（一段 9% 的实色块）
    // + stroke-dashoffset 动画。色块比底线深（底线 opacity≈0.34~0.62，色块 0.95），
    // 即用户截图里那种「浅色线上走一个深色块」。
    // 保留后来的复用架构（元素按边身份复用）：改 d 不会重启 dashoffset 动画，
    // 所以轮询/点开关时色块不跳回起点。
    '.dat-ws path.flow{fill:none;stroke-linecap:round;opacity:.95;animation:ws-flow 2.6s linear infinite;pointer-events:none}' +
    '@keyframes ws-flow{from{stroke-dashoffset:100}to{stroke-dashoffset:0}}' +
    // 反向流光（双向承接边）：色块从 100% 走回 0%。
    '.dat-ws path.flow.f-rev{animation-name:ws-flow-rev}' +
    '@keyframes ws-flow-rev{from{stroke-dashoffset:0}to{stroke-dashoffset:100}}' +
    '@media (prefers-reduced-motion: reduce){.dat-ws path.flow{animation:none;opacity:0}}' +
    '.dat-ws rect.corebox{fill:transparent;stroke:var(--dat-violet);stroke-width:1.2;stroke-dasharray:6 5;opacity:.5;cursor:pointer;pointer-events:auto}' +
    '.dat-ws rect.corebox:hover{opacity:.85}' +
    '.dat-ws text.corelabel{font-size:10px;fill:var(--dat-violet);opacity:.85;cursor:pointer;pointer-events:auto}' +
    '.dat-ws .ws-legend{display:flex;gap:16px;font-size:11px;color:var(--dat-ink-muted);padding:6px 26px 10px;flex-wrap:wrap;align-items:center;flex:none}' +
    '.dat-ws .ws-legend .li{display:inline-flex;align-items:center;gap:5px}' +
    '.dat-ws .ws-legend svg{display:block}' +
    '.dat-ws .ws-status{flex:none;border-top:1px solid var(--dsw-alias-border-l2,#e5e5e6);background:var(--dsw-alias-bg-layer-2,#fafafa);' +
    'padding:8px 14px;display:flex;align-items:center;gap:15px;flex-wrap:wrap;font-size:12px}' +
    '.dat-ws .sb{display:flex;align-items:baseline;gap:5px}' +
    '.dat-ws .sb .k{color:var(--dat-ink-muted);font-size:11px}' +
    '.dat-ws .sb .v{font-weight:600;font-variant-numeric:tabular-nums}' +
    '.dat-ws .sb-sep{width:1px;height:15px;background:var(--dsw-alias-border-l2,#e5e5e6)}' +
    '.dat-ws .sb .rt{margin-left:auto;display:flex;gap:15px;align-items:center}' +
    '.dat-ws .sb .hint{color:var(--dat-ink-muted);font-size:11px}' +
    '.dat-ws .ws-mask{position:fixed;top:var(--dat-chrome-top);left:0;right:0;bottom:0;background:rgba(0,0,0,.3);opacity:0;pointer-events:none;transition:opacity .16s;z-index:9010}' +
    '.dat-ws .ws-mask.on{opacity:1;pointer-events:auto}' +
    '.dat-ws .ws-drawer{position:fixed;top:var(--dat-chrome-top);right:0;bottom:0;width:min(620px,94vw);background:var(--dsw-alias-bg-layer-1,#fff);' +
    'border-left:1px solid var(--dsw-alias-border-l2,#e5e5e6);box-shadow:-14px 0 40px rgba(0,0,0,.16);' +
    'transform:translateX(102%);transition:transform .2s cubic-bezier(.22,.61,.36,1);display:flex;flex-direction:column;z-index:9011}' +
    '.dat-ws .ws-drawer.on{transform:none}' +
    '.dat-ws .ws-drawer .dh{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,#e5e5e6);flex:none}' +
    '.dat-ws .ws-drawer .dh .nm{font-weight:600}' +
    '.dat-ws .ws-drawer .dh .rl{font-size:11px;color:var(--dat-ink-muted)}' +
    '.dat-ws .ws-drawer .dh .x{margin-left:auto}' +
    // 抽屉左边缘的拖宽把手（用户 2026-10-09：「可以拖动左边的框让界面变宽，不要固定死宽度」）。
    // 绝对定位（不参与 drawer 的 flex 布局），命中区 7px、悬停高亮。
    '.dat-ws .ws-resizer{position:absolute;left:-3px;top:0;bottom:0;width:7px;cursor:col-resize;z-index:2;touch-action:none}' +
    '.dat-ws .ws-resizer:hover,.dat-ws .ws-resizer.on{background:var(--dat-blue);opacity:.35}' +
    '.dat-ws .ws-drawer .db{flex:1;min-height:0;overflow:hidden;padding:10px 12px;display:flex;flex-direction:column;gap:8px}' +
    // 指标区：紧凑的一行小格子（用户要求「状态栏再紧凑一些，现在太大太占位子」）。
    // 11 个指标压成 4 列 × 3 行的密排，字号缩小、去掉多余内边距，把高度让给下面的对话正文。
    '.dat-ws .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;flex:none}' +
    '.dat-ws .cell{border:1px solid var(--dsw-alias-border-l2,#e5e5e6);border-radius:5px;padding:3px 6px;min-width:0}' +
    '.dat-ws .cell .k{font-size:9px;line-height:1.25;color:var(--dat-ink-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.dat-ws .cell .v{font-weight:600;font-variant-numeric:tabular-nums;font-size:11.5px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    // 对话区：**占满剩余高度**并自己滚动（用户要求「下面是对话的窗口」）。
    // 间距对齐官方容器 .Hqq-bq_body 的 gap:12px（之前是 7px，比官方挤）。
    '.dat-ws .cvwrap{flex:1;min-height:0;display:flex;flex-direction:column;gap:6px}' +
    '.dat-ws .cvwrap h4{margin:2px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary,#63636a);font-weight:600;flex:none}' +
    '.dat-ws .cv{flex:1;min-height:0;overflow:auto;padding:2px 4px 2px 0;display:flex;flex-direction:column;gap:12px}' +
    '.dat-ws .ws-drawer h4{margin:10px 0 5px;font-size:12px;color:var(--dsw-alias-label-secondary,#63636a);font-weight:600}' +
    '.dat-ws .tk{border:1px solid var(--dsw-alias-border-l2,#e5e5e6);border-radius:6px;padding:5px 8px;margin-bottom:4px;display:flex;gap:7px;align-items:flex-start}' +
    '.dat-ws .tk .st{font-size:10px;padding:1px 5px;border-radius:3px;flex:none;margin-top:1px}' +
    '.dat-ws .tk .st.completed{background:color-mix(in srgb, var(--dat-green) 12%, transparent);color:var(--dat-green)}' +
    '.dat-ws .tk .st.in_progress{background:var(--dat-blue-soft);color:var(--dat-blue)}' +
    '.dat-ws .tk .st.pending{background:var(--dsw-alias-bg-layer-2,#f4f4f5);color:var(--dat-ink-muted)}' +
    '.dat-ws .empty{color:var(--dat-ink-muted);font-size:12px}' +
    // ── 对话排版 ──────────────────────────────────────────────────────────────
    // 官方真值（dsh-client-ui-chat 的 module CSS，提取脚本 .probe/extract-chat-css.cjs）：
    //   * 助手正文 AssistantMarkdown：14px / 24px 行高 / label-primary
    //   * 用户气泡 MessageItem：--dsw-specific-bubble(#d3e2ff) / radius-xl(20px) / 14px / 22px
    //   * 次要行（工具/活动）：13px / 20px / label-secondary
    //
    // ⚠️ 用户 2026-10-09 看过实际效果后要求「字号小一点，人眼看着舒服些」，
    // 所以正文与工具行统一收到 **12.5px / 21px**（比官方小一号，这是**用户明确的选择**，
    // 不是抄错）。标题、表格、行内码按同一比例等比收小，保持层次关系。
    '.dat-ws .tr .who{font-size:12px;color:var(--dsw-alias-label-tertiary,#9a9aa1);margin-bottom:3px}' +
    // 队员报告的首行「【report_result】名字 · 状态」：比正文略小、略灰，一眼与正文区分。
    '.dat-ws .md .rr-head{font-size:12px;color:var(--dsw-alias-label-secondary,#63636a);margin-bottom:6px}' +
    '.dat-ws .md .rr-head i{font-style:normal;color:var(--dat-green,#2e9e5b)}' +
    // reasoning-only 的回合（被中止，只有思考内容）——见 graph.js 的 reasoningOfBlocks。
    // 左侧竖线 + 略暗的文字，让用户一眼看出「这是思考，不是正式回复」。
    '.dat-ws .tr.think .md{color:var(--dsw-alias-label-tertiary,#9a9aa1)}' +
    '.dat-ws .tr.think{border-left:2px solid var(--dsw-alias-separator-secondary,#e6e6e6);padding-left:10px}' +
    // 折叠的「思考过程」是一行**可点开的披露行**（官方 ReasoningRow 同语义）：
    // 用 button 才有键盘/焦点语义，外观要抹平到与旁边那行 who 标签一致。
    '.dat-ws .who.qh{background:none;border:none;font:inherit;padding:0;cursor:pointer;text-align:left;' +
    'color:var(--dsw-alias-label-tertiary,#9a9aa1)}' +
    '.dat-ws .who.qh:hover{color:var(--dsw-alias-label-secondary,#63636a)}' +
    // 逐行「复制 + 时间」：官方 MessageIconActions 的高度是 28px、gap 8px
    // （chat-client.js:1093 .actions{height:calc(28px + …);align-items:center;gap:8px}），
    // 这里收小一档贴合本浮窗 12.5px 的正文规格，颜色仍走官方那三级标签色。
    '.dat-ws .rowacts{display:flex;align-items:center;gap:8px;height:22px;opacity:.55}' +
    '.dat-ws .tr:hover .rowacts,.dat-ws .rowacts:focus-within{opacity:1}' +
    '.dat-ws .rowacts .rt{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9a9aa1);font-variant-numeric:tabular-nums}' +
    '.dat-ws .copybtn{background:none;border:none;font:inherit;font-size:11.5px;line-height:16px;padding:0;' +
    'cursor:pointer;color:var(--dsw-alias-label-tertiary,#9a9aa1);text-align:left}' +
    '.dat-ws .copybtn:hover{color:var(--dsw-alias-label-secondary,#63636a)}' +
    // ⚠️ 正文元素的类名是 `.md`（不是 `.msg`）。2026-10-09 度量探针实测：写成 `.tr .msg`
    // 时这些规则**全是死代码**（计算样式 backgroundColor=rgba(0,0,0,0)、padding=0px），
    // 表现就是「用户消息没有气泡、正文继承默认字号」。选择器必须与 DOM 一致。
    '.dat-ws .tr .md{font-size:12.5px;line-height:21px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary,#191919)}' +
    // 工具行：官方次要行规格收小到 12.5px/21px（与正文一致，读起来齐整）。
    '.dat-ws .trow{display:flex;align-items:baseline;gap:10px;font-size:12.5px;line-height:21px;color:var(--dsw-alias-label-secondary,#63636a);padding:0}' +
    '.dat-ws .trow .tl{flex:none;color:var(--dsw-alias-label-secondary,#63636a)}' +
    '.dat-ws .trow .tt{font-family:var(--dsw-font-family,inherit);font-size:12.5px;line-height:21px;color:var(--dsw-alias-label-tertiary,#9a9aa1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}' +
    '.dat-ws .trow.err .tl{color:var(--dsw-alias-state-error-primary,#dc2626)}' +
    // 回合结局行：独立块（不套 .trow —— 那是 flex 且 .tl 为 flex:none，长错误正文会横向溢出）。
    '.dat-ws .turnend{font-size:12.5px;line-height:18px;padding:2px 0;color:var(--dsw-alias-label-tertiary,#9a9aa1);white-space:normal;word-break:break-word}' +
    '.dat-ws .turnend.err{color:var(--dsw-alias-state-error-primary,#dc2626)}' +
    '.dat-ws .trow.group{justify-content:flex-start;font-size:12.5px;line-height:21px;color:var(--dsw-alias-label-tertiary,#9a9aa1)}' +
    // ── 展开层（2026-10-14，用户 2026-10-09 的「和官方对话框没太大区别」）──────────
    // 官方每行工具调用是可展开的 DisclosureRow：折叠一行标签+目标，展开是「输入」「输出」
    // （.probe-tmp/tool-client.js:1495 lazily mounted result card、:1662/:1676 row.input/row.output）。
    // 这里用原生 details 之外的最小方案：行本身可点，正文挂在行后一个 .dbox 里。
    // max-height 必须有：一份 4,380 码元的工具输出（实测 session-00001000 最长值）不封顶
    // 会把整块对话正文顶出可视区，用户就得先滚掉一屏才能继续读对话。
    // 2026-10-15 用户报「固定容器太窄，看不到完整的工具调用」：260px 是**写死的数**，
    // 抽屉拖到 1200px 宽时它仍然只有 260px 高。改成随视口高度自适应（52vh，封顶 480px），
    // 并在每块展开层顶上给一颗「放大查看」—— 那才是真正看全的地方（见 .ws-zoom）。
    // ⚠️ 2026-10-21 用户报「工具调用不能展开，展开是一条缝」—— 根因是 **flex 收缩**，不是高度写死：
    // .cv 是 display:flex;flex-direction:column 的滚动容器，它的子项默认 flex-shrink:1。
    // 展开一层就会往这一列里塞两个子项（.trow 行 + .dbox 正文），子项总高超过可视高时
    // 浏览器按比例把它们**压扁**，于是每个 .dbox 只剩一道缝。
    // 实测（headless Chrome + 本文件抽出的真实 CSS，1400×760 视口）：
    //   3 个展开 → 每个 149px；5 个 → 76px；8 个 → **27px**（就是用户看到的那条缝）。
    // 强制 flex:0 0 auto 后同一场景 8 个全是 149px，滚动交给 .cv（scrollHeight 642→1612）。
    // 所以 .trow 与 .dbox 都必须 flex:none —— 行高塌陷会连带把正文压没（缝里只剩一行标题）。
    // 同时把「必须点放大查看才看得全」去掉：正文默认就摊到底（见 .dbox 的 max-height 说明）。
    '.dat-ws .trow{flex:none}' +
    '.dat-ws .trow.exp{cursor:pointer}' +
    '.dat-ws .trow .chv{flex:none;width:10px;color:var(--dat-ink-muted);font-size:10px;line-height:21px}' +
    // 展开层的两条硬约束（缺一就是「缝」）：
    //   * flex:none —— 不许被 .cv 的 flex 列压扁（上面那笔实测账）；
    //   * 高度随内容、封顶 70vh —— 用户要的是「展开就能看代码」，不是「展开后还得点放大查看」。
    //     封顶仍然要有：一份 4,380 码元的输出（session-00001000 实测最长值）不封顶会把
    //     整列顶到几屏高，用户反而找不到下一条。封顶后 .dbox 自己滚，正文可读区是 70vh。
    '.dat-ws .dbox{flex:none;border:1px solid var(--dsw-alias-border-l1,#efeff0);border-radius:6px;padding:6px 8px;margin:2px 0 6px;background:var(--dsw-alias-bg-layer-2,#fafafa);max-height:70vh;overflow:auto}' +
    '.dat-ws .dbox .dl{color:var(--dsw-alias-label-tertiary,#9a9aa1);font-size:10px;font-weight:600;margin:0 0 2px}' +
    // 展开后要能读代码（用户 2026-10-21：「展开后就可以看到工具调用里面的代码」）：
    // 等宽字体 + 11.5px/17px。原先是 11px 的 **界面正文字体** —— 工具输入是一份 JSON、
    // 输出是命令回显，比例字体下引号与花括号对不齐，缩进也看不出来。
    '.dat-ws .dbox pre{margin:0 0 6px;white-space:pre-wrap;word-break:break-word;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-primary,#191919)}' +
    '.dat-ws .dbox pre:last-child{margin-bottom:0}' +
    '.dat-ws .dbox .dl+i{color:var(--dsw-alias-state-error-primary,#dc2626)}' +
    // 展开层顶部的工具条。sticky 才在框内滚动时一直够得着（.dbox 自己就是滚动容器），
    // 负 margin 把它铺回 .dbox 的内边距上沿，滚动时正文不会从它背后穿过去。
    '.dat-ws .dbox .dzb{position:sticky;top:-6px;z-index:1;display:flex;align-items:center;gap:8px;' +
    'margin:-6px -8px 4px;padding:1px 8px 4px;background:var(--dsw-alias-bg-layer-2,#fafafa)}' +
    '.dat-ws .dbox .dzb .dzbtn{margin-left:auto;font-size:10px;line-height:16px;padding:0 6px;border-radius:4px;' +
    'border:1px solid var(--dsw-alias-border-l2,#e5e5e6);background:var(--dsw-alias-bg-layer-1,#fff);' +
    'color:var(--dsw-alias-label-secondary,#63636a);cursor:pointer;white-space:nowrap}' +
    '.dat-ws .dbox .dzb .dzbtn:hover{color:var(--dat-blue);border-color:var(--dat-blue)}' +
    // 「放大查看」面板（2026-10-15 用户：「工具调用这个固定容器弹窗太窄了」）。
    // 挂在 .dat-ws 根节点上而**不是**抽屉里：抽屉带 transform，固定定位的后代在它内部会
    // 变成相对抽屉定位，宽度也就被抽屉夹死 —— 那正是要逃出去的东西。
    // 顶边让出宿主标题栏带（与 .ws-drawer 同一个 --dat-chrome-top），否则 Windows 的 −□× 点不到。
    // 宽度 min(1180px,100%)：宽屏上是一条适合读的列，窗口窄下来它跟着缩，不靠横向滚动看全文。
    '.dat-ws .ws-zoom{position:fixed;top:var(--dat-chrome-top);left:0;right:0;bottom:0;z-index:9012;' +
    'background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;padding:20px}' +
    '.dat-ws .ws-zoom .zp{display:flex;flex-direction:column;width:min(1180px,100%);max-height:100%;' +
    'background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e5e5e6);' +
    'border-radius:10px;box-shadow:0 18px 60px rgba(0,0,0,.28);overflow:hidden}' +
    '.dat-ws .ws-zoom .zh{display:flex;align-items:center;gap:10px;padding:9px 14px;flex:none;' +
    'border-bottom:1px solid var(--dsw-alias-border-l2,#e5e5e6)}' +
    '.dat-ws .ws-zoom .zt{font-size:12.5px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.dat-ws .ws-zoom .zh .copybtn{margin-left:auto;flex:none;font-size:12px}' +
    '.dat-ws .ws-zoom .zx{flex:none;font:inherit;font-size:12px;line-height:18px;padding:1px 9px;border-radius:5px;cursor:pointer;' +
    'border:1px solid var(--dsw-alias-border-l2,#e5e5e6);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit}' +
    '.dat-ws .ws-zoom .zx:hover{background:var(--dsw-alias-interactive-bg-hover,#f4f4f5)}' +
    '.dat-ws .ws-zoom .zb{flex:1;min-height:0;overflow:auto;padding:12px 14px}' +
    '.dat-ws .ws-zoom .zl{font-size:11px;font-weight:600;color:var(--dat-ink-muted);margin:0 0 3px}' +
    '.dat-ws .ws-zoom .zl.zerr{color:var(--dat-red)}' +
    '.dat-ws .ws-zoom .zb pre{margin:0 0 12px;white-space:pre-wrap;word-break:break-word;' +
    'font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-primary,#191919)}' +
    '.dat-ws .ws-zoom .zb pre:last-child{margin-bottom:0}' +
    // markdown 正文（12.5px/21px 基准、段间距 12px；标题/列表/代码块/表格/行内码；
    // 颜色全走官方 --dsw-alias-* 令牌，暗色自适应）。
    '.dat-ws .md{font-size:12.5px;line-height:21px;color:var(--dsw-alias-label-primary,#191919);word-break:break-word}' +
    '.dat-ws .md p{margin:0 0 12px}' +
    '.dat-ws .md p:last-child{margin-bottom:0}' +
    '.dat-ws .md h1,.dat-ws .md h2,.dat-ws .md h3,.dat-ws .md h4{margin:16px 0 6px;line-height:1.4;color:var(--dsw-alias-label-primary,#191919);font-weight:600}' +
    '.dat-ws .md h1{font-size:19px}.dat-ws .md h2{font-size:16.5px}.dat-ws .md h3{font-size:14.5px}.dat-ws .md h4{font-size:13px}' +
    '.dat-ws .md ul,.dat-ws .md ol{margin:0 0 12px;padding-left:22px}' +
    '.dat-ws .md li{margin:3px 0}' +
    // 表格（用户 2026-10-09 截图：pipe table 原样显示成 `| 检查项 | 结果 |` 乱码）。
    // 样式对齐官方 markdown 表格：细边框、表头浅底、单元格内边距、可横向滚动。
    '.dat-ws .md-table{margin:0 0 12px;overflow-x:auto}' +
    '.dat-ws .md table{border-collapse:collapse;font-size:12px;line-height:18px;min-width:100%}' +
    '.dat-ws .md th,.dat-ws .md td{border:1px solid var(--dsw-alias-border-l2,#e5e5e6);padding:5px 9px;text-align:left;vertical-align:top}' +
    '.dat-ws .md th{background:var(--dsw-alias-bg-layer-2,#fafafa);font-weight:600;color:var(--dsw-alias-label-primary,#191919);white-space:nowrap}' +
    '.dat-ws .md td{color:var(--dsw-alias-label-primary,#191919);word-break:break-word}' +
    '.dat-ws .md code{font-family:var(--dsw-font-markdown-code-block,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:11.5px;background:var(--dsw-alias-markdown-code-block,#f6f6f7);border-radius:var(--dsw-radius-xs,4px);padding:1px 4px}' +
    '.dat-ws .md pre{margin:0 0 12px;padding:10px 12px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-markdown-code-block,#f6f6f7);overflow:auto}' +
    '.dat-ws .md pre code{background:none;padding:0;font-size:11.5px;line-height:1.6}' +
    '.dat-ws .md a{color:var(--dsw-alias-state-business-primary,#2563eb);text-decoration:none}' +
    '.dat-ws .md a:hover{text-decoration:underline}' +
    '.dat-ws .md strong{font-weight:600;color:var(--dsw-alias-label-primary,#191919)}' +
    '.dat-ws .md hr{border:none;border-top:1px solid var(--dsw-alias-border-l2,#e5e5e6);margin:12px 0}' +
    '.dat-ws .md blockquote{margin:0 0 12px;padding:2px 0 2px 10px;border-left:2px solid var(--dsw-alias-border-l3,#d4d4d8);color:var(--dsw-alias-label-secondary,#63636a)}' +
    // 我发出的消息：官方用户气泡（令牌真值见下），字号同样收小到 12.5px。
    '.dat-ws .tr.mine{align-self:flex-end;align-items:flex-end;max-width:82%;text-align:right}' +
    '.dat-ws .tr.mine .md{background:var(--dsw-specific-bubble,#d3e2ff);color:var(--dsw-alias-label-primary,#191919);' +
    'border-radius:var(--dsw-radius-xl,20px);padding:8px 14px;display:inline-block;text-align:left;font-size:12.5px;line-height:20px}' +
    // 图片行（用户 2026-10-10：「图片无法正常渲染！」→ 后接「显示的图片可以小一点，
    // 这个太大了！！」）：
    //   * 尺寸**硬上限**在 CSS 里（缩略图级别：最大 240px 高、最宽 100%），
    //     并且**不设** <img> 的 width/height 属性 —— JS 里写原图尺寸会覆盖这些上限，
    //     一张 2419x1733 的截图就会撑满整屏（用户截图里的「巨大红框」）。
    //   * cursor:zoom-in + 点击开原图，所以缩略图不影响看细节。
    //   * 加载中显示浅色占位；失败显示红框 + 下方原因文字（不再是空框）。
    '.dat-ws .imgrow{margin:2px 0;max-width:100%;display:flex;flex-direction:column;gap:3px}' +
    '.dat-ws .imgrow.mine{align-self:flex-end;align-items:flex-end}' +
    '.dat-ws .msgimg{max-width:min(100%,320px);max-height:200px;width:auto;height:auto;display:block;' +
    'border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l2,#e5e5e6);' +
    'cursor:zoom-in;object-fit:contain;background:var(--dsw-alias-bg-layer-2,#fafafa)}' +
    '.dat-ws .msgimg.loading{width:180px;height:110px}' +
    '.dat-ws .msgimg.failed{display:none}' +
    '.dat-ws .imgwhy{font-size:11px;line-height:16px;color:var(--dat-red);border:1px solid var(--dat-red);' +
    'border-radius:var(--dsw-radius-md,8px);padding:5px 8px;max-width:320px;word-break:break-word}' +
    '.dat-ws .imgcap{font-size:11px;color:var(--dsw-alias-label-tertiary,#9a9aa1);max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    // 提问卡（复刻官方 QuestionComposer 的形状：一次 ask_user_question = 一张卡，
    // 卡内每题带编号选项；点选项=选中，提交按钮一次性交全部题的答案）。
    // ⚠️ 必须限高滚动（用户 2026-10-09 截图：3 张卡把顶部指标格整个挤出可视区）：
    // .db 是 overflow:hidden 的 flex 列，qbox 不设上限就会无限撑高。
    '.dat-ws .qbox{flex:none;display:flex;flex-direction:column;gap:6px;max-height:46%;min-height:0;overflow:auto}' +
    '.dat-ws .qbox:empty{display:none}' +
    // 折叠态：只留标题那一行（用户 2026-10-09：「加一个待你回答（0 条）可以收下去的功能」）。
    // 标题本身做成可点行（button 语义），右侧一个箭头指示展开/收起。
    '.dat-ws .qbox .qh{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;' +
    'background:none;border:none;font:inherit;text-align:left;padding:0;flex:none}' +
    '.dat-ws .qbox .qh h4{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary,#63636a);font-weight:600}' +
    '.dat-ws .qbox .qh .chev{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#9a9aa1);transition:transform .15s}' +    '.dat-ws .qbox.folded{max-height:none;overflow:visible}' +
    '.dat-ws .qbox.folded .qh .chev{transform:rotate(-90deg)}' +
    '.dat-ws .qbox.folded .qcard{display:none}' +
    // 「本步还在生成」的如实标注（2026-10-12 报「弹窗与官方聊天不同步」）：静默期给个状态，
    // 不冒充流式正文。
    '.dat-ws .pendingrow{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9a9aa1);' +
    'font-style:italic;padding:2px 0}' +
    // 提问卡：官方 QuestionComposer 用面板底色 + 圆角 + 阴影，而不是彩色描边。
    '.dat-ws .qcard{border:1px solid var(--dsw-alias-border-l2,#e5e5e6);border-radius:var(--dsw-radius-lg,10px);' +
    'padding:12px 14px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:var(--dsw-elevation-soft,0 1px 2px rgba(0,0,0,.04))}' +
    '.dat-ws .qcard.done{background:var(--dsw-alias-bg-layer-2,#fafafa);box-shadow:none}' +
    '.dat-ws .qcard .qhd{font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary,#9a9aa1);margin-bottom:6px;letter-spacing:.02em}' +
    '.dat-ws .qcard.done .qhd{color:var(--dsw-alias-label-tertiary,#9a9aa1)}' +
    '.dat-ws .qcard .qtext{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#191919);white-space:pre-wrap;word-break:break-word}' +
    '.dat-ws .qopts{display:flex;flex-direction:column;gap:6px;margin-top:10px}' +
    // 题面之下的 detail（计划审批的整份计划）——官方同一位置：
    // dsh-client-ui-user-questions/lib/client.js:1077-1082（MarkdownText，渲在选项之上）。
    // 限高 + 内滚是必须的：真机实测一份计划 6,021 码元（session-00001007 seq 453），
    // 不限高会把选项与提交按钮顶出浮窗，用户得先滚完整份计划才找得到按钮。
    '.dat-ws .qdetail{border:1px solid var(--dsw-alias-border-l1,#efeff0);border-radius:6px;padding:8px 10px;margin:8px 0 0;background:var(--dsw-alias-bg-layer-2,#fafafa);max-height:300px;overflow:auto}' +
    '.dat-ws .qcap{color:var(--dsw-alias-label-tertiary,#9a9aa1);font-size:10px;margin-top:6px}' +
    '.dat-ws .qopt{display:flex;flex-direction:row;gap:10px;text-align:left;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#e5e5e6);' +
    'align-items:flex-start;background:var(--dsw-alias-bg-layer-1,#fff);border-radius:var(--dsw-radius-md,8px);padding:9px 12px;font:inherit;transition:border-color .12s,background .12s}' +
    '.dat-ws .qopt:hover{border-color:var(--dsw-alias-border-l3,#d4d4d8);background:var(--dsw-alias-interactive-bg-hover,#f7f7f8)}' +
    '.dat-ws .qopt.sel{border-color:var(--dsw-alias-state-business-primary,#2563eb);background:color-mix(in srgb, var(--dsw-alias-state-business-primary,#2563eb) 6%, transparent)}' +
    '.dat-ws .qopt .num{flex:none;width:18px;height:18px;border-radius:50%;border:1px solid var(--dsw-alias-border-l3,#d4d4d8);' +
    'font-size:11px;line-height:17px;text-align:center;margin-top:1px;color:var(--dsw-alias-label-secondary,#63636a)}' +
    '.dat-ws .qopt.sel .num{background:var(--dsw-alias-state-business-primary,#2563eb);border-color:var(--dsw-alias-state-business-primary,#2563eb);color:#fff}' +
    '.dat-ws .qopt .lb{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary,#191919)}' +
    '.dat-ws .qopt .ds{display:block;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#63636a);font-weight:400;margin-top:2px}' +
    '.dat-ws .qcustom{margin-top:8px;width:100%;box-sizing:border-box;font:inherit;font-size:13px;line-height:20px;padding:8px 10px;border-radius:var(--dsw-radius-md,8px);' +
    'border:1px solid var(--dsw-alias-border-l2,#e5e5e6);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit}' +
    '.dat-ws .qcustom:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#2563eb)}' +
    '.dat-ws .qfoot{display:flex;align-items:center;gap:10px;margin-top:12px}' +
    '.dat-ws .qans{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#63636a);white-space:pre-wrap;word-break:break-word}' +
    '.dat-ws .qans b{color:var(--dsw-alias-label-primary,#191919);font-weight:600}' +
    // 聊天输入区：输入框自增高、按钮在右、提示语在下方。
    // 2026-10-10 加图片上传：布局改成 [输入框 | ＋图片 | 发送]，缩略图条占一整行。
    '.dat-ws .composer{flex:none;display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:end;' +
    'border-top:1px solid var(--dsw-alias-border-l2,#e5e5e6);padding-top:10px}' +
    '.dat-ws .composer .cin{grid-column:1;resize:none;font:inherit;font-size:13px;line-height:20px;padding:8px 10px;border-radius:var(--dsw-radius-md,8px);' +
    'border:1px solid var(--dsw-alias-border-l2,#e5e5e6);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;min-height:36px;max-height:120px;overflow:auto}' +
    '.dat-ws .composer .cin:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#2563eb)}' +
    '.dat-ws .composer .addimg{grid-column:2;align-self:end;white-space:nowrap}' +
    // 「发送」与「停止生成」挤在第三列的一个 flex 容器里（2026-10-14 审查 P1-1）。
    // 为什么不是给 grid 加第四列：多一条轨道就多一个 gap，即使停止按钮 display:none
    // 也会把输入框挤窄 8px —— 那会动到用户已经习惯的布局。塞进同一列则停止键缺席时
    // 容器里只剩「发送」，宽度与改动前逐像素相同。
    '.dat-ws .composer .acts{grid-column:3;align-self:end;display:flex;gap:8px;align-items:flex-end}' +
    // 停止键用红色描边（与画布上 failed 那颗点同色），按下填红。
    '.dat-ws .composer .stop{white-space:nowrap;border-color:var(--dat-red);color:var(--dat-red)}' +
    '.dat-ws .composer .stop:hover{background:var(--dat-red);color:#fff}' +
    '.dat-ws .composer .stop:disabled{opacity:.5;cursor:default}' +
    '.dat-ws .composer .sendnote{grid-column:1/-1;font-size:11px;color:var(--dat-ink-muted);min-height:14px}' +
    '.dat-ws .composer .sendnote.err{color:var(--dat-red)}' +
    // 隐藏的原生 file input（只能通过 ＋ 按钮触发）。
    '.dat-ws .composer .filein{display:none}' +
    // 待发送图片缩略图条：未选中图片时不占位。
    '.dat-ws .composer .pending{grid-column:1/-1;display:none;gap:6px;flex-wrap:wrap}' +
    '.dat-ws .composer .pending.has{display:flex}' +
    '.dat-ws .composer .pchip{position:relative;width:56px;height:56px;border-radius:var(--dsw-radius-md,8px);overflow:hidden;' +
    'border:1px solid var(--dsw-alias-border-l2,#e5e5e6);background:var(--dsw-alias-bg-layer-2,#fafafa)}' +
    '.dat-ws .composer .pchip img{width:100%;height:100%;object-fit:cover;display:block}' +
    '.dat-ws .composer .pdel{position:absolute;top:1px;right:1px;width:16px;height:16px;line-height:14px;padding:0;border:none;' +
    'border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:12px;cursor:pointer}' +
    '.dat-ws .composer .pdel:hover{background:rgba(0,0,0,.75)}' +
    '.dat-ws .pill{font-size:10px;padding:1px 5px;border-radius:3px;background:var(--dat-blue-soft);color:var(--dat-blue)}' +
    '.dat-ws .rel{display:flex;align-items:center;gap:6px;font-size:11.5px;padding:3px 0}' +
    '.dat-ws .rel .ar{color:var(--dat-ink-muted)}' +
    '.dat-ws .ws-note{padding:18px 24px;color:var(--dat-ink-muted)}' +
    // 官方成员面板「成员」标题右侧的入口按钮（DOM 注入，见 ensureTeamEntry）。
    // ⚠️ 这个按钮挂在**官方面板**里，不在 .dat-ws 子树内 → 拿不到 .dat-ws 上定义的 --dat-* 变量，
    //    所以直接用宿主 alias 令牌（主题切换自动翻转），不经过我们的中间变量。
    '.dat-entry{font-size:11px;padding:2px 9px;border-radius:5px;cursor:pointer;margin-left:auto;flex:none;' +
    'border:1px solid var(--dsw-alias-state-business-primary,#2563eb);' +
    'background:var(--dsw-alias-state-business-primary,#2563eb);color:#fff}' +
    '.dat-entry:hover{filter:brightness(1.08)}'

  function ensureCss() {
    if (typeof document === 'undefined') return
    const id = 'dsh-dispatch-agent-team'
    if (document.querySelector('style[data-plugin-css="' + id + '"]')) return
    const tag = document.createElement('style')
    tag.dataset.plugin = id
    tag.dataset.pluginCss = id
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

  // ── 文案 ────────────────────────────────────────────────────────────────────
  // 官方 client-ui-agent-team 的写法：字典写在 JS 里，apply 时 ctx.locale.register(NS, {zh,en})；
  // locale/*.json 只放插件页的 meta.title/description。
  const zh = {
    // 角色数量不写死在这里：真值在 lib/roster.js，宿主 get 会返回 roles，页脚按 roles.length 渲染。
    summary: '可一次性给全部角色统一模型、思考强度、agent 预设与批量调用，也可逐角色单独指定（默认与 Lead 相同，批量调用默认开）',
    configured: '已配置 {count}/{total} 个角色',
    unsaved: '有未保存改动',
    loading: '正在加载配置与模型目录…',
    loadFailed: '加载失败：{message}',
    modelsFailed: '模型目录读取失败：{message}',
    modelsEmpty: '模型目录是空的：宿主没有返回任何 provider/model，现在只能选「跟随 Lead」。',
    noRoles: '宿主没有返回角色表：host 路由的 get 应当返回 roles。',
    diagnosticsTitle: '宿主诊断（配置文件可能有问题）：',
    notesTitle: '宿主信息（一切正常，仅供排查）：',
    cacheTitle: '缓存保活（等待队员时用 1-token 请求续提示词缓存）',
    cacheInactive: '本会话还没有开启团队：下面显示的是线路默认策略，开启团队（/team）后按当前线路生效。',
    cacheRoute: '当前线路：{route}',
    cacheMode: '模式：{mode}（{source}）',
    cacheInterval: '间隔：{seconds} 秒',
    cacheArmed: '线路已证明有缓存命中，满足 auto 的开启条件。',
    cacheNotArmed: 'auto 模式：等这条线路自己报告过一次缓存命中才会真正发保活。',
    cacheStopped: '已停止：{reason}',
    cachePings: '保活 {pings} 次（命中 {hits}，读 {tokens} token）',
    cacheRequests: '本会话真实请求 {requests} 次，缓存命中率 {ratio}',
    cacheRatioUnknown: '（还没有 usage 数据）',
    cacheWhy: '{id}：{mode}，TTL {ttl} —— {why}',
    cacheOverrideTitle: '线路覆盖（留空 = 用上面的默认策略）',
    cacheRouteKey: '线路（provider/model、provider 或族 id）',
    cacheRouteMode: '模式',
    cacheRouteInterval: '间隔（秒）',
    cacheAdd: '添加覆盖',
    cacheRemove: '删除',
    cacheModeAuto: 'auto（推荐）',
    cacheModeOn: 'on（强制）',
    cacheModeOff: 'off（关）',
    reportsTitle: '队员的结构化汇报（report_result）：',
    reportLine: '{name} · {status}{unresolved}',
    reportUnresolved: '，未决 {count} 项（阻止验收）',
    reportNotDelivered: '，**投递给 Lead 失败**（Lead 没收到这条）',
    reportsDropped: '另有 {dropped} 条更早的汇报未展示（记录上限 {cap} 条）。',
    reportsEmpty: '还没有队员交结构化汇报。',
    sessionsTitle: '会话记忆（宿主重启后自动恢复开团的会话）：',
    sessionsLine: '{tracked} 个会话在案 · 本进程已恢复 {restored} 次',
    hostMethod: '宿主拒绝了非 POST 请求（本页有 bug，请反馈）',
    hostGate: '宿主拒绝了这次请求：缺少插件闸门头（本页有 bug，请反馈）',
    hostCrossOrigin: '宿主拒绝了跨站请求（请从 DSH 自己的页面打开插件页）',
    httpError: '宿主返回了 HTTP {status}（路由可能没注册成功）',
    timeout: '请求超时：宿主没有在 20 秒内响应。',
    modelLabel: '模型',
    effortLabel: '思考强度',
    batchLabel: '批量调用',
    batchTip: '开（默认）= 这名队员在自己的作用域多拿一个 run_code：原生工具照常直接调用，同时可以在一个程序里批量调用多个工具（官方 both 档）。关 = 完全沿用所选 agent 预设自己的呈现档（选 PTC 就是纯 PTC）。改动只对之后新派的队员生效。',
    bulkBatchLabel: '批量调用（应用到全部角色）',
    bulkBatchTip: '打勾 = 全部开；去掉 = 全部关。这一格只管批量调用，不会动模型、思考强度与预设。',
    bulkBatchMixed: '（各角色当前不一致）',
    bulkTitle: '统一选择队员模型、思考强度、agent 预设与批量调用',
    recommendLabel: '推荐',
    recommendTip: '按角色分工一次填好「agent 预设」与「批量调用」两格并直接保存：查资料/审查/汇报型 = 纯 PTC（送模型只有一个 run_code，每轮少一大截工具清单，且只有这一档能拿到 ops_batch/ops_result）；改代码/写文档型 = 保留批量调用（原生 edit/write 直调）。模型与思考强度不动。',
    recommendNone: '宿主没有回传推荐取值（配置页读到的是旧版插件？重启 DSH 后重试）',
    recommendSaved: '已按角色分工填好「agent 预设 + 批量调用」并保存（模型与思考强度未改动）。只对**之后新派的队员**生效。',
    bulkAppliesAll: '（作用于全部 {count} 个角色）',
    bulkLabel: '模型（应用到全部角色）',
    bulkMixed: '（各角色当前不一致）',
    bulkHint: '四个控件都是「一次改全部」：模型选一次就作用于下面每个角色，思考强度同理（但强度依附于模型，所以先把模型统一）。换模型时强度会重算：仍然支持的档位保留，不支持的退回「模型默认」。预设与批量调用两格各自独立，不依附模型也不依附彼此。设置完仍可单独改某一个角色。',
    bulkEffortLabel: '思考强度（应用到全部角色）',
    bulkEffortMixedModels: '各角色模型不一致：档位是每个模型各自广告的，先把上面的模型统一成一个，才能统一思考强度。',
    bulkEffortNoModel: '还没有统一模型（当前是「跟随 Lead」）：强度依附于模型，先在上面选一个模型。',
    bulkEffortNone: '这个模型没有广告任何思考档位（官方规则：没有 reasoning 元数据就没有档位可选），所以没有可统一的值。',
    bulkEffortNoCatalog: '模型目录没读到（原因见上方告警）：档位无从校验，所以暂时不能统一思考强度。',
    inherit: '跟随 Lead（默认）',
    missingModel: '{label}（不在当前模型目录）',
    presetLabel: 'agent 预设',
    presetInherit: '跟随 Lead（默认）',
    presetMissing: '本机没装',
    presetBroken: '那份组合加载失败',
    presetStale: '{id}（当前不可用）',
    presetAppliesNext: '预设决定这名队员用哪一套工具与提示词。它只在**派队员那一刻**绑定：改动只对之后新派的队员生效，已在跑的与历史里的队员保持它创建时的组合。',
    bulkPresetLabel: 'agent 预设（应用到全部角色）',
    bulkPresetHint: '这一列与前两列互不影响：可以全队统一一份，也可以逐角色不同。注意缓存代价 —— 队员的系统提示词前缀按「同一份预设 + 同一个模型」共享，混用多种预设会把前缀切成几份，跨组不再命中。',
    bulkPresetNoRegistry: '读不到注册表里的 agent 预设（agentPresets 域服务缺席），所以这一列暂时不能改。',
    presetNameStandard: '标准模式',
    presetNamePtc: 'PTC 模式',
    presetNameMinimal: '极简模式',
    presetNameCordis: '创造模式',

    effortInherit: '跟随 Lead：该角色没有指定模型，思考强度与 Lead 相同。',
    effortNone: '该模型未广告思考强度（官方规则：没有 reasoning 元数据就没有档位可选）。',
    effortUnknown: '已保存的模型不在当前模型目录里，强度是否合法无法校验；重新选一次模型即可。',
    effortDefault: '不指定（模型默认）',
    catalogMissing: '模型目录读取失败，这里只能选「跟随 Lead」或保留已保存的值。',
    save: '保存',
    saving: '保存中…',
    saved: '已保存，派发队员时生效。',
    saveFailed: '保存失败：{message}',
    saveConflict: '保存冲突：{message}（磁盘上的配置已被其他会话改过，点「重新载入」取回最新值再改。）',
    unknownError: '未知错误',
    discard: '放弃改动',
    reload: '重新载入',
    reloaded: '已按磁盘上的配置重新载入。',
    reset: '全部恢复默认',
    resetConfirm: '再点一次确认清除',
    resetDone: '已清除配置文件：所有角色跟随 Lead。',
    resetFailed: '清除失败：{message}',
    footnote: '默认（这里不选模型）= 该队员与 Lead 使用完全相同的模型与思考强度；只有明确选定的角色才会被覆盖。配置写在 DSH 主目录的 dispatch-agent-team.json，保存后下一次派队员生效。',
    // ── 工作区画布 ──
    wsEnter: '进入工作区',
    wsTitle: '调度模式智能体团队 · 工作区',
    wsSubtitle: '真实团队拓扑（来自会话日志与域服务）',
    wsSnapshot: '团队已结束 · 历史快照',
    wsClose: '退出',
    wsZoom: '缩放',
    wsFit: '适配窗口',
    wsFlow: '流光',
    wsWeak: '弱关系',
    wsCoreOpen: '展开协作核',
    wsCoreClose: '收起协作核',
    wsLoading: '正在读取团队拓扑…',
    wsRetry: '重试',
    wsNotEnabled: '这个会话还没有开启团队。先用 /team 开启，再进入工作区。',
    wsEmpty: '团队里还没有队员（Lead 尚未派活）。派第一个队员后回来就能看到拓扑。',
    wsLoadFailed: '读取失败：{message}',
    wsMembers: '队员',
    wsRunning: '进行中',
    wsDelivered: '已交付',
    wsRelations: '承接关系',
    wsHit: '缓存命中率',
    wsTotalOut: '总输出',
    wsAvgTps: '平均 TPS',
    wsTotalTokens: '总 token',
    wsRealData: '真实会话日志',
    wsTodo: 'TODO',
    wsModelNone: '(未记录)',
    // 没有 provider usage 时的占位（与「测到 0」区分开，见 wsCard 里的长注释）。
    wsNoUsage: '—',
    // 只落了 reasoning 块的回合（被中止）的标注，如实说明这不是正式正文。
    wsReasoningNote: '仅思考内容（本轮被中止，未产生正式回复）',
    wsRoleLead: 'Lead',
    wsStateRunning: '进行中',
    wsStateDone: '已交付',
    wsStateIdle: '待命',
    wsStateFailed: '失败',
    wsCellStop: '停止原因',
    wsStopMaxTokens: '输出达上限（发「继续」可续跑）',
    wsStopError: '上一轮报错',
    wsPendingStep: '正在生成本步回复…',
    // 有正文时思考折成一行，这是那一行的标题（点开才看正文）。
    wsThinking: '思考过程',
    // 流式覆盖层里「思考正在打」的标注（与「本轮被中止只剩思考」区分开）。
    wsLiveThinking: '正在思考…',
    wsLegendLead: '进行中：蓝虚线，流光 Lead → 队员',
    wsLegendDone: '已交付：绿实线，流光 队员 → Lead',
    wsLegendHandoff: '承接：紫线，流光 写方 → 读方（越粗共享文件越多）',
    wsLegendCore: '协作核：互相读写的成员收进容器（点击展开内部关系）',
    wsLegendCol: '列 = 真实依赖深度 · 环 = 上下文占用（悬停看数值）· 悬停卡片看任务归属',
    // 注意：这里曾有 4 条 wsDrawerRelations / wsDrawerNoRel / wsDrawerTasks / wsDrawerNoTask，
    // 是 2026-10-08 用户要求「点击卡片后只保留 [指标] + [对话窗口]」时随区块一起删渲染、
    // 却忘了删文案的残骸（零引用死键，2026-10-14 清掉；selftest 有闸门不许这类残骸再攒起来）。
    wsDrawerConvo: '对话详情',
    wsDrawerConvoLoading: '正在读取对话…',
    wsDrawerConvoEmpty: '日志里没有可展示的对话轮次。',
    wsDrawerConvoFailed: '对话读取失败：{message}',
    wsImage: '图片',
    wsImageFailed: '图片读取失败：{message}',
    wsImageUpload: '添加图片',
    wsImageRemove: '移除这张图片',
    wsImageTooBig: '图片太大（上限 {limit}）',
    wsImageUnsupported: '不支持这种图片格式',
    wsImageSending: '正在上传图片…',
    // 提问卡：官方提问卡未被关闭时的如实提示（legacy 模式，见 lib/runtime.js 的 teamAnswer）。
    wsQNotSettled: '答案已发出（消息投递），但官方提问卡不会被关闭',
    // 2026-10-13 改写：本包的 preset 早就把 tool-ask-user 钉成 mode: timed
    // （presets/dispatch-mode.patch.yml），所以旧文案里「去设 timed」这条建议**已经不作数**。
    // 现在只有拿不到官方提问卡时才会落到消息投递，原因只有这几类，照实列出来。
    wsQNotSettledWhy: '原因：{reason}。弹窗回答优先走官方那张提问卡（与聊天界面等价）；只有取不到它时才退成消息投递。请确认这个会话是「调度模式」且官方聊天界面正开在同一个窗口里。',
    wsWhoUser: '用户输入',
    wsWhoAssistant: '助手回复',
    wsWhoTools: '工具调用',
    wsWhoTeam: '团队消息',
    wsWhoNotice: '子代理通知',
    wsWhoSystem: '系统',
    wsWhoMe: '我',
    wsQuestions: '待你回答（{count} 条）',
    wsQAnswered: '已回答',
    wsQAnswerBlank: '（已回答）',
    wsQSubmit: '提交回答',
    wsQCustom: '自定义回答…',
    wsQAnsweredOk: '已回答',
    // 弹窗里点「提交回答」走了官方那张卡（等价通道）时的说明。
    wsQAnsweredSame: '已通过官方提问卡回答（与在聊天界面回答等价）',
    // 官方卡通道失败：如实报错，不偷偷降级成消息投递。
    wsQCardFailed: '官方提问卡拒绝了这个答案：{message}',
    // answer() 会 resolve，但那次工具调用其实以 isError 结算了（提问已死）。
    wsQCardDead: '答案已送出，但这次提问当场报错了（工具调用未接受它），请改用官方聊天界面回答',
    // 送出去了、但弹窗这边读不到结算结果（没有活体事件流可查）。
    wsQAnsweredSent: '已通过官方提问卡送出答案',
    wsSendPlaceholder: '给 {name} 发消息…（Enter 发送，Shift+Enter 换行）',
    wsSend: '发送',
    wsSending: '发送中…',
    wsSent: '已发送',
    wsSendFailed: '发送失败：{message}',
    wsCellModel: '模型',
    wsCellStatus: '状态',
    wsCellRuntime: '运行时长',
    wsCellTps: '输出速度',
    wsTpsFormula: '输出速度 = 输出 token ÷ 生成时长。生成时长 = 回合总时长 − 工具调用占用（{runtime} − {busy}），工具等待期间模型并没有在吐 token，算进分母会量成「含工具等待的吞吐」。',
    wsTpsFormulaNoBusy: '输出速度 = 输出 token ÷ 生成时长。这名成员还没有可结算的工具调用时长，生成时长 = 回合总时长（{runtime}）。',
    wsCellOut: '输出 token',
    wsCellIn: '输入 token',
    wsCellCache: '缓存读取',
    wsCellHit: '缓存命中率',
    wsCellCtx: '上下文占用',
    wsCellTodo: 'TODO',
    wsCellDispatch: 'Lead 派活',
    wsCoreLabel: '协作核 ×{count}（互相读写 · 点击展开）',
    wsSharedFiles: '{count} 个共享文件',
    wsDispatchMsg: '{count} 条派活消息',
    wsMsgUnit: '{count} 条',
    wsDeliveredTip: '已交付（{count} 条汇报）',
    wsNotes: '{count} 条宿主提示（悬停查看）',
    // ── 展开层（2026-10-14）─────────────────────────────────────────────────
    // 「输入」「输出」用的是官方 row.input / row.output 的 zh 真值
    // （official-conversation-client.js:14770-14772），en 是 IN / OUT（同文件 :15142-15144）。
    // 不自造措辞：用户 2026-10-09 就是拿「和官方对话框不一样」报的障。
    wsDetailInput: '输入',
    wsDetailOutput: '输出',
    wsDetailOutputErr: '输出（失败）',
    wsDetailLoading: '正在读取…',
    wsDetailFailed: '详情读取失败：{message}',
    wsDetailFull: '展开全文',
    wsDetailCollapse: '收起全文',
    wsDetailCapped: '（以上为截断预览，完整正文见官方会话页）',
    wsDetailZoom: '放大查看',
    wsDetailZoomTip: '在随窗口自适应的大面板里看完整的输入与输出',
    wsDetailZoomClose: '关闭放大面板',
    wsToolFailedSuffix: '（失败）',
    // 计划审批卡（2026-10-14 P0-3）。id 与选项 label 一律用官方英文原词
    // （dsh-plan-mode/lib/index.js:37-41），这里只翻**说明性**文字。
    wsQPlanApproved: '已批准：退出计划模式，按计划开始执行',
    wsQPlanRejected: '已退回继续规划：反馈会回到模型',
    wsQPlanDone: '已处理',
    // 「停止生成」：措辞用官方 locale 真值（official-conversation-client.js:14487
    // "input.stop": "停止生成"），不自造「中断/取消」。
    wsStopRun: '停止生成',
    wsStopRunTip: '叫停这个人当前这一步（与官方输入框旁那颗停止键同一条通道）',
    wsStopNoBridge: '读不到该会话的活体状态，这里无法停止；请在官方聊天界面停止',
    wsStopFailed: '停止失败：{message}',
    wsStopSent: '已请求停止，等这一步收尾',
    // 折叠的工具串（后端只发 count，句子在这儿拼）。不再提「查看」：
    // 官方那句 detail.moreInInspect 的前提是它真有 Inspect 按钮
    // （tool-client.js:1684-1688），本插件没有，照抄就是空头承诺。
    wsToolgroup: '另有 {count} 项工具调用（点开展开）',
    // 回合结局（P1-4）。{reason} 是宿主给的原词，不翻译。
    wsTurnError: '本轮结束异常（{reason}）',
    wsTurnMaxTokens: '本轮撞到输出上限，已停下（发「继续」可接着跑）',
    wsTurnInterrupted: '本轮被中止',
    // 逐行时间与复制（P1-3）。日期串的格式与**值**都照官方 locale：
    // clock.md / clock.ymd 与 copy / copied 的原文取自 dsh-client-locale/lib/client.js:933-934
    // 与 chat-client.js 的字典（本轮实读 asar，非自造措辞）。
    wsClockMd: '{m}月{d}日',
    wsClockYmd: '{y}年{m}月{d}日',
    wsCopy: '复制',
    wsCopied: '复制成功',
    wsCopyFailed: '复制失败（浏览器不允许这里写剪贴板）',
    // 宿主画布提示（graph.js 的七个降级事实，code → 键见 WS_NOTE_CODES）。
    // 句子在这儿拼，服务端只发 code + 数字 —— 理由同 taskTip / 折叠组 / 回合结局。
    wsNoteNoLiveAgent: '会话 {sessionId} 没有活体 agent，且 sessionPersistence 不可用：它的统计显示为 0（不是真的没跑过）',
    wsNotePersistReadFailed: '会话 {sessionId} 的持久日志读取失败：{message}（统计显示为 0，稍后自动重试）',
    wsNoteRosterReadFailed: '成员名单读取失败：{message}',
    wsNoteRecoveredProjection: '域服务里没有在册成员（团队可能已结束）：已从持久投影缓存恢复 {count} 个历史成员{tasks}，显示的是最后一次记录到的状态',
    wsNoteTasksSuffix: ' 与 {count} 条任务',
    wsNoteRecoveredLog: '域服务里没有在册成员（团队可能已结束）：已从 Lead 会话日志重建 {count} 个历史成员，显示的是最后一次记录到的状态',
    wsNoteNoHistoryRoster: '读不到历史成员名单：Lead 会话日志缺失或损坏，画布只显示 Lead',
    wsNoteTasksReadFailed: '任务板读取失败：{message}',
    // ── 从代码里搬进来的句子（2026-10-14）──────────────────────────────────
    // 判据：字典之外不许有中文字面量（selftest 有闸门）。这些原来硬编码在 DOM 上，
    // 补齐 en 也翻不到它们 —— 英文界面下就是整屏中文里夹一句更硬的中文。
    wsToolCallGeneric: '工具调用',
    wsUnknownRoute: '（未知）',
    wsTtlSeconds: '{ttl} 秒',
    wsTtlUnknown: '未知（按不缓存处理，默认关闭）',
    wsCtxUsedFull: '{used} / {window} 上下文（{pct}%）',
    wsCtxUsedOnly: '已用 {used} 上下文',
    wsCtxWindowOnly: '上下文窗口 {n} · 本轮未记录用量',
    wsCtxUnrecorded: '上下文：未记录',
    wsHitFormula: '缓存命中率 = 缓存读取 / (缓存读取 + 新输入)',
    wsCoreTitle: '协作核：{members}',
    wsCoreTitleBody: '互相读写（内部 {count} 对关系）。点击展开',
    wsGraphShapeError: '宿主返回的图缺少 nodes/edges 字段',
    wsImageReadFailed: '读取失败',
    wsImageCountUnit: '{n} 张',
    wsCoreButtonTip: '互相读写的成员收进容器；展开可看内部关系',
    wsFlowButtonTip: '流光方向 = 信息流方向：Lead→队员（蓝）/ 队员→Lead（绿）/ 写→读（紫）',
    wsResizeTip: '拖动调整宽度',
    wsTaskTipHead: '任务板：{count} 条归 {name}',
    wsTaskTipMore: '…另有 {count} 条',
  }
  const en = {
    summary: 'Unify the model, reasoning effort, agent preset and batch calls across all roles at once, or set each role individually (Lead default otherwise; batch calls default to on)',
    configured: '{count}/{total} roles configured',
    unsaved: 'unsaved changes',
    loading: 'Loading configuration and model catalog…',
    loadFailed: 'Loading failed: {message}',
    modelsFailed: 'Model catalog unavailable: {message}',
    modelsEmpty: 'The model catalog is empty: the host returned no provider or model, so only “Follow Lead” is available.',
    noRoles: 'The host returned no role table: the get route must answer with roles.',
    diagnosticsTitle: 'Host diagnostics (the configuration file may be damaged):',
    notesTitle: 'Host info (nothing wrong; for troubleshooting only):',
    cacheTitle: 'Cache keepalive (1-token requests keep the prompt cache warm while teammates work)',
    cacheInactive: 'No team is enabled in this session yet: the list below is the per-route default. Enable it with /team and the current route applies.',
    cacheRoute: 'Current route: {route}',
    cacheMode: 'Mode: {mode} ({source})',
    cacheInterval: 'Interval: {seconds}s',
    cacheArmed: 'This route has proven a cache read, so auto mode is armed.',
    cacheNotArmed: 'auto mode: pings start only after this route reports a cache read once.',
    cacheStopped: 'Stopped: {reason}',
    cachePings: '{pings} keepalive pings ({hits} hit, {tokens} tokens read)',
    cacheRequests: '{requests} real requests this session, cache hit ratio {ratio}',
    cacheRatioUnknown: '(no usage data yet)',
    cacheWhy: '{id}: {mode}, TTL {ttl} — {why}',
    cacheOverrideTitle: 'Per-route overrides (empty = use the defaults above)',
    cacheRouteKey: 'Route (provider/model, provider, or family id)',
    cacheRouteMode: 'Mode',
    cacheRouteInterval: 'Interval (s)',
    cacheAdd: 'Add override',
    cacheRemove: 'Remove',
    cacheModeAuto: 'auto (recommended)',
    cacheModeOn: 'on (force)',
    cacheModeOff: 'off',
    reportsTitle: 'Structured teammate reports (report_result):',
    reportLine: '{name} · {status}{unresolved}',
    reportUnresolved: ', {count} unresolved (blocks acceptance)',
    reportNotDelivered: ', NOT delivered to the lead',
    reportsDropped: '{dropped} earlier report(s) not shown (record cap {cap}).',
    reportsEmpty: 'No structured report yet.',
    sessionsTitle: 'Session memory (teams restored after a host restart):',
    sessionsLine: '{tracked} session(s) on record · {restored} restored in this process',
    hostMethod: 'The host rejected a non-POST request (this page has a bug; please report it).',
    hostGate: 'The host rejected this request: the plugin gate header was missing (this page has a bug; please report it).',
    hostCrossOrigin: 'The host rejected a cross-origin request (open the plugin page from DSH itself).',
    httpError: 'The host answered HTTP {status} (the route may not have registered).',
    timeout: 'Request timed out: the host did not answer within 20 seconds.',
    modelLabel: 'Model',
    effortLabel: 'Reasoning effort',
    batchLabel: 'Batch calls',
    batchTip: 'On (the default) = this teammate also gets run_code in its own scope: native tools stay directly callable, and one program can call many tools in batch (the official "both" presentation). Off = the role follows its selected agent preset exactly (PTC stays pure PTC). Applies to teammates spawned after you save.',
    bulkBatchLabel: 'Batch calls (applies to all roles)',
    bulkBatchTip: 'Checked = all on; unchecked = all off. This box only changes batch calls; it leaves model, effort and preset alone.',
    bulkBatchMixed: '(roles currently differ)',
    bulkTitle: 'Set every teammate model, reasoning effort, agent preset and batch calls at once',
    recommendLabel: 'Recommended',
    recommendTip: 'Fill the agent preset and batch-call columns per role, then save: research/review/report roles go pure PTC (the model sees only run_code - a much smaller tool list every turn, and only that tier gets ops_batch/ops_result); code/document roles keep batch calls (native edit/write). Model and reasoning effort are left untouched.',
    recommendNone: 'The host returned no recommended values (page read an older plugin build? Restart DSH and try again)',
    recommendSaved: 'Agent preset and batch calls filled per role and saved (model and reasoning effort untouched). Applies to teammates spawned from now on.',
    bulkAppliesAll: '(applies to all {count} roles)',
    bulkLabel: 'Model (applies to all roles)',
    bulkMixed: '(roles currently differ)',
    bulkHint: 'All four controls apply to every role at once: pick a model once and every role below uses it; the same for reasoning effort (which attaches to a model, so unify the model first). Effort is recomputed when the model changes: still-valid efforts are kept, others fall back to the model default. The preset box and the batch-calls box are independent of the other two and of each other. You can still adjust any single role afterwards.',
    bulkEffortLabel: 'Reasoning effort (applies to all roles)',
    bulkEffortMixedModels: 'The roles use different models, and effort tiers are advertised per model: unify the model above first, then set one effort here.',
    bulkEffortNoModel: 'No model is unified yet (every role follows the Lead): effort attaches to a model, so pick one above first.',
    bulkEffortNone: 'This model advertises no reasoning tiers (official rule: no reasoning metadata means no tiers), so there is nothing to unify.',
    bulkEffortNoCatalog: 'The model catalog could not be read (see the warning above), so tiers cannot be checked and effort cannot be unified right now.',
    inherit: 'Follow Lead (default)',
    missingModel: '{label} (not in the current model catalog)',
    presetLabel: 'Agent preset',
    presetInherit: 'Follow Lead (default)',
    presetMissing: 'not installed here',
    presetBroken: 'failed to load',
    presetStale: '{id} (currently unavailable)',
    presetAppliesNext: 'The preset decides which tools and prompt this teammate runs with. It binds at spawn time only: changes apply to teammates spawned afterwards, while running and past teammates keep the composition they were created with.',
    bulkPresetLabel: 'Agent preset (applies to all roles)',
    bulkPresetHint: 'This column is independent of the two above: unify one preset for the whole team, or give each role its own. Mind the cache cost - a teammate system-prompt prefix is shared per (preset, model) pair, so mixing presets splits the prefix and cross-group hits stop.',
    bulkPresetNoRegistry: 'The agent preset registry could not be read (the agentPresets domain service is absent), so this column cannot be changed right now.',
    presetNameStandard: 'Standard mode',
    presetNamePtc: 'PTC mode',
    presetNameMinimal: 'Minimal mode',
    presetNameCordis: 'Creator mode',

    effortInherit: 'Follows Lead: this role names no model, so its reasoning effort is the Lead’s.',
    effortNone: 'This model advertises no reasoning effort (official rule: no reasoning metadata means no effort row).',
    effortUnknown: 'The saved model is not in the current catalog, so its effort cannot be checked; pick the model once to restore it.',
    effortDefault: 'Unspecified (model default)',
    catalogMissing: 'The model catalog could not be read, so only “Follow Lead” or the saved value can be kept here.',
    save: 'Save',
    saving: 'Saving…',
    saved: 'Saved. Applies the next time a teammate is spawned.',
    saveFailed: 'Save failed: {message}',
    saveConflict: 'Save conflict: {message} (another session changed the file; reload and edit again.)',
    unknownError: 'unknown error',
    discard: 'Discard changes',
    reload: 'Reload',
    reloaded: 'Reloaded from the configuration on disk.',
    reset: 'Reset all to default',
    resetConfirm: 'Click again to clear',
    resetDone: 'Configuration cleared: every role follows the Lead.',
    resetFailed: 'Reset failed: {message}',
    footnote: 'Default (no model picked here) = that teammate uses exactly the Lead’s model and reasoning effort; only the roles picked here are overridden. The file lives at dispatch-agent-team.json in the DSH home directory and applies to the next spawn.',
    // ── 工作区浮窗（与 zh 字典逐键对齐；键集合相等由 selftest 闸门钉住）──────
    // 这一整块此前**缺失**：浮窗的 118 句只有中文。补齐它只是必要条件 ——
    // 真正的根因在 wsText：它恒读 zh，连查都没查官方 locale（见该函数注释）。
    wsEnter: 'Open workspace',
    wsTitle: 'Dispatch Mode agent team · Workspace',
    wsSubtitle: 'Real team topology (from session logs and the domain service)',
    wsSnapshot: 'Team ended · historical snapshot',
    wsClose: 'Exit',
    wsZoom: 'Zoom',
    wsFit: 'Fit window',
    wsFlow: 'Flow',
    wsWeak: 'Weak links',
    wsCoreOpen: 'Expand core',
    wsCoreClose: 'Collapse core',
    wsLoading: 'Reading team topology…',
    wsRetry: 'Retry',
    wsNotEnabled: 'This session has no team yet. Run /team first, then open the workspace.',
    wsEmpty: 'No teammates yet (the Lead has not dispatched work). Dispatch one and come back to see the topology.',
    wsLoadFailed: 'Load failed: {message}',
    wsMembers: 'Teammates',
    wsRunning: 'Running',
    wsDelivered: 'Delivered',
    wsRelations: 'Hand-offs',
    wsHit: 'Cache hit',
    wsTotalOut: 'Total output',
    wsAvgTps: 'Avg TPS',
    wsTotalTokens: 'Total tokens',
    wsRealData: 'Real session log',
    wsTodo: 'TODO',
    wsModelNone: '(not recorded)',
    wsNoUsage: '—',
    wsReasoningNote: 'Reasoning only (this turn was interrupted and produced no reply)',
    wsRoleLead: 'Lead',
    wsStateRunning: 'Running',
    wsStateDone: 'Delivered',
    wsStateIdle: 'Idle',
    wsStateFailed: 'Failed',
    wsCellStop: 'Stop reason',
    wsStopMaxTokens: 'Hit the output limit (send “continue” to resume)',
    wsStopError: 'Last turn errored',
    wsPendingStep: 'Generating this step…',
    wsThinking: 'Reasoning',
    wsLiveThinking: 'Thinking…',
    wsLegendLead: 'Running: blue dashed, flow Lead → teammate',
    wsLegendDone: 'Delivered: green solid, flow teammate → Lead',
    wsLegendHandoff: 'Hand-off: violet, flow writer → reader (thicker = more shared files)',
    wsLegendCore: 'Core: members that read and write each other, grouped in a container (click to expand)',
    wsLegendCol: 'Column = real dependency depth · Ring = context usage (hover for numbers) · Hover a card for task ownership',
    wsDrawerConvo: 'Conversation',
    wsDrawerConvoLoading: 'Reading the conversation…',
    wsDrawerConvoEmpty: 'No conversation turns are available in the log.',
    wsDrawerConvoFailed: 'Failed to read the conversation: {message}',
    wsImage: 'Image',
    wsImageFailed: 'Failed to read the image: {message}',
    wsImageUpload: 'Add image',
    wsImageRemove: 'Remove this image',
    wsImageTooBig: 'Image too large (limit {limit})',
    wsImageUnsupported: 'Unsupported image format',
    wsImageSending: 'Uploading images…',
    wsQNotSettled: 'Answer sent (as a message), but the official question card will not close',
    wsQNotSettledWhy: 'Reason: {reason}. Answers prefer the official question card (equivalent to the chat view); only when that card is unavailable do they fall back to message delivery. Confirm this session runs in Dispatch Mode and the official chat view is open in the same window.',
    wsWhoUser: 'You',
    wsWhoAssistant: 'Assistant',
    wsWhoTools: 'Tool calls',
    wsWhoTeam: 'Team message',
    wsWhoNotice: 'Subagent notice',
    wsWhoSystem: 'System',
    wsWhoMe: 'Me',
    wsQuestions: 'Waiting for your answer ({count})',
    wsQAnswered: 'Answered',
    wsQAnswerBlank: '(answered)',
    wsQSubmit: 'Submit answer',
    wsQCustom: 'Custom answer…',
    wsQAnsweredOk: 'Answered',
    wsQAnsweredSame: 'Answered through the official question card (equivalent to answering in the chat view)',
    wsQCardFailed: 'The official question card rejected this answer: {message}',
    wsQCardDead: 'The answer was sent but this question errored on the spot (the tool call did not accept it). Please answer in the official chat view instead.',
    wsQAnsweredSent: 'Answer sent through the official question card',
    wsSendPlaceholder: 'Message {name}… (Enter to send, Shift+Enter for a newline)',
    wsSend: 'Send',
    wsSending: 'Sending…',
    wsSent: 'Sent',
    wsSendFailed: 'Send failed: {message}',
    wsCellModel: 'Model',
    wsCellStatus: 'Status',
    wsCellRuntime: 'Runtime',
    wsCellTps: 'Output speed',
    wsTpsFormula: 'Output speed = output tokens ÷ generating time. Generating time = turn total − tool-call occupancy ({runtime} − {busy}); the model emits nothing while a tool runs, so counting that wait would measure throughput-with-waiting instead of model speed.',
    wsTpsFormulaNoBusy: 'Output speed = output tokens ÷ generating time. This member has no settled tool-call time yet, so generating time = turn total ({runtime}).',
    wsCellOut: 'Output tokens',
    wsCellIn: 'Input tokens',
    wsCellCache: 'Cache read',
    wsCellHit: 'Cache hit',
    wsCellCtx: 'Context usage',
    wsCellTodo: 'TODO',
    wsCellDispatch: 'Lead dispatches',
    wsCoreLabel: 'Core ×{count} (mutual reads/writes · click to expand)',
    wsSharedFiles: '{count} shared files',
    wsDispatchMsg: '{count} dispatch messages',
    wsMsgUnit: '{count} msgs',
    wsDeliveredTip: 'Delivered ({count} reports)',
    wsNotes: '{count} host notes (hover to read)',
    wsDetailInput: 'IN',
    wsDetailOutput: 'OUT',
    wsDetailOutputErr: 'OUT (failed)',
    wsDetailLoading: 'Reading…',
    wsDetailFailed: 'Failed to read details: {message}',
    wsDetailFull: 'Show full text',
    wsDetailCollapse: 'Collapse',
    wsDetailCapped: '(truncated preview; the full text is on the official session page)',
    wsDetailZoom: 'Expand',
    wsDetailZoomTip: 'Show the full input and output in a viewport-sized panel',
    wsDetailZoomClose: 'Close the expanded panel',
    wsToolFailedSuffix: ' (failed)',
    wsQPlanApproved: 'Approved: leaving plan mode, carrying out the plan',
    wsQPlanRejected: 'Sent back to planning: the feedback goes to the model',
    wsQPlanDone: 'Handled',
    wsStopRun: 'Stop generating',
    wsStopRunTip: 'Interrupt this member’s current step (same channel as the official stop button)',
    wsStopNoBridge: 'The live state of this session is unavailable, so it cannot be stopped here; stop it in the official chat view',
    wsStopFailed: 'Stop failed: {message}',
    wsStopSent: 'Stop requested, waiting for this step to finish',
    wsToolgroup: '{count} more tool calls (click to expand)',
    wsTurnError: 'This turn ended abnormally ({reason})',
    wsTurnMaxTokens: 'This turn hit the output limit and stopped (send “continue” to resume)',
    wsTurnInterrupted: 'This turn was interrupted',
    wsClockMd: '{m}/{d}',
    wsClockYmd: '{y}-{m}-{d}',
    wsCopy: 'Copy',
    wsCopied: 'Copied',
    wsCopyFailed: 'Copy failed (the browser blocked clipboard writes here)',
    wsNoteNoLiveAgent: 'Session {sessionId} has no live agent and sessionPersistence is unavailable: its stats show 0 (it did not actually run)',
    wsNotePersistReadFailed: 'Failed to read the persisted log of session {sessionId}: {message} (stats show 0; it retries automatically)',
    wsNoteRosterReadFailed: 'Failed to read the member roster: {message}',
    wsNoteRecoveredProjection: 'No members registered in the domain service (the team may have ended): recovered {count} historical members from the durable projection cache{tasks}, showing the last recorded state',
    wsNoteTasksSuffix: ' and {count} tasks',
    wsNoteRecoveredLog: 'No members registered in the domain service (the team may have ended): rebuilt {count} historical members from the Lead session log, showing the last recorded state',
    wsNoteNoHistoryRoster: 'No historical member roster: the Lead session log is missing or corrupt; the canvas shows only the Lead',
    wsNoteTasksReadFailed: 'Failed to read the task board: {message}',
    // 从代码里搬进来的几句（原来硬编码在 DOM 上，英文界面翻不到）
    wsToolCallGeneric: 'Tool call',
    wsUnknownRoute: '(unknown)',
    wsTtlSeconds: '{ttl}s',
    wsTtlUnknown: 'unknown (treated as not cached, off by default)',
    wsCtxUsedFull: '{used} / {window} context ({pct}%)',
    wsCtxUsedOnly: '{used} tokens used',
    wsCtxWindowOnly: 'Context window {n} · no usage recorded this turn',
    wsCtxUnrecorded: 'Context: not recorded',
    wsHitFormula: 'Cache hit = cache read / (cache read + new input)',
    wsCoreTitle: 'Core: {members}',
    wsCoreTitleBody: 'mutual reads/writes ({count} pairs). Click to expand',
    wsGraphShapeError: 'the host response is missing nodes/edges',
    wsImageReadFailed: 'Failed to read the file',
    wsImageCountUnit: 'images',
    wsCoreButtonTip: 'Members that read and write each other are grouped in a container; expand it to see the internal relations',
    wsFlowButtonTip: 'Flow direction = information direction: Lead → teammate (blue) / teammate → Lead (green) / writer → reader (violet)',
    wsResizeTip: 'Drag to resize',
    wsTaskTipMore: '…and {count} more',
    wsTaskTipHead: 'Task board: {count} for {name}',
    wsTaskTipMore: '…and {count} more',
  }

  function fmt(text, params) {
    if (typeof text !== 'string') return ''
    if (params === undefined || params === null) return text
    return text.replace(/\{(\w+)\}/g, (match, key) => (params[key] === undefined ? match : String(params[key])))
  }

  // ── 当前界面语言（2026-10-14 补，这是浮窗此前恒中文的根因）──────────────
  // wsText / fallbackText 原来直接读 zh。官方 locale 提供三件东西
  // （本轮实读 dsh-client-locale/lib/client.js）：
  //   * getSnapshot().active —— 当前语言 :1250-1252
  //   * subscribe(fn) —— 快照变化通知；**语言切换与字典注册都会** publish（:1443 / :1397）:1260-1265
  //   * translate(ns,key) 走 active 的 fallbackChain，缺键**原样回 key** :1423-1427
  // 这里的取法与 makeText(props.t) 同一个兜底次序：官方链 → 本文件 zh → key。
  // 「缺键退 zh 而不是退 key」是刻意的：宁可给用户一句中文，也不给一串 camelCase。
  const localeState = { active: 'zh', ready: false, face: null, bind: null, bindOfficial: null }
  /** 记下 apply() 拿到的 locale 服务（不在 apply 里查 active：官方 bundle 可能晚于我们加载）。 */
  function localeAttach(face) {
    localeState.face = face
    localeState.bind = typeof face.bind === 'function' ? face.bind(NS) : null
    // 内置组合的显示名归官方那个 bundle 所有（注册表只回 id），绑同一个命名空间读它，
    // 而不是在插件里复制一份中文。那个 bundle 没加载时 bind 返回的函数会原样回 key，
    // officialPresetText 把那种情况判成「没命中」再退回本文件字典。
    localeState.bindOfficial = typeof face.bind === 'function' ? face.bind(OFFICIAL_PRESET_NS) : null
    localeSyncActive()
  }
  /** 把当前语言读进 localeState.active；读不到就维持 zh（首字母判不出时的保守值）。 */
  function localeSyncActive() {
    const face = localeState.face
    if (face === null || typeof face.getSnapshot !== 'function') return
    let snap
    try { snap = face.getSnapshot() } catch { return }
    const active = snap === null || snap === undefined ? '' : String(snap.active ?? '')
    if (active !== '' && active !== localeState.active) localeState.active = active
    localeState.ready = true
  }
  /**
   * 查一个文案键。**顺序**：官方 locale 链（跟用户选的语言走）→ 本文件 zh → key。
   * 官方缺键时会原样把 key 回传（translate :1425 的 ?? key），所以「回传到的一样是 key」
   * 就当作没命中，继续退 zh —— 否则界面上会出现 'wsSend' 这种字符串。
   * @param {string} key - 字典键。
   * @param {object} [params] - {name} 占位替换。
   * @returns {string}
   */
  function localeText(key, params) {
    if (localeState.bind !== null) {
      let out
      try { out = localeState.bind(key) } catch { out = undefined }
      if (typeof out === 'string' && out !== '' && out !== key) return fmt(out, params)
    }
    const raw = typeof zh[key] === 'string' ? zh[key] : key
    return fmt(raw, params)
  }
  /** 官方给内置组合起名字的那个命名空间（dsh-client-ui-agent-preset 注册，见其 client.js:1591）。 */
  const OFFICIAL_PRESET_NS = 'settings.agentPreset'
  /**
   * 内置组合的 id → 官方文案键。注册表**不发布**这四份的名字（list() 只回 id），
   * 名字是官方客户端本地化的：dsh-client-ui-agent-preset/lib/client.js:225-242 那张表 +
   * 同文件 :283-316 的两份字典。这里只抄「键名」，文案仍走官方 locale —— 官方改措辞我们跟着走，
   * 不在插件里复制第二份中文（drift-check 逐键核对这张表与官方那份是否还一致）。
   */
  const BUILT_IN_PRESET_NAME_KEYS = { standard: 'presetStandardName', ptc: 'presetPtcName', minimal: 'presetMinimalName', cordis: 'presetCordisName' }
  /**
   * 官方那个 bundle 没加载 / 没注册时的退路：本文件字典里的同文案键。
   * 键名**逐个字面写出来**（不是按 id 拼）—— 拼出来的键闸门查不到引用，就会变成
   * 「定义了却没人引用」的死键，下次改 UI 的人无从判断还有没有用。
   */
  const BUILT_IN_PRESET_LOCAL_KEYS = { standard: 'presetNameStandard', ptc: 'presetNamePtc', minimal: 'presetNameMinimal', cordis: 'presetNameCordis' }
  /** 读官方命名空间里的一个键；那个 bundle 没加载/没注册/缺键时回 ''，由调用方退回自己的字典。 */
  function officialPresetText(key) {
    if (localeState.bindOfficial === null) return ''
    let out
    try { out = localeState.bindOfficial(key) } catch { return '' }
    if (typeof out !== 'string' || out === '' || out === key) return ''
    return out
  }
  /**
   * 预设的显示名，顺序照官方 presetDisplayText：注册表发布的 name → 官方本地化的内置名 →
   * 本文件字典（那个 bundle 没加载时）→ id。
   * @param {{id:string,name:string}} preset - normalizePresets 出来的一行。
   * @returns {string}
   */
  function presetLabel(preset) {
    if (preset.name !== '') return preset.name
    const key = BUILT_IN_PRESET_NAME_KEYS[preset.id]
    if (key !== undefined) {
      const official = officialPresetText(key)
      if (official !== '') return official
      const localKey = BUILT_IN_PRESET_LOCAL_KEYS[preset.id]
      if (localKey === undefined) return preset.id
      const own = localeText(localKey)
      // localeText 拿不到时会原样把键名回传，那种情况不能当文案用。
      if (own !== localKey) return own
    }
    return preset.id
  }
  /** 当前是不是英文界面（决定那些**双语数据**取哪一份，如工具标签）。 */
  function localeIsEnglish() {
    return /^en\b/i.test(String(localeState.active ?? 'zh')) === true
  }
  /**
   * 组件外（apiCall 等）用的文案：与组件内同一条链（官方 locale → 本文件 zh → key）。
   *
   * 2026-10-14 修正：原来这里**只**读 zh。宿主回执的本地化也走它，所以英文界面下
   * 那几句（超时、CSRF、HTTP 状态）一直是中文。
   */
  function fallbackText(key, params) {
    return localeText(key, params)
  }

  /**
   * 框架给组件的 `t` 绑在 options.locale 的命名空间上；字典没注册时官方查找链会原样返回 key
   * （dsh-client-locale/lib/types/client/index.d.ts:86-90），所以这里兜一层：拿不到就用本文件
   * 自带的 zh 文案（本插件的主语言），保证任何情况下页面都有可读文字。
   */
  function makeText(t) {
    return function text(key, params) {
      let out
      if (typeof t === 'function') {
        try { out = t(key) } catch (error) { out = undefined }
      }
      if (typeof out !== 'string' || out.length === 0 || out === key) out = zh[key]
      if (typeof out !== 'string') out = key
      return fmt(out, params)
    }
  }

  // ── 宿主路由 ────────────────────────────────────────────────────────────────
  /** 宿主少数几条英文回执 → 字典键（它们是路由级拒绝，不经业务错误通道）。 */
  const HOST_ERROR_KEYS = {
    'method not allowed': 'hostMethod',
    'missing plugin gate header': 'hostGate',
    'cross-origin request rejected': 'hostCrossOrigin',
  }

  /** 请求超时上限：宿主没挂，但它挂起时不许把页面永久锁在 busy。 */
  const API_TIMEOUT_MS = 20000

  /**
   * 调一次宿主路由。**永不 reject**（调用方只处理 {ok:false}）。
   * 三件事都在这里收口：超时、HTTP 状态、非 JSON 回执——否则失败原因会以
   * 「Unexpected token < in JSON」这种原始形态直接显示给用户。
   */
  function apiCall(op, args) {
    // `x-dsh-plugin` 是宿主 half 在每个请求上要求的跨站（CSRF）闸门头。
    const headers = { 'content-type': 'application/json', 'x-dsh-plugin': PLUGIN_HEADER }
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined
    const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), API_TIMEOUT_MS)
    const done = () => { if (timer !== undefined) clearTimeout(timer) }
    return fetch(API_PATH, {
      method: 'POST',
      headers,
      body: JSON.stringify({ op, args: args || {} }),
      ...(controller === undefined ? {} : { signal: controller.signal }),
    }).then((response) => {
      const status = response.status
      return response.text().then((body) => {
        let parsed
        try { parsed = body === '' ? {} : JSON.parse(body) } catch (error) { parsed = undefined }
        if (parsed !== undefined && parsed !== null && typeof parsed === 'object') return parsed
        // 404/405 之类由宿主以外的东西应答时走这里：把状态码如实报出来，不要假装是业务失败。
        return { ok: false, error: fallbackText('httpError', { status }) }
      })
    }).catch((error) => {
      const name = error === null || error === undefined ? '' : String(error.name || '')
      return { ok: false, error: name === 'AbortError' ? fallbackText('timeout') : String((error && error.message) || error) }
    }).then((result) => { done(); return result }, (error) => { done(); return { ok: false, error: String((error && error.message) || error) } })
  }

  // ── 纯函数：角色表 / 模型目录 / 草稿 ─────────────────────────────────────────
  function asText(value) {
    return typeof value === 'string' ? value : ''
  }

  function errorText(result, text) {
    const raw = result !== null && typeof result === 'object' ? asText(result.error) : ''
    if (raw === '') return text('unknownError')
    const key = HOST_ERROR_KEYS[raw]
    return key === undefined ? raw : text(key)
  }

  /**
   * 角色表由宿主路由提供 —— roster.js 是唯一真值，浏览器半不硬编码角色（见 tools/drift-check.cjs:231-244）。
   * 字段宽容读取：id / label|name / labelEn|label_en / mission|description。
   */
  function normalizeRoles(raw) {
    if (!Array.isArray(raw)) return []
    const out = []
    for (const entry of raw) {
      if (entry === null || typeof entry !== 'object') continue
      const id = asText(entry.id) || asText(entry.role) || asText(entry.roleId)
      if (id === '') continue
      out.push({
        id,
        label: asText(entry.label) || asText(entry.name) || id,
        labelEn: asText(entry.labelEn) || asText(entry.label_en) || '',
        // mission 源自 roster.js，文案里带 markdown 强调标记（`**本仓库**`）——
        // 那是给**队员提示词**（playbook.teammateBrief）用的；配置页这里用 React
        // 纯文本节点渲染，标记会原样裸显（用户 2026-10-11 截图：把**本仓库**…）。
        // 这里剥掉成对 `**`（强调在纯文本里没有载体），roster 真值不动。
        mission: stripEmphasis(asText(entry.mission) || asText(entry.description) || ''),
      })
    }
    return out
  }

  /** 剥掉成对的 markdown 强调标记 `**`（只删标记，不动强调的文字）。 */
  function stripEmphasis(text) {
    return String(text ?? '').replace(/\*\*/g, '')
  }

  /**
   * list-models 的 groups → 分组的展示结构 + `provider\u0000model` → 记录 的查表。
   * 没有 `reasoning.efforts` 的模型一律不给强度档位（官方硬规则）。
   */
  function normalizeCatalog(groups) {
    const options = []
    const byKey = Object.create(null)
    if (!Array.isArray(groups)) return { options, byKey }
    for (const group of groups) {
      if (group === null || typeof group !== 'object') continue
      const provider = asText(group.id) || asText(group.provider) || ''
      if (provider === '') continue
      const models = Array.isArray(group.models) ? group.models : []
      const entries = []
      for (const model of models) {
        if (model === null || typeof model !== 'object') continue
        const modelId = asText(model.id) || asText(model.model) || ''
        if (modelId === '') continue
        const efforts = []
        const reasoning = model.reasoning !== null && typeof model.reasoning === 'object' ? model.reasoning : undefined
        const advertised = reasoning !== undefined && Array.isArray(reasoning.efforts) ? reasoning.efforts : []
        for (const effort of advertised) {
          if (typeof effort === 'string') {
            if (effort !== '') efforts.push({ id: effort, name: effort })
            continue
          }
          if (effort === null || typeof effort !== 'object') continue
          const effortId = asText(effort.id) || asText(effort.name) || ''
          if (effortId === '') continue
          efforts.push({ id: effortId, name: asText(effort.name) || effortId })
        }
        const key = provider + SEP + modelId
        const record = { key, provider, model: modelId, label: asText(model.name) || modelId, efforts }
        byKey[key] = record
        entries.push(record)
      }
      if (entries.length > 0) options.push({ id: provider, label: asText(group.name) || provider, models: entries })
    }
    return { options, byKey }
  }

  /** 已净化配置 → 草稿：每个角色存不透明模型键 + 强度 id + 预设 id（'' = 不指定/跟随 Lead）。 */
  function draftFromConfig(config) {
    const draft = Object.create(null)
    const roles = config !== null && typeof config === 'object' && config.roles !== null && typeof config.roles === 'object' && !Array.isArray(config.roles) ? config.roles : null
    if (roles === null) return draft
    for (const roleId of Object.keys(roles)) {
      const entry = roles[roleId]
      if (entry === null || typeof entry !== 'object') continue
      const provider = asText(entry.provider)
      const model = asText(entry.model)
      const preset = asText(entry.preset)
      const key = provider !== '' && model !== '' ? provider + SEP + model : ''
      // 只配了预设、没配模型的角色同样是「已配置」：以前这里 continue 会把整行丢掉，
      // 面板就把它显示成「跟随 Lead」的假象（读回来 ≠ 存进去）。
      if (key === '' && preset === '' && entry.batch !== false) continue
      draft[roleId] = makeRow(key, asText(entry.reasoningEffort), preset, entry.batch)
    }
    return draft
  }

  /** 配置里的 cache.keepalive.routes → 面板草稿（`{ '<route>': { mode?, intervalSeconds? } }`）。 */
  function cacheRoutesFromConfig(config) {
    const out = Object.create(null)
    const cache = config !== null && typeof config === 'object' && config.cache !== null && typeof config.cache === 'object' ? config.cache : null
    const keepalive = cache !== null && cache.keepalive !== null && typeof cache.keepalive === 'object' ? cache.keepalive : null
    const routes = keepalive === null ? undefined : keepalive.routes
    if (routes === null || routes === undefined || typeof routes !== 'object' || Array.isArray(routes)) return out
    for (const key of Object.keys(routes)) {
      const entry = routes[key]
      if (entry === null || typeof entry !== 'object') continue
      const row = {}
      const mode = asText(entry.mode)
      if (mode === 'auto' || mode === 'on' || mode === 'off') row.mode = mode
      if (typeof entry.intervalSeconds === 'number' && Number.isFinite(entry.intervalSeconds)) row.intervalSeconds = entry.intervalSeconds
      out[key] = row
    }
    return out
  }

  /** 宿主 get 返回的 cacheFamilies → 展示行（只保留认识的字段）。 */
  function normalizeCacheFamilies(raw) {
    if (!Array.isArray(raw)) return []
    const out = []
    for (const item of raw) {
      if (item === null || typeof item !== 'object') continue
      const id = asText(item.id)
      if (id === '') continue
      out.push({ id, mode: asText(item.mode), ttl: typeof item.ttlSeconds === 'number' ? item.ttlSeconds : 0, why: asText(item.why) })
    }
    return out
  }

  /**
   * 宿主 get 返回的 reports → 展示行（最近 8 条，新的在前）。
   *
   * 形状变更（2026-10-05 审查 §1-⑤）：宿主现在返回 {items, dropped, cap} 而不是裸数组。
   *   * dropped > 0 时页面要如实说「另有 N 条更早的汇报未展示」，否则用户会把
   *     「只看到 8 条」读成「总共只交了 8 条」；
   *   * delivered === false 的记录必须标出来——那是「插件页记了、Lead 没收到」的那一类，
   *     它正是这次补写 delivered 要暴露的东西。
   * 兼容旧的裸数组形状（宿主与客户端可能不同步更新）。
   */
  function normalizeReports(raw) {
    const items = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : null)
    if (items === null) return null
    const out = []
    for (const item of items) {
      if (item === null || typeof item !== 'object') continue
      const unresolved = Array.isArray(item.unresolved) ? item.unresolved.length : 0
      out.push({
        at: asText(item.at),
        name: asText(item.name),
        status: asText(item.status),
        unresolved,
        notDelivered: item.delivered === false,
      })
    }
    const dropped = typeof raw?.dropped === 'number' && Number.isFinite(raw.dropped) && raw.dropped > 0 ? raw.dropped : 0
    const cap = typeof raw?.cap === 'number' && Number.isFinite(raw.cap) ? raw.cap : 0
    return { rows: out.slice(-8).reverse(), dropped, cap }
  }

  /**
   * 宿主 get 回包的 agentPresets → 面板用的表。
   *
   * 只信形状、不信内容：每一项要 {id: string}，available 必须是真布尔，其余一律按不可用处理。
   * 宿主改形状或干脆没带（旧宿主 / 服务缺席）时这里给空表，页面显示「读不到预设」的原因，
   * 而不是把 undefined 当可用项渲染出去 —— 那会让用户选到一个根本不存在的预设。
   */
  function normalizePresets(raw) {
    const table = raw !== null && typeof raw === 'object' && Array.isArray(raw.presets) ? raw.presets : []
    const out = []
    for (const item of table) {
      if (item === null || typeof item !== 'object') continue
      const id = asText(item.id)
      if (id === '') continue
      out.push({
        id,
        name: asText(item.name),
        available: item.available === true,
        reason: asText(item.reason),
        detail: asText(item.detail),
      })
    }
    return out
  }

  /**
   * 宿主 get 返回的 recommendations（「推荐」按钮的取值）→ 可用的条目列表。
   * 这里只做形状清洗：缺 roleId 或 preset 的条目丢掉 —— 丢条目 = 那个角色不被改动，
   * 比按半条数据去改配置安全。preset 的白名单不在这里判：页面半不 import lib/roster.js，
   * 拿不到那份名单；真值拦在宿主的 validateRoles（lib/index.js:167，白名单那句判据在同函数
   * 内的 :196）—— 提交了不在清单里的 id，整次 set 会被拒并显示原因。
   */
  function normalizeRecommendations(raw) {
    if (!Array.isArray(raw)) return []
    const out = []
    for (const item of raw) {
      if (item === null || typeof item !== 'object') continue
      const roleId = asText(item.roleId)
      const preset = asText(item.preset)
      if (roleId === '' || preset === '') continue
      out.push({ roleId, preset, batch: item.batch !== false })
    }
    return out
  }

  /** 宿主 get 返回的 sessions（会话记忆快照）→ 展示行；形状不对时返回 null（不显示假数字）。 */
  function normalizeSessions(raw) {
    if (raw === null || typeof raw !== 'object') return null
    const tracked = typeof raw.tracked === 'number' && Number.isFinite(raw.tracked) ? raw.tracked : null
    const restored = typeof raw.restoredThisProcess === 'number' && Number.isFinite(raw.restoredThisProcess) ? raw.restoredThisProcess : 0
    if (tracked === null) return null
    return { tracked, restored, file: asText(raw.file) }
  }

  /** 0~1 → 百分数文本；没有数据时返回 ''（调用方换成「(还没有 usage 数据)」）。 */
  function formatRatio(value) {
    return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : ''
  }

  /** 线路覆盖草稿的浅拷贝（避免 React 状态被就地改动）。 */
  function cloneRouteDraft(source) {
    const out = Object.create(null)
    for (const key of Object.keys(source)) {
      const row = source[key]
      const copy = {}
      if (row.mode !== undefined) copy.mode = row.mode
      if (row.intervalSeconds !== undefined) copy.intervalSeconds = row.intervalSeconds
      out[key] = copy
    }
    return out
  }

  /**
   * 草稿行的**唯一**构造口：四个维度（模型 / 强度 / 预设 / 批量调用）一次带齐。
   *
   * 为什么要有它：这一行原先散在 14 处各自写对象字面量，每加一个维度就要同时改对 14 个
   * 地方，漏掉任何一个都是**静默丢配置**（preset 那一列就是这么踩过来的，selftest 里
   * 还留着一条禁两字段形状的闸门）。收成一个函数之后，行形状只有一处定义，
   * 闸门只需盯「还有没有别处写 { key: … } 字面量」。
   *
   * @param {string} key - 不透明模型键（provider + SEP + model），'' = 跟随 Lead。
   * @param {string} effort - 强度档位 id，'' = 模型默认。
   * @param {string|undefined} preset - 预设 id，'' / undefined = 跟随 Lead。
   * @param {boolean|undefined} batch - 批量调用档；**只有显式 false 才是关**（默认开）。
   * @returns {{key:string, effort:string, preset:string, batch:boolean}}
   */
  function makeRow(key, effort, preset, batch) {
    return {
      key: typeof key === 'string' ? key : '',
      effort: typeof effort === 'string' ? effort : '',
      preset: typeof preset === 'string' ? preset : '',
      batch: batch !== false,
    }
  }

  /** 这一行草稿有没有配任何维度（全默认 = 可以整条不进 payload，也可以整条删掉）。 */
  function rowIsEmpty(row) {
    return row.key === '' && row.preset === '' && row.batch === true
  }

  function cloneDraft(source) {
    const out = Object.create(null)
    for (const roleId of Object.keys(source)) {
      const row = source[roleId]
      if (row === undefined) continue
      out[roleId] = makeRow(row.key, row.effort, row.preset, row.batch)
    }
    return out
  }

  /** 只保留角色表里存在的行（三个维度一起搬），避免把宿主不认识的键写回配置。 */
  function trimDraft(draft, roleIds) {
    const out = Object.create(null)
    for (const roleId of roleIds) {
      const row = draft[roleId]
      if (row !== undefined) out[roleId] = makeRow(row.key, row.effort, row.preset, row.batch)
    }
    return out
  }

  /** 草稿 → set 的 args.roles：三个维度各自「空 = 跟随 Lead」，全空的角色整条不进 payload（= 清掉）。 */
  function rolesFromDraft(draft, roleIds) {
    const roles = {}
    for (const roleId of roleIds) {
      const row = draft[roleId]
      if (row === undefined) continue
      const at = typeof row.key === 'string' ? row.key.indexOf(SEP) : -1
      const entry = {}
      if (at > 0) {
        entry.provider = row.key.slice(0, at)
        entry.model = row.key.slice(at + 1)
        if (row.effort !== '') entry.reasoningEffort = row.effort
      }
      if (row.preset !== undefined && row.preset !== '') entry.preset = row.preset
      // 批量调用档：默认开 = 不落键（与宿主的 sanitizeConfig/validateRoles 同一口径，
      // 配置文件里只留真被关掉的角色）。
      if (row.batch === false) entry.batch = false
      // 两边都空 = 该角色完全跟随 Lead：不进 payload。宿主 set 的合并语义是「payload 里
      // 没出现的角色整条清掉」，所以「保留模型、清掉预设」这种改法也走得通。
      if (Object.keys(entry).length > 0) roles[roleId] = entry
    }
    return roles
  }

  function draftSignature(draft, roleIds) {
    const parts = []
    for (const roleId of roleIds) {
      const row = draft[roleId]
      parts.push(roleId + '\u0001' + (row === undefined ? '' : row.key + '\u0001' + row.effort + '\u0001' + (row.preset === undefined ? '' : row.preset) + '\u0001' + (row.batch === false ? '0' : '1')))
    }
    return parts.join('\u0002')
  }

  /**
   * 宿主 failures 是对象数组（{id,name,message}），不是字符串数组。
   * 以前直接 String(item) → 页面上永远显示「[object Object]」，等于这块告警没用。
   */
  function formatFailures(raw) {
    if (!Array.isArray(raw)) return []
    const out = []
    for (const item of raw) {
      if (typeof item === 'string') { if (item !== '') out.push(item); continue }
      if (item === null || typeof item !== 'object') continue
      const who = asText(item.name) || asText(item.id)
      const what = asText(item.message)
      const line = who !== '' && what !== '' ? who + '：' + what : (what !== '' ? what : who)
      if (line !== '') out.push(line)
    }
    return out
  }

  /** 载入时清掉「当前模型没有广告」的强度档位，保证草稿与界面显示一致。 */
  function sanitizeDraftAgainstCatalog(draft, catalog) {
    const out = Object.create(null)
    for (const roleId of Object.keys(draft)) {
      const row = draft[roleId]
      if (row === undefined) continue
      const record = catalog === null ? undefined : catalog.byKey[row.key]
      if (record === undefined) { out[roleId] = makeRow(row.key, row.effort, row.preset, row.batch); continue }
      const effort = record.efforts.some((item) => item.id === row.effort) ? row.effort : ''
      out[roleId] = makeRow(row.key, effort, row.preset, row.batch)
    }
    return out
  }

  // ── 页面组件 ────────────────────────────────────────────────────────────────
  // 签名照官方注册示例：({ t, view })（dsh-client-ui-plugin-manager/README.md:56-62）。
  // 官方只在 `plugins.bundle.config` 槽位上以 { view: 'page' } 渲染这个组件
  // （dsh-client-ui-plugin-manager/lib/client.js:1973），summary 分支是防御性的：
  // 万一哪天该槽位也渲染 summary，这里给一行文本而不是整张表单。
  function RosterConfigPage(props) {
    const text = makeText(props === undefined || props === null ? undefined : props.t)
    const view = props === undefined || props === null ? undefined : props.view

    const [phase, setPhase] = React.useState('loading')
    const [tick, setTick] = React.useState(0)
    const [roles, setRoles] = React.useState([])
    const [catalog, setCatalog] = React.useState(null)
    const [modelsError, setModelsError] = React.useState('')
    const [loadError, setLoadError] = React.useState('')
    const [baseline, setBaseline] = React.useState(Object.create(null))
    const [draft, setDraft] = React.useState(Object.create(null))
    const [busy, setBusy] = React.useState(false)
    const [message, setMessage] = React.useState(null)
    const [confirmReset, setConfirmReset] = React.useState(false)
    const [diagnostics, setDiagnostics] = React.useState([])
    // 信息通道（DSH 主目录 / 配置文件路径 / 控制面注册结果）：与故障分开存，样式与语义都不混。
    const [notes, setNotes] = React.useState([])
    // 磁盘版本的指纹（宿主 get 回传）：保存时带回去，宿主比对不一致就拒绝并让我们重新载入。
    const [revision, setRevision] = React.useState('')
    // 缓存保活：cache = 宿主快照（状态+统计，每次 get 刷新）；cacheDraft/cacheBaseline = 线路覆盖的编辑态。
    const [cache, setCache] = React.useState(null)
    const [cacheFamilies, setCacheFamilies] = React.useState([])
    const [cacheBaseline, setCacheBaseline] = React.useState(Object.create(null))
    const [cacheDraft, setCacheDraft] = React.useState(Object.create(null))
    const [reports, setReports] = React.useState([])
    // 会话记忆快照：宿主重启后有几个会话会被自动恢复（见 lib/resume.js），{tracked, restored}。
    const [sessions, setSessions] = React.useState(null)
    // 可选队员预设（宿主现读注册表回包）。空表 = 读不到，页面必须把原因显示出来。
    const [presets, setPresets] = React.useState([])
    // 「推荐」按钮的取值与规则文本：由宿主 get 回传（真值在 lib/roster.js），页面不自己写一份。
    const [recommendations, setRecommendations] = React.useState([])
    const [recommendationRule, setRecommendationRule] = React.useState('')
    const [overrideKey, setOverrideKey] = React.useState('')
    const [overrideMode, setOverrideMode] = React.useState('auto')
    const [overrideInterval, setOverrideInterval] = React.useState('')

    const roleIds = roles.map((role) => role.id)
    const cacheDirty = phase === 'ready' && JSON.stringify(cloneRouteDraft(cacheDraft)) !== JSON.stringify(cloneRouteDraft(cacheBaseline))
    const dirty = phase === 'ready' && (draftSignature(draft, roleIds) !== draftSignature(baseline, roleIds) || cacheDirty)

    React.useEffect(() => {
      // summary 只是插件卡片上的一行文本，不发任何请求；只有详情页的 page 视图去读配置与模型目录。
      if (view === 'summary') return undefined
      let alive = true
      setPhase('loading')
      setLoadError('')
      setMessage(null)
      setModelsError('')
      setDiagnostics([])
      setNotes([])
      setPresets([])
      setRecommendations([])
      Promise.all([apiCall('get', {}), apiCall('list-models', {})]).then((results) => {
        if (!alive) return
        const configResult = results[0] === undefined || results[0] === null ? {} : results[0]
        const modelResult = results[1] === undefined || results[1] === null ? {} : results[1]
        if (configResult.ok !== true) {
          setPhase('failed')
          setLoadError(errorText(configResult, text))
          return
        }
        const nextRoles = normalizeRoles(configResult.roles)
        const nextCatalog = modelResult.ok === true ? normalizeCatalog(modelResult.groups) : null
        const nextDraft = sanitizeDraftAgainstCatalog(
          trimDraft(draftFromConfig(configResult.config), nextRoles.map((role) => role.id)),
          nextCatalog,
        )
        setRoles(nextRoles)
        setBaseline(nextDraft)
        setDraft(cloneDraft(nextDraft))
        setRevision(asText(configResult.revision))
        setDiagnostics(formatFailures(configResult.diagnostics))
        setNotes(formatFailures(configResult.notes))
        setCache(configResult.cache !== null && typeof configResult.cache === 'object' ? configResult.cache : null)
        setCacheFamilies(normalizeCacheFamilies(configResult.cacheFamilies))
        setReports(normalizeReports(configResult.reports))
        setSessions(normalizeSessions(configResult.sessions))
        setPresets(normalizePresets(configResult.agentPresets))
        setRecommendations(normalizeRecommendations(configResult.recommendations))
        setRecommendationRule(asText(configResult.recommendationRule))
        const nextCacheDraft = cacheRoutesFromConfig(configResult.config)
        setCacheBaseline(cloneRouteDraft(nextCacheDraft))
        setCacheDraft(cloneRouteDraft(nextCacheDraft))
        setPhase('ready')
        if (nextCatalog !== null) {
          setCatalog(nextCatalog)
          const failures = formatFailures(modelResult.failures)
          // failures 优先于「目录为空」：ctx.llm 缺失时宿主恰好回 groups:[] + failures，
          // 先报「目录是空的」会把唯一可操作的原因（服务不可用）盖掉。
          if (failures.length > 0) setModelsError(text('modelsFailed', { message: failures.join('；') }))
          else if (nextCatalog.options.length === 0) setModelsError(text('modelsEmpty'))
          else setModelsError('')
        } else {
          setCatalog(null)
          setModelsError(text('modelsFailed', { message: errorText(modelResult, text) }))
        }
        // 只有手动「重新载入」（tick > 0）才回执成功；否则会在首屏就报一句「已重新载入」。
        if (tick > 0) setMessage({ kind: 'ok', text: text('reloaded') })
      }).catch((error) => {
        if (!alive) return
        setPhase('failed')
        setLoadError(String((error && error.message) || error))
      })
      return () => { alive = false }
    }, [tick])

    const changeModel = (roleId, key) => {
      setConfirmReset(false)
      setDraft((current) => {
        const next = cloneDraft(current)
        const record = catalog !== null && key !== '' ? catalog.byKey[key] : undefined
        const efforts = record === undefined ? [] : record.efforts
        const previous = current[roleId] === undefined ? '' : current[roleId].effort
        const effort = efforts.some((item) => item.id === previous) ? previous : ''
        // 清掉模型**不等于**清掉预设：这一行还剩任何一个维度就得留着，否则用户点一下
        // 「统一跟随 Lead」会顺手把配好的预设也抹掉（保存后才发现，最难查的那种丢数据）。
        const preset = current[roleId] === undefined || current[roleId].preset === undefined ? '' : current[roleId].preset
        const batch = current[roleId] === undefined ? true : current[roleId].batch !== false
        if (key === '') {
          const row = makeRow('', '', preset, batch)
          if (rowIsEmpty(row)) delete next[roleId]
          else next[roleId] = row
        } else next[roleId] = makeRow(key, effort, preset, batch)
        return next
      })
    }

    /**
     * 统一选择：把**全部角色**的模型改成同一个（也可选「跟随 Lead」清空全部）。
     *
     * 思考强度按新模型重算，规则与逐行改模型完全一致（changeModel 里那条）：
     * 新模型没广告该档位就退回「模型默认」，避免留下一个必然被丢弃的档位。
     * 这样「统一选 + 单独微调」两条路径产出的草稿形状恒等，不会出现只有一种改法才合法的状态。
     *
     * @param {string} key - 不透明模型键（provider + SEP + model），'' = 全部跟随 Lead。
     */
    const changeAllModels = (key) => {
      setConfirmReset(false)
      // 用函数式更新读 current：一次点击会改多个角色的 effort，必须基于**最新**草稿算，
      // 不能用渲染闭包里的 draft（连续两次统一选择时第二次会读到过期值）。
      setDraft((current) => {
        const next = Object.create(null)
        // '' = 模型全部跟随 Lead：**只清模型与强度**，逐行已配的预设原样留着。
        if (key === '') {
          for (const roleId of roleIds) {
            const keep = current[roleId] === undefined || current[roleId].preset === undefined ? '' : current[roleId].preset
            const keepBatch = current[roleId] === undefined ? true : current[roleId].batch !== false
            const row = makeRow('', '', keep, keepBatch)
            if (rowIsEmpty(row) === false) next[roleId] = row
          }
          return next
        }
        const record = catalog !== null ? catalog.byKey[key] : undefined
        const efforts = record === undefined ? [] : record.efforts
        for (const roleId of roleIds) {
          // 逐行已有的档位若仍被新模型支持就保留，否则退回「模型默认」。
          const previous = current[roleId] === undefined ? '' : current[roleId].effort
          const effort = efforts.some((item) => item.id === previous) ? previous : ''
          const keep = current[roleId] === undefined || current[roleId].preset === undefined ? '' : current[roleId].preset
          next[roleId] = makeRow(key, effort, keep, current[roleId] === undefined ? true : current[roleId].batch !== false)
        }
        return next
      })
    }

    /**
     * 统一选择：把**全部角色**的思考强度改成同一个（'' = 不指定，用模型默认）。
     *
     * 与逐行 changeEffort 的语义完全一致，只是对每个角色各跑一次：
     *   * 只改 effort，**不动 model**（配置层要求模型与强度成对出现，只给强度会被丢掉）；
     *   * 没有模型的行（跟随 Lead）保持原样——它本来就没有强度可言。
     *
     * 调用点保证「只在该档位对当前模型合法时」才可点（见 renderBulkModels 的 effortDisabled）：
     * 档位是**每个模型各自广告**的，模型不统一时「统一强度」没有确定含义。
     *
     * @param {string} effort - 档位 id；'' = 不指定（模型默认）。
     */
    const changeAllEfforts = (effort) => {
      setConfirmReset(false)
      setDraft((current) => {
        const next = cloneDraft(current)
        for (const roleId of roleIds) {
          const row = next[roleId]
          // 没有模型的行不碰：强度依附于模型，给一个空模型设强度保存时会被丢掉。
          if (row === undefined || row.key === '') continue
          next[roleId] = makeRow(row.key, effort, row.preset, row.batch)
        }
        return next
      })
    }

    const changeEffort = (roleId, effort) => {
      setConfirmReset(false)
      setDraft((current) => {
        const row = current[roleId]
        if (row === undefined) return current
        const next = cloneDraft(current)
        next[roleId] = makeRow(row.key, effort, row.preset, row.batch)
        return next
      })
    }

    /**
     * 逐行改「agent 预设」。
     *
     * 与强度不同，**预设不依附于模型**：一个角色可以只配预设、模型仍跟随 Lead（宿主的
     * sanitizeConfig 允许这种行）。反过来清掉预设时若该行还配着模型，必须留着那一半。
     *
     * @param {string} roleId - 角色 id。
     * @param {string} preset - 预设 id；'' = 跟随 Lead（不重绑）。
     */
    const changePreset = (roleId, preset) => {
      setConfirmReset(false)
      setDraft((current) => {
        const next = cloneDraft(current)
        const row = current[roleId]
        const key = row === undefined ? '' : row.key
        const effort = row === undefined ? '' : row.effort
        const batch = row === undefined ? true : row.batch !== false
        const nextRow = makeRow(key, effort, preset, batch)
        if (rowIsEmpty(nextRow)) delete next[roleId]
        else next[roleId] = nextRow
        return next
      })
    }

    /**
     * 统一选择：把**全部角色**的预设改成同一个（`''` = 全部跟随 Lead）。
     *
     * 只动预设，**不碰模型与强度** —— 与 changeAllModels/changeAllEfforts 各管一列，
     * 所以「先统一模型、再统一预设、最后单独微调某一行」三条路径产出的草稿形状恒等。
     *
     * @param {string} preset - 预设 id；空 = 全部跟随 Lead。
     */
    const changeAllPresets = (preset) => {
      setConfirmReset(false)
      setDraft((current) => {
        const next = cloneDraft(current)
        for (const roleId of roleIds) {
          const row = next[roleId]
          const key = row === undefined ? '' : row.key
          const effort = row === undefined ? '' : row.effort
          const batch = row === undefined ? true : row.batch !== false
          const nextRow = makeRow(key, effort, preset, batch)
          if (rowIsEmpty(nextRow)) delete next[roleId]
          else next[roleId] = nextRow
        }
        return next
      })
    }

    /**
     * 逐行改「批量调用」开关（官方 both 档）。
     *
     * 这一维与前三维唯一的差别：**默认就是开**，所以「开」不落键（rolesFromDraft 只在
     * batch === false 时写），关掉才进配置。行没配任何维度时整条删掉 = 回到默认。
     *
     * @param {string} roleId - 角色 id。
     * @param {boolean} on - true = 开（both），false = 关（沿用预设自己的呈现档）。
     */
    const changeBatch = (roleId, on) => {
      setConfirmReset(false)
      setDraft((current) => {
        const next = cloneDraft(current)
        const row = current[roleId]
        const base = row === undefined ? makeRow('', '', '', true) : row
        const nextRow = makeRow(base.key, base.effort, base.preset, on)
        if (rowIsEmpty(nextRow)) delete next[roleId]
        else next[roleId] = nextRow
        return next
      })
    }

    /** 统一选择：一次把全部角色的批量开关拨到同一位置（只动这一维，不碰另外三列）。 */
    const changeAllBatch = (on) => {
      setConfirmReset(false)
      setDraft((current) => {
        const next = cloneDraft(current)
        for (const roleId of roleIds) {
          const row = next[roleId]
          const base = row === undefined ? makeRow('', '', '', true) : row
          const nextRow = makeRow(base.key, base.effort, base.preset, on)
          if (rowIsEmpty(nextRow)) delete next[roleId]
          else next[roleId] = nextRow
        }
        return next
      })
    }

    /**
     * 把某份草稿提交给宿主的 set 路由（保存的唯一出口）。
     *
     * 为什么提成函数而不是只在「保存」按钮里写一遍：「推荐」按钮要**填上并直接保存**
     * （用户 2026-10-16 的要求），那必须走同一条链路 —— 两处各写一份 payload 形状，
     * 将来改 revision/cache 字段就会只改一处。带上读到的 revision：不一致宿主会拒绝，
     * 不静默覆盖别的会话刚存的东西。
     * @param {object} draftToSave - 要提交的草稿（角色行 → {key,effort,preset,batch}）。
     */
    const submitDraft = (draftToSave, okTextKey) => {
      if (busy || phase !== 'ready') return
      setBusy(true)
      setConfirmReset(false)
      setMessage(null)
      // 带上读到的磁盘版本：宿主比对不一致会拒绝（而不是静默 last-write-wins）。
      // cache 一起提交（宿主对没带的字段保持原值）：只改保活设置时不会清空角色配置，反之亦然。
      apiCall('set', {
        roles: rolesFromDraft(draftToSave, roleIds),
        cache: { keepalive: { routes: cloneRouteDraft(cacheDraft) } },
        revision,
      }).then((result) => {
        if (result !== null && typeof result === 'object' && result.ok === true) {
          // 以宿主回传的净化结果为准；宿主没回 config 时退回我们刚提交的那份（不然会把界面清空）。
          const saved = result.config === undefined || result.config === null
            ? cloneDraft(trimDraft(draftToSave, roleIds))
            : trimDraft(draftFromConfig(result.config), roleIds)
          setBaseline(saved)
          setDraft(cloneDraft(saved))
          if (result.config !== undefined && result.config !== null) {
            const routes = cacheRoutesFromConfig(result.config)
            setCacheBaseline(cloneRouteDraft(routes))
            setCacheDraft(cloneRouteDraft(routes))
          } else {
            setCacheBaseline(cloneRouteDraft(cacheDraft))
          }
          if (asText(result.revision) !== '') setRevision(asText(result.revision))
          // 「推荐」那条路径要说清它**只填了两格**（用户点的是「推荐」，不是「保存」；
          // 报一句笼统的「已保存」会让人以为模型与强度也被改了）。
          // 键名只有两个来源：undefined（普通保存）与 'recommendSaved'，后者在 zh/en 两份字典里
          // 都有 —— 键集合相等由 selftest 的字典对账闸门钉着，所以这里不需要再兜一层。
          setMessage({ kind: 'ok', text: text(okTextKey === 'recommendSaved' ? 'recommendSaved' : 'saved') })
          return
        }
        const conflict = result !== null && typeof result === 'object' && (result.conflict === true || result.stale === true)
        setMessage({ kind: 'err', text: conflict ? text('saveConflict', { message: errorText(result, text) }) : text('saveFailed', { message: errorText(result, text) }) })
      }).catch((error) => {
        setMessage({ kind: 'err', text: text('saveFailed', { message: String((error && error.message) || error) }) })
      }).then(() => { setBusy(false) })
    }

    const onSave = () => submitDraft(draft)

    /**
     * 「推荐」按钮：按角色分工把 **agent 预设 + 批量调用** 两格填成推荐值，并立刻保存。
     *
     * 只动这两格：模型与思考强度是用户自己的选择（他要省钱还是要强模型，机器不该替他定）。
     * 取值来自宿主 get（lib/roster.js 的 ROLE_RECOMMENDATIONS 是唯一真值），页面不复制一份。
     * 走 submitDraft = 与「保存」按钮同一条链路，所以填完即存、失败原因也与手工保存一致。
     */
    const onRecommend = () => {
      if (busy || phase !== 'ready' || recommendations.length === 0) return
      const byRole = new Map(recommendations.map((item) => [item.roleId, item]))
      // 从闭包里的 draft 直接算出「填完之后那份」，再一次性交给 submitDraft：
      // 不能写成 setDraft((current) => { …; submitDraft(next); return next }) ——
      // React 不保证 updater 同步执行（严格模式下还会跑两次），那样提交的就是改之前的草稿。
      // 按钮在 busy 与「没读到配置」时是禁用的，所以这份闭包值就是当前值。
      const next = cloneDraft(draft)
      for (const roleId of roleIds) {
        const rec = byRole.get(roleId)
        if (rec === undefined) continue
        const row = next[roleId]
        const base = row === undefined ? makeRow('', '', '', true) : row
        const nextRow = makeRow(base.key, base.effort, rec.preset, rec.batch !== false)
        if (rowIsEmpty(nextRow)) delete next[roleId]
        else next[roleId] = nextRow
      }
      setDraft(next)
      submitDraft(next, 'recommendSaved')
    }

    const onDiscard = () => {
      if (busy || phase !== 'ready') return
      setDraft(cloneDraft(baseline))
      setMessage(null)
      setConfirmReset(false)
    }

    const onReload = () => {
      if (busy || phase !== 'ready') return
      setConfirmReset(false)
      setMessage(null)
      // 回执由 effect 在**读成功后**给出：以前是先写好「已重新载入」再发请求，
      // 读失败时页面上会同时出现「已重新载入」和「加载失败」两句互相矛盾的话。
      setTick((value) => value + 1)
    }

    const onReset = () => {
      // 加载中禁止：重置在途、get 后返回时会把 roles/draft 覆盖回重置前的值，
      // 出现「界面 ≠ 磁盘且没有未保存提示」，再保存就是整份写回。
      if (busy || phase !== 'ready') return
      if (!confirmReset) { setConfirmReset(true); return }
      setBusy(true)
      setConfirmReset(false)
      setMessage(null)
      apiCall('reset', {}).then((result) => {
        if (result !== null && typeof result === 'object' && result.ok === true) {
          setBaseline(Object.create(null))
          setDraft(Object.create(null))
          setMessage({ kind: 'ok', text: text('resetDone') })
          return
        }
        setMessage({ kind: 'err', text: text('resetFailed', { message: errorText(result, text) }) })
      }).catch((error) => {
        setMessage({ kind: 'err', text: text('resetFailed', { message: String((error && error.message) || error) }) })
      }).then(() => { setBusy(false) })
    }

    if (view === 'summary') {
      return React.createElement('span', { className: 'dat-summary' }, text('summary'))
    }

    const configured = roleIds.filter((roleId) => draft[roleId] !== undefined).length
    // 强度下拉必须有模型目录才能列档位；模型下拉不需要——目录读不到时也要能把角色改回「跟随 Lead」。
    const controlsDisabled = busy || catalog === null
    const modelSelectDisabled = busy

    const renderEffort = (roleId, row, record) => {
      if (row.key === '') return React.createElement('div', { className: 'dat-note' }, text('effortInherit'))
      if (record === undefined) return React.createElement('div', { className: 'dat-note' }, text('effortUnknown'))
      if (record.efforts.length === 0) return React.createElement('div', { className: 'dat-note' }, text('effortNone'))
      const value = record.efforts.some((item) => item.id === row.effort) ? row.effort : ''
      return React.createElement('label', { className: 'dat-field' },
        React.createElement('span', { className: 'dat-label' }, text('effortLabel')),
        React.createElement('select', {
          className: 'dat-select',
          value,
          disabled: controlsDisabled,
          onChange: (event) => changeEffort(roleId, event.target.value),
        },
          React.createElement('option', { value: '' }, text('effortDefault')),
          record.efforts.map((item) => React.createElement('option', { key: item.id, value: item.id }, item.name))))
    }

    /**
     * 统一选择队员模型**与**思考强度 —— 角色列表**之上**的一行控件。
     *
     * 为什么需要它：12 个角色逐行点一遍很烦，而「所有队员用同一个模型 + 同一个强度」是最常见的诉求。
     * 它不是一个新设置项：只是把逐行的改法对每个角色各跑一次，最终仍走同一份草稿与同一个保存接口，
     * 所以「统一选完再单独微调某一行」是自然支持的，不存在两套配置来源。
     *
     * 混合状态：各角色取值不一致时，下拉显示「（各角色当前不一致）」这个**不可选**的占位项，
     * 而不是显示成第一项的值——那会谎称所有角色都一样。
     *
     * ── 思考强度为什么依赖模型（这里是最容易做错的地方，2026-10-06）──────────────────
     * 强度档位是**每个模型各自广告**的（官方硬规则：模型没有 reasoning 元数据就一个档位都不给），
     * 而且配置层**不接受「只有强度、没有模型」的角色条目**（rolesFromDraft 会把 key 为空的行整条丢掉）。
     * 所以「统一强度」只在**所有角色已经是同一个模型**时才有确定含义。
     * 模型不一致时这里**保持控件可见但禁用**并写明原因与下一步（先用上面的模型统一），
     * 而不是把控件藏起来 —— 藏起来只会让人问「为什么不能统一思考强度」却看不到任何解释。
     */
    const renderBulkModels = () => {
      const keys = roleIds.map((roleId) => (draft[roleId] === undefined ? '' : draft[roleId].key))
      const first = keys.length === 0 ? '' : keys[0]
      const uniform = keys.every((key) => key === first)
      const mixed = keys.length > 0 && !uniform
      // 当前值必须能在选项里找到，否则浏览器会退回第一项，界面显示的就不是草稿里的值。
      const shown = mixed ? MIXED_KEY : first
      const known = shown === '' || shown === MIXED_KEY || (catalog !== null && catalog.byKey[shown] !== undefined)
      const bulkOptions = []
      // 选项顺序与逐行的 renderRow 保持一致：不一致占位（仅此处有）→ 跟随 Lead → 缺失占位 → 目录。
      if (mixed) {
        bulkOptions.push(React.createElement('option', { key: '__mixed', value: MIXED_KEY, disabled: true }, text('bulkMixed')))
      }
      bulkOptions.push(React.createElement('option', { key: '__inherit', value: '' }, text('inherit')))
      if (!known) {
        // 已保存的模型不在当前目录里（同一处理手法见 renderRow）：插一个只读占位项，
        // 让下拉显示的就是草稿里的真实值，而不是浏览器退回的第一项。
        bulkOptions.push(React.createElement('option', { key: '__missing', value: shown }, text('missingModel', { label: shown.split(SEP).join(' / ') })))
      }
      if (catalog !== null) {
        for (const group of catalog.options) {
          bulkOptions.push(React.createElement('optgroup', { key: group.id, label: group.label },
            group.models.map((model) => React.createElement('option', { key: model.key, value: model.key }, model.provider + ' / ' + model.label))))
        }
      }

      // ── 思考强度 ──────────────────────────────────────────────────────────
      const efforts = roleIds.map((roleId) => (draft[roleId] === undefined ? '' : draft[roleId].effort))
      const firstEffort = efforts.length === 0 ? '' : efforts[0]
      const effortMixed = efforts.length > 0 && !efforts.every((effort) => effort === firstEffort)
      // 只有「模型已统一」时档位才有定义：模型不一致时各角色的可选项本来就不一样。
      const record = mixed || catalog === null || first === '' ? undefined : catalog.byKey[first]
      const availableEfforts = record === undefined ? [] : record.efforts
      const noModel = first === ''
      const effortDisabled = modelSelectDisabled || roleIds.length === 0 || mixed || noModel || availableEfforts.length === 0
      const effortShown = effortMixed ? MIXED_KEY : firstEffort
      const effortOptions = []
      if (effortMixed) {
        effortOptions.push(React.createElement('option', { key: '__mixed', value: MIXED_KEY, disabled: true }, text('bulkMixed')))
      }
      effortOptions.push(React.createElement('option', { key: '__default', value: '' }, text('effortDefault')))
      for (const item of availableEfforts) {
        effortOptions.push(React.createElement('option', { key: item.id, value: item.id }, item.name))
      }
      // 为什么点不了（按优先级给出**唯一**原因，不并列好几条）。
      // 五种情况都必须有解释：控件是禁用状态却不说明原因，用户只会以为功能坏了
      //（矩阵自检发现「模型不在目录里」与「目录整个读不到」这两条原本静默，2026-10-06 补）。
      const effortHint = mixed
        ? text('bulkEffortMixedModels')
        : (noModel
          ? text('bulkEffortNoModel')
          : (catalog === null
            ? text('bulkEffortNoCatalog')
            : (record === undefined
              ? text('effortUnknown')
              : (availableEfforts.length === 0 ? text('bulkEffortNone') : ''))))

      // ── agent 预设（2026-10-15 新增这一列）──────────────────────────────────
      // 与模型/强度两列同一套规矩：各角色不一致时显示「不一致」占位（禁用、不可选），
      // 点不了就必须给出**唯一**原因，不许静默禁用。
      const presetValues = roleIds.map((roleId) => (draft[roleId] === undefined || draft[roleId].preset === undefined ? '' : draft[roleId].preset))
      const firstPreset = presetValues.length === 0 ? '' : presetValues[0]
      const presetMixed = presetValues.length > 0 && !presetValues.every((value) => value === firstPreset)
      const presetShown = presetMixed ? MIXED_KEY : firstPreset
      const presetKnown = firstPreset === '' || presets.some((preset) => preset.id === firstPreset)
      const presetOptions = []
      if (presetMixed) {
        presetOptions.push(React.createElement('option', { key: '__mixed', value: MIXED_KEY, disabled: true }, text('bulkMixed')))
      }
      presetOptions.push(React.createElement('option', { key: '__inherit', value: '' }, text('presetInherit')))
      if (!presetMixed && !presetKnown) {
        presetOptions.push(React.createElement('option', { key: '__missing', value: firstPreset }, text('presetStale', { id: firstPreset })))
      }
      for (const preset of presets) {
        presetOptions.push(React.createElement('option', {
          key: preset.id,
          value: preset.id,
          disabled: preset.available !== true,
        }, presetLabel(preset) + (preset.available === true ? '' : '（' + text(preset.reason === 'broken' ? 'presetBroken' : 'presetMissing') + '）')))
      }
      const presetDisabled = modelSelectDisabled || roleIds.length === 0 || presets.length === 0
      const presetHint = presets.length === 0
        ? text('bulkPresetNoRegistry')
        : (presetMixed ? text('bulkMixed') : '')
      // 批量调用那一格是**布尔**，没有「不一致」这个值可显示：判据取「全部才打勾」，
      // 不一致时照样打勾但把原因写在旁边（与前几列同一套规矩：可以不准，不许静默）。
      const batchValues = roleIds.map((roleId) => (draft[roleId] === undefined ? true : draft[roleId].batch !== false))
      const batchAllOn = batchValues.length === 0 ? true : batchValues.every((value) => value === true)
      const batchMixed = batchValues.length > 0 && batchValues.some((value) => value !== batchValues[0])
      const children = [
        React.createElement('div', { className: 'dat-bulk-head', key: 'head' },
          React.createElement('span', { className: 'dat-bulk-title' }, text('bulkTitle')),
          React.createElement('span', { className: 'dat-id' }, text('bulkAppliesAll', { count: String(roleIds.length) })),
          // 「推荐」按钮：放在这一行的**右侧**（用户 2026-10-16 指定的位置 = 统一选择那一块的右上角）。
          // 点一下 = 按角色分工把「agent 预设 + 批量调用」两格填好并**直接保存**（模型与强度不动）。
          // 读不到推荐条目时禁用并写明原因，不藏起来（与思考强度那列同一套处理）。
          React.createElement('span', { className: 'dat-bulk-spacer', key: 'spacer' }),
          React.createElement('button', {
            className: 'dat-btn dat-btn-recommend',
            key: 'recommend',
            type: 'button',
            disabled: busy || phase !== 'ready' || recommendations.length === 0 || roleIds.length === 0,
            title: recommendations.length === 0 ? text('recommendNone') : (recommendationRule === '' ? text('recommendTip') : recommendationRule),
            onClick: onRecommend,
          }, text('recommendLabel')),
          // 读不到推荐取值时把原因**写在行上**（不只塞进 title）：这一行是标题行，平时不留提示位，
          // 但「按钮点不了且没有任何解释」正是本文件反复修过的那类问题（见思考强度那列的注释）。
          recommendations.length === 0
            ? React.createElement('span', { className: 'dat-bulk-note', key: 'recommendNone' }, text('recommendNone'))
            : null),
        // 三个字段（模型 / 思考强度 / agent 预设）必须是 .dat-bulk-ctl 的**同级**子节点。
        // 少一个闭括号时 React 照样渲染、一句不报，只是第三列被塞进第二列里面 —— 表现就是
        // 用户 2026-10-15 报的那张截图：统一选择那一块左边与中间空出两大块白。判据在
        // tools/client-smoke-test.cjs 的 §10（数 ctl 的直接子节点，不是看文本）。
        React.createElement('div', { className: 'dat-bulk-ctl', key: 'ctl' },
          React.createElement('label', { className: 'dat-field' },
            React.createElement('span', { className: 'dat-label' }, text('bulkLabel')),
            React.createElement('select', {
              className: 'dat-select',
              value: shown,
              disabled: modelSelectDisabled || roleIds.length === 0,
              onChange: (event) => {
                if (event.target.value === MIXED_KEY) return
                changeAllModels(event.target.value)
              },
            }, bulkOptions),
            React.createElement('span', { className: 'dat-hintslot', key: 'hint' }, '')),
          React.createElement('label', { className: 'dat-field' },
            React.createElement('span', { className: 'dat-label' }, text('bulkEffortLabel')),
            React.createElement('select', {
              className: 'dat-select',
              value: effortShown,
              disabled: effortDisabled,
              onChange: (event) => {
                if (event.target.value === MIXED_KEY) return
                changeAllEfforts(event.target.value)
              },
            }, effortOptions),
            // 强度这一格的提示槽留空：它的长原因（为什么现在不能统一）由下面那条 dat-note 承担，
            // 这里再写一遍就是重复。槽位仍然占位，四格才等高。
            React.createElement('span', { className: 'dat-hintslot', key: 'hint' }, '')),
          React.createElement('label', { className: 'dat-field', title: text('presetAppliesNext') },
            React.createElement('span', { className: 'dat-label' }, text('bulkPresetLabel')),
            React.createElement('select', {
              className: 'dat-select',
              value: presetShown,
              disabled: presetDisabled,
              onChange: (event) => {
                if (event.target.value === MIXED_KEY) return
                changeAllPresets(event.target.value)
              },
            }, presetOptions),
            React.createElement('span', { className: 'dat-hintslot', key: 'hint' }, presetHint)),
          // 第四格：批量调用。与三个下拉**同级**（套进去就是 2026-10-15 那个空白 bug）。
          React.createElement('label', { className: 'dat-field', title: text('bulkBatchTip') },
            React.createElement('span', { className: 'dat-label' }, text('bulkBatchLabel')),
            React.createElement('span', { className: 'dat-checkline' },
              React.createElement('input', {
                type: 'checkbox',
                className: 'dat-check',
                checked: batchAllOn,
                disabled: roleIds.length === 0,
                onChange: (event) => changeAllBatch(event.target.checked === true),
              })),
            React.createElement('span', { className: 'dat-hintslot', key: 'hint' }, batchMixed ? text('bulkBatchMixed') : '')),
        ),
        React.createElement('div', { className: 'dat-bulk-hint', key: 'hint' }, text('bulkHint')),
        React.createElement('div', { className: 'dat-bulk-hint', key: 'presetHint' }, text('bulkPresetHint')),
      ]
      if (effortHint !== '') {
        children.push(React.createElement('div', { className: 'dat-note', key: 'effortHint' }, effortHint))
      }
      return React.createElement('div', { className: 'dat-bulk', key: 'bulk' }, children)
    }

    /**
     * 一行的「agent 预设」下拉。
     *
     * 三个刻意的形状：
     *   * 注册表里没有 / 那份组合挂载失败的 id **留着但禁用**，并在括号里写原因 ——
     *     藏起来只会让人以为功能坏了（与思考强度那列同一套处理，见 renderBulkModels 的注释）；
     *   * 已保存但当前不可选的 id 插一个占位项，让下拉显示的是**真实值**而不是浏览器退回的第一项；
     *   * title 里放「只对之后新派的队员生效」，因为这一列不像模型那样即时生效。
     */
    const renderPreset = (roleId, row) => {
      const current = row.preset === undefined ? '' : row.preset
      const options = [React.createElement('option', { key: '__inherit', value: '' }, text('presetInherit'))]
      let known = current === ''
      for (const preset of presets) {
        if (preset.id === current) known = true
        options.push(React.createElement('option', {
          key: preset.id,
          value: preset.id,
          disabled: preset.available !== true,
        }, presetLabel(preset) + (preset.available === true ? '' : '（' + text(preset.reason === 'broken' ? 'presetBroken' : 'presetMissing') + '）')))
      }
      if (!known) {
        options.push(React.createElement('option', { key: '__missing', value: current }, text('presetStale', { id: current })))
      }
      return React.createElement('label', { className: 'dat-field', title: text('presetAppliesNext') },
        React.createElement('span', { className: 'dat-label' }, text('presetLabel')),
        React.createElement('select', {
          className: 'dat-select',
          value: current,
          disabled: modelSelectDisabled || presets.length === 0,
          onChange: (event) => changePreset(roleId, event.target.value),
        }, options))
    }
    const renderRow = (role) => {
      const row = draft[role.id] === undefined ? makeRow('', '', '', true) : draft[role.id]
      const record = catalog !== null && row.key !== '' ? catalog.byKey[row.key] : undefined
      const missing = row.key !== '' && record === undefined
      const modelOptions = [React.createElement('option', { key: '__inherit', value: '' }, text('inherit'))]
      if (missing) {
        const label = row.key.split(SEP).join(' / ')
        modelOptions.push(React.createElement('option', { key: '__missing', value: row.key }, text('missingModel', { label })))
      }
      if (catalog !== null) {
        for (const group of catalog.options) {
          modelOptions.push(React.createElement('optgroup', { key: group.id, label: group.label },
            group.models.map((model) => React.createElement('option', { key: model.key, value: model.key }, model.provider + ' / ' + model.label))))
        }
      }
      return React.createElement('div', { className: 'dat-row', key: role.id },
        React.createElement('div', { className: 'dat-role' },
          React.createElement('div', { className: 'dat-role-head' },
            React.createElement('span', { className: 'dat-name' }, role.label),
            React.createElement('code', { className: 'dat-id' }, role.id),
            role.labelEn === '' ? null : React.createElement('span', { className: 'dat-id' }, role.labelEn)),
          role.mission === '' ? null : React.createElement('div', { className: 'dat-mission' }, role.mission)),
        // 批量调用开关单独一格，夹在角色信息与三个下拉**之间**：正好填掉原来那块空白，
        // 也不把下拉那一列摞成四行（用户 2026-10-15 的版面要求）。
        React.createElement('label', { className: 'dat-batch', title: text('batchTip') },
          React.createElement('span', { className: 'dat-label' }, text('batchLabel')),
          React.createElement('span', { className: 'dat-checkline' },
            React.createElement('input', {
              type: 'checkbox',
              className: 'dat-check',
              checked: row.batch !== false,
              onChange: (event) => changeBatch(role.id, event.target.checked === true),
            }))),
        React.createElement('div', { className: 'dat-ctl' },
          React.createElement('label', { className: 'dat-field' },
            React.createElement('span', { className: 'dat-label' }, text('modelLabel')),
            React.createElement('select', {
              className: 'dat-select',
              value: row.key,
              disabled: modelSelectDisabled,
              onChange: (event) => changeModel(role.id, event.target.value),
            }, modelOptions)),
          renderEffort(role.id, row, record),
          renderPreset(role.id, row)))
    }

    /**
     * 缓存保活 + 结构化汇报。
     *
     * 为什么显示这些数字：保活是**要花钱的**（每次 ping 都要重读整段前缀，只是按缓存价计）。
     * 所以面板必须让用户看到「这条线路到底开没开、发了几次、命中几次、读了多少 token」，
     * 而不是让他相信一句「已经帮你省钱了」。拿不到证据时 0 就显示 0，不美化。
     */
    const renderCacheSection = () => {
      const rows = []
      const route = cache !== null && (asText(cache.provider) !== '' || asText(cache.model) !== '')
        ? asText(cache.provider) + '/' + asText(cache.model)
        : ''
      const active = cache !== null && cache.installed !== false && cache.active === true
      if (!active) rows.push(React.createElement('div', { className: 'dat-note', key: 'cacheInactive' }, text('cacheInactive')))
      if (active) {
        const stats = cache.stats !== null && typeof cache.stats === 'object' ? cache.stats : {}
        const ratio = formatRatio(stats.hitRatio)
        rows.push(React.createElement('div', { className: 'dat-note', key: 'cacheRoute' },
          route === '' ? text('cacheRoute', { route: text('wsUnknownRoute') }) : text('cacheRoute', { route }),
          ' · ',
          text('cacheMode', { mode: asText(cache.mode), source: asText(cache.source) }),
          ' · ',
          text('cacheInterval', { seconds: String(cache.intervalSeconds === undefined ? '?' : cache.intervalSeconds) })))
        rows.push(React.createElement('div', { className: 'dat-note', key: 'cacheArmed' },
          cache.armed === true ? text('cacheArmed') : text('cacheNotArmed')))
        if (asText(cache.stopped) !== '') rows.push(React.createElement('div', { className: 'dat-note', key: 'cacheStopped' }, text('cacheStopped', { reason: asText(cache.stopped) })))
        rows.push(React.createElement('div', { className: 'dat-note', key: 'cachePings' },
          text('cachePings', {
            pings: String(stats.pings === undefined ? 0 : stats.pings),
            hits: String(stats.pingHits === undefined ? 0 : stats.pingHits),
            tokens: String(cache.pingTokens === undefined ? 0 : cache.pingTokens),
          })))
        rows.push(React.createElement('div', { className: 'dat-note', key: 'cacheRequests' },
          text('cacheRequests', { requests: String(stats.requests === undefined ? 0 : stats.requests), ratio: ratio === '' ? text('cacheRatioUnknown') : ratio })))
      }
      // 线路族默认值：让用户知道「为什么 deepseek 默认不开」。
      // 注意 `ttlSeconds: null`（例如 DeepSeek 的磁盘缓存）**也要显示** —— 那正是最需要解释的一条。
      const families = cacheFamilies.filter((family) => family.id !== '')
      if (families.length > 0) {
        rows.push(React.createElement('ul', { className: 'dat-diag', key: 'cacheFamilies' },
          families.map((family) => React.createElement('li', { key: family.id },
            text('cacheWhy', {
              id: family.id,
              mode: family.mode,
              ttl: family.ttl > 0 ? text('wsTtlSeconds', { ttl: String(family.ttl) }) : text('wsTtlUnknown'),
              why: family.why,
            })))))
      }
      // 线路覆盖编辑器：key 直接是 provider/model、provider 或族 id（宿主按「越具体越优先」匹配）。
      const overrideKeys = Object.keys(cacheDraft)
      const modeSelect = (value, onChange) => React.createElement('select', { className: 'dat-select', value, onChange },
        React.createElement('option', { value: 'auto' }, text('cacheModeAuto')),
        React.createElement('option', { value: 'on' }, text('cacheModeOn')),
        React.createElement('option', { value: 'off' }, text('cacheModeOff')))
      rows.push(React.createElement('div', { className: 'dat-note', key: 'cacheOverrideTitle' }, text('cacheOverrideTitle')))
      rows.push(React.createElement('div', { className: 'dat-list', key: 'cacheOverrides' },
        overrideKeys.map((key) => React.createElement('div', { className: 'dat-row', key: 'override-' + key },
          React.createElement('div', { className: 'dat-role' }, React.createElement('code', { className: 'dat-id' }, key)),
          React.createElement('div', { className: 'dat-ctl' },
            React.createElement('label', { className: 'dat-field' },
              React.createElement('span', { className: 'dat-label' }, text('cacheRouteMode')),
              modeSelect(cacheDraft[key].mode === undefined ? 'auto' : cacheDraft[key].mode, (event) => {
                const next = cloneRouteDraft(cacheDraft)
                next[key] = Object.assign({}, next[key], { mode: event.target.value })
                setCacheDraft(next)
              })),
            React.createElement('label', { className: 'dat-field' },
              React.createElement('span', { className: 'dat-label' }, text('cacheRouteInterval')),
              React.createElement('input', {
                className: 'dat-select',
                type: 'number',
                min: 60,
                max: 3540,
                value: cacheDraft[key].intervalSeconds === undefined ? '' : String(cacheDraft[key].intervalSeconds),
                onChange: (event) => {
                  const raw = event.target.value
                  const next = cloneRouteDraft(cacheDraft)
                  const row = Object.assign({}, next[key])
                  if (raw === '') delete row.intervalSeconds
                  else row.intervalSeconds = Number(raw)
                  next[key] = row
                  setCacheDraft(next)
                },
              })),
            React.createElement('button', {
              className: 'dat-btn',
              onClick: () => {
                const next = cloneRouteDraft(cacheDraft)
                delete next[key]
                setCacheDraft(next)
              },
            }, text('cacheRemove')))))))
      rows.push(React.createElement('div', { className: 'dat-actions', key: 'cacheAdd' },
        React.createElement('input', {
          className: 'dat-select',
          type: 'text',
          placeholder: text('cacheRouteKey'),
          value: overrideKey,
          onChange: (event) => setOverrideKey(event.target.value),
        }),
        modeSelect(overrideMode, (event) => setOverrideMode(event.target.value)),
        React.createElement('input', {
          className: 'dat-select',
          type: 'number',
          min: 60,
          max: 3540,
          placeholder: text('cacheRouteInterval'),
          value: overrideInterval,
          onChange: (event) => setOverrideInterval(event.target.value),
        }),
        React.createElement('button', {
          className: 'dat-btn',
          disabled: overrideKey.trim() === '',
          onClick: () => {
            const key = overrideKey.trim()
            if (key === '') return
            const row = { mode: overrideMode }
            const interval = Number(overrideInterval)
            if (overrideInterval !== '' && Number.isFinite(interval)) row.intervalSeconds = interval
            const next = cloneRouteDraft(cacheDraft)
            next[key] = row
            setCacheDraft(next)
            setOverrideKey('')
            setOverrideInterval('')
          },
        }, text('cacheAdd'))))
      // 结构化汇报：谁交了什么状态、有几条未决项（未决项 = 阻止验收）。
      rows.push(React.createElement('div', { className: 'dat-note', key: 'reportsTitle' }, text('reportsTitle')))
      const reportRows = reports === null ? [] : reports.rows
      rows.push(reportRows.length === 0
        ? React.createElement('div', { className: 'dat-note', key: 'reportsEmpty' }, text('reportsEmpty'))
        : React.createElement('ul', { className: 'dat-diag', key: 'reports' }, reportRows.map((report, index) => React.createElement('li', { key: 'report-' + index },
          text('reportLine', {
            name: report.name === '' ? '?' : report.name,
            status: report.status === '' ? '?' : report.status,
            unresolved: report.unresolved > 0 ? text('reportUnresolved', { count: String(report.unresolved) }) : '',
            notDelivered: report.notDelivered ? text('reportNotDelivered') : '',
          })))))
      // 被上限挤掉的条数要如实说：只显示 8 条而不说总数，等于让用户以为汇报就这些。
      if (reports !== null && reports.dropped > 0) {
        rows.push(React.createElement('div', { className: 'dat-note', key: 'reportsDropped' },
          text('reportsDropped', { dropped: String(reports.dropped), cap: String(reports.cap) })))
      }
      // 会话记忆：宿主重启后有哪几个会话会自动把团队装回来（2026-10-01「移除：spawn_teammate…」的修复面）。
      if (sessions !== null) {
        rows.push(React.createElement('div', { className: 'dat-note', key: 'sessionsTitle' }, text('sessionsTitle')))
        rows.push(React.createElement('div', { className: 'dat-note', key: 'sessionsLine' },
          text('sessionsLine', { tracked: String(sessions.tracked), restored: String(sessions.restored) })))
      }
      return React.createElement('div', { className: 'dat-cache', key: 'cache' },
        React.createElement('div', { className: 'dat-head' }, React.createElement('span', null, text('cacheTitle'))),
        rows)
    }

    const children = [
      React.createElement('div', { className: 'dat-head', key: 'head' },        React.createElement('span', null, text('configured', { count: configured, total: roles.length })),
        dirty ? React.createElement('span', { className: 'dat-unsaved' }, '· ' + text('unsaved')) : null),
    ]
    if (phase === 'loading') children.push(React.createElement('div', { className: 'dat-note', key: 'loading' }, text('loading')))
    if (phase === 'failed') children.push(React.createElement('div', { className: 'dat-msg err', key: 'loadError' }, text('loadFailed', { message: loadError })))
    if (modelsError !== '') children.push(React.createElement('div', { className: 'dat-msg warn', key: 'modelsError' }, modelsError))
    if (catalog === null && phase === 'ready') children.push(React.createElement('div', { className: 'dat-note', key: 'catalogMissing' }, text('catalogMissing')))
    // 宿主诊断必须显示：配置文件坏掉时宿主会退回空配置并记一条诊断，页面以前完全忽略它，
    // 于是用户看到的是「全部跟随 Lead」的假象，随手一保存就把残留内容整份覆盖掉。
    if (diagnostics.length > 0) {
      children.push(React.createElement('div', { className: 'dat-msg warn', key: 'diagnostics' },
        React.createElement('div', null, text('diagnosticsTitle')),
        React.createElement('ul', { className: 'dat-diag' }, diagnostics.map((line, index) => React.createElement('li', { key: 'diag-' + index }, line)))))
    }
    // 信息通道用中性样式：这些行在**一切正常**时也会存在（DSH 主目录、配置文件路径、
    // 控制面注册结果）。2026-09-28 用户看到的就是它们在红色告警标题下 —— 语义错了，不是坏了。
    if (notes.length > 0) {
      children.push(React.createElement('div', { className: 'dat-note', key: 'notes' },
        React.createElement('div', null, text('notesTitle')),
        React.createElement('ul', { className: 'dat-diag' }, notes.map((line, index) => React.createElement('li', { key: 'note-' + index }, line)))))
    }
    if (phase === 'ready' && roles.length === 0) children.push(React.createElement('div', { className: 'dat-msg err', key: 'noRoles' }, text('noRoles')))
    // 统一选择队员模型放在角色列表**之上**（用户要求的位置）：它服务的就是下面那一列角色。
    if (phase === 'ready' && roles.length > 0) children.push(renderBulkModels())
    if (phase === 'ready' && roles.length > 0) children.push(React.createElement('div', { className: 'dat-list', key: 'list' }, roles.map(renderRow)))
    if (phase === 'ready') children.push(renderCacheSection())
    if (message !== null) children.push(React.createElement('div', { className: 'dat-msg ' + message.kind, key: 'message' }, message.text))
    children.push(React.createElement('div', { className: 'dat-actions', key: 'actions' },
      React.createElement('button', { className: 'dat-btn', disabled: busy || phase !== 'ready' || roles.length === 0 || !dirty, onClick: onSave }, busy ? text('saving') : text('save')),
      React.createElement('button', { className: 'dat-btn', disabled: busy || phase !== 'ready' || !dirty, onClick: onDiscard }, text('discard')),
      // 重载在 failed 阶段也必须可用：加载失败后这是用户唯一的恢复入口。
      // 只在「正在加载中」禁用，避免与在途请求竞态。
      React.createElement('button', { className: 'dat-btn', disabled: busy || phase === 'loading', onClick: onReload }, text('reload')),
      React.createElement('button', { className: 'dat-btn', disabled: busy || phase !== 'ready', onClick: onReset }, confirmReset ? text('resetConfirm') : text('reset'))))
    children.push(React.createElement('div', { className: 'dat-foot', key: 'foot' }, text('footnote')))

    return React.createElement('div', { className: 'dat-wrap' }, children)
  }

  // ── 工作区画布（「进入工作区」）─────────────────────────────────────────────
  //
  // 入口为什么走「锚点 + 面板注入」而不是直接在顶栏放按钮：用户 2026-10-08 的截图把入口
  // 圈在官方成员面板「成员」标题行的右上角。那个面板整体在只读 app.asar 里
  // （dsh-experimental-client-ui-agent-team 的 TeamAction），我们改不动它的 JSX；但它留了
  // 两个稳定钩子：面板根 [data-team-panel]（createPortal 挂到 document.body，
  // 开/关 = body 的直接子节点增删）与触发器 [data-team-action] + aria-expanded。
  // 本文件注册在**同一个槽** conversation.session.header.actions 上的锚点组件与官方触发器
  // 是兄弟节点（同一个 headerActions 容器），锚点带着权威的 sessionId（scope:"session"
  // 由槽位系统注入，官方 TeamAction 同款 props）。于是：面板挂载 → 找到展开中的触发器 →
  // 读它兄弟锚点的 sessionId → 把「进入工作区」塞进面板的「成员」h3。
  // **会话 id 永远来自 React prop，不解析 DOM 猜**；官方标记消失时 drift-check 会红。
  const ENTRY_CLASS = 'dat-entry'
  const ANCHOR_ATTR = 'data-ws-session'
  const PANEL_ATTR = 'data-team-panel'
  const ACTION_ATTR = 'data-team-action'

  /** 组件外（工作区覆盖层是命令式 DOM）用的文案：与组件内同一条语言链。 */
  function wsText(key, params) {
    return localeText(key, params)
  }

  /**
   * 宿主画布提示的 code → 字典键（与 lib/graph.js 的 notes.push({code}) **双向对齐**，
   * 对不齐由 selftest 闸门当场抓住）。
   *
   * 为什么服务端不直接拼句子（2026-10-15 用户点头做的）：宿主半不知道界面语言
   * （dsh-client-locale 的 active 只在浏览器里有值），拼了中文，英文界面就只能
   * 看一串中文 —— 而这条通道此前正是这么做的（画布底栏那 7 条降级提示）。
   * 同一理由已用在 taskTip / 折叠工具组 / 回合结局上。
   * 注意：lib/runtime.js 里**另一个**同名 notes 是配置页 + 磁盘状态文件通道
   * （排障用语，40 多个推送点），不在这次范围，两套别混。
   */
  const WS_NOTE_CODES = {
    noLiveAgent: 'wsNoteNoLiveAgent',
    persistReadFailed: 'wsNotePersistReadFailed',
    rosterReadFailed: 'wsNoteRosterReadFailed',
    recoveredFromProjection: 'wsNoteRecoveredProjection',
    recoveredFromLog: 'wsNoteRecoveredLog',
    noHistoryRoster: 'wsNoteNoHistoryRoster',
    tasksReadFailed: 'wsNoteTasksReadFailed',
  }

  /**
   * 一条宿主提示 → 当前语言的句子。
   * @param {object|string} note - {code, params}；**字符串也接受**：浏览器刷新到新半
   *   但 DSH 没重启时宿主还在发旧句子，直通显示比当场报错好。
   * @returns {string}
   */
  function wsNoteText(note) {
    if (typeof note === 'string') return note
    if (note === null || note === undefined || typeof note !== 'object') return ''
    const key = WS_NOTE_CODES[String(note.code ?? '')]
    const params = note.params === null || note.params === undefined ? {} : note.params
    if (key === undefined) {
      // 新宿主发了本半不认识的 code（宿主比浏览器新）：如实显示 code 本身，
      // 不编句子也不吞掉 —— 吞掉就等于把「有降级」这件事从画布上抹了。
      // （不加项目符号：已知 code 那边也没有，两种行的形状必须一致。）
      return String(note.code ?? '')
    }
    if (key === 'wsNoteRecoveredProjection') {
      // 「与 N 条任务」是可选子句：条件放这儿（数字>0），片段本身仍是字典句子。
      const taskCount = Number(params.tasks) || 0
      return wsText(key, {
        count: String(params.count ?? '0'),
        tasks: taskCount > 0 ? wsText('wsNoteTasksSuffix', { count: String(taskCount) }) : '',
      })
    }
    return wsText(key, params)
  }

  /** 整批宿主提示 → 多行悬停文本（底栏那颗琥珀色标签的 title）。 */
  function wsNotesText(notes) {
    const list = Array.isArray(notes) ? notes : []
    return list.map(wsNoteText).filter((line) => line !== '').join(String.fromCharCode(10))
  }

  function TeamEntryAnchor(props) {
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
    // 锚点自身不可见：真正的入口按钮注入到官方成员面板里（见 ensureTeamEntry）。
    const attrs = { style: { display: 'none' }, 'aria-hidden': 'true' }
    attrs[ANCHOR_ATTR] = sessionId
    return React.createElement('span', attrs)
  }

  let entryObserver
  const entryPanels = new WeakMap()
  let entryGlobalWatcher

  /**
   * 面板 ↔ 会话 的配对。
   * DOM 形状（官方 renderer 的 outlet 是 `<div data-slot style="display:contents">`，
   * 见 dsh-client-ui-renderer/lib/client.js:1094/1099；官方 TeamAction 的根带 data-team-action）：
   *   [data-slot] > [data-team-action] > button[aria-expanded]   ← 官方触发器
   *   [data-slot] > span[data-ws-session]                        ← 我们的锚点（同一个 outlet 的兄弟）
   * 从「展开中的触发器」出发向上走，第一个**含锚点**的容器就是 outlet；里面恰好一个锚点才配对，
   * 多于一个 = 歧义，宁可不放按钮也不猜会话（猜错会打开别的团队的画布）。
   * @returns {string} sessionId；配不出来时 ''。
   */
  function resolvePanelSession() {
    const triggers = [...document.querySelectorAll(
      '[' + ACTION_ATTR + '] [aria-expanded="true"], [' + ACTION_ATTR + '][aria-expanded="true"]',
    )]
    if (triggers.length !== 1) return ''
    let node = triggers[0].closest('[' + ACTION_ATTR + ']')
    for (let hop = 0; hop < 6 && node !== null && node !== undefined; hop += 1) {
      const anchors = node.querySelectorAll('[' + ANCHOR_ATTR + ']')
      if (anchors.length === 1) return String(anchors[0].getAttribute(ANCHOR_ATTR) ?? '')
      if (anchors.length > 1) return ''
      node = node.parentElement
    }
    return ''
  }

  /** 往面板的「成员」标题行右侧塞入口按钮（幂等；解析不到会话就不放按钮，点了没反应的按钮比没有按钮更糟）。 */
  function injectEntryButton(panel, sessionId) {
    if (panel === null || panel === undefined) return
    // 官方面板：body 里第一个 section 是 roster（成员），第二个是 tasks（共享任务）。
    // 只认「第一个 section 的 h3」而不是「第一个 h3」：官方以后若调换区段顺序，
    // 前者最多是按钮不出现（section 找不到就返回），后者会把按钮挂到「共享任务」旁边 —— 位置错了更糟。
    const heading = panel.querySelector('section h3') ?? panel.querySelector('h3')
    if (heading === null || heading === undefined) return
    const existing = heading.querySelector('.' + ENTRY_CLASS)
    if (sessionId === '') {
      if (existing !== null) existing.remove()
      return
    }
    if (existing !== null) return
    const button = document.createElement('button')
    button.type = 'button'
    button.className = ENTRY_CLASS
    button.textContent = wsText('wsEnter')
    button.addEventListener('click', (event) => {
      event.preventDefault()
      // 点击时**重新解析**会话：面板可能已经被 React 换到另一个会话（缓存注入时刻的 id 会开错团队）。
      const current = resolvePanelSession()
      if (current === '') return
      openWorkspace(current)
    })
    heading.appendChild(button)
  }

  function syncTeamEntry() {
    if (typeof document === 'undefined') return
    const panels = [...document.querySelectorAll('[' + PANEL_ATTR + ']')]
    // 两个以上面板 = 无法确定按钮该属于哪一个（面板被 portal 到 body，和触发器没有 DOM 父子关系）。
    // 此时把所有面板上的按钮**摘掉**：点了没反应的按钮比没有按钮更糟，
    // 而猜一个可能错的会话去开画布更不可接受。
    if (panels.length !== 1) {
      for (const panel of panels) injectEntryButton(panel, '')
      if (entryGlobalWatcher !== undefined) { entryGlobalWatcher.disconnect(); entryGlobalWatcher = undefined }
      return
    }
    const panel = panels[0]
    injectEntryButton(panel, resolvePanelSession())
    if (entryPanels.get(panel) !== true) {
      entryPanels.set(panel, true)
      if (entryGlobalWatcher !== undefined) entryGlobalWatcher.disconnect()
      // React 重渲染可能整批换掉 h3 的子节点：盯住这个面板补挂一次。
      entryGlobalWatcher = new MutationObserver(() => injectEntryButton(panel, resolvePanelSession()))
      entryGlobalWatcher.observe(panel, { childList: true, subtree: true })
    }
  }

  function ensureTeamEntry() {
    if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return
    if (entryObserver !== undefined) return
    // 只盯 body 的**直接**子节点：面板是 portal，开/关正好落在这里；
    // 聊天流式更新发生在深层子树，subtree:false 让我们不会被每次 token 唤醒。
    entryObserver = new MutationObserver(() => syncTeamEntry())
    entryObserver.observe(document.body, { childList: true })
    syncTeamEntry()
  }

  function disposeTeamEntry() {
    if (entryObserver !== undefined) { entryObserver.disconnect(); entryObserver = undefined }
    if (entryGlobalWatcher !== undefined) { entryGlobalWatcher.disconnect(); entryGlobalWatcher = undefined }
    closeWorkspace()
  }

  // ── 覆盖层本体（命令式：数据 → 分层布局 → 节点/连线/流光/浮窗）──────────────
  const WS_NODE_W = 196
  const WS_NODE_H = 142
  const WS_GAP_Y = 16
  const WS_GAP_X = 132
  const WS_PAD = 26
  /**
   * 箭头与流光亮斑在**屏幕上**的目标尺寸（px）。
   *
   * ⚠️ 必须放在这个共享常量块里：它们同时被 `wsDrawWires`（算亮斑半径）与
   * `openWorkspace`（建 marker / 同步尺寸）使用。第一版把它们声明在 `openWorkspace` 内部，
   * 结果 `wsDrawWires` 里引用 `SPOT_PX` 抛 ReferenceError —— 而且因为渲染被 try/catch 兜住，
   * 表现是「画了 6 条线就静默停下、流光全没了」，排查成本极高。
   */
  /**
   * 箭头在屏幕上的目标尺寸（px）。实际 markerWidth 按缩放补偿，见 wsSyncMarkers。
   *
   * 尺寸沿革：2026-10-08 用户两次报「看不到箭头」→ 定为 12px（45% 缩放下也清楚可见）；
   * 2026-10-09 用户看实际效果后反馈「有点大了，再小 1/3」→ **12 × 2/3 = 8px**。
   * 8px 仍是「能看清」的量级（e2e 的下限断言同步调到 ≥6px，留出余量避免贴边）。
   */
  const WS_ARROW_PX = 8
  /**
   * 线两端「水平短桩」的长度（用户坐标系 px）。见 wsRoute 的说明：
   * 没有它，箭头会跟着斜切线旋转并压进卡片文字里。
   */
  const WS_ARROW_STUB = 14
  /**
   * 折线拐角的**圆角半径**（用户坐标系 px）。见 wsRoundPath：
   * 正交折线不该用样条穿过直角（数学上必然过冲），而是把每个拐角截断后用二次贝塞尔绕过去。
   * 12px 在 45% 缩放下约 5.4px，肉眼是一段干净的圆角，不会看成折角。
   */
  const WS_CORNER_R = 12
  /**
   * **缓坡**的宽度范围（用户坐标系 px）。见 wsRampify。
   *
   * 用户 2026-10-09 第三次反馈（附截图）：「这个直角还存在，参考另一张图不要直角，
   * 就这样一个缓坡就行了」「不要再出现直角的问题了！！」——
   * 即使拐角有 12px 圆角，`水平 → 竖直 → 水平` 的**台阶**在 45% 缩放下看着仍是直角。
   *
   * 修法：把竖直台阶换成**斜线段**（缓坡）。列间通道宽 WS_GAP_X=132px，
   * 中心 ±66 都是无卡区，所以斜线有充足的水平空间，且仍在通道内、不会压到卡片。
   * 宽度随落差自适应：小落差给 WS_RAMP_MIN（很缓），大落差给 WS_RAMP_MAX（通道内上限）。
   */
  const WS_RAMP_MIN = 60
  const WS_RAMP_MAX = 110
  /**
   * 缓坡的目标上限坡度（度）。超过它就值得把这一段展宽。
   * 45° 是「看上去是斜坡而不是台阶」的经验阈值；用户参考图（192511）约 25°。
   */
  const WS_RAMP_SLOPE = 45
  /**
   * 同一条通道（列间隙 / 列间竖直通道）里两条线的最小间距（用户坐标系 px）。
   *
   * 用户 2026-10-09 第 7 次反馈：「不要有线重叠呗，之前说过的，不能有重叠啊」——
   * 于是**按他的感知反推**这个值，而不是拍脑袋：
   *   * 他的原话「6px 用户间距 = 2.7px 屏幕，肉眼仍是一条粗线」⇒ 感知阈值 ≈6px；
   *   * 12px（旧的 12）在 45% 缩放下只有 5.4px 屏幕、边缘间隙 4.8px，
   *     看似够，但**斜段贴近、槽位取整、圆角内切**都会把实际间距吃掉几个 px ——
   *     实测出现 7.7px（3.5px 屏幕）的并行段，肉眼就是一条粗线。
   *   * 18px 在 45% 下 = 8.1px 屏幕，接近箭头尺寸（8px），
   *     即使被上述因素吃掉 4~5px 仍有 6px 以上 ⇒ 真正分得开。
   *
   *   * 实测取舍（试过 15 与 18，都**不要**）：
   *     - 18px：通道里能放的车道变少 ⇒ 线被迫绕远 ⇒ 尖角回归（实测紫 97°、蓝 114°）；
   *     - 15px：蓝色出现 114° 尖角、流光方向也异常；
   *     - **12px 是实测最稳的值**（尖角 ≤63°、流光 23/23 正确）。
   *     真正让线「看着叠」的不是这个值太小，而是下面那个**槽位取整 bug**
   *     （带末尾补槽与前一个步进槽只差 10px），已在 freeSlotsOf 里修掉。
   *
   * 代价：每条通道能容纳的独立车道变少（列的无卡空间有几百 px，实测够用）。
   */
  const WS_LANE_GAP = 12
  const ws = { root: null, timer: 0, state: null, raf: 0 }

  /** HTML 转义（markdown 渲染的第一步：所有原文先变成文本节点安全的字符串）。 */
  function wsEsc(s) {
    return String(s).replace(/[&<>"']/g, (ch) => (
      ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
    ))
  }

  /**
   * 尝试把从第 i 行开始的 pipe table 解析成 HTML。
   *
   * 支持 GitHub 风格表格（助手回复里最常见的形式）：
   *   | 检查项 | 结果 |
   *   |---|---|
   *   | <home> | 0 命中 |
   * 分隔行（`|---|:--:|--:|`）决定每列对齐；首尾的 `|` 可省略（CommonMark 允许）。
   *
   * 为什么自己写而不是引库：本插件是**纯 DOM bundle**，不能加运行时依赖
   * （宿主 loader 只执行我们这一个 factory，没有模块解析）。
   *
   * 识别条件（三条同时成立才算表格，避免把普通文本里的 `|` 误判）：
   *   ① 当前行含 `|`；
   *   ② 下一行是合法分隔行（每格只由 `-`、`:`、空格组成且至少一个 `-`）；
   *   ③ 两行的列数一致。
   * @param {string[]} lines - 全部行。
   * @param {number} i - 起始行号。
   * @returns {{html:string,next:number}|null} 解析结果（next = 表格之后的行号）；不是表格返回 null。
   */
  function wsTableAt(lines, i) {
    const head = lines[i]
    if (i + 1 >= lines.length || !head.includes('|')) return null
    const splitRow = (raw) => {
      let s = raw.trim()
      // 去掉首尾竖线（CommonMark 允许省略）。
      if (s.startsWith('|')) s = s.slice(1)
      if (s.endsWith('|')) s = s.slice(0, -1)
      // 按未转义的 `|` 切分（`\|` 是字面竖线）。
      return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
    }
    const sep = splitRow(lines[i + 1])
    if (sep.length === 0) return null
    // 分隔行每格必须是 `:?-+:?` 形态。
    if (!sep.every((c) => /^:?-+:?$/.test(c))) return null
    const cols = splitRow(head)
    if (cols.length !== sep.length) return null
    const aligns = sep.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
    const rows = []
    let j = i + 2
    while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') {
      const cells = splitRow(lines[j])
      // 单元格数与表头不一致时：补齐/截断（真实日志里偶尔少写一个尾格）。
      while (cells.length < cols.length) cells.push('')
      rows.push(cells.slice(0, cols.length))
      j += 1
    }
    const styleOf = (k) => (aligns[k] === '' ? '' : ' style="text-align:' + aligns[k] + '"')
    const th = cols.map((c, k) => '<th' + styleOf(k) + '>' + wsMdInline(wsEsc(c)) + '</th>').join('')
    const tb = rows.map((r) => '<tr>' + r.map((c, k) => '<td' + styleOf(k) + '>' + wsMdInline(wsEsc(c)) + '</td>').join('') + '</tr>').join('')
    return { html: '<div class="md-table"><table><thead><tr>' + th + '</tr></thead><tbody>' + tb + '</tbody></table></div>', next: j }
  }

  /**
   * 行内 markdown → HTML（粗体/斜体/行内码/链接）。
   * 输入**必须已经过 wsEsc**，所以这里产出的标签全部是我们自己拼的，
   * 用户文本里的 `<script>` 只会以字面量出现。
   */
  function wsMdInline(escaped) {
    let out = escaped
    // 行内码先占位，避免里面的 * _ 被当成强调。
    const codes = []
    out = out.replace(/`([^`\n]+)`/g, (_m, inner) => {
      codes.push(inner)
      return '\u0000C' + (codes.length - 1) + '\u0000'
    })
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])__([^_\n]+)__/g, '$1<strong>$2</strong>')
      .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      // 链接：只放行 http/https，其余（javascript: 等）按纯文本处理。
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    out = out.replace(/\u0000C(\d+)\u0000/g, (_m, i) => '<code>' + codes[Number(i)] + '</code>')
    return out
  }

  /**
   * 迷你 markdown 渲染器（抽屉对话专用）。
   *
   * 为什么必须有（用户 2026-10-09：「聊天没有正确渲染文字，现在全是乱码以及*」）：
   * 助手正文是 markdown，之前用 textContent 直出 → `**粗体**`、`### 标题`、
   * ``` 代码块全是裸符号，用户看到的是「乱码」。
   *
   * 为什么自己写而不是复用官方的：官方 MarkdownText 是 React 组件
   * （dsh-client-ui-primitives/lib/index.js:11814，注释 :11168 自证 mdast→React），
   * 本插件是纯 DOM bundle，官方 asar 里没有任何 iframe/shadow 复用通道。
   *
   * 安全：先整体 wsEsc 再做替换 → 任何 HTML 标签都只能由我们自己拼出来。
   * 支持：标题 #~####、无序/有序列表、围栏代码块、行内码、粗斜删、链接、
   * 引用块、分割线、段落。表格/图片按纯文本原样显示（不猜语义）。
   * @param {string} text - markdown 原文。
   * @returns {string} HTML。
   */
  function wsMarkdown(text) {
    const src = String(text ?? '')
    const lines = src.split(/\r?\n/)
    const html = []
    let i = 0
    let para = []
    const flushPara = () => {
      if (para.length === 0) return
      html.push('<p>' + para.map((l) => wsMdInline(wsEsc(l))).join('<br>') + '</p>')
      para = []
    }
    while (i < lines.length) {
      const line = lines[i]
      // 队员结构化报告的首行「【report_result】名字 · 状态」（tools.js formatReport 固定格式）：
      // 渲染成小标题样式并在此**就地消费掉**，避免它以普通段落混在正文里
      // —— 与抽屉顶部 who 标签（senderName · 类别）互补：who 说「谁」，这行说「报告 + 状态」。
      const reportHead = line.match(/^【report_result】(.+?)\s·\s(completed|failed|blocked|needs_decision)\s*$/)
      if (reportHead !== null) {
        flushPara()
        html.push('<p class="rr-head"><b>【report_result】</b>' + wsMdInline(wsEsc(reportHead[1])) + ' · <i>' + wsEsc(reportHead[2]) + '</i></p>')
        i += 1
        continue
      }
      // 围栏代码块：整段收进来，内部不做任何 markdown 解释。
      const fence = line.match(/^\s*```(\w*)\s*$/)
      if (fence !== null) {
        flushPara()
        const buf = []
        i += 1
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i += 1 }
        i += 1
        html.push('<pre><code>' + wsEsc(buf.join('\n')) + '</code></pre>')
        continue
      }
      const head = line.match(/^(#{1,4})\s+(.*)$/)
      if (head !== null) {
        flushPara()
        html.push('<h' + head[1].length + '>' + wsMdInline(wsEsc(head[2])) + '</h' + head[1].length + '>')
        i += 1
        continue
      }
      if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
        flushPara()
        html.push('<hr>')
        i += 1
        continue
      }
      if (/^\s*>\s?/.test(line)) {
        flushPara()
        const buf = []
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i += 1 }
        html.push('<blockquote>' + buf.map((l) => wsMdInline(wsEsc(l))).join('<br>') + '</blockquote>')
        continue
      }
      // 表格（GitHub 风格 pipe table）。必须放在列表**之前**判断：
      // 表格行的第一个字符也是 `|`，而 `|` 不在列表标记集里，顺序其实无所谓，
      // 但放前面能让「表格被误判成段落」这类回归立刻暴露。
      //
      // 用户 2026-10-09 截图：`| 检查项 | 结果 |` 与 `|---|---|` 原样显示成乱码
      // （因为渲染器只支持标题/列表/代码/引用/链接）。表格是助手回复里最常见的结构之一，
      // 尤其在「逐条裁决」「扫描结果」这类内容里，不渲染等于整段不可读。
      const table = wsTableAt(lines, i)
      if (table !== null) {
        flushPara()
        html.push(table.html)
        i = table.next
        continue
      }
      const ul = line.match(/^\s*[-*+]\s+(.*)$/)
      if (ul !== null) {
        flushPara()
        const items = []
        while (i < lines.length) {
          const m = lines[i].match(/^\s*[-*+]\s+(.*)$/)
          if (m === null) break
          items.push(m[1]); i += 1
        }
        html.push('<ul>' + items.map((it) => '<li>' + wsMdInline(wsEsc(it)) + '</li>').join('') + '</ul>')
        continue
      }
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
      if (ol !== null) {
        flushPara()
        const items = []
        while (i < lines.length) {
          const m = lines[i].match(/^\s*\d+[.)]\s+(.*)$/)
          if (m === null) break
          items.push(m[1]); i += 1
        }
        html.push('<ol>' + items.map((it) => '<li>' + wsMdInline(wsEsc(it)) + '</li>').join('') + '</ol>')
        continue
      }
      if (line.trim() === '') { flushPara(); i += 1; continue }
      para.push(line)
      i += 1
    }
    flushPara()
    return html.join('')
  }

  function wsFmtN(n) {
    const value = Number(n)
    if (!Number.isFinite(value) || value === 0) return '0'
    if (value >= 1e6) return (value / 1e6).toFixed(value >= 1e7 ? 0 : 1) + 'M'
    if (value >= 1e3) return (value / 1e3).toFixed(value >= 1e4 ? 0 : 1) + 'k'
    return String(Math.round(value))
  }

  function wsFmtD(ms) {
    const value = Number(ms)
    if (!Number.isFinite(value) || value <= 0) return '—'
    const s = Math.round(value / 1000)
    if (s < 60) return s + 's'
    const m = Math.floor(s / 60)
    if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's'
    return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm'
  }

  /**
   * 逐行时间：**官方 formatMessageClock 的移植**（.probe-tmp/chat-client.js:1057-1068，
   * 本轮逐字读过）：当天只给 HH:mm；同年给 clock.md + 空格 + HH:mm；跨年给
   * clock.ymd + 空格 + HH:mm。日期串**走字典**而不是写死「月/日」—— 官方两份值
   * （dsh-client-locale/lib/client.js 实读 asar）zh={m}月{d}日 / {y}年{m}月{d}日，
   * en={m}/{d} / {y}-{m}-{d}，本插件逐字采用（见 zh/en 字典的 wsClockMd / wsClockYmd）。
   * @param {number} time - 事件时间（epoch 毫秒；lib/graph.js 的 row.time）。
   * @param {number} [now] - 「今天」的基准，测试可注入。
   * @returns {string} 空串 = 没有可用时间（官方 time === void 0 时整颗钟都不画）。
   */
  function wsFormatClock(time, now) {
    const ms = Number(time)
    if (!Number.isFinite(ms) || ms <= 0) return ''
    const d = new Date(ms)
    const n = new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now())
    const p2 = (v) => String(v).padStart(2, '0')
    const clock = p2(d.getHours()) + ':' + p2(d.getMinutes())
    if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
      return clock
    }
    const params = { y: String(d.getFullYear()), m: String(d.getMonth() + 1), d: String(d.getDate()) }
    const day = d.getFullYear() === n.getFullYear()
      ? wsText('wsClockMd', params) : wsText('wsClockYmd', params)
    return day + ' ' + clock
  }

  /**
   * 复制小按钮：**官方 MessageIconActions 的复制那颗**（chat-client.js:1129-1163）。
   * 一致的两点：成功后短暂回显（官方 setCopied(true) + 1000ms 复位），以及
   * 剪贴板的**兜底路径** —— 官方 writeClipboard（dsh-client-ui-primitives/lib/index.js，
   * 本轮实读 asar）先试 navigator.clipboard.writeText，拿不到就退回隐藏 textarea +
   * document.execCommand('copy')。只写 clipboard 的话，非安全上下文里用户点了没反应。
   * @param {function():Promise<string>} getText - 取要复制的正文（可能是**异步**的：
   *   被截断的行要先去宿主取全文，见下面 wsCopyTextFor 的理由）。
   * @returns {HTMLElement}
   */
  function wsCopyBtn(getText) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'copybtn'
    btn.setAttribute('aria-label', wsText('wsCopy'))
    btn.title = wsText('wsCopy')
    btn.textContent = wsText('wsCopy')
    let copied = false
    let pending = false
    btn.addEventListener('click', () => {
      if (copied === true || pending === true) return
      pending = true
      let settle
      try {
        // getText 可能**拒绝**（被截断的行要先去宿主取全文，取不到就不该
        // 假装复制成功）：拒绝也算失败，走下面 title 那条路。
        settle = Promise.resolve(getText()).then(
          (text) => wsWriteClipboard(String(text ?? '')), () => false)
      } catch { settle = Promise.resolve(false) }
      void settle.then((ok) => {
        pending = false
        if (ok !== true) {
          // 复制失败要看得见：静默失败等于用户以为复制到了（官方 ok===false 时
          // 不回显 copied，我们这里再把原因挂在 title 上）。
          btn.title = wsText('wsCopyFailed')
          return
        }
        copied = true
        btn.textContent = wsText('wsCopied')
        window.setTimeout(() => {
          copied = false
          btn.textContent = wsText('wsCopy')
          btn.title = wsText('wsCopy')
        }, 1000)
      })
    })
    return btn
  }

  /**
   * 写剪贴板：官方 writeClipboard 的两条路都在（dsh-client-ui-primitives/lib/index.js，
   * 本轮实读 asar）。先试异步 clipboard，拿不到/报错再退 execCommand。
   * @param {string} text - 正文。
   * @returns {Promise<boolean>} 是否成功（官方也是「成功才回显 copied」的语义）。
   */
  function wsWriteClipboard(text) {
    const clip = window.navigator !== undefined && window.navigator.clipboard !== undefined
      ? window.navigator.clipboard : null
    if (clip !== null && typeof clip.writeText === 'function') {
      try {
        return Promise.resolve(clip.writeText(text)).then(() => true, () => wsExecCopy(text))
      } catch { return Promise.resolve(wsExecCopy(text)) }
    }
    return Promise.resolve(wsExecCopy(text))
  }

  /**
   * execCommand 兜底（官方 writeClipboard 的非 clipboard 分支，逐字照做）。
   * @param {string} text - 正文。
   * @returns {boolean} 是否复制成功。
   */
  function wsExecCopy(text) {
    try {
      if (typeof document.execCommand !== 'function') return false
      const el = document.createElement('textarea')
      el.value = text
      el.setAttribute('readonly', '')
      el.style.position = 'fixed'
      el.style.left = '-9999px'
      document.body.appendChild(el)
      el.select()
      try {
        return document.execCommand('copy') === true
      } finally {
        el.remove()
      }
    } catch {
      return false
    }
  }

  /**
   * 「放大查看」面板：把一份工具调用的输入/输出搬到**随视口自适应**的大面板里。
   *
   * 为什么要有它（用户 2026-10-15：「工具调用这个固定容器弹窗太窄了，设计为自适应，
   * 我点开可以用自适应的方式看到完整的工具调用」）：抽屉里的展开层再怎么放宽，
   * 天花板始终是抽屉宽度；而工具调用的输入是一份 JSON、输出是命令回显，两样都长。
   * 取数**不重发**：面板用的就是展开层已经缓存的那一份（team-detail 已经取过、也已经有
   * DETAIL_MAX=32,000 的上限标记），所以点开是瞬时的，也不会和轮询抢接口。
   * @param {object} state - 工作区状态（挂载点 state.root、当前面板 state.zoomEl）。
   * @param {string} title - 面板标题：工具标签 + 目标。
   * @param {Array<{label:string, text:string, error?:boolean}>} parts - 要摊开的几段正文。
   * @returns {void}
   */
  function wsOpenDetailZoom(state, title, parts) {
    if (state === undefined || state === null) return
    const host = state.root
    if (host === undefined || host === null) return
    wsCloseDetailZoom(state)
    const overlay = document.createElement('div')
    overlay.className = 'ws-zoom'
    const panel = document.createElement('div')
    panel.className = 'zp'
    const head = document.createElement('div')
    head.className = 'zh'
    const t = document.createElement('span')
    t.className = 'zt'
    t.textContent = title
    // 复制的是**整份**（几段拼一起，带各自的标题行）：人在放大面板里要的是一整块能粘走的东西。
    const copy = wsCopyBtn(() => Promise.resolve(
      parts.map((part) => part.label + '\n' + part.text).join('\n\n')))
    const x = document.createElement('button')
    x.type = 'button'
    x.className = 'zx'
    x.textContent = '✕'
    x.title = wsText('wsDetailZoomClose')
    head.append(t, copy, x)
    const bodyEl = document.createElement('div')
    bodyEl.className = 'zb'
    for (const part of parts) {
      const l = document.createElement('div')
      l.className = 'zl' + (part.error === true ? ' zerr' : '')
      l.textContent = part.label
      // 与展开层同一个口径：工具正文一律 <pre> + textContent，不走 markdown
      //（花括号与星号会被当语法吃掉，2026-10-11 弹窗乱码就是这条）。
      const pre = document.createElement('pre')
      pre.textContent = part.text
      bodyEl.append(l, pre)
    }
    panel.append(head, bodyEl)
    overlay.appendChild(panel)
    // 点遮罩空白处关闭：判据是**点的就是遮罩本身**（点在面板里时 target 是后代，不误关）。
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) wsCloseDetailZoom(state)
    })
    x.addEventListener('click', () => wsCloseDetailZoom(state))
    host.appendChild(overlay)
    state.zoomEl = overlay
    // 焦点给关闭键：键盘用户点开就能用 Esc/回车关掉，焦点也不会留在展开层那一行上。
    try { x.focus() } catch { /* 无焦点环境（测试替身）忽略 */ }
  }

  /**
   * 关掉放大面板。**幂等**：Esc、✕、点遮罩、关抽屉都调它，重复调用不报错也不留残骸。
   * @param {object} state - 工作区状态。
   * @returns {void}
   */
  function wsCloseDetailZoom(state) {
    if (state === undefined || state === null) return
    const el = state.zoomEl
    state.zoomEl = null
    if (el !== undefined && el !== null && el.parentNode !== null) el.parentNode.removeChild(el)
  }

  /**
   * 展开层顶上那条工具条：目前只有「放大查看」一颗键。
   * @param {object} state - 工作区状态。
   * @param {object} row - 工具行（标题用它的官方标签 + 目标，与折叠那一行同源）。
   * @param {Array<{label:string, text:string}>} parts - 展开层已经画出来的那几段正文。
   * @returns {HTMLElement}
   */
  function wsDetailZoomBar(state, row, parts) {
    const bar = document.createElement('div')
    bar.className = 'dzb'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'dzbtn'
    btn.textContent = wsText('wsDetailZoom')
    btn.title = wsText('wsDetailZoomTip')
    btn.addEventListener('click', (event) => {
      // 必须 stopPropagation：展开层挂在**可点的行**下面，同一次点击不拦下来会顺冒泡
      // 把这一行收起 —— 表现就是「放大面板一闪就没」。
      event.stopPropagation()
      wsOpenDetailZoom(state, wsRowToolLabel(row, state)
        + (typeof row.detail === 'string' && row.detail !== '' ? ' · ' + row.detail : ''), parts)
    })
    bar.appendChild(btn)
    return bar
  }

  /**
   * 一行末尾的「复制 + 时间」小工具行。**谁能有一行**照官方，不是照我觉得好用：
   *   * 用户行（UserMessageNodeView .probe-tmp/chat-client.js:1458-1464：time + clock=start
   *     → 时钟在左、复制在右：:1152 `clock === "start" ? clockEl : null` 打头）；
   *   * 助手回合尾（TurnTailNodeView :6596-6599：time + clock=end → 复制在左、时钟在右，
   *     :1184 endInfo 里 usageAction 在前、clockEl 在后）；
   *   * 团队消息（官方按 turn trigger 渲染，:6719 有 formatMessageClock，**没有**复制键）。
   * 工具行**不给时间**：官方 tool-client.js 里 formatMessageClock 出现 0 次，
   * official-conversation-client.js 里也是 0 次 —— 给每行都贴时间就是超出官方。
   * @param {object} row - 对话行。
   * @param {{copy?:boolean, clock?:boolean, clockSide?:string}} opts - 给哪几样、时钟在哪侧。
   * @returns {HTMLElement|null} 两样都没有时返回 null（不画空行）。
   */
  function wsRowActions(row, opts, getCopyText) {
    const wantCopy = opts.copy === true
    const stamp = opts.clock === true ? wsFormatClock(row.time) : ''
    if (wantCopy !== true && stamp === '') return null
    const line = document.createElement('div')
    line.className = 'rowacts'
    const clockEl = () => {
      const t = document.createElement('span')
      t.className = 'rt'
      t.textContent = stamp
      return t
    }
    const copyEl = () => wsCopyBtn(() => getCopyText(row))
    // 顺序照官方：clock=start 是「时钟 复制」，clock=end 是「复制 时钟」。
    if (opts.clockSide === 'end') {
      if (wantCopy) line.appendChild(copyEl())
      if (stamp !== '') line.appendChild(clockEl())
    } else {
      if (stamp !== '') line.appendChild(clockEl())
      if (wantCopy) line.appendChild(copyEl())
    }
    return line
  }

  /**
   * 「输出速度」的悬停说明（**唯一**一份）。
   *
   * 为什么要有它（用户 2026-10-21）：「tps 应该是 总token/(对话时长−工具调用时长)」。
   * 改口径只是第一步 —— 一个说不出分母的 tps 数字，用户没法判断它是不是还错着。
   * 所以把算式连同两个实际数字一起放进 title：看到 31.1 tps 的人能立刻核对
   * 「生成 14,443 秒 × 31.1 ≈ 449,784 输出 token」是否成立。
   * @param {object} node - 画布节点（含 runtimeMs / toolBusyMs / generatingMs / hasUsage）。
   * @returns {string}
   */
  function wsTpsTip(node) {
    const runtime = wsFmtD(node?.runtimeMs ?? 0)
    const busy = node?.toolBusyMs ?? 0
    if (busy <= 0) return wsText('wsTpsFormulaNoBusy', { runtime })
    return wsText('wsTpsFormula', { runtime, busy: wsFmtD(busy) })
  }

  function wsPct(ratio) {
    const value = Number(ratio)
    return (Number.isFinite(value) ? Math.round(value * 100) : 0) + '%'
  }

  function wsSvg(tag, attrs) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
    for (const key of Object.keys(attrs)) node.setAttribute(key, String(attrs[key]))
    return node
  }

  /** 上下文占用环：**只有环，不放数字**（用户 2026-10-08 明确要求），数值进悬停 title。 */
  /**
   * 上下文环的悬停文本（**唯一**一份）。
   *
   * 为什么必须抽出来（2026-10-14 i18n 审查）：建卡时（wsRing 内部）与刷新时
   * （wsUpdateCard 内部）各有一份**同逻辑的**字符串拼接，抄两份迟早漂移 ——
   * 事实上已经漂了：我先把 wsUpdateCard 那份改成了走字典，wsRing 那份还留着硬编码，
   * 于是同一个环在「刚建出来」和「刷了一轮」两种情况下用两套文案来源。
   * @param {number} used - 已用 token。
   * @param {number} total - 上下文窗口；0 = provider 没给。
   * @returns {string}
   */
  function wsCtxTip(used, total) {
    const u = Number(used) || 0
    const t = Number(total) || 0
    if (u === 0 && t > 0) return wsText('wsCtxWindowOnly', { n: wsFmtN(t) })
    if (u === 0 && t === 0) return wsText('wsCtxUnrecorded')
    if (t > 0) {
      const frac = Math.min(1, u / t)
      return wsText('wsCtxUsedFull', { used: wsFmtN(u), window: wsFmtN(t), pct: String(Math.round(frac * 100)) })
    }
    return wsText('wsCtxUsedOnly', { used: wsFmtN(u) })
  }

  function wsRing(used, total) {
    const size = 30
    const r = (size - 6) / 2
    const c = 2 * Math.PI * r
    const u = Number(used) || 0
    const t = Number(total) || 0
    const frac = t > 0 ? Math.min(1, u / t) : 0
    const color = frac > 0.85 ? 'var(--dat-red)' : frac > 0.6 ? 'var(--dat-amber)' : 'var(--dat-blue)'
    // 「没测量」与「测到 0」的区别见 wsCtxTip：口径与卡片上的 `—` 必须一致。
    const tip = wsCtxTip(u, t)
    const svg = wsSvg('svg', { width: size, height: size, viewBox: '0 0 ' + size + ' ' + size })
    svg.style.flex = 'none'
    const title = wsSvg('title', {})
    title.textContent = tip
    svg.appendChild(title)
    svg.appendChild(wsSvg('circle', {
      cx: size / 2, cy: size / 2, r, fill: 'none', stroke: 'var(--dsw-alias-border-l2,#e5e5e6)', 'stroke-width': 3,
    }))
    svg.appendChild(wsSvg('circle', {
      cx: size / 2, cy: size / 2, r, fill: 'none', stroke: color, 'stroke-width': 3,
      'stroke-dasharray': (c * frac).toFixed(2) + ' ' + c.toFixed(2),
      'stroke-linecap': 'round', transform: 'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')',
    }))
    return svg
  }

  /**
   * 分层：Tarjan SCC 缩点 → 缩点 DAG 上 Kahn 最长路径定层 → 重心法 8 轮层内排序。
   * 从已验收的演示页逐字移植；为什么必须缩点（DFS 删后向边会把互读写的大环全塌进一层）
   * 与为什么不能递归缓存中间深度，见演示页构建脚本里的注释——两处都是踩过的坑。
   */
  function wsLayerize(names, edges, leadName) {
    const nodes = names.slice()
    nodes.push(leadName)
    const adj = new Map(nodes.map((n) => [n, []]))
    for (const e of edges) if (adj.has(e.from) && adj.has(e.to)) adj.get(e.from).push(e.to)

    let idx = 0
    const stack = []
    const onStack = new Set()
    const index = new Map()
    const low = new Map()
    const comps = []
    const strongconnect = (v) => {
      index.set(v, idx); low.set(v, idx); idx += 1
      stack.push(v); onStack.add(v)
      for (const w of adj.get(v) ?? []) {
        if (!index.has(w)) { strongconnect(w); low.set(v, Math.min(low.get(v), low.get(w))) }
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)))
      }
      if (low.get(v) === index.get(v)) {
        const comp = []
        for (;;) { const w = stack.pop(); onStack.delete(w); comp.push(w); if (w === v) break }
        comps.push(comp)
      }
    }
    for (const n of nodes) if (!index.has(n)) strongconnect(n)

    const compOf = new Map()
    comps.forEach((comp, i) => comp.forEach((n) => compOf.set(n, i)))
    const dag = new Map(comps.map((_, i) => [i, new Set()]))
    for (const e of edges) {
      const a = compOf.get(e.from); const b = compOf.get(e.to)
      if (a === undefined || b === undefined || a === b) continue
      dag.get(a).add(b)
    }
    const indeg = new Map([...dag.keys()].map((c) => [c, 0]))
    for (const tos of dag.values()) for (const t of tos) indeg.set(t, (indeg.get(t) ?? 0) + 1)
    const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([c]) => c)
    const depth = new Map([...dag.keys()].map((c) => [c, 0]))
    while (queue.length > 0) {
      const c = queue.shift()
      for (const t of dag.get(c) ?? []) {
        depth.set(t, Math.max(depth.get(t) ?? 0, (depth.get(c) ?? 0) + 1))
        indeg.set(t, indeg.get(t) - 1)
        if (indeg.get(t) === 0) queue.push(t)
      }
    }

    const rank = new Map(nodes.map((n) => [n, depth.get(compOf.get(n)) ?? 0]))
    rank.set(leadName, 0)
    for (const n of names) if ((rank.get(n) ?? 0) < 1) rank.set(n, 1)

    const layers = new Map()
    for (const n of nodes) {
      const r = rank.get(n)
      if (!layers.has(r)) layers.set(r, [])
      layers.get(r).push(n)
    }
    const order = new Map()
    for (const list of layers.values()) list.forEach((n, i) => order.set(n, i))
    const keys = [...layers.keys()].sort((a, b) => a - b)
    for (let iter = 0; iter < 8; iter += 1) {
      const seq = iter % 2 === 0 ? keys : [...keys].reverse()
      for (const r of seq) {
        const list = layers.get(r)
        const bary = new Map()
        for (const n of list) {
          const nb = iter % 2 === 0
            ? edges.filter((e) => e.to === n).map((e) => order.get(e.from))
            : edges.filter((e) => e.from === n).map((e) => order.get(e.to))
          bary.set(n, nb.length > 0 ? nb.reduce((a, b) => a + (b ?? 0), 0) / nb.length : order.get(n))
        }
        list.sort((a, b) => bary.get(a) - bary.get(b))
        list.forEach((n, i) => order.set(n, i))
      }
    }
    return { rank, layers }
  }

  // 三种几何（用户：「线可以拐弯，但幅度不能太大」）：跨层正向 = 水平外推三次贝塞尔；
  // 同层互读写 = 节点侧边的 C 形短弧；回向 = 兜到下方的平缓弧。**M 永远是源** → 流光方向=语义方向。
  function wsCurveLR(x1, y1, x2, y2) {
    const dx = Math.max(40, (x2 - x1) * 0.45)
    return 'M' + x1 + ' ' + y1 + ' C' + (x1 + dx) + ' ' + y1 + ' ' + (x2 - dx) + ' ' + y2 + ' ' + x2 + ' ' + y2
  }
  function wsCurveSame(ax, ay, bx, by, right) {
    const bulge = 26; const s = right ? 1 : -1
    return 'M' + ax + ' ' + ay + ' C' + (ax + s * bulge) + ' ' + ay + ' ' + (bx + s * bulge) + ' ' + by + ' ' + bx + ' ' + by
  }
  function wsCurveBack(x1, y1, x2, y2) {
    return 'M' + x1 + ' ' + y1 + ' C' + (x1 - 46) + ' ' + y1 + ' ' + (x2 - 46) + ' ' + y2 + ' ' + x2 + ' ' + y2
  }

  /** 第 r 列卡片的左边缘 x（与 wsLayout 的 xOf 同式）。 */
  function wsColumnX(r) {
    return WS_PAD + (WS_NODE_W + WS_GAP_X) * r
  }

  /**
   * 同层连线该走哪一侧的竖直通道。
   * 优先走右侧（列与列之间的空隙）；**最后一列没有右邻**，此时走左侧，
   * 否则线会从右边缘出发再横穿自己的卡片到左边去。
   * @param state - 画布状态。
   * @param {number} r - 列号。
   * @returns {'L'|'R'}
   */
  function wsGutterSide(state, r) {
    const maxRank = state.maxRank ?? 0
    return r < maxRank ? 'R' : 'L'
  }

  /**
   * 途经点化简：去重 + 共线合并 → **最短折线**（用户要求「算法要找到最短的路径」）。
   *
   * 为什么必须做（2026-10-09 用户截图报「紫色拐弯这么狠」）：
   *   跨列路由为每个中间列推 `[gX(r-1), y]` 与 `[gX(r), y]` 两点，而 `gX(r-1)` 正是
   *   **上一列的 `gX(r)`** —— 相邻两列缝高相同时就是**连续重复点**。
   *   度量探针实测：`d:builder-entry` 的途经点里 `616,961 → 561,961` 之后又出现
   *   `671,961 → 616,961 → 561,961`，x 序列**回溯**，曲线算出 180° 掉头。
   *
   * 去重解决重复点；共线合并顺带把「同一 y 的一串水平点」压成首尾两点，
   * 于是折线长度最短、途经点最少。
   * `dot < 0` 那道闸门保证只删**夹在中间**的点，绝不删会导致掉头的点。
   *
   * ⚠️ 还要防**反向回头**：正交路由在「分道让位」时可能推出一小段方向相反的边
   * （实测 `616,1119 → 613,1122 → 619,1126 → 616,1129`：x 先减后增再减）。
   * 那种小抖动在圆角折线里会变成两个贴在一起的圆角，看起来正是用户截图里的
   * 「方形凹口」。所以这里把「与上一条边方向相反且很短」的点丢掉。
   * @param {Array<[number,number]>} points
   * @returns {Array<[number,number]>}
   */
  function wsSlimPoints(points) {
    const out = []
    for (const p of points) {
      const last = out[out.length - 1]
      // ① 去重：相邻重复点（<0.5px）会让切线退化 → 回环/尖点。
      if (last !== undefined && Math.abs(last[0] - p[0]) < 0.5 && Math.abs(last[1] - p[1]) < 0.5) continue
      // ② 共线合并：三点叉积≈0 且中间点确实在两端之间 → 删中间点（最短路径）。
      while (out.length >= 2) {
        const a = out[out.length - 2]; const b = out[out.length - 1]
        const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
        if (Math.abs(cross) > 0.5) break
        const dot = (b[0] - a[0]) * (p[0] - b[0]) + (b[1] - a[1]) * (p[1] - b[1])
        if (dot < 0) break
        out.pop()
      }
      out.push([p[0], p[1]])
    }
    // ③ 去掉「方向反转的小抖动」（方形凹口的来源）：若最后三点构成一个很短的回头边，
    //    把中间那个点删掉。阈值用 WS_CORNER_R 的两倍——比圆角半径还短的回头边没有意义。
    const pruned = []
    for (const p of out) {
      pruned.push(p)
      while (pruned.length >= 3) {
        const a = pruned[pruned.length - 3]; const b = pruned[pruned.length - 2]; const c = pruned[pruned.length - 1]
        const v1 = [b[0] - a[0], b[1] - a[1]]
        const v2 = [c[0] - b[0], c[1] - b[1]]
        const len2 = Math.hypot(v2[0], v2[1])
        // 回头（点积为负）且这段很短 → 删中间点，让 a 直接连 c。
        if (v1[0] * v2[0] + v1[1] * v2[1] < 0 && len2 < WS_CORNER_R * 2) { pruned.splice(pruned.length - 2, 1); continue }
        break
      }
    }
    return pruned
  }

  /** 途经点 → path 坐标片段（保留一位小数，减小编译体积）。 */
  function fmtPt(p) {
    return p[0].toFixed(1) + ' ' + p[1].toFixed(1)
  }

  /**
   * 竖直通道（gutter）的**无卡走廊**：给定一个 x，返回它所在通道内可安全行走的 x 区间。
   *
   * 为什么需要（2026-10-09 缓坡引入的穿卡回归，度量探针实测）：
   *   `d:plan-critic` 的缓坡端点被推到 x=874，而卡片 visual-critic-wxd 占 x∈[682,878]
   *   —— 端点落进卡片里（缓坡的宽度上界只看了「相邻水平段的一半」，**没看通道本身有多宽**）。
   *
   * 几何：列间距 WS_GAP_X=132，卡片宽 196，所以每个通道中心两侧各有 66px 空区。
   * 通道中心恒为 `wsGutterX(r) = WS_PAD + (WS_NODE_W + WS_GAP_X)*r + WS_NODE_W + WS_GAP_X/2`
   * = 288 + 328r（对左右两侧通道都成立：最后一列的左侧通道中心 = 288+328(la−1)）。
   * 这里留 6px 余量 ⇒ 安全区间 = 中心 ± (WS_GAP_X/2 − 6)。
   * @param {number} x - 参考 x（必落在某个通道内）。
   * @returns {[number, number]} [安全下界, 安全上界]。
   */
  function wsGutterCorridor(x) {
    const r = Math.round((x - (WS_PAD + WS_NODE_W + WS_GAP_X / 2)) / (WS_NODE_W + WS_GAP_X))
    const center = WS_PAD + (WS_NODE_W + WS_GAP_X) * r + WS_NODE_W + WS_GAP_X / 2
    const half = WS_GAP_X / 2 - 6
    return [center - half, center + half]
  }

  /**
   * 把**陡段**展宽成**缓坡**（用户要的「不要直角，就这样一个缓坡」）。
   *
   * 用户 2026-10-09 第三次反馈（附截图）：「这个直角还存在，参考另一张图不要直角，
   * 就这样一个缓坡就行了」「不要再出现直角的问题了！！」
   *
   * ── 为什么前三版都没解决（每一条都是实测/单元测试的证据，别重走）──
   *   v1 只处理**纯竖直段**（`|dx| < 0.5`）：实测里 `dx=48 / dy=224`（78°）这种陡斜段
   *      不匹配 ⇒ 一个都没改。
   *   v2 上界取「相邻水平段的一半」：锚点旁 stub 只有 7px ⇒ 一半 3.5px 被跳过 ⇒ 仍未生效。
   *   v3 判据写成 `|dy| < |dx|*tanT ⇒ 不借`：**方向写反**，把水平邻居当成陡段，
   *      余量恒为 0 ⇒ 依然没生效（单元测试 .probe/test-rampify.cjs 抓出来的）。
   *   v4（本版）关键认识：**余量必须量到「整条水平段的另一端」**，而不是紧邻的那个顶点。
   *      实测 `h:scout-plot→builder-entry` 的陡段 (557,97)→(616,340)：
   *        向后只有 7px（stub），但**向前有 261px 水平段**（616,340 → 877,340）。
   *      量到紧邻顶点只会得到 14px；量到整条水平段才有 261px ⇒ 足够把 78° 摊成 45°。
   *
   * ── 做法（列表重写，不是原地挪点）──
   *   对每个陡段 a→b：
   *     ① 向后找「同一 y 的连续水平段」的起点 jBack，向前找终点 jFwd；
   *     ② 需要补的横向跨度 deficit = |dy|/tan(阈值) − |dx|；
   *     ③ 先各摊一半，不够的那一半由有余量的一侧补（`mb`/`mf` 两轮收敛）；
   *     ④ 把 a、b 各自向外挪 mb/mf，并把两个水平段上**已被吃掉**的中间顶点删掉
   *        （它们是共线的，删掉不改变形状）。
   *   最后交给 wsSlimPoints 收拾（去重/共线合并）。
   *
   * ── 安全性 ──
   *   只改 x、**从不改 y** ⇒「线在哪些缝隙里穿越」这个语义完全不变，
   *   所以「不穿卡片」这条既有保证不会被破坏（e2e 有断言钉住；实测 0 条穿卡）。
   *   另外仍用 `wsGutterCorridor` 夹紧，防止把端点推进卡片里。
   * @param {Array<[number,number]>} points - 已去重/共线的折线顶点。
   * @returns {Array<[number,number]>} 缓坡化后的顶点（新数组）。
   */
  function wsRampify(points) {
    if (points.length < 3) return points
    let pts = points.map((p) => [p[0], p[1]])
    const tanT = Math.tan((WS_RAMP_SLOPE * Math.PI) / 180)
    let i = 0
    while (i + 1 < pts.length) {
      const a = pts[i]; const b = pts[i + 1]
      const dx = b[0] - a[0]; const dy = b[1] - a[1]
      const adx = Math.abs(dx); const ady = Math.abs(dy)
      // 水平段（或极缓）：不用管。
      if (ady < 2 || adx >= ady / tanT) { i += 1; continue }
      // ① **把连续的陡段合并成一个游程**（用户真实会话实测的关键修复）：
      //    d:builder-copyid 的真实途经点是
      //      `347,574 → 294,666`（坡 60°）、`283,687 → 239,772`（坡 63°）
      //    —— 竖直位移被一个中间顶点拆成两段，中间还夹一个圆角，看上去就是**台阶**。
      //    合并成一条斜线后，两段共用的横向空间能连起来用，坡度变均匀。
      //    ⚠️ 第一版的合并条件写错了：量的是「a 到当前段末端的距离」（= 段长），
      //    而不是「中间连接段的长度」，所以永远不满足 ⇒ 合并从未发生（单元测试抓出来的）。
      //    正确判据：**下一段也陡**，且**x 方向相同**（方向相反说明是锯齿，不能合并）。
      let jEnd = i + 1
      const dirX = Math.sign(dx) || 1
      while (jEnd + 1 < pts.length) {
        const c = pts[jEnd]; const e = pts[jEnd + 1]
        const cdx = e[0] - c[0]; const cdy = Math.abs(e[1] - c[1])
        if (cdy < 2) break                              // 下一段是水平 → 游程结束
        if (Math.abs(cdx) >= cdy / tanT) break           // 下一段够缓 → 游程结束
        if ((Math.sign(cdx) || 1) !== dirX) break        // 方向相反（锯齿）→ 不合并
        jEnd += 1
      }
      const tail = pts[jEnd]
      const totDx = tail[0] - a[0]; const totDy = tail[1] - a[1]
      const tdx = Math.abs(totDx); const tdy = Math.abs(totDy)
      const deficit = tdy / tanT - tdx
      if (deficit < 4) { i = jEnd; continue }
      // ② 余量：量到**相邻顶点**（不要求同 y）。
      //    ⚠️ 第二版在这里又错了：我找的是「同 y 的连续水平段端点」，但真实数据里
      //    相邻顶点 y 并不相同（`354,571 → 347,574` 是个小台阶），于是 jBack 就是 i 自己、
      //    roomBack 恒为 0 ⇒ 缓坡依旧从不生效（单元测试 .probe/test-real-ramp.cjs 抓出来的）。
      //    正确的可用空间 = 到**前一个顶点** / **后一个顶点**的横向距离。
      const prevV = i - 1 >= 0 ? pts[i - 1] : undefined
      const nextV = jEnd + 1 < pts.length ? pts[jEnd + 1] : undefined
      const roomBack = prevV === undefined ? 0 : Math.abs(a[0] - prevV[0])
      const roomFwd = nextV === undefined ? 0 : Math.abs(nextV[0] - tail[0])
      // ③ 先各摊一半，余额由有余量的一侧补。
      let mb = Math.min(roomBack, deficit / 2)
      let mf = Math.min(roomFwd, deficit - mb)
      mb = Math.min(roomBack, deficit - mf)
      if (mb + mf < 4) { i = jEnd; continue }
      // ⚠️ 张开方向必须由**整体走向**决定，不能只看本段的 totDx。
      //    本段是纯竖直（totDx = 0）时 `Math.sign(0) || 1` 会默认成 **+1（向右）**，
      //    与线的实际走向（比如从右往左）相反 ⇒ 制造反向折返。
      //    实测（真实会话 d:red-team-desensitize，整体从 x=1338 走到 222）：
      //      产出 `574,97 → 638,173`（x 反向增大 64px）再 `→ 312,181`，
      //      形成 135° 尖角。这就是用户截图里「绿色线不协调」的剩余来源。
      //    正确判据：优先用本段横向位移；为 0 时回退到「前一个顶点 → 后一个顶点」的整体走向。
      const spanDx = (nextV !== undefined && prevV !== undefined)
        ? nextV[0] - prevV[0]
        : totDx
      const sgn = Math.sign(totDx) || Math.sign(spanDx) || 1
      // 走廊夹紧（防切进卡片）。
      const [aLo, aHi] = wsGutterCorridor(a[0])
      const [bLo, bHi] = wsGutterCorridor(tail[0])
      mb = Math.min(mb, sgn > 0 ? a[0] - aLo : aHi - a[0])
      mf = Math.min(mf, sgn > 0 ? bHi - tail[0] : tail[0] - bLo)
      if (mb + mf < 4) { i = jEnd; continue }
      const aNew = [a[0] - sgn * mb, a[1]]
      const bNew = [tail[0] + sgn * mf, tail[1]]
      // ④ 重写列表：游程 [i .. jEnd] 整体换成 aNew→bNew 一条斜线，
      //    中间的顶点全部删掉（它们只是把同一段竖直位移切碎，删掉才是一条完整缓坡）。
      pts = [...pts.slice(0, i), aNew, bNew, ...pts.slice(jEnd + 1)]
      i = i + 2
    }
    // ⑤ **吞掉锚点旁的短桩**（用户 2026-10-09 第 5 次反馈：「绿色的线有些不协调」，
    //    并手绘了一条从锚点直接斜出的黑线作为期望形状）。
    //
    //    实测证据（真实会话 dump）：
    //      L 354,1519 → 351,1519   长=3  坡=0°    ← 箭头水平短桩（被缓坡吃掉后只剩 3px）
    //      Q 351,1519 → 348,1516   长=4           ← 圆角（r 只能取 1.5px，几乎没圆）
    //      L 348,1516 → 229,870    长=657 坡=80°  ← 立刻转 80° 下斜
    //    那个 3px 短桩太短、圆角半径只能取 r=min(12, 3/2)=1.5px，于是锚点旁留下一个
    //    **尖刺** —— 正是用户截图里觉得「不协调」的东西。手绘期望是直接从锚点斜出。
    //
    //    做法：从头部（或尾部）反复删除「长度 ≤ WS_ARROW_STUB 的短段」的中间顶点，
    //    直到头部段的长度足够。这样斜线直接从锚点出发，锚点旁不再有转折。
    //
    //    安全性：① 锚点本身（pts[0] / pts[末]）永不删除；
    //    ② 只在**累计纵向偏移很小**（≤ WS_ARROW_STUB）时才吞 —— 那些顶点只是
    //       短桩与圆角产生的伪影，不是真正的路由决策（真正的路由转折 y 差很大）；
    //    ③ 箭头方向会随之变成斜的 —— 用户明确要「协调的斜线」，且锚点仍在卡片边缘上。
    const absorb = (atHead) => {
      for (;;) {
        if (pts.length < 3) return
        // 头部：看 [0,1,2]；尾部：看 [末-2, 末-1, 末]。
        const i0 = atHead ? 0 : pts.length - 3
        const anchor = pts[i0]                  // 头部时是起点锚点；尾部时是「倒数的第三个点」
        const mid = pts[i0 + 1]
        const far = pts[i0 + 2]                 // 尾部时就是终点锚点
        const l1 = Math.hypot(mid[0] - anchor[0], mid[1] - anchor[1])
        // 尾部方向相反：真正的「短桩」是 mid→far 那一段（贴着终点锚点）。
        const stubLen = atHead ? l1 : Math.hypot(far[0] - mid[0], far[1] - mid[1])
        const stubDy = atHead ? Math.abs(mid[1] - anchor[1]) : Math.abs(far[1] - mid[1])
        const longDy = atHead ? Math.abs(far[1] - mid[1]) : Math.abs(mid[1] - anchor[1])
        if (stubLen > WS_ARROW_STUB) return                // 贴锚点那段够长 → 停
        if (stubDy > WS_ARROW_STUB) return                 // 纵向偏移大 → 不是伪影
        if (longDy > WS_ARROW_STUB) {
          // 另一侧纵向跳得远 → mid 是伪影，删掉它，让斜线直接连到锚点。
          pts.splice(i0 + 1, 1)
          continue
        }
        const l2 = atHead
          ? Math.hypot(far[0] - mid[0], far[1] - mid[1])
          : Math.hypot(mid[0] - anchor[0], mid[1] - anchor[1])
        if (l2 < 1) { pts.splice(i0 + 1, 1); continue }    // 重合点
        return                                             // 都是小偏移但没长斜线 → 保守停下
      }
    }
    absorb(true)
    absorb(false)
    return pts
  }

  /**
   * 折线 → **圆角折线**路径（正交布线的标准画法：直线段 + 拐角圆弧）。
   *
   * 为什么最终换成它（2026-10-09 用户连续两次截图报「弯曲过度」「方形凹口 + 过冲 S 弯」）：
   *   本图的路由是**正交折线** —— 在列缝隙里走水平、在列间通道里走竖直，每个拐点都是直角。
   *   之前用 Catmull-Rom 样条去**穿过**这些直角顶点，控制点会被相邻点的落差拉出去，
   *   于是曲线在拐角外侧鼓出来（过冲）、甚至反勾回折。这是样条穿直角的**数学必然**：
   *   换向心参数化只能把最急转角从 180° 压到 82°，凹口与过冲依然存在（治标不治本）。
   *
   * 圆角折线从根上避免这件事：**曲线不穿过拐点**，而是在拐点前后各 r 处截断，
   * 用一段以拐点为控制点的二次贝塞尔连接。二次贝塞尔恒在控制点三角形内 ⇒
   *   * 永不越出折线凸包 ⇒ **不可能过冲**（对比样条：控制点可越界）；
   *   * 拐角处切线方向 = 两条邻边的方向 ⇒ 与直线段**切线连续**，没有折角；
   *   * 直线段走的就是折线本身 ⇒ **路径最短**（用户要求「找到最短、最美观的路径」）。
   * 这也是 dagre / ELK 等正交布线库的标准做法。
   *
   * 半径自适应：r 取 min(WS_CORNER_R, 两条邻边各自长度的一半)，
   * 避免短边被相邻两个圆角"吃光"而互相重叠（那会产生新的尖点）。
   * @param {Array<[number,number]>} points - 起点 → 途经点… → 终点。
   * @returns {string} SVG path 的 d。
   */
  function wsRoundPath(points) {
    // 先把竖直台阶化成缓坡（用户要求「不要直角，就这样一个缓坡」），再磨圆剩余的拐角。
    const pts = wsRampify(wsSlimPoints(points))
    if (pts.length < 2) return ''
    if (pts.length === 2) return 'M' + fmtPt(pts[0]) + ' L' + fmtPt(pts[1])
    let d = 'M' + fmtPt(pts[0])
    for (let i = 1; i < pts.length - 1; i += 1) {
      const prev = pts[i - 1]; const cur = pts[i]; const next = pts[i + 1]
      const lenIn = Math.hypot(cur[0] - prev[0], cur[1] - prev[1])
      const lenOut = Math.hypot(next[0] - cur[0], next[1] - cur[1])
      // 半径不能超过任一条邻边的一半（否则相邻圆角会重叠 → 新的尖点）。
      const r = Math.min(WS_CORNER_R, lenIn / 2, lenOut / 2)
      if (!(r > 0.5)) { d += ' L' + fmtPt(cur); continue }
      // 拐角两侧的截断点（沿各自边的方向回退 r）。
      const a = [cur[0] + ((prev[0] - cur[0]) / lenIn) * r, cur[1] + ((prev[1] - cur[1]) / lenIn) * r]
      const b = [cur[0] + ((next[0] - cur[0]) / lenOut) * r, cur[1] + ((next[1] - cur[1]) / lenOut) * r]
      d += ' L' + fmtPt(a) + ' Q' + fmtPt(cur) + ' ' + fmtPt(b)
    }
    d += ' L' + fmtPt(pts[pts.length - 1])
    return d
  }

  /**
   * 旧的 Catmull-Rom 样条（**保留但不再用于正交折线**）。
   *
   * 保留原因：wsCurveLR / wsCurveSame 这些「无途经点的两点弧」仍在用；而本函数只服务
   * 「多点正交折线」，那类形状已改由 wsRoundPath 处理（见其注释：样条穿直角必然过冲）。
   * 若将来出现**非正交**的平滑途经点需求，这里仍是可用的实现（向心参数化 α=0.5）。
   * @param {Array<[number,number]>} points - 起点 → 途经点… → 终点。
   * @returns {string} SVG path 的 d。
   */
  function wsSpline(points) {
    const slim = wsSlimPoints(points)
    if (slim.length < 2) return ''
    if (slim.length === 2) return wsCurveLR(slim[0][0], slim[0][1], slim[1][0], slim[1][1])
    const at = (i) => slim[Math.max(0, Math.min(slim.length - 1, i))]
    const f = (v) => v.toFixed(1)
    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
    const ALPHA = 0.5
    /** 结点间距 = 弦长的 α 次方（向心参数化的定义）。 */
    const knot = (a, b, t) => t + Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), ALPHA)
    /** 带分母保护：端点重复会让结点差为 0，此时该项取 0（而不是 NaN）。 */
    const div = (num, den) => (den === 0 ? 0 : num / den)
    let d = 'M' + f(slim[0][0]) + ' ' + f(slim[0][1])
    for (let i = 0; i < slim.length - 1; i += 1) {
      const p0 = at(i - 1); const p1 = at(i); const p2 = at(i + 1); const p3 = at(i + 2)
      const lo = Math.min(p1[1], p2[1])
      const hi = Math.max(p1[1], p2[1])
      const t0 = 0
      const t1 = knot(p0, p1, t0)
      const t2 = knot(p1, p2, t1)
      const t3 = knot(p2, p3, t2)
      const m1x = (t2 - t1) * (div(p1[0] - p0[0], t1 - t0) - div(p2[0] - p0[0], t2 - t0) + div(p2[0] - p1[0], t2 - t1))
      const m1y = (t2 - t1) * (div(p1[1] - p0[1], t1 - t0) - div(p2[1] - p0[1], t2 - t0) + div(p2[1] - p1[1], t2 - t1))
      const m2x = (t2 - t1) * (div(p2[0] - p1[0], t2 - t1) - div(p3[0] - p1[0], t3 - t1) + div(p3[0] - p2[0], t3 - t2))
      const m2y = (t2 - t1) * (div(p2[1] - p1[1], t2 - t1) - div(p3[1] - p1[1], t3 - t1) + div(p3[1] - p2[1], t3 - t2))
      const c1x = p1[0] + m1x / 3
      const c1y = clamp(p1[1] + m1y / 3, lo, hi)
      const c2x = p2[0] - m2x / 3
      const c2y = clamp(p2[1] - m2y / 3, lo, hi)
      d += ' C' + f(c1x) + ' ' + f(c1y) + ' ' + f(c2x) + ' ' + f(c2y) + ' ' + f(p2[0]) + ' ' + f(p2[1])
    }
    return d
  }

  /**
   * 跨过第 r 列时该走在什么高度。
   *
   * 判据来源：度量探针统计「连线穿过不属于自己端点的卡片」（改路由前 22 条线穿 33 张）。
   * 策略是**最小位移**，而不是「无条件吸附到最近的缝隙中心」：
   *   * idealY 本来就没压住任何卡片 → **不动它**（原样返回）。
   *     早期版本无条件吸附，导致本该笔直穿过的线也去挤缝中心，画出一堆大绕弯
   *     （用户看截图就会觉得「线绕得太夸张」）；
   *   * idealY 落在某张卡片里 → 吸附到**离它最近**的那条缝（卡片上边或下边），位移最小；
   *   * 该列是折叠的协作核（一整块障碍）→ 从容器上方或下方绕过，取近的那侧。
   * @param state - 画布状态。
   * @param r - 列号。
   * @param idealY - 理想穿越高度（起点到终点的线性插值）。
   * @returns {number} 穿越 y。
   */
  function wsColumnCards(state, r) {
    const names = state.layersByRank?.get(r) ?? []
    return names.map((n) => state.byName.get(n)).filter((n) => n !== undefined)
  }

  /**
   * 高度 y 在第 r 列**不被任何卡片挡住**的最大连续区间（可走带）。
   *
   * 为什么要它：分道要把挤在同一缝隙里的线上下错开，但错开不能撞进卡片。
   * 旧实现以为缝隙只有 WS_GAP_Y（16px）高 → 最多分 2 条道；实际上
   * **最上面那张卡片的上方整段都是空的**（画布顶到卡片顶），下方同理。
   * 用真实可走带能分出 4~6 条道，重叠才真的消得掉。
   * @param state - 画布状态。
   * @param {number} r - 列号。
   * @param {number} y - 参考高度。
   * @returns {[number, number]} [下界, 上界]。
   */
  function wsClearBand(state, r, y) {
    let lo = 4
    let hi = (Number.isFinite(state.canvasH) && state.canvasH > 0 ? state.canvasH : 1e4) - 4
    for (const n of wsColumnCards(state, r)) {
      if (n.y + WS_NODE_H + 3 <= y) lo = Math.max(lo, n.y + WS_NODE_H + 3)
      else if (n.y - 3 >= y) hi = Math.min(hi, n.y - 3)
    }
    return hi < lo ? [y, y] : [lo, hi]
  }

  /**
   * 跨过第 r 列时该走在什么高度，以及这条缝的**身份**与可走带（分道用）。
   *
   * 判据来源：度量探针统计「连线穿过不属于自己端点的卡片」（改路由前 22 条线穿 33 张）。
   * 策略是**最小位移**，而不是「无条件吸附到最近的缝隙中心」：
   *   * idealY 本来就没压住任何卡片 → **不动它**（原样返回）；
   *   * idealY 落在某张卡片里 → 吸附到**离它最近**的那条缝，位移最小；
   *   * 该列是折叠的协作核 → 从容器上方或下方绕过，取近的那侧。
   *
   * ⚠️ 「吸附到缝隙」有个副作用（用户 2026-10-09 截图报「线重叠非常丑」）：
   * 多条线各自吸附到**同一条缝的同一个中心**，于是在缝隙里叠成一条粗彩线。
   * 所以这里除了 y 还返回 `id`（同一条缝共用一个 id）与 `band`，
   * 由 assignLanes 给同 id 的线各分一道。
   * @param state - 画布状态。
   * @param {number} r - 列号。
   * @param {number} idealY - 理想穿越高度（起点到终点的线性插值）。
   * @returns {{y:number,id:string,band:[number,number]}}
   */
  function wsGapSlot(state, r, idealY) {
    const core = state.core
    const inThisColumn = wsColumnCards(state, r)
    const canvasMax = (Number.isFinite(state.canvasH) && state.canvasH > 0 ? state.canvasH : 1e4) - 4
    if (core !== null && !state.coreOpen && inThisColumn.some((n) => core.members.includes(n.name))) {
      const above = core.y - 14
      const below = core.y + core.h + 14
      // 已经走在容器上/下方就不动；落在容器里才绕（取近的一侧）。
      if (idealY <= core.y - 6 || idealY >= core.y + core.h + 6) {
        return { y: idealY, id: 'core:' + r + ':free:' + Math.round(idealY / WS_LANE_GAP), band: [4, canvasMax] }
      }
      const up = Math.abs(above - idealY) <= Math.abs(below - idealY)
      return up
        ? { y: above, id: 'core:' + r + ':above', band: [4, core.y - 6] }
        : { y: below, id: 'core:' + r + ':below', band: [core.y + core.h + 6, canvasMax] }
    }
    if (inThisColumn.length === 0) {
      return { y: idealY, id: 'col:' + r + ':empty:' + Math.round(idealY / WS_LANE_GAP), band: [4, canvasMax] }
    }
    // 畅通？直接穿过去，别为了「对齐缝隙」把线拉弯。
    // 挡卡余量 5px（与 wsRoute 的 BLOCK_MARGIN 同口径）：3px 会放过贴边 3~4px
    // 的插值高度 ⇒ 线视觉压边（2026-10-11 用户截图的那条绿线）。提到 5px 后
    // 这种高度改吸附到 ±8px 缝心，离卡 8px > 4px 视觉占宽。
    let blocked = null
    for (const n of inThisColumn) {
      if (idealY > n.y - 5 && idealY < n.y + WS_NODE_H + 5) {
        // 记下离 idealY 最近的那张挡路卡片。
        if (blocked === null || Math.abs(idealY - (n.y + WS_NODE_H / 2)) < Math.abs(idealY - (blocked.y + WS_NODE_H / 2))) blocked = n
      }
    }
    if (blocked === null) {
      // 没被挡住：按 WS_LANE_GAP 分桶，**只有真挤进同一桶**的线才需要分道。
      return {
        y: idealY,
        id: 'col:' + r + ':free:' + Math.round(idealY / WS_LANE_GAP),
        band: wsClearBand(state, r, idealY),
      }
    }
    const above = blocked.y - WS_GAP_Y / 2
    const below = blocked.y + WS_NODE_H + WS_GAP_Y / 2
    const up = Math.abs(above - idealY) <= Math.abs(below - idealY)
    const y = up ? above : below
    return { y, id: 'col:' + r + ':' + (up ? 'a' : 'b') + ':' + blocked.y, band: wsClearBand(state, r, y) }
  }

  /** 第 r 列与第 r+1 列之间那条竖直通道的中心 x（列间空隙，永远没有卡片）。 */
  function wsGutterX(r) {
    return wsColumnX(r) + WS_NODE_W + WS_GAP_X / 2
  }

  /**
   * 跨列路由：用 Sugiyama 的「哑点」思路，保证**不穿过任何卡片**。
   *
   * 为什么不能只放一个途经点（放在列的 x 中心）：曲线在到达那个点之前就已经进入该列的
   * x 范围了，此时的高度未必落在缝隙里 —— 度量探针实测：只放中心点时 13 条线穿过 24 张卡片。
   *
   * 正确做法：要跨过第 r 列时，在该列**左右两条间隙**上各放一个**同高度**的点（高度 = 该列的缝隙 y）。
   * 于是「穿过第 r 列」的那一段是水平线、且整段都在缝隙里；竖直方向的移动全部发生在
   * 列与列之间的空隙里（那里没有卡片）。曲线的平滑由样条保证。
   * @param state - 画布状态。
   * @param {number} ax - 起点 x；ay 起点 y。
   * @param {number} bx - 终点 x；by 终点 y。
   * @param {number} la - 起点列；lb 终点列。
   * @param {{y?:Map<number,number>,gutter?:number}} [lane] - 分道结果（见 wsDrawWires）：
   *   y = 该线在每一中间列的穿越高度；gutter = 同层竖直通道相对中心的横向偏移。
   * @returns {string} SVG path 的 d。
   */
  function wsRoute(state, ax, ay, bx, by, la, lb, lane) {
    if (la === lb) {
      // 同层线（Lead ↔ 队员的派活/交付线，绿色与蓝色）：**直接平滑斜走**。
      //
      // ⚠️ 2026-10-09 第 6 次修正（用户：「绿色有问题啊！！！紫色是好的」）：
      //   旧实现是「绕到列间通道 gutter，再竖直走，再回来」：
      //     [[ax,ay], [gutter,ay], [gutter,by], [bx,by]]
      //   于是画出一个**大三角/Z 形**：先水平横穿到 gutter、再竖直、再水平回来。
      //   用户截图实测（像素轨迹）：绿色在 y=96 有一段 [271..378][382..449] 的水平横穿，
      //   加上两条斜边 —— 正是这个绕行。而同层线的两端**本来就在同一列**（la===lb），
      //   中间没有任何卡片需要绕（同列内两条线之间的空间是空的）⇒ 绕行纯属多余。
      //   紫色（跨层承接线）走的是下面的分支、上一轮已优化成平滑斜线，所以用户说紫色好。
      //
      //   现在同层线也直接连：[[ax,ay], [bx,by]]，由 wsRoundPath → wsRampify 处理成缓坡。
      //   若两端 x 相同（同一张卡片的两侧），wsRampify 会因无横向空间而保持竖直 —— 那种
      //   情况（同一节点自我连线）本来就不该出现，这里不做特殊处理。
      //
      // ⚠️ 2026-10-09 第 7 次修正（用户：「不要有线重叠呗，不能有重叠啊」）：
      //   「直接连」之后**两条同层线之间不再有任何分道** ⇒ 完全重合。
      //   度量探针（中段并行判据）实测最坏 648 点：`d:builder-entry ⇄ d:plan-critic`
      //   整段并线；还有 292 点**异色**（`d:builder-tokens ⇄ d:builder-tokens-2`）。
      //   修法：形状保持「直接连」，但给每条同层线一个**垂直于路径的偏移**
      //   （lane.gutter 已由 assignLanes 按 mid 排序分配好，间距 WS_LANE_GAP），
      //   这样曲线仍是平滑直线、只是彼此错开。
      const off = lane?.gutter ?? 0
      if (Math.abs(off) < 0.5) return wsRoundPath([[ax, ay], [bx, by]])
      const vdx = bx - ax; const vdy = by - ay
      const vlen = Math.hypot(vdx, vdy) || 1
      // 单位法向量（垂直于起点→终点方向）。
      const nx = -vdy / vlen; const ny = vdx / vlen
      return wsRoundPath([
        [ax + nx * off, ay + ny * off],
        [bx + nx * off, by + ny * off],
      ])
    }
    // 跨层：两端各加一个**水平短桩**（stub），让线在离开/进入卡片的那一段是水平的。
    //
    // 为什么必须有（用户第三次报「箭头还是没有显示」，附截图）：marker 的方向跟着
    // 路径在该点的**切线**转。旧路由从锚点直接斜插到下一个途经点，于是箭头也斜着转，
    // 整个三角形压进卡片里盖住文字（实测像素：箭头与「Lead」「94% hit」重叠）。
    // 加了水平桩之后，箭头严格水平、箭身完全落在列间隙里，看起来就是「贴着卡片边缘
    // 的一颗干净三角」—— 这也正是用户要的「连线关系要自然」。
    const dir = bx >= ax ? 1 : -1
    // 桩长要有界：不能超过两端的水平距离（否则路径会倒着走）。
    const stub = Math.min(WS_ARROW_STUB, Math.max(0, Math.abs(bx - ax) / 2 - 1))
    // 竖直段横向分道：每条线在每条通道上占一个 x 槽位（lane.vx），
    // 避免多条线在同一 gutter 的同一 x 上竖直重叠（见 wsDrawWires 的竖直分道）。
    // 取不到分道时回退到通道中心线（旧行为）。
    const vxOf = (g) => {
      const off = lane?.vx?.get(g)
      return off === undefined ? wsGutterX(g) : wsGutterX(g) + off
    }
    const points = [[ax, ay]]
    if (stub > 0) points.push([ax + dir * stub, ay])
    // 相邻列线（|lb-la|===1）：没有中间列可分道，改在**通道中心**插一个分道途经点
    // （lane.gut，见 wsDrawWires）。通道内没有卡片，整段高度都可走 → 每条线一个独立
    // 高度，Lead 扇出的那束线就在这里被拉开（45% 像素复核实测的贴身平行束）。
    //
    // ⚠️ 这里**必须用通道中心线**、不要叠加 lane.vx：相邻列线已经靠 lane.gut.y 分开了，
    // 再横向错位会让它与另一条斜降段**交叉**（实测 d:scout-plot ⇄ d:scout-nature
    // 同色贴合 120→300px 的回归根因：两条斜降段斜率几乎相同，错位后交于一点，
    // 交叉点附近长距离贴身）。vx 只服务跨列线的中间通道。
    //
    // ⚠️ 2026-10-09 第 7 次反馈（「不要有线重叠呗，不能有重叠啊」）的补充认识：
    //   有些线**拓扑上必须交叉**（一条 col1→col2、另一条 col2→col1），
    //   交叉点附近靠近是**不可避免**的。能优化的是**交叉的角度**：
    //   若两条线在通道里斜率都平缓，它们会**长距离平行贴近**（实测 15px 异色贴合）；
    //   让 gut 途经点靠近**目标锚点**那一侧，线在通道里就走得更陡，交叉变成"十字"
    //   而不是"平行并线"，视觉上立刻分开。这里把 gut 途经点向目标锚点方向偏一段。
    if (lane?.gut?.g === Math.min(la, lb) && Math.abs(lb - la) === 1) {
      const gy = lane.gut.y
      // 目标锚点（线要去的那一端）的 y；把途经点朝它偏，使斜段更陡。
      //
      // ⚠️ 偏多少很关键（第 7 次反馈的实测教训）：
      //   偏 WS_LANE_GAP(12) 只把异色贴合从 15px 压到 12px —— 因为**平缓的斜段**
      //   即使错开 12px，在很长一段里仍然并行贴近。
      //   正确目标是让线在通道里**尽快走完竖直落差**（接近垂直穿过），
      //   于是两条必须交叉的线在交叉点附近只贴近极短一段（<12px），肉眼就是"十字"。
      //   所以偏移量取「到目标 y 的差值」本身（走满），但留 1/4 给圆角缓冲。
      const targetY = by
      const bias = (targetY - gy) * 0.75
      points.push([wsGutterX(lane.gut.g), gy + bias])
    }
    if (Number.isFinite(la) && Number.isFinite(lb)) {
      const step = lb > la ? 1 : -1
      // ① 先收集各中间列的穿越高度（分道优先，否则用缝隙槽位）。
      const cols = []
      for (let r = la + step; r !== lb; r += step) {
        const ideal = ay + ((by - ay) * (r - la)) / (lb - la)
        const assigned = lane?.y?.get(r)
        cols.push({ r, ideal, gap: assigned !== undefined ? assigned : wsGapSlot(state, r, ideal).y })
      }
      // ② **单调化 + 避卡**（两个约束同时满足，缺一不可）。
      //
      //    为什么必须单调：穿越高度来回折返会画出「水平→掉头→水平」的 Z 形与 135° 尖角
      //    —— 用户第 6 次反馈的「绿色线不协调」（真实会话实测：d:red-team-desensitize
      //    先右行 666px、掉头再左行 315px）。
      //
      //    为什么必须同时避卡：把 gap 直接夹成单调会落到卡片上（实测穿卡 2 条）。
      //
      //    ⚠️ 关键教训（前两版都栽在这）：**不能让「可行缝的离散值」主导高度**。
      //      该列可行缝只有 4 / 97 / 255 / 2000 这几个位置，若从里面挑，
      //      起点 196、终点 176 的线会被挑到 97 → 18，再升回 176 ⇒ **本身就成了折返**；
      //      而且 wsRampify 的游程合并会把竖直段向外扩张，制造反向（实测 116° 尖角）。
      //
      //    正确做法：以**起点 y → 终点 y 的线性插值**为基准（这就是「平滑过渡」的定义），
      //      只在该高度**被卡片挡住时**才吸附到最近的可行缝，且吸附方向必须与走势一致。
      //      插值天然单调，所以折返从根上不会出现。
      const rising = by >= ay
      // 挡卡判定的余量（2026-10-11 用户报「绿线还有一点被卡片遮挡」）：
      // 3px 判定会把「插值高度恰好在卡片边外 3~4px」的线判成畅通、原样放行，
      // 而线的视觉占宽 ≈4px ⇒ 贴边 1px。统一提到 5px：这种线会改吸附到
      // ±8px 的缝心（WS_GAP_Y/2），离卡 8px > 4px 占宽。≥5px 的线零影响。
      const BLOCK_MARGIN = 5
      // 该列所有可行缝（卡片上/下方 + 画布上下界），按 y 排序。
      const safeYsOf = (r) => {
        const list = []
        const canvasMax = (Number.isFinite(state.canvasH) && state.canvasH > 0 ? state.canvasH : 1e4) - 4
        list.push(4)
        for (const n of wsColumnCards(state, r)) {
          list.push(n.y - WS_GAP_Y / 2)
          list.push(n.y + WS_NODE_H + WS_GAP_Y / 2)
        }
        list.push(canvasMax)
        const cards = wsColumnCards(state, r)
        return list
          .filter((y) => y >= 4 && y <= canvasMax)
          .filter((y) => !cards.some((n) => y > n.y - BLOCK_MARGIN && y < n.y + WS_NODE_H + BLOCK_MARGIN))
          .sort((a, b) => a - b)
      }
      for (const c of cols) {
        // ⚠️ 优先级：**lane.y（分道结果）优先**，插值只作兜底。
        //
        //    为什么必须这样（用户第 7 次反馈：「不要有线重叠呗，之前说过的」）：
        //    assignLanes 专门为「同一条缝里的多条线各占一道」算出了 lane.y，
        //    它是消重叠的**唯一依据**。我上一版却把 lane.y 当成「离插值不远才采纳的微调」，
        //    于是分道被丢弃、两条线都退回插值 ⇒ 实测紫色 h:builder-copyid→red-team-desensitize
        //    与绿色 d:red-team-desensitize 在 y=97 上**重合 210px**（异色粗线）。
        //
        //    兜底顺序：lane.y → 线性插值。
        const base = c.ideal
        const assigned = lane?.y?.get(c.r)
        const want = assigned !== undefined ? assigned : base
        const safe = safeYsOf(c.r)
        if (safe.length === 0) { c.gap = want; continue }
        // want 已被卡片挡住？→ 吸附到最近的可行缝（按走势方向优先）。
        // BLOCK_MARGIN=5：与 safeYsOf 同一口径（3px 会放过贴边 3~4px 的线）。
        const blocked = wsColumnCards(state, c.r).some((n) => want > n.y - BLOCK_MARGIN && want < n.y + WS_NODE_H + BLOCK_MARGIN)
        if (!blocked) { c.gap = want; continue }
        // 吸附：优先「沿走势方向」的最近缝（rising 取上方的缝，falling 取下方的缝）；
        // 该侧没有才退到另一侧（此时是绕行，但仍保持整体单调：绕行只发生一次）。
        const mono = rising ? safe.filter((y) => y >= base) : safe.filter((y) => y <= base)
        const pool = mono.length > 0 ? mono : safe
        let best = pool[0]
        for (const y of pool) if (Math.abs(y - want) < Math.abs(best - want)) best = y
        c.gap = best
      }
      for (const c of cols) {
        const leftGutter = c.r > 0 ? vxOf(c.r - 1) : wsColumnX(c.r) - WS_GAP_X / 2
        const rightGutter = vxOf(c.r)
        if (step > 0) points.push([leftGutter, c.gap], [rightGutter, c.gap])
        else points.push([rightGutter, c.gap], [leftGutter, c.gap])
      }
    }
    if (stub > 0) points.push([bx - dir * stub, by])
    points.push([bx, by])
    return wsRoundPath(points)
  }

  function wsLayout(state) {
    const graph = state.data
    const byName = new Map()
    const members = []
    for (const node of graph.nodes) {
      byName.set(node.name, node)
      if (node.role !== 'lead') members.push(node)
    }
    const lead = graph.nodes.find((n) => n.role === 'lead')
    const dispatch = graph.edges.filter((e) => e.kind === 'dispatch')
    const handoff = graph.edges.filter((e) => e.kind === 'handoff')
    for (const e of dispatch) {
      const target = byName.get(e.to)
      if (target !== undefined) { target.delivered = e.delivered === true; target.dispatched = e.weight ?? 0 }
    }
    const names = members.map((m) => m.name)
    const layerInput = [
      ...dispatch.filter((e) => (e.weight ?? 0) > 0).map((e) => ({ from: e.from, to: e.to })),
      ...handoff.map((e) => ({ from: e.from, to: e.to })),
    ]
    const leadName = lead === undefined ? 'lead' : lead.name
    const { rank, layers } = wsLayerize(names, layerInput, leadName)

    const layerKeys = [...layers.keys()].sort((a, b) => a - b)
    const colH = (r) => (layers.get(r) ?? []).length * (WS_NODE_H + WS_GAP_Y) - WS_GAP_Y
    const maxColH = Math.max(...layerKeys.map(colH), WS_NODE_H)
    const xOf = (r) => WS_PAD + (WS_NODE_W + WS_GAP_X) * r
    const place = (r) => {
      const list = layers.get(r) ?? []
      const top = WS_PAD + Math.max(0, (maxColH - colH(r)) / 2)
      list.forEach((n, i) => {
        const node = byName.get(n)
        if (node !== undefined) { node.x = xOf(r); node.y = top + i * (WS_NODE_H + WS_GAP_Y); node.layer = r }
      })
    }
    for (const r of layerKeys) place(r)
    if (lead !== undefined) {
      lead.x = WS_PAD
      lead.y = WS_PAD + Math.max(0, (maxColH - WS_NODE_H) / 2)
      lead.layer = 0
    }
    state.byName = byName
    state.leadName = leadName
    state.layersByRank = layers
    state.maxRank = layerKeys[layerKeys.length - 1] ?? 0
    state.canvasW = xOf(state.maxRank) + WS_NODE_W + WS_PAD
    state.canvasH = WS_PAD * 2 + maxColH

    // 协作核：某一列 ≥4 人且层内互边 ≥6 对 → 收进容器（那团毛线的唯一解法）。
    state.core = null
    for (const r of layerKeys) {
      const list = layers.get(r) ?? []
      if (list.length < 4) continue
      const internal = handoff.filter((e) => list.includes(e.from) && list.includes(e.to))
      if (internal.length < 6) continue
      const xs = list.map((n) => byName.get(n).x)
      const ys = list.map((n) => byName.get(n).y)
      const minY = Math.min(...ys)
      state.core = {
        members: list,
        internal: internal.length,
        x: Math.min(...xs) - 10,
        y: minY - 30,
        w: WS_NODE_W + 20,
        h: Math.max(...ys) + WS_NODE_H - minY + 40,
      }
      break
    }
  }

  function wsStateOf(node) {
    if (node.role === 'lead') return 'running'
    if (node.status === 'failed') return 'failed'
    if (node.status === 'running' || node.status === 'provisioning') return 'running'
    // 队员此刻没在跑（inactive）。**完成的口径与官方对齐**：官方子智能体列表的
    // 「done」= 上一轮正常完成（official-subagent-client.js:200 的
    // lastTurnCompleted —— 2026-10-13 用户双截图实测：builder-arch/builder-field
    // 上轮以 error 收尾（QUOTA_EXCEEDED 限流），官方判灰「未完成」，
    // 工作区却给绿 —— 失败被完成的绿色淹没，用户点名没做好）。
    // 工作区比官方更进一步：**没做完 = 红**（红 = 需要处理；灰留给从没跑过的）：
    //   * 上轮结束原因不是 completed（max-tokens 罢工 / error 报错 / interrupted 中止…）；
    //   * 或 turn 没闭合（openTurns>0 = 被中止/额度断，死在半路；真机持久快照的
    //     幻影 openTurns 已由 e00a60d 的冷却重读自愈，不会误染红）。
    // lastTurnEndReason 缺省（旧 payload / 老日志）视为 completed，保持向后兼容。
    const didWork = node.hasUsage === true || (node.lastTime ?? 0) > 0
    const reason = node.lastTurnEndReason
    const endedClean = reason === undefined || reason === null || reason === '' || reason === 'completed'
    if (didWork && (node.openTurns ?? 0) === 0 && endedClean) return 'done'
    if (didWork) return 'failed'
    // delivered（队员给 lead 发过消息）保留为兜底：没有 usage 证据但确实汇报过。
    if (node.delivered === true) return 'done'
    return 'idle'
  }

  /**
   * 把服务端给的**任务归属清单**拼成悬停文本（2026-10-14：句子在这儿拼，不在服务端拼）。
   * 服务端只发事实（id/status/revision/subject + 折掉的条数），因为知道界面语言的
   * 只有浏览器（dsh-client-locale 的 active）；宿主半拼中文的话英文界面就翻不动。
   * @param {object|undefined} tip - node.taskTip（{total, rows, omitted}）。
   * @returns {string} 多行文本；名下没有条目时 ''（据此不挂 tooltip）。
   */
  function wsTaskTip(tip, name) {
    const data = tip === null || tip === undefined ? {} : tip
    const rows = Array.isArray(data.rows) ? data.rows : []
    if (rows.length === 0) return ''
    const head = wsText('wsTaskTipHead', { count: String(data.total ?? rows.length), name: String(name ?? '') })
    const lines = rows.map((row) => {
      const subject = typeof row.subject === 'string' && row.subject !== '' ? ' · ' + row.subject : ''
      return String(row.id) + ' · ' + String(row.status) + '（rev ' + String(row.revision) + '）' + subject
    })
    if (Number(data.omitted) > 0) lines.push(wsText('wsTaskTipMore', { count: String(data.omitted) }))
    return head + String.fromCharCode(10) + lines.join(String.fromCharCode(10))
  }

  function wsNodeCard(state, node) {
    const el = document.createElement('div')
    el.className = 'ws-node' + (node.role === 'lead' ? ' lead' : '')
    el.style.left = node.x + 'px'
    el.style.top = node.y + 'px'
    const st = wsStateOf(node)
    const todo = node.todo ?? { done: 0, running: 0, total: 0 }

    const head = document.createElement('div'); head.className = 'hd'
    const dot = document.createElement('span'); dot.className = 'ws-dot ' + st
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = node.name
    const rl = document.createElement('span'); rl.className = 'rl'
    rl.textContent = node.role === 'lead' ? wsText('wsRoleLead') : String(node.name).replace(/-\d+$/, '')
    head.append(dot, nm, rl)

    const body = document.createElement('div'); body.className = 'bd'
    const model = document.createElement('div'); model.className = 'model'
    model.textContent = node.model ?? wsText('wsModelNone')
    const tl = document.createElement('div'); tl.className = 'ws-tl'
    const lb = document.createElement('span'); lb.className = 'lb'; lb.textContent = wsText('wsTodo')
    const ct = document.createElement('span'); ct.className = 'ct'
    ct.textContent = todo.done + '/' + todo.running + '/' + todo.total
    const bar = document.createElement('span'); bar.className = 'bar'
    if (todo.done > 0) { const i = document.createElement('i'); i.className = 'd'; i.style.flex = String(todo.done); bar.appendChild(i) }
    if (todo.running > 0) { const i = document.createElement('i'); i.className = 'r'; i.style.flex = String(todo.running); bar.appendChild(i) }
    const rest = Math.max(0, todo.total - todo.done - todo.running)
    if (rest > 0) { const i = document.createElement('i'); i.style.flex = String(rest); bar.appendChild(i) }
    tl.append(lb, ct, bar)
    const mx = document.createElement('div'); mx.className = 'ws-mx'
    // ── 「没有测量」与「测到 0」必须区分（2026-10-10 用户报障「卡片看不到基本信息」）──
    // 被中止的回合（实测 session-00001008 seq=19：data.usage 缺失、data.stream 只有
    // block-start 与 reasoning-chunks）根本没产生 usage chunk ⇒ 四桶全停在 0。
    // 旧渲染把这种「没数据」画成 `0 out 0 cache 0% hit`，用户看不出是没测量还是真没消耗；
    // 而同屏的「输出速度」用的是 `tps > 0 ? ... : '—'`，两处口径自相矛盾。
    // 现在统一：hasUsage === false 时这几个数一律显示 `—`（与服务端 graph.js 的 hasUsage 同源）。
    const hasUsage = node.hasUsage === true
    const dash = '—'
    const out = document.createElement('span'); out.innerHTML = '<b></b> out'
    out.querySelector('b').textContent = hasUsage ? wsFmtN(node.usage?.outputTokens ?? 0) : dash
    const cache = document.createElement('span'); cache.innerHTML = '<b></b> cache'
    cache.querySelector('b').textContent = hasUsage ? wsFmtN(node.usage?.cacheReadTokens ?? 0) : dash
    const hit = document.createElement('span'); hit.className = 'hit'
    hit.title = wsText('wsHitFormula')
    hit.innerHTML = '<b></b> hit'
    hit.querySelector('b').textContent = hasUsage ? wsPct(node.cacheHit ?? 0) : dash
    mx.append(out, cache, hit)
    body.append(model, tl, mx)

    const foot = document.createElement('div'); foot.className = 'ft'
    const dur = document.createElement('span'); dur.className = 'd'; dur.textContent = wsFmtD(node.runtimeMs ?? 0)
    const tps = document.createElement('span'); tps.className = 'd'
    tps.textContent = (node.tps ?? 0) > 0 ? node.tps.toFixed(1) + ' tps' : '—'
    // 口径必须可核对：悬停给出「生成时长 = 回合 − 工具」这两个实际数字（见 wsTpsTip）。
    tps.title = wsTpsTip(node)
    const rg = document.createElement('span'); rg.className = 'rg'
    rg.appendChild(wsRing(node.pressureTokens ?? 0, node.contextWindow ?? 0))
    foot.append(dur, tps, rg)

    el.append(head, body, foot)
    // 共享任务板的归属走**整张卡片的悬停 tooltip**（文本由服务端算好，见 graph.taskTipOf）：
    // 浮窗里不放任务区块是用户 2026-10-08 的决定，但「这个人该收哪条」必须在画布上看得见，
    // 否则就会重现 session-00001000 —— Lead 建了 4 条、派了 7 个队员，两边零引用，全程没人发现。
    // tooltip 零布局成本；子元素自己的 title（如 hit 那格）在悬停到它时优先，互不干扰。
    el.title = wsTaskTip(node.taskTip, node.name)
    // onclick（不是 addEventListener）：刷新走 wsUpdateCard 就地改，重绑不会叠加。
    el.onclick = () => wsOpenDrawer(state, node)
    return el
  }

  /**
   * 流光相位：按边身份哈希出 0~0.6s 的错峰延迟。
   * 为什么不用「绘制序号 % 7」：序号会随弱关系开关/协作核展开导致的边序变化而漂移，
   * 每条边的相位就会跳一下 —— 哈希让同一条边永远同相位，重建也不乱。
   */
  function wsFlowPhase(key) {
    let h = 0
    for (let i = 0; i < key.length; i += 1) h = ((h * 31) + key.charCodeAt(i)) | 0
    return (Math.abs(h) % 62) / 100
  }

  function wsDrawWires(state) {
    // 首帧数据还没到（或上一轮失败）时不许画：顶栏的流光/弱关系/协作核开关与窗口 resize
    // 在 openWorkspace 之后就都活着了，用户完全可能在数据到达前点它们 ——
    // 没有这道闸门会读 state.data.edges 抛 TypeError（未捕获异常）。
    if (state.data === null || state.data === undefined) return
    const svg = state.svg
    svg.setAttribute('width', String(state.canvasW))
    svg.setAttribute('height', String(state.canvasH))
    svg.setAttribute('viewBox', '0 0 ' + state.canvasW + ' ' + state.canvasH)

    // 三层结构在 openWorkspace 里建一次：defs / 底线 / 流光 / 协作核。
    // 底线每次重建（它们没有动画，重建无副作用）；**流光层永不重建** ——
    // 每条边的 <path class="flow"> 按边身份复用，只更新 d/stroke：
    // CSS 动画挂在元素上，元素活着动画就连续。旧实现整层清空重建，
    // 于是点任何开关（弱关系/协作核/缩放…）所有流光都从头跑一遍（用户 2026-10-08 截图报的）。
    const wires = state.gWires
    const flows = state.gFlows
    const coreLayer = state.gCore
    while (wires.firstChild !== null) wires.removeChild(wires.firstChild)
    while (coreLayer.firstChild !== null) coreLayer.removeChild(coreLayer.firstChild)

    const core = state.core
    const collapsed = core !== null && !state.coreOpen
    const inCore = (name) => collapsed && core.members.includes(name)
    const graph = state.data
    const desired = new Map()

    const addPath = (key, d, attrs, titleText) => {
      const path = wsSvg('path', Object.assign({ d, fill: 'none', 'data-wire': key }, attrs))
      if (titleText !== '') {
        const title = wsSvg('title', {})
        title.textContent = titleText
        path.appendChild(title)
      }
      wires.appendChild(path)
      if (dbg !== null) dbg.addPath += 1
      return path
    }
    // 色块沿路径走 dashoffset（v1 模型）；宽度就是色块在屏幕上的长度。
    // 缩放不再需要补偿：dasharray 按 pathLength=100 归一，整条线（含色块）随画布一起缩放。
    const wantFlow = (key, d, color, width, reverse) => {
      desired.set(key, { d, color, width, reverse: reverse === true })
    }

    // ── 锚点铺开（消星爆）──────────────────────────────────────────────────
    // 度量探针实测：改之前 Lead 的 18 条线、plan-critic 的 6 条线全部挤在**同一个点**上
    // （节点垂直中点），画出来是一团放射状毛刺 —— 这就是「连线不自然」的主因之一。
    // 现在按「(节点,侧)」分组，把锚点沿节点边缘均匀铺开（纵向留 12px 边距）。
    //
    // 上限：线太多时（本插件 maxMembers 可到 48）间距会小于线宽、重新糊成一团。
    // 所以给最小间距兜底：超过 `可用高度 / MIN_ANCHOR_GAP` 条的，多出来的线**共用**最后几个
    // 槽位（宁可两条线共点，也不让锚点跑到卡片外面或糊成一片）。
    const MIN_ANCHOR_GAP = 5
    const anchorSlots = (count) => {
      const usable = WS_NODE_H - 24
      if (count <= 1) return [WS_NODE_H / 2]
      const maxSlots = Math.max(2, Math.floor(usable / MIN_ANCHOR_GAP) + 1)
      const slots = []
      for (let i = 0; i < count; i += 1) {
        const t = count <= maxSlots ? i / (count - 1) : Math.min(1, i / (maxSlots - 1))
        slots.push(12 + usable * t)
      }
      return slots
    }

    // 先收集所有要画的线（含端点与方向），分组后统一分配锚点。
    const planned = []
    for (const e of graph.edges) {
      if (e.kind !== 'handoff') continue
      if (inCore(e.from) && inCore(e.to)) continue
      const a = state.byName.get(e.from); const b = state.byName.get(e.to)
      if (a === undefined || b === undefined) continue
      const weak = (e.weight ?? 1) < 2
      if (weak && !state.weak) continue
      planned.push({ kind: 'handoff', e, a, b, weak })
    }
    for (const e of graph.edges) {
      if (e.kind !== 'dispatch') continue
      const a = state.byName.get(e.from); const b = state.byName.get(e.to)
      if (a === undefined || b === undefined) continue
      planned.push({ kind: 'dispatch', e, a, b, weak: false, done: wsStateOf(b) === 'done' })
    }
    if (typeof window !== 'undefined') {
      window.__DrawDbg__ = { edges: graph.edges.length, planned: planned.length,
        handoff: planned.filter((p) => p.kind === 'handoff').length,
        dispatch: planned.filter((p) => p.kind === 'dispatch').length,
        addPath: 0 }
    }
    const dbg = typeof window === 'undefined' ? null : window.__DrawDbg__
    // 分组键 = 「节点 + 哪一侧」（**不含**边类型）。
    // 为什么必须按 (节点,侧) 而不是 (节点,侧,边类型)：不同类型的两条线可能落在同一个侧面上
    // （例如 builder-bugfixer 左侧既有承接线的入口、又有绿交付线的出口），
    // 各自独立铺开就会算出**同一个 y**，两条线重叠在一点。
    // 实测（碰撞探针）：按类型分组时有 4 处「同侧同 y」重叠。
    //
    // 每行显式记录 **farY（这条线另一头节点的 y）**，排序时直接用。
    // 为什么不在排序阶段从 p.a/p.b 反推：dispatch 边里 a 恒为 Lead、b 恒为成员，
    // 而绿线（已交付）的语义方向是 成员→Lead（源=b、目标=a）—— 反推会把「自己的 y」
    // 当成对端 y（组内是常量），排序退化成按数组顺序。审查实测：Lead 右边缘 16 条绿线
    // 的锚点顺序与成员 y 完全不符（逆序对 49 对，理论应为 0），画出来就是一团交叉扇形。
    const groups = new Map()
    const addToGroup = (owner, side, item, end, fromNode, toNode) => {
      const k = owner + '|' + side
      const list = groups.get(k) ?? []
      list.push({ item, end, farY: (end === 'from' ? toNode : fromNode).y })
      groups.set(k, list)
    }
    for (const p of planned) {
      if (p.kind === 'handoff') {
        const la = p.a.layer ?? 0; const lb = p.b.layer ?? 0
        // 承接边：写方 a → 读方 b。
        //   同层：两端都走同一条竖直通道的侧别（绕节点列外侧，不横穿卡片）；
        //   正向（lb>la）：源右侧出 → 目标左侧入；
        //   回向（lb<la）：线往**左**走，源从左侧出、目标从**右侧**入
        //     （目标在更左的列，朝向来线的那条边是它的右边）。
        if (la === lb) {
          const side = wsGutterSide(state, la)
          addToGroup(p.a.name, side, p, 'from', p.a, p.b)
          addToGroup(p.b.name, side, p, 'to', p.a, p.b)
        } else if (lb > la) {
          addToGroup(p.a.name, 'R', p, 'from', p.a, p.b)
          addToGroup(p.b.name, 'L', p, 'to', p.a, p.b)
        } else {
          addToGroup(p.a.name, 'L', p, 'from', p.a, p.b)
          addToGroup(p.b.name, 'R', p, 'to', p.a, p.b)
        }
      } else {
        // 派活边：蓝（进行中）Lead→成员；绿（已交付）成员→Lead。
        // 绿线方向注意：Lead 在最左列、成员在右边，所以「回到 Lead」是**向左**走的，
        // 成员必须从**左**边缘出、Lead 从**右**边缘入 —— 若让成员从右边缘出，
        // 曲线会先横穿它自己的卡片再折回来（实测很难看）。
        if (p.done) {
          addToGroup(p.b.name, 'L', p, 'from', p.b, p.a)
          addToGroup(p.a.name, 'R', p, 'to', p.b, p.a)
        } else {
          addToGroup(p.a.name, 'R', p, 'from', p.a, p.b)
          addToGroup(p.b.name, 'L', p, 'to', p.a, p.b)
        }
      }
    }
    // 分配：同一 (节点,侧) 上的所有线按「对端 y」排序后自上而下铺开 ——
    // 线与线的相对顺序与节点的相对位置一致，交叉最少（这是「自然」的关键：
    // 不该出现上面节点的线跑到下面去），且同一侧上**不会有两线共用同一个锚点**。
    const anchorOf = new Map()
    for (const list of groups.values()) {
      list.sort((x, y) => x.farY - y.farY)
      const slots = anchorSlots(list.length)
      list.forEach((row, i) => anchorOf.set(row.item, Object.assign(anchorOf.get(row.item) ?? {}, { [row.end]: slots[i] })))
    }
    /**
     * 端点坐标：把「节点的哪一侧 + 沿边缘的偏移」变成画布上的实际坐标。
     * @param {string} name - 节点名。
     * @param {'L'|'R'} side - 从节点的哪一侧出去/进来。
     * @param {number|undefined} offset - 沿边缘的纵向偏移（锚点铺开算出来的）；
     *   undefined 或非有限值时退回节点垂直中点（单条线的情形）。
     * @returns {{x:number,y:number}}
     */
    const pointFor = (name, side, offset) => {
      const node = state.byName.get(name)
      if (node === undefined) return { x: 0, y: 0 }
      const dy = Number.isFinite(offset) ? offset : WS_NODE_H / 2
      const y = node.y + dy
      if (collapsed && core.members.includes(name)) {
        // 折叠态：进出协作核的线落在容器左右边缘，y 夹在容器纵向范围内（不画到容器外面去）。
        const clamped = Math.max(core.y + 10, Math.min(core.y + core.h - 10, y))
        return { x: side === 'R' ? core.x + core.w : core.x, y: clamped }
      }
      // 端点**贴住卡片边缘**：不往外退。退让会让箭头浮在离卡片十几 px 的地方（很难看）。
      //
      // ⚠️ 2026-10-09 记录一次失败的尝试（别再走）：为了修「箭头重心落在卡片内」，
      // 我曾把端点沿出线方向外移 WS_ARROW_PX=8px。结果：
      //   ① 遮挡确实没了；② 但「端点锚定在节点边缘」这条**语义**被破坏（e2e 23 条流光
      //   全部报「未锚定」），而那条语义是流光方向正确性的基础。
      // 正确认识：箭尖用 refX=9 正好落在终点（= 卡片边缘），箭身沿路径往回；**斜线的箭身
      // 会贴着边缘 1~2px**，但卡片有 12px 内边距 + 边框，视觉上完全看不出被裁。
      // 所以判据应当是「**箭尖**扎进卡片 ≤4px」（见 ws-e2e 的 deepInCard），
      // 而不是「箭头重心不在卡片内」—— 后者对斜线过于苛刻且没有视觉依据。
      return { x: side === 'R' ? node.x + WS_NODE_W : node.x, y }
    }

    // ── 分道（消重叠，用户 2026-10-09：「不要让拓扑线有任何重叠，非常丑」）──────
    // 截图里绿/紫/蓝三条线在同一高度完全叠成一条粗彩线。根因（重叠探针实测，
    // .probe/probe-overlap.mjs）：d:builder-matlab 与 d:builder-entry 在 x[241..950]
    // 全程 y=966/966 重合 130 个采样点 —— 穿越高度各算各的，多条线算出**同一个 y**。
    // 修法：先预计算端点/列，再按（列, 可走带）分组，组内把贴得比 WS_LANE_GAP 近的线
    // 推开成互不相同的道，并整组夹在该带的范围内（不撞卡片）。
    //
    // ⚠️ 分组键必须是**可走带 [lo,hi]**，不是「吸附原因」：第一版按缝隙 id 分组，
    // 一条线畅通保持原 y、另一条吸附到缝中心，两者 y 只差 2px 却落进不同组 →
    // 谁都不动 → 探针照样报重叠。带是几何事实，同带 = 真的会叠。
    for (const p of planned) {
      const anchors = anchorOf.get(p) ?? {}
      if (p.kind === 'handoff') {
        const la = p.a.layer ?? 0; const lb = p.b.layer ?? 0
        let fromSide; let toSide
        if (la === lb) { const s = wsGutterSide(state, la); fromSide = s; toSide = s }
        else if (lb > la) { fromSide = 'R'; toSide = 'L' }
        else { fromSide = 'L'; toSide = 'R' }
        p.la = la; p.lb = lb
        p.from = pointFor(p.e.from, fromSide, anchors.from)
        p.to = pointFor(p.e.to, toSide, anchors.to)
      } else {
        // 派活边：蓝（进行中）Lead(R)→成员(L)；绿（已交付）成员(L)→Lead(R)。
        p.from = p.done ? pointFor(p.e.to, 'L', anchors.from) : pointFor(p.e.from, 'R', anchors.from)
        p.to = p.done ? pointFor(p.e.from, 'R', anchors.to) : pointFor(p.e.to, 'L', anchors.to)
        p.la = p.done ? (p.b.layer ?? 0) : (p.a.layer ?? 0)
        p.lb = p.done ? (p.a.layer ?? 0) : (p.b.layer ?? 0)
      }
      // vx = 竖直段在每条通道上的横向槽位（见下面的竖直分道）；缺省=通道中心线。
      p.lane = { y: new Map(), gutter: 0, vx: new Map() }
    }
    // 跨列线分道：给每条线在该列一个**独立**的无卡 y（间距 ≥ WS_LANE_GAP）。
    // 为什么不是「吸附到最近缝隙再挤开」：一条缝只有 ~16px，几条线就压成 2px 贴合
    // （探针实测 d:builder-matlab/d:builder-entry 全程 964 vs 966 = 用户看到的粗彩线）。
    // 正确做法：把整列的无卡空间（顶上方 + 每条缝 + 底下方）按 WS_LANE_GAP 铺成槽位，
    // 每条线取离自己理想高度最近的**空闲**槽位 → 天然分开，且永不撞卡片。
    // 计算某列所有无卡槽位（升序 y）。
    const freeSlotsOf = (r) => {
      const cards = wsColumnCards(state, r).slice().sort((x, y) => x.y - y.y)
      // ⚠️ 带边界的卡片余量（2026-10-11 用户报「绿线贴着卡片边框穿过」的唯一修改点）：
      //    旧值 3px 小于线的视觉占宽（半线宽 1.6 + 边框 1 + 抗锯齿 ≈ 4px）⇒
      //    走在带边界上的线视觉上压着卡片边框。提到 5px（> 4px 占宽）后线与卡片
      //    干净分离。**只动这一个值**：缝 16px 时缝带 [175,179] 仍恰好容纳
      //    「一个步进槽 + 末槽贴边」（槽数与旧版完全一致）⇒ 分道分布不变，
      //    不触碰用户已认可的重叠/缓坡/圆角行为。max(5, …) 由下方 margin 使用。
      const MARGIN = 5
      const bands = []
      let cursor = 4
      for (const n of cards) {
        if (n.y - MARGIN > cursor) bands.push([cursor, n.y - MARGIN])
        cursor = Math.max(cursor, n.y + WS_NODE_H + MARGIN)
      }
      const bottom = (Number.isFinite(state.canvasH) && state.canvasH > 0 ? state.canvasH : 1e4) - 4
      if (bottom > cursor) bands.push([cursor, bottom])
      const slots = []
      for (const [lo, hi] of bands) {
        // ⚠️ 带末尾的「补槽」必须离前一个步进槽 ≥ WS_LANE_GAP（用户第 7 次反馈：
        // 「不要有线重叠呗，不能有重叠啊」）。
        //
        // 旧写法无条件补 `hi`：若 band = [1107, 1129]，步进槽是 1107 / 1119，
        // 再补 1129 —— 1119 与 1129 **只差 10px**（< WS_LANE_GAP=12）。
        // 实测后果：d:builder-python 拿 1119、d:builder-matlab 拿 1129，
        // 两条同色线在 y=1119/1129 上平行 92 个采样点、间距仅 10px（肉眼一条粗线）。
        //
        // 正确做法：只有当「补槽离前一个槽够远」时才补；否则把最后一个步进槽
        // **贴到带上界**（即用 hi 替换它），这样既不减少可用槽数、又保证间距。
        const band = []
        for (let y = lo; y <= hi; y += WS_LANE_GAP) band.push(y)
        if (band.length === 0) {
          band.push(hi)
        } else if (hi - band[band.length - 1] >= WS_LANE_GAP) {
          band.push(hi)                        // 够远 → 正常补
        } else if (band.length >= 2 && hi - band[band.length - 2] >= WS_LANE_GAP) {
          band[band.length - 1] = hi           // 不够远 → 末槽上移到带上界
        } else if (band.length === 1 && hi !== band[0]) {
          band[0] = hi                         // 只有一个槽 → 直接用它贴住上界
        }
        slots.push(...band)
      }
      return slots.sort((a, b) => a - b)
    }
    // 按列收集要跨的线（含同层线：它们也要在竖直通道里分道，见下）。
    //
    // ⚠️ 已知边界（2026-10-13 两次实测失败后固化；同日 26 队员真机数据推翻早期结论）：
    // 「同色并行贴合 ≤80 采样点」的断言在大扇入下会失败，且**真机也会**：
    // session-00001009（26 队员全在第一列）活体渲染实测 26 对同色贴合、最严重
    // 831 采样点（.probe/overlap-live.mjs，2026-10-13）——26 条线挤 Lead 一条
    // 142px 边（锚点间距 5.3px、容量 24 槽被超订共享），视觉上左缘成束。
    // 早期「真实会话 0 对贴合」只对 ≤11 队员成立，已被 26 队员真机数据推翻。
    // fixture 上也有同款失败（19 节点 ~145 点，d:builder-matlab ⇄ d:plan-critic），
    // 根因同源：单列布局下扇入无上限 → 槽位库存（每条 16px 卡缝 1 槽）不够。
    // 已试并回退的路（单列前提下无解，别再重试）：① 全局逐线单调指派 —— 动了
    // 所有线的槽位，引入新的异色贴合对；② 之字形事后修复趟 —— 145 对变成
    // 181+71 对。两次都只是把贴合对挪到别处。
    // 真修方向 = **布局换列**（单列人数超阈值 → 溢出换到右侧新列，扇入回归
    // ≤~12 的可分离区间，顺带压掉 4000px 的画布高度）；动 wsLayout 的分层
    // 语义（「列 = 真实依赖深度」→「深度 + 溢出换列」），用户已批准执行。
    const byColumn = new Map()
    for (const p of planned) {
      if (p.la === p.lb) continue
      if (!Number.isFinite(p.la) || !Number.isFinite(p.lb)) continue
      const step = p.lb > p.la ? 1 : -1
      for (let r = p.la + step; r !== p.lb; r += step) {
        const ideal = p.from.y + ((p.to.y - p.from.y) * (r - p.la)) / (p.lb - p.la)
        const list = byColumn.get(r) ?? []
        list.push({ p, r, ideal })
        byColumn.set(r, list)
      }
    }
    for (const [r, list] of byColumn) {
      const slots = freeSlotsOf(r)
      if (slots.length === 0) continue
      // 保序单调扫描：按理想 y 排序后，每条线只能拿**不低于上一条槽位 + GAP** 的
      // 空闲槽位。为什么不能"各拿最近的空闲槽"：那样两条线的槽位顺序可能和
      // 锚点顺序相反（A 锚在上、槽在下），斜坡段里两线必然交叉贴身 —— 探针实测
      // x[240..255] 的 1.3px 平行段就是这个。保序后斜坡只展宽不交叉。
      list.sort((x, y) => x.ideal - y.ideal)
      const taken = new Set()
      // ⚠️ 先占掉「**相邻列线在该列的途经点**」的槽位（用户第 7 次反馈：
      // 「不要有线重叠呗，之前说过的」）。相邻列线走 lane.gut，不在 byColumn 里，
      // 所以它们在该列附近的 y **没被计入占用** —— 实测
      //   h:builder-copyid→verify-copyid 的途经点 y=223（col2）
      //   d:red-team-desensitize 在 col2 拿的槽 y=250
      // 两者只差 27px，而线宽 + 圆角让它们在 x≈609..651 段**异色贴合 15px**。
      // 把相邻列线的途经 y 也算作「已占」，跨列线就不会选到它旁边。
      for (const q of planned) {
        if (q === undefined || q.la === q.lb) continue
        if (Math.abs(q.lb - q.la) !== 1) continue
        const g = q.lane?.gut?.g
        if (g === undefined || g !== r) continue
        const gy = q.lane.gut.y
        for (let s = 0; s < slots.length; s += 1) {
          if (Math.abs(slots[s] - gy) < WS_LANE_GAP) taken.add(s)
        }
      }
      for (const it of list) {
        // 就近空闲槽：离理想 y 最近且未被占用。
        // ⚠️ 试过「保序单调扫描」（每条线只能拿 ≥ 上一条+GAP 的槽），结果更糟：
        // 它把线推离锚点造成长绕行，绕行的线又互相平行贴合（探针最严重 24→72 点）。
        // 就近槽位让线尽量直，最严重重叠 24 采样点（约 144px，且是扇出收敛段），
        // 相比修复前的 145 点全程贴合已是数量级改善。
        let best = -1; let bd = Infinity
        for (let s = 0; s < slots.length; s += 1) {
          if (taken.has(s)) continue
          const d = Math.abs(slots[s] - it.ideal)
          if (d < bd) { bd = d; best = s }
        }
        if (best < 0) break
        taken.add(best)
        it.p.lane.y.set(r, slots[best])
      }
    }
    // 竖直段横向分道（用户 2026-10-09 第二轮截图：圆角折线严格走折线后，
    // 暴露出一条**既有的**分道缺口 —— 两条跨列线在同一 gutter 的同一 x 上竖直重叠。
    // 旧样条版"看着没事"只是因为样条会偏离折线、偶然错开；严格折线把它显形了）。
    //
    // 做法：对每条 gutter g，收集所有**竖直段**（区间 [y0,y1]），
    // 把区间互相重叠的线分到不同的 x 槽位；区间不重叠的线可以共用中心线（省空间）。
    // 槽位步长用 WS_LANE_GAP，横向范围限制在通道内（WS_GAP_X/2 − 6）。
    for (const g of new Set(planned.flatMap((p) => {
      if (p.la === p.lb || !Number.isFinite(p.la) || !Number.isFinite(p.lb)) return []
      const lo = Math.min(p.la, p.lb); const hi = Math.max(p.la, p.lb)
      const gs = []
      for (let r = lo; r < hi; r += 1) gs.push(r)
      return gs
    }))) {
      // 该通道上每条线的竖直跨度：从它进入该通道的 y 到离开的 y。
      const segs = []
      for (const p of planned) {
        if (p.la === p.lb || !Number.isFinite(p.la) || !Number.isFinite(p.lb)) continue
        const lo = Math.min(p.la, p.lb); const hi = Math.max(p.la, p.lb)
        if (g < lo || g >= hi) continue
        // 进入通道 g 的 y：跨列线在列 r 的缝高（列 r 的左右通道就是 r-1 与 r）。
        // 起点/终点所在的通道用端点 y。
        const yIn = g === lo ? p.from.y : (p.lane.y.get(g) ?? p.from.y)
        const yOut = (g + 1) === hi ? p.to.y : (p.lane.y.get(g + 1) ?? p.to.y)
        segs.push({ p, y0: Math.min(yIn, yOut), y1: Math.max(yIn, yOut) })
      }
      if (segs.length === 0) continue
      // 贪心分槽：按 y0 排序，逐个放进第一个「与已放线区间不重叠」的槽；都不行就新开槽。
      segs.sort((a, b) => a.y0 - b.y0)
      const slotEnds = [] // 每个槽当前占用的最大 y1
      for (const s of segs) {
        let slot = -1
        for (let k = 0; k < slotEnds.length; k += 1) {
          // 留 WS_LANE_GAP 余量：圆角会在拐角处向内切，贴太近视觉上仍是一条粗线。
          if (s.y0 >= slotEnds[k] + WS_LANE_GAP) { slot = k; break }
        }
        if (slot < 0) { slot = slotEnds.length; slotEnds.push(s.y1) } else { slotEnds[slot] = s.y1 }
        if (slot > 0) {
          // 第 0 槽留在中心线；其余按 WS_LANE_GAP 向两侧交替偏移（保持视觉居中）。
          const k = Math.ceil(slot / 2)
          const off = (slot % 2 === 1 ? -1 : 1) * k * WS_LANE_GAP
          const maxOff = WS_GAP_X / 2 - 6
          s.p.lane.vx.set(g, Math.max(-maxOff, Math.min(maxOff, off)))
        }
      }
    }
    // 同层线：共用同一条竖直通道的，横向错开（否则竖直段整段重合）。
    const gutterGroups = new Map()
    for (const p of planned) {
      if (p.la !== p.lb) continue
      const side = wsGutterSide(state, p.la)
      const k = p.la + '|' + side
      const list = gutterGroups.get(k) ?? []
      list.push({ p, mid: (p.from.y + p.to.y) / 2 })
      gutterGroups.set(k, list)
    }
    for (const list of gutterGroups.values()) {
      list.sort((x, y) => x.mid - y.mid)
      const n = list.length
      const maxOff = WS_GAP_X / 2 - 6
      const spacing = n > 1 ? Math.min(WS_LANE_GAP * 2, (maxOff * 2) / (n - 1)) : 0
      const span = (n - 1) * spacing
      list.forEach((it, i) => { it.p.lane.gutter = -span / 2 + i * spacing })
    }
    // 相邻列线（|la-lb|===1）：它们**不跨任何列**，按列分道对它们完全不生效
    // （45% 像素复核实测：Lead→col1 的派活线在通道里贴身平行成一束）。
    // 通道（两列之间）没有任何卡片 → 整段画布高度都可走 → 每条线在通道中心
    // 拿一个独立槽位，路由时插一个途经点。
    //
    // ⚠️ 槽位必须**避开跨列线在该通道的固定 y**（重叠探针实测的最后一类粗线根因）：
    // 跨 col r 的线在 col r 左右两条通道上的 y 被"缝内水平段"钉死（= 列槽位 y），
    // 若端点线的自由槽位不避开这些固定值，两套分道系统会在同一个通道 x 上
    // 各排各的道 → python 拿 700、matlab 钉 698 → 380px 贴身平行（实测 d 对）。
    const byGutter = new Map()
    const gutterFixed = new Map()
    for (const p of planned) {
      if (p.la === p.lb) continue
      if (!Number.isFinite(p.la) || !Number.isFinite(p.lb)) continue
      const lo = Math.min(p.la, p.lb); const hi = Math.max(p.la, p.lb)
      if (hi - lo === 1) {
        const g = lo
        const list = byGutter.get(g) ?? []
        list.push({ p, ideal: (p.from.y + p.to.y) / 2 })
        byGutter.set(g, list)
        continue
      }
      // 跨列线：它在通道 g 上的 y 被所跨列的槽位钉死（列 r 的左右通道 = r-1 与 r）。
      for (const [r, y] of p.lane.y) {
        for (const g of [r - 1, r]) {
          if (g < lo || g >= hi) continue
          const arr = gutterFixed.get(g) ?? []
          arr.push(y)
          gutterFixed.set(g, arr)
        }
      }
    }
    for (const [g, list] of byGutter) {
      const fixed = gutterFixed.get(g) ?? []
      const lo = 4
      const hi = (Number.isFinite(state.canvasH) && state.canvasH > 0 ? state.canvasH : 1e4) - 4
      const slots = []
      for (let y = lo; y <= hi; y += WS_LANE_GAP) {
        if (fixed.some((fy) => Math.abs(fy - y) < WS_LANE_GAP)) continue
        slots.push(y)
      }
      if (slots.length === 0) continue
      // 同列分道：保序单调扫描，斜坡只展宽不交叉（见 byColumn 的注释）。
      list.sort((x, y) => x.ideal - y.ideal)
      const taken = new Set()
      for (const it of list) {
        let best = -1; let bd = Infinity
        for (let s = 0; s < slots.length; s += 1) {
          if (taken.has(s)) continue
          const d = Math.abs(slots[s] - it.ideal)
          if (d < bd) { bd = d; best = s }
        }
        if (best < 0) break
        taken.add(best)
        it.p.lane.gut = { g, y: slots[best] }
      }
    }

    // ① 承接线（写 → 读）。端点与分道已在上面的预计算里算好（p.from/p.to/p.lane）。
    for (const p of planned) {
      if (p.kind !== 'handoff') continue
      const { e, weak } = p
      const w = Math.min(3.2, 0.9 + ((e.weight ?? 1) - 1) * 0.55)
      const opacity = weak ? 0.2 : Math.min(0.62, 0.34 + ((e.weight ?? 1)) * 0.04)
      const d = wsRoute(state, p.from.x, p.from.y, p.to.x, p.to.y, p.la, p.lb, p.lane)
      const attrs = { stroke: 'var(--dat-violet)', 'stroke-width': weak ? 0.9 : w.toFixed(2), opacity: opacity.toFixed(2) }
      if (weak) attrs['stroke-dasharray'] = '2 4'
      if (e.both === true) attrs['marker-start'] = 'url(#ws-avs)'
      attrs['marker-end'] = 'url(#ws-av)'
      const files = Array.isArray(e.files) ? e.files : []
      const key = 'h:' + e.from + '\u2192' + e.to
      addPath(key, d, attrs, e.from + ' → ' + e.to + '：' + wsText('wsSharedFiles', { count: String(e.weight ?? files.length) })
        + (files.length > 0 ? '（' + files.slice(0, 2).join(' / ') + '）' : ''))
      if (!weak) wantFlow(key, d, 'var(--dat-violet)', Math.min(2.4, w + 0.6), e.both === true)
    }

    // ② Lead ↔ 队员：进行中 = 蓝虚线 Lead→队员；已交付 = 绿实线 队员→Lead。
    //    路径的 M 点 = 信息流源头（蓝从 Lead 出发、绿从成员出发）→ 流光方向永远=语义方向。
    for (const p of planned) {
      if (p.kind !== 'dispatch') continue
      const { e, done } = p
      const color = done ? 'var(--dat-green)' : 'var(--dat-blue)'
      const d = wsRoute(state, p.from.x, p.from.y, p.to.x, p.to.y, p.la, p.lb, p.lane)
      const attrs = { stroke: color, 'stroke-width': 1.3, opacity: 0.5, 'marker-end': 'url(#' + (done ? 'ws-ag' : 'ws-ab') + ')' }
      if (!done) attrs['stroke-dasharray'] = '5 4'
      const key = 'd:' + e.to
      addPath(key, d, attrs, done
        ? e.to + ' → Lead：' + wsText('wsDeliveredTip', { count: String(e.reported ?? 0) })
        : 'Lead → ' + e.to + '：' + wsText('wsDispatchMsg', { count: String(e.weight ?? 0) }))
      wantFlow(key, d, color, 2.2)
    }

    // ③ 流光层调和：同 key 复用元素只改几何（动画连续），新 key 创建，消失的移除。
    //
    // 每条边一个**深色实心色块**（v1 模型：`<path class="flow">` + pathLength=100 +
    // dasharray '9 91' + dashoffset 动画）。用户 2026-10-09 明确要求改回这个：
    // 「一个深色的色块即可，不用什么光晕了」。
    // 复用架构保留：dashoffset 动画挂在元素上，**改 d 不会重启动画**，
    // 所以轮询/点开关时色块不跳回起点（用户之前报过「点按钮流光重跑」）。
    // 双向承接边：正反各一个色块（用户 #7 报「应该从右往左，但真实流光是从左往右」）。
    if (!state.flow) desired.clear()
    for (const [key, want] of desired) {
      const variants = want.reverse === true ? ['', '|rev'] : ['']
      for (const suffix of variants) {
        const flowKey = key + '|flow' + suffix
        let el = state.flowEls.get(flowKey)
        if (el === undefined) {
          el = wsSvg('path', {
            class: 'flow' + (suffix === '|rev' ? ' f-rev' : ''),
            d: want.d, fill: 'none', pathLength: 100,
            stroke: want.color, 'stroke-width': want.width, 'stroke-dasharray': '9 91',
            'data-flow': key,
          })
          el.style.animationDelay = wsFlowPhase(key) + 's'
          flows.appendChild(el)
          state.flowEls.set(flowKey, el)
        }
        // 几何与样式：只在与上轮不同时才写属性（少触发重排）。
        if (el.getAttribute('d') !== want.d) el.setAttribute('d', want.d)
        const width = String(want.width)
        if (el.getAttribute('stroke-width') !== width) el.setAttribute('stroke-width', width)
        if (el.getAttribute('stroke') !== want.color) el.setAttribute('stroke', want.color)
      }
    }
    // 清理：只保留本轮 desired 里出现过的 key。
    for (const [key, el] of [...state.flowEls]) {
      const base = key.includes('|') ? key.slice(0, key.indexOf('|')) : key
      if (desired.has(base)) continue
      el.remove()
      state.flowEls.delete(key)
    }

    // ④ 协作核容器（折叠态）。
    if (collapsed) {
      const box = wsSvg('rect', { class: 'corebox', x: core.x, y: core.y, width: core.w, height: core.h, rx: 12 })
      const boxTitle = wsSvg('title', {})
      boxTitle.textContent = wsText('wsCoreTitle', { members: core.members.join('、') })
        + String.fromCharCode(10) + wsText('wsCoreTitleBody', { count: String(core.internal) })
      box.appendChild(boxTitle)
      const label = wsSvg('text', { class: 'corelabel', x: core.x + 10, y: core.y - 8 })
      label.textContent = wsText('wsCoreLabel', { count: String(core.members.length) })
      const toggle = (event) => {
        event.stopPropagation()
        state.coreOpen = !state.coreOpen
        wsSyncCoreButton(state)
        wsDrawWires(state)
      }
      box.addEventListener('click', toggle)
      label.addEventListener('click', toggle)
      coreLayer.append(box, label)
    }
  }

  function wsStatusbar(state) {
    const bar = state.statusEl
    bar.textContent = ''
    const graph = state.data
    const teammates = graph.nodes.filter((n) => n.role !== 'lead')
    const running = teammates.filter((n) => wsStateOf(n) === 'running').length
    const delivered = teammates.filter((n) => wsStateOf(n) === 'done').length
    const relations = graph.edges.filter((e) => e.kind === 'handoff').length
    const totals = graph.totals ?? {}
    const cell = (k, v, color) => {
      const wrap = document.createElement('div'); wrap.className = 'sb'
      const key = document.createElement('span'); key.className = 'k'; key.textContent = k
      const val = document.createElement('span'); val.className = 'v'; val.textContent = v
      if (color !== undefined) val.style.color = color
      wrap.append(key, val)
      return wrap
    }
    const sep = () => { const s = document.createElement('div'); s.className = 'sb-sep'; return s }
    bar.append(
      cell(wsText('wsMembers'), String(teammates.length)),
      cell(wsText('wsRunning'), String(running), 'var(--dat-blue)'),
      cell(wsText('wsDelivered'), String(delivered), 'var(--dat-green)'),
      cell(wsText('wsRelations'), String(relations), 'var(--dat-violet)'),
      sep(),
      // 与卡片同一口径：全队都没有 usage 时显示 `—`，而不是把「没测量」画成 0。
      cell(wsText('wsHit'), totals.hasUsage === true ? wsPct(totals.cacheHit ?? 0) : wsText('wsNoUsage')),
      cell(wsText('wsTotalTokens'), totals.hasUsage === true ? wsFmtN(totals.totalTokens ?? 0) : wsText('wsNoUsage')),
      cell(wsText('wsTotalOut'), totals.hasUsage === true ? wsFmtN(totals.outputTokens ?? 0) : wsText('wsNoUsage')),
      sep(),
      cell(wsText('wsAvgTps'), (Number(totals.avgTps) || 0) > 0 ? (Number(totals.avgTps) || 0).toFixed(1) : wsText('wsNoUsage')),
    )
    const right = document.createElement('div'); right.className = 'rt'
    const hint = document.createElement('span'); hint.className = 'hint'
    hint.textContent = wsText('wsRealData') + ' · ' + new Date().toLocaleTimeString() + (state.error === '' ? '' : ' · ' + state.error)
    // 历史快照（团队已结束，数据从日志/投影缓存恢复）：**常驻**标出来，不藏在悬停里。
    // 否则底栏写着「真实会话日志」会让用户以为团队还在跑（用户 2026-10-08 的场景就是额度耗尽后看历史）。
    // 「这是历史快照」以前靠**在宿主中文提示里搜子串**判断
    // （n.includes('团队可能已结束')），那是把界面文案当协议用：换语言、改一个标点，
    // 这个琥珀色标记就静默消失，而底栏仍写着「真实会话日志」—— 用户以为团队还在跑。
    // 现在读宿主的结构化字段（lib/graph.js 的 historyRecovered）。
    const snapshot = state.historyRecovered === true
    if (snapshot) {
      const tag = document.createElement('span'); tag.className = 'hint'
      tag.style.color = 'var(--dat-amber)'
      tag.textContent = '· ' + wsText('wsSnapshot')
      tag.title = wsNotesText(state.notes)
      right.appendChild(tag)
    }
    // 宿主的非致命事实（例如某成员会话没有活体 agent、持久日志读取失败）如实标出来，
    // 否则「读不到的 0」和「真没跑过的 0」在画布上长得一模一样。
    if (state.notes.length > 0) {
      const noteTag = document.createElement('span'); noteTag.className = 'hint'
      noteTag.style.color = 'var(--dat-amber)'
      noteTag.textContent = '· ' + wsText('wsNotes', { count: String(state.notes.length) })
      noteTag.title = wsNotesText(state.notes)
      right.appendChild(noteTag)
    }
    right.appendChild(hint)
    bar.appendChild(right)
  }

  function wsLegend(state) {
    const legend = state.legendEl
    legend.textContent = ''
    const line = (stroke, dash, label) => {
      const item = document.createElement('span'); item.className = 'li'
      const svg = wsSvg('svg', { width: 34, height: 8 })
      svg.appendChild(wsSvg('path', { d: 'M0 4 C12 4 22 4 30 4', stroke, 'stroke-width': 1.4, fill: 'none', ...(dash ? { 'stroke-dasharray': dash } : {}) }))
      const text = document.createElement('span'); text.textContent = label
      item.append(svg, text)
      return item
    }
    legend.append(
      line('var(--dat-blue)', '5 4', wsText('wsLegendLead')),
      line('var(--dat-green)', '', wsText('wsLegendDone')),
      line('var(--dat-violet)', '', wsText('wsLegendHandoff')),
    )
    const coreItem = document.createElement('span'); coreItem.className = 'li'
    const coreSvg = wsSvg('svg', { width: 26, height: 12 })
    coreSvg.appendChild(wsSvg('rect', { x: 1, y: 1, width: 24, height: 10, rx: 3, fill: 'none', stroke: 'var(--dat-violet)', 'stroke-dasharray': '4 3', opacity: 0.6 }))
    const coreText = document.createElement('span'); coreText.textContent = wsText('wsLegendCore')
    coreItem.append(coreSvg, coreText)
    const colItem = document.createElement('span'); colItem.className = 'li'; colItem.textContent = wsText('wsLegendCol')
    legend.append(coreItem, colItem)
  }

  function wsApplyZoom(state) {
    const k = state.zoom / 100
    state.canvas.style.transform = 'scale(' + k + ')'
    // transform 不改布局盒：不同步 width/height 的话，缩放后父容器仍按未缩放尺寸出滚动条。
    state.canvas.style.width = (state.canvasW * k) + 'px'
    state.canvas.style.height = (state.canvasH * k) + 'px'
    state.zoomLabel.textContent = Math.round(state.zoom) + '%'
    // 箭头尺寸随缩放补偿（屏幕上恒定大小）。
    // 不补的话：默认 45% 缩放下箭头只有 3px（用户报「看不到箭头」）。
    // 流光色块不需要补偿：dasharray 按 pathLength=100 归一，色块随画布一起缩放（v1 行为）。
    if (typeof state.syncMarkers === 'function') state.syncMarkers(k)
  }

  function wsFit(state) {
    const stage = state.stageEl
    const k = Math.max(45, Math.min(130, Math.floor(Math.min(
      (stage.clientWidth - 20) / Math.max(1, state.canvasW),
      (stage.clientHeight - 20) / Math.max(1, state.canvasH),
    ) * 100)))
    state.zoom = k
    state.zoomInput.value = String(k)
    wsApplyZoom(state)
  }

  function wsSyncCoreButton(state) {
    if (state.coreButton === null) return
    state.coreButton.textContent = state.coreOpen ? wsText('wsCoreClose') : wsText('wsCoreOpen')
    state.coreButton.classList.toggle('on', state.coreOpen)
    state.coreButton.style.display = state.core === null ? 'none' : ''
  }

  function wsRender(state) {
    // 节点**就地更新**：按名字复用已有 DOM，只改文本/样式/位置。
    // 整批重建会让每个节点的脉冲点动画从头开始、并让悬停中的 tooltip 闪没
    // （和流光重置是同一类错误：把「数据刷新」做成「重建成片」）。
    const seen = new Set()
    for (const node of state.data.nodes) {
      if (node.x === undefined) continue
      seen.add(node.name)
      const existing = state.nodeEls.get(node.name)
      if (existing === undefined) {
        const el = wsNodeCard(state, node)
        // 新队员入场：淡入 + 轻微放大，让「刚出现的队员」被看见（用户要求实时显示新队员）。
        // 只在**非首帧**时播：首次打开画布 18 个节点一起动会像故障。
        if (state.freshNames !== undefined && state.freshNames.has(node.name) && state.first === false) {
          el.classList.add('ws-enter')
          window.setTimeout(() => el.classList.remove('ws-enter'), 900)
        }
        canvasAppend(state, el)
        state.nodeEls.set(node.name, el)
      } else {
        wsUpdateCard(state, existing, node)
      }
    }
    for (const [name, el] of [...state.nodeEls]) {
      if (seen.has(name)) continue
      el.remove()
      state.nodeEls.delete(name)
    }
    wsDrawWires(state)
    wsStatusbar(state)
    wsLegend(state)
    wsSyncCoreButton(state)
  }

  function canvasAppend(state, el) {
    state.canvas.appendChild(el)
  }

  /** 就地刷新一张节点卡片：只动会变的部分（位置、状态点、文本、环）。 */
  function wsUpdateCard(state, el, node) {
    el.style.left = node.x + 'px'
    el.style.top = node.y + 'px'
    const st = wsStateOf(node)
    const dot = el.querySelector('.ws-dot')
    if (dot !== null) dot.className = 'ws-dot ' + st
    const todo = node.todo ?? { done: 0, running: 0, total: 0 }
    const setText = (sel, value) => {
      const target = el.querySelector(sel)
      if (target !== null && target.textContent !== value) target.textContent = value
    }
    setText('.nm', node.name)
    setText('.rl', node.role === 'lead' ? wsText('wsRoleLead') : String(node.name).replace(/-\d+$/, ''))
    setText('.model', node.model ?? wsText('wsModelNone'))
    setText('.ws-tl .ct', todo.done + '/' + todo.running + '/' + todo.total)
    const bar = el.querySelector('.ws-tl .bar')
    if (bar !== null) {
      const want = []
      if (todo.done > 0) want.push(['d', todo.done])
      if (todo.running > 0) want.push(['r', todo.running])
      const rest = Math.max(0, todo.total - todo.done - todo.running)
      if (rest > 0) want.push(['', rest])
      const current = [...bar.children]
      for (let i = 0; i < Math.max(want.length, current.length); i += 1) {
        if (i >= want.length) { current[i].remove(); continue }
        const [cls, flex] = want[i]
        let seg = current[i]
        if (seg === undefined) { seg = document.createElement('i'); bar.appendChild(seg) }
        if (seg.className !== cls) seg.className = cls
        const next = String(flex)
        if (seg.style.flex !== next) seg.style.flex = next
      }
    }
    // 与 wsCard 同一口径：没有 usage 时显示 `—`（见 wsCard 里的长注释）。
    const hasUsage = node.hasUsage === true
    setText('.ws-mx span:nth-child(1) b', hasUsage ? wsFmtN(node.usage?.outputTokens ?? 0) : '—')
    setText('.ws-mx span:nth-child(2) b', hasUsage ? wsFmtN(node.usage?.cacheReadTokens ?? 0) : '—')
    setText('.ws-mx .hit b', hasUsage ? wsPct(node.cacheHit ?? 0) : '—')
    // 任务归属会变（claim / complete / 换人），所以 tooltip 也要就地刷新（只在变了时写）。
    const tip = wsTaskTip(node.taskTip, node.name)
    if (el.title !== tip) el.title = tip
    const footCells = el.querySelectorAll('.ft .d')
    if (footCells.length >= 2) {
      const dur = wsFmtD(node.runtimeMs ?? 0)
      if (footCells[0].textContent !== dur) footCells[0].textContent = dur
      const tps = (node.tps ?? 0) > 0 ? node.tps.toFixed(1) + ' tps' : '—'
      if (footCells[1].textContent !== tps) footCells[1].textContent = tps
      // 分母会随回合一起变（runtime 在走、工具在结算），冷启动与刷新两条路都要更新。
      const tpsTip = wsTpsTip(node)
      if (footCells[1].title !== tpsTip) footCells[1].title = tpsTip
    }
    const ring = el.querySelector('.rg svg')
    if (ring !== null) {
      const u = Number(node.pressureTokens) || 0
      const t = Number(node.contextWindow) || 0
      const frac = t > 0 ? Math.min(1, u / t) : 0
      const c = 2 * Math.PI * ((30 - 6) / 2)
      const circles = ring.querySelectorAll('circle')
      if (circles.length >= 2) {
        const dash = (c * frac).toFixed(2) + ' ' + c.toFixed(2)
        if (circles[1].getAttribute('stroke-dasharray') !== dash) circles[1].setAttribute('stroke-dasharray', dash)
        const color = frac > 0.85 ? 'var(--dat-red)' : frac > 0.6 ? 'var(--dat-amber)' : 'var(--dat-blue)'
        if (circles[1].getAttribute('stroke') !== color) circles[1].setAttribute('stroke', color)
      }
      const title = ring.querySelector('title')
      // 走 wsCtxTip（唯一一份）。我上一轮在这条路上自己写下过第二个分支版本，
      // 它把 u===0 的「本轮未记录用量」漏掉了 —— 刷一轮就会显示「0 / N 上下文（0%）」，
      // 与建卡时那句话矛盾，正是 wsRing 注释里明令不要写的「已用 0 上下文」。
      const tip = wsCtxTip(u, t)
      if (title !== null && title.textContent !== tip) title.textContent = tip
    }
    // 点击目标必须跟着最新数据走（浮窗读的是 node 对象）。
    el.onclick = () => wsOpenDrawer(state, node)
  }

  /**
   * 图的廉价指纹：节点数/边数 + 每个节点的可见状态 + 汇总数字。
   * 5 秒一轮的自动刷新用它判断「这轮到底变了没有」——没变就不碰 DOM：
   * 重建节点会让流光动画从头开始（肉眼可见的卡顿）、让悬停中的 tooltip 闪没。
   */
  function wsFingerprint(graph) {
    const parts = [graph.nodes.length, graph.edges.length, (graph.tasks ?? []).length]
    for (const n of graph.nodes) {
      parts.push(n.name, n.status ?? '', n.model ?? '', n.totalTokens ?? 0, n.runtimeMs ?? 0,
        (n.todo?.done ?? 0) + '/' + (n.todo?.running ?? 0) + '/' + (n.todo?.total ?? 0),
        Math.round((n.cacheHit ?? 0) * 1000), Math.round((n.contextRatio ?? 0) * 100))
    }
    for (const e of graph.edges) parts.push(e.kind, e.from, e.to, e.weight ?? 0, e.delivered === true ? 1 : 0, e.both === true ? 1 : 0)
    const t = graph.totals ?? {}
    parts.push(t.totalTokens ?? 0, Math.round((t.cacheHit ?? 0) * 1000), Math.round((t.avgTps ?? 0) * 10))
    return parts.join('\u0001')
  }

  async function wsLoad(state, first, force) {
    if (state.loading) return
    // ⚠️ 2026-10-12 修「浮窗一开，所有指标冻结」（用户报障：「发了消息之后工作区 lead 显示
    //    运行 0 秒，不显示信息，包括弹窗里面的回复也不显示了」）。
    //
    // 旧实现在浮窗打开时**整轮跳过**刷新，原注释担心「重绘会让抽屉里的引用变陈旧」。
    // 但刷新路径本来就地更新：wsRender → wsUpdateCard 只改文本/状态点/进度条/环，不重建节点，
    // 且每轮把 onclick 重绑到**最新** node（见 wsUpdateCard 末尾）。所以那个担心不成立，
    // 跳过的唯一后果是：卡片与抽屉指标永远停在开窗那一刻 —— 开窗时恰好是 0，就永远显示 0。
    // 现在照常刷新，抽屉指标由 wsSyncDrawerCells 同步（见 wsApplyGraph）。
    state.loading = true
    if (first) { state.noteEl.textContent = wsText('wsLoading'); state.noteEl.style.display = '' }
    let result
    try {
      // toolLabelsHash：把上一轮拿到的标签表指纹带回去，一致时服务端**省略**整张表
      // （双语表实测 7,286 字节，graph 本体 30,656 字节 → 每轮少白送约 19%）。
      // 首轮没有指纹 → 不带这个键 → 服务端发全量。undefined 不会进 JSON（apiCall 序列化时丢弃）。
      result = await apiCall('team-graph', { sessionId: state.sessionId, toolLabelsHash: state.toolLabelsHash })
    } catch (error) {
      // apiCall 设计上不 reject，但同步抛错（或将来改成抛错）会走到这里。
      // 关键：**loading 必须复位**，否则这个标志永远为 true → 之后每一轮都在第一行早返回，
      // 画布再也不会刷新（用户看到的是「卡住了」，且没有任何报错）。
      result = { ok: false, error: String((error && error.message) || error) }
    } finally {
      state.loading = false
    }
    if (result === null || result === undefined || result.ok !== true || result.graph === undefined) {
      state.error = result.notEnabled === true ? wsText('wsNotEnabled') : wsText('wsLoadFailed', { message: String(result.error ?? '') })
      // 请求失败时上一轮的宿主提示已经不作数：留着会让「这轮读不到」看起来像「上轮那几条」。
      // 快照标志同理 —— 那是**上一轮**的事实，本轮读不到就别继续挂着琥珀色标记。
      state.notes = []
      state.historyRecovered = false
      if (state.data === null) { state.noteEl.textContent = state.error; state.noteEl.style.display = '' }
      else { wsStatusbar(state) }
      return
    }
    // 形状闸门：宿主契约漂移（缺 nodes/edges）时必须在**这里**拦住并给出可读错误。
    // 否则后面 wsFingerprint 读 graph.nodes.length 会抛 TypeError，而那个抛出点以前
    // 在 try 之外 → 一路冒泡到轮询链的 .then（无 catch）→ **链永久死亡、画布冻结且无提示**。
    if (!Array.isArray(result.graph.nodes) || !Array.isArray(result.graph.edges)) {
      // 这句原来硬编码在代码里（字典之外）：英文界面下它是一句孤零零的中文。
      state.error = wsText('wsLoadFailed', { message: wsText('wsGraphShapeError') })
      state.notes = []
      // 两条失败路径都要清这个标志（理由见上面那条）；少清一条，形状漂移后
      // 底栏就继续挂着上一轮的「历史快照」标记。
      state.historyRecovered = false
      if (state.data === null) { state.noteEl.textContent = state.error; state.noteEl.style.display = '' }
      else { wsStatusbar(state) }
      return
    }
    state.error = ''
    state.notes = Array.isArray(result.notes) ? result.notes : []
    // 历史快照的标志来自宿主字段，**不再**在 notes 里搜中文（见 wsStatusbar 的注释）。
    state.historyRecovered = result.historyRecovered === true
    // 有表才覆盖：服务端省略那一轮 result.toolLabels 是 undefined，无条件赋值会把
    // 缓存的表清成 null（工具行标签当场退化成中文/泛称 —— 越用越坏）。
    if (result.toolLabels !== undefined && result.toolLabels !== null) state.toolLabels = result.toolLabels
    // 指纹每轮都记（省略时服务端仍回同一个 hash，见 integration-test 那条断言）。
    if (typeof result.toolLabelsHash === 'string') state.toolLabelsHash = result.toolLabelsHash
    try {
      wsApplyGraph(state, result.graph, first, force)
    } catch (error) {
      // 渲染期任何异常都只影响这一帧：如实报错 + 保住已有画面，绝不让它冒泡出 wsLoad
      // （冒泡出去会打断轮询链，见上）。下一轮会自动重试。
      state.error = wsText('wsLoadFailed', { message: String((error && error.message) || error) })
      wsStatusbar(state)
    }
  }

  /** 应用一帧图数据（指纹比对 → 布局 → 渲染）。异常由调用方兜住。 */
  function wsApplyGraph(state, graph, first, force) {
    const fingerprint = wsFingerprint(graph)
    if (!first && !force && fingerprint === state.fingerprint) {
      // 数据没变：不重绘节点/线（流光不重启、tooltip 不闪没），但底栏的刷新时刻照常走。
      // 连续 N 轮没变就把轮询退回慢档（自适应间隔的另一半，见 schedule）。
      state.stableRounds = (state.stableRounds ?? 0) + 1
      state.changedRecently = state.stableRounds < 3
      wsStatusbar(state)
      // ⚠️ 这条早退分支**也要**同步停止键（2026-10-14 探针抓到）：判据是官方面上的
      // session.running，而它**不在指纹里**（wsFingerprint 只算图数据）。队员在回合
      // 之间空一秒、图数据一个字没变，按钮就会停在上一轮的状态 —— 数据没变 ≠ 按钮不用管。
      // 一次属性写入的成本，对比「按钮说谎」的代价。
      wsSyncDrawerStop(state.drawerStop, state.drawerSession)
      return
    }
    state.stableRounds = 0
    state.changedRecently = true
    state.fingerprint = fingerprint
    // 新出现的成员名：给它们加入场动画（用户要求「每创建一个队友都会实时显示到工作区里面」）。
    const prevNames = state.data === null ? new Set() : new Set(state.data.nodes.map((n) => n.name))
    const fresh = new Set(graph.nodes.map((n) => n.name).filter((name) => !prevNames.has(name)))
    state.data = graph
    state.freshNames = fresh
    state.noteEl.style.display = 'none'
    if (state.data.nodes.length <= 1) {
      state.noteEl.textContent = wsText('wsEmpty')
      state.noteEl.style.display = ''
    }
    wsLayout(state)
    wsRender(state)
    // 浮窗开着时，它的指标格也要吃**这一帧**的数据。
    // 为什么必须在这里同步（2026-10-12 用户报障「运行 0 秒，不显示信息」）：
    // 浮窗的指标格建一次 DOM 就不再看图数据了，而 wsLoad 旧实现又在浮窗打开时整轮跳过刷新
    // ⇒ 两个叠加 = 打开浮窗后所有数字冻结。现在刷新照常（见 wsLoad），这里把值同步过去。
    if (typeof state.drawerName === 'string' && state.drawerCells !== undefined) {
      const shown = state.data.nodes.find((n) => n.name === state.drawerName)
      if (shown !== undefined) wsSyncDrawerCells(state.drawerCells, shown)
      // 「停止生成」的可用性也跟着这一轮走：队员跑完/被打断后按钮要自己消失，
      // 不然用户会去按一颗已经没意义的停止键。
      wsSyncDrawerStop(state.drawerStop, state.drawerSession)
    }
    if (first) {
      wsFit(state)
      // 首帧渲染完毕 → 之后出现的节点才算「新队员」，才播入场动画。
      // （这个标志以前一直是 true，导致入场动画永远不触发 —— 新队员会「凭空出现」而没有提示。）
      state.first = false
    }
  }

  /**
   * 浮窗指标格的**值**（顺序必须与 wsOpenDrawer 里的 cellKeys 一一对应）。
   *
   * 抽出来的原因（2026-10-12）：浮窗打开时只建一次 DOM、值由 wsSyncDrawerCells 刷新，
   * 这样「运行时长 / token / 上下文」会跟着工作区一起走，而不是停在开窗那一刻。
   * 口径与卡片完全一致（hasUsage === false 的字段显示 `—`，见 wsCard 里的长注释）。
   * @param {object} node - 图节点。
   * @returns {string[]} 与指标格同序的显示值。
   */
  function wsDrawerValues(node) {
    const st = wsStateOf(node)
    const stLabel = st === 'running' ? wsText('wsStateRunning') : st === 'done' ? wsText('wsStateDone')
      : st === 'failed' ? wsText('wsStateFailed') : wsText('wsStateIdle')
    const dash = wsText('wsNoUsage')
    const hasUsage = node.hasUsage === true
    // 停止原因（2026-10-12 用户报「队员罢工没人察觉」）：turn/end 的 reason.kind 如实上墙。
    // completed = 正常收尾，显示「—」不制造噪音；max-tokens 给出可执行的下一步（发「继续」）。
    const stop = node.lastTurnEndReason
    // ⚠️ 错误正文与错误码要一起上墙（2026-10-14 审查 P1-4）。此前这里只有 kind，
    // 于是真机上那批 QUOTA_EXCEEDED（.probe/real-events.json seq 349/362/371/382/527：
    // 「所有通道对该模型均受限」）在浮窗里被压成三个字「上一轮报错」——
    // 用户看得见「出错」，看不见「额度受限，换个模型就能继续」这个可执行的下一步。
    const stopMessage = typeof node.lastTurnErrorMessage === 'string' ? node.lastTurnErrorMessage.trim() : ''
    const stopCode = typeof node.lastTurnErrorCode === 'string' ? node.lastTurnErrorCode.trim() : ''
    const stopLead = stop === undefined || stop === null || stop === '' || stop === 'completed' ? dash
      : stop === 'max-tokens' ? wsText('wsStopMaxTokens')
        : stop === 'error' ? wsText('wsStopError')
          : String(stop)
    const stopTail = [stopMessage, stopCode].filter((part) => part !== '').join(' · ')
    const stopLabel = stopLead === dash || stopTail === '' ? stopLead : stopLead + '：' + stopTail
    return [
      node.model ?? wsText('wsModelNone'),
      stLabel,
      wsFmtD(node.runtimeMs ?? 0),
      (node.tps ?? 0) > 0 ? node.tps.toFixed(1) + ' tps' : dash,
      hasUsage ? wsFmtN(node.usage?.outputTokens ?? 0) : dash,
      hasUsage ? wsFmtN(node.usage?.uncachedInputTokens ?? 0) : dash,
      hasUsage ? wsFmtN(node.usage?.cacheReadTokens ?? 0) : dash,
      hasUsage ? wsPct(node.cacheHit ?? 0) : dash,
      (node.pressureTokens ?? 0) > 0
        ? wsFmtN(node.pressureTokens ?? 0) + (node.contextWindow ? ' / ' + wsFmtN(node.contextWindow) : '')
        : dash + (node.contextWindow ? ' / ' + wsFmtN(node.contextWindow) : ''),
      (node.todo?.done ?? 0) + '/' + (node.todo?.running ?? 0) + '/' + (node.todo?.total ?? 0),
      wsText('wsMsgUnit', { count: String(node.dispatched ?? 0) }),
      stopLabel,
    ]
  }

  /**
   * 把最新值写进浮窗指标格（只改**变化了**的文本，避免每轮无谓的 DOM 写入与闪烁）。
   * @param {HTMLElement[]} cells - 值单元格（wsOpenDrawer 建格时收集）。
   * @param {object} node - 该浮窗正在显示的那个节点（按 name 匹配到的最新数据）。
   * @returns {void}
   */
  function wsSyncDrawerCells(cells, node) {
    if (!Array.isArray(cells) || cells.length === 0) return
    const values = wsDrawerValues(node)
    for (let i = 0; i < cells.length && i < values.length; i += 1) {
      const el = cells[i]
      if (el === undefined || el === null) continue
      const text = String(values[i])
      if (el.textContent !== text) { el.textContent = text; el.title = text }
    }
  }

  function wsOpenDrawer(state, node) {
    state.drawer.textContent = ''
    const head = document.createElement('div'); head.className = 'dh'
    const dot = document.createElement('span'); dot.className = 'ws-dot ' + wsStateOf(node)
    dot.style.width = '8px'; dot.style.height = '8px'
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = node.name
    const rl = document.createElement('span'); rl.className = 'rl'
    rl.textContent = node.role === 'lead' ? 'Team Lead' : String(node.name).replace(/-\d+$/, '')
    const close = document.createElement('button'); close.className = 'ws-btn ghost x'; close.textContent = wsText('wsClose')
    close.addEventListener('click', () => wsCloseDrawer(state))
    head.append(dot, nm, rl, close)

    const body = document.createElement('div'); body.className = 'db'
    // 指标格的**键固定、值随数据变**：DOM 只建一次，值由 wsSyncDrawerCells 就地刷新
    // （2026-10-12：修「浮窗指标停在打开那一刻」—— 用户看到「运行 0 秒」永不更新）。
    const cellKeys = [
      wsText('wsCellModel'), wsText('wsCellStatus'), wsText('wsCellRuntime'), wsText('wsCellTps'),
      wsText('wsCellOut'), wsText('wsCellIn'), wsText('wsCellCache'), wsText('wsCellHit'),
      wsText('wsCellCtx'), wsText('wsCellTodo'), wsText('wsCellDispatch'), wsText('wsCellStop'),
    ]
    const grid = document.createElement('div'); grid.className = 'grid'
    const cellValues = []
    for (const k of cellKeys) {
      const cell = document.createElement('div'); cell.className = 'cell'
      const key = document.createElement('div'); key.className = 'k'; key.textContent = k
      const val = document.createElement('div'); val.className = 'v'
      cell.append(key, val)
      grid.appendChild(cell)
      cellValues.push(val)
    }
    wsSyncDrawerCells(cellValues, node)
    // 登记给 wsApplyGraph：图每刷新一轮，这两个字段就把最新数据同步到这个浮窗。
    state.drawerCells = cellValues
    state.drawerName = node.name
    body.appendChild(grid)

    // ⚠️ 用户 2026-10-08 明确要求：**不要**「关系」「任务」这些噪音区块。
    // 原话：「图中画的蓝色区域不要放这些没用的什么记忆文件注入、消息啥的，我点击了一个卡片后
    // 想看到的是 [指标] 这个保留，下面是 [对话窗口]」。
    // 所以浮窗现在只有两块：① 指标格（保留）② 对话正文（占满剩余高度、自己滚动）。
    // 这两条信息各自的真值位置（2026-10-14 逐条核过，别再写错）：
    //   * 关系 = 画布上的连线（wsDrawWires）+ 连线自身的悬停 title；
    //   * 任务 = 节点卡片的悬停 title（node.taskTip，服务端 graph.taskTipOf 算好）**以及**
    //            DSH 官方那个「共享任务」面板（client-ui-agent-team 直接投影 team/task 账本）。
    // 底栏那个数字是**全队**条目数，不是某个人的归属，别拿它当归属看。

    const convoTitle = document.createElement('h4'); convoTitle.textContent = wsText('wsDrawerConvo')
    const convoBox = document.createElement('div'); convoBox.className = 'cv'
    convoBox.textContent = wsText('wsDrawerConvoLoading')
    const convoWrap = document.createElement('div'); convoWrap.className = 'cvwrap'
    convoWrap.append(convoTitle, convoBox)
    body.appendChild(convoWrap)
    // 归属令牌：对话是异步拉的，期间用户可能关掉浮窗、或点了**另一个**队员。
    // 没有这道闸门时，慢响应会把 A 的对话画进 B 的浮窗（或画进已关闭的浮窗里）。
    state.drawerToken = (state.drawerToken ?? 0) + 1
    const token = state.drawerToken
    /**
     * 拉一次对话并渲染。
     *
     * ⚠️ 2026-10-10 改成**可重复调用**（原来是只跑一次的 IIFE）。用户报：
     *   「队员的弹窗无法实时同步官方界面的信息，点进去后不会有任何回复，
     *     只有退出弹窗重新进来才会有更新」——
     * 根因就是它只拉一次、之后**没有任何刷新机制**。
     * 现在由下面的自适应轮询按 `state.drawerToken === token` 反复调用，
     * 队员在后台继续干活时，弹窗会自己长出新的工具行与回复。
     * @param {boolean} first - 是否首次渲染（决定要不要强制滚到底）。
     * @returns {Promise<boolean>} 本轮**是否探测到内容变化**（供自适应轮询选快/慢档）。
     */
    // ── 弹窗对话：持久行（宿主读日志）+ 流式覆盖层（官方同一份 eventSource）──
    //
    // 用户 2026-10-13 的报障：「在首 token 前进入工作区点开 lead 的卡片，只能看到我发的
    // 消息，看不到首 token 的思考过程，直到 lead 提问时才把之前的思考一下子全加载出来」。
    // 根因：这里过去**只**读持久日志（team-conversation → session.eventAt / persistence），
    // 而 assistant/message 与 tool/call 都是**整步结算时**才落盘的（实测 session-0000100a
    // 的 seq 19/20 同一毫秒）⇒ 结算之前，思考与工具调用根本不存在于那个数据源里，
    // 再怎么轮询也不可能实时。
    //
    // 修法：吃官方界面自己在用的那份窗口（见文件头「宿主桥」①）。它带 transient 的
    // assistant/live-chunk 行，每一个 token 都同步 publish 一次 ⇒ 覆盖层与官方同帧。
    // 拿不到桥（宿主版本不对 / 该会话没有活体对象层）时 live 为 null，行为退回原来的
    // 「轮询持久日志 + 一句正在生成」—— 不实时，但绝不空白、绝不报错。
    /** 用户手动展开过的折叠思考：键是 'turn:step'。渲染每轮都重建 DOM，
     *  展开状态必须存在 DOM 之外，否则点开后下一个 token 一到就被打回折叠。 */
    const expandedThinking = new Set()

    // ── 展开层（2026-10-14，补用户 2026-10-09 那条需求的另一半）────────────────
    // 官方每一行工具调用是**可展开**的：折叠一行标签+目标，展开是「输入」「输出」
    // （.probe-tmp/tool-client.js:1495 注释原文 render one localized tool summary and
    //  lazily mounted result card；判据 :1518 expandable = inputRaw !== null ||
    //  outputText !== null || card !== null）。本插件此前折到「读取 · a.md」为止：
    // tool/result 那一支只写了 row.error，正文一个字节都没取（lib/graph.js 旧 :1397-1402）。
    // 正文按**行身份**懒取（team-detail），不随对话行整批回传 —— 抽屉每 1.2~3 秒
    // 轮询一次，把 329 次调用的参数与结果都挂上行等于每轮把载荷放大几十倍。
    /** 展开中的行（detailKey 集合）。状态必须在 DOM 之外：轮询每轮重建 DOM。 */
    const openedRows = new Set()
    /** detailKey → 取回的那份正文（成功与失败都记一次，避免反复打接口）。 */
    const detailCache = new Map()
    /** 一行的稳定身份：poll 重建 DOM 后仍对得上展开状态。 */
    const wsFoldKey = (row) => (typeof row.detailKey === 'string' && row.detailKey !== ''
      ? row.detailKey : 'g:' + String(row.time ?? 0) + ':' + String(row.count ?? 0))
    /**
     * 懒取一行的详情。**只在用户点开时调用**；结果进缓存，之后重渲染不再打接口。
     * @param {string} key - 行身份（call:<callId> 或 turn:<turn>:<step>）。
     * @returns {void}
     */
    const wsLoadDetail = (key) => {
      if (detailCache.has(key)) return
      void apiCall('team-detail', { sessionId: state.sessionId, targetId: node.id, key })
        .then((result) => {
          if (state.drawerToken !== token) return
          detailCache.set(key, result.ok === true
            ? result : { ok: false, note: String(result.error ?? '') })
          renderConvo(false)
        }, (error) => {
          // apiCall 设计上不 reject，这里兜一层：真 reject 了也要如实记，不能永远转圈。
          if (state.drawerToken !== token) return
          detailCache.set(key, { ok: false, note: String((error && error.message) || error) })
          renderConvo(false)
        })
    }
    /**
     * 画一行的展开体：工具行是「输入 / 输出」两块，正文与思考行是整段全文。
     * @param {object} row - 对话行。
     * @returns {HTMLElement}
     */
    /**
     * 这一行要复制的**正文**（官方复制的是整条消息原文，见 chat-client.js:1117 的 text 属性）。
     *
     * 为什么不是直接复制 row.text：后端把行截在 LINE_MAX=2000 码元，**官方不截**。
     * 直接复制断尾正文的话，用户粘出去的是「少了后半段」的内容而毫不知情 ——
     * 那比没有复制按钮更糟。所以有 detailKey 的行先去宿主取全文（与「展开全文」
     * 同一条通道、同一个缓存）；取不到就**让复制失败**并显示原因，不静默给半份。
     * @param {object} row - 对话行。
     * @returns {Promise<string>} 正文全文。
     */
    const wsCopyTextFor = (row) => {
      const key = wsFoldKey(row)
      const cached = detailCache.get(key)
      if (cached !== undefined && cached.ok === true && typeof cached.output === 'string') {
        return Promise.resolve(cached.output)
      }
      if (row.hasDetail === true && typeof row.detailKey === 'string') {
        return apiCall('team-detail', { sessionId: state.sessionId, targetId: node.id, key: row.detailKey })
          .then((result) => {
            if (result.ok !== true) throw new Error(String(result.error ?? ''))
            // 顺手填进缓存：用户接着点「展开全文」就不用再打一次接口。
            detailCache.set(key, result)
            return typeof result.output === 'string' ? result.output : String(row.text ?? '')
          })
      }
      return Promise.resolve(String(row.text ?? ''))
    }

    /**
     * 按行的类别决定给不给「复制 + 时间」，照官方的**有/无**与**左右顺序**。
     * 不给的对象也有依据：工具行（官方两个 bundle 里 formatMessageClock 都是 0 次）、
     * 思考行（官方 ReasoningRow 不在 MessageIconActions 的四处调用里）、
     * 流式中的行（官方回合尾只在回合结束那个节点渲染，:6596 closing.finalNode）。
     * @param {object} row - 对话行。
     * @returns {HTMLElement|null}
     */
    const wsRowActionsFor = (row) => {
      if (row.live === true || row.reasoning === true) return null
      if (row.kind === 'user') {
        return wsRowActions(row, { copy: true, clock: true, clockSide: 'start' }, wsCopyTextFor)
      }
      if (row.kind === 'assistant') {
        return wsRowActions(row, { copy: true, clock: true, clockSide: 'end' }, wsCopyTextFor)
      }
      if (row.kind === 'team' || row.kind === 'notice') {
        // 时间：官方把这类来源当 turn trigger 渲染，:6719 有 formatMessageClock。
        // 复制：**官方这条路上没有**（MessageIconActions 的四处调用都不含它），
        // 但队员汇报是一整段可复用的正文，用户要复制是很自然的动作 ——
        // 这一条是按「用户怎么体验好」加的，不是照抄官方，注释如实标在这儿。
        return wsRowActions(row, { copy: true, clock: true, clockSide: 'end' }, wsCopyTextFor)
      }
      return null
    }

    const wsDetailBox = (row) => {
      const box = document.createElement('div')
      box.className = 'dbox'
      const found = detailCache.get(wsFoldKey(row))
      if (found === undefined) { box.textContent = wsText('wsDetailLoading'); return box }
      if (found.ok !== true) {
        box.textContent = wsText('wsDetailFailed', { message: String(found.note ?? '') })
        return box
      }
      const label = (text) => {
        const l = document.createElement('div'); l.className = 'dl'; l.textContent = text
        return l
      }
      const body = (text) => {
        // 工具正文一律 <pre> + textContent：那是 JSON 与命令输出，走 markdown 会把
        // 花括号与星号当语法吃掉（2026-10-11 弹窗乱码就是同一类错误的反面）。
        const pre = document.createElement('pre'); pre.textContent = text
        return pre
      }
      if (row.kind === 'tool') {
        // parts 与展开层**同源**：同一份文字既画进框里、也交给「放大查看」，不取第二次数。
        const parts = []
        if (typeof found.input === 'string' && found.input !== '') {
          const cap = wsText('wsDetailInput')
          box.appendChild(label(cap))
          box.appendChild(body(found.input))
          parts.push({ label: cap, text: found.input })
        }
        if (typeof found.output === 'string' && found.output !== '') {
          const cap = found.error === true ? wsText('wsDetailOutputErr') : wsText('wsDetailOutput')
          box.appendChild(label(cap))
          box.appendChild(body(found.output))
          parts.push({ label: cap, text: found.output, error: found.error === true })
        }
        // 工具条插在最前面：.dzb 是 sticky 的，只有排在开头才会在框内滚动时一直钉在上沿。
        if (parts.length > 0) box.insertBefore(wsDetailZoomBar(state, row, parts), box.firstChild)
      } else {
        // 正文与思考共用同一个 (turn, step) 身份，所以各取各的那一份。
        const full = row.reasoning === true
          ? (typeof found.reasoning === 'string' ? found.reasoning : found.output)
          : found.output
        const md = document.createElement('div'); md.className = 'md'
        md.innerHTML = wsMarkdown(String(full ?? ''))
        box.appendChild(md)
      }
      // 宿主那侧还有 DETAIL_MAX 上限（32,000 码元），截过就如实标出来，不假装是全文。
      if (found.truncated === true) box.appendChild(label(wsText('wsDetailCapped')))
      return box
    }
    /** 宿主给的持久行；null = 还没拿到第一帧。 */
    let durableRows = null
    /** 宿主给的「本步还在生成」信号（只在没有覆盖层时用）。 */
    let durablePending = false
    /** 宿主读不到时的说明文字（空态用）。 */
    let durableNote = ''
    /** 已经结算的 (turn:step) 名单（宿主 settledStepsOf 算的，见 lib/graph.js）。 */
    let settledSteps = new Set()
    /**
     * 宿主半是否认这套协议（team-conversation 带 settledSteps / 行带 callId）。
     *
     * 为什么必须有这个闸门：改宿主半要**重启 DSH** 才生效，而改浏览器半只要刷新页面
     * （README「改代码后的生效方式」）。刷新了页面、没重启宿主时，宿主回的是**旧形状**
     * —— 没有 settledSteps、工具行没有 callId ⇒ 覆盖层那两把去重判据全部失效，
     * 已经结算的流式内容会与持久行**同时显示两遍**（同一段思考出现两次）。
     * 判据缺位时宁可退回「只轮询持久日志」这条老实路径，也不画重复内容。
     */
    let hostLiveCapable = false
    /** 覆盖层折出来的行（没桥时恒为空数组）。 */
    let liveRows = []
    /** 上一次看到的最大持久 seq：变了就立刻找宿主补一次，不等轮询。 */
    let lastDurableSeq = -1
    /** 结算后补拉持久行的防抖计时器（同一批 token 只拉一次）。 */
    let durableReloadTimer = 0

    /** 把「持久 + 覆盖层」两段行拼成最终要画的那一份。 */
    const allRows = () => {
      const base = durableRows === null ? [] : durableRows
      // 宿主半不认这套协议时**不画覆盖层**（理由见 hostLiveCapable：去重判据会失效，
      // 结算过的思考会与持久行重复）。此时轮询照常兜着，等于回到旧行为。
      if (!hostLiveCapable || liveRows.length === 0) return base
      // 去重（覆盖层与持久行的边界）：一条流式内容一旦进持久行就必须收回去，
      // 否则同一段思考/同一个工具行显示两遍。两种判据，各自精确：
      //   * 工具行按 callId —— 实测 data.stream 的 tool-call-chunks.id 与 tool/call 的
      //     callId **逐字相同**（session-0000100a：call_f3ee41e0ac224cc09da00ac9），
      //     而名字与目标都可能重复（连续两次 read 同一文件），不能拿来去重；
      //   * 正文/思考按 (turn, step) —— 用宿主给的 settledSteps，而不是从返回的行里推：
      //     extractConversation 会把成串工具行折叠掉，被折叠那一步的 turn/step 就不在
      //     返回结果里了（只靠返回行会漏判 → 重复显示）。
      const paintedCalls = new Set()
      for (const row of base) if (typeof row.callId === 'string' && row.callId !== '') paintedCalls.add(row.callId)
      const tail = []
      for (const row of liveRows) {
        if (row.kind === 'tool' && typeof row.callId === 'string' && paintedCalls.has(row.callId)) continue
        if (row.turn !== undefined && row.step !== undefined
          && settledSteps.has(String(row.turn) + ':' + String(row.step))) continue
        tail.push(row)
      }
      return tail.length === 0 ? base : base.concat(tail)
    }

    /**
     * 渲染对话区。**渲染口径复刻官方原始界面**（用户 2026-10-09：「弹窗要像在原始界面
     * 看到的界面一样，能看到读取文件、修改文件、调用工具等等」）：
     *   * 助手正文走 markdown 渲染（之前 textContent 直出 → 全是裸 `**`/`###`，用户叫它「乱码」）；
     *   * 工具调用是**逐条一行**「已读取文件 + 目标」（后端已按官方 activity() 字典出标签）；
     *   * ask_user_question 不在这里出现 —— 它渲染成下面的选择型提问卡。
     * @param {boolean} first - 是否首次渲染（决定要不要强制滚到底）。
     * @returns {boolean} 内容是否变化（供自适应轮询选快/慢档）。
     */
    const renderConvo = (first) => {
      // 记住用户是否本来就贴在底部：贴着才自动滚到最新，否则不要打断他往回翻。
      const wasAtBottom = first === true || convoBox.scrollHeight - convoBox.scrollTop - convoBox.clientHeight < 24
      const prevText = convoBox.textContent
      const rows = allRows()
      if (rows.length === 0) {
        convoBox.textContent = durableRows === null
          ? wsText('wsDrawerConvoLoading')
          : (durableNote !== '' ? durableNote : wsText('wsDrawerConvoEmpty'))
        convoBox.className = 'cv empty'
        return false
      }
      convoBox.textContent = ''
      convoBox.className = 'cv'
      const whoOf = (kind) => wsText(kind === 'user' ? 'wsWhoUser'
        : kind === 'assistant' ? 'wsWhoAssistant'
          : kind === 'tools' ? 'wsWhoTools'
            : kind === 'team' ? 'wsWhoTeam'
              : kind === 'notice' ? 'wsWhoNotice' : 'wsWhoSystem')
      // 思考行的序号（只在没有 turn/step 时当展开键用，见下面 thinkKey）。
      let thinkIndex = 0
      for (const row of rows) {
        if (row.kind === 'tool' || row.kind === 'toolgroup') {
          const foldable = row.kind === 'toolgroup'
            ? (Array.isArray(row.rows) && row.rows.length > 0)
            // 流式覆盖层的工具行**不给箭头**：它还没结算，宿主日志里没有 result，
            // 点了只能拿到半份参数 —— 等它结算成持久行（带 hasDetail）再展开。
            : (row.live !== true && row.hasDetail === true)
          const open = foldable && openedRows.has(wsFoldKey(row))
          const trow = document.createElement('div')
          trow.className = 'trow' + (row.error === true ? ' err' : '') + (row.kind === 'toolgroup' ? ' group' : '')
            + (foldable ? ' exp' : '')
          if (foldable) {
            const chv = document.createElement('span'); chv.className = 'chv'
            chv.textContent = open ? '▾' : '▸'
            trow.appendChild(chv)
          }
          const tl = document.createElement('span'); tl.className = 'tl'
          tl.textContent = row.kind === 'toolgroup'
            // 后端只给 count（事实），句子按当前语言拼 —— 见 lib/graph.js 的 toolgroup 注释。
            ? wsText('wsToolgroup', { count: String(row.count ?? row.rows.length ?? 0) })
            : (wsRowToolLabel(row, state) + (row.error === true ? wsText('wsToolFailedSuffix') : ''))
          trow.appendChild(tl)
          if (row.detail !== undefined && row.detail !== '') {
            const tt = document.createElement('span'); tt.className = 'tt'; tt.textContent = row.detail; tt.title = row.detail
            trow.appendChild(tt)
          }
          convoBox.appendChild(trow)
          if (foldable) {
            // 与官方 DisclosureRow 同一分工：点开才取数（wsLoadDetail 里缓存一次）。
            trow.addEventListener('click', () => {
              if (openedRows.has(wsFoldKey(row))) openedRows.delete(wsFoldKey(row))
              else { openedRows.add(wsFoldKey(row)); wsLoadDetail(wsFoldKey(row)) }
              renderConvo(false)
            })
            if (open) {
              if (row.kind === 'tool') convoBox.appendChild(wsDetailBox(row))
              else {
                // 折叠组：把被折掉的那几条**原样列出来**（后端 rows 随行进上，
                // 数据早就在这一行里，不打接口）。每一条自己还能再点开看输入输出。
                const wrap = document.createElement('div')
                for (const inner of row.rows) {
                  if (inner.hasDetail !== true) {
                    const one = document.createElement('div'); one.className = 'trow'
                    const l = document.createElement('span'); l.className = 'tl'
                    l.textContent = wsRowToolLabel(inner, state) + (inner.error === true ? wsText('wsToolFailedSuffix') : '')
                    one.appendChild(l)
                    if (typeof inner.detail === 'string' && inner.detail !== '') {
                      const d = document.createElement('span'); d.className = 'tt'; d.textContent = inner.detail; d.title = inner.detail
                      one.appendChild(d)
                    }
                    wrap.appendChild(one)
                    continue
                  }
                  const ikey = wsFoldKey(inner)
                  const iopen = openedRows.has(ikey)
                  const one = document.createElement('div'); one.className = 'trow exp' + (inner.error === true ? ' err' : '')
                  const chv2 = document.createElement('span'); chv2.className = 'chv'; chv2.textContent = iopen ? '▾' : '▸'
                  one.appendChild(chv2)
                  const l = document.createElement('span'); l.className = 'tl'
                  l.textContent = inner.text + (inner.error === true ? wsText('wsToolFailedSuffix') : '')
                  one.appendChild(l)
                  if (typeof inner.detail === 'string' && inner.detail !== '') {
                    const d = document.createElement('span'); d.className = 'tt'; d.textContent = inner.detail; d.title = inner.detail
                    one.appendChild(d)
                  }
                  wrap.appendChild(one)
                  one.addEventListener('click', () => {
                    if (openedRows.has(ikey)) openedRows.delete(ikey)
                    else { openedRows.add(ikey); wsLoadDetail(ikey) }
                    renderConvo(false)
                  })
                  if (iopen) wrap.appendChild(wsDetailBox(inner))
                }
                convoBox.appendChild(wrap)
              }
            }
          }
          continue
        }
        // 回合结局行（2026-10-14 审查 P1-4）：错误正文与错误码由后端带给前端
        // （graph.js 的 turnend 行），这里画成一行红字 —— 官方是整块 TurnErrorItem，
        // 我们抄它的数据、不抄那一整套样式。画在对话流里而不是只留在指标格里，
        // 是因为用户报的障是「罢工没人察觉」：他要在他盯着这个人干活的地方看到。
        if (row.kind === 'turnend') {
          // 独立成块而**不套 .trow**：.trow 是 display:flex 且 .tl 是 flex:none，
          // 一行长错误正文（真机那种带中文与括号的 QUOTA_EXCEEDED 文案）会横向溢出。
          // 句子在这里按当前语言拼（后端只给 reason/message/code 三个事实字段）；
          // message 与 code 原样透出不翻译 —— 那是宿主与 provider 的原文，
          // 用户拿它去搜、去比对日志，翻了就对不上号。
          const lead = row.reason === 'max-tokens' ? wsText('wsTurnMaxTokens')
            : (row.reason === 'interrupted' || row.reason === 'cancelled') ? wsText('wsTurnInterrupted')
              : wsText('wsTurnError', { reason: String(row.reason ?? '') })
          const tail = [row.message, row.code].filter((part) => typeof part === 'string' && part !== '').join(' · ')
          const line = document.createElement('div')
          line.className = 'turnend' + (row.error === true ? ' err' : '')
          line.textContent = tail === '' ? lead : lead + '：' + tail
          convoBox.appendChild(line)
          continue
        }

        // 图片行（用户 2026-10-10：「图片无法正常渲染！」→ 后接「显示的图片可以小一点，
        // 这个太大了！！」）：
        //   * 字节**按需**拉取（team-image → base64），缓存到 state.imgCache，
        //     轮询重渲染时不重复请求；
        //   * ⚠️ **绝不**把原图 width/height 写成 <img> 的属性 ——
        //     那样会覆盖 CSS 的 max-width/max-height，一张 2419x1733 的截图会撑满整屏
        //     （用户截图里的「巨大红框」就是这么来的，红线是 .failed 的边框）。
        //     尺寸完全交给 CSS（见 .msgimg 的 max-width/max-height），
        //     原图尺寸只放进 title 供悬停查看。
        if (row.kind === 'image') {
          const wrap = document.createElement('div')
          wrap.className = 'imgrow' + (row.owner === 'user' ? ' mine' : '')
          const img = document.createElement('img')
          img.className = 'msgimg'
          img.alt = row.text !== '' ? row.text : wsText('wsImage')
          if (row.width > 0 && row.height > 0) img.title = `${row.text !== '' ? row.text + ' · ' : ''}${row.width}×${row.height}`
          else if (row.text !== '') img.title = row.text
          const src = state.imgCache?.get(row.attachmentId)
          if (src !== undefined) {
            img.src = src
          } else {
            img.classList.add('loading')
            void (async () => {
              const r = await apiCall('team-image', {
                sessionId: state.sessionId, targetId: node.id, attachmentId: row.attachmentId,
              })
              if (state.drawerToken !== token) return
              if (r.ok === true && typeof r.data === 'string' && r.data !== '') {
                const mt = typeof r.mediaType === 'string' && r.mediaType !== '' ? r.mediaType : 'image/png'
                const url = 'data:' + mt + ';base64,' + r.data
                if (state.imgCache === undefined) state.imgCache = new Map()
                state.imgCache.set(row.attachmentId, url)
                img.src = url
                img.classList.remove('loading')
              } else {
                // 失败时**显示原因**，而不是一个空红框（用户截图里那种「只有文件名 + 红边」
                // 让人完全不知道发生了什么）。
                img.classList.remove('loading')
                img.classList.add('failed')
                img.removeAttribute('src')
                const why = document.createElement('div')
                why.className = 'imgwhy'
                why.textContent = wsText('wsImageFailed', { message: String(r.error ?? '') })
                wrap.appendChild(why)
              }
            })()
          }
          // 点击看原图（与官方「查看原图」同义）。
          img.addEventListener('click', () => { if (img.src !== '') window.open(img.src, '_blank') })
          wrap.appendChild(img)
          if (row.text !== '') {
            const cap = document.createElement('div'); cap.className = 'imgcap'; cap.textContent = row.text
            wrap.appendChild(cap)
          }
          convoBox.appendChild(wrap)
          continue
        }
        const turn = document.createElement('div'); turn.className = 'tr' + (row.kind === 'user' ? ' mine' : '')
        // 官方 MessageItem 只给**用户消息**渲染气泡行（.userRow/.bubble），助手正文
        // **没有角色标签**、直接铺 markdown（官方 CSS 模块里根本没有 assistantRow 类）。
        // 所以这里只对非用户行加 who 标签（团队/系统消息需要说明来源），
        // 助手与用户都不加 —— 与官方一致。
        //
        // ── 思考行 ──────────────────────────────────────────────────────────────
        // 口径与官方一致（dsh-client-ui-chat 的 ReasoningRow：「render one assistant
        // reasoning block **collapsed** until the reader opens it」）：
        //   * 流式中的思考（live）与「被中止、只剩思考」的回合（collapsed !== true）
        //     **直接摊开** —— 前者是用户要的实时思考，后者是唯一内容，折叠就等于没有；
        //   * 有正文的回合（collapsed === true）折成一行「思考过程」，点开才展开。
        //     这一步不能省：思考实时冒出来之后，如果结算时把它整块丢掉（旧口径），
        //     用户会看到「刚出现的思考凭空消失」；如果永远摊开，3.7 万字的内部推理
        //     又会把正文挤出屏幕（2026-10-10 就是那次的报障）。
        // 折叠时正文不进 DOM，只留那一行标题（下面 thinkHidden 决定）。
        let thinkHidden = false
        if (row.reasoning === true) {
          thinkIndex += 1
          // 展开状态的存在键：优先 (turn, step)。老日志可能没有这两个字段（那时宿主
          // 还不带），退回「本帧里的第几条思考行」而不是让它们共用一个键 ——
          // 否则展开一条会把所有思考一起展开。
          const thinkKey = (row.turn !== undefined && row.step !== undefined)
            ? row.turn + ':' + row.step
            : 'i:' + (thinkIndex - 1)
          const open = row.collapsed !== true || expandedThinking.has(thinkKey)
          thinkHidden = row.collapsed === true && !open
          turn.classList.add('think')
          const tag = document.createElement('button')
          tag.type = 'button'; tag.className = 'who qh'
          // 四种措辞对应四种事实（别把正在打的字说成已经结束）：
          //   * live —— 思考正在流式进来；
          //   * 折叠未展开 —— 一行「思考过程」，点它展开（官方 ReasoningRow 同语义）；
          //   * 折叠已展开 —— 提示可以再点一下收回去；
          //   * 不折叠（被中止、只有思考）—— 它就是全部内容，如实标注。
          if (row.collapsed === true) {
            tag.textContent = (open ? '▾ ' : '▸ ') + wsText('wsThinking')
            tag.addEventListener('click', () => {
              if (open) expandedThinking.delete(thinkKey); else expandedThinking.add(thinkKey)
              renderConvo(false)
            })
          } else {
            tag.textContent = row.live === true ? wsText('wsLiveThinking') : wsText('wsReasoningNote')
          }
          turn.appendChild(tag)
        }
        const msg = document.createElement('div'); msg.className = 'md'
        // ── markdown 分支的适用面（2026-10-11 用户报「弹窗乱码」的根因）────────────
        // team 行 = 队员的 report_result 结构化报告，正文**就是 markdown**
        // （实测 session-0000100b seq=66：`## 3) 抽查复核`、`**P2**`、`` `dev/...` ``）。
        // 旧写法只给 assistant 行走 wsMarkdown，team 行 textContent 直出 ⇒
        // `##`、`**`、反引号全部裸显 —— 用户看到的「乱码」就是它。
        // notice 行同源（subagent-settled 通知也可能带 markdown 片段），一并修。
        // system 行保持 textContent：那是框架注入的说明文字，不是 markdown。
        const md = row.kind === 'assistant' || row.kind === 'team' || row.kind === 'notice'
        // ── 流式期间也走 markdown（2026-10-14 纠正）────────────────────────────
        // 这里原来写着「官方界面也是这个分工：流式期间是纯文本增量」，并用它当不修的理由。
        // **那句依据是错的**，逐字读过官方实现后订正：
        //   * dsh-client-ui-primitives/lib/index.js 的 MarkdownText：
        //     `({ text, streaming = false, … })` → streaming 时用 `new StreamingRenderer(labels)
        //      .render(text)`，注释原文「streaming parses incrementally across chunks and
        //      highlights fences as they grow」；
        //   * 官方正文与思考都带着它：chat-client.js:5822 `streaming: running`（ReasoningRow
        //     展开体）、:5911/:6005 同款（文本块 streaming: data.status === "running"）。
        // 成本也不是不修的理由：renderConvo 每帧本来就**重建整个对话区**
        // （下面 `convoBox.textContent = ''`），所有已结算行的 markdown 每帧都在重解析，
        // 多这一条 live 行的边际成本是零。
        // 半截语法的表现也与官方一致：未闭合的 `**` 保持裸符号直到闭合，
        // 未闭合的围栏被当代码块一直吃到行尾（wsMarkdown 的围栏分支就是这么写的），
        // 结算后不重排 —— 这正是用户要的「和官方一样」。
        if (md) msg.innerHTML = wsMarkdown(row.text)
        else msg.textContent = row.text
        if (row.kind !== 'assistant' && row.kind !== 'user') {
          const who = document.createElement('div'); who.className = 'who'
          // team 行带结构化的 senderName（graph.js 不再把 sender 拼进正文）：
          // 显示「队员名 · 类别」而不是泛泛的「团队消息」—— 用户能一眼看出是谁交付的。
          who.textContent = row.kind === 'team' && typeof row.senderName === 'string' && row.senderName !== ''
            ? `${row.senderName} · ${whoOf(row.kind)}`
            : whoOf(row.kind)
          turn.appendChild(who)
        }
        if (row.reasoning === true) {
          // 折叠态：正文不进 DOM（官方也是「不展开就不占地方」），只留上面那一行。
          if (thinkHidden) { convoBox.appendChild(turn); continue }
        }
        turn.appendChild(msg)
        // ── 正文行的「展开全文」（2026-10-14）──────────────────────────────────
        // 后端 clipLine 把每行截在 2000 码元（LINE_MAX 定义见 lib/graph.js:1313，截断动作在 :2188 的 clipLine），**官方不截**。
        // 实测 session-00001000 的截断面：最长思考 22,814、最长真人输入 12,897、
        // 最长队员汇报 12,815 —— 都以 2,000 码元断尾，而断掉的部分此前永久不可达。
        // 为什么不干脆不截：这些行每 1.2~3 秒随抽屉轮询**整批**过一次 HTTP，
        // 官方拿的是内存里的事件窗口（chat-client.js:5911 MarkdownText），两者成本不同。
        // 所以保留有界 + 给一条**能拿到全文**的路，而不是留着断尾。
        if (row.hasDetail === true && row.live !== true && typeof row.detailKey === 'string') {
          const dkey = wsFoldKey(row)
          const dopen = openedRows.has(dkey)
          const toggle = document.createElement('button')
          toggle.type = 'button'; toggle.className = 'who qh'
          toggle.textContent = (dopen ? '▾ ' : '▸ ')
            + wsText(dopen ? 'wsDetailCollapse' : 'wsDetailFull')
          toggle.addEventListener('click', () => {
            if (openedRows.has(dkey)) openedRows.delete(dkey)
            else { openedRows.add(dkey); wsLoadDetail(dkey) }
            renderConvo(false)
          })
          turn.appendChild(toggle)
          if (dopen) turn.appendChild(wsDetailBox(row))
        }
          // ── 逐行「复制 + 时间」（P1-3，2026-10-15）─────────────────────────────
        const actions = wsRowActionsFor(row)
        if (actions !== null) turn.appendChild(actions)
        convoBox.appendChild(turn)
      }
      // 「本步还在生成」：没有覆盖层时（拿不到桥）这是唯一的诚实标注 —— 官方界面
      // 此时在流式打字，持久日志里却什么都没有。有覆盖层时正文自己在长，不需要这句。
      if (durablePending && (liveRows.length === 0 || !hostLiveCapable)) {
        const pend = document.createElement('div')
        pend.className = 'pendingrow'
        pend.textContent = wsText('wsPendingStep')
        convoBox.appendChild(pend)
      }
      // 打开即看到**最新**内容；之后只在用户本来贴着底部时才自动跟随。
      if (wasAtBottom) convoBox.scrollTop = convoBox.scrollHeight
      const changed = convoBox.textContent !== prevText
      if (!changed && wasAtBottom) convoBox.scrollTop = convoBox.scrollHeight
      return changed
    }

    /**
     * 拉一次**持久**对话（宿主半，读会话日志）。覆盖层不替代它 —— 已结算的正文、工具行、
     * 团队消息、图片行都仍由宿主折叠（口径与官方一致，且带成串工具行的折叠规则）。
     * @param {boolean} first - 是否首次渲染。
     * @returns {Promise<boolean>} 本轮内容是否变化。
     */
    const loadConvo = async (first) => {
      const result = await apiCall('team-conversation', { sessionId: state.sessionId, targetId: node.id, limit: 80 })
      if (state.drawerToken !== token) return false
      if (result.ok !== true) {
        // 已经有画面时**不清空**：一次补拉失败不该把用户正在看的内容抹掉，
        // 只在还没拿到过任何数据时把错误显示出来。
        if (durableRows === null) {
          convoBox.textContent = wsText('wsDrawerConvoFailed', { message: String(result.error ?? '') })
          convoBox.className = 'cv empty'
        }
        return false
      }
      durableRows = Array.isArray(result.rows) ? result.rows : []
      durablePending = result.pending === true
      durableNote = typeof result.note === 'string' ? result.note : ''
      // 只认「确实带了 settledSteps 数组」这一次回执；缺字段 = 宿主半还是旧的（没重启）。
      if (Array.isArray(result.settledSteps)) hostLiveCapable = true
      settledSteps = new Set(Array.isArray(result.settledSteps) ? result.settledSteps : [])
      return renderConvo(first === true)
    }
    // 首帧回来后择机启动兜底轮询（kickoffDrawer 在下面定义；这里是异步回调，
    // 执行时它已经定义好了）。失败也要启动，否则整条链永远不会起来。
    void loadConvo(true).then(() => { if (state.drawerToken === token) kickoffDrawer() },
      () => { if (state.drawerToken === token) kickoffDrawer() })

    // ── 流式覆盖层的接线（问题 2 的正身）────────────────────────────────────
    // retain 目标会话 → 订阅官方那份 eventSource → 每个 token 折成覆盖层行。
    // 三条纪律：
    //   ① 订阅回调里**绝不**做网络请求（它是同步 publish，官方 :1206-1209 每个 token
    //      都叫一次）；要补拉持久行就起一个防抖计时器，把同一批 token 合成一次。
    //   ② 一切回调都要过 drawerToken 闸门：用户可能已经关掉浮窗或点了别的队员。
    //   ③ 关窗/换人必须 release retain —— 那是引用计数，漏放就是永久泄漏一格
    //      （dsh-api-session-controller/lib/client.js:3420-3434：计数归零才 retireScope）。
    const live = bridgeRetain(node.id)
    // 停止按钮的判据要**官方面上的 running**，不是画布节点的状态：
    // buildGraph 里 Lead 的 status 恒 'active'、wsStateOf 又把 lead 一律画成 'running'
    // （那是画布的显示约定），拿它当「能不能停」会把没在跑的 Lead 也说成在跑。
    // 真值在 session 那层：dsh-api-session-controller/lib/client.js:1965-1974 handleRunning
    // 写 this.running，:2278 buildSnapshot 把它带进快照 —— 这就是官方输入框看的那一位。
    state.drawerSession = live === null ? null : (live.session ?? null)
    // 开窗时立刻同步一次（2026-10-14 探针抓到）：按钮建出来默认 display:none，
    // 而「该不该画」原本只在 wsApplyGraph 的刷新轮里决定 —— 用户点开的这一刻
    // 正好在两轮之间，于是**在跑的队员也没有停止键**，要等下一轮才冒出来。
    wsSyncDrawerStop(state.drawerStop, state.drawerSession)
    if (live !== null) {
      let queued = false
      const onFeed = () => {
        if (state.drawerToken !== token) return
        if (queued) return
        queued = true
        // 合并到一帧：流式期间每帧最多折一次覆盖层（一帧可能到十几个 token），
        // 比每个 token 重画一遍 DOM 便宜得多，观感与官方一致。
        const schedule = typeof requestAnimationFrame === 'function'
          ? (fn) => requestAnimationFrame(fn) : (fn) => setTimeout(fn, 16)
        schedule(() => {
          queued = false
          if (state.drawerToken !== token) return
          let snapshot
          try { snapshot = live.eventSource.getSnapshot() } catch { return }
          const entries = snapshot === undefined || snapshot === null ? null : snapshot.entries
          liveRows = wsFoldLive(Array.isArray(entries) ? entries : [], state.toolLabels)
          renderConvo(false)
          // 持久窗口里出现了新的 seq ⇒ 有事件落盘了 ⇒ 找宿主补一次持久行。
          // 这是「实时」的另一半：思考/工具在覆盖层里立刻可见，结算之后由宿主的
          // 正式行接管（覆盖层那一份按 callId / (turn,step) 收回去）。
          let maxSeq = -1
          if (Array.isArray(entries)) {
            for (const entry of entries) {
              const seq = entry === null || typeof entry !== 'object' ? NaN : Number(entry.event?.seq)
              if (Number.isFinite(seq) && entry.type !== 'transient' && seq > maxSeq) maxSeq = seq
            }
          }
          if (maxSeq > lastDurableSeq) {
            if (lastDurableSeq < 0) lastDurableSeq = maxSeq
            else {
              lastDurableSeq = maxSeq
              if (durableReloadTimer !== 0) clearTimeout(durableReloadTimer)
              // 300ms 防抖：一步结算会连着来好几条事件（assistant/message、tool/call、
              // step/end…），合成一次补拉而不是三次。计时器同时挂到 state.drawerLive，
              // 关窗时由 wsCloseDrawer 清掉（不挂的话关窗后还会打一次宿主接口）。
              durableReloadTimer = setTimeout(() => {
                durableReloadTimer = 0
                if (state.drawerLive !== undefined) state.drawerLive.reloadTimer = 0
                if (state.drawerToken !== token) return
                void loadConvo(false)
              }, 300)
              if (state.drawerLive !== undefined) state.drawerLive.reloadTimer = durableReloadTimer
            }
          }
        })
      }
      let unsubscribe = () => {}
      try { unsubscribe = live.eventSource.subscribe(onFeed) } catch { unsubscribe = () => {} }
      // reloadTimer 先占位：上面的 onFeed() 首帧就可能写它。
      state.drawerLive = {
        hasFeed: true,
        release: live.release,
        unsubscribe: () => { try { unsubscribe() } catch { /* 订阅已经掉了 */ } },
        reloadTimer: 0,
      }
      // 第一次主动喂一次：retain 时窗口可能已经开着（用户是在跑到一半才进来的），
      // 不等下一个 token 才画 —— 否则要干等到对方下一次 publish 才有画面。
      onFeed()
    }

    // ── 弹窗对话的**自适应轮询**（用户 2026-10-10：「无法实时同步官方界面的信息」）──
    // 与画布同一套思路（见 openWorkspace 末尾的 schedule）：
    //   * 有变化 → 1.2 秒一轮，队员干活时弹窗自己长出新内容；
    //   * 稳定了 → 3 秒一轮，省 CPU；
    //   * 页面不可见 → 跳过这一轮；
    //   * 浮窗被关掉/切到别的队员（drawerToken 变了）→ 链自然终止。
    // ⚠️ 续期不能依赖 loadConvo 的返回值：它抛错时也要继续排下一轮，
    //    否则链会永久死亡（画布那边踩过同一个坑，注释见 openWorkspace）。
    //
    // ⚠️ 2026-10-10 修一个自己引入的时序 bug（实测：模拟队员产出后 3 秒内没更新、
    //    要等 6 秒才更新）。原写法是「先按**上一轮**的 drawerChanged 排好 timer，
    //    再在 loadConvo 里更新那个标志」—— 标志总是慢一拍，于是「有变化」时
    //    仍在用慢档，用户感觉「不实时」。现在改成**先加载、再据本轮结果排下一轮**。
    //
    // 有了覆盖层之后这条链的角色变了：它不再是「实时的来源」（那是 eventSource 订阅），
    // 而是**兜底** —— 覆盖层在跑时走慢档（少打宿主接口），拿不到桥时退回快档盯着日志。
    const DRAWER_FAST_MS = 1200
    const DRAWER_SLOW_MS = 3000
    // 覆盖层在跑时的**兜底**档位：实时的来源已经是 eventSource 订阅（每个 token 同步
    // publish），这条链只剩「万一订阅漏了什么」的保险作用，10 秒一轮足够，
    // 不必再按秒打宿主接口（宿主每次都要重读一遍会话日志尾部，不是免费的）。
    const DRAWER_LIVE_MS = 10000
    const scheduleDrawer = (delay) => {
      state.drawerTimer = window.setTimeout(() => {
        state.drawerTimer = 0
        if (state.drawerToken !== token) return
        if (typeof document !== 'undefined' && document.hidden === true) { scheduleDrawer(DRAWER_SLOW_MS); return }
        const next = (changed) => {
          if (state.drawerToken !== token) return
          // 只有覆盖层**真的在画**时才降档；宿主半不认协议时覆盖层被 allRows 丢掉，
          // 这时实时性还得靠轮询，不能降到 10 秒（否则比修复前更慢）。
          if (state.drawerLive !== undefined && state.drawerLive.hasFeed === true && hostLiveCapable) {
            scheduleDrawer(DRAWER_LIVE_MS); return
          }
          // 本轮有变化 → 下一轮用快档（队员正在连续产出时能跟上）。
          scheduleDrawer(changed === true ? DRAWER_FAST_MS : DRAWER_SLOW_MS)
        }
        try {
          // 对话与提问盒同节拍刷新（2026-10-13：提问盒原来只读一次，见 loadQuestions 注释）。
          const pendingC = loadConvo(false)
          const pendingQ = loadQuestions(false)
          Promise.all([pendingC, pendingQ]).then(
            (list) => next(list.some((v) => v === true)),
            () => next(false),
          )
        } catch {
          next(false)
        }
      }, delay)
    }
    // 首档**等第一次 loadConvo 回来再定**：那时才知道宿主半认不认这套协议
    // （hostLiveCapable），也只有那时才知道覆盖层到底会不会画。
    // 在同步位置就定档位会多打一次无用的 1.2 秒请求（2026-10-13 浏览器探针实测到的），
    // 而更糟的是：宿主不认协议时覆盖层被丢掉，实时性还得靠轮询，绝不能降慢档。
    //
    // ⚠️ 这条链**只有一个启动点**：上面 `void loadConvo(true).then(kickoffDrawer, kickoffDrawer)`。
    // 这里再调一次就会并存两条独立计时链（scheduleDrawer 把 state.drawerTimer 覆盖成
    // 第二家的 handle，关窗时 clearTimeout 只能停掉一条 —— 另一条继续按秒打宿主接口）。
    const kickoffDrawer = () => {
      const liveFeed = state.drawerLive !== undefined && state.drawerLive.hasFeed === true
      scheduleDrawer(liveFeed && hostLiveCapable ? DRAWER_LIVE_MS : DRAWER_FAST_MS)
    }



    // ④ 待回答的提问（用户 2026-10-08：「他提问的时候我在工作区看不到也收不到任何的提问信息」）。
    //    数据来自会话日志里的 ask_user_question（不是官方投影——那个默认模式下恒为空）。
    //    放在**输入框上方**：提问是要用户回答的，必须紧贴回复入口。
    const qBox = document.createElement('div'); qBox.className = 'qbox'
    body.appendChild(qBox)

    // ⑤ 聊天输入框（用户：「我需要这样一个聊天框这个窗口回答问题，以及向 lead 提问以及发送下一步指令」）。
    //    + 图片上传（用户 2026-10-10：「要支持直接在弹窗上传图片，和官方的对话页面应当一致」）。
    const composer = document.createElement('div'); composer.className = 'composer'
    const input = document.createElement('textarea')
    input.className = 'cin'; input.rows = 1
    input.placeholder = wsText('wsSendPlaceholder', { name: node.name })
    // 附件按钮：一个隐藏的 file input + 一个图标按钮（与官方「添加图片」同义）。
    const fileInput = document.createElement('input')
    fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.multiple = true
    fileInput.className = 'filein'
    const addBtn = document.createElement('button')
    addBtn.className = 'ws-btn addimg'; addBtn.type = 'button'
    addBtn.textContent = '＋' + wsText('wsImageUpload')
    addBtn.title = wsText('wsImageUpload')
    const sendBtn = document.createElement('button')
    sendBtn.className = 'ws-btn primary send'; sendBtn.textContent = wsText('wsSend')
    // 停止生成（2026-10-14 审查 P1-1）。官方在 running 时把发送键位让给一个方块停止按钮
    // （dsh-client-ui-conversation/lib/client.js:17402-17410 + locale :14487「停止生成」），
    // 点它 = scopedConversation(sessions, sessionId).cancel()（同文件 :18022-18024），
    // 而 cancel() 就在**我们已经 retain 的那个 session** 上：Lead 走 remote.session.cancel，
    // 队员走 remote.subagents.interruptByParent(child, parent, 'continuable')
    // （dsh-api-session-controller/lib/client.js:1804-1815）—— 与官方逐字同一条通道，
    // 不是插件自己另发明的「停」。
    const stopBtn = document.createElement('button')
    stopBtn.className = 'ws-btn stop'; stopBtn.type = 'button'
    stopBtn.textContent = wsText('wsStopRun')
    // 默认不画：没在跑就别摆一个按了没用的按钮（可用性由 wsSyncDrawerStop 每轮同步）。
    stopBtn.style.display = 'none'
    stopBtn.addEventListener('click', () => {
      const session = state.drawerSession
      if (session === null || session === undefined || typeof session.cancel !== 'function') {
        // 拿不到桥（宿主版本不对 / 该会话没有活体对象层）时**如实说**，不静默。
        sendNote.className = 'sendnote err'
        sendNote.textContent = wsText('wsStopNoBridge')
        return
      }
      stopBtn.disabled = true
      // 官方的 stop 就是 fire-and-forget（dsh-client-ui-conversation/lib/client.js:18022-18024
      // `scopedConversation(…).cancel().catch((_error) => {})`），但那边失败落进
      // promptError 由官方界面自己显示；浮窗没有那个显示位，所以这里**自己**把失败说出来。
      // cancel() 也可能同步抛（scopedSession 解析不到 binding 就 throw，同文件 :3675-3679），
      // 所以调用包在 try 里，别让它变成未捕获异常。
      void (async () => {
        try {
          return { ok: true, result: await session.cancel() }
        } catch (error) {
          return { ok: false, error }
        }
      })().then((settled) => {
        if (state.drawerToken !== token) return
        stopBtn.disabled = false
        if (settled.ok !== true) {
          sendNote.className = 'sendnote err'
          sendNote.textContent = wsText('wsStopFailed', {
            message: String((settled.error && settled.error.message) || settled.error || ''),
          })
          return
        }
        // 官方 cancel() 不抛错而是把失败写进返回值（dsh-api-session-controller/lib/client.js
        // :1807-1813：!result.ok 时挂 promptError 并 notify），所以这里也要读它。
        const result = settled.result
        if (result !== undefined && result !== null && result.ok === false) {
          sendNote.className = 'sendnote err'
          sendNote.textContent = wsText('wsStopFailed', {
            message: String(result.error?.message ?? result.error?.code ?? result.error ?? ''),
          })
          return
        }
        sendNote.className = 'sendnote'
        sendNote.textContent = wsText('wsStopSent')
        // running 位要等宿主的 turn/end 翻过来才变，先补拉一次对话，别让用户干等一轮轮询。
        void loadConvo(false)
      })
    })
    const sendNote = document.createElement('div'); sendNote.className = 'sendnote'
    // 待发送图片的缩略图条（与官方「待发送图片」一致：能看见、能移除）。
    const pending = document.createElement('div'); pending.className = 'pending'
    // 「发送」与「停止」同在第三列的 acts 容器里（判据见 CSS 那段注释：
    // 单开一条 grid 轨道会多一个 gap，把输入框挤窄 8px）。
    const acts = document.createElement('div'); acts.className = 'acts'
    acts.append(sendBtn, stopBtn)
    composer.append(input, addBtn, acts, pending, sendNote, fileInput)
    // 登记给 wsApplyGraph：图每刷新一轮，就按最新状态决定这颗按钮画不画、能不能按。
    state.drawerStop = stopBtn
    body.appendChild(composer)
    /** 待发送图片：`[{data, mediaType, name, url}]`。 */
    let pendingImages = []
    const MAX_PENDING = 8
    const renderPending = () => {
      pending.textContent = ''
      pending.classList.toggle('has', pendingImages.length > 0)
      pendingImages.forEach((item, index) => {
        const chip = document.createElement('div'); chip.className = 'pchip'
        const thumb = document.createElement('img'); thumb.src = item.url; thumb.alt = item.name
        const del = document.createElement('button')
        del.type = 'button'; del.className = 'pdel'; del.textContent = '×'
        del.title = wsText('wsImageRemove')
        del.addEventListener('click', () => { pendingImages.splice(index, 1); renderPending() })
        chip.append(thumb, del)
        pending.appendChild(chip)
      })
    }
    /** File → canonical base64（官方 admission 要求 decode 后再 encode 与原文完全一致）。 */
    const fileToImage = (file) => new Promise((resolve) => {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { resolve({ ok: false, error: wsText('wsImageUnsupported') }); return }
      if (file.size > 8 * 1024 * 1024) { resolve({ ok: false, error: wsText('wsImageTooBig', { limit: '8MB' }) }); return }
      const reader = new FileReader()
      reader.onerror = () => resolve({ ok: false, error: wsText('wsImageReadFailed') })
      reader.onload = () => {
        const url = String(reader.result ?? '')
        const comma = url.indexOf(',')
        if (comma < 0) { resolve({ ok: false, error: wsText('wsImageReadFailed') }); return }
        // FileReader 给的就是标准 base64（与 Buffer 的 canonical 形式一致）。
        resolve({ ok: true, data: url.slice(comma + 1), mediaType: file.type, name: file.name, url })
      }
      reader.readAsDataURL(file)
    })
    addBtn.addEventListener('click', () => fileInput.click())
    fileInput.addEventListener('change', () => {
      void (async () => {
        const files = [...(fileInput.files ?? [])]
        fileInput.value = ''
        for (const f of files) {
          if (pendingImages.length >= MAX_PENDING) { sendNote.className = 'sendnote err'; sendNote.textContent = wsText('wsImageTooBig', { limit: wsText('wsImageCountUnit', { n: String(MAX_PENDING) }) }); break }
          const r = await fileToImage(f)
          if (r.ok !== true) { sendNote.className = 'sendnote err'; sendNote.textContent = String(r.error ?? '') ; continue }
          pendingImages.push({ data: r.data, mediaType: r.mediaType, name: r.name, url: r.url })
        }
        renderPending()
      })()
    })
    // 输入框自增高（1~6 行），Enter 发送 / Shift+Enter 换行。
    const autoGrow = () => {
      input.style.height = 'auto'
      input.style.height = Math.min(120, Math.max(30, input.scrollHeight)) + 'px'
    }
    input.addEventListener('input', autoGrow)
    const doSend = async () => {
      const text = input.value.trim()
      // 图片可单独成消息（官方 hasPromptContent 允许「只有图片」）。
      if ((text === '' && pendingImages.length === 0) || sendBtn.disabled) return
      sendBtn.disabled = true
      sendNote.className = 'sendnote'
      sendNote.textContent = pendingImages.length > 0 ? wsText('wsImageSending') : wsText('wsSending')
      const images = pendingImages.map((p) => ({ data: p.data, mediaType: p.mediaType, name: p.name }))
      const result = images.length > 0
        ? await apiCall('team-send-images', { sessionId: state.sessionId, targetId: node.id, text, images })
        : await apiCall('team-send', { sessionId: state.sessionId, targetId: node.id, text })
      if (state.drawerToken !== token) return
      sendBtn.disabled = false
      if (result.ok !== true) {
        sendNote.className = 'sendnote err'
        sendNote.textContent = wsText('wsSendFailed', { message: String(result.error ?? '') })
        return
      }
      input.value = ''
      pendingImages = []
      renderPending()
      autoGrow()
      sendNote.textContent = wsText('wsSent')
      window.setTimeout(() => { if (sendNote.textContent === wsText('wsSent')) sendNote.textContent = '' }, 2000)
      // 立刻把这条消息画进对话（不等下一轮轮询），用户才有「发出去了」的确定感。
      const turn = document.createElement('div'); turn.className = 'tr mine'
      const who = document.createElement('div'); who.className = 'who'; who.textContent = wsText('wsWhoMe')
      turn.appendChild(who)
      if (text !== '') {
        const msg = document.createElement('div'); msg.className = 'msg'; msg.textContent = text
        turn.appendChild(msg)
      }
      convoBox.appendChild(turn)
      convoBox.scrollTop = convoBox.scrollHeight
    }
    sendBtn.addEventListener('click', () => { void doSend() })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.shiftKey !== true) {
        event.preventDefault()
        void doSend()
      }
    })

    // 提问卡（用户 2026-10-09 两条硬要求）：
    //   ① 「回答问题不是回复型的是选择型的，不会打断对话」→ 选项是**单选/多选控件**，
    //      点选后按「提交」一次性交整卡（复刻官方 composer 的 choose + submitDrafts，
    //      dsh-client-ui-user-questions/lib/client.js:1087-1104），不再往聊天框灌文本；
    //   ② 「我已经回答过了，为什么还能在弹窗还能回答？设计问题非常的大！！」→
    //      后端 extractQuestions 现在配对 tool/result（官方投影 settled 的同款判据，
    //      dsh-user-questions/lib/types/projection.js:223-244）：有答案批次的卡渲染成
    //      **只读**（显示当时选了什么），永远不再可点。
    // 一次 ask_user_question 调用 = 一张卡（卡内可含多题），按 callId 分组。
    //
    // ⚠️ 2026-10-13 修「弹窗与官方聊天框不同步」的内容半边：提问盒以前只在开窗时读
    // **一次**、之后永不刷新 —— 队员在窗开着的时候新提的问题，用户永远看不到
    // （官方聊天框是推送，立刻就有；截图 224218 的「待你回答（0 条）」就是这种陈旧态）。
    // 现在它挂进抽屉轮询链，与对话同一节拍；用签名（callId|id|answered）判变化，
    // 没变化就不重建 —— 用户正在选的选项草稿与折叠开关都不会被打断。
    const qCards = document.createElement('div')
    let qHead = null
    let qSig = null
    let qPrevOpen = 0
    /**
     * 本次弹窗里「已经通过官方卡回答掉」的提问：callId → 答案摘要。
     *
     * 为什么需要这份本地记录：走官方卡 answer() 之后，答案进的是**那次工具调用的 result**，
     * 而它要等整步结算才落进会话日志（team-questions 读的就是这份日志）。在那之前宿主
     * 仍会把这张卡报成「未回答」——若照它重画，用户会看到刚答完的卡又变回可点，
     * 正是用户 2026-10-09 骂过的「我已经回答过了，为什么还能回答？」。
     * 所以：本地记一笔，签名里带上它，宿主追上之后自然一致（读同一份答案）。
     */
    const cardAnswered = new Map()
    /**
     * 把一张提问卡就地改成「已回答」的只读态（与宿主报来 answered 时的渲染同一套）。
     * @param {HTMLElement} cardEl - 卡容器。
     * @param {Array} items - 该卡的题目列表。
     * @param {Array<string>} texts - 每题的答案文本（与 items 同序）。
     * @param {string} label - 标题行的措辞。
     * @param {HTMLElement} [keep] - 重建后要**留在卡里**的旧节点（提交后那行说明）。
     */
    const markCardAnswered = (cardEl, items, texts, label, keep) => {
      cardEl.className = 'qcard done'
      // ⚠️ textContent='' 会把脚部（提交按钮 + 那行说明 note）一起摘掉 ——
      // 之前提交成功后 note.textContent 写进了**已脱离 DOM** 的节点，用户根本看不到
      // 「已通过官方提问卡回答」这句实话（探针 __Note() 返回 '(no note)' 抓到的）。
      // 所以要么别写，要么把它接回来：这里选接回来（keep）。
      cardEl.textContent = ''
      const hd = document.createElement('div'); hd.className = 'qhd'; hd.textContent = label
      cardEl.appendChild(hd)
      items.forEach((q, i) => {
        const ans = document.createElement('div'); ans.className = 'qans'
        const b = document.createElement('b'); b.textContent = (q.header !== '' ? q.header + '：' : '') + q.question
        ans.appendChild(b)
        ans.appendChild(document.createTextNode(' ' + (texts[i] !== undefined && texts[i] !== '' ? texts[i] : wsText('wsQAnswerBlank'))))
        cardEl.appendChild(ans)
      })
      if (keep !== undefined && keep !== null) cardEl.appendChild(keep)
    }
    /**
     * 一题的 detail 块（计划审批的**整份计划**就在这个字段里）。
     *
     * 官方对每一题都渲它，且渲在**选项之上**
     * （dsh-client-ui-user-questions/lib/client.js:1077-1082，MarkdownText）。
     * 顺序照它排：题头 → 问题 → detail → 选项。缺了这一句，计划审批就退化成
     * 「两个按钮 + 看不到要批什么」（2026-10-14 审查 P0-3）。
     * @param {object} q - 宿主给的一题（extractQuestions 的行）。
     * @returns {HTMLElement|null}
     */
    const wsQuestionDetail = (q) => {
      if (typeof q.detail !== 'string' || q.detail === '') return null
      const box = document.createElement('div')
      box.className = 'qdetail'
      // markdown 渲染：计划正文就是 markdown（真机实测 session-00001007 seq 453 的
      // arguments.plan 以 '# ' 标题开头 —— 官方 :258 还强制要求 plan 必须带 # 标题）。
      // textContent 直出会满屏裸 ** 和 |，正是 2026-10-11 那次「乱码」报障的同一类。
      const md = document.createElement('div')
      md.className = 'md'
      md.innerHTML = wsMarkdown(q.detail)
      box.appendChild(md)
      if (q.detailTruncated === true) {
        const cap = document.createElement('div')
        cap.className = 'qcap'
        cap.textContent = wsText('wsDetailCapped')
        box.appendChild(cap)
      }
      return box
    }

    const loadQuestions = async (first) => {
      const result = await apiCall('team-questions', { sessionId: state.sessionId, targetId: node.id })
      if (state.drawerToken !== token) return false
      const questions = Array.isArray(result?.questions) ? result.questions : []
      const sig = questions.map((q) => `${q.callId}|${q.id}|${q.answered === true || cardAnswered.has(q.callId) ? 1 : 0}`).join('§')
      if (sig === qSig) return false
      const firstLoad = qSig === null
      qSig = sig
      if (questions.length === 0) {
        if (firstLoad) return false
        // 从「有问题」变回「没问题」：必须清掉旧卡、标题归零 —— 否则又是一个陈旧态
        //（本轮探针 D 抓的：应答后提问消失，卡片却还挂着）。
        qCards.textContent = ''
        if (qHead !== null) qHead.querySelector('h4').textContent = wsText('wsQuestions', { count: '0' })
        qPrevOpen = 0
        return true
      }
      const byCall = new Map()
      for (const q of questions) {
        const k = q.callId !== '' ? q.callId : 't:' + q.time
        const list = byCall.get(k) ?? []
        list.push(q)
        byCall.set(k, list)
      }
      const open = questions.filter((q) => q.answered !== true && !cardAnswered.has(q.callId)).length
      // 标题行可点折叠（用户 2026-10-09：「待你回答（0 条）可以收下去，不要全部展开」）。
      // 默认态：有待答 → 展开（那是需要用户处理的事）；全答完 → 收起（只留一行，
      // 把高度让给对话正文）。**只有首次加载**才自动收起 —— 轮询刷新不抢用户的折叠开关。
      if (qHead === null) {
        qHead = document.createElement('button')
        qHead.type = 'button'; qHead.className = 'qh'
        const title = document.createElement('h4')
        const chev = document.createElement('span'); chev.className = 'chev'; chev.textContent = '▾'
        qHead.append(title, chev)
        qHead.addEventListener('click', () => {
          const folded = qBox.classList.toggle('folded')
          qHead.querySelector('.chev').textContent = folded ? '▸' : '▾'
        })
        qBox.append(qHead, qCards)
      }
      qHead.querySelector('h4').textContent = wsText('wsQuestions', { count: String(open) })
      if (firstLoad && open === 0) {
        qBox.classList.add('folded')
        qHead.querySelector('.chev').textContent = '▸'
      }
      qCards.textContent = ''
      let anyOpen = false
      for (const [callId, items] of byCall) {
        const answeredAll = items.every((q) => q.answered === true) || cardAnswered.has(callId)
        const card = document.createElement('div')
        card.className = 'qcard' + (answeredAll ? ' done' : '')
        if (answeredAll) {
          // 只读回看：每题一行「问题 → 已选答案」（官方 reviewPanel 同语义）。
          const hd = document.createElement('div'); hd.className = 'qhd'; hd.textContent = wsText('wsQAnswered')
          card.appendChild(hd)
          // 本地记过答案就用它（宿主日志可能还没落这一步，q.answer 会是空串）；
          // 宿主追上之后两边本来就是同一份答案。
          const local = cardAnswered.get(callId)
          items.forEach((q, i) => {
            const ans = document.createElement('div'); ans.className = 'qans'
            const b = document.createElement('b'); b.textContent = (q.header !== '' ? q.header + '：' : '') + q.question
            ans.appendChild(b)
            const shown = typeof local === 'string' && local !== ''
              ? (items.length > 1 ? (local.split('；')[i] ?? local) : local)
              : (q.answer !== '' ? q.answer : wsText('wsQAnswerBlank'))
            ans.appendChild(document.createTextNode(' ' + shown))
            card.appendChild(ans)
            const dEl = wsQuestionDetail(q)
            if (dEl !== null) card.appendChild(dEl)
          })
          qCards.appendChild(card)
          continue
        }
        anyOpen = true
        // 可答卡：每题一组选项 + 自定义输入；底部一个提交按钮。
        const drafts = items.map(() => ({ selected: [], custom: '' }))
        const foot = document.createElement('div'); foot.className = 'qfoot'
        const submit = document.createElement('button')
        submit.className = 'ws-btn primary'; submit.textContent = wsText('wsQSubmit')
        submit.disabled = true
        const note = document.createElement('span'); note.className = 'qans'
        // 提交按钮的启用条件：**每题**都选了或填了自定义（官方 submitDrafts 的
        // completed 校验，dsh-client-ui-user-questions/lib/client.js:923-931；宿主
        // userQuestions.answer 也要求批次命名每题恰好一次，dsh-user-questions/lib/index.js:560）。
        const syncSubmit = () => {
          submit.disabled = !drafts.every((d) => d.selected.length > 0 || d.custom.trim() !== '')
        }
        items.forEach((q, qi) => {
          if (q.header !== '') {
            const hd = document.createElement('div'); hd.className = 'qhd'; hd.textContent = q.header
            card.appendChild(hd)
          }
          const qt = document.createElement('div'); qt.className = 'qtext'; qt.textContent = q.question
          card.appendChild(qt)
          const detailEl = wsQuestionDetail(q)
          if (detailEl !== null) card.appendChild(detailEl)
          const ul = document.createElement('div'); ul.className = 'qopts'
          ul.setAttribute('role', q.multi === true ? 'group' : 'radiogroup')
          const buttons = []
          for (let oi = 0; oi < q.options.length; oi += 1) {
            const opt = q.options[oi]
            const row = document.createElement('button'); row.type = 'button'; row.className = 'qopt'
            row.setAttribute('role', q.multi === true ? 'checkbox' : 'radio')
            const num = document.createElement('span'); num.className = 'num'; num.textContent = String(oi + 1)
            const wrap = document.createElement('span')
            const lb = document.createElement('span'); lb.className = 'lb'; lb.textContent = opt.label
            wrap.appendChild(lb)
            if (opt.description !== '') {
              const ds = document.createElement('span'); ds.className = 'ds'; ds.textContent = opt.description
              wrap.appendChild(ds)
            }
            row.append(num, wrap)
            row.addEventListener('click', () => {
              const d = drafts[qi]
              if (q.multi === true) {
                const at = d.selected.indexOf(opt.label)
                if (at >= 0) d.selected.splice(at, 1); else d.selected.push(opt.label)
              } else {
                // 单选：换选即替换（官方 choose 语义）。
                d.selected = d.selected.length === 1 && d.selected[0] === opt.label ? [] : [opt.label]
              }
              buttons.forEach((btn, k) => btn.classList.toggle('sel', d.selected.includes(q.options[k].label)))
              syncSubmit()
            })
            buttons.push(row)
            ul.appendChild(row)
          }
          card.appendChild(ul)
          const custom = document.createElement('input')
          custom.className = 'qcustom'; custom.type = 'text'
          custom.placeholder = wsText('wsQCustom')
          custom.addEventListener('input', () => {
            drafts[qi].custom = custom.value
            // 写了自定义答案就取消选项选中（官方草稿同规则：二选一）。
            if (custom.value.trim() !== '') {
              drafts[qi].selected = []
              buttons.forEach((btn) => btn.classList.remove('sel'))
            }
            syncSubmit()
          })
          card.appendChild(custom)
        })
        submit.addEventListener('click', () => {
          submit.disabled = true
          note.textContent = wsText('wsSending')
          // ⚠️ 答案批次的**形状**就是这次报障的正身，逐字照抄官方 submitDrafts
          // （dsh-client-ui-user-questions/lib/client.js:936-948）：没填自定义时
          // **整个键都不出现**，而不是写 `custom: undefined`。
          //
          // 为什么这么讲究：弹窗调的是官方那张卡的 answer()，而它只是
          // `waterfall.resolve(answer)`（同文件 :396-406 + settlePendingComposer），
          // 于是这个载荷会作为**远程事件的返回值**回传宿主，被
          // dsh-api-gateway/lib/client.js:880 的 isRemoteJsonValue 校验；
          // visitJsonValue 对**嵌套的 undefined** 直接判 false（同文件 :93-96）
          // ⇒ 抛 "Remote event listener result is not lossless JSON data"
          // ⇒ ask_user_question 这个工具调用**当场以 isError 结算**。
          // 实测 session-00001004：seq 21 提问 → seq 22 正是这个错（用户一点提交
          // 就把提问打死），官方卡随之消失；再点一次只能退成消息投递
          // （seq 32 的 `【回答提问】n_count：8`，就是用户截图里那条插话）。
          const answers = items.map((q, i) => {
            const custom = drafts[i].custom.trim()
            return {
              id: q.id,
              selected: custom === '' || q.multi === true ? drafts[i].selected : [],
              ...(custom === '' ? {} : { custom }),
            }
          })
          void (async () => {
            // ── 问题 1 的正身：弹窗回答 == 官方界面回答 ────────────────────────
            // 用户 2026-10-13：「我不要消息投递，我要等价！！」
            //
            // 旧写法只有两条通道：宿主 userQuestions.answer（只认 continued 态）与
            // 「把答案拼成一条普通消息发出去」。后者就是用户看到的「插话」——
            // 实测 session-0000100a 的 seq 21/22：两条 `【回答提问】q1-n-count：9`
            // 以 user 消息插进 inbox，而官方提问卡还挂着（用户又点了一次提交）。
            //
            // 官方界面点「提交」走的**不是**这两条，而是那张 PendingQuestion 卡上的
            // answer()（dsh-client-ui-user-questions/lib/client.js:396-406）：
            //   * 未超时（timed 的 open 态）→ 前端 waterfall.resolve(answer)：
            //     阻塞在 ask_user_question 里的那次工具调用**当场**拿到结果，卡片自己关；
            //   * 已超时（continued 态）→ userQuestions.answer RPC。
            // 那张卡就在 uiSession 的 pending-interaction 快照里（见文件头「宿主桥」②），
            // 所以弹窗可以直接拿**同一个对象**、调**同一个方法** —— 这才是等价，
            // 不是「另开一条路再想办法同步」。拿不到卡（宿主版本不对/该会话没有卡）
            // 才退回原来的宿主通道，并且**照实说明**它只是投递。
            // ⚠️ 计划审批（items[0].planReview）走**另一把取卡的钥匙**：官方那张卡没有
            // callId（plan-mode 调 ask() 不带 wait），按 callId 找永远找不到，
            // 于是 Approve 会悄悄退成消息投递、官方卡继续挂着 —— 正是用户
            // 2026-10-13 报过的那个症状。判据换成官方自己的 kind 字段，
            // 拿到的仍是**同一个对象、同一个 answer()**（等价性不变）。
            const isPlan = items.length > 0 && items[0].planReview === true
            const official = isPlan ? bridgePlanReviewCard(node.id) : bridgeQuestionCard(node.id, callId)
            if (official !== null) {
              try {
                await official.answer({ answers })
                if (state.drawerToken !== token) return
                const summary = items.map((q, i) => drafts[i].selected.join('、') || drafts[i].custom.trim()).join('；')
                // ⚠️ answer() 只是 waterfall.resolve，**永远 resolve**（见 bridgeQuestionOutcome
                // 的注释）—— 载荷被网关拒了也算「成功」。所以必须去查这次工具调用
                // 到底结算成什么，再决定报「已回答」还是如实报错。
                // 结算要等一个微任务 + 一次往返，轮询式确认最多等 2 秒。
                let outcome = 'unknown'
                if (live !== null) {
                  for (let attempt = 0; attempt < 20; attempt += 1) {
                    outcome = isPlan
                      ? bridgePlanReviewOutcome(live, callId)
                      : bridgeQuestionOutcome(live, callId)
                    if (outcome !== 'unknown') break
                    await new Promise((resolve) => { window.setTimeout(resolve, 100) })
                    if (state.drawerToken !== token) return
                  }
                }
                if (state.drawerToken !== token) return
                if (outcome === 'dead') {
                  // 提问已被这次回答打死：绝不能报「已回答」。
                  //   * **不写 cardAnswered** —— 它没被接受，写了就等于谎报；
                  //   * **不重刷提问盒** —— 宿主那边签名没变（仍 answered:false），
                  //     刷了只会把这句实话抹掉、留一张看起来还能答的卡；
                  //   * 放开按钮让用户重试（重试时官方卡已经不在了，会走兜底通道，
                  //     而那条通道自己会如实标注「已作为消息发送」）。
                  note.className = 'qnote err'
                  note.textContent = wsText('wsQCardDead')
                  submit.disabled = false
                  return
                }
                cardAnswered.set(callId, summary)
                markCardAnswered(card, items, items.map((q, i) => drafts[i].selected.join('、') || drafts[i].custom.trim()), isPlan ? wsText('wsQPlanDone') : wsText('wsQAnswered'), note)
                // answered/continued 都是「官方确实收了这批答案」：
                //   answered  = 前端 waterfall 当场结算（与聊天界面点提交同一条路）
                //   continued = 提问已超时，answer() 走 RPC 分支，那条**会**回报
                //               accepted，失败就抛错 ⇒ 到不了这里
                // unknown 只有一种情况：读不到事件窗口（没 retain 成功），
                // 这时只能说「已送出」，不能替官方担保。
                // 措辞按 kinds 分：计划审批的 rejected 是**正常结果**（用户选了
                // Keep planning，官方以 isError 结算，dsh-plan-mode/lib/index.js:289-292），
                // 不能套用提问那套「已回答」，更不能报成「出错了」。
                note.textContent = isPlan
                  ? (outcome === 'approved' ? wsText('wsQPlanApproved')
                    : outcome === 'rejected' ? wsText('wsQPlanRejected')
                      : wsText('wsQAnsweredSent'))
                  : (outcome === 'unknown' ? wsText('wsQAnsweredSent') : wsText('wsQAnsweredSame'))
                // 官方卡关掉之后宿主日志要等这一步结算才出现答案，本地先记着（见 cardAnswered）。
                window.setTimeout(() => { if (state.drawerToken === token) void loadQuestions(false) }, 600)
                return
              } catch (error) {
                if (state.drawerToken !== token) return
                // 官方通道失败就**如实报错**，不偷偷降级成消息投递（那正是用户反对的
                // 「以为回答了其实没回答」）。让他能重投一次。
                note.className = 'qnote err'
                note.textContent = wsText('wsQCardFailed', { message: String((error && error.message) || error) })
                submit.disabled = false
                return
              }
            }
            const r = await apiCall('team-answer', { sessionId: state.sessionId, targetId: node.id, callId, answers })
            if (state.drawerToken !== token) return
            if (r.ok !== true) {
              note.textContent = wsText('wsSendFailed', { message: String(r.error ?? '') })
              submit.disabled = false
              return
            }
            // ⚠️ 如实分三种情况（用户 2026-10-10 报障：「面板显示已回答，但官方页面仍在等我回答」）：
            //   * via==='userQuestions' → 官方投影确实被 settle 了（timed 模式）；
            //   * via==='message' 且 settlesOfficial!==true → 只发了一条普通消息，
            //     **官方提问卡不会被关闭**（legacy 模式下 agent 正阻塞在工具调用里等 waterfall）。
            //     必须如实说明，不能把「已发出」显示成「已回答」——那正是本次报障的观感来源。
            const settled = r.via === 'userQuestions' || r.settlesOfficial === true
            if (settled) {
              // 与官方通道同一套收卡逻辑（含「把 note 接回 DOM」那个坑，见 markCardAnswered）。
              markCardAnswered(card, items, items.map((q, i) => drafts[i].selected.join('、') || drafts[i].custom.trim()), wsText('wsQAnswered'), note)
              note.textContent = wsText('wsQAnsweredOk')
            } else {
              // 未关闭官方等待：卡片保留（用户可能还要用官方界面回答），只把状态写清楚。
              card.classList.add('sent')
              submit.disabled = false
              note.className = 'qnote err'
              note.textContent = wsText('wsQNotSettled')
              const why = document.createElement('div')
              why.className = 'qwhy'
              const fb = r.fallback ?? {}
              why.textContent = wsText('wsQNotSettledWhy', { reason: String(fb.note ?? '') })
              card.appendChild(why)
            }
            // 对话流里也回显一条（用户的确定感），与聊天发送同款。
            const summary = drafts.map((d) => d.selected.join('、') || d.custom.trim()).filter((s) => s !== '').join('；')
            const turn = document.createElement('div'); turn.className = 'tr mine'
            const who = document.createElement('div'); who.className = 'who'; who.textContent = wsText('wsWhoMe')
            const msg = document.createElement('div'); msg.className = 'msg'; msg.textContent = summary
            turn.append(who, msg)
            convoBox.appendChild(turn)
            convoBox.scrollTop = convoBox.scrollHeight
          })()
        })
        foot.append(submit, note)
        card.appendChild(foot)
        qCards.appendChild(card)
      }
      if (anyOpen && (firstLoad || qPrevOpen === 0)) {
        // 有**新**提问时聚焦输入框方便下一步。⚠️ 必须 preventScroll（用户 2026-10-09 报
        // 「顶端基本信息消失」的根因）：.db 是 overflow:hidden 的 flex 列，focus()
        // 会让浏览器滚动容器把输入框滚进视野 —— 顶部指标格整块被推出可视区。
        // 轮询刷新不重复聚焦（只在首载或「0 → 有」跳变时），否则用户正在别处打字会被打断。
        input.focus({ preventScroll: true })
        convoBox.scrollTop = convoBox.scrollHeight
      }
      qPrevOpen = open
      return firstLoad ? false : true
    }
    void loadQuestions(true)
    // 提问盒的**推送**半边（2026-10-13，与官方等价）：官方卡的挂/卸是事件，不该等轮询。
    // 订阅 uiSession 的 pending-interaction 快照 —— 官方在界面里答完一次提问，
    // 弹窗这张卡就当场消失/转只读；反过来 Lead 刚提问，弹窗立刻有卡。
    // （仍然保留轮询里的 loadQuestions：卡的出现要等 ask_user_question 落进会话日志，
    //  推送负责「立刻去查一次」，日志负责「查到内容」。）
    if (state.drawerToken === token) {
      // ⚠️ 只在「这张会话的官方卡真的挂了/卸了」时才去查日志。sessionStatus 是
      // **所有会话**的 running / pendingInteraction / completionUnread 合在一份快照里，
      // 别的会话翻一下 running 位也会回调我们（官方 publishStatus 每次都通知全部监听者，
      // 见 dsh-client-ui-session/lib/client.js:342-358）；而 team-questions 在宿主侧要
      // **从 seq 0 整读一遍会话事件**（lib/runtime.js 的 readOwnEvents），
      // 按那个频率打过去纯属白烧。
      const cardSignature = () => {
        const ui = bridgeService('uiSession')
        const status = ui === undefined || ui === null ? undefined : ui.sessionStatus
        if (status === undefined || status === null || typeof status.getSnapshot !== 'function') return ''
        let snapshot
        try { snapshot = status.getSnapshot() } catch { return '' }
        if (snapshot === undefined || snapshot === null || typeof snapshot.get !== 'function') return ''
        const ids = [node.id]
        const sid = String(node.id)
        if (sid.indexOf('session-') === 0) ids.push(sid.slice(8)); else ids.push('session-' + sid)
        for (const id of ids) {
          let row
          try { row = snapshot.get(id) } catch { row = undefined }
          const card = row === undefined || row === null ? undefined : row.pendingInteraction
          if (card !== undefined && card !== null) return String(card.callId)
        }
        return ''
      }
      let lastCardSig = cardSignature()
      const stopWatch = bridgeWatchQuestions(() => {
        if (state.drawerToken !== token) return
        const sig = cardSignature()
        if (sig === lastCardSig) return
        lastCardSig = sig
        void loadQuestions(false)
      })
      const prev = state.drawerLive
      if (prev === undefined) {
        // 没有 eventSource（拿不到桥）也要能收提问的推送：单独建一个 holder，
        // hasFeed 留 false —— 轮询档位判据认的就是这个标志。
        state.drawerLive = { hasFeed: false, release: () => {}, unsubscribe: stopWatch, reloadTimer: 0 }
      } else {
        const prevUnsub = prev.unsubscribe
        prev.unsubscribe = () => { stopWatch(); prevUnsub() }
      }
    }

    // 把手在 openWorkspace 里建好挂在 state 上：drawer.textContent='' 会连它一起清掉，
    // 所以每次开抽屉都要重新 append（它自带 pointerdown，重挂不丢逻辑）。
    state.drawer.append(head, body)
    if (state.resizer !== undefined) state.drawer.appendChild(state.resizer)
    state.drawer.classList.add('on')
    state.maskEl.classList.add('on')
  }

  /**
   * 按最新数据同步「停止生成」按钮：只在**真在跑**时出现。
   * 与官方同口径（dsh-client-ui-conversation/lib/client.js:17402
   * `primaryStops = running && …`、:17546 `disabled: stop === void 0`）：
   * 没在跑就不摆一个按了没用的按钮；拿不到官方的 cancel 时**画出来但禁用**，
   * 并在悬停里说为什么禁用 —— 官方在 stop 缺位时也正是这么画的。
   * @param {HTMLElement|undefined} btn - 抽屉里的停止按钮（未建时 undefined）。
   * @param {object|null|undefined} session - 该抽屉的活体会话面。
   * @returns {void}
   */
  function wsSyncDrawerStop(btn, session) {
    if (btn === undefined || btn === null) return
    const running = session !== null && session !== undefined && session.running === true
    btn.style.display = running ? '' : 'none'
    if (!running) return
    const capable = typeof session.cancel === 'function'
    btn.disabled = !capable
    btn.title = capable ? wsText('wsStopRunTip') : wsText('wsStopNoBridge')
  }

  function wsCloseDrawer(state) {
    // 放大面板是从抽屉里的展开层打开的：抽屉都关了，它没有留下的道理。
    wsCloseDetailZoom(state)
    state.drawer.classList.remove('on')
    state.maskEl.classList.remove('on')
    // 关窗即撤销指标同步的登记（DOM 已不在，继续同步只是白跑）。
    state.drawerCells = undefined
    state.drawerName = undefined
    // 停止按钮的判据引用同批清掉：关窗后不该再拿旧会话面的 running 决定什么。
    state.drawerStop = undefined
    state.drawerSession = undefined
    // 关掉浮窗就**停掉对话轮询**（用户 2026-10-10 加了自适应轮询；不清理会一直发请求）。
    // 递增 drawerToken 让在途/已排队的轮询自然失效（loadConvo 与 scheduleDrawer 都查它）。
    state.drawerToken = (state.drawerToken ?? 0) + 1
    if (state.drawerTimer !== undefined && state.drawerTimer !== 0) {
      clearTimeout(state.drawerTimer)
      state.drawerTimer = 0
    }
    // 流式覆盖层的收尾（2026-10-13）：退订 eventSource、撤销「结算后补拉」的防抖计时器，
    // 并**释放 retain 的引用**。最后一条是硬要求：retain 是引用计数
    // （dsh-api-session-controller/lib/client.js:3420-3434），漏放一次就永久多占一格，
    // 用户每开一个队员的弹窗都漏一格的话，会话对象层永远回收不掉。
    const live = state.drawerLive
    state.drawerLive = undefined
    if (live !== undefined && live !== null) {
      try { live.unsubscribe() } catch { /* 订阅已经掉了 */ }
      if (live.reloadTimer !== undefined && live.reloadTimer !== 0) clearTimeout(live.reloadTimer)
      try { live.release() } catch { /* 重复释放无害 */ }
    }
  }

  function openWorkspace(sessionId) {
    if (ws.root !== null) return
    if (typeof document === 'undefined') return
    const root = document.createElement('div')
    root.className = 'dat-ws'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-label', wsText('wsTitle'))

    const top = document.createElement('div'); top.className = 'ws-top'
    const title = document.createElement('span'); title.className = 't'; title.textContent = wsText('wsTitle')
    const sub = document.createElement('span'); sub.className = 's'; sub.textContent = wsText('wsSubtitle')
    const sp = document.createElement('span'); sp.className = 'sp'
    const zoomCtl = document.createElement('span'); zoomCtl.className = 'ws-ctl'
    const zoomLabel = document.createElement('label'); zoomLabel.textContent = wsText('wsZoom')
    const zoomInput = document.createElement('input'); zoomInput.type = 'range'; zoomInput.min = '45'; zoomInput.max = '130'; zoomInput.value = '100'
    const zoomValue = document.createElement('span'); zoomValue.textContent = '100%'
    zoomCtl.append(zoomLabel, zoomInput, zoomValue)
    const fitButton = document.createElement('button'); fitButton.className = 'ws-btn ghost'; fitButton.textContent = wsText('wsFit')
    const coreButton = document.createElement('button'); coreButton.className = 'ws-btn ghost'; coreButton.textContent = wsText('wsCoreOpen')
    coreButton.title = wsText('wsCoreButtonTip')
    const flowButton = document.createElement('button'); flowButton.className = 'ws-btn ghost on'; flowButton.textContent = wsText('wsFlow')
    flowButton.title = wsText('wsFlowButtonTip')
    const weakButton = document.createElement('button'); weakButton.className = 'ws-btn ghost on'; weakButton.textContent = wsText('wsWeak')
    const reloadButton = document.createElement('button'); reloadButton.className = 'ws-btn ghost'; reloadButton.textContent = wsText('wsRetry')
    const closeButton = document.createElement('button'); closeButton.className = 'ws-btn primary'; closeButton.textContent = wsText('wsClose')
    top.append(title, sub, sp, zoomCtl, fitButton, coreButton, flowButton, weakButton, reloadButton, closeButton)

    const stageEl = document.createElement('div'); stageEl.className = 'ws-stage'
    const canvas = document.createElement('div'); canvas.className = 'ws-canvas'
    const svg = wsSvg('svg', { class: 'ws-wires' })
    // 一次性图层：defs（箭头）+ 底线 + 流光 + 协作核。底线/容器每轮重建无所谓（无动画），
    // **流光层永不重建**：元素按边身份复用，CSS 动画挂在元素上，元素活着动画就连续。
    const defs = wsSvg('defs', {})
    // 流光自 2026-10-09 起回到 v1 的「深色实心色块」模型（dasharray + dashoffset），
    // 因此这里**不再有**径向渐变 defs —— 之前为光晕写的 spotGradient 连同它的
    // 三个坑（甜甜圈白心、非单调不透明度画出亮环、光晕占位子）一起删掉了。
    // 箭头（用户 2026-10-08 三次报「看不到箭头」，第三次附截图）。
    //
    // 两个独立的根因，都实测确认过：
    //   ① 尺寸：画布整体被 CSS `transform: scale(zoom)` 缩放，默认 zoom=0.45。
    //      marker 用 userSpaceOnUse 时尺寸也在用户坐标系里 → 屏幕上的箭头只有
    //      8×0.45=3.24px，肉眼看不见。修法：尺寸除以缩放补偿（wsSyncMarkers），
    //      屏幕上恒定 ARROW_PX。
    //   ② 位置（截图暴露的）：refX 决定 marker 里哪个点对齐路径终点。三角的尖在
    //      viewBox x=9，而旧值 refX=7.5 → **箭尖越过终点 1.5 个单位戳进卡片**
    //      （节点卡片是 HTML div，叠在 SVG 之上，把箭尖整个盖掉），剩下的半截
    //      看着像个被切掉尖的钝块 —— 用户截图里正是这个现象。
    //      修法：refX=9，箭尖**正好落在终点**（= 卡片边缘），整个箭头留在卡片外。
    const ARROW_PX = WS_ARROW_PX
    const ARROW_IDS = ['ws-ab', 'ws-ag', 'ws-av', 'ws-avs']
    const marker = (id, color, back) => {
      const m = wsSvg('marker', {
        // 正向 marker：三角 'M0 1 L9 5 L0 9 z' 的尖在 x=9 → refX=9（尖贴线尾，不戳进卡片）。
        // 反向 marker（双向边的 marker-start）：三角 'M10 1 L1 5 L10 9 z' 的尖在 x=1 → refX=1。
        id, viewBox: '0 0 10 10', refX: back ? 1 : 9, refY: 5,
        markerWidth: ARROW_PX, markerHeight: ARROW_PX, orient: 'auto', markerUnits: 'userSpaceOnUse',
      })
      m.appendChild(wsSvg('path', { d: back ? 'M10 1 L1 5 L10 9 z' : 'M0 1 L9 5 L0 9 z', fill: color }))
      return m
    }
    defs.append(
      marker('ws-ab', 'var(--dat-blue)', false),
      marker('ws-ag', 'var(--dat-green)', false),
      marker('ws-av', 'var(--dat-violet)', false),
      marker('ws-avs', 'var(--dat-violet)', true),
    )
    const gWires = wsSvg('g', {})
    const gFlows = wsSvg('g', {})
    const gCore = wsSvg('g', {})
    // sync 助手声明在 gFlows **之后**（历史原因：它曾要遍历流光层；写在前面会命中 TDZ
    // `Cannot access 'gFlows' before initialization`，6 个未捕获异常导致只画一半的线）。
    /** 按当前缩放补偿 marker 尺寸：屏幕上恒定 ARROW_PX。 */
    const wsSyncMarkers = (zoom) => {
      const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
      const size = (ARROW_PX / z).toFixed(2)
      for (const id of ARROW_IDS) {
        const m = defs.querySelector('marker#' + id)
        if (m === null) continue
        if (m.getAttribute('markerWidth') !== size) m.setAttribute('markerWidth', size)
        if (m.getAttribute('markerHeight') !== size) m.setAttribute('markerHeight', size)
      }
    }
    svg.append(defs, gWires, gFlows, gCore)
    const noteEl = document.createElement('div'); noteEl.className = 'ws-note'
    canvas.appendChild(svg)
    stageEl.append(canvas, noteEl)

    const legendEl = document.createElement('div'); legendEl.className = 'ws-legend'
    const statusEl = document.createElement('div'); statusEl.className = 'ws-status'

    const maskEl = document.createElement('div'); maskEl.className = 'ws-mask'
    const drawer = document.createElement('div'); drawer.className = 'ws-drawer'
    // 左边缘拖宽把手（用户 2026-10-09：「可以拖动左边的框，让这个界面变宽，不要固定死宽度」）。
    // 宽度记在 ws 上：同一次工作区会话里换开不同成员的抽屉不跳回默认宽。
    const resizer = document.createElement('div'); resizer.className = 'ws-resizer'
    resizer.title = wsText('wsResizeTip')
    drawer.appendChild(resizer)
    if (ws.drawerWidth > 0) drawer.style.width = ws.drawerWidth + 'px'
    resizer.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      // 捕获成功时 move/up 会重定向到把手；失败（合成事件/个别浏览器）也无所谓，
      // 因为下面把 move/up 绑在 window 上 → 鼠标移出那 7px 把手也不会丢拖动。
      try { resizer.setPointerCapture(event.pointerId) } catch { /* 忽略 */ }
      resizer.classList.add('on')
      document.body.style.cursor = 'col-resize'
      const startX = event.clientX
      const startW = drawer.getBoundingClientRect().width
      const move = (ev) => {
        // 抽屉贴右边：向左拖 = 变宽，所以是 startX - ev.clientX。
        const want = startW + (startX - ev.clientX)
        const max = Math.max(380, window.innerWidth - 40)
        const w = Math.round(Math.min(max, Math.max(380, want)))
        drawer.style.width = w + 'px'
        ws.drawerWidth = w
      }
      const up = () => {
        resizer.classList.remove('on')
        document.body.style.cursor = ''
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    })

    root.append(top, stageEl, legendEl, statusEl, maskEl, drawer)
    document.body.appendChild(root)

    const state = {
      sessionId, data: null, byName: new Map(), leadName: 'lead',
      zoom: 100, flow: true, weak: true, coreOpen: false, core: null,
      canvasW: 0, canvasH: 0, loading: false, error: '', notes: [], first: true, fingerprint: '',
      // 宿主给的结构化标志：成员名单是否来自历史恢复（底栏据此打琥珀色快照标记）。
      historyRecovered: false,
      // 抽屉「停止生成」的登记（wsOpenDrawer 写、wsApplyGraph 同步、wsCloseDrawer 清）。
      drawerStop: undefined, drawerSession: undefined,
      // 当前打开的「放大查看」面板（wsOpenDetailZoom 写、wsCloseDetailZoom 清；null = 没开）。
      zoomEl: null,
      stableRounds: 0, changedRecently: true, freshNames: new Set(),
      root, canvas, svg, stageEl, legendEl, statusEl, noteEl, maskEl, drawer,
      // 顶栏那几个标签的引用（语言切换时 wsRelanguage 就地换字，见它的注释）。
      chromeLabels: { title, subtitle: sub, zoom: zoomLabel, fit: fitButton, flow: flowButton, weak: weakButton, reload: reloadButton, exit: closeButton, resizer },
      zoomInput, zoomLabel: zoomValue, coreButton,
      gWires, gFlows, gCore, flowEls: new Map(), nodeEls: new Map(),
      resizer,
      syncMarkers: wsSyncMarkers,
      // 官方工具标签表（宿主随 team-graph 给一次，见 lib/graph.js 的 toolLabelTable）。
      // 流式覆盖层给「正在生成的工具调用」出标签要用它 —— 不在前端再抄一份表，
      // 抄两份迟早和官方漂移（2026-10-09 用户就是拿「和官方对话框不一样」报的障）。
      toolLabels: null,
      // 上一轮服务端标签表的内容指纹（team-graph 带上它，服务端就能省略表本体）。
      toolLabelsHash: undefined,
    }
    ws.root = root
    ws.state = state

    zoomInput.addEventListener('input', () => { state.zoom = Number(zoomInput.value) || 100; wsApplyZoom(state) })
    fitButton.addEventListener('click', () => wsFit(state))
    coreButton.addEventListener('click', () => {
      state.coreOpen = !state.coreOpen
      wsSyncCoreButton(state)
      wsDrawWires(state)
    })
    flowButton.addEventListener('click', () => {
      state.flow = !state.flow
      flowButton.classList.toggle('on', state.flow)
      wsDrawWires(state)
    })
    weakButton.addEventListener('click', () => {
      state.weak = !state.weak
      weakButton.classList.toggle('on', state.weak)
      wsDrawWires(state)
    })
    reloadButton.addEventListener('click', () => { void wsLoad(state, false, true) })
    closeButton.addEventListener('click', closeWorkspace)
    maskEl.addEventListener('click', () => wsCloseDrawer(state))
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      // 放大面板压在抽屉**之上**，所以 Esc 先关它：先关抽屉会把它孤零零留在画布上。
      if (state.zoomEl !== null && state.zoomEl !== undefined) { wsCloseDetailZoom(state); return }
      if (state.drawer.classList.contains('on')) { wsCloseDrawer(state); return }
      closeWorkspace()
    }
    document.addEventListener('keydown', onKey)
    state.onKey = onKey
    const onResize = () => {
      if (ws.raf !== 0) cancelAnimationFrame(ws.raf)
      ws.raf = requestAnimationFrame(() => { ws.raf = 0; if (ws.state !== null) wsDrawWires(ws.state) })
    }
    window.addEventListener('resize', onResize)
    state.onResize = onResize

    // 自动刷新：画布是运行态视图，需要「刚派出的队员马上出现」（用户 2026-10-08 的要求）。
    // 用**自适应间隔**而不是固定 5 秒：
    //   * 团队正在变化（有新队员/新线/状态翻转）→ 1.2 秒一轮，肉眼几乎立刻看到新队员；
    //   * 稳定下来了 → 退回 5 秒一轮，省 CPU 与请求；
    //   * 页面不可见 → 完全跳过（切走标签页不该继续轮询）。
    // 成本有界：host 侧按 seq 增量折叠，一轮只是几次 Map 查找 + 一次 JSON 序列化。
    const FAST_MS = 1200
    const SLOW_MS = 5000
    const schedule = () => {
      const delay = state.changedRecently === true ? FAST_MS : SLOW_MS
      ws.timer = window.setTimeout(() => {
        ws.timer = 0
        if (ws.state !== state) return
        if (typeof document !== 'undefined' && document.hidden === true) { schedule(); return }
        // ⚠️ 轮询链的**续期不能依赖 wsLoad 的返回值**：以前写 `.then(() => schedule())`，
        // 一旦 wsLoad reject（宿主契约漂移让渲染期抛错等），.then 不执行 → **链永久死亡**、
        // 画布冻结且无任何提示（审查实测：畸形响应后 10 秒只发 1 次请求，恢复后也不自愈）。
        // 现在用 try/finally 无条件续期：wsLoad 抛错只影响这一帧，下一轮照常。
        const next = () => { if (ws.state === state) schedule() }
        try {
          const pending = wsLoad(state, false)
          if (pending !== null && pending !== undefined && typeof pending.then === 'function') {
            pending.then(next, next)
          } else {
            next()
          }
        } catch {
          next()
        }
      }, delay)
    }
    schedule()
    void wsLoad(state, true)
  }

  /**
   * 语言变了 → 把**已经打开**的工作区换成新语言。
   *
   * 为什么必须专门做（2026-10-14 i18n 审查）：官方 locale 一切换，React 那半边自己会重渲染，
   * 但这个覆盖层是**命令式 DOM**（openWorkspace 里 createElement 建出来的），官方那次重渲染
   * 不会顺手刷它 —— 不处理的话用户切到英文后画布仍是全中文，得退出工作区再进一次。
   *
   * 分两种做法，各按各自成本选：
   *   * 顶栏标签：就地换字（引用都在 state.chromeLabels 里，一次赋值一处真相）；
   *   * 抽屉：**关掉再重开**。抽屉的标签散在十几个闭包变量里（指标格键名、提问盒标题、
   *     发送框 placeholder、停止键、附件按钮…），逐个补一遍等于再写第二套渲染逻辑 ——
   *     那正是本仓库反复栽的「抄两份迟早漂移」。重开走的是同一条 wsOpenDrawer，
   *     retain/release 依旧成对（wsCloseDrawer 放掉、wsOpenDrawer 重新 retain，
   *     见它的注释：retain 是引用计数，漏放就永久多占一格）。
   *     代价是抽屉内的滚动位置与展开态回到初始：换语言是极低频操作，
   *     不值得为它维护第二套渲染，这一点如实写在这儿而不是假装没有代价。
   * @returns {void}
   */
  function wsRelanguage() {
    const state = ws.state
    if (state === null) return
    const labels = state.chromeLabels
    if (labels !== undefined && labels !== null) {
      labels.title.textContent = wsText('wsTitle')
      labels.subtitle.textContent = wsText('wsSubtitle')
      labels.zoom.textContent = wsText('wsZoom')
      labels.fit.textContent = wsText('wsFit')
      labels.flow.textContent = wsText('wsFlow')
      labels.flow.title = wsText('wsFlowButtonTip')
      labels.weak.textContent = wsText('wsWeak')
      labels.reload.textContent = wsText('wsRetry')
      labels.exit.textContent = wsText('wsClose')
      labels.resizer.title = wsText('wsResizeTip')
      state.root.setAttribute('aria-label', wsText('wsTitle'))
    }
    if (state.data !== null) {
      // 卡片、图例、底栏、协作核按钮全部走 wsText，重跑一次就换完字
      //（wsRender 是就地更新那条路，不会重建节点、不会打断流光动画）。
      wsRender(state)
    } else {
      wsSyncCoreButton(state)
    }
    if (state.drawer.classList.contains('on') === false) return
    const name = state.drawerName
    const shown = state.data === null ? undefined : state.data.nodes.find((n) => n.name === name)
    wsCloseDrawer(state)
    if (shown !== undefined) wsOpenDrawer(state, shown)
  }

  function closeWorkspace() {
    if (ws.root === null) return
    // 自适应轮询用 setTimeout 链（不是 setInterval）：退出时清掉待触发的那个。
    if (ws.timer !== 0) { clearTimeout(ws.timer); ws.timer = 0 }
    const state = ws.state
    if (state !== null) {
      // 弹窗对话的自适应轮询同样要清（2026-10-10 新增）。
      state.drawerToken = (state.drawerToken ?? 0) + 1
      if (state.drawerTimer !== undefined && state.drawerTimer !== 0) { clearTimeout(state.drawerTimer); state.drawerTimer = 0 }
      // 整页关闭时浮窗可能还开着：覆盖层的 retain 同样要放掉（理由见 wsCloseDrawer）。
      if (state.drawerLive !== undefined && state.drawerLive !== null) {
        const live = state.drawerLive
        state.drawerLive = undefined
        try { live.unsubscribe() } catch { /* 已经掉了 */ }
        if (live.reloadTimer !== undefined && live.reloadTimer !== 0) clearTimeout(live.reloadTimer)
        try { live.release() } catch { /* 重复释放无害 */ }
      }
      if (state.onKey !== undefined) document.removeEventListener('keydown', state.onKey)
      if (state.onResize !== undefined) window.removeEventListener('resize', state.onResize)
    }
    ws.root.remove()
    ws.root = null
    ws.state = null
  }

  // ── 挂载 ────────────────────────────────────────────────────────────────────
  function apply(ctx) {
    ensureCss()
    // 宿主桥的入口：只存引用，取服务一律延后到真正要用的时候
    // （官方 bundle 的加载顺序不保证在我们之前，apply 时 sessions 可能还没有）。
    bridge.ctx = ctx
    const slots = ctx.slots
    if (slots === undefined || slots === null) return

    // 字典注册（官方 client-ui-agent-team/lib/client.js:470 同形）：locale 是声明过的硬依赖
    // （见文件尾的 exports.inject），所以直接用 ctx.locale。字典没注册时组件里的 makeText
    // 会退回本文件自带的 zh 文案，页面不会退化成 key。
    const locale = ctx.locale
    if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
      ctx.effect(() => locale.register(NS, { zh, en }), 'dispatch-agent-team: dictionaries')
    }
    // 挂上当前语言 + 订阅变化（2026-10-14 补，这是浮窗此前恒中文的根因）。
    // 官方在**字典注册**时也会 publish 一次（dsh-client-locale/lib/client.js:1397），
    // 所以回调里只在 active 真的变了才重画，否则开局就白重建一次画布。
    if (locale !== undefined && locale !== null) {
      if (typeof locale.getSnapshot === 'function') localeAttach(locale)
      if (typeof locale.subscribe === 'function') {
        ctx.effect(() => locale.subscribe(() => {
          const before = localeState.active
          localeSyncActive()
          if (localeState.active !== before) wsRelanguage()
        }), 'dispatch-agent-team: locale sync')
      }
    }

    // 槽位由官方 plugin-manager 的页面声明（client.js:3449-3452），这里注入等它出现；
    // 注册随本插件生命周期回收。
    ctx.effect(() => slots.inject('plugins.bundle.config', () => slots.register({
      name: 'plugins.bundle.config',
      key: '@zws/dsh-dispatch-agent-team',
      locale: NS,
    }, RosterConfigPage)), 'dispatch-agent-team: config page')

    // 工作区入口锚点：注册进官方 TeamAction 的**同一个槽**（conversation.session.header.actions
    // 是 kind:"list"，多个注册共存）。槽位系统按 scope:"session" 给我们的组件注入权威的
    // sessionId（官方组件同款 props：dsh-client-ui-renderer/lib/client.js:790 SessionEntry →
    // standardProps 把会话绑定的 props 摊进组件），锚点把它写进 data 属性，
    // 供面板里的「进入工作区」按钮取用。
    // ⚠️ list 槽**必须用 id 不是 key**（dsh-client-ui-slots/lib/index.js:181-184：
    //    `list slot "x" requires options.id`，缺 id 在 register 时直接抛）。
    // order 取 -19：紧跟官方 TeamAction（-20），按钮顺序 = 智能体团队 → 我们的锚点（不可见）。
    // ⚠️ 整段包 try/catch：官方槽位形状若变了（list→keyed 会要求 key 而不是 id），
    //    register 抛错会**连带炸掉整个 apply()** —— 配置页（用户的主入口）跟着死。
    //    锚点是锦上添花，坏了只少一个按钮；drift-check 8c 会在官方改名时先红。
    try {
      ctx.effect(() => slots.inject('conversation.session.header.actions', () => slots.register({
        name: 'conversation.session.header.actions',
        id: 'dispatch-workspace-anchor',
        order: -19,
      }, TeamEntryAnchor)), 'dispatch-agent-team: workspace entry anchor')
    } catch {
      /* 锚点注册失败：入口按钮不出现，其余功能不受影响 */
    }

    try {
      ensureTeamEntry()
      ctx.effect(() => () => disposeTeamEntry(), 'dispatch-agent-team: entry observer')
    } catch {
      /* 同上：注入器坏了不拖垮页面 */
    }
  }

  exports.name = 'dsh-dispatch-agent-team-client'
  exports.inject = ['slots', 'locale']
  exports.apply = apply
  return module.exports
  },
})