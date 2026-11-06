package ai.deepseek.dsh.mobile;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.Vibrator;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.ExtractedText;
import android.view.inputmethod.ExtractedTextRequest;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 键盘页唯一能看到的原生世界。
 *
 * ============ 为什么只有一个桥 ============
 *
 * 键盘页要做的原生动作分成三类（输入、配置/存储、语音），但它们的
 * 调用频率与失败模式完全不同。分成三个 @JavascriptInterface 对象会让
 * 页面里散落三个全局名；合成一个，页面只认 window.DshIme。
 *
 * 语音那部分用的是同一套方法名（start/stop/cancel/isAvailable…），
 * 所以这个对象会被同时注册成 window.DshSpeech —— 现成的 voice.js
 * 一行都不用改就能复用。
 *
 * ============ 线程 ============
 *
 * @JavascriptInterface 方法跑在 JavaBridge 线程，而 InputConnection
 * **必须**在主线程用。所以所有输入动作都 post 到主线程；
 * 需要返回值的（读上下文）用短超时 CountDownLatch 等主线程。
 */
public class DshImeBridge {

    private final DshImeService service;
    private final Context ctx;
    private final WebView webView;
    private final DshVoskEngine vosk;

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    /** 读上下文时最多等主线程这么久。正常是几毫秒，超时说明输入框已经没了。 */
    private static final long CTX_TIMEOUT_MS = 300;

    /** 退格的决策状态机（纯 Java，可单测，见 DshDelete）。 */
    private final DshDelete deleter;

    public DshImeBridge(DshImeService service, WebView webView) {
        this.service = service;
        this.ctx = service.getApplicationContext();
        this.webView = webView;
        this.vosk = new DshVoskEngine(ctx, webView);
        this.deleter = new DshDelete(new DshDelete.Target() {
            @Override
            public CharSequence before(int n) {
                InputConnection c = ic();
                return c == null ? null : safeBefore(c, n);
            }

            @Override
            public void request(int n) {
                InputConnection c = ic();
                if (c != null) requestDelete(c, n);
            }

            @Override
            public void key(int n) {
                InputConnection c = ic();
                if (c != null) pressDelete(c, n);
            }

            @Override
            public void compose(int n) {
                InputConnection c = ic();
                if (c != null) composeDelete(c, n);
            }
        }, (ms, r) -> MAIN.postDelayed(r, ms));
    }

    private InputConnection ic() {
        try {
            return service.getCurrentInputConnection();
        } catch (Exception e) {
            return null;
        }
    }

    private void post(Runnable r) {
        MAIN.post(r);
    }

    /* ============================================================
       输入动作
       ============================================================ */

    @JavascriptInterface
    public void commit(String text) {
        if (text == null) return;
        final String t = text;
        post(() -> {
            InputConnection c = ic();
            if (c == null) return;
            c.commitText(t, 1);
        });
    }

    /**
     * 退格。
     *
     * 决策（请求 → 校验 → 换路）在 DshDelete 里，这里只做一件
     * 只有 Android 才知道的事：**有选区时删选区本身**，
     * 这最符合直觉，也不该走那条校验链。
     */
    @JavascriptInterface
    public void deleteBackward(int count) {
        final int n = Math.max(1, Math.min(64, count));
        post(() -> {
            InputConnection c = ic();
            if (c == null) return;
            try {
                CharSequence sel = c.getSelectedText(0);
                if (sel != null && sel.length() > 0) {
                    c.commitText("", 1);
                    return;
                }
            } catch (Exception ignored) {
            }
            deleter.delete(n);
        });
    }

    private CharSequence safeBefore(InputConnection c, int n) {
        try {
            return c.getTextBeforeCursor(n, 0);
        } catch (Exception e) {
            return null;
        }
    }

