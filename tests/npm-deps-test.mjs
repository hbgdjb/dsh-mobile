#!/usr/bin/env node
/* ============================================================
   依赖求解与安装（scripts/npm-deps.js）

   ============ 这个测试守的是什么 ============

   手机端不能 npm install，所以我们自己装。装错位置插件就找不到包，
   而报错是 `Cannot find module` —— 看不出是「没装」还是「装错了地方」。

   所以这里重点测目录布局：扁平、嵌套、循环、冲突。

   全部注入假的 registry / 下载 / 写入，不联网。

   用法：node tests/npm-deps-test.mjs
   ============================================================ */

import assert from "node:assert";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const npm = await import(pathToFileURL(path.join(ROOT, "scripts", "npm-deps.js")).href);

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

/* ---------------- 假 registry ---------------- */

/**
 * 造一份 packument。
 * @param {object} versions  { "1.0.0": { deps } }
 */
function packument(name, versions, latest) {
  const table = {};
  for (const [v, deps] of Object.entries(versions)) {
    table[v] = {
      name,
      version: v,
      dependencies: deps || {},
      dist: { tarball: `https://registry.example/${name}/-/${name}-${v}.tgz` },
    };
  }
  return {
    name,
    "dist-tags": { latest: latest || Object.keys(versions).pop() },
    versions: table,
  };
}

/** 按 URL 查表。找不到就 404 风格地抛错。 */
function registryOf(map) {
  return async (url) => {
    const name = decodeURIComponent(url.replace("https://registry.npmmirror.com/", ""));
    if (!map[name]) throw new Error(`404 ${name}`);
    return map[name];
  };
}

const dirsOf = (plan) => plan.packages.map((p) => `${p.dir}@${p.version}`).sort();

/* ============================================================
   求解
   ============================================================ */

console.log("\n[1] 基本求解");

await test("没有依赖 → 空计划", async () => {
  const plan = await npm.resolveDependencyTree({
    rootPkg: { name: "x", version: "1.0.0" },
    fetchJson: registryOf({}),
  });
  assert.deepStrictEqual(plan.packages, []);
});

await test("单个依赖装到根 node_modules", async () => {
  const plan = await npm.resolveDependencyTree({
    rootPkg: { dependencies: { a: "^1.0.0" } },
    fetchJson: registryOf({
      a: packument("a", { "1.0.0": {}, "1.2.0": {}, "2.0.0": {} }),
    }),
  });
  assert.deepStrictEqual(dirsOf(plan), ["node_modules/a@1.2.0"], "^1.0.0 应选 1.2.0");
});

await test("传递依赖提到根（npm 的 hoisting）", async () => {
  const plan = await npm.resolveDependencyTree({
    rootPkg: { dependencies: { a: "^1.0.0" } },
    fetchJson: registryOf({
      a: packument("a", { "1.0.0": { b: "^2.0.0" } }),
      b: packument("b", { "2.0.0": {}, "2.1.0": {} }),
    }),
  });
  // 根层空着就放根 —— 不做提升的话，每个父包都嵌一份，
  // 实测能解出 25 个包其中 10 个是重复副本。
  assert.deepStrictEqual(dirsOf(plan), ["node_modules/a@1.0.0", "node_modules/b@2.1.0"]);
});

await test("两个包要同一个依赖 → 只装一份", async () => {
  const plan = await npm.resolveDependencyTree({
    rootPkg: { dependencies: { a: "^1.0.0", c: "^1.0.0" } },
    fetchJson: registryOf({
      a: packument("a", { "1.0.0": { b: "^2.0.0" } }),
      c: packument("c", { "1.0.0": { b: "^2.0.0" } }),
      b: packument("b", { "2.0.0": {} }),
    }),
  });
  const bPaths = plan.packages.filter((p) => p.name === "b");
  assert.strictEqual(bPaths.length, 1, "同一版本只该装一份，实际：" + JSON.stringify(dirsOf(plan)));
  assert.strictEqual(bPaths[0].dir, "node_modules/b");
});

