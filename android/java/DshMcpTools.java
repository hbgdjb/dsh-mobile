package ai.deepseek.dsh.mobile;

import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.res.Resources;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.StatFs;
import android.os.Vibrator;
import android.provider.Settings;
import android.view.KeyEvent;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 手机本机可用的 MCP 工具集合。
 *
 * 分两层能力：
 *  1. 普通层 —— 启动/停止/查询应用、打开链接、分享、音量、媒体键、剪贴板、
 *     设备状态。不需要任何特殊权限。
 *  2. 无障碍层 —— 读取当前界面、按文字点击、坐标点击、滑动、输入文字、
 *     返回/主页/多任务。需要用户在系统设置里开启无障碍服务。
 */
public final class DshMcpTools {

    private DshMcpTools() {
    }

    /* --------------------------------------------------------------- 注册 */

    public static List<DshMcpServer.Tool> all(Context ctx) {
        List<DshMcpServer.Tool> list = new ArrayList<>();

        /* ---------------------------- 应用 ---------------------------- */

        list.add(new DshMcpServer.Tool(
                "app_list",
                "列出手机上可启动的应用，返回应用名与包名。想知道某个应用叫什么包名时先调它。",
                schema(),
                a -> listApps(ctx)
        ));

        list.add(new DshMcpServer.Tool(
                "app_launch",
                "启动一个应用。target 可以是包名（com.tencent.mm）、应用名片段（微信）或完整类名。",
                schema(prop("target", "string", "包名 / 应用名片段 / 类名", true)),
                a -> launchApp(ctx, req(a, "target"))
        ));

        list.add(new DshMcpServer.Tool(
                "app_stop",
                "结束一个应用的进程。target 为包名或应用名片段。",
                schema(prop("target", "string", "包名 / 应用名片段", true)),
                a -> stopApp(ctx, req(a, "target"))
        ));

        list.add(new DshMcpServer.Tool(
                "app_info",
                "查看某个应用的详情：版本、安装时间、是否可启动、是否系统应用。",
                schema(prop("target", "string", "包名 / 应用名片段", true)),
                a -> appInfo(ctx, req(a, "target"))
        ));

        list.add(new DshMcpServer.Tool(
                "app_open_uri",
                "用系统默认方式打开一个 URI。支持网址（https://…）、拨号（tel:）、短信（smsto:）、"
                        + "地图（geo:）、以及应用深链和系统设置页（如 settings、wifi、bluetooth、app）。",
                schema(prop("uri", "string", "要打开的 URI 或设置页名", true)),
                a -> openUri(ctx, req(a, "uri"))
        ));

        list.add(new DshMcpServer.Tool(
                "app_share_text",
                "调起系统分享面板，把一段文本分享到任意应用（微信、备忘录等）。",
                schema(prop("text", "string", "要分享的文本", true)),
                a -> shareText(ctx, req(a, "text"))
        ));

        /* ---------------------------- 设备 ---------------------------- */

        list.add(new DshMcpServer.Tool(
                "device_status",
                "读取手机状态：机型、系统版本、电量与充电、屏幕是否点亮、音量、存储余量、"
                        + "网络类型、当前前台应用、无障碍服务是否已开启。",
                schema(),
                a -> deviceStatus(ctx)
        ));

        list.add(new DshMcpServer.Tool(
                "volume_get",
                "读取当前媒体音量与最大音量。",
                schema(),
                a -> volumeGet(ctx)
        ));

        list.add(new DshMcpServer.Tool(
                "volume_set",
                "设置媒体音量。level 传 0-100 的百分比，或用 up / down / mute 微调。",
                schema(prop("level", "string", "0-100，或 up / down / mute", true)),
                a -> volumeSet(ctx, req(a, "level"))
        ));

        list.add(new DshMcpServer.Tool(
                "media_key",
                "发送媒体按键，控制正在播放的音乐/视频：play_pause、next、previous、stop。",
                schema(prop("key", "string", "play_pause / next / previous / stop", true)),
                a -> mediaKey(ctx, req(a, "key"))
        ));

        list.add(new DshMcpServer.Tool(
                "clipboard_get",
                "读取手机剪贴板里的文本。",
                schema(),
                a -> clipboardGet(ctx)
        ));

        list.add(new DshMcpServer.Tool(
                "clipboard_set",
                "把一段文本写入手机剪贴板。",
                schema(prop("text", "string", "要写入的文本", true)),
                a -> clipboardSet(ctx, req(a, "text"))
        ));

        list.add(new DshMcpServer.Tool(
                "toast",
                "在屏幕上弹一条短提示。适合告诉用户「已经帮你做了某事」。",
                schema(prop("text", "string", "提示文字", true)),
                a -> toast(ctx, req(a, "text"))
        ));

        list.add(new DshMcpServer.Tool(
                "vibrate",
                "让手机振动一下，毫秒数默认 200。",
                schema(prop("ms", "number", "振动时长（毫秒），默认 200")),
                a -> vibrate(ctx, a.optInt("ms", 200))
        ));

        list.add(new DshMcpServer.Tool(
                "notify",
                "发一条系统通知（会出现在通知栏）。",
                schema(
                        prop("title", "string", "通知标题", true),
                        prop("text", "string", "通知正文")
                ),
                a -> notify(ctx, req(a, "title"), a.optString("text", ""))
        ));

        /* --------------------------- 无障碍 UI --------------------------- */

        list.add(new DshMcpServer.Tool(
                "ui_dump",
                "读取当前屏幕上的界面结构，返回可点击控件、文字与坐标（每行已带中心点）。"
                        + "要操作别的应用时先用它看清界面。走 Shizuku 通道，约 1~2 秒。"
                        + "注意它只读**活动窗口**：软键盘、通知栏这类独立窗口不在结果里。"
                        + "format 可选 text（默认，给人看的紧凑文本）或 json"
                        + "（结构化：每个控件带 ref 语义引用、类型、文字、无障碍描述、资源 id）。"
                        + "要精确点击就用 format=json 拿 ref，再交给 ui_tap_ref —— "
                        + "它在点击那一刻会重新定位，比抄坐标可靠。",
                schema(prop("format", "string", "text（默认）或 json", false)),
                a -> uiDump(ctx, a.optString("format", "text"))
        ));

        list.add(new DshMcpServer.Tool(
                "ui_click_text",
                "在当前界面上按文字找控件并点击。match 支持文字或无障碍描述的一部分，"
                        + "例如「发送」「确定」「搜索」。同名时优先点可点的那个。"
                        + "strict=true 时只点可点/可输入的控件，找不到就报错不乱点。"
                        + "点击位置会在屏幕上短暂显示（用户能看到你点了哪里）。",
                schema(
                        prop("match", "string", "要点击的控件文字片段", true),
                        prop("strict", "boolean", "只点可点控件；找不到就报错（默认 false）", false)
                ),
                a -> uiClickText(ctx, req(a, "match"), a.optBoolean("strict", false))
        ));

        list.add(new DshMcpServer.Tool(
                "ui_tap_ref",
                "按 ref 点击控件。ref 形如 Button|搜索、ImageView|#icon-1、Button|搜索#2，"
                        + "从 ui_dump（format=json）的结果里取。"
                        + "点击前会在当前屏幕重新定位一次：找得到就点，找不到就报错并列出可用的 ref，"
                        + "**不会盲点坐标**。"
                        + "这是比 ui_tap(x, y) 更可靠的方式 —— 优先用它。",
                schema(prop("ref", "string", "控件的 ref（从 ui_dump 的 format=json 结果里取）", true)),
                a -> uiTapRef(ctx, req(a, "ref"))
        ));

        list.add(new DshMcpServer.Tool(
                "ui_tap",
                "按屏幕坐标点击一下。x、y 用像素（优先从 ui_dump 每行的「中心(x,y)」直接复制）。"
                        + "如果你是从截图估的位置，请传 0~1 的比例（如 0.5, 0.85），会自动按屏幕宽高换算 —— "
                        + "不要直接把截图上的像素填进来，截图和屏幕分辨率通常不是一个尺寸。"
                        + "点击位置会在屏幕上短暂显示（用户能看到你点了哪里）。",
                schema(
                        prop("x", "number", "横坐标（像素；或 0~1 的比例）", true),
                        prop("y", "number", "纵坐标（像素；或 0~1 的比例）", true)
                ),
                a -> uiTap(ctx, a.getDouble("x"), a.getDouble("y"))
        ));

        list.add(new DshMcpServer.Tool(
                "ui_swipe",
                "从一点滑动到另一点，用于翻页、下拉刷新、拖动。坐标规则同 ui_tap：像素或 0~1 比例。"
                        + "滑动轨迹会在屏幕上短暂显示（用户能看到方向和距离）。",
                schema(
                        prop("x1", "number", "起点横坐标", true),
                        prop("y1", "number", "起点纵坐标", true),
                        prop("x2", "number", "终点横坐标", true),
                        prop("y2", "number", "终点纵坐标", true),
                        prop("ms", "number", "滑动时长（毫秒），默认 300")
                ),
                a -> uiSwipe(ctx, a.getDouble("x1"), a.getDouble("y1"),
                        a.getDouble("x2"), a.getDouble("y2"), a.optInt("ms", 300))
        ));

        list.add(new DshMcpServer.Tool(
                "ui_set_text",
                "把文字输入到当前界面的输入框里（先点一下输入框再用它）。"
                        + "这是往输入框写字最可靠的方式 —— 不要靠点软键盘的字母键。",
                schema(prop("text", "string", "要输入的文字", true)),
                a -> uiSetText(ctx, req(a, "text"))
        ));

        list.add(new DshMcpServer.Tool(
                "ui_global",
                "执行系统级操作：back（返回）、home（回桌面）、recents（多任务）、notifications（下拉通知栏）、"
                        + "enter（回车/搜索/发送）、delete（退格删一个字）、space（空格）、lock（锁屏）。"
                        + "软键盘上的「搜索 / 发送 / 完成」按钮就用 enter —— 键盘是独立窗口，"
                        + "既不在 ui_dump 的控件树里，按坐标点也不稳。",
                schema(prop("action", "string", "back / home / recents / notifications / enter / delete / space / lock", true)),
                a -> uiGlobal(ctx, req(a, "action"))
        ));

        return list;
    }

