package tv.norva.phone;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Persistent manifest of offline downloads ({@code downloads.json} in
 * app-private internal storage). Holds the per-title metadata + the wrapped
 * data key; the encrypted media files themselves live in app-private external
 * storage. Reads/writes are serialised so the download service and the UI can
 * touch it concurrently.
 */
final class DownloadStore {

    private static final String FILE = "downloads.json";
    private static final Object LOCK = new Object();

    /** A single download. {@code url} holds provider credentials and is cleared once done. */
    static final class Item {
        String id;
        String sourceId;
        String itemId;
        String itemType = "movie";
        String title = "";
        String subtitle = "";
        int season = 0;       // series only; 0 when unknown
        int episodeNum = 0;   // series only; 0 when unknown
        String episodeTitle = "";
        String posterUrl = "";
        String posterFile = "";
        String container = "mp4";
        String url = "";
        String filePath = "";
        long totalBytes = 0;
        long downloadedBytes = 0;
        String state = "queued"; // queued | downloading | done | failed
        String error = "";
        String wrappedKey = "";
        String keyIv = "";
        String mediaIv = "";
        int durationSeconds = 0;
        long createdAt = System.currentTimeMillis();
        long queueOrder = 0; // lower = earlier in the queue (0 -> fall back to createdAt)
        boolean allowCellular = false; // user OK'd this one on mobile data despite Wi-Fi-only

        JSONObject toJson() throws Exception {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("sourceId", sourceId);
            o.put("itemId", itemId);
            o.put("itemType", itemType);
            o.put("title", title);
            o.put("subtitle", subtitle);
            o.put("season", season);
            o.put("episodeNum", episodeNum);
            o.put("episodeTitle", episodeTitle);
            o.put("posterUrl", posterUrl);
            o.put("posterFile", posterFile);
            o.put("container", container);
            o.put("url", url);
            o.put("filePath", filePath);
            o.put("totalBytes", totalBytes);
            o.put("downloadedBytes", downloadedBytes);
            o.put("state", state);
            o.put("error", error);
            o.put("wrappedKey", wrappedKey);
            o.put("keyIv", keyIv);
            o.put("mediaIv", mediaIv);
            o.put("durationSeconds", durationSeconds);
            o.put("createdAt", createdAt);
            o.put("queueOrder", queueOrder);
            o.put("allowCellular", allowCellular);
            return o;
        }

        static Item fromJson(JSONObject o) {
            Item it = new Item();
            it.id = o.optString("id");
            it.sourceId = o.optString("sourceId");
            it.itemId = o.optString("itemId");
            it.itemType = o.optString("itemType", "movie");
            it.title = o.optString("title");
            it.subtitle = o.optString("subtitle");
            it.season = o.optInt("season", 0);
            it.episodeNum = o.optInt("episodeNum", 0);
            it.episodeTitle = o.optString("episodeTitle");
            it.posterUrl = o.optString("posterUrl");
            it.posterFile = o.optString("posterFile");
            it.container = o.optString("container", "mp4");
            it.url = o.optString("url");
            it.filePath = o.optString("filePath");
            it.totalBytes = o.optLong("totalBytes");
            it.downloadedBytes = o.optLong("downloadedBytes");
            it.state = o.optString("state", "queued");
            it.error = o.optString("error");
            it.wrappedKey = o.optString("wrappedKey");
            it.keyIv = o.optString("keyIv");
            it.mediaIv = o.optString("mediaIv");
            it.durationSeconds = o.optInt("durationSeconds");
            it.createdAt = o.optLong("createdAt", System.currentTimeMillis());
            it.queueOrder = o.optLong("queueOrder", it.createdAt);
            it.allowCellular = o.optBoolean("allowCellular", false);
            return it;
        }
    }

    private DownloadStore() { }

    static List<Item> all(Context ctx) {
        synchronized (LOCK) {
            List<Item> list = new ArrayList<>();
            File f = new File(ctx.getFilesDir(), FILE);
            if (!f.exists()) return list;
            try {
                JSONArray arr = new JSONArray(readFile(f));
                for (int i = 0; i < arr.length(); i++) {
                    list.add(Item.fromJson(arr.getJSONObject(i)));
                }
            } catch (Exception ignored) { /* corrupt manifest -> empty */ }
            return list;
        }
    }

    static Item get(Context ctx, String id) {
        if (id == null) return null;
        for (Item it : all(ctx)) {
            if (id.equals(it.id)) return it;
        }
        return null;
    }

    static void put(Context ctx, Item item) {
        synchronized (LOCK) {
            List<Item> list = all(ctx);
            boolean replaced = false;
            for (int i = 0; i < list.size(); i++) {
                if (list.get(i).id != null && list.get(i).id.equals(item.id)) {
                    list.set(i, item);
                    replaced = true;
                    break;
                }
            }
            if (!replaced) list.add(item);
            save(ctx, list);
        }
    }

    static void remove(Context ctx, String id) {
        synchronized (LOCK) {
            List<Item> kept = new ArrayList<>();
            for (Item it : all(ctx)) {
                if (!it.id.equals(id)) kept.add(it);
            }
            save(ctx, kept);
        }
    }

    private static void save(Context ctx, List<Item> list) {
        try {
            JSONArray arr = new JSONArray();
            for (Item it : list) arr.put(it.toJson());
            File f = new File(ctx.getFilesDir(), FILE);
            FileOutputStream out = new FileOutputStream(f, false);
            out.write(arr.toString().getBytes("UTF-8"));
            out.close();
        } catch (Exception ignored) { /* best-effort persistence */ }
    }

    private static String readFile(File f) throws Exception {
        FileInputStream in = new FileInputStream(f);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        in.close();
        return out.toString("UTF-8");
    }
}
