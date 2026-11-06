package ai.deepseek.dsh.mobile;

import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.inputmethodservice.InputMethodService;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.util.Locale;

/**
 * DSH 输入法本体。
 *
 * ============ 为什么界面是 WebView ============
 *
 * 键盘的键位、候选条、面板全用 HTML/CSS 写，好处是能和主应用共用
 * 同一套设计变量（styles/tokens.css），改一次两边都变；代价是冷启动
 * 比原生 View 慢（首次 300-800ms）。
 *
 * 缓解办法只有一个：**实例复用**。onCreateInputView 只在第一次建，
 * 之后一直返回同一个 WebView。输入法一被系统唤起就必须秒开，
 * 每次重建等于每次都慢。
 *
 * ============ 为什么必须和主应用同进程 ============
 *
 * Android 9+ 禁止两个进程共用一个 WebView 数据目录（会直接崩），
 * 而键盘又需要和主页面同源才能共享 localStorage 与模型配置。
 * 所以 manifest 里不能给这个 Service 写 android:process。
 */
public class DshImeService extends InputMethodService {

    /** 键盘窗口高度（dp）。键区 4 行 + 候选条 + 工具条。 */
    private static final int KEYBOARD_DP = 290;

    /** 键盘底色。和 ime.css 里的 --bg-deep 保持一致。 */
    private static final int BG_DEEP = 0xFF050608;

    private final Handler main = new Handler(Looper.getMainLooper());

    private WebView webView;
    private DshImeBridge bridge;

    /** 承载 WebView 的外层容器。高度锁死在这里，WebView 只管填满。 */
    private FrameLayout container;

    /** 加载失败时显示的兜底提示。 */
    private TextView errorView;

    private ClipboardManager clipManager;
    private ClipboardManager.OnPrimaryClipChangedListener clipListener;

    @Override
    public void onCreate() {
        super.onCreate();
        DshImeState.imeWebView = null;
        applyWindowLayout();
    }

    /**
     * 把 IME 窗口收拾干净。
     *
     * ============ 为什么白边要在这里治 ============
     *
     * IME 的窗口背景来自 Service 的 theme。没指定 theme 时它继承
     * **application 的主题**，而应用主题是浅色的（DayNight 白天走 light），
     * 窗口背景就是一整块白。
     *
     * 窗口高度是 WRAP_CONTENT，实际内容比窗口矮一点的话，
     * 那多出来的一条就从这层白背景里露出来 ——
     * 用户看到的就是"屏幕底部一条白边"。
     *
     * 三处一起清：
     *   1. 窗口背景（theme 里的 windowBackground）
     *   2. decorView 背景（部分 ROM 会自己加一层）
     *   3. 系统给的 inputArea 容器背景
     *
     * 少清一层，白边就还在 —— 这是被多家 ROM 反复验证过的坑。
     */
    private void applyWindowLayout() {
        // getWindow() 返回的是 SoftInputWindow（一个 Dialog），
        // 要再取一层 .getWindow() 才拿得到真正的 android.view.Window。
        Window win = null;
        try {
            if (getWindow() != null) win = getWindow().getWindow();
        } catch (Exception ignored) {
        }
        if (win == null) return;
        applyWindowLayout(win);
    }

    /** 对着具体的 Window 做一次清理。onConfigureWindow 也会走这里。 */
    private void applyWindowLayout(Window win) {
        try {
            // 框架自己也会设这两个值（MATCH_PARENT x WRAP_CONTENT、BOTTOM），
            // 这里再设一遍是为了覆盖某些 ROM 的自定义行为。
            WindowManager.LayoutParams lp = win.getAttributes();
            lp.width = WindowManager.LayoutParams.MATCH_PARENT;
            lp.height = WindowManager.LayoutParams.WRAP_CONTENT;
            lp.gravity = Gravity.BOTTOM;
            win.setAttributes(lp);
        } catch (Exception ignored) {
        }
        try {
            win.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            View decor = win.getDecorView();
            if (decor != null) {
                decor.setBackgroundDrawable(null);
                // 系统给 IME 放我们视图的那个容器
                View area = decor.findViewById(android.R.id.inputArea);
                if (area != null) {
                    area.setBackgroundDrawable(null);
                }
            }
        } catch (Exception ignored) {
        }
    }

