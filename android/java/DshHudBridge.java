package ai.deepseek.dsh.mobile;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import android.webkit.JavascriptInterface;

/** JS -> 悬浮窗服务 的桥：开关、权限请求与状态推送。 */
public class DshHudBridge {

    private final Context ctx;

    public DshHudBridge(Context ctx) {
        this.ctx = ctx;
    }

    @JavascriptInterface
    public boolean canDrawOverlays() {
        return Settings.canDrawOverlays(ctx);
    }

    @JavascriptInterface
    public void requestPermission() {
        Intent i = new Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + ctx.getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(i);
        } catch (Exception ignored) {
        }
    }

    @JavascriptInterface
    public void enable() {
        DshHudState.enabled = true;
        Intent i = new Intent(ctx, DshHudService.class);
        try {
            ctx.startService(i);
        } catch (Exception ignored) {
        }
    }

    @JavascriptInterface
    public void disable() {
        DshHudState.enabled = false;
        ctx.stopService(new Intent(ctx, DshHudService.class));
    }

    @JavascriptInterface
    public void push(String json) {
        if (json != null && !json.isEmpty()) {
            DshHudState.json = json;
        }
        DshHudService.refresh();
    }
}
