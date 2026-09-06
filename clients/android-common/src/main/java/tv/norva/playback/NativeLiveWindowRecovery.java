package tv.norva.playback;

import androidx.media3.common.PlaybackException;

/** One local live-window recovery, rearmed only after sustained playback or user Retry. */
public final class NativeLiveWindowRecovery {
    private boolean used;

    public boolean tryAcquire(int errorCode, String url, String itemType) {
        if (used || errorCode != PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW
                || NativeStreamMediaItem.mimeTypeFor(url, itemType) == null) return false;
        used = true;
        return true;
    }

    public void reset() {
        used = false;
    }
}
