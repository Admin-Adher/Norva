package tv.norva.playback;

import android.net.Uri;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.extractor.Extractor;
import androidx.media3.extractor.ExtractorInput;
import androidx.media3.extractor.ExtractorOutput;
import androidx.media3.extractor.ExtractorsFactory;
import androidx.media3.extractor.PositionHolder;
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
        private final Extractor delegate;
        private boolean rewind;

        PreRoll(Extractor delegate) { this.delegate = delegate; }
        @Override public boolean sniff(ExtractorInput input) throws IOException {
            return delegate.sniff(input);
        }
        @Override public void init(ExtractorOutput output) { delegate.init(output); }
        @Override public void seek(long position, long timeUs) {
            long decodeTimeUs = Math.max(0, timeUs - WINDOW_US);
            rewind = decodeTimeUs == 0;
            delegate.seek(rewind ? 0 : position, decodeTimeUs);
        }
        @Override public int read(ExtractorInput input, PositionHolder seekPosition) throws IOException {
            if (rewind) {
                if (input.getPosition() != 0) {
                    seekPosition.position = 0;
                    return RESULT_SEEK;
                }
                rewind = false;
            }
            return delegate.read(input, seekPosition);
        }
        @Override public void release() { delegate.release(); }
    }
}
