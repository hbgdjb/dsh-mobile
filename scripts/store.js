/* ============================================================
   Store — 单一状态源、持久化、种子数据
   所有界面只读 state，通过 actions 写入；写入后统一 emit。
   ============================================================ */

import * as FS from "./fs.js";

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
 * 模型目录：每个条目都带**真实的 API model id 与默认端点**。
 * 选中模型时会把 baseUrl 切到该端点；设置里仍可手动覆盖。
 * 只列 OpenAI 兼容协议的服务 —— Claude 官方不是该协议，需要兼容网关时用「自定义模型」。
 */
export const APP_VERSION = "0.16.1";

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
  lmstudio: {
    name: "LM Studio · 本机",
    baseUrl: "http://localhost:1234/v1",
    defaultCtx: 128000,
    suggest: ["local-model"],
    hint: "LM Studio 本地服务；同一路由下用局域网 IP 访问手机外的电脑。",
    console: "https://lmstudio.ai",
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
      desc: "把 Markdown / CSV 导出为 Word、Excel，产物可直接用 WPS / Office 打开。",
      version: "1.8.0",
      author: "dsh",
      official: true,
      enabled: true,
      preinstalled: true,
      tools: ["office_export"],
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
      experimental: true,
      enabled: true,
      tools: [],
      scopes: ["microphone"],
    },
    {
      id: "teams",
      name: "智能体团队",
      desc: "团队协作、成员列表与共享任务看板。",
      version: "0.4.0",
      author: "dsh",
      official: true,
      experimental: true,
      enabled: false,
      tools: ["agent_team"],
      scopes: ["delegate", "shared-state"],
    },
    {
      id: "review",
      name: "自动授权审查",
      desc: "对高风险工具调用做二次模型复核，再决定是否放行。",
      version: "0.3.2",
      author: "dsh",
      official: true,
      experimental: true,
      enabled: false,
      tools: [],
      scopes: ["approval"],
    },
    {
      id: "pomodoro",
      name: "番茄钟",
      desc: "会话内悬浮计时器，25 分钟专注 / 5 分钟休息。",
      version: "0.1.0",
      author: "you",
      official: false,
      enabled: false,
      tools: [],
      scopes: ["ui.slot"],
      installedAt: now() - DAY,
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
    maxSteps: 24,
    theme: "dark",
    motion: true,
    searchEndpoint: "",
    showReasoning: true,
    fontSize: 14,
    fontScale: 1,
    density: "comfortable",
    notifyOnDone: true,
    haptics: true,
    requestTimeout: 60,
    hudEnabled: false,
    mcpServers: [],
    profileName: "本机用户",
  },
  sessions: seedSessions(),
  activeSessionId: null,
  files: seedFiles(),
  library: {},
  fsBackend: "",
  fsRoot: "",
  plugins: seedPlugins(),
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
      // 默认步数 8 → 24：老配置一次性提升，之后仍可在设置里手动调低
      if (parsed.settings.stepsBoosted !== true) {
        parsed.settings.maxSteps = Math.max(24, Number(parsed.settings.maxSteps) || 0);
        parsed.settings.stepsBoosted = true;
      }
      if (parsed.settings.notifyOnDone === undefined) parsed.settings.notifyOnDone = true;
      if (parsed.settings.haptics === undefined) parsed.settings.haptics = true;
      if (parsed.settings.fontScale === undefined) parsed.settings.fontScale = 1;
      if (parsed.settings.density === undefined) parsed.settings.density = "comfortable";
      if (!parsed.settings.profileName) parsed.settings.profileName = "本机用户";

      // 0.8 及以前只有全局 baseUrl/contextWindow。首次升级时把它们归到当前模型，
      // 之后每个模型各自保存，切换模型不会再互相覆盖。
      const hadOverrides = Object.keys(parsed.settings.modelOverrides).length > 0;
      if (!hadOverrides && picked) {
        const patch = {};
        const oldBase = String(parsed.settings.baseUrl || "").trim();
        if (oldBase && oldBase !== String(picked.baseUrl || "").trim()) patch.baseUrl = oldBase;
        const oldCtx = Number(parsed.settings.contextWindow) || 0;
        if (oldCtx && oldCtx !== Number(picked.ctx)) patch.ctx = oldCtx;
        if (Object.keys(patch).length) parsed.settings.modelOverrides[picked.id] = patch;
      }
    }
    const plugins = Array.isArray(parsed.plugins) ? parsed.plugins : base.plugins;
    // 迁移：已安装过旧版本时，补齐新内置插件（不覆盖用户开关）
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

export const state = load();

const listeners = new Set();
let saveTimer = null;
let sessionSaveTimers = new Map();
/** 有新内容、还没落盘的会话 id */
const dirtySessions = new Set();

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
    const light = { ...state, sessions: state.sessions.map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt })) };
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

