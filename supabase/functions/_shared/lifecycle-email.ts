// Lifecycle, billing and consent-gated marketing emails. These are pure render
// functions; norva-lifecycle owns cohort selection, consent and delivery.

const SITE_URL = "https://norva.tv";
const OPEN_URL = `${SITE_URL}/app.html`;
const SUBSCRIBE_URL = `${SITE_URL}/subscribe.html`;
const MANAGE_URL = `${SITE_URL}/subscription.html`;
const SUPPORT_EMAIL = "support@norva.tv";
const SUPPORT_URL = `mailto:${SUPPORT_EMAIL}`;
// CAN-SPAM requires a physical postal address in commercial mail. Marketing is
// fail-closed in the sender unless this value is configured.
const POSTAL_ADDRESS = (() => {
  try { return (Deno.env.get("NORVA_POSTAL_ADDRESS") ?? "").trim(); } catch (_) { return ""; }
})();

export interface EmailTag {
  name: "app" | "category" | "flow";
  value: string;
}

export interface Rendered {
  subject: string;
  html: string;
  text: string;
  tags: EmailTag[];
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function textValue(s: unknown, fallback = ""): string {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim() || fallback;
}

function tags(category: "transactional" | "marketing", flow: string): EmailTag[] {
  return [
    { name: "app", value: "norva" },
    { name: "category", value: category },
    { name: "flow", value: flow },
  ];
}

function greetHtml(firstName?: string | null): string {
  const name = textValue(firstName);
  return name ? `Hi ${esc(name)},` : "Hi,";
}

function greetText(firstName?: string | null): string {
  const name = textValue(firstName);
  return name ? `Hi ${name},` : "Hi,";
}

function button(label: string, url: string): string {
  return `<tr><td align="center" style="padding:8px 32px 30px">
    <table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr>
      <td align="center" bgcolor="#5b7cfa" style="background:#5b7cfa;border-radius:10px;mso-padding-alt:14px 30px">
        <a href="${esc(url)}" style="display:inline-block;padding:14px 30px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;line-height:1;text-decoration:none">${esc(label)}</a>
      </td>
    </tr></table>
  </td></tr>`;
}

// Generic branded shell. Only marketing templates receive an unsubscribe control.
// Transactional account/security/billing messages cannot be disabled by this preference.
function shell(opts: {
  title: string;
  preheader: string;
  heading: string;
  bodyHtml: string;
  cta?: { label: string; url: string };
  note?: string;
  unsubscribeUrl?: string;
}): string {
  const unsubscribe = opts.unsubscribeUrl
    ? `<a href="${esc(opts.unsubscribeUrl)}" style="color:#b8c8f2;text-decoration:underline">Unsubscribe</a>${POSTAL_ADDRESS ? ` &middot; ${esc(POSTAL_ADDRESS)}` : ""}<br>`
    : "";
  const cta = opts.cta ? button(opts.cta.label, opts.cta.url) : "";
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>${esc(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background:#0a0c11;color:#f8fafc;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
  <div data-preheader="true" style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;max-height:0;max-width:0;overflow:hidden;mso-hide:all">${esc(opts.preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#0a0c11" style="width:100%;background:#0a0c11;border-collapse:collapse">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#11151d" style="width:100%;max-width:500px;background:#11151d;border:1px solid #283143;border-radius:16px;border-collapse:separate">
        <tr><td align="center" style="padding:32px 32px 8px">
          <img src="${SITE_URL}/img/norva-app-icon.png" width="48" height="48" alt="" aria-hidden="true" style="display:block;width:48px;height:48px;border:0;border-radius:12px;outline:none;text-decoration:none">
          <p style="margin:10px 0 0;color:#ffffff;font-family:'Century Gothic',Arial,Helvetica,sans-serif;font-size:22px;font-weight:600;letter-spacing:-.02em;line-height:1.25">Norva</p>
        </td></tr>
        <tr><td align="center" style="padding:18px 32px 6px">
          <h1 style="margin:0;color:#f8fafc;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;line-height:1.3">${esc(opts.heading)}</h1>
        </td></tr>
        <tr><td style="padding:12px 32px 18px;color:#bcc5d6;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65">${opts.bodyHtml}</td></tr>
        ${cta}
        <tr><td style="padding:20px 32px 28px;border-top:1px solid #283143;color:#9ba6ba;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;text-align:center">
          ${opts.note ?? `Questions? <a href="${SUPPORT_URL}" style="color:#b8c8f2;text-decoration:underline">${SUPPORT_EMAIL}</a>. Norva is a media player and includes no content.`}
        </td></tr>
      </table>
      <p style="margin:16px 0 0;color:#8994a8;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.7;text-align:center">
        ${unsubscribe}&copy; Norva
      </p>
    </td></tr>
  </table>
</body>
</html>`;
}

function transactionalFooter(): string {
  return `Questions? ${SUPPORT_EMAIL}\nNorva is a media player and includes no content.\n© Norva`;
}

function marketingFooter(unsubscribeUrl?: string): string {
  return [
    unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : "",
    POSTAL_ADDRESS,
    `Questions? ${SUPPORT_EMAIL}`,
    "Norva is a media player and includes no content.",
    "© Norva",
  ].filter(Boolean).join("\n");
}

// Format a date like "12 July 2026" (UTC) for the reader.
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  } catch (_) { return ""; }
}

export function renderWelcome(firstName: string | null): Rendered {
  const subject = "Welcome to Norva — let's connect your first source";
  return {
    subject,
    tags: tags("transactional", "welcome"),
    text: `${greetText(firstName)}

Your Norva account is ready. Norva is a multi-screen media player: it includes no content of its own. Connect a compatible source you are authorized to use, and Norva will organize it and keep every screen in sync.

One step to start watching: open Norva and paste the link from the TV service you already use. Norva will build your catalog automatically. No card is needed to connect.

Connect my source: ${OPEN_URL}

You can watch on Web, Android phone, tablet and Android TV with the same account.

${transactionalFooter()}`,
    html: shell({
      title: subject,
      preheader: "Your Norva account is ready. Connect a compatible source to begin.",
      heading: "Welcome to Norva",
      bodyHtml: `<p style="margin:0 0 18px">${greetHtml(firstName)}</p>
        <p style="margin:0 0 18px">Your Norva account is ready. Norva is your <strong style="color:#e3e8f2">multi-screen media player</strong>: it includes no content of its own. Connect a compatible source you're authorized to use, and Norva will organize it and keep every screen in sync.</p>
        <p style="margin:0"><strong style="color:#e3e8f2">One step to start watching:</strong> open Norva and paste the link from the TV service you already use. Norva will build your catalog automatically. No card is needed to connect.</p>`,
      cta: { label: "Connect my source", url: OPEN_URL },
      note: "You can watch on Web, Android phone, tablet and Android TV with the same account.",
    }),
  };
}

export function renderTrialEnding(firstName: string | null, opts: { endsAt: string; planLabel?: string }): Rendered {
  const when = fmtDate(opts.endsAt);
  const planText = textValue(opts.planLabel, "your Norva plan");
  const subject = "Your Norva free trial ends in 2 days";
  return {
    subject,
    tags: tags("transactional", "trial_ending"),
    text: `${greetText(firstName)}

Your 7-day free trial ends${when ? ` on ${when}` : " soon"}. ${planText} will then renew automatically so your access continues without interruption.

Nothing to do if you would like to keep watching. If Norva is not for you, cancel before the trial ends and you will not be charged.

Manage my plan: ${MANAGE_URL}

${transactionalFooter()}`,
    html: shell({
      title: subject,
      preheader: when ? `Your trial ends on ${when}. Review your plan before it renews.` : "Your trial ends soon. Review your plan before it renews.",
      heading: "Your trial ends in 2 days",
      bodyHtml: `<p style="margin:0 0 18px">${greetHtml(firstName)}</p>
        <p style="margin:0 0 18px">Your <strong style="color:#e3e8f2">7-day free trial</strong> ends${when ? ` on <strong style="color:#e3e8f2">${when}</strong>` : " soon"}. ${esc(planText)} will then renew automatically so your access continues without interruption.</p>
        <p style="margin:0">Nothing to do if you'd like to keep watching. If Norva isn't for you, cancel before the trial ends and you won't be charged.</p>`,
      cta: { label: "Manage my plan", url: MANAGE_URL },
      note: `Cancel anytime from your account. Questions? <a href="${SUPPORT_URL}" style="color:#b8c8f2;text-decoration:underline">${SUPPORT_EMAIL}</a>.`,
    }),
  };
}

