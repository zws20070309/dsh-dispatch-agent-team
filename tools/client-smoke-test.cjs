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
    let localeDict;
    let injections = 0;
    const ctx = {
      effect(fn) { fn(); return () => {}; },
      slots: Object.freeze({
        inject(name, factory) { injections += 1; return factory(); },
        register(slot, candidate) { component = candidate; return () => {}; },
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
    check('注册形状：id / name / inject / 槽位与字典各注册一次', () => {
      if (registration.id !== '@zws/dsh-dispatch-agent-team') return `id=${registration.id}`;
      if (page.exportsObject.name !== 'dsh-dispatch-agent-team-client') return `name=${page.exportsObject.name}`;
      const inject = page.exportsObject.inject;
      if (!Array.isArray(inject) || !inject.includes('slots') || !inject.includes('locale')) {
        return `inject=${JSON.stringify(inject)}（需要 slots 与 locale）`;
      }
      if (page.injections() !== 1) return `slots.inject 调用了 ${page.injections()} 次`;
      if (page.dict() === undefined || typeof page.dict().zh !== 'object') return '字典没注册';
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
