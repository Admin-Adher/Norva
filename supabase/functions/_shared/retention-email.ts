import { renderEmailFrame } from "./email-frame.ts";
import type { Rendered } from "./lifecycle-email.ts";

export interface RetentionOffer {
  id: string; user_id: string; reference: string; stage: "pre" | "post";
  amount_cents: number; base_amount_cents: number; cycles: number;
  period: "monthly" | "annual"; access_until: string; expires_at: string;
}
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export function renderRetentionOffer(offer: RetentionOffer, opts: { locale?: string; unsubscribeUrl?: string }): Rendered {
  const fr = String(opts.locale || "").toLowerCase().startsWith("fr");
  const locale = fr ? "fr-FR" : "en-US";
  const amount = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(offer.amount_cents / 100);
  const base = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(offer.base_amount_cents / 100);
  const date = (value: string) => new Date(value).toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric" });
  const subject = fr ? "Une offre personnelle pour continuer avec Norva" : "A personal offer to continue with Norva";
  const terms = offer.period === "monthly"
    ? (fr ? `${amount}/mois pendant ${offer.cycles} mois, puis ${base}/mois.` : `${amount}/month for ${offer.cycles} months, then ${base}/month.`)
    : (fr ? `${amount} pour la prochaine année, puis ${base}/an.` : `${amount} for the next year, then ${base}/year.`);
  const timing = offer.stage === "pre"
    ? (fr ? `Votre accès reste disponible jusqu'au ${date(offer.access_until)}. Si vous acceptez, le premier paiement réduit aura lieu à cette échéance.`
      : `Your access remains available until ${date(offer.access_until)}. If you accept, your first discounted payment will be on that date.`)
    : (fr ? "Votre abonnement a expiré. Si vous choisissez de revenir, le paiement sera demandé lors du réabonnement."
      : "Your subscription has expired. If you choose to return, payment will be requested at checkout.");
  const conditions = fr
    ? `Offre valable jusqu'au ${date(offer.expires_at)}. Renouvellement automatique aux tarifs indiqués, résiliable à tout moment. Votre abonnement reste résilié tant que vous n'acceptez pas.`
    : `Offer available until ${date(offer.expires_at)}. Automatically renews at the stated prices; cancel anytime. Your subscription stays cancelled unless you accept.`;
  const label = fr ? "Voir mon offre" : "View my offer";
  const url = "https://norva.tv/subscription?retentionOffer=" + encodeURIComponent(offer.id);
  const unsubscribe = fr ? "Se désinscrire des e-mails commerciaux" : "Unsubscribe from marketing emails";
  const address = (Deno.env.get("NORVA_POSTAL_ADDRESS") || "").trim();
  return {
    subject,
    tags: [{ name: "app", value: "norva" }, { name: "category", value: "marketing" }, { name: "flow", value: "retention_offer" }],
    text: `${subject}\n\n${terms}\n\n${timing}\n\n${conditions}\n\n${label}: ${url}\n\n${unsubscribe}: ${opts.unsubscribeUrl || ""}\n${address}\nsupport@norva.tv`,
    html: renderEmailFrame({ lang: fr ? "fr" : "en", title: subject, heading: subject, preheader: terms, artwork: "billing",
      bodyHtml: `<p>${escape(terms)}</p><p>${escape(timing)}</p><p>${escape(conditions)}</p>`,
      cta: { label, url }, noteHtml: "support@norva.tv",
      footerHtml: `<a href="${escape(opts.unsubscribeUrl || "")}">${unsubscribe}</a><br>${escape(address)}` }),
  };
}
