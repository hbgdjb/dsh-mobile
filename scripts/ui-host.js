/* ============================================================
   界面宿主 —— 把插件声明的界面渲染成原生 DOM

   ============ 为什么不是"把组件传过来渲染" ============

   桌面版的 `ctx.slots.register(def, component)` 里，component 是
   React 组件**函数**。函数不能跨进程传：Node 里的闭包到了 WebView
   就是一段没有上下文的字节，`new Function` 跑起来只会拿到空的 props。

   所以手机端换一条路：插件给一棵**纯 JSON 的界面树**，宿主用
   document.createElement 一个个建出来。这就是"原生 DOM 逐个移植" ——
   把桌面版的组件原语（Row / Text / Button / Input / Switch / Select …）
   逐个用原生元素实现，插件的写法从"写组件"变成"描述界面"。

   代价是插件要改一点代码；收益是它真的能显示出来 ——
   而不是注册成功、界面上什么都没有。

   ============ 安全边界 ============

   界面树是**第三方内容**，不能当 HTML 用：

     - 标签只有白名单里那十几个，没有 `html` / `script` / `iframe`
     - 文本一律走 textContent，永远不拼 innerHTML
     - 属性只认白名单键，`style` / `on*` / `class` 一律丢弃
     - 图片只允许 https: 与 data:image/
     - 节点数、深度、字符串长度都有上限

   这样即使插件写恶意树，最坏也只能在自己的卡片里显示一堆怪文字，
   拿不到宿主 DOM，也注入不了脚本。
   ============================================================ */

/** 可用的挂载点。与插件清单里的 surfaces 是同一套名字。 */
export const SLOT_NAMES = [
  "shell.overlay",
  "composer.toolbar",
  "sidebar.footer",
  "settings.section",
];

/** 一次渲染允许的最大节点数。超过就截断并提示，不让页面被拖死。 */
const MAX_NODES = 240;

/** 界面树最大嵌套深度。 */
const MAX_DEPTH = 8;

/** 单个字符串最长度（label / text / value）。 */
const MAX_TEXT = 2000;

/** 一次挂载最多的挂载数（防止插件刷屏）。 */
const MAX_MOUNTS_PER_PLUGIN = 12;

/** 节点类型白名单。不在这里的一律渲染成一行灰色提示。 */
const TYPES = new Set([
  "row",
  "column",
  "card",
  "list",
  "text",
  "badge",
  "button",
  "input",
  "switch",
  "select",
  "progress",
  "image",
  "divider",
  "spacer",
  "table",
  "tabs",
]);

/** 颜色语义。渲染成 data-tone，颜色全交给 CSS —— 插件不能指定任意颜色。 */
const TONES = new Set(["plain", "muted", "strong", "accent", "ok", "warn", "danger"]);

/** id → { id, slot, pluginId, pluginName, order, tree, el } */
const mounts = new Map();

/** 用户操作的回调。由 UI 层接上，转发给 Node 里的插件。 */
let actionSink = null;

/** 已经挂过事件委托的容器。避免每次 attach 重复绑定。 */
const wired = new WeakSet();

/** 挂载序号：给没有 id 的挂载自动编号。 */
let seq = 0;

/* ---------------- 对外接口 ---------------- */

/**
 * 设置动作回调。
 *
 * @param {Function|null} fn ({ mountId, pluginId, action, name, value }) => void
 */
export function setActionSink(fn) {
  actionSink = typeof fn === "function" ? fn : null;
}

/**
 * 挂载一个界面树。
 *
 * @param {object} def
 *   def.id        挂载 id（不填自动生成）
 *   def.slot      挂载点，必须在 SLOT_NAMES 里
 *   def.tree      界面树
 *   def.pluginId  归属插件
 *   def.pluginName
 *   def.order     同挂载点内的排序，小的在前
 * @returns {{ok:boolean, id?:string, error?:string}}
 */
