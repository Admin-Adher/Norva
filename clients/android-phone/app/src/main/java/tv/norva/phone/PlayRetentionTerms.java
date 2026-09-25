package tv.norva.phone;

/** Store phases, never a web/USD price, are the authority for the payment sheet. */
final class PlayRetentionTerms {
    static boolean valid(String period, int cycles, long reduced, long regular, String currency) {
        boolean monthly = "P1M".equals(period);
        if (!(monthly || "P1Y".equals(period)) || cycles != (monthly ? 3 : 1)
                || reduced <= 0 || regular <= reduced || currency == null || !currency.matches("[A-Z]{3}")) return false;
        double ratio = (double) reduced / regular;
        // Google rounds local-currency prices. Reject a wrongly configured offer,
        // while displaying its exact formatted amounts rather than inventing one.
        return Math.abs(ratio - (monthly ? .8 : .9)) <= .01;
    }
    private PlayRetentionTerms() { }
}
