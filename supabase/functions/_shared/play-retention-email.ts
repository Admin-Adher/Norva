import { renderEmailFrame } from "./email-frame.ts";
import type { Rendered } from "./lifecycle-email.ts";
export const PLAY_RETENTION_LINK = "https://norva.tv/app.html?mobile=1#settings/account";
export function playRetentionCopy(period: string, locale = "en") {
  const fr = locale.toLowerCase().startsWith("fr");
  return {
    title: fr ? "Votre offre Norva sur Google Play" : "Your Norva offer on Google Play",
    terms: period === "monthly"
      ? (fr ? "−20 % pendant 3 mois, puis retour au tarif habituel." : "20% off for 3 months, then your regular price.")
      : (fr ? "−10 % sur la prochaine année, puis retour au tarif habituel." : "10% off your next year, then your regular price."),
    conditions: fr
      ? "Ouvrez Norva sur Android pour consulter les prix dans votre devise et confirmer avec Google Play. Votre accès restant est conservé. Renouvellement automatique ensuite ; résiliable à tout moment dans Google Play. Offre personnelle, non cumulable, une utilisation sur douze mois. Votre abonnement reste résilié sans votre acceptation."
      : "Open Norva on Android to see prices in your currency and confirm with Google Play. Your remaining access is preserved. Automatically renews afterwards; cancel anytime in Google Play. Personal, non-stackable offer, once every twelve months. Your subscription stays cancelled unless you accept.",
    cta: fr ? "Voir dans Norva sur Android" : "View in Norva on Android",
  };
}
const escape = (v: string) => v.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
export function renderPlayRetention(offer: { period: string; expiresAt: string }, opts: { locale?: string; unsubscribeUrl?: string }): Rendered {
  const fr = String(opts.locale || "en").startsWith("fr");
  const copy = playRetentionCopy(offer.period, opts.locale);
  const until = (fr ? "Valable jusqu’au " : "Available until ") + new Date(offer.expiresAt).toLocaleDateString(fr ? "fr-FR" : "en-US");
  const unsubscribe = fr ? "Se désinscrire des e-mails commerciaux" : "Unsubscribe from marketing emails";
  const address = (Deno.env.get("NORVA_POSTAL_ADDRESS") || "").trim();
  return {
    subject: copy.title,
    tags: [{name:"app",value:"norva"},{name:"category",value:"marketing"},{name:"flow",value:"play_retention_offer"}],
    text: `${copy.title}\n\n${copy.terms}\n\n${copy.conditions}\n${until}\n\n${copy.cta}: ${PLAY_RETENTION_LINK}\n\n${unsubscribe}: ${opts.unsubscribeUrl || ""}\n${address}\nsupport@norva.tv`,
    html: renderEmailFrame({lang:fr?"fr":"en",title:copy.title,heading:copy.title,preheader:copy.terms,artwork:"billing",
      bodyHtml:`<p>${escape(copy.terms)}</p><p>${escape(copy.conditions)}</p><p>${escape(until)}</p>`,
      cta:{label:copy.cta,url:PLAY_RETENTION_LINK},noteHtml:"support@norva.tv",
      footerHtml:`<a href="${escape(opts.unsubscribeUrl || "")}">${unsubscribe}</a><br>${escape(address)}`}),
  };
}
