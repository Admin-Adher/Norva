const encoder=new TextEncoder(),decoder=new TextDecoder();
function bytes(hex){if(!/^[a-f0-9]{64}$/.test(hex))throw Error('mail_wire_key_invalid');return Uint8Array.from(hex.match(/../g),v=>parseInt(v,16));}
function base64(value){let out='';for(let i=0;i<value.length;i+=8192)out+=String.fromCharCode(...value.subarray(i,i+8192));return btoa(out);}
function unbase64(value){if(typeof value!=='string'||value.length>1100000||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw Error('mail_wire_invalid');return Uint8Array.from(atob(value),c=>c.charCodeAt(0));}
function aad(direction,id,t){if(!['request','response'].includes(direction)||!/^[a-f0-9-]{36}$/.test(id)||!Number.isSafeInteger(t))throw Error('mail_wire_binding');return encoder.encode(`norva-mail-v1|${direction}|${id}|${t}`);}
export async function sealMailWire(value,keyHex,direction,id=crypto.randomUUID(),now=Date.now()){
 const clear=encoder.encode(JSON.stringify(value));if(clear.byteLength>700000)throw Error('mail_wire_limit');
 const key=await crypto.subtle.importKey('raw',bytes(keyHex),'AES-GCM',false,['encrypt']);
 const nonce=crypto.getRandomValues(new Uint8Array(12));
 const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:aad(direction,id,now)},key,clear);
 return {v:1,id,t:now,n:base64(nonce),c:base64(new Uint8Array(cipher))};
}
export async function openMailWire(envelope,keyHex,direction,expectedId=null,now=Date.now()){
 if(!envelope||envelope.v!==1||!Number.isSafeInteger(envelope.t)||Math.abs(now-envelope.t)>300000||
    (expectedId!==null&&envelope.id!==expectedId))throw Error('mail_wire_invalid');
 const nonce=unbase64(envelope.n);if(nonce.length!==12)throw Error('mail_wire_invalid');
 const key=await crypto.subtle.importKey('raw',bytes(keyHex),'AES-GCM',false,['decrypt']);
 const value=await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce,additionalData:aad(direction,envelope.id,envelope.t)},key,unbase64(envelope.c));
 if(value.byteLength>700000)throw Error('mail_wire_limit');return JSON.parse(decoder.decode(value));
}
