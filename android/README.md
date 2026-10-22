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
| 本机 MCP | 已内置（`android/java/DshMcp*.java`） | 提供 21 个手机本机工具给 App 内的 Agent |

## 本机 MCP（已内置）

`android/java/` 下的 `DshMcpServer` / `DshMcpTools` / `DshMcpPolicy` / `DshMcpBridge` / `DshMcpBootstrap` / `DshA11yService` 构成一个完整的本机 MCP 服务，随 APK 一起打包。

| 文件 | 职责 |
| --- | --- |
| `DshMcpServer.java` | `ServerSocket` + 手写 HTTP/1.1 + JSON-RPC 2.0，监听 `127.0.0.1:8788`，协议版本 `2024-11-05` |
| `DshMcpTools.java` | 21 个工具的实现，含白名单校验 |
| `DshMcpPolicy.java` | 白名单策略的唯一权威实现（SharedPreferences `dsh_mcp_policy`） |
| `DshMcpBridge.java` | JS ↔ 原生桥，暴露 `window.DshMcp` |
| `DshMcpBootstrap.java` | ContentProvider 启动钩子（比 `Application.onCreate()` 更早，且不碰 MainActivity） |
| `DshShizuku.java` | Shizuku 通道客户端：状态机、授权、UserService 连接、`uiautomator` XML 解析 |
| `DshShizukuService.java` | 跑在 shell 进程里的执行体（`extends IShizukuExec.Stub`） |
| `DshDeviceService.java` | `:device` 进程入口，负责启停 MCP server |
| `DshStatus.java` | 设备侧状态快照（只在 `:device` 采集，主进程走 HTTP 读） |
| `DshA11yDiagnostics.java` | 诊断日志（名字沿用历史，现在是通用日志） |

三层收口：

1. **默认关闭** —— 服务不随应用启动监听端口，需在「设置 → 本机控制」里手动开启。
2. **白名单收口** —— 用户逐个勾选允许控制的应用；`app_*` 与 `ui_*` 工具只对白名单内的应用生效，拒绝时把白名单回传给模型。
3. **最小权限** —— 不申请 `QUERY_ALL_PACKAGES`，只靠 manifest 的 `<queries>` intent 过滤器列出有启动入口的应用。

## 插件系统（0.22.0 新增）

插件的沙箱隔离是**纯 Web 层**的，不依赖任何原生能力 —— `sandbox="allow-scripts"` 的 iframe 在 WebView 里同样是不透明源，跨源访问照样 `SecurityError`。

但**「从任意 URL 安装插件」这一步必须走原生**，原因是 CORS：

| 环节 | 浏览器 / PWA | APK |
| --- | --- | --- |
| 拉插件清单 | `fetch`，只能同源或对方放行 CORS | `DshHttpBridge` → 原生 `HttpURLConnection`，不受同源策略约束 |
| 插件代码执行 | iframe 沙箱 | 同一个 iframe 沙箱 |
| 插件文件读写 | IndexedDB（工作区） | 原生文件（`DshFsBridge`），路径同样在沙箱外 |

`DshHttpBridge` 里有一处必须注意：`HttpURLConnection.setDoOutput(true)` 会把 **GET 悄悄改成 POST**（JDK 实现如此）。插件清单拉取必须是真 GET，所以那里改成了 `conn.setDoOutput(hasBody)` —— 少了这个改动，「填 URL 装插件」在 APK 里会莫名其妙地全部 405 / 解析失败。

原生侧只新增了「GET 一个纯文本资源」这一个能力（`nativeGetText`），没有为插件系统新增任何权限声明。插件的 `net` 能力走的是 WebView 侧的 `fetch`，受 CORS 限制 —— 插件要访问的第三方接口需要自己放行 CORS。

插件的代码存工作区文件 `plugins/<id>/main.js`，在 APK 里就是真实磁盘目录（`DshFsBridge` 的 workspace 根），随应用数据一起被系统清理。

## 语音输入（0.23.0 新增）

### 为什么必须写原生桥

旧实现只有一行判断：

```js
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) { toast("此设备不支持语音输入", "err"); return; }
```

