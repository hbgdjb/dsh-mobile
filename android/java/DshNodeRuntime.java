package ai.deepseek.dsh.mobile;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Properties;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Node.js 运行时的启动入口。
 *
 * ============ 它解决什么 ============
 *
 * DSH（桌面版）的插件是进程内的 npm 包，导出 apply(ctx)，需要 cordis 容器和
 * node:fs / node:http 这些真 Node API。WebView 沙箱里一个都给不了 ——
 * 所以插件生态在手机上等于零。
 *
 * ============ 为什么运行时是下载的 ============
 *
 * libnode.so 有 117 MB。内置的话 APK 就是 128 MB，用户根本传不到手机上
 * （常规文件传输工具有 20 MB 上限）。所以改成首次使用时下载，
 * APK 只留 20 KB 的 JNI 包装。
 *
 * 代价：第一次启用要下 88 MB。收益：之后每次更新只需要重下 15 MB。
 *
 * ============ 目录布局 ============
 *
 *   filesDir/node/main.js       入口脚本（从 assets 解压）
 *   filesDir/node/libnode.so    Node 本体（下载 + 解压）
 *   filesDir/node/.extracted    脚本解压标记（记录版本）
 */
public final class DshNodeRuntime {

    private static final String TAG = "DshNode";

    /** 运行时目录（相对 filesDir）。 */
    static final String NODE_DIR = "node";
    /** 入口脚本。 */
    static final String ENTRY = "main.js";
    /** 下载并解压出来的 Node 本体。 */
    static final String LIB_NAME = "libnode.so";
    /** assets 里的脚本目录。 */
    private static final String ASSET_DIR = "node";
    /** 脚本解压完成标记。 */
    private static final String MARKER = ".extracted";

    /**
     * Node 运行时压缩包。
     *
     * 用 Gitee 的 nodejs-mobile v22 预编译（Node 22.23.2）。
     * 官方 nodejs-mobile 停在 18.20.4，而 DSH 插件要求 ^22.19.0，用不了。
     */
    static final String RUNTIME_URL =
            "https://gitee.com/OpenFlun/nodejs-mobile/releases/download/v22.23.2/android-libnode.zip";

    private static boolean loaded = false;
    private static String loadError = null;
    /** JNI 包装没问题，但 dlopen libnode 失败时的原因（与 loadError 分开）。 */
    private static volatile String runtimeError = null;
    private static volatile boolean running = false;
    private static volatile boolean downloading = false;
    private static volatile int downloadPct = 0;

    private DshNodeRuntime() {
    }

    /** 只加载 JNI 包装（20 KB）。libnode 是下载来的，由 nativeStart 内部 dlopen。 */
    static synchronized boolean ensureLoaded() {
        if (loaded) return true;
        if (loadError != null) return false;
        try {
            System.loadLibrary("dshnode");
            loaded = true;
            Log.i(TAG, "JNI 包装已加载");
            return true;
        } catch (Throwable e) {
            loadError = e.getClass().getSimpleName() + ": " + e.getMessage();
            Log.e(TAG, "JNI 包装加载失败：" + loadError);
            return false;
        }
    }

    public static boolean available() {
        return ensureLoaded();
    }

    public static String unavailableReason() {
        ensureLoaded();
        return loadError;
    }

    public static boolean isRunning() {
        return running;
    }

    /** dlopen / 启动 Node 失败时的原因（null 表示没失败过）。 */
    public static String runtimeError() {
        return runtimeError;
    }

    public static boolean isDownloading() {
        return downloading;
    }

    public static int downloadPercent() {
        return downloadPct;
    }

    /** 运行时文件在不在（不看是否已加载进内存）。 */
    public static boolean runtimeInstalled(Context ctx) {
        return new File(new File(ctx.getFilesDir(), NODE_DIR), LIB_NAME).exists();
    }

    /**
     * 下载并安装 Node 运行时。
     *
     * 复用 ModelDownloader：12 路并行 + 断点续传 —— 88 MB 单连接要十几分钟，
     * 那套坑在语音模型上已经踩过一遍了。
     *
     * ============ 为什么必须自己解包 ============
     *
     * 官方 zip 里同时有 arm64 与 x86_64 两份 libnode.so，各 110 MB 上下。
     * 手机只要 arm64 那份，但 zip 得整个下完（88 MB）才能解出其中一半。
     * 这个浪费没法在协议层避免 —— 除非源站提供单架构包，而它没有。
     */
    static void downloadRuntime(Context ctx) throws IOException {
        File root = new File(ctx.getFilesDir(), NODE_DIR);
        if (!root.exists() && !root.mkdirs() && !root.exists()) {
            throw new IOException("无法创建运行时目录");
        }
        File lib = new File(root, LIB_NAME);
        File work = new File(ctx.getCacheDir(), "node-dl");

        downloading = true;
        downloadPct = 0;
        try {
            ModelDownloader.Result r = new ModelDownloader(
                    RUNTIME_URL,
                    work,
                    // 回调给的是 double（0~99.9），这里转成整数百分比
                    pct -> downloadPct = (int) pct
            ).download();

            // 压缩包里带 arm64 与 x86_64 两份，只取我们要的那份
            if (!extractLibnode(r.file, lib)) {
                throw new IOException("压缩包里没有 arm64-v8a/libnode.so");
            }
            ModelDownloader.deleteRecursive(work);
            downloadPct = 100;
            Log.i(TAG, "运行时安装完成：" + lib.length() + " 字节");
        } finally {
            downloading = false;
        }
    }

