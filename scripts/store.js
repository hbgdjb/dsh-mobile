/* ============================================================
   Store — 单一状态源、持久化、种子数据
   所有界面只读 state，通过 actions 写入；写入后统一 emit。
   ============================================================ */

import * as FS from "./fs.js";
import { FORMAT_IDS, MODEL_ID_RE, normalizeFormat } from "./formats.js";
import { normalizeApiKey, keyShape } from "./apikeys.js";

const LS_KEY = "dsh.mobile.state.v1";
const DAY = 86400000;

export const uid = (prefix = "id") =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const now = () => Date.now();

/* ---------------- 默认值 ---------------- */

export const MODES = {
  standard: {
    id: "standard",
    name: "标准",
    short: "标准",
    desc: "文件、终端、检索、Skills、子 Agent、工作流",
    detail: "功能最完整的通用 Agent，适合绝大多数任务。",
    tools: ["fs", "shell", "search", "subagent", "schedule", "plugin"],
  },
  ptc: {
    id: "ptc",
    name: "PTC",
    short: "PTC",
    desc: "程序化工具调用，一次 run_code 编排多步",
    detail: "模型编写一段程序组合多次工具调用，减少往返、适合批量流水线。",
    tools: ["fs", "shell", "search", "subagent", "schedule", "plugin", "code"],
  },
  minimal: {
    id: "minimal",
    name: "极简",
    short: "极简",
    desc: "仅保留终端与文件编辑器两个工具",
    detail: "更少的工具选择，更低的上下文负担，适合目标明确的任务。",
    tools: ["fs", "shell"],
  },
  creator: {
    id: "creator",
    name: "创造",
    short: "创造",
    desc: "检查运行时，试验并创建自己的插件",
    detail: "在标准模式之上开放运行时检查与插件装配能力，面向高级用户。",
    tools: ["fs", "shell", "search", "subagent", "schedule", "plugin", "creator"],
  },
};

/**
 * 会话预设：决定「这一场要干什么活」，与 MODES 是两回事。
 *
 * MODES 管能力（装哪些工具），PRESETS 管做法（怎么交付）。
 * 分开的理由：用户可能想用极简模式跑设计任务，两者不该互相锁死。
 *
 * 每个 preset 只有一段 prompt，选中的会话才注入 —— 没选就完全不出现，
 * system prompt 的体积和以前一样。手机上上下文很贵，不能默认常驻四份契约。
 */
export const PRESETS = {
  design: {
    id: "design",
    name: "设计",
    brief: "网页 · 界面 · 图",
    intro: "产出看得见的东西",
    prompt: [
      "【工作模式：设计】做出来，不是描述出来。",
      "· 先定：给谁看、像什么、交付什么形态。缺信息一次问完。",
      "· 交付必须能直接打开：网页给单文件 HTML，图给图片文件。只有文字 = 没做完。",
      "· 做完自己看一眼：手机上会不会塌、字号够不够、对比够不够。",
      "· 别拿「简约大气」当方向，要说具体的参考或数字。",
    ].join("\n"),
  },
  code: {
    id: "code",
    name: "代码",
    brief: "改代码 · 修 bug",
    intro: "改动可验证，步子最小",
    prompt: [
      "【工作模式：代码】改动可验证，步子最小。",
      "· 先读再改，不要凭想象重写整个文件。",
      "· 只改必要的地方，不顺手重构、不换风格。",
      "· 改完必须真跑一次，把输出贴出来；没跑就说没跑。",
      "· 报错先定位，连试三次不成就停下说清楚卡在哪。",
    ].join("\n"),
  },
  office: {
    id: "office",
    name: "办公",
    brief: "文档 · 表格 · 汇报",
    intro: "交付文件，不是聊天记录",
    prompt: [
      "【工作模式：办公】交付文件，不是给一段聊天记录。",
      "· 先给结构，确认后再填内容；信息不够就问，别编。",
      "· 产物落到工作区文件：文档 .docx / .pdf，表格 .xlsx，汇报 .pptx；源稿留 .md 方便再改。",
      "· 每个数字标来源；估算要写明是估算。",
      "· 结论在前，论据在后。",
    ].join("\n"),
  },
  learn: {
    id: "learn",
    name: "学习",
    brief: "问问题 · 留档",
    intro: "正常回答，答完留档",
    prompt: [
      "【工作模式：学习】正常回答，答完留档。不改讲法、不加测验。",
      "· 答完调用 learn_add：一句话结论 + 2–4 条要点 + 1–3 个标签。",
      "· 只记结论和要点，不要存整段原文。",
      "· 寒暄、纯时效查询、无结论的闲聊不记；用户说别记就不记。",
      "· 记完回一行「已记入学习库：标题」。",
    ].join("\n"),
  },
};

export const PRESET_LIST = Object.values(PRESETS);

export const PERMISSIONS = {
  readonly: { id: "readonly", name: "只读", desc: "只能读取工作区，任何写入都会被拒绝", write: false },
  workspace: { id: "workspace", name: "工作区写入", desc: "可修改工作区文件，越界操作需要批准", write: true },
  full: {
    id: "full",
    name: "完全访问",
    desc: "放宽护栏；当前版本所有路径仍映射在虚拟工作区内，真实设备目录需原生支持",
    write: true,
  },
};

/**
 * 应用版本号。
 *
 * 只用于**展示**（设置页、关于页）和 MCP clientInfo ——
 * 真正的版本判定看 APK 的 versionName / versionCode。
 *
 * 之前这里一直停在 0.16.1，而 APK 已经到了 0.36.0，
 * 导致设置页显示的版本是错的、MCP 握手报出去的也是旧版本。
 * 从 0.37.0 起与 APK 版本保持一致。
 */
export const APP_VERSION = "0.84.0";

/**
 * 不再预置任何模型：模型全部由用户在「模型管理」里自行添加。
 * 这里只保留 0.9 及以前内置目录的副本，用于把老用户已配置的模型无缝收编为自定义模型。
 */
const LEGACY_CATALOG = {
  "deepseek-chat": {
    label: "DeepSeek Chat",
    apiModel: "deepseek-chat",
    provider: "DeepSeek",
    providerKey: "deepseek",
    baseUrl: "https://api.deepseek.com",
    ctx: 128000,
  },
  "deepseek-reasoner": {
    label: "DeepSeek Reasoner",
    apiModel: "deepseek-reasoner",
    provider: "DeepSeek",
    providerKey: "deepseek",
    baseUrl: "https://api.deepseek.com",
    ctx: 128000,
  },
  "gpt-4.1": {
    label: "GPT-4.1",
    apiModel: "gpt-4.1",
    provider: "OpenAI",
    providerKey: "openai",
    baseUrl: "https://api.openai.com/v1",
    ctx: 1000000,
  },
  "moonshot-v1-128k": {
    label: "Moonshot v1 128K",
    apiModel: "moonshot-v1-128k",
    provider: "Moonshot",
    providerKey: "moonshot",
    baseUrl: "https://api.moonshot.cn/v1",
    ctx: 128000,
  },
};

/**
 * 模型供应方预设：不替用户选模型，但把「端点、常用模型 ID、控制台入口」都备好，
 * 添加模型时选择供应方即可一键预填。
 */
