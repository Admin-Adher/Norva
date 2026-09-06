package tv.norva.playback;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public final class NativeStreamMediaItemTest {
    private static final String URL = "https://epg.provider.plex.tv/library/parts/"
            + "643054b1fc3be59477853717-68a799722895f21006e758e4/?X-Plex-Token=test";

    @Test public void extensionlessPlexLiveSelectsHls() {
        assertEquals("application/x-mpegURL", NativeStreamMediaItem.mimeTypeFor(URL, "live"));
        assertEquals("application/x-mpegURL", NativeStreamMediaItem.mimeTypeFor(
                URL + new String(new char[6000]).replace('\0', 'a'), "live"));
    }

    @Test public void vodAndDownloadsKeepTheirExistingDetection() {
        for (String type : new String[]{"movie", "episode", null, ""}) {
            assertNull(NativeStreamMediaItem.mimeTypeFor(URL, type));
        }
        for (String url : new String[]{"file:///movie.enc", "https://example.com/movie.mkv",
                "https://example.com/live.ts", "https://example.com/live.m3u8",
                "https://media.norva.tv/sessions/test/index.m3u8"}) {
            assertNull(NativeStreamMediaItem.mimeTypeFor(url, "live"));
        }
    }

    @Test public void phoneBridgeChannelAliasSelectsTheSameManifestFormat() {
        assertEquals("application/x-mpegURL", NativeStreamMediaItem.mimeTypeFor(URL, "channel"));
        assertNull(NativeStreamMediaItem.mimeTypeFor("https://example.com/live.ts", "channel"));
    }

    @Test public void onlyTheKnownManifestEndpointGetsAHint() {
        for (String url : new String[]{null, "", "invalid url",
                URL.replace("https:", "http:"), URL.replace(".tv/", ".tv.evil.test/"),
                URL.replace(".tv/", ".tv:443/"), URL.replace("https://", "https://user@"),
                URL.replace("/parts/", "/videos/"), URL.replace("/parts/", "/%70arts/"),
                URL.replace("X-Plex-Token=", "token="), URL.replace("=test", "="),
                URL + "&other=value", URL + "#fragment"}) {
            assertNull(NativeStreamMediaItem.mimeTypeFor(url, "live"));
        }
    }
}