export function mount(def) {
  const slot = String(def?.slot || "");
  if (!SLOT_NAMES.includes(slot)) {
    return { ok: false, error: `未知挂载点：${slot || "(空)"}` };
  }

  const pluginId = String(def?.pluginId || "unknown");
  if (countOf(pluginId) >= MAX_MOUNTS_PER_PLUGIN) {
    return { ok: false, error: `一个插件最多挂 ${MAX_MOUNTS_PER_PLUGIN} 个界面` };
  }

  const id = String(def?.id || `m_${pluginId}_${++seq}`);
  const next = sanitize(def?.tree);
  if (!next) {
    return { ok: false, error: "界面树为空或类型不支持" };
  }

  // 同一个 id 重复挂载 = 覆盖（热重载后插件会重新 apply，这是正常路径）
  const prev = mounts.get(id);
  if (prev && prev.el) prev.el.remove();

  mounts.set(id, {
    id,
    slot,
    pluginId,
    pluginName: String(def?.pluginName || pluginId),
    order: Number(def?.order) || 0,
    tree: next,
    el: null,
    /**
     * 纯本地的界面状态（比如 tabs 选了第几个）。
     *
     * 为什么要留：tabs 的内容全在树里，切换不需要问插件。
     * 但插件一更新树，整块会重绘 —— 不记住选了哪个，
     * 用户刚点开的第二页会跳回第一页。
     */
    local: prev?.local || {},
  });

  paint(slot);
  return { ok: true, id };
}

/**
 * 更新一棵已挂载的树。
 *
 * @returns {boolean} 挂载是否存在
 */
export function update(id, tree) {
  const m = mounts.get(String(id || ""));
  if (!m) return false;
  const next = sanitize(tree);
  if (!next) return false;
  m.tree = next;
  paint(m.slot);
  return true;
}

/** 卸载一个挂载。 */
export function unmount(id) {
  const m = mounts.get(String(id || ""));
  if (!m) return false;
  if (m.el) m.el.remove();
  mounts.delete(m.id);
  paint(m.slot);
  return true;
}

/**
 * 卸载某个插件的全部界面。
 *
 * 插件卸载 / 热重载时必须调 —— 否则旧界面留在屏幕上，
 * 点它却没有任何反应（handler 已经跟着 fiber 一起没了）。
 *
 * @returns {number} 卸掉了几个
 */
export function unmountPlugin(pluginId) {
  const pid = String(pluginId || "");
  let n = 0;
  const touched = new Set();
  for (const [id, m] of Array.from(mounts.entries())) {
    if (m.pluginId !== pid) continue;
    if (m.el) m.el.remove();
    mounts.delete(id);
    touched.add(m.slot);
    n += 1;
  }
  touched.forEach((slot) => paint(slot));
  return n;
}

/** 当前所有挂载（供诊断面板）。 */
export function listMounts() {
  return Array.from(mounts.values()).map((m) => ({
    id: m.id,
    slot: m.slot,
    pluginId: m.pluginId,
    pluginName: m.pluginName,
    order: m.order,
  }));
}

/** 某个挂载点当前有几个挂载。 */
export function slotCount(slot) {
  let n = 0;
  mounts.forEach((m) => {
    if (m.slot === slot) n += 1;
  });
  return n;
}

/**
 * 把已挂载的界面画进页面里的占位符。
 *
 * 每次重建视图（对话页 innerHTML 重写、抽屉重开、设置页切类目）
 * 之后都要调一次 —— 占位符是新的 DOM 节点，旧引用已经作废。
 *
 * @param {ParentNode} root 扫描范围，默认整个文档
 */
export function attach(root) {
  const scope = root && typeof root.querySelectorAll === "function" ? root : document;
  const slots = new Set();
  scope.querySelectorAll("[data-ui-slot]").forEach((el) => {
    slots.add(el.getAttribute("data-ui-slot"));
  });
  slots.forEach((slot) => paint(slot, scope));
}

/* ---------------- 渲染 ---------------- */

/**
 * 重画一个挂载点。
 *
 * @param {string} slot
 * @param {ParentNode} scope 在哪个范围里找占位符
 */