    @Override
    public View onCreateInputView() {
        if (container != null) return container;

        DisplayMetrics dm = getResources().getDisplayMetrics();
        int height = (int) (KEYBOARD_DP * dm.density);

        // ============ 为什么不能直接返回裸 WebView ============
        //
        // AOSP 的 InputMethodService.setInputView() 是这么写的：
        //
        //     mInputFrame.addView(view, new FrameLayout.LayoutParams(
        //             MATCH_PARENT, WRAP_CONTENT));
        //
        // 注意 addView 的第二个参数 —— 框架用**它自己的** LayoutParams
        // 覆盖了我们返回的 View 的布局参数。所以"给 WebView 设一个
        // 固定高度的 LayoutParams"这种常规做法在这里根本不生效。
        //
        // 结果是：inputArea（WRAP_CONTENT）里放着一个没有内在高度的
        // WebView，测出来高度为 0 —— 键盘就塌成屏幕底部一条缝，
        // 缝里露出来的正是 IME 窗口的白背景。
        //
        // 所以高度不能靠 LayoutParams，只能靠 onMeasure 硬写死。
        // KeyboardHost 就是干这个的：不管框架给什么规格，
        // 它永远报告 KEYBOARD_DP 这么高。
        KeyboardHost box = new KeyboardHost(this, height);
        box.setBackgroundColor(BG_DEEP);

        WebView wv = new WebView(this);
        wv.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        wv.setBackgroundColor(BG_DEEP);
        wv.setVerticalScrollBarEnabled(false);
        wv.setHorizontalScrollBarEnabled(false);
        // 长按弹"复制/搜索"菜单在键盘上完全是噪音
        wv.setLongClickable(false);
        wv.setHapticFeedbackEnabled(false);
        wv.setOnLongClickListener(v -> true);

        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // 键盘页要按 360dp 布局，不跟随系统字号放大 ——
        // 否则"特大号字体"用户会看到按键文字溢出
        s.setTextZoom(100);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }

