package ai.deepseek.dsh.mobile;

import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * DSH 原生 HTTP 桥。
 *
 * WebView 里的 fetch 受同源策略、CORS 预检与流式读取限制，很多模型网关在
 * Android WebView 中会直接失败。这里用系统 HttpURLConnection 发 POST，
 * 把响应分块回传给页面，既绕开 CORS，也保留 SSE 的逐字输出。
 *
 * 协议（JS -> 原生）：
 *   postStream(id, url, headersJson, bodyJson, timeoutSec)
 *   abort(id)
 *
 * 协议（原生 -> JS，通过 window.__dshNativeEvent 单参数 JSON）：
 *   {id, type:"status", status}
 *   {id, type:"chunk", data}
 *   {id, type:"end"}
 *   {id, type:"error", status, message, body}
 */
public class DshHttpBridge {

    private final WebView webView;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, HttpURLConnection> active = new ConcurrentHashMap<>();

    public DshHttpBridge(WebView webView) {
        this.webView = webView;
    }

    @JavascriptInterface
    public void postStream(String id, String url, String headersJson, String bodyJson, int timeoutSec, String method) {
        postStream(id, url, headersJson, bodyJson, timeoutSec, method, 0, 0);
    }

    /**
     * 带「耐心值」的版本。
     *
     * @param firstByteSec 等第一个字节的上限；0 = 用默认 45 秒。
     *                     思考型模型（Agnes 3.0 之类）首字节可能 60 秒以上，
     *                     45 秒硬上限会把「正在思考」错判成「连接卡死」。
     * @param connectSec   连接超时；0 = 用默认 8 秒。跨境节点握手更慢。
     */
    @JavascriptInterface
    public void postStream(String id, String url, String headersJson, String bodyJson,
                           int timeoutSec, String method, int firstByteSec, int connectSec) {
        final String m = (method == null || method.isEmpty()) ? "POST" : method.toUpperCase();
        final long firstMs = firstByteSec > 0 ? firstByteSec * 1000L : FIRST_BYTE_MS;
        final int connectMs = connectSec > 0 ? connectSec * 1000 : CONNECT_TIMEOUT_MS;
        new Thread(() -> run(id, url, headersJson, bodyJson, timeoutSec, m, firstMs, connectMs),
                "dsh-http-" + id).start();
    }

    /**
     * 下载一个二进制资源（插件包、图片等），整段回传 Base64。
     *
     * ============ 为什么必须走原生 ============
     *
     * 页面里 fetch 一个第三方 URL 会被 CORS 挡住 —— 请求发得出去，
     * 响应读不到，JS 侧只看到一句 `TypeError: Failed to fetch`。
     * 而「从网址装插件」拉的一定是外部地址，所以这条路必须由原生走。
     *
     * 回传用 Base64 而不是分块文本：文本通道按 UTF-8 解码，二进制一到
     * 0x80 以上就坏了（zip 里全是这种字节）。
     *
     * @param id        请求 id，回传时带回来
     * @param url       目标地址
     * @param timeoutSec 读超时（秒）
     */
    @JavascriptInterface
    public void getBinary(String id, String url, int timeoutSec) {
        new Thread(() -> runBinary(id, url, timeoutSec), "dsh-bin-" + id).start();
    }

    @JavascriptInterface
    public void abort(String id) {
        HttpURLConnection conn = active.remove(id);
        if (conn != null) {
            try {
                conn.disconnect();
            } catch (Exception ignored) {
            }
        }
    }

    /**
     * 一次请求的运行时状态。看门狗靠它判断"是不是卡住了"。
     */
    private static final class Req {
        final HttpURLConnection conn;
        final long startAt;
        final long firstByteMs;
        final long idleMs;
        volatile long lastAt;
        volatile boolean firstByte;
        /** 被看门狗掐断时写在这里，异常分支据此给出人话。 */
        volatile String timeoutReason = "";

        Req(HttpURLConnection conn, long firstByteMs, long idleMs) {
            this.conn = conn;
            this.startAt = System.currentTimeMillis();
            this.lastAt = this.startAt;
            this.firstByteMs = firstByteMs;
            this.idleMs = idleMs;
        }
    }

    private static final Map<String, Req> META = new ConcurrentHashMap<>();

