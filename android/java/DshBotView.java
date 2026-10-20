package ai.deepseek.dsh.mobile;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;
import android.util.AttributeSet;
import android.view.Choreographer;
import android.view.View;

import java.util.Random;

/**
 * DSH 小球 — 移植自 agent-hud-open（Apache-2.0）的 DeepSeek Bot。
 * 与 scripts/dsh-ball.js（Web 端）同一套参数、同一条状态机、同一条时间曲线：
 * 蓝球 + 白肚皮 + 三只鳍 + 可交叉的眼睛，按 Agent 状态摆姿态、做动作。
 *
 * 数据流：WebView 侧 hudSnapshot() 推送 { look, event, badge } →
 *         DshHudState.json → DshHudService.fillBody() → setLook/play/setBadge。
 */
public class DshBotView extends View implements Choreographer.FrameCallback {

    /* ---------------- DeepSeek 小球参数（BotSpec.swift 逐值移植） ----------------
     * 本地改动：① 按需求去掉三只鳍（FINS 置空，只留光球）；② radius 0.36 → 0.5，
     * 球撑满 mark 方框（悬浮窗里更大更醒目）。 */
    private static final float R = 0.5f;           // radius
    private static final float CENTER_X = 0.5f, CENTER_Y = 0.5f;
    private static final float FACE_X = 0f, FACE_Y = -0.14f;
    private static final float EYE_HEIGHT = 0.62f, EYE_WIDTH = 0.25f, EYE_SPREAD = 0.34f;
    private static final boolean CROSSES_EYES = true;

    private static final int BODY_TOP = 0xFF6D86FF;
    private static final int BODY_MID = 0xFF4D6BFE;
    private static final int BODY_BOTTOM = 0xFF3F5AE6;
    private static final int INK = 0xFF0D0D10;
    private static final int FIN_COLOR = 0xFF3F5AE6;
    private static final int BELLY_COLOR = 0xFFC9D4FF;

    /** 鱼鳍：左右为可抬起的「手」，背鳍向后扫。 */
    private static final class Fin {
        float rootX, rootY, angle, length, base, tip, sweep;
        int hand;
        Fin(float rx, float ry, float a, float len, float b, float t, float s, int h) {
            rootX = rx; rootY = ry; angle = a; length = len; base = b; tip = t; sweep = s; hand = h;
        }
    }

    /** 鱼鳍：按需求已去掉（原左右手鳍 + 背鳍，保留数据结构以便随时恢复）。 */
    private static final Fin[] FINS = {};

    /* ---------------- 动作曲线（BotMoves.swift 移植） ---------------- */
    private static final float BEAT = 0.125f, BURST = 3f, CYCLE = 4.5f, PADDLE = 14f;
    private static final float PONDER_GAZE_X = 0.4f, PONDER_GAZE_Y = -0.7f;
    private static final float PONDER_TILT = 5f, PONDER = 2.5f, FULL_WAIT = 8f;
    private static final float FIRST_MOVE = 1.2f, HOP_SECONDS = 0.3f;
    private static final float FIN_WAVE_SECONDS = 0.9f, CHEER_START = 0.3f, CHEER_SECONDS = 1.2f;

    private static final float HOP_ATTENTION = 0.45f;
    private static final float MORPH_SECONDS = 0.5f;
    private static final float BLEND_SECONDS = 0.3f;
    private static final float LONGEST_STEP = 1f / 6f;
    private static final float PACE_LIVELY = 1f / 24f;
    private static final float PACE_SLACK = 0.004f;

    /* ---------------- 头顶符号（BotSigns.swift 逐行移植） ---------------- */
    private static final String[][] SIGN_ROWS = {
            null,                       // 0 占位
            {"..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."}, // exclamation
            {".###.", "#...#", "....#", "..##.", "..#..", ".....", "..#.."}, // question
            {".....", "#####", ".....", "#####", ".....", "#####", "....."}, // lines
            {".....", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "....."}, // cross
            {".....", "#####", ".#.#.", "..#..", ".###.", "#####", "....."}, // hourglass
            {".....", ".....", ".....", ".....", ".....", ".....", "#.#.#"}, // ellipsis
            {".....", ".....", "#####", "...#.", "..#..", ".#...", "#####"}, // z
    };
    private static final int SIGN_EXCLAMATION = 1, SIGN_QUESTION = 2, SIGN_LINES = 3,
            SIGN_CROSS = 4, SIGN_HOURGLASS = 5, SIGN_ELLIPSIS = 6, SIGN_Z = 7;
    private static final int SIGN_COLS = 5, SIGN_ROWS_N = 7;
    private static final float SIGN_FAINT = 0.35f;

    /* ---------------- 小工具 ---------------- */
    private static float clamp(float v, float lo, float hi) {
        return v < lo ? lo : v > hi ? hi : v;
    }

    private static float easeInOut(float x) {
        return x < 0.5f ? 2 * x * x : 1 - (float) Math.pow(-2 * x + 2, 2) / 2;
    }

    private static float easeOut(float x) {
        return 1 - (float) Math.pow(1 - x, 3);
    }

    private static float easeOutBack(float x) {
        float c = 1.70158f;
        return 1 + (c + 1) * (float) Math.pow(x - 1, 3) + c * (float) Math.pow(x - 1, 2);
    }

    /** 与原作相同的 seeded 随机数（SplitMix64），小动作可复现。 */
    private static final class SplitMix {
        private long state;

        SplitMix(long seed) {
            state = (seed * 0x9E3779B97F4A7C15L);
            if (state == 0) state = 0x123456789ABCDEFL;
        }

        private long next() {
            state += 0x9E3779B97F4A7C15L;
            long z = state;
            z = (z ^ (z >>> 30)) * 0xBF58476D1CE4E5B9L;
            z = (z ^ (z >>> 27)) * 0x94D049BB133111EBL;
            return z ^ (z >>> 31);
        }

