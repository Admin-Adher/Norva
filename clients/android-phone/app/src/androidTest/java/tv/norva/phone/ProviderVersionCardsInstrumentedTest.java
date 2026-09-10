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

/** Real localized version renderers and CSS; source/episode selection I/O is stubbed. */
public class ProviderVersionCardsInstrumentedTest {
    private static final String HTML = "<!doctype html><html lang='fr'><meta name='viewport' content='width=device-width, initial-scale=1'>"
        + "<link rel='stylesheet' href='/css/main.css'><link rel='stylesheet' href='/css/i18n.css'>"
        + "<style>body{overflow:auto}main{padding:var(--space-md)}</style><body><main id='qa-host'></main>"
        + "<script src='/js/i18n.js'></script><script src='/js/utils/mediaUtils.js'></script>"
        + "<script src='/js/pages/MoviesPage.js'></script><script src='/js/pages/SeriesPage.js'></script>"
        + "<script src='/provider-version-cards.js'></script></body></html>";

    private static String evaluate(android.app.Instrumentation instrumentation, WebView view, String js) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> view.evaluateJavascript(js, value -> { result.set(value); latch.countDown(); }));
        assertTrue("WebView responded", latch.await(20, TimeUnit.SECONDS));
        return result.get();
    }

    @Test public void portraitVersionCardsAtBothTextZooms() throws Exception { verify(360, 800); }
    @Test public void landscapeVersionCardsAtBothTextZooms() throws Exception { verify(844, 390); }

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
                        String mime = path.endsWith(".css") ? "text/css" : path.endsWith(".js") ? "text/javascript" : "application/octet-stream";
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
            view.loadDataWithBaseURL("https://norva-versions.test/", HTML, "text/html", "UTF-8", null);
        });
        try {
            assertTrue("Version renderer assets loaded", loaded.await(45, TimeUnit.SECONDS));
            for (int zoom : new int[] {100, 130}) {
                instrumentation.runOnMainSync(() -> holder.get().getSettings().setTextZoom(zoom));
                for (String locale : new String[] {"fr", "en", "hi", "ar", "bn", "fil"}) {
                    for (String kind : new String[] {"movie", "series"}) {
                        evaluate(instrumentation, holder.get(), "window.versionResult='pending';(async()=>{try{"
                            + "await NorvaI18n.setPreference('"+locale+"');ProviderVersionCardsQA.mount('"+kind+"');"
                            + "await new Promise(r=>setTimeout(r,150));ProviderVersionCardsQA.verify();"
                            + "if(Math.abs(innerWidth-"+width+")>2)throw Error('viewport '+innerWidth);"
                            + "window.versionResult='ok';}catch(e){window.versionResult=String(e);}})();");
                        String result = "\"pending\"";
                        for (int i=0; i<40 && "\"pending\"".equals(result); i++) {
                            Thread.sleep(100); result = evaluate(instrumentation, holder.get(), "window.versionResult");
                        }
                        assertEquals("width="+width+" textZoom="+zoom+" locale="+locale+" kind="+kind, "\"ok\"", result);
                    }
                }
            }
            System.out.println("PROVIDER_VERSION_CARDS_WEBVIEW_OK width="+width+" textZooms=100,130 locales=6 kinds=movie,series");
        } finally { instrumentation.runOnMainSync(() -> holder.get().destroy()); }
    }
}