    /* --------------------------------------------------------------- 应用 */

    private static String listApps(Context ctx) throws Exception {
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
        if (byPackage.isEmpty()) {
            return "（没有取到可启动的应用列表。Android 11+ 需要在 AndroidManifest 里"
                    + "声明 <queries> 的 MAIN/LAUNCHER intent 过滤器。）";
        }

        // 只列白名单内的应用：模型看到的「可用应用」就是用户授权的那一批
        List<String[]> rows = new ArrayList<>();
        for (Map.Entry<String, String> e : byPackage.entrySet()) {
            if (!DshMcpPolicy.isAllowed(ctx, e.getKey(), false)) continue;
            rows.add(new String[]{e.getValue(), e.getKey()});
        }
        Collections.sort(rows, (x, y) -> x[0].compareToIgnoreCase(y[0]));

        if (rows.isEmpty()) {
            return "没有允许控制的应用。" + DshMcpPolicy.describeScope(ctx);
        }

        StringBuilder sb = new StringBuilder();
        sb.append("共 ").append(rows.size()).append(" 个允许控制的应用：\n");
        int shown = 0;
        for (String[] row : rows) {
            sb.append(row[0]).append("  ").append(row[1]).append('\n');
            shown++;
            if (shown >= 150) {
                sb.append("…（只列前 150 个）");
                break;
            }
        }
        return sb.toString().trim();
    }

