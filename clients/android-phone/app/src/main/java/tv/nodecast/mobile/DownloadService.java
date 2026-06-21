package tv.nodecast.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.crypto.Cipher;

/**
 * Foreground service that downloads a movie straight from the user's HOME
 * network — the same direct provider URL the native player uses, never the
 * cloud gateway — and writes it AES/CTR-encrypted into app-private external
 * storage. The file therefore never appears in the gallery and can't be read
 * off the device. Downloads run sequentially and resume from a block-aligned
 * offset if interrupted (CTR makes mid-stream resume trivial).
 */
public final class DownloadService extends Service {

    static final String ACTION_ENQUEUE = "tv.nodecast.mobile.ENQUEUE";
    static final String EXTRA_ID = "id";

    private static final String CHANNEL = "norva_downloads";
    private static final int NOTIF_ID = 4201;
    private static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

    private static final ConcurrentLinkedQueue<String> QUEUE = new ConcurrentLinkedQueue<>();
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean running = new AtomicBoolean(false);
    private volatile boolean stopRequested = false;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startInForeground(buildNotification("Preparing downloads…", 0, 0, true));
        if (intent != null) {
            String id = intent.getStringExtra(EXTRA_ID);
            if (id != null && !id.isEmpty() && !QUEUE.contains(id)) QUEUE.add(id);
        }
        // Pick up any queued / interrupted items left in the store (e.g. after a
        // process death) so the queue self-heals on the next start.
        for (DownloadStore.Item it : DownloadStore.all(this)) {
            if (("queued".equals(it.state) || "downloading".equals(it.state)) && !QUEUE.contains(it.id)) {
                QUEUE.add(it.id);
            }
        }
        if (running.compareAndSet(false, true)) {
            worker.execute(this::drainQueue);
        }
        return START_STICKY;
    }

    private void drainQueue() {
        try {
            String id;
            while (!stopRequested && (id = QUEUE.poll()) != null) {
                processOne(id);
            }
        } finally {
            running.set(false);
            // An item enqueued during the tiny gap between the loop ending and
            // this flag clearing would otherwise stall — pick it back up.
            if (!stopRequested && !QUEUE.isEmpty() && running.compareAndSet(false, true)) {
                worker.execute(this::drainQueue);
                return;
            }
            stopForeground(true);
            stopSelf();
        }
    }

    private void processOne(String id) {
        DownloadStore.Item item = DownloadStore.get(this, id);
        if (item == null || "done".equals(item.state)) return;
        if (item.url == null || item.url.isEmpty()) {
            fail(item, "Missing source URL");
            return;
        }
        HttpURLConnection conn = null;
        RandomAccessFile out = null;
        try {
            File dir = downloadsDir();
            if (!dir.exists()) dir.mkdirs();
            File enc = new File(dir, id.replaceAll("[^A-Za-z0-9_.-]", "_") + ".enc");
            item.filePath = enc.getAbsolutePath();

            byte[] dataKey = DownloadCrypto.unwrapDataKey(
                    DownloadCrypto.unb64(item.wrappedKey), DownloadCrypto.unb64(item.keyIv));
            byte[] mediaIv = DownloadCrypto.unb64(item.mediaIv);

            // Resume from a 16-byte-aligned offset if a partial file exists.
            long have = enc.exists() ? enc.length() : 0;
            long resumeFrom = (have / 16) * 16;

            conn = (HttpURLConnection) new URL(item.url).openConnection();
            conn.setRequestProperty("User-Agent", UA);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(40000);
            conn.setInstanceFollowRedirects(true);
            if (resumeFrom > 0) conn.setRequestProperty("Range", "bytes=" + resumeFrom + "-");
            conn.connect();
            int code = conn.getResponseCode();

            boolean append;
            long startOffset;
            if (code == HttpURLConnection.HTTP_PARTIAL) {   // 206 — provider honoured Range
                append = true;
                startOffset = resumeFrom;
            } else if (code == HttpURLConnection.HTTP_OK) { // 200 — full body, restart
                append = false;
                startOffset = 0;
            } else {
                throw new IOException("HTTP " + code);
            }

            long contentLen = parseContentLength(conn); // header parse: getContentLengthLong is API 24+
            long total = contentLen >= 0 ? startOffset + contentLen : 0;
            item.totalBytes = total;
            item.downloadedBytes = startOffset;
            item.state = "downloading";
            item.error = "";
            DownloadStore.put(this, item);

            out = new RandomAccessFile(enc, "rw");
            if (!append) out.setLength(0);
            out.seek(startOffset);

            Cipher cipher = DownloadCrypto.mediaCipher(
                    Cipher.ENCRYPT_MODE, dataKey, mediaIv, startOffset);

            InputStream in = conn.getInputStream();
            byte[] buf = new byte[64 * 1024];
            long written = startOffset;
            long lastPersist = System.currentTimeMillis();
            int n;
            while (!stopRequested && (n = in.read(buf)) != -1) {
                byte[] ct = cipher.update(buf, 0, n);
                if (ct != null && ct.length > 0) out.write(ct);
                written += n;
                long now = System.currentTimeMillis();
                if (now - lastPersist > 1000) {
                    lastPersist = now;
                    item.downloadedBytes = written;
                    DownloadStore.put(this, item);
                    int pct = total > 0 ? (int) (written * 100 / total) : 0;
                    notifyProgress(buildNotification("Downloading " + item.title, pct, 100, total <= 0));
                }
            }
            byte[] tail = cipher.doFinal();
            if (tail != null && tail.length > 0) out.write(tail);

            if (stopRequested) {
                item.downloadedBytes = written;
                item.state = "queued"; // resume on the next service start
                DownloadStore.put(this, item);
                return;
            }

            item.downloadedBytes = total > 0 ? total : written;
            item.totalBytes = item.downloadedBytes;
            item.state = "done";
            item.url = ""; // don't keep provider credentials once finished
            DownloadStore.put(this, item);
        } catch (Exception e) {
            fail(item, String.valueOf(e.getMessage()));
        } finally {
            try {
                if (out != null) out.close();
            } catch (Exception ignored) { }
            if (conn != null) conn.disconnect();
        }
    }

    private void fail(DownloadStore.Item item, String message) {
        item.state = "failed";
        item.error = message;
        DownloadStore.put(this, item);
    }

    /** Content-Length via header parse (HttpURLConnection.getContentLengthLong is API 24+). */
    private static long parseContentLength(HttpURLConnection conn) {
        String h = conn.getHeaderField("Content-Length");
        if (h == null) return -1;
        try {
            return Long.parseLong(h.trim());
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private File downloadsDir() {
        File base = getExternalFilesDir(null);
        if (base == null) base = getFilesDir(); // external unavailable -> internal
        return new File(base, "downloads");
    }

    // ---- Notification ----

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL, "Downloads", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    private Notification buildNotification(String text, int progress, int max, boolean indeterminate) {
        Intent open = new Intent(this, DownloadsActivity.class);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
                .setContentTitle("Norva")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(PendingIntent.getActivity(this, 0, open, piFlags));
        if (max > 0 || indeterminate) b.setProgress(max, progress, indeterminate);
        return b.build();
    }

    private void startInForeground(Notification n) {
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }

    private void notifyProgress(Notification n) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NOTIF_ID, n);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopRequested = true;
        worker.shutdownNow();
        super.onDestroy();
    }
}
