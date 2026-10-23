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
        final String m = (method == null || method.isEmpty()) ? "POST" : method.toUpperCase();
        new Thread(() -> run(id, url, headersJson, bodyJson, timeoutSec, m), "dsh-http-" + id).start();
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

    private void run(String id, String url, String headersJson, String bodyJson, int timeoutSec, String method) {
        HttpURLConnection conn = null;
        boolean hasBody = !"GET".equals(method);
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod(method);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(Math.max(15, timeoutSec) * 1000);
            // doOutput 只能在有请求体时才开。
            // HttpURLConnection.setDoOutput(true) 会把方法从 GET 悄悄改成 POST
            // （JDK 实现里就是这么干的），而「拉取插件清单」必须是真的 GET。
            conn.setDoOutput(hasBody);
            conn.setDoInput(true);
            conn.setUseCaches(false);
            conn.setRequestProperty("Accept", "text/event-stream, application/json");
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");

            JSONObject headers = new JSONObject(headersJson == null ? "{}" : headersJson);
            for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                String key = it.next();
                String value = headers.optString(key, "");
                if (!value.isEmpty()) conn.setRequestProperty(key, value);
            }

            active.put(id, conn);

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
                emitError(id, status, "HTTP " + status, body);
                return;
            }

            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                char[] buffer = new char[4096];
                int n;
                while ((n = reader.read(buffer)) >= 0) {
                    if (!active.containsKey(id)) return; // 已被 abort
                    if (n > 0) emitChunk(id, new String(buffer, 0, n));
                }
            }
            active.remove(id);
            emitEnd(id);
        } catch (Exception err) {
            boolean aborted = !active.containsKey(id);
            active.remove(id);
            if (!aborted) {
                emitError(id, 0, err.getClass().getSimpleName() + ": " + String.valueOf(err.getMessage()), "");
            }
        } finally {
            active.remove(id);
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {
                }
            }
        }
    }

    /** 单次下载的上限。Base64 会膨胀 4/3，再大就可能在低端机上 OOM。 */
    private static final int MAX_BINARY = 24 * 1024 * 1024;

    private void runBinary(String id, String url, int timeoutSec) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(20000);
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
            if (conn != null) {
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
        try {
            JSONObject obj = new JSONObject();
            obj.put("id", id);
            obj.put("type", "error");
            obj.put("status", status);
            obj.put("message", message == null ? "请求失败" : message);
            obj.put("body", body == null ? "" : body);
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
