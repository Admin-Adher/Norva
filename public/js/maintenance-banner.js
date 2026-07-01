/**
 * Maintenance banner — consumer of the `maintenance_banner` feature flag (toggled from the admin
 * Système page). Self-contained: reads the anon-safe RPC app_public_flags() and, when the flag is on,
 * pins a bottom bar for every visitor (logged-out too). No dependency on app.js internals.
 */
(function () {
  function sbUrl() {
    return (localStorage.getItem('norva-supabase-url') || window.NORVA_SUPABASE_URL
      || 'https://oupsceccxsonaalhueff.supabase.co').replace(/\/+$/, '');
  }
  function sbKey() {
    return localStorage.getItem('norva-supabase-key') || window.NORVA_SUPABASE_PUBLISHABLE_KEY
      || 'sb_publishable_LJwYVgPGHYNYTDk7s3eOew_6TU73Fcw';
  }
  function show() {
    if (document.getElementById('norva-maint-banner')) return;
    var b = document.createElement('div');
    b.id = 'norva-maint-banner';
    b.textContent = '🛠️ Maintenance en cours — certaines fonctionnalités peuvent être temporairement indisponibles.';
    b.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#f5a623;color:#111;'
      + 'font-weight:600;font-size:13px;text-align:center;padding:9px 14px;box-shadow:0 -2px 8px rgba(0,0,0,.35);';
    document.body.appendChild(b);
  }
  function hide() { var b = document.getElementById('norva-maint-banner'); if (b) b.remove(); }
  function check() {
    fetch(sbUrl() + '/rest/v1/rpc/app_public_flags', {
      method: 'POST',
      headers: { apikey: sbKey(), 'Content-Type': 'application/json' },
      body: '{}'
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.maintenance_banner === true) show(); else hide(); })
      .catch(function () { /* offline / RPC down → no banner */ });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
  else check();
  // Re-check periodically so toggling the flag reaches open tabs within a minute.
  setInterval(check, 60000);
})();