    /** 把「包名 / 应用名片段」解析成包名。 */
    private static String resolvePackage(Context ctx, String target) {
        String t = target == null ? "" : target.trim();
        if (t.isEmpty()) return null;
        PackageManager pm = ctx.getPackageManager();

        try {
            pm.getPackageInfo(t, 0);
            // 直接给包名：同样要过白名单，否则可以绕过名字匹配直接点名操作
            if (DshMcpPolicy.isAllowed(ctx, t, false)) return t;
            return null;
        } catch (Exception ignored) {
        }

        Intent intent = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> resolved = pm.queryIntentActivities(intent, 0);
        String lower = t.toLowerCase(Locale.ROOT);
        String best = null;
        int bestScore = -1;
        for (ResolveInfo ri : resolved) {
            if (ri.activityInfo == null) continue;
            String pkg = ri.activityInfo.packageName;
            // 只在白名单内的应用里找名字
            if (!DshMcpPolicy.isAllowed(ctx, pkg, false)) continue;
            CharSequence labelCs = ri.loadLabel(pm);
            String label = labelCs == null ? "" : labelCs.toString();
            String lp = label.toLowerCase(Locale.ROOT);
            int score = -1;
            if (label.equalsIgnoreCase(t)) score = 100;
            else if (lp.startsWith(lower)) score = 80;
            else if (lp.contains(lower)) score = 60;
            else if (pkg.toLowerCase(Locale.ROOT).contains(lower)) score = 40;
            if (score > bestScore) {
                bestScore = score;
                best = pkg;
            }
        }
        return best;
    }

