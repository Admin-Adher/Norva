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

/** Real Settings renderer and CSS; all requests stay inside test assets. */
public class SettingsGenreChipsInstrumentedTest {
    private static final String HTML = "<!doctype html><html lang='fr'><meta name='viewport' content='width=device-width, initial-scale=1'>"
        + "<link rel='stylesheet' href='/css/main.css'><body><main style='padding:16px'>"
        + "<div id='chips' class='genre-chips' role='group' aria-label='Genres favoris'></div>"
        + "<select id='genres' multiple></select></main>"
        + "<script src='/js/pages/Settings.js'></script></body></html>";

    private static String evaluate(android.app.Instrumentation instrumentation, WebView view, String js) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> view.evaluateJavascript(js, value -> { result.set(value); latch.countDown(); }));
        assertTrue("WebView responded", latch.await(20, TimeUnit.SECONDS));
        return result.get();
    }

    @Test public void portraitGenrePreferencesAtBothTextZooms() throws Exception { verify(360, 800); }
    @Test public void landscapeGenrePreferencesAtBothTextZooms() throws Exception { verify(844, 390); }

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
            view.loadDataWithBaseURL("https://norva-settings.test/", HTML, "text/html", "UTF-8", null);
        });
        try {
            assertTrue("Settings assets loaded", loaded.await(45, TimeUnit.SECONDS));
            for (int zoom : new int[] {100, 130}) {
                instrumentation.runOnMainSync(() -> holder.get().getSettings().setTextZoom(zoom));
                evaluate(instrumentation, holder.get(), "window.genreResult='pending';setTimeout(()=>{try{"
                    + "const host=document.getElementById('chips'),select=document.getElementById('genres');"
                    + "select.replaceChildren(new Option('Action','action',false,true),new Option('Science-fiction','science-fiction'),new Option('<img src=x onerror=bad()>','\"/><script>bad</script>'));"
                    + "const page=Object.create(SettingsPage.prototype);page.renderGenreChips(select,host);page.renderGenreChips(select,host);"
                    + "const chips=[...host.querySelectorAll('button')];if(chips.length!==3)throw Error('missing chips');"
                    + "if(chips[2].children.length||chips[2].textContent!==select.options[2].textContent||chips[2].dataset.value!==select.options[2].value)throw Error('unsafe text');"
                    + "if(chips[0].getAttribute('aria-pressed')!=='true')throw Error('initial selection');"
                    + "let changes=0;select.onchange=()=>changes++;chips[1].click();"
                    + "if(changes!==1||!select.options[1].selected||chips[1].getAttribute('aria-pressed')!=='true')throw Error('toggle failed or duplicate listener');"
                    + "chips[1].focus();if(document.activeElement!==chips[1])throw Error('focus failed');"
                    + "chips[1].click();if(changes!==2||select.options[1].selected||chips[1].getAttribute('aria-pressed')!=='false')throw Error('deselect failed');"
                    + "if(chips.some(chip=>chip.getBoundingClientRect().height<44))throw Error('small touch target');"
                    + "if(Math.abs(innerWidth-"+width+")>2)throw Error('viewport '+innerWidth);"
                    + "if(document.documentElement.scrollWidth>innerWidth+1)throw Error('horizontal overflow');"
                    + "window.genreResult='ok';}catch(e){window.genreResult=String(e);}},200);");
                String result = "\"pending\"";
                for (int i=0; i<30 && "\"pending\"".equals(result); i++) {
                    Thread.sleep(200); result = evaluate(instrumentation, holder.get(), "window.genreResult");
                }
                assertEquals("width="+width+" textZoom="+zoom, "\"ok\"", result);
            }
            System.out.println("SETTINGS_GENRES_WEBVIEW_OK width="+width+" textZooms=100,130");
        } finally { instrumentation.runOnMainSync(() -> holder.get().destroy()); }
    }
}
