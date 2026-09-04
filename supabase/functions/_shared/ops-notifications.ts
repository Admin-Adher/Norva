import { groupOpsNotifications, TELEGRAM_CATEGORIES } from './telegram-routing.mjs';
import { sendTelegram, telegramConfigured, tgEscape, type TelegramCategory } from './telegram.ts';

const COOLDOWN = 6 * 60 * 60 * 1000;
type Incident = {key:string;detail:string};
type DeliveryState = {category:TelegramCategory;channel:'telegram'|'email';key:string;details:string;last_alerted_at:string};

export async function dispatchOpsNotifications(admin:any, problems:Incident[], opsEmail:string):Promise<Record<string,unknown>> {
  const {data, error} = await admin.from('admin_alert_delivery_state').select('*');
  if(error) throw new Error('ops_notification_state_unavailable');
  const states = (data ?? []) as DeliveryState[];
  const active = new Set(problems.map(p=>p.key));
  const lidActive = problems.some(p=>p.key.startsWith('lid_cascade_'));
  const resendKey = Deno.env.get('RESEND_API_KEY') ?? '';
  const from = Deno.env.get("AUTH_EMAIL_FROM") ?? "Norva <support@norva.tv>";
  const results:{category:string;channel:string;recovery:boolean;accepted:boolean;keys:string[]}[]=[];
  async function deliver(category:TelegramCategory,channel:'telegram'|'email',items:Incident[],recovery:boolean) {
    if(!items.length) return;
    let accepted=false;
    const heading=`${recovery ? '✅' : '⚠️'} Norva ${category} — ${recovery ? 'résolu' : `${items.length} alerte(s)`}`;
    if(channel==='telegram') {
      accepted=await sendTelegram(`<b>${heading}</b>\n`+items.map(p=>`• ${tgEscape(p.detail)}`).join('\n'),category);
    } else {
      try {
        const bucket=Math.floor(Date.now()/COOLDOWN);
        const signature=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(items.map(p=>p.key).sort().join('|'))))).map(b=>b.toString(16).padStart(2,'0')).join('');
        const response=await fetch('https://api.resend.com/emails',{
          method:'POST',headers:{Authorization:`Bearer ${resendKey}`,'Content-Type':'application/json',
            'Idempotency-Key':`norva-ops-${category}-${recovery?'recovery':'alert'}-${bucket}-${signature}`},
          body:JSON.stringify({from,to:[opsEmail],reply_to:opsEmail,subject:heading,
            text:heading+'\n\n'+items.map(p=>`- ${p.detail}`).join('\n')+'\n\nhttps://norva.tv/app#admin',
            tags:[{name:'app',value:'norva'},{name:'flow',value:recovery?'ops_health_recovery':'ops_health_alert'}]}),
          signal:AbortSignal.timeout(8000),
        });
        const body=await response.json().catch(()=>({}));accepted=response.ok && typeof body.id==='string' && !!body.id;
      }catch{/* Keep this channel's pending state. */}
    }
    if(accepted) {
      const query=recovery
        ? admin.from('admin_alert_delivery_state').delete().eq('category',category).eq('channel',channel).in('key',items.map(p=>p.key))
        : admin.from('admin_alert_delivery_state').upsert(items.map(p=>({category,channel,key:p.key,details:p.detail,last_alerted_at:new Date().toISOString()})),{onConflict:'category,channel,key'});
      const {error:writeError}=await query;
      if(writeError) throw new Error('ops_notification_ack_failed');
    }
    results.push({category,channel,recovery,accepted,keys:items.map(p=>p.key)});
  }
  for(const group of groupOpsNotifications(problems)) {
    const category=group.category as TelegramCategory;
    for(const channel of ['telegram','email'] as const) {
      if(channel==='telegram' ? !telegramConfigured(category) : !(resendKey && opsEmail)) continue;
      const due=group.items.filter((p:Incident)=>!states.some(s=>s.category===category && s.channel===channel && s.key===p.key && new Date(s.last_alerted_at).getTime()>Date.now()-COOLDOWN));
      await deliver(category,channel,due,false);
    }
  }
  for(const channel of ['telegram','email'] as const) {
    const healed=states.filter(s=>s.channel===channel && !active.has(s.key)
      && !(lidActive && s.key.startsWith('lid_cascade_'))
      && !(['sources_error','sources_incomplete'].includes(s.key) && new Date(s.last_alerted_at).getTime()>Date.now()-COOLDOWN));
    for(const group of groupOpsNotifications(healed,(s:DeliveryState)=>s.category)) {
      const category=group.category as TelegramCategory;
      if(channel==='telegram' ? !telegramConfigured(category) : !(resendKey && opsEmail)) continue;
      await deliver(category,channel,group.items.map((s:DeliveryState)=>({key:s.key,detail:s.details})),true);
    }
  }
  return {deliveries:results, telegram_routes:Object.fromEntries(TELEGRAM_CATEGORIES.map(c=>[c,telegramConfigured(c as TelegramCategory)])),
    email_configured:!!opsEmail, recovery_pending:results.some(r=>r.recovery&&!r.accepted)};
}
