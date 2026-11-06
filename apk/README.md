# 安装包

安装包不再入库，改由 **GitHub Releases** 分发（体积三十多 MB，放在 Release 里更合适，
也便于按版本归档）。

| 版本 | 下载 |
|---|---|
| **v0.84.0**（当前，versionCode 161） | [dsh-mobile-0.84.0-debug.apk](https://github.com/hbgdjb/dsh-mobile/releases/download/v0.84.0/dsh-mobile-0.84.0-debug.apk) |

全部版本见 <https://github.com/hbgdjb/dsh-mobile/releases>。

> 历史安装包（v0.12.4 / v0.21.6 / v0.38.0 / v0.49.0）曾直接放在本目录，
> 现已移除，可在 git 历史里找回：`git log --diff-filter=D -- apk/`

## 安装

1. 从 Releases 下载 APK 传到手机安装
2. 首次使用需授予「悬浮窗」权限（`SYSTEM_ALERT_WINDOW`），悬浮状态窗与 DSH 小球依赖它
3. 进入应用后在「设置 → 账号 / 模型」里填入自己的模型 API Key
4. 想用内置输入法（DSH 键盘）：系统设置 → 语言与输入法 → 启用「DSH 键盘」

## 基本信息（v0.84.0）

| 项 | 值 |
|---|---|
| 包名 | `ai.deepseek.dsh.mobile` |
| versionCode / versionName | 161 / 0.84.0 |
| minSdk / targetSdk | 24 / 34 |
| ABI | `arm64-v8a`（内嵌 Node 运行时：`libdshnode.so`；另含 `libvosk.so`、`libjnidispatch.so`、`libc++_shared.so`） |
| 权限 | `INTERNET`、`SYSTEM_ALERT_WINDOW`、`POST_NOTIFICATIONS`、`RECORD_AUDIO`、`VIBRATE`、`ACCESS_NETWORK_STATE`、`WAKE_LOCK`、`KILL_BACKGROUND_PROCESSES`、`FOREGROUND_SERVICE(_DATA_SYNC)`、`FOREGROUND_SERVICE_MEDIA_PROJECTION`、`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`、`moe.shizuku.manager.permission.API_V23` |
| SHA256 | `39b533cdcac163a75ff094d8e6dc9cccd8c915fbc875b3af011b6ff3dcce3aec` |
| MD5 | `003a829173fac47938924b0a6b73ffcc` |
| 大小 | 35.28 MB |

> 为 `assembleDebug` 产物（`debuggable=true`）。`libnode.so` 仍为按需下载，未进包。
> 体积从 v0.53.0 的 15.5 MB 增至 35.3 MB，主要是内置输入法的离线资源：
> PP-OCRv5 手写模型（`ppocrv5.ort`，15.9 MB）与 onnxruntime-web WASM（11.3 MB）。
