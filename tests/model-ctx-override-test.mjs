#!/usr/bin/env node
/* ============================================================
   模型的上下文窗口不能被「迁移」悄悄砍回 128K

   ============ 这个测试守的是什么 ============

   0.8 时代只有一个全局 `contextWindow`。当年写了一段迁移：
   首次升级时把全局值归到当前模型，存进 `modelOverrides`。

   问题在于「首次」是用 `modelOverrides` 是否为空判断的，而新用户
   添加模型并不会写 overrides —— 于是：

     添加 agnes-3.0-flash（512K）→ 选中 → 重启
     → 迁移把全局默认 128000 写成该模型的 ctx 覆盖
     → 界面显示 128K，上下文被削掉 3/4

   这不是理论风险，是截图里亲眼看到的 128K。所以：
     1. 不再迁移 contextWindow；
     2. 把旧版本已经写坏的覆盖清掉（只清「=128000 且模型更大」）；
     3. baseUrl 迁移保持原样。
   ============================================================ */

import assert from "node:assert";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

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

let seq = 0;
async function loadStore() {
  seq += 1;
  return await import(pathToFileURL(path.join(ROOT, "scripts", "store.js")).href + `?v=${seq}`);
}

const AGNES = {
  id: "agnes-3.0-flash",
  label: "agnes-3.0-flash",
  apiModel: "agnes-3.0-flash",
  provider: "Agnes AI",
  providerKey: "agnes",
  baseUrl: "https://apihub.agnes-ai.com/v1",
  format: "openai",
  ctx: 524288,
};

const seed = (over = {}) => ({
  settings: {
    customModels: [AGNES],
    model: AGNES.id,
    contextWindow: 128000,
    modelOverrides: {},
    keys: {},
    ...over,
  },
  sessions: [],
  plugins: [],
  files: {},
});

console.log("[1] 新用户：添加大窗口模型后重启");

await test("不再把全局 128000 写成模型的 ctx 覆盖", async () => {
  installStorage(seed());
  const st = await loadStore();
  assert.deepStrictEqual(st.state.settings.modelOverrides, {}, JSON.stringify(st.state.settings.modelOverrides));
});

await test("生效窗口仍是 512K", async () => {
  installStorage(seed());
  const st = await loadStore();
  assert.strictEqual(st.allModels()[0].ctx, 524288);
});

await test("迁移标记落盘，二次加载不再重复处理", async () => {
  const raw = seed();
  const storage = installStorage(raw);
  await loadStore();
  const saved = JSON.parse(storage.get("dsh.mobile.state.v1"));
  assert.strictEqual(saved.settings.ctxOverrideFixed, true);
});

console.log("\n[2] 已经写坏的覆盖");

await test("=128000 且模型更大的 ctx 覆盖被清掉", async () => {
  installStorage(seed({ modelOverrides: { [AGNES.id]: { ctx: 128000 } } }));
  const st = await loadStore();
  assert.deepStrictEqual(st.state.settings.modelOverrides, {});
  assert.strictEqual(st.allModels()[0].ctx, 524288);
});

await test("其他覆盖字段保留，只删 ctx", async () => {
  installStorage(
    seed({ modelOverrides: { [AGNES.id]: { ctx: 128000, temperature: 0.7 } } })
  );
  const st = await loadStore();
  assert.strictEqual(st.state.settings.modelOverrides[AGNES.id].ctx, undefined);
  assert.strictEqual(st.state.settings.modelOverrides[AGNES.id].temperature, 0.7);
});

await test("用户真的想用 128K 的模型不被误伤", async () => {
  const small = { ...AGNES, id: "small", ctx: 128000 };
  installStorage(
    seed({
      customModels: [small],
      model: "small",
      modelOverrides: { small: { ctx: 128000 } },
    })
  );
  const st = await loadStore();
  assert.strictEqual(st.allModels()[0].ctx, 128000);
});

await test("标记已存在时，用户新改的覆盖不再被清", async () => {
  installStorage(
    seed({
      ctxOverrideFixed: true,
      modelOverrides: { [AGNES.id]: { ctx: 128000 } },
    })
  );
  const st = await loadStore();
  assert.strictEqual(st.allModels()[0].ctx, 128000);
});

console.log("\n[3] baseUrl 的老迁移仍然保留");

await test("旧全局 baseUrl 归到当前模型", async () => {
  installStorage(
    seed({
      baseUrl: "https://old-gw.example.com/v1",
      customModels: [{ ...AGNES, baseUrl: "" }],
    })
  );
  const st = await loadStore();
  assert.strictEqual(
    st.state.settings.modelOverrides[AGNES.id].baseUrl,
    "https://old-gw.example.com/v1"
  );
});

await test("模型自己的 baseUrl 与旧全局相同就不写覆盖", async () => {
  installStorage(seed({ baseUrl: AGNES.baseUrl }));
  const st = await loadStore();
  assert.deepStrictEqual(st.state.settings.modelOverrides, {});
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
