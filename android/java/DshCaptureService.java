package ai.deepseek.dsh.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import java.nio.ByteBuffer;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 截图前台服务 —— MediaProjection 抓一帧，存 PNG，投递回 DSH。
 *
 * ============ 为什么必须是前台服务 ============
 *
 * Android 10 起，MediaProjection 拿到的 MediaProjection 对象
 * 必须在创建它的进程里保持"前台服务 + 活跃"状态，否则连接会被回收，
 * 表现为"授权成功了但截出来是黑屏"。
 *
 * 而且前台服务的 startForeground 必须在 5 秒内调用，否则系统抛
 * ForegroundServiceDidNotStartInTimeException 直接崩。
 *
 * ============ 为什么是 mediaProjection 类型 ============
 *
 * Android 14 (API 34) 起，MediaProjection 必须声明
 * foregroundServiceType="mediaProjection"，并且服务里调用
 * startForeground(id, notif, FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)。
 * 用错类型直接抛 SecurityException。
 *
 * ============ 抓几帧 ============
 *
 * 第一帧往往是黑的（VirtualDisplay 刚建立，缓冲区还没填）。
 * 所以等 300ms 之后连抓最多 5 帧，取第一张"不是全黑"的。
 */
public class DshCaptureService extends Service {

    private static final String CHANNEL_ID = "dsh_ime_capture";
    private static final int NOTIF_ID = 0x1A5E;

    private static final String EXTRA_RESULT_CODE = "rc";
    private static final String EXTRA_RESULT_DATA = "rd";

    private final Handler main = new Handler(Looper.getMainLooper());

    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;

    private int attempts = 0;
    private MediaProjection.Callback projectionCallback;

    /**
     * 静态入口：从 Activity 的 onActivityResult 调。
     *
     * 传的是**整个 result Intent**而不是 Uri ——
     * MediaProjection 的授权结果里除了 token 还有 extras，
     * 只把 Uri 拎出来会丢掉必要信息。
     */
    public static void start(Context ctx, int resultCode, Intent result) {
        try {
            Intent i = new Intent(ctx, DshCaptureService.class);
            i.putExtra(EXTRA_RESULT_CODE, resultCode);
            i.putExtra(EXTRA_RESULT_DATA, result);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
        } catch (Exception ignored) {
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 必须**第一件事**就 startForeground：
        // 系统给的窗口只有 5 秒。
        promoteForeground();

        Intent data = null;
        int rc = 0;
        if (intent != null) {
            try {
                data = intent.getParcelableExtra(EXTRA_RESULT_DATA);
            } catch (Exception ignored) {
            }
            rc = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
        }
        if (data == null) {
            finishWith("授权数据丢失");
            return START_NOT_STICKY;
        }

        try {
            MediaProjectionManager mpm =
                    (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            projection = mpm.getMediaProjection(rc, data);
            if (projection == null) {
                finishWith("拿不到屏幕捕获对象");
                return START_NOT_STICKY;
            }
            // Android 14+：不先注册 Callback，createVirtualDisplay 会直接抛异常。
            projectionCallback = new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    finishWith(null);
                }
            };
            projection.registerCallback(projectionCallback, main);

            setupDisplay();
        } catch (Exception e) {
            finishWith("截图失败：" + e.getMessage());
        }
        return START_NOT_STICKY;
    }

    /* ---------------- 显示与抓帧 ---------------- */

