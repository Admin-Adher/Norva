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
public class SubscriptionCancellationInstrumentedTest {
    private String evaluate(android.app.Instrumentation i, WebView view, String js) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        i.runOnMainSync(() -> view.evaluateJavascript(js, value -> { result.set(value); latch.countDown(); }));
        assertTrue(latch.await(20, TimeUnit.SECONDS));
        return result.get();
    }

    @Test public void cancellationAndRetryAtBothTextSizes() throws Exception {
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
                    if ("/js/cloudApi.js".equals(asset) || "/js/authApi.js".equals(asset) || "/js/billing.js".equals(asset)) asset = "/subscription-cancellation.js";
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
            evaluate(i, holder.get(), "window.cancelResult='pending';(async()=>{try{"
                + "const pause=()=>new Promise(r=>setTimeout(r,100));for(let j=0;j<30&&!document.querySelector('#content .plan-name');j++)await pause();"
                + "if(!document.querySelector('#content').textContent.includes('Norva Plus'))throw Error('plan missing');"
                + "const button=Array.from(document.querySelectorAll('#content button')).find(b=>b.textContent===NorvaI18n.t('ui_web_2e5d129831b6'));if(!button)throw Error('cancel missing');button.click();await pause();"
                + "let modal=document.querySelector('[role=dialog]');if(!modal||!modal.contains(document.activeElement))throw Error('dialog focus');"
                + "if(document.documentElement.scrollWidth>innerWidth+2)throw Error('horizontal overflow');"
                + "if(document.documentElement.lang==='fr'&&/It costs|Another reason|Le procès/.test(modal.textContent))throw Error('untranslated copy');"
                + "modal.querySelector('.danger').click();await pause();if(!document.querySelector('[role=dialog]'))throw Error('failed cancellation closed dialog');"
                + "if(modal.querySelector('.danger').disabled||modal.querySelector('[role=alert]').hidden)throw Error('retry unavailable');"
                + "if(modal.textContent.includes('private-backend'))throw Error('diagnostic exposed');"
                + "modal.querySelector('.danger').click();"
                + "}catch(e){window.cancelResult=String(e);}})();");
            String result = "false";
            for (int attempt = 0; attempt < 100 && !"true".equals(result); attempt++) {
                Thread.sleep(100);
                result = evaluate(i, holder.get(), "Boolean(document.querySelector('#content .pill')?.textContent===NorvaI18n.t('ui_sub_renewal_cancelled'))");
                String failure = evaluate(i, holder.get(), "window.cancelResult");
                if (!"null".equals(failure) && !"\"pending\"".equals(failure)) fail(failure);
            }
            assertEquals("Confirmed cancellation rendered after reload: " + language + "/" + zoom, "true", result);
            assertEquals("No upcoming price after cancellation", "false", evaluate(i, holder.get(), "document.querySelector('#content').textContent.includes('4.99')||document.querySelector('#content').textContent.includes('4,99')"));
        } finally { i.runOnMainSync(() -> holder.get().destroy()); }
    }
}
