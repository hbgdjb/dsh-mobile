package ai.deepseek.dsh.mobile;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * JS ↔ Node 的双向消息通道。
 *
 * ============ 为什么需要它 ============
 *
 * Node 和 WebView 在同一个 Android 进程里，但跑在**两个互不相通的 JS 引擎**中：
 * WebView 有 DOM、有页面、有 localStorage；Node 有 node:fs、node:http、npm 包。
 * 两者之间没有任何共享内存，WebView 里也没有 require 的能力。
 *
 * 所以插件要跑在 Node 里（拿真 Node API），工具的调用入口却必须在 WebView 里
 * （AI 助手在那儿）。中间必须有一条通道把它们接起来 —— 否则插件生态在手机上
 * 还是零。
 *
 * ============ 为什么用 TCP loopback 而不是管道 / Binder ============
 *
 * · Binder 要 AIDL、要 Service 绑定、要 Parcelable 序列化，做通用载荷太重；
 * · 匿名管道（pipe）跨不了 JNI 边界传 fd，太脆；
 * · Unix domain socket 在 Android 上要处理 abstract namespace 的差异；
 * · **loopback TCP 是最朴素、最可调试、最不挑 ROM 的**：nc 就能连上，
 *   出问题能直接抓包看。
 *
 * 而且将来要把 Node 挪到 :node 独立进程（崩溃不连累 UI）时，
 * 这条通道**一行都不用改** —— 那正是 TCP 的好处。
 *
 * ============ 协议 ============
 *
 * 行分隔 JSON（NDJSON），一条消息一行 UTF-8。
 *
 *   JS → Node：{"id":"7","method":"plugins.list","params":{...}}
 *   Node → JS：{"id":"7","ok":true,"result":{...}}
 *              {"id":"7","ok":false,"error":"原因"}
 *              {"event":"tools.changed","data":{...}}   ← 无 id，是主动推送
 *
 * id 由 Java 侧生成（UUID 前 8 位），用来把响应配回请求。
 *
 * ============ 为什么不做成同步阻塞 ============
 *
 * @JavascriptInterface 的方法跑在 WebView 的 JavaBridge 线程上。
 * 在那里阻塞等 Node 回答，会把这个线程占死 —— 而同一个线程还负责
 * 派发所有其它原生调用（文件、网络、语音）。一个慢插件就能把整个桥卡住。
 *
 * 所以这里是**完全异步**的：
 *   JS 调 call() 立刻拿到请求 id → Java 发给 Node → Node 回�� →
 *   Java 用 evaluateJavascript 回调 JS 的 Promise。
 * JS 侧封装成 Promise，调用方感觉不到异步。
 */
public final class DshNodeChannel {

    private static final String TAG = "DshNodeChannel";

    /** JS 侧接收响应的全局函数名（脚本里注册）。 */
    static final String JS_RESPONSE = "__dshNodeResponse";
    /** JS 侧接收主动推送的全局函数名。 */
    static final String JS_EVENT = "__dshNodeEvent";
    /** JS 侧接收 Node 反向调用的全局函数名。 */
    static final String JS_REQUEST = "__dshNodeRequest";

    /** 请求在 Node 侧最多等多久（毫秒）。超时后 JS 的 Promise 会被拒。 */
    private static final long REQUEST_TIMEOUT_MS = 30000L;

    private static final DshNodeChannel INSTANCE = new DshNodeChannel();

    public static DshNodeChannel get() {
        return INSTANCE;
    }

    private DshNodeChannel() {
    }

    /* ---------------- 状态 ---------------- */

    /** 监听端口。0 = 没起来。 */
    private volatile int port = 0;
    /** 连接口令，防止同机别的应用误连。 */
    private volatile String token = null;
    private volatile boolean connected = false;

    private ServerSocket server;
    private Socket socket;
    private BufferedReader reader;
    private BufferedWriter writer;
    private final Object writeLock = new Object();

    /** 等待响应的请求表：id → 截止时间。 */
    private final Map<String, Long> pending = new ConcurrentHashMap<>();

    private final Handler main = new Handler(Looper.getMainLooper());
    private ScheduledExecutorService timer;

    /** 回调给 WebView 的引用。主进程持有，Node 挪走也不影响。 */
    private volatile WebView webView;

    /* ---------------- WebView 挂接 ---------------- */

    /**
     * 登记 WebView，用来把 Node 的响应送回页面。
     *
     * 用静态引用而不是参数传递，是因为通道是单例：
     * Node 在 Service 的工作线程里跑，Service 拿不到 Activity 的引用，
     * 而 WebView 在 Activity 销毁后就失效了 —— 所以必须能随时置空。
     */
    public void attach(WebView view) {
        this.webView = view;
    }

    public void detach() {
        this.webView = null;
    }

    public boolean isConnected() {
        return connected;
    }

    public int port() {
        return port;
    }

    /** 连接口令。Node 侧要用它握手，防止同机别的应用误连。 */
    public String token() {
        return token == null ? "" : token;
    }

    /* ---------------- 服务端 ---------------- */

