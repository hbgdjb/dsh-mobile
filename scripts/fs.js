/* ============================================================
   统一文件层：工作区（workspace）与资料库（library）
   - APK：window.DshFs → DshFsBridge.java → 手机真实目录（应用专属外部目录）
   - 浏览器 / PWA：IndexedDB
   两侧同一套异步 API；元数据索引由 store 维护，这里只做读写。
   ============================================================ */

const bridge = () => (typeof window !== "undefined" ? window.DshFs : null);

export function nativeFsAvailable() {
  const b = bridge();
  return !!b && typeof b.list === "function";
}

/* ---------------- 原生桥：id + 事件回调 ---------------- */

let seq = 0;
const pending = new Map();

function emitToPending(raw) {
  let evt;
  try {
    evt = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return;
  }
  const item = pending.get(evt?.id);
  if (!item) return;
  pending.delete(evt.id);
  if (evt.ok) item.resolve(evt);
  else item.reject(new Error(evt.error || "文件操作失败"));
}

if (typeof window !== "undefined") {
  window.__dshFsEvent = emitToPending;
}

function nativeCall(method, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const b = bridge();
    if (!b || typeof b[method] !== "function") {
      reject(new Error("原生文件桥不可用"));
      return;
    }
    const id = `fs${Date.now().toString(36)}_${seq++}`;
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("文件操作超时"));
      }
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    try {
      b[method](id, ...args);
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err);
    }
  });
}

/* ---------------- IndexedDB 后端 ---------------- */

const DB_NAME = "dsh.fs.v1";
const DB_STORE = "files";
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        const os = db.createObjectStore(DB_STORE, { keyPath: "key" });
        os.createIndex("area", "area", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("无法打开本地数据库"));
  });
  return dbPromise;
}

async function idbTx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode);
    const store = tx.objectStore(DB_STORE);
    let result;
    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(result?.__value);
    tx.onerror = () => reject(tx.error || new Error("本地存储失败"));
    tx.onabort = () => reject(tx.error || new Error("本地存储被中止"));
  });
}

function idbReq(req) {
  const box = {};
  req.onsuccess = () => {
    box.__value = req.result;
  };
  req.onerror = () => {
    box.__error = req.error;
  };
  return box;
}

const keyOf = (area, path) => `${area}:${path}`;

/* ---------------- 文本 / 二进制判定 ---------------- */

const TEXT_EXT = new Set([
  "md", "markdown", "txt", "csv", "tsv", "json", "js", "mjs", "ts", "jsx", "tsx", "py", "html", "htm",
  "css", "scss", "xml", "yml", "yaml", "log", "sh", "bash", "java", "kt", "c", "h", "cpp", "rs", "go",
  "sql", "ini", "toml", "env", "gitignore", "svg", "patch", "diff",
]);

export function isTextPath(path) {
  const name = String(path || "");
  const base = name.split("/").pop() || "";
  if (!base.includes(".")) return true; // 无扩展名按文本处理
  const ext = base.split(".").pop().toLowerCase();
  return TEXT_EXT.has(ext);
}

