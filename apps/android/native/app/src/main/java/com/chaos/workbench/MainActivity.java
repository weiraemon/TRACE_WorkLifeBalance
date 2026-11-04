package com.chaos.workbench;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.splashscreen.SplashScreen;

public class MainActivity extends BridgeActivity {
    private boolean launchReady = false;

    @Override public void onCreate(Bundle state) {
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        splash.setKeepOnScreenCondition(() -> !launchReady);
        bridgeBuilder.addWebViewListener(new WebViewListener() {
            @Override public void onPageLoaded(WebView webView) {
                webView.postVisualStateCallback(0, new WebView.VisualStateCallback() {
                    @Override public void onComplete(long requestId) {
                        launchReady = true;
                    }
                });
            }

            @Override public void onReceivedError(WebView webView) {
                launchReady = true;
            }
        });
        registerPlugin(ChaosFilesPlugin.class);
        super.onCreate(state);
        getWindow().getDecorView().postDelayed(() -> launchReady = true, 10000);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                bridge.getWebView().evaluateJavascript("window.dispatchEvent(new Event('chaos-back'))", null);
            }
        });
    }
}
