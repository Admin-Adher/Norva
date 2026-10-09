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

/** Actual WatchPage rendered-position feedback in Android WebView; no decoder claim. */
public class GatewayRenderedPositionInstrumentedTest {
    private static final String HTML = "<!doctype html><html><body><script src='/js/utils/mediaUtils.js'></script><script src='/js/pages/WatchPage.js'></script></body></html>";

    @Test public void renderedPositionStaysWithinAuthenticatedPlaylistScope() throws Exception {
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
                "(()=>{try{const page=Object.create(WatchPage.prototype);page.video={currentTime:101.2349,readyState:4};\nconst root='https://gateway.invalid/sessions/one/playlist.m3u8?token=fixture';const media=root.replace('playlist.m3u8','video.m3u8');\nconst position=u=>new URL(page.gatewayPlaybackPositionUrl(u,root)).searchParams.get('renderedPosition');\nif(position(media)!=='101.234')throw Error('rendered time missing');\npage.video.currentTime=120.75;if(position(media)!=='120.75')throw Error('rendered time stale');\nfor(const u of [media.replace('gateway.invalid','other.invalid'),media.replace('/one/','/two/'),media.replace('fixture','other'),media.replace('.m3u8','.ts')])if(page.gatewayPlaybackPositionUrl(u,root)!==u)throw Error('feedback escaped scope');\npage.video.readyState=0;if(position(media)!=='0')throw Error('unready bootstrap');\npage.video.readyState=4;page.video.currentTime=Infinity;if(page.gatewayPlaybackPositionUrl(media,root)!==media)throw Error('invalid time accepted');\nreturn 'ok';}catch(e){return String(e);}})()",
                value -> { result.set(value); done.countDown(); }));
            assertTrue("WebView completed recovery contract", done.await(20, TimeUnit.SECONDS));
            assertEquals("\"ok\"", result.get());
        } finally {
            instrumentation.runOnMainSync(() -> holder.get().destroy());
        }
    }
}
