package tv.norva.phone;
import org.junit.Test;
import static org.junit.Assert.*;
public class PlayRetentionTermsTest {
    @Test public void approvedTermsAndCurrencyRounding() {
        assertTrue(PlayRetentionTerms.valid("P1M",3,3990000,4990000,"EUR"));
        assertTrue(PlayRetentionTerms.valid("P1Y",1,35990000,39990000,"USD"));
        assertTrue(PlayRetentionTerms.valid("P1M",3,800000000,1000000000,"JPY"));
    }
    @Test public void rejectsWrongDiscountDurationOrFreeTrial() {
        assertFalse(PlayRetentionTerms.valid("P1M",1,3990000,4990000,"EUR"));
        assertFalse(PlayRetentionTerms.valid("P1Y",3,35990000,39990000,"EUR"));
        assertFalse(PlayRetentionTerms.valid("P1M",3,4990000,4990000,"EUR"));
        assertFalse(PlayRetentionTerms.valid("P1M",3,0,4990000,"EUR"));
        assertFalse(PlayRetentionTerms.valid("P1M",3,1990000,4990000,"EUR"));
        assertFalse(PlayRetentionTerms.valid("P1M",3,3990000,4990000,""));
        assertFalse(PlayRetentionTerms.valid("P1W",3,3990000,4990000,"EUR"));
    }
}
