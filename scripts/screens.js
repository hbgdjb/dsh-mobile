/* ============================================================
   Screens — 工作区 / 插件 / 任务 / 设置 / 会话抽屉 的结构渲染
   纯函数：只读 state，输出 HTML；交互由 ui.js 的事件代理接管
   ============================================================ */

import {
  state,
  allModels,
  apiKeyFor,
  apiKeyForCurrent,
  hasKeyFor,
  providerKeyOf,
  modelStatusOf,
  modelBaseUrl,
  modelApiId,
  modelContextWindow,
  knownModelCtx,
  hasModels,
  PROVIDER_COUNT,
  APP_VERSION,
  MODES,
  PERMISSIONS,
  currentMode,
  currentModel,
  fmtRelative,
  fmtFuture,
  fmtTime,
  fmtTokens,
  listFiles,
  listLibrary,
  filesStats,
} from "./store.js";
import { fmtContext } from "./context.js";
import { icon } from "./icons.js";
import { plainText } from "./markdown.js";
import { availableToolNames } from "./tools.js";
import { powerStatus, powerAvailable } from "./keep-alive.js";
import { voiceDiagnose, requestVoicePermission } from "./voice.js";
import { nodeStatus } from "./node-runtime.js";
import { nodeToolList } from "./node-plugins.js";
import {
  localMcpAvailable,
  localStatus,
  listLaunchableApps,
  getAllowedPackages,
  isPointerMarkEnabled,
} from "./mcp-local.js";
import { listAll as listMemories } from "./memory.js";
import { trajStats } from "./traj.js";

/** 记忆条数（设置页摘要用）。 */
const memoryCount = () => listMemories().length;

/** 轨迹条数（设置页摘要用）。 */

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const ext = (path) => (path.split(".").pop() || "").toLowerCase();
const fmtSize = (f) => {
  const n = Number(f.size) || 0;
  return n >= 1024 ? `${(n / 1024).toFixed(1)}K` : `${n}B`;
};
const fileKind = (path) => {
  const e = ext(path);
  if (e === "md") return { cls: "fileicon--md", label: "MD" };
  if (e === "csv") return { cls: "fileicon--csv", label: "CSV" };
  if (e === "js" || e === "ts") return { cls: "fileicon--js", label: e.toUpperCase() };
  if (e === "docx") return { cls: "fileicon--docx", label: "DOCX" };
  if (e === "xlsx") return { cls: "fileicon--xlsx", label: "XLSX" };
  if (e === "json") return { cls: "", label: "JSON" };
  return { cls: "", label: e.slice(0, 3).toUpperCase() || "FILE" };
};

/* ---------------- 首页 ---------------- */

export function renderHome() {
  const recent = [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const mode = currentMode();
  const tools = availableToolNames().length;

  return `
  <div class="home">
    <div class="home__hero reveal">
      <span class="home__eyebrow">DSH MOBILE · ${esc(mode.name)}模式 · ${tools} 个工具</span>
      <h1 class="home__title">你只管说，<br>它负责做完。</h1>
      <p class="home__sub">读写文件、跑命令、改内容，动手前先问你。</p>
    </div>

    ${
      recent
        ? `
    <div class="home__section reveal">
      <span>最近</span>
      <span>${esc(fmtRelative(recent.updatedAt))}</span>
    </div>
    <button class="resume reveal" data-act="resume" data-id="${recent.id}">
      <span class="resume__dot"></span>
      <span class="resume__text">
        <span class="resume__title">${esc(recent.title)}</span>
        <span class="resume__sub">${esc(MODES[recent.mode]?.name || "标准")}模式 · ${recent.messages.length} 条消息</span>
      </span>
      ${icon("chevron", "icon--sm")}
    </button>`
        : ""
    }
  </div>`;
}

/* ---------------- 工作区 ---------------- */

export function renderWorkspace(tab = "workspace") {
  const isLib = tab === "library";
  const files = isLib ? listLibrary() : listFiles();
  const stats = filesStats();
  const total = files.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
  const groups = new Map();

  files.forEach((f) => {
    const seg = f.path.includes("/") ? f.path.split("/")[0] : "";
    if (!groups.has(seg)) groups.set(seg, []);
    groups.get(seg).push(f);
  });
  const order = [...groups.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));

  const tabs = `
    <div class="segmented ws-tabs" role="tablist">
      <button class="segmented__item" role="tab" data-act="ws-tab" data-value="workspace"
        aria-pressed="${!isLib}">工作区 · ${stats.workspace.count}</button>
      <button class="segmented__item" role="tab" data-act="ws-tab" data-value="library"
        aria-pressed="${isLib}">资料库 · ${stats.library.count}</button>
    </div>`;

  return `
  <div class="page-summary">${tabs}
    <span class="ws-meta">${files.length} 个文件 · ${(total / 1024).toFixed(1)} KB · ${PERMISSIONS[state.settings.permission].name}</span>
  </div>

  <div class="workspace__body scroll">
    ${
      files.length
        ? order
            .map((group) => {
              const list = groups.get(group);
              // uploads/ 是聊天附件的落盘位置，标出来避免和 Agent 产物混淆
              const groupLabel =
                group === "" ? "根目录" : group === "uploads" ? "uploads/ · 聊天附件" : group + "/";
              return `
        <div class="workspace__group">
          <div class="workspace__group-head">${groupLabel} · ${list.length}</div>
          ${list
            .map((f) => {
              const k = fileKind(f.path);
              const name = group === "" ? f.path : f.path.slice(group.length + 1);
              return `
            <button class="file-row" data-act="open-file" data-area="${isLib ? "library" : "workspace"}" data-path="${esc(f.path)}">
              <span class="fileicon ${k.cls}">${k.label}</span>
              <span class="file-row__name">${esc(name)}</span>
              <span class="file-row__meta">${fmtSize(f)}</span>
              ${icon("chevron", "icon--xs")}
            </button>`;
            })
            .join("")}
        </div>`;
            })
            .join("")
        : `<div class="empty-line">
             <b>${isLib ? "资料库还是空的" : "工作区还是空的"}</b>
             ${
               isLib
                 ? "把重要文件从工作区「存入资料库」，<br>或点右上角从手机导入。"
                 : "在对话里让 Agent 写第一个文件，<br>或点右上角手动新建。"
             }
           </div>
           ${
             isLib
               ? `<div class="empty-actions"><button class="btn btn--primary btn--sm" data-act="import-library">${icon("download", "icon--sm")} 从手机导入</button>
                  <button class="btn btn--ghost btn--sm" data-act="ws-tab" data-value="workspace">去工作区看看</button></div>`
               : ""
           }`
    }
    <div style="height:12px"></div>
  </div>`;
}

/* ---------------- 插件 ---------------- */

export function renderPlugins() {
  const enabled = state.plugins.filter((p) => p.enabled);
  const disabled = state.plugins.filter((p) => !p.enabled);

  const card = (p) => `
    <div class="plugin-row">
      <span class="avatar ${p.enabled ? "avatar--accent" : ""}" aria-hidden="true">
        ${icon(
          p.tools.includes("shell")
            ? "terminal"
            : p.tools.includes("office_export")
            ? "fileText"
            : p.scopes.includes("approval")
            ? "shield"
            : p.scopes.includes("ui.slot")
            ? "layers"
            : p.scopes.includes("network")
            ? "globe"
            : "puzzle",
          "icon--sm"
        )}
      </span>
      <div class="plugin-row__main">
        <div class="plugin-row__top">
          <button class="plugin-row__name" data-act="plugin-detail" data-id="${p.id}">${esc(p.name)}</button>
          ${p.experimental ? '<span class="tag tag--exp">实验</span>' : ""}
          ${p.preinstalled ? '<span class="tag">内置</span>' : ""}
        </div>
        <p class="plugin-row__desc">${esc(p.desc)}</p>
      </div>
      <button class="switch" role="switch" aria-checked="${p.enabled}" aria-label="启用 ${esc(p.name)}"
        data-act="toggle-plugin" data-id="${p.id}"></button>
    </div>`;

  return `
  <div class="page-summary">${enabled.length} / ${state.plugins.length} 已启用</div>

  <div class="workspace__body scroll" style="padding-top:0">
    <button class="creator-row" data-act="plugin-search">
      <span class="avatar">${icon("download", "icon--sm")}</span>
      <span class="creator-row__text">
        <b>安装插件</b>
        <span>官方清单，或直接填一个插件清单地址。</span>
      </span>
      ${icon("chevron", "icon--sm")}
    </button>

    <button class="creator-row" data-act="creator-mode">
      <span class="avatar">${icon("sparkles", "icon--sm")}</span>
      <span class="creator-row__text">
        <b>创造模式</b>
        <span>缺一个功能？让它自己写。</span>
      </span>
      ${icon("chevron", "icon--sm")}
    </button>

    <div class="section-label">已启用 · ${enabled.length}</div>
    ${enabled.map(card).join("") || '<div class="empty-line">没有启用的插件</div>'}

    <div class="section-label">未启用 · ${disabled.length}</div>
    ${disabled.map(card).join("") || '<p class="dim" style="font-size:12px;padding:6px 0">全部已启用。</p>'}

    <p class="eyebrow" style="margin:20px 0 0;line-height:1.9;letter-spacing:.04em">
      开关会即时改变模型可用的工具。
    </p>
  </div>`;
}

