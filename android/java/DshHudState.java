package ai.deepseek.dsh.mobile;

/** HUD 全局状态单例：WebView 侧与悬浮窗服务在同一进程内共享。 */
public final class DshHudState {
    public static volatile boolean enabled = false;
    public static volatile String json =
            "{\"status\":\"idle\",\"statusText\":\"空闲中\",\"step\":\"\",\"sessions\":[],\"tasks\":[]}";
    public static volatile boolean collapsed = true;

    private DshHudState() {}
}