    /** 从 zip 里抽 libnode/bin/arm64-v8a/libnode.so 到目标路径。 */
    private static boolean extractLibnode(File zip, File target) throws IOException {
        final String want = "arm64-v8a/libnode.so";
        try (InputStream in = new FileInputStream(zip);
             ZipInputStream zis = new ZipInputStream(in, java.nio.charset.StandardCharsets.UTF_8)) {
            ZipEntry e;
            byte[] buf = new byte[64 * 1024];
            while ((e = zis.getNextEntry()) != null) {
                if (e.isDirectory()) continue;
                // 条目形如 libnode/bin/arm64-v8a/libnode.so —— 用后缀匹配，
                // 不依赖压缩包顶层目录叫什么
                if (!e.getName().endsWith(want)) continue;

                long expected = e.getSize();
                long written = 0;
                try (OutputStream os = new FileOutputStream(target)) {
                    int n;
                    while ((n = zis.read(buf)) > 0) {
                        os.write(buf, 0, n);
                        written += n;
                    }
                }
                // 长度对不上就是解压坏了 —— 这种文件 dlopen 时会报
                // "not an ELF file"，但真正的原因在几十秒前就丢了。
                // 这里当场拦住，并把原文留着。
                if (expected > 0 && written != expected) {
                    //noinspection ResultOfMethodCallIgnored
                    target.delete();
                    throw new IOException("解压长度不符（" + written + "/" + expected + "）");
                }
                // 给执行权限：dlopen 会把文件映射成可执行内存，
                // 某些 ROM 上没有 x 位会直接拒绝。
                //noinspection ResultOfMethodCallIgnored
                target.setExecutable(true, false);
                return true;
            }
        }
        return false;
    }

    /**
     * 启动 Node。**阻塞**直到 Node 退出，调用方必须在工作线程里执行。
     *
     * @return Node 退出码；负数表示启动失败
     */
    static int run(Context ctx) {
        if (!ensureLoaded()) return -1;

        try {
            File root = prepareScripts(ctx);
            File entry = new File(root, ENTRY);
            if (!entry.exists()) {
                Log.e(TAG, "入口脚本不存在：" + entry);
                runtimeError = "入口脚本缺失";
                return -1;
            }
            File lib = new File(root, LIB_NAME);
            if (!lib.exists()) {
                Log.e(TAG, "libnode.so 未安装");
                runtimeError = "运行时未安装";
                return -1;
            }

            // ============ 通道：Java 先监听，Node 再连回来 ============
            //
            // nativeStart 是阻塞调用，Java 线程卡在上面等 Node 退出。
            // 所以不能让 Node 去连 Java（Java 那时还没端口），
            // 必须 Java 先起监听，把端口和口令塞进 argv。
            //
            // 插件代码在工作区（与 WebView 共享同一个文件系统），
            // 运行时目录只放 Node 本体和脚本。
            DshNodeChannel channel = DshNodeChannel.get();
            int port = channel.startServer();
            if (port == 0) {
                Log.e(TAG, "通道监听失败");
                runtimeError = "通道监听失败";
                return -3;
            }
            String token = channel.token();

            // argv[0] 是 node 自己，argv[1] 是脚本，其后传给脚本
            String[] args = {
                    "node",
                    entry.getAbsolutePath(),
                    root.getAbsolutePath(),
                    String.valueOf(port),
                    token,
                    workspacePath(ctx),
            };

            running = true;
            runtimeError = null;
            Log.i(TAG, "启动 Node：" + entry + "，库：" + lib + "，通道端口：" + port);
            int rc = nativeStart(lib.getAbsolutePath(), args);
            Log.i(TAG, "Node 退出，rc=" + rc);
            return rc;
        } catch (UnsatisfiedLinkError e) {
            // dlopen / dlsym 失败，异常消息里带 dlerror。
            // 这类失败最常见的原因是运行时没装好（下载的 zip 解压坏了、
            // 或者这台 ROM 的 linker 拦了私有目录的库）—— 所以要把原文
            // 完整留在状态里，用户截图反馈时才能定位。
            Log.e(TAG, "加载 libnode 失败：" + e.getMessage());
            runtimeError = e.getMessage();
            return -2;
        } catch (Throwable e) {
            Log.e(TAG, "启动失败：" + e.getMessage(), e);
            runtimeError = e.getClass().getSimpleName() + ": " + e.getMessage();
            return -1;
        } finally {
            running = false;
        }
    }

