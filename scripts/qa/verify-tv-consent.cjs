'use strict';
// NODE_PATH may point to the local browser runtime. No production server or account needed.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
(async () => {
  const browser = await chromium.launch({headless:true, ...(process.env.NORVA_BROWSER_PATH ? {executablePath:process.env.NORVA_BROWSER_PATH} : {})});
  let checks=0;
  try {
    const page = await browser.newPage({viewport:{width:1920,height:1080}});
    await page.route('https://norva-consent.test/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      const file = pathname==='/' ? 'tests/fixtures/tv-consent.html' : 'public'+pathname;
      return route.fulfill({path:path.join(root,file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
    });
    const focus = () => page.evaluate(()=>document.activeElement.getAttribute('data-consent') || document.activeElement.className || document.activeElement.id);
    for (const detail of [false,true]) {
      await page.goto('https://norva-consent.test/?tv=1'+(detail?'&detail=1':''));
      await page.waitForFunction(()=>document.activeElement?.getAttribute('data-consent')==='denied');
      assert.equal(await page.locator('.norva-consent').getAttribute('role'),'dialog');checks++;
      await page.keyboard.press('ArrowRight');assert.equal(await focus(),'granted');checks++;
      await page.keyboard.press('ArrowLeft');assert.equal(await focus(),'denied');checks++;
      await page.keyboard.press('ArrowUp');assert.equal(await focus(),'norva-consent__link');checks++;
      await page.keyboard.press('ArrowDown');assert.equal(await focus(),'denied');checks++;
      await page.evaluate(()=>document.getElementById('background').focus());assert.equal(await focus(),'denied');checks++;
      await page.evaluate(()=>{const b=document.createElement('button');b.id='late';document.body.append(b);});
      assert.equal(await page.locator('#late').evaluate(e=>e.inert),true);checks++;
      await page.evaluate(()=>{window.backgroundClicks=0;document.getElementById('detail').onclick=()=>backgroundClicks++;document.getElementById('opener').onclick=()=>backgroundClicks++;});
      await page.keyboard.down('Enter');await page.keyboard.down('Enter');await page.keyboard.up('Enter');
      assert.equal(await page.evaluate(()=>backgroundClicks),0);checks++;
      assert.equal(await page.evaluate(()=>NorvaConsent.get()),'denied');checks++;
      assert.equal(await page.evaluate(()=>document.activeElement.id),detail?'detail':'opener');checks++;
      assert.equal(await page.locator('#already-inert').evaluate(e=>e.inert),true);checks++;
      assert.equal(await page.locator('#late').evaluate(e=>e.inert),false);checks++;
      await page.evaluate(()=>NorvaConsent.open());await page.keyboard.press('ArrowRight');await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(()=>NorvaConsent.get()),'granted');checks++;
      assert.deepEqual(await page.evaluate(()=>consentCalls),['denied','granted']);checks++;
      await page.evaluate(()=>NorvaConsent.open());await page.keyboard.press('Escape');
      assert.equal(await page.locator('.norva-consent').count(),0);assert.equal(await page.evaluate(()=>NorvaConsent.get()),'granted');checks++;
      await page.evaluate(()=>{localStorage.removeItem('norva_consent');NorvaConsent.open();});
      assert.equal(await page.evaluate(()=>__norvaTV.handleBack()),'modal');assert.equal(await page.evaluate(()=>NorvaConsent.get()),null);checks++;
      await page.evaluate(()=>NorvaConsent.open());
      await page.evaluate(()=>NorvaI18n.setPreference('ar'));await page.keyboard.press('ArrowLeft');assert.equal(await focus(),'granted');checks++;
      await page.evaluate(()=>NorvaI18n.setPreference('fr'));
      for(const [width,height] of [[1920,1080],[1280,720],[960,540]]) {
        await page.setViewportSize({width,height});
        const geometry=await page.locator('.norva-consent__card').evaluate(e=>{let r=e.getBoundingClientRect();return {x:r.x,right:r.right,bottom:r.bottom,top:r.top,overflow:e.scrollWidth>e.clientWidth+1};});
        assert(geometry.x>=0&&geometry.right<=width&&geometry.top>=0&&geometry.bottom<=height&&!geometry.overflow);checks++;
      }
      await page.setViewportSize({width:1920,height:1080});
      await page.evaluate(()=>document.querySelector('[data-consent="denied"]').focus());
      if(process.env.NORVA_QA_OUTPUT) {
        fs.mkdirSync(process.env.NORVA_QA_OUTPUT,{recursive:true});
        await page.waitForTimeout(350); // Finish the consent entrance animation before capture.
        await page.screenshot({path:path.join(process.env.NORVA_QA_OUTPUT,detail?'fiche.png':'catalogue.png')});
      }
    }
    // Existing decisions are applied without reopening the prompt on initialization.
    await page.evaluate(()=>{NorvaConsent.close();window.NORVA_MARKETING_CONFIG.enabled=true;localStorage.setItem('norva_consent',JSON.stringify({status:'denied',v:1}));});
    await page.addScriptTag({path:path.join(root,'public/js/consent-banner.js')});
    assert.equal(await page.locator('.norva-consent').count(),0);checks++;
    console.log(JSON.stringify({checks,result:'passed'}));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
