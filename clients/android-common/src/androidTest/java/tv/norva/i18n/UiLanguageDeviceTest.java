package tv.norva.i18n;

import android.app.LocaleManager;
import android.content.Context;
import android.os.Build;
import android.os.LocaleList;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

/** Real resource/LocaleManager integration; no account, network or playback side effect. */
public class UiLanguageDeviceTest {
    @Test public void systemAppLanguageAndNativeResourcesStayInSync() throws Exception {
        assumeTrue(Build.VERSION.SDK_INT >= 33);
        Context target = InstrumentationRegistry.getInstrumentation().getTargetContext();
        LocaleManager manager = target.getSystemService(LocaleManager.class);
        LocaleList original = manager.getApplicationLocales();
        String[] codes = {"en", "fr", "pt-BR", "es", "hi", "tr", "bn", "ar", "id", "fil"};
        String[] labels = {"Interface language", "Langue de l’interface", "Idioma da interface",
                "Idioma de la interfaz", "इंटरफ़ेस की भाषा", "Arayüz dili", "ইন্টারফেসের ভাষা", "لغة الواجهة",
                "Bahasa antarmuka", "Wika ng interface"};
        try {
            for (int i = 0; i < codes.length; i++) {
                manager.setApplicationLocales(LocaleList.forLanguageTags(codes[i]));
                assertEquals(codes[i], UiLanguage.preference(target));
                Context localized = UiLanguage.wrap(target);
                int id = localized.getResources().getIdentifier("ui_language", "string", target.getPackageName());
                assertTrue(id != 0);
                assertEquals(labels[i], localized.getString(id));
                assertEquals("ar".equals(codes[i]) ? 1 : 0, localized.getResources().getConfiguration().getLayoutDirection());
            }
            manager.setApplicationLocales(LocaleList.getEmptyLocaleList());
            assertEquals("auto", UiLanguage.preference(target));
            assertEquals(UiLanguagePolicy.resolve("auto", UiLanguage.deviceLanguages(target)), UiLanguage.resolved(target));
        } finally { manager.setApplicationLocales(original); }
    }
}
