package tv.nodecast.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
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
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Norva Mobile — Android phone client.
 */
public class MainActivity extends Activity {

    private static final String PREFS          = "norva_mobile";
    private static final String PREF_SERVER_URL = "serverUrl";
    private static final String PREF_MODE       = "mode"; // "cloud" | "server"
    private static final String CLOUD_ACCOUNT_URL = "https://norva.tv/account.html?returnTo=%2Fapp.html%3Fmobile%3D1%23home";
    private static final String CLOUD_WATCH_URL = "https://norva.tv/app.html?mobile=1#home";
    private static final String UA_SUFFIX       = " NorvaTV-AndroidPhone/1.0";
    private static final int    REQ_PLAYER      = 1001;
    private boolean             cloudBridgeAdded = false;

    private FrameLayout  root;
    private WebView      webView;
    private LinearLayout setupPanel;
    private LinearLayout advancedPanel;
    private EditText     urlInput;
    private TextView     statusText;
    private boolean      webViewVisible = false;
    private LinearLayout splashPanel;
    private LinearLayout errorPanel;
    private TextView     errorText;
    private String       lastLoadedUrl;
    private long         lastBackPressMs = 0L;

    // ---- Lifecycle ----

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0a0a0f"));
        setContentView(root);

        buildWebView();
        buildSetupPanel();
        buildErrorPanel();
        buildSplash();
        showSplash();

        // Handle norva://pair deep link
        Intent intent = getIntent();
        if (Intent.ACTION_VIEW.equals(intent.getAction())) {
            Uri data = intent.getData();
            if (data != null
                    && "norva".equals(data.getScheme())
                    && "pair".equals(data.getHost())) {
                String hubUrl = data.getQueryParameter("hub");
                String code   = data.getQueryParameter("code");
                if (hubUrl != null && code != null) {
                    prefs().edit().putString(PREF_SERVER_URL, hubUrl).putString(PREF_MODE, "server").apply();
                    connect(hubUrl + "/pair-approve.html?code=" + code);
                    return;
                }
            }
        }

