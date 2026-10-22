package ai.deepseek.dsh.mobile;

import android.content.ComponentName;
import android.content.Context;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.os.IBinder;
import android.util.Log;
import android.util.Xml;

import org.xmlpull.v1.XmlPullParser;

import java.io.StringReader;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

import rikka.shizuku.Shizuku;

/**
 * Shizuku 通道 —— 「低速通道」。
 *
 * ============ 它解决的是哪一类问题 ============
 *
 * 高速通道（无障碍）的权限来自「系统对 AccessibilityService 的绑定」。
 * vivo / 小米 / OPPO 这类 ROM 的省电策略会把那条绑定摘掉 ——
 * 日志里的表现是 `onUnbind：系统开关 已关闭 · 总开关=开`，而进程 pid 一直没变。
 * 应用侧没有任何合法手段阻止它，只能眼睁睁看着实例变 null。
 *
 * Shizuku 的权限来自 ADB（或 root），落在 **shell 进程** 里（uid 2000）。
 * 它完全不经过 AccessibilityManagerService，所以：
 *
 *     无障碍被摘 → 高速通道不可用，低速通道照常工作。
 *
 * 这就是双通道的意义：不是二选一，而是「谁活着用谁」。
 *
 * ============ 能力对照 ============
 *
 *              高速（无障碍）        低速（Shizuku）
 *   读界面     getRootInActiveWindow  uiautomator dump（慢 1~2s）
 *   点击       dispatchGesture       input tap
 *   滑动       dispatchGesture       input swipe
 *   输入英文   ACTION_SET_TEXT       input text
 *   输入中文   ACTION_SET_TEXT       ✗（input text 只吃 ASCII）
 *   返回/桌面  performGlobalAction   input keyevent
 *
 * ============ 前提 ============
 *
 * 1. 手机装了 Shizuku 且服务在运行（重启后需重新启动一次，除非有 root）
 * 2. 用户在 Shizuku 里授权了本应用
 * 3. 本应用已声明 {@link DshShizukuService}（会被加载到 shell 进程执行）
 */
public final class DshShizuku {

    private static final String TAG = "DshShizuku";

    /** 权限申请码，任意唯一值。 */
    private static final int REQ_CODE = 0x5A1;

    /**
     * uiautomator 的 bounds 格式，固定就是 `[l,t][r,b]`。
     *
     * 用正则而不是 indexOf('[') 是有原因的：控件文字里可能本身就带方括号
     * （"[图片]"、"价格[1,2]" 这类），indexOf 会先命中文字里的那个，
     * 解析出来的坐标整体错位。正则匹配「两个数字对」的形状，
     * 正好跳过文字里的干扰。
     */
    private static final java.util.regex.Pattern BOUNDS_RE =
            java.util.regex.Pattern.compile("\\[(-?\\d+),(-?\\d+)\\]\\[(-?\\d+),(-?\\d+)\\]");

    private static final Object LOCK = new Object();
    private static volatile IShizukuExec remote = null;
    private static volatile boolean binding = false;
    private static volatile boolean listenersReady = false;
    private static volatile String lastError = "";
    /**
     * 留一份 Application Context 专供写诊断日志。
     *
     * 为什么不在每个地方都传 ctx：listener 是在 binder 线程被回调的，
     * 那些 lambda 捕获不到调用者的 ctx，而日志又必须能写进同一个文件 ——
     * 否则排查时看不到「Shizuku 什么时候连上/断开的」。
     */
    private static volatile Context appCtx;
    private static ServiceConnection conn = null;

    /* ------------------------------------------------------------ 状态 */

    public static final int ST_NOT_INSTALLED = 0;
    public static final int ST_NOT_RUNNING = 1;
    public static final int ST_NO_PERMISSION = 2;
    public static final int ST_CONNECTING = 3;
    public static final int ST_READY = 4;
    /** 已授权但还没建连接（首次调用时会自动建立）。 */
    public static final int ST_IDLE = 5;

