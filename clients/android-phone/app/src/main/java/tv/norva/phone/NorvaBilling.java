package tv.norva.phone;

import android.app.Activity;

import com.revenuecat.purchases.CustomerInfo;
import com.revenuecat.purchases.EntitlementInfo;
import com.revenuecat.purchases.Offering;
import com.revenuecat.purchases.Offerings;
import com.revenuecat.purchases.Package;
import com.revenuecat.purchases.PurchaseParams;
import com.revenuecat.purchases.Purchases;
import com.revenuecat.purchases.PurchasesError;
import com.revenuecat.purchases.Store;
import com.revenuecat.purchases.interfaces.LogInCallback;
import com.revenuecat.purchases.interfaces.PurchaseCallback;
import com.revenuecat.purchases.interfaces.ReceiveCustomerInfoCallback;
import com.revenuecat.purchases.interfaces.ReceiveOfferingsCallback;
import com.revenuecat.purchases.models.GoogleReplacementMode;
import com.revenuecat.purchases.models.StoreTransaction;

/**
 * Thin wrapper around the RevenueCat SDK for the WebView billing bridge.
 *
 * Targets the RevenueCat Android SDK v8. All of the SDK surface lives in this
 * one file so it is easy to verify/adjust on the first real build. Every call
 * is a safe no-op (reporting an error to the callback) when the SDK is not
 * configured — i.e. when no REVENUECAT_API_KEY was provided at build time — so
 * the app keeps working with billing simply unavailable.
 */
final class NorvaBilling {

    /** status is one of: success | restored | cancelled | unavailable | error. */
    interface ResultCallback {
        void onResult(String status, String error);
    }

    private NorvaBilling() {
    }

    static boolean isReady() {
        try {
            return Purchases.isConfigured();
        } catch (Throwable t) {
            return false;
        }
    }

    /** Map the RevenueCat App User ID to the Supabase user id (account-scoped). */
    static void login(String userId) {
        if (!isReady() || userId == null || userId.isEmpty()) return;
        try {
            Purchases.getSharedInstance().logIn(userId, new LogInCallback() {
                @Override
                public void onReceived(CustomerInfo customerInfo, boolean created) {
                }

                @Override
                public void onError(PurchasesError error) {
                }
            });
        } catch (Throwable ignored) {
        }
    }

    static void purchase(final Activity activity, final String packageId, final ResultCallback cb) {
        if (!isReady()) {
            cb.onResult("unavailable", "billing_not_configured");
            return;
        }
        try {
            Purchases.getSharedInstance().getOfferings(new ReceiveOfferingsCallback() {
                @Override
                public void onReceived(Offerings offerings) {
                    Package target = findPackage(offerings, packageId);
                    if (target == null) {
                        cb.onResult("error", "package_not_found");
                        return;
                    }
                    // Plan switch? Google Play needs to know which subscription is being
                    // REPLACED, or the purchase opens a second, parallel subscription
                    // (or is rejected outright). Look up the active Play subscription
                    // first; a lookup failure degrades to a plain purchase (first buy).
                    Purchases.getSharedInstance().getCustomerInfo(new ReceiveCustomerInfoCallback() {
                        @Override
                        public void onReceived(CustomerInfo customerInfo) {
                            launchPurchase(activity, target, activePlayProductId(customerInfo), cb);
                        }

                        @Override
                        public void onError(PurchasesError error) {
                            launchPurchase(activity, target, null, cb);
                        }
                    });
                }

                @Override
                public void onError(PurchasesError error) {
                    cb.onResult("error", messageOf(error));
                }
            });
        } catch (Throwable t) {
            cb.onResult("error", String.valueOf(t.getMessage()));
        }
    }

    /**
     * Launch the purchase, as a REPLACEMENT of {@code oldProductId} when one is
     * active. WITH_TIME_PRORATION is the one replacement mode Google accepts for
     * both upgrades and downgrades: the new plan starts immediately and the
     * remaining paid time converts into time credit on it (no double billing).
     * CHARGE_PRORATED_PRICE is NOT valid for monthly→annual (Google only allows
     * it when the price per unit of time increases, and annual is cheaper per day).
     */
    private static void launchPurchase(Activity activity, Package target, String oldProductId, ResultCallback cb) {
        PurchaseParams.Builder builder = new PurchaseParams.Builder(activity, target);
        if (oldProductId != null && !oldProductId.isEmpty()) {
            builder = builder
                    .oldProductId(oldProductId)
                    .googleReplacementMode(GoogleReplacementMode.WITH_TIME_PRORATION);
        }
        Purchases.getSharedInstance().purchase(builder.build(), new PurchaseCallback() {
            @Override
            public void onCompleted(StoreTransaction storeTransaction, CustomerInfo customerInfo) {
                cb.onResult("success", null);
            }

            @Override
            public void onError(PurchasesError error, boolean userCancelled) {
                cb.onResult(userCancelled ? "cancelled" : "error",
                        userCancelled ? null : messageOf(error));
            }
        });
    }

    /**
     * Subscription id of the active Google Play entitlement, or null when there is
     * none (first purchase, or the plan lives on another rail — web/Apple — which
     * Play knows nothing about and must never be passed as oldProductId). A
     * ":basePlan" suffix is stripped: Play replacements target the subscription id.
     */
    private static String activePlayProductId(CustomerInfo customerInfo) {
        try {
            if (customerInfo == null) return null;
            for (EntitlementInfo e : customerInfo.getEntitlements().getActive().values()) {
                if (e != null && e.getStore() == Store.PLAY_STORE) {
                    String pid = e.getProductIdentifier();
                    if (pid != null && !pid.isEmpty()) {
                        int sep = pid.indexOf(':');
                        return sep > 0 ? pid.substring(0, sep) : pid;
                    }
                }
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    static void restore(final ResultCallback cb) {
        if (!isReady()) {
            cb.onResult("unavailable", "billing_not_configured");
            return;
        }
        try {
            Purchases.getSharedInstance().restorePurchases(new ReceiveCustomerInfoCallback() {
                @Override
                public void onReceived(CustomerInfo customerInfo) {
                    cb.onResult("restored", null);
                }

                @Override
                public void onError(PurchasesError error) {
                    cb.onResult("error", messageOf(error));
                }
            });
        } catch (Throwable t) {
            cb.onResult("error", String.valueOf(t.getMessage()));
        }
    }

    private static Package findPackage(Offerings offerings, String packageId) {
        if (offerings == null || packageId == null) return null;
        Package match = matchIn(offerings.getCurrent(), packageId);
        if (match != null) return match;
        for (Offering offering : offerings.getAll().values()) {
            match = matchIn(offering, packageId);
            if (match != null) return match;
        }
        return null;
    }

    private static Package matchIn(Offering offering, String packageId) {
        if (offering == null) return null;
        for (Package pkg : offering.getAvailablePackages()) {
            if (packageId.equals(pkg.getIdentifier())) return pkg;
        }
        return null;
    }

    private static String messageOf(PurchasesError error) {
        return error == null ? "error" : String.valueOf(error.getMessage());
    }
}
