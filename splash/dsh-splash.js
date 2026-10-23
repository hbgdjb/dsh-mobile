/* ============================================================
   DSH Mobile · 启动动画「谱条飞入」  dsh-splash.js
   ------------------------------------------------------------
   标题按方块笔画拆成一根根谱条，从屏幕四方沿自身轴向飞入，
   ease-out 急停拼合；拼合后角标张开、一道光自上而下扫过、副标题浮起，
   应用就绪后一道斜切刀锋从左侧扫过，把画面切给真实界面。

   视觉语言（对齐《明日方舟：终末地》官网那套）：
   柠檬黄 + 灰调 / 细发丝线 / // 前缀与 NN / NN 计数 / 四角细切角。
   刻意避开「复古终端」那一套：不要蓝图网格、不要 CRT 扫描线、
   不要宽字距等宽标签、不要逐字打字机。

   设计约束：
   · 纯 canvas 2D，零依赖、零网络字体（离线 WebView 也能跑）
   · 构建一次，每帧只做数学运算，中端机 60fps 无压力
   · 全程时间轴驱动，可冻结到任意时刻截图（见 CFG.freeze）

   用法：
     DshSplash.boot({ mount: el })   // 手动启动（默认自动启动）
     DshSplash.ready()               // 应用就绪，安排退场
     DshSplash.exit()                // 强制退场
   事件：document 上派发 'dsh:splash:done'
   ============================================================ */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------
     一、可调参数（想改节奏/文案，只动这里）
     ------------------------------------------------------------ */
  var CFG = {
    lines: ['DEEPSEEK', 'HARNESS'], // 竖屏分两行；横屏/平板自动并成一行
    subtitle: 'MOBILE HOST',
    version: '0.49.0',              // 跟着 app 版本改这一处
    label: 'DSH MOBILE',

    /*
      节奏倍率：整套时间轴的总开关。
      1.0 = 原来的快节奏（拼合约 1.0s）；1.3 = 慢一档，看得清每一根条怎么落位。
      改这一个数就行，下面那些具体秒数都是「1.0 时的基准值」，会被乘上 pace。
    */
    pace: 1.3,

    // 以下都是 pace = 1.0 时的基准时长（秒），实际用时 = 基准 × pace
    warm: 0.40,       // 角标 / 标签淡入用时
    flyStart: 0.16,   // 第一根谱条出发的时刻
    delaySpan: 0.32,  // 由中心到边缘的出发时差（波纹感）
    flyBase: 0.38,    // 最短飞行时长
    flyExtra: 0.18,   // 远距离额外时长
    bracketDur: 0.34, // 四角角标张开的用时
    capDelay: 0.22,   // 页脚说明行比拼合晚多久出现
    capDur: 0.38,     // 页脚说明行浮起的用时
    sweepDur: 0.62,   // 拼合后那道光的掠过用时
    hold: 0.75,       // 拼合完成后至少停留多久再把画面交给应用
    exitDur: 0.66,    // 退场（像素溶解）总时长
    maxWait: 6.0,     // 应用迟迟不 ready 时的兜底（真实时间，不乘 pace）

    /*
      标题的复古彩色渐变：横向从左到右走一遍，青 → 蓝 → 靛 → 紫 → 粉。
      每根谱条按自己的横坐标从这条渐变上取色，所以字是一条完整的色带，
      而不是每根条各自随机上色。
    */
    gradient: [
      [0.00, [22, 201, 212]],   // 青
      [0.24, [58, 167, 242]],   // 天蓝
      [0.48, [111, 124, 246]],  // 靛
      [0.72, [168, 110, 240]],  // 紫
      [0.90, [224, 122, 210]],  // 品红
      [1.00, [245, 138, 168]]   // 玫瑰
    ],
    pixelShadow: true,  // 像素字的立体投影：同色压暗、往右下错开半格

    // 退场：像素点逐个消失
    dissolveIn: 0.03,    // 标题像素开始消失的时刻
    dissolveSpan: 0.36,  // 标题像素消失铺开的时长
    bgDelay: 0.26,       // 背景像素晚多久跟上
    bgSpan: 0.26,        // 背景像素消失铺开的时长

    timeScale: 1,    // 演示用的全局慢放（调试），乘在时间轴上，和 pace 叠加

    accent: '228,226,75', // 柠檬黄 #E4E24B
    ink: '233,234,228',   // 暖白 #E9EAE4
    bg: '#0b0c0e',
    bg2: '#101216',

    autoBoot: true,  // 脚本自己启动（设为 false 可手动 boot）
    freeze: null,    // 调试：冻结在某一时刻（秒），不自动退场
    onDone: null
  };

  // 允许在脚本加载前预置参数：<script>window.DshSplashConfig = {autoBoot:false}</script>
  if (global.DshSplashConfig) {
    for (var _k in global.DshSplashConfig) {
      if (global.DshSplashConfig.hasOwnProperty(_k)) CFG[_k] = global.DshSplashConfig[_k];
    }
  }

  /*
     节奏：把上面那些秒数当「基准」，每次启动按 CFG.pace 重新算一遍。
     这样改 pace 一个数就能整体放慢 / 加快，而且 boot 调多次也不会累积乘。
  */
  var TIMING = ['warm', 'flyStart', 'delaySpan', 'flyBase', 'flyExtra',
                'bracketDur', 'capDelay', 'capDur', 'sweepDur', 'hold', 'exitDur',
                'dissolveIn', 'dissolveSpan', 'bgDelay', 'bgSpan'];
  var AUTHORED = {};
  TIMING.forEach(function (k) { AUTHORED[k] = CFG[k]; });
  function applyPace() {
    var p = CFG.pace || 1;
    for (var i = 0; i < TIMING.length; i++) CFG[TIMING[i]] = AUTHORED[TIMING[i]] * p;
  }

  /* 在渐变上按 0..1 取色（线性插值，不建 LUT —— 只在构建时算几十次） */
  function gradAt(t) {
    var st = CFG.gradient;
    t = clamp(t, 0, 1);
    for (var i = 1; i < st.length; i++) {
      if (t <= st[i][0]) {
        var a = st[i - 1], b = st[i];
        var k = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
        return [
          Math.round(a[1][0] + (b[1][0] - a[1][0]) * k),
          Math.round(a[1][1] + (b[1][1] - a[1][1]) * k),
          Math.round(a[1][2] + (b[1][2] - a[1][2]) * k)
        ];
      }
    }
    return st[st.length - 1][1];
  }

  /* ------------------------------------------------------------
     二、字模：4×7 网格，一笔 = 一个矩形（横平竖直，无斜笔）
     ------------------------------------------------------------ */
  var GLYPHS = {
    // D / P / R 的右侧两角各切掉一格：不切的话 D 就是一个矩形，读成「O」。
    D: [[0, 0, 1, 7], [1, 0, 2, 1], [3, 1, 1, 5], [1, 6, 2, 1]],
    E: [[0, 0, 1, 7], [1, 0, 3, 1], [1, 3, 3, 1], [1, 6, 3, 1]],
    P: [[0, 0, 1, 7], [1, 0, 2, 1], [3, 1, 1, 3], [1, 3, 2, 1]],
    // S 的顶横条左侧内缩一格、底横条右侧内缩一格：
    // 7 段数码管的 S 和 5 是同一个形状，不切这两个角就会读成「5」。
    S: [[1, 0, 3, 1], [0, 1, 1, 2], [0, 3, 4, 1], [3, 4, 1, 2], [0, 6, 3, 1]],
    K: [[0, 0, 1, 7], [3, 0, 1, 3], [1, 3, 2, 1], [3, 4, 1, 3]],
    H: [[0, 0, 1, 7], [3, 0, 1, 7], [1, 3, 2, 1]],
    A: [[0, 1, 1, 6], [3, 1, 1, 6], [1, 0, 2, 1], [0, 4, 4, 1]],
    R: [[0, 0, 1, 7], [1, 0, 2, 1], [3, 1, 1, 2], [1, 3, 2, 1], [2, 4, 1, 1], [3, 5, 1, 2]],
    N: [[0, 0, 1, 7], [1, 1, 1, 2], [2, 3, 1, 2], [3, 0, 1, 7]]
  };
  var STEP = 5;      // 字宽 4 格 + 字距 1 格
  var ROWS = 7;
  var SEED = 20261022;

  /* ------------------------------------------------------------
     三、工具
     ------------------------------------------------------------ */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var eOutQuart = function (t) { return 1 - Math.pow(1 - t, 4); };
  var eOutCubic = function (t) { return 1 - Math.pow(1 - t, 3); };

  /* ------------------------------------------------------------
     四、运行时状态
     ------------------------------------------------------------ */
  var root = null, cv = null, ctx = null, veil = null;
  var W = 0, H = 0, DPR = 1;
  var bars = [], block = null, geo = null, bgGrad = null;
  var T = 0, last = 0, raf = 0;
  var phase = 'idle';        // idle → run → hold → exit → gone
  var allDoneT = -1, exitT0 = -1, wallT0 = 0;
  var readyFlag = false, started = false, inline = false;
  var rng = mulberry32(SEED);
  var reduce = false;
  var MONO = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

  /* ------------------------------------------------------------
     五、排版 + 拆条
     ------------------------------------------------------------ */
  function build() {
    rng = mulberry32(SEED);
    bars = [];

    var portrait = W / H < 1.06;
    var lines = portrait ? CFG.lines.slice() : [CFG.lines.join(' ')];
    var gapCells = 2.6;
    var totalCellsH = lines.length * ROWS + (lines.length - 1) * gapCells;

    var maxGridW = 0;
    for (var i = 0; i < lines.length; i++) {
      maxGridW = Math.max(maxGridW, lines[i].length * STEP - 1);
    }

    // 竖屏按宽度收紧，横屏按高度收紧
    var cellW = (W * 0.82) / maxGridW;
    var cellH = (H * (portrait ? 0.30 : 0.42)) / totalCellsH;
    var cell = Math.min(cellW, cellH);

    var blockH = totalCellsH * cell;
    var cy = H * 0.47;
    var top = cy - blockH / 2;
    var cx = W / 2;
    var blockW = maxGridW * cell;

    block = { cx: cx, cy: cy, top: top, bottom: top + blockH, w: blockW, h: blockH, cell: cell };

    var norm = Math.max(W, H) * 0.75;   // 距离归一化基准

    lines.forEach(function (text, li) {
      var gridW = text.length * STEP - 1;
      var lineW = gridW * cell;
      var tx0 = cx - lineW / 2;
      var ty0 = top + li * (ROWS + gapCells) * cell;

      for (var ci = 0; ci < text.length; ci++) {
        var ch = text.charAt(ci);
        var strokes = GLYPHS[ch];
        if (!strokes) continue;                      // 空格：只占位

        for (var si = 0; si < strokes.length; si++) {
          var gx = strokes[si][0], gy = strokes[si][1];
          var gw = strokes[si][2], gh = strokes[si][3];

          // 长笔拆两半：两段同源同向、出发时刻只差 20ms → 视觉上仍是「一笔」
          var split = (gh >= 6 && gw <= 2) ? 2 : (gw >= 6 && gh <= 2) ? 2 : 1;

          for (var s = 0; s < split; s++) {
            var px = gx * cell, py = gy * cell, pw = gw * cell, ph = gh * cell;
            if (split === 2) {
              if (gh >= gw) { py += s * ph / 2; ph /= 2; }
              else { px += s * pw / 2; pw /= 2; }
            }
            var tx = tx0 + ci * STEP * cell + px + pw / 2;
            var ty = ty0 + py + ph / 2;

            var axis = pw >= ph ? 'h' : 'v';          // 宽笔画横飞，窄笔画竖飞
            var rad = Math.sqrt((tx - cx) * (tx - cx) + (ty - cy) * (ty - cy));

            // 出发边：优先最近的一边（结构感），28% 概率走对面（制造穿插）
            var bx, by, dirx = 0, diry = 0, dist;
            if (axis === 'v') {
              var up = ty <= H - ty;
              if (rng() < 0.28) up = !up;
              by = up ? -(40 + rng() * 140) : H + 40 + rng() * 140;
              bx = tx + (rng() - 0.5) * W * 0.08;
              diry = up ? 1 : -1;
              dist = Math.abs(ty - by);
            } else {
              var left = tx <= W - tx;
              if (rng() < 0.28) left = !left;
              bx = left ? -(40 + rng() * 140) : W + 40 + rng() * 140;
              by = ty + (rng() - 0.5) * H * 0.05;
              dirx = left ? 1 : -1;
              dist = Math.abs(tx - bx);
            }

            var dur = CFG.flyBase + CFG.flyExtra * clamp(dist / norm, 0, 1);

            // 按横坐标在这条渐变上取色：整行字就是一条连续的色带。
            // 注意别叫 gx —— 上面循环里 gx 是字模的列号，同名会把 s=1 那半笔
            // 的 px 算错（var 是函数作用域，第二个半笔会用到被覆盖后的值）。
            var gt = clamp((tx - (cx - blockW / 2)) / Math.max(1, blockW), 0, 1);
            var rgb = gradAt(gt);

            bars.push({
              tx: tx, ty: ty, w: pw, h: ph, axis: axis,
              css: 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')',
              // 立体投影：同色压到 ~26%，错开半格往下右
              cssSh: 'rgb(' + Math.round(rgb[0] * 0.34) + ','
                                + Math.round(rgb[1] * 0.34) + ','
                                + Math.round(rgb[2] * 0.34) + ')',
              bx: bx, by: by, dirx: dirx, diry: diry, dist: dist,
              rad: rad, jitter: rng() * 0.05, half: s,
              delay: 0, dur: dur, landT: 0,
              nDist: 0, phase: rng() * Math.PI * 2
            });
          }
        }
      }
    });

    // 第二遍：用标题自身的半径归一化「离中心多远」，
    // 这样出发时刻的波纹是从字心一路铺到字边，而不是挤在 0.2 秒里。
    var maxRad = 1, maxLand = 0;
    for (var bi = 0; bi < bars.length; bi++) maxRad = Math.max(maxRad, bars[bi].rad);
    for (var bj = 0; bj < bars.length; bj++) {
      var bb = bars[bj];
      bb.nDist = clamp(bb.rad / maxRad, 0, 1);
      bb.delay = CFG.flyStart + Math.pow(bb.nDist, 0.85) * CFG.delaySpan
               + bb.jitter + bb.half * 0.02;
      bb.landT = bb.delay + bb.dur;
      if (bb.landT > maxLand) maxLand = bb.landT;
    }

    // 记下「最后一根到位」的时刻：后续特效与停留计时都以它为准，
    // 而不是以「检测到全部到位的那一帧」为准 —— 掉帧时两者会差出几十毫秒。
    geo = { lines: lines, cell: cell, maxLand: maxLand };
  }

  /* ------------------------------------------------------------
     六、绘制：底
     ------------------------------------------------------------ */
  function drawBg() {
    // 极轻的垂直渐变：上深下略浅，让画面有「空间」而不是一块死黑
    ctx.fillStyle = bgGrad || CFG.bg;
    ctx.fillRect(0, 0, W, H);

    // 标题背后一团极淡的暖光，把字从底上托起来
    var r = Math.max(W, H) * 0.55;
    var g = ctx.createRadialGradient(block.cx, block.cy, 0, block.cx, block.cy, r);
    g.addColorStop(0, 'rgba(255,255,255,0.045)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.012)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /* 标题四角的细角标：拼合后由中心向外张开，替代原来的「标尺」 */
  function drawBrackets(p) {
    if (p <= 0) return;
    var e = eOutQuart(clamp(p, 0, 1));
    var pad = 16 + 8 * (1 - e);
    var arm = 13 * e;
    var x0 = block.cx - block.w / 2 - pad;
    var x1 = block.cx + block.w / 2 + pad;
    var y0 = block.top - pad;
    var y1 = block.bottom + pad;

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(' + CFG.ink + ',' + (0.30 * e).toFixed(3) + ')';
    ctx.beginPath();
    [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]].forEach(function (c) {
      ctx.moveTo(c[0] + arm * c[2], c[1]);
      ctx.lineTo(c[0], c[1]);
      ctx.lineTo(c[0], c[1] + arm * c[3]);
    });
    ctx.stroke();
  }

  /* ------------------------------------------------------------
     七、绘制：谱条
     ------------------------------------------------------------ */
  function drawBars(t) {
    ctx.globalCompositeOperation = 'source-over';

    for (var i = 0; i < bars.length; i++) {
      var b = bars[i];
      var x, y, u = 1, sx = 1, sy = 1, alpha = 1;

      /*
        退场时谱条**原地不动**。
        之前让它「沿来向松开」再淡出，结果和刀锋抢戏：字先散成一堆零件，
        刀锋再扫过去，变成两个动作。现在退场只留一个手势 —— 字保持完整，
        由刀锋一刀切过，被切到的地方就没了。更果断，也更像「切到页面」。
      */
      u = (t - b.delay) / b.dur;
      if (u <= 0) continue;                       // 还没出发（在屏外）
      if (u < 1) {
        var e = eOutQuart(u);
        x = b.bx + (b.tx - b.bx) * e;
        y = b.by + (b.ty - b.by) * e;
        alpha = clamp(u * 7, 0, 1);
        // 沿自身轴向拉伸 = 速度感（不是整体缩放）
        var st = 1 + (reduce ? 0 : 1.05 * Math.pow(1 - u, 1.6));
        if (b.axis === 'h') sx = st; else sy = st;
      } else {
        x = b.tx; y = b.ty;
        // 落地：沿飞行轴轻微压缩再弹回，制造「急停」
        var k = clamp((t - b.landT) / 0.17, 0, 1);
        var sq = 1 - (reduce ? 0 : 0.085 * (1 - k) * (1 - k));
        if (b.axis === 'h') sx = sq; else sy = sq;
        alpha = 1;
      }

      // 到位后一律不透明；飞行中用 globalAlpha 淡入（半透明叠色会让接缝发亮）
      ctx.globalAlpha = alpha;

      if (sx === 1 && sy === 1) {
        /*
          已到位：把矩形的四条边对齐到设备像素再画。
          方块字的笔画是严格相邻的，如果落在分数坐标上，抗锯齿会让接缝像素
          各自只被覆盖一半（50% + 50% 叠出来仍是 75%），于是每根半笔中间
          都显出一道灰线。对齐到设备像素后，相邻边落在同一整数上，缝就没了，
          字也顺带变脆。
        */
        var x0 = Math.round((x - b.w / 2) * DPR) / DPR;
        var y0 = Math.round((y - b.h / 2) * DPR) / DPR;
        var x1 = Math.round((x + b.w / 2) * DPR) / DPR;
        var y1 = Math.round((y + b.h / 2) * DPR) / DPR;
        var rw = x1 - x0, rh = y1 - y0;

        if (CFG.pixelShadow && u >= 1) {
          // 投影也做像素对齐，和字块用同一套边线，不然会露出一条毛边
          var ox = Math.round(block.cell * 0.18 * DPR) / DPR;
          ctx.fillStyle = b.cssSh;
          ctx.fillRect(x0 + ox, y0 + ox, rw, rh);
        }
        ctx.fillStyle = b.css;
        ctx.fillRect(x0, y0, rw, rh);
      } else {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(sx, sy);
        ctx.fillStyle = b.css;
        ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
        ctx.restore();
      }
      ctx.globalAlpha = 1;

      // 落地闪一下柠檬黄：极短，只为了「咔」的那一下有重量
      if (phase !== 'exit' && u >= 1) {
        var fl = 1 - (t - b.landT) / 0.13;
        if (fl > 0) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.translate(b.tx, b.ty);
          // 落地闪白：彩色字上用白，用柠檬黄会和渐变打架
          ctx.fillStyle = 'rgba(255,255,255,' + (fl * 0.55).toFixed(3) + ')';
          ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
          ctx.restore();
        }
      }
    }

    ctx.globalCompositeOperation = 'source-over';
  }

  /* ------------------------------------------------------------
     八、绘制：拼合后的光、角标、副标题、HUD
     ------------------------------------------------------------ */

  /* 一道柔光自上而下掠过整屏 —— 替代原来的 CRT 扫描线 */
  function drawSweep(p) {
    if (p <= 0 || p >= 1) return;
    var band = H * 0.62;
    var y = -band + (H + band * 2) * p;

    ctx.globalCompositeOperation = 'lighter';

    var g = ctx.createLinearGradient(0, y - band / 2, 0, y + band / 2);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.075)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, y - band / 2, W, band);

    // 前沿一条发丝黄线 —— 和退场那道刀锋是同一种黄线，一进一出互相呼应
    ctx.fillStyle = 'rgba(' + CFG.accent + ',0.26)';
    ctx.fillRect(0, y - 0.5, W, 1);

    ctx.globalCompositeOperation = 'source-over';
  }

  function mono(size, spacing) {
    ctx.font = size + 'px ' + MONO;
    if ('letterSpacing' in ctx) ctx.letterSpacing = (spacing || 0) + 'px';
  }

  /* 两个数字补零：037 / 079 —— 终末地官网那种计数语法 */
  function pad3(n) {
    n = Math.round(n);
    return (n < 10 ? '00' : n < 100 ? '0' : '') + n;
  }

  /*
     边框信息分两处：左上角品牌 + 右上角版本，底部一行「说明 + 状态 + 计数」。
     副标题原来挂在标题正下方，结果底部 35% 全是空的、上面又挤成两层；
     挪到页脚以后，版式变成「中间一块大字，四角一圈元信息」，
     空出来的地方就是留白，而不是没画完。
  */
  function drawHud(t, done, capP) {
    var a = clamp((t - CFG.warm * 0.5) / 0.35, 0, 1);
    if (a <= 0) return;
    var pad = Math.min(W, H) * 0.062;
    var size = Math.max(8, Math.round(Math.min(W, H) * 0.023));
    var baseline = pad + size * 0.5;

    mono(size, 1.5);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    // 左上：一个柠檬黄小方块 + 标签
    ctx.fillStyle = 'rgba(' + CFG.accent + ',' + (0.95 * a).toFixed(3) + ')';
    ctx.fillRect(pad, baseline - 1.5, 3, 3);
    ctx.fillStyle = 'rgba(' + CFG.ink + ',' + (0.40 * a).toFixed(3) + ')';
    ctx.fillText(CFG.label, pad + 11, baseline);

    // 右上：版本
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(' + CFG.ink + ',' + (0.30 * a).toFixed(3) + ')';
    ctx.fillText('v' + CFG.version, W - pad, baseline);

    // ---- 页脚一行 ----
    // 注意：上面画版本号时把 textAlign 改成了 right，这里必须掰回 left，
    // 否则副标题会以 pad+26 为右边界向左溢出屏幕。
    ctx.textAlign = 'left';
    var y = H - pad - 8;
    var capE = eOutCubic(clamp(capP, 0, 1));
    var capA = clamp(capP * 1.6, 0, 1) * a;
    var cursor = pad;

    // 柠檬黄短横线：整套视觉的强调色锚点
    if (capE > 0) {
      ctx.fillStyle = 'rgba(' + CFG.accent + ',' + (0.9 * capA).toFixed(3) + ')';
      ctx.fillRect(pad, y - 0.7, 18 * capE, 1.4);
      ctx.fillStyle = 'rgba(' + CFG.ink + ',' + (0.50 * capA).toFixed(3) + ')';
      ctx.fillText(CFG.subtitle, pad + 26, y);
      cursor = pad + 26 + ctx.measureText(CFG.subtitle).width + 16;
    }

    // 状态词：装配中 → 收尾 → 就绪
    /*
      计数按「装配进度」算：以最后一根落位的时刻为终点做线性插值。
      试过两种更「物理」的写法都不行 ——
      · 数 landT：ease-out 让字早就看着拼好了，却还显示 033/079；
      · 累加各条的缓动值：缓动前段太快，0.8s 就报满 079/079。
      线性进度既不抢跑也不落后，而且正好在状态切到 READY 的那一帧收满。
    */
    var landed = done ? bars.length
      : Math.round(bars.length * clamp(t / (geo.maxLand || 1), 0, 1));
    ctx.textAlign = 'left';
    if (!done) {
      ctx.fillStyle = 'rgba(' + CFG.ink + ',' + (0.30 * a).toFixed(3) + ')';
      ctx.fillText('ASSEMBLING', cursor, y);
    } else if (readyFlag) {
      ctx.fillStyle = 'rgba(' + CFG.accent + ',' + (0.85 * a).toFixed(3) + ')';
      ctx.fillText('[ READY ]', cursor, y);
    } else {
      ctx.fillStyle = 'rgba(' + CFG.ink + ',' + (0.30 * a).toFixed(3) + ')';
      ctx.fillText('FINALIZING', cursor, y);
    }

    // 右下：计数
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(' + CFG.ink + ',' + (0.34 * a).toFixed(3) + ')';
    ctx.fillText(pad3(done ? bars.length : landed) + ' / ' + pad3(bars.length), W - pad, y);
  }

  /* ------------------------------------------------------------
     九、交棒：像素点逐个消失
     ------------------------------------------------------------ */
  /*
     整屏切成一张像素网，每个像素点有自己的「死亡时刻」，时间一到就从画布上
     被擦掉一块，真实界面从这些缺口里一点点渗出来。

     两个关键决定：
     1. **标题用 1×1 格，背景用 2×2 格**。同一种网格铺满全屏会像信号噪点；
        字用细格、背景用粗格，溶解时就有了层次 —— 先是字碎成像素，再是底退掉。
     2. **不再逐帧重绘**。2D canvas 的画布内容是保留的，所以退场时只把「这一帧
        该死掉的那几个像素」clearRect 掉，剩下的原样留着。否则每帧重画一遍背景，
        刚擦开的洞又被填回去了，而且全屏几千个 clearRect 每帧跑一遍也不划算。
  */

  var cells = [], cellCursor = 0, cellMax = 0, snap = null, snapCtx = null;

  function buildCells() {
    cells = [];
    cellCursor = 0;
    cellMax = 0;

    var size = Math.max(6, Math.round(block.cell));      // 和字模同格，像素才「对得上」
    var cols = Math.ceil(W / size), rows = Math.ceil(H / size);
    var bx0 = block.cx - block.w / 2, bx1 = block.cx + block.w / 2;
    var by0 = block.top, by1 = block.bottom;

    function overlapsBlock(x, y, w, h) {
      return x + w > bx0 && x < bx1 && y + h > by0 && y < by1;
    }

    // 标题区：1×1，随机顺序，起得快
    for (var ry = 0; ry < rows; ry++) {
      for (var rx = 0; rx < cols; rx++) {
        var x = rx * size, y = ry * size;
        if (!overlapsBlock(x, y, size, size)) continue;
        cells.push({
          x: x, y: y, w: size, h: size,
          dieAt: CFG.dissolveIn + Math.pow(rng(), 1.5) * CFG.dissolveSpan
        });
      }
    }

    /*
      背景：3×3 粗格，晚一拍跟上，但顺序不是纯随机 —— 纯随机在低对比度下
      看着像信号噪点。改成「斜向波浪 + 三成随机」：有一道从左上往右下推的
      趋势，随机只负责把边缘打散，读起来才像「整个画面被吃掉」而不是「雪花」。
    */
    var big = size * 3;
    var diagMax = W + H;
    for (var by = 0; by < H; by += big) {
      for (var bxx = 0; bxx < W; bxx += big) {
        var wave = (bxx + by) / diagMax;              // 0 左上 → 1 右下
        var t0 = CFG.bgDelay + (wave * 0.85 + rng() * 0.15) * CFG.bgSpan;
        // 压在标题上的粗格往后挪一点，别抢在字的细格前面把它啃掉；
        // 但**不排除**这一块 —— 排除了的话，字周围会留下一圈方块轮廓。
        if (overlapsBlock(bxx, by, big, big)) t0 += 0.06;
        cells.push({ x: bxx, y: by, w: big, h: big, dieAt: t0 });
      }
    }

    cells.sort(function (a, b) { return a.dieAt - b.dieAt; });
    cellMax = cells.length ? cells[cells.length - 1].dieAt : 0;
  }

  /*
     为什么不是「只擦不重绘」：
     那样依赖 canvas 的内容在帧与帧之间被保留 —— 这在浏览器里并不保证，
     内存紧张、GPU 纹理回收、切后台回来都可能把画布内容丢掉，画面上就会
     突然整个空掉。所以退场开始时先把最后一帧拍成一张快照，之后每帧
     从快照重画一遍，再把「这一帧该死掉」的像素从**快照上**挖掉。
     每帧只多一次全屏 drawImage，稳定得多。
  */
  function snapshot() {
    snap = document.createElement('canvas');
    snap.width = cv.width;
    snap.height = cv.height;
    snapCtx = snap.getContext('2d');
    snapCtx.drawImage(cv, 0, 0);
  }

  function stepDissolve(elapsed) {
    var dirty = false;
    while (cellCursor < cells.length && cells[cellCursor].dieAt <= elapsed) {
      var c = cells[cellCursor++];
      // 快照是设备像素坐标，没有变换，直接乘 DPR
      snapCtx.clearRect(c.x * DPR, c.y * DPR, c.w * DPR, c.h * DPR);
      dirty = true;
    }
    if (!dirty && !stepDissolve.first) return;
    stepDissolve.first = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(snap, 0, 0);
  }

  /* ------------------------------------------------------------
     十、主循环
     ------------------------------------------------------------ */
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!last) last = now;
    var dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    T += dt * (CFG.timeScale || 1);
    if (CFG.freeze !== null) T = CFG.freeze;

    var t = T;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (!block) return;

    /*
      退场阶段**完全不重绘**：画布上留着最后一帧，只把「这一帧该死掉」的
      像素块 clearRect 掉，洞就一直在。要是每帧重画一遍背景，
      刚擦开的地方会立刻被填回去，而且全屏几千个 clearRect 也不划算。
    */
    if (phase === 'exit') {
      var ep = t - exitT0;
      stepDissolve(ep);
      if (veil) veil.style.opacity = String(clamp(1 - ep * 6, 0, 1));
      if (ep >= Math.max(CFG.exitDur, cellMax + 0.08)) finish();
      return;
    }

    drawBg();

    // 全部到位？
    if (phase === 'run') {
      var all = true;
      for (var i = 0; i < bars.length; i++) if (t < bars[i].landT) { all = false; break; }
      if (all) { phase = 'hold'; allDoneT = geo.maxLand; }
    }

    // 框架层（角标 / 页脚）先画，谱条压在上面
    var capP = 0;
    if (allDoneT >= 0) {
      var dt2 = t - allDoneT;
      drawBrackets(clamp(dt2 / CFG.bracketDur, 0, 1));
      capP = clamp((dt2 - CFG.capDelay) / CFG.capDur, 0, 1);
    }
    drawHud(t, allDoneT >= 0, capP);

    drawBars(t);

    // 光扫过整屏（拼合之后一次）
    if (allDoneT >= 0) drawSweep(clamp((t - allDoneT - 0.06) / CFG.sweepDur, 0, 1));

    // 驻留时的呼吸：盖一层极淡的底色，整屏一起起伏。
    // 不用「逐条改透明度」——半透明的相邻条会在接缝处叠两次，亮出一道线。
    if (phase === 'hold') {
      var br = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI / 2.6);
      ctx.fillStyle = 'rgba(11,12,14,' + (0.030 * br).toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
    }

    // 交棒：像素点开始消失
    if (phase === 'hold') {
      // 退场条件：应用就绪 + 停留够久；或超时兜底。
      // 超时用**真实墙钟**而不是动画时间 —— 低帧率设备上动画时间会比真实时间慢，
      // 拿它做兜底会让「卡住的启动页」多挂好几秒。
      var waited = t - (allDoneT >= 0 ? allDoneT : 0);
      var wall = (now - wallT0) / 1000;
      if (CFG.freeze === null) {
        if ((readyFlag && waited >= CFG.hold) || wall >= CFG.maxWait) exit();
      }
    }

  }

  /* ------------------------------------------------------------
     十一、生命周期
     ------------------------------------------------------------ */
  function boot(opts) {
    if (started) return api;
    opts = opts || {};
    for (var k in opts) if (opts.hasOwnProperty(k)) CFG[k] = opts[k];

    applyPace();

    reduce = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var qs = new URLSearchParams(global.location.search || '');
    if (qs.get('splash-t') !== null) CFG.freeze = parseFloat(qs.get('splash-t')) || 0;

    // 系统开了「减弱动态效果」：不飞，直接淡入拼合，节奏整体压缩
    if (reduce && !opts.disableReduce) {
      CFG.flyStart = 0.04;
      CFG.delaySpan = 0.10;
      CFG.flyBase = 0.20;
      CFG.flyExtra = 0.04;
      CFG.hold = 0.55;
    }

    var mountEl = CFG.mount
      ? (typeof CFG.mount === 'string' ? document.querySelector(CFG.mount) : CFG.mount)
      : document.body;
    if (!mountEl) mountEl = document.body;
    inline = mountEl !== document.body;
    if (inline && getComputedStyle(mountEl).position === 'static') {
      mountEl.style.position = 'relative';
    }

    root = document.createElement('div');
    root.className = 'dsh-splash' + (inline ? ' dsh-splash--inline' : '');
    root.setAttribute('aria-hidden', 'true');   // 纯装饰层，别让读屏念它
    cv = document.createElement('canvas');
    cv.className = 'dsh-splash__canvas';
    veil = document.createElement('div');
    veil.className = 'dsh-splash__veil';
    root.appendChild(cv);
    root.appendChild(veil);
    mountEl.appendChild(root);

    ctx = cv.getContext('2d');
    document.documentElement.classList.add('dsh-booting');
    started = true;

    // 复位时间轴（支持重播）
    T = 0; last = 0; allDoneT = -1; exitT0 = -1;
    wallT0 = (global.performance && performance.now) ? performance.now() : Date.now();
    readyFlag = false;
    phase = 'run';

    resize();
    global.addEventListener('resize', resize);
    global.addEventListener('orientationchange', resize);
    document.addEventListener('visibilitychange', function () { last = 0; });

    // 应用侧可以用事件通知就绪，也可以直接调 DshSplash.ready()
    document.addEventListener('dsh:ready', function () { readyFlag = true; });

    raf = requestAnimationFrame(frame);
    return api;
  }

  function resize() {
    if (!root) return;
    W = inline ? root.clientWidth : global.innerWidth;
    H = inline ? root.clientHeight : global.innerHeight;

    /*
      按「像素预算」定 DPR，而不是死cap 在 2。
      现在多数手机是 DPR 3，canvas 只按 2 渲染再被系统放大到 3，
      这么粗的方块笔画会明显发虚 —— 而这一屏最值钱的就是字脆。
      预算 4.2M 像素：390×844@3 约 3.0M，放得下；大平板会自动退回 2。
    */
    var want = global.devicePixelRatio || 1;
    var byBudget = Math.sqrt(4.2e6 / Math.max(1, W * H));
    DPR = Math.max(1, Math.min(want, 3, byBudget));
    cv.width = Math.round(W * DPR);
    cv.height = Math.round(H * DPR);
    cv.style.width = W + 'px';
    cv.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    bgGrad = ctx.createLinearGradient(0, 0, 0, H);
    bgGrad.addColorStop(0, CFG.bg);
    bgGrad.addColorStop(1, CFG.bg2);

    build();
  }

  function ready() {
    readyFlag = true;
    return api;
  }

  function exit() {
    if (phase === 'exit' || phase === 'gone') return api;
    if (phase === 'run') { phase = 'hold'; allDoneT = T; }  // 提前收尾
    phase = 'exit';
    exitT0 = T;
    snapshot();            // 先把最后一帧拍下来，后面每帧从它重画
    buildCells();          // 这一刻的像素网：每个点什么时候消失
    stepDissolve.first = true;
    // 底色已经画在 canvas 上，这里把 DOM 的底色让出来，
    // 否则刀锋把画布切穿了，后面还是被 .dsh-splash 的背景挡着。
    if (root) root.style.background = 'transparent';
    return api;
  }

  function finish() {
    if (phase === 'gone') return;
    phase = 'gone';
    cancelAnimationFrame(raf);
    global.removeEventListener('resize', resize);
    global.removeEventListener('orientationchange', resize);
    if (root && root.parentNode) root.parentNode.removeChild(root);
    document.documentElement.classList.remove('dsh-booting');
    // 退场用的快照是整屏大小（DPR 3 时约 12MB），用完立刻放掉
    root = null; cv = null; ctx = null; veil = null;
    snap = null; snapCtx = null; cells = []; cellCursor = 0; cellMax = 0;
    started = false;
    document.dispatchEvent(new CustomEvent('dsh:splash:done'));
    if (typeof CFG.onDone === 'function') CFG.onDone();
  }

  var api = {
    boot: boot,
    ready: ready,
    exit: exit,
    get phase() { return phase; },
    get bars() { return bars; },
    get time() { return T; },
    config: CFG
  };
  global.DshSplash = api;

  /* 自动启动：脚本放到 <body> 末尾即可，无需额外调用 */
  function auto() {
    if (CFG.autoBoot !== false) boot();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', auto);
  } else {
    auto();
  }
})(window);
