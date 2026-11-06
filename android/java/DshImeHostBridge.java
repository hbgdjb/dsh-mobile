package ai.deepseek.dsh.mobile;

import android.content.Context;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.util.List;

/**
 * 主应用侧的 IME 桥。
 *
 * ============ 为什么键盘页不能直接用这套 ============
 *
 * 键盘页和主应用是两个 WebView，各自有自己的 JS 上下文。
 * 键盘要的是"往目标输入框打字"，主应用要的是"收截图、加附件"。
 * 方向相反，所以两边各有一个桥，共用一个进程内状态（DshImeState）。
 *
 * ============ 这里只做三件事 ============
 *
 *   1. 把主应用的模型配置拍成快照，交给键盘读
 *   2. 把键盘截到的图收进来，作为聊天附件
 *   3. 报告输入法是否已启用/正在使用（设置页的状态卡片要用）
 */
public class DshImeHostBridge {

    private final Context ctx;

    public DshImeHostBridge(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    /* ---------------- 配置快照 ---------------- */

    /**
     * 主应用调：拍一份配置快照给键盘。
     *
     * 键盘不读主应用的 localStorage —— 那会加载第二份全量 state。
     */
    @JavascriptInterface
    public void setConfig(String json) {
        DshImeState.setConfig(ctx, json);
    }

    @JavascriptInterface
    public String getConfig() {
        return DshImeState.getConfig(ctx);
    }

    /**
     * 主应用页面跑起来了。
     *
     * 这一刻做两件事：标记"可以投递截图"，并把积压的截图补投。
     */
    @JavascriptInterface
    public void ready() {
        DshImeState.mainReady = true;
        drainShots();
    }

    /* ---------------- 截图 ---------------- */

    /**
     * 主应用调：键盘截的图到了。
     *
     * 页面侧再决定是"只加为附件"还是"直接发出去"。
     */
    @JavascriptInterface
    public void onShot(String recordJson) {
        try {
            DshImeState.toMain("window.__dshImeShot && window.__dshImeShot("
                    + JSONObject.quote(recordJson == null ? "{}" : recordJson) + ")");
        } catch (Exception ignored) {
        }
    }

    /** 主应用启动时调：把队列里积压的截图补投出来。 */
    @JavascriptInterface
    public void drainShots() {
        try {
            List<String> shots = DshImeState.drainShots(ctx);
            for (String s : shots) {
                DshImeState.toMain("window.__dshImeShot && window.__dshImeShot("
                        + JSONObject.quote(s) + ")");
            }
        } catch (Exception ignored) {
        }
    }

    /* ---------------- 状态 ---------------- */

    /**
     * 输入法状态：是否在系统里启用、是不是当前输入法。
     *
     * 设置页的状态卡片直接读这个，不用用户自己猜。
     */
    @JavascriptInterface
    public String status() {
        JSONObject o = new JSONObject();
        try {
            android.view.inputmethod.InputMethodManager imm =
                    (android.view.inputmethod.InputMethodManager)
                            ctx.getSystemService(Context.INPUT_METHOD_SERVICE);
            String id = ctx.getPackageName() + ".DshImeService";
            boolean enabled = false;
            boolean current = false;
            if (imm != null) {
                try {
                    String list = imm.getEnabledInputMethodList() == null ? ""
                            : String.valueOf(imm.getEnabledInputMethodList());
                    enabled = list.contains(id);
                } catch (Exception ignored) {
                }
                try {
                    current = id.equals(String.valueOf(imm.getCurrentInputMethodInfo().getId()));
                } catch (Exception ignored) {
                }
            }
            o.put("enabled", enabled);
            o.put("current", current);
            o.put("serviceId", id);
        } catch (Exception e) {
            try {
                o.put("error", String.valueOf(e.getMessage()));
            } catch (Exception ignored) {
            }
        }
        return o.toString();
    }

    /** 打开系统的输入法选择页，让用户启用/切换。 */
    @JavascriptInterface
    public void openImeSettings() {
        try {
            android.content.Intent i =
                    new android.content.Intent(android.provider.Settings.ACTION_INPUT_METHOD_SETTINGS);
            i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
        } catch (Exception ignored) {
        }
    }

    /** 切换到下一个输入法（用户已启用 DSH 键盘但当前不是它时用）。 */
    @JavascriptInterface
    public void switchIme() {
        try {
            android.view.inputmethod.InputMethodManager imm =
                    (android.view.inputmethod.InputMethodManager)
                            ctx.getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null) {
                imm.showInputMethodPicker();
            }
        } catch (Exception ignored) {
        }
    }

    /* ---------------- 短语与剪贴板 ---------------- */

    @JavascriptInterface
    public String listPhrases() {
        return DshImeState.listPhrases(ctx);
    }

    @JavascriptInterface
    public void savePhrase(String json) {
        DshImeState.savePhrase(ctx, json);
    }

    @JavascriptInterface
    public void deletePhrase(String id) {
        DshImeState.deletePhrase(ctx, id);
    }

    @JavascriptInterface
    public String listClipboard() {
        return DshImeState.listClips(ctx);
    }

    @JavascriptInterface
    public void clearClipboard() {
        DshImeState.clearClips(ctx);
    }
}
