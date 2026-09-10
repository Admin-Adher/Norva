package tv.norva.i18n;

import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import static org.junit.Assert.*;

/** Real Movie/Series renderers, CSS and ten packaged locales; synthetic, offline data only. */
public class CatalogVersionTagsWebViewTest {
    private static final String[] LOCALES = {"en", "fr", "pt-BR", "es", "hi", "tr", "bn", "ar", "id", "fil"};

    private static String evaluate(android.app.Instrumentation instrumentation, WebView view, String js) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> view.evaluateJavascript(js, value -> { result.set(value); done.countDown(); }));
        assertTrue("WebView responded", done.await(20, TimeUnit.SECONDS));
        return result.get();
    }

    // Phone packages test assets; TV packages the same production files under www/.
    private static InputStream asset(android.app.Instrumentation instrumentation, String path) throws Exception {
        try { return instrumentation.getContext().getAssets().open(path); }
        catch (java.io.IOException missingTestAsset) {
            return instrumentation.getTargetContext().getAssets().open("www/" + path);
        }
    }

    @Test public void portraitProviderHintsRemainSecondaryAtBothTextScales() throws Exception { verify(360, 800); }
    @Test public void landscapeProviderHintsRemainSecondaryAtBothTextScales() throws Exception { verify(844, 390); }

    private void verify(int width, int height) throws Exception {
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        for (int zoom : new int[] {100, 130}) {
            Configuration configuration = new Configuration(instrumentation.getTargetContext().getResources().getConfiguration());
            configuration.fontScale = zoom / 100f;
            Context context = instrumentation.getTargetContext().createConfigurationContext(configuration);
            AtomicReference<WebView> holder = new AtomicReference<>();
            CountDownLatch loaded = new CountDownLatch(1);
            instrumentation.runOnMainSync(() -> {
                WebView view = new WebView(context); holder.set(view);
                view.getSettings().setJavaScriptEnabled(true);
                view.getSettings().setDomStorageEnabled(true);
                view.getSettings().setUseWideViewPort(true);
                view.getSettings().setTextZoom(zoom);
                view.setWebChromeClient(new android.webkit.WebChromeClient() {
                    @Override public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
                        System.out.println("CATALOG_TAGS_CONSOLE " + message.message());
                        return true;
                    }
                });
                view.setWebViewClient(new WebViewClient() {
                    @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                        if ("norva-tags.test".equals(request.getUrl().getHost())) {
                            try {
                                String path = request.getUrl().getPath().substring(1);
                                String mime = path.endsWith(".css") ? "text/css" : path.endsWith(".js") ? "text/javascript" : "application/octet-stream";
                                return new WebResourceResponse(mime, "UTF-8", asset(instrumentation, path));
                            } catch (Exception missingAsset) {
                                System.out.println("CATALOG_TAGS_MISSING_ASSET " + request.getUrl().getPath());
                            }
                        }
                        // No provider, account, analytics or external requests can leave this fixture.
                        return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                    }
                    @Override public void onPageFinished(WebView v, String url) {
                        if (url.startsWith("https://norva-tags.test/")) loaded.countDown();
                    }
                });
                float density = context.getResources().getDisplayMetrics().density;
                int w = Math.round(width * density), h = Math.round(height * density);
                view.measure(android.view.View.MeasureSpec.makeMeasureSpec(w, android.view.View.MeasureSpec.EXACTLY), android.view.View.MeasureSpec.makeMeasureSpec(h, android.view.View.MeasureSpec.EXACTLY));
                view.layout(0, 0, w, h);
                String html = "<!doctype html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
                    + "<link rel='stylesheet' href='/css/main.css'><script src='/js/i18n.js'></script>"
                    + "<script src='/js/utils/mediaUtils.js'></script><script src='/js/pages/MoviesPage.js'></script><script src='/js/pages/SeriesPage.js'></script></head>"
                    + "<body><main><section id='fixture-section' class='movie-versions-section'><h1>Synthetic version fixture</h1><p id='summary'></p><div id='versions' class='movie-versions-list'></div></section></main></body></html>";
                view.loadDataWithBaseURL("https://norva-tags.test/", html, "text/html", "UTF-8", null);
            });
            try {
                assertTrue("Packaged renderer loaded", loaded.await(45, TimeUnit.SECONDS));
                assertEquals("Production dependencies present", "\"object,object,function,function\"", evaluate(instrumentation, holder.get(),
                    "[typeof NorvaI18n,typeof MediaUtils,typeof MoviesPage,typeof SeriesPage].join(',')"));
                evaluate(instrumentation, holder.get(), "window.tagFontsReady=false;document.fonts.ready.then(()=>window.tagFontsReady=true);");
                String fontsReady = "false";
                for (int attempt = 0; attempt < 100 && !"true".equals(fontsReady); attempt++) {
                    Thread.sleep(100);
                    fontsReady = evaluate(instrumentation, holder.get(), "window.tagFontsReady");
                }
                assertEquals("Packaged fonts settled", "true", fontsReady);
                for (String locale : LOCALES) for (String kind : new String[] {"movie", "series"}) {
                    String result = evaluate(instrumentation, holder.get(), fixtureScript(locale, kind, width));
                    assertEquals("locale="+locale+" media="+kind+" width="+width+" contextFontScale="+configuration.fontScale+" textZoom="+zoom,
                        "\"ok\"", result);
                    if (zoom == 130 && ("fr".equals(locale) || "hi".equals(locale) || "ar".equals(locale))) {
                        saveCapture(instrumentation, holder.get(), "catalog-tags-"+kind+"-"+locale+"-"+width+"-"+zoom+".png");
                    }
                }
                System.out.println("CATALOG_TAGS_WEBVIEW_OK width="+width+" textZoom="+zoom+" contextFontScale="+configuration.fontScale+" locales=10 mediaTypes=2 prefixes=8 evidenceStates=2");
            } finally { instrumentation.runOnMainSync(() -> holder.get().destroy()); }
        }
    }

    private static String fixtureScript(String locale, String kind, int width) {
        return "(()=>{try{const api=NorvaI18n,M=MediaUtils;api.setPreference('"+locale+"');"
            + "const prefixes=['AR','DE','GR','HU','NL','PL','RU','SO'];const unknown=prefixes.map((p,i)=>({raw_title:p+' - Example Film',name:p+' - Example Film',stream_id:'fixture-'+i,series_id:'fixture-'+i,sourceId:'synthetic',container_extension:'mkv',audio_language_validation_status:'not_analyzed'}));"
            + "const verified=unknown.map(x=>({...x,stream_id:x.stream_id+'-verified',series_id:x.series_id+'-verified',audio_language_validation_status:'verified',audio_tracks_scope:'file',audio_tracks:[{index:0,lang:'eng'}]}));"
            + "const section=document.querySelector('main section'),list=document.getElementById('versions');"
            + "section.id='"+kind+"-versions-section';section.className='"+kind+"-versions-section';list.className='"+kind+"-versions-list';"
            + "const p=Object.create(('"+kind+"'==='movie'?MoviesPage:SeriesPage).prototype);p.versionsList=list;p.versionSummary=document.getElementById('summary');p.getSourceName=()=> 'Synthetic source';p.getMovieWatchState=()=>({});p.getPreferences=()=>({});p.isBrokenItem=()=>false;p.isSameSeriesVersion=(a,b)=>a===b;p._isTvMode=()=>false;"
            + "for(const fixtures of [unknown,verified]){const before=JSON.stringify(fixtures);p.currentMovieVersions=fixtures;p.currentMovie=fixtures[0];p.currentSeriesGroup={items:fixtures};p.currentSeries=fixtures[0];"
            + "if('"+kind+"'==='movie')p.renderMovieVersions();else p.renderSeriesVersions();"
            + "const ordered='"+kind+"'==='movie'?fixtures:p._orderedVersions;const cards=Array.from(list.querySelectorAll('button'));if(cards.length!==8)return 'card count '+cards.length;const seen=new Set();"
            + "for(let i=0;i<cards.length;i++){const item=ordered[i],card=cards[i],d=M.versionDescriptor(item,{siblings:fixtures,resolveSourceName:p.getSourceName}),headline=card.querySelector('.version-headline'),meta=card.querySelector('.version-meta'),prefix=item.raw_title.slice(0,2);"
            + "if(headline.textContent!==p.displayLanguageStatus(d.headline))return 'renderer headline';if(meta.textContent!==d.meta)return 'renderer meta';"
            + "const hint=api.t('ui_web_38fc9a457587',{defaultValue:'{{p0}} · Provider label',p0:prefix});if(!meta.textContent.startsWith(hint+' · '))return 'missing qualification '+prefix;"
            + "if(fixtures===unknown){if(d.audioSource==='file')return 'hint promoted to evidence';if(M.analyzeLanguageCompatibility(item,{preferredAudioLanguage:'hu'}).audio.state!=='unknown')return 'hint promoted to compatibility';}"
            + "else {if(d.headline!==M.languageDisplayFull('en')||d.audioSource!=='file')return 'observed soundtrack lost';if(M.analyzeLanguageCompatibility(item,{preferredAudioLanguage:'hu'}).audio.state!=='confirmed_absent')return 'hint overrides observed audio';}"
            + "const rect=card.getBoundingClientRect();if(rect.width<44||rect.height<44||rect.left< -1||rect.right>innerWidth+1)return 'card bounds '+JSON.stringify({w:rect.width,h:rect.height,l:rect.left,r:rect.right,v:innerWidth});"
            + "if(getComputedStyle(meta).color==='rgba(0, 0, 0, 0)'||getComputedStyle(headline).fontSize==='0px')return 'invisible label';"
            + "const range=document.createRange();range.setStart(meta.firstChild,0);range.setEnd(meta.firstChild,hint.length);if(range.getBoundingClientRect().width>meta.clientWidth+1)return 'qualified hint clipped '+prefix;seen.add(meta.textContent);"
            + "}if(seen.size!==8)return 'indistinguishable versions';if(JSON.stringify(fixtures)!==before)return 'fixture mutated';}"
            + "if(document.documentElement.dir!==('"+locale+"'==='ar'?'rtl':'ltr'))return 'direction';if(Math.abs(innerWidth-"+width+")>2)return 'viewport '+innerWidth;if(document.documentElement.scrollWidth>innerWidth+1)return 'horizontal overflow';"
            + "p.currentMovieVersions=unknown;p.currentSeriesGroup={items:unknown};if('"+kind+"'==='movie')p.renderMovieVersions();else p.renderSeriesVersions();return 'ok';}catch(e){return String(e)}})()";
    }

    private static void saveCapture(android.app.Instrumentation instrumentation, WebView view, String name) throws Exception {
        AtomicReference<Exception> failure = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> {
            Bitmap bitmap = Bitmap.createBitmap(view.getWidth(), view.getHeight(), Bitmap.Config.ARGB_8888);
            try {
                view.draw(new Canvas(bitmap));
                File target = new File(instrumentation.getTargetContext().getExternalFilesDir(null), name);
                try (FileOutputStream stream = new FileOutputStream(target)) { bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream); }
                System.out.println("CATALOG_TAGS_CAPTURE "+target.getAbsolutePath());
            } catch (Exception exception) { failure.set(exception); }
            finally { bitmap.recycle(); }
        });
        if (failure.get() != null) throw failure.get();
    }
}
