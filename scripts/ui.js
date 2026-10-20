/* ============================================================
   UI — 应用外壳、路由、对话流、面板与事件代理
   ============================================================ */

import {
  state,
  subscribe,
  save,
  emit,
  createSession,
  switchSession,
  deleteSession,
  forkSession,
  addMessage,
  activeSession,
  setSettings,
  togglePlugin,
  installPlugin,
  toggleAutomation,
  addAutomation,
  deleteAutomation,
  stopRun,
  currentMode,
  currentModel,
  upsertCustomModel,
  removeCustomModel,
  upsertMcpServer,
  removeMcpServer,
  saveSessionNow,
  flushSessionNow,
  replaceFiles,
  resetAll,
  MODES,
  PROVIDERS,
  PROVIDER_COUNT,
  knownModelCtx,
  knownModelVision,
  rememberModelCatalog,
  catalogFor,
  hasModels,
  allModels,
  apiKeyForCurrent,
  apiKeyFor,
  hasKeyFor,
  providerKeyOf,
  modelStatusOf,
  modelContextWindow,
  modelApiId,
  modelBaseUrl,
  saveModelOverride,
  clearModelOverride,
  setModelStatus,
  PERMISSIONS,
  fmtTime,
  fmtRelative,
  fmtClock,
  fmtTokens,
  listFiles,
  listLibrary,
  readFile,
  readDoc,
  writeFile,
  deleteFile,
  saveToLibrary,
  deleteFromLibrary,
  importToLibrary,
  importToWorkspace,
  exportDoc,
  filesStats,
} from "./store.js";
import { icon } from "./icons.js";
import { isTextPath } from "./fs.js";
import { isImagePath, imageMime, prepareThumb, prepareImage } from "./image.js";
import { renderMarkdown, plainText } from "./markdown.js";
import { availableToolNames } from "./tools.js";
import {
  mountEffortSlider,
  effortIndex,
  effortName,
  effortColor,
} from "./effort-slider.js";
import { fmtContext } from "./context.js";
import { runAgent, testConnection, testProvider, testModel, fetchModelList, spawnSubagentOnce } from "./runtime.js";
import { mcpDiscover } from "./mcp.js";
import { downloadBase64 } from "./office.js";
import { hudRender, hudPermissionGranted, nativeHudAvailable } from "./hud.js";
import {
  keepAliveStart,
  keepAliveStop,
  requestBatteryExemption,
  openBatterySettings,
  openAutoStartSettings,
} from "./keep-alive.js";
import { SAFETY_RULES } from "./safety.js";
import {
  renderHome,
  renderWorkspace,
  renderPlugins,
  renderTasks,
  renderSettings,
  SETTINGS_CAT_MAP,
  renderDrawer as renderDrawerHTML,
} from "./screens.js";

/* ---------------- 本地 UI 状态 ---------------- */

const ui = {
  view: "chat",
  drawer: false,
  sheet: null,
  approval: null,
  run: null,
  pinned: true,
  toolOpen: new Set(),
  reasoningOpen: new Set(),
  draft: "",
  composing: false,
  sheetTimer: null,
  confirmAction: null,
  testing: false,
  testResult: null,
  lastBuilt: null,
  renderFrom: null, // 渲染窗口起点（消息下标）
  workspaceTab: "workspace",
  attachments: [],   // 待随消息发送的附件 [{path,name,size}]
  msgNodes: new Map(), // 消息 id -> DOM，供增量渲染复用
  imageViewer: false,  // 图片查看器是否打开（返回键优先关它）
  settingsCat: null,
  pluginQuery: "",
  layer: false,
  hudCue: null, // 一次性动画事件（start / failed / limitHit），快照消费后清空
  hudBadge: null, // 持续徽标 {kind: "failed"|"limited", until}
  hudDoneUntil: 0, // 完成态保持到此时刻（小球笑眼 + 鳍连扇）
};

const els = {};
const $ = (sel, root = document) => root.querySelector(sel);

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/* ---------------- 初始化 ---------------- */

export function initUI() {
  els.appbar = $("#appbar");
  els.tabbar = $("#tabbar");
  els.views = $("#views");
  els.drawer = $("#drawer");
  els.scrim = $("#scrim");
  els.sheet = $("#sheet-layer");
  els.toast = $("#toast-layer");
  els.app = $("#app");

  document.documentElement.dataset.theme = state.settings.theme;
  document.documentElement.classList.toggle("no-motion", !state.settings.motion);
  applyDisplaySettings();

  bindEvents();
  subscribe((detail) => {
    if (detail?.type === "settings") {
      document.documentElement.dataset.theme = state.settings.theme;
      document.documentElement.classList.toggle("no-motion", !state.settings.motion);
      applyDisplaySettings();
    }
    if (detail?.type === "fs:write" && ui.view === "workspace") renderMain(true);
    if (detail?.type === "plugin:install") renderMain(true);
  });

  renderAll();
  requestAnimationFrame(() => {
    document.querySelectorAll(".view[data-active='true'] .reveal").forEach((el) => el.classList.add("is-in"));
  });

  const params = new URLSearchParams(location.search);
  if (params.get("new") === "1") createSession({ mode: state.settings.mode });
  const v = params.get("view");
  if (v && ["chat", "workspace", "plugins", "tasks"].includes(v)) navigate(v);

  initNativeBack();
  startHudLoop();
  installLifecycleHooks();
}

/* ---------------- 生命周期钩子 ---------------- */

/**
 * 切后台 / 回前台的收尾。
 *
 * - 切后台：立刻把正在流式的内容落盘。Android 随时可能因为内存把进程回收，
 *   之前只在运行结束才写盘，中途被杀就整段白跑。
 * - 回前台：如果状态里还挂着"孤儿运行"（执行器随进程一起没了），
 *   自动把它收尾成"已停止"，界面不会一直转圈，用户也能继续发消息。
 */
function installLifecycleHooks() {
  window.addEventListener("dsh:flush", () => {
    // 切后台这一刻进程随时可能被回收：必须立即落盘，不能等 1.2s 节流器
    const s = activeSession();
    if (s) flushSessionNow(s.id);
    save(true);
  });

  window.addEventListener("dsh:resume", () => {
    // 关键：只有"内存里已经没有执行器"才叫孤儿运行。
    // 之前这里无条件把 running 状态的消息判为中断，导致——
    // 任务其实好好地在跑（只是切后台时流式渲染被节流、肉眼看不到进度），
    // 用户切回来却看到"上次运行被系统中断"，还把它停掉了。
    // 这是"切后台任务就停"在应用侧的直接成因之一。
    if (ui.run) {
      // 任务还在：只是把界面重新拉起来，不动执行器
      updateMessages();
      renderAppbar();
      return;
    }
    const orphan = orphanRunning();
    if (orphan) {
      orphan.status = "stopped";
      orphan.error = "上次运行被系统中断（应用在后台被回收）。已保留已生成的内容。";
      orphan.interrupted = true;
      for (const t of orphan.tools || []) {
        if (t.status === "running" || t.status === "waiting") t.status = "stopped";
      }
      const s = activeSession();
      if (s) saveSessionNow(s.id);
      save(true);
      lastSendKind = "";
      updateSendState();
      updateMessages();
      renderAppbar();
      toast("上次运行被系统中断，已自动收尾", "err");
    }
  });
}

/* ---------------- Android 返回手势 ---------------- */

/** 设置页里从某个大类退回大类列表；不在小类页时返回 false。 */
function settingsBack() {
  if (ui.view !== "settings" || !ui.settingsCat) return false;
  ui.settingsCat = null;
  ui.settingsScroll = null;
  renderAppbar();
  renderMain(true);
  return true;
}

let exitArmed = false;

function handleNativeBack() {
  if (ui.imageViewer) {
    closeImageViewer();
    return;
  }
  // 审批面板必须显式选择，返回键不关闭
  if (ui.sheet && !ui.sheet.dismissible) return;
  if (ui.sheet) {
    closeSheet();
    return;
  }
  if (ui.drawer) {
    closeDrawer();
    return;
  }
  if (settingsBack()) return;
  if (ui.view !== "chat") {
    navigate("chat");
    return;
  }
  // 主对话页：两段式退出，避免全面屏手势一划就杀掉应用
  if (exitArmed) {
    window.Capacitor?.Plugins?.App?.exitApp?.();
    return;
  }
  exitArmed = true;
  setTimeout(() => {
    exitArmed = false;
  }, 2200);
  haptic(10);
  toast("再按一次返回退出");
}

function initNativeBack() {
  const CapApp = window.Capacitor?.Plugins?.App;
  if (!CapApp?.addListener) return; // 浏览器 / PWA 走 popstate
  try {
    CapApp.addListener("backButton", handleNativeBack);
  } catch {
    /* 插件不可用时忽略 */
  }
}

/* ---------------- 外壳 ---------------- */

function renderAll() {
  renderAppbar();
  renderTabbar();
  renderMain(true);
  renderDrawer();
}

function renderAppbar() {
  const s = activeSession();
  const mode = currentMode();
  let kicker = "DSH MOBILE · 0.1.0";
  let title = "新会话";
  let actions = "";

  if (ui.view === "chat") {
    title = s?.title || "新会话";
    kicker = "";
    actions = `<button class="icon-btn" data-act="session-menu" aria-label="会话操作">${icon("more")}</button>`;
  } else if (ui.view === "workspace") {
    const lib = ui.workspaceTab === "library";
    title = lib ? "资料库" : "工作区";
    kicker = "";
    actions = lib
      ? `<button class="icon-btn" data-act="import-library" aria-label="导入文件">${icon("download")}</button>`
      : `<button class="icon-btn" data-act="new-file" aria-label="新建文件">${icon("plus")}</button>`;
  } else if (ui.view === "plugins") {
    title = "插件";
    kicker = "";
    actions = `<button class="icon-btn" data-act="plugin-search" aria-label="查找插件">${icon("search")}</button>`;
  } else if (ui.view === "tasks") {
    title = "任务";
    kicker = "";
    actions = `<button class="icon-btn" data-act="new-automation" aria-label="新建定时任务">${icon("plus")}</button>`;
  } else if (ui.view === "settings") {
    const cat = ui.settingsCat ? SETTINGS_CAT_MAP[ui.settingsCat] : null;
    title = cat ? cat.title : "设置";
    kicker = cat ? "设置" : "";
    actions = "";
  }

  els.appbar.innerHTML = `
    ${
      ui.view === "chat"
        ? `<button class="icon-btn" data-act="open-drawer" aria-label="会话列表">
             ${icon("menu")}${state.runs.some((r) => r.status === "running") ? '<span class="badge-dot"></span>' : ""}
           </button>`
        : `<button class="icon-btn" data-act="${
             ui.view === "settings" ? (ui.settingsCat ? "settings-home" : "back") : "open-drawer"
           }" aria-label="${ui.view === "settings" ? "返回" : "会话列表"}">
             ${ui.view === "settings" ? icon("arrowLeft") : icon("menu")}
           </button>`
    }
    <div class="appbar__titles">
      <h1 class="appbar__title">${esc(title)}</h1>
      ${kicker ? `<span class="appbar__kicker">${esc(kicker)}</span>` : ""}
    </div>
    <div class="appbar__actions">${actions}</div>`;
}

function renderTabbar() {
  const tabs = [
    { id: "chat", label: "对话", icon: "sparkles" },
    { id: "workspace", label: "工作区", icon: "folder" },
    { id: "plugins", label: "插件", icon: "puzzle" },
    { id: "tasks", label: "任务", icon: "clock" },
  ];
  els.tabbar.innerHTML = tabs
    .map(
      (t) => `
    <button class="tab" role="tab" aria-selected="${ui.view === t.id}" data-act="tab" data-view="${t.id}"
      ${t.id === "tasks" && state.runs.some((r) => r.status === "running") ? 'data-alert="true"' : ""}>
      <span class="tab__icon">${icon(t.icon)}<span class="tab__dot"></span></span>
      <span>${t.label}</span>
    </button>`
    )
    .join("");
  els.tabbar.style.display = ui.view === "settings" ? "none" : "";
}

function renderMain(force = false) {
  const views = {
    chat: $("#view-chat"),
    workspace: $("#view-workspace"),
    plugins: $("#view-plugins"),
    tasks: $("#view-tasks"),
    settings: $("#view-settings"),
  };

  Object.entries(views).forEach(([id, el]) => {
    el.dataset.active = String(id === ui.view);
  });

  const target = views[ui.view];
  if (!target) return;

  // 打开会话 / 重建对话页：一律停在最新消息（底部）
  if (ui.view === "chat") {
    const sid = state.activeSessionId || "none";
    if (force || ui.lastBuilt !== sid) {
      renderChat(target, "bottom");
      ui.lastBuilt = sid;
    } else {
      updateMessages();
    }
    return;
  }

  if (ui.view === "workspace") target.innerHTML = renderWorkspace(ui.workspaceTab);
  if (ui.view === "plugins") target.innerHTML = renderPlugins();
  if (ui.view === "tasks") target.innerHTML = renderTasks();
  if (ui.view === "settings") {
    // 设置页内点任何控件都会重渲染，这里保住滚动位置，不再跳回顶部。
    // ui.settingsScroll === null 只在重新进入设置页的第一帧生效，之后始终跟随 DOM。
    const scroller = target.querySelector(".settings.scroll");
    const top = ui.settingsScroll === null ? 0 : scroller?.scrollTop || 0;
    target.innerHTML = renderSettings(ui.settingsCat);
    const fresh = target.querySelector(".settings.scroll");
    if (fresh) fresh.scrollTop = top;
    ui.settingsScroll = undefined;
  }
}

function navigate(view) {
  ui.view = view;
  if (view === "settings") {
    ui.settingsScroll = null; // 重新进入设置页从顶部开始
    ui.settingsCat = null; // 并回到大类列表
  }
  if (ui.drawer) closeDrawer();
  ui.drawer = false;
  els.drawer.dataset.open = "false";
  els.scrim.dataset.open = "false";
  renderAppbar();
  renderTabbar();
  renderMain(true);
  document.querySelectorAll(".view[data-active='true'] .reveal").forEach((el, i) => {
    el.style.animationDelay = `${i * 70}ms`;
    el.classList.add("is-in");
  });
  els.views.scrollTop = 0;
}

/* ---------------- 对话界面 ---------------- */

function renderChat(root, anchor = "bottom") {
  // 重建对话页之前，先把输入框里的未发送草稿收回来，避免输入到一半的字被重置
  const prevInput = root.querySelector("#composer-input") || document.getElementById("composer-input");
  if (prevInput && typeof prevInput.value === "string" && !ui.run) {
    ui.draft = prevInput.value;
  }
  const s = activeSession();
  root.innerHTML = `
    <div class="chat">
      ${renderContextBar(s)}
      <div id="conn-banner-slot">${renderConnectionBanner()}</div>
      <div class="chat__scroll scroll" id="chat-scroll">
        ${
          s && s.messages.length
            ? `<div class="messages" id="messages"></div>`
            : `<div class="messages messages--empty" id="messages">${renderHome()}</div>`
        }
        <button class="scroll-anchor" id="scroll-anchor" data-act="scroll-bottom" aria-label="回到底部">${icon("arrowDown", "icon--sm")}</button>
      </div>
      ${renderComposer(s)}
    </div>`;

  ui.msgNodes = new Map(); // DOM 是全新的，旧的节点引用作废
  releaseThumbs($("#messages")); // 释放上一屏的图片内存
  ui.renderFrom = Math.max(0, (s?.messages.length || 0) - RENDER_WINDOW);

  const scroller = $("#chat-scroll");
  scroller.addEventListener("scroll", () => {
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    ui.pinned = distance < 48;
    $("#scroll-anchor").dataset.show = String(!ui.pinned);
  });
  if (s && s.messages.length) {
    if (anchor === "bottom") {
      scroller.scrollTop = scroller.scrollHeight;
      ui.pinned = true;
      // 字体 / 富文本排版落定后再贴一次底，避免高度变化把视图顶回去
      requestAnimationFrame(() => {
        if (ui.pinned) scroller.scrollTop = scroller.scrollHeight;
      });
    } else {
      // 锚到最后一条用户消息（历史行为，当前默认不再使用）
      const users = root.querySelectorAll(".msg--user");
      const lastUser = users[users.length - 1];
      scroller.scrollTop = lastUser ? Math.max(0, lastUser.offsetTop - 6) : scroller.scrollHeight;
      ui.pinned = false;
    }
  } else {
    scroller.scrollTop = 0;
  }

  updateMessages();
  restoreDraft();
  lastSendKind = ""; // DOM 是新的，强制刷新一次发送键状态
  updateSendState();
}

function applyDisplaySettings() {
  document.documentElement.style.setProperty("--msg-scale", String(state.settings.fontScale || 1));
  document.documentElement.dataset.density = state.settings.density || "comfortable";
}

function haptic(pattern = 8) {
  if (!state.settings.haptics) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* 设备不支持 */
  }
}

function notifyDone(session) {
  haptic([12, 36, 12]);
  const title = "DSH · 任务完成";
  const body = session?.title || "会话已跑完";
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification(title, { body, icon: "./icons/icon-192.png", tag: session?.id || "dsh" });
      return;
    } catch {
      /* 回退到应用内提示 */
    }
  }
  toast(`任务完成：${body}`, "ok");
}

async function testNotification() {
  if (!("Notification" in window)) {
    haptic([8, 30, 8]);
    toast("系统通知不可用，将使用应用内提醒", "ok");
    return;
  }
  let permission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch {
      permission = "denied";
    }
  }
  if (permission === "granted") {
    try {
      new Notification("DSH 提醒测试", { body: "通知通道正常。", icon: "./icons/icon-192.png" });
      toast("已发送测试通知", "ok");
      return;
    } catch {
      /* 回退 */
    }
  }
  haptic([8, 30, 8]);
  toast("通知权限未授予，将使用应用内提醒", "ok");
}

function diagnosticsSheet() {
  const list = state.diagnostics?.requests || [];
  return sheetFrame({
    title: "请求日志",
    desc: `最近 ${list.length} 次真实请求；只存在本机，不含 Key 与会话正文。`,
    body: list.length
      ? list
          .map(
            (e) => `
        <div class="diag-row">
          <div class="diag-row__top">
            <span class="tag ${e.ok ? "tag--on" : ""}">${e.status || "FAIL"}</span>
            <b>${esc(e.model || "—")}</b>
            <span class="mono">${fmtClock(e.ms || 0)}</span>
          </div>
          <div class="diag-row__sub">${esc(hostOf(e.endpoint))} · ${fmtRelative(e.ts)} · ${e.tokens || 0} tok</div>
          ${e.error ? `<p class="diag-row__err">${esc(e.error)}</p>` : ""}
        </div>`
          )
          .join("")
      : `<div class="empty-line"><b>还没有请求记录</b>配置 Key 后发起一次真实模型请求，这里会记录端点、模型、状态、耗时与 token。<br>未连接模型时不会产生请求。</div>`,
    foot: `<button class="btn btn--ghost" data-act="copy-diagnostics" style="flex:1">复制 JSON</button>
           <button class="btn btn--danger" data-act="clear-diagnostics" style="flex:1">清空</button>`,
  });
}

function modelConnection(id) {
  const model = allModels().find((m) => m.id === id) || currentModel();
  if (!model) {
    return {
      key: "nokey",
      tone: "warn",
      label: "未添加模型",
      detail: "先到「模型管理」添加一个模型（选好供应方，填 Key 就能连上）。",
    };
  }
  if (!hasKeyFor(model)) {
    return {
      key: "nokey",
      tone: "warn",
      label: "未配置 Key",
      detail: "还没有填 API Key，无法对话。到「设置 → 账号 → 对应服务」填好后再发送。",
    };
  }
  const st = modelStatusOf(id);
  if (!st) {
    return { key: "unknown", tone: "muted", label: "未验证", detail: "Key 已填写，建议先测试连接。" };
  }
  if (st.ok) {
    return {
      key: "ok",
      tone: "ok",
      label: `已连接${st.ms ? ` · ${fmtClock(st.ms)}` : ""}`,
      detail: `最近一次请求成功：${st.model || model.apiModel} → ${hostOf(st.endpoint || model.baseUrl)}`,
    };
  }
  return {
    key: "fail",
    tone: "err",
    label:
      st.status === 429
        ? "限流 · 稍后再试"
        : st.status === 401 || st.status === 403
        ? "Key 无效"
        : st.status === 402
        ? "余额不足"
        : st.status
        ? `连接失败 · ${st.status}`
        : "连接失败",
    detail: st.error || "请求没有成功，点开查看诊断日志。",
  };
}

function statusPill(id, { compact = false } = {}) {
  const c = modelConnection(id);
  return `<span class="conn-pill conn-pill--${c.tone}" title="${esc(c.detail)}">
    <span class="conn-pill__dot"></span>${compact ? esc(c.label.split(" · ")[0]) : esc(c.label)}
  </span>`;
}

function renderConnectionBanner() {
  const model = currentModel();
  const c = modelConnection(model?.id);
  if (c.key === "ok") return "";
  const actions = model
    ? c.key === "nokey"
      ? `<button class="btn btn--primary btn--sm" data-act="connect-model">${icon("key", "icon--xs")} 连接模型</button>`
      : `<button class="btn btn--ghost btn--sm" data-act="test-current-model">${icon("bolt", "icon--xs")} 测试连接</button>
         <button class="btn btn--ghost btn--sm" data-act="edit-model" data-id="${model.id}">${icon("gear", "icon--xs")} 参数</button>`
    : `<button class="btn btn--primary btn--sm" data-act="new-custom-model">${icon("plus", "icon--xs")} 添加模型</button>
       <button class="btn btn--ghost btn--sm" data-act="open-models">${icon("folder", "icon--xs")} 模型管理</button>`;
  return `
    <div class="conn-banner conn-banner--${c.tone}">
      <span class="conn-banner__icon">${icon(model ? (c.key === "nokey" ? "key" : c.key === "fail" ? "alert" : "info") : "puzzle", "icon--sm")}</span>
      <div class="conn-banner__main">
        <b>${model ? `${esc(model.label)} · ${esc(c.label)}` : esc(c.label)}</b>
        <p>${esc(c.detail)}</p>
      </div>
      <div class="conn-banner__actions">${actions}</div>
    </div>`;
}

/** 只刷新顶部的模式/模型/连接条，不重建消息，避免测试连接后跳动。 */
function refreshChatMeta() {
  if (ui.view !== "chat") return;
  const meta = $("#view-chat .chat__meta");
  if (meta) meta.outerHTML = renderContextBar(activeSession());
  const slot = $("#conn-banner-slot");
  if (slot) slot.innerHTML = renderConnectionBanner();
}

