package ai.deepseek.dsh.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.ServiceCompat;

/**
 * Node 插件运行时的托管服务。
 *
 * ============ 为什么是前台服务 ============
 *
 * Node 进程一旦被系统回收，所有插件实例、正在跑的定时任务、内存里的状态全部丢失。
 * 而插件恰恰是「装了就该一直在」的东西 —— 用户不会理解「为什么刚才还在的插件没了」。
 *
 * 前台服务把这个进程提到用户可见的优先级，是最不容易被回收的形态。
 * 代价是必须挂一条常驻通知，这是 Android 的硬性要求，绕不开。
 *
 * ============ 崩溃后怎么处理 ============
 *
 * Node 侧一个未捕获异常就能让整个运行时退出（插件代码是第三方写的，不能假设它健壮）。
 * 所以这里做**退避重启**：1s → 2s → 4s … 最多 30s，连续失败 5 次就停下并提示，
 * 避免「崩溃 → 重启 → 立刻崩溃」把电量和日志刷爆。
 */
public class DshNodeService extends Service {

    private static final String TAG = "DshNodeService";
    private static final String CHANNEL_ID = "dsh_node";
    private static final int NOTIF_ID = 0xD5A2;

    /** 连续重启上限。超过说明是代码级问题，重启也不会好。 */
    private static final int MAX_RESTARTS = 5;

    /** Intent 里的标记：这次只下载，不启动 Node。 */
    private static final String EXTRA_DOWNLOAD_ONLY = "downloadOnly";

    private static volatile boolean running = false;

    private Thread worker = null;
    private volatile boolean stopRequested = false;

    public static boolean isRunning() {
        return running;
    }

