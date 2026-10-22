package ai.deepseek.dsh.mobile;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 手机本机 MCP 服务器（Streamable HTTP / JSON-RPC 2.0）。
 *
 * 存在的意义：dsh-mobile 是纯 WebView 应用，JS 层无法监听端口，
 * 所以「手机自己当 MCP 服务器」只能落在原生层。这里用 ServerSocket
 * 在 127.0.0.1:8788 起一个最小 HTTP 服务，协议按 dsh-mobile 的
 * scripts/mcp.js 客户端契约实现（initialize / tools/list / tools/call）。
 *
 * 好处：Web 运行时代码零改动 —— 它本来就是 MCP 客户端，
 * 只要在设置里把服务器 URL 填成 http://127.0.0.1:8788/mcp 即可。
 */
public final class DshMcpServer {

    private static final String TAG = "DshMcp";
    public static final int PORT = 8788;
    public static final String PROTOCOL = "2024-11-05";
    public static final String VERSION = "1.0.0";

    /** 留空 = 不校验；填了字符串则要求 Authorization: Bearer <TOKEN>。 */
    public static final String TOKEN = "";

    /**
     * false = 只监听 127.0.0.1（手机自己用，默认，最安全）。
     * true  = 监听 0.0.0.0，让同一局域网的电脑也能连过来控制这台手机；
     *         此时必须填 TOKEN，否则拒绝启动。
     */
    public static final boolean LAN = false;

    private static volatile DshMcpServer instance;

    private final Context appContext;
    private ServerSocket serverSocket;
    private Thread acceptThread;
    private volatile boolean running;
    /** 实际绑定的地址（重建 socket 时要复用）。 */
    private volatile String bindHost = "127.0.0.1";

    /**
     * 同时在处理的连接数。
     *
     * 每个连接一个线程，而线程没有天然上限。异常客户端（比如端口扫描、
     * 或者某个客户端反复超时重连）能把线程数堆到几百，最后是内存和调度一起崩。
     * 这里只做上限保护，不做排队 —— 超过就直接关掉连接，让它自己重试。
     */
    private final java.util.concurrent.atomic.AtomicInteger active =
            new java.util.concurrent.atomic.AtomicInteger();
    private static final int MAX_CONN = 24;

    private DshMcpServer(Context ctx) {
        this.appContext = ctx.getApplicationContext();
    }

    /** socket 是否真的还能 accept。instance 非空不代表它活着。 */
    private boolean alive() {
        ServerSocket s = serverSocket;
        return running && s != null && s.isBound() && !s.isClosed();
    }

    public static synchronized void start(Context ctx) {
        // ============ 死实例必须先清掉（0.27.1）============
        //
        // 旧代码 `if (instance != null) return;` 只看了「对象还在」。
        // 而 ServerSocket 可能已经被系统关掉、或者 accept 连续失败后处于不可用状态，
        // 这时 instance 仍然非空 —— 于是 start() 什么也不做，server 永远起不来，
        // 而 isRunning() 还一直报 true。用户看到的就是「显示在跑，但连不上」。
        DshMcpServer existing = instance;
        if (existing != null) {
            if (existing.alive()) return;
            Log.w(TAG, "发现失效实例，重建");
            stop();
        }

        DshMcpServer s = new DshMcpServer(ctx);
        try {
            boolean lan = LAN && TOKEN != null && !TOKEN.isEmpty();
            if (LAN && (TOKEN == null || TOKEN.isEmpty())) {
                Log.w(TAG, "LAN=true 但没有设置 TOKEN，出于安全只监听 127.0.0.1");
            }
            String host = lan ? "0.0.0.0" : "127.0.0.1";
            s.bindHost = host;
            s.serverSocket = new ServerSocket();
            s.serverSocket.setReuseAddress(true);
            s.serverSocket.bind(new InetSocketAddress(InetAddress.getByName(host), PORT));
            s.running = true;
            s.acceptThread = new Thread(s::acceptLoop, "dsh-mcp-accept");
            s.acceptThread.setDaemon(true);
            s.acceptThread.start();
            s.startWatchdog();
            instance = s;
            Log.i(TAG, "MCP server listening on " + host + ":" + PORT);
            DshA11yDiagnostics.log(s.appContext, "mcp：server 已监听 " + host + ":" + PORT);
        } catch (Exception e) {
            Log.e(TAG, "MCP server start failed: " + e.getMessage());
            DshA11yDiagnostics.log(s.appContext, "mcp：server 启动失败 " + e.getMessage());
            try {
                if (s.serverSocket != null) s.serverSocket.close();
            } catch (Exception ignored) {
            }
        }
    }

