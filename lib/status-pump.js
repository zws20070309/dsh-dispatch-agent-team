// 状态文件落盘的串行 pass 泵（2026-11-07 T10 融入 deepseek superagent 原型的调度底盘思想，
// 原型：dsh-superagent-prototype/src/app/passes.ts 的 Passes.pump —— one at a time，
// 运行期把并发请求合并成**一次** follow-up pass）。
//
// 为什么需要它（现场依据）：lib/index.js 的 setStatusRefresh 钩子此前是 fire-and-forget 的
// async writeStatusFile，而 refreshStatusFile() 的调用点遍布运行期高频事件
// （recordNote 40+ 处；recordReport / markReportDelivered 各一处 —— 2b92c4c 刚把
// 「报告落账立即刷盘」接上）。一次 report_result 的三连事件 = 3 份并发全量快照 +
// 3 次并发 fs.writeFile 写**同一个**文件：轻则白算（每次都要 await compositionInventory
// 等宿主服务），重则两次 writeFile 交错把文件写成半份 JSON。
//
// 泵的语义（与原型逐字对应）：
//   * 串行：同一时刻最多一个 write 在跑；
//   * 合并：write 在跑期间再来 N 次 request，只排**一次** follow-up（pumpAgain ??=），
//     follow-up 跑到的自然是合并窗口里全部事件之后的最新状态；
//   * 事件驱动、无定时器：状态文件没有「到期必须刷新」的硬需求，原型泵的 2 秒周期
//     在这里没有对应物（最小可用，不抄没有收益的半边）；
//   * 失败上报：write 抛错交给 onError（宿主 warn），泵自身永不抛错、也绝不静默吞错。

/**
 * 造一个串行写盘泵。
 * @param {() => Promise<void>} write - 单次落盘动作（无参；调用方闭包住 ctx 与 phase）。
 * @param {(error: unknown) => void} onError - write 失败的上报口（必传：失败不许无声）。
 * @returns {{request: () => Promise<void>, idle: () => Promise<void>, busy: () => boolean}}
 *   request 发起（或合并进）一次落盘；idle 等到当前与 follow-up 全部结束（测试用，
 *   原型 Passes.idle 同名语义）；busy 当前是否有落盘在跑。
 */
export function createStatusPump(write, onError) {
  if (typeof write !== 'function') throw new TypeError('createStatusPump: write 必须是函数');
  if (typeof onError !== 'function') throw new TypeError('createStatusPump: onError 必须是函数（失败不许无声）');
  /** 当前在跑的那一次（undefined = 空闲）。 */
  let pumping;
  /** 排队在当前那次之后的 follow-up（undefined = 没有排）。 */
  let pumpAgain;
  const api = {
    request() {
      if (pumping === undefined) {
        // Promise.resolve().then：同步抛错的 write 也进 rejected promise，交给统一的失败上报。
        pumping = Promise.resolve()
          .then(write)
          .catch(onError)
          .finally(() => { pumping = undefined; });
        return pumping;
      }
      // 合并：已在跑时只排一次 follow-up（N 个并发请求共享同一个排队位）。
      // 排队位在 follow-up 开跑时先清掉（原型 next 的 `{ this.pumpAgain = undefined; … }`）：
      // 不清的话这个变量永远非 undefined，idle() 会把一个已结算的 promise 当成「还有活」死等。
      if (pumpAgain === undefined) {
        const next = () => { pumpAgain = undefined; return api.request(); };
        pumpAgain = pumping.then(next, next);
      }
      return pumpAgain;
    },
    async idle() {
      // follow-up 排上后会顶替 pumping，所以循环到两者皆空为止（allSettled：失败也算结束）。
      while (pumping !== undefined || pumpAgain !== undefined) {
        const waiting = [pumping, pumpAgain].filter((item) => item !== undefined);
        await Promise.allSettled(waiting);
      }
    },
    busy() {
      return pumping !== undefined;
    },
  };
  return api;
}