/* ---------------- 任务 ---------------- */

export function renderTasks() {
  const running = state.runs.filter((r) => r.status === "running" || r.status === "queued").length;
  const scheduled = state.automations.filter((a) => a.enabled).length;
  const doneToday = state.runs.filter((r) => r.status === "done").length;
  const total = state.runs.length + state.automations.length;

  return `
  <div class="page-summary">${total ? `${running} 个进行中 · ${scheduled} 个计划启用 · ${doneToday} 个已完成` : "重复的工作，让它到点自己跑"}</div>

  <div class="workspace__body scroll" style="padding-top:0">

    <button class="creator-row" data-act="new-automation">
      <span class="avatar">${icon("clock", "icon--sm")}</span>
      <span class="creator-row__text">
        <b>新建定时计划</b>
        <span>写好一句指令和执行时间，DSH 到点自动跑，结果留在任务里。</span>
      </span>
      ${icon("plus", "icon--sm")}
    </button>

    <div class="section-label">后台任务</div>
    ${
      state.runs.length
        ? state.runs
            .map(
              (r) => `
      <div class="task-card">
        <div class="task-card__top">
          <span class="run-row__status ${r.status === "running" ? "run-row__status--run" : r.status === "queued" ? "run-row__status--wait" : ""}" style="margin-top:6px"></span>
          <div style="flex:1;min-width:0">
            <div class="task-card__title">${esc(r.title)}</div>
            <div class="task-card__meta">${esc(r.meta)} · ${fmtRelative(r.startedAt)}</div>
          </div>
          ${
            r.status === "running"
              ? `<button class="btn btn--sm btn--ghost" data-act="stop-run" data-id="${r.id}">${icon("stop", "icon--xs")} 停止</button>`
              : r.status === "queued"
              ? `<span class="tag">排队中</span>`
              : `<span class="tag tag--on">完成</span>`
          }
        </div>
        ${r.status === "running" ? `<div class="progress" style="margin-top:11px"><div class="progress__bar" style="width:${r.progress}%"></div></div>` : ""}
      </div>`
            )
            .join("")
        : `<div class="empty-line">暂无后台任务</div>`
    }

    <div class="section-label">定时计划 · ${state.automations.length} · ${scheduled} 启用</div>
    ${
      state.automations.length
        ? state.automations
            .map(
              (a) => `
      <div class="task-card">
        <div class="task-card__top">
          <div style="flex:1;min-width:0">
            <button class="task-card__title" data-act="automation-detail" data-id="${a.id}" style="background:none;border:0;padding:0;text-align:left;width:100%">${esc(a.name)}</button>
            <div class="task-card__meta">${esc(a.schedule)} · ${a.enabled ? `下次 ${fmtFuture(a.nextRun)}` : "已暂停"}</div>
          </div>
          <button class="switch" role="switch" aria-checked="${a.enabled}" aria-label="启用 ${esc(a.name)}" data-act="toggle-automation" data-id="${a.id}"></button>
        </div>
        <p class="task-card__prompt">${esc(a.prompt)}</p>
        <div class="task-card__foot">
          <span class="tag">${a.history.length} 次执行</span>
          ${a.lastRun ? `<span class="tag">上次 ${fmtRelative(a.lastRun)}</span>` : ""}
          <button class="btn btn--sm btn--ghost" style="margin-left:auto" data-act="run-automation" data-id="${a.id}">${icon("play", "icon--xs")} 立即运行</button>
        </div>
      </div>`
            )
            .join("")
        : `<div class="empty-line"><b>还没有定时计划</b>例如「每个工作日早上汇总一份报表」——<br>点上方按钮，一句话就能建好。</div>`
    }
    <div style="height:16px"></div>
  </div>`;
}

/* ---------------- 设置 ---------------- */

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url || "未填写端点";
  }
};

/* ============================================================
   设置：两级导航 —— 先选大类，进入后只显示该类的内部小类
   ============================================================ */

const approvalName = () =>
  ({ ask: "逐次询问", auto: "自动放行", never: "全部拒绝" })[state.settings.approval] || "逐次询问";

const fontName = () => {
  const v = Number(state.settings.fontScale) || 1;
  return v < 1 ? "小" : v > 1 ? "大" : "标准";
};

export const SETTINGS_CATS = [
  {
    id: "account",
    icon: "user",
    title: "账号与服务",
    desc: "本机档案、各服务的 Key 与模型清单。凭据只保存在本机。",
    summary: () => {
      const n = Object.values(state.settings.keys || {}).filter(Boolean).length;
      return `${state.settings.profileName || "本机用户"} · ${n} / ${PROVIDER_COUNT} 个服务已配置`;
    },
  },
  {
    id: "model",
    icon: "bolt",
    title: "当前模型",
    desc: "当前模型自己的端点、Key、上下文窗口与推理强度。切换模型不会覆盖这些值。",
    summary: () => {
      const m = currentModel();
      if (!m) return "还没有添加模型";
      return `${m.label} · ${fmtContext(m.ctx)} · ${hasKeyFor(m) ? "已配 Key" : "未配 Key"}`;
    },
  },
  {
    id: "agent",
    icon: "cpu",
    title: "Agent 行为",
    desc: "运行模式、写入权限、审批策略与单次步数上限。",
    summary: () =>
      `${currentMode().name}模式 · ${PERMISSIONS[state.settings.permission].name} · ${approvalName()}`,
  },
  {
    id: "tools",
    icon: "puzzle",
    title: "工具与扩展",
    desc: "MCP 服务器与网页搜索服务。",
    summary: () =>
      `MCP ${(state.settings.mcpServers || []).length} 个 · 搜索服务${
        state.settings.searchEndpoint ? "已配置" : "未配置"
      }`,
  },
  {
    id: "notify",
    icon: "bell",
    title: "通知与网络",
    desc: "悬浮状态窗、完成提醒、请求超时、触感反馈与代理。",
    summary: () =>
      `悬浮窗${state.settings.hudEnabled ? "开" : "关"} · 提醒${
        state.settings.notifyOnDone ? "开" : "关"
      } · 超时 ${state.settings.requestTimeout || 60}s`,
  },
  {
    id: "appearance",
    icon: "sun",
    title: "外观与阅读",
    desc: "主题、动效、正文字号、消息密度与思考过程展示。",
    summary: () =>
      `${state.settings.theme === "light" ? "亮色" : "暗色"} · ${fontName()}字号 · 动效${
        state.settings.motion ? "开" : "关"
      }`,
  },
  {
    id: "data",
    icon: "database",
    title: "数据与存储",
    desc: "工作区与资料库、备份导入导出、请求日志与凭据清理。",
    summary: () => {
      const st = filesStats();
      return `工作区 ${st.workspace.count} 个 · 资料库 ${st.library.count} 个`;
    },
  },
  {
    id: "about",
    icon: "info",
    title: "关于",
    desc: "内核版本、宿主环境与许可。",
    summary: () => `v${APP_VERSION} · DeepSeek Harness · MIT`,
  },
];

export const SETTINGS_CAT_MAP = Object.fromEntries(SETTINGS_CATS.map((c) => [c.id, c]));

