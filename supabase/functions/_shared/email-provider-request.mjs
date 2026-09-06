// No operation can contact api.resend.com. The AEAD key protects both message
// bodies and provider acknowledgements on this non-public, fixed endpoint.
import {sealMailWire,openMailWire} from './postal-mail-wire.mjs';
const endpoint='http://norva-private-mail-gateway:18185/v1/mail';
export async function requestEmailProvider(operation,init,{fetchImpl=fetch,wireKey=globalThis.Deno?.env.get('NORVA_POSTAL_WIRE_KEY')}={}){
 if(!['postal:send','postal:batch'].includes(operation))throw Error('email_operation_not_allowed');
 const headers=new Headers(init?.headers),key=headers.get('Idempotency-Key');
 if(init?.method!=='POST'||typeof init.body!=='string'||!key||!/^[\x21-\x7e]{1,256}$/.test(key)||
   headers.get('Content-Type')?.toLowerCase()!=='application/json'||!(init.signal instanceof AbortSignal))throw Error('invalid_email_transport_request');
 const envelope=await sealMailWire({kind:operation==='postal:batch'?'batch':'single',key,messages:JSON.parse(init.body)},wireKey,'request');
 const response=await fetchImpl(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(envelope),redirect:'error',signal:init.signal});
 if(!response.ok)throw Error('private_mail_gateway_unavailable');
 const bytes=await response.text();if(bytes.length>100000)throw Error('private_mail_response_limit');
 const value=await openMailWire(JSON.parse(bytes),wireKey,'response',envelope.id);
 if(!Number.isSafeInteger(value.status)||value.status<200||value.status>599||!value.body||typeof value.body!=='object')throw Error('private_mail_response_invalid');
 const outHeaders={'Content-Type':'application/json','Cache-Control':'no-store'};
 if(Number.isInteger(value.retryAfter)&&value.retryAfter>=0&&value.retryAfter<=21600)outHeaders['Retry-After']=String(value.retryAfter);
 return new Response(JSON.stringify(value.body),{status:value.status,headers:outHeaders});
}
