/* ============================================================
   UI — 应用外壳、路由、对话流、面板与事件代理
   ============================================================ */

import {
  state,
  subscribe,
  save,
  emit,
  createSession,
  setSessionPreset,
  switchSession,
  deleteSession,
  forkSession,
  addMessage,
  activeSession,
  setSettings,
  setNodePlugins,
  setNodePluginsDiag,
  setWatchStatus,
  togglePlugin,
  installPlugin,
  toggleAutomation,
  addAutomation,
  deleteAutomation,
  stopRun,
  currentMode,
  currentModel,
  upsertCustomModel,
  addCustomModels,
  modelFormat,
  removeCustomModel,
  upsertMcpServer,
  removeMcpServer,
  saveSessionNow,
  flushSessionNow,
  replaceFiles,
  sessionFileCount,
  orphanWorkspaceInfo,
  purgeOrphanWorkspace,
  resetAll,
  MODES,
  PRESETS,
  PROVIDERS,
  PROVIDER_COUNT,
  knownModelCtx,
  knownModelVision,
  rememberModelCatalog,
  catalogFor,
  catalogItemsFor,
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
import { normalizeApiKey } from "./apikeys.js";
import { isTextPath } from "./fs.js";
import { isImagePath, imageMime, prepareThumb, prepareImage } from "./image.js";
import { renderMarkdown, plainText } from "./markdown.js";
import { availableToolNames, forgetShellCwd } from "./tools.js";
import { searchOfficialPlugins } from "./plugin-manifest.js";
import {
  inspectPlugin,
  installPluginPackage,
  uninstallPlugin,
  setPluginEnabled,
} from "./plugin-install.js";
import {
  mountEffortSlider,
  effortIndex,
  effortName,
  effortColor,
} from "./effort-slider.js";
import { fmtContext } from "./context.js";
import { runAgent, testConnection, testProvider, testModel, fetchModelList, spawnSubagentOnce, promptStats } from "./runtime.js";
import { FORMAT_IDS, FORMAT_LABELS, FORMAT_SHORT, FORMAT_HINTS, FORMATS, normalizeFormat } from "./formats.js";
import { mcpDiscoverWithRetry } from "./mcp.js";
import { downloadBase64 } from "./office.js";
import { hudRender, hudPermissionGranted, nativeHudAvailable } from "./hud.js";
import { DshBall } from "./dsh-ball.js";
import {
  keepAliveStart,
  keepAliveStop,
  requestBatteryExemption,
  openBatterySettings,
  openAutoStartSettings,
} from "./keep-alive.js";
import {
  listAll as listMemories,
  remove as removeMemory,
  clearAll as clearMemories,
  stats as memoryStats,
  memoryBudget,
  MEMORY_TYPES,
} from "./memory.js";
import {
  localMcpAvailable,
  localStatus,
  localServerConfig,
  setServerEnabled,
  restartServer,
  addAllowed,
  removeAllowed,
  getAllowedPackages,
  openAppInfoSettings,
  requestShizukuPermission,
  connectShizuku,
  openShizukuApp,
  isPointerMarkEnabled,
  setPointerMarkEnabled,
} from "./mcp-local.js";
import { SAFETY_RULES } from "./safety.js";
import {
  listIndex as listTrajIndex,
  trajStats as trajStats,
  setOutcome as setTrajOutcome,
  removeTrajectory as removeTrajectory,
  clearTrajectories as clearTrajectories,
  searchTrajectories as searchTrajectories,
  exportCorpus as exportTrajCorpus,
} from "./traj.js";
import { nodeBridgeAvailable, nodeStatus, nodeStart, nodeStop, nodeDownload, nodePing, nodeCall, nodeLogTail, nodeReloadPlugin, nodeReloadPlugins, nodeOnEvent, nodeUiAction, nodeUiSnapshot, nodeWatchPlugins, nodeWatchStatus } from "./node-runtime.js";
import {
  attach as uiAttach,
  listMounts as uiListMounts,
  mount as uiMount,
  setActionSink as uiSetActionSink,
  unmount as uiUnmountMount,
  unmountPlugin as uiUnmountPluginMounts,
  update as uiUpdateMount,
} from "./ui-host.js";
import { refreshNodeTools, loadNewNodePlugins, nodePluginDetail } from "./node-plugins.js";
import { syncNodeLlmModels, isNodeLlmModel } from "./llm-bridge.js";
import {
  installNodePlugin,
  uninstallNodePlugin,
  depCacheStats,
  clearDepCache,
} from "./plugin-install-node.js";
import {
  loadCatalog,
  npmTarballUrl,
  clearCatalogCache,
  inspectPackage,
  pluginIdOf,
  formatAgo,
} from "./plugin-catalog.js";
import {
  openImeSettings,
  switchIme,
  savePhrase,
  deletePhrase,
  clearClipboard,
} from "./ime.js";
import { syncIndex } from "./store.js";
import {
  startVoice,
  stopVoice,
  cancelVoice,
  voiceState,
  onVoiceEvent,
  requestVoicePermission,
  voiceDownloadModel,
} from "./voice.js";
import {
  renderHome,
  renderWorkspace,
  renderPlugins,
  renderMarketList,
  renderMarketFilters,
  renderTasks,
  renderSettings,
  SETTINGS_CAT_MAP,
  renderDrawer as renderDrawerHTML,
  setVoiceDownload,
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
  // 组合输入的最近一次事件时刻：用来识别「compositionend 丢失」的残留标志
  composingAt: 0,
  sheetTimer: null,
  confirmAction: null,
  testing: false,
  testResult: null,
  lastBuilt: null,
  renderFrom: null, // 渲染窗口起点（消息下标）
  workspaceTab: "workspace",
  pluginsTab: "node",   // 插件页三类：node（跑在 Node 里）/ market（发现）/ page（页面内沙箱）
  /**
   * 插件市场的运行时状态。
   *
   * 不落盘：目录 2.5 MB，写进 state 会被整包序列化，还会污染工作区。
   * 缓存只活在内存里，30 分钟过期（见 plugin-catalog 的 TTL）。
   */
  market: {
    loading: false,
    error: "",
    note: "",
    items: [],
    at: 0,
    query: "",
    category: "",
    limit: 40,
    /**
     * 正在装的那个插件：{ name, stage, done, total }。
     *
     * 依赖多的插件要装一两分钟。只在面板里滚一行字不够 ——
     * 用户会以为没在下载。卡片里要有进度条和「12/59」。
     */
    installing: null,
  },
  /** 刚装好的插件 id：用来在已安装列表里高亮那一行，几秒后自动消失。 */
  highlightPlugin: "",
  /** 依赖缓存占用：{ count, bytes }。装在应用数据目录，用户看不见，所以给它一行数。 */
  depCache: null,
  attachments: [],   // 待随消息发送的附件 [{path,name,size}]
  msgNodes: new Map(), // 消息 id -> DOM，供增量渲染复用
  imageViewer: false,  // 图片查看器是否打开（返回键优先关它）
  settingsCat: null,
  pluginQuery: "",
  pluginUrl: "",
  pluginInspect: null,
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
  initVoiceUi();
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

  // IME 主机接线：给 scripts/ime.js 提供两个页面级钩子。
  // 之所以走钩子而不是直接 import，是为了不让 ime.js 依赖 ui.js 的内部实现 ——
  // ui.js 有 7000 多行，内部函数随时会重构，钩子层更稳。
  window.__dshAddAttachment = (item) => receiveImeAttachment(item);
  window.__dshSendImeShot = () => sendMessage("请看这张截图。");
  wireUiHost();
  wirePluginWatch();
  startNodeRuntime();
  startNodePoll();
}

/**
 * 启动 Node 插件运行时。
 *
 * 用户选择的是"装了插件就自动起"，所以这里不等用户操作。
 * 但延迟 1.2 秒：Node 启动要先解压运行时目录、再拉进程，
 * 和首屏第一帧抢 CPU 会让冷启动肉眼可见地变慢。
 *
 * ============ 关键：没装运行时就不启动，也不下载 ============
 *
 * 运行时是 88 MB。应用启动时自动下载它，等于用户什么都没干
 * 就被吃掉 88 MB 流量和 88 MB 存储。所以这里只判断"装没装"，
 * 装了就起，没装就安静地等用户去设置页点下载。
 */
function startNodeRuntime() {
  if (!nodeBridgeAvailable()) return; // 浏览器 / PWA：没有原生桥，不假装支持
  if (state.settings.nodeEnabled === false) return;
  setTimeout(() => {
    const st = nodeStatus();
    if (!st.available) {
      console.warn("[node] 运行时不可用：", st.reason || st.error || "原生库未加载");
      return;
    }
    if (!st.installed) {
      // 没装：等用户在设置里点「下载运行时」
      console.info("[node] 运行时未下载，等待用户手动下载");
      return;
    }
    if (!st.running) nodeStart();
  }, 1200);
}

/**
 * 从 Node 运行时同步插件清单到界面状态。
 *
 * 清单来自 Node —— 它才是真正加载了插件的那一方。
 * 页面这边的 state.plugins 只管 iframe 插件，两套分开。
 */
/**
 * 拉一次插件目录（有缓存就不拉）。
 *
 * 失败不抛给用户看堆栈 —— 目录是外部资源，网络不通很正常，
 * 界面上给一句原因 + 一个重试按钮就够了。
 */
async function ensureMarketLoaded() {
  if (ui.market.loading) return;
  if (ui.market.items.length && Date.now() - ui.market.at < 30 * 60 * 1000) return;

  ui.market.loading = true;
  ui.market.error = "";
  ui.market.note = "";
  if (ui.view === "plugins" && ui.pluginsTab === "market") renderMain(true);

  try {
    const items = await loadCatalog({
      onProgress: (label, i, total) => {
        ui.market.note =
          total > 1 ? `正在试 ${label}（第 ${i + 1} / ${total} 个来源）` : `正在试 ${label}`;
        // 只刷列表块，别整页重绘 —— 搜索框在页面上，重绘会丢焦点
        if (ui.view === "plugins" && ui.pluginsTab === "market") paintMarket();
      },
    });
    ui.market.items = items;
    ui.market.at = Date.now();
  } catch (e) {
    ui.market.error = String((e && e.message) || e);
  } finally {
    ui.market.loading = false;
    ui.market.note = "";
    if (ui.view === "plugins" && ui.pluginsTab === "market") renderMain(true);
  }
}

/**
 * 只重绘市场里的分类条与列表。
 *
 * 不能整页重绘：搜索框在页面里，重绘会丢焦点 —— 用户打字打到一半
 * 光标就跳走了。
 */
function paintMarket() {
  const filters = $("#market-filters");
  if (filters) filters.innerHTML = renderMarketFilters(ui.market);
  const list = $("#market-list");
  if (list) list.innerHTML = renderMarketList(ui.market);
}

/**
 * 问一下依赖缓存占了多少。
 *
 * 缓存装在应用数据目录，用户在文件管理器里看不见 —— 所以至少要在
 * 插件页给出一个数字，并且给个清空的办法。
 */
async function refreshDepCache() {
  try {
    ui.depCache = await depCacheStats();
  } catch {
    ui.depCache = null;
  }
}

async function syncNodePluginList() {
  if (!nodeBridgeAvailable()) return;
  const st = nodeStatus();
  if (!st.channelConnected) return;
  try {
    const r = await nodeCall("plugins.list", {});
    setNodePlugins(Array.isArray(r?.plugins) ? r.plugins : []);
    // 目录诊疗：列表为空时界面要靠它说清楚卡在哪一步
    setNodePluginsDiag(r?.diagnostics || null);
  } catch {
    /* 读不到就保持原样，不清空 —— 免得界面闪一下 */
  }
}

/**
 * 轮询 Node 运行时状态。
 *
 * ============ 为什么需要轮询 ============
 *
 * 语音模型的下载进度是原生侧主动 push 事件的（onVoiceEvent），
 * 但 Node 运行时的下载是纯原生状态 —— 没有事件通道。
 * 所以这里用低频轮询把「正在下载 42%」反映到设置页上。
 *
 * 频率 1 秒：88 MB 的下载要一两分钟，1 秒一跳足够看清在动，
 * 又不至于每秒都重绘整页（那会卡）。
 *
 * 只在设置页且状态有变化时才重绘。
 */
let nodePollTimer = null;
let nodePollLast = "";

function startNodePoll() {
  if (nodePollTimer) return;
  nodePollTimer = setInterval(() => {
    if (!nodeBridgeAvailable()) return;
    const st = nodeStatus();
    // 只有这几个字段变化时才需要重绘
    const key = `${st.available}|${st.installed}|${st.downloading}|${st.running}|${st.percent}|${st.channelConnected}|${st.runtimeError || ""}`;
    if (key === nodePollLast) return;
    const wasConnected = nodePollLast.split("|")[6] === "true";
    nodePollLast = key;
    // 通道刚连上 → 拉一次插件清单（Node 起来时插件已经加载好了）
    if (st.channelConnected && !wasConnected) {
      syncNodePluginList();
      // Node 侧的模型供应方这时也注册好了 → 同步进手机端模型表
      syncNodeLlmModels();
      // 插件可能已经往界面上挂了东西 —— 拉一次快照把它们贴回来。
      // 页面被系统杀掉重开时，Node 进程往往还活着、挂载也还在，
      // 不拉的话用户会看到「插件明明在跑，界面却是空的」。
      syncNodeUiMounts();
      // 监听是"页面要求"才开的：Node 不知道用户的设置。
      // 通道刚连上这一刻，按设置决定开不开。
      if (state.settings.pluginWatch) applyPluginWatch(true);
    }
    if (ui.view === "settings") renderMain(true);
  }, 1000);
}

/* ---------------- 插件界面宿主 ---------------- */

/**
 * 接上界面宿主。
 *
 * 两件事：
 *   1. 页面上的点击 → 转发给 Node 里的插件
 *   2. Node 里的 mount/update/unmount → 落到 DOM
 *
 * 为什么要单独一层而不是让 ui-host 自己发通道：
 * ui-host 是纯渲染器，不认识 Node。让它保持"给树就画"，
 * 才能在测试里不启动运行时也能验证渲染逻辑。
 */
function wireUiHost() {
  uiSetActionSink(async ({ mountId, action, value, name }) => {
    if (!mountId) return;
    try {
      const r = await nodeUiAction({ id: mountId, action, name, value });
      if (r && r.ok === false) {
        toast(r.error || "插件没有处理这个操作");
      }
    } catch (err) {
      // 通道断了 / 插件崩了：说清楚是哪一层出的问题。
      // 只说"操作失败"，用户会以为是自己点错了。
      toast(`插件没有响应：${err?.message || err}`);
    }
  });

  nodeOnEvent((event, data) => {
    if (!event || event.slice(0, 3) !== "ui.") return;
    if (event === "ui.mount") {
      const r = uiMount(data || {});
      if (!r.ok) {
        console.warn("[ui-host] 挂载被拒：", r.error);
        return;
      }
      uiAttach(); // 当前视图里如果有对应占位符，立刻画出来
      return;
    }
    if (event === "ui.update") {
      uiUpdateMount(data?.id, data?.tree);
      return;
    }
    if (event === "ui.unmount") {
      uiUnmountMount(data?.id);
    }
  });
}

/**
 * 拉一次全量界面快照。
 *
 * 通道刚连上、或页面被系统重建后调用：Node 里的挂载还在，
 * 这台设备上的 DOM 却是新的。不拉就永远是空的。
 */
async function syncNodeUiMounts() {
  if (!nodeBridgeAvailable()) return;
  try {
    const list = await nodeUiSnapshot();
    if (!Array.isArray(list) || !list.length) return;
    // 先清掉旧的：页面重建前挂的可能已经在别处删掉了
    uiListMounts().forEach((m) => uiUnmountMount(m.id));
    list.forEach((m) => uiMount(m));
    uiAttach();
  } catch (err) {
    // 快照失败不影响主流程 —— 插件自己重新 apply 时还会再挂一次
    console.warn("[ui-host] 拉取界面快照失败：", err?.message || err);
  }
}

/* ---------------- 自动重载 ---------------- */

/**
 * 订阅自动重载的推送。
 *
 * 重载成功要**静默**：用户正在写代码，每次保存都弹一个提示很烦。
 * 只有失败才说话 —— 失败时插件可能是坏的，必须让人知道。
 */
function wirePluginWatch() {
  nodeOnEvent((event, data) => {
    if (!event || event.slice(0, 6) !== "watch.") return;

    if (event === "watch.reloaded") {
      // 工具表 / 清单都可能变了，刷新一次
      syncNodePluginList();
      refreshNodeTools().catch(() => {});
      nodeWatchStatus()
        .then((st) => setWatchStatus(st))
        .catch(() => {});
      if (ui.view === "plugins" || ui.view === "settings") renderMain(true);
      return;
    }

    if (event === "watch.error") {
      const who = data?.id ? `「${data.id}」` : "";
      toast(`自动重载失败${who}：${data?.error || "未知原因"}`);
      nodeWatchStatus()
        .then((st) => setWatchStatus(st))
        .catch(() => {});
      if (ui.view === "settings") renderMain(true);
      return;
    }

    if (event === "watch.unloaded") {
      syncNodePluginList();
      refreshNodeTools().catch(() => {});
      if (ui.view === "plugins") renderMain(true);
      return;
    }

    if (event === "watch.state") {
      nodeWatchStatus()
        .then((st) => setWatchStatus(st))
        .catch(() => {});
    }
  });
}

/**
 * 按设置打开 / 关闭目录监听。
 *
 * 关的时候直接调 —— 不关的话监听会一直挂着，直到进程退出。
 */
async function applyPluginWatch(on) {
  if (!nodeBridgeAvailable()) return;
  const st = nodeStatus();
  if (!st.channelConnected) return;
  try {
    const r = await nodeWatchPlugins(on);
    setWatchStatus(r?.status || null);
  } catch (err) {
    toast(`插件监听开启失败：${err?.message || err}`);
  }
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

/** 全量重绘（切主题、切会话、重置后都会走这里）。导出供测试验证重渲染后的状态一致性。 */
export function renderAll() {
  renderAppbar();
  renderTabbar();
  renderMain(true);
  renderDrawer();
}

function renderAppbar() {
  const s = activeSession();
  const mode = currentMode();
  const running = state.runs.some((r) => r.status === "running");

  let title = "新会话";
  let tag = "";            // 胶囊右侧的小字：模式名
  let leftIcon = "menu";
  let leftAct = "open-drawer";
  let leftLabel = "会话列表";
  let actions = "";

  if (ui.view === "chat") {
    title = s?.title || "新会话";
    // 选了工作模式就显示模式名，否则退回推理档位 —— 这一枚小字是
    // 全屏唯一能说明"你现在处在什么上下文里"的地方，得留。
    tag = (s?.preset && PRESETS[s.preset]?.name) || mode?.name || "";
    actions = `<button class="icon-btn" data-act="session-menu" aria-label="会话操作">${icon("more")}</button>`;
  } else if (ui.view === "workspace") {
    const lib = ui.workspaceTab === "library";
    title = lib ? "资料库" : "工作区";
    actions = lib
      ? `<button class="icon-btn" data-act="import-library" aria-label="导入文件">${icon("download")}</button>`
      : `<button class="icon-btn" data-act="new-file" aria-label="新建文件">${icon("plus")}</button>`;
  } else if (ui.view === "plugins") {
    title = "插件";
    actions = `<button class="icon-btn" data-act="plugin-search" aria-label="安装插件">${icon("download")}</button>`;
  } else if (ui.view === "tasks") {
    title = "任务";
    actions = `<button class="icon-btn" data-act="new-automation" aria-label="新建定时任务">${icon("plus")}</button>`;
  } else if (ui.view === "settings") {
    const cat = ui.settingsCat ? SETTINGS_CAT_MAP[ui.settingsCat] : null;
    title = cat ? cat.title : "设置";
    tag = cat ? "设置" : "";
    if (ui.settingsCat) {
      leftIcon = "arrowLeft";
      leftAct = "settings-home";
      leftLabel = "返回";
    } else {
      leftIcon = "arrowLeft";
      leftAct = "back";
      leftLabel = "返回对话";
    }
  }

  // 三栏：圆钮 / 状态胶囊 / 圆钮。中间用 grid 居中而不是 flex，
  // 这样右侧按钮多一个少一个，胶囊都不会左右漂。
  els.appbar.innerHTML = `
    <button class="icon-btn" data-act="${leftAct}" aria-label="${leftLabel}">
      ${icon(leftIcon)}${running && ui.view === "chat" ? '<span class="badge-dot badge-dot--live"></span>' : ""}
    </button>
    <div class="appbar__mid">
      ${
        ui.view === "chat"
          ? `<button class="appbar__pill" data-act="open-mode" aria-label="切换推理档位">
               <span class="dot${running ? " dot--live" : ""}" aria-hidden="true"></span>
               <b>${esc(title)}</b>
               ${tag ? `<span class="sep" aria-hidden="true"></span><em>${esc(tag)}</em>` : ""}
             </button>`
          : `<span class="appbar__pill">
               <span class="dot${running ? " dot--live" : ""}" aria-hidden="true"></span>
               <b>${esc(title)}</b>
               ${tag ? `<span class="sep" aria-hidden="true"></span><em>${esc(tag)}</em>` : ""}
             </span>`
      }
    </div>
    <div class="appbar__end">${actions}</div>`;
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

  // 离开对话页：视图只是被隐藏，画布仍在文档里，rAF 不会自己停。
  // 回到对话页时 updateMessages 会把它重新启动。
  if (ui.view !== "chat") stopHomeBall();

  // 打开会话 / 重建对话页：一律停在最新消息（底部）
  if (ui.view === "chat") {
    const sid = state.activeSessionId || "none";
    if (force || ui.lastBuilt !== sid) {
      renderChat(target, "bottom");
      ui.lastBuilt = sid;
      // 对话页刚被整块重写，占位符是新的 —— 插件界面要重新贴上去。
      // 只在重建时贴：流式输出每帧都走 updateMessages，那时贴会打断输入框焦点。
      uiAttach(target);
    } else {
      updateMessages();
    }
    return;
  }

  if (ui.view === "workspace") target.innerHTML = renderWorkspace(ui.workspaceTab);
  if (ui.view === "plugins")
    target.innerHTML = renderPlugins(ui.pluginsTab, ui.market, ui.highlightPlugin, ui.depCache);
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

  // 非对话页每次都是整块 innerHTML 重写，占位符也跟着换了一批。
  // 统一在这里贴 —— 四个挂载点里只有 shell.overlay 在对话页，
  // 但有挂载点落在设置页，这里不贴它就永远是空的。
  uiAttach(target);
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
  // ============ 输入框跨重绘复用同一个 <textarea> ============
  // 旧做法：root.innerHTML 整块重建，再 restoreDraft() 用 `el.value = ui.draft`
  // 把文字填回去。在 Android WebView 上这有两个硬伤：
  //   1. 焦点没了 —— 软键盘还开着，字却进不来，必须「点一下」输入框重新聚焦；
  //   2. JS 直接赋值 value 会让 WebView 的 InputConnection(Editable) 与 DOM
  //      值失步，光标被推到末尾，之后在句中打字全部延到句末。
  // 现在重建前把旧节点从旧树摘出来，重建后放回新树：value / selection /
  // 组合输入状态 / 输入法连接都留在同一个节点上，一个字节都不用重写。
  // 先前的 `!ui.run` 限制也去掉 —— 运行中补引导指令时同样不能丢草稿。
  const prevInput = root.querySelector("#composer-input") || document.getElementById("composer-input");
  let stash = null;
  if (prevInput && typeof prevInput.value === "string") {
    stash = {
      node: prevInput,
      focused: document.activeElement === prevInput,
      start: prevInput.selectionStart,
      end: prevInput.selectionEnd,
      scrollTop: prevInput.scrollTop,
    };
    ui.draft = prevInput.value;
    prevInput.remove(); // 先摘出，否则下面的 innerHTML 会把它连同整棵树销毁
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
      <!-- 插件界面挂载点：浮在输入区上方（通知条、状态卡这类）。
           放在 composer 之前 —— 它在布局里占一行，不会压住输入框上方的工具条。 -->
      <div class="ui-slot ui-slot--overlay" data-ui-slot="shell.overlay" hidden></div>
      ${renderComposer(s)}
    </div>`;

  if (stash) {
    const fresh = $("#composer-input");
    if (fresh) {
      // 用旧节点顶掉刚生成的新节点。textarea 本身没被销毁，
      // 输入法正在进行的组合、光标、滚动位置都原封不动。
      fresh.replaceWith(stash.node);
      if (stash.focused) {
        // 节点被搬过一次，浏览器会按「移除」处理焦点，显式还回去。
        // preventScroll 避免在软键盘弹起时把页面顶一下。
        stash.node.focus({ preventScroll: true });
        try {
          const max = stash.node.value.length;
          stash.node.setSelectionRange(
            Math.min(stash.start ?? max, max),
            Math.min(stash.end ?? max, max)
          );
        } catch {
          /* 某些输入类型不支持 setSelectionRange */
        }
      }
      stash.node.scrollTop = stash.scrollTop;
    }
  }

  ui.msgNodes = new Map(); // DOM 是全新的，旧的节点引用作废
  voiceResync(); // composer 是新建的节点，录音条与麦克风按钮要重新贴状态
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
  // 复用节点时值本来就在，绝不再写 `el.value = …`（那正是 WebView 里
  // InputConnection 与 DOM 失步、光标跳句末的来源）。只有首次创建
  // 才需要从镜像缓存把草稿填进去。
  if (!stash) restoreDraft();
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

/**
 * 「我的记忆」面板。
 *
 * 这一页是整套方案里**最不能省**的一半。
 * 记忆库如果只能写不能看，用户就无法纠正它 —— 而一份错了的记忆
 * 比没有记忆更糟：模型会拿错误的事实去「有据可依」地回答。
 *
 * 所以提供：查看 / 单条删除 / 全部清空。
 */
function memorySheet() {
  const list = listMemories();
  const st = memoryStats();
  const typeName = (t) => MEMORY_TYPES[t]?.label || "事实";
  // 注入规模体检：让「记忆库会占多少上下文」变成看得见的事实，
  // 而不是等对话变慢变贵了才反应过来
  const budget = memoryBudget("");
  const budgetLine = `<div class="diag-row"><div class="diag-row__sub">单次注入上限 ${budget.limits.maxEntries} 条 / 约 ${budget.limits.maxTokens} token · 超出部分按相关度丢弃</div></div>`;
  const body = (list.length
    ? list
        .map(
          (m) => `
        <div class="diag-row">
          <div class="diag-row__top">
            <span class="tag ${m.type === "correction" ? "tag--on" : ""}">${esc(typeName(m.type))}</span>
            <b>${esc(m.key)}</b>
            <button class="icon-btn icon-btn--sm" data-act="delete-memory" data-key="${esc(m.key)}" aria-label="删除这条记忆">${icon("trash", "icon--sm")}</button>
          </div>
          <div class="diag-row__sub">${esc(m.value)}</div>
          <div class="diag-row__sub">置信度 ${(m.confidence * 100).toFixed(0)}% · ${fmtRelative(m.updatedAt)}</div>
        </div>`
        )
        .join("")
    : `<div class="empty-line"><b>还没有任何记忆</b>记忆由对话自动积累：在对话里说出你的偏好、纠正模型的错误，或让它记录重要事实，都会被存下来。<br>这里也可以随时查看、删除或纠正它们。</div>`) + budgetLine;
  return sheetFrame({
    title: "我的记忆",
    desc: `${st.total} 条 · 档案「${esc(st.profile)}」· 只存在本机。这些内容会被注入每次对话，用来替代模型自己的猜测。`,

    body,
    foot: `<button class="btn btn--ghost" data-act="clear-memories" style="flex:1">全部清空</button>`,
  });
}

/**
 * 控屏轨迹库（0.34.0）。
 *
 * ============ 为什么这个页面不能省 ============
 *
 * 轨迹是「机器从你的操作里学到的样本」，它的价值完全取决于**准不准**。
 * 一条被误标成「成功」的轨迹，会在下次检索时被当成范例注入给模型 ——
 * 于是错误被复制，而且越用越固。
 *
 * 所以这一页必须让用户能：
 *   1. 逐条判定成功 / 失败（只有「成功」才进检索池）
 *   2. 看到原文（指令 + 动作序列 + 应用版本）
 *   3. 删掉不想要的
 *   4. **用一句中文指令现场检索**，直接看命中率
 *
 * 第 4 条是这个页面的核心：它是「中文检索到底行不行」的人肉验证器。
 */
function trajSheet() {
  const list = listTrajIndex();
  const st = trajStats();
  const query = (ui.trajQuery || "").trim();
  const hits = query ? searchTrajectories(query, { limit: 8 }) : [];

  const stats = `<div class="diag-row">
    <div class="diag-row__top">
      <span class="tag tag--on">${st.success}</span><b>已确认成功</b>
      <span class="tag">${st.pending}</span><span>待确认</span>
      <span class="tag">${st.fail}</span><span>失败</span>
    </div>
    <div class="diag-row__sub">共 ${st.total} 条 · ${st.steps} 个动作 · 只存在本机，落库前已脱敏（手机号 / 验证码 / 卡号 / 邮箱）</div>
  </div>`;

  const search = `<div class="field">
    <label class="field__label" for="traj-q">用中文指令检索</label>
    <input class="input" id="traj-q" placeholder="例如：打开微信搜一下天气" value="${esc(query)}" data-act="traj-search" autocomplete="off">
    <p class="field__hint">${
      query
        ? hits.length
          ? `命中 ${hits.length} 条（相似度 ${hits.map((h) => h.sim.toFixed(2)).join("、")}）`
          : "没有命中。只有「已确认成功」的轨迹会进检索池 —— 先在下面把轨迹标成成功。"
        : "输入一句中文，看能不能召回对应轨迹。召回不了，说明语料还不够或机制有问题。"
    }</p>
  </div>`;

  const body =
    stats +
    search +
    (list.length
      ? list
          .slice(0, 60)
          .map((e) => {
            const mark = e.outcome === "success" ? "成功" : e.outcome === "fail" ? "失败" : "待确认";
            const tagCls = e.outcome === "success" ? "tag--on" : "";
            return `<div class="diag-row">
        <div class="diag-row__top">
          <span class="tag ${tagCls}">${mark}</span>
          <b>${esc(e.instruction || "（无指令）")}</b>
        </div>
        <div class="diag-row__sub">${esc(e.app || "?")} ${esc(e.appVersion || "")} · ${e.steps} 步 · ${fmtRelative(e.ts)}${
          e.replayable === false ? " · 含裸坐标，不可回放" : ""
        }</div>
        <div class="diag-row__top" style="margin-top:6px">
          <button class="btn btn--ghost btn--sm" data-act="traj-mark" data-id="${esc(e.id)}" data-outcome="success">成功</button>
          <button class="btn btn--ghost btn--sm" data-act="traj-mark" data-id="${esc(e.id)}" data-outcome="fail">失败</button>
          <button class="icon-btn icon-btn--sm" data-act="traj-del" data-id="${esc(e.id)}" aria-label="删除">${icon("trash", "icon--sm")}</button>
        </div>
      </div>`;
          })
          .join("")
      : `<div class="empty-line"><b>还没有控屏轨迹</b>让 DSH 操作一次手机界面（读屏、点击、输入）就会自动记一条。<br>指令来自你当时说的话，所以语料天然是中文 —— 这正是它能被中文检索到的原因。</div>`);

  return sheetFrame({
    title: "控屏轨迹",
    desc: `${st.total} 条 · 每条 = 一次控屏操作的全过程。只存在本机。`,
    body,
    foot: `<button class="btn btn--ghost" data-act="export-traj" style="flex:1">导出语料</button>
           <button class="btn btn--ghost" data-act="clear-traj" style="flex:1">全部清空</button>`,
  });
}

function diagnosticsSheet() {
  const list = state.diagnostics?.requests || [];
  // 提示词体量体检：system prompt 是每轮都要重发的固定开销，
  // 得让人能看见它现在多大、哪些段被降级掉了
  const ps = promptStats();
  const dropped = ps.dropped.length ? ps.dropped.join("、") : "无";
  const promptLine = `<div class="diag-row">
    <div class="diag-row__top"><b>系统提示词体量</b><span class="mono" style="margin-left:auto">${ps.tokens} tok</span></div>
    <div class="diag-row__sub">预算 ${ps.budget} token · ${ps.sections} 段 · 已降级：${esc(dropped)}</div>
    <div class="diag-row__sub">${ps.tierTokens.map((t) => `${esc(t.id)} ${t.tokens}`).join(" · ")}</div>
  </div>`;
  const body =
    (list.length
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
          ${e.hint ? `<details style="margin-top:6px"><summary class="field__hint" style="cursor:pointer;color:var(--accent)">排查建议</summary><pre style="white-space:pre-wrap;word-break:break-word;margin:8px 0 0;padding:9px 10px;background:var(--soft);border-radius:7px;font:11px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)">${esc(e.hint)}</pre></details>` : ""}
        </div>`
          )
          .join("")
      : `<div class="empty-line"><b>还没有请求记录</b>配置 Key 后发起一次真实模型请求，这里会记录端点、模型、状态、耗时与 token。<br>未连接模型时不会产生请求。</div>`) + promptLine;
  return sheetFrame({
    title: "请求日志",
    desc: `最近 ${list.length} 次真实请求；只存在本机，不含 Key 与会话正文。`,
    body,
    foot: `<button class="btn btn--ghost" data-act="copy-diagnostics" style="flex:1">复制 JSON</button>
           <button class="btn btn--danger" data-act="clear-diagnostics" style="flex:1">清空</button>`,
  });
}

/** 供诊断页与回归测试复用：连接状态的纯函数结论。 */
export function modelConnection(id) {
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
      st.phase === "stream"
        ? "响应中断"
        : st.status === 429
        ? "限流 · 稍后再试"
        : st.status === 401
        ? "Key 未被接受 · 401"
        : st.status === 403
        ? "无权限 · 403"
        : st.status === 402
        ? "余额不足"
        : st.status
        ? `连接失败 · ${st.status}`
        : "连接失败",
    detail:
      st.phase === "stream"
        ? `已经连上（HTTP ${st.httpStatus || 200}），但响应流中途断开：${
            st.error || "连接被中断"
          }。这通常是网络切换、代理或网关重置长连接，不是 Key 或地址的问题，重试一般就能恢复。`
        : [st.error, st.hint].filter(Boolean).join("\n\n") || "请求没有成功，点开查看诊断日志。",
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

  // 这一行只放结论，不放整解释 —— detail 往往两三句，塞进胶囊会被截成
  // 「没有填 API Key，无法对话。到「…」，读起来像报错。完整原因挂在 title 上，
  // 点整行进详情。
  const text = model ? c.label : "还没添加模型";
  const act = model
    ? c.key === "nokey"
      ? { label: "连接", act: "connect-model" }
      : { label: "测一下", act: "test-current-model" }
    : { label: "添加", act: "new-custom-model" };
  const open = model ? "edit-model" : "open-models";

  return `
    <div class="conn-note conn-note--${c.tone}">
      <button class="conn-note__main" data-act="${open}" ${model ? `data-id="${esc(model.id)}"` : ""} title="${esc(c.detail)}">
        <span class="conn-note__dot" aria-hidden="true"></span>
        <span class="conn-note__text">${esc(text)}</span>
      </button>
      <button class="conn-note__go" data-act="${act.act}">${esc(act.label)}</button>
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

  // 这一排只在「只读权限」时出现 —— 那是真正需要在每条消息旁边提醒的状态。
  // 模型缺失 / 连接失败交给上面那行 conn-note，同一件事不说两遍；
  // 模式和模型入口则收进顶栏胶囊（点一下改档位）与会话菜单。
  const empty = !s || !s.messages.length;
  const readonly = state.settings.permission === "readonly";
  if (empty || !readonly) return `<div class="chat__meta" hidden></div>`;

  const modelChip = model
    ? `<button class="chip" data-act="open-model" title="${esc(conn.detail)}">
        <span class="chip__dot ${conn.key === "ok" ? "chip__dot--ok" : conn.key === "nokey" || conn.key === "fail" ? "chip__dot--warn" : ""}"></span>
        ${esc(String(model.label || model.name || model.apiModel || model.id || "模型").replace("DeepSeek-", ""))}
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
      ${icon("bolt", "icon--xs")} ${esc(mode.name)}
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
  const mode = currentMode();
  return `
  <div class="composer-wrap">
    <!-- 插件界面挂载点：输入框上方。空的时候整块收起来，不留缝 -->
    <div class="ui-slot ui-slot--composer" data-ui-slot="composer.toolbar" hidden></div>
    <!-- 别的会话在跑：给一条可点的横条，切回来就能继续引导/停止 -->
    <button class="run-away" id="run-away" data-act="goto-run" ${ui.run && !runHere() ? "" : "hidden"}>
      <span class="run-away__dot" aria-hidden="true"></span>
      <span class="run-away__text"></span>
      <span class="run-away__go">查看</span>
    </button>
    <div class="composer">
      <div class="composer__files" id="composer-files" ${ui.attachments.length ? "" : "hidden"}>${attachmentChips()}</div>
      <div class="voice-strip" id="voice-strip" ${voiceState() === "idle" ? "hidden" : ""} aria-live="polite">
        <span class="voice-strip__dot" aria-hidden="true"></span>
        <div class="voice-strip__main">
          <div class="voice-strip__bars" id="voice-bars" aria-hidden="true">
            ${Array.from({ length: 5 }, () => '<i></i>').join("")}
          </div>
          <div class="voice-strip__text" id="voice-text">正在听…</div>
        </div>
        <button class="voice-strip__btn" data-act="voice-cancel" aria-label="取消语音输入">${icon("x", "icon--sm")}</button>
        <button class="voice-strip__btn voice-strip__btn--go" data-act="voice-stop" aria-label="结束并写入">${icon("check", "icon--sm")}</button>
      </div>
      <button class="icon-btn icon-btn--sm" data-act="attach" aria-label="添加文件">${icon("plus")}</button>
      <textarea class="composer__input" id="composer-input" rows="1" enterkeyhint="send"
        placeholder="${s && s.messages.length ? "接着说，或 / 调指令" : "描述目标，@ 引用文件"}"></textarea>
      <div class="composer__foot">
        ${state.plugins.find((p) => p.id === "voice" && p.enabled) ? `<button class="icon-btn icon-btn--sm" data-act="voice" id="voice-btn" aria-label="语音输入" aria-pressed="false">${icon("mic", "icon--sm")}</button>` : ""}
        <!-- 运行中主按钮会让位给「引导」，停止入口独立常驻，避免想停却发出一条消息 -->
        <button class="icon-btn icon-btn--sm icon-btn--stop" id="stop-live-btn" data-act="stop-live" aria-label="停止运行" ${runHere() ? "" : "hidden"}>${icon("stop", "icon--sm")}</button>
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

/**
 * 接住 DSH 键盘截回来的图。
 *
 * 键盘（IME）在别的应用里也能用，所以它截的图会从原生回到这里。
 * 默认只加为附件，不自动发 —— 用户在微信里截了图回到 DSH，
 * 看到它躺在附件区自己决定要不要发，比"截完自动弹一条消息"安静得多。
 */
export function receiveImeAttachment(item, { send = false } = {}) {
  if (!item?.path) return false;
  if (!addAttachment(item)) return false;
  if (send) {
    // 让 DOM 先刷新出附件条，再发
    requestAnimationFrame(() => sendMessage("请看这张截图。"));
  }
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
  // 运行中补的指令要能在记录里认出来：它不是一轮新提问，而是中途改口
  const tag = m.steer ? `<span class="msg__steer">引导</span>` : "";
  return `<div class="msg msg--user${m.steer ? " msg--steer" : ""}" data-msg="${m.id}"><div class="msg__bubble">${tag}${esc(m.content)}${
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
    <div class="msg__flow" hidden></div>
    <div class="msg__legacy">
      <div class="reasoning-slot"></div>
      <div class="tools-slot"></div>
      <div class="body-slot"><div class="msg__body"></div><span class="stream-caret" hidden></span></div>
    </div>
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
    m.contextPack?.compacted
      ? `<div class="msg__notice">${icon("bolt", "icon--xs")} 已压缩 ${m.contextPack.compacted} 处工具输出 · 回收约 ${Math.round(
          (m.contextPack.reclaimed || 0) / 1000,
        )}K token</div>`
      : ""
  }${
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
      <span class="reasoning__hint"></span>
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
  const slot = el.querySelector(".reasoning-slot");
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
  // 正文不再在运行时裁掉首尾空白（那会让时间线的段偏移错位），
  // 缩进交给渲染这一层处理
  const text = String(m.content || "").trim();
  if (text) return renderMarkdown(text);
  if (running) {
    const wait = {
      connecting: "正在连接模型服务…",
      waiting: "已连接，等待模型响应…",
      thinking: "模型正在思考…",
      streaming: "正在生成回答…",
      acting: "正在执行工具…",
    }[m.phase] || "正在准备…";
    return `${icon("loader", "icon--sm icon--loader")} ${wait}`;
  }
  return "";
}

function tailHtml(m, done, tools) {
  // 正在运行：一枚会动的状态标 + 计时。
  //
  // ============ 为什么需要它 ============
  //
  // 运行中原来只有「STEP 2」「正在思考…」这类**静态**文字。工具跑起来之后
  // 屏幕可能十几秒没有任何变化 —— 用户分不清"它在干活"还是"卡住了"。
  // 四格跳动的成本极低，但它回答的是最容易让人退出应用的那个问题：
  // 现在到底有没有在动。
  //
  // 秒数由 paintRunBadges 单独刷新，不参与 tail 的签名 ——
  // 否则每 0.2 秒重建一次 DOM，跳动的动画会跟着从头播，看着像在抽搐。
  const phaseLabel =
    {
      connecting: "正在连接…",
      waiting: "已连接 · 等待模型",
      thinking: "正在思考",
      streaming: "正在输出",
      acting: "执行工具中",
    }[m.phase] || "工作中";
  // 引导状态挂在运行状态标上：用户补完指令后能立刻看到「待生效」变成「已按 N 条调整」，
  // 否则输入完没有任何回执，又会以为消息没发出去。
  const steerNote =
    m.steerPending > 0
      ? ` · ${m.steerPending} 条引导待生效`
      : m.steerCount > 0
        ? ` · 已按 ${m.steerCount} 条引导调整`
        : "";
  const runBadge =
    m.status === "running"
      ? `<div class="runbadge" data-phase="${esc(m.phase || "")}" data-start="${m.startedAt || m.ts || Date.now()}" aria-label="DSH 正在工作">
           <span class="runbadge__bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
           <span class="runbadge__label">${esc(phaseLabel + steerNote)}</span>
           <span class="runbadge__time">0.0 秒</span>
         </div>`
      : "";

  // ============ 空思维链占位 ============
  //
  // 深度思考模型在服务端想 60~90 秒时，m.reasoning / m.content 都还是空的，
  // 思考区（要求 reasoning 非空）和正文都不渲染 —— 屏幕上只剩一枚"工作中"。
  // 上一轮刚经历过连接失败的用户，很自然会把这 90 秒当成又断线了。
  //
  // 这里补一张明确说"连接正常、模型在想、可能要一分钟"的卡，
  // 并且由 paintRunBadges 按等待秒数升级文案。思维链或正文一到就撤掉。
  const pending =
    m.status === "running" && !m.reasoning && !m.content && !tools.length
      ? `<div class="thinking-pending" aria-live="polite">
           <div class="thinking-pending__top">
             <span class="thinking-pending__pulse" aria-hidden="true"></span>
             <b>正在思考</b>
             <span class="thinking-pending__tag">尚未收到思维链</span>
           </div>
           <div class="thinking-pending__bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
           <div class="thinking-pending__hint" data-start="${m.startedAt || m.ts || Date.now()}"></div>
         </div>`
      : "";

  // 正在自动重试：说清楚"不是你点错了，是连接断了，我在重来"。
  // 不给按钮 —— 这时除了等，用户没有别的动作可做。
  const retry =
    m.retry && m.status === "running"
      ? `<div class="msg__notice">${icon("loader", "icon--xs icon--loader")} 连接中断，${Math.max(
          1,
          Math.round((m.retry.waitMs || 0) / 1000)
        )} 秒后重试（第 ${m.retry.attempt} 次，最多 ${m.retry.total} 次）</div>`
      : "";

  // 被系统中断：不当作错误处理，也不出"测试连接"这类误导按钮，
  // 只说明发生了什么，并给一个"继续"入口。
  if (m.interrupted) {
    const note = `<div class="msg__notice">${icon("alert", "icon--xs")} ${esc(m.error || "本次运行被系统中断。")}</div>`;
    return `${retry}${note}${
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
  return retry + err + pending + runBadge + meta;
}

/* ---------------- 运行计时（0.62.0） ----------------
 *
 * 只改 .runbadge__time 的文字，不重建结构。
 * 四格跳动是 CSS 动画，一旦 DOM 被换掉就会从第 0 帧重播 ——
 * 秒数每 0.2 秒变一次，若跟着重建，看起来就是一直在抽搐而不是在呼吸。
 *
 * 计时器只在页面上真的有运行时标时才存在，没有就自己停掉；
 * 应用切到后台也停，回来由 ensureRunClock 再拉起来。
 */
let runClockTimer = null;

/** 等待越久，话要说得越明确 —— 核心是让用户别把"在思考"误判成"没连上"。 */
function pendingHint(sec) {
  if (sec < 15) return "连接正常，模型正在组织思路…";
  if (sec < 45) return "模型正在深度思考，首个字通常较慢，请稍候。";
  if (sec < 90) return `已等待 ${Math.floor(sec)} 秒 · 连接正常，深度思考模型可能要 1 分钟以上才输出内容。`;
  return `仍在等待模型响应（${Math.floor(sec)} 秒）· 连接正常。若长时间无响应，可停止后重试或查看连接状态。`;
}

function paintRunBadges() {
  // 后台不跑：200ms 一次的定时器在后台没有任何意义，还白耗电
  if (document.hidden) {
    if (runClockTimer) {
      clearInterval(runClockTimer);
      runClockTimer = null;
    }
    return;
  }
  const nodes = document.querySelectorAll(".runbadge[data-start]");
  const hints = document.querySelectorAll(".thinking-pending__hint[data-start]");
  if (!nodes.length && !hints.length) {
    if (runClockTimer) {
      clearInterval(runClockTimer);
      runClockTimer = null;
    }
    return;
  }
  const now = Date.now();
  hints.forEach((el) => {
    const sec = Math.max(0, (now - Number(el.dataset.start)) / 1000);
    const text = pendingHint(sec);
    if (el.textContent !== text) el.textContent = text;
  });
  nodes.forEach((el) => {
    const sec = Math.max(0, (now - Number(el.dataset.start)) / 1000);
    const text =
      sec < 60
        ? `${sec.toFixed(1)} 秒`
        : `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
    const box = el.querySelector(".runbadge__time");
    if (box && box.textContent !== text) box.textContent = text;
  });
}

function ensureRunClock() {
  if (!document.querySelector(".runbadge[data-start]")) return;
  paintRunBadges();
  if (!runClockTimer) runClockTimer = setInterval(paintRunBadges, 200);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) ensureRunClock();
});