function renderContextBar(s) {
  const mode = currentMode();
  const model = currentModel();
  const conn = modelConnection(model?.id);
  const modelChip = model
    ? `<button class="chip" data-act="open-model" title="${esc(conn.detail)}">
        <span class="chip__dot ${conn.key === "ok" ? "chip__dot--ok" : conn.key === "nokey" || conn.key === "fail" ? "chip__dot--warn" : ""}"></span>
        ${esc(model.label.replace("DeepSeek-", ""))}
        ${
          effortEnabled()
            ? `<span class="chip__effort" style="color:${effortColor(state.settings.reasoning)}">${effortName(state.settings.reasoning)}</span>`
            : ""
        }
      </button>`
    : `<button class="chip" data-act="open-models" title="添加一个模型就能开始真实对话">
        <span class="chip__dot chip__dot--warn"></span>添加模型
      </button>`;
  return `
  <div class="chat__meta">
    <button class="chip chip--accent" data-act="open-mode">
      ${icon("bolt", "icon--xs")} ${esc(mode.name)}模式
    </button>
    ${modelChip}
    <button class="chip chip--status" data-act="${conn.key === "nokey" ? "connect-model" : "test-current-model"}" aria-label="${esc(conn.label)}：${esc(conn.detail)}">
      <span class="chip__dot ${conn.key === "ok" ? "chip__dot--ok" : conn.key === "nokey" ? "chip__dot--warn" : conn.key === "fail" ? "chip__dot--err" : "chip__dot--idle"}"></span>
      ${esc(conn.label)}
    </button>
    ${state.settings.permission === "readonly" ? `<span class="chip"><span class="chip__dot chip__dot--warn"></span>只读</span>` : ""}
  </div>`;
}

function renderComposer(s) {
  const tools = availableToolNames().length;
  const mode = currentMode();
  return `
  <div class="composer-wrap">
    <div class="composer">
      <div class="composer__files" id="composer-files" ${ui.attachments.length ? "" : "hidden"}>${attachmentChips()}</div>
      <textarea class="composer__input" id="composer-input" rows="1" enterkeyhint="send"
        placeholder="${s && s.messages.length ? "接着说要改什么，或 / 调指令" : "描述目标，@ 引用文件，/ 调指令"}"></textarea>
      <div class="composer__foot">
        <div class="composer__tools">
          <button class="icon-btn icon-btn--sm" data-act="attach" aria-label="添加文件">${icon("plus")}</button>
          ${state.plugins.find((p) => p.id === "voice" && p.enabled) ? `<button class="icon-btn icon-btn--sm" data-act="voice" aria-label="语音输入">${icon("mic", "icon--sm")}</button>` : ""}
        </div>
        <button class="send" id="send-btn" data-act="send" aria-label="发送">${icon("arrowUp", "icon--sm")}</button>
      </div>
    </div>
  </div>`;
}

/* ---------------- 聊天附件（要发给模型的文件） ---------------- */

const ATTACH_MAX = 8;

function attachSize(n) {
  const bytes = Number(n) || 0;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function attachmentChips() {
  return ui.attachments
    .map(
      (a, i) => `<span class="attach-chip" title="${esc(a.path)}">
        ${icon("file", "icon--xs")}
        <span class="attach-chip__name" data-act="preview-attachment" data-path="${esc(a.path)}" data-name="${esc(a.name || a.path)}" data-area="${esc(a.area || "workspace")}" title="点击预览">${esc(a.name || a.path)}</span>
        <span class="attach-chip__size">${attachSize(a.size)}</span>
        <button class="attach-chip__x" data-act="remove-attachment" data-index="${i}" aria-label="移除附件">${icon("x", "icon--xs")}</button>
      </span>`
    )
    .join("");
}

function refreshAttachmentStrip() {
  const box = $("#composer-files");
  if (!box) return;
  box.innerHTML = attachmentChips();
  box.hidden = ui.attachments.length === 0;
  updateSendState();
}

function addAttachment(item) {
  if (!item?.path) return false;
  const area = item.area === "library" ? "library" : "workspace";
  if (ui.attachments.some((a) => a.path === item.path && (a.area || "workspace") === area)) {
    toast("这个文件已经在附件里了");
    return false;
  }
  if (ui.attachments.length >= ATTACH_MAX) {
    toast(`一条消息最多带 ${ATTACH_MAX} 个附件`, "err");
    return false;
  }
  ui.attachments.push({ ...item, area });
  refreshAttachmentStrip();
  return true;
}

/* ---------------- 消息增量渲染 ----------------
   流式输出每帧重建整个 #messages 会带来两个问题：
   1) 增长中的正文每帧重跑一遍 Markdown，长回答接近 O(n²)，越写越卡；
   2) 所有工具卡片被重新创建，spinner 与入场动画每次从头播 → 频闪。
   这里按消息 id 复用 DOM，只替换真正变化的那一块。 */

const BODY_FRAME_MS = 70; // 流式中正文最短重排间隔（长文本自动放宽）

/**
 * 一次最多渲染多少条消息。
 * 超过的部分折叠成"展开更早的 N 条消息"，
 * 避免长会话把上千个 DOM 节点（含缩略图与工具卡片）全塞进 WebView 内存。
 */
const RENDER_WINDOW = 60;

function attachmentChipHtml(a) {
  const name = a.name || a.path;
  const size = attachSize(a.size);
  const area = a.area === "library" ? "library" : "workspace";
  // 注意：气泡是 white-space: pre-wrap，模板里的换行会被当成可见空行撑高卡片，必须写成一行
  if (isImagePath(a.path)) {
    return `<button class="msg__thumb" data-act="preview-attachment" data-path="${esc(a.path)}" data-name="${esc(name)}" data-area="${area}" aria-label="查看图片 ${esc(name)}"><img data-thumb="${esc(a.path)}" data-area="${area}" alt="${esc(name)}" loading="lazy"><span class="msg__thumb-bar"><span class="msg__file-name">${esc(name)}</span><span class="msg__file-size">${size}</span></span></button>`;
  }
  return `<button class="msg__file" data-act="preview-attachment" data-path="${esc(a.path)}" data-name="${esc(name)}" data-area="${area}" aria-label="查看文件 ${esc(name)}">${icon("file", "icon--xs")}<span class="msg__file-name">${esc(name)}</span><span class="msg__file-size">${size}</span></button>`;
}

function userMsgHtml(m) {
  const files = m.attachments || [];
  return `<div class="msg msg--user" data-msg="${m.id}"><div class="msg__bubble">${esc(m.content)}${
    files.length ? `<div class="msg__files">${files.map(attachmentChipHtml).join("")}</div>` : ""
  }</div></div>`;
}

/**
 * 缩略图懒加载。
 *
 * 之前直接用原图 base64 当 src，一张手机截图就有 2–4 MB 常驻在 DOM 里；
 * 加上长会话的全量消息节点，WebView 渲染进程很容易被系统 OOM 杀掉
 * （表现为"执行任务时应用突然退到桌面"）。
 *
 * 现在改为：
 *   1) 压到长边 320px 的 JPEG 再放进 <img>，内存降一到两个数量级；
 *   2) 用 IntersectionObserver 只在滚进视口时才加载；
 *   3) 换会话 / 重渲染时主动释放旧图，避免历史图无限累积。
 */
const thumbObserver =
  typeof IntersectionObserver === "function"
    ? new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            const img = e.target;
            thumbObserver.unobserve(img);
            loadThumb(img);
          }
        },
        { rootMargin: "200px" }
      )
    : null;

async function loadThumb(img) {
  const path = img.dataset.thumb;
  if (!path) return;
  const area = img.dataset.area === "library" ? "library" : "workspace";
  try {
    const doc = await readDoc(area, path);
    if (!doc) return;
    const mime = doc.mime || imageMime(path);
    let src = `data:${mime};base64,${doc.content}`;
    // 压小：失败也不影响展示，退回原图
    try {
      const thumb = await prepareThumb(doc.content, mime);
      if (thumb?.dataUrl) src = thumb.dataUrl;
    } catch {
      /* 保留原图 */
    }
    if (img.isConnected) img.src = src;
  } catch {
    img.closest(".msg__thumb")?.classList.add("msg__thumb--missing");
  }
}

function hydrateThumbs(root) {
  if (!root) return;
  for (const img of root.querySelectorAll("img[data-thumb]:not([data-loaded])")) {
    img.dataset.loaded = "1";
    if (thumbObserver) thumbObserver.observe(img);
    else loadThumb(img);
  }
}

/** 释放当前气泡里的图片内存（切换会话、滚动离开时调用）。 */
function releaseThumbs(root) {
  if (!root) return;
  for (const img of root.querySelectorAll("img[data-thumb]")) {
    if (img.src && img.src.startsWith("data:")) img.removeAttribute("src");
    img.dataset.loaded = "";
  }
}

function assistantShell(m) {
  return `<div class="msg msg--assistant" data-msg="${m.id}">
    <div class="msg__head"></div>
    <div class="msg__extra"></div>
    <div class="reasoning-slot"></div>
    <div class="tools-slot"></div>
    <div class="body-slot"><div class="msg__body"></div><span class="stream-caret" hidden></span></div>
    <div class="tail-slot"></div>
  </div>`;
}

function headHtml(m, running) {
  return `<span class="brandmark brandmark--xs" aria-hidden="true"></span>
    <span class="msg__name">DSH</span>
    <span class="msg__stamp">${fmtTime(m.ts)}</span>
    ${running ? `<span class="msg__stamp mono" style="color:var(--accent-bright);margin-left:auto">STEP ${m.steps || 1}</span>` : ""}
    ${
      m.status === "stopped"
        ? `<span class="tag" style="margin-left:auto">${m.interrupted ? "已被系统中断" : "已停止"}</span>`
        : ""
    }`;
}

function extraHtml(m) {
  return `${
    m.contextTrim
      ? `<div class="msg__notice">${icon("layers", "icon--xs")} 较早的 ${m.contextTrim.removed} 轮已省略 · 窗口 ${fmtContext(m.contextTrim.window)}</div>`
      : ""
  }${
    m.media?.images
      ? `<div class="msg__notice">${icon("file", "icon--xs")} ${
          m.media.sent
            ? `已随本条发送 ${m.media.sent} 张图片${
                m.media.items?.[0]?.width
                  ? `（${m.media.items.map((i) => `${i.width}×${i.height}`).join("、")}，已压缩）`
                  : ""
              }`
            : "图片没有发送：当前模型未开启「图片输入」"
        }</div>`
      : ""
  }`;
}

/* 思考区采用「外壳一次建好 + 之后只增量改文本」的渲染方式。
   早先的做法是把整段思考过程拼成 HTML 塞进 innerHTML，
   深度思考流式输出时每个 delta 都会重建整棵子树，
   展开状态下的 .reasoning__text 因此反复销毁重建，
   它的 fadeIn 动画也跟着不停重播 —— 表现就是「展开思考过程时频闪」。
   这里把外壳与内容彻底分开：外壳只在首次出现时创建，
   之后只改 data-open、标题文字和 .reasoning__text 的文本节点。 */

/** 思考区标题：运行中显示「正在思考…」，结束后显示实际思考耗时。 */
function reasoningLabel(m, running) {
  if (running) return "正在思考…";
  if (m.reasoningMs) return `已思考 ${fmtClock(m.reasoningMs)}`;
  return "思考过程";
}

/** 思考区外壳。内容留空，由 patchReasoning 增量填。 */
function reasoningShell(m, open) {
  return `<div class="reasoning" data-open="${open ? "true" : "false"}">
    <button class="reasoning__toggle" data-act="toggle-reason" data-id="${m.id}">
      ${icon("chevron", "icon--xs reasoning__chev")}
      <span class="reasoning__label"></span>
    </button>
    <div class="reasoning__text"></div>
  </div>`;
}

/* 增量更新思考区。
   关键约束：外壳 .reasoning 一旦建好就不能被替换。
   只要 .reasoning__text 这个节点还在，展开状态下的 fadeIn 动画就不会重播；
   反之若整棵子树被重建，动画会随新节点一起从头播放，
   深度思考流式输出时每个 delta 重建一次 —— 视觉上就是持续频闪。 */
function patchReasoning(el, m, running, open) {
  const slot = el.querySelector(":scope > .reasoning-slot");
  if (!slot) return;

  const show = !!(m.reasoning && (state.settings.showReasoning || running));
  let box = slot.querySelector(":scope > .reasoning");
  if (!show) {
    // 不该显示时整块移除，避免残留空壳占位
    if (box) {
      box.remove();
    }
    return;
  }

  if (!box) {
    slot.innerHTML = reasoningShell(m, open);
    box = slot.firstElementChild;
  }

  // 展开态：只在真正变化时改属性。改属性才会重播淡入动画，属于用户主动操作
  const openStr = open ? "true" : "false";
  if (box.dataset.open !== openStr) box.dataset.open = openStr;

  // 标题
  const label = box.querySelector(".reasoning__label");
  const want = reasoningLabel(m, running);
  if (label.textContent !== want) label.textContent = want;

  // 正文：只往末尾追加增量，不整段替换。
  // 整段替换会让浏览器重新排版整块文字，展开状态下肉眼能看出抖动。
  const textEl = box.querySelector(".reasoning__text");
  let node = textEl._reasonNode;
  if (!node || node.parentNode !== textEl) {
    textEl.textContent = "";
    node = document.createTextNode("");
    textEl.appendChild(node);
    textEl._reasonNode = node;
  }
  const shown = node.nodeValue || "";
  const full = String(m.reasoning || "");
  if (full.length > shown.length && full.startsWith(shown)) {
    node.appendData(full.slice(shown.length));
  } else if (full !== shown) {
    node.nodeValue = full;
  }
}

function bodyHtml(m, running) {
  if (m.content) return renderMarkdown(m.content);
  if (running) return `${icon("loader", "icon--sm icon--loader")} 正在准备…`;
  return "";
}

function tailHtml(m, done, tools) {
  // 被系统中断：不当作错误处理，也不出"测试连接"这类误导按钮，
  // 只说明发生了什么，并给一个"继续"入口。
  if (m.interrupted) {
    const note = `<div class="msg__notice">${icon("alert", "icon--xs")} ${esc(m.error || "本次运行被系统中断。")}</div>`;
    return `${note}${
      done && (m.duration || tools.length)
        ? `<button class="runmeta" data-act="trace" data-id="${m.id}" style="background:none;border:0;width:100%;text-align:left;cursor:pointer">
             <span class="runmeta__item">${icon("clock", "icon--xs")}<b>${fmtClock(m.duration)}</b></span>
             <span class="runmeta__item"><b>${tools.length}</b> 次工具</span>
             <span class="runmeta__item"><b>${fmtTokens(m.tokens)}</b> tok</span>
             <span class="runmeta__item" style="color:var(--accent-bright)">轨迹 ${icon("chevron", "icon--xs")}</span>
           </button>`
        : ""
    }`;
  }

  const err = m.error
    ? `<div class="msg__error">${icon("alert", "icon--sm")}<span>${esc(m.error)}</span></div>
       <div class="msg__error-actions">
         <button class="btn btn--ghost btn--sm" data-act="test-current-model">${icon("bolt", "icon--xs")} 测试连接</button>
         ${
           currentModel()
             ? `<button class="btn btn--ghost btn--sm" data-act="edit-model" data-id="${currentModel().id}">${icon("gear", "icon--xs")} 模型参数</button>`
             : `<button class="btn btn--ghost btn--sm" data-act="new-custom-model">${icon("plus", "icon--xs")} 添加模型</button>`
         }
       </div>`
    : "";
  const meta =
    done && (m.duration || tools.length)
      ? `<button class="runmeta" data-act="trace" data-id="${m.id}" style="background:none;border:0;width:100%;text-align:left;cursor:pointer">
           <span class="runmeta__item">${icon("clock", "icon--xs")}<b>${fmtClock(m.duration)}</b></span>
           <span class="runmeta__item"><b>${tools.length}</b> 次工具</span>
           <span class="runmeta__item"><b>${fmtTokens(m.tokens)}</b> tok</span>
           <span class="runmeta__item" style="color:var(--accent-bright)">轨迹 ${icon("chevron", "icon--xs")}</span>
         </button>`
      : "";
  return err + meta;
}

/** 工具卡片只在状态/输出长度等真正变化时重建，避免 spinner 反复从头转。 */
function toolSig(t) {
  return [
    t.status,
    t.ms || 0,
    (t.output || "").length,
    t.diff?.length || 0,
    t.export?.path || "",
    t.safety?.warn ? 1 : 0,
  ].join("|");
}

function patchTools(box, tools) {
  if (!box) return;
  let list = box.querySelector(":scope > .tools");
  if (!tools.length) {
    if (list) list.remove();
    return;
  }
  if (!list) {
    list = document.createElement("div");
    list.className = "tools";
    box.appendChild(list);
  }
  const existing = new Map([...list.children].map((c) => [c.dataset.toolId, c]));
  const alive = new Set();
  tools.forEach((t, idx) => {
    alive.add(t.id);
    const sig = toolSig(t);
    let card = existing.get(t.id);
    if (!card) {
      const tmp = document.createElement("div");
      tmp.innerHTML = renderTool(t);
      card = tmp.firstElementChild;
      card.dataset.toolId = t.id;
      card.dataset.sig = sig;
      existing.set(t.id, card);
    } else if (card.dataset.sig !== sig) {
      const tmp = document.createElement("div");
      tmp.innerHTML = renderTool(t);
      const fresh = tmp.firstElementChild;
      fresh.dataset.toolId = t.id;
      fresh.dataset.sig = sig;
      card.replaceWith(fresh);
      existing.set(t.id, fresh);
      card = fresh;
    } else {
      // 内容没变：只同步展开状态，别重建
      const openNow = String(ui.toolOpen.has(t.id));
      if (card.dataset.open !== openNow) card.dataset.open = openNow;
    }
    if (list.children[idx] !== card) list.insertBefore(card, list.children[idx] || null);
  });
  [...list.children].forEach((c) => {
    if (!alive.has(c.dataset.toolId)) c.remove();
  });
}

function patchAssistant(el, m) {
  const running = m.status === "running";
  const open = ui.reasoningOpen.has(m.id);

  // 便宜的整体签名：状态、正文/推理长度、工具状态、展开态。
  // 完全没变就不往下走，避免每帧为一屋子消息拼 HTML。
  const quick = [
    m.status,
    m.content.length,
    m.reasoning.length,
    (m.tools || [])
      .map((t) => `${t.id}:${t.status}:${(t.output || "").length}:${t.ms || 0}:${ui.toolOpen.has(t.id) ? 1 : 0}`)
      .join(","),
    m.contextTrim?.removed || 0,
    m.media?.sent || 0,
    m.media?.images || 0,
    open ? 1 : 0,
  ].join("|");
  if (el.dataset.quick === quick) return;

  const head = headHtml(m, running);
  if (el.dataset.sigHead !== head) {
    el.querySelector(":scope > .msg__head").innerHTML = head;
    el.dataset.sigHead = head;
  }

  const extra = extraHtml(m);
  if (el.dataset.sigExtra !== extra) {
    el.querySelector(":scope > .msg__extra").innerHTML = extra;
    el.dataset.sigExtra = extra;
  }

  patchReasoning(el, m, running, open);
  patchTools(el.querySelector(":scope > .tools-slot"), m.tools || []);

  // 正文是流式里变化最频繁的部分：按时间片节流，避免每个 token 都重排 Markdown
  const bodySig = `${m.content.length}|${running}|${m.status}`;
  if (el.dataset.sigBody !== bodySig) {
    const now = performance.now();
    const last = Number(el.dataset.bodyAt || 0);
    // 文本越长，Markdown 重排越贵：间隔跟着放宽，短消息保持跟手
    const gap = m.content.length > 6000 ? 180 : m.content.length > 2000 ? 110 : BODY_FRAME_MS;
    if (running && now - last < gap) {
      if (!el._bodyTimer) {
        el._bodyTimer = setTimeout(() => {
          el._bodyTimer = null;
          if (el.isConnected) updateMessages();
        }, gap);
      }
    } else {
      el.dataset.bodyAt = String(now);
      const bodyBox = el.querySelector(":scope > .body-slot");
      const bodyEl = bodyBox.querySelector(".msg__body");
      const caret = bodyBox.querySelector(".stream-caret");
      bodyEl.className = `msg__body${m.content ? " md" : " dim"}`;
      bodyEl.style.fontSize = m.content ? "" : "12px";
      bodyEl.innerHTML = bodyHtml(m, running);
      // 光标常驻 DOM，只切显隐：流式时不会每帧重播 blink 动画
      if (caret) caret.hidden = !(running && m.content);
      el.dataset.sigBody = bodySig;
    }
  }

  const tail = tailHtml(m, !running && m.status, m.tools || []);
  if (el.dataset.sigTail !== tail) {
    el.querySelector(":scope > .tail-slot").innerHTML = tail;
    el.dataset.sigTail = tail;
  }

  // 正文真正落地后才认这份 quick；否则保持旧值，等节流定时器补一次
  if (el.dataset.sigBody === bodySig) el.dataset.quick = quick;
}

function updateMessages() {
  const s = activeSession();
  const box = $("#messages");
  if (!s || !box) return;

  if (!s.messages.length) {
    // 空会话：渲染首页空态。
    // 注意容器必须是 .messages（带 padding/gap 的消息布局），
    // 否则一旦有消息进来，容器的布局规则会与首页空态对不上。
    box.className = "messages messages--empty";
    box.innerHTML = renderHome();
    ui.msgNodes = new Map();
    return;
  }

  // 有消息了：把首页空态整块移除。
  // 之前只是往容器里"追加"消息节点，首页空态（.home）会残留在消息列表下方，
  // 表现为"发完一句话底下空出整整一屏，底部不是最新消息"。
  if (box.classList.contains("messages--empty")) {
    box.className = "messages";
    box.innerHTML = "";
    ui.msgNodes = new Map();
  }

  const nearBottom = ui.pinned;
  const prevScroll = $("#chat-scroll")?.scrollTop || 0;

  // 日期头只建一次
  const dateText = `${new Date(s.createdAt).toLocaleDateString("zh-CN")} · ${MODES[s.mode]?.name || "标准"}模式`;
  let head = box.querySelector(":scope > .chat__date");
  if (!head) {
    head = document.createElement("div");
    head.className = "chat__date";
    head.textContent = dateText;
    box.insertBefore(head, box.firstChild);
  } else if (head.textContent !== dateText) {
    head.textContent = dateText;
  }

  const nodes = (ui.msgNodes ||= new Map());
  const seen = new Set();
  let prev = head;

  // 渲染窗口：只渲染最近 RENDER_WINDOW 条消息。
  // 长会话把上百条消息（含工具卡片、Markdown、缩略图）全塞进 DOM，
  // 是渲染进程内存爆炸的另一半原因。这里默认只渲染尾部，
  // 更早的内容折叠成一行提示，需要时点开。
  const total = s.messages.length;
  // renderFrom 是用户手动展开到的位置；没有手动展开时只留尾部窗口。
  // 注意要允许 renderFrom 继续往前扩（load-earlier），所以这里不能用 total-RENDER_WINDOW 钳制。
  const from = Math.max(0, Math.min(ui.renderFrom ?? total - RENDER_WINDOW, total - 1));
  const hidden = from;

  if (hidden > 0) {
    let more = box.querySelector(":scope > .chat__more");
    if (!more) {
      more = document.createElement("button");
      more.className = "chat__more";
      more.dataset.act = "load-earlier";
      head.insertAdjacentElement("afterend", more);
    }
    more.textContent = `展开更早的 ${hidden} 条消息`;
    more.hidden = false;
    prev = more;
  } else {
    box.querySelector(":scope > .chat__more")?.remove();
  }

  for (const m of s.messages.slice(from)) {
    seen.add(m.id);
    let el = nodes.get(m.id);
    if (!el || el.parentNode !== box) {
      const tmp = document.createElement("div");
      tmp.innerHTML = m.role === "user" ? userMsgHtml(m) : assistantShell(m);
      el = tmp.firstElementChild;
      nodes.set(m.id, el);
      el.dataset.sigBody = ""; // 新节点需要立即填充
    }
    if (prev.nextElementSibling !== el) box.insertBefore(el, prev.nextElementSibling);
    prev = el;

    if (m.role === "user") {
      const sig = `${m.content.length}|${(m.attachments || []).length}`;
      if (el.dataset.sigUser !== sig) {
        el.outerHTML = userMsgHtml(m);
        el = box.querySelector(`[data-msg="${m.id}"]`);
        nodes.set(m.id, el);
        el.dataset.sigUser = sig;
      }
    } else {
      patchAssistant(el, m);
    }
  }

  // 清掉已不存在的消息节点
  for (const [id, el] of [...nodes]) {
    if (!seen.has(id)) {
      el.remove();
      nodes.delete(id);
    }
  }

  hydrateThumbs(box);

  const scroller = $("#chat-scroll");
  if (scroller && nearBottom) scroller.scrollTop = scroller.scrollHeight;
  else if (scroller) scroller.scrollTop = prevScroll;
}

