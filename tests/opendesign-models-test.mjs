#!/usr/bin/env node
/* ============================================================
   OpenDesign 模型 ID：解析、反查、收口与老数据迁移

   ============ 这次守的是什么 ============

   0.67.0 把 OpenDesign 供应商接对了方向（云端网关），但模型探测
   把 /v1/models 里的「显示名」当成了 ID：`deepSeek V4.1 Flash`
   原样存进 model.apiModel 发到 /chat/completions，网关找不到模型，
   直接回 HTTP 404；同时列表嵌套一层就整个变空，看着「不全」。

   这份测试钉住四层：
     · formats.js  解析 —— 显示名绝不能进 id，容器要能递归
     · store.js    反查 —— 官方 12 个显示名能纠正回真实 ID
     · store.js    收口 —— UI 拿到的必须全是能直接发的 ID，且保序
     · store.js    迁移 —— 手机里已经存坏的条目升级时自动修好
   ============================================================ */

import assert from "node:assert";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  FORMATS,
  parseOpenAIModelList,
  parseOpenAIModelIds,
  httpHint,
} from "../scripts/formats.js";

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

globalThis.window = globalThis.window || {};
globalThis.document = globalThis.document || { addEventListener() {}, querySelector: () => null };

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

let seq = 0;
async function loadStore() {
  seq += 1;
  return await import(pathToFileURL(path.join(ROOT, "scripts", "store.js")).href + `?v=${seq}`);
}

/* ------------------------------------------------------------
   [1] 解析：什么能当 ID，什么只能当显示名
   ------------------------------------------------------------ */
console.log("\n[1] /v1/models 响应解析");

await test("标准 OpenAI 形状：data[].id", () => {
  const out = parseOpenAIModelList(
    JSON.stringify({ object: "list", data: [{ id: "gpt-4.1" }, { id: "o4-mini" }] })
  );
  assert.deepStrictEqual(out.map((x) => x.id), ["gpt-4.1", "o4-mini"]);
});

await test("同时给 id 和 name：id 进 ID、name 只做显示名", () => {
  const [m] = parseOpenAIModelList(
    JSON.stringify({ data: [{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }] })
  );
  assert.strictEqual(m.id, "deepseek-v4.1-flash");
  assert.strictEqual(m.label, "DeepSeek V4.1 Flash");
});

await test("字段叫 model_id / slug 也能认出来", () => {
  const out = parseOpenAIModelList(
    JSON.stringify({ data: [{ model_id: "claude-haiku-5.5", name: "Claude Haiku 5.5" }, { slug: "gpt-6-luna" }] })
  );
  assert.deepStrictEqual(out.map((x) => x.id), ["claude-haiku-5.5", "gpt-6-luna"]);
});

await test("只有显示名 → id 留空，绝不把「deepSeek V4.1 Flash」当 ID", () => {
  const [m] = parseOpenAIModelList(
    JSON.stringify({ data: [{ name: "deepSeek V4.1 Flash" }] })
  );
  assert.strictEqual(m.id, "", "显示名含空格，不能进 id：" + JSON.stringify(m));
  assert.strictEqual(m.label, "deepSeek V4.1 Flash");
});

await test("name 本身就是合法 slug 时才当 ID", () => {
  const [m] = parseOpenAIModelList(JSON.stringify({ data: [{ name: "qwen2.5:7b" }] }));
  assert.strictEqual(m.id, "qwen2.5:7b");
  assert.strictEqual(m.label, "");
});

await test("容器嵌套一层（result.data）不会整个列表变空", () => {
  const out = parseOpenAIModelList(
    JSON.stringify({ result: { data: [{ id: "a" }, { id: "b" }] } })
  );
  assert.deepStrictEqual(out.map((x) => x.id), ["a", "b"]);
});

await test("多个并列的模型数组会合并", () => {
  const out = parseOpenAIModelList(
    JSON.stringify({ data: [{ id: "a" }], models: [{ id: "b" }] })
  );
  assert.deepStrictEqual(out.map((x) => x.id), ["a", "b"]);
});

await test("纯字符串数组照旧可用", () => {
  const out = parseOpenAIModelList(JSON.stringify({ data: ["a", "b"] }));
  assert.deepStrictEqual(out.map((x) => x.id), ["a", "b"]);
});

