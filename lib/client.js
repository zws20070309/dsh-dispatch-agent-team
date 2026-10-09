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
    // ⚠️ 正文元素的类名是 `.md`（不是 `.msg`）。2026-10-09 度量探针实测：写成 `.tr .msg`
    // 时这些规则**全是死代码**（计算样式 backgroundColor=rgba(0,0,0,0)、padding=0px），
    // 表现就是「用户消息没有气泡、正文继承默认字号」。选择器必须与 DOM 一致。
    '.dat-ws .tr .md{font-size:12.5px;line-height:21px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary,#191919)}' +
    // 工具行：官方次要行规格收小到 12.5px/21px（与正文一致，读起来齐整）。
    '.dat-ws .trow{display:flex;align-items:baseline;gap:10px;font-size:12.5px;line-height:21px;color:var(--dsw-alias-label-secondary,#63636a);padding:0}' +
    '.dat-ws .trow .tl{flex:none;color:var(--dsw-alias-label-secondary,#63636a)}' +
    '.dat-ws .trow .tt{font-family:var(--dsw-font-family,inherit);font-size:12.5px;line-height:21px;color:var(--dsw-alias-label-tertiary,#9a9aa1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}' +
    '.dat-ws .trow.err .tl{color:var(--dsw-alias-state-error-primary,#dc2626)}' +
    '.dat-ws .trow.group{justify-content:flex-start;font-size:12.5px;line-height:21px;color:var(--dsw-alias-label-tertiary,#9a9aa1)}' +
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
    // 提问卡：官方 QuestionComposer 用面板底色 + 圆角 + 阴影，而不是彩色描边。
    '.dat-ws .qcard{border:1px solid var(--dsw-alias-border-l2,#e5e5e6);border-radius:var(--dsw-radius-lg,10px);' +
    'padding:12px 14px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:var(--dsw-elevation-soft,0 1px 2px rgba(0,0,0,.04))}' +
    '.dat-ws .qcard.done{background:var(--dsw-alias-bg-layer-2,#fafafa);box-shadow:none}' +
    '.dat-ws .qcard .qhd{font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary,#9a9aa1);margin-bottom:6px;letter-spacing:.02em}' +
    '.dat-ws .qcard.done .qhd{color:var(--dsw-alias-label-tertiary,#9a9aa1)}' +
    '.dat-ws .qcard .qtext{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#191919);white-space:pre-wrap;word-break:break-word}' +
    '.dat-ws .qopts{display:flex;flex-direction:column;gap:6px;margin-top:10px}' +
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
    '.dat-ws .composer{flex:none;display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end;' +
    'border-top:1px solid var(--dsw-alias-border-l2,#e5e5e6);padding-top:10px}' +
    '.dat-ws .composer .cin{grid-column:1;resize:none;font:inherit;font-size:13px;line-height:20px;padding:8px 10px;border-radius:var(--dsw-radius-md,8px);' +
    'border:1px solid var(--dsw-alias-border-l2,#e5e5e6);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;min-height:36px;max-height:120px;overflow:auto}' +
    '.dat-ws .composer .cin:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#2563eb)}' +
    '.dat-ws .composer .send{grid-column:2;align-self:end}' +
    '.dat-ws .composer .sendnote{grid-column:1/-1;font-size:11px;color:var(--dat-ink-muted);min-height:14px}' +
    '.dat-ws .composer .sendnote.err{color:var(--dat-red)}' +
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
    wsQSentAsMsg: '已作为消息发送（该问题在官方界面等待作答）',
    wsSendPlaceholder: '给 {name} 发消息…（Enter 发送，Shift+Enter 换行）',
    wsSend: '发送',
    wsSending: '发送中…',
    wsSent: '已发送',
    wsSendFailed: '发送失败：{message}',
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
   * 用户 2026-10-09：「不要让拓扑线有任何重叠，非常丑」——截图里三条线在同一个
   * 缝隙高度上叠成一条粗彩线，就是因为穿越高度按「最近缝隙」计算、彼此会聚。
   * 现在每条线在通道内分到**不同的道**（见 assignLanes）。
   *
   * ⚠️ 为什么是 12 不是 6：用户在 **45% 缩放**下看画布，6px 用户间距 = 屏幕上
   * 2.7px，肉眼仍是一条粗线（分道生效了却"看着还叠"）。12px 在 45% 下约 5.4px，
   * 才真的分得开。列的无卡空间有几百 px，装得下十几条道。
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
   *   | C:\Users\ZWS | 0 命中 |
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
      const sgn = Math.sign(totDx) || 1
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
    let blocked = null
    for (const n of inThisColumn) {
      if (idealY > n.y - 3 && idealY < n.y + WS_NODE_H + 3) {
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
      // 同层：从两个节点**同侧**的竖直通道绕过去。侧别由 wsGutterSide 决定
      // （最后一列没有右邻 → 走左侧），调用方的锚点侧必须与它一致。
      const side = wsGutterSide(state, la)
      const base = side === 'R' ? wsGutterX(la) : wsColumnX(la) - WS_GAP_X / 2
      // 共用同一条 gutter 的多条线按分道横向错开（否则竖直段整段重合）。
      const maxOff = WS_GAP_X / 2 - 6
      const off = Math.max(-maxOff, Math.min(maxOff, lane?.gutter ?? 0))
      const gutter = base + off
      return wsRoundPath([[ax, ay], [gutter, ay], [gutter, by], [bx, by]])
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
    if (lane?.gut?.g === Math.min(la, lb) && Math.abs(lb - la) === 1) {
      points.push([wsGutterX(lane.gut.g), lane.gut.y])
    }
    if (Number.isFinite(la) && Number.isFinite(lb)) {
      const step = lb > la ? 1 : -1
      for (let r = la + step; r !== lb; r += step) {
        const ideal = ay + ((by - ay) * (r - la)) / (lb - la)
        // 分道优先：同一条缝里的多条线各占一道（见 wsDrawWires 的 assignLanes）。
        const assigned = lane?.y?.get(r)
        const gap = assigned !== undefined ? assigned : wsGapSlot(state, r, ideal).y
        // 该列左右两条间隙上各一个同高度的点 → 穿越这一列的那一段是水平线，且走在缝隙里。
        const leftGutter = r > 0 ? vxOf(r - 1) : wsColumnX(r) - WS_GAP_X / 2
        const rightGutter = vxOf(r)
        if (step > 0) points.push([leftGutter, gap], [rightGutter, gap])
        else points.push([rightGutter, gap], [leftGutter, gap])
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
      // 端点**贴住卡片边缘**：不往外退。退让会让箭头浮在离卡片十几 px 的地方（很难看）；
      // 箭头被卡片盖住的问题由「水平短桩 + refX=9」解决（见 wsRoute / marker 注释）。
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
      const bands = []
      let cursor = 4
      for (const n of cards) {
        if (n.y - 3 > cursor) bands.push([cursor, n.y - 3])
        cursor = Math.max(cursor, n.y + WS_NODE_H + 3)
      }
      const bottom = (Number.isFinite(state.canvasH) && state.canvasH > 0 ? state.canvasH : 1e4) - 4
      if (bottom > cursor) bands.push([cursor, bottom])
      const slots = []
      for (const [lo, hi] of bands) {
        for (let y = lo; y <= hi; y += WS_LANE_GAP) slots.push(y)
        if (slots.length === 0 || slots[slots.length - 1] < hi) slots.push(hi)
      }
      return slots.sort((a, b) => a - b)
    }
    // 按列收集要跨的线（含同层线：它们也要在竖直通道里分道，见下）。
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
    // 历史快照（团队已结束，数据从日志/投影缓存恢复）：**常驻**标出来，不藏在悬停里。
    // 否则底栏写着「真实会话日志」会让用户以为团队还在跑（用户 2026-10-08 的场景就是额度耗尽后看历史）。
    const snapshot = state.notes.some((n) => n.includes('团队可能已结束') || n.includes('历史成员'))
    if (snapshot) {
      const tag = document.createElement('span'); tag.className = 'hint'
      tag.style.color = 'var(--dat-amber)'
      tag.textContent = '· ' + wsText('wsSnapshot')
      tag.title = state.notes.join('\n')
      right.appendChild(tag)
    }
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
    let result
    try {
      result = await apiCall('team-graph', { sessionId: state.sessionId })
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
      state.notes = []
      if (state.data === null) { state.noteEl.textContent = state.error; state.noteEl.style.display = '' }
      else { wsStatusbar(state) }
      return
    }
    // 形状闸门：宿主契约漂移（缺 nodes/edges）时必须在**这里**拦住并给出可读错误。
    // 否则后面 wsFingerprint 读 graph.nodes.length 会抛 TypeError，而那个抛出点以前
    // 在 try 之外 → 一路冒泡到轮询链的 .then（无 catch）→ **链永久死亡、画布冻结且无提示**。
    if (!Array.isArray(result.graph.nodes) || !Array.isArray(result.graph.edges)) {
      state.error = wsText('wsLoadFailed', { message: '宿主返回的图缺少 nodes/edges 字段' })
      state.notes = []
      if (state.data === null) { state.noteEl.textContent = state.error; state.noteEl.style.display = '' }
      else { wsStatusbar(state) }
      return
    }
    state.error = ''
    state.notes = Array.isArray(result.notes) ? result.notes : []
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

    // ⚠️ 用户 2026-10-08 明确要求：**不要**「关系」「任务」这些噪音区块。
    // 原话：「图中画的蓝色区域不要放这些没用的什么记忆文件注入、消息啥的，我点击了一个卡片后
    // 想看到的是 [指标] 这个保留，下面是 [对话窗口]」。
    // 所以浮窗现在只有两块：① 指标格（保留）② 对话正文（占满剩余高度、自己滚动）。
    // 「关系/任务」的信息在画布上（连线 + 悬停 tooltip）与 DSH 自己的任务面板里都有，
    // 塞进浮窗只会把用户真正想看的对话挤到屏幕外。

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
    void (async () => {
      const result = await apiCall('team-conversation', { sessionId: state.sessionId, targetId: node.id, limit: 80 })
      if (state.drawerToken !== token) return
      convoBox.textContent = ''
      if (result.ok !== true) {
        convoBox.textContent = wsText('wsDrawerConvoFailed', { message: String(result.error ?? '') })
        convoBox.className = 'cv empty'
        return
      }
      const rows = Array.isArray(result.rows) ? result.rows : []
      if (rows.length === 0) {
        convoBox.textContent = typeof result.note === 'string' && result.note !== '' ? result.note : wsText('wsDrawerConvoEmpty')
        convoBox.className = 'cv empty'
        return
      }
      // 渲染口径复刻官方原始界面（用户 2026-10-09：「弹窗要像在原始界面看到的界面一样，
      // 能看到读取文件、修改文件、调用工具等等」）：
      //   * 助手正文走 markdown 渲染（之前 textContent 直出 → 全是裸 `**`/`###`，用户叫它「乱码」）；
      //   * 工具调用是**逐条一行**「已读取文件 + 目标」（后端已按官方 activity() 字典出标签）；
      //   * ask_user_question 不在这里出现 —— 它渲染成下面的选择型提问卡。
      const whoOf = (kind) => wsText(kind === 'user' ? 'wsWhoUser'
        : kind === 'assistant' ? 'wsWhoAssistant'
          : kind === 'tools' ? 'wsWhoTools'
            : kind === 'team' ? 'wsWhoTeam'
              : kind === 'notice' ? 'wsWhoNotice' : 'wsWhoSystem')
      for (const row of rows) {
        if (row.kind === 'tool' || row.kind === 'toolgroup') {
          const trow = document.createElement('div')
          trow.className = 'trow' + (row.error === true ? ' err' : '') + (row.kind === 'toolgroup' ? ' group' : '')
          const tl = document.createElement('span'); tl.className = 'tl'
          tl.textContent = row.kind === 'toolgroup' ? row.text : (row.text + (row.error === true ? '（失败）' : ''))
          trow.appendChild(tl)
          if (row.detail !== undefined && row.detail !== '') {
            const tt = document.createElement('span'); tt.className = 'tt'; tt.textContent = row.detail; tt.title = row.detail
            trow.appendChild(tt)
          }
          convoBox.appendChild(trow)
          continue
        }
        const turn = document.createElement('div'); turn.className = 'tr' + (row.kind === 'user' ? ' mine' : '')
        // 官方 MessageItem 只给**用户消息**渲染气泡行（.userRow/.bubble），助手正文
        // **没有角色标签**、直接铺 markdown（官方 CSS 模块里根本没有 assistantRow 类）。
        // 所以这里只对非用户行加 who 标签（团队/系统消息需要说明来源），
        // 助手与用户都不加 —— 与官方一致。
        const msg = document.createElement('div'); msg.className = 'md'
        if (row.kind === 'assistant') msg.innerHTML = wsMarkdown(row.text)
        else msg.textContent = row.text
        if (row.kind !== 'assistant' && row.kind !== 'user') {
          const who = document.createElement('div'); who.className = 'who'; who.textContent = whoOf(row.kind)
          turn.appendChild(who)
        }
        turn.appendChild(msg)
        convoBox.appendChild(turn)
      }
      // 打开即看到**最新**内容（对话是「尾部」，用户想看的是最后发生了什么）。
      convoBox.scrollTop = convoBox.scrollHeight
    })()

    // ④ 待回答的提问（用户 2026-10-08：「他提问的时候我在工作区看不到也收不到任何的提问信息」）。
    //    数据来自会话日志里的 ask_user_question（不是官方投影——那个默认模式下恒为空）。
    //    放在**输入框上方**：提问是要用户回答的，必须紧贴回复入口。
    const qBox = document.createElement('div'); qBox.className = 'qbox'
    body.appendChild(qBox)

    // ⑤ 聊天输入框（用户：「我需要这样一个聊天框这个窗口回答问题，以及向 lead 提问以及发送下一步指令」）。
    const composer = document.createElement('div'); composer.className = 'composer'
    const input = document.createElement('textarea')
    input.className = 'cin'; input.rows = 1
    input.placeholder = wsText('wsSendPlaceholder', { name: node.name })
    const sendBtn = document.createElement('button')
    sendBtn.className = 'ws-btn primary send'; sendBtn.textContent = wsText('wsSend')
    const sendNote = document.createElement('div'); sendNote.className = 'sendnote'
    composer.append(input, sendBtn, sendNote)
    body.appendChild(composer)

    // 输入框自增高（1~6 行），Enter 发送 / Shift+Enter 换行。
    const autoGrow = () => {
      input.style.height = 'auto'
      input.style.height = Math.min(120, Math.max(30, input.scrollHeight)) + 'px'
    }
    input.addEventListener('input', autoGrow)
    const doSend = async () => {
      const text = input.value.trim()
      if (text === '' || sendBtn.disabled) return
      sendBtn.disabled = true
      sendNote.className = 'sendnote'
      sendNote.textContent = wsText('wsSending')
      const result = await apiCall('team-send', { sessionId: state.sessionId, targetId: node.id, text })
      if (state.drawerToken !== token) return
      sendBtn.disabled = false
      if (result.ok !== true) {
        sendNote.className = 'sendnote err'
        sendNote.textContent = wsText('wsSendFailed', { message: String(result.error ?? '') })
        return
      }
      input.value = ''
      autoGrow()
      sendNote.textContent = wsText('wsSent')
      window.setTimeout(() => { if (sendNote.textContent === wsText('wsSent')) sendNote.textContent = '' }, 2000)
      // 立刻把这条消息画进对话（不等下一轮轮询），用户才有「发出去了」的确定感。
      const turn = document.createElement('div'); turn.className = 'tr mine'
      const who = document.createElement('div'); who.className = 'who'; who.textContent = wsText('wsWhoMe')
      const msg = document.createElement('div'); msg.className = 'msg'; msg.textContent = text
      turn.append(who, msg)
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
    void (async () => {
      const result = await apiCall('team-questions', { sessionId: state.sessionId, targetId: node.id })
      if (state.drawerToken !== token) return
      const questions = Array.isArray(result?.questions) ? result.questions : []
      if (questions.length === 0) return
      const byCall = new Map()
      for (const q of questions) {
        const k = q.callId !== '' ? q.callId : 't:' + q.time
        const list = byCall.get(k) ?? []
        list.push(q)
        byCall.set(k, list)
      }
      const open = questions.filter((q) => q.answered !== true).length
      // 标题行可点折叠（用户 2026-10-09：「待你回答（0 条）可以收下去，不要全部展开」）。
      // 默认态：有待答 → 展开（那是需要用户处理的事）；全答完 → 收起（只留一行，
      // 把高度让给对话正文）。
      const qHead = document.createElement('button')
      qHead.type = 'button'; qHead.className = 'qh'
      const title = document.createElement('h4')
      title.textContent = wsText('wsQuestions', { count: String(open) })
      const chev = document.createElement('span'); chev.className = 'chev'; chev.textContent = '▾'
      qHead.append(title, chev)
      qHead.addEventListener('click', () => {
        const folded = qBox.classList.toggle('folded')
        chev.textContent = folded ? '▸' : '▾'
      })
      qBox.appendChild(qHead)
      if (open === 0) {
        qBox.classList.add('folded')
        chev.textContent = '▸'
      }
      let anyOpen = false
      for (const [callId, items] of byCall) {
        const answeredAll = items.every((q) => q.answered === true)
        const card = document.createElement('div')
        card.className = 'qcard' + (answeredAll ? ' done' : '')
        if (answeredAll) {
          // 只读回看：每题一行「问题 → 已选答案」（官方 reviewPanel 同语义）。
          const hd = document.createElement('div'); hd.className = 'qhd'; hd.textContent = wsText('wsQAnswered')
          card.appendChild(hd)
          for (const q of items) {
            const ans = document.createElement('div'); ans.className = 'qans'
            const b = document.createElement('b'); b.textContent = (q.header !== '' ? q.header + '：' : '') + q.question
            ans.appendChild(b)
            ans.appendChild(document.createTextNode(' ' + (q.answer !== '' ? q.answer : wsText('wsQAnswerBlank'))))
            card.appendChild(ans)
          }
          qBox.appendChild(card)
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
          const answers = items.map((q, i) => ({
            id: q.id,
            selected: drafts[i].selected,
            custom: drafts[i].custom.trim() !== '' ? drafts[i].custom.trim() : undefined,
          }))
          void (async () => {
            const r = await apiCall('team-answer', { sessionId: state.sessionId, targetId: node.id, callId, answers })
            if (state.drawerToken !== token) return
            if (r.ok !== true) {
              note.textContent = wsText('wsSendFailed', { message: String(r.error ?? '') })
              submit.disabled = false
              return
            }
            // 提交成功：卡片就地翻成只读（用户不该再点第二次）。
            card.className = 'qcard done'
            card.textContent = ''
            const hd = document.createElement('div'); hd.className = 'qhd'; hd.textContent = wsText('wsQAnswered')
            card.appendChild(hd)
            items.forEach((q, i) => {
              const ans = document.createElement('div'); ans.className = 'qans'
              const b = document.createElement('b'); b.textContent = (q.header !== '' ? q.header + '：' : '') + q.question
              ans.append(b, document.createTextNode(' ' + (drafts[i].selected.join('、') || drafts[i].custom.trim())))
              card.appendChild(ans)
            })
            note.textContent = r.via === 'message' ? wsText('wsQSentAsMsg') : wsText('wsQAnsweredOk')
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
        qBox.appendChild(card)
      }
      if (anyOpen) {
        // 有提问时聚焦输入框方便下一步。⚠️ 必须 preventScroll（用户 2026-10-09 报
        // 「顶端基本信息消失」的根因）：.db 是 overflow:hidden 的 flex 列，focus()
        // 会让浏览器滚动容器把输入框滚进视野 —— 顶部指标格整块被推出可视区。
        input.focus({ preventScroll: true })
        convoBox.scrollTop = convoBox.scrollHeight
      }
    })()

    // 把手在 openWorkspace 里建好挂在 state 上：drawer.textContent='' 会连它一起清掉，
    // 所以每次开抽屉都要重新 append（它自带 pointerdown，重挂不丢逻辑）。
    state.drawer.append(head, body)
    if (state.resizer !== undefined) state.drawer.appendChild(state.resizer)
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
    resizer.title = '拖动调整宽度'
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
      stableRounds: 0, changedRecently: true, freshNames: new Set(),
      root, canvas, svg, stageEl, legendEl, statusEl, noteEl, maskEl, drawer,
      zoomInput, zoomLabel: zoomValue, coreButton,
      gWires, gFlows, gCore, flowEls: new Map(), nodeEls: new Map(),
      resizer,
      syncMarkers: wsSyncMarkers,
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