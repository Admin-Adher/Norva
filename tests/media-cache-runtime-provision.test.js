const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {generateKeyPairSync} = require('node:crypto');
const root = path.join(__dirname, '..');
const modulePath = pathToFileURL(path.join(root, 'ops/cloudflare/seal-media-cache-runtime.mjs'));
const pem = fs.readFileSync(path.join(root, 'ops/cloudflare/media-cache-runtime-recipient.pem'));

test('runtime configuration is encrypted to the pinned recipient with randomized OAEP', async () => {
  const {sealRuntimeKeys} = await import(modulePath);
  const a=sealRuntimeKeys(pem, 'a'.repeat(64), 'b'.repeat(64), 1000);
  const b=sealRuntimeKeys(pem, 'a'.repeat(64), 'b'.repeat(64), 1000);
  assert.equal(a.length,384);
  assert.notDeepEqual(a,b);
  assert.equal(a.includes(Buffer.from('a'.repeat(64))),false);
});

test('recipient substitution and invalid or shared secrets fail closed', async () => {
  const {sealRuntimeKeys} = await import(modulePath);
  const other=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'pem'});
  assert.throws(()=>sealRuntimeKeys(other,'a'.repeat(64),'b'.repeat(64)),/Recipient mismatch/);
  assert.equal(sealRuntimeKeys(Buffer.from(pem.toString().replaceAll('\n','\r\n')),'a'.repeat(64),'b'.repeat(64)).length,384);
  for(const [a,b] of [['x','b'.repeat(64)],['a'.repeat(64),'a'.repeat(64)],[undefined,'b'.repeat(64)]]) {
    assert.throws(()=>sealRuntimeKeys(pem,a,b),/Invalid or duplicated/);
  }
});

test('workflow only seals missing keys and has no plaintext artifact or user-controlled recipient', () => {
  const workflow=fs.readFileSync(path.join(root,'.github/workflows/provision-media-cache-runtime.yml'),'utf8');
  assert.match(workflow,/github.ref == 'refs\/heads\/main'/);
  assert.match(workflow,/environment: Cloudflare/);
  assert.match(workflow,/path: artifacts\/media-cache-runtime\.sealed/);
  assert.doesNotMatch(workflow,/inputs\.(recipient|public_key)|secrets\.(CLOUDFLARE_API_TOKEN|NORVA_MEDIA_CACHE_WORKER_TOKEN)/);
  const receiver=fs.readFileSync(path.join(root,'ops/hetzner/media/provision-media-cache-runtime.py'),'utf8');
  assert.match(receiver,/900000/);
  assert.match(receiver,/lock table public.cloud_runtime_config/);
  assert.match(receiver,/Cache rollout must remain off/);
});
