// Produces local review artifacts only. The operator separately queues the
// explicitly labeled internal transport validations after reviewing this file.
const fs = require('node:fs');
const path = require('node:path');
const { importTypescriptModule } = require('../tests/helpers/import-typescript-module');
(async () => {
  const out = path.resolve(process.argv[2]);
  fs.mkdirSync(out, { recursive: true });
  globalThis.Deno = { env: { get: key => key === 'PUBLIC_SITE_URL' ? 'https://norva.tv' : undefined }, serve() {} };
  const e = await importTypescriptModule(path.join(__dirname, '../supabase/functions/_shared/lifecycle-email.ts'));
  const imports = await importTypescriptModule(path.join(__dirname, '../supabase/functions/_shared/import-email.ts'));
  const auth = await importTypescriptModule(path.join(__dirname, '../supabase/functions/norva-auth-email/index.ts'));
  const { renderEmailFrame } = await importTypescriptModule(path.join(__dirname, '../supabase/functions/_shared/email-frame.ts'));
  fs.cpSync(path.join(__dirname, '../public/img/email'), path.join(out, 'img/email'), { recursive: true });
  const items = [
    ['welcome', e.renderWelcome('Adrien')],
    ['payment_failed', e.renderPaymentFailed('Adrien', 1)],
    ['renewal_upcoming', e.renderRenewalUpcoming('Adrien', { renewsAt: '2026-09-15T12:00:00Z' })],
    ['payment_receipt', e.renderReceipt('Adrien', { planLabel: 'Norva Family', amount: '$9.99', currency: 'USD', billingPeriod: 'monthly', confirmedAt: '2026-09-08T12:00:00Z', periodEnd: '2026-10-08T12:00:00Z', reference: 'NV-DEMO-20260908' })],
    ['import_completed', imports.renderImportCompleted('Adrien', [{ name: 'My source', movies: 12480, series: 820, channels: 250 }])],
    ['verification', auth.buildOutboundEmails({ user: { email: 'preview@example.test' }, email_data: { token: '123456', token_hash: 'invalid-preview-token', email_action_type: 'reauthentication', redirect_to: 'https://norva.tv/account.html' } })[0]],
    ['support', { subject: 'We replied to your support request', text: 'Hi Adrien, our support team has replied. Open your conversation in Norva to continue.', html: renderEmailFrame({ artwork: 'support', title: 'We replied to your support request', heading: 'We replied to your support request', preheader: 'Your Norva conversation has an update.', bodyHtml: '<p style="margin:0">Hi Adrien,<br><br>Our support team has replied. Open your conversation in Norva to continue.</p>', cta: { label: 'Open my conversation', url: 'https://norva.tv/app.html#support' } }) }],
  ].map(([flow, message]) => {
    fs.writeFileSync(path.join(out, flow + '.html'), message.html.replaceAll('https://norva.tv/img/email/', 'img/email/'));
    return { flow, subject: '[TEST Norva] ' + message.subject,
      html: message.html.replace(/(<body[^>]*>)/i, '$1<div style="padding:16px;background:#fff;color:#111">TECHNICAL VALIDATION — no account setting or payment was changed. The message below is a sample.</div>'),
      text: 'TECHNICAL VALIDATION — no account setting or payment was changed. The message below is a sample.\n\n' + message.text };
  });
  fs.writeFileSync(path.join(out, 'internal-validation.json'), JSON.stringify(items));
  fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Norva — Aperçu des emails</title><style>body{margin:0;background:#080B12;color:#F8FAFC;font:16px Inter,Segoe UI,Arial,sans-serif}nav{padding:16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #3f3f46}select{padding:12px;background:#12121a;color:#F8FAFC;border:1px solid #64748b;border-radius:6px;font:inherit}iframe{display:block;width:100%;height:calc(100vh - 90px);border:0;margin:auto}span{color:#94A3B8}</style><nav><strong>Norva · Emails</strong><select aria-label="Type de message" onchange="document.querySelector('iframe').src=this.value">${items.map(x => `<option value="${x.flow}.html">${({welcome:'Bienvenue',payment_failed:'Paiement échoué',renewal_upcoming:'Renouvellement',payment_receipt:'Reçu de paiement',import_completed:'Import terminé',verification:'Code de vérification',support:'Support'})[x.flow]}</option>`).join('')}</select><select aria-label="Format" onchange="document.querySelector('iframe').style.maxWidth=this.value"><option value="100%">Ordinateur</option><option value="390px">Mobile</option></select><span>Données de démonstration</span></nav><iframe title="Aperçu de l’email" src="welcome.html"></iframe></html>`);
  console.log(JSON.stringify({ previews: items.map(x => x.flow), destination: out }));
})().catch(e => { console.error(e.message); process.exitCode = 1; });
