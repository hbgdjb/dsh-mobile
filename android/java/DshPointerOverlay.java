package ai.deepseek.dsh.mobile;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Locale;

/**
 * 落点可视化 —— AI 点哪儿，屏幕上就画在哪儿。
 *
 * ============ 它解决的是「说不清」的问题 ============
 *
 * 用户反馈「AI 点偏了」时，双方其实都没有证据：模型只知道自己传了 (630, 1330)，
 * 用户只看到「点了没反应」或「点错了」。中间到底偏了多少、偏在哪个方向，
 * 全靠猜。
 *
 * 这个类把那一下画出来：圆环涟漪标落点，连线标滑动方向，1.2 秒后消失。
 * 偏没偏、偏多少，一眼就能看出来。
 *
 * ============ 为什么是一个 View，而不是一个 Service ============
 *
 * 这个功能的生命只有 1.2 秒。用 Service 养一个常驻窗口，等于用「分钟级」的
 * 生命周期去承载「秒级」的展示，多出来的全是重复启动、被杀重建、通知栏图标
 * 这些与需求无关的成本。WindowManager.addView 只需要一个 Context 和一个 Looper。
 *
 * ============ 为什么窗口是「用到才挂，画完就摘」 ============
 *
 * 常驻的全屏浮窗会让银行、政务类应用在启动时检测到「正在其他应用上层显示」，
 * 轻则弹提示，重则直接退出。这里只在有标记存活时挂窗口，空闲立刻摘掉 ——
 * 曝光时间被压到 1.3 秒以内。
 */
public final class DshPointerOverlay extends View {

    /** 开关文件名。主进程写、:device 读，两边共用这个常量，避免字面量漂移。 */
    public static final String CONFIG_FILE = "ai-pointer.txt";

    /** 一条标记从出现到完全消失的时长。 */
    private static final long LIFE_MS = 1200L;

    /** addView 失败后的冷却。模型连点 20 下时，不要往诊断日志里灌 20 条同样的异常。 */
    private static final long FAIL_COOL_MS = 30_000L;

    /** 连点上限。超出丢最旧的，既不会叠成一团，也不会让 list 无限长。 */
    private static final int MAX_MARKS = 8;

    /**
     * 窗口不透明度。
     *
     * Android 12 起，穿过「不可触摸且不透明度 > 0.8」的浮窗的触摸会被系统丢弃。
     * 我们是全屏 + NOT_TOUCHABLE，1.0 会让每次 input tap 都被吞掉。
     * 0.75 给不同 ROM 的阈值留余量；实在遇到点击不生效，可以先降到 0.5 试。
     */
    private static final float WINDOW_ALPHA = 0.75f;

    private static final int COLOR_ACCENT = 0xFF5B8CFF;
    private static final int COLOR_CORE = 0xFFFFFFFF;
    private static final int COLOR_HALO = 0xFF000000;

    /** 箭头的两个翼角（弧度）。静态常量，避免每帧算。 */
    private static final float[] ARROW_ANGLES = {-0.42f, 0.42f};

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    /** 只在主线程读写。整个 :device 进程只有一个使用者。 */
    private static DshPointerOverlay instance;

    /* ------------------------------------------------------------ 对外入口 */

    /**
     * 标一个点击落点。
     *
     * 任意线程可调，**绝不抛异常** —— 画不出来是小事，把点击流程搞挂是大事。
     */
    public static void markTap(Context ctx, int x, int y) {
        post(ctx, true, x, y, x, y);
    }

    /** 标一次滑动：起点圆、终点环、连线带箭头。 */
    public static void markSwipe(Context ctx, int x1, int y1, int x2, int y2) {
        post(ctx, false, x1, y1, x2, y2);
    }

