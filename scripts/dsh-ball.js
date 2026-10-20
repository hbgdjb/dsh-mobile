/* ============================================================
   DSH 小球动画 — 移植自 agent-hud-open（Apache-2.0）的 DeepSeek Bot
   原作为 macOS 灵动岛里的「小 Bot」：agent 的图标在待命时化作一颗
   带眼睛的小球，思考、干活、等待审批、完成、失败各有动作。
   本文件是其 Web（Canvas 2D）移植：同一条参数、同一套状态机、
   同一条时间曲线，坐标与角度逐一对应。

   原 Swift 源码：Sources/AgentHUDDesktop/Bots/
     BotSpec.swift    — 每个 agent 的小球长相（DeepSeek：蓝球+白肚皮+三鳍+交叉眼）
     BotMotion.swift  — 状态机：形态渐变/呼吸/眨眼/随机小动作/思考/干活/完成/失败
     BotMoves.swift   — 各动作的时间曲线
     BotFins.swift    — 鱼鳍轮廓（圆头圆尾的桨形）
     BotSigns.swift   — 头顶 5×7 像素符号（! ? ≡ × ⧗ … z）
     BotRenderer.swift— 逐帧绘制
   ============================================================ */

/* ---------------- 工具 ---------------- */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const easeOutBack = (x) => {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
};

/** 与原作相同的 seeded 随机数（SplitMix64），小动作可复现。 */
class SplitMix {
  constructor(seed) {
    this.state = (BigInt(seed >>> 0) * 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    if (this.state === 0n) this.state = 0x123456789abcdefn;
  }
  next() {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
    return z ^ (z >> 31n);
  }
  /** [0, 1) */
  unit() {
    return Number(this.next() >> 11n) / Number(1n << 53n);
  }
}

/* ---------------- DeepSeek 小球参数（BotSpec.swift 逐值移植） ----------------
   默认值：eye 默认（高 0.62 宽 0.25 全圆角，spread 0.34），crossesEyes true。
   face (0, -0.14)：眼睛群落在球心偏下。
   本地改动：① 按需求去掉三只鳍（fins 置空，只留光球）；② radius 0.36 → 0.5，
   球撑满 mark 方框（悬浮窗里更大更醒目）。 */
const SPEC = {
  radius: 0.5,
  center: { x: 0.5, y: 0.5 },
  reach: 1,
  face: { x: 0, y: -0.14 },
  eye: { height: 0.62, width: 0.25, round: 1, spread: 0.34 },
  crossesEyes: true,
  settle: 0,
  fins: [],
  finColor: "#3f5ae6",
  belly: { x0: -0.86, y0: 0.34, x1: 0.86, y1: 1.9, round: 1, color: "#c9d4ff" },
};

/** 深海的蓝：原作 paint 为 .artwork（logo 自身的颜色场），此处以其品牌蓝近似。 */
const BODY_TOP = "#6d86ff";
const BODY_MID = "#4d6bfe";
const BODY_BOTTOM = "#3f5ae6";
const INK = "#0d0d10"; // 眼睛的墨色（灵动岛的黑，从任何身色上都读作镂空）
const SIGN_EDGE = "rgba(13,13,15,0.6)"; // 符号的深色描边
const SIGN_EDGE_FAINT = "rgba(13,13,15,0.21)"; // 0.6 * faint

/* ---------------- 头顶符号（BotSigns.swift 逐行移植） ---------------- */

const SIGN_ROWS = {
  exclamation: ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
  question: [".###.", "#...#", "....#", "..##.", "..#..", ".....", "..#.."],
  lines: [".....", "#####", ".....", "#####", ".....", "#####", "....."],
  cross: [".....", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "....."],
  hourglass: [".....", "#####", ".#.#.", "..#..", ".###.", "#####", "....."],
  ellipsis: [".....", ".....", ".....", ".....", ".....", ".....", "#.#.#"],
  z: [".....", ".....", "#####", "...#.", "..#..", ".#...", "#####"],
};
const SIGN_COLS = 5;
const SIGN_ROWS_N = 7;
const SIGN_FAINT = 0.35;
const SIGN_RANK = { exclamation: 0, question: 1, lines: 2, cross: 3, hourglass: 4, ellipsis: 5, z: 6 };

/** 两个符号谁说了算：rawValue 小者胜（BotSign.shown）。 */
function signShown(one, other) {
  if (!one) return other || null;
  if (!other) return one;
  return SIGN_RANK[one] <= SIGN_RANK[other] ? one : other;
}

function signBits(sign) {
  return (SIGN_ROWS[sign] || []).map((row) =>
    row.split("").reduce((acc, ch) => (acc << 1) | (ch === "#" ? 1 : 0), 0)
  );
}

/* ---------------- 鱼鳍轮廓（BotFins.swift 移植） ----------------
   圆头圆尾的桨形：根圆与尖圆外加两条公切线。 */
function finPathPoints(fin, grown, raised) {
  const angle = ((fin.angle - fin.hand * raised) * Math.PI) / 180;
  const along = { x: Math.cos(angle), y: Math.sin(angle) };
  const across = { x: Math.sin(angle), y: -Math.cos(angle) };
  const length = fin.length * grown;
  const a = fin.root;
  const ra = fin.base * grown;
  const rb = fin.tip * grown;
  const b = {
    x: a.x + along.x * (length - rb) + across.x * fin.sweep * grown,
    y: a.y + along.y * (length - rb) + across.y * fin.sweep * grown,
  };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.max(1e-6, Math.hypot(dx, dy));
  const s = clamp((ra - rb) / d, -1, 1);
  const c = Math.sqrt(1 - s * s);
  const toward = Math.atan2(dy, dx);
  const spread = Math.atan2(c, s);
  const pts = [];
  const arc = (cx, cy, r, from, to) => {
    const steps = Math.max(2, Math.ceil((to - from) / (Math.PI / 16)));
    for (let i = 0; i <= steps; i++) {
      const ang = from + ((to - from) * i) / steps;
      pts.push({ x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) });
    }
  };
  // 先绕尖圆，再绕根圆，闭合。
  arc(b.x, b.y, rb, toward - spread, toward + spread);
  arc(a.x, a.y, ra, toward + spread, toward + 2 * Math.PI - spread);
  return pts;
}

