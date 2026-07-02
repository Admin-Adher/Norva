package tv.norva.tv;

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
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
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
    private LinearLayout splashPanel;
    private LinearLayout errorPanel;
    private TextView errorText;
    private Button errorRetryBtn;
    private String lastLoadedUrl;

    // Poster/title of the playback in flight, kept for the launcher's Play Next
    // row (the player result only carries ids + position).
    private String lastPlayTitle;
    private String lastPlayPoster;

    // Deep-link JS (Watch Next click, voice search) queued until the web app is
    // loaded; pumped with retries because the SPA needs a moment to boot.
    private String pendingJs;
    private int pendingJsTries;
    private final android.os.Handler uiHandler = new android.os.Handler(android.os.Looper.getMainLooper());

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

        handleLaunchIntent(getIntent());
    }

    /** Watch Next click / voice search re-entry while the app is already running. */
    @Override
    protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleLaunchIntent(intent);
    }

    /**
     * norva://open?sourceId=..&itemType=..&itemId=.. (Play Next card) opens the
     * title in-app; ACTION_SEARCH forwards the spoken/typed query to the web
     * app's global search. Both are queued as JS and pumped once the SPA is up.
     */
    private void handleLaunchIntent(android.content.Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (android.content.Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            android.net.Uri data = intent.getData();
            if ("norva".equals(data.getScheme()) && "open".equals(data.getHost())) {
                String sourceId = data.getQueryParameter("sourceId");
                String itemType = data.getQueryParameter("itemType");
                String itemId = data.getQueryParameter("itemId");
                if (sourceId != null && itemId != null) {
                    queuePendingJs("(window.__norvaNative && window.__norvaNative.openItem) ? "
                            + "(window.__norvaNative.openItem(" + jsStr(sourceId) + "," + jsStr(itemType)
                            + "," + jsStr(itemId) + "), 'ok') : 'retry'");
                }
            }
        } else if (android.content.Intent.ACTION_SEARCH.equals(action)) {
            String query = intent.getStringExtra(android.app.SearchManager.QUERY);
            if (query != null && !query.trim().isEmpty()) {
                queuePendingJs("(window.__norvaNative && window.__norvaNative.openSearch) ? "
                        + "(window.__norvaNative.openSearch(" + jsStr(query.trim()) + "), 'ok') : 'retry'");
            }
        }
    }

    private void queuePendingJs(String js) {
        pendingJs = js;
        pendingJsTries = 0;
        pumpPendingJs();
    }

    /** Retry the queued deep-link JS until the SPA exposes its hooks (~30 s cap). */
    private void pumpPendingJs() {
        final String js = pendingJs;
        if (js == null || webView == null) return;
        if (pendingJsTries++ > 20) { pendingJs = null; return; }
        webView.evaluateJavascript(js, new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                if (value != null && value.contains("ok")) {
                    if (js.equals(pendingJs)) pendingJs = null;
                    return;
                }
                uiHandler.postDelayed(new Runnable() {
                    @Override public void run() { pumpPendingJs(); }
                }, 1500);
            }
        });
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
            public void onPageFinished(WebView view, String url) {
                hideSplash();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // Only react to failures of the main document, not subresources
                if (request.isForMainFrame()) {
                    hideSplash();
                    showNetworkError(String.valueOf(error.getDescription()));
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
        lastLoadedUrl = url;
        setupPanel.setVisibility(View.GONE);
        if (errorPanel != null) errorPanel.setVisibility(View.GONE);
        showSplash();
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

        // Extensible launch: one JSON payload instead of ever-longer signatures.
        // Carries poster (Play Next artwork) and nextTitle ("À suivre" overlay).
        @android.webkit.JavascriptInterface
        public void playVideoJson(final String json) {
            MainActivity.this.playFromJson(json);
        }

        @android.webkit.JavascriptInterface
        public void playVideoWithMeta(final String url, final String title, final String sourceId,
                                      final String itemType, final String itemId) {
            MainActivity.this.openPlayer(url, title, sourceId, itemType, itemId);
        }

        // Resume-aware variant: starts at resumeSeconds and reports the final
        // position back (cross-device resume). The web feature-detects this, so
        // older APKs that lack it transparently fall back to playVideoWithMeta.
        @android.webkit.JavascriptInterface
        public void playVideoResumable(final String url, final String title, final String sourceId,
                                       final String itemType, final String itemId, final int resumeSeconds) {
            MainActivity.this.openPlayer(url, title, sourceId, itemType, itemId, resumeSeconds);
        }

        // Direct URL + a gateway fallback URL the player switches to if the provider
        // refuses the direct (residential-IP) request with 401/403.
        @android.webkit.JavascriptInterface
        public void playVideoResumableFallback(final String url, final String fallbackUrl, final String title,
                                               final String sourceId, final String itemType, final String itemId,
                                               final int resumeSeconds) {
            MainActivity.this.openPlayer(url, title, sourceId, itemType, itemId, resumeSeconds, fallbackUrl);
        }

        // ---- Billing (Google Play Billing via RevenueCat) ----

        @android.webkit.JavascriptInterface
        public void billingLogin(final String userId) {
            NorvaBilling.login(userId);
        }

        @android.webkit.JavascriptInterface
        public void purchase(final String packageId, final String planCode, final String requestId) {
            NorvaBilling.purchase(MainActivity.this, packageId, new NorvaBilling.ResultCallback() {
                @Override
                public void onResult(String status, String error) {
                    sendBillingResult(requestId, status, planCode, error);
                }
            });
        }

        @android.webkit.JavascriptInterface
        public void restore(final String requestId) {
            NorvaBilling.restore(new NorvaBilling.ResultCallback() {
                @Override
                public void onResult(String status, String error) {
                    sendBillingResult(requestId, status, null, error);
                }
            });
        }
    }

    private class CloudBridge {
        @android.webkit.JavascriptInterface
        public void playVideo(final String url, final String title) {
            MainActivity.this.openPlayer(url, title, null, null, null);
        }

        // Extensible launch: one JSON payload instead of ever-longer signatures.
        // Carries poster (Play Next artwork) and nextTitle ("À suivre" overlay).
        @android.webkit.JavascriptInterface
        public void playVideoJson(final String json) {
            MainActivity.this.playFromJson(json);
        }

        @android.webkit.JavascriptInterface
        public void playVideoWithMeta(final String url, final String title, final String sourceId,
                                      final String itemType, final String itemId) {
            MainActivity.this.openPlayer(url, title, sourceId, itemType, itemId);
        }

        // Resume-aware variant: starts at resumeSeconds and reports the final
        // position back (cross-device resume). The web feature-detects this, so
        // older APKs that lack it transparently fall back to playVideoWithMeta.
        @android.webkit.JavascriptInterface
        public void playVideoResumable(final String url, final String title, final String sourceId,
                                       final String itemType, final String itemId, final int resumeSeconds) {
            MainActivity.this.openPlayer(url, title, sourceId, itemType, itemId, resumeSeconds);
        }

        // Direct URL + a gateway fallback URL the player switches to if the provider
        // refuses the direct (residential-IP) request with 401/403.
        @android.webkit.JavascriptInterface
        public void playVideoResumableFallback(final String url, final String fallbackUrl, final String title,
                                               final String sourceId, final String itemType, final String itemId,
                                               final int resumeSeconds) {
            MainActivity.this.openPlayer(url, title, sourceId, itemType, itemId, resumeSeconds, fallbackUrl);
        }

        // ---- Billing (Google Play Billing via RevenueCat) ----

        @android.webkit.JavascriptInterface
        public void billingLogin(final String userId) {
            NorvaBilling.login(userId);
        }

        @android.webkit.JavascriptInterface
        public void purchase(final String packageId, final String planCode, final String requestId) {
            NorvaBilling.purchase(MainActivity.this, packageId, new NorvaBilling.ResultCallback() {
                @Override
                public void onResult(String status, String error) {
                    sendBillingResult(requestId, status, planCode, error);
                }
            });
        }

        @android.webkit.JavascriptInterface
        public void restore(final String requestId) {
            NorvaBilling.restore(new NorvaBilling.ResultCallback() {
                @Override
                public void onResult(String status, String error) {
                    sendBillingResult(requestId, status, null, error);
                }
            });
        }
    }

    private static final int REQ_PLAYER = 1001;

    private void openPlayer(final String url, final String title, final String sourceId,
                            final String itemType, final String itemId) {
        openPlayer(url, title, sourceId, itemType, itemId, 0);
    }

    private void openPlayer(final String url, final String title, final String sourceId,
                            final String itemType, final String itemId, final int resumeSeconds) {
        openPlayer(url, title, sourceId, itemType, itemId, resumeSeconds, null);
    }

    private void openPlayer(final String url, final String title, final String sourceId,
                            final String itemType, final String itemId, final int resumeSeconds,
                            final String fallbackUrl) {
        openPlayer(url, title, sourceId, itemType, itemId, resumeSeconds, fallbackUrl, null, null);
    }

    private void openPlayer(final String url, final String title, final String sourceId,
                            final String itemType, final String itemId, final int resumeSeconds,
                            final String fallbackUrl, final String poster, final String nextTitle) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                lastPlayTitle = title;
                lastPlayPoster = poster;
                android.content.Intent intent = new android.content.Intent(MainActivity.this, PlayerActivity.class);
                intent.putExtra(PlayerActivity.EXTRA_URL, url);
                intent.putExtra(PlayerActivity.EXTRA_TITLE, title);
                if (sourceId != null) intent.putExtra(PlayerActivity.EXTRA_SOURCE_ID, sourceId);
                if (itemType != null) intent.putExtra(PlayerActivity.EXTRA_ITEM_TYPE, itemType);
                if (itemId != null) intent.putExtra(PlayerActivity.EXTRA_ITEM_ID, itemId);
                if (resumeSeconds > 0) intent.putExtra(PlayerActivity.EXTRA_RESUME_SECONDS, resumeSeconds);
                if (fallbackUrl != null && !fallbackUrl.isEmpty()) intent.putExtra(PlayerActivity.EXTRA_FALLBACK_URL, fallbackUrl);
                if (nextTitle != null && !nextTitle.isEmpty()) intent.putExtra(PlayerActivity.EXTRA_NEXT_TITLE, nextTitle);
                startActivityForResult(intent, REQ_PLAYER);
            }
        });
    }

    /** JSON-payload launch used by the newest web bridge (playVideoJson). */
    private void playFromJson(String json) {
        try {
            org.json.JSONObject o = new org.json.JSONObject(json);
            String url = o.optString("url");
            if (url.isEmpty()) return;
            openPlayer(url,
                    o.optString("title", "Norva"),
                    emptyToNull(o.optString("sourceId")),
                    emptyToNull(o.optString("itemType")),
                    emptyToNull(o.optString("itemId")),
                    o.optInt("resumeSeconds", 0),
                    emptyToNull(o.optString("fallbackUrl")),
                    emptyToNull(o.optString("poster")),
                    emptyToNull(o.optString("nextTitle")));
        } catch (Exception ignored) {
            // A malformed payload simply doesn't start playback; the web side
            // falls back to the legacy fixed-signature bridge methods.
        }
    }

    private static String emptyToNull(String s) {
        return (s == null || s.isEmpty()) ? null : s;
    }

    /**
     * The native player returns its final position when it closes; forward it to
     * the web app, which persists it to the cloud history so other devices
     * resume where this TV left off.
     */
    @Override
    protected void onActivityResult(int requestCode, int resultCode, android.content.Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PLAYER || data == null || webView == null) return;
        final String sourceId = data.getStringExtra("sourceId");
        final String itemType = data.getStringExtra("itemType");
        final String itemId = data.getStringExtra("itemId");
        final long pos = data.getLongExtra("positionSeconds", 0);
        final long dur = data.getLongExtra("durationSeconds", 0);
        final boolean ended = data.getBooleanExtra("ended", false);
        final boolean playNext = data.getBooleanExtra("playNext", false);
        final boolean openEpisodes = data.getBooleanExtra("openEpisodes", false);
        if (sourceId == null || itemId == null) return;
        if (pos > 0) {
            final String js = "window.__norvaNative && window.__norvaNative.onProgress("
                    + jsStr(sourceId) + "," + jsStr(itemType) + "," + jsStr(itemId) + "," + pos + "," + dur + ")";
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try { webView.evaluateJavascript(js, null); } catch (Exception ignored) { }
                }
            });
        }

        // Launcher "Play Next": keep the row in sync with real progress. A title
        // watched to (nearly) the end leaves the row; an in-progress one joins it.
        final boolean watchedOut = ended || (dur > 0 && pos >= dur * 95 / 100);
        final String wnTitle = lastPlayTitle;
        final String wnPoster = lastPlayPoster;
        new Thread(new Runnable() {
            @Override
            public void run() {
                if (watchedOut) {
                    WatchNextHelper.remove(MainActivity.this, sourceId, itemType, itemId);
                } else if (pos >= 60 && !"channel".equals(itemType)) {
                    WatchNextHelper.publishContinue(MainActivity.this, sourceId, itemType, itemId,
                            wnTitle, wnPoster, pos * 1000L, dur * 1000L);
                }
            }
        }, "norva-watch-next").start();

        // Series chaining: the player's "À suivre" overlay picked the next episode
        // (playNext), the stream simply ended (ended → web-side autoplay), or the
        // viewer asked for the episode list (openEpisodes → reopen the fiche).
        String chainJs = null;
        if (playNext) {
            chainJs = "window.__norvaNative && window.__norvaNative.onPlayNext && window.__norvaNative.onPlayNext("
                    + jsStr(sourceId) + "," + jsStr(itemType) + "," + jsStr(itemId) + ")";
        } else if (ended) {
            chainJs = "window.__norvaNative && window.__norvaNative.onEnded && window.__norvaNative.onEnded("
                    + jsStr(sourceId) + "," + jsStr(itemType) + "," + jsStr(itemId) + ")";
        } else if (openEpisodes) {
            chainJs = "window.__norvaNative && window.__norvaNative.openItem && window.__norvaNative.openItem("
                    + jsStr(sourceId) + "," + jsStr(itemType) + "," + jsStr(itemId) + ")";
        }
        if (chainJs != null) {
            final String finalChainJs = chainJs;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try { webView.evaluateJavascript(finalChainJs, null); } catch (Exception ignored) { }
                }
            });
        }
    }

    /** Post a billing result back to the web layer (subscribe.html / billing.js). */
    private void sendBillingResult(final String requestId, final String status, final String planCode, final String error) {
        try {
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("requestId", requestId);
            o.put("status", status);
            if (planCode != null) o.put("planCode", planCode);
            if (error != null) o.put("error", error);
            final String js = "window.__norvaBilling && window.__norvaBilling.onResult(" + jsStr(o.toString()) + ")";
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try { if (webView != null) webView.evaluateJavascript(js, null); } catch (Exception ignored) { }
                }
            });
        } catch (Exception ignored) { }
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
        splashPanel.setGravity(android.view.Gravity.CENTER);
        splashPanel.setBackgroundColor(Color.parseColor("#0a0a0f"));
        splashPanel.setVisibility(View.GONE);

        ImageView logo = new ImageView(this);
        int logoId = getResources().getIdentifier("norva_app_icon", "drawable", getPackageName());
        if (logoId == 0) logoId = getResources().getIdentifier("ic_launcher", "mipmap", getPackageName());
        if (logoId != 0) logo.setImageResource(logoId);
        LinearLayout.LayoutParams logoLp = new LinearLayout.LayoutParams(dp(120), dp(120));
        logoLp.bottomMargin = dp(32);
        splashPanel.addView(logo, logoLp);

        ProgressBar spinner = new ProgressBar(this);
        splashPanel.addView(spinner, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        root.addView(splashPanel, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
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

    /** Friendly "can't reach Norva" screen with a focusable Retry button. */
    private void buildErrorPanel() {
        errorPanel = new LinearLayout(this);
        errorPanel.setOrientation(LinearLayout.VERTICAL);
        errorPanel.setGravity(android.view.Gravity.CENTER);
        errorPanel.setBackgroundColor(Color.parseColor("#0a0a0f"));
        errorPanel.setVisibility(View.GONE);
        int pad = dp(40);
        errorPanel.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("Can't reach Norva");
        title.setTextColor(Color.WHITE);
        title.setTextSize(26);
        title.setGravity(android.view.Gravity.CENTER);
        title.setPadding(0, 0, 0, dp(12));
        errorPanel.addView(title);

        errorText = new TextView(this);
        errorText.setText("Please check your internet connection and try again.");
        errorText.setTextColor(Color.parseColor("#a1a1aa"));
        errorText.setTextSize(16);
        errorText.setGravity(android.view.Gravity.CENTER);
        errorText.setPadding(0, 0, 0, dp(32));
        errorPanel.addView(errorText);

        errorRetryBtn = new Button(this);
        errorRetryBtn.setText("Retry");
        errorRetryBtn.setTextColor(Color.WHITE);
        errorRetryBtn.setBackgroundColor(Color.parseColor("#3B82F6"));
        errorRetryBtn.setOnClickListener(v -> {
            if (lastLoadedUrl != null && !lastLoadedUrl.isEmpty()) {
                connect(lastLoadedUrl);
            } else {
                connectCloudPairing();
            }
        });
        errorPanel.addView(errorRetryBtn, new LinearLayout.LayoutParams(
                dp(260), LinearLayout.LayoutParams.WRAP_CONTENT));

        root.addView(errorPanel, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
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
        if (errorRetryBtn != null) errorRetryBtn.requestFocus();
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
                                // 'exit' = the SPA is on Home with nothing to close.
                                // Its pushState entries make canGoBack() true forever,
                                // so going back would just cycle tab history — confirm
                                // the exit instead (Netflix behavior).
                                if ("exit".equals(v)) {
                                    showExitDialog();
                                } else if (webView.canGoBack()) {
                                    webView.goBack();
                                } else {
                                    showExitDialog();
                                }
                            }
                        });
                    }
                });
    }

    /** "Quitter Norva ?" confirmation on BACK from the Home screen. */
    private void showExitDialog() {
        try {
            new android.app.AlertDialog.Builder(this, android.app.AlertDialog.THEME_DEVICE_DEFAULT_DARK)
                    .setTitle("Quitter Norva ?")
                    .setPositiveButton("Quitter", new android.content.DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(android.content.DialogInterface dialog, int which) { finish(); }
                    })
                    .setNegativeButton("Annuler", null)
                    .show();
        } catch (Exception e) {
            finish();
        }
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
