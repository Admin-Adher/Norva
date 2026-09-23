import { createHash, createPublicKey, publicEncrypt, constants } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LABEL = Buffer.from('norva-media-cache-runtime-v1');
export const RECIPIENT_SHA256 = 'ffd90fb54c422a287ac9c3f589909aa91e86ec6c67f6ab858c072c3b29d44a0e';

export function sealRuntimeKeys(publicPem, ticketKey, coordinationKey, now = Date.now()) {
  const key = createPublicKey(publicPem);
  if (createHash('sha256').update(key.export({type:'spki', format:'der'})).digest('hex') !== RECIPIENT_SHA256) throw new Error('Recipient mismatch');
  if (![ticketKey, coordinationKey].every(v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v))
      || ticketKey === coordinationKey) throw new Error('Invalid or duplicated runtime keys');
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength !== 3072) throw new Error('Invalid recipient type');
  return publicEncrypt({key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash:'sha256', oaepLabel:LABEL},
    Buffer.from(JSON.stringify({schema:1, issuedAt:now, ticketKey, coordinationKey})));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const pem = fs.readFileSync(new URL('./media-cache-runtime-recipient.pem', import.meta.url));
    const sealed = sealRuntimeKeys(pem, process.env.NORVA_MEDIA_CACHE_TICKET_HMAC_KEY, process.env.NORVA_MEDIA_CACHE_COORDINATION_HMAC_KEY);
    fs.mkdirSync('artifacts', {recursive:true});
    fs.writeFileSync('artifacts/media-cache-runtime.sealed', sealed, {mode:0o600, flag:'wx'});
    console.log('Runtime keys sealed for the pinned Norva production recipient. No activation performed.');
  } catch (_) {
    console.error('Runtime key sealing failed; no secret details emitted.');
    process.exitCode=1;
  }
}
