/**
 * 单通道（Shizuku）的契约测试。
 *
 * ============ 为什么用「读源码」这种测法 ============
 *
 * 真正要守的不是某个函数返回什么，而是几条**结构性约束**：
 *
 *   · UserService 必须 extends Stub，不能 extends Service（否则永远连不上）
 *   · 它不能出现在 AndroidManifest 里（Shizuku 不走 AMS 绑定）
 *   · :device 里必须调 enableMultiProcessSupport(false) + requestBinderForNonProviderProcess
 *   · 无障碍通道必须**彻底不再出现**（0.26.0 删除，防止被改回来）
 *
 * 这些错误编译期不报，运行时表现为「连不上」「没有通道」，
 * 而且很难从现象反推。所以直接对源码做断言，让后来人改坏时立刻红。
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";

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

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const f = join(ROOT, normalize(p));
    const b = await readFile(f);
    res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" });
    res.end(b);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

/* ============================================================
   一、UserService 结构（错了就永远连不上）
   ============================================================ */

const svc = await readFile(join(ROOT, "android/java/DshShizukuService.java"), "utf8");
const client = await readFile(join(ROOT, "android/java/DshShizuku.java"), "utf8");
const tools = await readFile(join(ROOT, "android/java/DshMcpTools.java"), "utf8");
const bootstrap = await readFile(join(ROOT, "android/java/DshMcpBootstrap.java"), "utf8");
const build = await readFile(join(ROOT, "android/build-apk.sh"), "utf8");
const aidl = await readFile(join(ROOT, "android/aidl/ai/deepseek/dsh/mobile/IShizukuExec.aidl"), "utf8");

check("契约：UserService 继承 IShizukuExec.Stub", /class DshShizukuService extends IShizukuExec\.Stub/.test(svc));
check("契约：UserService 不继承 Service（否则 bindUserService 永不回调）", !/class DshShizukuService extends Service/.test(svc));
check("契约：UserService 不在 manifest 声明", !/android:name="\.DshShizukuService"/.test(build));
check("契约：AIDL 定义了 exec", /String exec\(String cmd\)/.test(aidl));
check("契约：UserService 有带 Context 的构造", /public DshShizukuService\(Context ctx\)/.test(svc));
check("契约：命令输出有上限（Binder 事务 1MB）", /MAX_OUTPUT\s*=\s*900\s*\*\s*1024/.test(svc));
check("契约：命令有硬超时", /TIMEOUT_MS\s*=\s*15000/.test(svc));
check("契约：合并 stderr（否则子进程会阻塞）", /redirectErrorStream\(true\)/.test(svc));

check("契约：manifest 声明 ShizukuProvider", /rikka\.shizuku\.ShizukuProvider/.test(build));
check("契约：provider 带官方权限保护", /INTERACT_ACROSS_USERS_FULL/.test(build));
check("契约：provider authorities 用 applicationId", /\$\{applicationId\}\.shizuku/.test(build));
check("契约：manifest 声明 Shizuku 包可见性", /<package android:name="moe\.shizuku\.privileged\.api" \/>/.test(build));
check("契约：minSdk 24（Shizuku api 库的硬要求）", /minSdkVersion = 24/.test(build));

check("契约：非 provider 进程声明 enableMultiProcessSupport(false)", /enableMultiProcessSupport\(false\)/.test(bootstrap));
check("契约：主动请求 binder", /requestBinderForNonProviderProcess\(ctx\)/.test(bootstrap));
{
  const code = bootstrap
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
  const iEnable = code.indexOf("enableMultiProcessSupport(false)");
  const iReq = code.indexOf("requestBinderForNonProviderProcess(ctx)");
  check("契约：先声明身份再请求 binder", iEnable > -1 && iReq > iEnable, `${iEnable} < ${iReq}`);
}

