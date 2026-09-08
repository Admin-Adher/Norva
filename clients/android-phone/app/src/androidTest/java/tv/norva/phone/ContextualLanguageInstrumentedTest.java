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

/** Real catalogue markup, rating controller and filters, with an offline rating API. */
public class ContextualLanguageInstrumentedTest {
    private static final String[] LOCALES = {"en", "fr", "pt-BR", "es", "hi", "tr", "bn", "ar", "id", "fil"};

    private static String evaluate(android.app.Instrumentation instrumentation, WebView view, String js) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> view.evaluateJavascript(js, value -> { result.set(value); latch.countDown(); }));
        assertTrue("WebView responded", latch.await(20, TimeUnit.SECONDS));
        return result.get();
    }

    @Test public void portraitAllLocalesAndTextSizes() throws Exception { verify(360, 800); }
    @Test public void landscapeAllLocalesAndTextSizes() throws Exception { verify(844, 390); }

    private void verify(int width, int height) throws Exception {
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        android.content.Context context = instrumentation.getTargetContext();
        AtomicReference<WebView> holder = new AtomicReference<>();
        CountDownLatch loaded = new CountDownLatch(1);
        instrumentation.runOnMainSync(() -> {
            WebView view = new WebView(context); holder.set(view);
            view.getSettings().setJavaScriptEnabled(true);
            view.getSettings().setDomStorageEnabled(true);
            view.getSettings().setUseWideViewPort(true);
            view.setWebViewClient(new WebViewClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                    String path = request.getUrl().getPath();
                    try {
                        String mime = path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css" : path.endsWith(".js") ? "text/javascript" : "application/octet-stream";
                        return new WebResourceResponse(mime, "UTF-8", instrumentation.getContext().getAssets().open(path.substring(1)));
                    } catch (Exception ignored) {
                        return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                    }
                }
                @Override public void onPageFinished(WebView v, String url) { loaded.countDown(); }
            });
            float density = context.getResources().getDisplayMetrics().density;
            int w = Math.round(width * density), h = Math.round(height * density);
            view.measure(android.view.View.MeasureSpec.makeMeasureSpec(w, android.view.View.MeasureSpec.EXACTLY), android.view.View.MeasureSpec.makeMeasureSpec(h, android.view.View.MeasureSpec.EXACTLY));
            view.layout(0, 0, w, h);
            view.loadUrl("https://norva-context.test/i18n-context.html");
        });
        try {
            assertTrue("Context assets loaded", loaded.await(45, TimeUnit.SECONDS));
            String ready = "false";
            for (int i = 0; i < 100 && !"true".equals(ready); i++) {
                Thread.sleep(100); ready = evaluate(instrumentation, holder.get(), "window.fixtureReady");
            }
            assertEquals("Fixture ready: " + evaluate(instrumentation, holder.get(), "window.fixtureErrors"), "true", ready);
            for (int zoom : new int[] {100, 130}) {
                instrumentation.runOnMainSync(() -> holder.get().getSettings().setTextZoom(zoom));
                for (String locale : LOCALES) for (String kind : new String[] {"movies", "series"}) {
                    evaluate(instrumentation, holder.get(), "window.contextResult='pending';contextFixture.verify('"+locale+"','"+kind+"').then(r=>{window.contextResult=r.width==="+width+"?'ok':'wrong viewport '+r.width;}).catch(e=>window.contextResult=String(e));");
                    String result = "\"pending\"";
                    for (int i = 0; i < 100 && "\"pending\"".equals(result); i++) {
                        Thread.sleep(100); result = evaluate(instrumentation, holder.get(), "window.contextResult");
                    }
                    assertEquals("locale="+locale+" kind="+kind+" width="+width+" textZoom="+zoom, "\"ok\"", result);
                }
            }
            System.out.println("CONTEXT_WEBVIEW_OK width="+width+" locales=10 textZooms=100,130 mediaTypes=2 cases=40");
        } finally { instrumentation.runOnMainSync(() -> holder.get().destroy()); }
    }
}
