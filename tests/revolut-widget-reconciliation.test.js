const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../public/checkout-revolut.html'),'utf8');
function harness(confirm){
 const elements=new Map();
 function element(){return {style:{},classList:{add(){},remove(){}},firstElementChild:{},children:[],appendChild(x){this.children.push(x)},addEventListener(k,v){this[k]=v},remove(){},focus(){},querySelector(k){return this[k]??=(element())}};}
 const context={console, setTimeout:fn=>{fn();}, sessionStorage:{removeItem(){}},document:{createElement:element,getElementById:id=>elements.get(id)||elements.set(id,element()).get(id)},
 window:{NorvaBilling:{confirmRevolut:confirm}},loading:element(),statusEl:element(),payBtn:{},currentOrderId:'owned-order',submitting:false,cardField:{},cardValid:true,commercialQuote:{},checkoutKind:'trial_setup',plan:'plus',period:'monthly',applyServerTrialSchedule(){},applyKindCopy(){},trialChargeDate(){return 'date'},trackCheckout(){},setStatus(message){context.message=message}};
 vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('      const DONE_STATUSES'),source.indexOf('      // ── Open the order')),context);
 vm.runInContext(source.slice(source.indexOf('      function syncPayAvailability'),source.indexOf('      function trackBeginCheckoutOnce')),context);
 vm.runInContext('callbacks = {'+source.slice(source.indexOf('            onSuccess: function'),source.indexOf('\n          });',source.indexOf('            onSuccess: function')))+'};',context);
 return {context,elements,run:code=>vm.runInContext(code,context),flush:async()=>{for(let i=0;i<30;i++)await Promise.resolve()}};
}
test('widget error after released hold reconciles exact order and renders one success',async()=>{
 let calls=0;const h=harness(async id=>{assert.equal(id,'owned-order');calls++;return{status:'trialing',kind:'trial_setup'}});
 h.context.callbacks.onError();await h.flush();assert.equal(calls,1);assert.equal(h.run('checkoutCompleted'),true);assert.equal(h.elements.get('checkout-view').style.display,'none');assert.equal(h.context.payBtn.disabled,true);
 h.context.callbacks.onError();h.context.callbacks.onCancel();h.context.callbacks.onValidation([{message:'late'}]);await h.flush();assert.equal(calls,1);assert.equal(h.context.message,undefined);
});
test('success and error racing share one confirmation',async()=>{
 let resolve,calls=0;const h=harness(()=>{calls++;return new Promise(r=>resolve=r)});
 h.context.callbacks.onError();h.context.callbacks.onSuccess();assert.equal(calls,1);resolve({status:'trialing'});await h.flush();assert.equal(h.run('checkoutCompleted'),true);
});
test('pending or failed confirmation cannot grant success or permit duplicate submission',async()=>{
 let calls=0;const h=harness(async()=>{calls++;return{status:'CANCELLED',pending:true}});
 h.context.callbacks.onError();await h.flush();assert.equal(calls,6);assert.equal(h.run('checkoutCompleted'),false);assert.equal(h.context.payBtn.disabled,true);assert.match(h.context.message,/retry verification/i);assert.equal(h.context.statusEl.children.length,2);
});
test('submitted cancel reconciles instead of falsely claiming no charge',async()=>{
 const h=harness(async()=>({status:'trialing'}));h.context.submitting=true;h.context.callbacks.onCancel();await h.flush();assert.equal(h.run('checkoutCompleted'),true);
});
test('validation callbacks cannot unlock an in-flight card submission',()=>{
 const h=harness(async()=>({status:'trialing'}));h.context.submitting=true;h.run('syncPayAvailability()');h.context.callbacks.onValidation([{message:'late'}]);assert.equal(h.context.submitting,true);assert.equal(h.context.payBtn.disabled,true);
});

const localeCatalog = require('../scripts/i18n/catalog.cjs').load();
for (const { code } of require('../i18n/locales.json')) {
 test(`checkout confirmation and server date follow ${code}`, () => {
  const h = harness(async () => ({ status: 'trialing' }));
  h.context.NorvaI18n = { language: code, t(key, args = {}) {
   assert.ok(localeCatalog[key]?.[code], `missing ${key}/${code}`);
   return localeCatalog[key][code].replace(/\{\{(\w+)\}\}/g, (_, name) => String(args[name] ?? ''));
  }};
  h.context.serverFirstChargeAt = '2026-10-08T12:00:00Z';
  h.run(source.slice(source.indexOf('      function trialChargeDate()'), source.indexOf('      function stopCheckoutCountdown()')));
  const date = new Date(h.context.serverFirstChargeAt).toLocaleDateString(code, {year:'numeric',month:'long',day:'numeric'});
  assert.equal(h.run('trialChargeDate()'), date);
  for (const kind of ['trial_setup','plan_change','resubscribe','card_update']) {
   const copy = h.run(`successCopy('${kind}')`);
   assert.equal(copy.length,2);assert.ok(copy.every(s=>s && !s.includes('{{')));
   if(kind==='trial_setup')assert.ok(copy[1].includes(date));
   if(code!=='en')assert.notEqual(copy[0],h.run(`SUCCESS_DEFAULTS[${JSON.stringify({trial_setup:'ui_web_e1b66617c8d2',plan_change:'ui_web_1e16b9e4c26e',resubscribe:'ui_checkout_resubscribe_title',card_update:'ui_checkout_card_success_title'}[kind])}]`));
  }
 });
}
