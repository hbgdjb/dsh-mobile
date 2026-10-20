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
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * DSH 悬浮状态窗：在其他应用上方显示 Agent 状态。
 * 收缩态 = 一条可拖动的状态胶囊（左侧带 DSH 小球）；展开态 = 状态 + 多会话分框 + 任务步骤。
 * 数据来自 DshHudState（WebView 侧 DshHud.push 推送）。
 */
public class DshHudService extends Service {

    private WindowManager wm;
    private LinearLayout root;
    private LinearLayout body;
    private LinearLayout capRow;
    private TextView capsule;
    private DshBotView ball;
    private static int lastCueSeq = -1; // 一次性事件按 cueSeq 去重，避免折叠/展开/重建时重放
    private boolean collapsed = true;
    private int statusBarColor = Color.parseColor("#CC141821");
    private final Handler main = new Handler(Looper.getMainLooper());

    private final WindowManager.LayoutParams params = new WindowManager.LayoutParams(
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
        try {
            wm.removeView(root);
        } catch (Exception ignored) {
        }
        root = null;
        body = null;
        capRow = null;
        capsule = null;
        ball = null;
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

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
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
        // 点小球：打个招呼（不消费事件，拖动 / 伸缩仍由 root 处理）
        ball.setOnTouchListener((v, e) -> {
            if (e.getActionMasked() == MotionEvent.ACTION_DOWN) ball.greet();
            return false;
        });
        capsule = line("DSH · 空闲中", 12, Color.WHITE, true);
        capRow.addView(capsule);
        root.addView(capRow);

        body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        root.addView(body);

        // 拖动 + 点按伸缩
        root.setOnTouchListener(new View.OnTouchListener() {
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

            capsule.setText("DSH · " + statusText);
            driveBot(o);

            if (collapsed) {
                // 收缩态：只保留胶囊
                while (body.getChildCount() > 0) body.removeAllViews();
                return;
            }

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
