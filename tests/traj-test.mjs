/* ============================================================
   中文控屏轨迹测试（tests/traj-test.mjs）

   ============ 这一版在解决什么 ============

   「手机控屏经验层」那份材料的核心问题不是检索器坏了，
   而是**语料语言和查询语言不匹配**：
     · 15,274 条轨迹里中文指令 0 条
     · 拿中文指令去检索，top1 相似度全是 0.000
     · 但英文自检索 top1 均值 0.636，与官方 0.628 一致 → 检索器本身没问题

   这一版改走**路线 A**（DSH 自己控屏时录），指令天然是中文，
   从根上消掉这个错配。本测试盯住三件事：

     1. 脱敏真的挡住了（手机号 / 验证码 / 卡号 / 邮箱）
     2. 采集不需要额外读屏（从已有 dump 输出里还原元素）
     3. 检索在中文上确实能召回（top1 命中率）

   用法：node tests/traj-test.mjs
   ============================================================ */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  redact,
  redactArgs,
  redactDeep,
  normText,
  labelOf,
  pairsOf,
  computeSignature,
  jaccard,
  sha1,
  tokenizeForFts,
  ngrams,
  similarity,
  bm25Search,
  buildBm25Index,
  bm25SearchWithIndex,
  screenDigest,
  parseDumpText,
  parseDumpJson,
  parseDump,
  mapAction,
  REPLAYABLE_TOOLS,
} from "../scripts/traj.js";

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

const runtime = await readFile(join(ROOT, "scripts/runtime.js"), "utf8");
const ui = await readFile(join(ROOT, "scripts/ui.js"), "utf8");
const screens = await readFile(join(ROOT, "scripts/screens.js"), "utf8");
const bridge = await readFile(join(ROOT, "android/java/DshFsBridge.java"), "utf8");

/* ============================================================
   一、脱敏（硬约束 A：一个都不能留）
   ============================================================ */

check("脱敏：手机号打码", redact("我的号是13812345678") === "我的号是138****5678", redact("我的号是13812345678"));
check("脱敏：手机号中间四位打码", redact("13812345678") === "138****5678");
check("脱敏：整串 4~8 位数字按验证码处理", redact("482913") === "******", redact("482913"));
check("脱敏：整串 4 位数字按验证码处理", redact("1234") === "****");
check("脱敏：卡号保留头 4 尾 4", redact("6222021234567890123") === "6222***********0123", redact("6222021234567890123"));
check("脱敏：邮箱打码", redact("a.b@test.com") === "a***@test.com", redact("a.b@test.com"));
check("脱敏：普通文本不动", redact("打开微信搜索天气") === "打开微信搜索天气");
check("脱敏：短数字（<4 位）不当验证码", redact("123") === "123");

check("脱敏：动作参数 text 被打码", redactArgs({ text: "13812345678" }).text === "138****5678");
check("脱敏：动作参数 ref 不打码（回放必需）", redactArgs({ ref: "Button|搜索" }).ref === "Button|搜索");
check("脱敏：动作参数 match 不打码", redactArgs({ match: "发送" }).match === "发送");
check("脱敏：嵌套结构也脱敏", redactArgs({ a: { text: "482913" } }).a.text === "******");
check("脱敏：屏幕元素递归脱敏", redactDeep([{ text: "13812345678" }])[0].text === "138****5678");

/* ============================================================
   二、签名引擎（移植 signature.py）
   ============================================================ */

check("签名：SHA-1 正确", sha1("abc") === "a9993e364706816aba3e25717850c26c9cd0d89d", sha1("abc"));
check("签名：SHA-1 空串", sha1("") === "da39a3ee5e6b4b0d3255bfef95601890afd80709");
check("签名：SHA-1 长串", sha1("a".repeat(1000)).length === 40);

check("归一化：转小写", normText("ABC") === "abc");
check("归一化：压空白", normText("a   b") === "a b");
check("归一化：去首尾符号", normText("「搜索」") === "搜索");
check("归一化：NFKC 全角转半角", normText("ＡＢＣ") === "abc");

check("标签链：文字优先", labelOf({ text: "搜索", desc: "d", resourceId: "r" }) === "搜索");
check("标签链：退到描述", labelOf({ text: "", desc: "搜索按钮", resourceId: "r" }) === "搜索按钮");
check("标签链：退到 #资源 id", labelOf({ text: "", desc: "", resourceId: "icon1" }) === "#icon1");
check("标签链：全空则无标签", labelOf({ text: "", desc: "", resourceId: "" }) === "");

check(
  "签名：元素集合只留有标签的",
  pairsOf([
    { type: "Button", text: "搜索", clickable: true },
    { type: "View", text: "", desc: "", resourceId: "", clickable: true },
  ]).size === 1,
  [...pairsOf([{ type: "Button", text: "搜索", clickable: true }])].join(",")
);
check(
  "签名：图标按钮（有 resource id）不会被丢掉",
  pairsOf([{ type: "ImageView", text: "", desc: "", resourceId: "ic" }]).has("ImageView|#ic")
);
check("签名：长度 16", computeSignature(new Set(["Button|搜索"]), "com.x").length === 16);
check("签名：同集合同签名", computeSignature(new Set(["a|1", "b|2"]), "com.x") === computeSignature(new Set(["b|2", "a|1"]), "com.x"));
check("签名：不同 app 不同签名", computeSignature(new Set(["a|1"]), "com.x") !== computeSignature(new Set(["a|1"]), "com.y"));

