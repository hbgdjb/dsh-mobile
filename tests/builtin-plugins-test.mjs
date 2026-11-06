/* ============================================================
   内置插件测试（tests/builtin-plugins-test.mjs）

   ============ 这一轮修的是什么 ============

   用户截图里「子智能体 / 智能体团队 / 自动授权审查」三个开关都打不开，
   界面上也没有任何下载入口。查下来是两个问题叠在一起：

     1. 这三个是**宿主内置能力**，本来就没有 codePath。
        而 setPluginEnabled 不看这一点，一律去读插件代码文件 ——
        读不到 → 回滚成 false → 用户看到「插件代码是空的」。
     2. 它们可以被「卸载」（removable 没标 false），卸掉之后
        既不在官方清单、也没有下载地址，就永远回不来了。

   另外「番茄钟」只是种子里的示例，用户要求删掉。

   这个测试覆盖：种子、开关、团队工具、审查拦截、卸载保护、老状态迁移。

   运行：node tests/builtin-plugins-test.mjs
   ============================================================ */

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
function check(name, ok, extra = "") {
  if (ok) {
    pass += 1;
    console.log(`✓ ${name} ${extra}`);
  } else {
    fail += 1;
    console.log(`✗ ${name} ${extra}`);
  }
}

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(String(req.url || "/").split("?")[0]);
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

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});

await page.goto(ORIGIN, { waitUntil: "networkidle" });
await page.waitForTimeout(700);

console.log("\n[1] 种子与内置标记");

{
  const info = await page.evaluate(async () => {
    const st = await import("/scripts/store.js");
    return {
      ids: st.state.plugins.map((p) => p.id),
      items: st.state.plugins.map((p) => ({
        id: p.id,
        name: p.name,
        preinstalled: !!p.preinstalled,
        removable: p.removable,
        enabled: !!p.enabled,
      })),
    };
  });
  check("番茄钟已从种子里删除", !info.ids.includes("pomodoro"), info.ids.join(","));
  check("插件总数 11", info.ids.length === 11, String(info.ids.length));
  const builtins = info.items.filter((p) => p.preinstalled);
  check("11 个全部标为内置", builtins.length === 11, String(builtins.length));
  check(
    "内置插件一律不可卸载",
    builtins.every((p) => p.removable === false),
    builtins.filter((p) => p.removable !== false).map((p) => p.id).join(",")
  );
}

console.log("\n[2] 三个开关能真的打开");

{
  const info = await page.evaluate(async () => {
    const st = await import("/scripts/store.js");
    const pi = await import("/scripts/plugin-install.js");
    const out = {};
    for (const id of ["subagent", "teams", "review"]) {
      const res = await pi.setPluginEnabled(id, true);
      out[id] = { ok: res.ok, error: res.error || "", enabled: !!st.state.plugins.find((p) => p.id === id)?.enabled };
    }
    return out;
  });
  for (const id of ["subagent", "teams", "review"]) {
    check(`${id} 启用成功`, info[id].ok === true && info[id].enabled === true, info[id].error);
  }

  const tools = await page.evaluate(async () => {
    const t = await import("/scripts/tools.js");
    return t.availableToolNames();
  });
  check("子智能体工具进入工具表", tools.includes("spawn_subagent"));
  check("团队工具进入工具表", tools.includes("agent_team"));
}

console.log("\n[3] 团队任务板");

{
  const info = await page.evaluate(async () => {
    const st = await import("/scripts/store.js");
    const t = await import("/scripts/tools.js");
    st.setSettings({ approval: "auto" });
    st.state.team = { runs: [] };
    const started = Date.now();
    const run = await t.executeTool(
      "agent_team",
      { goal: "并行查三件事", tasks: ["查 A", "查 B", "查 C"] },
      {
        spawnSubagent: async (task) => {
          await new Promise((r) => setTimeout(r, 90));
          if (task === "查 B") throw new Error("B 超时");
          return "结论：" + task;
        },
      }
    );
    return {
      output: run.output,
      ok: run.ok,
      elapsed: Date.now() - started,
      board: st.state.team.runs[0],
    };
  });
  check("团队工具返回结论", /团队任务板/.test(info.output) && /结论：查 A/.test(info.output), info.output.slice(0, 60));
  check("三条任务是并行跑的", info.elapsed < 400, `${info.elapsed}ms`);
  check("部分失败不拖垮整队", info.ok === true && /B 超时/.test(info.output));
  check("任务板落盘 1 次", !!info.board && info.board.items.length === 3);
  check(
    "任务板记录状态",
    !!info.board && info.board.items[0].status === "done" && info.board.items[1].status === "error",
    info.board ? info.board.items.map((i) => i.status).join(",") : "无任务板"
  );

  const few = await page.evaluate(async () => {
    const t = await import("/scripts/tools.js");
    return t.executeTool("agent_team", { goal: "只有一条", tasks: ["单独查"] }, { spawnSubagent: async () => "x" });
  });
  check("少于两条任务直接拒绝", few.ok === false && /至少需要两条/.test(few.output), few.output);
}

console.log("\n[4] 自动授权审查只否决、不乱放");

