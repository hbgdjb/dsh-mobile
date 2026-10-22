/**
 * 语音输入测试。
 *
 * 这一轮的 bug 是：Android WebView 里根本没有 Web Speech API，
 * 而旧实现只认 Web Speech API —— 于是 APK 里点麦克风永远弹
 * 「此设备不支持语音输入」，功能等于不存在。
 *
 * 所以这里测的不是「能不能识别」（那要真麦克风），
 * 而是**这套链路在三种环境下各自的行为是否正确**：
 *
 *   A. 有原生桥（模拟 Android）→ 走原生、状态机对、事件能驱动 UI
 *   B. 无原生桥、有 Web Speech（桌面浏览器）→ 回退
 *   C. 两者都没有 → 明确告知不可用，而不是静默失败
 *
 * 用法：node tests/voice-test.mjs
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass += 1;
    console.log(`✓ ${name} ${extra}`);
  } else {
    fail += 1;
    console.log(`✗ ${name} ${extra}`);
  }
}

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("nf");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

/* ============================================================
   A. 有原生桥：模拟 Android 的行为
   ============================================================ */

{
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
  let pageErr = 0;
  page.on("pageerror", (e) => {
    pageErr += 1;
    console.log("  [pageerror]", e.message);
  });

  // 在任何页面脚本之前装一个假的原生桥，
  // 并把 Web Speech API 删掉 —— 这才是 Android WebView 的真实处境。
  await page.addInitScript(() => {
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;

    const calls = [];
    window.__calls = calls;
    window.__nativeAvailable = true;
    window.__hasPerm = false;

    window.DshSpeech = {
      isAvailable: () => window.__nativeAvailable,
      hasPermission: () => window.__hasPerm,
      requestPermission: () => calls.push(["requestPermission"]),
      start: (lang) => {
        calls.push(["start", lang]);
        // 模拟原生侧：先 ready，再来两段 partial，最后一句话
        setTimeout(() => {
          window.__hasPerm = true;
          window.__dshSpeechEvent({ type: "permission", granted: true });
          window.__dshSpeechEvent({ type: "ready" });
        }, 20);
        setTimeout(() => window.__dshSpeechEvent({ type: "volume", rms: 6 }), 40);
        setTimeout(() => window.__dshSpeechEvent({ type: "partial", text: "帮我写" }), 60);
        setTimeout(() => window.__dshSpeechEvent({ type: "partial", text: "帮我写一份周报" }), 80);
        setTimeout(() => window.__dshSpeechEvent({ type: "final", text: "帮我写一份周报" }), 100);
        setTimeout(() => window.__dshSpeechEvent({ type: "end", reason: "silence" }), 120);
      },
      stop: () => calls.push(["stop"]),
      cancel: () => {
        calls.push(["cancel"]);
        setTimeout(() => window.__dshSpeechEvent({ type: "end", reason: "cancel" }), 10);
      },
    };
  });

  await page.goto(base + "/index.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);

  /* --- 能力探测 --- */
  const probe = await page.evaluate(async () => {
    const v = await import("/scripts/voice.js");
    return {
      available: v.voiceAvailable(),
      perm: v.voicePermission(),
      state: v.voiceState(),
      hasWebSpeech: typeof window.webkitSpeechRecognition !== "undefined",
    };
  });
  check("Android 场景：Web Speech 不存在（复现真实环境）", probe.hasWebSpeech === false);
  check("有原生桥时判定为可用", probe.available === true);
  check("初始状态是 idle", probe.state === "idle");
  check("未授权时 voicePermission 为 false", probe.perm === false);

  /* --- 开始识别 → 触发原生 start --- */
  const started = await page.evaluate(async () => {
    const v = await import("/scripts/voice.js");
    const r = v.startVoice({ lang: "zh-CN" });
    return { ok: r.ok, state: v.voiceState(), calls: window.__calls.slice() };
  });
  check("startVoice 返回成功", started.ok === true);
  check("立刻进入 starting 状态", started.state === "starting", started.state);
  const startCall = started.calls.find((c) => c[0] === "start");
  check("调用了原生 start，并带上语言", !!startCall && startCall[1] === "zh-CN", JSON.stringify(startCall));

  /* --- 等事件流跑完，检查状态与文本 --- */
  await page.waitForTimeout(400);

  const afterEvents = await page.evaluate(() => {
    const el = document.querySelector("#composer-input");
    return {
      value: el?.value || "",
      state: window.__dshSpeechState || "",
    };
  });
  check("最终文本写进了输入框", afterEvents.value === "帮我写一份周报", JSON.stringify(afterEvents.value));

  const idleAgain = await page.evaluate(async () => {
    const v = await import("/scripts/voice.js");
    return v.voiceState();
  });
  check("结束后回到 idle", idleAgain === "idle", idleAgain);

  /* --- 录音条 UI --- */
  // 重新跑一次，这次在 partial 阶段停下看 UI
  const uiCheck = await page.evaluate(async () => {
    const v = await import("/scripts/voice.js");
    document.querySelector("#composer-input").value = "";
    v.startVoice({ lang: "zh-CN" });
    await new Promise((r) => setTimeout(r, 70));
    const strip = document.querySelector("#voice-strip");
    const btn = document.querySelector("#voice-btn");
    const txt = document.querySelector("#voice-text");
    return {
      stripHidden: strip ? strip.hidden : null,
      hasStrip: !!strip,
      micLive: btn ? btn.classList.contains("is-live") : null,
      ariaPressed: btn ? btn.getAttribute("aria-pressed") : null,
      text: txt ? txt.textContent : "",
      hasCancel: !!document.querySelector('[data-act="voice-cancel"]'),
      hasStop: !!document.querySelector('[data-act="voice-stop"]'),
    };
  });
  check("录音条存在", uiCheck.hasStrip === true);
  check("录音中录音条可见", uiCheck.stripHidden === false);
  check("麦克风按钮进入录音态", uiCheck.micLive === true);
  check("麦克风按钮 aria-pressed=true", uiCheck.ariaPressed === "true", uiCheck.ariaPressed);
  check("录音条显示实时转写", /帮我写/.test(uiCheck.text), uiCheck.text);
  check("有取消按钮", uiCheck.hasCancel === true);
  check("有结束按钮", uiCheck.hasStop === true);

  await page.waitForTimeout(300);
  const uiAfter = await page.evaluate(() => {
    const strip = document.querySelector("#voice-strip");
    const btn = document.querySelector("#voice-btn");
    return {
      stripHidden: strip ? strip.hidden : null,
      micLive: btn ? btn.classList.contains("is-live") : null,
      value: document.querySelector("#composer-input")?.value || "",
    };
  });
  check("结束后录音条自动收起", uiAfter.stripHidden === true);
  check("结束后麦克风按钮恢复", uiAfter.micLive === false);
  check("结束后文本已落进输入框", uiAfter.value === "帮我写一份周报", uiAfter.value);

  /* --- 追加而不是覆盖 --- */
  const append = await page.evaluate(async () => {
    const v = await import("/scripts/voice.js");
    const el = document.querySelector("#composer-input");
    el.value = "已经有的字";
    window.__calls.length = 0;
    v.startVoice({ lang: "zh-CN" });
    await new Promise((r) => setTimeout(r, 300));
    return el.value;
  });
  check("已有文字时是追加、不是覆盖", append === "已经有的字帮我写一份周报", JSON.stringify(append));

  /* --- 再次点击 = 停止 --- */
  const toggle = await page.evaluate(async () => {
    const v = await import("/scripts/voice.js");
    v.startVoice({ lang: "zh-CN" });
    const before = v.voiceState();
    // 立刻再点一次（模拟 UI 的 toggle 行为）
    v.stopVoice();
    return { before, calls: window.__calls.slice() };
  });
  check("识别中调用 stopVoice 会走原生 stop", toggle.calls.some((c) => c[0] === "stop"), JSON.stringify(toggle.calls));

  await page.waitForTimeout(200);

  /* --- 取消 --- */
  const cancelled = await page.evaluate(async () => {
    const v = await import("/scripts/voice.js");
    const el = document.querySelector("#composer-input");
    el.value = "不该被改";
    window.__calls.length = 0;
    v.startVoice({ lang: "zh-CN" });
    v.cancelVoice();
    await new Promise((r) => setTimeout(r, 250));
    return { value: el.value, state: v.voiceState(), calls: window.__calls.slice() };
  });
  check("取消会调原生 cancel", cancelled.calls.some((c) => c[0] === "cancel"), JSON.stringify(cancelled.calls));
  check("取消后输入框不被写入", cancelled.value === "不该被改", JSON.stringify(cancelled.value));
  check("取消后回到 idle", cancelled.state === "idle");

  /* --- 错误：没听清不应该当故障 --- */
  const errCase = await page.evaluate(async () => {
    const v = await import("/scripts/voice.js");
    window.__dshSpeechEvent({ type: "error", code: "no_match", message: "没听清，再说一次" });
    window.__dshSpeechEvent({ type: "end", reason: "error" });
    await new Promise((r) => setTimeout(r, 60));
    return v.voiceState();
  });
  check("错误事件不会让状态卡在中间态", errCase === "idle", errCase);

  /* --- 原生说没有服务 --- */
  const noService = await page.evaluate(async () => {
    window.__nativeAvailable = false;
    const v = await import("/scripts/voice.js");
    const r = v.startVoice({ lang: "zh-CN" });
    window.__nativeAvailable = true;
    return { ok: r.ok, reason: r.reason, state: v.voiceState() };
  });
  check("原生判定不可用时拒绝启动", noService.ok === false);
  check("拒绝原因说明是没有语音服务", noService.reason === "no-service", noService.reason);
  check("拒绝后状态仍是 idle", noService.state === "idle");

  /* --- 重渲染后录音条不丢 --- */
  //
  // 对话页每次更新都会重建 composer，录音条与麦克风按钮是全新节点。
  // 不重新贴状态的话，会出现「还在录音、界面上却什么都没了」——
  // 用户会以为坏了，再点一次反而把识别停了。
  const resync = await page.evaluate(async () => {
    const v = await import("/scripts/voice.js");
    const ui = await import("/scripts/ui.js");
    document.querySelector("#composer-input").value = "";
    v.startVoice({ lang: "zh-CN" });
    await new Promise((r) => setTimeout(r, 50));
    // 模拟一次普通重渲染（发消息、切会话都会走到这里）
    ui.renderAll(true);
    await new Promise((r) => setTimeout(r, 60));
    const strip = document.querySelector("#voice-strip");
    const btn = document.querySelector("#voice-btn");
    return {
      stripHidden: strip ? strip.hidden : null,
      micLive: btn ? btn.classList.contains("is-live") : null,
    };
  });
  check("重渲染后录音条仍然可见", resync.stripHidden === false);
  check("重渲染后麦克风仍是录音态", resync.micLive === true);
  await page.waitForTimeout(300);

  check("无未捕获异常", pageErr === 0, `${pageErr} 个`);

  await page.close();
}

/* ============================================================
   B. 没有原生桥、也没有 Web Speech：必须明确说清不可用
   ============================================================ */

{
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
  await page.addInitScript(() => {
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;
  });
  await page.goto(base + "/index.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(700);

  const res = await page.evaluate(async () => {
    const v = await import("/scripts/voice.js");
    const r = v.startVoice({ lang: "zh-CN" });
    return { available: v.voiceAvailable(), ok: r.ok, reason: r.reason, state: v.voiceState() };
  });
  check("两者都没有时：判定不可用", res.available === false);
  check("两者都没有时：拒绝启动并给出原因", res.ok === false && res.reason === "no-api", JSON.stringify(res));
  check("两者都没有时：不会卡在中间态", res.state === "idle");

  await page.close();
}

/* ============================================================
   C. 桌面浏览器回退：有 Web Speech 时走它
   ============================================================ */

{
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
  await page.addInitScript(() => {
    // 没有原生桥，但谎称有 Web Speech（模拟桌面 Chrome 的 API 形状）
    class FakeSR {
      constructor() {
        window.__fakeSR = this;
        this.started = false;
      }
      start() {
        this.started = true;
        setTimeout(() => this.onstart?.(), 10);
        setTimeout(() => {
          // 形状要对齐真实的 SpeechRecognitionEvent：
          // results 是可索引、有 length 的列表，第 0 项本身是「结果」，
          // 带 isFinal 且可索引到 alternative（有 transcript）。
          const alt = [{ transcript: "桌面浏览器的话" }];
          const result = Object.assign([{ transcript: "桌面浏览器的话" }], {
            isFinal: true,
            length: 1,
          });
          const results = Object.assign([result], { length: 1 });
          this.onresult?.({ resultIndex: 0, results });
        }, 40);
        setTimeout(() => this.onend?.(), 70);
      }
      stop() {
        this.onend?.();
      }
      abort() {
        this.onend?.();
      }
    }
    // Chromium 自带真的 SpeechRecognition（只是没权限直接报 not-allowed），
    // 两个名字都要覆盖，否则跑的是真实现，测不到回退逻辑。
    window.SpeechRecognition = FakeSR;
    window.webkitSpeechRecognition = FakeSR;
  });
  await page.goto(base + "/index.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(700);

  const res = await page.evaluate(async () => {
    const v = await import("/scripts/voice.js");
    const el = document.querySelector("#composer-input");
    el.value = "";
    const available = v.voiceAvailable();
    const r = v.startVoice({ lang: "zh-CN" });
    await new Promise((x) => setTimeout(x, 250));
    return { available, ok: r.ok, value: el.value, state: v.voiceState() };
  });
  check("有 Web Speech 时判定可用", res.available === true);
  check("Web Speech 回退能启动", res.ok === true);
  check("Web Speech 结果写进输入框", res.value === "桌面浏览器的话", JSON.stringify(res.value));
  check("Web Speech 结束后回到 idle", res.state === "idle", res.state);

  await page.close();
}

await browser.close();
server.close();

console.log("");
console.log(fail === 0 ? `✓ 全部通过（${pass} 项）` : `✗ ${fail} 项失败（共 ${pass + fail} 项）`);
process.exit(fail === 0 ? 0 : 1);
