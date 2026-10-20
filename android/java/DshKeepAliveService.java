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
import android.os.PowerManager;

import androidx.core.app.ServiceCompat;

/**
 * DSH 保活前台服务。
 *
 * 问题：Agent 跑长任务时，用户切到别的应用，系统会因为内存紧张回收本应用的进程。
 * 进程一死，这次运行的执行器（JS 里的 AbortController、正在流式的那条消息）全没了，
 * 用户回到应用看到的就是"记录坏了、停不下来"。
 *
 * 解法：运行期间把服务提升为前台服务（foreground service），
 * 系统会把它当成用户可见的活跃服务，优先级提高，不容易被回收。
 * 任务结束或应用被切到后台一段时间后自动停止。
 *
 * 通知是必要的：Android 要求前台服务必须挂一条常驻通知。
 */
public class DshKeepAliveService extends Service {

    private static final String CHANNEL_ID = "dsh_run";
    private static final int NOTIF_ID = 0xD5A1;

    private static volatile boolean running = false;
    private PowerManager.WakeLock wakeLock = null;

    public static boolean isRunning() {
        return running;
    }

    /** 开始保活：重复调用是安全的。 */
    public static void start(Context ctx) {
        if (running) return;
        try {
            Intent i = new Intent(ctx, DshKeepAliveService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
            running = true;
        } catch (Exception ignored) {
        }
    }

    /** 结束保活。 */
    public static void stop(Context ctx) {
        try {
            ctx.stopService(new Intent(ctx, DshKeepAliveService.class));
        } catch (Exception ignored) {
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
        createChannel();
        // 用 ServiceCompat 显式带上服务类型：
        // Android 14 起两参数 startForeground 依赖 manifest 里的类型推断，
        // 显式传更稳，不会因 manifest 变动而抛 MissingForegroundServiceTypeException。
        ServiceCompat.startForeground(
                this,
                NOTIF_ID,
                buildNotification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        );
        acquireWakeLock();
    }

    /**
     * 持 PARTIAL_WAKE_LOCK，避免 CPU 在后台休眠。
     *
     * 少了这一把，屏幕关掉或后台待上几分钟后 CPU 进入休眠，
     * SSE socket 的读事件不再投递——任务不是"被杀掉"，而是"卡住不动"，
     * 用户看到的就是切回来发现停在半路。唤醒锁是让流继续推进的关键。
     */
    private void acquireWakeLock() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "DSH:agent-run");
            // setReferenceCounted(false)：单次 acquire 即可，避免多 release 抛异常
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(12 * 60 * 60 * 1000L); // 最多持 12 小时，到期自动释放
        } catch (Throwable ignored) {
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Throwable ignored) {
        }
        wakeLock = null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 被系统重启时也重新挂上通知
        ServiceCompat.startForeground(
                this,
                NOTIF_ID,
                buildNotification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        );
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        releaseWakeLock();
        try {
            stopForeground(true);
        } catch (Exception ignored) {
        }
        super.onDestroy();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm == null) return;
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID,
                    "运行状态",
                    NotificationManager.IMPORTANCE_LOW
            );
            ch.setDescription("Agent 正在执行任务时保持应用存活");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        } catch (Exception ignored) {
        }
    }

    private Notification buildNotification() {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            b = new Notification.Builder(this, CHANNEL_ID);
        } else {
            b = new Notification.Builder(this);
        }
        b.setContentTitle("DSH 正在执行任务")
                .setContentText("保持应用存活，任务不会被系统中断")
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setOngoing(true)
                .setPriority(Notification.PRIORITY_LOW);
        try {
            Intent open = new Intent(this, MainActivity.class);
            open.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
            b.setContentIntent(PendingIntent.getActivity(this, 0, open, flags));
        } catch (Exception ignored) {
        }
        return b.build();
    }
}