function paint(slot, scope) {
  const root = scope && typeof scope.querySelectorAll === "function" ? scope : document;
  root.querySelectorAll(`[data-ui-slot="${cssEscape(slot)}"]`).forEach((host) => {
    const items = Array.from(mounts.values())
      .filter((m) => m.slot === slot)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

    host.textContent = "";
    // 没有挂载时整块收起来 —— 留一个空 div 会在输入框上方多出一条缝
    host.hidden = items.length === 0;
    host.classList.toggle("ui-slot--empty", items.length === 0);

    items.forEach((m) => {
      const wrap = document.createElement("div");
      wrap.className = "ui-plugin";
      wrap.dataset.mountId = m.id;
      wrap.dataset.plugin = m.pluginId;
      // 注意：这里**不能** stopPropagation —— 事件要冒泡到挂载点上，
      // 由那边的委托统一处理。点插件区域不穿透到底下的列表，
      // 是在挂载点那一层挡的（见 wire）。
      wrap.appendChild(renderNode(m.tree, m, "r"));
      host.appendChild(wrap);
      m.el = wrap;
    });

    wire(host, slot);
  });
}

/**
 * 给容器挂一次事件委托。
 *
 * 每次渲染都重新绑会让监听器越积越多（重建十次就有十个），
 * 用一个 WeakSet 记账，一个容器只挂一次。
 */
function wire(host, slot) {
  if (wired.has(host)) return;
  wired.add(host);
  host.addEventListener("click", (e) => {
    // 点在插件界面里：不要让事件继续往上跑，
    // 否则浮层里的卡片会被底下的会话项 / 设置行再处理一次。
    e.stopPropagation();
    const target = e.target.closest?.("[data-ui-action]");
    if (!target || !host.contains(target)) return;
    emit(target, slot);
  });
  host.addEventListener("change", (e) => {
    const t = e.target;
    if (!t || !t.dataset) return;
    if (t.dataset.uiAction && (t.tagName === "SELECT" || t.tagName === "INPUT")) {
      // 文本输入框的 change 只在失焦时触发，回车由 keydown 单独处理
      emit(t, slot);
    }
  });
  host.addEventListener("keydown", (e) => {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.uiAction) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      emit(t, slot);
    }
  });
}

/** 把一个可交互节点的当前值发给插件。 */
function emit(el, slot) {
  const host = el.closest?.(".ui-plugin");
  const mountId = host?.dataset?.mountId || "";
  if (!mountId) return;

  let value = el.dataset.uiValue ?? null;
  if (el.dataset.uiKind === "switch") {
    value = el.getAttribute("aria-checked") !== "true";
    // 先翻转本地状态：等插件回包再翻会让开关有半秒延迟，手感很差
    el.setAttribute("aria-checked", String(value));
    el.classList.toggle("is-on", value);
  } else if (el.dataset.uiKind === "input" || el.dataset.uiKind === "select") {
    value = el.value ?? "";
  }

  sendAction({
    mountId,
    slot,
    pluginId: host?.dataset?.plugin || "",
    action: el.dataset.uiAction || "",
    name: el.dataset.uiName || "",
    value,
  });
}

/** 把一次动作交给 UI 层（再由它转给 Node 里的插件）。 */
function sendAction(payload) {
  if (!actionSink) return;
  try {
    actionSink(payload);
  } catch (err) {
    console.warn("[ui-host] 动作回调出错：", err?.message || err);
  }
}

/* ---------------- 单节点渲染 ---------------- */

/**
 * 渲染一个节点。
 *
 * 全部走 createElement + textContent，没有任何一处 innerHTML ——
 * 这是"插件内容不可信"这条边界的实现方式。
 */
