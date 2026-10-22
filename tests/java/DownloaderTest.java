package ai.deepseek.dsh.mobile;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.Closeable;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * ModelDownloader 的真实测试。
 *
 * ============ 为什么值得单独写 ============
 *
 * 下载逻辑有四个边界，全都是"看代码看不出来、真机试一次十几分钟"的那种：
 *
 *   1. 分片边界（整除 / 不整除 / 最后一片）
 *   2. 续传偏移（从 start + 已落盘字节 开始，不能多也不能少）
 *   3. 合并顺序（并发完成顺序是乱的，拼接必须按 index）
 *   4. 签名失效（源换了必须整批作废，否则拼出坏包）
 *
 * 用一个本地 HTTP 服务器把四种情况都造出来，跑一次几秒钟。
 *
 * 编译运行：
 *   javac -d out ModelDownloader.java DownloaderTest.java
 *   java -cp out ai.deepseek.dsh.mobile.DownloaderTest
 */
public class DownloaderTest {

    static int pass = 0;
    static int fail = 0;

    static void check(String name, boolean ok, String detail) {
        if (ok) {
            pass++;
            System.out.println("  ✓ " + name);
        } else {
            fail++;
            System.out.println("  ✗ " + name + "  →  " + detail);
        }
    }

    /* ============================================================
       测试用的 HTTP 服务器
       ============================================================ */

    static class Srv implements Closeable {
        final HttpServer http;
        final byte[] body;
        volatile String etag = "\"v1\"";
        volatile boolean supportRange = true;
        volatile int delayMs = 0;
        /** 第 N 个请求：只发一半就断开（用来造"一次瞬断"，重试能自愈）。0 = 关闭。 */
        volatile int cutAtRequest = 0;

        /**
         * 凡是字节起点 < failBelow 的 Range 请求，统统发一半就断开。
         *
         * `cutAtRequest` 只断"那一次"，重试就成功了 —— 用来测自愈。
         * 要测"重试也救不回来"，必须让**同一个片**每次都被打断，
         * 所以按区间起点判断，而不是按请求序号。
         */
        volatile long failBelow = -1;

        /**
         * 带宽限速（字节/秒），0 = 不限。
         *
         * 不能用"每请求 sleep 固定毫秒"来模拟慢 —— 那测不出并发的价值：
         * 单请求延迟 120ms，并发 6 请求每个也只延迟 120ms，总耗时一样。
         * 真实情况是**每个连接各自限速**，数据量越大越慢，
         * 所以必须按字节数结算时间。
         */
        volatile long bytesPerSec = 0;

        final AtomicInteger active = new AtomicInteger();
        final AtomicInteger peak = new AtomicInteger();
        final AtomicLong served = new AtomicLong();
        final AtomicInteger requests = new AtomicInteger();

        Srv(byte[] body) throws IOException {
            this.body = body;
            http = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            // 线程数必须够：并发 12 时如果这里只有 1 个线程，请求会排队，
            // 测出来的"并发"是假的。
            http.setExecutor(Executors.newFixedThreadPool(32));
            http.createContext("/model.zip", this::handle);
            http.start();
        }

        String url() {
            return "http://127.0.0.1:" + http.getAddress().getPort() + "/model.zip";
        }

        void resetCounters() {
            served.set(0);
            requests.set(0);
            peak.set(0);
        }

        void handle(HttpExchange ex) {
            int n = requests.incrementAndGet();
            int now = active.incrementAndGet();
            peak.accumulateAndGet(now, Math::max);
            try {
                if (delayMs > 0) Thread.sleep(delayMs);

                String range = ex.getRequestHeaders().getFirst("Range");
                ex.getResponseHeaders().set("ETag", etag);
                ex.getResponseHeaders().set("Accept-Ranges", supportRange ? "bytes" : "none");

                long start = 0;
                long end = body.length - 1L;
                boolean partial = false;
                if (range != null && supportRange && range.startsWith("bytes=")) {
                    String spec = range.substring(6);
                    int dash = spec.indexOf('-');
                    String a = spec.substring(0, dash);
                    String b = spec.substring(dash + 1);
                    start = a.isEmpty() ? 0 : Long.parseLong(a);
                    if (!b.isEmpty()) end = Long.parseLong(b);
                    if (end >= body.length) end = body.length - 1;
                    partial = true;
                }

                long len = end - start + 1;
                ex.getResponseHeaders().set("Content-Type", "application/octet-stream");
                if (partial) {
                    ex.getResponseHeaders().set(
                            "Content-Range", "bytes " + start + "-" + end + "/" + body.length);
                    ex.sendResponseHeaders(206, len);
                } else {
                    ex.sendResponseHeaders(200, body.length);
                }

                OutputStream os = ex.getResponseBody();
                boolean cut = (cutAtRequest > 0 && n == cutAtRequest)
                        || (failBelow > 0 && start < failBelow && end > start);
                if (cut) {
                    int half = (int) (len / 2);
                    writeThrottled(os, (int) start, half);
                    os.flush();
                    served.addAndGet(half);
                    // 不发完直接关：客户端会看到提前 EOF
                    ex.close();
                    return;
                }
                writeThrottled(os, (int) start, (int) len);
                os.flush();
                served.addAndGet(len);
                ex.close();
            } catch (Exception e) {
                try {
                    ex.close();
                } catch (Exception ignored) {
                }
            } finally {
                active.decrementAndGet();
            }
        }

