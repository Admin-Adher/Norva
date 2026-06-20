package tv.nodecast.client;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.http.SslError;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Norva TV — Android TV client.
 *
 * Thin WebView wrapper around Norva.
 *
 * The default path pairs the TV with a Norva Account. The MENU key
 * brings back advanced connection options.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "norva";
    private static final String PREF_SERVER_URL = "serverUrl";
    private static final String PREF_MODE = "mode"; // "cloud" | "server" | "standalone"
    private static final String CLOUD_PAIR_URL = "https://norva.tv/cloud-pair.html?device=tv&returnTo=%2Fapp.html%3Fpaired%3D1%23home";
    // Marker appended to the WebView user agent: the web app detects it and
    // enables TV mode (D-pad spatial navigation, focus outlines).
    private static final String UA_SUFFIX = " NorvaTV-AndroidTV/3.1";

    private FrameLayout root;
    private WebView webView;
    private LinearLayout setupPanel;
    private LinearLayout advancedPanel;
    private EditText urlInput;
    private TextView statusText;
    private boolean webViewVisible = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0a0a0f"));
        setContentView(root);

        buildWebView();
        buildSetupPanel();

        String mode = prefs().getString(PREF_MODE, null);
        String saved = prefs().getString(PREF_SERVER_URL, null);
        if ("cloud".equals(mode)) {
            connectCloudPairing();
        } else if ("standalone".equals(mode)) {
            connectStandalone();
        } else if ("server".equals(mode) && saved != null && !saved.isEmpty()) {
            connect(saved);
        } else {
            prefs().edit().putString(PREF_MODE, "cloud").apply();
            connectCloudPairing();
        }
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void buildWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0a0a0f"));

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setUserAgentString(s.getUserAgentString() + UA_SUFFIX);

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // Only react to failures of the main document, not subresources
                if (request.isForMainFrame()) {
                    showSetup("Could not reach Norva: " + error.getDescription());
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                // Home servers typically use self-signed certs
                handler.proceed();
            }
        });

        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    }

    private void buildSetupPanel() {
        setupPanel = new LinearLayout(this);
        setupPanel.setOrientation(LinearLayout.VERTICAL);
        setupPanel.setBackgroundColor(Color.parseColor("#0a0a0f"));
        int pad = dp(48);
        setupPanel.setPadding(pad, pad, pad, pad);
        setupPanel.setGravity(android.view.Gravity.CENTER);

        TextView title = new TextView(this);
        title.setText("norva");
        title.setTextColor(Color.parseColor("#3B82F6"));
        title.setTextSize(34);
        title.setPadding(0, 0, 0, dp(8));
        setupPanel.addView(title);

        TextView hint = new TextView(this);
        hint.setText("Connect this TV to your Norva Account. Pairing is the easiest way to attach this screen to your household.");
        hint.setTextColor(Color.parseColor("#a1a1aa"));
        hint.setTextSize(16);
        hint.setPadding(0, 0, 0, dp(24));
        setupPanel.addView(hint);

        TextView cloudHint = new TextView(this);
        cloudHint.setText("Recommended");
        cloudHint.setTextColor(Color.parseColor("#a1a1aa"));
        cloudHint.setTextSize(15);
        cloudHint.setPadding(0, 0, 0, dp(10));
        setupPanel.addView(cloudHint, new LinearLayout.LayoutParams(dp(560), LinearLayout.LayoutParams.WRAP_CONTENT));

        Button cloudBtn = new Button(this);
        cloudBtn.setText("Connect this TV");
        cloudBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                prefs().edit().putString(PREF_MODE, "cloud").apply();
                connectCloudPairing();
            }
        });
        setupPanel.addView(cloudBtn, new LinearLayout.LayoutParams(dp(320), LinearLayout.LayoutParams.WRAP_CONTENT));

        Button advancedToggle = new Button(this);
        advancedToggle.setText("Advanced setup");
        advancedToggle.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (advancedPanel != null) {
                    advancedPanel.setVisibility(advancedPanel.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE);
                }
            }
        });
        LinearLayout.LayoutParams advancedToggleLp = new LinearLayout.LayoutParams(dp(220), LinearLayout.LayoutParams.WRAP_CONTENT);
        advancedToggleLp.topMargin = dp(20);
        setupPanel.addView(advancedToggle, advancedToggleLp);

        advancedPanel = new LinearLayout(this);
        advancedPanel.setOrientation(LinearLayout.VERTICAL);
        advancedPanel.setGravity(android.view.Gravity.CENTER);
        advancedPanel.setVisibility(View.GONE);
        setupPanel.addView(advancedPanel, new LinearLayout.LayoutParams(dp(580), LinearLayout.LayoutParams.WRAP_CONTENT));

        TextView localLabel = new TextView(this);
        localLabel.setText("Advanced local connector");
        localLabel.setTextColor(Color.parseColor("#71717a"));
        localLabel.setTextSize(15);
        localLabel.setPadding(0, dp(28), 0, dp(8));
        advancedPanel.addView(localLabel);

        urlInput = new EditText(this);
        urlInput.setHint("http://192.168.1.20:3000");
        urlInput.setText(prefs().getString(PREF_SERVER_URL, "http://"));
        urlInput.setTextColor(Color.WHITE);
        urlInput.setHintTextColor(Color.parseColor("#71717a"));
        urlInput.setSingleLine(true);
        urlInput.setInputType(android.text.InputType.TYPE_TEXT_VARIATION_URI);
        advancedPanel.addView(urlInput, new LinearLayout.LayoutParams(dp(520), LinearLayout.LayoutParams.WRAP_CONTENT));

        Button connectBtn = new Button(this);
        connectBtn.setText("Connect local connector");
        connectBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String url = normalizeUrl(urlInput.getText().toString());
                if (url == null) {
                    statusText.setText("Invalid address. Use http://IP:PORT");
                    return;
                }
                prefs().edit().putString(PREF_SERVER_URL, url).putString(PREF_MODE, "server").apply();
                connect(url);
            }
        });
        LinearLayout.LayoutParams btnLp = new LinearLayout.LayoutParams(dp(220), LinearLayout.LayoutParams.WRAP_CONTENT);
        btnLp.topMargin = dp(16);
        advancedPanel.addView(connectBtn, btnLp);

        // --- Standalone mode (no PC required) ---
        TextView orLabel = new TextView(this);
        orLabel.setText("- or -");
        orLabel.setTextColor(Color.parseColor("#71717a"));
        orLabel.setTextSize(15);
        orLabel.setPadding(0, dp(28), 0, dp(8));
        advancedPanel.addView(orLabel);

        TextView standaloneHint = new TextView(this);
        standaloneHint.setText("Standalone: run Norva entirely on this TV. Use this when you do not want an account on this device. Playback uses the TV native decoder.");
        standaloneHint.setTextColor(Color.parseColor("#a1a1aa"));
        standaloneHint.setTextSize(14);
        standaloneHint.setPadding(0, 0, 0, dp(12));
        advancedPanel.addView(standaloneHint, new LinearLayout.LayoutParams(dp(560), LinearLayout.LayoutParams.WRAP_CONTENT));

        Button standaloneBtn = new Button(this);
        standaloneBtn.setText("Use standalone mode");
        standaloneBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                prefs().edit().putString(PREF_MODE, "standalone").apply();
                connectStandalone();
            }
        });
        advancedPanel.addView(standaloneBtn, new LinearLayout.LayoutParams(dp(320), LinearLayout.LayoutParams.WRAP_CONTENT));

        statusText = new TextView(this);
        statusText.setTextColor(Color.parseColor("#ef4444"));
        statusText.setTextSize(15);
        statusText.setPadding(0, dp(16), 0, 0);
        setupPanel.addView(statusText);

        TextView tip = new TextView(this);
        tip.setText("Press MENU on the remote at any time for advanced connection options.");
        tip.setTextColor(Color.parseColor("#71717a"));
        tip.setTextSize(13);
        tip.setPadding(0, dp(24), 0, 0);
        setupPanel.addView(tip);

        root.addView(setupPanel, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    }

    private String normalizeUrl(String raw) {
        if (raw == null) return null;
        String url = raw.trim();
        if (url.isEmpty() || url.equals("http://") || url.equals("https://")) return null;
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://" + url;
        }
        // Strip trailing slash for consistency
        while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
        return url;
    }

    private void connect(String url) {
        setupPanel.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webViewVisible = true;
        webView.loadUrl(url);
        webView.requestFocus();
    }

    private void connectCloudPairing() {
        webView.addJavascriptInterface(new CloudBridge(), "NorvaTVCloud");
        connect(CLOUD_PAIR_URL);
    }

    /**
     * Standalone: start the embedded local server (web app + Xtream relay)
     * and expose the native player bridge to the page.
     */
    private void connectStandalone() {
        try {
            LocalServer.get(this).start();
        } catch (Exception e) {
            showSetup("Could not start the embedded server: " + e.getMessage());
            return;
        }
        webView.addJavascriptInterface(new NativeBridge(), "NodeCastNative");
        connect("http://127.0.0.1:" + LocalServer.PORT + "/");
    }

    /**
     * JS bridge (standalone mode): the web app routes playback here so MKV,
     * AC3/EAC3 and HEVC streams use the TV's hardware decoders instead of
     * the WebView's limited HTML5 codecs.
     */
    private class NativeBridge {
        @android.webkit.JavascriptInterface
        public void playVideo(final String url, final String title) {
            MainActivity.this.openPlayer(url, title, null, null, null);
        }

        @android.webkit.JavascriptInterface
        public void playVideoWithMeta(final String url, final String title, final String sourceId,
                                      final String itemType, final String itemId) {
            MainActivity.this.openPlayer(url, title, sourceId, itemType, itemId);
        }
    }

    private class CloudBridge {
        @android.webkit.JavascriptInterface
        public void playVideo(final String url, final String title) {
            MainActivity.this.openPlayer(url, title, null, null, null);
        }

        @android.webkit.JavascriptInterface
        public void playVideoWithMeta(final String url, final String title, final String sourceId,
                                      final String itemType, final String itemId) {
            MainActivity.this.openPlayer(url, title, sourceId, itemType, itemId);
        }
    }

    private void openPlayer(final String url, final String title, final String sourceId,
                            final String itemType, final String itemId) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                android.content.Intent intent = new android.content.Intent(MainActivity.this, PlayerActivity.class);
                intent.putExtra(PlayerActivity.EXTRA_URL, url);
                intent.putExtra(PlayerActivity.EXTRA_TITLE, title);
                if (sourceId != null) intent.putExtra(PlayerActivity.EXTRA_SOURCE_ID, sourceId);
                if (itemType != null) intent.putExtra(PlayerActivity.EXTRA_ITEM_TYPE, itemType);
                if (itemId != null) intent.putExtra(PlayerActivity.EXTRA_ITEM_ID, itemId);
                startActivity(intent);
            }
        });
    }

    private void showSetup(String error) {
        webViewVisible = false;
        webView.setVisibility(View.GONE);
        setupPanel.setVisibility(View.VISIBLE);
        statusText.setText(error == null ? "" : error);
        if (error != null && advancedPanel != null) {
            advancedPanel.setVisibility(View.VISIBLE);
        }
        if (advancedPanel != null && advancedPanel.getVisibility() == View.VISIBLE) {
            urlInput.requestFocus();
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_MENU && webViewVisible) {
            showSetup(null);
            if (advancedPanel != null) {
                advancedPanel.setVisibility(View.VISIBLE);
            }
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onBackPressed() {
        if (!webViewVisible || webView == null) {
            super.onBackPressed();
            return;
        }
        // Ask the web app to handle Back first (close an open modal, leave a
        // details panel...). Only fall back to history/exit when it doesn't.
        webView.evaluateJavascript(
                "(window.__norvaTV && window.__norvaTV.handleBack) ? window.__norvaTV.handleBack() : 'none'",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        final String v = value == null ? "" : value.replace("\"", "");
                        if ("modal".equals(v) || "nav".equals(v)) {
                            return; // handled inside the page
                        }
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                if (webView.canGoBack()) webView.goBack();
                                else finish();
                            }
                        });
                    }
                });
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