export function mimeOf(path) {
  const n = String(path || "").toLowerCase();
  if (n.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (n.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (n.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (n.endsWith(".pdf")) return "application/pdf";
  if (n.endsWith(".md")) return "text/markdown";
  if (n.endsWith(".csv")) return "text/csv";
  if (n.endsWith(".json")) return "application/json";
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".gif")) return "image/gif";
  if (n.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

/* ---------------- 对外 API ---------------- */

export async function initFs() {
  if (nativeFsAvailable()) {
    try {
      const root = bridge().rootPath ? String(bridge().rootPath() || "") : "";
      return { backend: "native", root };
    } catch {
      /* 落到 IDB */
    }
  }
  await openDb();
  return { backend: "idb", root: "" };
}

/** 列出某区域的文件元数据（不含内容）。 */
export async function listDocs(area, prefix = "") {
  if (nativeFsAvailable()) {
    const res = await nativeCall("list", [area, prefix]);
    return (res.files || []).map((f) => ({
      path: f.path,
      size: Number(f.size) || 0,
      updatedAt: Number(f.mtime) || Date.now(),
    }));
  }
  const rows = await idbTx("readonly", (store) => idbReq(store.index("area").getAll(area)));
  return (rows || [])
    .map((r) => ({ path: r.path, size: r.size || 0, updatedAt: r.mtime || 0 }))
    .filter((r) => r.path.startsWith(prefix))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** 读取完整内容：文本返回 content，二进制返回 base64。 */
export async function readDoc(area, path) {
  const binary = !isTextPath(path);
  if (nativeFsAvailable()) {
    const res = await nativeCall("read", [area, path, binary]);
    return {
      path,
      encoding: binary ? "base64" : "text",
      content: binary ? res.base64 || "" : res.content || "",
      size: Number(res.size) || 0,
      mime: binary ? mimeOf(path) : undefined,
    };
  }
  const row = await idbTx("readonly", (store) => idbReq(store.get(keyOf(area, path))));
  if (!row) throw new Error(`文件不存在：${path}`);
  return {
    path: row.path,
    encoding: row.encoding || "text",
    content: row.content || "",
    size: row.size || 0,
    mime: row.mime,
  };
}

export async function writeDoc(area, path, content) {
  const text = String(content ?? "");
  const size = new Blob([text]).size;
  if (nativeFsAvailable()) {
    const res = await nativeCall("write", [area, path, text]);
    return { path, size: Number(res.size) || size, updatedAt: Number(res.mtime) || Date.now() };
  }
  const mtime = Date.now();
  await idbTx("readwrite", (store) =>
    idbReq(store.put({ key: keyOf(area, path), area, path, content: text, encoding: "text", size, mtime }))
  );
  return { path, size, updatedAt: mtime };
}

export async function writeBinaryDoc(area, path, base64, mime) {
  const size = Math.round(String(base64 || "").length * 0.75);
  if (nativeFsAvailable()) {
    const res = await nativeCall("writeBinary", [area, path, base64 || "", mime || mimeOf(path)], 120000);
    return { path, size: Number(res.size) || size, updatedAt: Number(res.mtime) || Date.now(), mime };
  }
  const mtime = Date.now();
  await idbTx("readwrite", (store) =>
    idbReq(store.put({
      key: keyOf(area, path), area, path, content: String(base64 || ""), encoding: "base64",
      size, mtime, mime: mime || mimeOf(path),
    }))
  );
  return { path, size, updatedAt: mtime, mime };
}

export async function deleteDoc(area, path) {
  if (nativeFsAvailable()) {
    await nativeCall("delete", [area, path]);
    return;
  }
  await idbTx("readwrite", (store) => idbReq(store.delete(keyOf(area, path))));
}

export async function moveDoc(fromArea, fromPath, toArea, toPath) {
  if (nativeFsAvailable()) {
    const res = await nativeCall("move", [fromArea, fromPath, toArea, toPath]);
    return { path: toPath, size: Number(res.size) || 0, updatedAt: Number(res.mtime) || Date.now() };
  }
  const row = await idbTx("readonly", (store) => idbReq(store.get(keyOf(fromArea, fromPath))));
  if (!row) throw new Error(`文件不存在：${fromPath}`);
  const mtime = Date.now();
  await idbTx("readwrite", (store) => {
    store.put({ ...row, key: keyOf(toArea, toPath), area: toArea, path: toPath, mtime });
    store.delete(keyOf(fromArea, fromPath));
  });
  return { path: toPath, size: row.size || 0, updatedAt: mtime };
}

export async function clearArea(area) {
  if (nativeFsAvailable()) {
    await nativeCall("clear", [area]);
    return;
  }
  await idbTx("readwrite", (store) => {
    const idx = store.index("area");
    const req = idx.openCursor(area);
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        store.delete(cur.primaryKey);
        cur.continue();
      }
    };
  });
}

/** 从手机 / 本地选择文件导入到某区域，返回新增条目。 */
export async function importFromPhone(area, subdir = "") {
  if (nativeFsAvailable()) {
    // 新桥支持落到子目录（附件走 uploads/）；旧桥退回归根目录
    const canSub = typeof bridge()?.importFilesTo === "function";
    const res = await nativeCall(
      canSub ? "importFilesTo" : "importFiles",
      canSub ? [area, subdir] : [area],
      10 * 60 * 1000
    );
    return (res.files || []).map((f) => ({
      path: f.path,
      size: Number(f.size) || 0,
      updatedAt: Number(f.mtime) || Date.now(),
    }));
  }
  // 浏览器：隐藏 input[type=file] 多选
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", async () => {
      try {
        const files = [...(input.files || [])];
        const out = [];
        // 同名不覆盖：原生端会自己改名，浏览器端这里补上同样的行为，
        // 否则第二次导入同名文件会把第一次的悄悄顶掉，用户以为"文件没加上"。
        const taken = new Set((await listDocs(area)).map((d) => d.path));
        const uniquePath = (name) => {
          const path0 = subdir ? `${subdir}/${name}` : name;
          if (!taken.has(path0)) return path0;
          const dot = name.lastIndexOf(".");
          const stem = dot > 0 ? name.slice(0, dot) : name;
          const ext = dot > 0 ? name.slice(dot) : "";
          for (let i = 1; i < 1000; i += 1) {
            const cand = subdir ? `${subdir}/${stem}-${i}${ext}` : `${stem}-${i}${ext}`;
            if (!taken.has(cand)) return cand;
          }
          return path0;
        };
        for (const file of files) {
          const path = uniquePath(file.name);
          taken.add(path);
          // 文本类按文本落盘：模型侧才能直接读到正文，而不是一坨 base64
          const meta = isTextPath(file.name)
            ? await writeDoc(area, path, await file.text())
            : await writeBinaryDoc(
                area,
                path,
                bytesToBase64(new Uint8Array(await file.arrayBuffer())),
                file.type || mimeOf(file.name)
              );
          out.push({ path: meta.path, size: meta.size, updatedAt: meta.updatedAt });
        }
        resolve(out);
      } catch (err) {
        reject(err);
      } finally {
        input.remove();
      }
    });
    input.addEventListener("cancel", () => {
      input.remove();
      resolve([]);
    });
    input.click();
  });
}

/** 把文件另存到用户选择的位置（APK 走 SAF，浏览器走下载）。 */
export async function exportToPhone(area, path) {
  if (nativeFsAvailable()) {
    await nativeCall("exportFile", [area, path], 10 * 60 * 1000);
    return true;
  }
  const doc = await readDoc(area, path);
  const name = path.split("/").pop() || "file";
  if (doc.encoding === "base64") {
    downloadBlob(new Blob([base64ToBytes(doc.content)], { type: doc.mime || mimeOf(path) }), name);
  } else {
    downloadBlob(new Blob([doc.content], { type: "text/plain;charset=utf-8" }), name);
  }
  return true;
}

export async function fsRootPath() {
  if (!nativeFsAvailable()) return "";
  try {
    return String(bridge().rootPath?.() || "");
  } catch {
    return "";
  }
}

/* ---------------- 小工具 ---------------- */

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const bin = atob(String(base64 || ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
