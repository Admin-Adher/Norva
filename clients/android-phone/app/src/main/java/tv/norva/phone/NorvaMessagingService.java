package tv.norva.phone;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

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
    private static final String IMPORT_CHANNEL = "norva_imports";
    private static final String PROVIDER_ACCESS_CHANNEL = "norva_provider_access";
    private static final String PROVIDER_ACCESS_LINK = "https://norva.tv/app.html?mobile=1#settings/sources";
    private static final int MAX_SEEN_PROVIDER_ACCESS = 64;

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
        RemoteMessage.Notification n = msg.getNotification();
        String title = (n != null && n.getTitle() != null) ? n.getTitle() : "Norva";
        String body = (n != null && n.getBody() != null) ? n.getBody() : "";
        showNotification(title, body, IMPORT_CHANNEL, null, (int) (System.currentTimeMillis() % 100000));
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
        showNotification(title, body, PROVIDER_ACCESS_CHANNEL, Uri.parse(PROVIDER_ACCESS_LINK), notificationId.hashCode());
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

    private void showNotification(String title, String body, String channel, Uri deepLink, int notificationId) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            String label = PROVIDER_ACCESS_CHANNEL.equals(channel) ? "Provider access reminders" : "Catalog imports";
            nm.createNotificationChannel(new NotificationChannel(channel, label, NotificationManager.IMPORTANCE_HIGH));
        }
        Intent open = deepLink == null
                ? new Intent(this, MainActivity.class)
                : new Intent(Intent.ACTION_VIEW, deepLink, this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
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
        nm.notify(notificationId, b.build());
    }
}
