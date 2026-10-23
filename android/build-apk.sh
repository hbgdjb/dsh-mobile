#!/usr/bin/env bash
# ============================================================
# 一键构建 DSH Mobile 的 Android Debug APK
# 依赖：Node 18+ / JDK 17+ / Android SDK（platform 34 + build-tools 34）
# 用法：./android/build-apk.sh
# 国内网络默认启用腾讯 Gradle 镜像 + 阿里云 Maven 镜像，可用 MIRROR=0 关闭
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$ROOT/android/.build"
MIRROR="${MIRROR:-1}"

command -v node >/dev/null || { echo "缺少 Node.js（>=18）"; exit 1; }
command -v java >/dev/null || { echo "缺少 JDK（>=17）"; exit 1; }
if [ -z "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" ]; then
  echo "未检测到 ANDROID_HOME。请先安装 Android SDK 并设置 ANDROID_HOME。"
  exit 1
fi
SDK="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"

echo "→ 清理构建目录"
rm -rf "$WORK"
mkdir -p "$WORK/www"

echo "→ 复制 Web 运行时"
cp "$ROOT/index.html" "$WORK/www/"
cp "$ROOT/manifest.webmanifest" "$WORK/www/"
cp "$ROOT/sw.js" "$WORK/www/"
cp -R "$ROOT/styles" "$ROOT/scripts" "$ROOT/icons" "$ROOT/splash" "$WORK/www/"
cp "$ROOT/android/package.json" "$ROOT/android/capacitor.config.json" "$WORK/"

cd "$WORK"
echo "→ 安装 Capacitor"
npm install --no-audit --no-fund

echo "→ 生成 Android 工程"
npx cap add android
npx cap sync android

cd android
echo "sdk.dir=$SDK" > local.properties
sed -i 's/versionName "1.0"/versionName "0.49.0"/' app/build.gradle || true
sed -i 's/versionCode 1/versionCode 119/' app/build.gradle || true

echo "→ 注入原生 HTTP 桥"
JAVA_DIR="app/src/main/java/ai/deepseek/dsh/mobile"
mkdir -p "$JAVA_DIR"
# 本机 MCP（0.21.7 起正式并入）：
#   DshMcpServer   127.0.0.1:8788 上的最小 MCP 服务器
#   DshMcpTools    工具实现，全部走白名单校验
#   DshMcpPolicy   白名单策略（用户逐个勾选允许控制的应用）
#   DshMcpBridge   JS 侧读写白名单 / 启停服务
#   DshMcpBootstrap ContentProvider 启动钩子（仅在用户开启后启动）
#   DshSpeechBridge    语音识别桥（0.23.0 起，WebView 没有 Web Speech API）
#   DshA11yDiagnostics 诊断日志（名字沿用历史，现为通用日志，Shizuku 也在用）
#   DshStatus          设备状态快照（0.24.0 起，只在 :device 采集）
#   DshDeviceService   :device 进程入口（0.24.0 起，负责启停 MCP server）
for f in DshShizuku DshShizukuService DshPointerOverlay DshSpeechBridge DshVoskEngine ModelDownloader DshNodeRuntime DshNodeService DshNodeBridge DshNodeChannel DshA11yDiagnostics DshStatus DshDeviceService DshHttpBridge DshHudState DshHudBridge DshHudService DshBotView DshFsBridge DshKeepAliveService DshKeepAliveBridge DshPowerBridge DshMcpServer DshMcpTools DshMcpPolicy DshMcpBridge DshMcpBootstrap MainActivity; do
  cp "$ROOT/android/java/$f.java" "$JAVA_DIR/$f.java"
done

