# 安装包

| 文件 | 版本 | 说明 |
|---|---|---|
| `dsh-mobile-0.49.0-debug.apk` | **v0.49.0**（versionCode 119） | 与当前源码版本一致，debug 构建 |

> 旧版本（v0.12.4 / v0.21.6 / v0.38.0）已从仓库移除，需要的话可在 git 历史里找回：
> `git log --diff-filter=D -- apk/`

## 安装

1. 下载 APK 传到手机安装
2. 首次使用需授予「悬浮窗」权限（`SYSTEM_ALERT_WINDOW`），悬浮状态窗与 DSH 小球依赖它
3. 进入应用后在「设置 → 账号 / 模型」里填入自己的模型 API Key

## 基本信息

| 项 | 值 |
|---|---|
| 包名 | `ai.deepseek.dsh.mobile` |
| versionCode / versionName | 119 / 0.49.0 |
| minSdk / targetSdk | 24 / 34 |
| ABI | `arm64-v8a`（内嵌 Node 运行时：`libdshnode.so`；另含 `libvosk.so`、`libjnidispatch.so`、`libc++_shared.so`） |
| 权限 | `INTERNET`、`SYSTEM_ALERT_WINDOW`、`POST_NOTIFICATIONS`、`RECORD_AUDIO`、`VIBRATE`、`ACCESS_NETWORK_STATE`、`WAKE_LOCK`、`KILL_BACKGROUND_PROCESSES`、`FOREGROUND_SERVICE(_DATA_SYNC)`、`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`、`moe.shizuku.manager.permission.API_V23`（与 v0.38.0 一致，无新增） |
| MD5 | `e366d139ababd70f1d768e509cb2385c` |
| 大小 | 15.49 MB |

> 本版为 `assembleDebug` 产物（`debuggable=true`），与 v0.38.0 的构建方式相同。
> v0.49.0 起打通插件生态：迷你 cordis 容器、Node 侧 llm/hmr 服务、插件市场
> （公开目录 3000+ 条）与 npm 依赖安装；原生侧新增 DSH 小球视图（DshBotView）
> 与 Agent 运行时保活（DshKeepAliveService）。体积 15.36 → 15.49 MB
> （新增 `libjnidispatch.so`），`libnode.so` 仍为按需下载，未进包。