export function renderReceipt(firstName: string | null, opts: {
  planLabel?: string;
  amount?: string;
  currency?: string;
  billingPeriod?: string;
  confirmedAt?: string;
  periodEnd?: string;
  reference?: string;
}): Rendered {
  const planText = textValue(opts.planLabel, "Norva");
  const amountText = textValue(opts.amount);
  const currencyText = textValue(opts.currency).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
  const cadence = opts.billingPeriod === "annual"
    ? "Annual"
    : opts.billingPeriod === "monthly"
    ? "Monthly"
    : "";
  const confirmed = fmtDate(opts.confirmedAt);
  const periodEnd = fmtDate(opts.periodEnd);
  const reference = textValue(opts.reference).toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 32);
  const amountAndCurrency = [amountText, currencyText].filter(Boolean).join(" ");
  const details = [
    confirmed ? ["Payment date", confirmed] : null,
    ["Plan", planText],
    cadence ? ["Billing cycle", cadence] : null,
    amountAndCurrency ? ["Amount paid", amountAndCurrency] : null,
    periodEnd ? ["Access through", periodEnd] : null,
    reference ? ["Confirmation reference", reference] : null,
  ].filter(Boolean) as string[][];
  const detailsText = details.map(([label, value]) => `${label}: ${value}`).join("\n");
  const detailsHtml = details.map(([label, value]) =>
    `<tr><td style="padding:7px 12px 7px 0;color:#9ba6ba;vertical-align:top">${esc(label)}</td><td style="padding:7px 0;color:#e3e8f2;font-weight:600;text-align:right;vertical-align:top">${esc(value)}</td></tr>`
  ).join("");
  const subject = "Your Norva payment is confirmed";
  return {
    subject,
    // `payment_receipt` is retained as the historical internal analytics flow.
    // The customer-facing message deliberately makes no invoice, receipt or VAT
    // claim until Norva has the legal document fields required for one.
    tags: tags("transactional", "payment_receipt"),
    text: `${greetText(firstName)}

We confirm your Norva payment. Your access is active on all your screens.

${detailsText}

Open Norva: ${OPEN_URL}
Manage your plan: ${MANAGE_URL}

${transactionalFooter()}`,
    html: shell({
      title: subject,
      preheader: `Payment confirmed for ${planText}${amountAndCurrency ? ` · ${amountAndCurrency}` : ""}.`,
      heading: "Payment confirmed",
      bodyHtml: `<p style="margin:0 0 18px">${greetHtml(firstName)}</p>
        <p style="margin:0 0 16px">We confirm your Norva payment. Your access is active on all your screens.</p>
        <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid #283143;border-bottom:1px solid #283143">${detailsHtml}</table>`,
      cta: { label: "Open Norva", url: OPEN_URL },
      note: `Manage your plan at <a href="${MANAGE_URL}" style="color:#b8c8f2;text-decoration:underline">norva.tv/subscription</a>.`,
    }),
  };
}

