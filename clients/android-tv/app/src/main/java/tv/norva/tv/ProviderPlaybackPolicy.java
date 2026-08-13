package tv.norva.tv;

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

    static boolean isPlaybackSuperseded(String code) {
        return PLAYBACK_SUPERSEDED.equals(code);
    }
}
