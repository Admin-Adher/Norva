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
