// 调度模式智能体团队 —— 角色表与配置模型（共享模块，无外部依赖）
//
// 本文件是 host 半、preset 半、client 半三方共用的**唯一真值**：
//   * 角色 id 表（队员名必须由它推导，见 deriveRole）
//   * 配置文件形状与净化（sanitizeConfig）
//   * 角色 → LLM 路由解析（resolveRoleRoute）
//   * 队员命名（nextTeammateName）与名字校验（isValidTeammateName）
//   * 队员的能力面常量（MEMBER_TEAM_TOOL_NAMES / TEAMMATE_TOOL_DENY / TEAMMATE_SECTION_MUTES）
//
// 任何对角色 id 的改动都会同时影响：模型/强度配置页、spawn_teammate 校验、
// 角色表提示词段、drift-check 与 selftest。改前先看 README 的「维护」一节。

import { KEEPALIVE_MODES, clampIntervalSeconds } from './cache.js';

/** 配置文件格式版本。结构不兼容变更时必须 +1，并在 sanitizeConfig 里做迁移。 */
export const CONFIG_VERSION = 1;

/** 配置文件路径（相对 DSH 主目录）。 */
export const CONFIG_FILENAME = 'dispatch-agent-team.json';

/** 队员专用结构化汇报工具名（Lead 不注册；见 MEMBER_TEAM_TOOL_NAMES 的注释）。 */
export const REPORT_TOOL_NAME = 'report_result';

/**
 * 本插件**自己加的** Lead 专属工具名（不属于官方那九个，所以不进 TEAM_TOOL_NAMES —— 那张表
 * 是与官方工具面逐名对齐的镜子，drift-check 靠它发现官方改名）。
 *
 * `wake_teammate`：把一个**因输出上限被截断而停下**的队员叫醒续写。
 * 依据（截图 2026-10-01 + 会话日志）：一些第三方模型会撞输出上限，turn 直接结束、状态变
 * inactive，`report_result` 也没发出来；此前只能由用户在输入框里手打「继续」。这个工具把
 * 「续写」这件事交给 Lead，并固定措辞（从断点续、不重头再来、立刻汇报）。
 */
export const WAKE_TOOL_NAME = 'wake_teammate';

/**
 * `broadcast_message`：Lead 一次把同一条消息发给多个队员。
 * 依据（2026-10-04 审查 §8 建议 B，真实会话日志取证）：某可视交付任务会话里 Lead 对 4 个 builder
 * **逐条 send_message 同一份协议变更**（seq 544/547/550、400/404/408），纯重复且会漏发。
 * 它不是新的域语义：内部就是对每个目标调用官方 sendMessage。
 */
export const BROADCAST_TOOL_NAME = 'broadcast_message';

/**
 * `ask_lead`：队员在任务**中途**向 Lead 提一个需要拍板的问题（区别于 report_result 的交付时判定）。
 * 依据（2026-10-04 审查 §8 建议 C + P2-30）：官方挡掉了队员的 ask_user_question
 * （dsh-user-questions/lib/index.js:531-535 抛 DELEGATED_CALLER），而 TEAMMATE_CARD 的纪律是
 * 「有问题停下来报告给 Lead」；此前队员只有自由文本 send_message，Lead 无法机器区分
 * 「进度汇报」与「我在等你拍板」。
 */
export const ASK_LEAD_TOOL_NAME = 'ask_lead';

/**
 * 固定前缀：让 Lead 一眼分清「等决策的提问」与进度消息。官方投递框架只给发件人
 * （dsh-experimental-agent-team/lib/index.js:971-976），没有类型位，所以前缀由我们自己加。
 * @param question - 队员的问题正文（调用方已去空白/限长）。
 * @param blocking - false = 队员继续做不受影响的部分；其余（含 undefined）= 停下等答复。
 * @returns 投递给 lead 的消息正文。
 */
export function askLeadMessage(question, blocking) {
  const text = typeof question === 'string' ? question.trim() : '';
  const head = blocking === false ? '[可继续][需 Lead 决策]' : '[阻塞·等答复][需 Lead 决策]';
  return head + ' ' + (text === '' ? '（队员没有写清问题，请让它补充）' : text);
}

/**
 * 截断标志的固定诊断文本（由 list_agents 附给「上一轮撞输出上限、且没有交付报告」的队员行）。
 * 放进 diagnostics 数组而不是新增字段：那个字段官方 schema 里已有（MEMBER_VIEW_SCHEMA），
 * 不用改 Lead 的工具目录（工具 schema 属于请求前缀，能不变更就不变更）。
 */
export const TRUNCATED_DIAGNOSTIC = '上一轮 turn 因输出上限结束且未交付 report_result：用 wake_teammate 叫它从断点续写。';

/**
 * 规划一次广播的目标（纯函数，可单测）。
 *
 * 为什么默认只发给 **running** 的队员（2026-10-04 审查 §8 建议 B 的成本警告）：
 * 官方 send_message 对 inactive 目标会**启动/唤醒一个新的 turn**
 * （dsh-experimental-agent-team 的投递链：dispatchOnce → steerHostSubagentPrompt →
 * deliverFollowup 的 coldResume），所以「广播给全体队员」实际会把所有停着的队员都拉起来干活，
 * 与 Lead 的成本预期直接冲突。要那种效果必须显式 includeInactive=true。
 * 但**显式点名**的目标不受这条限制：点名本身就是 Lead 的明确决定（等价于对它单独 send_message），
 * 再拦一次只会让工具变得不可预测。
 *
 * @param members - listMembers 风格的行（{name, role, status}），可含 lead 伪行。
 * @param options - {targets?, includeInactive?, callerName?}。
 * @returns {{targets:string[], skipped:{target:string, reason:string}[]}}
 */
