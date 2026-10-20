/* ============================================================
   dsh-codex-effort-slider — 原生移植（移动端）
   源插件：https://github.com/Microqian2th/dsh-codex-effort-slider
   版本：1.1.2 · MIT · Copyright (c) 2026 dsh-codex-effort-slider contributors

   移植说明：
   · 几何、颜色、能量、星尘、运动引擎与设置项均按源插件 1:1 复刻
   · 源插件用 React portal 改造官方模型菜单的那一行；这里用原生 DOM
     挂到「模型」面板里的「推理等级」行，交互与视觉保持一致
   · 源插件在代码里用 `--dsw-*` 令牌；这里映射到本应用的 token
   ============================================================ */

export const EFFORT_LEVELS = [
  { id: "off", name: "Off" },
  { id: "low", name: "Low" },
  { id: "high", name: "High" },
  { id: "max", name: "Max" },
];

/* ── 尺寸与速率常量（与源插件一致）────────────────────────────── */
const TRACK_HEIGHT = 28;
const KNOB_SIZE = TRACK_HEIGHT;
const KNOB_RADIUS = KNOB_SIZE / 2;

const MAX_FRAME_DT = 0.05;
const STARFIELD_DURATION_MEAN = 1.5;
const STARFIELD_DURATION_SPREAD = 0.08;
const STARFIELD_MIN = 0.5;
const GOLDEN_RATIO = 0.6180339887498949;
const MAX_SPEED_FACTOR = 2;
const MIN_HEIGHT_SLOTS = 3;
const ENERGY_START = 1 / 3;
const ENERGY_END = 2 / 3;

const COLOR_BLUE = [77, 147, 248];
const COLOR_VIOLET = [147, 51, 234];
const COLOR_DEEP = [76, 29, 149];
const COLOR_TEXT_VIOLET = [139, 92, 246];

const MOTION = { K: 20, A: 120, k: 40, amax: 240, vmax: 6, epsX: 0.0015, epsV: 0.02 };
const MOTION_REDUCED = { K: 40, A: 300, k: 40, amax: 200, vmax: 7, epsX: 0.0015, epsV: 0.02 };
const MOTION_FAST = { K: 60, A: 500, k: 60, amax: 300, vmax: 10, epsX: 0.0015, epsV: 0.02 };
const DETENT_THIRD = 1 / 3;
const RELEASE_PROJECT_S = 0;
const POINTER_SPEED_EMA = 0.4;
const POINTER_STALE_S = 2 / 60;
const POINTER_SPEED_TAU = 0.03;

const DEFAULT_MOTION = "full";
const SETTINGS_KEY = "dsh-codex-effort-slider.settings";
const SETTINGS_VERSION = 3;
const DEFAULTS = { motion: "full", reachedTicks: "hidden", v: SETTINGS_VERSION };

/* ── 纯函数 ─────────────────────────────────────────────────── */
function clamp01(value) {
  if (!(value > 0)) return 0;
  return value > 1 ? 1 : value;
}

function clampAbs(value, limit) {
  if (value > limit) return limit;
  return value < -limit ? -limit : value;
}

function pctFromIndex(index, count) {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  const safe = Math.max(0, Math.min(count - 1, index));
  return safe / (count - 1);
}

function indexFromPct(pct, count) {
  if (count <= 1) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(clamp01(pct) * (count - 1))));
}

function mixColor(from, to, t) {
  const k = clamp01(t);
  return [
    Math.round(from[0] + (to[0] - from[0]) * k),
    Math.round(from[1] + (to[1] - from[1]) * k),
    Math.round(from[2] + (to[2] - from[2]) * k),
  ];
}

function rgbOf(color) {
  return `rgb(${color[0]},${color[1]},${color[2]})`;
}

/** 当前位置的填充色：第一档到第二档恒为蓝，之后蓝→紫→深紫。 */
function fillColorFor(pct) {
  const t = clamp01(pct);
  if (t <= ENERGY_START) return rgbOf(COLOR_BLUE);
  if (t <= ENERGY_END) {
    return rgbOf(mixColor(COLOR_BLUE, COLOR_VIOLET, (t - ENERGY_START) / (ENERGY_END - ENERGY_START)));
  }
  return rgbOf(mixColor(COLOR_VIOLET, COLOR_DEEP, (t - ENERGY_END) / (1 - ENERGY_END)));
}

