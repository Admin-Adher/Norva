package tv.norva.phone;

import android.webkit.*;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import static org.junit.Assert.*;

/** Visible WebView, production markup/CSS/WatchPage. No provider or account I/O. */
public class SlowVodPreparationInstrumentedTest {
 private static String evaluate(android.app.Instrumentation i, WebView view, String js) throws Exception {
  CountDownLatch latch=new CountDownLatch(1);AtomicReference<String> result=new AtomicReference<>();
  i.runOnMainSync(()->view.evaluateJavascript(js,value->{result.set(value);latch.countDown();}));
  assertTrue("WebView response",latch.await(20,TimeUnit.SECONDS));return result.get();
 }
 @Test public void portraitRecovery() throws Exception { verify(360,800); }
 @Test public void landscapeRecovery() throws Exception { verify(844,390); }
 private void verify(int width,int height) throws Exception {
  android.app.Instrumentation i=InstrumentationRegistry.getInstrumentation();
  android.content.Context context=i.getTargetContext();
  android.app.Activity activity=i.startActivitySync(new android.content.Intent(context,RecoveryWebViewFixtureActivity.class)
   .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("landscape",width>height));
  AtomicReference<WebView> holder=new AtomicReference<>();CountDownLatch loaded=new CountDownLatch(1);
  i.runOnMainSync(()->{
   WebView view=new WebView(activity);holder.set(view);view.getSettings().setJavaScriptEnabled(true);view.getSettings().setDomStorageEnabled(true);view.getSettings().setUseWideViewPort(true);
   view.setWebViewClient(new WebViewClient(){
    @Override public WebResourceResponse shouldInterceptRequest(WebView v,WebResourceRequest request){
     String path=request.getUrl().getPath();
     try{return new WebResourceResponse(path.endsWith(".css")?"text/css":path.endsWith(".js")?"text/javascript":path.endsWith(".html")?"text/html":"application/octet-stream","UTF-8",i.getContext().getAssets().open(path.substring(1)));}
     catch(Exception ignored){return new WebResourceResponse("text/plain","UTF-8",new ByteArrayInputStream(new byte[0]));}
    }
    @Override public void onPageFinished(WebView v,String url){loaded.countDown();}
   });
   float density=context.getResources().getDisplayMetrics().density;
   android.widget.FrameLayout host=new android.widget.FrameLayout(activity);
   host.addView(view,new android.widget.FrameLayout.LayoutParams(Math.round(width*density),Math.round(height*density)));
   activity.setContentView(host);view.requestFocus();view.loadUrl("https://norva-slow.test/slow-vod-preparation.html");
  });
  try{
   assertTrue("Fixture loaded",loaded.await(45,TimeUnit.SECONDS));
   for(int zoom:new int[]{100,130}){
    i.runOnMainSync(()->holder.get().getSettings().setTextZoom(zoom));
    for(String locale:new String[]{"fr","ar"}){
     evaluate(i,holder.get(),"document.getElementById('qa-controls').style.display='none';window.qaResult='pending';(async()=>{try{await NorvaI18n.setPreference('"+locale+"');if(document.visibilityState!=='visible')throw Error('hidden WebView');if(Math.abs(innerWidth-"+width+")>2)throw Error('viewport '+innerWidth);await SlowPreparationQA.verify();window.qaResult='ok';}catch(e){window.qaResult=String(e);}})();");
     String result="\"pending\"";
     for(int n=0;n<150&&"\"pending\"".equals(result);n++){Thread.sleep(100);result=evaluate(i,holder.get(),"window.qaResult");}
     assertEquals("width="+width+" zoom="+zoom+" locale="+locale,"\"ok\"",result);
    }
   }
  }finally{i.runOnMainSync(()->{activity.setContentView(new android.widget.FrameLayout(activity));holder.get().destroy();activity.finish();});}
 }
}
