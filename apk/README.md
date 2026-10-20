# 安装包

| 文件 | 版本 | 说明 |
|---|---|---|
| `DSH-Mobile-0.12.4.apk` | v0.12.4 | 旧构建，**低于当前源码版本 v0.16.1** |

> ⚠️ 这个 APK 是早期构建产物，功能比当前源码少（源码已到 v0.16.1）。
> 想要最新版本，请按 [`../README.md`](../README.md) 第 9 节「Android 打包」从源码自行构建，
> 或等这里更新。

## 安装

1. 下载 APK 传到手机安装
2. 首次使用需授予「悬浮窗」权限（`SYSTEM_ALERT_WINDOW`），悬浮状态窗与 DSH 小球依赖它
3. 进入应用后在「设置 → 账号 / 模型」里填入自己的模型 API Key

## 基本信息

| 项 | 值 |
|---|---|
| 包名 | `ai.deepseek.dsh.mobile` |
| versionCode | 26 |
| minSdk / targetSdk | 22 / 34 |
| 权限 | `INTERNET`、`SYSTEM_ALERT_WINDOW`、`POST_NOTIFICATIONS`、`VIBRATE` |
