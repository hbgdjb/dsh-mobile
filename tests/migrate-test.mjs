/**
 * 旧格式迁移测试：模拟 0.20.0 之前"所有会话挤在一个键里"的存量数据，
 * 验证升级后能被正确迁移成分片存储，且会话内容不丢。
 */
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

// 老版本的 state 结构：sessions 里带完整 messages
const legacy = {
  version: 1,
  settings: { model: "m1", keys: {}, customModels: [] },
  activeSessionId: "s_old",
  sessions: [
    {
      id: "s_old", title: "旧会话", createdAt: 1, updatedAt: 2, mode: "standard",
      messages: [
        { id: "u1", role: "user", content: "老消息一", ts: 1 },
        { id: "a1", role: "assistant", content: "老回复一", ts: 2, status: "done" },
      ],
    },
    {
      id: "s_old2", title: "旧会话二", createdAt: 3, updatedAt: 4, mode: "standard",
      messages: [{ id: "u2", role: "user", content: "老消息二", ts: 3 }],
    },
  ],
  files: {}, library: {},
};
mem.setItem("dsh.mobile.state.v1", JSON.stringify(legacy));

const store = await import("../scripts/store.js");

console.log("1) 迁移后会话数：", store.state.sessions.length, "（期望 2）");
const s1 = store.state.sessions.find((s) => s.id === "s_old");
console.log("2) 旧会话消息数：", s1.messages.length, "（期望 2）");
console.log("   消息内容保留：", s1.messages.map((m) => m.content).join("/") === "老消息一/老回复一" ? "是 ✓" : "否 ✗");
console.log("3) 已迁移到分片键：", mem.getItem("dsh.mobile.sessions.v1.s_old") ? "是 ✓" : "否 ✗");
console.log("4) 主键已瘦身：", JSON.parse(mem.getItem("dsh.mobile.state.v1")).sessions[0].messages ? "否 ✗" : "是 ✓");
console.log("5) activeSessionId 保留：", store.state.activeSessionId, "（期望 s_old）");
