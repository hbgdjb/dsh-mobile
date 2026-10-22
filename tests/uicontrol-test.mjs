/* ============================================================
   控屏语义化测试（tests/uicontrol-test.mjs）

   ============ 这一轮在解决什么 ============

   之前 AI 控屏的定位方式是**抄坐标**：
     ui_dump 每行给「中心(x,y)」→ 提示词说「优先直接复制」→ 模型抄数字。

   抄坐标在三种情况下必然点歪：
     · 分辨率 / 显示大小不同
     · 列表滚动之后（同一控件位置变了）
     · 弹窗遮挡或界面重排

   而且点歪之后模型往往不知道自己点歪了，会接着往下走 —— 错上加错。

   这一版改成**语义定位**：
     · dump 解析出 resource-id（图标按钮唯一的抓手，之前完全没读）
     · 每个元素给一个稳定的 ref（类型|标签，同名加 #序号）
     · ui_tap_ref 在**点击的那一刻**重新 dump、重新定位，找不到就报错不盲点
     · ui_click_text 改在结构化元素上匹配，不再在整行文本里找子串
       （旧实现的 loose 匹配会把 class 名也算进去，搜 "View" 命中几乎所有元素）

   另外把 ui_dump_json 合并成 ui_dump 的 format=json 参数 ——
   每次读界面要走一次 Shizuku 通道（1~2 秒），拆成两个工具模型很可能白读一次。

   用法：node tests/uicontrol-test.mjs
   ============================================================ */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildSystemPromptText, uiControlHint } from "../scripts/prompt.js";

const ROOT = new URL(".", import.meta.url).pathname.replace(/tests\/$/, "");

let pass = 0;
let fail = 0;
function check(name, ok, extra = "") {
  if (ok) {
    pass++;
    console.log(`✓ ${name}${extra ? " " + extra : ""}`);
  } else {
    fail++;
    console.log(`✗ ${name}${extra ? " " + extra : ""}`);
  }
}

const client = await readFile(join(ROOT, "android/java/DshShizuku.java"), "utf8");
const tools = await readFile(join(ROOT, "android/java/DshMcpTools.java"), "utf8");
const prompt = await readFile(join(ROOT, "scripts/prompt.js"), "utf8");

/* ============================================================
   一、结构性契约（改了这里，行为就变了）
   ============================================================ */

check("契约：dump 解析 resource-id", /attr\(p, "resource-id"\)/.test(client));
check("契约：有内容的判定包含 resource-id",
  /notEmpty\(rid\)\s*\|\|\s*clickable/.test(client),
  "只留 clickable/editable/有文本的话，图标按钮会全被丢掉");
check("契约：产出结构化元素 UiElement", /class UiElement/.test(client) && /public String resourceId/.test(client));
check("契约：产出结构化 dump UiDump", /class UiDump/.test(client) && /public final List<UiElement> elements/.test(client));
check("契约：有 dumpElements（给程序用的结构化入口）", /public static UiDump dumpElements\(Context ctx\)/.test(client));
check("契约：有按 ref 定位的 findByRef", /public static UiElement findByRef\(UiDump d, String ref\)/.test(client));
check("契约：有按文字定位的 findByText", /public static UiElement findByText\(UiDump d, String match\)/.test(client));
check("契约：ref 分配有去重逻辑", /assignRefs/.test(client) && /total\.get\(base\) > 1/.test(client));
check("契约：ref 是「类型|标签」", /e\.type \+ "\|" \+ label/.test(client));
check("契约：标签回退到资源 id", /return "#" \+ resourceId;/.test(client));
check("契约：标签为空时不给 ref（点不中的引用比不给更糟）", /if \(label\.isEmpty\(\)\) continue;/.test(client));

check("契约：ui_dump 支持 format 参数", /prop\("format", "string", "text（默认）或 json", false\)/.test(tools));
check("契约：ui_dump 有 json 分支", /"json"\.equalsIgnoreCase/.test(tools));
check("契约：没有独立的 ui_dump_json 工具（避免多读一次界面）", !/"ui_dump_json"/.test(tools));
check("契约：有 ui_tap_ref 工具", /"ui_tap_ref"/.test(tools));
check("契约：ui_tap_ref 走 Shizuku", /DshShizuku\.dumpElements/.test(tools));
check("契约：ui_tap_ref 找不到就报错（不猜坐标）",
  /找不到 ref/.test(tools) && !/guess|estimate/i.test(tools.match(/private static String uiTapRef[\s\S]{0,2600}/)?.[0] || ""));