    private void pressDelete(InputConnection c, int n) {
        for (int i = 0; i < n; i++) {
            try {
                c.sendKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DEL));
                c.sendKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DEL));
            } catch (Exception ignored) {
            }
        }
    }

    private void requestDelete(InputConnection c, int n) {
        // beginBatchEdit：部分输入框（尤其 WebView）在 batch 外
        // 不提交 deleteSurroundingText 的修改
        boolean batched = false;
        try {
            batched = c.beginBatchEdit();
        } catch (Exception ignored) {
        }
        try {
            boolean asked = false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                try {
                    // 码点版本：按 UTF-16 删会把 emoji 劈成两半
                    asked = c.deleteSurroundingTextInCodePoints(n, 0);
                } catch (Exception ignored) {
                }
            }
            if (!asked) {
                try {
                    c.deleteSurroundingText(n, 0);
                } catch (Exception ignored) {
                }
            }
        } finally {
            if (batched) {
                try {
                    c.endBatchEdit();
                } catch (Exception ignored) {
                }
            }
        }
    }

    /**
     * 最后一招：把光标前 n 个字符标成 composing 区，
     * 再提交空串把它覆盖掉。
     *
     * 只认 composing 的自绘输入框（某些国产 App 的编辑器）能被这条路救回来。
     *
     * 注意 setComposingRegion 要的是**整段文本的绝对下标**，不是"光标前几位"。
     * 所以必须先拿 ExtractedText 的 selectionStart，不能想当然地用长度减。
     */
    private void composeDelete(InputConnection c, int n) {
        try {
            ExtractedText et = c.getExtractedText(new ExtractedTextRequest(), 0);
            if (et == null || et.text == null) return;
            int end = et.selectionEnd;
            if (end <= 0) return;
            int start = Math.max(0, end - n);
            c.setComposingRegion(start, end);
            c.commitText("", 1);
        } catch (Exception ignored) {
        }
    }

    @JavascriptInterface
    public void moveCursor(String dir) {
        final boolean right = "right".equals(dir);
        post(() -> {
            InputConnection c = ic();
            if (c == null) return;
            int code = right ? KeyEvent.KEYCODE_DPAD_RIGHT : KeyEvent.KEYCODE_DPAD_LEFT;
            c.sendKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, code));
            c.sendKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, code));
        });
    }

    @JavascriptInterface
    public void editorAction() {
        post(() -> {
            try {
                service.sendDefaultEditorAction(true);
            } catch (Exception ignored) {
            }
        });
    }

    @JavascriptInterface
    public void vibrate() {
        try {
            Vibrator v = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null) v.vibrate(12);
        } catch (Exception ignored) {
        }
    }

    /**
     * 用改写结果替换原文。
     *
     * 有选区就直接覆盖；没有就选中"光标前 source 那么长的一段"再覆盖。
     *
     * ============ 为什么不再"先删后写" ============
     *
     * 先 deleteSurroundingText 再 commitText 是两步 —— 第一步在
     * WebView / 自绘输入框上可能静默失败，结果就是新文本被插到原文后面，
     * 变成"原文 + 改写"两段。而"选中区间 + commitText"是**一步覆盖**，
     * 输入框只要支持选区（几乎都支持），就一定能替换干净。
     */
    @JavascriptInterface
    public void replaceSelection(String text, String source) {
        final String t = text == null ? "" : text;
        final String src = source == null ? "" : source;
        post(() -> {
            InputConnection c = ic();
            if (c == null) return;
            try {
                CharSequence sel = c.getSelectedText(0);
                if (sel != null && sel.length() > 0) {
                    c.commitText(t, 1);
                    return;
                }
            } catch (Exception ignored) {
            }
            if (!src.isEmpty()) {
                int cp = src.codePointCount(0, src.length());
                // 选中要替换的那段，交给 commitText 一步覆盖
                if (selectBefore(c, cp)) {
                    c.commitText(t, 1);
                    return;
                }
                // 拿不到光标位置（输入框不支持 ExtractedText）才退回先删后写
                pressDelete(c, cp);
            }
            c.commitText(t, 1);
        });
    }

    /** 选中光标前 cp 个字符。成功返回 true。 */
    private boolean selectBefore(InputConnection c, int cp) {
        try {
            ExtractedText et = c.getExtractedText(new ExtractedTextRequest(), 0);
            if (et == null || et.text == null) return false;
            int end = et.selectionEnd;
            if (end <= 0) return false;
            int start = Math.max(0, end - cp);
            return c.setSelection(start, end);
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 读输入框上下文（同步）。
     *
     * 页面要拿它决定"AI 改写谁""能不能读"。返回 JSON：
     *   { selection, before, isPassword, multiline, hasSelection }
     */
    @JavascriptInterface
    public String getContext() {
        final String[] out = { "{}" };
        final CountDownLatch latch = new CountDownLatch(1);
        post(() -> {
            out[0] = buildContext();
            latch.countDown();
        });
        try {
            latch.await(CTX_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException ignored) {
        }
        return out[0];
    }

    /**
     * 主线程直接取上下文（不走 post/latch）。
     *
     * IME 侧推上下文时已经在主线程了，再走一次 latch 等自己
     * 就是死等 —— 所以这里单独留一个同步版本。
     */
    public String contextJson() {
        try {
            return buildContext();
        } catch (Exception e) {
            return "{}";
        }
    }

    private String buildContext() {
        JSONObject o = new JSONObject();
        try {
            InputConnection c = ic();
            EditorInfo ei = null;
            try {
                ei = service.getCurrentInputEditorInfo();
            } catch (Exception ignored) {
            }

            boolean password = isPasswordField(ei);
            o.put("isPassword", password);
            o.put("multiline", ei != null && (ei.inputType & InputType.TYPE_TEXT_FLAG_MULTI_LINE) != 0);
            o.put("inputType", ei == null ? "text" : typeName(ei.inputType));

            // 密码框一律不读内容 —— 这是硬边界，不是可选项
            if (password || c == null) {
                o.put("selection", "");
                o.put("before", "");
                o.put("hasSelection", false);
                return o.toString();
            }

            CharSequence sel = c.getSelectedText(0);
            String selText = sel == null ? "" : sel.toString();

            CharSequence before = c.getTextBeforeCursor(3000, 0);
            String beforeText = before == null ? "" : before.toString();

            o.put("selection", selText);
            o.put("before", beforeText);
            o.put("hasSelection", !selText.isEmpty());
        } catch (Exception e) {
            try {
                o.put("error", String.valueOf(e.getMessage()));
            } catch (Exception ignored) {
            }
        }
        return o.toString();
    }

    private boolean isPasswordField(EditorInfo ei) {
        if (ei == null) return false;
        int t = ei.inputType;
        int cls = t & InputType.TYPE_MASK_CLASS;
        int variation = t & InputType.TYPE_MASK_VARIATION;
        if (cls == InputType.TYPE_CLASS_TEXT) {
            if (variation == InputType.TYPE_TEXT_VARIATION_PASSWORD
                    || variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                    || variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD) {
                return true;
            }
        }
        if (cls == InputType.TYPE_CLASS_NUMBER) {
            if (variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD) return true;
        }
        // 输入框自己声明"别学习我的输入"时，也按敏感处理
        return (ei.imeOptions & EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING) != 0;
    }

    private String typeName(int inputType) {
        int cls = inputType & InputType.TYPE_MASK_CLASS;
        if (cls == InputType.TYPE_CLASS_NUMBER) return "number";
        if (cls == InputType.TYPE_CLASS_PHONE) return "phone";
        if (cls == InputType.TYPE_CLASS_DATETIME) return "datetime";
        if (cls == InputType.TYPE_CLASS_TEXT) return "text";
        return "other";
    }

    /* ============================================================
       配置与存储
       ============================================================ */

    @JavascriptInterface
    public String getConfig() {
        return DshImeState.getConfig(ctx);
    }

    /** 主应用调：把当前模型配置拍成快照存下来。 */
    @JavascriptInterface
    public void setConfig(String json) {
        DshImeState.setConfig(ctx, json);
    }

    /**
     * 读输入记忆（用户选过的词 + 权重）。
     *
     * 键盘每次启动都要拿它来给候选加权，所以走同步读 ——
     * 数据量小（几十个词），一次 SharedPreferences 读就够。
     */
    @JavascriptInterface
    public String getLearned() {
        return DshImeState.getLearned(ctx);
    }

    /** 写输入记忆。键盘侧做了防抖，不会每次都落盘。 */
    @JavascriptInterface
    public void setLearned(String json) {
        DshImeState.setLearned(ctx, json);
    }

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

    @JavascriptInterface
    public void copyToClipboard(String text) {
        try {
            ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("DSH", text == null ? "" : text));
        } catch (Exception ignored) {
        }
    }

    /* ============================================================
       键盘窗口
       ============================================================ */

    @JavascriptInterface
    public void ready() {
        post(() -> {
            if (service != null) service.onKeyboardReady();
        });
    }

    /**
     * 切到下一个输入法 —— 必须留一条能回到系统输入法的路。
     *
     * 用户装了别的输入法却切不过去，键盘就成了唯一选择，
     * 那等于把用户锁死在自己的键盘里。所以这个按钮必须有。
     *
     * API 28+ 走 InputMethodService.switchToNextInputMethod；
     * 更老的系统没有这个公开 API（getCurrentInputBindingToken 是 @hide，
     * InputBinding.getToken() 要 API 31），退回弹出输入法选择器 ——
     * 效果一样，只是多一步。
     */
    @JavascriptInterface
    public void switchIme() {
        post(() -> {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    service.switchToNextInputMethod(false);
                    return;
                }
                InputMethodManager imm =
                        (InputMethodManager) ctx.getSystemService(Context.INPUT_METHOD_SERVICE);
                if (imm != null) {
                    try {
                        imm.showInputMethodPicker();
                    } catch (Exception ignored) {
                    }
                }
            } catch (Exception ignored) {
            }
        });
    }

    @JavascriptInterface
    public void captureScreen() {
        post(() -> service.startCapture());
    }

    /* ============================================================
       语音（同一个对象注册成 window.DshSpeech）
       ============================================================ */

    @JavascriptInterface
    public boolean isAvailable() {
        return true; // 本地 Vosk 引擎随应用安装，不依赖系统语音服务
    }

    @JavascriptInterface
    public boolean hasPermission() {
        try {
            return ctx.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
        } catch (Exception e) {
            return false;
        }
    }

    @JavascriptInterface
    public void requestPermission() {
        post(() -> DshImeActivity.requestMic(ctx));
    }

    @JavascriptInterface
    public void start(String language) {
        post(() -> {
            if (!hasPermission()) {
                DshImeActivity.requestMic(ctx);
                DshImeState.toIme("window.__dshSpeechEvent && window.__dshSpeechEvent("
                        + jsonQuote("{\"type\":\"error\",\"message\":\"需要麦克风权限\"}") + ")");
                return;
            }
            vosk.prepare(
                    () -> vosk.start(),
                    () -> DshImeState.toIme("window.__dshSpeechEvent && window.__dshSpeechEvent("
                            + jsonQuote("{\"type\":\"error\",\"message\":\"语音模型还没准备好\"}") + ")")
            );
        });
    }

    @JavascriptInterface
    public void stop() {
        post(() -> vosk.stop());
    }

    @JavascriptInterface
    public void cancel() {
        post(() -> vosk.cancel());
    }

    @JavascriptInterface
    public String diagnose() {
        try {
            return vosk.diagnose();
        } catch (Exception e) {
            return "{\"native\":true,\"available\":false,\"error\":\"" + e.getMessage() + "\"}";
        }
    }

    @JavascriptInterface
    public void downloadModel() {
        post(() -> vosk.downloadModel(
                () -> DshImeState.toIme("window.__dshSpeechEvent && window.__dshSpeechEvent("
                        + jsonQuote("{\"type\":\"download\",\"pct\":100,\"state\":\"done\"}") + ")"),
                () -> DshImeState.toIme("window.__dshSpeechEvent && window.__dshSpeechEvent("
                        + jsonQuote("{\"type\":\"error\",\"message\":\"模型下载失败\"}") + ")")
        ));
    }

    /** 把任意字符串安全地塞进 evaluateJavascript 的字符串字面量。 */
    private static String jsonQuote(String s) {
        try {
            return JSONObject.quote(s);
        } catch (Exception e) {
            return "\"\"";
        }
    }
}
