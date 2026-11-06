package ai.deepseek.dsh.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;

import org.json.JSONObject;

/**
 * 透明的引导 Activity —— 用来做两件必须由 Activity 发起的事：
 *
 *   ① 申请麦克风权限（语音输入）
 *   ② 发起 MediaProjection 授权（截图）
 *
 * ============ 为什么截图要绕一个 Activity ============
 *
 * MediaProjection 的授权对话框只能由 Activity 发起
 * （MediaProjectionManager.createScreenCaptureIntent 返回的 Intent
 *  必须用 startActivityForResult 拿结果）。
 *
 * 而 IME（InputMethodService）不是 Activity，发不了这个 Intent。
 * 所以必须有一个中转：一个透明的、没有界面的 Activity 替用户点这个授权。
 *
 * ============ 这个 Activity 必须由系统真正创建 ============
 *
 * 早期版本这里是错的：手工 `new DshImeActivity()` 之后直接
 * 在这个"野生"实例上调 startActivityForResult。
 * 那样做的后果是：
 *
 *   · Activity 从未经过 attach / attachBaseContext，window token 为空
 *   · startActivityForResult 依赖真实的 result 回调通道，
 *     野生实例根本收不到 onActivityResult
 *   · 系统还可能直接抛 ActivityNotFoundException / IllegalStateException
 *
 * 正确做法：用 Context.startActivity 真正启动它，让系统创建实例、
 * 走完生命周期，Activity 自己在 onCreate 里 startActivityForResult，
 * 结果自然回到自己的 onActivityResult。
 *
 * ============ 为什么它是"透明"的 ============
 *
 * 授权过程用户要能看到底下那个应用（"我要截的就是这个"）。
 * 如果这个 Activity 是白底不透明的，授权完一黑一白闪一下，
 * 体验非常差 —— 尤其在深色应用里。
 *
 * 所以：主题设为透明、无标题，并且在显示前就把 decorView 设成 INVISIBLE。
 */
public class DshImeActivity extends Activity {

    private static final int REQ_CAPTURE = 0x5A21;
    private static final int REQ_MIC = 0x5A22;

    /** 中转模式：截图授权。 */
    private static final String MODE_CAPTURE = "capture";
    /** 中转模式：麦克风权限。 */
    private static final String MODE_MIC = "mic";

    private static final String EXTRA_MODE = "dsh_mode";

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    /* ============================================================
       启动中转 Activity
       ============================================================ */

    /**
     * 发起截图授权。
     *
     * 调这个之前必须已经 requestHideSelf 过 ——
     * 否则授权对话框本身就是被截的一部分。
     */
    public static void startCapture(final Context ctx) {
        MAIN.post(() -> {
            try {
                MediaProjectionManager mpm =
                        (MediaProjectionManager) ctx.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
                if (mpm == null) {
                    failShot("这台设备不支持截图");
                    return;
                }
                Intent i = mpm.createScreenCaptureIntent();
                if (i == null) {
                    failShot("系统拒绝了截图授权");
                    return;
                }
                // 注意：这里只是把"授权 Intent"带过去，
                // 真正 startActivityForResult 必须由 Activity 自己做。
                launch(ctx, MODE_CAPTURE, i);
            } catch (Exception e) {
                failShot("无法发起截图授权：" + e.getMessage());
            }
        });
    }

    /**
     * 申请录音权限。
     *
     * 已授权就直接回调，不打扰用户。
     */
    public static void requestMic(final Context ctx) {
        MAIN.post(() -> {
            try {
                if (ctx.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                        == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    notifyMic(true);
                    return;
                }
                launch(ctx, MODE_MIC, null);
            } catch (Exception e) {
                notifyMic(false);
            }
        });
    }

