package ai.deepseek.dsh.mobile;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.util.Log;

/**
 * 用 ContentProvider 做启动钩子。
 *
 * 为什么不直接在 MainActivity 里调 DshMcpServer.start()：
 * 那样就得改 MainActivity，而 MainActivity 会随版本变化，每次升级都要重新适配。
 * ContentProvider 的 onCreate 由系统在进程启动时自动调用（早于 Application.onCreate），
 * 只要在 AndroidManifest 里声明一行就能拿到执行时机 —— 现有 Java 源码一行都不用动。
 *
 * 这是 Firebase / LeakCanary 等库的通用做法。
 */
public class DshMcpBootstrap extends ContentProvider {

    private static final String TAG = "DshMcp";

    @Override
    public boolean onCreate() {
        Context ctx = getContext();
        if (ctx == null) return false;

        // ===== 多进程应用的 Shizuku 初始化（必须在这里，越早越好）=====
        //
        // ShizukuProvider 在 manifest 里是 multiprocess="false"，只在
        // **声明它的那个进程**（主进程）自动初始化。本进程是 :device，
        // 不显式处理的话 pingBinder() 恒为 false ——
        // 表现是「Shizuku 明明在运行，应用却说没运行」。
        //
        // ============ 两个参数都容易写错（0.25.2 修正）============
        //
        // 1) enableMultiProcessSupport(boolean) 的参数是 **isProviderProcess**，
        //    不是「是否开启」。传 true 等于宣称"我就是 provider 进程"，
        //    于是内部会认为 binder 已经就绪、跳过取 binder 的流程 ——
        //    pingBinder() 永远 false。本进程不是 provider，必须传 false。
        //
        // 2) 只调上面那句**还不够**。真正去 Shizuku 那边取 binder 的是
        //    requestBinderForNonProviderProcess(ctx)：它会注册
        //    BINDER_RECEIVED 广播并主动发起请求。少了这一步，
        //    即使参数传对，binder 也永远到不了。
        //
        // 两步的顺序不能反：requestBinderForNonProviderProcess 开头就有
        // `if (isProviderProcess) return;`，先调它会被直接跳过。
        try {
            rikka.shizuku.ShizukuProvider.enableMultiProcessSupport(false);
            rikka.shizuku.ShizukuProvider.requestBinderForNonProviderProcess(ctx);
            DshA11yDiagnostics.log(ctx, "shizuku：已请求非 provider 进程的 binder");
        } catch (Throwable t) {
            DshA11yDiagnostics.log(ctx, "shizuku：binder 请求异常 " + t);
        }

        try {
            // 每次进程启动都记一笔。
            //
            // 这是判断「进程有没有被杀过」的唯一直接证据：无障碍被解绑时
            // 如果紧跟着一条新的进程启动记录，说明是进程被杀导致的；
            // 如果进程一直活着、服务却被解绑，那是另一类问题（ROM 主动禁用）。
            DshA11yDiagnostics.log(ctx, "进程启动 pid=" + android.os.Process.myPid());
        } catch (Throwable ignored) {
        }
        try {
            // 只有用户显式开启过本机控制才起服务。
            // 默认关闭 —— 装上应用不等于授权它监听端口。
            if (DshMcpPolicy.isEnabled(ctx)) {
                DshMcpServer.start(ctx.getApplicationContext());
            }
        } catch (Throwable t) {
            // 绝不能让 MCP 的问题拖垮宿主启动
            Log.e(TAG, "bootstrap failed: " + t);
        }
        return true;
    }

    /* 以下是 ContentProvider 的必选空实现，本模块不提供任何数据 */

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        return null;
    }

    @Override
    public String getType(Uri uri) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
