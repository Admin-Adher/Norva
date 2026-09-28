package tv.norva.playback;

import static org.junit.Assert.*;
import androidx.media3.extractor.*;
import java.lang.reflect.Proxy;
import org.junit.Test;

public final class TsResumeExtractorsFactoryTest {
    @Test public void nearStartRewindsBytesBeforeReading() throws Exception {
        Fake delegate = new Fake();
        Extractor extractor = new TsResumeExtractorsFactory.PreRoll(delegate);
        extractor.seek(2000, 5_000_000);
        assertEquals(0, delegate.position);
        assertEquals(0, delegate.timeUs);
        PositionHolder requested = new PositionHolder();
        assertEquals(Extractor.RESULT_SEEK, extractor.read(input(2000), requested));
        assertEquals(0, requested.position);
        assertEquals(0, delegate.reads);
        assertEquals(Extractor.RESULT_CONTINUE, extractor.read(input(0), requested));
        assertEquals(1, delegate.reads);
        extractor.read(input(188), requested);
        assertEquals(2, delegate.reads);
    }

    @Test public void laterSeekCancelsPendingRewind() throws Exception {
        Fake delegate = new Fake();
        Extractor extractor = new TsResumeExtractorsFactory.PreRoll(delegate);
        extractor.seek(2000, 5_000_000);
        extractor.seek(9000, 25_000_000);
        assertEquals(9000, delegate.position);
        assertEquals(10_000_000, delegate.timeUs);
        assertEquals(Extractor.RESULT_CONTINUE, extractor.read(input(9000), new PositionHolder()));
        assertEquals(1, delegate.reads);
    }

    @Test public void nonTsExtractorsArePreserved() {
        Fake delegate = new Fake();
        Extractor[] original = {delegate};
        Extractor[] result = new TsResumeExtractorsFactory(() -> original).createExtractors();
        assertNotSame(original, result);
        assertSame(delegate, result[0]);
        assertSame(delegate, original[0]);
    }

    private static ExtractorInput input(long position) {
        return (ExtractorInput) Proxy.newProxyInstance(ExtractorInput.class.getClassLoader(),
            new Class<?>[]{ExtractorInput.class}, (proxy, method, args) -> {
                if (method.getName().equals("getPosition")) return position;
                throw new AssertionError("Unexpected input access: " + method.getName());
            });
    }

    private static final class Fake implements Extractor {
        long position, timeUs; int reads;
        public boolean sniff(ExtractorInput input) { return true; }
        public void init(ExtractorOutput output) { }
        public void seek(long position, long timeUs) { this.position=position; this.timeUs=timeUs; }
        public int read(ExtractorInput input, PositionHolder seekPosition) { reads++; return RESULT_CONTINUE; }
        public void release() { }
    }
}
