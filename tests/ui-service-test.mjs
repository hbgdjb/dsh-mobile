#!/usr/bin/env node
/* ============================================================
   界面宿主服务（Node 侧）的测试

   ============ 这套测试在防什么 ============

   界面宿主最容易出的问题是**假成功**：

     · 插件注册了，日志写着"插槽已注册"，界面上什么都没有
     · 插件挂了界面，插件卸载后界面还在，点了没反应
     · 没声明权限也挂上了 —— 那就等于权限检查形同虚设

   所以断言不只看"挂上了没有"，还要看：
     · 拒绝时有没有说清楚原因
     · 卸载时页面有没有收到 unmount
     · 旧式 register(component 函数) 是不是如实报"渲染不了"

   用法：node tests/ui-service-test.mjs
   ============================================================ */

import assert from "node:assert";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const NODE_DIR = path.join(ROOT, "android", "node");

const { createUiService, SLOT_NAMES } = require(path.join(NODE_DIR, "ui-service.js"));
const { createContainer } = require(path.join(NODE_DIR, "cordis-lite.js"));

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
    if (e && e.stack) console.error(e.stack.split("\n").slice(1, 5).join("\n"));
  }
}

/* ---------------- 脚手架 ---------------- */

/** 一个假宿主：只提供 manifestOf。 */
function makeHost(manifests = {}) {
  return {
    manifestOf(id) {
      const m = manifests[id];
      if (!m) return null;
      return {
        permissions: m.permissions || [],
        surfaces: m.surfaces || [],
      };
    },
  };
}

/** 建服务，收集所有推给页面的消息。 */
function makeService(opts = {}) {
  const sent = [];
  const logs = [];
  const svc = createUiService({
    ctx: opts.ctx || null,
    host: opts.host || null,
    log: (level, scope, message) => logs.push(`${level}|${scope}|${message}`),
    send: (event, data) => sent.push({ event, data }),
  });
  return { svc, sent, logs };
}

/** 一段合法的界面树。 */
function sampleTree(label = "润色") {
  return {
    type: "row",
    gap: "sm",
    children: [
      { type: "badge", text: "插件" },
      { type: "button", label, action: "polish" },
    ],
  };
}

/* ---------------- 测试 ---------------- */

console.log("\n界面宿主服务\n");

await test("挂载点清单是四个约定名字", () => {
  assert.deepStrictEqual(SLOT_NAMES, [
    "shell.overlay",
    "composer.toolbar",
    "sidebar.footer",
    "settings.section",
  ]);
});

await test("mount 会推 ui.mount 给页面", () => {
  const host = makeHost({ demo: { permissions: ["ui.slot"] } });
  const { svc, sent } = makeService({ host });
  const r = svc.mount("composer.toolbar", sampleTree(), { pluginId: "demo" });
  assert.strictEqual(r.ok, true, r.error);
  assert.ok(r.id);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].event, "ui.mount");
  assert.strictEqual(sent[0].data.slot, "composer.toolbar");
  assert.strictEqual(sent[0].data.tree.children[1].label, "润色");
  assert.strictEqual(sent[0].data.pluginId, "demo");
});

await test("mount 也接受对象写法", () => {
  const host = makeHost({ demo: { permissions: ["ui.slot"] } });
  const { svc, sent } = makeService({ host });
  const r = svc.mount({
    slot: "sidebar.footer",
    tree: { type: "text", text: "你好" },
    pluginId: "demo",
    order: 3,
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(sent[0].data.slot, "sidebar.footer");
  assert.strictEqual(sent[0].data.order, 3);
});

await test("没在清单里声明 ui.slot 的插件被拒，且说明原因", () => {
  const host = makeHost({ stingy: { permissions: ["fs.read"] } });
  const { svc, sent } = makeService({ host });
  const r = svc.mount("composer.toolbar", sampleTree(), { pluginId: "stingy" });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /ui\.slot/);
  assert.strictEqual(sent.length, 0, "被拒时不应推给页面");
});

await test("声明了 surfaces 时，挂到别的挂载点被拒", () => {
  const host = makeHost({ demo: { permissions: ["ui.slot"], surfaces: ["shell.overlay"] } });
  const { svc } = makeService({ host });
  const r = svc.mount("settings.section", sampleTree(), { pluginId: "demo" });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /shell\.overlay/);
});

