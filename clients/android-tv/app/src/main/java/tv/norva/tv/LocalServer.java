package tv.norva.tv;

import android.content.Context;
import android.content.res.AssetManager;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Standalone mode backend: a tiny HTTP server on 127.0.0.1 that
 *  - serves the embedded Norva web app from APK assets (assets/www),
 *  - implements the small API surface the frontend needs (sources,
 *    favorites, history, settings, auth stub) backed by JSON files,
 *  - relays Xtream player_api calls directly to the provider (the WebView
 *    itself can't, because providers don't send CORS headers).
 *
 * This gives the TV the exact same UI as the desktop app with no PC
 * required. Heavy server features (transcoding, TMDB enrichment, EPG
 * parsing) are not available in this mode; playback is handed to the
 * native Android player which decodes MKV/AC3 natively.
 */
public class LocalServer {

    public static final int PORT = 8765;
    private static final String UA = "Mozilla/5.0 (Linux; Android TV) NorvaTV-Standalone/3.1";
    private static final long PROVIDER_CACHE_MS = 10 * 60 * 1000L;

    private static LocalServer instance;

    private final Context context;
    private ServerSocket serverSocket;
    private Thread acceptThread;
    private volatile boolean running = false;

    // sourceId -> cached provider responses (urlKey -> [timestamp, bytes])
    private final Map<String, Object[]> providerCache = new HashMap<>();

    private LocalServer(Context context) {
        this.context = context.getApplicationContext();
    }

    public static synchronized LocalServer get(Context context) {
        if (instance == null) instance = new LocalServer(context);
        return instance;
    }

    public synchronized void start() throws IOException {
        if (running) return;
        serverSocket = new ServerSocket(PORT, 16, InetAddress.getByName("127.0.0.1"));
        running = true;
        acceptThread = new Thread(new Runnable() {
            @Override
            public void run() {
                while (running) {
                    try {
                        final Socket client = serverSocket.accept();
                        new Thread(new Runnable() {
                            @Override
                            public void run() {
                                handle(client);
                            }
                        }).start();
                    } catch (IOException e) {
                        if (running) android.util.Log.w("LocalServer", "accept failed", e);
                    }
                }
            }
        }, "norva-local-server");
        acceptThread.setDaemon(true);
        acceptThread.start();
        android.util.Log.i("LocalServer", "Standalone server listening on 127.0.0.1:" + PORT);
    }

    // ==================== HTTP plumbing ====================

    private void handle(Socket client) {
        try (Socket c = client) {
            c.setSoTimeout(30000);
            InputStream in = c.getInputStream();
            OutputStream out = c.getOutputStream();

            BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
            String requestLine = reader.readLine();
            if (requestLine == null) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0];
            String fullPath = parts[1];

            int contentLength = 0;
            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                int idx = line.indexOf(':');
                if (idx > 0 && line.substring(0, idx).trim().equalsIgnoreCase("content-length")) {
                    contentLength = Integer.parseInt(line.substring(idx + 1).trim());
                }
            }
            String body = "";
            if (contentLength > 0) {
                char[] buf = new char[contentLength];
                int read = 0;
                while (read < contentLength) {
                    int n = reader.read(buf, read, contentLength - read);
                    if (n < 0) break;
                    read += n;
                }
                body = new String(buf, 0, read);
            }

            String path = fullPath;
            Map<String, String> query = new HashMap<>();
            int qIdx = fullPath.indexOf('?');
            if (qIdx >= 0) {
                path = fullPath.substring(0, qIdx);
                for (String pair : fullPath.substring(qIdx + 1).split("&")) {
                    int eq = pair.indexOf('=');
                    if (eq > 0) {
                        query.put(URLDecoder.decode(pair.substring(0, eq), "UTF-8"),
                                URLDecoder.decode(pair.substring(eq + 1), "UTF-8"));
                    }
                }
            }