await test("版本冲突：不同版本嵌到各自父包下", async () => {
  const plan = await npm.resolveDependencyTree({
    rootPkg: { dependencies: { a: "^1.0.0", c: "^1.0.0" } },
    fetchJson: registryOf({
      a: packument("a", { "1.0.0": { b: "^2.0.0" } }),
      c: packument("c", { "1.0.0": { b: "^3.0.0" } }),
      b: packument("b", { "2.0.0": {}, "3.0.0": {} }),
    }),
  });
  const byDir = new Map(plan.packages.map((p) => [p.dir, p.version]));
  // a 先被处理，它的 b@2 放根；c 要 b@3，根已被占 → 嵌到 c 下
  assert.strictEqual(byDir.get("node_modules/b"), "2.0.0");
  assert.strictEqual(byDir.get("node_modules/c/node_modules/b"), "3.0.0");
});

await test("插件自己要 c@1、传递依赖要 c@2 → 各放各的", async () => {
  const plan = await npm.resolveDependencyTree({
    rootPkg: { dependencies: { c: "^1.0.0", a: "^1.0.0" } },
    fetchJson: registryOf({
      a: packument("a", { "1.0.0": { c: "^2.0.0" } }),
      c: packument("c", { "1.0.0": {}, "2.0.0": {} }),
    }),
  });
  const byDir = new Map(plan.packages.map((p) => [p.dir, p.version]));
  assert.strictEqual(byDir.get("node_modules/c"), "1.0.0", "插件自己那份在根");
  assert.strictEqual(byDir.get("node_modules/a/node_modules/c"), "2.0.0", "a 要的那份嵌在 a 下");
});

await test("找不到满足范围的版本 → 说清楚是哪个包", async () => {
  await assert.rejects(
    () =>
      npm.resolveDependencyTree({
        rootPkg: { dependencies: { a: "^9.0.0" } },
        fetchJson: registryOf({ a: packument("a", { "1.0.0": {} }) }),
      }),
    /a 没有满足「\^9\.0\.0」的版本/
  );
});

await test("循环依赖不会套娃到死", async () => {
  const plan = await npm.resolveDependencyTree({
    rootPkg: { dependencies: { a: "^1.0.0" } },
    fetchJson: registryOf({
      a: packument("a", { "1.0.0": { b: "^1.0.0" } }),
      b: packument("b", { "1.0.0": { a: "^1.0.0" } }),
    }),
  });
  // a 在根，b 在 a 下；b 又要 a —— 能解析到根那份，所以不该再装
  assert.deepStrictEqual(dirsOf(plan), ["node_modules/a@1.0.0", "node_modules/b@1.0.0"]);
});

console.log("\n[2] 可选依赖与上限");

await test("可选依赖查不到时跳过并给警告", async () => {
  const plan = await npm.resolveDependencyTree({
    rootPkg: { optionalDependencies: { ghost: "^1.0.0" } },
    fetchJson: registryOf({}),
  });
  assert.deepStrictEqual(plan.packages, []);
  assert.ok(plan.warnings.some((w) => w.includes("ghost")), "要说清楚跳过了什么");
});

await test("普通依赖查不到就整体失败，不静默跳过", async () => {
  await assert.rejects(
    () =>
      npm.resolveDependencyTree({
        rootPkg: { dependencies: { ghost: "^1.0.0" } },
        fetchJson: registryOf({}),
      }),
    /查不到依赖 ghost/
  );
});

await test("包数量超上限时报错，而不是把手机拖死", async () => {
  const map = {};
  const deps = {};
  for (let i = 0; i < 20; i += 1) {
    map[`p${i}`] = packument(`p${i}`, { "1.0.0": {} });
    deps[`p${i}`] = "^1.0.0";
  }
  await assert.rejects(
    () => npm.resolveDependencyTree({ rootPkg: { dependencies: deps }, fetchJson: registryOf(map), limits: { packages: 5 } }),
    /依赖太多了/
  );
});