/* ---------------- 鲸鱼 logo 的轮廓采样（BotForm.reach 移植） ----------------
   按角度从球心向外步进，记录最后一个不透明像素的距离，
   morph 时与圆身逐角度混合——鲸鱼就此"化成"一颗球。 */
const GRAIN = 256;
const SAMPLES = 360;

function sampleLogoReach(image) {
  const cv = document.createElement("canvas");
  cv.width = GRAIN;
  cv.height = GRAIN;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.clearRect(0, 0, GRAIN, GRAIN);
  cx.drawImage(image, 0, 0, GRAIN, GRAIN);
  let data;
  try {
    data = cx.getImageData(0, 0, GRAIN, GRAIN).data;
  } catch {
    return null;
  }
  const startX = SPEC.center.x * GRAIN;
  const startY = SPEC.center.y * GRAIN;
  const reach = new Array(SAMPLES);
  for (let i = 0; i < SAMPLES; i++) {
    const angle = (i * 2 * Math.PI) / SAMPLES;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let last = 0;
    for (let dist = 0; dist < (GRAIN * 3) / 2; dist++) {
      const x = Math.round(startX + dx * dist);
      const y = Math.round(startY + dy * dist);
      if (x < 0 || y < 0 || x >= GRAIN || y >= GRAIN) break;
      if (data[(y * GRAIN + x) * 4 + 3] > 127) last = dist;
    }
    reach[i] = Math.max(0.02, last / GRAIN);
  }
  return reach;
}

/* ---------------- 动作曲线（BotMoves.swift 移植） ---------------- */

const MOVES = {
  beat: 0.125, // 干活的一拍
  burst: 3,
  cycle: 4.5,
  paddle: 14, // 鱼鳍随每一次点头抬起的度数
  ponderGaze: { x: 0.4, y: -0.7 },
  ponderTilt: 5,
  ponder: 2.5,
  fullWait: 8,
  firstMove: 1.2,
  hopSeconds: 0.3, // 打招呼的小跳
  finWaveSeconds: 0.9,
  cheerStart: 0.3,
  cheerSeconds: 1.2,
};

const HOP_ATTENTION = 0.45; // 等待时的跳起（BotMotion.hopSeconds）
const MORPH_SECONDS = 0.5;
const BLEND_SECONDS = 0.3;
const DONE_SECONDS = 2.4;
const LONGEST_STEP = 1 / 6;
const PACE_LIVELY = 1 / 24;
const PACE_SLACK = 0.004;

const onFrame = (now) => {
  const frame = Math.round(now / PACE_LIVELY) * PACE_LIVELY;
  return Math.abs(frame - now) <= PACE_SLACK ? frame : now;
};

const inBurst = (t) => Math.max(0, t) % MOVES.cycle < MOVES.burst - 1e-6;
const bobAt = (t) => (inBurst(t) && Math.floor(Math.max(0, t) / MOVES.beat + 1e-6) % 2 === 1 ? 0.04 : 0);

const ponderSide = (now) => (Math.floor(now / MOVES.ponder + 1e-6) % 2 === 0 ? 1 : -1);

/** 等待请求的一连串小动作：首次在 1.2s，其后每 2.6s，两分钟后每 8s。 */
function moveAt(age) {
  const first = MOVES.firstMove;
  const often = 2.6;
  const rarely = 8.0;
  if (age < first) return { index: -1, start: null, next: first };
  const frequent = Math.ceil((120 - first) / often);
  const late = first + frequent * often;
  if (age < late - 1e-9) {
    const index = Math.floor((age - first) / often + 1e-9);
    return { index, start: first + index * often, next: first + (index + 1) * often };
  }
  const index = Math.floor((age - late) / rarely + 1e-9);
  return { index: frequent + index, start: late + index * rarely, next: late + (index + 1) * rarely };
}
const moveLength = (look) => (look === "question" ? 0.4 : look === "plan" ? 0.6 : 0.55);

