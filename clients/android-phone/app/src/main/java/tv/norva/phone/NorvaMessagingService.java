package tv.norva.phone;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * Firebase Cloud Messaging receiver. Two jobs:
 *  - onNewToken: cache the device's FCM token in a small prefs file. The WebView bridge
 *    (MainActivity.CloudBridge.getPushToken) reads it and the web app registers it with the backend.
 *  - onMessageReceived: show a notification when a push arrives in the FOREGROUND (background /
 *    app-closed "notification" messages are shown automatically by the system tray; onMessageReceived
 *    is not called then, so there's no double-show).
 */
public class NorvaMessagingService extends FirebaseMessagingService {
    static final String PREFS = "norva_push";
    static final String KEY_TOKEN = "fcm_token";
    private static final String CHANNEL = "norva_imports";

    @Override
    public void onNewToken(String token) {
        if (token == null) return;
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_TOKEN, token).apply();
    }

    @Override
    public void onMessageReceived(RemoteMessage msg) {
        RemoteMessage.Notification n = msg.getNotification();
        String title = (n != null && n.getTitle() != null) ? n.getTitle() : "Norva";
        String body = (n != null && n.getBody() != null) ? n.getBody() : "";
        showNotification(title, body);
    }

    private void showNotification(String title, String body) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Catalog imports", NotificationManager.IMPORTANCE_HIGH));
        }
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, piFlags);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(pi);
        nm.notify((int) (System.currentTimeMillis() % 100000), b.build());
    }
}