console.log("\n[3] 安装落盘");

await test("按求解结果写进对应目录，剥掉 tarball 的 package/ 前缀", async () => {
  const plan = {
    packages: [{ name: "a", version: "1.0.0", dir: "node_modules/a", tarball: "https://x/a.tgz" }],
    warnings: [],
  };
  const written = [];

  const r = await npm.installDependencyTree({
    plan,
    fetchBytes: async () => ({ bytes: new Uint8Array([1, 2, 3]) }),
    unpack: async () => [
      { path: "package/package.json", bytes: new Uint8Array([1]) },
      { path: "package/lib/index.js", bytes: new Uint8Array([2]) },
    ],
    writeFile: async (rel) => written.push(rel),
  });

  assert.deepStrictEqual(written.sort(), [
    "node_modules/a/lib/index.js",
    "node_modules/a/package.json",
  ]);
  assert.strictEqual(r.files, 2);
});

await test("跳过测试目录（大且没用）", async () => {
  const written = [];
  await npm.installDependencyTree({
    plan: { packages: [{ name: "a", version: "1.0.0", dir: "node_modules/a", tarball: "t" }], warnings: [] },
    fetchBytes: async () => ({ bytes: new Uint8Array([1]) }),
    unpack: async () => [
      { path: "package/index.js", bytes: new Uint8Array([1]) },
      { path: "package/test/x.js", bytes: new Uint8Array([1]) },
      { path: "package/tests/y.js", bytes: new Uint8Array([1]) },
      { path: "package/__tests__/z.js", bytes: new Uint8Array([1]) },
    ],
    writeFile: async (rel) => written.push(rel),
  });
  assert.deepStrictEqual(written, ["node_modules/a/index.js"]);
});

await test("可选依赖下载失败不影响整体", async () => {
  const r = await npm.installDependencyTree({
    plan: {
      packages: [{ name: "opt", version: "1.0.0", dir: "node_modules/opt", tarball: "t", optional: true }],
      warnings: [],
    },
    fetchBytes: async () => {
      throw new Error("网络炸了");
    },
    unpack: async () => [],
    writeFile: async () => {},
  });
  assert.strictEqual(r.files, 0);
  assert.ok(r.warnings.some((w) => w.includes("opt")), "要说明跳过了");
});

await test("普通依赖下载失败直接失败", async () => {
  await assert.rejects(
    () =>
      npm.installDependencyTree({
        plan: { packages: [{ name: "a", version: "1.0.0", dir: "node_modules/a", tarball: "t" }], warnings: [] },
        fetchBytes: async () => {
          throw new Error("网络炸了");
        },
        unpack: async () => [],
        writeFile: async () => {},
      }),
    /下载 a@1\.0\.0 失败/
  );
});

await test("总字节超上限时停下（手机装不下就别硬装）", async () => {
  await assert.rejects(
    () =>
      npm.installDependencyTree({
        plan: { packages: [{ name: "big", version: "1.0.0", dir: "node_modules/big", tarball: "t" }], warnings: [] },
        fetchBytes: async () => ({ bytes: new Uint8Array(1000) }),
        unpack: async () => [],
        writeFile: async () => {},
        limits: { bytes: 100 },
      }),
    /依赖太大/
  );
});

console.log("\n[4] 缓存");

const onePkg = (name, version) => ({
  packages: [{ name, version, dir: `node_modules/${name}`, tarball: `https://x/${name}.tgz` }],
  warnings: [],
});