const knock = (t) => {
  if (t < 0 || t >= 0.55) return 0;
  const x = t / 0.55;
  return 8 * Math.sin(2 * Math.PI * 2.5 * x) * (1 - x);
};
const questionTilt = (age) => {
  const move = moveAt(age);
  if (move.start === null) return 0;
  const side = move.index % 2 === 0 ? 1 : -1;
  const from = move.index === 0 ? 0 : -12 * side;
  const x = clamp((age - move.start) / moveLength("question"), 0, 1);
  return from + (12 * side - from) * easeInOut(x);
};
const nod = (t) => {
  if (t < 0 || t >= moveLength("plan")) return 0;
  const half = t / (moveLength("plan") / 2);
  return 0.03 * Math.sin(Math.PI * (half - Math.floor(half)));
};
const hop = (t) => {
  if (t < 0 || t >= MOVES.hopSeconds) return 0;
  const x = t / MOVES.hopSeconds;
  return -0.06 * 4 * x * (1 - x);
};
const shake = (t) => {
  if (t < 0 || t >= 0.5) return 0;
  return 0.05 * Math.sin(2 * Math.PI * 6 * t) * (1 - t / 0.5);
};
const sag = (t) => {
  if (t < 0.5) return 0;
  if (t < 0.75) return easeInOut((t - 0.5) / 0.25);
  if (t < 1.2) return 1;
  if (t < 1.5) return 1 - easeInOut((t - 1.2) / 0.3);
  return 0;
};
const sigh = (t) => {
  const u = Math.max(0, t) / 1.2;
  if (u < 0.4) {
    const k = easeInOut(u / 0.4);
    return { scaleX: 1 - 0.04 * k, scaleY: 1 + 0.07 * k, open: 1 - 0.7 * k };
  }
  if (u < 0.7) {
    const k = easeInOut((u - 0.4) / 0.3);
    return { scaleX: 0.96 + 0.1 * k, scaleY: 1.07 - 0.15 * k, open: 0.3 + 0.2 * k };
  }
  const k = easeInOut(Math.min(1, (u - 0.7) / 0.3));
  return { scaleX: 1.06 - 0.06 * k, scaleY: 0.92 + 0.08 * k, open: 0.5 + 0.5 * k };
};
const finFlap = (t) => {
  if (t < 0 || t >= MOVES.hopSeconds) return 0;
  return 32 * Math.sin((Math.PI * t) / MOVES.hopSeconds);
};
const finWave = (t) => {
  if (t < 0 || t >= MOVES.finWaveSeconds) return 0;
  const rise = 0.18;
  const up = easeInOut(Math.min(1, t / rise)) * easeInOut(Math.min(1, (MOVES.finWaveSeconds - t) / rise));
  return up * (34 + 12 * Math.sin((2 * Math.PI * (t - rise)) / 0.27));
};
const cheer = (age) => {
  const t = age - MOVES.cheerStart;
  if (t < 0 || t >= MOVES.cheerSeconds) return 0;
  return 30 * Math.abs(Math.sin((Math.PI * t) / (MOVES.cheerSeconds / 3)));
};

const LOOK = {
  isAttention: (l) => l === "permission" || l === "question" || l === "plan",
  isWorking: (l) => l === "compacting" || l === "thinking" || l === "tool" || l === "plain",
  isCalm: (l) => l === "noNews" || l === "idle" || l === "asleep",
  staysInPlace: (l) => LOOK.isWorking(l) || LOOK.isCalm(l),
};

/* ---------------- 状态机（BotMotion.swift 移植，去肢/去伴生/去旋转） ---------------- */

const zeroPose = () => ({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, footing: 0 });
const mixPose = (a, b, share) => {
  const mix = (p, q) => p + (q - p) * share;
  return {
    x: mix(a.x, b.x),
    y: mix(a.y, b.y),
    rotation: mix(a.rotation, b.rotation),
    scaleX: mix(a.scaleX, b.scaleX),
    scaleY: mix(a.scaleY, b.scaleY),
    footing: mix(a.footing, b.footing),
  };
};

const ACT_POOL = [
  ["glance", 5],
  ["blinkTwice", 2],
  ["squint", 2],
  ["widen", 2],
  ["smile", 2],
  ["inspect", 2],
  ["tilt", 3],
  ["stretch", 2],
  ["wiggle", 2],
];
const ACT_LENGTH = {
  glance: () => 1.1 + Math.random() * 0.7,
  blinkTwice: () => 0.5,
  squint: () => 1.2,
  widen: () => 0.9,
  smile: () => 1.1,
  inspect: () => 1.5,
  tilt: () => 1.1,
  stretch: () => 0.55,
  wiggle: () => 0.6,
};

class BotMotion {
  constructor(seed = (Math.random() * 2 ** 32) >>> 0) {
    this.random = new SplitMix(seed);
    this.staysBot = true; // 悬浮球常驻：不退回 logo
    this.arrivesAfter = 0.35; // 首次亮相先当 0.35s 鲸鱼
    this.period = 3; // 一次呼吸
    this.crossesEyes = SPEC.crossesEyes;
    this.finned = true;

    this.state = { look: "idle", hovered: false, holds: false, badge: null };
    this.since = -10;
    this.morph = 0;
    this.face = { open: 1, look: 0, lookY: 0, wide: 1, happy: 0, lean: 0, crossed: 0 };
    this.pose = zeroPose();
    this.flap = { left: 0, right: 0 };
    this.sign = null;
    this.lit = 0;

    this.last = null;
    this.leaving = null;
    this.act = null;
    this.nextAct = 0;
    this.blinks = [-1, -1];
    this.nextBlink = 2;
    this.blinksOn = true;
    this.greetAfter = null;
    this.greeting = null;
    this.greetSide = 1;
    this.pending = null;
    this.event = null;
    this.beatsFrom = 0;
    this.heldSide = 1;
  }

  get look() {
    return this.state.look;
  }

  set(next, now) {
    const before = this.state;
    this.state = { ...this.state, ...next };
    if (this.state.holds && !before.holds) this.heldSide = ponderSide(now);
    if (this.state.look !== before.look) {
      this.leaving = this.pose;
      this.since = now + (this.staysBot && this.morph === 0 ? Math.max(0, this.arrivesAfter) : 0);
      this.beatsFrom = Math.ceil((this.since - PACE_SLACK) / MOVES.beat) * MOVES.beat;
      if (LOOK.isWorking(this.state.look)) this.nextAct = now + 0.9 + this.random.unit() * 1.2;
    }
    if (this.state.hovered !== before.hovered) this.hover(this.state.hovered, now);
  }

  play(kind, now) {
    this.pending = { kind, at: now };
  }

