// Authenticated encryption on the private Edge -> coordinator hop. No bearer
// link or recipient is sent in plaintext, even on the internal Docker bridge.
const encoder = new TextEncoder(), decoder = new TextDecoder();
const b64 = bytes => btoa(Array.from(new Uint8Array(bytes), x => String.fromCharCode(x)).join(''));
const un64 = text => Uint8Array.from(atob(text), x => x.charCodeAt(0));
async function key(secret, direction) {
  if (!['request','response'].includes(direction)) throw Error('invalid_direction');
  const bytes = un64(secret);
  if (bytes.length !== 32) throw Error('invalid_transport_key');
  const material = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode('norva-auth-private-v1'),
    info:encoder.encode(direction)}, material, {name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function seal(value, secret, direction, now=Date.now()) {
  const envelope={v:1,t:Math.floor(now/1000),id:crypto.randomUUID(),iv:b64(crypto.getRandomValues(new Uint8Array(12)))};
  const plain=encoder.encode(JSON.stringify(value));
  if(plain.length>380000)throw Error('private_payload_too_large');
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv:un64(envelope.iv),
    additionalData:encoder.encode(JSON.stringify([direction,envelope.v,envelope.t,envelope.id]))},await key(secret,direction),plain);
  return {...envelope,data:b64(encrypted)};
}
export async function open(envelope,secret,direction,now=Date.now()) {
  if(envelope?.v!==1 || !Number.isInteger(envelope.t) || Math.abs(Math.floor(now/1000)-envelope.t)>30 ||
    !/^[0-9a-f-]{36}$/.test(envelope.id??'') || typeof envelope.data!=='string' || envelope.data.length>510000 ||
    !/^[A-Za-z0-9+/]{16}$/.test(envelope.iv??''))throw Error('invalid_private_envelope');
  const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:un64(envelope.iv),
    additionalData:encoder.encode(JSON.stringify([direction,envelope.v,envelope.t,envelope.id]))},await key(secret,direction),un64(envelope.data));
  return JSON.parse(decoder.decode(clear));
}
// Only the stable transport key is bundled into this one Auth worker. The
// coordinator re-reads its policy on EVERY request; SQL and the SMTP runner
// independently enforce expiry. A cached Edge module must never cache authority.
// The exact controlled pair stays fail-closed, including when Postal is disabled.
export function privateAuthForwarder({allowlist,transportKey,fetchImpl=fetch}) {
  return async input=>{
    const u=input?.payload?.user;
    if(input?.payload?.email_data?.email_action_type!=='email_change'||u?.id!==allowlist.userId||
      u.email?.toLowerCase()!==allowlist.currentEmail||u.new_email?.toLowerCase()!==allowlist.newEmail)return null;
    try {
      const envelope=await seal(input,transportKey,'request');
      const result=await fetchImpl('http://norva-private-auth-gateway:18187/auth-pair',{method:'POST',redirect:'error',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(envelope),signal:AbortSignal.timeout(3500)});
      if(!result.ok || Number(result.headers.get('content-length'))>8192)throw Error('private_queue_unavailable');
      const raw=await result.text();if(raw.length>8192)throw Error('invalid_private_response');
      const ack=await open(JSON.parse(raw),transportKey,'response');
      if(ack.requestId!==envelope.id||ack.status!==200||ack.acceptance!=='durable_pair')throw Error('private_receipt_missing');
      return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});
    } catch {return new Response('{"error":"Email queue unavailable","retryable":true}',
      {status:503,headers:{'Content-Type':'application/json','Retry-After':'2'}});}
  };
}
