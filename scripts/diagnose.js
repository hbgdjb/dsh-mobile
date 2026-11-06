/* ============================================================
   环境自检  scripts/diagnose.js

   ============ 为什么这个文件必须用 ES5 写 ============
   它是用来诊断"页面挂了"的工具。如果它也用了 `||=`、可选链、箭头函数，
   那么在出问题的那台机器上，它会和 app.js 一起被拒绝解析 ——
   诊断工具自己先挂，等于没写。

   所以这里的约束比业务代码更严：
     · 只有 var / function / 字符串拼接，没有 const/let/箭头/模板字符串
     · 不用 for...of、解构、默认参数、扩展运算符、class、async/await
     · 调用 DOM 时避开 Chrome 87+ 才有的简写（不用 inset，逐边写）
     · 不 import 任何模块 —— 模块图一旦断，import 就是不执行

   tests/legacy-syntax-test.mjs 会按 ecmaVersion 5 解析本文件，违反就红。

   ============ 它不修东西 ============
   只做三件事：采集事实、判定严重度、把结论压成一段能复制的文字。
   任何"自动修复"都不在这里 —— 诊断过程改变现场，会让下一次排查失去依据。
   ============================================================ */

(function () {
  "use strict";

  var REPO = "./";
  var PROBE = "./layout-probe.html";

  /* ---------------- 小工具 ---------------- */

  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  function txt(node, s) {
    node.appendChild(document.createTextNode(String(s)));
    return node;
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function stamp(d) {
    return (
      d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
      " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes())
    );
  }

  function kb(n) {
    if (n == null) return "—";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  /* ---------------- 检查项的数据结构 ----------------
     一条检查 = { id, label, status, value, why, ref }
       status: ok / warn / bad / skip
       why:    不通过意味着什么（人话，给用户看）
       ref:    这项能力从哪个版本开始有（给对照用）
  */

  var groups = [];

  function group(id, title, hint) {
    var g = { id: id, title: title, hint: hint || "", items: [] };
    groups.push(g);
    return g;
  }

  function item(g, id, label, status, value, why, ref) {
    var it = {
      id: id,
      label: label,
      status: status,
      value: value == null ? "" : String(value),
      why: why || "",
      ref: ref || "",
      need: false,
    };
    g.items.push(it);
    // 返回引用：模块语法那两项要异步回填，得能拿到同一个对象
    return it;
  }

  function allItems() {
    var out = [];
    for (var i = 0; i < groups.length; i++) {
      for (var j = 0; j < groups[i].items.length; j++) out.push(groups[i].items[j]);
    }
    return out;
  }

  function countOf(status) {
    var n = 0;
    var a = allItems();
    for (var i = 0; i < a.length; i++) if (a[i].status === status) n++;
    return n;
  }

  /* ============================================================
     1. 环境
     ============================================================ */

  function envGroup() {
    var g = group("env", "环境", "先确认这是哪台机器、跑在哪个内核上。");

    var ua = navigator.userAgent || "";
    var cm = /Chrome\/(\d+)(?:\.(\d+))?/.exec(ua);
    var am = /Android\s+(\d+(?:\.\d+)?)/.exec(ua);
    var chromeMajor = cm ? parseInt(cm[1], 10) : 0;
    var chromeFull = cm ? cm[1] + "." + (cm[2] || "0") : "";
    var android = am ? am[1] : "";
    var inApp = /;\s*wv\)/.test(ua);

    var env = {
      ua: ua,
      chrome: chromeMajor,
      chromeFull: chromeFull,
      android: android,
      inApp: inApp,
    };

    // WebView 主版本是整个诊断里最重要的一位数：
    // 98% 的"页面起不来"都能在这条线上找到解释。
    if (chromeMajor >= 108) {
      item(g, "chrome", "WebView 内核", "ok", "Chrome " + chromeFull, "", "");
    } else if (chromeMajor >= 87) {
      item(
        g, "chrome", "WebView 内核", "warn", "Chrome " + chromeFull,
        "能用，但低于 108 —— 个别新样式（dvh 等）不支持，界面可能错位。",
        "Chrome 108+"
      );
    } else if (chromeMajor > 0) {
      item(
        g, "chrome", "WebView 内核", "bad", "Chrome " + chromeFull,
        "太旧。页面用到的相当一部分语法和样式它不认识，会出现黑屏或只显示一半。",
        "Chrome 108+"
      );
    } else {
      item(
        g, "chrome", "WebView 内核", "warn", "读不到版本",
        "拿不到版本号通常意味着 WebView 被停用或被替换成了别的内核。",
        ""
      );
    }

    if (android) {
      item(g, "android", "Android 版本", "ok", "Android " + android, "", "");
    } else if (inApp) {
      // 在应用的 WebView 里却解析不出 Android 版本，说明 UA 被改写过，
      // 后面所有基于 UA 的推断都会失准。
      item(g, "android", "Android 版本", "warn", "读不到",
        "应用内却认不出 Android 版本，UA 可能被改写过 —— 下面按版本做的推断都不太可靠。", "");
    } else {
      item(g, "android", "Android 版本", "skip", "非 Android",
        "在浏览器里打开时本来就没有这一段。", "");
    }
    item(g, "wv", "运行位置", "ok", inApp ? "应用内 WebView" : "浏览器标签页", "", "");

    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    item(
      g, "viewport", "视口", "ok",
      vw + " × " + vh + " @ " + (window.devicePixelRatio || 1),
      vh < 400 ? "高度偏小 —— 如果键盘正开着，属正常。" : "",
      ""
    );

    var lang = navigator.language || "?";
    var tz = "";
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch (e) {
      tz = "读不到";
    }
    item(g, "locale", "语言 / 时区", "ok", lang + (tz ? " · " + tz : ""), "", "");

    var cap = window.Capacitor;
    var native = !!(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());
    if (native) {
      item(g, "host", "宿主", "ok", "原生壳（Capacitor）", "", "");
    } else if (inApp) {
      // 应用内却没拿到 Capacitor。可能是 DSH 的壳里桥没挂上，
      // 也可能只是"别的 App 的 WebView 里打开了同一个页面"——
      // 从 UA 分不出这两种情况，所以给 warn 而不是 bad。
      item(
        g, "host", "宿主", "warn", "应用内，但 Capacitor 未加载",
        "如果这就是 DSH 应用本身，说明原生桥可能没注入，依赖原生的功能会静默失效。",
        ""
      );
    } else {
      item(g, "host", "宿主", "skip", "纯网页（浏览器 / PWA）",
        "在浏览器里访问，没有原生能力是正常的。", "");
    }

    item(g, "ua", "User-Agent", "ok", ua || "(空)", "", "");
    return env;
  }

  /* ============================================================
     2. 语法
     --------------------------------------------------------
     判据是「这一行能不能被解析」，所以必须用 new Function 现编一次。
     不能用 try { eval(...) } 去跑语义 —— 我们只关心解析，不关心结果，
     而且 eval 会污染作用域。
     ============================================================ */

  /* need = 「当前这版代码真的用到了」。
     这个区分很重要：`||=`（Chrome 85）不支持当然会让页面挂，
     但只有代码里**写了**才会挂 —— 现在没写，那它就只是"以后别用"的提醒，
     不该把整台机器判成"跑不起来"。
     判"红"只认 need 项；其余不及格最多算警告。 */
  var SYNTAX = [
    { id: "chain", name: "可选链 a?.b", code: "var o={};return o?.b;", since: 80, need: true },
    { id: "nullish", name: "空值合并 a ?? b", code: "return null ?? 1;", since: 80, need: true },
    { id: "numsep", name: "数字分隔符 1_000", code: "return 1_000;", since: 75, need: true },
    { id: "bigint", name: "BigInt 1n", code: "return typeof 1n;", since: 67, need: true },
    { id: "regex-named", name: "正则命名捕获", code: "return /(?<a>x)/;", since: 64, need: true },
    { id: "optional-catch", name: "catch 省略参数", code: "try{}catch{}return 1;", since: 66, need: true },
    { id: "arrow", name: "箭头函数", code: "var f=()=>1;return f();", since: 45, need: true },
    { id: "template", name: "模板字符串", code: "var a=1;return `x${a}`;", since: 41, need: true },
    { id: "class-fields", name: "类字段 x = 1", code: "class A{x=1}return new A().x;", since: 72, need: true },
    { id: "private-field", name: "私有字段 #x", code: "class A{#x=1;g(){return this.#x}}return new A().g();", since: 74, need: true },
    { id: "assign-or", name: "逻辑或赋值 a ||=", code: "var a=0;a ||= 1;return a;", since: 85, need: false },
    { id: "assign-and", name: "逻辑与赋值 a &&=", code: "var a=1;a &&= 2;return a;", since: 85, need: false },
    { id: "assign-null", name: "空值赋值 a ??=", code: "var a=null;a ??= 3;return a;", since: 85, need: false },
    { id: "static-block", name: "静态块 static {}", code: "class A{static{this.x=1}}return A.x;", since: 94, need: false },
  ];

  function syntaxSupported(code) {
    try {
      // 只编译，不执行。语法不认识时这里抛 SyntaxError。
      new Function(code);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------------- 模块语法的真测 ----------------
     模块语法（import.meta / 顶层 await）没法用 new Function 测 —— 它们只在
     module 上下文里合法。也不能靠 UA 里的版本号推断：UA 可以被改，
     代理浏览器、套壳应用都会让它和真实内核脱节。

     所以真跑一次：把代码塞进 blob URL，动态 import 它。
     能解析能执行就是支持，被拒绝就是不支持。

     import() 这个关键字不能直接写 —— 本文件要按 ES5 解析，解析器不认识它。
     包进 `new Function` 的字符串里就绕开了：解析器看到的是字符串，
     运行时才把 import 拉出来。 */
  var dynImport = null;
  try {
    dynImport = new Function("u", "return import(u)");
  } catch (e) {
    dynImport = null;
  }

  function probeModule(code) {
    return new Promise(function (resolve) {
      if (!dynImport || typeof Blob === "undefined" || !URL || !URL.createObjectURL) {
        resolve(null); // 判断不了，交给上层标"跳过"
        return;
      }
      var url;
      try {
        url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      } catch (e) {
        resolve(null);
        return;
      }
      var done = false;
      function fin(v) {
        if (done) return;
        done = true;
        try {
          URL.revokeObjectURL(url);
        } catch (e) {}
        resolve(v);
      }
      setTimeout(function () {
        fin(null);
      }, 3000);
      try {
        dynImport(url).then(
          function () {
            fin(true);
          },
          function () {
            fin(false);
          }
        );
      } catch (e) {
        fin(false);
      }
    });
  }

  function probeModuleFeatures() {
    return Promise.all([
      probeModule("await 1; export default 0;"),
      probeModule("export default import.meta.url;"),
    ]).then(function (r) {
      return { topAwait: r[0], importMeta: r[1] };
    });
  }

  function syntaxGroup(env) {
    var g = group(
      "syntax", "语法",
      "浏览器遇到不认识的语法，不是跳过那一句，而是整份脚本拒绝执行 —— 这就是黑屏的直接原因。"
    );

    for (var i = 0; i < SYNTAX.length; i++) {
      var s = SYNTAX[i];
      var ok = syntaxSupported(s.code);
      var it = item(
        g, s.id, s.name, ok ? "ok" : s.need ? "bad" : "warn",
        ok ? "支持" : "不支持",
        ok
          ? ""
          : s.need
          ? "用到它的脚本会整份失效。" + (env.chrome ? "这台是 Chrome " + env.chrome + "，需要 " + s.since + "。" : "")
          : "当前版本没有用到它，所以不影响运行；但以后别用 —— 这台机器跑不了。",
        "Chrome " + s.since + "+"
      );
      it.need = s.need;
    }

    // 模块语法的两项：先占位，异步探测回来再改写
    var modA = item(g, "top-await", "顶层 await（模块）", "skip", "检测中…", "", "Chrome 89+");
    modA.need = false;
    var modB = item(g, "import-meta", "import.meta", "skip", "检测中…", "", "Chrome 64+");
    modB.need = true;

    return { group: g, topAwait: modA, importMeta: modB };
  }

  /** 把模块探测结果写回那两条上。探测不出来就保持「跳过」，不猜。 */
  function applyModuleResults(s, mods) {
    var pairs = [
      [s.topAwait, mods.topAwait, "当前版本没有用到顶层 await。"],
      [s.importMeta, mods.importMeta, "用到 import.meta 的脚本会失效。"],
    ];
    for (var i = 0; i < pairs.length; i++) {
      var it = pairs[i][0];
      var v = pairs[i][1];
      if (v === null || v === undefined) {
        it.status = "skip";
        it.value = "无法判断";
        it.why = "";
        continue;
      }
      it.status = v ? "ok" : it.need ? "bad" : "warn";
      it.value = v ? "支持" : "不支持";
      it.why = v ? "" : pairs[i][2];
    }
  }

  /** 只统计 need 项 —— 见 SYNTAX 上面的说明。 */
  function syntaxFactsOf(g) {
    var bad = 0;
    var first = "";
    for (var i = 0; i < g.items.length; i++) {
      var it = g.items[i];
      if (it.need && it.status === "bad") {
        bad++;
        if (!first) first = it.label;
      }
    }
    return { bad: bad, firstBad: first };
  }

  /* ============================================================
     3. 样式
     --------------------------------------------------------
     优先实测，其次 CSS.supports。之所以不全信 CSS.supports：
     个别版本对 selector() 语法的支持不完整，会给出假阴性，
     而真实情况是能用的 —— 反过来信它会把问题误报成样式故障。
     ============================================================ */

  function cssSupports(prop, val) {
    try {
      if (window.CSS && typeof CSS.supports === "function") return CSS.supports(prop, val);
    } catch (e) {
      return false;
    }
    return null;
  }

  // 造一个元素、套上样式、读回 computed —— 比 CSS.supports 笨但可靠。
  // 注意顺序：先给基准值，再放被测声明。反过来的话基准值会把被测值覆盖掉，
  // 量出来的永远是基准值（这个坑踩过一次：dvh 明明不支持却报"支持"）。
  function computedOf(baseCss, testCss, readProp) {
    var d = el("div");
    d.setAttribute(
      "style",
      baseCss + ";" + testCss + ";position:absolute;left:-9999px;top:0"
    );
    document.body.appendChild(d);
    var v = "";
    try {
      var cs = window.getComputedStyle(d);
      v = cs ? cs.getPropertyValue(readProp) : "";
    } catch (e) {
      v = "";
    }
    if (d.parentNode) d.parentNode.removeChild(d);
    return v;
  }

  function flexGapWorks() {
    var wrap = el("div");
    wrap.setAttribute(
      "style",
      "position:absolute;left:-9999px;top:0;display:flex;gap:13px;flex-direction:row"
    );
    var a = el("div");
    a.setAttribute("style", "width:10px;height:10px;flex:none");
    var b = el("div");
    b.setAttribute("style", "width:10px;height:10px;flex:none");
    wrap.appendChild(a);
    wrap.appendChild(b);
    document.body.appendChild(wrap);
    var gap = 0;
    try {
      gap = Math.round(b.getBoundingClientRect().left - a.getBoundingClientRect().right);
    } catch (e) {
      gap = 0;
    }
    if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    return gap === 13;
  }

  function hasSelectorWorks() {
    try {
      var d = el("div");
      d.appendChild(el("span"));
      d.setAttribute("style", "position:absolute;left:-9999px");
      document.body.appendChild(d);
      var ok = false;
      try {
        // 用 matches 而不是 querySelector：querySelector(":has(span)") 找的是
        // "后代里存在匹配 :has(span) 的元素"，span 自己并不匹配，永远返回 null。
        // 这个写法会把"支持"误报成"不支持"。
        ok = d.matches(":has(span)");
      } catch (e) {
        ok = false;
      }
      if (d.parentNode) d.parentNode.removeChild(d);
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  function styleGroup(env) {
    var g = group(
      "style", "样式",
      "某条声明不被认识时，浏览器丢弃的是那一条，不会报错 —— 表现就是布局莫名其妙塌了。"
    );

    var results = {};

    // dvh：本轮「只显示一半」的元凶。
    // 判据必须拿实测高度跟视口比 —— 只判断"值非空"是不够的：
    // 不支持时 height 会留在基准值 10px，那也是个非空值。
    var vhPx = document.documentElement.clientHeight;
    var dvhRaw = computedOf("width:10px;height:10px", "height:100dvh", "height");
    var dvhPx = parseFloat(dvhRaw) || 0;
    var dvhOk = Math.abs(dvhPx - vhPx) <= 2;
    results.dvh = dvhOk;
    item(
      g, "dvh", "height: 100dvh", dvhOk ? "ok" : "bad",
      dvhOk ? "支持（撑到 " + Math.round(dvhPx) + " px）" : "不支持（高度留在 10 px）",
      dvhOk ? "" : "整屏容器会没有高度 → 内容区塌成 0 → 界面只剩标题栏和导航条。",
      "Chrome 108+"
    );

    var insetOk = cssSupports("inset", "0px");
    results.inset = insetOk !== false;
    item(
      g, "inset", "inset 简写", insetOk === false ? "bad" : insetOk === null ? "skip" : "ok",
      insetOk === false ? "不支持" : insetOk === null ? "无法判断" : "支持",
      insetOk === false ? "遮罩、启动动画、绝对定位铺满都会失效（会变成一小块或贴在角落）。" : "",
      "Chrome 87+"
    );

    var cm = cssSupports("color", "color-mix(in srgb, red 50%, blue)");
    item(
      g, "color-mix", "color-mix()", cm === false ? "warn" : cm === null ? "skip" : "ok",
      cm === false ? "不支持" : cm === null ? "无法判断" : "支持",
      cm === false ? "描边、半透明底色会退回纯透明；不影响布局，只影响观感。" : "",
      "Chrome 111+"
    );

    var hsel = hasSelectorWorks();
    item(
      g, "has", ":has() 选择器", hsel ? "ok" : "warn",
      hsel ? "支持" : "不支持",
      hsel ? "" : "少数按「有子元素才变样」写的规则会失效，通常只影响细节。",
      "Chrome 105+"
    );

    var ar = cssSupports("aspect-ratio", "1 / 1");
    item(
      g, "aspect-ratio", "aspect-ratio", ar === false ? "warn" : ar === null ? "skip" : "ok",
      ar === false ? "不支持" : ar === null ? "无法判断" : "支持",
      ar === false ? "方形缩略图、图标容器会变形。" : "", "Chrome 88+"
    );

    var gap = flexGapWorks();
    item(
      g, "flex-gap", "flex gap", gap ? "ok" : "bad",
      gap ? "支持" : "不支持",
      gap ? "" : "所有 flex 间距归零 —— 按钮会挤成一坨，键盘按键会贴在一起。",
      "Chrome 84+"
    );

    var bf = cssSupports("backdrop-filter", "blur(2px)");
    item(
      g, "backdrop", "backdrop-filter", bf === false ? "warn" : bf === null ? "skip" : "ok",
      bf === false ? "不支持" : bf === null ? "无法判断" : "支持",
      bf === false ? "栏底模糊失效，变成半透明纯色；不影响可用性。" : "",
      "Chrome 76+"
    );

    // 注意：这里不量 .stage。
    // 本页不引 styles/*.css（故意的），造一个 class="stage" 的 div 不会有任何样式，
    // 量出来恒为 0 —— 那是在报告一个自造的假象。外壳尺寸由「布局实测」那组负责，
    // 那边是真的引了样式在 iframe 里量。

    return results;
  }

  /* ============================================================
     4. 布局（iframe 实测）
     --------------------------------------------------------
     把 layout-probe.html 装进 iframe 量尺寸。
     这个页面只引样式、没有脚本，所以不会碰存储、不会发业务请求。
     ============================================================ */

  function measureLayout(env) {
    return new Promise(function (resolve) {
      var host = el("div");
      host.setAttribute(
        "style",
        [
          "position:fixed", "left:0", "top:0",
          "width:100%", "height:100%",
          "opacity:0", "pointer-events:none", "z-index:-1",
          "overflow:hidden",
        ].join(";")
      );

      var frame = el("iframe");
      frame.setAttribute("title", "布局探针");
      frame.setAttribute("style", "display:block;border:0;width:100%;height:100%;background:#08090b");
      frame.src = PROBE;
      host.appendChild(frame);
      document.body.appendChild(host);

      var done = false;

      function finish(res) {
        if (done) return;
        done = true;
        if (host.parentNode) host.parentNode.removeChild(host);
        resolve(res);
      }

      // 探针页是纯静态的，正常 300ms 内就绪；给足 6 秒，
      // 慢设备上首次光栅化也会拖时间。
      var timer = setTimeout(function () {
        finish({ ok: false, reason: "探针页没有在 6 秒内加载完（可能是资源读不出来）" });
      }, 6000);

      frame.onload = function () {
        // 等两帧，让 iframe 里完成首次布局
        setTimeout(function () {
          var out = readFrame(frame);
          clearTimeout(timer);
          finish(out);
        }, 260);
      };

      frame.onerror = function () {
        clearTimeout(timer);
        finish({ ok: false, reason: "探针页加载失败" });
      };
    });
  }

  function readFrame(frame) {
    var doc = null;
    try {
      doc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
    } catch (e) {
      return { ok: false, reason: "拿不到 iframe 文档（同源策略）" };
    }
    if (!doc || !doc.body) return { ok: false, reason: "iframe 里没有文档" };

    function box(sel) {
      var n = doc.querySelector(sel);
      if (!n) return null;
      var r = n.getBoundingClientRect();
      return {
        h: Math.round(r.height),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        w: Math.round(r.width),
      };
    }

    var device = box(".device");
    var app = box(".app");
    var views = box("#probe-views") || box(".views");
    var tabbar = box("#probe-tabbar") || box(".tabbar");
    var stage = box(".stage");

    var frameH = 0;
    try {
      frameH = Math.round(frame.getBoundingClientRect().height);
    } catch (e) {
      frameH = 0;
    }

    if (!device || !views) {
      return { ok: false, reason: "探针页里找不到外壳元素（样式可能完全没加载）", frameH: frameH };
    }

    // 判据只用两条，都直接对外壳：
    //   1) .device 有没有撑到视口高度
    //   2) 内容区有没有分到剩下的空间
    // 导航条位置只作为佐证记录下来，不单独判红 ——
    // 它受 safe-area 影响，在探针里未必和真机一致。
    var deviceOk = frameH > 0 && device.h >= frameH * 0.9;
    var viewsOk = views.h >= 120;

    return {
      ok: deviceOk && viewsOk,
      frameH: frameH,
      device: device,
      app: app,
      views: views,
      tabbar: tabbar,
      stage: stage,
      deviceOk: deviceOk,
      viewsOk: viewsOk,
    };
  }

  function layoutGroup(env, measured) {
    var g = group(
      "layout", "布局实测",
      "如果这一组红了，你看到的应该是「标题栏和导航条都在，中间一片黑」。"
    );

    if (!measured.ok && !measured.device) {
      item(g, "probe", "布局探针", "bad", "跑不起来", measured.reason || "", "");
      return;
    }

    var fh = measured.frameH;
    item(
      g, "frame", "探针视口", "ok", fh + " px", "", ""
    );

    item(
      g, "device", "外壳 .device", measured.deviceOk ? "ok" : "bad",
      measured.device.h + " px（应约 " + fh + "）",
      measured.deviceOk ? "" : "外壳没撑满视口 —— height:100dvh 多半被丢弃了。",
      ""
    );

    item(
      g, "views", "内容区 #views", measured.viewsOk ? "ok" : "bad",
      measured.views.h + " px（应 ≥ 120）",
      measured.viewsOk ? "" : "内容区高度为 0，页面内容被裁掉了 —— 这就是「中间一片黑」。",
      ""
    );

    if (measured.tabbar) {
      var nearBottom = fh - measured.tabbar.bottom;
      var tabOk = Math.abs(nearBottom) <= 4;
      item(
        g, "tabbar", "导航条位置", tabOk ? "ok" : "bad",
        "顶 " + measured.tabbar.top + " px / 底距 " + nearBottom + " px",
        tabOk ? "" : "导航条没有贴在底部，被上面塌掉的内容区顶上去了 —— 和用户截图里的样子一致。",
        ""
      );
    }

    return g;
  }

  /* ============================================================
     5. 资源
     --------------------------------------------------------
     不读全文，只要状态码、类型、长度。
     content-length 缺失时才读 body 兜底 —— 16 MB 的模型读一遍
     在慢设备上要好几秒，能省则省。
     ============================================================ */

  var ASSETS = [
    { path: "index.html", label: "index.html", kind: "html" },
    { path: "scripts/app.js", label: "scripts/app.js", kind: "js" },
    { path: "styles/base.css", label: "styles/base.css", kind: "css" },
    { path: "ime/keyboard.html", label: "ime/keyboard.html", kind: "html" },
    { path: "ime/lexicon.bin", label: "ime/lexicon.bin", kind: "bin" },
    { path: "ime/model/ppocrv5.ort", label: "ime/model/ppocrv5.ort", kind: "model" },
    { path: "ime/model/ppocrv5-dict.txt", label: "ime/model/ppocrv5-dict.txt", kind: "text" },
    { path: "ime/vendor/ort/ort.wasm.min.mjs", label: "ort.wasm.min.mjs", kind: "mjs" },
    { path: "ime/vendor/ort/ort-wasm-simd-threaded.wasm", label: "ort-wasm-*.wasm", kind: "wasm" },
  ];

  // 类型不对会怎样，取决于这个文件是"当模块加载"还是"当二进制读"
  function expectType(kind) {
    if (kind === "js" || kind === "mjs") return ["javascript", "ecmascript"];
    if (kind === "css") return ["text/css"];
    if (kind === "html") return ["text/html"];
    if (kind === "wasm") return ["application/wasm"];
    if (kind === "text") return ["text/plain", "octet-stream", "text/"];
    return ["octet-stream", "binary"];
  }

  function typeOk(kind, ct) {
    if (!ct) return null; // 没给类型，不判
    var low = ct.toLowerCase();
    var want = expectType(kind);
    for (var i = 0; i < want.length; i++) if (low.indexOf(want[i]) >= 0) return true;
    // json / css 之类的宽松匹配
    if (kind === "css" && low.indexOf("css") >= 0) return true;
    if ((kind === "js" || kind === "mjs") && low.indexOf("javascript") >= 0) return true;
    return false;
  }

  function fetchOne(a) {
    return new Promise(function (resolve) {
      var ctrl = null;
      var timer = null;
      try {
        ctrl = new AbortController();
        timer = setTimeout(function () {
          try {
            ctrl.abort();
          } catch (e) {}
        }, 8000);
      } catch (e) {
        ctrl = null;
      }

      var opts = { cache: "no-store" };
      if (ctrl) opts.signal = ctrl.signal;

      fetch(REPO + a.path, opts)
        .then(function (res) {
          var ct = "";
          var len = null;
          try {
            ct = res.headers.get("content-type") || "";
            var cl = res.headers.get("content-length");
            if (cl != null) len = parseInt(cl, 10);
          } catch (e) {}

          if (!res.ok) {
            if (timer) clearTimeout(timer);
            resolve({ a: a, status: res.status, ct: ct, len: len, fail: true });
            return;
          }
          if (len != null && !isNaN(len)) {
            if (timer) clearTimeout(timer);
            resolve({ a: a, status: res.status, ct: ct, len: len, fail: false });
            return;
          }
          // 没有 content-length：只能读完量一次
          return res
            .arrayBuffer()
            .then(function (buf) {
              if (timer) clearTimeout(timer);
              resolve({ a: a, status: res.status, ct: ct, len: buf.byteLength, fail: false });
            })
            .catch(function () {
              if (timer) clearTimeout(timer);
              resolve({ a: a, status: res.status, ct: ct, len: null, fail: false });
            });
        })
        .catch(function (err) {
          if (timer) clearTimeout(timer);
          resolve({ a: a, status: 0, ct: "", len: null, fail: true, err: err });
        });
    });
  }

  function assetsGroup(results) {
    var g = group("assets", "关键文件", "读不到 = 功能整块哑火；类型不对 = 浏览器拒绝执行。");
    // 两种失败要分开数：一个是"文件没了"，一个是"文件在但用不了"，
    // 用户能做的事完全不同（重装 vs 报 bug）
    var missing = 0;
    var wrongType = 0;

    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var a = r.a;

      if (r.fail) {
        missing++;
        item(
          g, a.path, a.label, "bad",
          (r.status ? "HTTP " + r.status : "请求失败"),
          r.status === 404
            ? "文件不存在 —— 安装包可能不完整，重装一次通常能解决。"
            : "取不到这个文件。它会直接导致对应功能不可用。",
          ""
        );
        continue;
      }

      var tok = typeOk(a.kind, r.ct);
      var detail = "HTTP " + r.status + " · " + (r.ct || "无类型") + " · " + kb(r.len);

      if (tok === false) {
        wrongType++;
        item(
          g, a.path, a.label, "bad", detail,
          a.kind === "mjs"
            ? "这是要被当作模块执行的文件，类型必须是 JavaScript；标成 octet-stream 时浏览器会拒绝加载。"
            : "类型和用途对不上，浏览器可能拒绝使用它。",
          ""
        );
      } else if (r.len != null && r.len === 0) {
        missing++;
        item(g, a.path, a.label, "bad", detail, "文件是空的，等于没有。", "");
      } else {
        item(g, a.path, a.label, "ok", detail, "", "");
      }
    }

    return { missing: missing, wrongType: wrongType };
  }

  /* ============================================================
     6. 原生能力
     ============================================================ */

  var BRIDGES = [
    { name: "DshNative", what: "本机 HTTP / 网络" },
    { name: "DshFs", what: "文件读写" },
    { name: "DshImeHost", what: "输入法主机（配置下发 / 截图回收）" },
    { name: "DshNode", what: "Node 插件运行时" },
    { name: "DshMcp", what: "本机 MCP 服务" },
    { name: "DshSpeech", what: "系统语音识别" },
    { name: "DshHud", what: "悬浮窗" },
    { name: "DshKeepAlive", what: "后台保活" },
    { name: "DshPower", what: "电池策略" },
  ];

  function nativeGroup(env) {
    var g = group(
      "native", "原生能力",
      "纯网页宿主下这一组全空是正常的；原生壳里缺了才是问题。"
    );

    var found = 0;
    for (var i = 0; i < BRIDGES.length; i++) {
      var b = BRIDGES[i];
      var has = false;
      try {
        has = typeof window[b.name] !== "undefined" && window[b.name] !== null;
      } catch (e) {
        has = false;
      }
      if (has) found++;
      item(
        g, b.name, b.name, has ? "ok" : "warn",
        has ? b.what : "未注入",
        has ? "" : "对应的功能会静默失效（界面在，点了没反应）。",
        ""
      );
    }

    var isNative = false;
    try {
      isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    } catch (e) {}

    if (!isNative && found === 0) {
      // 网页里本来就该什么都没有，别吓人
      for (var k = 0; k < g.items.length; k++) g.items[k].status = "skip";
    }

    return { found: found, total: BRIDGES.length };
  }

  /* ============================================================
     7. 存储
     ============================================================ */

  function storageGroup() {
    var g = group("storage", "本地存储", "存不住东西会导致「设置改了又变回去」这类怪事。");

    var ls = false;
    try {
      window.localStorage.setItem("__dsh_probe__", "1");
      ls = window.localStorage.getItem("__dsh_probe__") === "1";
      window.localStorage.removeItem("__dsh_probe__");
    } catch (e) {
      ls = false;
    }
    item(g, "ls", "localStorage", ls ? "ok" : "bad", ls ? "可写" : "不可用",
      ls ? "" : "设置、输入法记忆、会话索引都存这里，不可用等于每次打开都是新的。", "");

    var idb = !!window.indexedDB;
    item(g, "idb", "IndexedDB", idb ? "ok" : "warn", idb ? "有" : "没有",
      idb ? "" : "工作区文件索引依赖它，没有会退回更慢的路径。", "");

    return { ls: ls, idb: idb };
  }

  /* ============================================================
     渲染
     ============================================================ */

  var STYLE = {
    ok: { dot: "#3ddc97", text: "通过" },
    warn: { dot: "#e8b93a", text: "注意" },
    bad: { dot: "#ff5f56", text: "失败" },
    skip: { dot: "#5a6270", text: "跳过" },
  };

  var root = null;

  function renderHeader(env, verdict) {
    var head = el("div");
    head.setAttribute("style", "padding:18px 18px 14px");

    var h = el("div");
    h.setAttribute("style", "font-size:19px;font-weight:700;letter-spacing:.2px");
    txt(h, "环境自检");
    head.appendChild(h);

    var sub = el("div");
    sub.setAttribute("style", "margin-top:4px;font-size:12px;color:#8b93a1");
    txt(sub, "DSH Mobile · " + stamp(new Date()));
    head.appendChild(sub);

    var card = el("div");
    card.setAttribute(
      "style",
      [
        "margin-top:14px", "padding:14px 14px 13px", "border-radius:12px",
        "background:" + verdict.bg, "border:1px solid " + verdict.border,
      ].join(";")
    );

    var t = el("div");
    t.setAttribute("style", "font-size:15px;font-weight:600;color:" + verdict.fg + ";line-height:1.5");
    txt(t, verdict.title);
    card.appendChild(t);

    if (verdict.detail) {
      var d = el("div");
      d.setAttribute("style", "margin-top:6px;font-size:12.5px;line-height:1.7;color:#aab2c0");
      txt(d, verdict.detail);
      card.appendChild(d);
    }

    // 三档计数做成一行，扫一眼就知道严重程度
    var row = el("div");
    row.setAttribute("style", "margin-top:11px;display:flex;flex-wrap:wrap;font-size:12px;color:#8b93a1");
    var counts = [
      ["bad", countOf("bad")],
      ["warn", countOf("warn")],
      ["ok", countOf("ok")],
    ];
    for (var i = 0; i < counts.length; i++) {
      var s = counts[i][0];
      var n = counts[i][1];
      if (!n) continue;
      var c = el("span");
      c.setAttribute("style", "margin-right:14px;white-space:nowrap");
      var dot = el("span");
      dot.setAttribute("style", "display:inline-block;width:7px;height:7px;border-radius:50%;vertical-align:1px;margin-right:5px;background:" + STYLE[s].dot);
      c.appendChild(dot);
      txt(c, STYLE[s].text + " " + n);
      row.appendChild(c);
    }
    card.appendChild(row);

    head.appendChild(card);
    return head;
  }

  function renderGroup(g) {
    var sec = el("section");
    sec.setAttribute("style", "margin:0 0 2px");

    var gh = el("div");
    gh.setAttribute("style", "padding:16px 18px 7px;font-size:12px;font-weight:600;letter-spacing:.6px;color:#6f7887");
    txt(gh, g.title.toUpperCase());
    sec.appendChild(gh);

    if (g.hint) {
      var hint = el("div");
      hint.setAttribute("style", "padding:0 18px 9px;font-size:11.5px;line-height:1.65;color:#666e7c");
      txt(hint, g.hint);
      sec.appendChild(hint);
    }

    var box = el("div");
    box.setAttribute("style", "margin:0 12px;border-radius:11px;background:#12151a;border:1px solid #1e232b;overflow:hidden");

    for (var i = 0; i < g.items.length; i++) {
      var it = g.items[i];
      var row = el("div");
      row.setAttribute(
        "style",
        "padding:11px 12px;border-top:1px solid #1a1f26" + (i === 0 ? "" : "")
      );
      if (i === 0) row.style.borderTop = "0";

      var top = el("div");
      top.setAttribute("style", "display:flex;align-items:flex-start");

      var dot = el("span");
      dot.setAttribute(
        "style",
        "flex:none;width:7px;height:7px;border-radius:50%;margin:7px 9px 0 0;background:" + STYLE[it.status].dot
      );
      top.appendChild(dot);

      var lab = el("span");
      lab.setAttribute("style", "font-size:13px;font-weight:500;color:#dfe4ea;line-height:1.5");
      txt(lab, it.label);
      top.appendChild(lab);

      if (it.value) {
        var val = el("span");
        val.setAttribute(
          "style",
          "margin-left:auto;padding-left:10px;font-size:11.5px;line-height:1.6;color:" +
            (it.status === "bad" ? "#ff8b84" : it.status === "warn" ? "#e8c46a" : "#8b93a1") +
            ";text-align:right;word-break:break-all"
        );
        txt(val, it.value);
        top.appendChild(val);
      }
      row.appendChild(top);

      if (it.why && it.status !== "ok") {
        var why = el("div");
        why.setAttribute("style", "margin:5px 0 0 16px;font-size:11.5px;line-height:1.7;color:#8b93a1");
        txt(why, it.why);
        row.appendChild(why);
      }

      if (it.ref) {
        var ref = el("div");
        ref.setAttribute("style", "margin:3px 0 0 16px;font-size:11px;color:#5f6775");
        txt(ref, "需要 " + it.ref);
        row.appendChild(ref);
      }

      box.appendChild(row);
    }

    sec.appendChild(box);
    return sec;
  }

  /* ---------------- 结论 ---------------- */

  /**
   * 结论只有一个，所以必须先定优先级：
   *   语法 > 布局 > 文件 > 其它
   * 顺序不是随便排的 —— 语法挂了后面的检查根本没机会跑，
   * 布局挂了用户看到的和"功能坏了"是两回事，必须先说清楚。
   *
   * facts 全部是显式传入的计数，不去翻 groups：
   * 翻全局数组拿结论，改一次分组就悄悄变了判据，这种依赖太难查。
   */
  function verdictOf(facts) {
    var syntaxBad = facts.syntaxBad;

    if (syntaxBad > 0) {
      return {
        tone: "bad",
        title: "这台机器的 WebView 太旧，脚本会被整份拒绝",
        detail:
          "有 " + syntaxBad + " 项语法它不认识（最先撞上的是「" + facts.firstSyntax + "」）。" +
          "浏览器遇到不认识的语法不会跳过那一句，而是整份文件不执行 —— 界面会一直是黑的。" +
          "去应用商店更新「Android System WebView」，或换一台设备。",
        bg: "#2a1512", border: "#4a201b", fg: "#ffb0a9",
      };
    }

    if (facts.viewsBad || facts.deviceBad) {
      return {
        tone: "bad",
        title: "布局塌了：外壳没撑开，内容区高度为 0",
        detail:
          "这对应你看到的样子 —— 标题栏和导航条都在，中间一片黑。" +
          (facts.dvhBad ? "根因是 height:100dvh 不被支持，整条 height 声明被丢弃。" : "") +
          "这一层是样式问题，脚本本身是好的。",
        bg: "#2a1512", border: "#4a201b", fg: "#ffb0a9",
      };
    }

    if (facts.assetMissing > 0) {
      return {
        tone: "bad",
        title: "有 " + facts.assetMissing + " 个关键文件读不到",
        detail: "安装包可能不完整，或者被系统清理过。重装一次通常能解决；重装无效请把本页发出来。",
        bg: "#2a1512", border: "#4a201b", fg: "#ffb0a9",
      };
    }

    if (facts.assetWrongType > 0) {
      return {
        tone: "bad",
        title: "有 " + facts.assetWrongType + " 个文件类型标错了",
        detail:
          "文件都在，但服务端给的类型不对，浏览器会拒绝把它当脚本执行。" +
          "这是安装包自身的问题，重装无效 —— 请把本页发出来。",
        bg: "#2a1512", border: "#4a201b", fg: "#ffb0a9",
      };
    }

    if (countOf("bad") > 0) {
      return {
        tone: "warn",
        title: "界面能起来，但有 " + countOf("bad") + " 项不达标",
        detail: "具体功能可能异常。往下看红色那几条。",
        bg: "#241d0e", border: "#443619", fg: "#f0c674",
      };
    }

    if (countOf("warn") > 0) {
      return {
        tone: "warn",
        title: "环境可用，有 " + countOf("warn") + " 处需要注意",
        detail: "不影响启动，个别细节可能和设计稿不一致。",
        bg: "#241d0e", border: "#443619", fg: "#f0c674",
      };
    }

    return {
      tone: "ok",
      title: "全部通过",
      detail: "语法、样式、布局、文件、原生能力都正常。如果有具体功能异常，请在下面找到对应那一组。",
      bg: "#10231a", border: "#1f4433", fg: "#7ee2b0",
    };
  }

  /* ---------------- 报告文本 ---------------- */

  function buildReport(env, verdict) {
    var L = [];
    L.push("DSH 自检报告");
    L.push(stamp(new Date()));
    L.push("");
    L.push("结论：" + verdict.title);
    if (verdict.detail) L.push("      " + verdict.detail);
    L.push("");

    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      L.push("【" + g.title + "】");
      for (var j = 0; j < g.items.length; j++) {
        var it = g.items[j];
        var mark = it.status === "ok" ? "OK  " : it.status === "warn" ? "WARN" : it.status === "bad" ? "FAIL" : "----";
        var line = "  " + mark + "  " + it.label;
        if (it.value) line += " → " + it.value;
        if (it.ref && it.status !== "ok") line += "  (" + it.ref + ")";
        L.push(line);
        if (it.why && it.status !== "ok" && it.status !== "skip") L.push("        " + it.why);
      }
      L.push("");
    }

    L.push("【原始】");
    L.push("  UA " + (env.ua || ""));
    L.push("  Android " + (env.android || "?") + " · Chrome " + (env.chrome || "?") + (env.inApp ? " · 应用内" : ""));
    L.push("  视口 " + document.documentElement.clientWidth + "×" + document.documentElement.clientHeight +
      " @" + (window.devicePixelRatio || 1));
    return L.join("\n");
  }

  /* ---------------- 复制 ---------------- */

  function copyText(text, btn) {
    var old = btn.textContent;
    function done(ok) {
      btn.textContent = ok ? "已复制" : "请手动复制";
      setTimeout(function () {
        btn.textContent = old;
      }, 1600);
      if (!ok) showRaw(text);
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {
            done(true);
          },
          function () {
            done(fallbackCopy(text) ? true : false);
          }
        );
        return;
      }
    } catch (e) {}
    done(fallbackCopy(text));
  }

  /**
   * 复制失败的兜底：把报告摊在页面上，让用户长按选中。
   * WebView 里 clipboard API 需要用户手势和权限，execCommand 也可能被拦 ——
   * 两条都失败时不能只弹一句"复制失败"，那就等于报告带不走。
   */
  function showRaw(text) {
    var old = document.getElementById("sc-raw");
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var wrap = document.createElement("div");
    wrap.id = "sc-raw";

    var tip = document.createElement("div");
    tip.setAttribute("style", "margin:0 12px 8px;font-size:11.5px;line-height:1.7;color:#8b93a1");
    tip.appendChild(document.createTextNode("自动复制被系统拦下了。下面这段可以长按全选后复制："));
    wrap.appendChild(tip);

    var pre = document.createElement("pre");
    pre.className = "raw";
    pre.appendChild(document.createTextNode(text));
    wrap.appendChild(pre);

    document.body.appendChild(wrap);
    // 滚到看得见的位置 —— 报告很长，不滚用户找不到
    try {
      if (pre.scrollIntoView) pre.scrollIntoView({ block: "nearest" });
    } catch (e) {}
    try {
      var range = document.createRange();
      range.selectNodeContents(pre);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e2) {}
  }

  function fallbackCopy(text) {
    // 老内核没有 clipboard API，只能靠 execCommand。
    // textarea 必须真的在文档里、且有选区，否则部分 WebView 会返回 false。
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute(
        "style",
        "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;padding:0;border:0"
      );
      ta.setAttribute("readonly", "readonly");
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (e) {
        ok = false;
      }
      document.body.removeChild(ta);
      return ok;
    } catch (e2) {
      return false;
    }
  }

  /* ---------------- 主流程 ---------------- */

  var currentReport = "";
  // idle / running / done：没有这个标志，"重查"之后外界无法判断
  // 旧报告是新的还是上一轮的（report() 里的字符串长度不变，等条件会立刻满足）
  var phase = "idle";

  /**
   * 分两趟：
   *   第一趟（同步）只算「不需要网络的」——环境、语法、样式。这三组能在
   *   首帧之前就出结果，慢设备上也立刻有东西可看。
   *   第二趟（异步）等布局探针和资源抓取回来，再把剩下的组补上。
   *
   * 第一趟建好的组要先存起来，不能等第二趟重建 ——
   * 语法探测要 new Function 编译十几段代码，重来一遍纯属浪费。
   */
  function run() {
    phase = "running";
    currentReport = "";
    root.innerHTML = "";
    var loading = el("div");
    loading.setAttribute("style", "padding:60px 24px;text-align:center;color:#8b93a1;font-size:13px");
    txt(loading, "正在检查…");
    root.appendChild(loading);

    groups = [];
    var env = envGroup();
    var syn = syntaxGroup(env);
    styleGroup(env);
    var headGroups = groups;

    // 三路并行：模块语法探测、布局探针、资源抓取，互不依赖
    var modP = probeModuleFeatures();
    var layoutP = measureLayout(env);
    var assetP = Promise.all(
      ASSETS.map(function (a) {
        return fetchOne(a);
      })
    );

    Promise.all([modP, layoutP, assetP])
      .then(function (res) {
        // 模块语法是异步回填的，结论必须在这之后重算
        applyModuleResults(syn, res[0]);
        var syntaxFacts = syntaxFactsOf(syn.group);
        var layout = res[1];
        var assets = res[2];

        groups = headGroups;
        layoutGroup(env, layout);
        var assetFacts = assetsGroup(assets);
        nativeGroup(env);
        storageGroup();

        var dvhBad = false;
        for (var i = 0; i < headGroups.length; i++) {
          for (var j = 0; j < headGroups[i].items.length; j++) {
            if (headGroups[i].items[j].id === "dvh" && headGroups[i].items[j].status === "bad") dvhBad = true;
          }
        }

        var v = verdictOf({
          syntaxBad: syntaxFacts.bad,
          firstSyntax: syntaxFacts.firstBad,
          assetMissing: assetFacts.missing,
          assetWrongType: assetFacts.wrongType,
          dvhBad: dvhBad,
          viewsBad: !!(layout.device && layout.viewsOk === false),
          deviceBad: !!(layout.device && layout.deviceOk === false),
        });

        paint(env, v);
      })
      .catch(function (err) {
        phase = "done";
        root.innerHTML = "";
        var box = el("div");
        box.setAttribute("style", "padding:30px 20px;color:#ff8b84;font-size:13px;line-height:1.7");
        txt(box, "自检本身出错了：" + ((err && err.message) || err));
        root.appendChild(box);
      });
  }

  function paint(env, verdict) {
    currentReport = buildReport(env, verdict);
    phase = "done";

    root.innerHTML = "";
    root.appendChild(renderHeader(env, verdict));
    for (var i = 0; i < groups.length; i++) root.appendChild(renderGroup(groups[i]));

    var foot = el("div");
    foot.setAttribute("style", "padding:8px 18px 30px;font-size:11px;line-height:1.7;color:#565e6b");
    txt(foot, "自检只读取信息，不修改任何设置。");
    root.appendChild(foot);
  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    root = document.getElementById("sc-root");

    // 顶部工具条：三个动作
    var bar = document.getElementById("sc-bar");
    if (bar) {
      bar.addEventListener("click", function (ev) {
        var t = ev.target;
        while (t && t !== bar && !t.getAttribute("data-act")) t = t.parentNode;
        if (!t || t === bar) return;
        var act = t.getAttribute("data-act");

        if (act === "copy") {
          copyText(currentReport || "（还没跑完）", t);
        } else if (act === "rerun") {
          run();
        } else if (act === "back") {
          // 优先用历史记录返回（保留主界面状态），
          // 直接从外部打开时没有可回退的条目，就跳回首页。
          if (window.history && window.history.length > 1) {
            window.history.back();
          } else {
            location.href = "./index.html";
          }
        }
      });
    }

    // 诊断页自己要能在最差的环境里运行：
    // 如果连 DOM 都没就绪，就等一等再跑。
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run);
    } else {
      run();
    }
  }

  // 暴露给测试用
  window.__dshSelfCheck = {
    run: run,
    report: function () {
      return currentReport;
    },
    groups: function () {
      return groups;
    },
    phase: function () {
      return phase;
    },
    // 探针本身也要能被测：如果它永远返回 true，"支持"这个结论就没有意义
    probeModule: probeModule,
  };

  boot();
})();
