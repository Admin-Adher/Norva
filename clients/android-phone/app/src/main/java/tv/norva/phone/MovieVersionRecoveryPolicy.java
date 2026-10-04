package tv.norva.phone;

/** A catalogue hand-off, never a replacement stream or a provider retry. */
final class MovieVersionRecoveryPolicy {
    private MovieVersionRecoveryPolicy() { }

    static boolean canOffer(boolean bridgeSupported, boolean local, String itemType,
                            String sourceId, String itemId, boolean terminal,
                            boolean accountConflict) {
        return bridgeSupported && !local && terminal && !accountConflict
                && "movie".equals(itemType)
                && sourceId != null && !sourceId.trim().isEmpty()
                && itemId != null && !itemId.trim().isEmpty();
    }
}
