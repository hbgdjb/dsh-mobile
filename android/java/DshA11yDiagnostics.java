package ai.deepseek.dsh.mobile;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.Date;
import java.util.Deque;
import java.util.Locale;

/**
 * 无障碍的生命周期诊断日志。
 *
 * ============ 为什么要这个 ============
 *
 * 「打开无障碍开关、离开页面就自己关闭」这个现象，在用户侧看起来是一个问题，
 * 但在 Android 里其实是**至少三种完全不同的故障**，处理方式截然相反：
 *
 *   A. 服务从来没连上过（onServiceConnected 没被调用）
 *      → 系统在绑定阶段就拒绝了：受限设置没放行、服务配置无效、或包可见性有问题
 *
 *   B. 连上了，随后进程被杀，服务被解绑
 *      → 缓存/省电策略（vivo/OPPO 常见），需要保活 + 系统白名单
 *
 *   C. 连上了，服务里抛了未捕获异常，系统主动禁用
 *      → 代码 bug，必须修代码
 *
 * 不记录就无法区分这三者 —— 前两轮修复都在猜（一次猜 FGS 时机、一次猜生命周期），
 * 结果两轮都没打中。所以这里把关键事件全部落盘，用户下次反馈时能直接看到
 * 「到底是连上了又断，还是压根没连上」。
 *
 * 日志写在应用私有目录（不需要任何权限），环形保留最近 200 条。
 */
public final class DshA11yDiagnostics {

    private static final String TAG = "DshA11yDiag";
    /** 主进程与 :device 各写各的，避免两个进程同时追加同一个文件。 */
    private static final String FILE_APP = "a11y-diag-app.log";
    private static final String FILE_DEVICE = "a11y-diag-device.log";
    private static final int MAX_LINES = 200;

    /**
     * 当前进程是不是 `:device`。
     *
     * 直接读 /proc/self/cmdline，比 Application.getProcessName()（API 28+）
     * 更兼容：本项目 minSdk 22。
     */
    private static boolean isDeviceProcess() {
        try (java.io.FileInputStream in = new java.io.FileInputStream("/proc/self/cmdline")) {
            byte[] buf = new byte[256];
            int n = in.read(buf);
            if (n <= 0) return false;
            int end = 0;
            while (end < n && buf[end] != 0) end++;
            String name = new String(buf, 0, end, java.nio.charset.StandardCharsets.UTF_8);
            return name.endsWith(":device");
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static String fileForCurrentProcess() {
        return isDeviceProcess() ? FILE_DEVICE : FILE_APP;
    }

    private DshA11yDiagnostics() {
    }

    /**
     * 追加一条事件。
     *
     * 全链路 try/catch：诊断本身绝不能成为新的故障源 ——
     * 尤其它会被 onServiceConnected 这种"崩了就会被系统禁用"的回调调用。
     */
    public static void log(Context ctx, String event) {
        if (ctx == null) return;
        try {
            String line = new SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault())
                    .format(new Date()) + "  " + (isDeviceProcess() ? "[dev] " : "[app] ") + event;
            Log.i(TAG, line);

            File f = new File(ctx.getFilesDir(), fileForCurrentProcess());
            // 超过上限时丢掉前半段，避免无限增长
            if (f.exists() && f.length() > 32 * 1024) {
                java.util.List<String> keep = readLines(f);
                int from = Math.max(0, keep.size() - MAX_LINES / 2);
                try (PrintWriter w = new PrintWriter(new FileWriter(f, false))) {
                    for (int i = from; i < keep.size(); i++) w.println(keep.get(i));
                }
            }
            try (PrintWriter w = new PrintWriter(new FileWriter(f, true))) {
                w.println(line);
            }
        } catch (Throwable ignored) {
            // 诊断失败就算了，绝不外抛
        }
    }

    /**
     * 读取最近的事件（新的在前）。
     *
     * 两个进程各写一个文件，这里合并后统一按行首时间戳排序 ——
     * 否则排查时看到的会是「设备进程那一段」和「主进程那一段」两个孤立的片段，
     * 而真正要看的是它们**交错**的时间线（比如「主进程 10:07 重启，设备进程没动」）。
     */
    public static String read(Context ctx, int limit) {
        if (ctx == null) return "";
        try {
            java.util.List<String> all = new java.util.ArrayList<>();
            all.addAll(readLines(new File(ctx.getFilesDir(), FILE_DEVICE)));
            all.addAll(readLines(new File(ctx.getFilesDir(), FILE_APP)));
            if (all.isEmpty()) return "";

            // 行首是 "MM-dd HH:mm:ss"，同一年内字典序即时间序
            java.util.Collections.sort(all);
            StringBuilder sb = new StringBuilder();
            for (int i = all.size() - 1, n = 0; i >= 0 && n < limit; i--, n++) {
                sb.append(all.get(i)).append('\n');
            }
            return sb.toString().trim();
        } catch (Throwable t) {
            return "";
        }
    }

    /** 清空日志（设置页的「清空诊断」按钮）。 */
    public static void clear(Context ctx) {
        if (ctx == null) return;
        try {
            new File(ctx.getFilesDir(), FILE_APP).delete();
            new File(ctx.getFilesDir(), FILE_DEVICE).delete();
        } catch (Throwable ignored) {
        }
    }

    private static java.util.List<String> readLines(File f) {
        java.util.List<String> out = new java.util.ArrayList<>();
        try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.FileReader(f))) {
            String s;
            while ((s = r.readLine()) != null) out.add(s);
        } catch (Throwable ignored) {
        }
        return out;
    }
}