/** 模型目录里的原始默认值（用于「恢复默认」）。 */
export function modelDefaults(m) {
  return {
    label: m.label,
    apiModel: m.apiModel || "",
    baseUrl: m.baseUrl || "",
    ctx: Number(m.ctx) || 128000,
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

/** 某个模型的 Key（按 provider 分槽，切换服务不会串 Key）。 */
export const apiKeyFor = (model = currentModel()) => {
  const slot = providerKeyOf(model);
  return String(state.settings.keys?.[slot] || "").trim();
};
export const apiKeyForCurrent = () => apiKeyFor(currentModel());
export const hasKeyFor = (model) => !!apiKeyFor(model);

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

/** 记住某服务商探测到的模型清单（按 baseUrl 区分端点）。 */
export function rememberModelCatalog(slot, baseUrl, ids) {
  const key = slot || "custom";
  const map = state.settings.modelCatalog || (state.settings.modelCatalog = {});
  map[key] = {
    baseUrl: String(baseUrl || "").replace(/\/+$/, ""),
    ids: Array.from(new Set((ids || []).map(String).filter(Boolean))),
    ts: Date.now(),
  };
  save(true);
  return map[key];
}

/** 取某服务商缓存过的模型清单；endpoint 不匹配时返回空。 */
export function catalogFor(slot, baseUrl = "") {
  const row = (state.settings.modelCatalog || {})[slot || "custom"];
  if (!row || !Array.isArray(row.ids)) return [];
  const now = String(baseUrl || "").replace(/\/+$/, "");
  if (now && row.baseUrl && row.baseUrl !== now) return [];
  return row.ids;
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

export function createSession({ mode, title = "新会话" } = {}) {
  const s = {
    id: uid("s"),
    title,
    createdAt: now(),
    updatedAt: now(),
    mode: mode || state.settings.mode,
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

/** 解析为已存在的真实路径；解析不到则返回规范化原值（用于新建文件）。 */
export function resolveWorkspacePath(path) {
  return matchFilePath(Object.keys(state.files || {}), path) || normalizePath(path);
}

export let filesReady = false;

/** 启动时初始化：探测后端 → 迁移旧数据 → 建立索引。 */
export async function initFiles() {
  const info = await FS.initFs();
  state.fsBackend = info.backend;
  state.fsRoot = info.root || "";

  // 旧版本把 content 存在 localStorage：一次性搬到真实目录
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

export const listFiles = () =>
  Object.values(state.files || {}).sort((a, b) => a.path.localeCompare(b.path));

export const listLibrary = () =>
  Object.values(state.library || {}).sort((a, b) => a.path.localeCompare(b.path));

export const fileExists = (path) => !!state.files[normalizePath(path)];

/** 读取工作区文件；不存在返回 null。 */
export async function readFile(path) {
  const p = resolveWorkspacePath(path);
  if (!p) return null;
  try {
    return await FS.readDoc("workspace", p);
  } catch {
    return null;
  }
}

export async function writeFile(path, content) {
  // 写入不跨目录兜底：避免 `report.md` 误覆盖 uploads/report.md
  const p = matchFilePath(Object.keys(state.files || {}), path, { basename: false }) || normalizePath(path);
  if (!p) throw new Error("路径不能为空");
  let previous = null;
  try {
    previous = (await FS.readDoc("workspace", p)).content;
  } catch {
    /* 新文件 */
  }
  const meta = await FS.writeDoc("workspace", p, String(content ?? ""));
  state.files[p] = { path: p, size: meta.size || 0, updatedAt: meta.updatedAt || now() };
  save();
  emit({ type: "fs:write", path: p });
  return { path: p, previous };
}

export async function deleteFile(path) {
  const p = resolveWorkspacePath(path);
  if (!p) return;
  await FS.deleteDoc("workspace", p);
  delete state.files[p];
  save();
  emit({ type: "fs:delete", path: p });
}

export async function writeBinaryFile(path, base64, mime, size) {
  const p = normalizePath(path);
  if (!p) throw new Error("路径不能为空");
  const meta = await FS.writeBinaryDoc("workspace", p, String(base64 || ""), mime);
  state.files[p] = {
    path: p,
    size: meta.size || size || 0,
    updatedAt: meta.updatedAt || now(),
    encoding: "base64",
    mime: mime || "application/octet-stream",
  };
  save();
  emit({ type: "fs:write", path: p });
  return { path: p, size: state.files[p].size };
}

/** 读取任意区域的文件（资料库/工作区共用）。 */
export const readDoc = (area, path) =>
  FS.readDoc(area === "library" ? "library" : "workspace", normalizePath(path));

/** 整份替换工作区（导入备份用）：清空后逐文件写入。 */
export async function replaceFiles(files) {
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error("不是有效的工作区文件结构");
  }
  const entries = Object.values(files).filter((f) => f && typeof f.path === "string");
  await FS.clearArea("workspace");
  let written = 0;
  for (const f of entries) {
    const path = normalizePath(f.path);
    if (!path) continue;
    if (f.encoding === "base64") await FS.writeBinaryDoc("workspace", path, f.content || "", f.mime);
    else await FS.writeDoc("workspace", path, f.content ?? "");
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
  const added = await FS.importFromPhone("workspace", subdir);
  await syncIndex("workspace");
  emit({ type: "fs:write", path: "*" });
  return added;
}

/** 把文件另存到手机（APK 走系统保存面板，浏览器走下载）。 */
export const exportDoc = (area, path) =>
  FS.exportToPhone(area === "library" ? "library" : "workspace", normalizePath(path));

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
  Object.assign(state.settings, patch);
  save();
  emit({ type: "settings", patch });
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
