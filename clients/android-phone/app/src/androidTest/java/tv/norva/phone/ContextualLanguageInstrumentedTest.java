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

/** Real catalogue markup, rating controller and filters, with an offline rating API. */
public class ContextualLanguageInstrumentedTest {
    private static final String[] LOCALES = {"en", "fr", "pt-BR", "es", "hi", "tr", "bn", "ar", "id", "fil"};

    private static String evaluate(android.app.Instrumentation instrumentation, WebView view, String js) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> view.evaluateJavascript(js, value -> { result.set(value); latch.countDown(); }));
        assertTrue("WebView responded", latch.await(20, TimeUnit.SECONDS));
        return result.get();
    }

    private static void tapSearch(android.app.Instrumentation instrumentation, WebView view, String kind) throws Exception {
        // Use the rendered DOM bounds and a real touch event, as on a phone.
        org.json.JSONArray rect = new org.json.JSONArray(evaluate(instrumentation, view,
            "(()=>{const r=document.getElementById('"+kind+"-category-search').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2,r.width,r.height,devicePixelRatio,innerWidth,innerHeight];})()"));
        assertTrue("Search target is visible",rect.getDouble(2)>0&&rect.getDouble(3)>0
            &&rect.getDouble(0)>0&&rect.getDouble(0)<rect.getDouble(5)
            &&rect.getDouble(1)>0&&rect.getDouble(1)<rect.getDouble(6));
        int[] offset = new int[2];
        instrumentation.runOnMainSync(() -> view.getLocationOnScreen(offset));
        float x=(float)(rect.getDouble(0)*rect.getDouble(4)+offset[0]);
        float y=(float)(rect.getDouble(1)*rect.getDouble(4)+offset[1]);
        long down=android.os.SystemClock.uptimeMillis();
        for(int action:new int[]{android.view.MotionEvent.ACTION_DOWN,android.view.MotionEvent.ACTION_UP}) {
            android.view.MotionEvent event=android.view.MotionEvent.obtain(down,android.os.SystemClock.uptimeMillis(),action,x,y,0);
            event.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
            instrumentation.sendPointerSync(event);event.recycle();
            if(action==android.view.MotionEvent.ACTION_DOWN)Thread.sleep(40);
        }
    }

    @Test public void portraitAllLocalesAndTextSizes() throws Exception { verify(360, 800); }
    @Test public void landscapeAllLocalesAndTextSizes() throws Exception { verify(844, 390); }

    /** Run in gesture and three-button navigation via adb overlay selection. */
    @Test public void attachedFiltersKeepScopeWithKeyboard() throws Exception {
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        android.app.Activity activity = instrumentation.startActivitySync(new android.content.Intent(
            instrumentation.getTargetContext(), MainActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        AtomicReference<WebView> holder = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> {
            WebView view = new WebView(activity); holder.set(view);
            view.setFocusableInTouchMode(true);
            view.getSettings().setJavaScriptEnabled(true);
            view.getSettings().setDomStorageEnabled(true);
            view.getSettings().setUseWideViewPort(true);
            view.getSettings().setTextZoom(130);
            view.setWebViewClient(new WebViewClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                    String path = request.getUrl().getPath();
                    try {
                        String mime = path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css" : path.endsWith(".js") ? "text/javascript" : "application/octet-stream";
                        return new WebResourceResponse(mime, "UTF-8", instrumentation.getContext().getAssets().open(path.substring(1)));
                    } catch (Exception ignored) {
                        return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                    }
                }
            });
            activity.getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            activity.setContentView(view);
            // Acquire native focus before selecting the DOM input. Requesting
            // WebView focus again afterward can move it to another DOM control.
            view.requestFocus();
            view.loadUrl("https://norva-context.test/i18n-context.html");
        });
        try {
            String ready="false";
            for(int i=0;i<100&&!"true".equals(ready);i++){Thread.sleep(100);ready=evaluate(instrumentation,holder.get(),"window.fixtureReady");}
            assertEquals("Attached fixture loaded","true",ready);
            for(String locale:new String[]{"fr","ar"}) for(String kind:new String[]{"movies","series"}) {
                evaluate(instrumentation,holder.get(),"window.imeReady=false;contextFixture.prepare('"+locale+"','"+kind+"').then(async()=>{document.getElementById('"+kind+"-mobile-filters-btn').click();document.getElementById('"+kind+"-category-btn').click();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await Promise.all(document.getElementById('"+kind+"-filter-bar').getAnimations().map(animation=>animation.finished.catch(()=>{})));window.imeReady=true;});");
                for(int i=0;i<100&&!"true".equals(evaluate(instrumentation,holder.get(),"window.imeReady"));i++)Thread.sleep(100);
                assertEquals("Filter opening animation completed","true",evaluate(instrumentation,holder.get(),"window.imeReady"));
                tapSearch(instrumentation,holder.get(),kind);
                AtomicReference<Boolean> keyboard=new AtomicReference<>(false);
                for(int i=0;i<50&&!keyboard.get();i++){
                    Thread.sleep(100);
                    instrumentation.runOnMainSync(()->{android.view.WindowInsets insets=holder.get().getRootWindowInsets();keyboard.set(insets!=null&&insets.isVisible(android.view.WindowInsets.Type.ime()));});
                }
                assertTrue("Keyboard visible for "+locale+"/"+kind,keyboard.get());
                assertEquals("Scope survives both reset orders with keyboard for "+locale+"/"+kind, "\"ok\"",evaluate(instrumentation,holder.get(),
                    "(()=>{const f=contextFixture;f.source.value='fixture-source';f.categories.setSelected(['comedie']);f.source.value='';f.categories.setSelected([]);if(f.source.value||f.categories.getSelected().size)return 'source/category';f.categories.setSelected(['comedie']);f.source.value='fixture-source';f.categories.setSelected([]);f.source.value='';if(f.source.value||f.categories.getSelected().size)return 'category/source';const sheet=document.getElementById('"+kind+"-filter-bar');if(sheet.inert||sheet.getAttribute('aria-hidden')!=='false')return 'inaccessible sheet';if(document.activeElement.id!=='"+kind+"-category-search')return 'focus lost';return 'ok';})()"));
                instrumentation.runOnMainSync(()->((android.view.inputmethod.InputMethodManager)activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(holder.get().getWindowToken(),0));
                for(int i=0;i<50&&keyboard.get();i++){
                    Thread.sleep(100);
                    instrumentation.runOnMainSync(()->{android.view.WindowInsets insets=holder.get().getRootWindowInsets();keyboard.set(insets!=null&&insets.isVisible(android.view.WindowInsets.Type.ime()));});
                }
                System.out.println("CONTEXT_KEYBOARD_OK locale="+locale+" media="+kind+" textZoom=130");
            }
        } finally { instrumentation.runOnMainSync(()->{holder.get().destroy();activity.finish();}); }
    }

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
                        String mime = path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css" : path.endsWith(".js") ? "text/javascript" : "application/octet-stream";
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
            view.loadUrl("https://norva-context.test/i18n-context.html");
        });
        try {
            assertTrue("Context assets loaded", loaded.await(45, TimeUnit.SECONDS));
            String ready = "false";
            for (int i = 0; i < 100 && !"true".equals(ready); i++) {
                Thread.sleep(100); ready = evaluate(instrumentation, holder.get(), "window.fixtureReady");
            }
            assertEquals("Fixture ready: " + evaluate(instrumentation, holder.get(), "window.fixtureErrors"), "true", ready);
            for (int zoom : new int[] {100, 130}) {
                instrumentation.runOnMainSync(() -> holder.get().getSettings().setTextZoom(zoom));
                for (String locale : LOCALES) for (String kind : new String[] {"movies", "series"}) {
                    evaluate(instrumentation, holder.get(), "window.contextResult='pending';contextFixture.verify('"+locale+"','"+kind+"').then(r=>{window.contextResult=Math.abs(r.width-"+width+")<=2?'ok':'wrong viewport '+r.width;}).catch(e=>window.contextResult=String(e));");
                    String result = "\"pending\"";
                    for (int i = 0; i < 100 && "\"pending\"".equals(result); i++) {
                        Thread.sleep(100); result = evaluate(instrumentation, holder.get(), "window.contextResult");
                    }
                    assertEquals("locale="+locale+" kind="+kind+" width="+width+" textZoom="+zoom, "\"ok\"", result);
                }
            }
            System.out.println("CONTEXT_WEBVIEW_OK width="+width+" locales=10 textZooms=100,130 mediaTypes=2 cases=40");
        } finally { instrumentation.runOnMainSync(() -> holder.get().destroy()); }
    }
}
