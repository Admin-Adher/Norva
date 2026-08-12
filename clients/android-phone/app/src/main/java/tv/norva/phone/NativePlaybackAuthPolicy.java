package tv.norva.phone;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Closed authentication policy for the in-memory player heartbeat channel.
 *
 * <p>User access tokens must be JWTs whose server-issued expiry is still in
 * the future. Paired-device credentials use Norva's fixed opaque format and do
 * not expire through GoTrue rotation. Refresh tokens are deliberately outside
 * this contract and never leave the trusted WebView.</p>
 */
final class NativePlaybackAuthPolicy {
    static final String KIND_DEVICE = "device";
    static final String KIND_USER = "user";
    private static final int MAX_BEARER_CHARS = 16_384;
    private static final long MIN_USER_BEARER_VALIDITY_SECONDS = 15L;
    private static final Pattern DEVICE_BEARER =
            Pattern.compile("^nv_dev_[A-Za-z0-9_-]{43}$");
    private static final Pattern JWT_EXP =
            Pattern.compile("\\\"exp\\\"\\s*:\\s*(\\d{1,12})");
    private static final Pattern JWT_SEGMENT = Pattern.compile("^[A-Za-z0-9_-]+$");
    private static final String BASE64_URL_ALPHABET =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    private NativePlaybackAuthPolicy() { }

    static boolean validNonce(String value) {
        if (value == null || value.length() != 36) return false;
        try {
            return UUID.fromString(value).toString().equals(value);
        } catch (IllegalArgumentException ignored) {
            return false;
        }
    }

    static boolean isFreshBearer(String kind, String bearer, long nowEpochSeconds) {
        if (!validBearerText(bearer)) return false;
        if (KIND_DEVICE.equals(kind)) return DEVICE_BEARER.matcher(bearer).matches();
        if (!KIND_USER.equals(kind)) return false;

        String[] jwt = bearer.split("\\.", -1);
        if (jwt.length != 3 || jwt[0].isEmpty() || jwt[1].isEmpty() || jwt[2].isEmpty()
                || jwt[1].length() > 4_096
                || !JWT_SEGMENT.matcher(jwt[0]).matches()
                || !JWT_SEGMENT.matcher(jwt[1]).matches()
                || !JWT_SEGMENT.matcher(jwt[2]).matches()) return false;
        try {
            String claims = new String(decodeBase64Url(jwt[1]), StandardCharsets.UTF_8);
            Matcher expiry = JWT_EXP.matcher(claims);
            if (!expiry.find()) return false;
            long expiresAt = Long.parseLong(expiry.group(1));
            return expiresAt > nowEpochSeconds
                    && expiresAt - nowEpochSeconds > MIN_USER_BEARER_VALIDITY_SECONDS;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean validBearerText(String bearer) {
        if (bearer == null || bearer.isEmpty() || bearer.length() > MAX_BEARER_CHARS
                || !bearer.equals(bearer.trim())) return false;
        for (int index = 0; index < bearer.length(); index++) {
            if (Character.isISOControl(bearer.charAt(index))) return false;
        }
        return true;
    }

    /** Minimal unpadded base64url decoder that works below Android API 26. */
    private static byte[] decodeBase64Url(String encoded) {
        ByteArrayOutputStream decoded = new ByteArrayOutputStream((encoded.length() * 3) / 4);
        int bits = 0;
        int bitCount = 0;
        for (int index = 0; index < encoded.length(); index++) {
            int value = BASE64_URL_ALPHABET.indexOf(encoded.charAt(index));
            if (value < 0) throw new IllegalArgumentException("invalid base64url");
            bits = (bits << 6) | value;
            bitCount += 6;
            if (bitCount >= 8) {
                bitCount -= 8;
                decoded.write((bits >> bitCount) & 0xff);
                bits &= bitCount == 0 ? 0 : (1 << bitCount) - 1;
            }
        }
        if (bitCount >= 6 || (bitCount > 0 && (bits & ((1 << bitCount) - 1)) != 0)) {
            throw new IllegalArgumentException("invalid base64url tail");
        }
        return decoded.toByteArray();
    }
}
