/**
 * Norva Admin — bespoke CRM shell.
 *
 * Cloud-only. When the user opens "Admin" they enter a dedicated CRM layout: a left sidebar with
 * internal routing (Cockpit · Clients · Providers · Moteur · Système) and a scrollable content area.
 * Data comes from PostgREST RPCs called directly with the user's Supabase JWT — NO edge function (so
 * it works even while edge deploys are down). Every RPC is gated SERVER-SIDE by is_admin()
 * (app_metadata.role='admin'); a non-admin token gets "not authorized". Client-side gating is UX only.
 *
 * Internal routing is state-based (this._route): 'cockpit' | 'clients' | 'client:<uuid>' |
 * 'providers' | 'moteur' | 'systeme'. Each page fetches its own (server-cached) RPC on navigation.
 */
class AdminPage {
    constructor(app) {
        this.app = app;
        this.built = false;
        this._isAdmin = null; // cached tri-state (null = unknown)
        this._route = 'cockpit';
        // Clients list is LIVE/paginated (not part of the cached snapshot). Its own state.
        this._users = { page: 0, limit: 25, search: '', sort: 'created_desc', tagId: '', total: 0 };
        this._allTags = [];
        this._usersDebounce = null;
        this._lastTs = null; // snapshot refreshed_at for the topbar
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
        this._navigate(this._route || 'cockpit');
    }
    hide() { }

    // ── CRM shell ──
    static NAV() {
        return [
            { key: 'cockpit', label: 'Cockpit', icon: '🎯' },
            { key: 'clients', label: 'Clients', icon: '👥' },
            { key: 'providers', label: 'Providers', icon: '📡' },
            { key: 'moteur', label: 'Moteur', icon: '⚙️' },
            { key: 'systeme', label: 'Système', icon: '🛡️' }
        ];
    }

