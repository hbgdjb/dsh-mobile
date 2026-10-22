/* ============================================================
   插件安装 —— 从 URL 或官方清单拉取、校验、落库、装载

   流程：

     1. 取清单
        - 官方清单：直接取内置的
        - 任意 URL：GET 那个地址，解析 JSON
          （APK 内走原生桥，绕开 WebView 的 CORS 限制）
     2. 校验清单（plugin-manifest.js）
     3. 取代码
        - 清单带 code：直接用
        - 清单带 entry：再 GET 一次
     4. 用户确认权限
     5. 落库（localStorage）+ 装载（iframe 沙箱）

   落库只存**元数据 + 代码**，不存运行时状态。
   运行时（iframe、token、注册的工具）全在内存里，重启应用重新装载。
   ============================================================ */

import { state, save, emit, readFile, writeFile, deleteFile } from "./store.js";
import { nativeGetText } from "./native-http.js";
import {
  validateManifest,
  findOfficialPlugin,
  ALLOWED_PERMISSIONS,
} from "./plugin-manifest.js";
import { loadPlugin, unloadPlugin, registeredTools, runtimeOf } from "./plugin-host.js";

/** 插件在本地存储里的上限：装太多会把 localStorage 撑爆。 */
const MAX_INSTALLED = 30;

/**
 * 插件代码存在哪。
 *
 * 不存 localStorage —— 那里只有 5MB 上限，而单个插件代码允许到 400KB，
 * 装十几个就写不进去了（writeJson 静默失败，用户会以为装上了其实没装）。
 * 代码存工作区文件，元数据才进 localStorage。
 */
function codePathFor(id) {
  return `plugins/${id}/main.js`;
}

/**
 * 从任意 URL 拉取插件清单。
 * @returns {Promise<{ok:boolean, plugin?:object, error?:string, source?:string}>}
 */
export async function fetchManifestFromUrl(url) {
  const raw = String(url || "").trim();
  if (!/^https?:\/\//i.test(raw)) {
    return { ok: false, error: "地址必须以 http:// 或 https:// 开头" };
  }
  const res = await nativeGetText(raw, { timeoutSec: 30 });
  if (!res.ok) {
    return { ok: false, error: res.error || `拉取失败（HTTP ${res.status}）` };
  }
  let parsed;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    return { ok: false, error: "返回的内容不是合法 JSON —— 这不是一个插件清单" };
  }
  const v = validateManifest(parsed);
  if (!v.ok) return { ok: false, error: v.error };
  return { ok: true, plugin: { ...v.plugin, source: raw }, source: raw };
}

/**
 * 取官方插件清单。
 */
export function fetchOfficialManifest(id) {
  const raw = findOfficialPlugin(id);
  if (!raw) return { ok: false, error: "官方清单里没有这个插件" };
  const v = validateManifest(raw);
  if (!v.ok) return { ok: false, error: v.error };
  return { ok: true, plugin: { ...v.plugin, source: "official" }, source: "official" };
}

/**
 * 把插件的代码补齐。
 * 清单里有 entry 的，需要再拉一次代码。
 */
export async function resolvePluginCode(plugin) {
  if (plugin.code) return { ok: true, plugin };
  if (!plugin.entry) return { ok: false, error: "插件没有代码" };
  const res = await nativeGetText(plugin.entry, { timeoutSec: 30 });
  if (!res.ok) {
    return { ok: false, error: `拉取插件代码失败：${res.error || "HTTP " + res.status}` };
  }
  return { ok: true, plugin: { ...plugin, code: res.text } };
}

/**
 * 校验一个插件是否可以安装（不落库）。
 * 用于「先看看这个插件要什么权限」这一步。
 */
export async function inspectPlugin(source) {
  const got =
    source === "official" || !/^https?:\/\//i.test(String(source || ""))
      ? fetchOfficialManifest(source)
      : await fetchManifestFromUrl(source);
  if (!got.ok) return got;

  const resolved = await resolvePluginCode(got.plugin);
  if (!resolved.ok) return resolved;

  return {
    ok: true,
    plugin: resolved.plugin,
    source: got.source,
    warnings: buildWarnings(resolved.plugin),
  };
}

/** 生成安装前的风险提示。 */
function buildWarnings(plugin) {
  const out = [];
  const perms = plugin.permissions || [];
  if (perms.includes("fs.write")) {
    out.push("可写入工作区文件");
  }
  if (perms.includes("fs.read")) {
    out.push("可读取工作区文件");
  }
  if (perms.includes("net")) {
    out.push("可发起网络请求（数据可能被外发）");
  }
  if (!out.length) {
    out.push("不申请任何宿主能力，仅在沙箱内计算");
  }
  return out;
}

/**
 * 安装插件。
 *
 * @param {object} plugin 已通过 validateManifest 的清单（含 code）
 * @returns {{ok:boolean, plugin?:object, error?:string, warning?:string}}
 */
