package tv.norva.phone;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class NativePlaybackTelemetryContractTest {
    @Test
    public void sessionIdentityIsUuidOnly() {
        assertEquals(
                "123e4567-e89b-12d3-a456-426614174000",
                NativePlaybackTelemetry.boundedSessionId(
                        "123e4567-e89b-12d3-a456-426614174000"));
        assertNull(NativePlaybackTelemetry.boundedSessionId("not-a-session"));
        assertNull(NativePlaybackTelemetry.boundedSessionId(
                "https://provider.example/stream?token=secret"));
    }

    @Test
    public void recoveryAndTerminalDimensionsAreClosedEnums() {
        assertEquals("no_data_timeout",
                NativePlaybackTelemetry.boundedRecoveryReason("no_data_timeout"));
        assertEquals("io_network",
                NativePlaybackTelemetry.boundedRecoveryReason("ERROR_CODE_IO_NETWORK_CONNECTION_FAILED"));
        assertEquals("other",
                NativePlaybackTelemetry.boundedRecoveryReason(
                        "https://provider.example/live/user/password/42.ts"));

        assertEquals("gateway", NativePlaybackTelemetry.boundedRecoveryRoute("gateway"));
        assertEquals("unknown", NativePlaybackTelemetry.boundedRecoveryRoute("secret-host"));
        assertEquals("native_terminal", NativePlaybackTelemetry.boundedTerminalCode("native_terminal"));
        assertEquals("native_terminal", NativePlaybackTelemetry.boundedTerminalCode("provider-token"));
    }
}