/** 填充层：左端恒为蓝，右端是当前位置的颜色。 */
function fillBackgroundFor(pct) {
  return `linear-gradient(90deg, ${rgbOf(COLOR_BLUE)}, ${fillColorFor(pct)})`;
}

/** 能量强度：第二档以前为 0，high 0.5，max 1。 */
function energyFor(pct) {
  return clamp01((clamp01(pct) - ENERGY_START) / (1 - ENERGY_START));
}

function speedFor(pct) {
  return Math.min(2, Math.max(0.35, 3 * clamp01(pct) - 1));
}

function particleCountFor(pct) {
  return Math.round(energyFor(pct) * PARTICLES.length);
}

function starLayerOpacityFor(pct) {
  return 0.6 + 0.4 * energyFor(pct);
}

function starHash01(index, salt) {
  const value = ((index + 1) * salt * 2654435761) % 4294967296;
  return ((value >>> 8) % 1000) / 1000;
}

function starBrightnessFor(index) {
  return STARFIELD_MIN + (1 - STARFIELD_MIN) * starHash01(index, 61);
}

function starDurationFor(index, speedFactor) {
  const speed = Math.min(
    MAX_SPEED_FACTOR,
    Math.max(0.35, typeof speedFactor === "number" ? speedFactor : MAX_SPEED_FACTOR)
  );
  const spread = 1 - STARFIELD_DURATION_SPREAD + 2 * STARFIELD_DURATION_SPREAD * starHash01(index, 29);
  return (STARFIELD_DURATION_MEAN * MAX_SPEED_FACTOR) / speed * spread;
}

function starDelayFor(index, duration) {
  const particle = PARTICLES[index];
  const phase = particle && typeof particle.phase === "number" ? particle.phase : 0;
  const jitter = starHash01(index, 53) * 0.03;
  return -((phase + jitter) % 1) * duration;
}

/** 旋钮圆心 / 填充终点 / 刻度共用这一套几何：半径 + pct × (100% − 直径)。 */
function knobOffsetOf(pct) {
  const t = Math.round(clamp01(pct) * 10000) / 10000;
  return `calc(${KNOB_RADIUS}px + ${t} * (100% - ${KNOB_RADIUS * 2}px))`;
}

function isOffLevel(level) {
  if (!level) return false;
  const candidates = [level.id, level.name];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const flat = candidate.replace(/\s+/g, "").toLowerCase();
    if (flat === "off" || flat === "none" || flat === "关闭" || flat === "无") return true;
  }
  return false;
}

/** 档位文字颜色；Off 返回空串 = 保持官方灰。 */
function valueColorFor(pct, level) {
  if (isOffLevel(level)) return "";
  return rgbOf(mixColor(COLOR_BLUE, COLOR_TEXT_VIOLET, energyFor(pct)));
}

/** 星尘：22 颗，高度与相位解耦，相位用黄金比低差异序列铺开。 */
const PARTICLES = (function buildParticles() {
  const count = 22;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ y: 0, phase: ((i + 1) * GOLDEN_RATIO) % 1 });
  }
  const byPhase = [];
  for (let i = 0; i < count; i += 1) byPhase.push(i);
  byPhase.sort((a, b) => out[a].phase - out[b].phase);

  let slots = null;
  for (let salt = 71; salt < 4000 && slots === null; salt += 1) {
    const candidate = [];
    for (let i = 0; i < count; i += 1) candidate.push(i);
    candidate.sort((a, b) => {
      const ha = starHash01(a, salt);
      const hb = starHash01(b, salt);
      return ha === hb ? a - b : ha - hb;
    });
    let ok = true;
    for (let k = 1; k < count && ok; k += 1) {
      if (Math.abs(candidate[k] - candidate[k - 1]) < MIN_HEIGHT_SLOTS) ok = false;
    }
    if (ok) slots = candidate;
  }
  if (slots === null) {
    slots = [];
    for (let i = 0; i < count; i += 1) slots.push((i * 5) % count);
  }
  for (let rank = 0; rank < count; rank += 1) {
    out[byPhase[rank]].y = 8 + (slots[rank] / (count - 1)) * 84;
  }
  return out;
})();

