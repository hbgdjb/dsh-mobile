package ai.deepseek.dsh.mobile;

import android.content.Intent;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * DSH 主界面。
 *
 * 这里额外承担两件事，都是为了解决"AI 干活时应用突然退到桌面"：
 *
 * 1) **渲染进程崩溃不杀应用**。
 *    WebView 的渲染进程（跑 JS 的那个）会因为内存吃紧被系统 OOM 杀掉。
 *    Capacitor 默认的 BridgeWebViewClient 在 onRenderProcessGone 里返回 false，
 *    含义是"我没处理"，Android 随即杀掉整个宿主进程——用户看到的就是应用闪退、
 *    退到桌面，再打开时页面重新加载、状态回滚成"坏数据"。
 *    这里覆写为返回 true 并重建 WebView 视图，让宿主进程活下来、页面自行恢复。
 *
 * 2) **页面崩溃留痕**。
 *    把异常写进应用私有目录，下次启动时可以在"诊断"里看到原因。
 */
public class MainActivity extends BridgeActivity {

    private static final String CRASH_LOG = "crash.log";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().addJavascriptInterface(
                    new DshHttpBridge(getBridge().getWebView()),
                    "DshNative"
            );
            getBridge().getWebView().addJavascriptInterface(
                    new DshHudBridge(getApplicationContext()),
                    "DshHud"
            );
            getBridge().getWebView().addJavascriptInterface(
                    new DshFsBridge(this, getBridge().getWebView()),
                    "DshFs"
            );
            getBridge().getWebView().addJavascriptInterface(
                    new DshKeepAliveBridge(getApplicationContext()),
                    "DshKeepAlive"
            );
            getBridge().getWebView().addJavascriptInterface(
                    new DshPowerBridge(getApplicationContext()),
                    "DshPower"
            );
            installCrashGuard(getBridge());
            keepRendererAlive();
        }
        lockTextZoom();
    }

    /**
     * 让 WebView 渲染进程在应用不可见时也不被系统降级回收。
     *
     * 这就是"切到后台任务自动停止"的主因。
     *
     * Android 8.0 起 WebView 跑在独立进程（sandboxed_process）里。
     * 系统按 Renderer Importance 策略决定何时回收它：默认策略下，
     * WebView 不可见时渲染进程会被降级到 RENDERER_PRIORITY_WAIVED，
     * 内存紧张时它是第一批被杀的候选。
     *
     * 渲染进程一死，WebView 的 JS 上下文整个消失——正在跑的 Agent 任务
     * （流式请求、AbortController、增量 DOM patch）全部归零，
     * 用户切回应用看到的就是"任务莫名中断"。
     *
     * setRendererPriorityPolicy(IMPORTANT, false) 表示：
     * "这个 WebView 很重要，即使不可见也不要放弃它的渲染进程"。
     *
     * 官方文档同时警告：调整该策略必须配套实现 onRenderProcessGone，
     * 否则渲染进程被杀时宿主进程会一起崩。installCrashGuard() 已经做了。
     */
    private void keepRendererAlive() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getBridge().getWebView().setRendererPriorityPolicy(
                        WebView.RENDERER_PRIORITY_IMPORTANT,
                        false // waivedWhenNotVisible=false：不可见时也不降级
                );
            }
        } catch (Throwable ignored) {
        }
    }

    /**
     * 给渲染进程崩溃加一层兜底。
     *
     * 做法：继承 Capacitor 的 BridgeWebViewClient，只覆写 onRenderProcessGone。
     * 默认实现返回 false，含义是"我没处理"，Android 随即杀掉整个宿主进程——
     * 用户看到的就是应用闪退退到桌面，再打开时页面重载、状态回滚成坏数据。
     *
     * 这里返回 true（表示自己处理），并让 Activity 走一次正常的重建流程：
     * 渲染进程已经被杀，WebView 里的 JS 状态必然丢失，但宿主进程活着，
     * 页面可以重新加载并从 localStorage 恢复会话（已分片落盘，不会再全丢）。
     */
    private void installCrashGuard(Bridge bridge) {
        final WebView webView = bridge.getWebView();
        if (webView == null) return;
        try {
            bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
                @Override
                public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                    boolean crashed = detail != null && detail.didCrash();
                    appendCrashLog("渲染进程" + (crashed ? "崩溃" : "被杀")
                            + "（didCrash=" + crashed + "）");
                    try {
                        Toast.makeText(MainActivity.this, "页面异常，正在自动恢复…", Toast.LENGTH_SHORT).show();
                    } catch (Throwable ignored) {
                    }
                    // 让宿主进程活着，把页面重新拉起来
                    view.postDelayed(() -> {
                        try {
                            Intent i = new Intent(MainActivity.this, MainActivity.class);
                            i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                            startActivity(i);
                            finish();
                        } catch (Throwable t) {
                            appendCrashLog("恢复页面失败：" + t);
                        }
                    }, 400);
                    // 返回 true：告诉系统"我已经处理了"，不要杀掉宿主进程
                    return true;
                }
            });
        } catch (Throwable t) {
            appendCrashLog("安装崩溃兜底失败：" + t);
        }
    }

    /** 把崩溃原因追加到应用私有目录的 crash.log。 */
    private void appendCrashLog(String reason) {
        try {
            File dir = getFilesDir();
            File f = new File(dir, CRASH_LOG);
            String stamp = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(new Date());
            try (PrintWriter w = new PrintWriter(new FileWriter(f, true))) {
                w.println(stamp + " " + reason);
            }
        } catch (Throwable ignored) {
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        lockTextZoom();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        lockTextZoom();
    }

    /**
     * 锁定 WebView 文本缩放为 100%。
     *
     * 页面尺寸完全由 CSS 固定 px 决定（图标、行高、胶囊高度都是设计稿数值）。
     * MIUI / HyperOS 等国产 ROM 会把「系统字体大小」写进 WebView 的 textZoom，
     * 于是文字被放大 1.3 倍而容器不变，出现字超出胶囊、标题挤出标题栏、
     * 行高错位等"UI 变形"。系统字体偏好改由应用内「外观与阅读 → 正文大小」承担。
     */
    private void lockTextZoom() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        try {
            WebSettings settings = getBridge().getWebView().getSettings();
            if (settings.getTextZoom() != 100) settings.setTextZoom(100);
        } catch (Exception ignored) {
        }
    }

    /** 文件选择器 / 另存为 的结果转交给文件桥。 */
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (DshFsBridge.handleActivityResult(requestCode, resultCode, data)) return;
        super.onActivityResult(requestCode, resultCode, data);
    }
}
