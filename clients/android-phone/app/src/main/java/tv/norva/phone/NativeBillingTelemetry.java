package tv.norva.phone;

import com.revenuecat.purchases.Offering;
import com.revenuecat.purchases.Package;
import com.revenuecat.purchases.models.Price;
import com.revenuecat.purchases.models.StoreProduct;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Best-effort server funnel event emitted at the real Play sheet launch. */
final class NativeBillingTelemetry {
    private static final String URL =
            "https://api.norva.tv/functions/v1/norva-cloud/experiments/paywall/checkout-start";

    private NativeBillingTelemetry() { }

    static void recordCheckoutStarted(final String authToken, final String requestId,
                                      final Offering offering, final Package pkg,
                                      final NorvaBilling.PackageSupport support,
                                      final String planCode, final String placement) {
        if (authToken == null || authToken.isEmpty() || authToken.length() > 16_384
                || requestId == null || requestId.isEmpty() || requestId.length() > 160
                || offering == null || pkg == null || pkg.getProduct() == null) return;
        final StoreProduct product = pkg.getProduct();
        final Price price = product.getPrice();
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                JSONObject body = new JSONObject();
                body.put("requestId", requestId);
                body.put("placement", placement);
                body.put("planCode", planCode);
                body.put("offeringId", offering.getIdentifier());
                body.put("packageId", pkg.getIdentifier());
                body.put("storeProductId", product.getId());
                body.put("billingCadence", product.getPeriod() == null
                        ? JSONObject.NULL : product.getPeriod().getIso8601());
                if (price != null) {
                    body.put("priceAmountMicros", price.getAmountMicros());
                    body.put("priceCurrency", price.getCurrencyCode());
                    body.put("priceFormatted", price.getFormatted());
                }
                body.put("trialEligible", support != null && support.trialEligible);
                byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
                connection = (HttpURLConnection) new URL(URL).openConnection();
                connection.setRequestMethod("POST");
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(4_000);
                connection.setReadTimeout(4_000);
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(payload.length);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setRequestProperty("Authorization", "Bearer " + authToken);
                OutputStream out = connection.getOutputStream();
                out.write(payload);
                out.close();
                InputStream in = connection.getResponseCode() < 400
                        ? connection.getInputStream() : connection.getErrorStream();
                if (in != null) { byte[] sink = new byte[256]; while (in.read(sink) != -1) { } in.close(); }
            } catch (Throwable ignored) {
                // Measurement must never delay or cancel the Play purchase sheet.
            } finally {
                if (connection != null) connection.disconnect();
            }
        }, "norva-checkout-started").start();
    }
}
