import { renderEmailFrame, escapeEmail } from "./email-frame.ts";
import type { Rendered } from "./lifecycle-email.ts";

// This receipt never contains an offer and is independent of marketing consent.
const copy: Record<string, [string, string, string, string]> = {
  en: ["Your Norva cancellation is confirmed", "Your plan will not renew. No further subscription payment is scheduled.", "You can keep watching until {{date}}.", "Manage my subscription"],
  fr: ["Votre résiliation Norva est confirmée", "Votre forfait ne sera pas renouvelé. Aucun nouveau paiement d’abonnement n’est prévu.", "Vous pouvez continuer à regarder jusqu’au {{date}}.", "Gérer mon abonnement"],
  "pt-BR": ["Seu cancelamento da Norva está confirmado", "Seu plano não será renovado. Nenhum novo pagamento de assinatura está agendado.", "Você pode continuar assistindo até {{date}}.", "Gerenciar minha assinatura"],
  es: ["Tu cancelación de Norva está confirmada", "Tu plan no se renovará. No hay ningún nuevo pago de suscripción programado.", "Puedes seguir viendo contenido hasta el {{date}}.", "Gestionar mi suscripción"],
  hi: ["आपका Norva रद्दीकरण पुष्ट हो गया है", "आपका प्लान नवीनीकृत नहीं होगा। सदस्यता का कोई नया भुगतान निर्धारित नहीं है।", "आप {{date}} तक देखना जारी रख सकते हैं।", "मेरी सदस्यता प्रबंधित करें"],
  tr: ["Norva iptaliniz onaylandı", "Planınız yenilenmeyecek. Yeni bir abonelik ödemesi planlanmıyor.", "{{date}} tarihine kadar izlemeye devam edebilirsiniz.", "Aboneliğimi yönet"],
  bn: ["আপনার Norva বাতিলকরণ নিশ্চিত হয়েছে", "আপনার প্ল্যান নবায়ন হবে না। নতুন কোনো সাবস্ক্রিপশন পেমেন্ট নির্ধারিত নেই।", "আপনি {{date}} পর্যন্ত দেখা চালিয়ে যেতে পারবেন।", "আমার সাবস্ক্রিপশন পরিচালনা করুন"],
  ar: ["تم تأكيد إلغاء اشتراكك في Norva", "لن يتم تجديد خطتك. لا توجد دفعة اشتراك جديدة مجدولة.", "يمكنك مواصلة المشاهدة حتى {{date}}.", "إدارة اشتراكي"],
  id: ["Pembatalan Norva Anda telah dikonfirmasi", "Paket Anda tidak akan diperpanjang. Tidak ada pembayaran langganan baru yang dijadwalkan.", "Anda dapat terus menonton hingga {{date}}.", "Kelola langganan saya"],
  fil: ["Kumpirmado na ang pagkansela ng iyong Norva", "Hindi mare-renew ang iyong plan. Walang nakaiskedyul na bagong bayad sa subscription.", "Maaari kang patuloy na manood hanggang {{date}}.", "Pamahalaan ang aking subscription"],
};
export function renderCancellationReceipt(opts: { effectiveAt?: string; locale?: string; provider?: 'revolut' | 'google_play' | 'store' }): Rendered {
  const requested = String(opts.locale || "en").replace(/_/g, "-").toLowerCase();
  const lang = Object.keys(copy).find(k => requested === k.toLowerCase())
    || (requested.startsWith("pt") ? "pt-BR" : requested.split("-")[0]);
  const locale = copy[lang] ? lang : "en";
  const [subject, confirmation, access, label] = copy[locale];
  const end = Date.parse(opts.effectiveAt || "");
  const date = Number.isFinite(end) ? new Intl.DateTimeFormat(locale, {
    year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  }).format(end) : "";
  const remaining = date ? access.replace("{{date}}", date) : "";
  const url = opts.provider === 'google_play'
    ? 'https://play.google.com/store/account/subscriptions?package=tv.norva.phone'
    : opts.provider === 'store' ? 'https://norva.tv/app#settings/account' : 'https://norva.tv/subscription';
  return {
    subject,
    tags: [{ name: "app", value: "norva" }, { name: "category", value: "transactional" }, { name: "flow", value: "cancellation_confirmed" }],
    text: `${subject}\n\n${confirmation}\n${remaining}\n\n${label}: ${url}\n\nsupport@norva.tv`,
    html: renderEmailFrame({ lang: locale, title: subject, heading: subject,
      preheader: remaining || confirmation, artwork: false,
      bodyHtml: `<p>${escapeEmail(confirmation)}</p>${remaining ? `<p>${escapeEmail(remaining)}</p>` : ""}`,
      cta: { label, url }, noteHtml: "support@norva.tv" }),
  };
}