        float unit() {
            return (float) ((next() >>> 11) / 9007199254740992.0);
        }
    }

    /* ---------------- 状态机（BotMotion.swift 移植） ---------------- */
    private static final class Pose {
        float x, y, rotation, scaleX = 1, scaleY = 1, footing;

        Pose copy() {
            Pose p = new Pose();
            p.x = x; p.y = y; p.rotation = rotation; p.scaleX = scaleX; p.scaleY = scaleY; p.footing = footing;
            return p;
        }
    }

    private static Pose zeroPose() {
        return new Pose();
    }

    private static Pose mixPose(Pose a, Pose b, float share) {
        Pose p = new Pose();
        p.x = a.x + (b.x - a.x) * share;
        p.y = a.y + (b.y - a.y) * share;
        p.rotation = a.rotation + (b.rotation - a.rotation) * share;
        p.scaleX = a.scaleX + (b.scaleX - a.scaleX) * share;
        p.scaleY = a.scaleY + (b.scaleY - a.scaleY) * share;
        p.footing = a.footing + (b.footing - a.footing) * share;
        return p;
    }

    private static final class Act {
        String kind;
        float start, length, side;
        float gazeX, gazeY;
    }

    private static final class Ev {
        String kind;
        float start;
    }

    private static final class MoveAt {
        int index;
        Float start; // null 表示还没到第一次
        float next;
    }

    private static boolean isAttention(String l) {
        return "permission".equals(l) || "question".equals(l) || "plan".equals(l);
    }

    private static boolean isWorking(String l) {
        return "compacting".equals(l) || "thinking".equals(l) || "tool".equals(l) || "plain".equals(l);
    }

    private static boolean isCalm(String l) {
        return "noNews".equals(l) || "idle".equals(l) || "asleep".equals(l);
    }

    private static boolean staysInPlace(String l) {
        return isWorking(l) || isCalm(l);
    }

    private static float moveLength(String look) {
        if ("question".equals(look)) return 0.4f;
        if ("plan".equals(look)) return 0.6f;
        return 0.55f;
    }

    private static MoveAt moveAt(float age) {
        float first = FIRST_MOVE, often = 2.6f, rarely = 8f;
        MoveAt m = new MoveAt();
        if (age < first) {
            m.index = -1; m.start = null; m.next = first;
            return m;
        }
        int frequent = (int) Math.ceil((120 - first) / often);
        float late = first + frequent * often;
        if (age < late - 1e-9f) {
            int index = (int) Math.floor((age - first) / often + 1e-9f);
            m.index = index; m.start = first + index * often; m.next = first + (index + 1) * often;
            return m;
        }
        int index = (int) Math.floor((age - late) / rarely + 1e-9f);
        m.index = frequent + index; m.start = late + index * rarely; m.next = late + (index + 1) * rarely;
        return m;
    }

    private static float knock(float t) {
        if (t < 0 || t >= 0.55f) return 0;
        float x = t / 0.55f;
        return 8 * (float) Math.sin(2 * Math.PI * 2.5 * x) * (1 - x);
    }

    private static float questionTilt(float age) {
        MoveAt move = moveAt(age);
        if (move.start == null) return 0;
        int side = move.index % 2 == 0 ? 1 : -1;
        float from = move.index == 0 ? 0 : -12 * side;
        float x = clamp((age - move.start) / moveLength("question"), 0, 1);
        return from + (12 * side - from) * easeInOut(x);
    }

    private static float nod(float t) {
        float len = moveLength("plan");
        if (t < 0 || t >= len) return 0;
        float half = t / (len / 2);
        return 0.03f * (float) Math.sin(Math.PI * (half - (float) Math.floor(half)));
    }

    private static float hop(float t) {
        if (t < 0 || t >= HOP_SECONDS) return 0;
        float x = t / HOP_SECONDS;
        return -0.06f * 4 * x * (1 - x);
    }

    private static float shake(float t) {
        if (t < 0 || t >= 0.5f) return 0;
        return 0.05f * (float) Math.sin(2 * Math.PI * 6 * t) * (1 - t / 0.5f);
    }

    private static float sag(float t) {
        if (t < 0.5f) return 0;
        if (t < 0.75f) return easeInOut((t - 0.5f) / 0.25f);
        if (t < 1.2f) return 1;
        if (t < 1.5f) return 1 - easeInOut((t - 1.2f) / 0.3f);
        return 0;
    }

    private static final class Sigh {
        float scaleX, scaleY, open;
    }

    private static Sigh sigh(float t) {
        Sigh s = new Sigh();
        float u = Math.max(0, t) / 1.2f;
        if (u < 0.4f) {
            float k = easeInOut(u / 0.4f);
            s.scaleX = 1 - 0.04f * k; s.scaleY = 1 + 0.07f * k; s.open = 1 - 0.7f * k;
        } else if (u < 0.7f) {
            float k = easeInOut((u - 0.4f) / 0.3f);
            s.scaleX = 0.96f + 0.1f * k; s.scaleY = 1.07f - 0.15f * k; s.open = 0.3f + 0.2f * k;
        } else {
            float k = easeInOut(Math.min(1, (u - 0.7f) / 0.3f));
            s.scaleX = 1.06f - 0.06f * k; s.scaleY = 0.92f + 0.08f * k; s.open = 0.5f + 0.5f * k;
        }
        return s;
    }

    private static float finFlap(float t) {
        if (t < 0 || t >= HOP_SECONDS) return 0;
        return 32 * (float) Math.sin(Math.PI * t / HOP_SECONDS);
    }

    private static float finWave(float t) {
        if (t < 0 || t >= FIN_WAVE_SECONDS) return 0;
        float rise = 0.18f;
        float up = easeInOut(Math.min(1, t / rise)) * easeInOut(Math.min(1, (FIN_WAVE_SECONDS - t) / rise));
        return up * (34 + 12 * (float) Math.sin(2 * Math.PI * (t - rise) / 0.27));
    }

