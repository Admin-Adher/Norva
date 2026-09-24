package tv.norva.phone;

import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import static org.junit.Assert.*;

/** Actual WatchPage recovery contract in Android WebView; no provider/decoder claim. */
public class GatewayAudioWindowInstrumentedTest {
    private static final String HTML = "<!doctype html><html><body><script src='/js/pages/WatchPage.js'></script></body></html>";

    @Test public void expiredAudioWindowKeepsAbsolutePositionAndPauseIntent() throws Exception {
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        AtomicReference<WebView> holder = new AtomicReference<>();
        CountDownLatch loaded = new CountDownLatch(1);
        instrumentation.runOnMainSync(() -> {
            WebView view = new WebView(instrumentation.getTargetContext());
            holder.set(view);
            view.getSettings().setJavaScriptEnabled(true);
            view.getSettings().setTextZoom(130);
            view.setWebViewClient(new WebViewClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                    try {
                        return new WebResourceResponse("text/javascript", "UTF-8", instrumentation.getContext().getAssets().open(request.getUrl().getPath().substring(1)));
                    } catch (Exception ignored) {
                        return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                    }
                }
                @Override public void onPageFinished(WebView v, String url) { loaded.countDown(); }
            });
            view.loadDataWithBaseURL("https://norva-audio-window.test/", HTML, "text/html", "UTF-8", null);
        });
        try {
            assertTrue("WatchPage loaded", loaded.await(45, TimeUnit.SECONDS));
            CountDownLatch done = new CountDownLatch(1);
            AtomicReference<String> result = new AtomicReference<>();
            instrumentation.runOnMainSync(() -> holder.get().evaluateJavascript(
                "(()=>{try{for(const paused of [true,false]){"
                + "const page=Object.create(WatchPage.prototype);let anchor=null,stopped=0;"
                + "const hls={audioTrack:0,currentLevel:0,levels:[{details:{live:true,fragments:[{start:600}]}}],audioTracks:[{},{}],stopLoad(){stopped++;}};"
                + "Object.assign(page,{hls,_playbackAttemptId:7,streamStartOffset:300,selectedAudioStreamIndex:1,directAudioStreamIndex:1,"
                + "video:{currentTime:40,paused,pause(){this.paused=true;}},getDisplayDuration:()=>7000,"
                + "getValidatedGatewayAudioRenditions:()=>[{hlsIndex:1,streamIndex:2}],isStalePlaybackAttempt:id=>id!==7,"
                + "clearPendingPreference:()=>{},closeAudioMenu:()=>{},queueSelectedAudioTrackRestart:value=>{anchor=value;return Promise.resolve(true);}});"
                + "page.selectGatewayHlsAudioTrack(1,2);"
                + "if(!anchor||anchor.position!==340||anchor.autoplay!==!paused)throw Error('lost anchor or pause');"
                + "if(hls.audioTrack!==0||stopped!==1||page.directAudioStreamIndex!==1)throw Error('unsafe track promotion');"
                + "if(page.selectedAudioStreamIndex!==2)throw Error('wrong requested track');"
                + "}return 'ok';}catch(e){return String(e);}})()",
                value -> { result.set(value); done.countDown(); }));
            assertTrue("WebView completed recovery contract", done.await(20, TimeUnit.SECONDS));
            assertEquals("\"ok\"", result.get());
        } finally {
            instrumentation.runOnMainSync(() -> holder.get().destroy());
        }
    }
}
