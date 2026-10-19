# DSH Mobile

> **Model + Harness = Agent** —— 把桌面级 AI Agent 的完整能力装进一部手机。

DSH Mobile（当前版本 **0.12.4**）是 **DeepSeek Harness** 的 Android 移动端宿主应用。

---

## 它是什么

一个**纯前端运行时**（HTML / CSS / 原生 ES Modules，**无构建步骤**）的 AI Agent 应用，通过 **Capacitor** 打包为 Android APK。

用户接入自己的模型 API Key（支持 DeepSeek、智谱 GLM、通义千问、豆包、Kimi、MiniMax、OpenAI 等十余家供应方），即可获得一个**会思考、会调用工具、会请求授权**的移动 Agent。

---

## 核心特性

### 🤖 多模型管理
添加任意 OpenAI 兼容模型，一键获取端点模型列表、测试连接、按模型单独保存参数与上下文窗口（自动识别 DeepSeek / GLM 等 **1M 大窗口**模型）。

### 🔁 完整 Agent 循环
多步推理、工具调用、MCP 服务器接入、子任务派生，**每一步可视化**。

### ✅ 工具审批
敏感操作弹出审批卡片，可选「**仅此一次 / 自动放行**」。

### 🪟 悬浮状态窗
在其他应用上方显示 Agent 实时状态（思考中 / 执行工具 / 等待审批），可拖动、贴边、伸缩。

### 🔵 DSH 小球
悬浮窗里有一颗移植自开源项目 [agent-hud-open](https://github.com/) 的动画小球——蓝球白肚皮、一双会交叉的眼睛：

| 状态 | 表现 |
|---|---|
| 待命 | 呼吸 + 眨眼 |
| 思考 | 头顶冒「…」 |
| 完成 | 笑眼 |
| 失败 | 摇头 + 打叉 |
| 点击 | 打招呼 |

### 📱 移动端适配
语音输入、触屏审批、上下文自动裁剪（**预留 28% 给输出**，防止超窗报错）、离线可用的 PWA。

---

## 安装

直接下载仓库里的 APK 安装即可：

**[DSH-Mobile-0.12.4.apk](./DSH-Mobile-0.12.4.apk)**（3.9 MB）

| 项 | 值 |
|---|---|
| 包名 | `ai.deepseek.dsh.mobile` |
| 版本 | versionCode `26` / versionName `0.12.4` |
| minSdk / targetSdk | 22 / 34 |
| 应用名 | DSH |

**所需权限：**

| 权限 | 用途 |
|---|---|
| `INTERNET` | 访问模型 API |
| `SYSTEM_ALERT_WINDOW` | 悬浮状态窗 + DSH 小球 |
| `POST_NOTIFICATIONS` | 状态通知 |
| `VIBRATE` | 交互反馈 |

> ⚠️ 悬浮功能需要在系统设置里为 DSH 授予「后台弹出界面 / 悬浮窗」权限。

---

## 技术栈

```
前端运行时   HTML / CSS / 原生 ES Modules（无构建步骤）
打包         Capacitor → Android APK
支持协议     OpenAI 兼容 API / MCP
```

`capacitor.config.json` 关键配置：

```json
{
  "appId": "ai.deepseek.dsh.mobile",
  "appName": "DSH",
  "webDir": "www",
  "server": { "androidScheme": "https" },
  "android": {
    "backgroundColor": "#08090b",
    "allowMixedContent": false,
    "captureInput": true
  }
}
```

---

## 许可

待补充。