    /**
     * 把 assets/node/ 里的脚本解压到 filesDir/node/。
     *
     * 用版本号做标记：APK 升级后版本变了就重解，避免"新代码 + 旧依赖"。
     * 注意这里**不碰** libnode.so —— 那是下载来的，重解脚本不该把它删掉。
     */
    private static File prepareScripts(Context ctx) throws IOException {
        File root = new File(ctx.getFilesDir(), NODE_DIR);
        File marker = new File(root, MARKER);

        String want = assetVersion(ctx);
        String have = null;
        if (marker.exists()) {
            Properties p = new Properties();
            try (InputStream in = new FileInputStream(marker)) {
                p.load(in);
            } catch (Throwable ignored) {
                // 标记坏了当作没解压过
            }
            have = p.getProperty("version");
        }

        if (!want.equals(have)) {
            Log.i(TAG, "解压脚本 " + have + " → " + want);
            if (!root.exists() && !root.mkdirs() && !root.exists()) {
                throw new IOException("无法创建运行时目录");
            }
            // 只删脚本，保留 libnode.so
            File[] kids = root.listFiles();
            if (kids != null) {
                for (File k : kids) {
                    if (LIB_NAME.equals(k.getName())) continue;
                    ModelDownloader.deleteRecursive(k);
                }
            }
            copyAsset(ctx, ASSET_DIR, root);
            Properties p = new Properties();
            p.setProperty("version", want);
            try (OutputStream out = new FileOutputStream(marker)) {
                p.store(out, "dsh node runtime");
            }
        }
        return root;
    }

    private static String assetVersion(Context ctx) {
        // assets/node/VERSION 由构建脚本写入，内容是 APK 的 versionCode。
        // 用它做标记：APK 一升级，标记就变了，脚本重新解压，
        // 不会出现"新 JS 配旧依赖"的组合。
        try (InputStream in = ctx.getAssets().open(ASSET_DIR + "/VERSION")) {
            byte[] buf = new byte[64];
            int n = in.read(buf);
            if (n > 0) {
                String v = new String(buf, 0, n, "UTF-8").trim();
                if (!v.isEmpty()) return v;
            }
        } catch (Throwable ignored) {
            // assets 里没有 VERSION 就退回版本号
        }
        try {
            return "apk-" + ctx.getPackageManager()
                    .getPackageInfo(ctx.getPackageName(), 0).versionCode;
        } catch (Throwable e) {
            return "apk-unknown";
        }
    }

    private static void copyAsset(Context ctx, String assetPath, File target)
            throws IOException {
        String[] kids = ctx.getAssets().list(assetPath);
        if (kids == null || kids.length == 0) {
            File parent = target.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) {
                throw new IOException("无法创建目录：" + parent);
            }
            try (InputStream in = ctx.getAssets().open(assetPath);
                 OutputStream os = new FileOutputStream(target)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            }
            return;
        }
        if (!target.exists() && !target.mkdirs() && !target.exists()) {
            throw new IOException("无法创建目录：" + target);
        }
        for (String kid : kids) {
            // VERSION 只给代码读，不需要落到应用目录
            if (ASSET_DIR.equals(assetPath) && "VERSION".equals(kid)) continue;
            copyAsset(ctx, assetPath + "/" + kid, new File(target, kid));
        }
    }

    /**
     * 工作区根目录。
     *
     * ============ 为什么 Node 要知道它 ============
     *
     * 插件代码（插件安装流程写下的 main.js / npm 包）落在工作区的
     * plugins/ 目录下。Node 与 WebView 在同一个应用里，读的是同一个
     * 文件系统 —— 所以 Node 直接读那个目录就行，不需要再传一遍代码。
     *
     * 路径必须和 DshFsBridge 用的一致（应用专属外部目录），
     * 否则 Node 看到的和页面看到的不是同一份文件。
     */
    private static String workspacePath(Context ctx) {
        try {
            File ext = ctx.getExternalFilesDir(null);
            if (ext != null) return ext.getAbsolutePath();
        } catch (Throwable ignored) {
        }
        return ctx.getFilesDir().getAbsolutePath();
    }

    private static native int nativeStart(String libPath, String[] args);
}