export async function installPluginPackage(plugin) {
  const v = validateManifest(plugin);
  if (!v.ok) return { ok: false, error: v.error };

  const p = v.plugin;
  const existing = state.plugins.find((x) => x.id === p.id);

  if (existing && existing.removable === false) {
    return { ok: false, error: `「${existing.name}」是内置插件，不能被覆盖` };
  }
  if (!existing && state.plugins.length >= MAX_INSTALLED) {
    return { ok: false, error: `已安装的插件太多（上限 ${MAX_INSTALLED}），先卸掉几个` };
  }

  // 代码落工作区文件
  let codePath = "";
  try {
    codePath = codePathFor(p.id);
    await writeFile(codePath, p.code || "");
  } catch (err) {
    return { ok: false, error: `写入插件代码失败：${err.message}` };
  }

  const record = {
    id: p.id,
    name: p.name,
    desc: p.description,
    version: p.version,
    author: p.author,
    homepage: p.homepage,
    source: p.source || plugin.source || "",
    permissions: p.permissions || [],
    tools: p.tools || [],
    scopes: [],
    enabled: existing ? existing.enabled : true,
    preinstalled: false,
    removable: true,
    installedAt: existing?.installedAt || Date.now(),
    codePath,
  };

  if (existing) {
    const i = state.plugins.indexOf(existing);
    state.plugins[i] = { ...existing, ...record };
  } else {
    state.plugins.push(record);
  }
  save();
  emit({ type: "plugin:install", id: p.id });

  // 立刻装载沙箱。
  //
  // 注意必须把代码带上：record 里只存 codePath（代码在工作区文件里），
  // 而沙箱启动读的是 plugin.code。少传一步，插件代码就不会执行，
  // 表现为「装上了但没有任何新工具」——而且不报错，最难查。
  try {
    loadPlugin({ ...record, code: p.code || "" });
  } catch (err) {
    return { ok: true, plugin: record, warning: `插件已保存，但沙箱启动失败：${err.message}` };
  }
  return { ok: true, plugin: record };
}

/**
 * 卸载插件：删记录 + 销毁沙箱 + 删代码文件。
 */
export async function uninstallPlugin(id) {
  const p = state.plugins.find((x) => x.id === id);
  if (!p) return { ok: false, error: "插件不存在" };
  if (p.removable === false) return { ok: false, error: "内置插件不能卸载" };
  unloadPlugin(id);
  state.plugins = state.plugins.filter((x) => x.id !== id);
  save();
  emit({ type: "plugin:uninstall", id });
  try {
    await deleteFile(p.codePath || codePathFor(id));
  } catch {
    /* 文件本来就不在 */
  }
  return { ok: true };
}

/**
 * 启用 / 禁用插件。禁用会销毁沙箱（插件里的一切随之停止）。
 */
export async function setPluginEnabled(id, enabled) {
  const p = state.plugins.find((x) => x.id === id);
  if (!p) return { ok: false, error: "插件不存在" };
  p.enabled = !!enabled;
  save();
  if (enabled) {
    let code = "";
    try {
      const doc = await readFile(p.codePath || "");
      code = doc?.content || "";
    } catch {
      p.enabled = false;
      save();
      return { ok: false, error: "插件代码文件读不到（可能被手动删了）" };
    }
    if (!code) {
      p.enabled = false;
      save();
      return { ok: false, error: "插件代码是空的" };
    }
    try {
      loadPlugin({ ...p, code });
    } catch (err) {
      p.enabled = false;
      save();
      return { ok: false, error: `沙箱启动失败：${err.message}` };
    }
  } else {
    unloadPlugin(id);
  }
  emit({ type: "plugin:toggle", id, enabled: p.enabled });
  return { ok: true };
}

/**
 * 装载全部已启用的插件。应用启动时调用。
 *
 * 代码在工作区文件里（不在 localStorage），所以这里是异步的。
 */
export async function loadEnabledPlugins() {
  const out = { loaded: [], failed: [] };
  for (const p of state.plugins) {
    if (!p.enabled) continue;
    // 内置插件（office / safety / effort / ops）没有 code，
    // 它们是宿主内的静态能力，不需要沙箱。
    if (!p.codePath) continue;
    let code = "";
    try {
      const doc = await readFile(p.codePath);
      code = doc?.content || "";
    } catch {
      out.failed.push({ id: p.id, error: "插件代码文件读不到（可能被手动删了）" });
      continue;
    }
    if (!code) {
      out.failed.push({ id: p.id, error: "插件代码是空的" });
      continue;
    }
    try {
      loadPlugin({ ...p, code });
      out.loaded.push(p.id);
    } catch (err) {
      out.failed.push({ id: p.id, error: err.message });
    }
  }
  return out;
}

/**
 * 当前所有已启用插件注册的工具。
 * 宿主用它来装配模型可用的工具表。
 */
export function pluginToolSchemas() {
  const out = [];
  registeredTools().forEach((t) => {
    out.push({
      type: "function",
      function: {
        name: `plugin__${t.pluginId}__${t.name}`,
        description: `[插件 · ${t.pluginName}] ${t.description || t.name}`,
        parameters: t.parameters,
      },
    });
  });
  return out;
}

/**
 * 调用插件工具。
 * 名字形如 plugin__<pluginId>__<toolName>。
 */
export async function callPluginTool(fullName, args) {
  const m = /^plugin__([a-z0-9_-]+)__(.+)$/.exec(String(fullName || ""));
  if (!m) return { ok: false, output: `插件工具名不合法：${fullName}` };
  const [, pluginId, toolName] = m;
  const rt = runtimeOf(pluginId);
  if (!rt) return { ok: false, output: `插件 ${pluginId} 未运行（可能已被禁用或卸载）` };
  try {
    const text = await rt.call(toolName, args || {});
    return { ok: true, output: typeof text === "string" ? text : JSON.stringify(text) };
  } catch (err) {
    return { ok: false, output: `插件调用失败：${err.message}` };
  }
}

/** 已安装插件的清单视图（不含代码，便于展示）。 */
export function installedPlugins() {
  return state.plugins.map((p) => ({
    id: p.id,
    name: p.name,
    desc: p.desc,
    version: p.version,
    author: p.author,
    source: p.source || "",
    permissions: p.permissions || [],
    tools: p.tools || [],
    enabled: p.enabled,
    preinstalled: !!p.preinstalled,
    removable: p.removable !== false,
    installedAt: p.installedAt || 0,
  }));
}

/** 允许的权限列表（给界面展示用）。 */
export { ALLOWED_PERMISSIONS };