await test("没声明 surfaces 的老插件可以挂任意挂载点", () => {
  const host = makeHost({ demo: { permissions: ["ui.slot"] } });
  const { svc } = makeService({ host });
  for (const slot of SLOT_NAMES) {
    const r = svc.mount(slot, sampleTree(), { pluginId: "demo" });
    assert.strictEqual(r.ok, true, `${slot}: ${r.error}`);
  }
});

await test("未知挂载点被拒", () => {
  const host = makeHost({ demo: { permissions: ["ui.slot"] } });
  const { svc } = makeService({ host });
  const r = svc.mount("body.anywhere", sampleTree(), { pluginId: "demo" });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /未知挂载点/);
});

await test("同一 id 重复挂载是覆盖，不是叠加", () => {
  const host = makeHost({ demo: { permissions: ["ui.slot"] } });
  const { svc, sent } = makeService({ host });
  svc.mount("composer.toolbar", sampleTree("A"), { pluginId: "demo", id: "fix" });
  svc.mount("composer.toolbar", sampleTree("B"), { pluginId: "demo", id: "fix" });
  assert.strictEqual(svc.list().length, 1);
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[1].data.tree.children[1].label, "B");
});

await test("update 推 ui.update", () => {
  const host = makeHost({ demo: { permissions: ["ui.slot"] } });
  const { svc, sent } = makeService({ host });
  const r = svc.mount("composer.toolbar", sampleTree(), { pluginId: "demo" });
  sent.length = 0;
  const u = svc.update(r.id, { type: "text", text: "已润色" });
  assert.strictEqual(u.ok, true);
  assert.strictEqual(sent[0].event, "ui.update");
  assert.strictEqual(sent[0].data.tree.text, "已润色");
});

await test("unmount 推 ui.unmount 并从清单里消失", () => {
  const host = makeHost({ demo: { permissions: ["ui.slot"] } });
  const { svc, sent } = makeService({ host });
  const r = svc.mount("composer.toolbar", sampleTree(), { pluginId: "demo" });
  sent.length = 0;
  assert.strictEqual(svc.unmount(r.id).ok, true);
  assert.strictEqual(sent[0].event, "ui.unmount");
  assert.strictEqual(svc.list().length, 0);
});

await test("onAction + handleAction：回调能返回新树", async () => {
  const host = makeHost({ demo: { permissions: ["ui.slot"] } });
  const { svc, sent } = makeService({ host });
  const r = svc.mount("composer.toolbar", sampleTree(), { pluginId: "demo" });

  let seen = null;
  svc.onAction(r.id, async (action, value) => {
    seen = { action, value };
    return { type: "text", text: `点了 ${action}` };
  });

  const out = await svc.handleAction({ id: r.id, action: "polish", value: "v1" });
  assert.strictEqual(out.ok, true, out.error);
  assert.deepStrictEqual(seen, { action: "polish", value: "v1" });
  // 新的树也推给页面了
  const last = sent[sent.length - 1];
  assert.strictEqual(last.event, "ui.update");
  assert.strictEqual(last.data.tree.text, "点了 polish");
});

await test("handleAction：回调抛错时如实返回原因", async () => {
  const host = makeHost({ demo: { permissions: ["ui.slot"] } });
  const { svc, logs } = makeService({ host });
  const r = svc.mount("composer.toolbar", sampleTree(), { pluginId: "demo" });
  svc.onAction(r.id, () => {
    throw new Error("接口挂了");
  });
  const out = await svc.handleAction({ id: r.id, action: "polish" });
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /接口挂了/);
  assert.ok(logs.some((l) => l.includes("接口挂了")));
});

await test("handleAction：界面已卸载时说清楚", async () => {
  const { svc } = makeService({ host: makeHost({}) });
  const out = await svc.handleAction({ id: "nope", action: "x" });
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /界面已不存在/);
});

