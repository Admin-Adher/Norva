package tv.norva.phone;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Firebase Cloud Messaging receiver. Two jobs:
 *  - onNewToken: cache the device's FCM token in a small prefs file. The WebView bridge
 *    (MainActivity.CloudBridge.getPushToken) reads it and the web app registers it with the backend.
 *  - onMessageReceived: show legacy notification messages in the foreground and durable Provider
 *    Access data-only messages in every process state. Provider Access messages carry a stable ID,
 *    are deduplicated locally, and deep-link only to the fixed Norva Settings route.
 */
public class NorvaMessagingService extends FirebaseMessagingService {
    static final String PREFS = "norva_push";
    static final String KEY_TOKEN = "fcm_token";
    private static final String KEY_PROVIDER_ACCESS_SEEN = "provider_access_seen_v1";
    private static final String KEY_LIFECYCLE_SEEN = "behavioral_lifecycle_seen_v1";
    private static final String KEY_LIFECYCLE_RECEIPTS = "behavioral_lifecycle_receipts_v1";
    private static final String IMPORT_CHANNEL = "norva_imports";
    private static final String PROVIDER_ACCESS_CHANNEL = "norva_provider_access";
    private static final String LIFECYCLE_CHANNEL = "norva_lifecycle_guidance";
    private static final String PROVIDER_ACCESS_LINK = "https://norva.tv/app.html?mobile=1#settings/sources";
    private static final int MAX_SEEN_PROVIDER_ACCESS = 64;
    private static final int MAX_LIFECYCLE_RECEIPTS = 128;
    private static final String LIFECYCLE_DELIVERY_ID_PATTERN =
            "(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

