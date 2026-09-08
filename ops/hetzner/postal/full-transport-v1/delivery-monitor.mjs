import fs from 'node:fs';
import pg from 'pg';

// Separate process and Telegram transport: a stopped Postal worker still alerts.
const config=JSON.parse(fs.readFileSync('/private/config.json','utf8'));
const pool=new pg.Pool({...config.database,max:1,connectionTimeoutMillis:3000,statement_timeout:5000});
pool.on('error',()=>{});
let running=false;
async function tick(){
 if(running)return;running=true;
 try{
  let health,issue;
  try{
   const r=await pool.query('select norva_postal_full.delivery_health() as health');health=r.rows[0].health;
   const response=await fetch('http://172.18.0.1:18185/health',{signal:AbortSignal.timeout(5000)});
   const worker=await response.json();
   if(!response.ok||!worker.enabled||!worker.guestVerified||Date.now()-worker.lastTick>180000)issue='worker_unhealthy';
  }catch{issue='mail_monitor_dependency_unavailable';}
  const counters=health??{};
  if(!issue&&Object.values(counters).some(n=>typeof n==='number'&&n>0))issue='mail_delivery_needs_review';
  const file='/data/state.json';let previous={};try{previous=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
  const signature=JSON.stringify({issue:issue??null,counters});
  if((issue&&(signature!==previous.signature||Date.now()-(previous.at??0)>21600000))||(!issue&&previous.issue)){
   const text=(issue?'Norva — incident de livraison email':'Norva — livraison email rétablie')+'\n'+
    (issue??'healthy')+'\n'+Object.entries(counters).map(([k,v])=>k+': '+v).join('\n');
   const r=await fetch('https://api.telegram.org/bot'+config.telegramToken+'/sendMessage',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:config.telegramChat,text,protect_content:true}),signal:AbortSignal.timeout(12000)});
   const body=await r.json();if(!r.ok||body.ok!==true)throw Error('telegram_not_accepted');
   const next={signature,issue:issue??null,at:Date.now(),messageId:body.result.message_id};
   fs.writeFileSync(file+'.next',JSON.stringify(next),{mode:0o600});fs.renameSync(file+'.next',file);
   console.log(JSON.stringify({event:issue?'incident_reported':'recovery_reported',counters}));
  }
 }catch{console.error('MAIL_MONITOR_NEEDS_REVIEW');}finally{running=false;}
}
await tick();setInterval(tick,60000);
