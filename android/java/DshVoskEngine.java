package ai.deepseek.dsh.mobile;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 本地（离线）语音识别引擎。
 *
 * ============ 为什么需要它 ============
 *
 * 系统的 `SpeechRecognizer` 在绝大多数设备上走**云端**：
 * 音频传到厂商 / Google 的服务器，识别结果再传回来。
 *
 * 这条链路在国内经常是断的 —— 表现就是错误码 11
 * （ERROR_SERVER_DISCONNECTED）：麦克风开了、音频采到了、就是拿不到结果。
 *
 * Android 12 起有 `createOnDeviceSpeechRecognizer()`，但**要求设备预装离线语音包**。
 * 国产 ROM 普遍没有，`isOnDeviceRecognitionAvailable()` 直接返回 false，
 * 用户没有任何入口去"装一个"——那是系统组件，不是应用能装的。
 *
 * 所以这里自带一个引擎：Vosk + 中文小模型，纯本地，不走网络。
 *
 * ============ 代价（必须说清楚） ============
 *
 * · **模型 44 MB，打包进 APK**。APK 从 4 MB 变成约 60 MB。
 * · **准确率低于云端**。小模型适合短句指令（"打开微信搜索天气"），
 *   长句和口音重的场景会出错。这是用体积和准确率换"能用"。
 *
 * ============ 与系统的关系 ============
 *
 * 这是**兜底**，不是替代：DshSpeechBridge 会优先用系统识别，
 * 只有在系统走不通（错误码 11 / 没有服务 / 用户手动选了本地）时才用它。
 */
public class DshVoskEngine {

    /** 采样率：Vosk 中文模型按 16 kHz 训练，改了这个识别率会崩。 */
    private static final int SAMPLE_RATE = 16000;
    /** 每次读 100 ms 音频（16000 * 0.1 * 2 字节）。 */
    private static final int CHUNK = 3200;
    /** assets 里的模型目录名。 */
    private static final String ASSET_DIR = "vosk-cn";
    /** 解压到 filesDir 后的目录名。 */
    private static final String LOCAL_DIR = "vosk-cn";
    /** 预压缩的模型包（assets 里）。有就用，没有就按需下载。 */
    private static final String ZIP_NAME = "vosk-cn.zip";

    /**
     * 模型下载地址。
     *
     * ============ 为什么不在 APK 里带 ============
     *
     * 模型解压后 66 MB、压缩后 42 MB。打进去 APK 就是 56 MB ——
     * 对一个聊天应用来说太重了：安装慢、更新慢、也没法只让需要的人付这个成本。
     *
     * 改成按需下载后 APK 回到 14 MB 左右（只剩 libvosk.so 10 MB）。
     * 代价是第一次用语音要等一次下载，但只等一次。
     *
     * 用官方源。国内可能慢 —— 下载有进度显示，也能重试。
     */
    private static final String MODEL_URL =
            "https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip";

    /**
     * 分片下载的并发数。
     *
     * ============ 为什么是 12 ============
     *
     * 实测同一个文件、同一台机器，只改并发连接数：
     *
     *     1 路   28 KB/s     42 MB 需要 25 分钟
     *     6 路  162 KB/s     4.4 分钟
     *    16 路  436 KB/s     1.7 分钟
     *    32 路  733 KB/s     58 秒
     *
     * 近似线性增长 —— 说明源对**每个 TCP 连接单独限速**，
     * 多开几条就能叠加。单连接慢不是"网络不好"，是被人为掐住的。
     *
     * 取 12 而不是 32：手机上再往上加，收益被耗电和系统调度吃掉，
     * 而 12 路已经能把 25 分钟压到 2 分钟左右。移动网络下这个数也不至于
     * 触发运营商的并发 QoS。
     */
    private static final int PARALLEL = 12;

    /** 分片的最小体积。文件太小时分片反而更慢（每片都要 TCP 握手）。 */
    private static final long MIN_CHUNK = 512 * 1024;

    /** 单片最多重试几次（含首次）。 */
    private static final int PART_RETRY = 2;

    /** 下载工作目录：分片与断点信息都放这里。 */
    private static final String DL_DIR = "vosk-dl";

    private final Context ctx;

    /** 分片下载的锁与重入标记。 */
    private final Object downloadLock = new Object();
    private volatile boolean downloading = false;


