package ai.deepseek.dsh.mobile;

import android.content.Context;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * 跑在 **shell 进程**里的执行体。
 *
 * ============ 它不是普通的 Service ============
 *
 * Shizuku 的 UserService 不走 Android 的 bindService：
 * 它会在 shell 进程里**直接 new 这个类**，然后把实例当作 IBinder 使用。
 *
 * 所以这里必须 `extends IShizukuExec.Stub`，而**不是** `extends Service` ——
 * 写成 Service + onBind 的示例在 Shizuku 里根本不会被调用，
 * 表现是 `bindUserService` 之后 `onServiceConnected` 永远不触发。
 *
 * 同样地，它**不能也不需要**在 AndroidManifest 里声明：
 * 它不经过 AMS 绑定，是 Shizuku 用反射 attach 进来的。
 *
 * 构造函数可以有两个：无参，和带 Context 的。Shizuku v13 优先用带 Context 的那个。
 * 注意那个 Context 不是普通应用 Context —— `getContentResolver` / `registerReceiver`
 * 这类依赖应用框架的能力在这里不可用。我们只跑 shell 命令，用不到。
 *
 * ============ 为什么这条路比无障碍稳 ============
 *
 * 无障碍的权限来自「系统对应用的 AccessibilityService 绑定」。OEM 的省电策略
 * 会把那条绑定摘掉（改写 `enabled_accessibility_services`），应用侧只能干看着。
 *
 * Shizuku 的权限来自 ADB（或 root），落在 shell 进程里（uid 2000）。
 * 它不经过 AccessibilityManagerService，所以**无障碍被摘不影响它**。
 */
public class DshShizukuService extends IShizukuExec.Stub {

    private static final String TAG = "DshShizukuSvc";

    /** Binder 单次事务上限 1MB，留出余量。 */
    private static final int MAX_OUTPUT = 900 * 1024;

    /** 单条命令的硬超时。`uiautomator dump` 正常 1~3 秒，卡住多半是系统异常。 */
    private static final long TIMEOUT_MS = 15000;

    public DshShizukuService() {
    }

    @SuppressWarnings("unused") // Shizuku v13 会优先调用这个构造
    public DshShizukuService(Context ctx) {
    }

    @Override
    public String exec(String cmd) {
        return run(cmd);
    }

    /**
     * 执行命令并合并 stdout / stderr。
     *
     * `redirectErrorStream(true)` 不是为了好看：如果不合并，命令往 stderr 写满
     * 缓冲区而没人读，子进程会阻塞在 write 上，整个调用卡死到超时。
     */
    private String run(String cmd) {
        if (cmd == null || cmd.trim().isEmpty()) return "";
        Process p = null;
        Thread killer = null;
        try {
            ProcessBuilder pb = new ProcessBuilder("sh", "-c", cmd);
            pb.redirectErrorStream(true);
            p = pb.start();

            final Process target = p;
            killer = new Thread(() -> {
                try {
                    Thread.sleep(TIMEOUT_MS);
                    target.destroy();
                } catch (InterruptedException ignored) {
                } catch (Throwable ignored) {
                }
            });
            killer.setDaemon(true);
            killer.start();

            InputStream in = p.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) >= 0) {
                int room = MAX_OUTPUT - buf.size();
                if (room <= 0) break;
                buf.write(b, 0, Math.min(n, room));
            }
            int code = p.waitFor();
            String out = buf.toString("UTF-8");
            if (buf.size() >= MAX_OUTPUT) {
                out += "\n…（输出超过 " + (MAX_OUTPUT / 1024) + "KB，已截断）";
            }
            if (code != 0) {
                out = out + "\n（退出码 " + code + "）";
            }
            return out;
        } catch (Throwable t) {
            Log.w(TAG, "exec failed: " + t);
            return "ERR " + t.getClass().getSimpleName() + ": " + t.getMessage();
        } finally {
            if (killer != null) killer.interrupt();
            if (p != null) {
                try {
                    p.destroy();
                } catch (Throwable ignored) {
                }
            }
        }
    }
}
