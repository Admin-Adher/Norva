package tv.norva.phone;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
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
import android.os.Handler;
import android.os.Looper;
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

import androidx.core.content.ContextCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.NoCredentialException;

import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import com.google.firebase.analytics.FirebaseAnalytics;
import com.google.firebase.messaging.FirebaseMessaging;

import tv.norva.analytics.NativeClarity;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.BufferedReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Norva Mobile — Android phone client.
 */
public class MainActivity extends Activity {

    private static final String PREFS          = "norva_mobile";
    private static final String PREF_SERVER_URL = "serverUrl";
    private static final String PREF_MODE       = "mode"; // "cloud" | "server"
    private static final String PREF_NOTIF_ASKED = "notificationPermissionAsked";
    private static final String PREF_NOTIF_MIGRATED_V18 = "notificationPermissionMigrationV18";
    private static final String PREF_PENDING_PLAYBACK_CLOSES =
            "pendingPlaybackSessionCloses";
    private static final String STATE_CLOUD_ROUTE = "norva.cloudRoute";
    private static final String STATE_PENDING_REFERRAL_URL = "norva.pendingReferralUrl";
    private static final String CLOUD_ACCOUNT_URL = "https://norva.tv/account.html?returnTo=%2Fapp.html%3Fmobile%3D1%23home";
    private static final String CLOUD_WATCH_URL = "https://norva.tv/app.html?mobile=1#home";
    private static final String SUPABASE_USER_URL = "https://api.norva.tv/auth/v1/user";
    private static final long BILLING_SESSION_CACHE_MS = 60_000L;
    // Every layer of the billing path answers before the layer above it gives up:
    // session verification (<= 11 s) -> NorvaBilling's catalog watchdog (12 s) ->
    // these bridge watchdogs -> the paywall's 45 s deadline. A request that dies
    // anywhere in between therefore reaches the page as a named reason instead of
    // as an unexplained timeout.
    private static final long BILLING_CATALOG_REQUEST_TIMEOUT_MS = 20_000L;
    private static final long BILLING_RESTORE_REQUEST_TIMEOUT_MS = 40_000L;
    private static final int PARTNER_SHARE_PROTOCOL_VERSION =
            PartnersContract.SHARE_PROTOCOL_VERSION;
    private static final int MAX_PARTNER_SHARE_MESSAGE_CHARS =
            PartnersContract.MAX_SHARE_MESSAGE_CHARS;
    private static final int MAX_PARTNER_SHARE_TEXT_CHARS =
            PartnersContract.MAX_SHARE_TEXT_CHARS;
    private static final int MAX_PARTNER_DISCLOSURE_CHARS =
            PartnersContract.MAX_DISCLOSURE_CHARS;
    private static final int MAX_PARTNER_CHOOSER_TITLE_CHARS =
            PartnersContract.MAX_CHOOSER_TITLE_CHARS;
    private static final int MAX_HANDLED_SHARE_REQUEST_IDS = 64;
    private static final String UA_SUFFIX       = " NorvaTV-AndroidPhone/1.0";
    private static final int    REQ_PLAYER      = 1001;
    private static final int    REQ_NOTIF_PERM  = 1002;
    private static final int    REQ_CAMERA_PERM = 1003;
    private PermissionRequest pendingWebCameraRequest;
    private static final String DL_UA           =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
    private boolean             cloudBridgeAdded = false;
    private final ExecutorService ioPool = Executors.newCachedThreadPool();
    private final Object billingSessionLock = new Object();
    private String cachedBillingUserId;
    private String cachedBillingTokenHash;
    private long cachedBillingVerifiedAt;
    private final Handler billingHandler = new Handler(Looper.getMainLooper());
    // Activity-scoped replay protection. The native share sheet has no reliable
    // cancellation result, so one request id is presented at most once. Returning
    // to the WebView can therefore never reopen a duplicate chooser.
    private final Set<String> handledShareRequestIds = new LinkedHashSet<>();
    private final Object playbackCloseLock = new Object();
    private final Map<String, NativePlaybackClosePolicy.Entry> pendingPlaybackSessionCloses =
            new LinkedHashMap<>();
    // Continuations and retry state are memory-only. Durable storage contains
    // only the server-owned UUID, one bounded close reason, and the absolute
    // creation time needed to enforce the 12-hour retention cap.
    private final Map<String, Runnable> pendingPlaybackCloseContinuations =
            new HashMap<>();
    private final Map<String, Integer> playbackCloseDeliveryAttempts =
            new HashMap<>();
    private final Map<String, Runnable> playbackCloseRetryTasks =
            new HashMap<>();
    private final Set<String> acknowledgedPlaybackCloseSessionIds = new LinkedHashSet<>();
    private boolean playbackCloseDeliveryActive = true;

    private FrameLayout  root;
    private WebView      webView;
    // True once the web app finished loading and its __norvaNative bridge exists, so a
    // pending native-progress flush only fires against a ready page (see onPageFinished).
    private volatile boolean webAppReady = false;
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
    // A fresh provider URL can now be delivered back into the still-open
    // PlayerActivity. The token binds one recovery request to one response so
    // another playback intent can never replace the current title.
    private BroadcastReceiver playerRecoveryReceiver;
    private String pendingPlayerRecoveryToken;
    private String pendingPlayerRecoveryKey;
    private long pendingPlayerRecoveryExpiresAtElapsedMs;
    private final Object playerRecoveryLock = new Object();
    private static final long PLAYER_RECOVERY_TTL_MS = 65_000L;
    // PlayerActivity never owns a refresh token. Each lease pulse asks this
    // still-running trusted WebView for its current access credential through a
    // request nonce bound to the exact PlayerActivity launch.
    private BroadcastReceiver playbackAuthReceiver;
    private final Object playbackAuthLock = new Object();
    private String activePlaybackAuthChannelId;
    private String pendingPlaybackAuthRequestNonce;
    private long pendingPlaybackAuthExpiresAtElapsedMs;
    private static final long PLAYBACK_AUTH_REQUEST_TTL_MS = 5_000L;

    // Cold-start watchdog: if a page neither finishes nor errors within the timeout
    // (a silently hung load), surface the friendly error screen instead of stranding
    // the user on the splash spinner.
    private static final long LOAD_TIMEOUT_MS = 15000L;
    private final Handler loadHandler = new Handler(Looper.getMainLooper());
    private final Runnable loadTimeout = new Runnable() {
        @Override public void run() {
            if (webViewVisible) showNetworkError("Norva is taking too long to respond.");
        }
    };