    private static String launchApp(Context ctx, String target) throws Exception {
        PackageManager pm = ctx.getPackageManager();
        String pkg = resolvePackage(ctx, target);
        if (pkg == null) {
            throw new Exception("没有找到可操作的应用：" + target + "。"
                    + DshMcpPolicy.describeScope(ctx));
        }
        Intent launch = pm.getLaunchIntentForPackage(pkg);
        if (launch == null) {
            // 退一步：直接按类名启动
            launch = new Intent(Intent.ACTION_MAIN);
            launch.setClassName(pkg, target);
        }
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        ctx.startActivity(launch);

        CharSequence label;
        try {
            label = pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0));
        } catch (Exception e) {
            label = pkg;
        }
        return "已启动 " + label + "（" + pkg + "）";
    }

    private static String stopApp(Context ctx, String target) throws Exception {
        String pkg = resolvePackage(ctx, target);
        if (pkg == null) {
            throw new Exception("没有找到可操作的应用：" + target + "。"
                    + DshMcpPolicy.describeScope(ctx));
        }
        ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
        if (am == null) throw new Exception("取不到 ActivityManager");
        am.killBackgroundProcesses(pkg);
        return "已请求结束 " + pkg + "（系统只允许结束后台进程，前台应用可能仍在运行）";
    }

    private static String appInfo(Context ctx, String target) throws Exception {
        PackageManager pm = ctx.getPackageManager();
        String pkg = resolvePackage(ctx, target);
        if (pkg == null) {
            throw new Exception("没有找到可操作的应用：" + target + "。"
                    + DshMcpPolicy.describeScope(ctx));
        }
        android.content.pm.PackageInfo pi = pm.getPackageInfo(pkg, 0);
        ApplicationInfo ai = pi.applicationInfo;

        long code = Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;

        StringBuilder sb = new StringBuilder();
        sb.append("包名      ").append(pkg).append('\n');
        sb.append("应用名    ").append(pm.getApplicationLabel(ai)).append('\n');
        sb.append("版本      ").append(pi.versionName).append(" (").append(code).append(")\n");
        sb.append("targetSdk ").append(ai.targetSdkVersion).append('\n');
        sb.append("系统应用  ").append((ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0 ? "是" : "否").append('\n');
        sb.append("可启动    ").append(pm.getLaunchIntentForPackage(pkg) != null ? "是" : "否").append('\n');
        sb.append("安装位置  ").append(ai.sourceDir).append('\n');
        sb.append("数据目录  ").append(ai.dataDir);
        return sb.toString();
    }

    private static String openUri(Context ctx, String uri) throws Exception {
        String u = uri == null ? "" : uri.trim();
        if (u.isEmpty()) throw new Exception("uri 不能为空");

        // 没有冒号：先当系统设置页简写，再当网址
        if (!u.contains(":")) {
            String key = u.toLowerCase(Locale.ROOT);
            String action = null;
            switch (key) {
                case "settings":
                case "设置":
                    action = Settings.ACTION_SETTINGS;
                    break;
                case "wifi":
                case "无线网络":
                    action = Settings.ACTION_WIFI_SETTINGS;
                    break;
                case "bluetooth":
                case "蓝牙":
                    action = Settings.ACTION_BLUETOOTH_SETTINGS;
                    break;
                case "app":
                case "apps":
                case "应用":
                    action = Settings.ACTION_APPLICATION_SETTINGS;
                    break;
                case "display":
                case "显示":
                    action = Settings.ACTION_DISPLAY_SETTINGS;
                    break;
                case "sound":
                case "声音":
                    action = Settings.ACTION_SOUND_SETTINGS;
                    break;
                case "battery":
                case "电池":
                    action = Settings.ACTION_BATTERY_SAVER_SETTINGS;
                    break;
                case "location":
                case "位置":
                    action = Settings.ACTION_LOCATION_SOURCE_SETTINGS;
                    break;
                case "accessibility":
                case "无障碍":
                    action = Settings.ACTION_ACCESSIBILITY_SETTINGS;
                    break;
                default:
                    break;
            }
            if (action != null) {
                Intent i = new Intent(action);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                return "已打开系统设置页：" + key;
            }
            if (!u.contains("/") && !u.contains(".")) {
                throw new Exception("看不懂这个地址：" + u
                        + "。要打开网址请写完整域名，要开设置页可用 settings / wifi / bluetooth / app / display / sound / battery / location / accessibility。");
            }
            u = "https://" + u;
        }

        // 深链会直接落到某个应用，那等于绕过白名单去启动未授权的应用。
        // 这里不用「猜」scheme 像不像包名（weixin、alipays 都不像），
        // 而是问系统：这个链接实际会被谁接走？拿到真实目标再校验。
        String targetPkg = resolveUriTarget(ctx, u);
        if (targetPkg != null && !DshMcpPolicy.isAllowed(ctx, targetPkg, false)) {
            throw new Exception("这个链接会打开 " + targetPkg + "，不在允许控制的白名单里，已拒绝。"
                    + DshMcpPolicy.describeScope(ctx));
        }

        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(u));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(intent);
        return "已用系统默认方式打开：" + u;
    }

    /**
     * 问系统：这个 URI 实际会被哪个应用接走？
     *
     * 比「按 scheme 形状猜包名」可靠得多：
     * 微信的 scheme 是 weixin、支付宝是 alipays，都不像包名；
     * 而 resolveActivity 拿的是系统真实的匹配结果。
     *
     * 解析不出来（网址、系统设置页等）返回 null —— 那不针对特定应用，不受白名单限制。
     */
    private static String resolveUriTarget(Context ctx, String uri) {
        try {
            Intent probe = new Intent(Intent.ACTION_VIEW, Uri.parse(uri));
            PackageManager pm = ctx.getPackageManager();
            ResolveInfo ri = pm.resolveActivity(probe, 0);
            if (ri != null && ri.activityInfo != null) {
                return ri.activityInfo.packageName;
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private static String shareText(Context ctx, String text) throws Exception {
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_TEXT, text);
        Intent chooser = Intent.createChooser(send, "分享到");
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(chooser);
        return "已调起分享面板，" + text.length() + " 个字符。";
    }

    /* --------------------------------------------------------------- 设备 */

    private static String deviceStatus(Context ctx) throws Exception {
        StringBuilder sb = new StringBuilder();

        // 第一行放「指纹」：FINGERPRINT 里带品牌/设备/版本，是唯一能一眼确认
        // "这份数据来自哪台机器"的东西。之前出过「AI 报的机型和用户手上的不是一台」，
        // 有了这一行，对不上时立刻能看出来，不用再猜是幻觉还是连错了服务。
        sb.append("【本机指纹】").append(Build.FINGERPRINT)
                .append(" · DSH ").append(appVersion(ctx))
                .append(" · pid ").append(android.os.Process.myPid()).append('\n');

        sb.append("机型      ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append('\n');
        sb.append("系统      Android ").append(Build.VERSION.RELEASE)
                .append("（API ").append(Build.VERSION.SDK_INT).append("）\n");

        Intent battery = ctx.registerReceiver(null, new android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (battery != null) {
            int level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
            int status = battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            int pct = scale > 0 ? (int) (level * 100f / scale) : -1;
            String state;
            switch (status) {
                case BatteryManager.BATTERY_STATUS_CHARGING:
                    state = "充电中";
                    break;
                case BatteryManager.BATTERY_STATUS_FULL:
                    state = "已充满";
                    break;
                case BatteryManager.BATTERY_STATUS_DISCHARGING:
                    state = "放电中";
                    break;
                default:
                    state = "未知";
            }
            sb.append("电量      ").append(pct).append("% · ").append(state).append('\n');
        }

        android.os.PowerManager pm = (android.os.PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        sb.append("屏幕      ").append(pm != null && pm.isInteractive() ? "点亮" : "熄灭").append('\n');

        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        if (am != null) {
            sb.append("媒体音量  ").append(am.getStreamVolume(AudioManager.STREAM_MUSIC))
                    .append('/').append(am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)).append('\n');
        }

        try {
            StatFs stat = new StatFs(Environment.getDataDirectory().getAbsolutePath());
            long free = stat.getAvailableBytes();
            long total = stat.getTotalBytes();
            sb.append("存储      ").append(gb(free)).append(" 可用 / ").append(gb(total)).append(" 总计\n");
        } catch (Exception ignored) {
        }

        // 网络类型是「锦上添花」的一项，**绝不能因为它拖垮整次调用**。
        //
        // 之前这里没有 try/catch：缺 ACCESS_NETWORK_STATE 时
        // ConnectivityManager.getActiveNetwork() 抛 SecurityException，
        // 整个 device_status 直接失败 —— 机型、电量、存储全都读到了却返回不出来。
        // 用户看到的是「device_status 不可用」，其实只有这一行不可用。
        String net = "未知（缺少网络状态权限）";
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            net = "无网络";
            if (cm != null) {
                if (Build.VERSION.SDK_INT >= 23) {
                    Network active = cm.getActiveNetwork();
                    NetworkCapabilities cap = active == null ? null : cm.getNetworkCapabilities(active);
                    if (cap != null) {
                        if (cap.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) net = "Wi-Fi";
                        else if (cap.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) net = "移动数据";
                        else if (cap.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) net = "以太网";
                        else net = "其它";
                    }
                } else {
                    // minSdk 22 兼容分支
                    android.net.NetworkInfo ni = cm.getActiveNetworkInfo();
                    if (ni != null && ni.isConnected()) {
                        net = ni.getType() == ConnectivityManager.TYPE_WIFI ? "Wi-Fi" : "移动数据";
                    }
                }
            }
        } catch (Throwable t) {
            net = "未知（" + t.getClass().getSimpleName() + "）";
        }
        sb.append("网络      ").append(net).append('\n');

        sb.append("Shizuku   ").append(DshShizuku.describe(ctx)).append('\n');

        // 前台包名只在 Shizuku 已建连接时问 —— 否则这次「读状态」会触发
        // 一次 4 秒的连接等待，让状态查询比实际操作还慢。
        //
        // 用 currentWindows 而不是 currentPackage：软键盘弹出时焦点窗口会变成
        // 输入法，只报一个包名的话模型会以为"前台换了应用"。这里报 Activity 归属，
        // 并把焦点窗口作为附注 —— 排查"为什么点不动"时这一行最有用。
        if (DshShizuku.state(ctx) == DshShizuku.ST_READY) {
            try {
                String[] w = DshShizuku.currentWindows(ctx);
                String fg = w[1] != null ? w[1] : w[0];
                if (fg != null) {
                    sb.append("前台应用  ").append(fg);
                    if (w[0] != null && !w[0].equals(fg)) {
                        sb.append("（焦点窗口：").append(w[0])
                                .append(DshShizuku.isIme(ctx, w[0]) ? " · 输入法" : "").append('）');
                    }
                    sb.append('\n');
                }
            } catch (Throwable ignored) {
            }
        }
        return sb.toString().trim();
    }

    /** 本应用的版本号，用于设备指纹（区分"连着的是不是当前这个 App"）。 */
    private static String appVersion(Context ctx) {
        try {
            android.content.pm.PackageInfo pi = ctx.getPackageManager()
                    .getPackageInfo(ctx.getPackageName(), 0);
            int code = Build.VERSION.SDK_INT >= 28 ? (int) pi.getLongVersionCode() : pi.versionCode;
            return pi.versionName + "(" + code + ")";
        } catch (Throwable t) {
            return "?";
        }
    }

    private static String gb(long bytes) {
        return String.format(Locale.US, "%.1f GB", bytes / 1024.0 / 1024.0 / 1024.0);
    }

    private static String volumeGet(Context ctx) throws Exception {
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        if (am == null) throw new Exception("取不到 AudioManager");
        int cur = am.getStreamVolume(AudioManager.STREAM_MUSIC);
        int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        int pct = max > 0 ? Math.round(cur * 100f / max) : 0;
        return "媒体音量 " + cur + "/" + max + "（" + pct + "%）";
    }

    private static String volumeSet(Context ctx, String level) throws Exception {
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        if (am == null) throw new Exception("取不到 AudioManager");
        int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        String v = level.trim().toLowerCase(Locale.ROOT);

        if ("up".equals(v)) {
            am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_RAISE, 0);
        } else if ("down".equals(v)) {
            am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_LOWER, 0);
        } else if ("mute".equals(v)) {
            am.setStreamVolume(AudioManager.STREAM_MUSIC, 0, 0);
        } else {
            int pct;
            try {
                pct = Math.max(0, Math.min(100, Integer.parseInt(v)));
            } catch (Exception e) {
                throw new Exception("level 要传 0-100，或 up / down / mute");
            }
            am.setStreamVolume(AudioManager.STREAM_MUSIC, Math.round(pct * max / 100f), 0);
        }
        int cur = am.getStreamVolume(AudioManager.STREAM_MUSIC);
        return "媒体音量已设为 " + cur + "/" + max;
    }

    private static String mediaKey(Context ctx, String key) throws Exception {
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        if (am == null) throw new Exception("取不到 AudioManager");
        int code;
        switch (key.trim().toLowerCase(Locale.ROOT)) {
            case "play_pause":
            case "play":
            case "pause":
                code = KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE;
                break;
            case "next":
                code = KeyEvent.KEYCODE_MEDIA_NEXT;
                break;
            case "previous":
            case "prev":
                code = KeyEvent.KEYCODE_MEDIA_PREVIOUS;
                break;
            case "stop":
                code = KeyEvent.KEYCODE_MEDIA_STOP;
                break;
            default:
                throw new Exception("key 要传 play_pause / next / previous / stop");
        }
        long now = android.os.SystemClock.uptimeMillis();
        am.dispatchMediaKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0));
        am.dispatchMediaKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_UP, code, 0));
        return "已发送媒体键：" + key;
    }

    private static String clipboardGet(Context ctx) throws Exception {
        ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null) throw new Exception("取不到剪贴板");
        if (!cm.hasPrimaryClip()) return "（剪贴板是空的）";
        ClipData clip = cm.getPrimaryClip();
        if (clip == null || clip.getItemCount() == 0) return "（剪贴板是空的）";
        CharSequence text = clip.getItemAt(0).coerceToText(ctx);
        String s = text == null ? "" : text.toString();
        return s.isEmpty() ? "（剪贴板里不是文本）" : s;
    }

    private static String clipboardSet(Context ctx, String text) throws Exception {
        ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null) throw new Exception("取不到剪贴板");
        cm.setPrimaryClip(ClipData.newPlainText("DSH", text));
        return "已写入剪贴板，" + text.length() + " 个字符。";
    }

    private static String toast(Context ctx, String text) throws Exception {
        new Handler(Looper.getMainLooper()).post(() ->
                Toast.makeText(ctx, text, Toast.LENGTH_SHORT).show());
        return "已弹出提示。";
    }

    private static String vibrate(Context ctx, int ms) throws Exception {
        Vibrator v = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
        if (v == null || !v.hasVibrator()) throw new Exception("这台设备没有振动马达");
        int d = Math.max(10, Math.min(2000, ms));
        v.vibrate(d);
        return "已振动 " + d + " 毫秒。";
    }

    private static String notify(Context ctx, String title, String text) throws Exception {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) throw new Exception("取不到通知服务");

        String channelId = "dsh-mcp";
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(
                    channelId, "DSH 工具通知", NotificationManager.IMPORTANCE_DEFAULT);
            nm.createNotificationChannel(ch);
        }
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(ctx, channelId)
                : new Notification.Builder(ctx);
        b.setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(title)
                .setContentText(text)
                .setAutoCancel(true);

        try {
            nm.notify((int) (System.currentTimeMillis() % 100000), b.build());
        } catch (SecurityException e) {
            throw new Exception("没有通知权限，请到系统设置里允许 DSH 发送通知");
        }
        return "已发送通知：" + title;
    }

    /* ------------------------------------------------------------- 无障碍 */

    /**
     * 白名单闸门。
     *
     * 无障碍通道已于 0.26.0 移除（见 README「为什么放弃无障碍」），
     * 现在只有 Shizuku 一条通道。但边界不能因此放松 ——
     * 它看到的同样是「当前屏幕」，可能是银行、聊天、相册。
     *
     * 所以判断依据始终是：**当下谁在前台**，而不是"要操作谁"。
     */
    private static void requireAllowed(Context ctx, String pkg) throws Exception {
        if (pkg == null || pkg.trim().isEmpty()) {
            throw new Exception("读不到当前前台应用，无法确认是否允许操作。"
                    + DshMcpPolicy.describeScope(ctx));
        }
        if (!DshMcpPolicy.isAllowed(ctx, pkg, false)) {
            throw new Exception("当前前台应用 " + pkg + " 不在允许控制的白名单里，已拒绝操作。"
                    + DshMcpPolicy.describeScope(ctx));
        }
    }

    /**
     * 判定「现在到底在操作谁」，返回判定通过的包名。
     *
     * ============ 为什么不能直接比 mCurrentFocus（0.26.2 修）============
     *
     * 「焦点窗口」不一定是应用：
     *
     *   软键盘弹出  → 焦点可能是输入法（com.baidu.input / com.sohu.inputmethod.sogou …）
     *   通知栏下拉  → 焦点是 com.android.systemui
     *   ANR 弹窗    → 焦点是 android
     *
     * 之前拿焦点包名直接比白名单，于是用户在这些界面上「明明在操作自己的应用，
     * 却被说不允许」—— 点软键盘、点系统弹窗全被挡住。
     *
     * 正确语义是：**白名单管的是"哪个应用的数据可以被碰"，不是"哪个窗口有焦点"。**
     * 所以输入法浮在授权应用上时，真正被操作的是它背后的应用（mFocusedApp），
     * 校验那个才对。
     *
     * 安全边界没有放松：
     *   · 输入法 → 必须背后的应用在白名单，否则照样拒绝
     *   · systemui / android / 设置这类系统窗口 → 本来就在 DshMcpPolicy.ALWAYS_ALLOWED
     *   · 权限授予弹窗（permissioncontroller）→ **不在**放行名单，仍然拒绝，
     *     否则 Agent 就能自己给自己加权限
     */
    private static String uiTarget(Context ctx) throws Exception {
        String[] w = DshShizuku.currentWindows(ctx);
        String focus = w[0];
        String app = w[1];

        // 焦点是输入法：键盘只是那个应用的输入通道，判定要落在应用上
        if (DshShizuku.isIme(ctx, focus)) {
            if (app != null && DshMcpPolicy.isAllowed(ctx, app, false)) return app;
            throw new Exception("软键盘（" + focus + "）正浮在当前应用上，但它背后的应用"
                    + (app == null ? "读不到" : " " + app + " 不在允许控制的白名单里")
                    + "，已拒绝操作。" + DshMcpPolicy.describeScope(ctx));
        }

        // 没有焦点窗口（部分 ROM 切换动画期间会短暂为空）→ 退回 Activity 归属
        if (focus == null) focus = app;

        if (focus == null || focus.trim().isEmpty()) {
            throw new Exception("读不到当前前台应用，无法确认是否允许操作。"
                    + DshMcpPolicy.describeScope(ctx));
        }
        if (!DshMcpPolicy.isAllowed(ctx, focus, false)) {
            throw new Exception("当前前台应用 " + focus + " 不在允许控制的白名单里，已拒绝操作。"
                    + DshMcpPolicy.describeScope(ctx));
        }
        return focus;
    }

    /**
     * dump 出来的根包名也可能落在输入法上（少数 ROM 会把 IME 当活动窗口）。
     * 遇到这种情况改用 {@link #uiTarget} 的判定，而不是一刀切拒绝。
     */
    private static void requireAllowedForDump(Context ctx, String rootPkg) throws Exception {
        if (DshShizuku.isIme(ctx, rootPkg)) {
            uiTarget(ctx);
            return;
        }
        requireAllowed(ctx, rootPkg);
    }

    /**
     * 白名单拒绝不是通道故障。
     *
     * 如果把它包成「通道不可用」，用户会去折腾 Shizuku，而真正的问题是
     * 「这个应用没勾选」—— 两件完全不同的事。
     */
    private static boolean isDenied(Exception e) {
        String m = e == null ? "" : String.valueOf(e.getMessage());
        return m.contains("不在允许控制的白名单") || m.contains("读不到当前前台应用");
    }

    /** 通道不可用时，报错要带上「怎么修」，而不是只说失败。 */
    private static Exception slowFailed(Exception e) {
        String m = e == null ? "未知原因" : String.valueOf(e.getMessage());
        return new Exception("界面操作不可用（Shizuku 通道）。\n"
                + "· 原因：" + m + "\n"
                + "· 排查：Shizuku 服务要在运行，且本应用要已授权（设置页「Shizuku」区块显示当前处于哪一档）。\n"
                + "· 不受影响：app_launch / clipboard / volume / notify / device_status 都不走这条通道。");
    }

    /**
     * 读界面。
     *
     * format=text（默认）：给人看的紧凑文本，与 0.32.0 完全一致。
     * format=json：结构化元素清单，每个带 ref —— 供 ui_tap_ref 精确点击。
     *
     * 为什么要做成同一个工具的两种格式，而不是两个工具：
     * 每读一次界面要走一次 Shizuku 通道（1~2 秒）。拆成两个工具的话，
     * 模型很可能「先 ui_dump 看一眼，再 dump(format=json) 拿 ref」—— 白读一次。
     * 一个工具一个参数，它自然只会读一次。
     */
    private static String uiDump(Context ctx, String format) throws Exception {
        try {
            if ("json".equalsIgnoreCase(String.valueOf(format).trim())) {
                return uiDumpJson(ctx);
            }
            String[] d = DshShizuku.dump(ctx);
            requireAllowedForDump(ctx, d[0]);
            return d[1] + "\n（通道：Shizuku）";
        } catch (Exception e) {
            if (isDenied(e)) throw e;
            throw slowFailed(e);
        }
    }

    /**
     * 按文字点击。
     *
     * ============ 为什么不再用「整行文本里找子串」（0.33.0）============
     *
     * 旧实现拿 dump 的**文本行**做子串匹配，有两个真实缺陷：
     *
     *   1. class 名也参与匹配。搜 "View" 会命中几乎所有元素 ——
     *      因为每行都以 "TextView" / "ImageView" 开头。
     *   2. 无法区分「同名但不同性质」的元素。页面上既有可点的「更多」按钮，
     *      也有不可点的「更多」标题，旧实现会按行序取第一个，可能是后者。
     *
     * 现在改成在**结构化元素**上匹配：只看文字 / 无障碍描述 / 资源 id，
     * 同名时优先挑可点的，其次挑面积小的（更像那个按钮本身，而不是整块容器）。
     *
     * strict = true 时只接受可点 / 可输入的元素，找不到就报错 ——
     * 用于「点错就出事」的场景（发送、支付、删除）。
     */
    private static String uiClickText(Context ctx, String match, boolean strict) throws Exception {
        try {
            // 一次 dump 同时拿到包名和控件树 —— 先校验，再点击，不盲点
            DshShizuku.UiDump d = DshShizuku.dumpElements(ctx);
            requireAllowedForDump(ctx, d.app);
            DshShizuku.UiElement e = DshShizuku.findByText(d, match);
            if (e == null || (strict && !e.clickable && !e.editable)) {
                throw new Exception("界面上没有找到" + (strict ? "可点的" : "") + "包含「" + match + "」的控件。"
                        + "（如果软键盘正开着，键盘是独立窗口、不在控件树里，"
                        + "提交请用 ui_global 的 enter，删字用 delete。"
                        + "可以先用 ui_dump（format=json）看看有哪些 ref。）");
            }
            int[] c = e.center();
            if (c == null) {
                throw new Exception("找到了「" + match + "」但它没有坐标，点不了。"
                        + "换一个更精确的文字，或改用 ui_tap 传坐标。");
            }
            // 先画再点：让「看见的那一下」和「实际落点」是同一时刻。
            // 画不出来不影响点击（mark* 内部全 catch），也不等 input 返回 —— 那会晚 100ms。
            DshPointerOverlay.markTap(ctx, c[0], c[1]);
            DshShizuku.tap(ctx, c[0], c[1]);
            return "已点击「" + match + "」(" + c[0] + ", " + c[1] + ")（通道：Shizuku）";
        } catch (Exception e) {
            if (isDenied(e)) throw e;
            throw slowFailed(e);
        }
    }

    /**
     * 结构化 dump：给程序用的元素清单。
     *
     * 为什么要它：文本 dump 是给人看的，模型要从里面「读」出该点哪个；
     * 结构化输出把这件事变成「程序查一次」，ref 还能在点击时重新定位。
     *
     * 元素数量封顶（默认 120，最多 300）：一屏几百个控件全塞进上下文
     * 既贵又没用 —— 模型真正会点的通常只有十几个。
     */
    private static String uiDumpJson(Context ctx) throws Exception {
        try {
            DshShizuku.UiDump d = DshShizuku.dumpElements(ctx);
            requireAllowedForDump(ctx, d.app);
            int max = 120;
            JSONArray els = new JSONArray();
            for (DshShizuku.UiElement e : d.elements) {
                if (els.length() >= max) break;
                JSONObject o = new JSONObject();
                if (!e.ref.isEmpty()) o.put("ref", e.ref);
                o.put("type", e.type);
                if (!e.text.isEmpty()) o.put("text", e.text);
                if (!e.desc.isEmpty()) o.put("desc", e.desc);
                if (!e.resourceId.isEmpty()) o.put("resource_id", e.resourceId);
                int[] c = e.center();
                if (c != null) {
                    o.put("x", c[0]);
                    o.put("y", c[1]);
                }
                if (e.clickable) o.put("clickable", true);
                if (e.editable) o.put("editable", true);
                els.put(o);
            }
            JSONObject root = new JSONObject();
            root.put("app", d.app);
            root.put("screen_width", d.width);
            root.put("screen_height", d.height);
            root.put("total", d.elements.size());
            root.put("elements", els);
            String out = root.toString();
            return out + "\n（通道：Shizuku）"
                    + (els.length() < d.elements.size()
                    ? "\n（控件过多，只列前 " + els.length() + " 个）" : "");
        } catch (Exception e) {
            if (isDenied(e)) throw e;
            throw slowFailed(e);
        }
    }

    /**
     * 按 ref 点击：点击的那一刻重新 dump、重新定位。
     *
     * 找不到就报错并把可用的 ref 列出来 —— **绝不猜坐标**。
     * 猜坐标就是「点错」，而点错的代价（发错消息、删错文件、付款）
     * 远大于「这次没点成」。
     */
    private static String uiTapRef(Context ctx, String ref) throws Exception {
        try {
            DshShizuku.UiDump d = DshShizuku.dumpElements(ctx);
            requireAllowedForDump(ctx, d.app);
            DshShizuku.UiElement e = DshShizuku.findByRef(d, ref);
            if (e == null) {
                StringBuilder avail = new StringBuilder();
                int n = 0;
                for (DshShizuku.UiElement x : d.elements) {
                    if (x.ref.isEmpty() || !x.clickable) continue;
                    if (n++ >= 12) break;
                    if (avail.length() > 0) avail.append("、");
                    avail.append(x.ref);
                }
                throw new Exception("界面上找不到 ref「" + ref + "」（可能屏幕已经变了）。"
                        + (avail.length() > 0 ? "当前可点的 ref 有：" + avail : "当前没有可点的控件。")
                        + "可以改用 ui_dump（format=json）重新取，或用 ui_click_text 按文字点。");
            }
            int[] c = e.center();
            if (c == null) {
                throw new Exception("ref「" + ref + "」对应的控件没有坐标，点不了。");
            }
            DshPointerOverlay.markTap(ctx, c[0], c[1]);
            DshShizuku.tap(ctx, c[0], c[1]);
            String what = !e.text.isEmpty() ? e.text : (!e.desc.isEmpty() ? e.desc : e.resourceId);
            return "已点击 " + e.ref + (what.isEmpty() ? "" : "（" + what + "）")
                    + "(" + c[0] + ", " + c[1] + ")（通道：Shizuku）";
        } catch (Exception e) {
            if (isDenied(e)) throw e;
            throw slowFailed(e);
        }
    }

    private static String uiTap(Context ctx, double x, double y) throws Exception {
        try {
            // 用 dumpsys 取包名（100ms 级），而不是为了校验去 dump 整棵树（1~2 秒）
            uiTarget(ctx);
            int[] p = DshShizuku.toPixels(ctx, x, y);
            DshPointerOverlay.markTap(ctx, p[0], p[1]);
            DshShizuku.tap(ctx, p[0], p[1]);
            return "已点击 (" + p[0] + ", " + p[1] + ")"
                    + (p[2] == 1 ? "（按屏幕比例换算自 " + fmt(x) + ", " + fmt(y) + "）" : "")
                    + " · " + DshShizuku.screenNote(ctx) + "（通道：Shizuku）";
        } catch (Exception e) {
            if (isDenied(e)) throw e;
            throw slowFailed(e);
        }
    }

    private static String uiSwipe(Context ctx, double x1, double y1, double x2, double y2, int ms) throws Exception {
        try {
            uiTarget(ctx);
            int[] a = DshShizuku.toPixels(ctx, x1, y1);
            int[] b = DshShizuku.toPixels(ctx, x2, y2);
            DshPointerOverlay.markSwipe(ctx, a[0], a[1], b[0], b[1]);
            DshShizuku.swipe(ctx, a[0], a[1], b[0], b[1], ms);
            return "已滑动 (" + a[0] + ", " + a[1] + ") → (" + b[0] + ", " + b[1] + ")"
                    + ((a[2] == 1 || b[2] == 1)
                    ? "（按屏幕比例换算自 " + fmt(x1) + "," + fmt(y1) + " → " + fmt(x2) + "," + fmt(y2) + "）"
                    : "")
                    + " · " + DshShizuku.screenNote(ctx) + "（通道：Shizuku）";
        } catch (Exception e) {
            if (isDenied(e)) throw e;
            throw slowFailed(e);
        }
    }

    private static String fmt(double v) {
        return v == Math.rint(v) ? String.valueOf((long) v) : String.valueOf(v);
    }

    private static String uiSetText(Context ctx, String text) throws Exception {
        try {
            uiTarget(ctx);
            return DshShizuku.setText(ctx, text) + "（通道：Shizuku）";
        } catch (Exception e) {
            if (isDenied(e)) throw e;
            throw slowFailed(e);
        }
    }

    private static String uiGlobal(Context ctx, String action) throws Exception {
        try {
            return DshShizuku.global(ctx, action) + "（通道：Shizuku）";
        } catch (Exception e) {
            if (isDenied(e)) throw e;
            throw slowFailed(e);
        }
    }

    /* --------------------------------------------------------------- 工具 */

    private static String req(JSONObject args, String key) throws Exception {
        String v = args.optString(key, "");
        if (v == null || v.isEmpty()) throw new Exception("缺少参数 " + key);
        return v;
    }

    private static JSONObject schema(JSONObject... props) {
        JSONObject properties = new JSONObject();
        JSONArray required = new JSONArray();
        for (JSONObject p : props) {
            try {
                String name = p.getString("__name");
                p.remove("__name");
                properties.put(name, p);
                if (p.optBoolean("__required", false)) {
                    p.remove("__required");
                    required.put(name);
                }
            } catch (Exception ignored) {
            }
        }
        JSONObject s = new JSONObject();
        try {
            s.put("type", "object");
            s.put("properties", properties);
            if (required.length() > 0) s.put("required", required);
        } catch (Exception ignored) {
        }
        return s;
    }

    private static JSONObject prop(String name, String type, String desc) {
        return prop(name, type, desc, false);
    }

    private static JSONObject prop(String name, String type, String desc, boolean required) {
        JSONObject p = new JSONObject();
        try {
            p.put("__name", name);
            p.put("type", type);
            p.put("description", desc);
            if (required) p.put("__required", true);
        } catch (Exception ignored) {
        }
        return p;
    }
}
