/* ============================================================
   PDF 工具测试（tests/office-pdf-test.mjs）

   ============ 这一轮补的是什么 ============
   办公能力缺两块最常用的：读 PDF、出 PDF。
     · 读：以前 fs_inspect 只能说「PDF 文档，约 12 页」，正文拿不到
     · 写：只能出 docx / pptx / xlsx，用户要 PDF 得自己转

   这里守的边界：
     1) 中文能写进去、也能读回来（不是豆腐块、不是乱码）
     2) 字体按需子集 —— 一份短文档不该带 2 MB 字体
     3) 分页、页脚、表格、列表、代码块这些原语真的落到页面上
     4) 图片（JPEG / 无透明 PNG）能嵌；带透明的要说清楚原因
     5) 读不出来的情况（扫描件、加密）必须明确说，不能假装读到了
     6) 缺字（emoji）要报告，而不是静默变空白

   运行：node tests/office-pdf-test.mjs
   ============================================================ */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { buildPdf } from "../scripts/pdf-write.js";
import { readPdf as readOnly } from "../scripts/pdf.js";

const ROOT = new URL("..", import.meta.url).pathname;
const FONT = new URL("../scripts/fonts/noto-sans-sc.ttf", import.meta.url).pathname;
const SYM = new URL("../scripts/fonts/dejavu-symbols.ttf", import.meta.url).pathname;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? ` ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` → ${detail}` : ""}`);
  }
};

if (!existsSync(FONT)) {
  console.log("缺少字体文件 scripts/fonts/noto-sans-sc.ttf");
  process.exit(1);
}

const { setFontBytes } = await import("../scripts/pdf-write.js");
const mainBytes = new Uint8Array(readFileSync(FONT));
const symBytes = existsSync(SYM) ? new Uint8Array(readFileSync(SYM)) : null;
setFontBytes(mainBytes, symBytes);
console.log(`字体：主 ${(mainBytes.length / 1048576).toFixed(2)} MB，符号 ${symBytes ? (symBytes.length / 1024).toFixed(0) + " KB" : "无"}`);

const tmp = "/tmp/dsh-pdf-test";
mkdirSync(tmp, { recursive: true });

/* ---------------- 1. 基本生成 ---------------- */
console.log("\n[1] 生成与回读");
const basic = [
  { type: "h1", text: "季度经营分析" },
  { type: "p", text: "本季度收入 **1.24 亿元**，同比增长 18.4%。毛利率 43.7%。" },
  { type: "bullets", items: ["华东 +22.1%", "华南 +19.6%", "华北 +9.2%"] },
  { type: "numbers", items: ["复制华东打法", "收紧折扣", "渠道分层"] },
  { type: "table", rows: [["区域", "收入", "同比"], ["华东", "4,820", "+22.1%"], ["华南", "3,150", "+19.6%"]] },
  { type: "quote", text: "增长由存量客户扩购驱动。" },
  { type: "code", text: "SELECT region, SUM(amount)\nFROM orders\nGROUP BY region;" },
];
const r1 = await buildPdf(basic, { title: "季度经营分析" });
writeFileSync(`${tmp}/basic.pdf`, r1.bytes);
check("生成成功", r1.bytes.length > 2000 && r1.bytes[0] === 0x25 && r1.bytes[1] === 0x50, `${(r1.bytes.length / 1024).toFixed(1)} KB`);
check("页数为 1", r1.pages === 1, `pages=${r1.pages}`);
check("无缺字", r1.missing.length === 0, r1.missing.join(""));

const back = await readOnly(r1.bytes);
const text1 = back.pages.map((p) => p.text).join("\n");
check("回读能拿到中文标题", text1.includes("季度经营分析"));
check("回读能拿到正文数字", text1.includes("1.24 亿元") && text1.includes("18.4%"));
check("回读包含列表项", text1.includes("华东 +22.1%") && text1.includes("渠道分层"));
check("回读包含表格单元格", text1.includes("4,820") && text1.includes("+19.6%"));
check("回读包含引用", text1.includes("增长由存量客户扩购驱动"));
check("回读包含代码", text1.includes("SELECT region"));
check("页数一致", back.totalPages === 1);

/* ---------------- 2. 字体子集 ---------------- */
console.log("\n[2] 字体子集");
const tiny = await buildPdf([{ type: "p", text: "你好" }]);
check("两个字也完整", (await readOnly(tiny.bytes)).pages[0].text.includes("你好"));
check("字体随内容增长而不是固定 2 MB", tiny.bytes.length < 60 * 1024, `${(tiny.bytes.length / 1024).toFixed(1)} KB`);
const big = await buildPdf([{ type: "p", text: "这是一段比较长的正文，用来把常用汉字的字形都带进来，看看子集是不是跟着内容走。".repeat(6) }]);
check("长文比短文大", big.bytes.length > tiny.bytes.length);