    /**
     * 开关是否打开。
     *
     * ============ 为什么「读不到就算开」 ============
     *
     * 写文件是「截断再写」，极端并发下可能读到空串。如果把空串当关闭，
     * 用户会看到「开关明明开着，屏幕上却不画」—— 这种不一致比多画一下难查得多。
     * 所以只认明确的 off / 0 / false，其余（不存在、空串、读失败）一律按开。
     */
    public static boolean enabled(Context ctx) {
        try {
            File f = new File(ctx.getApplicationContext().getFilesDir(), CONFIG_FILE);
            if (!f.exists()) return true;
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(
                    new FileInputStream(f), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            String v = sb.toString().trim().toLowerCase(Locale.ROOT);
            return !("off".equals(v) || "0".equals(v) || "false".equals(v));
        } catch (Throwable t) {
            return true;
        }
    }

    private static void post(Context ctx, boolean tap, int x1, int y1, int x2, int y2) {
        try {
            if (ctx == null) return;
            final Context app = ctx.getApplicationContext();
            // 读文件放在调用方线程（MCP 工作线程），不占主线程
            if (!enabled(app)) return;
            MAIN.post(() -> {
                try {
                    DshPointerOverlay v = obtain(app);
                    if (v != null) v.addMark(tap, x1, y1, x2, y2);
                } catch (Throwable ignored) {
                }
            });
        } catch (Throwable ignored) {
        }
    }

    /* ------------------------------------------------------------ 内部状态 */

    private static final class Mark {
        final boolean tap;
        final float x1, y1, x2, y2;
        final long t0;

        Mark(boolean tap, float x1, float y1, float x2, float y2, long t0) {
            this.tap = tap;
            this.x1 = x1;
            this.y1 = y1;
            this.x2 = x2;
            this.y2 = y2;
            this.t0 = t0;
        }
    }

    private final Context appCtx;
    private final WindowManager wm;
    private final WindowManager.LayoutParams lp;
    private final ArrayList<Mark> marks = new ArrayList<>();
    private final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final int[] loc = new int[2];
    private final float density;
    private final Runnable detachTask = this::detachIfIdle;

    /** 主线程独占：View 是否已经 addView 成功。 */
    private boolean added;
    private long failUntil;

    private static DshPointerOverlay obtain(Context app) {
        if (instance != null) return instance;
        WindowManager wm = (WindowManager) app.getSystemService(Context.WINDOW_SERVICE);
        if (wm == null) return null;
        instance = new DshPointerOverlay(app, wm);
        return instance;
    }

    private DshPointerOverlay(Context app, WindowManager wm) {
        super(app);
        this.appCtx = app;
        this.wm = wm;
        this.density = getResources().getDisplayMetrics().density;
        this.lp = buildParams();
        stroke.setStyle(Paint.Style.STROKE);
        stroke.setStrokeCap(Paint.Cap.ROUND);
        fill.setStyle(Paint.Style.FILL);
    }

    /* ------------------------------------------------------------ 窗口参数 */

    /**
     * 全屏透明、不接收触摸的浮窗。
     *
     * 每一行 flag 都对应一个具体的坑，见下面注释 —— 这里没有「顺手加的」。
     */
    private WindowManager.LayoutParams buildParams() {
        // API 26 才有 TYPE_APPLICATION_OVERLAY。minSdk 是 24，
        // 24/25 上只能用 TYPE_PHONE，否则 addView 直接抛异常。
        int type = Build.VERSION.SDK_INT >= 26
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;

        int flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                // 必须：否则这个全屏窗口会吃掉 input tap，目标应用一个事件都收不到 ——
                // 等于「开了落点显示，Agent 就点不动任何东西」。
                | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                // 关键：让窗口 frame 对齐物理屏幕，而不是「状态栏下方的内容区」。
                // 少了它，所有 y 会整体偏一个状态栏高度，而且底部会裁掉同样高度。
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS;

        WindowManager.LayoutParams p = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                type, flags, PixelFormat.TRANSLUCENT);

        p.gravity = Gravity.TOP | Gravity.START;
        p.x = 0;
        p.y = 0;

        // ============ alpha 为什么不是 1.0 ============
        //
        // Android 12（API 31）起，系统会把「穿过不可触摸且不透明度 > 0.8 的浮窗」
        // 的触摸判为 untrusted 并丢弃。我们是全屏 + NOT_TOUCHABLE，
        // 如果 alpha 保持 1.0，开了这个功能之后**每一次 input tap 都会被吞掉**，
        // 而 `input tap` 本身还返回成功 —— 这是最难查的一类故障。
        p.alpha = Build.VERSION.SDK_INT >= 31 ? WINDOW_ALPHA : 1.0f;

        if (Build.VERSION.SDK_INT >= 30) {
            // 明确声明「不需要为任何系统栏让位」。和 FLAG_LAYOUT_IN_SCREEN 同义，
            // 但 11+ 的 inset 分发以这个方法为准，两个都写最稳。
            p.setFitInsetsTypes(0);
            p.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
        } else if (Build.VERSION.SDK_INT >= 28) {
            // 28/29 没有 ALWAYS。不加这句，刘海机型竖屏下整个窗口会从刘海下方开始，
            // 于是所有 y 又偏一个刘海高度。
            p.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }

        // 排查时 `dumpsys window | grep dsh-pointer` 能一眼认出这个窗口
        p.setTitle("dsh-pointer");
        return p;
    }

