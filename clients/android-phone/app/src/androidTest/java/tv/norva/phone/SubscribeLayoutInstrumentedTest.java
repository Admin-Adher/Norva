package tv.norva.phone;

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

/** Actual subscription HTML/CSS/JS in Android System WebView; offline, no purchases. */
public class SubscribeLayoutInstrumentedTest {
    private static final String BILLING = "window.NorvaAuth={getSession:()=>null};"
        + "window.NorvaCloud={entitlements:{device:async()=>({status:'none'})},billing:{trialEligibility:async()=>({eligible:true})}};"
        + "window.NorvaBilling={isNative:()=>false,isTvShell:()=>false,isRevolutEnabled:()=>true,hasNativeBilling:()=>false,isWebBillingConfigured:()=>false,"
        + "revolutPrices:async()=>({prices:{plus:{monthly:499,annual:4399},family:{monthly:949,annual:7999}}}),purchase:()=>{throw Error('Offline fixture');}};";
    private static final String NATIVE_BILLING = "window.NorvaAuth={getSession:()=>({user:{id:'offline-qa'}})};"
        + "window.NorvaCloud={entitlements:{get:async()=>({status:'none'})},billing:{trialEligibility:async()=>({eligible:false})}};"
        + "window.NorvaBilling={isNative:()=>true,isTvShell:()=>false,isRevolutEnabled:()=>false,hasNativeBilling:()=>true,isWebBillingConfigured:()=>false,"
        + "nativeOfferings:async()=>({appUserId:'offline-qa',currentOfferingId:'default',packages:["
        + "['$rc_monthly','norva_plus','P1M',4990000],['$rc_annual','norva_plus','P1Y',43990000],"
        + "['family_monthly','norva_family','P1M',9490000],['family_annual','norva_family','P1Y',79990000]"
        + "].map(([packageId,productId,periodIso8601,priceMicros])=>({packageId,productId,periodIso8601,priceMicros,"
        + "offeringId:'default',currencyCode:'EUR',priceString:(priceMicros/1000000)+' EUR',supported:true,trialEligibility:'ineligible'}))}),"
        + "purchase:()=>{throw Error('Offline fixture');}};";

