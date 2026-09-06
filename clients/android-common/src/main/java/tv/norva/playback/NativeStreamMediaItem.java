package tv.norva.playback;

import androidx.media3.common.MediaItem;

import java.net.URI;

/** Format selection for an already-resolved playback URL; never an access decision. */
public final class NativeStreamMediaItem {
    private NativeStreamMediaItem() { }

    public static MediaItem fromUri(String url, String itemType) {
        MediaItem.Builder item = new MediaItem.Builder().setUri(url);
        String mime = mimeTypeFor(url, itemType);
        if (mime != null) item.setMimeType(mime);
        return item.build();
    }

    public static String mimeTypeFor(String url, String itemType) {
        // Plex returns an HLS manifest from this extensionless endpoint. Without
        // an explicit MIME type Media3 chooses ProgressiveMediaSource and tries
        // to parse the playlist as a video file. Leave other media untouched.
        // The phone bridge calls live items "channel"; the server calls them "live".
        if (!("live".equals(itemType) || "channel".equals(itemType)) || url == null) return null;
        try {
            URI uri = new URI(url);
            if (!"https".equals(uri.getScheme())
                    || !"epg.provider.plex.tv".equals(uri.getRawAuthority())
                    || uri.getRawFragment() != null
                    || !uri.getRawPath().matches("/library/parts/[a-f0-9]{24}-[a-f0-9]{24}/")
                    || uri.getRawQuery() == null
                    || !uri.getRawQuery().matches("X-Plex-Token=[^&]+")) return null;
            return "application/x-mpegURL";
        } catch (Exception ignored) {
            return null;
        }
    }
}