export function renderPaymentFailed(firstName: string | null, stage: number): Rendered {
  // stage 1 = gentle, 2 = firmer, 3 = final notice before access pauses.
  const final = stage >= 3;
  const subject = final ? "Action needed: your Norva access is about to pause" : "We couldn't process your Norva payment";
  const action = final
    ? "To avoid losing access, update your payment method now."
    : "Update your payment method and we'll retry automatically. Your access continues in the meantime.";
  return {
    subject,
    tags: tags("transactional", "payment_failed"),
    text: `${greetText(firstName)}

We tried to renew your Norva subscription, but the payment did not go through${stage > 1 ? " on our latest attempt" : ""}. This usually means an expired card or insufficient funds.

${action}

Update payment method: ${MANAGE_URL}

Already fixed it? You can ignore this email.
${transactionalFooter()}`,
    html: shell({
      title: subject,
      preheader: final ? "Update your payment method now to avoid losing access." : "Update your payment method; your access continues while we retry.",
      heading: final ? "Last payment reminder" : "Payment issue",
      bodyHtml: `<p style="margin:0 0 18px">${greetHtml(firstName)}</p>
        <p style="margin:0 0 18px">We tried to renew your Norva subscription, but the payment didn't go through${stage > 1 ? " on our latest attempt" : ""}. This usually means an expired card or insufficient funds.</p>
        <p style="margin:0">${esc(action)}</p>`,
      cta: { label: "Update payment method", url: MANAGE_URL },
      note: `Already fixed it? You can ignore this email. Questions? <a href="${SUPPORT_URL}" style="color:#b8c8f2;text-decoration:underline">${SUPPORT_EMAIL}</a>.`,
    }),
  };
}

