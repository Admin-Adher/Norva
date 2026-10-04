package tv.norva.tv;

/** A user-driven catalog action; never a file-health or provider-access verdict. */
final class MovieVersionRecoveryPolicy {
    private MovieVersionRecoveryPolicy() { }

    static boolean canOffer(boolean capability, String itemType, String sourceId,
                            String itemId, String sessionId, boolean terminal,
                            boolean blocked) {
        return capability && terminal && !blocked && "movie".equals(itemType)
                && coordinate(sourceId) && coordinate(itemId)
                && NativePlaybackClosePolicy.boundedSessionId(sessionId) != null;
    }

    private static boolean coordinate(String value) {
        return value != null && value.matches("[A-Za-z0-9_-]{1,160}");
    }
}
