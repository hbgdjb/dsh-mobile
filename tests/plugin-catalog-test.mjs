#!/usr/bin/env node
/* ============================================================
   插件市场的数据层（scripts/plugin-catalog.js）

   测的是纯逻辑：把公开索引压成我们要的形状、搜索、分类、tarball 地址。
   不联网 —— 目录数据用截取的样例，这样测试稳定、跑得快。

   用法：node tests/plugin-catalog-test.mjs
   ============================================================ */

import assert from "node:assert";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const cat = await import(pathToFileURL(path.join(ROOT, "scripts", "plugin-catalog.js")).href);
const install = await import(
  pathToFileURL(path.join(ROOT, "scripts", "plugin-install-node.js")).href
);

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

/** 一份缩小的、但字段形状与真实索引一致的样例。 */
const RAW = {
  format: 1,
  title: "DSH Plugin Catalog",
  plugins: [
    {
      name: "@yolk_vat-y/dsh-project-memory",
      title: "00080000/dsh-project-memory",
      description: { zh: "为项目提供持久化记忆", en: "Project memory for dsh" },
      metadata: { category: "memory" },
      versions: [
        { version: "0.6.2", publishTimestamp: 1792400000 },
        { version: "0.6.3", publishTimestamp: 1792426904 },
      ],
      repository: { url: "https://github.com/00080000/dsh-project-memory" },
    },
    {
      name: "dsh-free-search",
      title: "dsh-free-search",
      description: { zh: "免费联网搜索，多引擎回退", en: "Free web search" },
      metadata: { category: "browser" },
      versions: [{ version: "0.9.11", publishTimestamp: 1791000000 }],
    },
    {
      name: "dsh-codex-ui",
      title: "dsh-codex-ui",
      description: { zh: "Codex 风格界面", en: "Codex style UI" },
      metadata: { category: "ui" },
      versions: [{ version: "1.2.0", publishTimestamp: 1792000000 }],
    },
    { name: "", title: "坏的", versions: [] },
  ],
};

console.log("\n[1] 归一化");

await test("只保留最新版本", () => {
  const items = cat.normalizeCatalog(RAW);
  const mem = items.find((i) => i.name === "@yolk_vat-y/dsh-project-memory");
  assert.strictEqual(mem.version, "0.6.3", "versions 是升序，取最后一个");
  assert.strictEqual(mem.updatedAt, 1792426904);
});

await test("title 去掉作者前缀，name 保留全名", () => {
  const items = cat.normalizeCatalog(RAW);
  const mem = items.find((i) => i.name === "@yolk_vat-y/dsh-project-memory");
  assert.strictEqual(mem.title, "dsh-project-memory", "显示用短名");
  assert.strictEqual(mem.name, "@yolk_vat-y/dsh-project-memory", "安装必须用全名");
});

await test("中英描述都取到，缺字段不报错", () => {
  const items = cat.normalizeCatalog(RAW);
  const s = items.find((i) => i.name === "dsh-free-search");
  assert.strictEqual(s.desc, "免费联网搜索，多引擎回退");
  assert.strictEqual(s.descEn, "Free web search");
  const ui = items.find((i) => i.name === "dsh-codex-ui");
  assert.strictEqual(ui.repo, "", "没有仓库地址时给空串，不要 undefined");
});

await test("没有 name 的条目被丢掉", () => {
  const items = cat.normalizeCatalog(RAW);
  assert.strictEqual(items.length, 3);
});

await test("输入不是目录时返回空数组而不是抛错", () => {
  assert.deepStrictEqual(cat.normalizeCatalog(null), []);
  assert.deepStrictEqual(cat.normalizeCatalog({}), []);
});

console.log("\n[2] 搜索与分类");

const ITEMS = cat.normalizeCatalog(RAW);

await test("按中文描述搜", () => {
  const r = cat.filterCatalog(ITEMS, { query: "记忆" });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].name, "@yolk_vat-y/dsh-project-memory");
});

await test("按英文描述搜（大小写不敏感）", () => {
  const r = cat.filterCatalog(ITEMS, { query: "SEARCH" });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].name, "dsh-free-search");
});

