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

/** Exercise the real wizard-to-progress transition in Android WebView. */
public class CatalogProgressModalInstrumentedTest {
    private String evaluate(android.app.Instrumentation instrumentation, WebView view, String js) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> view.evaluateJavascript(js, value -> { result.set(value); latch.countDown(); }));
        assertTrue("WebView responded", latch.await(20, TimeUnit.SECONDS));
        return result.get();
    }

    @Test public void portrait() throws Exception { verify(390, 844); }
    @Test public void smallPortrait() throws Exception { verify(360, 640); }
    @Test public void landscape() throws Exception { verify(844, 390); }

    private void verify(int width, int height) throws Exception {
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        android.content.Context context = instrumentation.getTargetContext();
        AtomicReference<WebView> holder = new AtomicReference<>();
        CountDownLatch loaded = new CountDownLatch(1);
        instrumentation.runOnMainSync(() -> {
            WebView view = new WebView(context); holder.set(view);
            view.getSettings().setJavaScriptEnabled(true);
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
            view.loadUrl("https://norva-modal.test/catalog-progress-modal.html");
        });
        try {
            assertTrue("Modal assets loaded", loaded.await(45, TimeUnit.SECONDS));
            evaluate(instrumentation, holder.get(), "window.conflictResult='pending';verifySourceConflict().then(v=>window.conflictResult=v).catch(e=>window.conflictResult=String(e));");
            String conflict = "\"pending\"";
            for (int i=0; i<50 && "\"pending\"".equals(conflict); i++) {
                Thread.sleep(100); conflict=evaluate(instrumentation, holder.get(), "window.conflictResult");
            }
            assertEquals("Source conflict has safe copy and no automatic resubmission", "\"ok\"", conflict);
            for (int zoom : new int[] {100, 130}) {
                instrumentation.runOnMainSync(() -> holder.get().getSettings().setTextZoom(zoom));
                evaluate(instrumentation, holder.get(), "window.modalResult='pending';openProgress().then(()=>setTimeout(()=>{try{"
                    + "const modal=document.getElementById('modal'),body=document.getElementById('modal-body'),footer=document.getElementById('modal-footer'),button=document.getElementById('catalog-background');"
                    + "if(modal.classList.contains('provider-access-wizard-modal'))throw Error('wizard layout retained');"
                    + "if(footer.hidden||button.getBoundingClientRect().height<44)throw Error('background action unavailable');"
                    + "if(parseFloat(getComputedStyle(body).paddingLeft)<16)throw Error('missing padding');"
                    + "if(document.documentElement.scrollWidth>innerWidth+1)throw Error('horizontal overflow');"
                    + "if(Math.abs(innerWidth-"+width+")>2)throw Error('unexpected viewport '+innerWidth);"
                    + "const f=footer.getBoundingClientRect();if(f.bottom>innerHeight+1||f.top<0)throw Error('footer outside viewport');"
                    + "if([...document.querySelectorAll('.source-sync-card strong')].some(e=>e.scrollWidth>e.clientWidth+1))throw Error('clipped counter');"
                    + "if(!document.querySelector('main').inert)throw Error('background is interactive');"
                    + "button.click();setTimeout(()=>{if(modal.classList.contains('active')||document.activeElement.id!=='open'||document.querySelector('main').inert)window.modalResult='close/focus failed';else window.modalResult='ok';},100);"
                    + "}catch(e){window.modalResult=String(e);}},200)).catch(e=>window.modalResult=String(e));");
                String result = "\"pending\"";
                for (int i=0; i<50 && "\"pending\"".equals(result); i++) {
                    Thread.sleep(200); result=evaluate(instrumentation, holder.get(), "window.modalResult");
                }
                assertEquals("width="+width+" textZoom="+zoom, "\"ok\"", result);
            }
            System.out.println("CATALOG_MODAL_WEBVIEW_OK width="+width+" textZooms=100,130");
        } finally { instrumentation.runOnMainSync(() -> holder.get().destroy()); }
    }
}
