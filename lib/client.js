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
    '.dat-bulk-title{font-weight:600}' +
    '.dat-bulk-ctl{display:flex;gap:8px 10px;flex-wrap:wrap;align-items:flex-end}' +
    '.dat-bulk-ctl .dat-field{flex:1 1 200px;min-width:170px}' +
    '.dat-bulk-hint{font-size:11px;opacity:.6;line-height:1.6}' +
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
    // 流光：pathLength=100 归一化，9% 亮段沿路径从 M（源）跑到终点（目标）→ 方向永远=语义方向。
    '.dat-ws path.flow{fill:none;stroke-linecap:round;opacity:.95;animation:ws-flow 2.6s linear infinite}' +
    '@keyframes ws-flow{from{stroke-dashoffset:100}to{stroke-dashoffset:0}}' +
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
    '.dat-ws .ws-drawer .db{flex:1;overflow:auto;padding:14px}' +
    '.dat-ws .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-bottom:12px}' +
    '.dat-ws .cell{border:1px solid var(--dsw-alias-border-l2,#e5e5e6);border-radius:6px;padding:6px 8px}' +
    '.dat-ws .cell .k{font-size:10px;color:var(--dat-ink-muted)}' +
    '.dat-ws .cell .v{font-weight:600;font-variant-numeric:tabular-nums;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.dat-ws .ws-drawer h4{margin:14px 0 6px;font-size:12px;color:var(--dsw-alias-label-secondary,#63636a);font-weight:600}' +
    '.dat-ws .tk{border:1px solid var(--dsw-alias-border-l2,#e5e5e6);border-radius:6px;padding:6px 9px;margin-bottom:5px;display:flex;gap:8px;align-items:flex-start}' +
    '.dat-ws .tk .st{font-size:10px;padding:1px 5px;border-radius:3px;flex:none;margin-top:1px}' +
    '.dat-ws .tk .st.completed{background:color-mix(in srgb, var(--dat-green) 12%, transparent);color:var(--dat-green)}' +
    '.dat-ws .tk .st.in_progress{background:var(--dat-blue-soft);color:var(--dat-blue)}' +
    '.dat-ws .tk .st.pending{background:var(--dsw-alias-bg-layer-2,#f4f4f5);color:var(--dat-ink-muted)}' +
    '.dat-ws .empty{color:var(--dat-ink-muted);font-size:12px}' +
    '.dat-ws .cv{border-left:2px solid var(--dsw-alias-border-l2,#e5e5e6);padding-left:10px;display:flex;flex-direction:column;gap:9px}' +
    '.dat-ws .tr .who{font-size:10px;color:var(--dat-ink-muted);margin-bottom:2px}' +
    '.dat-ws .tr .msg{font-size:12px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,#63636a)}' +
    '.dat-ws .tr.tool .msg{font-family:ui-monospace,Consolas,monospace;font-size:11px;background:var(--dsw-alias-bg-layer-2,#fafafa);border-radius:4px;padding:5px 7px}' +
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
    summary: '可一次性给全部角色统一模型与思考强度，也可逐角色单独指定（默认与 Lead 相同）',
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
    bulkTitle: '统一选择队员模型与思考强度',
    bulkAppliesAll: '（作用于全部 {count} 个角色）',
    bulkLabel: '模型（应用到全部角色）',
    bulkMixed: '（各角色当前不一致）',
    bulkHint: '两个下拉都是「一次改全部」：模型选一次就作用于下面每个角色，思考强度同理（但强度依附于模型，所以先把模型统一）。换模型时强度会重算：仍然支持的档位保留，不支持的退回「模型默认」。设置完仍可单独改某一个角色。',
    bulkEffortLabel: '思考强度（应用到全部角色）',
    bulkEffortMixedModels: '各角色模型不一致：档位是每个模型各自广告的，先把上面的模型统一成一个，才能统一思考强度。',
    bulkEffortNoModel: '还没有统一模型（当前是「跟随 Lead」）：强度依附于模型，先在上面选一个模型。',
    bulkEffortNone: '这个模型没有广告任何思考档位（官方规则：没有 reasoning 元数据就没有档位可选），所以没有可统一的值。',
    bulkEffortNoCatalog: '模型目录没读到（原因见上方告警）：档位无从校验，所以暂时不能统一思考强度。',
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
    // ── 工作区画布 ──
    wsEnter: '进入工作区',
    wsTitle: '调度模式智能体团队 · 工作区',
    wsSubtitle: '真实团队拓扑（来自会话日志与域服务）',
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
    wsCacheRead: '缓存读取',
    wsTotalOut: '总输出',
    wsAvgTps: '平均 TPS',
    wsTotalTokens: '总 token',
    wsRealData: '真实会话日志',
    wsTodo: 'TODO',
    wsModelNone: '(未记录)',
    wsRoleLead: 'Lead',
    wsStateRunning: '进行中',
    wsStateDone: '已交付',
    wsStateIdle: '待命',
    wsStateFailed: '失败',
    wsStateProvisioning: '准备中',
    wsLegendLead: '进行中：蓝虚线，流光 Lead → 队员',
    wsLegendDone: '已交付：绿实线，流光 队员 → Lead',
    wsLegendHandoff: '承接：紫线，流光 写方 → 读方（越粗共享文件越多）',
    wsLegendCore: '协作核：互相读写的成员收进容器（点击展开内部关系）',
    wsLegendIdle: '待命',
    wsLegendCol: '列 = 真实依赖深度 · 环 = 上下文占用（悬停看数值）',
    wsDrawerRelations: '关系（{count} 条，来自真实文件读写与消息）',
    wsDrawerNoRel: '没有可追溯的承接关系。',
    wsDrawerTasks: '任务（{count} 条在任务板上）',
    wsDrawerNoTask: '这个队员没有认领任务板上的条目；它的工作在派活提示词里。',
    wsDrawerConvo: '对话详情',
    wsDrawerConvoLoading: '正在读取对话…',
    wsDrawerConvoEmpty: '日志里没有可展示的对话轮次。',
    wsDrawerConvoFailed: '对话读取失败：{message}',
    wsCellModel: '模型',
    wsCellStatus: '状态',
    wsCellRuntime: '运行时长',
    wsCellTps: '输出速度',
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
  }
  const en = {
    summary: 'Unify the model and reasoning effort across all roles at once, or set each role individually (Lead default otherwise)',
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
    bulkTitle: 'Set every teammate model and reasoning effort at once',
    bulkAppliesAll: '(applies to all {count} roles)',
    bulkLabel: 'Model (applies to all roles)',
    bulkMixed: '(roles currently differ)',
    bulkHint: 'Both dropdowns apply to every role at once: pick a model once and every role below uses it; the same for reasoning effort (which attaches to a model, so unify the model first). Effort is recomputed when the model changes: still-valid efforts are kept, others fall back to the model default. You can still adjust any single role afterwards.',
    bulkEffortLabel: 'Reasoning effort (applies to all roles)',
    bulkEffortMixedModels: 'The roles use different models, and effort tiers are advertised per model: unify the model above first, then set one effort here.',
    bulkEffortNoModel: 'No model is unified yet (every role follows the Lead): effort attaches to a model, so pick one above first.',
    bulkEffortNone: 'This model advertises no reasoning tiers (official rule: no reasoning metadata means no tiers), so there is nothing to unify.',
    bulkEffortNoCatalog: 'The model catalog could not be read (see the warning above), so tiers cannot be checked and effort cannot be unified right now.',
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
        // '' = 跟随 Lead：把整份草稿清空（sanitizeConfig 只接受成对的 provider/model）。
        if (key === '') return next
        const record = catalog !== null ? catalog.byKey[key] : undefined
        const efforts = record === undefined ? [] : record.efforts
        for (const roleId of roleIds) {
          // 逐行已有的档位若仍被新模型支持就保留，否则退回「模型默认」。
          const previous = current[roleId] === undefined ? '' : current[roleId].effort
          const effort = efforts.some((item) => item.id === previous) ? previous : ''
          next[roleId] = { key, effort }
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
          next[roleId] = { key: row.key, effort }
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

      const children = [
        React.createElement('div', { className: 'dat-bulk-head', key: 'head' },
          React.createElement('span', { className: 'dat-bulk-title' }, text('bulkTitle')),
          React.createElement('span', { className: 'dat-id' }, text('bulkAppliesAll', { count: String(roleIds.length) }))),
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
            }, bulkOptions)),
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
            }, effortOptions))),
        React.createElement('div', { className: 'dat-bulk-hint', key: 'hint' }, text('bulkHint')),
      ]
      if (effortHint !== '') {
        children.push(React.createElement('div', { className: 'dat-note', key: 'effortHint' }, effortHint))
      }
      return React.createElement('div', { className: 'dat-bulk', key: 'bulk' }, children)
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

  /** 组件外（工作区覆盖层是命令式 DOM）用的文案：走本文件 zh 字典，缺键回退 key。 */
  function wsText(key, params) {
    const raw = typeof zh[key] === 'string' ? zh[key] : key
    return fmt(raw, params)
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
      event.stopPropagation()
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
  const ws = { root: null, timer: 0, state: null, raf: 0 }

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
  function wsRing(used, total) {
    const size = 30
    const r = (size - 6) / 2
    const c = 2 * Math.PI * r
    const u = Number(used) || 0
    const t = Number(total) || 0
    const frac = t > 0 ? Math.min(1, u / t) : 0
    const color = frac > 0.85 ? 'var(--dat-red)' : frac > 0.6 ? 'var(--dat-amber)' : 'var(--dat-blue)'
    const tip = (t > 0 ? wsFmtN(u) + ' / ' + wsFmtN(t) : '已用 ' + wsFmtN(u)) + ' 上下文'
      + (t > 0 ? '（' + Math.round(frac * 100) + '%）' : '')
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
   * Catmull-Rom → 三次贝塞尔：曲线**穿过所有途经点**且切线连续。
   * 为什么需要它：跨多层的线要依次从各列的空隙里穿过去（见 wsRoute），
   * 两段独立的三次贝塞尔在途经点处会有折角；样条保证拐弯平滑、幅度可控
   * （用户要求「线可以拐弯，但幅度不能太大」）。
   *
   * ⚠️ 关键细节：控制点必须**夹紧到本段两端点的 y 区间**。
   * 不夹紧时，相邻途经点的落差会把控制点拉出去，曲线随之过冲 ——
   * 度量探针实测（坐标证据）：d:plan-critic 从 (1666,808) 出发、途经点全在 y≈800 的缝隙里，
   * 曲线却在 x=1469 掉到 y=876，一头扎进 builder-bugfixer 的卡片。
   * 夹紧之后曲线必落在控制点凸包内（贝塞尔的性质），即 y 不会超出两端点范围，
   * 于是「两端点都避开了卡片」就蕴含「整段都避开了卡片」。
   * @param {Array<[number,number]>} points - 起点 → 途经点… → 终点。
   * @returns {string} SVG path 的 d。
   */
  function wsSpline(points) {
    if (points.length < 2) return ''
    if (points.length === 2) return wsCurveLR(points[0][0], points[0][1], points[1][0], points[1][1])
    const at = (i) => points[Math.max(0, Math.min(points.length - 1, i))]
    const f = (v) => v.toFixed(1)
    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
    let d = 'M' + f(points[0][0]) + ' ' + f(points[0][1])
    for (let i = 0; i < points.length - 1; i += 1) {
      const p0 = at(i - 1); const p1 = at(i); const p2 = at(i + 1); const p3 = at(i + 2)
      const lo = Math.min(p1[1], p2[1])
      const hi = Math.max(p1[1], p2[1])
      const c1x = p1[0] + (p2[0] - p0[0]) / 6
      const c1y = clamp(p1[1] + (p2[1] - p0[1]) / 6, lo, hi)
      const c2x = p2[0] - (p3[0] - p1[0]) / 6
      const c2y = clamp(p2[1] - (p3[1] - p1[1]) / 6, lo, hi)
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
  function wsGapY(state, r, idealY) {
    const core = state.core
    const names = state.layersByRank?.get(r) ?? []
    const inThisColumn = names.map((n) => state.byName.get(n)).filter((n) => n !== undefined)
    if (core !== null && !state.coreOpen && inThisColumn.some((n) => core.members.includes(n.name))) {
      const above = core.y - 14
      const below = core.y + core.h + 14
      // 已经走在容器上/下方就不动；落在容器里才绕（取近的一侧）。
      if (idealY <= core.y - 6 || idealY >= core.y + core.h + 6) return idealY
      return Math.abs(above - idealY) <= Math.abs(below - idealY) ? above : below
    }
    if (inThisColumn.length === 0) return idealY
    // 畅通？直接穿过去，别为了「对齐缝隙」把线拉弯。
    let blocked = null
    for (const n of inThisColumn) {
      if (idealY > n.y - 3 && idealY < n.y + WS_NODE_H + 3) {
        // 记下离 idealY 最近的那张挡路卡片。
        if (blocked === null || Math.abs(idealY - (n.y + WS_NODE_H / 2)) < Math.abs(idealY - (blocked.y + WS_NODE_H / 2))) blocked = n
      }
    }
    if (blocked === null) return idealY
    const above = blocked.y - WS_GAP_Y / 2
    const below = blocked.y + WS_NODE_H + WS_GAP_Y / 2
    return Math.abs(above - idealY) <= Math.abs(below - idealY) ? above : below
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
   * @returns {string} SVG path 的 d。
   */
  function wsRoute(state, ax, ay, bx, by, la, lb) {
    if (la === lb) {
      // 同层：从两个节点**同侧**的竖直通道绕过去。侧别由 wsGutterSide 决定
      // （最后一列没有右邻 → 走左侧），调用方的锚点侧必须与它一致。
      const side = wsGutterSide(state, la)
      const gutter = side === 'R' ? wsGutterX(la) : wsColumnX(la) - WS_GAP_X / 2
      return wsSpline([[ax, ay], [gutter, ay], [gutter, by], [bx, by]])
    }
    const points = [[ax, ay]]
    if (Number.isFinite(la) && Number.isFinite(lb)) {
      const step = lb > la ? 1 : -1
      for (let r = la + step; r !== lb; r += step) {
        const ideal = ay + ((by - ay) * (r - la)) / (lb - la)
        const gap = wsGapY(state, r, ideal)
        // 该列左右两条间隙上各一个同高度的点 → 穿越这一列的那一段是水平线，且走在缝隙里。
        const leftGutter = r > 0 ? wsGutterX(r - 1) : wsColumnX(r) - WS_GAP_X / 2
        const rightGutter = wsGutterX(r)
        if (step > 0) points.push([leftGutter, gap], [rightGutter, gap])
        else points.push([rightGutter, gap], [leftGutter, gap])
      }
    }
    points.push([bx, by])
    return wsSpline(points)
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
    if (node.delivered === true) return 'done'
    return 'idle'
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
    const out = document.createElement('span'); out.innerHTML = '<b></b> out'
    out.querySelector('b').textContent = wsFmtN(node.usage?.outputTokens ?? 0)
    const cache = document.createElement('span'); cache.innerHTML = '<b></b> cache'
    cache.querySelector('b').textContent = wsFmtN(node.usage?.cacheReadTokens ?? 0)
    const hit = document.createElement('span'); hit.className = 'hit'
    hit.title = '缓存命中率 = 缓存读取 / (缓存读取 + 新输入)'
    hit.innerHTML = '<b></b> hit'
    hit.querySelector('b').textContent = wsPct(node.cacheHit ?? 0)
    mx.append(out, cache, hit)
    body.append(model, tl, mx)

    const foot = document.createElement('div'); foot.className = 'ft'
    const dur = document.createElement('span'); dur.className = 'd'; dur.textContent = wsFmtD(node.runtimeMs ?? 0)
    const tps = document.createElement('span'); tps.className = 'd'
    tps.textContent = (node.tps ?? 0) > 0 ? node.tps.toFixed(1) + ' tps' : '—'
    const rg = document.createElement('span'); rg.className = 'rg'
    rg.appendChild(wsRing(node.pressureTokens ?? 0, node.contextWindow ?? 0))
    foot.append(dur, tps, rg)

    el.append(head, body, foot)
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
      return path
    }
    const wantFlow = (key, d, color, width) => {
      desired.set(key, { d, color, width })
    }

    // ── 锚点铺开（消星爆）──────────────────────────────────────────────────
    // 度量探针实测：改之前 Lead 的 18 条线、plan-critic 的 6 条线全部挤在**同一个点**上
    // （节点垂直中点），画出来是一团放射状毛刺 —— 这就是「连线不自然」的主因之一。
    // 现在按「同侧同方向的线」分组，把锚点沿节点边缘均匀铺开（纵向留 12px 边距）。
    // 不设上限：18 条线铺在 118px 上每条约 6.9px 间距，比共点自然得多，
    // 也不会跑出卡片（首尾各留 12px）。
    const anchorSlots = (count) => {
      const usable = WS_NODE_H - 24
      if (count <= 1) return [WS_NODE_H / 2]
      const slots = []
      for (let i = 0; i < count; i += 1) slots.push(12 + (usable * i) / (count - 1))
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

    // 分组：键 = 「谁 + 哪一侧 + 哪条边」。同组内的线共享一组铺开的锚点。
    const groups = new Map()
    const groupKey = (owner, side, dir) => owner + '|' + side + '|' + dir
    const addToGroup = (owner, side, dir, item, end) => {
      const k = groupKey(owner, side, dir)
      const list = groups.get(k) ?? []
      list.push({ item, end })
      groups.set(k, list)
    }
    for (const p of planned) {
      if (p.kind === 'handoff') {
        const la = p.a.layer ?? 0; const lb = p.b.layer ?? 0
        // 承接边：写方 → 读方。
        //   同层：两端都走右侧的竖直通道（绕节点列的外侧，不横穿卡片）；
        //   正向（lb>la）：源右侧出 → 目标左侧入；
        //   回向（lb<la）：线要往**左**走，所以源从左侧出、目标从**右侧**入
        //     （目标在更左的列，朝向来线的那条边是它的右边）。
        if (la === lb) {
          // 同层：两侧都用同一条竖直通道的侧别（由 wsGutterSide 决定），否则锚点在一侧、通道在另一侧。
          const side = wsGutterSide(state, la)
          addToGroup(p.a.name, side, 'same', p, 'from')
          addToGroup(p.b.name, side, 'same', p, 'to')
        } else if (lb > la) {
          addToGroup(p.a.name, 'R', 'fwd', p, 'from')
          addToGroup(p.b.name, 'L', 'fwd', p, 'to')
        } else {
          addToGroup(p.a.name, 'L', 'back', p, 'from')
          addToGroup(p.b.name, 'R', 'back', p, 'to')
        }
      } else {
        // 派活边：蓝（进行中）Lead 右 → 成员左；绿（已交付）成员左 → Lead 右。
        // 注意绿线的方向：Lead 在最左列，成员在右边，所以「回到 Lead」是**向左**走的，
        // 成员必须从**左**边缘出、Lead 从**右**边缘入 —— 若让成员从右边缘出，
        // 曲线会先横穿它自己的卡片再折回来（实测很难看）。
        if (p.done) {
          addToGroup(p.b.name, 'L', 'ret', p, 'from')
          addToGroup(p.a.name, 'R', 'ret', p, 'to')
        } else {
          addToGroup(p.a.name, 'R', 'disp', p, 'from')
          addToGroup(p.b.name, 'L', 'disp', p, 'to')
        }
      }
    }
    // 分配：每个分组内按「对端 y」排序，锚点自上而下铺开 —— 线与线的相对顺序和节点的相对位置一致，
    // 这样交叉最少（这也是「自然」的关键：不该出现上面节点的线跑到下面去）。
    const anchorOf = new Map()
    for (const [k, list] of groups) {
      const other = (row) => {
        const p = row.item
        if (row.end === 'from') return (p.kind === 'dispatch' ? p.a : p.b).y
        return (p.kind === 'dispatch' ? (p.done ? p.a : p.b) : p.a).y
      }
      list.sort((x, y) => other(x) - other(y))
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
      return { x: side === 'R' ? node.x + WS_NODE_W : node.x, y }
    }

    // ① 承接线（写 → 读）。
    for (const p of planned) {
      if (p.kind !== 'handoff') continue
      const { e, a, b, weak } = p
      const la = a.layer ?? 0; const lb = b.layer ?? 0
      const w = Math.min(3.2, 0.9 + ((e.weight ?? 1) - 1) * 0.55)
      const opacity = weak ? 0.2 : Math.min(0.62, 0.34 + ((e.weight ?? 1)) * 0.04)
      const anchors = anchorOf.get(p) ?? {}
      // 侧别必须与 wsRoute/分组完全一致（同层走竖直通道；正向 源R→目标L；回向 源L→目标R）。
      let fromSide; let toSide
      if (la === lb) { const s = wsGutterSide(state, la); fromSide = s; toSide = s }
      else if (lb > la) { fromSide = 'R'; toSide = 'L' }
      else { fromSide = 'L'; toSide = 'R' }
      const from = pointFor(e.from, fromSide, anchors.from)
      const to = pointFor(e.to, toSide, anchors.to)
      const d = wsRoute(state, from.x, from.y, to.x, to.y, la, lb)
      const attrs = { stroke: 'var(--dat-violet)', 'stroke-width': weak ? 0.9 : w.toFixed(2), opacity: opacity.toFixed(2) }
      if (weak) attrs['stroke-dasharray'] = '2 4'
      if (e.both === true) attrs['marker-start'] = 'url(#ws-avs)'
      attrs['marker-end'] = 'url(#ws-av)'
      const files = Array.isArray(e.files) ? e.files : []
      const key = 'h:' + e.from + '\u2192' + e.to
      addPath(key, d, attrs, e.from + ' → ' + e.to + '：' + wsText('wsSharedFiles', { count: String(e.weight ?? files.length) })
        + (files.length > 0 ? '（' + files.slice(0, 2).join(' / ') + '）' : ''))
      if (!weak) wantFlow(key, d, 'var(--dat-violet)', Math.min(2.4, w + 0.6))
    }

    // ② Lead ↔ 队员：进行中 = 蓝虚线 Lead→队员；已交付 = 绿实线 队员→Lead。
    //    路径的 M 点 = 信息流源头（蓝从 Lead 出发、绿从成员出发）→ 流光方向永远=语义方向。
    for (const p of planned) {
      if (p.kind !== 'dispatch') continue
      const { e, a, b, done } = p
      const color = done ? 'var(--dat-green)' : 'var(--dat-blue)'
      const anchors = anchorOf.get(p) ?? {}
      // 侧别与分组一致：蓝 = Lead(R) → 成员(L)；绿 = 成员(L) → Lead(R)。
      const from = done ? pointFor(e.to, 'L', anchors.from) : pointFor(e.from, 'R', anchors.from)
      const to = done ? pointFor(e.from, 'R', anchors.to) : pointFor(e.to, 'L', anchors.to)
      const la = done ? (b.layer ?? 0) : (a.layer ?? 0)
      const lb = done ? (a.layer ?? 0) : (b.layer ?? 0)
      const d = wsRoute(state, from.x, from.y, to.x, to.y, la, lb)
      const attrs = { stroke: color, 'stroke-width': 1.3, opacity: 0.5, 'marker-end': 'url(#' + (done ? 'ws-ag' : 'ws-ab') + ')' }
      if (!done) attrs['stroke-dasharray'] = '5 4'
      const key = 'd:' + e.to
      addPath(key, d, attrs, done
        ? e.to + ' → Lead：' + wsText('wsDeliveredTip', { count: String(e.reported ?? 0) })
        : 'Lead → ' + e.to + '：' + wsText('wsDispatchMsg', { count: String(e.weight ?? 0) }))
      wantFlow(key, d, color, 2.2)
    }

    // ③ 流光层调和：同 key 复用元素只改几何（动画连续），新 key 创建，消失的移除。
    if (!state.flow) desired.clear()
    for (const [key, want] of desired) {
      let el = state.flowEls.get(key)
      if (el === undefined) {
        el = wsSvg('path', { class: 'flow', pathLength: 100, 'stroke-dasharray': '9 91', 'data-flow': key })
        el.style.animationDelay = wsFlowPhase(key) + 's'
        flows.appendChild(el)
        state.flowEls.set(key, el)
      }
      if (el.getAttribute('d') !== want.d) el.setAttribute('d', want.d)
      if (el.getAttribute('stroke') !== want.color) el.setAttribute('stroke', want.color)
      if (el.getAttribute('stroke-width') !== String(want.width)) el.setAttribute('stroke-width', String(want.width))
    }
    for (const [key, el] of [...state.flowEls]) {
      if (desired.has(key)) continue
      el.remove()
      state.flowEls.delete(key)
    }

    // ④ 协作核容器（折叠态）。
    if (collapsed) {
      const box = wsSvg('rect', { class: 'corebox', x: core.x, y: core.y, width: core.w, height: core.h, rx: 12 })
      const boxTitle = wsSvg('title', {})
      boxTitle.textContent = '协作核：' + core.members.join('、') + '\n互相读写（内部 ' + core.internal + ' 对关系）。点击展开'
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
      cell(wsText('wsHit'), wsPct(totals.cacheHit ?? 0)),
      cell(wsText('wsTotalTokens'), wsFmtN(totals.totalTokens ?? 0)),
      cell(wsText('wsTotalOut'), wsFmtN(totals.outputTokens ?? 0)),
      sep(),
      cell(wsText('wsAvgTps'), (Number(totals.avgTps) || 0).toFixed(1)),
    )
    const right = document.createElement('div'); right.className = 'rt'
    const hint = document.createElement('span'); hint.className = 'hint'
    hint.textContent = wsText('wsRealData') + ' · ' + new Date().toLocaleTimeString() + (state.error === '' ? '' : ' · ' + state.error)
    // 宿主的非致命事实（例如某成员会话没有活体 agent、持久日志读取失败）如实标出来，
    // 否则「读不到的 0」和「真没跑过的 0」在画布上长得一模一样。
    if (state.notes.length > 0) {
      const noteTag = document.createElement('span'); noteTag.className = 'hint'
      noteTag.style.color = 'var(--dat-amber)'
      noteTag.textContent = '· ' + wsText('wsNotes', { count: String(state.notes.length) })
      noteTag.title = state.notes.join('\n')
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
    setText('.ws-mx span:nth-child(1) b', wsFmtN(node.usage?.outputTokens ?? 0))
    setText('.ws-mx span:nth-child(2) b', wsFmtN(node.usage?.cacheReadTokens ?? 0))
    setText('.ws-mx .hit b', wsPct(node.cacheHit ?? 0))
    const footCells = el.querySelectorAll('.ft .d')
    if (footCells.length >= 2) {
      const dur = wsFmtD(node.runtimeMs ?? 0)
      if (footCells[0].textContent !== dur) footCells[0].textContent = dur
      const tps = (node.tps ?? 0) > 0 ? node.tps.toFixed(1) + ' tps' : '—'
      if (footCells[1].textContent !== tps) footCells[1].textContent = tps
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
      const tip = (t > 0 ? wsFmtN(u) + ' / ' + wsFmtN(t) : '已用 ' + wsFmtN(u)) + ' 上下文'
        + (t > 0 ? '（' + Math.round(frac * 100) + '%）' : '')
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
    // 浮窗开着 = 用户正在看细节：自动刷新这一轮直接跳过（重绘会让抽屉里的引用变陈旧），
    // 关掉后下一轮自然接上。手动「重试」不受此限制 —— 用户明确要刷新。
    if (!first && !force && state.drawer.classList.contains('on')) return
    state.loading = true
    if (first) { state.noteEl.textContent = wsText('wsLoading'); state.noteEl.style.display = '' }
    const result = await apiCall('team-graph', { sessionId: state.sessionId })
    state.loading = false
    if (result.ok !== true || result.graph === undefined) {
      state.error = result.notEnabled === true ? wsText('wsNotEnabled') : wsText('wsLoadFailed', { message: String(result.error ?? '') })
      // 请求失败时上一轮的宿主提示已经不作数：留着会让「这轮读不到」看起来像「上轮那几条」。
      state.notes = []
      if (state.data === null) { state.noteEl.textContent = state.error; state.noteEl.style.display = '' }
      else { wsStatusbar(state) }
      return
    }
    state.error = ''
    state.notes = Array.isArray(result.notes) ? result.notes : []
    const fingerprint = wsFingerprint(result.graph)
    if (!first && !force && fingerprint === state.fingerprint) {
      // 数据没变：不重绘节点/线（流光不重启、tooltip 不闪没），但底栏的刷新时刻照常走。
      // 连续 N 轮没变就把轮询退回慢档（自适应间隔的另一半，见 schedule）。
      state.stableRounds = (state.stableRounds ?? 0) + 1
      state.changedRecently = state.stableRounds < 3
      wsStatusbar(state)
      return
    }
    state.stableRounds = 0
    state.changedRecently = true
    state.fingerprint = fingerprint
    // 新出现的成员名：给它们加入场动画（用户要求「每创建一个队友都会实时显示到工作区里面」）。
    const prevNames = state.data === null ? new Set() : new Set(state.data.nodes.map((n) => n.name))
    const fresh = new Set(result.graph.nodes.map((n) => n.name).filter((name) => !prevNames.has(name)))
    state.data = result.graph
    state.freshNames = fresh
    state.noteEl.style.display = 'none'
    if (state.data.nodes.length <= 1) {
      state.noteEl.textContent = wsText('wsEmpty')
      state.noteEl.style.display = ''
    }
    wsLayout(state)
    wsRender(state)
    if (first) {
      wsFit(state)
      // 首帧渲染完毕 → 之后出现的节点才算「新队员」，才播入场动画。
      // （这个标志以前一直是 true，导致入场动画永远不触发 —— 新队员会「凭空出现」而没有提示。）
      state.first = false
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
    const st = wsStateOf(node)
    const stLabel = st === 'running' ? wsText('wsStateRunning') : st === 'done' ? wsText('wsStateDone')
      : st === 'failed' ? wsText('wsStateFailed') : wsText('wsStateIdle')
    const cells = [
      [wsText('wsCellModel'), node.model ?? wsText('wsModelNone')],
      [wsText('wsCellStatus'), stLabel],
      [wsText('wsCellRuntime'), wsFmtD(node.runtimeMs ?? 0)],
      [wsText('wsCellTps'), (node.tps ?? 0) > 0 ? node.tps.toFixed(1) + ' tps' : '—'],
      [wsText('wsCellOut'), wsFmtN(node.usage?.outputTokens ?? 0)],
      [wsText('wsCellIn'), wsFmtN(node.usage?.uncachedInputTokens ?? 0)],
      [wsText('wsCellCache'), wsFmtN(node.usage?.cacheReadTokens ?? 0)],
      [wsText('wsCellHit'), wsPct(node.cacheHit ?? 0)],
      [wsText('wsCellCtx'), wsFmtN(node.pressureTokens ?? 0) + (node.contextWindow ? ' / ' + wsFmtN(node.contextWindow) : '')],
      [wsText('wsCellTodo'), (node.todo?.done ?? 0) + '/' + (node.todo?.running ?? 0) + '/' + (node.todo?.total ?? 0)],
      [wsText('wsCellDispatch'), wsText('wsMsgUnit', { count: String(node.dispatched ?? 0) })],
    ]
    const grid = document.createElement('div'); grid.className = 'grid'
    for (const [k, v] of cells) {
      const cell = document.createElement('div'); cell.className = 'cell'
      const key = document.createElement('div'); key.className = 'k'; key.textContent = k
      const val = document.createElement('div'); val.className = 'v'; val.textContent = v; val.title = v
      cell.append(key, val)
      grid.appendChild(cell)
    }
    body.appendChild(grid)

    const relTitle = document.createElement('h4')
    const up = state.data.edges.filter((e) => e.to === node.name)
    const down = state.data.edges.filter((e) => e.from === node.name)
    relTitle.textContent = wsText('wsDrawerRelations', { count: String(up.length + down.length) })
    body.appendChild(relTitle)
    if (up.length + down.length === 0) {
      const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = wsText('wsDrawerNoRel')
      body.appendChild(empty)
    }
    const relLine = (e, dir) => {
      const row = document.createElement('div'); row.className = 'rel'
      const ar = document.createElement('span'); ar.className = 'ar'; ar.textContent = dir === 'in' ? '←' : '→'
      const who = document.createElement('b'); who.textContent = dir === 'in' ? e.from : e.to
      const why = document.createElement('span'); why.style.color = 'var(--dat-ink-muted)'
      why.textContent = e.kind === 'dispatch' ? wsText('wsDispatchMsg', { count: String(e.weight ?? 0) })
        : wsText('wsSharedFiles', { count: String(e.weight ?? 0) })
      row.append(ar, who, why)
      return row
    }
    for (const e of up) body.appendChild(relLine(e, 'in'))
    for (const e of down) body.appendChild(relLine(e, 'out'))

    const tasks = (state.data.tasks ?? []).filter((t) => t.ownerName === node.name)
    const taskTitle = document.createElement('h4')
    taskTitle.textContent = wsText('wsDrawerTasks', { count: String(tasks.length) })
    body.appendChild(taskTitle)
    if (tasks.length === 0) {
      const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = wsText('wsDrawerNoTask')
      body.appendChild(empty)
    }
    for (const task of tasks) {
      const row = document.createElement('div'); row.className = 'tk'
      const st2 = document.createElement('span'); st2.className = 'st ' + task.status; st2.textContent = task.status
      const subject = document.createElement('span'); subject.textContent = String(task.subject ?? '').slice(0, 110)
      row.append(st2, subject)
      body.appendChild(row)
    }

    const convoTitle = document.createElement('h4'); convoTitle.textContent = wsText('wsDrawerConvo')
    body.appendChild(convoTitle)
    const convoBox = document.createElement('div'); convoBox.className = 'cv'
    convoBox.textContent = wsText('wsDrawerConvoLoading')
    body.appendChild(convoBox)
    void (async () => {
      const result = await apiCall('team-conversation', { sessionId: state.sessionId, targetId: node.id, limit: 80 })
      convoBox.textContent = ''
      if (result.ok !== true) {
        convoBox.textContent = wsText('wsDrawerConvoFailed', { message: String(result.error ?? '') })
        convoBox.className = 'empty'
        return
      }
      const rows = Array.isArray(result.rows) ? result.rows : []
      if (rows.length === 0) {
        convoBox.textContent = typeof result.note === 'string' && result.note !== '' ? result.note : wsText('wsDrawerConvoEmpty')
        convoBox.className = 'empty'
        return
      }
      for (const row of rows) {
        const turn = document.createElement('div'); turn.className = 'tr' + (row.kind === 'tool' ? ' tool' : '')
        const who = document.createElement('div'); who.className = 'who'; who.textContent = row.kind
        const msg = document.createElement('div'); msg.className = 'msg'; msg.textContent = row.text
        turn.append(who, msg)
        convoBox.appendChild(turn)
      }
    })()

    state.drawer.append(head, body)
    state.drawer.classList.add('on')
    state.maskEl.classList.add('on')
  }

  function wsCloseDrawer(state) {
    state.drawer.classList.remove('on')
    state.maskEl.classList.remove('on')
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
    coreButton.title = '互相读写的成员收进容器；展开可看内部关系'
    const flowButton = document.createElement('button'); flowButton.className = 'ws-btn ghost on'; flowButton.textContent = wsText('wsFlow')
    flowButton.title = '流光方向 = 信息流方向：Lead→队员（蓝）/ 队员→Lead（绿）/ 写→读（紫）'
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
    const marker = (id, color, back) => {
      const m = wsSvg('marker', {
        id, viewBox: '0 0 8 8', refX: back ? 1.5 : 6.5, refY: 4,
        markerWidth: back ? 5 : 5.5, markerHeight: back ? 5 : 5.5, orient: 'auto',
      })
      m.appendChild(wsSvg('path', { d: back ? 'M8 0.8 L0.8 4 L8 7.2 z' : 'M0 0.6 L7.4 4 L0 7.4 z', fill: color }))
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
    svg.append(defs, gWires, gFlows, gCore)
    const noteEl = document.createElement('div'); noteEl.className = 'ws-note'
    canvas.appendChild(svg)
    stageEl.append(canvas, noteEl)

    const legendEl = document.createElement('div'); legendEl.className = 'ws-legend'
    const statusEl = document.createElement('div'); statusEl.className = 'ws-status'

    const maskEl = document.createElement('div'); maskEl.className = 'ws-mask'
    const drawer = document.createElement('div'); drawer.className = 'ws-drawer'

    root.append(top, stageEl, legendEl, statusEl, maskEl, drawer)
    document.body.appendChild(root)

    const state = {
      sessionId, data: null, byName: new Map(), leadName: 'lead',
      zoom: 100, flow: true, weak: true, coreOpen: false, core: null,
      canvasW: 0, canvasH: 0, loading: false, error: '', notes: [], first: true, fingerprint: '',
      stableRounds: 0, changedRecently: true, freshNames: new Set(),
      root, canvas, svg, stageEl, legendEl, statusEl, noteEl, maskEl, drawer,
      zoomInput, zoomLabel: zoomValue, coreButton,
      gWires, gFlows, gCore, flowEls: new Map(), nodeEls: new Map(),
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
        void wsLoad(state, false).then(() => { if (ws.state === state) schedule() })
      }, delay)
    }
    schedule()
    void wsLoad(state, true)
  }

  function closeWorkspace() {
    if (ws.root === null) return
    // 自适应轮询用 setTimeout 链（不是 setInterval）：退出时清掉待触发的那个。
    if (ws.timer !== 0) { clearTimeout(ws.timer); ws.timer = 0 }
    const state = ws.state
    if (state !== null) {
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