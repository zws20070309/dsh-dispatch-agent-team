#!/usr/bin/env node
/**
 * lib-atomic-write.cjs —— tools/ 脚本写 profile 关键文件的**唯一**原子写实现。
 *
 * 为什么需要（2026-10-04 审查 P2-17）：repair.cjs 与 emergency-disable.cjs 都直接用
 * fs.writeFileSync 覆写 profile 的 package.json / cordis.patch.yml。两处都「备份在先」，
 * 所以坏了能恢复；但 writeFileSync 是**就地截断再写**，进程写到一半崩溃/断电就会留下
 * 一个截断的 JSON/YAML —— 而这两个文件坏了 DSH 就起不来。同目录 tmp + rename
 * 在同一卷上是原子的：读者要么看到旧内容、要么看到完整新内容，不会看到半份文件。
 * 本仓库内 lib/resume.js 的 writeStore 早就是这么写的，这里只是让 tools/ 跟上同一标准。
 */

'use strict';

const fs = require('node:fs');

/**
 * 原子写文本：写 `<file>.<pid>.<ts>.tmp` 再 rename 覆盖目标；失败清掉临时文件。
 * @param file - 目标路径。
 * @param text - 完整新内容。
 */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件可能根本没建起来；清理失败不许改写原始异常 */
    }
    throw error;
  }
}

module.exports = { writeAtomic };
