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

/** Runs the production WebView language utility from generated, offline assets. */
public class CatalogLanguageAliasesInstrumentedTest {
    @Test public void catalogueLanguagesAtDefaultTextSize() throws Exception { verify(100); }
    @Test public void catalogueLanguagesAtLargerTextSize() throws Exception { verify(130); }

    private void verify(int zoom) throws Exception {
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        AtomicReference<WebView> holder = new AtomicReference<>();
        CountDownLatch loaded = new CountDownLatch(1), evaluated = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> {
            WebView view = new WebView(instrumentation.getTargetContext()); holder.set(view);
            view.getSettings().setJavaScriptEnabled(true);
            view.getSettings().setTextZoom(zoom);
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
            view.loadDataWithBaseURL("https://norva-languages.test/", "<!doctype html><html lang='fr'><meta name='viewport' content='width=device-width, initial-scale=1'><body><script src='/js/utils/mediaUtils.js'></script></body></html>", "text/html", "UTF-8", null);
        });
        try {
            assertTrue("Production utility loaded", loaded.await(30, TimeUnit.SECONDS));
            instrumentation.runOnMainSync(() -> holder.get().evaluateJavascript("(()=>{try{"
                + "const aliases={afr:'af',aze:'az',glg:'gl',guj:'gu',kan:'kn',kaz:'kk',khm:'km',kir:'ky',lat:'la',mal:'ml',mar:'mr',nep:'ne',oci:'oc',ori:'or',pan:'pa',scr:'hr',tgl:'tl',yor:'yo',zul:'zu'};"
                + "for(const [raw,code] of Object.entries(aliases)){"
                + "if(MediaUtils.normalizeLanguagePreference(raw)!==code)throw Error('alias '+raw);"
                + "const item={item_type:'movie',audio_tracks:[{index:1,lang:raw}],audio_tracks_scope:'file',audio_probed_at:'2026-09-10T10:00:00Z',audio_language_validation_status:'probed',audio_languages:[code],audio_languages_scope:'file',audio_languages_observed:true};"
                + "if(MediaUtils.versionDescriptor(item).headline==='Language unidentified')throw Error('missing badge '+raw);"
                + "if(!new Intl.DisplayNames(['fr'],{type:'language'}).of(code))throw Error('language label '+code);"
                + "}"
                + "const unprobed={item_type:'movie',raw_title:'FR | Film',audio_language_validation_status:'not_analyzed'};"
                + "if(MediaUtils.versionDescriptor(unprobed).headline!=='Language unidentified')throw Error('title guessed as audio');"
                + "return 'ok';}catch(e){return String(e);}})()", value -> {result.set(value); evaluated.countDown();}));
            assertTrue("WebView utility responded", evaluated.await(20, TimeUnit.SECONDS));
            assertEquals("textZoom="+zoom, "\"ok\"", result.get());
            System.out.println("CATALOG_LANGUAGE_ALIASES_WEBVIEW_OK aliases=19 textZoom="+zoom);
        } finally { instrumentation.runOnMainSync(() -> holder.get().destroy()); }
    }
}
