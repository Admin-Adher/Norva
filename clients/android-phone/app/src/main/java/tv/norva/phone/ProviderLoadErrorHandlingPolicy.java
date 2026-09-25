package tv.norva.phone;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy;
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy;

/** Surfaces provider conflicts and confirmed HTML refusals without hidden retries. */
@OptIn(markerClass = UnstableApi.class)
final class ProviderLoadErrorHandlingPolicy extends DefaultLoadErrorHandlingPolicy {
    @Override
    public long getRetryDelayMsFor(LoadErrorHandlingPolicy.LoadErrorInfo loadErrorInfo) {
        if (BoundedRangeDataSource.isHtmlResponse(loadErrorInfo.exception)
                || ProviderPlaybackPolicy.httpStatus(loadErrorInfo.exception) == 460
                || ProviderPlaybackPolicy.isProviderBusyHttpStatus(
                ProviderPlaybackPolicy.httpStatus(loadErrorInfo.exception))) {
            return C.TIME_UNSET;
        }
        return super.getRetryDelayMsFor(loadErrorInfo);
    }
}
