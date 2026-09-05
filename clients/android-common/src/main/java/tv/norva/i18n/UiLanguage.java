package tv.norva.i18n;

import android.app.Activity;
import android.app.LocaleManager;
import android.content.Context;
import android.content.res.Configuration;
import android.content.res.Resources;
import android.os.Build;
import android.os.LocaleList;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Locale;

/** Device-local UI preference. Never reads/writes profile, audio or catalogue settings. */
public final class UiLanguage {
    private static final String STORE = "norva_ui_language";
    private static final String KEY = "preference";
    private UiLanguage() {}

    public static String preference(Context context) {
        if (Build.VERSION.SDK_INT >= 33) {
            LocaleManager manager = context.getSystemService(LocaleManager.class);
            if (manager != null) {
                migrateLegacyPreference(context, manager);
                LocaleList list = manager.getApplicationLocales();
                if (list.isEmpty()) return "auto";
                String normalized = UiLanguagePolicy.normalize(list.get(0).toLanguageTag());
                return normalized.isEmpty() ? "auto" : normalized;
            }
        }
        String value = context.getSharedPreferences(STORE, Context.MODE_PRIVATE).getString(KEY, "auto");
        String normalized = UiLanguagePolicy.normalize(value);
        return normalized.isEmpty() ? "auto" : normalized;
    }

    @androidx.annotation.RequiresApi(33)
    private static synchronized void migrateLegacyPreference(Context context, LocaleManager manager) {
        android.content.SharedPreferences preferences = context.getSharedPreferences(STORE, Context.MODE_PRIVATE);
        if (preferences.getBoolean("migrated_api33", false)) return;
        String imported = UiLanguagePolicy.legacyPreferenceToImport(
                preferences.getString(KEY, "auto"), false, !manager.getApplicationLocales().isEmpty());
        if (!imported.isEmpty()) manager.setApplicationLocales(LocaleList.forLanguageTags(imported));
        // A failed commit is retried; an already-imported framework locale will never be replaced.
        preferences.edit().putBoolean("migrated_api33", true).commit();
    }

    public static String[] deviceLanguages(Context context) {
        if (Build.VERSION.SDK_INT >= 33) {
            LocaleManager manager = context.getSystemService(LocaleManager.class);
            if (manager != null) return tags(manager.getSystemLocales());
        }
        Configuration system = Resources.getSystem().getConfiguration();
        if (Build.VERSION.SDK_INT >= 24) return tags(system.getLocales());
        return new String[] { system.locale.toLanguageTag() };
    }

    @androidx.annotation.RequiresApi(24)
    private static String[] tags(LocaleList list) {
        String[] tags = new String[list.size()];
        for (int i = 0; i < tags.length; i++) tags[i] = list.get(i).toLanguageTag();
        return tags;
    }

    public static String resolved(Context context) {
        return UiLanguagePolicy.resolve(preference(context), deviceLanguages(context));
    }

    public static Context wrap(Context base) {
        Configuration config = new Configuration(base.getResources().getConfiguration());
        Locale locale = Locale.forLanguageTag(resolved(base));
        config.setLocale(locale);
        config.setLayoutDirection(locale);
        return base.createConfigurationContext(config);
    }

    public static String state(Context context) {
        try {
            JSONObject result = new JSONObject();
            result.put("preference", preference(context));
            result.put("deviceLanguages", new JSONArray(deviceLanguages(context)));
            result.put("language", resolved(context));
            return result.toString();
        } catch (Exception ignored) { return "{}"; }
    }

    public static boolean set(Activity activity, String value) {
        String normalized = UiLanguagePolicy.normalize(value);
        if (!"auto".equals(value) && !normalized.equals(value)) return false;
        if (value.equals(preference(activity))) return true;
        if (Build.VERSION.SDK_INT >= 33) {
            LocaleManager manager = activity.getSystemService(LocaleManager.class);
            if (manager == null) return false;
            // Framework persists the preference and dispatches the configuration change.
            manager.setApplicationLocales("auto".equals(value) ? LocaleList.getEmptyLocaleList()
                    : LocaleList.forLanguageTags(value));
        } else {
            boolean saved = activity.getSharedPreferences(STORE, Context.MODE_PRIVATE)
                    .edit().putString(KEY, value).commit();
            if (!saved) return false;
            activity.runOnUiThread(activity::recreate);
        }
        return true;
    }
}