export function planBroadcastTargets(members, options = {}) {
  const rows = Array.isArray(members) ? members : [];
  const includeInactive = options.includeInactive === true;
  const callerName = typeof options.callerName === 'string' ? options.callerName.trim() : '';
  const requested = Array.isArray(options.targets) && options.targets.length > 0
    ? options.targets.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item !== '')
    : null;
  const skipped = [];
  const targets = [];
  const seen = new Set();
  const byName = new Map(rows.map((row) => [String(row?.name ?? ''), row]));
  const consider = (row, explicit) => {
    const name = String(row?.name ?? '');
    if (name === '') return;
    if (seen.has(name)) return;
    seen.add(name);
    if (row?.role !== 'teammate') { skipped.push({ target: name, reason: '不是队员（lead 伪行或无名字）' }); return; }
    if (callerName !== '' && name === callerName) { skipped.push({ target: name, reason: '官方禁止给自己发消息（TEAM_SELF_MESSAGE）' }); return; }
    // 显式点名 = Lead 已经做出选择，与它直接对该队员调 send_message 等价，不再二次拦截；
    // 闸门只管**未点名（广播全体）**时的意外唤醒 —— 那才是 Lead 没意识到的成本。
    if (explicit !== true && !includeInactive && row?.status !== 'running' && row?.status !== 'provisioning') {
      skipped.push({ target: name, reason: `状态是 ${String(row?.status ?? '未知')}，广播默认不唤醒停着的队员（会额外开 turn）；确有其事请带 includeInactive=true 重发` });
      return;
    }
    targets.push(name);
  };
  if (requested === null) {
    for (const row of rows) consider(row, false);
  } else {
    for (const name of requested) {
      // 名字优先；名字对不上再按 agent id 认（与 lib/tools.js 的 resolveTarget 同一兼容策略：
      // 官方 subagent-control 的同名工具用 agent_id，会话里出现过那个形状，模型会照抄）。
      const row = byName.get(name) ?? rows.find((candidate) => candidate?.id === name);
      if (row === undefined) { skipped.push({ target: name, reason: '名单里没有这个队员（名字或 id 都对不上，用 list_agents 查）' }); continue; }
      consider(row, true);
    }
  }
  return { targets, skipped };
}

/**
 * Lead 的团队工具名单：官方九个 + 本插件为 Lead 另加的两个（wake_teammate / broadcast_message）。
 * Lead 的安装传这个名字表（不传 undefined），于是名单本身就是「Lead 能看见什么」的唯一真值。
 */
export const LEAD_TEAM_TOOL_NAMES = Object.freeze([
  'spawn_teammate',
  'send_message',
  'list_agents',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
  WAKE_TOOL_NAME,
  BROADCAST_TOOL_NAME,
]);

/**
 * 把「上一轮撞了输出上限且没交付」的队员行附上一条固定诊断（纯函数，可单测）。
 *
 * 为什么走 diagnostics 而不是新增字段（2026-10-04 审查 §8 建议 A）：
 *   * `diagnostics` 本来就在成员行的 schema 里（官方 listMembers 用它放创建失败原因），
 *     不新增字段 = 不动 Lead 的工具目录 = 不动每次请求的缓存前缀；
 *   * 截断这件事的真实来源是官方 turn/end 的 reason.kind === 'max-tokens'
 *     （dsh-agent-loop/lib/index.js:1151 产生、:979 turn 内聚合、:1027-1030 写入事件），
 *     插件在宿主 ctx 上监听 session/event 记账（官方 agent-team 自己就是这么用的：
 *     dsh-experimental-agent-team/lib/index.js:1720-1722）。
 *
 * @param rows - 官方 listMembers 的原始行（含 id/role/diagnostics）。
 * @param truncatedIds - 被判定截断的 agent id 集合（Set 或数组）。
 * @returns 新数组；被标记的行拿到一份新的 diagnostics，**不修改入参**。
 */
export function annotateTruncatedMembers(rows, truncatedIds) {
  const flagged = truncatedIds instanceof Set ? truncatedIds : new Set(Array.isArray(truncatedIds) ? truncatedIds : []);
  const list = Array.isArray(rows) ? rows : [];
  if (flagged.size === 0) return [...list];
  return list.map((row) => {
    if (row === null || typeof row !== 'object') return row;
    if (row.role !== 'teammate' || !flagged.has(row.id)) return row;
    const current = Array.isArray(row.diagnostics) ? row.diagnostics : [];
    if (current.includes(TRUNCATED_DIAGNOSTIC)) return row;
    return { ...row, diagnostics: [...current, TRUNCATED_DIAGNOSTIC] };
  });
}

/**
 * 重试标志的固定前缀（由 list_agents 附给「最近一次请求被宿主自动重试过」的队员行）。
 *
 * 与 TRUNCATED_DIAGNOSTIC 同法：放进成员行**已有**的 diagnostics 字段，不新增字段
 * ——新增字段就是改 Lead 的工具目录，也就是动每次请求的缓存前缀。
 * 为什么值得让 Lead 看见：宿主本来就在自动退避，而插件此前把 llm/retry 整个丢掉，
 * 于是「被限流打死的队员」与「干完了忘了交报告的队员」在状态面上长得一模一样。
 * 只报事实（失败码 / 线路 / 第几次 / 等了多久），不替 Lead 推断该不该采取行动。
 */
