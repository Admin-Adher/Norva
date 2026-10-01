package tv.norva.i18n;

import android.webkit.WebView;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.InputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import static org.junit.Assert.*;

/** Actual packaged JS in Android's renderer; no provider, account or network access. */
public class PlaybackHealthWebViewTest {
    private String script(android.app.Instrumentation instrumentation) throws Exception {
        InputStream input;
        try { input = instrumentation.getContext().getAssets().open("js/utils/playbackHealth.js"); }
        catch (java.io.IOException missing) {
            input = instrumentation.getTargetContext().getAssets().open("www/js/utils/playbackHealth.js");
        }
        try (InputStream asset = input) {
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[4096]; int count;
            while ((count = asset.read(buffer)) != -1) bytes.write(buffer, 0, count);
            return bytes.toString("UTF-8");
        }
    }

    private String evaluate(android.app.Instrumentation instrumentation, WebView view, String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> view.evaluateJavascript(script, value -> { result.set(value); done.countDown(); }));
        assertTrue("Renderer response", done.await(10, TimeUnit.SECONDS));
        return result.get();
    }

    @Test public void recoveryAndOwnerChangesNeverHideTheSeries() throws Exception {
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        AtomicReference<WebView> holder = new AtomicReference<>();
        CountDownLatch loaded = new CountDownLatch(1);
        String code = script(instrumentation);
        instrumentation.runOnMainSync(() -> {
            WebView view = new WebView(instrumentation.getTargetContext()); holder.set(view);
            view.getSettings().setJavaScriptEnabled(true);
            view.setWebViewClient(new android.webkit.WebViewClient() {
                @Override public void onPageFinished(WebView v, String url) { loaded.countDown(); }
            });
            view.loadDataWithBaseURL("https://health-fixture.invalid/", "<html><body><script>" + code + "</script></body></html>", "text/html", "UTF-8", null);
        });
        try {
            assertTrue("Fixture loaded", loaded.await(15, TimeUnit.SECONDS));
            evaluate(instrumentation, holder.get(),
                "window.qaHealthResult='pending';(async()=>{try{"
                + "window.NorvaCloud={token:'synthetic-owner-a'};"
                + "const h=PlaybackHealth,t={sourceId:'fixture',itemType:'episode',itemId:'ep2',sessionId:'s',status:'broken'};"
                + "window.API={playbackStatus:{report:async()=>({persisted:true,entry:{...t,unavailable:false,last_error:'format'}})}};"
                + "await h.report(t);if(!h.isBroken('fixture','episode','ep2')||h.isUnavailable('fixture','episode','ep2')||h.isBroken('fixture','series','ep2'))throw Error('episode scope');"
                + "API.playbackStatus.report=async()=>({entry:{...t,status:'ok',updated_at:'2026-10-01T10:01:00Z'}});await h.report({...t,status:'ok'});"
                + "API.playbackStatus.report=async()=>({entry:{...t,updated_at:'2026-10-01T10:00:00Z'}});await h.report(t);"
                + "if(h.isBroken('fixture','episode','ep2'))throw Error('late failure won');"
                + "NorvaCloud.token='synthetic-owner-b';if(h.isBroken('fixture','episode','ep2')||h.statuses.size)throw Error('owner leak');"
                + "API.playbackStatus.report=async()=>{throw Error('offline')};await h.report(t);if(h.statuses.size)throw Error('false acknowledgement');"
                + "window.qaHealthResult='ok';}catch(e){window.qaHealthResult=e.message;}})();");
            String result = null;
            for (int attempt = 0; attempt < 40; attempt++) {
                result = evaluate(instrumentation, holder.get(), "window.qaHealthResult");
                if (!"\"pending\"".equals(result)) break;
                Thread.sleep(100);
            }
            assertEquals("Packaged playback health", "\"ok\"", result);
        } finally { instrumentation.runOnMainSync(() -> holder.get().destroy()); }
    }
}
