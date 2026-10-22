package ai.deepseek.dsh.mobile;

import org.json.JSONObject;

import android.webkit.WebView;

/**
 * HUD 全局状态单例：WebView 侧与悬浮窗服务在同一进程内共享。
 *
 * ============ 为什么能共享 ============
 *
 * DshHudService 没有指定 android:process，跑在**主进程**——
 * 和 WebView 是同一个进程。所以这里放一个 WebView 引用，
 * 悬浮窗就能直接把指令送回页面里的 JS，而不需要跨进程 IPC。
 *
 * 代价是这个引用会随 Activity 一起死。所以 MainActivity 在 onCreate 里登记、
 * onDestroy 里清掉；拿到 null 时悬浮窗的命令按钮只提示「应用没在运行」，不崩。
 */
public final class DshHudState {
    public static volatile boolean enabled = false;
    public static volatile String json =
            "{\"status\":\"idle\",\"statusText\":\"空闲中\",\"step\":\"\",\"sessions\":[],\"tasks\":[]}";
    public static volatile boolean collapsed = true;

    /** 主进程里的 WebView（由 MainActivity 登记）。悬浮窗发指令时用它回到 JS。 */
    public static volatile WebView webView;

    private DshHudState() {}

    /**
     * 从悬浮窗向页面里的 JS 发一条指令。
     *
     * ============ 为什么走 evaluateJavascript ============
     *
     * 悬浮窗（原生 View）和聊天逻辑（JS）分处两侧，中间隔着一层 WebView。
     * 常见做法是「原生 → Intent → Activity → 广播 → JS」，要动 Activity 生命周期；
     * 而这里 Activity 已经在主进程里、页面就在同一个 WebView 实例中，
     * 直接 evaluateJavascript 最短，也不需要 Activity 在前台。
     *
     * 关键点：**必须在 UI 线程调用**。WebView 的所有方法都要求 UI 线程，
     * 而悬浮窗的点击回调虽然跑在主线程，但 push 之类的调用可能来自别处 ——
     * 所以统一用 webView.post() 兜一层。
     */
    public static void sendCommand(String action, String payloadJson) {
        final WebView w = webView;
        if (w == null) return;
        final String js =
                "(function(){try{"
                + "if(window.__dshHudCommand){window.__dshHudCommand("
                + JSONObject.quote(action == null ? "" : action) + ","
                + (payloadJson == null ? "null" : payloadJson)
                + ");return 'ok';}"
                + "return 'no-handler';})()";
        try {
            w.post(() -> {
                try {
                    w.evaluateJavascript(js, null);
                } catch (Throwable ignored) {
                }
            });
        } catch (Throwable ignored) {
        }
    }
}