export const RETRY_DIAGNOSTIC_PREFIX = '最近一次请求被宿主自动重试：';

/**
 * 把有重试记录的队员行附上一条诊断（纯函数，可单测）。
 *
 * @param rows - 官方 listMembers 的原始行（含 id/role/diagnostics）。
 * @param retryBy - agentId → 摘要文本（Map 或普通对象）；空 = 原样返回。
 * @returns 新数组；被标注的行拿到一份新的 diagnostics，**不修改入参**。
 */
export function annotateRetriedMembers(rows, retryBy) {
  const list = Array.isArray(rows) ? rows : [];
  const lookup = retryBy instanceof Map ? retryBy : new Map(Object.entries(retryBy ?? {}));
  if (lookup.size === 0) return [...list];
  return list.map((row) => {
    if (row === null || typeof row !== 'object') return row;
    if (row.role !== 'teammate') return row;
    const summary = lookup.get(row.id);
    if (typeof summary !== 'string' || summary === '') return row;
    const note = RETRY_DIAGNOSTIC_PREFIX + summary;
    const current = Array.isArray(row.diagnostics) ? row.diagnostics : [];
    if (current.includes(note)) return row;
    return { ...row, diagnostics: [...current, note] };
  });
}

/**
 * 十二个可选队员角色。`writes` 是**建议**写域语义（Lead 仍须在共享任务上逐条收紧）。
 * 顺序即配置页与角色表的展示顺序：**按工作流阶段排列**（先查事实 → 再审问题集与计划 →
 * 再落地与集成 → 再验证与对抗 → 最后简化与记录），也是 Lead 优先考虑的顺序。
 *
 * ⚠️ 角色的区分**只体现在 Lead 派活时的提示词里**（见 playbook.js 的 teammateBrief）：
 * 所有队员的系统提示词是同一份 TEAMMATE_CARD，逐字节相同，这样队员之间的提示词前缀
 * 才能共用同一份缓存。因此本表的每一项都必须能写进一段自包含的派活提示词，
 * 而不是「只有角色卡里写了才有用」。
 */