await test("缓存命中时不下载，直接用缓存的字节", async () => {
  let fetched = 0;
  const r = await npm.installDependencyTree({
    plan: onePkg("a", "1.0.0"),
    fetchBytes: async () => {
      fetched += 1;
      return { bytes: new Uint8Array([9, 9]) };
    },
    cache: {
      get: async () => new Uint8Array([1, 2, 3]),
      put: async () => {},
    },
    unpack: async () => [{ path: "package/index.js", bytes: new Uint8Array([1]) }],
    writeFile: async () => {},
  });
  assert.strictEqual(fetched, 0, "有缓存就不该再下载");
  assert.strictEqual(r.cached, 1);
  assert.strictEqual(r.downloaded, 0);
});

await test("缓存未命中时下载，并写进缓存", async () => {
  const put = [];
  const r = await npm.installDependencyTree({
    plan: onePkg("b", "2.0.0"),
    fetchBytes: async () => ({ bytes: new Uint8Array([7, 7, 7]) }),
    cache: {
      get: async () => null,
      put: async (name, ver, bytes) => put.push({ name, ver, size: bytes.length }),
    },
    unpack: async () => [{ path: "package/index.js", bytes: new Uint8Array([1]) }],
    writeFile: async () => {},
  });
  assert.strictEqual(r.cached, 0);
  assert.strictEqual(r.downloaded, 1);
  assert.deepStrictEqual(put, [{ name: "b", ver: "2.0.0", size: 3 }], "下载完要存进缓存");
});

await test("缓存读失败当作没缓存，不影响安装", async () => {
  let fetched = 0;
  const r = await npm.installDependencyTree({
    plan: onePkg("c", "1.0.0"),
    fetchBytes: async () => {
      fetched += 1;
      return { bytes: new Uint8Array([1]) };
    },
    cache: {
      get: async () => {
        throw new Error("缓存坏了");
      },
      put: async () => {},
    },
    unpack: async () => [{ path: "package/index.js", bytes: new Uint8Array([1]) }],
    writeFile: async () => {},
  });
  assert.strictEqual(fetched, 1, "缓存坏了就该老实去下载");
  assert.strictEqual(r.downloaded, 1);
});

await test("缓存写失败不影响这次安装", async () => {
  const r = await npm.installDependencyTree({
    plan: onePkg("d", "1.0.0"),
    fetchBytes: async () => ({ bytes: new Uint8Array([1]) }),
    cache: {
      get: async () => null,
      put: async () => {
        throw new Error("磁盘满了");
      },
    },
    unpack: async () => [{ path: "package/index.js", bytes: new Uint8Array([1]) }],
    writeFile: async () => {},
  });
  assert.strictEqual(r.files, 1, "缓存写不进去，包还是要装");
});

await test("不传 cache 时行为和以前一样", async () => {
  const r = await npm.installDependencyTree({
    plan: onePkg("e", "1.0.0"),
    fetchBytes: async () => ({ bytes: new Uint8Array([1]) }),
    unpack: async () => [{ path: "package/index.js", bytes: new Uint8Array([1]) }],
    writeFile: async () => {},
  });
  assert.strictEqual(r.cached, 0);
  assert.strictEqual(r.files, 1);
});

console.log("\n[5] 真实形状");

await test("DSH 生态的典型依赖（^0.1.7-rc.1 || ^0.2.0-rc.1）", async () => {
  const plan = await npm.resolveDependencyTree({
    rootPkg: { dependencies: { "@deepseek-ai/dsh-settings": "^0.1.7-rc.1 || ^0.2.0-rc.1" } },
    fetchJson: registryOf({
      "@deepseek-ai/dsh-settings": packument("@deepseek-ai/dsh-settings", {
        "0.1.7-rc.1": {},
        "0.2.0-rc.1": {},
        "0.2.0-rc.2": {},
        "0.2.1-rc.2": {},
      }),
    }),
  });
  assert.deepStrictEqual(dirsOf(plan), ["node_modules/@deepseek-ai/dsh-settings@0.2.0-rc.2"]);
});

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log(`${"=".repeat(50)}`);

process.exit(failed ? 1 : 0);
