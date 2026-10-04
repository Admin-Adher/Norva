package tv.norva.playback;

import android.content.Context;
import android.os.Handler;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.Renderer;
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector;
import androidx.media3.exoplayer.video.VideoRendererEventListener;
import java.util.ArrayList;

@UnstableApi
public final class NativeRenderersFactory extends DefaultRenderersFactory {
    public NativeRenderersFactory(Context context) {
        super(context);
        setExtensionRendererMode(EXTENSION_RENDERER_MODE_ON);
    }
    @Override protected void buildVideoRenderers(Context context, int extensionMode,
            MediaCodecSelector selector, boolean decoderFallback, Handler handler,
            VideoRendererEventListener listener, long joiningMs, ArrayList<Renderer> out) {
        out.add(new Mpeg4VideoRenderer(joiningMs, handler, listener, 50));
        super.buildVideoRenderers(context, extensionMode, selector, decoderFallback, handler, listener, joiningMs, out);
    }
}
