package ai.deepseek.dsh.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 输入法与主应用之间的唯一通道。
 *
 * ============ 为什么用静态字段而不是 IPC ============
 *
 * IME 和 MainActivity 跑在**同一个进程**（manifest 里都没写 android:process）。
 * 这不是随便选的：
 *
 *   · Android 9+ 禁止两个进程共用同一个 WebView 数据目录，分开会直接崩
 *   · 同进程才能让键盘页和主页面同源（都是 https://localhost）
 *   · 同进程才能共享 localStorage
 *
 * 所以这里不需要 AIDL / 广播，一个静态引用就是最快的通道。
 *
 * ============ 存什么 ============
 *
 *   config       模型配置快照（键盘读，主应用写）
 *   phrases      快捷短语
 *   clips        剪贴板历史
 *   shots        待投递的截图队列（主应用没起来时先存着）
 *
 * 全部放在独立的 dsh_ime prefs 里，不碰主应用的 localStorage ——
 * 两套 state 各自落盘，谁也不会覆盖谁。
 */
public final class DshImeState {

    private static final String PREF = "dsh_ime";
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    /** 键盘页的 WebView（IME 创建，销毁时置空）。 */
    public static volatile WebView imeWebView;

    /** 主应用的 WebView（MainActivity 挂载，销毁时置空）。 */
    public static volatile WebView mainWebView;

    /** 主应用页面是否已经跑起来并能接截图。 */
    public static volatile boolean mainReady;

    private DshImeState() {
    }

    static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    /* ---------------- 模型配置快照 ---------------- */

    public static void setConfig(Context c, String json) {
        prefs(c).edit().putString("config", json == null ? "{}" : json).apply();
    }

    public static String getConfig(Context c) {
        return prefs(c).getString("config", "{}");
    }

    /* ---------------- 输入记忆 ---------------- */

    /**
     * 用户选过的词及其权重。
     *
     * 单独存一个键，不塞进 config —— config 是主应用写的模型配置快照，
     * 主应用一保存就会整块覆盖，学习记录会被顺手抹掉。
     */
    public static String getLearned(Context c) {
        return prefs(c).getString("learned", "{}");
    }

    public static void setLearned(Context c, String json) {
        prefs(c).edit().putString("learned", json == null ? "{}" : json).apply();
    }

    /* ---------------- 截图 ---------------- */

    /**
     * 存一条待投递的截图。
     *
     * 主应用没在前台时，用户截的图不能凭空消失 ——
     * 先存队列，等下次主应用 ready 时补投。
     * 上限 10 条：再多就是没人消费，存着只会占空间。
     */
    public static void queueShot(Context c, String recordJson) {
        try {
            JSONArray arr = new JSONArray(prefs(c).getString("shots", "[]"));
            JSONArray next = new JSONArray();
            next.put(recordJson);
            for (int i = 0; i < arr.length() && i < 9; i++) next.put(arr.optString(i));
            prefs(c).edit().putString("shots", next.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    /** 取出并清空队列。 */
    public static List<String> drainShots(Context c) {
        List<String> out = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(prefs(c).getString("shots", "[]"));
            for (int i = 0; i < arr.length(); i++) {
                String s = arr.optString(i);
                if (s != null && !s.isEmpty()) out.add(s);
            }
        } catch (Exception ignored) {
        }
        prefs(c).edit().putString("shots", "[]").apply();
        return out;
    }

    /* ---------------- 快捷短语 ---------------- */

    public static String listPhrases(Context c) {
        return prefs(c).getString("phrases", "[]");
    }

    /** 新增或更新一条短语（按 id 覆盖）。 */
    public static void savePhrase(Context c, String json) {
        try {
            JSONObject item = new JSONObject(json);
            String id = item.optString("id", "");
            if (id.isEmpty()) {
                id = "p" + System.currentTimeMillis();
                item.put("id", id);
            }
            JSONArray arr = new JSONArray(listPhrases(c));
            JSONArray next = new JSONArray();
            boolean replaced = false;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o != null && id.equals(o.optString("id"))) {
                    next.put(item);
                    replaced = true;
                } else if (o != null) {
                    next.put(o);
                }
            }
            if (!replaced) next.put(item);
            prefs(c).edit().putString("phrases", next.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    public static void deletePhrase(Context c, String id) {
        try {
            JSONArray arr = new JSONArray(listPhrases(c));
            JSONArray next = new JSONArray();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o != null && !id.equals(o.optString("id"))) next.put(o);
            }
            prefs(c).edit().putString("phrases", next.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    /* ---------------- 剪贴板历史 ---------------- */

    public static String listClips(Context c) {
        return prefs(c).getString("clips", "[]");
    }

    /**
     * 记一条剪贴板文本。
     *
     * 连续相同的跳过（复制两次同一段很常见），上限 30 条。
     */
    public static void addClip(Context c, String text) {
        String t = text == null ? "" : text.trim();
        if (t.isEmpty() || t.length() > 20000) return;
        try {
            JSONArray arr = new JSONArray(listClips(c));
            if (arr.length() > 0 && t.equals(arr.optString(0))) return;
            JSONArray next = new JSONArray();
            next.put(t);
            for (int i = 0; i < arr.length() && i < 29; i++) {
                String s = arr.optString(i);
                if (!t.equals(s)) next.put(s);
            }
            prefs(c).edit().putString("clips", next.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    public static void clearClips(Context c) {
        prefs(c).edit().putString("clips", "[]").apply();
    }

    /* ---------------- 推送 ---------------- */

    /**
     * 往某个 WebView 里跑一段 JS。
     *
     * 必须 post 到主线程：WebView 的方法只能在创建它的线程调用。
     */
    public static void eval(WebView wv, String js) {
        if (wv == null || js == null) return;
        MAIN.post(() -> {
            try {
                wv.evaluateJavascript(js, null);
            } catch (Exception ignored) {
            }
        });
    }

    /** 推给键盘页。 */
    public static void toIme(String js) {
        eval(imeWebView, js);
    }

    /** 推给主应用页面。 */
    public static void toMain(String js) {
        if (!mainReady) return;
        eval(mainWebView, js);
    }
}