/** 一条消息里第几个子任务 —— 卡片标题上的序号，按工具发生顺序数。 */
function subagentSeq(tools) {
  const map = new Map();
  let n = 0;
  (tools || []).forEach((t) => {
    if (t.name === "spawn_subagent") map.set(t.id, ++n);
  });
  return map;
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
  const subSeq = subagentSeq(tools);
  tools.forEach((t, idx) => {
    alive.add(t.id);
    const sig = toolSig(t);
    let card = existing.get(t.id);
    const ctx = { subSeq: subSeq.get(t.id) };
    if (!card) {
      const tmp = document.createElement("div");
      tmp.innerHTML = renderTool(t, ctx);
      card = tmp.firstElementChild;
      card.dataset.toolId = t.id;
      card.dataset.sig = sig;
      existing.set(t.id, card);
    } else if (card.dataset.sig !== sig) {
      const tmp = document.createElement("div");
      tmp.innerHTML = renderTool(t, ctx);
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

/* ---------------- 时间线渲染 ---------------- */

/**
 * 按发生顺序铺开一条助手消息。
 *
 * 旧布局把「思考 / 工具 / 正文」各放一个固定槽位，顺序是写死的。
 * 可 Agent 实际的节奏是「想 → 调工具 → 看结果 → 再想」，
 * 三桶一平铺，中间那些「因为 A 失败所以改用 B」推理就全被抽走了，
 * 剩下一坨思考、一堆工具、一段结论，像三份互不相干的附录。
 *
 * 这里按 m.timeline 逐段铺开。段本身复用原来的类名
 * （.reasoning / .tool / .msg__body），样式一行都不用重写。
 * 没有 timeline 的旧消息仍走三桶布局 —— 历史会话不会变样。
 */

/** 段的稳定标识：位置由类别 + 起始偏移决定，刷新不会错位。 */
function segKey(seg) {
  if (seg.type === "tool") return `t:${seg.id}`;
  return `${seg.type === "reasoning" ? "r" : "x"}:${seg.from}`;
}

/** 取出该段覆盖的文本。to 为空表示还在增长，一直到末尾。 */
function segText(m, seg) {
  const src = String((seg.type === "reasoning" ? m.reasoning : m.content) || "");
  const to = seg.to === null || seg.to === undefined ? src.length : seg.to;
  return src.slice(seg.from, to);
}

/**
 * 思考段的折叠标题只写「深度思考」，四段排下来就是四个一样的标签，
 * 等于没写。这里取首句当摘要，折叠状态也能看出这一步在琢磨什么。
 */
function reasonSummary(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const m = s.match(/^(.{4,}?)[。！？!?；;，,]/);
  const head = m ? m[1] : s.slice(0, 16);
  return head.length > 16 ? `${head.slice(0, 16)}…` : head;
}

/* ---------------- 「N 步进程」折叠组 ----------------
 *
 * 一轮跑十几步时，思考与工具卡片平铺会把消息拉得老长，用户要滑很久才看到结论。
 * 收进一个组里：运行中自动展开（否则看不出它是不是卡住了），结束后自动收起。
 *
 * 两条硬规矩：
 *   1. 有等待审批的调用时强制展开 —— 折进去用户就找不到该点哪里了。
 *   2. 用户手动开合过就一直听用户的（强制展开的情况除外）。
 */
const flowOpen = new Map();

/**
 * 一次回复跑完就把思考链与「N 步进程」组收起来。
 *
 * 运行中它们默认展开（否则看不出模型是不是卡住了），用户也可能为了
 * 追进度手动点开。但结束后那几屏思考文字留在原地，会把结论和输入框
 * 一起顶到很远，想接着打字得先滑半天 —— 完成时自动收起最省事。
 *
 * 只收一次：收完之后用户再手动展开回看，不该被下一次 updateMessages
 * 又强行合上。重跑（status 回到 running）时把标记撤掉，允许再收一次。
 */
const collapsedOnFinish = new Set();

function collapseFinishedReasoning(s) {
  for (const m of s.messages || []) {
    if (m.status === "running" || m.status === "pending") {
      collapsedOnFinish.delete(m.id);
      continue;
    }
    if (collapsedOnFinish.has(m.id)) continue;
    collapsedOnFinish.add(m.id);
    flowOpen.delete(m.id);
    // 思考段在时间线里各有独立开关，键是 `消息id#起始偏移`
    for (const k of Array.from(ui.reasoningOpen)) {
      if (k === m.id || k.indexOf(`${m.id}#`) === 0) ui.reasoningOpen.delete(k);
    }
  }
}

function ensureRunGroup(box) {
  let g = box.querySelector(":scope > .run-group");
  if (!g) {
    g = document.createElement("div");
    g.className = "run-group";
    g.dataset.open = "true";
    g.innerHTML = `<button class="run-group__head" data-act="toggle-flow" data-id="">
      <span class="run-group__ic"></span>
      <span class="run-group__title">进程</span>
      <span class="run-group__meta"></span>
      <span class="run-group__chev">${icon("chevron", "icon--xs")}</span>
    </button>
    <div class="run-group__body"></div>`;
  }
  // 组永远是第一个孩子：正文段的插入位置按「组之后」算，挪了就错位
  if (box.firstElementChild !== g) box.insertBefore(g, box.firstElementChild || null);
  return g;
}

function paintRunGroup(group, m, steps, running) {
  const waiting = (m.tools || []).some((t) => t.status === "waiting");
  const open = waiting ? true : flowOpen.has(m.id) ? flowOpen.get(m.id) : running;
  const set = (el, key, val) => {
    if (el.dataset[key] !== String(val)) el.dataset[key] = String(val);
  };
  set(group, "open", open);
  set(group, "wait", waiting);

  const head = group.querySelector(".run-group__head");
  if (head.dataset.id !== m.id) head.dataset.id = m.id;

  const spin = running && !waiting;
  const ic = group.querySelector(".run-group__ic");
  const icKey = spin ? "loader" : waiting ? "shield" : "layers";
  if (ic.dataset.k !== icKey) {
    ic.dataset.k = icKey;
    ic.className = `run-group__ic${spin ? " run-group__ic--spin" : ""}`;
    ic.innerHTML = icon(icKey, "icon--xs");
  }

  const title = group.querySelector(".run-group__title");
  const tt = waiting ? `待处理 · ${steps} 步` : `${steps} 步进程`;
  if (title.textContent !== tt) title.textContent = tt;

  const total = (m.tools || []).length;
  const meta = group.querySelector(".run-group__meta");
  const mt = running ? "进行中" : total ? `${total} 次工具调用` : "";
  if (meta.textContent !== mt) meta.textContent = mt;
}

function patchFlow(box, m) {
  const segs = m.timeline || [];
  const running = m.status === "running";
  // 现有节点可能挂在折叠组里：组外的直接子元素 + 组内的步骤，两边都要收
  const existing = new Map();
  const oldGroup = box.querySelector(":scope > .run-group");
  if (oldGroup) {
    oldGroup.querySelectorAll(":scope > .run-group__body > *").forEach((c) => {
      if (c.dataset.k) existing.set(c.dataset.k, c);
    });
  }
  [...box.children].forEach((c) => {
    if (c === oldGroup || !c.dataset.k) return;
    existing.set(c.dataset.k, c);
  });
  const alive = new Set();
  const subSeq = subagentSeq(m.tools);

  // 只有最后一个思考段可能还在增长，标题也只由它决定
  let lastReason = -1;
  for (let i = 0; i < segs.length; i++) if (segs[i].type === "reasoning") lastReason = i;

  // 两条游标：步骤进折叠组、正文留在组外。
  // 不用 segs 下标 —— 关掉「显示思考过程」后思考段会被整段跳过，下标就和实际节点错开了。
  let stepIdx = 0;
  let textIdx = 0;
  const group = ensureRunGroup(box);
  const groupBody = group.querySelector(":scope > .run-group__body");

  segs.forEach((seg, idx) => {
    const key = segKey(seg);
    let node = existing.get(key);

    if (seg.type === "tool") {
      const t = (m.tools || []).find((x) => x.id === seg.id);
      if (!t) return; // 卡片还没落库，下一帧再画
      alive.add(key);
      const sig = toolSig(t);
      const ctx = { subSeq: subSeq.get(t.id) };
      if (!node) {
        const tmp = document.createElement("div");
        tmp.innerHTML = renderTool(t, ctx);
        node = tmp.firstElementChild;
        node.dataset.k = key;
        node.dataset.sig = sig;
        existing.set(key, node);
      } else if (node.dataset.sig !== sig) {
        const tmp = document.createElement("div");
        tmp.innerHTML = renderTool(t, ctx);
        const fresh = tmp.firstElementChild;
        fresh.dataset.k = key;
        fresh.dataset.sig = sig;
        node.replaceWith(fresh);
        existing.set(key, fresh);
        node = fresh;
      } else {
        const openNow = String(ui.toolOpen.has(t.id));
        if (node.dataset.open !== openNow) node.dataset.open = openNow;
      }
    } else if (seg.type === "reasoning") {
      const text = segText(m, seg);
      // 关掉「显示思考过程」后，历史段整块撤掉；运行中的末段仍然要露面，
      // 否则深度思考模型会有好几秒什么都不显示。
      const show = !!text && (state.settings.showReasoning || running);
      if (!show) {
        if (node) node.remove();
        existing.delete(key);
        return;
      }
      alive.add(key);
      const segId = `${m.id}#${seg.from}`;
      const open = ui.reasoningOpen.has(segId);
      if (!node) {
        const tmp = document.createElement("div");
        tmp.innerHTML = reasoningShell(m, open);
        node = tmp.firstElementChild;
        node.dataset.k = key;
        node.querySelector(".reasoning__toggle").setAttribute("data-id", segId);
        existing.set(key, node);
      } else {
        const openStr = open ? "true" : "false";
        if (node.dataset.open !== openStr) node.dataset.open = openStr;
      }
      const label = node.querySelector(".reasoning__label");
      const thinking = running && idx === lastReason && seg.to === null;
      const want = thinking ? "正在思考…" : "深度思考";
      if (label.textContent !== want) label.textContent = want;

      // 摘要只在停下来之后给：流式时首句还在长，每帧改一次反而晃眼睛
      const hint = node.querySelector(".reasoning__hint");
      if (hint) {
        const sum = thinking ? "" : reasonSummary(text);
        if (hint.textContent !== sum) hint.textContent = sum;
      }

      // 只对末段做追加：历史段内容已经固定，重写只会让浏览器白排一次版
      const textEl = node.querySelector(".reasoning__text");
      let tn = textEl._reasonNode;
      if (!tn || tn.parentNode !== textEl) {
        textEl.textContent = "";
        tn = document.createTextNode("");
        textEl.appendChild(tn);
        textEl._reasonNode = tn;
      }
      const shown = tn.nodeValue || "";
      if (text.length > shown.length && text.indexOf(shown) === 0) tn.appendData(text.slice(shown.length));
      else if (text !== shown) tn.nodeValue = text;
    } else {
      alive.add(key);
      if (!node) {
        node = document.createElement("div");
        node.className = "msg__body msg__body--seg";
        node.dataset.k = key;
        existing.set(key, node);
      }
      // 段尾可能留着工具回合后的空行，渲染前掐掉，否则会多出一块留白
      const text = segText(m, seg).trim();
      const sig = `${text.length}|${running}`;
      if (node.dataset.sig !== sig) {
        node.className = `msg__body msg__body--seg${text ? " md" : " dim"}`;
        node.innerHTML = text
          ? renderMarkdown(text)
          : running
            ? `${icon("loader", "icon--sm icon--loader")} 正在准备…`
            : "";
        node.dataset.sig = sig;
      }
    }

    // 步骤进组、正文留在组外：组永远在最上面，读起来是「过程 → 结论」。
    // 组内/组外各一条游标，互不干扰。
    if (seg.type === "tool" || seg.type === "reasoning") {
      if (groupBody.children[stepIdx] !== node) groupBody.insertBefore(node, groupBody.children[stepIdx] || null);
      stepIdx += 1;
    } else {
      // 组固定占 box 的第 0 位，正文从第 1 位往后排
      if (box.children[textIdx + 1] !== node) box.insertBefore(node, box.children[textIdx + 1] || null);
      textIdx += 1;
    }
  });

  // 死节点：组外的直接子元素 + 组内的步骤，两处都要扫
  [...box.children].forEach((c) => {
    if (c === group) return;
    if (!alive.has(c.dataset.k)) c.remove();
  });
  [...groupBody.children].forEach((c) => {
    if (!alive.has(c.dataset.k)) c.remove();
  });

  // 没有步骤就别留一个空壳
  if (!stepIdx) {
    group.remove();
    return;
  }
  paintRunGroup(group, m, stepIdx, running);
}

function patchAssistant(el, m) {
  const running = m.status === "running";
  const open = ui.reasoningOpen.has(m.id);

  // 时间线里每段思考各有自己的开关（键是 `消息id#起始偏移`），
  // 只拿整条消息的 id 去数，点开某一段时 quick 不变，界面就不会重绘。
  let openCount = 0;
  ui.reasoningOpen.forEach((k) => {
    if (k === m.id || k.indexOf(`${m.id}#`) === 0) openCount += 1;
  });

  // 便宜的整体签名：状态、正文/推理长度、工具状态、展开态。
  // 完全没变就不往下走，避免每帧为一屋子消息拼 HTML。
  const quick = [
    m.status,
    m.content.length,
    m.reasoning.length,
    (m.timeline || []).length,
    (m.tools || [])
      .map((t) => `${t.id}:${t.status}:${(t.output || "").length}:${t.ms || 0}:${ui.toolOpen.has(t.id) ? 1 : 0}`)
      .join(","),
    m.contextTrim?.removed || 0,
    m.contextPack?.compacted || 0,
    m.media?.sent || 0,
    m.media?.images || 0,
    m.phase || "",
    // 引导计数变化时必须重绘：否则发完引导、其它字段都没动，
    // patchAssistant 会在下面的 quick 早退，状态标迟迟不显示「待生效」。
    m.steerPending || 0,
    m.steerCount || 0,
    openCount,
    flowOpen.has(m.id) ? String(flowOpen.get(m.id)) : "",
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

  // 有 timeline 走时间线；没有的旧消息保持原来的三桶布局，
  // 历史会话翻回去看不会突然变样
  const flow = Array.isArray(m.timeline) && m.timeline.length > 0;
  const flowEl = el.querySelector(":scope > .msg__flow");
  const legacyEl = el.querySelector(":scope > .msg__legacy");
  if (flowEl) flowEl.hidden = !flow;
  if (legacyEl) legacyEl.hidden = flow;

  // 正文签名在两条路径下都要用，放在分流外面
  const bodySig = `${m.content.length}|${running}|${m.status}|${m.phase || ""}`;

  if (flow) {
    patchFlow(flowEl, m);
  } else {
    patchReasoning(el, m, running, open);
    patchTools(el.querySelector(".tools-slot"), m.tools || []);

    // 正文是流式里变化最频繁的部分：按时间片节流，避免每个 token 都重排 Markdown
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
        const bodyBox = el.querySelector(".body-slot");
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
  }

  const tail = tailHtml(m, !running && m.status, m.tools || []);
  if (el.dataset.sigTail !== tail) {
    el.querySelector(":scope > .tail-slot").innerHTML = tail;
    el.dataset.sigTail = tail;
  }
  // 运行中：把秒数时钟拉起来（已在跑就什么都不做）
  if (running) ensureRunClock();

  // 正文真正落地后才认这份 quick；否则保持旧值，等节流定时器补一次。
  // 时间线模式下正文由 patchFlow 自己增量维护，不存在「等节流」这回事。
  if (flow || el.dataset.sigBody === bodySig) el.dataset.quick = quick;
}

/* ---------------- 首页小球 ----------------
 *
 * 首页中间那颗球和悬浮窗是**同一颗**（dsh-ball.js）：同一个状态机、
 * 同一套眼神跟随，只是这里大一号（side 60 → 画布 96）。
 *
 * 为什么分两步：首页是一段字符串拼出来的，canvas 得先挂到 DOM 上
 * 才拿得到 2D 上下文。所以 renderHome 只负责给画布，挂载后由
 * mountHomeBall 绑球 —— 它可以被反复调用，已经绑过就复用。
 */
let homeBall = null;

function mountHomeBall() {
  const canvas = $("#home-ball");
  if (!canvas) {
    stopHomeBall();
    return;
  }
  // 系统「减少动效」或设置里关掉动效：只画静态一帧。
  // 这颗球一直在呼吸、眨眼，是持续的小幅刺激，不该当那个偏好不存在。
  const calm =
    !state.settings.motion ||
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  // DOM 没换、动效档位也没变（只是首页又渲染了一次）：接着用原来那颗。
  // 即使整块重绘换了画布节点，也只重绑，不新建 —— 新建会从 logo 变形的
  // 第 0 帧开始，用户看到的是「点一下模式，中间的球抖了一下」。
  if (homeBall && homeBall.calm === calm) {
    if (homeBall.canvas !== canvas) homeBall.rebind(canvas);
    else if (!homeBall.running) homeBall.start();
    return;
  }
  stopHomeBall();
  homeBall = new DshBall(canvas, { side: 72, calm });
  homeBall.start();
}

function stopHomeBall() {
  if (!homeBall) return;
  homeBall.stop();
  homeBall = null;
}

function updateMessages() {
  const s = activeSession();
  if (s) collapseFinishedReasoning(s);
  const box = $("#messages");
  // 冷启动还没有会话：首页照样画出来了，球也得挂上去。
  // 少了这一句，首次打开时中间是块空白画布 —— 只有先发一句话再切回来才有球。
  if (!s) {
    mountHomeBall();
    return;
  }
  if (!box) return;

  if (!s.messages.length) {
    // 空会话：渲染首页空态。
    // 注意容器必须是 .messages（带 padding/gap 的消息布局），
    // 否则一旦有消息进来，容器的布局规则会与首页空态对不上。
    box.className = "messages messages--empty";
    // 内容没变就不重写 DOM。updateMessages 在流式输出时每帧都会调，
    // 空态下每帧重写一次的话，小球画布会被换掉，动画跟着一直重开。
    const home = renderHome();
    if (box.dataset.homeSig !== home) {
      box.innerHTML = home;
      box.dataset.homeSig = home;
      ui.msgNodes = new Map();
      // 首页空态是整块重建的，.reveal 默认 opacity:0，只靠 navigate() 里那一次补 is-in。
      // 少了这一句，任何重绘（比如切换工作模式）都会把标题弄消失。
      box.querySelectorAll(".reveal").forEach((el) => el.classList.add("is-in"));
    }
    mountHomeBall();
    return;
  }

  // 有消息了：首页空态连同它的画布一起被移除，小球要停下 ——
  // 留着 rAF 在跑等于白白耗电，canvas 也已经不在文档里了。
  stopHomeBall();

  // 有消息了：把首页空态整块移除。
  // 之前只是往容器里"追加"消息节点，首页空态（.home）会残留在消息列表下方，
  // 表现为"发完一句话底下空出整整一屏，底部不是最新消息"。
  if (box.classList.contains("messages--empty")) {
    box.className = "messages";
    box.innerHTML = "";
    // 首页的签名要一起清掉：留着的话，切回空会话时签名相同会跳过重绘，
    // 可 DOM 已经被清空，首页就再也回不来了。
    delete box.dataset.homeSig;
    ui.msgNodes = new Map();
  }

  const nearBottom = ui.pinned;
  const prevScroll = $("#chat-scroll")?.scrollTop || 0;

  // 日期头只建一次
  // 日期头只放日期：模式已经写在顶栏胶囊里，这里再说一遍是重复。
  // 翻旧会话要判断"当时按什么规矩做的"，看顶栏就行。
  const dateText = new Date(s.createdAt).toLocaleDateString("zh-CN");
  let head = box.querySelector(":scope > .chat__date");
  if (!head) {
    head = document.createElement("div");
    head.className = "chat__date";
    head.textContent = dateText;
    box.insertBefore(head, box.firstChild);
  } else if (head.textContent !== dateText) {
    head.textContent = dateText;
  }

  // 不用 `||=`：那是 ES2021（Chrome 85+），而 2020 年前后的 Android 11 机型
  // 出厂 WebView 常在 83/84，整个 ui.js 会因这一行解析失败，应用直接黑屏。
  if (!ui.msgNodes) ui.msgNodes = new Map();
  const nodes = ui.msgNodes;
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

function toolStatusMeta(t) {
  const map = {
    running: { tag: "运行中", cls: "tool__tag--warn", ic: "loader", spin: true },
    waiting: { tag: "待批准", cls: "tool__tag--warn", ic: "shield", spin: false },
    done: { tag: "完成", cls: "tool__tag--ok", ic: "check", spin: false },
    error: { tag: "失败", cls: "tool__tag--err", ic: "alert", spin: false },
    denied: { tag: "已拒绝", cls: "tool__tag--err", ic: "x", spin: false },
    blocked: { tag: "已拦截", cls: "tool__tag--err", ic: "shield", spin: false },
    // 「需要你处理」和「单纯失败」要分开：前者重试一百次也没用（凭据错、地址错），
    // 后者可能是网络抖动。混在一起用户不知道该不该再点一次。
    needs_user: { tag: "需处理", cls: "tool__tag--warn", ic: "alert", spin: false },
  };
  // 未知状态不再默认成「运行中」—— 那会让一个已经失败的调用一直转圈。
  return map[t.status] || map.error;
}

/**
 * 子任务卡：spawn_subagent 不该长得像一条 shell 命令。
 *
 * 「子任务 2 · 探索模型管理…」+ 耗时/字数，展开是它带回来的结论。
 * 参数里的 task 全文放正文里，不放 JSON —— 用户要看的是"派了什么活"，
 * 不是"这个工具的入参 schema 长什么样"。
 */
function renderSubagentCard(t, st, ctx = {}) {
  const open = ui.toolOpen.has(t.id);
  const n = Number(ctx.subSeq) || 1;
  const task = String((t.args && t.args.task) || t.argLabel || "").trim();
  const brief = task.length > 22 ? `${task.slice(0, 22)}…` : task || "未命名任务";
  const out = String(t.output || "");
  const tail =
    t.status === "done"
      ? `<span class="tag">${t.ms ? fmtClock(t.ms) : ""}</span>${out ? `<span class="tag">${out.length} 字</span>` : ""}${
          t.suspended ? `<span class="tool__tag tool__tag--warn" title="客户端曾被系统挂起">含挂起</span>` : ""
        }`
      : `<span class="tool__tag ${st.cls}">${st.tag}</span>`;
  const color =
    t.status === "done" ? "var(--ok)" : t.status === "running" || t.status === "waiting" ? "var(--warn)" : "var(--danger)";

  return `
  <div class="tool tool--task" data-status="${t.status}" data-open="${open}">
    <button class="tool__head" data-act="toggle-tool" data-id="${t.id}">
      <span class="tool__state ${st.spin ? "tool__state--spin" : ""}" style="color:${color}">
        ${icon(st.spin ? "loader" : "layers", "icon--xs")}
      </span>
      <span class="tool__name tool__name--task">子任务 ${n}</span>
      <span class="tool__arg">${esc(brief)}</span>
      ${tail}
      ${icon("chevron", "icon--xs tool__chev")}
    </button>
    <div class="tool__body">
      ${task ? `<p class="tool__label">任务</p><p class="tool__ask">${esc(task)}</p>` : ""}
      ${
        out
          ? `<p class="tool__label">结论</p><div class="msg__body md tool__result">${renderMarkdown(out)}</div>`
          : t.status === "running"
            ? `<p class="tool__hint">${icon("loader", "icon--sm icon--loader")} 子 Agent 正在它自己的上下文里分析，不占用主对话的窗口。</p>`
            : t.status === "waiting"
              ? `<div class="tool__statusline">${icon("shield", "icon--xs")} 等待你在下方审批</div>`
              : `<p class="tool__hint">这次调用没有带回结论（${esc(st.tag)}）。</p>`
      }
      ${t.suspended ? `<div class="tool__notice tool__notice--warn">${icon("alert", "icon--xs")} 这次调用耗时 ${fmtClock(t.ms)}，DSH 当时可能被系统挂起在后台。</div>` : ""}
    </div>
  </div>`;
}

function renderTool(t, ctx = {}) {
  const st = toolStatusMeta(t);
  if (t.name === "spawn_subagent") return renderSubagentCard(t, st, ctx);
  const open = ui.toolOpen.has(t.id);

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
      ${
        t.status === "done"
          ? `<span class="tag">${t.ms ? fmtClock(t.ms) : ""}</span>${
              // 耗时异常长 = 客户端被系统挂起过，不是 DSH 慢。
              // 不标出来的话，用户只会觉得"这软件越来越卡"。
              t.suspended ? `<span class="tool__tag tool__tag--warn" title="客户端曾被系统挂起，期间屏幕可能已变化">含挂起</span>` : ""
            }`
          : `<span class="tool__tag ${st.cls}">${st.tag}</span>`
      }
      ${icon("chevron", "icon--xs tool__chev")}
    </button>
    <div class="tool__body">
      ${t.args && Object.keys(t.args).length ? `<p class="tool__label">调用参数</p><pre class="tool__code">${esc(JSON.stringify(t.args, null, 2).slice(0, 1600))}</pre>` : ""}
      ${t.code ? `<p class="tool__label">编排脚本</p><pre class="tool__code">${esc(t.code)}</pre>` : ""}
      ${t.status === "waiting" ? `<div class="tool__statusline">${icon("shield", "icon--xs")} 等待你在下方审批</div>` : ""}
      ${t.safety?.warn ? `<div class="tool__notice tool__notice--warn">${icon("shield", "icon--xs")} CC Safety Net 提醒：${esc(t.safety.secrets.join("、"))}</div>` : ""}
      ${t.suspended ? `<div class="tool__notice tool__notice--warn">${icon("alert", "icon--xs")} 这次调用耗时 ${fmtClock(t.ms)}，DSH 当时可能被系统挂起在后台。挂起期间屏幕可能已变化，模型已被提示先重新读屏确认。</div>` : ""}
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
    const focused = document.activeElement === el;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    // 值没变就一个字节都不碰：无谓的 `value=` 赋值会让 WebView 的
    // InputConnection 重新同步一次，组合输入期间尤其容易把候选打断。
    if (el.value !== value) el.value = value;
    if (focused) {
      const max = el.value.length;
      try {
        el.setSelectionRange(Math.min(start ?? max, max), Math.min(end ?? max, max));
      } catch {
        /* 某些输入类型不支持 setSelectionRange */
      }
    }
    autoGrow();
  }
  updateSendState();
}

/**
 * 在当前光标处插入文字（而不是无脑追加到句末）。
 *
 * 语音识别、@ 引用文件、剪贴板短语这些「程序写入」以前都是
 * `cur + text`，于是用户把光标挪到句中也只会被迫接在句尾。
 * setRangeText 是浏览器原生的选区替换：WebView 的 Editable 会同步，
 * 光标落在插入内容之后，不会破坏正在进行的组合输入。
 */
function insertComposerText(text, { space = true } = {}) {
  const t = String(text || "");
  const el = $("#composer-input");
  if (!el || !t) return;
  el.focus({ preventScroll: true });
  const cur = el.value;
  const start = el.selectionStart ?? cur.length;
  const end = el.selectionEnd ?? start;
  const before = cur.slice(0, start);
  const needSpace =
    space && !!before && !/\s$/.test(before) && /[A-Za-z0-9]$/.test(before) && /^[A-Za-z0-9]/.test(t);
  const ins = `${needSpace ? " " : ""}${t}`;
  try {
    el.setRangeText(ins, start, end, "end");
  } catch {
    setComposerValue(cur + ins);
    return;
  }
  ui.draft = el.value;
  autoGrow();
  updateSendState();
}

function restoreDraft() {
  const input = $("#composer-input");
  if (!input) return;
  if (input.value !== ui.draft) input.value = ui.draft;
  autoGrow();
}

/* autoGrow 用 rAF 合并：连续按键只做一次高度计算。 */
let growPending = false;

/**
 * 输入框高度跟随内容。
 *
 * ============ 这里有一个曾经把功能改坏的取舍 ============
 *
 * 原来的写法在**组合输入期间直接跳过**（拼音候选、语音候选都算）：
 *
 *     if (!input || ui.composing) return;
 *
 * 理由是"避免打断输入法"。担心不是没有根据 —— 改 textarea 高度会触发
 * layout，Android 上候选框可能跟着重排、闪一下。
 *
 * 但代价太大：**WebView 里 `compositionend` 丢失是常见现象**
 * （输入法上屏方式不同、语音识别走 setComposingText 提交、
 *  某些 ROM 的输入法干脆不发这个事件）。
 * 一旦 `ui.composing` 卡在 true，高度就永久冻结在那一刻的值 ——
 *
 *   · 继续打字，输入框不再长高 → **第二行开始看不见自己正在输的字**；
 *   · 语音识别追加文字走的是同一条路径 → **语音"没反应"**（其实文字进去了）。
 *
 * 两个看起来无关的抱怨，其实是同一个根因。
 *
 * ============ 现在的做法 ============
 *
 * **高度变化不阻塞**（它不改 value，不会真正打断输入），
 * 但只在高度**确实需要变**时才写 style —— 把强制重排压到最少：
 * 没变就不碰 DOM，等于给输入法让路。
 *
 * 只有「按钮重绘」那类真的会打断输入法的操作，才继续看 composing。
 */
function autoGrow() {
  if (growPending) return;
  growPending = true;
  requestAnimationFrame(() => {
    growPending = false;
    const input = $("#composer-input");
    if (!input) return;

    // 先归零再读 scrollHeight，否则收缩时读到的是旧高度
    input.style.height = "auto";
    const full = input.scrollHeight;
    const next = Math.min(full, 132);

    // ============ 这里必须无条件写回，不能做"值没变就跳过"的优化 ============
    //
    // 踩过一次：为了少碰 DOM，写成 `if (prev !== next + "px") 才写`。
    // 结果 autoGrow 在一次输入里跑两遍（input 一次、其它路径一次）时，
    // 第二遍看到 prev 已经是上次算出来的 32px、next 也是 32 —— 判定"没变"，
    // 于是**高度留在上一步刚设的 `auto` 上**。
    //
    // 而 textarea 加了 rows="1"，`height:auto` 就是一行高：
    // 内容明明 80px，框还是 32px，第二行起全看不见。
    //
    // 教训：读 scrollHeight 前必须先破坏高度，这一步本身就改变了样式，
    // 所以后面没有"跳过写回"的余地。
    input.style.height = `${next}px`;

    // 超过上限后，浏览器不一定把光标滚进可视区（WebView 上很常见），
    // 于是"正在输的那一行"落在框外。输入时跟到底部是符合直觉的。
    if (full > next) input.scrollTop = full;
  });
}

let lastSendKind = "";

/**
 * 内容高度变了才重排 —— 给轮询用的轻量版本。
 *
 * `autoGrow` 内部会先把 height 设成 auto 再读 scrollHeight，那是一次强制布局。
 * 400ms 一次虽然不贵，但没必要在用户发呆时也一直重排。
 *
 * 这里先用**当前固定高度**下的 scrollHeight 做比较（此时它仍然反映内容实际高度），
 * 变了才调 autoGrow。没变就一个 DOM 操作都不做。
 */
let lastGrowH = -1;
function growIfChanged() {
  const input = $("#composer-input");
  if (!input) return;
  const h = input.scrollHeight;
  if (h === lastGrowH) return;
  lastGrowH = h;
  autoGrow();
}

/**
 * 现在到底是不是"真的还在组合输入"。
 *
 * ============ 为什么不能只看 ui.composing ============
 *
 * `compositionend` 在 Android WebView 上会丢（不同输入法上屏方式不一样），
 * 标志一旦卡在 true 会连锁出三个问题：
 *
 *   1. 输入框高度不涨 → 第二行起看不见正在输的字；
 *   2. 点发送只弹「先让输入法确认候选」→ **永远发不出去**；
 *   3. 输入 "/" 不弹命令面板。
 *
 * 所以这里加**时效**：真正的组合输入，每敲一下都会刷新时间戳；
 * 超过 3 秒没有任何组合事件，就认为那个标志是残留，不再拦着用户。
 *
 * 单纯靠事件复位不够 —— 因为出问题的正是"事件没来"这件事本身。
 */
const COMPOSING_STALE_MS = 3000;
function isComposingNow() {
  if (!ui.composing) return false;
  if (Date.now() - (ui.composingAt || 0) > COMPOSING_STALE_MS) {
    // 超时未刷新：判定为残留标志，顺手清掉
    ui.composing = false;
    return false;
  }
  return true;
}

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

/** 当前正在跑的，是不是「屏幕上这个」会话。 */
function runHere() {
  return !!ui.run && ui.run.sessionId === state.activeSessionId;
}

/** 运行中的会话（可能不是当前打开的）。 */
function runningSession() {
  return ui.run ? state.sessions.find((s) => s.id === ui.run.sessionId) || null : null;
}

/**
 * 别的会话在跑时，输入区上方给一条可点的横条。
 * 没有这条提示，用户切到新会话后看到发送键变回普通样式，
 * 会以为「刚才那个任务已经停了」——其实还在后台跑。
 */
function updateRunAway() {
  const el = $("#run-away");
  if (!el) return;
  const away = !!ui.run && !runHere();
  const wantHidden = !away;
  if (el.hidden !== wantHidden) el.hidden = wantHidden;
  if (!away) return;
  const s = runningSession();
  const text = el.querySelector(".run-away__text");
  if (text) {
    const next = `「${s?.title || "另一个会话"}」正在运行`;
    if (text.textContent !== next) text.textContent = next;
  }
}

function updateSendState() {
  const btn = $("#send-btn");
  if (!btn) return;
  updateRunAway();
  // 只有「正看着运行中的会话」才有引导/停止语义。
  // 只看 ui.run 会让别的会话的输入也变成引导，点下去 steerRun 又因
  // sessionId 不匹配直接返回 —— 表现就是「打字发送没反应」。
  const here = runHere();
  const stop = $("#stop-live-btn");
  if (stop) stop.hidden = !here;
  const input = $("#composer-input");
  if (input) {
    const s = activeSession();
    const ph = here
      ? "运行中可补充指令，发送即引导"
      : s && s.messages.length
        ? "接着说，或 / 调指令"
        : "描述目标，@ 引用文件";
    // 每 400ms 的轮询都会走到这里。无条件写 placeholder 等于每 400ms
    // 改一次输入框属性，组合输入中的 WebView 会因此反复重连输入法。
    if (input.placeholder !== ph) input.placeholder = ph;
  }
  // 以输入框实时内容判断，避免镜像缓存与 DOM 脱节导致按钮永远禁用
  const orphan = orphanRunning();
  const txt = composerValue().trim();
  // 引导只带文字；运行中挂着附件时不把按钮伪装成可发送引导
  const hasText = here ? !!txt : !!txt || ui.attachments.length > 0;
  const kind = here ? (hasText ? "steer" : "stop") : orphan ? "stop" : hasText ? "send" : "off";

  // 语音键与发送键共用右侧同一个位置：没字时是麦克风，有字时是发送。
  // 两个按钮常驻会让胶囊右侧挤成一小排图标，这里只留一个。
  const mic = $("#voice-btn");
  if (mic) {
    const hidden = kind !== "off";
    if (mic.hidden !== hidden) mic.hidden = hidden;
  }

  if (kind === lastSendKind) return; // 每次按键不重建按钮 DOM
  lastSendKind = kind;
  btn.classList.toggle("send--steer", kind === "steer");
  if (kind === "steer") {
    btn.dataset.stop = "false";
    btn.innerHTML = icon("arrowUp", "icon--sm");
    btn.setAttribute("aria-label", "把补充指令作为引导发送");
    btn.disabled = false;
    return;
  }
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
    if (active && modelFormat(active) !== "openai") {
      toast(`当前模型是 ${FORMAT_SHORT[modelFormat(active)]} 格式，图片会换成一行文字说明`, "err");
    } else if (!vision) {
      toast("当前模型未开启「图片输入」，图片不会发送", "err");
    }
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
  // steerQueue：运行中用户追加的指令。runtime 在工具循环边界来取，
  // 不打断正在进行的请求；这里不能用普通消息发送（那会直接被 ui.run 挡掉）。
  ui.run = { controller, sessionId: s.id, msgId: msg.id, steerQueue: [] };
  updateSendState();
  if (ui.drawer) renderDrawer(); // 会话列表里的「运行中」圆点
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
      pollSteer: () => (ui.run?.steerQueue ? ui.run.steerQueue.splice(0) : []),
    });
  } catch (err) {
    msg.status = "error";
    msg.error = err.message || "运行失败";
  } finally {
    const missed = ui.run?.steerQueue?.length || 0;
    ui.run = null;
    updateSendState();
    if (ui.drawer) renderDrawer();
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
    if (missed) toast(`${missed} 条引导没赶上本轮，可重新发送`, "err");
    const away = document.visibilityState !== "visible" || ui.view !== "chat" || state.activeSessionId !== s.id;
    if (state.settings.notifyOnDone && away && msg.status === "done") notifyDone(s);
  }
}

/**
 * 运行中的输入引导：不打断当前请求，把用户追加的指令排进队列。
 *
 * runtime 在工具循环边界来取（见 liveRun 的 takeSteer），那是既不丢
 * 当前流式输出、又能让模型读到新指令的最早时机。界面上同时落一条
 * 带「引导」标记的用户气泡 —— 否则用户补完指令屏幕上什么都没留下，
 * 和之前「一分半没反应」一样会让人以为消息没发出去。
 */
function steerRun(text) {
  const raw = String(text || "").trim();
  const run = ui.run;
  if (!raw || !run || !run.steerQueue) return;
  const s = activeSession();
  if (!s || s.id !== run.sessionId) return;

  const userMsg = {
    id: `us_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    role: "user",
    content: raw,
    ts: Date.now(),
    steer: true,
    during: run.msgId,
  };
  addMessage(s.id, userMsg);
  run.steerQueue.push(raw);
  const msg = s.messages.find((m) => m.id === run.msgId);
  if (msg) msg.steerPending = (msg.steerPending || 0) + 1;

  setComposerValue("");
  ui.pinned = true;
  const box = $("#messages");
  if (ui.lastBuilt === s.id && box && !box.querySelector(".home")) {
    ui.renderFrom = Math.max(0, s.messages.length - RENDER_WINDOW);
    updateMessages();
    const sc = $("#chat-scroll");
    if (sc) sc.scrollTop = sc.scrollHeight;
  } else {
    renderChat($("#view-chat"), "bottom");
    ui.lastBuilt = s.id;
  }
  saveSessionNow(s.id);
  updateSendState();
  toast("已加入引导，模型在下一步读取", "ok");
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
  clearTimeout(ui.sheetTimer); // 别让上一次关闭的延时清理落到新面板上
  ui.sheet = { type, data, dismissible: opts.dismissible !== false };
  renderSheet();
  pushLayer();
}

/**
 * 从一个面板直接换到另一个面板。
 *
 * 不能写成 closeSheet() + openSheet()：
 * closeSheet 会 dropLayer() → history.back()，而 back 的 popstate 是异步到达的。
 * 等它到达时，新面板已经 push 了 layer，于是 popstate 看见 ui.layer === true，
 * 当成用户按了返回键，把刚打开的面板关掉 —— 表现为「点进去闪一下又没了」。
 *
 * 面板之间互相跳时，历史栈本来就只有一层，原地换掉内容才是对的。
 */
function replaceSheet(type, data = {}, opts = {}) {
  const had = !!ui.sheet;
  clearTimeout(ui.sheetTimer);
  ui.sheet = { type, data, dismissible: opts.dismissible !== false };
  renderSheet();
  if (!had) pushLayer();
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
    // 打开面板：先把「实际请求地址」「哪些开关可用」画出来，再静默探一次。
    renderEndpointPreview();
    syncFormatGates();
    setTimeout(() => {
      if (ui.sheet?.type === "custom-model" && $("#cm-base")?.value.trim()) scheduleProbe({});
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
    memory: memorySheet,
    traj: trajSheet,
    mcp: mcpSheet,
    "mcp-server": mcpServerSheet,
    workspace: workspaceSheet,
    commands: commandSheet,
    attach: attachSheet,
    trace: traceSheet,
    file: fileSheet,
    "new-file": newFileSheet,
    "node-log": nodeLogSheet,
    "node-install": nodeInstallSheet,
    "node-plugin": nodePluginSheet,
    "market-plugin": marketPluginSheet,
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
  const m = currentModel();
  // 模型入口收到这里：顶栏不要为了它多长一颗按钮。
  // 一行「模型 + 当前模型名」，点进去还是原来那张模型面板。
  const modelLabel = m ? m.label || m.name || m.apiModel || m.id : "未添加模型";
  return sheetFrame({
    title: "运行模式",
    desc: "模式决定当前会话装配哪些工具与提示词。",
    body: `
      <button class="menu__item sheet__model" data-act="${m ? "open-model" : "open-models"}" style="width:100%">
        ${icon("bolt", "icon--sm")}<span>模型</span><small>${esc(modelLabel)}</small>
      </button>
      <div style="height:8px"></div>
      ${Object.values(MODES)
        .map(
          (m) => `
      <button class="card card--interactive mode-opt${m.id === s.mode ? " mode-opt--on" : ""}" data-act="set-mode" data-value="${m.id}">
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
        .join("")}
      <p class="field__hint">极简模式只保留终端与文件编辑器；PTC 模式额外提供 <code>run_code</code>；创造模式可检查并创建插件。</p>`,
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

  const row = (m) => {
    const fmt = normalizeFormat(m.format);
    // 只有当「这个模型的协议」和「它所属厂牌的默认协议」不一致时才打标：
    // 一致的场合说一遍就够，重复的徽标只会把标题挤窄。
    const preset = normalizeFormat(PROVIDER_META[m.providerKey || "custom"]?.format);
    const badge = fmt === preset ? "" : `<span class="tag">${esc(FORMAT_SHORT[fmt] || fmt)}</span>`;
    return `
      <button class="card card--interactive" data-act="set-model" data-value="${m.id}" data-msearch="${esc(`${m.label} ${modelApiId(m)} ${m.provider}`.toLowerCase())}" style="margin-bottom:7px;${m.id === active ? "border-color:var(--accent-line);background:var(--accent-soft)" : ""}">
        <div class="card__row">
          <span class="avatar ${m.id === active ? "avatar--accent" : ""}" style="font-size:9px">${esc(PROVIDER_META[m.providerKey || "custom"]?.short || "CUS")}</span>
          <div style="flex:1;min-width:0">
            <div class="card__title">${esc(m.label)} ${badge} ${m.tag ? `<span class="tag">${m.tag}</span>` : ""}</div>
            <div class="card__sub">${esc(m.provider)} · ${fmtContext(m.ctx)} · ${esc(hostOf(modelBaseUrl(m)))}</div>
            <div style="margin-top:4px">${statusPill(m.id, { compact: true })}</div>
          </div>
          ${m.id === active ? icon("check", "icon--sm") : icon("chevron", "icon--sm")}
        </div>
      </button>`;
  };

  return sheetFrame({
    title: "选择模型",
    desc: "按厂牌分组，顺序与设置里一致；切换后回到上一页，每行的状态来自最近一次请求或测试。",
    body: `
      <input class="input" id="model-pick-search" placeholder="搜索名称、模型 ID 或厂牌…" autocomplete="off" spellcheck="false" style="margin-bottom:10px">
      <div id="model-pick-list">${groups
        .map(
          (g) => `
      <div class="model-group" data-mgroup>
        <div class="model-group__head">
          <span class="eyebrow">${esc(g.meta.name)}</span>
          <span class="eyebrow">${g.models.length} 个</span>
        </div>
        ${g.models.map(row).join("")}
      </div>`
        )
        .join("")}</div>`,
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
  minimax: "MMX", xiaomi: "MIMO", spark: "SPK", siliconflow: "SIL", agnes: "AGN",
  openai: "OPE", groq: "GRQ", openrouter: "OR", ollama: "OLL", lmstudio: "LMS",
  opendesign: "OPD",
  anth: "ANT", anthropic: "ANT", google: "GEM", gemini: "GEM", ollamaNative: "OLN",
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
      // 本地服务（Ollama / LM Studio 一类）不校验 Key，
      // 界面上不该显示成「未配置 Key」——那看起来像缺了东西。
      local: !!p.local,
      placeholderKey: p.placeholderKey || "",
      // 预设协议：新建模型时用它预选下拉，也是 modelFormat 的第二级兜底
      format: p.format || "openai",
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
  return normalizeApiKey(state.settings.keys?.[slot]).key;
}

function providerRow(slot) {
  const meta = PROVIDER_META[slot];
  const key = keyOf(slot);
  const active = providerKeyOf() === slot;
  const count = allModels().filter((m) => (m.providerKey || "custom") === slot).length;
  const sub = key
    ? `Key ····${esc(key.slice(-4))}`
    : meta.local
      ? "本地服务 · 无需 Key"
      : "未配置 Key";
  return `
    <button class="provider-row" data-act="open-provider" data-slot="${slot}">
      <span class="avatar ${active ? "avatar--accent" : ""}">${esc(meta.short)}</span>
      <span class="provider-row__main">
        <span class="provider-row__top">
          <span class="provider-row__name">${esc(meta.name)}</span>
          ${active ? '<span class="tag tag--on">当前</span>' : ""}
        </span>
        <span class="provider-row__sub">${sub} · ${count} 个模型</span>
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
        <p class="field__hint">${
          meta.local
            ? "本地代理不校验 Key，留空即可；只有代理单独设了 token 时才需要填。"
            : "只粘贴密钥本身，不要带 <code>Bearer </code> 前缀、引号或换行（本版会自动清理）。Key 按服务分槽保存，切换模型时自动取对应的那一把。"
        }</p>
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
  // 协议和厂牌默认值不一致时点出来 —— 改过格式的模型最容易「看着像 OpenAI，其实不是」
  const fmt = normalizeFormat(m.format);
  const preset = normalizeFormat(PROVIDER_META[m.providerKey || "custom"]?.format);
  const fmtTag = fmt === preset ? "" : `<span class="tag">${esc(FORMAT_SHORT[fmt] || fmt)}</span>`;
  return `
    <div class="model-manage" data-active="${active}">
      <button class="model-manage__main" data-act="set-model" data-value="${m.id}">
        <span class="avatar ${active ? "avatar--accent" : ""}">${esc(PROVIDER_META[m.providerKey]?.short || "CUS")}</span>
        <span class="model-manage__text">
          <span class="model-manage__name">${esc(m.label)} ${fmtTag} ${active ? '<span class="tag tag--on">当前</span>' : ""}${m.overridden ? '<span class="tag">已改参数</span>' : ""}</span>
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
      <p class="field__hint" style="margin-top:10px;line-height:1.7">支持 OpenAI 兼容、Anthropic Messages、Google Gemini、Ollama 原生四种接口格式，添加时自动探测端点提供了哪些模型；每个模型可单独改上下文、端点与采样参数，点闪电测试连接。</p>`,
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
  const fmt = normalizeFormat(existing?.format || providerMeta.format);
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
                 ${providerMeta.endpoints.map((e) => `<button class="chip" data-act="pick-scene" data-url="${esc(e.baseUrl)}"${e.format ? ` data-format="${esc(e.format)}"` : ""}>${esc(e.label)}</button>`).join("")}
               </div>`
            : ""
        }
      </div>

      <div class="field">
        <label class="field__label" for="cm-format">接口格式</label>
        <select class="input select" id="cm-format">
          ${FORMAT_IDS.map((id) => `<option value="${id}" ${id === fmt ? "selected" : ""}>${esc(FORMAT_LABELS[id])}</option>`).join("")}
        </select>
        <p class="field__hint" id="cm-format-hint">${esc(FORMAT_HINTS[fmt])}</p>
      </div>

      <div class="field">
        <label class="field__label" for="cm-key">API Key</label>
        <input class="input mono" id="cm-key" type="password" value="${esc(keyOf(slot))}" placeholder="${providerMeta.local ? "本地代理，可留空" : "粘贴 Key，自动保存并拉取可用模型"}" autocomplete="off" spellcheck="false">
        <p class="field__hint">${
          providerMeta.local
            ? "本地代理不校验 Key，留空即可；代理单独设了 token 才需要填。"
            : "只保存在本机。同一服务的模型共用一个 Key，填一次就够。"
        }</p>
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
        <p class="field__hint">${
          providerMeta.local
            ? "不用记 ID：本地代理会直接列出它有哪些模型；ID 要和它路由表里的名字对得上。"
            : "不用记 ID：填好 Key 会自动列出可用模型，点一下就填好并切换。"
        }</p>
        <div id="cm-models" class="cm-models" data-mode="${isNew ? "new" : "edit"}"></div>
      </div>
      <div class="field">
        <div class="field__head">
          <label class="field__label" for="cm-base">Base URL</label>
          <button class="btn btn--ghost btn--sm" data-act="fetch-models">${icon("refresh", "icon--xs")} 获取模型列表</button>
        </div>
        <input class="input mono" id="cm-base" value="${esc(existing?.baseUrl || providerMeta.baseUrl || "")}" placeholder="https://gateway.example.com/v1" spellcheck="false">
        <p class="field__hint" id="cm-endpoint-preview"></p>
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
      <div class="settings__row" style="padding:4px 0 10px" data-gate="effort">
        <div class="settings__row-main">
          <div class="settings__row-title">透传推理强度</div>
          <div class="settings__row-sub">默认开启；端点拒绝 reasoning_effort 时会自动关闭</div>
        </div>
        <button class="switch" role="switch" aria-checked="${existing ? existing.supportsEffort !== false : true}" aria-label="透传推理强度" data-act="toggle-cm-effort" data-toggle="cm-effort"></button>
      </div>
      <div class="settings__row" style="padding:0 0 10px" data-gate="vision">
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
    foot: `
      ${localMcpAvailable() ? `<button class="btn btn--block" data-act="add-local-mcp">${icon("shield", "icon--xs")} 添加本机服务器</button>` : ""}
      <button class="btn btn--primary btn--block" data-act="new-mcp">${icon("plus", "icon--xs")} 添加服务器</button>`,
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

/**
 * 市场里点开一个插件。
 *
 * ============ 为什么需要这一屏 ============
 *
 * 卡片是两列的，描述只能显示三行。而目录里的中文描述中位数 85 字、
 * 最长 161 字，四分之一超过 120 字 —— 被截断的恰恰是「这插件到底
 * 干什么」的关键部分。用户点开就是为了读完它。
 *
 * 顺手多做一件事：查一眼 npm 上的 package.json。目录里没有依赖信息，
 * 而「装上去能不能跑」几乎全由它决定。这一条请求几百字节，
 * 在详情页里等它也值。
 */
function marketPluginSheet(data) {
  const it = data?.item;
  if (!it) {
    return sheetFrame({
      title: "插件详情",
      body: `<div class="empty-line"><b>这条记录丢了</b>回到列表再点一次。</div>`,
      foot: `<button class="btn btn--ghost" data-act="close-sheet" style="flex:1">关闭</button>`,
    });
  }

  const installed = (state.nodePlugins || []).some((p) => String(p.id || "") === pluginIdOf(it.name));
  const repo = String(it.repo || "").replace(/^https?:\/\//, "").replace(/\.git$/, "");
  const ago = formatAgo(it.updatedAt);

  // 描述：中文优先，英文作为补充。两者都可能有，也可能都没有。
  const zh = String(it.desc || "").trim();
  const en = String(it.descEn || "").trim();
  // 目录里的说明本身就有 12% 是截断的（以省略号结尾）——
  // 那不是我们截的，是数据源截的。不说清楚，用户会以为详情页也能看全。
  const cutByCatalog = /(…|\.\.\.)$/.test(zh) || /(…|\.\.\.)$/.test(en);
  const cutNote = cutByCatalog
    ? `<p class="mk-detail__note">目录里的说明到这里就结束了，更详细的写在仓库的 README 里。</p>`
    : "";

  const descBlock = `${
    zh
      ? `<p class="mk-detail__text">${esc(zh)}</p>${
          en && en !== zh ? `<p class="mk-detail__text mk-detail__text--en">${esc(en)}</p>` : ""
        }`
      : en
      ? `<p class="mk-detail__text">${esc(en)}</p>`
      : `<p class="mk-detail__text mk-detail__text--en">目录里没有写说明。</p>`
  }${cutNote}`;

  const pre = data?.pre || null;
  const preLoading = data?.preLoading;
  const preError = data?.preError;

  let preBlock;
  if (preLoading) {
    preBlock = `<div class="mk-detail__pre mk-detail__pre--wait">正在查 npm 上的包信息…</div>`;
  } else if (pre) {
    const deps = pre.deps || [];
    const peers = pre.peers || [];
    const rows = [];

    if (deps.length) {
      rows.push(`<div class="mk-detail__flag mk-detail__flag--warn">
        <b>声明了 ${deps.length} 个依赖</b>
        <span>${esc(deps.slice(0, 4).join("、"))}${deps.length > 4 ? "…" : ""}</span>
        <span>手机端不能 npm install。包里若没带 node_modules，加载时会报 Cannot find module。</span>
      </div>`);
    } else {
      rows.push(`<div class="mk-detail__flag mk-detail__flag--ok">
        <b>没有声明依赖</b><span>装上就能跑的可能性大。</span>
      </div>`);
    }

    if (pre.hasClient) {
      rows.push(`<div class="mk-detail__flag">
        <b>带界面部分</b>
        <span>它在 dsh web 宿主里会往界面挂东西。本机不渲染，但工具与模型照常生效。</span>
      </div>`);
    }

    if (peers.length) {
      // 只列两个：这些名字又长又技术，列四个会占两行，
      // 而用户真正关心的是「有没有我这边提供不了的」—— 数量比名字更能说明。
      rows.push(`<div class="mk-detail__kv"><span>宿主依赖</span><b>${esc(
        peers.slice(0, 2).join("、")
      )}${peers.length > 2 ? ` 等 ${peers.length} 个` : ""}</b></div>`);
    }
    if (pre.main) {
      rows.push(`<div class="mk-detail__kv"><span>入口</span><b class="mono">${esc(pre.main)}</b></div>`);
    }
    if (pre.enginesNode) {
      rows.push(`<div class="mk-detail__kv"><span>Node 要求</span><b>${esc(pre.enginesNode)}</b></div>`);
    }

    preBlock = `<div class="mk-detail__pre">${rows.join("")}</div>`;
  } else {
    preBlock = preError
      ? `<div class="mk-detail__pre mk-detail__pre--wait">没查到 npm 上的包信息：${esc(
          preError
        )}<br>不影响安装，只是少了这项参考。</div>`
      : "";
  }

  const foot = installed
    ? `<button class="btn btn--ghost" data-act="close-sheet" style="flex:1">关闭</button>
       <div style="flex:1.4;display:flex;align-items:center;justify-content:center">
         <span class="mk-card__done">已装在这台设备上</span>
       </div>`
    : `<button class="btn btn--ghost" data-act="close-sheet" style="flex:1">关闭</button>
       <button class="btn btn--primary" data-act="market-install" style="flex:1.4"
         data-name="${esc(it.name)}" data-version="${esc(it.version)}">安装</button>`;

  return sheetFrame({
    title: esc(it.title),
    desc: `<span class="mono" style="font-size:11px">${esc(it.name)}</span>`,
    body: `
      <div class="mk-detail__meta">
        ${it.category ? `<span class="mk-detail__tag">${esc(it.category)}</span>` : ""}
        ${it.version ? `<span class="mk-detail__tag mk-detail__tag--mono">v${esc(it.version)}</span>` : ""}
        ${ago ? `<span class="mk-detail__tag mk-detail__tag--dim">更新于 ${esc(ago)}</span>` : ""}
      </div>

      ${descBlock}

      ${
        repo
          ? `<button class="mk-detail__link" data-act="market-copy-repo">
               <span class="mono">${esc(repo)}</span>
               <span class="mk-detail__link-hint">点击复制</span>
             </button>`
          : ""
      }

      <div class="section-label">装之前</div>
      ${preBlock}

      <div id="ni-progress" class="field__hint" style="margin-top:12px"></div>`,
    foot,
  });
}

/**
 * 插件详情 —— 它到底带来了什么。
 *
 * ============ 为什么值得单独一屏 ============
 *
 * 装完插件，用户第一个问题是「它给了什么」。列表里只有
 * 「名字 · 版本 · N 个工具」，看不到工具叫什么、提供了哪些模型、
 * 卡在哪个依赖上。而这几件事恰好是判断「这插件有用吗」的全部依据。
 */
function nodePluginSheet(data) {
  const detail = data?.detail || null;
  const err = data?.error || "";

  if (!detail) {
    return sheetFrame({
      title: "插件详情",
      desc: data?.id || "",
      body: err
        ? `<div class="empty-line"><b>读不到详情</b>${esc(err)}</div>`
        : `<div class="empty-line">正在问 Node 要数据…</div>`,
      foot: `<button class="btn btn--ghost" data-act="close-sheet" style="flex:1">关闭</button>`,
    });
  }

  const p = detail.plugin || {};
  const tools = Array.isArray(detail.tools) ? detail.tools : [];
  const routes = Array.isArray(detail.routes) ? detail.routes : [];
  const pending = p.status === "pending";

  const statusLine = pending
    ? `在等 ${(p.pendingDeps || []).join("、") || "依赖"}`
    : p.status === "active"
    ? "已加载，正在运行"
    : p.status === "failed"
    ? `加载失败：${p.error || "未知原因"}`
    : p.status === "not-loaded"
    ? "文件在，但没加载起来（看 Node 日志）"
    : String(p.status || "未知");

  const toolBlocks = tools.length
    ? tools
        .map(
          (t) =>
            `<div class="kv"><span class="mono">${esc(t.name)}</span><b style="text-align:right;max-width:62%">${esc(
              t.description || "（无说明）"
            )}</b></div>`
        )
        .join("")
    : `<p class="field__hint">这个插件没有注册工具。</p>`;

  const routeBlocks = routes.length
    ? routes
        .map((r) => {
          const models = Array.isArray(r.models) ? r.models : [];
          const list = models.length
            ? models
                .map(
                  (m) =>
                    `<div class="kv"><span class="mono">${esc(m.id)}</span><b>${esc(m.name || m.id)}${
                      m.contextWindow ? ` · ${fmtContext(m.contextWindow)}` : ""
                    }</b></div>`
                )
                .join("")
            : r.error
            ? ""
            : `<p class="field__hint">这个路由眼下没有模型（可能还没探测，或需要配置）。</p>`;
          return `
            <div class="kv"><span>路由</span><b class="mono">${esc(r.provider)}</b></div>
            ${r.name && r.name !== r.provider ? `<div class="kv"><span>名称</span><b>${esc(r.name)}</b></div>` : ""}
            ${r.error ? `<p class="field__hint" style="color:var(--warn,#d9a441)">清单查不到：${esc(r.error)}</p>` : ""}
            ${list}`;
        })
        .join("")
    : `<p class="field__hint">${
        detail.routeCount
          ? "它没有提供模型 —— 可能只提供工具。"
          : "还没有任何模型供应方注册。"
      }</p>`;

  return sheetFrame({
    title: esc(p.name || p.id || "插件"),
    desc: `${esc(p.id || "")} · v${esc(p.version || "0.0.0")}`,
    body: `
      <div class="kv"><span>状态</span><b style="color:${
        pending
          ? "var(--warn,#d9a441)"
          : p.status === "failed"
          ? "var(--danger,#e5484d)"
          : "var(--ok,#5ac08a)"
      }">${esc(statusLine)}</b></div>
      <div class="kv"><span>形态</span><b>${p.kind === "package" ? "npm 包" : "单文件脚本"}</b></div>
      ${
        p.entry
          ? `<div class="kv"><span>入口</span><b class="mono" style="font-size:10px;word-break:break-all;text-align:right;max-width:64%">${esc(
              p.entry
            )}</b></div>`
          : ""
      }

      <div class="section-label">工具 · ${tools.length}</div>
      ${toolBlocks}

      <div class="section-label">模型</div>
      ${routeBlocks}

      <div style="display:flex;gap:8px;margin-top:18px">
        <button class="btn btn--ghost btn--sm" data-act="node-reload-one" data-id="${esc(p.id || "")}" style="flex:1">重载</button>
        <button class="btn btn--ghost btn--sm" data-act="node-uninstall" data-id="${esc(p.id || "")}"
          style="flex:1;color:var(--danger,#e5484d)">卸载</button>
      </div>`,
    foot: `<button class="btn btn--primary" data-act="close-sheet" style="flex:1">关闭</button>`,
  });
}

/**
 * 安装 Node 插件。
 *
 * ============ 为什么要有安全提示 ============
 *
 * 插件不是沙箱里的东西：它在 Node 里跑，能读工作区、能发网络请求、
 * 能起定时器。装一个插件等于把权限交给它。
 *
 * 所以这里不写「一键安装，轻松扩展」那种话 —— 先把风险说清楚，
 * 用户同意之后才装。
 */
function nodeInstallSheet() {
  return sheetFrame({
    title: "安装 Node 插件",
    desc: "支持 .zip / .tar.gz / .tgz，或单个 .js 文件",
    body: `
      <div class="field">
        <label class="field__label" for="ni-url">插件包网址</label>
        <input class="input mono" id="ni-url" placeholder="https://…/plugin.zip" autocomplete="off" spellcheck="false">
        <p class="field__hint">GitHub Release 的 zip、npm pack 出来的 .tgz 都行。装进工作区的 plugins/ 目录。</p>
      </div>
      <button class="btn btn--ghost btn--block" data-act="node-install-file">从手机选择文件…</button>
      <div class="field" style="margin-top:14px">
        <div id="ni-progress" class="field__hint" aria-live="polite">还没有开始。</div>
      </div>
      <p class="field__hint" style="color:var(--warn,#d9a441);display:flex;gap:6px;align-items:flex-start">
        ${icon("shield", "icon--xs")}
        <span>插件是在你设备上运行的 JavaScript：能读写工作区文件、发起网络请求。
        只装你信得过的来源。装完可以在设置里随时卸载。</span>
      </p>`,
    foot: `<button class="btn btn--ghost" data-act="close-sheet" style="flex:1">关闭</button>
           <button class="btn btn--primary" data-act="node-install-url" style="flex:1.4">安装</button>`,
  });
}

/**
 * 装完之后让 Node 真的把插件跑起来，并把它的模型同步进选择器。
 *
 * 三步都不做的话，用户会看到「装好了但列表里没有」——那正是我们
 * 前几个版本反复踩的坑。
 */
async function afterNodePluginChange() {
  // 插件文件是直接用 fs 写的，没走 store 的 writeFile ——
  // 所以工作区索引里没有它们，列表里会看不见。
  // 同步一次索引，让「装好了但工作区里找不到」这种事不发生。
  try {
    await syncIndex("workspace");
  } catch {
    /* 索引同步失败不影响组装载 */
  }
  try {
    // 只加载新来的插件 —— 已在跑的那些不能重跑
    // （重跑会出现两个实例同时跑，宿主服务注册也会撞车）
    await loadNewNodePlugins();
  } catch {
    /* 通道没连上时加载会失败，但文件已经装好了 */
  }
  await refreshDepCache();
  await syncNodePluginList();
  try {
    await syncNodeLlmModels();
  } catch {
    /* 模型同步失败不该盖掉安装结果 */
  }
  renderMain(true);
}

/** 统一的安装流程（网址 / 文件共用）。 */
async function runNodeInstall(source) {
  const box = $("#ni-progress");

  /**
   * 进度出口。
   *
   * 同时更新三个地方，因为它们解决的是三个不同的问题：
   *   · 面板里的那行字 —— 看得懂「现在在干什么」
   *   · 卡片里的进度条 —— 看得见「在动」
   *   · done/total 计数 —— 看得出「还要多久」
   */
  const say = (t, done, total) => {
    if (box) box.textContent = t;
    const inst = ui.market.installing;
    if (inst) {
      inst.stage = t;
      if (typeof done === "number") inst.done = done;
      if (typeof total === "number") inst.total = total;
      if (ui.view === "plugins" && ui.pluginsTab === "market") paintMarket();
    }
  };

  const fromMarket = Boolean(ui.market.installing);
  say("准备…");
  try {
    const r = await installNodePlugin({ ...source, onProgress: say });
    const warns = Array.isArray(r.warnings) ? r.warnings : [];
    const clientNote = r.hasClient ? "它的界面部分在本机不渲染（需要 dsh web 宿主），工具/模型照常生效。" : "";
    const depNote = r.deps
      ? ` · 依赖 ${r.deps.packages} 个包 / ${Math.round((r.deps.bytes || 0) / 1024)} KB`
      : "";
    say(
      `已安装 ${r.name} v${r.version} · ${r.installed} 个文件${depNote}${
        warns.length ? "（有警告）" : ""
      }`
    );
    ui.market.installing = null;
    await afterNodePluginChange();
    closeSheet(true);

    // ============ 装完要让人找得到 ============
    //
    // 从市场装的，装完直接跳到「已安装」并高亮那一行。
    // 只弹个 toast 是不够的 —— 用户下一步的动作一定是「看看它长什么样」，
    // 而那时他还停在市场列表里，得自己猜去哪儿找。
    if (fromMarket) {
      ui.pluginsTab = "node";
      ui.highlightPlugin = r.id;
      renderMain(true);
      setTimeout(() => {
        if (ui.highlightPlugin === r.id) {
          ui.highlightPlugin = "";
          if (ui.view === "plugins" && ui.pluginsTab === "node") renderMain(true);
        }
      }, 3200);
    }

    if (warns.length) toast(warns[0], "err");
    else if (r.deps) toast(`已安装 ${r.name}，依赖 ${r.deps.packages} 个包`);
    else if (clientNote) toast(clientNote);
    else toast(`已安装 ${r.name}`, "ok");
  } catch (e) {
    const msg = String((e && e.message) || e);
    ui.market.installing = null;
    say("安装失败：" + msg);
    toast(msg, "err");
    if (fromMarket) paintMarket();
  }
}

function nodeLogSheet(data) {
  const raw = String(data?.text || "");
  const text = raw.trim();
  let body;
  if (!text) {
    body = `<div class="empty-line">
      <b>日志是空的</b>
      Node 可能还没真正跑起来过，或者日志被清空了（超过 200 KB 会滚动）。
    </div>`;
  } else {
    body = `
      <pre class="input mono" style="white-space:pre-wrap;word-break:break-all;max-height:54vh;overflow:auto;font-size:11px;line-height:1.6;margin:0">${esc(text)}</pre>
      <p class="dim" style="font-size:12px;margin:10px 0 0;line-height:1.6">
        只显示最后 8 KB。找「通道」「错误」「error」这几行，
        它们会写明连不上的具体原因。
      </p>`;
  }
  return sheetFrame({
    title: "Node 日志",
    desc: "排查「运行中但通道未连接」看这里",
    body,
    foot: `<button class="btn btn--ghost" data-act="close-sheet" style="flex:1">关闭</button><button class="btn btn--primary" data-act="copy-node-log" style="flex:1.4">复制</button>`,
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
        p.codePath
          ? `<div class="section-label">沙箱</div>
             <div class="kv"><span>来源</span><b class="mono" style="font-size:10px">${esc(
                 String(p.source || "官方清单").slice(0, 48)
               )}</b></div>
             <div class="kv"><span>申请能力</span><b>${
               (p.permissions || []).length
                 ? esc(p.permissions.map((x) => PERMISSION_LABEL[x] || x).join(" · "))
                 : "无"
             }</b></div>
             <div class="kv"><span>运行环境</span><b>独立 iframe 沙箱</b></div>
             <p class="field__hint" style="line-height:1.8">插件代码跑在独立 origin 的 iframe 里，读不到本应用的模型 Key、localStorage、其它会话与界面。<br>它能碰到的只有上面列出的能力，且每次工具调用仍会弹审批。</p>`
          : ""
      }
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
             <p class="field__hint" style="line-height:1.8">Markdown → Word（.docx，保留标题、列表、表格）<br>Markdown → PowerPoint（.pptx，封面 / 要点 / 表格三种版式，16:9）<br>CSV → Excel（.xlsx，保留表头与列宽）<br>Markdown / 排版原语 → PDF（.pdf，中文字体按需子集嵌入）<br>读 PDF 正文（按页提取；扫描件会明确说读不出）<br>产物写入 <code>exports/</code>，在工作区下载。</p>`
          : ""
      }
      ${
        p.id === "teams"
          ? (() => {
              const board = (state.team?.runs || [])[0];
              if (!board) {
                return `<div class="section-label">团队任务板</div>
                  <p class="field__hint" style="line-height:1.8">还没有团队任务。在对话里把目标拆开说，例如「分三路查一下 A、B、C，再汇总」，模型会调用 <code>agent_team</code>。</p>`;
              }
              const rows = (board.items || [])
                .map(
                  (it, i) =>
                    `<div class="kv"><span>${it.status === "done" ? "✓" : it.status === "error" ? "✗" : "…"} 成员 ${i + 1}</span><b>${
                      it.title ? esc(it.title) : "（未命名）"
                    }</b></div>`
                )
                .join("");
              const last = (board.items || []).find((it) => it.output) || {};
              return `<div class="section-label">团队任务板 · 最近一次</div>
                <div class="kv"><span>目标</span><b>${esc(board.goal || "（未命名）")}</b></div>
                <div class="kv"><span>时间</span><b>${fmtRelative(board.at)}</b></div>
                ${rows}
                ${
                  last.output
                    ? `<p class="field__hint" style="line-height:1.8">成员 1 的结论：${esc(String(last.output).slice(0, 160))}</p>`
                    : ""
                }`;
            })()
          : ""
      }
      ${
        p.id === "review"
          ? `<div class="section-label">复核记录</div>
             <div class="stat-row" style="margin-bottom:10px">
               <div class="stat"><div class="stat__val">${Number(state.review?.scans) || 0}</div><div class="stat__key">已复核</div></div>
               <div class="stat"><div class="stat__val">${Number(state.review?.blocked) || 0}</div><div class="stat__key">已拦下</div></div>
               <div class="stat"><div class="stat__val">${p.enabled ? "ON" : "OFF"}</div><div class="stat__key">状态</div></div>
             </div>
             <p class="field__hint" style="line-height:1.8">每次敏感调用进入审批前先复核一次：路径越界、通配删除、递归删根目录、<code>find -delete</code>、远程脚本直通 shell，命中就拦下。<br>它只会否决，不会替你点「允许」；自动放行仍由审批策略决定。</p>`
          : ""
      }
      <p class="field__hint" style="margin-top:12px">${
        p.preinstalled
          ? "内置插件随内核提供，不需要下载；关掉只是停用，随时能再打开。"
          : "关闭开关会从当前上下文中卸载该插件，已经挂载的界面槽位会在下一次渲染时移除。"
      }</p>`,
    foot:
      p.preinstalled
        ? `<button class="btn btn--ghost btn--block" data-act="close-sheet">完成</button>`
        : `<button class="btn btn--danger" data-act="uninstall-plugin" data-id="${p.id}" style="flex:1">卸载</button>
           <button class="btn btn--primary" data-act="close-sheet" style="flex:1.3">完成</button>`,
  });
}

/**
 * 插件安装面板。
 *
 * 两个来源：
 *   1. 官方清单（内置，离线可用）
 *   2. 任意 URL —— 填一个插件清单地址
 *
 * 安装前会先拉清单、列出它要申请哪些权限，用户看清再决定。
 */
function pluginSearchSheet() {
  const installed = new Set(state.plugins.map((p) => p.id));
  const list = searchOfficialPlugins(ui.pluginQuery);
  const url = ui.pluginUrl || "";

  return sheetFrame({
    title: "安装插件",
    desc: "从官方清单安装，或直接填一个插件清单地址。",
    body: `
      <div class="field">
        <label class="field__label" for="plugin-url">插件清单地址</label>
        <input class="input mono" id="plugin-url" value="${esc(url)}"
          placeholder="https://example.com/dsh-plugin.json" spellcheck="false" autocomplete="off">
        <button class="btn btn--primary btn--block" style="margin-top:8px" data-act="plugin-fetch-url">${icon(
          "download",
          "icon--xs"
        )} 拉取并检查</button>
      </div>

      <div id="plugin-inspect">${pluginInspectCard(ui.pluginInspect)}</div>

      <div class="section-label">官方清单</div>
      <div class="input-suffix" style="margin-bottom:10px">
        <input class="input" id="catalog-search" placeholder="搜索插件" value="${esc(ui.pluginQuery || "")}" autocomplete="off">
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
                <span class="tag">官方</span>
              </div>
              <p class="plugin-card__desc">${esc(p.description)}</p>
              <div class="plugin-card__tags">
                <span class="tag">v${esc(p.version)}</span>
                ${(p.permissions || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}
              </div>
            </div>
            ${
              installed.has(p.id)
                ? `<span class="tag tag--on">已安装</span>`
                : `<button class="btn btn--sm btn--ghost" data-act="install-plugin" data-id="${esc(p.id)}">安装</button>`
            }
          </div>`
                )
                .join("")
            : `<div class="empty-line">没有匹配的插件</div>`
        }
      </div>

      <p class="field__hint" style="margin-top:12px;line-height:1.8">
        插件代码跑在独立的 iframe 沙箱里，<b>拿不到</b>本应用的模型 Key、localStorage、其它会话与界面。<br>
        它能碰到的只有清单里显式声明的能力，且每次调用仍会弹审批。
      </p>`,
  });
}

/**
 * 已拉取到的插件清单预览（含权限说明与安装按钮）。
 */
function pluginInspectCard(ins) {
  if (!ins) return "";
  const p = ins.plugin;
  const permText = (p.permissions || []).length
    ? p.permissions.map((x) => PERMISSION_LABEL[x] || x).join(" · ")
    : "不申请任何宿主能力";
  return `
    <div class="card" style="margin-bottom:14px">
      <div class="card__row">
        <span class="avatar avatar--accent" style="width:38px;height:38px">${icon("puzzle", "icon--sm")}</span>
        <div style="flex:1">
          <div class="card__title">${esc(p.name)}</div>
          <div class="card__sub">${esc(p.description || "")}</div>
        </div>
      </div>
      <div class="kv" style="margin-top:8px"><span>版本</span><b>${esc(p.version)}</b></div>
      <div class="kv"><span>作者</span><b>${esc(p.author || "未知")}</b></div>
      <div class="kv"><span>来源</span><b class="mono" style="font-size:10px">${esc(String(ins.source || "").slice(0, 60))}</b></div>
      <div class="kv"><span>申请能力</span><b>${esc(permText)}</b></div>
      <div class="kv"><span>提供工具</span><b>${p.tools.length ? esc(p.tools.map((t) => t.name).join(" · ")) : "运行后由插件自行注册"}</b></div>
    </div>
    ${
      (ins.warnings || []).length
        ? `<div class="key-warning" style="flex-direction:column;gap:4px;margin-bottom:12px">
             ${ins.warnings.map((w) => `<span>· ${esc(w)}</span>`).join("")}
           </div>`
        : ""
    }
    <button class="btn btn--primary btn--block" style="margin-bottom:14px" data-act="plugin-confirm-install">${icon(
      "check",
      "icon--xs"
    )} 安装这个插件</button>`;
}

/** 权限名的中文说明。 */
const PERMISSION_LABEL = {
  "fs.read": "读取工作区文件",
  "fs.write": "写入工作区文件",
  net: "发起网络请求",
};

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
  els.drawer.innerHTML = renderDrawerHTML(ui.search || "", ui.run?.sessionId || "");
  // 抽屉整块重写 —— 底部的插件界面要重新贴
  uiAttach(els.drawer);
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
    if (e.target.id !== "composer-input") return;
    ui.composing = true;
    ui.composingAt = Date.now();
  });

  // ============ 组合期间也要跟高度 ============
  //
  // 中文输入法在候选阶段只保证发 `compositionupdate`，**不保证发 `input`**。
  // 有的输入法要等到上屏才派发 input，有的干脆全程只发 composition 系列。
  //
  // 只在 input 里跟高度的话，用户逐字输入时框完全不动 ——
  // 而退格走的是 input（deleteContentBackward），所以"退格一下就涨了"。
  // 用户描述的这个对比，正好指向这里。
  els.app.addEventListener("compositionupdate", (e) => {
    if (e.target.id !== "composer-input") return;
    ui.composingAt = Date.now();
    autoGrow();
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
    // 聚焦期间每 400ms 做两件事：
    //   1. 刷发送键状态（部分输入法上屏不发 input，靠这个兜）
    //   2. 刷输入框高度（同上，任何输入路径漏了都能兜住）
    composerPoll = setInterval(() => {
      updateSendState();
      // 组合输入期间不要再动高度。autoGrow 会先把 height 设成 auto 再读
      // scrollHeight，那是一次破坏性重排；400ms 来一次足以让部分输入法
      // 的候选反复重连，表现就是「字要点一下才上屏」。
      // compositionupdate 事件里已经在跟高度，不会漏掉「第二行看不见」。
      if (!isComposingNow()) growIfChanged();
    }, 400);
  });
  els.app.addEventListener("focusout", (e) => {
    if (e.target.id !== "composer-input") return;
    if (composerPoll) {
      clearInterval(composerPoll);
      composerPoll = null;
    }
    // 离开输入框时组合一定已经结束（键盘都收了）。
    // 这里不复位的话，标志会带着 true 活到下一次聚焦。
    ui.composing = false;
  });

  els.app.addEventListener("input", (e) => {
    const t = e.target;

    if (t.id === "cm-model-filter") {
      filterFormModels(t.value);
      return;
    }

    // 「选择模型」搜索：只切可见性，不重绘，避免输入时失焦
    if (t.id === "model-pick-search") {
      const q = t.value.trim().toLowerCase();
      const list = $("#model-pick-list");
      if (!list) return;
      list.querySelectorAll("[data-mgroup]").forEach((group) => {
        let shown = 0;
        group.querySelectorAll("[data-msearch]").forEach((card) => {
          const hit = !q || String(card.dataset.msearch || "").includes(q);
          card.style.display = hit ? "" : "none";
          if (hit) shown++;
        });
        group.style.display = shown ? "" : "none";
      });
      return;
    }

    // 改端点：先把「实际请求会打到哪」画出来（即时反馈、不用等网络），
    // 再等手停下来 600ms 才探测 —— 边打边发请求既费配额也没意义。
    if (t.id === "cm-base") {
      renderEndpointPreview();
      scheduleProbe({ delay: 600 });
      return;
    }

    if (t.id === "market-q") {
      ui.market.query = t.value;
      ui.market.limit = 40;
      // 只重绘列表，不动输入框 —— 整页重绘会把光标弄丢
      clearTimeout(ui.marketTimer);
      ui.marketTimer = setTimeout(paintMarket, 160);
      return;
    }

    if (t.id === "composer-input") {
      // 先自愈再判断，否则第一次输入的 "/" 会被残留标志挡掉
      if (ui.composing && e.inputType && e.inputType !== "insertCompositionText") {
        ui.composing = false;
      }
      if (e.inputType === "insertCompositionText") ui.composingAt = Date.now();

      if (t.value === "/" && !isComposingNow()) {
        t.value = "";
        ui.draft = "";
        updateSendState();
        openSheet("commands");
        return;
      }
      // 组合输入期间只记值、不重绘按钮（重绘才是真会打断输入法的操作）；
      // 高度照常跟 —— 高度不改 value，但"看不见正在输的字"是硬伤。
      ui.draft = t.value;
      autoGrow();
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

    if (t.id === "plugin-url") {
      ui.pluginUrl = t.value;
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

    // 「允许控制的应用」勾选：白名单是本机 MCP 的唯一授权凭据
    if (t.matches?.('input[data-act="toggle-local-app"]')) {
      const pkg = t.value;
      if (t.checked) {
        addAllowed(pkg);
        toast(`已允许控制 ${pkg}`, "ok");
      } else {
        removeAllowed(pkg);
        toast(`已取消 ${pkg} 的控制权限`);
      }
      renderMain(ui.view !== "chat");
      return;
    }

    // 表单内直接填 Key：存下并立刻探测模型（显式动作，跳过缓存）
    if (t.id === "cm-key") {
      const slot = $("#cm-provider")?.value || "custom";
      const { key, notes } = normalizeApiKey(t.value);
      setSettings({ keys: { ...state.settings.keys, [slot]: key } });
      if (notes.length) toast(`已自动清理 Key：${notes.join("、")}`, "ok");
      if (key) scheduleProbe({ force: true });
      else renderProbe();
      return;
    }

    // 换接口格式：图片 / 推理强度两个开关要跟着灰，探测也要按新协议重来
    if (t.id === "cm-format") {
      syncFormatGates();
      renderEndpointPreview();
      scheduleProbe({ force: true });
      return;
    }

    // 探测结果里的多选
    if (t.matches?.("input[data-cm-pick]")) {
      toggleProbePick(t.value, t.checked);
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
      // 换供应方 = 换协议：把预设格式写回下拉，再按新格式决定开关能不能用
      const fmtSel = $("#cm-format");
      if (fmtSel && meta.format) fmtSel.value = normalizeFormat(meta.format);
      syncFormatGates();
      renderEndpointPreview();
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
          .map((e) => `<button class="chip" data-act="pick-scene" data-url="${esc(e.baseUrl)}"${e.format ? ` data-format="${esc(e.format)}"` : ""}>${esc(e.label)}</button>`)
          .join("")}`;
      }
      const nextKey = keyOf(t.value);
      const keyInput = $("#cm-key");
      if (keyInput) {
        keyInput.value = nextKey;
        // 切到本地代理时，Key 这一栏的语气要跟着变：
        // 还写着「粘贴 Key」会让人以为不填就不给用。
        keyInput.placeholder = meta.local ? "本地代理，可留空" : "粘贴 Key，自动保存并拉取可用模型";
        const kh = keyInput.closest(".field")?.querySelector(".field__hint");
        if (kh) {
          kh.textContent = meta.local
            ? "本地代理不校验 Key，留空即可；代理单独设了 token 才需要填。"
            : "只保存在本机。同一服务的模型共用一个 Key，填一次就够。";
        }
      }
      if (nextKey) {
        setTimeout(() => {
          if (ui.sheet?.type === "custom-model") scheduleProbe({ force: true });
        }, 80);
      } else if (meta.local) {
        // 本地代理选中即问一句「你有哪些模型」，不用等用户填 Key。
        setTimeout(() => {
          if (ui.sheet?.type === "custom-model") scheduleProbe({ force: true });
        }, 80);
      } else {
        // 没 Key：状态机自己会渲染成「填上 Key 就会列出来」
        cmProbe.status = "needkey";
        cmProbe.items = [];
        cmProbe.selected.clear();
        renderProbe();
      }
      const modelInput = $("#cm-model");
      if (modelInput && meta.suggest?.length) {
        modelInput.placeholder = typeof meta.suggest[0] === "string" ? meta.suggest[0] : meta.suggest[0]?.id || "";
      }
      return;
    }

    if (t.dataset.keyField || t.dataset.providerKey) {
      const slot = t.dataset.providerKey || providerKeyOf();
      // 粘贴进来的 Key 常带空格 / Bearer 前缀 / 换行。存的时候已经洗净，
      // 这里给一句明确反馈，免得用户以为「我填的和刚才不一样了」。
      const { notes } = normalizeApiKey(t.value);
      if (notes.length) toast(`已自动清理 Key：${notes.join("、")}`, "ok");
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
      if (ui.run && !runHere()) {
        const other = runningSession();
        toast(`「${other?.title || "另一个会话"}」正在运行，等它结束或点上方横条查看`, "err");
        return;
      }
      if (runHere()) {
        const value = composerValue().trim();
        if (value) steerRun(value);
        return;
      }
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

  // 从系统设置里改完无障碍开关回到本应用时，界面上的状态必须立刻反映真实情况。
  // 否则用户看到的还是「未开启」，会以为开关又被关掉了 —— 这正是本次要修的观感问题。
  const refreshA11yStatus = () => {
    if (document.visibilityState === "hidden") return;
    if (ui.view !== "settings") return;
    renderMain(true);
  };
  document.addEventListener("visibilitychange", refreshA11yStatus);
  window.addEventListener("pageshow", refreshA11yStatus);
  window.addEventListener("focus", refreshA11yStatus);

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
  const format = normalizeFormat($("#cm-format")?.value);
  // 非 OpenAI 格式这两项本来就用不上，哪怕 aria 残留 true 也不写进去
  const gate = format === "openai";
  return {
    label,
    apiModel,
    baseUrl,
    ctx: Math.round(ctxK * 1000),
    temperature,
    maxTokens,
    format,
    supportsEffort: gate && supportsEffort,
    vision: gate && vision,
  };
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
      // 换过站要把结果说出来：不然用户只看到「成功」，不知道自己填的地址
      // 已经被改掉了，下次换设备又会对不上。
      const note = r.siteNote
        ? `<p style="margin-top:6px;color:var(--warn,#a86400)">${esc(r.siteNote)}</p>`
        : "";
      box.innerHTML = `<div class="model-test model-test--ok">${icon("check", "icon--sm")}
        <div><b>连接成功 · ${fmtClock(r.ms)}</b><p>${esc(r.model)} · ${esc(hostOf(r.endpoint))} · HTTP ${r.status}</p>${note}</div>
      </div>`;
    }
    toast(r.siteSwitched ? "已切换到另一个站点并连接成功" : `连接成功 · ${fmtClock(r.ms)}`, "ok");
    return r;
  } catch (err) {
    if (box) {
      // 401 / 403 的诊断是多行的：服务端原文、读的 Key 槽位、脱敏形态、
      // 自查清单。塞进 toast 会被截掉，这里单独铺开。
      const hint = err.hint
        ? `<pre style="white-space:pre-wrap;word-break:break-word;margin:9px 0 0;padding:9px 10px;background:var(--soft);border-radius:7px;font:11.5px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)">${esc(err.hint)}</pre>`
        : "";
      box.innerHTML = `<div class="model-test model-test--err">${icon("alert", "icon--sm")}
        <div><b>连接失败</b><p>${esc(err.message || "未知错误")}</p>${hint}</div>
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
    format: f.format,
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
  const fmt = normalizeFormat(meta.format);
  const base = String(baseUrl || $("#cm-base")?.value.trim() || meta.baseUrl || "").replace(/\/+$/, "");
  const exists = allModels().find(
    (m) => modelApiId(m) === apiModel && (m.providerKey || "custom") === s && normalizeFormat(m.format) === fmt
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
      format: fmt,
      supportsEffort: fmt === "openai",
      vision: fmt === "openai",
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

/* ============================================================
   端点探测：一个状态机 + 一份多选

   ============ 为什么不是一个函数跑到底 ============
   探测有三种失败：没填、Key 错、网关不提供列表。旧实现把它们
   都塞进同一句"没有取到模型列表"，用户分不清是自己填错还是
   端点不支持。现在状态分开，每种给一句能动手的话。

   竞态也要管：用户改一次 Base URL 就发一次请求，先发后到的
   旧结果会把新结果盖掉。序号 + AbortController 双保险。
   ============================================================ */

const MODEL_LIST_TTL = 10 * 60 * 1000;
const modelListCache = new Map();

const cmProbe = {
  seq: 0,
  timer: 0,
  ctrl: null,
  status: "idle", // idle | needkey | loading | ok | empty | error
  items: [],
  selected: new Set(),
  endpoint: "",
  error: "",
  fromCache: false,
};

const probeSlot = () => $("#cm-provider")?.value || "custom";
const probeFormat = () => normalizeFormat($("#cm-format")?.value || (PROVIDER_META[probeSlot()] || {}).format);
const probeBase = () => String($("#cm-base")?.value || "").trim();
const probeMeta = () => PROVIDER_META[probeSlot()] || PROVIDER_META.custom;
const probeKey = () => {
  const slot = probeSlot();
  const meta = probeMeta();
  // 本地服务（Ollama 原生、LM Studio 一类）不校验 Key，但请求头要有东西占位
  return keyOf(slot) || (meta.local ? meta.placeholderKey || "local" : "");
};

/** 判重用的四元组：换协议、换端点都算不同模型。 */
function modelIdentity(m) {
  return [
    m.providerKey || "custom",
    normalizeFormat(m.format),
    String(modelBaseUrl(m) || "").replace(/\/+$/, ""),
    modelApiId(m),
  ].join("|");
}

function renderEndpointPreview() {
  const el = $("#cm-endpoint-preview");
  if (!el) return;
  const base = probeBase();
  const adapter = FORMATS[probeFormat()] || FORMATS.openai;
  if (!base) {
    el.textContent = "选供应方会预填官方端点，可改；填好 Key 后会自动探测模型。";
    return;
  }
  const model = String($("#cm-model")?.value || "").trim() || "{model}";
  el.innerHTML = `实际请求 <code>${esc(adapter.chatEndpoint(base, model))}</code>`;
}

/** 非 OpenAI 格式下，图片与推理强度这两行没有意义，直接置灰说清楚。 */
function syncFormatGates() {
  const openai = probeFormat() === "openai";
  const pairs = [
    ["effort", "默认开启；端点拒绝 reasoning_effort 时会自动关闭", "仅 OpenAI 格式支持 reasoning_effort"],
    ["vision", "开启后，聊天里的图片按 image_url 发给模型；长边压到 1568px 再发送", "仅 OpenAI 格式支持图片；当前格式会把图片换成一行提示文字"],
  ];
  pairs.forEach(([key, on, off]) => {
    const row = els.sheet?.querySelector(`[data-gate="${key}"]`);
    if (!row) return;
    row.classList.toggle("is-disabled", !openai);
    const sw = row.querySelector(".switch");
    if (sw) {
      sw.disabled = !openai;
      if (!openai) sw.setAttribute("aria-checked", "false");
    }
    const sub = row.querySelector(".settings__row-sub");
    if (sub) sub.textContent = openai ? on : off;
  });
  const hint = $("#cm-format-hint");
  if (hint) hint.textContent = FORMAT_HINTS[probeFormat()];
}

function scheduleProbe({ force = false, delay = 0 } = {}) {
  if (cmProbe.timer) {
    clearTimeout(cmProbe.timer);
    cmProbe.timer = 0;
  }
  if (delay > 0) {
    cmProbe.timer = setTimeout(() => {
      cmProbe.timer = 0;
      probeNow({ force });
    }, delay);
    return;
  }
  probeNow({ force });
}

async function probeNow({ force = false } = {}) {
  const box = $("#cm-models");
  if (!box) return;

  const baseUrl = probeBase();
  const format = probeFormat();
  const slot = probeSlot();
  const key = probeKey();

  if (!baseUrl) {
    cmProbe.status = "idle";
    cmProbe.items = [];
    cmProbe.selected.clear();
    renderProbe();
    return;
  }
  if (!key) {
    cmProbe.status = "needkey";
    cmProbe.items = [];
    cmProbe.selected.clear();
    renderProbe();
    return;
  }

  const cacheKey = `${slot}|${format}|${baseUrl}|${key.slice(-6)}`;
  const cached = modelListCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.ts < MODEL_LIST_TTL) {
    cmProbe.items = cached.items;
    cmProbe.endpoint = cached.endpoint || "";
    cmProbe.fromCache = true;
    cmProbe.status = cached.items.length ? "ok" : "empty";
    renderProbe();
    return;
  }

  if (cmProbe.ctrl) {
    try {
      cmProbe.ctrl.abort();
    } catch {
      /* 已经结束 */
    }
  }
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  cmProbe.ctrl = ctrl;
  const seq = ++cmProbe.seq;

  cmProbe.status = "loading";
  cmProbe.error = "";
  cmProbe.endpoint = (FORMATS[format] || FORMATS.openai).listEndpoint(baseUrl);
  renderProbe();

  try {
    const listed = await fetchModelList({
      format,
      baseUrl,
      apiKey: key,
      providerKey: slot,
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (seq !== cmProbe.seq) return; // 已经有更新的请求了
    // 换了站才列出来：把地址改到表单里，保存时就不会又存回错的。
    if (listed.switchedTo) {
      const input = $("#cm-base");
      if (input && input.value.trim().replace(/\/+$/, "") !== listed.switchedTo) {
        input.value = listed.switchedTo;
        toast("这个 Key 属于另一个 Agnes 站点，地址已自动改好", "ok");
      }
    }
    const items = (listed.items || []).filter((it) => it && it.id);
    modelListCache.set(cacheKey, { items, endpoint: listed.endpoint, ts: Date.now() });
    rememberModelCatalog(slot, baseUrl, items.map((it) => it.id), { format, items });
    cmProbe.items = items;
    cmProbe.endpoint = listed.endpoint || cmProbe.endpoint;
    cmProbe.fromCache = false;
    cmProbe.status = items.length ? "ok" : "empty";
    // 上一轮的勾选只保留仍然存在的
    const alive = new Set(items.map((it) => it.id));
    Array.from(cmProbe.selected).forEach((id) => {
      if (!alive.has(id)) cmProbe.selected.delete(id);
    });
    renderProbe();
  } catch (err) {
    if (seq !== cmProbe.seq) return;
    if (err && err.name === "AbortError") return;
    modelListCache.delete(cacheKey);
    cmProbe.items = [];
    cmProbe.status = "error";
    cmProbe.error = (err && err.message) || "未知错误";
    renderProbe();
  }
}

function renderProbe() {
  const box = $("#cm-models");
  if (!box) return;
  const mode = box.dataset.mode || "new";
  const format = probeFormat();

  if (cmProbe.status === "idle") {
    box.innerHTML = `<p class="field__hint">填好 Base URL 和 Key 后会自动探测；也可以点上方「获取模型列表」。</p>`;
    return;
  }
  if (cmProbe.status === "needkey") {
    box.innerHTML = `<p class="field__hint">填上这个服务的 API Key，就会自动列出可用模型。</p>`;
    return;
  }
  if (cmProbe.status === "loading") {
    box.innerHTML = `<p class="field__hint cm-probe__loading">${icon("loader", "icon--sm icon--loader")} 正在探测 ${esc(FORMAT_LABELS[format])} · ${esc(cmProbe.endpoint)}…</p>`;
    return;
  }
  if (cmProbe.status === "error") {
    box.innerHTML = `<div class="model-test model-test--err">${icon("alert", "icon--sm")}
        <div><b>没有取到模型列表</b><p>${esc(cmProbe.error)}</p></div></div>
      <div class="cm-probe__tools">
        <button class="btn btn--ghost btn--sm" data-act="fetch-models">${icon("refresh", "icon--xs")} 重试</button>
      </div>
      <p class="field__hint">不影响使用：可以点上方「常用模型」，或直接手填模型 ID。</p>`;
    return;
  }
  if (cmProbe.status === "empty") {
    box.innerHTML = `<p class="field__hint">端点通了，但没有返回任何模型（${esc(cmProbe.endpoint)}）。${
      format === "gemini" ? "Gemini 只列支持 generateContent 的模型。" : "可以手填一个 ID 试试。"
    }</p>`;
    return;
  }

  const added = addedIdentities();
  const total = cmProbe.items.length;
  const addedCount = cmProbe.items.filter((it) => added.has(identityOf(it, format))).length;
  const visible = filteredItems();
  const picked = cmProbe.selected.size;

  const status = `<div class="cm-probe">
      <span class="cm-probe__ok">${icon("check", "icon--xs")} ${total} 个模型</span>
      <span class="cm-probe__meta">${esc(cmProbe.endpoint)}${cmProbe.fromCache ? " · 已缓存" : ""}</span>
      ${addedCount ? `<span class="cm-probe__added">${addedCount} 已添加</span>` : ""}
      <button class="btn btn--ghost btn--sm cm-probe__refresh" data-act="fetch-models" aria-label="重新探测">${icon("refresh", "icon--xs")}</button>
    </div>`;

  if (mode === "edit") {
    // 编辑已有模型时是"选一个填进 ID"，不需要批量
    box.innerHTML =
      status +
      `<input class="input" id="cm-model-filter" placeholder="筛选模型…" autocomplete="off" spellcheck="false" style="margin:8px 0">
       <div class="cm-model-list">${visible
         .map(
           (it) =>
             `<button class="chip" data-act="pick-detected-model" data-value="${esc(it.id)}"${
               it.ctx ? ` data-ctx="${it.ctx}"` : ""
             }>${esc(it.id)}</button>`
         )
         .join("")}</div>`;
    return;
  }

  box.innerHTML =
    status +
    `<div class="cm-probe__tools">
       <input class="input" id="cm-model-filter" placeholder="筛选模型…" autocomplete="off" spellcheck="false">
       <button class="btn btn--ghost btn--sm" data-act="select-all-models">全选</button>
       <button class="btn btn--primary btn--sm" data-act="add-selected-models" ${picked ? "" : "disabled"}>加入所选${picked ? `（${picked}）` : ""}</button>
     </div>
     <div class="cm-model-list cm-model-list--rows">${visible
       .map((it) => {
         const isAdded = added.has(identityOf(it, format));
         const checked = cmProbe.selected.has(it.id);
         const meta = [it.label, it.ctx ? fmtContext(it.ctx) : ""].filter(Boolean).join(" · ");
         return `<label class="cm-model-row${isAdded ? " is-added" : ""}">
             <input type="checkbox" data-cm-pick value="${esc(it.id)}" ${checked ? "checked" : ""} ${isAdded ? "disabled" : ""}>
             <span class="cm-model-row__id mono">${esc(it.id)}</span>
             ${isAdded ? `<span class="cm-model-row__badge">已添加</span>` : meta ? `<span class="cm-model-row__meta">${esc(meta)}</span>` : ""}
           </label>`;
       })
       .join("")}</div>`;
}

/** 已经加进模型表的四元组集合。 */
function addedIdentities() {
  const set = new Set();
  allModels().forEach((m) => set.add(modelIdentity(m)));
  return set;
}

function identityOf(item, format) {
  return [probeSlot(), format, probeBase().replace(/\/+$/, ""), item.id].join("|");
}

function filteredItems() {
  const q = String($("#cm-model-filter")?.value || "").trim().toLowerCase();
  if (!q) return cmProbe.items;
  return cmProbe.items.filter(
    (it) => it.id.toLowerCase().indexOf(q) >= 0 || String(it.label || "").toLowerCase().indexOf(q) >= 0
  );
}

/** 筛选只切可见性，不重建列表（否则输入框每敲一个字就失焦）。 */
function filterFormModels(keyword) {
  const box = $("#cm-models");
  if (!box) return;
  const q = String(keyword || "").trim().toLowerCase();
  box.querySelectorAll(".cm-model-row").forEach((row) => {
    const input = row.querySelector("[data-cm-pick]");
    const id = String((input && input.value) || "").toLowerCase();
    row.style.display = !q || id.indexOf(q) >= 0 ? "" : "none";
  });
  box.querySelectorAll(".cm-model-list .chip").forEach((chip) => {
    const v = String(chip.dataset.value || "").toLowerCase();
    chip.style.display = !q || v.indexOf(q) >= 0 ? "" : "none";
  });
}

/** 勾选变化后只更新按钮与计数，不重排列表。 */
function syncProbeSelection() {
  const box = $("#cm-models");
  if (!box) return;
  const btn = box.querySelector('[data-act="add-selected-models"]');
  if (!btn) return;
  const n = cmProbe.selected.size;
  btn.disabled = n === 0;
  btn.textContent = n ? `加入所选（${n}）` : "加入所选";
}

function toggleProbePick(id, on) {
  if (!id) return;
  if (on) cmProbe.selected.add(id);
  else cmProbe.selected.delete(id);
  syncProbeSelection();
}

function selectAllProbe() {
  const added = addedIdentities();
  const format = probeFormat();
  const rows = Array.from(document.querySelectorAll("#cm-models .cm-model-row"));
  const candidates = rows
    .filter((r) => r.style.display !== "none")
    .map((r) => {
      const input = r.querySelector("[data-cm-pick]");
      return input ? { id: input.value, disabled: input.disabled, el: input } : null;
    })
    .filter((x) => x && !x.disabled);

  const allPicked = candidates.length > 0 && candidates.every((c) => cmProbe.selected.has(c.id));
  candidates.forEach((c) => {
    if (allPicked) cmProbe.selected.delete(c.id);
    else cmProbe.selected.add(c.id);
    if (c.el) c.el.checked = !allPicked;
  });
  syncProbeSelection();
}

/** 把勾中的模型一次写进模型表。 */
function addSelectedProbeModels() {
  const ids = Array.from(cmProbe.selected);
  if (!ids.length) return;
  const format = probeFormat();
  const slot = probeSlot();
  const meta = probeMeta();
  const baseUrl = probeBase();
  const added = addedIdentities();
  const picked = cmProbe.items.filter((it) => ids.indexOf(it.id) >= 0 && !added.has(identityOf(it, format)));
  if (!picked.length) {
    toast("这些模型都已经添加过了");
    cmProbe.selected.clear();
    renderProbe();
    return;
  }
  const stamp = Date.now().toString(36);
  const list = picked.map((it, i) => ({
    id: `cm_${stamp}_${i}_${Math.random().toString(36).slice(2, 6)}`,
    label: it.label || it.id,
    apiModel: it.id,
    baseUrl,
    ctx: Number(it.ctx) || knownModelCtx(it.id) || meta.defaultCtx || 128000,
    provider: meta.name,
    providerKey: slot,
    format,
    custom: true,
    // 非 OpenAI 格式没有图片与 reasoning_effort，先记成关闭，
    // 免得以后切格式时被当成"用户主动开启过"。
    vision: format === "openai",
    supportsEffort: format === "openai",
  }));
  const result = addCustomModels(list);
  if (result.length) {
    if (!currentModel()) {
      setSettings({ model: result[0].id });
      verifyModel(result[0].id);
    }
    renderAppbar();
    toast(`已加入 ${result.length} 个模型`, "ok");
  }
  cmProbe.selected.clear();
  renderProbe();
}


function applyCurrentModelFields({ silent = false } = {}) {
  const m = currentModel();
  // 插件提供的模型没有端点 —— 它由 Node 里的 adapter 负责发请求，
  // 所以不能拿「Base URL 不能为空」去卡它（否则用户改个上下文窗口都存不上）。
  const nodeModel = isNodeLlmModel(m);
  const baseUrl = $("#set-base")?.value.trim().replace(/\/+$/, "") || "";
  const apiModel = $("#set-api")?.value.trim() || "";
  const ctxK = Math.max(4, Math.min(2000, Number($("#set-ctx")?.value) || 0));
  if ((!nodeModel && !baseUrl) || !apiModel) {
    toast(nodeModel ? "模型 ID 不能为空" : "Base URL 和模型 ID 都不能为空", "err");
    return false;
  }
  if (!ctxK) {
    toast("上下文窗口至少 4K", "err");
    return false;
  }
  const def = m.defaults || {};
  saveModelOverride(m.id, {
    baseUrl: nodeModel ? undefined : baseUrl !== String(def.baseUrl || "") ? baseUrl : undefined,
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

    case "set-preset": {
      // 首页理论上一定有会话；真没有就补一个，别让按钮点了没反应
      const cur = activeSession() || createSession({ mode: state.settings.mode });
      // 再点一次同一个 = 取消，回到「不注入任何契约」
      const next = cur.preset === value ? null : value;
      setSessionPreset(cur.id, next);
      haptic(5);
      updateMessages();
      if (next && PRESETS[next]) toast(`已切到${PRESETS[next].name}模式`, "ok");
      return;
    }

    case "plugins-tab": {
      const v = String(target.dataset.value || "");
      ui.pluginsTab = v === "page" ? "page" : v === "market" ? "market" : "node";
      renderMain(true);
      if (ui.pluginsTab === "market") ensureMarketLoaded();
      if (ui.pluginsTab === "node") {
        refreshDepCache().then(() => {
          if (ui.view === "plugins" && ui.pluginsTab === "node") renderMain(true);
        });
      }
      return;
    }

    case "market-cat": {
      ui.market.category = String(target.dataset.value || "");
      ui.market.limit = 40;
      paintMarket();
      return;
    }

    case "market-more": {
      ui.market.limit = (Number(ui.market.limit) || 40) + 40;
      paintMarket();
      return;
    }

    case "market-reload": {
      clearCatalogCache();
      ui.market.items = [];
      ui.market.at = 0;
      ui.market.error = "";
      ensureMarketLoaded();
      return;
    }

    case "market-open": {
      const name = String(target.dataset.name || "");
      const item = (ui.market.items || []).find((x) => x.name === name);
      if (!item) {
        toast("这条记录丢了，刷新一下目录", "err");
        return;
      }

      // 先把已知的画出来，别让用户对着空白等网络
      openSheet("market-plugin", { item, preLoading: true });

      // 同一时间只认一个详情面板：网络回来时用户可能已经关了又开了别的
      const stillMine = () =>
        ui.sheet &&
        ui.sheet.type === "market-plugin" &&
        ui.sheet.data &&
        ui.sheet.data.item &&
        ui.sheet.data.item.name === name;

      try {
        const pre = await inspectPackage(name);
        if (stillMine()) {
          ui.sheet.data = { item, pre };
          renderSheet();
        }
      } catch (e) {
        if (stillMine()) {
          ui.sheet.data = { item, preError: String((e && e.message) || e) };
          renderSheet();
        }
      }
      return;
    }

    case "market-copy-repo": {
      const repo = String(ui.sheet?.data?.item?.repo || "");
      if (!repo) return;
      navigator.clipboard?.writeText(repo).then(
        () => toast("仓库地址已复制", "ok"),
        () => toast("复制失败", "err")
      );
      return;
    }

    case "market-install": {
      const name = String(target.dataset.name || "");
      const version = String(target.dataset.version || "");
      if (!name || !version) {
        toast("这个条目没有可安装的版本", "err");
        return;
      }
      // 同时只装一个：依赖解析会互相踩，而且手机上并行下载更慢
      if (ui.market.installing) {
        toast("还有插件在装，等它完成", "err");
        return;
      }

      ui.market.installing = { name, stage: "准备…", done: 0, total: 0 };
      paintMarket();

      (async () => {
        try {
          await runNodeInstall({ url: npmTarballUrl(name, version) });
        } finally {
          if (ui.market.installing && ui.market.installing.name === name) {
            ui.market.installing = null;
            paintMarket();
          }
        }
      })();
      return;
    }

    case "clear-dep-cache": {
      const c = ui.depCache || { count: 0, bytes: 0 };
      openSheet("confirm", {
        title: "清空依赖缓存？",
        desc: `${c.count} 个包 · ${(c.bytes / 1024 / 1024).toFixed(1)} MB`,
        detail:
          "清掉的是下载过的安装包副本，已经装好的插件不受影响。" +
          "之后装新插件时，这些包要重新下载一遍。",
        danger: true,
        confirmText: "清空",
      });
      ui.confirmAction = async () => {
        try {
          await clearDepCache();
          await refreshDepCache();
          renderMain(true);
          toast("缓存已清空", "ok");
        } catch (e) {
          toast(String((e && e.message) || e), "err");
        }
      };
      return;
    }

    case "goto-installed": {
      // 市场卡片上的「已装 · 查看」→ 去已安装列表，并高亮这一行
      const name = String(target.dataset.name || "");
      ui.pluginsTab = "node";
      ui.highlightPlugin = pluginIdOf(name);
      renderMain(true);
      setTimeout(() => {
        if (ui.highlightPlugin === pluginIdOf(name)) {
          ui.highlightPlugin = "";
          if (ui.view === "plugins" && ui.pluginsTab === "node") renderMain(true);
        }
      }, 3200);
      return;
    }

    case "goto-node-plugins": {
      // 设置里的摘要行 → 插件页（Node 分段）
      ui.pluginsTab = "node";
      navigate("plugins");
      return;
    }

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
      const n = sessionFileCount(id);
      openSheet("confirm", {
        title: "删除会话？",
        desc: s?.title,
        detail: n
          ? `会话及其全部消息会从本机删除。该会话工作区的 ${n} 个文件会保留，可在 设置 → 工作区 清理无主文件。`
          : "会话及其全部消息会从本机删除，工作区里没有该会话的私有文件。",
        danger: true,
        confirmText: "删除",
      });
      ui.confirmAction = () => {
        // 删的正好是运行中的会话：先停掉，否则运行器继续往一个已经不在列表里的
        // 会话对象写消息，界面只剩一条指向不存在的会话的运行横条，停也停不掉。
        if (ui.run?.sessionId === id) stopRunAction();
        deleteSession(id);
        forgetShellCwd(id);
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
      const n = sessionFileCount(s.id);
      openSheet("confirm", {
        title: "删除当前会话？",
        desc: s.title,
        detail: n
          ? `会话及其全部消息会从本机删除。该会话工作区的 ${n} 个文件会保留，可在 设置 → 工作区 清理无主文件。`
          : "会话及其全部消息会从本机删除，工作区里没有该会话的私有文件。",
        danger: true,
        confirmText: "删除",
      });
      ui.confirmAction = () => {
        if (ui.run?.sessionId === s.id) stopRunAction();
        deleteSession(s.id);
        forgetShellCwd(s.id);
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
      // 别的会话在跑：当前会话不能发新消息（运行时是全局单通道），
      // 也不能当引导（引导只属于那个会话）。说清楚，别让点击石沉大海。
      if (ui.run && !runHere()) {
        const other = runningSession();
        toast(`「${other?.title || "另一个会话"}」正在运行，等它结束或点上方横条查看`, "err");
        return;
      }
      if (runHere()) {
        if (isComposingNow()) toast("先让输入法确认候选，再点发送");
        else {
          const value = composerValue().trim();
          if (value) steerRun(value);
          else stopRunAction();
        }
      } else if (isComposingNow()) toast("先让输入法确认候选，再点发送");
      else {
        const value = composerValue().trim();
        if (value || ui.attachments.length) sendMessage(value);
      }
      return;

    case "goto-run": {
      const run = ui.run;
      if (!run) {
        updateSendState();
        return;
      }
      switchSession(run.sessionId);
      ui.lastBuilt = null;
      if (ui.view !== "chat") navigate("chat");
      else {
        renderAppbar();
        renderMain(true);
      }
      toast("已回到运行中的会话", "ok");
      return;
    }

    case "stop-live":
      stopRunAction();
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

    case "toggle-flow": {
      const m = (activeSession()?.messages || []).find((x) => x.id === id);
      if (!m) return;
      // 有调用在等审批时不给折：折进去就找不到该点哪里了
      if ((m.tools || []).some((t) => t.status === "waiting")) {
        toast("还有调用在等审批，先处理它");
        return;
      }
      const cur = flowOpen.has(id) ? flowOpen.get(id) : m.status === "running";
      flowOpen.set(id, !cur);
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
      replaceSheet("mode");
      return;

    case "open-model":
      replaceSheet("model");
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
      scheduleProbe({ force: true });
      return;

    case "select-all-models":
      selectAllProbe();
      return;

    case "add-selected-models":
      addSelectedProbeModels();
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
      // 有些供应方一个地址配一种协议（OpenDesign 的 Chat Completions / Messages），
      // 只换地址不换格式会打出一个 404。chip 上带 data-format 时一起切。
      if (target.dataset.format) {
        const fmt = $("#cm-format");
        if (fmt && FORMAT_IDS.includes(target.dataset.format)) {
          fmt.value = target.dataset.format;
          syncFormatGates();
        }
      }
      document.querySelectorAll("#cm-scenes .chip").forEach((chip) => {
        chip.classList.toggle("chip--accent", chip === target);
      });
      renderEndpointPreview();
      scheduleProbe({});
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

    case "toggle-memory": {
      const on = state.settings.memoryEnabled === false;
      setSettings({ memoryEnabled: on });
      renderMain(ui.view !== "chat");
      toast(on ? "长期记忆已开启" : "长期记忆已关闭", "ok");
      return;
    }

    case "toggle-traj": {
      const on = state.settings.trajEnabled === false;
      setSettings({ trajEnabled: on });
      renderMain(ui.view !== "chat");
      toast(on ? "控屏轨迹记录已开启" : "控屏轨迹记录已关闭", "ok");
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

    case "toggle-local-mcp": {
      if (!localMcpAvailable()) {
        toast("当前环境不支持本机控制", "err");
        return;
      }
      const on = !localStatus().enabled;
      if (!setServerEnabled(on)) {
        toast("切换失败", "err");
        return;
      }
      if (on) {
        const n = getAllowedPackages().length;
        toast(
          n
            ? `本机 MCP 已开启，可控制 ${n} 个已勾选的应用`
            : "本机 MCP 已开启，但还没有勾选任何应用",
          n ? "ok" : ""
        );
      } else {
        toast("本机 MCP 已关闭，端口不再监听");
      }
      renderMain(ui.view !== "chat");
      return;
    }

    case "restart-local-mcp": {
      if (!localMcpAvailable()) {
        toast("当前环境不支持本机控制", "err");
        return;
      }
      if (!restartServer()) {
        toast("无法触发重启，请重启应用", "err");
        return;
      }
      toast("正在重新启动本机控制…");
      // 设备进程重建要几百毫秒，稍等一下再刷新，否则读到的还是旧状态
      setTimeout(() => renderMain(ui.view !== "chat"), 900);
      return;
    }

    case "toggle-pointer-mark": {
      if (!localMcpAvailable()) {
        toast("当前环境不支持本机控制", "err");
        return;
      }
      const on = !isPointerMarkEnabled();
      if (!setPointerMarkEnabled(on)) {
        toast("切换失败", "err");
        return;
      }
      // 落点标记只在 :device 里生效，主进程没有对应的运行时状态可同步 ——
      // 重渲染一次，让开关的 aria-checked 从刚写入的文件里读回来即可。
      renderMain(ui.view !== "chat");
      toast(on ? "已开启：AI 点击时会显示落点" : "已关闭落点标记");
      return;
    }

    case "open-shizuku-download": {
      window.open("https://shizuku.rikka.app/download/", "_blank");
      toast("装好后打开 Shizuku，用无线调试启动服务");
      return;
    }

    case "open-shizuku-app": {
      // 服务没在运行 —— 只能由用户去 Shizuku 里启动（应用无权代劳）
      if (!openShizukuApp()) {
        toast("打不开 Shizuku，确认它还在装", "err");
        return;
      }
      toast("在 Shizuku 里点「启动服务」");
      return;
    }

    case "request-shizuku": {
      if (!requestShizukuPermission()) {
        toast("申请失败：Shizuku 可能没在运行", "err");
        return;
      }
      toast("请在 Shizuku 的弹框里选「允许」");
      // 授权对话框是系统弹窗，结果不会立刻回来 —— 稍等再刷一次状态
      setTimeout(() => {
        renderMain(true);
        renderSheet();
      }, 1800);
      return;
    }

    case "connect-shizuku": {
      if (!connectShizuku()) {
        toast("连接失败：当前环境不支持", "err");
        return;
      }
      toast("正在连接 Shizuku…");
      setTimeout(() => {
        renderMain(true);
        renderSheet();
      }, 1200);
      return;
    }

    case "open-app-info-settings": {
      // 打开本应用的「应用信息」页 —— Android 13+ 受限设置的放行入口
      if (!openAppInfoSettings()) {
        toast("无法打开应用信息页，请手动到「设置 → 应用 → DSH」进入", "err");
        return;
      }
      toast("点右上角 ⋮ →「允许受限设置」。请先放行这里，再回到无障碍列表开开关");
      return;
    }

    case "voice-download": {
      if (!voiceDownloadModel()) {
        toast("当前环境不支持下载", "err");
        return;
      }
      setVoiceDownload({ state: "running", pct: 0 });
      renderMain(true);
      return;
    }

    case "toggle-node": {
      const on = state.settings.nodeEnabled === false; // 取反
      setSettings({ nodeEnabled: on });
      if (on) {
        // 运行时还没下载的话，启只是记下意图 ——
        // 不能在这里触发 88 MB 的下载。
        const st = nodeStatus();
        if (st.installed) {
          nodeStart();
          toast("插件运行时已启动");
        } else {
          toast("请先下载运行时");
        }
      } else {
        nodeStop();
        toast("插件运行时已停止");
      }
      renderMain(true);
      return;
    }

    case "node-download": {
      const st = nodeStatus();
      if (st.downloading) {
        toast("正在下载中");
        return;
      }
      if (st.installed) {
        toast("运行时已就绪");
        return;
      }
      if (!nodeDownload()) {
        toast("无法启动下载", "err");
        return;
      }
      toast("开始下载运行时（约 88 MB）");
      renderMain(true);
      return;
    }

    case "node-reload-plugins": {
      // 热重载全部 Node 插件。
      //
      // ============ 为什么不是「再加载一次」 ============
      //
      // 以前的做法是 plugins.load —— 那只是把 apply 再跑一遍：
      //   · 模块缓存没破，代码改了但跑的还是旧的（假重载）
      //   · 旧 fiber 还在，同一个插件两个实例同时跑
      //   · 宿主服务的注册会撞车（settings.register 直接抛错）
      //
      // plugins.reload 才是真重载：卸载 → 破缓存 → 重新加载。
      if (!nodeBridgeAvailable()) {
        toast("当前环境不支持", "err");
        return;
      }
      const btn = target;
      if (btn) btn.disabled = true;
      try {
        const r = await nodeReloadPlugins();
        const results = Array.isArray(r?.results) ? r.results : [];
        const bad = results.filter((x) => !x.ok);
        if (bad.length) {
          // 把第一条失败原因说出来 —— 只说「失败了」用户没法处理
          const first = bad[0];
          toast(`${bad.length} 个插件重载失败：${first.error || "未知原因"}`, "err");
        } else {
          toast(`已重载 ${results.length} 个插件`);
        }
        await refreshNodeTools();
        await syncNodePluginList();
        renderMain(true);
      } catch (err) {
        toast(`重载失败：${err?.message || err}`, "err");
      } finally {
        if (btn) btn.disabled = false;
      }
      return;
    }

    case "node-reload-one": {
      // 重载单个插件。
      //
      // 用户改代码通常只改一个插件，逐个重载比每次全量重载快得多，
      // 也不会把其它正在工作的插件掀掉。
      const id = String(target.dataset.id || "");
      if (!id) return;
      if (!nodeBridgeAvailable()) {
        toast("当前环境不支持", "err");
        return;
      }
      target.disabled = true;
      try {
        const r = await nodeReloadPlugin(id);
        if (r?.ok) {
          toast(`已重载 ${id}`);
        } else {
          // 失败要说清楚：是没换成，还是换了但起不来
          const hint = r?.restored ? "（已回滚到旧版本）" : "";
          toast(`${id} 重载失败：${r?.error || "未知原因"}${hint}`, "err");
        }
        await refreshNodeTools();
        await syncNodePluginList();
        renderMain(true);
      } catch (err) {
        toast(`重载失败：${err?.message || err}`, "err");
      } finally {
        target.disabled = false;
      }
      return;
    }

    case "node-plugin-detail": {
      const id = String(target.dataset.id || "");
      if (!id) return;
      openSheet("node-plugin", { id });
      try {
        const detail = await nodePluginDetail(id);
        // 期间用户可能已经关掉了面板 —— 只更新还停在同一个插件上的那个
        if (ui.sheet && ui.sheet.type === "node-plugin" && ui.sheet.data?.id === id) {
          ui.sheet.data = { id, detail };
          renderSheet();
        }
      } catch (e) {
        if (ui.sheet && ui.sheet.type === "node-plugin" && ui.sheet.data?.id === id) {
          ui.sheet.data = { id, error: String((e && e.message) || e) };
          renderSheet();
        }
      }
      return;
    }

    case "node-install-open": {
      openSheet("node-install");
      return;
    }

    case "node-install-url": {
      const url = $("#ni-url")?.value.trim() || "";
      if (!url) {
        toast("请填插件包网址", "err");
        return;
      }
      await runNodeInstall({ url });
      return;
    }

    case "node-install-file": {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".zip,.tgz,.gz,.js,.mjs,.cjs,application/zip,application/gzip";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        await runNodeInstall({ file });
      };
      input.click();
      return;
    }

    case "node-uninstall": {
      const id = String(target.dataset.id || "");
      if (!id) return;
      openSheet("confirm", {
        title: "卸载这个插件？",
        desc: id,
        detail: "会删掉 plugins/" + id + "/ 下的所有文件。它注册的工具与模型会一起消失，聊天记录不受影响。",
        danger: true,
        confirmText: "卸载",
      });
      ui.confirmAction = async () => {
        try {
          const n = await uninstallNodePlugin(id);
          await afterNodePluginChange();
          toast(`已删除 ${n} 个文件`, "ok");
        } catch (e) {
          toast(String((e && e.message) || e), "err");
        }
      };
      return;
    }

    case "node-log": {
      // 「运行中但通道未连接」只能靠 Node 自己的日志定位 ——
      // 页面看不到 Android/data 下的文件，所以由原生读出来。
      const text = nodeLogTail();
      openSheet("node-log", { text });
      return;
    }

    case "copy-node-log": {
      const text = ui.sheet?.data?.text || "";
      navigator.clipboard?.writeText(text).then(
        () => toast("日志已复制", "ok"),
        () => toast("复制失败，可以长按选择", "err")
      );
      return;
    }

    case "node-selfcheck": {
      // 通道自检：ping 一��，看往返是否正常。
      // 这是排查"插件调不通"时最直接的一步。
      if (!nodeBridgeAvailable()) {
        toast("当前环境不支持", "err");
        return;
      }
      try {
        const t0 = Date.now();
        await nodePing();
        const ms = Date.now() - t0;
        toast(`通道正常（${ms} ms）`);
      } catch (err) {
        toast(`通道异常：${err?.message || err}`, "err");
      }
      return;
    }

    case "voice-permission": {
      if (!requestVoicePermission()) {
        toast("当前环境不支持申请麦克风权限", "err");
        return;
      }
      toast("请在系统弹窗中选择「允许」");
      return;
    }

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
          const hint = err.hint
            ? `<pre style="white-space:pre-wrap;word-break:break-word;margin:8px 0 0;padding:9px 10px;background:var(--soft);border-radius:7px;font:11.5px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)">${esc(err.hint)}</pre>`
            : "";
          if (box) box.innerHTML = `<p class="field__hint" style="color:var(--danger);white-space:pre-wrap">${esc(err.message || "测试失败")}</p>${hint}`;
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
      replaceSheet("workspace");
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

    case "toggle-isolate-workspace":
      setSettings({ isolateWorkspace: state.settings.isolateWorkspace === false });
      toast(state.settings.isolateWorkspace === false ? "已改为所有会话共用" : "已按会话隔离工作区", "ok");
      renderMain(true);
      return;

    case "purge-orphan": {
      const info = orphanWorkspaceInfo();
      if (!info.count) {
        toast("没有需要清理的无主文件", "ok");
        renderMain(true);
        return;
      }
      openSheet("confirm", {
        title: "清理无主文件？",
        desc: `${info.sessions} 个已删除会话`,
        detail: `共 ${info.count} 个文件 · ${(info.bytes / 1024).toFixed(1)} KB。它们属于已经不存在的会话，任何会话都看不到；清理后不可恢复。`,
        danger: true,
        confirmText: "清理",
      });
      ui.confirmAction = async () => {
        const r = await purgeOrphanWorkspace();
        closeSheet();
        renderMain(true);
        toast(`已清理 ${r.removed} 个文件`, "ok");
      };
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

    case "ime-open-settings": {
      openImeSettings();
      return;
    }

    case "ime-switch": {
      switchIme();
      return;
    }

    case "toggle-ime-auto-send": {
      setSettings({ imeAutoSend: !state.settings.imeAutoSend });
      renderMain(true);
      return;
    }

    case "ime-clear-clips": {
      clearClipboard();
      renderMain(true);
      toast("剪贴板历史已清空");
      return;
    }

    case "ime-delete-phrase": {
      const pid = target.dataset.id || "";
      if (!pid) return;
      deletePhrase(pid);
      renderMain(true);
      toast("短语已删除");
      return;
    }

    case "ime-add-phrase": {
      const text = prompt("短语内容");
      if (text === null) return;
      const t = String(text).trim();
      if (!t) {
        toast("内容不能为空", "err");
        return;
      }
      const title = prompt("备注（可留空）");
      savePhrase({ text: t, title: title ? String(title).trim() : "" });
      renderMain(true);
      toast("短语已添加");
      return;
    }

    case "toggle-plugin-watch": {
      const on = !state.settings.pluginWatch;
      setSettings({ pluginWatch: on });
      renderMain(true);

      if (!on) {
        applyPluginWatch(false);
        toast("已停止监听插件目录");
        return;
      }

      // 打开了开关但运行时还没连上：说明白，不要让它看起来"开好了"
      if (!nodeStatus().channelConnected) {
        toast("已开启，等插件运行时连上后开始监听");
        return;
      }
      applyPluginWatch(true).then(() => {
        const w = state.watchStatus;
        if (w && w.running) toast("已开始监听，改插件文件后自动生效");
        else toast(w?.error || "监听没起来：这台设备的 Node 不支持目录监听");
      });
      return;
    }

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

    case "open-selfcheck":
      // 独立页面而不是弹层：自检要能在"界面已经坏了"的情况下也能打开，
      // 而弹层本身依赖界面正常。两者不能共用一条路。
      location.href = "./diagnose.html";
      return;

    case "open-diagnostics":
      openSheet("diagnostics");
      return;

    case "open-memory":
      openSheet("memory");
      return;

    case "delete-memory": {
      const key = target.dataset.key || "";
      if (!key) return;
      removeMemory(key);
      renderSheet();
      toast("已删除这条记忆");
      return;
    }

    case "clear-memories": {
      openSheet("confirm", {
        title: "清空全部记忆？",
        desc: `${memoryStats().total} 条记忆将被删除。`,
        detail: "之后模型将不再有这些「已验证信息」可以依据，回答里的事实性内容可能变差。",
        danger: true,
        confirmText: "全部清空",
      });
      ui.confirmAction = () => {
        clearMemories();
        closeSheet(true);
        renderMain(true);
        toast("记忆已清空");
      };
      return;
    }

    /* ---------------- 控屏轨迹（0.34.0） ---------------- */

    case "open-traj":
      openSheet("traj");
      return;

    case "traj-search": {
      // 检索框是即时反馈的：每次输入都重算一次并重绘。
      // 它是「中文检索到底行不行」的人肉验证器 ——
      // 所以必须能一边打一边看结果，而不是提交后才见分晓。
      ui.trajQuery = target.value || "";
      renderSheet();
      const el = document.getElementById("traj-q");
      if (el) {
        el.focus();
        try {
          el.setSelectionRange(el.value.length, el.value.length);
        } catch {
          /* 某些输入类型不支持 setSelectionRange */
        }
      }
      return;
    }

    case "traj-mark": {
      const id = target.dataset.id || "";
      const outcome = target.dataset.outcome || "";
      if (!id) return;
      setTrajOutcome(id, outcome).then(() => {
        renderSheet();
        toast(outcome === "success" ? "已标记成功 · 进入检索池" : "已标记失败 · 不参与检索");
      });
      return;
    }

    case "traj-del": {
      const id = target.dataset.id || "";
      if (!id) return;
      removeTrajectory(id).then(() => {
        renderSheet();
        toast("已删除这条轨迹");
      });
      return;
    }

    case "clear-traj": {
      openSheet("confirm", {
        title: "清空全部控屏轨迹？",
        desc: `${trajStats().total} 条轨迹将被删除。`,
        detail: "之后模型将不再有这些控屏范例可用，已确认成功的轨迹也无法再被检索到。",
        danger: true,
        confirmText: "全部清空",
      });
      ui.confirmAction = () => {
        clearTrajectories().then(() => {
          closeSheet(true);
          renderMain(true);
          toast("轨迹已清空");
        });
      };
      return;
    }

    case "export-traj": {
      exportTrajCorpus().then((text) => {
        const lines = text ? text.split("\n").filter(Boolean).length : 0;
        if (!lines) {
          toast("还没有可导出的轨迹", "err");
          return;
        }
        // 导出到工作区：这样用户能直接把语料文件取出来做离线评测
        import("./fs.js").then(({ writeDoc }) =>
          writeDoc("workspace", "控屏轨迹语料.jsonl", text).then(() => {
            toast(`已导出 ${lines} 条到工作区「控屏轨迹语料.jsonl」`, "ok");
          })
        );
      });
      return;
    }

    case "open-mcp":
      openSheet("mcp");
      return;

    case "new-mcp":
      openSheet("mcp-server");
      return;

    case "add-local-mcp": {
      // 一键接入本机 MCP：不用手填 URL
      if (!localMcpAvailable()) {
        toast("当前环境不支持本机控制", "err");
        return;
      }
      const cfg = localServerConfig();
      const list = state.settings.mcpServers || [];
      const exist = list.find((x) => x.url === cfg.url);
      if (exist) {
        setSettings({ mcpServers: list.map((x) => (x.id === exist.id ? { ...x, enabled: true } : x)) });
        toast("本机服务器已在列表中，已启用", "ok");
        openSheet("mcp");
        return;
      }
      const id = `mcp_local_${Date.now()}`;
      setSettings({
        mcpServers: [
          ...list,
          { id, name: cfg.name, url: cfg.url, token: cfg.token, enabled: true, tools: [] },
        ],
      });
      toast("已添加本机服务器，去「工具与扩展」勾选允许控制的应用", "ok");
      openSheet("mcp");
      return;
    }

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
      mcpDiscoverWithRetry(server)
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
            title: "导入到当前会话？",
            desc: `${Object.keys(files).length} 个文件`,
            detail: "导入会覆盖当前会话里的同名文件，并清掉本会话多出来的文件；共享文件和其他会话不受影响。建议先导出一份备份。",
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
      // 第三方插件的启停会重建/销毁沙箱，是异步的
      const res = await setPluginEnabled(id, !p.enabled);
      if (!res.ok) {
        toast(res.error || "操作失败", "err");
        return;
      }
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
      ui.pluginUrl = "";
      ui.pluginInspect = null;
      openSheet("plugin-search");
      return;

    case "plugin-fetch-url": {
      const url = String(ui.pluginUrl || "").trim();
      if (!url) {
        toast("先填一个插件清单地址", "err");
        return;
      }
      const box = $("#plugin-inspect");
      if (box) box.innerHTML = `<div class="empty-line">正在拉取…</div>`;
      const ins = await inspectPlugin(url);
      if (!ins.ok) {
        if (box) box.innerHTML = `<div class="key-warning" style="flex-direction:column;gap:4px"><span>· ${esc(ins.error)}</span></div>`;
        toast(ins.error || "拉取失败", "err");
        return;
      }
      ui.pluginInspect = ins;
      if (box) box.innerHTML = pluginInspectCard(ins);
      toast(`已拉取 ${ins.plugin.name}`, "ok");
      return;
    }

    case "plugin-confirm-install": {
      const ins = ui.pluginInspect;
      if (!ins) {
        toast("先拉取一个插件清单", "err");
        return;
      }
      const res = await installPluginPackage(ins.plugin);
      if (!res.ok) {
        toast(res.error || "安装失败", "err");
        return;
      }
      ui.pluginInspect = null;
      ui.pluginUrl = "";
      toast(res.warning ? `已安装，但${res.warning}` : `已安装 ${res.plugin.name}`, res.warning ? "" : "ok");
      renderSheet();
      renderMain(true);
      return;
    }

    case "install-plugin": {
      // 官方清单里的插件：先走一遍 inspect，把权限摊开给用户看
      const ins = await inspectPlugin(id);
      if (!ins.ok) {
        toast(ins.error || "读取插件清单失败", "err");
        return;
      }
      const res = await installPluginPackage(ins.plugin);
      if (!res.ok) {
        toast(res.error || "安装失败", "err");
        return;
      }
      toast(res.warning ? `已安装，但${res.warning}` : `已安装 ${res.plugin.name}`, res.warning ? "" : "ok");
      renderSheet();
      renderMain(true);
      return;
    }

    case "uninstall-plugin": {
      const res = await uninstallPlugin(id);
      if (!res.ok) {
        toast(res.error || "卸载失败", "err");
        return;
      }
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
        sendMessage("用创造模式写一个会话内待办插件：能加一条待办、勾掉一条，数据存在工作区里。");
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
      // 插在光标处，不是拼到句末：用户很可能正把引用放到句子中间
      insertComposerText(`@${path} `);
      closeSheet();
      return;
    }

    case "commands":
      openSheet("commands");
      return;

    case "voice":
      toggleVoice();
      return;

    case "voice-stop":
      // 用户主动结束：等最终结果写进输入框
      stopVoice();
      return;

    case "voice-cancel":
      cancelVoice();
      voiceStripHide();
      return;

    case "new-file":
      replaceSheet("new-file");
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

/* ---------------- 语音输入 ---------------- */

/**
 * 录音条的三个状态：idle（收起）/ listening / finishing。
 *
 * 旧实现只弹一个 toast 就完事，用户说完之前完全不知道它在不在听。
 * 现在有：音量条（证明麦克风真的在工作）、实时转写（证明识别在跑）、
 * 取消与结束按钮（证明用户能控制它）。
 */
let voiceOff = null;

function voiceEls() {
  return {
    strip: document.getElementById("voice-strip"),
    text: document.getElementById("voice-text"),
    bars: document.getElementById("voice-bars"),
    btn: document.getElementById("voice-btn"),
    input: document.getElementById("composer-input"),
  };
}

function voiceStripShow() {
  const { strip, btn } = voiceEls();
  if (strip) strip.hidden = false;
  if (btn) {
    btn.classList.add("is-live");
    btn.setAttribute("aria-pressed", "true");
  }
  els.app?.setAttribute("data-voice", "on");
}

function voiceStripHide() {
  const { strip, btn, bars } = voiceEls();
  if (strip) strip.hidden = true;
  if (btn) {
    btn.classList.remove("is-live");
    btn.setAttribute("aria-pressed", "false");
  }
  if (bars) bars.querySelectorAll("i").forEach((b) => (b.style.height = "3px"));
  els.app?.removeAttribute("data-voice");
}

function voiceStripText(text) {
  const { text: el } = voiceEls();
  if (el) el.textContent = text;
}

function voiceStripLevel(level) {
  const { bars } = voiceEls();
  if (!bars) return;
  // 5 根柱子做相位错开，看起来像真的在跳动，而不是整排一起长
  const base = Math.max(0, Math.min(10, level)) / 10;
  bars.querySelectorAll("i").forEach((b, i) => {
    const phase = [0.66, 1, 0.82, 0.95, 0.72][i];
    const h = 3 + Math.round(base * 15 * phase);
    b.style.height = `${h}px`;
  });
}

function appendVoiceText(text) {
  const t = String(text || "").trim();
  if (!t) return;
  // 走光标处插入：语音转写不该无视用户刚挪好的光标，硬接到句末。
  // 中文之间不加空格、中英混排补空格的规则由 insertComposerText 统一处理。
  insertComposerText(t);
}

/** 点麦克风：不再是一次性调用，而是可开可停的开关。 */
function toggleVoice() {
  const st = voiceState();
  if (st === "listening" || st === "starting") {
    stopVoice();
    return;
  }
  const res = startVoice({ lang: "zh-CN" });
  if (!res.ok) {
    if (res.reason === "no-api") {
      toast("这个浏览器不支持语音识别，APK 内可用", "err");
    } else if (res.reason === "no-service") {
      toast("系统里没有可用的语音识别服务", "err");
    } else {
      toast("语音输入启动失败", "err");
    }
    return;
  }
}

/**
 * 重渲染后把语音相关 DOM 拉回与状态一致。
 *
 * 对话页每次更新都会重建 composer，录音条与麦克风按钮是新的节点 ——
 * 不重新贴一次，就会出现「状态还在 listening，界面上却是静止的」。
 */
function voiceResync() {
  const st = voiceState();
  const strip = document.getElementById("voice-strip");
  const btn = document.getElementById("voice-btn");
  if (!strip || !btn) return;
  if (st === "idle") {
    strip.hidden = true;
    btn.classList.remove("is-live");
    btn.setAttribute("aria-pressed", "false");
    return;
  }
  strip.hidden = false;
  btn.classList.add("is-live");
  btn.setAttribute("aria-pressed", "true");
}

/** 订阅语音状态，驱动录音条。 */
function initVoiceUi() {
  if (voiceOff) voiceOff();
  voiceStripHide();
  voiceOff = onVoiceEvent((e) => {
    if (e.type === "state") {
      // 录音条的显隐完全由状态驱动 —— 这样不管是从 UI 点的，
      // 还是别处直接调 startVoice()，界面都不会和状态对不上。
      if (e.state === "starting" || e.state === "listening") {
        voiceStripText("正在听…");
        voiceStripShow();
      } else if (e.state === "finishing") {
        voiceStripText("正在识别…");
        voiceStripShow();
      } else if (e.state === "idle") {
        voiceStripHide();
      }
      return;
    }
    if (e.type === "download") {
      // 42 MB 的下载必须在界面上有动静，否则用户会以为卡死然后杀掉应用
      if (e.state === "done") {
        setVoiceDownload({ state: "done", pct: 100 });
        toast("离线语音模型已就绪");
        refreshVoicePanel();
      } else if (e.state === "unzip" || e.pct >= 100) {
        setVoiceDownload({ state: "unzip", pct: 100 });
        refreshVoicePanel();
      } else {
        setVoiceDownload({ state: "running", pct: e.pct });
        // 只改进度条，不重建整页 —— 见 paintVoiceProgress 的注释
        paintVoiceProgress(e.pct);
      }
      return;
    }
    if (e.type === "preparing") {
      voiceStripText("正在准备离线语音（首次约几秒）…");
      voiceStripShow();
      return;
    }
    if (e.type === "volume") {
      voiceStripLevel(e.level);
      return;
    }
    if (e.type === "partial") {
      voiceStripText(e.text || "正在听…");
      return;
    }
    if (e.type === "final") {
      appendVoiceText(e.text);
      if (e.text) vibrateShort();
      return;
    }
    if (e.type === "error") {
      // 下载失败要在设置页留个"可重试"的状态，而不是只弹一下就没了
      if (e.code === "download") {
        setVoiceDownload({ state: "error", pct: 0 });
        refreshVoicePanel();
      }
      // 「没听清 / 没检测到说话」不算故障，用中性提示，不弹红
      const soft = e.code === "no_match" || e.code === "speech_timeout";
      toast(e.message, soft ? "" : "err");
      return;
    }
    if (e.type === "empty") {
      voiceStripText("没听到内容");
      const before = composerValue();
      setTimeout(() => {
        if (composerValue() === before && voiceState() === "idle") voiceStripHide();
      }, 600);
      return;
    }
    if (e.type === "permission" && !e.granted) {
      toast("需要麦克风权限才能语音输入", "err");
    }
  });
}

/** 极轻的触感反馈：确认「这句话进去了」。失败无所谓，不是所有设备都有。 */
function vibrateShort() {
  try {
    if (navigator.vibrate) navigator.vibrate(12);
  } catch {
    /* ignore */
  }
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

  // ===== 最近消息（0.28.0，0.62.0 起可读完整回复）=====
  //
  // 悬浮窗展开态要能「接消息」——显示最近几条对话。
  // 只取**有实质内容**的：空的助手气泡（还在流式输出、content 还是空串）
  // 会显示成一条空行，比不显示更糟。
  //
  // 曾经每条只留 60 字，理由是「浮窗只有一行」。现在消息区能换行 + 上下滑，
  // 60 字反而成了硬伤：一段代码解释只看到开头半句。上限放到 1200 字 ——
  // 长到这个程度的回复本来就该回应用里看，浮窗只负责「不切应用也能读完大意」。
  const HUD_MSG_MAX = 1200;
  const messages = [];
  const cur = activeSession();
  if (cur && Array.isArray(cur.messages)) {
    for (let i = cur.messages.length - 1; i >= 0 && messages.length < 4; i -= 1) {
      const m = cur.messages[i];
      if (!m) continue;
      const text = String(m.content || "").trim();
      if (!text) continue;
      messages.unshift({
        role: m.role === "user" ? "user" : "assistant",
        text: text.length > HUD_MSG_MAX ? `${text.slice(0, HUD_MSG_MAX)}…` : text,
      });
    }
  }

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
    messages,
    // 是否有正在跑的会话 —— 悬浮窗据此决定「停止」按钮可不可点
    running: !!ui.run,
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

/* ---------------- 悬浮窗指令入口（0.28.0）----------------
 *
 * 原生悬浮窗点「发送 / 停止」时，会通过 evaluateJavascript 调到这里。
 * 协议：window.__dshHudCommand(action, payload)
 *   action = "send"  payload = {text: "..."}
 *   action = "stop"  payload = null
 *
 * 为什么放在 window 上而不是模块导出：
 * 原生侧拿不到 ES module 的引用，只能走全局对象。
 */

function installHudCommandHandler() {
  if (typeof window === "undefined") return;
  window.__dshHudCommand = async (action, payload) => {
    try {
      if (action === "send") {
        const text = String(payload?.text || "").trim();
        if (!text) return "empty";
        // 运行中不能发消息（sendMessage 内部会 return），先给个明确提示
        if (ui.run) {
          toast("正在运行中，先点「停止」再发消息", "err");
          return "busy";
        }
        await sendMessage(text);
        return "ok";
      }
      if (action === "stop") {
        if (!ui.run && !orphanRunning()) {
          toast("当前没有正在运行的会话", "");
          return "idle";
        }
        stopRunAction();
        return "ok";
      }
      return "unknown";
    } catch (err) {
      toast(`悬浮窗操作失败：${err?.message || err}`, "err");
      return "error";
    }
  };
}
installHudCommandHandler();

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
      const hint = err.hint
        ? `<pre style="white-space:pre-wrap;word-break:break-word;margin:9px 0 0;padding:9px 10px;background:var(--soft);border-radius:7px;font:11.5px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)">${esc(err.hint)}</pre>`
        : "";
      fresh.innerHTML = `<div class="model-test model-test--err">${icon("alert", "icon--sm")}
        <div><b>连接失败</b><p>${esc(err.message || "未知错误")}</p>${hint}</div>
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

/**
 * 记忆被安全闸拒绝时的提示。
 *
 * 为什么要有这个：记忆写入被拒是**静默失败** ——
 * 用户以为「记下了」，实际那条已经被丢弃。
 * 一旦模型反复输出同类内容，用户会以为是记忆功能坏了。
 */
globalThis.__dshOnMemoryRejected = (keys) => {
  const n = Array.isArray(keys) ? keys.length : 0;
  if (n > 0) {
    toast(`${n} 条记忆内容未保存：内容包含指令式或安全风险表述，已拒绝写入`, "err");
  }
};

/**
 * 刷新设置页里的语音面板。
 *
 * 只在**结构发生变化**时用：开始下载（按钮 → 进度条）、解压、完成、失败。
 * 单纯的百分比跳动不走这里 —— 那会把整页重建上百次。
 */
function refreshVoicePanel() {
  // 注意是 ui.view 不是 ui.screen。0.35.0 这里写成了 ui.screen（那个字段不存在），
  // 条件恒为假 → 进度永远不刷新，用户只能靠点别的按钮触发重绘才看到新数字。
  if (ui.view === "settings") renderMain(true);
}

/**
 * 只改下载进度条，不重建设置页。
 *
 * ============ 为什么不能每次都 renderMain ============
 *
 * 42 MB 分 12 片，进度会更新约 100 次。
 * 每次 `target.innerHTML = renderSettings(...)` 都是一次完整的
 * HTML 解析 + 重排，手机上明显卡；而且用户如果正在改别的设置项，
 * 输入到一半的内容会被清掉。
 *
 * 直接改 DOM 两个属性就没这些问题。
 *
 * 找不到元素就直接返回 —— 说明当前不在设置页（或语音分组没渲染出来）。
 * 下次进设置页时 renderSettings 会从 voiceDl 读到最新值，不会丢进度。
 */
export function paintVoiceProgress(pct) {
  const bar = document.querySelector("#voice-dl-bar");
  const label = document.querySelector("#voice-dl-label");
  if (!bar && !label) return;
  // 后端按 0.1% 上报（见 ModelDownloader.Listener 的注释）：
  // 宽度用原值让动画连续，文字取整免得画面里跳出 "37.4%" 这种数
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  if (bar) bar.style.width = `${v}%`;
  if (label) label.textContent = `正在下载离线模型 ${Math.floor(v)}%`;
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