    _ensureLayout() {
        let root = document.getElementById('page-admin');
        if (!root) {
            root = document.createElement('div');
            root.id = 'page-admin';
            root.className = 'page';
            (document.querySelector('.main-content') || document.getElementById('main-content') || document.body).appendChild(root);
        }
        if (this.built) return;
        const nav = AdminPage.NAV().map(n =>
            `<button class="crm-nav-item" data-route="${n.key}"><span class="ic">${n.icon}</span><span class="lb">${n.label}</span></button>`).join('');
        root.innerHTML = `
<style>
#page-admin{height:100%;overflow:hidden;}
#page-admin *{box-sizing:border-box;}
#page-admin .crm-shell{display:flex;height:100%;background:var(--color-bg-primary,#0d0d0f);}
#page-admin .crm-sidebar{width:232px;flex-shrink:0;background:var(--color-bg-secondary,#141418);border-right:1px solid var(--color-border,#242430);display:flex;flex-direction:column;overflow-y:auto;padding:16px 12px;}
#page-admin .crm-brand{display:flex;align-items:center;gap:9px;padding:6px 8px 16px;font-weight:800;font-size:16px;color:var(--color-text-primary,#fff);}
#page-admin .crm-brand .dot{width:22px;height:22px;border-radius:7px;background:linear-gradient(135deg,#5b7cfa,#a855f7);display:inline-block;}
#page-admin .crm-nav-item{display:flex;align-items:center;gap:11px;width:100%;background:none;border:0;color:var(--color-text-secondary,#9aa);padding:10px 11px;border-radius:9px;cursor:pointer;font-size:14px;font-weight:500;text-align:left;margin-bottom:2px;}
#page-admin .crm-nav-item .ic{font-size:16px;width:20px;text-align:center;}
#page-admin .crm-nav-item:hover{background:#ffffff0a;color:var(--color-text-primary,#fff);}
#page-admin .crm-nav-item.active{background:#5b7cfa1f;color:#a9bcff;font-weight:600;}
#page-admin .crm-side-foot{margin-top:auto;padding:12px 10px 4px;font-size:11px;color:#66707e;line-height:1.5;}
#page-admin .crm-main{flex:1;min-width:0;overflow-y:auto;-webkit-overflow-scrolling:touch;}
#page-admin .crm-topbar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:14px;padding:14px 26px;background:rgba(13,13,15,.86);backdrop-filter:blur(8px);border-bottom:1px solid var(--color-border,#242430);}
#page-admin .crm-crumb{font-size:15px;font-weight:700;color:var(--color-text-primary,#fff);}
#page-admin .crm-spacer{flex:1;}
#page-admin #crm-refresh{background:#5b7cfa;color:#fff;border:0;border-radius:8px;padding:7px 13px;cursor:pointer;font-weight:600;font-size:13px;}
#page-admin #crm-ts{color:#66707e;font-size:12px;}
#page-admin .crm-page{max-width:1240px;margin:0 auto;padding:24px 26px 90px;}
#page-admin .crm-h1{font-size:22px;font-weight:700;margin:0 0 4px;color:var(--color-text-primary,#fff);}
#page-admin .crm-sub{color:var(--color-text-secondary,#9aa);font-size:13px;margin:0 0 22px;}
#page-admin .admin-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:12px;margin-bottom:26px;}
#page-admin .kpi-groups{margin-bottom:24px;}
#page-admin .kpi-group{margin-bottom:20px;}
#page-admin .kpi-group:last-child{margin-bottom:0;}
#page-admin .kpi-gtitle{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#7a8494;margin:0 0 9px 2px;}
#page-admin .kpi-group .admin-cards{margin-bottom:0;}
#page-admin .kpi{background:var(--color-bg-secondary,#16161c);border:1px solid var(--color-border,#242430);border-radius:11px;padding:15px;}
#page-admin .kpi .v{font-size:26px;font-weight:700;color:var(--color-text-primary,#fff);line-height:1.1;}
#page-admin .kpi .l{font-size:11px;color:var(--color-text-secondary,#9aa);margin-top:5px;text-transform:uppercase;letter-spacing:.4px;}
#page-admin .kpi.alert{border-color:#e5091455;background:#e5091412;}
#page-admin .kpi.alert .v{color:#ff6b6b;}
#page-admin .kpi.ok .v{color:#3ecf8e;}
#page-admin .admin-block{margin-bottom:30px;}
#page-admin .admin-block h2{font-size:15px;font-weight:600;margin:0 0 10px;color:var(--color-text-primary,#fff);}
#page-admin table{width:100%;border-collapse:collapse;font-size:13px;}
#page-admin th,#page-admin td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--color-border,#20202a);white-space:nowrap;}
#page-admin th{color:var(--color-text-secondary,#9aa);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.4px;}
#page-admin td.num{text-align:right;font-variant-numeric:tabular-nums;}
#page-admin tr.bad{background:#e5091412;}
#page-admin .badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;}
#page-admin .badge.red{background:#e5091422;color:#ff6b6b;}
#page-admin .badge.green{background:#3ecf8e22;color:#3ecf8e;}
#page-admin .badge.gray{background:#8884;color:#bbb;}
#page-admin .badge.amber{background:#f5a62322;color:#f5c15a;}
#page-admin .badge.blue{background:#4a9eff22;color:#7ab8ff;}
#page-admin tr.group-start td{border-top:2px solid var(--color-border,#2a2a38);}
#page-admin .pname{font-weight:600;}
#page-admin .pacct{font-size:11px;color:var(--color-text-secondary,#9aa);}
#page-admin .ssub{font-size:12px;color:var(--color-text-secondary,#9aa);margin:-4px 0 12px;}
#page-admin .resync-btn{background:var(--color-bg-secondary,#181820);color:#a9bcff;border:1px solid var(--color-border,#2a2a38);border-radius:6px;padding:2px 9px;cursor:pointer;font-size:12px;white-space:nowrap;}
#page-admin .resync-btn:disabled{opacity:.5;cursor:default;}
#page-admin .bar{height:6px;border-radius:3px;background:#2a2a34;overflow:hidden;min-width:60px;display:inline-block;vertical-align:middle;margin-right:6px;}
#page-admin .bar>i{display:block;height:100%;background:#3ecf8e;}
#page-admin .admin-err{color:#ff6b6b;padding:10px;}
#page-admin .scroll{overflow-x:auto;}
#page-admin .card{background:var(--color-bg-secondary,#16161c);border:1px solid var(--color-border,#242430);border-radius:12px;padding:18px 20px;}
#page-admin .users-controls{display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap;}
#page-admin .users-controls input,#page-admin .users-controls select{background:var(--color-bg-secondary,#16161c);border:1px solid var(--color-border,#2a2a38);color:var(--color-text-primary,#fff);border-radius:8px;padding:8px 12px;font-size:13px;}
#page-admin .users-controls input{min-width:240px;flex:1;max-width:380px;}
#page-admin .users-pager{display:flex;align-items:center;gap:14px;margin-top:12px;}
#page-admin .users-pager button{background:var(--color-bg-secondary,#181820);color:var(--color-text-primary,#fff);border:1px solid var(--color-border,#2a2a38);border-radius:8px;padding:6px 12px;cursor:pointer;font-size:13px;}
#page-admin .users-pager button:disabled{opacity:.4;cursor:default;}
#page-admin .users-pager span{color:var(--color-text-secondary,#9aa);font-size:13px;font-variant-numeric:tabular-nums;}
#page-admin tr.user-row{cursor:pointer;}
#page-admin tr.user-row:hover{background:#ffffff0d;}
#page-admin .crm-back{background:none;border:0;color:#a9bcff;cursor:pointer;font-size:13px;padding:0;margin-bottom:12px;}
#page-admin .fiche-head{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:4px;}
#page-admin .fiche-avatar{width:46px;height:46px;border-radius:50%;background:linear-gradient(135deg,#5b7cfa,#a855f7);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:#fff;flex-shrink:0;}
#page-admin .fiche-title{font-size:20px;font-weight:700;color:#fff;word-break:break-all;}
#page-admin .umeta{color:var(--color-text-secondary,#9aa);font-size:12px;margin:6px 0 20px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
#page-admin .fiche-grid{display:grid;grid-template-columns:1fr;gap:18px;}
#page-admin .soon{color:#66707e;font-size:13px;font-style:italic;}
#page-admin .tag-row{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;}
#page-admin .tag-chip .crm-tag-remove{background:none;border:0;color:inherit;cursor:pointer;font-size:12px;padding:0 0 0 3px;opacity:.7;}
#page-admin .tag-chip .crm-tag-remove:hover{opacity:1;}
#page-admin .tag-add-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
#page-admin .tag-add-chip{background:#ffffff0d;border:1px dashed var(--color-border,#2a2a38);color:#9aa;border-radius:20px;padding:2px 9px;font-size:11px;cursor:pointer;}
#page-admin .tag-add-chip:hover{color:#fff;border-color:#5b7cfa;}
#page-admin .note-add{display:flex;gap:8px;margin-bottom:12px;}
#page-admin .note-add textarea{flex:1;background:var(--color-bg-primary,#0d0d0f);border:1px solid var(--color-border,#2a2a38);color:#fff;border-radius:8px;padding:8px 10px;font-size:13px;resize:vertical;font-family:inherit;}
#page-admin .note-add button{align-self:flex-start;background:#5b7cfa;color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer;font-weight:600;font-size:13px;}
#page-admin .note-item{border-top:1px solid var(--color-border,#20202a);padding:9px 0;}
#page-admin .note-body{color:var(--color-text-primary,#e8e8ee);font-size:13px;white-space:pre-wrap;word-break:break-word;}
#page-admin .note-meta{color:#66707e;font-size:11px;margin-top:3px;}
#page-admin .note-meta .crm-note-del{background:none;border:0;color:#ff6b6b88;cursor:pointer;font-size:11px;margin-left:8px;}
#page-admin .note-meta .crm-note-del:hover{color:#ff6b6b;}
#page-admin .tl{display:flex;flex-direction:column;}
#page-admin .tl-item{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--color-border,#1b1b24);}
#page-admin .tl-ic{width:22px;text-align:center;}
#page-admin .tl-sum{flex:1;font-size:13px;color:var(--color-text-primary,#e8e8ee);}
#page-admin .tl-at{color:#66707e;font-size:11px;white-space:nowrap;}
#page-admin .audit-row[data-user-id]{cursor:pointer;}
#page-admin .audit-row[data-user-id]:hover{background:#ffffff0a;}
#page-admin .alert-card{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:var(--color-bg-secondary,#16161c);border:1px solid #e5091433;border-left:3px solid #e50914;border-radius:9px;padding:11px 14px;margin-bottom:8px;}
#page-admin .alert-card[data-user-id]{cursor:pointer;}
#page-admin .alert-card[data-user-id]:hover{background:#e5091412;}
#page-admin .alert-card .al-name{font-weight:600;color:var(--color-text-primary,#fff);}
#page-admin .alert-card .al-owner{color:var(--color-text-secondary,#9aa);font-size:12px;}
#page-admin .alert-card .al-err{color:#ff9b9b;font-size:11px;font-family:monospace;}
#page-admin .act-row{display:flex;flex-wrap:wrap;gap:10px;}
#page-admin .act-btn{background:var(--color-bg-primary,#0d0d0f);border:1px solid var(--color-border,#2a2a38);color:var(--color-text-primary,#fff);border-radius:8px;padding:9px 14px;cursor:pointer;font-size:13px;font-weight:600;}
#page-admin .act-btn:hover{border-color:#5b7cfa;}
#page-admin .act-btn:disabled{opacity:.5;cursor:default;}
#page-admin .act-btn.act-danger{color:#ff6b6b;border-color:#e5091433;}
#page-admin .act-btn.act-danger:hover{border-color:#e50914;background:#e5091412;}
#page-admin .act-btn.act-unsuspend{color:#3ecf8e;border-color:#3ecf8e33;}
#page-admin .act-btn.act-unsuspend:hover{border-color:#3ecf8e;background:#3ecf8e12;}
#page-admin .mini-btn{background:none;border:1px solid var(--color-border,#2a2a38);color:#9aa;border-radius:6px;padding:1px 8px;cursor:pointer;font-size:12px;margin-left:8px;vertical-align:middle;}
#page-admin .mini-btn:hover{color:#fff;border-color:#5b7cfa;}
#page-admin .flag-row{display:flex;align-items:center;gap:13px;padding:11px 0;border-bottom:1px solid var(--color-border,#20202a);}
#page-admin .flag-meta{flex:1;min-width:0;}
#page-admin .flag-key{font-weight:600;font-family:monospace;font-size:13px;color:#e8e8ee;}
#page-admin .flag-desc{font-size:12px;color:#9aa;}
#page-admin .flag-del{background:none;border:0;color:#ff6b6b88;cursor:pointer;font-size:19px;line-height:1;}
#page-admin .flag-del:hover{color:#ff6b6b;}
#page-admin .flag-add{margin-top:12px;}
#page-admin .switch{position:relative;display:inline-block;width:40px;height:22px;flex-shrink:0;}
#page-admin .switch input{opacity:0;width:0;height:0;}
#page-admin .switch .slider{position:absolute;inset:0;background:#3a3a44;border-radius:22px;transition:.2s;cursor:pointer;}
#page-admin .switch .slider:before{content:"";position:absolute;height:16px;width:16px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.2s;}
#page-admin .switch input:checked+.slider{background:#3ecf8e;}
#page-admin .switch input:checked+.slider:before{transform:translateX(18px);}
@media(max-width:900px){
  #page-admin .crm-sidebar{width:60px;padding:14px 8px;}
  #page-admin .crm-nav-item .lb,#page-admin .crm-brand span:last-child,#page-admin .crm-side-foot{display:none;}
  #page-admin .crm-page{padding:20px 16px 80px;}
}
</style>
<div class="crm-shell">
  <aside class="crm-sidebar">
    <div class="crm-brand"><span class="dot"></span><span>Norva CRM</span></div>
    <nav id="crm-nav">${nav}</nav>
    <div class="crm-side-foot">Admin · accès restreint<br>rôle app_metadata.role</div>
  </aside>
  <main class="crm-main">
    <div class="crm-topbar">
      <span class="crm-crumb" id="crm-crumb">Cockpit</span>
      <span class="crm-spacer"></span>
      <span id="crm-ts"></span>
      <button id="crm-refresh">↻ Rafraîchir</button>
    </div>
    <div id="crm-view"></div>
  </main>
</div>`;
        // Delegated handlers on the stable root: sidebar nav, refresh, re-sync buttons, client rows.
        root.addEventListener('click', (e) => {
            const navItem = e.target.closest('.crm-nav-item');
            if (navItem) { this._navigate(navItem.dataset.route); return; }
            if (e.target.closest('#crm-refresh')) { this._navigate(this._route); return; }
            const b = e.target.closest('.resync-btn');
            if (b) { e.preventDefault(); this._resync(b); return; }
            const ur = e.target.closest('.user-row');
            if (ur && !e.target.closest('button,a')) { this._navigate('client:' + ur.dataset.userId); return; }
            const ac = e.target.closest('.alert-card[data-user-id]');
            if (ac) { this._navigate('client:' + ac.dataset.userId); return; }
            const au = e.target.closest('.audit-row[data-user-id]');
            if (au) { this._navigate('client:' + au.dataset.userId); return; }
            if (e.target.closest('.crm-back')) { this._navigate('clients'); return; }
            // Fiche relational actions
            const tRem = e.target.closest('.crm-tag-remove');
            if (tRem) { this._crmMutate('admin_tag_toggle', { p_user_id: this._crmUser, p_tag_id: tRem.dataset.tagId, p_on: false }); return; }
            const tAdd = e.target.closest('.crm-tag-add');
            if (tAdd) { this._crmMutate('admin_tag_toggle', { p_user_id: this._crmUser, p_tag_id: tAdd.dataset.tagId, p_on: true }); return; }
            if (e.target.closest('.crm-tag-create')) { this._crmCreateTag(); return; }
            if (e.target.closest('.crm-note-add')) { this._crmAddNote(); return; }
            const nDel = e.target.closest('.crm-note-del');
            if (nDel) { this._crmMutate('admin_note_delete', { p_note_id: nDel.dataset.noteId }); return; }
            const actBtn = e.target.closest('.act-btn');
            if (actBtn) { this._userAction(actBtn); return; }
            if (e.target.closest('#sys-infra-refresh')) { this._loadInfra(); return; }
            if (e.target.closest('.flag-create')) { this._flagCreate(); return; }
            const fDel = e.target.closest('.flag-del');
            if (fDel) {
                if (window.confirm(`Supprimer le flag « ${fDel.dataset.key} » ?`)) {
                    this._rpc('admin_flag_delete', { p_key: fDel.dataset.key }).then(() => this._loadFlags()).catch(err => window.alert('Erreur : ' + err.message));
                }
                return;
            }
        });
        // Feature-flag switches fire 'change', not 'click' — delegate separately.
        root.addEventListener('change', (e) => {
            const ft = e.target.closest('.flag-toggle');
            if (ft) this._flagToggle(ft);
        });
        this.built = true;
    }

