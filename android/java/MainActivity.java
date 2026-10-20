package ai.deepseek.dsh.mobile;

import android.content.Intent;
import android.content.res.Configuration;
import android.os.Bundle;
import android.webkit.WebSettings;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().addJavascriptInterface(
                    new DshHttpBridge(getBridge().getWebView()),
                    "DshNative"
            );
            getBridge().getWebView().addJavascriptInterface(
                    new DshHudBridge(getApplicationContext()),
                    "DshHud"
            );
            getBridge().getWebView().addJavascriptInterface(
                    new DshFsBridge(this, getBridge().getWebView()),
                    "DshFs"
            );
        }
        lockTextZoom();
    }

    @Override
    public void onResume() {
        super.onResume();
        lockTextZoom();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        lockTextZoom();
    }

    /**
     * 锁定 WebView 文本缩放为 100%。
     *
     * 页面尺寸完全由 CSS 固定 px 决定（图标、行高、胶囊高度都是设计稿数值）。
     * MIUI / HyperOS 等国产 ROM 会把「系统字体大小」写进 WebView 的 textZoom，
     * 于是文字被放大 1.3 倍而容器不变，出现字超出胶囊、标题挤出标题栏、
     * 行高错位等"UI 变形"。系统字体偏好改由应用内「外观与阅读 → 正文大小」承担。
     */
    private void lockTextZoom() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        try {
            WebSettings settings = getBridge().getWebView().getSettings();
            if (settings.getTextZoom() != 100) settings.setTextZoom(100);
        } catch (Exception ignored) {
        }
    }

    /** 文件选择器 / 另存为 的结果转交给文件桥。 */
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (DshFsBridge.handleActivityResult(requestCode, resultCode, data)) return;
        super.onActivityResult(requestCode, resultCode, data);
    }
}