    /** Shizuku 应用是否装着。 */
    public static boolean installed(Context ctx) {
        try {
            ctx.getPackageManager().getPackageInfo("moe.shizuku.privileged.api", 0);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** Shizuku 服务是否在运行（binder 是否可达）。 */
    public static boolean running() {
        try {
            return Shizuku.pingBinder();
        } catch (Throwable t) {
            return false;
        }
    }

    /** 是否已获得本应用的授权。 */
    public static boolean granted() {
        try {
            return Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) {
            // binder 没就绪时这里会抛，按未授权处理
            return false;
        }
    }

    public static int state(Context ctx) {
        // ============ 判断顺序很重要（0.25.1 修正）============
        //
        // 之前先判断 installed(ctx)，而它依赖 getPackageInfo —— 受 Android 11+
        // 的包可见性限制。只要 <queries> 少一行，它就恒为 false，
        // 于是直接返回「未安装」，「授权」按钮根本不出现，
        // 用户会以为 Shizuku 没装，而 Shizuku 那边连一条授权申请都收不到。
        //
        // 现在先问 binder 通不通：pingBinder 走的是 ContentProvider 的显式
        // authorities，不受包可见性影响，是最本质的判据 ——
        // **能连上就说明它装着且在运行**，比查包名可靠。
        //
        // installed() 退化为兜底：只在连不上时才用来区分「没装」和「装了没启动」。
        if (running()) {
            if (!granted()) return ST_NO_PERMISSION;
            if (remote != null) return ST_READY;
            if (binding) return ST_CONNECTING;
            return ST_IDLE;
        }
        return installed(ctx) ? ST_NOT_RUNNING : ST_NOT_INSTALLED;
    }

    /**
     * 给界面和模型看的一句话状态。
     *
     * 分成五档是有必要的：这五档对用户来说是完全不同的动作
     * （去装应用 / 去启动服务 / 去点授权 / 等一下 / 可以用），
     * 笼统说「不可用」会让人无从下手。
     */
    public static String describe(Context ctx) {
        switch (state(ctx)) {
            case ST_NOT_INSTALLED:
                return "未安装 Shizuku";
            case ST_NOT_RUNNING:
                // 两种情况在应用侧看起来一样（binder 拿不到），但对用户来说是
                // 完全不同的动作：去启动 Shizuku / 重启 DSH 让本进程重新拿 binder。
                return "没连上 Shizuku（可能它没在运行，也可能是本应用没拿到 binder —— 重启一次 DSH 再试）";
            case ST_NO_PERMISSION:
                return "Shizuku 在运行，但还没授权本应用";
            case ST_READY:
                return "就绪 · 可以执行 shell 命令（uid " + safeUid() + "）";
            case ST_IDLE:
                return "已授权 · 尚未建立连接（调用 ui_* 时会自动连上）";
            default:
                return "正在连接 Shizuku…" + (lastError.isEmpty() ? "" : "（" + lastError + "）");
        }
    }

    private static String safeUid() {
        try {
            return String.valueOf(Shizuku.getUid());
        } catch (Throwable t) {
            return "?";
        }
    }

    /* ------------------------------------------------------------ 授权 */

    /**
     * 申请授权。必须由用户在 Shizuku 的对话框里点「允许」。
     *
     * @return 是否成功发起了申请（不代表已授权，结果走 listener）
     */
    public static boolean request(Context ctx) {
        try {
            appCtx = ctx.getApplicationContext();
            ensureListeners();

            // binder 是**异步**到达的：requestBinderForNonProviderProcess 先注册
            // BINDER_RECEIVED 广播，Shizuku 那边收到请求后才把 binder 送过来。
            // 用户点「授权」时进程可能刚起来，binder 还没到 —— 这里等最多 2 秒。
            //
            // 注意：调用方必须在工作线程（见 DshDeviceService），主线程 sleep 会 ANR。
            for (int i = 0; i < 20 && !running(); i++) {
                try {
                    Thread.sleep(100);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }

            if (!running()) {
                lastError = "binder 未就绪（Shizuku 没在运行，或本进程还没拿到 binder）";
                diag("shizuku：授权失败 · " + lastError);
                return false;
            }
            Shizuku.requestPermission(REQ_CODE);
            diag("shizuku：已发出授权申请");
            return true;
        } catch (Throwable t) {
            lastError = t.getClass().getSimpleName();
            diag("shizuku：requestPermission 异常 " + t);
            Log.w(TAG, "requestPermission failed: " + t);
            return false;
        }
    }

    /**
     * 注册 Shizuku 的全局监听。
     *
     * 这三个 listener 是「用户不重启应用也能恢复」的关键：
     *   binder 到达 → 自动建连接（用户刚启动 Shizuku）
     *   binder 死亡 → 清掉旧 binder（Shizuku 被杀了）
     *   授权结果   → 记下来
     */
    /** 写一行诊断日志（进程内共用一份 appCtx）。 */
    private static void diag(String event) {
        try {
            DshA11yDiagnostics.log(appCtx, event);
        } catch (Throwable ignored) {
        }
    }

    private static void ensureListeners() {
        if (listenersReady) return;
        synchronized (LOCK) {
            if (listenersReady) return;
            try {
                Shizuku.addBinderReceivedListener(() -> {
                    diag("shizuku：binder 到达");
                    lastError = "";
                });
                Shizuku.addBinderDeadListener(() -> {
                    diag("shizuku：binder 断开");
                    remote = null;
                    binding = false;
                    lastError = "Shizuku 服务已断开";
                });
                Shizuku.addRequestPermissionResultListener((code, grantResult) -> {
                    if (code == REQ_CODE) {
                        boolean ok = grantResult == PackageManager.PERMISSION_GRANTED;
                        diag("shizuku：授权结果 " + (ok ? "允许" : "拒绝"));
                        if (!ok) {
                            lastError = "用户拒绝了授权";
                            return;
                        }
                        // 授权成功后立刻建 UserService 连接。
                        // 不建的话状态会停在「已授权 · 未连接」，用户以为没成功；
                        // 而且第一次 ui_* 调用要现场等 4 秒。
                        // 这个回调在 binder 线程，等 4 秒不会 ANR。
                        Thread t = new Thread(() -> {
                            if (appCtx != null) connect(appCtx);
                        }, "shizuku-auto-connect");
                        t.setDaemon(true);
                        t.start();
                    }
                });
                listenersReady = true;
            } catch (Throwable t) {
                Log.w(TAG, "addListener failed: " + t);
            }
        }
    }

    /* ------------------------------------------------------------ 连接 */

    /**
     * 建立 UserService 连接（幂等）。
     *
     * `bindUserService` 是异步的，这里最多等 4 秒。调用方通常是 MCP 的工作线程，
     * 不是主线程 —— 所以这里的 sleep 不会 ANR。
     */
    public static boolean connect(Context ctx) {
        appCtx = ctx.getApplicationContext();
        ensureListeners();
        if (remote != null) return true;
        if (!running() || !granted()) return false;

        synchronized (LOCK) {
            if (remote != null) return true;
            if (!binding) {
                binding = true;
                try {
                    conn = new ServiceConnection() {
                        @Override
                        public void onServiceConnected(ComponentName name, IBinder binder) {
                            try {
                                remote = IShizukuExec.Stub.asInterface(binder);
                                lastError = "";
                                diag("shizuku：UserService 已连接");
                            } catch (Throwable t) {
                                lastError = "连接对象无效";
                            }
                        }

                        @Override
                        public void onServiceDisconnected(ComponentName name) {
                            remote = null;
                            binding = false;
                            lastError = "UserService 断开";
                        }
                    };
                    // tag 显式给死：Shizuku 用它判断"是不是同一个 UserService"。
                    // 不给的话会用类名，而类名在 R8/ProGuard 之后会变，
                    // 升级后就认不出旧实例、越积越多。
                    Shizuku.UserServiceArgs args = new Shizuku.UserServiceArgs(
                            new ComponentName(ctx.getPackageName(), DshShizukuService.class.getName()))
                            .tag("dsh_exec")
                            .daemon(false)
                            .processNameSuffix("shizuku")
                            .debuggable(false)
                            .version(1);
                    Shizuku.bindUserService(args, conn);
                } catch (Throwable t) {
                    binding = false;
                    lastError = t.getClass().getSimpleName();
                    Log.w(TAG, "bindUserService failed: " + t);
                    return false;
                }
            }
        }

        // 等回调。binder 线程回调很快，正常 < 200ms。
        long deadline = System.currentTimeMillis() + 4000;
        while (System.currentTimeMillis() < deadline) {
            if (remote != null) return true;
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        if (lastError.isEmpty()) lastError = "连接超时";
        return remote != null;
    }

    /* ------------------------------------------------------------ 执行 */

    /** 执行一条 shell 命令。未连接时先尝试连接。 */
    public static String exec(Context ctx, String cmd) throws Exception {
        if (!connect(ctx)) {
            throw new Exception("Shizuku 通道不可用：" + describe(ctx));
        }
        synchronized (LOCK) {
            try {
                String out = remote.exec(cmd);
                return out == null ? "" : out;
            } catch (Throwable t) {
                remote = null;
                binding = false;
                throw new Exception("Shizuku 执行失败：" + t.getClass().getSimpleName());
            }
        }
    }

    /* ------------------------------------------------------------ 读界面 */

    private static final java.util.regex.Pattern PKG_RE =
            java.util.regex.Pattern.compile("([a-zA-Z][a-zA-Z0-9_]*(?:\\.[a-zA-Z0-9_]+)+)/");

    /**
     * 取当前的两个窗口归属：**焦点窗口** 和 **焦点 Activity**。
     *
     * ============ 为什么不能只看 mCurrentFocus（0.26.2 修）============
     *
     * `mCurrentFocus` 指的是「现在接收输入的那个窗口」，它不一定是应用：
     *
     *   软键盘弹出       → 某些 ROM 上焦点是输入法（com.baidu.input/…）
     *   下拉通知栏       → 焦点是 com.android.systemui
     *   ANR / 权限弹窗   → 焦点是 android 或 com.android.permissioncontroller
     *
     * 之前只拿这一个值去比对白名单，于是「点软键盘」「点系统弹窗」全被拒 ——
     * 用户看到的是「明明在操作自己的应用，却说不允许」。
     *
     * `mFocusedApp` 指的是「焦点 Activity 属于哪个应用」，它不会因为输入法或
     * 系统浮层而改变。所以真正的判定顺序是：
     *
     *   焦点是输入法 → 用 mFocusedApp 判定（键盘是为那个应用服务的）
     *   焦点是系统 UI → 直接放行（它不是任何应用的数据）
     *   其余          → 用焦点包名判定
     *
     * @return {@code [0]} 焦点窗口包名，{@code [1]} 焦点 Activity 包名，都可能为 null
     */
    public static String[] currentWindows(Context ctx) throws Exception {
        String out = exec(ctx, "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp' | head -6");
        String focus = null, app = null;
        for (String line : (out == null ? "" : out).split("\n")) {
            java.util.regex.Matcher m = PKG_RE.matcher(line);
            if (!m.find()) continue;
            String pkg = m.group(1);
            if (line.contains("mCurrentFocus") && focus == null) focus = pkg;
            else if (line.contains("mFocusedApp") && app == null) app = pkg;
        }
        return new String[]{focus, app};
    }

    /**
     * 快速取当前前台应用包名（约 100~200ms）。
     *
     * 为什么不直接用 {@link #dump}：点击/滑动/输入前都要做白名单校验，
     * 而一次完整 dump 要 1~2 秒。为了校验去 dump 一次，等于把每个动作都拖慢一倍。
     *
     * `dumpsys window` 只读窗口焦点，代价小得多，够用来回答"现在是谁在前台"。
     *
     * 注意：这里返回的是**焦点窗口**的包名，可能是输入法或 systemui。
     * 要判断"该不该允许操作"，用 {@link #currentWindows} + 白名单组合判断。
     */
    public static String currentPackage(Context ctx) throws Exception {
        String[] w = currentWindows(ctx);
        return w[0] != null ? w[0] : w[1];
    }

    /* ------------------------------------------------------ 输入法识别 */

    private static volatile Set<String> imeCache = null;
    private static volatile long imeCacheAt = 0;

    /**
     * 系统里启用的输入法包名（60 秒缓存）。
     *
     * 为什么要有缓存：每次点击/滑动都要判定一次，而这里要跨进程读 Secure 设置，
     * 虽然很快，但没必要每个动作都读一遍 —— 输入法列表只在用户切换键盘时变。
     *
     * 三条路兜底，因为单独任何一条在 :device 进程里都可能拿不到：
     *   1. InputMethodManager.getEnabledInputMethodList()  —— 最准，但依赖 IMM 初始化
     *   2. Settings.Secure "enabled_input_methods"        —— "pkg/cls:pkg/cls"
     *   3. Settings.Secure DEFAULT_INPUT_METHOD           —— 至少能拿到当前在用的那个
     */
    public static Set<String> imePackages(Context ctx) {
        long now = System.currentTimeMillis();
        Set<String> c = imeCache;
        if (c != null && now - imeCacheAt < 60_000) return c;

        Set<String> out = new java.util.LinkedHashSet<>();
        try {
            android.view.inputmethod.InputMethodManager imm =
                    (android.view.inputmethod.InputMethodManager)
                            ctx.getSystemService(android.content.Context.INPUT_METHOD_SERVICE);
            if (imm != null) {
                for (android.view.inputmethod.InputMethodInfo i : imm.getEnabledInputMethodList()) {
                    String p = i == null ? null : i.getPackageName();
                    if (p != null && !p.isEmpty()) out.add(p);
                }
            }
        } catch (Throwable ignored) {
        }
        for (String key : new String[]{"enabled_input_methods", "default_input_method"}) {
            try {
                String raw = android.provider.Settings.Secure.getString(
                        ctx.getContentResolver(), key);
                if (raw == null) continue;
                for (String one : raw.split(":")) {
                    String p = one.trim();
                    int slash = p.indexOf('/');
                    if (slash > 0) p = p.substring(0, slash);
                    if (p.startsWith("com.") || p.contains(".")) out.add(p);
                }
            } catch (Throwable ignored) {
            }
        }
        imeCache = out;
        imeCacheAt = now;
        return out;
    }

    /** 这个包名是不是输入法。 */
    public static boolean isIme(Context ctx, String pkg) {
        if (pkg == null || pkg.isEmpty()) return false;
        return imePackages(ctx).contains(pkg);
    }

    /**
     * 软键盘现在是不是弹着的。
     *
     * 这个信息很关键：`uiautomator dump` 只 dump **活动窗口**，
     * 而软键盘是独立的 `TYPE_INPUT_METHOD` 窗口 —— 它根本不在 dump 结果里。
     * 所以「点软键盘」这件事，靠 dump 找控件永远找不到，
     * 必须明确告诉模型"看不见它"，而不是让它反复重试。
     */
    public static boolean imeShown(Context ctx) {
        try {
            String out = exec(ctx, "dumpsys input_method | grep -m1 -E 'mInputShown|mIsInputViewShown'");
            return out != null && out.contains("true");
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 用 `uiautomator dump` 读当前界面，并转成和高速通道一致的文本格式。
     *
     * 为什么要转格式：模型已经在用高速通道的输出格式（`#1 TextView "文字" [l,t][r,b] 可点`）。
     * 两条通道输出不同格式的话，要么模型要学两套，要么提示词里得解释"这次是哪种"。
     * 统一格式后，模型完全不需要知道走的是哪条。
     *
     * @return {@code [0]} 前台包名（可能为空），{@code [1]} 文本
     */
    public static String[] dump(Context ctx) throws Exception {
        // 先删旧文件：dump 失败时 cat 会读到上一次的内容，那比报错更危险
        String xml = exec(ctx,
                "rm -f /data/local/tmp/dsh_ui.xml; "
                        + "uiautomator dump --compressed /data/local/tmp/dsh_ui.xml >/dev/null 2>&1; "
                        + "cat /data/local/tmp/dsh_ui.xml 2>/dev/null");
        if (xml == null || !xml.contains("<hierarchy")) {
            String hint = xml == null ? "" : xml.trim();
            if (hint.length() > 200) hint = hint.substring(0, 200);
            throw new Exception("Shizuku 读不到界面（uiautomator dump 未产出结果）"
                    + (hint.isEmpty() ? "" : "：" + hint));
        }

        String[] r = parse(xml);

        // 软键盘是独立的 TYPE_INPUT_METHOD 窗口，uiautomator 只 dump 活动窗口，
        // 所以它**永远不在这份列表里**。不告诉模型的话，它会一直重试「找不到发送键」。
        if (imeShown(ctx)) {
            r[1] = r[1] + "\n（软键盘正在显示，但它是独立窗口，不在上面这份列表里。"
                    + "要输入文字用 ui_set_text；要提交/搜索用 ui_global 的 enter；"
                    + "要删字用 ui_global 的 delete。不要靠猜坐标点键盘。）";
        }
        return r;
    }

    /**
     * 解析 uiautomator 的 XML。
     *
     * 只输出「有内容的节点」——纯容器节点对模型没意义，还会把 400 个名额占满。
     * 这和高速通道的过滤规则一致（text / desc / clickable / editable 至少占一个）。
     *
     * ============ 为什么每行要带「中心(x,y)」（0.26.1 补）============
     *
     * 之前只给 bounds，让模型自己去算中点。模型算中点经常出错：
     * 把 `[l,t][r,b]` 当成 `(l,t,r,b)` 四个数、把 x/y 弄反、
     * 或者干脆按百分比估 —— 结果点偏，用户看到的就是「坐标有偏差」。
     *
     * 算中点是纯机械劳动，交给代码做，模型只需要抄数字。
     * 这比任何提示词约束都可靠。
     *
     * 同时头部补上「屏幕尺寸 + 旋转」：没有分母，模型就算想按比例换算也无从下手。
     * 尺寸取的是所有节点 bounds 的并集，**与下面每一行的坐标系完全同源**，
     * 比 `wm size` 靠谱 —— 后者在横屏、分屏、分辨率 override 时都会给错。
     */
    private static String[] parse(String xml) throws Exception {
        UiDump d = parseDump(xml);
        return new String[]{d.app, renderText(d)};
    }

    /* ------------------------------------------------------------ 结构化元素 */

    /**
     * 一个界面元素（归一化后的）。
     *
     * ============ 为什么要有 resource_id（0.33.0）============
     *
     * 之前只解析 text / content-desc / class / bounds / clickable，
     * **不读 resource-id**。代价很直接：
     *
     *   图标按钮（ImageView + view-id，没有文字也没有 content-desc）
     *   在 dump 里就是一行「没有名字的控件」。
     *   模型想点它只能去猜坐标 —— 而它恰好是最容易点错的一类
     *   （搜索放大镜、更多菜单、返回箭头、勾选框）。
     *
     * 「手机控屏经验层」那份材料的 README 第 6 条踩坑记的正是这件事：
     * 最初只留 clickable / editable / 有文本的元素，结果图标按钮全被丢掉，
     * 回放定位 100% 失败。现在补上。
     */
    public static final class UiElement {
        public String ref = "";
        public String type = "View";
        public String text = "";
        public String desc = "";
        public String resourceId = "";
        public String bounds = "";
        public int[] rect; // {l, t, r, b}
        public boolean clickable;
        public boolean editable;

        /** 这个元素的语义标签：文字 → 描述 → #资源 id。 */
        public String label() {
            if (!text.isEmpty()) return text;
            if (!desc.isEmpty()) return desc;
            if (!resourceId.isEmpty()) return "#" + resourceId;
            return "";
        }

        /** 中心点；解析不出 bounds 时返回 null。 */
        public int[] center() {
            return rect == null ? null : new int[]{(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2};
        }

        /** 面积；用来在多个同名元素里挑「最像按钮的那个」。 */
        public int area() {
            if (rect == null) return Integer.MAX_VALUE;
            return Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1]);
        }
    }

    /** 一次 dump 的完整结果。 */
    public static final class UiDump {
        public String app = "";
        public String rotation = "?";
        public int width = 0;
        public int height = 0;
        public final List<UiElement> elements = new ArrayList<>();
    }

    /**
     * 解析 uiautomator 的 XML，产出结构化元素。
     *
     * ============ ref 是什么（0.33.0）============
     *
     * ref 是「可重新定位的语义键」，形如：
     *
     *     Button|搜索          有文字
     *     ImageView|#icon-1    只有资源 id 的图标按钮
     *     Button|搜索#2        同名元素里的第二个
     *
     * 为什么不用行号（`#3`）当引用：
     * 行号只在**这一次 dump 内**有效。模型 dump 完、决定点哪个、再点的时候，
     * 屏幕可能已经变了（列表滚了、弹窗来了）—— 行号会指向别的元素。
     * 语义键可以在**点击的那一刻重新 dump 再找一次**，这才是「按语义定位」。
     *
     * 同名元素加 `#N` 后缀：同一个界面上「更多」可能有好几个，
     * 不区分就等于让模型盲选。
     */
    private static UiDump parseDump(String xml) throws Exception {
        XmlPullParser p = Xml.newPullParser();
        p.setInput(new StringReader(xml));
        UiDump d = new UiDump();
        String rootPkg = "";
        String rotation = "?";
        int maxR = 0, maxB = 0;
        int count = 0;

        int ev;
        while ((ev = p.next()) != XmlPullParser.END_DOCUMENT) {
            if (ev != XmlPullParser.START_TAG) continue;

            if ("hierarchy".equals(p.getName()) && "?".equals(rotation)) {
                String r = attr(p, "rotation");
                if (notEmpty(r)) rotation = r.trim();
                continue;
            }
            if (!"node".equals(p.getName())) continue;

            String pkg = attr(p, "package");
            if (rootPkg.isEmpty() && pkg != null && !pkg.isEmpty()) rootPkg = pkg;

            String text = trim(attr(p, "text"));
            String desc = trim(attr(p, "content-desc"));
            String cls = attr(p, "class");
            String bounds = attr(p, "bounds");
            String rid = trim(attr(p, "resource-id"));

            // 屏幕尺寸：拿所有节点 bounds 的并集（容器节点也包括，所以不会小于真实屏幕）
            int[] rect = rect(bounds);
            if (rect != null) {
                if (rect[2] > maxR) maxR = rect[2];
                if (rect[3] > maxB) maxB = rect[3];
            }

            boolean clickable = "true".equals(attr(p, "clickable"));
            boolean editable = cls != null && cls.contains("EditText");

            // 「有内容」的定义现在包含 resource-id —— 见 UiElement 的注释。
            boolean interesting = notEmpty(text) || notEmpty(desc) || notEmpty(rid) || clickable || editable;
            if (!interesting) continue;
            if (count >= 400) break;

            count++;
            UiElement e = new UiElement();
            e.type = shortClass(cls);
            e.text = text;
            e.desc = desc;
            e.resourceId = rid;
            e.bounds = notEmpty(bounds) ? bounds : "";
            e.rect = rect;
            e.clickable = clickable;
            e.editable = editable;
            d.elements.add(e);
        }

        d.app = rootPkg;
        d.rotation = rotation;
        d.width = maxR;
        d.height = maxB;
        assignRefs(d.elements);
        return d;
    }

    /**
     * 给元素分配 ref。
     *
     * 规则：
     *   1. 基础键 = `类型|标签`，标签取文字 → 描述 → #资源 id；
     *   2. 基础键重复时，全部改成 `基础键#序号`（序号从 1 开始）；
     *   3. 标签为空（什么信息都没有的容器）不给 ref —— 给一个点不中的引用比不给更糟。
     */
    private static void assignRefs(List<UiElement> elements) {
        java.util.Map<String, Integer> total = new java.util.LinkedHashMap<>();
        for (UiElement e : elements) {
            String label = e.label();
            if (label.isEmpty()) continue;
            String base = e.type + "|" + label;
            Integer c = total.get(base);
            total.put(base, c == null ? 1 : c + 1);
        }
        java.util.Map<String, Integer> seen = new java.util.LinkedHashMap<>();
        for (UiElement e : elements) {
            String label = e.label();
            if (label.isEmpty()) continue;
            String base = e.type + "|" + label;
            if (total.get(base) > 1) {
                int n = seen.containsKey(base) ? seen.get(base) + 1 : 1;
                seen.put(base, n);
                e.ref = base + "#" + n;
            } else {
                e.ref = base;
            }
        }
    }

    /** 把结构化 dump 转成给模型看的文本（格式与 0.32.0 完全一致，向后兼容）。 */
    private static String renderText(UiDump d) {
        StringBuilder sb = new StringBuilder();
        int idx = 0;
        for (UiElement e : d.elements) {
            idx++;
            sb.append('#').append(idx).append(' ');
            sb.append(e.type);
            if (!e.text.isEmpty()) sb.append(" \"").append(e.text).append('"');
            if (!e.desc.isEmpty()) sb.append(" desc=\"").append(e.desc).append('"');
            // 只有资源 id 的元素（图标按钮）额外给出 id —— 它是这类控件唯一的抓手
            if (e.text.isEmpty() && e.desc.isEmpty() && !e.resourceId.isEmpty()) {
                sb.append(" id=\"").append(e.resourceId).append('"');
            }
            if (!e.bounds.isEmpty()) sb.append(' ').append(e.bounds);
            int[] c = e.center();
            if (c != null) sb.append(" 中心(").append(c[0]).append(',').append(c[1]).append(')');
            if (e.clickable) sb.append(" 可点");
            if (e.editable) sb.append(" 可输入");
            sb.append('\n');
        }

        if (d.elements.isEmpty()) sb.append("（界面上没有取到可读控件，可能是纯图形界面）\n");
        else if (d.elements.size() >= 400) sb.append("…（控件过多，只列前 400 个）\n");

        StringBuilder head = new StringBuilder();
        head.append("前台应用：").append(d.app.isEmpty() ? "未知" : d.app).append('\n');
        if (d.width > 0 && d.height > 0) {
            head.append("屏幕：").append(d.width).append('×').append(d.height)
                    .append(" 像素 · 旋转 ").append(rotateDeg(d.rotation))
                    .append("° · 原点在左上角\n")
                    .append("（下面每行的 中心(x,y) 已经是屏幕绝对坐标，可直接传给 ui_tap；")
                    .append("若你手上有截图，坐标要按 截图宽:").append(d.width)
                    .append(" 等比换算，不能直接用图片像素）\n");
        }
        head.append("界面控件：\n");
        return head + sb.toString().trim();
    }

    /**
     * 结构化 dump：拿元素列表。
     *
     * 与 {@link #dump(Context)} 的区别：dump 给模型看的文本，
     * 这个给程序用（按 ref 重新定位、按标签匹配）。
     */
    public static UiDump dumpElements(Context ctx) throws Exception {
        String xml = exec(ctx,
                "rm -f /data/local/tmp/dsh_ui.xml; "
                        + "uiautomator dump --compressed /data/local/tmp/dsh_ui.xml >/dev/null 2>&1; "
                        + "cat /data/local/tmp/dsh_ui.xml 2>/dev/null");
        if (xml == null || !xml.contains("<hierarchy")) {
            String hint = xml == null ? "" : xml.trim();
            if (hint.length() > 200) hint = hint.substring(0, 200);
            throw new Exception("Shizuku 读不到界面（uiautomator dump 未产出结果）"
                    + (hint.isEmpty() ? "" : "：" + hint));
        }
        return parseDump(xml);
    }

    /**
     * 按 ref 重新定位元素。
     *
     * ref 形如 `Button|搜索` / `ImageView|#icon-1` / `Button|搜索#2`。
     * 找不到就返回 null —— **绝不猜坐标**，这是语义定位的全部意义。
     */
    public static UiElement findByRef(UiDump d, String ref) {
        if (d == null || ref == null) return null;
        String want = ref.trim();
        if (want.isEmpty()) return null;

        // 拆出可能的 #序号 后缀
        int nth = 1;
        String base = want;
        int hash = want.lastIndexOf('#');
        if (hash > 0 && hash < want.length() - 1) {
            String tail = want.substring(hash + 1);
            boolean allDigits = !tail.isEmpty();
            for (int i = 0; i < tail.length(); i++) {
                if (!Character.isDigit(tail.charAt(i))) { allDigits = false; break; }
            }
            // `ImageView|#icon-1` 里的 # 不是序号 —— 后面不是纯数字就不是序号
            if (allDigits) {
                try {
                    nth = Integer.parseInt(tail);
                    base = want.substring(0, hash);
                } catch (Throwable ignored) {
                    base = want;
                }
            }
        }

        int seen = 0;
        for (UiElement e : d.elements) {
            if (!e.ref.equals(base)) continue;
            seen++;
            if (seen == nth) return e;
        }
        return null;
    }

    /**
     * 按文字匹配元素。
     *
     * 与旧的 findCenter 的区别：
     *   · 旧的 loose 匹配是在**整行文本**里找子串，class 名（"TextView"）也算命中 ——
     *     搜 "View" 会命中几乎所有元素；
     *   · 新的匹配只看元素的文字 / 描述 / 资源 id，不看 class。
     *   · 同名时优先挑**可点**的，其次挑面积小的（更像按钮而不是整块容器）。
     */
    public static UiElement findByText(UiDump d, String match) {
        if (d == null || match == null) return null;
        String needle = match.trim().toLowerCase(Locale.ROOT);
        if (needle.isEmpty()) return null;

        UiElement exact = null, exactClickable = null;
        UiElement loose = null, looseClickable = null;

        for (UiElement e : d.elements) {
            String t = e.text.toLowerCase(Locale.ROOT);
            String ds = e.desc.toLowerCase(Locale.ROOT);
            boolean eq = t.equals(needle) || ds.equals(needle);
            boolean has = t.contains(needle) || ds.contains(needle)
                    || (!e.resourceId.isEmpty() && e.resourceId.toLowerCase(Locale.ROOT).contains(needle));
            if (eq) {
                if (exact == null) exact = e;
                if (e.clickable && exactClickable == null) exactClickable = e;
            } else if (has) {
                if (loose == null) loose = e;
                if (e.clickable && looseClickable == null) looseClickable = e;
            }
        }

        if (exactClickable != null) return exactClickable;
        if (exact != null) return exact;
        if (looseClickable != null) return looseClickable;
        return loose;
    }

    /** uiautomator 的 rotation 是 0/1/2/3 个 90°，转成角度给人看。 */
    private static String rotateDeg(String r) {
        switch (r) {
            case "1":
                return "90";
            case "2":
                return "180";
            case "3":
                return "270";
            default:
                return "0";
        }
    }

    /** "[100,200][500,260]" → {100,200,500,260} */
    private static int[] rect(String bounds) {
        java.util.regex.Matcher m = BOUNDS_RE.matcher(bounds == null ? "" : bounds);
        if (!m.find()) return null;
        try {
            return new int[]{
                    Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)),
                    Integer.parseInt(m.group(3)), Integer.parseInt(m.group(4))
            };
        } catch (Throwable t) {
            return null;
        }
    }

    /* ------------------------------------------------------------ 动作 */

    public static boolean tap(Context ctx, float x, float y) throws Exception {
        String out = exec(ctx, "input tap " + (int) x + " " + (int) y);
        return !out.toLowerCase(Locale.ROOT).contains("err");
    }

    public static boolean swipe(Context ctx, float x1, float y1, float x2, float y2, int ms) throws Exception {
        String out = exec(ctx, "input swipe " + (int) x1 + " " + (int) y1 + " "
                + (int) x2 + " " + (int) y2 + " " + Math.max(50, ms));
        return !out.toLowerCase(Locale.ROOT).contains("err");
    }

    /**
     * 输入文字。
     *
     * ============ 中文怎么办（0.25.3 补）============
     *
     * `input text` 只接受 ASCII —— 这是 shell 输入命令的硬限制，不是实现偷懒。
     * 之前遇到中文直接报错，等于「只用低速通道」时中文彻底不可用。
     *
     * 现在改走「写剪贴板 + 发粘贴键」：
     *   1. ClipboardManager.setPrimaryClip —— 写剪贴板不受 Android 10+ 的后台限制
     *      （受限的是"读"，写一直是允许的）
     *   2. input keyevent 279（KEYCODE_PASTE）—— 让当前输入框粘贴
     *
     * 代价是依赖「焦点在输入框」这个前提：焦点不在时粘贴键无效，而且没有回执。
     * 所以结果里会明确说明走的哪条路，并在可能失败时提示先点一下输入框。
     *
     * 顺带一个用户体验上的副作用：Android 13+ 写剪贴板时系统会弹「已复制」提示，
     * 这是系统行为，改不掉。
     */
    public static String setText(Context ctx, String text) throws Exception {
        if (text == null) text = "";
        if (!isAscii(text)) return paste(ctx, text);

        // input text 用空格分词，字面空格要写成 %s
        String esc = text.replace("%", "\\%").replace(" ", "%s");
        exec(ctx, "input text '" + esc.replace("'", "'\\''") + "'");
        return "已输入";
    }

    private static boolean isAscii(String s) {
        for (int i = 0; i < s.length(); i++) {
            if (s.charAt(i) > 127) return false;
        }
        return true;
    }

    /** 非 ASCII 文字：写剪贴板 + 发粘贴键。 */
    private static String paste(Context ctx, String text) throws Exception {
        android.content.ClipboardManager cm = (android.content.ClipboardManager)
                ctx.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
        if (cm == null) {
            throw new Exception("取不到剪贴板服务，无法输入中文。"
                    + "这条通道的中文输入依赖剪贴板 + 粘贴键。");
        }
        cm.setPrimaryClip(android.content.ClipData.newPlainText("dsh", text));
        // 给系统一点时间让剪贴板内容就位，否则粘贴键可能拿到旧内容
        try {
            Thread.sleep(150);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        exec(ctx, "input keyevent 279");
        return "已通过剪贴板粘贴（中文无法用 input text 直接输入）。"
                + "如果没粘上，先点一下输入框让光标就位再试";
    }

    /**
     * 在已 dump 的文本里找匹配控件的中心点。
     *
     * ============ 为什么要拆出来 ============
     *
     * 按文字点击必须**先确认前台应用在白名单里**，再动手点。
     * 如果 `clickText` 内部自己 dump，调用方就拿不到包名，只能盲点 ——
     * 那等于绕过了整个白名单闸门。
     *
     * 所以这里只负责"找"，点击由调用方在校验之后执行。
     *
     * 匹配优先级和高速通道一致：引号内完全相等 > 包含（不区分大小写）。
     */
    public static int[] findCenter(String dumpedText, String match) {
        String needle = match == null ? "" : match.trim().toLowerCase(Locale.ROOT);
        if (needle.isEmpty() || dumpedText == null) return null;

        int[] exact = null;
        int[] loose = null;
        for (String line : dumpedText.split("\n")) {
            if (!line.startsWith("#")) continue;

            // 从行尾往前找最后一个 bounds 形状的匹配：
            // 文字里可能有 "[1,2]" 这种假括号，行尾那个才是真的
            java.util.regex.Matcher m = BOUNDS_RE.matcher(line);
            String bounds = null;
            int boundsStart = -1;
            while (m.find()) {
                bounds = m.group();
                boundsStart = m.start();
            }
            if (bounds == null) continue;

            int[] c = center(bounds);
            if (c == null) continue;

            String hay = line.substring(0, boundsStart).toLowerCase(Locale.ROOT);
            if (hay.contains("\"" + needle + "\"")) {
                if (exact == null) exact = c;
            } else if (hay.contains(needle)) {
                if (loose == null) loose = c;
            }
        }
        return exact != null ? exact : loose;
    }

    /** 全局动作：back / home / recents / notifications / enter / delete / space / lock。 */
    public static String global(Context ctx, String action) throws Exception {
        String a = action == null ? "" : action.trim().toLowerCase(Locale.ROOT);
        int key;
        switch (a) {
            case "back":
                key = 4;
                break;
            case "home":
                key = 3;
                break;
            case "recents":
            case "recent":
                key = 187;
                break;
            case "notifications":
            case "notification":
                key = 83;
                break;
            // 下面三个是「软键盘上的功能键」的替代品。
            // 键盘是独立窗口，dump 看不到、按坐标点也不稳，用按键才是确定性的。
            case "enter":
            case "search":
            case "send":
                key = 66; // KEYCODE_ENTER，输入框里通常就是「搜索 / 发送 / 完成」
                break;
            case "delete":
            case "backspace":
            case "del":
                key = 67; // KEYCODE_DEL
                break;
            case "space":
                key = 62; // KEYCODE_SPACE
                break;
            case "lock":
                key = 26; // KEYCODE_POWER
                break;
            default:
                throw new Exception("不支持的动作：" + action
                        + "（可用 back / home / recents / notifications / enter / delete / space / lock）");
        }
        exec(ctx, "input keyevent " + key);
        return "已执行 " + a;
    }

    /* ------------------------------------------------------------ 小工具 */

    private static String attr(XmlPullParser p, String name) {
        try {
            String v = p.getAttributeValue(null, name);
            return v == null ? "" : v;
        } catch (Throwable t) {
            return "";
        }
    }

    private static boolean notEmpty(String s) {
        return s != null && !s.trim().isEmpty();
    }

    private static String trim(String s) {
        String t = s.replace('\n', ' ').replace('\r', ' ').trim();
        return t.length() > 80 ? t.substring(0, 80) + "…" : t;
    }

    private static String shortClass(String cls) {
        if (cls == null || cls.isEmpty()) return "View";
        int i = cls.lastIndexOf('.');
        return i >= 0 && i + 1 < cls.length() ? cls.substring(i + 1) : cls;
    }

    /** "[100,200][500,260]" → {300, 230} */
    private static int[] center(String bounds) {
        int[] r = rect(bounds);
        if (r == null) return null;
        return new int[]{(r[0] + r[2]) / 2, (r[1] + r[3]) / 2};
    }

    /* ------------------------------------------------------ 坐标系（0.26.1） */

    /**
     * 当前屏幕的宽高（逻辑像素，与应用看到的坐标系一致）。
     *
     * 为什么要问 WindowManager 而不是跑 `wm size`：
     *   - `wm size` 给的是 **自然方向** 的尺寸，横屏时宽高是反的；
     *   - 开启「屏幕分辨率/显示大小」后它给 Physical 和 Override 两组值，
     *     还得自己判断用哪组；
     *   - 多一次 shell 往返（约 100ms），而这里只是算个比例。
     *
     * getRealMetrics 拿到的就是当前 display 实际生效的逻辑尺寸：
     * override 已应用、旋转已应用 —— 正好是 input tap 接受的坐标系。
     */
    public static int[] screenSize(Context ctx) {
        try {
            android.view.WindowManager wm = (android.view.WindowManager)
                    ctx.getSystemService(android.content.Context.WINDOW_SERVICE);
            if (wm == null) return null;
            android.util.DisplayMetrics dm = new android.util.DisplayMetrics();
            wm.getDefaultDisplay().getRealMetrics(dm);
            if (dm.widthPixels <= 0 || dm.heightPixels <= 0) return null;
            return new int[]{dm.widthPixels, dm.heightPixels};
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * 把模型给的坐标收敛到「屏幕像素」。
     *
     * ============ 为什么需要这一步 ============
     *
     * 模型拿到的坐标有两种来源，单位完全不同：
     *
     *   1. ui_dump 的 bounds / 中心点   → 已经是屏幕像素，直接用
     *   2. 用户贴的截图                  → 图片像素，而且要经过两重缩放
     *      （原图 → 长边 1568 的压缩图 → 模型实际看的尺寸），
     *      直接当像素用会整体偏小，越往右下偏得越多
     *
     * 第 2 种情况下模型给的通常是 0~1 的比例（或者它按图算出的像素）。
     * 这里约定：x、y 都落在 (0,1] 区间时按比例理解，乘上屏幕宽高。
     * 这是唯一能自动区分两种意图的办法 —— 一个真实像素坐标不可能两轴都 ≤1。
     *
     * @return {px, py, 是否是比例}
     */
    public static int[] toPixels(Context ctx, double x, double y) {
        int[] s = screenSize(ctx);
        int w = s == null ? 0 : s[0];
        int h = s == null ? 0 : s[1];

        boolean ratio = x > 0 && x <= 1 && y > 0 && y <= 1;
        int px = ratio && w > 0 ? (int) Math.round(x * w) : (int) Math.round(x);
        int py = ratio && h > 0 ? (int) Math.round(y * h) : (int) Math.round(y);

        // 越界钳制：input tap 对界外坐标是静默忽略，用户只会看到"点了没反应"，
        // 那比点偏更难查。钳到边缘至少动作会发生，返回里也会说明。
        if (w > 0) px = Math.max(0, Math.min(w - 1, px));
        if (h > 0) py = Math.max(0, Math.min(h - 1, py));
        return new int[]{px, py, ratio ? 1 : 0};
    }

    /** 供工具返回里附带的一句话坐标系说明。 */
    public static String screenNote(Context ctx) {
        int[] s = screenSize(ctx);
        return s == null ? "" : ("屏幕 " + s[0] + "×" + s[1]);
    }
}
