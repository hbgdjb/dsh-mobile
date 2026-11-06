/* ============================================================
   两颗球必须是同一颗（0.65.1）

   悬浮窗那颗是原生 DshBotView.java 画的，首页那颗是 Web 端
   scripts/dsh-ball.js 画的 —— 同一套参数、两个人维护。

   0.65.0 就栽在这上面：Web 端把白肚皮往下挪了半个半径，原生没动，
   结果悬浮窗是一张"白脸"，首页是"蓝球 + 底下一小块白"，用户一眼
   看出"不对吧，这不是悬浮窗上那个球"。

   所以这里逐项比对两边的长相参数，并且盯住肚皮的落点：偏移可以改，
   但必须两边一起改；单边漂移立刻红。
   ============================================================ */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const js = await readFile(join(ROOT, "scripts/dsh-ball.js"), "utf8");
const java = await readFile(join(ROOT, "android/java/DshBotView.java"), "utf8");

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass += 1;
    console.log(`✓ ${name}${extra ? " " + extra : ""}`);
  } else {
    fail += 1;
    console.log(`✗ ${name}${extra ? " " + extra : ""}`);
  }
}

const grab = (src, re, from = 0) => {
  const m = src.slice(from).match(re);
  return m ? m.slice(1).map(Number) : null;
};
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

/* ---------------- 1. 体型与五官 ---------------- */

const jsRadius = grab(js, /radius:\s*(-?[\d.]+),/) ?? [];
const javaRadius = grab(java, /private static final float R = (-?[\d.]+)f/) ?? [];
check(
  "球的半径一致",
  jsRadius.length && javaRadius.length && near(jsRadius[0], javaRadius[0]),
  `js ${jsRadius[0]} / java ${javaRadius[0]}`
);

const jsCenter = grab(js, /center:\s*\{\s*x:\s*(-?[\d.]+),\s*y:\s*(-?[\d.]+)\s*\}/) ?? [];
const javaCenter = grab(java, /CENTER_X = (-?[\d.]+)f, CENTER_Y = (-?[\d.]+)f/) ?? [];
check(
  "球心位置一致",
  jsCenter.length === 2 && javaCenter.length === 2 && near(jsCenter[0], javaCenter[0]) && near(jsCenter[1], javaCenter[1]),
  `js ${jsCenter.join(",")} / java ${javaCenter.join(",")}`
);

const jsFace = grab(js, /face:\s*\{\s*x:\s*(-?[\d.]+),\s*y:\s*(-?[\d.]+)\s*\}/) ?? [];
const javaFace = grab(java, /FACE_X = (-?[\d.]+)f, FACE_Y = (-?[\d.]+)f/) ?? [];
check(
  "眼睛群落的落点一致",
  jsFace.length === 2 && javaFace.length === 2 && near(jsFace[0], javaFace[0]) && near(jsFace[1], javaFace[1]),
  `js ${jsFace.join(",")} / java ${javaFace.join(",")}`
);

const jsEye = grab(js, /eye:\s*\{\s*height:\s*(-?[\d.]+),\s*width:\s*(-?[\d.]+),\s*round:\s*[\d.]+,\s*spread:\s*(-?[\d.]+)\s*\}/) ?? [];
const javaEye = grab(
  java,
  /EYE_HEIGHT = (-?[\d.]+)f, EYE_WIDTH = (-?[\d.]+)f, EYE_SPREAD = (-?[\d.]+)f/
) ?? [];
check(
  "眼睛的高/宽/间距一致",
  jsEye.length === 3 && javaEye.length === 3 && jsEye.every((v, i) => near(v, javaEye[i])),
  `js ${jsEye.join("/")} / java ${javaEye.join("/")}`
);

/* ---------------- 2. 白肚皮：尺寸 + 落点 ---------------- */

const jsBelly = grab(
  js,
  /belly:\s*\{\s*x0:\s*(-?[\d.]+),\s*y0:\s*(-?[\d.]+),\s*x1:\s*(-?[\d.]+),\s*y1:\s*(-?[\d.]+)/
) ?? [];
const javaBelly = grab(java, /BELLY_W = (-?[\d.]+)f, BELLY_H = (-?[\d.]+)f/) ?? [];
const jsBW = jsBelly[2] - jsBelly[0];
const jsBH = jsBelly[3] - jsBelly[1];
check(
  "肚皮的宽高一致",
  jsBelly.length === 4 && javaBelly.length === 2 && near(jsBW, javaBelly[0]) && near(jsBH, javaBelly[1]),
  `js ${jsBW.toFixed(2)}×${jsBH.toFixed(2)} / java ${javaBelly[0]}×${javaBelly[1]}`
);

// 落点：两边都必须"以球心为中心"，谁都不许再自己加偏移。
const jsBellyAt = /ctx\.translate\(spec\.center\.x,\s*spec\.center\.y\s*\);/.test(js);
const javaBellyAt = /canvas\.translate\(CENTER_X,\s*CENTER_Y\s*\);/.test(java);
check("首页肚皮画在球心", jsBellyAt, jsBellyAt ? "" : "有人给它加了偏移");
check("悬浮窗肚皮画在球心", javaBellyAt, javaBellyAt ? "" : "有人给它加了偏移");
check("两边肚皮落点一致", jsBellyAt === javaBellyAt);

/* ---------------- 3. 颜色 ---------------- */

const hex = (n) => "#" + n.toString(16).padStart(6, "0").toLowerCase();
const jsColor = (name) => {
  const m = js.match(new RegExp(`${name} = "(#[0-9a-fA-F]{6})"`));
  return m ? m[1].toLowerCase() : null;
};
const javaColor = (name) => {
  const m = java.match(new RegExp(`${name} = 0xFF([0-9A-Fa-f]{6})`));
  return m ? hex(parseInt(m[1], 16)) : null;
};
for (const [jsName, javaName, label] of [
  ["BODY_TOP", "BODY_TOP", "球身上缘"],
  ["BODY_MID", "BODY_MID", "球身中段"],
  ["BODY_BOTTOM", "BODY_BOTTOM", "球身下缘"],
  ["INK", "INK", "眼睛墨色"],
]) {
  check(`配色一致：${label}`, jsColor(jsName) === javaColor(javaName), `${jsColor(jsName)} / ${javaColor(javaName)}`);
}
const jsBellyColor = js.match(/belly:\s*\{[^}]*color:\s*"(#[0-9a-fA-F]{6})"/);
const javaBellyColor = java.match(/BELLY_COLOR = 0xFF([0-9A-Fa-f]{6})/);
check(
  "配色一致：白肚皮",
  !!jsBellyColor && !!javaBellyColor && jsBellyColor[1].toLowerCase() === hex(parseInt(javaBellyColor[1], 16)),
  `${jsBellyColor?.[1]} / ${javaBellyColor ? hex(parseInt(javaBellyColor[1], 16)) : null}`
);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
