import {createHash} from 'node:crypto';
const address=/^[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
export const sha=value=>createHash('sha256').update(value).digest('hex');
export function validateRequest(value){
 if(!value||!['single','batch'].includes(value.kind)||typeof value.key!=='string'||
    !/^[\x21-\x7e]{1,256}$/.test(value.key))throw Error('invalid_request');
 const source=value.kind==='batch'?value.messages:[value.messages];
 if(!Array.isArray(source)||source.length<1||source.length>2)throw Error('invalid_batch');
 const messages=source.map(m=>{
  if(!m||Object.keys(m).some(k=>!['from','to','reply_to','subject','html','text','tags','headers'].includes(k)))throw Error('unsupported_mail_field');
  const to=Array.isArray(m.to)?m.to:[m.to];
  if(to.length!==1||typeof to[0]!=='string'||to[0].length>254||!address.test(to[0]))throw Error('invalid_recipient');
  if(typeof m.from!=='string'||!/^Norva(?: Support)? <[^<>\r\n]+@(?:notify\.)?norva\.tv>$/i.test(m.from))throw Error('invalid_sender');
  if(m.reply_to!==undefined&&(typeof m.reply_to!=='string'||m.reply_to.length>254||!address.test(m.reply_to)))throw Error('invalid_reply_to');
  if(typeof m.subject!=='string'||m.subject.length<1||m.subject.length>300||/[\r\n]/.test(m.subject))throw Error('invalid_subject');
  if(!m.html&&!m.text)throw Error('empty_content');
  for(const k of ['html','text'])if(m[k]!==undefined&&(typeof m[k]!=='string'||Buffer.byteLength(m[k])>180000))throw Error('content_limit');
  const tags=m.tags??[];
  if(!Array.isArray(tags)||tags.length>12||tags.some(t=>!t||typeof t.name!=='string'||typeof t.value!=='string'||!/^[a-zA-Z0-9_-]{1,50}$/.test(t.name)||!/^[a-zA-Z0-9_.:-]{1,150}$/.test(t.value)))throw Error('invalid_tags');
  const headers=m.headers??{};
  if(!headers||typeof headers!=='object'||Array.isArray(headers)||Object.keys(headers).some(k=>!['List-Unsubscribe','List-Unsubscribe-Post','X-Entity-Ref-ID'].includes(k))||
     Object.values(headers).some(v=>typeof v!=='string'||v.length>2048||/[\r\n]/.test(v)))throw Error('invalid_headers');
  const flow=tags.find(t=>t.name==='flow')?.value??'transactional';
  const category=tags.find(t=>t.name==='category')?.value??'';
  const auth=category==='transactional_auth'||value.key.startsWith('norva-auth-')||value.key.startsWith('norva-mailbox-proof-');
  if(headers['List-Unsubscribe-Post']&&headers['List-Unsubscribe-Post']!=='List-Unsubscribe=One-Click')throw Error('invalid_unsubscribe');
  return {from:'Norva <support@notify.norva.tv>',to:to[0].toLowerCase(),reply_to:m.reply_to??'support@norva.tv',
   subject:m.subject,html:m.html??'',text:m.text??'',headers,tags,flow,auth};
 });
 if(value.kind==='batch'&&(messages.length!==2||messages.some(m=>!m.auth)||messages[0].to===messages[1].to))throw Error('invalid_auth_pair');
 const canonical=JSON.stringify(messages);
 if(Buffer.byteLength(canonical)>390000)throw Error('batch_limit');
 // Auth retries may carry different outer webhook ids/user metadata. The
 // rendered, recipient-bound secure pair, not that outer id, is its authority.
 const authority=messages.every(m=>m.auth)?'auth-content-'+sha(canonical):value.key;
 return {kind:value.kind,key:value.key,authority,messages,digest:sha(canonical),auth:messages.every(m=>m.auth)};
}
