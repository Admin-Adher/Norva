package tv.norva.phone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import android.content.Context;
import android.net.Uri;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Device-level privacy and durability contract for behavioral lifecycle links. */
@RunWith(AndroidJUnit4.class)
public final class LifecycleDeepLinkInstrumentedTest {

    private static final String DELIVERY_ID = "22222222-2222-4222-8222-222222222222";

    @Test
    public void canonicalizerKeepsOnlyTheExactNorvaLifecycleShape() {
        String input = "https://NORVA.tv:443/app.html?mobile=1&lifecycleDelivery="
                + DELIVERY_ID + "#settings/sources/help/timeout/m3u";
        Uri canonical = NorvaMessagingService.canonicalLifecycleLink(input, DELIVERY_ID);
        assertEquals(
                "https://norva.tv/app.html?mobile=1&lifecycleDelivery=" + DELIVERY_ID
                        + "#settings/sources/help/timeout/m3u",
                canonical == null ? null : canonical.toString());

        for (String fragment : new String[]{
                "home", "home/resume", "settings/sources",
                "settings/sources/help/payload_too_large/m3u",
                "settings/sources/help/credentials/xtream"
        }) {
            String candidate = "https://norva.tv/app.html?mobile=1&lifecycleDelivery="
                    + DELIVERY_ID + "#" + fragment;
            Uri result = NorvaMessagingService.canonicalLifecycleLink(candidate, DELIVERY_ID);
            assertEquals(candidate, result == null ? null : result.toString());
        }
    }

    @Test
    public void canonicalizerRejectsExtraQueriesCredentialsAndForeignOrigins() {
        String prefix = "?mobile=1&lifecycleDelivery=" + DELIVERY_ID;
        assertNull(NorvaMessagingService.canonicalLifecycleLink(
                "http://norva.tv/app.html" + prefix + "#home", DELIVERY_ID));
        assertNull(NorvaMessagingService.canonicalLifecycleLink(
                "https://norva.tv.evil.example/app.html" + prefix + "#home", DELIVERY_ID));
        assertNull(NorvaMessagingService.canonicalLifecycleLink(
                "https://norva.tv:444/app.html" + prefix + "#home", DELIVERY_ID));
        assertNull(NorvaMessagingService.canonicalLifecycleLink(
                "https://norva.tv/app" + prefix + "#home", DELIVERY_ID));
        assertNull(NorvaMessagingService.canonicalLifecycleLink(
                "https://norva.tv/app.html" + prefix + "&utm_source=x#home", DELIVERY_ID));
        assertNull(NorvaMessagingService.canonicalLifecycleLink(
                "https://norva.tv/app.html" + prefix + "&mobile=1#home", DELIVERY_ID));
        assertNull(NorvaMessagingService.canonicalLifecycleLink(
                "https://norva.tv/app.html" + prefix
                        + "#settings/sources/help/password_secret/xtream", DELIVERY_ID));
        assertNull(NorvaMessagingService.canonicalLifecycleLink(
                "https://norva.tv/app.html" + prefix + "#settings/sources/help/timeout/m3u/extra",
                DELIVERY_ID));
        assertNull(NorvaMessagingService.canonicalLifecycleLink(
                "https://norva.tv/app.html" + prefix + "#home",
                "33333333-3333-4333-8333-333333333333"));
        String dashId = "------------------------------------";
        assertNull(NorvaMessagingService.canonicalLifecycleLink(
                "https://norva.tv/app.html?mobile=1&lifecycleDelivery=" + dashId + "#home",
                dashId));
    }

    @Test
    public void receiptQueueDeduplicatesDrainsAndRestoresOnlyValidEvents() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        NorvaMessagingService.drainLifecycleReceipts(context);

        NorvaMessagingService.rememberLifecycleReceipt(context, DELIVERY_ID, "opened");
        NorvaMessagingService.rememberLifecycleReceipt(context, DELIVERY_ID, "opened");
        NorvaMessagingService.rememberLifecycleReceipt(context, DELIVERY_ID, "invalid_event");
        NorvaMessagingService.rememberLifecycleReceipt(context, "not-a-delivery", "delivered");
        NorvaMessagingService.rememberLifecycleReceipt(
                context, "------------------------------------", "delivered");

        JSONArray drained = new JSONArray(NorvaMessagingService.drainLifecycleReceipts(context));
        assertEquals(1, drained.length());
        assertEquals("opened", drained.getJSONObject(0).getString("event"));
        assertEquals(DELIVERY_ID, drained.getJSONObject(0).getString("deliveryId"));
        assertEquals(0, new JSONArray(NorvaMessagingService.drainLifecycleReceipts(context)).length());

        JSONArray restore = new JSONArray();
        restore.put(new JSONObject().put("event", "delivered").put("deliveryId", DELIVERY_ID));
        restore.put(new JSONObject().put("event", "not_allowed").put("deliveryId", DELIVERY_ID));
        NorvaMessagingService.restoreLifecycleReceipts(context, restore.toString());
        JSONArray restored = new JSONArray(NorvaMessagingService.drainLifecycleReceipts(context));
        assertEquals(1, restored.length());
        assertEquals("delivered", restored.getJSONObject(0).getString("event"));
        assertEquals(DELIVERY_ID, restored.getJSONObject(0).getString("deliveryId"));
    }
}
