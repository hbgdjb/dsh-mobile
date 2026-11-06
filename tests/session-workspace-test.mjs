#!/usr/bin/env node
/* ============================================================
   按会话隔离工作区 —— 回归测试

   用「最小 localStorage + 内存版 DshFs 桥」跑真实的 store.js，
   覆盖逻辑路径 ↔ 真实路径映射、跨会话互不可见、共享基底 CoW、
   开关回退、备份导入范围、提示词上下文与 UI 契约。

   用法：node tests/session-workspace-test.mjs
   ============================================================ */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

class MemStore {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i]; }
}

/** 内存版原生文件桥：完全按 DshFsBridge 的 id + 事件回调协议。 */
class MemFs {
  constructor() { this.docs = new Map(); this.calls = []; }
  key(area, p) { return `${area}:${p}`; }
  rootPath() { return "/mem"; }
  emit(id, res) {
    // 同步回调即可：fs.js 的 nativeCall 会把 resolve 排进微任务
    globalThis.window.__dshFsEvent({ id, ok: true, ...res });
  }
  list(id, area, prefix = "") {
    const files = [];
    for (const [k, v] of this.docs) {
      if (!k.startsWith(`${area}:`)) continue;
      const p = k.slice(area.length + 1);
      if (!p.startsWith(prefix)) continue;
      files.push({ path: p, size: v.size || 0, mtime: v.mtime || 0 });
    }
    this.emit(id, { files });
  }
  read(id, area, p, binary) {
    const v = this.docs.get(this.key(area, p));
    if (!v) return globalThis.window.__dshFsEvent({ id, ok: false, error: "文件不存在" });
    this.emit(id, binary ? { base64: v.content, size: v.size } : { content: v.content, size: v.size });
  }
  write(id, area, p, content) {
    const size = Buffer.byteLength(content, "utf8");
    this.docs.set(this.key(area, p), { content, size, mtime: Date.now() });
    this.emit(id, { size, mtime: Date.now() });
  }
  writeBinary(id, area, p, base64) {
    const size = Math.round(String(base64).length * 0.75);
    this.docs.set(this.key(area, p), { content: base64, size, mtime: Date.now(), binary: true });
    this.emit(id, { size, mtime: Date.now() });
  }
  delete(id, area, p) {
    this.docs.delete(this.key(area, p));
    this.emit(id, {});
  }
  clear(id, area) {
    for (const k of [...this.docs.keys()]) if (k.startsWith(`${area}:`)) this.docs.delete(k);
    this.emit(id, {});
  }
  move(id, fromArea, fromPath, toArea, toPath) {
    const v = this.docs.get(this.key(fromArea, fromPath));
    if (v) { this.docs.set(this.key(toArea, toPath), v); this.docs.delete(this.key(fromArea, fromPath)); }
    this.emit(id, { size: v?.size || 0, mtime: Date.now() });
  }
  importFiles() { this.emit(arguments[0], { files: [] }); }
  importFilesTo() { this.emit(arguments[0], { files: [] }); }
  exportFile(id, area, p) {
    this.calls.push({ area, path: p });
    this.emit(id, {});
  }
}

const mem = new MemStore();
const bridge = new MemFs();
globalThis.localStorage = mem;
globalThis.window = { DshFs: bridge };
globalThis.document = { visibilityState: "visible" };
globalThis.indexedDB = undefined;