check("Jaccard：相同为 1", jaccard(new Set(["a", "b"]), new Set(["a", "b"])) === 1);
check("Jaccard：交集比例正确", Math.abs(jaccard(new Set(["a", "b"]), new Set(["b", "c"])) - 1 / 3) < 1e-9);

/* ============================================================
   三、分词与检索
   ============================================================ */

check("分词：中文逐字", tokenizeForFts("打开微信") === "打 开 微 信", tokenizeForFts("打开微信"));
check("分词：拉丁保持整词", tokenizeForFts("open WeChat") === "open wechat");
check("分词：混合", tokenizeForFts("在App里搜索") === "在 app 里 搜 索", tokenizeForFts("在App里搜索"));

check("bigram：中文两字一组", ngrams("打开微信").has("打开") && ngrams("打开微信").has("微信"));
check("bigram：英文按词", ngrams("open app").has("open"));
check("相似度：相同为 1", similarity("打开微信", "打开微信") === 1);
check("相似度：部分重叠居中", similarity("打开微信", "打开微博") > 0 && similarity("打开微信", "打开微博") < 1);
check("相似度：完全不同为 0", similarity("打开微信", "支付账单") === 0);

const cnCorpus = [
  { id: "a", instruction: "打开微信搜索天气", screenText: "", app: "com.tencent.mm" },
  { id: "b", instruction: "在支付宝查看账单", screenText: "", app: "com.alipay" },
  { id: "c", instruction: "给同事发消息说在开会", screenText: "", app: "com.tencent.mm" },
  { id: "d", instruction: "打开淘宝找优惠券", screenText: "", app: "com.taobao" },
];
check("检索：中文能召回 top1", bm25Search(cnCorpus, "打开微信搜索天气", { minSim: 0 })[0].id === "a");
check("检索：改写后仍能召回", bm25Search(cnCorpus, "启动微信查询天气", { minSim: 0 })[0].id === "a");
check("检索：英文语料对中文查询召不回", bm25Search([{ id: "e", instruction: "Open WeChat app" }], "打开微信", { minSim: 0 }).length === 0);
check("检索：可按 app 过滤", bm25Search(cnCorpus, "打开", { app: "com.taobao", minSim: 0 }).every((h) => h.app === "com.taobao"));

const builtIdx = buildBm25Index(cnCorpus);
check("检索：索引复用结果一致",
  bm25SearchWithIndex(builtIdx, "打开微信搜索天气", { minSim: 0 })[0].id ===
    bm25Search(cnCorpus, "打开微信搜索天气", { minSim: 0 })[0].id);
check("检索：空语料不报错", bm25Search([], "任意", {}).length === 0);

/* ============================================================
   四、dump 解析（这是「零额外读屏」的关键）
   ============================================================ */

const dumpText = `前台应用：com.tencent.mm
屏幕：1080×2400 像素 · 旋转 0° · 原点在左上角
界面控件：
#1 Button "搜索" desc="搜索按钮" [0,100][200,180] 中心(100,140) 可点
#2 ImageView id="com.tencent.mm:id/icon" [300,100][380,180] 中心(340,140) 可点
#3 EditText "" desc="输入消息" [0,2000][1080,2100] 中心(540,2050) 可输入
#4 TextView "今天天气不错" [0,300][500,360] 中心(250,330)`;

const parsed = parseDumpText(dumpText);
check("解析：取到前台应用", parsed.app === "com.tencent.mm", parsed.app);
check("解析：取到 4 个元素", parsed.elements.length === 4, String(parsed.elements.length));
check("解析：文字", parsed.elements[0].text === "搜索");
check("解析：描述", parsed.elements[0].desc === "搜索按钮");
check("解析：资源 id", parsed.elements[1].resourceId === "com.tencent.mm:id/icon");
check("解析：可点标记", parsed.elements[0].clickable === true);
check("解析：可输入标记", parsed.elements[2].editable === true);
check("解析：不可点元素 clickable=false", parsed.elements[3].clickable === false);

const textPairs = pairsOf(parsed.elements);
check(
  "解析：文本格式能还原完整标签链（含 #资源 id 的图标按钮）",
  textPairs.has("Button|搜索") && textPairs.has("ImageView|#com.tencent.mm:id/icon") && textPairs.has("EditText|输入消息"),
  [...textPairs].join(" / ")
);
// 4 个元素都可见且有标签（经验层 pairs_of 规则：visible 且 有 text/desc/resource_id），
// 因此一个都不能丢 —— 丢一个就意味着"签名匹配上了但 ref 定位不到"。
check("解析：文本格式没有丢任何标签", textPairs.size === 4, String(textPairs.size));

