package tv.norva.phone;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.junit.Test;
import static org.junit.Assert.*;

/** Attached production controllers/CSS. Fixture catalogue only; no provider or authenticated API. */
public final class LiveSearchScopeInstrumentedTest {
    @Test public void searchSurvivesRenderAndSourceChangesWithTheRealKeyboard() throws Exception {
        Instrumentation ins = InstrumentationRegistry.getInstrumentation();
        Activity activity = ins.startActivitySync(new Intent(ins.getTargetContext(), MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        AtomicReference<WebView> holder = new AtomicReference<>();
        ins.runOnMainSync(() -> {
            WebView view = new WebView(activity);
            holder.set(view);
            view.getSettings().setJavaScriptEnabled(true);
            view.getSettings().setDomStorageEnabled(true);
            view.getSettings().setUseWideViewPort(true);
            view.getSettings().setTextZoom(Math.round(activity.getResources().getConfiguration().fontScale * 100));
            view.setWebViewClient(new WebViewClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                    String path = request.getUrl().getPath();
                    String mime = path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css"
                            : path.endsWith(".js") ? "text/javascript" : "application/octet-stream";
                    try {
                        if (!"norva-live-search.test".equals(request.getUrl().getHost())) throw new java.io.IOException();
                        return new WebResourceResponse(mime, "UTF-8", ins.getContext().getAssets().open(path.substring(1)));
                    } catch (Exception ignored) {
                        // No fallback to the network, including logos or EPG.
                        return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                    }
                }
            });
            activity.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            FrameLayout root = new FrameLayout(activity);
            root.setOnApplyWindowInsetsListener((host, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                host.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return insets;
            });
            root.addView(view, new FrameLayout.LayoutParams(-1, -1));
            activity.setContentView(root);
            root.requestApplyInsets();
            view.requestFocus();
            view.loadUrl("https://norva-live-search.test/mobile-live-search.html");
        });
        WebView view = holder.get();
        try {
            awaitFlag(ins, view, "window.fixtureReady===true");
            assertEquals("Production controllers instantiated", "true", js(ins, view,
                    "liveSearchAudit.list instanceof ChannelList && liveSearchAudit.livePage instanceof LivePage"));
            tapSearch(ins, view);
            assertKeyboard(ins, view);
            js(ins, view, "(()=>{const input=document.querySelector('.live-guide-search');input.value='TF1';"
                    + "input.dispatchEvent(new Event('input',{bubbles:true}));})()");
            awaitFlag(ins, view, "document.querySelectorAll('.live-guide-row').length>0 && "
                    + "[...document.querySelectorAll('.live-guide-row')].every(row=>row.textContent.toLowerCase().includes('tf1'))");

            runFixture(ins, view, "verifyRender()", "renderVerified");
            assertKeyboard(ins, view);
            screenshot(ins, view, "live-search-tf1-after-render");
            runFixture(ins, view, "verifyRemoteSourceRace()", "remoteVerified");
            runFixture(ins, view, "verifyMobileRemoteSourceRace()", "mobileRemoteVerified");
            assertKeyboard(ins, view);
            screenshot(ins, view, "live-search-source-scoped");

            runFixture(ins, view, "verifyFilterOrder(true)", "sourceFirstVerified");
            assertKeyboard(ins, view);
            screenshot(ins, view, "live-search-all-sources-then-categories-ime");
            runFixture(ins, view, "verifyFilterOrder(false)", "categoryFirstVerified");
            assertKeyboard(ins, view);
            screenshot(ins, view, "live-search-all-categories-then-sources-ime");
            System.out.println("LIVE_SEARCH_SCOPE_RUNTIME_OK productionControllers=true keyboard=true fontScale="
                    + activity.getResources().getConfiguration().fontScale);
        } finally {
            ins.runOnMainSync(() -> { view.destroy(); activity.finish(); });
        }
    }

    private static String js(Instrumentation ins, WebView view, String source) throws Exception {
        CountDownLatch completed = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        ins.runOnMainSync(() -> view.evaluateJavascript(source, result -> { value.set(result); completed.countDown(); }));
        assertTrue("WebView evaluation completed", completed.await(15, TimeUnit.SECONDS));
        return value.get();
    }

    private static void awaitFlag(Instrumentation ins, WebView view, String expression) throws Exception {
        long until = SystemClock.elapsedRealtime() + 15000;
        while (SystemClock.elapsedRealtime() < until) {
            assertEquals("Fixture error", "null", js(ins, view, "window.fixtureError||null"));
            if ("true".equals(js(ins, view, expression))) return;
            SystemClock.sleep(50);
        }
        fail("Runtime condition did not become true: " + expression);
    }

    private static void runFixture(Instrumentation ins, WebView view, String call, String flag) throws Exception {
        js(ins, view, "void liveSearchAudit." + call + ".catch(error=>window.fixtureError=String(error))");
        awaitFlag(ins, view, "liveSearchAudit." + flag + "===true");
    }

    private static void tapSearch(Instrumentation ins, WebView view) throws Exception {
        JSONArray bounds = new JSONArray(js(ins, view,
                "(()=>{const r=document.querySelector('.live-guide-search').getBoundingClientRect();"
                        + "return [r.x+r.width/2,r.y+r.height/2,devicePixelRatio]})()"));
        int[] offset = new int[2];
        ins.runOnMainSync(() -> view.getLocationOnScreen(offset));
        float x = (float) (bounds.getDouble(0) * bounds.getDouble(2) + offset[0]);
        float y = (float) (bounds.getDouble(1) * bounds.getDouble(2) + offset[1]);
        long down = SystemClock.uptimeMillis();
        for (int action : new int[]{MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP}) {
            MotionEvent event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, x, y, 0);
            event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
            try { assertTrue(ins.getUiAutomation().injectInputEvent(event, true)); }
            finally { event.recycle(); }
            SystemClock.sleep(50);
        }
    }

    private static void assertKeyboard(Instrumentation ins, WebView view) throws Exception {
        AtomicBoolean visible = new AtomicBoolean();
        long until = SystemClock.elapsedRealtime() + 4000;
        do {
            ins.runOnMainSync(() -> {
                WindowInsets insets = view.getRootWindowInsets();
                visible.set(insets != null && insets.isVisible(WindowInsets.Type.ime()));
            });
            if (!visible.get()) SystemClock.sleep(50);
        } while (!visible.get() && SystemClock.elapsedRealtime() < until);
        assertTrue("Real Android IME stays visible", visible.get());
    }

    private static void screenshot(Instrumentation ins, WebView view, String name) throws Exception {
        CountDownLatch frame = new CountDownLatch(1);
        ins.runOnMainSync(() -> view.postVisualStateCallback(0, new WebView.VisualStateCallback() {
            @Override public void onComplete(long requestId) { view.postOnAnimation(() -> view.postOnAnimation(frame::countDown)); }
        }));
        assertTrue("WebView presented before screenshot", frame.await(15, TimeUnit.SECONDS));
        Bitmap image = ins.getUiAutomation().takeScreenshot();
        assertNotNull(image);
        try (FileOutputStream output = new FileOutputStream(new File(ins.getTargetContext().getExternalFilesDir(null), name + ".png"))) {
            image.compress(Bitmap.CompressFormat.PNG, 100, output);
        } finally { image.recycle(); }
    }
}