/* ── 运动引擎（与源插件同一份函数与参数）────────────────────── */
function motionStep(m, dt, p) {
  const e = m.target - m.x;
  let vAbs = p.K * Math.abs(e);
  const brake = Math.sqrt(2 * p.A * Math.abs(e));
  if (brake < vAbs) vAbs = brake;
  if (vAbs > p.vmax) vAbs = p.vmax;
  const vDesired = e > 0 ? vAbs : e < 0 ? -vAbs : 0;
  m.a = clampAbs(p.k * (vDesired - m.v), p.amax);
  m.v = clampAbs(m.v + m.a * dt, p.vmax);

  if (e !== 0 && Math.abs(m.v * dt) >= Math.abs(e)) {
    m.x = m.target;
    m.v = 0;
    m.a = 0;
    return m;
  }

  const xRaw = m.x + m.v * dt;
  const xClamped = xRaw < 0 ? 0 : xRaw > 1 ? 1 : xRaw;
  if (xClamped !== xRaw && ((xClamped === 0 && m.v < 0) || (xClamped === 1 && m.v > 0))) {
    m.v = 0;
    m.a = 0;
  }
  m.x = xClamped;
  if (motionSettled(m, p)) {
    m.x = m.target;
    m.v = 0;
    m.a = 0;
  }
  return m;
}

function motionSettled(m, p) {
  return Math.abs(m.target - m.x) < p.epsX && Math.abs(m.v) < p.epsV;
}

function decayPointerSpeed(vPtr, sinceS, staleS, tau) {
  if (!(sinceS > staleS)) return vPtr;
  return vPtr * Math.exp(-(sinceS - staleS) / tau);
}

function detentTargetIndex(pos, cur, count, third) {
  if (count <= 1) return 0;
  const th = typeof third === "number" && third > 0 && third < 0.5 ? third : 1 / 3;
  const lo = Math.max(0, Math.min(count - 1, typeof cur === "number" ? cur : 0));
  const p = Math.max(0, Math.min(count - 1, pos));
  if (p >= lo + th) return Math.min(count - 1, Math.max(lo + 1, Math.round(p)));
  if (p <= lo - (1 - th)) return Math.max(0, Math.min(lo - 1, Math.round(p)));
  return lo;
}

/* ── 设置（键名与源插件一致，可直接沿用）───────────────────── */
let settingsCache = null;

function normalizeSettings(raw) {
  const out = { ...DEFAULTS };
  const source = raw && typeof raw === "object" ? raw : {};
  if (["fast", "quick", "full"].includes(source.motion)) out.motion = source.motion;
  if (["highlight", "dim", "hidden"].includes(source.reachedTicks)) out.reachedTicks = source.reachedTicks;
  out.v = SETTINGS_VERSION;
  return out;
}

export function readEffortSettings() {
  if (settingsCache) return settingsCache;
  let parsed = null;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  settingsCache = normalizeSettings(parsed);
  return settingsCache;
}

export function writeEffortSettings(patch) {
  const next = normalizeSettings({ ...readEffortSettings(), ...patch });
  settingsCache = next;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* 存不下只影响“下次还记不记得” */
  }
  window.dispatchEvent(new CustomEvent("dsh-codex-effort-slider:settings", { detail: next }));
  return next;
}

/* ── 对外的小工具 ─────────────────────────────────────────── */
export function effortIndex(id) {
  const i = EFFORT_LEVELS.findIndex((l) => l.id === id);
  return i < 0 ? 0 : i;
}

export function effortName(id) {
  return EFFORT_LEVELS[effortIndex(id)].name;
}

