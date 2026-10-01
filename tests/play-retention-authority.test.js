const test=require('node:test');
const assert=require('node:assert/strict');
const mod=import('../supabase/functions/_shared/play-retention-authority.mjs');
function fixture(){
 const event={environment:'SANDBOX',product_id:'norva_plus:monthly',transaction_id:'GPA.test',purchased_at_ms:1790876859373};
 const claim={product_id:event.product_id,offer_id:'retention-monthly-20',claim_id:'claim',claimed_at:'2026-10-01T17:47:19Z',expires_at:'2026-10-08T00:00:00Z',access_until:'2026-10-01T17:49:57Z'};
 const order={orderId:event.transaction_id,state:'PROCESSED',purchaseToken:'secret',lineItems:[{productId:'norva_plus',subscriptionDetails:{basePlanId:'monthly',offerId:claim.offer_id,servicePeriodStartTime:'2026-10-01T17:47:39Z',servicePeriodEndTime:'2026-10-01T17:50:15Z'}}]};
 const subscription={testPurchase:{},subscriptionState:'SUBSCRIPTION_STATE_ACTIVE',lineItems:[{productId:'norva_plus',offerDetails:{basePlanId:'monthly',offerId:claim.offer_id},autoRenewingPlan:{autoRenewEnabled:true},expiryTime:'2026-10-01T17:50:15Z'}]};
 return {event,claim,order,subscription};
}
test('scheduled offer is confirmed from matching Google authority without retaining secrets',async()=>{
 const {validateScheduledPlayOffer:verify}=await mod;
 const f=fixture(),proof=verify(f.event,f.claim,f.order,f.subscription);
 assert.equal(proof.offerId,'retention-monthly-20');assert.equal(proof.claimId,'claim');
 assert.equal(proof.accessUntil,'2026-10-01T17:50:15.000Z');
 assert.doesNotMatch(JSON.stringify(proof),/secret|purchaseToken/);
 delete f.subscription.testPurchase;f.event.environment='PRODUCTION';
 assert.equal(verify(f.event,f.claim,f.order,f.subscription).environment,'PRODUCTION');
});
test('wrong order, environment, product, offer, date and inactive subscriptions fail closed',async()=>{
 const {validateScheduledPlayOffer:verify}=await mod;
 for(const mutate of [
  f=>f.order.orderId='other',f=>f.order.state='PENDING',f=>f.event.environment='PRODUCTION',
  f=>f.subscription.subscriptionState='SUBSCRIPTION_STATE_CANCELED',
  f=>f.subscription.lineItems[0].autoRenewingPlan.autoRenewEnabled=false,
  f=>f.subscription.lineItems[0].offerDetails.offerId='other',
  f=>f.order.lineItems[0].subscriptionDetails.basePlanId='annual',
  f=>f.order.lineItems[0].subscriptionDetails.servicePeriodEndTime='2026-10-01T17:48:00Z',
  f=>f.event.purchased_at_ms-=600000,
  f=>f.subscription.lineItems.push(f.subscription.lineItems[0]),
  f=>f.subscription.lineItems[0].expiryTime='invalid',
 ]){const f=fixture();mutate(f);assert.equal(verify(f.event,f.claim,f.order,f.subscription),null);}
});
test('unrelated webhook events never contact Google or read claims',async()=>{
 const {scheduledPlayOffer}=await mod;
 for(const event of [{type:'RENEWAL'},{type:'INITIAL_PURCHASE',store:'APP_STORE'},
 {type:'INITIAL_PURCHASE',store:'PLAY_STORE',offer_code:'known'}])
 assert.equal(await scheduledPlayOffer({from(){throw Error('unexpected');}},'user',event,{}),null);
});
test('store lookup is owner-scoped and sanitized; unavailable authority remains retryable',async()=>{
 const {scheduledPlayOffer}=await mod;
 const f=fixture();Object.assign(f.event,{type:'INITIAL_PURCHASE',store:'PLAY_STORE'});
 const filters=[];
 const q={select(){return this;},eq(k,v){filters.push([k,v]);return this;},not(){return this;},
  order(){return this;},limit(){return this;},maybeSingle:async()=>({data:f.claim})};
 const db={from(name){assert.equal(name,'cloud_play_retention_offers');return q;}};
 const config={packageName:'tv.norva.phone',serviceAccountJson:JSON.stringify({type:'service_account',
  client_email:'qa@example.test',private_key:'-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----'})};
 const deps={order:async()=>f.order,token:async()=>'private-token',fetch:async(url,opts)=>{
  assert.equal(url,'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/tv.norva.phone/purchases/subscriptionsv2/tokens/secret');
  assert.equal(opts.redirect,'error');assert.ok(opts.signal);
  return new Response(JSON.stringify(f.subscription));
 }};
 assert.equal((await scheduledPlayOffer(db,'owner',f.event,config,deps)).offerId,f.claim.offer_id);
 assert.ok(filters.some(([k,v])=>k==='user_id'&&v==='owner'));
 await assert.rejects(scheduledPlayOffer(db,'owner',f.event,config,{...deps,fetch:async()=>{
  throw Error('sensitive-url-and-token');
 }}),e=>e.message==='play_retention_store_verification_unavailable');
 q.maybeSingle=async()=>({data:null});
 assert.equal(await scheduledPlayOffer(db,'owner',f.event,{},{}),null);
 q.maybeSingle=async()=>({error:{code:'db'}});
 await assert.rejects(scheduledPlayOffer(db,'owner',f.event,{},{}),/play_retention_claim_unavailable/);
});
