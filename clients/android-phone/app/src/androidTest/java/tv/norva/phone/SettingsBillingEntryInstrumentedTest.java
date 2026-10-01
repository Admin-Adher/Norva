package tv.norva.phone;

import android.webkit.*;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import static org.junit.Assert.*;

/** The real Settings renderer; fixture membership responses never leave the emulator. */
public class SettingsBillingEntryInstrumentedTest {
    private String evaluate(android.app.Instrumentation i, WebView view, String js) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        i.runOnMainSync(() -> view.evaluateJavascript(js, r -> { value.set(r); done.countDown(); }));
        assertTrue(done.await(15, TimeUnit.SECONDS));
        return value.get();
    }

    @Test public void ordinaryCustomerPurchaseEntryAndRailIsolation() throws Exception {
        android.app.Instrumentation i = InstrumentationRegistry.getInstrumentation();
        AtomicReference<WebView> holder = new AtomicReference<>();
        CountDownLatch loaded = new CountDownLatch(1);
        i.runOnMainSync(() -> {
            WebView v = new WebView(i.getTargetContext()); holder.set(v);
            v.getSettings().setJavaScriptEnabled(true);
            v.getSettings().setUseWideViewPort(true);
            v.setWebViewClient(new WebViewClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                    String p = req.getUrl().getPath();
                    try { return new WebResourceResponse(p.endsWith(".js") ? "text/javascript" : "text/css", "UTF-8",
                        i.getContext().getAssets().open(p.substring(1))); }
                    catch (Exception e) { return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0])); }
                }
                @Override public void onPageFinished(WebView view, String url) { loaded.countDown(); }
            });
            float d = i.getTargetContext().getResources().getDisplayMetrics().density;
            int w = Math.round(360*d), h = Math.round(800*d);
            v.measure(android.view.View.MeasureSpec.makeMeasureSpec(w,1073741824), android.view.View.MeasureSpec.makeMeasureSpec(h,1073741824));
            v.layout(0,0,w,h);
            v.loadDataWithBaseURL("https://settings-billing.test/?mobile=1",
                "<!doctype html><html><meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<link rel='stylesheet' href='/css/main.css'><body><main style='padding:16px'>"
                + "<div id='settings-access-plan'></div><p id='settings-access-hint'></p>"
                + "<button class='btn btn-secondary' id='settings-manage-plan-btn'></button></main>"
                + "<script src='/js/pages/Settings.js'></script></body></html>", "text/html", "UTF-8", null);
        });
        try {
            assertTrue(loaded.await(30,TimeUnit.SECONDS)); WebView v = holder.get();
            for (int zoom : new int[]{100,130}) {
                i.runOnMainSync(() -> v.getSettings().setTextZoom(zoom));
                evaluate(i,v,"window.proof='pending';(async()=>{try{"
                    + "window.NorvaBillingNative={postMessage(){}};window.NorvaI18n={t:(k,o)=>k==='ui_web_cc0e38da9c41'?'S’abonner':o.defaultValue};"
                    + "let state={status:'expired',projection:{provider:'revolut'}};window.NorvaCloud={entitlements:{get:async()=>state}};"
                    + "const page=Object.create(SettingsPage.prototype);page.app={currentUser:{cloud:true,email:'ordinary@example.test'}};"
                    + "const b=document.getElementById('settings-manage-plan-btn');await page.refreshAccessCard();"
                    + "if(b.style.display==='none'||b.textContent!=='S’abonner')throw Error('ordinary customer cannot subscribe');"
                    + "if(b.getBoundingClientRect().height<44||b.getBoundingClientRect().bottom>innerHeight)throw Error('unusable target');"
                    + "if(document.documentElement.scrollWidth>innerWidth+2)throw Error('overflow');"
                    + "state={status:'trialing',projection:{provider:'revolut'}};await page.refreshAccessCard();"
                    + "if(b.style.display!=='none')throw Error('second rail purchase');"
                    + "state={status:'expired',projection:{provider:'revolut'}};await page.refreshAccessCard();b.focus();"
                    + "if(document.activeElement!==b||b.style.display==='none')throw Error('return from expired state');"
                    + "window.proof='ok';}catch(e){window.proof=String(e);}})();");
                String result = "\"pending\"";
                for(int n=0;n<100&&"\"pending\"".equals(result);n++){Thread.sleep(100);result=evaluate(i,v,"window.proof");}
                assertEquals("textZoom="+zoom,"\"ok\"",result);
            }
        } finally { i.runOnMainSync(() -> holder.get().destroy()); }
    }
}
