/* ============================================================
   语音状态机看门狗（0.34.4）

   守的是一条会让语音输入**彻底卡死**的链路：
     start() 成功但 onReadyForSpeech 不来 → 停在 starting
     点停止 → 进 finishing → onResults/onError 都不来 → 永远等 end
     再点麦克风 → stopVoice()（空操作）→ 还是等 end → 只能杀进程

   看门狗的作用：每个状态都有最长存活时间，超时强制收尾。
   ============================================================ */

/* ---------- 先搭一个假的 window.DshSpeech，再 import ---------- */

const calls = [];
globalThis.window = {
  DshSpeech: {
    isAvailable: () => true,
    hasPermission: () => true,
    start: (lang) => calls.push(["start", lang]),
    stop: () => calls.push(["stop"]),
    cancel: () => calls.push(["cancel"]),
    requestPermission: () => calls.push(["requestPermission"]),
  },
};

const v = await import("../scripts/voice.js");

/** 模拟原生侧发事件。 */
function nativeEvent(obj) {
  globalThis.window.__dshSpeechEvent(obj);
}

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass += 1;
    console.log(`✓ ${name}${extra ? " " + extra : ""}`);
  } else {
    fail += 1;
    console.log(`✗ ${name}${extra ? " " + extra : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================
   一、正常流程
   ============================================================ */

const events = [];
const off = v.onVoiceEvent((e) => events.push(e));

calls.length = 0;
const started = v.startVoice({ lang: "zh-CN" });
check("正常：startVoice 成功", started.ok === true);
check("正常：调了原生 start", calls.some((c) => c[0] === "start"));
check("正常：进入 starting", v.voiceState() === "starting", v.voiceState());

nativeEvent({ type: "ready" });
check("正常：ready 后进入 listening", v.voiceState() === "listening", v.voiceState());

nativeEvent({ type: "partial", text: "你好" });
check("正常：partial 有转发", events.some((e) => e.type === "partial" && e.text === "你好"));

nativeEvent({ type: "final", text: "你好世界" });
check("正常：final 后进入 finishing", v.voiceState() === "finishing", v.voiceState());

nativeEvent({ type: "end", reason: "silence" });
check("正常：end 后回到 idle", v.voiceState() === "idle", v.voiceState());
check("正常：final 文本已交付", events.some((e) => e.type === "final" && e.text === "你好世界"));

/* ============================================================
   二、核心：starting 卡住要能自愈
   ============================================================ */

events.length = 0;
calls.length = 0;
v.startVoice({ lang: "zh-CN" });
check("卡住：已进入 starting", v.voiceState() === "starting");

// 原生侧**什么都不发** —— 复现 onReadyForSpeech 丢失
await sleep(5400);
check("卡住：starting 超时后自动回到 idle", v.voiceState() === "idle", v.voiceState());
check(
  "卡住：给了人话提示（不是静默失败）",
  events.some((e) => e.type === "error" && e.code === "start_timeout"),
  JSON.stringify(events.filter((e) => e.type === "error"))
);
check("卡住：顺手取消了原生那次启动（别占着麦克风）", calls.some((c) => c[0] === "cancel"));

/* ============================================================
   三、finishing 卡住：点麦克风必须能重开
   ============================================================ */

events.length = 0;
calls.length = 0;
v.startVoice({ lang: "zh-CN" });
nativeEvent({ type: "ready" });
nativeEvent({ type: "final", text: "说完这句就没下文了" });
check("卡住：已进入 finishing", v.voiceState() === "finishing");

// 原生侧不发 end。用户又点了一下麦克风 —— 应该直接重开，而不是再等
const restart = v.startVoice({ lang: "zh-CN" });
check("卡住：finishing 时点麦克风能重开", restart.ok === true);
check(
  "卡住：重开后确实重新在启动（不是停在 finishing）",
  v.voiceState() === "starting",
  v.voiceState()
);
check("卡住：重开前取消了上一次", calls.some((c) => c[0] === "cancel"));
check(
  "卡住：重开会发一次 end(restart)，UI 不会一直挂着录音条",
  events.some((e) => e.type === "end" && e.reason === "restart")
);

// 收尾
v.cancelVoice();
await sleep(100);

/* ============================================================
   四、事件还活着时不能误判超时
   ============================================================ */

events.length = 0;
v.startVoice({ lang: "zh-CN" });
nativeEvent({ type: "ready" });
// 在 starting 超时窗口内连续发事件，看门狗应被不断重置
for (let i = 0; i < 4; i += 1) {
  await sleep(1500);
  nativeEvent({ type: "partial", text: `第 ${i} 段` });
}
check(
  "误判：持续有事件时不会被判超时",
  v.voiceState() === "listening",
  v.voiceState()
);
check("误判：没有误报 start_timeout", !events.some((e) => e.type === "error" && e.code === "start_timeout"));

v.cancelVoice();

/* ============================================================
   四之二、语音自检（voiceDiagnose）
   ============================================================ */

// 正常情况下：服务在、权限有
globalThis.window.DshSpeech.diagnose = () =>
  JSON.stringify({
    available: true,
    permission: true,
    services: ["com.google.android.googlequicksearchbox"],
    serviceCount: 1,
    api: 34,
  });
const dOk = v.voiceDiagnose();
check("自检：可用 + 有权限", dOk.available === true && dOk.permission === true);
check("自检：带出服务包名", dOk.services.length === 1 && /google/.test(dOk.services[0]), dOk.services.join(","));
check("自检：带出 API 级别", dOk.api === 34);

// 设备没有识别服务（国产 ROM 常见）
globalThis.window.DshSpeech.diagnose = () =>
  JSON.stringify({ available: false, permission: true, services: [], serviceCount: 0, api: 33 });
const dNone = v.voiceDiagnose();
check("自检：没有服务时 serviceCount 为 0", dNone.serviceCount === 0 && dNone.services.length === 0);
check("自检：没有服务时 available 为 false", dNone.available === false);

// 权限被拒
globalThis.window.DshSpeech.diagnose = () =>
  JSON.stringify({ available: true, permission: false, services: ["x"], serviceCount: 1, api: 34 });
const dPerm = v.voiceDiagnose();
check("自检：权限被拒能分辨出来", dPerm.available === true && dPerm.permission === false);

// 老版本 APK：桥里没有 diagnose
delete globalThis.window.DshSpeech.diagnose;
const dOld = v.voiceDiagnose();
check("自检：旧桥没有 diagnose 也不崩", dOld.native === true && Array.isArray(dOld.services));

// 桥返回垃圾
globalThis.window.DshSpeech.diagnose = () => "not json";
const dBad = v.voiceDiagnose();
check("自检：返回非 JSON 时不抛异常", !!dBad.error && dBad.available === false);

// 完全没有原生桥
const savedBridge = globalThis.window.DshSpeech;
delete globalThis.window.DshSpeech;
const dWeb = v.voiceDiagnose();
check("自检：没有原生桥时 native=false", dWeb.native === false);
globalThis.window.DshSpeech = savedBridge;

/* ============================================================
   五、源码契约
   ============================================================ */

const fs = await import("node:fs/promises");
const src = await fs.readFile(new URL("../scripts/voice.js", import.meta.url), "utf8");

check("契约：有看门狗表", /WATCHDOG_MS/.test(src));
check("契约：starting 有超时", /starting: 5000/.test(src));
check("契约：finishing 有超时", /finishing: 10000/.test(src));
check("契约：每个事件都重置计时", /touchWatchdog\(\)/.test(src));
check("契约：finishing 时 startVoice 走重开", /state === "finishing"[\s\S]{0,600}forceReset/.test(src));
check("契约：forceReset 不依赖原生回调", /function forceReset/.test(src));

const speechJava = await fs.readFile(
  new URL("../android/java/DshSpeechBridge.java", import.meta.url),
  "utf8"
);
check("契约：原生侧有 diagnose 接口", /public String diagnose\(\)/.test(speechJava));
check("契约：诊断会列出识别服务包名", /queryIntentServices/.test(speechJava));
check("契约：诊断暴露 API 级别", /Build\.VERSION\.SDK_INT/.test(speechJava));

const screensSrc = await fs.readFile(new URL("../scripts/screens.js", import.meta.url), "utf8");
check("契约：设置页有语音自检分组", /语音输入/.test(screensSrc) && /voiceDiagnose/.test(screensSrc));

off();
console.log("");
if (fail) {
  console.log(`✗ ${fail} 项失败（通过 ${pass}）`);
  process.exit(1);
} else {
  console.log(`全部通过（${pass} 项）`);
}
process.exit(fail ? 1 : 0);
