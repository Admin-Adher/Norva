package tv.norva.phone;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
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

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

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
    private static final int    REQ_NOTIF_PERM  = 1002;
    private static final String DL_UA           =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
    private boolean             cloudBridgeAdded = false;
    private final ExecutorService ioPool = Executors.newCachedThreadPool();

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

        // Offline: with no connectivity but saved downloads present, go straight
        // to the native Downloads library instead of a doomed page load.
        if (!hasNetwork() && !DownloadStore.all(this).isEmpty()) {
            startActivity(new Intent(this, DownloadsActivity.class));
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
        ioPool.shutdownNow();
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

        // ---- Offline downloads ----

        /** Queue a movie for offline download. {@code json} carries url + metadata. */
        @android.webkit.JavascriptInterface
        public void downloadMedia(final String json) {
            startDownload(json);
        }

        /** JSON array of all downloads (id, title, state, progress) for the web UI. */
        @android.webkit.JavascriptInterface
        public String getDownloads() {
            return downloadsJson();
        }

        /** State of one download ("none" | queued | downloading | done | failed). */
        @android.webkit.JavascriptInterface
        public String downloadState(final String id) {
            DownloadStore.Item it = DownloadStore.get(MainActivity.this, id);
            return it == null ? "none" : it.state;
        }

        @android.webkit.JavascriptInterface
        public void deleteDownload(final String id) {
            DownloadService.requestCancel(MainActivity.this, id);
        }

        /** Open the native Downloads screen. */
        @android.webkit.JavascriptInterface
        public void openDownloads() {
            runOnUiThread(() -> startActivity(new Intent(MainActivity.this, DownloadsActivity.class)));
        }

        // ---- Billing (Google Play Billing via RevenueCat) ----

        /** Associate the RevenueCat App User ID with the Supabase user id. */
        @android.webkit.JavascriptInterface
        public void billingLogin(final String userId) {
            NorvaBilling.login(userId);
        }

        /** Start a subscription purchase for the given RevenueCat package id. */
        @android.webkit.JavascriptInterface
        public void purchase(final String packageId, final String planCode, final String requestId) {
            NorvaBilling.purchase(MainActivity.this, packageId,
                    (status, error) -> sendBillingResult(requestId, status, planCode, error));
        }

        /** Restore previous purchases for the signed-in account. */
        @android.webkit.JavascriptInterface
        public void restore(final String requestId) {
            NorvaBilling.restore((status, error) -> sendBillingResult(requestId, status, null, error));
        }
    }

    /** Post a billing result back to the web layer (subscribe.html / billing.js). */
    private void sendBillingResult(String requestId, String status, String planCode, String error) {
        try {
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("requestId", requestId);
            o.put("status", status);
            if (planCode != null) o.put("planCode", planCode);
            if (error != null) o.put("error", error);
            final String js = "window.__norvaBilling && window.__norvaBilling.onResult(" + jsStr(o.toString()) + ")";
            runOnUiThread(() -> {
                try { if (webView != null) webView.evaluateJavascript(js, null); } catch (Exception ignored) { }
            });
        } catch (Exception ignored) { }
    }

    // ---- Offline downloads ----

    /** Build the manifest entry (with envelope-wrapped key) and start the service. */
    private void startDownload(String json) {
        try {
            JSONObject o = new JSONObject(json);
            String url = o.optString("url");
            String sourceId = o.optString("sourceId");
            String itemId = o.optString("itemId");
            if (url.isEmpty() || sourceId.isEmpty() || itemId.isEmpty()) return;
            final String id = sourceId + ":" + itemId;

            DownloadStore.Item existing = DownloadStore.get(this, id);
            if (existing != null) {
                if ("done".equals(existing.state)) return; // already saved
                // queued / downloading / failed: re-queue the SAME entry so the
                // existing per-file key is reused (a new key would corrupt the
                // partial encrypted file on resume). Refresh the provider URL and
                // poster, and re-fetch the poster if it never landed.
                if (url != null && !url.isEmpty()) existing.url = url;
                String freshPoster = o.optString("posterUrl", existing.posterUrl);
                if (freshPoster != null && !freshPoster.isEmpty()) existing.posterUrl = freshPoster;
                existing.state = "queued";
                existing.error = "";
                DownloadStore.put(this, existing);
                ensureNotifPermission();
                startDownloadService(id);
                return;
            }

            DownloadStore.Item it = new DownloadStore.Item();
            it.id = id;
            it.sourceId = sourceId;
            it.itemId = itemId;
            it.itemType = o.optString("itemType", "movie");
            it.title = o.optString("title", "Movie");
            it.subtitle = o.optString("subtitle", "");
            it.season = o.optInt("season", 0);
            it.episodeNum = o.optInt("episode", 0);
            it.episodeTitle = o.optString("episodeTitle", "");
            it.posterUrl = o.optString("posterUrl", "");
            it.container = sanitizeContainer(o.optString("container", "mp4"));
            it.url = url;
            it.durationSeconds = o.optInt("durationSeconds", 0);
            it.state = "queued";
            it.createdAt = System.currentTimeMillis();
            it.queueOrder = it.createdAt; // FIFO by default; reorder edits this

            byte[] dataKey = DownloadCrypto.newDataKey();
            byte[] mediaIv = DownloadCrypto.newMediaIv();
            DownloadCrypto.Wrapped w = DownloadCrypto.wrapDataKey(dataKey);
            it.wrappedKey = DownloadCrypto.b64(w.blob);
            it.keyIv = DownloadCrypto.b64(w.iv);
            it.mediaIv = DownloadCrypto.b64(mediaIv);

            DownloadStore.put(this, it);
            // The download service fetches the poster (single owner -> no race).
            ensureNotifPermission();
            startDownloadService(id);
        } catch (Exception ignored) {
            // The web side simply won't see a new entry appear.
        }
    }

    private void startDownloadService(String id) {
        Intent svc = new Intent(this, DownloadService.class);
        svc.setAction(DownloadService.ACTION_ENQUEUE);
        svc.putExtra(DownloadService.EXTRA_ID, id);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(svc);
        } else {
            startService(svc);
        }
    }

    private void removeDownload(String id) {
        ioPool.execute(() -> {
            DownloadStore.Item it = DownloadStore.get(this, id);
            if (it != null) {
                try { if (it.filePath != null && !it.filePath.isEmpty()) new File(it.filePath).delete(); } catch (Exception ignored) { }
                try { if (it.posterFile != null && !it.posterFile.isEmpty()) new File(it.posterFile).delete(); } catch (Exception ignored) { }
            }
            DownloadStore.remove(this, id);
        });
    }

    private String downloadsJson() {
        try {
            JSONArray arr = new JSONArray();
            for (DownloadStore.Item it : DownloadStore.all(this)) {
                JSONObject o = new JSONObject();
                o.put("id", it.id);
                o.put("sourceId", it.sourceId);
                o.put("itemId", it.itemId);
                o.put("itemType", it.itemType);
                o.put("title", it.title);
                o.put("state", it.state);
                o.put("totalBytes", it.totalBytes);
                o.put("downloadedBytes", it.downloadedBytes);
                o.put("progress", it.totalBytes > 0 ? (int) (it.downloadedBytes * 100 / it.totalBytes) : 0);
                arr.put(o);
            }
            return arr.toString();
        } catch (Exception e) {
            return "[]";
        }
    }

    /** Download the poster once (unencrypted, app-private) so the offline screen has art. */
    private void downloadPosterAsync(String id, String posterUrl) {
        ioPool.execute(() -> {
            HttpURLConnection conn = null;
            try {
                File base = getFilesDir();
                File dir = new File(base, "posters");
                if (!dir.exists()) dir.mkdirs();
                File out = new File(dir, id.replaceAll("[^A-Za-z0-9_.-]", "_") + ".jpg");
                conn = (HttpURLConnection) new URL(posterUrl).openConnection();
                conn.setRequestProperty("User-Agent", DL_UA);
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(20000);
                conn.setInstanceFollowRedirects(true);
                if (conn.getResponseCode() != HttpURLConnection.HTTP_OK) return;
                InputStream in = conn.getInputStream();
                FileOutputStream fos = new FileOutputStream(out);
                byte[] buf = new byte[16 * 1024];
                int n;
                while ((n = in.read(buf)) != -1) fos.write(buf, 0, n);
                fos.close();
                DownloadStore.Item it = DownloadStore.get(this, id);
                if (it != null) {
                    it.posterFile = out.getAbsolutePath();
                    DownloadStore.put(this, it);
                }
            } catch (Exception ignored) {
                // Poster is best-effort; the row just shows a placeholder.
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    private void ensureNotifPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
            runOnUiThread(() -> requestPermissions(
                    new String[]{ Manifest.permission.POST_NOTIFICATIONS }, REQ_NOTIF_PERM));
        }
    }

    private static String sanitizeContainer(String c) {
        if (c == null) return "mp4";
        String s = c.toLowerCase().replaceAll("[^a-z0-9]", "");
        return s.isEmpty() ? "mp4" : s;
    }

    private boolean hasNetwork() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            Network n = cm.getActiveNetwork();
            if (n == null) return false;
            NetworkCapabilities caps = cm.getNetworkCapabilities(n);
            return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        } catch (Exception e) {
            return true; // assume online if we can't tell
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

        Button downloadsBtn = new Button(this);
        downloadsBtn.setText("Downloads");
        downloadsBtn.setTextColor(Color.WHITE);
        downloadsBtn.setBackgroundColor(Color.parseColor("#272d3a"));
        downloadsBtn.setOnClickListener(v ->
                startActivity(new Intent(MainActivity.this, DownloadsActivity.class)));
        LinearLayout.LayoutParams downloadsLp = new LinearLayout.LayoutParams(
                dp(220), LinearLayout.LayoutParams.WRAP_CONTENT);
        downloadsLp.bottomMargin = dp(14);
        errorPanel.addView(downloadsBtn, downloadsLp);

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
