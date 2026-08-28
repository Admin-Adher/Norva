package tv.norva.analytics;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NativeClarityPolicyTest {

    @Test
    public void screenVocabularyRejectsIdentifiersAndUnknownRoutes() {
        assertTrue(NativeClarity.isAllowedScreen("settings_sources"));
        assertTrue(NativeClarity.isAllowedScreen("player"));
        assertFalse(NativeClarity.isAllowedScreen("source_c5be5ac4-3700"));
        assertFalse(NativeClarity.isAllowedScreen("provider.example/get.php"));
    }

    @Test
    public void customEventVocabularyStaysBoundedAndIdentifierFree() {
        assertTrue(NativeClarity.isAllowedEvent("provider_access_saved"));
        assertTrue(NativeClarity.isAllowedEvent("player_error"));
        assertFalse(NativeClarity.isAllowedEvent("provider_access_saved_user_123"));
        assertFalse(NativeClarity.isAllowedEvent("title_the_matrix"));
    }
}
