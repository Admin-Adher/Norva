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
            view.getSettings().setUseWideViewPort(true);
            view.setWebViewClient(new WebViewClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                    try {
                        String path = request.getUrl().getPath();
                        String mime = path.endsWith(".css") ? "text/css" : path.endsWith(".js") ? "text/javascript" : "application/octet-stream";
                        return new WebResourceResponse(mime, "UTF-8", instrumentation.getContext().getAssets().open(path.substring(1)));
                    } catch (Exception ignored) {
                        return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                    }
                }
                @Override public void onPageFinished(WebView v, String url) { loaded.countDown(); }
            });
            float density = instrumentation.getTargetContext().getResources().getDisplayMetrics().density;
            int width = Math.round(360 * density), height = Math.round(800 * density);
            view.measure(android.view.View.MeasureSpec.makeMeasureSpec(width, android.view.View.MeasureSpec.EXACTLY), android.view.View.MeasureSpec.makeMeasureSpec(height, android.view.View.MeasureSpec.EXACTLY));
            view.layout(0, 0, width, height);
            view.loadDataWithBaseURL("https://norva-languages.test/", "<!doctype html><html lang='fr'><meta name='viewport' content='width=device-width, initial-scale=1'><link rel='stylesheet' href='/css/main.css'><body><script src='/js/utils/mediaUtils.js'></script></body></html>", "text/html", "UTF-8", null);
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
                + "for(const locale of ['fr','en','ar']) for(const code of ['fa','ur','tl','gu','or','yue','sq','bs','hr','sr','sl','mk','sw']){"
                + "document.documentElement.lang=locale;document.documentElement.dir=locale==='ar'?'rtl':'ltr';"
                + "const owned={item_type:'movie',provider_audio_languages:[code],provider_audio_language_status:'provider_declared'};"
                + "const presentation=MediaUtils.catalogLanguageInfo(owned);"
                + "if(presentation.text!==MediaUtils.languageDisplayFull(code))throw Error('owned declaration hidden '+code);"
                + "document.body.innerHTML='<div class=movie-card style=\"width:240px;height:320px;margin:24px\"><div class=movie-poster style=\"height:100%\">'+MediaUtils.languageBadgeHtml(presentation)+'</div></div>';"
                + "const badge=document.querySelector('.catalog-language-badge'),label=badge.querySelector('.language-badge-label'),poster=badge.closest('.movie-poster');"
                + "if(badge.getAttribute('aria-label')!==presentation.accessibleHeadline)throw Error('owned accessible label '+code);"
                + "if(label.scrollWidth>label.clientWidth+1||label.scrollHeight>label.clientHeight+1)throw Error('owned clipped label '+code);"
                + "const r=label.getBoundingClientRect(),p=poster.getBoundingClientRect();if(r.left<p.left-1||r.right>p.right+1||r.bottom>p.bottom+1)throw Error('owned badge overflow '+code);"
                + "if(/vérifier|verify|unverified|provider_declared/.test(badge.outerHTML))throw Error('internal diagnostic leaked');"
                + "}"
                + "const unprobed={item_type:'movie',raw_title:'FR | Film',audio_language_validation_status:'not_analyzed'};"
                + "if(MediaUtils.versionDescriptor(unprobed).headline!=='Language unidentified')throw Error('title guessed as audio');"
                + "return 'ok';}catch(e){return String(e);}})()", value -> {result.set(value); evaluated.countDown();}));
            assertTrue("WebView utility responded", evaluated.await(20, TimeUnit.SECONDS));
            assertEquals("textZoom="+zoom, "\"ok\"", result.get());
            System.out.println("CATALOG_LANGUAGE_ALIASES_WEBVIEW_OK aliases=19 ownedLanguageCases=39 textZoom="+zoom);
        } finally { instrumentation.runOnMainSync(() -> holder.get().destroy()); }
    }
}