    _setCrumb(text, ts) {
        const c = document.getElementById('crm-crumb'); if (c) c.textContent = text;
        const t = document.getElementById('crm-ts');
        if (t) t.textContent = ts ? ('snapshot · ' + new Date(ts).toLocaleTimeString('fr-FR') + ' · auto 5 min') : '';
    }
    _setActiveNav(route) {
        document.querySelectorAll('#page-admin .crm-nav-item').forEach(el =>
            el.classList.toggle('active', el.dataset.route === (route.startsWith('client') ? 'clients' : route)));
    }
    _view() { return document.getElementById('crm-view'); }

    _navigate(route) {
        this._route = route;
        this._setActiveNav(route);
        if (route === 'cockpit') this._pageCockpit();
        else if (route === 'clients') this._pageClients();
        else if (route.startsWith('client:')) this._pageClientDetail(route.slice(7));
        else if (route === 'providers') this._pageProviders();
        else if (route === 'moteur') this._pageMoteur();
        else if (route === 'systeme') this._pageSysteme();
        else this._pageCockpit();
    }

    // ── Page: Cockpit ──
    async _pageCockpit() {
        this._setCrumb('Cockpit', this._lastTs);
        const v = this._view();
        v.innerHTML = `<div class="crm-page">
            <h1 class="crm-h1">🎯 Cockpit</h1>
            <p class="crm-sub">Santé de l'écosystème Norva en un coup d'œil.</p>
            <section id="admin-overview" class="kpi-groups"><div class="ssub">Chargement…</div></section>
            <div class="admin-block"><h2>🚨 Alertes</h2><div id="admin-alerts"><div class="ssub">Chargement…</div></div></div>
        </div>`;
        try {
            const [o, sources] = await Promise.all([this._rpc('admin_overview'), this._rpc('admin_sources')]);
            this._lastTs = o && o.refreshed_at ? o.refreshed_at : this._lastTs;
            this._setCrumb('Cockpit', this._lastTs);
            this._renderOverview(o);
            this._renderAlerts(Array.isArray(sources) ? sources : []);
        } catch (e) {
            const el = document.getElementById('admin-overview');
            if (el) el.innerHTML = `<div class="admin-err">Erreur : ${AdminPage.esc(e.message)}</div>`;
        }
    }

