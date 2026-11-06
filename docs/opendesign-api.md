# OpenDesign API 接入调研（2026-11-04）

> 起因：0.66.0 之前项目里的 `opendesign` 供应商被写成了「本机 127.0.0.1:5712
> 的 od proxy，不校验 Key」—— 方向完全错了。本文是重新接入时收集的原始资料，
> 记录**事实、出处、以及本项目据此做了什么 / 没做什么**。

## 先分清两个同名但无关的东西

| 名称 | 是什么 | 与本项目有关吗 |
| --- | --- | --- |
| `open-design.ai` / `nexu-io/open-design` | 本地优先的 AI 设计工作空间，同时提供 **Cloud 订阅模型 API** | ✅ 就是它 |
| `opendesign.cc` | 设计参考目录（1,400 套设计系统），提供 MCP / `catalog.json` | ❌ 完全不同的项目，别按它接 |

搜索时这两者会混在一起。提到 `od mcp install`、`/api/projects/:id/chat`、
`catalog.json`、`search_designs` 的都是前者的工作空间或后者，**不是模型 API**。

## 核心结论：订阅制云端网关，两个平面

OpenDesign Cloud 提供的是「把套餐额度接给外部 Agent」的模型服务，
不是本机进程。凭据与额度分属两个平面：

| 平面 | 主机 | 用途 | 凭据 |
| --- | --- | --- | --- |
| 推理（Model） | `https://amr-link.open-design.ai/v1` | `GET /models`、`POST /chat/completions`、`/responses` | `sk-amr-…` runtimeKey，`Authorization: Bearer` |
| 账户（Control） | `https://amr-api.open-design.ai` | 钱包余额、套餐、5h / 7d 额度窗口 | `vela_ctrl_…` controlKey，`Authorization: Bearer` |

账户面已确认的具体端点：

- `GET https://amr-api.open-design.ai/api/v1/wallet/balance` → `balanceUsd`
- `GET https://amr-api.open-design.ai/api/v1/billing/summary` → `membershipTier`、
  `subscriptionStatus`、`balances.subscriptionCredits`、`balances.rechargeCredits`

**本项目只接推理平面**，账户/额度不在这一版范围。

## 接入条件（官方）

