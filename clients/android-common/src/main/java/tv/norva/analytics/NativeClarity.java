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
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
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
    private static final int PROTOCOL_VERSION = 2;
    private static final int MAX_MESSAGE_CHARS = 384;
    private static final String SCHEMA = "norva-native-clarity:v2";

    private static final Set<String> SCREENS = new HashSet<>(Arrays.asList(
            "home", "live", "guide", "movies", "series", "settings",
            "settings_account", "settings_sources", "settings_profile",
            "settings_notifications", "partners", "search", "player",
            "downloads", "pairing", "setup", "account", "pricing",
            "checkout", "subscription", "error"
    ));

    // Raw API events are a closed vocabulary. Clarity's separate 20-event Smart
    // Event spine is documented in clients/CLARITY_ANDROID_ROLLOUT.md and reuses
    // these events across funnels instead of creating a new event per screen.
    private static final Set<String> EVENTS = new HashSet<>(Arrays.asList(
            "app_open", "landing_view", "primary_cta_clicked", "store_cta_clicked",
            "signup_started", "signup_completed", "login_started", "login_completed",
            "pricing_viewed", "plan_selected", "checkout_started", "checkout_completed",
            "provider_connect_started", "provider_connected", "provider_access_opened",
            "provider_access_saved", "provider_action_required", "provider_repair_started",
            "provider_repair_succeeded", "catalog_sync_started", "catalog_ready",
            "content_opened", "playback_started", "playback_first_frame",
            "journey_retry", "journey_error", "billing_period_changed",
            "faq_opened", "demo_interaction", "context_widget_action",
            "context_widget_impression"
    ));

    private static final Map<String, Set<String>> CONTEXT_VALUES = contextValues();

    private static final List<WeakReference<View>> SENSITIVE_VIEWS = new ArrayList<>();
    private static String projectId = "";
    private static String platform = "unknown";
    private static String appVersion = "unknown";
    private static String releaseChannel = "unknown";
    private static boolean initialized;
    private static boolean sessionReady;
    private static boolean granted;
    private static String pendingScreen = "";
    private static final List<String> PENDING_EVENTS = new ArrayList<>();
    private static final Map<String, String> PENDING_CONTEXT = new HashMap<>();

    private NativeClarity() {}

    public static synchronized void configure(
            String clarityProjectId,
            String platformName,
            String versionName,
            String channelName
    ) {
        if (initialized) return;
        projectId = safeToken(clarityProjectId, 24, "");
        platform = safeToken(platformName, 32, "unknown");
        appVersion = safeToken(versionName, 32, "unknown");
        releaseChannel = allowedValue("release_channel", channelName);
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
                return;
            }
            if ("context".equals(type) && hasExactKeys(message, "v", "type", "tags")) {
                JSONObject tags = message.optJSONObject("tags");
                if (tags == null || tags.length() > CONTEXT_VALUES.size()) return;
                Iterator<String> keys = tags.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    tag(key, tags.optString(key, ""));
                }
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
            PENDING_CONTEXT.clear();
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
                    PENDING_CONTEXT.clear();
                    return;
                }
            } catch (Throwable ignored) {
                try { Clarity.consent(false, false); } catch (Throwable nestedIgnored) { }
                try { Clarity.pause(); } catch (Throwable nestedIgnored) { }
                initialized = false;
                sessionReady = false;
                granted = false;
                PENDING_EVENTS.clear();
                PENDING_CONTEXT.clear();
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

    public static synchronized void tag(String key, String value) {
        String safeKey = normalize(key);
        String safeValue = allowedValue(safeKey, value);
        if (!initialized || !granted || safeValue.isEmpty()) return;
        if (!sessionReady) {
            PENDING_CONTEXT.put(safeKey, safeValue);
            return;
        }
        try { Clarity.setCustomTag(safeKey, safeValue); } catch (Throwable ignored) { }
    }

    static boolean isAllowedScreen(String name) {
        return SCREENS.contains(normalize(name));
    }

    static boolean isAllowedEvent(String name) {
        return EVENTS.contains(normalize(name));
    }

    static boolean isAllowedContext(String key, String value) {
        return !allowedValue(normalize(key), value).isEmpty();
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
        try { Clarity.setCustomTag("release_channel", releaseChannel); } catch (Throwable ignored) { }
        try { Clarity.setCustomTag("funnel_version", "norva-funnel:v2"); } catch (Throwable ignored) { }
        for (Map.Entry<String, String> entry : PENDING_CONTEXT.entrySet()) {
            try { Clarity.setCustomTag(entry.getKey(), entry.getValue()); } catch (Throwable ignored) { }
        }
        PENDING_CONTEXT.clear();
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

    private static String allowedValue(String key, String value) {
        String safeKey = normalize(key);
        String safeValue = safeToken(value, 48, "");
        Set<String> allowed = CONTEXT_VALUES.get(safeKey);
        return allowed != null && allowed.contains(safeValue) ? safeValue : "";
    }

    private static Map<String, Set<String>> contextValues() {
        Map<String, Set<String>> values = new HashMap<>();
        values.put("visitor_state", set("signed_in", "anonymous"));
        values.put("billing_period", set("monthly", "annual"));
        values.put("selected_plan", set("plus", "family", "unknown"));
        values.put("event_source", set("landing", "hero", "nav", "pricing", "context_widget", "manual", "automatic", "settings", "onboarding", "player", "unknown"));
        values.put("event_target", set("signup", "login", "pricing", "android_mobile", "android_tv", "app", "checkout", "unknown"));
        values.put("event_state", set("started", "completed", "ready", "action_required", "error", "cancelled", "unknown"));
        values.put("auth_method", set("email_password", "email_magic_link", "google", "unknown"));
        values.put("journey_entrypoint", set("landing", "account", "subscribe_plans", "paywall", "locked_profile", "settings", "onboarding", "player", "unknown"));
        values.put("journey_name", set("acquisition", "subscription", "provider_onboarding", "provider_recovery", "catalog", "time_to_value", "authentication", "unknown"));
        values.put("journey_step", set("landing", "signup", "login", "pricing", "checkout", "provider_connect", "provider_access", "provider_repair", "catalog_sync", "content", "playback", "unknown"));
        values.put("journey_outcome", set("success", "error", "cancelled", "pending", "retry", "unknown"));
        values.put("failure_family", set("credentials", "provider_busy", "provider_blocked", "provider_unreachable", "network", "timeout", "format", "superseded", "revision_conflict", "invalid_state", "billing_unavailable", "payment_declined", "entitlement_pending", "cancelled", "unknown"));
        values.put("catalog_state", set("none", "syncing", "ready", "error", "unknown"));
        values.put("provider_access_state", set("active", "expiring", "expected_expired", "expired_confirmed", "access_unavailable_confirmed", "check_failed_temporary", "restoring", "unknown"));
        values.put("subscription_state", set("none", "trialing", "active", "past_due", "cancelled", "unknown"));
        values.put("release_channel", set("production", "qa", "preview", "unknown"));
        return Collections.unmodifiableMap(values);
    }

    private static Set<String> set(String... values) {
        return Collections.unmodifiableSet(new HashSet<>(Arrays.asList(values)));
    }

    private static String safeToken(String value, int limit, String fallback) {
        if (value == null) return fallback;
        String normalized = value.trim().toLowerCase(Locale.ROOT)
                .replaceAll("[^a-z0-9_.-]+", "_");
        if (normalized.isEmpty()) return fallback;
        return normalized.length() > limit ? normalized.substring(0, limit) : normalized;
    }
}