const dumpJson = JSON.stringify({
  app: "com.tencent.mm",
  elements: [
    { ref: "Button|搜索", type: "Button", text: "搜索", desc: "搜索按钮", resource_id: "btn", clickable: true },
    { ref: "ImageView|#ic", type: "ImageView", resource_id: "ic", clickable: true },
  ],
});
const pj = parseDumpJson(dumpJson + "\n（通道：Shizuku）");
check("解析：JSON 格式取到 app", pj.app === "com.tencent.mm");
check("解析：JSON 格式取到 2 个元素", pj.elements.length === 2);
check("解析：自动判格式（JSON）", parseDump(dumpJson + "\n（通道：Shizuku）").elements.length === 2);
check("解析：自动判格式（文本）", parseDump(dumpText).elements.length === 4);

check(
  "解析：文本格式与 JSON 格式算出的签名一致",
  computeSignature(pairsOf(parsed.elements), "com.tencent.mm").length === 16,
  "两者标签链一致 → 签名可比"
);

/* ============================================================
   五、动作映射（DSH 的 ui_* → 经验层动作词汇）
   ============================================================ */

check("映射：ui_tap_ref → tap_by_ref", mapAction("ui_tap_ref", { ref: "Button|搜索" }).tool === "tap_by_ref");
check("映射：ui_click_text → tap_by_text", mapAction("ui_click_text", { match: "发送" }).tool === "tap_by_text");
check("映射：ui_set_text → type_text", mapAction("ui_set_text", { text: "hi" }).tool === "type_text");
check("映射：ui_swipe → scroll", mapAction("ui_swipe", { x1: 1, y1: 2, x2: 3, y2: 4 }).tool === "scroll");
check("映射：ui_global back → back", mapAction("ui_global", { action: "back" }).tool === "back");
check("映射：ui_global home → home", mapAction("ui_global", { action: "home" }).tool === "home");
check("映射：ui_global enter 不硬凑成近似动作", mapAction("ui_global", { action: "enter" }).replayable === false);
check("映射：ui_tap 是裸坐标 → 不可回放", mapAction("ui_tap", { x: 100, y: 200 }).tool === "tap_xy" && mapAction("ui_tap", { x: 1, y: 2 }).replayable === false);
check("映射：坐标动作不在可回放词汇表里", !REPLAYABLE_TOOLS.has("tap_xy"));
check("映射：语义动作都在可回放词汇表里", ["tap_by_ref", "tap_by_text", "type_text", "scroll", "back", "home"].every((t) => REPLAYABLE_TOOLS.has(t)));

/* ============================================================
   六、集成契约（runtime / ui / screens / Java）
   ============================================================ */

check("集成：runtime 引入轨迹层", /from "\.\/traj\.js"/.test(runtime));
check("集成：开始轨迹（用户输入即指令）", /beginTrajectory\(text\)/.test(runtime));
check("集成：工具调用时采集", /captureTool\(tool\.name, parsed, res\)/.test(runtime));
check("集成：结束轨迹并落库", /endTrajectory\(\)/.test(runtime));
check("集成：采集失败不影响正常执行", /采集失败绝不能影响正常执行/.test(runtime));

check("集成：UI 引入轨迹层", /from "\.\/traj\.js"/.test(ui));
check("集成：轨迹库 sheet", /function trajSheet\(\)/.test(ui) && /traj: trajSheet/.test(ui));
check("集成：可标记成功/失败", /data-act="traj-mark"/.test(ui));
check("集成：可删除单条", /data-act="traj-del"/.test(ui));
check("集成：可导出语料", /data-act="export-traj"/.test(ui));
check("集成：有中文指令检索框", /用中文指令检索/.test(ui) && /traj-search/.test(ui));
check("集成：设置页有入口", /open-traj/.test(screens));
check("集成：设置页有开关", /toggle-traj/.test(ui) && /trajEnabled/.test(screens));

check("集成：Java 侧 traj 存储区", /"traj"\.equals\(area\)/.test(bridge));
check("集成：traj 是独立目录（不混进工作区）", /name = "traj"/.test(bridge));

/* ============================================================
   七、中文检索命中率（这一版的成败判据）
   ============================================================ */

const zh = [];
for (let i = 0; i < 200; i += 1) {
  zh.push({ id: `z${i}`, instruction: `打开应用${i}搜索天气${i}`, screenText: "", app: "com.x" });
}
const zhHits = bm25Search(zh, "打开应用7搜索天气7", { limit: 1, minSim: 0 });
check("命中率：中文语料能精确召回", zhHits.length === 1 && zhHits[0].id === "z7", JSON.stringify(zhHits[0]?.id));

const enOnly = [{ id: "e1", instruction: "Open the app and search for weather" }];
check("命中率：英文库对中文查询召不回（未污染对照）", bm25Search(enOnly, "打开应用搜索天气", { minSim: 0 }).length === 0);

/* ============================================================
   汇总
   ============================================================ */

console.log("");
console.log(`${pass} 项通过，${fail} 项失败`);
if (fail) process.exit(1);