    private static float cheer(float age) {
        float t = age - CHEER_START;
        if (t < 0 || t >= CHEER_SECONDS) return 0;
        return 30 * Math.abs((float) Math.sin(Math.PI * t / (CHEER_SECONDS / 3)));
    }

    private static boolean inBurst(float t) {
        return Math.max(0, t) % CYCLE < BURST - 1e-6f;
    }

    private static float bobAt(float t) {
        boolean odd = (long) Math.floor(Math.max(0, t) / BEAT + 1e-6f) % 2 == 1;
        return inBurst(t) && odd ? 0.04f : 0;
    }

    private static int ponderSide(float now) {
        return (long) Math.floor(now / PONDER + 1e-6f) % 2 == 0 ? 1 : -1;
    }

    private static int signRank(int sign) {
        return sign; // rawValue 即优先级
    }

    private static int signShown(int one, int other) {
        if (one == 0) return other;
        if (other == 0) return one;
        return signRank(one) <= signRank(other) ? one : other;
    }

    /* ---------------- 球的状态 ---------------- */
    private final SplitMix random = new SplitMix((long) (Math.random() * 4294967296.0));
    private final Random plainRandom = new Random();

    private String look = "idle";
    private float since = -10f;
    private float morph = 0f;
    private float last = Float.NaN;
    private final float[] face = {1, 0, 0, 1, 0, 0, 0}; // open, look, lookY, wide, happy, lean, crossed
    private final Pose pose = zeroPose();
    private Pose leaving;
    private final float[] flap = {0, 0};
    private int sign = 0;
    private int lit = 0;
    private Act act;
    private float nextAct = 0f;
    private final float[] blinks = {-1, -1};
    private float nextBlink = 2f;
    private boolean blinksOn = true;
    private float greeting = -1f;
    private int greetSide = 1;
    private Ev pending;
    private Ev event;
    private float beatsFrom = 0f;
    private int heldSide = 1;
    private String badge = null;

    private static final float ARRIVES_AFTER = 0.35f;
    private static final float PERIOD = 3f;
    private boolean staysBot = true; // 悬浮球常驻：不退回 logo

    /* ---------------- 绘制资源 ---------------- */
    private final Paint bodyPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint finPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint bellyPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint inkPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint inkStroke = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint logoPaint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
    private final Paint signEdge = new Paint();
    private final Paint signEdgeFaint = new Paint();
    private final Paint signInk = new Paint();
    private final Paint signDim = new Paint();
    private final Path outlinePath = new Path();
    private final Path finPath = new Path();
    private final Path bellyPath = new Path();
    private final Path eyePath = new Path();
    private final android.graphics.RectF rectF = new android.graphics.RectF();
    private final android.graphics.RectF logoDst = new android.graphics.RectF(0, 0, 1, 1);

    private Bitmap logo;
    private float[] logoReach;
    private boolean running = false;

    private static final int SIDE_DP = 30;      // mark 边长（CSS 像素的对应物）
    private float sidePx;                        // mark 边长（设备像素）
    private float density = 3f;

    public DshBotView(Context ctx) {
        super(ctx);
        init();
    }

    public DshBotView(Context ctx, AttributeSet attrs) {
        super(ctx, attrs);
        init();
    }

    private void init() {
        density = getResources().getDisplayMetrics().density;
        sidePx = SIDE_DP * density;
        // 软件层：轮廓裁剪的边缘也要抗锯齿（球很小，代价可忽略）
        setLayerType(LAYER_TYPE_SOFTWARE, null);

        finPaint.setStyle(Paint.Style.FILL);
        finPaint.setColor(FIN_COLOR);
        bellyPaint.setStyle(Paint.Style.FILL);
        bellyPaint.setColor(BELLY_COLOR);
        bodyPaint.setStyle(Paint.Style.FILL);
        bodyPaint.setShader(new LinearGradient(
                CENTER_X, CENTER_Y - R, CENTER_X, CENTER_Y + R,
                new int[]{BODY_TOP, BODY_MID, BODY_BOTTOM},
                new float[]{0f, 0.55f, 1f}, Shader.TileMode.CLAMP));
        inkPaint.setStyle(Paint.Style.FILL);
        inkPaint.setColor(INK);
        inkStroke.setStyle(Paint.Style.STROKE);
        inkStroke.setStrokeCap(Paint.Cap.ROUND);
        inkStroke.setColor(INK);

        signEdge.setColor(0x990D0D10);       // SIGN_EDGE（alpha 0.6）
        signEdgeFaint.setColor(0x360D0D10);  // SIGN_EDGE_FAINT（alpha 0.21）
        signInk.setColor(0xFFFFFFFF);
        signDim.setColor(0x59FFFFFF);        // SIGN_FAINT 0.35
    }

    /** 鲸鱼 logo：morph 化身的轮廓来源；null 时直接以圆身登场。 */
    public void setLogo(Bitmap bmp) {
        logo = bmp;
        logoReach = bmp == null ? null : sampleLogoReach(bmp);
    }

    @Override
    protected void onMeasure(int widthSpec, int heightSpec) {
        int px = Math.round(sidePx * 1.6f);
        setMeasuredDimension(px, px);
    }

    /* ---------------- 对外 API ---------------- */

    /** 状态：idle / thinking / tool / plain / done / permission / question / plan / asleep */
    public void setLook(String next) {
        if (next == null || next.equals(look)) return;
        float now = now();
        look = next;
        leaving = pose.copy();
        since = now + (staysBot && morph == 0 ? Math.max(0, ARRIVES_AFTER) : 0);
        beatsFrom = (float) Math.ceil((since - PACE_SLACK) / BEAT) * BEAT;
        if (isWorking(look)) nextAct = now + 0.9f + random.unit() * 1.2f;
    }

    /** 一次性事件：start / failed / limitHit */
    public void play(String kind) {
        if (kind == null || kind.isEmpty()) return;
        pending = new Ev();
        pending.kind = kind;
        pending.start = now();
    }