export function renderWinback(firstName: string | null, opts: { unsubscribeUrl?: string } = {}): Rendered {
  const subject = "Your Norva catalog is waiting";
  return {
    subject,
    tags: tags("marketing", "winback"),
    text: `${greetText(firstName)}

Your Norva account, sources and preferences are still here. Reactivate anytime and pick up your catalog on every screen, right where you left off.

Reactivate Norva: ${SUBSCRIBE_URL}

${marketingFooter(opts.unsubscribeUrl)}`,
    html: shell({
      title: subject,
      preheader: "Your sources and preferences are still here when you're ready to return.",
      heading: "Come back to Norva",
      bodyHtml: `<p style="margin:0 0 18px">${greetHtml(firstName)}</p>
        <p style="margin:0">Your Norva account, sources and preferences are still here. Reactivate anytime and pick up your catalog on every screen, right where you left off.</p>`,
      cta: { label: "Reactivate Norva", url: SUBSCRIBE_URL },
      note: "No longer need Norva? You can ignore this — we won't email you about this again.",
      unsubscribeUrl: opts.unsubscribeUrl,
    }),
  };
}

// Checkout-abandonment reminder: one email, 1–48h after the latest incomplete
// Revolut card check, deep-linked to the selected plan and period.
export function renderAbandonedCheckout(
  firstName: string | null,
  opts: { plan?: string; period?: string; validationAmount?: string; returnTo?: string; unsubscribeUrl?: string },
): Rendered {
  const plan = opts.plan === "family" ? "family" : "plus";
  const period = opts.period === "annual" ? "annual" : "monthly";
  const planName = plan === "family" ? "Norva Family" : "Norva";
  const returnTo = typeof opts.returnTo === "string" && /^\/(?!\/)/.test(opts.returnTo) ? opts.returnTo : "/app#home";
  const url = `${SITE_URL}/checkout-revolut.html?plan=${plan}&period=${period}&returnTo=${encodeURIComponent(returnTo)}`;
  const validationAmount = /^\$\d+(?:\.\d{2})?$/.test(opts.validationAmount ?? "")
    ? opts.validationAmount as string
    : "$0.50";
  const subject = "Your Norva free trial is one step away";
  return {
    subject,
    tags: tags("marketing", "checkout_abandoned"),
    text: `${greetText(firstName)}

You were one step away from starting your ${planName} free trial. The quick card check was not completed.

There is no charge today. Norva only places a temporary ${validationAmount} authorization that is released immediately and never debited. Your 7 days of full access start when the check completes.

Finish setup: ${url}

Changed your mind? Ignore this email; nothing was charged and nothing will be.
${marketingFooter(opts.unsubscribeUrl)}`,
    html: shell({
      title: subject,
      preheader: `Finish the card check to start 7 days of ${planName} at no charge today.`,
      heading: "Finish setting up your free trial",
      bodyHtml: `<p style="margin:0 0 18px">${greetHtml(firstName)}</p>
        <p style="margin:0 0 18px">You were one step away from starting your <strong style="color:#e3e8f2">${planName}</strong> free trial. The quick card check wasn't completed.</p>
        <p style="margin:0">There is <strong style="color:#e3e8f2">no charge today</strong>. Norva only places a temporary ${esc(validationAmount)} authorization that is released immediately and never debited. Your 7 days of full access start when the check completes.</p>`,
      cta: { label: "Finish setup", url },
      note: "Changed your mind? Ignore this email; nothing was charged and nothing will be.",
      unsubscribeUrl: opts.unsubscribeUrl,
    }),
  };
}

function renderBillingState(opts: {
  firstName: string | null;
  subject: string;
  heading: string;
  preheader: string;
  body: string;
  flow: string;
  ctaLabel?: string;
  ctaUrl?: string;
  note?: string;
}): Rendered {
  const cta = opts.ctaLabel && opts.ctaUrl ? { label: opts.ctaLabel, url: opts.ctaUrl } : undefined;
  return {
    subject: opts.subject,
    tags: tags("transactional", opts.flow),
    text: `${greetText(opts.firstName)}\n\n${opts.body}${cta ? `\n\n${cta.label}: ${cta.url}` : ""}\n\n${transactionalFooter()}`,
    html: shell({
      title: opts.subject,
      preheader: opts.preheader,
      heading: opts.heading,
      bodyHtml: `<p style="margin:0 0 18px">${greetHtml(opts.firstName)}</p><p style="margin:0">${esc(opts.body)}</p>`,
      cta,
      note: opts.note,
    }),
  };
}

