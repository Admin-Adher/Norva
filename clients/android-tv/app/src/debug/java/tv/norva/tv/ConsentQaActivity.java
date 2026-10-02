package tv.norva.tv;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebView;

/** Debug-only host for isolated remote/WebView regression tests. */
public class ConsentQaActivity extends Activity {
    public WebView webView;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setUseWideViewPort(true);
        webView.getSettings().setUserAgentString(webView.getSettings().getUserAgentString() + " NorvaTV-AndroidTV");
        setContentView(webView);
        webView.requestFocus();
    }
    @Override public void onBackPressed() {
        webView.evaluateJavascript("window.__norvaTV && window.__norvaTV.handleBack()", null);
    }
    @Override public void onDestroy() {
        webView.destroy();
        super.onDestroy();
    }
}
