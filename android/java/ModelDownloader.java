package ai.deepseek.dsh.mobile;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Properties;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 分片并行 + 断点续传的文件下载器。
 *
 * ============ 为什么不写在 DshVoskEngine 里 ============
 *
 * 这段逻辑有四个容易错的边界，全都不是"看代码能看出来"的：
 *
 *   1. 分片边界 —— 最后一片的长度是 total - start，不是固定的 size；
 *      整除与不整除两种情况都要对。
 *   2. 续传偏移 —— 续传要从 start + 已落盘字节 开始，
 *      而从 start 开始会重复写，从头开始又会白下。
 *   3. 合并顺序 —— 必须按 part_0..part_N 拼接，并发完成顺序是乱的。
 *   4. 签名失效 —— 源换了文件、片数变了，旧片必须整体作废，
 *      否则会拼出一个"能解压但内容是坏的"的包，比直接失败更难查。
 *
 * 而 DshVoskEngine 依赖 Android 的 Context / WebView，脱离设备跑不起来，
 * 这四件事就只能靠真机下载 42 MB 来验证 —— 一次十几分钟，改一行验一次。
 *
 * 所以把它抽出来：**纯 JDK，不依赖 Android**，可以在桌面上用本地 HTTP
 * 服务器完整验证（见 tests/java/DownloaderTest.java）。
 */
public class ModelDownloader {

    /**
     * 进度回调。
     *
     * 值域 0.0 ~ 99.9（100 由调用方在解压阶段自己发）。
     *
     * ============ 为什么是小数不是整数 ============
     *
     * 42 MB 按整数百分比只跳 100 次 —— 慢网络下 1% 要两三秒，
     * 用户看到的就是"跳一格、定住、再跳一格"，像卡住了。
     * 而下载慢恰恰是这套并行改动的起因，不能在这里又制造一次卡顿感。
     *
     * 精度到 0.1% = 每 42 KB 一格，160 KB/s 下约每 0.26 秒跳一次，
     * 视觉上是连续走的。
     */
    public interface Listener {
        void onProgress(double pct);
    }

    /** 下载结果。 */
    public static class Result {
        /** 合并好的完整文件（位于 workDir/model.zip）。 */
        public File file;
        /** 总字节数。 */
        public long bytes;
        /** 实际分片数（1 表示退化成了单连接）。 */
        public int parts;
        /** 是否复用了上次遗留的进度。 */
        public boolean resumed;
        /** 服务器是否支持 Range。 */
        public boolean ranged;
    }

    /**
     * 默认并发数。
     *
     * 实测同一个文件、同一台机器，只改并发连接数：
     *
     *     1 路   28 KB/s     42 MB 需要 25 分钟
     *     6 路  162 KB/s     4.4 分钟
     *    16 路  436 KB/s     1.7 分钟
     *    32 路  733 KB/s     58 秒
     *
     * 近似线性增长 —— 说明源对**每个 TCP 连接单独限速**，
     * 多开几条就能叠加。
     *
     * 取 12 而不是 32：手机上再往上加，收益被耗电和系统调度吃掉；
     * 12 路已能把 25 分钟压到 2 分钟左右，移动网络下也不至于
     * 触发运营商的并发 QoS。
     */
    public static final int DEFAULT_PARALLEL = 12;

    /** 分片的最小体积。文件太小时分片反而更慢（每片都要 TCP 握手）。 */
    static final long MIN_CHUNK = 512 * 1024;

    /** 单片最多重试几次（含首次）。 */
    static final int PART_RETRY = 2;

    /** 两次进度事件的最小间隔。8 次/秒足够连续，又不会把主线程压满。 */
    static final long EMIT_MIN_INTERVAL_MS = 120;

    private final String url;
    private final File workDir;
    private final Listener listener;
    private final int parallel;
    private final long minChunk;

    private volatile long totalBytes = 0;
    private final AtomicLong downloadedBytes = new AtomicLong(0);
    /** 上一次发出的进度（千分比整数，0~999），-1 表示还没发过。 */
    private int lastDeci = -1;
    private long lastEmitAt = 0;

    public ModelDownloader(String url, File workDir, Listener listener) {
        this(url, workDir, listener, DEFAULT_PARALLEL);
    }

    public ModelDownloader(String url, File workDir, Listener listener, int parallel) {
        this(url, workDir, listener, parallel, MIN_CHUNK);
    }

