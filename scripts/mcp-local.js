/* ============================================================
   本机 MCP —— 白名单与服务开关的 JS 封装

   0.21.7 起，DSH 自带一个跑在本机的 MCP 服务器（127.0.0.1:8788），
   让 App 里的 Agent 能操作这台手机上的应用。

   但「能操作手机」这件事的敏感度很高，所以设计上做了三层收口：

   1) **默认关闭**。本机 MCP 服务默认不启动，装上应用不等于授权它监听端口。
      用户要在「设置 → 本机控制」里主动打开。

   2) **白名单收口**。用户逐个勾选允许控制的应用，模型能看到的
      「可用应用」就只有勾选过的那些；未勾选的一律拒绝，
      并把白名单内容报给模型，让它知道边界在哪。

   3) **最小权限**。不申请 QUERY_ALL_PACKAGES，靠 manifest 里的
      <queries> intent 过滤器只列出「有启动入口」的应用。

   浏览器 / PWA 没有原生桥，全部降级为 no-op（界面自动隐藏）。
   ============================================================ */

const bridge = () => (typeof window !== "undefined" ? window.DshMcp : null);

/** 是否具备本机控制能力（仅 APK 有）。 */
export function localMcpAvailable() {
  const b = bridge();
  return !!b && typeof b.listLaunchableApps === "function";
}

/** 服务是否已被用户启用。 */
export function isServerEnabled() {
  const b = bridge();
  if (!b) return false;
  try {
    return !!b.isServerEnabled();
  } catch {
    return false;
  }
}

/** 服务当前是否真的在监听。 */
export function isServerRunning() {
  const b = bridge();
  if (!b) return false;
  try {
    return !!b.isServerRunning();
  } catch {
    return false;
  }
}

/** 打开 / 关闭本机 MCP 服务。 */
export function setServerEnabled(on) {
  const b = bridge();
  if (!b) return false;
  try {
    if (on) b.enableServer();
    else b.disableServer();
    return true;
  } catch {
    return false;
  }
}

/**
 * 强制重建 :device 里的 MCP server。
 *
 * 用于「状态显示在跑、实际连不上」：那种情况下服务对象还在，
 * 但监听 socket 已经不能 accept，普通「开启」会被幂等判断挡回去。
 */
export function restartServer() {
  const b = bridge();
  if (!b || typeof b.restartServer !== "function") return false;
  try {
    return !!b.restartServer();
  } catch {
    return false;
  }
}

/**
 * 列出可启动的应用（应用名 + 包名 + 是否已在白名单）。
 * @returns {Array<{label:string, package:string, allowed:boolean}>}
 */