    /** 头顶徽标：failed（×）/ limited（⧗），null 清除。 */
    public void setBadge(String kind) {
        badge = kind;
    }

    /** 点一下：打招呼。 */
    public void greet() {
        greeting = now();
        greetSide = 1;
    }

    public void start() {
        if (running) return;
        running = true;
        Choreographer.getInstance().postFrameCallback(this);
    }

    public void stop() {
        running = false;
        Choreographer.getInstance().removeFrameCallback(this);
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        start();
    }

    @Override
    protected void onDetachedFromWindow() {
        stop();
        super.onDetachedFromWindow();
    }

    private static float now() {
        return (float) (System.nanoTime() / 1e9);
    }

    @Override
    public void doFrame(long frameTimeNanos) {
        if (!running) return;
        step(now());
        invalidate();
        Choreographer.getInstance().postFrameCallback(this);
    }

    /* ---------------- 状态机（BotMotion.step 移植） ---------------- */

    private void step(float t) {
        float now = onFrame(t);
        // 首次起步：先当 0.35s 鲸鱼，再化身（原作 arrivesAfter）
        if (Float.isNaN(last) && staysBot && morph == 0) since = now + ARRIVES_AFTER;
        float gap = Math.max(0, now - (Float.isNaN(last) ? now : last));
        float dt = gap > 2 * LONGEST_STEP ? 0 : Math.min(LONGEST_STEP, gap);
        last = now;
        float age = now - since;

        if (pending != null && now - pending.start > 3) pending = null; // 事件保鲜 3s
        if (event != null && now - event.start >= eventLength(event.kind)) event = null;

        boolean dozing = "asleep".equals(look);
        boolean arrived = age >= 0;
        boolean awake = arrived && (isWorking(look) || isAttention(look)
                || ("done".equals(look) && age < 1.5f)
                || pending != null || event != null);
        float wanted = arrived && (awake || staysBot) ? 1 : 0;
        float stride = dt / MORPH_SECONDS;
        morph = Math.abs(wanted - morph) <= stride ? wanted
                : morph + (wanted > morph ? stride : -stride);

        // 事件等球到位再演。
        if (pending != null && event == null && !isAttention(look) && morph > 0.9f) {
            event = pending;
            pending = null;
            act = null;
        }
        // 鱼挥手比小跳长。
        float greetLength = Math.max(HOP_SECONDS, FIN_WAVE_SECONDS);
        if (greeting >= 0 && now - greeting >= greetLength) greeting = -1;

        // 随机小动作：一个接一个，中间停顿。
        if (act != null && now - act.start >= act.length) act = null;
        boolean actsInPlace = staysInPlace(look);
        // 原作：无指针悬停时，只有 plain/tool/idle/noNews 会随机小动作
        boolean actsEligible = "plain".equals(look) || "tool".equals(look)
                || "idle".equals(look) || "noNews".equals(look);
        boolean acts = event == null && greeting < 0 && actsEligible;
        if (actsInPlace && acts) {
            if (act == null && now >= nextAct) {
                act = pick(now);
                nextAct = now + act.length + 0.5f + random.unit() * 1.9f;
                if ("blinkTwice".equals(act.kind)) {
                    blinks[0] = now;
                    blinks[1] = now + 0.24f;
                }
            }
        } else {
            act = null;
        }
        float progress = act == null ? 0 : clamp((now - act.start) / act.length, 0, 1);
        float swell = act == null ? 0
                : easeInOut(Math.min(1, Math.min(progress / 0.22f, (1 - progress) / 0.22f)));

        signs(now, arrived, dozing);

        Pose p = sitting(age, progress, swell, dozing);
        if (leaving != null && arrived && age < BLEND_SECONDS) {
            p = mixPose(leaving, p, easeOut(clamp(age / BLEND_SECONDS, 0, 1)));
        }
        if (actsInPlace) {
            // 中心固定：呼吸与起伏只改变形状，不挪位置。
            p = mixPose(zeroPose(), p, morph);
            p.x = 0; p.y = 0; p.footing = 0;
            if ("tool".equals(look)) p.y = bobAt(now - beatsFrom) * morph;
        } else if (morph > 0.5f) {
            p.x += 0.025f * face[1];
        }
        played(p, now);
        pose.x = p.x; pose.y = p.y; pose.rotation = p.rotation;
        pose.scaleX = p.scaleX; pose.scaleY = p.scaleY; pose.footing = p.footing;

        flap[0] = flappingLeft(age, now);
        flap[1] = flappingRight(age, now);

        if (arrived) lookFace(age, now, dt, swell, dozing);
    }

    private Act pick(float now) {
        String[] kinds = {"glance", "blinkTwice", "squint", "widen", "smile", "inspect", "tilt", "stretch", "wiggle"};
        float[] weights = {5, 2, 2, 2, 2, 2, 3, 2, 2};
        float total = 0;
        for (float w : weights) total += w;
        float roll = random.unit() * total;
        String kind = kinds[0];
        for (int i = 0; i < kinds.length; i++) {
            roll -= weights[i];
            if (roll < 0) {
                kind = kinds[i];
                break;
            }
        }
        Act a = new Act();
        a.kind = kind;
        a.start = now;
        a.length = actLength(kind);
        a.side = random.unit() < 0.5f ? -1 : 1;
        float angle = random.unit() * 2 * (float) Math.PI;
        a.gazeX = (float) Math.cos(angle);
        a.gazeY = (float) Math.sin(angle) * 0.7f;
        return a;
    }

    private float actLength(String kind) {
        switch (kind) {
            case "glance": return 1.1f + plainRandom.nextFloat() * 0.7f;
            case "blinkTwice": return 0.5f;
            case "squint": return 1.2f;
            case "widen": return 0.9f;
            case "smile": return 1.1f;
            case "inspect": return 1.5f;
            case "tilt": return 1.1f;
            case "stretch": return 0.55f;
            default: return 0.6f; // wiggle
        }
    }

