package ai.deepseek.dsh.mobile;

import android.app.Service;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.text.Editable;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * DSH 悬浮状态窗：在其他应用上方显示 Agent 状态。
 * 收缩态 = 一条可拖动的状态胶囊（左侧带 DSH 小球）；展开态 = 状态 + 多会话分框 + 任务步骤
 * + 最近消息 + 快捷输入（发消息 / 停止会话）。
 * 数据来自 DshHudState（WebView 侧 DshHud.push 推送）。
 *
 * ============ 展开态为什么能收发消息 ============
 *
 * 悬浮窗是原生 View，聊天逻辑在 WebView 里的 JS。两者隔着一层 WebView，
 * 所以：
 *
 *   - **读（接消息）**：JS 侧把最近的消息放进快照里推过来（hudSnapshot），
 *     原生只负责渲染。没有额外通道。
 *   - **写（发消息 / 停止）**：原生调 DshHudState.sendCommand()，
 *     它用 evaluateJavascript 调页面里的 window.__dshHudCommand(action, payload)。
 *
 * 不用「Intent → Activity → 广播 → JS」那一套，是因为 HUD 服务就跑在主进程里，
 * 和 WebView 同一个进程，直接调最短。
 */
public class DshHudService extends Service {

    private WindowManager wm;
    private LinearLayout root;
    private LinearLayout body;
    private LinearLayout capRow;
    private TextView capsule;
    private DshBotView ball;

    /** 消息区（每次刷新重建）。 */
    private LinearLayout msgBox;
    /** 输入行：提示条 + 真正的输入框 + 发送键。 */
    private LinearLayout actionRow;
    private TextView inputHint;
    private LinearLayout inputBox;
    private EditText input;
    private TextView sendBtn;
    private TextView stopBtn;

    /** 是否处于「正在输入」模式（此时窗口可获焦点、软键盘弹出）。 */
    private boolean inputMode = false;
    /** 输入模式下的窗口参数备份，收起时还原。 */
    private int savedFlags;
    private int savedX, savedY, savedWidth, savedHeight;

    private static int lastCueSeq = -1; // 一次性事件按 cueSeq 去重，避免折叠/展开/重建时重放
    private boolean collapsed = true;
    /**
     * 悬浮窗底色。
     *
     * ============ alpha 是刻意压低的 ============
     *
     * 0xCC = 204/255 ≈ 0.80 → 0xAD = 173/255 ≈ 0.68。
     *
     * 悬浮窗长期挂在别的应用上面，0.80 的实心感太重 —— 挡住的不只是背景，
     * 还有用户正在看的内容（看视频时右侧一大块不透明会很难受）。
     * 0.68 既能透出底层，又不至于让白字糊掉。
     *
     * 想再透一点就继续降（0xA6 ≈ 0.65、0x99 ≈ 0.60），
     * 但低于 0.6 之后在浅色界面上白字会开始看不清。
     */
    private int statusBarColor = Color.parseColor("#AD141821");
    private final Handler main = new Handler(Looper.getMainLooper());

