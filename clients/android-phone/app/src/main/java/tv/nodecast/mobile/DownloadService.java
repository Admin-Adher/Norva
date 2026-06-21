package tv.nodecast.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.crypto.Cipher;

/**
 * Foreground service that downloads movies/episodes straight from the user's
 * HOME network — the same direct provider URL the native player uses, never the
 * cloud gateway — and writes them AES/CTR-encrypted into app-private external
 * storage (invisible to the gallery, unreadable off-device).
 *
 * The queue lives in {@link DownloadStore} (state == "queued", ordered by
 * queueOrder) so it survives process death and supports reorder/pause/cancel.
 * The active item is controlled in-memory via {@link #CONTROL}. A Wi-Fi-only
 * preference pauses downloads off Wi-Fi and resumes them when it returns.
 */
public final class DownloadService extends Service {

    static final String ACTION_ENQUEUE = "tv.nodecast.mobile.ENQUEUE";
    static final String EXTRA_ID = "id";
    static final String PREFS = "norva_downloads_prefs";
    static final String PREF_WIFI_ONLY = "wifi_only";

    static final int CTRL_PAUSE = 1;
    static final int CTRL_CANCEL = 2;
    /** Live control for the item currently downloading: PAUSE or CANCEL. */
    static final ConcurrentHashMap<String, Integer> CONTROL = new ConcurrentHashMap<>();
    static volatile String currentId = null;

    private static final String CHANNEL = "norva_downloads";
    private static final int NOTIF_ID = 4201;
    private static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