let rafPending = false;
function scheduleMessages() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    updateMessages();
  });
}

function renderTool(t) {
  const open = ui.toolOpen.has(t.id);
  const map = {
    running: { tag: "运行中", cls: "tool__tag--warn", ic: "loader", spin: true },
    waiting: { tag: "待批准", cls: "tool__tag--warn", ic: "shield", spin: false },
    done: { tag: "完成", cls: "tool__tag--ok", ic: "check", spin: false },
    error: { tag: "失败", cls: "tool__tag--err", ic: "alert", spin: false },
    denied: { tag: "已拒绝", cls: "tool__tag--err", ic: "x", spin: false },
    blocked: { tag: "已拦截", cls: "tool__tag--err", ic: "shield", spin: false },
  };
  const st = map[t.status] || map.running;

  const argsText = (() => {
    if (t.name === "fs_write" || t.name === "fs_read") return t.args?.path || t.argLabel;
    if (t.name === "run_code") return "编排脚本";
    return t.argLabel || "";
  })();

  return `
  <div class="tool" data-status="${t.status}" data-open="${open}">
    <button class="tool__head" data-act="toggle-tool" data-id="${t.id}">
      <span class="tool__state ${st.spin ? "tool__state--spin" : ""}" style="color:${t.status === "done" ? "var(--ok)" : t.status === "running" || t.status === "waiting" ? "var(--warn)" : "var(--danger)"}">
        ${icon(st.ic, "icon--xs")}
      </span>
      <span class="tool__name">${esc(t.name)}</span>
      <span class="tool__arg">${esc(argsText)}</span>
      ${t.status === "done" ? `<span class="tag">${t.ms ? fmtClock(t.ms) : ""}</span>` : `<span class="tool__tag ${st.cls}">${st.tag}</span>`}
      ${icon("chevron", "icon--xs tool__chev")}
    </button>
    <div class="tool__body">
      ${t.args && Object.keys(t.args).length ? `<p class="tool__label">调用参数</p><pre class="tool__code">${esc(JSON.stringify(t.args, null, 2).slice(0, 1600))}</pre>` : ""}
      ${t.code ? `<p class="tool__label">编排脚本</p><pre class="tool__code">${esc(t.code)}</pre>` : ""}
      ${t.status === "waiting" ? `<div class="tool__statusline">${icon("shield", "icon--xs")} 等待你在下方审批</div>` : ""}
      ${t.safety?.warn ? `<div class="tool__notice tool__notice--warn">${icon("shield", "icon--xs")} CC Safety Net 提醒：${esc(t.safety.secrets.join("、"))}</div>` : ""}
      ${t.output ? `<p class="tool__label">输出</p><pre class="tool__code">${esc(t.output)}</pre>` : ""}
      ${t.export ? `<button class="btn btn--sm btn--soft" style="margin-top:10px" data-act="download-file" data-path="${esc(t.export.path)}">${icon("download", "icon--xs")} 下载 ${esc(t.export.path.split("/").pop())}</button>` : ""}
      ${
        t.diff && t.diff.length
          ? `<p class="tool__label">文件差异</p><div class="diff">${t.diff
              .map((d) => `<span class="diff__line diff__line--${d.t}">${esc(d.s)}</span>`)
              .join("")}</div>`
          : ""
      }
    </div>
  </div>`;
}

/** 输入框的真实值：永远以 DOM 为准，ui.draft 只是镜像缓存。 */
function composerValue() {
  const el = $("#composer-input");
  return typeof el?.value === "string" ? el.value : ui.draft || "";
}

function setComposerValue(value) {
  ui.draft = value;
  const el = $("#composer-input");
  if (el) {
    el.value = value;
    autoGrow();
  }
  updateSendState();
}

function restoreDraft() {
  const input = $("#composer-input");
  if (!input) return;
  input.value = ui.draft;
  autoGrow();
}

/* autoGrow 用 rAF 合并：连续按键只做一次高度计算；
   组合输入（拼音/语音候选）期间完全不改动输入框，避免打断输入法 */
let growPending = false;
function autoGrow() {
  if (growPending) return;
  growPending = true;
  requestAnimationFrame(() => {
    growPending = false;
    const input = $("#composer-input");
    if (!input || ui.composing) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
  });
}

let lastSendKind = "";

/**
 * 是否有"孤儿运行"：状态里标记为 running，但内存里已经没有对应的执行器。
 *
 * 判据必须是"消息状态是 running **且** 当前没有执行器"，
 * 只看消息状态会把正在正常跑的任务误判成孤儿——
 * 切后台时流式渲染被节流，用户看不到进度，以为死了；
 * 回到前台又把它当孤儿收尾，任务就真的停了。
 */
function orphanRunning() {
  if (ui.run) return null; // 执行器还在，任务活着
  const s = activeSession();
  if (!s) return null;
  const m = [...(s.messages || [])].reverse().find((x) => x.status === "running");
  return m || null;
}

function updateSendState() {
  const btn = $("#send-btn");
  if (!btn) return;
  // 以输入框实时内容判断，避免镜像缓存与 DOM 脱节导致按钮永远禁用
  const orphan = orphanRunning();
  const kind = ui.run || orphan ? "stop" : composerValue().trim() || ui.attachments.length ? "send" : "off";
  if (kind === lastSendKind) return; // 每次按键不重建按钮 DOM
  lastSendKind = kind;
  if (kind === "stop") {
    btn.dataset.stop = "true";
    btn.innerHTML = icon("stop", "icon--sm");
    btn.setAttribute("aria-label", "停止运行");
    btn.disabled = false;
    return;
  }
  btn.dataset.stop = "false";
  btn.innerHTML = icon("arrowUp", "icon--sm");
  btn.setAttribute("aria-label", "发送");
  btn.disabled = kind === "off";
}
let sendStatePending = false;
function scheduleSendState() {
  if (sendStatePending) return;
  sendStatePending = true;
  requestAnimationFrame(() => {
    sendStatePending = false;
    updateSendState();
  });
}

/* ---------------- 发送与运行 ---------------- */

async function sendMessage(text) {
  const raw = String(text || "").trim();
  const attachments = ui.attachments.slice();
  if ((!raw && !attachments.length) || ui.run) return;
  // 孤儿运行（上次进程被回收，状态还停在 running）：先自动收尾再发
  if (orphanRunning()) {
    stopRunAction();
  }
  const content = raw || "请看这些附件。";

  // 图片不会被发送时先提醒，避免"以为发了、模型其实没看到"
  if (attachments.some((a) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(a.path))) {
    const active = currentModel();
    const vision = active ? active.vision !== false : false;
    if (!vision) toast("当前模型未开启「图片输入」，图片不会发送", "err");
  }

  let s = activeSession();
  if (!s) {
    s = createSession({ mode: state.settings.mode });
    ui.lastBuilt = null;
  }

  haptic(6);
  const userMsg = {
    id: `u_${Date.now()}`,
    role: "user",
    content,
    ts: Date.now(),
    ...(attachments.length ? { attachments } : {}),
  };
  addMessage(s.id, userMsg);
  const msg = {
    id: `a_${Date.now()}`,
    role: "assistant",
    status: "running",
    ts: Date.now(),
    content: "",
    reasoning: "",
    tools: [],
    steps: 0,
    tokens: 0,
  };
  addMessage(s.id, msg);

  setComposerValue("");
  ui.attachments = [];
  refreshAttachmentStrip();
  ui.pinned = true;
  // 增量插入只在"已经有消息的会话"里安全：
  // 空会话的容器里还躺着首页空态（.home），往上追加消息会让首页残留在下方，
  // 表现为"发完一句底下空出整整一屏"。所以空会话一律整页重建。
  const box = $("#messages");
  const wasEmpty = !box || !!box.querySelector(".home");
  if (ui.lastBuilt === s.id && box && !wasEmpty) {
    // 已有会话：只把两条新消息插进去，别把整段历史重建一遍
    // 新消息进来后，渲染窗口回到"最近 N 条"，避免展开态把新内容挤出窗口
    ui.renderFrom = Math.max(0, s.messages.length - RENDER_WINDOW);
    updateMessages();
    const sc = $("#chat-scroll");
    if (sc) sc.scrollTop = sc.scrollHeight;
  } else {
    renderChat($("#view-chat"), "bottom");
  }
  ui.lastBuilt = s.id;
  renderAppbar();

  const controller = new AbortController();
  ui.run = { controller, sessionId: s.id, msgId: msg.id };
  updateSendState();
  hudSync();
  hudCue("start"); // 小球跳一下，表示开工
  // 任务期间拉起前台服务：用户切到别的应用时系统不会随手回收我们的进程，
  // 正在跑的这次运行不会"莫名其妙断在半路"
  keepAliveStart();

  try {
    await runAgent({
      session: s,
      text: content,
      msg,
      attachments,
      signal: controller.signal,
      onChange: () => {
        if (state.activeSessionId === ui.run?.sessionId) scheduleMessages();
        hudSync();
        // 流式期间持续落盘（内部有 1.2s 节流）：
        // 之前只在运行结束时才写盘，进程被系统杀掉时整段输出全丢，
        // 重开后只剩一个空壳消息，这就是"记录坏死"的一部分。
        saveSessionNow(s.id);
      },
      requestApproval,
      spawnSubagent: (task) => spawnSubagentOnce(task, controller.signal),
    });
  } catch (err) {
    msg.status = "error";
    msg.error = err.message || "运行失败";
  } finally {
    ui.run = null;
    updateSendState();
    keepAliveStop();
    saveSessionNow(s.id);
    save(true);
    if (msg.status === "done" && !msg.error) {
      state.stats.runs += 1;
      state.stats.tools += msg.tools.length;
      state.stats.tokens += msg.tokens || 0;
      save(true);
      // 完成：小球笑眼 + 双鳍三连扇，保持片刻
      ui.hudDoneUntil = Date.now() + 2600;
    } else if (msg.status === "error") {
      // 失败：限流是叹息（⧗），其余是摇头 + 打叉；徽标保持 6s
      const limited = HUD_LIMIT_RE.test(msg.error || "");
      ui.hudBadge = { kind: limited ? "limited" : "failed", until: Date.now() + 6000 };
      hudCue(limited ? "limitHit" : "failed");
    }
    save(true);
    updateMessages();
    refreshChatMeta();
    renderAppbar();
    hudSync();
    if (msg.status === "error") toast(msg.error || "运行失败", "err");
    const away = document.visibilityState !== "visible" || ui.view !== "chat" || state.activeSessionId !== s.id;
    if (state.settings.notifyOnDone && away && msg.status === "done") notifyDone(s);
  }
}

function stopRunAction() {
  // 正常情况：内存里有执行器，直接 abort
  if (ui.run) {
    ui.run.controller.abort();
    ui.run = null;
    keepAliveStop();
    updateSendState();
    toast("已停止本次运行");
    setTimeout(() => {
      updateMessages();
      renderAppbar();
    }, 80);
    return;
  }
  // 孤儿运行：执行器随进程一起没了（被系统回收 / 崩溃后重开），
  // 但消息状态还停在 running——此时必须能手动收尾，否则永远转圈、也永远发不出新消息。
  const orphan = orphanRunning();
  if (orphan) {
    orphan.status = "stopped";
    orphan.error = "本次运行已被手动终止（应用之前被系统回收或异常退出）。";
    orphan.interrupted = true;
    for (const t of orphan.tools || []) {
      if (t.status === "running" || t.status === "waiting") t.status = "stopped";
    }
    const s = activeSession();
    if (s) saveSessionNow(s.id);
    save(true);
    lastSendKind = "";
    updateSendState();
    updateMessages();
    renderAppbar();
    toast("已清理中断的运行", "ok");
  }
}

/* ---------------- 审批 ---------------- */

function requestApproval(info) {
  return new Promise((resolve) => {
    ui.approval = { info, resolve };
    openSheet("approval", info, { dismissible: false });
  });
}

function resolveApproval(allow, remember = false) {
  const a = ui.approval;
  ui.approval = null;
  if (remember && allow) setSettings({ approval: "auto" });
  closeSheet(true);
  a?.resolve(allow);
  toast(allow ? (remember ? "已改为自动放行" : "已允许本次操作") : "已拒绝该操作", allow ? "ok" : "err");
}

/* ---------------- 面板 ---------------- */

function openSheet(type, data = {}, opts = {}) {
  ui.sheet = { type, data, dismissible: opts.dismissible !== false };
  renderSheet();
  pushLayer();
}

function closeSheet(force = false, fromHistory = false) {
  if (!ui.sheet) return;
  if (!ui.sheet.dismissible && !force) return;
  const layer = els.sheet;
  layer.dataset.open = "false";
  ui.sheet = null;
  destroySheetControls();
  els.app.dataset.sheet = "false";
  clearTimeout(ui.sheetTimer);
  ui.sheetTimer = setTimeout(() => {
    if (!ui.sheet) layer.innerHTML = "";
  }, 320);
  if (!fromHistory) dropLayer();
}

/* ---------------- 图片查看器 ---------------- */

function closeImageViewer() {
  document.getElementById("img-viewer")?.remove();
  ui.imageViewer = false;
}

function openImageViewer(path, name, area = "workspace") {
  closeImageViewer();
  ui.imageViewer = true;
  const el = document.createElement("div");
  el.className = "img-viewer";
  el.id = "img-viewer";
  el.innerHTML = `
    <div class="img-viewer__bar">
      <span class="img-viewer__name">${esc(name || path.split("/").pop())}</span>
      <button class="icon-btn" data-act="close-image-viewer" aria-label="关闭">${icon("x")}</button>
    </div>
    <div class="img-viewer__stage" id="img-stage">
      <div class="img-viewer__hint">${icon("loader", "icon--sm icon--loader")} 正在读取…</div>
    </div>
    <div class="img-viewer__foot">
      <span class="img-viewer__meta" id="img-meta">${esc(path)}</span>
      <div class="img-viewer__actions">
        <button class="btn btn--ghost btn--sm" data-act="export-file" data-area="${esc(area)}" data-path="${esc(path)}">${icon("download", "icon--xs")} 保存到手机</button>
        <button class="btn btn--ghost btn--sm" data-act="open-file" data-area="${esc(area)}" data-path="${esc(path)}">${icon("file", "icon--xs")} 文件信息</button>
      </div>
    </div>`;
  els.app.appendChild(el);

  const stage = el.querySelector("#img-stage");
  const meta = el.querySelector("#img-meta");

  // 点空白处关闭；点图片本身切换放大
  el.addEventListener("click", (e) => {
    if (e.target === stage) closeImageViewer();
    else if (e.target.classList?.contains("img-viewer__img")) e.target.classList.toggle("is-zoom");
  });

  readDoc(area, path)
    .then((doc) => {
      const img = new Image();
      img.className = "img-viewer__img";
      img.alt = name || path;
      img.onload = () => {
        stage.innerHTML = "";
        stage.appendChild(img);
        meta.textContent = `${img.naturalWidth}×${img.naturalHeight} · ${attachSize(doc.size)}`;
      };
      img.onerror = () => {
        stage.innerHTML = `<div class="img-viewer__hint">这张图片无法显示（可能是 WebView 不支持的格式）</div>`;
      };
      // 预览用压缩版（长边 1568px、约 1.2MB）而不是原始 base64：
      // 原图 4MB 的 data URL 常驻内存，很容易把 WebView 渲染进程顶爆。
      // 用户点"保存到手机"拿到的仍是原图。
      const mime = doc.mime || imageMime(path);
      prepareImage(doc.content, mime)
        .then((t) => {
          img.src = t?.dataUrl || `data:${mime};base64,${doc.content}`;
        })
        .catch(() => {
          img.src = `data:${mime};base64,${doc.content}`;
        });
    })
    .catch(() => {
      stage.innerHTML = `<div class="img-viewer__hint">读取失败：文件可能已被删除</div>`;
    });
}

function sheetFrame({ title, desc = "", body = "", foot = "", dismissible = true }) {
  return `
    <div class="sheet-backdrop" data-act="${dismissible ? "close-sheet" : "noop"}"></div>
    <section class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet__handle" aria-hidden="true"></div>
      <div class="sheet__head">
        <div class="sheet__head-text">
          <h2 class="sheet__title">${title}</h2>
          ${desc ? `<p class="sheet__desc">${desc}</p>` : ""}
        </div>
        ${dismissible ? `<button class="icon-btn icon-btn--sm" data-act="close-sheet" aria-label="关闭">${icon("x", "icon--sm")}</button>` : ""}
      </div>
      <div class="sheet__body">${body}</div>
      ${foot ? `<div class="sheet__foot">${foot}</div>` : ""}
    </section>`;
}

let effortSlider = null;

function destroySheetControls() {
  if (effortSlider) {
    effortSlider.destroy();
    effortSlider = null;
  }
}

function mountSheetControls(type) {
  destroySheetControls();
  if (type === "custom-model") {
    // 打开面板即自动探测端点提供的模型（无 Key / 无端点时静默给出提示）
    setTimeout(() => {
      if (ui.sheet?.type === "custom-model" && $("#cm-base")?.value.trim()) runFormModelFetch();
    }, 350);
    return;
  }
  if (type !== "model") return;
  const host = els.sheet.querySelector("#effort-mount");
  if (!host) return;
  effortSlider = mountEffortSlider(host, {
    index: effortIndex(state.settings.reasoning),
    onChange: (id) => {
      setSettings({ reasoning: id });
      syncEffortChip(id);
    },
  });
}

function renderSheet() {
  if (!ui.sheet) {
    destroySheetControls();
    els.sheet.innerHTML = "";
    els.sheet.dataset.open = "false";
    els.app.dataset.sheet = "false";
    return;
  }
  const { type, data, dismissible } = ui.sheet;
  const builders = {
    approval: approvalSheet,
    mode: modeSheet,
    model: modelSheet,
    "model-list": modelListSheet,
    account: accountSheet,
    provider: providerSheet,
    models: modelsSheet,
    "custom-model": customModelSheet,
    diagnostics: diagnosticsSheet,
    mcp: mcpSheet,
    "mcp-server": mcpServerSheet,
    workspace: workspaceSheet,
    commands: commandSheet,
    attach: attachSheet,
    trace: traceSheet,
    file: fileSheet,
    "new-file": newFileSheet,
    "plugin-detail": pluginSheet,
    "plugin-search": pluginSearchSheet,
    "new-automation": automationSheet,
    "automation-detail": automationDetailSheet,
    confirm: confirmSheet,
    "session-menu": sessionMenuSheet,
    "rename-session": renameSheet,
  };
  const html = (builders[type] || (() => sheetFrame({ title: "面板", body: "", dismissible })))(data);
  els.sheet.innerHTML = html;
  mountSheetControls(type);
  els.app.dataset.sheet = "true";
  requestAnimationFrame(() => {
    els.sheet.dataset.open = "true";
  });

  if (!dismissible) {
    const first = els.sheet.querySelector("[data-act='approval-deny']");
    first?.focus();
  } else {
    const focusable = els.sheet.querySelector("input, textarea, button");
    focusable?.focus({ preventScroll: true });
  }
}

/* ---------------- 各类面板 ---------------- */

function approvalSheet(info) {
  const risks = {
    fs_write: "这会修改工作区中的文件，原内容可以被 diff 预览。",
    fs_delete: "这会删除文件，且无法撤销。",
    shell: "这会在沙箱中执行命令。",
    run_code: "这会执行一段编排脚本，脚本内的写入受当前权限约束。",
    plugin_scaffold: "这会在运行时创建并挂载新插件，插件可以占用界面槽位。",
    office_export: "这会在工作区生成一个 Office 文件（Word / Excel），不会修改源文件。",
    ops_cleanup: "这会删除 exports/ 下的导出文件，源文件与会话记录不受影响。",
    task_schedule: "这会创建一个持续在后台运行的定时任务。",
    spawn_subagent: "这会启动一个拥有独立上下文的子 Agent。",
  };

  return sheetFrame({
    title: "需要你的确认",
    desc: "Agent 正在请求一次敏感操作。",
    dismissible: false,
    body: `
      <div class="approval" style="margin-top:2px">
        <div class="approval__head">
          ${icon("shield", "icon--sm")}
          <span class="approval__title">${esc(info.label || info.name)}</span>
          <span class="tag">${esc(info.name)}</span>
        </div>
        ${info.preview ? `<div class="approval__desc">目标：<code>${esc(info.preview)}</code></div>` : ""}
        <p class="approval__desc">${risks[info.name] || (String(info.name).startsWith("mcp__") ? "这会调用外部 MCP 服务器的工具，可能读写它的数据。" : "这是一个敏感操作。")}</p>
        ${
          info.args?.content
            ? `<p class="tool__label">将写入的内容</p><pre class="tool__code" style="max-height:180px">${esc(String(info.args.content).slice(0, 1600))}</pre>`
            : info.args?.code
            ? `<p class="tool__label">将执行的脚本</p><pre class="tool__code" style="max-height:200px">${esc(String(info.args.code).slice(0, 1600))}</pre>`
            : info.args?.command
            ? `<p class="tool__label">命令</p><pre class="tool__code">${esc(String(info.args.command))}</pre>`
            : String(info.name).startsWith("mcp__")
            ? `<p class="tool__label">工具参数</p><pre class="tool__code">${esc(JSON.stringify(info.args || {}, null, 2))}</pre>`
            : ""
        }
      </div>
      ${
        info.safety?.warn
          ? `<div class="tool__notice tool__notice--warn">${icon("shield", "icon--xs")} CC Safety Net：检测到 ${esc(info.safety.secrets.join("、"))}，请确认是否写入。</div>`
          : info.safety?.checked
          ? `<div class="tool__notice">${icon("shield", "icon--xs")} CC Safety Net 已检查，未发现高风险模式。</div>`
          : ""
      }
      <p class="field__hint" style="margin-top:10px">选择「始终允许」会把审批策略改为自动放行，可在设置中改回。</p>`,
    foot: `
      <button class="btn btn--ghost" data-act="approval-deny" style="flex:1">拒绝</button>
      <button class="btn btn--ghost" data-act="approval-always" style="flex:1">始终允许</button>
      <button class="btn btn--primary" data-act="approval-allow" style="flex:1.2">允许一次</button>`,
  });
}