export const ROLES = Object.freeze([
  Object.freeze({
    id: 'researcher',
    label: '外部调研',
    labelEn: 'Researcher',
    mission: '把「仓库之外」的事实查清楚：已安装依赖的真实实现、上游源码、官方文档、外部 API 与规范。只报告你亲自读到的内容。',
    duties: [
      '查因外部知识才能定的事：依赖包的活体实现、上游版本差异、官方文档/API 契约、外部规范；每条结论带 URL 或 文件路径:行号。',
      '优先读**本机真实安装的那一份**，再读官方文档；两者冲突时以本机实跑/实读为准并写明冲突。',
      '区分事实 / 推测 / 未知；查不到就写「未找到证据」并列出检索过的入口。',
      '报告结尾给「对 Lead 决策有用的 3 条以内结论」，不要长篇转述资料。',
    ],
    writes: '只读；仅可写你自己的报告文件',
    when: '需要仓库之外的事实：已安装依赖的真实行为、上游版本差异、官方文档与 API 契约、外部规范。',
  }),
  Object.freeze({
    id: 'scout',
    label: '探索调研',
    labelEn: 'Scout',
    mission: '把**本仓库**的事实查清楚：代码位置、真实行为、依赖关系、配置语义。只报告你亲自读到的东西。',
    duties: [
      '用 read/grep/glob/只读 shell 定位事实，每条结论带 文件路径:行号 或可复现命令。',
      '区分事实 / 推测 / 未知；查不到就写「未找到证据」并列出检索过的位置。',
      '不写业务实现（除了你自己的报告文件）；不修改被调研的代码。',
      '报告结尾给「对 Lead 决策有用的 3 条以内结论」，不要长篇复述代码。',
    ],
    writes: '只读；仅可写你自己的报告文件',
    when: '任何需要落地到证据的问题：接口形状、现有实现、配置语义、调用链路、回归风险。',
  }),
  Object.freeze({
    id: 'frontier-auditor',
    label: '前沿审查',
    labelEn: 'Frontier Auditor',
    mission: '在 Lead 宣布「问完了」之前审查设计树：找出被静默假设、被跳过、或还没问过就当作已定的分支。',
    duties: [
      '只审**问题集**，不审方案：哪些决定的前提还没落定、哪些分支从没被问过、哪些前提是沉默假设。',
      '逐条给出「缺的那一问」+ 它阻塞了下游哪几件事，按会不会导致返工排序。',
      '用已确认的事实核对：设计树里的哪条前提与代码/文档的实际情况不符。',
      '不要重写设计树、不要替用户拍板；只给最小补充清单。',
    ],
    writes: '只读',
    when: 'Lead 认为前沿快空了、准备进入落地之前；需求模糊、或改动跨模块/不可逆时必叫。',
  }),
  Object.freeze({
    id: 'plan-critic',
    label: '计划审查',
    labelEn: 'Plan Critic',
    mission: '在动手之前把**已经写出来的计划**打穿：缺口、不可行处、隐藏假设、越界、成本误判。',
    duties: [
      '逐条对照计划与证据（文件/行号），指出计划里没有依据的断言。',
      '主动找反例：让计划失败的输入、时序、并发、权限、升级场景。',
      '区分 P0（会失败/会破坏数据）/P1（功能缺陷）/P2（优化），不要只给一堆并列建议。',
      '不要重写计划；给最小修正方案。',
    ],
    writes: '只读',
    when: '任何方案批准前；改动跨模块、涉及持久化/权限/兼容性时必叫。',
  }),
  Object.freeze({
    id: 'builder',
    label: '执行落地',
    labelEn: 'Builder',
    mission: '在 Lead 指定的写域内把改动做出来，并自证可运行。',
    duties: [
      '严格只改自己任务的 write scope；发现必须越界时先停下来说清楚。',
      '只实现被要求的最小改动，不顺手重构没坏的东西，不新增推测性功能。',
      '每处改动都能追溯到任务描述里的具体一条要求。',
      '落地后必须给出「怎么验证的」（真实命令与真实输出），不许用 --help/--version 冒充。',
    ],
    writes: '被分配的写域（共享任务上的 write_scopes）',
    when: '计划已定、写域已切分之后。并行时一人一块互不重叠的文件。',
  }),
  Object.freeze({
    id: 'integrator',
    label: '集成落地',
    labelEn: 'Integrator',
    mission: '把多个写域的产出合成一个能真正跑起来的整体，并对端到端链路负责。',
    duties: [
      '只做集成：接线、依赖顺序、跨模块契约对齐、清掉半成品；不重写别人写域里的实现。',
      '必须真的跑通端到端链路，给出真实命令与真实输出。',
      '发现两个写域的产出互不相容时停下来把冲突说清楚，不要私自选一边改掉后当作完成。',
      '结尾必须给「现在能跑 / 不能跑」的明确结论与剩余断点清单。',
    ],
    writes: '被分配的集成写域（通常只碰接线处、入口与共享清单）',
    when: '有 2 个以上并行写域之后；改动跨进程/跨包/跨文件格式边界、需要真正跑通端到端时。',
  }),
  Object.freeze({
    id: 'tester',
    label: '复现回归',
    labelEn: 'Tester',
    mission: '把缺陷变成可重复的失败用例，把修好的行为锁成回归用例。',
    duties: [
      '先写能复现问题的**最小失败用例**（真实入口、真实参数），并确认它在修复前确实失败。',
      '用例必须能被别人一条命令重跑：写明命令、期望、实际。',
      '不修业务代码（除非 Lead 明确把那段写域分给你）；只新增测试与必要的夹具。',
      '结论回答「修好了吗」：修复后同一用例通过，且原来通过的用例没有退化。',
    ],
    writes: '测试文件与夹具（任务指定路径）；不改业务代码',
    when: '缺陷复现、以及任何需要留下可重复回归证据的改动；builder 修之前或修之后都可叫。',
  }),
  Object.freeze({
    id: 'verify',
    label: '逻辑审查',
    labelEn: 'Verifier',
    mission: '按**验收标准**判定结果：走真实调用链路，覆盖逻辑与边界；只有你能判定「通过」。',
    duties: [
      '先跑真实链路再下结论：真实入口、真实参数、真实输出；不看代码猜行为。',
      '覆盖边界与失败路径：空值、超时、并发、权限、中断、以及文档承诺的反例。',
      '主动扫同类问题：未处理异常、吞错误、硬编码、注入面、越权、竞态、死代码/mock。',
      '判定必须落到「哪一条验收标准、用什么命令、真实输出是什么」。',
    ],
    writes: '只读；可新增测试脚本（写在任务指定路径下）',
    when: '每个交付物声称完成之后；最终答案之前必叫。',
  }),
  Object.freeze({
    id: 'red-team',
    label: '对抗审查',
    labelEn: 'Red Team',
    mission: '假定交付物是坏的：主动构造能把它打穿的输入、时序与环境，目标是**证伪**而不是确认。',
    duties: [
      '先列攻击面（输入边界、畸形/恶意数据、并发与时序、权限与降级、资源耗尽），再逐条真的去打。',
      '每个发现给最小可复现步骤：命令或输入 → 实际结果 → 为什么这是缺陷。',
      '不允许「我觉得可能有风险」：要么打出真实失败，要么明确写「尝试了这些，没打穿」。',
      '只读优先；要造数据就写在任务指定路径下，不要污染交付物。',
    ],
    writes: '只读；可写你自己的攻击脚本与数据（任务指定路径）',
    when: '交付物声称通过之后、最终答案之前；涉及安全面、持久化、并发或对外接口时必叫。',
  }),
  Object.freeze({
    id: 'visual-critic',
    label: '美术审查',
    labelEn: 'Visual Critic',
    mission: '审查**实际产出**的视觉结果，而不是想象出来的结果。',
    duties: [
      '必须看真实渲染物（截图/导出图/实际页面），根据观察到的问题下结论。',
      '检查：布局对齐、间距留白、层级对比、可读性、状态反馈、文案、深浅色。',
      '图表类另查：坐标轴标签与量纲、刻度、异常值、数据与图是否一致，留白是否被顶满。',
      '每条问题给「看到的现象 + 期望 + 最小修法」，并指明重看哪一屏。',
    ],
    writes: '只读',
    when: '存在 UI/图表/演示稿等可视交付物时。',
  }),
  Object.freeze({
    id: 'refiner',
    label: '反思优化',
    labelEn: 'Refiner',
    mission: '在不破坏正确性的前提下做根因与简化，并把经验固化成可复用的纪律。',
    duties: [
      '找根因，不满足于表面修复；说明「为什么之前会错」。',
      '删多于加：能合并的抽象合并，能删的推测性代码删掉，能复用的既有能力复用。',
      '只动被点名的范围；越界需求写成建议而不是直接改。',
      '产出必须包含「回归风险」与「如何验证没坏」。',
    ],
    writes: '被分配的写域（通常与 builder 不同批，避免同时改同一文件）',
    when: '功能已通过验证后；或反复出现同一类缺陷时。',
  }),
  Object.freeze({
    id: 'scribe',
    label: '文档术语',
    labelEn: 'Scribe',
    mission: '把已经定下来的决定与术语写下来，让下一个人不用重新推一遍。',
    duties: [
      '术语表放进 CONTEXT.md（只放本项目的领域术语，不放通用编程概念）。',
      'ADR 只在三个条件同时成立时写：难以回退 / 不看上下文会觉得奇怪 / 是真的权衡过。',
      '只在决策真的定下来时写；不要批量补历史，不要写推测。',
      '写之前先读现有 CONTEXT.md 与 docs/adr/，编号取最大号 +1。',
    ],
    writes: '文档：CONTEXT.md、CONTEXT-MAP.md、docs/adr/',
    when: '用户确认了共享理解、或出现不可轻易回退的取舍时。',
  }),
]);

