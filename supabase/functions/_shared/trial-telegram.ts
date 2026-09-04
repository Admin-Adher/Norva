import { maskedEmail, sendTelegramDetailed, telegramConfigured, tgEscape } from './telegram.ts';

// Runs under the existing minute signup worker; no client-side event can send a
// trial notification. PostgreSQL created this row with the entitlement commit.
export async function drainTrialTelegram(admin: any): Promise<Record<string, unknown>> {
  if (!telegramConfigured('growth')) return {configured:false, sent:0};
  const {data, error} = await admin.rpc('claim_trial_telegram_deliveries');
  if (error) throw new Error('trial_telegram_claim_failed');
  let sent=0, failed=0, unacknowledged=0;
  const claims = data ?? [];
  for (let index=0; index<claims.length; index++) {
    const claim = claims[index];
    const {data: identity} = await admin.auth.admin.getUserById(claim.user_id);
    const provider = ({revolut:'Web · Revolut',google_play:'Google Play',apple_app_store:'App Store',
      system:'Essai Norva automatique',web:'Web',revenuecat:'Store · RevenueCat'} as Record<string,string>)[claim.provider] ?? 'Canal non déterminé';
    const formatDate = (value:string) => new Intl.DateTimeFormat('fr-FR', {timeZone:'Europe/Paris',dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
    const delivery = await sendTelegramDetailed([
      '🚀 <b>Nouvel essai Norva démarré</b>',
      ...(identity?.user?.email ? [`<tg-spoiler>${tgEscape(maskedEmail(identity.user.email))}</tg-spoiler>`] : []),
      `Forfait : <b>${tgEscape(claim.plan_code)}</b>`,
      `Canal : ${tgEscape(provider)}`,
      `Début : ${tgEscape(formatDate(claim.started_at))} (Paris)`,
      `Fin : ${tgEscape(formatDate(claim.ends_at))} (Paris)`,
      '<i>Essai activé — aucun paiement encaissé à ce stade.</i>',
    ].join('\n'), {category:'growth',protectContent:true,inlineKeyboard:[[{text:'Ouvrir la fiche client',url:`https://norva.tv/app#admin/client:${encodeURIComponent(claim.user_id)}`}]]});
    const {data: acknowledged, error: ackError} = await admin.rpc('finish_trial_telegram_delivery', {
      p_id:claim.id,p_lease:claim.lease_token,p_message_id:delivery.accepted ? delivery.messageId : null,
      p_retryable:delivery.status === null || [408,425,429].includes(delivery.status) || delivery.status >= 500,
      p_retry_after:delivery.retryAfterSeconds ?? 60,p_error:delivery.error,
    });
    if (ackError || acknowledged !== true) unacknowledged++;
    else if (delivery.accepted) sent++;
    else failed++;
    if (delivery.status === 429) {
      // Respect the provider's Retry-After for every claimed row, not only the
      // first rejected message. This avoids a fresh burst after lease expiry.
      for (const deferred of claims.slice(index+1)) await admin.rpc('finish_trial_telegram_delivery', {
        p_id:deferred.id,p_lease:deferred.lease_token,p_message_id:null,p_retryable:true,
        p_retry_after:delivery.retryAfterSeconds ?? 60,p_error:'telegram_rate_limited_deferred',
      });
      break;
    }
  }
  return {configured:true,claimed:data?.length ?? 0,sent,failed,unacknowledged};
}
