package tv.norva.i18n;

import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import static org.junit.Assert.*;

/** Executes the actual generated release bundle in Android System WebView, offline. */
public class UiLanguageWebViewTest {
    @Test public void generatedBundleResolvesAllLocalesWithoutChangingProviderContent() throws Exception {
        final android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        final android.content.Context context = instrumentation.getTargetContext();
        final CountDownLatch loaded = new CountDownLatch(1);
        final AtomicReference<WebView> holder = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> {
            WebView view = new WebView(context);
            holder.set(view);
            view.getSettings().setJavaScriptEnabled(true);
            view.getSettings().setDomStorageEnabled(true);
            view.getSettings().setTextZoom(130);
            view.layout(0, 0, 1080, 1920);
            view.setWebViewClient(new WebViewClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebView webView, WebResourceRequest request) {
                    try {
                        String asset = request.getUrl().getPath();
                        if ("/js/i18n.js".equals(asset) || "/js/consent-banner.js".equals(asset)) {
                            return new WebResourceResponse("text/javascript", "UTF-8", instrumentation.getContext().getAssets().open(asset.substring(1)));
                        }
                    } catch (Exception ignored) { }
                    return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                }
                @Override public void onPageFinished(WebView webView, String url) { loaded.countDown(); }
            });
            String html = "<!doctype html><html><head><meta charset='UTF-8'><script src='/js/i18n.js'></script></head>"
                + "<body><h1 data-i18n='ui_settings'>Settings</h1><p id='provider' translate='no'>Provider Français العربية</p>"
                + "<script>window.NORVA_MARKETING_CONFIG={enabled:true};window.consentCalls=0;window.NorvaMarketing={setConsent:function(){window.consentCalls++;}};</script>"
                + "<script src='/js/consent-banner.js'></script></body></html>";
            view.loadDataWithBaseURL("https://norva-i18n.test/", html, "text/html", "UTF-8", null);
        });
        try {
            assertTrue("Packaged bundle loaded", loaded.await(45, TimeUnit.SECONDS));
            CountDownLatch evaluated = new CountDownLatch(1);
            AtomicReference<String> result = new AtomicReference<>();
            instrumentation.runOnMainSync(() -> holder.get().evaluateJavascript(
                "(function(){try{const api=window.NorvaI18n;if(!api)return 'missing bundle';let count=0;"
                + "const decline=document.querySelector('[data-consent=denied]');if(!decline)return 'missing consent';decline.focus();"
                + "for(const l of api.locales){if(!api.setPreference(l.code))return 'preference '+l.code;"
                + "if(document.documentElement.dir!==(l.code==='ar'?'rtl':'ltr'))return 'direction '+l.code;"
                + "if(document.getElementById('provider').textContent!=='Provider Français العربية')return 'provider changed';"
                + "const text=api.t('ui_trial_started_duration',{duration:'7'});if(text.includes('{{')||!text.includes('7'))return 'duration '+l.code;"
                + "if(api.t('ui_settings')==='ui_settings')return 'missing label '+l.code;count++;}"
                + "if(decline!==document.querySelector('[data-consent=denied]')||document.activeElement!==decline)return 'consent focus';"
                + "if(decline.textContent!==api.t('ui_web_a2d285b35287'))return 'stale consent language';"
                + "if(window.consentCalls||localStorage.getItem('norva_consent'))return 'consent changed';"
                + "api.setPreference('auto');return count;}catch(e){return String(e);}})()",
                value -> { result.set(value); evaluated.countDown(); }));
            assertTrue("JavaScript completed", evaluated.await(30, TimeUnit.SECONDS));
            assertEquals("All ten packaged locales", "10", result.get());
        } finally { instrumentation.runOnMainSync(() -> holder.get().destroy()); }
    }
}