/** 角色 id 数组，顺序同 ROLES。 */
export const ROLE_IDS = Object.freeze(ROLES.map((role) => role.id));

/** id → 角色定义。 */
export const ROLE_BY_ID = Object.freeze(Object.fromEntries(ROLES.map((role) => [role.id, role])));

// ── 队员的能力面（与角色无关，对**所有**队员完全相同） ──────────────────────────
//
// 为什么必须逐字节相同：提示词缓存按「前缀」命中。队员的系统提示词 + 工具目录是每个
// 队员请求的固定前缀，只要所有队员拿到同一份，队员之间就共用同一份缓存；一旦某个角色
// 多一句、少一个工具，那个角色的前缀就整体错位，命中率与省下的钱一起消失。
// 所以下面三个常量都是**常量**，不允许按角色分叉。

/**
 * 九个团队工具的名字（顺序与注册顺序一致）。
 *
 * 放在这里而不是 lib/tools.js 的理由：本文件**不 import 任何 @deepseek-ai 包**，所以
 * `tools/selftest.cjs` 与 `tools/drift-check.cjs` 都能直接读它，不用为了一个名字数组
 * 去加载 `@deepseek-ai/dsh-tools`（那需要安装期的 node_modules junction）。
 * 这两条真值以前各写了一份，官方改名字时两边会各飘各的。
 */
export const TEAM_TOOL_NAMES = Object.freeze([
  'spawn_teammate',
  'send_message',
  'list_agents',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
]);

/**
 * Lead 专属的**官方**团队工具：不给队员。`MEMBER_TEAM_TOOL_NAMES`
 * = 官方九个减去这两个，再加队员专用的 `report_result` 与 `ask_lead`，selftest 会核对这条关系。
 * （本插件给 Lead 另加的 `wake_teammate` 不在官方名单里，见 LEAD_TEAM_TOOL_NAMES 与 WAKE_TOOL_NAME。）
 */
export const LEAD_ONLY_TEAM_TOOL_NAMES = Object.freeze(['spawn_teammate', 'interrupt_agent']);

/**
 * 队员可见的团队工具名（顺序即注册顺序）。
 * `spawn_teammate` 与 `interrupt_agent` 是 Lead 专属：前者是「再派子代理」的权限
 * （工具描述里就写着 Only the Team Lead may call this tool），后者按契约同样 Lead only。
 *
 * `report_result` 是本插件加的**队员专用**结构化汇报工具（Lead 不注册它）：
 * 它把「完成 / 受阻 / 待决 + 证据 + 验收 + 未决项」的结构固化下来，并由插件自己把这份
 * 报告投递给 Lead —— 于是「没有结构化报告就当没完成」这条纪律不再只是一句话。
 * 形状、校验与投递行为见 README §2.4。（另有一说「机制对照 dsh-model-fusion 的同名工具」，
 * 该对照**本机未经验证**——那份插件目录现在只剩 state.sqlite，无从比对，2026-10-04 审查 P2-28。）
 */
export const MEMBER_TEAM_TOOL_NAMES = Object.freeze([
  'send_message',
  'list_agents',
  'wait_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
  REPORT_TOOL_NAME,
  ASK_LEAD_TOOL_NAME,
]);

/**
 * 队员身上要**摘掉**的工具名（这些工具来自 preset 继承，不是我们注册的）。
 *
 * 依据 dsh-tools 的 `ctx.tools.restrict({deny})`：它过滤的是**继承面**（全局层 + 作用域链上
 * 的祖先层，也就是 preset 行的贡献），本作用域自己注册的不受影响——正好是「per-child
 * capability filter」的官方语义（dsh-tools/lib/index.js 的 `view()` 注释）。
 *
 * 四条理由：
 *   1. 不给队员「目标」：goal 是 Lead 的编排手段，队员的目标就是它那一条任务。
 *   2. 不给队员「再派子代理」的权限：subagent / subagent_fork / workflow 都会起子代理，
 *      多一层递归只会烧预算并让汇报链断掉。
 *   3. 摘掉 Lead 专属的团队开关：队员调用只会拿到「只有 Lead 能开启团队」的拒绝。
 *   4. 摘掉 ask_user_question：官方本来就挡（dsh-user-questions/lib/index.js:531-535 的
 *      assertLiveRoot 对非 roots() 成员抛 DELEGATED_CALLER，
 *      dsh-agent/lib/index.js:621-623 的 roots() 只含 owner===undefined 的 agent），
 *      所以队员调用是**一次注定失败的往返**；而 TEAMMATE_CARD 的纪律是「有问题停下来报告给
 *      Lead」。摘掉它让工具目录与纪律口径一致（2026-10-04 审查 P2-30）。
 *
 * ⚠️ `restrict` 对**不存在的名字会抛错**，所以 runtime 逐个名字 try/catch 地调用它：
 * 用户关掉某个 preset 行（例如 tool-goal、tool-ask-user）时，我们只是少摘一个，不会让队员建不出来。
 */
