# Android 壳工程

这里不是另一套 UI，而是把 `../` 的 Web 运行时（同一份 HTML/CSS/JS）装进 Android WebView 的最小壳。UI、内核、数据层与浏览器版完全一致，改一处两边同时生效。

## 为什么用 Capacitor

- **WebView 复用**：DSH Mobile 的运行时是纯前端，Capacitor 只负责原生外壳、状态栏、返回键与安装包。
- **可替换**：如果后续要接原生 API（剪贴板、通知、后台任务、文件系统），通过 Capacitor 插件补齐即可，不需要重写界面。
- **可退出**：删掉 `android/` 目录，`../index.html` 仍是一个完整的 PWA。

## 环境要求

| 依赖 | 版本 |
| --- | --- |
| Node.js | ≥ 18 |
| JDK | 17+（实测 20） |
| Android SDK | Platform 34 + Build-Tools 34 |
| Gradle | 随 capacitance 工程自带 wrapper |

需要设置 `ANDROID_HOME`，并接受 SDK licenses：

```bash
yes | sdkmanager --licenses
```

## 构建

```bash
chmod +x android/build-apk.sh
ANDROID_HOME=~/Android/Sdk ./android/build-apk.sh
# 国内网络默认走腾讯 Gradle 镜像 + 阿里云 Maven；如需官方源：
MIRROR=0 ./android/build-apk.sh
```

脚本会：

1. 把 `index.html`、`styles/`、`scripts/`、`icons/`、`manifest`、`sw.js` 复制到 `android/.build/www`
2. 安装 Capacitor 6
3. `npx cap add android` / `npx cap sync android`
4. 用 Gradle 产出 Debug APK
5. 复制到 `android/out/dsh-mobile-debug.apk`

安装到设备：

```bash
adb install -r android/out/dsh-mobile-debug.apk
```

## 已构建产物

`android/out/dsh-mobile-0.8.0-debug.apk`（3.9 MB，`ai.deepseek.dsh.mobile` 0.8.0，debug 签名）可直接侧载。构建时会把 `android/res/` 下的品牌图标覆盖到生成的工程，因此启动器图标与 PWA 图标一致。

## 签名与发布

Debug APK 使用调试签名，可以直接侧载测试。发布到应用商店需要：

```bash
keytool -genkey -v -keystore dsh-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias dsh
```

然后在 `android/app/build.gradle` 里配置 `signingConfigs.release`，执行 `./gradlew assembleRelease`。

## 原生能力对接（可选）

| 能力 | 建议插件 | 对 UI 的影响 |
| --- | --- | --- |
| 状态栏配色 | `@capacitor/status-bar` | 把状态栏设为 `#08090b`，图标用浅色 |
| 返回键 | 已用 History API 处理浮层 | 无需改动 |
| 分享 / 导出 | `@capacitor/share` | 替换 `downloadJSON` 的浏览器实现 |
| 本地文件 | `@capacitor/filesystem` | 把 `store.files` 映射到真实目录 |
| 通知 | `@capacitor/local-notifications` | 定时任务到点提醒 |
| 后台执行 | 原生 WorkManager | 替代当前的后台任务桩 |

## 已知限制

- WebView 里没有 Node 运行时，因此 `shell` 工具是内置的沙箱命令子集（`pwd/ls/cat/echo/date/wc/tree`），不是真实 shell。
- 后台任务与定时计划在 Web 版是宿主桩：数据结构、历史与开关是真的，真正的到点执行需要原生调度器（见上表）。
- 语音输入依赖 WebView 的 Web Speech API，部分国产 ROM 不带该能力。
- 模型请求受 CORS 限制；如果目标网关不放行，请在壳内改用 Capacitor HTTP 插件转发。
