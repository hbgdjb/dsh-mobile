/**
 * 静态资源 MIME 表测试
 *
 * ============ 这条锁是为什么加的 ============
 *
 * 0.57.0 手写功能在真机上「识别引擎加载失败」，本地测试全绿。
 * 差别只在 Content-Type：键盘页用 ESM 动态 import onnxruntime-web
 * 的 `.mjs`，而 DshImeService.mimeOf() 只认 `.js`，
 * `.mjs` 落到 application/octet-stream → Chromium 严格 MIME 检查 → 不执行。
 *
 * 所以这里不测"键盘能不能用"（那是 ui 测试的事），只测一件事：
 * **键盘要加载的每一个文件，Android 那边给出的类型是否会被浏览器接受**。
 * 表直接从 Java 源码解析，Java 改错了这里就红。
 */
import { loadAndroidMime, JS_MIME } from "./android-serve.mjs";
import { readdir, stat } from "node:fs/promises";
import { join, extname, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

// 构建时被整目录拷进 assets/public 的那些（见 android/build-apk.sh）
const SERVED_DIRS = ["ime", "scripts", "styles", "icons", "splash"];
const SERVED_ROOT = ["index.html", "sw.js", "manifest.webmanifest"];

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

const mime = await loadAndroidMime();

console.log(`\n解析到 ${mime.table.size} 条映射，兜底 ${mime.fallback}\n`);
console.log([...mime.table].map(([e, t]) => `${e} → ${t}`).join("\n"));

/* ---------------- 关键扩展名 ---------------- */

console.log("\n关键扩展名\n");

// 手写面板的命门：ESM 必须拿到 JS 类型，wasm 必须拿到 application/wasm
check(".mjs 是 JS 类型", JS_MIME.test(mime.mimeFor("app.mjs")), mime.mimeFor("app.mjs"));
check(".js 是 JS 类型", JS_MIME.test(mime.mimeFor("app.js")), mime.mimeFor("app.js"));
check(".wasm 是 application/wasm", mime.mimeFor("x.wasm") === "application/wasm", mime.mimeFor("x.wasm"));
check(".html 是 text/html", mime.mimeFor("a.html") === "text/html", mime.mimeFor("a.html"));
check(".css 是 text/css", mime.mimeFor("a.css") === "text/css", mime.mimeFor("a.css"));
check(".txt 是 text/plain", mime.mimeFor("a.txt") === "text/plain", mime.mimeFor("a.txt"));
check(".png 是 image/png", mime.mimeFor("a.png") === "image/png", mime.mimeFor("a.png"));

// 双后缀：ort.wasm.min.mjs 不能被 .js 之外的规则误伤
check("ort.wasm.min.mjs 仍判为 JS", JS_MIME.test(mime.mimeFor("ime/vendor/ort/ort.wasm.min.mjs")),
  mime.mimeFor("ort.wasm.min.mjs"));

/* ---------------- 真实文件逐个过 ---------------- */

console.log("\n真实资源\n");

async function walk(dir) {
  const out = [];
  const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const it of items) {
    const p = join(dir, it.name);
    if (it.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const files = [];
for (const d of SERVED_DIRS) files.push(...(await walk(join(ROOT, d))));
for (const f of SERVED_ROOT) {
  try {
    if ((await stat(join(ROOT, f))).isFile()) files.push(join(ROOT, f));
  } catch {
    /* 缺文件不算这张表的错，构建脚本会拦 */
  }
}

// 只看真要经 WebView 加载的那些；模型/词库是 fetch 字节，类型无所谓
const JSY = new Set([".js", ".mjs"]);
let bad = 0;
for (const f of files) {
  const ext = extname(f).toLowerCase();
  const type = mime.mimeFor(f);
  const rel = relative(ROOT, f);
  if (JSY.has(ext) && !JS_MIME.test(type)) {
    console.log(`   ✗ ${rel} → ${type}`);
    bad += 1;
  }
  if (ext === ".wasm" && type !== "application/wasm") {
    console.log(`   ✗ ${rel} → ${type}`);
    bad += 1;
  }
}
check(`${files.length} 个资源里没有一个类型不对`, bad === 0, bad ? `${bad} 个有问题` : "");

// 手写/词库必须都在构建范围里，否则真机上就是 404
const need = ["ime/model/ppocrv5.ort", "ime/model/ppocrv5-dict.txt", "ime/vendor/ort/ort.wasm.min.mjs",
  "ime/vendor/ort/ort-wasm-simd-threaded.wasm", "ime/lexicon.bin", "ime/handwrite.js", "ime/main.js"];
const have = new Set(files.map((f) => relative(ROOT, f)));
for (const n of need) {
  check(`资源存在：${n}`, have.has(n));
}

console.log(failed ? `\n${failed} 项失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