export const PROVIDERS = {
  deepseek: {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    endpoints: [
      { label: "标准", baseUrl: "https://api.deepseek.com" },
      { label: "带 /v1", baseUrl: "https://api.deepseek.com/v1" },
    ],
    defaultCtx: 1048576,
    suggest: [
      { id: "deepseek-flash", ctx: 1048576 },
      { id: "deepseek-v4-pro", ctx: 1048576 },
    ],
    hint: "DeepSeek 开放平台，OpenAI 兼容协议。",
    console: "https://platform.deepseek.com/api_keys",
  },
  glm: {
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    endpoints: [
      { label: "通用按量", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
      { label: "Coding · Chat", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" },
      { label: "Coding · Response", baseUrl: "https://open.bigmodel.cn/api/v1" },
    ],
    defaultCtx: 1048576,
    suggest: [
      // 智谱官方要求 Model Code 全部小写
      { id: "glm-5.3", ctx: 1048576 },
      { id: "glm-5.3-flash", ctx: 1048576 },
      { id: "glm-5.3-flashx", ctx: 1048576 },
      { id: "glm-5.2", ctx: 1048576 },
      { id: "glm-5-turbo", ctx: 204800 },
    ],
    hint: "智谱开放平台 bigmodel.cn；Coding 套餐请选对应端点。",
    console: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  qwen: {
    name: "通义千问 · 阿里云百炼",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    endpoints: [
      { label: "通用端点", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
      { label: "百炼专属（需改空间 ID）", baseUrl: "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" },
    ],
    defaultCtx: 128000,
    suggest: [
      { id: "qwen3.8-max", ctx: 1048576 },
      { id: "qwen3.8-flash", ctx: 1048576 },
      { id: "qwen3.8-omni-flash", ctx: 1048576 },
      { id: "qwen3.7-plus", ctx: 1048576 },
      { id: "qwen3.7-max", ctx: 262144 },
      { id: "qwen3-coder-next", ctx: 262144 },
      { id: "qwen-long", note: "千万级超长上下文" },
    ],
    hint: "通用端点直接可用；百炼专属端点把 {WorkspaceId} 替换成业务空间 ID。",
    console: "https://bailian.console.aliyun.com/",
  },
  doubao: {
    name: "豆包 · 火山方舟",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    endpoints: [
      { label: "标准", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
      { label: "Coding Plan", baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3" },
    ],
    defaultCtx: 128000,
    suggest: [
      // 方舟严格有效的 Model ID 通常带日期后缀
      { id: "doubao-seed-2-1-pro-260915", ctx: 1048576 },
      { id: "doubao-seed-2-1-pro-260628", ctx: 1048576 },
      { id: "doubao-pro-32k", ctx: 32768 },
      { id: "doubao-lite-32k", ctx: 32768 },
    ],
    hint: "火山方舟 Ark；严格有效的模型 ID 带日期后缀（如 doubao-seed-2-1-pro-260915），也可用控制台的推理接入点；建议以「获取模型列表」结果为准。",
    console: "https://console.volcengine.com/ark",
  },
  moonshot: {
    name: "Moonshot · Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultCtx: 128000,
    suggest: [
      { id: "kimi-k3", ctx: 1048576 },
      { id: "kimi-k2.7-code", ctx: 262144 },
      { id: "kimi-k2.7-code-highspeed", ctx: 262144 },
      { id: "kimi-k2.6", ctx: 262144 },
    ],
    hint: "月之暗面 Kimi 开放平台，OpenAI 兼容协议。",
    console: "https://platform.moonshot.cn/console/api-keys",
  },
  minimax: {
    name: "MiniMax",
    baseUrl: "https://api.minimax.cn/v1",
    endpoints: [
      { label: "主端点", baseUrl: "https://api.minimax.cn/v1" },
      { label: "备选", baseUrl: "https://api.minimaxi.com/v1" },
    ],
    defaultCtx: 1048576,
    suggest: [
      // 2026-10-19 发布：Space Bunny 的正式版，替换掉 Preview
      { id: "MiniMax-M3.1-Flash", ctx: 1000000 },
      { id: "MiniMax-M3.1-Flash-Preview", ctx: 1000000 },
      { id: "MiniMax-M3", ctx: 1000000 },
      { id: "MiniMax-M2.7-highspeed", ctx: 204800 },
      { id: "MiniMax-M2.5", ctx: 204800 },
    ],
    hint: "MiniMax 开放平台，OpenAI 兼容接口；M3.1 Flash（2026-10-19 发布，1M 上下文）已加入常用模型。",
    console: "https://platform.minimaxi.com/",
  },
  xiaomi: {
    name: "小米 MiMo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    defaultCtx: 1000000,
    suggest: [
      { id: "mimo-v2.6-pro", ctx: 1000000 },
      { id: "mimo-v2.6-flash", ctx: 1000000 },
      { id: "mimo-v2.6-pro-ultraspeed", ctx: 1000000 },
    ],
    hint: "小米 MiMo 开放平台（OpenAI / Anthropic 双协议）：V2.6 三款均为 1M 上下文、128K 最大输出；v2.5 系将于 2026-10-21 下线。",
    console: "https://platform.xiaomimimo.com/",
  },
  spark: {
    name: "讯飞星火",
    baseUrl: "https://spark-api-open.xf-yun.com/v1",
    endpoints: [
      { label: "标准", baseUrl: "https://spark-api-open.xf-yun.com/v1" },
      { label: "X2 模型", baseUrl: "https://spark-api-open.xf-yun.com/x2" },
      { label: "Agent", baseUrl: "https://spark-api-open.xf-yun.com/agent/v1" },
    ],
    defaultCtx: 128000,
    suggest: [
      { id: "Spark-X2.5", ctx: 262144 },
      { id: "Spark-X2.5-4B", ctx: 1048576 },
      { id: "Spark-X2.5-1.7B", ctx: 1048576 },
    ],
    hint: "讯飞星火 OpenAI 兼容接口；Key 填「APIKey:APISecret」整串。",
    console: "https://console.xfyun.cn/services/cbm",
  },
  qianfan: {
    name: "百度千帆",
    baseUrl: "https://qianfan.baidubce.com/v2",
    endpoints: [
      { label: "通用", baseUrl: "https://qianfan.baidubce.com/v2" },
      { label: "Coding Plan", baseUrl: "https://qianfan.baidubce.com/v2/coding" },
    ],
    defaultCtx: 128000,
    suggest: [
      { id: "ERNIE-5.0", note: "旗舰，以千帆模型列表为准" },
      { id: "ERNIE-5.1", note: "旗舰，以千帆模型列表为准" },
      { id: "deepseek-v4-pro", ctx: 1048576 },
      { id: "ERNIE-4.5-Turbo-128K", ctx: 131072 },
      { id: "ERNIE-4.0-Turbo", ctx: 131072 },
    ],
    hint: "百度千帆 ModelBuilder v2 接口，OpenAI 兼容。",
    console: "https://console.bce.baidu.com/iam/#/iam/apikey/list",
  },
  hunyuan: {
    name: "腾讯混元",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    defaultCtx: 128000,
    suggest: [
      { id: "hy4-preview", note: "突破百万级" },
      { id: "Hy3", ctx: 262144 },
      { id: "hunyuan-turbos", ctx: 262144 },
      { id: "hunyuan-large", ctx: 262144 },
      { id: "hunyuan-standard", ctx: 262144 },
      { id: "hunyuan-lite", ctx: 4096 },
    ],
    hint: "腾讯混元 OpenAI 兼容接口。",
    console: "https://console.cloud.tencent.com/hunyuan/api-key",
  },
  siliconflow: {
    name: "硅基流动 SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    defaultCtx: 128000,
    suggest: [
      { id: "Kimi-K3", ctx: 1048576 },
      { id: "deepseek-ai/DeepSeek-V4-Flash", ctx: 1048576 },
      { id: "ByteDance-Seed/Seed-OSS-36B-Instruct", ctx: 262144 },
      { id: "LongCat-2.0", ctx: 131072 },
    ],
    hint: "聚合多家开源模型的国内推理平台，OpenAI 兼容。",
    console: "https://cloud.siliconflow.cn/account/ak",
  },
  agnes: {
    name: "Agnes AI",
    // 默认国内站：本应用的用户大多在国内，.cn 走境内节点，首字节快一个量级。
    // 国际站的 Key 也别担心 —— 连不上时会自动换到 .com 并记住结果。
    baseUrl: "https://apihub.agnes-ai.cn/v1",
    endpoints: [
      // 每个 chip 都必须带 format：只给 Anthropic 那个带的话，用户从
      // Anthropic 切回「标准」时，地址换了、格式还停在 anthropic，照样 404。
      { label: "国内站 · 境内节点", baseUrl: "https://apihub.agnes-ai.cn/v1", format: "openai" },
      { label: "国际站 · 新加坡", baseUrl: "https://apihub.agnes-ai.com/v1", format: "openai" },
      { label: "Anthropic 兼容（实验）", baseUrl: "https://apihub.agnes-ai.cn/v1", format: "anthropic" },
    ],
    defaultCtx: 524288,
    suggest: [
      { id: "agnes-3.0-flash", ctx: 524288, note: "agnes-3.0-flash · 512K 上下文" },
      { id: "agnes-2.5-flash", ctx: 262144, note: "agnes-2.5-flash · 快速档" },
      { id: "agnes-2.5-pro-alpha", ctx: 262144, note: "agnes-2.5-pro-alpha · 预览版" },
    ],
    // 文档只承诺 model / messages / temperature / top_p / max_tokens / stream /
    // tools / tool_choice / chat_template_kwargs。不要照搬 OpenAI 的
    // stream_options 与 reasoning_effort，Agnes 没列这两个字段。
    hint: "Agnes AI，OpenAI 兼容；思考模式用 chat_template_kwargs.enable_thinking 开启，本应用会自动换算。国内站与国际站的 Key 不通用：国内站（platform.agnes-ai.cn）的 Key 配 https://apihub.agnes-ai.cn/v1，国际站的配 https://apihub.agnes-ai.com/v1，配错会一律回 401。本版在遇到 401 时会自动试另一个站，成功后写回配置。建议用「标准 · OpenAI 兼容」；Anthropic 兼容档走 /v1/messages，鉴权与参数不同。",
    console: "https://platform.agnes-ai.cn/",
  },
  openai: {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultCtx: 128000,
    suggest: [
      { id: "gpt-4.1", ctx: 1048576 },
      { id: "gpt-4.1-mini", ctx: 1048576 },
      { id: "o4-mini", ctx: 204800 },
    ],
    hint: "OpenAI 官方 API。",
    console: "https://platform.openai.com/api-keys",
  },
  /* Claude 官方 API 不是 OpenAI 协议：请求走 /v1/messages，鉴权用
     x-api-key + anthropic-version，流是命名事件。接它必须经过
     formats.js 的 anthropic 适配器，不能靠「兼容网关」碰运气。 */
  anthropic: {
    name: "Anthropic · Claude 官方",
    baseUrl: "https://api.anthropic.com",
    format: "anthropic",
    defaultCtx: 200000,
    suggest: [
      { id: "claude-sonnet-4-5", ctx: 200000 },
      { id: "claude-opus-4-1", ctx: 200000 },
      { id: "claude-haiku-4-5", ctx: 200000 },
    ],
    hint: "Claude 官方 API，Anthropic Messages 协议；填到域名即可，应用自动补 /v1/messages。",
    console: "https://console.anthropic.com/settings/keys",
  },
  google: {
    name: "Google · Gemini 官方",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    format: "gemini",
    defaultCtx: 1048576,
    suggest: [
      { id: "gemini-2.5-pro", ctx: 1048576 },
      { id: "gemini-2.5-flash", ctx: 1048576 },
    ],
    hint: "Google AI Studio 的 Gemini 接口；Key 走 x-goog-api-key 头，不会出现在 URL 里。",
    console: "https://aistudio.google.com/apikey",
  },
  groq: {
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultCtx: 128000,
    suggest: ["llama-3.3-70b-versatile", "mixtral-8x7b-32768"],
    hint: "Groq 超低延迟推理，OpenAI 兼容。",
    console: "https://console.groq.com/keys",
  },
  openrouter: {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultCtx: 128000,
    suggest: ["openai/gpt-4.1-mini", "anthropic/claude-sonnet-4", "google/gemini-2.0-flash-001"],
    hint: "一个 Key 调用数百家模型；模型 ID 用「厂商/模型名」格式。",
    console: "https://openrouter.ai/keys",
  },
  ollama: {
    name: "Ollama · 本机/局域网",
    baseUrl: "http://localhost:11434/v1",
    defaultCtx: 128000,
    suggest: ["qwen2.5:7b", "llama3.1:8b"],
    hint: "本机或局域网 Ollama；APK 内已走原生请求，填局域网 IP 即可（如 http://192.168.1.10:11434/v1）。",
    console: "https://ollama.com",
  },
  /* 原生 Ollama：/api/chat + NDJSON 流，不校验 Key。
     上面那个 ollama 预设走的是 OpenAI 兼容的 /v1，两条路别混：
     老用户填的是 /v1，改成新协议会直接把他打挂。 */
  ollamaNative: {
    name: "Ollama · 原生协议",
    baseUrl: "http://localhost:11434",
    format: "ollama",
    defaultCtx: 128000,
    suggest: [],
    hint: "Ollama 自己的 /api/chat（NDJSON 流），不用 Key；局域网填电脑 IP。",
    console: "https://ollama.com",
    local: true,
    placeholderKey: "ollama-local",
  },
  lmstudio: {
    name: "LM Studio · 本机",
    baseUrl: "http://localhost:1234/v1",
    defaultCtx: 128000,
    suggest: ["local-model"],
    hint: "LM Studio 本地服务；同一路由下用局域网 IP 访问手机外的电脑。",
    console: "https://lmstudio.ai",
  },
  /* OpenDesign Cloud（open-design.ai）：订阅制模型网关，**不是本机服务**。
     两个平面别混：
       amr-link.open-design.ai/v1  推理：/models、/chat/completions、/responses  → runtimeKey `sk-amr-…`
       amr-api.open-design.ai      账户：钱包、套餐、5h/7d 额度窗口          → controlKey `vela_ctrl_…`
     这里只接推理平面。凭据是网页「API 密钥」页签发的真 Key，Go/Plus/Pro/Max
     套餐才可用，Free 不支持；所以绝不能标 local 或塞占位符 —— 那会让界面
     显示「无需 Key」，用户拿着一把假 Key 去请求，只会得到 401。
     模型不写死：套餐不同可用模型不同，一律由 GET /v1/models 实时探测。 */
  opendesign: {
    name: "OpenDesign · Cloud API",
    baseUrl: "https://amr-link.open-design.ai/v1",
    format: "openai",
    endpoints: [
      { label: "Chat Completions", baseUrl: "https://amr-link.open-design.ai/v1", format: "openai" },
      { label: "Messages", baseUrl: "https://amr-link.open-design.ai", format: "anthropic" },
    ],
    defaultCtx: 200000,
    suggest: [],
    hint: "订阅制模型网关（Go / Plus / Pro / Max 套餐，Free 不可用）。在网页「API 密钥」页创建 sk-amr- 开头的 Key，填入后自动探测套餐可用模型。默认走 Chat Completions；单次请求体上限 50 MiB。网关多为 1M 上下文且输入输出共用预算，这里默认按 200K 保守裁剪，可在模型参数里调大。",
    console: "https://open-design.ai/cloud/dashboard",
  },
  custom: {
    name: "自定义 / 兼容网关",
    baseUrl: "",
    defaultCtx: 128000,
    suggest: [],
    hint: "任何 OpenAI 兼容网关（One-API、New-API、Nginx 反代等），端点自填。",
    console: "",
  },
};

/**
 * OpenDesign Cloud 的 Design Plan 模型目录（Go 套餐 12 个）。
 * 一手来源：dsh-opendesign-go 的 src/catalog.ts（GO_DESIGN_PLAN_MODELS）。
 * 用途只有两个：把 /v1/models 返回的显示名反查成真实 ID；探测结果不全时
 * 在「常用模型」里给出可直接点的参考 ID。
 * 不冒充实时列表 —— 可用模型仍以账户 GET /v1/models 为准。
 */
export const OPEN_DESIGN_MODELS = [
  { id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", ctx: 1000000 },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", ctx: 1000000 },
  { id: "deepseek-v4-flash-vision-exp", label: "DeepSeek V4 Flash Vision Exp", ctx: 1000000 },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", ctx: 1000000 },
  { id: "claude-haiku-5.5", label: "Claude Haiku 5.5", ctx: 1000000 },
  { id: "gpt-6-luna", label: "GPT-6 Luna", ctx: 1050000 },
  { id: "glm-5.3-flash", label: "GLM-5.3 Flash", ctx: 1000000 },
  { id: "glm-5.3-flashx", label: "GLM-5.3 Flash-X", ctx: 1000000 },
  { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", ctx: 262144 },
  { id: "mimo-v2.6-flash", label: "MiMo V2.6 Flash", ctx: 1000000 },
  { id: "mimo-v2.6-pro", label: "MiMo V2.6 Pro", ctx: 1000000 },
  { id: "hy4-preview", label: "Hunyuan H4 Preview", ctx: 1000000 },
];

const foldModelName = (v) => String(v || "").toLowerCase().replace(/[\s_.\-]+/g, "");
const OPEN_DESIGN_FOLD = new Map(
  OPEN_DESIGN_MODELS.flatMap((m) => [
    [foldModelName(m.id), m.id],
    [foldModelName(m.label), m.id],
  ])
);

/** 把「deepSeek V4.1 Flash」这类显示名纠正回可发送的 ID；已是 ID 则原样返回。 */
export function normalizeOpendesignModelId(raw) {
  const v = String(raw || "").trim();
  return v ? OPEN_DESIGN_FOLD.get(foldModelName(v)) || v : "";
}

/**
 * 探测结果收口：OpenDesign 做显示名反查并丢掉仍不像 ID 的条目，
 * 其它供应商只做有效性过滤。放在 fetchModelList 里统一调用，
 * UI 拿到的就一定可以直接写进请求体。
 */
export function resolveDiscoveredModels(providerKey, items) {
  const list = Array.isArray(items) ? items : [];
  const isOpenDesign = String(providerKey || "") === "opendesign";
  // Agnes 的 /v1/models 会把视频、图像模型一起列出来。它们同样挂在
  // /v1/chat/completions 下，但用途完全不同 —— 加进聊天模型列表后
  // 用户一点就报 400/404，还以为 Key 有问题。
  const isAgnes = String(providerKey || "") === "agnes";
  const out = [];
  const seen = new Set();
  for (const it of list) {
    if (!it) continue;
    let id = String(it.id || "").trim();
    const label = String(it.label || "").trim();
    if (isOpenDesign && !id && label) id = normalizeOpendesignModelId(label);
    if (isOpenDesign && id) id = normalizeOpendesignModelId(id);
    if (isAgnes && /-(?:video|image)(?:-|$)/i.test(id)) continue;
    if (!id || !MODEL_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: label && label !== id ? label : "",
      ctx: Number(it.ctx) || 0,
    });
  }
  // 这里不再二次排序：上游（或解析层）给的顺序就照原样交给 UI，
  // 有些网关按推荐度排好了，再排一次反而把常用的挤到后面。
  return out;
}

// 「常用模型」给 OpenDesign 一份核实过的参考 ID：/v1/models 探测失败或只返回
// 部分模型时，用户仍可直接点一个正确 ID，不用照着显示名手抄。
// 这里不冒充实时列表，实际可用模型仍以账户 /v1/models 为准。
PROVIDERS.opendesign.suggest = OPEN_DESIGN_MODELS.map((m) => ({ id: m.id, ctx: m.ctx }));

export const PROVIDER_COUNT = Object.keys(PROVIDERS).length;

/**
 * 已知模型的真实上下文窗口：探测列表 / 手填模型 ID 时自动带出，
 * 避免落在 128K 默认值上（DeepSeek V4 系与 GLM-5 系实际都是 1M 窗口）。
 * 由各供应方的 suggest 表自动汇总，另补常见别名。
 */
const KNOWN_MODEL_CTX = (() => {
  const map = {};
  for (const p of Object.values(PROVIDERS)) {
    for (const s of p.suggest || []) {
      if (typeof s === "object" && s.id && s.ctx) map[String(s.id).toLowerCase()] = s.ctx;
    }
  }
  // 常见别名：旧目录里这些 ID 只记了 128K，实际早已是 1M 窗口
  Object.assign(map, {
    "deepseek-chat": 1048576,
    "deepseek-reasoner": 1048576,
    "deepseek-flash": 1048576,
    "deepseek-v4-pro": 1048576,
  });
  return map;
})();

/**
 * 已知支持图片输入的模型：命中即默认开启「图片输入」，
 * 用户在模型参数里手动关掉会写成显式 false，优先于这里的推断。
 */
const VISION_HINTS = [
  /glm-5\.3-flash/i,
  /glm-4(?:\.\d)?v/i,
  /glm-4v/i,
  /gpt-4o/i,
  /gpt-4\.1/i,
  /gpt-5/i,
  /claude-(?:3|4|sonnet|opus|haiku)/i,
  /gemini/i,
  /qwen[\w.-]*vl/i,
  /mimo-v2\.6/i,
  /minimax-m3/i,
  /doubao[\w.-]*vision/i,
  /step-1v/i,
  /yi-vision/i,
  /internvl/i,
  /kimi[\w.-]*vl/i,
  // Agnes 2.5 / 3.0 都接受 messages[].content 里的 image_url（公开可访问 URL）
  /agnes-(?:2\.5|3\.0)/i,
];

/** 该模型是否大概率支持图片输入（仅作默认值，用户可在模型参数里覆盖）。 */
export function knownModelVision(id) {
  const key = String(id || "").trim().toLowerCase();
  if (!key) return false;
  return VISION_HINTS.some((re) => re.test(key));
}

/** 查已知模型的上下文窗口；未知返回 0。兼容 OpenRouter 式「厂商/模型名」。 */
export function knownModelCtx(id) {
  const key = String(id || "").trim().toLowerCase();
  if (!key) return 0;
  if (KNOWN_MODEL_CTX[key]) return KNOWN_MODEL_CTX[key];
  const bare = key.includes("/") ? key.split("/").pop() : "";
  return bare ? KNOWN_MODEL_CTX[bare] || 0 : 0;
}

/* ---------------- 种子内容 ---------------- */

function seedFiles() {
  return {
    "README.md": {
      path: "README.md",
      content:
        "# 工作区\n\n这是 DSH Mobile 的虚拟工作区，目前是空的。\n\nAgent 的文件读写、命令产物与生成结果都会落在这里。你可以让 Agent 直接开始工作，产物会自动出现在「工作区」页。",
      updatedAt: now(),
    },
  };
}

function seedSessions() {
  return []; // 不再预置演示会话：没有连接模型时不应该出现看似真实的回答
}

function seedPlugins() {
  return [
    {
      id: "office",
      name: "DSH Office",
      desc: "把 Markdown 导出为 Word、PPT、PDF，把 CSV 导出为 Excel；也能读 PDF 正文。产物可直接用 WPS / Office 打开。",
      version: "2.0.0",
      author: "dsh",
      official: true,
      enabled: true,
      preinstalled: true,
      removable: false,
      tools: ["office_export", "pdf_create", "pdf_read"],
      scopes: ["workspace"],
    },
    {
      id: "safety",
      name: "CC Safety Net",
      desc: "执行前护栏：拦截递归删除、格式化、远程脚本直通 shell，以及密钥写入。",
      version: "1.4.2",
      author: "community",
      official: false,
      enabled: true,
      preinstalled: true,
      removable: false,
      tools: [],
      scopes: ["approval", "workspace"],
    },
    {
      id: "effort",
      name: "Codex Effort Slider",
      desc: "改造模型面板的推理等级行：连续拖动、一档一色、高档紫色星尘。",
      version: "1.1.2",
      author: "Microqian2th",
      official: false,
      enabled: true,
      preinstalled: true,
      removable: false,
      license: "MIT",
      source: "github.com/Microqian2th/dsh-codex-effort-slider",
      tools: [],
      scopes: ["ui.slot", "model"],
    },
    {
      id: "ops",
      name: "DSH Ops",
      desc: "运行时体检与清理：会话、文件占用、异常调用，一键清导出产物。",
      version: "1.2.0",
      author: "community",
      official: false,
      enabled: true,
      preinstalled: true,
      removable: false,
      tools: ["ops_status", "ops_cleanup"],
      scopes: ["runtime", "workspace"],
    },
    {
      id: "terminal",
      name: "终端",
      desc: "在工作区内执行沙箱命令，支持超时与输出上限。",
      version: "1.4.2",
      author: "dsh",
      official: true,
      preinstalled: true,
      removable: false,
      enabled: true,
      tools: ["shell"],
      scopes: ["workspace"],
    },
    {
      id: "websearch",
      name: "网页搜索",
      desc: "为 Agent 提供联网检索，返回可引用的来源列表。",
      version: "1.1.0",
      author: "dsh",
      official: true,
      preinstalled: true,
      removable: false,
      enabled: true,
      tools: ["web_search"],
      scopes: ["network"],
    },
    {
      id: "subagent",
      name: "子智能体",
      desc: "把任务委派给独立上下文的子 Agent，支持并行与层级限制。",
      version: "0.9.3",
      author: "dsh",
      official: true,
      experimental: true,
      preinstalled: true,
      removable: false,
      enabled: true,
      tools: ["spawn_subagent"],
      scopes: ["delegate"],
    },
    {
      id: "scheduler",
      name: "定时任务",
      desc: "按计划在后台运行 Agent，保留每次执行的完整轨迹。",
      version: "1.0.6",
      author: "dsh",
      official: true,
      preinstalled: true,
      removable: false,
      enabled: true,
      tools: ["task_schedule"],
      scopes: ["background"],
    },
    {
      id: "voice",
      name: "语音输入",
      desc: "本机转写，不上传音频；把语音直接写进输入框。",
      version: "0.6.1",
      author: "dsh",
      official: true,
      preinstalled: true,
      removable: false,
      experimental: true,
      enabled: true,
      tools: [],
      scopes: ["microphone"],
    },
    {
      id: "teams",
      name: "智能体团队",
      desc: "把一个目标拆成多条任务并行派出，结果汇在团队任务板。",
      version: "0.4.0",
      author: "dsh",
      official: true,
      experimental: true,
      preinstalled: true,
      removable: false,
      enabled: false,
      tools: ["agent_team"],
      scopes: ["delegate", "shared-state"],
    },
    {
      id: "review",
      name: "自动授权审查",
      desc: "执行前复核越界路径、整目录删除与远程脚本直通，命中即拦下。",
      version: "0.3.2",
      author: "dsh",
      official: true,
      experimental: true,
      preinstalled: true,
      removable: false,
      enabled: false,
      tools: [],
      scopes: ["approval"],
    },
  ];
}

function seedAutomations() {
  return []; // 不再预置演示计划
}

function seedRuns() {
  return []; // 不再预置演示任务
}

const DEFAULT_STATE = () => ({
  version: 1,
  createdAt: now(),
  settings: {
    provider: "deepseek",
    baseUrl: "",
    apiKey: "",
    model: null,
    customModelId: "",
    customModels: [],
    /** 逐模型覆盖：{ [modelId]: { ctx, baseUrl, apiModel, label, temperature, maxTokens, supportsEffort } } */
    modelOverrides: {},
    /** 最近一次连接结果：{ [modelId]: { ok, ms, at, status, error, model } } */
    modelStatus: {},
    /** 按服务商缓存的可用模型清单：{ [providerKey]: { ids, baseUrl, ts } } */
    modelCatalog: {},
    keys: Object.fromEntries(Object.keys(PROVIDERS).map((k) => [k, ""])),
    contextWindow: 128000,
    reasoning: "high",
    mode: "standard",
    permission: "workspace",
    approval: "ask",
    /**
     * 按会话隔离工作区：开启后每个会话的文件存在 sessions/<id>/ 下，
     * 别的会话看不见也覆盖不到。关掉则回到 0.71.0 及以前的全局共用。
     * 资料库不受这个开关影响，始终跨会话可用。
     */
    isolateWorkspace: true,
    theme: "dark",
    motion: true,
    searchEndpoint: "",
    showReasoning: true,
    fontSize: 14,
    fontScale: 1,
    density: "comfortable",
    notifyOnDone: true,
    /** 键盘截的图是否直接发出去（默认只加为附件） */
    imeAutoSend: false,
    haptics: true,
    requestTimeout: 60,
    hudEnabled: false,
    memoryEnabled: true,
    mcpServers: [],
    profileName: "本机用户",
    /**
     * Node 插件运行时开关。
     *
     * 默认开启：运行时**已下载**的情况下，应用启动会拉起它。
     * 没下载时不会自动下（88 MB 太大，不能替用户做主）——
     * 那件事要用户自己去设置页点。
     */
    nodeEnabled: true,
    /**
     * 插件目录自动重载。
     *
     * 默认关闭：它会常驻一个目录监听，而且"改一下文件插件就重启"
     * 不是所有人都想要的。写插件的人自己去设置里打开。
     */
    pluginWatch: false,
  },
  sessions: seedSessions(),
  activeSessionId: null,
  files: seedFiles(),
  library: {},
  fsBackend: "",
  fsRoot: "",
  plugins: seedPlugins(),
  /**
   * 已安装的技能包（SKILL.md 形态）。
   *
   * 只存元数据（id / name / description / 文件数），正文在工作区
   * skills/<id>/ 里 —— 一份 SKILL.md 动辄二十几 KB，塞进 localStorage
   * 会和插件代码抢那 5 MB 配额。
   */
  skills: [],
  /**
   * 智能体团队的最近几次任务板。
   *
   * 只留最近 5 次 —— 它是给人看的过程记录，不是账本。
   * 任务正文由子 Agent 产出，单条已截断到 600 字符，不会撑爆 localStorage。
   */
  team: { runs: [] },
  /**
   * 自动授权审查的计数：扫了多少次、拦下多少次。
   *
   * 只落两个整数。用户要的是「它到底有没有在工作」，
   * 不是把每次判断的理由都存一遍。
   */
  review: { scans: 0, blocked: 0 },
  /**
   * Node 插件清单（从 Node 运行时读来的）。
   *
   * 不落盘 —— 它是运行时的状态，Node 重启后自己会重新报上来。
   * 落盘反而会造成"界面上显示有插件，其实已经没了"的错觉。
   */
  nodePlugins: [],
  /**
   * Node 侧插件目录的诊断快照（见 android/node/plugin-host.js 的 diagnose）。
   *
   * 不落盘 —— 和 nodePlugins 一样是运行时状态。
   */
  nodePluginsDiag: null,
  /**
   * 插件目录监听的运行状态（见 android/node/watcher.js 的 status）。
   *
   * 不落盘 —— 它是运行时的瞬时状态，落盘只会让下次启动显示
   * 一个「正在监听」但其实没在监听的假象。
   */
  watchStatus: null,
  automations: seedAutomations(),
  runs: seedRuns(),
  stats: { runs: 0, tools: 0, tokens: 0 },
  safety: { scans: 0, blocked: 0 },
  diagnostics: { requests: [] },
});

/* ---------------- Store ---------------- */

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_STATE();
    const parsed = JSON.parse(raw);
    const base = DEFAULT_STATE();
    if (parsed.settings?.reasoning === "medium") parsed.settings.reasoning = "high";

    // 0.9.1 起不再有内置模型目录：老用户当前使用的模型收编为自定义模型
    if (parsed.settings) {
      if (!Array.isArray(parsed.settings.customModels)) parsed.settings.customModels = [];
      const legacyModel = String(parsed.settings.model || "").trim();
      const owned = parsed.settings.customModels.some((m) => m && m.id === legacyModel);
      if (legacyModel && !owned) {
        if (LEGACY_CATALOG[legacyModel]) {
          // 旧目录里的模型：原样收编，保留 id（连接状态与参数覆盖都挂在同一 id 上）
          parsed.settings.customModels.unshift({
            id: legacyModel,
            ...LEGACY_CATALOG[legacyModel],
            custom: true,
          });
        } else {
          // 内置「自定义模型」占位（custom）或任何未知 id：按手填配置收编
          const apiModel =
            legacyModel === "custom"
              ? String(parsed.settings.customModelId || "").trim()
              : legacyModel;
          const label =
            legacyModel === "custom"
              ? apiModel || "自定义模型"
              : legacyModel;
          parsed.settings.customModels.unshift({
            id: legacyModel,
            label,
            apiModel,
            provider: "自定义",
            providerKey: "custom",
            baseUrl: String(parsed.settings.baseUrl || "").trim(),
            ctx: Number(parsed.settings.contextWindow) || 128000,
            custom: true,
          });
        }
      }
      // ============ 给每个模型条目补 label ============
      //
      // 所有界面显示模型名都读 `label`（顶栏 chip、模型卡标题、抽屉底部）。
      // 而插件模型（source: "node-llm"）在 0.41.5 之前的同步里只写了 name，
      // 没有 label —— 一旦用户选中它，`model.label.replace(...)` 直接抛
      // TypeError，整页渲染中断，表现为「对话界面没了」。
      //
      // 补在加载时而不是只在写入时：这样**已经存在手机里的旧条目**
      // 也能被修好，不用等下一次同步。
      for (const m of parsed.settings.customModels) {
        if (!m || typeof m !== "object") continue;
        if (typeof m.label === "string" && m.label) continue;
        m.label = String(m.name || m.apiModel || m.id || "未命名模型");
      }

      // ============ 老条目补协议 ============
      //
      // 0.66 之前整站只认 OpenAI 一种协议，所有条目都没有 format。
      // 这里补成 "openai" 而不是留空：UI 判断、批量添加去重、缓存 key
      // 都直接读它，到处写 `|| "openai"` 迟早漏一个。
      // 插件模型（source: "node-llm"）不走 HTTP，协议对它没意义，跳过。
      for (const m of parsed.settings.customModels) {
        if (!m || typeof m !== "object") continue;
        if (m.source === "node-llm" || String(m.provider || "").startsWith("node__")) continue;
        if (FORMAT_IDS.indexOf(String(m.format || "")) < 0) m.format = "openai";
      }

      // ============ OpenDesign：显示名 → 真实 ID ============
      // 0.67.0 的探测把 /v1/models 里的 name 当成了 id（例如
      // 「deepSeek V4.1 Flash」），发出去网关找不到模型，直接 404。
      // 升级时按官方目录就地纠正，并把可读名挪去 label，用户不用手改。
      for (const m of parsed.settings.customModels) {
        if (!m || typeof m !== "object") continue;
        const isOd =
          m.providerKey === "opendesign" ||
          /amr-link\.open-design\.ai/i.test(String(m.baseUrl || ""));
        if (!isOd) continue;
        const fixed = normalizeOpendesignModelId(m.apiModel);
        if (fixed && fixed !== m.apiModel) {
          const row = OPEN_DESIGN_MODELS.find((x) => x.id === fixed);
          m.apiModel = fixed;
          if (row) m.label = row.label;
          // 旧的「连接失败 · HTTP 404」是坏 ID 造成的，别让它继续挂在模型上
          if (parsed.settings.modelStatus) delete parsed.settings.modelStatus[m.id];
        }
      }

      const picked =
        parsed.settings.customModels.find((m) => m && m.id === parsed.settings.model) || null;
      if (!parsed.settings.contextWindow) parsed.settings.contextWindow = picked?.ctx || 128000;
      if (parsed.settings.customModelId === undefined) parsed.settings.customModelId = "";
      if (!Array.isArray(parsed.settings.mcpServers)) parsed.settings.mcpServers = [];
      if (!parsed.settings.modelOverrides || typeof parsed.settings.modelOverrides !== "object") {
        parsed.settings.modelOverrides = {};
      }
      if (!parsed.settings.modelStatus || typeof parsed.settings.modelStatus !== "object") {
        parsed.settings.modelStatus = {};
      }
      if (!parsed.settings.modelCatalog || typeof parsed.settings.modelCatalog !== "object") {
        parsed.settings.modelCatalog = {};
      }
      if (!parsed.settings.keys || typeof parsed.settings.keys !== "object") {
        parsed.settings.keys = {};
      }
      Object.keys(PROVIDERS).forEach((k) => {
        if (typeof parsed.settings.keys[k] !== "string") parsed.settings.keys[k] = "";
      });
      // 旧版只有一把 apiKey：迁移到当前模型所属的服务槽位
      if (parsed.settings.apiKey && !Object.values(parsed.settings.keys).some(Boolean)) {
        const slot = picked?.providerKey || "custom";
        parsed.settings.keys[slot] = parsed.settings.apiKey;
      }
      // 迁移后不再保留旧字段，避免同一把 Key 在导出里出现两次
      if (parsed.settings.apiKey !== undefined) parsed.settings.apiKey = "";
      if (parsed.settings.requestTimeout === undefined) parsed.settings.requestTimeout = 60;
      // 0.67.0 起工具调用步数不再设上限。老配置里的 maxSteps（8/24/…）
      // 会被 runtime 当成内部限流重新变成一道硬墙，必须清掉，
      // 否则用户升级后照样在 24 步被拦，还找不到设置项去改。
      delete parsed.settings.maxSteps;
      delete parsed.settings.stepsBoosted;
      if (parsed.settings.notifyOnDone === undefined) parsed.settings.notifyOnDone = true;
      if (parsed.settings.haptics === undefined) parsed.settings.haptics = true;
      if (parsed.settings.fontScale === undefined) parsed.settings.fontScale = 1;
      if (parsed.settings.density === undefined) parsed.settings.density = "comfortable";
      if (!parsed.settings.profileName) parsed.settings.profileName = "本机用户";

      // 0.8 及以前只有全局 baseUrl。首次升级时把它归到当前模型，
      // 之后每个模型各自保存，切换模型不会再互相覆盖。
      //
      // contextWindow 不再迁移：全局默认就是 128000，一旦把它写成
      // 某个模型的覆盖值，512K / 1M 的模型每次重启都会被砍回 128K。
      // 这不是理论风险 —— 新用户「添加模型 → 选中 → 重启」就会命中。
      const hadOverrides = Object.keys(parsed.settings.modelOverrides).length > 0;
      if (!hadOverrides && picked) {
        const patch = {};
        const oldBase = String(parsed.settings.baseUrl || "").trim();
        if (oldBase && oldBase !== String(picked.baseUrl || "").trim()) patch.baseUrl = oldBase;
        if (Object.keys(patch).length) parsed.settings.modelOverrides[picked.id] = patch;
      }

      // 一次性清掉旧版本按上面那段逻辑写坏的 ctx 覆盖：
      // 只认「覆盖值正好是 128000、而模型自身窗口更大」这一种形态，
      // 清完打标记，之后用户手动把某个模型改成 128K 不会再被碰。
      if (!parsed.settings.ctxOverrideFixed) {
        for (const [id, ov] of Object.entries(parsed.settings.modelOverrides)) {
          if (!ov || typeof ov !== "object") continue;
          if (Number(ov.ctx) !== 128000) continue;
          const model = (parsed.settings.customModels || []).find((x) => x && x.id === id);
          if (!model || Number(model.ctx) <= 128000) continue;
          delete ov.ctx;
          if (!Object.keys(ov).length) delete parsed.settings.modelOverrides[id];
          persistAfterLoad = true;
        }
        parsed.settings.ctxOverrideFixed = true;
        // 标记本身也要落盘，否则下次启动又会把用户后来手动改的 128K 清掉
        persistAfterLoad = true;
      }
    }
    const plugins = Array.isArray(parsed.plugins) ? parsed.plugins : base.plugins;

    // 0.80.0 起不再预置「番茄钟」示例。
    //
    // 只删种子形态（没有 codePath、不是我装的真插件）——
    // 万一用户从市场装过同名插件，那条记录要留着。
    // 删完立刻落盘，否则每次启动都要再算一遍，且设置页的计数会来回跳。
    const withoutPomodoro = plugins.filter(
      (p) => !(p && p.id === "pomodoro" && !p.codePath && p.removable !== true)
    );
    if (withoutPomodoro.length !== plugins.length) {
      plugins.length = 0;
      plugins.push(...withoutPomodoro);
      persistAfterLoad = true;
    }

    // 迁移：已安装过旧版本时，补齐新内置插件（不覆盖用户开关）
    //
    // 内置插件现在一律 removable:false：它们是宿主能力，不是装进来的包。
    // 以前它们可以被「卸载」，卸掉之后既没有下载地址、也不在官方清单里，
    // 用户就再也找不回来了 —— 那正是「插件不存在也无法下载」的来源。
    base.plugins
      .filter((p) => p.preinstalled)
      .forEach((bp) => {
        const i = plugins.findIndex((p) => p.id === bp.id);
        if (i === -1) {
          plugins.unshift({ ...bp });
          return;
        }
        // 内置插件升级：同步静态元信息，保留用户的开关状态
        plugins[i] = {
          ...plugins[i],
          name: bp.name,
          desc: bp.desc,
          version: bp.version,
          author: bp.author,
          license: bp.license,
          source: bp.source,
          preinstalled: true,
          removable: false,
          experimental: bp.experimental,
          tools: bp.tools,
          scopes: bp.scopes,
        };
      });
    // 清掉 0.9 以前预置的演示任务与定时计划（按固定种子 id 识别，不动用户自建的）
    const SEED_RUN_IDS = ["r_1", "r_2", "r_3"];
    const SEED_AUTO_IDS = ["a_daily", "a_weekly", "a_plugin"];
    parsed.runs = (Array.isArray(parsed.runs) ? parsed.runs : []).filter((r) => !SEED_RUN_IDS.includes(r.id));
    parsed.automations = (Array.isArray(parsed.automations) ? parsed.automations : []).filter(
      (a) => !SEED_AUTO_IDS.includes(a.id)
    );
    if (parsed.stats && parsed.stats.tokens === 128400) parsed.stats = { runs: 0, tools: 0, tokens: 0 };

    // 会话正文：优先从分片键读取；旧版本（单键存储）则从 parsed.sessions 迁移过来
    const loaded = loadSessions(parsed);

    const result = {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}) },
      // 种子只在首次出现，后续以用户数据为准
      sessions: loaded,
      files: parsed.files && typeof parsed.files === "object" ? parsed.files : base.files,
      library: parsed.library && typeof parsed.library === "object" ? parsed.library : {},
      fsBackend: typeof parsed.fsBackend === "string" ? parsed.fsBackend : "",
      fsRoot: typeof parsed.fsRoot === "string" ? parsed.fsRoot : "",
      plugins,
      team: parsed.team && Array.isArray(parsed.team.runs) ? parsed.team : base.team,
      review:
        parsed.review && typeof parsed.review === "object"
          ? {
              scans: Number(parsed.review.scans) || 0,
              blocked: Number(parsed.review.blocked) || 0,
            }
          : base.review,
      automations: Array.isArray(parsed.automations) ? parsed.automations : base.automations,
      safety: parsed.safety || base.safety,
      diagnostics: parsed.diagnostics && Array.isArray(parsed.diagnostics.requests)
        ? parsed.diagnostics
        : base.diagnostics,
    };

    // 崩溃/被系统杀掉后，状态里会残留 status="running" 的消息与工具。
    // 这些运行已经不存在了（对应的 AbortController 随进程一起没了），
    // 如果不收拾，重开后消息会永远转圈、而且停不下来——用户描述的"记录坏死"就是这么来的。
    healInterruptedRuns(result);

    return result;
  } catch {
    return DEFAULT_STATE();
  }
}

/** 读取分片会话；兼容旧单键格式并做一次性迁移。 */
function loadSessions(parsed) {
  const index = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  const out = [];
  let migrated = false;

  for (const entry of index) {
    // 新格式：index 里只有 {id,title,updatedAt}
    const sid = entry?.id;
    if (!sid) continue;
    const frag = readJson(`${LS_SESSIONS}.${sid}`, null);
    if (frag && Array.isArray(frag.messages)) {
      out.push({ ...entry, ...frag });
    } else {
      // 旧格式：会话全文就在主键里
      const legacy = entry.messages ? entry : null;
      if (legacy) {
        out.push(legacy);
        migrated = true;
      } else {
        out.push({ ...entry, messages: [], createdAt: entry.createdAt || Date.now(), mode: entry.mode || "standard" });
      }
    }
  }

  // 主键里还残留完整会话（迁移前的老数据）→ 全部转成分片
  if (index.some((s) => Array.isArray(s.messages) && s.messages.length)) migrated = true;

  if (migrated) {
    for (const s of out) {
      if (!s.messages?.length) continue;
      writeJson(`${LS_SESSIONS}.${s.id}`, s);
    }
    // 迁移完成后立刻把主键瘦身（去掉内联的会话正文），
    // 否则老用户的主键会一直带着几百 KB 正文，
    // 后续每次写入都可能被配额卡住——这正是"记录坏死"的起点。
    try {
      const light = { ...parsed, sessions: parsed.sessions.map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt })) };
      writeJson(LS_KEY, light);
    } catch {
      /* 忽略 */
    }
  }

  const active = localStorage.getItem(LS_ACTIVE);
  if (active) parsed.activeSessionId = active;

  return out;
}

