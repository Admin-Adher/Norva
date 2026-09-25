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

/** Production account page in System WebView; every account/billing response is offline. */
public class SubscriptionRetentionInstrumentedTest {
    private String evaluate(android.app.Instrumentation i, WebView view, String js) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        i.runOnMainSync(() -> view.evaluateJavascript(js, value -> { result.set(value); latch.countDown(); }));
        assertTrue(latch.await(20, TimeUnit.SECONDS));
        return result.get();
    }

    @Test public void retentionAndRetryAtBothTextSizes() throws Exception {
        for (int zoom : new int[] {100, 130}) verify("fr", zoom);
        verify("ar", 130);
    }

    private void verify(String language, int zoom) throws Exception {
        final android.app.Instrumentation i = InstrumentationRegistry.getInstrumentation();
        final AtomicReference<WebView> holder = new AtomicReference<>();
        final CountDownLatch loaded = new CountDownLatch(1);
        i.runOnMainSync(() -> {
            WebView view = new WebView(i.getTargetContext()); holder.set(view);
            view.getSettings().setJavaScriptEnabled(true);
            view.getSettings().setDomStorageEnabled(true);
            view.getSettings().setUseWideViewPort(true);
            view.getSettings().setTextZoom(zoom);
            view.setWebViewClient(new WebViewClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                    String asset = request.getUrl().getPath();
                    if ("/js/cloudApi.js".equals(asset) || "/js/authApi.js".equals(asset) || "/js/billing.js".equals(asset)) asset = "/subscription-retention.js";
                    try {
                        String type = asset.endsWith(".html") ? "text/html" : asset.endsWith(".js") ? "text/javascript" : asset.endsWith(".css") ? "text/css" : "application/octet-stream";
                        return new WebResourceResponse(type, "UTF-8", i.getContext().getAssets().open(asset.substring(1)));
                    } catch (Exception ignored) {
                        return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                    }
                }
                @Override public void onPageFinished(WebView view, String url) { loaded.countDown(); }
            });
            float density = i.getTargetContext().getResources().getDisplayMetrics().density;
            int w = Math.round(360 * density), h = Math.round(800 * density);
            view.measure(android.view.View.MeasureSpec.makeMeasureSpec(w, android.view.View.MeasureSpec.EXACTLY), android.view.View.MeasureSpec.makeMeasureSpec(h, android.view.View.MeasureSpec.EXACTLY));
            view.layout(0, 0, w, h);
            view.loadUrl("https://norva-cancel.test/subscription.html?lang=" + language + "&fail=1&run=" + System.nanoTime());
        });
        try {
            assertTrue(loaded.await(45, TimeUnit.SECONDS));
            evaluate(i, holder.get(), "window.retentionResult='pending';(async()=>{try{"
                + "const pause=()=>new Promise(r=>setTimeout(r,100));for(let j=0;j<50&&!document.querySelector('.retention-offer button');j++)await pause();"
                + "const card=document.querySelector('.retention-offer');if(!card?.textContent.includes(NorvaI18n.t('ui_ret_title')))throw Error('offer missing');"
                + "if(document.documentElement.scrollWidth>innerWidth+2)throw Error('horizontal overflow');"
                + "for(const b of card.querySelectorAll('button'))if(b.getBoundingClientRect().height<44)throw Error('small touch target');"
                + "card.querySelector('button').click();await pause();"
                + "if(card.textContent.includes('private-diagnostic')||!card.textContent.includes(NorvaI18n.t('ui_ret_error')))throw Error('unsafe or missing error');"
                + "card.querySelector('button').click();await pause();"
                + "card.querySelector('button').click();"
                + "}catch(e){window.retentionResult=String(e);}})();");
            String result = "false";
            for (int attempt = 0; attempt < 100 && !"true".equals(result); attempt++) {
                Thread.sleep(100);
                result = evaluate(i, holder.get(), "Boolean(document.querySelector('#content .detail')?.parentNode.textContent.includes(NorvaI18n.t('ui_ret_remaining_monthly',{cycles:3,base:new Intl.NumberFormat(document.documentElement.lang,{style:'currency',currency:'USD'}).format(4.99)})))");
                String failure = evaluate(i, holder.get(), "window.retentionResult");
                if (!"null".equals(failure) && !"\"pending\"".equals(failure)) fail(failure);
            }
            // Use the fixture's persisted state as the reload proof; localized
            // status keys are deliberately not coupled to implementation naming.
            assertEquals("Accepted offer persisted: " + language + "/" + zoom, "true", evaluate(i, holder.get(), "Array.from({length:sessionStorage.length},(_,i)=>sessionStorage.key(i)).some(k=>sessionStorage.getItem(k)==='accept')"));
            assertEquals("Remaining discounted cycles and normal price shown", "true", result);
        } finally { i.runOnMainSync(() -> holder.get().destroy()); }
    }
}