    public static synchronized void stop() {
        DshMcpServer s = instance;
        instance = null;
        if (s == null) return;
        s.running = false;
        try {
            if (s.serverSocket != null) s.serverSocket.close();
        } catch (Exception ignored) {
        }
        DshA11yDiagnostics.log(s.appContext, "mcp：server 已停止");
    }

    public static boolean isRunning() {
        DshMcpServer s = instance;
        return s != null && s.alive();
    }

    /**
     * 看门狗：定期确认 socket 还活着，死了就重绑。
     *
     * ============ 为什么需要它 ============
     *
     * 端口被系统回收、ROM 的后台管控把监听断掉、fd 被回收 —— 这些都会让
     * ServerSocket 在**不通知任何人**的情况下失效。此时：
     *   - instance 还非空 → 旧版 start() 幂等挡回，什么也修不了
     *   - isRunning() 若只看 instance → 一直报 true
     *   - 用户看到的是「界面显示在跑，但 Agent 连不上」
     *
     * 看门狗每 3 秒查一次，发现 socket 不可用就重新 bind 同一个端口。
     * 端口没被占的话，rebind 几乎瞬时完成，用户无感。
     */
    private void startWatchdog() {
        Thread w = new Thread(() -> {
            while (running) {
                try {
                    Thread.sleep(3000);
                } catch (InterruptedException e) {
                    break;
                }
                if (!running) break;
                ServerSocket s = serverSocket;
                boolean ok = s != null && s.isBound() && !s.isClosed();
                if (ok) continue;
                Log.w(TAG, "看门狗发现监听 socket 失效，尝试重绑");
                DshA11yDiagnostics.log(appContext, "mcp：监听 socket 失效，自动重绑");
                reopen();
            }
        }, "dsh-mcp-watchdog");
        w.setDaemon(true);
        w.start();
    }

    /**
     * 重新绑定端口。
     *
     * 先关掉旧 socket 再 bind 新的 —— 否则 reuseAddress 也可能撞上
     * 「旧 socket 还在 TIME_WAIT / 仍被内核持有」。
     */
    private synchronized void reopen() {
        if (!running) return;
        try {
            ServerSocket old = serverSocket;
            serverSocket = null;
            if (old != null) {
                try {
                    old.close();
                } catch (Exception ignored) {
                }
            }
            ServerSocket ns = new ServerSocket();
            ns.setReuseAddress(true);
            ns.bind(new InetSocketAddress(InetAddress.getByName(bindHost), PORT));
            serverSocket = ns;
            // accept 线程如果已经死了，重新拉起
            Thread t = acceptThread;
            if (t == null || !t.isAlive()) {
                acceptThread = new Thread(this::acceptLoop, "dsh-mcp-accept");
                acceptThread.setDaemon(true);
                acceptThread.start();
            }
            DshA11yDiagnostics.log(appContext, "mcp：已重绑 " + bindHost + ":" + PORT);
            Log.i(TAG, "MCP server rebound on " + bindHost + ":" + PORT);
        } catch (Exception e) {
            Log.e(TAG, "reopen failed: " + e.getMessage());
            DshA11yDiagnostics.log(appContext, "mcp：重绑失败 " + e.getMessage());
        }
    }

    /* ------------------------------------------------------------ 接受连接 */

    /**
     * 接受连接。
     *
     * ============ 为什么要退避 + 自愈 ============
     *
     * 旧代码在 catch 里只打一行日志就继续循环。如果 accept() 因为
     * 「文件描述符耗尽」或「socket 被系统关掉」而持续失败，
     * 这个循环会以每秒上万次的速度空转 —— CPU 打满、日志刷爆，
     * 而用户那边看到的是「手机突然卡了，MCP 也连不上」。
     *
     * 现在失败会退避；连续失败会**重建 socket 并继续**，
     * 而不是直接放弃 —— 因为 socket 失效是可恢复的，
     * 一放弃就只剩「重启应用」这一条路。
     */
    private void acceptLoop() {
        int fails = 0;
        while (running) {
            Socket client;
            try {
                ServerSocket s = serverSocket;
                if (s == null) {
                    Thread.sleep(200);
                    continue;
                }
                client = s.accept();
                fails = 0;
            } catch (Exception e) {
                if (!running) break;
                fails++;
                Log.w(TAG, "accept: " + e.getMessage() + "（连续 " + fails + "）");
                if (fails >= 3) {
                    // 连续失败 → 重建 socket 后继续，而不是退出循环。
                    // 退出循环 = 服务彻底死掉 = 只能重启应用。
                    reopen();
                    fails = 0;
                }
                try {
                    Thread.sleep(Math.min(1000L, 120L * fails));
                } catch (InterruptedException ie) {
                    break;
                }
                continue;
            }

            if (active.get() >= MAX_CONN) {
                // 超限直接断开，让客户端自己重试。这里不回 503：
                // 那要多写一个响应，而客户端本来就会重试。
                try {
                    client.close();
                } catch (Exception ignored) {
                }
                continue;
            }

            // 先占位再开线程：
            // 原来在子线程里 increment，等于「先放行再计数」，
            // 短时间内可以无限开线程 —— 上限形同虚设。
            active.incrementAndGet();
            Thread t = new Thread(() -> {
                try {
                    handle(client);
                } finally {
                    active.decrementAndGet();
                }
            }, "dsh-mcp-conn");
            t.setDaemon(true);
            t.start();
        }
    }