/* ---------------- 3. 分页与页脚 ---------------- */
console.log("\n[3] 分页");
const long = [];
long.push({ type: "h1", text: "长文档" });
for (let i = 1; i <= 40; i += 1) {
  long.push({ type: "h2", text: `第 ${i} 节` });
  long.push({ type: "p", text: "正文用来把页面填满，验证自动分页、行距和页脚编号是否正确。".repeat(3) });
}
const r3 = await buildPdf(long);
check("长文档分成多页", r3.pages >= 4, `pages=${r3.pages}`);
const b3 = await readOnly(r3.bytes);
check("每页都有页脚页码", b3.pages.every((p) => p.text.includes("/") && p.text.trim().endsWith(`${p.index} / ${r3.pages}`)), "last line");
check("最后一节还在", b3.pages.map((p) => p.text).join("").includes("第 40 节"));

/* ---------------- 4. 图片 ---------------- */
console.log("\n[4] 图片");
// 造一张 JPEG 与一张无透明 PNG（用最小的合法样本太脆，这里用现成的 PIL 产物）
const jpeg = readFileSync(new URL("./fixtures/chart.jpg", import.meta.url));
const png = readFileSync(new URL("./fixtures/chart.png", import.meta.url));
const withImg = await buildPdf(
  [
    { type: "p", text: "下图是收入结构。" },
    { type: "image", src: "chart.jpg", caption: "图 1 收入结构" },
    { type: "image", src: "chart.png", caption: "图 2 渠道分布" },
  ],
  { images: { "chart.jpg": new Uint8Array(jpeg), "chart.png": new Uint8Array(png) } }
);
const imgText = (await readOnly(withImg.bytes)).pages.map((p) => p.text).join("\n");
check("图注进入正文", imgText.includes("图 1 收入结构") && imgText.includes("图 2 渠道分布"));
const raw = Buffer.from(withImg.bytes).toString("latin1");
check("JPEG 用 DCTDecode", raw.includes("/DCTDecode"));
check("PNG 用 FlateDecode + predictor", raw.includes("/FlateDecode") && raw.includes("/Predictor 15"));

/* ---------------- 5. 缺字与异常输入 ---------------- */
console.log("\n[5] 边界");
const emoji = await buildPdf([{ type: "p", text: "完成 🎉 下一步 👉 上线" }]);
check("emoji 被报告为缺字", emoji.missing.some((c) => c === "🎉" || c === "👉"), emoji.missing.join(""));
const sym = await buildPdf([{ type: "p", text: "增长 → 超额 ✓ 完成 ① 阶段" }]);
check("箭头与勾选能排进去", sym.missing.length === 0, sym.missing.join(""));
const arrowText = (await readOnly(sym.bytes)).pages[0].text;
check("箭头回读正确", arrowText.includes("→") && arrowText.includes("✓"));

const mdPdf = await buildPdf("# 标题\n\n正文一段。\n\n- 甲\n- 乙\n\n| A | B |\n| --- | --- |\n| 1 | 2 |");
const mdText = (await readOnly(mdPdf.bytes)).pages[0].text;
check("Markdown 映射成块", mdText.includes("标题") && mdText.includes("甲") && mdText.includes("乙") && mdText.includes("2"));

/* ---------------- 6. 读真实 PDF ---------------- */
console.log("\n[6] 读别人的 PDF");
const sample = new Uint8Array(readFileSync(new URL("./fixtures/reportlab-cn.pdf", import.meta.url)));
const s = await readOnly(sample);
check("读到 2 页", s.totalPages === 2, `pages=${s.totalPages}`);
check("中文正文正确", s.pages[0].text.includes("本季度收入同比增长 18.4%"));
check("表格同行", s.pages[0].text.includes("区域 收入 同比"));
check("第二页", s.pages[1].text.includes("供应链单点依赖"));

const scanned = new Uint8Array(readFileSync(new URL("./fixtures/scanned.pdf", import.meta.url)));
const sc = await readOnly(scanned);
check("纯图片 PDF 没有文本层", sc.pages.every((p) => !p.text), `empty=${sc.emptyPages}`);
check("判定为扫描件", sc.scanned === true);

/* ---------------- 7. 结构完整性 ---------------- */
console.log("\n[7] 结构");
const r7 = r1.bytes;
const str7 = Buffer.from(r7).toString("latin1");
check("有 xref", str7.includes("\nxref\n") && str7.includes("trailer"));
check("startxref 指向 xref", (() => {
  const idx = str7.lastIndexOf("startxref");
  const off = Number(str7.slice(idx + 10).trim().split("\n")[0]);
  return str7.slice(off, off + 5) === "xref\n";
})());
check("对象数 >= 页面数×2", (str7.match(/\d+ 0 obj/g) || []).length >= r1.pages * 2);
check("ToUnicode 存在", str7.includes("/ToUnicode"));
check("字体已嵌入", str7.includes("/FontFile2"));

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