    /** 真正启动中转 Activity（由系统创建、走完整生命周期）。 */
    private static void launch(Context ctx, String mode, Intent payload) {
        try {
            Intent go = new Intent(ctx, DshImeActivity.class);
            go.putExtra(EXTRA_MODE, mode);
            if (payload != null) go.putExtra("dsh_payload", payload);
            // 来自 IME Service 的 Context 不是 Activity，必须自己带 NEW_TASK
            go.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(go);
        } catch (Exception e) {
            if (MODE_CAPTURE.equals(mode)) failShot("无法打开截图授权页：" + e.getMessage());
            else notifyMic(false);
        }
    }

    /* ============================================================
       生命周期
       ============================================================ */

    private String mode;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 主题必须在 super.onCreate 之前设好，否则第一帧会闪白底。
        try {
            setTheme(android.R.style.Theme_Translucent_NoTitleBar);
        } catch (Exception ignored) {
        }
        super.onCreate(savedInstanceState);
        try {
            getWindow().setBackgroundDrawable(null);
        } catch (Exception ignored) {
        }
        try {
            mode = getIntent() == null ? null : getIntent().getStringExtra(EXTRA_MODE);
        } catch (Exception ignored) {
        }
        // 这个 Activity 只做中转，别让它出现在最近任务里。
        try {
            getWindow().setDimAmount(0f);
        } catch (Exception ignored) {
        }

        // 真正的 startActivityForResult 必须由 Activity 自己发起。
        if (MODE_CAPTURE.equals(mode)) {
            requestCapture();
        } else if (MODE_MIC.equals(mode)) {
            requestMicPermission();
        } else {
            finish();
        }
    }

    private void requestCapture() {
        try {
            MediaProjectionManager mpm =
                    (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            Intent i = null;
            try {
                Intent payload = getIntent() == null ? null : getIntent().getParcelableExtra("dsh_payload");
                i = payload != null ? payload : (mpm != null ? mpm.createScreenCaptureIntent() : null);
            } catch (Exception ignored) {
                i = null;
            }
            if (i == null) {
                if (mpm == null) {
                    failShot("这台设备不支持截图");
                } else {
                    failShot("系统拒绝了截图授权");
                }
                finish();
                return;
            }
            startActivityForResult(i, REQ_CAPTURE);
        } catch (Exception e) {
            failShot("无法发起截图授权：" + e.getMessage());
            finish();
        }
    }

    private void requestMicPermission() {
        try {
            requestPermissions(
                    new String[]{android.Manifest.permission.RECORD_AUDIO}, REQ_MIC);
        } catch (Exception e) {
            notifyMic(false);
            finish();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 这个 Activity 自己不显示任何东西 —— 立刻隐藏 decor。
        // 用 post 延迟一点，是为了让 onResume 走完再隐藏，
        // 避免某些 ROM 上出现一帧白屏。
        MAIN.postDelayed(() -> {
            try {
                getWindow().getDecorView().setVisibility(View.INVISIBLE);
            } catch (Exception ignored) {
            }
        }, 30);
    }

    /* ============================================================
       麦克风权限
       ============================================================ */

    private static void notifyMic(boolean granted) {
        DshImeState.toIme("window.__dshMicEvent && window.__dshMicEvent("
                + (granted ? "true" : "false") + ")");
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_MIC) return;
        boolean granted = grantResults.length > 0
                && grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED;
        notifyMic(granted);
        finish();
    }

    /* ============================================================
       截图授权结果
       ============================================================ */

    private static void failShot(String msg) {
        DshImeState.toIme("window.__dshShotEvent && window.__dshShotEvent("
                + jsonQuote("{\"ok\":false,\"error\":" + jsonQuote(msg) + "}") + ")");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        try {
            if (requestCode == REQ_CAPTURE) {
                if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                    DshCaptureService.start(this, resultCode, data);
                } else {
                    failShot("已取消截图");
                }
                finish();
            }
        } catch (Exception ignored) {
        }
    }

    private static String jsonQuote(String s) {
        try {
            return JSONObject.quote(s);
        } catch (Exception e) {
            return "\"\"";
        }
    }
}
