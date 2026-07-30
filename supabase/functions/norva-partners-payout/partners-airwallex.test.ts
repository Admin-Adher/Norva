import {
  canAdvanceTransferState,
  canonicalTransferState,
  minorUnitsToDecimal,
  verifyAirwallexWebhook,
} from "../_shared/partners-airwallex.mjs";

Deno.test("Airwallex payout money and PAID semantics stay fail-closed", () => {
  if (minorUnitsToDecimal("499", 2) !== "4.99") {
    throw new Error("minor unit conversion drifted");
  }
  if (canonicalTransferState("PAID") !== "PAID") {
    throw new Error("PAID mapping drifted");
  }
  if (!canAdvanceTransferState("PAID", "FAILED")) {
    throw new Error("late Airwallex failure was made unreachable");
  }
  if (canAdvanceTransferState("PAID", "PROCESSING")) {
    throw new Error("provider state regression was accepted");
  }
});

Deno.test("Airwallex webhook HMAC binds timestamp and raw body", async () => {
  const timestamp = "1785402720000";
  const rawBody =
    '{"id":"evt_0123456789abcdef","name":"payout.transfer.paid","data":{"id":"370d83d6-52e8-4bdd-97b6-56d18c5ba4d0"}}';
  const secret = "webhook_secret_test";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(timestamp + rawBody),
  );
  const signature = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const valid = await verifyAirwallexWebhook({
    rawBody,
    timestamp,
    signature,
    secret,
    nowMs: Number(timestamp),
    toleranceMs: 60_000,
  });
  if (!valid) throw new Error("valid signature rejected");
});