export const TEAMMATE_TOOL_DENY = Object.freeze([
  'create_goal',
  'get_goal',
  'update_goal',
  'subagent',
  'subagent_fork',
  'workflow',
  'enable_agent_team',
  'disable_agent_team',
  'ask_user_question',
]);

/**
 * 队员身上要**清空**的提示词段。
 *
 * 为什么摘掉工具还不够：`systemPrompt.section` 注册的「工具用法」段是**独立**注册的，
 * 过滤工具不会连带清掉它（dsh-tools 只提供工具 schema，不提供段）。工具没了、段还在，
 * 系统提示词就在教队员用一个它没有的工具——既浪费 token 又会让它反复发起注定失败的调用。
 *
 * `tool:${toolName}` 这种段名有两种实现：一种写死文本（必须我们清），一种在文本函数里
 * 自查 `tools.get(toolName, scope) === undefined ? '' : ...`（工具被摘掉后自己变空）。
 * 这里只列**写死文本**的那些；`orderKey` 走官方 `getSectionOrder`，拿不到时退回 fallback。
 */
export const TEAMMATE_SECTION_MUTES = Object.freeze([
  Object.freeze({ name: 'tool:goal', orderKey: 'TOOL_GOAL', fallbackOrder: 2400 }),
  Object.freeze({ name: 'tool:workflow', orderKey: 'TOOL_WORKFLOW', fallbackOrder: 2600 }),
]);

/**
 * 官方 `tool-agent-team` 行注册的**策略段名**（系统提示词里的「Team Lead 方法论」）。
 *
 * 为什么需要它：官方那九个工具的**名字与我们的完全相同**（drift-check 逐名对齐），
 * 所以「这个模式里用的是谁的团队」在工具面上分不出来 —— 但策略段分得出来。
 * 调度模式的 preset 作用域里用**同名空段**遮蔽它（`renderPrompt` 会丢掉空段），
 * 让本模式的提示词里只有我们的 PLAYBOOK，不叠加一份官方方法论。
 * 名字取自官方源码 `scoped.systemPrompt.section({ name: "team:policy", … })`；
 * drift-check 会持续校验这个名字没变。
 */
export const OFFICIAL_TEAM_POLICY_SECTION = 'team:policy';

/**
 * 队员名规则：**以某个角色 id 开头**（`<role>` 本身，或 `<role>-<任意后缀>`）。
 *
 * 为什么从「`<role>` 或 `<role>-<数字>`」放宽（2026-10-05，用户实测截图）：
 * 真实会话里 Lead 想给同一角色的两个队员起可区分的语义名，于是派出 `scout-core` /
 * `scout-validate`，两次都被本插件自己拒掉：
 *   `spawn_teammate 失败：name "scout-core" 不是合法的队员名（必须是 <角色id> 或 <角色id>-N，N>=2）`
 * 而同一天官方域服务对这两个名字**完全接受**（官方 `MEMBER_NAME` 见下），所以这条限制
 * 是本插件凭空收紧的，收益为零、代价是模型被迫用 `scout-2`/`scout-3` 这种无信息量的名字。
 *
 * 放宽后的三条口径：
 *   1. 形状以**官方**为准（逐字照抄 dsh-experimental-agent-team/lib/types/roster.js:10
 *      的 `MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/`）——我们不再比官方更严，
 *      否则官方接受而插件拒绝的这类假失败会再次出现；
 *   2. 角色用**最长前缀**匹配（`deriveRole`）。今天 12 个角色 id 之间实测没有任何前缀关系，
 *      所以最长与首个匹配等价；写成最长是为了将来加角色时不会把 `plan-critic-x` 错判成 `plan`；
 *   3. 纯数字后缀仍从 2 起（见 isValidTeammateName）：`-N` 是本插件自动命名
 *      （nextTeammateName）自己的命名空间，`scout-0`/`scout-1` 不在其中。
 *      非数字后缀（`scout-core`）是自由标签，不再受这条约束。
 *
 * ⚠️ 放宽的已知代价：名字与角色不再一一对应（`scout-core` 与 `scout-validate` 都是 scout）。
 * 角色只用来选模型/强度与拼派活简报，两者本就不需要唯一；需要区分时看名字即可。
 */
const OFFICIAL_MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** 有效的强度 id 只做形状校验；具体是否被模型支持由 host 侧向 llm 预检决定。 */
const EFFORT_SHAPE = /^[a-z][a-z0-9_-]*$/u;

/**
 * 从队员名推导角色 id。
 * @param name - 模型可见的队员名。
 * @returns 角色 id；名字不符合 `<role>` / `<role>-N` 或角色未知时返回 undefined。
 */
