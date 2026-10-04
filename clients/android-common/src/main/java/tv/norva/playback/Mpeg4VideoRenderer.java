package tv.norva.playback;

import android.os.Handler;
import android.view.Surface;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.decoder.CryptoConfig;
import androidx.media3.decoder.DecoderException;
import androidx.media3.decoder.VideoDecoderOutputBuffer;
import androidx.media3.exoplayer.DecoderReuseEvaluation;
import androidx.media3.exoplayer.RendererCapabilities;
import androidx.media3.exoplayer.video.DecoderVideoRenderer;
import androidx.media3.exoplayer.video.VideoRendererEventListener;

/** MPEG-4 alone uses the local software renderer; modern codecs retain MediaCodec. */
@UnstableApi
final class Mpeg4VideoRenderer extends DecoderVideoRenderer {
    private Mpeg4VideoDecoder decoder;
    Mpeg4VideoRenderer(long joiningMs, Handler handler, VideoRendererEventListener listener, int droppedFrames) {
        super(joiningMs, handler, listener, droppedFrames);
    }
    @Override public String getName() { return "NorvaMpeg4VideoRenderer"; }
    @Override public int supportsFormat(Format format) {
        if (!MimeTypes.VIDEO_MP4V.equals(format.sampleMimeType))
            return RendererCapabilities.create(C.FORMAT_UNSUPPORTED_TYPE);
        if (format.drmInitData != null) return RendererCapabilities.create(C.FORMAT_UNSUPPORTED_DRM);
        return RendererCapabilities.create(Mpeg4VideoDecoder.isAvailable() ? C.FORMAT_HANDLED : C.FORMAT_UNSUPPORTED_SUBTYPE);
    }
    @Override protected Mpeg4VideoDecoder createDecoder(Format format, CryptoConfig crypto) throws DecoderException {
        if (crypto != null) throw new DecoderException("Encrypted MPEG-4 is unsupported by this decoder");
        return decoder = new Mpeg4VideoDecoder(format);
    }
    @Override protected void setDecoderOutputMode(int mode) {
        if (decoder != null) decoder.setOutputMode(mode);
    }
    @Override protected void renderOutputBufferToSurface(VideoDecoderOutputBuffer output, Surface surface) throws DecoderException {
        try { decoder.render(output, surface); } finally { output.release(); }
    }
    @Override protected DecoderReuseEvaluation canReuseDecoder(String name, Format oldFormat, Format newFormat) {
        // A new stream may have different VOL/extradata. Reinitialize; seeks use flush.
        return new DecoderReuseEvaluation(name, oldFormat, newFormat,
                DecoderReuseEvaluation.REUSE_RESULT_NO,
                DecoderReuseEvaluation.DISCARD_REASON_REUSE_NOT_IMPLEMENTED);
    }
}
