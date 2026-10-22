package ai.deepseek.dsh.mobile;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * JS -> 原生：本机 MCP 的白名单管理与服务开关。
 *
 * 对应「只针对部分指定应用生效，保持最小敏感权限」：
 *
 * - **列可启动应用**（listLaunchableApps）：只返回有 MAIN/LAUNCHER 入口的应用。
 *   不申请 QUERY_ALL_PACKAGES，靠 manifest 里的 <queries> intent 过滤器实现，
 *   拿不到后台服务与系统私有包。
 *
 * - **白名单读写**（getAllowedPackages / setAllowedPackages / addAllowed / removeAllowed）：
 *   用户在设置里勾选哪些应用可以被本机 MCP 操作，存 SharedPreferences。
 *
 * - **服务开关**（enableServer / disableServer / isServerRunning）：
 *   默认关闭。关掉的时候连端口都不监听。
 */
public class DshMcpBridge {

    private final Context ctx;

    /** 应用是否被系统限制了后台运行（"限制后台活动"开关）。 */
    private boolean backgroundRestricted() {
        try {
            android.app.ActivityManager am =
                    (android.app.ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            if (am == null) return false;
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                return am.isBackgroundRestricted();
            }
        } catch (Throwable ignored) {
        }
        return false;
    }

    /** 有没有「显示在其他应用上层」权限 —— 决定后台能否启动保活前台服务。 */
    private boolean canDrawOverlays() {
        try {
            return android.provider.Settings.canDrawOverlays(ctx);
        } catch (Throwable t) {
            return false;
        }
    }

