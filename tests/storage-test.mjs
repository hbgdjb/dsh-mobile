/**
 * 存储分片 + 状态自愈的回归测试。
 * 用一个最小的 localStorage 模拟器跑真实的 store.js。
 */
import fs from "node:fs";
import path from "node:path";

// ---- 最小 localStorage 模拟 ----
class MemStore {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i]; }
}
const mem = new MemStore();
globalThis.localStorage = mem;
globalThis.window = { DshFs: null };
globalThis.document = { visibilityState: "visible" };
globalThis.indexedDB = undefined;

// 记录写入量，模拟慢/大的 localStorage
let writeCount = 0;
const origSet = mem.setItem.bind(mem);
mem.setItem = (k, v) => { writeCount++; origSet(k, v); };

const store = await import("../scripts/store.js");
const { state, save, saveSessionNow, addMessage } = store;

// ---------- 1. 写入与分片 ----------
const s = store.createSession({ mode: "standard", title: "T1" });
addMessage(s.id, { id: "u1", role: "user", content: "你好", ts: Date.now() });
save(true);

const mainRaw = mem.getItem("dsh.mobile.state.v1");
const mainObj = JSON.parse(mainRaw);
console.log("1) 主键里是否含会话正文：", Array.isArray(mainObj.sessions[0].messages) ? "是（未分片）" : "否（已分片）✓");
console.log("   分片键存在：", mem.getItem(`dsh.mobile.sessions.v1.${s.id}`) ? "是 ✓" : "否 ✗");

// ---------- 2. 大会话不会撑爆主键 ----------
for (let i = 0; i < 200; i++) {
  addMessage(s.id, { id: `a${i}`, role: "assistant", content: "x".repeat(3000), ts: Date.now(), status: "done" });
}
save(true);
const mainSize = mem.getItem("dsh.mobile.state.v1").length;
const sessSize = mem.getItem(`dsh.mobile.sessions.v1.${s.id}`).length;
console.log(`2) 主键大小 ${(mainSize/1024).toFixed(1)}KB，分片大小 ${(sessSize/1024).toFixed(1)}KB`);
console.log("   主键保持轻量：", mainSize < 50000 ? "是 ✓" : "否 ✗");

// ---------- 3. 写入次数（增量落盘） ----------
const before = writeCount;
for (let i = 0; i < 20; i++) {
  addMessage(s.id, { id: `b${i}`, role: "user", content: "y".repeat(100), ts: Date.now() });
  saveSessionNow(s.id);
}
save(true);
console.log(`3) 20 次消息变更共触发 ${writeCount - before} 次写入（增量而非全量重写）`);

// ---------- 4. 残留 running 自愈 ----------
const s2 = store.createSession({ mode: "standard", title: "T2" });
addMessage(s2.id, { id: "u9", role: "user", content: "跑个任务", ts: Date.now() });
const stale = {
  id: "a9", role: "assistant", status: "running", ts: Date.now(),
  content: "已经生成了一半", reasoning: "", tools: [{ id: "t1", name: "shell", status: "running", output: "" }],
};
addMessage(s2.id, stale);
save(true);

// 模拟"进程重启"：重新 import store（用 query 参数绕过模块缓存）
mem.setItem("__restart__", "1");
const store2 = await import("../scripts/store.js?restart=1");
const s2b = store2.state.sessions.find((x) => x.id === s2.id);
const m2 = s2b.messages.find((x) => x.id === "a9");
console.log("4) 重启后残留消息状态：", m2.status, m2.interrupted ? "(已标记中断 ✓)" : "(未标记 ✗)");
console.log("   工具状态：", m2.tools[0].status);
console.log("   内容是否保留：", m2.content === "已经生成了一半" ? "是 ✓" : "否 ✗");
console.log("   提示文案：", (m2.error || "").slice(0, 30) + "…");

// ---------- 5. 旧格式迁移 ----------
console.log("\n5) 旧格式迁移检查（需单独进程跑，见 migrate-test.mjs）");