    /* ------------------------------------------------------------ 生命周期 */

    private void addMark(boolean tap, float x1, float y1, float x2, float y2) {
        if (!ensureAdded()) return;
        long now = SystemClock.uptimeMillis();
        if (marks.size() >= MAX_MARKS) marks.remove(0);
        marks.add(new Mark(tap, x1, y1, x2, y2, now));
        scheduleDetach();
        invalidate();
    }

    /**
     * 保证窗口已挂上。
     *
     * 三重判断不是冗余：
     *   added           —— 正常路径
     *   getParent()     —— 标志位丢了时（系统摘过窗）用视图自身状态校正
     *   canDrawOverlays —— 没授权时提前放弃，别每次都撞一次异常
     *
     * 关键点：`added = true` 必须在 addView 返回后**立刻**置位。
     * addView 返回到真正 attach 之间隔着一个 traversal，那个间隙正是
     * 连续点击最容易踩中「View already has a parent」的时候。
     */
    private boolean ensureAdded() {
        if (added) return true;
        if (getParent() != null) {
            added = true;
            return true;
        }
        long now = SystemClock.uptimeMillis();
        if (now < failUntil) return false;

        try {
            if (!Settings.canDrawOverlays(appCtx)) {
                failUntil = now + FAIL_COOL_MS;
                DshA11yDiagnostics.log(appCtx,
                        "pointer：没有悬浮窗权限，落点画不出来（点击本身不受影响）");
                return false;
            }
            wm.addView(this, lp);
            added = true;
            return true;
        } catch (Throwable t) {
            added = false;
            failUntil = now + FAIL_COOL_MS;
            DshA11yDiagnostics.log(appCtx, "pointer：浮窗添加失败 "
                    + t.getClass().getSimpleName() + " " + t.getMessage());
            return false;
        }
    }

    private void scheduleDetach() {
        MAIN.removeCallbacks(detachTask);
        MAIN.postDelayed(detachTask, LIFE_MS + 120);
    }

