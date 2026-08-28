package tv.norva.analytics;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Looper;
import android.view.View;

import com.microsoft.clarity.Clarity;
import com.microsoft.clarity.ClarityConfig;

import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

import kotlin.Unit;

/**
 * Consent-gated Microsoft Clarity adapter shared by the phone and TV clients.
 *
 * <p>The adapter is deliberately data-minimal: it never identifies a user,
 * source, provider or title. The WebView is always masked, and the bridge only
 * accepts a closed vocabulary of screen names and product events.</p>
 */
public final class NativeClarity {

    public interface ConsentListener {
        void onConsentChanged(boolean granted);
    }

    private static final String PREFS = "norva_native_analytics";
    private static final String PREF_CONSENT = "analytics_consent";
    private static final int PROTOCOL_VERSION = 1;
    private static final int MAX_MESSAGE_CHARS = 384;
    private static final String SCHEMA = "norva-native-clarity:v1";

    private static final Set<String> SCREENS = new HashSet<>(Arrays.asList(
            "home", "live", "guide", "movies", "series", "settings",
            "settings_account", "settings_sources", "settings_profile",
            "settings_notifications", "partners", "search", "player",
            "downloads", "pairing", "setup", "account", "error"
    ));

    // Clarity supports at most 20 custom Smart Events. Keep this set bounded.
    private static final Set<String> EVENTS = new HashSet<>(Arrays.asList(
            "app_open", "provider_access_opened", "provider_access_saved",
            "provider_access_action_required", "provider_access_error",
            "catalog_sync_started", "catalog_sync_ready", "catalog_sync_error",
            "player_started", "player_first_frame", "player_error",
            "player_retry", "player_exit", "login_started", "login_completed",
            "login_error"
    ));

    private static final List<WeakReference<View>> SENSITIVE_VIEWS = new ArrayList<>();
    private static String projectId = "";
    private static String platform = "unknown";
    private static String appVersion = "unknown";
    private static boolean initialized;
    private static boolean sessionReady;
    private static boolean granted;
    private static String pendingScreen = "";
    private static final List<String> PENDING_EVENTS = new ArrayList<>();

    private NativeClarity() {}

    public static synchronized void configure(
            String clarityProjectId,
            String platformName,
            String versionName
    ) {
        if (initialized) return;
        projectId = safeToken(clarityProjectId, 24, "");
        platform = safeToken(platformName, 32, "unknown");
        appVersion = safeToken(versionName, 32, "unknown");
    }

    /** Register a view that must never be visible in session replay. */
    public static synchronized void registerSensitiveView(View view) {
        if (view == null) return;
        SENSITIVE_VIEWS.add(new WeakReference<>(view));
        if (initialized) mask(view);
    }

    /**
     * Accept a closed, identifier-free message from the origin-scoped WebView
     * channel. The Activity must call this on the main thread.
     */
    public static void handleMessage(
            Activity activity,
            String raw,
            ConsentListener consentListener
    ) {
        if (activity == null || raw == null || raw.isEmpty()
                || raw.length() > MAX_MESSAGE_CHARS) return;
        try {
            JSONObject message = new JSONObject(raw);
            if (message.optInt("v", -1) != PROTOCOL_VERSION) return;
            String type = message.optString("type", "");
            if ("consent".equals(type) && hasExactKeys(message, "v", "type", "status")) {
                String status = message.optString("status", "");
                if (!"granted".equals(status) && !"denied".equals(status)) return;
                boolean allow = "granted".equals(status);
                applyConsent(activity, allow);
                if (consentListener != null) consentListener.onConsentChanged(allow);
                return;
            }
            if ("screen".equals(type) && hasExactKeys(message, "v", "type", "name")) {
                screen(message.optString("name", ""));
                return;
            }
            if ("event".equals(type) && hasExactKeys(message, "v", "type", "name")) {
                event(message.optString("name", ""));
            }
        } catch (Exception ignored) {
            // Invalid messages are dropped without exposing parser details.
        }
    }

    public static synchronized void applyStoredConsent(Activity activity) {
        applyStoredConsent(activity, null);
    }

    public static synchronized void applyStoredConsent(
            Activity activity,
            ConsentListener consentListener
    ) {
        if (activity == null) return;
        String value = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(PREF_CONSENT, "unknown");
        if ("granted".equals(value)) {
            applyConsent(activity, true);
            if (consentListener != null) consentListener.onConsentChanged(true);
        } else if ("denied".equals(value) && consentListener != null) {
            consentListener.onConsentChanged(false);
        }
    }

