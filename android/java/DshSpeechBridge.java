package ai.deepseek.dsh.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 原生语音识别桥。
 *
 * ============ 为什么要写这一层 ============
 *
 * 之前的语音输入直接用 Web Speech API：
 *
 *     const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
 *     if (!SR) { toast("此设备不支持语音输入", "err"); return; }
 *
 * 问题在于 **Android WebView 里这两个对象都不存在**。
 * Web Speech API 的语音识别是 Chrome 浏览器自带的能力（依赖 Google 语音服务），
 * WebView 并不实现它 —— 桌面 Chromium 里有，手机 WebView 里没有。
 * 于是这个功能在 APK 里从来就没成功过：一点麦克风就弹「此设备不支持语音输入」。
 *
 * 另外还有第二个坑：manifest 里从来没有声明 RECORD_AUDIO。
 * 即使哪天 WebView 支持了，没有这个权限也开不了麦。
 *
 * 所以这里改用 Android 原生的 SpeechRecognizer：
 *   - 走系统/厂商的语音服务，不依赖 WebView
 *   - 支持 partial results，说话过程中就能看到文字在长
 *   - 支持 rmsChanged，可以画音量反馈
 *
 * ============ 与 JS 的协议 ============
 *
 *  JS -> 原生：
 *    start(lang)        开始识别（会自动申请录音权限）
 *    stop()             正常结束，等最终结果
 *    cancel()           立刻取消，不要结果
 *    isAvailable()      是否有可用的语音识别服务
 *    hasPermission()    是否已授予录音权限
 *    requestPermission()只用申请权限（供设置页的"授权"按钮）
 *
 *  原生 -> JS（window.__dshSpeechEvent，单参数 JSON）：
 *    {type:"ready"}                    识别器就绪，已开始收音
 *    {type:"partial", text:"..."}      中间结果（会用最新一条覆盖）
 *    {type:"final", text:"..."}        最终结果
 *    {type:"volume", rms:0..10}        音量（0 静音）
 *    {type:"error", code:"...", message:"..."}
 *    {type:"end", reason:"stop|silence|error"}
 *    {type:"permission", granted:true/false}
 *
 * ============ 生命周期上的几个必须 ============
 *
 * 1. SpeechRecognizer **只能在主线程创建和调用**，否则直接抛
 *    "SpeechRecognizer should be used only from the main thread"。
 * 2. 每次 startListening 前要 cancel() 上一次，否则会 ERROR_RECOGNIZER_BUSY。
 * 3. 识别结束（无论成功失败）都要 destroy() —— 不销毁会一直占着麦克风，
 *    下次进来起不来。
 * 4. onResults 之后系统自己会断，不需要我们再调 stop()。
 */
public class DshSpeechBridge {

    private final Activity activity;
    private final WebView webView;
    private final Handler main = new Handler(Looper.getMainLooper());

    /** 权限请求的 requestCode，MainActivity 收到结果后转给这里。 */
    static final int REQ_AUDIO = 0x5A21;

    /** 正在等待权限结果时，记住调用方想干什么（start 还是单纯申请）。 */
    private static DshSpeechBridge awaitingPermission;

    private SpeechRecognizer recognizer;
    private boolean listening = false;
    private String lang = "zh-CN";
    /** 本次用的是不是离线识别器（用于诊断与提示语）。 */
    private boolean onDevice = false;

    /** 本次会话是否已经给过 final —— 防止 onResults 与 onError 双触发导致重复插入。 */
    private boolean delivered = false;

    /** 内置的本地引擎（Vosk）。系统只有云端、且云端不通时用它兜底。 */
    private final DshVoskEngine vosk;

    /** 本次实际用的引擎：system-ondevice / vosk / system-cloud。 */
    private String engineUsed = "";

    /**
     * 启动代次。
     *
     * 模型首次加载要几秒，期间用户完全可能点「停止」——
     * 如果那个异步回调不认代次，加载完成后会把录音**又开起来**，
     * 表现为"点了停止，过几秒它自己开始听"。
     */
    private volatile int startToken = 0;