    private WindowManager.LayoutParams params = new WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                    | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT);

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = 24;
        params.y = 180;
        if (DshHudState.enabled && Settings.canDrawOverlays(this)) {
            showViews();
        }
        DshHudService.instance = this;
    }

    @Override
    public void onDestroy() {
        hideViews();
        DshHudService.instance = null;
        super.onDestroy();
    }

    static DshHudService instance;

    /** WebView 侧推送后调用：切到主线程刷新。 */
    static void refresh() {
        final DshHudService svc = instance;
        if (svc == null) return;
        svc.main.post(svc::rebuild);
    }

    private void showViews() {
        if (root != null) return;
        buildViews();
        try {
            wm.addView(root, params);
        } catch (Exception ignored) {
            root = null;
        }
    }

    private void hideViews() {
        if (root == null) return;
        exitInputMode(false);
        try {
            wm.removeView(root);
        } catch (Exception ignored) {
        }
        root = null;
        body = null;
        capRow = null;
        capsule = null;
        ball = null;
        msgBox = null;
        actionRow = null;
        inputHint = null;
        inputBox = null;
        input = null;
        sendBtn = null;
        stopBtn = null;
    }

    private void rebuild() {
        if (!DshHudState.enabled) {
            hideViews();
            return;
        }
        if (!Settings.canDrawOverlays(this)) {
            hideViews();
            return;
        }
        if (root == null) showViews();
        if (root != null) fillBody();
    }

    /**
     * 展开态的文本行宽度上限（dp）。
     *
     * ============ 为什么原来是 238，现在 300 ============
     *
     * 238dp 下，一条「· 会话标题 — 正在思考」就会被截成
     * 「· 会话标题 — 正在思…」，用户得点进应用才能看全。
     * 这个浮窗存在的意义就是"不切应用也能看清"，截断直接抵消了它。
     *
     * 加宽**不会变高**：body 里每行都是单行 TextView，
     * 行数由数据条数决定，与宽度无关。加宽只是让每行少被截几个字。
     */
    private static final float W_MAX_DP = 300;

    /**
     * 收起态的文本上限。
     *
     * 收起时只有「DSH · 空闲中」这种短句，用不到 300 ——
     * 真遇到长状态文本时保持窄一点，别让胶囊横穿半个屏幕。
     */
    private static final float W_COLLAPSED_DP = 238;

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    /**
     * 把宽度上限压进屏幕能容纳的范围。
     *
     * 300dp 在主流机型（360dp 起）没问题，但 320dp 的老设备上
     * 300 + 左右 padding 24 = 324 会顶出屏幕。
     *
     * 而悬浮窗带 FLAG_LAYOUT_NO_LIMITS —— 出屏不会被裁，
     * 而是**直接少一截看不见**，右侧文字被切掉还没提示。
     */
    private int clampWidth(float wantDp) {
        int screen = getResources().getDisplayMetrics().widthPixels;
        int room = screen - dp(40); // 左右各留 20dp
        return Math.min(dp(wantDp), Math.max(dp(180), room));
    }

    private GradientDrawable pill(float radius, int color) {
        GradientDrawable d = new GradientDrawable();
        d.setCornerRadius(dp(radius));
        d.setColor(color);
        return d;
    }

    private TextView line(String text, float sizeSp, int color, boolean bold) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        tv.setTextColor(color);
        tv.setTypeface(Typeface.create("sans-serif", bold ? Typeface.BOLD : Typeface.NORMAL));
        tv.setSingleLine(true);
        tv.setEllipsize(TextUtils.TruncateAt.END);
        tv.setPadding(dp(2), dp(1), dp(2), dp(1));
        // 限宽：窗口是 WRAP_CONTENT，不限的话一行长文本能把整个浮窗拉成全屏宽。
        // 默认用展开态的宽度；胶囊行在 buildViews / fillBody 里单独收窄。
        tv.setMaxWidth(clampWidth(W_MAX_DP));
        return tv;
    }

    private void buildViews() {
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackground(pill(18, statusBarColor));
        root.setPadding(dp(12), dp(7), dp(12), dp(7));

        // 胶囊行：DSH 小球 + 状态文字（收缩态只留这一行）
        capRow = new LinearLayout(this);
        capRow.setOrientation(LinearLayout.HORIZONTAL);
        capRow.setGravity(Gravity.CENTER_VERTICAL);
        ball = new DshBotView(this);
        try {
            Bitmap logo = BitmapFactory.decodeResource(getResources(), R.drawable.whale_white);
            ball.setLogo(logo);
        } catch (Exception ignored) {
            /* 没有 logo 也能画球，只是少了化身动画 */
        }
        capRow.addView(ball, new LinearLayout.LayoutParams(dp(48), dp(48)));
        // 点小球：打个招呼（不消费事件，拖动 / 伸缩仍由 capRow 处理）
        ball.setOnTouchListener((v, e) -> {
            if (e.getActionMasked() == MotionEvent.ACTION_DOWN) ball.greet();
            return false;
        });
        capsule = line("DSH · 空闲中", 12, Color.WHITE, true);
        capsule.setMaxWidth(clampWidth(W_COLLAPSED_DP));
        capRow.addView(capsule);
        root.addView(capRow);

        body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        root.addView(body);

        // 快捷操作行是 body 的**兄弟**而不是子节点。
        //
        // body 每次快照推送都会 removeAllViews() 重建（消息在流式更新，
        // 内容一直在变）。如果操作行是 body 的子节点，重建时它会被摘下来再挂回去 ——
        // EditText 会丢焦点、正在输入的文字会丢、软键盘会收起。
        // 放在外面它就一直活着，输入不被打断。
        buildActionRow();
        root.addView(actionRow, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        // 拖动 + 点按伸缩
        //
        // ============ 为什么挂在 capRow 而不是 root ============
        //
        // 旧代码把 OnTouchListener 挂在 root 上，而它对所有事件都 return true。
        // 展开态下 root 里会有按钮和 EditText —— 事件全被 root 吞掉，
        // 按钮点不动、键盘弹不出来。
        //
        // 挂在 capRow 上就干净了：标题行负责拖动与伸缩，
        // 下面的内容区各控件自己处理触摸，互不干扰。
        capRow.setOnTouchListener(new View.OnTouchListener() {
            float downX, downY;
            int startX, startY;
            boolean moved;

            @Override
            public boolean onTouch(View v, MotionEvent event) {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = event.getRawX();
                        downY = event.getRawY();
                        startX = params.x;
                        startY = params.y;
                        moved = false;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        float dx = event.getRawX() - downX;
                        float dy = event.getRawY() - downY;
                        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;
                        if (moved) {
                            params.x = startX + (int) dx;
                            params.y = startY + (int) dy;
                            try {
                                wm.updateViewLayout(root, params);
                            } catch (Exception ignored) {
                            }
                        }
                        return true;
                    case MotionEvent.ACTION_UP:
                        if (!moved) {
                            collapsed = !collapsed;
                            if (collapsed) exitInputMode(true);
                            fillBody();
                        } else {
                            snapToEdge();
                        }
                        return true;
                    default:
                        return false;
                }
            }
        });

        fillBody();
    }

    /**
     * 快捷操作行：输入框 + 发送 + 停止。
     *
     * 收起状态下这一整行都隐藏（body 整个清空），只有展开态才有。
     */
    private void buildActionRow() {
        actionRow = new LinearLayout(this);
        actionRow.setOrientation(LinearLayout.VERTICAL);

        // 提示条：没进入输入模式时显示「点这里回消息」，点一下才弹键盘
        //
        // 为什么不是一上来就放 EditText：
        // 悬浮窗默认是 FLAG_NOT_FOCUSABLE 的（不抢焦点、不拦触摸），
        // 这种窗口里的 EditText 拿不到输入焦点，键盘弹不出来。
        // 所以先用一个普通 TextView 当入口，用户点它的时候再切窗口标志。
        inputHint = line("点这里回消息…", 11, Color.parseColor("#9FB4D8"), false);
        inputHint.setPadding(dp(10), dp(7), dp(10), dp(7));
        inputHint.setBackground(pill(12, Color.parseColor("#232A38")));
        inputHint.setOnClickListener(v -> enterInputMode());
        actionRow.addView(inputHint, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        // 真正的输入行
        inputBox = new LinearLayout(this);
        inputBox.setOrientation(LinearLayout.HORIZONTAL);
        inputBox.setGravity(Gravity.CENTER_VERTICAL);

        input = new EditText(this);
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
        input.setTextColor(Color.WHITE);
        input.setHintTextColor(Color.parseColor("#6C7789"));
        input.setHint("回消息…");
        input.setSingleLine(true);
        input.setBackground(pill(12, Color.parseColor("#232A38")));
        input.setPadding(dp(10), dp(4), dp(10), dp(4));
        // 固定宽度而不是 weight=1：
        // 父容器是 WRAP_CONTENT，weight 在这种父容器下会被算成 0 宽。
        // 跟着悬浮窗一起加宽，否则展开时上面 300、下面 148，右边空一块很别扭
        inputBox.addView(input, new LinearLayout.LayoutParams(dp(190), dp(34)));

        sendBtn = button("发送", Color.parseColor("#3A7BD5"), Color.WHITE);
        sendBtn.setOnClickListener(v -> sendFromInput());
        inputBox.addView(sendBtn, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, dp(30)));

        stopBtn = button("停止", Color.parseColor("#8C3A3A"), Color.WHITE);
        stopBtn.setOnClickListener(v -> stopRun());
        inputBox.addView(stopBtn, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, dp(30)));

        // 输入行默认隐藏：只有用户点了「点这里回消息」才显示并弹键盘。
        // 一开始就显示的话，用户会看到一个点不动的输入框（窗口不可获焦）。
        inputBox.setVisibility(View.GONE);

        actionRow.addView(inputBox, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        // 发送键也要能吃回车：软键盘的「发送」动作
        input.setOnEditorActionListener((v, actionId, event) -> {
            sendFromInput();
            return true;
        });
    }

    private TextView button(String text, int bg, int fg) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10.5f);
        tv.setTextColor(fg);
        tv.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
        tv.setGravity(Gravity.CENTER);
        tv.setPadding(dp(10), dp(3), dp(10), dp(3));
        tv.setBackground(pill(11, bg));
        return tv;
    }

    /* ------------------------------------------------------------ 输入模式 */

    /**
     * 进入输入模式：把窗口从「不可获焦」切成「可获焦」，然后弹软键盘。
     *
     * ============ 为什么必须切标志 ============
     *
     * 悬浮窗默认带 FLAG_NOT_FOCUSABLE —— 这是悬浮窗的常规做法：
     * 它不抢走应用的输入焦点，也不拦截落在它下面的触摸。
     * 但也正因为不能获焦，里面的 EditText 永远拿不到输入焦点，
     * 键盘根本不会弹出来（点输入框毫无反应）。
     *
     * 所以点击输入入口时：去掉 FLAG_NOT_FOCUSABLE，换上 FLAG_NOT_TOUCH_MODAL。
     * 后者保证**窗口外的触摸仍然穿透到下面的应用**——
     * 否则用户在 AI 控制屏幕时点别的应用，会被这个窗口吃掉点击，
     * 屏幕控制直接失灵。
     */
    private void enterInputMode() {
        if (root == null || inputMode) return;
        inputMode = true;
        savedFlags = params.flags;
        savedX = params.x;
        savedY = params.y;
        savedWidth = params.width;
        savedHeight = params.height;

        params.flags = (params.flags & ~WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL;
        // 只设 STATE_VISIBLE，不设 ADJUST_RESIZE：
        // 悬浮窗（TYPE_APPLICATION_OVERLAY）不参与窗口 resize，
        // 设了反而在部分 ROM 上把窗口算歪。
        params.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE;
        try {
            wm.updateViewLayout(root, params);
        } catch (Exception ignored) {
        }

        inputHint.setVisibility(View.GONE);
        inputBox.setVisibility(View.VISIBLE);
        input.requestFocus();
        // 键盘要在窗口标志生效之后再弹，否则会打在旧窗口配置上
        main.postDelayed(this::showKeyboard, 120);
    }

    /**
     * 退出输入模式：收起键盘、恢复窗口标志。
     *
     * @param hideKeyboard 是否收键盘（重建视图时传 false）
     */
    private void exitInputMode(boolean hideKeyboard) {
        if (!inputMode) return;
        inputMode = false;
        if (hideKeyboard) {
            try {
                InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
                if (imm != null && input != null) imm.hideSoftInputFromWindow(input.getWindowToken(), 0);
            } catch (Exception ignored) {
            }
        }
        if (input != null) {
            try {
                input.clearFocus();
            } catch (Exception ignored) {
            }
        }
        if (root != null) {
            params.flags = savedFlags;
            params.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN;
            try {
                wm.updateViewLayout(root, params);
            } catch (Exception ignored) {
            }
        }
        if (inputHint != null) inputHint.setVisibility(View.VISIBLE);
        if (inputBox != null) inputBox.setVisibility(View.GONE);
    }

    private void showKeyboard() {
        if (!inputMode || input == null) return;
        try {
            InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (imm != null) imm.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT);
        } catch (Exception ignored) {
        }
    }

    /** 发送输入框里的文字给页面。 */
    private void sendFromInput() {
        if (input == null) return;
        String text = input.getText() == null ? "" : input.getText().toString().trim();
        if (text.isEmpty()) return;
        try {
            input.setText("");
        } catch (Exception ignored) {
        }
        try {
            JSONObject payload = new JSONObject();
            payload.put("text", text);
            DshHudState.sendCommand("send", payload.toString());
        } catch (Exception ignored) {
        }
        // 发完不退出输入模式：用户可能还要接着说
    }

    /** 请求页面停止当前这次运行。 */
    private void stopRun() {
        try {
            DshHudState.sendCommand("stop", null);
        } catch (Exception ignored) {
        }
    }

    /** 松手后吸附到最近的屏幕左右边，并夹紧上下边界（气泡贴边）。 */
    private void snapToEdge() {
        int screenW = getResources().getDisplayMetrics().widthPixels;
        int screenH = getResources().getDisplayMetrics().heightPixels;
        int w = root.getWidth();
        int h = root.getHeight();
        if (w <= 0 || h <= 0) return;
        // 以窗口中心点的左右半边决定贴靠方向
        int centerX = params.x + w / 2;
        params.x = centerX <= screenW / 2 ? 0 : screenW - w;
        params.y = Math.max(0, Math.min(params.y, screenH - h));
        try {
            wm.updateViewLayout(root, params);
        } catch (Exception ignored) {
        }
    }

    private void fillBody() {
        if (root == null || body == null) return;
        try {
            JSONObject o = new JSONObject(DshHudState.json);
            String statusText = o.optString("statusText", "空闲中");
            String step = o.optString("step", "");
            JSONArray sessions = o.optJSONArray("sessions");
            JSONArray tasks = o.optJSONArray("tasks");
            JSONArray messages = o.optJSONArray("messages");

            capsule.setText("DSH · " + statusText);
            driveBot(o);

            if (collapsed) {
                // 收缩态：只保留胶囊，宽度回到内容自适应
                root.setMinimumWidth(0);
                capsule.setMaxWidth(clampWidth(W_COLLAPSED_DP));
                while (body.getChildCount() > 0) body.removeAllViews();
                if (actionRow != null) actionRow.setVisibility(View.GONE);
                return;
            }
            // ============ 展开态要给一个**固定**宽度，不能只放开上限 ============
            //
            // 只改 maxWidth 的话，窗口仍是 WRAP_CONTENT —— 宽度由最长的那一行撑开。
            // 而 body 里的行都是 nowrap + ellipsis，它们的 max-content 就是文字全长，
            // 所以内容短的时候窗口依然很窄，"加宽"等于没发生。
            //
            // setMinimumWidth 才是把"展开 = 宽面板"这件事钉死的做法：
            // 内容短就留白，内容长就截断，宽度始终稳定 ——
            // 也不会因为新来一条长消息让整个浮窗突然跳宽。
            //
            // +dp(24) 是补 root 自身的左右 padding（12 × 2），
            // 让内容区正好是 W_MAX_DP。
            root.setMinimumWidth(clampWidth(W_MAX_DP) + dp(24));
            // 展开态：胶囊也放开到宽上限，否则标题仍被按 238 截断
            capsule.setMaxWidth(clampWidth(W_MAX_DP));
            if (actionRow != null) actionRow.setVisibility(View.VISIBLE);

            body.removeAllViews();
            if (!TextUtils.isEmpty(step)) {
                body.addView(line(step, 10.5f, Color.parseColor("#9FB4D8"), false));
            }

            int n = sessions == null ? 0 : sessions.length();
            if (n > 0) {
                body.addView(divider());
                body.addView(line("会话", 9.5f, Color.parseColor("#7B8497"), true));
                for (int i = 0; i < n && i < 4; i++) {
                    JSONObject s = sessions.getJSONObject(i);
                    body.addView(line(
                            "· " + s.optString("title", "会话") + " — " + s.optString("state", ""),
                            10.5f, Color.WHITE, false));
                }
            }

            int t = tasks == null ? 0 : tasks.length();
            if (t > 0) {
                body.addView(divider());
                body.addView(line("任务", 9.5f, Color.parseColor("#7B8497"), true));
                for (int i = 0; i < t && i < 3; i++) {
                    JSONObject tk = tasks.getJSONObject(i);
                    body.addView(line(
                            "▸ " + tk.optString("title", "任务")
                                    + (tk.has("progress") ? " · " + tk.optInt("progress") + "%" : ""),
                            10.5f, Color.WHITE, false));
                }
            }

            // ===== 最近消息 =====
            //
            // 这一段是「接消息」：把最近几条对话显示在悬浮窗里，
            // 便于在屏幕控制过程中瞄一眼 AI 说了什么。
            int m = messages == null ? 0 : messages.length();
            if (m > 0) {
                body.addView(divider());
                body.addView(line("消息", 9.5f, Color.parseColor("#7B8497"), true));
                for (int i = 0; i < m && i < 4; i++) {
                    JSONObject msg = messages.getJSONObject(i);
                    String who = "user".equals(msg.optString("role")) ? "你" : "DSH";
                    int c = "user".equals(msg.optString("role"))
                            ? Color.parseColor("#9FB4D8") : Color.WHITE;
                    body.addView(line(
                            who + "：" + msg.optString("text", ""),
                            10.5f, c, false));
                }
            }

            // ===== 快捷操作行状态 =====
            //
            // 行本身是 root 的直接子节点（不随 body 重建），
            // 这里只更新「停止」按钮的可点状态。
            if (stopBtn != null) {
                boolean running = o.optBoolean("running", false);
                stopBtn.setEnabled(running);
                stopBtn.setAlpha(running ? 1f : 0.4f);
            }
        } catch (Exception ignored) {
        }
    }

    private View divider() {
        View v = new View(this);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(1));
        lp.setMargins(dp(2), dp(5), dp(2), dp(5));
        v.setLayoutParams(lp);
        v.setBackgroundColor(Color.parseColor("#3A4356"));
        return v;
    }

    /** 把 WebView 推来的 look / event / badge 喂给小球；一次性事件按 cueSeq 去重。 */
    private void driveBot(JSONObject o) {
        if (ball == null) return;
        ball.setLook(o.optString("look", "idle"));
        String badge = o.has("badge") && !o.isNull("badge") ? o.optString("badge", "") : null;
        ball.setBadge(badge);
        int cueSeq = o.optInt("cueSeq", -1);
        if (cueSeq != lastCueSeq) {
            lastCueSeq = cueSeq;
            String event = o.has("event") && !o.isNull("event") ? o.optString("event", "") : null;
            if (event != null && !event.isEmpty()) ball.play(event);
        }
    }
}