    private Pose sitting(float age, float progress, float swell, boolean dozing) {
        Pose pose = zeroPose();
        float t = age;
        if (isAttention(look)) {
            if (t < HOP_ATTENTION) {
                float x = t / HOP_ATTENTION;
                float arc = (float) Math.sin(Math.PI * x);
                pose.y = -0.26f * 4 * x * (1 - x);
                pose.scaleY = 1 + 0.08f * arc;
                pose.scaleX = 1 - 0.05f * arc;
            }
            float raised = 1 + 0.12f * easeOutBack(clamp(t / 0.35f, 0, 1));
            pose.scaleX *= raised;
            pose.scaleY *= raised;
            MoveAt mv = moveAt(age);
            if ("permission".equals(look)) {
                pose.rotation = mv.start == null ? 0 : knock(age - mv.start);
            } else if ("question".equals(look)) {
                pose.rotation = questionTilt(age);
            } else if ("plan".equals(look)) {
                pose.y += mv.start == null ? 0 : nod(age - mv.start);
            }
        } else if ("done".equals(look)) {
            if (t < 0.6f) {
                float pop = (float) Math.sin(Math.PI * t / 0.6);
                pose.scaleX = 1 + 0.2f * pop;
                pose.scaleY = 1 + 0.2f * pop;
                pose.y = -0.1f * pop;
            }
        } else {
            // 呼吸：绕固定中心改变形状。
            if (staysInPlace(look) && !dozing) {
                float breath = (2 * (float) Math.PI * age) / PERIOD;
                pose.scaleX = 1 + 0.03f * (float) Math.sin(2 * breath);
                pose.scaleY = 1 - 0.03f * (float) Math.sin(2 * breath);
            }
            // 思考时朝目光方向微微侧头。
            if ("thinking".equals(look)) {
                pose.rotation = PONDER_TILT * clamp(face[1] / PONDER_GAZE_X, -1, 1);
            }
        }
        if (act != null) {
            switch (act.kind) {
                case "tilt":
                    pose.rotation += act.side * 9 * swell;
                    break;
                case "stretch": {
                    float arc = (float) Math.sin(Math.PI * progress);
                    pose.scaleY *= 1 + 0.06f * arc;
                    pose.scaleX *= 1 - 0.04f * arc;
                    break;
                }
                case "wiggle":
                    pose.rotation += 8 * (float) Math.sin(2 * Math.PI * 3 * progress) * (1 - progress);
                    break;
                default:
                    break;
            }
        }
        return pose;
    }

    /** 打招呼与事件给坐姿加的料。 */
    private void played(Pose pose, float now) {
        if (greeting >= 0) pose.y += hop(now - greeting) * morph;
        if (event == null) return;
        float time = now - event.start;
        switch (event.kind) {
            case "start":
                pose.y += hop(time) * morph;
                break;
            case "failed": {
                float s = sag(time);
                pose.x += shake(time) * morph;
                pose.rotation += 6 * s * morph;
                pose.y += 0.02f * s * morph;
                break;
            }
            case "limitHit": {
                Sigh sg = sigh(time);
                pose.scaleX *= 1 + (sg.scaleX - 1) * morph;
                pose.scaleY *= 1 + (sg.scaleY - 1) * morph;
                pose.footing = 0.5f;
                break;
            }
            default:
                break;
        }
    }

    /** 鱼鳍抬起：干活时随点头抬双鳍，开工与打招呼扇一下，完成时连扇三下。 */
    private float flappingLeft(float age, float now) {
        if (event != null) {
            float f = Math.round(finFlap(now - event.start) * morph);
            return "start".equals(event.kind) ? f : 0;
        }
        if (greeting >= 0) {
            float wave = Math.round(finWave(now - greeting) * morph);
            return greetSide < 0 ? wave : 0;
        }
        if ("tool".equals(look)) {
            float p = bobAt(now - beatsFrom) > 0 ? Math.round(PADDLE * morph) : 0;
            return p;
        }
        if ("done".equals(look)) {
            return Math.round(cheer(age) * morph);
        }
        return 0;
    }

    private float flappingRight(float age, float now) {
        if (event != null) {
            float f = Math.round(finFlap(now - event.start) * morph);
            return "start".equals(event.kind) ? f : 0;
        }
        if (greeting >= 0) {
            float wave = Math.round(finWave(now - greeting) * morph);
            return greetSide < 0 ? 0 : wave;
        }
        if ("tool".equals(look)) {
            float p = bobAt(now - beatsFrom) > 0 ? Math.round(PADDLE * morph) : 0;
            return p;
        }
        if ("done".equals(look)) {
            return Math.round(cheer(age) * morph);
        }
        return 0;
    }