    private void handle(Socket client) {
        try (Socket c = client) {
            // 分两段设超时，而不是一路 60 秒：
            //   读请求头用短超时 —— 浏览器可能会预连接但不发数据，
            //   那种连接不该占着线程一分钟。
            //   读 body 用较长超时 —— 大参数（比如 base64 文件）传得慢。
            c.setSoTimeout(15000);
            c.setTcpNoDelay(true);
            InputStream in = c.getInputStream();
            OutputStream out = c.getOutputStream();

            String head = readHead(in);
            if (head == null || head.isEmpty()) return;

            String[] lines = head.split("\r\n");
            String[] reqLine = lines[0].split(" ");
            if (reqLine.length < 2) {
                write(out, 400, "text/plain; charset=utf-8", "bad request", null);
                return;
            }
            String method = reqLine[0].toUpperCase(Locale.US);
            String path = reqLine[1];
            int q = path.indexOf('?');
            if (q >= 0) path = path.substring(0, q);

            Map<String, String> headers = new HashMap<>();
            for (int i = 1; i < lines.length; i++) {
                int idx = lines[i].indexOf(':');
                if (idx > 0) {
                    headers.put(
                            lines[i].substring(0, idx).trim().toLowerCase(Locale.US),
                            lines[i].substring(idx + 1).trim()
                    );
                }
            }

            if ("OPTIONS".equals(method)) {
                write(out, 204, null, "", null);
                return;
            }

            if (!authorized(headers)) {
                write(out, 401, "application/json; charset=utf-8",
                        "{\"error\":\"unauthorized\"}", null);
                return;
            }

            if ("GET".equals(method)) {
                // GET 同时承担两个职责：
                //   1) 健康检查（ok / version / tools）
                //   2) 设备状态快照 —— 主进程的 DshMcpBridge.status() 就是读这里
                //
                // 为什么状态要绕一趟 HTTP：无障碍和本服务都在 :device 进程，
                // 而设置页的 UI 在主进程。静态量不跨进程，主进程自己采集只能是错的。
                JSONObject health = DshStatus.snapshot(appContext);
                health.put("ok", true);
                health.put("server", "dsh-mobile-native");
                health.put("version", VERSION);
                health.put("protocol", PROTOCOL);
                health.put("tools", DshMcpTools.all(appContext).size());
                health.put("endpoint", "/mcp");
                write(out, 200, "application/json; charset=utf-8", health.toString(), null);
                return;
            }

            if (!"POST".equals(method)) {
                write(out, 405, "text/plain; charset=utf-8", "method not allowed", null);
                return;
            }

            int len = 0;
            boolean chunked = false;
            String te = headers.get("transfer-encoding");
            if (te != null && te.toLowerCase(Locale.US).contains("chunked")) {
                chunked = true;
            }
            if (!chunked) {
                try {
                    len = Integer.parseInt(headers.getOrDefault("content-length", "0"));
                } catch (Exception ignored) {
                }
            }
            if (len < 0 || len > 4 * 1024 * 1024) {
                write(out, 413, "text/plain; charset=utf-8", "payload too large", null);
                return;
            }
            // 请求头已经读完，body 可能较大（base64 附件），放宽等待
            c.setSoTimeout(30000);
            byte[] raw = chunked ? readChunked(in) : readN(in, len);
            String bodyText = new String(raw, StandardCharsets.UTF_8);

            String resp = dispatch(bodyText);
            if (resp == null) {
                write(out, 202, null, "", null);
            } else {
                write(out, 200, "application/json; charset=utf-8", resp, null);
            }
        } catch (Exception e) {
            Log.w(TAG, "handle: " + e.getMessage());
        }
    }