/**
 * 自愈：把上次进程异常退出留下的 "running" 状态收敛掉。
 * 消息 → stopped（并注明是异常中断），工具 → stopped，任务记录 → error。
 */
function healInterruptedRuns(st) {
  let healed = 0;
  for (const s of st.sessions || []) {
    for (const m of s.messages || []) {
      if (m.status === "running") {
        m.status = "stopped";
        m.error = m.error || "上次运行被系统中断（应用被回收或崩溃）。已保留已生成的内容，可重新提问继续。";
        m.interrupted = true;
        healed++;
      }
      for (const t of m.tools || []) {
        if (t.status === "running" || t.status === "waiting") {
          t.status = "stopped";
          t.interrupted = true;
        }
      }
    }
  }
  for (const r of st.runs || []) {
    if (r.status === "running") {
      r.status = "error";
      r.error = "运行被系统中断";
      healed++;
    }
  }
  if (healed) {
    // 立刻把自愈结果写回，避免下次启动又看到 running
    try {
      setTimeout(() => {
        save(true);
      }, 0);
    } catch {
      /* 忽略 */
    }
  }
  return healed;
}

/* ---------------- 落盘 ---------------- */

/**
 * 状态分片存储。
 *
 * 之前整个 state（含所有会话全文、工具输出、诊断）挤在一个 localStorage 键里，
 * 一边流式输出一边全量 JSON.stringify，几 MB 就会撞上 5MB 上限；
 * setItem 抛配额异常后只被 console.warn 吞掉，于是内存里的新状态再也写不进去，
 * 重开应用就回到一份"坏数据"——表现就是记录乱掉、停不下来。
 *
 * 现在改成：
 *   - LS_KEY      设置 / 模型 / 文件索引等轻量状态（常驻）
 *   - LS_SESSIONS 每个会话一个键，单独读写，互不拖累
 *   - LS_ACTIVE   当前会话 id
 * 写入超限时按会话逐个降级（先丢最旧会话），保证设置与模型永远不会丢。
 */