    /** 启动运行时。重复调用是安全的。 */
    public static void start(Context ctx) {
        if (running) return;
        try {
            Intent i = new Intent(ctx, DshNodeService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
            running = true;
        } catch (Throwable e) {
            Log.e(TAG, "启动服务失败：" + e.getMessage());
        }
    }

    /**
     * 只下载运行时，不启动 Node。
     *
     * ============ 为什么下载和启动要分开 ============
     *
     * 运行时是 88 MB。应用一装完就自动下这个，用户完全没同意 ——
     * 而且第一次下多半是在 WiFi 下（不对），下完才发现手机存储不够、
     * 或者用户根本不需要插件，白占 88 MB。
     *
     * 所以拆成两个动作：
     *   · 用户在设置页点「下载运行时」→ 只下载
     *   · 用户装好插件后打开开关 → 才启动
     *
     * 下载完也不自动启动 —— 第一次启动由用户主动触发。
     */
    public static void downloadOnly(Context ctx) {
        try {
            Intent i = new Intent(ctx, DshNodeService.class);
            i.putExtra(EXTRA_DOWNLOAD_ONLY, true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
        } catch (Throwable e) {
            Log.e(TAG, "启动下载失败：" + e.getMessage());
        }
    }

    /** 停止运行时。 */
    public static void stop(Context ctx) {
        try {
            ctx.stopService(new Intent(ctx, DshNodeService.class));
        } catch (Throwable ignored) {
        }
        running = false;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;

        if (!DshNodeRuntime.available()) {
            Log.e(TAG, "原生库不可用：" + DshNodeRuntime.unavailableReason());
            notify("插件运行时不可用：" + DshNodeRuntime.unavailableReason());
            stopSelf();
            return;
        }

        // 必须在这里（而不是 onStartCommand）调 startForeground：
        // 系统要求前台服务在启动后 5 秒内进入前台，否则 ANR + 崩溃。
        startForegroundCompat("插件运行时启动中");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 下载与启动是两条不同的路径，由 intent 里的标记区分。
        // 放在 onStartCommand 而不是 onCreate，是因为 onCreate 拿不到 intent。
        boolean downloadOnly = intent != null
                && intent.getBooleanExtra(EXTRA_DOWNLOAD_ONLY, false);
        startNode(downloadOnly);
        // 被系统杀掉后重建：保持运行，不依赖 intent
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopRequested = true;
        if (worker != null) {
            worker.interrupt();
            worker = null;
        }
        running = false;
        // 关掉通道监听：否则端口一直被占着，
        // 而且挂着的请求永远等不到回答（Node 已经没了）。
        DshNodeChannel.get().stopServer();
        super.onDestroy();
    }

    /* ---------------- 内部 ---------------- */

    private void startNode(boolean downloadOnly) {
        worker = new Thread(() -> {
            // 运行时（libnode.so，88 MB 压缩包）是下载来的，不是内置的。
            // 没装就绪就没有 node::Start 可调 —— 这是唯一的入口。
            if (!DshNodeRuntime.runtimeInstalled(this)) {
                if (!downloadOnly) {
                    // 用户想启动但运行时还没装：不要自作主张下 88 MB，
                    // 告诉他没装，让他去设置页点下载。
                    Log.w(TAG, "运行时未安装，拒绝启动（不自动下载）");
                    notify("插件运行时未安装，请在设置里下载");
                    running = false;
                    stopSelf();
                    return;
                }
                if (!prepareRuntime()) {
                    running = false;
                    stopSelf();
                    return;
                }
                // 只下载模式：下完就收工，不启动 Node
                notify("运行时已下载完成");
                running = false;
                stopSelf();
                return;
            }

            int restarts = 0;
            while (!stopRequested) {
                long began = System.currentTimeMillis();
                int rc = DshNodeRuntime.run(this);
                long lived = System.currentTimeMillis() - began;

                if (stopRequested) break;

                // 跑够久就重置计数：偶发崩溃不该累计到上限
                if (lived > 60_000L) restarts = 0;

                restarts += 1;
                if (restarts > MAX_RESTARTS) {
                    Log.e(TAG, "连续 " + restarts + " 次退出，停止重启");
                    notify("插件运行时反复退出，已停止（看日志定位）");
                    break;
                }

                long wait = Math.min(30_000L, 1000L << Math.min(5, restarts - 1));
                Log.w(TAG, "Node 退出 rc=" + rc + "，" + wait + "ms 后重启");
                notify("插件运行时已退出，正在重启…");
                try {
                    Thread.sleep(wait);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            running = false;
        }, "dsh-node");
        worker.start();
    }

    /**
     * 下载并安装运行时。
     *
     * @return 成功与否；失败时已经更新过通知，直接收工
     */
    private boolean prepareRuntime() {
        notify("正在下载 Node 运行时（88 MB）…");
        Thread ticker = new Thread(() -> {
            // 88 MB 要几分钟，通知不刷新的话用户会以为卡死
            while (DshNodeRuntime.isDownloading() && !stopRequested) {
                notify("正在下载 Node 运行时 " + DshNodeRuntime.downloadPercent() + "%");
                try {
                    Thread.sleep(1500L);
                } catch (InterruptedException e) {
                    return;
                }
            }
        }, "dsh-node-dl-ui");
        ticker.setDaemon(true);
        ticker.start();

        try {
            DshNodeRuntime.downloadRuntime(this);
            notify("运行时已就绪，正在启动…");
            return true;
        } catch (Throwable e) {
            Log.e(TAG, "运行时准备失败：" + e.getMessage(), e);
            notify("运行时下载失败：" + e.getMessage());
            return false;
        } finally {
            ticker.interrupt();
        }
    }

    private void startForegroundCompat(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "插件运行时", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Node.js 插件运行时（DSH Mobile）");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int piFlags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, piFlags);

        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        b.setContentTitle("DSH 插件运行时")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setOngoing(true)
                .setContentIntent(pi);

        Notification n = b.build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // dataSync：这是一段持续的后台数据处理，语义最接近
            ServiceCompat.startForeground(this, NOTIF_ID, n,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }

    private void notify(String text) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm == null) return;
            Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Notification.Builder(this, CHANNEL_ID)
                    : new Notification.Builder(this);
            b.setContentTitle("DSH 插件运行时")
                    .setContentText(text)
                    .setSmallIcon(android.R.drawable.stat_sys_download_done)
                    .setOngoing(true);
            nm.notify(NOTIF_ID, b.build());
        } catch (Throwable ignored) {
        }
    }
}