    private boolean authorized(Map<String, String> headers) {
        if (TOKEN == null || TOKEN.isEmpty()) return true;
        String h = headers.get("authorization");
        return h != null && h.toLowerCase(Locale.US).startsWith("bearer ")
                && h.substring(7).trim().equals(TOKEN);
    }

    /* ------------------------------------------------------------- 协议层 */

    /** 返回 null 表示这是通知，应当回 202 空体。 */
    private String dispatch(String bodyText) {
        try {
            JSONObject msg = new JSONObject(bodyText);
            String method = msg.optString("method", "");
            Object id = msg.opt("id");

            if (method.isEmpty()) {
                return error(id, -32600, "无效请求：缺少 method");
            }
            if (method.startsWith("notifications/")) {
                return null;
            }

            switch (method) {
                case "initialize": {
                    JSONObject caps = new JSONObject();
                    JSONObject tools = new JSONObject();
                    tools.put("listChanged", false);
                    caps.put("tools", tools);

                    JSONObject info = new JSONObject();
                    info.put("name", "dsh-mobile-native");
                    info.put("version", VERSION);

                    JSONObject result = new JSONObject();
                    result.put("protocolVersion", PROTOCOL);
                    result.put("capabilities", caps);
                    result.put("serverInfo", info);
                    return ok(id, result);
                }
                case "ping":
                    return ok(id, new JSONObject());
                case "tools/list": {
                    List<DshMcpServer.Tool> list = DshMcpTools.all(appContext);
                    JSONArray arr = new JSONArray();
                    for (DshMcpServer.Tool t : list) {
                        JSONObject o = new JSONObject();
                        o.put("name", t.name);
                        o.put("description", t.description);
                        o.put("inputSchema", t.schema);
                        arr.put(o);
                    }
                    JSONObject result = new JSONObject();
                    result.put("tools", arr);
                    return ok(id, result);
                }
                case "tools/call": {
                    JSONObject params = msg.optJSONObject("params");
                    String name = params == null ? "" : params.optString("name", "");
                    JSONObject args = params == null ? null : params.optJSONObject("arguments");
                    if (args == null) args = new JSONObject();

                    List<DshMcpServer.Tool> registry = DshMcpTools.all(appContext);
                    DshMcpServer.Tool tool = null;
                    StringBuilder names = new StringBuilder();
                    for (DshMcpServer.Tool t : registry) {
                        if (names.length() > 0) names.append(", ");
                        names.append(t.name);
                        if (t.name.equals(name)) tool = t;
                    }
                    if (tool == null) {
                        // 把可用工具列出来，模型调错名字时能自己纠正
                        return ok(id, toolResult("未知工具：" + name + "。可用工具：" + names, true));
                    }
                    try {
                        return ok(id, toolResult(tool.handler.run(args), false));
                    } catch (Exception e) {
                        String m = e.getMessage();
                        return ok(id, toolResult(name + " 执行失败：" + (m == null ? e.toString() : m), true));
                    }
                }
                default:
                    return error(id, -32601, "未实现的方法：" + method);
            }
        } catch (JSONException e) {
            return error(null, -32700, "解析失败：" + e.getMessage());
        }
    }

    private static JSONObject toolResult(String text, boolean isError) throws JSONException {
        JSONObject part = new JSONObject();
        part.put("type", "text");
        part.put("text", text == null ? "" : text);

        JSONArray content = new JSONArray();
        content.put(part);

        JSONObject result = new JSONObject();
        result.put("content", content);
        if (isError) result.put("isError", true);
        return result;
    }

    private static String ok(Object id, JSONObject result) {
        try {
            JSONObject o = new JSONObject();
            o.put("jsonrpc", "2.0");
            o.put("id", id == null ? JSONObject.NULL : id);
            o.put("result", result);
            return o.toString();
        } catch (JSONException e) {
            return "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,\"message\":\"encode failed\"}}";
        }
    }

    private static String error(Object id, int code, String message) {
        try {
            JSONObject err = new JSONObject();
            err.put("code", code);
            err.put("message", message);
            JSONObject o = new JSONObject();
            o.put("jsonrpc", "2.0");
            o.put("id", id == null ? JSONObject.NULL : id);
            o.put("error", err);
            return o.toString();
        } catch (JSONException e) {
            return "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,\"message\":\"encode failed\"}}";
        }
    }