await test("空搜索返回全部", () => {
  assert.strictEqual(cat.filterCatalog(ITEMS, { query: "  " }).length, 3);
});

await test("分类过滤", () => {
  const r = cat.filterCatalog(ITEMS, { category: "ui" });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].name, "dsh-codex-ui");
});

await test("分类与搜索叠加", () => {
  assert.strictEqual(cat.filterCatalog(ITEMS, { query: "记忆", category: "ui" }).length, 0);
  assert.strictEqual(cat.filterCatalog(ITEMS, { query: "记忆", category: "memory" }).length, 1);
});

await test("分类统计按数量排序", () => {
  const cats = cat.categoriesOf(ITEMS);
  assert.strictEqual(cats.length, 3, "三个分类各一条");
  assert.ok(cats.every((c) => c.count === 1));
});

console.log("\n[3] 下载地址");

await test("普通包", () => {
  assert.strictEqual(
    cat.npmTarballUrl("dsh-free-search", "0.9.11"),
    "https://registry.npmmirror.com/dsh-free-search/-/dsh-free-search-0.9.11.tgz"
  );
});

await test("scoped 包：文件名不带 scope，路径带", () => {
  assert.strictEqual(
    cat.npmTarballUrl("@yolk_vat-y/dsh-project-memory", "0.6.3"),
    "https://registry.npmmirror.com/@yolk_vat-y/dsh-project-memory/-/dsh-project-memory-0.6.3.tgz"
  );
});

await test("缺包名或版本时明确报错", () => {
  assert.throws(() => cat.npmTarballUrl("", "1.0.0"), /缺少包名/);
  assert.throws(() => cat.npmTarballUrl("x", ""), /缺少包名/);
});

/* ---------------- 造一个最小可用的 tar.gz ---------------- */

/**
 * 造一个 tar.gz。
 *
 * npmmirror 那条路是「下 tarball → 解出 index.json」，不造真的包
 * 就只能靠联网验证 —— 而联网验证恰恰是这条路的薄弱环节，
 * 不能只在网络好的时候才对。
 */
function makeTarGz(files) {
  const parts = [];
  for (const [name, data] of Object.entries(files)) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(buf.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148); // checksum 先用空格占位
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += header[i];
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);

    parts.push(header, buf);
    const pad = (512 - (buf.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024)); // 结束标记
  return new Uint8Array(gzipSync(Buffer.concat(parts)));
}

const enc = (o) => new TextEncoder().encode(typeof o === "string" ? o : JSON.stringify(o));
const BOOM = () => {
  throw new Error("ConnectException: Failed to connect to cdn.jsdelivr.net/104.17.207.5:443");
};

console.log("\n[4] 多来源回退");

await test("npmmirror：先问版本号，再下 tarball，解出里面的 index.json", async () => {
  cat.clearCatalogCache({ forgetSource: true });
  const seen = [];
  const tgz = makeTarGz({ "package/index.json": JSON.stringify(RAW) });
  const fakeFetch = async (url) => {
    seen.push(url);
    if (url.endsWith("/dsh-plugin-catalog/latest")) return enc({ version: "2026.1023.9552" });
    if (url.includes("/dsh-plugin-catalog-2026.1023.9552.tgz")) return tgz;
    throw new Error("不该请求：" + url);
  };

  const items = await cat.loadCatalog({ fetchBytes: fakeFetch });
  assert.ok(items.length > 0, "要能解出条目");
  assert.strictEqual(cat.catalogSourceId(), "npmmirror");
  assert.strictEqual(seen.length, 2, "两步：版本号 → tarball");
  assert.ok(seen[0].endsWith("/latest"));
  assert.ok(seen[1].endsWith("dsh-plugin-catalog-2026.1023.9552.tgz"));
});

await test("第一个源不通就自动换下一个（国内最常见的那个场景）", async () => {
  cat.clearCatalogCache({ forgetSource: true });
  const seen = [];
  const fakeFetch = async (url) => {
    seen.push(url);
    // 模拟「npmmirror 也不通」，只有 fastly 能走
    if (url.includes("fastly")) return enc(RAW);
    throw new Error("ConnectException: Failed to connect to registry.npmmirror.com/1.2.3.4:443");
  };

  const items = await cat.loadCatalog({ fetchBytes: fakeFetch });
  assert.ok(items.length > 0, "换到能通的源就该成功，而不是整个失败");
  assert.strictEqual(cat.catalogSourceId(), "fastly");
  assert.ok(seen.length >= 2, "至少试过 npmmirror 和 fastly");
});

