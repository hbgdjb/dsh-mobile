/**
 * PPTX 导出测试。
 *
 * 起点是一个明确的能力缺口：办公插件只能导出 docx / xlsx，
 * 「做个 PPT」只能给一份大纲让用户自己排版。
 *
 * 这里的 PPT 不是「把 Markdown 塞进一个 .pptx 壳子」——
 * 那样打开是满屏项目符号、字号字号全一样。要求是：
 *   1) 结构正确：13.333×7.5 英寸、每页一张 slide、页与页编号连续
 *   2) 包正确：PowerPoint 能打开的最小 OOXML 集合一个不少
 *   3) 排版成立：要点分级、有序列表真的编号、表格真表格
 *   4) 内容不丢：标题、副标题、要点按原文进去，& < > 不破坏 XML
 *   5) 过长自动分页，而不是把字压到看不见
 *
 * 用法：node tests/office-pptx-test.mjs
 */
import { buildDeck, markdownToPptx } from "../scripts/pptx.js";

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

/** 只认 store 模式的 ZIP —— 导出器就是这么写的，够用。 */
function unzip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return {};
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const files = {};
  for (let i = 0; i < count; i += 1) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const nlen = dv.getUint16(off + 28, true);
    const elen = dv.getUint16(off + 30, true);
    const clen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nlen));
    const lnameLen = dv.getUint16(lho + 26, true);
    const lextra = dv.getUint16(lho + 28, true);
    const size = dv.getUint32(lho + 22, true);
    const start = lho + 30 + lnameLen + lextra;
    files[name] = new TextDecoder().decode(buf.subarray(start, start + size));
    off += 46 + nlen + elen + clen;
  }
  return files;
}

const SAMPLE = `# 二季度经营复盘

> 三条主线：收入结构、成本效率、下季度重点

## 收入结构

- 订阅收入占比升到 **62%**
  - 东南亚按月付费
- 海外区首次转正

## 成本效率

### 人力

- 研发人均产出 +11%

## 关键指标

| 指标 | 本季 | 目标 |
| --- | --- | --- |
| 收入 | 1.82 亿 | 1.75 亿 |
| 毛利率 | 71% | 70% |

## 下季度三件事

1. 订阅转化率提到 22%
2. 交付并入客户成功
3. 海外只保东南亚
`;

console.log("[1] 包结构");
const { bytes, slides } = buildDeck(SAMPLE, "二季度经营复盘");
const files = unzip(bytes);
check("返回字节数组", bytes instanceof Uint8Array && bytes.length > 2000, `${bytes.length}B`);
check("以 ZIP 魔数开头", bytes[0] === 0x50 && bytes[1] === 0x4b);
const need = [
  "[Content_Types].xml",
  "_rels/.rels",
  "ppt/presentation.xml",
  "ppt/_rels/presentation.xml.rels",
  "ppt/slideMasters/slideMaster1.xml",
  "ppt/slideMasters/_rels/slideMaster1.xml.rels",
  "ppt/slideLayouts/slideLayout1.xml",
  "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
  "ppt/theme/theme1.xml",
];
need.forEach((n) => check(`包含 ${n}`, !!files[n], files[n] ? `${files[n].length}B` : "缺失"));

console.log("\n[2] 幻灯片切页");
check("页数 = 封面 + 4 个 ##（### 并入本页）", slides.length === 5, slides.map((s) => s.title).join(" / "));
check("第一页是封面", slides[0].type === "title");
check("封面取 # 标题", /二季度经营复盘/.test(files["ppt/slides/slide1.xml"]));
check("封面取 > 作副标题", /三条主线/.test(files["ppt/slides/slide1.xml"]));
check(
  "每页都有对应 part",
  slides.every((_, i) => !!files[`ppt/slides/slide${i + 1}.xml`])
);
check(
  "sldId 连续",
  /<p:sldId id="256" r:id="rId2"\/>/.test(files["ppt/presentation.xml"]) &&
    files["ppt/presentation.xml"].match(/<p:sldId /g).length === slides.length
);
check("16:9 尺寸", /cx="12192000" cy="6858000"/.test(files["ppt/presentation.xml"]));
check(
  "presentation.rels 里回指主题",
  new RegExp(`rId${slides.length + 2}.*theme1\\.xml`).test(files["ppt/_rels/presentation.xml.rels"])
);

