package tv.norva.i18n;

import android.app.Activity;
import android.webkit.JavascriptInterface;

/** Locale-only interface installed inside the existing selected-origin WebViews. */
public class UiLanguageBridge {
    private final Activity activity;
    public UiLanguageBridge(Activity activity) { this.activity = activity; }

    @JavascriptInterface
    public String getUiLanguageState() { return UiLanguage.state(activity); }

    @JavascriptInterface
    public boolean setUiLanguage(String preference) {
        try { return UiLanguage.set(activity, preference); }
        catch (RuntimeException ignored) { return false; }
    }
}
