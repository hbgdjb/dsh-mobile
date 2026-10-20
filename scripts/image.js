/* ============================================================
   Image — 图片附件的解码、缩放与 data URL 生成
   模型接口按 OpenAI 多模态格式接收图片：content 数组里的 image_url。
   手机截图动辄 2–4 MB，直接 base64 会拖垮请求，这里统一压到长边 1568px。
   ============================================================ */

export const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;

const MAX_EDGE = 1568; // 主流视觉模型的最佳输入长边
const MAX_BYTES = 1_200_000; // 单张压缩后目标体积

export const isImagePath = (path) => IMAGE_RE.test(String(path || ""));

export function imageMime(path) {
  const n = String(path || "").toLowerCase();
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".gif")) return "image/gif";
  if (n.endsWith(".bmp")) return "image/bmp";
  return "image/jpeg";
}

function base64ToBytes(b64) {
  const raw = atob(String(b64 || ""));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i) & 0xff;
  return out;
}

async function decode(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* 回退到 <img> */
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("这张图片无法解码（可能是 HEIC 等 WebView 不支持的格式）"));
    };
    img.src = url;
  });
}

/**
 * 把工作区里的图片整理成可直接放进请求的 data URL。
 * 长边超过 1568px 的按比例缩小，并转 JPEG（透明区域铺白底）。
 * @returns {Promise<{dataUrl:string,bytes:number,width:number,height:number,resized:boolean}>}
 */
export async function prepareImage(base64, mime = "image/jpeg") {
  const bytes = base64ToBytes(base64);
  if (!bytes.length) throw new Error("图片内容为空");
  const bitmap = await decode(new Blob([bytes], { type: mime }));
  const sw = bitmap.width || bitmap.naturalWidth || 0;
  const sh = bitmap.height || bitmap.naturalHeight || 0;
  if (!sw || !sh) throw new Error("无法读取图片尺寸");

  const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
  const small = scale === 1 && bytes.length <= MAX_BYTES && !/png|bmp/i.test(mime);
  if (small) {
    return {
      dataUrl: `data:${mime};base64,${String(base64)}`,
      bytes: bytes.length,
      width: sw,
      height: sh,
      resized: false,
    };
  }

  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  // 统一白底：JPEG 没有 alpha，透明 PNG 直接压会变黑
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  let quality = 0.86;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  // toDataURL 的 base64 长度约等于字节数的 1.37 倍
  while (dataUrl.length * 0.73 > MAX_BYTES && quality > 0.5) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  return {
    dataUrl,
    bytes: Math.round(dataUrl.length * 0.73),
    width: w,
    height: h,
    resized: scale < 1 || !/jpe?g/i.test(mime),
  };
}