    private final WebView webView;
    private final Handler main = new Handler(Looper.getMainLooper());

    private Model model = null;
    private Recognizer recognizer = null;
    private AudioRecord audio = null;
    private Thread worker = null;

    private volatile boolean running = false;
    private volatile boolean cancelled = false;
    /** 已经出的完整句子，stop 时合并成一条 final。 */
    private final StringBuilder collected = new StringBuilder();
    private String lastPartial = "";

    public DshVoskEngine(Context ctx, WebView webView) {
        this.ctx = ctx.getApplicationContext();
        this.webView = webView;
    }

    /* ---------------- 对外接口 ---------------- */

    /** 模型是否已经加载好（可以直接说话）。 */
    public boolean isReady() {
        return model != null;
    }

    /**
     * 预加载模型。
     *
     * 首次调用要把 44 MB 从 assets 解压到应用目录，再加载进内存 ——
     * 合计 2~8 秒（取决于闪存速度）。所以必须异步，且要能显示进度。
     */
    public void prepare(final Runnable onReady, final Runnable onError) {
        if (model != null) {
            if (onReady != null) main.post(onReady);
            return;
        }
        new Thread(() -> {
            try {
                File dir = new File(ctx.getFilesDir(), LOCAL_DIR);
                // 用 am/final.mdl 当"解压完成"的标记：只要它在，就说明上次解压成功了。
                // 不用目录是否存在 —— mkdirs 之后崩溃会留下空目录，那会误判。
                File marker = new File(dir, "am/final.mdl");
                if (!marker.exists()) {
                    // 优先用预压缩的 zip（如果这次构建带进去了）
                    if (hasAsset(ZIP_NAME)) {
                        unzipAsset(ZIP_NAME, ctx.getFilesDir());
                    } else if (hasAsset(ASSET_DIR)) {
                        copyAsset(ASSET_DIR, dir);
                    } else {
                        // 既没打包也没下载过：明确告诉调用方"缺模型"，别假装能工作
                        emit("{\"type\":\"error\",\"code\":\"model_missing\","
                                + "\"message\":\"还没有下载离线语音模型（设置 → 工具与扩展 → 语音输入）\"}");
                        if (onError != null) main.post(onError);
                        return;
                    }
                }
                model = new Model(dir.getAbsolutePath());
                if (onReady != null) main.post(onReady);
            } catch (Throwable e) {
                emit("{\"type\":\"error\",\"code\":\"model_load\",\"message\":"
                        + JSONObject.quote("离线语音模型加载失败：" + e.getMessage()) + "}");
                if (onError != null) main.post(onError);
            }
        }, "dsh-vosk-prepare").start();
    }

    /** 模型是否已经装在设备上（不管有没有加载进内存）。 */
    public boolean modelInstalled() {
        return new File(new File(ctx.getFilesDir(), LOCAL_DIR), "am/final.mdl").exists();
    }

    /** 这次构建有没有把模型打进 APK。 */
    public boolean modelBundled() {
        return hasAsset(ZIP_NAME) || hasAsset(ASSET_DIR);
    }

    /**
     * 下载并安装模型。
     *
     * 真正的下载逻辑在 {@link ModelDownloader} 里 —— 那里是纯 JDK 实现，
     * 可以脱离设备用本地 HTTP 服务器验证分片边界、续传偏移、合并顺序。
     * 这里只负责：防重入、把进度转成 WebView 事件、装完之后清理。
     */
    public void downloadModel(final Runnable onDone, final Runnable onError) {
        // 防重入：第二次点下载会起第二个线程，两个线程往同一批 part 文件写，
        // 结果是数据损坏且极难排查。这里一次性把门关上。
        synchronized (downloadLock) {
            if (downloading) return;
            downloading = true;
        }

        new Thread(() -> {
            File dir = new File(ctx.getCacheDir(), DL_DIR);
            try {
                emit("{\"type\":\"download\",\"pct\":0}");

                ModelDownloader.Result r = new ModelDownloader(
                        MODEL_URL,
                        dir,
                        pct -> emit("{\"type\":\"download\",\"pct\":" + pct + "}")
                ).download();

                emit("{\"type\":\"download\",\"pct\":100,\"state\":\"unzip\"}");
                installFromZip(r.file);
                model = null;

                // 只有成功才清理 —— 失败要留着分片，下次从断点继续
                deleteRecursive(dir);
                if (onDone != null) main.post(onDone);
            } catch (Throwable e) {
                String msg = e.getMessage() == null ? String.valueOf(e) : e.getMessage();
                emit("{\"type\":\"error\",\"code\":\"download\",\"message\":"
                        + JSONObject.quote("模型下载失败：" + msg + "（进度已保存，点重试会从断点继续）")
                        + "}");
                if (onError != null) main.post(onError);
            } finally {
                downloading = false;
            }
        }, "dsh-vosk-download").start();
    }

