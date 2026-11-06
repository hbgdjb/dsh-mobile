/* ============================================================
   主应用侧 IME 接线测试

   验三件事：
     1. 配置快照只给改写需要的四个字段，不夹带会话历史
     2. 截图进来能变成附件
     3. 键盘状态能被正确识别（浏览器环境 = 不支持）
   ============================================================ */

import assert from "node:assert/strict";

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    console.log(`  ✗ ${name}\n    ${err?.message || err}`);
  }
}

// ---- 造一个假的原生桥 ----
function makeHost(overrides = {}) {
  const calls = { setConfig: [], ready: 0, onShot: [] };
  return {
    calls,
    host: {
      setConfig: (json) => calls.setConfig.push(json),
      getConfig: () => calls.setConfig[calls.setConfig.length - 1] || "{}",
      ready: () => {
        calls.ready++;
      },
      status: () => JSON.stringify(overrides.status || { enabled: false, current: false, serviceId: "x" }),
      listPhrases: () => JSON.stringify(overrides.phrases || []),
      savePhrase: (j) => calls.onShot.push(["savePhrase", j]),
      deletePhrase: (id) => calls.onShot.push(["deletePhrase", id]),
      listClipboard: () => JSON.stringify(overrides.clips || []),
      clearClipboard: () => calls.onShot.push(["clearClipboard"]),
      openImeSettings: () => calls.onShot.push(["openImeSettings"]),
      switchIme: () => calls.onShot.push(["switchIme"]),
      drainShots: () => calls.onShot.push(["drainShots"]),
    },
  };
}

console.log("\n配置快照\n");

await test("快照只含四个必要字段", async () => {
  const { host } = makeHost();
  global.window = { DshImeHost: host };
  const ime = await import("../scripts/ime.js");
  const cfg = ime.imeConfigSnapshot();
  const keys = Object.keys(cfg);
  const allowed = ["baseUrl", "apiKey", "apiModel", "temperature", "updatedAt"];
  keys.forEach((k) => {
    assert.ok(allowed.includes(k), `不该有字段 ${k}`);
  });
});

await test("快照不含任何会话内容", async () => {
  const { host } = makeHost();
  global.window = { DshImeHost: host };
  const ime = await import("../scripts/ime.js");
  const json = JSON.stringify(ime.imeConfigSnapshot());
  assert.ok(!/messages|sessions|history/i.test(json), "快照里不该出现会话字段");
});

await test("推快照走原生桥", async () => {
  const { host, calls } = makeHost();
  global.window = { DshImeHost: host };
  const ime = await import("../scripts/ime.js");
  ime.pushImeConfig();
  assert.strictEqual(calls.setConfig.length, 1);
  const parsed = JSON.parse(calls.setConfig[0]);
  assert.ok(parsed && typeof parsed === "object");
});

await test("没有原生桥时不抛错", async () => {
  global.window = { DshImeHost: null };
  const ime = await import("../scripts/ime.js");
  ime.pushImeConfig();
  const st = ime.imeStatus();
  assert.strictEqual(st.supported, false);
  assert.strictEqual(st.enabled, false);
});

console.log("\n截图投递\n");

await test("截图变成附件", async () => {
  const { host } = makeHost();
  global.window = { DshImeHost: host };
  const ime = await import("../scripts/ime.js");
  let got = null;
  global.window.__dshAddAttachment = (item) => {
    got = item;
    return true;
  };
  const ok = ime.receiveImeShot({
    path: "/data/workspace/uploads/ime-1.png",
    name: "ime-1.png",
    size: 1234,
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(got.path, "/data/workspace/uploads/ime-1.png");
  assert.strictEqual(got.area, "workspace");
  assert.strictEqual(got.size, 1234);
});

await test("没有路径的截图被忽略", async () => {
  const { host } = makeHost();
  global.window = { DshImeHost: host };
  const ime = await import("../scripts/ime.js");
  global.window.__dshAddAttachment = () => {
    throw new Error("不该走到这里");
  };
  assert.strictEqual(ime.receiveImeShot({ name: "x.png" }), false);
  assert.strictEqual(ime.receiveImeShot(null), false);
});

await test("页面钩子缺失时不崩", async () => {
  const { host } = makeHost();
  global.window = { DshImeHost: host };
  const ime = await import("../scripts/ime.js");
  delete global.window.__dshAddAttachment;
  assert.strictEqual(ime.receiveImeShot({ path: "/x.png" }), false);
});

console.log("\n状态与短语\n");

await test("状态能解析", async () => {
  const { host } = makeHost({ status: { enabled: true, current: false, serviceId: "a.b.C" } });
  global.window = { DshImeHost: host };
  const ime = await import("../scripts/ime.js");
  const st = ime.imeStatus();
  assert.strictEqual(st.supported, true);
  assert.strictEqual(st.enabled, true);
  assert.strictEqual(st.current, false);
});

await test("短语能读写", async () => {
  const { host, calls } = makeHost({ phrases: [{ id: "p1", text: "我的邮箱" }] });
  global.window = { DshImeHost: host };
  const ime = await import("../scripts/ime.js");
  const list = ime.listPhrases();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].text, "我的邮箱");
  ime.savePhrase({ text: "abc" });
  ime.deletePhrase("p1");
  assert.deepStrictEqual(
    calls.onShot.map((c) => c[0]),
    ["savePhrase", "deletePhrase"]
  );
});

console.log("\n安装接线\n");

await test("安装后注册截图入口并通知原生 ready", async () => {
  const { host, calls } = makeHost();
  global.window = { DshImeHost: host, addEventListener: () => {} };
  const ime = await import("../scripts/ime.js");
  ime.installImeHost();
  assert.strictEqual(typeof global.window.__dshImeShot, "function");
  assert.strictEqual(calls.ready, 1);
  // 原生推一条 JSON 过来，应该不炸
  global.window.__dshImeShot(JSON.stringify({ path: "/x.png" }));
});

console.log(`\n${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