function renderNode(node, mount, path) {
  const type = String(node?.t || "text");
  const el = document.createElement("div");
  el.className = `uih uih--${type}`;

  if (node.tone && TONES.has(node.tone)) el.dataset.tone = node.tone;

  switch (type) {
    case "row":
    case "column": {
      el.classList.add("uih--stack");
      if (type === "row") el.classList.add("uih--horizontal");
      if (node.gap) el.dataset.gap = node.gap;
      if (node.align) el.dataset.align = node.align;
      if (node.wrap) el.dataset.wrap = "true";
      appendChildren(el, node.children, mount, path);
      break;
    }
    case "card": {
      if (node.title) {
        const h = document.createElement("div");
        h.className = "uih__title";
        h.textContent = node.title;
        el.appendChild(h);
      }
      if (node.subtitle) {
        const s = document.createElement("div");
        s.className = "uih__sub";
        s.textContent = node.subtitle;
        el.appendChild(s);
      }
      const body = document.createElement("div");
      body.className = "uih__body";
      appendChildren(body, node.children, mount, path);
      el.appendChild(body);
      break;
    }
    case "list": {
      appendChildren(el, node.children, mount, path);
      break;
    }
    case "text": {
      el.textContent = String(node.text ?? "");
      if (node.size) el.dataset.size = node.size;
      if (node.mono) el.dataset.mono = "true";
      if (node.strong) el.dataset.strong = "true";
      if (node.center) el.dataset.center = "true";
      break;
    }
    case "badge": {
      el.textContent = String(node.text ?? "");
      el.classList.add("uih__badge");
      break;
    }
    case "button": {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "uih__btn";
      btn.textContent = String(node.label ?? node.text ?? "按钮");
      if (node.tone) btn.dataset.tone = node.tone;
      if (node.grow) btn.dataset.grow = "true";
      if (node.disabled) btn.disabled = true;
      tagAction(btn, node, "button");
      el.appendChild(btn);
      break;
    }
    case "input": {
      if (node.label) {
        const lab = document.createElement("label");
        lab.className = "uih__label";
        lab.textContent = node.label;
        el.appendChild(lab);
      }
      const multiline = !!node.multiline;
      const field = document.createElement(multiline ? "textarea" : "input");
      field.className = "uih__field";
      if (!multiline) field.type = "text";
      if (multiline) field.rows = 2;
      field.placeholder = String(node.placeholder || "");
      field.value = String(node.value ?? "");
      field.dataset.uiKind = "input";
      tagAction(field, node, "input");
      el.appendChild(field);
      break;
    }
    case "switch": {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "uih__switch";
      sw.setAttribute("role", "switch");
      sw.setAttribute("aria-checked", node.checked ? "true" : "false");
      sw.classList.toggle("is-on", !!node.checked);
      sw.dataset.uiKind = "switch";
      const label = document.createElement("span");
      label.className = "uih__switch-label";
      label.textContent = String(node.label ?? "");
      sw.appendChild(label);
      const track = document.createElement("span");
      track.className = "uih__switch-track";
      track.setAttribute("aria-hidden", "true");
      sw.appendChild(track);
      tagAction(sw, node, "switch");
      el.appendChild(sw);
      break;
    }
    case "select": {
      if (node.label) {
        const lab = document.createElement("label");
        lab.className = "uih__label";
        lab.textContent = node.label;
        el.appendChild(lab);
      }
      const sel = document.createElement("select");
      sel.className = "uih__field uih__field--select";
      (Array.isArray(node.options) ? node.options : []).forEach((o) => {
        const opt = document.createElement("option");
        opt.value = String(o?.value ?? "");
        opt.textContent = String(o?.label ?? o?.value ?? "");
        if (String(o?.value ?? "") === String(node.value ?? "")) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.dataset.uiKind = "select";
      tagAction(sel, node, "select");
      el.appendChild(sel);
      break;
    }
    case "progress": {
      const value = clamp(Number(node.value) || 0, 0, 1);
      const track = document.createElement("div");
      track.className = "uih__track";
      const bar = document.createElement("div");
      bar.className = "uih__bar";
      bar.style.width = `${Math.round(value * 100)}%`;
      track.appendChild(bar);
      el.appendChild(track);
      if (node.label) {
        const lab = document.createElement("div");
        lab.className = "uih__sub";
        lab.textContent = node.label;
        el.appendChild(lab);
      }
      break;
    }
    case "image": {
      const img = document.createElement("img");
      img.className = "uih__img";
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = String(node.alt || "");
      img.src = String(node.src || "");
      if (node.height) img.style.height = `${clamp(Number(node.height) || 120, 24, 320)}px`;
      img.addEventListener("error", () => el.classList.add("is-broken"));
      el.appendChild(img);
      break;
    }
    case "divider": {
      el.className = "uih uih--divider";
      break;
    }
    case "spacer": {
      el.className = "uih uih--spacer";
      el.dataset.size = node.size || "sm";
      break;
    }
    case "table": {
      // 手机上宽度紧张，表格一定会超宽。
      // 所以外面套一层可横向滚动的壳，而不是把列硬压窄 ——
      // 压窄的结果是每格两三个字，等于没显示。
      const wrap = document.createElement("div");
      wrap.className = "uih__table-wrap";

      const table = document.createElement("table");
      table.className = "uih__table";

      const cols = Array.isArray(node.columns) ? node.columns : [];
      if (cols.length) {
        const thead = document.createElement("thead");
        const tr = document.createElement("tr");
        cols.forEach((c) => {
          const th = document.createElement("th");
          th.textContent = String(c.label ?? c.key ?? "");
          if (c.align) th.dataset.align = c.align;
          tr.appendChild(th);
        });
        thead.appendChild(tr);
        table.appendChild(thead);
      }

      const tbody = document.createElement("tbody");
      const rows = Array.isArray(node.rows) ? node.rows : [];
      rows.forEach((row) => {
        const tr = document.createElement("tr");
        const cells = Array.isArray(row) ? row : cols.map((c) => row?.[c.key]);
        cells.forEach((cell, i) => {
          const td = document.createElement("td");
          // 单元格可以是纯字符串，也可以是 { text, tone } —— 后者用来标红/标绿
          const text = cell && typeof cell === "object" ? cell.text ?? "" : cell ?? "";
          td.textContent = String(text);
          const tone = cell && typeof cell === "object" ? cell.tone : "";
          if (tone && TONES.has(tone)) td.dataset.tone = tone;
          if (cols[i]?.align) td.dataset.align = cols[i].align;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);

      if (!rows.length) {
        const empty = document.createElement("div");
        empty.className = "uih__table-empty";
        empty.textContent = String(node.empty || "没有数据");
        wrap.appendChild(table);
        wrap.appendChild(empty);
      } else {
        wrap.appendChild(table);
      }
      el.appendChild(wrap);
      break;
    }
    case "tabs": {
      // 分页签：内容都在树里，切换可以完全本地做 ——
      // 不必等插件回包。回包只是"顺便告诉插件一声"。
      //
      // 所以当前选中的页签记在 mount.local 里：重绘时优先用它，
      // 否则用户点了「第二页」，插件一更新树就跳回「第一页」。
      el.classList.add("uih--tabs");
      const items = Array.isArray(node.items) ? node.items : [];
      const key = node.name || path;
      const current =
        (mount?.local?.tabs?.[key]) ?? node.value ?? items[0]?.value ?? "";

      const bar = document.createElement("div");
      bar.className = "uih__tabs-bar";
      bar.setAttribute("role", "tablist");

      const panels = [];

      const select = (value, fire) => {
        items.forEach((it, i) => {
          const on = it.value === value;
          bar.children[i]?.setAttribute("aria-selected", String(on));
          bar.children[i]?.classList.toggle("is-on", on);
          if (panels[i]) panels[i].hidden = !on;
        });
        if (mount) {
          if (!mount.local) mount.local = {};
          if (!mount.local.tabs) mount.local.tabs = {};
          mount.local.tabs[key] = value;
        }
        if (fire && node.action) {
          sendAction({
            mountId: mount?.id || "",
            slot: mount?.slot || "",
            pluginId: mount?.pluginId || "",
            action: node.action,
            name: node.name || "",
            value,
          });
        }
      };

      items.forEach((it) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "uih__tab";
        btn.setAttribute("role", "tab");
        btn.textContent = String(it.label ?? it.value ?? "");
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          select(it.value, true);
        });
        bar.appendChild(btn);
      });
      el.appendChild(bar);

      items.forEach((it) => {
        const panel = document.createElement("div");
        panel.className = "uih__panel";
        panel.setAttribute("role", "tabpanel");
        appendChildren(panel, it.children, mount, `${path}.t`);
        el.appendChild(panel);
        panels.push(panel);
      });

      select(current, false);
      break;
    }
    default: {
      el.className = "uih uih--unknown";
      el.textContent = `不支持的组件：${type}`;
    }
  }

  return el;
}

/** 给元素盖上"点了要发什么"的标记。 */
function tagAction(el, node, kind) {
  if (node.action) el.dataset.uiAction = String(node.action);
  if (node.name) el.dataset.uiName = String(node.name);
  if (node.value != null) el.dataset.uiValue = String(node.value);
  el.dataset.uiKind = kind;
}

function appendChildren(el, children, mount, path) {
  if (!Array.isArray(children)) return;
  children.forEach((c, i) => {
    if (c) el.appendChild(renderNode(c, mount, `${path}.${i}`));
  });
}

/* ---------------- 树清洗 ---------------- */

/**
 * 把插件给的任意对象洗成一棵安全的界面树。
 *
 * 三道闸：类型白名单、节点/深度上限、字符串截断。
 * 洗完的树可以放心渲染 —— 渲染层不用再判断合法性。
 *
 * @param {any} node
 * @param {number} depth
 * @param {{count:number}} budget
 * @returns {object|null}
 */
function sanitize(node, depth = 0, budget = { count: 0 }) {
  if (!node || typeof node !== "object") return null;
  if (depth > MAX_DEPTH) return null;
  if (budget.count >= MAX_NODES) return null;

  // 允许简写：字符串直接当文本
  if (typeof node === "string") return { t: "text", text: clip(node) };

  const type = String(node.type || node.t || "text");
  if (!TYPES.has(type)) {
    return { t: "text", text: `不支持的组件：${clip(type, 40)}`, tone: "muted" };
  }
  budget.count += 1;

  const out = { t: type };
  if (node.tone && TONES.has(node.tone)) out.tone = node.tone;

  switch (type) {
    case "row":
    case "column": {
      if (node.gap) out.gap = pick(node.gap, ["xs", "sm", "md", "lg"], "sm");
      if (node.align) out.align = pick(node.align, ["start", "center", "end", "between"], "start");
      out.wrap = !!node.wrap;
      out.children = sanitizeChildren(node.children, depth, budget);
      break;
    }
    case "card": {
      if (node.title) out.title = clip(node.title);
      if (node.subtitle) out.subtitle = clip(node.subtitle);
      out.children = sanitizeChildren(node.children, depth, budget);
      break;
    }
    case "list": {
      out.children = sanitizeChildren(node.children, depth, budget);
      break;
    }
    case "text": {
      out.text = clip(node.text ?? node.label ?? "");
      if (node.size) out.size = pick(node.size, ["sm", "md", "lg", "xl"], "md");
      out.mono = !!node.mono;
      out.strong = !!node.strong;
      out.center = !!node.center;
      break;
    }
    case "badge": {
      out.text = clip(node.text ?? node.label ?? "");
      break;
    }
    case "button": {
      out.label = clip(node.label ?? node.text ?? "按钮", 80);
      if (node.action) out.action = clip(node.action, 120);
      if (node.name) out.name = clip(node.name, 60);
      if (node.value != null) out.value = clip(node.value, 500);
      out.disabled = !!node.disabled;
      out.grow = !!node.grow;
      break;
    }
    case "input": {
      if (node.label) out.label = clip(node.label, 80);
      if (node.placeholder) out.placeholder = clip(node.placeholder, 200);
      out.value = clip(node.value ?? "", 1000);
      out.multiline = !!node.multiline;
      if (node.action) out.action = clip(node.action, 120);
      if (node.name) out.name = clip(node.name, 60);
      break;
    }
    case "switch": {
      out.label = clip(node.label ?? "", 120);
      out.checked = !!node.checked;
      if (node.action) out.action = clip(node.action, 120);
      if (node.name) out.name = clip(node.name, 60);
      break;
    }
    case "select": {
      if (node.label) out.label = clip(node.label, 80);
      const opts = Array.isArray(node.options) ? node.options.slice(0, 40) : [];
      out.options = opts.map((o) => ({
        value: clip(o?.value ?? "", 120),
        label: clip(o?.label ?? o?.value ?? "", 120),
      }));
      out.value = clip(node.value ?? "", 120);
      if (node.action) out.action = clip(node.action, 120);
      if (node.name) out.name = clip(node.name, 60);
      break;
    }
    case "progress": {
      out.value = clamp(Number(node.value) || 0, 0, 1);
      if (node.label) out.label = clip(node.label, 120);
      break;
    }
    case "image": {
      const src = String(node.src || "");
      // 只认 https 与 data:image —— http 会混进明文内容，
      // file: 能探测本机文件，javascript: 直接是脚本注入
      if (!/^(https:\/\/|data:image\/)/i.test(src)) return null;
      out.src = clip(src, 300000);
      out.alt = clip(node.alt || "", 200);
      if (node.height) out.height = clamp(Number(node.height) || 120, 24, 320);
      break;
    }
    case "spacer": {
      out.size = pick(node.size, ["xs", "sm", "md"], "sm");
      break;
    }
    case "table": {
      // 列数与行数都封顶：表格最容易失控 ——
      // 一个插件把 5000 行日志塞进来，整页就卡住了。
      const cols = Array.isArray(node.columns) ? node.columns.slice(0, 8) : [];
      out.columns = cols.map((c) => ({
        key: clip(c?.key ?? "", 60),
        label: clip(c?.label ?? c?.key ?? "", 60),
        align: pick(c?.align, ["left", "center", "right"], "left"),
      }));
      const rows = Array.isArray(node.rows) ? node.rows.slice(0, 100) : [];
      out.rows = rows.map((r) => {
        const cells = Array.isArray(r) ? r.slice(0, 8) : out.columns.map((c) => r?.[c.key]);
        return cells.map((cell) => {
          if (cell && typeof cell === "object") {
            return {
              text: clip(cell.text ?? "", 200),
              tone: TONES.has(cell.tone) ? cell.tone : "",
            };
          }
          return { text: clip(cell ?? "", 200), tone: "" };
        });
      });
      out.empty = clip(node.empty || "没有数据", 60);
      break;
    }
    case "tabs": {
      if (node.name) out.name = clip(node.name, 60);
      if (node.action) out.action = clip(node.action, 120);
      out.value = clip(node.value ?? "", 120);
      const items = Array.isArray(node.children) ? node.children.slice(0, 8) : [];
      out.items = items.map((it) => ({
        label: clip(it?.label ?? it?.text ?? "", 40),
        value: clip(it?.value ?? "", 120),
        children: sanitizeChildren(it?.children, depth + 1, budget),
      }));
      // 一个都没有的 tabs 没有意义，直接当空
      if (!out.items.length) return null;
      break;
    }
    default:
      break;
  }

  return out;
}

function sanitizeChildren(children, depth, budget) {
  if (!Array.isArray(children)) return [];
  const out = [];
  for (const c of children.slice(0, 60)) {
    const s = typeof c === "string" ? { t: "text", text: clip(c) } : sanitize(c, depth + 1, budget);
    if (s) out.push(s);
    if (budget.count >= MAX_NODES) break;
  }
  return out;
}

/* ---------------- 小工具 ---------------- */

function clip(v, max = MAX_TEXT) {
  const s = typeof v === "string" ? v : String(v ?? "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
}

function pick(v, allowed, fallback) {
  return allowed.includes(String(v)) ? String(v) : fallback;
}

function countOf(pluginId) {
  let n = 0;
  mounts.forEach((m) => {
    if (m.pluginId === pluginId) n += 1;
  });
  return n;
}

function cssEscape(s) {
  // CSS.escape 在旧 WebView 上可能没有；挂载点是固定白名单，简单替换足够
  return String(s).replace(/["\\]/g, "\\$&");
}