    // ---- Lifecycle ----

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Branded system splash (dark background + icon) instead of a blank
        // window then black flash; must be installed before super.onCreate().
        try { androidx.core.splashscreen.SplashScreen.installSplashScreen(this); } catch (Exception ignored) { }
        super.onCreate(savedInstanceState);
        NativeClarity.configure(BuildConfig.CLARITY_PROJECT_ID, "android_mobile", BuildConfig.VERSION_NAME, BuildConfig.DEBUG ? "qa" : "production");
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    this::handleBackPressed);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0a0a0f"));
        setContentView(root);
        // Android 15+ enforces edge-to-edge for current target SDKs. Reserve the
        // visible bars once on the native root, then dispatch only the remaining
        // insets to its children. Returning the original insets here makes some
        // OEM WebViews expose the same status/navigation inset again through CSS
        // env(safe-area-inset-*), creating the empty bands seen above and below
        // the web shell. Insets from the IME remain in the adjusted remainder.
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets safe = insets.getInsets(
                        android.view.WindowInsets.Type.systemBars()
                                | android.view.WindowInsets.Type.displayCutout());
                v.setPadding(safe.left, safe.top, safe.right, safe.bottom);
                return insets.inset(safe.left, safe.top, safe.right, safe.bottom);
            });
            root.requestApplyInsets();
        }

        buildWebView();
        buildSetupPanel();
        buildErrorPanel();
        buildSplash();
        NativeClarity.registerSensitiveView(setupPanel);
        NativeClarity.registerSensitiveView(advancedPanel);
        NativeClarity.registerSensitiveView(urlInput);
        NativeClarity.applyStoredConsent(this, this::setFirebaseAnalyticsCollection);
        showSplash();
        registerPlayerRecoveryBridge();
        registerPlaybackAuthBridge();
        loadPendingPlaybackSessionCloses();

        // Explicit links win over a recreated Activity's previous route.
        if (handleDeepLink(getIntent())) return;

        String mode = prefs().getString(PREF_MODE, null);
        String saved = prefs().getString(PREF_SERVER_URL, null);
        if ("cloud".equals(mode) && restoreCloudContinuity(savedInstanceState)) {
            // Activity recreation (font/navigation-mode/configuration change):
            // the WebView reloads the exact SPA route with a one-shot recovery
            // marker. Auth/profile/filter state remains in the trusted origin's
            // storage; no bearer or provider URL is copied into Android prefs.
        } else if ("cloud".equals(mode)) {
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

        // Push: ask for notification permission and cache the FCM token so the web
        // bridge (getPushToken) can hand it to the backend for "catalog ready" pushes.
        setupPush();
    }

    /**
     * Persist only the bounded SPA fragment needed to rebuild navigation. The
     * authenticated session remains in WebView origin storage and media URLs
     * (which may contain short-lived credentials) never enter the Bundle.
     */
    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if ("cloud".equals(prefs().getString(PREF_MODE, null)) && webView != null) {
            try {
                String referralUrl = canonicalReferralUrl(webView.getUrl());
                if (referralUrl != null) {
                    // A public opaque referral URL is safe to keep in Android's
                    // recreation Bundle. The server-issued attribution claim
                    // remains only in its HttpOnly WebView cookie and is never
                    // copied into a Bundle, SharedPreferences, JavaScript or logs.
                    outState.putString(STATE_PENDING_REFERRAL_URL, referralUrl);
                } else {
                    String fragment = safeCloudFragment(webView.getUrl());
                    if (fragment != null) outState.putString(STATE_CLOUD_ROUTE, fragment);
                }
                webView.evaluateJavascript(
                        "window.app&&window.app.persistNativeContinuity&&"
                                + "window.app.persistNativeContinuity();",
                        null);
            } catch (Exception ignored) {
                // A renderer may disappear during a configuration change. The
                // default Home route remains a safe fallback.
            }
        }
        super.onSaveInstanceState(outState);
    }

    private boolean restoreCloudContinuity(Bundle savedInstanceState) {
        if (savedInstanceState == null) return false;
        String referralUrl = canonicalReferralUrl(
                savedInstanceState.getString(STATE_PENDING_REFERRAL_URL));
        if (referralUrl != null) {
            connectCloud(referralUrl);
            return true;
        }
        String fragment = savedInstanceState.getString(STATE_CLOUD_ROUTE);
        if (fragment == null) return false;
        connectCloud(cloudContinuityUrl(fragment));
        return true;
    }

    private static String safeCloudFragment(String url) {
        if (url == null || url.isEmpty()) return null;
        try {
            Uri uri = Uri.parse(url);
            if (!"https".equalsIgnoreCase(uri.getScheme())
                    || !"norva.tv".equalsIgnoreCase(uri.getHost())) return null;
            String fragment = uri.getEncodedFragment();
            if (fragment == null || fragment.isEmpty()) return "home";
            if (fragment.length() > 2_048) return "home";
            String page = fragment.split("/", 2)[0];
            if (!("home".equals(page) || "live".equals(page)
                    || "movies".equals(page) || "series".equals(page)
                    || "settings".equals(page) || "partners".equals(page))) return "home";
            return fragment;
        } catch (Exception ignored) {
            return "home";
        }
    }

    private static String cloudContinuityUrl(String fragment) {
        String safe = fragment == null || fragment.isEmpty() ? "home" : fragment;
        return Uri.parse(CLOUD_WATCH_URL).buildUpon()
                .appendQueryParameter("_nativeRecovery", "1")
                .fragment(safe)
                .build()
                .toString();
    }

    /**
     * norva://pair (QR pairing) and https://norva.tv App Links. Returns true when
     * the intent fully decided the initial navigation (pairing flow).
     */
    private boolean handleDeepLink(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return false;
        Uri data = intent.getData();
        if (data == null) return false;
        if ("norva".equals(data.getScheme()) && "pair".equals(data.getHost())) {
            String hubUrl = data.getQueryParameter("hub");
            String code   = data.getQueryParameter("code");
            if (hubUrl != null && code != null) {
                prefs().edit().putString(PREF_SERVER_URL, hubUrl).putString(PREF_MODE, "server").apply();
                connect(hubUrl + "/pair-approve.html?code=" + code);
                return true;
            }
            return false;
        }
        if ("https".equals(data.getScheme()) && "norva.tv".equals(data.getHost())) {
            if ("/partners-kyc-return".equals(data.getPath())) {
                String kycReturnUrl = PartnersContract.canonicalKycReturnDestination(
                        data.toString());
                intent.setAction(null);
                prefs().edit().putString(PREF_MODE, "cloud").apply();
                connectCloud(kycReturnUrl == null
                        ? Uri.parse(CLOUD_WATCH_URL).buildUpon()
                                .fragment("partners").build().toString()
                        : kycReturnUrl);
                return true;
            }
            String partnersRelayUrl = partnersRelayAppLinkDestination(data);
            if (partnersRelayUrl != null) {
                // The relay fragment is a short-lived bearer-like value. Consume
                // the external VIEW action once and let app.js move it into
                // sessionStorage before any authentication redirect.
                intent.setAction(null);
                prefs().edit().putString(PREF_MODE, "cloud").apply();
                connectCloud(partnersRelayUrl);
                return true;
            }
            String referralUrl = referralAppLinkDestination(data);
            if (isReferralPath(data)) {
                // Consume the VIEW action before loading. Activity recreation
                // must rely on the bounded Bundle URL above, not replay the
                // original external Intent and its untrusted query/fragment.
                intent.setAction(null);
                prefs().edit().putString(PREF_MODE, "cloud").apply();
                connectCloud(referralUrl == null
                        ? Uri.parse(CLOUD_WATCH_URL).buildUpon()
                                .fragment("partners").build().toString()
                        : referralUrl);
                return true;
            }
            // Public /t/* links are canonical web URLs, not SPA documents. Convert
            // their bounded title identity into the existing movies/series route
            // so the signed-in user lands on the exact fiche.
            String url = appLinkDestination(data);
            if (url == null) url = data.toString();
            if (!url.contains("mobile=1")) {
                int hash = url.indexOf('#');
                String base = hash >= 0 ? url.substring(0, hash) : url;
                String frag = hash >= 0 ? url.substring(hash) : "";
                url = base + (base.contains("?") ? "&mobile=1" : "?mobile=1") + frag;
            }
            prefs().edit().putString(PREF_MODE, "cloud").apply();
            connectCloud(url);
            return true;
        }
        return false;
    }

    private static boolean isReferralPath(Uri data) {
        return data != null && data.getPath() != null
                && data.getPath().startsWith("/r/");
    }

    /**
     * Canonicalize a Partners App Link without copying arbitrary query values,
     * fragments or credentials into the WebView. The 32-character code mirrors
     * the server's opaque public-code contract; it is not the HttpOnly claim.
     */
    private static String referralAppLinkDestination(Uri data) {
        if (data == null
                || !"https".equalsIgnoreCase(data.getScheme())
                || !"norva.tv".equalsIgnoreCase(data.getHost())
                || (data.getPort() != -1 && data.getPort() != 443)) return null;
        java.util.List<String> segments = data.getPathSegments();
        if (segments.size() != 2 || !"r".equals(segments.get(0))) return null;
        String code = segments.get(1);
        if (!isOpaqueReferralCode(code)) return null;
        String destination = new Uri.Builder()
                .scheme("https")
                .authority("norva.tv")
                .appendPath("r")
                .appendPath(code)
                .appendQueryParameter("mobile", "1")
                .build()
                .toString();
        String pureDestination = PartnersContract.canonicalReferralDestination(data.toString());
        return destination.equals(pureDestination) ? destination : null;
    }

    private static String canonicalReferralUrl(String value) {
        if (value == null || value.isEmpty()) return null;
        try {
            String destination = referralAppLinkDestination(Uri.parse(value));
            String pureDestination = PartnersContract.canonicalReferralDestination(value);
            return destination != null && destination.equals(pureDestination)
                    ? destination
                    : null;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static boolean isOpaqueReferralCode(String code) {
        return PartnersContract.isOpaqueReferralCode(code)
                && code != null && code.matches("^[A-Za-z0-9_-]{32}$");
    }

    private static String partnersRelayAppLinkDestination(Uri data) {
        if (data == null
                || !"https".equalsIgnoreCase(data.getScheme())
                || !"norva.tv".equalsIgnoreCase(data.getHost())
                || (data.getPort() != -1 && data.getPort() != 443)
                || !"/app.html".equals(data.getPath())
                || data.getQuery() != null) return null;
        String fragment = data.getFragment();
        if (fragment == null
                || !fragment.matches("^relay=v1\\.[A-Za-z0-9_-]{43}\\.[0-9a-f]{64}$")) {
            return null;
        }
        String destination = Uri.parse(CLOUD_WATCH_URL).buildUpon()
                .encodedFragment(Uri.encode(fragment, "=._-"))
                .build()
                .toString();
        String pureDestination = PartnersContract.canonicalRelayDestination(data.toString());
        return destination.equals(pureDestination) ? destination : null;
    }

    private static String appLinkDestination(Uri data) {
        if (data == null || data.getPath() == null
                || !data.getPath().startsWith("/t/")) return null;
        java.util.List<String> segments = data.getPathSegments();
        String kind = segments.size() > 1 ? segments.get(1) : data.getQueryParameter("type");
        String page = titlePage(kind);
        if (page == null) return CLOUD_WATCH_URL;

        String sourceId = firstNonEmpty(
                segments.size() > 2 ? segments.get(2) : null,
                data.getQueryParameter("sourceId"),
                data.getQueryParameter("source"));
        String itemId = firstNonEmpty(
                segments.size() > 3 ? segments.get(3) : null,
                data.getQueryParameter("itemId"),
                data.getQueryParameter("streamId"),
                data.getQueryParameter("seriesId"),
                data.getQueryParameter("id"));
        String title = firstNonEmpty(
                segments.size() > 4
                        ? android.text.TextUtils.join(" ", segments.subList(4, segments.size()))
                        : null,
                data.getQueryParameter("title"),
                data.getQueryParameter("name"));

        if (!boundedLinkPart(sourceId, 200) || !boundedLinkPart(itemId, 200)) {
            return Uri.parse(CLOUD_WATCH_URL).buildUpon().fragment(page).build().toString();
        }
        String route = page + "/open:"
                + Uri.encode(sourceId) + ":"
                + Uri.encode(itemId) + ":"
                + Uri.encode(title == null ? "" : title);
        return Uri.parse(CLOUD_WATCH_URL).buildUpon().fragment(route).build().toString();
    }

    private static String titlePage(String kind) {
        if (kind == null) return null;
        String normalized = kind.trim().toLowerCase(Locale.ROOT);
        if ("movie".equals(normalized) || "movies".equals(normalized)
                || "film".equals(normalized) || "films".equals(normalized)) return "movies";
        if ("series".equals(normalized) || "show".equals(normalized)
                || "shows".equals(normalized) || "tv".equals(normalized)) return "series";
        return null;
    }

    private static String firstNonEmpty(String... values) {
        if (values == null) return null;
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) return value.trim();
        }
        return null;
    }

    private static boolean boundedLinkPart(String value, int maxLength) {
        return value != null && !value.isEmpty() && value.length() <= maxLength;
    }

    /** App Link / pairing link tapped while the app is already running. */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleDeepLink(intent);
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
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Pre-Android 13 fallback. Android 13+ dispatches to the registered
        // OnBackInvokedCallback, which is mandatory once targetSdk reaches 36.
        handleBackPressed();
    }

    private void handleBackPressed() {
        // Back abandons any in-flight WebView resolution. A late tokened JSON
        // response is consumed by deliverRecoveredStreamToPlayer and can no
        // longer resurrect playback after the viewer leaves.
        clearPendingPlayerRecovery(null);
        if (!webViewVisible || webView == null) {
            finish();
            return;
        }
        // Let the web app consume Back first (close a menu, modal, channel drawer,
        // or step back to Home). Only fall back to history / exit when it doesn't.
        webView.evaluateJavascript(
                PartnersContract.nativeBackScript(),
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
        loadHandler.removeCallbacks(loadTimeout);
        playbackCloseDeliveryActive = false;
        cancelPlaybackCloseRetryTimers();
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
        if (webView != null) webView.destroy();
        ioPool.shutdownNow();
        super.onDestroy();
    }

    private void registerPlaybackAuthBridge() {
        playbackAuthReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                if (!PlayerActivity.ACTION_REQUEST_PLAYBACK_AUTH.equals(intent.getAction())
                        || webView == null || !cloudBridgeAdded
                        || !isTrustedCloudUrl(webView.getUrl())) return;
                String channelId = intent.getStringExtra(
                        PlayerActivity.EXTRA_PLAYBACK_AUTH_CHANNEL_ID);
                String requestNonce = intent.getStringExtra(
                        PlayerActivity.EXTRA_PLAYBACK_AUTH_REQUEST_NONCE);
                if (!NativePlaybackAuthPolicy.validNonce(channelId)
                        || !NativePlaybackAuthPolicy.validNonce(requestNonce)) return;
                synchronized (playbackAuthLock) {
                    if (!channelId.equals(activePlaybackAuthChannelId)) return;
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
     * Ask the trusted Norva origin for a credential just in time. A stable
     * paired-device token wins; user sessions go through the existing
     * single-flight, rotation-safe getAccessToken() path. The refresh token is
     * never read or copied by Android.
     */
    private void requestPlaybackAuthFromWeb(final String channelId, final String requestNonce) {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                synchronized (playbackAuthLock) {
                    if (!channelId.equals(activePlaybackAuthChannelId)
                            || !requestNonce.equals(pendingPlaybackAuthRequestNonce)) return;
                }
                if (webView == null || !cloudBridgeAdded
                        || !isTrustedCloudUrl(webView.getUrl())) {
                    clearPendingPlaybackAuthRequest(channelId, requestNonce);
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
                    clearPendingPlaybackAuthRequest(channelId, requestNonce);
                    return;
                }
                loadHandler.postDelayed(
                        () -> clearPendingPlaybackAuthRequest(channelId, requestNonce),
                        PLAYBACK_AUTH_REQUEST_TTL_MS + 250L);
            }
        });
    }

    private void clearPendingPlaybackAuthRequest(String channelId, String requestNonce) {
        synchronized (playbackAuthLock) {
            if (channelId != null && !channelId.equals(activePlaybackAuthChannelId)) return;
            if (requestNonce != null
                    && !requestNonce.equals(pendingPlaybackAuthRequestNonce)) return;
            pendingPlaybackAuthRequestNonce = null;
            pendingPlaybackAuthExpiresAtElapsedMs = 0L;
        }
    }

    private void deliverPlaybackAuthToPlayer(String channelId, String requestNonce,
                                             String kind, String bearer) {
        synchronized (playbackAuthLock) {
            if (!NativePlaybackAuthPolicy.validNonce(channelId)
                    || !NativePlaybackAuthPolicy.validNonce(requestNonce)
                    || !channelId.equals(activePlaybackAuthChannelId)
                    || !requestNonce.equals(pendingPlaybackAuthRequestNonce)) return;
            if (pendingPlaybackAuthExpiresAtElapsedMs <= 0L
                    || android.os.SystemClock.elapsedRealtime()
                    > pendingPlaybackAuthExpiresAtElapsedMs) {
                clearPendingPlaybackAuthRequest(channelId, requestNonce);
                return;
            }
            // Claim before validating/sending. Duplicate callbacks, a late
            // Promise, or an older Activity can never receive the credential.
            pendingPlaybackAuthRequestNonce = null;
            pendingPlaybackAuthExpiresAtElapsedMs = 0L;
        }
        if (!NativePlaybackAuthPolicy.isFreshBearer(
                kind, bearer, System.currentTimeMillis() / 1000L)) return;
        Intent response = new Intent(PlayerActivity.ACTION_APPLY_PLAYBACK_AUTH)
                .setPackage(getPackageName())
                .putExtra(PlayerActivity.EXTRA_PLAYBACK_AUTH_CHANNEL_ID, channelId)
                .putExtra(PlayerActivity.EXTRA_PLAYBACK_AUTH_REQUEST_NONCE, requestNonce)
                .putExtra(PlayerActivity.EXTRA_PLAYBACK_AUTH_TOKEN, bearer);
        sendBroadcast(response);
    }

    private void activatePlaybackAuthChannel(Intent intent) {
        String channelId = UUID.randomUUID().toString();
        synchronized (playbackAuthLock) {
            activePlaybackAuthChannelId = channelId;
            pendingPlaybackAuthRequestNonce = null;
            pendingPlaybackAuthExpiresAtElapsedMs = 0L;
        }
        intent.putExtra(PlayerActivity.EXTRA_PLAYBACK_AUTH_CHANNEL_ID, channelId);
    }

    private void clearPlaybackAuthChannel(String channelId) {
        synchronized (playbackAuthLock) {
            if (channelId != null && !channelId.equals(activePlaybackAuthChannelId)) return;
            activePlaybackAuthChannelId = null;
            pendingPlaybackAuthRequestNonce = null;
            pendingPlaybackAuthExpiresAtElapsedMs = 0L;
        }
    }

    private static String recoveryKey(String sourceId, String itemType, String itemId) {
        return String.valueOf(sourceId) + "|" + String.valueOf(itemType) + "|" + String.valueOf(itemId);
    }

    private void clearPendingPlayerRecovery(String token) {
        synchronized (playerRecoveryLock) {
            if (token != null && !token.equals(pendingPlayerRecoveryToken)) return;
            pendingPlayerRecoveryToken = null;
            pendingPlayerRecoveryKey = null;
            pendingPlayerRecoveryExpiresAtElapsedMs = 0L;
        }
    }

    /**
     * PlayerActivity stays visible while the WebView mints a replacement
     * provider/Gateway URL. This removes the old close -> details -> relaunch
     * flash and keeps controls, position and track choices stable.
     */
    private void registerPlayerRecoveryBridge() {
        playerRecoveryReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                if (!PlayerActivity.ACTION_REQUEST_FRESH_STREAM.equals(intent.getAction())
                        || webView == null) return;
                String token = intent.getStringExtra(PlayerActivity.EXTRA_RECOVERY_TOKEN);
                String sourceId = intent.getStringExtra(PlayerActivity.EXTRA_SOURCE_ID);
                String itemType = intent.getStringExtra(PlayerActivity.EXTRA_ITEM_TYPE);
                String itemId = intent.getStringExtra(PlayerActivity.EXTRA_ITEM_ID);
                if (token == null || token.length() < 16 || token.length() > 160
                        || sourceId == null || sourceId.isEmpty()
                        || itemId == null || itemId.isEmpty()) return;
                synchronized (playerRecoveryLock) {
                    pendingPlayerRecoveryToken = token;
                    pendingPlayerRecoveryKey = recoveryKey(sourceId, itemType, itemId);
                    pendingPlayerRecoveryExpiresAtElapsedMs =
                            android.os.SystemClock.elapsedRealtime() + PLAYER_RECOVERY_TTL_MS;
                }
                long position = Math.max(0L, intent.getLongExtra("positionSeconds", 0L));
                long duration = Math.max(0L, intent.getLongExtra("durationSeconds", 0L));
                String reason = intent.getStringExtra("retryReason");
                String saveProgress = position > 0
                        ? "window.__norvaNative&&window.__norvaNative.onProgress&&"
                        + "window.__norvaNative.onProgress("
                        + jsStr(sourceId) + "," + jsStr(itemType) + "," + jsStr(itemId)
                        + "," + position + "," + duration + ");"
                        : "";
                String retry = saveProgress
                        + "window.__norvaNative&&window.__norvaNative.retryPlayback&&"
                        + "window.__norvaNative.retryPlayback("
                        + jsStr(sourceId) + "," + jsStr(itemType) + "," + jsStr(itemId)
                        + "," + position + "," + jsStr(reason) + "," + jsStr(token) + ");";
                runOnUiThread(() -> {
                    try { webView.evaluateJavascript(retry, null); } catch (Exception ignored) { }
                });
                loadHandler.postDelayed(() -> {
                    synchronized (playerRecoveryLock) {
                        if (token.equals(pendingPlayerRecoveryToken)
                                && android.os.SystemClock.elapsedRealtime()
                                >= pendingPlayerRecoveryExpiresAtElapsedMs) {
                            clearPendingPlayerRecovery(token);
                        }
                    }
                }, PLAYER_RECOVERY_TTL_MS + 250L);
            }
        };
        ContextCompat.registerReceiver(
                this,
                playerRecoveryReceiver,
                new IntentFilter(PlayerActivity.ACTION_REQUEST_FRESH_STREAM),
                ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    /**
     * Intercept the next JSON launch only when it answers the active recovery.
     * Normal taps still create a new PlayerActivity.
     */
    private boolean deliverRecoveredStreamToPlayer(JSONObject payload) {
        if (payload == null) return false;
        String responseToken = emptyToNull(payload.optString("recoveryToken"));
        // Untokened JSON is a normal viewer action. Tokened JSON is recovery-only:
        // consume stale/expired replies so they never open another Activity.
        if (responseToken == null) return false;

        final String token;
        synchronized (playerRecoveryLock) {
            token = pendingPlayerRecoveryToken;
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
            // Claim atomically before leaving the lock. A second JS callback
            // for this token is therefore stale and can never replace it.
            clearPendingPlayerRecovery(token);
        }
        Intent response = new Intent(PlayerActivity.ACTION_APPLY_FRESH_STREAM)
                .setPackage(getPackageName())
                .putExtra(PlayerActivity.EXTRA_RECOVERY_TOKEN, token)
                .putExtra(PlayerActivity.EXTRA_RECOVERY_PAYLOAD, payload.toString());
        sendBroadcast(response);
        return true;
    }

    // ---- Build UI ----

    @SuppressLint("SetJavaScriptEnabled")
    private void buildWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0a0a0f"));
        webView.setVisibility(View.GONE);
        // Debug builds only: expose the WebView to chrome://inspect for on-device debugging
        // (e.g. the [Native] variant-switch logs). Never enabled in release for security.
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        // The initial cloud load is HTTPS-only. LAN mode explicitly relaxes this
        // immediately before loading a user-entered local server.
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setUserAgentString(s.getUserAgentString() + UA_SUFFIX);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                Uri origin = request == null ? null : request.getOrigin();
                boolean trusted = origin != null && (isTrustedCloudUrl(origin.toString())
                        || isSameOrigin(origin.toString(), lastLoadedUrl));
                boolean cameraRequested = false;
                if (request != null && request.getResources() != null) {
                    for (String resource : request.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                            cameraRequested = true;
                            break;
                        }
                    }
                }
                if (trusted && cameraRequested) {
                    if (checkSelfPermission(Manifest.permission.CAMERA)
                            != PackageManager.PERMISSION_GRANTED) {
                        pendingWebCameraRequest = request;
                        requestPermissions(new String[]{ Manifest.permission.CAMERA }, REQ_CAMERA_PERM);
                        return;
                    }
                    request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                } else if (request != null) {
                    request.deny();
                }
            }
        });

        webView.setWebViewClient(new WebViewClient() {
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
                webAppReady = false;
                configureWebSecurity(url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                loadHandler.removeCallbacks(loadTimeout);
                hideSplash();
                webAppReady = true;
                // Flush any position the native player persisted before a non-graceful
                // exit or an offline session. Small delay lets standalone.js install
                // window.__norvaNative before we call onProgress.
                view.postDelayed(new Runnable() {
                    @Override public void run() {
                        flushPendingNativeProgress();
                        flushPendingPlaybackSessionCloses(true);
                    }
                }, 1500);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        WebResourceError error) {
                if (request.isForMainFrame()) {
                    hideSplash();
                    showNetworkError(null);
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler,
                                           SslError error) {
                // Never bypass certificate validation, including for LAN servers.
                // Users can still connect to an explicit local HTTP endpoint.
                handler.cancel();
            }
        });

        installOriginScopedBillingChannel();
        installOriginScopedPartnerShareChannel();
        installOriginScopedNativeAnalyticsChannel();

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
        setCloudBridgeEnabled(false);
        connectInternal(url);
    }

    private void connectInternal(String url) {
        lastLoadedUrl = url;
        configureWebSecurity(url);
        setupPanel.setVisibility(View.GONE);
        if (errorPanel != null) errorPanel.setVisibility(View.GONE);
        showSplash();
        webView.setVisibility(View.VISIBLE);
        webViewVisible = true;
        loadHandler.removeCallbacks(loadTimeout);
        loadHandler.postDelayed(loadTimeout, LOAD_TIMEOUT_MS);
        webView.loadUrl(withShellCacheBust(url));
        webView.requestFocus();
    }

    /**
     * Cache-bust the norva.tv app shell on every load.
     *
     * The shell (app.html/account.html) is served no-store so its freshly hashed
     * /css + /js references are always current — but that header is recent, and a
     * WebView that cached the shell under the previous must-revalidate policy can
     * cling to an OLD app.html (and thus an OLD /css/main.css hash it holds
     * `immutable` for a year), stranding the phone on stale UI even after a clean
     * deploy. Appending a per-launch `_cb` param gives the shell a URL the WebView
     * cache has never seen, forcing a real refetch of the shell and, through its
     * new hashes, the current CSS/JS. Scoped to norva.tv *.html only: the LAN
     * "server" mode URL, media/stream URLs and deep links to non-html paths are
     * left untouched, and the immutable hashed assets still cache forever — only
     * the tiny shell document is refetched.
     */
    private static String withShellCacheBust(String url) {
        if (url == null) return null;
        try {
            Uri u = Uri.parse(url);
            if (!"norva.tv".equalsIgnoreCase(u.getHost())) return url;
            String path = u.getPath();
            if (path == null || !path.endsWith(".html")) return url;
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

    /** Cloud playback: expose the native player bridge, then load the cloud app. */
    private void connectCloud(String url) {
        if (!isTrustedCloudUrl(url)) {
            openExternalUrl(url);
            return;
        }
        setCloudBridgeEnabled(true);
        connectInternal(url);
    }

    private void setCloudBridgeEnabled(boolean enabled) {
        if (enabled && !cloudBridgeAdded) {
            webView.addJavascriptInterface(new CloudBridge(), "NorvaTVCloud");
            cloudBridgeAdded = true;
        } else if (!enabled && cloudBridgeAdded) {
            webView.removeJavascriptInterface("NorvaTVCloud");
            cloudBridgeAdded = false;
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

    /** Keep only Norva cloud pages, or the selected LAN origin, inside the WebView. */
    private boolean routeTopLevelNavigation(String url) {
        if (url == null || url.isEmpty()) return true;
        if (isTrustedCloudUrl(url)) return false;
        if ("server".equals(prefs().getString(PREF_MODE, null))
                && isSameOrigin(url, lastLoadedUrl)) return false;
        openExternalUrl(url);
        return true;
    }

    private void openExternalUrl(String url) {
        if (url == null || url.isEmpty()) return;
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(intent);
        } catch (Exception ignored) {
            Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show();
        }
    }

    private static boolean isTrustedCloudUrl(String value) {
        if (value == null || value.isEmpty()) return false;
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

    private static boolean isTrustedBillingPage(String value) {
        if (!isTrustedCloudUrl(value)) return false;
        try {
            String path = Uri.parse(value).getPath();
            // Cloudflare Pages serves these documents extensionless and redirects
            // the .html form onto it, so the URL the WebView settles on is the bare
            // path. Both spellings are trusted, for both screens.
            return "/subscribe".equals(path)
                    || "/subscribe.html".equals(path)
                    || "/subscription".equals(path)
                    || "/subscription.html".equals(path);
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
            return safeEqualsIgnoreCase(a.getScheme(), b.getScheme())
                    && safeEqualsIgnoreCase(a.getHost(), b.getHost())
                    && aPort == bPort;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static int defaultPort(String scheme) {
        return "https".equalsIgnoreCase(scheme) ? 443 : 80;
    }

    private static boolean safeEqualsIgnoreCase(String left, String right) {
        return left != null && right != null && left.equalsIgnoreCase(right);
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

        // Direct URL + a gateway fallback URL the player switches to if the provider
        // refuses the direct (residential-IP) request with 401/403.
        @android.webkit.JavascriptInterface
        public void playVideoResumableFallback(final String url, final String fallbackUrl, final String title,
                                               final String sourceId, final String itemType, final String itemId,
                                               final int resumeSeconds) {
            openPlayer(url, title, sourceId, itemType, itemId, resumeSeconds, fallbackUrl);
        }

        // Extensible launch: one JSON payload. The web prefers this when present, so it
        // also carries live quality variants ({label,streamId,sourceId} + activeStreamId)
        // for the player's "Version" menu. Feature-detected: absent → the web uses the
        // fixed-signature methods above (no variant menu).
        @android.webkit.JavascriptInterface
        public void playVideoJson(final String json) {
            try {
                org.json.JSONObject o = new org.json.JSONObject(json);
                final String url = o.optString("url");
                if (url.isEmpty()) return;
                if (deliverRecoveredStreamToPlayer(o)) return;
                org.json.JSONArray variants = o.optJSONArray("variants");
                org.json.JSONObject trackMetadata = o.optJSONObject("trackMetadata");
                org.json.JSONObject preferenceScope = o.optJSONObject("preferenceScope");
                org.json.JSONObject playbackPreferences = o.optJSONObject("playbackPreferences");
                openPlayer(
                        url,
                        o.optString("title", "Norva"),
                        emptyToNull(o.optString("sourceId")),
                        emptyToNull(o.optString("itemType")),
                        emptyToNull(o.optString("itemId")),
                        o.optInt("resumeSeconds", 0),
                        emptyToNull(o.optString("fallbackUrl")),
                        (variants != null && variants.length() > 1) ? variants.toString() : null,
                        emptyToNull(o.optString("activeStreamId")),
                        trackMetadata == null ? null : trackMetadata.toString(),
                        preferenceScope == null ? null : preferenceScope.toString(),
                        playbackPreferences == null ? null : playbackPreferences.toString(),
                        emptyToNull(o.optString("poster")),
                        emptyToNull(o.optString("nextTitle")),
                        emptyToNull(o.optString("sessionId")));
            } catch (Exception ignored) {
                // Malformed payload → the web falls back to the fixed-signature methods.
            }
        }

        /**
         * Completes one native heartbeat credential request. JavaScript can
         * answer only a nonce that MainActivity currently owns; stale or
         * unsolicited callbacks are discarded before any broadcast is sent.
         */
        @android.webkit.JavascriptInterface
        public void providePlaybackAuth(final String channelId, final String requestNonce,
                                        final String kind, final String bearer) {
            runOnUiThread(() -> deliverPlaybackAuthToPlayer(
                    channelId, requestNonce, kind, bearer));
        }

        /** Terminal ACK after standalone.js confirms exact server-side expiry. */
        @android.webkit.JavascriptInterface
        public void ackPlaybackSessionClosed(final String sessionId) {
            runOnUiThread(() -> acknowledgePlaybackSessionClosed(sessionId));
        }

        // ---- Native Google Sign-In ----

        /**
         * Google Sign-In without leaving the app. Google blocks OAuth inside a raw
         * WebView, so the web "Continue with Google" button on native calls this
         * bridge instead of a redirect: we fetch a Google ID token natively and hand
         * it back to the page via window.onNorvaGoogleIdToken(idToken, error), which
         * exchanges it for a Norva session (Supabase signInWithIdToken).
         */
        @android.webkit.JavascriptInterface
        public void googleSignIn() {
            runOnUiThread(() -> startGoogleSignIn());
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

        // ---- Push notifications (FCM) ----

        /**
         * The device's FCM token, cached by NorvaMessagingService / setupPush. The web app
         * reads it and registers it with the backend so the digest sender can push "catalog
         * ready" notifications to this device while the app is closed. Empty until FCM resolves it.
         */
        @android.webkit.JavascriptInterface
        public String getPushToken() {
            return getSharedPreferences(NorvaMessagingService.PREFS, MODE_PRIVATE)
                    .getString(NorvaMessagingService.KEY_TOKEN, "");
        }

        /**
         * Notification permission stays contextual: the web Home card can explain
         * the benefit before Android displays its system dialog.
         */
        @android.webkit.JavascriptInterface
        public String notificationPermissionState() {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                    || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                        == PackageManager.PERMISSION_GRANTED) {
                return "granted";
            }
            boolean asked = getSharedPreferences(PREFS, MODE_PRIVATE)
                    .getBoolean(PREF_NOTIF_ASKED, false);
            return (asked || notificationPermissionPreviouslyAsked()) ? "denied" : "prompt";
        }

        @android.webkit.JavascriptInterface
        public void requestNotificationPermission() {
            getSharedPreferences(PREFS, MODE_PRIVATE)
                    .edit().putBoolean(PREF_NOTIF_ASKED, true).apply();
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                    || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                        == PackageManager.PERMISSION_GRANTED) {
                runOnUiThread(() -> dispatchNotificationPermissionChanged());
                return;
            }
            ensureNotifPermission();
        }
    }

    private interface VerifiedBillingUserCallback {
        void onVerified(String userId, String accessToken);
        void onError(String error);
    }

    /**
     * A dedicated, origin-scoped Partners bridge. Unlike the legacy player
     * bridge, this object is never installed with addJavascriptInterface:
     * AndroidX WebKit supplies both the source origin and main-frame identity.
     */
    private void installOriginScopedPartnerShareChannel() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        WebViewCompat.addWebMessageListener(webView, "NorvaShareNative",
                Collections.singleton("https://norva.tv"),
                new WebViewCompat.WebMessageListener() {
                    @Override
                    public void onPostMessage(WebView view, WebMessageCompat message,
                                              Uri sourceOrigin, boolean isMainFrame,
                                              JavaScriptReplyProxy replyProxy) {
                        if (!isMainFrame || sourceOrigin == null
                                || !isTrustedCloudUrl(sourceOrigin.toString())
                                || view == null || !isTrustedPartnersPage(view.getUrl())) return;
                        dispatchPartnerShareMessage(
                                message == null ? null : message.getData(),
                                replyProxy);
                    }
                });
    }

    /**
     * Data-minimal analytics bridge exposed only to Norva's trusted main frame.
     * Arbitrary event names and properties never cross this boundary.
     */
    private void installOriginScopedNativeAnalyticsChannel() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        final Set<String> origins = new LinkedHashSet<>();
        origins.add("https://norva.tv");
        origins.add("https://www.norva.tv");
        WebViewCompat.addWebMessageListener(webView, "NorvaAnalyticsNative", origins,
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
                                MainActivity.this::setFirebaseAnalyticsCollection);
                    }
                });
    }

    private void setFirebaseAnalyticsCollection(boolean granted) {
        try {
            FirebaseAnalytics.getInstance(this).setAnalyticsCollectionEnabled(granted);
        } catch (Throwable ignored) { }
    }

    private void dispatchPartnerShareMessage(String raw, JavaScriptReplyProxy replyProxy) {
        if (replyProxy == null || raw == null
                || raw.isEmpty() || raw.length() > MAX_PARTNER_SHARE_MESSAGE_CHARS) {
            return;
        }

        final JSONObject request;
        final JSONObject payload;
        final String method;
        final String requestId;
        try {
            request = new JSONObject(raw);
            if (!hasExactKeys(request, "version", "requestId", "method", "payload")
                    || request.optInt("version", -1) != PARTNER_SHARE_PROTOCOL_VERSION) {
                throw new IllegalArgumentException();
            }
            requestId = request.optString("requestId", "");
            method = request.optString("method", "");
            payload = request.optJSONObject("payload");
            if (!isValidPartnerShareRequestId(requestId) || payload == null) {
                throw new IllegalArgumentException();
            }
        } catch (Exception ignored) {
            sendPartnerShareReply(replyProxy, "", "error", "invalid_request", null);
            return;
        }

        if ("getCapabilities".equals(method)) {
            if (!hasExactKeys(payload)) {
                sendPartnerShareReply(
                        replyProxy, requestId, "error", "invalid_request", null);
                return;
            }
            JSONObject capabilities = new JSONObject();
            try {
                capabilities.put("shareReferral", true);
                // A bitmap supplied by JavaScript cannot be proven to encode the
                // validated referral URL without adding a barcode decoder. Keep
                // the native export fail-closed; the Web can offer its ordinary
                // download fallback without granting Android storage access.
                capabilities.put(
                        "exportReferralQr",
                        PartnersContract.canExportReferralQr());
                capabilities.put(
                        "exportReferralQrReason",
                        "semantic_qr_validation_unavailable");
            } catch (Exception ignored) {
                sendPartnerShareReply(
                        replyProxy, requestId, "error", "native_unavailable", null);
                return;
            }
            sendPartnerShareReply(replyProxy, requestId, "ok", null, capabilities);
            return;
        }

        if ("exportReferralQr".equals(method)) {
            if (!hasExactKeys(payload)) {
                sendPartnerShareReply(
                        replyProxy, requestId, "error", "invalid_request", null);
                return;
            }
            sendPartnerShareReply(
                    replyProxy,
                    requestId,
                    "unavailable",
                    "semantic_qr_validation_unavailable",
                    null);
            return;
        }

        if (!"shareReferral".equals(method)
                || !hasExactKeys(
                        payload, "url", "message", "disclosure", "chooserTitle")) {
            sendPartnerShareReply(
                    replyProxy, requestId, "error", "unsupported_request", null);
            return;
        }

        String url = canonicalShareReferralUrl(payload.optString("url", ""));
        String message = strictPartnerShareText(
                payload.optString("message", ""), MAX_PARTNER_SHARE_TEXT_CHARS);
        String disclosure = strictPartnerShareText(
                payload.optString("disclosure", ""), MAX_PARTNER_DISCLOSURE_CHARS);
        String chooserTitle = strictPartnerShareText(
                payload.optString("chooserTitle", ""), MAX_PARTNER_CHOOSER_TITLE_CHARS);
        if (url == null || message == null || disclosure == null || chooserTitle == null) {
            sendPartnerShareReply(
                    replyProxy, requestId, "error", "invalid_share_payload", null);
            return;
        }
        if (!consumePartnerShareRequestId(requestId)) {
            sendPartnerShareReply(
                    replyProxy, requestId, "duplicate", "request_already_presented", null);
            return;
        }

        // The disclosure and destination are appended by native code, not passed
        // as separable chooser fields. No caller can silently share the sales copy
        // while dropping the partner disclosure.
        final String shareText = message + "\n\n" + disclosure + "\n" + url;
        if (!shareText.equals(PartnersContract.buildShareText(
                url, message, disclosure, chooserTitle))) {
            sendPartnerShareReply(
                    replyProxy, requestId, "error", "invalid_share_payload", null);
            return;
        }
        try {
            Intent sendIntent = new Intent(Intent.ACTION_SEND);
            sendIntent.setType("text/plain");
            sendIntent.putExtra(Intent.EXTRA_SUBJECT, chooserTitle);
            sendIntent.putExtra(Intent.EXTRA_TEXT, shareText);
            Intent chooser = Intent.createChooser(sendIntent, chooserTitle);
            if (chooser.resolveActivity(getPackageManager()) == null) {
                sendPartnerShareReply(
                        replyProxy, requestId, "unavailable", "no_share_target", null);
                return;
            }
            startActivity(chooser);
            // Android does not expose a reliable chooser-cancel result here.
            // "presented" is deliberately honest and never claims a completed share.
            sendPartnerShareReply(replyProxy, requestId, "presented", null, null);
        } catch (Exception ignored) {
            sendPartnerShareReply(
                    replyProxy, requestId, "unavailable", "native_share_failed", null);
        }
    }

    private boolean consumePartnerShareRequestId(String requestId) {
        synchronized (handledShareRequestIds) {
            if (handledShareRequestIds.contains(requestId)) return false;
            while (handledShareRequestIds.size() >= MAX_HANDLED_SHARE_REQUEST_IDS) {
                String oldest = handledShareRequestIds.iterator().next();
                handledShareRequestIds.remove(oldest);
            }
            handledShareRequestIds.add(requestId);
            return true;
        }
    }

    private static boolean hasExactKeys(JSONObject value, String... expectedKeys) {
        if (value == null || expectedKeys == null || value.length() != expectedKeys.length) {
            return false;
        }
        for (String key : expectedKeys) {
            if (key == null || !value.has(key)) return false;
        }
        return true;
    }

    private static boolean isValidPartnerShareRequestId(String requestId) {
        return PartnersContract.isValidShareRequestId(requestId)
                && requestId != null
                && requestId.matches("^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$");
    }

    private static String strictPartnerShareText(String value, int maxLength) {
        String pure = PartnersContract.strictShareText(value, maxLength);
        if (pure == null) return null;
        if (value == null || value.isEmpty() || value.length() > maxLength
                || !value.equals(value.trim())) return null;
        for (int index = 0; index < value.length(); index += 1) {
            if (Character.isISOControl(value.charAt(index))) return null;
        }
        return pure;
    }

    private static String canonicalShareReferralUrl(String value) {
        String canonical = canonicalReferralUrl(value);
        if (canonical == null) return null;
        // Sharing uses the public canonical URL. The mobile query parameter is
        // transport-only and must never leak into copied partner messages.
        Uri uri = Uri.parse(canonical);
        String shareUrl = new Uri.Builder()
                .scheme("https")
                .authority("norva.tv")
                .appendPath("r")
                .appendPath(uri.getLastPathSegment())
                .build()
                .toString();
        String pureShareUrl = PartnersContract.canonicalShareReferralUrl(value);
        return shareUrl.equals(pureShareUrl) ? shareUrl : null;
    }

    private static boolean isTrustedPartnersPage(String value) {
        if (!isTrustedCloudUrl(value)
                || !PartnersContract.isTrustedPartnersPage(value)) return false;
        try {
            Uri uri = Uri.parse(value);
            String path = uri.getPath();
            if (!("/app.html".equals(path) || "/app".equals(path))) return false;
            String fragment = uri.getFragment();
            if (fragment == null) return false;
            String route = fragment.split("/", 2)[0];
            return "partners".equals(route);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static void sendPartnerShareReply(
            JavaScriptReplyProxy replyProxy,
            String requestId,
            String status,
            String error,
            JSONObject capabilities) {
        if (replyProxy == null) return;
        // JavaScriptReplyProxy exists only inside the guarded
        // WEB_MESSAGE_LISTENER callback, but this second feature check keeps the
        // call site valid for OEM WebView implementations and satisfies lint
        // without a broad RequiresFeature suppression.
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        try {
            JSONObject reply = new JSONObject();
            reply.put("version", PARTNER_SHARE_PROTOCOL_VERSION);
            reply.put("requestId", requestId == null ? "" : requestId);
            reply.put("status", status == null ? "error" : status);
            if (error != null && !error.isEmpty()) reply.put("error", error);
            if (capabilities != null) reply.put("capabilities", capabilities);
            replyProxy.postMessage(reply.toString());
        } catch (Exception ignored) {
            // The native boundary never forwards exception messages or stack data.
        }
    }

    /**
     * Billing deliberately does not live on the legacy JavascriptInterface: that
     * object is visible to every frame. WebMessageListener gives Android the
     * authenticated source origin and main-frame bit for every request.
     */
    private void installOriginScopedBillingChannel() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        final Set<String> billingOrigins = new LinkedHashSet<>();
        billingOrigins.add("https://norva.tv");
        billingOrigins.add("https://www.norva.tv");
        WebViewCompat.addWebMessageListener(webView, "NorvaBillingNative",
                billingOrigins,
                new WebViewCompat.WebMessageListener() {
                    @Override
                    public void onPostMessage(WebView view, WebMessageCompat message,
                                              Uri sourceOrigin, boolean isMainFrame,
                                              JavaScriptReplyProxy replyProxy) {
                        // A hostile or nested frame is still dropped in silence.
                        // The page-level check moved into withVerifiedBillingUser,
                        // which ANSWERS untrusted_billing_context: silently dropping
                        // a request that came from our own origin is what left the
                        // paywall waiting for a reply that never arrived.
                        if (!isMainFrame || sourceOrigin == null
                                || !isTrustedCloudUrl(sourceOrigin.toString())
                                || view == null) return;
                        dispatchBillingMessage(message == null ? null : message.getData());
                    }
                });
    }

    private void dispatchBillingMessage(String raw) {
        final JSONObject request;
        final JSONArray args;
        final String method;
        final String requestId;
        try {
            request = new JSONObject(raw == null ? "" : raw);
            method = request.optString("method", "");
            requestId = request.optString("requestId", "");
            args = request.optJSONArray("args");
            if (requestId.isEmpty() || args == null) throw new IllegalArgumentException();
        } catch (Exception ignored) {
            return;
        }
        final String claimedUserId = args.optString(0, "");
        // The paywall refuses to sell until this request is answered, so every
        // request gets exactly one answer: whichever of the real result and the
        // watchdog below lands first. The watchdog names the stage the request died
        // at, so a stuck bridge surfaces as a cause instead of a bare timeout.
        // A purchase stays unwatched here: the Play sheet is paced by the user and
        // NorvaBilling already guards it.
        final AtomicBoolean answered = new AtomicBoolean(false);
        final String[] stage = { "session" };
        final Runnable expire = new Runnable() {
            @Override
            public void run() {
                if (!answered.compareAndSet(false, true)) return;
                sendBillingFailure(method, requestId, claimedUserId, "native_timeout_" + stage[0]);
            }
        };
        if ("getOfferingsForUser".equals(method)) {
            billingHandler.postDelayed(expire, BILLING_CATALOG_REQUEST_TIMEOUT_MS);
        } else if ("restoreForUser".equals(method)) {
            billingHandler.postDelayed(expire, BILLING_RESTORE_REQUEST_TIMEOUT_MS);
        }
        withVerifiedBillingUser(claimedUserId, new VerifiedBillingUserCallback() {
            @Override
            public void onVerified(String verifiedUserId, String accessToken) {
                if ("getOfferingsForUser".equals(method) && args.length() == 1) {
                    stage[0] = "offerings";
                    NorvaBilling.getOfferingsForUser(verifiedUserId, requestId,
                            payloadJson -> {
                                if (!answered.compareAndSet(false, true)) return;
                                billingHandler.removeCallbacks(expire);
                                sendBillingOfferings(payloadJson);
                            });
                } else if ("purchaseForUser".equals(method) && args.length() == 6) {
                    final String offeringId = args.optString(1, "");
                    final String packageId = args.optString(2, "");
                    final String productId = args.optString(3, "");
                    final String planCode = args.optString(4, "");
                    final String placement = args.optString(5, "");
                    stage[0] = "purchase";
                    NorvaBilling.purchaseForUser(MainActivity.this, verifiedUserId, accessToken,
                            offeringId, packageId, productId, planCode, placement, requestId,
                            (status, error, detailsJson) -> {
                                if (!answered.compareAndSet(false, true)) return;
                                billingHandler.removeCallbacks(expire);
                                sendBillingResult(requestId, status, planCode, error, detailsJson);
                            });
                } else if ("restoreForUser".equals(method) && args.length() == 1) {
                    stage[0] = "restore";
                    NorvaBilling.restoreForUser(verifiedUserId,
                            (status, error) -> {
                                if (!answered.compareAndSet(false, true)) return;
                                billingHandler.removeCallbacks(expire);
                                sendBillingResult(requestId, status, null, error, null);
                            });
                } else {
                    finishBillingRequest(answered, expire, method, requestId, claimedUserId,
                            "invalid_billing_request");
                }
            }

            @Override
            public void onError(String error) {
                finishBillingRequest(answered, expire, method, requestId, claimedUserId, error);
            }
        });
    }

    /** Settle a billing request once, cancelling its watchdog. */
    private void finishBillingRequest(AtomicBoolean answered, Runnable expire, String method,
                                      String requestId, String claimedUserId, String error) {
        if (!answered.compareAndSet(false, true)) return;
        billingHandler.removeCallbacks(expire);
        sendBillingFailure(method, requestId, claimedUserId, error);
    }

    /**
     * A catalog request waits on window.__norvaBilling.onOfferings, a purchase or a
     * restore on onResult. Posting an error to the other channel is, for the page,
     * indistinguishable from never answering — which is exactly how the paywall
     * ended up showing "timeout" with no cause.
     */
    private void sendBillingFailure(String method, String requestId, String claimedUserId,
                                    String error) {
        if ("getOfferingsForUser".equals(method)) {
            sendBillingOfferingsError(requestId, claimedUserId, error);
        } else {
            sendBillingResult(requestId, "error", null, error, null);
        }
    }

    /**
     * Bind every RevenueCat operation to the signed-in Norva account. The id
     * supplied by JavaScript is treated only as a claim: the top-level paywall
     * session is read natively and its access token is verified against the
     * Supabase user endpoint before RevenueCat can log in or purchase.
     */
    private void withVerifiedBillingUser(final String claimedUserId,
                                         final VerifiedBillingUserCallback callback) {
        if (callback == null) return;
        if (!validBillingUserId(claimedUserId)) {
            callback.onError("invalid_user_id");
            return;
        }
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (webView == null || !cloudBridgeAdded
                        || !isTrustedBillingPage(webView.getUrl())) {
                    callback.onError("untrusted_billing_context");
                    return;
                }
                try {
                    webView.evaluateJavascript(
                            "(function(){try{return localStorage.getItem('norva-cloud-session')||''}catch(e){return ''}})()",
                            new ValueCallback<String>() {
                                @Override
                                public void onReceiveValue(String rawValue) {
                                    verifyBillingSessionValue(claimedUserId, rawValue, callback);
                                }
                            });
                } catch (Throwable ignored) {
                    callback.onError("billing_session_missing");
                }
            }
        });
    }

    private void verifyBillingSessionValue(final String claimedUserId, String rawValue,
                                           final VerifiedBillingUserCallback callback) {
        final String accessToken;
        final String sessionUserId;
        try {
            if (rawValue == null || "null".equals(rawValue)) throw new IllegalArgumentException();
            JSONArray decoded = new JSONArray("[" + rawValue + "]");
            String sessionJson = decoded.optString(0, "");
            JSONObject session = new JSONObject(sessionJson);
            accessToken = session.optString("access_token", "");
            JSONObject user = session.optJSONObject("user");
            sessionUserId = user == null ? "" : user.optString("id", "");
        } catch (Exception ignored) {
            callback.onError("billing_session_missing");
            return;
        }
        if (accessToken.isEmpty() || !claimedUserId.equals(sessionUserId)) {
            callback.onError("billing_account_mismatch");
            return;
        }

        final String tokenHash = sha256(accessToken);
        long now = System.currentTimeMillis();
        synchronized (billingSessionLock) {
            if (claimedUserId.equals(cachedBillingUserId)
                    && tokenHash.equals(cachedBillingTokenHash)
                    && now - cachedBillingVerifiedAt <= BILLING_SESSION_CACHE_MS) {
                callback.onVerified(claimedUserId, accessToken);
                return;
            }
        }

        final Runnable verify = new Runnable() {
            @Override
            public void run() {
                HttpURLConnection connection = null;
                String error = "billing_session_verification_failed";
                try {
                    connection = (HttpURLConnection) new URL(SUPABASE_USER_URL).openConnection();
                    connection.setRequestMethod("GET");
                    connection.setInstanceFollowRedirects(false);
                    // Halved from 10 s: this verification is only the first stage
                    // of a billing request, and its worst case has to leave room
                    // for RevenueCat's login and catalog calls inside the deadline.
                    connection.setConnectTimeout(5_000);
                    connection.setReadTimeout(5_000);
                    connection.setRequestProperty("Accept", "application/json");
                    connection.setRequestProperty("Authorization", "Bearer " + accessToken);
                    connection.setRequestProperty("apikey", BuildConfig.SUPABASE_PUBLISHABLE_KEY);
                    if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                        error = "billing_session_invalid";
                    } else {
                        JSONObject verifiedUser = new JSONObject(readBoundedJson(connection.getInputStream()));
                        String verifiedUserId = verifiedUser.optString("id", "");
                        if (!claimedUserId.equals(verifiedUserId)) {
                            error = "billing_account_mismatch";
                        } else {
                            synchronized (billingSessionLock) {
                                cachedBillingUserId = verifiedUserId;
                                cachedBillingTokenHash = tokenHash;
                                cachedBillingVerifiedAt = System.currentTimeMillis();
                            }
                            final String finalVerifiedUserId = verifiedUserId;
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    callback.onVerified(finalVerifiedUserId, accessToken);
                                }
                            });
                            return;
                        }
                    }
                } catch (Exception ignored) {
                    // Never expose network details or the bearer token to JavaScript.
                } finally {
                    if (connection != null) connection.disconnect();
                }
                final String finalError = error;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        callback.onError(finalError);
                    }
                });
            }
        };
        try {
            ioPool.execute(verify);
        } catch (Throwable ignored) {
            callback.onError("billing_session_verification_failed");
        }
    }

    private static boolean validBillingUserId(String userId) {
        return userId != null && userId.length() >= 8 && userId.length() <= 128
                && userId.equals(userId.trim()) && !userId.startsWith("$RCAnonymousID:");
    }

    private static String readBoundedJson(InputStream stream) throws Exception {
        BufferedReader reader = new BufferedReader(new InputStreamReader(
                stream, StandardCharsets.UTF_8));
        StringBuilder out = new StringBuilder();
        char[] buffer = new char[2048];
        int count;
        while ((count = reader.read(buffer)) != -1) {
            if (out.length() + count > 65_536) throw new IllegalArgumentException("response_too_large");
            out.append(buffer, 0, count);
        }
        return out.toString();
    }

    private static String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder(digest.length * 2);
            for (byte b : digest) out.append(String.format(java.util.Locale.US, "%02x", b & 0xff));
            return out.toString();
        } catch (Exception ignored) {
            return "";
        }
    }

    /** Post a billing result back to the web layer (subscribe.html / billing.js). */
    private void sendBillingResult(String requestId, String status, String planCode,
                                   String error, String detailsJson) {
        try {
            org.json.JSONObject o;
            try {
                o = detailsJson == null || detailsJson.isEmpty()
                        ? new org.json.JSONObject()
                        : new org.json.JSONObject(detailsJson);
            } catch (Exception ignored) {
                o = new org.json.JSONObject();
            }
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

    /** Post the live, localized Play catalog back to public/js/billing.js. */
    private void sendBillingOfferings(String payloadJson) {
        final String js = "window.__norvaBilling && window.__norvaBilling.onOfferings(" +
                jsStr(payloadJson == null ? "{}" : payloadJson) + ")";
        runOnUiThread(() -> {
            try { if (webView != null) webView.evaluateJavascript(js, null); } catch (Exception ignored) { }
        });
    }

    private void sendBillingOfferingsError(String requestId, String claimedUserId, String error) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("nativeBillingContract", 2);
            payload.put("requestId", requestId == null ? "" : requestId);
            payload.put("appUserId", claimedUserId == null ? "" : claimedUserId);
            payload.put("status", "error");
            payload.put("error", error == null ? "billing_session_verification_failed" : error);
            payload.put("packages", new JSONArray());
            sendBillingOfferings(payload.toString());
        } catch (Exception ignored) {
            sendBillingOfferings("{\"nativeBillingContract\":2,\"status\":\"error\","
                    + "\"error\":\"billing_session_verification_failed\",\"packages\":[]}");
        }
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
            // Smart downloads: the web attaches the FOLLOWING episode's payload; the
            // service auto-queues it when this one completes (if the toggle is on).
            org.json.JSONObject next = o.optJSONObject("next");
            it.nextJson = next != null ? next.toString() : "";
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

    /**
     * Upgrade-safe denial detection. Older Norva builds asked at launch before
     * PREF_NOTIF_ASKED existed. Android exposes a rationale after a normal denial;
     * for a permanently denied v17 install, the one-time v18 migration recognizes
     * that this package was updated rather than freshly installed.
     */
    private boolean notificationPermissionPreviouslyAsked() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false;
        if (shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) {
            return true;
        }
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (prefs.getBoolean(PREF_NOTIF_MIGRATED_V18, false)) return false;
        try {
            android.content.pm.PackageInfo info = getPackageManager()
                    .getPackageInfo(getPackageName(), 0);
            boolean upgradedFromEarlierBuild = info.lastUpdateTime > info.firstInstallTime + 5_000L;
            SharedPreferences.Editor edit = prefs.edit()
                    .putBoolean(PREF_NOTIF_MIGRATED_V18, true);
            if (upgradedFromEarlierBuild) edit.putBoolean(PREF_NOTIF_ASKED, true);
            edit.apply();
            return upgradedFromEarlierBuild;
        } catch (Exception ignored) {
            return false;
        }
    }

    /**
     * Push setup resolves the FCM token without interrupting first-run with a
     * permission dialog. Home asks only after explaining the concrete benefit.
     * Best-effort and silent — if Firebase is unavailable, the app continues normally.
     */
    private void setupPush() {
        try {
            FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> {
                if (token == null || token.isEmpty()) return;
                getSharedPreferences(NorvaMessagingService.PREFS, MODE_PRIVATE)
                        .edit().putString(NorvaMessagingService.KEY_TOKEN, token).apply();
            });
        } catch (Throwable ignored) {
            // No Firebase / no google-services.json — push disabled, app continues normally.
        }
    }

    private void dispatchNotificationPermissionChanged() {
        if (webView == null) return;
        try {
            webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('norva:notification-permission-changed'));",
                    null);
        } catch (Exception ignored) {
            // The page may be between navigations; it will read the bridge state on Home.
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_NOTIF_PERM) {
            dispatchNotificationPermissionChanged();
        }
        if (requestCode == REQ_CAMERA_PERM) {
            PermissionRequest pending = pendingWebCameraRequest;
            pendingWebCameraRequest = null;
            if (pending == null) return;
            boolean granted = grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (granted) {
                pending.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            } else {
                pending.deny();
            }
        }
    }

    private static String sanitizeContainer(String c) {
        if (c == null) return "mp4";
        String s = c.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
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
        openPlayer(url, title, sourceId, itemType, itemId, resumeSeconds, null);
    }

    private void openPlayer(final String url, final String title, final String sourceId,
                            final String itemType, final String itemId, final int resumeSeconds,
                            final String fallbackUrl) {
        // A new viewer launch supersedes any automatic recovery that was still
        // resolving in the background.
        clearPendingPlayerRecovery(null);
        runOnUiThread(() -> {
            Intent intent = new Intent(MainActivity.this, PlayerActivity.class);
            intent.putExtra(PlayerActivity.EXTRA_URL, url);
            intent.putExtra(PlayerActivity.EXTRA_TITLE, title);
            if (sourceId != null) intent.putExtra(PlayerActivity.EXTRA_SOURCE_ID, sourceId);
            if (itemType != null) intent.putExtra(PlayerActivity.EXTRA_ITEM_TYPE, itemType);
            if (itemId != null) intent.putExtra(PlayerActivity.EXTRA_ITEM_ID, itemId);
            if (resumeSeconds > 0) intent.putExtra(PlayerActivity.EXTRA_RESUME_SECONDS, resumeSeconds);
            if (fallbackUrl != null && !fallbackUrl.isEmpty()) intent.putExtra(PlayerActivity.EXTRA_FALLBACK_URL, fallbackUrl);
            launchPlayerWithEphemeralAuth(intent);
        });
    }

    // Live-variant-aware launch: same as above plus the quality variants JSON + the
    // currently-playing streamId, so the player can offer a "Version" menu.
    private void openPlayer(final String url, final String title, final String sourceId,
                            final String itemType, final String itemId, final int resumeSeconds,
                            final String fallbackUrl, final String variantsJson, final String activeStreamId,
                            final String trackMetadataJson, final String preferenceScopeJson,
                            final String playbackPreferencesJson, final String posterUrl,
                            final String nextTitle, final String playbackSessionId) {
        // Variant picks and explicit Play actions are new intents. Retire the
        // previous retry token before the new Activity is launched.
        clearPendingPlayerRecovery(null);
        runOnUiThread(() -> {
            Intent intent = new Intent(MainActivity.this, PlayerActivity.class);
            intent.putExtra(PlayerActivity.EXTRA_URL, url);
            intent.putExtra(PlayerActivity.EXTRA_TITLE, title);
            if (sourceId != null) intent.putExtra(PlayerActivity.EXTRA_SOURCE_ID, sourceId);
            if (itemType != null) intent.putExtra(PlayerActivity.EXTRA_ITEM_TYPE, itemType);
            if (itemId != null) intent.putExtra(PlayerActivity.EXTRA_ITEM_ID, itemId);
            if (resumeSeconds > 0) intent.putExtra(PlayerActivity.EXTRA_RESUME_SECONDS, resumeSeconds);
            if (fallbackUrl != null && !fallbackUrl.isEmpty()) intent.putExtra(PlayerActivity.EXTRA_FALLBACK_URL, fallbackUrl);
            if (variantsJson != null && !variantsJson.isEmpty()) intent.putExtra(PlayerActivity.EXTRA_VARIANTS, variantsJson);
            if (activeStreamId != null && !activeStreamId.isEmpty()) intent.putExtra(PlayerActivity.EXTRA_ACTIVE_VARIANT, activeStreamId);
            if (trackMetadataJson != null && !trackMetadataJson.isEmpty()) {
                intent.putExtra(PlayerActivity.EXTRA_TRACK_METADATA, trackMetadataJson);
            }
            if (preferenceScopeJson != null && !preferenceScopeJson.isEmpty()) {
                intent.putExtra(PlayerActivity.EXTRA_PREFERENCE_SCOPE, preferenceScopeJson);
            }
            if (playbackPreferencesJson != null && !playbackPreferencesJson.isEmpty()) {
                intent.putExtra(PlayerActivity.EXTRA_PLAYBACK_PREFERENCES, playbackPreferencesJson);
            }
            if (posterUrl != null && !posterUrl.isEmpty()) {
                intent.putExtra(PlayerActivity.EXTRA_POSTER_URL, posterUrl);
            }
            if (nextTitle != null && !nextTitle.isEmpty()) {
                intent.putExtra(PlayerActivity.EXTRA_NEXT_TITLE, nextTitle);
            }
            if (playbackSessionId != null) {
                intent.putExtra(PlayerActivity.EXTRA_PLAYBACK_SESSION_ID, playbackSessionId);
            }
            launchPlayerWithEphemeralAuth(intent);
        });
    }

    /**
     * Read the already-authenticated cloud token just in time and keep it only
     * in the explicit, non-exported PlayerActivity intent. A short fail-open
     * timer guarantees telemetry can never delay playback materially.
     */
    private void launchPlayerWithEphemeralAuth(final Intent intent) {
        activatePlaybackAuthChannel(intent);
        if (webView == null || !cloudBridgeAdded || !isTrustedCloudUrl(webView.getUrl())) {
            startActivityForResult(intent, REQ_PLAYER);
            return;
        }
        final AtomicBoolean launched = new AtomicBoolean(false);
        final Runnable fallback = new Runnable() {
            @Override
            public void run() {
                if (launched.compareAndSet(false, true)) {
                    startActivityForResult(intent, REQ_PLAYER);
                }
            }
        };
        loadHandler.postDelayed(fallback, 250L);
        webView.evaluateJavascript(
                "(function(){try{var d=localStorage.getItem('norva-cloud-device-token')||'';"
                        + "var u=localStorage.getItem('norva-cloud-token')||'';"
                        + "if(!u){var s=JSON.parse(localStorage.getItem('norva-cloud-session')||'null');"
                        + "u=(s&&s.access_token)||'';}return d||u||'';}catch(e){return '';}})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String raw) {
                        String token = decodeJavascriptString(raw);
                        if (!launched.compareAndSet(false, true)) return;
                        loadHandler.removeCallbacks(fallback);
                        if (!token.isEmpty() && token.length() <= 16_384) {
                            intent.putExtra(PlayerActivity.EXTRA_PLAYBACK_AUTH_TOKEN, token);
                        }
                        startActivityForResult(intent, REQ_PLAYER);
                    }
                });
    }

    private static String decodeJavascriptString(String raw) {
        try {
            if (raw == null || "null".equals(raw)) return "";
            return new JSONArray("[" + raw + "]").optString(0, "");
        } catch (Exception ignored) {
            return "";
        }
    }

    private static String emptyToNull(String s) {
        return (s == null || s.isEmpty()) ? null : s;
    }

    /**
     * The native player returns its final position when it closes; forward it to
     * the web app, which persists it to the cloud history for cross-device resume.
     */
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PLAYER) return;
        String returnedPlaybackAuthChannel = data == null
                ? null : data.getStringExtra(PlayerActivity.EXTRA_PLAYBACK_AUTH_CHANNEL_ID);
        if (returnedPlaybackAuthChannel != null) {
            clearPlaybackAuthChannel(returnedPlaybackAuthChannel);
        }
        // Returning from PlayerActivity means Back, a terminal close, or a
        // deliberate variant change. All three explicitly retire the active
        // recovery; a late tokened resolver reply will be consumed, not launched.
        String returnedRecoveryToken = data == null
                ? null : data.getStringExtra(PlayerActivity.EXTRA_RECOVERY_TOKEN);
        if (returnedRecoveryToken != null) clearPendingPlayerRecovery(returnedRecoveryToken);
        clearPendingPlayerRecovery(null);
        if (data == null) return;
        // Progress and track preferences never open a provider session. Relay
        // them immediately while the Activity result is still in memory; exact
        // session closure may need durable retries and must gate only actions
        // that can resolve or launch the next stream.
        persistPlayerResultState(data);
        queuePlaybackSessionClose(
                data.getStringExtra(PlayerActivity.EXTRA_PLAYBACK_SESSION_ID),
                data.getStringExtra(PlayerActivity.EXTRA_PLAYBACK_CLOSE_REASON),
                () -> continuePlayerResult(data));
    }

    /** Relay state writes that cannot create or replace a playback session. */
    private void persistPlayerResultState(Intent data) {
        if (data == null || webView == null) return;
        final String sourceId = data.getStringExtra("sourceId");
        final String itemType = data.getStringExtra("itemType");
        final String itemId = data.getStringExtra("itemId");
        final String trackPreferences = data.getStringExtra("trackPreferences");
        if (sourceId != null && itemId != null
                && trackPreferences != null && !trackPreferences.isEmpty()) {
            final String jsPreferences =
                    "window.__norvaNative&&window.__norvaNative.onTrackPreferences&&"
                    + "window.__norvaNative.onTrackPreferences("
                    + jsStr(sourceId) + "," + jsStr(itemType) + "," + jsStr(itemId)
                    + "," + jsStr(trackPreferences) + ")";
            runOnUiThread(() -> {
                try { webView.evaluateJavascript(jsPreferences, null); } catch (Exception ignored) { }
            });
        }
        final long pos = data.getLongExtra("positionSeconds", 0);
        final long dur = data.getLongExtra("durationSeconds", 0);
        if (sourceId != null && itemId != null && pos > 0) {
            final String js = "window.__norvaNative && window.__norvaNative.onProgress("
                    + jsStr(sourceId) + "," + jsStr(itemType) + "," + jsStr(itemId) + "," + pos + "," + dur + ")";
            runOnUiThread(() -> {
                try { webView.evaluateJavascript(js, null); } catch (Exception ignored) { }
            });
        }
    }

    /** Continue only after standalone.js confirms terminal expiry with an explicit ACK. */
    private void continuePlayerResult(Intent data) {
        if (data == null || webView == null) return;
        final String sourceId = data.getStringExtra("sourceId");
        final String itemType = data.getStringExtra("itemType");
        final String itemId = data.getStringExtra("itemId");
        // Viewer picked a different quality variant in the native player: ask the web to
        // re-select it (resolves a fresh stream + relaunches native playback).
        final String pickedVariant = data.getStringExtra("selectedVariantStreamId");
        if (pickedVariant != null && !pickedVariant.isEmpty()) {
            final String pickedSource = data.getStringExtra("selectedVariantSourceId");
            final String jsv = "window.__norvaPlayVariant && window.__norvaPlayVariant("
                    + jsStr(pickedVariant) + "," + jsStr(pickedSource) + ")";
            runOnUiThread(() -> {
                try { webView.evaluateJavascript(jsv, null); } catch (Exception ignored) { }
            });
            return;
        }
        final boolean ended = data.getBooleanExtra("ended", false);
        final boolean retryPlayback = data.getBooleanExtra("retryPlayback", false);
        if (retryPlayback && sourceId != null && itemId != null) {
            // The current player now resolves fresh URLs in-place. If it closes
            // while a request is outstanding, that is a viewer cancellation;
            // never relaunch it behind Back with an unbound legacy retry.
            return;
        }
        // Natural end → ask the web to autoplay the next episode (a no-op for movies).
        if (ended && itemId != null) {
            final String jsEnded = "window.__norvaNative && window.__norvaNative.onEnded && window.__norvaNative.onEnded("
                    + jsStr(sourceId) + "," + jsStr(itemType) + "," + jsStr(itemId) + ")";
            runOnUiThread(() -> {
                try { webView.evaluateJavascript(jsEnded, null); } catch (Exception ignored) { }
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
        runOnUiThread(() -> {
            try {
                if (!isTrustedPlaybackClosePage()) {
                    schedulePlaybackCloseRetry(sessionId, "not_ready");
                    return;
                }
                // Arm before evaluateJavascript: a renderer reload can swallow
                // ValueCallback entirely. The real accepted/not_ready callback
                // replaces this bounded fallback timer when it arrives.
                schedulePlaybackCloseRetry(sessionId, "not_ready");
                webView.evaluateJavascript(js, value -> {
                    String decodedStatus = decodeJavascriptString(value);
                    String status = "accepted".equals(decodedStatus)
                            ? "accepted" : "not_ready";
                    // accepted is delivery ownership, not terminal expiry. Keep
                    // both the durable UUID and its continuation pending until
                    // ackPlaybackSessionClosed. This prevents a new resolver
                    // from opening while exact expiry is still failing.
                    schedulePlaybackCloseRetry(sessionId, status);
                });
            } catch (Exception ignored) {
                schedulePlaybackCloseRetry(sessionId, "not_ready");
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
            task = () -> {
                synchronized (playbackCloseLock) {
                    playbackCloseRetryTasks.remove(sessionId);
                }
                dispatchPlaybackSessionClose(sessionId);
            };
            playbackCloseRetryTasks.put(sessionId, task);
        }
        loadHandler.postDelayed(task, delayMs);
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
        if (task != null) loadHandler.removeCallbacks(task);
    }

    private void loadPendingPlaybackSessionCloses() {
        Set<String> encoded = prefs().getStringSet(
                PREF_PENDING_PLAYBACK_CLOSES, Collections.emptySet());
        if (encoded == null) encoded = Collections.emptySet();
        final long nowEpochMs = System.currentTimeMillis();
        ArrayList<NativePlaybackClosePolicy.Entry> valid = new ArrayList<>();
        for (String value : encoded) {
            NativePlaybackClosePolicy.Entry entry =
                    NativePlaybackClosePolicy.decode(value, nowEpochMs);
            if (entry != null) valid.add(entry);
        }
        // Collections.sort is available on the phone client's minSdk 23;
        // List.sort would require API 24 without core-library desugaring.
        Collections.sort(valid, (left, right) -> Long.compare(
                left.createdAtEpochMs, right.createdAtEpochMs));
        int firstRetained = Math.max(
                0, valid.size() - NativePlaybackClosePolicy.MAX_PENDING_CLOSES);
        synchronized (playbackCloseLock) {
            pendingPlaybackSessionCloses.clear();
            for (int index = firstRetained; index < valid.size(); index++) {
                NativePlaybackClosePolicy.Entry entry = valid.get(index);
                pendingPlaybackSessionCloses.put(entry.sessionId, entry);
            }
            // Rewrite once so corrupt or legacy values cannot linger alongside
            // the exact UUID + reason + absolute-age-anchor schema.
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

    @Override
    protected void onResume() {
        super.onResume();
        NativeClarity.event("app_open");
        if (webAppReady) {
            flushPendingNativeProgress();
            flushPendingPlaybackSessionCloses(true);
        }
    }

    /**
     * H1 / offline recovery: the native PlayerActivity persists its live position to
     * SharedPreferences on onPause/onStop (online AND offline). When it exits without a
     * graceful online result (background/standby/kill, or any downloaded-title play,
     * which is launched without a result), that position is stranded; here we relay it
     * to the web app's onProgress bridge (which writes cloud history), then consume it.
     * Guarded on webAppReady so a cold-start onResume doesn't drop the record.
     */
    private void flushPendingNativeProgress() {
        try {
            if (!webAppReady || webView == null) return;
            SharedPreferences p = prefs();
            String itemId = p.getString("pending_progress_itemId", null);
            if (itemId == null || itemId.isEmpty()) return;
            final String sourceId = p.getString("pending_progress_sourceId", "");
            final String itemType = p.getString("pending_progress_itemType", "");
            final long pos = p.getLong("pending_progress_pos", 0);
            final long dur = p.getLong("pending_progress_dur", 0);
            p.edit()
                    .remove("pending_progress_sourceId").remove("pending_progress_itemType")
                    .remove("pending_progress_itemId").remove("pending_progress_pos")
                    .remove("pending_progress_dur").apply();
            if (pos <= 0) return;
            final String js = "window.__norvaNative && window.__norvaNative.onProgress("
                    + jsStr(sourceId) + "," + jsStr(itemType) + "," + jsStr(itemId) + "," + pos + "," + dur + ")";
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try { if (webView != null) webView.evaluateJavascript(js, null); } catch (Exception ignored) { }
                }
            });
        } catch (Exception ignored) { /* flush is best-effort */ }
    }

    private static String jsStr(String value) {
        if (value == null) return "''";
        return "'" + value.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ") + "'";
    }

    /**
     * Native Google Sign-In via Credential Manager. Reads the WEB OAuth client id
     * from R.string.norva_google_web_client_id (dormant until the owner sets it and
     * creates an Android OAuth client for tv.norva.phone + the Play signing SHA-256
     * in Google Cloud). On success/failure it calls back into the page via
     * window.onNorvaGoogleIdToken(idToken, error).
     */
    private void startGoogleSignIn() {
        final String webClientId = getString(R.string.norva_google_web_client_id);
        if (webClientId == null || webClientId.trim().isEmpty()) {
            sendGoogleIdTokenToWeb(null, "google_not_configured");
            return;
        }
        // Single-shot guard: the GMS Credential Manager Task has been observed to
        // stall without ever invoking onResult/onError (no account, Play Services
        // mid-update, transient GMS bug). A native watchdog guarantees the web page
        // always gets exactly one callback so it can never hang on "Opening Google…".
        // AtomicBoolean dedups between the real callback and the watchdog; whichever
        // fires first wins.
        final AtomicBoolean answered = new AtomicBoolean(false);
        final Handler watchdog = new Handler(Looper.getMainLooper());
        final Runnable onTimeout = () -> {
            if (answered.compareAndSet(false, true)) {
                sendGoogleIdTokenToWeb(null, "timeout: Google Sign-In did not respond. "
                        + "Check the account chooser or try again.");
            }
        };
        try {
            // GetSignInWithGoogleOption = the button-triggered flow (always shows the
            // account chooser). More reliable than GetGoogleIdOption here, which can
            // stall/return no-credential when there is no previously-authorized account.
            GetSignInWithGoogleOption option =
                    new GetSignInWithGoogleOption.Builder(webClientId).build();
            GetCredentialRequest request = new GetCredentialRequest.Builder()
                    .addCredentialOption(option)
                    .build();
            CredentialManager credentialManager = CredentialManager.create(this);
            Executor executor = ContextCompat.getMainExecutor(this);
            // 20s native watchdog — shorter than the web-side 30s guard so a native
            // timeout message reaches the page first with a concrete reason.
            watchdog.postDelayed(onTimeout, 20_000);
            credentialManager.getCredentialAsync(this, request, null, executor,
                    new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                        @Override
                        public void onResult(GetCredentialResponse response) {
                            watchdog.removeCallbacks(onTimeout);
                            if (!answered.compareAndSet(false, true)) return;
                            try {
                                Credential credential = response.getCredential();
                                if (credential instanceof CustomCredential
                                        && GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) {
                                    GoogleIdTokenCredential googleCred =
                                            GoogleIdTokenCredential.createFrom(((CustomCredential) credential).getData());
                                    sendGoogleIdTokenToWeb(googleCred.getIdToken(), null);
                                } else {
                                    sendGoogleIdTokenToWeb(null, "unexpected_credential_type");
                                }
                            } catch (Exception e) {
                                sendGoogleIdTokenToWeb(null, e.getMessage());
                            }
                        }

                        @Override
                        public void onError(GetCredentialException e) {
                            watchdog.removeCallbacks(onTimeout);
                            if (!answered.compareAndSet(false, true)) return;
                            if (e instanceof NoCredentialException) {
                                sendGoogleIdTokenToWeb(null, "no_google_credential");
                                return;
                            }
                            // Surface the exception class too — e.g. NoCredentialException
                            // (no Google account on device) vs GetCredentialProviderConfigurationException
                            // (SHA-1 / OAuth client misconfigured) read very differently.
                            String msg = e.getClass().getSimpleName()
                                    + (e.getMessage() != null ? ": " + e.getMessage() : "");
                            sendGoogleIdTokenToWeb(null, msg);
                        }
                    });
        } catch (Exception e) {
            watchdog.removeCallbacks(onTimeout);
            if (answered.compareAndSet(false, true)) {
                sendGoogleIdTokenToWeb(null, e.getMessage());
            }
        }
    }

    /** Hand the Google ID token (or an error) back to the web account page. */
    private void sendGoogleIdTokenToWeb(final String idToken, final String error) {
        final String js = "window.onNorvaGoogleIdToken && window.onNorvaGoogleIdToken("
                + jsStr(idToken) + "," + jsStr(error) + ")";
        runOnUiThread(() -> {
            try { if (webView != null) webView.evaluateJavascript(js, null); } catch (Exception ignored) { }
        });
    }

    private void showSetup(String error) {
        webViewVisible = false;
        loadHandler.removeCallbacks(loadTimeout);
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
        logo.setImageResource(R.drawable.norva_app_icon);
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
                // A failed first cloud load can happen before the emulator/device
                // has usable networking. Retrying through connect() would remove
                // NorvaTVCloud, so the web catalog would appear healthy while every
                // Play action silently lost its native PlayerActivity handoff.
                if ("cloud".equals(prefs().getString(PREF_MODE, null))) {
                    connectCloud(lastLoadedUrl);
                } else {
                    connect(lastLoadedUrl);
                }
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
        loadHandler.removeCallbacks(loadTimeout);
        hideSplash();
        webView.setVisibility(View.GONE);
        setupPanel.setVisibility(View.GONE);
        if (errorText != null) {
            errorText.setText("Please check your internet connection and try again.");
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
