package tv.norva.phone;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.webkit.*;
import android.graphics.Bitmap;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import static org.junit.Assert.*;

/** Attached System WebView audit. Synthetic catalogue; playback ends at a recorded request. */
public class LiveGuideAuditInstrumentedTest {
    private String js(Instrumentation i, WebView v, String code) throws Exception {
        CountDownLatch done=new CountDownLatch(1); AtomicReference<String> out=new AtomicReference<>();
        i.runOnMainSync(()->v.evaluateJavascript(code,s->{out.set(s);done.countDown();}));
        assertTrue(done.await(15,TimeUnit.SECONDS)); return out.get();
    }
    private void screenshot(Instrumentation i, String name) throws Exception {
        Bitmap b=i.getUiAutomation().takeScreenshot(); assertNotNull(b);
        try(FileOutputStream out=new FileOutputStream(new File(i.getTargetContext().getExternalFilesDir(null),name+".png"))){b.compress(Bitmap.CompressFormat.PNG,100,out);} finally {b.recycle();}
    }
    @Test public void attachedGuideNavigationAndPlayRequests() throws Exception {
        Instrumentation i=InstrumentationRegistry.getInstrumentation();
        Activity a=i.startActivitySync(new Intent(i.getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        AtomicReference<WebView> ref=new AtomicReference<>();
        i.runOnMainSync(()->{
            WebView v=new WebView(a);ref.set(v);v.getSettings().setJavaScriptEnabled(true);
            v.getSettings().setDomStorageEnabled(true);v.getSettings().setUseWideViewPort(true);
            v.getSettings().setTextZoom(Math.round(a.getResources().getConfiguration().fontScale*100));
            v.setWebViewClient(new WebViewClient(){@Override public WebResourceResponse shouldInterceptRequest(WebView w,WebResourceRequest r){
                String p=r.getUrl().getPath();String mime=p.endsWith(".html")?"text/html":p.endsWith(".css")?"text/css":p.endsWith(".js")?"text/javascript":"application/octet-stream";
                try{return new WebResourceResponse(mime,"UTF-8",i.getContext().getAssets().open(p.substring(1)));}
                catch(Exception e){return new WebResourceResponse("text/plain","UTF-8",new ByteArrayInputStream(new byte[0]));}
            }});
            a.getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            a.setContentView(v);v.requestFocus();v.loadUrl("https://norva-live.test/mobile-live-audit.html");
        });
        try {
            String ready="false";
            for(int n=0;n<100&&!"true".equals(ready);n++){Thread.sleep(100);ready=js(i,ref.get(),"window.fixtureReady===true");}
            assertEquals("fixture: "+js(i,ref.get(),"window.fixtureError||null"),"true",ready);
            Thread.sleep(400);screenshot(i,"live-guide-initial");
            String measurement=js(i,ref.get(),"liveAudit.measure()");
            try(FileWriter out=new FileWriter(new File(i.getTargetContext().getExternalFilesDir(null),"live-guide-measurements.json"))){out.write(measurement);}
            assertEquals("Row is preview-only","0",js(i,ref.get(),"document.querySelector('.live-guide-row').click();liveAudit.plays.length"));
            assertEquals("Play control submits one request","1",js(i,ref.get(),"document.querySelector('.live-guide-play').click();liveAudit.plays.length"));
            assertEquals("Selected channel passed to playback","\"0\"",js(i,ref.get(),"liveAudit.plays[0].channelId"));
            js(i,ref.get(),"document.querySelector('.live-guide-source-trigger').click()");
            Thread.sleep(200);screenshot(i,"live-guide-source-sheet");
            assertEquals("Background inert","true",js(i,ref.get(),"document.querySelector('main').inert"));
            js(i,ref.get(),"document.querySelector('[data-source-value=\"qa-b\"]').click()");
            Thread.sleep(200);
            assertEquals("Source fixture projects only B","true",js(i,ref.get(),"[...document.querySelectorAll('.live-guide-row')].every(r=>r.dataset.sourceId==='qa-b')"));
            js(i,ref.get(),"const q=document.querySelector('.live-guide-search');q.value='Chaîne 80';q.dispatchEvent(new Event('input',{bubbles:true}));q.focus()");
            Thread.sleep(600);
            assertEquals("Search filters the guide","1",js(i,ref.get(),"document.querySelectorAll('.live-guide-row').length"));
            screenshot(i,"live-guide-search");
            assertEquals("Search retains focus","true",js(i,ref.get(),"document.activeElement.classList.contains('live-guide-search')"));
            System.out.println("LIVE_GUIDE_AUDIT "+measurement);
        } finally {i.runOnMainSync(()->{ref.get().destroy();a.finish();});}
    }
}
