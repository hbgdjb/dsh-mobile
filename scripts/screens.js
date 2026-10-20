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
        <p class="field__hint" style="margin-top:6px">${s.approval === "ask" ? "写入、终端、插件安装前会弹出审批。" : s.approval === "auto" ? "敏感操作直接执行，适合调好的固定流程。" : "所有敏感操作直接拒绝。"}</p>
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
    </div>`,

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
