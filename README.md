# DSH Mobile

**DeepSeek Harness 的 Android 触屏宿主。**
`Model + Harness = Agent` —— 同一套 Agent 循环、工具审批、插件装配与轨迹记录，为一块 6 英寸的屏幕重新排布。

纯前端运行时（HTML / CSS / 原生 ES Modules），无构建步骤、可离线、可装成 PWA，也可用 Capacitor 装进 Android WebView 出 APK。

> **v0.16.1** · 附件可预览：图片附件在气泡里显示缩略图，点开全屏查看（尺寸/大小、点图放大、保存到手机、文件信息，返回键/Esc 关闭）；文本与其它文件点开直接进文件预览（Markdown 渲染 / 纯文本 / 二进制卡片）；输入框里的附件名也能点开预览。
>
> **v0.16.0** · 会话渲染改为增量更新：按消息 id 复用 DOM，只替换变化的区块（正文 / 工具 / 推理 / 底部元信息），流式输出不再每帧重建整段历史；正文按文本长度自适应节流重排（70–180ms），流式光标常驻不再重播闪动，工具卡片在正文增长时零重建（不再频闪）；发送新消息时也不再重建整个对话页。
>
> **v0.15.1** · 修复"装了新版仍是旧行为"：Android 端不再注册 Service Worker 并主动清旧缓存（此前 SW 会继续喂旧脚本）；助手消息会显示「已随本条发送 N 张图片（尺寸，已压缩）」，模型未开视觉时发送前直接提示；`fs_read` 遇到图片会明确说明"只能作为附件发送"，避免模型反复读二进制；沙箱终端支持 `ls -l`、`wc -l/-w/-c`、`file`、`head/tail`，不再把 `-c` 当文件名报"文件不存在"。
>
> **v0.15.0** · 支持识图：图片附件按 OpenAI 多模态格式（content 数组 + image_url）发送，发送前把长边压到 1568px 并转 JPEG（2MB 截图约压到 200KB），单条最多 4 张；模型是否支持视觉可在「模型参数 → 图片输入」开关，已知视觉模型（GLM-5.3-Flash、GPT-4o/5、Claude、Gemini、Qwen-VL、MiMo V2.6、MiniMax M3 等）自动开启；模型不支持时不再让它去 fs_read 二进制乱猜，而是直接说明原因；服务端返回 400/422 时也会附上「关闭图片输入或换视觉模型」的提示。
>
> **v0.14.0** · 聊天可以直接发文件：输入框「+」→ 从手机任意位置选文件（系统文件选择器，多选），文件复制到工作区 `uploads/` 并作为附件随消息发送；纯文本（md / txt / csv / json / 代码等，单文件 ≤64KB、单条合计 ≤160KB）直接读给模型，PDF / Office / 图片等二进制保留路径供 Agent 用工具处理；附件在气泡与输入框里都有卡片，可单独移除，也能只发附件不写字。
>
> **v0.13.3** · 小米 MiMo 常用模型更正为 V2.6 三款：`mimo-v2.6-pro`、`mimo-v2.6-flash`、`mimo-v2.6-pro-ultraspeed`（均为 1M 上下文 / 128K 输出，默认窗口同步 1M）；移除已过期的 `MiMo-7B-RL`。
>
> **v0.13.2** · 修复部分国产 ROM（MIUI / HyperOS 等）把系统「字体大小」写进 WebView textZoom 导致的界面变形：启动时把 textZoom 锁回 100%，标题栏 / 标签栏 / 胶囊高度改为最小高度，文字放大时容器跟着长而不是被裁切。系统字号偏好请用「外观与阅读 → 正文大小」。
>
> **v0.13.1** · 设置改两级导航：先选大类（账号与服务 / 当前模型 / Agent 行为 / 工具与扩展 / 通知与网络 / 外观与阅读 / 数据与存储 / 关于），每类带一句实时摘要；进入后只显示该类的小类，互不干扰，返回键逐级回退。
>
> **v0.13.0** · 工作区落地真实目录：文件改存手机 `Android/data/ai.deepseek.dsh.mobile/files/workspace`（零权限、无 5MB 限制），浏览器版用 IndexedDB；新增「资料库」，只存重要与跨会话复用的文件，支持工作区收藏、手机导入、Agent `library_list / library_read / library_save` 检索引用；localStorage 只保留元数据索引，持久化体积回到 KB 级。
>
> **v0.12.7** · 加入 MiniMax M3.1 Flash（2026-10-19 发布，API ID `MiniMax-M3.1-Flash`，1M 上下文、最高 512K 输出、思考常开）到 MiniMax 常用模型首位；MiniMax 默认窗口同步为 1M。
>
> **v0.12.6** · 打开会话直接定位在最新消息：去掉聊天区的平滑滚动（长上下文不再从顶部一路滑到底部），首帧即在底部，无闪动。
>
> **v0.12.5** · 彻底移除本地演示：空工作区（只留 README）、无预置会话，未连接模型时发送直接报错并给出添加入口；打开任意会话默认停在最新消息（底部），不再回落到顶部。
>
> **v0.12.4** · 上下文窗口修正：内置各供应方「模型 ID → 实际窗口」表（DeepSeek V4 系 / GLM-5 系均为 1M），「获取模型列表」点选、手填模型 ID、编辑已有模型三种路径都会自动带出真实窗口，不再落在 128K 默认值；DeepSeek / GLM 供应方默认窗口同步调到 1M；设置页对已保存的低配模型给出「实际支持 1M · 点此填入」一键修正。另修复「有 Key 但未配模型」时抽屉渲染报错。
>
> **v0.12.3** · 自适应图标改为标准做法：整个「圆角方块 + D:」设计缩小居中于启动器遮罩内（白色衬底），D: 在最终图标中约占一半宽度，与设计稿一致；悬浮小球再次放大（浮条内 30px / 悬浮窗 48dp）。
>
> **v0.12.1** · 换上新图标（DeepSeek 蓝「D:」），悬浮小球去掉三只鱼鳍只留光球并整体放大——更干净，也更醒目。
>
> **v0.12.0** · 悬浮状态窗住进一颗 DSH 小球：动画移植自开源项目 [agent-hud-open](https://github.com/jazzenchen/agent-hud-open)（Apache-2.0）的 DeepSeek Bot——蓝球 + 白肚皮 + 一双会交叉的眼睛，待命时呼吸眨眼、思考时抬眼冒「…」、干活时随节拍点头、等待审批头顶「!」、完成时笑眼、失败时摇头打叉、429 限流时垂头叹息（⧗）。APK 悬浮窗与应用内浮条同源：Web 端为 Canvas 2D（`scripts/dsh-ball.js`），Android 端为原生 View（`DshBotView.java`），同一套参数与时间曲线；点一下小球还会跟你打招呼。
>
> **v0.11.0** · 悬浮状态窗：APK 内以系统悬浮窗（SYSTEM_ALERT_WINDOW）在其他应用上方显示 Agent 状态——可拖动、点按伸缩的状态条（空闲中 / 正在深度思考 / 正在执行 xx），多会话分框、任务步骤与进度；设置 → 通知与网络内置开关与悬浮窗权限请求。浏览器 / PWA 降级为应用内浮条。
>
> **v0.9.9** · 模型 ID 修正：智谱 GLM 按官方要求全部小写（glm-5.3 / glm-5.3-flash / glm-5.2 / glm-5-turbo）；豆包改用方舟严格有效的带日期后缀 ID（doubao-seed-2-1-pro-260915 / 260628），hint 提示以「获取模型列表」为准。
>
> **v0.9.8** · 安全与兼容修复：① fetch 分支补齐非流式兜底（网关忽略 stream 时不再空白回复）；② tool_call 分片重复 id 改为覆盖，修复 "call_Acall_A" 聚合错误；③ run_code 如实定性为「WebView 内执行、非安全沙箱」——严格模式 + 遮蔽 localStorage / fetch / DOM 等全局，Safety Net 新增脚本逃逸规则（触碰存储 / 网络 / DOM / eval 即拦截）；④「完全访问」权限描述如实化。
>
> **v0.9.7** · 限流冷却期间自动探测模型列表也一并暂停（面板内给出倒计时提示），彻底避免冷却期叠加请求。
>
> **v0.9.6** · 限流友好化：429 状态显示「限流 · 稍后再试」并给出具体指引；模型列表探测按端点缓存 10 分钟，避免反复请求触发限流；测试连接遇 429 自动进入 30 秒冷却。
>
> **v0.9.5** · 按最新统计更新各供应方「常用模型 ID」并附带上下文窗口（DeepSeek 1M、GLM-5.3、kimi-k3、qwen3.8、doubao-seed-2.1、MiniMax-M3、ERNIE-5、hy4-preview、Spark-X2.5 等）：点选建议即同时填入模型 ID 与上下文窗口，特殊条目附说明（如 qwen-long 千万级）。
>
> **v0.9.4** · 按官方文档校准端点：新增百度千帆、腾讯混元；小米 MiMo 改用官方国内站（api.xiaomimimo.com/v1）；MiniMax 主端点更新；智谱 / 豆包 / 千帆 / 讯飞增加「端点场景」一键切换（通用 / Coding Plan / X2 / Agent 等）；模型列表获取失败时自动尝试备用 /models 路径，Key 类错误单独提示。
>
> **v0.9.3** · 添加 / 编辑模型时自动探测端点提供的模型列表（OpenAI 兼容 GET /models，APK 走原生请求）：列表可筛选、点选即填入模型 ID；原生桥新增 GET 支持。
>
> **v0.9.2** · 供应方预设扩充到 15 家（新增智谱 GLM、通义千问、豆包火山方舟、MiniMax、小米 MiMo、讯飞星火、硅基流动、Groq、OpenRouter、Ollama / LM Studio 本地）；设置页内点任何控件不再跳回顶部；APK 内返回手势改为逐级回退，主页面两段式退出（「再按一次返回退出」）。
>
> **v0.9.1** · 不再预置任何模型与演示数据：模型全部由用户添加，供应方预设（端点、常用模型 ID、控制台入口）已备好，选一下即预填；老用户的模型在升级时自动收编为自定义条目，参数与连接状态不丢。任务页清空预置计划，顶部加「新建定时计划」引导。
>
> **v0.9.0** · 模型参数逐模型可编辑（上下文 / 端点 / 模型 ID / 温度 / 最大输出 / reasoning_effort）；连接状态全面可见（对话条、模型列表、设置页都有测试与延迟）；APK 内置原生 HTTP 流式桥，绕开 WebView 跨域限制，真实模型请求直接可用；输入路径零打断（输入法组合期间不再丢字、发送键即时点亮）；侧边栏底部「账号 / 设置」两栏，设置页带分类导航。

<p align="center">
  <img src="docs/home.png" width="232" alt="首页" />
  <img src="docs/chat.png" width="232" alt="对话与工具轨迹" />
  <img src="docs/approval.png" width="232" alt="写入审批" />
</p>
<p align="center">
  <img src="docs/slider.png" width="232" alt="模型面板里的推理等级滑条" />
  <img src="docs/slider-settings.png" width="232" alt="长按滑条打开设置" />
  <img src="docs/slider-light.png" width="232" alt="浅色主题" />
</p>
<p align="center">
  <img src="docs/models.png" width="232" alt="模型目录：逐模型状态与参数" />
  <img src="docs/model-params.png" width="232" alt="模型参数：上下文、端点、采样" />
  <img src="docs/settings.png" width="232" alt="设置：先选大类，再进小类" />
</p>
<p align="center">
  <img src="docs/account.png" width="232" alt="账号与服务" />
  <img src="docs/mcp.png" width="232" alt="MCP 服务器" />
  <img src="docs/diagnostics.png" width="232" alt="请求日志" />
</p>
<p align="center">
  <img src="docs/plugins.png" width="232" alt="插件" />
  <img src="docs/workspace.png" width="232" alt="工作区" />
  <img src="docs/desktop.png" width="232" alt="桌面端设备框" />
</p>

---

## 1. 这是什么

DSH Mobile 不是「套了层壳的聊天框」。它实现了 Harness 的核心闭环：

- 模型思考 → 调用工具 → 观察结果 → 继续推理，直到任务完成
- 文件写入、终端、脚本、插件安装等敏感操作先过审批闸门
- 四种运行模式按需装配工具，而不是只改提示词
- 所有工具调用与推理进入一条只追加的轨迹，可回看、可导出
- 一切皆插件：插件决定当前上下文里有哪些工具与界面槽位

没有连接模型时**不会运行任何本地脚本**：发送会直接提示去添加模型，避免把演示输出误当成模型回答。

## 2. 设计定调

| 项 | 决策 |
| --- | --- |
| 目的 | 在手机上完成「交代目标 → 审批 → 拿到产物」的完整 Agent 流程 |
| 受众 | 已经习惯桌面 Agent、需要在通勤/会议间隙处理任务的人 |
| 调性 | **工业极简 × 编辑感**：暖黑底、发丝线、等宽数据、宋体大标题 |
| 展示字 | Noto Serif SC 600（中文）/ 衬线回退 |
| 正文字 | Noto Sans SC 400 / 500 |
| 数据与标签 | IBM Plex Mono 400 / 500，`tabular-nums` |
| 主色 | 近黑 `#08090B`，占 60% |
| 辅助 | 石墨表面 `#0F1116` ~ `#1A1F2A`，占 30% |
| 强调 | 单一电光蓝 `#4763F4`，只给关键动作与运行态，占 10% |
| 记忆点 | 真实工具轨迹卡（状态、耗时、diff、审批）+ 桌面端的设备框 |

**反 AI 味约束**：没有白底紫渐变、没有三卡居中首屏、没有无意义线性图标装饰、没有「无缝赋能」。首屏是左对齐的编辑式大标题 + 编号快捷卡，右侧留白，信息密度按屏幕高度自适应。

## 3. 能力清单

| 能力 | 实现状态 | 说明 |
| --- | --- | --- |
| 多会话 | ✅ 真实 | 新建 / 搜索 / 重命名 / 分叉 / 导出 / 删除，按时间分组 |
| 聊天附件 | ✅ 新增 | 从手机选文件随消息发送；文本内联、**图片按 image_url 发送**（自动压缩）、其它二进制登记路径 |
| 工作区 | ✅ 真实 | 手机真实目录（APK）/ IndexedDB（浏览器），树状列表、Markdown / 代码预览、新建 / 删除 |
| 资料库 | ✅ 新增 | 只存重要与跨会话要复用的文件；工作区收藏、手机导入、Agent 可检索 |
| 四种模式 | ✅ 真实 | 标准、PTC、极简、创造，各自装配不同工具与系统提示词 |
| 模型切换 | ✅ 真实 | 目录里每个模型带真实 API id 与默认端点，选中即切换；支持自定义 OpenAI 兼容网关 |
| 工具调用 | ✅ 真实 | 文件读写删、终端子集、计算、时间、搜索、子 Agent、定时任务、插件、`run_code` |
| 审批闸门 | ✅ 真实 | 逐次询问 / 自动放行 / 全部拒绝；展示将写入内容或将执行脚本 |
| 权限三档 | ✅ 真实 | 只读 / 工作区写入 / 完全访问；只读会硬拒绝写入 |
| 账号与凭据 | ✅ 真实 | 本机档案；DeepSeek / OpenAI / Moonshot / 自定义四套 Key 分槽保存，切换模型不串 Key；DeepSeek 余额查询 |
| 模型管理 | ✅ 真实 | 目录 + 自定义模型增删改；真实 model id、端点与上下文窗口 |
| 插件系统 | ✅ 真实 | 开关即时改变可用工具；支持安装官方索引插件与自建插件 |
| 创造模式 | ✅ 真实 | `plugin_inspect` 查看运行时，`plugin_scaffold` 创建并热挂载 |
| DSH Office（内置） | ✅ 真实 | Markdown → `.docx`、CSV → `.xlsx`，标准 OOXML，工作区内直接下载 |
| Codex Effort Slider（内置） | ✅ 真实 | 上游 1.1.2 的 1:1 移植：整行连续滑条、Off / Low / High / Max、一档一色、高档紫色星云 + 22 颗星尘、三档动画、长按设置 |
| DSH Ops（内置） | ✅ 真实 | `ops_status` 运行时体检、`ops_cleanup` 清理导出产物（需审批） |
| CC Safety Net（内置） | ✅ 真实 | 拦截递归删除、格式化、远程脚本直通 shell；密钥写入在审批中提示 |
| 上下文窗口 | ✅ 真实 | 默认按模型预填、可手动覆盖；请求前按 72% 预算裁剪较早回合，并在消息里标注 |
| 通知与网络 | ✅ 真实 | 完成提醒、触感、30 / 60 / 120 秒超时；系统通知不可用时回退应用内提示 |
| MCP | ✅ 真实 | Streamable HTTP：服务器管理、连接测试、工具发现、审批后执行 |
| 诊断与隐私 | ✅ 真实 | 最近 50 次请求日志、复制 JSON、清空；无遥测、无上报 |
| 工作区备份 | ✅ 真实 | 导出 / 导入 JSON；真实设备目录映射需要原生插件 |
| 运行轨迹 | ✅ 真实 | 用时、工具次数、Token、推理、每次调用的参数与输出 |
| PTC | ✅ 真实 | `run_code` 里通过 `dsh.*` SDK 一次编排多步，写入受权限约束 |
| 子 Agent | ✅ 真实 | 独立上下文的单轮委派（受插件开关控制） |
| 定时任务 | ⚠️ 宿主桩 | 数据结构、开关、历史真实；到点执行需要原生调度器 |
| 后台任务 | ⚠️ 宿主桩 | 列表与停止可用，长任务托管留给 Android WorkManager |
| 语音输入 | ✅ 视设备 | Web Speech API；不支持时明确提示，不静默失败 |
| 团队协作 / 自动审批复核 | ⚠️ 占位 | 官方实验插件位，当前不影响工具装配 |

### 模型目录与上下文

目录里只放 **OpenAI 兼容协议** 的服务，每一项都写清楚实际 `model` id 和默认端点：

| 目录项 | 实际 model id | 默认端点 | 默认窗口 |
| --- | --- | --- | --- |
| DeepSeek Chat | `deepseek-chat` | `https://api.deepseek.com` | 128K |
| DeepSeek Reasoner | `deepseek-reasoner` | `https://api.deepseek.com` | 128K |
| GPT-4.1 | `gpt-4.1` | `https://api.openai.com/v1` | 1M |
| Moonshot v1 128K | `moonshot-v1-128k` | `https://api.moonshot.cn/v1` | 128K |
| 自定义模型 | 手填 | 手填 | 128K（可改） |

- 选中模型会自动切换 Base URL 与上下文窗口；Base URL 仍可手动改成自己的网关，模型 id 仍按目录里的值发。
- Claude 官方 API 不是 OpenAI 协议，因此没有直接列进目录；用「自定义模型」填兼容网关地址与模型 id。
- 上下文窗口按模型预填，可在设置里以 K 为单位覆盖。请求前用约 72% 的预算估算 token，按「用户回合」从旧到新裁剪，不会留下孤立的 tool 结果；裁剪后会在这条回答上方标注省略了几轮。
- token 是字符级粗估（中文≈1 字 / token，英文≈3.6 字符 / token），不是各厂商的精确 tokenizer，所以预算偏保守。

### 账号、模型与设置

**账号与服务**（设置顶部，或抽屉左下角头像）：

- 本机档案：名称、创建日期、会话 / 文件 / 占用统计。
- 四个服务槽位：DeepSeek、OpenAI、Moonshot、自定义 / 兼容网关。每套 Key 独立保存，切换模型时自动切换 Key，不会把 DeepSeek 的 Key 发给 OpenAI。
- DeepSeek 支持查询 `/user/balance` 余额；接口不允许跨域时会明确提示。
- **官方账号登录没有做**：需要官方 OAuth 回调与后端，当前纯 WebView 架构没有这条链路。页面里明确标注「未连接」，只提供开放平台链接，不伪造登录框。

**模型管理**：

- **没有任何预置模型**：模型全部由用户添加。供应方预设 15 家（DeepSeek、智谱 GLM、通义千问、豆包、Moonshot、MiniMax、小米 MiMo、讯飞星火、硅基流动、OpenAI、Groq、OpenRouter、Ollama、LM Studio、自定义网关），选中即预填端点与常用模型 ID，也可以全手填。
- 每个模型可单独编辑：显示名称、模型 ID、Base URL、上下文窗口、温度、最大输出、是否透传 `reasoning_effort`；首次编辑前自动备份，随时可「恢复默认」。
- 每行都有「闪电」测试连接，结果显示延迟与 HTTP 状态，并持久化到该模型。
- 只支持 OpenAI 兼容协议；Claude 官方、Gemini 等需要各自的兼容网关。
- 从 0.9 及以前升级时，正在使用的模型会自动收编为自定义条目（id、参数、连接状态全部保留）。

**连接状态**：

- 对话页顶部常驻状态芯片：`已连接 · 延迟` / `未验证` / `连接失败 · HTTP xxx` / `未配置 Key`；未连接时出现可操作的横幅（填 Key / 测试 / 改参数）。
- 每次真实请求（对话或测试）都会自动更新该模型的连接记录；填改 Key 后自动清空旧状态。
- 错误消息自带「测试连接 / 模型参数」按钮，不需要去翻设置。

**设置分组**：

| 分组 | 内容 |
| --- | --- |
| 账号与服务 | 本机档案、四个服务 Key、DeepSeek 余额、官方账号说明 |
| 当前模型 | 连接状态、Key、Base URL / 模型 ID / 上下文（逐模型保存）、推理强度、测试连接 |
| 模型管理 | 用户自定义模型、供应方预设、逐模型参数、连接测试 |
| Agent 默认 | 模式、权限、审批、最大步数 |
| 通知与网络 | 完成提醒、测试提醒、请求超时、触感、系统代理说明、语言 |
| 工作区与 MCP | 文件统计、工作区导入导出、真实目录说明、MCP 服务器 |
| 能力 | 搜索服务、显示思考 |
| 外观 | 主题、动效、正文大小、消息密度 |
| 数据 | 导出全部、重置 |
| 诊断与隐私 | 请求日志、遥测状态、清除所有 Key |
| 关于 | 版本、宿主、插件数、协议 |

**MCP**：

- 只支持 **Streamable HTTP**（JSON-RPC）。stdio / 本地进程型服务器需要 Capacitor 原生桥，当前不支持。
- 添加服务器后点「测试连接并发现工具」，会执行 `initialize` → `notifications/initialized` → `tools/list`。
- 发现的工具会以 `mcp__<server>__<tool>` 进入模型可用工具；调用前走审批，只读权限直接拒绝。
- Token 可选，随请求头发送；服务端需要允许 CORS。

**诊断与隐私**：

- 每次真实请求记录端点、模型、HTTP 状态、耗时、token 与错误摘要，最多 50 条，只存本机，不含 Key 与会话正文。
- 没有遥测与上报；「清除所有服务的 Key」只清凭据，不动会话与文件。

### 关于 `dsh-codex-effort-slider`

不是同名占位。`vendor/dsh-codex-effort-slider/` 保存了上游 **1.1.2** 的 MIT 产物，
`scripts/effort-slider.js` 按 `lib/client.js` 逐字移植了几何、颜色、能量、星尘与运动引擎：

| 项 | 上游 | 本应用 |
| --- | --- | --- |
| 位置 | DSH 模型菜单的「推理等级」行 | 「模型」面板的「推理等级」行 |
| 交互 | 拖动 / 右键设置 | 拖动 / 长按（桌面端右键）设置 |
| 色彩 | 蓝 `#4d93f8` → 紫 `#9333ea` → 深紫 `#4c1d95` | 同左 |
| 星尘 | 22 颗、黄金比相位、确定性伪随机、速度随位置 | 同左 |
| 动画 | 快速 / 简洁 / 完整，含 `1/3` 前进、`2/3` 后退的滞回 | 同左 |
| 设置键 | `dsh-codex-effort-slider.settings` | 同名键 |

Cordis / `ctx.slots` / `modelDirectories` 这些宿主接口没有移植（WebView 没有 Node 运行时），
数据写入口换成应用自己的 `setSettings`；界面与手感保持一致。

## 4. 运行

ES Modules 与 Service Worker 需要 HTTP 协议，**不能直接双击 `index.html`**。

```bash
cd dsh-mobile
python3 -m http.server 8099
# 打开 http://localhost:8099
```

或任意静态服务器（Nginx / Vercel / GitHub Pages）。

**装到 Android**：Chrome 打开后菜单 →「添加到主屏幕」。会以 standalone 模式启动，没有浏览器地址栏，支持离线打开壳。

## 5. 接入真实模型

设置 → 当前模型（或 对话页顶部状态芯片 → 连接模型）：

| 字段 | 示例 |
| --- | --- |
| API Key | `sk-…`（按服务分槽保存） |
| Base URL | `https://api.deepseek.com` |
| 模型 ID | `deepseek-chat` / `deepseek-reasoner` |
| 上下文窗口 | `128`（K，按模型单独保存） |

- 只保存在本机（工作区/资料库为真实文件，其余为 `localStorage`），不经过任何中间服务。
- 走 `POST {baseUrl}/chat/completions`，`stream: true`，支持 `reasoning_content` 与增量 `tool_calls`。
- 401 / 402 / 429 / 超时都有对应中文提示，不会只抛 `Failed to fetch`。
- **APK 内请求由原生 HTTP 桥（`DshHttpBridge`）发出**：绕开 WebView 的 CORS 与流式限制，任何 OpenAI 兼容网关（含 http 内网地址）都能直连；浏览器预览 / PWA 下回退 fetch，仍要求服务端允许 CORS。
- 发送前建议点一次「测试连接」；未添加模型或未配置 Key 时发送会直接报错并给出入口，不做任何模拟回答。

## 6. 没有连接模型时

首次打开是一个空工作区（只有一份 `README.md`），没有预置会话、没有预置任务，也没有本地演示内核。发送消息会直接提示：

- 未添加模型 → 「到设置 → 模型管理添加一个模型」
- 已添加但未填 Key → 「到设置 → 账号填好 API Key」

这样任何一条回答都必然来自你接入的真实模型，不会被脚本输出误导。

## 7. 架构

```
index.html
styles/    tokens.css  base.css  components.css  screens.css  effort.css
scripts/
  app.js       启动、SW 注册
  ui.js        外壳、路由、对话流、面板、事件代理
  screens.js   工作区 / 插件 / 任务 / 设置 / 抽屉
  runtime.js   Agent 主循环、SSE 解析、连通性测试、演示内核
  native-http.js  Android 原生 HTTP 流式桥的 JS 侧适配（无桥时回退 fetch）
  tools.js     工具注册表、虚拟 FS、权限与审批
  store.js     单一状态源、持久化、种子数据、逐模型参数与连接状态
  markdown.js  轻量 Markdown 渲染（先转义，白名单恢复 delta 标记）
  icons.js     24 视框描边图标
  office.js    DOCX / XLSX 生成（标准 OOXML）
  safety.js    执行前护栏规则
  effort-slider.js  Codex Effort Slider 的原生移植
  context.js   上下文 token 估算、按回合裁剪
  mcp.js       MCP Streamable HTTP 客户端（initialize / tools/list / tools/call）
sw.js          壳缓存，导航 stale-while-revalidate
android/       Capacitor 壳、原生桥 Java 源与一键构建脚本
vendor/        上游插件原始产物（MIT，仅溯源，不进 APK）
```

一次运行：

```
用户输入
  → 组装系统提示词（模式 / 权限 / 文件 / 插件）
  → 流式请求模型
  → 有 tool_calls？
      → 权限检查 → 审批 → 执行 → 结果写回上下文 → 继续
  → 无 tool_calls → 落到消息，写轨迹与用量
```

状态只有一个来源：`store.state`。UI 只读，动作只通过 `store` 的导出函数写入；写入后 `emit`，渲染层按视图粒度重绘。流式更新合并到 `requestAnimationFrame`，不会每个 token 重建整个消息列表。

## 8. 权限与安全

| 层 | 行为 |
| --- | --- |
| 权限 | 只读模式直接拒绝所有 `sensitive` 工具；`run_code` 的 SDK 写入也会二次检查 |
| 审批 | 写入 / 删除 / 终端 / 脚本 / 插件安装 / 定时任务 / 子 Agent 默认逐次询问 |
| 路径 | 统一正斜杠、去掉前导 `/`、折叠 `../`，禁止越出工作区 |
| 终端 | 不是真实 shell，只实现 `pwd ls cat echo date wc tree` 七条只读/回显命令 |
| 脚本 | 在 `AsyncFunction` 中执行，30s 超时；无网络、无 DOM，只能访问注入的 `dsh` SDK |
| 密钥 | 仅存本机；界面明确提示风险；不会进入演示内核与日志 |
| 注入 | Markdown 先全量转义，只恢复 `delta-up/down` 两种内容标记；链接限制为 http(s)/mailto |

## 9. Android 打包

**方案 A · PWA**：Chrome「添加到主屏幕」，立即得到独立窗口 + 离线壳。

**方案 B · APK**：`android/build-apk.sh` 一键把同一份 Web 运行时装进 Capacitor 7：

```bash
chmod +x android/build-apk.sh
ANDROID_HOME=~/Android/Sdk ./android/build-apk.sh
# → android/out/dsh-mobile-0.9.0-debug.apk
```

需要 Node 18+、JDK 17+、Android SDK 34。详见 [`android/README.md`](android/README.md)。

仓库内已附带构建好的 Debug 包：

| 项 | 值 |
| --- | --- |
| 文件 | `android/out/dsh-mobile-0.9.0-debug.apk`（根目录另有一份同名文件） |
| 包名 | `ai.deepseek.dsh.mobile` |
| 版本 | 0.9.0（versionCode 9） |
| 体积 | 3.9 MB |
| 签名 | Android Debug（可侧载，**不可直接上架**） |
| SHA-256 | `16ab2bf5f7a76cd6cbe8098e78c5c35f85fa632608beb3b9cb485ef39f60ec77` |

```bash
adb install -r android/out/dsh-mobile-0.9.0-debug.apk
```

> 原生 HTTP 桥（`DshHttpBridge`）随包注入：模型请求由系统网络栈发出，不受 WebView CORS 限制，并保留 SSE 逐字输出。
>
> 四个内置插件（DSH Office、CC Safety Net、Codex Effort Slider、DSH Ops）随 APK 打包，首次启动即启用，换设备重装也在。
>
> 启动图标使用 DeepSeek 官方黑鲸鱼（浅色底），应用内按主题使用白/黑鲸鱼；鲸鱼属于 DeepSeek 商标，本包为非官方个人构建，公开分发前请自行确认品牌授权。
>
> 该包使用 JDK 20 + Gradle 8.7 + Android SDK 34 构建。壳内加载的是同一份 `www` 资源，WebView 版本过低（< 90）时部分 CSS 与 Web Speech 能力会降级。

## 10. 交互地图

| 位置 | 手势 | 结果 |
| --- | --- | --- |
| 顶栏左 | 点按 | 打开会话抽屉 / 返回 |
| 顶栏右上 | 点按 | 运行轨迹、会话菜单、新建 |
| 上下文芯片 | 点按 | 切换工作区权限 / 模式 / 模型 |
| 模型面板滑条 | 拖动 | 连续调推理等级，越过档位边界即生效 |
| 模型面板滑条 | 长按 / 右键 | 滑条设置：动画三档、刻度点三档、复制诊断、恢复默认 |
| 消息工具卡 | 点按 | 展开参数、脚本、输出、diff |
| 运行摘要 | 点按 | 打开完整轨迹 |
| 输入框 | Enter / Shift+Enter | 发送 / 换行 |
| 输入框左侧 `+` | 点按 | 引用工作区文件（插入 `@path`） |
| 输入框键入 `/` | 输入 | 打开指令面板：新会话、切模式、清空、导出 |
| 插件开关 | 点按 | 热启用/卸载，立即影响工具装配 |
| 系统返回键 | 返回 | 先关审批/面板/抽屉，再退出 |

## 11. 交付自检

| 项 | 结果 |
| --- | --- |
| 展示字 / 正文字 | Noto Serif SC + Noto Sans SC + IBM Plex Mono，均不在禁用清单 |
| 对比度（实测） | 正文 16.98:1；次要 6.53:1；元信息 5.30:1；白字/主色 4.82:1；浅色次要 6.80:1 |
| 入场编排 | 首页 5 组错峰 70ms；视图切换 360ms；面板 360ms 上滑 |
| 降级动效 | `prefers-reduced-motion: reduce` 与设置里的「动效」开关都会关闭全部动画 |
| 氛围层 | 径向冷光 + SVG 噪点 + 桌面端纵向网格 |
| 状态覆盖 | 默认 / 悬停 / 按下 / 聚焦 / 禁用 / 加载 / 错误 / 空态 |
| 点击目标 | 主要控件 ≥ 44×44px；工具卡整行可点 |
| 尺寸 | 360 / 390 / 768 / 1440 无横向溢出，无构成崩坏 |
| 自动化扫描 | axe WCAG A/AA 在首页 / 模型面板 / 滑条设置 / 插件页 / 设置页均为 0 违规 |
| 滑条移植 | 完整 / 简洁 / 快速三档动画、1/3 前进与 2/3 后退滞回、键盘、长按设置均已自动化验证 |
| 模型路由 | 断点拦截实测：GPT-4.1 → `api.openai.com/v1`，自定义 → 手填网关，`model` 字段与目录一致 |
| 上下文裁剪 | 30 轮长会话 + 4K 窗口实测：压到 7 条消息、标注省略 28 轮、当前提问不重复 |
| 账号隔离 | DeepSeek / OpenAI / 自定义三套 Key 分别写入、切换模型后互不串用 |
| MCP | 本地模拟服务器实测：发现 2 个工具、schema 进入工具表、审批后 `echo` 返回 `echo: hi`、拒绝返回 denied |
| 工作区备份 | 导出 JSON 后再导入，文件列表与内容一致 |
| 页面设置 | 正文字号 0.92 / 1 / 1.1 与消息密度即时生效 |
| 原生状态栏 | 深色状态栏 + 浅色图标，WebView 不再叠加 safe-area 留白 |
| 键盘 | Tab 可达、`:focus-visible` 2px 描边、Esc 关闭浮层、Enter 发送 |
| 错误路径 | 401 已实测；断网 / 超时 / 参数解析失败均有中文回执 |

## 12. 已知边界

- **不是官方客户端**：与 DeepSeek 无隶属关系；协议 MIT。
- 终端是沙箱子集，不是真实 shell；文件保存在 App 专属目录（`Android/data/ai.deepseek.dsh.mobile/files/`），不是任意系统目录。
- 定时与后台任务是宿主桩，数据结构与界面完整，真正的到点执行需要原生调度器。
- 移动端一次只跑一个前台会话；切换会话不会中断正在进行的运行，但界面只更新当前会话。
- 官方「智能体团队」「自动审批复核」目前是插件位，未接模型复核逻辑。
- DSH Office 支持 `.docx` / `.xlsx`，PPT 尚未实现；护栏是基于模式的保守拦截，不是权限沙箱。
- `Codex Effort Slider` 是上游 1.1.2 的**原生移植**，不是 Cordis 插件包；上游依赖 Node 运行时，Android WebView 无法直接加载。
- 上下文裁剪是字符级估算，不是精确 tokenizer；裁剪以完整回合为单位，可能比预算更保守。
- 目录只覆盖 OpenAI 兼容协议；Claude 官方、Gemini 等需要各自的兼容网关，走「自定义模型」。
- **没有官方账号登录 / 云同步**：这不是漏做，而是没有官方 OAuth 与后端；API Key 模式可用，但订阅、账单、跨设备同步不在本应用内。
- MCP 只支持 Streamable HTTP；stdio / 本地进程型服务器、OAuth 授权流程未实现。
- 应用内代理不生效，跟随 Android 系统代理；真实设备目录映射、后台推送需要 Capacitor 原生插件。
- 完成提醒是尽力而为：应用在前台/刚回到前台时可靠，真正的后台推送需要原生通知调度。
- Key 与 MCP Token 以明文存放在本机 localStorage，适合个人侧载，不适合共享设备。

**下一步**：原生文件系统映射 → WorkManager 后台执行 → 通知 → 团队看板 → 自动审批复核。

## License

MIT.

`Codex Effort Slider` 的界面、几何、色彩、粒子与运动参数移植自
[`Microqian2th/dsh-codex-effort-slider`](https://github.com/Microqian2th/dsh-codex-effort-slider) 1.1.2，
上游同样以 MIT 发布；原始产物与许可见 `vendor/dsh-codex-effort-slider/`。
