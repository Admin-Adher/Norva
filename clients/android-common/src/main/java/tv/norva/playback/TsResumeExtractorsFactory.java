package tv.norva.playback;

import android.net.Uri;
import androidx.media3.common.C;
import androidx.media3.common.DataReader;
import androidx.media3.common.Format;
import androidx.media3.common.util.ParsableByteArray;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.extractor.Extractor;
import androidx.media3.extractor.ExtractorInput;
import androidx.media3.extractor.ExtractorOutput;
import androidx.media3.extractor.ExtractorsFactory;
import androidx.media3.extractor.PositionHolder;
import androidx.media3.extractor.SeekMap;
import androidx.media3.extractor.TrackOutput;
import androidx.media3.extractor.ts.TsExtractor;
import java.io.IOException;
import java.util.List;
import java.util.Map;

/** Decode progressive TS before the requested position; keep Media3's sample target intact. */
@UnstableApi
public final class TsResumeExtractorsFactory implements ExtractorsFactory {
    private final ExtractorsFactory delegate;

    public TsResumeExtractorsFactory(ExtractorsFactory delegate) {
        this.delegate = delegate;
    }

    @Override public Extractor[] createExtractors() {
        return wrap(delegate.createExtractors());
    }

    @Override public Extractor[] createExtractors(Uri uri, Map<String, List<String>> headers) {
        return wrap(delegate.createExtractors(uri, headers));
    }

    private static Extractor[] wrap(Extractor[] extractors) {
        Extractor[] result = extractors.clone();
        for (int i = 0; i < result.length; i++) {
            if (result[i] instanceof TsExtractor) result[i] = new PreRoll(result[i]);
        }
        return result;
    }

    // This bounded fallback matches the server's non-indexed TS decode window.
    // It does not promise support for an arbitrarily long GOP, nor change the
    // user-visible seek target. HLS has its own extractor factory and is unaffected.
    static final class PreRoll implements Extractor {
        static final long WINDOW_US = 15_000_000L;
        static final long INITIAL_WINDOW_US = 2_000_000L;
        private final Extractor delegate;
        private boolean rewind;
        private boolean hasVideo, waitingForKey, retry, extended;
        private long requestedTimeUs;

        PreRoll(Extractor delegate) { this.delegate = delegate; }
        @Override public boolean sniff(ExtractorInput input) throws IOException {
            return delegate.sniff(input);
        }
        @Override public void init(ExtractorOutput output) {
            delegate.init(new ExtractorOutput() {
                @Override public TrackOutput track(int id, int type) {
                    if (type == C.TRACK_TYPE_VIDEO) hasVideo = true;
                    return new GuardedTrack(output.track(id, type), type == C.TRACK_TYPE_VIDEO);
                }
                @Override public void endTracks() { output.endTracks(); }
                @Override public void seekMap(SeekMap map) { output.seekMap(map); }
            });
        }
        @Override public void seek(long position, long timeUs) {
            requestedTimeUs = Math.max(0, timeUs);
            waitingForKey = hasVideo && requestedTimeUs > 0;
            retry = false;
            extended = false;
            startDecode(position, INITIAL_WINDOW_US);
        }
        private void startDecode(long position, long windowUs) {
            long decodeTimeUs = Math.max(0, requestedTimeUs - windowUs);
            rewind = decodeTimeUs == 0;
            delegate.seek(rewind ? 0 : position, decodeTimeUs);
        }
        @Override public int read(ExtractorInput input, PositionHolder seekPosition) throws IOException {
            if (retry) {
                retry = false;
                extended = true;
                startDecode(input.getPosition(), WINDOW_US);
            }
            if (rewind) {
                if (input.getPosition() != 0) {
                    seekPosition.position = 0;
                    return RESULT_SEEK;
                }
                rewind = false;
            }
            int result = delegate.read(input, seekPosition);
            if (result == RESULT_END_OF_INPUT && waitingForKey && !extended) {
                retry = true;
                return RESULT_CONTINUE;
            }
            return result;
        }
        @Override public void release() { delegate.release(); }

        private final class GuardedTrack implements TrackOutput {
            private final TrackOutput output;
            private final boolean video;
            GuardedTrack(TrackOutput output, boolean video) { this.output=output; this.video=video; }
            @Override public void format(Format format) { output.format(format); }
            @Override public int sampleData(DataReader input, int length, boolean allowEnd, int part) throws IOException {
                return output.sampleData(input, length, allowEnd, part);
            }
            @Override public void sampleData(ParsableByteArray data, int length, int part) {
                output.sampleData(data, length, part);
            }
            @Override public void sampleMetadata(long timeUs, int flags, int size, int offset, CryptoData crypto) {
                if (retry) return;
                if (waitingForKey) {
                    if (!video || (flags & C.BUFFER_FLAG_KEY_FRAME) == 0) return;
                    if (timeUs > requestedTimeUs + 100_000 && !extended) {
                        // No sample metadata from this failed attempt reaches a queue.
                        // Previously appended bytes stay unreferenced; size/offset still
                        // identify the next committed sample according to TrackOutput.
                        retry = true;
                        return;
                    }
                    waitingForKey = false;
                }
                output.sampleMetadata(timeUs, flags, size, offset, crypto);
            }
        }
    }
}