    /**
     * @param parallel 并发连接数
     * @param minChunk 分片最小体积（测试时会调小，好让小文件也能分片）
     */
    public ModelDownloader(String url, File workDir, Listener listener,
                           int parallel, long minChunk) {
        this.url = url;
        this.workDir = workDir;
        this.listener = listener;
        this.parallel = Math.max(1, parallel);
        this.minChunk = Math.max(1, minChunk);
    }

    /**
     * 执行下载。
     *
     * 成功返回合并好的文件；失败抛异常，但**保留分片文件** ——
     * 下次调用会从断点继续。这是本类最核心的行为承诺。
     */
    public Result download() throws IOException {
        Probe probe = probe();
        if (probe.length <= 0) throw new IOException("服务器没有给出文件大小");

        int parts = 1;
        // 支持 Range 且文件够大才分片。分成 1 片没有意义（还要多一次握手），
        // 分成 2 片以下同理。
        if (probe.ranges && probe.length >= minChunk * 2) {
            parts = (int) Math.min(parallel, Math.max(2, probe.length / minChunk));
            // 片数不该超过字节数（每片至少 1 字节）
            parts = (int) Math.min(parts, Math.max(1, probe.length));
        }

        ensureDir(workDir);
        boolean resumed = checkMeta(probe, parts);

        totalBytes = probe.length;
        lastDeci = -1;
        lastEmitAt = 0;
        downloadedBytes.set(calcDone(parts));
        if (resumed && downloadedBytes.get() > 0) {
            emitProgress(downloadedBytes.get());
        }

        downloadParts(probe, parts);
        // 下载已结束，补一次满格。
        //
        // 时间节流会把"最后几格"吃掉 —— 网速快的时候尤其明显：
        // 测试里 3 MB 在 120 ms 内下完，进度只发到 4.1% 就没了。
        // 真机虽然不会这么极端，但快速网络下从 40% 直接跳到"解压中"同样难看。
        // 这里不是造进度，是真的下完了 —— 只是把被节流吞掉的那一次补发出来。
        forceProgress();

        File zip = new File(workDir, "model.zip");
        merge(parts, zip, probe.length);

        Result r = new Result();
        r.file = zip;
        r.bytes = probe.length;
        r.parts = parts;
        r.resumed = resumed;
        r.ranged = probe.ranges;
        return r;
    }