/** 设置首页：大类列表，每项带一句实时摘要。 */
/**
 * 「后台保活」设置区块。
 *
 * 这一段是给"切到后台任务自动停止"这个问题准备的。
 * 应用侧能做的三件事都已经做了（渲染进程保活、唤醒锁、前台服务），
 * 剩下的是系统层面那层"电池优化 / 厂商省电策略"——应用无权自行绕过，
 * 只能把状态如实告诉用户，并给出直达系统设置页的入口。
 *
 * 状态怎么读：
 *   batteryIgnored —— 是否在"忽略电池优化"白名单里
 *   keepAlive     —— 保活前台服务此刻是否在跑（跑任务时才会亮）
 */
function backgroundKeepAliveSection() {
  if (!powerAvailable()) return "";
  const st = powerStatus();
  const ignored = !!st.batteryIgnored;
  const maker = st.manufacturer || "";
  // 国产 ROM 的省电策略比标准 Doze 更凶，提示语要说清楚
  const isDomestic = /xiaomi|redmi|poco|huawei|honor|oppo|oneplus|realme|vivo|meizu|lenovo|zte/i.test(maker);

  const statusLine = ignored
    ? "已加入电池优化白名单，后台运行不受限"
    : isDomestic
    ? `尚未加入白名单，${maker} 的省电策略可能冻结后台任务`
    : "尚未加入白名单，系统可能在后台限制网络与唤醒";

  return `
    <div class="settings__group">
      <div class="settings__group-head">后台保活</div>
      <div class="settings__row settings__row--stack">
        <div class="settings__row-title" style="margin-bottom:4px">后台运行状态</div>
        <div class="settings__row-sub" style="margin-bottom:10px">${esc(statusLine)}</div>
        ${
          ignored
            ? `<div class="settings__row-sub" style="color:var(--ok,#5ac08a)">✓ 电池优化已放行</div>`
            : `<button class="btn btn--primary btn--block" style="margin-bottom:8px" data-act="request-battery-exemption">${icon("shield", "icon--xs")} 允许后台耗电（加入白名单）</button>`
        }
        <button class="btn btn--ghost btn--block" style="margin-bottom:8px" data-act="open-battery-settings">${icon("gear", "icon--xs")} 打开系统省电策略设置</button>
        <button class="btn btn--ghost btn--block" data-act="open-autostart-settings">${icon("arrowUp", "icon--xs")} 允许自启动</button>
        <p class="field__hint" style="margin-top:10px">
          应用已在运行时开启前台服务与唤醒锁，渲染进程也不会被系统降级回收。<br>
          剩下这层是系统与厂商的省电策略，只能由你手动放行；放行后长任务切到后台也能继续跑。
        </p>
      </div>
    </div>`;
}

/**
 * 「本机控制」区块：让用户决定 Agent 能碰这台手机上的哪些应用。
 *
 * 设计上刻意做成显式勾选，而不是"全都能碰"：
 *   - 服务默认关闭，勾了白名单也不会自己启动
 *   - 白名单为空 = 一个应用都不允许
 *   - 无障碍已开启时，ui_* 工具只能操作白名单内正处于前台的应用
 */
/**
 * 语音输入自检。
 *
 * 「语音用不了」有四种原因，对外表现却都是"没反应"。这里把它们摊开：
 * 有没有服务、有没有权限、服务是哪个包 —— 用户一眼能看出缺哪一项，
 * 也省得来回描述"就是不行"。
 */
/**
 * 离线模型下载的瞬时状态。
 *
 * 不放进 store：它不是用户数据，退出应用就该丢，
 * 也没必要落盘（重启后按"未下载"处理是对的 —— 真下载完了，
 * 原生侧会通过 modelInstalled 告诉我们）。
 */
let voiceDl = { state: "idle", pct: 0 };

/** 由 ui.js 在收到 download 事件时更新。 */
export function setVoiceDownload(next) {
  voiceDl = { ...voiceDl, ...next };
}

export function getVoiceDownload() {
  return voiceDl;
}

/**
 * 模型下载区块：按钮 / 进度 / 完成状态。
 *
 * 42 MB 的下载没有进度条是不可接受的 —— 用户只会觉得卡死了，
 * 然后在 30% 的时候杀掉应用。
 */
function voiceModelBlock(d) {
  if (d.modelInstalled || d.modelBundled) {
    return d.modelInstalled
      ? `<div class="settings__row-sub" style="color:var(--ok,#5ac08a);margin-bottom:8px">✓ 离线模型已就位（不再需要网络）</div>`
      : "";
  }
  const dl = voiceDl;
  if (dl.state === "running") {
    return `
      <!-- id 是给 ui.js 的 paintVoiceProgress 用的：进度只改这两个节点，不重建整页 -->
      <div class="settings__row-sub" style="margin-bottom:8px" id="voice-dl-label">正在下载离线模型 ${Math.floor(dl.pct)}%</div>
      <div style="height:6px;border-radius:3px;background:var(--line,#2a2f3a);overflow:hidden;margin-bottom:10px">
        <div id="voice-dl-bar" style="width:${dl.pct}%;height:100%;background:var(--accent,#4c8dff);transition:width .2s"></div>
      </div>
      <p class="field__hint" style="margin:0 0 10px">分 12 条连接并行下载。中途断了也没关系 —— 已下的部分会保留，点重试从断点继续。</p>`;
  }
  if (dl.state === "unzip") {
    return `<div class="settings__row-sub" style="margin-bottom:8px">正在解压安装（约 10 秒）…</div>`;
  }
  return `
    <button class="btn btn--primary btn--block" style="margin-bottom:8px" data-act="voice-download">
      ${icon("download", "icon--xs")} 下载离线语音模型（42 MB）
    </button>
    ${
      dl.state === "error"
        ? `<p class="field__hint" style="margin:0 0 10px;color:var(--danger,#e5484d)">上次下载中断了，已下的部分已经保留 —— 点上面按钮会从断点继续，不会从头再来一遍。</p>`
        : ""
    }`;
}

/**
 * Node 插件运行时。
 *
 * 为什么值得占一个设置分组：它决定了「DSH 的插件能不能用」这件事。
 * 而插件是 DSH 相对其它客户端最大的差异点 —— 用户需要知道它现在是活的还是死的。
 */
function nodeRuntimeSection() {
  const st = nodeStatus();
  // 浏览器 / PWA 里没有原生桥，这个分组不该出现（否则会显示"不可用"误导人）
  if (!st.native) return "";

  const on = state.settings.nodeEnabled !== false;
  let line = "";
  let hint = "";
  let color = "var(--ok,#5ac08a)";
  // 额外的操作按钮（目前只有"下载"）
  let action = "";

  if (!st.available) {
    line = "运行时不可用";
    hint =
      st.reason ||
      st.error ||
      "JNI 包装没能加载 —— 这个 APK 可能没带 libdshnode.so";
    color = "var(--danger,#e5484d)";
  } else if (st.runtimeError) {
    // 装上了但起不来：dlopen 失败、符号缺失等。
    // 把原文显示出来，用户截图反馈时才能定位。
    line = "加载失败";
    hint = st.runtimeError;
    color = "var(--danger,#e5484d)";
  } else if (!st.installed) {
    // 运行时（libnode.so，117 MB）是下载的，不是内置的 ——
    // 内置的话 APK 128 MB，用户根本传不到手机上
    if (st.downloading) {
      line = `正在下载运行时 ${st.percent}%`;
      hint = "约 88 MB。中途断了会从断点继续，不用从头下。";
      color = "var(--warn,#d9a441)";
    } else {
      line = "运行时未下载（88 MB）";
      hint =
        "运行时不会内置在安装包里 —— 否则光一个包就 128 MB，手机传都传不过来。" +
        "点下面的按钮下载一次，之后每次更新应用只有十几 MB。";
      color = "var(--warn,#d9a441)";
      action = `<button class="btn btn--sm" data-act="node-download">下载运行时</button>`;
    }
  } else if (st.running) {
    // Node 在跑，但通道不一定连上了 —— 这是两件事。
    // 「运行中但连不上」意味着插件工具调不通，得让用户看见。
    if (!st.channelConnected) {
      line = "运行中，但通道未连接";
      hint =
        "Node 进程起来了，但和页面的消息通道没连上 —— " +
        "插件工具此时调不通。稍等几秒会自动重连；如果一直这样，" +
        "说明运行时启动时出了岔子，重启应用试试。";
      color = "var(--warn,#d9a441)";
    } else {
      line = "运行中";
      hint = "插件跑在独立进程里，崩溃会自动重启（连续 5 次失败后停下）。";
    }
  } else if (on) {
    line = "已启用，等待启动";
    hint = "开关打开后应用下次启动就会拉起运行时。";
    color = "var(--warn,#d9a441)";
  } else {
    line = "已关闭";
    hint = "关闭后所有插件停止，正在跑的任务会中断。";
    color = "var(--warn,#d9a441)";
  }

  return `
    <div class="settings__group">
      <div class="settings__group-head">插件运行时</div>
      <div class="settings__row">
        <div class="settings__row-main">
          <div class="settings__row-title">Node.js 运行时</div>
          <div class="settings__row-sub" style="color:${color}">${esc(line)}</div>
        </div>
        <button class="switch" role="switch" aria-checked="${on}" aria-label="Node.js 运行时" data-act="toggle-node"></button>
      </div>
      ${action ? `<div class="settings__row">${action}</div>` : ""}
      ${hint ? `<div class="settings__row settings__row--hint"><div class="settings__row-sub">${esc(hint)}</div></div>` : ""}
    </div>`;
}

