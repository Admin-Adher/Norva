package tv.norva.phone;

import android.webkit.*;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import static org.junit.Assert.*;

/** Release phone navigation in a visible System WebView, including IME and safe area. */
public class MobileNavigationInstrumentedTest {
    private String evaluate(android.app.Instrumentation i,WebView view,String js) throws Exception {
        CountDownLatch done=new CountDownLatch(1);AtomicReference<String> value=new AtomicReference<>();
        i.runOnMainSync(()->view.evaluateJavascript(js,v->{value.set(v);done.countDown();}));
        assertTrue("WebView response",done.await(10,TimeUnit.SECONDS));return value.get();
    }
    @Test public void searchLivesOnlyInHeader() throws Exception {
        android.app.Instrumentation i=InstrumentationRegistry.getInstrumentation();
        android.app.Activity a=i.startActivitySync(new android.content.Intent(i.getTargetContext(),RecoveryWebViewFixtureActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        AtomicReference<WebView> holder=new AtomicReference<>();CountDownLatch loaded=new CountDownLatch(1);
        i.runOnMainSync(()->{
            WebView w=new WebView(a);holder.set(w);w.getSettings().setJavaScriptEnabled(true);w.getSettings().setUseWideViewPort(true);
            w.setWebViewClient(new WebViewClient(){
                @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request){
                    String path=request.getUrl().getPath();
                    try{return new WebResourceResponse(path.endsWith(".html")?"text/html":path.endsWith(".css")?"text/css":path.endsWith(".svg")?"image/svg+xml":path.endsWith(".png")?"image/png":"text/javascript","UTF-8",i.getContext().getAssets().open(path.substring(1)));}
                    catch(Exception ignored){return new WebResourceResponse("text/plain","UTF-8",new ByteArrayInputStream(new byte[0]));}
                }
                @Override public void onPageFinished(WebView view,String url){loaded.countDown();}
            });
            a.getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            a.setContentView(w);w.requestFocus();w.loadUrl("https://norva-nav.test/mobile-navigation.html?native=1");
        });
        try{
            assertTrue("Navigation loaded",loaded.await(45,TimeUnit.SECONDS));
            String ready="";for(int n=0;n<60&&!"\"Prêt\"".equals(ready);n++){Thread.sleep(100);ready=evaluate(i,holder.get(),"document.getElementById('qa-result').textContent");}
            assertEquals("Navigation mounted","\"Prêt\"",ready);
            for(int zoom:new int[]{100,130}){
                i.runOnMainSync(()->holder.get().getSettings().setTextZoom(zoom));Thread.sleep(250);
                String check="(()=>{const nav=document.getElementById('bottom-nav'),search=document.getElementById('nav-search'),links=[...nav.querySelectorAll('a:not([hidden])')];"
                    +"if(nav.querySelector('[data-action=search]')||document.querySelectorAll('#nav-search').length!==1)throw Error('duplicate search');"
                    +"if(links.length!==6)throw Error('destinations '+links.length);"
                    +"if(search.hidden||search.getBoundingClientRect().height<44)throw Error('header search unavailable');"
                    +"if(links.some(e=>e.getBoundingClientRect().width<44||e.getBoundingClientRect().height<44))throw Error('small destination');"
                    +"if(document.documentElement.scrollWidth>innerWidth+1)throw Error('overflow');"
                    +"if(nav.getBoundingClientRect().bottom>innerHeight+1)throw Error('covered bottom bar');return 'ok';})()";
                assertEquals("Layout zoom="+zoom,"\"ok\"",evaluate(i,holder.get(),check));
                evaluate(i,holder.get(),"document.getElementById('qa-search').focus()");
                i.runOnMainSync(()->((android.view.inputmethod.InputMethodManager)a.getSystemService(android.content.Context.INPUT_METHOD_SERVICE)).showSoftInput(holder.get(),android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT));
                Thread.sleep(700);
                assertEquals("IME focus","\"qa-search\"",evaluate(i,holder.get(),"document.activeElement.id"));
                assertEquals("Layout during IME zoom="+zoom,"\"ok\"",evaluate(i,holder.get(),check));
                i.runOnMainSync(()->((android.view.inputmethod.InputMethodManager)a.getSystemService(android.content.Context.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(holder.get().getWindowToken(),0));
            }
            System.out.println("MOBILE_NAV_HEADER_SEARCH_OK textZooms=100,130");
        }finally{i.runOnMainSync(()->{holder.get().destroy();a.finish();});}
    }
}