    /**
     * 摘窗口。
     *
     * ============ 为什么要一条独立的看门狗，而不是靠绘制回调 ============
     *
     * 熄屏、窗口被系统判为不可见、帧循环被跳过 —— 这些情况下 onDraw 可能一次都不跑。
     * 如果「画完就摘」的逻辑挂在 onDraw 里，窗口就会一直挂着，
     * 用户下次打开银行 App 就会被提示「正在其他应用上层显示」。
     *
     * 所以摘窗永远由 Handler 任务执行，和绘制解耦，并且**自续期**：
     * 还有活着的标记就再等一会儿，直到全部过期。
     *
     * 用 removeViewImmediate 而不是 removeView：后者只是往队列里投一个 die 消息，
     * 此时 WMS 侧窗口还在，紧接着的 addView 可能撞上「已经添加过」。
     */
    private void detachIfIdle() {
        long now = SystemClock.uptimeMillis();
        long left = 0;
        for (Mark m : marks) left = Math.max(left, LIFE_MS - (now - m.t0));
        if (left > 0) {
            MAIN.postDelayed(detachTask, left + 80);
            return;
        }

        if (!added && getParent() == null) return;
        added = false;
        try {
            wm.removeViewImmediate(this);
        } catch (Throwable ignored) {
        }
    }

    /**
     * 窗口被摘下时（可能是我们自己摘的，也可能是系统摘的：权限被回收、显示切换）
     * 把状态清干净。不清的话下次点击会以为窗口还挂着，结果什么也画不出来。
     */
    @Override
    protected void onDetachedFromWindow() {
        super.onDetachedFromWindow();
        added = false;
        marks.clear();
        MAIN.removeCallbacks(detachTask);
    }

