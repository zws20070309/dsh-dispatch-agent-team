#!/usr/bin/env node
/**
 * lib-dsh-home.cjs —— tools/ 脚本定位 DSH 主目录与 profile 目录的**唯一**实现。
 *
 * 为什么要抽这一份（2026-10-04 审查 P1-7）：install.cjs 认 DSH_HOME，
 * 而 repair.cjs / drift-check.cjs / emergency-disable.cjs 各自硬编码
 * `os.homedir()/.dsh/profiles/desktop`。设置了 DSH_HOME 的机器上，后三者会
 * 把体检报告指到错的目录，`repair.cjs --apply` 更会把 profile 层的托管块
 * （关官方 tool-agent-team 行 + 容量覆盖）**写进一个根本不在用的 profile**——
 * 该修的没修、还顺手污染了另一个，全程无报错。
 *
 * 优先级（与官方 DSH_HOME 语义一致）：
 *   1. `--profile <目录>`（仅 profile 层，调用方各自决定是否支持这个开关）；
 *   2. 环境变量 `DSH_HOME`；
 *   3. `os.homedir()/.dsh`。
 *
 * 只依赖 node 内置模块，可被 selftest 直接 require 做纯函数断言。
 */

'use strict';

const os = require('node:os');
const path = require('node:path');

/** 官方桌面端 profile 的名字（本插件只针对桌面端）。 */
const DEFAULT_PROFILE = 'desktop';

/**
 * 解析 DSH 主目录。
 * @param env - 环境对象（默认 process.env），测试可注入。
 * @param homedir - 主目录（默认 os.homedir()），测试可注入。
 * @returns {{home:string, source:'env'|'homedir'}} source 说明是哪一路，打印时一并给出。
 */
function resolveDshHome(env = process.env, homedir = os.homedir()) {
  const raw = env.DSH_HOME;
  if (typeof raw === 'string' && raw.trim() !== '') {
    return { home: path.resolve(raw.trim()), source: 'env' };
  }
  return { home: path.join(homedir, '.dsh'), source: 'homedir' };
}

/**
 * 解析 profile 目录：显式 --profile 优先，否则 `<DSH 主目录>/profiles/desktop`。
 * @param options - {explicit, env, homedir}；explicit 是调用方从 argv 取到的 --profile 值。
 * @returns {{home:string, profileDir:string, source:'cli'|'env'|'homedir'}}
 */
function resolveProfileDir(options = {}) {
  const resolved = resolveDshHome(options.env, options.homedir);
  const explicit = typeof options.explicit === 'string' ? options.explicit.trim() : '';
  if (explicit !== '') {
    return { home: resolved.home, profileDir: path.resolve(explicit), source: 'cli' };
  }
  return { home: resolved.home, profileDir: path.join(resolved.home, 'profiles', DEFAULT_PROFILE), source: resolved.source };
}

/** 一行说明解析来源，给脚本开头打印，排查时一眼看见用的是哪条路径。 */
function describeSource({ home, profileDir, source }) {
  const from = source === 'cli' ? '--profile 指定' : source === 'env' ? `DSH_HOME=${home}` : `默认主目录 ${home}`;
  return `${profileDir}（${from}）`;
}

module.exports = { DEFAULT_PROFILE, resolveDshHome, resolveProfileDir, describeSource };
