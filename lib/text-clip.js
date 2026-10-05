// 调度模式智能体团队 —— 文本截断（纯函数，零依赖）
//
// 全插件所有「把模型给的文本截成摘要」的地方都走这里：报错回显、wake_teammate 的补充指令、
// 广播预览。它的存在只有一个理由，而且是被实测证伪过的那种：
//
// 为什么不能直接 .slice(0, n)：JS 字符串按 UTF-16 码元计长，BMP 之外的字符（emoji、部分
// CJK 扩展字）由一对代理码元组成。截断点恰好落在一对中间时会留下一个孤立的高代理
// （0xD800-0xDBFF）：显示成乱码，写进会话日志后经 UTF-8 编码变成 U+FFFD，**不可逆**。
// 2026-10-05 的独立探针实测：599 个 ASCII + emoji 的 note 走 wake_teammate，
// 600 码元的裸 slice 会切出孤立高代理，而这里的 clipText 不会。
//
// 长度口径仍是 UTF-16 码元（与各处上限常量的单位一致），只是必要时少截一个码元。

/** 是否高代理码元（代理对的前半）。 */
function isHighSurrogate(codeUnit) {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

/**
 * 取前 max 个码元，但不劈开代理对：若第 max 个码元（截断后的最后一个）是高代理，就少截一个。
 * 未超长时原样返回。
 * @param text - 原文。
 * @param max - 上限（码元数）。
 * @returns 安全截断后的文本。
 */
export function sliceCodeUnitsSafely(text, max) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  if (source.length <= max) return source;
  if (max <= 0) return '';
  const end = isHighSurrogate(source.charCodeAt(max - 1)) ? max - 1 : max;
  return source.slice(0, end);
}

/** 超过 max 码元时安全截断并补省略号；未超长时原样返回（不加标记）。 */
export function clipText(text, max) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  return source.length <= max ? source : `${sliceCodeUnitsSafely(source, max)}…`;
}

/**
 * 把任意值渲染成**有界**的一行文本，用于报错回显。
 *
 * 为什么需要它（2026-10-05 审查 §1-①，实测证据）：`toolErrorResult` 只把
 * `Error: <message>` 放进工具结果（dsh-tools/lib/index.js:3616-3630），也就是说
 * **报错正文会整段进模型上下文**。而宿主参数层只管类型不管长度（`type:'string'` 没有
 * maxLength），于是模型把一个 20 万码元的名字传进来时，实测报错正文 = 200,062 码元，
 * 一次失败的代价是把成功路径攒下的上下文预算全挤掉——比不报还糟。
 *
 * 刻意**不走** String(value) 的隐式转换：`String(Object.create(null))` 会抛
 * `TypeError: Cannot convert object to primitive value`，那会让「报错」本身再抛一次。
 * @param value - 任意被回显的值。
 * @param max - 回显上限（码元数）。
 * @returns 有界的一行文本（超长时带省略号与原始长度）。
 */
export function describeValue(value, max = 120) {
  let raw;
  if (typeof value === 'string') raw = value;
  else if (value === null) raw = 'null';
  else if (value === undefined) raw = 'undefined';
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') raw = String(value);
  else if (typeof value === 'symbol') raw = value.toString();
  else if (Array.isArray(value)) raw = `Array(${value.length})`;
  else {
    // 容器与函数一律只报**形状**，不尝试序列化：序列化一个巨大/带环/带访问器的对象
    // 本身就可能抛错或产生更长的回显。
    try {
      const name = Object.prototype.toString.call(value);
      raw = typeof value === 'function' ? 'function' : name === '[object Object]' ? 'object' : name;
    } catch {
      raw = 'object';
    }
  }
  const flat = raw.replace(/\s+/gu, ' ');
  if (flat.length <= max) return flat;
  return `${sliceCodeUnitsSafely(flat, max)}…（原长 ${flat.length} 码元）`;
}