    @Override
    public void onNewToken(String token) {
        if (token == null) return;
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_TOKEN, token).apply();
    }

    @Override
    public void onMessageReceived(RemoteMessage msg) {
        Map<String, String> data = msg.getData();
        if ("provider_access".equals(data.get("kind"))) {
            showProviderAccessNotification(data);
            return;
        }
        if ("behavioral_lifecycle".equals(data.get("kind"))) {
            showLifecycleNotification(data);
            return;
        }
        RemoteMessage.Notification n = msg.getNotification();
        String title = (n != null && n.getTitle() != null) ? n.getTitle() : "Norva";
        String body = (n != null && n.getBody() != null) ? n.getBody() : "";
        showNotification(title, body, IMPORT_CHANNEL, null, null,
                (int) (System.currentTimeMillis() % 100000));
    }

    private void showProviderAccessNotification(Map<String, String> data) {
        String notificationId = bounded(data.get("notificationId"), 200);
        String title = bounded(data.get("title"), 120);
        String body = bounded(data.get("body"), 500);
        String deepLink = data.get("deepLink");
        if (notificationId == null || title == null || body == null
                || !PROVIDER_ACCESS_LINK.equals(deepLink)
                || !notificationId.matches("[A-Za-z0-9._:-]+")) return;
        if (!rememberProviderAccessNotification(notificationId)) return;
        showNotification(title, body, PROVIDER_ACCESS_CHANNEL, Uri.parse(PROVIDER_ACCESS_LINK),
                null, notificationId.hashCode());
    }

    private void showLifecycleNotification(Map<String, String> data) {
        String deliveryId = bounded(data.get("deliveryId"), 36);
        String title = bounded(data.get("title"), 80);
        String body = bounded(data.get("body"), 500);
        Uri deepLink = canonicalLifecycleLink(data.get("deepLink"), deliveryId);
        if (!isLifecycleDeliveryId(deliveryId)
                || title == null || body == null || deepLink == null) return;
        if (!rememberLifecycleNotification(deliveryId)) return;
        if (showNotification(title, body, LIFECYCLE_CHANNEL, deepLink, deliveryId,
                deliveryId.hashCode())) {
            rememberLifecycleReceipt(this, deliveryId, "delivered");
        }
    }

    private static String bounded(String value, int max) {
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.isEmpty() || trimmed.length() > max ? null : trimmed;
    }

    private synchronized boolean rememberProviderAccessNotification(String notificationId) {
        SharedPreferences preferences = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String stored = preferences.getString(KEY_PROVIDER_ACCESS_SEEN, "");
        List<String> retained = new ArrayList<>();
        if (stored != null && !stored.isEmpty()) {
            for (String seen : stored.split("\\n")) {
                if (notificationId.equals(seen)) return false;
                if (!seen.isEmpty() && retained.size() < MAX_SEEN_PROVIDER_ACCESS - 1) retained.add(seen);
            }
        }
        StringBuilder next = new StringBuilder(notificationId);
        for (String seen : retained) next.append('\n').append(seen);
        preferences.edit().putString(KEY_PROVIDER_ACCESS_SEEN, next.toString()).apply();
        return true;
    }

    private synchronized boolean rememberLifecycleNotification(String deliveryId) {
        SharedPreferences preferences = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String stored = preferences.getString(KEY_LIFECYCLE_SEEN, "");
        List<String> retained = new ArrayList<>();
        if (stored != null && !stored.isEmpty()) {
            for (String seen : stored.split("\\n")) {
                if (deliveryId.equals(seen)) return false;
                if (!seen.isEmpty() && retained.size() < MAX_SEEN_PROVIDER_ACCESS - 1) retained.add(seen);
            }
        }
        StringBuilder next = new StringBuilder(deliveryId);
        for (String seen : retained) next.append('\n').append(seen);
        preferences.edit().putString(KEY_LIFECYCLE_SEEN, next.toString()).apply();
        return true;
    }

    static Uri canonicalLifecycleLink(String value, String expectedDeliveryId) {
        if (value == null || !isLifecycleDeliveryId(expectedDeliveryId)) return null;
        try {
            Uri uri = Uri.parse(value);
            Set<String> names = uri.getQueryParameterNames();
            String fragment = canonicalLifecycleFragment(uri.getFragment());
            if (!"https".equalsIgnoreCase(uri.getScheme())
                    || !"norva.tv".equalsIgnoreCase(uri.getHost())
                    || (uri.getPort() != -1 && uri.getPort() != 443)
                    || !"/app.html".equals(uri.getPath())
                    || names.size() != 2
                    || !names.contains("mobile")
                    || !names.contains("lifecycleDelivery")
                    || uri.getQueryParameters("mobile").size() != 1
                    || uri.getQueryParameters("lifecycleDelivery").size() != 1
                    || !"1".equals(uri.getQueryParameter("mobile"))
                    || !expectedDeliveryId.equals(uri.getQueryParameter("lifecycleDelivery"))
                    || fragment == null) return null;
            return new Uri.Builder()
                    .scheme("https")
                    .authority("norva.tv")
                    .appendPath("app.html")
                    .appendQueryParameter("mobile", "1")
                    .appendQueryParameter("lifecycleDelivery", expectedDeliveryId)
                    // The fragment has already passed the strict route allowlist.
                    // Preserve its path separators: Uri.Builder.fragment() escapes
                    // '/' to %2F, which prevents app.js from matching the route.
                    .encodedFragment(fragment)
                    .build();
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String canonicalLifecycleFragment(String value) {
        if ("home".equals(value) || "home/resume".equals(value)
                || "settings/sources".equals(value)) return value;
        if (value == null) return null;
        String[] parts = value.split("/", -1);
        if (parts.length != 5
                || !"settings".equals(parts[0])
                || !"sources".equals(parts[1])
                || !"help".equals(parts[2])
                || !("m3u".equals(parts[4]) || "xtream".equals(parts[4]))) return null;
        switch (parts[3]) {
            case "credentials":
            case "missing_credentials":
            case "endpoint_not_found":
            case "timeout":
            case "provider_busy":
            case "rate_limited":
            case "playlist_format":
            case "invalid_input":
            case "payload_too_large":
            case "provider_unreachable":
            case "infrastructure":
            case "unknown":
                return value;
            default:
                return null;
        }
    }

    static synchronized void rememberLifecycleReceipt(
            Context context, String deliveryId, String event) {
        if (context == null || deliveryId == null || event == null
                || !isLifecycleDeliveryId(deliveryId)
                || !("delivered".equals(event) || "opened".equals(event))) return;
        SharedPreferences preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String entry = event + ":" + deliveryId;
        String stored = preferences.getString(KEY_LIFECYCLE_RECEIPTS, "");
        List<String> retained = new ArrayList<>();
        if (stored != null && !stored.isEmpty()) {
            for (String current : stored.split("\\n")) {
                if (entry.equals(current)) return;
                if (!current.isEmpty() && retained.size() < MAX_LIFECYCLE_RECEIPTS - 1) retained.add(current);
            }
        }
        StringBuilder next = new StringBuilder(entry);
        for (String current : retained) next.append('\n').append(current);
        preferences.edit().putString(KEY_LIFECYCLE_RECEIPTS, next.toString()).apply();
    }

    static synchronized String drainLifecycleReceipts(Context context) {
        SharedPreferences preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String stored = preferences.getString(KEY_LIFECYCLE_RECEIPTS, "");
        preferences.edit().remove(KEY_LIFECYCLE_RECEIPTS).commit();
        JSONArray result = new JSONArray();
        if (stored == null || stored.isEmpty()) return result.toString();
        for (String entry : stored.split("\\n")) {
            int separator = entry.indexOf(':');
            if (separator <= 0 || separator >= entry.length() - 1) continue;
            try {
                JSONObject receipt = new JSONObject();
                receipt.put("event", entry.substring(0, separator));
                receipt.put("deliveryId", entry.substring(separator + 1));
                result.put(receipt);
            } catch (Exception ignored) { }
        }
        return result.toString();
    }

    static synchronized void restoreLifecycleReceipts(Context context, String value) {
        try {
            JSONArray receipts = new JSONArray(value == null ? "[]" : value);
            for (int i = 0; i < receipts.length() && i < MAX_LIFECYCLE_RECEIPTS; i++) {
                JSONObject receipt = receipts.optJSONObject(i);
                if (receipt == null) continue;
                rememberLifecycleReceipt(
                        context,
                        receipt.optString("deliveryId", ""),
                        receipt.optString("event", ""));
            }
        } catch (Exception ignored) { }
    }

    private static boolean isLifecycleDeliveryId(String value) {
        return value != null && value.matches(LIFECYCLE_DELIVERY_ID_PATTERN);
    }

    static boolean notificationDisplayAllowed(
            int sdkInt, boolean runtimePermissionGranted, boolean managerEnabled,
            boolean channelEnabled) {
        return (sdkInt < Build.VERSION_CODES.TIRAMISU || runtimePermissionGranted)
                && (sdkInt < Build.VERSION_CODES.N || managerEnabled)
                && (sdkInt < Build.VERSION_CODES.O || channelEnabled);
    }

    private boolean canPresentNotifications(NotificationManager manager, String channel) {
        if (manager == null) return false;
        boolean runtimePermissionGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        boolean managerEnabled = Build.VERSION.SDK_INT < Build.VERSION_CODES.N
                || manager.areNotificationsEnabled();
        boolean channelEnabled = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel notificationChannel = manager.getNotificationChannel(channel);
            channelEnabled = notificationChannel != null
                    && notificationChannel.getImportance() != NotificationManager.IMPORTANCE_NONE;
        }
        return notificationDisplayAllowed(
                Build.VERSION.SDK_INT, runtimePermissionGranted, managerEnabled, channelEnabled);
    }

    private boolean showNotification(String title, String body, String channel, Uri deepLink,
                                     String lifecycleDeliveryId, int notificationId) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            String label = PROVIDER_ACCESS_CHANNEL.equals(channel)
                    ? "Provider access reminders"
                    : LIFECYCLE_CHANNEL.equals(channel) ? "Norva guidance" : "Catalog imports";
            nm.createNotificationChannel(new NotificationChannel(channel, label, NotificationManager.IMPORTANCE_HIGH));
        }
        if (!canPresentNotifications(nm, channel)) return false;
        Intent open = deepLink == null
                ? new Intent(this, MainActivity.class)
                : new Intent(Intent.ACTION_VIEW, deepLink, this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (lifecycleDeliveryId != null) {
            open.putExtra("norva_lifecycle_delivery_id", lifecycleDeliveryId);
        }
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pi = PendingIntent.getActivity(this, notificationId, open, piFlags);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, channel)
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(pi);
        try {
            nm.notify(notificationId, b.build());
            return true;
        } catch (SecurityException ignored) {
            // Permission can be revoked between the check and notify(). Never
            // report a lifecycle delivery that Android refused to display.
            return false;
        }
    }
}