        /** 按 bytesPerSec 限速写出。限的是**这一条连接**，所以 N 条并发就是 N 倍吞吐。 */
        void writeThrottled(OutputStream os, int start, int len) throws Exception {
            byte[] buf = new byte[64 * 1024];
            int pos = start;
            int remaining = len;
            long sent = 0;
            long t0 = System.nanoTime();
            while (remaining > 0) {
                int n = Math.min(buf.length, remaining);
                os.write(body, pos, n);
                os.flush();
                pos += n;
                remaining -= n;
                sent += n;
                long rate = bytesPerSec;
                if (rate > 0) {
                    long shouldMs = sent * 1000L / rate;
                    long elapsedMs = (System.nanoTime() - t0) / 1_000_000L;
                    long sleep = shouldMs - elapsedMs;
                    if (sleep > 0) Thread.sleep(sleep);
                }
            }
        }

        @Override
        public void close() {
            http.stop(0);
        }
    }

    /* ============================================================
       工具
       ============================================================ */

    static byte[] randomBytes(int n) {
        byte[] b = new byte[n];
        new Random(42).nextBytes(b);
        return b;
    }

    static String sha256(byte[] b) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] d = md.digest(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : d) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    static String sha256(Path p) throws Exception {
        return sha256(Files.readAllBytes(p));
    }

    static Path tmpDir() throws IOException {
        return Files.createTempDirectory("dltest");
    }

    /* ============================================================
       一、分片区间计算（纯算术，最容易被"想当然"写错）
       ============================================================ */

    static void testRanges() {
        System.out.println("\n[1] 分片区间");

        // 整除：1000 / 4 = 250，四片等长
        long[][] r = new long[4][];
        for (int i = 0; i < 4; i++) r[i] = ModelDownloader.rangeOf(1000, 4, i);
        check("整除：首片从 0 开始", r[0][0] == 0 && r[0][1] == 249, r[0][0] + "-" + r[0][1]);
        check("整除：次片接续无空洞", r[1][0] == 250 && r[1][1] == 499, r[1][0] + "-" + r[1][1]);
        check("整除：末片到 total-1", r[3][0] == 750 && r[3][1] == 999, r[3][0] + "-" + r[3][1]);

        // 不整除：1001 / 4 = 250 余 1，末片要多担 1 字节
        long[][] u = new long[4][];
        for (int i = 0; i < 4; i++) u[i] = ModelDownloader.rangeOf(1001, 4, i);
        long sum = 0;
        for (long[] x : u) sum += x[1] - x[0] + 1;
        check("不整除：四片之和等于总长", sum == 1001, "sum=" + sum);
        check("不整除：末片接续无空洞", u[3][0] == u[2][1] + 1, u[2][1] + " → " + u[3][0]);
        check("不整除：末片覆盖到 total-1", u[3][1] == 1000, String.valueOf(u[3][1]));

        // 1 片：整文件
        long[] one = ModelDownloader.rangeOf(999, 1, 0);
        check("单片：覆盖 0..total-1", one[0] == 0 && one[1] == 998, one[0] + "-" + one[1]);

        // 片数多于字节数（极端）：不能出现负数长度
        long[][] tiny = new long[5][];
        boolean noNegative = true;
        for (int i = 0; i < 5; i++) {
            tiny[i] = ModelDownloader.rangeOf(3, 5, i);
            if (tiny[i][1] < tiny[i][0]) noNegative = false;
        }
        check("片数>字节数：不产生负长度分片", noNegative, "");
    }

    /* ============================================================
       二、正常下载
       ============================================================ */

    static void testBasic(byte[] data, String want) throws Exception {
        System.out.println("\n[2] 正常下载");
        try (Srv s = new Srv(data)) {
            Path dir = tmpDir();
            List<Double> progress = new ArrayList<>();
            ModelDownloader.Result r = new ModelDownloader(
                    s.url(), dir.toFile(), progress::add).download();

            check("内容与源完全一致", sha256(r.file.toPath()).equals(want), "sha 不符");
            check("字节数正确", r.file.length() == data.length,
                    r.file.length() + " vs " + data.length);
            check("识别为支持 Range", r.ranged, "ranged=false");
            check("确实分了片", r.parts >= 2, "parts=" + r.parts);
            check("首次下载不是续传", !r.resumed, "resumed=true");
            check("进度单调不减", isMonotonic(progress), progress.toString());
            // 下了至少 1 条，且最后一次必须是满格 —— 下载完成时会强制补发，
            // 否则快速网络下会从 40% 直接跳到「解压中」
            check("进度至少上报一次", !progress.isEmpty(), "一条都没收到");
            check("最后一次进度是满格",
                    !progress.isEmpty() && progress.get(progress.size() - 1) >= 99,
                    String.valueOf(progress.isEmpty() ? "空" : progress.get(progress.size() - 1)));
        }
    }

    static boolean isMonotonic(List<Double> xs) {
        for (int i = 1; i < xs.size(); i++) {
            if (xs.get(i) < xs.get(i - 1)) return false;
        }
        return true;
    }

    /* ============================================================
       三、断点续传
       ============================================================ */

    static void testResume(byte[] data, String want) throws Exception {
        System.out.println("\n[3] 断点续传");
        try (Srv s = new Srv(data)) {
            Path dir = tmpDir();
            // 让 part_0 这个区间**每次**都被打断 —— 单片重试 3 次也救不回来，
            // 这样才能测到"整个下载失败、但进度保留"。
            // 用 cutAtRequest 只能造一次瞬断，会被重试吃掉（那个场景由 [6] 覆盖）。
            s.failBelow = data.length / 6;

            boolean threw = false;
            try {
                new ModelDownloader(s.url(), dir.toFile(), p -> { }).download();
            } catch (IOException e) {
                threw = true;
            }
            check("持续失败时如实抛错", threw, "没有抛异常");

            long leftover = 0;
            java.io.File[] parts = dir.toFile().listFiles();
            if (parts != null) {
                for (java.io.File f : parts) {
                    if (f.getName().startsWith("part_")) leftover += f.length();
                }
            }
            check("失败后保留已下的分片", leftover > 0, "leftover=" + leftover);

            // 第二次：服务器恢复正常
            s.failBelow = -1;
            s.resetCounters();
            ModelDownloader.Result r = new ModelDownloader(
                    s.url(), dir.toFile(), p -> { }).download();

            check("第二次识别为续传", r.resumed, "resumed=false");
            check("续传后内容正确", sha256(r.file.toPath()).equals(want), "sha 不符");
            check("续传没有白下全部字节", s.served.get() < data.length,
                    "第二次只下了 " + s.served.get() + " / " + data.length);
        }
    }

    /* ============================================================
       四、服务器不支持 Range → 退化为单连接
       ============================================================ */

    static void testNoRange(byte[] data, String want) throws Exception {
        System.out.println("\n[4] 服务器不支持 Range");
        try (Srv s = new Srv(data)) {
            s.supportRange = false;
            Path dir = tmpDir();
            ModelDownloader.Result r = new ModelDownloader(
                    s.url(), dir.toFile(), p -> { }).download();

            check("退化为单分片", r.parts == 1, "parts=" + r.parts);
            check("标记为不支持 Range", !r.ranged, "ranged=true");
            check("单连接下载内容仍正确", sha256(r.file.toPath()).equals(want), "sha 不符");
        }
    }

    /* ============================================================
       五、源换了文件 → 旧分片必须作废
       ============================================================ */

    static void testSourceChanged(byte[] data, String want) throws Exception {
        System.out.println("\n[5] 源文件已更换");
        try (Srv s = new Srv(data)) {
            Path dir = tmpDir();
            s.failBelow = data.length / 6; // 先制造一次"下了半截"的现场
            try {
                new ModelDownloader(s.url(), dir.toFile(), p -> { }).download();
            } catch (IOException ignored) {
            }

            s.failBelow = -1;
            s.etag = "\"v2\""; // 源站换了文件
            s.resetCounters();
            ModelDownloader.Result r = new ModelDownloader(
                    s.url(), dir.toFile(), p -> { }).download();

            check("ETag 变了就不再续传", !r.resumed, "resumed=true（会拼出坏包）");
            check("作废后重下的内容正确", sha256(r.file.toPath()).equals(want), "sha 不符");
            // 探针请求（Range: bytes=0-0）也会计入 served，所以是 >= 而非 ==
            check("确实整份重下", s.served.get() >= data.length,
                    "只下了 " + s.served.get() + " / " + data.length);
        }
    }

    /* ============================================================
       六、单片偶发失败 → 自动重试修好，不该整单失败
       ============================================================ */

    static void testTransientHeals(byte[] data, String want) throws Exception {
        System.out.println("\n[6] 单片偶发失败");
        try (Srv s = new Srv(data)) {
            Path dir = tmpDir();
            s.cutAtRequest = 1; // 只有第 1 个请求断，重试时请求序号已变，不会再断
            ModelDownloader.Result r = new ModelDownloader(
                    s.url(), dir.toFile(), p -> { }).download();
            check("单片瞬断能自愈", sha256(r.file.toPath()).equals(want), "sha 不符");
        }
    }

    /* ============================================================
       七、并发真的生效（这是整件事的意义所在）
       ============================================================ */

    static void testParallelism(byte[] data, String want) throws Exception {
        System.out.println("\n[7] 并发有效性");

        long serialMs;
        try (Srv s = new Srv(data)) {
            // 每个连接 2 MB/s —— 这才是"源对单连接限速"的真实形态。
            // 若改成"每请求固定延迟 120ms"，单请求和 6 并发的总耗时是一样的，
            // 根本测不出并发的价值（这个坑我踩过一次）。
            s.bytesPerSec = 2 * 1024 * 1024;
            Path dir = tmpDir();
            long t0 = System.currentTimeMillis();
            ModelDownloader.Result r = new ModelDownloader(
                    s.url(), dir.toFile(), p -> { }, 1).download();
            serialMs = System.currentTimeMillis() - t0;
            check("单连接下载正确", sha256(r.file.toPath()).equals(want), "sha 不符");
        }

        long parallelMs;
        int peak;
        try (Srv s = new Srv(data)) {
            s.bytesPerSec = 2 * 1024 * 1024;
            Path dir = tmpDir();
            long t0 = System.currentTimeMillis();
            ModelDownloader.Result r = new ModelDownloader(
                    s.url(), dir.toFile(), p -> { }, 12).download();
            parallelMs = System.currentTimeMillis() - t0;
            peak = s.peak.get();
            check("并发下载正确", sha256(r.file.toPath()).equals(want), "sha 不符");
            check("确实多连接同时进行", peak >= 4, "峰值并发=" + peak);
        }

        check("并发显著快于串行", parallelMs < serialMs * 0.6,
                "串行 " + serialMs + "ms / 并发 " + parallelMs + "ms");
        System.out.printf("      串行 %d ms  →  并发 %d ms（%.1f×）%n",
                serialMs, parallelMs, serialMs / (double) Math.max(1, parallelMs));
    }

    /* ============================================================
       八、Content-Range 解析
       ============================================================ */

    static void testParseTotal() {
        System.out.println("\n[8] Content-Range 解析");
        check("标准格式", ModelDownloader.parseTotal("bytes 0-0/43898754") == 43898754L,
                String.valueOf(ModelDownloader.parseTotal("bytes 0-0/43898754")));
        check("未知总长返回 -1", ModelDownloader.parseTotal("bytes 0-0/*") == -1, "");
        check("null 返回 -1", ModelDownloader.parseTotal(null) == -1, "");
        check("垃圾输入不抛异常", ModelDownloader.parseTotal("garbage") == -1, "");
    }

    /* ============================================================
       入口
       ============================================================ */

    public static void main(String[] args) throws Exception {
        System.out.println("ModelDownloader 测试");

        // 3 MB + 1 字节：故意不整除，顺便验证最后一片的长度
        byte[] data = randomBytes(3 * 1024 * 1024 + 1);
        String want = sha256(data);
        System.out.printf("测试数据：%d 字节，sha256=%s…%n", data.length, want.substring(0, 12));

        testRanges();
        testParseTotal();
        testBasic(data, want);
        testResume(data, want);
        testNoRange(data, want);
        testSourceChanged(data, want);
        testTransientHeals(data, want);
        testParallelism(data, want);

        System.out.printf("%n结果：%d 通过，%d 失败%n", pass, fail);
        if (fail > 0) System.exit(1);
    }
}