    /**
     * 起监听。在 Node 启动**之前**调用 —— Node 一起来就会连过来，
     * 端口必须已经就绪。
     *
     * @return 监听端口（0 表示失败）
     */
    public synchronized int startServer() {
        if (port != 0 && server != null && !server.isClosed()) return port;
        try {
            server = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
            port = server.getLocalPort();
            token = UUID.randomUUID().toString().substring(0, 8);
            connected = false;
            pending.clear();
            acceptLoop();
            Log.i(TAG, "通道监听已开：127.0.0.1:" + port);
            return port;
        } catch (Throwable e) {
            Log.e(TAG, "开监听失败：" + e.getMessage());
            server = null;
            port = 0;
            token = null;
            return 0;
        }
    }

    private void acceptLoop() {
        Thread t = new Thread(() -> {
            while (true) {
                ServerSocket s = server;
                if (s == null || s.isClosed()) return;
                try {
                    Socket c = s.accept();
                    // Node 崩溃重启后会重连。旧连接还挂着的话，
                    // 留着只会让"已连接"这个状态说谎 —— 直接踢掉。
                    // 这里清的是**旧**连接（socket 字段还指向旧的那个），
                    // 新连接随后由自己的读线程填进 socket。
                    synchronized (DshNodeChannel.this) {
                        closeSocket();
                    }
                    // 每个连接单独一个线程读。
                    //
                    // ============ 为什么不能就地读 ============
                    //
                    // 就地读的话，accept 循环会被这个连接卡住 ——
                    // 而 Node 崩溃后重连时，旧连接可能还处在半死状态
                    // （对端已消失，本地 read 还在等）。
                    // 那样新连接就再也 accept 不到了，
                    // 表现为「Node 明明起来了，插件却一直调不通」，
                    // 而且没有任何报错。
                    final Socket sock = c;
                    Thread reader = new Thread(() -> handleConnection(sock), "dsh-node-read");
                    reader.setDaemon(true);
                    reader.start();
                } catch (Throwable e) {
                    if (server == null || server.isClosed()) return;
                    // 不是关闭导致的错误（比如单个连接被重置）——
                    // 继续 accept，不能让整个监听线程死掉。
                    // 监听线程死了的话，Node 重启后就再也连不上了，
                    // 而那时候没有任何报错，只表现为"插件突然全部失效"。
                    Log.w(TAG, "accept 失败，继续监听：" + e.getMessage());
                }
            }
        }, "dsh-node-accept");
        t.setDaemon(true);
        t.start();
    }

    private void handleConnection(Socket c) {
        try {
            socket = c;
            reader = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
            writer = new BufferedWriter(new OutputStreamWriter(c.getOutputStream(), StandardCharsets.UTF_8));
            connected = true;
            Log.i(TAG, "Node 已连接");

            String line;
            while ((line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) continue;
                dispatchLine(line);
            }
        } catch (Throwable e) {
            Log.w(TAG, "读取中断：" + e.getMessage());
        } finally {
            // 只清理"自己这个连接"——
            // 如果期间已经有新连接接上了（Node 重启），
            // 不能把新连接也一起关掉。
            synchronized (this) {
                if (socket == c) {
                    connected = false;
                    closeSocket();
                }
            }
            failAllPending("Node 连接已断开");
        }
    }

    /** 处理来自 Node 的一行消息。 */
    private void dispatchLine(String line) {
        JSONObject o;
        try {
            o = new JSONObject(line);
        } catch (Throwable e) {
            Log.w(TAG, "收到非法 JSON：" + line);
            return;
        }
        // 主动推送（无 id）
        String event = o.optString("event", "");
        if (!event.isEmpty()) {
            postEvent(event, o.opt("data"));
            return;
        }
        // Node 反向调用 WebView：有 method 且带 id
        String method = o.optString("method", "");
        String id = o.optString("id", "");
        if (!method.isEmpty() && !id.isEmpty()) {
            postRequest(id, method, o.opt("params"));
            return;
        }
        // 响应（有 id）
        if (id.isEmpty()) return;
        pending.remove(id);
        boolean ok = o.optBoolean("ok", false);
        String payload;
        if (ok) {
            payload = String.valueOf(o.opt("result"));
        } else {
            payload = String.valueOf(o.optString("error", "未知错误"));
        }
        postResponse(id, ok, payload);
    }

    /* ---------------- 对外：JS 发起调用 ---------------- */

    /**
     * 发起一次调用。
     *
     * @return 请求 id（空串表示没发出去）
     */
    public String call(String method, String paramsJson) {
        if (!connected) return "";
        String id = UUID.randomUUID().toString().substring(0, 8);
        JSONObject msg = new JSONObject();
        try {
            msg.put("id", id);
            msg.put("method", method);
            msg.put("params", paramsJson == null || paramsJson.isEmpty() ? "{}" : new JSONObject(paramsJson));
        } catch (Throwable e) {
            Log.e(TAG, "构造请求失败：" + e.getMessage());
            return "";
        }
        if (!send(msg.toString())) return "";

        pending.put(id, System.currentTimeMillis() + REQUEST_TIMEOUT_MS);
        scheduleTimeout(id);
        return id;
    }