await test("旧接口 register(函数) 如实标注 rendered:false", () => {
  const host = makeHost({ legacy: { permissions: ["ui.slot"] } });
  const { svc, logs } = makeService({ host });
  const id = svc.register({ id: "s1", name: "composer.toolbar" }, function Component() {});
  assert.strictEqual(id, "s1");
  const row = svc.list().find((m) => m.id === "s1");
  assert.ok(row, "注册记录应该出现在清单里");
  assert.strictEqual(row.rendered, false);
  assert.match(row.reason, /跨进程/);
  assert.ok(logs.some((l) => l.includes("不会显示")), "应该留下一条警告日志");
});

await test("旧接口 register(对象) 当成界面树真的挂上", () => {
  const host = makeHost({ legacy: { permissions: ["ui.slot"] } });
  const { svc, sent } = makeService({ host });
  const id = svc.register({ id: "s2", name: "composer.toolbar", pluginId: "legacy" }, sampleTree());
  assert.strictEqual(id, "s2");
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].event, "ui.mount");
  assert.strictEqual(sent[0].data.id, "s2");
});

await test("一个插件最多挂 12 个界面", () => {
  const host = makeHost({ demo: { permissions: ["ui.slot"] } });
  const { svc } = makeService({ host });
  for (let i = 0; i < 12; i += 1) {
    assert.strictEqual(svc.mount("composer.toolbar", sampleTree(), { pluginId: "demo" }).ok, true);
  }
  const r = svc.mount("composer.toolbar", sampleTree(), { pluginId: "demo" });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /最多/);
});

await test("snapshot 带完整界面树", () => {
  const host = makeHost({ demo: { permissions: ["ui.slot"], surfaces: ["composer.toolbar"] } });
  const { svc } = makeService({ host });
  svc.mount("composer.toolbar", sampleTree("快照"), { pluginId: "demo" });
  const snap = svc.snapshot();
  assert.strictEqual(snap.length, 1);
  assert.strictEqual(snap[0].tree.children[1].label, "快照");
  assert.strictEqual(snap[0].slot, "composer.toolbar");
});

await test("unmountPlugin 清掉该插件的全部界面，不碰别人", () => {
  const host = makeHost({
    a: { permissions: ["ui.slot"] },
    b: { permissions: ["ui.slot"] },
  });
  const { svc } = makeService({ host });
  svc.mount("composer.toolbar", sampleTree(), { pluginId: "a" });
  svc.mount("sidebar.footer", sampleTree(), { pluginId: "a" });
  svc.mount("settings.section", sampleTree(), { pluginId: "b" });
  assert.strictEqual(svc.unmountPlugin("a"), 2);
  assert.strictEqual(svc.list().length, 1);
  assert.strictEqual(svc.list()[0].pluginId, "b");
});

await test("没有 host 时（宿主自己挂）不拦权限", () => {
  const { svc } = makeService({ host: null });
  const r = svc.mount("composer.toolbar", sampleTree(), { pluginId: "core" });
  assert.strictEqual(r.ok, true, r.error);
});

/* ---------------- 与真容器联调：卸载钩子 ---------------- */

await test("插件卸载时界面自动消失（scope.onDispose）", async () => {
  const container = createContainer({});
  const sent = [];
  const host = makeHost({ demo: { permissions: ["ui.slot"] } });
  const svc = createUiService({
    ctx: container.root,
    host,
    log: () => {},
    send: (event, data) => sent.push({ event, data }),
  });

  container.provide("slots", svc);

  const plugin = {
    name: "demo",
    // 服务必须声明，否则 cordis 语义下 ctx.slots 拿不到
    inject: ["slots"],
    apply(ctx) {
      const r = ctx.slots.mount("composer.toolbar", sampleTree(), { pluginId: "demo" });
      if (!r.ok) throw new Error(r.error);
    },
  };

  const applied = container.apply(plugin);
  assert.strictEqual(applied.ok, true);
  assert.strictEqual(svc.list().length, 1, "apply 之后应该有一个挂载");
  assert.strictEqual(sent.filter((s) => s.event === "ui.mount").length, 1);

  sent.length = 0;
  applied.disposer();

  assert.strictEqual(svc.list().length, 0, "dispose 之后挂载应该没了");
  assert.ok(
    sent.some((s) => s.event === "ui.unmount"),
    "页面应该收到 unmount —— 否则屏幕上会留着一块点不动的旧界面"
  );
});

/* ---------------- 收尾 ---------------- */

console.log(`\n${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
