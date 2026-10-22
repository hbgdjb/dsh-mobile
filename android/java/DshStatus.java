package ai.deepseek.dsh.mobile;

import android.content.Context;

import org.json.JSONObject;

/**
 * 设备侧状态的**唯一**快照来源。
 *
 * ============ 为什么抽出来 ============
 *
 * Shizuku 的 binder、授权、连接状态都是**进程内静态量**，它们活在 `:device`，
 * 而设置页的 UI 在主进程。主进程里读这些静态量，拿到的永远是「没连上」。
 *
 * 这种"状态显示错误"比功能坏掉更难排查 —— 用户会以为功能坏了去重装，
 * 实际一切正常。所以状态只在 `:device` 里采集（{@link DshMcpServer} 的 GET 就调这里），
 * 主进程通过 HTTP 读同一份 JSON。
 *
 * 这里只放**纯读**逻辑：不改任何状态、不启动任何服务。
 *
 * ============ 0.26.0 的删减 ============
 *
 * 无障碍通道删除后，原来那一批字段（a11yEnabled / a11yConnected / a11yKeepAlive /
 * a11yBound / a11yDiag / canOverlay / keepAlivePref …）全部移除了。
 * 只保留 `diag`：Shizuku 的连接、断开、授权结果都写在同一个日志文件里，
 * 排障时还是它最有用。
 */
public final class DshStatus {

    private DshStatus() {
    }

    public static JSONObject snapshot(Context ctx) {
        JSONObject o = new JSONObject();
        try {
            o.put("enabled", DshMcpPolicy.isEnabled(ctx));
            o.put("running", DshMcpServer.isRunning());
            o.put("allowedCount", DshMcpPolicy.allowedPackages(ctx).size());

            // ===== 唯一的界面操作通道 =====
            // 五档状态（未安装 / 未运行 / 未授权 / 已授权未连接 / 就绪）分别对应
            // 五种完全不同的处理动作，所以不能只给一个 boolean。
            o.put("shizukuInstalled", DshShizuku.installed(ctx));
            o.put("shizukuRunning", DshShizuku.running());
            o.put("shizukuGranted", DshShizuku.granted());
            o.put("shizukuState", DshShizuku.state(ctx));
            o.put("shizukuDesc", DshShizuku.describe(ctx));

            // 诊断日志：binder 到达/断开、授权结果、连接结果都在这里
            o.put("diag", DshA11yDiagnostics.read(ctx, 40));

            o.put("devicePid", android.os.Process.myPid());
            o.put("port", DshMcpServer.PORT);
            o.put("deviceProcess", true);
        } catch (Throwable ignored) {
        }
        return o;
    }
}
