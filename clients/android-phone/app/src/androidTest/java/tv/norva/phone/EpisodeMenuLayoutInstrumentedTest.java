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

/** Actual episode renderer and CSS in Android WebView, without a media session. */
public class EpisodeMenuLayoutInstrumentedTest {
    private static final String HTML = "<!doctype html><html lang='fr'><meta name='viewport' content='width=device-width, initial-scale=1'>"
        + "<link rel='stylesheet' href='/css/main.css'><body>"
        + "<div class='watch-episodes-menu' style='position:relative;width:300px;margin:16px'>"
        + "<div id='episodes' class='captions-menu-list'></div></div>"
        + "<script src='/js/i18n.js'></script><script src='/js/utils/mediaUtils.js'></script>"
        + "<script src='/js/pages/WatchPage.js'></script></body></html>";

    private static String evaluate(android.app.Instrumentation instrumentation, WebView view, String js) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> view.evaluateJavascript(js, value -> { result.set(value); latch.countDown(); }));
        assertTrue("WebView responded", latch.await(20, TimeUnit.SECONDS));
        return result.get();
    }

    @Test public void portraitEpisodeLabelsAtBothTextZooms() throws Exception { verify(360, 800); }
    @Test public void landscapeEpisodeLabelsAtBothTextZooms() throws Exception { verify(844, 390); }

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
            view.loadDataWithBaseURL("https://norva-episodes.test/", HTML, "text/html", "UTF-8", null);
        });
        try {
            assertTrue("Episode assets loaded", loaded.await(45, TimeUnit.SECONDS));
            for (int zoom : new int[] {100, 130}) {
                instrumentation.runOnMainSync(() -> holder.get().getSettings().setTextZoom(zoom));
                evaluate(instrumentation, holder.get(), "window.episodeResult='pending';setTimeout(()=>{try{"
                    + "NorvaI18n.setPreference('fr');const page=Object.create(WatchPage.prototype);"
                    + "page.episodesNavList=document.getElementById('episodes');"
                    + "page.seriesInfo={episodes:{2:[{id:'selection-1',episode_num:1,selectionUnit:{seasons:[2],episode:1}},"
                    + "{id:'selection-2',episode_num:2,selectionUnit:{seasons:[2],episode:2}},"
                    + "{id:'ordinary',episode_num:3,title:'Une visite inattendue et une très longue conversation qui doit rester entièrement lisible'}]}};"
                    + "page.isCurrentEpisode=ep=>ep.id==='selection-2';page.closeEpisodesMenu=()=>{};page.playEpisode=ep=>window.chosenEpisode=ep.id;page.renderEpisodesMenu();"
                    + "if(Math.abs(innerWidth-"+width+")>2)throw Error('viewport '+innerWidth);"
                    + "const rows=[...document.querySelectorAll('.watch-ep-option')];if(rows.length!==3)throw Error('rows');"
                    + "for(const row of rows){const title=row.querySelector('.watch-ep-title'),r=row.getBoundingClientRect(),t=title.getBoundingClientRect();"
                    + "if(t.width<150)throw Error('title squeezed to '+t.width);if(title.scrollWidth>title.clientWidth+1)throw Error('text clipped');"
                    + "if(t.right>r.right+1||t.bottom>r.bottom+1)throw Error('text outside row');if(r.height<44)throw Error('small touch target');}"
                    + "if(!rows[0].textContent.includes('Épisode 1'))throw Error('missing French label');"
                    + "if(rows[2].children.length!==2||rows[2].getBoundingClientRect().height<=44)throw Error('number or wrapping');"
                    + "if(document.documentElement.scrollWidth>innerWidth+1)throw Error('horizontal overflow');"
                    + "rows[1].click();if(chosenEpisode!=='selection-2')throw Error('wrong episode');"
                    + "window.episodeResult='ok';}catch(e){window.episodeResult=String(e);}},200);");
                String result = "\"pending\"";
                for (int i=0; i<30 && "\"pending\"".equals(result); i++) {
                    Thread.sleep(200); result = evaluate(instrumentation, holder.get(), "window.episodeResult");
                }
                assertEquals("width="+width+" textZoom="+zoom, "\"ok\"", result);
            }
            System.out.println("EPISODE_WEBVIEW_OK width="+width+" textZooms=100,130");
        } finally { instrumentation.runOnMainSync(() -> holder.get().destroy()); }
    }
}
