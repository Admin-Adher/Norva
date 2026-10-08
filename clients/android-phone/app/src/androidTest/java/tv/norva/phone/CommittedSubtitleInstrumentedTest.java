package tv.norva.phone;
import android.webkit.*;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import static org.junit.Assert.*;

/** Real WatchPage selection and browser TextTracks; synthetic cues, no media/network. */
public class CommittedSubtitleInstrumentedTest {
 @Test public void preparedTracksSwitchAndOffRevokes() throws Exception {
  final android.app.Instrumentation ins=InstrumentationRegistry.getInstrumentation();
  final android.content.Context ctx=ins.getTargetContext();
  final android.app.Activity activity=ins.startActivitySync(new android.content.Intent(ctx,RecoveryWebViewFixtureActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
  final AtomicReference<WebView> view=new AtomicReference<>(); final CountDownLatch loaded=new CountDownLatch(1);
  ins.runOnMainSync(()->{
   WebView w=new WebView(activity);view.set(w);w.getSettings().setJavaScriptEnabled(true);w.getSettings().setDomStorageEnabled(true);
   w.setWebViewClient(new WebViewClient(){
    @Override public WebResourceResponse shouldInterceptRequest(WebView v,WebResourceRequest req){
     try {return new WebResourceResponse(req.getUrl().getPath().endsWith(".css")?"text/css":"text/javascript","UTF-8",ins.getContext().getAssets().open(req.getUrl().getPath().substring(1)));}
     catch(Exception e){return new WebResourceResponse("text/plain","UTF-8",new ByteArrayInputStream(new byte[0]));}
    }
    @Override public void onPageFinished(WebView v,String url){loaded.countDown();}
   });
   activity.setContentView(w);w.requestFocus();
   w.loadDataWithBaseURL("https://norva-fixture.test/","<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'><link rel='stylesheet' href='/css/main.css'><main id='qa-host'></main><script src='/js/utils/mediaUtils.js'></script><script src='/js/pages/WatchPage.js'></script><script src='/committed-subtitle-menu.js'></script>","text/html","UTF-8",null);
  });
  try {
   assertTrue(loaded.await(30,TimeUnit.SECONDS));
   for(int zoom:new int[]{100,130}){
    ins.runOnMainSync(()->view.get().getSettings().setTextZoom(zoom));
    eval(ins,view.get(),"window.qaResult='pending';verifyCommittedSubtitles().then(()=>window.qaResult='ok').catch(e=>window.qaResult=String(e))");
    String result="\"pending\"";
    for(int i=0;i<150&&result.equals("\"pending\"");i++){Thread.sleep(100);result=eval(ins,view.get(),"window.qaResult");}
    assertEquals("textZoom="+zoom,"\"ok\"",result);
   }
  } finally {ins.runOnMainSync(()->{view.get().destroy();activity.finish();});}
 }
 private static String eval(android.app.Instrumentation ins,WebView v,String js)throws Exception{
  CountDownLatch latch=new CountDownLatch(1);AtomicReference<String> result=new AtomicReference<>();
  ins.runOnMainSync(()->v.evaluateJavascript(js,x->{result.set(x);latch.countDown();}));assertTrue(latch.await(20,TimeUnit.SECONDS));return result.get();
 }
}