function modeSheet() {
  const s = state.settings;
  return sheetFrame({
    title: "运行模式",
    desc: "模式决定当前会话装配哪些工具与提示词。",
    body: Object.values(MODES)
      .map(
        (m) => `
      <button class="card card--interactive" data-act="set-mode" data-value="${m.id}" style="margin-bottom:8px;${m.id === s.mode ? "border-color:var(--accent-line);background:var(--accent-soft)" : ""}">
        <div class="card__row">
          <span class="avatar ${m.id === s.mode ? "avatar--accent" : ""}">${icon({ standard: "bolt", ptc: "code", minimal: "terminal", creator: "sparkles" }[m.id] || "bolt", "icon--sm")}</span>
          <div style="flex:1;min-width:0">
            <div class="card__title">${m.name}模式 ${m.id === s.mode ? '<span class="tag tag--on" style="margin-left:4px">当前</span>' : ""}</div>
            <div class="card__sub">${m.detail}</div>
          </div>
          ${m.id === s.mode ? icon("check", "icon--sm") : ""}
        </div>
      </button>`
      )
      .join("") +
      `<p class="field__hint">极简模式只保留终端与文件编辑器；PTC 模式额外提供 <code>run_code</code>；创造模式可检查并创建插件。</p>`,
  });
}

function modelSheet() {
  const m = currentModel();
  if (!m) {
    return sheetFrame({
      title: "模型",
      desc: "还没有添加模型。模型完全由你定义：选供应方、填模型 ID 和 Key 即可。",
      body: `
        <button class="card card--interactive" data-act="new-custom-model" style="margin-bottom:10px">
          <div class="card__row">
            <span class="avatar avatar--accent">${icon("plus", "icon--sm")}</span>
            <div style="flex:1;min-width:0">
              <div class="card__title">添加模型</div>
              <div class="card__sub">DeepSeek / OpenAI / Moonshot / 兼容网关，供应方信息已备好</div>
            </div>
            ${icon("chevron", "icon--sm")}
          </div>
        </button>
        <button class="btn btn--ghost btn--block" data-act="open-models">${icon("puzzle", "icon--xs")} 管理已有模型</button>`,
    });
  }
  const conn = modelConnection(m.id);
  return sheetFrame({
    title: "模型",
    desc: "当前模型、端点与连接状态；参数可以逐个模型单独修改。",
    body: `
      <button class="card card--interactive model-pick" data-act="open-model-list">
        <div class="card__row">
          <span class="avatar avatar--accent" style="font-size:9px">${esc(m.provider.slice(0, 3).toUpperCase())}</span>
          <div style="flex:1;min-width:0">
            <div class="card__title">${esc(m.label)} ${m.tag ? `<span class="tag">${m.tag}</span>` : ""}</div>
            <div class="card__sub">${esc(m.provider)} · ${fmtContext(m.ctx)} · ${esc(hostOf(modelBaseUrl(m)))}</div>
          </div>
          ${icon("chevron", "icon--sm")}
        </div>
      </button>

      <div class="model-detail">
        <div class="kv"><span>连接状态</span><b>${statusPill(m.id)}</b></div>
        <div class="kv"><span>实际 model</span><b class="mono">${esc(modelApiId(m) || "未填写")}</b></div>
        <div class="kv"><span>端点</span><b class="mono">${esc(hostOf(modelBaseUrl(m)))}</b></div>
        <div class="kv"><span>上下文</span><b>${fmtContext(m.ctx)}</b></div>
        <div class="kv"><span>Key</span><b>${hasKeyFor(m) ? `已配置 · ${providerKeyOf(m)}` : "未配置"}</b></div>
        ${m.overridden ? `<div class="kv"><span>参数</span><b>已自定义</b></div>` : ""}
      </div>
      <p class="field__hint" style="margin:8px 0 10px">${esc(conn.detail)}</p>

      <div class="model-actions">
        <button class="btn btn--ghost btn--sm" data-act="test-model" data-id="${m.id}" style="flex:1">${icon("bolt", "icon--xs")} 测试连接</button>
        <button class="btn btn--ghost btn--sm" data-act="edit-model" data-id="${m.id}" style="flex:1">${icon("gear", "icon--xs")} 模型参数</button>
      </div>
      <div id="model-test-result"></div>

      ${effortEnabled() ? `<div id="effort-mount"></div>` : ""}`,
  });
}

function modelListSheet() {
  // 顺序与「设置 → 模型管理」完全一致：按厂牌分组，厂牌顺序同设置里的大类顺序。
  const groups = groupModelsByProvider(allModels());
  const active = state.settings.model;

  const row = (m) => `
      <button class="card card--interactive" data-act="set-model" data-value="${m.id}" style="margin-bottom:7px;${m.id === active ? "border-color:var(--accent-line);background:var(--accent-soft)" : ""}">
        <div class="card__row">
          <span class="avatar ${m.id === active ? "avatar--accent" : ""}" style="font-size:9px">${esc(PROVIDER_META[m.providerKey || "custom"]?.short || "CUS")}</span>
          <div style="flex:1;min-width:0">
            <div class="card__title">${esc(m.label)} ${m.tag ? `<span class="tag">${m.tag}</span>` : ""}</div>
            <div class="card__sub">${esc(m.provider)} · ${fmtContext(m.ctx)} · ${esc(hostOf(modelBaseUrl(m)))}</div>
            <div style="margin-top:4px">${statusPill(m.id, { compact: true })}</div>
          </div>
          ${m.id === active ? icon("check", "icon--sm") : icon("chevron", "icon--sm")}
        </div>
      </button>`;

  return sheetFrame({
    title: "选择模型",
    desc: "按厂牌分组，顺序与设置里一致；切换后回到上一页，每行的状态来自最近一次请求或测试。",
    body: groups
      .map(
        (g) => `
      <div class="model-group">
        <div class="model-group__head">
          <span class="eyebrow">${esc(g.meta.name)}</span>
          <span class="eyebrow">${g.models.length} 个</span>
        </div>
        ${g.models.map(row).join("")}
      </div>`
      )
      .join(""),
  });
}

function effortEnabled() {
  return state.plugins.some((p) => p.id === "effort" && p.enabled);
}

function syncEffortChip(id = state.settings.reasoning) {
  const el = els.app.querySelector('.chip[data-act="open-model"] .chip__effort');
  if (!el) return;
  el.textContent = effortName(id);
  el.style.color = effortColor(id);
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url || "未填写端点";
  }
}

/** 选模型 = 切换 id；参数由每个模型自己的配置决定，不再覆盖全局值。 */
function applyModelSelection(value) {
  const model = allModels().find((m) => m.id === value) || allModels()[0];
  setSettings({ model: model.id });
  renderAppbar();
  if (ui.view === "chat") renderMain(true);
  if (ui.view === "settings") renderMain(true);
  verifyModel(model.id);
  return model;
}

/* ---------------- 账号与服务 ---------------- */

const SHORT = {
  deepseek: "DEE", glm: "GLM", qwen: "QWN", doubao: "DBY", moonshot: "MOO",
  minimax: "MMX", xiaomi: "MIMO", spark: "SPK", siliconflow: "SIL",
  openai: "OPE", groq: "GRQ", openrouter: "OR", ollama: "OLL", lmstudio: "LMS",
  custom: "CUS",
};
const PROVIDER_META = Object.fromEntries(
  Object.entries(PROVIDERS).map(([slot, p]) => [
    slot,
    {
      name: p.name,
      short: SHORT[slot] || "CUS",
      host: p.baseUrl ? hostOf(p.baseUrl) : "按模型填写",
      desc: p.hint,
      console: p.console,
      baseUrl: p.baseUrl,
      endpoints: p.endpoints || [],
      suggest: p.suggest,
      defaultCtx: p.defaultCtx,
    },
  ])
);

/* 厂牌（大类）的全局顺序。
   设置里的「账号与服务」「模型管理」以及会话上方的「选择模型」都用这一份顺序，
   三处看到的厂牌排列完全一致，用户在任意入口切换模型都不会重新找位置。 */
const PROVIDER_ORDER = Object.keys(PROVIDERS);

/** 厂牌在顺序表里的下标；不在表内（历史数据里的未知厂牌）排到最后。 */
function providerRank(slot) {
  const i = PROVIDER_ORDER.indexOf(slot);
  return i < 0 ? PROVIDER_ORDER.length : i;
}

/**
 * 把模型列表按厂牌分组，组内按 model id 排。
 * 返回 [{ slot, meta, models }]，组序 = PROVIDER_ORDER（当前厂牌同样按此表定位，不置顶）。
 * 「设置 → 模型管理」与「会话上方 → 选择模型」共用，保证顺序一致。
 */
function groupModelsByProvider(list) {
  const groups = new Map();
  (list || []).forEach((m) => {
    const slot = m.providerKey || "custom";
    if (!groups.has(slot)) groups.set(slot, []);
    groups.get(slot).push(m);
  });
  return [...groups.keys()]
    .sort((a, b) => providerRank(a) - providerRank(b))
    .map((slot) => ({
      slot,
      meta: PROVIDER_META[slot] || PROVIDER_META.custom,
      models: [...groups.get(slot)].sort((a, b) =>
        String(modelApiId(a)).localeCompare(String(modelApiId(b)), "en", { numeric: true })
      ),
    }));
}

function fmtDate(ms) {
  try {
    return new Date(ms).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return "—";
  }
}

function keyOf(slot) {
  return String(state.settings.keys?.[slot] || "").trim();
}

function providerRow(slot) {
  const meta = PROVIDER_META[slot];
  const key = keyOf(slot);
  const active = providerKeyOf() === slot;
  const count = allModels().filter((m) => (m.providerKey || "custom") === slot).length;
  return `
    <button class="provider-row" data-act="open-provider" data-slot="${slot}">
      <span class="avatar ${active ? "avatar--accent" : ""}">${esc(meta.short)}</span>
      <span class="provider-row__main">
        <span class="provider-row__top">
          <span class="provider-row__name">${esc(meta.name)}</span>
          ${active ? '<span class="tag tag--on">当前</span>' : ""}
        </span>
        <span class="provider-row__sub">${key ? `Key ····${esc(key.slice(-4))}` : "未配置 Key"} · ${count} 个模型</span>
      </span>
      ${icon("chevron", "icon--sm")}
    </button>`;
}

function accountSheet() {
  const s = state.settings;
  const used = Object.keys(PROVIDER_META).filter((slot) => keyOf(slot)).length;
  const bytes = JSON.stringify(state).length;
  return sheetFrame({
    title: "账号与服务",
    desc: "本机档案与各服务凭据；Key 只存在这台设备。",
    body: `
      <div class="account-profile">
        <span class="avatar avatar--accent">${icon("user", "icon--sm")}</span>
        <div class="account-profile__main">
          <input class="input account-profile__name" value="${esc(s.profileName || "本机用户")}" data-set="profileName" aria-label="本机档案名称">
          <p class="field__hint">本机档案 · 创建于 ${fmtDate(state.createdAt)} · ${used} / ${PROVIDER_COUNT} 个服务已配置</p>
        </div>
      </div>

      <div class="section-label">API 服务</div>
      ${Object.keys(PROVIDER_META).map(providerRow).join("")}
      <p class="field__hint" style="margin:8px 0 4px;line-height:1.7">切换模型时会自动使用对应服务的 Key，不会把 DeepSeek 的 Key 发给 OpenAI。</p>

      <div class="section-label">DeepSeek 官方账号</div>
      <div class="account-official">
        <div class="account-official__head">${icon("shield", "icon--sm")} 未连接 · 本版本不提供官方登录</div>
        <p>官方账号登录需要 OAuth 回调与后端，当前纯 WebView 架构没有这条链路。API Key 可以正常调用模型，但不能管理订阅与账单；Key 只保存在本机。</p>
        <div class="account-official__actions">
          <a class="btn btn--ghost btn--sm" href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener">${icon("external", "icon--xs")} 开放平台</a>
          <button class="btn btn--ghost btn--sm" data-act="copy-deepseek-url">${icon("copy", "icon--xs")} 复制链接</button>
        </div>
      </div>

      <div class="section-label">本机数据</div>
      <div class="kv"><span>会话</span><b>${state.sessions.length}</b></div>
      <div class="kv"><span>文件</span><b>${listFiles().length}</b></div>
      <div class="kv"><span>占用</span><b>${(bytes / 1024).toFixed(0)} KB</b></div>
      <button class="btn btn--ghost btn--block" style="margin-top:12px" data-act="export-all">${icon("download", "icon--xs")} 导出全部数据</button>`,
  });
}

function providerSheet(data = {}) {
  const slot = data.slot || "deepseek";
  const meta = PROVIDER_META[slot];
  const key = keyOf(slot);
  return sheetFrame({
    title: meta.name,
    desc: meta.desc,
    body: `
      <div class="field">
        <label class="field__label" for="provider-key">API Key</label>
        <div class="input-suffix">
          <input class="input mono" id="provider-key" type="password" value="${esc(key)}"
            data-provider-key="${slot}" placeholder="sk-…" autocomplete="off" spellcheck="false">
          <button class="icon-btn" data-act="toggle-provider-key" aria-label="显示或隐藏 Key">${icon("eye", "icon--sm")}</button>
        </div>
        <p class="field__hint">以明文保存在本机 localStorage；清除后会从所有请求中移除。</p>
      </div>
      <div class="kv"><span>默认端点</span><b>${esc(meta.host)}</b></div>
      <div class="kv"><span>服务内模型</span><b>${allModels().filter((m) => (m.providerKey || "custom") === slot).length} 个</b></div>

      ${
        slot === "deepseek"
          ? `<button class="btn btn--ghost btn--block" style="margin-top:12px" data-act="deepseek-balance">${icon("database", "icon--xs")} 查询账户余额</button>
             <div id="balance-result"></div>`
          : ""
      }

      <button class="btn btn--ghost btn--block" style="margin-top:8px" data-act="test-provider" data-slot="${slot}">${icon("bolt", "icon--xs")} 测试此服务</button>
      <div id="provider-test"></div>

      ${
        key
          ? `<button class="btn btn--danger btn--block" style="margin-top:12px" data-act="clear-provider-key" data-slot="${slot}">${icon("trash", "icon--xs")} 清除此服务的 Key</button>`
          : ""
      }

      ${
        meta.console
          ? `<div class="account-official__actions" style="margin-top:12px">
               <a class="btn btn--ghost btn--sm" href="${meta.console}" target="_blank" rel="noopener">${icon("external", "icon--xs")} 管理 Key</a>
             </div>`
          : ""
      }`,
  });
}

/* ---------------- 模型管理 ---------------- */

function modelManageRow(m) {
  const active = m.id === state.settings.model;
  const isCustomEntry = m.custom && m.id !== "custom";
  const conn = modelConnection(m.id);
  return `
    <div class="model-manage" data-active="${active}">
      <button class="model-manage__main" data-act="set-model" data-value="${m.id}">
        <span class="avatar ${active ? "avatar--accent" : ""}">${esc(PROVIDER_META[m.providerKey]?.short || "CUS")}</span>
        <span class="model-manage__text">
          <span class="model-manage__name">${esc(m.label)} ${active ? '<span class="tag tag--on">当前</span>' : ""}${m.overridden ? '<span class="tag">已改参数</span>' : ""}</span>
          <span class="model-manage__sub">${esc(m.apiModel || "未填模型 ID")} · ${fmtContext(m.ctx)} · ${esc(hostOf(modelBaseUrl(m)))}</span>
          <span class="model-manage__status conn-pill conn-pill--${conn.tone}"><span class="conn-pill__dot"></span>${esc(conn.label)}</span>
        </span>
        ${active ? icon("check", "icon--sm") : ""}
      </button>
      <span class="model-manage__actions">
        <button class="icon-btn icon-btn--sm" data-act="test-model" data-id="${m.id}" aria-label="测试 ${esc(m.label)} 的连接">${icon("bolt", "icon--xs")}</button>
        <button class="icon-btn icon-btn--sm" data-act="edit-model" data-id="${m.id}" aria-label="编辑 ${esc(m.label)} 的参数">${icon("gear", "icon--xs")}</button>
        ${isCustomEntry ? `<button class="icon-btn icon-btn--sm" data-act="delete-custom-model" data-id="${m.id}" aria-label="删除 ${esc(m.label)}">${icon("trash", "icon--xs")}</button>` : ""}
      </span>
    </div>`;
}

function modelsSheet() {
  const list = allModels();
  const cur = currentModel();
  const curSlot = cur ? cur.providerKey || "custom" : "deepseek";

  // 分组顺序与「会话上方 → 选择模型」一致：都用 PROVIDER_ORDER（大类顺序）。
  // 组内仍然把当前模型顶到第一位，方便直接看到自己在用哪个。
  let groups = groupModelsByProvider(list);
  if (!groups.length) groups = [{ slot: curSlot, meta: PROVIDER_META[curSlot] || PROVIDER_META.custom, models: [] }];

  const sortRows = (arr) =>
    [...arr].sort((a, b) => {
      if (a.id === cur?.id) return -1;
      if (b.id === cur?.id) return 1;
      return String(modelApiId(a)).localeCompare(String(modelApiId(b)), "en", { numeric: true });
    });

  const html = groups
    .map((g) => {
      const k = g.slot;
      const meta = g.meta;
      const rows = sortRows(g.models);
      const base = String((rows[0] && modelBaseUrl(rows[0])) || meta.baseUrl || "").replace(/\/+$/, "");
      const catalog = catalogFor(k, base);
      const pool = (catalog.length ? catalog : (meta.suggest || []).map((m) => (typeof m === "string" ? m : m.id))).filter(Boolean);
      const have = new Set(rows.map((m) => modelApiId(m)));
      const rest = pool.filter((id) => !have.has(id)).slice(0, 10);
      return `
        <div class="model-group">
          <div class="model-group__head">
            <span class="eyebrow">${esc(meta.name)}</span>
            <span class="eyebrow">${rows.length} 个已添加${catalog.length ? " · 端点清单" : ""}</span>
          </div>
          ${rows.length ? rows.map(modelManageRow).join("") : `<p class="field__hint">这个厂还没有模型，点下面的 ＋ 直接加入。</p>`}
          ${
            rest.length
              ? `<div class="cm-model-list model-group__rest">
                   ${rest.map((id) => `<button class="chip" data-act="use-catalog-model" data-value="${esc(id)}" data-slot="${esc(k)}">＋ ${esc(id)}${knownModelCtx(id) ? ` · ${fmtContext(knownModelCtx(id))}` : ""}</button>`).join("")}
                 </div>`
              : ""
          }
        </div>`;
    })
    .join("");

  return sheetFrame({
    title: "模型管理",
    desc: "按厂牌分组：点已添加的即切换，点 ＋ 即加入并切换；切换后会自动测一次连接。",
    body: `
      ${html}
      <button class="btn btn--primary btn--block" style="margin-top:12px" data-act="new-custom-model">${icon("plus", "icon--xs")} 添加模型</button>
      <p class="field__hint" style="margin-top:10px;line-height:1.7">只支持 OpenAI 兼容协议；每个模型可单独改上下文、端点与采样参数，点闪电测试连接。</p>`,
  });
}

