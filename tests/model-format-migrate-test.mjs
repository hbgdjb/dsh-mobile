#!/usr/bin/env node
/* ============================================================
   模型条目的协议字段（format）迁移

   ============ 这个测试守的是什么 ============

   0.66 之前整站只认 OpenAI 一种协议，模型条目里没有 format。
   加了 Anthropic / Gemini / Ollama 之后，所有分支都要读这个字段：

     runtime.js  chatAttempt   —— 决定用哪个适配器发请求
     ui.js       探测 / 批量添加 —— 决定探测端点与去重
     store.js    modelCatalog  —— 缓存 key 必须带协议，否则两个
                                  兼容入口共用一份清单会串

   老条目（手机里已经存着的）不会自己长出 format，所以加载时补。
   这个测试守三件事：补得对、不误伤插件模型、缓存 key 不串。
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

const baseModel = (over) =>
  Object.assign(
    {
      id: "cm_legacy",
      label: "老网关",
      apiModel: "gpt-4.1-mini",
      provider: "自定义",
      providerKey: "custom",
      baseUrl: "https://gw.example.com/v1",
      ctx: 128000,
    },
    over
  );

console.log("\n[1] 老条目加载时补 openai");

await test("没有 format 的条目 → openai", async () => {
  installStorage({ settings: { customModels: [baseModel()] } });
  const store = await loadStore();
  const m = store.allModels()[0];
  assert.strictEqual(m.format, "openai");
});

await test("已经写了 format 的条目不被覆盖", async () => {
  installStorage({ settings: { customModels: [baseModel({ id: "cm_a", format: "anthropic" })] } });
  const store = await loadStore();
  assert.strictEqual(store.allModels()[0].format, "anthropic");
});

await test("插件模型（node-llm）不补 format", async () => {
  installStorage({
    settings: {
      customModels: [
        baseModel({ id: "cm_node", source: "node-llm", provider: "node__echo", nodeProvider: "echo" }),
      ],
    },
  });
  const store = await loadStore();
  const m = store.allModels()[0];
  assert.strictEqual(m.format, undefined, "插件模型不该被写上 OpenAI 协议");
});

console.log("\n[2] modelFormat 的三级兜底");

await test("条目自带 format 优先", async () => {
  installStorage({ settings: { customModels: [] } });
  const store = await loadStore();
  assert.strictEqual(store.modelFormat({ format: "gemini", providerKey: "openai" }), "gemini");
});

await test("条目没写就看供应方预设", async () => {
  installStorage({ settings: { customModels: [] } });
  const store = await loadStore();
  assert.strictEqual(store.modelFormat({ providerKey: "anthropic" }), "anthropic");
  assert.strictEqual(store.modelFormat({ providerKey: "google" }), "gemini");
  assert.strictEqual(store.modelFormat({ providerKey: "ollamaNative" }), "ollama");
});

await test("都没有就兜底 openai（未知协议也不炸）", async () => {
  installStorage({ settings: { customModels: [] } });
  const store = await loadStore();
  assert.strictEqual(store.modelFormat({ providerKey: "custom" }), "openai");
  assert.strictEqual(store.modelFormat({ providerKey: "nope", format: "martian" }), "openai");
});

await test("modelDefaults 带上 format，恢复默认能还原协议", async () => {
  installStorage({ settings: { customModels: [baseModel({ format: "ollama" })] } });
  const store = await loadStore();
  assert.strictEqual(store.allModels()[0].defaults.format, "ollama");
});

console.log("\n[3] 新预设");

await test("Anthropic / Gemini / Ollama 原生三个预设就位", async () => {
  installStorage({ settings: { customModels: [] } });
  const store = await loadStore();
  const P = store.PROVIDERS;
  assert.strictEqual(P.anthropic.format, "anthropic");
  assert.ok(/^https:\/\/api\.anthropic\.com/.test(P.anthropic.baseUrl));
  assert.strictEqual(P.google.format, "gemini");
  assert.ok(P.google.baseUrl.indexOf("/v1beta") > 0);
  assert.strictEqual(P.ollamaNative.format, "ollama");
  assert.strictEqual(P.ollamaNative.local, true);
  // 老的 ollama 预设必须保持 OpenAI 兼容，老用户填的是 /v1
  assert.strictEqual(P.ollama.format, undefined);
  assert.ok(/\/v1$/.test(P.ollama.baseUrl));
});

console.log("\n[4] 模型清单缓存按协议分开");

await test("同一 slot 两种协议各存各的", async () => {
  installStorage({ settings: { customModels: [] } });
  const store = await loadStore();
  const base = "https://gw.example.com/v1";
  store.rememberModelCatalog("custom", base, ["gpt-4.1"], { format: "openai" });
  store.rememberModelCatalog("custom", base, ["claude-sonnet-4-5"], { format: "anthropic" });
  assert.deepStrictEqual(store.catalogFor("custom", base, "openai"), ["gpt-4.1"]);
  assert.deepStrictEqual(store.catalogFor("custom", base, "anthropic"), ["claude-sonnet-4-5"]);
});

await test("旧版裸 slot 的缓存只在 openai 下回退", async () => {
  installStorage({
    settings: {
      customModels: [],
      modelCatalog: { custom: { baseUrl: "https://gw.example.com/v1", ids: ["old-model"], ts: 1 } },
    },
  });
  const store = await loadStore();
  const base = "https://gw.example.com/v1";
  assert.deepStrictEqual(store.catalogFor("custom", base), ["old-model"]);
  assert.deepStrictEqual(store.catalogFor("custom", base, "openai"), ["old-model"]);
  assert.deepStrictEqual(store.catalogFor("custom", base, "gemini"), []);
});

await test("baseUrl 换掉之后旧缓存不再匹配", async () => {
  installStorage({ settings: { customModels: [] } });
  const store = await loadStore();
  store.rememberModelCatalog("custom", "https://a.example.com/v1", ["m1"], { format: "openai" });
  assert.deepStrictEqual(store.catalogFor("custom", "https://b.example.com/v1", "openai"), []);
});

await test("条目元信息（名称 / 窗口）也一起缓存", async () => {
  installStorage({ settings: { customModels: [] } });
  const store = await loadStore();
  store.rememberModelCatalog("google", "https://x/v1beta", ["gemini-2.5-pro"], {
    format: "gemini",
    items: [{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", ctx: 1048576 }],
  });
  const items = store.catalogItemsFor("google", "https://x/v1beta", "gemini");
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].label, "Gemini 2.5 Pro");
  assert.strictEqual(items[0].ctx, 1048576);
});

console.log("\n[5] 批量写入");

await test("一次加多个、重复 id 跳过、订阅只响一次", async () => {
  installStorage({ settings: { customModels: [baseModel({ id: "cm_keep" })] } });
  const store = await loadStore();
  let emits = 0;
  const off = store.subscribe
    ? store.subscribe(() => {
        emits += 1;
      })
    : null;

  const added = store.addCustomModels([
    baseModel({ id: "cm_1", apiModel: "a" }),
    baseModel({ id: "cm_2", apiModel: "b" }),
    baseModel({ id: "cm_1", apiModel: "a" }),
    baseModel({ id: "cm_keep" }),
  ]);
  if (off) off();

  assert.strictEqual(added.length, 2, "只应新增两条，重复 id 与已存在的都跳过");
  assert.strictEqual(store.allModels().length, 3);
  assert.ok(emits <= 1, `批量写入不该反复 emit（实际 ${emits} 次）`);
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