export function deriveRole(name) {
  if (typeof name !== 'string') return void 0;
  const trimmed = name.trim();
  if (trimmed === '') return void 0;
  // 形状先过官方那一关：这样「deriveRole(name) !== undefined」与「name 是一个
  // 角色派生的队员名」严格等价 —— `scout-` / `scout--2` / `Scout` 这些官方根本
  // 造不出来的名字不会被本函数认领，冷恢复路径也不需要再自己判一遍形状。
  if (!OFFICIAL_MEMBER_NAME.test(trimmed)) return void 0;
  // 最长前缀匹配（见 OFFICIAL_MEMBER_NAME 上方的口径 2）：
  //   'scout' -> 'scout'；'scout-core' -> 'scout'；'scout-2' -> 'scout'；
  //   'plan-critic-verify' -> 'plan-critic'；'lead' -> undefined（没有任何角色 id 是它的前缀）。
  let matched = '';
  for (const id of ROLE_IDS) {
    if (trimmed !== id && !trimmed.startsWith(`${id}-`)) continue;
    if (id.length > matched.length) matched = id;
  }
  return matched === '' ? void 0 : matched;
}

/**
 * 校验一个队员名是否合法且能推导出角色。
 * @param name - 候选名字。
 * @returns 合法返回 true。
 */
export function isValidTeammateName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  // 长度与形状口径逐字对齐官方 memberName()（official-roster.js:417-423：
  // `!MEMBER_NAME.test(value) || value.length > 64 || value === 'lead'`）。
  // 插件只允许**更严**的部分是下面那条「必须以角色 id 开头」，其余不再自己加限制。
  if (trimmed.length === 0 || trimmed.length > 64) return false;
  if (!OFFICIAL_MEMBER_NAME.test(trimmed)) return false;
  if (!deriveRole(trimmed)) return false;
  // 纯数字后缀是本插件自动命名（nextTeammateName）的命名空间，从 2 起；
  // `foo-0` 会被自动命名跳过，接受它等于制造一个与 `foo` 语义相同的名字。
  // 注意只对**纯数字**后缀生效：`scout-core` 这类自由标签不受约束。
  const suffix = /-(\d+)$/u.exec(trimmed);
  return suffix === null || Number(suffix[1]) >= 2;
}

/**
 * 为角色挑一个尚未占用的队员名。
 * @param role - 角色 id。
 * @param taken - 已占用的名字集合（roster 里的现有队员名，含 lead）。
 * @returns 可用的 `<role>` 或 `<role>-N`（N 从 2 起）。
 */