check("契约：UserServiceArgs 显式设置 tag（R8 后类名会变）", /\.tag\("dsh_exec"\)/.test(client));
check("契约：daemon 关闭", /\.daemon\(false\)/.test(client));
{
  const start = client.indexOf("public static int state(Context ctx)");
  const body = client
    .slice(start, start + 1600)
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
  const iRun = body.indexOf("running()");
  const iInst = body.indexOf("installed(ctx)");
  check("契约：state 先判断 binder 再判断包名", iRun > -1 && iInst > iRun, `running@${iRun} installed@${iInst}`);
}

/* ============================================================
   二、无障碍通道必须彻底消失（0.26.0）
   ============================================================ */

const A11Y_CLASSES = /DshA11yService|DshA11yState|DshA11yFlags|DshA11yKeepAliveService|DshA11yReviveJob/;

for (const f of ["DshMcpTools.java", "DshMcpBridge.java", "DshStatus.java", "MainActivity.java", "DshDeviceService.java"]) {
  const src = await readFile(join(ROOT, "android/java", f), "utf8");
  check(`${f} 不再引用无障碍类`, !A11Y_CLASSES.test(src));
}
check("构建清单不含无障碍类", !A11Y_CLASSES.test(build));
check("manifest 不声明无障碍服务", !/BIND_ACCESSIBILITY_SERVICE/.test(build));
check("无障碍服务源码已删除", !existsSync(join(ROOT, "android/java/DshA11yService.java")));
check("无障碍配置 xml 已删除", !existsSync(join(ROOT, "android/res/xml/dsh_a11y.xml")));
check("不再有通道偏好（单通道不需要）", !/ui-channel\.txt/.test(tools));

/* ============================================================
   三、ui_* 只走 Shizuku
   ============================================================ */

for (const fn of ["uiDump", "uiClickText", "uiTap", "uiSwipe", "uiSetText", "uiGlobal"]) {
  const start = tools.indexOf(`private static String ${fn}(`);
  const next = tools.indexOf("\n    private static", start + 10);
  const body = tools.slice(start, next > start ? next : start + 3000);
  check(`${fn} 走 Shizuku`, /DshShizuku\./.test(body));
  check(`${fn} 没有残留的无障碍分支`, !/DshA11yService|viaChannels/.test(body));
}

check("契约：结果标明通道", /（通道：Shizuku）/.test(tools));
check("契约：白名单拒绝不包装成通道故障", /if \(isDenied\(e\)\) throw e;/.test(tools));
check("契约：通道故障报错带排查指引", /Shizuku 服务要在运行/.test(tools));
check("契约：中文走剪贴板粘贴", /input keyevent 279/.test(client) && /setPrimaryClip/.test(client));

check("契约：device_status 带本机指纹", /【本机指纹】/.test(tools) && /Build\.FINGERPRINT/.test(tools));
check("契约：指纹里带 DSH 版本号", /appVersion\(ctx\)/.test(tools));

/* ============================================================
   三·五、坐标（0.26.1）
   ============================================================ */

