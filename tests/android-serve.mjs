/**
 * 把 Android 的静态资源服务「搬进」浏览器测试。
 *
 * ============ 为什么测试要读 Java 源码 ============
 *
 * 0.57.0 的手写功能在真机上一点就报「识别引擎加载失败」，
 * 而本地测试 24 项全绿。根因是两边对同一个文件给了不同的
 * Content-Type：
 *
 *   测试的 node 静态服务器：.mjs → text/javascript   ✓
 *   真机 DshImeService：     .mjs → application/octet-stream  ✗
 *
 * Chromium 对 ESM 做严格 MIME 检查，类型不对就不执行 ——
 * 于是 `import("./vendor/ort/ort.wasm.min.mjs")` 直接失败。
 *
 * 只要测试服务器自己写一份 MIME 表，它就永远比生产环境宽松，
 * 这类 bug 也就永远测不出来。所以这里直接从 DshImeService.java
 * 里**解析**出那张表来用：Java 怎么给，测试就怎么给。
 *
 * 代价是解析器得跟着 Java 的写法走。mimeOf 里就那一种句式
 * （`if (low.endsWith(".x")) return "y";`），解析失败会明确报错，
 * 不会静默退回一张宽松的表 —— 那等于把锁拆了。
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const JAVA = new URL("../android/java/DshImeService.java", import.meta.url).pathname;

/** 从源码里抠出 mimeOf 的方法体（按大括号配对，不靠缩进）。 */
function methodBody(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(`找不到方法：${signature}`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`方法体没有闭合：${signature}`);
}

/**
 * 解析出 { ".mjs": "application/javascript", ... } 与默认类型。
 * 一条 `if` 里可能挂多个扩展名（`.html` || `.htm`），要全收。
 */
export async function loadAndroidMime(javaPath = JAVA) {
  const src = await readFile(javaPath, "utf8");
  const body = methodBody(src, "private String mimeOf(String p)");

  const table = new Map();
  let fallback = null;
  for (const stmt of body.split(";")) {
    const type = stmt.match(/return\s+"([^"]+)"/);
    const exts = [...stmt.matchAll(/endsWith\("(\.[A-Za-z0-9]+)"\)/g)].map((m) => m[1].toLowerCase());
    if (!type) continue;
    if (!exts.length) {
      // 末尾那条 `return "application/octet-stream"` 就是兜底
      fallback = type[1];
      continue;
    }
    for (const e of exts) table.set(e, type[1]);
  }

  if (!table.size) throw new Error("mimeOf 里一个扩展名都没解析到，解析器跟实现脱节了");
  if (!fallback) throw new Error("mimeOf 里没有兜底 return，解析器跟实现脱节了");

  return {
    table,
    fallback,
    /** 与 Java 完全一致的判定：按扩展名后缀匹配 */
    mimeFor(path) {
      const low = path.toLowerCase();
      for (const [ext, type] of table) {
        if (low.endsWith(ext)) return type;
      }
      return fallback;
    },
  };
}

/** 常见资源应有的类型（只列必须精确的那些）。 */
export const JS_MIME = /javascript|ecmascript/i;

export { extname };
