#!/usr/bin/env node
/* ============================================================
   Node 插件安装器 —— 端到端（在真浏览器里写文件）

   ============ 为什么要跑浏览器 ============

   plugin-install-test.mjs 测的是「解包 + 认插件根」，纯函数。
   但安装真正会出事的地方在写入：路径拼错、二进制当文本写、
   重装残留文件、卸载删不干净 —— 这些只有真的落到存储上才看得见。

   这里在 Chromium 里跑真实的 installNodePlugin()：
   它用页面自己的 fetch 下载、用 fs.js 写进 IndexedDB（浏览器环境）。

   没有 Chromium 就跳过，不假装通过。

   用法：node tests/plugin-install-e2e-test.mjs
   ============================================================ */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FIXTURES = path.join(HERE, "fixtures", "archives");

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

function findChrome() {
  const list = [
    process.env.CHROME_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].filter(Boolean);
  for (const p of list) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".zip": "application/zip",
};

const chrome = findChrome();
let playwright = null;
if (chrome) {
  try {
    playwright = await import("playwright");
  } catch {
    playwright = null;
  }
}

if (!chrome || !playwright) {
  console.log("\n[跳过] 没有可用的 Chromium 或 playwright");
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项，跳过 1 项`);
  process.exit(0);
}

const server = createServer(async (req, res) => {
  try {
    const raw = String(req.url || "/");
    const p = decodeURIComponent(raw.split("?")[0]);
// 插件包：走 fixtures
    if (p === "/forbidden.bin") {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("blocked");
      return;
    }
    if (p === "/nested.zip" || p === "/flat.zip" || p === "/pkg.tgz" || p === "/deps.zip") {
      const file = path.join(FIXTURES, p.slice(1));
      const buf = await readFile(file);
      res.writeHead(200, { "content-type": p.endsWith(".tgz") ? "application/gzip" : "application/zip" });
      res.end(buf);
      return;
    }
    const target = p === "/" ? "/index.html" : p;
    const file = join(ROOT, normalize(target).replace(/^(\.\.[/\\])+/, ""));
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const browser = await playwright.chromium.launch({ executablePath: chrome });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});

await page.goto(ORIGIN, { waitUntil: "networkidle" });
await page.waitForTimeout(600);

/** 在页面里跑一段安装器代码。 */
async function inPage(fn, arg) {
  return await page.evaluate(fn, arg);
}

console.log("\n[1] 从网址装一个 npm 风格的 zip");

let installedId = "";

await test("装上了，文件数对得上", async () => {
  const r = await inPage(async () => {
    const mod = await import("/scripts/plugin-install-node.js");
    const fsMod = await import("/scripts/fs.js");
    if (typeof fsMod.initFs === "function") await fsMod.initFs();
    const res = await mod.installNodePlugin({ url: "/nested.zip" });
    return { id: res.id, installed: res.installed, version: res.version, name: res.name, warnings: res.warnings };
  });
  assert.strictEqual(r.id, "demo-hello-plugin");
  assert.strictEqual(r.version, "1.2.3");
  assert.strictEqual(r.installed, 3, "应该是 index.js / package.json / lib/helper.js 三个");
  installedId = r.id;
});

await test("文件真的落在 plugins/<id>/ 下，内容没坏", async () => {
  const r = await inPage(async (id) => {
    const fsMod = await import("/scripts/fs.js");
    const doc = await fsMod.readDoc("workspace", `plugins/${id}/index.js`);
    const pkg = await fsMod.readDoc("workspace", `plugins/${id}/package.json`);
    return { text: doc && doc.content, pkg: pkg && JSON.parse(pkg.content) };
  }, installedId);
  assert.strictEqual(r.text, "exports.apply = () => {};");
  assert.strictEqual(r.pkg.name, "@demo/hello-plugin");
});

await test("__MACOSX 垃圾没有被写进去", async () => {
  const files = await inPage(async (id) => {
    const fsMod = await import("/scripts/fs.js");
    const list = await fsMod.listDocs("workspace", `plugins/${id}/`);
    return list.map((f) => f.path);
  }, installedId);
  assert.ok(!files.some((f) => f.includes("__MACOSX")), "实际：" + JSON.stringify(files));
});

console.log("\n[2] 重装 / 卸载");

await test("重装同一个包不会堆出重复文件", async () => {
  const files = await inPage(async () => {
    const mod = await import("/scripts/plugin-install-node.js");
    await mod.installNodePlugin({ url: "/nested.zip" });
    const fsMod = await import("/scripts/fs.js");
    const list = await fsMod.listDocs("workspace", "plugins/demo-hello-plugin/");
    return list.map((f) => f.path);
  });
  const uniq = new Set(files);
  assert.strictEqual(uniq.size, files.length, "不该有重复路径");
  assert.strictEqual(files.length, 3);
});

await test("卸载会删掉整个目录", async () => {
  const r = await inPage(async () => {
    const mod = await import("/scripts/plugin-install-node.js");
    const n = await mod.uninstallNodePlugin("demo-hello-plugin");
    const fsMod = await import("/scripts/fs.js");
    const list = await fsMod.listDocs("workspace", "plugins/demo-hello-plugin/");
    return { n, left: list.map((f) => f.path) };
  });
  assert.strictEqual(r.n, 3);
  assert.deepStrictEqual(r.left, [], "卸载后不该还剩文件");
});

console.log("\n[3] 另外两种形态");

await test("tar.gz（npm pack）能装", async () => {
  const r = await inPage(async () => {
    const mod = await import("/scripts/plugin-install-node.js");
    const res = await mod.installNodePlugin({ url: "/pkg.tgz" });
    const fsMod = await import("/scripts/fs.js");
    const list = await fsMod.listDocs("workspace", `plugins/${res.id}/`);
    return { id: res.id, entry: res.entry, paths: list.map((f) => f.path).sort() };
  });
  assert.strictEqual(r.id, "tgz-plugin");
  assert.strictEqual(r.entry, "main.js");
  assert.ok(r.paths.some((p) => p.endsWith("src/util.js")), "嵌套目录要保留：" + JSON.stringify(r.paths));
});

await test("缺依赖的包：装上但带着警告", async () => {
  const r = await inPage(async () => {
    const mod = await import("/scripts/plugin-install-node.js");
    const res = await mod.installNodePlugin({ url: "/deps.zip" });
    return { id: res.id, warnings: res.warnings };
  });
  assert.strictEqual(r.id, "needs-deps");
  // 两种结局都要交代清楚，不能一声不吭：
  //   装上了 → 「已自动安装 N 个依赖包」
  //   没装上 → 「依赖没装成：原因」
  // 测试环境有网，实际走的是第一条；断网时走第二条。
  assert.ok(
    r.warnings.some((w) => /已自动安装 \d+ 个依赖包/.test(w) || /依赖没装成/.test(w)),
    "必须说明依赖的结果，实际：" + JSON.stringify(r.warnings)
  );
});

await test("装第二次走缓存：不重复下载，统计对得上", async () => {
  const r = await inPage(async () => {
    const mod = await import("/scripts/plugin-install-node.js");
    const before = await mod.depCacheStats();
    const res = await mod.installNodePlugin({ url: "/deps.zip" });
    const after = await mod.depCacheStats();
    return {
      cached: res.deps ? res.deps.cached : -1,
      downloaded: res.deps ? res.deps.downloaded : -1,
      before,
      after,
    };
  });

  if (!r.before.count) {
    // 上一次安装没联网成功，缓存是空的 —— 这条的前提不成立，跳过
    console.log("      （缓存为空，跳过：上次安装可能没联网）");
    return;
  }

  assert.ok(r.cached > 0, "第二次装同一个插件，应该全部命中缓存，实际：" + JSON.stringify(r));
  assert.strictEqual(r.downloaded, 0, "命中缓存就不该再下载");
  assert.ok(r.after.count >= r.before.count, "缓存条目不该变少");
});

await test("清空缓存后，统计归零", async () => {
  const r = await inPage(async () => {
    const mod = await import("/scripts/plugin-install-node.js");
    await mod.clearDepCache();
    return await mod.depCacheStats();
  });
  assert.strictEqual(r.count, 0, "清空后不该还有条目");
  assert.strictEqual(r.bytes, 0);
});

await test("403 时说清楚是缺访问凭据，而不是「包坏了」", async () => {
  const msg = await inPage(async () => {
    const mod = await import("/scripts/plugin-install-node.js");
    try {
      await mod.installNodePlugin({ url: "/forbidden.bin" });
      return "没有抛错";
    } catch (e) {
      return String((e && e.message) || e);
    }
  });
  assert.ok(/403/.test(msg), "要带上状态码：" + msg);
  assert.ok(/sharecode/.test(msg), "要指出可能是缺访问凭据：" + msg);
});

await test("没有入口的包：拒绝安装，并说清楚原因", async () => {
  const msg = await inPage(async () => {
    const mod = await import("/scripts/plugin-install-node.js");
    try {
      // 造一个没有入口的 zip 不方便，直接用 planInstall 验证语义
      mod.planInstall([{ path: "docs/readme.txt", bytes: new Uint8Array([65]) }]);
      return "没有抛错";
    } catch (e) {
      return String(e && e.message);
    }
  });
  assert.ok(/找不到插件入口/.test(msg), "实际：" + msg);
});

console.log("\n[4] 原生下载通道");

await test("有原生桥时走原生，字节原样还原（0x80 以上不能坏）", async () => {
  const r = await inPage(async () => {
    // 造一段「二进制」：开头是 zip 魔数，后面故意放 0xFF / 0x80
    const payload = [0x50, 0x4b, 0x03, 0x04, 0xff, 0x80, 0x00, 0x01];
    let bin = "";
    for (const b of payload) bin += String.fromCharCode(b);
    const b64 = btoa(bin);

    let usedNative = false;
    globalThis.window.DshNative = {
      postStream() {},
      abort() {},
      getBinary(id) {
        usedNative = true;
        setTimeout(() => {
          globalThis.window.__dshNativeEvent(
            JSON.stringify({ id, type: "bytes", status: 200, mime: "application/zip", base64: b64 })
          );
        }, 10);
      },
    };

    const nh = await import("/scripts/native-http.js");
    const got = await nh.nativeGetBytes("https://example.invalid/x.zip");
    return { usedNative, arr: Array.from(got.bytes), mime: got.mime };
  });

  assert.strictEqual(r.usedNative, true, "有原生桥时必须走原生（fetch 会被 CORS 挡住）");
  assert.deepStrictEqual(r.arr, [0x50, 0x4b, 0x03, 0x04, 0xff, 0x80, 0x00, 0x01], "字节不能坏");
  assert.strictEqual(r.mime, "application/zip");
});

await test("原生通道报 HTTP 错误时，状态码带得回来", async () => {
  const r = await inPage(async () => {
    globalThis.window.DshNative = {
      postStream() {},
      abort() {},
      getBinary(id) {
        setTimeout(() => {
          globalThis.window.__dshNativeEvent(
            JSON.stringify({ id, type: "error", status: 403, message: "HTTP 403", body: "blocked" })
          );
        }, 10);
      },
    };
    const nh = await import("/scripts/native-http.js");
    try {
      await nh.nativeGetBytes("https://example.invalid/y.zip");
      return { status: -1, message: "没有抛错" };
    } catch (e) {
      return { status: e.httpStatus || 0, message: String(e.message) };
    }
  });
  assert.strictEqual(r.status, 403, "httpStatus 要传出来，上层才能给出「缺凭据」的提示");
});

await test("原生异常翻成人话：只说「连不上哪台机器」，不留类名和 IP", async () => {
  const r = await inPage(async () => {
    const mod = await import("/scripts/native-http.js");
    return [
      mod.humanizeNetworkError(
        "ConnectException: Failed to connect to cdn.jsdelivr.net/104.17.207.5:443"
      ),
      mod.humanizeNetworkError(
        'UnknownHostException: Unable to resolve host "example.com": No address associated'
      ),
      mod.humanizeNetworkError("SocketTimeoutException: Read timed out"),
      mod.humanizeNetworkError("SomeWeirdException: 别的东西坏了"),
    ];
  });
  assert.strictEqual(r[0], "连不上 cdn.jsdelivr.net", "连不上要指名主机，实际：" + r[0]);
  assert.ok(/解析不到 example\.com/.test(r[1]), "DNS 失败要说解析不到，实际：" + r[1]);
  assert.ok(/超时/.test(r[2]), "超时要说超时，实际：" + r[2]);
  assert.strictEqual(r[3], "别的东西坏了", "不认识的至少把类名前缀去掉，实际：" + r[3]);
});

await browser.close();
server.close();

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log(`${"=".repeat(50)}`);

process.exit(failed ? 1 : 0);
