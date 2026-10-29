# 安装包

安装包不再入库，改由 **GitHub Releases** 分发（体积十几 MB，放在 Release 里更合适，
也便于按版本归档）。

| 版本 | 下载 |
|---|---|
| **v0.53.0**（当前，versionCode 123） | [dsh-mobile-0.53.0-debug.apk](https://github.com/hbgdjb/dsh-mobile/releases/download/v0.53.0/dsh-mobile-0.53.0-debug.apk) |

全部版本见 <https://github.com/hbgdjb/dsh-mobile/releases>。

> 历史安装包（v0.12.4 / v0.21.6 / v0.38.0 / v0.49.0）曾直接放在本目录，
> 现已移除，可在 git 历史里找回：`git log --diff-filter=D -- apk/`

## 安装

1. 从 Releases 下载 APK 传到手机安装
2. 首次使用需授予「悬浮窗」权限（`SYSTEM_ALERT_WINDOW`），悬浮状态窗与 DSH 小球依赖它
3. 进入应用后在「设置 → 账号 / 模型」里填入自己的模型 API Key

## 基本信息（v0.53.0）

| 项 | 值 |
|---|---|
| 包名 | `ai.deepseek.dsh.mobile` |
| versionCode / versionName | 123 / 0.53.0 |
| minSdk / targetSdk | 24 / 34 |
| ABI | `arm64-v8a`（内嵌 Node 运行时：`libdshnode.so`；另含 `libvosk.so`、`libjnidispatch.so`、`libc++_shared.so`） |
| 权限 | `INTERNET`、`SYSTEM_ALERT_WINDOW`、`POST_NOTIFICATIONS`、`RECORD_AUDIO`、`VIBRATE`、`ACCESS_NETWORK_STATE`、`WAKE_LOCK`、`KILL_BACKGROUND_PROCESSES`、`FOREGROUND_SERVICE(_DATA_SYNC)`、`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`、`moe.shizuku.manager.permission.API_V23`（自 v0.38.0 起未变） |
| SHA256 | `80eb0dab3326f83d7a6c1f5a929aaeb3816569c230da079d281c868e185f824b` |
| 大小 | 15.53 MB |

> 为 `assembleDebug` 产物（`debuggable=true`）。`libnode.so` 仍为按需下载，未进包。
