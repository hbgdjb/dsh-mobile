package ai.deepseek.dsh.mobile;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

/**
 * 后台保活相关的原生能力。
 *
 * 背景：用户反馈"切到后台任务就会自动停止"。追下来发现**不是权限不够**，
 * 而是三处机制没接上：
 *
 * 1) **WebView 渲染进程被降级回收**（主因）。
 *    Android 8.0 起 WebView 跑在独立进程里。当 WebView 不可见时，系统会按
 *    "waivedWhenNotVisible" 把渲染进程降级到 RENDERER_PRIORITY_WAIVED——
 *    内存紧张时第一个被回收的就是它。渲染进程一死，WebView 的 JS 上下文
 *    全部丢失，Agent 正在跑的流式请求、AbortController、增量 patch 全部归零。
 *    应用侧表现为"切后台几秒后回来发现任务中断了"。
 *    解法：setRendererPriorityPolicy(RENDERER_PRIORITY_IMPORTANT, false)
 *    —— 第二个参数 false 表示"不可见时也不放弃渲染进程"。
 *    注意：官方文档明确要求同时正确实现 onRenderProcessGone，
 *    否则渲染进程被杀时宿主进程也会跟着崩。MainActivity 已经做了。
 *
 * 2) **CPU 休眠打断流式读取**。
 *    屏幕关掉、进入后台几分钟后 CPU 进入休眠，SSE 的 socket 读事件不再投递，
 *    表现为"任务卡在某一动不动"。解法：保活服务持 PARTIAL_WAKE_LOCK。
 *
 * 3) **电池优化 / 国产 ROM 省电策略**。
 *    这是最后一层，也是最难绕过的。Android 的 Doze 会限制后台网络与唤醒，
 *    MIUI / ColorOS / EMUI / OriginOS 更是各有各的"后台管理""自启动"开关。
 *    应用无法自行绕过，但可以：
 *      - 检测自己是否在电池优化白名单里（isIgnoringBatteryOptimizations）
 *      - 弹系统面板请用户加白名单（ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS）
 *      - 识别常见厂商，跳到它们各自的后台管理页
 *
 * 这个桥把这三件事的"能力探测"和"引导入口"暴露给 JS，
 * 具体界面在「设置 → 通知与网络 → 后台保活」。
 */
public class DshPowerBridge {

    private final Context ctx;

    public DshPowerBridge(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    /* ---------------- 1. WebView 渲染进程保活 ---------------- */

    /**
     * 调整 WebView 渲染进程优先级策略。
     *
     * keepAlive=true 时请求 RENDERER_PRIORITY_IMPORTANT 且 waivedWhenNotVisible=false，
     * 即"不可见也不降级"——这是让 Agent 任务能在后台继续跑的关键一步。
     */
    @JavascriptInterface
    public void setRendererKeepAlive(WebView webView, boolean keepAlive) {
        if (webView == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                webView.setRendererPriorityPolicy(
                        keepAlive ? WebView.RENDERER_PRIORITY_IMPORTANT : WebView.RENDERER_PRIORITY_BOUND,
                        !keepAlive);
            }
        } catch (Throwable ignored) {
        }
    }

    /* ---------------- 2. 电池优化白名单 ---------------- */

    /** 当前应用是否已加入"忽略电池优化"白名单。 */
    @JavascriptInterface
    public boolean isIgnoringBatteryOptimizations() {
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            if (pm == null) return false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                return pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
            }
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    /**
     * 弹系统面板请用户把本应用加入"忽略电池优化"白名单。
     *
     * 走 ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS 需要在 manifest 里声明
     * REQUEST_IGNORE_BATTERY_OPTIMIZATIONS 权限（Play 商店会审核这个权限，
     * 但对自用 / 侧载 APK 没有这个问题）。
     * 若该 Activity 不存在，退回到系统"电池优化应用列表"页面。
     */
    @JavascriptInterface
    public boolean requestIgnoreBatteryOptimizations() {
        try {
            Intent i = new Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + ctx.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            return true;
        } catch (Throwable ignored) {
            try {
                Intent j = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                j.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(j);
                return true;
            } catch (Throwable t) {
                return false;
            }
        }
    }