console.log("\n[3] 版式");
const s2 = files["ppt/slides/slide2.xml"];
check("正文页有标题", /收入结构/.test(s2));
check("顶部有分隔线", /name="Rule"/.test(s2));
check("二级要点用不同符号", /char="–"/.test(s2));
check("正文页有页码", /2 \/ 5/.test(s2));
check("封面无页码", !/1 \/ 5/.test(files["ppt/slides/slide1.xml"]));

console.log("\n[4] 有序列表与表格");
const s5 = files["ppt/slides/slide5.xml"];
const nums = [...s5.matchAll(/buAutoNum type="arabicPeriod" startAt="(\d+)"/g)].map((m) => m[1]);
check("有序列表用自动编号", nums.length === 3, nums.join(","));
check("编号从 1 递增到 3", nums.join(",") === "1,2,3");
const s4 = files["ppt/slides/slide4.xml"];
check("表格页含 a:tbl", /<a:tbl>/.test(s4));
check("表格行数正确（表头 + 2 行）", (s4.match(/<a:tr /g) || []).length === 3);
check("表头有底色", /F4F6FA/.test(s4));

console.log("\n[5] 分页与边界");
const long = `# 长页\n\n## 要点很多\n\n${Array.from({ length: 9 }, (_, i) => `- 第 ${i + 1} 条`).join("\n")}\n`;
const longDeck = buildDeck(long, "长页");
check("超过 6 条自动拆页", longDeck.slides.length === 3, longDeck.slides.map((s) => s.title).join(" / "));
check("续页带（续）", longDeck.slides[2].title.includes("（续）"));

const noH1 = buildDeck("## 只有二级标题\n\n- 一条\n", "备用标题");
check("没有 # 时自动补封面", noH1.slides[0].type === "title");
check("封面标题回退到文档标题", noH1.slides[0].title === "备用标题", noH1.slides[0].title);

const empty = buildDeck("", "空文档");
check("空内容也能导出", empty.bytes.length > 1000 && empty.slides.length === 1);

const dirty = buildDeck('# A & B <tag> "q"\n\n- x & y < z\n', "t");
const xmlText = unzip(dirty.bytes)["ppt/slides/slide1.xml"];
check("特殊字符被转义", /A &amp; B &lt;tag&gt;/.test(xmlText));
check("没有裸 & 破坏 XML", !/&(?!(amp|lt|gt|quot|apos);)/.test(xmlText));

const divider = buildDeck("## 第一节\n\n## 第二节\n\n- 内容\n", "t");
check("以 ## 开头时仍保留第一页内容", divider.slides.length === 3, divider.slides.map((s) => `${s.type}:${s.title}`).join(" / "));
const dFiles = unzip(divider.bytes);
check("只有标题的页去掉页脚页码", !/name="Page"/.test(dFiles["ppt/slides/slide2.xml"]));
check("只有标题的页标题放大", /sz="3400"/.test(dFiles["ppt/slides/slide2.xml"]));

console.log("\n[6] 结构自洽");
const allIdsOk = Object.keys(files)
  .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
  .every((n) => {
    const ids = [...files[n].matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]);
    return new Set(ids).size === ids.length;
  });
check("每页形状 id 不重复", allIdsOk);
const ctypes = files["[Content_Types].xml"];
check("内容类型覆盖每页", slides.every((_, i) => ctypes.includes(`/ppt/slides/slide${i + 1}.xml`)));
check(
  "每页都在 presentation.rels 里",
  slides.every((_, i) => files["ppt/_rels/presentation.xml.rels"].includes(`slides/slide${i + 1}.xml`))
);
check("markdownToPptx 兼容字节返回", markdownToPptx(SAMPLE) instanceof Uint8Array);

const dash = buildDeck("## 甲\n\n- 一\n\n---\n\n- 二\n", "t");
check("--- 之后无标题时沿用上一页标题", dash.slides[2].title === "甲", dash.slides.map((s) => s.title).join(" / "));
const noTitle = buildDeck("---\n\n- 孤立的要点\n", "兜底标题");
check("唯一的页没有标题时用文档名兜底", noTitle.slides.every((s) => !!s.title), noTitle.slides.map((s) => s.title).join(" / "));

console.log("\n==================================================");
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log("==================================================");
process.exit(fail ? 1 : 0);