    _renderAlerts(sources) {
        const el = document.getElementById('admin-alerts');
        if (!el) return;
        const problems = sources.filter(s => s.incomplete === true || s.sync_error || s.sync_status === 'sync_error');
        if (!problems.length) { el.innerHTML = '<div class="card"><span class="badge green">✓</span> Aucune alerte — tout est sain.</div>'; return; }
        el.innerHTML = problems.map(s => {
            const kind = s.incomplete === true ? 'sync incomplète' : (s.sync_status || 'erreur');
            const uid = s.user_id ? ` alert-card" data-user-id="${AdminPage.esc(s.user_id)}` : '"';
            return `<div class="alert-card${uid}" title="${s.user_id ? 'Ouvrir la fiche client' : ''}">
                <span class="badge red">${AdminPage.esc(kind)}</span>
                <span class="al-name">${AdminPage.esc(s.display_name)}</span>
                <span class="al-owner">${AdminPage.esc(s.owner_email || '')}</span>
                ${s.sync_error ? `<span class="al-err">${AdminPage.esc(String(s.sync_error).slice(0, 80))}</span>` : ''}
            </div>`;
        }).join('');
    }

    // ── Page: Clients (list) ──
    _pageClients() {
        this._setCrumb('Clients');
        const v = this._view();
        v.innerHTML = `<div class="crm-page">
            <h1 class="crm-h1">👥 Clients</h1>
            <p class="crm-sub">Liste paginée — recherche, tri, clic pour la fiche 360°. Agrégation bornée par page (scalable).</p>
            <div class="users-controls">
              <input id="admin-users-search" type="search" placeholder="Rechercher un email…" autocomplete="off" value="${AdminPage.esc(this._users.search)}" />
              <select id="admin-users-sort">
                <option value="created_desc">Plus récents</option>
                <option value="created_asc">Plus anciens</option>
                <option value="active_desc">Dernière activité</option>
                <option value="email_asc">Email A→Z</option>
              </select>
              <select id="admin-users-tag"><option value="">Tous les segments</option></select>
            </div>
            <div class="scroll"><div id="admin-users"></div></div>
            <div class="users-pager">
              <button id="admin-users-prev">← Précédent</button>
              <span id="admin-users-range"></span>
              <button id="admin-users-next">Suivant →</button>
            </div>
        </div>`;
        const sortSel = document.getElementById('admin-users-sort');
        if (sortSel) sortSel.value = this._users.sort;
        // Wire controls (re-created on each navigation to this page).
        const usearch = document.getElementById('admin-users-search');
        if (usearch) usearch.addEventListener('input', () => {
            clearTimeout(this._usersDebounce);
            this._usersDebounce = setTimeout(() => {
                this._users.search = usearch.value.trim(); this._users.page = 0; this._loadUsers();
            }, 300);
        });
        if (sortSel) sortSel.addEventListener('change', () => {
            this._users.sort = sortSel.value; this._users.page = 0; this._loadUsers();
        });
        const tagSel = document.getElementById('admin-users-tag');
        if (tagSel) {
            this._fillTagOptions(tagSel);
            tagSel.addEventListener('change', () => { this._users.tagId = tagSel.value; this._users.page = 0; this._loadUsers(); });
        }
        const prev = document.getElementById('admin-users-prev');
        if (prev) prev.addEventListener('click', () => { if (this._users.page > 0) { this._users.page -= 1; this._loadUsers(); } });
        const next = document.getElementById('admin-users-next');
        if (next) next.addEventListener('click', () => {
            const s = this._users; if ((s.page + 1) * s.limit < s.total) { s.page += 1; this._loadUsers(); }
        });
        this._loadUsers();
    }

