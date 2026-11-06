/* ============================================================
   ZIP 解包原语 — tools.js 与插件安装器共用

   ============ 为什么要单独一个文件 ============
   插件安装（plugin-install-node.js）早就会解 zip；沙箱终端里的
   `unzip` 却只实现了 `-l` 列表。模型收到「上传了一个 zip，帮我装」
   时会自然地写 `unzip x.zip`，拿到的是条目列表、退出码还是成功，
   它以为解压完了，接着 ls 一个空目录 —— 然后开始瞎猜路径。

   把解包挪到这里之后，两边共用同一份实现，不会再出现
   「安装器能解、shell 不能解」这种自相矛盾。

   ============ 边界 ============
   · 不支持 ZIP64（插件包/资料包不会超过 4 GB）
   · 不校验 CRC —— 解出来的字节由 DecompressionStream 保证完整性，
     校验和只影响「静默损坏」的极端情况，不值得为此多读一遍
   ============================================================ */

function needDecompression() {
  if (typeof DecompressionStream !== "function") {
    throw new Error(
      "这台设备的系统 WebView 太旧，不支持解压（缺少 DecompressionStream）。" +
        "到应用商店更新「Android System WebView」后再试，或改用单文件 .js 插件。"
    );
  }
}

/** deflate 原始流（zip method 8 用的就是它，没有 zlib 头）。 */
export async function inflateRaw(bytes) {
  needDecompression();
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(bytes) {
  needDecompression();
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decodeName(bytes) {
  // zip 里的名字通常是 UTF-8（带 EFS 标志时）。非 UTF-8 会解成替换字符，
  // 对插件而言不影响加载（文件名只是路径）。
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * 解 zip，返回 [{ path, bytes }]（不含目录条目）。
 *
 * 走中央目录而不是顺序扫本地头：本地头里的 size 字段在「流式写入」的
 * zip 里可能是 0（真正的长度在数据描述符里），中央目录才是权威。
 */
export async function unpackZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minEocd = 22;
  if (bytes.length < minEocd) throw new Error("不是有效的 zip 文件");

  let eocd = -1;
  const floor = Math.max(0, bytes.length - minEocd - 65535);
  for (let i = bytes.length - minEocd; i >= floor; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 zip 文件（找不到目录结尾）");

  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  const out = [];

  for (let i = 0; i < count; i += 1) {
    if (off + 46 > bytes.length) break;
    if (view.getUint32(off, true) !== 0x02014b50) break;
    const method = view.getUint16(off + 10, true);
    const compSize = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localOff = view.getUint32(off + 42, true);
    const name = decodeName(bytes.subarray(off + 46, off + 46 + nameLen)).replace(/\\/g, "/");
    off += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;
    if (localOff + 30 > bytes.length) continue;

    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + compSize);

    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error(`不支持的压缩方式（method=${method}）：${name}`);

    out.push({ path: name, bytes: data });
  }

  if (!out.length) throw new Error("这个 zip 里没有文件");
  return out;
}

/** 路径里是否带 `..` 或绝对路径（zip slip）。 */
export function unsafeEntry(name) {
  const p = String(name || "").replace(/\\/g, "/");
  if (!p) return true;
  if (p.startsWith("/")) return true;
  if (/^[A-Za-z]:/.test(p)) return true;
  return p.split("/").some((seg) => seg === "..");
}