const LS_SESSIONS = "dsh.mobile.sessions.v1";
const LS_ACTIVE = "dsh.mobile.active.v1";

/** 会话正文在内存里的上限：超出后只保留头部，工具输出另存。 */
const SESSION_CHARS_CAP = 400000;

function readJson(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn("持久化失败：", key, err);
    return false;
  }
}

/** 把一个会话的体积压到可落盘的规模。 */
function compactSession(s) {
  const copy = { ...s, messages: (s.messages || []).slice() };
  let total = 0;
  for (const m of copy.messages) {
    total += (m.content || "").length + (m.reasoning || "").length;
    if (m.tools?.length) {
      // 工具输出只留前 800 字，完整内容在应用内仍可从内存取
      copy.messages = copy.messages.map((x) =>
        x === m
          ? { ...x, tools: x.tools.map((t) => ({ ...t, output: String(t.output || "").slice(0, 800) })) }
          : x
      );
    }
  }
  if (total > SESSION_CHARS_CAP) {
    // 超量：从最早的消息开始裁正文，保留最后 8 条完整
    const keepTail = 8;
    let acc = 0;
    copy.messages = copy.messages.map((m, i) => {
      const isTail = i >= copy.messages.length - keepTail;
      if (isTail) {
        acc += (m.content || "").length;
        return m;
      }
      const text = String(m.content || "");
      if (acc + text.length > SESSION_CHARS_CAP) {
        acc += text.length;
        return { ...m, content: text.slice(0, 4000) + "\n…（历史内容已裁剪以节省空间）", trimmed: true };
      }
      acc += text.length;
      return m;
    });
  }
  return copy;
}

