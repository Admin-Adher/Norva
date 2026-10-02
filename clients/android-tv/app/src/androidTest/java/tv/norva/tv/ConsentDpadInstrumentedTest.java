package tv.norva.tv;

import android.app.Instrumentation;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.view.KeyEvent;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import static org.junit.Assert.*;

/** Real Android key events against the shipped consent and D-pad modules, offline. */
public class ConsentDpadInstrumentedTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private String eval(WebView view, String js) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> view.evaluateJavascript(js, value -> {result.set(value);latch.countDown();}));
        assertTrue("JS response", latch.await(15, TimeUnit.SECONDS));
        return result.get();
    }
    private void key(int code) {
        instrumentation.sendKeyDownUpSync(code);
        instrumentation.waitForIdleSync();
    }
    @Test public void remoteCanChooseDismissAndRestoreFocus() throws Exception {
        Intent intent = new Intent(instrumentation.getTargetContext(), ConsentQaActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ConsentQaActivity activity = (ConsentQaActivity) instrumentation.startActivitySync(intent);
        WebView view = activity.webView;
        CountDownLatch loaded = new CountDownLatch(1);
        try {
            instrumentation.runOnMainSync(() -> {
                view.getSettings().setTextZoom(Math.round(100 * activity.getResources().getConfiguration().fontScale));
                view.setWebViewClient(new WebViewClient() {
                    @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                        String path = request.getUrl().getPath();
                        try {
                            String mime = path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css" : "text/javascript";
                            return new WebResourceResponse(mime, "UTF-8", path.equals("/tv-consent.html")
                                ? instrumentation.getContext().getAssets().open("tv-consent.html")
                                : activity.getAssets().open("www" + path));
                        } catch (Exception e) { return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0])); }
                    }
                    @Override public void onPageFinished(WebView v, String url) { loaded.countDown(); }
                });
                view.loadUrl("https://norva-consent.test/tv-consent.html?tv=1&detail=1");
            });
            assertTrue("Fixture loaded", loaded.await(45, TimeUnit.SECONDS));
            for (int i=0;i<50 && !"\"denied\"".equals(eval(view,"document.activeElement.getAttribute('data-consent')"));i++) Thread.sleep(100);
            assertEquals("Initial refusal focus", "\"denied\"", eval(view,"document.activeElement.getAttribute('data-consent')"));
            assertEquals("Background inert", "true", eval(view,"document.getElementById('modal').inert"));
            key(KeyEvent.KEYCODE_DPAD_RIGHT);
            assertEquals("Accept reachable", "\"granted\"", eval(view,"document.activeElement.getAttribute('data-consent')"));
            key(KeyEvent.KEYCODE_DPAD_LEFT);
            assertEquals("Decline reachable", "\"denied\"", eval(view,"document.activeElement.getAttribute('data-consent')"));
            capture(activity, view, "tv-consent-decline.png");
            key(KeyEvent.KEYCODE_DPAD_CENTER);
            assertEquals("Refusal persisted", "\"denied\"", eval(view,"NorvaConsent.get()"));
            assertEquals("Focus restored to fiche", "\"detail\"", eval(view,"document.activeElement.id"));
            assertEquals("Original inert state retained", "true", eval(view,"document.getElementById('already-inert').inert"));
            eval(view,"NorvaConsent.open()");
            key(KeyEvent.KEYCODE_DPAD_RIGHT);
            key(KeyEvent.KEYCODE_DPAD_CENTER);
            assertEquals("Acceptance persisted", "\"granted\"", eval(view,"NorvaConsent.get()"));
            eval(view,"NorvaConsent.open()");
            key(KeyEvent.KEYCODE_BACK);
            assertEquals("Back closes consent first", "false", eval(view,"!!document.querySelector('.norva-consent')"));
            assertEquals("Fiche remains open", "true", eval(view,"document.getElementById('modal').classList.contains('active')"));
            assertEquals("Back preserves prior choice", "\"granted\"", eval(view,"NorvaConsent.get()"));
            eval(view,"document.getElementById('modal').classList.remove('active');localStorage.removeItem('norva_consent');openConsent()");
            key(KeyEvent.KEYCODE_BACK);
            assertEquals("No implicit consent", "null", eval(view,"NorvaConsent.get()"));
            assertEquals("Settings opener restored", "\"opener\"", eval(view,"document.activeElement.id"));
        } finally { instrumentation.runOnMainSync(activity::finish); }
    }
    private void capture(ConsentQaActivity activity, WebView view, String name) {
        instrumentation.runOnMainSync(() -> {
            try {
                Bitmap image=Bitmap.createBitmap(view.getWidth(),view.getHeight(),Bitmap.Config.ARGB_8888);
                view.draw(new Canvas(image));
                try(FileOutputStream out=new FileOutputStream(new File(activity.getExternalFilesDir(null),name))) { image.compress(Bitmap.CompressFormat.PNG,100,out); }
                image.recycle();
            } catch(Exception e) { throw new AssertionError(e); }
        });
    }
}
