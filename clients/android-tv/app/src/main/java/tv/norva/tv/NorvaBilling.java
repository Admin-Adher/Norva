package tv.norva.tv;

import android.app.Activity;

import com.revenuecat.purchases.CustomerInfo;
import com.revenuecat.purchases.Offering;
import com.revenuecat.purchases.Offerings;
import com.revenuecat.purchases.Package;
import com.revenuecat.purchases.PurchaseParams;
import com.revenuecat.purchases.Purchases;
import com.revenuecat.purchases.PurchasesError;
import com.revenuecat.purchases.interfaces.LogInCallback;
import com.revenuecat.purchases.interfaces.PurchaseCallback;
import com.revenuecat.purchases.interfaces.ReceiveCustomerInfoCallback;
import com.revenuecat.purchases.interfaces.ReceiveOfferingsCallback;
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
                    PurchaseParams params = new PurchaseParams.Builder(activity, target).build();
                    Purchases.getSharedInstance().purchase(params, new PurchaseCallback() {
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

                @Override
                public void onError(PurchasesError error) {
                    cb.onResult("error", messageOf(error));
                }
            });
        } catch (Throwable t) {
            cb.onResult("error", String.valueOf(t.getMessage()));
        }
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
