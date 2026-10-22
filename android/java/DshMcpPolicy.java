package ai.deepseek.dsh.mobile;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 本机 MCP 的「允许控制哪些应用」白名单。
 *
 * 设计目标（对应「保持最小敏感权限」这条要求）：
 *
 * 1. **默认全关。** 刚装上时白名单是空的，一个应用都不允许操作。
 *    用户必须自己在设置里逐个勾选，App 才碰得了那些应用。
 *
 * 2. **只认显式勾选。** 任何 app_* / ui_* 工具在动手之前，
 *    都要先问这个类「目标包名在白名单里吗」。不在 → 直接拒绝，
 *    并且把当前白名单报给模型，让它知道边界在哪。
 *
 * 3. **不依赖 QUERY_ALL_PACKAGES。** 列出可启动应用走
 *    <queries> 的 MAIN/LAUNCHER intent 过滤器，只暴露「有启动入口」的应用，
 *    拿不到后台服务、拿不到系统私有包。敏感面比 QUERY_ALL_PACKAGES 小得多。
 *
 * 4. **系统自己的包永远允许。** DSH 自己的包名、设置页、系统 Intent
 *    这些不是「用户数据」，不受白名单限制，否则连设置页都打不开。
 */
public final class DshMcpPolicy {

    private static final String PREFS = "dsh_mcp_policy";
    private static final String KEY_ALLOWED = "allowed_packages";
    private static final String KEY_ENABLED = "server_enabled";

    /** 「本机控制是否开启」的文件副本，给 :device 重建时读（prefs 跨进程不可靠）。 */
    private static final String ENABLE_FILE = "mcp-enabled.txt";

    private static final Set<String> ALWAYS_ALLOWED = new LinkedHashSet<>();

    static {
        // DSH 自己
        ALWAYS_ALLOWED.add("ai.deepseek.dsh.mobile");
        // 常见系统页面的宿主包：设置、拨号、短信、浏览器、系统 UI
        ALWAYS_ALLOWED.add("com.android.settings");
        ALWAYS_ALLOWED.add("com.android.dialer");
        ALWAYS_ALLOWED.add("com.google.android.dialer");
        ALWAYS_ALLOWED.add("com.android.contacts");
        ALWAYS_ALLOWED.add("com.google.android.contacts");
        ALWAYS_ALLOWED.add("com.android.mms");
        ALWAYS_ALLOWED.add("com.google.android.apps.messaging");
        ALWAYS_ALLOWED.add("com.android.chrome");
        ALWAYS_ALLOWED.add("com.google.android.googlequicksearchbox");
        ALWAYS_ALLOWED.add("com.android.systemui");
        ALWAYS_ALLOWED.add("com.android.shell");
        // 系统自己的对话框（ANR、崩溃、应用无响应、系统提示）宿主是 "android"。
        // 不放行的话，一个弹窗就能把 Agent 卡死 —— 它连"等待/关闭"都点不了。
        //
        // 注意：权限授予弹窗是 com.android.permissioncontroller，
        // **故意不放行** —— 否则 Agent 可以自己给自己加权限，白名单就形同虚设。
        ALWAYS_ALLOWED.add("android");
    }