**Android WebView 里这两个对象都不存在。** Web Speech API 的语音识别是 Chrome 浏览器带的能力（后端接 Google 语音服务），WebView 不实现它 —— 桌面 Chromium 里 `typeof` 是 `"function"`，手机 WebView 里是 `"undefined"`。所以那个 `if` 永远成立，这个功能在 APK 里**从来没有成功过**。

同时 manifest 里也从来没声明过 `RECORD_AUDIO`，双重断链。

现在改成 `DshSpeechBridge` + 系统 `SpeechRecognizer`：

| 文件 | 职责 |
| --- | --- |
| `DshSpeechBridge.java` | 包装 `SpeechRecognizer`：能力探测、运行时权限、partial results、音量回调、错误码翻译 |
| `scripts/voice.js` | 状态机（idle / starting / listening / finishing）+ 事件转发 + Web Speech 回退 |

### 生命周期上的四个必须

| 约束 | 为什么 |
| --- | --- |
| `SpeechRecognizer` 只能在**主线程**创建与调用 | 否则直接抛 `SpeechRecognizer should be used only from the main thread` |
| 每次 `startListening` 前先 `destroy()` 上一个 | 否则会 `ERROR_RECOGNIZER_BUSY`，表现为「点了没反应」 |
| 识别结束（成功或失败）都必须 `destroy()` | 不销毁会一直占着麦克风，下次进来起不来 |
| `onResults` 之后不要再调 `stop()` | 系统自己会断；多调一次会触发第二个 `onEndOfSpeech` |

### 权限

`RECORD_AUDIO` 是运行时权限，只在用户第一次点麦克风时申请（不在启动时弹，避免一装上就吓人）。拒绝后不会反复骚扰，只提示一次怎么去系统设置里开。

`<queries>` 里加了 `android.speech.RecognitionService` —— Android 11+ 的包可见性限制下，不声明的话 `isRecognitionAvailable()` 会直接返回 false，看着像「这台设备不支持语音」，其实只是「看不见」。

### 交互

| 状态 | 界面 |
| --- | --- |
| idle | 麦克风是普通按钮 |
| starting / listening | 输入框上方出现录音条：呼吸红点 + 5 根音量柱 + 实时转写 + 取消 / 结束按钮；麦克风按钮变红并呼吸 |
| finishing | 录音条文字变「正在识别…」 |
| idle（结束） | 录音条收起，文字落进输入框，轻振一下 |

几个容易忽略的细节：

- **音量柱是 5 根错相位的柱子**，不是一根进度条 —— 后者看着像加载，前者才像「在听人说话」。
- **实时转写**用 `EXTRA_PARTIAL_RESULTS`。没有它的话，用户说完之前界面一片空白，会以为坏了。
- **静音判断放宽到 2 秒**（默认 1.5 秒），中文长句容易被截断。
- **「没听清」「没检测到说话」不弹红字** —— 那不是故障，是正常的一次空识别。

## 界面操作：Shizuku（0.26.0 起唯一通道）

### 为什么只剩这一条

0.25.x 还有一条无障碍通道（更快、能直接输中文），但它的权限来自
「系统对 `AccessibilityService` 的绑定」。日志实测：

```
11:14:19  [dev] onUnbind：系统开关 已关闭 · 总开关=开 · 进程pid=22968
11:14:23  [dev] ui：无障碍实例不存在 · 解绑距现在=4s · pid=22968
11:22:06  [dev] 进程启动 pid=2826
```

注意 `pid` 在 11:14~11:15 一直是 22968 —— **进程活着，被摘的是设置里的条目**。
这是 vivo / 小米 / OPPO 的省电策略，应用侧没有合法手段阻止
（写 `Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES` 需要 `WRITE_SECURE_SETTINGS`）。

Shizuku 的权限来自 ADB（或 root），落在 **shell 进程**（uid 2000）。
它不经过 `AccessibilityManagerService`，不受这套策略影响。

0.25.x 的做法是留两条、自动降级。真机上这反而更难用：同一段操作有时 100ms、
有时 2 秒、有时直接失败。**不可预测比慢更糟**，所以 0.26.0 把无障碍整条删掉了 ——
连同它的服务、保活、自愈任务、状态字段一起。

### 三个必须踩准的点