    public DshMcpBridge(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    /* ---------------------------------------------------------- 服务开关 */

    @JavascriptInterface
    public boolean isServerEnabled() {
        return DshMcpPolicy.isEnabled(ctx);
    }

    @JavascriptInterface
    public void enableServer() {
        DshMcpPolicy.setEnabled(ctx, true);
        // MCP server 现在跑在 :device 进程里，主进程调 start() 只会把 server
        // 起在自己的进程里 —— 那样无障碍和 server 又不在一个进程了，白拆。
        // 必须由 :device 的入口服务去拉。
        DshDeviceService.start(ctx, true);
    }

    @JavascriptInterface
    public void disableServer() {
        DshMcpPolicy.setEnabled(ctx, false);
        DshDeviceService.stop(ctx);
    }

    /**
     * 强制重建 :device 里的 MCP server。
     *
     * 解决的是「界面显示正在运行，但请求连不上」——那种情况下
     * instance 还在、socket 已经不能 accept，普通 start() 会被 instance 挡住。
     */
    @JavascriptInterface
    public boolean restartServer() {
        try {
            DshDeviceService.restart(ctx);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    @JavascriptInterface
    public boolean isServerRunning() {
        // 主进程里 DshMcpServer.isRunning() 永远是 false（静态量不跨进程），
        // 只能问 :device。
        return fetchDeviceStatus() != null;
    }

    /* ------------------------------------------------------------ 白名单 */

    @JavascriptInterface
    public String getAllowedPackages() {
        JSONArray arr = new JSONArray();
        for (String p : DshMcpPolicy.allowedPackages(ctx)) {
            arr.put(p);
        }
        return arr.toString();
    }

    @JavascriptInterface
    public void setAllowedPackages(String csv) {
        DshMcpPolicy.setAllowedPackages(ctx, csv);
    }

    @JavascriptInterface
    public void addAllowedPackage(String pkg) {
        DshMcpPolicy.addAllowed(ctx, pkg);
    }

    @JavascriptInterface
    public void removeAllowedPackage(String pkg) {
        DshMcpPolicy.removeAllowed(ctx, pkg);
    }

    /**
     * 列出可启动的应用（应用名 + 包名），并标注哪些已在白名单里。
     *
     * 走 <queries> 的 MAIN/LAUNCHER 过滤器，不需要 QUERY_ALL_PACKAGES。
     */
    @JavascriptInterface
    public String listLaunchableApps() {
        JSONArray arr = new JSONArray();
        try {
            PackageManager pm = ctx.getPackageManager();
            Intent intent = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
            List<ResolveInfo> resolved = pm.queryIntentActivities(intent, 0);

            Map<String, String> byPackage = new LinkedHashMap<>();
            for (ResolveInfo ri : resolved) {
                if (ri.activityInfo == null || ri.activityInfo.packageName == null) continue;
                String pkg = ri.activityInfo.packageName;
                if (byPackage.containsKey(pkg)) continue;
                CharSequence label = ri.loadLabel(pm);
                byPackage.put(pkg, label == null ? pkg : label.toString());
            }

            List<String[]> rows = new ArrayList<>();
            for (Map.Entry<String, String> e : byPackage.entrySet()) {
                rows.add(new String[]{e.getValue(), e.getKey()});
            }
            rows.sort((x, y) -> x[0].compareToIgnoreCase(y[0]));

            for (String[] row : rows) {
                JSONObject o = new JSONObject();
                o.put("label", row[0]);
                o.put("package", row[1]);
                o.put("allowed", DshMcpPolicy.isExplicitlyAllowed(ctx, row[1]));
                arr.put(o);
            }
        } catch (Throwable t) {
            try {
                JSONObject err = new JSONObject();
                err.put("error", String.valueOf(t.getMessage()));
                arr.put(err);
            } catch (Exception ignored) {
            }
        }
        return arr.toString();
    }

    /**
     * 无障碍设置页 —— 0.26.0 起不再使用无障碍通道，指向它只会让用户困惑。
     * 保留签名兼容旧前端。
     */
    @JavascriptInterface
    public boolean openAccessibilitySettings() {
        return false;
    }

    /**
     * 打开本应用的「应用信息」页。
     *
     * Android 13+ 对**非应用商店安装**的应用默认禁止开启无障碍等敏感权限，
     * 必须先在这个页面点右上角 ⋮ →「允许受限设置」放行，
     * 否则用户在无障碍页把开关点开，系统会在离开界面时把它弹回关闭。
     *
     * 这正是「打开后离开界面开关自动关闭」的头号成因，
     * 所以给一个直达入口，比让用户自己在设置里找要靠谱得多。
     */
    @JavascriptInterface
    public boolean openAppInfoSettings() {
        try {
            Intent intent = new Intent(
                    android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    android.net.Uri.parse("package:" + ctx.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(intent);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 无障碍保活 —— 0.26.0 起无障碍通道已删除，保活服务随之移除。
     *
     * 保留空方法只为兼容旧前端：老版本页面还会调它，直接删会 NoSuchMethod，
     * 整个 JS 桥会报错。空实现让旧页面不至于崩，同时什么也不做。
     */
    @JavascriptInterface
    public void setA11yKeepAlive(boolean on) {
    }

    /**
     * 设置 ui_* 的通道偏好：auto / fast / slow。
     *
     * 为什么写文件而不是 SharedPreferences：读它的是 :device 进程里的 MCP 工具，
     * 而 SharedPreferences 有进程内缓存 —— 主进程写完之后，:device 手里还是旧值，
     * 表现为「设置里切了，实际行为没变」。文件是所有进程共享的，不存在这个问题。
     */
    @JavascriptInterface
    public void setUiChannel(String ch) {
        try {
            String v = ("fast".equals(ch) || "slow".equals(ch)) ? ch : "auto";
            java.io.File f = new java.io.File(ctx.getFilesDir(), "ui-channel.txt");
            try (java.io.OutputStreamWriter w = new java.io.OutputStreamWriter(
                    new java.io.FileOutputStream(f), java.nio.charset.StandardCharsets.UTF_8)) {
                w.write(v);
            }
            DshA11yDiagnostics.log(ctx, "ui：通道偏好设为 " + v);
        } catch (Throwable ignored) {
        }
    }

    @JavascriptInterface
    public String getUiChannel() {
        try {
            java.io.File f = new java.io.File(ctx.getFilesDir(), "ui-channel.txt");
            if (!f.exists()) return "auto";
            StringBuilder sb = new StringBuilder();
            try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.InputStreamReader(
                    new java.io.FileInputStream(f), java.nio.charset.StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            String v = sb.toString().trim();
            return ("fast".equals(v) || "slow".equals(v)) ? v : "auto";
        } catch (Throwable t) {
            return "auto";
        }
    }

    /* ------------------------------------------------------ 落点标记（0.27.0） */

    /**
     * 开关「AI 点击时在屏幕上显示落点」。
     *
     * 为什么也写文件：读它的是 :device 进程里的 ui_* 工具，和 ui-channel 同一个理由 ——
     * SharedPreferences 有进程内缓存，主进程写完 :device 还是旧值，
     * 表现为「设置里关掉了，屏幕上还在画」。
     */
    @JavascriptInterface
    public void setPointerMarkEnabled(boolean on) {
        try {
            java.io.File f = new java.io.File(ctx.getFilesDir(), DshPointerOverlay.CONFIG_FILE);
            try (java.io.OutputStreamWriter w = new java.io.OutputStreamWriter(
                    new java.io.FileOutputStream(f), java.nio.charset.StandardCharsets.UTF_8)) {
                w.write(on ? "on" : "off");
            }
            DshA11yDiagnostics.log(ctx, "pointer：落点标记 " + (on ? "开" : "关"));
        } catch (Throwable ignored) {
        }
    }

    @JavascriptInterface
    public boolean isPointerMarkEnabled() {
        return DshPointerOverlay.enabled(ctx);
    }

    /**
     * 申请 Shizuku 授权。
     *
     * 为什么绕一圈走 :device 的 Service，而不是在这里直接调 Shizuku.requestPermission：
     * UserService 的连接状态（remote binder）是**进程内静态量**，它活在 :device 里。
     * 主进程去申请，授权成功了但连接建在别处，两边状态会不一致。
     * 所有 Shizuku 动作统一在 :device 执行，只留一份真相。
     */
    @JavascriptInterface
    public void requestShizukuPermission() {
        DshDeviceService.sendAction(ctx, DshDeviceService.ACTION_SHIZUKU_REQUEST);
    }

    @JavascriptInterface
    public void connectShizuku() {
        DshDeviceService.sendAction(ctx, DshDeviceService.ACTION_SHIZUKU_CONNECT);
    }

    /**
     * 打开 Shizuku 应用（没启动时用户需要手动启动它）。
     *
     * 返回 false 表示没装 —— 那就该引导去装，而不是反复点「授权」。
     */
    @JavascriptInterface
    public boolean openShizukuApp() {
        try {
            Intent i = ctx.getPackageManager().getLaunchIntentForPackage("moe.shizuku.privileged.api");
            if (i == null) return false;
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 无障碍保活 —— 0.26.0 起已移除，保留签名兼容旧前端。 */
    public boolean startA11yKeepAlive() {
        return false;
    }

    /**
     * 悬浮窗授权页 —— 当初是为了让无障碍保活能在后台启动，0.26.0 起不再需要。
     * 保留签名兼容旧前端。
     */
    public boolean openOverlaySettings() {
        return false;
    }

    /**
     * 一次性状态：服务是否在跑、白名单数量、Shizuku 通道处于哪一档。
     *
     * ============ 为什么必须从 :device 取 ============
     *
     * Shizuku 的 binder、授权、连接状态都是**进程内静态量**，它们活在 :device。
     * 主进程自己算出来的永远是「没连上」—— 这种"状态显示错"比功能坏更难查。
     *
     * 所以：主进程只放自己确实能算的（是否启用、白名单数量、自己的 pid），
     * 其余一律以 :device 的快照为准。
     */
    @JavascriptInterface
    public String status() {
        JSONObject local = new JSONObject();
        try {
            local.put("enabled", DshMcpPolicy.isEnabled(ctx));
            local.put("allowedCount", DshMcpPolicy.allowedPackages(ctx).size());
            local.put("port", DshMcpServer.PORT);
            local.put("appPid", android.os.Process.myPid());
            // 落点标记要不要「去授予悬浮窗权限」，界面全靠这个字段判断
            local.put("overlay", canDrawOverlays());
        } catch (Throwable ignored) {
        }

        JSONObject remote = fetchDeviceStatus();
        if (remote != null) {
            try {
                for (java.util.Iterator<String> it = remote.keys(); it.hasNext(); ) {
                    String k = it.next();
                    local.put(k, remote.get(k));
                }
                local.put("deviceReachable", true);
                // ============ running 取 :device 的判断，不要覆盖成 true ============
                //
                // 之前这里无条件写 running=true，理由是「能取到快照说明端口通着」。
                // 但端口通 ≠ 监听正常：:device 里 server 可能已经停止（用户关了开关），
                // 而 DshMcpServer.isRunning() 才是那一侧的真相。
                //
                // 覆盖成 true 的后果是：设置页永远显示「正在监听」，
                // 而实际连不上 —— 这正是「显示在跑但就是不稳」的第一现场。
                boolean running = remote.optBoolean("running", true);
                local.put("running", running);
            } catch (Throwable ignored) {
            }
        } else {
            try {
                local.put("deviceReachable", false);
                local.put("running", false);
                // 拿不到就明说拿不到，不要伪造「未授权」骗用户去重新授权
                local.put("shizukuInstalled", false);
                local.put("shizukuRunning", false);
                local.put("shizukuGranted", false);
                local.put("shizukuState", 0);
                local.put("shizukuDesc", "本机控制未运行（设备进程不可达），读不到 Shizuku 状态");
            } catch (Throwable ignored) {
            }
        }
        return local.toString();
    }

    /**
     * 从 :device 的 MCP server 取状态快照。
     *
     * 本地回环，正常 1~5ms。server 没起时连接会被立即拒绝（不是超时），
     * 所以这里的超时只防"端口被占住不响应"这种极端情况。
     *
     * @return 拿不到返回 null
     */
    /**
     * 问 :device 要状态快照。
     *
     * ============ 超时为什么从 250/400 放宽（0.27.1）============
     *
     * 127.0.0.1 正常往返 <20ms，250/400 看起来绰绰有余。但这一侧真正要等的
     * 不只是网络：对端还要跑 DshStatus.snapshot()（读 Shizuku 状态 + 读日志文件）。
     * :device 刚被系统唤醒、或在读一份很大的诊断日志时，很容易超过 400ms。
     *
     * 一超过就返回 null，界面立刻显示「本机控制未运行」、isServerRunning() 也变 false ——
     * 用户看到的就是「连接不稳」。这里放宽到 600/1000，并重试一次：
     * 单次抖动不该被当成"服务挂了"。
     *
     * 代价是最坏情况下这条桥接调用要 3 秒左右。但它只在设备侧真的异常时才会走到，
     * 正常路径仍然是 20ms。
     */
    private JSONObject fetchDeviceStatus() {
        for (int attempt = 0; attempt < 2; attempt++) {
            JSONObject o = fetchDeviceStatusOnce();
            if (o != null) return o;
            if (attempt == 0) {
                try {
                    Thread.sleep(120);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }
        return null;
    }

    private JSONObject fetchDeviceStatusOnce() {
        java.net.HttpURLConnection conn = null;
        try {
            java.net.URL url = new java.net.URL(
                    "http://127.0.0.1:" + DshMcpServer.PORT + "/");
            conn = (java.net.HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(600);
            conn.setReadTimeout(1000);
            conn.setUseCaches(false);
            if (conn.getResponseCode() != 200) return null;
            java.io.InputStream in = conn.getInputStream();
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] b = new byte[4096];
            int n;
            while ((n = in.read(b)) > 0) buf.write(b, 0, n);
            String text = buf.toString("UTF-8");
            return new JSONObject(text);
        } catch (Throwable t) {
            return null;
        } finally {
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Throwable ignored) {
                }
            }
        }
    }
}
