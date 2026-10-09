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
 @Test public void steadyPreparation() throws Exception { verify(360,800,true); }
 @Test public void portraitStaticArtwork() throws Exception { verify(360,800,false,true); }
 private void verify(int width,int height) throws Exception { verify(width,height,false); }
 private void verify(int width,int height,boolean steady) throws Exception { verify(width,height,steady,false); }
 private void verify(int width,int height,boolean steady,boolean staticArtwork) throws Exception {
  android.app.Instrumentation i=InstrumentationRegistry.getInstrumentation();
  android.content.Context context=i.getTargetContext();
  android.app.Activity activity=i.startActivitySync(new android.content.Intent(context,RecoveryWebViewFixtureActivity.class)
   .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("landscape",width>height));
  AtomicReference<WebView> holder=new AtomicReference<>();CountDownLatch loaded=new CountDownLatch(1);
  i.runOnMainSync(()->{
   WebView view=new WebView(activity);holder.set(view);view.getSettings().setJavaScriptEnabled(true);view.getSettings().setDomStorageEnabled(true);view.getSettings().setUseWideViewPort(true);
   view.setWebChromeClient(new WebChromeClient(){
    @Override public boolean onConsoleMessage(ConsoleMessage message){android.util.Log.i("SlowVodQA",message.message());return true;}
   });
   view.setWebViewClient(new WebViewClient(){
    @Override public WebResourceResponse shouldInterceptRequest(WebView v,WebResourceRequest request){
     String path=request.getUrl().getPath();
     // Diagnostic only: same production image box and still asset. The real
     // animated path remains exercised by all non-diagnostic methods.
     if(staticArtwork && path.equals("/img/watch/norva-loading-60fps.webp"))path="/img/watch/norva-loading-still.webp";
     try{return new WebResourceResponse(path.endsWith(".css")?"text/css":path.endsWith(".js")?"text/javascript":path.endsWith(".html")?"text/html":"application/octet-stream","UTF-8",i.getContext().getAssets().open(path.substring(1)));}
     catch(Exception ignored){return new WebResourceResponse("text/plain","UTF-8",new ByteArrayInputStream(new byte[0]));}
    }
    @Override public void onPageFinished(WebView v,String url){loaded.countDown();}
   });
   float density=context.getResources().getDisplayMetrics().density;
   android.widget.FrameLayout host=new android.widget.FrameLayout(activity);
   host.addView(view,new android.widget.FrameLayout.LayoutParams(Math.round(width*density),Math.round(height*density)));
   activity.setContentView(host);view.requestFocus();
   try {
    java.io.InputStream input=i.getContext().getAssets().open("slow-vod-preparation.html");
    java.io.ByteArrayOutputStream output=new java.io.ByteArrayOutputStream();byte[] buffer=new byte[4096];int read;
    while((read=input.read(buffer))!=-1)output.write(buffer,0,read);input.close();
    view.loadDataWithBaseURL("https://norva-slow.test/",output.toString("UTF-8"),"text/html","UTF-8",null);
   }catch(Exception error){throw new RuntimeException(error);}
  });
  try{
   assertTrue("Fixture loaded",loaded.await(45,TimeUnit.SECONDS));
   if(steady){
    evaluate(i,holder.get(),"document.getElementById('qa-controls').style.display='none';window.qaResult='pending';(async()=>{try{await NorvaI18n.setPreference('fr');await SlowPreparationQA.mount({advance:false});window.qaResult='mounted';}catch(e){window.qaResult=String(e);}})();");
    Thread.sleep(2000);
    assertEquals("Steady preparation mounted","\"mounted\"",evaluate(i,holder.get(),"window.qaResult"));
    assertEquals("No early notice","true",evaluate(i,holder.get(),"document.getElementById('watch-slow-preparation').classList.contains('hidden')"));
    Thread.sleep(46000);
    assertEquals("Real 45-second notice","\"ok\"",evaluate(i,holder.get(),"SlowPreparationQA.layout();'ok'"));
    evaluate(i,holder.get(),"document.getElementById('watch-slow-continue').click()");
    assertEquals("Continue preserves preparation without closing","true",evaluate(i,holder.get(),"document.getElementById('watch-slow-preparation').classList.contains('hidden')&&document.getElementById('watch-loading').classList.contains('show')&&SlowPreparationQA.events().length===0"));
    evaluate(i,holder.get(),"SlowPreparationQA.ready()");
    android.util.Log.i("SlowVodQA","steady 45-second preparation passed");
    return;
   }
   for(int zoom:new int[]{100,130}){
    i.runOnMainSync(()->holder.get().getSettings().setTextZoom(zoom));
    for(String locale:new String[]{"fr","ar"}){
     evaluate(i,holder.get(),"document.getElementById('qa-controls').style.display='none';window.qaResult='pending';(async()=>{try{await NorvaI18n.setPreference('"+locale+"');if(document.visibilityState!=='visible')throw Error('hidden WebView');if(Math.abs(innerWidth-"+width+")>2)throw Error('viewport '+innerWidth);await SlowPreparationQA.verify();window.qaResult='ok';}catch(e){window.qaResult=String(e);}})();");
     String result="\"pending\"";
     for(int n=0;n<150&&"\"pending\"".equals(result);n++){Thread.sleep(100);result=evaluate(i,holder.get(),"window.qaResult");}
     android.util.Log.i("SlowVodQA","result width="+width+" zoom="+zoom+" locale="+locale+" "+result);
     assertEquals("width="+width+" zoom="+zoom+" locale="+locale,"\"ok\"",result);
    }
   }
  }finally{android.util.Log.i("SlowVodQA","teardown start");i.runOnMainSync(()->{activity.setContentView(new android.widget.FrameLayout(activity));holder.get().destroy();activity.finish();});android.util.Log.i("SlowVodQA","teardown done");}
 }
}