    /** 眼神：看向哪、睁多大、笑没笑。 */
    private void lookFace(float age, float now, float dt, float swell, boolean dozing) {
        float[] target = {1, 0, 0, 1, 0, 0, 0}; // open, look, lookY, wide, happy, lean, crossed
        float[] every = {3.2f, 6.5f};
        boolean hasEvery = true;
        if (isAttention(look)) {
            target[3] = 1.22f;
            if ("plan".equals(look) && movingAt(age)) target[2] = 0.5f;
            every = age < 1.5f || age >= FULL_WAIT ? null : new float[]{4, 7};
            hasEvery = every != null;
        } else if ("done".equals(look)) {
            if (age < 1.25f) {
                target[4] = 1;
                every = null;
                hasEvery = false;
            }
        } else if ("thinking".equals(look)) {
            int side = ponderSide(now);
            target[1] = PONDER_GAZE_X * side;
            target[2] = PONDER_GAZE_Y;
            every = new float[]{2.2f, 4.5f};
            hasEvery = true;
        } else if (dozing) {
            target[0] = 0;
            every = null;
            hasEvery = false;
        } else {
            every = new float[]{2.2f, 4.5f};
            hasEvery = true;
            if (act != null) {
                switch (act.kind) {
                    case "glance":
                        target[1] += (act.gazeX * 0.8f - target[1]) * swell;
                        target[2] += (act.gazeY - target[2]) * swell;
                        break;
                    case "squint":
                        target[0] = 1 - 0.55f * swell;
                        break;
                    case "widen":
                        target[3] = 1 + 0.2f * swell;
                        break;
                    case "smile":
                        target[4] = swell > 0.4f ? 1 : 0;
                        break;
                    case "inspect":
                        target[5] = act.side * swell;
                        target[1] += (act.side * 0.6f - target[1]) * swell;
                        target[2] -= target[2] * swell;
                        break;
                    default:
                        break;
                }
            }
        }
        if (pending != null && "start".equals(pending.kind)) target[0] = 0;
        if (event != null) {
            float time = now - event.start;
            switch (event.kind) {
                case "start":
                    target[0] = clamp(time / HOP_SECONDS, 0, 1);
                    break;
                case "failed":
                    target[6] = CROSSES_EYES ? 1 : 0;
                    if (!CROSSES_EYES) target[0] = 0.45f;
                    target[2] = 0.35f * sag(time);
                    break;
                case "limitHit":
                    target[0] = sigh(time).open;
                    target[2] = 0.3f;
                    break;
                default:
                    break;
            }
            every = null;
            hasEvery = false;
        }
        blinksOn = hasEvery;

        float eyes = 1 - (float) Math.exp(-dt * 18);
        float head = 1 - (float) Math.exp(-dt * 9);
        face[1] += (target[1] - face[1]) * head;
        face[2] += (target[2] - face[2]) * head;
        face[3] += (target[3] - face[3]) * eyes;
        face[4] += (target[4] - face[4]) * eyes;
        face[5] += (target[5] - face[5]) * eyes;
        face[6] += (target[6] - face[6]) * eyes;

        float lid = target[0];
        if (hasEvery) {
            if (now >= nextBlink) {
                blinks[0] = now;
                blinks[1] = -1;
                nextBlink = now + every[0] + random.unit() * (every[1] - every[0]);
            }
        } else if (nextBlink < now) {
            nextBlink = now + 1.2f;
        }
        for (float start : blinks) {
            float blink = (now - start) / 0.17f;
            if (blink >= 0 && blink < 1) lid *= 1 - (float) Math.sin(Math.PI * blink);
        }
        face[0] += (lid - face[0]) * (1 - (float) Math.exp(-dt * 60));
    }

    private boolean movingAt(float age) {
        MoveAt mv = moveAt(age);
        return mv.start != null && age - mv.start < moveLength(look);
    }

    /** 头顶符号：等待请求的 ! ? ≡、失败的 ×、限流的 ⧗、思考的 …、打盹的 z。 */
    private void signs(float now, boolean arrived, boolean dozing) {
        int shown = 0;
        if (arrived) {
            if ("permission".equals(look)) shown = SIGN_EXCLAMATION;
            else if ("question".equals(look)) shown = SIGN_QUESTION;
            else if ("plan".equals(look)) shown = SIGN_LINES;
        }
        if (event != null && "failed".equals(event.kind)) shown = signShown(shown, SIGN_CROSS);
        if ("failed".equals(badge)) shown = signShown(shown, SIGN_CROSS);
        if ("limited".equals(badge)) shown = signShown(shown, SIGN_HOURGLASS);
        if (morph > 0 && "thinking".equals(look)) shown = signShown(shown, SIGN_ELLIPSIS);
        if (morph > 0 && dozing) shown = signShown(shown, SIGN_Z);
        sign = shown;
        lit = shown == SIGN_ELLIPSIS ? (int) (now * 3 + 1e-6f) % 3 : 0;
    }

    private static float eventLength(String kind) {
        if ("failed".equals(kind)) return 1.5f;
        if ("limitHit".equals(kind)) return 1.2f;
        return HOP_SECONDS;
    }

    private static float onFrame(float now) {
        float frame = Math.round(now / PACE_LIVELY) * PACE_LIVELY;
        return Math.abs(frame - now) <= PACE_SLACK ? frame : now;
    }

