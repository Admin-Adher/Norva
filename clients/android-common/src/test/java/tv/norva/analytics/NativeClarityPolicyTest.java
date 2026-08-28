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
        assertTrue(NativeClarity.isAllowedEvent("playback_first_frame"));
        assertTrue(NativeClarity.isAllowedEvent("journey_error"));
        assertFalse(NativeClarity.isAllowedEvent("provider_access_saved_user_123"));
        assertFalse(NativeClarity.isAllowedEvent("title_the_matrix"));
    }

    @Test
    public void contextVocabularyRejectsIdentifiersAndRawErrors() {
        assertTrue(NativeClarity.isAllowedContext("journey_name", "provider_onboarding"));
        assertTrue(NativeClarity.isAllowedContext("failure_family", "credentials"));
        assertTrue(NativeClarity.isAllowedContext("release_channel", "production"));
        assertFalse(NativeClarity.isAllowedContext("provider_name", "ninja"));
        assertFalse(NativeClarity.isAllowedContext("failure_family", "401 from provider.example"));
    }
}