    /**
     * 尺寸不一致说明窗口被 inset 了而不是被偏移 —— 平移校准救不了底部那一截。
     * 这时**不做缩放**：缩放会让坐标和 input tap 的真实像素彻底脱钩，
     * 比画不出来更糟。只记一条日志，留给排查。
     */
    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        int[] s = DshShizuku.screenSize(appCtx);
        if (s != null && (Math.abs(w - s[0]) > 4 || Math.abs(h - s[1]) > 4)) {
            DshA11yDiagnostics.log(appCtx, "pointer：浮窗 " + w + "×" + h
                    + " 与屏幕 " + s[0] + "×" + s[1] + " 不一致，落点可能偏移");
        }
    }

    /* ------------------------------------------------------------ 绘制 */

    @Override
    protected void onDraw(Canvas c) {
        final long now = SystemClock.uptimeMillis();

        // 每帧校准一次。flag 只是「请求」，最终 frame 由 WMS 决定，
        // 各家 ROM 的 inset 策略、隐藏刘海开关都会改变结果。
        // getLocationOnScreen 读的是 WMS 回填的真实位置，成本只有几次加法。
        getLocationOnScreen(loc);
        c.translate(-loc[0], -loc[1]);

        boolean alive = false;
        for (int i = marks.size() - 1; i >= 0; i--) {
            Mark m = marks.get(i);
            long t = now - m.t0;
            if (t >= LIFE_MS) {
                // 这里只丢数据，绝不在这里 removeView —— 不能在绘制回调里改窗口树
                marks.remove(i);
                continue;
            }
            alive = true;
            if (m.tap) drawTap(c, m, t);
            else drawSwipe(c, m, t);
        }
        if (alive) postInvalidateOnAnimation();
    }

    /** 一次点击：中心实点 + 两圈错峰涟漪 + 一个定位环。 */
    private void drawTap(Canvas c, Mark m, long t) {
        final float x = m.x1, y = m.y1;

        // 中心实点：白芯 + 亮色边。任何底色上都认得出「这里被点了一下」
        float ca = t < 160 ? 1f : clamp(1f - (t - 160) / 460f);
        if (ca > 0) {
            fill.setColor(COLOR_CORE);
            fill.setAlpha((int) (255 * ca));
            c.drawCircle(x, y, dp(4.5f), fill);

            fill.setColor(COLOR_ACCENT);
            fill.setAlpha((int) (210 * ca));
            c.drawCircle(x, y, dp(7f), fill);
        }

        ripple(c, x, y, t, 0f, dp(7), dp(30), 700f, 235);
        // 第二圈错开 120ms 才像水波；同时扩散就是单个光圈，看不出「一下」
        ripple(c, x, y, t, 120f, dp(6), dp(22), 620f, 150);

        float ra = t < 700 ? 0.85f : clamp(0.85f * (1f - (t - 700) / 500f));
        if (ra > 0) {
            stroke.setColor(COLOR_HALO);
            stroke.setStrokeWidth(dp(4f));
            stroke.setAlpha((int) (110 * ra));
            c.drawCircle(x, y, dp(15), stroke);

            stroke.setColor(COLOR_ACCENT);
            stroke.setStrokeWidth(dp(1.8f));
            stroke.setAlpha((int) (255 * ra));
            c.drawCircle(x, y, dp(15), stroke);
        }
    }

    /** 一圈扩散涟漪。delay 用来做第二圈的错峰。 */
    private void ripple(Canvas c, float x, float y, long t,
                        float delay, float r0, float r1, float dur, int a0) {
        float u = (t - delay) / dur;
        if (u <= 0f || u >= 1f) return;

        float e = 1f - (1f - u) * (1f - u) * (1f - u); // easeOut：起步快、收尾慢，像水波
        float r = r0 + (r1 - r0) * e;
        int a = (int) (a0 * (1f - u) * (1f - u));      // 末尾加速变淡，避免硬消失

        // 先铺一条更宽的暗色垫底，再压亮色 —— 浅色背景上才看得见。
        // 不用 setShadowLayer：非文字阴影要开软件层，全屏窗口代价太大。
        stroke.setColor(COLOR_HALO);
        stroke.setStrokeWidth(dp(4.5f));
        stroke.setAlpha(a * 2 / 3);
        c.drawCircle(x, y, r, stroke);

        stroke.setColor(COLOR_ACCENT);
        stroke.setStrokeWidth(dp(2.2f));
        stroke.setAlpha(a);
        c.drawCircle(x, y, r, stroke);
    }

    /** 一次滑动：线从起点长到终点，然后终点环 + 箭头。 */
    private void drawSwipe(Canvas c, Mark m, long t) {
        float u = Math.min(1f, t / 180f);
        float ex = m.x1 + (m.x2 - m.x1) * u;
        float ey = m.y1 + (m.y2 - m.y1) * u;
        float a = t < 700 ? 1f : clamp(1f - (t - 700) / 500f);

        stroke.setColor(COLOR_HALO);
        stroke.setStrokeWidth(dp(5.5f));
        stroke.setAlpha((int) (130 * a));
        c.drawLine(m.x1, m.y1, ex, ey, stroke);

        stroke.setColor(COLOR_ACCENT);
        stroke.setStrokeWidth(dp(2.8f));
        stroke.setAlpha((int) (255 * a));
        c.drawLine(m.x1, m.y1, ex, ey, stroke);

        // 起点：实心小圆
        fill.setColor(COLOR_ACCENT);
        fill.setAlpha((int) (255 * a));
        c.drawCircle(m.x1, m.y1, dp(4.5f), fill);

        // 终点：等线走完再出现，方向感更清楚
        float ea = clamp((t - 180f) / 160f) * a;
        if (ea <= 0) return;

        stroke.setColor(COLOR_ACCENT);
        stroke.setStrokeWidth(dp(1.8f));
        stroke.setAlpha((int) (230 * ea));
        c.drawCircle(m.x2, m.y2, dp(8), stroke);

        // 线太短就不画箭头，否则糊成一团
        float len = (float) Math.hypot(m.x2 - m.x1, m.y2 - m.y1);
        if (len <= dp(28)) return;

        double ang = Math.atan2(m.y2 - m.y1, m.x2 - m.x1);
        for (float d : ARROW_ANGLES) {
            c.drawLine(m.x2, m.y2,
                    m.x2 - dp(10) * (float) Math.cos(ang + d),
                    m.y2 - dp(10) * (float) Math.sin(ang + d), stroke);
        }
    }

    /* ------------------------------------------------------------ 小工具 */

    private float dp(float v) {
        return v * density;
    }

    private static float clamp(float v) {
        return v < 0 ? 0 : (v > 1 ? 1 : v);
    }
}