echo "→ 准备 Node 运行时（脚本 + JNI）"
#
# 只放 cpp 源码和入口脚本。**不放 libnode.so** ——
# 它有 117 MB，打进去 APK 就是 128 MB，用户根本传不到手机上
# （常见传输工具有 20 MB 上限）。改成首次启用时下载，
# 见 DshNodeRuntime.RUNTIME_URL 与 downloadRuntime()。
NODE_CPP="$WORK/android/app/src/main/cpp"
NODE_ASSETS="$WORK/android/app/src/main/assets/node"
mkdir -p "$NODE_CPP" "$NODE_ASSETS"
cp "$ROOT/android/jni/CMakeLists.txt" "$ROOT/android/jni/dshnode.cpp" "$NODE_CPP/"
# Node 侧的脚本不止入口一个：通道客户端、cordis 迷你容器、
# 宿主服务、插件宿主 —— 都是 main.js 的依赖，缺一个就起不来。
cp "$ROOT/android/node/main.js" "$ROOT/android/node/channel.js" \
   "$ROOT/android/node/cordis-lite.js" "$ROOT/android/node/fiber-state.js" \
   "$ROOT/android/node/ctx-services.js" "$ROOT/android/node/host-services.js" \
   "$ROOT/android/node/plugin-host.js" "$ROOT/android/node/llm-service.js" \
   "$ROOT/android/node/llm-chat.js" \
   "$ROOT/android/node/plugin-reload.js" "$ROOT/android/node/hmr-service.js" \
   "$NODE_ASSETS/"
# VERSION 是"脚本已解压"的标记，必须随 APK 版本变化 ——
# 否则升级 APK 后新代码配旧的解压结果，出现诡异的不一致。
# 用 versionCode（119），不是版本名（0.49.0）：它是整数、单调递增、
# 且和 PackageManager 拿到的值一致。
echo "119" > "$NODE_ASSETS/VERSION"

echo "→ 复制 AIDL（Shizuku UserService 接口）"
# AIDL 必须放在 app/src/main/aidl 下，Gradle 才会自动编译成 IShizukuExec。
# 少了这一步，DshShizukuService extends IShizukuExec.Stub 直接编译不过。
if [ -d "$ROOT/android/aidl" ]; then
  mkdir -p app/src/main/aidl
  cp -R "$ROOT/android/aidl/." app/src/main/aidl/
fi

# ---- 提升 minSdk 到 24（0.25.0）----
#
# Shizuku 的 api / provider 两个库都声明 minSdk 24（Android 7.0）。
# 原来是 22（Android 5.1），manifest merger 会直接报错拒绝构建。
#
# 为什么不选 tools:overrideLibrary 硬塞：
# 那只是绕过检查，库内部用了 API 24 才有的类型，在旧系统上运行时
# NoClassDefFoundError —— 崩在用户机器上比构建失败糟得多。
#
# 顺带一个好处：minSdk 24 自带 java.util.function 等 Java 8 API，
# 所以不需要再开 coreLibraryDesugaring（那是 minSdk 23 才需要的）。
if [ -f variables.gradle ]; then
  sed -i 's/minSdkVersion = 22/minSdkVersion = 24/' variables.gradle || true
fi