  /** 点击时打招呼：小跳 + 朝指针一侧挥手。 */
  greet(now, aimX = 0) {
    this.greeting = now;
    this.greetSide = aimX < 0 ? -1 : 1;
  }

  hover(on, now) {
    this.greetAfter = null;
    if (!on) return;
    this.greetAfter = now + MOVES.hopSeconds;
    this.nextAct = now + 0.9 + this.random.unit() * 1.2;
  }

  step(time, aim = { x: 0, y: 0 }) {
    const now = onFrame(time);
    // 首次起步：先当 0.35s 鲸鱼，再化身（原作 arrivesAfter）
    if (this.last === null && this.staysBot && this.morph === 0) this.since = now + this.arrivesAfter;
    const gap = Math.max(0, now - (this.last ?? now));
    const dt = gap > 2 * LONGEST_STEP ? 0 : Math.min(LONGEST_STEP, gap);
    this.last = now;
    const age = now - this.since;

    if (this.pending && now - this.pending.at > 3) this.pending = null; // 事件保鲜 3s
    const evLen = (k) => (k === "failed" ? 1.5 : k === "limitHit" ? 1.2 : MOVES.hopSeconds);
    if (this.event && now - this.event.start >= evLen(this.event.kind)) this.event = null;

    const dozing = this.look === "asleep" && !this.state.hovered;
    const arrived = age >= 0;
    const awake =
      arrived &&
      (LOOK.isWorking(this.look) ||
        LOOK.isAttention(this.look) ||
        this.state.hovered ||
        (this.look === "done" && age < 1.5) ||
        this.pending !== null ||
        this.event !== null);
    const wanted = arrived && (awake || this.staysBot) ? 1 : 0;
    const stride = dt / MORPH_SECONDS;
    this.morph =
      Math.abs(wanted - this.morph) <= stride ? wanted : this.morph + (wanted > this.morph ? stride : -stride);

    // 事件等球到位再演。
    if (this.pending && this.event === null && !LOOK.isAttention(this.look) && this.morph > 0.9) {
      this.event = { kind: this.pending.kind, start: now };
      this.pending = null;
      this.act = null;
    }
    // 指针停留片刻，跳一下问好。
    if (
      this.greetAfter !== null &&
      now >= this.greetAfter &&
      this.morph > 0.9 &&
      this.event === null &&
      this.pending === null
    ) {
      this.greetAfter = null;
      if (this.state.hovered && !LOOK.isAttention(this.look) && LOOK.isCalm(this.look)) {
        this.greeting = now;
        this.greetSide = aim.x < 0 ? -1 : 1;
      }
    }
    // 鱼挥手比小跳长。
    const greetLength = Math.max(MOVES.hopSeconds, MOVES.finWaveSeconds);
    if (this.greeting !== null && now - this.greeting >= greetLength) this.greeting = null;

    // 随机小动作：一个接一个，中间停顿。
    if (this.act && now - this.act.start >= this.act.length) this.act = null;
    const actsInPlace = LOOK.staysInPlace(this.look);
    const acts =
      this.event === null &&
      this.greeting === null &&
      !this.state.holds &&
      (this.state.hovered
        ? LOOK.staysInPlace(this.look)
        : ["plain", "tool", "idle", "noNews"].includes(this.look));
    if (actsInPlace && acts) {
      if ((awake || this.staysBot) && this.act === null && now >= this.nextAct) {
        const chosen = this.pick(now);
        this.act = chosen;
        this.nextAct = now + chosen.length + 0.5 + this.random.unit() * 1.9;
        if (chosen.kind === "blinkTwice") this.blinks = [now, now + 0.24];
      }
    } else {
      this.act = null;
    }
    const progress = this.act ? clamp((now - this.act.start) / this.act.length, 0, 1) : 0;
    const swell = this.act === null ? 0 : easeInOut(Math.min(1, Math.min(progress / 0.22, (1 - progress) / 0.22)));

    this.signs(now, arrived, dozing);

    let pose = this.sitting(age, progress, swell, dozing);
    if (this.leaving && arrived && age < BLEND_SECONDS) {
      pose = mixPose(this.leaving, pose, easeOut(clamp(age / BLEND_SECONDS, 0, 1)));
    }
    if (actsInPlace) {
      // 中心固定：呼吸与起伏只改变形状，不挪位置。
      pose = mixPose(zeroPose(), pose, this.morph);
      pose.x = 0;
      pose.y = 0;
      pose.footing = 0;
      if (this.look === "tool" && !this.state.holds) pose.y = bobAt(now - this.beatsFrom) * this.morph;
    } else if (this.morph > 0.5) {
      pose.x += 0.025 * this.face.look;
    }
    this.played(pose, now);
    this.pose = pose;

    this.flap = this.flapping(age, now);

    if (arrived) this.lookFace(age, now, dt, aim, swell, dozing);
  }

  pick(now) {
    let roll = this.random.unit() * ACT_POOL.reduce((sum, [, w]) => sum + w, 0);
    let kind = ACT_POOL[0][0];
    for (const [candidate, weight] of ACT_POOL) {
      roll -= weight;
      if (roll < 0) {
        kind = candidate;
        break;
      }
    }
    const angle = this.random.unit() * 2 * Math.PI;
    return {
      kind,
      start: now,
      length: ACT_LENGTH[kind](),
      side: this.random.unit() < 0.5 ? -1 : 1,
      gaze: { x: Math.cos(angle), y: Math.sin(angle) * 0.7 },
    };
  }

