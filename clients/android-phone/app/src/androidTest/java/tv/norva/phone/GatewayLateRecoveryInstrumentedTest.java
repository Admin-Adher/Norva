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

/** Runs the production WatchPage state machine in Android WebView, not a decoder test. */
public class GatewayLateRecoveryInstrumentedTest {
    @Test public void lateSegmentsResumeOnlyAutomaticPauses() throws Exception {
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        AtomicReference<WebView> holder = new AtomicReference<>();
        CountDownLatch loaded = new CountDownLatch(1);
        instrumentation.runOnMainSync(() -> {
            WebView view = new WebView(instrumentation.getTargetContext()); holder.set(view);
            view.getSettings().setJavaScriptEnabled(true); view.getSettings().setTextZoom(130);
            view.setWebViewClient(new WebViewClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                    try { return new WebResourceResponse("text/javascript", "UTF-8", instrumentation.getContext().getAssets().open(request.getUrl().getPath().substring(1))); }
                    catch (Exception ignored) { return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0])); }
                }
                @Override public void onPageFinished(WebView v, String url) { loaded.countDown(); }
            });
            view.loadDataWithBaseURL("https://norva-recovery.test/", "<!doctype html><script src='/js/pages/WatchPage.js'></script><script src='/gateway-late-recovery.js'></script>", "text/html", "UTF-8", null);
        });
        try {
            assertTrue("scripts loaded", loaded.await(30, TimeUnit.SECONDS));
            instrumentation.runOnMainSync(() -> holder.get().evaluateJavascript(
                "window.result='pending';window.Hls=class{static Events=Object.fromEntries(['MEDIA_ATTACHED','AUDIO_TRACKS_UPDATED','AUDIO_TRACK_SWITCHED','SUBTITLE_TRACKS_UPDATED','SUBTITLE_TRACK_SWITCH','MANIFEST_PARSED','ERROR','BUFFER_APPENDED'].map(x=>[x,x]));static ErrorTypes={MEDIA_ERROR:'media',NETWORK_ERROR:'network'};constructor(){this.handlers=new Map();this.audioTracks=[];}on(e,f){this.handlers.set(e,f);}emit(e,d){return this.handlers.get(e)?.(e,d);}loadSource(){}attachMedia(){}};verifyGatewayLateRecovery(WatchPage,Hls,()=>new Promise(r=>setTimeout(r,500))).then(v=>window.result=v,e=>window.result=String(e));", null));
            String value = "";
            for (int i=0;i<20;i++) {
                Thread.sleep(500);
                CountDownLatch read = new CountDownLatch(1); AtomicReference<String> current = new AtomicReference<>();
                instrumentation.runOnMainSync(() -> holder.get().evaluateJavascript("window.result", v -> { current.set(v); read.countDown(); }));
                assertTrue(read.await(5, TimeUnit.SECONDS)); value=current.get();
                if (!"\"pending\"".equals(value)) break;
            }
            assertEquals("\"ok\"", value);
        } finally { instrumentation.runOnMainSync(() -> holder.get().destroy()); }
    }
}
