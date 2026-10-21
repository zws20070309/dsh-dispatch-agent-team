#!/usr/bin/env node
/**
 * client-smoke-test.cjs —— 浏览器半（lib/client.js）的渲染冒烟测试
 *
 * 为什么需要它：`lib/client.js` 是用户**看得见**的那一页（插件 → 已安装 → 详情页），
 * 而它此前没有任何测试。宿主半有三层测试（selftest / drift-check / integration-test），
 * 浏览器半只有一条「顶层零声明」的静态检查 —— 一个渲染期就崩的改动（引用了不存在的文案键、
 * 在 render 里调 setState、把对象直接塞进 React 子节点）能一路溜到用户面前。
 *
 * 做法：复刻官方 loader 的调用形状（`window.__ModuleLoader__.load({ id, factory })`），
 * 用一个极小的 React 替身（useState / useEffect / createElement）把组件真的渲染一遍，
 * 并把 `fetch` 指向一份可编程的宿主回执。每个用例都**重新跑一次 factory**
 * （组件函数定义在 factory 闭包里，复用同一个实例会让 hooks 状态串台）。
 * 全程不依赖浏览器、不依赖 jsdom、不依赖任何 dsh 包。
 *
 *   node tools/client-smoke-test.cjs
 *
 * 退出码：0 = 全通过；1 = 有断言失败；2 = 环境不满足（client.js 形状变了）。
 */

