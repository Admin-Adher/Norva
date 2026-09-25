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

/** Actual catalogue renderers, API save event and native progress bridge in System WebView. */
public class ContinueWatchingInstrumentedTest {
    @Test public void sourceScopeAndPlaybackReturnRefreshTheRail() throws Exception {
        android.app.Instrumentation i = InstrumentationRegistry.getInstrumentation();
        AtomicReference<WebView> holder = new AtomicReference<>();
        CountDownLatch loaded = new CountDownLatch(1);
        i.runOnMainSync(() -> {
            WebView view = new WebView(i.getTargetContext()); holder.set(view);
            view.getSettings().setJavaScriptEnabled(true);
            view.getSettings().setDomStorageEnabled(true);
            view.getSettings().setTextZoom(130);
            view.setWebViewClient(new WebViewClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                    String path = request.getUrl().getPath();
                    String mime = path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css" : path.endsWith(".png") ? "image/png" : "text/javascript";
                    try { return new WebResourceResponse(mime, "UTF-8", i.getContext().getAssets().open(path.substring(1))); }
                    catch (Exception ignored) { return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0])); }
                }
                @Override public void onPageFinished(WebView v, String url) { loaded.countDown(); }
            });
            view.loadUrl("https://norva-history.test/continue-watching.html");
        });
        try {
            assertTrue("History fixture loaded", loaded.await(45, TimeUnit.SECONDS));
            String result = "null";
            for (int n = 0; n < 60 && "null".equals(result); n++) {
                CountDownLatch done = new CountDownLatch(1);
                AtomicReference<String> value = new AtomicReference<>();
                i.runOnMainSync(() -> holder.get().evaluateJavascript("window.continueWatchingProof || null", response -> { value.set(response); done.countDown(); }));
                assertTrue("WebView response", done.await(10, TimeUnit.SECONDS));
                result = value.get();
                if ("null".equals(result)) Thread.sleep(250);
            }
            assertTrue("History proof: " + result, result != null && result.contains("\"passed\":true"));
        } finally { i.runOnMainSync(() -> holder.get().destroy()); }
    }
}
