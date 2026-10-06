'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { references, digest } = require('./fingerprint-app-assets.cjs');

async function verify(origin, manifest, fetcher = fetch) {
  const get = async url => {
    const response = await fetcher(new URL(url, origin), { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('Asset HTTP ' + response.status + ': ' + url);
    return Buffer.from(await response.arrayBuffer());
  };
  // Validate the shell actually served, then the bytes at every referenced URL.
  // A ?v= label or a successful upload alone is not evidence of delivered code.
  const shell = (await get('/app')).toString('utf8');
  const actual = references(shell);
  for (const asset of manifest.assets) {
    const ref = actual.find(r => r.url === asset.url);
    if (!ref || !ref.tag.includes('integrity="' + asset.integrity + '"')) throw Error('Stale application shell: ' + asset.source);
  }
  if (new Set(actual.map(r => r.url)).size !== manifest.assets.length) throw Error('Unexpected application asset set');
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, manifest.assets.length) }, async () => {
    while (cursor < manifest.assets.length) {
      const asset = manifest.assets[cursor++];
      if (digest(await get(asset.url)) !== asset.sha256) throw Error('Delivered asset hash mismatch: ' + asset.source);
    }
  }));
  return { verifiedAssets: manifest.assets.length };
}
module.exports = { verify };
if (require.main === module) {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(process.argv[3] || 'public/app-assets.json'), 'utf8'));
  (async () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      try { console.log(JSON.stringify(await verify(process.argv[2] || 'https://norva.tv', manifest))); return; }
      catch (error) {
        console.error('Deployment verification ' + attempt + ': ' + error.message);
        if (attempt === 6) throw error;
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
  })().catch(() => { process.exitCode = 1; });
}
