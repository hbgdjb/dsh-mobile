'use strict';

/**
 * cordis 的 FiberState —— 生命周期状态枚举。
 *
 * ============ 为什么必须是数字 ============
 *
 * cordis 的 `FiberState` 是 **const enum**（src/fiber.ts 第 147 行）：
 *
 *     export const enum FiberState {
 *       PENDING,   // 0
 *       LOADING,   // 1
 *       ACTIVE,    // 2
 *       FAILED,    // 3
 *       DISPOSED,  // 4
 *       UNLOADING, // 5
 *     }
 *
 * const enum 在编译期就被内联掉，运行时**没有对象可 import** ——
 * 所以桌面版专门做了一个镜像模块
 * （`@deepseek-ai/dsh-tool-cordis/fiber-state.d.ts`），值与上面逐一对应。
 *
 * 我们这里也照做：数字枚举 + 一个可读的名字映射。
 *
 * ============ 为什么之前用字符串是错的 ============
 *
 * cordis 的 `reflect.get(name, strict=true)` 用**数字比较**过滤
 * 「正在卸载的服务」：
 *
 *     if (strict && impl.fiber.state !== FiberState.ACTIVE) return
 *
 * 字符串 `'ACTIVE'` 与数字 `2` 不相等 —— 用字符串会让这个过滤**永远失效**，
 * 于是「正在被卸载的服务」在卸载完成前仍能被读到。
 */

/** FiberState 的数字值 —— 与 cordis src/fiber.ts 的 const enum 逐一对应。 */
const FiberState = Object.freeze({
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
});

/** 每个状态的可读名字（供日志与调试用）。 */
const STATE_NAMES = Object.freeze({
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: 'disposed',
  5: 'unloading',
});

/**
 * 取状态的可读名字。
 *
 * @param {number} state 状态值
 * @returns {string} 小写名字；未知值返回 'unknown'
 */
function stateName(state) {
  return STATE_NAMES[state] || 'unknown';
}

module.exports = { FiberState, STATE_NAMES, stateName };