  sitting(age, progress, swell, dozing) {
    const pose = zeroPose();
    const t = age;
    if (LOOK.isAttention(this.look)) {
      if (t < HOP_ATTENTION) {
        const x = t / HOP_ATTENTION;
        const arc = Math.sin(Math.PI * x);
        pose.y = -0.26 * 4 * x * (1 - x);
        pose.scaleY = 1 + 0.08 * arc;
        pose.scaleX = 1 - 0.05 * arc;
      }
      const raised = 1 + 0.12 * easeOutBack(clamp(t / 0.35, 0, 1));
      pose.scaleX *= raised;
      pose.scaleY *= raised;
      const start = moveAt(age).start;
      if (this.look === "permission") pose.rotation = start === null ? 0 : knock(age - start);
      else if (this.look === "question") pose.rotation = questionTilt(age);
      else if (this.look === "plan") pose.y += start === null ? 0 : nod(age - start);
    } else if (this.look === "done") {
      if (t < 0.6) {
        const pop = Math.sin((Math.PI * t) / 0.6);
        pose.scaleX = 1 + 0.2 * pop;
        pose.scaleY = 1 + 0.2 * pop;
        pose.y = -0.1 * pop;
      }
    } else {
      // 呼吸：绕固定中心改变形状。
      if (LOOK.staysInPlace(this.look) && !this.state.holds && !dozing) {
        const breath = (2 * Math.PI * age) / this.period;
        pose.scaleX = 1 + 0.03 * Math.sin(2 * breath);
        pose.scaleY = 1 - 0.03 * Math.sin(2 * breath);
      }
      // 思考时朝目光方向微微侧头。
      if (this.look === "thinking") {
        pose.rotation = MOVES.ponderTilt * clamp(this.face.look / MOVES.ponderGaze.x, -1, 1);
      }
    }
    if (this.act) {
      switch (this.act.kind) {
        case "tilt":
          pose.rotation += this.act.side * 9 * swell;
          break;
        case "stretch": {
          const arc = Math.sin(Math.PI * progress);
          pose.scaleY *= 1 + 0.06 * arc;
          pose.scaleX *= 1 - 0.04 * arc;
          break;
        }
        case "wiggle":
          pose.rotation += 8 * Math.sin(2 * Math.PI * 3 * progress) * (1 - progress);
          break;
        default:
          break;
      }
    }
    return pose;
  }

  /** 打招呼与事件给坐姿加的料。 */
  played(pose, now) {
    if (this.greeting !== null) pose.y += hop(now - this.greeting) * this.morph;
    if (!this.event) return;
    const time = now - this.event.start;
    switch (this.event.kind) {
      case "start":
        pose.y += hop(time) * this.morph;
        break;
      case "failed": {
        const s = sag(time);
        pose.x += shake(time) * this.morph;
        pose.rotation += 6 * s * this.morph;
        pose.y += 0.02 * s * this.morph;
        break;
      }
      case "limitHit": {
        const sg = sigh(time);
        pose.scaleX *= 1 + (sg.scaleX - 1) * this.morph;
        pose.scaleY *= 1 + (sg.scaleY - 1) * this.morph;
        pose.footing = 0.5;
        break;
      }
      default:
        break;
    }
  }

  /** 鱼鳍抬起：干活时随点头抬双鳍，开工与打招呼扇一下，完成时连扇三下。 */
  flapping(age, now) {
    const round = (v) => Math.round(v);
    if (this.event) {
      const f = round(finFlap(now - this.event.start) * this.morph);
      return this.event.kind === "start" ? { left: f, right: f } : { left: 0, right: 0 };
    }
    if (this.greeting !== null) {
      const wave = round(finWave(now - this.greeting) * this.morph);
      return this.greetSide < 0 ? { left: wave, right: 0 } : { left: 0, right: wave };
    }
    switch (this.look) {
      case "tool": {
        const p = this.state.holds ? 0 : bobAt(now - this.beatsFrom) > 0 ? round(MOVES.paddle * this.morph) : 0;
        return { left: p, right: p };
      }
      case "done": {
        const c = round(cheer(age) * this.morph);
        return { left: c, right: c };
      }
      default:
        return { left: 0, right: 0 };
    }
  }

