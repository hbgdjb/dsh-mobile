#!/usr/bin/env node
/* ============================================================
   回显测试插件能否端到端跑通

   这个测试的作用：在把「安装步骤」教给用户之前，
   先用真容器 + 真翻译层把它跑一遍。给用户的步骤必须是验过的。

   用法：node tests/echo-plugin-test.mjs
   ============================================================ */

import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require2 = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE_DIR = path.join(HERE, '..', 'android', 'node');

const { createContainer, applyPlugin } = require2(path.join(NODE_DIR, 'cordis-lite.js'));
const { createLlmService } = require2(path.join(NODE_DIR, 'llm-service.js'));
const { runAdapterStream } = require2(path.join(NODE_DIR, 'llm-chat.js'));

async function main() {
  const container = createContainer({});
  const llm = createLlmService({ ctx: container, log: () => {} });
  container.provide('llm', llm);

  const plugin = require2(path.join(HERE, 'fixtures', 'echo-llm', 'main.js'));
  const res = applyPlugin(container, { id: 'echo-llm', name: 'echo-llm', apply: plugin.apply, inject: plugin.inject });
  assert.strictEqual(res.ok, true, '插件要能装上：' + res.error);

  assert.strictEqual(llm.routeCount(), 1, '应该注册了 1 条路由');
  const routes = llm.listRoutes();
  assert.strictEqual(routes[0].provider, 'echo');

  const models = await llm.listModels('echo');
  assert.strictEqual(models.length, 1);
  assert.strictEqual(models[0].id, 'echo-1');
  assert.strictEqual(models[0].name, '回声模型');

  const chunks = [];
  const r = await runAdapterStream({
    adapter: llm.getAdapter('echo'),
    provider: 'echo',
    model: 'echo-1',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ],
    tools: [],
    onChunk: (c) => chunks.push(c),
  });

  assert.strictEqual(r.finish, 'stop');
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  assert.ok(text.includes('收到 2 条消息'), '应回显消息条数，实际：' + text);
  assert.ok(text.includes('你好'), '应回显最后一句，实际：' + text);
  assert.ok(text.includes('工具定义 0 个'));

  console.log('  ✓ 插件装载、路由注册、模型清单、流式回显全部通过');
  console.log('  回显内容：' + text);

  // 卸载后路由要消失
  res.disposer();
  assert.strictEqual(llm.routeCount(), 0, '卸载后路由要释放');
  console.log('  ✓ 卸载后路由释放');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('  ✗ ' + (e && e.message));
    process.exit(1);
  }
);
