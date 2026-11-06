/**
 * 手写引擎加载失败与重试
 *
 * ============ 为什么专门测"失败" ============
 *
 * 0.57.0 的失败提示是「识别引擎加载失败：Failed to fetch dynamically
 * imported module: https://localhost/ime/vendor/ort/ort.wasm.min.mjs」——
 * 用户看到的东西既没有中文解释，也没有任何可点的动作，
 * 只能关掉键盘重开，还不知道重开有没有用。
 *
 * 现在要求三件事，缺一不可：
 *   1. 原因说人话（"模型文件缺失"而不是 "Can't create session"）
 *   2. 旁边有个「重试」，点一下能原地恢复
 *   3. 重试成功后提示消失，按钮不留残影
 *
 * 服务端的 MIME 表照样用真机那张（见 android-serve.mjs），
 * 否则这里又会变成"测试环境比真机宽松"的老问题。
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { loadAndroidMime } from "./android-serve.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const androidMime = await loadAndroidMime();

/** 让某几个路径临时 404，模拟安装包缺文件 */
const blocked = new Set();

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/ime/keyboard.html";
    if (p === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if ([...blocked].some((b) => p.endsWith(b))) {
      // 404 默认可以被启发式缓存，那样"补上文件再重试"永远拿到旧的 404
      res.writeHead(404, { "cache-control": "no-store" });
      res.end("nf");
      return;
    }
    const f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    const b = await readFile(f);
    res.writeHead(200, { "content-type": androidMime.mimeFor(f), "cache-control": "no-store" });
    res.end(b);
  } catch {
    res.writeHead(404);
    res.end("nf");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

async function openKb() {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 290 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => {
    window.__calls = [];
    window.DshIme = {
      commit: (t) => window.__calls.push(["commit", String(t)]),
      deleteBackward: () => window.__calls.push(["delete", 1]),
      vibrate: () => {},
      ready: () => window.__calls.push(["ready"]),
      getContext: () => JSON.stringify({ inputType: "text", isPassword: false, hasSelection: false, multiline: false, canRead: true }),
      getConfig: () => JSON.stringify({}),
      listPhrases: () => "[]",
      listClipboard: () => "[]",
      getLearned: () => "{}",
      setLearned: () => {},
    };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/ime/keyboard.html`, { waitUntil: "load" });
  await page.waitForTimeout(700);
  await page.click('.tool[data-tool="hand"]');
  return { ctx, page, errors };
}

async function waitStatus(page, want, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await page.evaluate(() => window.__dshHandwrite?._debug().status);
    if (s === want) return s;
    await page.waitForTimeout(200);
  }
  return page.evaluate(() => window.__dshHandwrite?._debug().status);
}

const hintOf = (page) => page.evaluate(() => {
  const el = document.querySelector(".hw__hint");
  return {
    hidden: !el || el.hidden,
    text: el?.querySelector(".hw__hint-txt")?.textContent ?? el?.textContent ?? "",
    title: el?.querySelector(".hw__hint-txt")?.title ?? "",
    retry: el?.querySelector(".hw__retry")?.textContent ?? "",
    retries: document.querySelectorAll(".hw__retry").length,
  };
});

/* ---------------- 1. 字典缺失 ---------------- */

console.log("\n字典缺失\n");

blocked.add("/ppocrv5-dict.txt");
{
  const { ctx, page } = await openKb();
  const s = await waitStatus(page, "error");
  check("缺字典 → 进入 error", s === "error", `status=${s}`);
  const h = await hintOf(page);
  console.log("  提示：", h.text);
  check("提示是中文原因，不是英文异常", /字典/.test(h.text) && !/Failed to fetch/i.test(h.text), h.text);
  check("提示带「重试」", h.retry === "重试");
  check("只有一颗「重试」", h.retries === 1);
  check("长提示能看全文（title）", h.title.length >= h.text.length && h.title.length > 0);
  await ctx.close();
}

/* ---------------- 2. 模型缺失 → 补上后重试 ---------------- */

console.log("\n模型缺失后重试\n");

blocked.clear();
blocked.add("/ppocrv5.ort");
{
  const { ctx, page, errors } = await openKb();
  const s1 = await waitStatus(page, "error");
  check("缺模型 → 进入 error", s1 === "error", `status=${s1}`);
  const h1 = await hintOf(page);
  console.log("  提示：", h1.text);
  check("提示指向模型文件", /模型/.test(h1.text), h1.text);
  check("错误态有「重试」", h1.retry === "重试");

  // 补上文件，点重试
  blocked.clear();
  await page.click(".hw__retry");
  const s2 = await waitStatus(page, "ready", 60000);
  check("点「重试」后加载成功", s2 === "ready", `status=${s2}`);
  const h2 = await hintOf(page);
  check("成功后提示消失", h2.hidden || h2.text === "", JSON.stringify(h2));
  check("成功后不留「重试」按钮", h2.retries === 0, `retries=${h2.retries}`);

  // 重试成功之后必须真能认字，否则"恢复"只是假象
  const cands = await page.evaluate(async () => {
    const s = [[[100, 500], [900, 500]]];
    const r = await window.__dshHandwrite.recognize(s);
    return r.map((x) => x.char);
  });
  check("恢复后能识别（横线→一）", cands[0] === "一", JSON.stringify(cands.slice(0, 4)));
  check("全程无页面错误", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

/* ---------------- 3. 反复失败不叠按钮 ---------------- */

console.log("\n反复失败\n");

blocked.clear();
blocked.add("/ppocrv5.ort");
blocked.add("/ppocrv5-dict.txt");
{
  const { ctx, page } = await openKb();
  await waitStatus(page, "error");
  for (let i = 0; i < 3; i += 1) {
    await page.click(".hw__retry").catch(() => {});
    await page.waitForTimeout(400);
  }
  const h = await hintOf(page);
  check("连点三次「重试」没有堆出多个按钮", h.retries === 1, `retries=${h.retries}`);
  check("仍然停在 error，不是在转圈", (await waitStatus(page, "error", 5000)) === "error");
  await ctx.close();
}

await browser.close();
server.close();

console.log(failed ? `\n${failed} 项失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