    private DshMcpPolicy() {
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /*
     * ============ 白名单为什么改用文件 ============
     *
     * 白名单是「哪些应用允许被控制」，它必须被**两个进程**看到：
     *   - 主进程：设置页读取、勾选、回显
     *   - :device 进程：ui_* / app_* 工具执行前逐个校验
     *
     * 而 SharedPreferences 是进程内缓存的。A 进程写入之后，B 进程手里的
     * 还是旧快照 —— 表现为「刚勾上的应用，Agent 调用时仍然说不在白名单」，
     * 或者更糟：刚取消勾选的应用还能被操作。
     *
     * 白名单改动频率极低（用户手动勾选），直接读写文件完全够用，
     * 而且文件是所有进程共享的，不存在缓存问题。
     *
     * 旧数据（SharedPreferences 里的 KEY_ALLOWED）会在首次读文件时迁移过来，
     * 迁移后就把旧键删掉，避免两份数据打架。
     */
    private static java.io.File allowFile(Context ctx) {
        return new java.io.File(ctx.getApplicationContext().getFilesDir(), "mcp-allowed.txt");
    }

    /* ------------------------------------------------------------ 开关 */

    /** 本机 MCP 服务是否启用。默认关闭。 */
    public static boolean isEnabled(Context ctx) {
        // ============ 文件优先（0.27.1）============
        //
        // 这个值不只给界面看，还要回答 :device 进程的一句话：
        // 「我现在是被系统按 START_STICKY 拉起来的，到底该不该继续跑？」
        //
        // 而 SharedPreferences 是进程内缓存。:device 被回收重建后，
        // 它手里的 prefs 可能是空的 / 旧的 —— 读出来就是 false，
        // 于是重建的那一刻主动把 server 关掉。用户看到的就是「连接时好时坏」。
        //
        // 文件是所有进程共享的，不存在这个问题。
        try {
            java.io.File f = new java.io.File(ctx.getApplicationContext().getFilesDir(), ENABLE_FILE);
            if (f.exists()) {
                String v = readText(f).trim();
                return "1".equals(v) || "true".equalsIgnoreCase(v);
            }
        } catch (Throwable ignored) {
        }
        return prefs(ctx).getBoolean(KEY_ENABLED, false);
    }

    public static void setEnabled(Context ctx, boolean enabled) {
        prefs(ctx).edit().putBoolean(KEY_ENABLED, enabled).apply();
        try {
            java.io.File f = new java.io.File(ctx.getApplicationContext().getFilesDir(), ENABLE_FILE);
            try (java.io.OutputStreamWriter w = new java.io.OutputStreamWriter(
                    new java.io.FileOutputStream(f), java.nio.charset.StandardCharsets.UTF_8)) {
                w.write(enabled ? "1" : "0");
            }
        } catch (Throwable ignored) {
        }
    }

    /* ---------------------------------------------------------- 白名单 */

    /** 当前允许控制的包名集合（不含系统固定放行的那些）。 */
    public static Set<String> allowedPackages(Context ctx) {
        Set<String> out = new LinkedHashSet<>();
        try {
            java.io.File f = allowFile(ctx);
            if (!f.exists()) {
                migrateFromPrefs(ctx);
            }
            if (!f.exists()) return out;
            String raw = readText(f);
            for (String p : raw.split("\n")) {
                String t = p.trim();
                if (!t.isEmpty()) out.add(t);
            }
        } catch (Throwable ignored) {
        }
        return out;
    }

    /** 把老版本存在 SharedPreferences 里的白名单搬到文件，只搬一次。 */
    private static void migrateFromPrefs(Context ctx) {
        try {
            String raw = prefs(ctx).getString(KEY_ALLOWED, "");
            if (raw == null || raw.trim().isEmpty()) return;
            Set<String> tmp = new LinkedHashSet<>();
            for (String p : raw.split("\n")) {
                String t = p.trim();
                if (!t.isEmpty()) tmp.add(t);
            }
            if (tmp.isEmpty()) return;
            writeAllowFile(ctx, tmp);
            prefs(ctx).edit().remove(KEY_ALLOWED).apply();
        } catch (Throwable ignored) {
        }
    }

    private static void writeAllowFile(Context ctx, Set<String> set) {
        try {
            java.io.File f = allowFile(ctx);
            // 用传统 IO：java.nio.file.Files 是 API 26 才有的，
            // 本项目 minSdk 22，用它在 Android 6/7 上会直接 NoClassDefFoundError。
            try (java.io.OutputStreamWriter w = new java.io.OutputStreamWriter(
                    new java.io.FileOutputStream(f), java.nio.charset.StandardCharsets.UTF_8)) {
                w.write(String.join("\n", set));
            }
        } catch (Throwable ignored) {
        }
    }

    private static String readText(java.io.File f) {
        StringBuilder sb = new StringBuilder();
        try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.InputStreamReader(
                new java.io.FileInputStream(f), java.nio.charset.StandardCharsets.UTF_8))) {
            String line;
            boolean first = true;
            while ((line = r.readLine()) != null) {
                if (!first) sb.append('\n');
                sb.append(line);
                first = false;
            }
        } catch (Throwable ignored) {
        }
        return sb.toString();
    }

    /** 用逗号或换行分隔的字符串覆盖白名单。 */
    public static void setAllowedPackages(Context ctx, String csv) {
        Set<String> out = new LinkedHashSet<>();
        if (csv != null) {
            for (String p : csv.split("[,\\n]")) {
                String t = p.trim();
                if (!t.isEmpty()) out.add(t);
            }
        }
        writeAllowFile(ctx, out);
    }

    public static void addAllowed(Context ctx, String pkg) {
        if (pkg == null || pkg.trim().isEmpty()) return;
        Set<String> cur = allowedPackages(ctx);
        cur.add(pkg.trim());
        setAllowedPackages(ctx, String.join("\n", cur));
    }

    public static void removeAllowed(Context ctx, String pkg) {
        if (pkg == null) return;
        Set<String> cur = allowedPackages(ctx);
        cur.remove(pkg.trim());
        setAllowedPackages(ctx, String.join("\n", cur));
    }

    /**
     * 目标包名是否允许被本机 MCP 操作。
     *
     * @param pkg       目标包名
     * @param isSystem  目标是不是系统自带的东西（设置页 / 拨号 / 系统 Intent）——
     *                  这类不受白名单限制
     */
    public static boolean isAllowed(Context ctx, String pkg, boolean isSystem) {
        if (pkg == null || pkg.trim().isEmpty()) return false;
        String t = pkg.trim();
        if (ALWAYS_ALLOWED.contains(t)) return true;
        if (isSystem) return true;
        return allowedPackages(ctx).contains(t);
    }

    /** 只查白名单（不含系统放行），用于界面显示状态。 */
    public static boolean isExplicitlyAllowed(Context ctx, String pkg) {
        return pkg != null && allowedPackages(ctx).contains(pkg.trim());
    }

    /** 给模型看的白名单说明，让它知道边界。 */
    public static String describeScope(Context ctx) {
        Set<String> list = allowedPackages(ctx);
        if (list.isEmpty()) {
            return "当前没有允许控制任何应用。"
                    + "所有 app_* 与 ui_* 工具都会拒绝执行。"
                    + "用户可以在「设置 → 本机控制」里逐个勾选要允许的应用。";
        }
        List<String> sorted = new ArrayList<>(list);
        Collections.sort(sorted);
        return "当前允许控制的应用（" + sorted.size() + " 个）：" + String.join(", ", sorted)
                + "。其它应用一律拒绝。若要操作别的应用，请提示用户在「设置 → 本机控制」里添加。";
    }
}
