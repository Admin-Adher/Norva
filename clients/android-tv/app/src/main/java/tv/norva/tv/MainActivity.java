package tv.norva.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
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

import androidx.core.content.ContextCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import tv.norva.analytics.NativeClarity;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Norva TV — Android TV client.
 *
 * Thin WebView wrapper around Norva.
 *
 * The default path pairs the TV with a Norva Account. The MENU key
 * brings back advanced connection options.
 */
public class MainActivity extends Activity {

    @Override
    protected void attachBaseContext(android.content.Context base) {
        super.attachBaseContext(tv.norva.i18n.UiLanguage.wrap(base));
    }


    private static final String PREFS = "norva";
    private static final String PREF_SERVER_URL = "serverUrl";
    private static final String PREF_MODE = "mode"; // "cloud" | "server" | "standalone"
    private static final String PREF_PENDING_PLAYBACK_CLOSES =
            "pendingPlaybackSessionCloses";
    private static final String EXTRA_DEBUG_BUNDLED_DPAD_ASSETS =
            "tv.norva.tv.DEBUG_BUNDLED_DPAD_ASSETS";
    private static final String CLOUD_PAIR_URL = "https://norva.tv/cloud-pair.html?device=tv&returnTo=%2Fapp.html%3Fpaired%3D1%23home";
    // Marker appended to the WebView user agent: the web app detects it and
    // enables TV mode (D-pad spatial navigation, focus outlines).
    private static final String UA_SUFFIX = " NorvaTV-AndroidTV/" + BuildConfig.VERSION_NAME;

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
    private FrameLayout exitPanel;
    private LinearLayout exitActions;
    private View exitReturnFocus;
    private String lastLoadedUrl;
    private boolean cloudBridgeAdded;
    private boolean nativeBridgeAdded;
    // Debug-only emulator audit: serve the just-built D-pad assets over the live
    // cloud shell so real account data can be tested without deploying or changing
    // the cloud origin. Release builds can never enable this path.
    private boolean debugBundledDpadAssets;
    // One recovery request is bound to one playback item and one unguessable
    // token. The next matching JSON launch is returned to the still-visible
    // PlayerActivity instead of opening a second activity.
    private BroadcastReceiver playerRecoveryReceiver;
    private String pendingPlayerRecoveryToken;
    private String pendingPlayerRecoveryKey;
    private long pendingPlayerRecoveryExpiresAtElapsedMs;
    private static final long PLAYER_RECOVERY_TTL_MS = 30_000L;
    // Auth credentials stay in memory and cross the WebView boundary only in
    // response to a canonical nonce owned by the currently active player.
    private BroadcastReceiver playbackAuthReceiver;
    private final Object playbackAuthLock = new Object();
    private String activePlaybackAuthChannelId;
    private String pendingPlaybackAuthRequestNonce;
    private long pendingPlaybackAuthExpiresAtElapsedMs;
    private Intent pendingPlayerLaunchIntent;
    private String pendingPlayerLaunchNonce;
    private long pendingPlayerLaunchExpiresAtElapsedMs;
    private static final long PLAYBACK_AUTH_REQUEST_TTL_MS = 5_000L;

    // Poster/title of the playback in flight, kept for the launcher's Play Next
    // row (the player result only carries ids + position).
    private String lastPlayTitle;
    private String lastPlayPoster;

