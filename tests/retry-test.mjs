#!/usr/bin/env node
/* ============================================================
   请求重试的测试

   ============ 这套测试在防什么 ============

   重试写错有两个方向，都比"不重试"更糟：

     一、该停的时候不停 —— 401（Key 错）重试三次，用户多等
         十几秒，最后还是同一个错；或者一段已经吐了一半的回答
         被重发，屏幕上同一段话说两遍。

     二、该等的时候不等 —— 429 之后立刻重发，等于往枪口上撞，
         越试越被限流。

   所以这里测的重点不是"重试了没有"，而是"什么时候不重试"。

   用法：node tests/retry-test.mjs
   ============================================================ */

import assert from "node:assert";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const mod = await import(pathToFileURL(path.join(ROOT, "scripts", "retry.js")).href);
const { retryable, backoffMs, withRetry, delay, DEFAULT_ATTEMPTS, RETRY_AFTER_CAP_SEC } = mod;

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`      ${e && e.message ? e.message : e}`);
  }
}

/** 造一个带状态码的错误。 */
function httpError(status, extra = {}) {
  const e = new Error(`HTTP ${status}`);
  e.httpStatus = status;
  Object.assign(e, extra);
  return e;
}

console.log("\n哪些错误值得重试\n");

await test("429 / 408 / 425 值得重试", () => {
  assert.strictEqual(retryable(httpError(429)), true);
  assert.strictEqual(retryable(httpError(408)), true);
  assert.strictEqual(retryable(httpError(425)), true);
});

await test("5xx 值得重试", () => {
  for (const code of [500, 502, 503, 504]) {
    assert.strictEqual(retryable(httpError(code)), true, `${code} 应该可重试`);
  }
});

await test("401 / 400 / 403 / 404 不重试", () => {
  for (const code of [400, 401, 403, 404, 422]) {
    assert.strictEqual(retryable(httpError(code)), false, `${code} 不该重试`);
  }
});

await test("中止不算失败", () => {
  const e = new Error("Aborted");
  e.name = "AbortError";
  assert.strictEqual(retryable(e), false);
});

await test("已经输出过内容的不重试", () => {
  assert.strictEqual(retryable(httpError(502, { produced: true })), false);
});

await test("没有状态码时按错误文案判断", () => {
  assert.strictEqual(retryable(new Error("Failed to connect to api.deepseek.com")), true);
  assert.strictEqual(retryable(new Error("等待响应超时：45 秒内没有收到任何数据")), true);
  assert.strictEqual(retryable(new Error("连接空闲超过 120 秒，已中断")), true);
  assert.strictEqual(retryable(new Error("ECONNRESET")), true);
  // 解析失败这类不是网络问题，重试也没用
  assert.strictEqual(retryable(new Error("接口返回异常：unexpected token")), false);
});

console.log("\n等多久\n");

await test("指数退避：800 → 1600 → 3200 封顶", () => {
  const a = backoffMs(1, new Error("x"));
  const b = backoffMs(2, new Error("x"));
  const c = backoffMs(3, new Error("x"));
  assert.ok(a >= 800 && a < 1200, `第一次应约 800ms，实际 ${a}`);
  assert.ok(b >= 1600 && b < 2000, `第二次应约 1600ms，实际 ${b}`);
  assert.ok(c >= 3200 && c < 3600, `第三次应约 3200ms，实际 ${c}`);
});

await test("有 Retry-After 就听服务端的", () => {
  assert.strictEqual(backoffMs(1, httpError(429, { retryAfter: 3 })), 3000);
});

await test("Retry-After 太长就不自动等了", () => {
  const tooLong = RETRY_AFTER_CAP_SEC + 1;
  assert.strictEqual(backoffMs(1, httpError(429, { retryAfter: tooLong })), null);
});

console.log("\n整体行为\n");

await test("第一次失败、第二次成功 → 拿到结果，且通知了一次", async () => {
  let calls = 0;
  const notices = [];
  const out = await withRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw httpError(503);
      return "ok";
    },
    { attempts: 3, onRetry: (i) => notices.push(i) }
  );
  assert.strictEqual(out, "ok");
  assert.strictEqual(calls, 2);
  assert.strictEqual(notices.length, 1);
  assert.strictEqual(notices[0].attempt, 1);
  assert.strictEqual(notices[0].total, 2);
});

await test("一直失败 → 试满次数后抛最后一次的错误", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw httpError(500);
        },
        { attempts: 2 }
      ),
    /HTTP 500/
  );
  assert.strictEqual(calls, 2, `应该试 2 次，实际 ${calls}`);
});

await test("401 只试一次", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw httpError(401);
        },
        { attempts: 3 }
      ),
    /HTTP 401/
  );
  assert.strictEqual(calls, 1, "Key 错了重试也没用，不该多试");
});

await test("已经吐字之后断流 → 不重试", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw httpError(502, { produced: true });
        },
        { attempts: 3 }
      ),
    /HTTP 502/
  );
  assert.strictEqual(calls, 1, "重试会让同一段话说两遍");
});

await test("服务端要求等太久 → 不自动等，错误里说明", async () => {
  let calls = 0;
  let err = null;
  try {
    await withRetry(
      async () => {
        calls += 1;
        throw httpError(429, { retryAfter: 60 });
      },
      { attempts: 3 }
    );
  } catch (e) {
    err = e;
  }
  assert.ok(err, "应该抛错");
  assert.strictEqual(calls, 1);
  assert.match(err.message, /60 秒/);
  assert.strictEqual(err.needsManualRetry, true);
});

await test("中止之后不再重试", async () => {
  const ac = new AbortController();
  let calls = 0;
  const p = withRetry(
    async () => {
      calls += 1;
      if (calls === 1) {
        ac.abort();
        throw httpError(503);
      }
      return "ok";
    },
    { attempts: 3, signal: ac.signal }
  );
  await assert.rejects(p, (e) => e.name === "AbortError");
  assert.strictEqual(calls, 1);
});

await test("等待期间中止 → 立刻抛 AbortError", async () => {
  const ac = new AbortController();
  let calls = 0;
  const p = withRetry(
    async () => {
      calls += 1;
      throw httpError(503);
    },
    { attempts: 3, signal: ac.signal }
  );
  setTimeout(() => ac.abort(), 150);
  const t0 = Date.now();
  await assert.rejects(p, (e) => e.name === "AbortError");
  // 第一次退避是 800ms 起，150ms 就该被打断
  assert.ok(Date.now() - t0 < 700, `应该立刻停，实际等了 ${Date.now() - t0}ms`);
  assert.strictEqual(calls, 1);
});

await test("onRetry 自己抛错不影响重试", async () => {
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw httpError(503);
      return "fine";
    },
    {
      attempts: 2,
      onRetry: () => {
        throw new Error("界面炸了");
      },
    }
  );
  assert.strictEqual(out, "fine");
  assert.strictEqual(calls, 2);
});

await test("默认是 3 次", () => {
  assert.strictEqual(DEFAULT_ATTEMPTS, 3);
});

await test("delay 能正常等待", async () => {
  const t0 = Date.now();
  await delay(120, null);
  assert.ok(Date.now() - t0 >= 100);
});

console.log(`\n${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
