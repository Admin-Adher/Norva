package tv.norva.i18n;

import java.util.Locale;

/** Pure language matching shared by both shells; no content-region inference. */
public final class UiLanguagePolicy {
    private UiLanguagePolicy() {}

    public static String normalize(String value) {
        if (value == null) return "";
        String tag = value.trim().replace('_', '-').toLowerCase(Locale.ROOT);
        if (!tag.matches("[a-z]{2,3}(-[a-z0-9]{2,8})*")) return "";
        String base = tag.split("-")[0];
        switch (base) {
            case "pt": return "pt-BR";
            case "tl": case "fil": return "fil";
            case "in": case "id": return "id";
            case "en": case "fr": case "es": case "hi": case "tr": case "bn": case "ar": return base;
            default: return "";
        }
    }

    /** Import an Android 6-12 preference once, without replacing a system-owned choice. */
    public static String legacyPreferenceToImport(String stored, boolean migrated, boolean systemHasChoice) {
        return migrated || systemHasChoice ? "" : normalize(stored);
    }

    public static String resolve(String preference, String[] deviceLanguages) {
        String explicit = normalize(preference);
        if (!explicit.isEmpty()) return explicit;
        if (deviceLanguages != null) {
            for (String tag : deviceLanguages) {
                String language = normalize(tag);
                if (!language.isEmpty()) return language;
            }
        }
        return "en";
    }
}