            try {
                route(method, path, query, body, out);
            } catch (Exception e) {
                android.util.Log.w("LocalServer", "route error " + path, e);
                sendJson(out, 500, new JSONObject().put("error", String.valueOf(e.getMessage())).toString());
            }
        } catch (Exception ignored) {
        }
    }

    private void route(String method, String path, Map<String, String> q, String body, OutputStream out) throws Exception {
        if (path.startsWith("/api/")) {
            api(method, path.substring(4), q, body, out);
        } else {
            serveAsset(path, out);
        }
    }

    // ==================== API ====================

    private void api(String method, String path, Map<String, String> q, String body, OutputStream out) throws Exception {
        // --- auth (standalone: single implicit admin) ---
        if (path.equals("/auth/me")) {
            sendJson(out, 200, "{\"id\":1,\"username\":\"TV\",\"role\":\"admin\"}");
        } else if (path.startsWith("/auth/users")) {
            sendJson(out, 200, method.equals("GET") ? "[]" : "{\"success\":true}");
        } else if (path.startsWith("/auth/")) {
            sendJson(out, 200, "{\"success\":true}");

        } else if (path.equals("/version")) {
            sendJson(out, 200, "{\"version\":\"3.1.0-standalone\"}");

        // --- settings ---
        } else if (path.equals("/settings") && method.equals("GET")) {
            sendJson(out, 200, settingsWithDefaults().toString());
        } else if (path.equals("/settings") && method.equals("PUT")) {
            JSONObject store = loadObj("settings.json");
            JSONObject updates = new JSONObject(body);
            for (java.util.Iterator<String> it = updates.keys(); it.hasNext(); ) {
                String k = it.next();
                store.put(k, updates.get(k));
            }
            saveObj("settings.json", store);
            sendJson(out, 200, settingsWithDefaults().toString());
        } else if (path.startsWith("/settings")) {
            if (path.endsWith("/sync-status")) sendJson(out, 200, "{\"lastSyncTime\":null}");
            else sendJson(out, 200, "{}");

        } else if (path.startsWith("/tmdb")) {
            if (path.endsWith("/status")) {
                sendJson(out, 200, "{\"running\":false,\"total\":0,\"processed\":0,\"matched\":0,\"failed\":0,\"startedAt\":null,\"finishedAt\":null}");
            } else {
                sendJson(out, 200, "{\"started\":false,\"reason\":\"standalone\"}");
            }

        // --- sources ---
        } else if (path.equals("/sources") && method.equals("GET")) {
            sendJson(out, 200, loadArr("sources.json").toString());
        } else if (path.equals("/sources") && method.equals("POST")) {
            JSONArray sources = loadArr("sources.json");
            JSONObject src = new JSONObject(body);
            int nextId = 1;
            for (int i = 0; i < sources.length(); i++) {
                nextId = Math.max(nextId, sources.getJSONObject(i).optInt("id", 0) + 1);
            }
            src.put("id", nextId);
            src.put("enabled", true);
            sources.put(src);
            saveArr("sources.json", sources);
            sendJson(out, 200, src.toString());
        } else if (path.equals("/sources/status")) {
            sendJson(out, 200, "[]");
        } else if (path.startsWith("/sources/type/")) {
            String type = path.substring("/sources/type/".length());
            JSONArray result = new JSONArray();
            JSONArray sources = loadArr("sources.json");
            for (int i = 0; i < sources.length(); i++) {
                JSONObject s = sources.getJSONObject(i);
                if (type.equals(s.optString("type")) && s.optBoolean("enabled", true)) result.put(s);
            }
            sendJson(out, 200, result.toString());
        } else if (path.startsWith("/sources/")) {
            handleSourceById(method, path, body, out);

        // --- favorites ---
        } else if (path.equals("/favorites/check")) {
            boolean fav = findFavorite(q.get("sourceId"), q.get("itemId"), q.get("itemType")) >= 0;
            sendJson(out, 200, "{\"isFavorite\":" + fav + "}");
        } else if (path.equals("/favorites") && method.equals("GET")) {
            JSONArray favs = loadArr("favorites.json");
            JSONArray result = new JSONArray();
            for (int i = 0; i < favs.length(); i++) {
                JSONObject f = favs.getJSONObject(i);
                if (q.containsKey("sourceId") && f.optInt("source_id") != Integer.parseInt(q.get("sourceId"))) continue;
                if (q.containsKey("itemType") && !q.get("itemType").equals(f.optString("item_type"))) continue;
                result.put(f);
            }
            sendJson(out, 200, result.toString());
        } else if (path.equals("/favorites")) {
            JSONObject req = new JSONObject(body);
            JSONArray favs = loadArr("favorites.json");
            int existing = findFavorite(req.optString("sourceId"), req.optString("itemId"), req.optString("itemType", "channel"));
            if (method.equals("POST") && existing < 0) {
                favs.put(new JSONObject()
                        .put("source_id", req.optInt("sourceId"))
                        .put("item_id", req.optString("itemId"))
                        .put("item_type", req.optString("itemType", "channel")));
                saveArr("favorites.json", favs);
            } else if (method.equals("DELETE") && existing >= 0) {
                favs.remove(existing);
                saveArr("favorites.json", favs);
            }
            sendJson(out, 200, "{\"success\":true}");

        // --- watch history ---
        } else if (path.equals("/history") && method.equals("GET")) {
            sendJson(out, 200, loadArr("history.json").toString());
        } else if (path.equals("/history") && method.equals("POST")) {
            JSONObject req = new JSONObject(body);
            String itemId = String.valueOf(req.opt("id"));
            JSONArray history = loadArr("history.json");
            JSONArray updated = new JSONArray();
            JSONObject entry = new JSONObject()
                    .put("id", "1:" + itemId)
                    .put("user_id", 1)
                    .put("source_id", req.opt("sourceId"))
                    .put("item_type", req.optString("type", "movie"))
                    .put("item_id", itemId)
                    .put("parent_id", req.opt("parentId"))
                    .put("progress", req.optInt("progress"))
                    .put("duration", req.optInt("duration"))
                    .put("updated_at", System.currentTimeMillis())
                    .put("data", req.optJSONObject("data") != null ? req.optJSONObject("data") : new JSONObject());
            updated.put(entry);
            for (int i = 0; i < history.length() && updated.length() < 100; i++) {
                JSONObject h = history.getJSONObject(i);
                if (!itemId.equals(h.optString("item_id"))) updated.put(h);
            }
            saveArr("history.json", updated);
            sendJson(out, 200, "{\"success\":true}");
        } else if (path.startsWith("/history/") && method.equals("DELETE")) {
            String itemId = path.substring("/history/".length());
            JSONArray history = loadArr("history.json");
            JSONArray updated = new JSONArray();
            for (int i = 0; i < history.length(); i++) {
                JSONObject h = history.getJSONObject(i);
                if (!itemId.equals(h.optString("item_id"))) updated.put(h);
            }
            saveArr("history.json", updated);
            sendJson(out, 200, "{\"success\":true}");

        // --- hidden items ---
        } else if (path.equals("/channels/hidden")) {
            JSONArray hidden = loadArr("hidden.json");
            JSONArray result = new JSONArray();
            for (int i = 0; i < hidden.length(); i++) {
                JSONObject h = hidden.getJSONObject(i);
                if (q.containsKey("sourceId") && h.optInt("source_id") != Integer.parseInt(q.get("sourceId"))) continue;
                result.put(h);
            }
            sendJson(out, 200, result.toString());
        } else if (path.equals("/channels/hide") || path.equals("/channels/show")) {
            JSONObject req = new JSONObject(body);
            toggleHidden(req.optInt("sourceId"), req.optString("itemType"), String.valueOf(req.opt("itemId")), path.endsWith("/hide"));
            sendJson(out, 200, "{\"success\":true}");
        } else if (path.startsWith("/channels/")) {
            sendJson(out, 200, "{\"success\":true}");

        // --- playback health ---
        } else if (path.equals("/playback-status") && method.equals("GET")) {
            handlePlaybackStatusGet(q, out);
        } else if (path.equals("/playback-status/report") && method.equals("POST")) {
            handlePlaybackStatusReport(body, out);

        // --- Xtream relay ---
        } else if (path.startsWith("/proxy/xtream/")) {
            handleXtream(path.substring("/proxy/xtream/".length()), q, out);

        } else if (path.startsWith("/proxy/image")) {
            relayBinary(q.get("url"), out);
        } else if (path.startsWith("/proxy/epg")) {
            sendJson(out, 200, "{\"channels\":[],\"programmes\":[]}");
        } else if (path.startsWith("/epg")) {
            sendJson(out, 200, "{}");
        } else if (path.startsWith("/probe")) {
            sendJson(out, 200, "{\"compatible\":true,\"needsTranscode\":false,\"needsRemux\":false,\"duration\":null,\"video\":\"h264\",\"audio\":\"aac\",\"subtitles\":[]}");
        } else {
            sendJson(out, 404, "{\"error\":\"Not available in standalone mode\"}");
        }
    }

    private void handleSourceById(String method, String path, String body, OutputStream out) throws Exception {
        String[] segs = path.split("/"); // "", "sources", ":id"[, action]
        int id = Integer.parseInt(segs[2]);
        String action = segs.length > 3 ? segs[3] : null;
        JSONArray sources = loadArr("sources.json");
        int idx = -1;
        for (int i = 0; i < sources.length(); i++) {
            if (sources.getJSONObject(i).optInt("id") == id) { idx = i; break; }
        }
        if (idx < 0) { sendJson(out, 404, "{\"error\":\"Source not found\"}"); return; }
        JSONObject src = sources.getJSONObject(idx);

        if (action == null && method.equals("GET")) {
            sendJson(out, 200, src.toString());
        } else if (action == null && method.equals("PUT")) {
            JSONObject updates = new JSONObject(body);
            for (java.util.Iterator<String> it = updates.keys(); it.hasNext(); ) {
                String k = it.next();
                src.put(k, updates.get(k));
            }
            saveArr("sources.json", sources);
            sendJson(out, 200, src.toString());
        } else if (action == null && method.equals("DELETE")) {
            sources.remove(idx);
            saveArr("sources.json", sources);
            sendJson(out, 200, "{\"success\":true}");
        } else if ("toggle".equals(action)) {
            src.put("enabled", !src.optBoolean("enabled", true));
            saveArr("sources.json", sources);
            sendJson(out, 200, src.toString());
        } else if ("test".equals(action) || "sync".equals(action)) {
            sendJson(out, 200, "{\"success\":true}");
        } else if ("estimate".equals(action)) {
            sendJson(out, 200, "{}");
        } else {
            sendJson(out, 200, "{\"success\":true}");
        }
    }

    /**
     * /proxy/xtream/:sourceId/<action or stream/:id/:type>
     * Relays player_api calls straight to the provider (with caching).
     */
    private void handleXtream(String rest, Map<String, String> q, OutputStream out) throws Exception {
        String[] segs = rest.split("/");
        int sourceId = Integer.parseInt(segs[0]);
        JSONObject src = findSource(sourceId);
        if (src == null) { sendJson(out, 404, "{\"error\":\"Source not found\"}"); return; }

        String base = src.optString("url").replaceAll("/+$", "");
        String user = URLEncoder.encode(src.optString("username"), "UTF-8");
        String pass = URLEncoder.encode(src.optString("password"), "UTF-8");

        // Stream URL builder: /stream/:streamId/:type
        if (segs.length >= 3 && "stream".equals(segs[1])) {
            String streamId = segs[2];
            String type = segs.length > 3 ? segs[3] : "live";
            String container = q.containsKey("container") ? q.get("container") : "m3u8";
            String kind = "movie".equals(type) ? "movie" : ("series".equals(type) ? "series" : "live");
            String url = base + "/" + kind + "/" + user + "/" + pass + "/" + streamId + "." + container;
            sendJson(out, 200, new JSONObject().put("url", url).toString());
            return;
        }

        String action = segs[1];
        String apiAction;
        StringBuilder extra = new StringBuilder();
        switch (action) {
            case "auth": apiAction = null; break;
            case "live_categories": apiAction = "get_live_categories"; break;
            case "live_streams": apiAction = "get_live_streams"; break;
            case "vod_categories": apiAction = "get_vod_categories"; break;
            case "vod_streams": apiAction = "get_vod_streams"; break;
            case "series_categories": apiAction = "get_series_categories"; break;
            case "series": apiAction = "get_series"; break;
            case "series_info": apiAction = "get_series_info"; break;
            case "vod_info": apiAction = "get_vod_info"; break;
            case "short_epg": apiAction = "get_short_epg"; break;
            default:
                sendJson(out, 400, "{\"error\":\"Unknown action\"}");
                return;
        }
        if (q.containsKey("category_id")) extra.append("&category_id=").append(URLEncoder.encode(q.get("category_id"), "UTF-8"));
        if (q.containsKey("series_id")) extra.append("&series_id=").append(URLEncoder.encode(q.get("series_id"), "UTF-8"));
        if (q.containsKey("vod_id")) extra.append("&vod_id=").append(URLEncoder.encode(q.get("vod_id"), "UTF-8"));
        if (q.containsKey("stream_id")) extra.append("&stream_id=").append(URLEncoder.encode(q.get("stream_id"), "UTF-8"));

        String url = base + "/player_api.php?username=" + user + "&password=" + pass
                + (apiAction != null ? "&action=" + apiAction : "") + extra;

        byte[] data = fetchWithCache(url, !"get_series_info".equals(apiAction) && !"get_short_epg".equals(apiAction));
        sendBytes(out, 200, "application/json", data);
    }

    private byte[] fetchWithCache(String url, boolean cacheable) throws IOException {
        synchronized (providerCache) {
            Object[] cached = providerCache.get(url);
            if (cacheable && cached != null && System.currentTimeMillis() - (long) cached[0] < PROVIDER_CACHE_MS) {
                return (byte[]) cached[1];
            }
        }
        byte[] data = httpGet(url);
        if (cacheable) {
            synchronized (providerCache) {
                if (providerCache.size() > 60) providerCache.clear();
                providerCache.put(url, new Object[]{System.currentTimeMillis(), data});
            }
        }
        return data;
    }

    private byte[] httpGet(String url) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(60000);
        conn.setRequestProperty("User-Agent", UA);
        conn.setInstanceFollowRedirects(true);
        try {
            int code = conn.getResponseCode();
            InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (in == null) return ("{\"error\":\"HTTP " + code + "\"}").getBytes(StandardCharsets.UTF_8);
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        } finally {
            conn.disconnect();
        }
    }

    private void relayBinary(String url, OutputStream out) {
        try {
            byte[] data = httpGet(url);
            sendBytes(out, 200, "image/png", data);
        } catch (Exception e) {
            try { sendJson(out, 502, "{\"error\":\"image relay failed\"}"); } catch (IOException ignored) {}
        }
    }

    // ==================== JSON file store ====================

    private JSONObject settingsWithDefaults() {
        JSONObject store = loadObj("settings.json");
        try {
            if (!store.has("autoTranscode")) store.put("autoTranscode", false);
            if (!store.has("forceProxy")) store.put("forceProxy", false);
            if (!store.has("streamFormat")) store.put("streamFormat", "m3u8");
            if (!store.has("groupDuplicates")) store.put("groupDuplicates", true);
            if (!store.has("preferredQuality")) store.put("preferredQuality", "highest");
            if (!store.has("preferredLanguage")) store.put("preferredLanguage", "");
            if (!store.has("tmdbApiKey")) store.put("tmdbApiKey", "");
            if (!store.has("epgRefreshInterval")) store.put("epgRefreshInterval", "24");
            if (!store.has("autoPlayNextEpisode")) store.put("autoPlayNextEpisode", false);
            if (!store.has("arrowKeysChangeChannel")) store.put("arrowKeysChangeChannel", true);
            if (!store.has("overlayDuration")) store.put("overlayDuration", 5);
            if (!store.has("defaultVolume")) store.put("defaultVolume", 80);
            if (!store.has("rememberVolume")) store.put("rememberVolume", true);
        } catch (Exception ignored) {}
        return store;
    }

    private JSONObject findSource(int id) {
        try {
            JSONArray sources = loadArr("sources.json");
            for (int i = 0; i < sources.length(); i++) {
                if (sources.getJSONObject(i).optInt("id") == id) return sources.getJSONObject(i);
            }
        } catch (Exception ignored) {}
        return null;
    }

    private int findFavorite(String sourceId, String itemId, String itemType) {
        try {
            JSONArray favs = loadArr("favorites.json");
            for (int i = 0; i < favs.length(); i++) {
                JSONObject f = favs.getJSONObject(i);
                if (String.valueOf(f.optInt("source_id")).equals(String.valueOf(sourceId))
                        && f.optString("item_id").equals(String.valueOf(itemId))
                        && f.optString("item_type").equals(itemType == null ? "channel" : itemType)) {
                    return i;
                }
            }
        } catch (Exception ignored) {}
        return -1;
    }

    private void toggleHidden(int sourceId, String itemType, String itemId, boolean hide) throws Exception {
        JSONArray hidden = loadArr("hidden.json");
        JSONArray updated = new JSONArray();
        boolean exists = false;
        for (int i = 0; i < hidden.length(); i++) {
            JSONObject h = hidden.getJSONObject(i);
            boolean match = h.optInt("source_id") == sourceId
                    && h.optString("item_type").equals(itemType)
                    && h.optString("item_id").equals(itemId);
            if (match) { exists = true; if (hide) updated.put(h); }
            else updated.put(h);
        }
        if (hide && !exists) {
            updated.put(new JSONObject().put("source_id", sourceId).put("item_type", itemType).put("item_id", itemId));
        }
        saveArr("hidden.json", updated);
    }

    private void handlePlaybackStatusGet(Map<String, String> q, OutputStream out) throws Exception {
        JSONArray statuses = loadArr("playback-status.json");
        JSONArray result = new JSONArray();
        for (int i = 0; i < statuses.length(); i++) {
            JSONObject s = statuses.getJSONObject(i);
            if (q.containsKey("sourceId") && s.optInt("source_id") != Integer.parseInt(q.get("sourceId"))) continue;
            if (q.containsKey("itemType") && !q.get("itemType").equals(s.optString("item_type"))) continue;
            if (!"true".equals(q.get("includeOk")) && !"broken".equals(s.optString("status"))) continue;
            result.put(s);
        }
        sendJson(out, 200, result.toString());
    }

    private void handlePlaybackStatusReport(String body, OutputStream out) throws Exception {
        JSONObject req = new JSONObject(body);
        int sourceId = req.optInt("sourceId", req.optInt("source_id", 0));
        String itemType = req.optString("itemType", req.optString("item_type", ""));
        String itemId = String.valueOf(req.has("itemId") ? req.opt("itemId") : req.opt("item_id"));
        String status = req.optString("status", "");
        String reason = req.optString("reason", req.optString("error", ""));

        if (sourceId <= 0 || itemType.length() == 0 || itemId.length() == 0
                || (!"ok".equals(status) && !"broken".equals(status))) {
            sendJson(out, 400, "{\"error\":\"Invalid playback status report\"}");
            return;
        }
        if ("broken".equals(status) && reason.toLowerCase(Locale.ROOT).contains("empty src")) {
            sendJson(out, 200, "{\"success\":true,\"ignored\":true,\"reason\":\"empty-src\"}");
            return;
        }

        JSONArray statuses = loadArr("playback-status.json");
        int idx = findPlaybackStatus(statuses, sourceId, itemType, itemId);
        JSONObject entry = idx >= 0 ? statuses.getJSONObject(idx) : new JSONObject()
                .put("source_id", sourceId)
                .put("item_type", itemType)
                .put("item_id", itemId);

        entry.put("status", status);
        entry.put("updated_at", System.currentTimeMillis());
        if ("broken".equals(status)) {
            entry.put("failures", entry.optInt("failures", 0) + 1);
            entry.put("last_error", reason);
        } else {
            entry.put("failures", 0);
            entry.remove("last_error");
        }

        if (idx < 0) statuses.put(entry);
        saveArr("playback-status.json", statuses);
        sendJson(out, 200, new JSONObject().put("success", true).put("entry", entry).toString());
    }

    private int findPlaybackStatus(JSONArray statuses, int sourceId, String itemType, String itemId) throws Exception {
        for (int i = 0; i < statuses.length(); i++) {
            JSONObject s = statuses.getJSONObject(i);
            if (s.optInt("source_id") == sourceId
                    && itemType.equals(s.optString("item_type"))
                    && itemId.equals(s.optString("item_id"))) {
                return i;
            }
        }
        return -1;
    }

    private synchronized JSONObject loadObj(String name) {
        try { return new JSONObject(readFile(name)); } catch (Exception e) { return new JSONObject(); }
    }

    private synchronized JSONArray loadArr(String name) {
        try { return new JSONArray(readFile(name)); } catch (Exception e) { return new JSONArray(); }
    }

    private synchronized void saveObj(String name, JSONObject obj) { writeFile(name, obj.toString()); }

    private synchronized void saveArr(String name, JSONArray arr) { writeFile(name, arr.toString()); }

    private String readFile(String name) throws IOException {
        File f = new File(context.getFilesDir(), name);
        try (FileInputStream in = new FileInputStream(f)) {
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toString("UTF-8");
        }
    }

    private void writeFile(String name, String content) {
        try (FileOutputStream out = new FileOutputStream(new File(context.getFilesDir(), name))) {
            out.write(content.getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            android.util.Log.w("LocalServer", "write failed " + name, e);
        }
    }

    // ==================== Static assets ====================

    private void serveAsset(String path, OutputStream out) throws IOException {
        String clean = path.equals("/") ? "index.html" : path.substring(1);
        if (clean.contains("..")) { sendJson(out, 400, "{}"); return; }

        AssetManager assets = context.getAssets();
        InputStream in;
        try {
            in = assets.open("www/" + clean);
        } catch (IOException e) {
            // SPA fallback (hash routing uses index.html for everything)
            try {
                in = assets.open("www/index.html");
                clean = "index.html";
            } catch (IOException e2) {
                sendJson(out, 404, "{\"error\":\"not found\"}");
                return;
            }
        }

        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        sendBytes(out, 200, mimeFor(clean), bos.toByteArray());
    }

    private String mimeFor(String name) {
        if (name.endsWith(".html")) return "text/html; charset=utf-8";
        if (name.endsWith(".js")) return "application/javascript; charset=utf-8";
        if (name.endsWith(".css")) return "text/css; charset=utf-8";
        if (name.endsWith(".svg")) return "image/svg+xml";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
        if (name.endsWith(".json")) return "application/json";
        if (name.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    private void sendJson(OutputStream out, int code, String json) throws IOException {
        sendBytes(out, code, "application/json; charset=utf-8", json.getBytes(StandardCharsets.UTF_8));
    }

    private void sendBytes(OutputStream out, int code, String contentType, byte[] data) throws IOException {
        String status = code == 200 ? "OK" : (code == 404 ? "Not Found" : "Error");
        String headers = "HTTP/1.1 " + code + " " + status + "\r\n"
                + "Content-Type: " + contentType + "\r\n"
                + "Content-Length: " + data.length + "\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Connection: close\r\n\r\n";
        out.write(headers.getBytes(StandardCharsets.UTF_8));
        out.write(data);
        out.flush();
    }
}
