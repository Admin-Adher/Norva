// Hash the standalone reviewed runtime. Historical pilot generators are not
// needed to build this release; postal.rb and the verifier are reviewed sources.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=dirname(fileURLToPath(import.meta.url));
const copyCanonical=(source,target)=>writeFileSync(resolve(root,target),readFileSync(resolve(root,source),'utf8').replaceAll('\r\n','\n'));
copyCanonical('../../../../supabase/functions/_shared/postal-mail-wire.mjs','postal-mail-wire.mjs');
copyCanonical('../../../../supabase/migrations/20260906083918_postal_full_transport_receipts.sql','migration.sql');
const files=['model.mjs','store.mjs','worker.mjs','service.mjs','gateway.mjs','postal-mail-wire.mjs','postal-webhook-verifier.mjs','guest.py','postal.rb','install-host.py','install-guest.py','Dockerfile','migration.sql'];
// Reproducible hashes on Windows and Linux; Git pins this directory to LF.
for(const n of files){const p=resolve(root,n),before=readFileSync(p,'utf8');if(before.includes('\r\n'))writeFileSync(p,before.replaceAll('\r\n','\n'));}
const hashes=Object.fromEntries(files.map(n=>[n,createHash('sha256').update(readFileSync(resolve(root,n))).digest('hex')]));
writeFileSync(resolve(root,'manifest.json'),JSON.stringify(hashes,null,2)+'\n');
console.log(JSON.stringify({result:'POSTAL_RELEASE_STAGED',files:files.length}));