/** 统一参数面板：内置模型写覆盖，自定义模型直接改条目。 */
function modelParamsSheet(data = {}) {
  const isNew = !data.id;
  const existing = isNew ? null : allModels().find((m) => m.id === data.id);
  // 新建默认开启；已有模型只有显式关过才关
  const visionOn = existing ? existing.vision !== false : true;
  const isCustomEntry = !!existing;
  const defaults = existing?.defaults;
  const temp = typeof existing?.temperature === "number" ? existing.temperature : "";
  const maxTokens = Number(existing?.maxTokens) > 0 ? existing.maxTokens : "";
  const slot = existing?.providerKey || "deepseek";
  const providerMeta = PROVIDER_META[slot] || PROVIDER_META.custom;
  const suggest = providerMeta.suggest || [];
  const suggestChip = (m) => {
    const id = typeof m === "string" ? m : m.id;
    const ctx = typeof m === "string" ? null : m.ctx;
    const note = typeof m === "string" ? "" : m.note || "";
    const label = note || (ctx ? `${id} · ${fmtContext(ctx)}` : id);
    return `<button class="chip" data-act="pick-suggest-model" data-value="${esc(id)}"${ctx ? ` data-ctx="${ctx}"` : ""}>${esc(label)}</button>`;
  };

  return sheetFrame({
    title: isNew ? "添加模型" : "模型参数",
    desc: isNew
      ? "选好供应方（端点与常用模型已备好），填上模型 ID 和 Key 就能连上。"
      : "这些参数只影响这一个模型；供应方决定使用哪个服务的 Key。",
    body: `
      <div class="field">
        <label class="field__label" for="cm-provider">供应方</label>
        <select class="input select" id="cm-provider" data-cm-provider="1">
          ${Object.entries(PROVIDER_META)
            .map(([k, v]) => `<option value="${k}" ${k === slot ? "selected" : ""}>${esc(v.name)}${v.baseUrl ? ` · ${esc(hostOf(v.baseUrl))}` : " · 自填端点"}</option>`)
            .join("")}
        </select>
        <p class="field__hint">${esc(providerMeta.desc)}</p>
        ${
          (providerMeta.endpoints || []).length
            ? `<div class="cm-scenes" id="cm-scenes">
                 <span class="eyebrow">端点场景</span>
                 ${providerMeta.endpoints.map((e) => `<button class="chip" data-act="pick-scene" data-url="${esc(e.baseUrl)}">${esc(e.label)}</button>`).join("")}
               </div>`
            : ""
        }
      </div>

      <div class="field">
        <label class="field__label" for="cm-key">API Key</label>
        <input class="input mono" id="cm-key" type="password" value="${esc(keyOf(slot))}" placeholder="粘贴 Key，自动保存并拉取可用模型" autocomplete="off" spellcheck="false">
        <p class="field__hint">只保存在本机。同一服务的模型共用一个 Key，填一次就够。</p>
      </div>

      <div class="cm-suggest" id="cm-suggest">
        ${suggest.map(suggestChip).join("")}
      </div>

      <div class="field">
        <label class="field__label" for="cm-label">显示名称</label>
        <input class="input" id="cm-label" value="${esc(existing?.label || "")}" placeholder="例如 公司网关 · GPT-4.1" spellcheck="false">
      </div>
      <div class="field">
        <label class="field__label" for="cm-model">模型 ID</label>
        <input class="input mono" id="cm-model" value="${esc(existing?.apiModel || "")}" placeholder="${esc(typeof suggest[0] === "string" ? suggest[0] : suggest[0]?.id || "从下方列表点一个")}" spellcheck="false">
        <p class="field__hint">不用记 ID：填好 Key 会自动列出可用模型，点一下就填好并切换。</p>
        <div id="cm-models" class="cm-models"><p class="field__hint">填入 Key 后自动获取；也可以直接点上方「常用模型」。</p></div>
      </div>
      <div class="field">
        <label class="field__label" for="cm-base">Base URL</label>
        <input class="input mono" id="cm-base" value="${esc(existing?.baseUrl || providerMeta.baseUrl || "")}" placeholder="https://gateway.example.com/v1" spellcheck="false">
        <p class="field__hint">选供应方会预填官方端点，可改；填到 <code>/v1</code> 即可，应用自动补 <code>/chat/completions</code>。</p>
      </div>
      <div class="field">
        <label class="field__label" for="cm-ctx">上下文窗口</label>
        <div class="input-suffix">
          <input class="input mono" id="cm-ctx" type="number" min="4" max="2000" step="1" inputmode="numeric"
            value="${Math.round(
              Math.max(existing?.ctx || 0, existing ? knownModelCtx(existing.apiModel) : 0, 128000) / 1000
            )}">
          <span class="input-unit">K</span>
        </div>
        <p class="field__hint">请求前按这个窗口的 72% 裁剪较早回合——预留 28% 给本步回复与工具调用，避免超出窗口报错。已知模型会自动预填实际窗口。</p>
      </div>
      <div class="field-row">
        <div class="field">
          <label class="field__label" for="cm-temp">温度</label>
          <input class="input mono" id="cm-temp" type="number" min="0" max="2" step="0.1" inputmode="decimal"
            value="${temp}" placeholder="0.3">
        </div>
        <div class="field">
          <label class="field__label" for="cm-max">最大输出</label>
          <input class="input mono" id="cm-max" type="number" min="0" max="131072" step="256" inputmode="numeric"
            value="${maxTokens}" placeholder="不限制">
        </div>
      </div>
      <div class="settings__row" style="padding:4px 0 10px">
        <div class="settings__row-main">
          <div class="settings__row-title">透传推理强度</div>
          <div class="settings__row-sub">默认开启；端点拒绝 reasoning_effort 时会自动关闭</div>
        </div>
        <button class="switch" role="switch" aria-checked="${existing ? existing.supportsEffort !== false : true}" aria-label="透传推理强度" data-act="toggle-cm-effort" data-toggle="cm-effort"></button>
      </div>
      <div class="settings__row" style="padding:0 0 10px">
        <div class="settings__row-main">
          <div class="settings__row-title">图片输入（视觉）</div>
          <div class="settings__row-sub">开启后，聊天里的图片按 image_url 发给模型；长边压到 1568px 再发送</div>
        </div>
        <button class="switch" role="switch" aria-checked="${visionOn}" aria-label="图片输入" data-act="toggle-cm-vision" data-toggle="cm-vision"></button>
      </div>

      <div id="model-form-test"></div>`,
    foot: `
      ${existing?.backup ? `<button class="btn btn--ghost btn--sm" data-act="reset-model" data-id="${existing.id}" title="恢复到最初保存的参数">恢复默认</button>` : ""}
      <button class="btn btn--ghost btn--sm" data-act="test-model-form" data-id="${existing?.id || ""}">${icon("bolt", "icon--xs")} 测试</button>
      <button class="btn btn--primary" data-act="save-model-params" data-id="${existing?.id || ""}">保存</button>`,
  });
}

function customModelSheet(data = {}) {
  return modelParamsSheet(data);
}

/* ---------------- MCP ---------------- */

function mcpSheet() {
  const servers = state.settings.mcpServers || [];
  return sheetFrame({
    title: "MCP 服务器",
    desc: "Streamable HTTP（JSON-RPC）。测试连接会拉取工具列表，发现后自动进入工具装配。",
    body: servers.length
      ? servers
          .map(
            (s) => `
        <div class="mcp-row">
          <div class="mcp-row__main">
            <div class="mcp-row__top">
              <b>${esc(s.name || "未命名")}</b>
              <span class="tag ${s.enabled ? "tag--on" : ""}">${s.enabled ? "启用" : "停用"}</span>
            </div>
            <div class="mcp-row__sub">${esc(s.url)} · ${(s.tools || []).length} 个工具</div>
          </div>
          <button class="icon-btn icon-btn--sm" data-act="edit-mcp" data-id="${s.id}" aria-label="编辑 ${esc(s.name || "")}">${icon("edit", "icon--sm")}</button>
        </div>`
          )
          .join("")
      : `<div class="empty-line"><b>还没有 MCP 服务器</b>支持 Streamable HTTP 的 MCP 服务可以接进来；<br>stdio / 本地进程型服务器需要原生能力，当前不支持。</div>`,
    foot: `<button class="btn btn--primary btn--block" data-act="new-mcp">${icon("plus", "icon--xs")} 添加服务器</button>`,
  });
}

function mcpServerSheet(data = {}) {
  const existing = data.id ? (state.settings.mcpServers || []).find((s) => s.id === data.id) : null;
  const tools = existing?.tools || [];
  return sheetFrame({
    title: existing ? "编辑 MCP 服务器" : "添加 MCP 服务器",
    desc: "需要服务端允许 CORS；只支持 Streamable HTTP。",
    body: `
      <div class="field">
        <label class="field__label" for="mcp-name">名称</label>
        <input class="input" id="mcp-name" value="${esc(existing?.name || "")}" placeholder="例如 文件检索" spellcheck="false">
      </div>
      <div class="field">
        <label class="field__label" for="mcp-url">URL</label>
        <input class="input mono" id="mcp-url" value="${esc(existing?.url || "")}" placeholder="https://mcp.example.com/mcp" spellcheck="false">
      </div>
      <div class="field">
        <label class="field__label" for="mcp-token">Token（可选）</label>
        <input class="input mono" id="mcp-token" type="password" value="${esc(existing?.token || "")}" placeholder="Bearer …" autocomplete="off" spellcheck="false">
      </div>
      <div class="settings__row">
        <div class="settings__row-main">
          <div class="settings__row-title">启用</div>
          <div class="settings__row-sub">启用并把工具交给 Agent</div>
        </div>
        <input type="checkbox" id="mcp-enabled" ${existing?.enabled !== false ? "checked" : ""} aria-label="启用此 MCP 服务器" style="width:16px;height:16px;accent-color:var(--accent)">
      </div>

      <button class="btn btn--ghost btn--block" style="margin-top:12px" data-act="test-mcp" data-id="${existing?.id || ""}">${icon("bolt", "icon--xs")} 测试连接并发现工具</button>
      <div id="mcp-test"></div>

      ${
        tools.length
          ? `<div class="section-label">已发现 · ${tools.length}</div>
             ${tools
               .map(
                 (t) => `<div class="mcp-tool"><b>${esc(t.name)}</b><span>${esc(t.description || "无描述")}</span></div>`
               )
               .join("")}`
          : ""
      }

      <p class="field__hint" style="margin-top:12px;line-height:1.75">发现工具后，它们会出现在模型可用工具里，调用前仍会弹出审批。stdio / 本地进程型 MCP 服务器需要 Capacitor 原生桥，当前版本不支持。</p>

      <div class="account-official__actions" style="margin-top:14px">
        ${existing ? `<button class="btn btn--danger btn--sm" data-act="delete-mcp" data-id="${existing.id}">${icon("trash", "icon--xs")} 删除</button>` : ""}
        <button class="btn btn--primary btn--sm" data-act="save-mcp" data-id="${existing?.id || ""}" style="flex:1.4">保存</button>
      </div>`,
  });
}

function readMcpForm(id) {
  return {
    id: id || `mcp_${Date.now().toString(36)}`,
    name: $("#mcp-name")?.value.trim() || "未命名服务器",
    url: $("#mcp-url")?.value.trim() || "",
    token: $("#mcp-token")?.value.trim() || "",
    enabled: $("#mcp-enabled")?.checked !== false,
  };
}

function workspaceSheet() {
  const files = listFiles();
  const total = files.reduce((s, f) => s + (Number(f.size) || 0), 0);
  return sheetFrame({
    title: "工作区",
    desc: "Agent 的文件读写都限制在这个范围内。",
    body: `
      <div class="workspace__path" style="margin-bottom:12px">${icon("folder", "icon--sm")}<span>/workspace/<b>默认工作区</b></span></div>
      <div class="stat-row" style="margin-bottom:14px">
        <div class="stat"><div class="stat__val">${files.length}</div><div class="stat__key">文件</div></div>
        <div class="stat"><div class="stat__val">${(total / 1024).toFixed(1)}<small>KB</small></div><div class="stat__key">占用</div></div>
        <div class="stat"><div class="stat__val">${state.plugins.filter((p) => p.enabled).length}</div><div class="stat__key">插件</div></div>
      </div>
      <span class="field__label">权限</span>
      <div class="segmented" style="margin-bottom:6px">
        ${Object.values(PERMISSIONS).map((p) => `<button class="segmented__item" data-act="set-permission" data-value="${p.id}" aria-pressed="${state.settings.permission === p.id}">${p.name}</button>`).join("")}
      </div>
      <p class="field__hint" style="margin-bottom:14px">${esc(PERMISSIONS[state.settings.permission].desc)}</p>
      <button class="btn btn--ghost btn--block" data-act="goto-workspace">${icon("folder", "icon--sm")} 打开文件列表</button>`,
  });
}

function commandSheet() {
  const items = [
    { a: "new-session", ic: "plus", t: "新会话", k: "N" },
    { a: "open-mode", ic: "bolt", t: "切换运行模式", k: "M" },
    { a: "open-model", ic: "cpu", t: "选择模型", k: "K" },
    { a: "attach", ic: "attach", t: "添加文件（手机 / 工作区）", k: "@" },
    { a: "clear-session", ic: "trash", t: "清空当前会话", k: "" },
    { a: "export-session", ic: "download", t: "导出当前会话", k: "" },
    { a: "open-settings", ic: "gear", t: "打开设置", k: "," },
  ];
  return sheetFrame({
    title: "指令",
    desc: "移动端用面板代替斜杠命令，效果一致。",
    body: items
      .map(
        (i) => `<button class="menu__item" data-act="${i.a}" style="width:100%">
          ${icon(i.ic, "icon--sm")}<span>${i.t}</span><small>${i.k}</small>
        </button>`
      )
      .join(""),
  });
}

function attachSheet() {
  const lib = listLibrary();
  const busy = !!ui.importingFiles;
  const picked = ui.attachments;
  return sheetFrame({
    title: "添加文件",
    desc: "从手机选，或从资料库里挑已有的。选好直接进这条消息的附件，不再经工作区转一手。",
    body: `
      <button class="btn btn--primary btn--block" data-act="pick-phone-files" ${busy ? "disabled" : ""}>
        ${icon("download", "icon--sm")} ${busy ? "正在导入…" : "从手机选择文件"}
      </button>
      <p class="field__hint" style="margin:8px 0 16px">
        纯文本直接读给模型；图片在支持视觉的模型上会按图片发送；PDF / Office 只随消息附上，由 Agent 用工具处理。
      </p>

      ${
             picked.length
               ? `<div class="section-label">已选 ${picked.length} 个</div>
                  ${picked
                    .map(
                      (a, i) => `<div class="file-row">
                        <span class="fileicon">${esc((a.name || a.path).split(".").pop()?.slice(0, 3).toUpperCase() || "FILE")}</span>
                        <span class="file-row__name">${esc(a.name || a.path)}</span>
                        <span class="file-row__meta">${a.area === "library" ? "资料库 · " : ""}${attachSize(a.size)}</span>
                        <button class="attach-chip__x" data-act="remove-attachment" data-index="${i}" aria-label="移除">${icon("x", "icon--xs")}</button>
                      </div>`
                    )
                    .join("")}`
               : ""
           }

      <div class="section-label">资料库</div>
      ${
        lib.length
          ? lib
              .map(
                (f) => `<button class="file-row" data-act="attach-file" data-area="library" data-path="${esc(f.path)}">
                  <span class="fileicon">${esc((f.path.split(".").pop() || "").slice(0, 3).toUpperCase())}</span>
                  <span class="file-row__name">${esc(f.path)}</span>
                  <span class="file-row__meta">${attachSize(f.size)}</span>
                  ${icon("plus", "icon--xs")}
                </button>`
              )
              .join("")
          : `<div class="empty-line">资料库还没有文件<br>去「工作区 → 资料库」导入，或让 Agent 存入</div>`
      }
    `,
  });
}

function traceSheet(data) {
  const s = activeSession();
  const msg = s?.messages.find((m) => m.id === data.id) || s?.messages.filter((m) => m.role === "assistant").slice(-1)[0];
  if (!msg) {
    return sheetFrame({ title: "运行轨迹", body: `<div class="empty-line">还没有可展示的运行记录</div>` });
  }
  return sheetFrame({
    title: "运行轨迹",
    desc: "模型看到的一切都写进这条只追加的记录里。",
    body: `
      <div class="stat-row" style="margin-bottom:14px">
        <div class="stat"><div class="stat__val">${fmtClock(msg.duration || 0)}</div><div class="stat__key">用时</div></div>
        <div class="stat"><div class="stat__val">${(msg.tools || []).length}</div><div class="stat__key">工具</div></div>
        <div class="stat"><div class="stat__val">${fmtTokens(msg.tokens || 0)}</div><div class="stat__key">Tokens</div></div>
      </div>

      <div class="section-label">01 · 思考</div>
      <p class="field__hint" style="line-height:1.75;white-space:pre-wrap">${esc(msg.reasoning || "本次运行没有留下推理内容。")}</p>

      <div class="section-label">02 · 工具调用</div>
      ${
        (msg.tools || []).length
          ? msg.tools
              .map(
                (t, i) => `
          <div style="padding:10px 0;border-bottom:1px solid var(--line)">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <span class="mono" style="font-size:9px;color:var(--dim)">${String(i + 1).padStart(2, "0")}</span>
              <span class="tool__name">${esc(t.name)}</span>
              <span class="tag ${t.status === "done" ? "tag--on" : ""}" style="margin-left:auto">${{ done: "完成", error: "失败", denied: "已拒绝", waiting: "待批准", running: "运行中" }[t.status] || t.status} · ${fmtClock(t.ms || 0)}</span>
            </div>
            <div class="mono" style="font-size:10px;color:var(--muted);word-break:break-all">${esc(t.argLabel || "")}</div>
            ${t.diff ? `<div class="mono" style="font-size:9.5px;color:var(--dim);margin-top:4px">${t.diff.length} 行差异</div>` : ""}
          </div>`
              )
              .join("")
          : `<p class="field__hint">本次运行没有调用工具。</p>`
      }

      <div class="section-label">03 · 产物</div>
      <p class="field__hint">${(msg.tools || []).filter((t) => t.name === "fs_write").length} 个文件被写入，可在工作区查看。</p>`,
    foot: `<button class="btn btn--ghost btn--block" data-act="close-sheet">关闭</button>`,
  });
}