/**
 * Node 插件清单。
 *
 * ============ 为什么单独一个分组 ============
 *
 * 「Node 运行时是活的」和「插件是好的」是两回事：
 * 运行时活着但插件加载失败（语法错误、依赖缺失、版本不兼容），
 * 用户看到的现象是「工具列表里没有它」—— 没有任何报错。
 *
 * 所以把插件清单和工具清单摆到界面上，让失败有地方显示。
 */
function nodePluginsSection() {
  const st = nodeStatus();
  // 浏览器 / PWA 没有原生桥，不显示
  if (!st.native) return "";
  // 运行时没起来就没必要列插件
  if (!st.running) return "";

  const plugins = state.nodePlugins || [];
  const tools = nodeToolList();

  let body;
  if (!st.channelConnected) {
    body = `<div class="settings__row-sub" style="color:var(--warn,#d9a441)">通道未连接，暂时读不到插件清单</div>`;
  } else if (!plugins.length) {
    body = `<div class="settings__row-sub">没有找到插件。插件代码放在工作区的 plugins/ 目录下，每个插件一个子目录。</div>`;
  } else {
    body = plugins
      .map((p) => {
        const mine = tools.filter((t) => t.pluginId === `node__${p.id}`);
        const toolTxt = mine.length
          ? ` · ${mine.length} 个工具：${mine.map((t) => t.name).join("、")}`
          : " · 未注册工具";
        return `<div class="settings__row">
          <div class="settings__row-main">
            <div class="settings__row-title">${esc(p.name || p.id)}</div>
            <div class="settings__row-sub">${esc(p.id)} · v${esc(p.version || "0.0.0")}${esc(toolTxt)}</div>
          </div>
        </div>`;
      })
      .join("");
  }

  return `
    <div class="settings__group">
      <div class="settings__group-head">Node 插件</div>
      ${body}
      ${
        st.channelConnected
          ? `<div class="settings__row">
               <button class="btn btn--sm" data-act="node-reload-plugins">重新加载插件</button>
               <button class="btn btn--sm" data-act="node-selfcheck">通道自检</button>
             </div>`
          : ""
      }
    </div>`;
}

function voiceInputSection() {
  const d = voiceDiagnose();
  // 浏览器 / PWA 没有原生桥：不显示这个分组，免得占地方还看不懂
  if (!d.native) return "";

  const ok = d.available && d.permission;
  let line;
  let hint = "";
  if (!d.available) {
    line = d.serviceCount === 0
      ? "系统里没有语音识别服务 —— 这台设备可能没装（国产 ROM 常见）"
      : "语音服务存在，但系统判定不可用";
    hint =
      "可以装一个带语音识别的输入法或语音服务（如讯飞语记），" +
      "或改用键盘自带的语音键。这是设备能力问题，不是应用能绕过的。";
  } else if (!d.permission) {
    line = "有语音服务，但还没有麦克风权限";
    hint = "点下面的按钮授权。如果系统不再弹窗，说明之前勾过「不再询问」，需要到系统设置里手动打开。";
  } else if (d.onDevice) {
    line = "使用系统的本地识别（不走网络，质量最好）";
  } else if (d.preferBuiltin && !d.modelInstalled) {
    // 还没下载模型：这是最常见的首次状态
    line = "还没有下载离线语音模型";
    hint =
      "系统的识别只能走云端，而那条链路在你的网络下多半不通（错误码 11）。" +
      "下载一个 42 MB 的中文模型后，语音就会完全在本地识别，不再需要网络。";
  } else if (d.builtin && d.preferBuiltin) {
    // 这才是多数国内设备的实际状态：系统只能走云端，所以用内置引擎
    line = "使用内置离线引擎（不走网络）";
    hint =
      "系统的识别服务只能走云端，而那条链路在你的网络下多半不通（错误码 11），" +
      "所以改用了应用自带的离线引擎。它不联网、一定能出字，代价是准确率低于云端 —— " +
      "短句指令够用，长句和口音重的场景会出错。";
  } else if (!d.builtin) {
    line = "系统只能走云端，且内置引擎未安装";
    hint =
      "如果点麦克风后报「连不上语音识别服务（11）」，说明云端那条链路不通。" +
      "这次构建没有打包离线语音模型（android/vosk-cn/ 缺失），需要重新构建完整包。";
  } else {
    line = "语音服务与麦克风权限都正常";
  }

  return `
    <div class="settings__group">
      <div class="settings__group-head">语音输入</div>
      <div class="settings__row settings__row--stack">
        <div class="settings__row-title" style="margin-bottom:4px">状态</div>
        <div class="settings__row-sub" style="margin-bottom:${hint ? "8px" : "2px"};color:${
          ok ? "var(--ok,#5ac08a)" : "var(--warn,#d9a441)"
        }">${ok ? "✓ " : "! "}${esc(line)}</div>
        ${hint ? `<p class="field__hint" style="margin:0 0 10px">${esc(hint)}</p>` : ""}
        ${
          d.available && !d.permission
            ? `<button class="btn btn--primary btn--block" style="margin-bottom:8px" data-act="voice-permission">${icon("mic", "icon--xs")} 授权麦克风</button>`
            : ""
        }
        ${voiceModelBlock(d)}
        <p class="field__hint" style="margin:8px 0 0;opacity:.75">
          识别服务：${
            d.serviceCount
              ? esc(d.services.join("、"))
              : "未找到"
          }<br>系统本地识别：${d.onDevice ? "支持" : "不支持"} · 内置引擎：${
            d.builtin ? "已就绪" : "未安装"
          } · Android API ${d.api || "?"}${
            d.error ? ` · 自检异常：${esc(d.error)}` : ""
          }
        </p>
      </div>
    </div>`;
}

