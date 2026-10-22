package ai.deepseek.dsh.mobile;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import android.util.Log;

/**
 * `:device` 进程的入口服务 —— 只负责两件事：保住这个进程、启停 MCP server。
 *
 * ============ 为什么要有这个进程 ============
 *
 * 之前无障碍服务、MCP server 和 WebView 挤在同一个进程里。系统的清理是按进程算的，
 * 它要清的是那个几百 MB 的 WebView 进程，顺手把无障碍也带走了 ——
 * 用户看到的就是「切到别的应用，ui_* 立刻报未开启」。
 *
 * 现在拆成两个：
 *
 *   :device 进程（轻，几十 MB）      默认进程（重，几百 MB）
 *   ├─ DshMcpServer（127.0.0.1:8788）  └─ WebView + UI + agent
 *   └─ DshShizuku（Shizuku 通道客户端）
 *
 * 主进程通过 HTTP 调 MCP，本来就是跨进程的，架构不用改。
 *
 * 这样即使 WebView 进程被回收，无障碍服务和 MCP 还在；
 * 用户切回来时 WebView 重建，立刻就能继续用，**不需要重新打开无障碍开关**。
 *
 * ============ 为什么不用 ContentProvider 启动 ============
 *
 * DshMcpBootstrap 是 ContentProvider，只在**进程创建时**执行一次。
 * 如果用户先关掉本机控制（server 停止）再打开，进程还活着，Provider 不会再跑，
 * server 就起不来了。所以启停必须由一个 Service 承担，Provider 只做首次启动的兜底。
 */
public class DshDeviceService extends Service {

    private static final String TAG = "DshDevice";

    /** 从主进程带过来的「是否启用」，避免 :device 读到自己那份过期的 SharedPreferences 缓存。 */
    public static final String EXTRA_ENABLED = "enabled";

    /** 申请 Shizuku 授权（必须在本进程执行 —— bindUserService 的连接状态在本进程）。 */
    public static final String ACTION_SHIZUKU_REQUEST = "ai.deepseek.dsh.mobile.SHIZUKU_REQUEST";
    /** 主动建立 Shizuku UserService 连接。 */
    public static final String ACTION_SHIZUKU_CONNECT = "ai.deepseek.dsh.mobile.SHIZUKU_CONNECT";
    /** 强制重启 MCP server（设置页「重新连接」用）。 */
    public static final String ACTION_RESTART = "ai.deepseek.dsh.mobile.MCP_RESTART";

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            String action = intent == null ? null : intent.getAction();
            if (ACTION_SHIZUKU_REQUEST.equals(action)) {
                DshA11yDiagnostics.log(this, "shizuku：收到授权请求");
                // 必须开线程：request() 里可能等 2 秒让 binder 到达，
                // 在主线程等就是 ANR，而且会把整个 :device（含无障碍）拖下水。
                new Thread(() -> DshShizuku.request(DshDeviceService.this), "shizuku-request")
                        .start();
                return START_STICKY;
            }
            if (ACTION_SHIZUKU_CONNECT.equals(action)) {
                // connect() 会最多等 4 秒，**绝对不能放在主线程** ——
                // onStartCommand 阻塞超过 5 秒就是 ANR，而且这会连带把整个
                // :device 进程（含无障碍）拖下水。
                new Thread(() -> {
                    boolean ok = DshShizuku.connect(DshDeviceService.this);
                    DshA11yDiagnostics.log(DshDeviceService.this,
                            "shizuku：连接结果 " + (ok ? "成功" : "失败"));
                }, "shizuku-connect").start();
                return START_STICKY;
            }

            if (ACTION_RESTART.equals(action)) {
                // 先 stop 再 start：start() 看到 instance 非空会直接 return，
                // 而「重新连接」要解决的正是「实例还在、实际已经不能 accept」。
                DshMcpServer.stop();
                DshMcpServer.start(getApplicationContext());
                DshA11yDiagnostics.log(this, "device：收到重启请求，server 已重建");
                return START_STICKY;
            }

            // ============ 这里曾经把 server「越重建越关」（0.27.1 修）============
            //
            // 旧写法：`boolean enabled = intent != null && intent.getBooleanExtra(...)`
            //
            // START_STICKY 重建时系统给的 intent **一定是 null**，于是 enabled 恒为 false，
            // 代码走进 else 分支把 server 主动停掉。而这次重建恰恰是因为进程被系统回收 ——
            // 也就是说「被杀 → 拉起来 → 立刻自己关掉服务」成了固定剧本。
            // 用户看到的就是：前台好好的，切走一会儿回来就连不上，过一阵又好了。
            //
            // 现在：intent 里有明确意图才用它；重建（null）时读持久化状态。
            boolean enabled;
            if (intent != null && intent.hasExtra(EXTRA_ENABLED)) {
                enabled = intent.getBooleanExtra(EXTRA_ENABLED, true);
            } else {
                enabled = DshMcpPolicy.isEnabled(getApplicationContext());
                DshA11yDiagnostics.log(this, "device：无 intent（进程被重建），按持久化状态 "
                        + (enabled ? "继续运行" : "保持关闭"));
            }
            if (enabled) {
                DshMcpServer.start(getApplicationContext());
                DshA11yDiagnostics.log(this, "device：MCP server 启动请求，进程 pid="
                        + android.os.Process.myPid());
            } else {
                DshMcpServer.stop();
                DshA11yDiagnostics.log(this, "device：MCP server 停止请求");
            }
        } catch (Throwable t) {
            Log.w(TAG, "start command failed: " + t);
        }
        // START_STICKY：进程被回收后系统会重新拉起，此时按 Provider 里读到的持久化状态决定
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        try {
            DshMcpServer.stop();
        } catch (Throwable ignored) {
        }
        super.onDestroy();
    }

    /** 从主进程拉起 :device 并启动 server。 */
    public static void start(android.content.Context ctx, boolean enabled) {
        try {
            Intent i = new Intent(ctx, DshDeviceService.class);
            i.putExtra(EXTRA_ENABLED, enabled);
            ctx.startService(i);
        } catch (Throwable t) {
            Log.w(TAG, "start device service failed: " + t);
        }
    }

    /** 发一个不带 enabled 参数的动作（Shizuku 授权等）。 */
    public static void sendAction(android.content.Context ctx, String action) {
        try {
            Intent i = new Intent(ctx, DshDeviceService.class);
            i.setAction(action);
            ctx.startService(i);
        } catch (Throwable t) {
            Log.w(TAG, "send action failed: " + t);
        }
    }

    /**
     * 强制重建 MCP server。
     *
     * 和 {@link #start} 的区别：start 只保证「进程里有这个服务」，
     * 而这里要解决「服务对象还在、socket 已经不能 accept」——
     * 那种情况 start 会被 instance != null 挡回去，什么也不做。
     */
    public static void restart(android.content.Context ctx) {
        sendAction(ctx, ACTION_RESTART);
    }

    /** 停掉 server（不杀进程 —— 无障碍服务可能还在里面跑）。 */
    public static void stop(android.content.Context ctx) {
        try {
            ctx.stopService(new Intent(ctx, DshDeviceService.class));
        } catch (Throwable ignored) {
        }
    }
}
