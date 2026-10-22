/* ============================================================
   插件宿主能力 —— 把宿主功能按插件声明的权限逐项开放

   这里是沙箱与宿主之间唯一的实际通道。
   插件代码里 `dsh.host.fsRead(...)` 最终落到这里的实现，
   而这里只会被传入**已经通过权限校验**的调用。

   每项能力都有明确的边界：
     fs.read  —— 只能读工作区（不是整个手机文件系统）
     fs.write —— 只能写工作区，且路径不能逃出工作区
     net      —— 只能发 HTTP(S) 请求，不能读本地文件、不能带宿主凭据
   ============================================================ */

import { readFile, writeFile, listFiles } from "./store.js";
import { nativeGetText } from "./native-http.js";
import { installHostImpl } from "./plugin-host.js";

/** 单次网络请求的响应体上限。防止插件把大文件全拉下来撑爆内存。 */
const MAX_NET_BYTES = 2 * 1024 * 1024;

/** 网络请求超时。 */
const NET_TIMEOUT = 30;

/**
 * 挂载宿主能力。
 *
 * 在应用启动时调用一次。挂载后插件才能真正用上这些能力。
 */
export function mountPluginHost() {
  installHostImpl({
    async fsRead(plugin, params) {
      const path = String(params?.path || "");
      if (!path) return { ok: false, output: "缺少 path" };
      const doc = await readFile(path);
      if (!doc) return { ok: false, output: `文件不存在：${path}` };
      return { ok: true, result: { path: doc.path, content: doc.content } };
    },

    async fsWrite(plugin, params) {
      const path = String(params?.path || "");
      const content = String(params?.content ?? "");
      if (!path) return { ok: false, output: "缺少 path" };
      // 路径逃逸防护：writeFile 内部会做工作区归一化，
      // 这里再挡一道 ".." 与绝对路径，避免插件写到工作区之外。
      if (path.includes("..") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
        return { ok: false, output: "路径不合法：只能写工作区内的相对路径" };
      }
      const res = await writeFile(path, content);
      return { ok: true, result: { path: res.path } };
    },

    async netFetch(plugin, params) {
      const url = String(params?.url || "");
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, output: "只支持 http:// 与 https://" };
      }
      const method = String(params?.method || "GET").toUpperCase();
      const res = await nativeGetText(url, { timeoutSec: NET_TIMEOUT });
      if (res.text.length > MAX_NET_BYTES) {
        return { ok: false, output: "响应体过大" };
      }
      if (!res.ok) {
        return { ok: false, output: `HTTP ${res.status}：${res.error || "请求失败"}` };
      }
      return {
        ok: true,
        result: { status: res.status, body: res.text, method },
      };
    },
  });
}

/**
 * 列出工作区文件（供插件在有 fs.read 权限时了解结构）。
 */
export async function pluginWorkspaceListing() {
  try {
    return listFiles();
  } catch {
    return [];
  }
}