echo "→ 注入 Shizuku 依赖"
python3 - <<'PY'
from pathlib import Path
p = Path("app/build.gradle")
s = p.read_text()
if "dev.rikka.shizuku" not in s:
    s = s.replace(
        "dependencies {\n",
        "dependencies {\n"
        "    // Shizuku：低速通道。api 提供 Shizuku 类与 UserService 机制，\n"
        "    // provider 提供 binder 获取入口（必须在 manifest 里声明对应 provider）。\n"
        "    implementation \"dev.rikka.shizuku:api:13.1.5\"\n"
        "    implementation \"dev.rikka.shizuku:provider:13.1.5\"\n"
    )
    # Vosk：内置离线语音识别引擎。
    # 系统 SpeechRecognizer 在国内多数设备上只能走云端，而那条链路经常是断的
    # （错误码 11）。这个 AAR 让应用能完全本地识别，不依赖网络。
    if "com.alphacephei:vosk-android" not in s:
        s = s.replace(
            "dependencies {\n",
            "dependencies {\n"
            "    implementation \"com.alphacephei:vosk-android:0.3.75\"\n"
        )
    # 只保留 arm64：libvosk.so 单个 ABI 就 10 MB，
    # 多打 armeabi-v7a 只为了 2026 年几乎不存在的 32 位设备，不划算。
    if "abiFilters" not in s:
        s = s.replace(
            "    defaultConfig {\n",
            "    defaultConfig {\n"
            "        ndk { abiFilters \"arm64-v8a\" }\n",
            1,
        )
    # AGP 8 起 buildFeatures.aidl 默认是 false ——
    # 不开的话 app/src/main/aidl 下的文件会被完全忽略，
    # 表现为 IShizukuExec 找不到符号（不是语法错误，是根本没生成）。
    if "aidl true" not in s:
        s = s.replace(
            "android {\n",
            "android {\n"
            "    buildFeatures {\n"
            "        aidl true\n"
            "    }\n",
        )
    # ---- Node 运行时 JNI（0.37.0）----
    #
    # 三个配置缺一不可，少任何一个的表现都是「libdshnode.so 不见了」：
    #
    # ① ndkVersion        不写的话 Gradle 找不到 NDK 直接构建失败
    # ② externalNativeBuild 指向 src/main/cpp/CMakeLists.txt，
    #                      这才让 CMake 去编 dshnode.cpp
    # ③ ANDROID_STL=c++_shared
    #                      必须和 libnode.so 一致 —— readelf 显示它
    #                      NEEDED libc++_shared.so。用 c++_static 会得到
    #                      两份 C++ 运行时，跨库 new/delete 直接崩。
    if "ndkVersion" not in s:
        s = s.replace(
            "    namespace \"ai.deepseek.dsh.mobile\"\n",
            "    namespace \"ai.deepseek.dsh.mobile\"\n"
            "    ndkVersion \"26.1.10909125\"\n",
        )
    if "externalNativeBuild" not in s:
        s = s.replace(
            "    defaultConfig {\n",
            "    defaultConfig {\n"
            "        externalNativeBuild {\n"
            "            cmake {\n"
            "                arguments \"-DANDROID_STL=c++_shared\"\n"
            "            }\n"
            "        }\n",
            1,
        )
        s = s.replace(
            "    buildTypes {\n",
            "    externalNativeBuild {\n"
            "        cmake {\n"
            "            path \"src/main/cpp/CMakeLists.txt\"\n"
            "            version \"3.22.1\"\n"
            "        }\n"
            "    }\n"
            "    buildTypes {\n",
        )
    p.write_text(s)
    print("已注入 Shizuku 依赖（含 AIDL 编译开关）")
    print("已注入 Node JNI 的 CMake / NDK 配置")
PY

echo "→ 覆盖应用图标与无障碍配置"
cp -R "$ROOT/android/res/." app/src/main/res/

echo "→ 补充振动、通知权限与明文网关支持"
python3 - <<'PY'
from pathlib import Path
m = Path("app/src/main/AndroidManifest.xml")
s = m.read_text()
if "android.permission.VIBRATE" not in s:
    s = s.replace(
        '<uses-permission android:name="android.permission.INTERNET" />',
        '<uses-permission android:name="android.permission.INTERNET" />\n'
        '    <uses-permission android:name="android.permission.VIBRATE" />\n'
        '    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
    )
if 'android:usesCleartextTraffic' not in s:
    s = s.replace(
        '<application',
        '<application\n        android:usesCleartextTraffic="true"',
        1,
    )
if 'android.permission.SYSTEM_ALERT_WINDOW' not in s:
    s = s.replace(
        '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
        '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n'
        '    <uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />',
    )
# 前台服务权限：Agent 运行期间靠它保活，避免被系统回收导致任务中断
if 'android.permission.FOREGROUND_SERVICE' not in s:
    s = s.replace(
        '<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />',
        '<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />\n'
        '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />\n'
        '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />',
    )
