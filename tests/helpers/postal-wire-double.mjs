import assert from 'node:assert/strict';
import {sealMailWire,openMailWire} from '../../supabase/functions/_shared/postal-mail-wire.mjs';
export const key='7'.repeat(64);
export function postalDouble(handler){return async(url,init)=>{
 assert.equal(url,'http://norva-private-mail-gateway:18185/v1/mail');assert.equal(init.redirect,'error');
 assert.equal(new Headers(init.headers).has('authorization'),false);
 const envelope=JSON.parse(init.body),r=await openMailWire(envelope,key,'request');
 const result=await handler(r,init);
 return new Response(JSON.stringify(await sealMailWire(result,key,'response',envelope.id)));
};}