await test("全部不通时，错误里逐个列出源和原因（用户要能判断是不是网络的锅）", async () => {
  cat.clearCatalogCache({ forgetSource: true });
  await assert.rejects(
    () => cat.loadCatalog({ fetchBytes: async () => BOOM() }),
    (e) => {
      assert.ok(/所有 5 个来源都不通/.test(e.message), "要说清是全部失败：" + e.message);
      assert.ok(/npmmirror/.test(e.message), "要列出试过的源");
      assert.ok(/连不上 cdn\.jsdelivr\.net/.test(e.message), "要带上能看懂的原因：" + e.message);
      return true;
    }
  );
});

await test("Java 的异常类名不往界面上抛，只留「连不上哪个主机」", async () => {
  cat.clearCatalogCache({ forgetSource: true });
  try {
    await cat.loadCatalog({ fetchBytes: async () => BOOM() });
    assert.fail("应该抛错");
  } catch (e) {
    assert.ok(!/ConnectException/.test(e.message), "不该出现 ConnectException：" + e.message);
    assert.ok(!/104\.17\.207\.5/.test(e.message), "不该出现 IP 和端口");
  }
});

await test("上次成功的源会被提到最前，不重走一遍失败", async () => {
  cat.clearCatalogCache({ forgetSource: true });
  const okFetch = async (url) => {
    if (url.includes("fastly")) return enc(RAW);
    throw new Error("fail");
  };
  await cat.loadCatalog({ fetchBytes: okFetch });
  assert.strictEqual(cat.catalogSourceId(), "fastly");

  cat.clearCatalogCache(); // 只清数据，不忘来源
  const seen = [];
  await cat.loadCatalog({
    fetchBytes: async (url) => {
      seen.push(url);
      if (url.includes("fastly")) return enc(RAW);
      throw new Error("fail");
    },
  });
  assert.ok(seen[0].includes("fastly"), "第二次应该直接从 fastly 开始，实际：" + seen[0]);
});

await test("下到的不是 JSON（比如错误页）时不会假装成功", async () => {
  cat.clearCatalogCache({ forgetSource: true });
  await assert.rejects(
    () => cat.loadCatalog({ fetchBytes: async () => enc("<html>403 Forbidden</html>") }),
    /所有 5 个来源都不通/
  );
});

await test("目录结构不对时报错，不返回空数组糊弄过去", async () => {
  cat.clearCatalogCache({ forgetSource: true });
  await assert.rejects(
    () => cat.loadCatalog({ fetchBytes: async () => enc({ foo: 1 }) }),
    /所有 5 个来源都不通/
  );
});

console.log("\n[5] 目录名规则");

await test("pluginIdOf 和安装器的目录名规则完全一致", () => {
  // 两处各写了一份（目录模块要轻，不能拖进安装器的 fs 依赖）。
  // 规则一旦漂移，市场里已装的插件还会显示「安装」，点下去报「已存在」——
  // 所以拿同一批输入把两边比一遍。
  const cases = [
    "dsh-free-search",
    "@demo/project-memory",
    "@yolk_vat-y/dsh-project-memory",
    "  spaced-name  ",
    "@a/b_c.d",
  ];
  for (const name of cases) {
    assert.strictEqual(cat.pluginIdOf(name), install.normaliseId(name), `不一致：${name}`);
  }
});

await test("斜杠进不了目录名：@scope/name → scope-name", () => {
  assert.strictEqual(cat.pluginIdOf("@demo/project-memory"), "demo-project-memory");
  assert.ok(!cat.pluginIdOf("@demo/project-memory").includes("/"));
});

console.log("\n[6] 装前预检");

/** 假 npm 响应。 */
const fakeLatest = (o) => async () => enc(o);

