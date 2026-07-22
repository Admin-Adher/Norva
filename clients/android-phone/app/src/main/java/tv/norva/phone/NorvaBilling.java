package tv.norva.phone;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import com.revenuecat.purchases.CustomerInfo;
import com.revenuecat.purchases.EntitlementInfo;
import com.revenuecat.purchases.Offering;
import com.revenuecat.purchases.Offerings;
import com.revenuecat.purchases.Package;
import com.revenuecat.purchases.PeriodType;
import com.revenuecat.purchases.PurchaseParams;
import com.revenuecat.purchases.Purchases;
import com.revenuecat.purchases.PurchasesError;
import com.revenuecat.purchases.Store;
import com.revenuecat.purchases.interfaces.LogInCallback;
import com.revenuecat.purchases.interfaces.PurchaseCallback;
import com.revenuecat.purchases.interfaces.ReceiveCustomerInfoCallback;
import com.revenuecat.purchases.interfaces.ReceiveOfferingsCallback;
import com.revenuecat.purchases.models.GoogleReplacementMode;
import com.revenuecat.purchases.models.Period;
import com.revenuecat.purchases.models.Price;
import com.revenuecat.purchases.models.PricingPhase;
import com.revenuecat.purchases.models.StoreProduct;
import com.revenuecat.purchases.models.StoreTransaction;
import com.revenuecat.purchases.models.SubscriptionOption;
import com.google.firebase.analytics.FirebaseAnalytics;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Date;
import java.util.List;
import java.util.Locale;

/** Account-bound RevenueCat bridge used by the WebView paywall. */
final class NorvaBilling {

    interface ResultCallback {
        void onResult(String status, String error);
    }

    interface PurchaseResultCallback {
        void onResult(String status, String error, String detailsJson);
    }

    interface OfferingsCallback {
        void onResult(String payloadJson);
    }

    private interface AccountCallback {
        void onReady(Purchases purchases);
        void onError(String error);
    }

    private static final Object OPERATION_LOCK = new Object();
    private static final Handler OPERATION_HANDLER = new Handler(Looper.getMainLooper());
    private static final long OPERATION_TIMEOUT_MS = 6L * 60L * 1000L;
    private static String operationUserId;
    private static long operationSequence;
    private static long activeOperationToken;
    private static Runnable activeOperationWatchdog;

    private NorvaBilling() {
    }