check("契约：bounds 用正则解析", /BOUNDS_RE\s*=\s*$|BOUNDS_RE\s*=\s*\n?\s*java\.util\.regex\.Pattern\.compile/m.test(client));
check("契约：findCenter 不再用 indexOf('[') 找 bounds", !/int open = line\.indexOf\('\['\)/.test(client));
check("契约：ui_dump 每行直接给中心点", /中心\("\)/.test(client) || /append\(" 中心\("/.test(client));
check("契约：ui_dump 头部给屏幕尺寸与旋转", /append\("屏幕："\)/.test(client) && /rotateDeg/.test(client));
check("契约：ui_tap 支持 0~1 比例", /toPixels\(ctx, x, y\)/.test(tools));
check("契约：ui_swipe 支持 0~1 比例", /toPixels\(ctx, x1, y1\)/.test(tools) && /toPixels\(ctx, x2, y2\)/.test(tools));
check("契约：比例判定是「两轴都 ≤1」", /x > 0 && x <= 1 && y > 0 && y <= 1/.test(client));
check("契约：坐标越界钳制到屏幕内", /Math\.max\(0, Math\.min\(w - 1, px\)\)/.test(client));
check("契约：工具描述写明比例用法", /0~1 的比例/.test(tools));

{
  // 真正的回归点：文字里带方括号时，旧实现会解析到错误位置。
  // 把 Java 里的正则原样搬到 JS 跑一遍，验证「取最后一个匹配」的语义是对的。
  const m = client.match(/BOUNDS_RE\s*=[\s\S]{0,80}?Pattern\.compile\("((?:[^"\\]|\\.)*)"\)/);
  const javaRegex = m ? m[1].replace(/\\\\/g, "\\") : "";
  check("契约：能从源码取出 BOUNDS 正则", javaRegex.includes("(-?\\d+)"), javaRegex.slice(0, 40));

  const re = new RegExp(javaRegex, "g");
  const cases = [
    ['#3 TextView "[图片]" [42,318][1218,432] 中心(630,375) 可点', "[42,318][1218,432]"],
    ['#2 Button "价格[1,2]" [10,20][110,60] 中心(60,40) 可点', "[10,20][110,60]"],
    ['#1 Button "确定" [542,1298][718,1362] 中心(630,1330) 可点', "[542,1298][718,1362]"],
  ];
  for (const [line, want] of cases) {
    let last = null;
    let it;
    re.lastIndex = 0;
    while ((it = re.exec(line)) !== null) last = it[0];
    check(`解析：${line.slice(0, 26)}… → ${want}`, last === want, String(last));
  }
}

/* ============================================================
   三·六、前台判定（0.26.2）
   ============================================================ */

const policy = await readFile(join(ROOT, "android/java/DshMcpPolicy.java"), "utf8");

check("契约：同时解析 mCurrentFocus 与 mFocusedApp", /mCurrentFocus/.test(client) && /mFocusedApp/.test(client));
check("契约：currentWindows 返回两个包名", /public static String\[\] currentWindows/.test(client));
check("契约：输入法列表读 enabled_input_methods", /enabled_input_methods/.test(client));
check("契约：isIme 存在", /public static boolean isIme\(Context ctx, String pkg\)/.test(client));
check("契约：软键盘是否弹出用 dumpsys input_method 判定", /dumpsys input_method/.test(client));

{
  // 关键回归点：焦点在输入法时必须回退到 mFocusedApp 判定，
  // 而不是拿输入法包名去比白名单（那必然不在，于是「点不了软键盘」）。
  const start = tools.indexOf("private static String uiTarget(Context ctx)");
  const body = tools.slice(start, start + 1800);
  check("契约：uiTarget 识别输入法", /DshShizuku\.isIme\(ctx, focus\)/.test(body));
  check("契约：输入法时判定背后的应用", /isAllowed\(ctx, app, false\)/.test(body));
  check("契约：没有焦点窗口时退回 Activity 归属", /if \(focus == null\) focus = app/.test(body));
}
for (const fn of ["uiTap", "uiSwipe", "uiSetText"]) {
  const start = tools.indexOf(`private static String ${fn}(`);
  const next = tools.indexOf("\n    private static", start + 10);
  const body = tools.slice(start, next > start ? next : start + 3000);
  check(`${fn} 用 uiTarget 判定（不再直接比焦点包名）`, /uiTarget\(ctx\);/.test(body));
}

check("契约：ui_global 支持 enter（键盘的搜索/发送键）", /case "enter":/.test(client) && /key = 66;/.test(client));
check("契约：ui_global 支持 delete", /case "delete":/.test(client) && /key = 67;/.test(client));
check("契约：dump 提示软键盘不在控件树里", /软键盘正在显示/.test(client) && /不在上面这份列表里/.test(client));
check("契约：system 包 android 放行（ANR 弹窗能点）", /ALWAYS_ALLOWED\.add\("android"\)/.test(policy));
check("契约：权限授予弹窗仍然拒绝", !/ALWAYS_ALLOWED\.add\("com\.android\.permissioncontroller"\)/.test(policy));
check("契约：device_status 报焦点窗口（排查点不动时最有用）", /焦点窗口：/.test(tools));

/* ============================================================
   三·七、落点标记（0.27.0）
   ============================================================ */

const pointer = await readFile(join(ROOT, "android/java/DshPointerOverlay.java"), "utf8");
const uiSrc = await readFile(join(ROOT, "scripts/ui.js"), "utf8");
const mcpLocalSrc = await readFile(join(ROOT, "scripts/mcp-local.js"), "utf8");
const screensSrc = await readFile(join(ROOT, "scripts/screens.js"), "utf8");

check("契约：落点 View 存在", /class DshPointerOverlay extends View/.test(pointer));
check("契约：窗口不可触摸（否则会吃掉 input tap）", /FLAG_NOT_TOUCHABLE/.test(pointer));
check("契约：窗口对齐物理屏幕（否则整体偏一个状态栏）", /FLAG_LAYOUT_IN_SCREEN/.test(pointer));
check("契约：API 24/25 用 TYPE_PHONE 兜底", /TYPE_PHONE/.test(pointer));
check("契约：绘制时用 getLocationOnScreen 校准", /getLocationOnScreen\(loc\)/.test(pointer));
check("反向契约：不用无障碍浮层", !/TYPE_ACCESSIBILITY_OVERLAY/.test(pointer));
check("契约：Android 12+ 降低窗口不透明度（untrusted touch 阈值 0.8）",
  /0\.75f/.test(pointer) && /SDK_INT >= 31/.test(pointer));
check("契约：按需挂窗，空闲即摘", /removeViewImmediate/.test(pointer) && /detachIfIdle/.test(pointer));
check("契约：开关默认开（读不到也算开）", /CONFIG_FILE = "ai-pointer\.txt"/.test(pointer)
  && /if \(!f\.exists\(\)\) return true;/.test(pointer));

for (const [fn, call] of [["uiTap", "DshShizuku.tap"], ["uiClickText", "DshShizuku.tap"], ["uiSwipe", "DshShizuku.swipe"]]) {
  const start = tools.indexOf(`private static String ${fn}(`);
  const next = tools.indexOf("\n    private static", start + 10);
  const body = tools.slice(start, next > start ? next : start + 3000);
  const iMark = body.indexOf("DshPointerOverlay.mark");
  const iCall = body.indexOf(call);
  check(`${fn} 先画落点再执行`, iMark > -1 && iCall > iMark, `mark@${iMark} call@${iCall}`);
}

check("契约：开关走文件桥（不是 prefs）", /setPointerMarkEnabled/.test(
  await readFile(join(ROOT, "android/java/DshMcpBridge.java"), "utf8")));
check("契约：开关文件常量复用于两端", /DshPointerOverlay\.CONFIG_FILE/.test(
  await readFile(join(ROOT, "android/java/DshMcpBridge.java"), "utf8")));
check("契约：status 暴露悬浮窗权限", /local\.put\("overlay", canDrawOverlays\(\)\)/.test(
  await readFile(join(ROOT, "android/java/DshMcpBridge.java"), "utf8")));
check("契约：前端有开关封装", /export function isPointerMarkEnabled/.test(mcpLocalSrc)
  && /export function setPointerMarkEnabled/.test(mcpLocalSrc));
check("契约：设置页有开关行", /data-act="toggle-pointer-mark"/.test(screensSrc));
check("契约：ui.js 有对应事件", /case "toggle-pointer-mark"/.test(uiSrc));
check("契约：构建清单包含落点类（漏了会 cannot find symbol）", /for f in .*DshPointerOverlay/.test(build));

/* ============================================================
   四、界面：只有一张通道卡，五档各给一个动作
   ============================================================ */

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox"],
});