| 点 | 错了会怎样 |
| --- | --- |
| `DshShizukuService` 必须 `extends IShizukuExec.Stub` | 写成 `extends Service` + `onBind`，`onServiceConnected` **永远不触发**。Shizuku 不走 `bindService`，它在 shell 进程里直接 `new` 这个类当 IBinder 用 |
| 它**不能**在 manifest 声明 | 声明了也没用，而且 `exported="true"` 会把「任意 shell 执行」暴露给其它应用 |
| `:device` 里必须调 `ShizukuProvider.enableMultiProcessSupport()` | `multiprocess="false"` 的 provider 只在主进程自动初始化；不调这句，`:device` 里 `Shizuku.pingBinder()` 恒为 false —— 表现为「Shizuku 明明在运行，应用说没运行」 |

另外 `UserServiceArgs` 的 `tag` 必须显式给（比如 `"dsh_exec"`）。不给会用类名，
而类名在 R8 之后会变，升级后认不出旧实例、进程越积越多。

### 进程模型

```
主进程（WebView + UI + agent）
  └─ DshMcpBridge  ──startService──▶  :device 进程
                                         ├─ DshMcpServer（MCP 入口）
                                         ├─ DshA11yService（高速通道）
                                         └─ DshShizuku（低速客户端）
                                                │ bindUserService
                                                ▼
                                        shell 进程（uid 2000）
                                         └─ DshShizukuService.exec(cmd)
```

Shizuku 相关的所有状态（binder、授权）都只在 `:device` 里有一份。
主进程要触发授权，走 `DshDeviceService.sendAction(...)`，不在本地调 ——
否则两边状态会不一致。

### minSdk 为什么从 22 抬到 24

`dev.rikka.shizuku:api` 与 `:provider` 的 AAR 都声明 `minSdk 24`（Android 7.0）。
不抬的话 manifest merger 直接报错拒绝构建。

没有选 `tools:overrideLibrary` 硬塞：那只是绕过检查，库内部用了 API 24 的类型，
在 5.1 / 6.0 上运行会 `NoClassDefFoundError`。崩在用户机器上比构建失败更糟。

顺带的好处：`minSdk 24` 自带 `java.util.function` 等 Java 8 API，
所以不需要开 `coreLibraryDesugaring`（那是 `minSdk 23` 才需要的）。

### 能力边界

`input text` 只接受 ASCII —— 这是 shell 输入命令的硬限制。

中文改走「写剪贴板 + `input keyevent 279`」：写剪贴板不受 Android 10+ 的后台限制
（受限的是读），粘贴键让当前输入框粘上。代价是**依赖焦点在输入框**，焦点不在时无效且没有回执，
所以结果里会明确提示「如果没粘上，先点一下输入框」。

Android 13+ 写剪贴板时系统会弹「已复制」提示，这是系统行为，改不掉。

`uiautomator dump` 比 `getRootInActiveWindow` 慢一个数量级（1~2s vs 100ms）。
连续多步操作时这个差距会累积起来 —— 这也是保留高速通道的主要理由。

`uiautomator dump` 比 `getRootInActiveWindow` 慢一个数量级（1~2s vs 100ms）。
连续多步操作时这个差距会累积起来。

## 已知限制

- WebView 里没有 Node 运行时，因此 `shell` 工具是内置的沙箱命令子集（`pwd/ls/cat/echo/date/wc/tree`），不是真实 shell。
- 后台任务与定时计划在 Web 版是宿主桩：数据结构、历史与开关是真的，真正的到点执行需要原生调度器（见上表）。
- 语音输入走系统 `SpeechRecognizer`（0.23.0 起）。它依赖手机里装着可用的语音识别服务 —— 原生 Android / 带 Google 服务的机型都有；少数纯国产 ROM 若把语音服务裁掉了，会明确提示「系统里没有可用的语音识别服务」，而不是静默失败。
- **界面操作全部依赖 Shizuku**（0.26.0 起）。无障碍通道已删除：它的权限来自系统对服务的绑定，OEM 省电策略会周期性摘掉，表现为「时好时坏」。Shizuku 未安装/未启动/未授权时，`ui_*` 全部不可用，但非界面工具（`app_launch` / `clipboard` / `volume` / `device_status`）不受影响。
- 模型请求受 CORS 限制；如果目标网关不放行，请在壳内改用 Capacitor HTTP 插件转发。
