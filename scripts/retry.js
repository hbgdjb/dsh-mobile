/* ============================================================
   请求重试 —— 什么时候值得再试一次

   ============ 为什么值得单独一层 ============
   
   重试最容易写错的地方不是"没试"，而是"试错了"：

     · 401 重试一百次，Key 还是错的，只是用户多等了十几秒
     · 已经吐了一半字的回答重发一遍，屏幕上就是同一段话说两次
     · 429 之后立刻重试，等于往枪口上撞，只会更糟

   所以判断"值不值得"比"怎么退避"更重要。这些判断跟网络无关、
   跟界面无关，抽出来才能逐条测。
   ============================================================ */

/** 默认最多试几次（含首次）。 */
export const DEFAULT_ATTEMPTS = 3;

/** 服务端要求的等待超过这个秒数，就不自动等了。 */
export const RETRY_AFTER_CAP_SEC = 15;

/**
 * 这个错误值不值得再试一次。
 *
 * 状态码的语义：
 *   408 请求超时 / 425 太早 / 429 限流 —— 等一下再来有意义
 *   5xx —— 服务端自己的问题，通常是瞬时的
 *   其余 4xx —— 重试不会改变结果
 *   0（没拿到状态码）—— 连接被重置、DNS 失败、看门狗掐断，值得再试
 *
 * @param {Error & {httpStatus?:number}} err
 * @returns {boolean}
 */
export function retryable(err) {
  if (!err || err.name === "AbortError") return false;
  // 已经输出过内容：重试会让同一段话说两遍
  if (err.produced) return false;

  const code = Number(err.httpStatus) || 0;
  // 已连上、流读到一半断了：这是网络抖动，不是服务端拒绝。
  // 它没有状态码（0），文案也不一定带 Socket / 超时字样，所以单独认。
  // 放在 produced 检查之后 —— 已经吐过字仍然不能重试，否则同一段说两遍。
  if (err.streamBroken) return true;
  if (code === 408 || code === 425 || code === 429) return true;
  if (code >= 500 && code <= 599) return true;
  if (code >= 400 && code < 500) return false;

  if (code === 0) {
    const msg = String(err.message || "");
    return /超时|timeout|空闲|Socket|ECONN|ECONNRESET|连接|network|Failed to connect|重置/i.test(msg);
  }
  return false;
}

/**
 * 下一次重试等多久。
 *
 * @param {number} attempt 第几次尝试（从 1 开始）
 * @param {object} err     上一轮的错误
 * @returns {number|null} 毫秒；null 表示不该自动等
 */
export function backoffMs(attempt, err) {
  const ra = Number(err && err.retryAfter) || 0;
  if (ra > 0) {
    // 429 让等 60 秒，用户坐在那儿看转圈 —— 那叫卡住，不叫自动恢复
    if (ra > RETRY_AFTER_CAP_SEC) return null;
    return ra * 1000;
  }
  // 800 → 1600 → 3200，加抖动：多个请求同时被限流时，
  // 不至于在同一毫秒一起回来再撞一次
  const base = Math.min(4000, 800 * Math.pow(2, attempt - 1));
  return base + Math.floor(Math.random() * 300);
}

/** 可被 abort 打断的等待。 */
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 跑一个可能失败的异步操作，失败时按策略重试。
 *
 * @param {Function} attemptFn 每次尝试调用的函数
 * @param {object} [opts]
 *   opts.attempts    最多几次（含首次）
 *   opts.signal      AbortSignal
 *   opts.onRetry     ({attempt, total, waitMs, error}) => void
 *   opts.isRetryable (err) => boolean
 * @returns {Promise<any>} attemptFn 的返回值
 */
export async function withRetry(attemptFn, opts = {}) {
  const attempts = Math.max(1, Number(opts.attempts) || DEFAULT_ATTEMPTS);
  const isRetryable = typeof opts.isRetryable === "function" ? opts.isRetryable : retryable;
  let lastErr = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await attemptFn(attempt);
    } catch (err) {
      lastErr = err;
      if (err?.name === "AbortError") throw err;
      if (attempt >= attempts) throw err;
      if (!isRetryable(err)) throw err;

      const wait = backoffMs(attempt, err);
      if (wait === null) {
        // 明确告诉用户"服务端要求等更久"，而不是偷偷换个说法
        err.message = `${err.message}（服务端要求 ${Math.round(err.retryAfter)} 秒后再试，等待时间过长，已停止自动重试）`;
        err.needsManualRetry = true;
        throw err;
      }

      try {
        opts.onRetry?.({ attempt, total: attempts - 1, waitMs: wait, error: err.message });
      } catch {
        /* 界面回调出错不该影响重试 */
      }
      await delay(wait, opts.signal);
    }
  }

  throw lastErr || new Error("请求失败");
}
