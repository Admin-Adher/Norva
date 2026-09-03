package tv.norva.phone;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NotificationDisplayPolicyTest {
    @Test
    public void androidThirteenRequiresRuntimePermissionAndEnabledNotifications() {
        assertTrue(NorvaMessagingService.notificationDisplayAllowed(33, true, true, true));
        assertFalse(NorvaMessagingService.notificationDisplayAllowed(33, false, true, true));
        assertFalse(NorvaMessagingService.notificationDisplayAllowed(33, true, false, true));
        assertFalse(NorvaMessagingService.notificationDisplayAllowed(33, true, true, false));
    }

    @Test
    public void androidSevenThroughTwelveRequiresEnabledNotificationManager() {
        assertTrue(NorvaMessagingService.notificationDisplayAllowed(32, false, true, true));
        assertFalse(NorvaMessagingService.notificationDisplayAllowed(32, true, false, true));
        assertFalse(NorvaMessagingService.notificationDisplayAllowed(24, true, false, true));
    }

    @Test
    public void androidEightThroughTwelveAlsoRequiresTheLifecycleChannel() {
        assertTrue(NorvaMessagingService.notificationDisplayAllowed(32, false, true, true));
        assertFalse(NorvaMessagingService.notificationDisplayAllowed(32, false, true, false));
        assertFalse(NorvaMessagingService.notificationDisplayAllowed(26, false, true, false));
    }

    @Test
    public void legacyAndroidHasNoRuntimeOrManagerGate() {
        assertTrue(NorvaMessagingService.notificationDisplayAllowed(23, false, false, false));
    }
}