    private void setupDisplay() {
        try {
            DisplayMetrics dm = new DisplayMetrics();
            WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
            if (wm != null) {
                wm.getDefaultDisplay().getRealMetrics(dm);
            }
            int w = Math.max(dm.widthPixels, 1);
            int h = Math.max(dm.heightPixels, 1);

            reader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2);
            reader.setOnImageAvailableListener(r -> onFrame(), main);

            display = projection.createVirtualDisplay(
                    "dsh-ime",
                    w, h, dm.densityDpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    reader.getSurface(),
                    null,
                    main);

            // VirtualDisplay 建立后第一帧是黑的。等一会儿再抓。
            main.postDelayed(this::grab, 320);
        } catch (Exception e) {
            finishWith("无法建立虚拟屏幕：" + e.getMessage());
        }
    }

    private void onFrame() {
        grab();
    }

    private void grab() {
        if (reader == null || attempts > 6) return;
        attempts++;
        Image img = null;
        try {
            img = reader.acquireLatestImage();
            if (img == null) return;
            Bitmap bmp = toBitmap(img);
            if (bmp == null) return;
            if (isAllBlack(bmp)) {
                // 黑帧：VirtualDisplay 还没准备好，再等
                main.postDelayed(this::grab, 220);
                return;
            }
            save(bmp);
        } catch (Exception e) {
            finishWith("读取屏幕失败：" + e.getMessage());
        } finally {
            if (img != null) {
                try {
                    img.close();
                } catch (Exception ignored) {
                }
            }
        }
    }

    /**
     * Image → Bitmap。
     *
     * rowStride 可能大于 width*4（硬件对齐），必须按行裁，
     * 直接 copyPixelsFromBuffer 会拿到歪掉的图。
     */
    private Bitmap toBitmap(Image img) {
        try {
            Bitmap bmp = Bitmap.createBitmap(
                    img.getWidth(), img.getHeight(), Bitmap.Config.ARGB_8888);
            ByteBuffer bb = img.getPlanes()[0].getBuffer();
            int rowStride = img.getPlanes()[0].getRowStride();
            int pixelStride = img.getPlanes()[0].getPixelStride();
            int w = img.getWidth();
            int h = img.getHeight();

            if (rowStride == pixelStride * w) {
                bb.rewind();
                bmp.copyPixelsFromBuffer(bb);
                return bmp;
            }

            byte[] row = new byte[rowStride * h];
            bb.rewind();
            bb.get(row, 0, Math.min(row.length, bb.remaining()));
            int[] pixels = new int[w * h];
            for (int y = 0; y < h; y++) {
                int base = y * rowStride;
                for (int x = 0; x < w; x++) {
                    int o = base + x * pixelStride;
                    if (o + 3 >= row.length) {
                        pixels[y * w + x] = 0xFF000000;
                        continue;
                    }
                    int r = row[o] & 0xFF;
                    int g = (row[o + 1] & 0xFF) << 8;
                    int b = (row[o + 2] & 0xFF) << 16;
                    int a = (row[o + 3] & 0xFF) << 24;
                    pixels[y * w + x] = a | r | g | b;
                }
            }
            bmp.setPixels(pixels, 0, w, 0, 0, w, h);
            return bmp;
        } catch (Exception e) {
            return null;
        }
    }

    private boolean isAllBlack(Bitmap bmp) {
        try {
            int w = Math.min(64, bmp.getWidth());
            int h = Math.min(64, bmp.getHeight());
            int stepX = Math.max(1, bmp.getWidth() / w);
            int stepY = Math.max(1, bmp.getHeight() / h);
            for (int y = 0; y < h; y += stepY) {
                for (int x = 0; x < w; x += stepX) {
                    if (bmp.getPixel(x * stepX, y * stepY) != 0xFF000000) return false;
                }
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /* ---------------- 落盘与投递 ---------------- */

    private void save(Bitmap bmp) {
        try {
            File dir = uploadsDir();
            if (dir == null) {
                finishWith("找不到上传目录");
                return;
            }
            if (!dir.exists()) dir.mkdirs();
            String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
            File out = new File(dir, "ime-" + stamp + ".png");

            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.PNG, 90, bos);
            byte[] data = bos.toByteArray();
            try (FileOutputStream fos = new FileOutputStream(out)) {
                fos.write(data);
            }

            JSONObject rec = new JSONObject();
            // path 必须是「workspace 区内相对路径」——
            // 主应用侧 DshFsBridge.resolve(area, path) 是按区域相对路径解析的，
            // 给绝对路径会被判成越界 / 找不到文件。
            rec.put("path", "uploads/" + out.getName());
            rec.put("absPath", out.getAbsolutePath());
            rec.put("name", out.getName());
            rec.put("size", data.length);
            rec.put("source", "ime");
            rec.put("createdAt", System.currentTimeMillis());

            deliver(rec.toString());
            finishWith(null);
        } catch (Exception e) {
            finishWith("保存截图失败：" + e.getMessage());
        }
    }

    /** workspace/uploads —— 和 DshFsBridge 的聊天附件区一致。 */
    private File uploadsDir() {
        try {
            File ext = getExternalFilesDir(null);
            File root = ext != null ? ext : getFilesDir();
            return new File(new File(root, "workspace"), "uploads");
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 投递。
     *
     * 主应用活着 → 直接推给页面；没活着 → 进队列，下次 ready 时补投。
     */
    private void deliver(String recordJson) {
        try {
            if (DshImeState.mainReady) {
                DshImeState.toMain("window.__dshImeShot && window.__dshImeShot("
                        + JSONObject.quote(recordJson) + ")");
            } else {
                DshImeState.queueShot(this, recordJson);
                notifyPending();
            }
        } catch (Exception ignored) {
        }
    }

    private void notifyPending() {
        try {
            JSONObject rec = new JSONObject();
            rec.put("ok", false);
            rec.put("error", "截图已保存，回到 DSH 后自动送达");
            DshImeState.toIme("window.__dshShotEvent && window.__dshShotEvent("
                    + JSONObject.quote(rec.toString()) + ")");
        } catch (Exception ignored) {
        }
    }

    /* ---------------- 前台与收尾 ---------------- */

    private void promoteForeground() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel ch = new NotificationChannel(
                        CHANNEL_ID, "DSH 键盘截图", NotificationManager.IMPORTANCE_LOW);
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
            Notification.Builder nb = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Notification.Builder(this, CHANNEL_ID)
                    : new Notification.Builder(this);
            Notification n = nb.setContentTitle("DSH 键盘")
                    .setContentText("正在截取屏幕…")
                    .setSmallIcon(android.R.drawable.ic_menu_camera)
                    .setOngoing(true)
                    .build();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, n,
                        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            } else {
                startForeground(NOTIF_ID, n);
            }
        } catch (Exception ignored) {
            try {
                startForeground(NOTIF_ID, new Notification());
            } catch (Exception ignored2) {
            }
        }
    }

    private void finishWith(String error) {
        try {
            release();
        } catch (Exception ignored) {
        }
        if (error != null) {
            try {
                JSONObject rec = new JSONObject();
                rec.put("ok", false);
                rec.put("error", error);
                DshImeState.toIme("window.__dshShotEvent && window.__dshShotEvent("
                        + JSONObject.quote(rec.toString()) + ")");
            } catch (Exception ignored) {
            }
        }
        try {
            stopForeground(true);
        } catch (Exception ignored) {
        }
        try {
            stopSelf();
        } catch (Exception ignored) {
        }
    }

    private void release() {
        if (display != null) {
            try {
                display.release();
            } catch (Exception ignored) {
            }
            display = null;
        }
        if (reader != null) {
            try {
                reader.close();
            } catch (Exception ignored) {
            }
            reader = null;
        }
        if (projection != null) {
            if (projectionCallback != null) {
                try {
                    projection.unregisterCallback(projectionCallback);
                } catch (Exception ignored) {
                }
            }
            try {
                projection.stop();
            } catch (Exception ignored) {
            }
            projection = null;
        }
    }

    @Override
    public void onDestroy() {
        release();
        super.onDestroy();
    }
}
