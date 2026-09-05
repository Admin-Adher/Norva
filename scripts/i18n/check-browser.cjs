async (page) => {
 const proof = await page.evaluate(async () => {
  const api = window.NorvaI18n; const pause = () => new Promise(resolve=>setTimeout(resolve,20));
  const languages=[]; const provider=document.getElementById('provider-title').textContent;
  for(const locale of api.locales){if(!api.setPreference(locale.code))throw Error('Cannot save '+locale.code); await pause();
   if(document.documentElement.dir!==(locale.code==='ar'?'rtl':'ltr'))throw Error('Wrong direction');
   if(document.getElementById('provider-title').textContent!==provider)throw Error('Provider text changed');
   languages.push({code:locale.code,label:document.querySelector('h1').textContent,dir:document.documentElement.dir});}
  api.setPreference('fr');
  const plain=document.createElement('span');plain.dataset.i18n='ui_web_66d27b78bb70';plain.dataset.i18nArgs=JSON.stringify({p3:'<img src=x onerror="window.injected=true">'});document.body.append(plain);await pause();
  if(plain.querySelector('img')||window.injected||!plain.textContent.includes('<img'))throw Error('Unsafe interpolation');
  const state=document.createElement('button');state.dataset.i18n='ui_back';state.textContent='Back';document.body.append(state);await pause();state.textContent='Loading state';await pause();
  if(state.textContent!=='Loading state'||state.hasAttribute('data-i18n'))throw Error('Stale label overrode state');
  const rich=document.createElement('div');rich.dataset.i18n='ui_web_2526c15d39d0';rich.setAttribute('data-i18n-rich','');rich.dataset.i18nArgs=JSON.stringify({p12:'10 €',p13:'1.2',p14:'',p15:'8 €',p16:'<button>unsafe string</button>'});
  const slot=document.createElement('norva-slot');slot.dataset.i18nSlot='p16';const action=document.createElement('button');action.textContent='Existing action';let clicks=0;action.onclick=()=>clicks++;slot.append(action);rich.append(slot);document.body.append(rich);await pause();
  action.click();api.setPreference('ar');await pause();action.click();
  if(clicks!==2||!rich.contains(action)||rich.textContent.includes('<button>'))throw Error('Rich action identity lost');
  plain.remove();state.remove();rich.remove();
  return {languages,escapedParameters:true,stateTransitions:true,richActionPreserved:true,resource:performance.getEntriesByType('resource').find(e=>e.name.includes('/js/i18n.js'))?.duration};
 });
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:'output/i18n/browser-settings-ar.png',fullPage:true});
 return proof;
}
