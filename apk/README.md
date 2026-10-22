# 安装包

| 文件 | 版本 | 说明 |
|---|---|---|
| `DSH-Mobile-0.38.0.apk` | **v0.38.0**（versionCode 94） | 与当前源码版本一致 |

> 旧版本（v0.12.4 / v0.21.6）已从仓库移除，需要的话可在 git 历史里找回：
> `git log --diff-filter=D -- apk/`

## 安装

1. 下载 APK 传到手机安装
2. 首次使用需授予「悬浮窗」权限（`SYSTEM_ALERT_WINDOW`），悬浮状态窗与 DSH 小球依赖它
3. 进入应用后在「设置 → 账号 / 模型」里填入自己的模型 API Key

## 基本信息

| 项 | 值 |
|---|---|
| 包名 | `ai.deepseek.dsh.mobile` |
| versionCode / versionName | 94 / 0.38.0 |
| minSdk / targetSdk | 24 / 34 |
| ABI | `arm64-v8a`（内嵌 Node 运行时，含 `libdshnode.so`） |
| 权限 | `INTERNET`、`SYSTEM_ALERT_WINDOW`、`POST_NOTIFICATIONS`、`RECORD_AUDIO`、`VIBRATE`、`ACCESS_NETWORK_STATE`、`WAKE_LOCK`、`KILL_BACKGROUND_PROCESSES`、`FOREGROUND_SERVICE(_DATA_SYNC)`、`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`、`moe.shizuku.manager.permission.API_V23` |
| MD5 | `7492e4a393f1346e18b34c7dcf407f5a` |
| 大小 | 15.36 MB |

> v0.38.0 起新增本地语音识别（Vosk，故需 `RECORD_AUDIO`）与
> Shizuku 提权执行支持（`moe.shizuku.manager.permission.API_V23`），
> 以及内嵌 Node.js 运行时（Android 侧体积由 4.2 MB 增至 15.4 MB 的主因）。
