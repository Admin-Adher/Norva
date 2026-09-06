package tv.norva.phone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.Drawable;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.FileOutputStream;

/** Resource-only device tests: no push send, permission change, login or customer data. */
@RunWith(AndroidJUnit4.class)
public final class NotificationBrandingInstrumentedTest {
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

    @Test
    public void backgroundFcmUsesTheSameDedicatedNorvaMark() throws Exception {
        ApplicationInfo info = context.getPackageManager().getApplicationInfo(
                context.getPackageName(), PackageManager.GET_META_DATA);
        assertEquals(R.drawable.ic_norva_notification,
                info.metaData.getInt("com.google.firebase.messaging.default_notification_icon"));
        assertEquals(R.color.norva_accent,
                info.metaData.getInt("com.google.firebase.messaging.default_notification_color"));
    }

    @Test
    public void statusIconHasTransparentMarginsAndARealMonochromeMark() throws Exception {
        for (int size : new int[]{24, 48, 72}) {
            Bitmap image = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            Drawable icon = context.getDrawable(R.drawable.ic_norva_notification);
            assertNotNull(icon);
            icon.setBounds(0, 0, size, size);
            icon.draw(new Canvas(image));
            int visible = 0;
            for (int y = 0; y < size; y++) {
                for (int x = 0; x < size; x++) {
                    int pixel = image.getPixel(x, y);
                    if (x == 0 || y == 0 || x == size - 1 || y == size - 1) {
                        assertEquals("transparent outer margin", 0, Color.alpha(pixel));
                    }
                    if (Color.alpha(pixel) > 0) {
                        visible++;
                        assertEquals(255, Color.red(pixel));
                        assertEquals(255, Color.green(pixel));
                        assertEquals(255, Color.blue(pixel));
                    }
                }
            }
            double coverage = visible / (double) (size * size);
            assertTrue("not an empty icon", coverage > 0.20);
            assertTrue("not an opaque launcher tile", coverage < 0.65);
            if (size == 72) {
                try (FileOutputStream output = context.openFileOutput(
                        "notification-status-mark-proof.png", Context.MODE_PRIVATE)) {
                    assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, output));
                }
            }
            image.recycle();
        }
    }

    @Test
    public void largeIconRemainsTheExistingFullColourNorvaAsset() {
        Bitmap image = BitmapFactory.decodeResource(context.getResources(), R.drawable.norva_app_icon);
        assertNotNull(image);
        assertTrue(image.getWidth() >= 96 && image.getHeight() >= 96);
        boolean colourFound = false;
        for (int y = 0; y < image.getHeight() && !colourFound; y += 8) {
            for (int x = 0; x < image.getWidth(); x += 8) {
                int pixel = image.getPixel(x, y);
                if (Color.alpha(pixel) > 200 && Math.abs(Color.red(pixel) - Color.blue(pixel)) > 30) {
                    colourFound = true;
                    break;
                }
            }
        }
        assertTrue("existing colour logo retained", colourFound);
        image.recycle();
    }
}