    /**
     * 把下载到的 zip 装成 filesDir/vosk-cn。
     *
     * 官方 zip 的顶层目录是 `vosk-model-small-cn-0.22/`，而我们要的是
     * `vosk-cn/`。所以先解到临时目录，再把唯一那一层目录改名搬过去 ——
     * 比在解压循环里做路径字符串替换更不容易出错。
     */
    private void installFromZip(File zip) throws IOException {
        File tmp = new File(ctx.getFilesDir(), "vosk-tmp");
        deleteRecursive(tmp);
        if (!tmp.mkdirs()) throw new IOException("无法创建临时目录");

        try (InputStream in = new FileInputStream(zip);
             java.util.zip.ZipInputStream zis =
                     new java.util.zip.ZipInputStream(in, java.nio.charset.StandardCharsets.UTF_8)) {
            java.util.zip.ZipEntry e;
            byte[] buf = new byte[64 * 1024];
            while ((e = zis.getNextEntry()) != null) {
                File out = new File(tmp, e.getName());
                if (!out.getCanonicalPath().startsWith(tmp.getCanonicalPath())) continue;
                if (e.isDirectory()) {
                    out.mkdirs();
                    continue;
                }
                File parent = out.getParentFile();
                if (parent != null && !parent.exists() && !parent.mkdirs()) {
                    throw new IOException("无法创建目录：" + parent);
                }
                try (OutputStream os = new FileOutputStream(out)) {
                    int n;
                    while ((n = zis.read(buf)) > 0) os.write(buf, 0, n);
                }
            }
        }

        File[] kids = tmp.listFiles(File::isDirectory);
        if (kids == null || kids.length == 0) {
            throw new IOException("压缩包里没有模型目录");
        }
        File src = kids[0];
        File dst = new File(ctx.getFilesDir(), LOCAL_DIR);
        deleteRecursive(dst);
        if (!src.renameTo(dst)) {
            throw new IOException("模型安装失败（无法移动目录）");
        }
        deleteRecursive(tmp);

        if (!new File(dst, "am/final.mdl").exists()) {
            throw new IOException("模型不完整（缺少 am/final.mdl）");
        }
    }