'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const CLIENT = path.resolve(__dirname, '..', 'lib', 'client.js');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const outcome = fn();
    if (outcome === true || outcome === undefined) {
      passed += 1;
      console.log(`  PASS  ${name}`);
      return;
    }
    failures.push({ name, detail: String(outcome) });
    console.log(`  FAIL  ${name}`);
    console.log(`        → ${String(outcome)}`);
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}`);
    console.log(`        → 断言抛错：${detail}`);
  }
}

// ── 极小的 React 替身 ────────────────────────────────────────────────────────
function createElement(type, props, ...children) {
  const flat = [];
  const push = (child) => {
    if (child === null || child === undefined || child === false || child === true) return;
    if (Array.isArray(child)) { child.forEach(push); return; }
    flat.push(child);
  };
  children.forEach(push);
  return { type, props: { ...(props === null || props === undefined ? {} : props), children: flat } };
}

/** 把元素树里的所有文本拼起来（按钮文字、错误提示、诊断列表都在内）。 */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object') return textOf(node.props === undefined ? undefined : node.props.children);
  return '';
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((child) => findAll(child, predicate, out)); return out; }
  if (predicate(node)) out.push(node);
  findAll(node.props === undefined ? undefined : node.props.children, predicate, out);
  return out;
}

/** 每个用例一份的 hooks 运行时。 */
function createReactStub() {
  const hooks = [];
  let cursor = 0;
  let effects = [];
  let stateVersion = 0;
  return {
    stateVersion: () => stateVersion,
    React: {
      createElement,
      useState(initial) {
        const index = cursor++;
        if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
        return [hooks[index], (value) => {
          hooks[index] = typeof value === 'function' ? value(hooks[index]) : value;
          stateVersion += 1;
        }];
      },
      useEffect(fn, deps) {
        const index = cursor++;
        const previous = hooks[index];
        const changed = previous === undefined || deps === undefined || deps.some((dep, at) => dep !== previous[at]);
        hooks[index] = deps;
        if (changed) effects.push(fn);
      },
    },
    /** 渲染一轮并执行本轮登记的 effect。 */
    render(component, props) {
      cursor = 0;
      effects = [];
      const tree = component(props);
      for (const effect of effects) effect();
      return tree;
    },
  };
}

const flush = async (rounds = 3) => {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function main() {
  // ── loader 替身：捕获 factory 的形状（factory 每个用例重新调用） ─────────
  let registration;
  globalThis.window = { __ModuleLoader__: { load(spec) { registration = spec; } } };

  try {
    await import(pathToFileURL(CLIENT).href);
  } catch (error) {
    console.error(`[client-smoke-test] lib/client.js 顶层求值就抛错：${error && error.message ? error.message : String(error)}`);
    process.exit(2);
  }
  if (registration === undefined || typeof registration.factory !== 'function') {
    console.error('[client-smoke-test] 没有捕获到 window.__ModuleLoader__.load({ factory })。');
    process.exit(2);
  }

  // ── 共享的宿主回执替身 ────────────────────────────────────────────────────
  const ROLES = [
    { id: 'researcher', label: '外部调研', labelEn: 'Researcher', mission: '查仓库之外的事实' },
    { id: 'scout', label: '探索调研', labelEn: 'Scout', mission: '查本仓库的事实' },
    { id: 'builder', label: '执行落地', labelEn: 'Builder', mission: '在写域内落地' },
  ];
  let sent = [];
  let hostReply = {};
  globalThis.fetch = (url, options) => {
    const body = JSON.parse(options.body);
    sent.push({ op: body.op, args: body.args, url, headers: options.headers });
    const reply = hostReply[body.op] === undefined ? { ok: false, error: `no stub for ${body.op}` } : hostReply[body.op];
    return Promise.resolve({ status: 200, text: () => Promise.resolve(JSON.stringify(reply)) });
  };

  /** 挂载一次插件页（新的 factory 实例 + 新的 hooks），渲染到稳定。 */
  async function mount(responses) {
    hostReply = responses;
    sent = [];
    const runtime = createReactStub();
    const exportsObject = registration.factory((specifier) => {
      if (specifier === 'react') return runtime.React;
      throw new Error(`client.js 只应该 require('react')，实际 require 了 "${specifier}"`);
    });
    let component;
    let anchorComponent;
    let localeDict;
    let injections = 0;
    const registered = [];
    const ctx = {
      effect(fn) { fn(); return () => {}; },
      slots: Object.freeze({
        inject(name, factory) { injections += 1; return factory(); },
        register(slot, candidate) {
          registered.push(slot.name);
          // 2026-10-08：本包现在注册**两个**组件（配置页 + 工作区入口锚点）。
          // 锚点必须注册在 conversation.session.header.actions（官方 TeamAction 同一个槽），
          // 配置页必须留在 plugins.bundle.config —— 各拿各的，别互相覆盖。
          if (slot.name === 'plugins.bundle.config') component = candidate;
          if (slot.name === 'conversation.session.header.actions') anchorComponent = candidate;
          return () => {};
        },
      }),
      locale: Object.freeze({ register(namespace, dicts) { localeDict = dicts; return () => {}; } }),
    };
    exportsObject.apply(ctx);
    if (typeof component !== 'function') throw new Error('apply() 没有注册组件');
    const t = (key, params) => {
      const dict = localeDict === undefined ? {} : localeDict.zh || {};
      const raw = typeof dict[key] === 'string' ? dict[key] : undefined;
      if (raw === undefined) return key;
      if (params === undefined) return raw;
      return raw.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])));
    };
    const props = { t, view: 'page' };
    let tree = runtime.render(component, props);
    await flush();
    tree = runtime.render(component, props);
    await flush();
    tree = runtime.render(component, props);
    return {
      exportsObject,
      injections: () => injections,
      registered: () => registered,
      anchor: () => anchorComponent,
      /** 再渲染一轮（用于交互之后）。 */
      repaint() { tree = runtime.render(component, props); return tree; },
      tree: () => tree,
      /** 交互后需要把 Promise 链走完再渲染。 */
      async settle() { await flush(); return this.repaint(); },
      sent: () => sent,
      dict: () => localeDict,
    };
  }

  console.log('lib/client.js（浏览器半渲染冒烟）');

  // ── 0) 注册形状 ───────────────────────────────────────────────────────────
  {
    const page = await mount({
      get: { ok: true, config: { version: 1, roles: {} }, roles: ROLES, revision: '1:1', diagnostics: [] },
      'list-models': { ok: true, groups: [], failures: [] },
    });
    check('注册形状：id / name / inject / 两个槽位与字典各注册一次', () => {
      if (registration.id !== '@zws/dsh-dispatch-agent-team') return `id=${registration.id}`;
      if (page.exportsObject.name !== 'dsh-dispatch-agent-team-client') return `name=${page.exportsObject.name}`;
      const inject = page.exportsObject.inject;
      if (!Array.isArray(inject) || !inject.includes('slots') || !inject.includes('locale')) {
        return `inject=${JSON.stringify(inject)}（需要 slots 与 locale）`;
      }
      if (page.injections() !== 2) return `slots.inject 调用了 ${page.injections()} 次（应为 2：配置页 + 工作区锚点）`;
      const names = page.registered();
      if (!names.includes('plugins.bundle.config')) return '配置页槽位没注册';
      if (!names.includes('conversation.session.header.actions')) return '工作区锚点槽位没注册（官方 TeamAction 同一个槽）';
      if (typeof page.anchor() !== 'function') return '工作区锚点组件没注册';
      if (page.dict() === undefined || typeof page.dict().zh !== 'object') return '字典没注册';
      return true;
    });

    check('工作区锚点：渲染隐藏 span 并把 sessionId 写进 data-ws-session', () => {
      // 锚点是纯函数（无 hooks），直接调用即可。
      const tree = page.anchor()({ sessionId: 'session-abc' });
      const props = tree === undefined || tree === null ? {} : tree.props;
      if (tree === undefined || tree === null || tree.type !== 'span') return '锚点不是 span';
      if (props['data-ws-session'] !== 'session-abc') return `data-ws-session=${String(props['data-ws-session'])}`;
      if (props.style === undefined || props.style.display !== 'none') return '锚点没有隐藏（会往会话顶栏塞一个可见空位）';
      return true;
    });

    check('工作区锚点：sessionId 缺失时不抛错、写空串', () => {
      const tree = page.anchor()({});
      if (tree.props['data-ws-session'] !== '') return '缺失的 sessionId 应归一成空串';
      return true;
    });
  }

  // ── 1) 正常加载 ───────────────────────────────────────────────────────────
  {
    const page = await mount({
      get: { ok: true, config: { version: 1, roles: {} }, roles: ROLES, path: 'X', revision: '111:222', diagnostics: [] },
      'list-models': {
        ok: true,
        groups: [{ id: 'p1', name: 'Provider 1', models: [{ id: 'm1', name: 'Model 1', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }],
        failures: [],
      },
    });
    const tree = page.tree();
    const text = textOf(tree);

    check('正常加载：渲染出每个角色（label + id）', () => {
      for (const role of ROLES) {
        if (!text.includes(role.label)) return `缺少角色行：${role.label}`;
        if (!text.includes(role.id)) return `缺少角色 id：${role.id}`;
      }
      return true;
    });

    check('正常加载：{count}/{total} 的 total 是动态 roles.length', () => (text.includes('0/3') ? true : `没有渲染 0/3：${text.slice(0, 120)}`));

    check('正常加载：模型下拉里出现宿主给出的 provider/model（不透明键）', () => {
      const values = findAll(tree, (node) => node.type === 'option').map((option) => option.props.value);
      return values.includes('p1\u0000m1') ? true : `模型下拉里没有 p1/m1：${JSON.stringify(values)}`;
    });

    check('正常加载：请求带 CSRF 闸门头、走 POST、路径正确', () => {
      const call = page.sent().find((entry) => entry.op === 'get');
      if (call === undefined) return '没有发出 get 请求';
      if (call.headers === undefined || call.headers['x-dsh-plugin'] !== 'zws-dispatch-agent-team') return `闸门头不对：${JSON.stringify(call.headers)}`;
      if (call.url !== '/zws-dispatch-agent-team/api') return `路径不对：${call.url}`;
      return true;
    });

    check('正常加载：无改动时「保存」禁用；加载完成后重载/重置可用', () => {
      const save = findAll(tree, (node) => node.type === 'button' && textOf(node).includes('保存'))[0];
      const reload = findAll(tree, (node) => node.type === 'button' && textOf(node).includes('重新载入'))[0];
      const reset = findAll(tree, (node) => node.type === 'button' && textOf(node).includes('全部恢复默认'))[0];
      if (save === undefined || reload === undefined || reset === undefined) return '找不到按钮';
      if (save.props.disabled !== true) return '没有未保存改动时「保存」应当是禁用的';
      if (reload.props.disabled === true) return '加载完成后「重新载入」仍被禁用';
      if (reset.props.disabled === true) return '加载完成后「全部恢复默认」仍被禁用';
      return true;
    });

    check('正常加载：未保存改动时会提示「有未保存改动」', () => {
      // 注意：页面上现在有多个 select（统一选择 + 每个角色一行），这里要的是**角色行**那个。
      const list = findAll(tree, (node) => node.props !== undefined && node.props.className === 'dat-list')[0];
      const select = findAll(list, (node) => node.type === 'select')[0];
      select.props.onChange({ target: { value: 'p1\u0000m1' } });
      const after = page.repaint();
      const afterText = textOf(after);
      if (!afterText.includes('有未保存改动')) return '改了模型但没有未保存提示';
      const save = findAll(after, (node) => node.type === 'button' && textOf(node).includes('保存'))[0];
      if (save.props.disabled === true) return '改了模型之后「保存」仍然禁用';
      return true;
    });
  }

  // ── 1.5) 统一选择队员模型（2026-10-06 新增）────────────────────────────────
  // 用户诉求原话：「外层调研的上面加一个统一选择队员模型，可以一次性把所有队员的模型都选择了」。
  // 所以除了「能一次改全部」，还要钉住两件事：**位置在角色列表之上**、**它只是快捷方式**
  // （不引入第二套配置来源，保存仍走同一个 roles 载荷）。
  {
    const page = await mount({
      get: { ok: true, config: { version: 1, roles: {} }, roles: ROLES, revision: '1:1', diagnostics: [] },
      'list-models': {
        ok: true,
        groups: [{ id: 'p1', name: 'Provider 1', models: [
          { id: 'm1', name: 'Model 1', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
          { id: 'm2', name: 'Model 2', reasoning: { efforts: [{ id: 'low', name: 'Low' }] } },
        ] }],
        failures: [],
      },
    });
    const tree = page.tree();
    const bulk = findAll(tree, (node) => node.props !== undefined && node.props.className === 'dat-bulk')[0];

    check('统一选择：控件渲染出来，且在角色列表**之上**（用户指定的位置）', () => {
      if (bulk === undefined) return '页面上没有 .dat-bulk 控件';
      const wrap = findAll(tree, (node) => node.props !== undefined && node.props.className === 'dat-wrap')[0];
      if (wrap === undefined) return '找不到 .dat-wrap';
      const kids = wrap.props.children;
      const bulkAt = kids.findIndex((child) => child !== null && child !== undefined && child.props !== undefined && child.props.className === 'dat-bulk');
      const listAt = kids.findIndex((child) => child !== null && child !== undefined && child.props !== undefined && child.props.className === 'dat-list');
      if (bulkAt < 0) return '统一选择控件不在渲染树里';
      if (listAt < 0) return '角色列表不在渲染树里';
      if (bulkAt > listAt) return `统一选择在角色列表**之后**（bulkAt=${bulkAt} listAt=${listAt}）——用户要求在上面`;
      return true;
    });

    check('统一选择：默认（无配置）显示「跟随 Lead」，且标出作用于几个角色', () => {
      const select = findAll(bulk, (node) => node.type === 'select')[0];
      if (select === undefined) return '统一选择控件里没有 select';
      if (select.props.value !== '') return `默认值应为空（跟随 Lead），实际 ${JSON.stringify(select.props.value)}`;
      const text = textOf(bulk);
      if (!text.includes('统一选择队员模型')) return '缺少标题文案';
      if (!text.includes(String(ROLES.length))) return `没有标出作用角色数 ${ROLES.length}：${text}`;
      return true;
    });

    check('统一选择：选一次模型 → 所有角色都被设为该模型，并提示有未保存改动', () => {
      const select = findAll(bulk, (node) => node.type === 'select')[0];
      select.props.onChange({ target: { value: 'p1\u0000m1' } });
      const after = page.repaint();
      const list = findAll(after, (node) => node.props !== undefined && node.props.className === 'dat-list')[0];
      // 每个角色行各有一个模型下拉：都应变成 p1/m1。
      // 每个角色行里有**两个** select（模型 + 思考强度），只取模型那个（行内第一个）。
      const rows = findAll(list, (node) => node.props !== undefined && node.props.className === 'dat-row');
      const values = rows.map((row) => findAll(row, (node) => node.type === 'select')[0].props.value);
      const wrong = values.filter((value) => value !== 'p1\u0000m1');
      if (wrong.length > 0) return `仍有 ${wrong.length} 个角色没被改到：${JSON.stringify(values)}`;
      if (!textOf(after).includes('有未保存改动')) return '统一改完没有未保存提示';
      return true;
    });

    // 交互与结算放在 check 之外（与本文件其余用例同形：check 的回调是同步的）。
    {
      const select = findAll(bulk, (node) => node.type === 'select')[0];
      select.props.onChange({ target: { value: 'p1\u0000m1' } });
      const after = await page.settle();
      const save = findAll(after, (node) => node.type === 'button' && textOf(node).includes('保存'))[0];
      save.props.onClick();
      await flush();
    }
    check('统一选择：改完保存，roles 载荷里三个角色都在（走的是同一个 set 接口）', () => {
      const call = sent.find((entry) => entry.op === 'set');
      if (call === undefined) return '没有发出 set 请求';
      const roles = call.args.roles;
      const ids = Object.keys(roles === undefined ? {} : roles);
      if (ids.length !== ROLES.length) return `roles 只带上了 ${ids.length} 个角色（应为 ${ROLES.length}）`;
      for (const id of ids) {
        if (roles[id].provider !== 'p1' || roles[id].model !== 'm1') return `角色 ${id} 的路由不对：${JSON.stringify(roles[id])}`;
      }
      return true;
    });
  }

  // ── 1.6) 统一选择的边界语义 ────────────────────────────────────────────────
  {
    // 已有配置：researcher 用 p1/m1+high，其余两个用 p1/m2+low —— 正好造出「不一致」。
    const page = await mount({
      get: {
        ok: true,
        config: { version: 1, roles: {
          researcher: { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
          scout: { provider: 'p1', model: 'm2', reasoningEffort: 'low' },
          builder: { provider: 'p1', model: 'm2', reasoningEffort: 'low' },
        } },
        roles: ROLES,
        revision: '1:1',
        diagnostics: [],
      },
      'list-models': {
        ok: true,
        groups: [{ id: 'p1', name: 'Provider 1', models: [
          { id: 'm1', name: 'Model 1', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
          { id: 'm2', name: 'Model 2', reasoning: { efforts: [{ id: 'low', name: 'Low' }] } },
        ] }],
        failures: [],
      },
    });
    const tree = page.tree();
    const bulk = findAll(tree, (node) => node.props !== undefined && node.props.className === 'dat-bulk')[0];
    const bulkSelect = findAll(bulk, (node) => node.type === 'select')[0];
    const mixKey = '\u0000mixed';

    check('统一选择：各角色不一致时显示「不一致」占位，**不**谎称「跟随 Lead」', () => {
      if (bulkSelect.props.value !== mixKey) return `应为混合占位值，实际 ${JSON.stringify(bulkSelect.props.value)}`;
      const options = findAll(bulkSelect, (node) => node.type === 'option');
      const mixedOption = options.find((node) => node.props.value === mixKey);
      if (mixedOption === undefined) return '缺少混合占位项';
      if (mixedOption.props.disabled !== true) return '混合占位项应当是禁用（不可选中）';
      if (!textOf(mixedOption).includes('不一致')) return `占位文案不对：${textOf(mixedOption)}`;
      return true;
    });

    check('统一选择：选「跟随 Lead」= 清空全部角色（不是只清一行）', () => {
      bulkSelect.props.onChange({ target: { value: '' } });
      const after = page.repaint();
      const list = findAll(after, (node) => node.props !== undefined && node.props.className === 'dat-list')[0];
      const rows = findAll(list, (node) => node.props !== undefined && node.props.className === 'dat-row');
      const values = rows.map((row) => findAll(row, (node) => node.type === 'select')[0].props.value);
      const wrong = values.filter((value) => value !== '');
      if (wrong.length > 0) return `仍有 ${wrong.length} 个角色没被清空：${JSON.stringify(values)}`;
      return true;
    });

    // 单独 mount：上面那条「清空全部」会改掉共享草稿，接着测强度保留就会读到已被清空的状态。
    const effortPage = await mount({
      get: {
        ok: true,
        config: { version: 1, roles: { researcher: { provider: 'p1', model: 'm1', reasoningEffort: 'high' } } },
        roles: ROLES,
        revision: '1:1',
        diagnostics: [],
      },
      'list-models': {
        ok: true,
        groups: [{ id: 'p1', name: 'Provider 1', models: [
          { id: 'm1', name: 'Model 1', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
          { id: 'm2', name: 'Model 2', reasoning: { efforts: [{ id: 'low', name: 'Low' }] } },
        ] }],
        failures: [],
      },
    });
    let effortAfter = effortPage.repaint();
    // 第一步：统一设成 m1。researcher 原本 effort=high，m1 广告 high → 应当保留。
    findAll(findAll(effortAfter, (node) => node.props !== undefined && node.props.className === 'dat-bulk')[0], (node) => node.type === 'select')[0]
      .props.onChange({ target: { value: 'p1\u0000m1' } });
    effortAfter = effortPage.repaint();
    // 第二步：再统一设成 m2（只广告 low）→ high 不再被支持，应退回「模型默认」。
    findAll(findAll(effortAfter, (node) => node.props !== undefined && node.props.className === 'dat-bulk')[0], (node) => node.type === 'select')[0]
      .props.onChange({ target: { value: 'p1\u0000m2' } });
    effortAfter = effortPage.repaint();

    check('统一选择：思考强度按新模型重算 —— 仍支持则保留，不支持则退回「模型默认」', () => {
      const list = findAll(effortAfter, (node) => node.props !== undefined && node.props.className === 'dat-list')[0];
      const rows = findAll(list, (node) => node.props !== undefined && node.props.className === 'dat-row');
      // 统一设成 m2 后，所有角色的强度都应为「模型默认」（m2 只广告 low，原本的 high 不合法）。
      const efforts = rows.map((row) => findAll(row, (node) => node.type === 'select')[1].props.value);
      const wrong = efforts.filter((value) => value !== '');
      if (wrong.length > 0) return `不支持的档位没有被退回模型默认：${JSON.stringify(efforts)}`;
      return true;
    });

    // 反向：档位**仍被支持**时必须保留（否则统一选择会把用户已选的强度悄悄清掉）。
    {
      const keepPage = await mount({
        get: {
          ok: true,
          config: { version: 1, roles: { researcher: { provider: 'p1', model: 'm1', reasoningEffort: 'high' } } },
          roles: ROLES,
          revision: '1:1',
          diagnostics: [],
        },
        'list-models': {
          ok: true,
          groups: [{ id: 'p1', name: 'Provider 1', models: [
            { id: 'm1', name: 'Model 1', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
            { id: 'm3', name: 'Model 3', reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }] } },
          ] }],
          failures: [],
        },
      });
      const before = keepPage.repaint();
      findAll(findAll(before, (node) => node.props !== undefined && node.props.className === 'dat-bulk')[0], (node) => node.type === 'select')[0]
        .props.onChange({ target: { value: 'p1\u0000m3' } });
      const afterKeep = keepPage.repaint();
      check('统一选择：新模型仍支持原档位时保留该档位（不悄悄清掉用户已选的强度）', () => {
        const list = findAll(afterKeep, (node) => node.props !== undefined && node.props.className === 'dat-list')[0];
        const rows = findAll(list, (node) => node.props !== undefined && node.props.className === 'dat-row');
        const effort = findAll(rows[0], (node) => node.type === 'select')[1].props.value;
        if (effort !== 'high') return `m3 仍广告 high，却变成了 ${JSON.stringify(effort)}`;
        return true;
      });
    }

    const page2 = await mount({
      get: { ok: true, config: { version: 1, roles: { scout: { provider: 'p9', model: 'm9' } } }, roles: ROLES, revision: '1:1', diagnostics: [] },
      'list-models': { ok: false, error: 'ctx.llm 不可用' },
    });
    const bulk2 = findAll(page2.tree(), (node) => node.props !== undefined && node.props.className === 'dat-bulk')[0];
    if (bulk2 !== undefined) {
      const sel = findAll(bulk2, (node) => node.type === 'select')[0];
      if (sel !== undefined) sel.props.onChange({ target: { value: '' } });
    }
    const page3 = await mount({
      get: { ok: true, config: { version: 1, roles: {
        researcher: { provider: 'gone', model: 'm9' },
        scout: { provider: 'gone', model: 'm9' },
        builder: { provider: 'gone', model: 'm9' },
      } }, roles: ROLES, revision: '1:1', diagnostics: [] },
      'list-models': { ok: true, groups: [{ id: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1', reasoning: { efforts: [] } }] }], failures: [] },
    });
    const b3 = findAll(page3.tree(), (node) => node.props !== undefined && node.props.className === 'dat-bulk')[0];
    check('统一选择：已保存的模型不在当前目录时，下拉显示的就是那个真实值（不退回第一项）', () => {
      const b = b3;
      if (b === undefined) return '控件不存在';
      const sel = findAll(b, (node) => node.type === 'select')[0];
      if (sel.props.value !== 'gone\u0000m9') return `下拉值应为已保存的 gone/m9，实际 ${JSON.stringify(sel.props.value)}`;
      const opts = findAll(sel, (node) => node.type === 'option').map((o) => o.props.value);
      if (opts[0] !== '' || opts[1] !== 'gone\u0000m9') return `选项顺序应为[跟随Lead, 缺失占位, 目录]，实际 ${JSON.stringify(opts)}`;
      return true;
    });

    // ── 统一思考强度（2026-10-06）────────────────────────────────────────────
    // 用户追问「为啥不能统一思考强度」。结论：能，但只在**模型已统一**时才有确定含义，
    // 因为档位是每个模型各自广告的。下面把「能统一」与「为什么此时不能」两侧都钉住。
    {
      // 场景 A：模型已统一为 p1/m1（广告 high/low）→ 强度可统一。
      const effortUnify = await mount({
        get: { ok: true, config: { version: 1, roles: {} }, roles: ROLES, revision: '1:1', diagnostics: [] },
        'list-models': { ok: true, groups: [{ id: 'p1', name: 'P1', models: [
          { id: 'm1', name: 'M1', reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }] } },
        ] }], failures: [] },
      });
      let treeE = effortUnify.tree();
      findAll(findAll(treeE, (n) => n.props !== undefined && n.props.className === 'dat-bulk')[0], (n) => n.type === 'select')[0]
        .props.onChange({ target: { value: 'p1\u0000m1' } });
      treeE = effortUnify.repaint();
      const bulkE = findAll(treeE, (n) => n.props !== undefined && n.props.className === 'dat-bulk')[0];
      const effortSel = findAll(bulkE, (n) => n.type === 'select')[1];

      check('统一思考强度：模型统一后控件可用，且列出该模型广告的档位', () => {
        if (effortSel === undefined) return '统一选择控件里没有第二个下拉（思考强度）';
        if (effortSel.props.disabled === true) return '模型已统一，思考强度却仍被禁用';
        const ids = findAll(effortSel, (node) => node.type === 'option').map((o) => o.props.value);
        if (!ids.includes('high') || !ids.includes('low')) return `档位不全：${JSON.stringify(ids)}`;
        if (!ids.includes('')) return '缺少「不指定（模型默认）」选项';
        return true;
      });

      check('统一思考强度：选一次 → 所有角色都拿到该档位，并提示有未保存改动', () => {
        effortSel.props.onChange({ target: { value: 'high' } });
        const after = effortUnify.repaint();
        const rows = findAll(findAll(after, (n) => n.props !== undefined && n.props.className === 'dat-list')[0],
          (n) => n.props !== undefined && n.props.className === 'dat-row');
        const efforts = rows.map((row) => findAll(row, (node) => node.type === 'select')[1].props.value);
        const wrong = efforts.filter((value) => value !== 'high');
        if (wrong.length > 0) return `仍有 ${wrong.length} 个角色没被改到：${JSON.stringify(efforts)}`;
        if (!textOf(after).includes('有未保存改动')) return '统一改完没有未保存提示';
        return true;
      });

      {
        const after = await effortUnify.settle();
        findAll(after, (n) => n.type === 'button' && JSON.stringify(n.props.children).includes('保存'))[0].props.onClick();
        await flush();
      }
      check('统一思考强度：保存载荷里每个角色都带上了 model + reasoningEffort（成对）', () => {
        const call = sent.find((entry) => entry.op === 'set');
        if (call === undefined) return '没有发出 set 请求';
        const roles = call.args.roles || {};
        const ids = Object.keys(roles);
        if (ids.length !== ROLES.length) return `roles 只带了 ${ids.length} 个角色`;
        for (const id of ids) {
          if (roles[id].model !== 'm1') return `${id} 的 model 丢了：${JSON.stringify(roles[id])}`;
          if (roles[id].reasoningEffort !== 'high') return `${id} 的 reasoningEffort 不是 high：${JSON.stringify(roles[id])}`;
        }
        return true;
      });

      check('统一思考强度：统一成「不指定」时清掉全部档位（而不是只清一行）', () => {
        const cur = findAll(findAll(effortUnify.repaint(), (n) => n.props !== undefined && n.props.className === 'dat-bulk')[0], (n) => n.type === 'select')[1];
        cur.props.onChange({ target: { value: '' } });
        const after = effortUnify.repaint();
        const rows = findAll(findAll(after, (n) => n.props !== undefined && n.props.className === 'dat-list')[0],
          (n) => n.props !== undefined && n.props.className === 'dat-row');
        const efforts = rows.map((row) => findAll(row, (node) => node.type === 'select')[1].props.value);
        const wrong = efforts.filter((value) => value !== '');
        if (wrong.length > 0) return `仍有 ${wrong.length} 个角色没被清空：${JSON.stringify(efforts)}`;
        return true;
      });
    }

    // 场景 B：各角色模型不一致 → 强度控件必须**可见但禁用**，并写明原因与下一步。
    {
      const mixedModels = await mount({
        get: { ok: true, config: { version: 1, roles: {
          researcher: { provider: 'p1', model: 'm1' },
          scout: { provider: 'p1', model: 'm2' },
          builder: { provider: 'p1', model: 'm2' },
        } }, roles: ROLES, revision: '1:1', diagnostics: [] },
        'list-models': { ok: true, groups: [{ id: 'p1', name: 'P1', models: [
          { id: 'm1', name: 'M1', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
          { id: 'm2', name: 'M2', reasoning: { efforts: [{ id: 'low', name: 'Low' }] } },
        ] }], failures: [] },
      });
      const bulkM = findAll(mixedModels.tree(), (n) => n.props !== undefined && n.props.className === 'dat-bulk')[0];

      check('统一思考强度：模型不一致时禁用并说明「先统一模型」（不是把控件藏起来）', () => {
        const sel = findAll(bulkM, (n) => n.type === 'select')[1];
        if (sel === undefined) return '控件整个消失了 —— 用户只会看到「没有统一思考强度」却不知道为什么';
        if (sel.props.disabled !== true) return '模型不一致时思考强度不该可用（档位是每个模型各自广告的）';
        const shown = textOf(bulkM);
        if (!shown.includes('模型不一致')) return `没有给出原因：${shown}`;
        if (!shown.includes('先')) return '没有给出下一步动作（先统一模型）';
        return true;
      });

      check('统一思考强度：模型不一致时，不得把「第一个角色的档位」当成所有人的候选', () => {
        // 这条补的是上面那条 Mutation 测出来的盲区：只断言「禁用」时，
        // 若实现改成「不禁用且列出第一个角色的档位」，界面会**骗人**（那些档位对别的角色非法），
        // 而禁用类断言不会响。这里直接钉住「不许 advertise 任何档位」。
        const sel = findAll(bulkM, (n) => n.type === 'select')[1];
        if (sel === undefined) return '控件不存在';
        const ids = findAll(sel, (node) => node.type === 'option').map((o) => o.props.value).filter((v) => v !== '');
        if (ids.length > 0) return `模型不一致却列出了档位 ${JSON.stringify(ids)}（那些档位对别的角色可能非法）`;
        return true;
      });

      check('统一思考强度：模型不在目录 / 目录读不到时，禁用之余必须给出**准确**原因', () => {
        // 这两条是矩阵自检（六种状态逐个打印）发现的：控件禁用了却一条解释都没有，
        // 用户只会以为功能坏了。而且两种情况的原因**不同**，不能共用一句话
        //（「模型不在目录里」在目录整个读不到时是假指控）。
        // 这里只做静态检查：文案必须存在，且两种场景引用的 key 不是同一个。
        const src = require('node:fs').readFileSync(CLIENT, 'utf8');
        if (!src.includes('bulkEffortNoCatalog')) return '目录读不到的场景没有专门的说明文案';
        if (!src.includes('bulkEffortMixedModels')) return '模型不一致的场景没有说明文案';
        if (!src.includes('bulkEffortNoModel')) return '跟随 Lead 的场景没有说明文案';
        if (!src.includes('bulkEffortNone')) return '模型无档位的场景没有说明文案';
        // 目录缺失分支必须排在「record === undefined」之前，否则会被误报成「模型不在目录里」。
        const noCatAt = src.indexOf('bulkEffortNoCatalog');
        const unknownAt = src.indexOf("? text('effortUnknown')");
        if (noCatAt < 0 || unknownAt < 0 || noCatAt > unknownAt) {
          return '目录缺失的判断必须排在「模型不在目录」之前（否则会误报原因）';
        }
        return true;
      });

      check('统一思考强度：模型不一致时，模型下拉本身仍可用（先统一模型这条路要通）', () => {
        const sel = findAll(bulkM, (n) => n.type === 'select')[0];
        if (sel.props.disabled === true) return '模型下拉也被禁用了，用户没有任何出路';
        return true;
      });

      check('统一思考强度：「跟随 Lead」时禁用并说明强度依附于模型', () => {
        findAll(bulkM, (n) => n.type === 'select')[0].props.onChange({ target: { value: '' } });
        const after = mixedModels.repaint();
        const b2 = findAll(after, (n) => n.props !== undefined && n.props.className === 'dat-bulk')[0];
        const sel = findAll(b2, (n) => n.type === 'select')[1];
        if (sel.props.disabled !== true) return '全部跟随 Lead 时强度不该可用';
        if (!textOf(b2).includes('依附于模型')) return `没有给出原因：${textOf(b2)}`;
        return true;
      });
    }

    check('统一选择：模型目录读不到时仍可用（能一次把所有角色改回「跟随 Lead」）', () => {
      if (bulk2 === undefined) return '目录读不到时统一选择控件整个消失了';
      const select = findAll(bulk2, (node) => node.type === 'select')[0];
      if (select === undefined) return '统一选择控件里没有 select';
      if (select.props.disabled === true) return '目录读不到时统一选择被禁用（应当仍能把全部改回跟随 Lead）';
      const after = page2.repaint();
      const list = findAll(after, (node) => node.props !== undefined && node.props.className === 'dat-list')[0];
      const rows = findAll(list, (node) => node.props !== undefined && node.props.className === 'dat-row');
      const values = rows.map((row) => findAll(row, (node) => node.type === 'select')[0].props.value);
      const wrong = values.filter((value) => value !== '');
      if (wrong.length > 0) return `仍有 ${wrong.length} 个角色没被清空：${JSON.stringify(values)}`;
      return true;
    });
  }

  // ── 2) 宿主的 diagnostics 必须显示 ────────────────────────────────────────
  {
    const page = await mount({
      get: {
        ok: true,
        config: { version: 1, roles: {} },
        roles: ROLES,
        revision: '1:1',
        diagnostics: ['配置文件不是合法 JSON，已按空配置处理：Unexpected token'],
      },
      'list-models': { ok: true, groups: [], failures: [] },
    });
    const text = textOf(page.tree());
    check('宿主的 diagnostics 会显示在页面上（配置损坏不再被静默当成「全默认」）', () => {
      if (!text.includes('诊断')) return `没有出现诊断区块标题：${text.slice(0, 160)}`;
      if (!text.includes('不是合法 JSON')) return `诊断内容没显示：${text.slice(0, 200)}`;
      return true;
    });
  }

  // ── 2.5) 信息通道（notes）必须与故障通道分开渲染 ───────────────────────────
  // 复现 2026-09-28 的截图：那 5 行全是**正常事实**（主目录 / 配置文件路径 / 控制面注册成功），
  // 却被渲染在「宿主诊断（配置文件可能有问题）」这个红色标题下面 —— 用户以为坏了。
  {
    const page = await mount({
      get: {
        ok: true,
        config: { version: 1, roles: {} },
        roles: ROLES,
        revision: '1:1',
        diagnostics: [],
        notes: ['DSH 主目录：<DSH 主目录>（由 <home>/profiles 存在性确认）', '配置文件：<DSH 主目录>\\dispatch-agent-team.json'],
      },
      'list-models': { ok: true, groups: [], failures: [] },
    });
    const text = textOf(page.tree());
    check('正常事实走中性信息块：出现「宿主信息」，且**不**出现红色告警标题', () => {
      if (!text.includes('宿主信息')) return `没有信息块标题：${text.slice(0, 160)}`;
      if (!text.includes('配置文件：')) return `信息内容没显示：${text.slice(0, 220)}`;
      if (text.includes('配置文件可能有问题')) return '正常事实仍被渲染成「配置文件可能有问题」的告警';
      return true;
    });
  }

  // ── 3) failures 是对象数组 ────────────────────────────────────────────────
  {
    const page = await mount({
      get: { ok: true, config: { version: 1, roles: {} }, roles: ROLES, revision: '1:1', diagnostics: [] },
      'list-models': { ok: true, groups: [], failures: [{ id: 'p1', name: 'Provider 1', message: 'listModels 失败：boom' }] },
    });
    const text = textOf(page.tree());
    check('模型目录 failures 渲染成可读文字（不是 [object Object]）', () => {
      if (text.includes('[object Object]')) return '页面上出现了 [object Object]';
      if (!text.includes('listModels 失败')) return `没有渲染失败原因：${text.slice(0, 200)}`;
      return true;
    });
    check('failures 优先于「目录是空的」（否则真实原因被盖掉）', () => (text.includes('模型目录是空的') ? '显示了「目录是空的」把失败原因盖住了' : true));
  }

  // ── 4) 目录读取失败 ───────────────────────────────────────────────────────
  {
    const page = await mount({
      get: {
        ok: true,
        config: { version: 1, roles: { scout: { provider: 'gone', model: 'gone-m', reasoningEffort: 'high' } } },
        roles: ROLES,
        revision: '1:1',
        diagnostics: [],
      },
      'list-models': { ok: false, error: 'ctx.llm 服务不可用，无法列举模型目录' },
    });
    const tree = page.tree();
    const text = textOf(tree);
    check('目录读取失败：给出可操作的原因', () => (text.includes('ctx.llm') ? true : `没有显示失败原因：${text.slice(0, 200)}`));
    check('目录读取失败：模型下拉仍可操作（能改回「跟随 Lead」）', () => {
      const selects = findAll(tree, (node) => node.type === 'select');
      const modelSelects = selects.filter((select) => findAll(select, (node) => node.type === 'option').some((option) => String(option.props.value) === ''));
      if (modelSelects.length === 0) return '找不到模型下拉';
      if (modelSelects.every((select) => select.props.disabled === true)) return '目录读不到时模型下拉被全部禁用，用户无法改回「跟随 Lead」';
      return true;
    });
    check('目录读取失败：仍提示「只能选跟随 Lead 或保留已保存的值」', () => (text.includes('只能选') ? true : `缺少提示：${text.slice(0, 200)}`));
  }

  // ── 5) 保存：revision 与冲突 ──────────────────────────────────────────────
  {
    const page = await mount({
      get: { ok: true, config: { version: 1, roles: {} }, roles: ROLES, revision: 'aaa:1', diagnostics: [] },
      'list-models': { ok: true, groups: [{ id: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1' }] }], failures: [] },
      set: { ok: false, conflict: true, revision: 'bbb:2', error: '磁盘上的配置在这期间被改过，本次保存已取消' },
    });
    const tree = page.tree();
    findAll(tree, (node) => node.type === 'select')[0].props.onChange({ target: { value: 'p1\u0000m1' } });
    const after = page.repaint();
    findAll(after, (node) => node.type === 'button' && textOf(node).includes('保存'))[0].props.onClick();
    await page.settle();
    await page.settle();

    check('保存请求带上了读到的 revision（乐观并发的前置条件）', () => {
      const call = page.sent().find((entry) => entry.op === 'set');
      if (call === undefined) return '没有发出 set 请求';
      if (call.args === undefined || call.args.revision !== 'aaa:1') return `args=${JSON.stringify(call.args)}`;
      return true;
    });

    check('保存冲突时显示「保存冲突」而不是普通失败', () => {
      const text = textOf(page.tree());
      if (!text.includes('保存冲突')) return `没有显示冲突文案：${text.slice(-200)}`;
      return true;
    });
  }

  // ── 6) 保存成功路径与 revision 回写 ───────────────────────────────────────
  {
    const page = await mount({
      get: { ok: true, config: { version: 1, roles: {} }, roles: ROLES, revision: 'aaa:1', diagnostics: [] },
      'list-models': { ok: true, groups: [{ id: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1' }] }], failures: [] },
      set: { ok: true, config: { version: 1, roles: { scout: { provider: 'p1', model: 'm1' } } }, revision: 'ccc:3', diagnostics: [] },
    });
    const tree = page.tree();
    findAll(tree, (node) => node.type === 'select')[0].props.onChange({ target: { value: 'p1\u0000m1' } });
    findAll(page.repaint(), (node) => node.type === 'button' && textOf(node).includes('保存'))[0].props.onClick();
    await page.settle();
    await page.settle();

    check('保存成功后显示成功提示，草稿回到「无未保存改动」', () => {
      const text = textOf(page.tree());
      if (!text.includes('已保存')) return `没有成功提示：${text.slice(-200)}`;
      if (text.includes('有未保存改动')) return '保存成功后仍显示「有未保存改动」';
      return true;
    });

    // 第二次改一次再保存，看它带的是不是宿主回传的新 revision
    const tree2 = page.tree();
    const selects = findAll(tree2, (node) => node.type === 'select');
    selects[selects.length - 1].props.onChange({ target: { value: '' } });
    findAll(page.repaint(), (node) => node.type === 'button' && textOf(node).includes('保存'))[0].props.onClick();
    await page.settle();
    await page.settle();
    const secondSet = page.sent().filter((entry) => entry.op === 'set').pop();
    check('第二次保存带的是宿主回传的新 revision（不是旧的那份 → 避免必冲突）',
      () => (secondSet !== undefined && secondSet.args.revision === 'ccc:3' ? true : `第二次 set 的 revision=${secondSet === undefined ? '(无)' : secondSet.args.revision}`));
  }

  // ── 8) 缓存保活面板（2026-09-30） ─────────────────────────────────────────
  {
    const page = await mount({
      get: {
        ok: true,
        config: { version: 1, roles: {}, cache: { keepalive: { routes: { 'p1/m1': { mode: 'on', intervalSeconds: 180 } } } } },
        roles: ROLES,
        revision: 'ddd:4',
        diagnostics: [],
        cache: {
          installed: true,
          active: true,
          mode: 'auto',
          source: 'route-family:generic',
          intervalSeconds: 210,
          provider: 'p1',
          model: 'm1',
          armed: true,
          stopped: undefined,
          pingTokens: 4200,
          stats: { requests: 12, pings: 3, pingHits: 2, hitRatio: 0.9 },
        },
        cacheFamilies: [
          { id: 'deepseek', mode: 'off', ttlSeconds: null, why: '磁盘缓存，等待几分钟不会过期' },
          { id: 'generic', mode: 'auto', ttlSeconds: 300, why: '未列出线路按最短 TTL 处理' },
        ],
        reports: [{ at: '2026-09-30T00:00:00Z', name: 'builder', status: 'blocked', unresolved: ['测试没跑', '依赖缺失'] }],
        sessions: { file: 'C:\\temp\\dispatch-agent-team-sessions.json', tracked: 3, restoredThisProcess: 1 },
      },
      'list-models': { ok: true, groups: [{ id: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1' }] }], failures: [] },
      set: { ok: true, config: { version: 1, roles: {}, cache: { keepalive: { routes: { 'p1/m1': { mode: 'on', intervalSeconds: 180 } } } } }, revision: 'eee:5', diagnostics: [] },
    });
    const text = textOf(page.tree());
    check('缓存保活面板：显示线路/模式/间隔/命中率/保活次数（数字来自宿主，不美化）', () => {
      if (!text.includes('缓存保活')) return `没有缓存段标题：${text.slice(0, 160)}`;
      if (!text.includes('p1/m1')) return '没有显示当前线路';
      if (!text.includes('route-family:generic')) return '没有显示策略来源';
      if (!text.includes('间隔：210 秒')) return '没有显示间隔';
      if (!text.includes('90%')) return `没有显示缓存命中率：${text.slice(-400)}`;
      if (!text.includes('保活 3 次（命中 2，读 4200 token）')) return '没有显示保活统计';
      if (!text.includes('deepseek：off')) return '没有显示线路族默认（含 deepseek=off 的理由）';
      if (!text.includes('builder · blocked，未决 2 项')) return '没有显示结构化汇报与未决项';
      if (!text.includes('会话记忆')) return '没有显示会话记忆段（宿主重启后自动恢复开团的会话）';
      if (!text.includes('3 个会话在案 · 本进程已恢复 1 次')) return `会话记忆数字不对：${text.slice(-300)}`;
      return true;
    });

    // 编辑一条线路覆盖 → 保存时必须把 cache 一起提交（否则「改了没生效」）
    const addKey = findAll(page.tree(), (node) => node.type === 'input' && node.props.placeholder !== undefined)[0];
    addKey.props.onChange({ target: { value: 'deepseek' } });
    const afterKey = page.repaint();
    const addButton = findAll(afterKey, (node) => node.type === 'button' && textOf(node).includes('添加覆盖'))[0];
    addButton.props.onClick();
    const afterAdd = page.repaint();
    const save = findAll(afterAdd, (node) => node.type === 'button' && textOf(node).includes('保存'))[0];
    check('缓存保活面板：编辑线路覆盖后会提示「有未保存改动」，且「保存」可用', () => {
      if (!textOf(afterAdd).includes('有未保存改动')) return '改了保活设置却没有未保存提示';
      if (save === undefined || save.props.disabled === true) return '「保存」仍然禁用';
      return true;
    });
    save.props.onClick();
    await page.settle();
    await page.settle();
    const setCall = page.sent().filter((entry) => entry.op === 'set').pop();
    check('缓存保活面板：保存请求把 cache.keepalive.routes 一起带上（含新加的 deepseek=auto）', () => {
      if (setCall === undefined) return '没有发出 set 请求';
      const routes = setCall.args.cache?.keepalive?.routes;
      if (routes === undefined) return 'set 请求里没有 cache.keepalive.routes';
      if (routes['p1/m1']?.mode !== 'on') return `原有覆盖丢了：${JSON.stringify(routes)}`;
      if (routes.deepseek?.mode !== 'auto') return `新加的覆盖没带上：${JSON.stringify(routes)}`;
      return true;
    });
  }

  // ── 9) 队员 agent 预设这一列（2026-10-15）──────────────────────────────────
  // 这一列最容易出的错不是「不显示」，而是**静默丢数据**：草稿管道里任何一个构造函数
  // 少带一个 preset，用户保存后那一半配置就没了。所以断言全部围绕「读回来 = 显示 = 存回去」。
  // 定位一律**按列标题文字**，不按「第几个 select」：思考强度那一格在某些目录形状下会
  // 整个不渲染，位置索引会指错列（这条我自己踩过）。
  {
    const PRESET_TABLE = {
      presets: [
        { id: 'ptc', name: '', available: true, reason: '', detail: '' },
        { id: 'standard', name: '', available: true, reason: '', detail: '' },
        { id: 'minimal-grayscale', name: '极简灰度模式', available: true, reason: '', detail: '' },
        { id: 'liangshen', name: '梁神模式', available: false, reason: 'not-registered', detail: '' },
      ],
      notes: [],
    };
    const optionItems = (node) => {
      const out = [];
      const walk = (x) => {
        if (Array.isArray(x)) { for (const item of x) walk(item); return }
        if (x === null || x === undefined || typeof x !== 'object') return
        if (x.type === 'option') out.push({ value: String(x.props.value), disabled: x.props.disabled === true })
        walk(x.props === undefined ? undefined : x.props.children)
      };
      walk(node === undefined || node === null ? undefined : node.props.children);
      return out;
    };
    /** 角色行按**角色 id** 找（dat-row 这个类名缓存保活的覆盖行也在用，位置索引会指错；行顺序也不归测试说了算）。 */
    const roleRow = (root, roleId) => findAll(root, (node) => {
      if (node.type !== 'div' || node.props.className !== 'dat-row') return false;
      const code = findAll(node, (inner) => inner.type === 'code')[0];
      return code !== undefined && textOf(code) === roleId;
    })[0];
    /** 某个角色行里，标题为 label 的那一格下拉。 */
    const selectInRow = (root, roleId, label) => {
      const row = roleRow(root, roleId);
      if (row === undefined) return undefined;
      for (const field of findAll(row, (node) => node.type === 'label' && node.props.className === 'dat-field')) {
        const head = findAll(field, (node) => node.type === 'span' && node.props.className === 'dat-label')[0];
        if (head === undefined || textOf(head) !== label) continue;
        const sel = findAll(field, (node) => node.type === 'select')[0];
        if (sel !== undefined) return sel;
      }
      return undefined;
    };
    /** 「统一选择」那一块里标题为 label 的下拉（整页只有一处用这些标题）。 */
    const bulkSelect = (root, label) => {
      const bulk = findAll(root, (node) => node.type === 'div' && node.props.className === 'dat-bulk')[0];
      if (bulk === undefined) return undefined;
      for (const field of findAll(bulk, (node) => node.type === 'label' && node.props.className === 'dat-field')) {
        const head = findAll(field, (node) => node.type === 'span' && node.props.className === 'dat-label')[0];
        if (head === undefined || textOf(head) !== label) continue;
        const sel = findAll(field, (node) => node.type === 'select')[0];
        if (sel !== undefined) return sel;
      }
      return undefined;
    };
    const PRESET_COL = 'agent 预设';
    const BULK_PRESET_COL = 'agent 预设（应用到全部角色）';
    const page = await mount({
      get: {
        ok: true,
        config: { version: 1, roles: { scout: { preset: 'standard' } } },
        roles: ROLES,
        revision: 'aaa:1',
        diagnostics: [],
        agentPresets: PRESET_TABLE,
      },
      'list-models': { ok: true, groups: [{ id: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1' }] }], failures: [] },
      // 保存成功后组件**以宿主回传的净化结果为准**重建草稿（onSave 里那条），所以这里必须
      // 如实回它保存的那一份，否则后面几条断言测的是「fixture 骗人」。
      set: { ok: true, config: { version: 1, roles: { scout: { preset: 'ptc' } } }, revision: 'bbb:2', diagnostics: [] },
    });

    check('每行有「agent 预设」下拉，且已保存的预设显示成它自己（读回来 = 显示）', () => {
      const sel = selectInRow(page.tree(), 'scout', PRESET_COL);
      if (sel === undefined) return '第一行里没有标题为「' + PRESET_COL + '」的下拉：' + textOf(page.tree()).slice(0, 160);
      if (sel.props.value !== 'standard') return '预设下拉显示的是 ' + JSON.stringify(sel.props.value) + '，不是已保存的 standard';
      return true;
    });

    check('预设选项：跟随 Lead 与三个 id 都在，注册表里没有的那项在但禁用（不藏）', () => {
      const items = optionItems(selectInRow(page.tree(), 'scout', PRESET_COL));
      const values = items.map((item) => item.value);
      for (const want of ['', 'ptc', 'standard', 'minimal-grayscale']) {
        if (!values.includes(want)) return '选项不全：' + values.join(' | ');
      }
      const stale = items.find((item) => item.value === 'liangshen');
      if (stale === undefined) return '不可用的预设被藏起来了（用户会以为功能坏了）';
      if (stale.disabled !== true) return '不可用的预设竟然可选（选了保存会被宿主拒掉）';
      return true;
    });

    selectInRow(page.tree(), 'scout', PRESET_COL).props.onChange({ target: { value: 'ptc' } });
    findAll(page.repaint(), (node) => node.type === 'button' && textOf(node).includes('保存'))[0].props.onClick();
    await page.settle();
    await page.settle();
    const onlyPreset = page.sent().filter((entry) => entry.op === 'set').pop();
    check('只改预设：set 里该角色只带 preset，没有 provider/model（不猜路由）', () => {
      const scout = onlyPreset === undefined ? undefined : onlyPreset.args.roles.scout;
      if (scout === undefined) return 'set 里没有 scout：' + JSON.stringify(onlyPreset === undefined ? null : onlyPreset.args.roles);
      if (scout.preset !== 'ptc') return 'preset=' + JSON.stringify(scout.preset);
      if (scout.provider !== undefined || scout.model !== undefined) return '不该带上模型：' + JSON.stringify(scout);
      return true;
    });

    check('改模型不许顺手清掉预设（草稿管道少带一个字段 = 静默丢配置）', () => {
      const before = selectInRow(page.tree(), 'scout', PRESET_COL);
      if (before === undefined || before.props.value !== 'ptc') return '改模型前预设已经不是 ptc 了';
      selectInRow(page.tree(), 'scout', '模型').props.onChange({ target: { value: 'p1\u0000m1' } });
      const after = selectInRow(page.repaint(), 'scout', PRESET_COL);
      if (after === undefined || after.props.value !== 'ptc') return '改模型把预设清成了 ' + JSON.stringify(after === undefined ? null : after.props.value);
      return true;
    });

    check('清掉模型后预设仍留在行里（两个维度各自独立）', () => {
      selectInRow(page.tree(), 'scout', '模型').props.onChange({ target: { value: '' } });
      const after = selectInRow(page.repaint(), 'scout', PRESET_COL);
      if (after === undefined || after.props.value !== 'ptc') return '清模型后预设变成 ' + JSON.stringify(after === undefined ? null : after.props.value);
      return true;
    });

    check('统一选择预设：一次改完全部 12 个角色', () => {
      const bulk = bulkSelect(page.tree(), BULK_PRESET_COL);
      if (bulk === undefined) return '统一块里没有「' + BULK_PRESET_COL + '」这一格';
      bulk.props.onChange({ target: { value: 'minimal-grayscale' } });
      const after = page.repaint();
      const values = [];
      for (const role of ROLES) {
        const sel = selectInRow(after, role.id, PRESET_COL);
        values.push(sel === undefined ? '(缺行)' + role.id : String(sel.props.value));
      }
      if (values.some((value) => value !== 'minimal-grayscale')) return '统一后：' + values.join(' | ');
      return true;
    });

    check('统一预设不动模型与强度（三列各管各的）', () => {
      const model = selectInRow(page.tree(), 'builder', '模型');
      if (model === undefined) return '第 4 行找不到模型下拉';
      if (model.props.value !== '') return '统一预设把模型也改了：' + model.props.value;
      return true;
    });
  }

  // 旧宿主 / agentPresets 服务缺席：这一列必须禁用并说明原因，而不是空下拉或崩掉。
  {
    const page = await mount({
      get: { ok: true, config: { version: 1, roles: {} }, roles: ROLES, revision: 'aaa:1', diagnostics: [] },
      'list-models': { ok: true, groups: [], failures: [] },
    });
    const tree = page.tree();
    const rows = findAll(tree, (node) => node.type === 'div' && node.props.className === 'dat-row');
    let sel;
    for (const field of findAll(rows[0], (node) => node.type === 'label' && node.props.className === 'dat-field')) {
      const head = findAll(field, (node) => node.type === 'span' && node.props.className === 'dat-label')[0];
      if (head !== undefined && textOf(head) === 'agent 预设') sel = findAll(field, (node) => node.type === 'select')[0];
    }
    check('宿主没带预设表：这一列仍渲染但禁用（用户看得见「读不到」，不是少了功能）', () => {
      if (sel === undefined) return '预设下拉没渲染出来';
      if (sel.props.disabled !== true) return '读不到注册表却仍可点（选了会被宿主拒）';
      return true;
    });
    check('宿主没带预设表：统一那一列给出唯一原因', () => {
      const text = textOf(tree);
      if (!text.includes('读不到')) return '没有说明原因：' + text.slice(-240);
      return true;
    });
  }

  // ── 10) 布局结构：三个下拉必须是同级（2026-10-15 用户报「总控页面空白太多」）────
  //
  // 上面 §9 的定位全是 findAll（**后代**搜索），所以「预设那一格被套进强度格里面」它照样
  // 找得到 —— React 对嵌套 label 一句不报，坏掉的只有版面：flex 容器里只剩两格，左边
  // 空出一整块、中间空出一整块。这类 bug 只能靠**直接子节点**判据抓到，故本节点用
  // node.props.children（替身把 children 平铺成数组，同级关系就是数组元素，嵌套的在更深层）。
  {
    const page = await mount({
      get: {
        ok: true,
        config: { version: 1, roles: { scout: { preset: 'standard' } } },
        roles: ROLES,
        revision: 'aaa:1',
        diagnostics: [],
        agentPresets: { presets: [{ id: 'ptc', name: '', available: true, reason: '', detail: '' }], notes: [] },
      },
      'list-models': { ok: true, groups: [{ id: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1' }] }], failures: [] },
    });
    const tree = page.tree();
    /** 某个 dat-field 里那一格的列标题。 */
    const fieldLabel = (field) => {
      const head = findAll(field, (node) => node.type === 'span' && node.props.className === 'dat-label')[0];
      return head === undefined ? '' : textOf(head);
    };
    const isField = (node) => node.type === 'label' && node.props.className === 'dat-field';

    check('全局：没有任何 dat-field 套在另一个 dat-field 里面（同级判据）', () => {
      const nested = [];
      const walk = (node, insideField) => {
        if (node === null || node === undefined || typeof node !== 'object') return;
        if (Array.isArray(node)) { for (const item of node) walk(item, insideField); return; }
        const nowField = isField(node);
        if (nowField && insideField !== undefined) nested.push(fieldLabel(node) || '(无标题)');
        walk(node.props === undefined ? undefined : node.props.children, nowField ? node : insideField);
      };
      walk(tree.props.children, undefined);
      if (nested.length > 0) return '这些下拉被嵌进了别的下拉里（同级才会并排）：' + nested.join(' | ');
      return true;
    });

    check('统一选择块：模型 / 思考强度 / agent 预设 三格都是 dat-bulk-ctl 的直接子节点', () => {
      const ctl = findAll(tree, (node) => node.type === 'div' && node.props.className === 'dat-bulk-ctl')[0];
      if (ctl === undefined) return '找不到 dat-bulk-ctl';
      const direct = (ctl.props.children || []).filter(isField).map(fieldLabel);
      const want = ['模型（应用到全部角色）', '思考强度（应用到全部角色）', 'agent 预设（应用到全部角色）'];
      const missing = want.filter((label) => !direct.includes(label));
      if (missing.length > 0) return '直接子节点只有 [' + direct.join(' | ') + ']，缺 ' + missing.join(' | ');
      return true;
    });

    check('角色行：模型与 agent 预设同为 dat-ctl 的直接子节点（逐行那一列也不许套娃）', () => {
      const row = findAll(tree, (node) => {
        if (node.type !== 'div' || node.props.className !== 'dat-row') return false;
        const code = findAll(node, (inner) => inner.type === 'code')[0];
        return code !== undefined && textOf(code) === 'scout';
      })[0];
      if (row === undefined) return '找不到 scout 行';
      const ctl = findAll(row, (node) => node.type === 'div' && node.props.className === 'dat-ctl')[0];
      if (ctl === undefined) return 'scout 行里没有 dat-ctl';
      const direct = (ctl.props.children || []).filter(isField).map(fieldLabel);
      for (const label of ['模型', 'agent 预设']) {
        if (!direct.includes(label)) return 'dat-ctl 的直接子节点是 [' + direct.join(' | ') + ']，缺「' + label + '」';
      }
      return true;
    });
  }

  // ── 12)「推荐」按钮（2026-10-16 用户：在统一选择那块右上角加一个推荐，点一下填好并保存）──
  //
  // 用户诉求原话：「在画圈的地方加一个推荐，点击之后直接就可以直接把最适合这个队员的基本信息填上并保存」。
  // 所以钉四件事：① 按钮渲染在 dat-bulk-head 里（= 画圈那一行）；② 点一下**既填又存**
  // （发出 set，载荷里 preset/batch 正确、模型与强度**没被改动**）；③ 回执要说清只动了两格；
  // ④ 宿主没回推荐取值时按钮禁用并写明原因（不许静默少一个功能）。
  {
    const page = await mount({
      get: {
        ok: true,
        config: { version: 1, roles: {
          researcher: { provider: 'p1', model: 'm1', reasoningEffort: 'high', preset: 'standard', batch: false },
          scout: { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
          builder: { provider: 'p1', model: 'm1', reasoningEffort: 'high', preset: 'ptc', batch: false },
        } },
        roles: ROLES,
        revision: 'rec:1',
        diagnostics: [],
        agentPresets: { presets: [{ id: 'ptc', name: '', available: true, reason: '', detail: '' }], notes: [] },
        recommendations: [ { roleId: 'researcher', preset: 'ptc', batch: false }, { roleId: 'scout', preset: 'ptc', batch: false }, { roleId: 'builder', preset: 'ptc', batch: true }, ], recommendationRule: '规则文本（只读型走纯 PTC，写域型保留批量调用）',
      },
      'list-models': { ok: true, groups: [{ id: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }], failures: [] },
      set: { ok: true, config: { version: 1, roles: {} }, revision: 'rec:2' },
    });
    const tree = page.tree();
    const head = findAll(tree, (node) => node.type === 'div' && node.props.className === 'dat-bulk-head')[0];
    const btn = findAll(head === undefined ? { props: { children: [] } } : head, (node) => node.type === 'button' && textOf(node) === '推荐')[0];

    check('推荐按钮渲染在统一选择那一行（dat-bulk-head = 用户画圈的位置）', () => {
      if (head === undefined) return '找不到 dat-bulk-head';
      if (btn === undefined) return 'dat-bulk-head 里没有「推荐」按钮';
      if (btn.props.disabled === true) return '有推荐取值时按钮却被禁用';
      return true;
    });
    check('推荐按钮的 title 用宿主回传的规则文本（页面不自己写一份理由）', () => {
      if (btn.props.title !== '规则文本（只读型走纯 PTC，写域型保留批量调用）') return JSON.stringify(btn.props.title);
      return true;
    });

    btn.props.onClick();
    await flush();
    check('点一下 = 直接保存（发出 set，且带读到的 revision）', () => {
      const call = sent.find((entry) => entry.op === 'set');
      if (call === undefined) return '点「推荐」没有发出 set 请求（只填不存 = 用户还得自己点保存）';
      if (call.args.revision !== 'rec:1') return '没带上读到的 revision：' + JSON.stringify(call.args.revision);
      return true;
    });
    check('点一下 = 按角色填对两格，且模型与思考强度原样保留', () => {
      const roles = sent.find((entry) => entry.op === 'set').args.roles;
      const want = {
        researcher: { preset: 'ptc', batch: false },   // 原本就是纯 PTC：保持
        scout: { preset: 'ptc', batch: false },        // 原本没有 batch 键（默认开）→ 推荐关 = 落键 false
        builder: { preset: 'ptc', batch: undefined },  // 写域型：从「关」被拨回「开」= 默认 = 不落键
      };
      for(const id of Object.keys(want)) {
        const row = roles[id];
        if (row === undefined) return id + ' 没进载荷';
        if (row.preset !== want[id].preset) return id + ' preset=' + row.preset;
        if (row.batch !== want[id].batch) return id + ' batch=' + JSON.stringify(row.batch) + '（应为 ' + JSON.stringify(want[id].batch) + '）';
        if (row.provider !== 'p1' || row.model !== 'm1' || row.reasoningEffort !== 'high') return id + ' 的模型/强度被改了：' + JSON.stringify(row);
      }
      return true;
    });
    check('保存成功的回执说清「只填了两格、模型与强度未动」', () => {
      const text = textOf(page.repaint());
      if (!text.includes('模型与思考强度未改动')) return '回执没说明改动范围：' + text.slice(-260);
      return true;
    });
  }
  {
    // 降级：宿主是旧版（get 不回 recommendations）→ 按钮不许消失，要禁用 + 给原因。
    const page = await mount({
      get: { ok: true, config: { version: 1, roles: {} }, roles: ROLES, revision: 'x:1', diagnostics: [] },
      'list-models': { ok: true, groups: [], failures: [] },
    });
    const tree = page.tree();
    const head = findAll(tree, (node) => node.type === 'div' && node.props.className === 'dat-bulk-head')[0];
    const btn = findAll(head, (node) => node.type === 'button' && textOf(node) === '推荐')[0];
    check('宿主没回推荐取值：按钮仍渲染但禁用，并写明原因（不静默少功能）', () => {
      if (btn === undefined) return '按钮整个消失了';
      if (btn.props.disabled !== true) return '读不到推荐取值却仍可点';
      const text = textOf(tree);
      if (!text.includes('宿主没有回传推荐取值')) return '没有给出原因：' + text.slice(-200);
      return true;
    });
  }

  // ── 11) 批量调用开关（both 档，2026-10-15 用户选路径 1：默认开 + 开关放控件列左边）──
  //
  // 这一维最容易出的两种错：① 开关被摞进右边那一列（用户明确不要的版面）；
  // ② 拨了开关但保存时被别的列挤掉（草稿行是四字段对象，任何一处绕过 makeRow 都会丢）。
  // 所以断言同时盯**结构**（直接子节点）与**往返**（读回来 = 显示 = 存回去）。
  {
    const page = await mount({
      get: {
        ok: true,
        config: {
          version: 1,
          roles: {
            builder: { provider: 'p', model: 'm1', preset: 'ptc', batch: false },
            scout: { batch: false },
          },
        },
        roles: ROLES,
        revision: 'aaa:1',
        diagnostics: [],
        agentPresets: { presets: [{ id: 'ptc', name: '', available: true, reason: '', detail: '' }], notes: [] },
      },
      'list-models': { ok: true, groups: [{ id: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1', efforts: [{ id: 'low', name: 'Low' }] }] }], failures: [] },
      set: { ok: true, config: { version: 1, roles: {} }, revision: 'bbb:2', diagnostics: [] },
    });
    /** 某个角色行里那一颗批量开关（连同它那一格与整行）。 */
    const batchBox = (root, roleId) => {
      const row = findAll(root, (node) => {
        if (node.type !== 'div' || node.props.className !== 'dat-row') return false;
        const code = findAll(node, (inner) => inner.type === 'code')[0];
        return code !== undefined && textOf(code) === roleId;
      })[0];
      if (row === undefined) return undefined;
      const cell = findAll(row, (node) => node.type === 'label' && node.props.className === 'dat-batch')[0];
      if (cell === undefined) return undefined;
      const box = findAll(cell, (node) => node.type === 'input')[0];
      return box === undefined ? undefined : { cell, box, row };
    };
    /** 某个角色行里、列标题为 label 的那个下拉（与 §9 同一套定位：按标题文字，不按位置）。 */
    const selectOf = (root, roleId, label) => {
      const row = findAll(root, (node) => {
        if (node.type !== 'div' || node.props.className !== 'dat-row') return false;
        const code = findAll(node, (inner) => inner.type === 'code')[0];
        return code !== undefined && textOf(code) === roleId;
      })[0];
      if (row === undefined) return undefined;
      for (const field of findAll(row, (node) => node.type === 'label' && node.props.className === 'dat-field')) {
        const head = findAll(field, (node) => node.type === 'span' && node.props.className === 'dat-label')[0];
        if (head === undefined || textOf(head) !== label) continue;
        const sel = findAll(field, (node) => node.type === 'select')[0];
        if (sel !== undefined) return sel;
      }
      return undefined;
    };
    const bulkBatchBox = (root) => {
      const bulk = findAll(root, (node) => node.type === 'div' && node.props.className === 'dat-bulk')[0];
      if (bulk === undefined) return undefined;
      for (const field of findAll(bulk, (node) => node.type === 'label' && node.props.className === 'dat-field')) {
        const head = findAll(field, (node) => node.type === 'span' && node.props.className === 'dat-label')[0];
        if (head === undefined || textOf(head) !== '批量调用（应用到全部角色）') continue;
        const box = findAll(field, (node) => node.type === 'input')[0];
        if (box !== undefined) return { field, box };
      }
      return undefined;
    };
    const save = () => {
      const btn = findAll(page.tree(), (node) => node.type === 'button' && textOf(node).includes('保存'))[0];
      btn.props.onClick();
    };

    check('每个角色行都有一颗批量开关，已关掉的那颗显示为未勾选（读回来 = 显示）', () => {
      const tree = page.tree();
      const scout = batchBox(tree, 'scout');
      if (scout === undefined) return 'scout 行里没有 dat-batch 那一格';
      if (scout.box.props.checked !== false) return '配置里 batch:false，界面上却仍是勾选状态';
      const researcher = batchBox(tree, 'researcher');
      if (researcher === undefined) return 'researcher 行里没有 dat-batch 那一格';
      if (researcher.box.props.checked !== true) return '没配任何维度的角色应当默认打勾（默认开）';
      const builder = batchBox(tree, 'builder');
      if (builder === undefined || builder.box.props.checked !== false) return 'builder 的 batch:false 没读回来';
      return true;
    });

    check('版面：批量开关是 dat-row 的直接子节点，且不在 dat-ctl 那一列里', () => {
      const found = batchBox(page.tree(), 'scout');
      if (found === undefined) return '找不到 scout 的开关';
      const ctl = findAll(found.row, (node) => node.type === 'div' && node.props.className === 'dat-ctl')[0];
      if (ctl === undefined) return '找不到 dat-ctl（行结构变了，本条判据要重写）';
      if (findAll(ctl, (node) => node === found.cell).length > 0) return '批量开关被放进了 dat-ctl 那一列';
      if ((found.row.props.children || []).indexOf(found.cell) < 0) return 'dat-batch 不是 dat-row 的直接子节点';
      return true;
    });

    check('统一那一格：角色不一致时不打勾（有一格关掉就不打勾）', () => {
      const bulk = bulkBatchBox(page.tree());
      if (bulk === undefined) return '统一选择块里找不到「批量调用（应用到全部角色）」';
      if (bulk.box.props.checked !== false) return 'scout/builder 是关的，统一格却打勾了（骗人）';
      return true;
    });

    check('关掉批量后再改模型，batch 仍是 false（四字段收口到 makeRow 的行为证明）', () => {
      const researcher = batchBox(page.tree(), 'researcher');
      researcher.box.props.onChange({ target: { checked: false } });
      const model = selectOf(page.repaint(), 'researcher', '模型');
      if (model === undefined) return '找不到 researcher 的模型下拉';
      model.props.onChange({ target: { value: 'p1\u0000m1' } });
      const after = batchBox(page.repaint(), 'researcher');
      if (after === undefined || after.box.props.checked !== false) return '改模型把批量开关拨回了开';
      return true;
    });

    check('统一开关：一次拨全部角色，且不动模型/强度/预设', () => {
      const bulk = bulkBatchBox(page.tree());
      if (bulk === undefined) return '找不到统一格';
      bulk.box.props.onChange({ target: { checked: true } });
      const after = page.repaint();
      const bad = [];
      for (const role of ROLES) {
        const found = batchBox(after, role.id);
        if (found === undefined || found.box.props.checked !== true) bad.push(role.id);
      }
      if (bad.length > 0) return '统一开后仍未勾选的角色：' + bad.join(' ');
      const preset = selectOf(after, 'builder', 'agent 预设');
      if (preset === undefined || preset.props.value !== 'ptc') return '统一批量把 builder 的预设改掉了：' + JSON.stringify(preset === undefined ? null : preset.props.value);
      bulk.box.props.onChange({ target: { checked: false } });
      const off = page.repaint();
      const stillOn = ROLES.filter((role) => {
        const found = batchBox(off, role.id);
        return found === undefined || found.box.props.checked !== false;
      }).map((role) => role.id);
      if (stillOn.length > 0) return '统一关后仍在勾选的角色：' + stillOn.join(' ');
      return true;
    });

    save();
    await page.settle();
    await page.settle();
    check('保存时 batch:false 真的进了 payload（与模型/预设同在一行、互不挤掉）', () => {
      const setCall = page.sent().filter((entry) => entry.op === 'set').pop();
      if (setCall === undefined) return '没有发出 set 请求';
      const roles = setCall.args.roles;
      const scout = roles.scout;
      if (scout === undefined || scout.batch !== false) return 'scout 的 batch:false 丢了：' + JSON.stringify(scout);
      if (scout.provider !== undefined) return 'scout 不该带模型：' + JSON.stringify(scout);
      const researcher = roles.researcher;
      if (researcher === undefined || researcher.batch !== false) return 'researcher 的 batch:false 丢了：' + JSON.stringify(researcher);
      if (researcher.provider !== 'p1' || researcher.model !== 'm1') return 'researcher 的模型丢了：' + JSON.stringify(researcher);
      const builder = roles.builder;
      if (builder === undefined || builder.preset !== 'ptc' || builder.batch !== false) return 'builder 两维没同时活下来：' + JSON.stringify(builder);
      return true;
    });

    // 上一轮保存后组件按宿主回包重建草稿（fixture 回的是 roles:{}），这里正好从「全默认」起算。
    check('拨开关再拨回去 = 不算未保存改动（默认值不留残骸行）', () => {
      const found = batchBox(page.tree(), 'researcher');
      if (found === undefined) return '找不到 researcher 的开关';
      found.box.props.onChange({ target: { checked: false } });
      const dirty = textOf(page.repaint());
      if (dirty.includes('有未保存改动') === false) return '关掉批量没有产生未保存提示（这一维没进指纹？）';
      const back = batchBox(page.tree(), 'researcher');
      back.box.props.onChange({ target: { checked: true } });
      const clean = textOf(page.repaint());
      if (clean.includes('有未保存改动') === true) return '拨回默认（开）之后仍提示未保存：说明默认值被写成了显式行，配置会越长越脏';
      return true;
    });
  }
  // ── 12) 统一选择那一排的**等高骨架**（2026-10-15 用户第二次报版面：四格不在一条线上）──
  //
  // 现象：「agent 预设」整格比旁边高出一截。根因是 .dat-bulk-ctl 底对齐 + **只有那一格**
  // 多了第三个孩子（提示语）：格子变高，底对齐就把它的 select 往上推。
  // 所以判据不是「有没有提示语」，而是**每格的孩子数与形状必须一致**：标题 / 控件 / 提示槽。
  // 提示槽恒定存在（没话也说空串），四格才永远等高，提示出现/消失时版面也不跳。
  {
    const page = await mount({
      get: {
        ok: true,
        config: { version: 1, roles: { scout: { preset: 'ptc', batch: false }, builder: { preset: 'standard' } } },
        roles: ROLES,
        revision: 'aaa:1',
        diagnostics: [],
        agentPresets: { presets: [{ id: 'ptc', name: '', available: true, reason: '', detail: '' }, { id: 'standard', name: '', available: true, reason: '', detail: '' }], notes: [] },
      },
      'list-models': { ok: true, groups: [{ id: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1' }] }], failures: [] },
      set: { ok: true, config: { version: 1, roles: {} }, revision: 'bbb:2', diagnostics: [] },
    });
    const ctl = findAll(page.tree(), (node) => node.type === 'div' && node.props.className === 'dat-bulk-ctl')[0];

    check('统一选择：四格都是「标题 + 控件 + 提示槽」三件套（等高骨架，谁也不会被顶上去）', () => {
      if (ctl === undefined) return '找不到 dat-bulk-ctl';
      const cells = (ctl.props.children || []).filter((node) => node.type === 'label' && node.props.className === 'dat-field');
      if (cells.length !== 4) return '统一块里应有 4 格，实得 ' + cells.length;
      const bad = [];
      for (const cell of cells) {
        const kids = (cell.props.children || []);
        const head = kids[0];
        const slot = kids[kids.length - 1];
        const title = head === undefined || head.props === undefined ? '' : textOf(head);
        if (kids.length !== 3) { bad.push(title + '（' + kids.length + ' 个孩子）'); continue; }
        if (head.props.className !== 'dat-label') bad.push(title + '（第一个孩子不是 dat-label）');
        else if (slot === undefined || slot.props === undefined || slot.props.className !== 'dat-hintslot') bad.push(title + '（末尾没有恒定的 dat-hintslot）');
      }
      if (bad.length > 0) return '这些格不符合三件套：' + bad.join(' | ');
      return true;
    });

    check('提示槽恒定占位：没话的格是空串（不是 null），有话的格把原因写在自己槽里', () => {
      const cells = (ctl.props.children || []).filter((node) => node.type === 'label' && node.props.className === 'dat-field');
      const slotTextOf = (wantLabel) => {
        for (const cell of cells) {
          const kids = cell.props.children || [];
          if (kids.length === 0 || kids[0].props === undefined || textOf(kids[0]) !== wantLabel) continue;
          const slot = kids[kids.length - 1];
          if (slot === undefined || slot.props === undefined || slot.props.className !== 'dat-hintslot') return '(那格没有提示槽)';
          return textOf(slot);
        }
        return '(找不到那一格)';
      };
      // 这份配置：预设三行不一致（ptc / standard / 空）、批量也不一致（scout 关着），模型与强度一致或没得说。
      const problems = [];
      if (slotTextOf('模型（应用到全部角色）') !== '') problems.push('模型格本该是空槽');
      if (slotTextOf('思考强度（应用到全部角色）') !== '') problems.push('强度格本该是空槽（长原因由下面的 dat-note 承担）');
      if (!slotTextOf('agent 预设（应用到全部角色）').includes('不一致')) problems.push('预设格的不一致原因没写进自己槽里：' + slotTextOf('agent 预设（应用到全部角色）'));
      if (!slotTextOf('批量调用（应用到全部角色）').includes('不一致')) problems.push('批量格的不一致原因没写进自己槽里：' + slotTextOf('批量调用（应用到全部角色）'));
      return problems.length === 0 ? true : problems.join(' | ');
    });
  }

  {
    // 上面那份配置里**每一格都有话要说**（预设/批量都不一致），所以「有提示时是三个孩子」
    // 那种断言抓不到真正的病：**没话要说时**把提示槽写成 null，格子就矮一截，底对齐的
    // 老 CSS 会把旁边整排顶歪。第一版闸门就是这个空转的（变异「presetHint 为空时不渲染槽」
    // 完全没红），这里补一份「全一致」的配置专门盯空槽。
    const page = await mount({
      get: {
        ok: true,
        config: { version: 1, roles: { researcher: { preset: 'ptc' }, scout: { preset: 'ptc' }, builder: { preset: 'ptc' } } },
        roles: ROLES,
        revision: 'aaa:1',
        diagnostics: [],
        agentPresets: { presets: [{ id: 'ptc', name: '', available: true, reason: '', detail: '' }], notes: [] },
      },
      'list-models': { ok: true, groups: [{ id: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1' }] }], failures: [] },
      set: { ok: true, config: { version: 1, roles: {} }, revision: 'bbb:2', diagnostics: [] },
    });

    check('四格全一致时（没话要说）提示槽仍然必须存在且为空串 —— 不许写成 null', () => {
      const ctl = findAll(page.tree(), (node) => node.type === 'div' && node.props.className === 'dat-bulk-ctl')[0];
      if (ctl === undefined) return '找不到 dat-bulk-ctl';
      const cells = (ctl.props.children || []).filter((node) => node.type === 'label' && node.props.className === 'dat-field');
      if (cells.length !== 4) return '应有 4 格，实得 ' + cells.length;
      const bad = [];
      for (const cell of cells) {
        const kids = cell.props.children || [];
        const title = kids.length === 0 || kids[0].props === undefined ? '(无标题)' : textOf(kids[0]);
        const slot = kids.length === 0 ? undefined : kids[kids.length - 1];
        if (kids.length !== 3) { bad.push(title + '（' + kids.length + ' 个孩子：没话时槽被省掉了）'); continue; }
        if (slot === undefined || slot.props === undefined || slot.props.className !== 'dat-hintslot') { bad.push(title + '（末尾不是 dat-hintslot）'); continue; }
        if (textOf(slot) !== '') bad.push(title + '（本该空槽，实得 ' + textOf(slot) + '）');
      }
      return bad.length === 0 ? true : '这些格在「没话要说」时破坏了等高骨架：' + bad.join(' | ');
    });
  }

  // ── 7) 加载失败路径 ───────────────────────────────────────────────────────
  {
    const page = await mount({
      get: { ok: false, error: 'missing plugin gate header' },
      'list-models': { ok: false, error: 'x' },
    });
    const tree = page.tree();
    const text = textOf(tree);
    check('加载失败：显示「加载失败」且把宿主英文回执本地化', () => {
      if (!text.includes('加载失败')) return `没有加载失败提示：${text.slice(0, 200)}`;
      if (text.includes('missing plugin gate header')) return '把宿主英文原文直接显示给用户了';
      return true;
    });
    check('加载失败：不渲染角色列表（避免显示成「全部跟随 Lead」的假象）', () => {
      const codes = findAll(tree, (node) => node.type === 'code');
      if (codes.some((row) => textOf(row).includes('researcher'))) return '加载失败时仍渲染了角色行';
      return true;
    });
    check('加载失败：重载可用（否则用户无法恢复）', () => {
      const reload = findAll(tree, (node) => node.type === 'button' && textOf(node).includes('重新载入'))[0];
      return reload !== undefined && reload.props.disabled !== true ? true : '加载失败后「重新载入」不可用';
    });
  }

  // ── 收尾 ──────────────────────────────────────────────────────────────────
  console.log('');
  console.log(`${passed}/${passed + failures.length} 通过。`);
  if (failures.length > 0) {
    console.log('');
    console.log('失败项：');
    for (const failure of failures) console.log(`  - ${failure.name}: ${failure.detail}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error('[client-smoke-test] 测试本身崩了：', error);
  process.exit(2);
});