    public static synchronized void applyConsent(Activity activity, boolean allow) {
        if (activity == null || Looper.myLooper() != Looper.getMainLooper()) return;
        SharedPreferences preferences = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        preferences.edit().putString(PREF_CONSENT, allow ? "granted" : "denied").apply();
        granted = allow;

        if (!allow) {
            sessionReady = false;
            pendingScreen = "";
            PENDING_EVENTS.clear();
            if (initialized) {
                try { Clarity.consent(false, false); } catch (Throwable ignored) { }
                try { Clarity.pause(); } catch (Throwable ignored) { }
            }
            return;
        }
        if (projectId.isEmpty()) return; // Build remains fail-closed without a project id.

        if (!initialized) {
            try {
                boolean possible = Clarity.initialize(activity, new ClarityConfig(projectId));
                if (!possible) {
                    granted = false;
                    return;
                }
                initialized = true;
                PENDING_EVENTS.add("app_open");
                boolean callbackRegistered = Clarity.setOnSessionStartedCallback(sessionId -> {
                    synchronized (NativeClarity.class) {
                        if (initialized && granted) {
                            sessionReady = true;
                            applySessionContext();
                        }
                    }
                    return Unit.INSTANCE;
                });
                if (!callbackRegistered) {
                    try { Clarity.consent(false, false); } catch (Throwable ignored) { }
                    try { Clarity.pause(); } catch (Throwable ignored) { }
                    initialized = false;
                    sessionReady = false;
                    granted = false;
                    PENDING_EVENTS.clear();
                    return;
                }
            } catch (Throwable ignored) {
                try { Clarity.consent(false, false); } catch (Throwable nestedIgnored) { }
                try { Clarity.pause(); } catch (Throwable nestedIgnored) { }
                initialized = false;
                sessionReady = false;
                granted = false;
                PENDING_EVENTS.clear();
                return;
            }
        }
        try { Clarity.consent(false, true); } catch (Throwable ignored) { }
        try { Clarity.resume(); } catch (Throwable ignored) { }
    }

    public static synchronized void screen(String name) {
        String safe = normalize(name);
        if (!initialized || !granted || !SCREENS.contains(safe)) return;
        if (!sessionReady) {
            pendingScreen = safe;
            return;
        }
        try { Clarity.setCurrentScreenName(safe); } catch (Throwable ignored) { }
    }

    public static synchronized void event(String name) {
        String safe = normalize(name);
        if (!initialized || !granted || !EVENTS.contains(safe)) return;
        if (!sessionReady) {
            if (PENDING_EVENTS.size() < EVENTS.size()) PENDING_EVENTS.add(safe);
            return;
        }
        try { Clarity.sendCustomEvent(safe); } catch (Throwable ignored) { }
    }

    static boolean isAllowedScreen(String name) {
        return SCREENS.contains(normalize(name));
    }

    static boolean isAllowedEvent(String name) {
        return EVENTS.contains(normalize(name));
    }

    private static boolean hasExactKeys(JSONObject value, String... keys) {
        if (value == null || value.length() != keys.length) return false;
        for (String key : keys) if (!value.has(key)) return false;
        return true;
    }

    private static void maskRegisteredViews() {
        for (int i = SENSITIVE_VIEWS.size() - 1; i >= 0; i -= 1) {
            View view = SENSITIVE_VIEWS.get(i).get();
            if (view == null) SENSITIVE_VIEWS.remove(i);
            else mask(view);
        }
    }

    private static void applySessionContext() {
        try { Clarity.setCustomTag("norva_schema", SCHEMA); } catch (Throwable ignored) { }
        try { Clarity.setCustomTag("norva_platform", platform); } catch (Throwable ignored) { }
        try { Clarity.setCustomTag("norva_runtime", "native"); } catch (Throwable ignored) { }
        try { Clarity.setCustomTag("norva_app_version", appVersion); } catch (Throwable ignored) { }
        maskRegisteredViews();
        if (!pendingScreen.isEmpty()) {
            try { Clarity.setCurrentScreenName(pendingScreen); } catch (Throwable ignored) { }
            pendingScreen = "";
        }
        for (String event : PENDING_EVENTS) {
            try { Clarity.sendCustomEvent(event); } catch (Throwable ignored) { }
        }
        PENDING_EVENTS.clear();
    }

    private static void mask(View view) {
        try { Clarity.maskView(view); } catch (Throwable ignored) { }
    }

    private static String normalize(String value) {
        return safeToken(value, 48, "unknown");
    }

    private static String safeToken(String value, int limit, String fallback) {
        if (value == null) return fallback;
        String normalized = value.trim().toLowerCase(Locale.ROOT)
                .replaceAll("[^a-z0-9_.-]+", "_");
        if (normalized.isEmpty()) return fallback;
        return normalized.length() > limit ? normalized.substring(0, limit) : normalized;
    }
}