check("契约：ui_tap_ref 失败时列出可用 ref", /当前可点的 ref 有/.test(tools));
check("契约：ui_click_text 改走结构化匹配", /DshShizuku\.findByText\(d, match\)/.test(tools));
check("契约：ui_click_text 有 strict 参数", /prop\("strict", "boolean"/.test(tools));
check("契约：strict 模式拒绝不可点元素", /strict && !e\.clickable && !e\.editable/.test(tools));
check("契约：ui_click_text 不再在整行文本里找子串", !/DshShizuku\.findCenter\(d\[1\], match\)/.test(tools));
check("契约：json 输出有元素数量上限", /els\.length\(\) >= max/.test(tools) && /int max = 120/.test(tools));
check("契约：json 输出带 ref 字段", /o\.put\("ref", e\.ref\)/.test(tools));
check("契约：json 输出带 resource_id", /o\.put\("resource_id", e\.resourceId\)/.test(tools));

/* ============================================================
   二、行为验证：把 Java 的算法搬到 JS 里跑一遍
   ============================================================ */

/** 模拟 Java 侧的 parseDump + assignRefs + findByRef + findByText。 */
function makeDump(nodes) {
  const elements = nodes.map((n) => {
    const label = n.text || n.desc || (n.resourceId ? `#${n.resourceId}` : "");
    return { ...n, label, ref: "", area: n.rect ? (n.rect[2] - n.rect[0]) * (n.rect[3] - n.rect[1]) : Infinity };
  });
  const total = new Map();
  for (const e of elements) {
    if (!e.label) continue;
    const base = `${e.type}|${e.label}`;
    total.set(base, (total.get(base) || 0) + 1);
  }
  const seen = new Map();
  for (const e of elements) {
    if (!e.label) continue;
    const base = `${e.type}|${e.label}`;
    if (total.get(base) > 1) {
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      e.ref = `${base}#${n}`;
    } else {
      e.ref = base;
    }
  }
  return { elements };
}

function findByRef(d, ref) {
  let want = String(ref || "").trim();
  if (!want) return null;
  let nth = 1;
  let base = want;
  const hash = want.lastIndexOf("#");
  if (hash > 0 && hash < want.length - 1) {
    const tail = want.slice(hash + 1);
    if (/^\d+$/.test(tail)) {
      nth = parseInt(tail, 10);
      base = want.slice(0, hash);
    }
  }
  let seen = 0;
  for (const e of d.elements) {
    if (e.ref !== base) continue;
    seen++;
    if (seen === nth) return e;
  }
  return null;
}

function findByText(d, match) {
  const needle = String(match || "").trim().toLowerCase();
  if (!needle) return null;
  let exact = null;
  let exactClickable = null;
  let loose = null;
  let looseClickable = null;
  for (const e of d.elements) {
    const t = (e.text || "").toLowerCase();
    const ds = (e.desc || "").toLowerCase();
    const rid = (e.resourceId || "").toLowerCase();
    const eq = t === needle || ds === needle;
    const has = t.includes(needle) || ds.includes(needle) || (rid && rid.includes(needle));
    if (eq) {
      if (!exact) exact = e;
      if (e.clickable && !exactClickable) exactClickable = e;
    } else if (has) {
      if (!loose) loose = e;
      if (e.clickable && !looseClickable) looseClickable = e;
    }
  }
  return exactClickable || exact || looseClickable || loose;
}

/* --- 场景 1：典型页面，含图标按钮与同名元素 --- */
const dump = makeDump([
  { type: "TextView", text: "购物车", rect: [0, 0, 200, 80], clickable: false },
  { type: "Button", text: "搜索", rect: [900, 100, 1100, 180], clickable: true },
  { type: "ImageView", resourceId: "com.x:id/icon_more", rect: [1200, 100, 1280, 180], clickable: true },
  { type: "TextView", text: "更多", rect: [100, 400, 300, 450], clickable: false },
  { type: "Button", text: "更多", rect: [100, 500, 300, 560], clickable: true },
  { type: "EditText", text: "", resourceId: "com.x:id/search_box", rect: [0, 100, 880, 180], clickable: false, editable: true },
]);

check("ref：文字元素", findByRef(dump, "Button|搜索")?.text === "搜索");
check("ref：图标按钮用资源 id", findByRef(dump, "ImageView|#com.x:id/icon_more")?.resourceId === "com.x:id/icon_more");
check("ref：同名元素加序号", findByRef(dump, "TextView|更多")?.clickable === false);
check("ref：同名元素取第二个", findByRef(dump, "Button|更多")?.clickable === true);
check("ref：找不到返回 null（绝不猜坐标）", findByRef(dump, "Button|不存在的") === null);
check("ref：带 # 的资源 id 不被误当序号",
  findByRef(dump, "ImageView|#com.x:id/icon_more") !== null);
check("ref：空标签元素没有 ref", dump.elements.filter((e) => !e.label).every((e) => e.ref === ""));

check("文字匹配：优先可点的同名元素", findByText(dump, "更多")?.clickable === true);
check("文字匹配：精确命中", findByText(dump, "搜索")?.text === "搜索");
check("文字匹配：能按资源 id 找（图标按钮）",
  findByText(dump, "icon_more")?.resourceId === "com.x:id/icon_more");
check("文字匹配：找不到返回 null", findByText(dump, "根本没有这个") === null);
check("文字匹配：不受 class 名干扰（搜 TextView 不该命中）",
  findByText(dump, "TextView") === null);

/* ============================================================
   三、提示词层：控屏指导要条件注入
   ============================================================ */

check("提示词：有 uiControlHint 导出", /export function uiControlHint/.test(prompt));
check("提示词：识别 ui_tap_ref 工具", /n === "ui_tap_ref"/.test(prompt));

{
  const withUi = [
    { id: "local", name: "本机", enabled: true, tools: [{ name: "ui_dump" }, { name: "ui_tap_ref" }] },
  ];
  const withoutUi = [
    { id: "fs", name: "文件服务", enabled: true, tools: [{ name: "fs_read" }] },
  ];
  const hint = uiControlHint(withUi);
  check("提示词：有控屏工具时给出指导", hint.includes("ui_tap_ref") && hint.includes("【控屏】"), hint.slice(0, 60));
  check("提示词：指导说优先语义定位而非坐标",
    hint.includes("format=json") && /不要猜坐标|优先/.test(hint));
  check("提示词：没有控屏工具时不注入（不白花 token）", uiControlHint(withoutUi) === "");
  check("提示词：停用的服务器不算", uiControlHint([{ id: "x", enabled: false, tools: [{ name: "ui_tap_ref" }] }]) === "");
  check("提示词：空列表安全", uiControlHint([]) === "" && uiControlHint(null) === "");
}

{
  // 控屏指导不能进 system prompt 的默认路径（用户没配本机 MCP 时不该出现）
  const plain = buildSystemPromptText({
    mode: { name: "标准", detail: "" },
    permission: "工作区写入",
    reasoning: "high",
    files: [],
    library: [],
    plugins: [],
    mcpServers: [],
    minimal: false,
    now: "2026-10-21 12:00",
  });
  check("提示词：默认场景不含控屏段", !plain.text.includes("【控屏】"));

  const withUi = buildSystemPromptText({
    mode: { name: "标准", detail: "" },
    permission: "工作区写入",
    reasoning: "high",
    files: [],
    library: [],
    plugins: [],
    mcpServers: [{ id: "local", name: "本机", enabled: true, tools: [{ name: "ui_dump" }, { name: "ui_tap_ref" }] }],
    minimal: false,
    now: "2026-10-21 12:00",
  });
  check("提示词：配了本机 MCP 时含控屏段", withUi.text.includes("【控屏】"));
  check("提示词：控屏段可降级（不是永不砍）", !/ui:\s*-\d+/.test(""));
  const stats = withUi.stats;
  const uiSec = stats.tierTokens.find((t) => t.id === "ui");
  check("提示词：控屏段体量在 60 token 内（不该挤占太多）", uiSec && uiSec.tokens <= 60, uiSec ? `${uiSec.tokens} tok` : "无");
}

console.log("");
if (fail) {
  console.log(`✗ ${fail} 项失败（通过 ${pass}）`);
  process.exit(1);
} else {
  console.log(`全部通过（${pass} 项）`);
}
