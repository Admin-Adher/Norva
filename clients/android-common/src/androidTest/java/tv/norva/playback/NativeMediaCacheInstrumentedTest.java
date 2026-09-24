package tv.norva.playback;

import static org.junit.Assert.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.JSONObject;

@RunWith(AndroidJUnit4.class)
public final class NativeMediaCacheInstrumentedTest {
    private static final String KEY = new String(new char[64]).replace('\0', 'a');
    private static final String URL = "https://cache.norva.tv/v1/hls/" + KEY + "/master.m3u8";
    private JSONObject contract() throws Exception {
        return new JSONObject().put("protocol", 1).put("transport", "private-r2-hls")
                .put("objectKey", KEY).put("playlistUrl", URL)
                .put("authorization", new JSONObject().put("scheme", "Bearer").put("token", "mc1.test.signature"))
                .put("refreshAfter", "2026-09-24T16:00:00.000Z")
                .put("ticketExpiresAt", "2026-09-24T16:05:00.000Z")
                .put("hardExpiresAt", "2026-09-24T17:00:00.000Z");
    }
    @Test public void ticketIsRestrictedToExactHttpsOriginAndObjectPrefix() throws Exception {
        NativeMediaCache.Access access = new NativeMediaCache.Access(contract(), URL);
        assertTrue(access.allows(URL.replace("master.m3u8", "video/segment001.ts")));
        for (String bad : new String[] {
                URL.replace("https:", "http:"), URL.replace("cache.norva.tv", "provider.example"),
                URL.replace(KEY, KEY.substring(1)), URL + "?ticket=x", URL + "#fragment",
                URL.replace("master.m3u8", "../other.ts"), URL.replace("master.m3u8", "%2e%2e/other.ts"),
                URL.replace("cache.norva.tv", "cache.norva.tv:444"),
                URL.replace("cache.norva.tv", "user@cache.norva.tv") }) assertFalse(bad, access.allows(bad));
    }
    @Test public void renewalCannotReplaceIdentityOrInjectHeaderText() throws Exception {
        for (JSONObject bad : new JSONObject[] {
                contract().put("playlistUrl", URL.replace(KEY, KEY.substring(1))),
                contract().put("authorization", new JSONObject().put("scheme", "Bearer").put("token", "mc1.a.b\r\nInjected: true")),
                contract().put("refreshAfter", "2026-09-24T17:05:00.000Z"),
                contract().put("hardExpiresAt", "2026-09-24T16:01:00.000Z") }) {
            try { new NativeMediaCache.Access(bad, URL); fail("Invalid authority accepted"); }
            catch (Exception expected) { }
        }
    }
    @Test public void databaseRfc3339DatesAndJavascriptDatesAreEquivalent() throws Exception {
        NativeMediaCache.Access javascript = new NativeMediaCache.Access(contract(), URL);
        NativeMediaCache.Access database = new NativeMediaCache.Access(contract()
                .put("ticketExpiresAt", "2026-09-24T18:05:00.000123+02:00")
                .put("hardExpiresAt", "2026-09-24T17:00:00+00:00"), URL);
        assertEquals(javascript.expiresAt, database.expiresAt);
    }
}