function localControlSection() {
  if (!localMcpAvailable()) return "";
  const st = localStatus();
  const apps = listLaunchableApps();
  const allowed = new Set(getAllowedPackages());
  const allowedList = apps.filter((a) => allowed.has(a.package));
  const pointerOn = isPointerMarkEnabled();

  return `
    <div class="settings__group">
      <div class="settings__group-head">本机控制</div>
      <div class="settings__row">
        <div class="settings__row-main">
          <div class="settings__row-title">本机 MCP 服务</div>
          <div class="settings__row-sub">${
            st.running
              ? `正在监听 127.0.0.1:${st.port || 8788} · 只对本机生效`
              : st.enabled
              ? "已启用，但设备进程没响应（可能刚被系统回收）"
              : "默认关闭。开启后 Agent 才能通过 MCP 操作这台手机"
          }</div>
        </div>
        <button class="switch" role="switch" aria-checked="${st.enabled}" aria-label="本机 MCP 服务" data-act="toggle-local-mcp"></button>
      </div>

      ${
        // 「开着但连不上」是最常见的一种不稳：设备进程被回收过一次，
        // 或者监听 socket 已经不能 accept。给它一个明确的恢复动作，
        // 而不是让用户去翻设置、重启应用。
        st.enabled && !st.running
          ? `<button class="btn btn--primary btn--block" style="margin:2px 0 10px" data-act="restart-local-mcp">重新连接</button>`
          : ""
      }

      <div class="settings__row">
        <div class="settings__row-main">
          <div class="settings__row-title">显示点击位置</div>
          <div class="settings__row-sub">${
            !st.overlay
              ? "缺少悬浮窗权限，落点画不出来 —— 但点击本身照常执行"
              : pointerOn
              ? "AI 点击时在落点画涟漪，滑动时画连线，1.2 秒后消失"
              : "已关闭：操作照常执行，只是看不见落点"
          }</div>
        </div>
        <button class="switch" role="switch" aria-checked="${pointerOn}" aria-label="显示点击位置" data-act="toggle-pointer-mark"></button>
      </div>
      ${
        // 没权限时不隐藏这一行（那是最需要它的时候），而是在下面直接给入口。
        // 这是 0.23.x 那次的教训：把「去授权」按钮藏在 js 条件里，用户永远看不到。
        !st.overlay
          ? `<button class="btn btn--primary btn--block" style="margin:2px 0 10px" data-act="request-hud-permission">去授予悬浮窗权限</button>`
          : ""
      }

      ${shizukuCard(st)}

      <div class="settings__row settings__row--stack">
        <div class="settings__row-title" style="margin-bottom:4px">允许控制的应用</div>
        <p class="field__hint" style="margin:0 0 8px">
          已勾选 <b>${allowedList.length}</b> 个。Agent 只能启动、读取、操作用户勾选过的应用；
          其它应用一律拒绝。深链跳转也会被拦。
        </p>
        ${
          apps.length
            ? `<div class="local-apps">${apps
                .map(
                  (a) => `
          <label class="local-app">
            <input type="checkbox" data-act="toggle-local-app" value="${esc(a.package)}" ${allowed.has(a.package) ? "checked" : ""}>
            <span class="local-app__label">${esc(a.label || a.package)}</span>
            <span class="local-app__pkg mono">${esc(a.package)}</span>
          </label>`
                )
                .join("")}</div>`
            : `<p class="field__hint">没有取到可启动应用列表。</p>`
        }
      </div>
    </div>`;
}

/**
 * 低速通道（Shizuku）的状态卡。
 *
 * 为什么单独占一张卡，而不是塞进无障碍那一块：
 * 这两条通道的**修法完全不同** —— 无障碍要去系统设置里开开关、放行电池，
 * Shizuku 要去启动服务、点授权。混在一起会让人分不清该动哪个。
 *
 * 五档状态对应五个不同动作，这也是为什么 State 不能只给一个 boolean。
 */
function shizukuCard(st) {
  const s = Number(st.shizukuState ?? 0);
  let tone = "";
  let text = "";

  if (!st.available) {
    text = "未接入原生桥（浏览器环境没有 Shizuku 通道）。";
  } else if (s === 0) {
    tone = "bad";
    text = "没有安装 Shizuku。装好并启动服务后，这条通道才可用。";
  } else if (s === 1) {
    tone = "bad";
    text = "Shizuku 装了，但服务没在运行 —— 每次重启手机后要重新启动一次（Android 11+ 用无线调试即可，不需要电脑）。";
  } else if (s === 2) {
    tone = "warn";
    text = "Shizuku 在运行，但还没授权本应用。点下面的按钮，在 Shizuku 的弹框里选「允许」。";
  } else if (s === 3) {
    tone = "warn";
    text = "正在建立连接…";
  } else if (s === 4) {
    tone = "ok";
    text = "通道就绪。界面操作（读屏、点击、滑动、输入）全部走这条。";
  } else {
    tone = "warn";
    text = "已授权，尚未建立连接。首次调用 ui_* 会自动连上，也可以点下面的按钮立即连接。";
  }

  const btn = (act, label) =>
    `<button class="btn btn--primary btn--block" style="margin-bottom:8px" data-act="${act}">${label}</button>`;

  let actions = "";
  if (st.available) {
    if (s === 0) actions = btn("open-shizuku-download", "去下载 Shizuku");
    else if (s === 1) actions = btn("open-shizuku-app", "打开 Shizuku 启动服务");
    else if (s === 2) actions = btn("request-shizuku", "授权 DSH");
    else if (s === 3 || s === 5) actions = btn("connect-shizuku", "立即连接");
  }

  return `<div class="settings__row settings__row--stack">
        <div class="settings__row-title" style="margin-bottom:4px;display:flex;align-items:center;gap:6px">
          界面操作 · Shizuku
        </div>
        <div class="settings__row-sub" style="margin-bottom:10px">${esc(st.shizukuDesc || "未检测")}</div>
        <div class="a11y-verdict a11y-verdict--${tone}">${esc(text)}</div>
        ${actions}
        <p class="field__hint" style="margin:0">
          原来还有一条「无障碍」通道，更快（约 100ms）也能输中文，但它的权限来自
          「系统对应用的绑定」，vivo / 小米 / OPPO 的省电策略会周期性把它摘掉，
          表现为「时好时坏」。0.26.0 起已移除，只保留这一条 —— 行为可预期。<br>
          代价：读一次界面约 1~2 秒；中文输入靠剪贴板 + 粘贴键。
        </p>
      </div>`;

}

function settingsHome() {
  return `
  <div class="settings scroll">
    <p class="settings__lead">模型、权限与运行时。<br>改动立即生效，不会上传到任何服务。</p>
    <div class="settings__cards">
      ${SETTINGS_CATS.map(
        (c) => `
        <button class="settings-card" data-act="settings-cat" data-value="${c.id}">
          <span class="avatar avatar--accent">${icon(c.icon, "icon--sm")}</span>
          <span class="settings-card__main">
            <span class="settings-card__title">${esc(c.title)}</span>
            <span class="settings-card__sub">${esc(c.summary())}</span>
          </span>
          ${icon("chevron", "icon--sm")}
        </button>`
      ).join("")}
    </div>
    <div style="height:20px"></div>
  </div>`;
}

/**
 * 一句话结论：现在到底卡在哪。
 *
 * 前几轮的教训是「给了用户一堆状态字段，他仍然不知道该点哪」。
 * 这里按「最可能的下一步」排序，只给一条 —— 说多了等于没说。
 */
/**
 * 审批策略的说明文案。
 *
 * 旧文案只说「写入、终端、插件安装前会弹审批」，没讲清楚 MCP 工具算不算。
 * 更糟的是代码里 MCP / 插件确实**不认**这个设置 —— 文案和实现都不完整。
 * 现在三条路径统一了，文案也把范围写全。
 */
function approvalHint(policy) {
  if (policy === "never") {
    return "所有敏感操作（写入、终端、脚本、MCP、插件工具）直接拒绝，不弹窗。";
  }
  if (policy === "auto") {
    return "上述操作全部直接执行，包括 MCP 与插件工具。破坏性命令仍会被 CC Safety Net 拦下。";
  }
  return "写入、终端、脚本、MCP 工具、插件工具，每次调用前都会弹窗确认。";
}

