package tv.norva.playback;

import android.view.Surface;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.decoder.Decoder;
import androidx.media3.decoder.DecoderException;
import androidx.media3.decoder.DecoderInputBuffer;
import androidx.media3.decoder.VideoDecoderOutputBuffer;
import java.nio.ByteBuffer;
import java.util.ArrayDeque;

/** Local MPEG-4 Part 2 decoder. One pending packet and four owned output buffers
 * bound memory. FFmpeg retains reordered frames; EOS drains them before ending.
 * All decoder calls belong to ExoPlayer's playback thread, including release. */
@UnstableApi
final class Mpeg4VideoDecoder implements Decoder<DecoderInputBuffer, VideoDecoderOutputBuffer, DecoderException> {
    private static final boolean AVAILABLE = load();
    private final DecoderInputBuffer input = new DecoderInputBuffer(DecoderInputBuffer.BUFFER_REPLACEMENT_MODE_DIRECT);
    private final ArrayDeque<VideoDecoderOutputBuffer> free = new ArrayDeque<>();
    private final long[] frame = new long[5];
    private final Format format;
    private long context;
    private long outputStartTimeUs;
    private int outputMode;
    private int skipped;
    private boolean inputOwned, pending, draining, ended;

    private static boolean load() {
        try { System.loadLibrary("ffmpegJNI"); return nativeVersion() == 1; }
        catch (LinkageError | SecurityException error) { return false; }
    }
    static boolean isAvailable() { return AVAILABLE; }

    Mpeg4VideoDecoder(Format format) throws DecoderException {
        this.format = format;
        if (!AVAILABLE) throw new DecoderException("Local MPEG-4 decoder unavailable");
        byte[] extra = format.initializationData.isEmpty() ? null : format.initializationData.get(0);
        context = nativeCreate(extra, Math.max(0, format.width), Math.max(0, format.height));
        if (context == 0) throw new DecoderException("Cannot initialize local MPEG-4 decoder");
        for (int i = 0; i < 4; i++) free.add(new VideoDecoderOutputBuffer(this::recycle));
    }
    @Override public String getName() { return "norva-ffmpeg-mpeg4"; }
    @Override public void setOutputStartTimeUs(long timeUs) { outputStartTimeUs = timeUs; }
    void setOutputMode(int mode) { outputMode = mode; }
    @Override public DecoderInputBuffer dequeueInputBuffer() {
        if (context == 0 || inputOwned || pending || draining || ended) return null;
        input.clear(); inputOwned = true; return input;
    }
    @Override public void queueInputBuffer(DecoderInputBuffer buffer) throws DecoderException {
        if (buffer != input || !inputOwned || context == 0) throw new DecoderException("Invalid MPEG-4 input ownership");
        inputOwned = false; pending = true;
    }
    @Override public VideoDecoderOutputBuffer dequeueOutputBuffer() throws DecoderException {
        if (context == 0 || ended || free.isEmpty()) return null;
        // Receive before send, preserving packets rejected with EAGAIN and all
        // delayed B frames. Never treat an input timestamp as an output timestamp.
        for (int steps = 0; steps < 32; steps++) {
            int result = nativeReceive(context, frame);
            if (result == 1) {
                if (frame[2] < outputStartTimeUs) { skipped++; continue; }
                VideoDecoderOutputBuffer output = free.removeFirst();
                output.init(frame[2], outputMode, null);
                int width = (int) frame[0], height = (int) frame[1];
                if (!output.initForYuvFrame(width, height, width, (width + 1) / 2, (int) frame[3])
                        || !nativeCopy(context, output.data)) {
                    recycle(output); throw new DecoderException("Invalid MPEG-4 output frame");
                }
                output.format = format;
                output.skippedOutputBufferCount = skipped; skipped = 0;
                return output;
            }
            if (result == 2) {
                ended = true;
                VideoDecoderOutputBuffer output = free.removeFirst();
                output.addFlag(C.BUFFER_FLAG_END_OF_STREAM);
                return output;
            }
            if (result < 0) throw new DecoderException("MPEG-4 decode failed (" + result + ")");
            if (!pending) return null;
            boolean eos = input.isEndOfStream();
            ByteBuffer data = eos ? null : input.data;
            int sent = nativeSend(context, data, data == null ? 0 : data.position(),
                    data == null ? 0 : data.remaining(), input.timeUs, eos);
            if (sent < 0) throw new DecoderException("MPEG-4 packet rejected (" + sent + ")");
            if (sent == 0) return null; // EAGAIN: retain the exact packet.
            pending = false; draining = eos;
        }
        return null; // Bound catch-up work on the playback thread after seeking.
    }
    private void recycle(VideoDecoderOutputBuffer output) {
        output.clear();
        if (context != 0) free.addLast(output);
    }
    void render(VideoDecoderOutputBuffer output, Surface surface) throws DecoderException {
        if (!nativeRender(output.data, output.width, output.height, surface))
            throw new DecoderException("MPEG-4 video surface unavailable");
    }
    @Override public void flush() {
        if (context != 0) nativeFlush(context);
        input.clear(); inputOwned = pending = draining = ended = false; skipped = 0;
        outputStartTimeUs = 0;
    }
    @Override public void release() {
        if (context != 0) { nativeRelease(context); context = 0; }
        free.clear(); pending = inputOwned = false;
    }
    private static native int nativeVersion();
    private static native long nativeCreate(byte[] extra, int width, int height);
    private static native int nativeSend(long context, ByteBuffer data, int offset, int size, long pts, boolean eos);
    private static native int nativeReceive(long context, long[] frame);
    private static native boolean nativeCopy(long context, ByteBuffer data);
    private static native boolean nativeRender(ByteBuffer data, int width, int height, Surface surface);
    private static native void nativeFlush(long context);
    private static native void nativeRelease(long context);
}
