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
            // 本机 MCP：白名单读写 + 启停服务
            getBridge().getWebView().addJavascriptInterface(
                    new DshMcpBridge(getApplicationContext()),
                    "DshMcp"
            );
            // 语音识别：WebView 里没有 Web Speech API，必须走系统 SpeechRecognizer
            getBridge().getWebView().addJavascriptInterface(
                    new DshSpeechBridge(this, getBridge().getWebView()),
                    "DshSpeech"
            );
            // Node 插件运行时：DSH 的插件是进程内 npm 包，WebView 沙箱跑不了，
            // 只能把真 Node 拉起来（独立进程，不影响这里的渲染）
            //
            // 传 WebView 进去：Node 的响应要通过它 evaluateJavascript 送回页面，
            // 通道才有回路。
            getBridge().getWebView().addJavascriptInterface(
                    new DshNodeBridge(getApplicationContext(), getBridge().getWebView()),
                    "DshNode"
            );
            installCrashGuard(getBridge());
            keepRendererAlive();
            // 登记 WebView：悬浮窗要用它把「发消息 / 停止」指令送回页面里的 JS。
            //
            // HUD 服务跑在主进程，和这里是同一个进程，所以直接持有引用即可，
            // 不需要广播或 IPC。onDestroy 里会清掉。
            DshHudState.webView = getBridge().getWebView();
            // Node 通道同理：Node 的响应要送回页面。
            DshNodeChannel.get().attach(getBridge().getWebView());
        }
        lockTextZoom();
    }

    @Override
    public void onDestroy() {
        // 清掉 WebView 引用：Activity 死了之后这个引用就是悬空的，
        // 悬浮窗再调 sendCommand 会打到已销毁的 WebView 上。
        DshHudState.webView = null;
        // Node 通道同理 —— 它也持有 WebView 引用。
        DshNodeChannel.get().detach();
        super.onDestroy();
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
        // 无障碍保活对齐：用户在系统设置里刚打开/关掉无障碍开关回到本应用时，
        // 这里按系统权威状态同步保活前台服务的启停。
        // （前台启动，合法，不会触发 Android 12+ 的后台 FGS 限制。）
        try {
            // 本机控制启用时，确保 :device 进程活着。
            //
            // 这个进程装的是无障碍服务 + MCP server。它平时由系统绑定无障碍时拉起，
            // 但如果用户没开无障碍、或进程被清过，这里的幂等 start 能把它补回来。
            // 传 enabled 而不是让它读 SharedPreferences —— 跨进程的 SharedPreferences
            // 是进程内缓存，:device 那份可能是旧的。
            if (DshMcpPolicy.isEnabled(this)) {
                DshDeviceService.start(this, true);
            }
        } catch (Throwable ignored) {
        }
        // 无障碍保活与自愈任务已于 0.26.0 随无障碍通道一起删除。
        // 现在界面操作只走 Shizuku：它的权限来自 ADB，落在 shell 进程，
        // 不需要本进程常驻，也就不需要保活。
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

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (DshSpeechBridge.handlePermissionResult(requestCode, permissions, grantResults)) return;
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    /** 文件选择器 / 另存为 的结果转交给文件桥。 */
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (DshFsBridge.handleActivityResult(requestCode, resultCode, data)) return;
        super.onActivityResult(requestCode, resultCode, data);
    }
}
