'use strict';
// Development-only NMT drafts. No credential is embedded in shipped assets.
const fs = require('node:fs');
const path = require('node:path');
const {load, tokens} = require('./catalog.cjs');
const locales = require('../../i18n/locales.json');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'output/i18n/cloud-translation');
const names = ['web', 'web-extra', 'web-dynamic', 'web-tail'];
const cp = s => [...s].length;
const write = (file, value) => {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
};
function plan() {
  const merged = load();
  return locales.map(({code}) => ({code, rows: Object.entries(merged)
    .filter(([,e]) => !e[code]?.trim()).map(([key,e]) => ({key, source:e.source}))}));
}
async function main() {
  const groups = plan();
  const summary = groups.map(g => ({locale:g.code, missing:g.rows.length,
    characters:g.rows.reduce((n,r) => n + cp(r.source), 0)}));
  console.log(JSON.stringify(summary));
  if (!process.argv.includes('--execute')) return;
  const key = process.env.NORVA_TRANSLATION_API_KEY;
  if (!key) throw Error('NORVA_TRANSLATION_API_KEY is required; do not put secrets in command arguments.');
  fs.mkdirSync(output, {recursive:true});
  const ledgerFile = path.join(output, 'ledger.json');
  const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile)) : {characters:0, requests:0};
  const ceiling = 1000000; // Cumulative across resumes; not a Google-account-wide quota.
  const catalogs = Object.fromEntries(names.map(n => [n, JSON.parse(fs.readFileSync(path.join(root, 'i18n', n+'.json')))]));
  for (const group of groups) {
    while (group.rows.length) {
      const batch = [];
      let characters = 0;
      while (group.rows.length && batch.length < 64 && (batch.length === 0 || characters + cp(group.rows[0].source) <= 4000)) {
        const row = group.rows.shift(); batch.push(row); characters += cp(row.source);
      }
      if (ledger.characters + characters > ceiling) throw Error('Local character ceiling reached; stopped before sending.');
      const requestId = ledger.requests + 1;
      const responseFile = path.join(output, String(requestId).padStart(5,'0')+'.json');
      // Reserve before transmission, including uncertain network failures. Never auto-retry.
      ledger.characters += characters; ledger.requests = requestId; write(ledgerFile, ledger);
      const response = await fetch('https://translation.googleapis.com/language/translate/v2', {
        method:'POST', headers:{'Content-Type':'application/json', 'X-Goog-Api-Key':key},
        body:JSON.stringify({q:batch.map(r=>r.source), target:group.code === 'pt-BR' ? 'pt' : group.code, format:'text', model:'nmt'}),
        signal:AbortSignal.timeout(60000)
      });
      if (!response.ok) throw Error('Cloud Translation HTTP '+response.status+'; stopped without automatic retries.');
      const data = await response.json();
      const translations = data.data?.translations;
      write(responseFile, {locale:group.code, rows:batch, translations});
      if (!Array.isArray(translations) || translations.length !== batch.length) throw Error('Unexpected response length; saved for review.');
      let rejected = 0;
      batch.forEach((row,i) => {
        const value = translations[i].translatedText;
        if (typeof value !== 'string' || !value.trim() || tokens(value) !== tokens(row.source) || /ZXQ(?:ARG|ROW)/.test(value)) { rejected++; return; }
        for (const catalog of Object.values(catalogs)) if (catalog[row.key] && !catalog[row.key][group.code]?.trim()) catalog[row.key][group.code] = value;
      });
      for (const [name,catalog] of Object.entries(catalogs)) write(path.join(root,'i18n',name+'.json'),catalog);
      console.log(group.code+': '+batch.length+' responses, '+rejected+' rejected; cumulative characters '+ledger.characters);
      if (rejected) console.warn('Rejected values left empty for contextual review; response saved in '+responseFile);
      if (process.argv.includes('--sample')) return;
      await new Promise(r=>setTimeout(r,1000));
    }
  }
}
if (require.main === module) main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports = {plan};