if '<service android:name=".DshHudService"' not in s:
    s = s.replace(
        '</application>',
        '    <service\n'
        '        android:name=".DshHudService"\n'
        '        android:exported="false"\n'
        '    />\n'
        '</application>',
    )
# 保活前台服务：Agent 跑任务时把进程优先级提起来
if 'DshKeepAliveService' not in s:
    s = s.replace(
        '</application>',
        '    <service\n'
        '        android:name=".DshKeepAliveService"\n'
        '        android:exported="false"\n'
        '        android:foregroundServiceType="dataSync"\n'
        '    />\n'
        '</application>',
    )
# Node 插件运行时：常驻前台服务（dataSync）
if 'DshNodeService' not in s:
    s = s.replace(
        '</application>',
        '    <service\n'
        '        android:name=".DshNodeService"\n'
        '        android:exported="false"\n'
        '        android:foregroundServiceType="dataSync"\n'
        '    />\n'
        '</application>',
    )
# ---- 后台保活相关权限 ----
# WAKE_LOCK：保活服务持 PARTIAL_WAKE_LOCK，避免 CPU 休眠打断 SSE 流式读取。
# REQUEST_IGNORE_BATTERY_OPTIMIZATIONS：弹系统面板请用户把应用加进
#   "忽略电池优化"白名单（用户提的"允许后台耗电"对应的就是这个）。
#   注意：这个权限 Play 商店会审核，自用 / 侧载 APK 无此限制。
extra_perms = [
    'android.permission.WAKE_LOCK',
    'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
]
for perm in extra_perms:
    if perm not in s:
        s = s.replace(
            '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
            '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />\n'
            '    <uses-permission android:name="' + perm + '" />',
        )
# 前台服务类型保持 dataSync：
#   Android 15 的 dataSync 6 小时/24h 硬限制只对 targetSdk 35+ 生效，
#   本应用 targetSdk 34，不受该限制影响。
#   而 specialUse 在 API 34+ 还必须额外声明
#   <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" .../>，
#   漏了会在 startForeground 时直接抛异常，得不偿失。

# ---- 本机 MCP（0.21.7）：最小敏感权限 ----
#
# 这里刻意**不申请** QUERY_ALL_PACKAGES。
# 那个权限能列出手机上装了什么，属于商店审核里的敏感项，而且暴露面远大于本应用需要。
# 改用 <queries> 的 intent 过滤器，只暴露「有 MAIN/LAUNCHER 启动入口」的应用，
# 拿不到后台服务与系统私有包；真正的操作边界由 DshMcpPolicy 的白名单兜底。
if '<queries>' not in s:
    s = s.replace(
        '</manifest>',
        '    <queries>\n'
        '        <intent>\n'
        '            <action android:name="android.intent.action.MAIN" />\n'
        '            <category android:name="android.intent.category.LAUNCHER" />\n'
        '        </intent>\n'
        '    </queries>\n'
        '</manifest>',
    )

# ---- Shizuku 的包可见性（0.25.1）----
#
# Android 11+ 默认限制应用能"看见"哪些其它应用。不开这个声明，
# getPackageInfo("moe.shizuku.privileged.api") 会抛 NameNotFoundException ——
# 哪怕 Shizuku 装着并在运行。
#
# 症状特别有迷惑性：Shizuku 明明显示"服务已启动"，DSH 却显示"未安装"，
# 于是「授权」按钮根本不出现，Shizuku 的授权列表里也就一直是空的。
#
# 注意这是"允许看见"，不是权限，不会扩大任何系统能力。
if 'moe.shizuku.privileged.api' not in s:
    s = s.replace(
        '    <queries>\n',
        '    <queries>\n'
        '        <package android:name="moe.shizuku.privileged.api" />\n',
    )