    static boolean isReady() {
        try {
            return Purchases.isConfigured();
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * Fetch only RevenueCat's current offering after an exact account login.
     * Targeting and trial eligibility are account-specific, so an anonymous or
     * previously logged-in catalog must never be reused for another Norva user.
     */
    static void getOfferingsForUser(final String userId, final String requestId,
                                    final OfferingsCallback cb) {
        if (cb == null) return;
        final long operationToken = beginOperation(userId, new Runnable() {
            @Override
            public void run() {
                cb.onResult(offeringsPayload(requestId, userId, "error", null,
                        "billing_timeout"));
            }
        });
        if (operationToken == 0L) {
            cb.onResult(offeringsPayload(requestId, userId, "error", null,
                    validUserId(userId) ? "billing_account_busy" : "invalid_user_id"));
            return;
        }
        withLoggedInUser(userId, new AccountCallback() {
            @Override
            public void onReady(Purchases purchases) {
                if (!isOperationActive(operationToken)) return;
                try {
                    purchases.getOfferings(new ReceiveOfferingsCallback() {
                        @Override
                        public void onReceived(Offerings offerings) {
                            if (!completeOperation(operationToken)) return;
                            Offering current = offerings == null ? null : offerings.getCurrent();
                            if (current == null) {
                                cb.onResult(offeringsPayload(requestId, userId, "error", null,
                                        "current_offering_unavailable"));
                                return;
                            }
                            cb.onResult(offeringsPayload(requestId, userId, "success", current, null));
                        }

                        @Override
                        public void onError(PurchasesError error) {
                            if (!completeOperation(operationToken)) return;
                            cb.onResult(offeringsPayload(requestId, userId, "error", null,
                                    messageOf(error)));
                        }
                    });
                } catch (Throwable t) {
                    if (!completeOperation(operationToken)) return;
                    cb.onResult(offeringsPayload(requestId, userId, "error", null,
                            safeMessage(t)));
                }
            }

            @Override
            public void onError(String error) {
                if (!completeOperation(operationToken)) return;
                cb.onResult(offeringsPayload(requestId, userId, "error", null, error));
            }
        });
    }

    /**
     * Buy exactly the product that was rendered from the current offering.
     * Every identifier is rechecked against a fresh, account-targeted catalog.
     */
    static void purchaseForUser(final Activity activity, final String userId,
                                final String accessToken,
                                final String offeringId, final String packageId,
                                final String productId, final String planCode,
                                final String placement,
                                final String requestId,
                                final PurchaseResultCallback cb) {
        if (cb == null) return;
        if (!validPurchaseRequest(offeringId, packageId, productId, planCode)
                || !("locked_profile".equals(placement) || "subscribe_plans".equals(placement))) {
            cb.onResult("error", "invalid_purchase_request", null);
            return;
        }
        final long operationToken = beginOperation(userId, new Runnable() {
            @Override
            public void run() {
                cb.onResult("error", "billing_timeout", null);
            }
        });
        if (operationToken == 0L) {
            cb.onResult("error", validUserId(userId) ? "billing_account_busy" : "invalid_user_id", null);
            return;
        }
        withLoggedInUser(userId, new AccountCallback() {
            @Override
            public void onReady(final Purchases purchases) {
                if (!isOperationActive(operationToken)) return;
                try {
                    purchases.getOfferings(new ReceiveOfferingsCallback() {
                        @Override
                        public void onReceived(Offerings offerings) {
                            if (!isOperationActive(operationToken)) return;
                            Offering current = offerings == null ? null : offerings.getCurrent();
                            if (current == null || !offeringId.equals(current.getIdentifier())) {
                                finishPurchaseError(operationToken, cb, "stale_or_non_current_offering");
                                return;
                            }
                            Package target = findExactPackage(current, packageId, productId);
                            if (target == null) {
                                finishPurchaseError(operationToken, cb, "package_product_mismatch");
                                return;
                            }
                            String expectedProduct = "family".equals(planCode) ? "norva_family" : "norva_plus";
                            if (!expectedProduct.equals(baseProductId(productId))) {
                                finishPurchaseError(operationToken, cb, "plan_product_mismatch");
                                return;
                            }
                            PackageSupport support = inspectPackage(target);
                            if (!support.supported) {
                                finishPurchaseError(operationToken, cb, "unsupported_offer_" + support.reason);
                                return;
                            }
                            loadCustomerInfoAndPurchase(activity, purchases, userId, accessToken,
                                    current, target, support, operationToken, planCode, placement, requestId, cb);
                        }

                        @Override
                        public void onError(PurchasesError error) {
                            finishPurchaseError(operationToken, cb, messageOf(error));
                        }
                    });
                } catch (Throwable t) {
                    finishPurchaseError(operationToken, cb, safeMessage(t));
                }
            }

            @Override
            public void onError(String error) {
                finishPurchaseError(operationToken, cb, error);
            }
        });
    }

    private static void loadCustomerInfoAndPurchase(final Activity activity,
                                                    final Purchases purchases,
                                                    final String userId,
                                                    final String accessToken,
                                                    final Offering offering,
                                                    final Package target,
                                                    final PackageSupport support,
                                                    final long operationToken,
                                                    final String planCode,
                                                    final String placement,
                                                    final String requestId,
                                                    final PurchaseResultCallback cb) {
        if (!isOperationActive(operationToken)) return;
        try {
            purchases.getCustomerInfo(new ReceiveCustomerInfoCallback() {
                @Override
                public void onReceived(CustomerInfo customerInfo) {
                    if (!isOperationActive(operationToken)) return;
                    launchPurchase(activity, purchases, userId, accessToken, offering, target, support,
                            activePlayProductId(customerInfo), operationToken, planCode, placement, requestId, cb);
                }

                @Override
                public void onError(PurchasesError error) {
                    // Without the existing Play subscription id a plan switch can
                    // accidentally create a parallel subscription. Fail closed.
                    finishPurchaseError(operationToken, cb, "customer_info_unavailable");
                }
            });
        } catch (Throwable t) {
            finishPurchaseError(operationToken, cb, "customer_info_unavailable");
        }
    }

    private static void launchPurchase(final Activity activity, final Purchases purchases,
                                       final String userId, final String accessToken, final Offering offering,
                                       final Package target, final PackageSupport support,
                                       final String oldProductId,
                                       final long operationToken, final String planCode,
                                       final String placement,
                                       final String requestId,
                                       final PurchaseResultCallback cb) {
        if (!isOperationActive(operationToken)) return;
        try {
            PurchaseParams.Builder builder = new PurchaseParams.Builder(activity, target);
            if (oldProductId != null && !oldProductId.isEmpty()) {
                builder = builder.oldProductId(oldProductId)
                        .googleReplacementMode(GoogleReplacementMode.WITH_TIME_PRORATION);
            }
            recordCheckoutStarted(activity, target, planCode);
            NativeBillingTelemetry.recordCheckoutStarted(accessToken, requestId, offering,
                    target, support, planCode, placement);
            purchases.purchase(builder.build(), new PurchaseCallback() {
                @Override
                public void onCompleted(StoreTransaction transaction, CustomerInfo customerInfo) {
                    if (!completeOperation(operationToken)) return;
                    cb.onResult("success", null, purchaseDetails(userId, offering, target,
                            support, transaction, customerInfo));
                }

                @Override
                public void onError(PurchasesError error, boolean userCancelled) {
                    if (!completeOperation(operationToken)) return;
                    cb.onResult(userCancelled ? "cancelled" : "error",
                            userCancelled ? null : messageOf(error), null);
                }
            });
        } catch (Throwable t) {
            finishPurchaseError(operationToken, cb, safeMessage(t));
        }
    }

    static void restoreForUser(final String userId, final ResultCallback cb) {
        if (cb == null) return;
        final long operationToken = beginOperation(userId, new Runnable() {
            @Override
            public void run() {
                cb.onResult("error", "billing_timeout");
            }
        });
        if (operationToken == 0L) {
            cb.onResult("error", validUserId(userId) ? "billing_account_busy" : "invalid_user_id");
            return;
        }
        withLoggedInUser(userId, new AccountCallback() {
            @Override
            public void onReady(Purchases purchases) {
                if (!isOperationActive(operationToken)) return;
                try {
                    purchases.restorePurchases(new ReceiveCustomerInfoCallback() {
                        @Override
                        public void onReceived(CustomerInfo customerInfo) {
                            if (!completeOperation(operationToken)) return;
                            cb.onResult("restored", null);
                        }

                        @Override
                        public void onError(PurchasesError error) {
                            if (!completeOperation(operationToken)) return;
                            cb.onResult("error", messageOf(error));
                        }
                    });
                } catch (Throwable t) {
                    if (!completeOperation(operationToken)) return;
                    cb.onResult("error", safeMessage(t));
                }
            }

            @Override
            public void onError(String error) {
                if (!completeOperation(operationToken)) return;
                cb.onResult("error", error);
            }
        });
    }

    private static void withLoggedInUser(final String userId, final AccountCallback cb) {
        if (!isReady()) {
            cb.onError("billing_not_configured");
            return;
        }
        try {
            final Purchases purchases = Purchases.getSharedInstance();
            if (userId.equals(purchases.getAppUserID())) {
                cb.onReady(purchases);
                return;
            }
            purchases.logIn(userId, new LogInCallback() {
                @Override
                public void onReceived(CustomerInfo customerInfo, boolean created) {
                    try {
                        if (!userId.equals(purchases.getAppUserID())) {
                            cb.onError("billing_account_mismatch");
                            return;
                        }
                        cb.onReady(purchases);
                    } catch (Throwable t) {
                        cb.onError("billing_account_mismatch");
                    }
                }

                @Override
                public void onError(PurchasesError error) {
                    cb.onError("billing_login_failed");
                }
            });
        } catch (Throwable t) {
            cb.onError("billing_login_failed");
        }
    }

    private static long beginOperation(String userId, final Runnable onTimeout) {
        if (!validUserId(userId)) return 0L;
        synchronized (OPERATION_LOCK) {
            // RevenueCat has one process-global account. Serialize every account-
            // scoped operation, including two requests from the same account.
            if (activeOperationToken != 0L) return 0L;
            operationSequence += 1L;
            if (operationSequence == 0L) operationSequence = 1L;
            final long token = operationSequence;
            operationUserId = userId;
            activeOperationToken = token;
            activeOperationWatchdog = new Runnable() {
                @Override
                public void run() {
                    if (completeOperation(token) && onTimeout != null) onTimeout.run();
                }
            };
            OPERATION_HANDLER.postDelayed(activeOperationWatchdog, OPERATION_TIMEOUT_MS);
            return token;
        }
    }

    private static boolean isOperationActive(long token) {
        synchronized (OPERATION_LOCK) {
            return token != 0L && activeOperationToken == token;
        }
    }

    private static boolean completeOperation(long token) {
        synchronized (OPERATION_LOCK) {
            if (token == 0L || activeOperationToken != token) return false;
            if (activeOperationWatchdog != null) {
                OPERATION_HANDLER.removeCallbacks(activeOperationWatchdog);
            }
            activeOperationWatchdog = null;
            activeOperationToken = 0L;
            operationUserId = null;
            return true;
        }
    }

    private static boolean validUserId(String userId) {
        if (userId == null || userId.length() < 8 || userId.length() > 128) return false;
        return userId.equals(userId.trim()) && !userId.startsWith("$RCAnonymousID:");
    }

    private static boolean validPurchaseRequest(String offeringId, String packageId,
                                                String productId, String planCode) {
        if (offeringId == null || offeringId.isEmpty() || packageId == null || packageId.isEmpty()
                || productId == null || productId.isEmpty()) return false;
        return "plus".equals(planCode) || "family".equals(planCode);
    }

    private static Package findExactPackage(Offering offering, String packageId, String productId) {
        if (offering == null) return null;
        Package match = null;
        int matches = 0;
        for (Package pkg : offering.getAvailablePackages()) {
            if (pkg == null || pkg.getProduct() == null) continue;
            String storeProductId = pkg.getProduct().getId();
            boolean exactStoreProductRequested = productId.indexOf(':') > 0;
            boolean productMatches = baseProductId(productId).equals(baseProductId(storeProductId))
                    && (!exactStoreProductRequested || productId.equals(storeProductId));
            if (packageId.equals(pkg.getIdentifier()) && productMatches) {
                match = pkg;
                matches += 1;
            }
        }
        return matches == 1 ? match : null;
    }

    private static PackageSupport inspectPackage(Package pkg) {
        if (pkg == null || pkg.getProduct() == null) return PackageSupport.no("missing_product");
        StoreProduct product = pkg.getProduct();
        Price price = product.getPrice();
        Period period = product.getPeriod();
        String periodIso = period == null ? "" : period.getIso8601();
        if (!("P1M".equals(periodIso) || "P1Y".equals(periodIso))) {
            return PackageSupport.no("billing_period");
        }
        if (price == null || price.getAmountMicros() <= 0 || price.getFormatted() == null
                || price.getFormatted().isEmpty() || price.getCurrencyCode() == null
                || price.getCurrencyCode().isEmpty()) {
            return PackageSupport.no("price");
        }
        SubscriptionOption option = product.getDefaultOption();
        if (option == null) return PackageSupport.no("subscription_option");
        PricingPhase paidIntro = option.getIntroPhase();
        if (paidIntro != null) return PackageSupport.no("paid_introductory_phase");

        PricingPhase free = option.getFreePhase();
        if (free == null) return PackageSupport.yes(false, null, 0);
        Price freePrice = free.getPrice();
        Integer cycles = free.getBillingCycleCount();
        Period freePeriod = free.getBillingPeriod();
        if (freePrice == null || freePrice.getAmountMicros() != 0 || cycles == null
                || cycles < 1 || freePeriod == null || freePeriod.getIso8601() == null
                || freePeriod.getIso8601().isEmpty()) {
            return PackageSupport.no("trial_phase");
        }
        return PackageSupport.yes(true, freePeriod.getIso8601(), cycles);
    }

    private static String offeringsPayload(String requestId, String userId, String status,
                                           Offering current, String error) {
        try {
            JSONObject root = new JSONObject();
            root.put("nativeBillingContract", 2);
            root.put("requestId", requestId == null ? "" : requestId);
            root.put("appUserId", userId == null ? "" : userId);
            root.put("status", status == null ? "error" : status);
            if (error != null && !error.isEmpty()) root.put("error", error);
            JSONArray packages = new JSONArray();
            root.put("packages", packages);
            if (current == null) return root.toString();
            root.put("currentOfferingId", current.getIdentifier());
            for (Package pkg : current.getAvailablePackages()) {
                if (pkg != null && pkg.getProduct() != null) {
                    packages.put(packageJson(current, pkg));
                }
            }
            return root.toString();
        } catch (Throwable t) {
            return fallbackOfferingsPayload(requestId, userId);
        }
    }

    private static JSONObject packageJson(Offering offering, Package pkg) {
        JSONObject out = new JSONObject();
        StoreProduct product = pkg.getProduct();
        Price price = product.getPrice();
        Period period = product.getPeriod();
        SubscriptionOption option = product.getDefaultOption();
        PricingPhase free = option == null ? null : option.getFreePhase();
        PackageSupport support = inspectPackage(pkg);
        try {
            out.put("offeringId", offering.getIdentifier());
            out.put("packageId", pkg.getIdentifier());
            out.put("packageType", pkg.getPackageType() == null
                    ? "unknown" : pkg.getPackageType().name().toLowerCase(Locale.US));
            out.put("productId", baseProductId(product.getId()));
            out.put("storeProductId", product.getId());
            out.put("supported", support.supported);
            if (!support.supported) out.put("unsupportedReason", support.reason);
            if (price != null) {
                out.put("priceString", price.getFormatted());
                out.put("priceMicros", price.getAmountMicros());
                out.put("currencyCode", price.getCurrencyCode());
            }
            appendPeriod(out, "period", period);
            if (support.trialEligible && free != null) {
                out.put("trialEligibility", "eligible");
                appendPeriod(out, "trialPeriod", free.getBillingPeriod());
                out.put("trialBillingCycles", support.trialCycles);
                Price trialPrice = free.getPrice();
                if (trialPrice != null) out.put("trialPriceString", trialPrice.getFormatted());
            } else {
                out.put("trialEligibility", option == null ? "unknown" : "ineligible");
            }
        } catch (Throwable ignored) {
        }
        return out;
    }

    private static String purchaseDetails(String userId, Offering offering, Package target,
                                          PackageSupport support, StoreTransaction transaction,
                                          CustomerInfo customerInfo) {
        try {
            JSONObject out = new JSONObject();
            String storeProductId = target.getProduct().getId();
            String productId = baseProductId(storeProductId);
            out.put("nativeBillingContract", 2);
            out.put("appUserId", userId);
            out.put("offeringId", offering.getIdentifier());
            out.put("packageId", target.getIdentifier());
            out.put("productId", productId);
            out.put("storeProductId", storeProductId);
            out.put("selectedOfferTrialEligible", support.trialEligible);
            out.put("customerInfoVerified", customerInfo != null);
            boolean transactionMatches = transactionContainsProduct(transaction, productId);
            out.put("transactionMatchesProduct", transactionMatches);

            EntitlementInfo matchedEntitlement = matchingActiveEntitlement(customerInfo, productId);
            boolean subscriptionActive = matchedEntitlement != null
                    || customerHasActiveProduct(customerInfo, productId);
            boolean trialActive = matchedEntitlement != null
                    && matchedEntitlement.getPeriodType() == PeriodType.TRIAL;
            out.put("entitlementActive", subscriptionActive);
            out.put("trialActive", trialActive);
            if (matchedEntitlement != null) {
                out.put("periodType", matchedEntitlement.getPeriodType().name().toLowerCase(Locale.US));
                Date expiration = matchedEntitlement.getExpirationDate();
                if (expiration != null) out.put("expirationAtMillis", expiration.getTime());
            }
            return out.toString();
        } catch (Throwable ignored) {
            return "{\"customerInfoVerified\":false,\"transactionMatchesProduct\":false}";
        }
    }

    private static boolean transactionContainsProduct(StoreTransaction transaction, String productId) {
        if (transaction == null || productId == null) return false;
        try {
            List<String> ids = transaction.getProductIds();
            if (ids == null) return false;
            for (String id : ids) if (sameProduct(id, productId)) return true;
        } catch (Throwable ignored) {
        }
        return false;
    }

    private static EntitlementInfo matchingActiveEntitlement(CustomerInfo customerInfo, String productId) {
        if (customerInfo == null) return null;
        try {
            for (EntitlementInfo entitlement : customerInfo.getEntitlements().getActive().values()) {
                if (entitlement != null && entitlement.getStore() == Store.PLAY_STORE
                        && sameProduct(entitlement.getProductIdentifier(), productId)) {
                    return entitlement;
                }
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    private static boolean customerHasActiveProduct(CustomerInfo customerInfo, String productId) {
        if (customerInfo == null) return false;
        try {
            for (String id : customerInfo.getActiveSubscriptions()) {
                if (sameProduct(id, productId)) return true;
            }
        } catch (Throwable ignored) {
        }
        return false;
    }

    private static boolean sameProduct(String left, String right) {
        if (left == null || right == null) return false;
        return baseProductId(left).equals(baseProductId(right));
    }

    private static String baseProductId(String value) {
        int separator = value.indexOf(':');
        return separator > 0 ? value.substring(0, separator) : value;
    }

    private static String activePlayProductId(CustomerInfo customerInfo) {
        try {
            if (customerInfo == null) return null;
            for (EntitlementInfo entitlement : customerInfo.getEntitlements().getActive().values()) {
                if (entitlement != null && entitlement.getStore() == Store.PLAY_STORE) {
                    String productId = entitlement.getProductIdentifier();
                    if (productId != null && !productId.isEmpty()) return baseProductId(productId);
                }
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    private static void appendPeriod(JSONObject out, String prefix, Period period) {
        if (period == null) return;
        try {
            out.put(prefix + "Iso8601", period.getIso8601());
            out.put(prefix + "Unit", period.getUnit().name().toLowerCase(Locale.US));
            out.put(prefix + "Value", period.getValue());
        } catch (Throwable ignored) {
        }
    }

    private static void finishPurchaseError(long operationToken, PurchaseResultCallback cb, String error) {
        if (!completeOperation(operationToken)) return;
        cb.onResult("error", error == null || error.isEmpty() ? "billing_error" : error, null);
    }

    /** Logs the moment the Google Play purchase sheet is actually requested. */
    private static void recordCheckoutStarted(Activity activity, Package target, String planCode) {
        if (activity == null || target == null || target.getProduct() == null) return;
        try {
            StoreProduct product = target.getProduct();
            Price price = product.getPrice();
            Bundle event = new Bundle();
            event.putString(FirebaseAnalytics.Param.ITEM_ID, target.getIdentifier());
            event.putString(FirebaseAnalytics.Param.ITEM_NAME, planCode);
            event.putString(FirebaseAnalytics.Param.ITEM_CATEGORY, "subscription");
            event.putString("store_product_id", product.getId());
            if (price != null) {
                event.putString(FirebaseAnalytics.Param.CURRENCY, price.getCurrencyCode());
                event.putDouble(FirebaseAnalytics.Param.VALUE,
                        price.getAmountMicros() / 1_000_000.0d);
            }
            FirebaseAnalytics.getInstance(activity)
                    .logEvent(FirebaseAnalytics.Event.BEGIN_CHECKOUT, event);
        } catch (Throwable ignored) {
            // Analytics must never prevent the Play purchase sheet from opening.
        }
    }

    private static String fallbackOfferingsPayload(String requestId, String userId) {
        try {
            JSONObject fallback = new JSONObject();
            fallback.put("nativeBillingContract", 2);
            fallback.put("requestId", requestId == null ? "" : requestId);
            fallback.put("appUserId", userId == null ? "" : userId);
            fallback.put("status", "error");
            fallback.put("error", "offerings_serialization_failed");
            fallback.put("packages", new JSONArray());
            return fallback.toString();
        } catch (Throwable ignored) {
            return "{\"status\":\"error\",\"error\":\"offerings_serialization_failed\",\"packages\":[]}";
        }
    }

    private static String messageOf(PurchasesError error) {
        return error == null ? "billing_error" : String.valueOf(error.getMessage());
    }

    private static String safeMessage(Throwable throwable) {
        if (throwable == null || throwable.getMessage() == null || throwable.getMessage().isEmpty()) {
            return "billing_error";
        }
        return String.valueOf(throwable.getMessage());
    }

    static final class PackageSupport {
        final boolean supported;
        final String reason;
        final boolean trialEligible;
        final String trialPeriod;
        final int trialCycles;

        private PackageSupport(boolean supported, String reason, boolean trialEligible,
                               String trialPeriod, int trialCycles) {
            this.supported = supported;
            this.reason = reason;
            this.trialEligible = trialEligible;
            this.trialPeriod = trialPeriod;
            this.trialCycles = trialCycles;
        }

        static PackageSupport no(String reason) {
            return new PackageSupport(false, reason, false, null, 0);
        }

        static PackageSupport yes(boolean trialEligible, String trialPeriod, int trialCycles) {
            return new PackageSupport(true, null, trialEligible, trialPeriod, trialCycles);
        }
    }
}