/**
 * 极端降级版本：只保留每条消息的正文骨架（工具输出清空、正文截到 400 字），
 * 用于配额已经见底、常规压缩仍然写不进去的情况。
 */
function tinySession(s) {
  return {
    ...s,
    messages: (s.messages || []).map((m) => ({
      id: m.id,
      role: m.role,
      ts: m.ts,
      status: m.status,
      content: String(m.content || "").slice(0, 400),
      tools: (m.tools || []).map((t) => ({ id: t.id, name: t.name, status: t.status, output: "" })),
    })),
  };
}

/** load() 做了需要立刻落盘的修复时置 true；state 初始化后才能调 save。 */
let persistAfterLoad = false;

// 这几个是 save() 的运行状态。必须放在 state 初始化之前：
// 加载期的一次性修复要当场落盘，而 save 会先 clearTimeout(saveTimer)。
const listeners = new Set();
let saveTimer = null;
let sessionSaveTimers = new Map();
/** 有新内容、还没落盘的会话 id */
const dirtySessions = new Set();

export const state = load();

// 一次性修复必须当场写回去：只改内存的话，下次启动标记又没了，
// 用户后来手动改成的 128K 会被反复清掉。
if (persistAfterLoad) save(true);

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(detail) {
  listeners.forEach((fn) => fn(detail));
}

/** 会话正文单独落盘，节流 1.2s：流式期间只写当前会话。 */
function saveSession(sid) {
  const s = state.sessions.find((x) => x.id === sid);
  if (!s) return;
  const key = `${LS_SESSIONS}.${sid}`;
  if (!writeJson(key, compactSession(s))) {
    // 配额爆了：先删最旧的会话（保留当前会话），再试一次
    const others = state.sessions.filter((x) => x.id !== sid).sort((a, b) => a.updatedAt - b.updatedAt);
    for (const o of others) {
      try {
        localStorage.removeItem(`${LS_SESSIONS}.${o.id}`);
      } catch {
        /* 忽略 */
      }
      if (writeJson(key, compactSession(s))) break;
    }
    // 还是写不下：进一步瘦身，至少把"会话存在 + 最近内容"保住
    if (!writeJson(key, tinySession(s))) {
      console.warn("会话正文落盘失败，已降级为最小快照：", sid);
    }
  }
  dirtySessions.delete(sid);
}

function scheduleSessionSave(sid) {
  dirtySessions.add(sid);
  clearTimeout(sessionSaveTimers.get(sid));
  sessionSaveTimers.set(
    sid,
    setTimeout(() => {
      sessionSaveTimers.delete(sid);
      saveSession(sid);
    }, 1200)
  );
}

export function save(immediate = false) {
  clearTimeout(saveTimer);
  const write = () => {
    // 1) 轻量状态：不含会话正文
    const light = {
      ...state,
      sessions: state.sessions.map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt })),
      // 运行时状态不落盘：下次启动时它们一定是过期的
      watchStatus: undefined,
    };
    if (!writeJson(LS_KEY, light)) {
      // 轻量部分都写不进去：清诊断历史再试一次（设置与模型必须保住）
      state.diagnostics = { requests: [] };
      writeJson(LS_KEY, light);
    }
    try {
      localStorage.setItem(LS_ACTIVE, state.activeSessionId || "");
    } catch {
      /* 忽略 */
    }
    // 2) 只重写"脏"会话，避免每次流式更新都全量序列化所有历史
    for (const sid of [...dirtySessions]) saveSession(sid);
  };
  if (immediate) write();
  else saveTimer = setTimeout(write, 180);
}

/** 会话内容变化时调用：只标记该会话为脏，由节流器落盘。 */
export function saveSessionNow(sid) {
  scheduleSessionSave(sid);
}

/**
 * 立即落盘（不等节流）。
 *
 * 用于"页面即将转入后台"这种一次性时刻：此时进程随时可能被系统回收，
 * 而节流器那 1.2 秒的定时器在后台未必来得及触发，
 * 结果就是已经流出来的内容全丢，回来只剩一个空壳。
 */
export function flushSessionNow(sid) {
  if (!sid) return;
  clearTimeout(sessionSaveTimers.get(sid));
  sessionSaveTimers.delete(sid);
  dirtySessions.add(sid);
  saveSession(sid);
}

/* ---------------- 选择器 ---------------- */

export const activeSession = () =>
  state.sessions.find((s) => s.id === state.activeSessionId) || null;

export const currentMode = () => MODES[state.settings.mode] || MODES.standard;

/** 当前会话选的工作模式（设计/代码/办公/学习）；没选返回 null。 */
export const currentPreset = () => PRESETS[activeSession()?.preset] || null;

/** 模型目录里的原始默认值（用于「恢复默认」）。 */
export function modelDefaults(m) {
  return {
    label: m.label,
    apiModel: m.apiModel || "",
    baseUrl: m.baseUrl || "",
    ctx: Number(m.ctx) || 128000,
    format: modelFormat(m),
    temperature: null,
    maxTokens: null,
    supportsEffort: !!m.supportsEffort,
    vision: m.vision,
  };
}

/** 把逐模型覆盖合并进目录项；目录默认值保持不变，随时可恢复。 */
export function effectiveModel(m) {
  const override = state.settings.modelOverrides?.[m.id] || {};
  const merged = { ...m };
  Object.entries(override).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") merged[k] = v;
  });
  merged.ctx = Number(merged.ctx) || Number(m.ctx) || 128000;
  merged.defaults = modelDefaults(m);
  merged.overridden = Object.keys(override).length > 0;
  return merged;
}