export function renderSettings(cat = null) {
  const s = state.settings;
  const model = currentModel();
  const mode = currentMode();
  const files = listFiles();
  const filesBytes = files.reduce((n, f) => n + (Number(f.size) || 0), 0);
  const meta = cat ? SETTINGS_CAT_MAP[cat] : null;
  if (!meta) return settingsHome();

  const sections = {
    account: () => `
    <div class="settings__group">
      <div class="settings__group-head">账号与服务</div>
      <button class="settings__row" data-act="open-account" style="width:100%;text-align:left">
        <span class="avatar avatar--accent">${icon("user", "icon--sm")}</span>
        <div class="settings__row-main" style="margin-left:10px">
          <div class="settings__row-title">${esc(s.profileName || "本机用户")}</div>
          <div class="settings__row-sub">${Object.values(s.keys || {}).filter(Boolean).length} / ${PROVIDER_COUNT} 个服务已配置 · 本机档案</div>
        </div>
        ${icon("chevron", "icon--sm")}
      </button>
      <button class="settings__row" data-act="open-models" style="width:100%;text-align:left">
        <div class="settings__row-main">
          <div class="settings__row-title">模型管理</div>
          <div class="settings__row-sub">${hasModels() ? `${allModels().length} 个模型 · 参数与连接测试` : "添加你的第一个模型"}</div>
        </div>
        ${icon("chevron", "icon--sm")}
      </button>
    </div>`,

    model: () => `
    <div class="settings__group">
      <div class="settings__group-head">当前模型</div>
      ${
        !model
          ? `<div class="provider-card" data-active="true">
               <span class="avatar avatar--accent">${icon("plus", "icon--sm")}</span>
               <div style="flex:1;min-width:0">
                 <div class="card__title">还没有模型</div>
                 <div class="card__sub">添加一个：选供应方 → 填模型 ID → 填 Key → 测试连接</div>
               </div>
             </div>
             <button class="btn btn--primary btn--block" style="margin:12px 0 4px" data-act="new-custom-model">${icon("plus", "icon--xs")} 添加模型</button>
             <p class="field__hint" style="margin-top:10px">供应方预设里已写好 DeepSeek、OpenAI、Moonshot 与兼容网关的端点和常用模型 ID；Key 在「账号 → 对应服务」里填。</p>`
          : `
      ${(() => {
        const st = modelStatusOf(model.id);
        const conn = !hasKeyFor(model)
          ? { tone: "warn", text: "未配置 Key · 无法对话" }
          : !st
          ? { tone: "idle", text: "未验证" }
          : st.ok
          ? { tone: "ok", text: `已连接 · ${(st.ms || 0) < 1000 ? `${st.ms || 0} ms` : `${((st.ms || 0) / 1000).toFixed(1)}s`}` }
          : st.status === 429
          ? { tone: "err", text: "限流 · 稍后再试" }
          : { tone: "err", text: `连接失败${st.status ? ` · HTTP ${st.status}` : ""}` };
        return `
      <div class="provider-card" data-active="true">
        <span class="avatar avatar--accent">${icon("bolt", "icon--sm")}</span>
        <div style="flex:1;min-width:0">
          <div class="card__title">${esc(model.label)}</div>
          <div class="card__sub">${model.provider ? `${esc(model.provider)} · ` : ""}${fmtContext(model.ctx)} · ${esc(hostOf(modelBaseUrl(model)))}</div>
        </div>
        <span class="conn-pill conn-pill--${conn.tone}"><span class="conn-pill__dot"></span>${esc(conn.text)}</span>
      </div>
      ${st && !st.ok ? `<p class="field__hint" style="color:var(--danger);margin-bottom:10px">${esc(st.error || "最近一次请求失败，可点下方测试连接。")}</p>` : ""}`;
      })()}

      <div class="field">
        <label class="field__label" for="set-key">${esc(providerKeyOf(model) === "custom" ? "自定义服务 Key" : `${model.provider || "服务"} API Key`)}
          <button class="chip" data-act="toggle-key" style="height:22px;font-size:9px">${s.showKey ? "隐藏" : "显示"}</button>
        </label>
        <div class="input-suffix">
          <input class="input mono" id="set-key" type="${s.showKey ? "text" : "password"}" placeholder="sk-…"
            value="${esc(apiKeyForCurrent())}" data-key-field="1" autocomplete="off" spellcheck="false">
          <button class="icon-btn" data-act="paste-key" aria-label="粘贴">${icon("copy", "icon--sm")}</button>
        </div>
        <p class="field__hint">只保存在本机；不同服务分槽保存。留空则无法发送消息。</p>
      </div>

      <div class="field">
        <label class="field__label" for="set-base">Base URL</label>
        <input class="input mono" id="set-base" value="${esc(modelBaseUrl(model))}" data-model-field="baseUrl" spellcheck="false" placeholder="https://api.deepseek.com">
        <p class="field__hint">这是当前模型自己的端点；切换模型不会覆盖它。</p>
      </div>

      <div class="field">
        <label class="field__label" for="set-api">模型 ID</label>
        <input class="input mono" id="set-api" value="${esc(modelApiId(model))}" data-model-field="apiModel" spellcheck="false" placeholder="deepseek-chat">
        <p class="field__hint">会原样放进请求体的 <code>model</code> 字段。</p>
      </div>

      <div class="field">
        <label class="field__label" for="set-ctx">上下文窗口</label>
        <div class="input-suffix">
          <input class="input mono" id="set-ctx" type="number" min="4" max="2000" step="1"
            value="${Math.round(modelContextWindow(model) / 1000)}" data-model-field="ctx" inputmode="numeric">
          <span class="input-unit">K</span>
        </div>
        <p class="field__hint">按当前模型单独保存；请求前按 72% 预算裁剪较早回合——预留 28% 给本步回复与工具调用，避免超出窗口报错。</p>
        ${
          knownModelCtx(modelApiId(model)) > modelContextWindow(model)
            ? `<button class="chip" style="margin-top:6px" data-act="fill-known-ctx" data-ctx="${knownModelCtx(modelApiId(model))}">${icon("check", "icon--xs")} 该模型实际支持 ${fmtContext(knownModelCtx(modelApiId(model)))}，点此填入</button>`
            : ""
        }
      </div>

      <div class="model-inline-actions">
        <button class="btn btn--primary btn--sm" data-act="apply-current-model" style="flex:1.2">${icon("check", "icon--xs")} 保存参数</button>
        <button class="btn btn--ghost btn--sm" data-act="edit-model" data-id="${model.id}" style="flex:1">${icon("gear", "icon--xs")} 更多参数</button>
      </div>

      <div class="field">
        <span class="field__label">推理强度</span>
        <div class="segmented" data-seg="reasoning">
          ${[["off", "关闭"], ["low", "低"], ["high", "高"], ["max", "最高"]].map(([r, label]) => `<button class="segmented__item" data-act="set-reasoning" data-value="${r}" aria-pressed="${s.reasoning === r}">${label}</button>`).join("")}
        </div>
      </div>

      <button class="btn btn--ghost btn--block" data-act="test-connection" id="test-btn">${icon("bolt", "icon--sm")} 测试连接</button>
      <div id="test-result"></div>

      <p class="key-warning">${icon("shield", "icon--sm")} APK 内请求走系统原生网络，不再受 WebView 跨域限制；浏览器预览仍要求服务端允许 CORS。模型管理里可以给每个模型单独测试。</p>`
      }
    </div>`,

    agent: () => `
    <div class="settings__group">
      <div class="settings__group-head">Agent 默认</div>
      <button class="settings__row" data-act="open-mode" style="width:100%;text-align:left">
        <div class="settings__row-main">
          <div class="settings__row-title">运行模式</div>
          <div class="settings__row-sub">${esc(mode.name)}模式 · ${esc(mode.desc)}</div>
        </div>
        <span class="tag">${mode.name}</span>
        ${icon("chevron", "icon--sm")}
      </button>

      <div class="settings__row settings__row--stack">
        <div class="settings__row-title" style="margin-bottom:8px">权限</div>
        <div class="segmented" data-seg="permission">
          ${Object.values(PERMISSIONS).map((p) => `<button class="segmented__item" data-act="set-permission" data-value="${p.id}" aria-pressed="${s.permission === p.id}">${p.name}</button>`).join("")}
        </div>
        <p class="field__hint" style="margin-top:6px">${esc(PERMISSIONS[s.permission].desc)}</p>
      </div>

      <div class="settings__row settings__row--stack">
        <div class="settings__row-title" style="margin-bottom:8px">审批策略</div>
        <div class="segmented" data-seg="approval">
          <button class="segmented__item" data-act="set-approval" data-value="ask" aria-pressed="${s.approval === "ask"}">逐次询问</button>
          <button class="segmented__item" data-act="set-approval" data-value="auto" aria-pressed="${s.approval === "auto"}">自动放行</button>
          <button class="segmented__item" data-act="set-approval" data-value="never" aria-pressed="${s.approval === "never"}">全部拒绝</button>
        </div>
        <p class="field__hint" style="margin-top:6px">${approvalHint(s.approval)}</p>
      </div>

      <div class="settings__row">
        <div class="settings__row-main">
          <div class="settings__row-title">单次最大步数</div>
          <div class="settings__row-sub">工具调用回合上限，默认 24，最高 100</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <button class="icon-btn icon-btn--sm" data-act="max-steps" data-value="-2" aria-label="减少">${icon("minus", "icon--sm")}</button>
          <span class="mono" style="font-size:13px;min-width:18px;text-align:center">${s.maxSteps}</span>
          <button class="icon-btn icon-btn--sm" data-act="max-steps" data-value="2" aria-label="增加">${icon("plus", "icon--sm")}</button>
        </div>
      </div>
    </div>

    <div class="settings__group">
      <div class="settings__group-head">长期记忆</div>
      <div class="settings__row">
        <div class="settings__row-main">
          <div class="settings__row-title">启用长期记忆</div>
          <div class="settings__row-sub">把已验证的事实与偏好注入对话，替代模型自己的猜测</div>
        </div>
        <button class="switch" role="switch" aria-checked="${s.memoryEnabled !== false}" aria-label="启用长期记忆" data-act="toggle-memory"></button>
      </div>
      <button class="settings__row" data-act="open-memory" style="width:100%;text-align:left">
        <div class="settings__row-main">
          <div class="settings__row-title">我的记忆</div>
          <div class="settings__row-sub">${(() => {
            const n = memoryCount();
            return n ? `${n} 条 · 查看、删除与纠正` : "还没有记录 · 对话中说出偏好或纠正错误会自动积累";
          })()}</div>
        </div>
        ${icon("chevron", "icon--sm")}
      </button>
    </div>

    <div class="settings__group">
      <div class="settings__group-head">控屏轨迹</div>
      <div class="settings__row">
        <div class="settings__row-main">
          <div class="settings__row-title">记录控屏轨迹</div>
          <div class="settings__row-sub">DSH 操作手机界面时自动记一条，落库前已脱敏；只有你标为成功的才会被检索使用</div>
        </div>
        <button class="switch" role="switch" aria-checked="${s.trajEnabled !== false}" aria-label="记录控屏轨迹" data-act="toggle-traj"></button>
      </div>
      <button class="settings__row" data-act="open-traj" style="width:100%;text-align:left">
        <div class="settings__row-main">
          <div class="settings__row-title">控屏轨迹库</div>
          <div class="settings__row-sub">${(() => {
            const st = trajStats();
            return st.total
              ? `${st.total} 条 · ${st.success} 条已确认成功 · 查看、判定与检索`
              : "还没有记录 · 让 DSH 操作一次手机界面就会自动记一条";
          })()}</div>
        </div>
        ${icon("chevron", "icon--sm")}
      </button>
    </div>`,

    tools: () => `
    <div class="settings__group">
      <div class="settings__group-head">网页搜索</div>
      <div class="field">
        <label class="field__label" for="set-search">搜索服务</label>
        <input class="input mono" id="set-search" placeholder="https://searx.example.com/search" value="${esc(s.searchEndpoint)}" data-set="searchEndpoint" spellcheck="false">
        <p class="field__hint">需返回 JSON 且允许跨域。留空时网页搜索插件会返回明确错误，不会静默失败。</p>
      </div>
    </div>

    <div class="settings__group">
      <div class="settings__group-head">扩展</div>
      <button class="settings__row" data-act="open-mcp" style="width:100%;text-align:left">
        <div class="settings__row-main">
          <div class="settings__row-title">MCP 服务器</div>
          <div class="settings__row-sub">${(s.mcpServers || []).length} 个已保存 · 连接测试与工具发现</div>
        </div>
        <span class="tag">${(s.mcpServers || []).length}</span>
        ${icon("chevron", "icon--sm")}
      </button>
    </div>
    ${localControlSection()}
    ${voiceInputSection()}
    ${nodeRuntimeSection()}
    ${nodePluginsSection()}`,

    notify: () => `
    <div class="settings__group">
      <div class="settings__group-head">通知与网络</div>
      <div class="settings__row">
        <div class="settings__row-main">
          <div class="settings__row-title">悬浮状态窗</div>
          <div class="settings__row-sub">${(() => {
            if (typeof window !== "undefined" && window.DshHud?.canDrawOverlays) {
              return window.DshHud.canDrawOverlays()
                ? "系统悬浮窗 · 在其他应用上方显示状态"
                : "需要在系统设置授予悬浮窗权限";
            }
            return "浏览器模式为应用内浮条";
          })()}</div>
        </div>
        <button class="switch" role="switch" aria-checked="${s.hudEnabled}" aria-label="悬浮状态窗" data-act="toggle-hud"></button>
      </div>
      ${(() => {
        if (typeof window === "undefined" || !window.DshHud?.canDrawOverlays) return "";
        if (window.DshHud.canDrawOverlays()) return "";
        return `<button class="btn btn--ghost btn--block" style="margin:2px 0 10px" data-act="request-hud-permission">${icon("shield", "icon--xs")} 去授予悬浮窗权限</button>`;
      })()}
      <div class="settings__row">
        <div class="settings__row-main">
          <div class="settings__row-title">完成提醒</div>
          <div class="settings__row-sub">不在当前对话时，任务完成给出提醒</div>
        </div>
        <button class="switch" role="switch" aria-checked="${s.notifyOnDone}" aria-label="完成提醒" data-act="toggle-notify"></button>
      </div>
      <button class="settings__row" data-act="test-notification" style="width:100%;text-align:left">
        <div class="settings__row-main">
          <div class="settings__row-title">发送测试提醒</div>
          <div class="settings__row-sub">系统通知不可用时回退为应用内提示</div>
        </div>
        ${icon("bell", "icon--sm")}
      </button>
      <div class="settings__row settings__row--stack">
        <div class="settings__row-title" style="margin-bottom:8px">请求超时</div>
        <div class="segmented">
          ${[30, 60, 120].map((sec) => `<button class="segmented__item" data-act="set-timeout" data-value="${sec}" aria-pressed="${s.requestTimeout === sec}">${sec} 秒</button>`).join("")}
        </div>
        <p class="field__hint" style="margin-top:6px">超时会中止本次请求；不会自动重试，避免重复扣费。</p>
      </div>
      <div class="settings__row">
        <div class="settings__row-main">
          <div class="settings__row-title">触感反馈</div>
          <div class="settings__row-sub">发送、审批与完成时轻微振动</div>
        </div>
        <button class="switch" role="switch" aria-checked="${s.haptics}" aria-label="触感反馈" data-act="toggle-haptics"></button>
      </div>
      ${backgroundKeepAliveSection()}
      <div class="settings__row settings__row--stack">
        <div class="settings__row-title">网络代理</div>
        <p class="field__hint">跟随系统代理。WebView 不支持应用内代理；需要代理时请在 Android 系统或路由器层配置。</p>
      </div>
      <div class="settings__row">
        <div class="settings__row-main">
          <div class="settings__row-title">界面语言</div>
          <div class="settings__row-sub">当前版本只提供简体中文</div>
        </div>
        <span class="tag">简体中文</span>
      </div>
    </div>`,

    appearance: () => `
    <div class="settings__group">
      <div class="settings__group-head">外观</div>
      <div class="settings__row settings__row--stack">
        <div class="settings__row-title" style="margin-bottom:8px">主题</div>
        <div class="segmented">
          <button class="segmented__item" data-act="set-theme" data-value="dark" aria-pressed="${s.theme === "dark"}">${icon("moon", "icon--xs")} 暗色</button>
          <button class="segmented__item" data-act="set-theme" data-value="light" aria-pressed="${s.theme === "light"}">${icon("sun", "icon--xs")} 亮色</button>
        </div>
      </div>
      <div class="settings__row">
        <div class="settings__row-main">
          <div class="settings__row-title">动效</div>
          <div class="settings__row-sub">关闭后使用零动画过渡</div>
        </div>
        <button class="switch" role="switch" aria-checked="${s.motion}" aria-label="界面动效" data-act="toggle-motion"></button>
      </div>
      <div class="settings__row settings__row--stack">
        <div class="settings__row-title" style="margin-bottom:8px">正文大小</div>
        <div class="segmented">
          ${[[0.92, "小"], [1, "标准"], [1.1, "大"]].map(([v, label]) => `<button class="segmented__item" data-act="set-font-scale" data-value="${v}" aria-pressed="${Number(s.fontScale) === v}">${label}</button>`).join("")}
        </div>
      </div>
      <div class="settings__row settings__row--stack">
        <div class="settings__row-title" style="margin-bottom:8px">消息密度</div>
        <div class="segmented">
          <button class="segmented__item" data-act="set-density" data-value="comfortable" aria-pressed="${s.density !== "compact"}">舒适</button>
          <button class="segmented__item" data-act="set-density" data-value="compact" aria-pressed="${s.density === "compact"}">紧凑</button>
        </div>
      </div>
    </div>

    <div class="settings__group">
      <div class="settings__group-head">阅读</div>
      <div class="settings__row">
        <div class="settings__row-main">
          <div class="settings__row-title">显示思考过程</div>
          <div class="settings__row-sub">在回答上方折叠展示推理内容</div>
        </div>
        <button class="switch" role="switch" aria-checked="${s.showReasoning}" aria-label="显示思考过程" data-act="toggle-reasoning"></button>
      </div>
    </div>`,

    data: () => `
    <div class="settings__group">
      <div class="settings__group-head">工作区与资料库</div>
      <div class="kv"><span>工作区</span><b>${files.length} 个 · ${(filesBytes / 1024).toFixed(1)} KB</b></div>
      <div class="kv"><span>资料库</span><b>${listLibrary().length} 个 · ${(
        listLibrary().reduce((n, f) => n + (Number(f.size) || 0), 0) / 1024
      ).toFixed(1)} KB</b></div>
      <div class="settings__row">
        <div class="settings__row-main">
          <div class="settings__row-title">工作区数据</div>
          <div class="settings__row-sub">导入 / 导出 JSON 备份</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="chip" data-act="export-workspace">导出</button>
          <button class="chip" data-act="import-workspace">导入</button>
        </div>
      </div>
      <div class="settings__row settings__row--stack">
        <div class="settings__row-title">存储位置</div>
        <p class="field__hint">${
          state.fsBackend === "native" && state.fsRoot
            ? `手机真实目录：<code>${esc(state.fsRoot)}/workspace</code> 与 <code>/library</code>（应用专属目录，无需存储权限）。`
            : "浏览器环境：文件保存在本机 IndexedDB 中；装成 APK 后会落到手机真实目录。"
        }</p>
      </div>
      <div class="settings__row">
        <div class="settings__row-main">
          <div class="settings__row-title">资料库</div>
          <div class="settings__row-sub">只存重要 / 跨会话要复用的文件</div>
        </div>
        <button class="chip" data-act="import-library">导入</button>
      </div>
    </div>
    <div class="settings__group">
      <div class="settings__group-head">数据</div>
      <button class="settings__row" data-act="export-all" style="width:100%;text-align:left">
        <div class="settings__row-main">
          <div class="settings__row-title">导出全部数据</div>
          <div class="settings__row-sub">会话、文件、插件与自动化，JSON 格式</div>
        </div>
        ${icon("download", "icon--sm")}
      </button>
      <button class="settings__row" data-act="reset-all" style="width:100%;text-align:left">
        <div class="settings__row-main">
          <div class="settings__row-title" style="color:var(--danger)">重置应用</div>
          <div class="settings__row-sub">清除会话、文件与设置，工作区回到只有 README</div>
        </div>
        ${icon("trash", "icon--sm")}
      </button>
    </div>
    <div class="settings__group">
      <div class="settings__group-head">诊断与隐私</div>
      <button class="settings__row" data-act="open-diagnostics" style="width:100%;text-align:left">
        <div class="settings__row-main">
          <div class="settings__row-title">请求日志</div>
          <div class="settings__row-sub">最近 ${state.diagnostics?.requests?.length || 0} 条 · 只存本机</div>
        </div>
        ${icon("chevron", "icon--sm")}
      </button>
      <div class="settings__row">
        <div class="settings__row-main">
          <div class="settings__row-title">遥测</div>
          <div class="settings__row-sub">不收集使用数据，不上报会话内容</div>
        </div>
        <span class="tag">关闭</span>
      </div>
      <button class="settings__row" data-act="clear-all-keys" style="width:100%;text-align:left">
        <div class="settings__row-main">
          <div class="settings__row-title" style="color:var(--danger)">清除所有服务的 Key</div>
          <div class="settings__row-sub">保留会话与文件，只清空凭据</div>
        </div>
        ${icon("key", "icon--sm")}
      </button>
    </div>`,

    about: () => `
    <div class="settings__group">
      <div class="settings__group-head">关于</div>
      <div class="kv"><span>内核</span><b>DeepSeek Harness · mobile ${APP_VERSION}</b></div>
      <div class="kv"><span>宿主</span><b>Android WebView / PWA</b></div>
      <div class="kv"><span>插件数</span><b>${state.plugins.length}</b></div>
      <div class="kv"><span>协议</span><b>MIT</b></div>
      <p class="field__hint" style="margin-top:12px;line-height:1.8">
        DSH Mobile 是 DeepSeek Harness 的移动端宿主实现：同一套 Agent 循环、工具审批、插件装配与轨迹记录，为触屏重排。与 DeepSeek 官方无隶属关系。
      </p>
    </div>`,
  };

  return `
  <div class="settings scroll">
    <p class="settings__cat-desc">${esc(meta.desc)}</p>
    ${sections[meta.id]()}
    <div style="height:20px"></div>
  </div>`;
}

