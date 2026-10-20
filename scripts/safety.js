/* ============================================================
   CC Safety Net — 执行前安全护栏
   规则是保守的：只拦明确的破坏性模式，不拦正常读写。
   ============================================================ */

const DANGEROUS = [
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|~|\*|\.\.)/i, label: "递归删除根目录 / 家目录 / 通配" },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/i, label: "格式化文件系统" },
  { re: /\bdd\s+[^\n]*of=\/dev\//i, label: "直接写入块设备" },
  { re: /\b(shutdown|reboot|poweroff|halt)\b/i, label: "关机或重启" },
  { re: /:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/, label: "fork 炸弹" },
  { re: /\bcurl\b[^\n|]*\|\s*(sh|bash|zsh)\b/i, label: "远程脚本直接交给 shell" },
  { re: /\bchmod\s+(-R\s+)?777\s+\//i, label: "把根目录权限放开" },
  { re: /\b(localStorage|sessionStorage)\.clear\s*\(/i, label: "清空应用本地数据" },
  { re: /\bdocument\.cookie\b|\bprocess\.env\b/i, label: "读取环境变量或 Cookie" },
  { re: /\bwindow\.location\s*=\s*['"]https?:/i, label: "脚本内跳转到外部地址" },
];

const SECRETS = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/, label: "API Key（sk-…）" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS Access Key" },
  { re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, label: "私钥" },
  { re: /\b(password|passwd|secret|token)\s*[:=]\s*["']?[^\s"']{6,}/i, label: "明文口令 / Token" },
];

/** run_code 专扫：脚本逃逸出编排沙箱、触及存储/网络/DOM 的行为。
    这类脚本可能读到明文 Key 并外发，命中即拦截。 */
const SCRIPT_RISKS = [
  { re: /\b(localStorage|sessionStorage|indexedDB|caches)\b/, label: "访问应用本地存储（可能读到明文 Key）" },
  { re: /\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/, label: "脚本内发起网络请求（可外发数据）" },
  { re: /\bimport\s*\(|\bimportScripts\s*\(/, label: "动态加载外部模块" },
  { re: /\beval\s*\(|\bnew\s+Function\b|[^.\w]Function\s*\(/, label: "动态构造并执行代码" },
  { re: /\b(document|window|globalThis|self|parent|top)\b/, label: "访问页面 DOM 与全局对象" },
  { re: /\bdocument\.cookie\b|\bnavigator\./, label: "读取 Cookie 或设备信息" },
];

export function scanScriptRisks(code) {
  const src = String(code || "");
  return SCRIPT_RISKS.filter((r) => r.re.test(src)).map((r) => r.label);
}

export function scanDangerous(text) {
  const src = String(text || "");
  return DANGEROUS.filter((r) => r.re.test(src)).map((r) => r.label);
}

export function scanSecrets(text) {
  const src = String(text || "");
  return SECRETS.filter((r) => r.re.test(src)).map((r) => r.label);
}

export const SAFETY_RULES = [
  "递归删除 / 格式化 / 裸设备写入",
  "关机、重启与 fork 炸弹",
  "远程脚本直通 shell",
  "读取环境变量与 Cookie",
  "清空应用本地数据",
  "写入疑似密钥或私钥",
  "脚本触碰存储 / 网络 / DOM（run_code 逃逸拦截）",
  "脚本内动态构造代码（eval / Function）",
];