    /* ---------------- 绘制（BotRenderer 移植） ---------------- */

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        renderFrame(canvas);
    }

    private void renderFrame(Canvas canvas) {
        float share = morph;
        float eased = easeInOut(share);
        float solid = Math.min(1, share / 0.22f);
        float dressed = Math.max(0, Math.min(1, (share - 0.45f) / 0.45f));
        float[] reach = logoReach != null ? logoReach : fullReach();
        float margin = 0.3f;

        canvas.save();
        // 坐姿：位移、旋转、缩放（footing 为缩放原点）
        float cx = CENTER_X * sidePx;
        float cy = CENTER_Y * sidePx;
        canvas.translate(pose.x * sidePx, pose.y * sidePx);
        canvas.translate(cx, cy);
        canvas.translate(0, pose.footing * R * sidePx);
        canvas.rotate(pose.rotation);
        canvas.scale(pose.scaleX, pose.scaleY);
        canvas.translate(0, -pose.footing * R * sidePx);
        canvas.translate(-cx, -cy);

        // mark 空间：一单位 = mark 边长，原点在 mark 左上角，y 向下。
        canvas.translate(margin * sidePx, margin * sidePx);
        canvas.scale(sidePx, sidePx);

        // 1) 鲸鱼 logo 淡出（morph 前 40%）
        float artwork = 1 - Math.min(1, share / 0.4f);
        if (artwork > 0 && logo != null) {
            logoPaint.setAlpha((int) (255 * artwork));
            canvas.drawBitmap(logo, null, logoDst, logoPaint);
        }

        // 2) 鱼鳍（站在身后，随 morph 长出；hand ≠ 0 的会随动作抬起）
        if (dressed > 0) {
            canvas.save();
            finPaint.setAlpha((int) (255 * dressed));
            canvas.translate(CENTER_X, CENTER_Y);
            canvas.scale(R, R);
            float grown = 0.3f + 0.7f * dressed;
            for (Fin fin : FINS) {
                float raised = fin.hand < 0 ? flap[0] : fin.hand > 0 ? flap[1] : 0;
                finPath.reset();
                buildFinPath(fin, grown, raised);
                canvas.drawPath(finPath, finPaint);
            }
            canvas.restore();
        }

        // 3) 球身与 4) 白肚皮：都裁进轮廓里
        canvas.save();
        buildOutline(reach, eased);
        canvas.clipPath(outlinePath);
        bodyPaint.setAlpha((int) (255 * solid));
        canvas.drawRect(CENTER_X - R - 0.05f, CENTER_Y - R - 0.05f,
                CENTER_X + R + 0.05f, CENTER_Y + R + 0.05f, bodyPaint);

        // 白肚皮（圆角胶囊，贴在球身下部）
        canvas.save();
        bellyPaint.setAlpha((int) (255 * dressed));
        canvas.translate(CENTER_X, CENTER_Y);
        canvas.scale(R, R);
        float bw = 1.72f, bh = 1.56f; // x1-x0 = 0.86-(-0.86)，y1-y0 = 1.9-0.34
        buildPill(bellyPath, bw, bh, 1f);
        canvas.drawPath(bellyPath, bellyPaint);
        canvas.restore();
        canvas.restore(); // 轮廓裁剪

        // 5) 眼睛（不裁进轮廓）
        if (dressed > 0) drawEyes(canvas, dressed);

        canvas.restore(); // 坐姿 + mark 空间

        // 6) 头顶符号（整像素网格）
        if (sign != 0) drawSign(canvas);
    }

    private static float[] fullReach() {
        float[] r = new float[360];
        java.util.Arrays.fill(r, R);
        return r;
    }

    private void buildOutline(float[] reach, float eased) {
        outlinePath.reset();
        for (int i = 0; i < 360; i++) {
            float angle = (i * 2 * (float) Math.PI) / 360;
            float r = reach[i] + (R - reach[i]) * eased;
            float x = CENTER_X + (float) Math.cos(angle) * r;
            float y = CENTER_Y + (float) Math.sin(angle) * r;
            if (i == 0) outlinePath.moveTo(x, y);
            else outlinePath.lineTo(x, y);
        }
        outlinePath.close();
    }

    /** 桨形鳍：根圆与尖圆外加两条公切线（BotFins.swift 移植）。 */
    private void buildFinPath(Fin fin, float grown, float raised) {
        float angle = (float) Math.toRadians(fin.angle - fin.hand * raised);
        float alongX = (float) Math.cos(angle), alongY = (float) Math.sin(angle);
        float acrossX = (float) Math.sin(angle), acrossY = -(float) Math.cos(angle);
        float length = fin.length * grown;
        float ra = fin.base * grown;
        float rb = fin.tip * grown;
        float ax = fin.rootX, ay = fin.rootY;
        float bx = ax + alongX * (length - rb) + acrossX * fin.sweep * grown;
        float by = ay + alongY * (length - rb) + acrossY * fin.sweep * grown;
        float dx = bx - ax, dy = by - ay;
        float d = Math.max(1e-6f, (float) Math.hypot(dx, dy));
        float s = clamp((ra - rb) / d, -1, 1);
        float c = (float) Math.sqrt(1 - s * s);
        float toward = (float) Math.atan2(dy, dx);
        float spread = (float) Math.atan2(c, s);

        // 先绕尖圆，再绕根圆，闭合（与原作逐段采样一致，直接写进 Path）。
        finPath.reset();
        boolean first = true;
        float from = toward - spread, to = toward + spread;
        int steps = Math.max(2, (int) Math.ceil((to - from) / (Math.PI / 16)));
        for (int i = 0; i <= steps; i++) {
            float ang = from + (to - from) * i / steps;
            float px = bx + rb * (float) Math.cos(ang);
            float py = by + rb * (float) Math.sin(ang);
            if (first) {
                finPath.moveTo(px, py);
                first = false;
            } else {
                finPath.lineTo(px, py);
            }
        }
        from = toward + spread;
        to = toward + 2 * (float) Math.PI - spread;
        steps = Math.max(2, (int) Math.ceil((to - from) / (Math.PI / 16)));
        for (int i = 0; i <= steps; i++) {
            float ang = from + (to - from) * i / steps;
            finPath.lineTo(ax + ra * (float) Math.cos(ang), ay + ra * (float) Math.sin(ang));
        }
        finPath.close();
    }

    /** 胶囊路径（round=1 时即全圆角胶囊），以当前原点为中心。 */
    private void buildPill(Path path, float w, float h, float round) {
        float x = -w / 2, y = -h / 2;
        float r = Math.min(w, h) / 2 * round;
        path.reset();
        if (r <= 0.0005f) {
            path.addRect(x, y, x + w, y + h, Path.Direction.CW);
            return;
        }
        path.moveTo(x + r, y);
        path.lineTo(x + w - r, y);
        rectF.set(x + w - 2 * r, y, x + w, y + 2 * r);
        path.arcTo(rectF, -90, 90);
        path.lineTo(x + w, y + h - r);
        rectF.set(x + w - 2 * r, y + h - 2 * r, x + w, y + h);
        path.arcTo(rectF, 0, 90);
        path.lineTo(x + r, y + h);
        rectF.set(x, y + h - 2 * r, x + 2 * r, y + h);
        path.arcTo(rectF, 90, 90);
        path.lineTo(x, y + r);
        rectF.set(x, y, x + 2 * r, y + 2 * r);
        path.arcTo(rectF, 180, 90);
        path.close();
    }

    private void drawEyes(Canvas canvas, float awake) {
        float f0 = face[0], f1 = face[1], f2 = face[2], f3 = face[3], f4 = face[4], f5 = face[5], f6 = face[6];
        float radius = R;
        float size = 0.78f;
        float spread = EYE_SPREAD;
        float turn = 1f * 0.72f;
        float yaw = clamp(f1, -1.15f, 1.15f) * turn;
        float pitch = clamp(f2, -1.15f, 1.15f) * turn;
        float apart = ((float) Math.sin(yaw + spread) - (float) Math.sin(yaw - spread)) * radius * 0.76f;

        for (int side : new int[]{-1, 1}) {
            float angle = yaw + side * spread;
            float x = CENTER_X + FACE_X * radius + (float) Math.sin(angle) * radius * 0.76f;
            float y = CENTER_Y + FACE_Y * radius + (float) Math.sin(pitch) * 0.62f * radius;
            float narrow = (float) Math.pow(Math.max(0.25f, Math.cos(angle)), 1.4);
            float tall = (0.72f + 0.28f * (float) Math.cos(angle))
                    * (float) Math.pow(Math.max(0, (float) Math.cos(pitch)), 0.5);
            float big = (1 + 0.26f * side * f5) * f3 * (0.6f + 0.4f * awake) * size;
            float w = EYE_WIDTH * radius * big * narrow;
            float h = EYE_HEIGHT * radius * big * tall * Math.max(0.08f, f0) * awake;

            canvas.save();
            canvas.translate(x, y);
            if (f4 < 0.98f && f6 < 0.98f) {
                inkPaint.setAlpha((int) (255 * (1 - f4) * (1 - f6)));
                buildPill(eyePath, w, Math.max(h, w * 0.16f), 1f);
                canvas.drawPath(eyePath, inkPaint);
            }
            if (f6 > 0.02f) {
                // 失败后打叉（DeepSeek 眼睛够大，叉得出）
                float reachX = EYE_HEIGHT * radius * size * 0.32f * (0.6f + 0.4f * awake);
                inkStroke.setAlpha((int) (255 * f6));
                inkStroke.setStrokeWidth(EYE_WIDTH * radius * size * 0.55f);
                canvas.drawLine(-reachX, -reachX, reachX, reachX, inkStroke);
                canvas.drawLine(-reachX, reachX, reachX, -reachX, inkStroke);
            }
            if (f4 > 0.02f) {
                float stroke = Math.min(EYE_WIDTH * radius * 0.58f * size, apart * 0.2f);
                float half = Math.max(stroke * 0.7f,
                        Math.min(EYE_WIDTH * radius * 0.8f * size, apart / 2 - stroke * 1.05f))
                        * Math.max(0.6f, narrow);
                float rise = half * 0.95f;
                inkStroke.setAlpha((int) (255 * f4));
                inkStroke.setStrokeWidth(stroke);
                eyePath.reset();
                eyePath.moveTo(-half, rise * 0.45f);
                eyePath.quadTo(0, -rise * 1.1f, half, rise * 0.45f);
                canvas.drawPath(eyePath, inkStroke);
            }
            canvas.restore();
        }
    }

    /** 头顶符号：5×7 整像素网格，深色地上白字描深边；… 逐点点亮。 */
    private void drawSign(Canvas canvas) {
        String[] rows = SIGN_ROWS[sign];
        if (rows == null) return;
        float margin = 0.3f;
        float top = CENTER_Y - R; // 球顶
        float footX = CENTER_X + 0.14f, footY = top - 0.04f;
        float cell = Math.max(1, Math.min(Math.round(sidePx / 20), Math.round((0.3f * sidePx) / SIGN_ROWS_N)));
        float width = SIGN_COLS * cell;
        float height = SIGN_ROWS_N * cell;
        float left = Math.round((footX + margin) * sidePx);
        float bottom = Math.round((footY + margin) * sidePx);
        float ceiling = (float) Math.ceil((margin - 0.28f) * sidePx);
        bottom = Math.max(bottom, ceiling + height);
        left = Math.max(1, Math.min(left, sidePx * 1.6f - 1 - width));
        int litClamped = (int) clamp(lit, 0, 2);

        for (int row = 0; row < SIGN_ROWS_N; row++) {
            for (int col = 0; col < SIGN_COLS; col++) {
                if (rows[row].charAt(col) != '#') continue;
                float x = left + col * cell;
                float y = bottom - (row + 1) * cell;
                boolean dim = sign == SIGN_ELLIPSIS && col != 2 * litClamped;
                Paint edge = dim ? signEdgeFaint : signEdge;
                Paint fill = dim ? signDim : signInk;
                rectF.set(x - 1, y - 1, x + cell + 1, y + cell + 1);
                canvas.drawRect(rectF, edge);
                rectF.set(x, y, x + cell, y + cell);
                canvas.drawRect(rectF, fill);
            }
        }
    }

    /* ---------------- 鲸鱼 logo 的轮廓采样（BotForm.reach 移植） ---------------- */
    private static final int GRAIN = 256;

    private static float[] sampleLogoReach(Bitmap src) {
        Bitmap bmp = Bitmap.createScaledBitmap(src, GRAIN, GRAIN, true);
        int[] px = new int[GRAIN * GRAIN];
        bmp.getPixels(px, 0, GRAIN, 0, 0, GRAIN, GRAIN);
        if (bmp != src) bmp.recycle();
        float startX = CENTER_X * GRAIN;
        float startY = CENTER_Y * GRAIN;
        float[] reach = new float[360];
        for (int i = 0; i < 360; i++) {
            float angle = (i * 2 * (float) Math.PI) / 360;
            float dx = (float) Math.cos(angle);
            float dy = (float) Math.sin(angle);
            int last = 0;
            for (int dist = 0; dist < GRAIN * 1.5f; dist++) {
                int x = Math.round(startX + dx * dist);
                int y = Math.round(startY + dy * dist);
                if (x < 0 || y < 0 || x >= GRAIN || y >= GRAIN) break;
                if ((px[y * GRAIN + x] >>> 24) > 127) last = dist;
            }
            reach[i] = Math.max(0.02f, last / (float) GRAIN);
        }
        return reach;
    }
}
