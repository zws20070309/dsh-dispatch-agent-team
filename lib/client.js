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
// ⚠️ 注册必须在**单条语句内**完成，且不得有任何顶层声明。
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
    '.dat-row{display:flex;gap:10px 16px;flex-wrap:wrap;align-items:flex-start;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))}' +
    '.dat-row:first-child{border-top:none}' +
    '.dat-role{flex:1 1 260px;min-width:0;display:flex;flex-direction:column;gap:2px}' +
    '.dat-role-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}' +
    '.dat-name{font-weight:600}' +
    '.dat-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;opacity:.6;word-break:break-all}' +
    '.dat-mission{font-size:12px;opacity:.78}' +
    '.dat-ctl{flex:0 1 232px;min-width:200px;display:flex;flex-direction:column;gap:6px}' +
    '.dat-field{display:flex;flex-direction:column;gap:3px;min-width:0}' +
    '.dat-label{font-size:11px;opacity:.65}' +
    '.dat-select{font-size:12px;padding:3px 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.5));background:transparent;color:inherit;width:100%;box-sizing:border-box}' +
    '.dat-select:disabled{opacity:.5}' +
    '.dat-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
    '.dat-btn{font-size:12px;padding:3px 10px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.5));background:transparent;color:inherit;cursor:pointer;white-space:nowrap}' +
    '.dat-btn:disabled{opacity:.5;cursor:default}' +
    '.dat-foot{font-size:11px;opacity:.6;line-height:1.75}' +
    '.dat-summary{font-size:12px;opacity:.78}'

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
    summary: '每个角色各自可指定模型与思考强度（默认与 Lead 相同）',
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
    cacheModeDefault: '用默认',
    cacheModeAuto: 'auto（推荐）',
    cacheModeOn: 'on（强制）',
    cacheModeOff: 'off（关）',
    reportsTitle: '队员的结构化汇报（report_result）：',
    reportLine: '{name} · {status}{unresolved}',
    reportUnresolved: '，未决 {count} 项（阻止验收）',
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
    inherit: '跟随 Lead（默认）',
    missingModel: '{label}（不在当前模型目录）',
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
  }
  const en = {
    summary: 'Every role can name its own model and reasoning effort (Lead default otherwise)',
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
    cacheModeDefault: 'Default',
    cacheModeAuto: 'auto (recommended)',
    cacheModeOn: 'on (force)',
    cacheModeOff: 'off',
    reportsTitle: 'Structured teammate reports (report_result):',
    reportLine: '{name} · {status}{unresolved}',
    reportUnresolved: ', {count} unresolved (blocks acceptance)',
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
    inherit: 'Follow Lead (default)',
    missingModel: '{label} (not in the current model catalog)',
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
  }

  function fmt(text, params) {
    if (typeof text !== 'string') return ''
    if (params === undefined || params === null) return text
    return text.replace(/\{(\w+)\}/g, (match, key) => (params[key] === undefined ? match : String(params[key])))
  }

  /**
   * 组件外（apiCall 等）用的文案兜底：只用本文件自带的 zh 字典。
   * 组件内用 makeText(props.t)，优先走官方 locale 查找链。
   */
  function fallbackText(key, params) {
    const out = typeof zh[key] === 'string' ? zh[key] : key
    return fmt(out, params)
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
        mission: asText(entry.mission) || asText(entry.description) || '',
      })
    }
    return out
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

  /** 已净化配置 → 草稿：每个角色只存不透明模型键 + 强度 id（'' = 不指定/跟随 Lead）。 */
  function draftFromConfig(config) {
    const draft = Object.create(null)
    const roles = config !== null && typeof config === 'object' && config.roles !== null && typeof config.roles === 'object' && !Array.isArray(config.roles) ? config.roles : null
    if (roles === null) return draft
    for (const roleId of Object.keys(roles)) {
      const entry = roles[roleId]
      if (entry === null || typeof entry !== 'object') continue
      const provider = asText(entry.provider)
      const model = asText(entry.model)
      if (provider === '' || model === '') continue
      draft[roleId] = { key: provider + SEP + model, effort: asText(entry.reasoningEffort) }
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

  /** 宿主 get 返回的 reports → 展示行（最近 8 条，新的在前）。 */
  function normalizeReports(raw) {
    if (!Array.isArray(raw)) return []
    const out = []
    for (const item of raw) {
      if (item === null || typeof item !== 'object') continue
      const unresolved = Array.isArray(item.unresolved) ? item.unresolved.length : 0
      out.push({ at: asText(item.at), name: asText(item.name), status: asText(item.status), unresolved })
    }
    return out.slice(-8).reverse()
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

  function cloneDraft(source) {
    const out = Object.create(null)
    for (const roleId of Object.keys(source)) {
      const row = source[roleId]
      if (row === undefined) continue
      out[roleId] = { key: row.key, effort: row.effort }
    }
    return out
  }

  /** 只保留角色表里存在的行，避免把宿主不认识的键写回配置。 */
  function trimDraft(draft, roleIds) {
    const out = Object.create(null)
    for (const roleId of roleIds) {
      const row = draft[roleId]
      if (row !== undefined) out[roleId] = { key: row.key, effort: row.effort }
    }
    return out
  }

  /** 草稿 → set 的 args.roles。没选模型 = 跟随 Lead，不进 payload（sanitizeConfig 只接受成对的 provider/model）。 */
  function rolesFromDraft(draft, roleIds) {
    const roles = {}
    for (const roleId of roleIds) {
      const row = draft[roleId]
      if (row === undefined || row.key === '') continue
      const at = row.key.indexOf(SEP)
      if (at <= 0) continue
      const entry = { provider: row.key.slice(0, at), model: row.key.slice(at + 1) }
      if (row.effort !== '') entry.reasoningEffort = row.effort
      roles[roleId] = entry
    }
    return roles
  }

  function draftSignature(draft, roleIds) {
    const parts = []
    for (const roleId of roleIds) {
      const row = draft[roleId]
      parts.push(roleId + '\u0001' + (row === undefined ? '' : row.key + '\u0001' + row.effort))
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
      if (record === undefined) { out[roleId] = { key: row.key, effort: row.effort }; continue }
      const effort = record.efforts.some((item) => item.id === row.effort) ? row.effort : ''
      out[roleId] = { key: row.key, effort }
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
        if (key === '') delete next[roleId]
        else next[roleId] = { key, effort }
        return next
      })
    }

    const changeEffort = (roleId, effort) => {
      setConfirmReset(false)
      setDraft((current) => {
        const row = current[roleId]
        if (row === undefined) return current
        const next = cloneDraft(current)
        next[roleId] = { key: row.key, effort }
        return next
      })
    }

    const onSave = () => {
      if (busy || phase !== 'ready') return
      setBusy(true)
      setConfirmReset(false)
      setMessage(null)
      // 带上读到的磁盘版本：宿主比对不一致会拒绝（而不是静默 last-write-wins）。
      // cache 一起提交（宿主对没带的字段保持原值）：只改保活设置时不会清空角色配置，反之亦然。
      apiCall('set', {
        roles: rolesFromDraft(draft, roleIds),
        cache: { keepalive: { routes: cloneRouteDraft(cacheDraft) } },
        revision,
      }).then((result) => {
        if (result !== null && typeof result === 'object' && result.ok === true) {
          // 以宿主回传的净化结果为准；宿主没回 config 时退回我们刚提交的那份（不然会把界面清空）。
          const saved = result.config === undefined || result.config === null
            ? cloneDraft(trimDraft(draft, roleIds))
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
          setMessage({ kind: 'ok', text: text('saved') })
          return
        }
        const conflict = result !== null && typeof result === 'object' && (result.conflict === true || result.stale === true)
        setMessage({ kind: 'err', text: conflict ? text('saveConflict', { message: errorText(result, text) }) : text('saveFailed', { message: errorText(result, text) }) })
      }).catch((error) => {
        setMessage({ kind: 'err', text: text('saveFailed', { message: String((error && error.message) || error) }) })
      }).then(() => { setBusy(false) })
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

    const renderRow = (role) => {
      const row = draft[role.id] === undefined ? { key: '', effort: '' } : draft[role.id]
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
        React.createElement('div', { className: 'dat-ctl' },
          React.createElement('label', { className: 'dat-field' },
            React.createElement('span', { className: 'dat-label' }, text('modelLabel')),
            React.createElement('select', {
              className: 'dat-select',
              value: row.key,
              disabled: modelSelectDisabled,
              onChange: (event) => changeModel(role.id, event.target.value),
            }, modelOptions)),
          renderEffort(role.id, row, record)))
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
          route === '' ? text('cacheRoute', { route: '（未知）' }) : text('cacheRoute', { route }),
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
              ttl: family.ttl > 0 ? `${family.ttl} 秒` : '未知（按不缓存处理，默认关闭）',
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
      rows.push(reports.length === 0
        ? React.createElement('div', { className: 'dat-note', key: 'reportsEmpty' }, text('reportsEmpty'))
        : React.createElement('ul', { className: 'dat-diag', key: 'reports' }, reports.map((report, index) => React.createElement('li', { key: 'report-' + index },
          text('reportLine', {
            name: report.name === '' ? '?' : report.name,
            status: report.status === '' ? '?' : report.status,
            unresolved: report.unresolved > 0 ? text('reportUnresolved', { count: String(report.unresolved) }) : '',
          })))))
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

  // ── 挂载 ────────────────────────────────────────────────────────────────────
  function apply(ctx) {
    ensureCss()
    const slots = ctx.slots
    if (slots === undefined || slots === null) return

    // 字典注册（官方 client-ui-agent-team/lib/client.js:470 同形）：locale 是声明过的硬依赖
    // （见文件尾的 exports.inject），所以直接用 ctx.locale。字典没注册时组件里的 makeText
    // 会退回本文件自带的 zh 文案，页面不会退化成 key。
    const locale = ctx.locale
    if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
      ctx.effect(() => locale.register(NS, { zh, en }), 'dispatch-agent-team: dictionaries')
    }

    // 槽位由官方 plugin-manager 的页面声明（client.js:3449-3452），这里注入等它出现；
    // 注册随本插件生命周期回收。
    ctx.effect(() => slots.inject('plugins.bundle.config', () => slots.register({
      name: 'plugins.bundle.config',
      key: '@zws/dsh-dispatch-agent-team',
      locale: NS,
    }, RosterConfigPage)), 'dispatch-agent-team: config page')
  }

  exports.name = 'dsh-dispatch-agent-team-client'
  exports.inject = ['slots', 'locale']
  exports.apply = apply
  return module.exports
  },
})