        String mode = prefs().getString(PREF_MODE, null);
        String saved = prefs().getString(PREF_SERVER_URL, null);
        if ("cloud".equals(mode)) {
            connectCloud(CLOUD_WATCH_URL);
        } else if (saved != null && !saved.isEmpty()) {
            connect(saved);
        } else {
            prefs().edit().putString(PREF_MODE, "cloud").apply();
            connectCloud(CLOUD_ACCOUNT_URL);
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
        // Let the web app consume Back first (close a menu, modal, channel drawer,
        // or step back to Home). Only fall back to history / exit when it doesn't.
        webView.evaluateJavascript(
                "(window.__norvaHandleBack ? window.__norvaHandleBack() : 'none')",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        final String v = value == null ? "" : value.replace("\"", "");
                        if ("handled".equals(v)) return; // page consumed Back
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                if ("none".equals(v) && webView.canGoBack()) {
                                    webView.goBack();
                                    return;
                                }
                                long now = System.currentTimeMillis();
                                if (now - lastBackPressMs < 2000) {
                                    finish();
                                } else {
                                    lastBackPressMs = now;
                                    Toast.makeText(MainActivity.this,
                                            "Press back again to exit", Toast.LENGTH_SHORT).show();
                                }
                            }
                        });
                    }
                });
    }

    @Override
    protected void onDestroy() {
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    // ---- Build UI ----

    @SuppressLint("SetJavaScriptEnabled")
    private void buildWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0a0a0f"));
        webView.setVisibility(View.GONE);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setUserAgentString(s.getUserAgentString() + UA_SUFFIX);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Grant camera access so QR scanning works inside the WebView
                request.grant(request.getResources());
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                hideSplash();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        WebResourceError error) {
                if (request.isForMainFrame()) {
                    hideSplash();
                    showNetworkError(String.valueOf(error.getDescription()));
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler,
                                           SslError error) {
                // Accept self-signed certs on local network
                handler.proceed();
            }
        });

        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));
    }

    private void buildSetupPanel() {
        setupPanel = new LinearLayout(this);
        setupPanel.setOrientation(LinearLayout.VERTICAL);
        setupPanel.setBackgroundColor(Color.parseColor("#0a0a0f"));
        setupPanel.setGravity(Gravity.CENTER);

        int padH = dp(24);
        int padV = dp(40);
        setupPanel.setPadding(padH, padV, padH, padV);

        // App title
        TextView title = new TextView(this);
        title.setText("norva");
        title.setTextColor(Color.parseColor("#3B82F6"));
        title.setTextSize(28);
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, 0, 0, dp(6));
        setupPanel.addView(title);

        // Subtitle
        TextView sub = new TextView(this);
        sub.setText("Watch and manage Norva");
        sub.setTextColor(Color.parseColor("#71717a"));
        sub.setTextSize(14);
        sub.setGravity(Gravity.CENTER);
        sub.setPadding(0, 0, 0, dp(32));
        setupPanel.addView(sub);

        Button accountBtn = new Button(this);
        accountBtn.setText("Norva Account");
        accountBtn.setTextColor(Color.WHITE);
        accountBtn.setBackgroundColor(Color.parseColor("#3B82F6"));
        accountBtn.setOnClickListener(v -> {
            prefs().edit().putString(PREF_MODE, "cloud").apply();
            connectCloud(CLOUD_WATCH_URL);
        });

        LinearLayout.LayoutParams accountBtnLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        accountBtnLp.bottomMargin = dp(22);
        setupPanel.addView(accountBtn, accountBtnLp);

        Button advancedToggle = new Button(this);
        advancedToggle.setText("Advanced setup");
        advancedToggle.setTextColor(Color.WHITE);
        advancedToggle.setBackgroundColor(Color.parseColor("#272d3a"));
        advancedToggle.setOnClickListener(v -> {
            if (advancedPanel != null) {
                advancedPanel.setVisibility(advancedPanel.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE);
            }
        });
        LinearLayout.LayoutParams advancedToggleLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        advancedToggleLp.bottomMargin = dp(14);
        setupPanel.addView(advancedToggle, advancedToggleLp);

        advancedPanel = new LinearLayout(this);
        advancedPanel.setOrientation(LinearLayout.VERTICAL);
        advancedPanel.setVisibility(View.GONE);
        setupPanel.addView(advancedPanel, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        // Hint
        TextView hint = new TextView(this);
        hint.setText("Advanced local connector");
        hint.setTextColor(Color.parseColor("#a1a1aa"));
        hint.setTextSize(15);
        hint.setPadding(0, 0, 0, dp(10));
        advancedPanel.addView(hint);

        // URL input — max width 300dp on phones
        urlInput = new EditText(this);
        urlInput.setHint("http://192.168.1.20:3000");
        urlInput.setText(prefs().getString(PREF_SERVER_URL, "http://"));
        urlInput.setTextColor(Color.WHITE);
        urlInput.setHintTextColor(Color.parseColor("#71717a"));
        urlInput.setSingleLine(true);
        urlInput.setInputType(InputType.TYPE_TEXT_VARIATION_URI
                | InputType.TYPE_CLASS_TEXT);
        urlInput.setBackgroundColor(Color.parseColor("#18181f"));
        urlInput.setPadding(dp(12), dp(12), dp(12), dp(12));

        LinearLayout.LayoutParams inputLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        inputLp.bottomMargin = dp(4);
        advancedPanel.addView(urlInput, inputLp);

        // Connect button
        Button connectBtn = new Button(this);
        connectBtn.setText("Connect local connector");
        connectBtn.setTextColor(Color.WHITE);
        connectBtn.setBackgroundColor(Color.parseColor("#3B82F6"));
        connectBtn.setOnClickListener(v -> {
            String url = urlInput.getText().toString().trim();
            if (url.isEmpty() || url.equals("http://")) {
                statusText.setText("Enter a valid URL");
                return;
            }
            if (!url.startsWith("http")) url = "http://" + url;
            while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
            prefs().edit().putString(PREF_SERVER_URL, url).putString(PREF_MODE, "server").apply();
            connect(url);
        });

        LinearLayout.LayoutParams btnLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        btnLp.topMargin = dp(16);
        advancedPanel.addView(connectBtn, btnLp);

        // Status / error text
        statusText = new TextView(this);
        statusText.setTextColor(Color.parseColor("#ef4444"));
        statusText.setTextSize(14);
        statusText.setPadding(0, dp(12), 0, 0);
        setupPanel.addView(statusText);

        root.addView(setupPanel, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));
    }

    // ---- Navigation ----

    private void connect(String url) {
        lastLoadedUrl = url;
        setupPanel.setVisibility(View.GONE);
        if (errorPanel != null) errorPanel.setVisibility(View.GONE);
        showSplash();
        webView.setVisibility(View.VISIBLE);
        webViewVisible = true;
        webView.loadUrl(url);
        webView.requestFocus();
    }

    /** Cloud playback: expose the native player bridge, then load the cloud app. */
    private void connectCloud(String url) {
        if (!cloudBridgeAdded) {
            webView.addJavascriptInterface(new CloudBridge(), "NorvaTVCloud");
            cloudBridgeAdded = true;
        }
        connect(url);
    }

    /**
     * JS bridge: the web app hands playback here so movies use the phone's
     * hardware decoders and the home network (residential IP) instead of the
     * cloud gateway the provider blocks. playVideoResumable is feature-detected
     * by the web, so older builds still work (playback without resume).
     */
    private class CloudBridge {
        @android.webkit.JavascriptInterface
        public void playVideo(final String url, final String title) {
            openPlayer(url, title, null, null, null, 0);
        }

        @android.webkit.JavascriptInterface
        public void playVideoWithMeta(final String url, final String title, final String sourceId,
                                      final String itemType, final String itemId) {
            openPlayer(url, title, sourceId, itemType, itemId, 0);
        }

        @android.webkit.JavascriptInterface
        public void playVideoResumable(final String url, final String title, final String sourceId,
                                       final String itemType, final String itemId, final int resumeSeconds) {
            openPlayer(url, title, sourceId, itemType, itemId, resumeSeconds);
        }
    }

    private void openPlayer(final String url, final String title, final String sourceId,
                            final String itemType, final String itemId, final int resumeSeconds) {
        runOnUiThread(() -> {
            Intent intent = new Intent(MainActivity.this, PlayerActivity.class);
            intent.putExtra(PlayerActivity.EXTRA_URL, url);
            intent.putExtra(PlayerActivity.EXTRA_TITLE, title);
            if (sourceId != null) intent.putExtra(PlayerActivity.EXTRA_SOURCE_ID, sourceId);
            if (itemType != null) intent.putExtra(PlayerActivity.EXTRA_ITEM_TYPE, itemType);
            if (itemId != null) intent.putExtra(PlayerActivity.EXTRA_ITEM_ID, itemId);
            if (resumeSeconds > 0) intent.putExtra(PlayerActivity.EXTRA_RESUME_SECONDS, resumeSeconds);
            startActivityForResult(intent, REQ_PLAYER);
        });
    }

    /**
     * The native player returns its final position when it closes; forward it to
     * the web app, which persists it to the cloud history for cross-device resume.
     */
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PLAYER || data == null || webView == null) return;
        final String sourceId = data.getStringExtra("sourceId");
        final String itemType = data.getStringExtra("itemType");
        final String itemId = data.getStringExtra("itemId");
        final long pos = data.getLongExtra("positionSeconds", 0);
        final long dur = data.getLongExtra("durationSeconds", 0);
        if (sourceId == null || itemId == null || pos <= 0) return;
        final String js = "window.__norvaNative && window.__norvaNative.onProgress("
                + jsStr(sourceId) + "," + jsStr(itemType) + "," + jsStr(itemId) + "," + pos + "," + dur + ")";
        runOnUiThread(() -> {
            try { webView.evaluateJavascript(js, null); } catch (Exception ignored) { }
        });
    }

    private static String jsStr(String value) {
        if (value == null) return "''";
        return "'" + value.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ") + "'";
    }

    private void showSetup(String error) {
        webViewVisible = false;
        hideSplash();
        if (errorPanel != null) errorPanel.setVisibility(View.GONE);
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

    // ---- Splash ----

    /** Branded launch/loading screen shown over the WebView until a page loads. */
    private void buildSplash() {
        splashPanel = new LinearLayout(this);
        splashPanel.setOrientation(LinearLayout.VERTICAL);
        splashPanel.setGravity(Gravity.CENTER);
        splashPanel.setBackgroundColor(Color.parseColor("#0a0a0f"));
        splashPanel.setVisibility(View.GONE);

        ImageView logo = new ImageView(this);
        int logoId = getResources().getIdentifier("norva_app_icon", "drawable", getPackageName());
        if (logoId == 0) logoId = getResources().getIdentifier("ic_launcher", "drawable", getPackageName());
        if (logoId != 0) logo.setImageResource(logoId);
        LinearLayout.LayoutParams logoLp = new LinearLayout.LayoutParams(dp(96), dp(96));
        logoLp.bottomMargin = dp(28);
        splashPanel.addView(logo, logoLp);

        ProgressBar spinner = new ProgressBar(this);
        splashPanel.addView(spinner, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        root.addView(splashPanel, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));
    }

    private void showSplash() {
        if (splashPanel != null) {
            splashPanel.bringToFront();
            splashPanel.setVisibility(View.VISIBLE);
        }
    }

    private void hideSplash() {
        if (splashPanel != null) splashPanel.setVisibility(View.GONE);
    }

    // ---- Network error ----

    /** Friendly "can't reach Norva" screen with a Retry button. */
    private void buildErrorPanel() {
        errorPanel = new LinearLayout(this);
        errorPanel.setOrientation(LinearLayout.VERTICAL);
        errorPanel.setGravity(Gravity.CENTER);
        errorPanel.setBackgroundColor(Color.parseColor("#0a0a0f"));
        errorPanel.setVisibility(View.GONE);
        int pad = dp(28);
        errorPanel.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("Can't reach Norva");
        title.setTextColor(Color.WHITE);
        title.setTextSize(22);
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, 0, 0, dp(10));
        errorPanel.addView(title);

        errorText = new TextView(this);
        errorText.setText("Please check your internet connection and try again.");
        errorText.setTextColor(Color.parseColor("#a1a1aa"));
        errorText.setTextSize(15);
        errorText.setGravity(Gravity.CENTER);
        errorText.setPadding(0, 0, 0, dp(28));
        errorPanel.addView(errorText);

        Button retryBtn = new Button(this);
        retryBtn.setText("Retry");
        retryBtn.setTextColor(Color.WHITE);
        retryBtn.setBackgroundColor(Color.parseColor("#3B82F6"));
        retryBtn.setOnClickListener(v -> {
            if (lastLoadedUrl != null && !lastLoadedUrl.isEmpty()) {
                connect(lastLoadedUrl);
            } else {
                connectCloud(CLOUD_WATCH_URL);
            }
        });
        LinearLayout.LayoutParams retryLp = new LinearLayout.LayoutParams(
                dp(220), LinearLayout.LayoutParams.WRAP_CONTENT);
        retryLp.bottomMargin = dp(14);
        errorPanel.addView(retryBtn, retryLp);

        Button setupBtn = new Button(this);
        setupBtn.setText("Advanced setup");
        setupBtn.setTextColor(Color.WHITE);
        setupBtn.setBackgroundColor(Color.parseColor("#272d3a"));
        setupBtn.setOnClickListener(v -> {
            showSetup(null);
            if (advancedPanel != null) advancedPanel.setVisibility(View.VISIBLE);
        });
        errorPanel.addView(setupBtn, new LinearLayout.LayoutParams(
                dp(220), LinearLayout.LayoutParams.WRAP_CONTENT));

        root.addView(errorPanel, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));
    }

    private void showNetworkError(String detail) {
        webViewVisible = false;
        hideSplash();
        webView.setVisibility(View.GONE);
        setupPanel.setVisibility(View.GONE);
        if (errorText != null) {
            errorText.setText(detail == null || detail.isEmpty()
                    ? "Please check your internet connection and try again."
                    : "Please check your internet connection and try again.\n\n" + detail);
        }
        if (errorPanel != null) {
            errorPanel.bringToFront();
            errorPanel.setVisibility(View.VISIBLE);
        }
    }

    // ---- Helpers ----

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    /** Convert dp to pixels. */
    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