  /** 眼神：看向哪、睁多大、笑没笑。 */
  lookFace(age, now, dt, aim, swell, dozing) {
    const target = { open: 1, look: 0, lookY: 0, wide: 1, happy: 0, lean: 0, crossed: 0 };
    let every = [3.2, 6.5];
    const f = this.face;
    if (LOOK.isAttention(this.look)) {
      target.wide = 1.22;
      if (this.state.hovered) {
        target.look = aim.x;
        target.lookY = aim.y;
      }
      if (this.look === "plan" && this.movingAt(age)) target.lookY = 0.5;
      every = age < 1.5 || age >= MOVES.fullWait ? null : [4, 7];
    } else if (this.look === "done") {
      if (age < 1.25) {
        target.happy = 1;
        every = null;
      } else {
        target.look = aim.x;
        target.lookY = aim.y;
      }
    } else if (this.look === "thinking" && !this.state.hovered) {
      const side = this.state.holds ? this.heldSide : ponderSide(now);
      target.look = MOVES.ponderGaze.x * side;
      target.lookY = MOVES.ponderGaze.y;
      every = [2.2, 4.5];
    } else if (dozing) {
      target.open = 0;
      every = null;
    } else {
      target.look = aim.x;
      target.lookY = aim.y;
      every = [2.2, 4.5];
      if (this.act) {
        switch (this.act.kind) {
          case "glance":
            target.look += (this.act.gaze.x * 0.8 - target.look) * swell;
            target.lookY += (this.act.gaze.y - target.lookY) * swell;
            break;
          case "squint":
            target.open = 1 - 0.55 * swell;
            break;
          case "widen":
            target.wide = 1 + 0.2 * swell;
            break;
          case "smile":
            target.happy = swell > 0.4 ? 1 : 0;
            break;
          case "inspect":
            target.lean = this.act.side * swell;
            target.look += (this.act.side * 0.6 - target.look) * swell;
            target.lookY -= target.lookY * swell;
            break;
          default:
            break;
        }
      }
    }
    if (this.state.holds) every = null;
    if (this.pending?.kind === "start") target.open = 0;
    if (this.event) {
      const time = now - this.event.start;
      switch (this.event.kind) {
        case "start":
          target.open = clamp(time / MOVES.hopSeconds, 0, 1);
          break;
        case "failed":
          if (SPEC.crossesEyes) target.crossed = 1;
          else target.open = 0.45;
          target.lookY = 0.35 * sag(time);
          break;
        case "limitHit":
          target.open = sigh(time).open;
          target.lookY = 0.3;
          break;
        default:
          break;
      }
      every = null;
    }
    this.blinksOn = every !== null;

    const eyes = 1 - Math.exp(-dt * 18);
    const head = 1 - Math.exp(-dt * 9);
    f.look += (target.look - f.look) * head;
    f.lookY += (target.lookY - f.lookY) * head;
    f.wide += (target.wide - f.wide) * eyes;
    f.happy += (target.happy - f.happy) * eyes;
    f.lean += (target.lean - f.lean) * eyes;
    f.crossed += (target.crossed - f.crossed) * eyes;

    let lid = target.open;
    if (every) {
      if (now >= this.nextBlink) {
        this.blinks = [now, -1];
        this.nextBlink = now + every[0] + this.random.unit() * (every[1] - every[0]);
      }
    } else if (this.nextBlink < now) {
      this.nextBlink = now + 1.2;
    }
    for (const start of this.blinks) {
      const blink = (now - start) / 0.17;
      if (blink >= 0 && blink < 1) lid *= 1 - Math.sin(Math.PI * blink);
    }
    f.open += (lid - f.open) * (1 - Math.exp(-dt * 60));
  }

  movingAt(age) {
    const start = moveAt(age).start;
    return start !== null && age - start < moveLength(this.look);
  }

  /** 头顶符号：等待请求的 ! ? ≡、失败的 ×、限流的 ⧗、思考的 …、打盹的 z。 */
  signs(now, arrived, dozing) {
    let shown = null;
    if (arrived) {
      if (this.look === "permission") shown = "exclamation";
      else if (this.look === "question") shown = "question";
      else if (this.look === "plan") shown = "lines";
    }
    if (this.event?.kind === "failed") shown = signShown(shown, "cross");
    if (this.state.badge === "failed") shown = signShown(shown, "cross");
    if (this.state.badge === "limited") shown = signShown(shown, "hourglass");
    if (this.morph > 0 && this.look === "thinking") shown = signShown(shown, "ellipsis");
    if (this.morph > 0 && dozing) shown = signShown(shown, "z");
    this.sign = shown;
    this.lit = shown === "ellipsis" ? Math.floor(now * 3 + 1e-6) % 3 : 0;
  }
}

/* ---------------- 绘制（BotRenderer.swift 移植） ---------------- */