    /* ---------------- 3. 厂商省电策略引导 ---------------- */

    /**
     * 打开本应用在系统里的"电池 / 后台管理"设置页。
     *
     * 国产 ROM 的省电策略是各自实现的，标准 Intent 打不开，只能按厂商分支处理：
     *   小米/红米 → 电池省电策略；华为/荣耀 → 应用启动管理；
     *   OPPO/一加/realme → 电池优化；vivo → 后台高耗电；
     *   三星 → 应用电池使用情况；其他 → 系统应用信息页。
     */
    @JavascriptInterface
    public boolean openBatterySettings() {
        String pkg = ctx.getPackageName();
        String maker = String.valueOf(Build.MANUFACTURER).toLowerCase();
        Intent target = null;

        if (maker.contains("xiaomi") || maker.contains("redmi") || maker.contains("poco")) {
            target = new Intent("mi.intent.action.POWER_HIDE_MODE_APP_LIST");
        } else if (maker.contains("huawei") || maker.contains("honor")) {
            target = new Intent().setComponent(new ComponentName(
                    "com.huawei.systemmanager",
                    "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"));
        } else if (maker.contains("oppo") || maker.contains("oneplus") || maker.contains("realme")) {
            target = new Intent("com.coloros.safecenter");
        } else if (maker.contains("vivo")) {
            target = new Intent().setComponent(new ComponentName(
                    "com.vivo.permissionmanager",
                    "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"));
        } else if (maker.contains("samsung")) {
            target = new Intent("com.samsung.android.lool");
        }

        if (target != null) {
            try {
                target.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(target);
                return true;
            } catch (Throwable ignored) {
                /* 落到下面的通用页 */
            }
        }
        // 通用兜底：系统应用详情页，用户可以从那里进"电池优化"
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    /** 打开"自启动"管理页（部分厂商把自启动和后台管理分开）。 */
    @JavascriptInterface
    public boolean openAutoStartSettings() {
        String maker = String.valueOf(Build.MANUFACTURER).toLowerCase();
        Intent target = null;
        if (maker.contains("xiaomi") || maker.contains("redmi") || maker.contains("poco")) {
            target = new Intent("mi.intent.action.OP_AUTO_START");
        } else if (maker.contains("huawei") || maker.contains("honor")) {
            target = new Intent().setComponent(new ComponentName(
                    "com.huawei.systemmanager",
                    "com.huawei.systemmanager.optimize.process.ProtectActivity"));
        } else if (maker.contains("oppo") || maker.contains("oneplus") || maker.contains("realme")) {
            target = new Intent("com.oppo.safe");
        } else if (maker.contains("vivo")) {
            target = new Intent().setComponent(new ComponentName(
                    "com.vivo.permissionmanager",
                    "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"));
        }
        if (target == null) return false;
        try {
            target.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(target);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    /* ---------------- 4. 状态汇总 ---------------- */

    /**
     * 一次性返回后台保活相关的全部状态，供设置页展示。
     * 用 JSON 传，JS 侧直接 JSON.parse 即可。
     */
    @JavascriptInterface
    public String status() {
        JSONObject o = new JSONObject();
        try {
            o.put("batteryIgnored", isIgnoringBatteryOptimizations());
            o.put("manufacturer", String.valueOf(Build.MANUFACTURER));
            o.put("sdk", Build.VERSION.SDK_INT);
            o.put("model", String.valueOf(Build.MODEL));
            // 前台服务是否正在跑
            o.put("keepAlive", DshKeepAliveService.isRunning());
        } catch (Throwable ignored) {
        }
        return o.toString();
    }
}