# ACCESS_NETWORK_STATE：device_status 要读网络类型。
# 这是普通权限（normal），安装即授予，不弹窗、不涉及隐私。
if 'android.permission.ACCESS_NETWORK_STATE' not in s:
    s = s.replace(
        '    <uses-permission android:name="android.permission.INTERNET" />',
        '    <uses-permission android:name="android.permission.INTERNET" />\n'
        '    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />',
    )

# ---- 语音输入（0.23.0）：RECORD_AUDIO ----
#
# 之前整个工程没有声明过录音权限，而语音输入用的又是 Web Speech API ——
# 那东西在 Android WebView 里压根不存在，所以这个功能在 APK 里从来没成功过。
# 现在改走原生 SpeechRecognizer，权限必须补上。
if 'android.permission.RECORD_AUDIO' not in s:
    s = s.replace(
        '    <uses-permission android:name="android.permission.INTERNET" />',
        '    <uses-permission android:name="android.permission.INTERNET" />\n'
        '    <uses-permission android:name="android.permission.RECORD_AUDIO" />',
    )

# Android 11+ 的包可见性：不声明 <queries> 的话，SpeechRecognizer
# 可能看不到系统里的语音识别服务，isRecognitionAvailable() 直接返回 false。
# 这条不是权限，只是"允许看见这类服务"，不会泄露其它应用。
if 'android.speech.RecognitionService' not in s:
    s = s.replace(
        '        <intent>\n'
        '            <action android:name="android.intent.action.MAIN" />',
        '        <intent>\n'
        '            <action android:name="android.speech.RecognitionService" />\n'
        '        </intent>\n'
        '        <intent>\n'
        '            <action android:name="android.intent.action.MAIN" />',
    )

# KILL_BACKGROUND_PROCESSES：app_stop 用（结束白名单内应用的后台进程）
if 'android.permission.KILL_BACKGROUND_PROCESSES' not in s:
    s = s.replace(
        '    <uses-permission android:name="android.permission.VIBRATE" />',
        '    <uses-permission android:name="android.permission.VIBRATE" />\n'
        '    <uses-permission android:name="android.permission.KILL_BACKGROUND_PROCESSES" />',
    )

# ---- Shizuku provider（0.25.0）----
#
# Shizuku 的 binder 是通过 ContentProvider 换来的：ShizukuProvider 跑在
# Shizuku 应用那边，本应用通过它拿到 binder。不声明这个 provider，
# Shizuku.pingBinder() 永远是 false —— 看起来像「Shizuku 没在运行」，
# 其实是本应用压根没接上。
#
# android:permission 是官方要求的保护，防止普通应用直接访问这个 provider。
if 'rikka.shizuku.ShizukuProvider' not in s:
    s = s.replace(
        '</application>',
        '    <provider\n'
        '        android:name="rikka.shizuku.ShizukuProvider"\n'
        '        android:authorities="${applicationId}.shizuku"\n'
        '        android:multiprocess="false"\n'
        '        android:enabled="true"\n'
        '        android:exported="true"\n'
        '        android:permission="android.permission.INTERACT_ACROSS_USERS_FULL" />\n'
        '</application>',
    )

# 启动钩子：ContentProvider（早于 Application.onCreate，不碰 MainActivity）
if 'DshMcpBootstrap' not in s:
    s = s.replace(
        '</application>',
        '    <provider\n'
        '        android:name=".DshMcpBootstrap"\n'
        '        android:process=":device"\n'
        '        android:authorities="ai.deepseek.dsh.mobile.dshmcp"\n'
        '        android:exported="false"\n'
        '        android:enabled="true" />\n'
        '</application>',
    )

# ---- :device 进程入口（0.24.0）----
#
# 无障碍服务与 MCP server 都跑在这个进程里，和 WebView 分开。
# 它是普通 Service（不是前台服务）：只负责拉起进程、启停 MCP server，
# 不需要提升优先级 —— 无障碍服务本身的绑定已经给了这个进程足够的优先级。
if 'DshDeviceService' not in s:
    s = s.replace(
        '</application>',
        '    <service\n'
        '        android:name=".DshDeviceService"\n'
        '        android:exported="false"\n'
        '        android:process=":device"\n'
        '    />\n'
        '</application>',
    )