/** 胶囊路径（round=1 时即全圆角胶囊），以当前原点为中心。 */
function pillPath(ctx, w, h, round) {
  const x = -w / 2;
  const y = -h / 2;
  const r = Math.min(w, h) / 2 * round;
  ctx.beginPath();
  if (r <= 0.0005) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** morph 三件套：轮廓的进度、身色的饱和、装饰（肚皮/鳍）的到位。 */
function morphOf(share) {
  return {
    share,
    eased: easeInOut(share),
    solid: Math.min(1, share / 0.22),
    dressed: Math.max(0, Math.min(1, (share - 0.45) / 0.45)),
  };
}

/** 轮廓：鲸鱼 logo 的逐角度半径与圆身半径按 eased 混合。 */
function traceOutline(ctx, logoReach, eased) {
  const center = SPEC.center;
  const radius = SPEC.radius;
  ctx.beginPath();
  for (let i = 0; i < SAMPLES; i++) {
    const angle = (i * 2 * Math.PI) / SAMPLES;
    const reach = logoReach[i] + (radius - logoReach[i]) * eased;
    const x = center.x + Math.cos(angle) * reach;
    const y = center.y + Math.sin(angle) * reach;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

const fullReach = () => new Array(SAMPLES).fill(SPEC.radius);

/**
 * 一帧。side 为 mark 边长（CSS 像素），画布为 side*1.6 见方（四周留 0.3 给鳍与符号）。
 */
function renderFrame(ctx, motion, opts) {
  const { side, dpr = 1, logoImage = null, logoReach = null } = opts;
  const margin = 0.3;
  const spec = SPEC;
  const morph = morphOf(motion.morph);
  const pose = motion.pose;
  const reach = logoReach || fullReach();

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, side * 1.6, side * 1.6);

  ctx.save();
  // 坐姿：位移（share of side，y 向下为正）、旋转（顺时针度）、缩放（footing 为缩放原点）
  const cx = spec.center.x * side;
  const cy = spec.center.y * side;
  ctx.translate(pose.x * side, pose.y * side);
  ctx.translate(cx, cy);
  ctx.translate(0, pose.footing * spec.radius * side);
  ctx.rotate((pose.rotation * Math.PI) / 180);
  ctx.scale(pose.scaleX, pose.scaleY);
  ctx.translate(0, -pose.footing * spec.radius * side);
  ctx.translate(-cx, -cy);

  // mark 空间：一单位 = mark 边长，原点在 mark 左上角，y 向下。
  ctx.translate(margin * side, margin * side);
  ctx.scale(side, side);

  // 1) 鲸鱼 logo 淡出（morph 前 40%）
  const artwork = 1 - Math.min(1, morph.share / 0.4);
  if (artwork > 0 && logoImage) {
    ctx.save();
    ctx.globalAlpha = artwork;
    ctx.drawImage(logoImage, 0, 0, 1, 1);
    ctx.restore();
  }

  // 2) 鱼鳍（站在身后，随 morph 长出；hand ≠ 0 的会随动作抬起）
  if (morph.dressed > 0) {
    ctx.save();
    ctx.globalAlpha = morph.dressed;
    ctx.fillStyle = spec.finColor;
    ctx.translate(spec.center.x, spec.center.y);
    ctx.scale(spec.radius, spec.radius);
    const grown = 0.3 + 0.7 * morph.dressed;
    for (const fin of spec.fins) {
      const raised = fin.hand < 0 ? motion.flap.left : fin.hand > 0 ? motion.flap.right : 0;
      const pts = finPathPoints(fin, grown, raised);
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // 3) 球身与 4) 白肚皮：都裁进轮廓里（BotRenderer.stillPart 的 clip）
  ctx.save();
  traceOutline(ctx, reach, morph.eased);
  ctx.clip();
  ctx.globalAlpha = morph.solid; // 身色在 morph 前 22% 就饱满了
  const grad = ctx.createLinearGradient(spec.center.x, spec.center.y - spec.radius, spec.center.x, spec.center.y + spec.radius);
  grad.addColorStop(0, BODY_TOP);
  grad.addColorStop(0.55, BODY_MID);
  grad.addColorStop(1, BODY_BOTTOM);
  ctx.fillStyle = grad;
  ctx.fillRect(
    spec.center.x - spec.radius - 0.05,
    spec.center.y - spec.radius - 0.05,
    spec.radius * 2 + 0.1,
    spec.radius * 2 + 0.1
  );

  // 白肚皮（soft 装饰：圆角胶囊，贴在球身下部）
  ctx.save();
  ctx.globalAlpha = morph.dressed;
  ctx.fillStyle = spec.belly.color;
  ctx.translate(spec.center.x, spec.center.y);
  ctx.scale(spec.radius, spec.radius);
  const bw = spec.belly.x1 - spec.belly.x0;
  const bh = spec.belly.y1 - spec.belly.y0;
  pillPath(ctx, bw, bh, spec.belly.round);
  ctx.fill();
  ctx.restore();
  ctx.restore(); // 轮廓裁剪

  // 5) 眼睛（BotRenderer.eyes 逐行移植，不裁进轮廓）
  if (morph.dressed > 0) drawEyes(ctx, motion, morph.dressed);

  ctx.restore(); // 坐姿 + mark 空间

  // 6) 头顶符号（整像素网格）
  if (motion.sign) drawSign(ctx, motion, { side, dpr });
}

function drawEyes(ctx, motion, awake) {
  const spec = SPEC;
  const f = motion.face;
  const radius = spec.radius;
  const size = 0.78;
  const spread = spec.eye.spread;
  const turn = spec.reach * 0.72;
  const yaw = clamp(f.look, -1.15, 1.15) * turn;
  const pitch = clamp(f.lookY, -1.15, 1.15) * turn;
  const apart = (Math.sin(yaw + spread) - Math.sin(yaw - spread)) * radius * 0.76;
  ctx.save();
  for (const side of [-1, 1]) {
    const angle = yaw + side * spread;
    const x = spec.center.x + spec.face.x * radius + Math.sin(angle) * radius * 0.76;
    const y = spec.center.y + spec.face.y * radius + Math.sin(pitch) * 0.62 * radius;
    const narrow = Math.pow(Math.max(0.25, Math.cos(angle)), 1.4);
    const tall = (0.72 + 0.28 * Math.cos(angle)) * Math.pow(Math.max(0, Math.cos(pitch)), 0.5);
    const big = (1 + 0.26 * side * f.lean) * f.wide * (0.6 + 0.4 * awake) * size;
    const w = spec.eye.width * radius * big * narrow;
    const h = spec.eye.height * radius * big * tall * Math.max(0.08, f.open) * awake;
    ctx.save();
    ctx.translate(x, y);
    if (f.happy < 0.98 && f.crossed < 0.98) {
      ctx.globalAlpha = (1 - f.happy) * (1 - f.crossed);
      ctx.fillStyle = INK;
      pillPath(ctx, w, Math.max(h, w * 0.16), spec.eye.round);
      ctx.fill();
    }
    if (f.crossed > 0.02) {
      // 失败后打叉（DeepSeek 眼睛够大，叉得出）
      const reachX = spec.eye.height * radius * size * 0.32 * (0.6 + 0.4 * awake);
      ctx.globalAlpha = f.crossed;
      ctx.strokeStyle = INK;
      ctx.lineWidth = spec.eye.width * radius * size * 0.55;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(-reachX, -reachX);
      ctx.lineTo(reachX, reachX);
      ctx.moveTo(-reachX, reachX);
      ctx.lineTo(reachX, -reachX);
      ctx.stroke();
    }
    if (f.happy > 0.02) {
      const stroke = Math.min(spec.eye.width * radius * 0.58 * size, apart * 0.2);
      const half =
        Math.max(stroke * 0.7, Math.min(spec.eye.width * radius * 0.8 * size, apart / 2 - stroke * 1.05)) *
        Math.max(0.6, narrow);
      const rise = half * 0.95;
      ctx.globalAlpha = f.happy;
      ctx.strokeStyle = INK;
      ctx.lineWidth = stroke;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(-half, rise * 0.45);
      ctx.quadraticCurveTo(0, -rise * 1.1, half, rise * 0.45);
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}

/** 头顶符号：5×7 整像素网格，深色地上白字描深边；… 逐点点亮。 */
function drawSign(ctx, motion, { side, dpr }) {
  const sign = motion.sign;
  const bits = signBits(sign);
  if (!bits.length) return;
  const margin = 0.3;
  const top = SPEC.center.y - SPEC.radius; // 球顶（settle 为 0）
  const foot = { x: SPEC.center.x + 0.14, y: top - 0.04 };
  const toPx = (share) => (share + margin) * side;
  const cell = Math.max(1, Math.min(Math.round(side / 20), Math.round((0.3 * side) / SIGN_ROWS_N)));
  const width = SIGN_COLS * cell;
  const height = SIGN_ROWS_N * cell;
  let left = Math.round(toPx(foot.x));
  let bottom = Math.round(toPx(foot.y));
  const ceiling = Math.ceil(toPx(-0.28));
  bottom = Math.max(bottom, ceiling + height);
  left = Math.max(1, Math.min(left, side * 1.6 - 1 - width));
  const lit = clamp(motion.lit, 0, 2);

  const ink = [];
  const dim = [];
  for (let row = 0; row < SIGN_ROWS_N; row++) {
    for (let col = 0; col < SIGN_COLS; col++) {
      if (!((bits[row] >> (SIGN_COLS - 1 - col)) & 1)) continue;
      const x = left + col * cell;
      const y = bottom - (row + 1) * cell;
      if (sign === "ellipsis" && col !== 2 * lit) dim.push({ x, y });
      else ink.push({ x, y });
    }
  }
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = SIGN_EDGE;
  for (const b of ink) ctx.fillRect(b.x - 1, b.y - 1, cell + 2, cell + 2);
  ctx.fillStyle = SIGN_EDGE_FAINT;
  for (const b of dim) ctx.fillRect(b.x - 1, b.y - 1, cell + 2, cell + 2);
  ctx.fillStyle = "#fff";
  for (const b of ink) ctx.fillRect(b.x, b.y, cell, cell);
  ctx.fillStyle = `rgba(255,255,255,${SIGN_FAINT})`;
  for (const b of dim) ctx.fillRect(b.x, b.y, cell, cell);
  ctx.restore();
}

/* ---------------- 对外：一颗球 ---------------- */

export class DshBall {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{side?: number, logo?: HTMLImageElement|null, onTap?: () => void}} opts
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.side = opts.side || 40;
    this.onTap = opts.onTap || null;
    this.motion = new BotMotion();
    this.logoImage = opts.logo || null;
    this.logoReach = null;
    this.aim = { x: 0, y: 0 };
    this.running = false;
    this._raf = 0;
    this._loadLogo(opts.logoUrl);
    this._bindInput();
    this.resize();
  }

  async _loadLogo(logoUrl) {
    if (this.logoImage) {
      this._afterLogo(this.logoImage);
      return;
    }
    try {
      const img = new Image();
      // 相对本模块解析：scripts/dsh-ball.js → ../icons/whale-white.png
      img.src = logoUrl || new URL("../icons/whale-white.png", import.meta.url).href;
      await img.decode();
      this.logoImage = img;
      this._afterLogo(img);
    } catch {
      /* 没有 logo 也能画球，只是少了化身动画 */
    }
  }

  _afterLogo(img) {
    this.logoReach = sampleLogoReach(img);
  }

  resize() {
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const frame = Math.round(this.side * 1.6 * dpr);
    if (this.canvas.width !== frame || this.canvas.height !== frame) {
      this.canvas.width = frame;
      this.canvas.height = frame;
    }
    this.canvas.style.width = `${this.side * 1.6}px`;
    this.canvas.style.height = `${this.side * 1.6}px`;
    this.dpr = dpr;
  }

  /** 状态：idle / thinking / tool / plain / done / permission / question / plan / asleep */
  setLook(look) {
    if (!look || look === this.motion.look) return;
    this.motion.set({ look }, performance.now() / 1000);
  }

  /** 一次性事件：start / failed / limitHit */
  play(event) {
    if (!event) return;
    this.motion.play(event, performance.now() / 1000);
  }

  /** 指针（或手指）位置驱动眼神；aimX/aimY 为相对球心的像素偏移。 */
  setAim(aimX, aimY, hovered) {
    const d = Math.hypot(aimX, aimY);
    if (d < 1) this.aim = { x: 0, y: 0 };
    else {
      const share = d / (d + 120);
      this.aim = { x: (aimX / d) * share, y: (aimY / d) * share };
    }
    if (hovered !== undefined && hovered !== this.motion.state.hovered) {
      this.motion.set({ hovered }, performance.now() / 1000);
    }
  }

  /** 点一下：打招呼。 */
  greet() {
    this.motion.greet(performance.now() / 1000, this.aim.x);
  }

  /** 头顶徽标：failed（×）/ limited（⧗），null 清除。 */
  setBadge(kind) {
    const next = kind || null;
    if (next === this.motion.state.badge) return;
    this.motion.state.badge = next;
  }

  _bindInput() {
    const el = this.canvas;
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      this.setAim(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2), true);
    });
    el.addEventListener("pointerleave", () => this.setAim(0, 0, false));
    el.addEventListener("pointerdown", (e) => {
      const r = el.getBoundingClientRect();
      this.setAim(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2), true);
      this.greet();
      this.onTap?.();
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      const now = performance.now() / 1000;
      this.motion.step(now, this.aim);
      renderFrame(this.ctx, this.motion, {
        side: this.side,
        dpr: this.dpr || 1,
        logoImage: this.logoImage,
        logoReach: this.logoReach,
      });
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }
}
