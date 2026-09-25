package tv.norva.phone;

import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.HttpDataSource;

/** Pure classification for provider-account conflicts exposed by Media3 or Norva. */
@OptIn(markerClass = UnstableApi.class)
final class ProviderPlaybackPolicy {
    static final int HTTP_PROVIDER_BUSY = 458;
    static final String PLAYBACK_SUPERSEDED = "PLAYBACK_SUPERSEDED";

    private ProviderPlaybackPolicy() {
    }

    static int httpStatus(Throwable error) {
        Throwable current = error;
        int depth = 0;
        while (current != null && depth++ < 8) {
            if (current instanceof HttpDataSource.InvalidResponseCodeException) {
                return ((HttpDataSource.InvalidResponseCodeException) current).responseCode;
            }
            current = current.getCause();
        }
        return -1;
    }

    static boolean isProviderBusyHttpStatus(int status) {
        return status == HTTP_PROVIDER_BUSY;
    }

    static boolean refreshUnprovenVodRoute(String reason, boolean renderedFrame,
            boolean localOrLive, boolean ownedItem) {
        if (renderedFrame || localOrLive || !ownedItem) return false;
        return "ERROR_CODE_IO_BAD_HTTP_STATUS".equals(reason)
                || "ERROR_CODE_IO_NETWORK_CONNECTION_FAILED".equals(reason)
                || "ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT".equals(reason)
                || "ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED".equals(reason)
                || "no_data_timeout".equals(reason);
    }

    static boolean isPlaybackSuperseded(String code) {
        return PLAYBACK_SUPERSEDED.equals(code);
    }
}