async function renderWith(state) {
  const page = await browser.newPage();
  await page.addInitScript((st) => {
    window.DshMcp = {
      isServerEnabled: () => true,
      isServerRunning: () => true,
      listLaunchableApps: () => JSON.stringify([]),
      getAllowedPackages: () => JSON.stringify([]),
      status: () => JSON.stringify(st),
      setAllowedPackages: () => {},
      addAllowedPackage: () => {},
      removeAllowedPackage: () => {},
      enableServer: () => {},
      disableServer: () => {},
      openAppInfoSettings: () => true,
      requestShizukuPermission: () => {},
      connectShizuku: () => {},
      openShizukuApp: () => true,
    };
  }, state);
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const html = await page.evaluate(async () => {
    const m = await import("/scripts/screens.js");
    return m.renderSettings("tools");
  });
  await page.close();
  return html;
}

const base = {
  enabled: true,
  running: true,
  allowedCount: 0,
  diag: "",
  devicePid: 1234,
  deviceReachable: true,
  port: 8788,
};

{
  const h = await renderWith({ ...base, shizukuInstalled: false, shizukuRunning: false, shizukuGranted: false, shizukuState: 0, shizukuDesc: "未安装 Shizuku" });
  check("界面：有通道卡", h.includes("界面操作 · Shizuku"));
  check("界面：未安装时给下载入口", h.includes('data-act="open-shizuku-download"'));
  check("界面：说明了为什么去掉无障碍", h.includes("时好时坏"));
  check("界面：不再有通道选择器", !h.includes('data-seg="ui-channel"'));
  check("界面：不再有无障碍卡片", !h.includes("无障碍服务</div>"));
}

