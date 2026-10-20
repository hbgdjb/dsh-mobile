package ai.deepseek.dsh.mobile;

import android.content.Context;
import android.webkit.JavascriptInterface;

/**
 * JS -> 原生：保活开关。
 *
 * Agent 运行期间调用 start()，把 DshKeepAliveService 提升为前台服务，
 * 这样用户切到别的应用时系统不会随手回收我们的进程，
 * 正在跑的任务也就不会"莫名其妙中断、记录全丢"。
 */
public class DshKeepAliveBridge {

    private final Context ctx;

    public DshKeepAliveBridge(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    @JavascriptInterface
    public void start() {
        DshKeepAliveService.start(ctx);
    }

    @JavascriptInterface
    public void stop() {
        DshKeepAliveService.stop(ctx);
    }

    @JavascriptInterface
    public boolean isRunning() {
        return DshKeepAliveService.isRunning();
    }
}
