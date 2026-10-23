#!/usr/bin/env node
/* ============================================================
   Node 侧「插件模型调用」的回归测试（android/node/llm-chat.js）

   测两件事：
     1. OpenAI 形状的消息能不能正确翻译成 harness 形状；
     2. 一个 adapter 的 StreamChunk 流能不能被正确跑完。

   用法：node tests/llm-chat-test.mjs
   ============================================================ */

import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE_DIR = path.join(HERE, '..', 'android', 'node');
const { toHarnessMessages, runAdapterStream } = require(path.join(NODE_DIR, 'llm-chat.js'));

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

/* ============================================================
   1. 消息翻译
   ============================================================ */

console.log('\n[1] 消息翻译（OpenAI → harness）');

await test('system 变成 harness 的 system 消息', () => {
  const out = toHarnessMessages([{ role: 'system', content: '你是一个助手' }]);
  assert.deepStrictEqual(out, [{ role: 'system', content: '你是一个助手' }]);
});

await test('字符串内容的 user 消息变成文本块', () => {
  const out = toHarnessMessages([{ role: 'user', content: '你好' }]);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0].content, [{ type: 'text', text: '你好' }]);
});

await test('图片 part 变成 attachment.url（插件正是读这个字段）', () => {
  const url = 'data:image/png;base64,AAAA';
  const out = toHarnessMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url } },
      ],
    },
  ]);
  assert.deepStrictEqual(out[0].content, [
    { type: 'text', text: '看图' },
    { type: 'image', attachment: { url } },
  ]);
});

await test('assistant 的 tool_calls 变成 tool-call 块', () => {
  const out = toHarnessMessages([
    {
      role: 'assistant',
      content: '我来查一下',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'fs_read', arguments: '{"path":"a"}' } },
      ],
    },
  ]);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0].content, [
    { type: 'text', text: '我来查一下' },
    { type: 'tool-call', id: 'call_1', name: 'fs_read', arguments: '{"path":"a"}' },
  ]);
});

await test('无名的 tool_call 被丢掉（留着会毒化整段历史）', () => {
  const out = toHarnessMessages([
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: '', arguments: '{}' } }] },
  ]);
  assert.strictEqual(out.length, 0, '只剩空调用时整条消息都该消失');
});

await test('tool 消息的 tool_call_id 变成 toolCallId', () => {
  const out = toHarnessMessages([{ role: 'tool', tool_call_id: 'call_1', content: '结果' }]);
  assert.deepStrictEqual(out[0], {
    role: 'tool',
    toolCallId: 'call_1',
    content: [{ type: 'text', text: '结果' }],
  });
});

await test('没有 tool_call_id 的 tool 消息被丢弃（发上去只会换 400）', () => {
  const out = toHarnessMessages([{ role: 'tool', content: '孤儿结果' }]);
  assert.strictEqual(out.length, 0);
});

await test('空的 tool 结果给一个占位文本', () => {
  const out = toHarnessMessages([{ role: 'tool', tool_call_id: 'c1', content: '' }]);
  assert.strictEqual(out[0].content[0].text, '(no output)');
});

await test('图片 part 没有 url 时不生成空块', () => {
  const out = toHarnessMessages([
    { role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: {} }] },
  ]);
  assert.strictEqual(out[0].content.length, 1);
});

/* ============================================================
   2. adapter 调用
   ============================================================ */

console.log('\n[2] adapter 调用');

/** 一个最小的假 adapter：按给定脚本吐 chunk。 */
function fakeAdapter(chunks, opts = {}) {
  const seen = { options: null, prepared: null };
  return {
    seen,
    providerInfo: () => ({ name: '假供应方' }),
    listModels: async () => [],
    stream(options) {
      seen.options = options;
      return {
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield c;
        },
      };
    },
    ...(opts.withPrepare
      ? {
          async prepareCall(provider, model) {
            seen.prepared = { provider, model };
            return {
              model: { id: model, context: { contextWindow: 65536 }, defaultMaxTokens: 4096 },
              stream: (options) => {
                seen.options = options;
                return {
                  async *[Symbol.asyncIterator]() {
                    for (const c of chunks) yield c;
                  },
                };
              },
            };
          },
        }
      : {}),
  };
}

