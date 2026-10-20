/**
 * 配额耗尽时的降级测试。
 *
 * 场景：localStorage 只剩很小空间（模拟被旧数据/其它应用占满），
 * 此时写入应该：
 *   1) 轻量状态（设置/模型）必须保住；
 *   2) 会话正文可以丢，但不能连带把设置一起拖垮；
 *   3) 不能抛未捕获异常。
 */
class MemStore {
  constructor(limit) { this.m = new Map(); this.limit = limit; this.total = 0; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) {
    v = String(v);
    const old = this.m.get(k);
    const oldLen = old ? old.length : 0;
    if (this.total - oldLen + v.length > this.limit) {
      const e = new Error("QuotaExceededError");
      e.name = "QuotaExceededError";
      throw e;
    }
    this.total = this.total - oldLen + v.length;
    this.m.set(k, v);
  }
  removeItem(k) { const v = this.m.get(k); if (v) this.total -= v.length; this.m.delete(k); }
  clear() { this.m.clear(); this.total = 0; }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i]; }
}

// 只给 40KB：足够放设置，不够放大会话
const mem = new MemStore(40 * 1024);
globalThis.localStorage = mem;
globalThis.window = { DshFs: null };
globalThis.document = { visibilityState: "visible" };

const store = await import("../scripts/store.js");
const { state, save } = store;

// 一个大会话
const s = store.createSession({ mode: "standard", title: "大" });
for (let i = 0; i < 40; i++) {
  store.addMessage(s.id, { id: `m${i}`, role: "assistant", content: "z".repeat(5000), ts: Date.now(), status: "done" });
}
save(true);

const mainRaw = mem.getItem("dsh.mobile.state.v1");
console.log("1) 主键是否还在（设置要保住）：", mainRaw ? "是 ✓" : "否 ✗");
if (mainRaw) {
  const o = JSON.parse(mainRaw);
  console.log("   设置完整：", o.settings ? "是 ✓" : "否 ✗");
  console.log("   自定义模型保留：", Array.isArray(o.settings.customModels) ? "是 ✓" : "否 ✗");
  console.log("   会话索引保留：", Array.isArray(o.sessions) && o.sessions.length ? "是 ✓" : "否 ✗");
}
console.log("2) 会话分片是否写入：", mem.getItem(`dsh.mobile.sessions.v1.${s.id}`) ? "是 ✓" : "否（已降级，可接受）");
console.log("3) 内存中会话内容仍在：", state.sessions[0].messages.length === 40 ? "是 ✓" : `否 ✗ (${state.sessions[0].messages.length})`);
console.log("4) 未抛出未捕获异常 ✓");
