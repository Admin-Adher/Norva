package tv.norva.phone;
import android.webkit.*;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import static org.junit.Assert.*;

public class PlayRetentionInstrumentedTest {
    private String evaluate(android.app.Instrumentation i,WebView v,String js) throws Exception {
        CountDownLatch done=new CountDownLatch(1); AtomicReference<String> result=new AtomicReference<>();
        i.runOnMainSync(()->v.evaluateJavascript(js,r->{result.set(r);done.countDown();}));
        assertTrue(done.await(15,TimeUnit.SECONDS));return result.get();
    }
    @Test public void visibleTermsRetryPendingDeclineAndRailIsolation() throws Exception {
        for(int zoom:new int[]{100,130}) verify(zoom);
    }
    private void verify(int zoom) throws Exception {
        android.app.Instrumentation i=InstrumentationRegistry.getInstrumentation();
        AtomicReference<WebView> holder=new AtomicReference<>(); CountDownLatch loaded=new CountDownLatch(1);
        i.runOnMainSync(()->{
            WebView v=new WebView(i.getTargetContext());holder.set(v);
            v.getSettings().setJavaScriptEnabled(true);v.getSettings().setUseWideViewPort(true);v.getSettings().setTextZoom(zoom);
            v.setWebViewClient(new WebViewClient(){
                @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest req){
                    String p=req.getUrl().getPath();
                    try{return new WebResourceResponse(p.endsWith(".js")?"text/javascript":p.endsWith(".css")?"text/css":"text/html","UTF-8",i.getContext().getAssets().open(p.substring(1)));}
                    catch(Exception e){return new WebResourceResponse("text/plain","UTF-8",new ByteArrayInputStream(new byte[0]));}
                }
                @Override public void onPageFinished(WebView view,String url){loaded.countDown();}
            });
            float d=i.getTargetContext().getResources().getDisplayMetrics().density;
            int w=Math.round(360*d),h=Math.round(800*d);
            v.measure(android.view.View.MeasureSpec.makeMeasureSpec(w,1073741824),android.view.View.MeasureSpec.makeMeasureSpec(h,1073741824));v.layout(0,0,w,h);
            v.loadUrl("https://play-retention.test/play-retention.html");
        });
        try{
            assertTrue(loaded.await(30,TimeUnit.SECONDS));WebView v=holder.get();
            evaluate(i,v,"window.proof='pending';(async()=>{try{const wait=()=>new Promise(r=>setTimeout(r,80));"
                +"for(let n=0;n<100&&!document.querySelector('.play-retention-actions button');n++)await wait();"
                +"const root=document.querySelector('#settings-play-retention'),buy=root.querySelector('button');"
                +"if(!buy||buy.getBoundingClientRect().bottom>innerHeight)throw Error('primary action below first screen');"
                +"if(document.documentElement.scrollWidth>innerWidth+2)throw Error('overflow');"
                +"if([...root.querySelectorAll('button')].some(b=>b.getBoundingClientRect().height<44))throw Error('target too small');"
                +"if(!root.textContent.includes('3,99')||!root.textContent.includes('4,99'))throw Error('store prices missing');"
                +"buy.click();await wait();if(buy.disabled||root.textContent.includes('private-provider'))throw Error('retry unsafe');"
                +"buy.click();await wait();if(root.querySelector('.play-retention-actions button'))throw Error('second payment possible');"
                +"await NorvaPlayRetentionCard.refresh(qaApp,{projection:{provider:'google_play'}});"
                +"root.querySelectorAll('button')[1].click();await wait();if(!calls.some(c=>c.action==='decline'))throw Error('decline missing');"
                +"if(document.activeElement.getAttribute('role')!=='status')throw Error('decline focus');"
                +"await NorvaPlayRetentionCard.refresh(qaApp,{projection:{provider:'revolut'}});if(!root.hidden)throw Error('web rail leak');"
                +"window.proof='ok';}catch(e){window.proof=String(e);}})();");
            String result="\"pending\"";
            for(int n=0;n<120&&"\"pending\"".equals(result);n++){Thread.sleep(100);result=evaluate(i,v,"window.proof");}
            assertEquals("WebView font size "+zoom,"\"ok\"",result);
        }finally{i.runOnMainSync(()->holder.get().destroy());}
    }
}