// These pure renderers are ready for authoritative Web/Revolut event producers.
// No generic projection trigger calls them: each provider event must enqueue once
// from the transaction that owns its immutable event id.
export function renderCancellationConfirmed(firstName: string | null, opts: { effectiveAt?: string }): Rendered {
  const date = fmtDate(opts.effectiveAt);
  return renderBillingState({
    firstName,
    subject: "Your Norva cancellation is confirmed",
    heading: "Cancellation confirmed",
    preheader: date ? `Your access remains available through ${date}.` : "Your plan will not renew.",
    body: date
      ? `Your plan will not renew. You can keep watching on every screen through ${date}. You can reactivate before then without losing access.`
      : "Your plan will not renew. You can reactivate whenever you are ready.",
    flow: "cancellation_confirmed",
    ctaLabel: "Reactivate or manage plan",
    ctaUrl: MANAGE_URL,
  });
}

export function renderSubscriptionResumed(firstName: string | null, opts: { renewsAt?: string }): Rendered {
  const date = fmtDate(opts.renewsAt);
  return renderBillingState({
    firstName,
    subject: "Your Norva plan will continue",
    heading: "Cancellation removed",
    preheader: "Your Norva subscription is active and will continue.",
    body: date
      ? `Your cancellation was removed. Your access stays active and your plan is scheduled to renew on ${date}.`
      : "Your cancellation was removed. Your access stays active and your plan will continue normally.",
    flow: "subscription_resumed",
    ctaLabel: "Manage my plan",
    ctaUrl: MANAGE_URL,
  });
}

export function renderPlanChangeScheduled(firstName: string | null, opts: { planLabel: string; effectiveAt?: string }): Rendered {
  const plan = textValue(opts.planLabel, "your new Norva plan");
  const date = fmtDate(opts.effectiveAt);
  return renderBillingState({
    firstName,
    subject: "Your Norva plan change is scheduled",
    heading: "Plan change scheduled",
    preheader: date ? `${plan} starts on ${date}.` : `${plan} will start at your next renewal.`,
    body: date
      ? `Your change to ${plan} is confirmed and will take effect on ${date}. Your current access continues until then.`
      : `Your change to ${plan} is confirmed and will take effect at your next renewal.`,
    flow: "plan_change_scheduled",
    ctaLabel: "Review my plan",
    ctaUrl: MANAGE_URL,
  });
}

export function renderPlanChangeApplied(firstName: string | null, opts: { planLabel: string }): Rendered {
  const plan = textValue(opts.planLabel, "your new Norva plan");
  return renderBillingState({
    firstName,
    subject: "Your new Norva plan is active",
    heading: "Plan updated",
    preheader: `${plan} is now active on every screen.`,
    body: `Your plan was updated successfully. ${plan} is now active on every screen linked to your Norva account.`,
    flow: "plan_change_applied",
    ctaLabel: "Open Norva",
    ctaUrl: OPEN_URL,
  });
}

export function renderPaymentRecovered(firstName: string | null, opts: { nextBillingAt?: string }): Rendered {
  const date = fmtDate(opts.nextBillingAt);
  return renderBillingState({
    firstName,
    subject: "Your Norva payment issue is resolved",
    heading: "Payment recovered",
    preheader: "Your plan is active again; no further action is needed.",
    body: date
      ? `We successfully processed your payment. Your access remains active and your next billing date is ${date}. No further action is needed.`
      : "We successfully processed your payment. Your access remains active and no further action is needed.",
    flow: "payment_recovered",
    ctaLabel: "Open Norva",
    ctaUrl: OPEN_URL,
  });
}

export function renderAccessExpired(firstName: string | null): Rendered {
  return renderBillingState({
    firstName,
    subject: "Your Norva access has ended",
    heading: "Access ended",
    preheader: "Reactivate anytime to continue on every screen.",
    body: "Your paid Norva access has ended. Your account and preferences remain available, and you can choose a plan again whenever you are ready.",
    flow: "access_expired",
    ctaLabel: "See plans",
    ctaUrl: SUBSCRIBE_URL,
  });
}

export function renderRefundConfirmed(firstName: string | null, opts: { amount?: string; reference?: string }): Rendered {
  const amount = textValue(opts.amount);
  const reference = textValue(opts.reference).toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 32);
  const details = [amount ? `Amount: ${amount}.` : "", reference ? `Reference: ${reference}.` : ""].filter(Boolean).join(" ");
  return renderBillingState({
    firstName,
    subject: "Your Norva refund is confirmed",
    heading: "Refund confirmed",
    preheader: "Your refund has been issued to the original payment method.",
    body: `Your refund has been issued to the original payment method. ${details} Your bank may take several business days to display it.`.trim(),
    flow: "refund_confirmed",
    ctaLabel: "View my subscription",
    ctaUrl: MANAGE_URL,
  });
}
