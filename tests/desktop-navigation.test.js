const test=require('node:test'),assert=require('node:assert/strict');
const {isSameAppOrigin}=require('../desktop/navigation');
test('catalogue entry keeps local account and login return navigation in the application',()=>{
 const app='http://127.0.0.1:3002/app';
 for(const p of ['/account.html?returnTo=%2Fapp','/login.html','/app#home','/app.html#movies']) assert.equal(isSameAppOrigin('http://127.0.0.1:3002'+p,app),true);
});
test('origin matching rejects lookalike hosts, other local ports and executable schemes',()=>{
 for(const p of ['https://norva.tv.evil.example/app','https://norva.tv@evil.example/app','http://norva.tv/app','file:///app','javascript:alert(1)','invalid']) assert.equal(isSameAppOrigin(p,'https://norva.tv/app'),false);
 assert.equal(isSameAppOrigin('http://127.0.0.1:3003/app','http://127.0.0.1:3002/app'),false);
});