    /** 主动推给 Node（不需要回复）。 */
    public boolean notify(String method, String paramsJson) {
        if (!connected) return false;
        JSONObject msg = new JSONObject();
        try {
            msg.put("method", method);
            msg.put("params", paramsJson == null || paramsJson.isEmpty() ? "{}" : new JSONObject(paramsJson));
            msg.put("fire", true);
        } catch (Throwable e) {
            return false;
        }
        return send(msg.toString());
    }

    /* ---------------- 对外：回应 Node 的反向调用 ---------------- */

    /**
     * WebView 处理完 Node 的请求后，把结果送回去。
     *
     * 这条路径是 Node 插件访问宿主能力的入口：插件在 Node 里，
     * 但"读工作区文件""发网络请求"这些能力实现在 WebView 侧（那才有
     * 统一的权限白名单与审计），所以要绕回来调用。
     */
    public void respond(String id, boolean ok, String payloadJson) {
        JSONObject msg = new JSONObject();
        try {
            msg.put("id", id);
            msg.put("ok", ok);
            if (ok) {
                msg.put("result", payloadJson == null || payloadJson.isEmpty()
                        ? JSONObject.NULL : new JSONObject(payloadJson));
            } else {
                msg.put("error", payloadJson == null ? "未知错误" : payloadJson);
            }
        } catch (Throwable e) {
            Log.e(TAG, "构造响应失败：" + e.getMessage());
            return;
        }
        send(msg.toString());
    }

    private boolean send(String line) {
        BufferedWriter w = writer;
        if (w == null) return false;
        try {
            synchronized (writeLock) {
                w.write(line);
                w.write("\n");
                w.flush();
            }
            return true;
        } catch (Throwable e) {
            Log.w(TAG, "发送失败：" + e.getMessage());
            connected = false;
            return false;
        }
    }

    /* ---------------- 超时 ---------------- */

    private void scheduleTimeout(final String id) {
        try {
            if (timer == null || timer.isShutdown()) {
                timer = Executors.newSingleThreadScheduledExecutor(r -> {
                    Thread t = new Thread(r, "dsh-node-timeout");
                    t.setDaemon(true);
                    return t;
                });
            }
            timer.schedule(() -> {
                Long deadline = pending.remove(id);
                if (deadline != null) {
                    postResponse(id, false, "Node 响应超时");
                }
            }, REQUEST_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (Throwable ignored) {
        }
    }

    /** 连接断开时，把所有还在等着的请求一次性拒掉。 */
    private void failAllPending(String reason) {
        if (pending.isEmpty()) return;
        for (String id : pending.keySet().toArray(new String[0])) {
            if (pending.remove(id) != null) postResponse(id, false, reason);
        }
    }

    /* ---------------- 回到 WebView ---------------- */

    private void postResponse(final String id, final boolean ok, final String payload) {
        final WebView w = webView;
        if (w == null) return;
        main.post(() -> {
            try {
                String js = "window." + JS_RESPONSE + " && window." + JS_RESPONSE
                        + "(" + JSONObject.quote(id) + "," + (ok ? "true" : "false")
                        + "," + JSONObject.quote(payload == null ? "" : payload) + ")";
                w.evaluateJavascript(js, null);
            } catch (Throwable ignored) {
            }
        });
    }

    private void postEvent(final String event, final Object data) {
        final WebView w = webView;
        if (w == null) return;
        main.post(() -> {
            try {
                String js = "window." + JS_EVENT + " && window." + JS_EVENT
                        + "(" + JSONObject.quote(event) + "," + JSONObject.quote(String.valueOf(data)) + ")";
                w.evaluateJavascript(js, null);
            } catch (Throwable ignored) {
            }
        });
    }

    /** 把 Node 的反向调用送进 WebView，等 JS 处理完再 respond() 回来。 */
    private void postRequest(final String id, final String method, final Object params) {
        final WebView w = webView;
        if (w == null) {
            respond(id, false, "宿主页面不可用");
            return;
        }
        main.post(() -> {
            try {
                String js = "window." + JS_REQUEST + " && window." + JS_REQUEST
                        + "(" + JSONObject.quote(id) + "," + JSONObject.quote(method)
                        + "," + JSONObject.quote(String.valueOf(params)) + ")";
                w.evaluateJavascript(js, null);
            } catch (Throwable e) {
                respond(id, false, "派发失败：" + e.getMessage());
            }
        });
    }

    /* ---------------- 清理 ---------------- */

    /** 关掉监听与连接。Node 重启时会重新调 startServer()。 */
    public synchronized void stopServer() {
        failAllPending("通道已关闭");
        closeSocket();
        try {
            if (server != null) server.close();
        } catch (Throwable ignored) {
        }
        server = null;
        port = 0;
        token = null;
        connected = false;
    }

    private void closeSocket() {
        try {
            if (socket != null) socket.close();
        } catch (Throwable ignored) {
        }
        socket = null;
        reader = null;
        writer = null;
    }
}
