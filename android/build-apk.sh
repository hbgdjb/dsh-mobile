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
cp -R "$ROOT/styles" "$ROOT/scripts" "$ROOT/icons" "$WORK/www/"
cp "$ROOT/android/package.json" "$ROOT/android/capacitor.config.json" "$WORK/"

cd "$WORK"
echo "→ 安装 Capacitor"
npm install --no-audit --no-fund

echo "→ 生成 Android 工程"
npx cap add android
npx cap sync android

cd android
echo "sdk.dir=$SDK" > local.properties
sed -i 's/versionName "1.0"/versionName "0.21.6"/' app/build.gradle || true
sed -i 's/versionCode 1/versionCode 49/' app/build.gradle || true

echo "→ 注入原生 HTTP 桥"
JAVA_DIR="app/src/main/java/ai/deepseek/dsh/mobile"
mkdir -p "$JAVA_DIR"
for f in DshHttpBridge DshHudState DshHudBridge DshHudService DshBotView DshFsBridge DshKeepAliveService DshKeepAliveBridge DshPowerBridge MainActivity; do
  cp "$ROOT/android/java/$f.java" "$JAVA_DIR/$f.java"
done

echo "→ 覆盖应用图标"
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

echo "→ Gradle 构建 Debug APK"
./gradlew assembleDebug --no-daemon

APK="$WORK/android/app/build/outputs/apk/debug/app-debug.apk"
VERSION="0.21.6"
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