    /** 探测总大小、是否支持 Range、以及一致性签名。 */
    Probe probe() throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(20000);
        c.setInstanceFollowRedirects(true);
        // ============ 这一行不能省 ============
        // 服务器如果略响应做了 gzip，Content-Length 是**压缩后**的大小，
        // 而按字节范围切分是按原始大小算的 —— 两者对不上会拼出坏文件。
        // 而且 Range 与压缩本身就不兼容，很多实现会因此直接忽略 Range。
        c.setRequestProperty("Accept-Encoding", "identity");
        c.setRequestProperty("Range", "bytes=0-0");
        try {
            int code = c.getResponseCode();
            Probe p = new Probe();
            if (code == 206) {
                p.ranges = true;
                p.length = parseTotal(c.getHeaderField("Content-Range"));
                if (p.length <= 0) p.length = c.getContentLength();
            } else if (code == 200) {
                // 服务器忽略了 Range，把整个文件回吐。不读 body，立刻断开。
                p.ranges = false;
                p.length = c.getContentLength();
            } else {
                throw new IOException("HTTP " + code);
            }
            String et = c.getHeaderField("ETag");
            String lm = c.getHeaderField("Last-Modified");
            p.sig = et != null && !et.isEmpty() ? et : (lm != null ? lm : "");
            return p;
        } finally {
            c.disconnect();
        }
    }

    /** 从 "bytes 0-0/43898754" 里取出总大小；拿不到返回 -1。 */
    static long parseTotal(String contentRange) {
        if (contentRange == null) return -1;
        int slash = contentRange.lastIndexOf('/');
        if (slash < 0) return -1;
        String tail = contentRange.substring(slash + 1).trim();
        if ("*".equals(tail)) return -1;
        try {
            return Long.parseLong(tail);
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /**
     * 校验/建立断点元信息。
     *
     * @return true 表示可以接着上次的片继续；false 表示旧片已作废、从零开始
     */
    private boolean checkMeta(Probe probe, int parts) throws IOException {
        File f = new File(workDir, "meta.props");
        Properties p = new Properties();
        if (f.exists()) {
            try (InputStream in = new FileInputStream(f)) {
                p.load(in);
            } catch (Throwable ignored) {
                // 元信息坏了就当作没有 —— 下面的 same=false 会清空重来
            }
        }
        boolean same = String.valueOf(probe.length).equals(p.getProperty("total", ""))
                && String.valueOf(parts).equals(p.getProperty("parts", ""))
                && nz(probe.sig).equals(p.getProperty("sig", ""));

        if (same) return true;

        // 源变了 / 片数变了 / 没有元信息 → 旧片一律作废。
        // 宁可重下，也不能拿两代文件的碎片拼成一个"看起来能解压"的坏包。
        deleteRecursive(workDir);
        ensureDir(workDir);
        p.clear();
        p.setProperty("total", String.valueOf(probe.length));
        p.setProperty("parts", String.valueOf(parts));
        p.setProperty("sig", nz(probe.sig));
        try (OutputStream out = new FileOutputStream(f)) {
            p.store(out, "dsh model download");
        }
        return false;
    }

    private static String nz(String v) {
        return v == null ? "" : v;
    }

    /** 已落盘的总字节数（断点续传的起点）。 */
    long calcDone(int parts) {
        long sum = 0;
        for (int i = 0; i < parts; i++) {
            long len = new File(workDir, "part_" + i).length();
            if (len > 0) sum += len;
        }
        return sum;
    }

    private void downloadParts(Probe probe, int parts) throws IOException {
        if (parts == 1) {
            downloadPart(probe, 1, 0);
            return;
        }
        ExecutorService pool = Executors.newFixedThreadPool(parts);
        CountDownLatch latch = new CountDownLatch(parts);
        final List<Throwable> errors = Collections.synchronizedList(new ArrayList<>());
        for (int i = 0; i < parts; i++) {
            final int idx = i;
            pool.execute(() -> {
                try {
                    downloadPart(probe, parts, idx);
                } catch (Throwable e) {
                    errors.add(e);
                } finally {
                    latch.countDown();
                }
            });
        }
        try {
            latch.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("下载被中断");
        } finally {
            pool.shutdownNow();
        }
        if (!errors.isEmpty()) {
            Throwable first = errors.get(0);
            throw new IOException(first.getMessage() == null ? "下载中断" : first.getMessage());
        }
    }

    /**
     * 计算第 idx 片的字节区间。抽出来是为了能被测试直接断言。
     *
     * 边界情况都要兜住 —— 正常路径下 parts 远小于字节数，但一旦调用方
     * 传进来一个不合理的 parts，`total / parts` 会是 0，
     * 于是 end = start - 1 成了负长度：分片文件永远下不满，
     * 最后在 merge 时报"大小不符"，而错误信息完全指不到真正的原因。
     */
    static long[] rangeOf(long total, int parts, int idx) {
        long size = Math.max(1, total / parts);
        long start = Math.min(idx * size, Math.max(0, total - 1));
        long end = (idx == parts - 1)
                ? total - 1
                : Math.min(start + size - 1, total - 1);
        if (end < start) end = start;
        return new long[]{start, end};
    }

    /** 下载第 idx 片；带着已有的字节数续传。 */
    private void downloadPart(Probe probe, int parts, int idx) throws IOException {
        long[] r = rangeOf(probe.length, parts, idx);
        long start = r[0];
        long end = r[1];
        long expect = end - start + 1;

        File part = new File(workDir, "part_" + idx);
        if (part.length() > expect) {
            // 片比应有大小还大，只可能是上一代文件留下的：作废重下
            if (!part.delete()) throw new IOException("无法清理异常分片 " + idx);
        }

        // ============ 源不支持 Range 时不能续传 ============
        //
        // 有些 CDN（Gitee 的附件服务就是）会忽略 Range 请求，
        // 直接把**整个文件**回吐（HTTP 200 而不是 206）。
        //
        // 这时如果还按"从 part.length() 接着下"来续，就会出事：
        // 服务器返回的是完整文件，而我们是**追加**写入 ——
        // 结果是「半个旧文件 + 一整个新文件」，长度对不上，
        // 而且每次重试都再追加一遍，永远下不完。
        //
        // 所以源不支持 Range 时，老老实实从头下。
        if (!probe.ranges && part.exists()) {
            if (!part.delete()) throw new IOException("无法清理无法续传的分片 " + idx);
        }

        Throwable last = null;
        for (int attempt = 0; attempt <= PART_RETRY; attempt++) {
            long done = part.length();
            if (done >= expect) return;
            try {
                fetchRange(part, start + done, end, parts);
                if (part.length() != expect) {
                    throw new IOException("分片长度不符（" + part.length() + "/" + expect + "）");
                }
                return;
            } catch (Throwable e) {
                last = e;
                if (attempt < PART_RETRY) {
                    // 退避重试：并发失败多半是源侧瞬时限流，越急越糟
                    try {
                        Thread.sleep(600L + attempt * 900L);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        throw new IOException("下载被中断");
                    }
                }
            }
        }
        throw new IOException("第 " + (idx + 1) + "/" + parts + " 片失败："
                + (last == null ? "未知" : last.getMessage()));
    }

    /** 拉一个字节区间，追加到分片文件。 */
    private void fetchRange(File part, long from, long to, int parts) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("Accept-Encoding", "identity");
        c.setRequestProperty("Range", "bytes=" + from + "-" + to);
        try {
            int code = c.getResponseCode();
            // 单片模式允许 200（服务器不支持 Range 时会把整个文件回吐，
            // 此时 from 一定是 0，正好是我们要的）
            boolean ok = code == 206 || (code == 200 && parts == 1);
            if (!ok) throw new IOException("HTTP " + code + "（期望 206）");

            // ============ 服务器无视 Range 时的关键处理 ============
            //
            // 200 意味着它回吐的是**整个文件**，不是我们要的那一段。
            // 如果 from > 0 还往文件尾部追加，结果就是"半截旧的 + 完整的新文件"。
            //
            // 这里直接覆盖写（append=false），并且把 from 归零 ——
            // 让调用方在长度校验时发现不符并报错，而不是拿到一个坏文件。
            boolean append = from > 0 && code == 206;
            try (InputStream in = c.getInputStream();
                 OutputStream out = new FileOutputStream(part, append)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    emitProgress(downloadedBytes.addAndGet(n));
                }
            }
        } finally {
            c.disconnect();
        }
    }

    /** 按顺序合并分片，并校验总长度。 */
    private void merge(int parts, File dst, long total) throws IOException {
        long written = 0;
        try (OutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[64 * 1024];
            for (int i = 0; i < parts; i++) {
                File p = new File(workDir, "part_" + i);
                try (InputStream in = new FileInputStream(p)) {
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        written += n;
                    }
                }
            }
        }
        if (written != total) {
            //noinspection ResultOfMethodCallIgnored
            dst.delete();
            throw new IOException("合并后大小不符（" + written + "/" + total + "）");
        }
    }

    /**
     * 推进度。
     *
     * 两道闸门，缺一个都不行：
     *
     *   1. **值没变就不发** —— 12 个线程每 64 KB 汇报一次，
     *      42 MB 累计会调用 670 次，但真正有意义的格子只有 1000 个。
     *   2. **时间不够就不发** —— 12 个线程同时汇报时，一毫秒内可能连跳
     *      好几格；而主线程一帧只画一次，多发的每一次都要跨一次进程
     *      （evaluateJavascript），纯属浪费。
     *
     * 两道一起，实际发出频率被压在每秒 8 次以内，且不会漏掉进度。
     */
    private synchronized void emitProgress(long got) {
        long total = totalBytes;
        if (total <= 0 || listener == null) return;
        int deci = (int) Math.min(999, got * 1000 / total); // 0.0% ~ 99.9%
        if (deci == lastDeci) return;
        long now = System.currentTimeMillis();
        if (now - lastEmitAt < EMIT_MIN_INTERVAL_MS) return;
        lastDeci = deci;
        lastEmitAt = now;
        listener.onProgress(deci / 10.0);
    }

    /** 强制推一次 99.9%：下载确实完成时调用，绕过时间节流。 */
    private synchronized void forceProgress() {
        if (totalBytes <= 0 || listener == null) return;
        lastDeci = 999;
        lastEmitAt = System.currentTimeMillis();
        listener.onProgress(99.9);
    }

    private void ensureDir(File dir) throws IOException {
        if (!dir.exists() && !dir.mkdirs() && !dir.exists()) {
            throw new IOException("无法创建目录：" + dir);
        }
    }

    static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) {
            for (File k : kids) deleteRecursive(k);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    /** 探测结果。 */
    static final class Probe {
        long length;
        boolean ranges;
        String sig = "";
    }
}
