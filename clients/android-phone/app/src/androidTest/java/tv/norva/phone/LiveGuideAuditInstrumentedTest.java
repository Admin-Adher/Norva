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
    private void screenshot(Instrumentation i, WebView view, String name) throws Exception {
        CountDownLatch presented = new CountDownLatch(1);
        i.runOnMainSync(() -> view.postVisualStateCallback(0, new WebView.VisualStateCallback() {
            @Override public void onComplete(long requestId) {
                view.postOnAnimation(() -> view.postOnAnimation(presented::countDown));
            }
        }));
        assertTrue("WebView frame presented before screenshot", presented.await(15, TimeUnit.SECONDS));
        i.waitForIdleSync();
        Bitmap b=i.getUiAutomation().takeScreenshot(); assertNotNull(b);
        try(FileOutputStream out=new FileOutputStream(new File(i.getTargetContext().getExternalFilesDir(null),name+".png"))){b.compress(Bitmap.CompressFormat.PNG,100,out);} finally {b.recycle();}
    }
    private void tapSearch(Instrumentation i, WebView v) throws Exception {
        org.json.JSONArray r=new org.json.JSONArray(js(i,v,"(()=>{const r=document.querySelector('.live-guide-search').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2,devicePixelRatio]})()"));
        int[] offset=new int[2];i.runOnMainSync(()->v.getLocationOnScreen(offset));
        float x=(float)(r.getDouble(0)*r.getDouble(2)+offset[0]),y=(float)(r.getDouble(1)*r.getDouble(2)+offset[1]);
        long down=android.os.SystemClock.uptimeMillis();
        for(int action:new int[]{0,1}) {
            android.view.MotionEvent e=android.view.MotionEvent.obtain(down,android.os.SystemClock.uptimeMillis(),action,x,y,0);
            e.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
            try {assertTrue(i.getUiAutomation().injectInputEvent(e,true));}finally{e.recycle();}
            Thread.sleep(50);
        }
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
            android.widget.FrameLayout root = new android.widget.FrameLayout(a);
            root.setOnApplyWindowInsetsListener((host, insets) -> {
                android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars());
                host.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return insets;
            });
            root.addView(v, new android.widget.FrameLayout.LayoutParams(-1, -1));
            a.setContentView(root);root.requestApplyInsets();v.requestFocus();v.loadUrl("https://norva-live.test/mobile-live-audit.html");
        });
        try {
            String ready="false";
            for(int n=0;n<100&&!"true".equals(ready);n++){Thread.sleep(100);ready=js(i,ref.get(),"window.fixtureReady===true");}
            assertEquals("fixture: "+js(i,ref.get(),"window.fixtureError||null"),"true",ready);
            Thread.sleep(400);screenshot(i,ref.get(),"live-guide-initial");
            String measurement=js(i,ref.get(),"liveAudit.measure()");
            assertEquals("Touch controls have at least 44 CSS pixels", "true", js(i,ref.get(),
                "liveAudit.measure().targets.every(t=>t.width>=44&&t.height>=44)"));
            try(FileWriter out=new FileWriter(new File(i.getTargetContext().getExternalFilesDir(null),"live-guide-measurements.json"))){out.write(measurement);}
            assertEquals("Phone row launches playback","1",js(i,ref.get(),"document.querySelector('.live-guide-row').click();liveAudit.plays.length"));
            assertEquals("Play control submits one additional request","2",js(i,ref.get(),"document.querySelector('.live-guide-play').click();liveAudit.plays.length"));
            assertEquals("Selected channel passed to playback","\"0\"",js(i,ref.get(),"liveAudit.plays[0].channelId"));
            js(i,ref.get(),"document.querySelector('.live-guide-source-trigger').click()");
            Thread.sleep(200);screenshot(i,ref.get(),"live-guide-source-sheet");
            assertEquals("Background inert","true",js(i,ref.get(),"document.querySelector('main').inert"));
            js(i,ref.get(),"document.querySelector('[data-source-value=\"m3u:2\"]').click()");
            Thread.sleep(200);
            assertEquals("Source fixture projects only B","true",js(i,ref.get(),"[...document.querySelectorAll('.live-guide-row')].every(r=>r.dataset.sourceId==='2')"));
            screenshot(i,ref.get(),"live-guide-after-source-change");
            String sourcePlay=js(i,ref.get(),"document.querySelector('[data-action=watch]').click();liveAudit.plays[liveAudit.plays.length-1].sourceId");
            System.out.println("LIVE_SOURCE_WATCH_REQUEST "+sourcePlay);
            try(FileWriter out=new FileWriter(new File(i.getTargetContext().getExternalFilesDir(null),"live-source-watch.json"))){out.write(sourcePlay);}
            tapSearch(i,ref.get());
            java.util.concurrent.atomic.AtomicBoolean keyboard=new java.util.concurrent.atomic.AtomicBoolean();
            for(int n=0;n<40&&!keyboard.get();n++) {Thread.sleep(100);i.runOnMainSync(()->{
                android.view.WindowInsets insets=ref.get().getRootWindowInsets();
                keyboard.set(insets!=null&&insets.isVisible(android.view.WindowInsets.Type.ime()));
            });}
            assertTrue("Real Android keyboard opened",keyboard.get());
            js(i,ref.get(),"const q=document.querySelector('.live-guide-search');q.value='Chaîne 80';q.dispatchEvent(new Event('input',{bubbles:true}));q.focus()");
            Thread.sleep(600);
            assertEquals("Search filters the guide","1",js(i,ref.get(),"document.querySelectorAll('.live-guide-row').length"));
            screenshot(i,ref.get(),"live-guide-search");
            assertEquals("Search retains focus","true",js(i,ref.get(),"document.activeElement.classList.contains('live-guide-search')"));
            // Exercise both filter orders while the real IME remains open.
            js(i,ref.get(),"document.querySelector('.live-guide-search').value='';liveAudit.guide.searchQuery='';document.querySelectorAll('.live-guide-group')[1].click();document.getElementById('source-select').value='';document.getElementById('source-select').dispatchEvent(new Event('change'))");
            Thread.sleep(300);
            js(i,ref.get(),"document.querySelector('.live-guide-group[data-group=\"\"]').click()");
            assertEquals("All sources then all categories", "96", js(i,ref.get(),"liveAudit.guide.getRowsChannels().length"));
            js(i,ref.get(),"document.getElementById('source-select').value='m3u:2';document.getElementById('source-select').dispatchEvent(new Event('change'))");
            Thread.sleep(300);
            js(i,ref.get(),"document.querySelectorAll('.live-guide-group')[1].click();document.querySelector('.live-guide-group[data-group=\"\"]').click();document.getElementById('source-select').value='';document.getElementById('source-select').dispatchEvent(new Event('change'))");
            Thread.sleep(300);
            assertEquals("All categories then all sources", "96", js(i,ref.get(),"liveAudit.guide.getRowsChannels().length"));
            System.out.println("LIVE_GUIDE_AUDIT "+measurement);
            System.out.println("LIVE_SOURCE_WATCH_REQUEST "+sourcePlay);
            assertEquals("Watch must follow the selected source", "\"2\"", sourcePlay);
        } finally {i.runOnMainSync(()->{ref.get().destroy();a.finish();});}
    }
}