    private static final int R_DONE = 0, R_PAUSED = 1, R_CANCELED = 2,
            R_FAILED = 3, R_WIFI_WAIT = 4, R_STOP = 5;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean running = new AtomicBoolean(false);
    private volatile boolean stopRequested = false;
    // Static so it survives this service instance stopping (it waits for Wi-Fi to
    // return) and can be cleared by whichever instance next starts up.
    private static ConnectivityManager.NetworkCallback wifiWaiter;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startInForeground(buildNotification("Preparing downloads…", 0, 0, true));
        unregisterWifiWaiter();
        if (running.compareAndSet(false, true)) {
            worker.execute(this::drainQueue);
        }
        return START_STICKY;
    }

    private void drainQueue() {
        try {
            while (!stopRequested) {
                if (isWifiOnly() && !onWifi()) {
                    registerWifiWaiter();
                    break;
                }
                DownloadStore.Item item = nextQueued();
                if (item == null) break;
                currentId = item.id;
                int result = downloadOne(item);
                currentId = null;
                CONTROL.remove(item.id);
                if (result == R_WIFI_WAIT) {
                    registerWifiWaiter();
                    break;
                }
            }
        } finally {
            running.set(false);
            // Pick back up anything enqueued during the gap before we stop.
            if (!stopRequested && nextQueued() != null && !(isWifiOnly() && !onWifi())
                    && running.compareAndSet(false, true)) {
                worker.execute(this::drainQueue);
                return;
            }
            stopForeground(true);
            stopSelf();
        }
    }

    /** The next "queued" item by queueOrder (then createdAt). */
    // ---- Queue control (called from the native screen + the JS bridge) ----

    static void startFor(Context ctx, String id) {
        Intent svc = new Intent(ctx, DownloadService.class);
        svc.setAction(ACTION_ENQUEUE);
        if (id != null) svc.putExtra(EXTRA_ID, id);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(svc);
        else ctx.startService(svc);
    }

    static void requestPause(Context ctx, String id) {
        if (id == null) return;
        if (id.equals(currentId)) {
            CONTROL.put(id, CTRL_PAUSE);
        } else {
            DownloadStore.Item it = DownloadStore.get(ctx, id);
            if (it != null && "queued".equals(it.state)) {
                it.state = "paused";
                DownloadStore.put(ctx, it);
            }
        }
    }

    static void requestResume(Context ctx, String id) {
        DownloadStore.Item it = DownloadStore.get(ctx, id);
        if (it == null || "done".equals(it.state)) return;
        CONTROL.remove(id);
        it.state = "queued";
        it.error = "";
        DownloadStore.put(ctx, it);
        startFor(ctx, id);
    }

    /** Cancel = stop + remove the entry and delete its files (for real). */
    static void requestCancel(Context ctx, String id) {
        if (id == null) return;
        if (id.equals(currentId)) {
            CONTROL.put(id, CTRL_CANCEL); // the worker deletes file + entry on the next chunk
            return;
        }
        DownloadStore.Item it = DownloadStore.get(ctx, id);
        if (it != null) {
            try {
                if (it.filePath != null && !it.filePath.isEmpty()) new File(it.filePath).delete();
            } catch (Exception ignored) { }
        }
        try {
            File base = ctx.getExternalFilesDir(null);
            if (base == null) base = ctx.getFilesDir();
            new File(new File(base, "downloads"), safeName(id) + ".enc").delete();
        } catch (Exception ignored) { }
        try {
            new File(new File(ctx.getFilesDir(), "posters"), safeName(id) + ".jpg").delete();
        } catch (Exception ignored) { }
        DownloadStore.remove(ctx, id);
    }

    /** Move a queued item earlier (delta &lt; 0) or later (delta &gt; 0). */
    static void moveInQueue(Context ctx, String id, int delta) {
        java.util.List<DownloadStore.Item> q = new java.util.ArrayList<>();
        for (DownloadStore.Item it : DownloadStore.all(ctx)) {
            if ("queued".equals(it.state) || "paused".equals(it.state)) q.add(it);
        }
        java.util.Collections.sort(q, (a, b) -> Long.compare(orderOf(a), orderOf(b)));
        int idx = -1;
        for (int i = 0; i < q.size(); i++) {
            if (q.get(i).id.equals(id)) { idx = i; break; }
        }
        if (idx < 0) return;
        int j = idx + (delta < 0 ? -1 : 1);
        if (j < 0 || j >= q.size()) return;
        DownloadStore.Item a = q.get(idx), b = q.get(j);
        long ao = orderOf(a), bo = orderOf(b);
        a.queueOrder = bo;
        b.queueOrder = ao;
        DownloadStore.put(ctx, a);
        DownloadStore.put(ctx, b);
    }

    private static long orderOf(DownloadStore.Item it) {
        return it.queueOrder != 0 ? it.queueOrder : it.createdAt;
    }

    static boolean getWifiOnly(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(PREF_WIFI_ONLY, false);
    }

    static void setWifiOnly(Context ctx, boolean on) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(PREF_WIFI_ONLY, on).apply();
        if (!on) startFor(ctx, null); // resume anything that was waiting for Wi-Fi
    }

    private DownloadStore.Item nextQueued() {
        DownloadStore.Item best = null;
        for (DownloadStore.Item it : DownloadStore.all(this)) {
            if (!"queued".equals(it.state)) continue;
            if (best == null
                    || it.queueOrder < best.queueOrder
                    || (it.queueOrder == best.queueOrder && it.createdAt < best.createdAt)) {
                best = it;
            }
        }
        return best;
    }

    private int downloadOne(DownloadStore.Item itemIn) {
        DownloadStore.Item item = DownloadStore.get(this, itemIn.id);
        if (item == null) return R_CANCELED;
        if ("done".equals(item.state)) return R_DONE;
        if (item.url == null || item.url.isEmpty()) {
            fail(item, "Missing source URL");
            return R_FAILED;
        }

        maybeDownloadPoster(item); // owned by this thread, before the long media pull

        HttpURLConnection conn = null;
        RandomAccessFile out = null;
        try {
            File dir = downloadsDir();
            if (!dir.exists()) dir.mkdirs();
            File enc = new File(dir, safeName(item.id) + ".enc");
            item.filePath = enc.getAbsolutePath();

            byte[] dataKey = DownloadCrypto.unwrapDataKey(
                    DownloadCrypto.unb64(item.wrappedKey), DownloadCrypto.unb64(item.keyIv));
            byte[] mediaIv = DownloadCrypto.unb64(item.mediaIv);

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
            if (code == HttpURLConnection.HTTP_PARTIAL) {
                append = true;
                startOffset = resumeFrom;
            } else if (code == HttpURLConnection.HTTP_OK) {
                append = false;
                startOffset = 0;
            } else {
                throw new IOException("HTTP " + code);
            }

            long contentLen = parseContentLength(conn);
            long total = contentLen >= 0 ? startOffset + contentLen : 0;
            item.totalBytes = total;
            item.downloadedBytes = startOffset;
            item.state = "downloading";
            item.error = "";
            persist(item);

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
            while ((n = in.read(buf)) != -1) {
                Integer ctrl = CONTROL.get(item.id);
                if (ctrl != null && ctrl == CTRL_CANCEL) {
                    closeQuietly(out);
                    out = null;
                    enc.delete();
                    deletePoster(item.id);
                    DownloadStore.remove(this, item.id);
                    return R_CANCELED;
                }
                if (stopRequested || (ctrl != null && ctrl == CTRL_PAUSE)) {
                    byte[] tail = cipher.doFinal();
                    if (tail != null && tail.length > 0) out.write(tail);
                    item.downloadedBytes = written;
                    item.state = stopRequested ? "queued" : "paused";
                    persist(item);
                    return stopRequested ? R_STOP : R_PAUSED;
                }
                if (isWifiOnly() && !onWifi()) {
                    byte[] tail = cipher.doFinal();
                    if (tail != null && tail.length > 0) out.write(tail);
                    item.downloadedBytes = written;
                    item.state = "queued";
                    persist(item);
                    return R_WIFI_WAIT;
                }
                byte[] ct = cipher.update(buf, 0, n);
                if (ct != null && ct.length > 0) out.write(ct);
                written += n;
                long now = System.currentTimeMillis();
                if (now - lastPersist > 1000) {
                    lastPersist = now;
                    item.downloadedBytes = written;
                    persist(item);
                    int pct = total > 0 ? (int) (written * 100 / total) : 0;
                    notifyProgress(buildNotification("Downloading " + item.title, pct, 100, total <= 0));
                }
            }
            byte[] tail = cipher.doFinal();
            if (tail != null && tail.length > 0) out.write(tail);

            item.downloadedBytes = total > 0 ? total : written;
            item.totalBytes = item.downloadedBytes;
            item.state = "done";
            item.url = "";
            persist(item);
            return R_DONE;
        } catch (Exception e) {
            fail(item, String.valueOf(e.getMessage()));
            return R_FAILED;
        } finally {
            closeQuietly(out);
            if (conn != null) conn.disconnect();
        }
    }

    /** Fetch the poster once (unencrypted, app-private) so the library has art. */
    private void maybeDownloadPoster(DownloadStore.Item item) {
        if (item.posterUrl == null || item.posterUrl.isEmpty()) return;
        File out = new File(posterDir(), safeName(item.id) + ".jpg");
        if (out.exists() && out.length() > 0) {
            if (item.posterFile == null || item.posterFile.isEmpty()) {
                item.posterFile = out.getAbsolutePath();
            }
            return;
        }
        HttpURLConnection c = null;
        try {
            if (!posterDir().exists()) posterDir().mkdirs();
            c = (HttpURLConnection) new URL(item.posterUrl).openConnection();
            c.setRequestProperty("User-Agent", UA);
            c.setConnectTimeout(15000);
            c.setReadTimeout(20000);
            c.setInstanceFollowRedirects(true);
            if (c.getResponseCode() != HttpURLConnection.HTTP_OK) return;
            InputStream in = c.getInputStream();
            FileOutputStream fos = new FileOutputStream(out);
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) fos.write(buf, 0, n);
            fos.close();
            if (out.length() > 0) item.posterFile = out.getAbsolutePath();
        } catch (Exception ignored) {
            // Poster is best-effort.
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private void fail(DownloadStore.Item item, String message) {
        item.state = "failed";
        item.error = message;
        persist(item);
    }

    /** Persist, preserving a poster path that another writer may have set. */
    private void persist(DownloadStore.Item item) {
        if (item.posterFile == null || item.posterFile.isEmpty()) {
            DownloadStore.Item latest = DownloadStore.get(this, item.id);
            if (latest != null && latest.posterFile != null && !latest.posterFile.isEmpty()) {
                item.posterFile = latest.posterFile;
            }
        }
        DownloadStore.put(this, item);
    }

    // ---- Wi-Fi-only ----

    private boolean isWifiOnly() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(PREF_WIFI_ONLY, false);
    }

    private boolean onWifi() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            Network n = cm.getActiveNetwork();
            if (n == null) return false;
            NetworkCapabilities caps = cm.getNetworkCapabilities(n);
            if (caps == null) return false;
            return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                    || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
                    || caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
        } catch (Exception e) {
            return true;
        }
    }

    /** Resume downloads when an unmetered/Wi-Fi network returns. */
    private void registerWifiWaiter() {
        if (wifiWaiter != null) return;
        try {
            final ConnectivityManager cm =
                    (ConnectivityManager) getApplicationContext().getSystemService(CONNECTIVITY_SERVICE);
            if (cm == null) return;
            NetworkRequest req = new NetworkRequest.Builder()
                    .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                    .build();
            wifiWaiter = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    try {
                        Intent svc = new Intent(getApplicationContext(), DownloadService.class);
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            getApplicationContext().startForegroundService(svc);
                        } else {
                            getApplicationContext().startService(svc);
                        }
                    } catch (Exception ignored) {
                        // Background FGS start may be blocked; resumes on next app open.
                    }
                }
            };
            cm.registerNetworkCallback(req, wifiWaiter);
        } catch (Exception ignored) { }
    }

    private void unregisterWifiWaiter() {
        if (wifiWaiter == null) return;
        try {
            ConnectivityManager cm =
                    (ConnectivityManager) getApplicationContext().getSystemService(CONNECTIVITY_SERVICE);
            if (cm != null) cm.unregisterNetworkCallback(wifiWaiter);
        } catch (Exception ignored) { }
        wifiWaiter = null;
    }

    // ---- Files ----

    private File downloadsDir() {
        File base = getExternalFilesDir(null);
        if (base == null) base = getFilesDir();
        return new File(base, "downloads");
    }

    private File posterDir() {
        return new File(getFilesDir(), "posters");
    }

    private void deletePoster(String id) {
        try {
            new File(posterDir(), safeName(id) + ".jpg").delete();
        } catch (Exception ignored) { }
    }

    private static String safeName(String id) {
        return (id == null ? "x" : id.replaceAll("[^A-Za-z0-9_.-]", "_"));
    }

    private static void closeQuietly(RandomAccessFile f) {
        try {
            if (f != null) f.close();
        } catch (Exception ignored) { }
    }

    private static long parseContentLength(HttpURLConnection conn) {
        String h = conn.getHeaderField("Content-Length");
        if (h == null) return -1;
        try {
            return Long.parseLong(h.trim());
        } catch (NumberFormatException e) {
            return -1;
        }
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