    /**
     * 卡死检测。
     *
     * ============ 为什么需要它 ============
     *
     * HttpURLConnection 只有一个读超时，没法分别表达
     * 「多久没收到第一个字节」和「流中间停了多久」。
     *
     * 而这两件事的合理阈值差了两个数量级：首字节超过 45 秒基本就是
     * 网关卡住了（等下去也没用），但一个长回答中间停 30 秒可能是
     * 模型在思考，不该掐。
     *
     * 所以另起一个线程看着：谁超了就 disconnect，让阻塞的 read 抛异常。
     */
    private static final ScheduledExecutorService WATCHDOG =
            Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "dsh-http-watchdog");
                t.setDaemon(true);
                return t;
            });

    static {
        WATCHDOG.scheduleAtFixedRate(() -> {
            long now = System.currentTimeMillis();
            for (Map.Entry<String, Req> e : META.entrySet()) {
                Req r = e.getValue();
                try {
                    if (!r.firstByte && now - r.startAt > r.firstByteMs) {
                        r.timeoutReason = "等待响应超时：" + (r.firstByteMs / 1000) + " 秒内没有收到任何数据";
                        r.conn.disconnect();
                    } else if (r.firstByte && now - r.lastAt > r.idleMs) {
                        r.timeoutReason = "连接空闲超过 " + (r.idleMs / 1000) + " 秒，已中断";
                        r.conn.disconnect();
                    }
                } catch (Exception ignored) {
                }
            }
        }, 1, 1, TimeUnit.SECONDS);
    }

    /** 首字节超时：连上了但服务端一直不吐字。 */
    private static final long FIRST_BYTE_MS = 45_000L;

    /** 流式空闲超时：两块数据之间最多等这么久。 */
    private static final long STREAM_IDLE_MS = 120_000L;

    /** 连接超时：弱网下宁可快点失败去重试，也不要干等。 */
    private static final int CONNECT_TIMEOUT_MS = 8000;

    private void run(String id, String url, String headersJson, String bodyJson, int timeoutSec, String method,
                     long firstByteMs, int connectTimeoutMs) {
        HttpURLConnection conn = null;
        Req meta = null;
        boolean hasBody = !"GET".equals(method);
        // 读完流之后不能 disconnect —— 见 finally 里的说明
        boolean reusable = false;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod(method);
            conn.setConnectTimeout(connectTimeoutMs);
            // 读超时给一个足够大的上限，真正的卡死判定交给看门狗：
            // 它区分"首字节"和"流中途停顿"，比一个笼统的读超时准得多。
            conn.setReadTimeout((int) Math.max(15, timeoutSec) * 1000);
            // doOutput 只能在有请求体时才开。
            // HttpURLConnection.setDoOutput(true) 会把方法从 GET 悄悄改成 POST
            // （JDK 实现里就是这么干的），而「拉取插件清单」必须是真的 GET。
            conn.setDoOutput(hasBody);
            conn.setDoInput(true);
            conn.setUseCaches(false);
            conn.setRequestProperty("Accept", "text/event-stream, application/json");
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            // 明确要求复用连接。默认就是 keep-alive，但显式写出来
            // 免得中间经过的代理按 http/1.0 的默认值把连接关掉。
            conn.setRequestProperty("Connection", "keep-alive");

            JSONObject headers = new JSONObject(headersJson == null ? "{}" : headersJson);
            for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                String key = it.next();
                String value = headers.optString(key, "");
                if (!value.isEmpty()) conn.setRequestProperty(key, value);
            }

            active.put(id, conn);
            meta = new Req(conn, firstByteMs, STREAM_IDLE_MS);
            META.put(id, meta);

            if (hasBody) {
                byte[] payload = (bodyJson == null ? "{}" : bodyJson).getBytes(StandardCharsets.UTF_8);
                conn.setFixedLengthStreamingMode(payload.length);
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(payload);
                    out.flush();
                }
            }

            int status = conn.getResponseCode();
            emitStatus(id, status);

            if (status < 200 || status >= 300) {
                String body = readAll(conn.getErrorStream());
                if (body.isEmpty()) body = readAll(conn.getInputStream());
                emitError(id, status, "HTTP " + status, body, retryAfterOf(conn));
                return;
            }

            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                char[] buffer = new char[4096];
                int n;
                while ((n = reader.read(buffer)) >= 0) {
                    if (!active.containsKey(id)) return; // 已被 abort
                    if (n > 0) {
                        if (meta != null) {
                            meta.firstByte = true;
                            meta.lastAt = System.currentTimeMillis();
                        }
                        emitChunk(id, new String(buffer, 0, n));
                    }
                }
            }
            active.remove(id);
            META.remove(id);
            // ============ 关键：正常结束不要 disconnect ============
            //
            // InputStream 已经在 try-with-resources 里关掉了，
            // 连接这时会**自动归还连接池**，下一个请求可以直接复用
            // （省掉 TCP + TLS 握手，弱网下一次能省几百毫秒到一秒）。
            //
            // 调了 disconnect() 就等于通知底层"这条连接不要了"，
            // 池子会把它关掉 —— 于是每个请求、每一轮工具调用都要重新握手。
            reusable = true;
            emitEnd(id);
        } catch (Exception err) {
            boolean aborted = !active.containsKey(id);
            String reason = meta != null ? meta.timeoutReason : "";
            active.remove(id);
            META.remove(id);
            if (!aborted) {
                if (!reason.isEmpty()) {
                    // 看门狗掐断的：库里抛的是 SocketException，对用户没有意义，
                    // 换成他真正需要知道的那句
                    emitError(id, 0, reason, "", 0);
                } else {
                    emitError(id, 0, err.getClass().getSimpleName() + ": " + String.valueOf(err.getMessage()), "", 0);
                }
            }
        } finally {
            active.remove(id);
            META.remove(id);
            if (conn != null && !reusable) {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {
                }
            }
        }
    }

    /** 服务端要求的重试间隔（秒）。没有就是 0。 */
    private long retryAfterOf(HttpURLConnection conn) {
        try {
            String v = conn.getHeaderField("Retry-After");
            if (v == null) return 0;
            return Math.max(0, Math.min(600, Long.parseLong(v.trim())));
        } catch (Exception e) {
            return 0;
        }
    }

    /** 单次下载的上限。Base64 会膨胀 4/3，再大就可能在低端机上 OOM。 */
    private static final int MAX_BINARY = 24 * 1024 * 1024;

    private void runBinary(String id, String url, int timeoutSec) {
        HttpURLConnection conn = null;
        // 同 run()：读完就归还连接池，不要主动断
        boolean reusable = false;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(Math.max(15, timeoutSec) * 1000);
            conn.setInstanceFollowRedirects(true);
            conn.setUseCaches(false);
            conn.setRequestProperty("Accept", "*/*");

            active.put(id, conn);
            int status = conn.getResponseCode();
            if (status < 200 || status >= 300) {
                String body = readAll(conn.getErrorStream());
                if (body.isEmpty()) body = readAll(conn.getInputStream());
                emitError(id, status, "HTTP " + status, body);
                return;
            }

            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            int total = 0;
            try (InputStream in = conn.getInputStream()) {
                while ((n = in.read(chunk)) >= 0) {
                    if (!active.containsKey(id)) return; // 已被 abort
                    if (n <= 0) continue;
                    total += n;
                    if (total > MAX_BINARY) {
                        emitError(id, status, "文件太大（超过 24 MB）", "");
                        return;
                    }
                    buf.write(chunk, 0, n);
                }
            }

            active.remove(id);
            reusable = true;
            String b64 = android.util.Base64.encodeToString(buf.toByteArray(), android.util.Base64.NO_WRAP);
            emitBytes(id, status, conn.getContentType(), b64);
        } catch (Exception err) {
            boolean aborted = !active.containsKey(id);
            active.remove(id);
            if (!aborted) {
                emitError(id, 0, err.getClass().getSimpleName() + ": " + String.valueOf(err.getMessage()), "");
            }
        } finally {
            active.remove(id);
            if (conn != null && !reusable) {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {
                }
            }
        }
    }

    private void emitBytes(String id, int status, String mime, String base64) {
        try {
            JSONObject obj = new JSONObject();
            obj.put("id", id);
            obj.put("type", "bytes");
            obj.put("status", status);
            obj.put("mime", mime == null ? "" : mime);
            obj.put("base64", base64);
            eval(obj.toString());
        } catch (Exception ignored) {
        }
    }

    private String readAll(InputStream stream) {
        if (stream == null) return "";
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            char[] buffer = new char[2048];
            int n;
            int total = 0;
            while ((n = reader.read(buffer)) >= 0 && total < 262144) {
                sb.append(buffer, 0, n);
                total += n;
            }
        } catch (Exception ignored) {
        }
        return sb.toString();
    }

    private void emitStatus(String id, int status) {
        try {
            JSONObject obj = new JSONObject();
            obj.put("id", id);
            obj.put("type", "status");
            obj.put("status", status);
            eval(obj.toString());
        } catch (Exception ignored) {
        }
    }

    private void emitChunk(String id, String data) {
        try {
            JSONObject obj = new JSONObject();
            obj.put("id", id);
            obj.put("type", "chunk");
            obj.put("data", data);
            eval(obj.toString());
        } catch (Exception ignored) {
        }
    }

    private void emitEnd(String id) {
        try {
            JSONObject obj = new JSONObject();
            obj.put("id", id);
            obj.put("type", "end");
            eval(obj.toString());
        } catch (Exception ignored) {
        }
    }

    private void emitError(String id, int status, String message, String body) {
        emitError(id, status, message, body, 0);
    }

    /**
     * @param retryAfter 服务端要求的重试间隔（秒）。页面据此决定等多久，
     *                   比它自己猜的指数退避更准 —— 429 之后立刻重试只会更糟。
     */
    private void emitError(String id, int status, String message, String body, long retryAfter) {
        try {
            JSONObject obj = new JSONObject();
            obj.put("id", id);
            obj.put("type", "error");
            obj.put("status", status);
            obj.put("message", message == null ? "请求失败" : message);
            obj.put("body", body == null ? "" : body);
            if (retryAfter > 0) obj.put("retryAfter", retryAfter);
            eval(obj.toString());
        } catch (Exception ignored) {
        }
    }

    private void eval(String json) {
        final String js = "window.__dshNativeEvent && window.__dshNativeEvent(" + JSONObject.quote(json) + ")";
        main.post(() -> {
            try {
                webView.evaluateJavascript(js, null);
            } catch (Exception ignored) {
            }
        });
    }
}