await test("读出依赖、入口、Node 要求", async () => {
  const r = await cat.inspectPackage("dsh-free-search", {
    fetchBytes: fakeLatest({
      name: "dsh-free-search",
      version: "0.9.13",
      main: "lib/index.js",
      dependencies: { "@deepseek-ai/schemastery": "^3.18.4" },
      peerDependencies: { react: "^18.2.0" },
      engines: { node: ">=20" },
    }),
  });
  assert.deepStrictEqual(r.deps, ["@deepseek-ai/schemastery"]);
  assert.deepStrictEqual(r.peers, ["react"]);
  assert.strictEqual(r.main, "lib/index.js");
  assert.strictEqual(r.enginesNode, ">=20");
  assert.strictEqual(r.hasClient, false, "没有 client 导出就不算有界面");
});

await test("exports[\"./client\"] → 有界面部分", async () => {
  const r = await cat.inspectPackage("x", {
    fetchBytes: fakeLatest({ version: "1.0.0", exports: { ".": "./i.js", "./client": "./c.js" } }),
  });
  assert.strictEqual(r.hasClient, true);
});

await test("files 里列了 client 目录也算有界面部分", async () => {
  const r = await cat.inspectPackage("x", {
    fetchBytes: fakeLatest({ version: "1.0.0", files: ["lib", "client"] }),
  });
  assert.strictEqual(r.hasClient, true);
});

await test("没有导出地图、也没 files 时，老实说没有", async () => {
  const r = await cat.inspectPackage("x", {
    fetchBytes: fakeLatest({ version: "1.0.0", main: "index.js" }),
  });
  assert.strictEqual(r.hasClient, false, "不能瞎猜有界面，否则每个插件都提示一遍");
  assert.deepStrictEqual(r.deps, []);
});

await test("npm 上查不到这个包时说清楚，而不是返回空对象", async () => {
  await assert.rejects(
    () => cat.inspectPackage("nope", { fetchBytes: fakeLatest({}) }),
    /查不到这个包/
  );
});

await test("npm 返回的不是 JSON（被网关拦）时也能分辨", async () => {
  await assert.rejects(
    () => cat.inspectPackage("x", { fetchBytes: async () => enc("<html>blocked</html>") }),
    /不是 JSON/
  );
});

console.log("\n[7] 时间");

await test("「多久以前」按量级切换单位", () => {
  const now = 1_800_000_000_000;
  const at = (ms) => cat.formatAgo((now - ms) / 1000, now);
  assert.strictEqual(at(10 * 1000), "刚刚");
  assert.strictEqual(at(5 * 60 * 1000), "5 分钟前");
  assert.strictEqual(at(3 * 3600 * 1000), "3 小时前");
  assert.strictEqual(at(4 * 86400 * 1000), "4 天前");
  assert.strictEqual(at(90 * 86400 * 1000), "3 个月前");
  assert.strictEqual(at(800 * 86400 * 1000), "2 年前");
  assert.strictEqual(cat.formatAgo(0, now), "", "没有时间戳就不显示");
});

console.log("\n[8] 缓存");

await test("第二次拉取走缓存，不再调用取字节函数", async () => {
  cat.clearCatalogCache({ forgetSource: true });
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return enc(RAW);
  };
  const a = await cat.loadCatalog({ fetchBytes: fakeFetch });
  const first = calls;
  const b = await cat.loadCatalog({ fetchBytes: fakeFetch });
  assert.strictEqual(calls, first, "30 分钟内不该重复下载");
  assert.strictEqual(a.length, b.length);
  assert.ok(cat.catalogCachedAt() > 0);
  assert.strictEqual(cat.catalogCachedSource(), cat.catalogSourceId());
});

await test("force 会绕过缓存", async () => {
  cat.clearCatalogCache({ forgetSource: true });
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return enc(RAW);
  };
  await cat.loadCatalog({ fetchBytes: fakeFetch });
  const after1 = calls;
  await cat.loadCatalog({ fetchBytes: fakeFetch, force: true });
  assert.ok(calls > after1, "force 必须真的再拉一次");
});

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log(`${"=".repeat(50)}`);

process.exit(failed ? 1 : 0);
