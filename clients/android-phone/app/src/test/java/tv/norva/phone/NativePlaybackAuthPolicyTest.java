package tv.norva.phone;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NativePlaybackAuthPolicyTest {
    private static String jwt(long expiresAt) {
        // Stable, precomputed base64url keeps the pure policy test free from
        // Android/JDK encoder availability differences.
        String payload = expiresAt == 2_000_003_600L
                ? "eyJzdWIiOiJ1c2VyIiwiZXhwIjoyMDAwMDAzNjAwfQ"
                : expiresAt == 2_000_007_200L
                        ? "eyJzdWIiOiJ1c2VyIiwiZXhwIjoyMDAwMDA3MjAwfQ"
                        : expiresAt == 2_000_000_015L
                                ? "eyJzdWIiOiJ1c2VyIiwiZXhwIjoyMDAwMDAwMDE1fQ"
                                : expiresAt == 2_000_000_000L
                                        ? "eyJzdWIiOiJ1c2VyIiwiZXhwIjoyMDAwMDAwMDAwfQ"
                                        : "eyJzdWIiOiJ1c2VyIiwiZXhwIjo5OTk5OTk5OTk5fQ";
        return "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." + payload + ".signature";
    }

    @Test
    public void rotatingUserBearerKeepsHeartbeatValidBeyondOneHour() {
        long startedAt = 2_000_000_000L;
        String launchBearer = jwt(startedAt + 3_600L);
        String rotatedBearer = jwt(startedAt + 7_200L);

        assertTrue(NativePlaybackAuthPolicy.isFreshBearer(
                "user", launchBearer, startedAt));
        assertFalse(NativePlaybackAuthPolicy.isFreshBearer(
                "user", launchBearer, startedAt + 3_600L));
        assertTrue(NativePlaybackAuthPolicy.isFreshBearer(
                "user", rotatedBearer, startedAt + 3_600L));
    }

    @Test
    public void userBearerFailsClosedWhenExpiredMalformedOrNearExpiry() {
        long now = 2_000_000_000L;
        assertFalse(NativePlaybackAuthPolicy.isFreshBearer("user", jwt(now), now));
        assertFalse(NativePlaybackAuthPolicy.isFreshBearer("user", jwt(now + 15L), now));
        assertFalse(NativePlaybackAuthPolicy.isFreshBearer("user", "not-a-jwt", now));
        assertFalse(NativePlaybackAuthPolicy.isFreshBearer(
                "user", jwt(now + 60L) + "\nAuthorization: Bearer injected", now));
    }

    @Test
    public void onlyExactStableDeviceTokensAndCanonicalNoncesAreAccepted() {
        String device = "nv_dev_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";
        assertTrue(NativePlaybackAuthPolicy.isFreshBearer("device", device, 0L));
        assertFalse(NativePlaybackAuthPolicy.isFreshBearer("device", device + "x", 0L));
        assertFalse(NativePlaybackAuthPolicy.isFreshBearer("device", jwt(9_999_999_999L), 0L));

        assertTrue(NativePlaybackAuthPolicy.validNonce(
                "123e4567-e89b-42d3-a456-426614174000"));
        assertFalse(NativePlaybackAuthPolicy.validNonce(
                "123E4567-E89B-42D3-A456-426614174000"));
        assertFalse(NativePlaybackAuthPolicy.validNonce("stale-activity"));
    }
}
