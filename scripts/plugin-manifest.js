/* ============================================================
   插件清单（manifest）—— 插件的身份证与权限声明

   一个插件由两部分组成：

     1. 清单（manifest）—— 一段 JSON，声明身份、权限、工具、代码
     2. 代码（code）—— 插件主体，跑在 iframe 沙箱里

   清单长这样：

   {
     "id": "my-plugin",              // 全局唯一，小写字母数字与连字符
     "name": "我的插件",
     "version": "1.0.0",
     "description": "一句话说明它是干什么的",
     "author": "someone",
     "homepage": "https://…",        // 可选
     "permissions": ["fs.read"],     // 声明要哪些宿主能力
     "tools": [                      // 可选：静态声明工具（也可在代码里 registerTool）
       { "name": "my_tool", "description": "…", "parameters": {…} }
     ],
     "code": "…",                    // 内联代码
     "entry": "https://…/main.js"    // 或者：代码在别处，按 URL 拉取
   }

   安装来源有两种：
     - entry：清单里给代码地址，安装时二次拉取
     - code ：清单里直接内联代码，单次请求即可装完

   官方清单（OFFICIAL_PLUGINS）是内置的一份可信清单，
   用户也可以直接填任意 URL 装第三方插件。
   ============================================================ */

/** 插件 id 合法形态：只允许小写字母、数字、连字符与下划线。 */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * 允许插件声明的宿主能力。
 *
 * 这里只列真正实现了的。宁可少给，也不要留一个「声明了但调用会失败」的坑。
 *   fs.read  —— 读工作区文件
 *   fs.write —— 写工作区文件
 *   net      —— 发起网络请求（GET / POST）
 */
export const ALLOWED_PERMISSIONS = ["fs.read", "fs.write", "net"];

/** 单个插件体积上限（字符数）。防止一个清单塞进几十 MB。 */
const MAX_CODE_CHARS = 400000;

/** 清单各字段的硬上限。 */
const LIMITS = {
  name: 60,
  description: 300,
  author: 60,
  version: 20,
  homepage: 300,
};

/**
 * 校验并规范化一个清单。
 *
 * 返回 { ok, plugin, error }。
 * 任何一条不满足都直接拒掉 —— 插件是第三方代码，宁可严。
 */
export function validateManifest(raw) {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "清单不是一个对象" };
  }

  const id = String(raw.id || "").trim();
  if (!ID_RE.test(id)) {
    return { ok: false, error: "插件 id 不合法：只允许小写字母、数字、连字符与下划线，且以字母数字开头" };
  }

  const name = String(raw.name || "").trim();
  if (!name) return { ok: false, error: "插件缺少 name" };
  if (name.length > LIMITS.name) return { ok: false, error: `插件名超过 ${LIMITS.name} 字` };

  const version = String(raw.version || "0.1.0").trim();
  if (!/^\d+(\.\d+){0,3}$/.test(version)) {
    return { ok: false, error: `版本号格式不合法：${version}` };
  }

  const description = String(raw.description || "").trim().slice(0, LIMITS.description);

  const author = String(raw.author || "").trim().slice(0, LIMITS.author);

  const homepage = String(raw.homepage || "").trim().slice(0, LIMITS.homepage);
  if (homepage && !/^https?:\/\//i.test(homepage)) {
    return { ok: false, error: "homepage 必须以 http:// 或 https:// 开头" };
  }

  // 权限：只保留白名单内的，且去重
  const rawPerms = Array.isArray(raw.permissions) ? raw.permissions : [];
  const permissions = [];
  const badPerm = rawPerms.find((p) => !ALLOWED_PERMISSIONS.includes(String(p)));
  if (badPerm) {
    return { ok: false, error: `未知权限「${badPerm}」，可用权限：${ALLOWED_PERMISSIONS.join(" / ")}` };
  }
  rawPerms.forEach((p) => {
    const s = String(p);
    if (!permissions.includes(s)) permissions.push(s);
  });

  // 代码：内联或 entry
  const code = typeof raw.code === "string" ? raw.code : "";
  const entry = String(raw.entry || "").trim();
  if (!code && !entry) {
    return { ok: false, error: "插件既没有内联 code，也没有 entry 地址" };
  }
  if (code.length > MAX_CODE_CHARS) {
    return { ok: false, error: `插件代码过大（${code.length} 字符，上限 ${MAX_CODE_CHARS}）` };
  }
  if (entry && !/^https?:\/\//i.test(entry)) {
    return { ok: false, error: "entry 必须以 http:// 或 https:// 开头" };
  }

  // 静态工具声明（可选）
  const rawTools = Array.isArray(raw.tools) ? raw.tools : [];
  const tools = [];
  for (const t of rawTools) {
    if (!t || typeof t !== "object") continue;
    const tn = String(t.name || "").trim();
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(tn)) {
      return { ok: false, error: `工具名不合法：${tn}` };
    }
    if (tools.some((x) => x.name === tn)) {
      return { ok: false, error: `工具名重复：${tn}` };
    }
    tools.push({
      name: tn,
      description: String(t.description || "").slice(0, 300),
      parameters: t.parameters && typeof t.parameters === "object" ? t.parameters : { type: "object", properties: {} },
    });
  }

  return {
    ok: true,
    plugin: {
      id,
      name,
      version,
      description,
      author,
      homepage,
      permissions,
      tools,
      code,
      entry,
    },
  };
}