await test("非 JSON（nginx 404 HTML）返回空，不抛", () => {
  assert.deepStrictEqual(parseOpenAIModelList("<html>404 Not Found</html>"), []);
  assert.deepStrictEqual(parseOpenAIModelList(""), []);
});

await test("兼容入口 parseOpenAIModelIds 不吐显示名", () => {
  const ids = parseOpenAIModelIds(
    JSON.stringify({ data: [{ name: "deepSeek V4.1 Flash" }, { id: "hy4-preview" }] })
  );
  assert.deepStrictEqual(ids, ["hy4-preview"]);
});

/* ------------------------------------------------------------
   [2] 官方目录与显示名反查
   ------------------------------------------------------------ */
console.log("\n[2] 官方目录与显示名反查");

installStorage(null);
const store = await loadStore();

await test("目录是 12 条，且每条都是合法 ID", () => {
  assert.strictEqual(store.OPEN_DESIGN_MODELS.length, 12);
  assert.ok(store.OPEN_DESIGN_MODELS.every((m) => /^[a-z0-9._-]+$/.test(m.id)));
});

await test("截图里那个坏值能纠正成 deepseek-v4.1-flash", () => {
  assert.strictEqual(store.normalizeOpendesignModelId("deepSeek V4.1 Flash"), "deepseek-v4.1-flash");
  assert.strictEqual(store.normalizeOpendesignModelId("DeepSeek V4.1 Flash"), "deepseek-v4.1-flash");
  assert.strictEqual(store.normalizeOpendesignModelId("DEEPSEEK V4.1 FLASH"), "deepseek-v4.1-flash");
});

await test("12 个官方显示名全部能反查回 ID", () => {
  for (const m of store.OPEN_DESIGN_MODELS) {
    assert.strictEqual(store.normalizeOpendesignModelId(m.label), m.id, m.label);
  }
});

await test("已经是 ID 的保持原样，未知 ID 也不乱改", () => {
  assert.strictEqual(store.normalizeOpendesignModelId("deepseek-v4.1-flash"), "deepseek-v4.1-flash");
  assert.strictEqual(store.normalizeOpendesignModelId("gpt-7-ultra"), "gpt-7-ultra");
});

/* ------------------------------------------------------------
   [3] 收口：UI 拿到的必须是能直接发的 ID
   ------------------------------------------------------------ */
console.log("\n[3] 探测结果收口");

await test("opendesign：显示名条目反查成真实 ID", () => {
  const out = store.resolveDiscoveredModels("opendesign", [
    { id: "", label: "deepSeek V4.1 Flash" },
    { id: "claude-haiku-5.5", label: "Claude Haiku 5.5" },
  ]);
  assert.deepStrictEqual(out.map((x) => x.id), ["deepseek-v4.1-flash", "claude-haiku-5.5"]);
});

await test("opendesign：反查不到的显示名直接丢掉，合法新 ID 保留", () => {
  const out = store.resolveDiscoveredModels("opendesign", [
    { id: "", label: "某个我没见过的模型" },
    { id: "gpt-7-ultra", label: "" },
  ]);
  assert.deepStrictEqual(out.map((x) => x.id), ["gpt-7-ultra"]);
});

await test("opendesign：保序，不重排上游给的顺序", () => {
  const out = store.resolveDiscoveredModels("opendesign", [
    { id: "mimo-v2.6-pro" },
    { id: "deepseek-v4.1-flash" },
    { id: "hy4-preview" },
  ]);
  assert.deepStrictEqual(out.map((x) => x.id), ["mimo-v2.6-pro", "deepseek-v4.1-flash", "hy4-preview"]);
});

await test("opendesign：去重", () => {
  const out = store.resolveDiscoveredModels("opendesign", [
    { id: "deepseek-v4.1-flash" },
    { id: "", label: "DeepSeek V4.1 Flash" },
  ]);
  assert.strictEqual(out.length, 1);
});