{
  const h = await renderWith({ ...base, shizukuInstalled: true, shizukuRunning: false, shizukuGranted: false, shizukuState: 1, shizukuDesc: "没在运行" });
  check("界面：没运行时给「打开 Shizuku」", h.includes('data-act="open-shizuku-app"'));
  check("界面：提示重启后需手动启动", h.includes("每次重启手机后要重新启动一次"));
}

{
  const h = await renderWith({ ...base, shizukuInstalled: true, shizukuRunning: true, shizukuGranted: false, shizukuState: 2, shizukuDesc: "未授权" });
  check("界面：未授权时给「授权 DSH」", h.includes('data-act="request-shizuku"'));
}

{
  const h = await renderWith({ ...base, shizukuInstalled: true, shizukuRunning: true, shizukuGranted: true, shizukuState: 5, shizukuDesc: "已授权未连接" });
  check("界面：已授权未连接时给「立即连接」", h.includes('data-act="connect-shizuku"'));
}

{
  const h = await renderWith({ ...base, shizukuInstalled: true, shizukuRunning: true, shizukuGranted: true, shizukuState: 4, shizukuDesc: "就绪 · uid 2000" });
  check("界面：就绪时显示结论", h.includes("通道就绪"));
  check("界面：就绪时不再给连接按钮", !h.includes('data-act="connect-shizuku"'));
}

/* ============================================================
   五、状态字段完整性
   ============================================================ */

{
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const st = await page.evaluate(async () => {
    const m = await import("/scripts/mcp-local.js");
    return m.localStatus();
  });
  await page.close();
  const keys = ["shizukuInstalled", "shizukuRunning", "shizukuGranted", "shizukuState", "shizukuDesc", "diag"];
  check("降级状态带全部 Shizuku 字段（浏览器环境不崩）", keys.every((k) => k in st), keys.filter((k) => !(k in st)).join(",") || "");
  check("降级状态不再有无障碍字段", !("a11yEnabled" in st) && !("a11yConnected" in st));
}

await browser.close();
server.close();

console.log("");
if (fail) {
  console.log(`✗ ${fail} 项失败（通过 ${pass}）`);
  process.exit(1);
} else {
  console.log(`全部通过（${pass} 项）`);
}