export const allModels = () => {
  const custom = Array.isArray(state.settings.customModels) ? state.settings.customModels : [];
  return custom.map(effectiveModel);
};

/** 当前模型；一个都没添加时返回 null，由界面引导用户去添加。 */
export const currentModel = () =>
  allModels().find((m) => m.id === state.settings.model) || null;
export const hasModels = () => allModels().length > 0;

/** 真正发给接口的 model id。 */
export const modelApiId = (model = currentModel()) => {
  if (!model) return "";
  const id = String(model.apiModel || "").trim();
  // 兼容旧版：内置「自定义模型」条目曾把手填值放在 settings.customModelId
  if (!id && model.id === "custom") return String(state.settings.customModelId || "").trim();
  return id;
};

/** 某个模型对应的服务槽位。 */
export const providerKeyOf = (model = currentModel()) => model?.providerKey || "custom";

/**
 * 某个模型说哪种协议。
 *
 * 优先级：条目自己带的 format → 供应方预设的 format → OpenAI 兼容。
 * 三条路都要有，因为：手填的网关没有预设；老的预设没有 format；
 * 而用户可以把「Anthropic 官方」这个预设下的某个模型单独改成别的协议。
 */
export function modelFormat(model = currentModel()) {
  if (!model) return "openai";
  const own = String(model.format || "");
  if (FORMAT_IDS.indexOf(own) >= 0) return own;
  const preset = PROVIDERS[providerKeyOf(model)];
  const fromPreset = String((preset && preset.format) || "");
  return FORMAT_IDS.indexOf(fromPreset) >= 0 ? fromPreset : "openai";
}

/** 某个模型的 Key（按 provider 分槽，切换服务不会串 Key）。 */
export const apiKeyFor = (model = currentModel()) => {
  const slot = providerKeyOf(model);
  // 归档里可能存着带空格 / Bearer 前缀 / 换行的旧值。请求发出前统一清洗，
  // 否则一把在电脑上有效的 Key，到了移动端会变成 `Bearer Bearer sk-…`。
  const { key } = normalizeApiKey(state.settings.keys?.[slot]);
  if (key) return key;
  // 本地服务（Ollama / LM Studio 一类）通常不校验 Key，
  // 但请求头需要一个非空值，否则会被当成「未配置」拦在门口 ——
  // 用户只能随手编一串字符，既没意义又容易被误认为真凭据。
  const preset = PROVIDERS[slot];
  return preset && preset.local ? String(preset.placeholderKey || "local") : "";
};

/**
 * Key 诊断：401 时告诉用户「当前模型到底在读哪个槽、读到了什么」。
 *
 * 分槽保存是好事，但也带来一个真实困惑：在「账号与服务」里给 A 服务填了
 * Key，模型却挂在 B 槽上 —— 请求带着另一把 Key（或干脆空着）发出去，
 * 服务端回 401，界面显示「Key 无效」，用户怎么检查键都觉得没错。
 */
export function keyDiagnosis(model = currentModel()) {
  const slot = providerKeyOf(model);
  const keys = state.settings.keys || {};
  const raw = String(keys[slot] || "");
  const { key, notes } = normalizeApiKey(raw);
  const filledElsewhere = Object.entries(keys)
    .filter(([k, v]) => k !== slot && normalizeApiKey(v).key)
    .map(([k]) => k);
  return {
    slot,
    key,
    shape: keyShape(key),
    cleaned: notes,
    filledElsewhere,
    empty: !key,
  };
}
export const apiKeyForCurrent = () => apiKeyFor(currentModel());
export const hasKeyFor = (model) => {
  // 插件提供的模型没有 Key —— 它的端点在 Node 里的 adapter 上。
  // 这里返回 true，界面才不会一直提示「未配置 Key · 无法对话」。
  if (model && (model.source === "node-llm" || String(model.provider || "").startsWith("node__"))) {
    return true;
  }
  return !!apiKeyFor(model);
};

/** 当前模型生效的上下文窗口（按模型保存，不再是一个全局值）。 */
export const modelContextWindow = (model = currentModel()) =>
  Math.max(4096, Math.min(2000000, Number(model?.ctx) || Number(state.settings.contextWindow) || 128000));

/** 保存逐模型参数覆盖；传空值等于删除该覆盖项。 */
export function saveModelOverride(id, patch) {
  const overrides = { ...(state.settings.modelOverrides || {}) };
  const next = { ...(overrides[id] || {}) };
  Object.entries(patch).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "") delete next[k];
    else next[k] = v;
  });
  if (Object.keys(next).length) overrides[id] = next;
  else delete overrides[id];
  state.settings.modelOverrides = overrides;
  save(true);
  emit({ type: "settings", patch: { modelOverrides: overrides } });
}

/** 恢复某个模型的目录默认值。 */
export function clearModelOverride(id) {
  const overrides = { ...(state.settings.modelOverrides || {}) };
  delete overrides[id];
  state.settings.modelOverrides = overrides;
  save(true);
  emit({ type: "settings", patch: { modelOverrides: overrides } });
}

/** 记录连接结果；传 null 清除。 */
export function setModelStatus(id, status) {
  const list = { ...(state.settings.modelStatus || {}) };
  if (status) list[id] = { ...status, at: Date.now() };
  else delete list[id];
  state.settings.modelStatus = list;
  save(true);
  emit({ type: "settings", patch: { modelStatus: list } });
}

export const modelStatusOf = (id) => state.settings.modelStatus?.[id] || null;

/** 新增或更新 MCP 服务器。 */
export function upsertMcpServer(server) {
  const list = Array.isArray(state.settings.mcpServers) ? [...state.settings.mcpServers] : [];
  const i = list.findIndex((s) => s.id === server.id);
  if (i === -1) list.push(server);
  else list[i] = server;
  state.settings.mcpServers = list;
  save(true);
  emit({ type: "settings", patch: { mcpServers: list } });
  return server;
}

export function removeMcpServer(id) {
  state.settings.mcpServers = (state.settings.mcpServers || []).filter((s) => s.id !== id);
  save(true);
  emit({ type: "settings", patch: { mcpServers: state.settings.mcpServers } });
}

/** 新增或更新一个自定义模型。 */
export function upsertCustomModel(model) {
  const list = Array.isArray(state.settings.customModels) ? [...state.settings.customModels] : [];
  const i = list.findIndex((m) => m.id === model.id);
  if (i === -1) list.push(model);
  else list[i] = model;
  state.settings.customModels = list;
  save(true);
  emit({ type: "settings", patch: { customModels: list } });
  return model;
}

/* ---------------- 可用模型目录 ----------------
   一次获取、长期复用：模型面板不再要求用户记 ID。 */

/**
 * 记住某服务商探测到的模型清单（按 baseUrl + 协议区分）。
 *
 * 缓存 key 必须带协议：同一个网关可能同时开 OpenAI 兼容与 Anthropic 兼容
 * 两个入口，返回的模型清单并不一样；只按 slot 存会串。
 */
export function rememberModelCatalog(slot, baseUrl, ids, options = {}) {
  const format = normalizeFormat(options.format);
  const key = `${slot || "custom"}|${format}`;
  const map = state.settings.modelCatalog || (state.settings.modelCatalog = {});
  const items = (Array.isArray(options.items) ? options.items : [])
    .map((it) => ({
      id: String((it && it.id) || ""),
      label: String((it && it.label) || ""),
      ctx: Number(it && it.ctx) || 0,
    }))
    .filter((it) => it.id)
    .slice(0, 1000);
  map[key] = {
    baseUrl: String(baseUrl || "").replace(/\/+$/, ""),
    format,
    ids: Array.from(new Set((ids || []).map(String).filter(Boolean))).slice(0, 1000),
    items,
    ts: Date.now(),
  };
  save(true);
  return map[key];
}

/** 取某服务商缓存过的模型清单；endpoint 不匹配时返回空。 */
export function catalogFor(slot, baseUrl = "", format = "openai") {
  const map = state.settings.modelCatalog || {};
  const fmt = normalizeFormat(format);
  // 0.65 及以前的旧 key 是裸 slot、且只有 OpenAI 一种协议 —— 只给它回退
  let row = map[`${slot || "custom"}|${fmt}`];
  if (!row && fmt === "openai") row = map[slot || "custom"];
  if (!row || !Array.isArray(row.ids)) return [];
  const now = String(baseUrl || "").replace(/\/+$/, "");
  if (now && row.baseUrl && row.baseUrl !== now) return [];
  return row.ids;
}

/** 同 catalogFor，但要的是带名称/窗口的完整条目。 */
export function catalogItemsFor(slot, baseUrl = "", format = "openai") {
  const map = state.settings.modelCatalog || {};
  const fmt = normalizeFormat(format);
  let row = map[`${slot || "custom"}|${fmt}`];
  if (!row && fmt === "openai") row = map[slot || "custom"];
  if (!row) return [];
  const now = String(baseUrl || "").replace(/\/+$/, "");
  if (now && row.baseUrl && row.baseUrl !== now) return [];
  return Array.isArray(row.items) ? row.items : [];
}

/**
 * 批量新增模型。
 *
 * 探测一次可能带回来几十个模型，逐个 upsert 就是几十次 save + emit ——
 * 每次 emit 都会触发整页重渲染，手机上肉眼可见地卡。这里合并成一次。
 */
export function addCustomModels(models) {
  const list = Array.isArray(state.settings.customModels) ? [...state.settings.customModels] : [];
  const added = [];
  (models || []).forEach((m) => {
    if (!m || !m.id) return;
    if (list.some((x) => x && x.id === m.id)) return;
    list.push(m);
    added.push(m);
  });
  if (added.length) {
    state.settings.customModels = list;
    save(true);
    emit({ type: "settings", patch: { customModels: list } });
  }
  return added;
}

/** 删除自定义模型；若正在使用，退回 DeepSeek Chat。 */
export function removeCustomModel(id) {
  state.settings.customModels = (state.settings.customModels || []).filter((m) => m.id !== id);
  if (state.settings.modelOverrides) delete state.settings.modelOverrides[id];
  if (state.settings.modelStatus) delete state.settings.modelStatus[id];
  if (state.settings.model === id) {
    state.settings.model = null;
  }
  save(true);
  emit({ type: "settings", patch: { customModels: state.settings.customModels } });
}

/** 写入请求诊断（最多 50 条）。 */
export function addDiagnostic(entry) {
  if (!state.diagnostics) state.diagnostics = { requests: [] };
  state.diagnostics.requests.unshift({ ...entry, ts: Date.now() });
  state.diagnostics.requests = state.diagnostics.requests.slice(0, 50);
  save();
}

/** 当前请求端点：只认这个模型自己的配置；旧全局值已在迁移时写入覆盖。 */
export const modelBaseUrl = (model = currentModel()) =>
  String(model?.baseUrl || model?.defaults?.baseUrl || "").trim();

export const pluginTools = () => {
  const set = new Set();
  state.plugins.forEach((p) => {
    if (p.enabled) p.tools.forEach((t) => set.add(t));
  });
  return set;
};

/* ---------------- 会话 actions ---------------- */

export function createSession({ mode, preset = null, title = "新会话" } = {}) {
  const s = {
    id: uid("s"),
    title,
    createdAt: now(),
    updatedAt: now(),
    mode: mode || state.settings.mode,
    // 工作模式跟着会话走，不跟着人走：同一个用户可能上午写代码、下午做汇报。
    // null 表示「还没选」，此时 system prompt 不注入任何契约。
    preset: PRESETS[preset] ? preset : null,
    model: state.settings.model,
    workspace: "默认工作区",
    messages: [],
  };
  state.sessions.unshift(s);
  state.activeSessionId = s.id;
  save();
  emit({ type: "session:new", id: s.id });
  return s;
}

export function switchSession(id) {
  state.activeSessionId = id;
  save();
  emit({ type: "session:switch", id });
}

/**
 * 给会话设定工作模式。
 *
 * 传 null / 未知值 = 取消，回到「不注入」。
 * 已经有了消息也能改：system prompt 每轮重新拼，下一句就生效。
 */
export function setSessionPreset(id, preset) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return null;
  const next = PRESETS[preset] ? preset : null;
  if (s.preset === next) return s;
  s.preset = next;
  s.updatedAt = now();
  save();
  emit({ type: "session:preset", id: s.id, preset: next });
  return s;
}

