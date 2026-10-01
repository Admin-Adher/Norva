import { renderEmailFrame } from "./email-frame.ts";
import type { Rendered } from "./lifecycle-email.ts";
export const PLAY_RETENTION_LINK = "https://norva.tv/app.html?mobile=1#settings/account";
const messages: Record<string, string[]> = {
  en: ['Your Norva offer on Google Play','20% off for 3 months, then your regular price.','10% off your next year, then your regular price.',
    'Open Norva on Android to see prices in your currency and confirm with Google Play. Your remaining access is preserved. Automatically renews afterwards; cancel anytime in Google Play. Personal, non-stackable offer, once every twelve months. Your subscription stays cancelled unless you accept.',
    'View in Norva on Android','Available until','Unsubscribe from marketing emails'],
  fr: ['Votre offre Norva sur Google Play','−20 % pendant 3 mois, puis retour au tarif habituel.','−10 % sur la prochaine année, puis retour au tarif habituel.',
    'Ouvrez Norva sur Android pour consulter les prix dans votre devise et confirmer avec Google Play. Votre accès restant est conservé. Renouvellement automatique ensuite ; résiliable à tout moment dans Google Play. Offre personnelle, non cumulable, une utilisation sur douze mois. Votre abonnement reste résilié sans votre acceptation.',
    'Voir dans Norva sur Android','Valable jusqu’au','Se désinscrire des e-mails commerciaux'],
  'pt-BR': ['Sua oferta Norva no Google Play','20% de desconto por 3 meses, depois o preço habitual.','10% de desconto no próximo ano, depois o preço habitual.',
    'Abra o Norva no Android para ver os preços na sua moeda e confirmar com o Google Play. Seu acesso restante é mantido. Renovação automática depois; cancele a qualquer momento no Google Play. Oferta pessoal, não cumulativa, uma vez a cada doze meses. Sua assinatura continua cancelada se você não aceitar.',
    'Ver no Norva para Android','Disponível até','Cancelar e-mails de marketing'],
  es: ['Tu oferta Norva en Google Play','20 % de descuento durante 3 meses, después el precio habitual.','10 % de descuento en el próximo año, después el precio habitual.',
    'Abre Norva en Android para ver los precios en tu moneda y confirmar con Google Play. Se conserva tu acceso restante. Después se renueva automáticamente; cancela en cualquier momento en Google Play. Oferta personal, no acumulable, una vez cada doce meses. Tu suscripción sigue cancelada si no aceptas.',
    'Ver en Norva para Android','Disponible hasta','Darse de baja de los correos comerciales'],
  hi: ['Google Play पर आपका Norva ऑफ़र','3 महीने तक 20% छूट, फिर सामान्य कीमत।','अगले वर्ष पर 10% छूट, फिर सामान्य कीमत।',
    'अपनी मुद्रा में कीमतें देखने और Google Play से पुष्टि करने के लिए Android पर Norva खोलें। आपका बचा हुआ ऐक्सेस सुरक्षित रहेगा। इसके बाद अपने-आप नवीनीकरण होगा; Google Play में कभी भी रद्द करें। निजी ऑफ़र, अन्य ऑफ़र के साथ नहीं, हर बारह महीने में एक बार। स्वीकार न करने पर आपका सब्सक्रिप्शन रद्द ही रहेगा।',
    'Android पर Norva में देखें','इस तारीख तक उपलब्ध','मार्केटिंग ईमेल बंद करें'],
  tr: ['Google Play’deki Norva teklifiniz','3 ay boyunca %20 indirim, ardından normal fiyatınız.','Gelecek yıl için %10 indirim, ardından normal fiyatınız.',
    'Fiyatları kendi para biriminizde görmek ve Google Play ile onaylamak için Android’de Norva’yı açın. Kalan erişiminiz korunur. Sonrasında otomatik yenilenir; Google Play’de istediğiniz zaman iptal edebilirsiniz. Kişisel teklif, başka tekliflerle birleştirilemez, on iki ayda bir kez. Kabul etmezseniz aboneliğiniz iptal edilmiş olarak kalır.',
    'Android’de Norva’da görüntüle','Son geçerlilik tarihi','Pazarlama e-postalarından çık'],
  bn: ['Google Play-তে আপনার Norva অফার','3 মাসের জন্য 20% ছাড়, তারপর স্বাভাবিক মূল্য।','পরের বছরের জন্য 10% ছাড়, তারপর স্বাভাবিক মূল্য।',
    'নিজের মুদ্রায় দাম দেখতে এবং Google Play দিয়ে নিশ্চিত করতে Android-এ Norva খুলুন। আপনার বাকি অ্যাক্সেস বজায় থাকবে। এরপর স্বয়ংক্রিয়ভাবে নবায়ন হবে; Google Play-তে যেকোনো সময় বাতিল করুন। ব্যক্তিগত অফার, অন্য অফারের সঙ্গে নয়, প্রতি বারো মাসে একবার। গ্রহণ না করলে আপনার সাবস্ক্রিপশন বাতিলই থাকবে।',
    'Android-এ Norva-তে দেখুন','এই তারিখ পর্যন্ত উপলব্ধ','মার্কেটিং ইমেইল বন্ধ করুন'],
  ar: ['عرض Norva الخاص بك على Google Play','خصم 20% لمدة 3 أشهر، ثم السعر المعتاد.','خصم 10% على السنة المقبلة، ثم السعر المعتاد.',
    'افتح Norva على Android للاطلاع على الأسعار بعملتك والتأكيد عبر Google Play. يُحفظ وصولك المتبقي. يتجدد تلقائيًا بعد ذلك؛ يمكنك الإلغاء في أي وقت عبر Google Play. عرض شخصي، لا يُجمع مع عروض أخرى، مرة كل اثني عشر شهرًا. يظل اشتراكك ملغيًا إذا لم تقبل العرض.',
    'العرض في Norva على Android','متاح حتى','إلغاء الاشتراك في رسائل التسويق'],
  id: ['Penawaran Norva Anda di Google Play','Diskon 20% selama 3 bulan, lalu harga biasa.','Diskon 10% untuk tahun berikutnya, lalu harga biasa.',
    'Buka Norva di Android untuk melihat harga dalam mata uang Anda dan mengonfirmasi dengan Google Play. Sisa akses Anda tetap berlaku. Setelah itu diperpanjang otomatis; batalkan kapan saja di Google Play. Penawaran pribadi, tidak dapat digabungkan, sekali setiap dua belas bulan. Langganan tetap dibatalkan jika Anda tidak menerima.',
    'Lihat di Norva untuk Android','Tersedia hingga','Berhenti menerima email pemasaran'],
  fil: ['Ang iyong alok sa Norva sa Google Play','20% diskuwento sa loob ng 3 buwan, pagkatapos ay ang regular na presyo.','10% diskuwento sa susunod na taon, pagkatapos ay ang regular na presyo.',
    'Buksan ang Norva sa Android para makita ang mga presyo sa iyong currency at kumpirmahin sa Google Play. Mananatili ang natitira mong access. Awtomatikong mare-renew pagkatapos; kanselahin anumang oras sa Google Play. Personal na alok, hindi maaaring isabay sa iba, isang beses bawat labindalawang buwan. Mananatiling kanselado ang subscription mo kung hindi mo tatanggapin.',
    'Tingnan sa Norva sa Android','Available hanggang','Mag-unsubscribe sa mga email sa marketing'],
};
function language(locale = 'en') {
  const code = locale.toLowerCase().replace('_','-').split('-')[0];
  return code === 'pt' ? 'pt-BR' : (messages[code] ? code : 'en');
}
export function playRetentionCopy(period: string, locale = "en") {
  const row = messages[language(locale)];
  return {
    title: row[0], terms: row[period === 'monthly' ? 1 : 2], conditions: row[3], cta: row[4],
    until: row[5], unsubscribe: row[6],
  };
}
const escape = (v: string) => v.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
export function renderPlayRetention(offer: { period: string; expiresAt: string }, opts: { locale?: string; unsubscribeUrl?: string }): Rendered {
  const lang = language(opts.locale);
  const copy = playRetentionCopy(offer.period, opts.locale);
  const until = copy.until + ' ' + new Date(offer.expiresAt).toLocaleDateString(lang, { timeZone: 'UTC' });
  const unsubscribe = copy.unsubscribe;
  const address = (Deno.env.get("NORVA_POSTAL_ADDRESS") || "").trim();
  return {
    subject: copy.title,
    tags: [{name:"app",value:"norva"},{name:"category",value:"marketing"},{name:"flow",value:"play_retention_offer"}],
    text: `${copy.title}\n\n${copy.terms}\n\n${copy.conditions}\n${until}\n\n${copy.cta}: ${PLAY_RETENTION_LINK}\n\n${unsubscribe}: ${opts.unsubscribeUrl || ""}\n${address}\nsupport@norva.tv`,
    html: renderEmailFrame({lang,title:copy.title,heading:copy.title,preheader:copy.terms,artwork:"billing",
      bodyHtml:`<p>${escape(copy.terms)}</p><p>${escape(copy.conditions)}</p><p>${escape(until)}</p>`,
      cta:{label:copy.cta,url:PLAY_RETENTION_LINK},noteHtml:"support@norva.tv",
      footerHtml:`<a href="${escape(opts.unsubscribeUrl || "")}">${unsubscribe}</a><br>${escape(address)}`}),
  };
}