{
  const info = await page.evaluate(async () => {
    const st = await import("/scripts/store.js");
    const pi = await import("/scripts/plugin-install.js");
    const t = await import("/scripts/tools.js");
    st.setSettings({ approval: "ask" });
    st.state.review = { scans: 0, blocked: 0 };
    await pi.setPluginEnabled("review", true);

    const run = (name, args) => t.executeTool(name, args, { requestApproval: async () => true });
    const traversal = await run("fs_delete", { path: "../outside.txt" });
    const wildcard = await run("shell", { command: "rm -rf ." });
    const findDel = await run("shell", { command: "find . -name '*.md' -delete" });
    const normal = await run("fs_write", { path: "note.txt", content: "hi" });
    const deleteOne = await run("fs_delete", { path: "note.txt" });

    await pi.setPluginEnabled("review", false);
    const afterOff = await run("fs_delete", { path: "../outside.txt" });

    return {
      traversal: { ok: traversal.ok, status: traversal.status, output: traversal.output },
      wildcard: { ok: wildcard.ok, status: wildcard.status, output: wildcard.output },
      findDel: { ok: findDel.ok, status: findDel.status, output: findDel.output },
      normal: { ok: normal.ok, status: normal.status },
      deleteOne: { ok: deleteOne.ok, status: deleteOne.status },
      afterOff: { ok: afterOff.ok, status: afterOff.status },
      review: { ...st.state.review },
    };
  });

  check("越界路径被拦", info.traversal.status === "denied" && /越出了工作区/.test(info.traversal.output));
  check("rm -rf . 被拦", info.wildcard.status === "denied" && /通配符|当前目录/.test(info.wildcard.output));
  check("find -delete 被拦", info.findDel.status === "denied" && /find/.test(info.findDel.output));
  check("正常写入不受影响", info.normal.ok === true && info.normal.status === "done");
  check("删除单个文件不受影响", info.deleteOne.ok === true);
  check("关掉审查后不再拦", info.afterOff.status !== "denied", info.afterOff.status);
  check("计数：复核 5 次、拦 3 次", info.review.scans === 5 && info.review.blocked === 3, JSON.stringify(info.review));
}

console.log("\n[5] 内置插件卸载保护");

{
  const info = await page.evaluate(async () => {
    const st = await import("/scripts/store.js");
    const pi = await import("/scripts/plugin-install.js");
    const res = await pi.uninstallPlugin("teams");
    return { res, still: !!st.state.plugins.find((p) => p.id === "teams") };
  });
  check("内置插件拒绝卸载", info.res.ok === false && /内置插件不能卸载/.test(info.res.error), info.res.error || "");
  check("拒绝后插件仍在", info.still === true);
}

console.log("\n[6] 老状态迁移：番茄钟被清掉，丢失的内置插件回得来");

{
  const info = await page.evaluate(async () => {
    const st = await import("/scripts/store.js");
    // 模拟老用户的 localStorage：有番茄钟、缺 teams
    st.state.plugins = st.state.plugins.filter((p) => p.id !== "teams");
    st.state.plugins.push({
      id: "pomodoro",
      name: "番茄钟",
      desc: "会话内悬浮计时器",
      version: "0.1.0",
      author: "you",
      official: false,
      enabled: false,
      tools: [],
      scopes: ["ui.slot"],
      installedAt: Date.now() - 86400000,
    });
    st.save(true);
    return true;
  });
  check("已写入模拟老状态", info === true);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(700);

  const after = await page.evaluate(async () => {
    const st = await import("/scripts/store.js");
    return {
      ids: st.state.plugins.map((p) => p.id),
      teams: st.state.plugins.find((p) => p.id === "teams"),
      pomodoro: st.state.plugins.find((p) => p.id === "pomodoro"),
    };
  });
  check("重开后番茄钟消失", !after.pomodoro);
  check("丢失的 teams 被内置清单补回", !!after.teams);
  check("补回后仍不可卸载", after.teams?.removable === false);
}

console.log("\n[7] 详情页把能力说清楚");

{
  await page.evaluate(async () => {
    const st = await import("/scripts/store.js");
    const pi = await import("/scripts/plugin-install.js");
    await pi.setPluginEnabled("teams", true);
    await pi.setPluginEnabled("review", true);
    st.state.review = { scans: 7, blocked: 2 };
    st.save(true);
  });
  await page.evaluate(() => document.querySelector('[data-act="tab"][data-view="plugins"]')?.click());
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    document.querySelector('[data-act="plugins-tab"][data-value="page"]')?.click();
  });
  await page.waitForTimeout(300);

  const teamsSheet = await page.evaluate(async () => {
    document.querySelector('[data-act="plugin-detail"][data-id="teams"]')?.click();
    await new Promise((r) => setTimeout(r, 250));
    return document.querySelector(".sheet")?.innerText || "";
  });
  check("团队详情有任务板", /团队任务板/.test(teamsSheet), teamsSheet.slice(0, 80));

  const reviewSheet = await page.evaluate(async () => {
    document.querySelector('[data-act="plugin-detail"][data-id="review"]')?.click();
    await new Promise((r) => setTimeout(r, 250));
    return document.querySelector(".sheet")?.innerText || "";
  });
  check("审查详情有复核计数", /已复核/.test(reviewSheet) && /7/.test(reviewSheet), reviewSheet.slice(0, 80));
  check("审查详情说明只否决", /只会否决/.test(reviewSheet));
}

check("没有未捕获异常", errors.length === 0, errors.slice(0, 2).join(" | "));

await browser.close();
server.close();

console.log("\n==================================================");
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log("==================================================");
process.exit(fail ? 1 : 0);