    async _loadUsers() {
        const el = document.getElementById('admin-users');
        const range = document.getElementById('admin-users-range');
        if (!el) return;
        const s = this._users;
        if (range) range.textContent = '…';
        try {
            const res = await this._rpc('admin_users_page', {
                p_limit: s.limit, p_offset: s.page * s.limit, p_search: s.search || null,
                p_sort: s.sort, p_tag_id: s.tagId || null
            });
            const rows = (res && Array.isArray(res.rows)) ? res.rows : [];
            s.total = Number(res && res.total) || 0;
            if (res && Array.isArray(res.all_tags)) { this._allTags = res.all_tags; this._fillTagOptions(document.getElementById('admin-users-tag')); }
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

    _fillTagOptions(sel) {
        if (!sel) return;
        const cur = this._users.tagId || '';
        sel.innerHTML = '<option value="">Tous les segments</option>' +
            this._allTags.map(t => `<option value="${AdminPage.esc(t.id)}">${AdminPage.esc(t.label)}</option>`).join('');
        sel.value = cur;
    }

    _renderUsers(rows) {
        const el = document.getElementById('admin-users');
        if (!el) return;
        if (!rows.length) { el.innerHTML = '<div class="ssub">Aucun utilisateur.</div>'; return; }
        const head = `<tr><th>Email</th><th>Rôle</th><th>Segments</th><th class="num">Sources</th><th>Inscrit</th><th>Dernière activité</th><th>Email vérifié</th></tr>`;
        const day = (d) => d ? new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
        const body = rows.map(r => {
            const role = r.role === 'admin' ? '<span class="badge amber">admin</span>' : '<span class="badge gray">user</span>';
            const driver = r.is_driver ? ' <span class="badge blue" title="Compte pilote d\'enrichissement">pilote</span>' : '';
            const conf = r.email_confirmed ? '<span class="badge green">✓</span>' : '<span class="badge red">non</span>';
            const tags = (Array.isArray(r.tags) ? r.tags : [])
                .map(t => `<span class="badge ${AdminPage.tagColor(t.color)}">${AdminPage.esc(t.label)}</span>`).join(' ') || '<span class="ssub">—</span>';
            const last = r.last_sign_in_at
                ? `<span title="${AdminPage.esc(new Date(r.last_sign_in_at).toLocaleString('fr-FR'))}">${AdminPage.esc(AdminPage.timeAgo(r.last_sign_in_at))}</span>`
                : '<span class="badge gray">jamais</span>';
            return `<tr class="user-row" data-user-id="${AdminPage.esc(r.user_id)}" data-email="${AdminPage.esc(r.email || '')}" title="Voir la fiche">
                <td>${AdminPage.esc(r.email || '—')}${driver}</td>
                <td>${role}</td>
                <td>${tags}</td>
                <td class="num">${AdminPage.n(r.sources_count)}</td>
                <td>${AdminPage.esc(day(r.created_at))}</td>
                <td>${last}</td>
                <td>${conf}</td>
            </tr>`;
        }).join('');
        el.innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
    }

    // ── Page: Client detail (fiche 360°, full page) ──
    async _pageClientDetail(userId) {
        this._crmUser = userId;
        this._setCrumb('Clients › fiche');
        const v = this._view();
        v.innerHTML = `<div class="crm-page">
            <button class="crm-back">← Retour aux clients</button>
            <div id="fiche-body"><div class="ssub">Chargement…</div></div>
        </div>`;
        try {
            const d = await this._rpc('admin_user_detail', { p_user_id: userId });
            this._renderFiche(d);
            this._loadCrm(userId);   // relational panels (tags/notes/timeline), non-blocking
        } catch (e) {
            const b = document.getElementById('fiche-body');
            if (b) b.innerHTML = `<div class="admin-err">Erreur : ${AdminPage.esc(e.message)}</div>`;
        }
    }

    // ── CRM relational panels (tags / notes / timeline) ──
    async _loadCrm(userId) {
        try {
            this._crm = await this._rpc('admin_client_crm', { p_user_id: userId }) || {};
            this._renderCrm();
        } catch (e) {
            ['fiche-tags', 'fiche-notes', 'fiche-timeline'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.innerHTML = `<div class="admin-err">Erreur : ${AdminPage.esc(e.message)}</div>`;
            });
        }
    }

    _renderCrm() {
        const c = this._crm || {};
        const tags = Array.isArray(c.tags) ? c.tags : [];
        const all = Array.isArray(c.all_tags) ? c.all_tags : [];
        const notes = Array.isArray(c.notes) ? c.notes : [];
        const timeline = Array.isArray(c.timeline) ? c.timeline : [];
        const applied = new Set(tags.map(t => t.id));

        const tagsEl = document.getElementById('fiche-tags');
        if (tagsEl) {
            const cur = tags.length
                ? tags.map(t => `<span class="badge ${AdminPage.tagColor(t.color)} tag-chip">${AdminPage.esc(t.label)} <button class="crm-tag-remove" data-tag-id="${AdminPage.esc(t.id)}" title="Retirer">×</button></span>`).join('')
                : '<span class="ssub">Aucun tag.</span>';
            const avail = all.filter(t => !applied.has(t.id))
                .map(t => `<button class="crm-tag-add tag-add-chip" data-tag-id="${AdminPage.esc(t.id)}">+ ${AdminPage.esc(t.label)}</button>`).join('');
            tagsEl.innerHTML = `<div class="tag-row">${cur}</div><div class="tag-add-row">${avail}<button class="crm-tag-create tag-add-chip">＋ créer</button></div>`;
        }

        const notesEl = document.getElementById('fiche-notes');
        if (notesEl) {
            const list = notes.length
                ? notes.map(n => `<div class="note-item"><div class="note-body">${AdminPage.esc(n.body)}</div>
                    <div class="note-meta">${AdminPage.esc(n.author_email || 'admin')} · ${AdminPage.esc(AdminPage.timeAgo(n.created_at))}
                    <button class="crm-note-del" data-note-id="${AdminPage.esc(n.id)}" title="Supprimer">supprimer</button></div></div>`).join('')
                : '<div class="ssub">Aucune note.</div>';
            notesEl.innerHTML = `<div class="note-add"><textarea id="crm-note-input" rows="2" placeholder="Ajouter une note interne…"></textarea><button class="crm-note-add">Ajouter</button></div>${list}`;
        }

        const tlEl = document.getElementById('fiche-timeline');
        if (tlEl) {
            const icon = (k) => ({ signup: '🎉', provider_added: '📡', sync: '🔄', sync_started: '▶️', sync_done: '✅', sync_failed: '⚠️', note_added: '📝', tag_added: '🏷️', tag_removed: '🏷️', resync: '↻', admin_action: '⚡' }[k] || '•');
            tlEl.innerHTML = timeline.length
                ? '<div class="tl">' + timeline.map(e => `<div class="tl-item"><span class="tl-ic">${icon(e.kind)}</span><span class="tl-sum">${AdminPage.esc(e.summary)}</span><span class="tl-at" title="${e.at ? AdminPage.esc(new Date(e.at).toLocaleString('fr-FR')) : ''}">${e.at ? AdminPage.esc(AdminPage.timeAgo(e.at)) : ''}</span></div>`).join('') + '</div>'
                : '<div class="ssub">Aucun événement.</div>';
        }
    }

    // Privileged user actions → norva-admin edge (service-role, admin-JWT-gated).
    async _userAction(btn) {
        const uid = btn.dataset.userId;
        if (!uid || btn.disabled) return;
        let path, body = {};
        if (btn.classList.contains('act-resend')) { path = `user/${uid}/resend-confirmation`; }
        else if (btn.classList.contains('act-role')) {
            const role = btn.dataset.role;
            if (!window.confirm(`Changer le rôle de cet utilisateur en « ${role} » ?`)) return;
            path = `user/${uid}/role`; body = { role };
        } else if (btn.classList.contains('act-suspend')) {
            const suspend = btn.dataset.suspend === 'true';
            if (!window.confirm(suspend ? 'Suspendre ce compte ? Il ne pourra plus se connecter.' : 'Réactiver ce compte ?')) return;
            path = `user/${uid}/suspend`; body = { suspend };
        } else return;
        const orig = btn.textContent;
        btn.disabled = true; btn.textContent = '…';
        try {
            const res = await fetch(`${this._sbUrl()}/functions/v1/norva-admin/${path}`, {
                method: 'POST',
                headers: { apikey: this._sbKey(), Authorization: `Bearer ${this._token()}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || String(res.status));
            if (data.message) window.alert(data.message);
            this._navigate('client:' + uid);   // reload fiche to reflect the new state
        } catch (e) {
            btn.textContent = '✗ ' + AdminPage.esc(e.message);
            setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000);
        }
    }

    async _crmMutate(fn, params) {
        try { await this._rpc(fn, params); await this._loadCrm(this._crmUser); }
        catch (e) { window.alert('Erreur : ' + e.message); }
    }
    async _crmAddNote() {
        const ta = document.getElementById('crm-note-input');
        const body = ta ? ta.value.trim() : '';
        if (!body) return;
        await this._crmMutate('admin_note_add', { p_user_id: this._crmUser, p_body: body });
    }
    async _crmCreateTag() {
        const label = (window.prompt('Nom du tag / segment :') || '').trim();
        if (!label) return;
        const color = (window.prompt('Couleur : gray, green, red, amber ou blue', 'blue') || 'blue').trim();
        try {
            const t = await this._rpc('admin_tag_create', { p_label: label, p_color: color });
            if (t && t.id) await this._rpc('admin_tag_toggle', { p_user_id: this._crmUser, p_tag_id: t.id, p_on: true });
            await this._loadCrm(this._crmUser);
        } catch (e) { window.alert('Erreur : ' + e.message); }
    }

    _renderFiche(d) {
        const body = document.getElementById('fiche-body');
        if (!body) return;
        const u = (d && d.user) || {};
        const sources = (d && Array.isArray(d.sources)) ? d.sources : [];
        const enrich = (d && Array.isArray(d.enrichment)) ? d.enrichment : [];
        const email = u.email || 'Utilisateur';
        this._setCrumb('Clients › ' + email);
        const day = (x) => x ? new Date(x).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
        const role = u.role === 'admin' ? '<span class="badge amber">admin</span>' : '<span class="badge gray">user</span>';
        const driver = u.is_driver ? '<span class="badge blue">pilote</span>' : '';
        const conf = u.email_confirmed ? '<span class="badge green">email vérifié</span>' : '<span class="badge red">email non vérifié</span>';
        const banned = u.banned ? '<span class="badge red">suspendu</span>' : '';
        const initial = (email[0] || '?').toUpperCase();
        const uid = AdminPage.esc(u.user_id);
        const roleTarget = u.role === 'admin' ? 'user' : 'admin';
        const actions = `<div class="act-row">
            ${!u.email_confirmed ? `<button class="act-btn act-resend" data-user-id="${uid}">✉️ Renvoyer la confirmation</button>` : ''}
            <button class="act-btn act-role" data-user-id="${uid}" data-role="${roleTarget}">🔑 Passer ${roleTarget}</button>
            <button class="act-btn ${u.banned ? 'act-unsuspend' : 'act-danger'} act-suspend" data-user-id="${uid}" data-suspend="${u.banned ? 'false' : 'true'}">${u.banned ? '✅ Réactiver' : '⛔ Suspendre'}</button>
        </div>`;

        let srcHtml;
        if (!sources.length) srcHtml = '<div class="ssub">Aucune source.</div>';
        else {
            const rows = sources.map(s => {
                const bad = s.incomplete === true || s.sync_error || s.sync_status === 'sync_error';
                const status = s.incomplete === true ? '<span class="badge red">sync incomplète</span>'
                    : (bad ? `<span class="badge red">${AdminPage.esc(s.sync_status || 'error')}</span>`
                        : `<span class="badge green">${AdminPage.esc(s.sync_status || 'ready')}</span>`);
                return `<tr class="${bad ? 'bad' : ''}">
                    <td>${AdminPage.esc(s.display_name)}</td>
                    <td>${status}</td>
                    <td class="num">${AdminPage.n(s.media_items)}</td>
                    <td class="num">${AdminPage.n(s.variants)}</td>
                    <td class="num">${AdminPage.n(s.movie_titles)}</td>
                    <td class="num">${AdminPage.n(s.series_titles)}</td>
                    <td>${s.identity_name ? AdminPage.esc(s.identity_name) : '<span class="badge gray">non résolue</span>'}</td>
                    <td>${s.last_synced_at ? AdminPage.esc(AdminPage.timeAgo(s.last_synced_at)) : '—'}</td>
                    <td><button class="resync-btn" data-source="${AdminPage.esc(s.source_id)}" title="Forcer un re-sync complet">↻ re-sync</button></td>
                </tr>`;
            }).join('');
            srcHtml = `<table><thead><tr><th>Provider</th><th>Statut</th><th class="num">Items</th><th class="num">Variants</th><th class="num">Films</th><th class="num">Séries</th><th>Identité</th><th>Dernier sync</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table>`;
        }

        let enrHtml;
        if (!enrich.length) enrHtml = '<div class="ssub">Aucun titre enrichi (pas de VOD ou catalogue vide).</div>';
        else {
            const rows = enrich.map(r => `<tr>
                <td>${AdminPage.esc(r.panel)}</td>
                <td>${r.item_type === 'series' ? 'séries' : 'films'}</td>
                <td class="num">${AdminPage.n(r.total)}</td>
                <td class="num"><span class="bar"><i style="width:${Math.min(100, Number(r.resolved_pct) || 0)}%"></i></span>${AdminPage.n(r.resolved)} (${r.resolved_pct == null ? 0 : r.resolved_pct}%)</td>
                <td class="num">${AdminPage.n(r.never_probed)}</td>
                <td class="num">${AdminPage.n(r.probed_24h)}</td>
                <td class="num">${AdminPage.n(r.subtitle_found)}</td>
            </tr>`).join('');
            enrHtml = `<table><thead><tr><th>Panel</th><th>Type</th><th class="num">Total</th><th class="num">Audio résolu</th><th class="num">Jamais sondé</th><th class="num">Sondé 24h</th><th class="num">ST trouvés</th></tr></thead><tbody>${rows}</tbody></table>`;
        }

        body.innerHTML = `
            <div class="fiche-head">
              <div class="fiche-avatar">${AdminPage.esc(initial)}</div>
              <div><div class="fiche-title">${AdminPage.esc(email)}</div>
              <div class="umeta">${role} ${driver} ${conf} ${banned}
                <span>· inscrit ${AdminPage.esc(day(u.created_at))}</span>
                <span>· dernière activité ${u.last_sign_in_at ? AdminPage.esc(AdminPage.timeAgo(u.last_sign_in_at)) : 'jamais'}</span>
                ${u.auth_provider ? `<span>· via ${AdminPage.esc(u.auth_provider)}</span>` : ''}</div></div>
            </div>
            <div class="fiche-grid">
              <div class="admin-block"><h2>⚡ Actions</h2><div class="card">${actions}</div></div>
              <div class="admin-block"><h2>📡 Sources (${sources.length})</h2><div class="scroll">${srcHtml}</div></div>
              <div class="admin-block"><h2>⚙️ Enrichissement audio par panel</h2><div class="scroll">${enrHtml}</div></div>
              <div class="admin-block"><h2>🏷️ Tags & segments</h2><div id="fiche-tags" class="card"><div class="ssub">Chargement…</div></div></div>
              <div class="admin-block"><h2>📝 Notes internes</h2><div id="fiche-notes" class="card"><div class="ssub">Chargement…</div></div></div>
              <div class="admin-block"><h2>🕑 Timeline d'activité</h2><div id="fiche-timeline" class="card"><div class="ssub">Chargement…</div></div></div>
            </div>`;
    }

    // ── Page: Providers ──
    async _pageProviders() {
        this._setCrumb('Providers', this._lastTs);
        const v = this._view();
        v.innerHTML = `<div class="crm-page">
            <h1 class="crm-h1">📡 Providers / Sources</h1>
            <p class="crm-sub">Panels pilotes + sources en problème (sync incomplète / erreur) — borné à l'échelle.</p>
            <div class="scroll"><div id="admin-sources"><div class="ssub">Chargement…</div></div></div>
        </div>`;
        try {
            const sources = await this._rpc('admin_sources');
            this._renderSources(Array.isArray(sources) ? sources : []);
        } catch (e) {
            const el = document.getElementById('admin-sources');
            if (el) el.innerHTML = `<div class="admin-err">Erreur : ${AdminPage.esc(e.message)}</div>`;
        }
    }

    // ── Page: Moteur (enrichment + crons) ──
    async _pageMoteur() {
        this._setCrumb('Moteur', this._lastTs);
        const v = this._view();
        v.innerHTML = `<div class="crm-page">
            <h1 class="crm-h1">⚙️ Moteur d'enrichissement</h1>
            <p class="crm-sub">Couverture par panel (comptes pilotes) + crons jour/nuit.</p>
            <div class="admin-block"><h2>Enrichissement par panel</h2><div class="scroll"><div id="admin-enrich"><div class="ssub">Chargement…</div></div></div></div>
            <div class="admin-block"><h2>⏱️ Crons</h2><div class="scroll"><div id="admin-cron"></div></div></div>
        </div>`;
        try {
            const [enrich, cron] = await Promise.all([
                this._rpc('admin_enrichment_coverage'),
                this._rpc('admin_cron_health')
            ]);
            this._renderEnrich(Array.isArray(enrich) ? enrich : []);
            this._renderCron(Array.isArray(cron) ? cron : []);
        } catch (e) {
            const el = document.getElementById('admin-enrich');
            if (el) el.innerHTML = `<div class="admin-err">Erreur : ${AdminPage.esc(e.message)}</div>`;
        }
    }

    // ── Page: Système (snapshot health + admin audit feed) ──
    async _pageSysteme() {
        this._setCrumb('Système', this._lastTs);
        const v = this._view();
        v.innerHTML = `<div class="crm-page">
            <h1 class="crm-h1">🛡️ Système & Audit</h1>
            <p class="crm-sub">Santé du snapshot & infra temps réel · feature flags · journal d'audit.</p>
            <div class="kpi-gtitle">📸 Snapshot</div>
            <section id="sys-health" class="admin-cards"><div class="ssub">Chargement…</div></section>
            <div class="admin-block"><h2>🌐 Infra temps réel <button id="sys-infra-refresh" class="mini-btn" title="Re-ping">↻</button></h2><div id="sys-infra" class="admin-cards"><div class="ssub">Ping…</div></div></div>
            <div class="admin-block"><h2>🚩 Feature flags</h2><div id="sys-flags"><div class="ssub">Chargement…</div></div></div>
            <div class="admin-block"><h2>📜 Journal d'audit</h2><div id="sys-audit"><div class="ssub">Chargement…</div></div></div>
        </div>`;
        try {
            const [o, feed] = await Promise.all([this._rpc('admin_overview'), this._rpc('admin_audit_feed', { p_limit: 80 })]);
            this._lastTs = o && o.refreshed_at ? o.refreshed_at : this._lastTs;
            this._setCrumb('Système', this._lastTs);
            this._renderSysHealth(o);
            this._renderAudit(Array.isArray(feed) ? feed : []);
        } catch (e) {
            const el = document.getElementById('sys-health');
            if (el) el.innerHTML = `<div class="admin-err">Erreur : ${AdminPage.esc(e.message)}</div>`;
        }
        this._loadInfra();
        this._loadFlags();
    }

    async _loadInfra() {
        const el = document.getElementById('sys-infra');
        if (!el) return;
        el.innerHTML = '<div class="ssub">Ping…</div>';
        try {
            const res = await fetch(`${this._sbUrl()}/functions/v1/norva-admin/health`, {
                method: 'POST',
                headers: { apikey: this._sbKey(), Authorization: `Bearer ${this._token()}`, 'Content-Type': 'application/json' },
                body: '{}'
            });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(d.error || String(res.status));
            this._renderInfra(d);
        } catch (e) { el.innerHTML = `<div class="admin-err">Erreur : ${AdminPage.esc(e.message)}</div>`; }
    }

    _renderInfra(d) {
        const el = document.getElementById('sys-infra');
        if (!el) return;
        const svc = (label, s) => {
            s = s || {};
            if (s.configured === false) return `<div class="kpi"><div class="v" style="font-size:15px;color:#9aa">non configuré</div><div class="l">${label}</div></div>`;
            const up = s.ok === true;
            return `<div class="kpi ${up ? 'ok' : 'alert'}"><div class="v" style="font-size:17px">${up ? `🟢 ${AdminPage.n(s.ms)} ms` : '🔴 down'}</div><div class="l">${label}${s.status ? ` · ${s.status}` : ''}</div></div>`;
        };
        el.innerHTML = [svc('Edge', d.edge), svc('Base de données', d.db), svc('Gateway', d.gateway), svc('Relay', d.relay)].join('');
    }

    async _loadFlags() {
        const el = document.getElementById('sys-flags');
        if (!el) return;
        try {
            const flags = await this._rpc('admin_flags_list');
            this._renderFlags(Array.isArray(flags) ? flags : []);
        } catch (e) { el.innerHTML = `<div class="admin-err">Erreur : ${AdminPage.esc(e.message)}</div>`; }
    }

    _renderFlags(flags) {
        const el = document.getElementById('sys-flags');
        if (!el) return;
        const rows = flags.map(f => `<div class="flag-row">
            <label class="switch"><input type="checkbox" class="flag-toggle" data-key="${AdminPage.esc(f.key)}" ${f.enabled ? 'checked' : ''}><span class="slider"></span></label>
            <div class="flag-meta"><div class="flag-key">${AdminPage.esc(f.key)}</div><div class="flag-desc">${AdminPage.esc(f.description || '')}${f.updated_by ? ` · ${AdminPage.esc(f.updated_by)}` : ''}</div></div>
            <button class="flag-del" data-key="${AdminPage.esc(f.key)}" title="Supprimer le flag">×</button>
        </div>`).join('');
        el.innerHTML = `${rows || '<div class="ssub">Aucun flag.</div>'}<div class="flag-add"><button class="flag-create tag-add-chip">＋ créer un flag</button></div>`;
    }

    async _flagToggle(input) {
        try { await this._rpc('admin_flag_set', { p_key: input.dataset.key, p_enabled: input.checked }); }
        catch (e) { input.checked = !input.checked; window.alert('Erreur : ' + e.message); }
    }
    async _flagCreate() {
        const key = (window.prompt('Clé du flag (a-z, 0-9, _) :') || '').trim();
        if (!key) return;
        const desc = (window.prompt('Description :') || '').trim();
        try { await this._rpc('admin_flag_create', { p_key: key, p_description: desc || null }); this._loadFlags(); }
        catch (e) { window.alert('Erreur : ' + e.message); }
    }

    _renderSysHealth(o) {
        o = o || {};
        const el = document.getElementById('sys-health');
        if (!el) return;
        const card = (val, l, cls) => `<div class="kpi ${cls || ''}"><div class="v">${val}</div><div class="l">${l}</div></div>`;
        const n = AdminPage.n;
        const fresh = o.refreshed_at && (Date.now() - new Date(o.refreshed_at).getTime()) < 12 * 60000;
        el.innerHTML = [
            card(AdminPage.esc(o.refreshed_at ? AdminPage.timeAgo(o.refreshed_at) : '—'), 'Dernier snapshot', fresh ? 'ok' : 'alert'),
            card(n(o.cron_active), 'Crons actifs', 'ok'),
            card(n(o.cron_paused), 'Crons en pause'),
            card(n(o.cron_fails_24h), 'Échecs cron 24h', Number(o.cron_fails_24h) > 0 ? 'alert' : 'ok'),
            card(n(o.sources_error), 'Sources en erreur', Number(o.sources_error) > 0 ? 'alert' : 'ok'),
            card(n(o.gensubs_processing), 'ST IA en cours'),
            card(n(o.gensubs_failed), 'ST IA échoués', Number(o.gensubs_failed) > 0 ? 'alert' : '')
        ].join('');
    }

    _renderAudit(rows) {
        const el = document.getElementById('sys-audit');
        if (!el) return;
        if (!rows.length) { el.innerHTML = '<div class="ssub">Aucune action enregistrée pour l\'instant.</div>'; return; }
        const icon = (k) => ({ note_added: '📝', tag_added: '🏷️', tag_removed: '🏷️', admin_action: '⚡', resync: '↻', signup: '🎉', sync_started: '▶️', sync_done: '✅', sync_failed: '⚠️' }[k] || '•');
        el.innerHTML = '<div class="tl">' + rows.map(e => `<div class="tl-item audit-row"${e.user_id ? ` data-user-id="${AdminPage.esc(e.user_id)}"` : ''}>
            <span class="tl-ic">${icon(e.kind)}</span>
            <span class="tl-sum">${AdminPage.esc(e.summary)}${e.client_email ? ` <span class="al-owner">· ${AdminPage.esc(e.client_email)}</span>` : ''}${e.actor ? ` <span class="ssub">par ${AdminPage.esc(e.actor)}</span>` : ''}</span>
            <span class="tl-at" title="${e.created_at ? AdminPage.esc(new Date(e.created_at).toLocaleString('fr-FR')) : ''}">${e.created_at ? AdminPage.esc(AdminPage.timeAgo(e.created_at)) : ''}</span>
        </div>`).join('') + '</div>';
    }

    // ── shared renderers ──
    _renderOverview(o) {
        o = o || {};
        const el = document.getElementById('admin-overview');
        if (!el) return;
        const card = (v, l, cls) => `<div class="kpi ${cls || ''}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
        const n = (x) => (x == null ? '—' : Number(x).toLocaleString('fr-FR'));
        const group = (title, cards) => `<div class="kpi-group"><div class="kpi-gtitle">${title}</div><div class="admin-cards">${cards.join('')}</div></div>`;
        el.innerHTML = [
            group('👥 Clients & croissance', [
                card(n(o.users_total), 'Users', o.users_active_7d ? 'ok' : ''),
                card(n(o.users_active_24h), 'Actifs 24 h'),
                card(n(o.users_active_7d), 'Actifs 7 j'),
                card(n(o.users_new_7d), 'Nouveaux 7 j', Number(o.users_new_7d) > 0 ? 'ok' : ''),
                card(n(o.users_new_30d), 'Nouveaux 30 j')
            ]),
            group('📡 Providers & catalogue', [
                card(n(o.sources_total), 'Sources'),
                card(n(o.sources_incomplete), 'Sync incomplète', Number(o.sources_incomplete) > 0 ? 'alert' : 'ok'),
                card(n(o.sources_error), 'Sources en erreur', Number(o.sources_error) > 0 ? 'alert' : 'ok'),
                card(n(o.identities_active), 'Identités'),
                card(n(o.titles_movie), 'Films'),
                card(n(o.titles_series), 'Séries')
            ]),
            group('🎬 Sous-titres IA', [
                card(n(o.gensubs_ready), 'Prêts', 'ok'),
                card(n(o.gensubs_processing), 'En cours'),
                card(n(o.gensubs_failed), 'Échoués', Number(o.gensubs_failed) > 0 ? 'alert' : '')
            ]),
            group('⏱️ Crons', [
                card(n(o.cron_active), 'Actifs', 'ok'),
                card(n(o.cron_paused), 'En pause'),
                card(n(o.cron_fails_24h), 'Échecs 24 h', Number(o.cron_fails_24h) > 0 ? 'alert' : 'ok')
            ])
        ].join('');
    }

    _renderSources(rows) {
        const el = document.getElementById('admin-sources');
        if (!el) return;
        if (!rows.length) { el.innerHTML = '<div class="ssub">Aucune source.</div>'; return; }
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
        } catch (e) {
            btn.textContent = '✗ ' + AdminPage.esc(e.message || 'err');
            setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3500);
        }
    }

    _renderEnrich(rows) {
        const el = document.getElementById('admin-enrich');
        if (!el) return;
        if (!rows.length) { el.innerHTML = '<div class="ssub">Aucune donnée.</div>'; return; }
        const barCell = (a, p) => `<td class="num"><span class="bar"><i style="width:${Math.min(100, Number(p) || 0)}%"></i></span>${AdminPage.n(a)} (${p == null ? 0 : p}%)</td>`;
        const eta = (r) => {
            if (Number(r.never_probed) === 0) {
                const undPct = Math.max(0, Math.round((100 - (Number(r.resolved_pct) || 0)) * 10) / 10);
                return `<span class="badge green" title="1ʳᵉ passe de sondage terminée : chaque titre a été sondé au moins une fois. Les ~${undPct}% non résolus sont « und » dans le conteneur (aucune langue déclarée) — seul whisper peut les résoudre.">✓ sondé</span>`;
            }
            if (Number(r.probed_24h) === 0) return '<span class="badge red">⏸ à l\'arrêt</span>';
            return `~${AdminPage.n(r.eta_days)} j`;
        };
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
    // Stored tag colour → badge class (fall back to gray for anything unexpected).
    static tagColor(c) { return ['gray', 'green', 'red', 'amber', 'blue'].includes(c) ? c : 'gray'; }
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
        else if (/^\d+$/.test(min)) minLabel = null;
        else return expr;
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