function fileSheet(data) {
  const area = data.area === "library" ? "library" : "workspace";
  const list = area === "library" ? listLibrary() : listFiles();
  const meta = list.find((f) => f.path === data.path);
  if (!meta) {
    return sheetFrame({ title: "文件不存在", body: `<div class="empty-line">${esc(data.path)}</div>` });
  }
  const size = Number(meta.size) || 0;
  const sizeText = size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`;
  const extName = (data.path.split(".").pop() || "").toUpperCase();
  const isMd = /\.md$/i.test(data.path);
  const binary = !isTextPath(data.path);
  const kind =
    extName === "DOCX"
      ? "Word 文档"
      : extName === "XLSX"
      ? "Excel 表格"
      : extName === "PPTX"
      ? "PowerPoint 演示"
      : extName === "PDF"
      ? "PDF 文档"
      : isImagePath(data.path)
      ? "图片"
      : "二进制文件";

  const body = binary
    ? `<div class="binary-card">
         <span class="fileicon ${extName === "XLSX" ? "fileicon--xlsx" : "fileicon--docx"}" style="width:46px;height:46px">${esc(extName)}</span>
         <div>
           <b>${kind}</b>
           <p>${
             extName === "PDF"
               ? "PDF 文档，点下方按钮保存到手机后用阅读器打开。"
               : extName === "DOCX" || extName === "XLSX" || extName === "PPTX"
               ? "标准 OOXML 文件，用 WPS / Office 打开即可。点下方按钮保存到手机。"
               : "二进制文件，可保存到手机后用对应应用打开。"
           }</p>
         </div>
       </div>`
    : `<div class="viewer">
         <div class="viewer__content" id="file-body"><p class="field__hint">正在读取…</p></div>
       </div>`;

  const foot =
    area === "library"
      ? `<button class="btn btn--ghost" data-act="delete-library-file" data-path="${esc(data.path)}" style="flex:1;color:var(--danger)">${icon("trash", "icon--sm")} 移出</button>
         <button class="btn btn--ghost" data-act="export-file" data-area="library" data-path="${esc(data.path)}" style="flex:1.2">${icon("download", "icon--sm")} 保存到手机</button>
         <button class="btn btn--primary" data-act="mention-file" data-path="${esc(data.path)}" style="flex:1.4">${icon("arrowUp", "icon--sm")} 引用</button>`
      : `<button class="btn btn--ghost" data-act="delete-file" data-path="${esc(data.path)}" style="flex:1;color:var(--danger)">${icon("trash", "icon--sm")} 删除</button>
         <button class="btn btn--ghost" data-act="export-file" data-area="workspace" data-path="${esc(data.path)}" style="flex:1.2">${icon("download", "icon--sm")} 存到手机</button>
         <button class="btn btn--primary" data-act="save-to-library" data-path="${esc(data.path)}" style="flex:1.3">${icon("layers", "icon--sm")} 存入资料库</button>`;

  if (!binary) {
    // 先出骨架，内容异步填充，避免大文件阻塞面板动画
    setTimeout(async () => {
      const box = document.getElementById("file-body");
      if (!box) return;
      try {
        const doc = await readDoc(area, data.path);
        box.className = `viewer__content ${isMd ? "md" : ""}`;
        box.innerHTML = isMd ? renderMarkdown(doc.content) : `<pre>${esc(doc.content)}</pre>`;
      } catch (err) {
        box.innerHTML = `<div class="msg__error">${icon("alert", "icon--sm")}<span>${esc(err.message || "读取失败")}</span></div>`;
      }
    }, 0);
  }

  return sheetFrame({
    title: esc(data.path.split("/").pop()),
    desc: `<span class="mono">${esc(data.path)} · ${sizeText} · ${fmtRelative(meta.updatedAt)}${area === "library" ? " · 资料库" : ""}</span>`,
    body,
    foot,
  });
}

function newFileSheet() {
  return sheetFrame({
    title: "新建文件",
    desc: "路径相对于工作区根目录。",
    body: `
      <div class="field">
        <label class="field__label" for="nf-path">路径</label>
        <input class="input mono" id="nf-path" placeholder="notes/新文件.md" autocomplete="off">
      </div>
      <div class="field">
        <label class="field__label" for="nf-content">内容</label>
        <textarea class="input" id="nf-content" rows="6" placeholder="可以先留空，之后再让 Agent 填。"></textarea>
      </div>`,
    foot: `<button class="btn btn--ghost" data-act="close-sheet" style="flex:1">取消</button><button class="btn btn--primary" data-act="create-file" style="flex:1.4">创建</button>`,
  });
}

function pluginSheet(data) {
  const p = state.plugins.find((x) => x.id === data.id);
  if (!p) return sheetFrame({ title: "插件", body: "" });
  return sheetFrame({
    title: esc(p.name),
    desc: `v${esc(p.version)} · ${p.official ? "官方" : "社区 / 自建"} · ${p.enabled ? "已启用" : "未启用"}`,
    body: `
      <div class="card" style="margin-bottom:14px">
        <div class="card__row">
          <span class="avatar avatar--accent" style="width:42px;height:42px">${icon("puzzle", "icon--sm")}</span>
          <div style="flex:1">
            <div class="card__title">${esc(p.name)}</div>
            <div class="card__sub">${esc(p.desc)}</div>
          </div>
          <button class="switch" role="switch" aria-checked="${p.enabled}" data-act="toggle-plugin" data-id="${p.id}"></button>
        </div>
      </div>
      <div class="kv"><span>提供能力</span><b>${p.tools.length ? p.tools.join(" · ") : p.scopes.includes("approval") ? "运行时护栏 · 无工具" : "界面扩展 · 无工具"}</b></div>
      <div class="kv"><span>作用域</span><b>${p.scopes.join(" · ")}</b></div>
      <div class="kv"><span>安装时间</span><b>${p.installedAt ? fmtRelative(p.installedAt) : "随内核内置"}</b></div>
      ${
        p.id === "safety"
          ? `<div class="section-label">护栏记录</div>
             <div class="stat-row" style="margin-bottom:10px">
               <div class="stat"><div class="stat__val">${state.safety?.scans || 0}</div><div class="stat__key">已扫描</div></div>
               <div class="stat"><div class="stat__val">${state.safety?.blocked || 0}</div><div class="stat__key">已拦截</div></div>
               <div class="stat"><div class="stat__val">ON</div><div class="stat__key">状态</div></div>
             </div>
             <p class="field__hint" style="line-height:1.8">${SAFETY_RULES.map((r) => `· ${esc(r)}`).join("<br>")}</p>`
          : ""
      }
      ${
        p.id === "effort"
          ? `<div class="section-label">源插件</div>
             <div class="kv"><span>包名</span><b>dsh-codex-effort-slider</b></div>
             <div class="kv"><span>版本</span><b>1.1.2 · MIT</b></div>
             <div class="kv"><span>作者</span><b>Microqian2th</b></div>
             <div class="kv"><span>当前档位</span><b>${ { off: "Off", low: "Low", high: "High", max: "Max" }[state.settings.reasoning] || "High" }</b></div>
             <p class="field__hint" style="line-height:1.8">按源插件 1:1 移植：模型面板里的整行滑条、Off / Low / High / Max、一档一色、高档紫色星云与 22 颗星尘。<br>长按滑条打开设置：动画三档、刻度点三档、复制诊断。<br>档位写入系统提示；只有声明支持 <code>reasoning_effort</code> 的模型才会额外透传。</p>
             <button class="btn btn--ghost btn--block" style="margin-top:12px" data-act="open-model">打开模型面板调整</button>`
          : ""
      }
      ${
        p.id === "ops"
          ? `<div class="section-label">运行时</div>
             <div class="kv"><span>会话</span><b>${state.sessions.length}</b></div>
             <div class="kv"><span>文件</span><b>${listFiles().length} · ${(listFiles().reduce((n, f) => n + (Number(f.size) || 0), 0) / 1024).toFixed(1)} KB</b></div>
             <div class="kv"><span>安全扫描</span><b>${state.safety?.scans || 0} 次 · 拦截 ${state.safety?.blocked || 0}</b></div>
             <p class="field__hint" style="line-height:1.8">提供 <code>ops_status</code> 与 <code>ops_cleanup</code>；清理只动 <code>exports/</code>，必须走审批。</p>`
          : ""
      }
      ${
        p.id === "office"
          ? `<div class="section-label">能力</div>
             <p class="field__hint" style="line-height:1.8">Markdown → Word（.docx，保留标题、列表、表格）<br>CSV → Excel（.xlsx，保留表头与列宽）<br>产物写入 <code>exports/</code>，在工作区下载。</p>`
          : ""
      }
      <p class="field__hint" style="margin-top:12px">关闭开关会从当前上下文中卸载该插件，已经挂载的界面槽位会在下一次渲染时移除。</p>`,
    foot:
      p.preinstalled
        ? `<button class="btn btn--ghost btn--block" data-act="close-sheet">完成</button>`
        : `<button class="btn btn--danger" data-act="uninstall-plugin" data-id="${p.id}" style="flex:1">卸载</button>
           <button class="btn btn--primary" data-act="close-sheet" style="flex:1.3">完成</button>`,
  });
}

const CATALOG = [
  { id: "charts", name: "图表生成", desc: "把 CSV 直接渲染成可交互的图表卡片。", version: "1.2.0", tools: ["render_chart"], scopes: ["ui.slot"], official: true },
  { id: "git", name: "Git 快照", desc: "为工作区生成版本快照与可回滚 diff。", version: "1.0.4", tools: ["git_snapshot"], scopes: ["workspace"], official: true },
  { id: "office", name: "Office 导出", desc: "把 Markdown 导出为 docx / pptx / xlsx。", version: "0.8.2", tools: ["export_office"], scopes: ["workspace"], official: true },
  { id: "calendar", name: "日历", desc: "读写设备日历，安排评审与提醒。", version: "0.5.0", tools: ["calendar_write"], scopes: ["device"], official: false },
];

function pluginSearchSheet() {
  const installed = new Set(state.plugins.map((p) => p.id));
  const list = CATALOG.filter(
    (p) => !ui.pluginQuery || (p.name + p.desc).toLowerCase().includes(ui.pluginQuery.toLowerCase())
  );
  return sheetFrame({
    title: "查找插件",
    desc: "从官方索引安装；安装后立即进入当前上下文。",
    body: `
      <div class="input-suffix" style="margin-bottom:10px">
        <input class="input" id="catalog-search" placeholder="搜索插件" value="${esc(ui.pluginQuery)}" autocomplete="off">
        <span class="icon-btn" style="pointer-events:none">${icon("search", "icon--sm")}</span>
      </div>
      <div id="catalog-list">
        ${
          list.length
            ? list
                .map(
                  (p) => `
          <div class="plugin-card">
            <span class="avatar" style="width:34px;height:34px">${icon("puzzle", "icon--sm")}</span>
            <div class="plugin-card__main">
              <div class="plugin-card__top">
                <span class="plugin-card__name">${esc(p.name)}</span>
                ${p.official ? '<span class="tag">官方</span>' : '<span class="tag">社区</span>'}
              </div>
              <p class="plugin-card__desc">${esc(p.desc)}</p>
              <div class="plugin-card__tags"><span class="tag">v${p.version}</span>${p.tools.map((t) => `<span class="tag">${t}</span>`).join("")}</div>
            </div>
            ${
              installed.has(p.id)
                ? `<span class="tag tag--on">已安装</span>`
                : `<button class="btn btn--sm btn--ghost" data-act="install-plugin" data-id="${p.id}">安装</button>`
            }
          </div>`
                )
                .join("")
            : `<div class="empty-line">没有匹配的插件</div>`
        }
      </div>`,
  });
}

function automationSheet() {
  return sheetFrame({
    title: "新建定时任务",
    desc: "到点后 Agent 会在后台完整跑一遍，并留下轨迹。",
    body: `
      <div class="field">
        <label class="field__label" for="au-name">名称</label>
        <input class="input" id="au-name" placeholder="例如：每日销售数据汇总" autocomplete="off">
      </div>
      <div class="field">
        <label class="field__label" for="au-prompt">任务指令</label>
        <textarea class="input" id="au-prompt" rows="4" placeholder="例如：每天 9:00 整理工作区里的笔记，生成一份待办清单。"></textarea>
      </div>
      <div class="field">
        <span class="field__label">计划</span>
        <div class="segmented" id="au-schedule">
          <button class="segmented__item" data-act="pick-schedule" data-value="每天 09:00" aria-pressed="true">每天 09:00</button>
          <button class="segmented__item" data-act="pick-schedule" data-value="每周五 18:00" aria-pressed="false">每周五 18:00</button>
          <button class="segmented__item" data-act="pick-schedule" data-value="每小时" aria-pressed="false">每小时</button>
        </div>
      </div>`,
    foot: `<button class="btn btn--ghost" data-act="close-sheet" style="flex:1">取消</button><button class="btn btn--primary" data-act="create-automation" style="flex:1.4">创建</button>`,
  });
}

let draftSchedule = "每天 09:00";

function automationDetailSheet(data) {
  const a = state.automations.find((x) => x.id === data.id);
  if (!a) return sheetFrame({ title: "任务不存在", body: "" });
  return sheetFrame({
    title: esc(a.name),
    desc: `${esc(a.schedule)} · ${a.enabled ? "运行中" : "已暂停"}`,
    body: `
      <div class="card" style="margin-bottom:14px">
        <p class="card__sub" style="font-size:12px">${esc(a.prompt)}</p>
      </div>
      <div class="kv"><span>状态</span><b>${a.enabled ? "已启用" : "已暂停"}</b></div>
      <div class="kv"><span>下次运行</span><b>${a.nextRun ? new Date(a.nextRun).toLocaleString("zh-CN", { hour12: false }) : "—"}</b></div>
      <div class="kv"><span>上次运行</span><b>${a.lastRun ? fmtRelative(a.lastRun) : "尚未运行"}</b></div>
      <div class="section-label">执行历史</div>
      ${
        a.history.length
          ? a.history
              .map(
                (h) => `<div class="run-row">
            <span class="run-row__status"></span>
            <div class="run-row__main">
              <div class="run-row__title">${esc(h.summary)}</div>
              <div class="run-row__sub">${new Date(h.ts).toLocaleString("zh-CN", { hour12: false })} · ${fmtClock(h.duration)}</div>
            </div>
            <span class="tag tag--on">成功</span>
          </div>`
              )
              .join("")
          : `<p class="field__hint">还没有执行记录。</p>`
      }`,
    foot: `
      <button class="btn btn--danger" data-act="delete-automation" data-id="${a.id}" style="flex:1">删除</button>
      <button class="btn btn--primary" data-act="run-automation" data-id="${a.id}" style="flex:1.4">立即运行</button>`,
  });
}

function confirmSheet(data) {
  return sheetFrame({
    title: esc(data.title || "确认操作"),
    desc: data.desc || "",
    body: `<p class="field__hint" style="line-height:1.7">${esc(data.detail || "此操作不可撤销。")}</p>`,
    foot: `<button class="btn btn--ghost" data-act="close-sheet" style="flex:1">取消</button>
           <button class="btn ${data.danger ? "btn--danger" : "btn--primary"}" data-act="confirm-yes" style="flex:1.3">${esc(data.confirmText || "确认")}</button>`,
  });
}

function sessionMenuSheet() {
  const s = activeSession();
  return sheetFrame({
    title: "会话",
    desc: s ? esc(s.title) : "还没有会话",
    body: `
      ${s && s.messages.length ? `<button class="menu__item" data-act="trace" style="width:100%">${icon("clock", "icon--sm")}<span>查看运行轨迹</span></button>` : ""}
      <button class="menu__item" data-act="goto-workspace" style="width:100%">${icon("folder", "icon--sm")}<span>打开工作区</span></button>
      <button class="menu__item" data-act="rename-session" style="width:100%">${icon("edit", "icon--sm")}<span>重命名会话</span></button>
      <button class="menu__item" data-act="fork-session" style="width:100%">${icon("layers", "icon--sm")}<span>分叉会话</span><small>FORK</small></button>
      <button class="menu__item" data-act="export-session" style="width:100%">${icon("download", "icon--sm")}<span>导出会话 JSON</span></button>
      <button class="menu__item" data-act="clear-session" style="width:100%">${icon("refresh", "icon--sm")}<span>清空消息</span></button>
      <button class="menu__item menu__item--danger" data-act="delete-session-current" style="width:100%">${icon("trash", "icon--sm")}<span>删除会话</span></button>`,
  });
}

function renameSheet() {
  const s = activeSession();
  return sheetFrame({
    title: "重命名会话",
    body: `<div class="field"><label class="field__label" for="rn-title">标题</label>
      <input class="input" id="rn-title" value="${esc(s?.title || "")}" maxlength="40"></div>`,
    foot: `<button class="btn btn--ghost" data-act="close-sheet" style="flex:1">取消</button>
           <button class="btn btn--primary" data-act="rename-confirm" style="flex:1.3">保存</button>`,
  });
}

/* ---------------- 抽屉 ---------------- */

function renderDrawer() {
  els.drawer.innerHTML = renderDrawerHTML(ui.search || "");
}

function pushLayer() {
  if (ui.layer) return;
  ui.layer = true;
  try {
    history.pushState({ dshLayer: true }, "");
  } catch {
    ui.layer = false;
  }
}

function dropLayer() {
  if (!ui.layer) return;
  ui.layer = false;
  history.back();
}

function openDrawer() {
  renderDrawer();
  ui.drawer = true;
  els.drawer.dataset.open = "true";
  els.scrim.dataset.open = "true";
  pushLayer();
}

function closeDrawer(fromHistory = false) {
  ui.drawer = false;
  els.drawer.dataset.open = "false";
  els.scrim.dataset.open = "false";
  if (!fromHistory) dropLayer();
}

/* ---------------- 事件 ---------------- */

function bindEvents() {
  els.app.addEventListener("click", onClick);

  // 输入法组合输入：期间冻结输入框的样式改动，结束后一次性补齐
  els.app.addEventListener("compositionstart", (e) => {
    if (e.target.id === "composer-input") ui.composing = true;
  });
  els.app.addEventListener("compositionend", (e) => {
    if (e.target.id !== "composer-input") return;
    ui.composing = false;
    ui.draft = e.target.value;
    autoGrow();
    updateSendState();
  });

  // 部分安卓输入法（键盘内组合）上屏时不派发 input 事件，
  // 聚焦期间做 400ms 轻轮询兜底，保证发送键状态跟手
  let composerPoll = null;
  els.app.addEventListener("focusin", (e) => {
    if (e.target.id !== "composer-input" || composerPoll) return;
    composerPoll = setInterval(updateSendState, 400);
  });
  els.app.addEventListener("focusout", (e) => {
    if (e.target.id === "composer-input" && composerPoll) {
      clearInterval(composerPoll);
      composerPoll = null;
    }
  });

  els.app.addEventListener("input", (e) => {
    const t = e.target;

    if (t.id === "cm-model-filter") {
      filterFormModels(t.value);
      return;
    }

    if (t.id === "composer-input") {
      if (t.value === "/" && !ui.composing) {
        t.value = "";
        ui.draft = "";
        updateSendState();
        openSheet("commands");
        return;
      }
      // 自愈：事件流显示组合已结束但标志未复位时，纠正过来
      if (ui.composing && e.isComposing === false) ui.composing = false;
      // 组合输入期间只记值：不动高度、不重绘按钮，避免打断输入法
      ui.draft = t.value;
      if (!ui.composing) autoGrow();
      scheduleSendState();
      return;
    }

    if (t.id === "session-search") {
      ui.search = t.value;
      const q = t.value.trim().toLowerCase();
      els.drawer.querySelectorAll(".session-item").forEach((item) => {
        item.style.display = item.textContent.toLowerCase().includes(q) ? "" : "none";
      });
      return;
    }

    if (t.id === "catalog-search") {
      ui.pluginQuery = t.value;
      const box = $("#catalog-list");
      if (!box) return;
      const q = t.value.trim().toLowerCase();
      box.querySelectorAll(".plugin-card").forEach((card) => {
        card.style.display = card.textContent.toLowerCase().includes(q) ? "" : "none";
      });
      return;
    }

    if (t.dataset.providerKey) {
      const slot = t.dataset.providerKey;
      setSettings({ keys: { ...state.settings.keys, [slot]: t.value } });
      if (slot === providerKeyOf() && ui.view === "chat") renderMain(true);
      return;
    }

    if (t.dataset.keyField) {
      const slot = providerKeyOf();
      setSettings({ keys: { ...state.settings.keys, [slot]: t.value } });
      return;
    }

    if (t.dataset.set) {
      const key = t.dataset.set;
      if (key === "model" || key === "contextWindow") return;
      setSettings({ [key]: t.value });
      return;
    }
  });

  els.app.addEventListener("change", (e) => {
    const t = e.target;

    // 表单内直接填 Key：存下并立刻拉取可用模型
    if (t.id === "cm-key") {
      const slot = $("#cm-provider")?.value || "custom";
      setSettings({ keys: { ...state.settings.keys, [slot]: t.value.trim() } });
      if (t.value.trim()) runFormModelFetch({ force: true });
      return;
    }

    // 手填 / 修改模型 ID：已知模型自动带出真实上下文窗口
    if (t.id === "cm-model") {
      const kc = knownModelCtx(t.value);
      const ctxInput = $("#cm-ctx");
      if (kc > 0 && ctxInput) ctxInput.value = String(Math.round(kc / 1000));
      return;
    }

    if (t.dataset.cmProvider) {
      const meta = PROVIDER_META[t.value] || PROVIDER_META.custom;
      const base = $("#cm-base");
      if (base && meta.baseUrl) base.value = meta.baseUrl;
      const ctx = $("#cm-ctx");
      if (ctx && meta.defaultCtx) ctx.value = String(Math.round(meta.defaultCtx / 1000));
      const hint = $("#cm-provider")?.closest(".field")?.querySelector(".field__hint");
      if (hint) hint.textContent = meta.desc;
      const sg = $("#cm-suggest");
      if (sg) {
        sg.innerHTML = `${(meta.suggest || []).map((m) => {
          const id = typeof m === "string" ? m : m.id;
          const mctx = typeof m === "string" ? null : m.ctx;
          const note = typeof m === "string" ? "" : m.note || "";
          return `<button class="chip" data-act="pick-suggest-model" data-value="${esc(id)}"${mctx ? ` data-ctx="${mctx}"` : ""}>${esc(note || (mctx ? `${id} · ${fmtContext(mctx)}` : id))}</button>`;
        }).join("")}`;
      }
      const scenes = $("#cm-scenes");
      if (scenes) {
        scenes.innerHTML = `${(meta.endpoints || []).length ? '<span class="eyebrow">端点场景</span>' : ""}${(meta.endpoints || [])
          .map((e) => `<button class="chip" data-act="pick-scene" data-url="${esc(e.baseUrl)}">${esc(e.label)}</button>`)
          .join("")}`;
      }
      const nextKey = keyOf(t.value);
      const keyInput = $("#cm-key");
      if (keyInput) keyInput.value = nextKey;
      if (nextKey) {
        setTimeout(() => {
          if (ui.sheet?.type === "custom-model") runFormModelFetch({ force: true });
        }, 80);
      } else {
        const box = $("#cm-models");
        if (box) box.innerHTML = `<p class="field__hint">填上这个服务的 API Key，就会自动列出可用模型。</p>`;
      }
      const modelInput = $("#cm-model");
      if (modelInput && meta.suggest?.length) {
        modelInput.placeholder = typeof meta.suggest[0] === "string" ? meta.suggest[0] : meta.suggest[0]?.id || "";
      }
      return;
    }

    if (t.dataset.keyField || t.dataset.providerKey) {
      const slot = t.dataset.providerKey || providerKeyOf();
      allModels()
        .filter((m) => providerKeyOf(m) === slot)
        .forEach((m) => setModelStatus(m.id, null));
      if (ui.view === "settings") renderMain(true);
      return;
    }

    if (!t.dataset.set) return;

    if (t.dataset.set === "model") {
      applyModelSelection(t.value);
      return;
    }

    if (t.dataset.set === "contextWindow") {
      const k = Math.max(4, Math.min(2000, Number(t.value) || 128));
      setSettings({ contextWindow: Math.round(k * 1000) });
      t.value = String(k);
      if (ui.view === "settings") renderMain(true);
      return;
    }

    setSettings({ [t.dataset.set]: t.value });
  });

  // 图片查看器在最上层：Esc 直接关它（焦点可能不在 app 内）
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && ui.imageViewer) {
      e.preventDefault();
      closeImageViewer();
    }
  });

  els.app.addEventListener("keydown", (e) => {
    const isComposing = e.isComposing || e.keyCode === 229;
    if (e.target.id === "composer-input" && e.key === "Enter" && !e.shiftKey && !isComposing) {
      // 组合中的回车留给输入法确认候选；只有真正提交后的回车才发送
      e.preventDefault();
      if (ui.run) return;
      const value = composerValue().trim();
      if (value || ui.attachments.length) sendMessage(value);
    }
    if (e.key === "Enter" && e.target.dataset?.modelField) {
      e.preventDefault();
      applyCurrentModelFields();
    }
    if (e.key === "Escape") {
      if (ui.imageViewer) closeImageViewer();
      else if (ui.sheet && ui.sheet.dismissible) closeSheet();
      else if (ui.drawer) closeDrawer();
    }
  });

  els.scrim.addEventListener("click", () => closeDrawer());

  window.addEventListener("popstate", () => {
    // dropLayer() 自己触发的回退不参与处理，避免关掉抽屉后又把页面退回对话
    if (!ui.layer) return;
    ui.layer = false;
    if (ui.sheet?.dismissible) {
      closeSheet(true, true);
    } else if (ui.sheet && !ui.sheet.dismissible) {
      // 审批面板不允许被系统返回键直接关闭
      pushLayer();
    } else if (ui.drawer) {
      closeDrawer(true);
    } else if (!settingsBack() && ui.view !== "chat") {
      navigate("chat");
    }
  });

  els.app.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList?.contains("session-item")) {
      e.preventDefault();
      e.target.click();
    }
  });
}

/* ---------------- 模型参数读写 ---------------- */

function readModelForm() {
  const label = $("#cm-label")?.value.trim() || "";
  const apiModel = $("#cm-model")?.value.trim() || "";
  const baseUrl = $("#cm-base")?.value.trim().replace(/\/+$/, "") || "";
  const ctxK = Math.max(4, Math.min(2000, Number($("#cm-ctx")?.value) || 128));
  const tempRaw = $("#cm-temp")?.value.trim();
  const maxRaw = $("#cm-max")?.value.trim();
  const temperature = tempRaw === "" ? null : Math.max(0, Math.min(2, Number(tempRaw)));
  const maxTokens = maxRaw === "" ? null : Math.max(0, Math.min(131072, Math.round(Number(maxRaw))));
  const supportsEffort =
    $("#sheet-layer [data-toggle='cm-effort']")?.getAttribute("aria-checked") === "true";
  const vision = $("#sheet-layer [data-toggle='cm-vision']")?.getAttribute("aria-checked") === "true";
  return { label, apiModel, baseUrl, ctx: Math.round(ctxK * 1000), temperature, maxTokens, supportsEffort, vision };
}

function modelFromForm(id) {
  const f = readModelForm();
  const existing = id ? allModels().find((m) => m.id === id) : null;
  const slot = $("#cm-provider")?.value || existing?.providerKey || "custom";
  const meta = PROVIDER_META[slot] || PROVIDER_META.custom;
  return {
    id: id || "__draft__",
    label: f.label || "未命名模型",
    apiModel: f.apiModel,
    baseUrl: f.baseUrl,
    ctx: f.ctx,
    provider: meta.name,
    providerKey: slot,
    custom: true,
    ...f,
    __draft: true,
  };
}

async function runModelTest(id, candidate, boxSelector) {
  const box = $(boxSelector);
  if (box) {
    box.innerHTML = `<p class="field__hint" style="display:flex;align-items:center;gap:6px">${icon("loader", "icon--sm icon--loader")} 正在连接…</p>`;
  }
  try {
    const model = candidate || allModels().find((m) => m.id === id);
    if (!model) throw new Error("找不到这个模型");
    const r = await testModel(model);
    if (box) {
      box.innerHTML = `<div class="model-test model-test--ok">${icon("check", "icon--sm")}
        <div><b>连接成功 · ${fmtClock(r.ms)}</b><p>${esc(r.model)} · ${esc(hostOf(r.endpoint))} · HTTP ${r.status}</p></div>
      </div>`;
    }
    toast(`连接成功 · ${fmtClock(r.ms)}`, "ok");
    return r;
  } catch (err) {
    if (box) {
      box.innerHTML = `<div class="model-test model-test--err">${icon("alert", "icon--sm")}
        <div><b>连接失败</b><p>${esc(err.message || "未知错误")}</p></div>
      </div>`;
    }
    toast(`连接失败：${err.message || "未知错误"}`, "err");
    throw err;
  }
}

/* 切换 / 保存后自动验活：成功静默，失败提示；60 秒内不重复测同一个模型 */
const verifyInflight = new Set();
async function verifyModel(id, { announce = false } = {}) {
  const model = allModels().find((m) => m.id === id);
  if (!model || verifyInflight.has(id)) return;
  if (!apiKeyFor(model)) {
    if (announce) toast("所属服务还没有 Key", "err");
    return;
  }
  const prev = modelStatusOf(id);
  if (prev?.ok && Date.now() - Number(prev.at || 0) < 60000) return;
  verifyInflight.add(id);
  try {
    const r = await testModel(model);
    if (announce) toast(`连接正常 · ${fmtClock(r.ms)}`, "ok");
  } catch (err) {
    toast(`连接失败：${err.message || "未知错误"}`, "err");
  } finally {
    verifyInflight.delete(id);
    if (ui.sheet?.type === "models") renderSheet();
    else if (ui.view === "settings") renderMain(true);
    else if (ui.view === "chat") refreshChatMeta();
  }
}

function saveModelParams(id) {
  const f = readModelForm();
  const slot = $("#cm-provider")?.value || "custom";
  const meta = PROVIDER_META[slot] || PROVIDER_META.custom;
  if (!f.apiModel || !f.baseUrl) {
    toast("模型 ID 和 Base URL 都要填", "err");
    return;
  }
  const existing = id ? allModels().find((m) => m.id === id) : null;
  const nextId = id || `cm_${Date.now().toString(36)}`;
  const raw = existing
    ? (state.settings.customModels || []).find((m) => m.id === existing.id) || {}
    : {};
  const backup = raw.backup || { ...raw };
  upsertCustomModel({
    ...raw,
    id: nextId,
    label: f.label || f.apiModel,
    apiModel: f.apiModel,
    baseUrl: f.baseUrl,
    ctx: f.ctx,
    provider: meta.name,
    providerKey: slot,
    custom: true,
    temperature: f.temperature ?? undefined,
    maxTokens: f.maxTokens ?? undefined,
    supportsEffort: f.supportsEffort || undefined,
    vision: f.vision,
    backup,
  });
  // 参数已写进条目本体，清掉旧覆盖，避免旧值遮住刚保存的值
  clearModelOverride(nextId);
  setModelStatus(nextId, null);
  setSettings({ model: nextId });
  ui.lastBuilt = null;
  renderAppbar();
  renderMain(true);
  openSheet("models");
  toast(`已保存：${f.label || f.apiModel}`, "ok");
  verifyModel(nextId, { announce: true });
}

/** 从可用清单直接建条目（可选立即切换）：用户不必记模型 ID。 */
function addModelFromCatalog(apiModel, { slot, baseUrl, activate = true } = {}) {
  const s = slot || $("#cm-provider")?.value || ui.sheet?.data?.slot || "custom";
  const meta = PROVIDER_META[s] || PROVIDER_META.custom;
  const base = String(baseUrl || $("#cm-base")?.value.trim() || meta.baseUrl || "").replace(/\/+$/, "");
  const exists = allModels().find(
    (m) => modelApiId(m) === apiModel && (m.providerKey || "custom") === s
  );
  const model =
    exists ||
    upsertCustomModel({
      id: `cm_${Date.now().toString(36)}`,
      label: apiModel,
      apiModel,
      baseUrl: base,
      ctx: knownModelCtx(apiModel) || Number(meta.defaultCtx) || 128000,
      provider: meta.name,
      providerKey: s,
      custom: true,
      supportsEffort: true,
      vision: true,
    });
  if (activate) {
    setSettings({ model: model.id });
    setModelStatus(model.id, null);
    ui.lastBuilt = null;
    renderAppbar();
    renderMain(true);
    verifyModel(model.id);
  }
  return model;
}

/* 端点可用模型探测与选择（同一端点 10 分钟内复用缓存，避免触发限流） */
const MODEL_LIST_TTL = 10 * 60 * 1000;
const modelListCache = new Map();

async function runFormModelFetch({ force = false } = {}) {
  const box = $("#cm-models");
  if (!box) return;
  const baseUrl = $("#cm-base")?.value.trim();
  const slot = $("#cm-provider")?.value || "custom";
  const key = keyOf(slot);
  if (!key) {
    box.innerHTML = `<p class="field__hint">填上这个服务的 API Key，就会自动列出可用模型。</p>`;
    return;
  }
  const cacheKey = `${slot}|${baseUrl}`;
  const cached = modelListCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.ts < MODEL_LIST_TTL) {
    renderFormModels(cached.ids, { fromCache: true });
    return;
  }
  box.innerHTML = `<p class="field__hint" style="display:flex;align-items:center;gap:6px">${icon("loader", "icon--sm icon--loader")} 正在获取模型列表…</p>`;
  try {
    const ids = await fetchModelList({ baseUrl, apiKey: key });
    modelListCache.set(cacheKey, { ids, ts: Date.now() });
    rememberModelCatalog(slot, baseUrl, ids);
    renderFormModels(ids);
    box.dataset.models = JSON.stringify(ids);
  } catch (err) {
    modelListCache.delete(cacheKey);
    box.innerHTML = `<div class="model-test model-test--err">${icon("alert", "icon--sm")}
      <div><b>没有取到模型列表</b><p>${esc(err.message || "未知错误")}</p></div></div>
      <button class="btn btn--ghost btn--sm" style="margin-top:8px" data-act="fetch-models">${icon("refresh", "icon--xs")} 重试</button>
      <p class="field__hint" style="margin-top:8px">不影响使用：直接点上方「常用模型」，或手动填一个 ID。</p>`;
  }
}

function renderFormModels(ids, { fromCache = false } = {}) {
  const box = $("#cm-models");
  if (!box) return;
  const count = $("#cm-models-count");
  if (count) count.textContent = `${ids.length} 个可用${fromCache ? " · 已缓存" : ""}`;
  box.innerHTML = `
    <input class="input" id="cm-model-filter" placeholder="筛选模型…" autocomplete="off" spellcheck="false" style="margin:6px 0 8px">
    <div class="cm-model-list">
      ${ids
        .map((m) => {
          const kc = knownModelCtx(m);
          return `<button class="chip" data-act="pick-detected-model" data-value="${esc(m)}"${kc ? ` data-ctx="${kc}"` : ""}>${esc(m)}</button>`;
        })
        .join("")}
    </div>`;
  const current = $("#cm-model")?.value.trim();
  if (current) {
    box.querySelectorAll(".cm-model-list .chip").forEach((chip) => {
      if (chip.dataset.value === current) chip.classList.add("chip--accent");
    });
  }
}

function filterFormModels(keyword) {
  const box = $("#cm-models");
  if (!box) return;
  const q = String(keyword || "").trim().toLowerCase();
  box.querySelectorAll(".cm-model-list .chip").forEach((chip) => {
    chip.style.display = !q || chip.dataset.value.toLowerCase().includes(q) ? "" : "none";
  });
}

function applyCurrentModelFields({ silent = false } = {}) {
  const m = currentModel();
  const baseUrl = $("#set-base")?.value.trim().replace(/\/+$/, "") || "";
  const apiModel = $("#set-api")?.value.trim() || "";
  const ctxK = Math.max(4, Math.min(2000, Number($("#set-ctx")?.value) || 0));
  if (!baseUrl || !apiModel) {
    toast("Base URL 和模型 ID 都不能为空", "err");
    return false;
  }
  if (!ctxK) {
    toast("上下文窗口至少 4K", "err");
    return false;
  }
  const def = m.defaults || {};
  saveModelOverride(m.id, {
    baseUrl: baseUrl !== String(def.baseUrl || "") ? baseUrl : undefined,
    apiModel: apiModel !== String(def.apiModel || "") ? apiModel : undefined,
    ctx: Math.round(ctxK * 1000) !== Number(def.ctx) ? Math.round(ctxK * 1000) : undefined,
  });
  setModelStatus(m.id, null);
  if (!silent) {
    renderMain(true);
    toast(`已保存 ${m.label} 的参数；建议测试一次连接`, "ok");
  }
  return true;
}

async function onClick(e) {
  const target = e.target.closest("[data-act]");
  if (!target) return;
  const act = target.dataset.act;
  const id = target.dataset.id;
  const value = target.dataset.value;

  // 防止抽屉里的删除按钮同时触发打开会话
  if (act === "delete-session") e.stopPropagation();

  switch (act) {
    case "noop":
      return;

    case "tab":
      navigate(target.dataset.view);
      return;

    case "open-drawer":
      openDrawer();
      return;

    case "close-drawer":
      closeDrawer();
      return;

    case "open-settings":
      closeDrawer();
      closeSheet();
      navigate("settings");
      renderAppbar();
      renderTabbar();
      return;

    case "back":
      navigate("chat");
      return;

    case "new-session":
      createSession({ mode: state.settings.mode });
      setComposerValue("");
      ui.lastBuilt = null;
      closeDrawer();
      closeSheet();
      if (ui.view !== "chat") navigate("chat");
      else {
        renderAppbar();
        renderMain(true);
      }
      setTimeout(() => $("#composer-input")?.focus(), 220);
      return;

    case "open-session":
      switchSession(id);
      ui.lastBuilt = null;
      closeDrawer();
      if (ui.view !== "chat") navigate("chat");
      else {
        renderAppbar();
        renderMain(true);
      }
      return;

    case "resume":
      switchSession(id);
      ui.lastBuilt = null;
      renderAppbar();
      renderMain(true);
      return;

    case "delete-session": {
      e.stopPropagation();
      const s = state.sessions.find((x) => x.id === id);
      openSheet("confirm", {
        title: "删除会话？",
        desc: s?.title,
        detail: "会话及其全部消息会从本机删除，工作区文件不受影响。",
        danger: true,
        confirmText: "删除",
      });
      ui.confirmAction = () => {
        deleteSession(id);
        ui.lastBuilt = null;
        renderMain(true);
        renderDrawer();
        closeSheet();
        toast("会话已删除");
      };
      return;
    }

    case "delete-session-current": {
      const s = activeSession();
      if (!s) return;
      openSheet("confirm", {
        title: "删除当前会话？",
        desc: s.title,
        detail: "会话及其全部消息会从本机删除，工作区文件不受影响。",
        danger: true,
        confirmText: "删除",
      });
      ui.confirmAction = () => {
        deleteSession(s.id);
        ui.lastBuilt = null;
        renderMain(true);
        renderDrawer();
        closeSheet();
      };
      return;
    }

    case "confirm-yes":
      ui.confirmAction?.();
      ui.confirmAction = null;
      return;

    case "session-menu":
      openSheet("session-menu");
      return;

    case "rename-session":
      openSheet("rename-session");
      return;

    case "rename-confirm": {
      const val = $("#rn-title")?.value.trim();
      const s = activeSession();
      if (s && val) {
        s.title = val;
        save();
        renderAppbar();
      }
      closeSheet();
      return;
    }

    case "clear-session": {
      const s = activeSession();
      if (!s) return;
      s.messages = [];
      save();
      ui.lastBuilt = null;
      closeSheet();
      renderMain(true);
      renderDrawer();
      toast("已清空上下文");
      return;
    }

    case "quick":
      // 通用「填入预设提示词」能力：只填输入框，由用户确认后再发送，避免误触直接跑一段预设提示词。
      // 首页的推荐问题已移除，这里保留入口以备其它地方复用。
      closeDrawer();
      closeSheet();
      setComposerValue(String(target.dataset.prompt || ""));
      navigate("chat");
      renderMain(true);
      setTimeout(() => $("#composer-input")?.focus(), 180);
      toast("已填入输入框，点发送开始");
      return;

    case "send":
      if (ui.run) stopRunAction();
      else if (ui.composing) toast("先让输入法确认候选，再点发送");
      else {
        const value = composerValue().trim();
        if (value || ui.attachments.length) sendMessage(value);
      }
      return;

    case "scroll-bottom": {
      const sc = $("#chat-scroll");
      if (sc) sc.scrollTop = sc.scrollHeight;
      ui.pinned = true;
      return;
    }

    case "load-earlier": {
      // 渲染窗口往前扩一批：一次 60 条，避免一次全量又把内存顶爆
      const s = activeSession();
      if (!s) return;
      const cur = ui.renderFrom ?? Math.max(0, s.messages.length - RENDER_WINDOW);
      ui.renderFrom = Math.max(0, cur - RENDER_WINDOW);
      releaseThumbs($("#messages"));
      updateMessages();
      return;
    }

    case "toggle-tool": {
      if (ui.toolOpen.has(id)) ui.toolOpen.delete(id);
      else ui.toolOpen.add(id);
      updateMessages();
      return;
    }

    case "toggle-reason": {
      if (ui.reasoningOpen.has(id)) ui.reasoningOpen.delete(id);
      else ui.reasoningOpen.add(id);
      updateMessages();
      return;
    }

    case "trace":
      openSheet("trace", { id: id || undefined });
      return;

    case "approval-allow":
      resolveApproval(true, false);
      return;

    case "approval-always":
      resolveApproval(true, true);
      return;

    case "approval-deny":
      resolveApproval(false, false);
      return;

    case "close-sheet":
      closeSheet();
      return;

    case "open-mode":
      closeSheet();
      openSheet("mode");
      return;

    case "open-model":
      closeSheet();
      openSheet("model");
      return;

    case "open-account":
      openSheet("account");
      return;

    case "open-provider":
      openSheet("provider", { slot: target.dataset.slot || "deepseek" });
      return;

    case "open-models":
      openSheet("models");
      return;

    case "new-custom-model":
      openSheet("custom-model");
      return;

    case "edit-model":
    case "edit-custom-model":
      openSheet("custom-model", { id: target.dataset.id });
      return;

    case "reset-model": {
      const id = target.dataset.id;
      const raw = (state.settings.customModels || []).find((m) => m.id === id);
      if (raw?.backup) {
        upsertCustomModel({ ...raw.backup, id });
      }
      clearModelOverride(id);
      setModelStatus(id, null);
      ui.lastBuilt = null;
      renderMain(true);
      openSheet("custom-model", { id });
      toast("已恢复到最初保存的参数");
      return;
    }

    case "test-model": {
      const id = target.dataset.id;
      const row = target.closest(".model-manage");
      if (row) row.dataset.testing = "true";
      runModelTest(id, null, "#model-test-result")
        .catch(() => {})
        .finally(() => {
          if (row) row.dataset.testing = "false";
          if (ui.sheet?.type === "models") renderSheet();
          else if (ui.view === "chat") renderMain(true);
        });
      return;
    }

    case "test-current-model":
      runModelTest(currentModel().id, null, "#model-test-result").catch(() => {}).finally(() => {
        if (ui.view === "settings") renderMain(true);
        else refreshChatMeta();
      });
      return;

    case "test-model-form": {
      const candidate = modelFromForm(target.dataset.id || "");
      runModelTest(candidate.id, candidate, "#model-form-test").catch(() => {});
      return;
    }

    case "save-model-params":
    case "save-custom-model":
      saveModelParams(target.dataset.id || "");
      return;

    case "fetch-models":
      runFormModelFetch({ force: true });
      return;

    case "pick-detected-model": {
      const picking = target.dataset.value || "";
      // 新建：点一下即加入并切换，不用再点保存
      if (!ui.sheet?.data?.id) {
        addModelFromCatalog(picking, { activate: true });
        openSheet("models");
        toast(`已切换到 ${picking}`);
        return;
      }
      const input = $("#cm-model");
      if (input) {
        input.value = picking;
        input.focus();
      }
      // 已知模型自动带出真实上下文窗口
      const kc = Number(target.dataset.ctx) || knownModelCtx(picking);
      if (kc > 0) {
        const ctxInput = $("#cm-ctx");
        if (ctxInput) ctxInput.value = String(Math.round(kc / 1000));
      }
      document.querySelectorAll(".cm-model-list .chip").forEach((chip) => {
        chip.classList.toggle("chip--accent", chip === target);
      });
      return;
    }

    case "use-catalog-model": {
      const apiModel = target.dataset.value || "";
      addModelFromCatalog(apiModel, { slot: target.dataset.slot, activate: true });
      openSheet("models");
      toast(`已切换到 ${apiModel}`);
      return;
    }

    case "pick-scene": {
      const base = $("#cm-base");
      if (base && target.dataset.url) base.value = target.dataset.url;
      document.querySelectorAll("#cm-scenes .chip").forEach((chip) => {
        chip.classList.toggle("chip--accent", chip === target);
      });
      return;
    }

    case "fill-known-ctx": {
      const kc = Number(target.dataset.ctx);
      const ctxInput = $("#set-ctx");
      if (kc > 0 && ctxInput) {
        ctxInput.value = String(Math.round(kc / 1000));
        toast(`已填入 ${fmtContext(kc)}，记得点「保存参数」生效`);
      }
      return;
    }

    case "pick-suggest-model": {
      const picking = target.dataset.value || "";
      if (!ui.sheet?.data?.id) {
        addModelFromCatalog(picking, { activate: true });
        openSheet("models");
        toast(`已切换到 ${picking}`);
        return;
      }
      const input = $("#cm-model");
      if (input) {
        input.value = picking;
        input.focus();
      }
      const ctx = Number(target.dataset.ctx);
      if (ctx > 0) {
        const ctxInput = $("#cm-ctx");
        if (ctxInput) ctxInput.value = String(Math.round(ctx / 1000));
      }
      return;
    }

    case "toggle-cm-effort": {
      const btn = target.closest("[data-toggle='cm-effort']") || target;
      const on = btn.getAttribute("aria-checked") === "true";
      btn.setAttribute("aria-checked", String(!on));
      return;
    }

    case "toggle-cm-vision": {
      const btn = target.closest("[data-toggle='cm-vision']") || target;
      const on = btn.getAttribute("aria-checked") === "true";
      btn.setAttribute("aria-checked", String(!on));
      return;
    }

    case "toggle-hud": {
      const on = !state.settings.hudEnabled;
      if (nativeHudAvailable()) {
        if (on && !hudPermissionGranted()) {
          try {
            window.DshHud.requestPermission();
          } catch {
            /* ignore */
          }
          toast("请在系统设置中授予悬浮窗权限，返回后再打开");
          return;
        }
      }
      hudLastJson = ""; // 开关变化必须触发重绘
      setSettings({ hudEnabled: on });
      renderMain(ui.view !== "chat");
      hudSync();
      toast(on ? "悬浮状态窗已开启" : "悬浮状态窗已关闭", "ok");
      return;
    }

    case "request-hud-permission":
      if (nativeHudAvailable()) {
        try {
          window.DshHud.requestPermission();
        } catch {
          /* ignore */
        }
      }
      return;

    case "request-battery-exemption": {
      // 「允许后台耗电」：弹系统面板让用户把应用加进"忽略电池优化"白名单
      if (!requestBatteryExemption()) {
        toast("当前系统不支持自动跳转，请到系统设置里手动放行", "err");
        return;
      }
      toast("请在系统弹窗中选择「允许」");
      return;
    }

    case "open-battery-settings": {
      if (!openBatterySettings()) {
        toast("无法打开系统省电设置页", "err");
        return;
      }
      return;
    }

    case "open-autostart-settings": {
      if (!openAutoStartSettings()) {
        toast("该系统没有独立的自启动设置，可在「系统省电策略设置」里一并放行", "err");
        return;
      }
      return;
    }

    case "connect-model":
      closeSheet();
      navigate("settings");
      renderAppbar();
      renderTabbar();
      setTimeout(() => $("#set-key")?.focus(), 260);
      return;

    case "delete-custom-model": {
      const m = allModels().find((x) => x.id === target.dataset.id);
      if (!m) return;
      openSheet("confirm", {
        title: "删除这个模型？",
        desc: m.label,
        detail: "只会删除本机的模型配置，不会影响服务商那边。",
        danger: true,
        confirmText: "删除",
      });
      ui.confirmAction = () => {
        removeCustomModel(m.id);
        ui.lastBuilt = null;
        renderAppbar();
        renderMain(true);
        openSheet("models");
        toast("模型已删除");
      };
      return;
    }

    case "toggle-provider-key": {
      const input = $("#provider-key");
      if (input) input.type = input.type === "password" ? "text" : "password";
      return;
    }

    case "clear-provider-key": {
      const slot = target.dataset.slot;
      const meta = PROVIDER_META[slot];
      openSheet("confirm", {
        title: `清除 ${meta.name} 的 Key？`,
        desc: "这会影响使用该服务的所有模型。",
        detail: "Key 只存在本机，清除后无法恢复。",
        danger: true,
        confirmText: "清除",
      });
      ui.confirmAction = () => {
        setSettings({ keys: { ...state.settings.keys, [slot]: "" } });
        renderAppbar();
        if (ui.view === "chat") renderMain(true);
        openSheet("account");
        toast("已清除 Key");
      };
      return;
    }

    case "test-provider": {
      const slot = target.dataset.slot;
      const box = $("#provider-test");
      if (box) box.innerHTML = `<p class="field__hint">测试中…</p>`;
      testProvider(slot)
        .then((r) => {
          if (box) box.innerHTML = `<p class="field__hint" style="color:var(--ok)">连接正常 · ${esc(r.model)} · ${r.ms} ms</p>`;
        })
        .catch((err) => {
          if (box) box.innerHTML = `<p class="field__hint" style="color:var(--danger)">${esc(err.message || "测试失败")}</p>`;
        });
      return;
    }

    case "deepseek-balance": {
      const box = $("#balance-result");
      const key = keyOf("deepseek");
      if (!key) {
        toast("先填写 DeepSeek 的 Key", "err");
        return;
      }
      if (box) box.innerHTML = `<p class="field__hint">查询中…</p>`;
      fetch("https://api.deepseek.com/user/balance", {
        headers: { Authorization: `Bearer ${key}` },
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((data) => {
          const info = data.balance_infos?.[0];
          if (!info) throw new Error("接口没有返回余额");
          if (box) {
            box.innerHTML = `<div class="kv" style="margin-top:8px"><span>可用余额</span><b>${esc(info.total_balance)} ${esc(info.currency)}</b></div>
              <div class="kv"><span>赠送 / 充值</span><b>${esc(info.granted_balance)} / ${esc(info.topped_up_balance)}</b></div>`;
          }
        })
        .catch((err) => {
          if (box) box.innerHTML = `<p class="field__hint" style="color:var(--danger)">查询失败：${esc(err.message)}。可能是该接口未允许跨域。</p>`;
        });
      return;
    }

    case "copy-deepseek-url": {
      const url = "https://platform.deepseek.com/api_keys";
      navigator.clipboard?.writeText(url).then(
        () => toast("链接已复制", "ok"),
        () => toast("复制失败，请手动打开", "err")
      );
      return;
    }

    case "open-workspace":
      closeSheet();
      openSheet("workspace");
      return;

    case "goto-workspace":
      closeSheet();
      navigate("workspace");
      return;

    case "set-mode": {
      setSettings({ mode: value });
      const s = activeSession();
      if (s) {
        s.mode = value;
        save();
      }
      closeSheet();
      renderAppbar();
      if (ui.view === "chat") {
        renderMain(true);
        toast(`已切换到${MODES[value].name}模式`);
      } else {
        renderMain(true);
        toast(`默认模式：${MODES[value].name}`);
      }
      return;
    }

    case "set-model": {
      const picked = applyModelSelection(value);
      openSheet(ui.sheet?.type === "models" ? "models" : "model");
      toast(`模型：${picked.label}`);
      return;
    }

    case "open-model-list":
      openSheet("model-list");
      return;

    case "set-permission":
      setSettings({ permission: value });
      closeSheet();
      renderAppbar();
      renderMain(true);
      toast(`权限：${PERMISSIONS[value].name}`);
      return;

    case "set-approval":
      setSettings({ approval: value });
      renderMain(true);
      return;

    case "set-reasoning":
      setSettings({ reasoning: value });
      syncEffortChip(value);
      renderMain(true);
      return;

    case "toggle-reasoning":
      setSettings({ showReasoning: !state.settings.showReasoning });
      renderMain(true);
      return;

    case "max-steps": {
      const cur = Number(state.settings.maxSteps) || 24;
      const dir = Number(value) < 0 ? -1 : 1;
      // 步进随数值增大：20 以下 ±2，60 以下 ±5，再往上 ±10
      const step = cur < 30 ? 2 : cur < 60 ? 5 : 10;
      const next = Math.max(4, Math.min(100, cur + dir * step));
      setSettings({ maxSteps: next });
      renderMain(true);
      return;
    }

    case "set-theme":
      setSettings({ theme: value });
      renderMain(true);
      return;

    case "toggle-motion":
      setSettings({ motion: !state.settings.motion });
      renderMain(true);
      return;

    case "toggle-key":
      setSettings({ showKey: !state.settings.showKey });
      renderMain(true);
      return;

    case "paste-key":
      navigator.clipboard
        ?.readText()
        .then((t) => {
          if (t) {
            setSettings({ keys: { ...state.settings.keys, [providerKeyOf()]: t.trim() } });
            renderMain(true);
            toast("已从剪贴板填入", "ok");
          } else toast("剪贴板为空");
        })
        .catch(() => toast("无法读取剪贴板", "err"));
      return;

    case "test-connection":
      runTest();
      return;

    case "apply-current-model":
      applyCurrentModelFields();
      return;

    case "settings-cat": {
      const id = target.dataset.value;
      if (!id || !SETTINGS_CAT_MAP[id]) return;
      ui.settingsCat = id;
      ui.settingsScroll = null; // 进入小类从顶部开始
      renderAppbar();
      renderMain(true);
      return;
    }

    case "settings-home": {
      ui.settingsCat = null;
      ui.settingsScroll = null;
      renderAppbar();
      renderMain(true);
      return;
    }

    case "toggle-notify":
      setSettings({ notifyOnDone: !state.settings.notifyOnDone });
      renderMain(ui.view !== "chat");
      return;

    case "toggle-haptics":
      setSettings({ haptics: !state.settings.haptics });
      haptic(8);
      renderMain(ui.view !== "chat");
      return;

    case "set-timeout":
      setSettings({ requestTimeout: Number(value) || 60 });
      renderMain(ui.view !== "chat");
      toast(`请求超时：${Number(value) || 60} 秒`);
      return;

    case "set-font-scale":
      setSettings({ fontScale: Number(value) || 1 });
      applyDisplaySettings();
      renderMain(ui.view !== "chat");
      return;

    case "set-density":
      setSettings({ density: value === "compact" ? "compact" : "comfortable" });
      applyDisplaySettings();
      renderMain(ui.view !== "chat");
      return;

    case "test-notification":
      testNotification();
      return;

    case "open-diagnostics":
      openSheet("diagnostics");
      return;

    case "open-mcp":
      openSheet("mcp");
      return;

    case "new-mcp":
      openSheet("mcp-server");
      return;

    case "edit-mcp":
      openSheet("mcp-server", { id: target.dataset.id });
      return;

    case "save-mcp": {
      const server = readMcpForm(target.dataset.id || "");
      if (!server.url) {
        toast("请填写 MCP 服务器 URL", "err");
        return;
      }
      const existing = (state.settings.mcpServers || []).find((s) => s.id === server.id);
      server.tools = existing?.tools || [];
      server.lastConnectedAt = existing?.lastConnectedAt || 0;
      upsertMcpServer(server);
      openSheet("mcp");
      toast("MCP 服务器已保存", "ok");
      return;
    }

    case "test-mcp": {
      const server = readMcpForm(target.dataset.id || "");
      if (!server.url) {
        toast("请填写 MCP 服务器 URL", "err");
        return;
      }
      const box = $("#mcp-test");
      if (box) box.innerHTML = `<p class="field__hint">连接中…</p>`;
      mcpDiscover(server)
        .then((tools) => {
          server.tools = tools;
          server.lastConnectedAt = Date.now();
          upsertMcpServer(server);
          openSheet("mcp-server", { id: server.id });
          toast(`连接成功 · 发现 ${tools.length} 个工具`, "ok");
        })
        .catch((err) => {
          if (box) box.innerHTML = `<p class="field__hint" style="color:var(--danger)">${esc(err.message || "连接失败")}</p>`;
        });
      return;
    }

    case "delete-mcp": {
      const id = target.dataset.id;
      const server = (state.settings.mcpServers || []).find((s) => s.id === id);
      openSheet("confirm", {
        title: "删除这个 MCP 服务器？",
        desc: server?.name || "",
        detail: "只会删除本机配置，工具会从下一轮对话里移除。",
        danger: true,
        confirmText: "删除",
      });
      ui.confirmAction = () => {
        removeMcpServer(id);
        openSheet("mcp");
        toast("MCP 服务器已删除");
      };
      return;
    }

    case "copy-diagnostics":
      navigator.clipboard
        ?.writeText(JSON.stringify(state.diagnostics?.requests || [], null, 2))
        .then(
          () => toast("诊断 JSON 已复制", "ok"),
          () => toast("复制失败", "err")
        );
      return;

    case "clear-diagnostics":
      state.diagnostics = { requests: [] };
      save(true);
      renderSheet();
      toast("请求日志已清空");
      return;

    case "clear-all-keys": {
      openSheet("confirm", {
        title: "清除所有服务的 Key？",
        desc: "DeepSeek / OpenAI / Moonshot / 自定义都会被清空。",
        detail: "会话、文件与插件配置会保留；清除后需要重新填 Key 才能使用真实模型。",
        danger: true,
        confirmText: "全部清除",
      });
      ui.confirmAction = () => {
        setSettings({ keys: { deepseek: "", openai: "", moonshot: "", custom: "" } });
        renderAppbar();
        renderMain(true);
        toast("所有 Key 已清除");
      };
      return;
    }

    case "export-workspace": {
      toast("正在打包…");
      try {
        const files = {};
        for (const meta of listFiles()) {
          const doc = await readDoc("workspace", meta.path);
          files[meta.path] = {
            path: meta.path,
            content: doc.content,
            encoding: doc.encoding === "base64" ? "base64" : undefined,
            mime: doc.mime,
            size: doc.size,
            updatedAt: meta.updatedAt,
          };
        }
        downloadJSON(`dsh-workspace-${new Date().toISOString().slice(0, 10)}.json`, {
          version: 1,
          exportedAt: new Date().toISOString(),
          files,
        });
        toast("工作区已导出", "ok");
      } catch (err) {
        toast(err.message || "导出失败", "err");
      }
      return;
    }

    case "import-workspace": {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json,.json";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const data = JSON.parse(await file.text());
          const files = data.files || data;
          if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error("文件结构不对");
          openSheet("confirm", {
            title: "替换当前工作区？",
            desc: `${Object.keys(files).length} 个文件`,
            detail: "导入会覆盖同名文件并删除当前工作区里多出来的文件。建议先导出一份备份。",
            danger: true,
            confirmText: "替换",
          });
          ui.confirmAction = async () => {
            try {
              await replaceFiles(files);
              toast("工作区已导入", "ok");
              if (ui.view === "workspace") renderMain(true);
            } catch (err) {
              toast(err.message || "导入失败", "err");
            }
          };
        } catch (err) {
          toast(`导入失败：${err.message}`, "err");
        }
      };
      input.click();
      return;
    }

    case "export-all":
      downloadJSON(`dsh-backup-${new Date().toISOString().slice(0, 10)}.json`, state);
      toast("已导出全部数据", "ok");
      return;

    case "reset-all":
      openSheet("confirm", {
        title: "重置应用？",
        desc: "所有会话、文件、插件配置都会清除。",
        detail: "会恢复为首次启动时的种子内容。此操作不可撤销。",
        danger: true,
        confirmText: "重置",
      });
      ui.confirmAction = () => { resetAll(); };
      return;

    case "toggle-plugin": {
      const p = state.plugins.find((x) => x.id === id);
      if (!p) return;
      togglePlugin(id, !p.enabled);
      toast(`${p.name}${p.enabled ? "已启用" : "已停用"}`);
      renderMain(ui.view !== "chat");
      if (ui.sheet?.type === "plugin-detail") renderSheet();
      if (ui.sheet?.type === "plugin-search") renderSheet();
      return;
    }

    case "plugin-detail":
      openSheet("plugin-detail", { id });
      return;

    case "plugin-search":
      ui.pluginQuery = "";
      openSheet("plugin-search");
      return;

    case "install-plugin": {
      const p = CATALOG.find((x) => x.id === id);
      if (!p) return;
      installPlugin(p);
      toast(`已安装 ${p.name}`, "ok");
      renderSheet();
      renderMain(true);
      return;
    }

    case "uninstall-plugin": {
      state.plugins = state.plugins.filter((x) => x.id !== id);
      save();
      closeSheet();
      renderMain(true);
      toast("插件已卸载");
      return;
    }

    case "creator-mode": {
      if (state.settings.mode !== "creator") setSettings({ mode: "creator" });
      createSession({ mode: "creator" });
      ui.lastBuilt = null;
      navigate("chat");
      ui.draft = "";
      setTimeout(() => {
        sendMessage("用创造模式写一个番茄钟插件，要求能在会话里悬浮计时，25 分钟一轮。");
      }, 120);
      return;
    }

    case "attach":
      openSheet("attach");
      return;

    case "pick-phone-files": {
      if (ui.importingFiles) return;
      ui.importingFiles = true;
      if (ui.sheet?.type === "attach") renderSheet();
      try {
        const added = await importToWorkspace();
        if (!added.length) {
          toast("没有选择文件");
        } else {
          let n = 0;
          for (const f of added) {
            const before = ui.attachments.length;
            addAttachment({ path: f.path, name: f.path.split("/").pop(), size: f.size });
            if (ui.attachments.length > before) n += 1;
          }
          // 直接进对话框：关掉面板，让用户看到附件已经挂在输入框上方
          closeSheet();
          $("#composer-input")?.focus();
          toast(n ? `已添加 ${n} 个文件到这条消息` : "这些文件已经在附件里了", n ? "ok" : "");
        }
      } catch (err) {
        const msg = err.message || "导入失败";
        if (/取消/.test(msg)) toast("已取消");
        else toast(msg, "err");
      } finally {
        ui.importingFiles = false;
        // 失败/取消时面板还开着，要重绘把"正在导入…"状态解掉
        if (ui.sheet?.type === "attach") renderSheet();
      }
      return;
    }

    case "preview-attachment": {
      const path = target.dataset.path;
      const name = target.dataset.name || path.split("/").pop();
      const area = target.dataset.area === "library" ? "library" : "workspace";
      if (!path) return;
      if (isImagePath(path)) openImageViewer(path, name, area);
      else openSheet("file", { path, area });
      return;
    }

    case "close-image-viewer":
      closeImageViewer();
      return;

    case "attach-file": {
      const path = target.dataset.path;
      const area = target.dataset.area === "library" ? "library" : "workspace";
      const list = area === "library" ? listLibrary() : listFiles();
      const meta = list.find((f) => f.path === path);
      addAttachment({ path, name: path.split("/").pop(), size: meta?.size || 0, area });
      closeSheet();
      $("#composer-input")?.focus();
      return;
    }

    case "remove-attachment": {
      const i = Number(target.dataset.index);
      if (Number.isInteger(i) && i >= 0) ui.attachments.splice(i, 1);
      refreshAttachmentStrip();
      if (ui.sheet?.type === "attach") renderSheet();
      return;
    }

    case "download-file": {
      const path = target.dataset.path;
      try {
        await exportDoc("workspace", path);
        toast("已保存");
      } catch (err) {
        toast(err.message || "保存失败", "err");
      }
      return;
    }

    case "mention-file": {
      const path = target.dataset.path;
      const base = composerValue();
      setComposerValue(`${base}${base && !base.endsWith(" ") ? " " : ""}@${path} `);
      closeSheet();
      $("#composer-input")?.focus();
      return;
    }

    case "commands":
      openSheet("commands");
      return;

    case "voice":
      startVoice();
      return;

    case "new-file":
      closeSheet();
      openSheet("new-file");
      return;

    case "create-file": {
      const path = $("#nf-path")?.value.trim();
      const content = $("#nf-content")?.value || "";
      if (!path) {
        toast("请填写路径", "err");
        return;
      }
      try {
        await writeFile(path, content);
        closeSheet();
        renderMain(true);
        toast(`已创建 ${path}`, "ok");
      } catch (err) {
        toast(err.message, "err");
      }
      return;
    }

    case "open-file":
      closeImageViewer();
      openSheet("file", { path: target.dataset.path, area: target.dataset.area || "workspace" });
      return;

    case "ws-tab":
      ui.workspaceTab = target.dataset.value === "library" ? "library" : "workspace";
      renderAppbar();
      renderMain(true);
      return;

    case "import-library": {
      if (ui.importing) return;
      ui.importing = true;
      toast("正在导入…");
      try {
        const added = await importToLibrary();
        toast(added.length ? `已导入 ${added.length} 个文件到资料库` : "没有选择文件", added.length ? "ok" : "err");
        ui.workspaceTab = "library";
        renderAppbar();
        renderMain(true);
      } catch (err) {
        toast(err.message || "导入失败", "err");
      } finally {
        ui.importing = false;
      }
      return;
    }

    case "save-to-library": {
      const path = target.dataset.path;
      try {
        const saved = await saveToLibrary(path);
        toast(`已存入资料库：${saved}`, "ok");
        closeSheet(true);
        renderMain(true);
      } catch (err) {
        toast(err.message || "存入失败", "err");
      }
      return;
    }

    case "delete-library-file": {
      const path = target.dataset.path;
      openSheet("confirm", {
        title: "移出资料库？",
        desc: path,
        detail: "只从资料库删除，工作区里的同名文件不受影响。",
        danger: true,
        confirmText: "移出",
      });
      ui.confirmAction = async () => {
        try {
          await deleteFromLibrary(path);
          closeSheet();
          renderMain(true);
          toast("已移出资料库");
        } catch (err) {
          toast(err.message || "删除失败", "err");
        }
      };
      return;
    }

    case "export-file": {
      const area = target.dataset.area === "library" ? "library" : "workspace";
      const path = target.dataset.path;
      try {
        await exportDoc(area, path);
        toast("已保存");
      } catch (err) {
        toast(err.message || "保存失败", "err");
      }
      return;
    }

    case "delete-file": {
      const path = target.dataset.path;
      openSheet("confirm", {
        title: "删除文件？",
        desc: path,
        detail: "文件会从工作区移除，此操作不可撤销。",
        danger: true,
        confirmText: "删除",
      });
      ui.confirmAction = async () => {
        try {
          await deleteFile(path);
          closeSheet();
          renderMain(true);
          toast("文件已删除");
        } catch (err) {
          toast(err.message || "删除失败", "err");
        }
      };
      return;
    }

    case "workspace-info":
      openSheet("workspace");
      return;

    case "toggle-automation": {
      const a = state.automations.find((x) => x.id === id);
      if (a) toggleAutomation(id, !a.enabled);
      renderMain(true);
      toast(`${a?.name || "任务"}${a?.enabled ? "已暂停" : "已启用"}`);
      return;
    }

    case "run-automation": {
      const a = state.automations.find((x) => x.id === id);
      if (!a) return;
      a.lastRun = Date.now();
      a.history.unshift({
        ts: Date.now(),
        status: "ok",
        duration: 18000 + Math.round(Math.random() * 30000),
        summary: "手动触发 · 已完成",
      });
      save();
      closeSheet();
      renderMain(true);
      toast("已在后台启动", "ok");
      return;
    }

    case "new-automation":
      draftSchedule = "每天 09:00";
      openSheet("new-automation");
      return;

    case "pick-schedule": {
      draftSchedule = value;
      const seg = $("#au-schedule");
      seg?.querySelectorAll(".segmented__item").forEach((b) => {
        b.setAttribute("aria-pressed", String(b.dataset.value === value));
      });
      return;
    }

    case "create-automation": {
      const name = $("#au-name")?.value.trim();
      const prompt = $("#au-prompt")?.value.trim();
      if (!name || !prompt) {
        toast("名称和指令都要填", "err");
        return;
      }
      addAutomation({ name, prompt, schedule: draftSchedule, cron: "0 9 * * *" });
      closeSheet();
      renderMain(true);
      toast("定时任务已创建", "ok");
      return;
    }

    case "automation-detail":
      openSheet("automation-detail", { id });
      return;

    case "delete-automation":
      deleteAutomation(id);
      closeSheet();
      renderMain(true);
      toast("定时任务已删除");
      return;

    case "stop-run":
      stopRun(id);
      renderMain(true);
      toast("任务已停止");
      return;

    case "fork-session": {
      const s = activeSession();
      if (!s) return;
      forkSession(s.id);
      ui.lastBuilt = null;
      closeSheet();
      renderAppbar();
      renderMain(true);
      renderDrawer();
      toast("已分叉为新会话", "ok");
      return;
    }

    case "export-session": {
      const s = activeSession();
      if (s) downloadJSON(`dsh-session-${s.id}.json`, s);
      closeSheet();
      toast("会话已导出", "ok");
      return;
    }

    case "scroll-bottom":
      return;

    case "noop2":
      return;

    default:
      return;
  }
}

/* ---------------- 辅助动作 ---------------- */

function startVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    toast("此设备不支持语音输入", "err");
    return;
  }
  const rec = new SR();
  rec.lang = "zh-CN";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (e) => {
    const text = e.results[0][0].transcript;
    setComposerValue(`${composerValue()}${text}`);
  };
  rec.onerror = () => toast("语音识别失败", "err");
  rec.start();
  toast("正在听…");
}

/* ---------------- 悬浮状态窗快照 ---------------- */

let hudCueSeq = 0;
/** 打一次性动画事件点：小球跳一下 / 摇头叹息 / 被打叉。 */
function hudCue(kind) {
  ui.hudCue = { kind, seq: ++hudCueSeq };
  hudSync();
}

const HUD_LIMIT_RE = /429|限流|rate.?limit|too many/i;

function hudSnapshot() {
  const run = ui.run;
  let status = "idle";
  let statusText = "空闲中";
  let step = "";
  let look = "idle";
  if (run) {
    const session = state.sessions.find((x) => x.id === run.sessionId);
    const msg = session?.messages.find((m) => m.id === run.msgId);
    if (msg) {
      const tools = msg.tools || [];
      const activeTool = [...tools].reverse().find((t) => t.status === "running" || t.status === "waiting");
      if (activeTool) {
        status = "tool";
        statusText = `正在执行：${activeTool.name}`;
        step = `STEP ${msg.steps || 1} · ${activeTool.name}`;
        look = "tool";
      } else if (msg.reasoning && !msg.content) {
        status = "thinking";
        statusText = "正在深度思考…";
        step = `STEP ${msg.steps || 1}`;
        look = "thinking";
      } else if (msg.content) {
        status = "replying";
        statusText = "正在回复…";
        step = `STEP ${msg.steps || 1}`;
        look = "plain";
      }
    }
  }
  // 审批中：小球进入 attention 姿态（头顶 ! + 敲头晃动）
  if (ui.approval) {
    look = "permission";
    if (status === "idle") {
      status = "waiting";
      statusText = "等待审批…";
    }
  }
  // 刚完成：保持片刻 done（笑眼 + 双鳍三连扇）
  if (!run && !ui.approval && ui.hudDoneUntil && Date.now() < ui.hudDoneUntil) {
    status = "done";
    statusText = "完成了";
    look = "done";
  }
  const sessions = state.sessions
    .filter((x) => x.messages.some((m) => m.status === "running"))
    .slice(0, 4)
    .map((x) => {
      const m = x.messages.find((mm) => mm.status === "running");
      const tool = [...(m.tools || [])].reverse().find((t) => t.status === "running");
      return {
        title: x.title || "会话",
        state: tool ? `正在执行 ${tool.name}` : m.reasoning && !m.content ? "深度思考" : m.content ? "回复中" : "运行中",
      };
    });
  const tasks = state.runs
    .filter((r) => r.status === "running" || r.status === "queued")
    .slice(0, 3)
    .map((r) => ({ title: r.title, progress: r.status === "done" ? 100 : r.progress || 0 }));
  // 一次性事件：进快照即消费，seq 保证 JSON 有差异、不会被 diff 吞掉
  const cue = ui.hudCue;
  ui.hudCue = null;
  const badge = ui.hudBadge && Date.now() < ui.hudBadge.until ? ui.hudBadge.kind : null;
  return {
    status,
    statusText,
    step,
    sessions,
    tasks,
    look,
    event: cue ? cue.kind : null,
    cueSeq: cue ? cue.seq : hudCueSeq,
    badge,
  };
}

let hudTimer = null;
let hudLastJson = "";
function hudSync() {
  try {
    const snap = hudSnapshot();
    const json = JSON.stringify(snap);
    if (json === hudLastJson) return; // 无变化不重绘
    hudLastJson = json;
    hudRender(snap, !!state.settings.hudEnabled);
  } catch {
    /* 快照失败不影响主流程 */
  }
}
function startHudLoop() {
  if (hudTimer) return;
  hudTimer = setInterval(hudSync, 1200);
  hudSync();
}

async function runTest() {
  const btn = $("#test-btn");
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = `${icon("loader", "icon--sm")} 正在连接…`;
  try {
    const r = await testConnection();
    if (ui.view === "settings") renderMain(true);
    const fresh = $("#test-result");
    if (fresh) {
      fresh.innerHTML = `<div class="model-test model-test--ok">${icon("check", "icon--sm")}
        <div><b>连接成功 · ${fmtClock(r.ms)}</b><p>${esc(r.model)} · ${esc(hostOf(r.endpoint))} · HTTP ${r.status}</p></div>
      </div>`;
    }
    toast("连接成功", "ok");
  } catch (err) {
    if (ui.view === "settings") renderMain(true);
    const fresh = $("#test-result");
    if (fresh) {
      fresh.innerHTML = `<div class="model-test model-test--err">${icon("alert", "icon--sm")}
        <div><b>连接失败</b><p>${esc(err.message || "未知错误")}</p></div>
      </div>`;
    }
    toast(`连接失败：${err.message || "未知错误"}`, "err");
  } finally {
    const again = $("#test-btn");
    if (again) {
      again.disabled = false;
      again.innerHTML = `${icon("bolt", "icon--sm")} 测试连接`;
    }
  }
}

function downloadJSON(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function toast(message, kind = "") {
  if (els.toast.querySelector(`[data-text="${CSS.escape(message)}"]`)) return;
  const el = document.createElement("div");
  el.dataset.text = message;
  el.className = `toast ${kind ? `toast--${kind}` : ""}`;
  el.innerHTML = `${kind === "ok" ? icon("check", "icon--xs") : kind === "err" ? icon("alert", "icon--xs") : ""}<span>${esc(message)}</span>`;
  els.toast.appendChild(el);
  while (els.toast.children.length > 2) els.toast.firstElementChild.remove();
  setTimeout(() => {
    el.style.transition = "opacity .25s ease, transform .25s ease";
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    setTimeout(() => el.remove(), 260);
  }, 2400);
}
