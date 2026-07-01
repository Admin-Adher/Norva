/**
 * Norva Admin Dashboard — Ops MVP (Health · Providers · Enrichment · Crons).
 *
 * Cloud-only. Data comes from PostgREST RPCs (`admin_overview`, `admin_sources`,
 * `admin_enrichment_coverage`, `admin_cron_health`) called directly with the user's
 * Supabase JWT — NO edge function (so it works even while edge deploys are down).
 * Every RPC is gated SERVER-SIDE by is_admin() (app_metadata.role='admin'); a
 * non-admin token gets "not authorized". The client-side gating below is UX only.
 */
class AdminPage {
    constructor(app) {
        this.app = app;
        this.built = false;
        this._isAdmin = null; // cached tri-state (null = unknown)
        // Users section is LIVE/paginated (not part of the cached snapshot). Its own state.
        this._users = { page: 0, limit: 25, search: '', sort: 'created_desc', total: 0 };
        this._usersDebounce = null;
    }

    // ── direct PostgREST RPC client (mirrors authApi.js config resolution) ──
    _sbUrl() {
        return (localStorage.getItem('norva-supabase-url') || window.NORVA_SUPABASE_URL
            || 'https://oupsceccxsonaalhueff.supabase.co').replace(/\/+$/, '');
    }
    _sbKey() {
        return localStorage.getItem('norva-supabase-key') || window.NORVA_SUPABASE_PUBLISHABLE_KEY
            || 'sb_publishable_LJwYVgPGHYNYTDk7s3eOew_6TU73Fcw';
    }
    _token() {
        try { return (JSON.parse(localStorage.getItem('norva-cloud-session') || 'null') || {}).access_token || ''; }
        catch (_) { return ''; }
    }
    async _rpc(fn, params) {
        const res = await fetch(`${this._sbUrl()}/rest/v1/rpc/${fn}`, {
            method: 'POST',
            headers: {
                apikey: this._sbKey(),
                Authorization: `Bearer ${this._token()}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(params || {})
        });
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`${fn}: ${res.status} ${t.slice(0, 140)}`);
        }
        return res.json();
    }

    /** Authoritative admin check (server-side). Cached. */
    async isAdmin(force) {
        if (this._isAdmin !== null && !force) return this._isAdmin;
        if (!window.API?.isCloudMode?.()) { this._isAdmin = false; return false; }
        try { this._isAdmin = (await this._rpc('is_admin')) === true; }
        catch (_) { this._isAdmin = false; }
        return this._isAdmin;
    }

    async show() {
        if (!(await this.isAdmin())) { this.app.navigateTo('home'); return; }
        this._ensureLayout();
        await this.refresh();
    }
    hide() { }

    // ── layout ──
    _ensureLayout() {
        let root = document.getElementById('page-admin');
        if (!root) {
            root = document.createElement('div');
            root.id = 'page-admin';
            root.className = 'page';
            (document.querySelector('.main-content') || document.getElementById('main-content') || document.body).appendChild(root);
        }
        if (this.built) return;
        root.innerHTML = `
<style>
#page-admin{height:100%;overflow-y:auto;-webkit-overflow-scrolling:touch;}
#page-admin .admin-wrap{max-width:1280px;margin:0 auto;padding:var(--space-lg,24px) var(--space-lg,24px) 80px;}
#page-admin .admin-head{display:flex;align-items:center;gap:14px;margin-bottom:20px;flex-wrap:wrap;}
#page-admin .admin-head h1{font-size:24px;font-weight:700;margin:0;color:var(--color-text-primary,#fff);}
#page-admin #admin-refresh{background:var(--color-accent,#e50914);color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer;font-weight:600;}
#page-admin #admin-ts{color:var(--color-text-secondary,#9aa);font-size:13px;}
#page-admin .admin-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:26px;}
#page-admin .kpi{background:var(--color-bg-secondary,#181818);border:1px solid var(--color-border,#2a2a2a);border-radius:10px;padding:14px;}
#page-admin .kpi .v{font-size:26px;font-weight:700;color:var(--color-text-primary,#fff);line-height:1.1;}
#page-admin .kpi .l{font-size:12px;color:var(--color-text-secondary,#9aa);margin-top:4px;text-transform:uppercase;letter-spacing:.4px;}
#page-admin .kpi.alert{border-color:#e5091455;background:#e5091412;}
#page-admin .kpi.alert .v{color:#ff6b6b;}
#page-admin .kpi.ok .v{color:#3ecf8e;}
#page-admin .admin-block{margin-bottom:30px;}
#page-admin .admin-block h2{font-size:16px;font-weight:600;margin:0 0 10px;color:var(--color-text-primary,#fff);}
#page-admin table{width:100%;border-collapse:collapse;font-size:13px;}
#page-admin th,#page-admin td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--color-border,#242424);white-space:nowrap;}
#page-admin th{color:var(--color-text-secondary,#9aa);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.4px;}
#page-admin td.num{text-align:right;font-variant-numeric:tabular-nums;}
#page-admin tr.bad{background:#e5091412;}
#page-admin .badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;}
#page-admin .badge.red{background:#e5091422;color:#ff6b6b;}
#page-admin .badge.green{background:#3ecf8e22;color:#3ecf8e;}
#page-admin .badge.gray{background:#8884;color:#bbb;}
#page-admin .badge.amber{background:#f5a62322;color:#f5c15a;}
#page-admin .badge.blue{background:#4a9eff22;color:#7ab8ff;}
#page-admin tr.group-start td{border-top:2px solid var(--color-border,#2a2a2a);}
#page-admin .pname{font-weight:600;}
#page-admin .pacct{font-size:11px;color:var(--color-text-secondary,#9aa);}
#page-admin .ssub{font-size:12px;color:var(--color-text-secondary,#9aa);margin:-4px 0 12px;}
#page-admin .resync-btn{background:var(--color-bg-secondary,#181818);color:var(--color-accent,#e50914);border:1px solid var(--color-border,#2a2a2a);border-radius:6px;padding:2px 9px;cursor:pointer;font-size:12px;white-space:nowrap;}
#page-admin .resync-btn:disabled{opacity:.5;cursor:default;}
#page-admin .bar{height:6px;border-radius:3px;background:#333;overflow:hidden;min-width:60px;display:inline-block;vertical-align:middle;margin-right:6px;}
#page-admin .bar>i{display:block;height:100%;background:#3ecf8e;}
#page-admin .admin-err{color:#ff6b6b;padding:10px;}
#page-admin .scroll{overflow-x:auto;}
#page-admin .users-controls{display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap;}
#page-admin .users-controls input,#page-admin .users-controls select{background:var(--color-bg-secondary,#181818);border:1px solid var(--color-border,#2a2a2a);color:var(--color-text-primary,#fff);border-radius:8px;padding:7px 11px;font-size:13px;}
#page-admin .users-controls input{min-width:240px;flex:1;max-width:360px;}
#page-admin .users-pager{display:flex;align-items:center;gap:14px;margin-top:12px;}
#page-admin .users-pager button{background:var(--color-bg-secondary,#181818);color:var(--color-text-primary,#fff);border:1px solid var(--color-border,#2a2a2a);border-radius:8px;padding:6px 12px;cursor:pointer;font-size:13px;}
#page-admin .users-pager button:disabled{opacity:.4;cursor:default;}
#page-admin .users-pager span{color:var(--color-text-secondary,#9aa);font-size:13px;font-variant-numeric:tabular-nums;}
</style>
<div class="admin-wrap">
  <div class="admin-head">
    <h1>⚙️ Admin — Ops</h1>
    <button id="admin-refresh">↻ Rafraîchir</button>
    <span id="admin-ts"></span>
  </div>
  <section id="admin-overview" class="admin-cards"></section>
  <section class="admin-block">
    <h2>👥 Utilisateurs</h2>
    <div class="ssub">Liste paginée — recherche par email, tri. Agrégation bornée par page (scalable à des milliers d'users).</div>
    <div class="users-controls">
      <input id="admin-users-search" type="search" placeholder="Rechercher un email…" autocomplete="off" />
      <select id="admin-users-sort">
        <option value="created_desc">Plus récents</option>
        <option value="created_asc">Plus anciens</option>
        <option value="active_desc">Dernière activité</option>
        <option value="email_asc">Email A→Z</option>
      </select>
    </div>
    <div class="scroll"><div id="admin-users"></div></div>
    <div class="users-pager">
      <button id="admin-users-prev">← Précédent</button>
      <span id="admin-users-range"></span>
      <button id="admin-users-next">Suivant →</button>
    </div>
  </section>
  <section class="admin-block"><h2>📡 Providers / Sources</h2><div class="ssub">Panels pilotes + sources en problème (sync incomplète / erreur) — borné à l'échelle</div><div class="scroll"><div id="admin-sources"></div></div></section>
  <section class="admin-block"><h2>⚙️ Enrichissement par panel</h2><div class="ssub">Comptes pilotes d'enrichissement uniquement (les autres users héritent via le cache cross-user)</div><div class="scroll"><div id="admin-enrich"></div></div></section>
  <section class="admin-block"><h2>⏱️ Crons</h2><div class="scroll"><div id="admin-cron"></div></div></section>
</div>`;
        const btn = root.querySelector('#admin-refresh');
        if (btn) btn.addEventListener('click', () => this.refresh());
        // Delegated handler for the per-source re-sync buttons (rows are re-rendered each refresh).
        root.addEventListener('click', (e) => {
            const b = e.target.closest('.resync-btn');
            if (b) { e.preventDefault(); this._resync(b); }
        });
        // Users section controls (static elements, built once).
        const usearch = root.querySelector('#admin-users-search');
        if (usearch) usearch.addEventListener('input', () => {
            clearTimeout(this._usersDebounce);
            this._usersDebounce = setTimeout(() => {
                this._users.search = usearch.value.trim();
                this._users.page = 0;
                this._loadUsers();
            }, 300);
        });
        const usort = root.querySelector('#admin-users-sort');
        if (usort) usort.addEventListener('change', () => {
            this._users.sort = usort.value; this._users.page = 0; this._loadUsers();
        });
        const uprev = root.querySelector('#admin-users-prev');
        if (uprev) uprev.addEventListener('click', () => {
            if (this._users.page > 0) { this._users.page -= 1; this._loadUsers(); }
        });
        const unext = root.querySelector('#admin-users-next');
        if (unext) unext.addEventListener('click', () => {
            const s = this._users;
            if ((s.page + 1) * s.limit < s.total) { s.page += 1; this._loadUsers(); }
        });
        this.built = true;
    }

    async refresh() {
        this._loadUsers();   // live/paginated — independent of the cached snapshot below
        const ts = document.getElementById('admin-ts');
        if (ts) ts.textContent = 'chargement…';
        try {
            const [ov, sources, enrich, cron] = await Promise.all([
                this._rpc('admin_overview'),
                this._rpc('admin_sources'),
                this._rpc('admin_enrichment_coverage'),
                this._rpc('admin_cron_health')
            ]);
            this._renderOverview(ov);
            this._renderSources(Array.isArray(sources) ? sources : []);
            this._renderEnrich(Array.isArray(enrich) ? enrich : []);
            this._renderCron(Array.isArray(cron) ? cron : []);
            if (ts) ts.textContent = 'snapshot · ' + (ov && ov.refreshed_at
                ? new Date(ov.refreshed_at).toLocaleTimeString('fr-FR') : new Date().toLocaleTimeString('fr-FR'))
                + ' · auto 5 min';
        } catch (e) {
            if (ts) ts.textContent = '';
            const ov = document.getElementById('admin-overview');
            if (ov) ov.innerHTML = `<div class="admin-err">Erreur de chargement : ${AdminPage.esc(e.message)}</div>`;
        }
    }

    // ── Users (live paginated) ──
    async _loadUsers() {
        const el = document.getElementById('admin-users');
        const range = document.getElementById('admin-users-range');
        if (!el) return;
        const s = this._users;
        if (range) range.textContent = '…';
        try {
            const res = await this._rpc('admin_users_page', {
                p_limit: s.limit,
                p_offset: s.page * s.limit,
                p_search: s.search || null,
                p_sort: s.sort
            });
            const rows = (res && Array.isArray(res.rows)) ? res.rows : [];
            s.total = Number(res && res.total) || 0;
            this._renderUsers(rows);
            const from = s.total === 0 ? 0 : s.page * s.limit + 1;
            const to = Math.min(s.total, (s.page + 1) * s.limit);
            if (range) range.textContent = `${AdminPage.n(from)}–${AdminPage.n(to)} sur ${AdminPage.n(s.total)}`;
            const prev = document.getElementById('admin-users-prev');
            const next = document.getElementById('admin-users-next');
            if (prev) prev.disabled = s.page <= 0;
            if (next) next.disabled = to >= s.total;
        } catch (e) {
            if (range) range.textContent = '';
            el.innerHTML = `<div class="admin-err">Erreur : ${AdminPage.esc(e.message)}</div>`;
        }
    }

    _renderUsers(rows) {
        const el = document.getElementById('admin-users');
        if (!el) return;
        if (!rows.length) { el.innerHTML = '<div class="ssub">Aucun utilisateur.</div>'; return; }
        const head = `<tr><th>Email</th><th>Rôle</th><th class="num">Sources</th><th>Inscrit</th><th>Dernière activité</th><th>Email vérifié</th></tr>`;
        const day = (d) => d ? new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
        const body = rows.map(r => {
            const role = r.role === 'admin' ? '<span class="badge amber">admin</span>' : '<span class="badge gray">user</span>';
            const driver = r.is_driver ? ' <span class="badge blue" title="Compte pilote d\'enrichissement">pilote</span>' : '';
            const conf = r.email_confirmed ? '<span class="badge green">✓</span>' : '<span class="badge red">non</span>';
            const last = r.last_sign_in_at
                ? `<span title="${AdminPage.esc(new Date(r.last_sign_in_at).toLocaleString('fr-FR'))}">${AdminPage.esc(AdminPage.timeAgo(r.last_sign_in_at))}</span>`
                : '<span class="badge gray">jamais</span>';
            return `<tr>
                <td>${AdminPage.esc(r.email || '—')}${driver}</td>
                <td>${role}</td>
                <td class="num">${AdminPage.n(r.sources_count)}</td>
                <td>${AdminPage.esc(day(r.created_at))}</td>
                <td>${last}</td>
                <td>${conf}</td>
            </tr>`;
        }).join('');
        el.innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
    }

    // ── renderers ──
    _renderOverview(o) {
        o = o || {};
        const el = document.getElementById('admin-overview');
        if (!el) return;
        const card = (v, l, cls) => `<div class="kpi ${cls || ''}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
        const n = (x) => (x == null ? '—' : Number(x).toLocaleString('fr-FR'));
        el.innerHTML = [
            card(n(o.users_total), 'Users', o.users_active_7d ? 'ok' : ''),
            card(n(o.sources_total), 'Sources'),
            card(n(o.sources_incomplete), 'Sync incomplète', Number(o.sources_incomplete) > 0 ? 'alert' : 'ok'),
            card(n(o.sources_error), 'Sources en erreur', Number(o.sources_error) > 0 ? 'alert' : 'ok'),
            card(n(o.titles_movie), 'Films'),
            card(n(o.titles_series), 'Séries'),
            card(n(o.identities_active), 'Identités'),
            card(n(o.cron_active), 'Crons actifs', 'ok'),
            card(n(o.cron_fails_24h), 'Échecs cron 24h', Number(o.cron_fails_24h) > 0 ? 'alert' : 'ok'),
            card(n(o.cron_paused), 'Crons en pause'),
            card(n(o.gensubs_ready), 'Sous-titres IA prêts'),
            card(n(o.gensubs_failed), 'Sous-titres IA échoués', Number(o.gensubs_failed) > 0 ? 'alert' : '')
        ].join('');
    }

    _renderSources(rows) {
        const el = document.getElementById('admin-sources');
        if (!el) return;
        // Group providers by account so a customer's panels sit together.
        const sorted = rows.slice().sort((a, b) =>
            String(a.owner_email).localeCompare(String(b.owner_email)) ||
            String(a.display_name).localeCompare(String(b.display_name)));
        const head = `<tr><th>Compte</th><th>Provider</th><th>Statut</th><th class="num">Items</th><th class="num">Variants</th><th class="num">Films</th><th class="num">Séries</th><th>Identité</th><th>Action</th></tr>`;
        let prevOwner = null;
        const body = sorted.map(r => {
            const bad = r.incomplete === true;
            const newGroup = r.owner_email !== prevOwner;
            prevOwner = r.owner_email;
            const status = bad
                ? `<span class="badge red">sync incomplète</span>`
                : (r.sync_error ? `<span class="badge red">${AdminPage.esc(r.sync_status || 'error')}</span>`
                    : `<span class="badge green">${AdminPage.esc(r.sync_status || 'ready')}</span>`);
            return `<tr class="${newGroup ? 'group-start' : ''} ${bad ? 'bad' : ''}">
                <td>${newGroup ? `<span class="pacct">${AdminPage.esc(r.owner_email || '—')}</span>` : ''}</td>
                <td>${AdminPage.esc(r.display_name)}</td>
                <td>${status}</td>
                <td class="num">${AdminPage.n(r.media_items)}</td>
                <td class="num">${AdminPage.n(r.variants)}</td>
                <td class="num">${AdminPage.n(r.movie_titles)}</td>
                <td class="num">${AdminPage.n(r.series_titles)}</td>
                <td>${r.identity_name ? AdminPage.esc(r.identity_name) : '<span class="badge gray">non résolue</span>'}</td>
                <td><button class="resync-btn" data-source="${AdminPage.esc(r.source_id)}" title="Forcer un re-sync complet de cette source">↻ re-sync</button></td>
            </tr>`;
        }).join('');
        el.innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
    }

    async _resync(btn) {
        const sourceId = btn.dataset.source;
        if (!sourceId || btn.disabled) return;
        const orig = btn.textContent;
        btn.disabled = true; btn.textContent = '…';
        try {
            const res = await fetch(`${this._sbUrl()}/functions/v1/norva-source-sync/admin/resync/${sourceId}`, {
                method: 'POST',
                headers: { apikey: this._sbKey(), Authorization: `Bearer ${this._token()}`, 'Content-Type': 'application/json' },
                body: '{}'
            });
            if (!res.ok) throw new Error(String(res.status));
            btn.textContent = '✓ lancé';
            setTimeout(() => this.refresh(), 6000);   // let the background sync progress, then re-read
        } catch (e) {
            btn.textContent = '✗ ' + AdminPage.esc(e.message || 'err');
            setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3500);
        }
    }

    _renderEnrich(rows) {
        const el = document.getElementById('admin-enrich');
        if (!el) return;
        const barCell = (a, p) => `<td class="num"><span class="bar"><i style="width:${Math.min(100, Number(p) || 0)}%"></i></span>${AdminPage.n(a)} (${p == null ? 0 : p}%)</td>`;
        const eta = (r) => {
            // "1ʳᵉ passe terminée" = never_probed 0 → tout a été sondé au moins une fois. Ce n'est PAS
            // "100% résolu" : le reste (audio résolu < 100%) est « und » dans le conteneur (piste sans
            // langue déclarée), que le probe ne peut pas résoudre — seul whisper le peut. Le libellé
            // dit donc "sondé", pas "complet", pour ne pas contredire une barre Audio résolu à 61%.
            if (Number(r.never_probed) === 0) {
                const undPct = Math.max(0, Math.round((100 - (Number(r.resolved_pct) || 0)) * 10) / 10);
                return `<span class="badge green" title="1ʳᵉ passe de sondage terminée : chaque titre a été sondé au moins une fois. Les ~${undPct}% non résolus sont « und » dans le conteneur (aucune langue déclarée) — seul whisper peut les résoudre.">✓ sondé</span>`;
            }
            if (Number(r.probed_24h) === 0) return '<span class="badge red">⏸ à l\'arrêt</span>';
            return `~${AdminPage.n(r.eta_days)} j`;
        };
        // Group by provider so a panel's films + séries sit together (account → panel → films first).
        const sorted = rows.slice().sort((a, b) =>
            String(a.owner_email).localeCompare(String(b.owner_email)) ||
            String(a.panel).localeCompare(String(b.panel)) ||
            ((a.item_type === 'series') ? 1 : 0) - ((b.item_type === 'series') ? 1 : 0));
        const head = `<tr><th>Provider</th><th>Type</th><th class="num">Total</th><th class="num">Audio résolu</th><th class="num">Jamais sondé</th><th class="num">Sondé 24h</th><th>ETA 1er passage</th><th class="num">ST trouvés</th></tr>`;
        let prevPanel = null;
        const body = sorted.map(r => {
            const newGroup = r.panel !== prevPanel;
            prevPanel = r.panel;
            const panelCell = newGroup
                ? `<td><div class="pname">${AdminPage.esc(r.panel)}</div><div class="pacct">${AdminPage.esc(r.owner_email || '')}</div></td>`
                : `<td></td>`;
            return `<tr class="${newGroup ? 'group-start' : ''}">
            ${panelCell}
            <td>${r.item_type === 'series' ? 'séries' : 'films'}</td>
            <td class="num">${AdminPage.n(r.total)}</td>
            ${barCell(r.resolved, r.resolved_pct)}
            <td class="num">${AdminPage.n(r.never_probed)}</td>
            <td class="num">${AdminPage.n(r.probed_24h)}</td>
            <td>${eta(r)}</td>
            <td class="num">${AdminPage.n(r.subtitle_found)}</td>
        </tr>`;
        }).join('');
        el.innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
    }

    _renderCron(rows) {
        const el = document.getElementById('admin-cron');
        if (!el) return;
        const winBadge = (w) => w === 'jour' ? '<span class="badge amber">☀️ jour</span>'
            : (w === 'nuit' ? '<span class="badge blue">🌙 nuit</span>' : '<span class="badge gray">—</span>');
        const head = `<tr><th>Fenêtre</th><th>Dimension</th><th>Job</th><th>Cadence</th><th>État</th><th>Dernier run</th><th class="num">Échecs 24h</th></tr>`;
        let prevWin = null;
        const body = rows.map(r => {
            const paused = r.active === false;
            const failing = Number(r.fails_24h) > 0;
            const newGroup = r.window !== prevWin;
            prevWin = r.window;
            const state = paused ? `<span class="badge gray">pause</span>`
                : (failing ? `<span class="badge red">échecs</span>` : `<span class="badge green">actif</span>`);
            const last = r.last_run ? new Date(r.last_run).toLocaleString('fr-FR') : '—';
            return `<tr class="${newGroup ? 'group-start' : ''} ${failing ? 'bad' : ''}">
                <td>${newGroup ? winBadge(r.window) : ''}</td>
                <td>${AdminPage.esc(r.kind)}</td>
                <td>${AdminPage.esc(r.jobname)}</td>
                <td><span title="${AdminPage.esc(r.schedule)}">${AdminPage.esc(AdminPage.cronHuman(r.schedule))}</span></td>
                <td>${state}</td>
                <td>${AdminPage.esc(last)} <span class="badge gray">${AdminPage.esc(r.last_status || '')}</span></td>
                <td class="num">${AdminPage.n(r.fails_24h)}</td>
            </tr>`;
        }).join('');
        el.innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
    }

    static n(x) { return x == null ? '—' : Number(x).toLocaleString('fr-FR'); }
    // Concise French relative time ("il y a 3 j", "il y a 2 h"). Absolute value kept as tooltip.
    static timeAgo(d) {
        const t = new Date(d).getTime();
        if (!Number.isFinite(t)) return '—';
        const s = Math.max(0, Math.round((Date.now() - t) / 1000));
        if (s < 60) return "à l'instant";
        const m = Math.round(s / 60); if (m < 60) return `il y a ${m} min`;
        const h = Math.round(m / 60); if (h < 24) return `il y a ${h} h`;
        const j = Math.round(h / 24); if (j < 31) return `il y a ${j} j`;
        const mo = Math.round(j / 30); if (mo < 12) return `il y a ${mo} mois`;
        return `il y a ${Math.round(mo / 12)} an${mo >= 24 ? 's' : ''}`;
    }
    // cron expression → concise French label (raw kept as tooltip). Falls back to raw on anything odd.
    static cronHuman(expr) {
        const p = String(expr || '').trim().split(/\s+/);
        if (p.length < 5) return expr || '—';
        const [min, hr] = p;
        let m, minLabel;
        if (min === '*') minLabel = 'chaque min';
        else if ((m = min.match(/^\*\/(\d+)$/))) minLabel = `toutes les ${m[1]} min`;
        else if ((m = min.match(/^\d+-\d+\/(\d+)$/))) minLabel = `toutes les ${m[1]} min`;
        else if (/,/.test(min)) { const a = min.split(',').map(Number); const s = a.length > 1 ? a[1] - a[0] : 0; minLabel = s > 0 ? `toutes les ${s} min` : `${a.length}×/h`; }
        else if (/^\d+$/.test(min)) minLabel = null;        // single minute → "1×/j à HhMM"
        else return expr;
        // hour
        if ((m = hr.match(/^\*\/(\d+)$/))) return `toutes les ${m[1]} h`;
        let hrLabel = '';
        if (hr === '*') hrLabel = '';
        else if ((m = hr.match(/^(\d+)-(\d+)$/))) hrLabel = `${m[1]}h–${m[2]}h`;
        else if (/,/.test(hr)) { const a = hr.split(','); hrLabel = `${a[0]}h–${a[a.length - 1]}h`; }
        else if (/^\d+$/.test(hr)) hrLabel = `${hr}h`;
        if (minLabel === null) {
            const mm = String(min).padStart(2, '0');
            return /^\d+$/.test(hr) ? `1×/j à ${hr}h${mm}` : `à :${mm}`;
        }
        return hrLabel ? `${minLabel} · ${hrLabel}` : minLabel;
    }
    static esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }
}

if (typeof window !== 'undefined') window.AdminPage = AdminPage;