/** 收起态（输入框里的模型席）档位文字颜色，Off 为空串。 */
export function effortColor(id) {
  const idx = effortIndex(id);
  return valueColorFor(pctFromIndex(idx, EFFORT_LEVELS.length), EFFORT_LEVELS[idx]);
}

/* ── 挂载 ─────────────────────────────────────────────────── */

/**
 * @param {HTMLElement} host 容器
 * @param {{ index?: number, levels?: Array<{id:string,name:string}>, onChange?: (id:string, index:number)=>void }} opts
 */
export function mountEffortSlider(host, opts = {}) {
  const levels = opts.levels && opts.levels.length ? opts.levels : EFFORT_LEVELS;
  const count = levels.length;
  let index = Math.max(0, Math.min(count - 1, opts.index ?? 0));

  host.innerHTML = `
    <div class="ces-row" data-energy="0">
      <div class="ces-row__head">
        <span class="ces-row__label">推理等级</span>
        <span class="ces-row__value"></span>
      </div>
      <div class="ces-inline">
        <div class="ces-track" role="slider" tabindex="0" aria-label="推理等级"
             aria-valuemin="0" aria-valuemax="${count - 1}">
          <div class="ces-fill" data-ces-part="fill"></div>
          <div class="ces-energy" data-ces-part="energy">
            <div class="ces-energy__sweep" data-ces-part="sweep"></div>
          </div>
          <div class="ces-stars" data-ces-part="stars"></div>
          <div class="ces-ticks" data-ces-part="ticks"></div>
          <div class="ces-knob" data-ces-part="knob"></div>
        </div>
      </div>
      <p class="ces-hint">长按滑条：动画与刻度点设置</p>
    </div>`;

  const root = host.querySelector(".ces-row");
  const track = host.querySelector(".ces-track");
  const fill = host.querySelector(".ces-fill");
  const energy = host.querySelector(".ces-energy");
  const stars = host.querySelector(".ces-stars");
  const ticksBox = host.querySelector(".ces-ticks");
  const knob = host.querySelector(".ces-knob");
  const valueEl = host.querySelector(".ces-row__value");

  /* 刻度点 */
  const tickEls = levels.map((_, i) => {
    const tick = document.createElement("span");
    tick.className = "ces-tick";
    tick.style.left = knobOffsetOf(pctFromIndex(i, count));
    ticksBox.appendChild(tick);
    return tick;
  });

  /* 星尘 */
  const starEls = PARTICLES.map((p, i) => {
    const star = document.createElement("span");
    star.className = "ces-star";
    star.style.top = `${p.y}%`;
    const dot = document.createElement("span");
    dot.className = "ces-star__dot";
    dot.style.setProperty("--ces-b", starBrightnessFor(i).toFixed(3));
    star.appendChild(dot);
    star.style.display = "none";
    stars.appendChild(star);
    return star;
  });

  let lastStarCount = -1;
  let lastSpeedBucket = -1;

  function paintStars(offset, pct) {
    const starCount = particleCountFor(pct);
    stars.style.width = offset;
    stars.style.opacity = starLayerOpacityFor(pct).toFixed(3);
    const speed = speedFor(pct);
    const bucket = Math.round(speed * 20);
    if (starCount === lastStarCount && bucket === lastSpeedBucket) return;
    lastStarCount = starCount;
    lastSpeedBucket = bucket;
    starEls.forEach((el, i) => {
      const duration = starDurationFor(i, speed);
      el.style.display = i < starCount ? "" : "none";
      el.style.animationDuration = `${duration.toFixed(3)}s`;
      el.style.animationDelay = `${starDelayFor(i, duration).toFixed(3)}s`;
    });
  }

  function paint(pct, labelIndex) {
    const t = clamp01(pct);
    const offset = knobOffsetOf(t);
    const level = levels[Math.max(0, Math.min(count - 1, labelIndex))] || levels[0];
    const strength = energyFor(t);

    fill.style.width = offset;
    fill.style.background = fillBackgroundFor(t);
    energy.style.width = offset;
    knob.style.left = offset;
    root.style.setProperty("--ces-energy", String(strength));
    root.dataset.energy = strength > 0 ? "1" : "0";
    root.style.boxShadow =
      strength > 0
        ? `inset 0 0 0 1px rgba(168,85,247,${(0.16 + 0.34 * strength).toFixed(2)})`
        : "";

    valueEl.textContent = level.name;
    valueEl.style.color = valueColorFor(t, level);

    tickEls.forEach((tick, i) => {
      tick.dataset.on = i <= labelIndex ? "1" : "0";
    });

    track.setAttribute("aria-valuenow", String(labelIndex));
    track.setAttribute("aria-valuetext", level.name);

    paintStars(offset, t);
  }

  /* 运动状态 */
  const motion = { x: pctFromIndex(index, count), v: 0, a: 0, target: pctFromIndex(index, count), vPtr: 0 };
  let dragging = false;
  let snapIndex = null;
  let detentIndex = -1;
  let lastPtrPct = null;
  let lastPointerAt = 0;
  let lastTs = 0;
  let raf = null;
  let longPressTimer = null;
  let pressOrigin = null;
  let destroyed = false;
  const trace = [];

  const settings = () => readEffortSettings();
  const motionParams = () => {
    const mode = settings().motion;
    if (mode === "quick") return MOTION_REDUCED;
    if (mode === "fast") return MOTION_FAST;
    return MOTION;
  };

  root.dataset.reachedTicks = settings().reachedTicks;

  function nowMs() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }

  function report(idx) {
    const safe = Math.max(0, Math.min(count - 1, idx));
    if (safe === index) return;
    index = safe;
    opts.onChange?.(levels[safe].id, safe);
  }

  function startFrames() {
    if (raf !== null || destroyed) return;
    lastTs = nowMs();
    raf = requestAnimationFrame(step);
  }

  function step(ts) {
    raf = null;
    if (destroyed) return;
    const dt = Math.min(MAX_FRAME_DT, Math.max(0.001, (ts - lastTs) / 1000));
    lastTs = ts;
    const p = motionParams();

    motion.vPtr = decayPointerSpeed(
      motion.vPtr,
      (ts - lastPointerAt) / 1000,
      POINTER_STALE_S,
      POINTER_SPEED_TAU
    );
    motionStep(motion, dt, p);

    const shown = indexFromPct(motion.x, count);
    const labelIndex = dragging ? shown : snapIndex !== null ? snapIndex : index;

    if (dragging && shown !== index) report(shown);

    if (motionSettled(motion, p)) {
      motion.x = motion.target;
      motion.v = 0;
      motion.a = 0;
      paint(motion.x, labelIndex);
      if (!dragging) {
        const finalIndex = snapIndex !== null ? snapIndex : indexFromPct(motion.x, count);
        snapIndex = null;
        report(finalIndex);
        paint(motion.x, finalIndex);
      }
      return;
    }

    paint(motion.x, labelIndex);
    if (dragging && trace.length < 300) {
      trace.push({
        t: Math.round(ts),
        x: +motion.x.toFixed(4),
        v: +motion.v.toFixed(3),
        target: +motion.target.toFixed(4),
        index: shown,
      });
    }
    raf = requestAnimationFrame(step);
  }

  function pctAt(clientX) {
    const rect = track.getBoundingClientRect();
    const usable = rect.width - KNOB_RADIUS * 2;
    if (!(usable > 0)) return null;
    return clamp01((clientX - rect.left - KNOB_RADIUS) / usable);
  }

  function moveTo(clientX) {
    const pct = pctAt(clientX);
    if (pct === null) return;
    const now = nowMs();
    const dtPtr = (now - lastPointerAt) / 1000;
    if (lastPtrPct !== null && dtPtr > 0.001) {
      const raw = (pct - lastPtrPct) / dtPtr;
      motion.vPtr = motion.vPtr * (1 - POINTER_SPEED_EMA) + clampAbs(raw, MOTION.vmax) * POINTER_SPEED_EMA;
    }
    lastPtrPct = pct;
    lastPointerAt = now;

    if (settings().motion === "fast") {
      const pos = pct * Math.max(1, count - 1);
      if (!(detentIndex >= 0)) detentIndex = indexFromPct(motion.target, count);
      detentIndex = detentTargetIndex(pos, detentIndex, count, DETENT_THIRD);
      motion.target = pctFromIndex(detentIndex, count);
    } else {
      motion.target = pct;
    }
    startFrames();
  }

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    if (settings().motion === "fast") {
      snapIndex = detentIndex >= 0 ? detentIndex : indexFromPct(motion.target, count);
    } else {
      snapIndex = indexFromPct(clamp01(motion.target + motion.vPtr * RELEASE_PROJECT_S), count);
    }
    snapIndex = Math.max(0, Math.min(count - 1, snapIndex));
    motion.target = pctFromIndex(snapIndex, count);
    motion.vPtr = 0;
    report(snapIndex);
    paint(motion.x, snapIndex);
    startFrames();
    clearLongPress();
  }

  function clearLongPress() {
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = null;
    pressOrigin = null;
  }

  /* ── 设置面板（长按 / 右键）────────────────────────────── */
  let panel = null;

  function closeSettings() {
    if (!panel) return;
    panel.remove();
    panel = null;
    document.removeEventListener("pointerdown", onDocPointerDown, true);
  }

  function openSettings() {
    if (panel || destroyed) return;
    const rect = track.getBoundingClientRect();
    const current = settings();

    panel = document.createElement("div");
    panel.className = "ces-set";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "滑条设置");
    panel.innerHTML = `
      <p class="ces-set__title">滑条设置</p>
      <p class="ces-set__row">三种动画都不受系统「减少动态效果」影响</p>
      <p class="ces-set__group-title">动画效果</p>
      <div class="ces-set__group" role="radiogroup" aria-label="动画效果">
        ${[
          ["fast", "快速动画"],
          ["quick", "简洁动画"],
          ["full", "完整动画"],
        ]
          .map(
            ([value, label]) => `
          <label><input type="radio" name="ces-motion" value="${value}" ${current.motion === value ? "checked" : ""}> ${label}</label>`
          )
          .join("")}
      </div>
      <p class="ces-set__group-title">已到达档位的刻度点</p>
      <div class="ces-set__group" role="radiogroup" aria-label="已到达档位的刻度点">
        ${[
          ["highlight", "亮白显示"],
          ["dim", "与未到达同色"],
          ["hidden", "隐藏"],
        ]
          .map(
            ([value, label]) => `
          <label><input type="radio" name="ces-ticks" value="${value}" ${current.reachedTicks === value ? "checked" : ""}> ${label}</label>`
          )
          .join("")}
      </div>
      <div class="ces-set__actions">
        <button type="button" data-ces-act="diag">复制诊断</button>
        <button type="button" data-ces-act="reset">恢复默认</button>
        <button type="button" data-ces-act="close">关闭</button>
      </div>`;

    document.body.appendChild(panel);

    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = Math.min(Math.max(8, rect.left), vw - width - 8);
    let top = rect.bottom + 8;
    if (top + height > vh - 8) top = Math.max(8, rect.top - height - 8);
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;

    panel.addEventListener("change", (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement)) return;
      if (input.name === "ces-motion") {
        writeEffortSettings({ motion: input.value });
      } else if (input.name === "ces-ticks") {
        writeEffortSettings({ reachedTicks: input.value });
        root.dataset.reachedTicks = input.value;
      }
    });

    panel.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-ces-act]");
      if (!btn) return;
      const act = btn.dataset.cesAct;
      if (act === "close") {
        closeSettings();
      } else if (act === "reset") {
        writeEffortSettings({ motion: DEFAULT_MOTION, reachedTicks: DEFAULTS.reachedTicks });
        panel.querySelectorAll('input[name="ces-motion"]').forEach((el) => {
          el.checked = el.value === DEFAULT_MOTION;
        });
        panel.querySelectorAll('input[name="ces-ticks"]').forEach((el) => {
          el.checked = el.value === DEFAULTS.reachedTicks;
        });
        root.dataset.reachedTicks = DEFAULTS.reachedTicks;
      } else if (act === "diag") {
        copyDiagnostics(btn);
      }
    });

    setTimeout(() => {
      document.addEventListener("pointerdown", onDocPointerDown, true);
    }, 0);
  }

  function onDocPointerDown(event) {
    if (!panel) return;
    if (panel.contains(event.target) || track.contains(event.target)) return;
    closeSettings();
  }

  async function copyDiagnostics(btn) {
    const payload = JSON.stringify(
      {
        plugin: "dsh-codex-effort-slider",
        version: "1.1.2",
        at: new Date().toISOString(),
        settings: settings(),
        level: levels[index]?.name,
        trace,
      },
      null,
      2
    );
    let ok = false;
    try {
      await navigator.clipboard.writeText(payload);
      ok = true;
    } catch {
      try {
        const area = document.createElement("textarea");
        area.value = payload;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        ok = document.execCommand("copy");
        area.remove();
      } catch {
        ok = false;
      }
    }
    btn.textContent = ok ? "已复制" : "复制失败";
    setTimeout(() => {
      if (panel) btn.textContent = "复制诊断";
    }, 1600);
  }

  /* ── 指针 / 键盘 ───────────────────────────────────────── */
  const onPointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    dragging = true;
    snapIndex = null;
    lastPtrPct = null;
    detentIndex = -1;
    if (settings().motion === "fast") {
      const p0 = pctAt(event.clientX);
      if (p0 !== null) detentIndex = indexFromPct(p0, count);
    }
    try {
      track.setPointerCapture(event.pointerId);
    } catch {
      /* 老 WebView */
    }
    moveTo(event.clientX);

    pressOrigin = { x: event.clientX, y: event.clientY };
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      if (dragging && pressOrigin) {
        navigator.vibrate?.(8);
        openSettings();
      }
    }, 480);
    event.preventDefault();
  };

  const onPointerMove = (event) => {
    if (!dragging) return;
    if (pressOrigin) {
      const dx = event.clientX - pressOrigin.x;
      const dy = event.clientY - pressOrigin.y;
      if (dx * dx + dy * dy > 64) {
        clearLongPress();
      }
    }
    moveTo(event.clientX);
  };

  const onPointerUp = () => {
    endDrag();
  };

  const onKeyDown = (event) => {
    let next = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = Math.max(0, index - 1);
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") next = Math.min(count - 1, index + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else return;
    event.preventDefault();
    snapIndex = null;
    index = next;
    motion.x = pctFromIndex(next, count);
    motion.target = motion.x;
    motion.v = 0;
    motion.a = 0;
    paint(motion.x, next);
    opts.onChange?.(levels[next].id, next);
  };

  const onContextMenu = (event) => {
    event.preventDefault();
    openSettings();
  };

  track.addEventListener("pointerdown", onPointerDown);
  track.addEventListener("pointermove", onPointerMove);
  track.addEventListener("pointerup", onPointerUp);
  track.addEventListener("pointercancel", onPointerUp);
  track.addEventListener("keydown", onKeyDown);
  track.addEventListener("contextmenu", onContextMenu);

  track.title = "推理等级：拖动调整；长按打开滑条设置";
  paint(motion.x, index);

  return {
    element: root,
    setIndex(next) {
      index = Math.max(0, Math.min(count - 1, next));
      snapIndex = null;
      motion.x = pctFromIndex(index, count);
      motion.target = motion.x;
      motion.v = 0;
      motion.a = 0;
      paint(motion.x, index);
    },
    refreshSettings() {
      root.dataset.reachedTicks = settings().reachedTicks;
    },
    destroy() {
      destroyed = true;
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
      clearLongPress();
      closeSettings();
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      track.removeEventListener("pointerdown", onPointerDown);
      track.removeEventListener("pointermove", onPointerMove);
      track.removeEventListener("pointerup", onPointerUp);
      track.removeEventListener("pointercancel", onPointerUp);
      track.removeEventListener("keydown", onKeyDown);
      track.removeEventListener("contextmenu", onContextMenu);
      host.innerHTML = "";
    },
  };
}