export function nextTeammateName(role, taken = []) {
  const used = new Set(taken);
  if (!used.has(role)) return role;
  for (let index = 2; index <= 99; index += 1) {
    const candidate = `${role}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`角色 "${role}" 的队员名已用尽（99 个）`);
}

/** 空配置。roles 里没有条目的角色 = 与 Lead 同模型同强度。 */
export function defaultConfig() {
  return { version: CONFIG_VERSION, roles: {}, cache: { keepalive: { routes: {} } } };
}

const LOG_OFF = () => void 0;

/**
 * 净化缓存保活设置。
 *
 * 形状（全部可选）：
 *   `cache.keepalive.routes = { '<provider>/<model>' | '<provider>' | '<线路族id>': {mode, intervalSeconds} }`
 * `mode` 只认 auto/on/off；`intervalSeconds` 夹到 [60, 3540]。坏值丢掉并记 log —— 配置页里
 * 一个手滑的字符串不该让整份配置被重置。
 */
function sanitizeCache(raw, log) {
  const out = { keepalive: { routes: {} } };
  const cache = raw?.cache;
  if (cache === undefined || cache === null) return out;
  if (typeof cache !== 'object' || Array.isArray(cache)) {
    log('cache 不是对象，已忽略');
    return out;
  }
  const keepalive = cache.keepalive;
  if (keepalive === undefined || keepalive === null) return out;
  if (typeof keepalive !== 'object' || Array.isArray(keepalive)) {
    log('cache.keepalive 不是对象，已忽略');
    return out;
  }
  const routes = keepalive.routes;
  if (routes === undefined || routes === null) return out;
  if (typeof routes !== 'object' || Array.isArray(routes)) {
    log('cache.keepalive.routes 不是对象，已忽略');
    return out;
  }
  for (const [key, value] of Object.entries(routes)) {
    if (typeof key !== 'string' || key.trim() === '') continue;
    if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
      log(`cache.keepalive.routes["${key}"] 不是对象，已忽略`);
      continue;
    }
    const clean = {};
    if (value.mode !== undefined && value.mode !== null && value.mode !== '') {
      if (typeof value.mode !== 'string' || !KEEPALIVE_MODES.includes(value.mode)) {
        log(`cache.keepalive.routes["${key}"].mode "${String(value.mode)}" 非法（只能是 ${KEEPALIVE_MODES.join('/')}），已丢弃`);
      } else {
        clean.mode = value.mode;
      }
    }
    if (value.intervalSeconds !== undefined && value.intervalSeconds !== null && value.intervalSeconds !== '') {
      const interval = clampIntervalSeconds(Number(value.intervalSeconds));
      if (interval === undefined) {
        log(`cache.keepalive.routes["${key}"].intervalSeconds "${String(value.intervalSeconds)}" 不是数字，已丢弃`);
      } else {
        clean.intervalSeconds = interval;
      }
    }
    if (Object.keys(clean).length > 0) out.keepalive.routes[key.trim()] = clean;
  }
  return out;
}

/**
 * 把任意来源的配置净化为可信形状。永不抛错：坏字段被丢掉并记入 log。
 * @param raw - 文件里读到的或客户端提交的值。
 * @param log - 诊断回调，默认丢弃。
 * @returns 净化后的配置（新对象）。
 */
export function sanitizeConfig(raw, log = LOG_OFF) {
  const out = defaultConfig();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    if (raw !== void 0) log('配置不是对象，已重置为空配置');
    return out;
  }
  const rawVersion = raw.version;
  if (rawVersion !== void 0 && rawVersion !== CONFIG_VERSION) {
    log(`配置版本 ${String(rawVersion)} 与当前 ${CONFIG_VERSION} 不同，按当前版本读取`);
  }
  out.cache = sanitizeCache(raw, log);
  const roles = raw.roles;
  if (typeof roles !== 'object' || roles === null || Array.isArray(roles)) {
    if (roles !== void 0) log('roles 不是对象，已忽略');
    return out;
  }
  for (const roleId of ROLE_IDS) {
    const entry = roles[roleId];
    if (entry === void 0 || entry === null) continue;
    if (typeof entry !== 'object' || Array.isArray(entry)) {
      log(`角色 "${roleId}" 的配置不是对象，已忽略`);
      continue;
    }
    const provider = entry.provider;
    const model = entry.model;
    // provider/model 必须成对，且都不为空；只有一个则整条丢弃（不猜）。
    if (typeof provider !== 'string' || typeof model !== 'string' || provider.trim() === '' || model.trim() === '') {
      if (provider !== void 0 || model !== void 0) log(`角色 "${roleId}" 的 provider/model 不成对或是空串，已忽略该角色的模型设置`);
      continue;
    }
    const clean = { provider: provider.trim(), model: model.trim() };
    const effort = entry.reasoningEffort;
    if (effort !== void 0 && effort !== null && effort !== '') {
      if (typeof effort !== 'string' || !EFFORT_SHAPE.test(effort)) {
        log(`角色 "${roleId}" 的 reasoningEffort "${String(effort)}" 形状非法，已丢弃该强度`);
      } else {
        clean.reasoningEffort = effort;
      }
    }
    out.roles[roleId] = clean;
  }
  return out;
}

/**
 * 解析一个角色最终要用的 LLM 路由。
 * @param config - 已净化的配置。
 * @param role - 角色 id。
 * @returns 有覆盖时返回 `{provider, model, reasoningEffort?}`；没有覆盖时返回 undefined（= 继承 Lead）。
 */
export function resolveRoleRoute(config, role) {
  if (typeof config !== 'object' || config === null) return void 0;
  const entry = config.roles?.[role];
  if (entry === void 0) return void 0;
  return { provider: entry.provider, model: entry.model, ...entry.reasoningEffort === void 0 ? {} : { reasoningEffort: entry.reasoningEffort } };
}

/**
 * 判断配置里是否有任何角色被覆盖（用于 UI 的「已配置 / 全默认」提示与 diagnostics）。
 * @param config - 已净化的配置。
 * @returns 被覆盖的角色数量。
 */
export function configuredRoleCount(config) {
  if (typeof config !== 'object' || config === null || typeof config.roles !== 'object' || config.roles === null) return 0;
  return ROLE_IDS.filter((roleId) => config.roles[roleId] !== void 0).length;
}

/**
 * 解析**一名队员本次请求**要用的路由（纯函数，可单测）。
 *
 * 优先级的真值（2026-10-01 修 bug 后）：
 *   1. `explicitRoute` —— 只在 `spawn_teammate` **工具调用显式给了 provider+model** 时存在。
 *      它是「这一次 spawn 的命令」，钉死到该队员生命周期是**正确**的；
 *   2. `roleRoute` —— 角色配置，**每次请求实时读**（`peekConfig()`）。所以用户在面板上把某角色改成
 *      另一个模型、或改回「跟随 Lead」，**已经在跑的队员下一次请求就生效**；
 *   3. 两者都没有 → `undefined` = **不覆盖** = 跟随 Lead（本插件对「跟随 Lead」的定义就是「不加任何覆盖，
 *      让官方的继承/选择自己决定」，member 每请求都会跟着 Lead 当前的选择走）。
 *   `explicitEffort` 是工具显式给的思考强度，叠加在上面两者之上（只有强度没给模型时也能生效）。
 *
 * ⚠️ 曾经这里写成 `pinSpawnRoute` 会把**角色配置解析出来的路由**也钉住，于是「跟随 Lead」永远不生效：
 * 队员按 spawn 那一刻的旧模型一直跑下去（用户 2026-10-01 报的正是这个）。现在钉子只由显式参数产生。
 *
 * @param explicitRoute - `{provider, model}` 或 undefined。
 * @param roleRoute - `resolveRoleRoute(peekConfig(), role)` 的结果。
 * @param explicitEffort - 本次 spawn 显式给的 reasoningEffort 或 undefined。
 * @returns `{provider, model, reasoningEffort?}`（可能要覆盖）或 undefined（跟随 Lead，不覆盖）。
 */
export function resolveMemberRoute(explicitRoute, roleRoute, explicitEffort) {
  const base = explicitRoute ?? roleRoute;
  const effort = explicitEffort ?? base?.reasoningEffort;
  if (base === undefined && effort === undefined) return void 0;
  return {
    ...(base ?? {}),
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  };
}