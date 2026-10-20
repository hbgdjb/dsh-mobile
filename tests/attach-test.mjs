/**
 * 附件选取流程回归测试（0.21.5）
 *
 * 用户反馈：点附件从本地导入文件时，文件先落到工作区，再由工作区列表选入对话框，
 * 两步流程很容易选错。要求：
 *   1) 本地导入后直接进入对话框的附件区（不再经工作区二次选择）
 *   2) 附件选取列表不含「已在工作区中的文件」，只含「本地导入」和「资料库」
 *   3) 资料库文件加入附件后带 area=library，预览/缩略图按区域读取
 *
 * 用法：node tests/attach-test.mjs
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";

const ROOT = new URL("..", import.meta.url).pathname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    const b = await readFile(f);
    res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" });
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
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(500);

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

// ---- 准备：工作区放一个文件（仅工作区），资料库放另一个文件（仅资料库） ----
await page.evaluate(async () => {
  const store = await import("./scripts/store.js");
  await store.initFiles();
  await store.writeFile("ws-only.md", "# 仅工作区\n不该出现在附件选取列表里\n");
  await store.writeFile("to-lib.md", "# 资料库文件\n应出现在附件选取列表里\n");
  await store.saveToLibrary("to-lib.md");
  store.createSession({ mode: "standard", title: "附件测试" });
  store.save(true);
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);

// ---- 场景一：附件面板只含「本地导入」和「资料库」 ----
await page.click('[data-act="attach"]');
await page.waitForSelector("#sheet-layer .sheet", { timeout: 5000 });
await page.waitForTimeout(200);

const s1 = await page.evaluate(() => {
  const sheet = document.querySelector("#sheet-layer .sheet");
  const labels = [...sheet.querySelectorAll(".section-label")].map((e) => e.textContent.trim());
  const rows = [...sheet.querySelectorAll(".file-row")].map((e) => e.textContent.trim());
  return {
    labels,
    rows,
    hasPhoneBtn: !!sheet.querySelector('[data-act="pick-phone-files"]'),
    phoneBtnText: sheet.querySelector('[data-act="pick-phone-files"]')?.textContent.trim() || "",
    sheetText: sheet.textContent,
    // 工作区文件那条记录如果还在，就是回归
    mentionsWorkspaceFile: /ws-only\.md/.test(sheet.textContent),
    hasWorkspaceSection: /工作区文件/.test(sheet.textContent),
    hasLibrarySection: /资料库/.test(sheet.textContent),
  };
});

check("附件面板有「从手机选择文件」入口", s1.hasPhoneBtn, s1.phoneBtnText);
check("附件面板没有「工作区文件」区块", !s1.hasWorkspaceSection);
check("附件面板不含工作区中的文件", !s1.mentionsWorkspaceFile, s1.rows.join(" | "));
check("附件面板含「资料库」区块", s1.hasLibrarySection, `分组=${s1.labels.join(",")}`);
check("资料库文件出现在附件列表里", s1.rows.some((r) => /to-lib\.md/.test(r)), s1.rows.join(" | "));

// ---- 场景二：从资料库选文件 → 直接成为附件（带 area=library） ----
await page.click('#sheet-layer .sheet [data-act="attach-file"][data-area="library"]');
await page.waitForTimeout(400);

const s2 = await page.evaluate(() => {
  const chips = [...document.querySelectorAll("#composer-files .attach-chip")].map((e) => e.textContent.trim());
  const chipArea = document.querySelector("#composer-files [data-act='preview-attachment']")?.dataset.area || "";
  return { chips, chipArea, sheetOpen: !!document.querySelector("#sheet-layer .sheet[data-open='true']") };
});
check("资料库文件已加入对话框附件区", s2.chips.length === 1, s2.chips.join(" | "));
check("附件标记了来源区域 library", s2.chipArea === "library", `area=${s2.chipArea}`);
check("选完资料库文件后面板关闭", !s2.sheetOpen);

// ---- 场景三：本地导入 → 直接进对话框附件区，不经工作区二次选择 ----
const tmp = await mkdtemp(join(tmpdir(), "dsh-attach-"));
const localFile = join(tmp, "phone-pic.png");
await writeFile(localFile, Buffer.from("89504e470d0a1a0a", "hex"));

const chooserPromise = page.waitForEvent("filechooser", { timeout: 8000 });
await page.click('[data-act="attach"]');
await page.waitForSelector("#sheet-layer .sheet", { timeout: 5000 });
await page.click('#sheet-layer .sheet [data-act="pick-phone-files"]');
const chooser = await chooserPromise;
await chooser.setFiles(localFile);
await page.waitForTimeout(1200);

const s3 = await page.evaluate(() => {
  const chips = [...document.querySelectorAll("#composer-files .attach-chip")].map((e) => ({
    text: e.textContent.trim(),
    area: e.querySelector("[data-act='preview-attachment']")?.dataset.area || "",
    path: e.getAttribute("title") || "",
  }));
  return {
    chips,
    sheetOpen: !!document.querySelector("#sheet-layer .sheet[data-open='true']"),
    // 导入后工作区里应该有这个文件（模型要能读到），但它不该再要求用户去工作区选
    workspaceHasIt: !!document.querySelector("#composer-files .attach-chip"),
  };
});
check("本地导入的文件直接进了附件区", s3.chips.length === 2, s3.chips.map((c) => c.text).join(" | "));
check("本地导入的附件来自 workspace 区", s3.chips.some((c) => c.area === "workspace" && /phone-pic/.test(c.text)), JSON.stringify(s3.chips));
check("导入后面板关闭（无需回工作区再选）", !s3.sheetOpen);

// ---- 场景四：附件面板再次打开时，已选文件可见，工作区文件仍不可见 ----
await page.click('[data-act="attach"]');
await page.waitForSelector("#sheet-layer .sheet", { timeout: 5000 });
await page.waitForTimeout(200);
const s4 = await page.evaluate(() => {
  const sheet = document.querySelector("#sheet-layer .sheet");
  const labels = [...sheet.querySelectorAll(".section-label")].map((e) => e.textContent.trim());
  return {
    labels,
    hasSelected: /已选\s*2\s*个/.test(sheet.textContent),
    mentionsWorkspaceRoot: /ws-only\.md/.test(sheet.textContent),
  };
});
check("面板显示「已选 2 个」", s4.hasSelected, s4.labels.join(","));
check("面板仍不列出工作区文件", !s4.mentionsWorkspaceRoot);

// ---- 场景五：预览附件按区域读取（library 文本能读出来） ----
await page.click("#sheet-layer .sheet [data-act='close-sheet']").catch(() => {});
await page.waitForTimeout(200);
const preview = await page.evaluate(async () => {
  const chip = document.querySelector("#composer-files [data-act='preview-attachment'][data-area='library']");
  if (!chip) return { ok: false, why: "no library chip" };
  chip.click();
  await new Promise((r) => setTimeout(r, 900));
  const box = document.querySelector("#file-body");
  return { ok: !!box, text: (box?.textContent || "").trim().slice(0, 80) };
});
check("资料库附件可预览并读出内容", preview.ok && /资料库文件/.test(preview.text), preview.text);

check("无未捕获异常", errors.length === 0, errors.join(" | "));

await browser.close();
server.close();
console.log(failed ? `\n✗ ${failed} 项未通过` : "\n✓ 全部通过");
process.exit(failed ? 1 : 0);