    public DshSpeechBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        this.vosk = new DshVoskEngine(activity, webView);
    }

    /* ---------------- 能力探测 ---------------- */

    @JavascriptInterface
    public boolean isAvailable() {
        try {
            return SpeechRecognizer.isRecognitionAvailable(activity);
        } catch (Exception e) {
            return false;
        }
    }

    @JavascriptInterface
    public boolean hasPermission() {
        try {
            return activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                    == PackageManager.PERMISSION_GRANTED;
        } catch (Exception e) {
            return false;
        }
    }

    @JavascriptInterface
    public void requestPermission() {
        main.post(() -> ensurePermission(false));
    }

    /**
     * 语音识别的自检报告。
     *
     * ============ 为什么需要它 ============
     *
     * 「语音用不了」有四种完全不同的原因，对外表现却都是"没反应"：
     *
     *   1. 设备上根本没有语音识别服务（国产 ROM 常见：Google 的被移除，
     *      厂商自家服务不一定注册 RecognitionService）；
     *   2. 有服务，但没有装中文语言包；
     *   3. 录音权限被拒（尤其是勾了"不再询问"之后，系统不再弹窗）；
     *   4. 服务在，但启动后立刻报错（被其他应用占着麦克风等）。
     *
     * 前三种在界面上长得一模一样，用户只能描述成"语音有问题"。
     * 这个接口把判据直接摊开，界面上一眼能看出缺哪一项。
     *
     * 返回：
     *   available   系统认为有没有识别服务
     *   permission  录音权限
     *   services    实际能查到的识别服务包名（空数组 = 真的没有）
     *   api         Android API 级别（包可见性规则从 30 起变严）
     */
    /**
     * 下载离线语音模型（42 MB）。
     *
     * 进度通过 `{type:"download", pct}` 事件推给界面，
     * 完成/失败同样走事件 —— JS 那边只要订阅一次就够。
     */
    @JavascriptInterface
    public void downloadModel() {
        main.post(() -> vosk.downloadModel(
                () -> emit("{\"type\":\"download\",\"pct\":100,\"state\":\"done\"}"),
                null
        ));
    }

    @JavascriptInterface
    public String diagnose() {
        JSONObject o = new JSONObject();
        try {
            o.put("available", isAvailable());
            o.put("permission", hasPermission());
            o.put("api", Build.VERSION.SDK_INT);
            boolean off = false;
            if (Build.VERSION.SDK_INT >= 31) {
                try {
                    off = SpeechRecognizer.isOnDeviceRecognitionAvailable(activity);
                } catch (Throwable ignored) {
                }
            }
            o.put("onDevice", off);
            // 内置引擎状态：这是"云端连不通"时的实际出路
            o.put("builtin", vosk.isReady());
            o.put("modelInstalled", vosk.modelInstalled());
            o.put("modelBundled", vosk.modelBundled());
            o.put("preferBuiltin", preferBuiltIn());

            JSONArray services = new JSONArray();
            try {
                Intent probe = new Intent("android.speech.RecognitionService");
                List<ResolveInfo> list =
                        activity.getPackageManager().queryIntentServices(probe, 0);
                if (list != null) {
                    for (ResolveInfo ri : list) {
                        if (ri != null && ri.serviceInfo != null
                                && ri.serviceInfo.packageName != null) {
                            services.put(ri.serviceInfo.packageName);
                        }
                    }
                }
            } catch (Exception ignored) {
                // 查不到就当没有 —— 这一项本来就是"能不能看到服务"
            }
            o.put("services", services);
            o.put("serviceCount", services.length());
        } catch (Exception e) {
            try {
                o.put("error", String.valueOf(e.getMessage()));
            } catch (Exception ignored) {
            }
        }
        return o.toString();
    }

    /* ---------------- 识别控制 ---------------- */

    @JavascriptInterface
    public void start(final String language) {
        this.lang = (language == null || language.isEmpty()) ? "zh-CN" : language;
        main.post(() -> {
            if (!ensurePermission(true)) return;
            if (preferBuiltIn()) {
                startBuiltIn();
            } else {
                beginListening();
            }
        });
    }

    /**
     * 该用内置引擎还是系统识别。
     *
     * ============ 判断顺序 ============
     *
     * 1. 系统**有本地识别**（Android 12+ 且装了离线语音包）→ 用系统。
     *    Google 的离线模型质量比 Vosk 小模型好，没有理由不用。
     *
     * 2. 否则 → 用内置的 Vosk。
     *
     *    这一步是有意的：系统剩下的唯一路径是**云端**，而国内绝大多数设备上
     *    那条路是断的（错误码 11）。与其让用户点一次失败一次，
     *    不如直接用能工作的那一个。
     *
     *    代价是准确率下降 —— 这个取舍在 README 里写清楚了，
     *    设置页也会显示当前用的是哪个引擎。
     */
    private boolean preferBuiltIn() {
        if (Build.VERSION.SDK_INT >= 31) {
            try {
                if (SpeechRecognizer.isOnDeviceRecognitionAvailable(activity)) return false;
            } catch (Throwable ignored) {
            }
        }
        return true;
    }

    /** 走内置引擎。首次要把模型从 assets 解出来，可能几秒。 */
    private void startBuiltIn() {
        engineUsed = "vosk";
        if (!vosk.isReady()) {
            // 首次准备：告诉界面在干什么，否则用户盯着"正在听"以为坏了
            emit("{\"type\":\"preparing\"}");
        }
        vosk.prepare(
                () -> {
                    engineUsed = "vosk";
                    vosk.start();
                },
                () -> {
                    // 内置引擎起不来（模型缺失等）：回退系统，至少还有一条路
                    engineUsed = "system-cloud";
                    beginListening();
                }
        );
    }

    @JavascriptInterface
    public void stop() {
        main.post(() -> {
            if ("vosk".equals(engineUsed)) {
                engineUsed = "";
                vosk.stop();
                return;
            }
            if (recognizer == null) {
                emitEnd("stop");
                return;
            }
            try {
                // stopListening 表示"说完了，给结果吧"
                recognizer.stopListening();
            } catch (Exception e) {
                cleanup();
                emitEnd("stop");
            }
        });
    }

    @JavascriptInterface
    public void cancel() {
        main.post(() -> {
            if ("vosk".equals(engineUsed)) {
                engineUsed = "";
                vosk.cancel();
                return;
            }
            delivered = true;
            if (recognizer != null) {
                try {
                    recognizer.cancel();
                } catch (Exception ignored) {
                }
            }
            cleanup();
            emitEnd("cancel");
        });
    }

    /* ---------------- 权限 ---------------- */

    /**
     * @param thenStart true 表示用户点了麦克风（拿到权限后要立刻开始识别）
     * @return 当前是否已经可以往下走
     */
    private boolean ensurePermission(boolean thenStart) {
        if (hasPermission()) return true;
        awaitingPermission = this;
        this.pendingStart = thenStart;
        try {
            activity.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
        } catch (Exception e) {
            emitError("permission", "无法申请录音权限：" + e.getMessage());
            emitEnd("error");
            return false;
        }
        return false;
    }

    /** 等权限结果期间记住要不要自动开始。 */
    private boolean pendingStart = false;

    /**
     * MainActivity.onRequestPermissionsResult 转进来。
     * @return 是否已处理
     */
    public static boolean handlePermissionResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode != REQ_AUDIO) return false;
        DshSpeechBridge b = awaitingPermission;
        awaitingPermission = null;
        if (b == null) return true;

        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        b.emit("{\"type\":\"permission\",\"granted\":" + granted + "}");
        if (!granted) {
            b.emitError("permission",
                    "没有麦克风权限。到「设置 → 应用 → DSH → 权限 → 麦克风」里允许后再试。");
            b.emitEnd("error");
            return true;
        }
        if (b.pendingStart) {
            b.pendingStart = false;
            b.beginListening();
        }
        return true;
    }

    /* ---------------- 识别器 ---------------- */

    /**
     * 挑一个能用的识别器：**优先离线，其次在线**。
     *
     * ============ 为什么要优先离线 ============
     *
     * `SpeechRecognizer.createSpeechRecognizer()` 拿到的是系统默认实现，
     * 绝大多数设备上它走**云端**识别 —— 音频传到厂商/Google 的服务器，
     * 结果再传回来。
     *
     * 这条链路在国内经常是断的：
     *   · Google 语音服务被移除或不可达；
     *   · 厂商的识别云服务需要登录自家账号；
     *   · 网络环境不通（尤其是开着代理时，语音服务的 UDP/长连接容易被打断）。
     *
     * 表现就是错误码 11（ERROR_SERVER_DISCONNECTED）：
     * **权限没问题、麦克风也开起来了、就是拿不到结果。**
     *
     * Android 12（API 31）起提供了 `createOnDeviceSpeechRecognizer()`，
     * 完全本地识别，不走网络。设备装了离线语音包就能用。
     *
     * 所以顺序是：设备支持离线 → 用离线；否则回退在线。
     * 这不是"更好"，是"在很多设备上这是唯一能工作的路径"。
     */
    private SpeechRecognizer createBestRecognizer() {
        if (Build.VERSION.SDK_INT >= 31) {
            try {
                if (SpeechRecognizer.isOnDeviceRecognitionAvailable(activity)) {
                    onDevice = true;
                    return SpeechRecognizer.createOnDeviceSpeechRecognizer(activity);
                }
            } catch (Throwable ignored) {
                // 部分 ROM 声明了 API 但实现为空，回退在线
            }
        }
        onDevice = false;
        return SpeechRecognizer.createSpeechRecognizer(activity);
    }

    private void beginListening() {
        // 上一次可能还没彻底结束：先拆干净再建，避免 RECOGNIZER_BUSY
        destroyRecognizer();
        delivered = false;

        try {
            recognizer = createBestRecognizer();
        } catch (Exception e) {
            emitError("init", "语音识别器启动失败：" + e.getMessage());
            emitEnd("error");
            return;
        }

        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override
            public void onReadyForSpeech(Bundle params) {
                listening = true;
                emit("{\"type\":\"ready\"}");
            }

            @Override
            public void onBeginningOfSpeech() {
                // 用户开口了，给个音量起点
                emit("{\"type\":\"volume\",\"rms\":0}");
            }

            @Override
            public void onRmsChanged(float rmsdB) {
                // rmsdB 大致落在 -2 ~ 10 之间，静音时约为 0 或负值。
                // 归一化到 0..10 给 UI 画音量条。
                int level = Math.round(Math.max(0f, Math.min(10f, rmsdB)));
                emit("{\"type\":\"volume\",\"rms\":" + level + "}");
            }

            @Override
            public void onBufferReceived(byte[] buffer) {
                // 不需要原始音频
            }

            @Override
            public void onEndOfSpeech() {
                listening = false;
                // 系统在 onEndOfSpeech 之后会自己给 onResults，这里不主动停
            }

            @Override
            public void onError(int error) {
                listening = false;
                String code = codeOf(error);
                // NO_MATCH / SPEECH_TIMEOUT 在实际使用里经常是「用户还没开口就超时」，
                // 不该当成错误弹红字，交给 JS 决定怎么提示。
                emitError(code, messageOf(error));
                cleanup();
                emitEnd("error");
            }

            @Override
            public void onResults(Bundle results) {
                listening = false;
                if (delivered) {
                    cleanup();
                    return;
                }
                delivered = true;
                String text = firstResult(results);
                emit("{\"type\":\"final\",\"text\":" + JSONObject.quote(text) + "}");
                cleanup();
                emitEnd("silence");
            }

            @Override
            public void onPartialResults(Bundle partialResults) {
                if (delivered) return;
                String text = firstResult(partialResults);
                if (!text.isEmpty()) {
                    emit("{\"type\":\"partial\",\"text\":" + JSONObject.quote(text) + "}");
                }
            }

            @Override
            public void onEvent(int eventType, Bundle params) {
            }
        });

        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang);
        intent.putExtra(RecognizerIntent.EXTRA_ONLY_RETURN_LANGUAGE_PREFERENCE, false);
        // partial results 是体验的关键：说话过程中就能看到字在长，
        // 用户才知道「它在听」，而不是对着一片空白怀疑坏了。
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        // 即使拿到的是在线识别器，也告诉它"优先用本地引擎"——
        // 部分实现会在此标志下切到设备端，避免走那条断掉的云端链路。
        intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        // 关掉"说完自动停"之外的静音判断：默认 1.5s 就断，中文长句容易被截断。
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2000L);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 1200L);

        try {
            recognizer.startListening(intent);
        } catch (Exception e) {
            emitError("start", "无法启动语音识别：" + e.getMessage());
            cleanup();
            emitEnd("error");
        }
    }

    private String firstResult(Bundle bundle) {
        if (bundle == null) return "";
        ArrayList<String> list = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (list == null || list.isEmpty()) return "";
        String s = list.get(0);
        return s == null ? "" : s.trim();
    }

    private void cleanup() {
        listening = false;
        destroyRecognizer();
    }

    private void destroyRecognizer() {
        if (recognizer == null) return;
        try {
            recognizer.cancel();
        } catch (Exception ignored) {
        }
        try {
            recognizer.destroy();
        } catch (Exception ignored) {
        }
        recognizer = null;
    }

    /* ---------------- 错误码翻译 ---------------- */

    private static String codeOf(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_AUDIO:
                return "audio";
            case SpeechRecognizer.ERROR_CLIENT:
                return "client";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "permission";
            case SpeechRecognizer.ERROR_NETWORK:
                return "network";
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "network_timeout";
            case SpeechRecognizer.ERROR_NO_MATCH:
                return "no_match";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "busy";
            case SpeechRecognizer.ERROR_SERVER:
                return "server";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "speech_timeout";
            // 下面这几个常量要 API 31 才有，用数字写避免编译期兼容问题。
            // 它们恰恰是"权限正常但用不了"最常见的三种原因。
            case 10: // ERROR_TOO_MANY_REQUESTS
                return "too_many_requests";
            case 11: // ERROR_SERVER_DISCONNECTED
                return "server_disconnected";
            case 12: // ERROR_LANGUAGE_NOT_SUPPORTED
                return "language_not_supported";
            case 13: // ERROR_LANGUAGE_UNAVAILABLE
                return "language_unavailable";
            default:
                return "unknown_" + error;
        }
    }

    private static String messageOf(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_AUDIO:
                return "录音出错了（麦克风可能被别的应用占用）";
            case SpeechRecognizer.ERROR_CLIENT:
                return "识别客户端异常，请重试";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "缺少麦克风权限";
            case SpeechRecognizer.ERROR_NETWORK:
                return "语音服务需要联网，当前网络不通";
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "语音服务连接超时";
            case SpeechRecognizer.ERROR_NO_MATCH:
                return "没听清，再说一次";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "识别器忙，请稍后再试";
            case SpeechRecognizer.ERROR_SERVER:
                return "语音服务返回错误";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "没有检测到说话";
            case 10:
                return "语音服务被调用太频繁，请稍后再试";
            case 11:
                // 这条最常见。toast 放不下长文案，说清"是什么"就够了，
                // 详细原因与出路放在 设置 → 语音输入 的自检里。
                return "连不上语音识别服务（11）· 详见 设置 → 语音输入";
            case 12:
                return "语音服务不支持中文，需要安装中文语音包";
            case 13:
                return "中文语音包不可用，请在系统设置里下载";
            default:
                return "语音识别失败（错误码 " + error + "）";
        }
    }

    /* ---------------- 回传 JS ---------------- */

    private void emit(String json) {
        final String js = "(function(){try{window.__dshSpeechEvent&&window.__dshSpeechEvent(" + json + ");}catch(e){}})();";
        main.post(() -> {
            try {
                webView.evaluateJavascript(js, null);
            } catch (Exception ignored) {
            }
        });
    }

    private void emitError(String code, String message) {
        emit("{\"type\":\"error\",\"code\":" + JSONObject.quote(code)
                + ",\"message\":" + JSONObject.quote(message) + "}");
    }

    private void emitEnd(String reason) {
        emit("{\"type\":\"end\",\"reason\":" + JSONObject.quote(reason) + "}");
    }
}