await test("其它供应商不做 OpenDesign 反查，且保序、过滤无 ID 项", () => {
  const out = store.resolveDiscoveredModels("anthropic", [
    { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { id: "", label: "deepSeek V4.1 Flash" },
    { id: "claude-haiku-4-5" },
  ]);
  assert.deepStrictEqual(out.map((x) => x.id), ["claude-sonnet-4-5", "claude-haiku-4-5"]);
});

await test("404 提示要说清是 ID 不是显示名", () => {
  assert.ok(/ID/.test(httpHint(404)) && /显示名/.test(httpHint(404)), httpHint(404));
});

/* ------------------------------------------------------------
   [4] 端到端：假 /v1/models 返回显示名
   ------------------------------------------------------------ */
console.log("\n[4] 端到端：解析 → 收口");

const fakeModels = {
  data: [
    { name: "deepSeek V4.1 Flash" },
    { model_id: "claude-haiku-5.5", name: "Claude Haiku 5.5" },
    { id: "gpt-6-luna", name: "GPT-6 Luna" },
  ],
};
const listed = await FORMATS.openai.listModels({
  baseUrl: "https://amr-link.open-design.ai/v1",
  apiKey: "sk-fake",
  request: async ({ url }) => ({ status: 200, text: JSON.stringify(fakeModels) }),
});

await test("假上游打的是 /v1/models", () => {
  assert.ok(String(listed.endpoint).endsWith("/v1/models"), listed.endpoint);
});

await test("解析层把三个条目都带出来（不再「列表不全」）", () => {
  assert.strictEqual(listed.items.length, 3, JSON.stringify(listed.items));
});

await test("收口后三个都是真实 ID，没有显示名混进请求体", () => {
  const ids = store.resolveDiscoveredModels("opendesign", listed.items).map((x) => x.id);
  // 解析层会按 ID 排序（既有行为），这里只关心集合与值是否可直接发送
  assert.deepStrictEqual([...ids].sort(), ["claude-haiku-5.5", "deepseek-v4.1-flash", "gpt-6-luna"]);
  assert.ok(ids.every((id) => !/\s/.test(id)));
});

await test("不传 providerKey 时，显示名条目不会冒充 ID", () => {
  const ids = store.resolveDiscoveredModels("", listed.items).map((x) => x.id);
  assert.ok(!ids.includes("deepSeek V4.1 Flash"));
});

/* ------------------------------------------------------------
   [5] 老数据迁移：手机里已经存坏的条目
   ------------------------------------------------------------ */
console.log("\n[5] 升级时自动修好已存模型");

const badModel = {
  id: "cm_od_bad",
  label: "deepSeek V4.1 Flash",
  apiModel: "deepSeek V4.1 Flash",
  provider: "OpenDesign · Cloud API",
  providerKey: "opendesign",
  baseUrl: "https://amr-link.open-design.ai/v1",
  ctx: 1000000,
  format: "openai",
  custom: true,
};

await test("坏 ID 纠正成 deepseek-v4.1-flash，label 换成可读名", async () => {
  installStorage({
    settings: {
      model: "cm_od_bad",
      customModels: [badModel],
      modelStatus: { cm_od_bad: { state: "error", text: "HTTP 404" } },
    },
  });
  const s = await loadStore();
  const m = s.allModels()[0];
  assert.strictEqual(m.apiModel, "deepseek-v4.1-flash");
  assert.strictEqual(m.label, "DeepSeek V4.1 Flash");
});

await test("旧的「连接失败 404」状态被清掉", async () => {
  installStorage({
    settings: {
      model: "cm_od_bad",
      customModels: [badModel],
      modelStatus: { cm_od_bad: { state: "error", text: "HTTP 404" } },
    },
  });
  const s = await loadStore();
  assert.strictEqual(s.state.settings.modelStatus.cm_od_bad, undefined);
});

await test("只按端点认也能修（老条目没写 providerKey）", async () => {
  installStorage({
    settings: {
      model: "cm_od_bad",
      customModels: [{ ...badModel, providerKey: undefined }],
    },
  });
  const s = await loadStore();
  assert.strictEqual(s.allModels()[0].apiModel, "deepseek-v4.1-flash");
});

await test("别家的模型一个字都不动", async () => {
  installStorage({
    settings: {
      model: "cm_other",
      customModels: [
        { ...badModel, id: "cm_other", apiModel: "Some Display Name", baseUrl: "https://gw.example.com/v1", providerKey: "custom" },
      ],
    },
  });
  const s = await loadStore();
  assert.strictEqual(s.allModels()[0].apiModel, "Some Display Name");
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