    private static String evaluate(android.app.Instrumentation instrumentation, WebView view, String js) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> view.evaluateJavascript(js, value -> {result.set(value); latch.countDown();}));
        assertTrue("WebView responded", latch.await(20, TimeUnit.SECONDS));
        return result.get();
    }

    @Test public void portraitLocalesReflowAtBothTextZooms() throws Exception { verifyAtWidth(360, 800, false); }
    @Test public void landscapeLocalesReflowAtBothTextZooms() throws Exception { verifyAtWidth(844, 390, false); }
    @Test public void nativeSavingsFollowSelectedPlanInEveryLocale() throws Exception { verifyAtWidth(360, 800, true); }

    private void verifyAtWidth(int width, int height, boolean nativeBilling) throws Exception {
        final android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        final android.content.Context context = instrumentation.getTargetContext();
        final AtomicReference<WebView> holder = new AtomicReference<>();
        final CountDownLatch loaded = new CountDownLatch(1);
        instrumentation.runOnMainSync(() -> {
            WebView view = new WebView(context); holder.set(view);
            view.getSettings().setJavaScriptEnabled(true);
            view.getSettings().setDomStorageEnabled(true);
            view.getSettings().setUseWideViewPort(true);
            view.setWebViewClient(new WebViewClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                    String asset = request.getUrl().getPath();
                    if ("/js/cloudApi.js".equals(asset) || "/js/authApi.js".equals(asset) || "/js/billing.js".equals(asset))
                        return new WebResourceResponse("text/javascript", "UTF-8", new ByteArrayInputStream((nativeBilling ? NATIVE_BILLING : BILLING).getBytes(StandardCharsets.UTF_8)));
                    try {
                        String type = asset.endsWith(".css") ? "text/css" : asset.endsWith(".js") ? "text/javascript" : asset.endsWith(".html") ? "text/html" : asset.endsWith(".svg") ? "image/svg+xml" : asset.endsWith(".woff2") ? "font/woff2" : "image/png";
                        return new WebResourceResponse(type, "UTF-8", instrumentation.getContext().getAssets().open(asset.substring(1)));
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
            view.loadUrl("https://norva-subscribe.test/subscribe.html?returnTo=%2Fapp%23watch");
        });
        try {
            assertTrue("Subscription assets loaded", loaded.await(45, TimeUnit.SECONDS));
            for (int zoom : new int[] {100, 130}) {
                float density = context.getResources().getDisplayMetrics().density;
                instrumentation.runOnMainSync(() -> {
                    WebView view=holder.get();view.getSettings().setTextZoom(zoom);
                    int w=Math.round(width*density),h=Math.round(height*density);
                    view.measure(android.view.View.MeasureSpec.makeMeasureSpec(w, android.view.View.MeasureSpec.EXACTLY),android.view.View.MeasureSpec.makeMeasureSpec(h, android.view.View.MeasureSpec.EXACTLY));
                    view.layout(0,0,w,h);
                });
                evaluate(instrumentation, holder.get(), "window.subscribeResult='pending';(async()=>{try{const pause=()=>new Promise(r=>setTimeout(r,120));await pause();"
                    + "if(Math.abs(innerWidth-"+width+")>2)throw Error('viewport '+innerWidth);"
                    + "for(const locale of NorvaI18n.locales){NorvaI18n.setPreference(locale.code);document.querySelector('[data-period=annual]').click();await pause();"
                    + "const saving=document.querySelector('.toggle .save');for(const [plan,percent] of [['plus',27],['family',30],['plus',27]]){document.querySelector('[data-plan='+plan+'] .plan-choice-input').click();if(saving.hidden||saving.textContent!==NorvaPlanSelectionUi.copy.savePercent(percent))throw Error('annual saving '+plan+' '+locale.code+' '+saving.textContent);}"
                    + "if(document.documentElement.scrollWidth>innerWidth+2)throw Error('overflow '+locale.code);"
                    + "const title=document.querySelector('.shared-benefits h2');if(title.getBoundingClientRect().height>90)throw Error('title '+locale.code);"
                    + "if(document.querySelector('#continue-plan').disabled)throw Error('disabled '+locale.code);"
                    + "if(locale.code!=='en'&&/billed annually|per month/.test(document.querySelector('.price-note').textContent))throw Error('English '+locale.code);"
                    + "const decision=document.querySelector('.plan-decision');for(let attempt=0;attempt<10;attempt++){const required=Math.ceil(decision.getBoundingClientRect().height)+24;const reserved=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--plan-decision-space'))||0;if(reserved>=required)break;await pause();}"
                    + "await document.fonts.ready;let bottomSettled=false;for(let attempt=0;attempt<15;attempt++){const before=document.documentElement.scrollHeight;scrollTo({top:before,behavior:'instant'});await pause();const after=document.documentElement.scrollHeight;if(before===after&&Math.abs(after-innerHeight-scrollY)<=2){bottomSettled=true;break;}}if(!bottomSettled)throw Error('bottom layout did not settle '+locale.code);"
                    + "const top=document.querySelector('.plan-decision').getBoundingClientRect().top;"
                    + "for(const a of document.querySelectorAll('.note a')){const b=a.getBoundingClientRect();if(b.bottom>top+1)throw Error('covered '+JSON.stringify({locale:locale.code,bottom:b.bottom,top,scrollY,height:innerHeight,scrollHeight:document.documentElement.scrollHeight,decisionHeight:decision.getBoundingClientRect().height,reserved:getComputedStyle(document.documentElement).getPropertyValue('--plan-decision-space'),padding:getComputedStyle(document.querySelector('.commerce-main')).paddingBottom}));if(b.width<44||b.height<44)throw Error('touch target '+locale.code);}"
                    + "}window.subscribeResult='ok';}catch(e){window.subscribeResult=String(e);}})();");
                String result = "\"pending\"";
                for (int attempt=0;attempt<80 && "\"pending\"".equals(result);attempt++) {
                    Thread.sleep(200); result=evaluate(instrumentation,holder.get(),"window.subscribeResult");
                }
                assertEquals("10 locales; width="+width+"; textZoom="+zoom+"; native="+nativeBilling, "\"ok\"", result);
            }
            System.out.println("SUBSCRIBE_WEBVIEW_OK locales=10 width="+width+" textZooms=100,130 conditions=20");
        } finally { instrumentation.runOnMainSync(() -> holder.get().destroy()); }
    }
}