    /* ------------------------------------------------------------- HTTP IO */

    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int state = 0;
        while (true) {
            int b = in.read();
            if (b == -1) return buf.size() == 0 ? null : buf.toString("UTF-8");
            buf.write(b);
            if (b == '\r' && (state == 0 || state == 2)) state++;
            else if (b == '\n' && (state == 1 || state == 3)) state++;
            else state = 0;
            if (state == 4) break;
            if (buf.size() > 64 * 1024) break;
        }
        return buf.toString("UTF-8");
    }

    private static byte[] readN(InputStream in, int len) throws IOException {
        byte[] out = new byte[len];
        int off = 0;
        while (off < len) {
            int n = in.read(out, off, len - off);
            if (n < 0) break;
            off += n;
        }
        if (off == len) return out;
        byte[] shorter = new byte[off];
        System.arraycopy(out, 0, shorter, 0, off);
        return shorter;
    }

    /**
     * 读 chunked 传输编码的 body。
     *
     * ============ 为什么必须支持 ============
     *
     * 之前只认 Content-Length。有些 HTTP 客户端（以及部分 fetch 实现
     * 在流式请求下）会用 `Transfer-Encoding: chunked`，此时没有 Content-Length，
     * 旧代码解析出 len=0 → body 是空串 → JSON 解析失败 →
     * 用户看到的是「MCP 调用莫名其妙报解析失败」。
     *
     * 格式：<十六进制长度>CRLF<数据>CRLF ... 直到长度为 0 的块。
     */
    private static byte[] readChunked(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        while (true) {
            String sizeLine = readLine(in);
            if (sizeLine == null) break;
            String t = sizeLine.trim();
            int semi = t.indexOf(';');
            if (semi >= 0) t = t.substring(0, semi).trim();
            int size;
            try {
                size = Integer.parseInt(t, 16);
            } catch (NumberFormatException e) {
                break;
            }
            if (size <= 0) break;
            if (out.size() + size > 4 * 1024 * 1024) break;
            byte[] buf = new byte[size];
            int off = 0;
            while (off < size) {
                int n = in.read(buf, off, size - off);
                if (n < 0) break;
                off += n;
            }
            out.write(buf, 0, off);
            readLine(in); // 吃掉数据块后的 CRLF
        }
        return out.toByteArray();
    }

    /** 读一行（以 CRLF 或 LF 结束），返回不含行尾的内容。 */
    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int b;
        while ((b = in.read()) != -1) {
            if (b == '\n') break;
            if (b != '\r') buf.write(b);
            if (buf.size() > 8192) break;
        }
        if (b == -1 && buf.size() == 0) return null;
        return buf.toString("UTF-8");
    }

    private static void write(OutputStream out, int status, String contentType, String body,
                              Map<String, String> extra) throws IOException {
        byte[] bytes = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n");
        sb.append("Access-Control-Allow-Origin: *\r\n");
        sb.append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
        sb.append("Access-Control-Allow-Headers: content-type, authorization, mcp-protocol-version, mcp-session-id, accept\r\n");
        sb.append("Access-Control-Expose-Headers: Mcp-Session-Id\r\n");
        sb.append("Access-Control-Max-Age: 86400\r\n");
        if (contentType != null) sb.append("Content-Type: ").append(contentType).append("\r\n");
        sb.append("Content-Length: ").append(bytes.length).append("\r\n");
        sb.append("Connection: close\r\n");
        if (extra != null) {
            for (Map.Entry<String, String> e : extra.entrySet()) {
                sb.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
            }
        }
        sb.append("\r\n");
        out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
        if (bytes.length > 0) out.write(bytes);
        out.flush();
    }

    private static String reason(int status) {
        switch (status) {
            case 200: return "OK";
            case 202: return "Accepted";
            case 204: return "No Content";
            case 400: return "Bad Request";
            case 401: return "Unauthorized";
            case 405: return "Method Not Allowed";
            case 413: return "Payload Too Large";
            default: return "OK";
        }
    }

    /* --------------------------------------------------------------- 工具 */

    public interface Handler {
        String run(JSONObject args) throws Exception;
    }

    public static final class Tool {
        public final String name;
        public final String description;
        public final JSONObject schema;
        public final Handler handler;

        public Tool(String name, String description, JSONObject schema, Handler handler) {
            this.name = name;
            this.description = description;
            this.schema = schema;
            this.handler = handler;
        }
    }
}