m.write_text(s)
PY
if [ "$MIRROR" = "1" ]; then
  echo "→ 启用国内镜像"
  python3 - <<'PY'
import pathlib
p = pathlib.Path("gradle/wrapper/gradle-wrapper.properties")
s = p.read_text()
lines = []
for line in s.splitlines():
    if line.startswith("distributionUrl="):
        # 腾讯镜像的 Gradle 路径是 /gradle/，官方是 /distributions/，直接整体重写
        lines.append("distributionUrl=https\\://mirrors.cloud.tencent.com/gradle/gradle-8.7-bin.zip")
    else:
        lines.append(line)
p.write_text("\n".join(lines) + "\n")
PY
  python3 - <<'PY'
import pathlib
p = pathlib.Path("build.gradle")
s = p.read_text()
mirror = """        maven { url 'https://maven.aliyun.com/repository/google' }
        maven { url 'https://maven.aliyun.com/repository/central' }
        maven { url 'https://maven.aliyun.com/repository/gradle-plugin' }
"""
if "maven.aliyun.com" not in s:
    s = s.replace("""    repositories {
        google()
        mavenCentral()
    }""", "    repositories {\n" + mirror + "        google()\n        mavenCentral()\n    }")
    p.write_text(s)
PY
fi

# ---- 离线语音模型 ----
#
# 模型 44 MB，**不放进源码包**（那会让源码包没人愿意下）。
# 构建时从 android/vosk-cn/ 复制进 assets；没有就跳过 ——
# 此时应用仍能构建，只是设置页会显示"内置引擎：未安装"。
MODEL_SRC="$ROOT/android/vosk-cn"
ASSETS_DIR="$WORK/android/app/src/main/assets"
# 默认**不打包**模型（APK 保持 ~14 MB），应用内按需下载。
# 需要离线分发包时：BUNDLE_MODEL=1 ./android/build-apk.sh
if [ -d "$MODEL_SRC" ] && [ "${BUNDLE_MODEL:-0}" = "1" ]; then
  # 打成 zip 再放 assets：模型原始 66 MB，zip 后 42 MB。
  # 直接以目录形式放进 assets，APK 会大 24 MB（assets 里这些二进制压不动）。
  echo "→ 打包离线语音模型（压缩，BUNDLE_MODEL=1）"
  mkdir -p "$ASSETS_DIR"
  ( cd "$(dirname "$MODEL_SRC")" && rm -f "$ASSETS_DIR/vosk-cn.zip" && zip -qr9 "$ASSETS_DIR/vosk-cn.zip" "$(basename "$MODEL_SRC")" )
  ls -lh "$ASSETS_DIR/vosk-cn.zip" | awk '{print "   模型包：" $5}'
else
  if [ -d "$MODEL_SRC" ]; then
    echo "→ 不打包模型（应用内按需下载；要内置请设 BUNDLE_MODEL=1）"
  else
    echo "→ 不含离线语音模型（应用内按需下载）"
  fi
fi

echo "→ Gradle 构建 Debug APK"
./gradlew assembleDebug --no-daemon

APK="$WORK/android/app/build/outputs/apk/debug/app-debug.apk"
VERSION="0.49.0"
if [ -f "$APK" ]; then
  mkdir -p "$ROOT/android/out"
  cp "$APK" "$ROOT/android/out/dsh-mobile-$VERSION-debug.apk"
  echo ""
  echo "完成：$ROOT/android/out/dsh-mobile-$VERSION-debug.apk"
  echo "安装：adb install -r \"$ROOT/android/out/dsh-mobile-$VERSION-debug.apk\""
else
  echo "构建结束但未找到 APK，请检查 Gradle 输出。"
  exit 1
fi
