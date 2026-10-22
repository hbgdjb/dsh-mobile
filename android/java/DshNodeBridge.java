package ai.deepseek.dsh.mobile;

import android.content.Context;
import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

/**
 * Node 运行时的 JS 桥。
 *
 * 负责三块：运行时状态（可用/运行中/下载中）、启停、以及**通道转发**。
 *
 * ============ 通道转发为什么放在原生 ============
 *
 * JS 和 Node 在两个互不相通的 JS 引擎里，WebView 里没有 require，
 * Node 里也没有 DOM。要让插件（在 Node 里）能被页面调用，
 * 中间必须有一条通道，而通道的两端都不是页面 —— 一端在 Node，
 * 一端在原生（Java 能同时看到 WebView 和 Node 进程）。
 *
 * 所以原生是天然的中间人：
 *   页面 → window.DshNode.call(method, params) → 通道 → Node
 *   Node → 通道 → 原生 → window.__dshNodeResponse(...) → 页面
 *
 * 页面侧的 Promise 封装在 scripts/node-runtime.js 里。
 */
public class DshNodeBridge {

    private final Context ctx;
    private final android.webkit.WebView webView;

    public DshNodeBridge(Context ctx) {
        this(ctx, null);
    }

    public DshNodeBridge(Context ctx, android.webkit.WebView webView) {
        this.ctx = ctx;
        this.webView = webView;
        if (webView != null) {
            DshNodeChannel.get().attach(webView);
        }
    }

    @JavascriptInterface
    public void start() {
        DshNodeService.start(ctx);
    }

    @JavascriptInterface
    public void stop() {
        DshNodeService.stop(ctx);
    }

    /**
     * 只下载运行时，不启动。
     *
     * 88 MB 是一次性的、用户能感知的开销 —— 必须由用户主动触发，
     * 不能在应用启动时偷偷发生。
     */
    @JavascriptInterface
    public void download() {
        DshNodeService.downloadOnly(ctx);
    }

    /* ---------------- 通道 ---------------- */

    /**
     * 调 Node 里的一个方法。
     *
     * **立即返回**请求 id，不等结果 —— @JavascriptInterface 的方法跑在
     * WebView 的 JavaBridge 线程上，在那儿阻塞会把整个原生桥卡死。
     * 结果由原生通过 window.__dshNodeResponse 异步送回。
     *
     * @param method       方法名
     * @param paramsJson   参数（JSON 字符串）
     * @return 请求 id；空串表示没发出去（通道没连上）
     */
    @JavascriptInterface
    public String call(String method, String paramsJson) {
        try {
            return DshNodeChannel.get().call(method, paramsJson);
        } catch (Throwable e) {
            Log.w("DshNode", "调用失败：" + e.getMessage());
            return "";
        }
    }

    /** 回应 Node 的反向调用。页面处理完 Node 的请求后调这个。 */
    @JavascriptInterface
    public void respond(String id, boolean ok, String payloadJson) {
        try {
            DshNodeChannel.get().respond(id, ok, payloadJson);
        } catch (Throwable ignored) {
        }
    }

    /** 通道是否已连上 Node。 */
    @JavascriptInterface
    public boolean channelConnected() {
        return DshNodeChannel.get().isConnected();
    }

    /**
     * 一次性把状态问全。
     *
     * 拆成 available / running / reason 三个字段而不是一个布尔：
     * "库没打进包"、"库加载失败"、"服务在跑但 Node 崩了" 是三种完全不同的状态，
     * 用户需要看到具体哪一种。
     */
    @JavascriptInterface
    public String status() {
        JSONObject o = new JSONObject();
        try {
            boolean avail = DshNodeRuntime.available();
            o.put("available", avail);
            o.put("running", DshNodeService.isRunning());
            // 运行时是下载来的：这三个字段让界面能区分
            // "没下载" / "正在下" / "下好了但没起来"
            o.put("installed", DshNodeRuntime.runtimeInstalled(ctx));
            o.put("downloading", DshNodeRuntime.isDownloading());
            o.put("percent", DshNodeRuntime.downloadPercent());
            // 通道状态：Node 起来了不等于连上了 —— 连上才说明
            // 插件能被页面调用。这是两个不同的状态，要分开报。
            o.put("channelConnected", DshNodeChannel.get().isConnected());
            o.put("channelPort", DshNodeChannel.get().port());
            if (!avail) {
                String why = DshNodeRuntime.unavailableReason();
                o.put("reason", why == null ? "原生库未加载" : why);
            }
            // dlopen 失败的原因（和"原生库没加载"是两回事，要分开报）
            String rerr = DshNodeRuntime.runtimeError();
            if (rerr != null && !rerr.isEmpty()) {
                o.put("runtimeError", rerr);
            }
        } catch (Throwable e) {
            try {
                o.put("error", String.valueOf(e.getMessage()));
            } catch (Throwable ignored) {
            }
        }
        return o.toString();
    }
}