export function forkSession(id) {
  const src = state.sessions.find((s) => s.id === id);
  if (!src) return null;
  const copy = {
    ...src,
    id: uid("s"),
    title: `${src.title} · 分叉`,
    createdAt: now(),
    updatedAt: now(),
    messages: src.messages.map((m) => ({
      ...m,
      id: uid(m.role === "user" ? "u" : "a"),
      tools: (m.tools || []).map((t) => ({ ...t, id: uid("t") })),
    })),
  };
  state.sessions.unshift(copy);
  state.activeSessionId = copy.id;
  save(true);
  writeJson(`${LS_SESSIONS}.${copy.id}`, compactSession(copy));
  emit({ type: "session:fork", id: copy.id });
  return copy;
}

export function deleteSession(id) {
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.activeSessionId === id) state.activeSessionId = null;
  try {
    localStorage.removeItem(`${LS_SESSIONS}.${id}`);
  } catch {
    /* 忽略 */
  }
  dirtySessions.delete(id);
  save(true);
  emit({ type: "session:delete", id });
}

export function touchSession(id, patch = {}) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  Object.assign(s, patch, { updatedAt: now() });
  save();
}

export function addMessage(sessionId, msg) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s) return null;
  s.messages.push(msg);
  s.updatedAt = now();
  if (msg.role === "user" && (s.title === "新会话" || !s.title)) {
    s.title = msg.content.replace(/\s+/g, " ").slice(0, 22);
  }
  save();
  scheduleSessionSave(sessionId);
  return msg;
}

/* ---------------- 工作区 / 资料库 actions ----------------
   内容存在手机真实目录（APK）或 IndexedDB（浏览器），state 里只留元数据索引。
   列表类 API 保持同步（渲染用），读写一律 async。 */

const normalizePath = (p) =>
  String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\.{2,}\//g, "")
    .replace(/\/{2,}/g, "/")
    .trim();

/* ---------------- 按会话隔离工作区 ----------------
   真实存储路径有两种：
     · 共享区：`parts/01.html`（0.71.0 及以前留下的文件都在这里）
     · 会话私有区：`sessions/<sessionId>/parts/01.html`
   工具、模型、UI 看到的永远是「逻辑路径」`parts/01.html`，
   映射全部收口在下面这几个函数里，调用方零改动。

   为什么用路径前缀而不是 FS 的 area 分桶：
   DshFsBridge.areaDir() 把除 library / traj / deps 之外的 area 全部
   落到同一个 <root>/workspace 目录，native 侧根本不区分 area；
   而 IndexedDB 侧的 key 是 `${area}:${path}`，区分。
   用 area 会让「浏览器里隔离、真机上串台」——只能用路径前缀，
   这样两种后端语义完全一致。 */
const WS_SESSION_DIR = "sessions/";

/**
 * 不参与隔离、始终写共享区的目录：
 * · plugins/  —— Node 插件运行时直接扫 <root>/workspace/plugins/，且 state.plugins 是全局的；
 *               隔离后插件会「装上了但加载不到」。plugin-install-node.js 本来就用 FS 直写共享区。
 * · 学习库/   —— 长期记忆，设计上就是跨会话沉淀，不该跟着某个会话消失。
 * · skills/   —— 技能包装一次就该所有会话可用。放进会话私有区的话，
 *                在 A 会话装完切到 B，skill_read 会读不到文件，而
 *                state.skills 是全局的 —— 列表里有、读出来是空，最难查的那种。
 */
const WS_SHARED_PREFIXES = ["plugins/", "学习库/", "skills/"];
const wsIsShared = (logical) =>
  WS_SHARED_PREFIXES.some((p) => normalizePath(logical).startsWith(p));

function wsScope() {
  if (state.settings.isolateWorkspace === false || !state.activeSessionId) return "";
  return `${WS_SESSION_DIR}${state.activeSessionId}/`;
}

const wsIsSessionOwned = (real) => String(real || "").startsWith(WS_SESSION_DIR);

/** 真实路径 → 当前会话能看到的逻辑路径；属于别的会话时返回空串。 */
function wsLogical(real, scope = wsScope()) {
  const p = normalizePath(real);
  if (!p) return "";
  if (!scope) return p; // 共用模式：全部真实路径可见（含历史会话前缀）
  if (p.startsWith(scope)) return p.slice(scope.length);
  if (wsIsSessionOwned(p)) return "";
  return p; // 共享区
}

/** sessions/ 是内部保留目录：外部一律用逻辑路径，不接受带前缀的越界请求。 */
const wsGuard = (raw) => {
  const p = normalizePath(raw);
  return p.startsWith(WS_SESSION_DIR) ? "" : p;
};

/** 写入一律落到当前会话私有区；白名单目录例外（跨会话共享资产）。 */
const wsWritePath = (logical, scope = wsScope()) =>
  wsIsShared(logical) ? normalizePath(logical) : scope + normalizePath(logical);

/** 读取：白名单直读共享区；其余私有区优先、回退共享区。 */
function wsReadPath(logical, scope = wsScope()) {
  const p = normalizePath(logical);
  if (wsIsShared(p)) return p;
  const own = scope + p;
  if (state.files[own]) return own;
  if (state.files[p]) return p;
  return own;
}

/** 给 UI / 测试看的隔离概况。 */
export function sessionWorkspaceInfo() {
  const scope = wsScope();
  const all = Object.values(state.files || {}).map((f) => normalizePath(f.path));
  return {
    isolated: !!scope,
    sessionId: state.activeSessionId,
    scope,
    own: scope ? all.filter((p) => p.startsWith(scope)).length : all.length,
    shared: all.filter((p) => !wsIsSessionOwned(p)).length,
    others: scope ? all.filter((p) => wsIsSessionOwned(p) && !p.startsWith(scope)).length : 0,
  };
}

/** 某个会话私有区里有多少文件（删会话时用来如实告知）。 */
export function sessionFileCount(sessionId) {
  if (!sessionId) return 0;
  const scope = `${WS_SESSION_DIR}${sessionId}/`;
  return Object.values(state.files || {}).filter((f) => normalizePath(f.path).startsWith(scope)).length;
}

/**
 * 已删除会话留下的文件：真实路径在 sessions/<id>/ 里，但 sessions[] 已经没有这个 id。
 *
 * 0.72.0 有意选择「删会话不删文件」，避免误删用户还想留的产物；
 * 但那些文件此后任何会话都看不见，也没有入口回收，等于永久占着存储。
 * 这里只统计、不自动清理，由用户明确点「清理」才删。
 */
export function orphanWorkspaceInfo() {
  const live = new Set((state.sessions || []).map((s) => s.id));
  const ids = new Set();
  let count = 0;
  let bytes = 0;
  for (const f of Object.values(state.files || {})) {
    const p = normalizePath(f.path);
    if (!p.startsWith(WS_SESSION_DIR)) continue;
    const sid = p.slice(WS_SESSION_DIR.length).split("/")[0];
    if (!sid || live.has(sid)) continue;
    ids.add(sid);
    count += 1;
    bytes += Number(f.size) || 0;
  }
  return { count, bytes, sessions: ids.size };
}

/** 清理无主文件（只动 sessions/ 下、会话已不存在的路径）。 */
export async function purgeOrphanWorkspace() {
  const live = new Set((state.sessions || []).map((s) => s.id));
  const info = orphanWorkspaceInfo();
  if (!info.count) return { ...info, removed: 0 };
  let removed = 0;
  for (const [key, f] of Object.entries(state.files || {})) {
    const p = normalizePath(f.path);
    if (!p.startsWith(WS_SESSION_DIR)) continue;
    const sid = p.slice(WS_SESSION_DIR.length).split("/")[0];
    if (!sid || live.has(sid)) continue;
    try {
      await FS.deleteDoc("workspace", p);
      removed += 1;
    } catch {
      /* 已不存在：索引照样清掉 */
    }
    delete state.files[key];
  }
  save();
  emit({ type: "fs:delete", path: "*" });
  return { ...info, removed };
}

/** 路径指纹：忽略全/半角括号、空白、URL 编码与大小写差异。 */
export function pathKey(p) {
  let s = String(p || "").replace(/\\/g, "/");
  try {
    s = decodeURIComponent(s);
  } catch {
    /* 含非法百分号时保留原样 */
  }
  return s
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[［]/g, "[")
    .replace(/[］]/g, "]")
    .replace(/[＋]/g, "+")
    .replace(/[／]/g, "/")
    .replace(/[\u00a0\u3000\s]+/g, "")
    .normalize("NFC")
    .toLowerCase();
}

/** 在候选路径中找到用户真正指的那个；找不到返回空串。 */
export function matchFilePath(candidates, raw, opts = {}) {
  const want = normalizePath(raw);
  if (!want) return "";
  const list = (candidates || [])
    .map((x) => normalizePath(typeof x === "string" ? x : x && x.path))
    .filter(Boolean);
  if (list.includes(want)) return want;
  const key = pathKey(want);
  let hits = list.filter((p) => pathKey(p) === key);
  if (!hits.length && !want.includes("/") && opts.basename !== false) {
    // 只给了文件名：允许在任意子目录下找同名文件
    hits = list.filter((p) => pathKey(p.slice(p.lastIndexOf("/") + 1)) === key);
  }
  if (!hits.length) return "";
  if (hits.length === 1) return hits[0];
  // 同名多份：优先 uploads/，其次路径最短
  const up = hits.filter((p) => p.startsWith("uploads/"));
  return (up.length ? up : hits).sort((a, b) => a.length - b.length)[0];
}

/** 解析为当前视图里已存在的逻辑路径；解析不到返回规范化原值（用于新建文件）。 */
export function resolveWorkspacePath(path) {
  const raw = wsGuard(path);
  if (!raw) return "";
  return matchFilePath(listFiles().map((f) => f.path), raw) || raw;
}

export let filesReady = false;

/** 启动时初始化：探测后端 → 迁移旧数据 → 建立索引。 */
export async function initFiles() {
  const info = await FS.initFs();
  state.fsBackend = info.backend;
  state.fsRoot = info.root || "";

  // 旧版本把 content 存在 localStorage：一次性搬到真实目录。
  // 这些是「共享区」文件（不带会话前缀），升级后所有会话都能看到，
  // 但任何写入都会落到当前会话私有区，不会污染原件。
  const legacy = Object.values(state.files || {}).filter((f) => f && typeof f.content === "string");
  if (legacy.length) {
    for (const f of legacy) {
      const path = normalizePath(f.path);
      if (!path) continue;
      try {
        if (f.encoding === "base64") await FS.writeBinaryDoc("workspace", path, f.content, f.mime);
        else await FS.writeDoc("workspace", path, f.content);
      } catch (err) {
        console.warn("迁移文件失败：", path, err);
      }
    }
  }

  await syncIndex("workspace");
  await syncIndex("library");
  filesReady = true;
  save(true);
  emit({ type: "fs:ready", backend: info.backend, migrated: legacy.length });
  return { ...info, migrated: legacy.length };
}

/** 从存储后端重建某区域的元数据索引。 */
export async function syncIndex(area = "workspace") {
  try {
    const docs = await FS.listDocs(area);
    const next = {};
    for (const d of docs) {
      next[d.path] = { path: d.path, size: d.size || 0, updatedAt: d.updatedAt || now() };
    }
    if (area === "library") state.library = next;
    else state.files = next;
    save();
    return next;
  } catch (err) {
    console.warn("读取文件索引失败：", err);
    return area === "library" ? state.library : state.files;
  }
}