- 套餐：**Go / Plus / Pro / Max 可用，Free 免费套餐不支持**。
- Key：登录网页账户，左侧 **API keys** 创建；可在
  [Cloud 控制台](https://open-design.ai/cloud/dashboard) 管理与看用量。
- 官方 **Connection setup** 让用户在三种 API 格式里选并复制对应 base URL，
  明确写着「**接入地址和协议必须匹配**」：Chat Completions、Responses、Messages。
- 一键配置通过 CC Switch 导入 Claude Code / Codex / Grok Build / OpenCode /
  OpenClaw / Hermes Agent；每次导入新建一把 Key，不能复用已有 Key。
- 可用模型**以账户当前 Model 列表为准**，截图不代表所有套餐。
- API 与应用内**共用同一份额度与用量窗口**，多建 Key 不会重置。
- 单次请求体上限 **50 MiB**（是整个请求，不是单张图片）。

> ⚠️ 官方帮助页没有逐字印出三个 base URL（它们在 Connection setup 的截图里）。
> 下面的具体地址来自第三方源码 / issue 交叉印证，已标注出处。

## 已交叉印证的地址

| 协议 | Base URL | 出处 |
| --- | --- | --- |
| Chat Completions | `https://amr-link.open-design.ai/v1` | [magpie#897](https://github.com/yetone/magpie/issues/897)、[open-design#8967](https://github.com/nexu-io/open-design/issues/8967) |
| Anthropic Messages | `https://amr-link.open-design.ai`（路由到 `/v1/messages`） | [magpie#2124](https://github.com/yetone/magpie/issues/2124) |
| Responses | 官方称支持，`/responses` 在 `amr-link` 上 | [opencode-opendesign-auth](https://npm.io/package/opencode-opendesign-auth) |

`magpie#897` 的完整描述：从 `~/.amr/config.json` 的 `profiles.prod` 读
`controlKey` / `runtimeKey`；调用 AI 用 `runtimeKey`、`GET /models` 拉列表、
`POST /chat/completions` 发 `model` / `messages` / `stream`。

登录态的另一种拿法（本项目不做）：`POST /api/v1/cli/device-authorizations`
拿 code，去 `open-design.ai/cloud/cli/activate?…` 批准，轮询后同时拿到
control + runtime 两把 Key。这是 `vela login` 的设备授权流程。

## Go 套餐的 12 个模型

来自 [`dsh-opendesign-go` 的 `docs/models.md`](https://github.com/EliteOtaku/dsh-opendesign-go/blob/main/docs/models.md)
（静态表 `GO_DESIGN_PLAN_MODELS`，并逐条注明厂商文档出处）。**只作参考，不要硬编码进预设**——
套餐不同可用模型不同，官方明确以 `GET /v1/models` 实时列表为准。

| ID | 上下文 | 输出上限 | 图片 |
| --- | --- | --- | --- |
| `deepseek-v4.1-flash` | 1,000,000 | 384,000 | ✅ |
| `deepseek-v4-flash` | 1,000,000 | 384,000 | ✅ |
| `deepseek-v4-flash-vision-exp` | 1,000,000 | 384,000 | ✅ |
| `deepseek-v4-pro` | 1,000,000 | 384,000 | — |
| `claude-haiku-5.5` | 1,000,000 | 128,000 | ✅ |
| `gpt-6-luna` | 1,050,000 | 128,000 | ✅ |
| `glm-5.3-flash` | 1,000,000 | 128,000 | ✅ |
| `glm-5.3-flashx` | 1,000,000 | 128,000 | ✅ |
| `kimi-k2.7-code` | 262,144 | 262,144 | ✅ |
| `mimo-v2.6-flash` | 1,000,000 | 128,000 | ✅ |
| `mimo-v2.6-pro` | 1,000,000 | 128,000 | ✅ |
| `hy4-preview` | 1,000,000 | 64,000 | — |

两个容易踩的点：

- **输入与输出共用窗口**。网关判据是 `输入 + max_tokens ≤ 窗口`，直接把
  `max_tokens` 报成 384,000 会在输入刚过六成时被拒。该插件报给宿主的
  `contextWindow` 是「输入预算」`窗口 − max(输出上限, 窗口/4)`，1M + 384K 的模型报 750,000。
- **图片**：声明了 `image` 模态的模型才发图片字节，用 `image_url` 内容块；
  纯文本模型收到占位文本。工具读到的图放到紧随其后的 `user` 消息里
  （`tool` 角色带 `image_url` 会被中间层静默丢弃）。

`kimi-k2.7-code` 对**工具消息**里的图片会答「无法读取此图」，直接贴图正常。

## 本项目据此改了什么（0.67.0）

| 项 | 旧（错误） | 新 |
| --- | --- | --- |
| 定位 | 本机 5712 的 od proxy | `open-design.ai` 云端订阅网关 |
| Base URL | `http://127.0.0.1:5712/v1` | `https://amr-link.open-design.ai/v1` |
| 凭据 | `local: true` + 占位符 `od-local`，界面显示「无需 Key」 | 必须填 `sk-amr-…` 真 Key，未配置就如实显示「未配置 Key」 |
| 模型 | 硬编码 `claude-sonnet-4-5` / `deepseek-chat` | `suggest: []`，填 Key 后走 `GET /v1/models` 探测 |
| 协议 | 只有 OpenAI 兼容 | 默认 Chat Completions；端点场景 chip 可一键切 Messages（同时换地址与格式） |
| 控制台 | 空 | `https://open-design.ai/cloud/dashboard` |
| 上下文 | 200K（碰巧接近，但理由是错的） | 200K 保守裁剪默认值，说明「网关 1M 且输入输出共用预算，可改」 |

配套改动：端点场景 chip 新增 `data-format`，点 chip 时同步切
`#cm-format` 与开关置灰状态 —— 否则换了地址没换协议会打出 404。

## 0.68.0 修正：显示名 ≠ 模型 ID，以及端点实测

0.67.0 上线后用户实测回报「连接失败 HTTP 404，自动拉取的模型 ID 一看就不对、也不全」。
排查结论：**地址和端口一直是对的，坏的是模型 ID**。

### 匿名探测端点（不带任何凭据，2026-11-04）

| 请求 | 结果 | 说明 |
| --- | --- | --- |
| `GET https://amr-link.open-design.ai/v1/models` | `401 {"error":{"code":"missing_api_key",...}}` | 路径存在，鉴权正常 |
| `GET https://amr-link.open-design.ai/v1/chat/completions` | `405` | 路径存在，只收 POST |
| `GET https://amr-link.open-design.ai/models` | `404` nginx HTML | 少了 `/v1` |
| `GET https://amr-link.open-design.ai/` | `404` nginx HTML | 根路径本就不提供内容 |

所以 `baseURL = https://amr-link.open-design.ai/v1` 与官方插件
`dsh-opendesign-go` 的默认配置一致，**标准 HTTPS 443，没有非标端口**，
历史文档里 `127.0.0.1:5712` 那套已彻底清掉。官方帮助页也特别提示
「不能通过填写截图中的模型名绕过权限」—— 模型名（显示名）不是可发送的 ID。

### 根因

`formats.js` 的 `parseOpenAIModelIds` 里 `m.id || m.name || m.model`：
只要上游条目没有 `id`（或 `id` 为空），就把 `name` 当成 ID。
OpenDesign 的 `/v1/models` 给出的 `name` 是 `deepSeek V4.1 Flash` 这种显示名，
于是它被原样写进 `model.apiModel`，发到 `/chat/completions` 时网关找不到模型，
回 **404**。同时响应容器只认 `data` 一层，嵌套一层就整个列表变空，看着「不全」。

一手源码 `dsh-opendesign-go/src/catalog.ts` 的 `CatalogModel` 正好是
`{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }` —— 两个字段并存，
这也解释了为什么混淆如此容易发生。

### 修法（不依赖对 `/v1/models` 具体字段的猜测）

带 Key 的真实响应**没有实测**（排查时未使用用户截图中露出的 Key），
所以解析做成了覆盖多种形状的稳健版，而不是照着某一份样例硬编码：

1. **解析层**：`id` 只认 `id / model_id / modelId / slug / model` 里符合
   `[A-Za-z0-9._:/+@-]+` 的值；`name / display_name / label / title` 一律只做 `label`。
   只有 `name` 本身就是合法 slug 时才当 ID。容器递归找
   `data / models / result / response / items / list / results`，多个数组合并。
2. **反查层**：`store.js` 内置官方 12 个 `{id, label}`，把显示名纠正回真实 ID；
   反查不到的显示名直接丢弃，绝不让它进请求体。
3. **收口层**：`fetchModelList` 加 `providerKey`，返回前统一过一遍
   `resolveDiscoveredModels`，UI 拿到的必然是能直接发的 ID，且保序。
4. **老数据迁移**：`load()` 里按 `providerKey` 或 `amr-link.open-design.ai`
   端点识别，把已存坏的 `apiModel` 就地纠正、`label` 换成可读名，
   并清掉那条由坏 ID 造成的「连接失败 404」状态。
5. **兜底**：`suggest` 给 12 个核实过的参考 ID（常用模型区，点一下即填），
   探测失败或只返回部分时用户仍有正确 ID 可用；不冒充实时列表。
6. 404 提示改写为「要填 ID，不是显示名」，模型参数页的 hint 同步。

### 仍未实测

- 带有效 Key 的 `GET /v1/models` 真实 JSON 字段名。上面的解析覆盖常见命名，
  但若上游用了完全不同的字段，探测会显示「列表为空」—— 此时常用模型区的
  12 个参考 ID 仍可直接点用。
- Messages 场景（Anthropic 格式）下的 `/v1/models` 鉴权组合。

## 明确没做的

1. **账户/额度平面**（`amr-api` + controlKey + `vela` CLI）：需要另一把凭据，
   与模型请求不是一套鉴权，这版不碰。
2. **Responses API**：`formats.js` 目前只有 openai / anthropic / gemini / ollama
   四种适配器，没有 Responses。官方支持但我们没接。
3. **设备授权登录**：需要浏览器批准页，手机端做不了。
4. **每模型上下文 / 输出上限静态表**：与「以 /models 实时列表为准」冲突，
   不引入。用户可在模型参数里单独改。
5. **图片模态自动门控**：这期图片仍只走 OpenAI `image_url`，非 OpenAI 格式置灰。
6. **Messages 场景下的模型探测未实测**：`formats.js` 的 Anthropic 适配器会带
   `x-api-key` / `anthropic-version` 打 `/v1/models`，网关是否接受这套组合没有验证过。
    Messages 场景的**对话**有第三方 issue 佐证（magpie#2124），列表探测没有。
   真遇到探测失败，在「模型 ID」里手填即可，不影响发请求。

## 来源清单

**一手（官方）**

- [将 OpenDesign Cloud API 接入外部工具](https://open-design.ai/zh/help/cloud-api/)
- [选择 AI 接入方式](https://open-design.ai/zh/help/connect-models)
- [三步把 OpenDesign 套餐接入你的 Agent（官方教程）](https://open-design.ai/zh/tutorials/open-design-one-click-agent-setup/)
- [Cloud 控制台](https://open-design.ai/cloud/dashboard)

**技术细节（第三方源码 / issue，用于补齐官方截图里的地址）**

- [magpie#897 对接 OpenDesign 订阅](https://github.com/yetone/magpie/issues/897)
- [magpie#2124 Messages 协议接入](https://github.com/yetone/magpie/issues/2124)
- [open-design#8967 网关 503/500 报告](https://github.com/nexu-io/open-design/issues/8967)
- [opencode-opendesign-auth（两个平面与设备授权）](https://npm.io/package/opencode-opendesign-auth)
- [`dsh-opendesign-go` docs/models.md（12 个模型）](https://github.com/EliteOtaku/dsh-opendesign-go/blob/main/docs/models.md)
- [dsh-opendesign-go 综述（夜雨飘零，2026-10-22）](https://blog.yeyupiaoling.cn/article/1792633810851?lang=zh-cn)
