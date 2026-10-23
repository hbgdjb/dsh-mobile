#!/usr/bin/env node
/* ============================================================
   模型条目的 label 迁移

   ============ 这个测试守的是什么 ============

   手机端所有「显示模型名」的地方都读 `label`：

     ui.js  renderContextBar  —— 顶部那颗模型 chip，直接 `model.label.replace(...)`
     screens.js 模型卡标题    —— `${esc(model.label)}`
     screens.js 抽屉底部      —— `已连接 · ${label}`

   插件模型（source: "node-llm"）在 0.41.5 之前同步进模型表时**没有写 label**。
   一旦用户选中它，`model.label.replace` 就抛 TypeError，
   renderContextBar 抛 → renderChat 抛 → 整个对话页白掉。

   0.41.5 补了写入时带 label，但**已经存在手机里的旧条目**不会自己长出来 ——
   所以加载时还要做一次迁移。这个测试就守这条迁移。

   用法：node tests/model-label-test.mjs
   ============================================================ */

import assert from "node:assert";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

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

/** 装一个只有内存的 localStorage，并塞入预置的 state。 */
function installStorage(state) {
  const store = new Map();
  if (state) store.set("dsh.mobile.state.v1", JSON.stringify(state));
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  };
  return store;
}

globalThis.window = globalThis.window || {};
globalThis.document = globalThis.document || { addEventListener() {}, querySelector: () => null };

let modSeq = 0;
async function loadStore() {
  modSeq += 1;
  return await import(pathToFileURL(path.join(ROOT, "scripts", "store.js")).href + `?v=${modSeq}`);
}

console.log("\n[1] 旧条目（没有 label）加载后要自愈");

await test("插件模型缺 label 时，加载 store 会补上", async () => {
  installStorage({
    version: 1,
    settings: {
      model: "node__echo__echo-1",
      customModels: [
        {
          id: "node__echo__echo-1",
          name: "回声模型",
          apiModel: "echo-1",
          provider: "node__echo",
          nodeProvider: "echo",
          source: "node-llm",
          ctx: 32000,
        },
      ],
    },
  });
  const store = await loadStore();
  const m = store.state.settings.customModels[0];
  assert.strictEqual(m.label, "回声模型", "应该用 name 补出 label，实际：" + m.label);
});

await test("当前选中的模型 label 一定是字符串（顶栏要 .replace 它）", async () => {
  installStorage({
    settings: {
      model: "node__x__y",
      customModels: [{ id: "node__x__y", name: "", apiModel: "y", provider: "node__x", source: "node-llm" }],
    },
  });
  const store = await loadStore();
  const cur = store.currentModel();
  assert.ok(cur, "当前模型要能解析出来");
  assert.strictEqual(typeof cur.label, "string");
  assert.ok(cur.label.length > 0, "不能是空串");
  assert.doesNotThrow(() => cur.label.replace("DeepSeek-", ""), "顶栏的 .replace 不能抛");
});

await test("完全没有 name 时退回 apiModel / id，不会留 undefined", async () => {
  installStorage({
    settings: {
      model: "m1",
      customModels: [{ id: "m1", apiModel: "api-1", provider: "p" }],
    },
  });
  const store = await loadStore();
  assert.strictEqual(store.state.settings.customModels[0].label, "api-1");
});

await test("已有正常 label 的不被覆盖", async () => {
  installStorage({
    settings: {
      model: "a",
      customModels: [{ id: "a", label: "我自己起的名字", name: "别的名字" }],
    },
  });
  const store = await loadStore();
  assert.strictEqual(store.state.settings.customModels[0].label, "我自己起的名字");
});

/* ============================================================
   2. 写入时就该带 label（llm-bridge 那一侧）
   ============================================================ */

console.log("\n[2] 同步写入时就带 label");

await test("syncLlmModels 产出的条目自带 label", async () => {
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(path.join(ROOT, "scripts", "llm-bridge.js"), "utf8")
  );
  assert.ok(/label:\s*m\.name \|\| m\.id/.test(src), "llm-bridge 造条目时必须写 label");
});

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log(`${"=".repeat(50)}`);

process.exit(failed ? 1 : 0);
