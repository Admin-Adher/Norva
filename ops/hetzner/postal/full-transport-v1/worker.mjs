export async function workOne({store,runner,authorize,enabled}){
 if(!enabled)return 'disabled';
 const job=store.next();if(!job)return 'idle';
 const {message,deliveryKey}=store.payload(job),tag='norva-mail-'+job.id.slice(7);
 // Sending recovery is receipt-only, including after a message expires.
 if(job.state==='sending'){
  const previous=await runner({mode:'receipt',tag});
  if(previous.state==='Sent'&&previous.secure===true)store.mark(job.id,'sent',{secure:1,sent_at:store.now()});
  else if(previous.state==='retry'&&previous.provedNoAcceptance)store.mark(job.id,'held',{next_at:store.now()+60000,error:'smtp_temporary'});
  else store.mark(job.id,'uncertain',{error:'smtp_unknown_no_replay'});
  return 'reconciled';
 }
 if(store.now()>=job.expires){store.mark(job.id,'canceled',{error:'expired'});return 'expired';}
 const permission=await authorize({deliveryKey,message,jobId:job.id});
 if(permission==='cancel'||store.suppressed(message.to)){store.mark(job.id,'canceled',{error:'authorization_revoked'});return 'canceled';}
 if(permission!=='allow'){store.mark(job.id,job.state,{next_at:store.now()+60000,error:'authorization_deferred'});return 'deferred';}
 let postalId=job.postal_id;
 if(job.state==='pending'||job.state==='api_started'){
  const recovery=job.state==='api_started';
  if(!recovery)store.mark(job.id,'api_started');
  const response=await runner({mode:recovery?'find':'hold',tag,message});
  if(!response.held||!Number.isSafeInteger(response.messageId)){
   store.mark(job.id,'uncertain',{error:'api_unknown_no_replay'});return 'api_uncertain';}
  postalId=response.messageId;store.mark(job.id,'held',{postal_id:postalId});
 }
 // Revalidate after the API/MIME preparation boundary too.
 const finalPermission=await authorize({deliveryKey,message,jobId:job.id});
 if(finalPermission==='cancel'||store.suppressed(message.to)){
  store.mark(job.id,'canceled',{error:'authorization_revoked'});return 'canceled';}
 if(finalPermission!=='allow'){
  store.mark(job.id,'held',{next_at:store.now()+60000,error:'authorization_deferred'});return 'deferred';}
 const attempt=job.attempts+1;
 if(attempt>12){store.mark(job.id,'failed',{error:'retry_limit'});return 'failed';}
 store.mark(job.id,'sending',{attempts:attempt});
 const result=await runner({mode:'dispatch',tag,messageId:postalId,recipient:message.to,
  expiresUnix:Math.floor(Math.min(store.now()+90000,job.expires)/1000),attempt});
 if(result.state==='Sent'&&result.secure===true){store.mark(job.id,'sent',{secure:1,sent_at:store.now()});return 'sent';}
 if(result.state==='retry'&&result.provedNoAcceptance===true){
  store.mark(job.id,'held',{next_at:store.now()+Math.min(3600000,60000*2**Math.min(6,attempt-1)),error:'smtp_temporary'});return 'retry';}
 if(result.state==='HardFail'){
  store.mark(job.id,'failed',{error:'smtp_permanent'});
  if(result.recipientInvalid===true)store.suppress(job.recipient_hash,'permanent_recipient');return 'failed';}
 store.mark(job.id,'uncertain',{error:'smtp_unknown_no_replay'});return 'uncertain';
}
