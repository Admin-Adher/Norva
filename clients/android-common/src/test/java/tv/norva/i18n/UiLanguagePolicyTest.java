package tv.norva.i18n;
import org.junit.Test;
import static org.junit.Assert.*;

public class UiLanguagePolicyTest {
    @Test public void resolvesSupportedDeviceLanguagesInOrder() {
        assertEquals("fr", UiLanguagePolicy.resolve("auto", new String[]{"de-DE", "fr-CA", "en"}));
        assertEquals("en", UiLanguagePolicy.resolve("auto", new String[]{"ja-JP"}));
        assertEquals("ar", UiLanguagePolicy.resolve("ar", new String[]{"en"}));
        assertEquals("en", UiLanguagePolicy.resolve("auto", null));
    }
    @Test public void normalizesAndroidAndBrowserAliases() {
        assertEquals("pt-BR", UiLanguagePolicy.normalize("pt_PT"));
        assertEquals("fil", UiLanguagePolicy.normalize("tl-PH"));
        assertEquals("id", UiLanguagePolicy.normalize("in-ID"));
        assertEquals("hi", UiLanguagePolicy.normalize("hi-IN"));
        assertEquals("bn", UiLanguagePolicy.normalize("bn-BD"));
        assertEquals("", UiLanguagePolicy.normalize("en;fr"));
        assertEquals("", UiLanguagePolicy.normalize(null));
    }
}