    private void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) {
            for (File k : kids) deleteRecursive(k);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    /** 开始收音识别。调用前必须 isReady()。 */
    public void start() {
        if (!isReady()) {
            emit("{\"type\":\"error\",\"code\":\"model_not_ready\",\"message\":\"离线语音模型还没准备好\"}");
            emitEnd("error");
            return;
        }
        if (ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            emit("{\"type\":\"error\",\"code\":\"permission\",\"message\":\"缺少麦克风权限\"}");
            emitEnd("error");
            return;
        }

        stopInternal(false);

        cancelled = false;
        collected.setLength(0);
        lastPartial = "";

        try {
            recognizer = new Recognizer(model, SAMPLE_RATE);
        } catch (Throwable e) {
            emit("{\"type\":\"error\",\"code\":\"init\",\"message\":"
                    + JSONObject.quote("识别器初始化失败：" + e.getMessage()) + "}");
            emitEnd("error");
            return;
        }

        int minBuf = AudioRecord.getMinBufferSize(
                SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        int bufSize = Math.max(minBuf, CHUNK * 4);

        try {
            audio = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, bufSize);
        } catch (Throwable e) {
            emit("{\"type\":\"error\",\"code\":\"audio\",\"message\":"
                    + JSONObject.quote("无法打开麦克风：" + e.getMessage()) + "}");
            emitEnd("error");
            cleanup();
            return;
        }

        if (audio.getState() != AudioRecord.STATE_INITIALIZED) {
            emit("{\"type\":\"error\",\"code\":\"audio\",\"message\":\"麦克风被占用或不可用\"}");
            emitEnd("error");
            cleanup();
            return;
        }

        try {
            audio.startRecording();
        } catch (Throwable e) {
            emit("{\"type\":\"error\",\"code\":\"audio\",\"message\":"
                    + JSONObject.quote("麦克风启动失败：" + e.getMessage()) + "}");
            emitEnd("error");
            cleanup();
            return;
        }

        running = true;
        emit("{\"type\":\"ready\"}");

        worker = new Thread(this::loop, "dsh-vosk-rec");
        worker.start();
    }

    /** 停止并给出最终结果。 */
    public void stop() {
        stopInternal(true);
    }

    /** 立刻丢弃，不要结果。 */
    public void cancel() {
        cancelled = true;
        stopInternal(false);
    }

    /** 自检用。 */
    public String diagnose() {
        JSONObject o = new JSONObject();
        try {
            o.put("ready", isReady());
            File dir = new File(ctx.getFilesDir(), LOCAL_DIR);
            o.put("extracted", new File(dir, "am/final.mdl").exists());
            o.put("sampleRate", SAMPLE_RATE);
            o.put("installed", modelInstalled());
            o.put("bundled", modelBundled());
        } catch (Exception ignored) {
        }
        return o.toString();
    }

    /* ---------------- 识别循环 ---------------- */

    private void loop() {
        byte[] buf = new byte[CHUNK];
        long lastVolume = 0;

        while (running) {
            int n;
            try {
                n = audio.read(buf, 0, buf.length);
            } catch (Throwable e) {
                break;
            }
            if (n <= 0) continue;

            // 音量：给 UI 一个"它在听"的反馈。0~10 与系统识别的事件格式保持一致。
            long now = System.currentTimeMillis();
            if (now - lastVolume > 100) {
                lastVolume = now;
                emit("{\"type\":\"volume\",\"rms\":" + rmsOf(buf, n) + "}");
            }

            try {
                if (recognizer.acceptWaveForm(buf, n)) {
                    // 检测到一句结束：收进累积区，等 stop 时一起给。
                    // 不在这里 emit final —— JS 的状态机会因为 final 进 finishing，
                    // 而用户可能还要继续说。
                    String text = field(recognizer.getResult(), "text");
                    if (!text.isEmpty()) {
                        if (collected.length() > 0) collected.append("，");
                        collected.append(text);
                    }
                    lastPartial = "";
                } else {
                    String p = field(recognizer.getPartialResult(), "partial");
                    if (!p.isEmpty() && !p.equals(lastPartial)) {
                        lastPartial = p;
                        emit("{\"type\":\"partial\",\"text\":" + JSONObject.quote(p) + "}");
                    }
                }
            } catch (Throwable e) {
                break;
            }
        }
    }

    private void stopInternal(boolean deliver) {
        boolean wasRunning = running;
        running = false;

        if (worker != null) {
            try {
                worker.join(800);
            } catch (InterruptedException ignored) {
            }
            worker = null;
        }

        String tail = "";
        if (deliver && !cancelled && recognizer != null) {
            try {
                // 把缓冲里最后没断句的部分取出来
                tail = field(recognizer.getFinalResult(), "text");
            } catch (Throwable ignored) {
            }
        }

        cleanup();

        if (!wasRunning && !deliver) return;

        String full = collected.toString();
        if (!tail.isEmpty()) {
            full = full.isEmpty() ? tail : full + "，" + tail;
        }

        if (deliver && !cancelled) {
            if (!full.isEmpty()) {
                emit("{\"type\":\"final\",\"text\":" + JSONObject.quote(full) + "}");
            }
        }
        emitEnd(deliver && !cancelled ? "stop" : "cancel");
    }

    private void cleanup() {
        if (audio != null) {
            try {
                if (audio.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) {
                    audio.stop();
                }
            } catch (Throwable ignored) {
            }
            try {
                audio.release();
            } catch (Throwable ignored) {
            }
            audio = null;
        }
        if (recognizer != null) {
            try {
                recognizer.close();
            } catch (Throwable ignored) {
            }
            recognizer = null;
        }
    }

    /* ---------------- 工具 ---------------- */

    private int rmsOf(byte[] buf, int n) {
        long sum = 0;
        int count = n / 2;
        for (int i = 0; i + 1 < n; i += 2) {
            // 小端 16 位有符号
            int s = (short) ((buf[i] & 0xff) | (buf[i + 1] << 8));
            sum += (long) s * s;
        }
        if (count == 0) return 0;
        double rms = Math.sqrt((double) sum / count);
        // 32768 满量程 → 0~10 档，用对数压缩，否则正常说话永远显示 1
        double level = 20 * Math.log10(Math.max(rms, 1) / 32768.0); // -90 ~ 0 dB
        int v = (int) Math.round((level + 60) / 6); // -60dB→0, 0dB→10
        return Math.max(0, Math.min(10, v));
    }

    /** 从 Vosk 的 JSON 结果里取一个字符串字段，不引第三方 JSON。 */
    private static String field(String json, String key) {
        if (json == null) return "";
        try {
            Object v = new JSONObject(json).opt(key);
            return v == null ? "" : String.valueOf(v).trim();
        } catch (Throwable e) {
            return "";
        }
    }

    /* ---------------- assets 解压 ---------------- */

    /**
     * 递归把 assets 下的目录复制到 filesDir。
     *
     * 不用 Vosk 自带的 StorageService：那个类的签名在小版本间变过，
     * 而这里只依赖 Model / Recognizer 两个稳定的类，风险小得多。
     */
    private void copyAsset(String assetPath, File target) throws IOException {
        String[] children = ctx.getAssets().list(assetPath);
        if (children == null || children.length == 0) {
            copyFile(assetPath, target);
            return;
        }
        if (!target.exists() && !target.mkdirs()) {
            throw new IOException("无法创建目录：" + target);
        }
        for (String child : children) {
            copyAsset(assetPath + "/" + child, new File(target, child));
        }
    }

    /** assets 里有没有这个文件（不用抛异常来判断）。 */
    private boolean hasAsset(String name) {
        try {
            ctx.getAssets().open(name).close();
            return true;
        } catch (Throwable e) {
            return false;
        }
    }

    /**
     * 把 assets 里的 zip 直接解到目标目录。
     *
     * zip 里的路径是 `vosk-cn/am/final.mdl` 这种，所以解压目标是 filesDir，
     * 解出来正好是 filesDir/vosk-cn/…，与本类的 LOCAL_DIR 对上。
     *
     * 用 ZipInputStream 流式解 —— 不要先把 44 MB 读进内存再解，
     * 那在低端机上是一次真实的 OOM 风险。
     */
    private void unzipAsset(String name, File targetDir) throws IOException {
        try (InputStream in = ctx.getAssets().open(name);
             java.util.zip.ZipInputStream zis = new java.util.zip.ZipInputStream(in, java.nio.charset.StandardCharsets.UTF_8)) {
            java.util.zip.ZipEntry e;
            byte[] buf = new byte[64 * 1024];
            while ((e = zis.getNextEntry()) != null) {
                File out = new File(targetDir, e.getName());
                // 防 zip slip：条目路径不能跳出目标目录
                if (!out.getCanonicalPath().startsWith(targetDir.getCanonicalPath())) {
                    continue;
                }
                if (e.isDirectory()) {
                    out.mkdirs();
                    continue;
                }
                File parent = out.getParentFile();
                if (parent != null && !parent.exists() && !parent.mkdirs()) {
                    throw new IOException("无法创建目录：" + parent);
                }
                try (OutputStream os = new FileOutputStream(out)) {
                    int n;
                    while ((n = zis.read(buf)) > 0) {
                        os.write(buf, 0, n);
                    }
                }
            }
        }
    }

    private void copyFile(String assetPath, File target) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("无法创建目录：" + parent);
        }
        try (InputStream in = ctx.getAssets().open(assetPath);
             OutputStream out = new FileOutputStream(target)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
        }
    }

    /* ---------------- 事件 ---------------- */

    private void emitEnd(String reason) {
        emit("{\"type\":\"end\",\"reason\":" + JSONObject.quote(reason) + "}");
    }

    private void emit(final String json) {
        if (webView == null) return;
        main.post(() -> {
            try {
                webView.evaluateJavascript(
                        "(function(){try{window.__dshSpeechEvent&&window.__dshSpeechEvent("
                                + json + ");}catch(e){}})();", null);
            } catch (Throwable ignored) {
            }
        });
    }
}