const store = await import("../scripts/store.js?session-ws=1");
const { state } = store;
await store.initFiles();

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}`); console.error(`      ${e && e.message ? e.message : e}`); }
}
const paths = () => store.listFiles().map((f) => f.path).sort();
const has = (p) => paths().includes(p);

console.log("\n[1] 默认行为与真实存储路径");

await test("默认开启按会话隔离", () => {
  assert.equal(state.settings.isolateWorkspace, true);
});

const A = store.createSession({ mode: "standard", title: "会话 A" });
const B = store.createSession({ mode: "standard", title: "会话 B" });
// createSession 把 active 指到 B，先切回 A
store.switchSession(A.id);

await test("初始共享区（种子 README）在所有会话可见", () => {
  assert.ok(has("README.md"), `实际：${paths()}`);
  const info = store.sessionWorkspaceInfo();
  assert.equal(info.isolated, true);
  assert.equal(info.scope, `sessions/${A.id}/`);
  assert.ok(info.shared >= 1);
});

await test("写文件落到 sessions/<当前会话>/ 私有区", async () => {
  const r = await store.writeFile("parts/01.html", "<h1>A</h1>");
  assert.equal(r.path, "parts/01.html", "返回值应是逻辑路径");
  assert.ok(bridge.docs.has(`workspace:sessions/${A.id}/parts/01.html`), "真实路径缺会话前缀");
  assert.equal(bridge.docs.get(`workspace:sessions/${A.id}/parts/01.html`).content, "<h1>A</h1>");
});

await test("listFiles 只给逻辑路径，不泄露 sessions/ 前缀", () => {
  assert.ok(has("parts/01.html"));
  assert.ok(!paths().some((p) => p.startsWith("sessions/")), `实际：${paths()}`);
});

console.log("\n[2] 跨会话互不可见");

await test("切到会话 B 看不到 A 写的 parts/01.html", () => {
  store.switchSession(B.id);
  assert.ok(!has("parts/01.html"), `B 不该看到 A 的文件：${paths()}`);
  assert.ok(has("README.md"), "共享基底仍可见");
});

await test("B 写同名文件，内容与 A 各自独立", async () => {
  await store.writeFile("parts/01.html", "<h1>B</h1>");
  assert.equal(bridge.docs.get(`workspace:sessions/${A.id}/parts/01.html`).content, "<h1>A</h1>");
  assert.equal(bridge.docs.get(`workspace:sessions/${B.id}/parts/01.html`).content, "<h1>B</h1>");
});

await test("readFile 读回的是本会话内容", async () => {
  const b = await store.readFile("parts/01.html");
  assert.equal(b.content, "<h1>B</h1>");
  assert.equal(b.path, "parts/01.html");
  store.switchSession(A.id);
  const a = await store.readFile("parts/01.html");
  assert.equal(a.content, "<h1>A</h1>");
});

await test("readDoc(workspace, 逻辑路径) 也按会话映射", async () => {
  const d = await store.readDoc("workspace", "parts/01.html");
  assert.equal(d.content, "<h1>A</h1>");
  assert.equal(d.path, "parts/01.html");
});

await test("无法借 sessions/<别的会话>/ 前缀越界读取", async () => {
  const d = await store.readFile(`sessions/${B.id}/parts/01.html`);
  assert.equal(d, null, "越界路径应读不到");
});

console.log("\n[3] 共享基底：只读 + copy-on-write");

const sharedReadme = bridge.docs.get("workspace:README.md").content;

await test("改写共享同名文件不污染原件（CoW）", async () => {
  await store.writeFile("README.md", "# A 改过的 README");
  assert.equal(bridge.docs.get("workspace:README.md").content, sharedReadme, "共享原件被覆盖了");
  assert.ok(bridge.docs.has(`workspace:sessions/${A.id}/README.md`), "应写入 A 私有区");
});

await test("A 看到私有副本，B 仍看到共享原件", async () => {
  assert.equal((await store.readFile("README.md")).content, "# A 改过的 README");
  store.switchSession(B.id);
  assert.equal((await store.readFile("README.md")).content, sharedReadme);
});

await test("私有副本优先于共享同名文件", () => {
  store.switchSession(A.id);
  const hit = store.listFiles().find((f) => f.path === "README.md");
  assert.equal(hit.shared, false, "有私有副本时不应标记为共享");
});

await test("删除私有副本后回落到共享原件，共享原件没被删", async () => {
  await store.deleteFile("README.md");
  assert.ok(bridge.docs.has("workspace:README.md"), "共享文件被误删");
  assert.equal((await store.readFile("README.md")).content, sharedReadme);
});

await test("共享区文件不能被某个会话删掉", async () => {
  store.switchSession(B.id);
  await store.deleteFile("README.md");
  assert.ok(bridge.docs.has("workspace:README.md"));
  assert.ok(has("README.md"));
});

console.log("\n[4] 共享白名单：插件与长期记忆不参与隔离");

await test("plugins/ 写入不带会话前缀（Node 侧扫得到）", async () => {
  store.switchSession(A.id);
  const r = await store.writeFile("plugins/demo/main.js", "module.exports = 1;");
  assert.equal(r.path, "plugins/demo/main.js");
  assert.ok(bridge.docs.has("workspace:plugins/demo/main.js"), "插件被写进了会话私有区");
  assert.ok(!bridge.docs.has(`workspace:sessions/${A.id}/plugins/demo/main.js`));
});

await test("plugins/ 在所有会话可见且可读", async () => {
  store.switchSession(B.id);
  assert.ok(has("plugins/demo/main.js"), `实际：${paths()}`);
  assert.equal((await store.readFile("plugins/demo/main.js")).content, "module.exports = 1;");
});

await test("学习库/ 同样跨会话共享", async () => {
  await store.writeFile("学习库/2026-11.md", "# 长期记忆");
  assert.ok(bridge.docs.has("workspace:学习库/2026-11.md"));
  store.switchSession(A.id);
  assert.equal((await store.readFile("学习库/2026-11.md")).content, "# 长期记忆");
});

await test("白名单文件可删（插件卸载场景），普通共享文件仍不可删", async () => {
  await store.deleteFile("plugins/demo/main.js");
  assert.ok(!bridge.docs.has("workspace:plugins/demo/main.js"), "插件删不掉");
  await store.deleteFile("README.md");
  assert.ok(bridge.docs.has("workspace:README.md"), "普通共享文件被误删");
});

console.log("\n[5] 二进制、导出、解析与备份");

await test("writeBinaryFile 同样落到私有区", async () => {
  store.switchSession(A.id);
  const r = await store.writeBinaryFile("img/a.png", "aGVsbG8=", "image/png", 5);
  assert.equal(r.path, "img/a.png");
  assert.ok(bridge.docs.has(`workspace:sessions/${A.id}/img/a.png`));
});

await test("exportDoc 传给原生桥的是真实路径", async () => {
  await store.exportDoc("workspace", "parts/01.html");
  const last = bridge.calls.at(-1);
  assert.equal(last.path, `sessions/${A.id}/parts/01.html`);
});

await test("resolveWorkspacePath 返回逻辑路径", () => {
  assert.equal(store.resolveWorkspacePath("parts/01.html"), "parts/01.html");
  assert.equal(store.resolveWorkspacePath("01.html"), "parts/01.html", "basename 兜底仍可用");
});

await test("导入备份只影响当前会话，不动共享区和 B 的文件", async () => {
  await store.replaceFiles({
    "new.txt": { path: "new.txt", content: "备份内容" },
  });
  assert.ok(has("new.txt"));
  assert.ok(bridge.docs.has("workspace:README.md"), "共享区被清了");
  assert.ok(bridge.docs.has(`workspace:sessions/${B.id}/parts/01.html`), "B 的文件被清了");
  // A 私有区被替换：旧的 parts/01.html 没了，新的 new.txt 在
  assert.ok(!bridge.docs.has(`workspace:sessions/${A.id}/parts/01.html`));
  assert.equal(bridge.docs.get(`workspace:sessions/${A.id}/new.txt`).content, "备份内容");
  store.switchSession(B.id);
  assert.ok(!has("new.txt"), "B 不该看见 A 导入的备份");
});

console.log("\n[6] 开关回退与无会话兜底");

await test("关闭开关后回到全局共用（能看到全部真实路径）", () => {
  store.setSettings({ isolateWorkspace: false });
  assert.equal(store.sessionWorkspaceInfo().isolated, false);
  assert.ok(paths().some((p) => p.startsWith("sessions/")), `实际：${paths()}`);
});

await test("共用模式下写入不带会话前缀", async () => {
  await store.writeFile("shared-mode.txt", "共用");
  assert.ok(bridge.docs.has("workspace:shared-mode.txt"));
});

await test("重新开启后私有区恢复，共用模式写的文件成为共享基底", () => {
  store.setSettings({ isolateWorkspace: true });
  store.switchSession(A.id);
  assert.ok(has("shared-mode.txt"));
  assert.ok(!paths().some((p) => p.startsWith("sessions/")));
});

await test("没有活跃会话时退回全局视图（设置页/工作区页可用）", () => {
  store.switchSession(null);
  assert.equal(store.sessionWorkspaceInfo().isolated, false);
  const r = store.listFiles();
  assert.ok(r.length > 0);
  store.switchSession(A.id);
});

console.log("\n[7] 上游收口：提示词、UI、文案");

await test("system prompt 的文件清单改用 listFiles() 视图", () => {
  const rt = src("scripts/runtime.js");
  assert.ok(/files:\s*listFiles\(\)/.test(rt), "runtime.js 还在用全量 state.files");
  assert.ok(!/files:\s*Object\.values\(state\.files/.test(rt));
});

await test("工作区页展示隔离状态与共享标记", () => {
  const sc = src("scripts/screens.js");
  assert.ok(sc.includes("sessionWorkspaceInfo"), "未引入隔离概况");
  assert.ok(sc.includes("独立工作区"), "未展示独立状态");
  assert.ok(sc.includes('f.shared && wsInfo.isolated ? "共享 · "'), "未标记共享文件");
  assert.ok(sc.includes("toggle-isolate-workspace"), "设置页缺开关");
});

await test("设置开关有事件处理，导入文案已改为当前会话", () => {
  const ui = src("scripts/ui.js");
  assert.ok(ui.includes('case "toggle-isolate-workspace"'));
  assert.ok(ui.includes("导入到当前会话"));
});

await test("Java 侧 area 分桶确实用不了（守住这个前提）", () => {
  const java = src("android/java/DshFsBridge.java");
  assert.ok(/name\s*=\s*"workspace"/.test(java), "areaDir 的默认映射变了，需重新评估方案");
});

console.log("\n[8] 无主文件：删会话后的回收");

let C = null;

await test("会话 C 的文件数可被统计", async () => {
  C = store.createSession({ mode: "standard", title: "会话 C" });
  await store.writeFile("c1.txt", "1");
  await store.writeFile("sub/c2.txt", "22");
  assert.equal(store.sessionFileCount(C.id), 2);
});

await test("删除会话后文件仍在存储里，但当前视图看不到", () => {
  store.deleteSession(C.id);
  store.switchSession(A.id);
  assert.ok(bridge.docs.has(`workspace:sessions/${C.id}/c1.txt`), "文件不应随会话删除");
  assert.ok(!has("c1.txt"), "别的会话不该看到它");
  const info = store.orphanWorkspaceInfo();
  assert.equal(info.count, 2, `实际：${JSON.stringify(info)}`);
  assert.equal(info.sessions, 1);
  assert.ok(info.bytes > 0);
});

await test("清理只删无主文件，不动活跃会话与共享区", async () => {
  const beforeShared = bridge.docs.get("workspace:README.md")?.content;
  const r = await store.purgeOrphanWorkspace();
  assert.equal(r.removed, 2);
  assert.ok(!bridge.docs.has(`workspace:sessions/${C.id}/c1.txt`));
  assert.ok(!bridge.docs.has(`workspace:sessions/${C.id}/sub/c2.txt`));
  assert.ok(bridge.docs.has(`workspace:sessions/${A.id}/new.txt`), "A 的文件被误删");
  assert.equal(bridge.docs.get("workspace:README.md")?.content, beforeShared, "共享区被误删");
  assert.equal(store.orphanWorkspaceInfo().count, 0);
});

await test("重复清理返回 0，不报错", async () => {
  const r = await store.purgeOrphanWorkspace();
  assert.equal(r.removed, 0);
});

await test("设置页有清理入口，删除会话文案如实说明文件保留", () => {
  const sc = src("scripts/screens.js");
  const ui = src("scripts/ui.js");
  assert.ok(sc.includes("purge-orphan"), "设置页缺清理入口");
  assert.ok(ui.includes('case "purge-orphan"'));
  assert.ok(ui.includes("清理无主文件"));
  assert.ok(ui.includes("该会话工作区的") && !ui.includes("工作区文件不受影响"), "文案仍在说「不受影响」");
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
