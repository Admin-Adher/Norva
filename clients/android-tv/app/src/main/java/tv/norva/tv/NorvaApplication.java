package tv.norva.tv;

import android.app.Application;

import com.revenuecat.purchases.LogLevel;
import com.revenuecat.purchases.Purchases;
import com.revenuecat.purchases.PurchasesConfiguration;

/**
 * Configures the RevenueCat SDK once per process.
 *
 * The public SDK key is injected at build time via the Gradle property
 * REVENUECAT_API_KEY (see build.gradle / docs/roadmap/billing-setup.md §7). When it is
 * absent the SDK stays unconfigured and the app runs normally with billing
 * unavailable, so debug/local builds need no key.
 */
public class NorvaApplication extends Application {

    @Override
    public void onCreate() {
        super.onCreate();
        String apiKey = BuildConfig.REVENUECAT_API_KEY;
        if (apiKey != null && !apiKey.isEmpty()) {
            Purchases.setLogLevel(LogLevel.WARN);
            Purchases.configure(new PurchasesConfiguration.Builder(this, apiKey).build());
        }
    }
}