export const listFiles = () => {
  const scope = wsScope();
  const out = new Map(); // 逻辑路径 -> 元数据；私有区文件优先于共享区同名文件
  for (const f of Object.values(state.files || {})) {
    const logical = wsLogical(f.path, scope);
    if (!logical) continue;
    const shared = !(scope && normalizePath(f.path).startsWith(scope));
    const prev = out.get(logical);
    if (!prev || !shared) out.set(logical, { ...f, path: logical, shared });
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
};

export const listLibrary = () =>
  Object.values(state.library || {}).sort((a, b) => a.path.localeCompare(b.path));

export const fileExists = (path) => listFiles().some((f) => pathKey(f.path) === pathKey(path));

/** 读取工作区文件；不存在返回 null。返回体里的 path 是逻辑路径。 */
export async function readFile(path) {
  const logical = resolveWorkspacePath(path);
  if (!logical) return null;
  const p = wsReadPath(logical);
  try {
    const doc = await FS.readDoc("workspace", p);
    return { ...doc, path: logical };
  } catch {
    return null;
  }
}

export async function writeFile(path, content) {
  // 视图内解析（basename 不兜底，避免 `report.md` 误覆盖 uploads/report.md）
  const raw = wsGuard(path);
  if (!raw) throw new Error("sessions/ 是会话私有目录，请用相对路径");
  const logical =
    matchFilePath(listFiles().map((f) => f.path), raw, { basename: false }) || raw;
  if (!logical) throw new Error("路径不能为空");
  const real = wsWritePath(logical);
  let previous = null;
  try {
    previous = (await FS.readDoc("workspace", real)).content;
  } catch {
    /* 新文件，或共享区基底 —— 都不读共享内容，写入只会落在私有区 */
  }
  const meta = await FS.writeDoc("workspace", real, String(content ?? ""));
  state.files[real] = { path: real, size: meta.size || 0, updatedAt: meta.updatedAt || now() };
  save();
  emit({ type: "fs:write", path: logical });
  return { path: logical, previous };
}

export async function deleteFile(path) {
  const logical = resolveWorkspacePath(path);
  if (!logical) return;
  const real = wsReadPath(logical);
  if (!real) return;
  // 共享区文件对所有会话可见，不能从某个会话里删掉；只删私有区副本。
  // 白名单目录（plugins/、学习库/）例外：它们本来就是共享资产，删插件要能删掉。
  const scope = wsScope();
  if (scope && !real.startsWith(scope) && !wsIsShared(real)) return;
  await FS.deleteDoc("workspace", real);
  delete state.files[real];
  save();
  emit({ type: "fs:delete", path: logical });
}

export async function writeBinaryFile(path, base64, mime, size) {
  const raw = wsGuard(path);
  if (!raw) throw new Error("sessions/ 是会话私有目录，请用相对路径");
  const logical =
    matchFilePath(listFiles().map((f) => f.path), raw, { basename: false }) || raw;
  if (!logical) throw new Error("路径不能为空");
  const real = wsWritePath(logical);
  const meta = await FS.writeBinaryDoc("workspace", real, String(base64 || ""), mime);
  state.files[real] = {
    path: real,
    size: meta.size || size || 0,
    updatedAt: meta.updatedAt || now(),
    encoding: "base64",
    mime: mime || "application/octet-stream",
  };
  save();
  emit({ type: "fs:write", path: logical });
  return { path: logical, size: state.files[real].size };
}

/** 读取任意区域的文件（资料库/工作区共用）；工作区路径按当前会话映射。 */
export function readDoc(area, path) {
  if (area === "library") return FS.readDoc("library", normalizePath(path));
  const logical = wsGuard(path);
  if (!logical) return Promise.reject(new Error("文件不存在"));
  return FS.readDoc("workspace", wsReadPath(logical)).then((doc) => ({ ...doc, path: logical }));
}

/**
 * 导入备份：只替换**当前会话视图**，不动共享区和其他会话的文件。
 * 老版本会 clearArea("workspace") 全清 —— 隔离后那样会一次性抹掉所有会话产物。
 */
export async function replaceFiles(files) {
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error("不是有效的工作区文件结构");
  }
  const entries = Object.values(files).filter((f) => f && typeof f.path === "string");
  const scope = wsScope();
  for (const f of listFiles()) {
    const real = wsReadPath(f.path);
    if (!scope || real.startsWith(scope)) {
      try {
        await FS.deleteDoc("workspace", real);
      } catch {
        /* 已不存在 */
      }
      delete state.files[real];
    }
  }
  let written = 0;
  for (const f of entries) {
    const logical = normalizePath(f.path);
    if (!logical) continue;
    const real = wsWritePath(logical);
    if (f.encoding === "base64") await FS.writeBinaryDoc("workspace", real, f.content || "", f.mime);
    else await FS.writeDoc("workspace", real, f.content ?? "");
    written += 1;
  }
  await syncIndex("workspace");
  emit({ type: "fs:write", path: "*" });
  return written;
}

/* ---------------- 资料库 ---------------- */

function uniqueLibraryPath(path) {
  const base = normalizePath(path);
  if (!state.library[base]) return base;
  const slash = base.lastIndexOf("/");
  const dir = slash >= 0 ? base.slice(0, slash + 1) : "";
  const name = slash >= 0 ? base.slice(slash + 1) : base;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${dir}${stem}-${i}${ext}`;
    if (!state.library[candidate]) return candidate;
  }
  return `${dir}${stem}-${Date.now()}${ext}`;
}

/** 把工作区文件复制进资料库（源文件保留）。 */
export async function saveToLibrary(path) {
  const p = normalizePath(path);
  const doc = await readFile(p);
  if (!doc) throw new Error(`文件不存在：${p}`);
  const target = uniqueLibraryPath(p);
  if (doc.encoding === "base64") {
    await FS.writeBinaryDoc("library", target, doc.content, doc.mime);
  } else {
    await FS.writeDoc("library", target, doc.content);
  }
  await syncIndex("library");
  emit({ type: "fs:write", path: target });
  return target;
}

export async function deleteFromLibrary(path) {
  const p = normalizePath(path);
  if (!p) return;
  await FS.deleteDoc("library", p);
  delete state.library[p];
  save();
  emit({ type: "fs:delete", path: p });
}

/** 从手机选择文件导入资料库。 */
export async function importToLibrary() {
  const added = await FS.importFromPhone("library");
  await syncIndex("library");
  emit({ type: "fs:write", path: "*" });
  return added;
}

/**
 * 从手机选择文件导入工作区 uploads/（聊天附件用）。
 * 文件落在真实目录里，模型可以直接用 fs_read / shell 读，而不是只存在于消息里。
 */
export async function importToWorkspace(subdir = "uploads") {
  const added = await FS.importFromPhone("workspace", wsScope() + subdir);
  await syncIndex("workspace");
  emit({ type: "fs:write", path: "*" });
  return added;
}

/** 把文件另存到手机（APK 走系统保存面板，浏览器走下载）。 */
export function exportDoc(area, path) {
  if (area === "library") return FS.exportToPhone("library", normalizePath(path));
  const logical = wsGuard(path);
  if (!logical) return Promise.reject(new Error("文件不存在"));
  return FS.exportToPhone("workspace", wsReadPath(logical));
}

/** 两区统计（设置页 / 资料库页脚）。 */
export function filesStats() {
  const sizeOf = (list) => list.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
  return {
    workspace: { count: listFiles().length, bytes: sizeOf(listFiles()) },
    library: { count: listLibrary().length, bytes: sizeOf(listLibrary()) },
  };
}

/* ---------------- 插件 actions ---------------- */

export function togglePlugin(id, enabled) {
  const p = state.plugins.find((x) => x.id === id);
  if (!p) return;
  p.enabled = enabled;
  save();
  emit({ type: "plugin:toggle", id, enabled });
}

export function installPlugin(plugin) {
  if (state.plugins.some((p) => p.id === plugin.id)) {
    togglePlugin(plugin.id, true);
    return state.plugins.find((p) => p.id === plugin.id);
  }
  const p = {
    id: plugin.id,
    name: plugin.name,
    desc: plugin.desc || "由 Agent 在会话中创建并挂载的插件。",
    version: plugin.version || "0.1.0",
    author: plugin.author || "you",
    official: false,
    enabled: true,
    tools: plugin.tools || [],
    scopes: plugin.scopes || ["ui.slot"],
    installedAt: now(),
  };
  state.plugins.push(p);
  save();
  emit({ type: "plugin:install", id: p.id });
  return p;
}

/* ---------------- 自动化 / 后台任务 ---------------- */

export function toggleAutomation(id, enabled) {
  const a = state.automations.find((x) => x.id === id);
  if (!a) return;
  a.enabled = enabled;
  a.nextRun = enabled ? now() + DAY : null;
  save();
  emit({ type: "automation:toggle", id });
}

export function deleteAutomation(id) {
  state.automations = state.automations.filter((a) => a.id !== id);
  save();
  emit({ type: "automation:delete", id });
}

export function addAutomation({ name, prompt, schedule, cron }) {
  const a = {
    id: uid("a"),
    name,
    prompt,
    schedule,
    cron,
    enabled: true,
    lastRun: null,
    nextRun: now() + 6 * 3600000,
    history: [],
  };
  state.automations.unshift(a);
  save();
  emit({ type: "automation:add", id: a.id });
  return a;
}

export function stopRun(id) {
  const r = state.runs.find((x) => x.id === id);
  if (r) {
    r.status = "done";
    r.progress = 100;
    save();
    emit({ type: "run:stop", id });
  }
}

/* ---------------- 设置 ---------------- */

export function setSettings(patch) {
  let next = patch;
  if (patch && Object.prototype.hasOwnProperty.call(patch, "keys")) {
    const cleaned = {};
    for (const [slot, raw] of Object.entries(patch.keys || {})) {
      cleaned[slot] = normalizeApiKey(raw).key;
    }
    const merged = { ...(state.settings.keys || {}), ...cleaned };
    next = { ...patch, keys: merged };

    // Key 一变，之前那次连接结果就不再具备参考意义。
    // 不清掉的话，用户改完 Key 仍会看到上一次留下的「Key 无效」，
    // 明明已经改对了却像没生效 —— 这是「填入 Key 后显示 Key 无效」
    // 最容易被忽略的一半原因。
    const touched = Object.keys(cleaned).filter(
      (slot) => cleaned[slot] !== String(state.settings.keys?.[slot] ?? "")
    );
    if (touched.length) {
      const statuses = { ...(state.settings.modelStatus || {}) };
      let removed = false;
      for (const m of allModels()) {
        if (touched.includes(providerKeyOf(m)) && statuses[m.id]) {
          delete statuses[m.id];
          removed = true;
        }
      }
      if (removed) next = { ...next, modelStatus: statuses };
    }
  }
  Object.assign(state.settings, next);
  save();
  emit({ type: "settings", patch: next });
}

/**
 * 更新 Node 插件清单。
 *
 * 不落盘 —— 插件清单是**运行时状态**：Node 重启后它自己会重新报上来。
 * 落盘反而会造成「界面上还显示着插件，其实已经没了」的错觉。
 */
export function setNodePlugins(list) {
  state.nodePlugins = Array.isArray(list) ? list : [];
  emit({ type: "node:plugins", plugins: state.nodePlugins });
}

/**
 * 记下 Node 侧的插件目录诊断。
 *
 * 「未找到插件」这句话本身不提供信息：可能是目录不存在、目录空、
 * 文件写到了别处。界面要靠这份快照把差别说出来。
 */
/** 更新插件目录监听的状态（页面展示用）。 */
export function setWatchStatus(st) {
  state.watchStatus = st && typeof st === "object" ? st : null;
  emit({ type: "node:watch", status: state.watchStatus });
}

export function setNodePluginsDiag(diag) {
  state.nodePluginsDiag = diag && typeof diag === "object" ? diag : null;
}

export async function resetAll() {
  // 清空两区真实目录，再清状态，避免残留文件让新状态"复活"
  try {
    await FS.clearArea("workspace");
    await FS.clearArea("library");
  } catch (err) {
    console.warn("清空文件目录失败：", err);
  }
  // 分片会话要逐个删，否则重置后老会话会"复活"
  for (const s of state.sessions || []) {
    try {
      localStorage.removeItem(`${LS_SESSIONS}.${s.id}`);
    } catch {
      /* 忽略 */
    }
  }
  try {
    localStorage.removeItem(LS_ACTIVE);
  } catch {
    /* 忽略 */
  }
  localStorage.removeItem(LS_KEY);
  location.reload();
}

/* ---------------- 时间格式 ---------------- */

export function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fmtRelative(ts) {
  if (!ts) return "—";
  const diff = now() - ts;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function fmtFuture(ts) {
  if (!ts) return "—";
  const diff = ts - now();
  if (diff <= 0) return "即将";
  if (diff < 3600000) return `${Math.max(1, Math.round(diff / 60000))} 分钟后`;
  if (diff < DAY) return `${Math.round(diff / 3600000)} 小时后`;
  return `${Math.round(diff / DAY)} 天后`;
}

export function fmtClock(ms) {
  if (!ms && ms !== 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

export function fmtTokens(n) {
  if (!n) return "0";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