await test('chunk 原样交给 onChunk，finish 与 usage 被收集', async () => {
  const adapter = fakeAdapter([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '你好' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '你好' } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  const got = [];
  const r = await runAdapterStream({
    adapter,
    provider: 'p',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    onChunk: (c) => got.push(c.type),
  });
  assert.deepStrictEqual(got, ['block-start', 'text-delta', 'block-end', 'usage', 'finish']);
  assert.strictEqual(r.finish, 'stop');
  assert.strictEqual(r.usage.totalTokens, 12);
  assert.strictEqual(r.failure, null);
});

await test('消息已经翻译过才交给 adapter', async () => {
  const adapter = fakeAdapter([{ type: 'finish', reason: { kind: 'stop' } }]);
  await runAdapterStream({
    adapter,
    provider: 'p',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.deepStrictEqual(adapter.seen.options.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  assert.strictEqual(adapter.seen.options.model, 'm');
});

await test('有 prepareCall 时优先用它，并用它的默认输出上限', async () => {
  const adapter = fakeAdapter([{ type: 'finish', reason: { kind: 'stop' } }], { withPrepare: true });
  const r = await runAdapterStream({ adapter, provider: 'p', model: 'm', messages: [] });
  assert.deepStrictEqual(adapter.seen.prepared, { provider: 'p', model: 'm' });
  assert.strictEqual(adapter.seen.options.maxTokens, 4096, '没给上限时用 adapter 声明的默认值');
  assert.strictEqual(r.model.defaultMaxTokens, 4096);
});

await test('调用方给了 maxTokens 就不覆盖', async () => {
  const adapter = fakeAdapter([{ type: 'finish', reason: { kind: 'stop' } }], { withPrepare: true });
  await runAdapterStream({ adapter, provider: 'p', model: 'm', messages: [], maxTokens: 128 });
  assert.strictEqual(adapter.seen.options.maxTokens, 128);
});

await test('finish:error 被翻译成 failure，不当成正常结束', async () => {
  const adapter = fakeAdapter([
    { type: 'finish', reason: { kind: 'error', failure: { message: '额度用完了', code: 'EMPTY_RESPONSE' } } },
  ]);
  const r = await runAdapterStream({ adapter, provider: 'p', model: 'm', messages: [] });
  assert.strictEqual(r.finish, 'error');
  assert.strictEqual(r.failure.message, '额度用完了');
  assert.strictEqual(r.failure.code, 'EMPTY_RESPONSE');
});

await test('aborted 也是一个 finish kind，不算 failure', async () => {
  const adapter = fakeAdapter([{ type: 'finish', reason: { kind: 'aborted' } }]);
  const r = await runAdapterStream({ adapter, provider: 'p', model: 'm', messages: [] });
  assert.strictEqual(r.finish, 'aborted');
  assert.strictEqual(r.failure, null);
});

await test('adapter 抛错时异常向上抛（由调用方决定怎么报）', async () => {
  const adapter = {
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        throw new Error('网络断了');
      },
    }),
  };
  await assert.rejects(
    () => runAdapterStream({ adapter, provider: 'p', model: 'm', messages: [] }),
    /网络断了/
  );
});

await test('没有 stream 方法的 adapter 明确报错', async () => {
  await assert.rejects(() => runAdapterStream({ adapter: {}, provider: 'p', model: 'm', messages: [] }), /没有可用的 adapter/);
});

await test('temperature / reasoningEffort 只在给了的时候透传', async () => {
  const a1 = fakeAdapter([{ type: 'finish', reason: { kind: 'stop' } }]);
  await runAdapterStream({ adapter: a1, provider: 'p', model: 'm', messages: [] });
  assert.ok(!('temperature' in a1.seen.options), '没给就不要塞字段');
  assert.ok(!('reasoningEffort' in a1.seen.options));

  const a2 = fakeAdapter([{ type: 'finish', reason: { kind: 'stop' } }]);
  await runAdapterStream({
    adapter: a2,
    provider: 'p',
    model: 'm',
    messages: [],
    temperature: 0.3,
    reasoningEffort: 'high',
  });
  assert.strictEqual(a2.seen.options.temperature, 0.3);
  assert.strictEqual(a2.seen.options.reasoningEffort, 'high');
});

console.log('\n==================================================');
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('==================================================');
process.exit(failed ? 1 : 0);
