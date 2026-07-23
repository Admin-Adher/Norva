package tv.norva.phone;

import android.content.Context;
import android.os.Bundle;

import com.google.firebase.analytics.FirebaseAnalytics;

import java.util.Locale;

/**
 * Bounded analytics for native player UI interactions.
 *
 * <p>Events exist only to understand whether controls are discoverable and
 * whether recovery/actions are working. Payload fields are whitelisted below.</p>
 */
final class NativePlayerUiTelemetry {

    private NativePlayerUiTelemetry() {}

    static void log(
            Context context,
            String eventName,
            String action,
            String target,
            String state
    ) {
        if (context == null || !isAllowedEvent(eventName)) return;
        try {
            Bundle event = new Bundle();
            event.putString("action", clean(action));
            event.putString("target", clean(target));
            event.putString("state", clean(state));
            FirebaseAnalytics.getInstance(context).logEvent(eventName, event);
        } catch (Throwable ignored) {
            // Measurement must never affect playback.
        }
    }

    private static boolean isAllowedEvent(String eventName) {
        return "player_tracks_open".equals(eventName)
                || "player_track_select".equals(eventName)
                || "player_track_select_fail".equals(eventName)
                || "player_gesture".equals(eventName)
                || "player_error_action".equals(eventName)
                || "player_ui_summary".equals(eventName);
    }

    private static String clean(String value) {
        if (value == null) return "unknown";
        String normalized = value.trim().toLowerCase(Locale.ROOT)
                .replaceAll("[^a-z0-9_.-]+", "_");
        if (normalized.isEmpty()) return "unknown";
        return normalized.length() > 40 ? normalized.substring(0, 40) : normalized;
    }
}