/**
 * 内置官方清单。
 *
 * 这几个是**示例插件**，演示清单该怎么写、插件能拿到什么能力。
 * 它们随 APK 打包，不需要联网就能装 —— 这也是「插件系统自检」的方式。
 *
 * permissions 的含义：
 *   fs.read  —— 读工作区文件
 *   fs.write —— 写工作区文件
 *   net      —— 发起网络请求
 *   notify   —— 发系统通知
 */
export const OFFICIAL_PLUGINS = [
  {
    id: "hello",
    name: "打个招呼",
    version: "1.0.0",
    description: "最小示例插件：注册一个 greet 工具，向模型问好。用来验证插件链路是否正常。",
    author: "dsh",
    homepage: "",
    permissions: [],
    tools: [
      {
        name: "greet",
        description: "生成一句问候语。",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "要问候的名字" } },
          required: ["name"],
        },
      },
    ],
    code: `
// 插件代码在独立沙箱里运行。
// 这里能看到的只有 dsh 这一个对象 —— 没有宿主 DOM、没有 localStorage、没有模型 Key。
dsh.registerTool({
  name: "greet",
  description: "生成一句问候语。",
  parameters: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"]
  }
}, async (args) => {
  return "你好，" + (args.name || "陌生人") + "。这是来自「打个招呼」插件的问候。";
});

dsh.log("hello 插件已加载");
`,
  },
  {
    id: "wordcount",
    name: "字数统计",
    version: "1.0.0",
    description: "统计一段文本的字数、行数与词频分布，不联网、不读文件，纯本地计算。",
    author: "dsh",
    homepage: "",
    permissions: [],
    tools: [
      {
        name: "count_text",
        description: "统计文本的字数、行数、字符数与出现最多的词。",
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "要统计的文本" } },
          required: ["text"],
        },
      },
    ],
    code: `
dsh.registerTool({
  name: "count_text",
  description: "统计文本的字数、行数、字符数与出现最多的词。",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"]
  }
}, async (args) => {
  const text = String(args.text || "");
  const chars = Array.from(text).length;
  const lines = text ? text.split("\\n").length : 0;
  const words = text.match(/[\\u4e00-\\u9fa5]|[A-Za-z0-9']+/g) || [];
  const freq = {};
  words.forEach((w) => { freq[w] = (freq[w] || 0) + 1; });
  const top = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([w, n]) => w + " × " + n)
    .join("\\n");
  return "字符数：" + chars + "\\n行数：" + lines + "\\n词数：" + words.length + (top ? "\\n\\n高频词：\\n" + top : "");
});
`,
  },
  {
    id: "note",
    name: "随手笔记",
    version: "1.0.0",
    description: "演示 fs.read / fs.write 权限：把一段文字追加到工作区的笔记文件里。",
    author: "dsh",
    homepage: "",
    permissions: ["fs.read", "fs.write"],
    tools: [
      {
        name: "append_note",
        description: "把文字追加到工作区的 notes.md 文件。",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "要记下的内容" },
            file: { type: "string", description: "文件名，默认 notes.md" },
          },
          required: ["text"],
        },
      },
    ],
    code: `
// 这个插件声明了 fs.read / fs.write，所以 dsh.host 里才有这两个方法。
// 未声明的能力根本不存在 —— 沙箱里调用会直接抛错，不是靠约定拦住的。
dsh.registerTool({
  name: "append_note",
  description: "把文字追加到工作区的笔记文件。",
  parameters: {
    type: "object",
    properties: { text: { type: "string" }, file: { type: "string" } },
    required: ["text"]
  }
}, async (args) => {
  const file = String(args.file || "notes.md");
  const path = file.includes("/") ? file : "plugins/" + file;
  const text = String(args.text || "");
  let old = "";
  try {
    const res = await dsh.host.fsRead({ path: path });
    old = (res && res.content) || "";
  } catch (e) {
    // 文件还不存在，正常
  }
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  const next = old + (old ? "\\n" : "") + "- [" + stamp + "] " + text + "\\n";
  await dsh.host.fsWrite({ path: path, content: next });
  return "已写入 " + path + "（当前共 " + next.length + " 字符）";
});
`,
  },
];

/** 按 id 找官方插件。 */
export function findOfficialPlugin(id) {
  return OFFICIAL_PLUGINS.find((p) => p.id === id) || null;
}

/** 按名称或 id 模糊搜索官方插件。 */
export function searchOfficialPlugins(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return OFFICIAL_PLUGINS;
  return OFFICIAL_PLUGINS.filter(
    (p) =>
      p.id.toLowerCase().includes(q) ||
      p.name.toLowerCase().includes(q) ||
      String(p.description).toLowerCase().includes(q)
  );
}
