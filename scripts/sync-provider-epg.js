// The Edge runtime and the Gateway Docker context use the same bounded parser.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
for (const name of ['provider-epg.mjs', 'bounded-provider-response.mjs']) {
    const target = path.join(root, 'services/media-gateway/src/provider-epg-shared', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, 'supabase/functions/_shared', name), target);
}