        wv.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                // 键盘页和主应用共用 https://localhost 这个源：
                // 同源才能共享 localStorage，而实际文件全部来自 assets/public
                String path = req.getUrl().getPath();
                if (path == null) path = "";
                return serveAsset(path);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                // 键盘页里不该有任何跳转；万一有，拦住别让它把键盘变成浏览器
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req,
                                        WebResourceError err) {
                // 主框架加载失败 = 键盘页整个没起来。
                // 不给提示的话用户只看到一片空白，什么都做不了。
                if (req != null && req.isForMainFrame()) {
                    showError("键盘资源加载失败");
                }
            }
        });

        bridge = new DshImeBridge(this, wv);
        wv.addJavascriptInterface(bridge, "DshIme");
        // 同一个对象挂两个名字：voice.js 只认 window.DshSpeech，
        // 这样那份零依赖的语音状态机可以原样复用
        wv.addJavascriptInterface(bridge, "DshSpeech");
        // AI 改写要发 HTTP 请求。WebView 里直接 fetch 会被 CORS 挡住
        // （请求发得出去但响应读不到），所以同样走原生桥 ——
        // 和主应用用的是同一个 DshHttpBridge。
        wv.addJavascriptInterface(new DshHttpBridge(wv), "DshNative");

        wv.loadUrl("https://localhost/ime/keyboard.html");

        box.addView(wv);

        container = box;
        webView = wv;
        DshImeState.imeWebView = wv;

        // 兜底：8 秒还没拿到"准备好了"，就明确告诉用户出了什么事，
        // 而不是让人对着一条白边猜。
        main.postDelayed(() -> {
            if (bridge != null && !ready) {
                showError("键盘启动超时，请重启 DSH");
            }
        }, 8000);

        // 视图挂上去之后再清一次背景：onCreate 时 inputArea 还不存在，
        // 那时清不到它的背景。
        main.post(this::applyWindowLayout);

        return box;
    }

    /**
     * 覆写窗口布局。
     *
     * AOSP 默认行为就是 MATCH_PARENT x WRAP_CONTENT（非全屏时），
     * 这里显式写一遍是为了：
     *   1. 明确表达"我们不做全屏输入"
     *   2. 挡掉某些 ROM 擅自改成 MATCH_PARENT 的行为 ——
     *      那会让键盘窗口铺满全屏，露出的空白就是白边
     */
    @Override
    public void onConfigureWindow(Window win, boolean isFullscreen,
                                  boolean isCandidatesOnly) {
        if (isFullscreen) {
            super.onConfigureWindow(win, isFullscreen, isCandidatesOnly);
            return;
        }
        win.setLayout(WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.WRAP_CONTENT);
        // 这里是框架保证窗口有效的时机，顺手把背景清干净
        applyWindowLayout(win);
    }

    /** 键盘页是否已经就绪。 */
    private boolean ready;

    /**
     * 键盘视图的宿主容器：**永远报告固定高度**。
     *
     * ============ 为什么必须自己实现 onMeasure ============
     *
     * 系统把我们的视图塞进 android.R.id.inputArea 时用的是
     * `addView(view, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))`
     * —— 我们自己设的 LayoutParams 会被覆盖掉。
     *
     * 而 WebView 没有内在高度（它不像 TextView 那样能算出内容高度），
     * 在 WRAP_CONTENT 的父容器里就测成 0。
     *
     * 所以唯一可靠的办法是覆写 onMeasure，把高度直接钉成 KEYBOARD_DP。
     * 宽度跟随父容器（键盘要铺满屏幕宽度）。
     */
    static class KeyboardHost extends FrameLayout {

        private final int fixedHeight;

        KeyboardHost(Context ctx, int height) {
            super(ctx);
            this.fixedHeight = height;
        }

        @Override
        protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
            // 宽度：父容器给什么就用什么（一般是 EXACTLY = 屏幕宽）
            int width = MeasureSpec.getSize(widthMeasureSpec);
            // 高度：一律用固定值，不管父给的是 WRAP 还是 EXACTLY
            int height = fixedHeight;

            // 先按固定尺寸量一遍子 View，让 WebView 填满
            measureChildrenFixed(width, height);
            setMeasuredDimension(width, height);
        }

        /**
         * 按固定尺寸量子 View。
         *
         * 不能叫 measureChildren —— 那是 ViewGroup 的 protected 方法，
         * 同名会变成"尝试降低访问权限"的编译错误。
         */
        private void measureChildrenFixed(int width, int height) {
            for (int i = 0; i < getChildCount(); i++) {
                View child = getChildAt(i);
                if (child.getVisibility() == GONE) continue;
                child.measure(
                        MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
                        MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY));
            }
        }
    }

    /**
     * 显示错误提示。
     *
     * 直接盖在容器上，用户至少知道"键盘坏了"而不是"屏幕底下有根白条"。
     * 铺满整个键盘区域 —— 反正这时候键盘也没法用，
     * 提示比半残的键区更诚实。
     *
     * 附一个「重试」：出问题时用户能自救，
     * 而不用先退出应用重开（键盘坏了，退出应用这个动作本身就不直观）。
     */
    private void showError(String msg) {
        if (errorView == null && container != null) {
            errorView = new TextView(this);
            errorView.setTextColor(0xFFEDEBE4);
            errorView.setTextSize(14);
            errorView.setGravity(Gravity.CENTER);
            errorView.setPadding(24, 0, 24, 0);
            errorView.setBackgroundColor(BG_DEEP);
            // 只占上半部分，给下面的「重试」按钮腾地方
            FrameLayout.LayoutParams elp = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, 0);
            elp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
            elp.height = (int) (120 * getResources().getDisplayMetrics().density);
            container.addView(errorView, elp);
            // 「重试」按钮
            TextView retry = new TextView(this);
            retry.setText("重试");
            retry.setTextColor(0xFF7FD1C0);
            retry.setTextSize(15);
            retry.setGravity(Gravity.CENTER);
            retry.setPadding(0, 0, 0, 0);
            retry.setBackgroundColor(BG_DEEP);
            retry.setOnClickListener(v -> reloadKeyboard());
            FrameLayout.LayoutParams rlp = new FrameLayout.LayoutParams(
                    (int) (96 * getResources().getDisplayMetrics().density),
                    (int) (44 * getResources().getDisplayMetrics().density));
            rlp.gravity = Gravity.CENTER;
            container.addView(retry, rlp);
        }
        if (errorView != null) {
            errorView.setText(msg);
            errorView.setVisibility(View.VISIBLE);
        }
    }

    /** 重新加载键盘页。 */
    private void reloadKeyboard() {
        try {
            ready = false;
            if (errorView != null) errorView.setVisibility(View.GONE);
            if (webView != null) {
                webView.loadUrl("https://localhost/ime/keyboard.html");
            }
        } catch (Exception ignored) {
        }
    }

    /** 从 assets/public 里取文件。 */
    private WebResourceResponse serveAsset(String path) {
        String p = path.startsWith("/") ? path.substring(1) : path;
        if (p.isEmpty()) p = "ime/keyboard.html";
        try {
            InputStream in = getAssets().open("public/" + p);
            String mime = mimeOf(p);
            // 二进制资源绝不能带 utf-8 这个 encoding：wasm 有 11 MB，
            // 声明成文本后 WebView 有机会当字符串解一遍，白烧内存和时间。
            return new WebResourceResponse(mime, isTextMime(mime) ? "utf-8" : null, in);
        } catch (Exception e) {
            // 静默失败最难查：页面报不出错，只是一片空白。
            // 这里留个日志，真机上一看 logcat 就知道是哪个路径没命中。
            android.util.Log.w("DshIme", "资源缺失: public/" + p + " (" + e + ")");
            return new WebResourceResponse("text/plain", "utf-8",
                    new ByteArrayInputStream(new byte[0]));
        }
    }

    private static boolean isTextMime(String mime) {
        return mime.startsWith("text/")
                || mime.contains("javascript")
                || mime.equals("application/json")
                || mime.equals("image/svg+xml");
    }

    /**
     * 扩展名 → MIME。
     *
     * ============ 这张表决定键盘能不能用 ============
     *
     * 手写模块是 ESM：`import("./vendor/ort/ort.wasm.min.mjs")`。
     * 而 Chromium 对模块脚本做**严格 MIME 检查**，返回
     * application/octet-stream 时直接拒绝执行：
     *
     *     Failed to load module script: Expected a JavaScript-or-Wasm
     *     module script but the server responded with a MIME type of
     *     "application/octet-stream"
     *
     * 0.57.0 就栽在这 —— 表里只有 .js，没有 .mjs，于是手写面板
     * 一点开就是"识别引擎加载失败"。本地测试用的是 node 静态服务器，
     * 它的 MIME 表是全的，所以测试全绿、真机全挂。
     *
     * 教训：这张表是**生产环境的一部分**，测试必须照着它跑。
     * tests/ime-serve-mime-test.mjs 直接从本文件解析这张表来断言。
     */
    private String mimeOf(String p) {
        String low = p.toLowerCase(Locale.ROOT);
        if (low.endsWith(".html") || low.endsWith(".htm")) return "text/html";
        // .mjs 必须列在 .js 之外单独给：在 WebView 里它就是模块，
        // 类型给错的后果是整块功能哑火，而不是降级
        if (low.endsWith(".mjs")) return "application/javascript";
        if (low.endsWith(".js")) return "application/javascript";
        if (low.endsWith(".css")) return "text/css";
        if (low.endsWith(".json") || low.endsWith(".webmanifest")) return "application/json";
        if (low.endsWith(".txt")) return "text/plain";
        if (low.endsWith(".svg")) return "image/svg+xml";
        if (low.endsWith(".png")) return "image/png";
        if (low.endsWith(".jpg") || low.endsWith(".jpeg")) return "image/jpeg";
        if (low.endsWith(".webp")) return "image/webp";
        if (low.endsWith(".ico")) return "image/x-icon";
        if (low.endsWith(".wasm")) return "application/wasm";
        if (low.endsWith(".woff2")) return "font/woff2";
        if (low.endsWith(".woff")) return "font/woff";
        if (low.endsWith(".ttf")) return "font/ttf";
        // .ort / .bin 是 ONNX 权重和词库，只有 fetch 读字节，给什么都行
        return "application/octet-stream";
    }

    /* ---------------- 生命周期 ---------------- */

    @Override
    public void onStartInput(EditorInfo attribute, boolean restarting) {
        super.onStartInput(attribute, restarting);
        pushContext();
    }

    @Override
    public void onStartInputView(EditorInfo attribute, boolean restarting) {
        super.onStartInputView(attribute, restarting);
        // 窗口在每次显示前可能被系统重置（旋转、切换主题、多任务），
        // 所以布局要在这里再压一遍，不能只在 onCreate 里设一次。
        applyWindowLayout();
        pushContext();
        startClipWatch();
    }

    @Override
    public void onWindowShown() {
        super.onWindowShown();
        applyWindowLayout();
    }

    @Override
    public void onFinishInputView(boolean finishingInput) {
        stopClipWatch();
        super.onFinishInputView(finishingInput);
    }

    @Override
    public void onFinishInput() {
        // 换输入框 / 收起键盘时把键盘页的状态清干净：
        // 留着拼音缓冲，下一次唤起会在新输入框里接上上一次的输入
        DshImeState.toIme("window.__dshImeReset && window.__dshImeReset()");
        super.onFinishInput();
    }

    @Override
    public void onDestroy() {
        stopClipWatch();
        if (webView != null) {
            try {
                webView.destroy();
            } catch (Exception ignored) {
            }
        }
        webView = null;
        bridge = null;
        container = null;
        errorView = null;
        ready = false;
        DshImeState.imeWebView = null;
        super.onDestroy();
    }

    /**
     * 键盘页加载完并准备好时回调。
     *
     * 这时才推上下文 —— 页面还没跑起来就 evaluateJavascript，
     * 那段 JS 会直接丢掉（窗口里没有 __dshImeContext）。
     */
    void onKeyboardReady() {
        ready = true;
        if (errorView != null) errorView.setVisibility(View.GONE);
        pushContext();
    }

    private void pushContext() {
        if (bridge == null || webView == null) return;
        // 已经在主线程，直接同步取（getContext() 会 post 再等，会死锁）
        String json = bridge.contextJson();
        DshImeState.toIme("window.__dshImeContext && window.__dshImeContext("
                + JSONObject.quote(json) + ")");
    }

    /* ---------------- 剪贴板 ---------------- */

    private void startClipWatch() {
        if (clipListener != null) return;
        try {
            clipManager = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            clipListener = this::onClipChanged;
            clipManager.addPrimaryClipChangedListener(clipListener);
        } catch (Exception ignored) {
        }
    }

    private void stopClipWatch() {
        if (clipListener == null || clipManager == null) return;
        try {
            clipManager.removePrimaryClipChangedListener(clipListener);
        } catch (Exception ignored) {
        }
        clipListener = null;
    }

    private void onClipChanged() {
        try {
            if (clipManager == null || !clipManager.hasPrimaryClip()) return;
            ClipData clip = clipManager.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return;

            // 系统标记为敏感的（密码管理器复制的内容）不记录。
            //
            // ClipDescription.getExtras() 是 API 33 才公开的，
            // 老系统上只能靠 ClipDescription.EXTRA_IS_SENSITIVE 这个字符串键
            // 直接读 extras —— 用反射兜住，失败就当它不敏感。
            if (isSensitiveClip(clip)) {
                return;
            }
            CharSequence text = clip.getItemAt(0).coerceToText(this);
            if (text == null) return;
            DshImeState.addClip(this, text.toString());
        } catch (Exception ignored) {
        }
    }

    /**
     * 判断剪贴板内容是否被系统标记为敏感。
     *
     * 密码管理器复制出来的内容带着 EXTRA_IS_SENSITIVE 标记，
     * 把它记进历史就是泄露密码 —— 所以这条是硬边界。
     */
    private boolean isSensitiveClip(ClipData clip) {
        try {
            ClipDescription desc = clip.getDescription();
            if (desc == null) return false;
            // API 33+ 公开了 getExtras()，返回的是 PersistableBundle
            if (Build.VERSION.SDK_INT >= 33) {
                android.os.PersistableBundle pb = desc.getExtras();
                if (pb == null) return false;
                return pb.getBoolean(ClipDescription.EXTRA_IS_SENSITIVE, false);
            }
            // 老系统：extras 字段是 Bundle，用反射取
            try {
                java.lang.reflect.Field f = ClipDescription.class.getField("extras");
                Object v = f.get(desc);
                if (v instanceof android.os.Bundle) {
                    return ((android.os.Bundle) v).getBoolean(ClipDescription.EXTRA_IS_SENSITIVE, false);
                }
            } catch (Exception ignored) {
            }
            return false;
        } catch (Exception ignored) {
            return false;
        }
    }

    /* ---------------- 截图 ---------------- */

    /**
     * 截图入口。
     *
     * 必须先收起键盘再截 —— 否则截到的是"带键盘的屏幕"，
     * 而用户想要的是键盘底下那个应用的样子。
     */
    void startCapture() {
        try {
            requestHideSelf(0);
        } catch (Exception ignored) {
        }
        main.postDelayed(() -> {
            try {
                DshImeActivity.startCapture(this);
            } catch (Exception ignored) {
            }
        }, 420);
    }
}
