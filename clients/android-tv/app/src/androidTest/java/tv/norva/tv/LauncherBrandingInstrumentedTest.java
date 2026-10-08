package tv.norva.tv;

import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.drawable.AdaptiveIconDrawable;
import android.graphics.drawable.Drawable;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import org.junit.Test;
import static org.junit.Assert.*;

/** Exercise the actual package resources used by Android's TV launcher. */
public class LauncherBrandingInstrumentedTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private final Context context = instrumentation.getTargetContext();

    private Bitmap render(Drawable drawable, int width, int height) {
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        drawable.setBounds(0, 0, width, height);
        drawable.draw(new Canvas(bitmap));
        return bitmap;
    }

    private void save(Bitmap bitmap, String name) throws Exception {
        assertNotNull(name, bitmap);
        try (FileOutputStream output = new FileOutputStream(new File(context.getExternalFilesDir(null), name))) {
            assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output));
        }
    }

    @Test public void launcherLoadsAdaptiveLogoAndFullNamedBanner() throws Exception {
        ApplicationInfo info = context.getPackageManager().getApplicationInfo(context.getPackageName(), 0);
        Drawable icon = info.loadIcon(context.getPackageManager());
        assertTrue("The manifest must resolve to a real adaptive icon", icon instanceof AdaptiveIconDrawable);
        AdaptiveIconDrawable adaptive = (AdaptiveIconDrawable) icon;
        Bitmap background = render(adaptive.getBackground(), 512, 512);
        assertEquals("The mask must have an opaque background", 255, Color.alpha(background.getPixel(0, 0)));
        save(render(icon, 512, 512), "tv-launcher-adaptive.png");

        // Android expands adaptive layers by 25% beyond the mask bounds.
        // Exercise both masks with those real layer bounds, not a resized PNG.
        for (boolean circle : new boolean[]{true, false}) {
            Bitmap bitmap = Bitmap.createBitmap(512, 512, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            Path mask = new Path();
            if (circle) mask.addCircle(256, 256, 256, Path.Direction.CW);
            else mask.addRoundRect(new RectF(0, 0, 512, 512), 112, 112, Path.Direction.CW);
            canvas.clipPath(mask);
            for (Drawable layer : new Drawable[]{adaptive.getBackground(), adaptive.getForeground()}) {
                layer.setBounds(-128, -128, 640, 640);
                layer.draw(canvas);
            }
            assertEquals(255, Color.alpha(bitmap.getPixel(256, 256)));
            save(bitmap, circle ? "tv-launcher-circle.png" : "tv-launcher-rounded-square.png");
        }

        Drawable banner = info.loadBanner(context.getPackageManager());
        assertNotNull("Launcher banner resolved from the manifest", banner);
        float density = context.getResources().getDisplayMetrics().density;
        assertEquals(160, Math.round(banner.getIntrinsicWidth() / density));
        assertEquals(90, Math.round(banner.getIntrinsicHeight() / density));
        Bitmap rendered = render(banner, 320, 180);
        for (int[] point : new int[][]{{0,0},{319,0},{0,179},{319,179}})
            assertEquals("The banner fills its rectangle", 255, Color.alpha(rendered.getPixel(point[0], point[1])));
        int wordmarkPixels = 0;
        for (int y=64;y<116;y++) for (int x=144;x<284;x++) {
            int pixel=rendered.getPixel(x,y);
            if (Color.red(pixel)>220 && Color.green(pixel)>220 && Color.blue(pixel)>220) wordmarkPixels++;
        }
        assertTrue("The product name must render inside the banner", wordmarkPixels > 400);
        save(rendered, "tv-launcher-banner-320x180.png");

        Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(home);
        instrumentation.waitForIdleSync();
        AccessibilityNodeInfo root = null;
        for (int i=0; i<40; i++) {
            root=instrumentation.getUiAutomation().getRootInActiveWindow();
            if (root!=null && root.getPackageName()!=null && !context.getPackageName().contentEquals(root.getPackageName())) break;
            SystemClock.sleep(250);
        }
        assertNotNull("Actual TV launcher is visible", root);
        assertFalse("Test must return to the launcher", context.getPackageName().contentEquals(root.getPackageName()));
        save(instrumentation.getUiAutomation().takeScreenshot(), "tv-launcher-home.png");
        // The fresh launcher has no favourites. Open its Apps tab via the
        // actual accessibility node, then capture Norva in the installed grid.
        for (AccessibilityNodeInfo node : root.findAccessibilityNodeInfosByText("Apps")) {
            if ("Apps".contentEquals(node.getText() == null ? "" : node.getText())) {
                AccessibilityNodeInfo target = node;
                for (int i=0; i<4 && target != null && !target.isClickable(); i++) target=target.getParent();
                if (target != null) target.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                break;
            }
        }
        boolean found = false;
        for (int i=0; i<40; i++) {
            root=instrumentation.getUiAutomation().getRootInActiveWindow();
            if (root!=null && !root.findAccessibilityNodeInfosByText("Norva").isEmpty()) { found=true; break; }
            SystemClock.sleep(250);
        }
        save(instrumentation.getUiAutomation().takeScreenshot(), "tv-launcher-apps.png");
        StringBuilder tree = new StringBuilder();
        dump(root, tree, 0);
        try (FileOutputStream out = new FileOutputStream(new File(context.getExternalFilesDir(null), "tv-launcher-home.txt"))) {
            out.write(tree.toString().getBytes(StandardCharsets.UTF_8));
        }
        // The workflow copies screenshots every five seconds, before test APK removal.
        SystemClock.sleep(6000);
        assertTrue("Norva must be visible in the real launcher Apps grid", found);
    }

    private void dump(AccessibilityNodeInfo node, StringBuilder result, int depth) {
        if (node == null || depth > 20) return;
        result.append(depth).append(' ').append(node.getPackageName()).append(' ').append(node.getClassName())
            .append(' ').append(node.getText()).append(' ').append(node.getContentDescription()).append('\n');
        for (int i=0; i<node.getChildCount(); i++) dump(node.getChild(i), result, depth+1);
    }
}
