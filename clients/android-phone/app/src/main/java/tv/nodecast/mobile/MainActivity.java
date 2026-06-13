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
 * Norva Mobile — Android phone client.
 */
public class MainActivity extends Activity {

    private static final String PREFS          = "norva_mobile";
    private static final String PREF_SERVER_URL = "serverUrl";
    private static final String PREF_MODE       = "mode"; // "cloud" | "server"
    private static final String CLOUD_ACCOUNT_URL = "https://norva-pgkk.vercel.app/account.html";
    private static final String CLOUD_DASHBOARD_URL = "https://norva-pgkk.vercel.app/cloud.html";
    private static final String UA_SUFFIX       = " NorvaTV-AndroidPhone/1.0";

    private FrameLayout  root;
    private WebView      webView;
    private LinearLayout setupPanel;
    private EditText     urlInput;
    private TextView     statusText;
    private boolean      webViewVisible = false;

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
            connect(CLOUD_DASHBOARD_URL);
        } else if (saved != null && !saved.isEmpty()) {
            connect(saved);
        } else {
            showSetup(null);
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_MENU && webViewVisible) {
            showSetup(null);
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
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            finish();
        }
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
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        WebResourceError error) {
                if (request.isForMainFrame()) {
                    showSetup("Could not reach server: " + error.getDescription());
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
        sub.setText("Mobile companion");
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
            connect(CLOUD_ACCOUNT_URL);
        });

        LinearLayout.LayoutParams accountBtnLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        accountBtnLp.bottomMargin = dp(22);
        setupPanel.addView(accountBtn, accountBtnLp);

        // Hint
        TextView hint = new TextView(this);
        hint.setText("Enter your Norva hub address");
        hint.setTextColor(Color.parseColor("#a1a1aa"));
        hint.setTextSize(15);
        hint.setPadding(0, 0, 0, dp(10));
        setupPanel.addView(hint);

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
        setupPanel.addView(urlInput, inputLp);

        // Connect button
        Button connectBtn = new Button(this);
        connectBtn.setText("Connect");
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
        setupPanel.addView(connectBtn, btnLp);

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
        setupPanel.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webViewVisible = true;
        webView.loadUrl(url);
        webView.requestFocus();
    }

    private void showSetup(String error) {
        webViewVisible = false;
        webView.setVisibility(View.GONE);
        setupPanel.setVisibility(View.VISIBLE);
        statusText.setText(error == null ? "" : error);
        urlInput.requestFocus();
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