    // Deep-link JS (Watch Next click, voice search) queued until the web app is
    // loaded; pumped with retries because the SPA needs a moment to boot.
    private String pendingJs;
    private int pendingJsTries;
    // True once the web app SHELL has finished loading and its __norvaNative bridge is
    // available, so a pending native-progress flush only fires against a ready page. Reset on
    // every navigation start and set only when the finished URL IS the app shell — it used to
    // flip true on ANY onPageFinished (cloud-pair.html, error pages) and never back to false,
    // which made the flush consume-and-lose positions against pages with no bridge.
    private volatile boolean webAppReady = false;
    // Retry counter for the pending-progress pump (mirrors the deep-link pump's 20×/1.5s).
    private int pendingProgressTries = 0;
    // Weak live instance for PlayerActivity's in-playback heartbeat relay.
    private static volatile WeakReference<MainActivity> currentRef =
            new WeakReference<>(null);
    private final android.os.Handler uiHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Object playbackCloseLock = new Object();
    private final Map<String, NativePlaybackClosePolicy.Entry> pendingPlaybackSessionCloses =
            new LinkedHashMap<>();
    // Continuations and retry state are memory-only. Durable storage contains
    // only the bounded server UUID, close reason and absolute age anchor.
    private final Map<String, Runnable> pendingPlaybackCloseContinuations =
            new HashMap<>();
    private final Map<String, Integer> playbackCloseDeliveryAttempts =
            new HashMap<>();
    private final Map<String, Runnable> playbackCloseRetryTasks =
            new HashMap<>();
    private final Set<String> acknowledgedPlaybackCloseSessionIds = new LinkedHashSet<>();
    private boolean playbackCloseDeliveryActive = true;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        NativeClarity.configure(BuildConfig.CLARITY_PROJECT_ID, "android_tv", BuildConfig.VERSION_NAME, BuildConfig.DEBUG ? "qa" : "production");
        currentRef = new WeakReference<>(this);
        debugBundledDpadAssets =
                (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
                && getIntent().getBooleanExtra(EXTRA_DEBUG_BUNDLED_DPAD_ASSETS, false);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0a0a0f"));
        setContentView(root);

        buildWebView();
        buildSetupPanel();
        buildErrorPanel();
        buildSplash();
        buildExitPanel();
        NativeClarity.registerSensitiveView(setupPanel);
        NativeClarity.registerSensitiveView(advancedPanel);
        NativeClarity.registerSensitiveView(urlInput);
        NativeClarity.applyStoredConsent(this);
        showSplash();
        registerPlayerRecoveryBridge();
        registerPlaybackAuthBridge();
        loadPendingPlaybackSessionCloses();

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

    private static String recoveryKey(String sourceId, String itemType, String itemId) {
        return String.valueOf(sourceId) + "|" + String.valueOf(itemType) + "|" + String.valueOf(itemId);
    }

    private void clearPendingPlayerRecovery(String token) {
        if (token != null && !token.equals(pendingPlayerRecoveryToken)) return;
        pendingPlayerRecoveryToken = null;
        pendingPlayerRecoveryKey = null;
        pendingPlayerRecoveryExpiresAtElapsedMs = 0L;
    }

    /**
     * Keep the native TV player on screen while the background WebView saves
     * progress and resolves a replacement provider/Gateway URL. The receiver
     * is application-private so another app cannot inject a recovery request.
     */
    private void registerPlayerRecoveryBridge() {
        playerRecoveryReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent == null) return;
                String token = intent.getStringExtra(PlayerActivity.EXTRA_RECOVERY_TOKEN);
                if (PlayerActivity.ACTION_CANCEL_FRESH_STREAM.equals(intent.getAction())) {
                    if (token != null && !token.isEmpty()) {
                        clearPendingPlayerRecovery(token);
                    }
                    return;
                }
                if (!PlayerActivity.ACTION_REQUEST_FRESH_STREAM.equals(intent.getAction())
                        || webView == null) return;
                String sourceId = intent.getStringExtra(PlayerActivity.EXTRA_SOURCE_ID);
                String itemType = intent.getStringExtra(PlayerActivity.EXTRA_ITEM_TYPE);
                String itemId = intent.getStringExtra(PlayerActivity.EXTRA_ITEM_ID);
                if (token == null || token.length() < 16 || token.length() > 160
                        || sourceId == null || sourceId.isEmpty()
                        || itemId == null || itemId.isEmpty()) return;

                pendingPlayerRecoveryToken = token;
                pendingPlayerRecoveryKey = recoveryKey(sourceId, itemType, itemId);
                pendingPlayerRecoveryExpiresAtElapsedMs =
                        android.os.SystemClock.elapsedRealtime() + PLAYER_RECOVERY_TTL_MS;
                long position = Math.max(0L, intent.getLongExtra("positionSeconds", 0L));
                long duration = Math.max(0L, intent.getLongExtra("durationSeconds", 0L));
                String reason = intent.getStringExtra("retryReason");
                String saveProgress = position > 0
                        ? "window.__norvaNative&&window.__norvaNative.onProgress&&"
                        + "window.__norvaNative.onProgress("
                        + jsStr(sourceId) + "," + jsStr(itemType) + "," + jsStr(itemId)
                        + "," + position + "," + duration + ");"
                        : "";
                final String retry = saveProgress
                        + "window.__norvaNative&&window.__norvaNative.retryPlayback&&"
                        + "window.__norvaNative.retryPlayback("
                        + jsStr(sourceId) + "," + jsStr(itemType) + "," + jsStr(itemId)
                        + "," + position + "," + jsStr(reason) + "," + jsStr(token) + ");";
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        try { webView.evaluateJavascript(retry, null); } catch (Exception ignored) { }
                    }
                });
            }
        };
        IntentFilter recoveryFilter =
                new IntentFilter(PlayerActivity.ACTION_REQUEST_FRESH_STREAM);
        recoveryFilter.addAction(PlayerActivity.ACTION_CANCEL_FRESH_STREAM);
        ContextCompat.registerReceiver(
                this,
                playerRecoveryReceiver,
                recoveryFilter,
                ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    /**
     * Receive credential requests only from this application and bind each one
     * to both the active PlayerActivity channel and a one-shot nonce.
     */
    private void registerPlaybackAuthBridge() {
        playbackAuthReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent == null
                        || !PlayerActivity.ACTION_REQUEST_PLAYBACK_AUTH.equals(intent.getAction())
                        || webView == null || !cloudBridgeAdded
                        || !isTrustedCloudUrl(webView.getUrl())) return;
                String channelId = intent.getStringExtra(
                        PlayerActivity.EXTRA_PLAYBACK_AUTH_CHANNEL_ID);
                String requestNonce = intent.getStringExtra(
                        PlayerActivity.EXTRA_PLAYBACK_AUTH_REQUEST_NONCE);
                if (!NativePlaybackAuthPolicy.validNonce(channelId)
                        || !NativePlaybackAuthPolicy.validNonce(requestNonce)) return;
                synchronized (playbackAuthLock) {
                    if (!channelId.equals(activePlaybackAuthChannelId)
                            || pendingPlayerLaunchIntent != null) return;
                    pendingPlaybackAuthRequestNonce = requestNonce;
                    pendingPlaybackAuthExpiresAtElapsedMs =
                            android.os.SystemClock.elapsedRealtime()
                                    + PLAYBACK_AUTH_REQUEST_TTL_MS;
                }
                requestPlaybackAuthFromWeb(channelId, requestNonce);
            }
        };
        ContextCompat.registerReceiver(
                this,
                playbackAuthReceiver,
                new IntentFilter(PlayerActivity.ACTION_REQUEST_PLAYBACK_AUTH),
                ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    /**
     * Ask only the trusted Norva origin for a current credential. A paired-TV
     * device token wins; user sessions use the existing rotation-aware async
     * access-token path. Refresh tokens never leave JavaScript storage.
     */
    private void requestPlaybackAuthFromWeb(final String channelId, final String requestNonce) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                synchronized (playbackAuthLock) {
                    boolean playerRequest = requestNonce.equals(pendingPlaybackAuthRequestNonce);
                    boolean launchRequest = requestNonce.equals(pendingPlayerLaunchNonce);
                    if (!channelId.equals(activePlaybackAuthChannelId)
                            || (!playerRequest && !launchRequest)) return;
                }
                if (webView == null || !cloudBridgeAdded
                        || !isTrustedCloudUrl(webView.getUrl())) {
                    expirePlaybackAuthRequest(channelId, requestNonce);
                    return;
                }
                String script = "(function(){var c=" + jsStr(channelId)
                        + ",n=" + jsStr(requestNonce)
                        + ";var done=function(k,t){try{NorvaTVCloud.providePlaybackAuth("
                        + "c,n,k,typeof t==='string'?t:'');}catch(_){}};try{"
                        + "var d=localStorage.getItem('norva-cloud-device-token')||"
                        + "(window.NorvaCloud&&window.NorvaCloud.deviceToken)||'';"
                        + "if(d){done('device',d);return;}"
                        + "if(window.NorvaAuth&&typeof window.NorvaAuth.getAccessToken==='function'){"
                        + "Promise.resolve(window.NorvaAuth.getAccessToken()).then("
                        + "function(t){done('user',t);},function(){done('none','');});return;}"
                        + "done('none','');}catch(_){done('none','');}})()";
                try {
                    webView.evaluateJavascript(script, null);
                } catch (Exception ignored) {
                    expirePlaybackAuthRequest(channelId, requestNonce);
                    return;
                }
                uiHandler.postDelayed(
                        new Runnable() {
                            @Override public void run() {
                                expirePlaybackAuthRequest(channelId, requestNonce);
                            }
                        },
                        PLAYBACK_AUTH_REQUEST_TTL_MS + 250L);
            }
        });
    }

    /** Claim and clear a timed-out nonce; launch auth fails visibly and closed. */
    private void expirePlaybackAuthRequest(String channelId, String requestNonce) {
        boolean launchExpired = false;
        synchronized (playbackAuthLock) {
            if (channelId == null || requestNonce == null
                    || !channelId.equals(activePlaybackAuthChannelId)) return;
            if (requestNonce.equals(pendingPlayerLaunchNonce)) {
                pendingPlayerLaunchIntent = null;
                pendingPlayerLaunchNonce = null;
                pendingPlayerLaunchExpiresAtElapsedMs = 0L;
                launchExpired = true;
            } else if (requestNonce.equals(pendingPlaybackAuthRequestNonce)) {
                pendingPlaybackAuthRequestNonce = null;
                pendingPlaybackAuthExpiresAtElapsedMs = 0L;
            } else {
                return;
            }
        }
        if (launchExpired) failAuthenticatedPlayerLaunch(channelId);
    }

    /**
     * Accept one response for either the pending launch or the active player's
     * heartbeat/provider-failure request. Duplicate and stale responses are
     * consumed without ever forwarding their credential.
     */
    private void deliverPlaybackAuth(String channelId, String requestNonce,
                                     String kind, String bearer) {
        Intent launchIntent = null;
        boolean playerRequest = false;
        synchronized (playbackAuthLock) {
            if (!NativePlaybackAuthPolicy.validNonce(channelId)
                    || !NativePlaybackAuthPolicy.validNonce(requestNonce)
                    || !channelId.equals(activePlaybackAuthChannelId)) return;
            long now = android.os.SystemClock.elapsedRealtime();
            if (requestNonce.equals(pendingPlayerLaunchNonce)) {
                if (pendingPlayerLaunchExpiresAtElapsedMs <= 0L
                        || now > pendingPlayerLaunchExpiresAtElapsedMs) {
                    pendingPlayerLaunchIntent = null;
                    pendingPlayerLaunchNonce = null;
                    pendingPlayerLaunchExpiresAtElapsedMs = 0L;
                    failAuthenticatedPlayerLaunch(channelId);
                    return;
                }
                launchIntent = pendingPlayerLaunchIntent;
                pendingPlayerLaunchIntent = null;
                pendingPlayerLaunchNonce = null;
                pendingPlayerLaunchExpiresAtElapsedMs = 0L;
            } else if (requestNonce.equals(pendingPlaybackAuthRequestNonce)) {
                if (pendingPlaybackAuthExpiresAtElapsedMs <= 0L
                        || now > pendingPlaybackAuthExpiresAtElapsedMs) {
                    pendingPlaybackAuthRequestNonce = null;
                    pendingPlaybackAuthExpiresAtElapsedMs = 0L;
                    return;
                }
                pendingPlaybackAuthRequestNonce = null;
                pendingPlaybackAuthExpiresAtElapsedMs = 0L;
                playerRequest = true;
            } else {
                return;
            }
        }

        if (!NativePlaybackAuthPolicy.isFreshBearer(
                kind, bearer, System.currentTimeMillis() / 1000L)) {
            if (launchIntent != null) failAuthenticatedPlayerLaunch(channelId);
            return;
        }
        if (launchIntent != null) {
            launchIntent.putExtra(PlayerActivity.EXTRA_PLAYBACK_AUTH_TOKEN, bearer);
            startActivityForResult(launchIntent, REQ_PLAYER);
            return;
        }
        if (playerRequest) {
            Intent response = new Intent(PlayerActivity.ACTION_APPLY_PLAYBACK_AUTH)
                    .setPackage(getPackageName())
                    .putExtra(PlayerActivity.EXTRA_PLAYBACK_AUTH_CHANNEL_ID, channelId)
                    .putExtra(PlayerActivity.EXTRA_PLAYBACK_AUTH_REQUEST_NONCE, requestNonce)
                    .putExtra(PlayerActivity.EXTRA_PLAYBACK_AUTH_KIND, kind)
                    .putExtra(PlayerActivity.EXTRA_PLAYBACK_AUTH_TOKEN, bearer);
            sendBroadcast(response);
        }
    }

    private String activatePlaybackAuthChannel(Intent intent) {
        String channelId = UUID.randomUUID().toString();
        synchronized (playbackAuthLock) {
            activePlaybackAuthChannelId = channelId;
            pendingPlaybackAuthRequestNonce = null;
            pendingPlaybackAuthExpiresAtElapsedMs = 0L;
            pendingPlayerLaunchIntent = null;
            pendingPlayerLaunchNonce = null;
            pendingPlayerLaunchExpiresAtElapsedMs = 0L;
        }
        intent.putExtra(PlayerActivity.EXTRA_PLAYBACK_AUTH_CHANNEL_ID, channelId);
        return channelId;
    }

    private void clearPlaybackAuthChannel(String channelId) {
        synchronized (playbackAuthLock) {
            if (channelId != null && !channelId.equals(activePlaybackAuthChannelId)) return;
            activePlaybackAuthChannelId = null;
            pendingPlaybackAuthRequestNonce = null;
            pendingPlaybackAuthExpiresAtElapsedMs = 0L;
            pendingPlayerLaunchIntent = null;
            pendingPlayerLaunchNonce = null;
            pendingPlayerLaunchExpiresAtElapsedMs = 0L;
        }
    }

    private void beginAuthenticatedPlayerLaunch(Intent intent, String channelId) {
        String requestNonce = UUID.randomUUID().toString();
        synchronized (playbackAuthLock) {
            if (!channelId.equals(activePlaybackAuthChannelId)) return;
            pendingPlayerLaunchIntent = intent;
            pendingPlayerLaunchNonce = requestNonce;
            pendingPlayerLaunchExpiresAtElapsedMs =
                    android.os.SystemClock.elapsedRealtime() + PLAYBACK_AUTH_REQUEST_TTL_MS;
        }
        requestPlaybackAuthFromWeb(channelId, requestNonce);
    }

    private void failAuthenticatedPlayerLaunch(String channelId) {
        if (channelId != null) clearPlaybackAuthChannel(channelId);
        runOnUiThread(new Runnable() {
            @Override public void run() {
                showNetworkError(getString(R.string.native_playback_auth_error));
            }
        });
    }

    /**
     * Intercept only the JSON response for the active recovery. Normal title
     * selections still launch a new PlayerActivity.
     */
    private boolean deliverRecoveredStreamToPlayer(org.json.JSONObject payload) {
        if (payload == null) return false;
        String responseToken = emptyToNull(payload.optString("recoveryToken"));
        // A JSON launch without a token is a normal viewer action. A launch
        // with a token is recovery-only: consume stale/expired responses so
        // they can never open a second PlayerActivity after a newer request.
        if (responseToken == null) return false;

        String token = pendingPlayerRecoveryToken;
        String expectedKey = pendingPlayerRecoveryKey;
        if (token == null || expectedKey == null) return true;
        if (!token.equals(responseToken)) return true;
        if (pendingPlayerRecoveryExpiresAtElapsedMs <= 0L
                || android.os.SystemClock.elapsedRealtime()
                > pendingPlayerRecoveryExpiresAtElapsedMs) {
            clearPendingPlayerRecovery(token);
            return true;
        }
        String sourceId = emptyToNull(payload.optString("sourceId"));
        String itemType = emptyToNull(payload.optString("itemType"));
        String itemId = emptyToNull(payload.optString("itemId"));
        if (!expectedKey.equals(recoveryKey(sourceId, itemType, itemId))) return true;

        clearPendingPlayerRecovery(token);
        Intent response = new Intent(PlayerActivity.ACTION_APPLY_FRESH_STREAM)
                .setPackage(getPackageName())
                .putExtra(PlayerActivity.EXTRA_RECOVERY_TOKEN, token)
                .putExtra(PlayerActivity.EXTRA_RECOVERY_PAYLOAD, payload.toString());
        sendBroadcast(response);
        return true;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void buildWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0a0a0f"));

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setUserAgentString(s.getUserAgentString() + UA_SUFFIX);
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
                if (debugBundledDpadAssets && message != null
                        && message.message().startsWith("[TV-AUDIT]")) {
                    android.util.Log.i("NorvaTV", message.message());
                }
                return super.onConsoleMessage(message);
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(
                    WebView view, WebResourceRequest request) {
                WebResourceResponse bundled = bundledDpadAssetForAudit(request);
                return bundled != null ? bundled : super.shouldInterceptRequest(view, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request == null || !request.isForMainFrame()) return false;
                return routeTopLevelNavigation(request.getUrl() == null
                        ? null : request.getUrl().toString());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return routeTopLevelNavigation(url);
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                configureWebSecurity(url);
                // Honest readiness: navigating away (pairing screen, error page, redirect)
                // means the bridge is gone until the next app-shell finishes loading.
                webAppReady = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                hideSplash();
                webAppReady = isAppShellUrl(url);
                if (!webAppReady) return; // no bridge on this page — nothing to flush against
                // Flush any position the native player persisted before a non-graceful
                // exit (power-off/standby/crash). Small delay lets standalone.js install
                // window.__norvaNative before we call onProgress; the pump then retries
                // like the deep-link pump, and only a CONFIRMED cloud save clears the record.
                view.postDelayed(new Runnable() {
                    @Override public void run() {
                        flushPendingNativeProgress();
                        flushPendingPlaybackSessionCloses(true);
                    }
                }, 1500);
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
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // A renderer crash must not take down the Android TV process. WebView
                // cannot be reused after this callback, so destroy it, recreate every
                // JS bridge on a fresh instance, and reload the current page.
                recoverFromRendererCrash(view, detail);
                return true;
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                // Never bypass certificate validation, including for LAN servers.
                // Users can still connect to an explicit local HTTP endpoint.
                handler.cancel();
            }
        });

        installOriginScopedNativeAnalyticsChannel();

        root.addView(webView, 0, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    }

    /** Accept only bounded analytics messages from Norva's HTTPS main frame. */
    private void installOriginScopedNativeAnalyticsChannel() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        WebViewCompat.addWebMessageListener(webView, "NorvaAnalyticsNative",
                java.util.Collections.singleton("https://norva.tv"),
                new WebViewCompat.WebMessageListener() {
                    @Override
                    public void onPostMessage(WebView view, WebMessageCompat message,
                                              Uri sourceOrigin, boolean isMainFrame,
                                              JavaScriptReplyProxy replyProxy) {
                        if (!isMainFrame || sourceOrigin == null || view == null
                                || !isTrustedCloudUrl(sourceOrigin.toString())
                                || !isTrustedCloudUrl(view.getUrl())) return;
                        NativeClarity.handleMessage(
                                MainActivity.this,
                                message == null ? null : message.getData(),
                                null);
                    }
                });
    }

    private WebResourceResponse bundledDpadAssetForAudit(WebResourceRequest request) {
        if (!debugBundledDpadAssets || request == null || request.getUrl() == null) return null;
        Uri uri = request.getUrl();
        if (!"https".equalsIgnoreCase(uri.getScheme())
                || !"norva.tv".equalsIgnoreCase(uri.getHost())) {
            return null;
        }
        String assetPath;
        String mimeType;
        String path = uri.getPath();
        if ("/js/navigation/NavigationModel.js".equals(path)) {
            assetPath = "www/js/navigation/NavigationModel.js";
            mimeType = "application/javascript";
        } else if ("/js/navigation/NavigationAdapters.js".equals(path)) {
            assetPath = "www/js/navigation/NavigationAdapters.js";
            mimeType = "application/javascript";
        } else if ("/js/navigation/navigationBootstrap.js".equals(path)) {
            assetPath = "www/js/navigation/navigationBootstrap.js";
            mimeType = "application/javascript";
        } else if ("/js/utils/tvNavigation.js".equals(path)) {
            assetPath = "www/js/utils/tvNavigation.js";
            mimeType = "application/javascript";
        } else if ("/js/utils/sourceHealth.js".equals(path)) {
            assetPath = "www/js/utils/sourceHealth.js";
            mimeType = "application/javascript";
        } else if ("/js/utils/GenreRails.js".equals(path)) {
            assetPath = "www/js/utils/GenreRails.js";
            mimeType = "application/javascript";
        } else if ("/js/utils/standalone.js".equals(path)) {
            assetPath = "www/js/utils/standalone.js";
            mimeType = "application/javascript";
        } else if ("/js/api.js".equals(path)) {
            assetPath = "www/js/api.js";
            mimeType = "application/javascript";
        } else if ("/js/cloudApi.js".equals(path)) {
            assetPath = "www/js/cloudApi.js";
            mimeType = "application/javascript";
        } else if ("/js/app.js".equals(path)) {
            assetPath = "www/js/app.js";
            mimeType = "application/javascript";
        } else if ("/js/profiles.js".equals(path)) {
            assetPath = "www/js/profiles.js";
            mimeType = "application/javascript";
        } else if ("/js/pages/HomePage.js".equals(path)) {
            assetPath = "www/js/pages/HomePage.js";
            mimeType = "application/javascript";
        } else if ("/js/pages/LivePage.js".equals(path)) {
            assetPath = "www/js/pages/LivePage.js";
            mimeType = "application/javascript";
        } else if ("/js/pages/WatchPage.js".equals(path)) {
            assetPath = "www/js/pages/WatchPage.js";
            mimeType = "application/javascript";
        } else if ("/js/pages/MoviesPage.js".equals(path)) {
            assetPath = "www/js/pages/MoviesPage.js";
            mimeType = "application/javascript";
        } else if ("/js/pages/SeriesPage.js".equals(path)) {
            assetPath = "www/js/pages/SeriesPage.js";
            mimeType = "application/javascript";
        } else if ("/js/pages/Settings.js".equals(path)) {
            assetPath = "www/js/pages/Settings.js";
            mimeType = "application/javascript";
        } else if ("/js/components/ChannelList.js".equals(path)) {
            assetPath = "www/js/components/ChannelList.js";
            mimeType = "application/javascript";
        } else if ("/js/components/VideoPlayer.js".equals(path)) {
            assetPath = "www/js/components/VideoPlayer.js";
            mimeType = "application/javascript";
        } else if ("/js/components/LiveGuideFusion.js".equals(path)) {
            assetPath = "www/js/components/LiveGuideFusion.js";
            mimeType = "application/javascript";
        } else if ("/js/components/MultiSelect.js".equals(path)) {
            assetPath = "www/js/components/MultiSelect.js";
            mimeType = "application/javascript";
        } else if ("/js/components/TitleRatingControl.js".equals(path)) {
            assetPath = "www/js/components/TitleRatingControl.js";
            mimeType = "application/javascript";
        } else if ("/img/icons/norva-thumb-up.svg".equals(path)) {
            assetPath = "www/img/icons/norva-thumb-up.svg";
            mimeType = "image/svg+xml";
        } else if ("/img/icons/norva-thumb-down.svg".equals(path)) {
            assetPath = "www/img/icons/norva-thumb-down.svg";
            mimeType = "image/svg+xml";
        } else if ("/img/icons/norva-account.svg".equals(path)) {
            assetPath = "www/img/icons/norva-account.svg";
            mimeType = "image/svg+xml";
        } else if ("/img/icons/norva-movies.svg".equals(path)) {
            assetPath = "www/img/icons/norva-movies.svg";
            mimeType = "image/svg+xml";
        } else if ("/img/icons/norva-live-tv.svg".equals(path)) {
            assetPath = "www/img/icons/norva-live-tv.svg";
            mimeType = "image/svg+xml";
        } else if ("/img/icons/norva-logout.svg".equals(path)) {
            assetPath = "www/img/icons/norva-logout.svg";
            mimeType = "image/svg+xml";
        } else if ("/app".equals(path) || "/app.html".equals(path)) {
            assetPath = "www/app.html";
            mimeType = "text/html";
        } else if ("/css/main.css".equals(path)) {
            assetPath = "www/css/main.css";
            mimeType = "text/css";
        } else {
            return null;
        }
        try {
            android.util.Log.i("NorvaTV", "Serving bundled D-pad audit asset: " + path);
            return new WebResourceResponse(
                    mimeType,
                    "UTF-8",
                    getAssets().open(assetPath)
            );
        } catch (java.io.IOException error) {
            android.util.Log.e("NorvaTV", "Bundled D-pad audit asset unavailable: " + path, error);
            return null;
        }
    }

    private static String markRendererRecovery(String url) {
        if (url == null || url.isEmpty()) return url;
        try {
            Uri uri = Uri.parse(url);
            if ("1".equals(uri.getQueryParameter("_rendererRecovery"))) return url;
            return uri.buildUpon()
                    .appendQueryParameter("_rendererRecovery", "1")
                    .build()
                    .toString();
        } catch (Exception ignored) {
            return url;
        }
    }

    @android.annotation.TargetApi(26)
    private void recoverFromRendererCrash(WebView crashedView, RenderProcessGoneDetail detail) {
        String recoveryUrl = null;
        try {
            recoveryUrl = crashedView == null ? null : crashedView.getUrl();
        } catch (Exception ignored) {
            // The renderer is already gone; lastLoadedUrl remains the safe fallback.
        }
        if (recoveryUrl == null || recoveryUrl.isEmpty()) recoveryUrl = lastLoadedUrl;

        android.util.Log.e("NorvaTV",
                "WebView renderer exited (crash=" + (detail != null && detail.didCrash()) + "); rebuilding");
        webAppReady = false;
        webViewVisible = false;

        if (crashedView != null) {
            if (root != null) root.removeView(crashedView);
            try {
                crashedView.destroy();
            } catch (Exception ignored) {
                // The dead renderer may reject cleanup calls; it is already detached.
            }
        }
        if (crashedView != webView || isFinishing() || isDestroyed()) return;

        webView = null;
        cloudBridgeAdded = false;
        nativeBridgeAdded = false;
        showSplash();
        buildWebView();

        String mode = prefs().getString(PREF_MODE, null);
        setBridgeMode("cloud".equals(mode), "standalone".equals(mode));
        if (recoveryUrl == null || recoveryUrl.isEmpty()) {
            showNetworkError("The TV browser restarted. Select Retry to reconnect.");
            return;
        }

        configureWebSecurity(recoveryUrl);
        setupPanel.setVisibility(View.GONE);
        if (errorPanel != null) errorPanel.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webViewVisible = true;
        webView.loadUrl(withShellCacheBust(markRendererRecovery(recoveryUrl)));
        webView.requestFocus();
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
        cloudHint.setText(R.string.ui_recommended);
        cloudHint.setTextColor(Color.parseColor("#a1a1aa"));
        cloudHint.setTextSize(15);
        cloudHint.setPadding(0, 0, 0, dp(10));
        setupPanel.addView(cloudHint, new LinearLayout.LayoutParams(dp(560), LinearLayout.LayoutParams.WRAP_CONTENT));

        Button cloudBtn = new Button(this);
        cloudBtn.setText(R.string.ui_connect_tv);
        cloudBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                prefs().edit().putString(PREF_MODE, "cloud").apply();
                connectCloudPairing();
            }
        });
        setupPanel.addView(cloudBtn, new LinearLayout.LayoutParams(dp(320), LinearLayout.LayoutParams.WRAP_CONTENT));

        Button advancedToggle = new Button(this);
        advancedToggle.setText(R.string.ui_advanced_setup);
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
        localLabel.setText(R.string.ui_local_connector);
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
        connectBtn.setText(R.string.ui_connect_local);
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
        orLabel.setText(R.string.ui_or);
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
        standaloneBtn.setText(R.string.ui_standalone);
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
        tip.setText("Advanced connection options: press MENU, or press BACK from Home and pick \"Connection settings\".");
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
        String mode = prefs().getString(PREF_MODE, null);
        if ("cloud".equals(mode)) {
            if (!isTrustedCloudUrl(url)) {
                openExternalUrl(url);
                return;
            }
            setBridgeMode(true, false);
        } else if ("standalone".equals(mode)) {
            setBridgeMode(false, true);
        } else {
            setBridgeMode(false, false);
        }
        connectInternal(url);
    }

    private void connectInternal(String url) {
        lastLoadedUrl = url;
        configureWebSecurity(url);
        webView.addJavascriptInterface(new tv.norva.i18n.UiLanguageBridge(this), "NorvaLocaleNative");
        setupPanel.setVisibility(View.GONE);
        if (errorPanel != null) errorPanel.setVisibility(View.GONE);
        showSplash();
        webView.setVisibility(View.VISIBLE);
        webViewVisible = true;
        webView.loadUrl(withShellCacheBust(url));
        webView.requestFocus();
    }

    /**
     * Cache-bust the norva.tv app shell on every load.
     *
     * The cloud-pair and app HTML shells are served no-store so their freshly
     * hashed /css + /js references are always current — but that header is recent,
     * and a WebView that cached the shell under the previous must-revalidate policy
     * can cling to an OLD shell (and thus an OLD /css/main.css hash it holds
     * `immutable` for a year), stranding the TV on stale UI even after a clean
     * deploy. Appending a per-launch `_cb` param gives the shell a URL the WebView
     * cache has never seen, forcing a real refetch of the shell and, through its new
     * hashes, the current CSS/JS. Scoped to norva.tv HTML documents plus the
     * extensionless /app route: LAN mode, media URLs and other paths are left
     * untouched, and the immutable hashed assets still cache forever — only the tiny
     * shell document is refetched. (Ported from the phone client, which fixed this
     * exact staleness.)
     */
    /**
     * The SPA shell — norva.tv /app or /app.html, plus the embedded/LAN server root.
     * Pairing, landing and error documents do NOT count: flushing progress against
     * them silently no-ops.
     */
    private static boolean isAppShellUrl(String url) {
        if (url == null) return false;
        try {
            Uri u = Uri.parse(url);
            String path = u.getPath();
            if (path == null || path.isEmpty()) path = "/";
            String host = u.getHost();
            boolean norva = "norva.tv".equalsIgnoreCase(host);
            if (norva) {
                return "/app".equals(path) || "/app.html".equals(path);
            }
            // Embedded (127.0.0.1) and authorized LAN "server" mode may serve
            // the app at their root, index.html or a nested app.html path.
            if ("/".equals(path)
                    || path.endsWith("/app.html")
                    || path.endsWith("/index.html")) return true;
        } catch (Exception ignored) { /* fall through */ }
        return false;
    }

    private static String withShellCacheBust(String url) {
        if (url == null) return null;
        try {
            Uri u = Uri.parse(url);
            if (!"norva.tv".equalsIgnoreCase(u.getHost())) return url;
            String path = u.getPath();
            boolean shellDocument = path != null
                    && (path.endsWith(".html") || "/app".equals(path));
            if (!shellDocument) return url;
            String frag = u.getFragment();
            String out = u.buildUpon()
                    .fragment(null)
                    .appendQueryParameter("_cb", Long.toString(System.currentTimeMillis()))
                    .build()
                    .toString();
            if (frag != null && !frag.isEmpty()) out = out + "#" + frag;
            return out;
        } catch (Exception e) {
            return url;
        }
    }

    private void connectCloudPairing() {
        setBridgeMode(true, false);
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
        setBridgeMode(false, true);
        connect("http://127.0.0.1:" + LocalServer.PORT + "/");
    }

    private void setBridgeMode(boolean cloud, boolean nativeBridge) {
        if (cloud && !cloudBridgeAdded) {
            webView.addJavascriptInterface(new CloudBridge(), "NorvaTVCloud");
            cloudBridgeAdded = true;
        } else if (!cloud && cloudBridgeAdded) {
            webView.removeJavascriptInterface("NorvaTVCloud");
            cloudBridgeAdded = false;
        }
        if (nativeBridge && !nativeBridgeAdded) {
            webView.addJavascriptInterface(new NativeBridge(), "NodeCastNative");
            nativeBridgeAdded = true;
        } else if (!nativeBridge && nativeBridgeAdded) {
            webView.removeJavascriptInterface("NodeCastNative");
            nativeBridgeAdded = false;
        }
    }

    private void configureWebSecurity(String url) {
        if (webView == null) return;
        boolean cloud = "cloud".equals(prefs().getString(PREF_MODE, null))
                || isTrustedCloudUrl(url);
        WebSettings settings = webView.getSettings();
        settings.setMixedContentMode(cloud
                ? WebSettings.MIXED_CONTENT_NEVER_ALLOW
                : WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setAllowFileAccess(!cloud);
        settings.setAllowContentAccess(!cloud);
    }

    private boolean routeTopLevelNavigation(String url) {
        if (url == null || url.isEmpty()) return true;
        String mode = prefs().getString(PREF_MODE, null);
        if ("cloud".equals(mode) && isTrustedCloudUrl(url)) return false;
        if (("server".equals(mode) || "standalone".equals(mode))
                && isSameOrigin(url, lastLoadedUrl)) return false;
        openExternalUrl(url);
        return true;
    }

    private void openExternalUrl(String url) {
        if (url == null || url.isEmpty()) return;
        try {
            android.content.Intent intent = new android.content.Intent(
                    android.content.Intent.ACTION_VIEW, Uri.parse(url));
            intent.addCategory(android.content.Intent.CATEGORY_BROWSABLE);
            startActivity(intent);
        } catch (Exception ignored) {
            android.widget.Toast.makeText(this, getString(R.string.ui_no_link_app),
                    android.widget.Toast.LENGTH_SHORT).show();
        }
    }

    private static boolean isTrustedCloudUrl(String value) {
        if (value == null || value.isEmpty()) return false;
        if (!PartnersTvContract.isTrustedNorvaCloudUrl(value)) return false;
        try {
            Uri uri = Uri.parse(value);
            int port = uri.getPort();
            return "https".equalsIgnoreCase(uri.getScheme())
                    && "norva.tv".equalsIgnoreCase(uri.getHost())
                    && (port == -1 || port == 443);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean isSameOrigin(String left, String right) {
        if (left == null || right == null) return false;
        try {
            Uri a = Uri.parse(left);
            Uri b = Uri.parse(right);
            int aPort = a.getPort() == -1 ? defaultPort(a.getScheme()) : a.getPort();
            int bPort = b.getPort() == -1 ? defaultPort(b.getScheme()) : b.getPort();
            return a.getScheme() != null && b.getScheme() != null
                    && a.getHost() != null && b.getHost() != null
                    && a.getScheme().equalsIgnoreCase(b.getScheme())
                    && a.getHost().equalsIgnoreCase(b.getHost())
                    && aPort == bPort;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static int defaultPort(String scheme) {
        return "https".equalsIgnoreCase(scheme) ? 443 : 80;
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

        // The web layer's history save SUCCEEDED for the pending record carrying this token —
        // safe to drop the SharedPreferences safety net (see pumpPendingProgress).
        @android.webkit.JavascriptInterface
        public void onProgressSaved(final String token) {
            MainActivity.this.confirmProgressSaved(token);
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

        // The web layer's history save SUCCEEDED for the pending record carrying this token —
        // safe to drop the SharedPreferences safety net (see pumpPendingProgress).
        @android.webkit.JavascriptInterface
        public void onProgressSaved(final String token) {
            MainActivity.this.confirmProgressSaved(token);
        }

        /** Complete exactly one nonce-scoped native launch/liveness request. */
        @android.webkit.JavascriptInterface
        public void providePlaybackAuth(final String channelId, final String requestNonce,
                                        final String kind, final String bearer) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    deliverPlaybackAuth(channelId, requestNonce, kind, bearer);
                }
            });
        }

        /** Terminal ACK after standalone.js confirms exact server-side expiry. */
        @android.webkit.JavascriptInterface
        public void ackPlaybackSessionClosed(final String sessionId) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    acknowledgePlaybackSessionClosed(sessionId);
                }
            });
        }
    }

    private static final int REQ_PLAYER = 1001;
    // Keep these keys in sync with PlayerActivity. They intentionally match the
    // phone client so a playback payload has the same contract on every Android
    // surface, even while the TV reader is being integrated separately.
    private static final String EXTRA_TRACK_METADATA = "trackMetadata";
    private static final String EXTRA_PREFERENCE_SCOPE = "preferenceScope";
    private static final String EXTRA_PLAYBACK_PREFERENCES = "playbackPreferences";

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
        openPlayer(url, title, sourceId, itemType, itemId, resumeSeconds, fallbackUrl, null, null, null, null);
    }

    private void openPlayer(final String url, final String title, final String sourceId,
                            final String itemType, final String itemId, final int resumeSeconds,
                            final String fallbackUrl, final String poster, final String nextTitle) {
        openPlayer(url, title, sourceId, itemType, itemId, resumeSeconds, fallbackUrl, poster, nextTitle, null, null);
    }

    private void openPlayer(final String url, final String title, final String sourceId,
                            final String itemType, final String itemId, final int resumeSeconds,
                            final String fallbackUrl, final String poster, final String nextTitle,
                            final String variantsJson, final String activeStreamId) {
        openPlayer(url, title, sourceId, itemType, itemId, resumeSeconds, fallbackUrl,
                poster, nextTitle, variantsJson, activeStreamId, null, null, null);
    }

    private void openPlayer(final String url, final String title, final String sourceId,
                            final String itemType, final String itemId, final int resumeSeconds,
                            final String fallbackUrl, final String poster, final String nextTitle,
                            final String variantsJson, final String activeStreamId,
                            final String trackMetadataJson, final String preferenceScopeJson,
                            final String playbackPreferencesJson) {
        openPlayer(url, title, sourceId, itemType, itemId, resumeSeconds, fallbackUrl,
                poster, nextTitle, variantsJson, activeStreamId, trackMetadataJson,
                preferenceScopeJson, playbackPreferencesJson, null);
    }

    private void openPlayer(final String url, final String title, final String sourceId,
                            final String itemType, final String itemId, final int resumeSeconds,
                            final String fallbackUrl, final String poster, final String nextTitle,
                            final String variantsJson, final String activeStreamId,
                            final String trackMetadataJson, final String preferenceScopeJson,
                            final String playbackPreferencesJson,
                            final String playbackSessionId) {
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
                if (poster != null && !poster.isEmpty()) intent.putExtra(PlayerActivity.EXTRA_POSTER_URL, poster);
                if (nextTitle != null && !nextTitle.isEmpty()) intent.putExtra(PlayerActivity.EXTRA_NEXT_TITLE, nextTitle);
                if (variantsJson != null && !variantsJson.isEmpty()) intent.putExtra(PlayerActivity.EXTRA_VARIANTS, variantsJson);
                if (activeStreamId != null && !activeStreamId.isEmpty()) intent.putExtra(PlayerActivity.EXTRA_ACTIVE_VARIANT, activeStreamId);
                if (trackMetadataJson != null && !trackMetadataJson.isEmpty()) {
                    intent.putExtra(EXTRA_TRACK_METADATA, trackMetadataJson);
                }
                if (preferenceScopeJson != null && !preferenceScopeJson.isEmpty()) {
                    intent.putExtra(EXTRA_PREFERENCE_SCOPE, preferenceScopeJson);
                }
                if (playbackPreferencesJson != null && !playbackPreferencesJson.isEmpty()) {
                    intent.putExtra(EXTRA_PLAYBACK_PREFERENCES, playbackPreferencesJson);
                }
                if (playbackSessionId != null && !playbackSessionId.isEmpty()) {
                    intent.putExtra(PlayerActivity.EXTRA_PLAYBACK_SESSION_ID, playbackSessionId);
                }
                launchPlayerWithEphemeralAuth(intent);
            }
        });
    }

    private void launchPlayerWithEphemeralAuth(final android.content.Intent intent) {
        final boolean trustedCloud = webView != null && cloudBridgeAdded
                && isTrustedCloudUrl(webView.getUrl());
        final String rawSessionId = intent.getStringExtra(
                PlayerActivity.EXTRA_PLAYBACK_SESSION_ID);
        final String boundedSessionId = NativePlaybackTelemetry.boundedSessionId(rawSessionId);

        // Standalone/server playback has no cloud credential or liveness lease;
        // an optional local resolver id must not turn that mode into cloud auth.
        if (!cloudBridgeAdded) {
            startActivityForResult(intent, REQ_PLAYER);
            return;
        }
        // A cloud callback never falls through without fresh authentication.
        // Malformed cloud UUIDs fail closed instead of being silently dropped.
        if (!trustedCloud || (rawSessionId != null && boundedSessionId == null)) {
            failAuthenticatedPlayerLaunch(null);
            return;
        }

        String channelId = activatePlaybackAuthChannel(intent);
        beginAuthenticatedPlayerLaunch(intent, channelId);
    }

    /** JSON-payload launch used by the newest web bridge (playVideoJson). */
    private void playFromJson(final String json) {
        // @JavascriptInterface methods run on WebView's private bridge thread.
        // Recovery state is owned by the main thread (BroadcastReceiver,
        // lifecycle and Activity launch), so serialize parsing + token delivery
        // there before reading or clearing pendingPlayerRecovery*.
        if (android.os.Looper.myLooper() != android.os.Looper.getMainLooper()) {
            runOnUiThread(new Runnable() {
                @Override public void run() { playFromJson(json); }
            });
            return;
        }
        try {
            org.json.JSONObject o = new org.json.JSONObject(json);
            String url = o.optString("url");
            if (url.isEmpty()) return;
            if (deliverRecoveredStreamToPlayer(o)) return;
            org.json.JSONArray variants = o.optJSONArray("variants");
            org.json.JSONObject trackMetadata = o.optJSONObject("trackMetadata");
            org.json.JSONObject preferenceScope = o.optJSONObject("preferenceScope");
            org.json.JSONObject playbackPreferences = o.optJSONObject("playbackPreferences");
            openPlayer(url,
                    o.optString("title", "Norva"),
                    emptyToNull(o.optString("sourceId")),
                    emptyToNull(o.optString("itemType")),
                    emptyToNull(o.optString("itemId")),
                    o.optInt("resumeSeconds", 0),
                    emptyToNull(o.optString("fallbackUrl")),
                    emptyToNull(o.optString("poster")),
                    emptyToNull(o.optString("nextTitle")),
                    (variants != null && variants.length() > 1) ? variants.toString() : null,
                    emptyToNull(o.optString("activeStreamId")),
                    trackMetadata == null ? null : trackMetadata.toString(),
                    preferenceScope == null ? null : preferenceScope.toString(),
                    playbackPreferences == null ? null : playbackPreferences.toString(),
                    emptyToNull(o.optString("sessionId")));
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
        if (requestCode != REQ_PLAYER) return;
        String returnedPlaybackAuthChannel = data == null
                ? null : data.getStringExtra(PlayerActivity.EXTRA_PLAYBACK_AUTH_CHANNEL_ID);
        if (returnedPlaybackAuthChannel != null) {
            clearPlaybackAuthChannel(returnedPlaybackAuthChannel);
        }
        // Backup acknowledgement for timeout/Back cancellation. The private
        // cancellation broadcast normally clears this first; the result token
        // covers lifecycle races where MainActivity was not resumed yet.
        String returnedRecoveryToken = data == null
                ? null : data.getStringExtra(PlayerActivity.EXTRA_RECOVERY_TOKEN);
        if (returnedRecoveryToken != null && !returnedRecoveryToken.isEmpty()) {
            clearPendingPlayerRecovery(returnedRecoveryToken);
        }
        // Returning from the native player is terminal for its current recovery
        // ownership. A late resolver response must be consumed, never relaunched.
        clearPendingPlayerRecovery(null);
        if (data == null) return;

        // Progress and track preferences cannot create a provider session. Relay
        // them immediately while the Activity result is still in memory; actions
        // that can resolve the next stream remain gated on exact close + ACK.
        persistPlayerResultState(data);
        queuePlaybackSessionClose(
                data.getStringExtra(PlayerActivity.EXTRA_PLAYBACK_SESSION_ID),
                data.getStringExtra(PlayerActivity.EXTRA_PLAYBACK_CLOSE_REASON),
                new Runnable() {
                    @Override public void run() { continuePlayerResult(data); }
                });
    }

    /** Relay state writes that cannot create or replace a playback session. */
    private void persistPlayerResultState(android.content.Intent data) {
        if (data == null || webView == null) return;
        final String preferenceSourceId = data.getStringExtra("sourceId");
        final String preferenceItemType = data.getStringExtra("itemType");
        final String preferenceItemId = data.getStringExtra("itemId");
        final String trackPreferences = data.getStringExtra("trackPreferences");
        if (preferenceSourceId != null && preferenceItemId != null
                && trackPreferences != null && !trackPreferences.isEmpty()) {
            final String jsPreferences =
                    "window.__norvaNative&&window.__norvaNative.onTrackPreferences&&"
                    + "window.__norvaNative.onTrackPreferences("
                    + jsStr(preferenceSourceId) + "," + jsStr(preferenceItemType) + ","
                    + jsStr(preferenceItemId) + "," + jsStr(trackPreferences) + ")";
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try { webView.evaluateJavascript(jsPreferences, null); } catch (Exception ignored) { }
                }
            });
        }
        final long pos = data.getLongExtra("positionSeconds", 0);
        if (preferenceSourceId != null && preferenceItemId != null && pos > 0) {
            // PlayerActivity persisted this exact final position to the confirmed
            // SharedPreferences pump; it is cleared only after the cloud ACK.
            flushPendingNativeProgress();
        }
    }

    /** Continue only after standalone.js confirms terminal expiry with an explicit ACK. */
    private void continuePlayerResult(android.content.Intent data) {
        if (data == null || webView == null) return;
        // Viewer picked a different quality variant in the native player: ask the web to
        // re-select it (resolves a fresh stream + relaunches native playback). The position of
        // the segment watched before the switch sits in the prefs net (finish() persists it now)
        // — pump it instead of dropping it with the early return (audit P3 n°14).
        final String pickedVariant = data.getStringExtra("selectedVariantStreamId");
        if (pickedVariant != null && !pickedVariant.isEmpty()) {
            final String pickedSource = data.getStringExtra("selectedVariantSourceId");
            final String js = "window.__norvaPlayVariant && window.__norvaPlayVariant("
                    + jsStr(pickedVariant) + "," + jsStr(pickedSource) + ")";
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try { webView.evaluateJavascript(js, null); } catch (Exception ignored) { }
                }
            });
            return;
        }
        final String sourceId = data.getStringExtra("sourceId");
        final String itemType = data.getStringExtra("itemType");
        final String itemId = data.getStringExtra("itemId");
        final long pos = data.getLongExtra("positionSeconds", 0);
        final long dur = data.getLongExtra("durationSeconds", 0);
        final boolean ended = data.getBooleanExtra("ended", false);
        final boolean playNext = data.getBooleanExtra("playNext", false);
        final boolean openEpisodes = data.getBooleanExtra("openEpisodes", false);
        final boolean retryPlayback = data.getBooleanExtra("retryPlayback", false);
        final String retryReason = data.getStringExtra("retryReason");
        if (sourceId == null || itemId == null) return;
        // Direct + signed fallback were exhausted. Keep the current catalogue/detail
        // route open and ask it to mint a fresh provider session, then relaunch the
        // native player at the same VOD timestamp. This prevents a transient Atlas
        // EOF from closing the player and exposing Home.
        if (retryPlayback) {
            final String retryJs = "window.__norvaNative && window.__norvaNative.retryPlayback && "
                    + "window.__norvaNative.retryPlayback("
                    + jsStr(sourceId) + "," + jsStr(itemType) + "," + jsStr(itemId) + ","
                    + pos + "," + jsStr(retryReason) + ")";
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try { webView.evaluateJavascript(retryJs, null); } catch (Exception ignored) { }
                }
            });
            return;
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

    private void queuePlaybackSessionClose(String rawSessionId, String reason,
                                           Runnable continuation) {
        final String sessionId = NativePlaybackClosePolicy.boundedSessionId(rawSessionId);
        if (sessionId == null) {
            if (continuation != null) continuation.run();
            return;
        }
        boolean continueNow = false;
        final long nowEpochMs = System.currentTimeMillis();
        synchronized (playbackCloseLock) {
            boolean persistenceChanged = pruneExpiredPlaybackSessionClosesLocked(nowEpochMs);
            if (acknowledgedPlaybackCloseSessionIds.contains(sessionId)) {
                continueNow = true;
            } else {
                if (!pendingPlaybackSessionCloses.containsKey(sessionId)) {
                    while (pendingPlaybackSessionCloses.size()
                            >= NativePlaybackClosePolicy.MAX_PENDING_CLOSES) {
                        evictOldestPlaybackSessionCloseLocked();
                    }
                    pendingPlaybackSessionCloses.put(
                            sessionId,
                            new NativePlaybackClosePolicy.Entry(
                                    sessionId,
                                    NativePlaybackClosePolicy.boundedReason(reason),
                                    nowEpochMs));
                    persistenceChanged = true;
                }
                if (continuation != null) {
                    pendingPlaybackCloseContinuations.put(sessionId, continuation);
                }
            }
            if (persistenceChanged) persistPendingPlaybackSessionClosesLocked();
        }
        if (continueNow) {
            if (continuation != null) continuation.run();
            return;
        }
        dispatchPlaybackSessionClose(sessionId);
    }

    private void dispatchPlaybackSessionClose(String sessionId) {
        final String reason;
        synchronized (playbackCloseLock) {
            if (!playbackCloseDeliveryActive) return;
            if (pruneExpiredPlaybackSessionClosesLocked(System.currentTimeMillis())) {
                persistPendingPlaybackSessionClosesLocked();
            }
            NativePlaybackClosePolicy.Entry pending =
                    pendingPlaybackSessionCloses.get(sessionId);
            if (pending == null || playbackCloseRetryTasks.containsKey(sessionId)) return;
            reason = pending.reason;
            Integer previousAttempts = playbackCloseDeliveryAttempts.get(sessionId);
            playbackCloseDeliveryAttempts.put(
                    sessionId,
                    previousAttempts == null ? 1 : previousAttempts + 1);
        }
        if (!isTrustedPlaybackClosePage()) {
            schedulePlaybackCloseRetry(sessionId, "not_ready");
            return;
        }
        final String js = "(function(){try{var n=window.__norvaNative;"
                + "if(!n||typeof n.onPlaybackClosed!=='function')return 'not_ready';"
                + "var s=n.onPlaybackClosed(" + jsStr(sessionId) + ","
                + jsStr(reason) + ");return s==='accepted'?'accepted':'not_ready';"
                + "}catch(_){return 'not_ready';}})()";
        runOnUiThread(new Runnable() {
            @Override public void run() {
                try {
                    if (!isTrustedPlaybackClosePage()) {
                        schedulePlaybackCloseRetry(sessionId, "not_ready");
                        return;
                    }
                    // Arm before evaluating: a renderer reload may swallow the
                    // callback. The accepted/not_ready result replaces this timer.
                    schedulePlaybackCloseRetry(sessionId, "not_ready");
                    webView.evaluateJavascript(js, new ValueCallback<String>() {
                        @Override public void onReceiveValue(String value) {
                            String decodedStatus = decodeJavascriptString(value);
                            String status = "accepted".equals(decodedStatus)
                                    ? "accepted" : "not_ready";
                            // accepted transfers delivery ownership to JS, but the
                            // resolver gate stays closed until the terminal ACK.
                            schedulePlaybackCloseRetry(sessionId, status);
                        }
                    });
                } catch (Exception ignored) {
                    schedulePlaybackCloseRetry(sessionId, "not_ready");
                }
            }
        });
    }

    private boolean isTrustedPlaybackClosePage() {
        if (!webAppReady || webView == null || !cloudBridgeAdded
                || !isTrustedCloudUrl(webView.getUrl())) return false;
        try {
            String path = Uri.parse(webView.getUrl()).getPath();
            return "/app.html".equals(path) || "/app".equals(path);
        } catch (Exception ignored) {
            return false;
        }
    }

    private void acknowledgePlaybackSessionClosed(String rawSessionId) {
        if (!isTrustedPlaybackClosePage()) return;
        String sessionId = NativePlaybackClosePolicy.boundedSessionId(rawSessionId);
        if (sessionId == null) return;
        synchronized (playbackCloseLock) {
            if (!pendingPlaybackSessionCloses.containsKey(sessionId)) return;
            pendingPlaybackSessionCloses.remove(sessionId);
            playbackCloseDeliveryAttempts.remove(sessionId);
            cancelPlaybackCloseRetryLocked(sessionId);
            persistPendingPlaybackSessionClosesLocked();
        }
        completePlaybackCloseAcknowledgement(sessionId);
    }

    private void completePlaybackCloseAcknowledgement(String sessionId) {
        final Runnable continuation;
        synchronized (playbackCloseLock) {
            if (!acknowledgedPlaybackCloseSessionIds.add(sessionId)) return;
            while (acknowledgedPlaybackCloseSessionIds.size()
                    > NativePlaybackClosePolicy.MAX_ACKNOWLEDGED_CLOSES) {
                java.util.Iterator<String> oldest =
                        acknowledgedPlaybackCloseSessionIds.iterator();
                if (!oldest.hasNext()) break;
                oldest.next();
                oldest.remove();
            }
            continuation = pendingPlaybackCloseContinuations.remove(sessionId);
        }
        if (continuation != null) continuation.run();
    }

    private void schedulePlaybackCloseRetry(String sessionId, String status) {
        final Runnable task;
        final long delayMs;
        synchronized (playbackCloseLock) {
            if (!playbackCloseDeliveryActive
                    || !pendingPlaybackSessionCloses.containsKey(sessionId)) return;
            Integer storedAttempts = playbackCloseDeliveryAttempts.get(sessionId);
            int attempts = storedAttempts == null ? 0 : storedAttempts;
            delayMs = NativePlaybackClosePolicy.retryDelayMs(attempts, status);
            if (delayMs < 0L) return;
            cancelPlaybackCloseRetryLocked(sessionId);
            task = new Runnable() {
                @Override public void run() {
                    synchronized (playbackCloseLock) {
                        playbackCloseRetryTasks.remove(sessionId);
                    }
                    dispatchPlaybackSessionClose(sessionId);
                }
            };
            playbackCloseRetryTasks.put(sessionId, task);
        }
        uiHandler.postDelayed(task, delayMs);
    }

    private void flushPendingPlaybackSessionCloses(boolean resetAttempts) {
        final ArrayList<String> sessionIds;
        synchronized (playbackCloseLock) {
            if (pruneExpiredPlaybackSessionClosesLocked(System.currentTimeMillis())) {
                persistPendingPlaybackSessionClosesLocked();
            }
            if (resetAttempts) playbackCloseDeliveryAttempts.clear();
            for (String sessionId : new ArrayList<>(playbackCloseRetryTasks.keySet())) {
                cancelPlaybackCloseRetryLocked(sessionId);
            }
            sessionIds = new ArrayList<>(pendingPlaybackSessionCloses.keySet());
        }
        for (String sessionId : sessionIds) dispatchPlaybackSessionClose(sessionId);
    }

    private void cancelPlaybackCloseRetryTimers() {
        synchronized (playbackCloseLock) {
            for (String sessionId : new ArrayList<>(playbackCloseRetryTasks.keySet())) {
                cancelPlaybackCloseRetryLocked(sessionId);
            }
        }
    }

    private void cancelPlaybackCloseRetryLocked(String sessionId) {
        Runnable task = playbackCloseRetryTasks.remove(sessionId);
        if (task != null) uiHandler.removeCallbacks(task);
    }

    private void loadPendingPlaybackSessionCloses() {
        Set<String> encoded = prefs().getStringSet(
                PREF_PENDING_PLAYBACK_CLOSES, Collections.<String>emptySet());
        if (encoded == null) encoded = Collections.emptySet();
        final long nowEpochMs = System.currentTimeMillis();
        ArrayList<NativePlaybackClosePolicy.Entry> valid = new ArrayList<>();
        for (String value : encoded) {
            NativePlaybackClosePolicy.Entry entry =
                    NativePlaybackClosePolicy.decode(value, nowEpochMs);
            if (entry != null) valid.add(entry);
        }
        Collections.sort(valid, new java.util.Comparator<NativePlaybackClosePolicy.Entry>() {
            @Override public int compare(NativePlaybackClosePolicy.Entry left,
                                         NativePlaybackClosePolicy.Entry right) {
                return Long.compare(left.createdAtEpochMs, right.createdAtEpochMs);
            }
        });
        int firstRetained = Math.max(
                0, valid.size() - NativePlaybackClosePolicy.MAX_PENDING_CLOSES);
        synchronized (playbackCloseLock) {
            pendingPlaybackSessionCloses.clear();
            for (int index = firstRetained; index < valid.size(); index++) {
                NativePlaybackClosePolicy.Entry entry = valid.get(index);
                pendingPlaybackSessionCloses.put(entry.sessionId, entry);
            }
            persistPendingPlaybackSessionClosesLocked();
        }
    }

    private void persistPendingPlaybackSessionClosesLocked() {
        Set<String> encoded = new LinkedHashSet<>();
        for (NativePlaybackClosePolicy.Entry entry : pendingPlaybackSessionCloses.values()) {
            String value = NativePlaybackClosePolicy.encode(
                    entry.sessionId, entry.reason, entry.createdAtEpochMs);
            if (value != null) encoded.add(value);
        }
        prefs().edit().putStringSet(PREF_PENDING_PLAYBACK_CLOSES, encoded).apply();
    }

    private boolean pruneExpiredPlaybackSessionClosesLocked(long nowEpochMs) {
        boolean changed = false;
        java.util.Iterator<Map.Entry<String, NativePlaybackClosePolicy.Entry>> iterator =
                pendingPlaybackSessionCloses.entrySet().iterator();
        while (iterator.hasNext()) {
            Map.Entry<String, NativePlaybackClosePolicy.Entry> mapEntry = iterator.next();
            NativePlaybackClosePolicy.Entry entry = mapEntry.getValue();
            long ageMs = nowEpochMs - entry.createdAtEpochMs;
            if (ageMs >= 0L && ageMs < NativePlaybackClosePolicy.MAX_PENDING_AGE_MS) continue;
            String sessionId = mapEntry.getKey();
            iterator.remove();
            pendingPlaybackCloseContinuations.remove(sessionId);
            playbackCloseDeliveryAttempts.remove(sessionId);
            cancelPlaybackCloseRetryLocked(sessionId);
            changed = true;
        }
        return changed;
    }

    private void evictOldestPlaybackSessionCloseLocked() {
        String oldestSessionId = null;
        long oldestCreatedAtEpochMs = Long.MAX_VALUE;
        for (Map.Entry<String, NativePlaybackClosePolicy.Entry> mapEntry
                : pendingPlaybackSessionCloses.entrySet()) {
            if (mapEntry.getValue().createdAtEpochMs < oldestCreatedAtEpochMs) {
                oldestSessionId = mapEntry.getKey();
                oldestCreatedAtEpochMs = mapEntry.getValue().createdAtEpochMs;
            }
        }
        if (oldestSessionId == null) return;
        pendingPlaybackSessionCloses.remove(oldestSessionId);
        pendingPlaybackCloseContinuations.remove(oldestSessionId);
        playbackCloseDeliveryAttempts.remove(oldestSessionId);
        cancelPlaybackCloseRetryLocked(oldestSessionId);
    }

    private static String decodeJavascriptString(String raw) {
        try {
            if (raw == null || "null".equals(raw)) return "";
            return new org.json.JSONArray("[" + raw + "]").optString(0, "");
        } catch (Exception ignored) {
            return "";
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        NativeClarity.event("app_open");
        // Web app already loaded and MainActivity came back to front (e.g. the native
        // player was killed by the system): flush any pending native progress now.
        if (webAppReady) {
            flushPendingNativeProgress();
            flushPendingPlaybackSessionCloses(true);
        }
    }

    /**
     * H1 recovery, confirmed edition: the native PlayerActivity persists its position (heartbeat,
     * onPause/onStop, and now the graceful finish() too) to SharedPreferences. Here we relay it
     * to the web app's onProgress bridge — with retries like the deep-link pump — and the record
     * is only cleared when the web layer echoes the token back through onProgressSaved(), i.e.
     * when the CLOUD save actually succeeded. The old flush consumed the prefs BEFORE evaluating
     * the JS: one boot landing on cloud-pair.html, one 401, one network blip → position gone.
     */
    private void flushPendingNativeProgress() {
        pendingProgressTries = 0;
        pumpPendingProgress();
    }

    private void pumpPendingProgress() {
        try {
            if (webView == null) return;
            SharedPreferences p = prefs();
            final String itemId = p.getString("pending_progress_itemId", null);
            if (itemId == null || itemId.isEmpty()) return;
            final String sourceId = p.getString("pending_progress_sourceId", "");
            final String itemType = p.getString("pending_progress_itemType", "");
            final long pos = p.getLong("pending_progress_pos", 0);
            final long dur = p.getLong("pending_progress_dur", 0);
            final long savedAt = p.getLong("pending_progress_savedAt", 0);
            final String token = p.getString("pending_progress_token", "");
            if (pos <= 0) { clearPendingProgressPrefs(); return; }
            // A record nothing could deliver for a week is dead (signed-out TV, permanent 401):
            // stop replaying it on every foreground.
            if (savedAt > 0 && System.currentTimeMillis() - savedAt > 7L * 24 * 3600 * 1000L) {
                clearPendingProgressPrefs();
                return;
            }
            if (!webAppReady) return; // the next app-shell onPageFinished re-pumps
            if (pendingProgressTries++ > 20) return; // keep the record; next foreground retries
            final String js = "(window.__norvaNative && window.__norvaNative.onProgress) ? "
                    + "(window.__norvaNative.onProgress(" + jsStr(sourceId) + "," + jsStr(itemType) + ","
                    + jsStr(itemId) + "," + pos + "," + dur + "," + savedAt + "," + jsStr(token) + "), 'ok') : 'retry'";
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        if (webView == null) return;
                        webView.evaluateJavascript(js, new ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String value) {
                                // 'ok' = delivered to the bridge; the SAVE confirmation arrives
                                // separately via onProgressSaved (which clears the record). Not
                                // delivered yet (SPA still booting) → retry shortly.
                                if (value != null && value.contains("ok")) return;
                                uiHandler.postDelayed(new Runnable() {
                                    @Override public void run() { pumpPendingProgress(); }
                                }, 1500);
                            }
                        });
                    } catch (Exception ignored) { }
                }
            });
        } catch (Exception ignored) { /* flush is best-effort */ }
    }

    private void clearPendingProgressPrefs() {
        try {
            prefs().edit()
                    .remove("pending_progress_sourceId").remove("pending_progress_itemType")
                    .remove("pending_progress_itemId").remove("pending_progress_pos")
                    .remove("pending_progress_dur").remove("pending_progress_savedAt")
                    .remove("pending_progress_token").apply();
        } catch (Exception ignored) { }
    }

    /** Web layer confirmed the cloud save of the pending record carrying this token. */
    void confirmProgressSaved(String token) {
        try {
            if (token == null || token.isEmpty()) return;
            String currentToken = prefs().getString("pending_progress_token", "");
            // Only clear the record the confirmation is FOR — a newer pending write (different
            // token) must survive an old confirmation arriving late.
            if (token.equals(currentToken)) clearPendingProgressPrefs();
        } catch (Exception ignored) { }
    }

    /**
     * In-playback heartbeat from PlayerActivity (~45s): relay the live position into the WebView
     * so the cloud history advances DURING native playback — other devices used to see the
     * position from BEFORE the film started until the player closed (sync audit P1 n°4). No
     * token: this is best-effort telemetry, the SharedPreferences net stays authoritative.
     */
    void relayNativeHeartbeat(final String sourceId, final String itemType, final String itemId,
                              final long pos, final long dur) {
        try {
            if (!webAppReady || webView == null || itemId == null || itemId.isEmpty() || pos <= 0) return;
            final String js = "window.__norvaNative && window.__norvaNative.onProgress("
                    + jsStr(sourceId) + "," + jsStr(itemType) + "," + jsStr(itemId) + ","
                    + pos + "," + dur + "," + System.currentTimeMillis() + ")";
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try { if (webView != null) webView.evaluateJavascript(js, null); } catch (Exception ignored) { }
                }
            });
        } catch (Exception ignored) { /* heartbeat is best-effort */ }
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
        logo.setImageResource(R.drawable.norva_app_icon);
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
        title.setText(R.string.ui_cannot_reach);
        title.setTextColor(Color.WHITE);
        title.setTextSize(26);
        title.setGravity(android.view.Gravity.CENTER);
        title.setPadding(0, 0, 0, dp(12));
        errorPanel.addView(title);

        errorText = new TextView(this);
        errorText.setText(R.string.ui_check_connection);
        errorText.setTextColor(Color.parseColor("#a1a1aa"));
        errorText.setTextSize(16);
        errorText.setGravity(android.view.Gravity.CENTER);
        errorText.setPadding(0, 0, 0, dp(32));
        errorPanel.addView(errorText);

        errorRetryBtn = new Button(this);
        errorRetryBtn.setText(R.string.ui_retry);
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

    /**
     * Branded TV confirmation shown over the app shell. It deliberately lives
     * in our view hierarchy instead of a system dialog so focus and Back are
     * deterministic on every TV launcher.
     */
    private void buildExitPanel() {
        exitPanel = new FrameLayout(this);
        exitPanel.setId(R.id.norva_tv_exit_panel);
        exitPanel.setBackgroundColor(Color.parseColor("#D905050A"));
        exitPanel.setVisibility(View.GONE);
        exitPanel.setFocusable(false);
        exitPanel.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER);
        card.setPadding(dp(34), dp(30), dp(34), dp(32));
        GradientDrawable cardBackground = new GradientDrawable();
        cardBackground.setColor(Color.parseColor("#FA111119"));
        cardBackground.setCornerRadius(dp(20));
        cardBackground.setStroke(dp(1), Color.parseColor("#3DFFFFFF"));
        card.setBackground(cardBackground);

        TextView title = new TextView(this);
        title.setText(R.string.tv_exit_title);
        title.setTextColor(Color.WHITE);
        title.setTextSize(28);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        card.addView(title, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView message = new TextView(this);
        message.setText(R.string.tv_exit_message);
        message.setTextColor(Color.parseColor("#B4B4BF"));
        message.setTextSize(17);
        message.setGravity(Gravity.CENTER);
        message.setPadding(dp(24), dp(10), dp(24), dp(26));
        card.addView(message, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        exitActions = new LinearLayout(this);
        exitActions.setOrientation(LinearLayout.HORIZONTAL);
        exitActions.setGravity(Gravity.CENTER);

        TextView cancel = exitAction(
                R.id.norva_tv_exit_cancel,
                getString(R.string.tv_exit_cancel),
                new Runnable() {
                    @Override public void run() { closeExitDialog(true); }
                });
        TextView settings = exitAction(
                R.id.norva_tv_exit_connection_settings,
                getString(R.string.tv_connection_settings),
                new Runnable() {
                    @Override public void run() {
                        closeExitDialog(false);
                        if (advancedPanel != null) advancedPanel.setVisibility(View.VISIBLE);
                        showSetup(null);
                        if (urlInput != null) urlInput.requestFocus();
                    }
                });
        TextView confirm = exitAction(
                R.id.norva_tv_exit_confirm,
                getString(R.string.tv_exit_confirm),
                new Runnable() {
                    @Override public void run() {
                        closeExitDialog(false);
                        finish();
                    }
                });

        LinearLayout.LayoutParams actionLp = new LinearLayout.LayoutParams(dp(240), dp(60));
        actionLp.leftMargin = dp(8);
        actionLp.rightMargin = dp(8);
        exitActions.addView(cancel, new LinearLayout.LayoutParams(actionLp));
        exitActions.addView(settings, new LinearLayout.LayoutParams(actionLp));
        exitActions.addView(confirm, new LinearLayout.LayoutParams(actionLp));

        // Explicit links complement the dispatcher and keep OEM focus engines
        // and accessibility services inside the three-action loop.
        cancel.setNextFocusLeftId(R.id.norva_tv_exit_confirm);
        cancel.setNextFocusRightId(R.id.norva_tv_exit_connection_settings);
        settings.setNextFocusLeftId(R.id.norva_tv_exit_cancel);
        settings.setNextFocusRightId(R.id.norva_tv_exit_confirm);
        confirm.setNextFocusLeftId(R.id.norva_tv_exit_connection_settings);
        confirm.setNextFocusRightId(R.id.norva_tv_exit_cancel);
        cancel.setNextFocusUpId(R.id.norva_tv_exit_cancel);
        cancel.setNextFocusDownId(R.id.norva_tv_exit_cancel);
        settings.setNextFocusUpId(R.id.norva_tv_exit_connection_settings);
        settings.setNextFocusDownId(R.id.norva_tv_exit_connection_settings);
        confirm.setNextFocusUpId(R.id.norva_tv_exit_confirm);
        confirm.setNextFocusDownId(R.id.norva_tv_exit_confirm);

        card.addView(exitActions);
        FrameLayout.LayoutParams cardLp = new FrameLayout.LayoutParams(
                Math.min(dp(930), getResources().getDisplayMetrics().widthPixels - dp(120)),
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER);
        exitPanel.addView(card, cardLp);
        root.addView(exitPanel, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private TextView exitAction(int id, String label, final Runnable action) {
        final TextView button = new TextView(this);
        button.setId(id);
        button.setText(label);
        button.setTextSize(17);
        button.setGravity(Gravity.CENTER);
        button.setSingleLine(true);
        button.setFocusable(true);
        button.setClickable(true);
        button.setContentDescription(label);
        styleExitAction(button, false);
        button.setOnFocusChangeListener(new View.OnFocusChangeListener() {
            @Override public void onFocusChange(View view, boolean hasFocus) {
                styleExitAction((TextView) view, hasFocus);
            }
        });
        button.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { action.run(); }
        });
        return button;
    }

    private void styleExitAction(TextView button, boolean focused) {
        GradientDrawable background = new GradientDrawable();
        background.setCornerRadius(dp(11));
        if (focused) {
            background.setColor(Color.parseColor("#F4F4F7"));
            background.setStroke(dp(2), Color.WHITE);
            button.setTextColor(Color.parseColor("#09090F"));
        } else {
            background.setColor(Color.parseColor("#1A1A24"));
            background.setStroke(dp(1), Color.parseColor("#32FFFFFF"));
            button.setTextColor(button.getId() == R.id.norva_tv_exit_confirm
                    ? Color.parseColor("#FCA5A5") : Color.WHITE);
        }
        button.setBackground(background);
        button.animate()
                .scaleX(focused ? 1.04f : 1f)
                .scaleY(focused ? 1.04f : 1f)
                .setDuration(120)
                .start();
    }

    private boolean isExitDialogVisible() {
        return exitPanel != null && exitPanel.getVisibility() == View.VISIBLE;
    }

    private static boolean isExitModalKey(int keyCode) {
        return keyCode == KeyEvent.KEYCODE_BACK
                || keyCode == KeyEvent.KEYCODE_ESCAPE
                || keyCode == KeyEvent.KEYCODE_MENU
                || keyCode == KeyEvent.KEYCODE_DPAD_LEFT
                || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT
                || keyCode == KeyEvent.KEYCODE_DPAD_UP
                || keyCode == KeyEvent.KEYCODE_DPAD_DOWN
                || keyCode == KeyEvent.KEYCODE_DPAD_CENTER
                || keyCode == KeyEvent.KEYCODE_ENTER
                || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER;
    }

    private boolean dispatchExitModalKey(int keyCode) {
        if (keyCode == KeyEvent.KEYCODE_BACK || keyCode == KeyEvent.KEYCODE_ESCAPE) {
            closeExitDialog(true);
            return true;
        }
        if (exitActions == null || exitActions.getChildCount() == 0) return true;

        View current = getCurrentFocus();
        int index = exitActions.indexOfChild(current);
        if (index < 0) index = 0;
        if (keyCode == KeyEvent.KEYCODE_DPAD_LEFT
                || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT) {
            int delta = keyCode == KeyEvent.KEYCODE_DPAD_LEFT ? -1 : 1;
            int next = PartnersTvContract.nextHorizontalIndex(
                    index, exitActions.getChildCount(), delta);
            exitActions.getChildAt(next).requestFocus();
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_DPAD_CENTER
                || keyCode == KeyEvent.KEYCODE_ENTER
                || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER) {
            View action = exitActions.getChildAt(index);
            if (action != null) action.performClick();
            return true;
        }
        // Up, Down and MENU stay inside the modal instead of reaching the app.
        return true;
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (isExitDialogVisible() && isExitModalKey(event.getKeyCode())) {
            if (event.getAction() == KeyEvent.ACTION_DOWN) {
                return dispatchExitModalKey(event.getKeyCode());
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
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
        if (isExitDialogVisible()) {
            closeExitDialog(true);
            return;
        }
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

    /**
     * "Exit Norva?" confirmation on BACK from the Home screen. Also the
     * discoverable doorway to the connection settings — many TV remotes have
     * no MENU key, and this dialog is one BACK press away from anywhere.
     */
    private void showExitDialog() {
        if (exitPanel == null || isExitDialogVisible()) return;
        exitReturnFocus = getCurrentFocus();
        if (webView != null) {
            webView.setImportantForAccessibility(
                    View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        }
        if (setupPanel != null) {
            setupPanel.setImportantForAccessibility(
                    View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        }
        if (errorPanel != null) {
            errorPanel.setImportantForAccessibility(
                    View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        }
        if (splashPanel != null) {
            splashPanel.setImportantForAccessibility(
                    View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        }
        exitPanel.setVisibility(View.VISIBLE);
        exitPanel.bringToFront();
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            exitPanel.setAccessibilityPaneTitle(getString(R.string.tv_exit_title));
        }
        final View safeAction = exitActions == null ? null
                : exitActions.findViewById(R.id.norva_tv_exit_cancel);
        exitPanel.post(new Runnable() {
            @Override public void run() {
                if (safeAction != null && safeAction.isShown()) safeAction.requestFocus();
            }
        });
    }

    /** Closes the sheet; Back/Cancel return to the exact previously focused view. */
    private void closeExitDialog(boolean restoreOrigin) {
        if (!isExitDialogVisible()) return;
        final View returnFocus = exitReturnFocus;
        exitReturnFocus = null;
        exitPanel.setVisibility(View.GONE);
        if (webView != null) {
            webView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
        }
        if (setupPanel != null) {
            setupPanel.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
        }
        if (errorPanel != null) {
            errorPanel.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
        }
        if (splashPanel != null) {
            splashPanel.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
        }
        if (!restoreOrigin || root == null) return;
        root.post(new Runnable() {
            @Override public void run() {
                if (returnFocus != null
                        && returnFocus.isShown()
                        && returnFocus.isFocusable()
                        && returnFocus.requestFocus()) {
                    return;
                }
                if (webViewVisible && webView != null && webView.isShown()) {
                    webView.requestFocus();
                }
            }
        });
    }

    @Override
    protected void onDestroy() {
        playbackCloseDeliveryActive = false;
        cancelPlaybackCloseRetryTimers();
        if (currentRef.get() == this) {
            currentRef.clear();
            currentRef = new WeakReference<>(null);
        }
        clearPendingPlayerRecovery(null);
        clearPlaybackAuthChannel(null);
        if (playerRecoveryReceiver != null) {
            try { unregisterReceiver(playerRecoveryReceiver); } catch (Exception ignored) { }
            playerRecoveryReceiver = null;
        }
        if (playbackAuthReceiver != null) {
            try { unregisterReceiver(playbackAuthReceiver); } catch (Exception ignored) { }
            playbackAuthReceiver = null;
        }
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }

    static MainActivity currentInstance() {
        return currentRef.get();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