/* ---------------- 会话抽屉 ---------------- */

export function renderDrawer(search = "") {
  const q = search.trim().toLowerCase();
  const sessions = state.sessions.filter(
    (s) =>
      !q ||
      s.title.toLowerCase().includes(q) ||
      s.messages.some((m) => String(m.content).toLowerCase().includes(q))
  );

  const groups = [
    { label: "今天", test: (s) => Date.now() - s.updatedAt < 86400000 },
    { label: "昨天", test: (s) => Date.now() - s.updatedAt >= 86400000 && Date.now() - s.updatedAt < 2 * 86400000 },
    { label: "更早", test: (s) => Date.now() - s.updatedAt >= 2 * 86400000 },
  ];

  return `
    <div class="drawer__head">
      <div class="drawer__brand">
        <span class="brandmark" aria-hidden="true"></span>
        <span class="drawer__brand-text">
          <b>DeepSeek Harness</b>
          <span>MOBILE · ${APP_VERSION}</span>
        </span>
      </div>
      <button class="icon-btn icon-btn--sm" data-act="close-drawer" aria-label="关闭会话列表">${icon("x", "icon--sm")}</button>
    </div>

    <div class="drawer__search">
      <div class="input-suffix">
        <input class="input" id="session-search" placeholder="搜索会话或内容" value="${esc(search)}" autocomplete="off">
        <span class="icon-btn" style="pointer-events:none">${icon("search", "icon--sm")}</span>
      </div>
      <button class="btn btn--primary btn--block" style="margin-top:9px" data-act="new-session">
        ${icon("plus", "icon--sm")} 新会话
      </button>
    </div>

    <div class="drawer__list scroll">
      ${
        sessions.length
          ? groups
              .map((g) => {
                const list = sessions.filter(g.test);
                if (!list.length) return "";
                return `
            <div class="drawer__section"><span class="eyebrow">${g.label}</span><span class="eyebrow">${list.length}</span></div>
            ${list
              .map((s) => {
                const last = s.messages[s.messages.length - 1];
                return `
              <div class="session-item" data-active="${s.id === state.activeSessionId}">
                <button class="session-item__main" data-act="open-session" data-id="${s.id}">
                  <span class="session-item__top">
                    <span class="session-item__title">${esc(s.title)}</span>
                    <span class="session-item__time">${fmtTime(s.updatedAt)}</span>
                  </span>
                  <span class="session-item__preview">${esc(last ? plainText(last.content, 42) : "空会话")}</span>
                </button>
                <button class="session-item__del" data-act="delete-session" data-id="${s.id}" aria-label="删除会话">${icon("trash", "icon--xs")}</button>
              </div>`;
              })
              .join("")}`;
              })
              .join("")
          : `<div class="empty-line"><b>没有匹配的会话</b>换个关键词，或开一个新会话。</div>`
      }
    </div>

    <div class="drawer__foot">
      <div class="drawer__conn">${icon(apiKeyForCurrent() && currentModel() ? "bolt" : "info", "icon--xs")}
        <span>${apiKeyForCurrent() && currentModel() ? `已连接 · ${esc(currentModel().label)}` : "未连接模型"}</span>
      </div>
      <div class="drawer__foot-actions">
        <button class="drawer__pill" data-act="open-account">
          ${icon("user", "icon--sm")}
          <span class="drawer__pill-text">
            <b>账号</b>
            <small>Key · 服务 · 本机档案</small>
          </span>
        </button>
        <button class="drawer__pill" data-act="open-settings">
          ${icon("gear", "icon--sm")}
          <span class="drawer__pill-text">
            <b>设置</b>
            <small>模型 · 权限 · 外观</small>
          </span>
        </button>
      </div>
    </div>`;
}