export function listLaunchableApps() {
  const b = bridge();
  if (!b || typeof b.listLaunchableApps !== "function") return [];
  try {
    const raw = b.listLaunchableApps();
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw || [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 当前白名单里的包名数组。 */
export function getAllowedPackages() {
  const b = bridge();
  if (!b) return [];
  try {
    const raw = b.getAllowedPackages();
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw || [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 覆盖整个白名单。 */
export function setAllowedPackages(list) {
  const b = bridge();
  if (!b) return false;
  try {
    b.setAllowedPackages(Array.isArray(list) ? list.join("\n") : String(list || ""));
    return true;
  } catch {
    return false;
  }
}

/** 加入 / 移出一个包名。 */
export function addAllowed(pkg) {
  const b = bridge();
  if (!b) return false;
  try {
    b.addAllowedPackage(pkg);
    return true;
  } catch {
    return false;
  }
}

export function removeAllowed(pkg) {
  const b = bridge();
  if (!b) return false;
  try {
    b.removeAllowedPackage(pkg);
    return true;
  } catch {
    return false;
  }
}

/**
 * 本机控制的当前状态（设置页直接渲染它）。
 *
 * 只有一条界面操作通道（Shizuku），状态围绕它的五档展开：
 *   0 未安装 / 1 装了没运行 / 2 未授权 / 3 连接中 / 4 就绪 / 5 已授权未连接
 *
 * `diag` 是 Shizuku 的连接、断开、授权结果日志，排障时先看它。
 *
 * @returns {{enabled:boolean, running:boolean, allowedCount:number,
 *            shizukuInstalled:boolean, shizukuRunning:boolean, shizukuGranted:boolean,
 *            shizukuState:number, shizukuDesc:string, diag:string,
 *            devicePid:number, deviceReachable:boolean, port:number, available:boolean}}
 */
export function localStatus() {
  const b = bridge();
  const fallback = {
    enabled: false,
    running: false,
    allowedCount: 0,
    // 唯一的界面操作通道
    shizukuInstalled: false,
    shizukuRunning: false,
    shizukuGranted: false,
    shizukuState: 0,
    shizukuDesc: "",
    diag: "",
    devicePid: 0,
    deviceReachable: false,
    port: 8788,
    // 悬浮窗权限：落点标记要靠它才能画
    overlay: false,
    available: false,
  };
  if (!b || typeof b.status !== "function") return fallback;
  try {
    const raw = b.status();
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw || {};
    return { ...fallback, ...obj, available: true };
  } catch {
    return fallback;
  }
}

/**
 * 打开本应用的「应用信息」页。
 *
 * Android 13+ 对非应用商店安装的应用默认禁止开启无障碍等敏感权限，
 * 必须先在这个页面点右上角 ⋮ →「允许受限设置」放行。
 * 这是「开关点开后离开界面自己弹回」的头号成因。
 */
export function openAppInfoSettings() {
  const b = bridge();
  if (!b || typeof b.openAppInfoSettings !== "function") return false;
  try {
    return !!b.openAppInfoSettings();
  } catch {
    return false;
  }
}

/* ---------------- 低速通道（Shizuku） ----------------
 *
 * 这些动作都只是「转发给 :device 进程」——
 * UserService 的连接状态活在那边，主进程操作不到。
 */

/** 申请 Shizuku 授权（会弹 Shizuku 自己的确认框）。 */
export function requestShizukuPermission() {
  const b = bridge();
  if (!b || typeof b.requestShizukuPermission !== "function") return false;
  try {
    b.requestShizukuPermission();
    return true;
  } catch {
    return false;
  }
}

/** 主动建立 UserService 连接（授权之后调一次可以省掉首次调用的等待）。 */
export function connectShizuku() {
  const b = bridge();
  if (!b || typeof b.connectShizuku !== "function") return false;
  try {
    b.connectShizuku();
    return true;
  } catch {
    return false;
  }
}

/** 打开 Shizuku 应用（没启动时用户需要手动启动它）。返回 false = 没装。 */
export function openShizukuApp() {
  const b = bridge();
  if (!b || typeof b.openShizukuApp !== "function") return false;
  try {
    return !!b.openShizukuApp();
  } catch {
    return false;
  }
}

/* ---------------- 落点标记 ----------------
 *
 * 开关状态存在 :device 侧的文件里（ai-pointer.txt），不是 localStorage。
 * 原因和 ui-channel 一样：真正消费它的是 :device 里的 ui_* 工具，
 * 存两份就会出现「设置里关了、屏幕上还在画」这种对不上的状态。
 */

/** 是否在 AI 点击/滑动时显示落点。浏览器环境按默认（开）返回。 */
export function isPointerMarkEnabled() {
  const b = bridge();
  if (!b || typeof b.isPointerMarkEnabled !== "function") return true;
  try {
    return !!b.isPointerMarkEnabled();
  } catch {
    return true;
  }
}

/** 打开 / 关闭落点标记。返回 true 表示已写入。 */
export function setPointerMarkEnabled(on) {
  const b = bridge();
  if (!b || typeof b.setPointerMarkEnabled !== "function") return false;
  try {
    b.setPointerMarkEnabled(!!on);
    return true;
  } catch {
    return false;
  }
}

/**
 * 本机 MCP 在 App 里对应的服务器配置。
 * 用户不用手填 URL —— 一键写入。
 */
export function localServerConfig() {
  return { name: "本机", url: `http://127.0.0.1:${localStatus().port || 8788}/mcp`, token: "" };
}
