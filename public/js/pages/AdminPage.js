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
        this._users = { page: 0, limit: 25, search: '', sort: 'created_desc', tagId: '', billing: '', country: '', total: 0 };
        this._allTags = [];
        this._usersDebounce = null;
        this._lastTs = null; // snapshot refreshed_at for the topbar
        this._partnersCanManageCapabilities = false;
        this._partnersCanManageRelease = false;
        this._partnersCapabilities = { support: false, risk: false, finance: false };
        this._partnersCapabilityOperators = undefined;
        this._partnersView = 'overview';
        this._partnersPage = 0;
        this._partnersLimit = 25;
        this._partnersAccessRequestPage = 0;
        this._partnersAccessRequestLimit = 12;
        this._partnersAccessRequestStatus = 'requested';
        this._partnersPayoutOnboardingOffset = 0;
        this._partnersPayoutOnboardingLimit = 20;
        this._partnersPayoutOnboardingStatus = 'pending';
        this._partnersPayoutOnboardingSearch = '';
        this._partnersFiscalOffset = 0;
        this._partnersFiscalLimit = 20;
        this._partnersFiscalStatus = 'pending';
        this._partnersFiscalSearch = '';
        this._partnersRoutePage = 0;
        this._partnersRouteLimit = 12;
        this._partnersRouteSearch = '';
        this._partnersRouteStatus = 'all';
        this._partnersRoutes = [];
        this._partnersPolicyPage = 0;
        this._partnersPolicyLimit = 12;
        this._partnersRequestSeq = 0;
        this._partnersPageGeneration = 0;
        this._partnersRequests = new Map();
        this._partnersCache = new Map();
        this._partnersScrollByView = new Map();
        this._partnersRestoreContext = null;
        this._partnersAal2Required = false;
        this._partnersAal2FailedKeys = new Set();
        this._partnersContactKeys = new Map();
        this._partnersKycCertificationPollTimer = null;
        this._partnersKycCertificationPollUntil = 0;
    }

    // ── direct PostgREST RPC client (mirrors authApi.js config resolution) ──
    _sbUrl() {
        return (localStorage.getItem('norva-supabase-url') || window.NORVA_SUPABASE_URL
            || 'https://api.norva.tv').replace(/\/+$/, '');
    }
    _sbKey() {
        return localStorage.getItem('norva-supabase-key') || window.NORVA_SUPABASE_PUBLISHABLE_KEY
            || 'sb_publishable_LJwYVgPGHYNYTDk7s3eOew_6TU73Fcw';
    }
    _token() {
        try { return (JSON.parse(localStorage.getItem('norva-cloud-session') || 'null') || {}).access_token || ''; }
        catch (_) { return ''; }
    }
    // Current admin's user id, decoded from the JWT (sub claim) — client-side gate only
    // (UX: hide self-destructive actions); the edge enforces the real anti-lock-out rules.
    _meId() {
        try {
            const part = this._token().split('.')[1] || '';
            return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))).sub || '';
        } catch (_) { return ''; }
    }
    async _rpc(fn, params, options = {}) {
        const res = await fetch(`${this._sbUrl()}/rest/v1/rpc/${fn}`, {
            method: 'POST',
            headers: {
                apikey: this._sbKey(),
                Authorization: `Bearer ${this._token()}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(params || {}),
            signal: options?.signal
        });
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            const error = new Error(`${fn}: ${res.status} ${t.slice(0, 140)}`);
            error.status = res.status;
            try { error.payload = JSON.parse(t); } catch (_) { error.payload = {}; }
            throw error;
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
        // Deep-link / F5: restore the exact CRM view from "#admin/<route>". The app's
        // navigateTo rewrites the hash to "#admin" before we run, so init stashes the
        // sub-route on the app (consumed once); fall back to reading the live hash
        // (covers being called while the sub-hash is still intact), then to memory.
        let sub = null;
        if (this.app && this.app._adminSubRoute) { sub = AdminPage.validRoute(this.app._adminSubRoute); this.app._adminSubRoute = ''; }
        if (!sub) { const m = String(location.hash || '').match(/^#admin\/(.+)$/); if (m) sub = AdminPage.validRoute(decodeURIComponent(m[1])); }
        this._navigate(sub || this._route || 'cockpit');
    }
    hide() {
        clearTimeout(this._partnersSearchDebounce);
        clearTimeout(this._partnersRoutesDebounce);
        clearTimeout(this._partnersPayoutOnboardingDebounce);
        clearTimeout(this._partnersFiscalDebounce);
        clearTimeout(this._partnersKycCertificationPollTimer);
        this._partnersKycCertificationPollTimer = null;
        this._partnersAbortAll?.();
    }

    // Whitelist CRM routes coming from the URL (never trust a raw hash): static pages by
    // name, entity pages only as client:<uuid> / ticket:<uuid> / partner:<uuid>
    // or the sanitized Finance-only partner-public:prt_<opaque> route.
    static validRoute(r) {
        r = String(r || '');
        if (['cockpit', 'finance', 'finance/vat', 'finance/promos', 'finance/paiements', 'finance/analyse',
            'marketing', 'marketing/promos', 'marketing/notifs',
            'clients', 'partners', 'support', 'providers', 'identites', 'moteur', 'systeme', 'telemetrie'].includes(r)) return r;
        const m = r.match(/^(client|ticket|partner):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
        if (m) return m[1] + ':' + m[2];
        const publicPartner = r.match(/^partner-public:(prt_[0-9a-f]{24})$/);
        return publicPartner ? `partner-public:${publicPartner[1]}` : null;
    }

    // ── CRM shell ──
    static NAV() {
        // Grouped into sections (rendered as sidebar headers) for fast comprehension.
        return [
            { key: 'cockpit', label: 'Cockpit', icon: '🎯', section: 'Business' },
            { key: 'finance', label: 'Finance', icon: '💶', section: 'Business' },
            { key: 'marketing', label: 'Marketing', icon: '📣', section: 'Business' },
            { key: 'clients', label: 'Clients', icon: '👥', section: 'Business' },
            { key: 'partners', label: 'Partners', icon: 'P', section: 'Business' },
            { key: 'support', label: 'Support', icon: '🎫', section: 'Business' },
            { key: 'providers', label: 'Providers', icon: '📡', section: 'Catalogue' },
            { key: 'identites', label: 'Identités', icon: '🧬', section: 'Catalogue' },
            { key: 'moteur', label: 'Moteur', icon: '⚙️', section: 'Catalogue' },
            { key: 'systeme', label: 'Système', icon: '🛡️', section: 'Infra' },
            { key: 'telemetrie', label: 'Télémétrie', icon: '📊', section: 'Infra' }
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
        const navSecOrder = [];
        const navBySec = {};
        AdminPage.NAV().forEach(n => {
            const s = n.section || 'Autre';
            if (!navBySec[s]) { navBySec[s] = []; navSecOrder.push(s); }
            navBySec[s].push(n);
        });
        const nav = navSecOrder.map(s =>
            `<div class="crm-nav-sec" aria-hidden="true">${s}</div>` +
            navBySec[s].map(n =>
                `<button class="crm-nav-item" data-route="${n.key}" title="${n.label}" aria-label="${n.label}"><span class="ic" aria-hidden="true">${n.icon}</span><span class="lb">${n.label}</span></button>`).join('')
        ).join('');
        root.innerHTML = `
<style>
#page-admin{height:100%;overflow:hidden;
  --adm-bg:#0a0d16;--adm-bg2:#0e1220;
  --adm-card1:#171c2b;--adm-card2:#111624;--adm-card:var(--adm-card1);
  --adm-panel:rgba(255,255,255,.022);
  --adm-line:rgba(255,255,255,.07);--adm-line2:rgba(255,255,255,.045);
  --adm-tx:#eef1f8;--adm-tx1:var(--adm-tx);--adm-tx2:#a2adc2;--adm-tx3:#828da3;
  --adm-blue:#5b7cfa;--adm-purple:#a855f7;--adm-green:#34d399;--adm-red:#f87171;--adm-amber:#fbbf24;
  color:var(--adm-tx);}
#page-admin *{box-sizing:border-box;}
#page-admin .crm-shell{display:flex;height:100%;background:var(--adm-bg);color:var(--adm-tx);}
/* Sidebar */
#page-admin .crm-sidebar{width:238px;flex-shrink:0;background:linear-gradient(180deg,#0e1220,#0a0d17);border-right:1px solid var(--adm-line);display:flex;flex-direction:column;overflow-y:auto;padding:18px 13px;}
#page-admin .crm-brand{display:flex;align-items:center;gap:11px;padding:6px 8px 20px;font-weight:800;font-size:16px;color:var(--adm-tx);letter-spacing:.2px;}
#page-admin .crm-brand .dot{width:27px;height:27px;border-radius:9px;background:linear-gradient(135deg,#5b7cfa,#a855f7);display:inline-block;box-shadow:0 5px 16px rgba(91,124,250,.42);}
#page-admin .crm-brand .crm-logo{width:30px;height:30px;flex-shrink:0;filter:drop-shadow(0 2px 9px rgba(120,150,255,.4));}
#page-admin .crm-nav-sec{padding:15px 12px 5px;font-size:10.5px;font-weight:700;letter-spacing:.9px;text-transform:uppercase;color:var(--adm-tx3);opacity:.7;user-select:none;}
#page-admin .crm-nav-sec:first-child{padding-top:2px;}
#page-admin .crm-nav-item{position:relative;display:flex;align-items:center;gap:12px;width:100%;background:none;border:0;color:var(--adm-tx2);padding:10px 12px;border-radius:10px;cursor:pointer;font-size:13.5px;font-weight:500;text-align:left;margin-bottom:3px;transition:background .15s,color .15s,box-shadow .15s;}
#page-admin .crm-nav-item .ic{font-size:16px;width:20px;text-align:center;opacity:.9;}
#page-admin .crm-nav-item:hover{background:rgba(255,255,255,.05);color:var(--adm-tx);}
#page-admin .crm-nav-item.active{background:linear-gradient(90deg,rgba(91,124,250,.22),rgba(168,85,247,.09));color:#c6d0ff;font-weight:600;box-shadow:inset 0 0 0 1px rgba(120,150,255,.16);}
#page-admin .crm-nav-item.active .ic{opacity:1;}
#page-admin .crm-nav-item.active::before{content:"";position:absolute;left:0;top:9px;bottom:9px;width:3px;border-radius:0 3px 3px 0;background:linear-gradient(180deg,#5b7cfa,#a855f7);}
#page-admin .crm-side-foot{margin-top:auto;display:flex;align-items:center;gap:10px;padding:10px 11px;background:linear-gradient(135deg,rgba(91,124,250,.10),rgba(168,85,247,.05));border:1px solid var(--adm-line2);border-radius:12px;box-shadow:inset 0 0 0 1px rgba(120,150,255,.08);cursor:default;transition:box-shadow .15s;}
#page-admin .crm-side-foot:hover{box-shadow:inset 0 0 0 1px rgba(120,150,255,.22);}
#page-admin .sf-ava{flex:none;width:32px;height:32px;border-radius:9px;background:linear-gradient(135deg,#5b7cfa,#a855f7);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#fff;letter-spacing:.02em;box-shadow:0 2px 8px rgba(91,124,250,.35);}
#page-admin .sf-tx{flex:1;min-width:0;line-height:1.35;}
#page-admin .sf-name{font-size:11.5px;font-weight:700;color:var(--adm-tx);display:flex;align-items:center;gap:6px;}
#page-admin .sf-name .sf-shield{font-size:10px;opacity:.9;}
#page-admin .sf-mail{display:block;font-size:10.5px;color:var(--adm-tx3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#page-admin .sf-dot{flex:none;width:7px;height:7px;border-radius:50%;background:#34d399;box-shadow:0 0 0 3px rgba(52,211,153,.15);animation:sfPulse 2.4s ease-in-out infinite;}
@keyframes sfPulse{0%,100%{box-shadow:0 0 0 3px rgba(52,211,153,.15);}50%{box-shadow:0 0 0 5px rgba(52,211,153,.05);}}
#page-admin .crm-main{flex:1;min-width:0;overflow-y:auto;-webkit-overflow-scrolling:touch;background:radial-gradient(1100px 520px at 78% -8%,rgba(91,124,250,.10),transparent 60%),radial-gradient(760px 420px at 8% 0%,rgba(168,85,247,.06),transparent 55%),var(--adm-bg);}
#page-admin .crm-topbar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:14px;padding:13px 26px;background:rgba(10,13,22,.82);backdrop-filter:blur(10px);border-bottom:1px solid var(--adm-line);}
#page-admin .crm-crumb{font-size:15px;font-weight:700;color:var(--adm-tx);}
#page-admin .crm-spacer{flex:1;}
#page-admin #crm-refresh{min-height:44px;background:linear-gradient(135deg,#5b7cfa,#7c6cf5);color:#fff;border:0;border-radius:10px;padding:9px 16px;cursor:pointer;font-weight:600;font-size:13px;box-shadow:0 6px 18px rgba(91,124,250,.32);transition:transform .12s,box-shadow .12s,filter .12s;}
#page-admin #crm-refresh:hover{filter:brightness(1.06);box-shadow:0 8px 22px rgba(91,124,250,.42);}
#page-admin #crm-refresh:active{transform:translateY(1px);}
#page-admin #crm-ts{color:var(--adm-tx3);font-size:12px;font-variant-numeric:tabular-nums;}
#page-admin .crm-page{max-width:1280px;margin:0 auto;padding:26px 28px 96px;}
/* Page header — gradient icon badge + title + subtitle */
#page-admin .crm-head{display:flex;align-items:flex-start;gap:16px;margin:0 0 24px;}
#page-admin .crm-head-ic{flex-shrink:0;width:56px;height:56px;border-radius:15px;display:flex;align-items:center;justify-content:center;font-size:26px;background:linear-gradient(135deg,rgba(91,124,250,.24),rgba(168,85,247,.20));border:1px solid rgba(120,150,255,.22);box-shadow:0 8px 24px rgba(91,124,250,.20),inset 0 1px 0 rgba(255,255,255,.06);}
#page-admin .crm-head-tx{min-width:0;padding-top:2px;}
#page-admin .crm-h1{font-size:24px;font-weight:750;margin:0 0 5px;color:var(--adm-tx);letter-spacing:-.2px;line-height:1.15;}
#page-admin .crm-sub{color:var(--adm-tx2);font-size:13px;margin:0;line-height:1.5;max-width:820px;}
#page-admin .admin-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:13px;margin-bottom:22px;}
#page-admin .kpi-groups{margin-bottom:22px;}
/* KPI group = framed panel (title inside) */
#page-admin .kpi-group{margin-bottom:18px;background:var(--adm-panel);border:1px solid var(--adm-line);border-radius:16px;padding:16px 18px 18px;}
#page-admin .kpi-group:last-child{margin-bottom:0;}
#page-admin .kpi-gtitle{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:var(--adm-tx2);margin:0 0 13px 2px;}
#page-admin .kpi-group .admin-cards,#page-admin .admin-block .admin-cards{margin-bottom:0;}
/* KPI card */
#page-admin .kpi{position:relative;background:linear-gradient(158deg,var(--adm-card1),var(--adm-card2));border:1px solid var(--adm-line);border-radius:14px;padding:16px 17px;box-shadow:0 2px 10px rgba(0,0,0,.22);transition:transform .14s,border-color .14s,box-shadow .14s;overflow:hidden;}
#page-admin .kpi:hover{transform:translateY(-2px);border-color:rgba(120,150,255,.28);box-shadow:0 10px 26px rgba(0,0,0,.32);}
#page-admin .kpi .v{font-size:27px;font-weight:750;color:var(--adm-tx);line-height:1.08;letter-spacing:-.4px;}
#page-admin .kpi .l{font-size:11px;color:var(--adm-tx2);margin-top:6px;text-transform:uppercase;letter-spacing:.45px;line-height:1.35;}
#page-admin .kpi.alert{border-color:rgba(248,113,113,.42);background:linear-gradient(158deg,rgba(248,113,113,.10),var(--adm-card2));}
#page-admin .kpi.alert .v{color:var(--adm-red);}
#page-admin .kpi.ok .v{color:var(--adm-green);}
#page-admin .kpi.muted{background:linear-gradient(158deg,rgba(251,191,36,.05),var(--adm-card2));}
#page-admin .kpi.muted .v{color:var(--adm-amber);}
#page-admin .kpi.muted .kpi-ic{background:rgba(251,191,36,.10);border-color:rgba(251,191,36,.18);}
/* KPI card with icon + sparkline (Cockpit) */
#page-admin .kpi-hd{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;}
#page-admin .kpi-ic{flex-shrink:0;width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:15px;background:rgba(120,150,255,.09);border:1px solid rgba(120,150,255,.14);}
#page-admin .kpi.alert .kpi-ic{background:rgba(248,113,113,.10);border-color:rgba(248,113,113,.20);}
#page-admin .kpi.ok .kpi-ic{background:rgba(52,211,153,.10);border-color:rgba(52,211,153,.18);}
#page-admin .kpi-spark{margin-top:11px;height:38px;}
#page-admin .kpi-spark svg{width:100%;height:38px;display:block;}
#page-admin .kpi .v{white-space:nowrap;}
/* Compact (two-column) cards: slightly smaller value so money never wraps */
#page-admin .admin-cards.fin-mini .kpi:not(.fin-status) .v{font-size:21px;}
/* Section block = framed panel */
#page-admin .admin-block{margin-bottom:18px;background:var(--adm-panel);border:1px solid var(--adm-line);border-radius:16px;padding:17px 20px 18px;}
#page-admin .admin-block h2{font-size:14px;font-weight:650;margin:0 0 13px;color:var(--adm-tx);letter-spacing:-.1px;}
#page-admin table{width:100%;border-collapse:collapse;font-size:13px;}
#page-admin th,#page-admin td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--adm-line2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#page-admin thead th{border-bottom:1px solid var(--adm-line);}
#page-admin tbody tr:last-child td{border-bottom:0;}
#page-admin th{color:var(--adm-tx3);font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;}
#page-admin td.num{text-align:right;font-variant-numeric:tabular-nums;}
#page-admin tr.bad{background:rgba(248,113,113,.09);}
#page-admin .badge{display:inline-block;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600;line-height:1.3;}
#page-admin .badge.red{background:rgba(248,113,113,.15);color:#fca5a5;}
#page-admin .badge.green{background:rgba(52,211,153,.15);color:#5eead4;}
#page-admin .badge.gray{background:rgba(148,163,184,.15);color:#b8c2d4;}
#page-admin .badge.amber{background:rgba(251,191,36,.15);color:#fcd34d;}
#page-admin .badge.blue{background:rgba(91,124,250,.18);color:#a9bcff;}
#page-admin tr.group-start td{border-top:2px solid var(--adm-line);}
#page-admin .pname{font-weight:600;}
#page-admin .pacct{font-size:11px;color:var(--color-text-secondary,#9aa);}
#page-admin .ssub{font-size:12px;color:var(--color-text-secondary,#9aa);margin:-4px 0 12px;}
#page-admin .resync-btn{background:var(--color-bg-secondary,#181820);color:#a9bcff;border:1px solid var(--color-border,#2a2a38);border-radius:6px;padding:2px 9px;cursor:pointer;font-size:12px;white-space:nowrap;}
#page-admin .resync-btn:disabled{opacity:.5;cursor:default;}
#page-admin .bar{height:6px;border-radius:4px;background:rgba(255,255,255,.07);overflow:hidden;min-width:60px;display:inline-block;vertical-align:middle;margin-right:6px;}
#page-admin .bar>i{display:block;height:100%;background:linear-gradient(90deg,#34d399,#22c1a6);border-radius:4px;}
#page-admin .admin-err{color:var(--adm-red);padding:10px;}
#page-admin .scroll{overflow-x:auto;}
#page-admin .card{background:var(--adm-panel);border:1px solid var(--adm-line);border-radius:16px;padding:18px 20px;}
/* Charts (self-contained inline SVG) */
#page-admin .chart-row{display:grid;grid-template-columns:1.7fr 1fr;gap:16px;margin-bottom:18px;}
#page-admin .chart-panel{background:var(--adm-panel);border:1px solid var(--adm-line);border-radius:16px;padding:16px 18px 14px;min-width:0;margin-bottom:18px;}
#page-admin .chart-panel h2{font-size:14px;font-weight:650;margin:0 0 2px;color:var(--adm-tx);}
#page-admin .chart-panel .chsub{font-size:11.5px;color:var(--adm-tx3);margin:0 0 12px;}
#page-admin .chart-svg{width:100%;display:block;}
/* Interactive bar chart: focus-dim on hover + cursor-following tooltip */
#page-admin .chart-wrap{position:relative;}
#page-admin .chart-svg .bar-main{transition:opacity .12s;}
#page-admin .chart-svg.dim .bar-col:not(.hl) .bar-main{opacity:.32;}
#page-admin .chart-svg.dim .bar-col:not(.hl) .bar-fail{opacity:.32;}
#page-admin .chart-svg .barbox{fill:transparent;cursor:pointer;}
#page-admin .chart-tip{position:absolute;left:0;top:0;pointer-events:none;z-index:20;background:rgba(12,16,26,.97);border:1px solid var(--adm-line);border-radius:10px;padding:8px 11px;font-size:12px;color:var(--adm-tx);box-shadow:0 10px 28px rgba(0,0,0,.45);opacity:0;transform:translate(-50%,-100%);transition:opacity .1s;white-space:nowrap;}
#page-admin .chart-tip.on{opacity:1;}
#page-admin .chart-tip .tt-d{font-weight:700;margin-bottom:4px;font-size:11.5px;}
#page-admin .chart-tip .tt-r{color:var(--adm-tx2);display:flex;align-items:center;gap:7px;line-height:1.7;}
#page-admin .chart-tip .tt-r b{color:var(--adm-tx);font-weight:700;}
#page-admin .chart-tip .tt-dot{width:8px;height:8px;border-radius:2px;display:inline-block;flex-shrink:0;}
#page-admin .donut-wrap{display:flex;align-items:center;gap:20px;flex-wrap:wrap;justify-content:center;}
#page-admin .chart-legend{display:flex;flex-direction:column;gap:11px;font-size:13px;min-width:150px;flex:1;}
#page-admin .chart-legend .lg{display:flex;align-items:center;gap:9px;color:var(--adm-tx2);}
#page-admin .chart-legend .dotc{width:11px;height:11px;border-radius:3px;flex-shrink:0;}
#page-admin .chart-legend b{color:var(--adm-tx);font-variant-numeric:tabular-nums;}
#page-admin .chart-legend .pct{color:var(--adm-tx3);margin-left:auto;font-variant-numeric:tabular-nums;}
@media(max-width:820px){#page-admin .chart-row{grid-template-columns:1fr;}}
/* Finance two-column rows (blocks paired side by side, like the mockup) */
#page-admin .fin-cols{display:grid;grid-template-columns:1fr 1.08fr;gap:16px;margin-bottom:18px;align-items:stretch;}
#page-admin .fin-cols > *{margin-bottom:0;}
/* Cartes rail (Finance) : identité financière complète de chaque canal de paiement. */
#page-admin .rail-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;}
#page-admin .rail-card{background:rgba(255,255,255,.015);border:1px solid var(--adm-line);border-radius:14px;padding:14px 16px 11px;}
#page-admin .rail-card--revolut{border-color:rgba(91,124,250,.38);background:linear-gradient(158deg,rgba(91,124,250,.06),rgba(255,255,255,.01));}
#page-admin .rail-card--store{border-color:rgba(62,207,142,.32);background:linear-gradient(158deg,rgba(62,207,142,.05),rgba(255,255,255,.01));}
#page-admin .rail-hd{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;}
#page-admin .rail-share{font-size:11.5px;color:#9aa4b2;white-space:nowrap;}
#page-admin .rail-mrr{font-size:25px;font-weight:800;letter-spacing:-.6px;font-variant-numeric:tabular-nums;}
#page-admin .rail-net{font-size:11.5px;color:#9aa4b2;margin:2px 0 8px;cursor:help;}
#page-admin .rail-card .kv-row{font-size:12.5px;padding:5.5px 0;}
#page-admin .admin-cards.fin-mini{grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:10px;}
@media(max-width:900px){#page-admin .fin-cols{grid-template-columns:1fr;}}
/* Header status line (executive read at the top of a page) */
#page-admin .crm-head-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:11px;}
#page-admin .crm-hpill{font-size:11.5px;color:var(--adm-tx2);background:rgba(255,255,255,.04);border:1px solid var(--adm-line);border-radius:20px;padding:3px 11px;line-height:1.5;}
#page-admin .crm-hpill b{color:var(--adm-tx);font-weight:700;}
#page-admin .crm-hpill.bad{background:rgba(248,113,113,.12);border-color:rgba(248,113,113,.3);}
#page-admin .crm-hpill.bad b{color:#fca5a5;}
#page-admin .crm-hlive{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--adm-tx3);margin-left:2px;}
#page-admin .live-dot{width:7px;height:7px;border-radius:50%;background:var(--adm-green);box-shadow:0 0 0 3px rgba(52,211,153,.16);animation:livepulse 2.4s ease-in-out infinite;}
@keyframes livepulse{0%,100%{box-shadow:0 0 0 3px rgba(52,211,153,.16);}50%{box-shadow:0 0 0 5px rgba(52,211,153,.05);}}
/* Revenue-risk group: calm when clean, flags amber→red when any risk is present */
#page-admin .kpi-group--risk{border-color:rgba(251,191,36,.16);background:linear-gradient(158deg,rgba(251,191,36,.035),var(--adm-panel));}
#page-admin .kpi-group--risk.has-risk{border-color:rgba(248,113,113,.28);background:linear-gradient(158deg,rgba(248,113,113,.06),var(--adm-panel));}
/* Compact horizontal-bar list (funnel, cancellation reasons) — pure CSS, responsive */
#page-admin .hbars{display:flex;flex-direction:column;gap:9px;padding:4px 2px 2px;}
#page-admin .hbar{display:grid;grid-template-columns:132px 1fr 50px;align-items:center;gap:11px;}
#page-admin .hbar-l{font-size:12px;color:var(--adm-tx2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#page-admin .hbar-track{height:9px;border-radius:5px;background:rgba(255,255,255,.05);overflow:hidden;}
#page-admin .hbar-fill{height:100%;border-radius:5px;background:linear-gradient(90deg,#5b7cfa,#8b7cff);min-width:2px;}
#page-admin .hbar-fill.warn{background:linear-gradient(90deg,#f59e0b,#fbbf24);}
#page-admin .hbar-v{font-size:13px;font-weight:700;color:var(--adm-tx);text-align:right;font-variant-numeric:tabular-nums;}
@media(max-width:560px){#page-admin .hbar{grid-template-columns:100px 1fr 42px;gap:8px;}}
/* Paywall funnel: experiment state and non-additive dimensional cohorts. */
#page-admin .pw-exp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px;margin:12px 0 14px;}
#page-admin .pw-exp{background:rgba(255,255,255,.018);border:1px solid var(--adm-line2);border-radius:12px;padding:11px 13px;min-width:0;}
#page-admin .pw-exp-h{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;font-size:12px;font-weight:650;}
#page-admin .pw-exp-v{display:flex;flex-wrap:wrap;gap:6px;}
#page-admin .pw-exp-v .badge{font-variant-numeric:tabular-nums;}
#page-admin .pw-dims{margin-top:14px;border-top:1px solid var(--adm-line2);padding-top:11px;}
#page-admin .pw-dims summary{cursor:pointer;color:var(--adm-tx2);font-size:12px;font-weight:650;list-style-position:inside;}
#page-admin .pw-dims[open] summary{margin-bottom:9px;color:var(--adm-tx);}
#page-admin .pw-dims td{font-size:12px;}
#page-admin .pw-dims-note{font-size:11px;color:var(--adm-tx3);margin-top:8px;line-height:1.45;}
/* Moteur: Matching TMDB (left) ‖ Crons (right) */
#page-admin .mot-cols{display:grid;grid-template-columns:0.9fr 2.2fr;gap:16px;margin-bottom:18px;align-items:stretch;}
#page-admin .mot-cols > *{margin-bottom:0;min-width:0;}
@media(max-width:1000px){#page-admin .mot-cols{grid-template-columns:1fr;}}
#page-admin .mot-tmdb{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:12px;}
#page-admin .mot-tmdb .kpi{text-align:center;padding:16px 8px 14px;display:flex;flex-direction:column;align-items:center;}
#page-admin .mot-tmdb .kpi .v{font-size:19px;}
#page-admin .mot-tmdb .kpi .l{margin-top:6px;}
#page-admin .mot-tmdb .mot-ic{margin-top:13px;font-size:19px;opacity:.75;}
#page-admin .mot-tmdb .mot-drain{font-size:10px;color:var(--adm-tx3);margin-top:5px;line-height:1.3;}
/* Moteur: incidents block, threshold audio bars, cron summary, legend */
#page-admin .mot-inc{display:flex;flex-direction:column;gap:8px;margin-bottom:22px;}
#page-admin .mot-inc-row{display:flex;align-items:center;gap:10px;background:var(--adm-panel);border:1px solid var(--adm-line);border-left:3px solid var(--adm-red);border-radius:10px;padding:10px 14px;font-size:13px;}
#page-admin .mot-inc-row.warn{border-left-color:var(--adm-amber);}
#page-admin .mot-inc-row.gray{border-left-color:var(--adm-tx3);}
#page-admin .mot-inc-row .mi-t{color:var(--adm-tx);font-weight:650;}
#page-admin .mot-inc-row .mi-d{color:var(--adm-tx2);}
#page-admin .mot-inc-ok{background:rgba(52,211,153,.08);border:1px solid rgba(52,211,153,.24);color:#6ee7bf;border-radius:12px;padding:11px 15px;font-size:13px;font-weight:600;margin-bottom:22px;}
#page-admin .bar.b-warn>i{background:linear-gradient(90deg,#f59e0b,#fbbf24);}
#page-admin .bar.b-bad>i{background:linear-gradient(90deg,#f87171,#ef4444);}
#page-admin .cron-sum{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;}
#page-admin .mot-legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:11.5px;color:var(--adm-tx3);margin-top:10px;}
#page-admin .mot-legend b{color:var(--adm-tx2);}
#page-admin tr.mot-bad{background:rgba(248,113,113,.05);}
#page-admin .mot-state-detail{font-size:10.5px;color:var(--adm-tx3);line-height:1.35;margin-top:4px;max-width:230px;}
#page-admin .mot-legacy-note{background:rgba(251,191,36,.07);border:1px solid rgba(251,191,36,.22);color:#fcd34d;border-radius:10px;padding:9px 12px;font-size:11.5px;line-height:1.45;margin-bottom:10px;}
/* Support header KPI cards (big icon on the left, like the mockup) */
#page-admin .sup-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(176px,1fr));gap:14px;margin-bottom:20px;}
#page-admin .sup-card{display:flex;align-items:center;gap:14px;background:linear-gradient(158deg,var(--adm-card1),var(--adm-card2));border:1px solid var(--adm-line);border-radius:14px;padding:16px 18px;box-shadow:0 2px 10px rgba(0,0,0,.22);}
#page-admin .sup-card .ic{width:46px;height:46px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;background:rgba(120,150,255,.12);border:1px solid rgba(120,150,255,.18);}
#page-admin .sup-card.ok .ic{background:rgba(52,211,153,.12);border-color:rgba(52,211,153,.2);}
#page-admin .sup-card.alert .ic{background:rgba(248,113,113,.12);border-color:rgba(248,113,113,.2);}
#page-admin .sup-card .v{font-size:26px;font-weight:750;line-height:1;color:var(--adm-tx);}
#page-admin .sup-card.ok .v{color:var(--adm-green);}
#page-admin .sup-card.alert .v{color:var(--adm-red);}
#page-admin .sup-card .l{font-size:11px;color:var(--adm-tx2);text-transform:uppercase;letter-spacing:.4px;margin-top:5px;}
/* Support KPI cards → clickable filters (active state mirrors the open tab) */
#page-admin .sup-card[role="button"]{cursor:pointer;transition:border-color .14s,transform .14s,box-shadow .14s;}
#page-admin .sup-card[role="button"]:hover{border-color:#5b7cfa;transform:translateY(-1px);}
#page-admin .sup-card.is-active{border-color:rgba(120,150,255,.5);box-shadow:0 0 0 1px rgba(120,150,255,.3),0 4px 18px rgba(91,124,250,.14);}
/* Support: dedicated pill tabs with counts (an inbox, not a back-office table) */
#page-admin .support-tabs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;}
#page-admin .sup-tab{background:var(--adm-panel);border:1px solid var(--adm-line);color:var(--adm-tx2);border-radius:20px;padding:7px 14px;font-size:12.5px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:7px;transition:border-color .14s,color .14s,background .14s;}
#page-admin .sup-tab:hover{border-color:#5b7cfa;color:var(--adm-tx);}
#page-admin .sup-tab[aria-selected="true"]{background:linear-gradient(135deg,rgba(91,124,250,.2),rgba(168,85,247,.16));border-color:rgba(120,150,255,.4);color:#fff;}
#page-admin .sup-tab .tab-n{font-size:11px;font-weight:700;background:rgba(255,255,255,.08);border-radius:9px;padding:1px 7px;min-width:18px;text-align:center;}
#page-admin .sup-tab.urgent .tab-n{background:rgba(248,113,113,.24);color:#fca5a5;}
#page-admin .sup-search{background:var(--adm-panel);border:1px solid var(--adm-line);color:var(--adm-tx);border-radius:10px;padding:9px 13px;font-size:13px;width:100%;max-width:360px;margin-bottom:14px;}
/* Support inbox rows: status left · subject+preview center · client+age right */
#page-admin .inbox{display:flex;flex-direction:column;gap:9px;}
#page-admin .inbox-row{display:grid;grid-template-columns:112px 1fr auto;gap:14px;align-items:center;background:var(--adm-panel);border:1px solid var(--adm-line);border-left:3px solid transparent;border-radius:12px;padding:12px 15px;cursor:pointer;transition:border-color .14s,background .14s;}
#page-admin .inbox-row:hover{border-color:#5b7cfa;background:rgba(91,124,250,.05);}
#page-admin .inbox-row.urgent{border-left-color:var(--adm-red);}
#page-admin .inbox-row.warn{border-left-color:var(--adm-amber);}
#page-admin .inbox-st{display:flex;flex-direction:column;gap:5px;align-items:flex-start;}
#page-admin .inbox-main{min-width:0;}
#page-admin .inbox-subj{font-size:14px;font-weight:650;color:var(--adm-tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#page-admin .inbox-prev{font-size:12px;color:var(--adm-tx2);margin-top:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4;}
#page-admin .inbox-cli{font-size:11.5px;color:var(--adm-tx3);margin-top:5px;}
#page-admin .inbox-meta{text-align:right;white-space:nowrap;display:flex;flex-direction:column;align-items:flex-end;gap:5px;}
#page-admin .inbox-age{font-size:12px;color:var(--adm-tx2);font-weight:600;}
#page-admin .inbox-msgs{font-size:11px;color:var(--adm-tx3);}
#page-admin .sla-chip{font-size:9.5px;font-weight:700;letter-spacing:.3px;padding:2px 7px;border-radius:5px;text-transform:uppercase;}
#page-admin .sla-chip.red{background:rgba(248,113,113,.18);color:#fca5a5;}
#page-admin .sla-chip.amber{background:rgba(251,191,36,.18);color:#fcd34d;}
@media(max-width:640px){#page-admin .inbox-row{grid-template-columns:1fr auto;}#page-admin .inbox-st{flex-direction:row;grid-column:1/-1;}}
/* Ticket view: sticky back bar, state banner, class-based thread, context sidebar, templates */
/* Sticks BELOW the .crm-topbar (also sticky top:0, z-index:5, ~60px tall) — both live in the
   same .crm-main scroll container, so top:0 here would overlap the topbar and its opaque
   gradient painted over the Rafraîchir button. Offset by the topbar height + a lower z-index
   (4 < 5) so the topbar always wins any residual 1px touch, and a solid bg (no transparent bleed). */
#page-admin .tk-back-bar{position:sticky;top:68px;z-index:4;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 0;margin-bottom:6px;background:var(--adm-bg);}
#page-admin .tk-cols{display:grid;grid-template-columns:1fr 300px;gap:18px;align-items:start;}
@media(max-width:960px){#page-admin .tk-cols{grid-template-columns:1fr;}}
#page-admin .tk-banner{display:flex;align-items:center;gap:9px;padding:11px 15px;border-radius:12px;font-size:13px;font-weight:600;margin-bottom:14px;}
#page-admin .tk-banner.red{background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.3);color:#fca5a5;}
#page-admin .tk-banner.blue{background:rgba(91,124,250,.1);border:1px solid rgba(91,124,250,.3);color:#a9bcff;}
#page-admin .tk-banner.gray{background:rgba(255,255,255,.04);border:1px solid var(--adm-line);color:var(--adm-tx2);}
#page-admin .ticket-thread{display:flex;flex-direction:column;gap:12px;}
#page-admin .ticket-msg{max-width:82%;padding:11px 14px;border-radius:14px;font-size:13.5px;line-height:1.55;}
#page-admin .ticket-msg-b{white-space:pre-wrap;word-break:break-word;}
#page-admin .ticket-msg--client{background:#1c2433;border:1px solid #263048;align-self:flex-start;border-bottom-left-radius:4px;}
#page-admin .ticket-msg--admin{background:#14261f;border:1px solid #1f4436;align-self:flex-end;border-bottom-right-radius:4px;}
#page-admin .ticket-msg-h{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--adm-tx3);font-weight:700;margin-bottom:5px;}
#page-admin .tk-av{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0;}
#page-admin .ticket-msg--admin .tk-av{background:linear-gradient(135deg,#34d399,#22c1a6);color:#04120c;}
#page-admin .ticket-msg--client .tk-av{background:linear-gradient(135deg,#5b7cfa,#a855f7);color:#fff;}
#page-admin .ticket-reply{width:100%;background:var(--color-bg-primary,#0d0d0f);border:1px solid var(--adm-line);color:#fff;border-radius:10px;padding:11px 13px;font:inherit;font-size:13px;resize:vertical;}
#page-admin .tk-templates{display:flex;flex-wrap:wrap;gap:7px;margin:10px 0 2px;}
#page-admin .tk-tpl{background:var(--adm-panel);border:1px solid var(--adm-line);color:var(--adm-tx2);border-radius:16px;padding:5px 11px;font-size:11.5px;cursor:pointer;transition:border-color .14s,color .14s;}
#page-admin .tk-tpl:hover{border-color:#5b7cfa;color:var(--adm-tx);}
#page-admin .tk-ctx .kv-row{padding:6px 0;}
#page-admin .tk-ctx h2{font-size:13px;}
/* Sources triage console: toolbar + ops rows (status left · account/identity/error center · catalogue/sync/actions right) */
#page-admin .src-toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:14px;}
#page-admin .src-toolbar .sup-search{margin-bottom:0;flex:1;min-width:220px;}
#page-admin .src-bulk{background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.32);color:#fca5a5;border-radius:10px;padding:9px 13px;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;}
#page-admin .src-bulk:hover{background:rgba(248,113,113,.16);}
#page-admin .src-bulk:disabled{opacity:.55;cursor:default;}
#page-admin .src-rows{display:flex;flex-direction:column;gap:9px;}
#page-admin .src-row{display:grid;grid-template-columns:158px 1fr auto;gap:14px;align-items:center;background:var(--adm-panel);border:1px solid var(--adm-line);border-left:3px solid transparent;border-radius:12px;padding:12px 15px;}
#page-admin .src-row.err{border-left-color:var(--adm-red);}
#page-admin .src-row.inc{border-left-color:var(--adm-amber);}
#page-admin .src-row.unres{border-left-color:#8b7cff;}
#page-admin .src-st{display:flex;flex-direction:column;gap:6px;align-items:flex-start;min-width:0;}
#page-admin .src-prov{font-size:13.5px;font-weight:650;color:var(--adm-tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}
#page-admin .src-main{min-width:0;font-size:12.5px;color:var(--adm-tx2);}
#page-admin .src-acct{color:#a9bcff;cursor:pointer;font-weight:600;}
#page-admin .src-acct:hover{text-decoration:underline;}
#page-admin .src-id{color:var(--adm-tx3);}
#page-admin .src-err{color:#fca5a5;margin-top:4px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:560px;}
#page-admin .src-cat{font-size:11.5px;color:var(--adm-tx3);margin-top:4px;}
#page-admin .src-meta{text-align:right;white-space:nowrap;display:flex;flex-direction:column;align-items:flex-end;gap:7px;}
#page-admin .src-sync{font-size:11.5px;color:var(--adm-tx2);}
#page-admin .src-acts{display:flex;gap:6px;}
#page-admin .src-mini{background:var(--color-bg-secondary,#181820);color:#a9bcff;border:1px solid var(--adm-line);border-radius:6px;padding:2px 9px;cursor:pointer;font-size:12px;white-space:nowrap;}
#page-admin .src-mini:hover{border-color:#5b7cfa;}
#page-admin .src-row.ok .resync-btn{opacity:.5;}
#page-admin .src-row.ok .resync-btn:hover{opacity:1;}
@media(max-width:820px){#page-admin .src-row{grid-template-columns:1fr;}#page-admin .src-meta{text-align:left;align-items:flex-start;}}
/* Identités: leading gradient icon on each identity card */
#page-admin .id-ic{width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;background:linear-gradient(135deg,rgba(91,124,250,.22),rgba(168,85,247,.18));border:1px solid rgba(120,150,255,.2);}
/* Identity cards — class-based (replaces inline styles) */
#page-admin .identity-card{background:var(--adm-panel);border:1px solid var(--adm-line);border-radius:16px;padding:18px 20px;margin-bottom:14px;}
#page-admin .identity-card.mirror{border-color:rgba(251,191,36,.28);background:linear-gradient(158deg,rgba(251,191,36,.035),var(--adm-panel));}
#page-admin .identity-card.dormant{opacity:.72;}
#page-admin .identity-head{display:flex;gap:13px;align-items:flex-start;margin-bottom:12px;}
#page-admin .identity-main{min-width:0;flex:1;}
#page-admin .identity-name{font-size:16px;font-weight:700;color:var(--adm-tx);display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
#page-admin .identity-stats{font-size:12px;color:var(--adm-tx2);margin-top:5px;}
#page-admin .identity-stats b{color:var(--adm-tx);font-weight:700;}
#page-admin .identity-brands{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px;}
#page-admin .identity-acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;}
#page-admin .id-actbtn{background:var(--color-bg-secondary,#181820);color:#a9bcff;border:1px solid var(--adm-line);border-radius:7px;padding:4px 11px;cursor:pointer;font-size:11.5px;white-space:nowrap;}
#page-admin .id-actbtn:hover{border-color:#5b7cfa;}
#page-admin .id-legend{display:flex;flex-wrap:wrap;gap:7px 18px;background:var(--adm-panel);border:1px solid var(--adm-line);border-radius:12px;padding:11px 15px;margin-bottom:16px;font-size:12px;color:var(--adm-tx2);}
#page-admin .id-legend b{color:var(--adm-tx);}
#page-admin .id-legend .lgd{white-space:nowrap;}
/* Système: health gauge bar + Services ‖ Activité two-column */
#page-admin .kpi-bar{height:7px;border-radius:4px;background:rgba(255,255,255,.08);overflow:hidden;margin-top:11px;}
#page-admin .kpi-bar>i{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,#5b7cfa,#8b7cff);}
#page-admin .kpi.ok .kpi-bar>i{background:linear-gradient(90deg,#34d399,#22c1a6);}
#page-admin .kpi.alert .kpi-bar>i{background:linear-gradient(90deg,#f87171,#ef4444);}
#page-admin .sys-cols{display:grid;grid-template-columns:0.95fr 1.6fr;gap:16px;margin-bottom:18px;align-items:stretch;}
#page-admin .sys-cols > *{margin-bottom:0;min-width:0;}
@media(max-width:1000px){#page-admin .sys-cols{grid-template-columns:1fr;}}
/* Système: services as status cards, audit day headers, collapsible go-live checklist */
#page-admin .svc-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;}
#page-admin .svc-card{background:var(--adm-card2);border:1px solid var(--adm-line);border-left:3px solid var(--adm-green);border-radius:12px;padding:13px 15px;}
#page-admin .svc-card.down{border-left-color:var(--adm-red);}
#page-admin .svc-card.off{border-left-color:var(--adm-tx3);}
#page-admin .svc-h{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;}
#page-admin .svc-name{font-size:12.5px;font-weight:650;color:var(--adm-tx);min-width:0;}
#page-admin .svc-badge{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;flex-shrink:0;font-size:11px;font-weight:700;letter-spacing:.2px;padding:3px 9px;border-radius:20px;line-height:1.4;}
#page-admin .svc-badge .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}
#page-admin .svc-badge.up{background:rgba(52,211,153,.14);color:#6ee7bf;}
#page-admin .svc-badge.up .dot{background:#34d399;box-shadow:0 0 0 3px rgba(52,211,153,.16);}
#page-admin .svc-badge.down{background:rgba(248,113,113,.16);color:#fca5a5;}
#page-admin .svc-badge.down .dot{background:#f87171;box-shadow:0 0 0 3px rgba(248,113,113,.15);}
#page-admin .svc-badge.off{background:rgba(255,255,255,.05);color:var(--adm-tx3);}
#page-admin .svc-badge.off .dot{background:var(--adm-tx3);}
#page-admin .svc-lat{font-size:20px;font-weight:750;color:var(--adm-tx);margin-top:8px;font-variant-numeric:tabular-nums;}
#page-admin .svc-card.down .svc-lat{color:var(--adm-red);font-size:16px;}
#page-admin .svc-err{font-size:11px;color:#fca5a5;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#page-admin .audit-day{font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--adm-tx3);margin:16px 0 6px;}
#page-admin .audit-day:first-child{margin-top:2px;}
#page-admin .sys-gl-details{margin-top:12px;}
#page-admin .sys-gl-details summary{cursor:pointer;color:#a9bcff;font-size:12.5px;font-weight:600;list-style:none;}
#page-admin .sys-gl-details summary::-webkit-details-marker{display:none;}
#page-admin .sys-gl-details[open] summary{margin-bottom:9px;}
#page-admin .users-controls{display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap;}
#page-admin .users-controls input,#page-admin .users-controls select{background:var(--color-bg-secondary,#16161c);border:1px solid var(--color-border,#2a2a38);color:var(--color-text-primary,#fff);border-radius:8px;padding:8px 12px;font-size:13px;}
#page-admin .users-controls input{min-width:240px;flex:1;max-width:380px;}
#page-admin .users-controls button{background:var(--color-bg-secondary,#16161c);border:1px solid var(--color-border,#2a2a38);color:#a9bcff;border-radius:8px;padding:8px 13px;font-size:13px;cursor:pointer;font-weight:600;}
#page-admin .users-controls button:hover{border-color:#5b7cfa;}
#page-admin .users-controls button:disabled{opacity:.5;cursor:default;}
#page-admin .bulk-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:#5b7cfa12;border:1px solid #5b7cfa33;border-radius:9px;padding:9px 13px;margin-bottom:12px;font-size:13px;color:var(--color-text-primary,#e8e8ee);}
#page-admin .bulk-bar select{background:var(--color-bg-secondary,#16161c);border:1px solid var(--color-border,#2a2a38);color:#fff;border-radius:7px;padding:5px 9px;font-size:12px;}
#page-admin .bulk-bar button{background:var(--color-bg-secondary,#16161c);border:1px solid var(--color-border,#2a2a38);color:#a9bcff;border-radius:7px;padding:5px 11px;font-size:12px;cursor:pointer;font-weight:600;}
#page-admin .bulk-bar button:hover{border-color:#5b7cfa;}
#page-admin .bulk-bar button.danger{color:#ff6b6b;}
#page-admin .bulk-bar button.danger:hover{border-color:#e50914;background:#e5091412;}
#page-admin .users-pager{display:flex;align-items:center;gap:14px;margin-top:12px;}
#page-admin .users-pager button{background:var(--color-bg-secondary,#181820);color:var(--color-text-primary,#fff);border:1px solid var(--color-border,#2a2a38);border-radius:8px;padding:6px 12px;cursor:pointer;font-size:13px;}
#page-admin .users-pager button:disabled{opacity:.4;cursor:default;}
#page-admin .users-pager span{color:var(--color-text-secondary,#9aa);font-size:13px;font-variant-numeric:tabular-nums;}
#page-admin tr.user-row{cursor:pointer;}
#page-admin tr.user-row:hover{background:#ffffff0d;}
#page-admin .signup-origin{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:178px;white-space:normal;line-height:1.35;}
#page-admin .signup-origin-main{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--adm-tx);font-weight:600;}
#page-admin .signup-origin-loc{font-size:11.5px;color:var(--adm-tx2);}
#page-admin .signup-origin-note{font-size:10.5px;color:var(--adm-tx3);}
#page-admin .acq-note{margin-top:11px;padding:9px 11px;border-radius:10px;background:rgba(91,124,250,.08);border:1px solid rgba(91,124,250,.16);color:var(--adm-tx2);font-size:11.5px;line-height:1.5;}
#page-admin .crm-back{display:inline-flex;align-items:center;gap:7px;background:none;border:0;color:#a9bcff;cursor:pointer;font-size:13px;padding:0;margin-bottom:12px;transition:color .12s ease;}
#page-admin .crm-back::before{content:"";width:9px;height:9px;border-left:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg);transition:transform .12s ease;}
#page-admin .crm-back:hover{color:#cfd9ff;}
#page-admin .crm-back:hover::before{transform:rotate(45deg) translate(1px,-1px);}
#page-admin .fiche-head{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:4px;}
#page-admin .fiche-avatar{width:46px;height:46px;border-radius:50%;background:linear-gradient(135deg,#5b7cfa,#a855f7);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:#fff;flex-shrink:0;}
#page-admin .fiche-title{font-size:20px;font-weight:700;color:#fff;word-break:break-all;}
#page-admin .umeta{color:var(--color-text-secondary,#9aa);font-size:12px;margin:6px 0 20px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
#page-admin .fiche-grid{display:grid;grid-template-columns:1fr;gap:18px;}
/* Fiche: two-column desktop (relation client ‖ technique/ops); single column mobile */
#page-admin .fiche-cols{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start;}
#page-admin .fiche-col{display:flex;flex-direction:column;gap:18px;min-width:0;}
@media(max-width:1000px){#page-admin .fiche-cols{grid-template-columns:1fr;}}
#page-admin .fiche-summary{margin:2px 0 20px;flex-wrap:wrap;gap:10px 6px;}
#page-admin .fiche-summary .cs-item:last-child{border-right:0;}
/* Sensitive-actions zone (role / suspend), visually isolated from common actions */
#page-admin .act-zone{margin-top:14px;padding:12px 14px;border:1px dashed rgba(248,113,113,.3);border-radius:12px;background:rgba(248,113,113,.04);}
#page-admin .act-zone-h{font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:#fca5a5;margin-bottom:10px;display:flex;align-items:center;gap:6px;}
#page-admin .act-lbl{font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--adm-tx3);margin-bottom:9px;}
/* Key/value rows (billing / support panels) — shared classes replace per-line inline styles */
#page-admin .kv-row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid var(--adm-line);font-size:13px;}
#page-admin .kv-row:last-child{border-bottom:0;}
#page-admin .kv-l{color:var(--adm-tx2);}
#page-admin .kv-v{color:var(--adm-tx);font-weight:600;text-align:right;}
/* Clients: quick-view chips + stronger filter bar */
#page-admin .qv-row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;}
#page-admin .qv-chip{background:var(--adm-panel);border:1px solid var(--adm-line);color:var(--adm-tx2);border-radius:20px;padding:6px 13px;font-size:12.5px;font-weight:600;cursor:pointer;transition:border-color .14s,color .14s,background .14s;}
#page-admin .qv-chip:hover{border-color:#5b7cfa;color:var(--adm-tx);}
#page-admin .qv-chip.active{background:linear-gradient(135deg,rgba(91,124,250,.2),rgba(168,85,247,.16));border-color:rgba(120,150,255,.4);color:#fff;}
#page-admin .price-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;}
#page-admin .price-cell{display:flex;flex-direction:column;gap:6px;background:var(--adm-panel);border:1px solid var(--adm-line);border-radius:10px;padding:10px 12px;font-size:12.5px;color:var(--adm-tx2);}
#page-admin .price-cell .price-in{display:flex;align-items:center;gap:6px;color:var(--adm-tx);font-weight:700;}
#page-admin .price-cell input{width:96px;background:rgba(0,0,0,.25);border:1px solid var(--adm-line);border-radius:8px;color:var(--adm-tx);padding:6px 8px;font:inherit;}
#page-admin .price-cell input:focus-visible{outline:none;border-color:#5b7cfa;}
#page-admin .pev{position:relative;}
#page-admin .pev-btn{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;background:rgba(0,0,0,.25);border:1px solid var(--adm-line);border-radius:8px;color:var(--adm-tx);padding:7px 10px;font:inherit;font-size:12.5px;cursor:pointer;transition:border-color .14s;}
#page-admin .pev-btn:hover{border-color:#5b7cfa;}
#page-admin .pev-car{color:var(--adm-tx2);font-size:10px;}
#page-admin .pev-menu{position:absolute;z-index:40;top:calc(100% + 6px);left:0;right:0;max-height:264px;overflow:auto;background:#12161f;border:1px solid var(--adm-line);border-radius:10px;padding:6px;box-shadow:0 14px 36px rgba(0,0,0,.55);display:grid;gap:2px;}
#page-admin .pev-menu[hidden]{display:none;}
#page-admin .pev-opt{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:none;border:0;border-radius:7px;color:var(--adm-tx2);padding:7px 9px;font:inherit;font-size:12.5px;cursor:pointer;}
#page-admin .pev-opt:hover{background:rgba(91,124,250,.14);color:var(--adm-tx);}
#page-admin .pev-opt.on{background:linear-gradient(135deg,rgba(91,124,250,.2),rgba(168,85,247,.16));color:#fff;}
#page-admin .price-cell input.pev-label{width:100%;font-size:12px;}
#page-admin .price-cell .pcy-unit{font-style:normal;color:var(--adm-tx2);font-weight:500;font-size:11.5px;}
#page-admin .price-cell input[data-pcycles]{width:58px;}
#page-admin .refm{margin-left:6px;padding:4px 8px;border-radius:999px;border:1px solid var(--adm-line);background:rgba(0,0,0,.25);color:var(--adm-tx2);font:inherit;font-size:11px;font-weight:800;cursor:pointer;transition:border-color .14s,color .14s;}
#page-admin .refm:hover:not(:disabled){border-color:#5b7cfa;color:var(--adm-tx);}
#page-admin .refm.on{background:linear-gradient(135deg,rgba(91,124,250,.3),rgba(168,85,247,.25));border-color:#5b7cfa;color:#fff;}
#page-admin .refm:disabled{opacity:.35;cursor:default;}
#page-admin .mkt-notif-grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:18px;}
@media (max-width:900px){#page-admin .mkt-notif-grid{grid-template-columns:1fr;}}
#page-admin .mkt-notif-grid input[type=text],#page-admin .mkt-notif-grid textarea{width:100%;background:rgba(0,0,0,.25);border:1px solid var(--adm-line);border-radius:8px;color:var(--adm-tx);padding:9px 11px;font:inherit;font-size:13px;}
#page-admin .mkt-notif-grid textarea{resize:vertical;margin-top:6px;}
#page-admin .mkt-preview{border:1px solid var(--adm-line);border-radius:14px;background:#12161f;padding:12px 14px;box-shadow:0 10px 26px rgba(0,0,0,.4);}
#page-admin .mkt-pv-hd{display:flex;align-items:center;gap:6px;color:var(--adm-tx2);font-size:11px;margin-bottom:6px;}
#page-admin .mkt-pv-ic{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:4px;background:linear-gradient(135deg,#5b7cfa,#a855f7);color:#fff;font-size:10px;font-weight:900;}
#page-admin .mkt-pv-t{color:#fff;font-size:13px;font-weight:700;word-break:break-word;}
#page-admin .mkt-pv-b{color:var(--adm-tx2);font-size:12.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;}
#page-admin .mkt-log-clip{max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--adm-tx2);font-size:12px;}
#page-admin .mkt-td-wrap{white-space:normal;overflow:visible;text-overflow:clip;vertical-align:top;}
#page-admin .mkt-log-title{max-width:220px;min-width:120px;white-space:normal;word-break:break-word;line-height:1.4;font-size:12.5px;}
#page-admin .mkt-log-msg{max-width:460px;min-width:220px;white-space:normal;word-break:break-word;line-height:1.45;color:var(--adm-tx2);font-size:12px;}
#page-admin .mkt-log-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px;}
#page-admin #mkt-log-q{background:rgba(0,0,0,.25);border:1px solid var(--adm-line);border-radius:8px;color:var(--adm-tx);padding:8px 11px;font:inherit;font-size:12.5px;min-width:260px;}
#page-admin .price-cell.promo-on{border-color:rgba(255,128,103,.55);}
#page-admin .price-cell .pchip{display:inline-block;margin-left:6px;padding:2px 7px;border-radius:999px;font-size:9.5px;font-weight:900;letter-spacing:.04em;color:#0b1220;background:linear-gradient(135deg,#ff8067,#b579ff);}
#page-admin .price-cell .promo-sub{display:flex;flex-direction:column;gap:6px;margin-top:4px;padding-top:8px;border-top:1px dashed var(--adm-line);}
#page-admin .price-cell .promo-sub select,#page-admin .price-cell .promo-sub input[type="datetime-local"]{background:rgba(0,0,0,.25);border:1px solid var(--adm-line);border-radius:8px;color:var(--adm-tx);padding:6px 8px;font:inherit;font-size:12px;width:100%;}
#page-admin .filter-bar{background:var(--adm-panel);border:1px solid var(--adm-line);border-radius:14px;padding:12px 14px;margin-bottom:14px;}
#page-admin .filter-bar .fb-h{font-size:10.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--adm-tx3);margin-bottom:10px;display:flex;align-items:center;gap:6px;}
#page-admin .filter-bar .users-controls{margin-bottom:0;}
#page-admin .soon{color:#828ea1;font-size:13px;font-style:italic;}
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
#page-admin .note-meta{color:#828ea1;font-size:11px;margin-top:3px;}
#page-admin .note-meta .crm-note-del{background:none;border:0;color:#ff6b6b;cursor:pointer;font-size:11px;margin-left:8px;}
#page-admin .note-meta .crm-note-del:hover{color:#ff9b9b;text-decoration:underline;}
#page-admin .tl{display:flex;flex-direction:column;}
#page-admin .tl-item{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--color-border,#1b1b24);}
#page-admin .tl-ic{width:22px;text-align:center;}
#page-admin .tl-sum{flex:1;font-size:13px;color:var(--color-text-primary,#e8e8ee);}
#page-admin .tl-at{color:#828ea1;font-size:11px;white-space:nowrap;}
#page-admin .audit-row[data-user-id]{cursor:pointer;}
#page-admin .audit-row[data-user-id]:hover{background:#ffffff0a;}
#page-admin .alert-card{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:linear-gradient(90deg,rgba(248,113,113,.14),rgba(248,113,113,.03));border:1px solid rgba(248,113,113,.28);border-left:3px solid #ef4444;border-radius:12px;padding:13px 16px;margin-bottom:9px;box-shadow:0 4px 16px rgba(239,68,68,.10);}
#page-admin .alert-card[data-user-id]{cursor:pointer;}
#page-admin .alert-card[data-user-id]:hover{background:linear-gradient(90deg,rgba(248,113,113,.20),rgba(248,113,113,.05));}
/* Amber-severity system alerts get amber chrome so the card frame matches its badge (triage). */
#page-admin .alert-card.amber{background:linear-gradient(90deg,rgba(251,191,36,.13),rgba(251,191,36,.03));border-color:rgba(251,191,36,.30);border-left-color:#f59e0b;box-shadow:0 4px 16px rgba(245,158,11,.10);}
#page-admin .alert-card.amber[data-route]:hover{background:linear-gradient(90deg,rgba(251,191,36,.19),rgba(251,191,36,.05));}
#page-admin .alert-card .al-name{font-weight:600;color:var(--adm-tx);}
/* Non-colour-only severity chip on alert cards */
#page-admin .sev-chip{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:2px 7px;border-radius:6px;flex-shrink:0;}
#page-admin .sev-chip.red{background:rgba(248,113,113,.2);color:#fca5a5;box-shadow:inset 0 0 0 1px rgba(248,113,113,.35);}
#page-admin .sev-chip.amber{background:rgba(251,191,36,.18);color:#fcd34d;box-shadow:inset 0 0 0 1px rgba(251,191,36,.3);}
/* Cockpit executive-read summary band */
#page-admin .cockpit-summary{display:flex;align-items:center;gap:6px;flex-wrap:wrap;background:linear-gradient(158deg,var(--adm-card1),var(--adm-card2));border:1px solid var(--adm-line);border-radius:16px;padding:13px 18px;margin-bottom:22px;box-shadow:0 2px 12px rgba(0,0,0,.24);}
#page-admin .cockpit-summary.is-loading{min-height:64px;}
#page-admin .cockpit-summary.ok{border-color:rgba(52,211,153,.24);}
#page-admin .cockpit-summary.warn{border-color:rgba(251,191,36,.3);}
#page-admin .cockpit-summary.alert{border-color:rgba(248,113,113,.34);}
#page-admin .cs-item{display:flex;align-items:center;gap:11px;padding:3px 22px 3px 0;margin-right:2px;border-right:1px solid var(--adm-line);}
#page-admin .cs-ic{width:38px;height:38px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;background:rgba(120,150,255,.1);border:1px solid rgba(120,150,255,.16);}
#page-admin .cs-item.ok .cs-ic{background:rgba(52,211,153,.12);border-color:rgba(52,211,153,.2);}
#page-admin .cs-item.warn .cs-ic{background:rgba(251,191,36,.12);border-color:rgba(251,191,36,.2);}
#page-admin .cs-item.alert .cs-ic{background:rgba(248,113,113,.12);border-color:rgba(248,113,113,.2);}
#page-admin .cs-v{font-size:19px;font-weight:750;color:var(--adm-tx);line-height:1.1;white-space:nowrap;}
#page-admin .cs-item.ok .cs-v{color:var(--adm-green);}
#page-admin .cs-item.warn .cs-v{color:var(--adm-amber);}
#page-admin .cs-item.alert .cs-v{color:var(--adm-red);}
#page-admin .cs-l{font-size:10.5px;color:var(--adm-tx2);margin-top:3px;text-transform:uppercase;letter-spacing:.4px;}
#page-admin .cs-cta{margin-left:auto;background:linear-gradient(135deg,#5b7cfa,#7c6cf5);color:#fff;border:0;border-radius:10px;padding:9px 15px;font-weight:600;font-size:13px;cursor:pointer;box-shadow:0 5px 16px rgba(91,124,250,.3);transition:filter .12s;}
#page-admin .cs-cta:hover{filter:brightness(1.07);}
#page-admin .cs-ok{margin-left:auto;color:var(--adm-green);font-weight:600;font-size:13px;padding-right:4px;}
@media(max-width:820px){#page-admin .cs-item{border-right:0;padding-right:10px;}#page-admin .cs-cta,#page-admin .cs-ok{margin-left:0;}}
/* Priority ("Top signals") group — visually dominant over the secondary groups */
#page-admin .kpi-group--priority{border-color:rgba(120,150,255,.22);background:linear-gradient(158deg,rgba(91,124,250,.07),var(--adm-panel));box-shadow:0 4px 20px rgba(91,124,250,.08);}
#page-admin .kpi-group--priority .kpi{padding:17px 18px 15px;}
/* Vertical stat-card: icon on its own top row, big value on a full-width line below.
   Gives wide currency values the whole card width (no clipping / no icon overlap). */
#page-admin .kpi-group--priority .kpi-hd{flex-direction:column-reverse;align-items:flex-start;gap:11px;}
#page-admin .kpi-group--priority .kpi .v{font-size:27px;white-space:nowrap;letter-spacing:-.6px;font-variant-numeric:tabular-nums;}
/* Non-colour state chip on priority KPI cards */
#page-admin .kpi-state{display:inline-block;margin-left:8px;font-size:9px;font-weight:700;letter-spacing:.4px;padding:2px 6px;border-radius:5px;vertical-align:middle;}
#page-admin .kpi-state.ok{background:rgba(52,211,153,.16);color:#6ee7bf;}
#page-admin .kpi-state.warn{background:rgba(251,191,36,.18);color:#fcd34d;}
#page-admin .kpi-state.crit{background:rgba(248,113,113,.2);color:#fca5a5;}
/* Alerts grouped by family */
#page-admin .alert-fam{margin-bottom:15px;}
#page-admin .alert-fam:last-child{margin-bottom:0;}
#page-admin .alert-fam-h{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--adm-tx2);margin:0 0 9px 2px;}
#page-admin .alert-fam-h .pacct{color:var(--adm-tx3);margin-left:2px;}
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
#page-admin .flag-del{background:none;border:0;color:#ff6b6b;cursor:pointer;font-size:19px;line-height:1;}
#page-admin .flag-del:hover{color:#ff9b9b;}
#page-admin .flag-add{margin-top:12px;}
#page-admin .flag-row--managed{margin:6px 0;padding:12px 13px;background:linear-gradient(135deg,rgba(91,124,250,.08),rgba(168,85,247,.035));border:1px solid rgba(91,124,250,.2);border-radius:11px;}
#page-admin .flag-managed-signal{width:10px;height:10px;flex:0 0 auto;border-radius:50%;background:var(--adm-tx3);box-shadow:0 0 0 4px rgba(130,141,163,.12);}
#page-admin .flag-managed-signal.is-on{background:var(--adm-green);box-shadow:0 0 0 4px rgba(52,211,153,.13);}
#page-admin .flag-managed-detail{display:flex;flex-wrap:wrap;align-items:center;gap:6px 9px;margin-top:5px;color:var(--adm-tx3);font-size:11px;line-height:1.4;}
#page-admin .flag-managed-badge{display:inline-flex;align-items:center;min-height:24px;padding:2px 8px;border:1px solid rgba(91,124,250,.28);border-radius:999px;color:#aebdff;background:rgba(91,124,250,.09);font-weight:700;letter-spacing:.2px;}
#page-admin .flag-managed-state{flex:0 0 auto;min-width:74px;padding:5px 9px;border:1px solid var(--adm-line);border-radius:8px;color:var(--adm-tx2);background:var(--adm-card2);font-size:11.5px;font-weight:700;text-align:center;}
#page-admin .flag-managed-state.is-on{color:var(--adm-green);border-color:rgba(52,211,153,.25);background:rgba(52,211,153,.06);}
#page-admin .partners-admin-toolbar{display:grid;grid-template-columns:minmax(220px,1fr) minmax(180px,260px);gap:12px;margin:16px 0;}
#page-admin .partners-admin-toolbar input,#page-admin .partners-admin-toolbar select{min-height:44px;padding:9px 12px;border:1px solid var(--adm-line);border-radius:9px;background:var(--adm-card2);color:var(--adm-tx1);font:inherit;}
#page-admin .partners-workspace-nav{position:sticky;top:71px;z-index:4;display:flex;gap:6px;margin:16px 0;padding:7px;overflow-x:auto;overscroll-behavior-inline:contain;scroll-padding-inline:7px;scrollbar-width:thin;border:1px solid var(--adm-line);border-radius:12px;background:rgba(10,13,22,.94);backdrop-filter:blur(12px);box-shadow:0 12px 30px rgba(0,0,0,.2);}
#page-admin .partners-workspace-tab{min-height:44px;flex:0 0 auto;padding:9px 13px;scroll-margin-inline:7px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--adm-tx2);font:inherit;font-size:12px;font-weight:750;cursor:pointer;white-space:nowrap;}
#page-admin .partners-workspace-tab:hover{color:var(--adm-tx);background:var(--adm-card2);}
#page-admin .partners-workspace-tab[aria-selected="true"]{color:var(--adm-tx);border-color:rgba(91,124,250,.35);background:linear-gradient(135deg,rgba(91,124,250,.18),rgba(168,85,247,.1));box-shadow:inset 0 0 0 1px rgba(124,150,255,.08);}
#page-admin #crm-refresh:focus-visible,#page-admin .partners-workspace-tab:focus-visible,#page-admin .partners-action:focus-visible,#page-admin .partners-page-btn:focus-visible,#page-admin .partners-overview-item:focus-visible,#page-admin .partner-open:focus-visible{outline:2px solid #7c96ff;outline-offset:2px;}
#page-admin .partners-sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important;}
#page-admin .partners-pane[hidden]{display:none!important;}
#page-admin .partners-pane{display:grid;gap:16px;min-width:0;}
#page-admin .partners-pane > *{width:100%;min-width:0;max-width:100%;box-sizing:border-box;}
#page-admin .partners-pane-intro{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;min-width:0;}
#page-admin .partners-pane-intro > *{min-width:0;max-width:100%;}
#page-admin .partners-pane-intro h2{margin:0 0 5px;color:var(--adm-tx);font-size:18px;}
#page-admin .partners-pane-intro p{margin:0;color:var(--adm-tx3);font-size:12px;line-height:1.5;}
#page-admin .partners-priority-strip{min-height:64px;padding:13px 15px;border:1px solid var(--adm-line);border-left:3px solid var(--adm-green);border-radius:11px;background:var(--adm-card);}
#page-admin .partners-priority-strip.is-alert{border-left-color:var(--adm-red);background:linear-gradient(135deg,rgba(248,113,113,.08),var(--adm-card));}
#page-admin .partners-priority-strip strong,#page-admin .partners-priority-strip span{display:block;}
#page-admin .partners-priority-strip span{margin-top:4px;color:var(--adm-tx2);font-size:12px;line-height:1.45;}
#page-admin .partners-aal2-gate{display:flex;align-items:center;justify-content:space-between;gap:16px;border-left-color:var(--adm-amber);background:linear-gradient(135deg,rgba(251,191,36,.09),var(--adm-card));}
#page-admin .partners-aal2-gate[hidden]{display:none!important;}
#page-admin .partners-aal2-gate .partners-action{flex:0 0 auto;min-height:44px;}
@media(max-width:820px){#page-admin .partners-aal2-gate{align-items:stretch;flex-direction:column;}#page-admin .partners-aal2-gate .partners-action{width:100%;}}
#page-admin .partners-overview-list{padding:0;overflow:hidden;}
#page-admin .partners-overview-list-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 17px;border-bottom:1px solid var(--adm-line);}
#page-admin .partners-overview-list-head h2{margin:0;color:var(--adm-tx);font-size:15px;}
#page-admin .partners-overview-items{display:grid;}
#page-admin .partners-overview-item{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;padding:9px 17px;border:0;border-bottom:1px solid var(--adm-line2);background:transparent;color:var(--adm-tx);text-align:left;cursor:pointer;}
#page-admin .partners-overview-item:last-child{border-bottom:0;}
#page-admin .partners-overview-item:hover{background:var(--adm-card2);}
#page-admin .partners-overview-item span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700;}
#page-admin .partners-overview-item small{flex:0 0 auto;color:var(--adm-tx3);font-size:11px;}
#page-admin .partners-route-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin:12px 0;}
#page-admin .partners-routes-toolbar{display:grid;grid-template-columns:minmax(180px,1fr) minmax(150px,220px);gap:10px;margin:12px 0;}
#page-admin .partners-routes-toolbar input,#page-admin .partners-routes-toolbar select{min-height:44px;padding:9px 12px;border:1px solid var(--adm-line);border-radius:9px;background:var(--adm-card2);color:var(--adm-tx);font:inherit;}
#page-admin .partners-admin-toolbar input:focus-visible,#page-admin .partners-admin-toolbar select:focus-visible,#page-admin .partners-routes-toolbar input:focus-visible,#page-admin .partners-routes-toolbar select:focus-visible,#page-admin .partners-control-head select:focus-visible{outline:2px solid #7c96ff;outline-offset:2px;border-color:#7c96ff;}
#page-admin .partners-route-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin:0;padding:0;list-style:none;}
#page-admin .partners-route-list .partners-control-item{min-width:0;}
#page-admin .partners-pagination{display:flex;align-items:center;justify-content:flex-end;gap:9px;margin-top:12px;}
#page-admin .partners-pagination-status{margin-right:auto;color:var(--adm-tx3);font-size:11px;}
#page-admin .partners-page-btn{min-width:44px;min-height:44px;padding:8px 12px;border:1px solid var(--adm-line);border-radius:9px;background:var(--adm-card2);color:var(--adm-tx2);font:inherit;cursor:pointer;}
#page-admin .partners-page-btn:disabled{opacity:.45;cursor:not-allowed;}
#page-admin .partners-admin-readiness{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;min-width:0;max-width:100%;margin:16px 0;}
#page-admin .partners-admin-cap{min-width:0;max-width:100%;min-height:112px;padding:14px;border:1px solid var(--adm-line);border-radius:11px;background:var(--adm-card);box-sizing:border-box;}
#page-admin .partners-admin-cap strong{display:block;margin-bottom:6px;color:var(--adm-tx1);}
#page-admin .partners-admin-cap span{color:var(--adm-tx3);font-size:12px;line-height:1.5;}
#page-admin .partners-admin-cap.is-ready{border-color:rgba(52,211,153,.3);background:rgba(52,211,153,.045);}
#page-admin .partners-admin-cap .partners-action-row{margin-top:12px;}
#page-admin .partners-operator-manager{grid-column:1/-1;padding:16px;border:1px solid var(--adm-line);border-radius:11px;background:var(--adm-card);}
#page-admin .partners-operator-manager-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px;}
#page-admin .partners-operator-manager-head h3{margin:0 0 4px;color:var(--adm-tx1);font-size:15px;}
#page-admin .partners-operator-manager-head p{margin:0;color:var(--adm-tx3);font-size:12px;line-height:1.5;}
#page-admin .partners-operator-table-wrap{overflow-x:auto;border:1px solid var(--adm-line);border-radius:10px;}
#page-admin .partners-operator-table{width:100%;border-collapse:collapse;min-width:720px;}
#page-admin .partners-operator-table th,#page-admin .partners-operator-table td{padding:11px 12px;border-bottom:1px solid var(--adm-line);text-align:left;vertical-align:middle;}
#page-admin .partners-operator-table tr:last-child td{border-bottom:0;}
#page-admin .partners-operator-table th{color:var(--adm-tx3);font-size:11px;text-transform:uppercase;letter-spacing:.06em;}
#page-admin .partners-operator-identity strong{display:block;color:var(--adm-tx1);font-size:13px;}
#page-admin .partners-operator-status{display:flex;flex-wrap:wrap;gap:6px;margin-top:5px;}
#page-admin .partners-operator-chip{display:inline-flex;align-items:center;min-height:24px;padding:3px 8px;border-radius:999px;background:rgba(148,163,184,.1);color:var(--adm-tx3);font-size:11px;}
#page-admin .partners-operator-chip.is-ready{background:rgba(52,211,153,.11);color:var(--adm-green);}
#page-admin .partners-operator-actions{display:flex;flex-wrap:wrap;gap:6px;}
#page-admin .partners-operator-actions .partners-action{min-height:44px;}
#page-admin .partners-ops-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:16px 0;}
#page-admin .partners-ops-card{min-width:0;padding:16px;border:1px solid var(--adm-line);border-radius:11px;background:var(--adm-card);}
#page-admin .partners-ops-card h2{margin:0 0 5px;font-size:15px;color:var(--adm-tx1);}
#page-admin .partners-ops-card p{margin:0 0 12px;color:var(--adm-tx3);font-size:12px;line-height:1.5;}
#page-admin .partners-ops-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;}
#page-admin .partners-ops-stat{padding:10px;border:1px solid var(--adm-line);border-radius:9px;background:var(--adm-card2);}
#page-admin .partners-ops-stat strong,#page-admin .partners-ops-stat span{display:block;}
#page-admin .partners-ops-stat strong{font-size:16px;color:var(--adm-tx1);}
#page-admin .partners-ops-stat span{margin-top:3px;color:var(--adm-tx3);font-size:10px;line-height:1.3;}
#page-admin .partners-ops-list{display:grid;gap:7px;}
#page-admin .partners-ops-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--adm-line);font-size:12px;}
#page-admin .partners-ops-row:last-child{border-bottom:0;}
#page-admin .partners-ops-row span{min-width:0;overflow-wrap:anywhere;color:var(--adm-tx2);}
#page-admin .partners-ops-row strong{color:var(--adm-tx1);text-align:right;}
#page-admin .partners-control-stack{display:grid;gap:16px;min-width:0;max-width:100%;margin:16px 0;}
#page-admin .partners-control-card{min-width:0;max-width:100%;padding:17px;border:1px solid var(--adm-line);border-radius:12px;background:linear-gradient(145deg,var(--adm-card),rgba(91,124,250,.025));box-sizing:border-box;}
#page-admin .partners-control-card > *{min-width:0;max-width:100%;}
#page-admin .partners-control-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:12px;}
#page-admin .partners-control-head > *{min-width:0;max-width:100%;}
#page-admin .partners-control-head h2,#page-admin .partners-control-head h3{margin:0 0 4px;color:var(--adm-tx1);font-size:15px;}
#page-admin .partners-control-head p{margin:0;color:var(--adm-tx3);font-size:12px;line-height:1.5;}
#page-admin .partners-control-head select{min-height:44px;padding:8px 10px;border:1px solid var(--adm-line);border-radius:8px;background:var(--adm-card2);color:var(--adm-tx);font:inherit;}
#page-admin .partners-control-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;min-width:0;max-width:100%;}
#page-admin .partners-control-item{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;max-width:100%;min-height:58px;padding:10px 12px;border:1px solid var(--adm-line);border-radius:10px;background:var(--adm-card2);box-sizing:border-box;}
#page-admin .partners-kyc-certification{margin-top:12px;}
#page-admin .partners-control-item > span{flex:1 1 auto;min-width:0;color:var(--adm-tx2);font-size:12px;overflow-wrap:anywhere;}
#page-admin .partners-control-item small{display:block;margin-top:3px;color:var(--adm-tx3);font-size:10px;line-height:1.35;}
#page-admin .partners-access-request-item{align-items:flex-start;}
#page-admin .partners-access-request-main{display:flex;flex:0 0 min(240px,32%);flex-wrap:wrap;align-items:center;gap:7px;min-width:0;}
#page-admin .partners-access-request-main strong{min-width:0;color:var(--adm-tx1);font-size:12px;overflow-wrap:anywhere;}
#page-admin .partners-access-request-copy{flex:1 1 260px;margin:2px 0;color:var(--adm-tx2);font-size:11px;line-height:1.45;overflow-wrap:anywhere;}
#page-admin .partners-action-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-width:0;max-width:100%;}
#page-admin .partners-action{min-height:44px;padding:9px 12px;border:1px solid rgba(91,124,250,.35);border-radius:9px;background:rgba(91,124,250,.09);color:#c9d3ff;font:inherit;font-size:12px;font-weight:750;cursor:pointer;}
#page-admin .partners-action:hover{border-color:#7c96ff;background:rgba(91,124,250,.16);}
#page-admin .partners-action:disabled,#page-admin .partners-action[aria-disabled="true"]{opacity:.55;cursor:progress;}
#page-admin .partners-action.is-danger{border-color:rgba(239,68,68,.35);background:rgba(239,68,68,.06);color:#ff9a9a;}
#page-admin .partners-action.is-success{border-color:rgba(52,211,153,.35);background:rgba(52,211,153,.06);color:#79e6bc;}
#page-admin .partners-state{display:inline-flex;align-items:center;min-height:26px;padding:3px 8px;border:1px solid var(--adm-line);border-radius:999px;background:var(--adm-card2);color:var(--adm-tx3);font-size:10px;font-weight:800;white-space:nowrap;}
#page-admin .partners-state.is-on{border-color:rgba(52,211,153,.3);background:rgba(52,211,153,.07);color:var(--adm-green);}
#page-admin .partners-state.is-alert{border-color:rgba(239,68,68,.3);background:rgba(239,68,68,.06);color:#ff8585;}
#page-admin .partners-mini-chart{display:grid;grid-template-columns:repeat(30,minmax(3px,1fr));align-items:end;gap:3px;height:72px;margin-top:12px;}
#page-admin .partners-mini-chart span{display:block;min-height:3px;border-radius:3px 3px 1px 1px;background:linear-gradient(180deg,#7c96ff,#7457e8);opacity:.85;}
#page-admin .partners-analytics-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px;}
#page-admin .partners-analytics-section{min-width:0;padding:13px;border:1px solid var(--adm-line);border-radius:10px;background:var(--adm-card2);}
#page-admin .partners-analytics-section h3{margin:0 0 9px;color:var(--adm-tx1);font-size:12px;}
#page-admin .partners-analytics-section .partners-ops-stats{grid-template-columns:repeat(2,minmax(0,1fr));}
#page-admin .partners-analytics-section .partners-ops-row{font-size:11px;}
#page-admin .partners-analytics-note{margin-top:8px;color:var(--adm-tx3);font-size:10px;line-height:1.45;}
#page-admin .partners-analytics-wide{grid-column:1/-1;}
#page-admin .partners-risk-actions{display:flex;flex:0 1 auto;flex-wrap:wrap;justify-content:flex-end;gap:6px;min-width:0;max-width:100%;}
#page-admin .partners-control-head > .partners-state,#page-admin .partners-action-row > .partners-state,#page-admin .partners-risk-actions .partners-state{max-width:100%;white-space:normal;overflow-wrap:anywhere;line-height:1.35;text-align:left;}
#page-admin .partners-risk-actions .partners-action{min-height:44px;padding:9px 12px;font-size:12px;}
#page-admin .partners-table-wrap{max-width:100%;overflow-x:auto;border:1px solid var(--adm-line);border-radius:12px;background:var(--adm-card);}
#page-admin .partners-table{width:100%;border-collapse:collapse;table-layout:fixed;}
#page-admin .partners-table caption{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}
#page-admin .partners-table th,#page-admin .partners-table td{padding:11px 12px;border-bottom:1px solid var(--adm-line);white-space:normal;overflow-wrap:anywhere;text-overflow:clip;}
#page-admin .partners-table th{color:var(--adm-tx3);font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;}
#page-admin .partners-table tbody tr:last-child td{border-bottom:0;}
#page-admin .partner-row:hover td{background:var(--adm-card2);}
#page-admin .partner-open{width:100%;min-height:44px;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--adm-tx1);font:inherit;font-weight:750;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;}
#page-admin .partner-open:hover{background:rgba(91,124,250,.1);}
#page-admin .partner-ref{min-width:0;color:var(--adm-tx1);font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#page-admin .partner-meta{color:var(--adm-tx3);font-size:12px;}
#page-admin .partners-detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:16px;}
#page-admin .partners-detail-grid .section{min-width:0;}
#page-admin .partners-event-list{display:grid;gap:8px;margin-top:10px;}
#page-admin .partners-event{display:grid;grid-template-columns:minmax(120px,.8fr) minmax(180px,1.5fr) minmax(130px,.8fr);gap:10px;padding:10px 0;border-bottom:1px solid var(--adm-line);font-size:12px;}
#page-admin .partners-event:last-child{border-bottom:0;}
#page-admin .switch{position:relative;display:inline-block;width:40px;height:22px;flex-shrink:0;}
#page-admin .switch input{opacity:0;width:0;height:0;}
#page-admin .switch .slider{position:absolute;inset:0;background:#3a3a44;border-radius:22px;transition:.2s;cursor:pointer;}
#page-admin .switch .slider:before{content:"";position:absolute;height:16px;width:16px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.2s;}
#page-admin .switch input:checked+.slider{background:#3ecf8e;}
#page-admin .switch input:checked+.slider:before{transform:translateX(18px);}
/* Breadcrumb can be a long email — keep it on one line with ellipsis so it never pushes the topbar controls off-screen. */
#page-admin .crm-crumb{max-width:min(52vw,560px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
/* Timeline/audit summaries: flex child needs min-width:0 to actually ellipsis/wrap instead of overflowing. */
#page-admin .tl-sum{min-width:0;overflow-wrap:anywhere;}
/* Visible keyboard focus for the interactive rows/cards/tabs/nav. */
#page-admin .user-row:focus-visible,#page-admin .partner-row:focus-visible,#page-admin .alert-card:focus-visible,#page-admin .audit-row:focus-visible,#page-admin .tl-item[data-ticket-id]:focus-visible,#page-admin .fin-status:focus-visible,#page-admin .sup-tab:focus-visible,#page-admin .crm-nav-item:focus-visible,#page-admin .crm-back:focus-visible{outline:2px solid #7c96ff;outline-offset:-2px;border-radius:6px;}
/* Toasts + modal confirm/prompt (replace native alert/confirm/prompt). Scoped under #page-admin so the tokens apply. */
#page-admin .crm-toasts{position:fixed;right:18px;bottom:18px;z-index:60;display:flex;flex-direction:column;gap:8px;max-width:min(92vw,380px);}
#page-admin .crm-toast{background:var(--color-bg-secondary,#16161c);border:1px solid var(--color-border,#2a2a38);border-left:3px solid #5b7cfa;border-radius:9px;padding:11px 14px;font-size:13px;color:var(--color-text-primary,#e8e8ee);box-shadow:0 10px 30px #0009;animation:crmtoast .2s ease both;}
#page-admin .crm-toast.ok{border-left-color:#3ecf8e;}
#page-admin .crm-toast.err{border-left-color:#ff6b6b;}
@keyframes crmtoast{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}
@media(prefers-reduced-motion:reduce){#page-admin .crm-toast,#page-admin .crm-modal-back{animation:none;}}
#page-admin .crm-modal-back{position:fixed;inset:0;z-index:70;background:#000b;display:flex;align-items:center;justify-content:center;padding:20px;animation:crmtoast .15s ease both;}
#page-admin .crm-modal{background:var(--color-bg-secondary,#16161c);border:1px solid var(--color-border,#2a2a38);border-radius:14px;padding:20px 22px;max-width:440px;width:100%;box-shadow:0 24px 70px #000b;}
#page-admin .crm-modal.is-wide{max-width:720px;}
#page-admin .crm-modal h3{margin:0 0 8px;font-size:16px;color:var(--color-text-primary,#fff);}
#page-admin .crm-modal p{margin:0 0 16px;font-size:13.5px;color:var(--color-text-secondary,#9aa);line-height:1.55;white-space:pre-wrap;word-break:break-word;}
#page-admin .crm-modal-input{width:100%;min-height:44px;background:var(--color-bg-primary,#0d0d0f);border:1px solid var(--color-border,#2a2a38);color:#fff;border-radius:8px;padding:9px 12px;font-size:14px;margin-bottom:16px;}
#page-admin textarea.crm-modal-input{min-height:180px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;line-height:1.45;}
#page-admin .crm-modal .mrow{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;}
#page-admin .crm-modal button{min-height:44px;border-radius:8px;padding:8px 15px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--color-border,#2a2a38);background:var(--color-bg-primary,#0d0d0f);color:var(--color-text-primary,#fff);}
#page-admin .crm-modal button.primary{background:#5b7cfa;border-color:#5b7cfa;color:#fff;}
#page-admin .crm-modal button.danger{background:#e50914;border-color:#e50914;color:#fff;}
#page-admin .crm-modal button:disabled{opacity:.52;cursor:not-allowed;}
#page-admin .partners-kyc-guide{max-height:min(860px,calc(100dvh - 40px));overflow:auto;overscroll-behavior:contain;padding-bottom:max(20px,env(safe-area-inset-bottom,0px));}
#page-admin .partners-kyc-guide-head{display:grid;gap:6px;margin-bottom:16px;}
#page-admin .partners-kyc-guide-head p{margin:0;}
#page-admin .partners-kyc-guide-list{display:grid;gap:8px;margin:0 0 18px;padding:0;list-style:none;}
#page-admin .partners-kyc-guide-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:11px 12px;border:1px solid var(--adm-line);border-radius:10px;background:var(--adm-card2);}
#page-admin .partners-kyc-guide-item strong{display:block;color:var(--adm-tx);font-size:13px;line-height:1.35;}
#page-admin .partners-kyc-guide-item small{display:block;margin-top:3px;color:var(--adm-tx3);font-size:11px;line-height:1.4;}
#page-admin .partners-kyc-guide-state{display:inline-flex;align-items:center;min-height:26px;padding:3px 9px;border:1px solid var(--adm-line);border-radius:999px;color:var(--adm-tx2);font-size:10px;font-weight:800;white-space:nowrap;}
#page-admin .partners-kyc-guide-item.is-ready .partners-kyc-guide-state{border-color:rgba(52,211,153,.34);background:rgba(52,211,153,.08);color:var(--adm-green);}
#page-admin .partners-kyc-guide-item.is-blocked .partners-kyc-guide-state{border-color:rgba(248,113,113,.38);background:rgba(248,113,113,.08);color:var(--adm-red);}
#page-admin .partners-kyc-guide-form{display:grid;gap:14px;margin-top:4px;}
#page-admin .partners-kyc-guide-field{display:grid;gap:7px;min-width:0;}
#page-admin .partners-kyc-guide-field label,#page-admin .partners-kyc-guide-field legend{color:var(--adm-tx);font-size:12.5px;font-weight:700;}
#page-admin .partners-kyc-guide-field small{color:var(--adm-tx3);font-size:11px;line-height:1.4;}
#page-admin .partners-kyc-guide-field input,#page-admin .partners-kyc-guide-field select,#page-admin .partners-kyc-guide-field textarea{box-sizing:border-box;width:100%;min-height:44px;border:1px solid var(--adm-line);border-radius:9px;background:var(--adm-bg);color:var(--adm-tx);font:inherit;font-size:13px;padding:10px 12px;}
#page-admin .partners-kyc-guide-field textarea{min-height:92px;resize:vertical;line-height:1.45;}
#page-admin .partners-kyc-guide-consent{display:grid;grid-template-columns:22px minmax(0,1fr);gap:10px;align-items:start;padding:12px;border:1px solid var(--adm-line);border-radius:10px;background:var(--adm-card2);color:var(--adm-tx2);font-size:12px;line-height:1.5;}
#page-admin .partners-kyc-guide-consent input{width:20px;height:20px;margin:1px 0 0;accent-color:var(--adm-blue);}
#page-admin .partners-kyc-guide-alert{margin:0 0 14px;padding:11px 12px;border:1px solid rgba(248,113,113,.38);border-radius:10px;background:rgba(248,113,113,.08);color:var(--adm-red);font-size:12px;line-height:1.5;}
#page-admin .partners-kyc-guide-note{margin:0 0 14px;padding:11px 12px;border:1px solid rgba(91,124,250,.32);border-radius:10px;background:rgba(91,124,250,.08);color:var(--adm-tx2);font-size:12px;line-height:1.5;}
#page-admin .partners-kyc-guide .mrow{position:sticky;bottom:calc(-1 * max(20px,env(safe-area-inset-bottom,0px)));margin:18px -22px calc(-1 * max(20px,env(safe-area-inset-bottom,0px)));padding:14px 22px max(14px,env(safe-area-inset-bottom,0px));border-top:1px solid var(--adm-line);background:var(--color-bg-secondary,#16161c);}
@media(max-width:1180px){
  #page-admin .partners-control-grid{grid-template-columns:1fr;}
}
@media(max-width:900px){
  #page-admin .crm-sidebar{width:60px;padding:14px 8px;}
  #page-admin .crm-nav-item .lb,#page-admin .crm-brand span:last-child,#page-admin .crm-side-foot,#page-admin .crm-nav-sec{display:none;}
  #page-admin .crm-nav-item{justify-content:center;gap:0;position:relative;}
  /* .lb (with its ticket count) is hidden on the rail — surface a red dot on the icon instead. */
  #page-admin .crm-nav-item.has-alerts::after{content:"";position:absolute;top:8px;right:12px;width:8px;height:8px;border-radius:50%;background:#e50914;box-shadow:0 0 0 2px var(--color-bg-primary,#0d0d0f);}
  #page-admin .crm-page{padding:20px 16px max(80px,calc(24px + env(safe-area-inset-bottom,0px)));}
  #page-admin .crm-topbar{padding:12px 16px;}
  #page-admin .tk-back-bar{top:66px;}  /* mobile topbar measures ~66px */
  #page-admin .crm-crumb{max-width:56vw;}
  #page-admin .users-controls input{min-width:0;}
  #page-admin .partners-admin-readiness{grid-template-columns:1fr;}
  #page-admin .partners-operator-manager{padding:13px;}
  #page-admin .partners-operator-manager-head{display:block;}
  #page-admin .partners-operator-table-wrap{border:0;overflow:visible;}
  #page-admin .partners-operator-table{display:block;min-width:0;}
  #page-admin .partners-operator-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;}
  #page-admin .partners-operator-table tbody,#page-admin .partners-operator-table tr,#page-admin .partners-operator-table td{display:block;width:100%;}
  #page-admin .partners-operator-table tr{padding:12px;border:1px solid var(--adm-line);border-radius:10px;margin-top:10px;}
  #page-admin .partners-operator-table td{padding:8px 0;border:0;}
  #page-admin .partners-operator-table td::before{content:attr(data-label);display:block;margin-bottom:5px;color:var(--adm-tx3);font-size:10px;text-transform:uppercase;letter-spacing:.06em;}
  #page-admin .partners-workspace-nav{top:69px;}
  #page-admin .partners-detail-grid{grid-template-columns:1fr;}
  #page-admin .partners-ops-grid{grid-template-columns:1fr;}
  #page-admin .partners-control-grid{grid-template-columns:1fr;}
  #page-admin .partners-analytics-grid{grid-template-columns:1fr;}
  #page-admin .partners-analytics-wide{grid-column:auto;}
  #page-admin .partners-event{grid-template-columns:1fr;}
}
#page-admin .partners-account-cards{display:none;margin:0;padding:0;list-style:none;}
@media(max-width:700px){
  #page-admin .partners-table-wrap{display:none;}
  #page-admin .partners-account-cards{display:grid;gap:10px;}
  #page-admin .partners-account-card{padding:14px;border:1px solid var(--adm-line);border-radius:12px;background:var(--adm-card);}
  #page-admin .partners-account-card header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:11px;}
  #page-admin .partners-account-card h3{min-width:0;margin:0;color:var(--adm-tx);font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  #page-admin .partners-account-card .partner-open{width:auto;flex:0 0 auto;}
  #page-admin .partners-account-facts{display:grid;gap:7px;margin:0;}
  #page-admin .partners-account-facts div{display:grid;grid-template-columns:minmax(88px,.8fr) minmax(0,1.2fr);gap:10px;}
  #page-admin .partners-account-facts dt{color:var(--adm-tx3);font-size:11px;}
  #page-admin .partners-account-facts dd{margin:0;color:var(--adm-tx2);font-size:12px;overflow-wrap:anywhere;}
  #page-admin .partners-route-summary,#page-admin .partners-routes-toolbar{grid-template-columns:1fr;}
  #page-admin .partners-route-list{grid-template-columns:1fr;}
  #page-admin .partners-control-head,#page-admin .partners-pane-intro{flex-direction:column;align-items:stretch;}
  #page-admin .partners-control-item{flex-direction:column;align-items:stretch;}
  #page-admin .partners-access-request-main{flex-basis:auto;}
  #page-admin .partners-ops-row{grid-template-columns:1fr;align-items:start;}
  #page-admin .partners-ops-row strong{text-align:left;}
  #page-admin .partners-risk-actions{justify-content:flex-start;}
  #page-admin .partners-pagination{flex-wrap:wrap;justify-content:space-between;}
  #page-admin .partners-pagination-status{width:100%;margin-right:0;}
  #page-admin .crm-modal-back{align-items:flex-end;padding:12px 12px max(12px,env(safe-area-inset-bottom,0px));}
  #page-admin .partners-kyc-guide{max-height:calc(100dvh - 24px);border-radius:16px;padding:18px 16px max(18px,env(safe-area-inset-bottom,0px));}
  #page-admin .partners-kyc-guide .mrow{margin-left:-16px;margin-right:-16px;padding-left:16px;padding-right:16px;}
  #page-admin .partners-kyc-guide-item{grid-template-columns:1fr;gap:8px;}
  #page-admin .partners-kyc-guide-state{justify-self:start;}
}
@media(max-width:560px){
  #page-admin .partners-admin-toolbar{grid-template-columns:1fr;}
  #page-admin .partners-workspace-nav{margin-inline:-8px;border-radius:9px;}
  #page-admin .partners-workspace-tab{padding-inline:11px;}
}
</style>
<div class="crm-shell">
  <aside class="crm-sidebar">
    <div class="crm-brand"><svg class="crm-logo" viewBox="0 0 48 48" width="30" height="30" fill="none" aria-hidden="true"><defs><linearGradient id="ncg" x1="7" y1="5" x2="41" y2="43" gradientUnits="userSpaceOnUse"><stop stop-color="#5b8cff"/><stop offset="1" stop-color="#a855f7"/></linearGradient></defs><rect x="1.6" y="1.6" width="44.8" height="44.8" rx="13" fill="#0b1022" stroke="url(#ncg)" stroke-width="1.7"/><circle cx="24" cy="25.5" r="11.5" fill="none" stroke="url(#ncg)" stroke-width="2.2" opacity=".8"/><circle cx="24" cy="21" r="4.4" fill="url(#ncg)"/><path d="M16 33.4c0-4.4 3.6-7.2 8-7.2s8 2.8 8 7.2z" fill="url(#ncg)"/><circle cx="24" cy="14" r="3.2" fill="#8fb0ff"/><circle cx="14" cy="31" r="3.2" fill="#6f8dff"/><circle cx="34" cy="31" r="3.2" fill="#c084fc"/></svg><span>Norva CRM</span></div>
    <nav id="crm-nav">${nav}</nav>
    ${(() => {
        // Carte de session : humain devant (initiale, rôle, email), technique en tooltip.
        // L'accès réel est gardé SERVEUR (is_admin() sur chaque RPC) — ceci n'est que de l'UX.
        const em = String(this.app?.currentUser?.email || '');
        const ini = (em.trim()[0] || 'A').toUpperCase();
        return `<div class="crm-side-foot" title="Accès restreint — contrôlé côté serveur (app_metadata.role = 'admin', is_admin() sur chaque RPC)">
      <span class="sf-ava">${AdminPage.esc(ini)}</span>
      <span class="sf-tx"><span class="sf-name">Administrateur <span class="sf-shield">🛡️</span></span>
      <span class="sf-mail">${AdminPage.esc(em || 'Session sécurisée')}</span></span>
      <span class="sf-dot" aria-label="Session active"></span>
    </div>`;
    })()}
  </aside>
  <main class="crm-main" tabindex="-1">
    <div class="crm-topbar">
      <span class="crm-crumb" id="crm-crumb" aria-live="polite">Cockpit</span>
      <span class="crm-spacer"></span>
      <span id="crm-ts"></span>
      <button id="crm-refresh" aria-label="Rafraîchir la page">↻ Rafraîchir</button>
    </div>
    <div id="crm-view"></div>
  </main>
</div>`;
        // Delegated handlers on the stable root: sidebar nav, refresh, re-sync buttons, client rows.
        root.addEventListener('click', (e) => {
            const navItem = e.target.closest('.crm-nav-item');
            if (navItem) { this._navigate(navItem.dataset.route); return; }
            const rf = e.target.closest('#crm-refresh');
            if (rf) {
                rf.disabled = true;
                rf.textContent = '↻ …';
                const refresh = this._route === 'partners'
                    ? this._partnersRefreshVisibleView()
                    : (this._navigate(this._route), Promise.resolve());
                Promise.resolve(refresh).finally(() => {
                    if (!rf.isConnected) return;
                    rf.disabled = false;
                    rf.textContent = '↻ Rafraîchir';
                });
                return;
            }
            const b = e.target.closest('.resync-btn');
            if (b) { e.preventDefault(); this._resync(b); return; }
            // Require data-user-id: support-ticket rows also carry .user-row but navigate to a
            // ticket via their own listener — matching them here would fire client:undefined too.
            const ur = e.target.closest('.user-row[data-user-id]');
            if (ur && !e.target.closest('button,a')) { this._navigate('client:' + ur.dataset.userId); return; }
            const ac = e.target.closest('.alert-card[data-user-id]');
            if (ac) { this._navigate('client:' + ac.dataset.userId); return; }
            const ar = e.target.closest('.alert-card[data-route]');
            if (ar) { this._navigate(ar.dataset.route); return; }
            const au = e.target.closest('.audit-row[data-user-id]');
            if (au) { this._navigate('client:' + au.dataset.userId); return; }
            const partnerOpen = e.target.closest('.partner-open[data-partner-id],.partners-overview-item[data-partner-id]');
            if (partnerOpen) {
                this._partnersRememberContext(partnerOpen);
                this._navigate('partner:' + partnerOpen.dataset.partnerId);
                return;
            }
            const partner = e.target.closest('.partner-row[data-partner-id]');
            if (partner && !e.target.closest('button,a')) {
                this._partnersRememberContext(partner);
                this._navigate('partner:' + partner.dataset.partnerId);
                return;
            }
            const partnersView = e.target.closest('[data-partners-view]');
            if (partnersView) {
                this._partnersSelectView(partnersView.dataset.partnersView, { focusTab: true });
                return;
            }
            const payoutPartner = e.target.closest('[data-partners-onboarding-open-partner]');
            if (payoutPartner) {
                const partnerKey = String(
                    payoutPartner.dataset.partnersOnboardingOpenPartner || ''
                );
                if (!/^prt_[0-9a-f]{24}$/.test(partnerKey)) return;
                this._ficheReturn = 'partners';
                this._navigate(`partner-public:${partnerKey}`);
                return;
            }
            const partnersPage = e.target.closest('[data-partners-account-page]');
            if (partnersPage && !partnersPage.disabled) {
                this._partnersPage = Math.max(0, this._partnersPage
                    + (partnersPage.dataset.partnersAccountPage === 'next' ? 1 : -1));
                this._partnersLoadAccounts({ force: true, preserveFocus: partnersPage.dataset.partnersAccountPage });
                return;
            }
            const accessRequestPage = e.target.closest('[data-partners-access-request-page]');
            if (accessRequestPage && !accessRequestPage.disabled) {
                const direction = accessRequestPage.dataset.partnersAccessRequestPage;
                this._partnersAccessRequestPage = Math.max(0, this._partnersAccessRequestPage
                    + (direction === 'next' ? 1 : -1));
                this._partnersLoadAccessRequests({ force: true, preserveFocus: direction });
                return;
            }
            const payoutOnboardingPage = e.target.closest('[data-partners-payout-onboarding-page]');
            if (payoutOnboardingPage && !payoutOnboardingPage.disabled) {
                const direction = payoutOnboardingPage.dataset.partnersPayoutOnboardingPage;
                this._partnersPayoutOnboardingOffset = Math.max(
                    0,
                    this._partnersPayoutOnboardingOffset
                        + (direction === 'next'
                            ? this._partnersPayoutOnboardingLimit
                            : -this._partnersPayoutOnboardingLimit)
                );
                this._partnersLoadPayoutOnboardingRequests({
                    force: true,
                    preserveFocus: direction
                });
                return;
            }
            const fiscalPage = e.target.closest('[data-partners-fiscal-page]');
            if (fiscalPage && !fiscalPage.disabled) {
                const direction = fiscalPage.dataset.partnersFiscalPage;
                this._partnersFiscalOffset = Math.max(
                    0,
                    this._partnersFiscalOffset
                        + (direction === 'next'
                            ? this._partnersFiscalLimit
                            : -this._partnersFiscalLimit)
                );
                this._partnersLoadFiscalProfiles({
                    force: true,
                    preserveFocus: direction
                });
                return;
            }
            const routesPage = e.target.closest('[data-partners-route-page]');
            if (routesPage && !routesPage.disabled) {
                this._partnersRoutePage = Math.max(0, this._partnersRoutePage
                    + (routesPage.dataset.partnersRoutePage === 'next' ? 1 : -1));
                this._renderPartnersRoutes({ focusControl: routesPage.dataset.partnersRoutePage });
                return;
            }
            const policyPage = e.target.closest('[data-partners-policy-page]');
            if (policyPage && !policyPage.disabled) {
                this._partnersPolicyPage = Math.max(0, this._partnersPolicyPage
                    + (policyPage.dataset.partnersPolicyPage === 'next' ? 1 : -1));
                const configuration = this._partnersCache.get('configuration');
                if (configuration) {
                    this._renderPartnersConfiguration(configuration, {
                        focusControl: policyPage.dataset.partnersPolicyPage
                    });
                }
                return;
            }
            const retry = e.target.closest('[data-partners-retry]');
            if (retry) {
                this._partnersRetryModule(retry.dataset.partnersRetry, retry);
                return;
            }
            const partnersAction = e.target.closest('[data-partners-action]');
            if (partnersAction) {
                e.preventDefault();
                this._partnersAdminAction(partnersAction);
                return;
            }
            if (e.target.closest('.crm-back')) { this._navigate(this._ficheReturn || 'clients'); return; }
            // Fiche relational actions
            const tRem = e.target.closest('.crm-tag-remove');
            if (tRem) { this._crmMutate('admin_tag_toggle', { p_user_id: this._crmUser, p_tag_id: tRem.dataset.tagId, p_on: false }); return; }
            const tAdd = e.target.closest('.crm-tag-add');
            if (tAdd) { this._crmMutate('admin_tag_toggle', { p_user_id: this._crmUser, p_tag_id: tAdd.dataset.tagId, p_on: true }); return; }
            if (e.target.closest('.crm-tag-create')) { this._crmCreateTag(); return; }
            if (e.target.closest('.crm-note-add')) { this._crmAddNote(); return; }
            const nDel = e.target.closest('.crm-note-del');
            if (nDel) { this._confirm('Supprimer cette note interne ?', { danger: true, okLabel: 'Supprimer' }).then(ok => { if (ok) this._crmMutate('admin_note_delete', { p_note_id: nDel.dataset.noteId }); }); return; }
            const actBtn = e.target.closest('.act-btn');
            if (actBtn) { this._userAction(actBtn); return; }
            if (e.target.closest('#sys-infra-refresh') || e.target.closest('#sys-billing-refresh')) { this._loadInfra(); return; }
            if (e.target.closest('#sys-audit-more')) { this._loadAudit(false); return; }
            if (e.target.closest('#bulk-apply-btn')) { this._bulkTag('apply'); return; }
            if (e.target.closest('#bulk-remove-btn')) { this._bulkTag('remove'); return; }
            if (e.target.closest('.flag-create')) { this._flagCreate(); return; }
            const fDel = e.target.closest('.flag-del');
            if (fDel) {
                if (this._isManagedPartnersFlag(fDel.dataset.key)) {
                    this._toast('Ce flag Partners est piloté par le contrôle de release sécurisé.', 'err');
                    return;
                }
                this._confirm(`Supprimer le flag « ${fDel.dataset.key} » ?`, { danger: true, okLabel: 'Supprimer' }).then(ok => {
                    if (ok) this._rpc('admin_flag_delete', { p_key: fDel.dataset.key }).then(() => this._loadFlags()).catch(err => this._toast('Erreur : ' + err.message, 'err'));
                });
                return;
            }
        });
        // Keyboard activation for the click-only rows/cards (they carry role="button" tabindex="0"):
        // Enter/Space on a focused row triggers the same click path. A child <button> keeps its own
        // native handling (guarded by e.target === el).
        root.addEventListener('keydown', (e) => {
            const tab = e.target.closest('.partners-workspace-tab');
            if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                e.preventDefault();
                const tabs = Array.from(root.querySelectorAll('.partners-workspace-tab'));
                const current = tabs.indexOf(tab);
                const next = e.key === 'Home' ? 0
                    : (e.key === 'End' ? tabs.length - 1
                        : (current + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length);
                const target = tabs[next];
                if (target) this._partnersSelectView(target.dataset.partnersView, { focusTab: true });
                return;
            }
            if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
            const el = e.target.closest('.user-row,.partner-row,.alert-card[data-user-id],.alert-card[data-route],.audit-row[data-user-id],[data-ticket-id],.fin-status');
            if (el && e.target === el) { e.preventDefault(); el.click(); }
        });
        // Feature-flag switches fire 'change', not 'click' — delegate separately.
        root.addEventListener('change', (e) => {
            const ft = e.target.closest('.flag-toggle');
            if (ft) this._flagToggle(ft);
            if (e.target.id === 'partners-admin-status') {
                this._partnersStatus = e.target.value;
                this._partnersPage = 0;
                this._partnersLoadAccounts({ force: true, preserveFocus: 'status' });
            }
            if (e.target.id === 'partners-access-request-status') {
                const allowed = ['requested', 'approved', 'declined', 'all'];
                this._partnersAccessRequestStatus = allowed.includes(e.target.value)
                    ? e.target.value : 'requested';
                this._partnersAccessRequestPage = 0;
                this._partnersLoadAccessRequests({ force: true, preserveFocus: 'status' });
            }
            if (e.target.id === 'partners-payout-onboarding-status') {
                const allowed = ['pending', 'in_progress', 'rejected', 'completed', 'all'];
                this._partnersPayoutOnboardingStatus = allowed.includes(e.target.value)
                    ? e.target.value : 'pending';
                this._partnersPayoutOnboardingOffset = 0;
                this._partnersLoadPayoutOnboardingRequests({ force: true, preserveFocus: 'status' });
            }
            if (e.target.id === 'partners-fiscal-status') {
                const allowed = ['pending', 'verified', 'rejected', 'expired', 'all'];
                this._partnersFiscalStatus = allowed.includes(e.target.value)
                    ? e.target.value : 'pending';
                this._partnersFiscalOffset = 0;
                this._partnersLoadFiscalProfiles({ force: true, preserveFocus: 'status' });
            }
            if (e.target.id === 'partners-routes-status') {
                this._partnersRouteStatus = ['all', 'active', 'disabled'].includes(e.target.value)
                    ? e.target.value : 'all';
                this._partnersRoutePage = 0;
                this._renderPartnersRoutes({ focusControl: 'status' });
            }
            if (e.target.id === 'partners-revolut-incident-filter') {
                const allowed = ['action_required', 'open', 'quarantined', 'resolved', 'all'];
                if (!allowed.includes(e.target.value)) return;
                this._partnersIncidentFilter = e.target.value;
                this._partnersIncidentOffset = 0;
                this._partnersLoadIncidents({ force: true, preserveFocus: 'filter' });
            }
        });
        root.addEventListener('input', (e) => {
            if (e.target.id === 'partners-admin-search') {
                clearTimeout(this._partnersSearchDebounce);
                const input = e.target;
                this._partnersSearchDebounce = setTimeout(() => {
                    this._partnersSearch = input.value.trim().toLowerCase()
                        .replace(/[^0-9a-f-]/g, '').slice(0, 64);
                    this._partnersPage = 0;
                    if (this._route === 'partners') {
                        this._partnersLoadAccounts({ force: true, preserveFocus: 'search' });
                    }
                }, 250);
            }
            if (e.target.id === 'partners-routes-search') {
                clearTimeout(this._partnersRoutesDebounce);
                const input = e.target;
                this._partnersRoutesDebounce = setTimeout(() => {
                    this._partnersRouteSearch = input.value.trim().toUpperCase().slice(0, 16);
                    this._partnersRoutePage = 0;
                    this._renderPartnersRoutes({ focusControl: 'search' });
                }, 120);
            }
            if (e.target.id === 'partners-payout-onboarding-search') {
                clearTimeout(this._partnersPayoutOnboardingDebounce);
                const input = e.target;
                this._partnersPayoutOnboardingDebounce = setTimeout(() => {
                    this._partnersPayoutOnboardingSearch = input.value.trim().toLowerCase()
                        .replace(/[^a-z0-9_]/g, '').slice(0, 64);
                    this._partnersPayoutOnboardingOffset = 0;
                    if (this._route === 'partners' && this._partnersView === 'finance') {
                        this._partnersLoadPayoutOnboardingRequests({
                            force: true,
                            preserveFocus: 'search'
                        });
                    }
                }, 250);
            }
            if (e.target.id === 'partners-fiscal-search') {
                clearTimeout(this._partnersFiscalDebounce);
                const input = e.target;
                this._partnersFiscalDebounce = setTimeout(() => {
                    this._partnersFiscalSearch = input.value.trim().toLowerCase()
                        .replace(/[^a-z0-9_]/g, '').slice(0, 64);
                    this._partnersFiscalOffset = 0;
                    if (this._route === 'partners' && this._partnersView === 'risk') {
                        this._partnersLoadFiscalProfiles({
                            force: true,
                            preserveFocus: 'search'
                        });
                    }
                }, 250);
            }
        });
        this.built = true;
        this._refreshSupportBadge();
    }

    _setCrumb(text, ts) {
        const c = document.getElementById('crm-crumb'); if (c) c.textContent = text;
        const t = document.getElementById('crm-ts');
        if (t) t.textContent = ts ? ('snapshot · ' + new Date(ts).toLocaleTimeString('fr-FR') + ' · auto 10 min') : '';
    }
    _setActiveNav(route) {
        const mapped = route.startsWith('client') ? 'clients' : (route.startsWith('partner') ? 'partners' : (route.startsWith('ticket') ? 'support'
            : (route.startsWith('finance') ? 'finance' : (route.startsWith('marketing') ? 'marketing' : route))));
        document.querySelectorAll('#page-admin .crm-nav-item').forEach(el => {
            const on = el.dataset.route === mapped;
            el.classList.toggle('active', on);
            if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
        });
    }

    // Sidebar badge: tickets awaiting an admin reply. Refreshed on shell build + support pages.
    async _refreshSupportBadge() {
        try {
            const c = await this._rpc('admin_support_counts') || {};
            const btn = document.querySelector('#page-admin .crm-nav-item[data-route="support"]');
            const item = btn && btn.querySelector('.lb');
            if (!item) return;
            const n = Number(c.needs_reply) || 0;
            item.innerHTML = 'Support' + (n > 0 ? ` <span class="badge red" style="margin-left:6px">${n}</span>` : '');
            // .has-alerts drives a red dot on the collapsed (mobile) icon rail, where .lb is hidden.
            btn.classList.toggle('has-alerts', n > 0);
        } catch (_) { /* cosmetic */ }
    }

    // Support header KPI cards (icon-left) — real counts from admin_support_counts.
    async _loadSupportKpis() {
        const el = document.getElementById('sup-kpis');
        if (!el) return;
        try {
            const c = await this._rpc('admin_support_counts') || {};
            if (this._route !== 'support') return;
            const n = AdminPage.n;
            const cur = this._supportFilter || '';
            // Clickable KPI cards → switch to the matching tab; active state mirrors the open tab.
            const card = (v, l, cls, icon, filter) => `<div class="sup-card ${cls || ''} ${filter !== undefined && filter === cur ? 'is-active' : ''}"${filter !== undefined ? ` role="button" tabindex="0" data-filter="${filter}" title="Voir ces tickets"` : ''}><div class="ic">${icon}</div><div><div class="v">${v}</div><div class="l">${l}</div></div></div>`;
            // Every clickable card's count uses the SAME predicate as the list filter it opens
            // (the old 'open'/'in_progress' counts covered open+pending → number ≠ list length).
            el.innerHTML = [
                card(n(c.open), 'Tickets actifs', '', '🎫', 'active'),
                card(n(c.needs_reply), 'À répondre', Number(c.needs_reply) > 0 ? 'alert' : 'ok', '⏳', 'needs_reply'),
                card(n(c.pending_exact), 'En attente client', '', '🔄', 'pending'),
                card(n(c.resolved_7d), 'Résolus 7 j', 'ok', '✅', 'closed'),
                card(n(c.resolved_30d), 'Résolus 30 j', '', '📅')
            ].join('');
            // "Résolus 7 j" opens the full closed list (no 7-day list filter exists) — say so.
            const r7 = el.querySelector('.sup-card[data-filter="closed"]');
            if (r7) r7.title = 'Fermés ces 7 derniers jours — ouvre tous les tickets fermés';
            el.querySelectorAll('.sup-card[data-filter]').forEach(cd => cd.addEventListener('click', () => this._pageSupport(cd.dataset.filter)));
            // Tab counts + urgency dot on "À répondre".
            const setCount = (k, val) => { const s = document.getElementById('sup-count-' + k); if (s) s.textContent = AdminPage.n(val); };
            setCount('needs_reply', c.needs_reply); setCount('active', c.open); setCount('pending_exact', c.pending_exact);
            const nrTab = document.querySelector('.sup-tab[data-filter="needs_reply"]');
            if (nrTab) nrTab.classList.toggle('urgent', Number(c.needs_reply) > 0);
            // Header status line: à répondre · ouverts · résolus 7 j.
            const tx = document.querySelector('#page-admin .crm-head-tx');
            if (tx) {
                let meta = tx.querySelector('.crm-head-meta');
                if (!meta) { meta = document.createElement('div'); meta.className = 'crm-head-meta'; tx.appendChild(meta); }
                meta.innerHTML =
                    `<span class="crm-hpill ${Number(c.needs_reply) > 0 ? 'bad' : ''}"><b>${n(c.needs_reply)}</b> à répondre</span>` +
                    `<span class="crm-hpill"><b>${n(c.open)}</b> ouverts</span>` +
                    `<span class="crm-hpill"><b>${n(c.resolved_7d)}</b> résolus 7 j</span>`;
            }
        } catch (_) { el.innerHTML = ''; }
    }
    _view() { return document.getElementById('crm-view'); }

    // ── Non-blocking UX primitives (replace native alert/confirm/prompt) ──
    _toast(msg, kind) {
        const root = document.getElementById('page-admin'); if (!root) return;
        let host = root.querySelector('.crm-toasts');
        if (!host) { host = document.createElement('div'); host.className = 'crm-toasts'; host.setAttribute('aria-live', 'polite'); root.appendChild(host); }
        const t = document.createElement('div');
        t.className = 'crm-toast' + (kind ? ' ' + kind : ''); t.setAttribute('role', 'status'); t.textContent = msg;
        host.appendChild(t);
        setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 320); }, kind === 'err' ? 5200 : 3200);
    }
    _confirm(message, opts) { const o = opts || {}; return this._modal({ message, danger: o.danger, okLabel: o.okLabel || 'Confirmer' }); }
    _prompt(message, def) { return this._modal({ message, prompt: true, def: def || '', okLabel: 'OK' }); }
    // Accessible modal: focus-trapped (Tab cycles inside, background made inert), Escape/Enter/
    // backdrop, labelled by its title + described by its message. Returns a Promise —
    // false/null on cancel, true on confirm, or the trimmed input string on prompt.
    _modal(o) {
        return new Promise((resolve) => {
            const root = document.getElementById('page-admin') || document.body;
            const shell = root.querySelector('.crm-shell');
            const prev = document.activeElement;
            const uid = 'crmmodal' + (this._modalSeq = (this._modalSeq || 0) + 1);
            const back = document.createElement('div');
            back.className = 'crm-modal-back';
            back.setAttribute('role', 'dialog');
            back.setAttribute('aria-modal', 'true');
            back.setAttribute('aria-labelledby', uid + 't');
            back.setAttribute('aria-describedby', uid + 'd');
            const promptAttrs = o.prompt ? [
                !o.multiline ? `type="${AdminPage.esc(o.inputType || 'text')}"` : '',
                'class="crm-modal-input"',
                `aria-label="${AdminPage.esc(o.inputLabel || o.message || 'Saisie')}"`,
                !o.multiline ? `value="${AdminPage.esc(o.def || '')}"` : '',
                `autocomplete="${AdminPage.esc(o.autocomplete || 'off')}"`,
                o.inputMode ? `inputmode="${AdminPage.esc(o.inputMode)}"` : '',
                Number.isSafeInteger(o.maxLength) && o.maxLength > 0
                    ? `maxlength="${o.maxLength}"` : '',
                o.pattern ? `pattern="${AdminPage.esc(o.pattern)}"` : ''
            ].filter(Boolean).join(' ') : '';
            const promptHtml = o.prompt
                ? (o.multiline
                    ? `<textarea ${promptAttrs} rows="${Number.isSafeInteger(o.rows) ? Math.min(18, Math.max(4, o.rows)) : 9}">${AdminPage.esc(o.def || '')}</textarea>`
                    : `<input ${promptAttrs} />`)
                : '';
            back.innerHTML = `<div class="crm-modal${o.wide ? ' is-wide' : ''}"><h3 id="${uid}t">${AdminPage.esc(o.title || 'Confirmation')}</h3><p id="${uid}d">${AdminPage.esc(o.message)}</p>${promptHtml}
                <div class="mrow"><button class="cancel" type="button">Annuler</button><button class="ok ${o.danger ? 'danger' : 'primary'}" type="button">${AdminPage.esc(o.okLabel || 'OK')}</button></div></div>`;
            root.appendChild(back);
            if (shell) shell.setAttribute('inert', ''); // background can't be reached by pointer/tab/AT
            const input = back.querySelector('.crm-modal-input');
            const okBtn = back.querySelector('.ok');
            const cancelBtn = back.querySelector('.cancel');
            const cancelVal = o.prompt ? null : false;
            const okVal = () => o.prompt ? (input ? input.value.trim() : '') : true;
            const focusables = () => Array.from(back.querySelectorAll('input,textarea,button')).filter(el => !el.disabled);
            const finish = (val) => {
                document.removeEventListener('keydown', onKey, true);
                if (shell) shell.removeAttribute('inert');
                if (input) input.value = '';
                back.remove();
                if (prev && prev.focus) { try { prev.focus(); } catch (_) { /* gone */ } }
                resolve(val);
            };
            const onKey = (e) => {
                if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') { e.preventDefault(); finish(cancelVal); return; }
                if (e.key === 'Tab') {
                    const f = focusables(); if (!f.length) return;
                    const first = f[0], last = f[f.length - 1], a = document.activeElement;
                    if (e.shiftKey && (a === first || !back.contains(a))) { e.preventDefault(); last.focus(); }
                    else if (!e.shiftKey && (a === last || !back.contains(a))) { e.preventDefault(); first.focus(); }
                    return;
                }
                if (e.key === 'Enter') {
                    if (document.activeElement === cancelBtn) return; // let Enter cancel when Cancel is focused
                    if (o.multiline && document.activeElement === input && !e.ctrlKey && !e.metaKey) return;
                    e.preventDefault(); finish(okVal());
                }
            };
            okBtn.addEventListener('click', () => finish(okVal()));
            cancelBtn.addEventListener('click', () => finish(cancelVal));
            back.addEventListener('mousedown', (e) => { if (e.target === back) finish(cancelVal); });
            document.addEventListener('keydown', onKey, true); // capture: intercept Tab before it leaves
            (input || okBtn).focus();
        });
    }

    // Human label for a route, used by the context-aware fiche back button.
    static routeLabel(route) {
        if (!route) return 'Retour';
        if (route.startsWith('ticket:')) return 'Retour au ticket';
        if (route.startsWith('client:')) return 'Retour à la fiche';
        if (route.startsWith('partner:') || route.startsWith('partner-public:')) return 'Retour au partenaire';
        return ({ clients: 'Retour aux clients', finance: 'Retour à la finance', cockpit: 'Retour au cockpit',
            systeme: 'Retour au système', identites: 'Retour aux identités', providers: 'Retour aux providers',
            moteur: 'Retour au moteur', support: 'Retour au support', partners: 'Retour à Partners' })[route] || 'Retour';
    }

    _navigate(route) {
        const from = this._route;
        if (from === 'partners' && route !== 'partners') {
            clearTimeout(this._partnersSearchDebounce);
            clearTimeout(this._partnersRoutesDebounce);
            clearTimeout(this._partnersPayoutOnboardingDebounce);
            clearTimeout(this._partnersFiscalDebounce);
            this._partnersSearchDebounce = null;
            this._partnersRoutesDebounce = null;
            this._partnersPayoutOnboardingDebounce = null;
            this._partnersFiscalDebounce = null;
            this._partnersAbortAll?.();
        }
        // Remember where a fiche was opened from so its back button returns there (not always Clients).
        // Keep the original entry across chained fiche→fiche hops (source row → another fiche).
        if ((route.startsWith('client:') || route.startsWith('partner:')
            || route.startsWith('partner-public:'))
            && from
            && !from.startsWith('client:')
            && !from.startsWith('partner:')
            && !from.startsWith('partner-public:')) this._ficheReturn = from;
        // Same for tickets: opened from a fiche (panel tickets) → back returns to that fiche,
        // not to the Support inbox (the back target used to be hardcoded 'support').
        if (route.startsWith('ticket:') && from && !from.startsWith('ticket:')) this._ticketReturn = from.startsWith('client:') ? from : 'support';
        this._route = route;
        // Reflect the CRM sub-route in the URL (#admin/<route>) so F5 / bookmarks / shared
        // links restore the exact view (fiche, ticket…). replaceState — the app's own history
        // stack (one entry per app page) stays untouched, Back behaves exactly as before.
        try { if (String(location.hash || '').startsWith('#admin')) history.replaceState(history.state, '', '#admin/' + route); } catch (_) { /* non-navigable contexts */ }
        this._nav = (this._nav || 0) + 1; // monotonic token — stale async page/panel loads bail on mismatch
        this._setActiveNav(route);
        const main = document.querySelector('#page-admin .crm-main');
        if (main) { main.scrollTop = 0; main.focus({ preventScroll: true }); } // reset scroll + move focus into content (a11y)
        if (route === 'cockpit') this._pageCockpit();
        else if (route === 'finance' || route.startsWith('finance/')) {
            const finSub = route.split('/')[1] || '';
            if (finSub === 'promos') {
                // Les promotions ont déménagé dans la page Marketing — les vieux
                // liens/favoris #admin/finance/promos y atterrissent directement.
                this._marketingTab = 'promos';
                this._route = 'marketing';
                try { history.replaceState(history.state, '', '#admin/marketing/promos'); } catch (_) { /* non-navigable */ }
                this._setActiveNav('marketing');
                this._pageMarketing();
            } else {
                this._financeTab = ['vat', 'paiements', 'analyse'].includes(finSub) ? finSub : 'overview';
                this._route = 'finance'; this._pageFinance();
            }
        }
        else if (route === 'marketing' || route.startsWith('marketing/')) {
            const mktSub = route.split('/')[1] || '';
            this._marketingTab = ['promos', 'notifs'].includes(mktSub) ? mktSub : 'overview';
            this._route = 'marketing'; this._pageMarketing();
        }
        else if (route === 'clients') this._pageClients();
        else if (route === 'partners') this._pagePartners();
        else if (route.startsWith('partner-public:')) this._pagePartnerDetailByPublicId(route.slice(15));
        else if (route.startsWith('partner:')) this._pagePartnerDetail(route.slice(8));
        else if (route === 'support') this._pageSupport();
        else if (route.startsWith('ticket:')) this._pageTicket(route.slice(7));
        else if (route.startsWith('client:')) this._pageClientDetail(route.slice(7));
        else if (route === 'providers') this._pageProviders();
        else if (route === 'identites') this._pageIdentites();
        else if (route === 'moteur') this._pageMoteur();
        else if (route === 'systeme') this._pageSysteme();
        else if (route === 'telemetrie') this._pageTelemetrie();
        else this._pageCockpit();
        // Every page renders its header synchronously (before its first await), so the
        // markup is already in the DOM here — upgrade "🎯 Cockpit" into the gradient
        // icon-badge + title/subtitle layout once, for all pages (no per-page edits).
        this._dressHeader();
    }

    // Turn a page's "<h1 class="crm-h1">EMOJI Title</h1><p class="crm-sub">…</p>" into the
    // premium header: a gradient icon square beside the title/subtitle block. Idempotent.
    _dressHeader() {
        const main = document.querySelector('#page-admin .crm-main');
        if (!main) return;
        const h1 = main.querySelector('.crm-h1');
        if (!h1 || h1.closest('.crm-head')) return;
        const sub = (h1.nextElementSibling && h1.nextElementSibling.classList.contains('crm-sub'))
            ? h1.nextElementSibling : null;
        const m = h1.textContent.trim().match(/^(\S+)\s+([\s\S]*)$/);
        const icon = m ? m[1] : '📊';
        const title = m ? m[2] : h1.textContent.trim();
        const head = document.createElement('div'); head.className = 'crm-head';
        const ic = document.createElement('div'); ic.className = 'crm-head-ic'; ic.textContent = icon;
        const tx = document.createElement('div'); tx.className = 'crm-head-tx';
        head.append(ic, tx);
        h1.parentNode.insertBefore(head, h1);
        h1.textContent = title;
        tx.appendChild(h1);
        if (sub) tx.appendChild(sub);
    }

    // ── Page: Cockpit ──
    async _pageCockpit() {
        const nav = this._nav;
        this._setCrumb('Cockpit', this._lastTs);
        const v = this._view();
        v.innerHTML = `<div class="crm-page">
            <h1 class="crm-h1">🎯 Cockpit</h1>
            <p class="crm-sub">Santé de l'écosystème Norva en un coup d'œil.</p>
            <div id="cockpit-summary" class="cockpit-summary is-loading"></div>
            <section id="admin-overview" class="kpi-groups"><div class="ssub">Chargement…</div></section>
            <div class="admin-block"><h2>🚨 Alertes</h2><div id="admin-alerts"><div class="ssub">Chargement…</div></div></div>
        </div>`;
        try {
            const [o, sources, sparks] = await Promise.all([
                this._rpc('admin_overview'),
                this._rpc('admin_sources'),
                this._rpc('admin_metric_sparks', { p_days: 14 }).catch(() => null) // sparklines are non-critical
            ]);
            if (this._nav !== nav) return; // navigated away while loading
            this._lastTs = o && o.refreshed_at ? o.refreshed_at : this._lastTs;
            this._setCrumb('Cockpit', this._lastTs);
            this._renderCockpitSummary(o, Array.isArray(sources) ? sources : []);
            this._renderOverview(o, sparks && sparks.series);
            this._renderAlerts(Array.isArray(sources) ? sources : [], o);
        } catch (e) {
            if (this._nav !== nav) return;
            const err = `<div class="admin-err" role="alert">Erreur : ${AdminPage.esc(e.message)}</div>`;
            const ov = document.getElementById('admin-overview'); if (ov) ov.innerHTML = err;
            const al = document.getElementById('admin-alerts'); if (al) al.innerHTML = err; // both panels — don't strand Alertes on "Chargement…"
        }
    }

    // Alerts = source problems PLUS the system-level red signals the overview already surfaces
    // (failed payments, cron failures, failed AI subs) so the Cockpit's alert panel is coherent
    // with its own KPI colours.
    // Executive-read band: one glance = global health + alert count + MRR + freshness + CTA.
    _renderCockpitSummary(o, sources) {
        const el = document.getElementById('cockpit-summary');
        if (!el) return;
        o = o || {};
        const problems = (Array.isArray(sources) ? sources : []).filter(s => s.incomplete === true || s.sync_error || s.sync_status === 'sync_error');
        const criticals = (Number(o.billing_past_due) > 0 ? 1 : 0) + problems.length; // actionable, high-severity
        // Recovery-aware : cron_ko = jobs dont le DERNIER run est en échec. Un échec 24 h
        // auto-réparé (dernier run OK) n'est plus un signal « Attention ». Fallback sur le
        // volume brut tant que le snapshot n'expose pas cron_ko (cache pas encore rafraîchi).
        const cronKo = o.cron_ko !== undefined ? Number(o.cron_ko) : Number(o.cron_fails_24h);
        const warnings = (cronKo > 0 ? 1 : 0) + (Number(o.gensubs_failed) > 50 ? 1 : 0);
        const total = criticals + warnings;
        let statusTxt = 'Sain', statusCls = 'ok';
        if (criticals > 0) { statusTxt = 'Dégradé'; statusCls = 'alert'; }
        else if (warnings > 0) { statusTxt = 'Attention'; statusCls = 'warn'; }
        const money = AdminPage.money, n = AdminPage.n;
        const item = (ic, v, l, cls) => `<div class="cs-item ${cls || ''}"><div class="cs-ic">${ic}</div><div class="cs-tx"><div class="cs-v">${v}</div><div class="cs-l">${l}</div></div></div>`;
        el.className = 'cockpit-summary ' + statusCls;
        el.innerHTML =
            item('🩺', statusTxt, 'État global', statusCls) +
            item('🚨', n(total), total > 0 ? (criticals > 0 ? 'alerte(s) critique(s)' : 'à traiter') : 'aucune alerte', total > 0 ? (criticals > 0 ? 'alert' : 'warn') : 'ok') +
            item('💶', money(o.billing_mrr_cents), 'MRR', Number(o.billing_mrr_cents) > 0 ? 'ok' : '') +
            item('🕐', o.refreshed_at ? AdminPage.timeAgo(o.refreshed_at) : '—', 'Dernier refresh') +
            (total > 0 ? `<button class="cs-cta" id="cs-cta">Traiter les alertes →</button>` : `<div class="cs-ok">✓ Tout est sain</div>`);
        const cta = document.getElementById('cs-cta');
        if (cta) cta.addEventListener('click', () => {
            const al = document.getElementById('admin-alerts');
            if (al) al.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
    }

    _renderAlerts(sources, o) {
        const el = document.getElementById('admin-alerts');
        if (!el) return;
        o = o || {};
        const sevChip = (t, cls) => `<span class="sev-chip ${cls}">${t}</span>`;
        const sysCard = (kind, sev, count, label, route) =>
            `<div class="alert-card ${kind === 'amber' ? 'amber' : ''}" data-route="${route}" role="button" tabindex="0" title="Ouvrir">
                ${sevChip(sev, kind === 'amber' ? 'amber' : 'red')}
                <span class="badge ${kind}">${AdminPage.n(count)}</span>
                <span class="al-name">${AdminPage.esc(label)}</span>
            </div>`;
        // Group alerts by family so a high volume stays scannable (paiement / crons / sources / sous-titres).
        const fam = { paiement: [], crons: [], sources: [], soustitres: [] };
        if (Number(o.billing_past_due) > 0) fam.paiement.push(sysCard('red', 'Critique', o.billing_past_due, 'client(s) en échec de paiement', 'finance'));
        // KO (dernier run en échec) = rouge « À traiter » ; échecs 24 h tous récupérés = info ambre.
        const cronKo = o.cron_ko !== undefined ? Number(o.cron_ko) : Number(o.cron_fails_24h);
        if (cronKo > 0) fam.crons.push(sysCard('red', 'À traiter', cronKo, 'cron(s) encore en échec (dernier run KO)', 'systeme'));
        else if (Number(o.cron_fails_24h) > 0) fam.crons.push(sysCard('amber', 'Récupéré', o.cron_fails_24h, 'échec(s) cron sur 24 h — auto-réparé(s), dernier run OK', 'systeme'));
        if (Number(o.gensubs_failed) > 0) fam.soustitres.push(sysCard('amber', 'Mineur', o.gensubs_failed, 'sous-titre(s) IA en échec', 'systeme'));
        (sources || []).filter(s => s.incomplete === true || s.sync_error || s.sync_status === 'sync_error').forEach(s => {
            const kind = s.incomplete === true ? 'sync incomplète' : (s.sync_status || 'erreur');
            const uidAttr = s.user_id ? ` data-user-id="${AdminPage.esc(s.user_id)}" role="button" tabindex="0" title="Ouvrir la fiche client"` : '';
            fam.sources.push(`<div class="alert-card"${uidAttr}>
                ${sevChip('Critique', 'red')}
                <span class="badge red">${AdminPage.esc(kind)}</span>
                <span class="al-name">${AdminPage.esc(s.display_name)}</span>
                <span class="al-owner">${AdminPage.esc(s.owner_email || '')}</span>
                ${s.sync_error ? `<span class="al-err">${AdminPage.esc(String(s.sync_error).slice(0, 80))}</span>` : ''}
            </div>`);
        });
        const total = fam.paiement.length + fam.crons.length + fam.sources.length + fam.soustitres.length;
        if (!total) { el.innerHTML = '<div class="card"><span class="badge green">✓</span> Aucune alerte — tout est sain.</div>'; return; }
        // Only the sources family can grow long → cap it at 8 with an in-place expander.
        const CAP = 8;
        const famDefs = [['paiement', '💳', 'Paiement'], ['crons', '⏱️', 'Crons'], ['sources', '📡', 'Sources'], ['soustitres', '🎬', 'Sous-titres IA']];
        el.innerHTML = famDefs.map(([k, ic, lbl]) => {
            const cards = fam[k];
            if (!cards.length) return '';
            const cap = k === 'sources' ? CAP : cards.length;
            const shown = cards.slice(0, cap), hidden = cards.slice(cap);
            return `<div class="alert-fam"><div class="alert-fam-h">${ic} ${lbl} <span class="pacct">${cards.length}</span></div>${shown.join('')}${hidden.length ? `<div class="alert-fam-hidden" hidden>${hidden.join('')}</div><button class="tag-add-chip alerts-more" style="margin-top:8px">⌄ Voir les ${hidden.length} autres</button>` : ''}</div>`;
        }).join('');
        el.querySelectorAll('.alerts-more').forEach(btn => btn.addEventListener('click', () => {
            const hid = btn.previousElementSibling;
            if (hid && hid.classList.contains('alert-fam-hidden')) { hid.hidden = false; btn.remove(); } // clicks stay delegated
        }));
    }

    // ── Page: Finance (MRR / statuts / encaissé / funnel / churn / paiements) ──
    async _pageFinance() {
        this._setCrumb('Finance');
        const v = this._view();
        v.innerHTML = `<div class="crm-page">
            <h1 class="crm-h1">💶 Finance</h1>
            <p class="crm-sub">Revenus par plan/période/rail, abonnés par statut, encaissements, funnel de conversion et churn — données live.</p>
            <div id="fin-body"><div class="ssub">Chargement…</div></div>
        </div>`;
        try {
            const [f, sparks, vat, fc, paywall] = await Promise.all([
                this._rpc('admin_finance'),
                this._rpc('admin_metric_sparks', { p_days: 14 }).catch(() => null), // sparklines are non-critical
                this._rpc('admin_vat_report').catch(() => null), // panneau TVA non-critique (absent avant migration)
                this._rpc('admin_vat_forecast').catch(() => null), // provision + prévision T+1 + ETA (non-critique)
                // Experiment analytics stay separate from admin_finance(). An older
                // deployment without this RPC must never take the Finance page down.
                this._rpc('admin_paywall_funnel_30d').catch(error => ({
                    unavailable: true,
                    message: error && error.message ? error.message : 'RPC indisponible'
                }))
            ]);
            this._vatForecast = fc || null; // trimestre-indépendant — survit aux re-renders du panneau
            this._renderFinance(f || {}, sparks && sparks.series, vat, paywall);
        } catch (e) {
            const el = document.getElementById('fin-body');
            if (el) el.innerHTML = `<div class="admin-err" role="alert">Erreur : ${AdminPage.esc(e.message)}</div>`;
        }
    }

    // ── Page: Marketing — promotions (déplacées de Finance), visuel de campagne
    // et notifications push mobiles (FCM, tokens cloud_push_tokens enregistrés
    // par l'app Android via le bridge WebView). Trois onglets deep-linkables :
    // #admin/marketing[/promos|/notifs]. ──
    async _pageMarketing() {
        this._setCrumb('Marketing');
        const v = this._view();
        const MKT_TABS = { overview: 'mkt-tab-overview', promos: 'mkt-tab-promos', notifs: 'mkt-tab-notifs' };
        const tab = MKT_TABS[this._marketingTab] ? this._marketingTab : 'overview';
        const show = t => (tab === t ? '' : ' style="display:none"');
        v.innerHTML = `<div class="crm-page">
            <h1 class="crm-h1">📣 Marketing</h1>
            <p class="crm-sub">Promotions, campagnes visuelles et notifications push — tout ce qui pousse Norva vers ses utilisateurs.</p>
            <div class="qv-row" id="mkt-tabs" role="tablist" aria-label="Sections Marketing">
                <button class="qv-chip ${tab === 'overview' ? 'active' : ''}" data-mtab="overview" role="tab">📣 Vue d'ensemble</button>
                <button class="qv-chip ${tab === 'promos' ? 'active' : ''}" data-mtab="promos" role="tab">🏷️ Promotions</button>
                <button class="qv-chip ${tab === 'notifs' ? 'active' : ''}" data-mtab="notifs" role="tab">📲 Notifications</button>
            </div>
            <div id="mkt-tab-overview"${show('overview')}><div id="mkt-overview"><div class="ssub">Chargement…</div></div></div>
            <div id="mkt-tab-promos"${show('promos')}>
                <div class="admin-block"><h2>💵 Tarifs web &amp; promotions (Revolut)</h2>
                    <div class="ssub" style="margin-bottom:10px">Source unique <code>billing_prices</code> — appliquée aux <b>nouveaux</b> checkouts et changements de plan ; les abonnés existants gardent leur prix souscrit. Rail Play : tarifs et promos gérés dans la Play Console.</div>
                    <div id="fin-prices"><div class="ssub">Chargement…</div></div>
                </div>
            </div>
            <div id="mkt-tab-notifs"${show('notifs')}>
                <div class="admin-block"><h2>📲 Notification push (mobile)</h2>
                    <div class="ssub" style="margin-bottom:10px">Envoyée immédiatement à <b>tous les appareils enregistrés</b> (app Android installée + push accepté). Rédige en <b>anglais</b> — le produit est anglophone — et reste parcimonieux : une notification de trop = désinstallation.</div>
                    <div class="mkt-notif-grid">
                        <div>
                            <input type="text" id="mkt-nt" maxlength="60" placeholder="Titre — ex. Flash Sale: 40% off tonight ⚡" autocomplete="off">
                            <div class="ssub" id="mkt-nt-c" style="text-align:right;margin-top:3px">0/60</div>
                            <textarea id="mkt-nb" maxlength="240" rows="3" placeholder="Message — ex. Annual plans are 40% off until Sunday. Open Norva to grab yours."></textarea>
                            <div class="ssub" id="mkt-nb-c" style="text-align:right;margin-top:3px">0/240</div>
                            <div class="ssub" style="margin:8px 0 4px">Audience</div>
                            <div class="pev" id="mkt-aud" data-val="all" style="max-width:360px">
                                <button type="button" class="pev-btn"><span class="pev-cur">📢 Tous les appareils</span><span class="pev-car">▾</span></button>
                                <div class="pev-menu" hidden></div>
                            </div>
                            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px">
                                <button class="mini-btn" id="mkt-send">📤 Envoyer maintenant</button>
                                <span class="ssub" id="mkt-send-msg"></span>
                            </div>
                        </div>
                        <div>
                            <div class="ssub" style="margin-bottom:6px">Aperçu (Android)</div>
                            <div class="mkt-preview">
                                <div class="mkt-pv-hd"><span class="mkt-pv-ic">N</span> Norva · maintenant</div>
                                <div class="mkt-pv-t" id="mkt-pv-t">Titre</div>
                                <div class="mkt-pv-b" id="mkt-pv-b">Message</div>
                            </div>
                            <div class="ssub" id="mkt-devices" style="margin-top:8px">📱 Appareils : chargement…</div>
                        </div>
                    </div>
                </div>
                <div class="admin-block"><h2>🗂 Historique des envois</h2>
                    <div class="mkt-log-bar">
                        <input type="search" id="mkt-log-q" placeholder="🔎 Rechercher (titre, message, auteur)…" autocomplete="off">
                        <div class="qv-row" id="mkt-log-auds" role="group" aria-label="Filtrer par audience"></div>
                    </div>
                    <div id="mkt-log"><div class="ssub">Chargement…</div></div>
                </div>
            </div>
        </div>`;

        // Bascule d'onglet : montrer/cacher en préservant l'état (dépliant promo
        // ouvert, brouillon de notification…), URL reflétée pour F5 / favoris.
        v.querySelectorAll('#mkt-tabs .qv-chip').forEach(chip => chip.addEventListener('click', () => {
            const t = MKT_TABS[chip.dataset.mtab] ? chip.dataset.mtab : 'overview';
            this._marketingTab = t;
            v.querySelectorAll('#mkt-tabs .qv-chip').forEach(c => c.classList.toggle('active', c === chip));
            Object.entries(MKT_TABS).forEach(([k2, id]) => {
                const node = document.getElementById(id);
                if (node) node.style.display = k2 === t ? '' : 'none';
            });
            try { if (String(location.hash || '').startsWith('#admin')) history.replaceState(history.state, '', '#admin/marketing' + (t === 'overview' ? '' : '/' + t)); } catch (_) { /* non-navigable */ }
        }));

        this._loadWebPrices();
        this._loadMarketingOverview();
        this._loadPushLog();
        this._wirePushComposer();
        this._wirePushLogControls();
    }

    // Vue d'ensemble Marketing : promos actives (billing_prices), appareils push,
    // notifications 30 j, visuel de campagne — chaque KPI dégrade proprement si
    // sa migration n'est pas encore passée.
    async _loadMarketingOverview() {
        const el = document.getElementById('mkt-overview');
        if (!el) return;
        const esc = AdminPage.esc, n = AdminPage.n;
        let ov = null, prices = null, camp = null;
        try { ov = await this._rpc('admin_marketing_overview'); } catch (_) { /* migration 20260719090000 absente */ }
        try { prices = await this._rpc('admin_billing_prices'); } catch (_) { /* dégradé */ }
        try { camp = await this._rpc('admin_promo_campaign'); } catch (_) { /* dégradé */ }
        if (this._route !== 'marketing') return;
        const rows = Array.isArray(prices) ? prices : [];
        const actives = rows.filter(r => r.promo_active);
        const LBL = { plus: 'Norva', family: 'Norva Family' }, PER = { monthly: 'mensuel', annual: 'annuel' };
        const day = d => d ? new Date(d).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
        const promoRows = actives.map(r => {
            const pct = Math.max(1, Math.round(100 - (r.promo_amount_cents / r.amount_cents) * 100));
            const bits = [`−${pct}%`, `$${(r.promo_amount_cents / 100).toFixed(2)} (base $${(r.amount_cents / 100).toFixed(2)})`];
            if (r.promo_cycles) bits.push(`${r.promo_cycles} période${r.promo_cycles > 1 ? 's' : ''} puis base`);
            if (r.promo_ref_monthly) bits.push('réf. 12× mensuel');
            const end = day(r.promo_ends_at);
            return `<tr><td>${esc(LBL[r.plan] || r.plan)} · ${esc(PER[r.period] || r.period)}</td><td>${esc(bits.join(' · '))}</td><td>${end ? esc(end) : '<span class="pacct">sans échéance</span>'}</td></tr>`;
        }).join('');
        const card = (v2, l, icon, cls) => `<div class="kpi ${cls || ''}"><div class="kpi-hd"><div class="v">${v2}</div><span class="kpi-ic">${icon}</span></div><div class="l">${l}</div></div>`;
        el.innerHTML = `
            <div class="kpi-group"><div class="kpi-gtitle">📣 L'essentiel</div><div class="admin-cards">
                ${card(n(actives.length), 'Promo(s) active(s)', '🏷️', actives.length ? 'ok' : '')}
                ${card(ov ? n(ov.push_devices) : '—', 'Appareils push' + (ov && Number(ov.push_users) ? ` (${n(ov.push_users)} compte${Number(ov.push_users) > 1 ? 's' : ''})` : ''), '📱', ov && Number(ov.push_devices) > 0 ? 'ok' : '')}
                ${card(ov ? n(ov.notifs_30d) : '—', 'Notifications envoyées (30 j)', '📤', '')}
                ${card(camp && camp.bg_path ? 'Oui' : 'Non', 'Visuel de campagne', '🎨', camp && camp.bg_path ? 'ok' : '')}
            </div></div>
            <div class="admin-block"><h2>🏷️ Promotions en cours</h2>
                ${promoRows
                    ? `<div class="scroll"><table><thead><tr><th>Tarif</th><th>Promo</th><th>Fin</th></tr></thead><tbody>${promoRows}</tbody></table></div>`
                    : '<div class="ssub">Aucune promotion active — lance-en une dans l\'onglet Promotions.</div>'}
            </div>
            <div class="admin-block"><h2>⚡ Raccourcis</h2>
                <div style="display:flex;gap:10px;flex-wrap:wrap">
                    <button class="mini-btn" data-goto="promos">🏷️ Gérer les promotions</button>
                    <button class="mini-btn" data-goto="notifs">📲 Envoyer une notification</button>
                </div>
                ${ov && ov.last_notif_at ? `<div class="ssub" style="margin-top:8px">Dernière notification envoyée ${AdminPage.timeAgo(ov.last_notif_at)}.</div>` : ''}
                ${ov ? '' : '<div class="ssub" style="margin-top:8px">⚠ KPIs push indisponibles — appliquer la migration 20260719090000 puis <code>NOTIFY pgrst, \'reload schema\'</code>.</div>'}
            </div>`;
        el.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => {
            document.querySelector(`#mkt-tabs .qv-chip[data-mtab="${b.dataset.goto}"]`)?.click();
        }));
    }

    // Audiences push : clé serveur → picto + libellés (composeur + historique).
    static AUDIENCES() {
        return [
            ['all', '📢', 'Tous les appareils'],
            ['trialing', '⏳', 'En essai'],
            ['paying', '💳', 'Abonnés payants'],
            ['monthly', '📅', 'Mensuels payants — upsell annuel'],
            ['free', '💤', 'Sans abonnement actif — win-back']
        ];
    }
    static audShort(a) {
        const x = AdminPage.AUDIENCES().find(v => v[0] === a);
        return x ? `${x[1]} ${x[0] === 'all' ? 'Tous' : x[0] === 'trialing' ? 'Essai' : x[0] === 'paying' ? 'Payants' : x[0] === 'monthly' ? 'Mensuels' : 'Sans abo'}` : (a || '—');
    }

    // Historique des notifications push marketing — vraie liste : recherche
    // (titre/message/auteur, débouncée), filtre par audience, message à la ligne.
    async _loadPushLog() {
        const el = document.getElementById('mkt-log');
        if (!el) return;
        try {
            const rows = await this._rpc('admin_marketing_push_log', {
                p_query: (this._pushLogQuery || '').trim() || null,
                p_audience: this._pushLogAud || null,
                p_limit: 100
            });
            if (this._route !== 'marketing') return;
            const esc = AdminPage.esc, n = AdminPage.n;
            const list = Array.isArray(rows) ? rows : [];
            el.innerHTML = list.length
                ? `<div class="scroll"><table><thead><tr><th>Date</th><th>Audience</th><th>Titre</th><th>Message</th><th class="num">Envoyés</th><th class="num">Échecs</th><th>Par</th></tr></thead><tbody>${list.map(r => `<tr>
                    <td style="white-space:nowrap;vertical-align:top">${new Date(r.created_at).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                    <td style="vertical-align:top"><span class="badge blue">${esc(AdminPage.audShort(r.audience))}</span></td>
                    <td class="mkt-td-wrap"><div class="mkt-log-title">${esc(r.title)}</div></td>
                    <td class="mkt-td-wrap"><div class="mkt-log-msg">${esc(r.body)}</div></td>
                    <td class="num" style="vertical-align:top">${n(r.sent_count)}</td>
                    <td class="num" style="vertical-align:top">${Number(r.fail_count) ? `<span class="badge red">${n(r.fail_count)}</span>` : '0'}${Number(r.dead_count) ? ` <span class="pacct" title="Tokens morts purgés pendant l'envoi">· ${n(r.dead_count)} purgé(s)</span>` : ''}</td>
                    <td style="vertical-align:top"><div class="mkt-log-clip" style="max-width:180px" title="${esc(r.actor || '')}">${esc(r.actor || '—')}</div></td>
                </tr>`).join('')}</tbody></table></div>`
                : `<div class="ssub">${(this._pushLogQuery || this._pushLogAud) ? 'Aucun envoi ne correspond à cette recherche.' : 'Aucune notification marketing envoyée pour l\'instant — la première apparaîtra ici avec ses compteurs.'}</div>`;
        } catch (e) {
            el.innerHTML = `<div class="ssub">Historique indisponible — appliquer les migrations 20260719090000 + 20260719110000 puis <code>NOTIFY pgrst, 'reload schema'</code>. (${AdminPage.esc(e && e.message ? e.message : 'erreur')})</div>`;
        }
    }

    // Barre de l'historique : recherche débouncée + chips d'audience.
    _wirePushLogControls() {
        const q = document.getElementById('mkt-log-q');
        const auds = document.getElementById('mkt-log-auds');
        if (q) {
            q.value = this._pushLogQuery || '';
            q.addEventListener('input', () => {
                this._pushLogQuery = q.value;
                clearTimeout(this._pushLogQT);
                this._pushLogQT = setTimeout(() => this._loadPushLog(), 300);
            });
        }
        if (auds) {
            const mk = (val, label) => `<button class="qv-chip${(this._pushLogAud || '') === val ? ' active' : ''}" data-aud="${val}">${label}</button>`;
            auds.innerHTML = mk('', 'Toutes') + AdminPage.AUDIENCES().map(([v]) => mk(v, AdminPage.audShort(v))).join('');
            auds.querySelectorAll('.qv-chip').forEach(chip => chip.addEventListener('click', () => {
                this._pushLogAud = chip.dataset.aud || '';
                auds.querySelectorAll('.qv-chip').forEach(c => c.classList.toggle('active', c === chip));
                this._loadPushLog();
            }));
        }
    }

    // Composeur : aperçu Android en direct + envoi via norva-admin /marketing-push
    // (admin-JWT ; l'edge lit les tokens, envoie via FCM, purge les tokens morts
    // et journalise). Confirmation obligatoire — un push, ça ne se rappelle pas.
    _wirePushComposer() {
        const nt = document.getElementById('mkt-nt'), nb = document.getElementById('mkt-nb');
        const pvT = document.getElementById('mkt-pv-t'), pvB = document.getElementById('mkt-pv-b');
        const cT = document.getElementById('mkt-nt-c'), cB = document.getElementById('mkt-nb-c');
        if (!nt || !nb) return;
        const syncPv = () => {
            if (pvT) pvT.textContent = nt.value.trim() || 'Titre';
            if (pvB) pvB.textContent = nb.value.trim() || 'Message';
            if (cT) cT.textContent = `${nt.value.length}/60`;
            if (cB) cB.textContent = `${nb.value.length}/240`;
        };
        nt.addEventListener('input', syncPv);
        nb.addEventListener('input', syncPv);
        syncPv();
        // Sélecteur d'audience : dépliant maison + compteur d'appareils PAR
        // segment (admin_marketing_audience_counts). Le hint sous l'aperçu suit
        // la sélection — on sait toujours combien d'appareils seront touchés.
        const aud = document.getElementById('mkt-aud');
        let audCounts = null;
        const audLabel = (v) => {
            const x = AdminPage.AUDIENCES().find(a => a[0] === v) || AdminPage.AUDIENCES()[0];
            return `${x[1]} ${x[2]}`;
        };
        const syncHint = () => {
            const d = document.getElementById('mkt-devices');
            if (!d) return;
            const v = aud?.dataset.val || 'all';
            if (audCounts && typeof audCounts[v] === 'number') {
                d.textContent = `📱 ${AdminPage.n(audCounts[v])} appareil(s) ciblé(s) — ${audLabel(v)}`;
            } else {
                d.textContent = `📱 Audience : ${audLabel(v)}`;
            }
        };
        if (aud) {
            const btn = aud.querySelector('.pev-btn');
            const menu = aud.querySelector('.pev-menu');
            const renderMenu = () => {
                menu.innerHTML = AdminPage.AUDIENCES().map(([v, ic, l]) =>
                    `<button type="button" class="pev-opt${(aud.dataset.val || 'all') === v ? ' on' : ''}" data-val="${v}">${ic} ${l}${audCounts && typeof audCounts[v] === 'number' ? ` <span class="pacct">· ${AdminPage.n(audCounts[v])} appareil(s)</span>` : ''}</button>`).join('');
                menu.querySelectorAll('.pev-opt').forEach(opt => opt.addEventListener('click', () => {
                    aud.dataset.val = opt.dataset.val || 'all';
                    const cur = aud.querySelector('.pev-cur');
                    if (cur) cur.textContent = audLabel(aud.dataset.val);
                    menu.hidden = true;
                    renderMenu();
                    syncHint();
                }));
            };
            renderMenu();
            btn?.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
            if (!this._mktPevCloseWired) {
                this._mktPevCloseWired = true;
                document.addEventListener('click', () => {
                    document.querySelectorAll('#mkt-tab-notifs .pev-menu').forEach(m => { m.hidden = true; });
                });
            }
            (async () => {
                try {
                    audCounts = await this._rpc('admin_marketing_audience_counts');
                    renderMenu();
                } catch (_) { /* migration 20260719110000 absente — sélecteur sans compteurs */ }
                syncHint();
            })();
        }
        syncHint();
        const sendBtn = document.getElementById('mkt-send');
        sendBtn?.addEventListener('click', async () => {
            const title = nt.value.trim(), body = nb.value.trim();
            const audience = aud?.dataset.val || 'all';
            const msg = document.getElementById('mkt-send-msg');
            if (title.length < 2 || body.length < 2) { if (msg) msg.textContent = '❌ Titre et message obligatoires (2 caractères min).'; return; }
            const nDev = audCounts && typeof audCounts[audience] === 'number' ? `≈ ${AdminPage.n(audCounts[audience])} appareil(s)` : 'les appareils du segment';
            if (!window.confirm(`Envoyer cette notification à « ${audLabel(audience)} » (${nDev}) ?\n\n« ${title} »\n${body}\n\nEnvoi immédiat — un push ne se rappelle pas.`)) return;
            sendBtn.disabled = true;
            if (msg) msg.textContent = 'Envoi…';
            try {
                const res = await fetch(`${this._sbUrl()}/functions/v1/norva-admin/marketing-push`, {
                    method: 'POST',
                    headers: { apikey: this._sbKey(), Authorization: `Bearer ${this._token()}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title, body, audience })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || String(res.status));
                if (msg) msg.textContent = `✅ ${AdminPage.n(data.sent)} envoyé(s) sur ${AdminPage.n(data.devices)} appareil(s) — ${audLabel(data.audience || audience)}`
                    + (data.fail ? ` · ${AdminPage.n(data.fail)} échec(s)` : '')
                    + (data.dead ? ` · ${AdminPage.n(data.dead)} token(s) mort(s) purgé(s)` : '');
                nt.value = ''; nb.value = ''; syncPv();
                this._loadPushLog();
            } catch (e) {
                if (msg) msg.textContent = '❌ ' + (e && e.message ? e.message : 'échec');
            } finally { sendBtn.disabled = false; }
        });
    }

    // Carte « 💵 Tarifs web » : édition de billing_prices (source unique lue par les
    // edge et le front). Deux étages par tarif : le prix de BASE, et une PROMO
    // optionnelle (montant + événement → badge sur la page de vente + échéance
    // auto-désactivante). Le promo PRIME tant qu'il est rempli et non échu.
    // Effet : nouveaux checkouts + changements de plan uniquement — les abonnés
    // existants gardent leur prix souscrit (mapping). Cache edge 60 s.
    async _loadWebPrices() {
        const host = document.getElementById('fin-prices');
        if (!host) return;
        let rows = null;
        try { rows = await this._rpc('admin_billing_prices'); } catch (_) { /* rendu dégradé ci-dessous */ }
        if (!Array.isArray(rows) || !rows.length) {
            host.innerHTML = '<div class="ssub">Table des tarifs indisponible — appliquer les migrations 20260718150000 + 20260718170000 (supabase_admin) puis <code>NOTIFY pgrst, \'reload schema\'</code>.</div>';
            return;
        }
        const LBL = { plus: 'Norva', family: 'Norva Family' };
        const PER = { monthly: 'mensuel', annual: 'annuel' };
        // Catalogue d'événements (clé serveur → libellé FR admin + icône) ; le badge
        // côté page de vente est le libellé anglais correspondant — sauf libellé
        // personnalisé (événement « Autre »), qui prime.
        const EVENTS = [
            ['black_friday', 'Black Friday', '🖤'], ['cyber_monday', 'Cyber Monday', '💻'],
            ['winter_sale', 'Soldes d\'hiver', '❄️'], ['summer_sale', 'Soldes d\'été', '☀️'],
            ['christmas', 'Noël', '🎄'], ['new_year', 'Nouvel An', '🎆'], ['lunar_new_year', 'Nouvel An chinois', '🏮'],
            ['eid', 'Aïd', '🌙'], ['easter', 'Pâques', '🐣'], ['halloween', 'Halloween', '🎃'],
            ['valentines', 'Saint-Valentin', '💘'], ['back_to_school', 'Rentrée', '🎒'],
            ['birthday', 'Anniversaire Norva', '🎂'], ['flash', 'Vente flash', '⚡'], ['other', 'Autre…', '🏷️']
        ];
        const evOf = v => EVENTS.find(x => x[0] === v) || EVENTS[0];
        const escA = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        const toLocalInput = iso => {
            if (!iso) return '';
            const d = new Date(iso);
            if (!isFinite(d.getTime())) return '';
            const p = x => String(x).padStart(2, '0');
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
        };
        const by = {};
        rows.forEach(r => { by[r.plan + ':' + r.period] = r; });
        const order = ['plus:monthly', 'plus:annual', 'family:monthly', 'family:annual'].filter(k => by[k]);
        host.innerHTML = `<div class="price-grid">${order.map(k => {
            const [plan, period] = k.split(':');
            const r = by[k];
            return `<div class="price-cell${r.promo_active ? ' promo-on' : ''}">
                <span>${LBL[plan]} · ${PER[period]}${r.promo_active ? ' <span class="pchip">PROMO</span>' : ''}</span>
                <span class="price-in" title="Prix de base">$ <input type="number" step="0.01" min="1" max="999.99" data-price="${k}" value="${(r.amount_cents / 100).toFixed(2)}">${period === 'annual'
                    ? `<button type="button" class="refm${r.promo_ref_monthly ? ' on' : ''}" data-refm="${k}" title="Ancre marketing (promo annuelle) : afficher la réduction par rapport à 12 × le prix mensuel de base, au lieu du prix annuel de base — le site le présente comme « vs monthly billing » (comparaison de deux offres actuelles, légal), jamais comme un ancien prix. Actif uniquement quand une promo est remplie.">12×</button>`
                    : ''}</span>
                <div class="promo-sub" title="Promo : prime sur le prix de base tant qu'elle est remplie (et non échue)">
                    <span class="price-in">🏷 $ <input type="number" step="0.01" min="1" max="999.99" data-promo="${k}" placeholder="—" value="${r.promo_amount_cents ? (r.promo_amount_cents / 100).toFixed(2) : ''}"></span>
                    <div class="pev" data-pev-host="${k}" data-val="${escA(r.promo_event || 'black_friday')}">
                        <button type="button" class="pev-btn"><span class="pev-cur">${evOf(r.promo_event || 'black_friday')[2]} ${evOf(r.promo_event || 'black_friday')[1]}</span><span class="pev-car">▾</span></button>
                        <div class="pev-menu" hidden>${EVENTS.map(([v, l, ic]) =>
                            `<button type="button" class="pev-opt${(r.promo_event || 'black_friday') === v ? ' on' : ''}" data-val="${v}">${ic} ${l}</button>`).join('')}</div>
                    </div>
                    <input type="text" class="pev-label" data-plabel="${k}" maxlength="24" placeholder="Nom de l'événement (badge affiché)" value="${escA(r.promo_label || '')}"${(r.promo_event || '') === 'other' ? '' : ' style="display:none"'} title="Libellé du badge sur la page de vente (2-24 caractères) — pour un événement propre à Norva">
                    <span class="price-in" title="Nombre de périodes facturées au prix promo, puis retour au prix de base — vide = réduction à vie (réserver aux early-birds). Conseillé : 3 en mensuel, 1 en annuel.">🔁 <input type="number" min="1" max="24" step="1" data-pcycles="${k}" placeholder="∞" value="${r.promo_amount_cents ? (r.promo_cycles ?? '') : (period === 'monthly' ? 3 : 1)}"> <em class="pcy-unit">${period === 'monthly' ? 'mois au prix promo' : 'an(s) au prix promo'}</em></span>
                    <input type="datetime-local" data-pends="${k}" value="${toLocalInput(r.promo_ends_at)}" title="Fin de promo (optionnel) — passée cette date, la promo s'auto-désactive">
                </div>
            </div>`;
        }).join('')}</div>
            <div style="margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
                <button class="mini-btn" id="fin-prices-save">💾 Enregistrer</button>
                <span class="ssub">Promo vide = tarif de base seul. L'échéance est optionnelle (auto-désactivation).</span>
                <span class="ssub" id="fin-prices-msg"></span>
            </div>
            <div class="kpi-gtitle" style="margin:16px 0 6px">🎨 Visuel de campagne (optionnel)</div>
            <div class="ssub" style="margin-bottom:8px">Image de <b>fond plein écran</b> de la page de vente pendant une promo (les cartes gardent leur halo aux couleurs de l'événement). Uploade en <b>pleine qualité</b> (JPG/PNG/WebP, paysage 1920 × 1080 px ou plus, jusqu'à ~25 Mo) — l'image est <b>optimisée automatiquement</b> avant l'envoi (max 2560 px, WebP haute qualité) pour que la page reste instantanée. Un dégradé sombre vertical est appliqué par-dessus : le haut reste visible, le bas s'assombrit derrière les cartes.</div>
            <div id="fin-campaign" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span class="ssub">Chargement…</span></div>`;
        // Dépliant d'événement maison (le <select> natif rendait clair-sur-clair) :
        // clic → panneau sombre avec icônes ; « Autre… » révèle le champ du libellé
        // personnalisé (badge affiché tel quel sur la page de vente).
        host.querySelectorAll('[data-pev-host]').forEach(pev => {
            const key = pev.dataset.pevHost;
            const btn = pev.querySelector('.pev-btn');
            const menu = pev.querySelector('.pev-menu');
            btn?.addEventListener('click', (e) => {
                e.stopPropagation();
                const wasHidden = menu.hidden;
                host.querySelectorAll('.pev-menu').forEach(m => { m.hidden = true; });
                menu.hidden = !wasHidden;
            });
            menu?.querySelectorAll('.pev-opt').forEach(opt => opt.addEventListener('click', () => {
                pev.dataset.val = opt.dataset.val || 'other';
                const curSpan = pev.querySelector('.pev-cur');
                if (curSpan) curSpan.textContent = opt.textContent;
                menu.querySelectorAll('.pev-opt').forEach(o => o.classList.toggle('on', o === opt));
                menu.hidden = true;
                const lblIn = host.querySelector(`input[data-plabel="${key}"]`);
                if (lblIn) {
                    lblIn.style.display = pev.dataset.val === 'other' ? '' : 'none';
                    if (pev.dataset.val === 'other') lblIn.focus();
                }
            }));
        });
        if (!this._pevCloseWired) {
            this._pevCloseWired = true;
            document.addEventListener('click', () => {
                document.querySelectorAll('#fin-prices .pev-menu').forEach(m => { m.hidden = true; });
            });
        }
        // Bouton « 12× » (ancre marketing des promos annuelles) : cliquable
        // uniquement quand le champ promo de la ligne est rempli — suit la
        // saisie en direct.
        host.querySelectorAll('[data-refm]').forEach(btn => {
            const key = btn.dataset.refm;
            const promoIn = host.querySelector(`input[data-promo="${key}"]`);
            const sync = () => { btn.disabled = !String(promoIn?.value ?? '').trim(); };
            sync();
            promoIn?.addEventListener('input', sync);
            btn.addEventListener('click', () => btn.classList.toggle('on'));
        });

        const msgEl = () => document.getElementById('fin-prices-msg');
        document.getElementById('fin-prices-save')?.addEventListener('click', async () => {
            const baseEdits = [], promoEdits = [];
            for (const k of order) {
                const [plan, period] = k.split(':');
                const cur = by[k];
                const baseIn = host.querySelector(`input[data-price="${k}"]`);
                const cents = Math.round(parseFloat(baseIn?.value) * 100);
                if (Number.isFinite(cents) && cents !== Number(cur.amount_cents)) baseEdits.push({ plan, period, cents });
                const pv = String(host.querySelector(`input[data-promo="${k}"]`)?.value ?? '').trim();
                const pCents = pv === '' ? null : Math.round(parseFloat(pv) * 100);
                const pEvent = String(host.querySelector(`[data-pev-host="${k}"]`)?.dataset.val || 'other');
                const pLabelRaw = String(host.querySelector(`input[data-plabel="${k}"]`)?.value || '').trim();
                const pLabel = (pEvent === 'other' && pLabelRaw) ? pLabelRaw.slice(0, 24) : null;
                const pEndsRaw = String(host.querySelector(`input[data-pends="${k}"]`)?.value || '');
                const pEnds = pEndsRaw ? new Date(pEndsRaw).toISOString() : null;
                const curEnds = cur.promo_ends_at ? new Date(cur.promo_ends_at).toISOString() : null;
                const pCycRaw = String(host.querySelector(`input[data-pcycles="${k}"]`)?.value ?? '').trim();
                let pCycles = pCycRaw === '' ? null : Math.round(parseFloat(pCycRaw));
                if (pCycles != null && (!Number.isFinite(pCycles) || pCycles < 1)) pCycles = null;
                if (pCycles != null) pCycles = Math.min(24, pCycles);
                const pRef = period === 'annual'
                    && Boolean(host.querySelector(`[data-refm="${k}"]`)?.classList.contains('on'));
                const changed = (pCents ?? null) !== (cur.promo_amount_cents ?? null)
                    || (pCents != null && (pEvent !== (cur.promo_event || 'other') || pEnds !== curEnds
                        || (pLabel || null) !== (cur.promo_label || null)
                        || (pCycles ?? null) !== (cur.promo_cycles ?? null)
                        || pRef !== Boolean(cur.promo_ref_monthly)));
                if (!changed) continue;
                if (pCents != null && !Number.isFinite(pCents)) continue;
                if (pCents != null && pEvent === 'other' && pLabelRaw && pLabelRaw.length < 2) {
                    if (msgEl()) msgEl().textContent = `❌ ${LBL[plan]} ${PER[period]} : le nom de l'événement fait 2 à 24 caractères.`;
                    return;
                }
                const baseAfter = Number.isFinite(cents) ? cents : Number(cur.amount_cents);
                if (pCents != null && pCents >= baseAfter) {
                    if (msgEl()) msgEl().textContent = `❌ ${LBL[plan]} ${PER[period]} : le promo doit être inférieur au prix de base.`;
                    return;
                }
                promoEdits.push({ plan, period, cents: pCents, event: pEvent, ends: pEnds, label: pLabel, cycles: pCycles, ref: pRef });
            }
            if (!baseEdits.length && !promoEdits.length) { if (msgEl()) msgEl().textContent = 'Aucun changement.'; return; }
            const rec = baseEdits.map(e => `${LBL[e.plan]} ${PER[e.period]} → $${(e.cents / 100).toFixed(2)}`)
                .concat(promoEdits.map(e => e.cents == null
                    ? `${LBL[e.plan]} ${PER[e.period]} : fin de promo`
                    : `${LBL[e.plan]} ${PER[e.period]} : PROMO $${(e.cents / 100).toFixed(2)} (${e.label || evOf(e.event)[1]}, ${e.cycles ? e.cycles + ' période' + (e.cycles > 1 ? 's' : '') + ' puis prix de base' : 'à vie'}${e.ref ? ', réf. 12× mensuel' : ''})`))
                .join('\n');
            if (!window.confirm(`Appliquer ces changements ?\n${rec}\n\nEffet immédiat sur les nouveaux checkouts (abonnés existants inchangés).`)) return;
            try {
                for (const e of baseEdits) {
                    await this._rpc('admin_billing_price_set', { p_plan: e.plan, p_period: e.period, p_amount_cents: e.cents });
                }
                for (const e of promoEdits) {
                    await this._rpc('admin_billing_promo_set', {
                        p_plan: e.plan, p_period: e.period,
                        p_amount_cents: e.cents, p_event: e.cents == null ? null : e.event,
                        p_ends_at: e.cents == null ? null : e.ends, p_label: e.cents == null ? null : e.label,
                        p_cycles: e.cents == null ? null : e.cycles,
                        p_ref_monthly: e.cents == null ? false : Boolean(e.ref),
                    });
                }
                if (msgEl()) msgEl().textContent = `✅ Enregistré — visible sur le site sous ~1 min (cache edge 60 s).`;
                this._loadWebPrices();
            } catch (e) {
                if (msgEl()) msgEl().textContent = '❌ ' + (e && e.message ? e.message : 'échec');
            }
        });

        // Visuel de campagne : image publique (bucket promo-assets, écriture admin)
        // appliquée en fond de la carte en promo. Best-effort — la carte tarifs
        // reste utilisable si la migration campagne n'est pas encore passée.
        try {
            const camp = await this._rpc('admin_promo_campaign');
            const cHost = document.getElementById('fin-campaign');
            if (cHost) {
                const path = camp && camp.bg_path ? String(camp.bg_path) : '';
                const url = path ? `${this._sbUrl()}/storage/v1/object/public/promo-assets/${path}` : '';
                cHost.innerHTML = `${url
                    ? `<img src="${url}" alt="Visuel de campagne" style="width:160px;height:90px;object-fit:cover;border-radius:8px;border:1px solid var(--adm-line)">`
                    : '<span class="ssub">Aucune image — les promos utilisent le thème par défaut de leur événement.</span>'}
                    <input type="file" id="fin-campaign-file" accept="image/jpeg,image/png,image/webp" style="font-size:12px;color:var(--adm-tx2)">
                    ${url ? '<button class="mini-btn" id="fin-campaign-clear">✕ Retirer</button>' : ''}
                    <span class="ssub" id="fin-campaign-msg"></span>`;
                // Optimisation navigateur : l'admin peut uploader un artwork en pleine
                // qualité (PNG IA de 10 Mo…) — on le recadre à 2560 px max et on le
                // ré-encode en WebP haute qualité AVANT l'envoi. Qualité visuelle
                // intacte pour un fond de page, poids divisé par 10-20 : la page de
                // vente doit rester instantanée, c'est elle qui convertit.
                const optimizeImage = (file) => new Promise((resolve, reject) => {
                    const url = URL.createObjectURL(file);
                    const img = new Image();
                    img.onload = () => {
                        try {
                            URL.revokeObjectURL(url);
                            const MAXDIM = 2560;
                            const scale = Math.min(1, MAXDIM / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
                            const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
                            const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
                            const cv = document.createElement('canvas');
                            cv.width = w; cv.height = h;
                            cv.getContext('2d').drawImage(img, 0, 0, w, h);
                            cv.toBlob(b => {
                                // On ne garde l'optimisée que si elle apporte quelque chose
                                // (plus légère, ou redimensionnée) — sinon l'original suffit.
                                if (b && b.size > 0 && (b.size < file.size || scale < 1)) resolve(b);
                                else resolve(null);
                            }, 'image/webp', 0.85);
                        } catch (e) { reject(e); }
                    };
                    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image illisible')); };
                    img.src = url;
                });
                const fmtSize = (n) => n >= 1024 * 1024 ? (n / 1048576).toFixed(1) + ' Mo' : Math.max(1, Math.round(n / 1024)) + ' Ko';
                document.getElementById('fin-campaign-file')?.addEventListener('change', async (ev) => {
                    const f = ev.target.files && ev.target.files[0];
                    if (!f) return;
                    const cMsg = document.getElementById('fin-campaign-msg');
                    if (f.size > 25 * 1024 * 1024) { if (cMsg) cMsg.textContent = '❌ Fichier > 25 Mo — exporte une version plus raisonnable.'; return; }
                    if (cMsg) cMsg.textContent = '⏳ Optimisation…';
                    try {
                        // Type MIME de repli (upload de l'original si l'optimisation
                        // n'apporte rien) : celui du navigateur s'il est accepté par le
                        // bucket, sinon déduit de l'extension.
                        const byExt = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
                        const nameExt = String(f.name || '').split('.').pop().toLowerCase();
                        let body = f;
                        let mime = ['image/jpeg', 'image/png', 'image/webp'].includes(f.type) ? f.type : (byExt[nameExt] || 'image/jpeg');
                        try {
                            const opt = await optimizeImage(f);
                            if (opt) { body = opt; mime = 'image/webp'; }
                        } catch (_) { /* image exotique → tentative avec l'original */ }
                        if (body.size > 10 * 1024 * 1024) {
                            if (cMsg) cMsg.textContent = '❌ Impossible de passer sous 10 Mo — réduis la résolution de l\'export.';
                            return;
                        }
                        if (cMsg) cMsg.textContent = `⬆ Envoi… (${fmtSize(f.size)}${body !== f ? ' → ' + fmtSize(body.size) : ''})`;
                        const ext = mime === 'image/png' ? 'png' : (mime === 'image/webp' ? 'webp' : 'jpg');
                        const objPath = `campaign/bg-${Date.now()}.${ext}`;
                        const res = await fetch(`${this._sbUrl()}/storage/v1/object/promo-assets/${objPath}`, {
                            method: 'POST',
                            headers: { apikey: this._sbKey(), Authorization: `Bearer ${this._token()}`, 'Content-Type': mime, 'x-upsert': 'true' },
                            body,
                        });
                        if (!res.ok) {
                            // La vraie raison du storage (RLS, MIME, taille) — sans
                            // elle, un « 400 » sec est indiagnosticable.
                            const t = await res.text().catch(() => '');
                            throw new Error('upload ' + res.status + (t ? ' — ' + t.slice(0, 180) : ''));
                        }
                        await this._rpc('admin_promo_campaign_set', { p_bg_path: objPath });
                        if (cMsg) cMsg.textContent = `✅ En ligne (${fmtSize(body.size)}${body !== f ? ', optimisée depuis ' + fmtSize(f.size) : ''}).`;
                        setTimeout(() => this._loadWebPrices(), 1200);
                    } catch (e) {
                        if (cMsg) cMsg.textContent = '❌ ' + (e && e.message ? e.message : 'échec');
                    }
                });
                document.getElementById('fin-campaign-clear')?.addEventListener('click', async () => {
                    try { await this._rpc('admin_promo_campaign_set', { p_bg_path: null }); this._loadWebPrices(); } catch (_) { /* noop */ }
                });
            }
        } catch (_) {
            const cHost = document.getElementById('fin-campaign');
            if (cHost) cHost.innerHTML = '<span class="ssub">Visuel de campagne indisponible — appliquer la migration 20260718190000 (+ NOTIFY pgrst).</span>';
        }
    }

    _renderFinance(f, sparks, vat, paywall) {
        const el = document.getElementById('fin-body');
        if (!el) return;
        const n = AdminPage.n, money = AdminPage.money, esc = AdminPage.esc;
        const S = sparks || {};
        if (Array.isArray(S.mrr_cents)) S.arr = S.mrr_cents.map(v => v == null ? null : v * 12); // ARR = MRR×12
        // card(value, label, cls, metricKey, icon, tip) — icon top-right + sparkline where a series
        // exists; optional tooltip for metrics that need a one-line explanation.
        const card = (v2, l, cls, key, icon, tip) => {
            const spark = key && Array.isArray(S[key]) ? AdminPage.spark(S[key], cls) : '';
            return `<div class="kpi ${cls || ''}"${tip ? ` title="${esc(tip)}"` : ''}><div class="kpi-hd"><div class="v">${v2}</div>${icon ? `<span class="kpi-ic">${icon}</span>` : ''}</div><div class="l">${l}</div>${spark ? `<div class="kpi-spark">${spark}</div>` : ''}</div>`;
        };
        // Non-colour-only state chip (same language as the Cockpit priority cards).
        const stateChip = (bad, crit) => `<span class="kpi-state ${bad ? (crit ? 'crit' : 'warn') : 'ok'}">${bad ? (crit ? 'Critique' : 'À traiter') : 'OK'}</span>`;
        const counts = f.counts || {};
        const up = f.upcoming || {};
        const day = (d) => d ? new Date(d).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

        // Status cards are the daily working views: each one opens Clients pre-filtered. Icon top-right,
        // optional state chip (à traiter / critique) on the label.
        const statusCard = (v2, l, filter, cls, icon, chip) =>
            `<div class="kpi fin-status ${cls || ''}" data-billing="${filter}" role="button" tabindex="0" style="cursor:pointer" title="Voir ces clients"><div class="kpi-hd"><div class="v">${v2}</div>${icon ? `<span class="kpi-ic">${icon}</span>` : ''}</div><div class="l">${l}${chip || ''}</div></div>`;

        const byPlan = Array.isArray(f.by_plan) ? f.by_plan : [];
        const planRows = byPlan.map(r => `<tr>
            <td>${esc(r.plan_code)}</td><td>${esc(r.period)}</td><td><span class="badge blue">${esc(r.provider)}</span></td>
            <td class="num">${n(r.n)}</td><td class="num">${money(r.mrr_cents)}</td>
        </tr>`).join('');

        // Compact horizontal-bar list (label · bar · value) — replaces dense mini-tables for
        // the funnel and cancellation reasons so the shape is readable at a glance.
        const hbars = (rows, cls) => {
            const max = Math.max(1, ...rows.map(r => Number(r.v) || 0));
            return `<div class="hbars">${rows.map(r => {
                const val = Number(r.v) || 0, pct = Math.max(2, Math.round(100 * val / max));
                return `<div class="hbar"${r.tip ? ` title="${esc(r.tip)}"` : ''}><div class="hbar-l" title="${esc(r.label)}">${esc(r.label)}</div>` +
                    `<div class="hbar-track"><div class="hbar-fill ${cls || ''}" style="width:${pct}%"></div></div>` +
                    `<div class="hbar-v">${n(val)}</div></div>`;
            }).join('')}</div>`;
        };

        // Conversion steps are ordered as a journey, not by implementation
        // date. Landing/page-view remains in the consent-gated marketing stack;
        // these stages are backed by authoritative first-party server records.
        const FUNNEL_ORDER = ['account_created', 'source_added', 'checkout_open', 'order_authorized', 'entitlement_active', 'first_play', 'trial_start', 'trial_convert', 'renewal', 'cancel', 'winback_return'];
        const FUNNEL_LABELS = { account_created: 'Compte créé', source_added: '1ʳᵉ source ajoutée', checkout_open: 'Checkout ouvert', order_authorized: 'Paiement autorisé', entitlement_active: 'Accès activé', first_play: '1ʳᵉ lecture', trial_start: 'Essai démarré', trial_convert: 'Essai → payant', renewal: 'Renouvellements', cancel: 'Annulations', winback_return: 'Retours win-back' };
        const funnelMap = {};
        (Array.isArray(f.funnel_30d) ? f.funnel_30d : []).forEach(r => { funnelMap[r.stage] = r.users; });
        const funnelData = FUNNEL_ORDER.filter(s => funnelMap[s] != null).map(s => ({ label: FUNNEL_LABELS[s] || s, v: funnelMap[s] }));

        // Dedicated paywall funnel. The server provides a true 30-day distinct-account
        // rollup plus dimensional cohorts. Never sum users from `stage_totals`: the same
        // account can legitimately appear on several placements or surfaces.
        const PAYWALL_ORDER = ['paywall_exposed', 'checkout_started', 'order_authorized', 'payment_captured', 'entitlement_activated', 'first_play'];
        const PAYWALL_LABELS = {
            paywall_exposed: 'Paywall affiché',
            checkout_started: 'Checkout démarré',
            order_authorized: 'Paiement autorisé',
            payment_captured: 'Paiement encaissé',
            entitlement_activated: 'Accès activé',
            first_play: '1ʳᵉ lecture réussie'
        };
        const pw = paywall && typeof paywall === 'object' ? paywall : {};
        const pwUnavailable = pw.unavailable === true;
        const pwStageTotals = Array.isArray(pw.stage_totals) ? pw.stage_totals : [];
        const hasPwRollup = Array.isArray(pw.stage_rollup);
        // Compatibility with a short-lived RPC version: a dimensional row can stand in
        // for a global total only when it is the sole row for that stage. No addition.
        const pwSingleDimensionFallback = hasPwRollup ? [] : PAYWALL_ORDER.map(stage => {
            const rows = pwStageTotals.filter(row => row && row.stage === stage);
            return rows.length === 1 ? rows[0] : null;
        }).filter(Boolean);
        const pwRollup = hasPwRollup ? pw.stage_rollup : pwSingleDimensionFallback;
        const pwRollupByStage = new Map((Array.isArray(pwRollup) ? pwRollup : [])
            .filter(row => row && PAYWALL_ORDER.includes(row.stage))
            .map(row => [row.stage, row]));
        const pwFunnelData = PAYWALL_ORDER.filter(stage => pwRollupByStage.has(stage)).map(stage => {
            const row = pwRollupByStage.get(stage);
            return {
                label: PAYWALL_LABELS[stage],
                v: row.users,
                tip: `${n(row.users)} compte(s) unique(s) · ${n(row.events)} événement(s)`
            };
        });
        const pwDimensions = pwStageTotals.filter(row => row && PAYWALL_ORDER.includes(row.stage)).slice().sort((a, b) => {
            const stage = PAYWALL_ORDER.indexOf(a.stage) - PAYWALL_ORDER.indexOf(b.stage);
            if (stage) return stage;
            return ['experiment_key', 'variant', 'placement', 'surface']
                .map(key => String(a[key] || '').localeCompare(String(b[key] || ''), 'fr'))
                .find(value => value) || 0;
        });
        const pwDim = value => value ? `<span class="badge gray">${esc(value)}</span>` : '<span class="ssub">—</span>';
        const pwDimensionRows = pwDimensions.map(row => `<tr>
            <td>${esc(PAYWALL_LABELS[row.stage] || row.stage)}</td>
            <td>${pwDim(row.experiment_key)}</td><td>${pwDim(row.variant)}</td>
            <td>${pwDim(row.placement)}</td><td>${pwDim(row.surface)}</td>
            <td class="num">${n(row.users)}</td><td class="num">${n(row.events)}</td>
        </tr>`).join('');
        const pwAssignments = Array.isArray(pw.assignments) ? pw.assignments : [];
        const assignedAccounts = (experimentKey, variant) => {
            const row = pwAssignments.find(a => a && a.experiment_key === experimentKey && a.variant === variant);
            return row ? Number(row.accounts) || 0 : 0;
        };
        const pwExperiments = (Array.isArray(pw.experiments) ? pw.experiments : []).map(experiment => {
            const variants = Array.isArray(experiment.variants) ? experiment.variants : [];
            const variantBadges = variants.map(variant => {
                const allocation = (Number(variant.allocation_bps) || 0) / 100;
                const accounts = assignedAccounts(experiment.experiment_key, variant.variant);
                const cls = variant.active === false ? 'gray' : allocation > 0 ? 'blue' : 'gray';
                return `<span class="badge ${cls}" title="Allocation pour les nouvelles assignations">${esc(variant.variant)} · ${allocation.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} % · ${n(accounts)} compte(s)</span>`;
            }).join('');
            return `<div class="pw-exp"><div class="pw-exp-h"><span>${esc(experiment.experiment_key)}</span>` +
                `<span class="badge ${experiment.active ? 'green' : 'gray'}">${experiment.active ? 'actif' : 'inactif'}</span></div>` +
                `<div class="pw-exp-v">${variantBadges || '<span class="ssub">Aucune variante.</span>'}</div></div>`;
        }).join('');
        const pwGenerated = pw.generated_at ? ` · généré ${esc(AdminPage.timeAgo(pw.generated_at))}` : '';
        const paywallFunnelHtml = pwUnavailable
            ? `<div class="admin-block"><h2>🧭 Funnel paywall (30 j)</h2><div class="ssub" title="${esc(pw.message || '')}">Analyse paywall indisponible sur ce déploiement. Le funnel historique et le reste de Finance restent accessibles.</div></div>`
            : `<div class="admin-block"><h2>🧭 Funnel paywall (30 j)</h2>
                <div class="ssub" style="margin-bottom:10px">Comptes uniques sur toute la fenêtre, calculés côté serveur — comptes internes exclus${pwGenerated}.</div>
                ${pwFunnelData.length ? hbars(pwFunnelData, '')
                    : (hasPwRollup
                        ? '<div class="ssub">Aucune exposition ou conversion commerciale sur les 30 derniers jours.</div>'
                        : '<div class="ssub">Totaux uniques globaux indisponibles sur cette version du RPC. Le détail dimensionnel ci-dessous reste exact et n’est pas additionné.</div>')}
                ${pwExperiments ? `<div class="pw-exp-grid">${pwExperiments}</div>` : '<div class="ssub" style="margin-top:12px">Aucune expérience configurée.</div>'}
                ${pwDimensionRows ? `<details class="pw-dims"><summary>Détail par variante, placement et surface · ${n(pwDimensions.length)} cohorte(s)</summary>
                    <div class="scroll"><table><thead><tr><th>Étape</th><th>Expérience</th><th>Variante</th><th>Placement</th><th>Surface</th><th class="num">Comptes</th><th class="num">Événements</th></tr></thead><tbody>${pwDimensionRows}</tbody></table></div>
                    <div class="pw-dims-note">Les comptes sont uniques dans chaque cohorte. Ne pas additionner les lignes entre placements ou surfaces : un même compte peut apparaître dans plusieurs cohortes.</div>
                </details>` : ''}
            </div>`;

        const REASONS = { too_expensive: 'Trop cher', not_using: 'Utilise pas assez', technical: 'Problème technique', other: 'Autre', skipped: 'Non précisé' };
        const reasonData = (Array.isArray(f.cancel_reasons) ? f.cancel_reasons : []).map(r => ({ label: REASONS[r.reason] || r.reason, v: r.n }));
        const savesTotal = Number(f.saves_total) || 0;
        const cancelsTotal = Number(f.cancels_total) || 0;
        const saveRate = (savesTotal + cancelsTotal) > 0 ? Math.round(100 * savesTotal / (savesTotal + cancelsTotal)) : null;

        const KIND_LABELS = { trial_setup: 'essai (carte)', first_charge: '1ᵉʳ prélèvement', renewal: 'renouvellement', plan_change: 'changement plan', resubscribe: 'réabonnement', card_update: 'MAJ carte', refund: 'remboursement' };
        // Payment status → business-readable FR label; raw provider status kept in a tooltip.
        const PAY_STATUS = { captured: 'Encaissé', authorized: 'Autorisé', to_capture: 'À encaisser', require_payment_method: 'Non finalisé', canceled: 'Annulé', refused: 'Refusé', expired: 'Expiré', disputed: 'Litige', refunded: 'Remboursé' };
        const payBadge = (s) => {
            const lbl = PAY_STATUS[s] || esc(s);
            const cls = s === 'captured' ? 'green' : (s === 'authorized' || s === 'to_capture') ? 'blue'
                : (s === 'require_payment_method') ? 'amber' : (s === 'refused' || s === 'disputed') ? 'red' : 'gray';
            return `<span class="badge ${cls}" title="Statut technique : ${esc(s)}">${lbl}</span>`;
        };

        // Payment rail (web vs mobile store) — the KPI dimension that separates web
        // revenue from Google Play / App Store mobile revenue.
        const railBadge = AdminPage.railBadge;

        // Merge every per-rail block (by_rail incl. trials, collected+refunded, conversions,
        // upcoming) into one bucket per provider — the data behind each rail card.
        const railMap = {};
        const railBucket = (k) => (railMap[k] || (railMap[k] = {
            provider: k, n: 0, mrr_cents: 0, unknown_n: 0, trialing_n: 0, mrr_trial_cents: 0,
            collected_cents: 0, collected_n: 0, refunded_cents: 0, conversions_7d: 0,
            trial_48h_n: 0, trial_48h_cents: 0, renewals_7d_n: 0, renewals_7d_cents: 0,
        }));
        (Array.isArray(f.by_rail) ? f.by_rail : []).forEach(r => {
            const b = railBucket(r.provider); b.n = Number(r.n) || 0; b.mrr_cents = Number(r.mrr_cents) || 0; b.unknown_n = Number(r.unknown_n) || 0;
            b.trialing_n = Number(r.trialing_n) || 0; b.mrr_trial_cents = Number(r.mrr_trial_cents) || 0;
        });
        (Array.isArray(f.collected_by_rail) ? f.collected_by_rail : []).forEach(r => {
            const b = railBucket(r.provider); b.collected_cents = Number(r.cents) || 0; b.collected_n = Number(r.n) || 0; b.refunded_cents = Number(r.refunded_cents) || 0;
        });
        (Array.isArray(f.conversions_by_rail) ? f.conversions_by_rail : []).forEach(r => { railBucket(r.provider).conversions_7d = Number(r.n) || 0; });
        (Array.isArray(f.upcoming_by_rail) ? f.upcoming_by_rail : []).forEach(r => {
            const b = railBucket(r.provider);
            b.trial_48h_n = Number(r.trial_48h_n) || 0; b.trial_48h_cents = Number(r.trial_48h_cents) || 0;
            b.renewals_7d_n = Number(r.renewals_7d_n) || 0; b.renewals_7d_cents = Number(r.renewals_7d_cents) || 0;
        });
        const railList = Object.values(railMap).sort((a, b) => (b.mrr_cents - a.mrr_cents) || (b.mrr_trial_cents - a.mrr_trial_cents) || (b.collected_cents - a.collected_cents));

        // Net estimé après commission — ESTIMATION (hors taxes) : ~1 % PSP Revolut ;
        // 15 % stores mobiles (palier Small Business < 1 M$/an). Ajuster ici si les taux changent.
        const RAIL_FEES = { revolut: 0.01, google_play: 0.15, apple_app_store: 0.15 };
        const totalMrr = railList.reduce((s, r) => s + r.mrr_cents, 0);
        const railCard = (r) => {
            const fee = RAIL_FEES[r.provider];
            const isStore = r.provider === 'google_play' || r.provider === 'apple_app_store';
            const cls = r.provider === 'revolut' ? 'rail-card--revolut' : isStore ? 'rail-card--store' : '';
            const share = totalMrr > 0 && r.mrr_cents > 0 ? Math.round(100 * r.mrr_cents / totalMrr) + ' % du MRR'
                : (r.trialing_n > 0 ? 'pipeline essais' : '—');
            const kv = (l, v2) => `<div class="kv-row"><span class="kv-l">${l}</span><span class="kv-v">${v2}</span></div>`;
            const feePct = fee ? Math.round(fee * 100) : 0;
            const net = fee && r.mrr_cents > 0
                ? `<div class="rail-net" title="Estimation hors taxes — commission ${isStore ? 'du store' : 'PSP'} ≈ ${feePct} %">≈ ${money(Math.round(r.mrr_cents * (1 - fee)))} net après commission (−${feePct} %)</div>` : '';
            return `<div class="rail-card ${cls}">
                <div class="rail-hd">${railBadge(r.provider)}<span class="rail-share">${share}</span></div>
                <div class="rail-mrr">${money(r.mrr_cents)}<span class="pacct" style="font-size:12px;font-weight:600"> MRR</span></div>
                ${net}
                ${kv('👤 Payants', n(r.n) + (r.unknown_n > 0 ? ` <span class="pacct" title="Abonnés sans montant connu">+${n(r.unknown_n)} ?</span>` : ''))}
                ${kv('⏳ Essais en cours', n(r.trialing_n) + (r.mrr_trial_cents > 0 ? ` <span class="pacct">· ${money(r.mrr_trial_cents)} potentiels</span>` : ''))}
                ${kv('💰 Encaissé 30 j', money(r.collected_cents) + (r.refunded_cents > 0 ? ` <span class="badge red" title="Remboursements sur 30 j">− ${money(r.refunded_cents)}</span>` : ''))}
                ${kv('📊 Conversions 7 j', n(r.conversions_7d))}
                ${kv('⏰ Essais à prélever &lt; 48 h', n(r.trial_48h_n) + (r.trial_48h_cents > 0 ? ` <span class="pacct">· ${money(r.trial_48h_cents)}</span>` : ''))}
                ${kv('🔁 Renouvellements &lt; 7 j', n(r.renewals_7d_n) + (r.renewals_7d_cents > 0 ? ` <span class="pacct">· ${money(r.renewals_7d_cents)}</span>` : ''))}
                <div class="ssub" style="margin-top:9px;font-size:11px">${r.provider === 'revolut' ? 'Prélèvements exécutés par le cron Norva (norva-revolut-billing).' : isStore ? 'Facturation gérée par le store — Norva reçoit les webhooks RevenueCat.' : 'Rail interne / manuel — hors facturation automatique.'}</div>
            </div>`;
        };
        const railCards = railList.map(railCard).join('');

        // ── Répartition par pays (payants + essais) — barres façon funnel, MRR en valeur.
        // Le bucket « Inconnu » ('??') reste TOUJOURS visible : c'est la jauge de
        // couverture de la capture pays (backfill partiel côté web par construction).
        const byCountry = Array.isArray(f.by_country) ? f.by_country : [];
        const totalCountryMrr = byCountry.reduce((s, r) => s + (Number(r.mrr_cents) || 0), 0);
        const countryBars = byCountry.length ? `<div class="hbars">${byCountry.map(r => {
            const unknown = r.country_code === '??';
            const v = Number(r.mrr_cents) || 0;
            const max = Math.max(1, ...byCountry.map(x => Number(x.mrr_cents) || 0));
            const pct = Math.max(2, Math.round(100 * v / max));
            const share = totalCountryMrr > 0 && v > 0 ? ` · ${Math.round(100 * v / totalCountryMrr)} %` : '';
            const extra = `${n(r.n)} payant(s)${Number(r.trialing_n) > 0 ? ` +${n(r.trialing_n)} essai(s)` : ''}`;
            return `<div class="hbar"><div class="hbar-l" title="${esc(unknown ? 'Pays non capturé pour ces clients' : extra)}">${unknown ? 'Inconnu' : AdminPage.flag(r.country_code)}</div>` +
                `<div class="hbar-track"><div class="hbar-fill ${unknown ? 'warn' : ''}" style="width:${pct}%"></div></div>` +
                `<div class="hbar-v" title="${esc(extra)}">${money(v)}<span class="pacct">${share}</span></div></div>`;
        }).join('')}</div>` : '<div class="ssub">La répartition apparaîtra avec les premiers abonnements (pays capturé au paiement).</div>';
        const byCR = Array.isArray(f.by_country_rail) ? f.by_country_rail : [];
        const countryRailRows = byCR.map(r => `<tr>
            <td>${r.country_code === '??' ? '<span class="ssub">Inconnu</span>' : AdminPage.flag(r.country_code)}</td>
            <td>${railBadge(r.provider)}</td>
            <td class="num">${n(r.n)}</td><td class="num">${money(r.mrr_cents)}</td>
        </tr>`).join('');

        const payRows = (Array.isArray(f.recent_payments) ? f.recent_payments : []).map(p => `<tr class="user-row" data-user-id="${esc(p.user_id)}" tabindex="0" aria-label="Voir la fiche de ${esc(p.email || p.user_id)}" title="Voir la fiche">
            <td>${esc(day(p.at))}</td><td>${esc(p.email || p.user_id)}</td>
            <td>${railBadge(p.provider)}</td>
            <td>${AdminPage.flag(p.country_code)}</td>
            <td>${KIND_LABELS[p.kind] || esc(p.kind)}</td><td>${payBadge(p.status)}</td>
            <td class="num">${money(p.amount)}${p.currency && String(p.currency).toLowerCase() !== 'usd' ? ` <span class="pacct">${esc(String(p.currency).toUpperCase())}</span>` : ''}</td>
        </tr>`).join('');

        // Revenue-risk signals (drives the risk-zone accent + header pill).
        const pastDue = Number(counts.past_due) || 0, cancelPending = Number(counts.cancel_pending) || 0, expired = Number(counts.expired) || 0;
        const anyRisk = pastDue > 0 || cancelPending > 0;
        // Total amount shown as a label note (a bare "4 199,60 $" would read as one number in fr-FR).
        const amtNote = (c) => ` <span class="pacct">· ${money(c)}</span>`;

        // Onglet TVA : indicateur ⚠ quand quelque chose requiert l'attention (pays
        // inconnus, ou seuil OSS franchi ≈). Le détail précis vit dans le hero du panneau.
        const vatTot = (vat && vat.totals) || {};
        const vatYs = (vat && vat.year_summary) || {};
        const vatAttention = Number(vatTot.unknown_n) > 0
            || Math.round((Number(vatYs.eu_cross_cents) || 0) * 0.92) >= 1000000
            || Math.round((Number(vatYs.eu_cross_prev_cents) || 0) * 0.92) >= 1000000;
        // Onglets Finance : la Vue d'ensemble MONTRE (lecture pure), les actions
        // vivent chacune dans leur onglet (même modèle que TVA). Chaque onglet est
        // deep-linkable : #admin/finance[/paiements|/analyse|/vat]. Les promotions
        // vivent désormais dans la page Marketing (#admin/marketing/promos).
        const FIN_TABS = { overview: 'fin-tab-overview', paiements: 'fin-tab-pay', analyse: 'fin-tab-analyse', vat: 'fin-tab-vat' };
        const finTab = FIN_TABS[this._financeTab] ? this._financeTab : 'overview';
        const finShow = t => (finTab === t ? '' : ' style="display:none"');

        el.innerHTML = `
            <div class="qv-row" id="fin-tabs" role="tablist" aria-label="Sections Finance">
                <button class="qv-chip ${finTab === 'overview' ? 'active' : ''}" data-ftab="overview" role="tab">💶 Vue d'ensemble</button>
                <button class="qv-chip ${finTab === 'paiements' ? 'active' : ''}" data-ftab="paiements" role="tab">🧾 Paiements</button>
                <button class="qv-chip ${finTab === 'analyse' ? 'active' : ''}" data-ftab="analyse" role="tab">📊 Analyse</button>
                <button class="qv-chip ${finTab === 'vat' ? 'active' : ''}" data-ftab="vat" role="tab">🇪🇺 TVA &amp; conformité${vatAttention ? ' <span style="color:#fbbf24">⚠</span>' : ''}</button>
            </div>
            <div id="fin-tab-overview"${finShow('overview')}>
            <!-- 1 ── Résumé financier : les 5 métriques dominantes, en tête ── -->
            <div class="kpi-group kpi-group--priority"><div class="kpi-gtitle">💶 Résumé financier</div><div class="admin-cards">
                ${card(money(f.mrr_cents), 'MRR', Number(f.mrr_cents) > 0 ? 'ok' : '', 'mrr_cents', '💲')}
                ${card(money(f.arr_cents), 'ARR', '', 'arr', '📈')}
                ${card(money(f.collected_30d_cents), 'Encaissé 30 j', Number(f.collected_30d_cents) > 0 ? 'ok' : '', 'collected_30d_cents', '💰')}
                ${card(n(f.conversions_7d), 'Conversions 7 j', '', 'conversions_7d', '📊')}
                ${card(money(f.mrr_trial_cents), 'MRR potentiel essais', 'muted', null, '⏳', 'Revenu mensuel projeté si tous les essais en cours se convertissent — non encore encaissé.')}
            </div></div>
            <!-- 2 ── Vue par rail : d'où vient (et viendra) le revenu — web Revolut vs stores ── -->
            <div class="kpi-group"><div class="kpi-gtitle">💳 Revenu par rail — 🌐 web (Revolut) vs 📱 stores mobiles</div>
                ${railCards ? `<div class="rail-cards">${railCards}</div>` : '<div class="ssub">Aucun abonnement ni essai — les cartes Revolut / Google Play / App Store apparaîtront ici avec les premiers clients.</div>'}
            </div>
            <!-- 2bis ── Géographie du revenu (la conformité TVA vit dans son onglet) ── -->
            <div class="admin-block"><h2>🌍 Répartition par pays</h2>
                <div class="ssub" style="margin-bottom:10px">Pays du storefront (Play) ou d'émission de la carte (Revolut, proxy ~95 %).</div>
                ${countryBars}
                ${countryRailRows ? `<div class="kpi-gtitle" style="margin:14px 0 8px">Par pays &amp; rail</div><div class="scroll"><table><thead><tr><th>Pays</th><th>Rail</th><th class="num">Abonnés</th><th class="num">MRR</th></tr></thead><tbody>${countryRailRows}</tbody></table></div>` : ''}
            </div>
            <!-- 3 ── Risque revenu : tout ce qui menace le revenu, regroupé ── -->
            <div class="kpi-group kpi-group--risk ${anyRisk ? 'has-risk' : ''}"><div class="kpi-gtitle">⚠️ Risque revenu — cliquer un statut pour ouvrir la liste</div><div class="admin-cards">
                ${statusCard(n(pastDue), 'Échecs paiement', 'past_due', pastDue > 0 ? 'alert' : 'ok', '💳', stateChip(pastDue > 0, true))}
                ${statusCard(n(cancelPending), 'Annulations prévues', 'cancel_pending', cancelPending > 0 ? 'alert' : 'ok', '📅', stateChip(cancelPending > 0, false))}
                ${statusCard(n(expired), 'Expirés', 'expired', '', '⛔')}
                ${card(n(up.trial_charges_48h_n), 'Essais à prélever < 48 h' + amtNote(up.trial_charges_48h_cents), '', null, '⏰')}
                ${card(n(up.renewals_7d_n), 'Renouvellements < 7 j' + amtNote(up.renewals_7d_cents), '', null, '🔁')}
                ${Number(f.discounts_pending) > 0 ? card(n(f.discounts_pending), 'Remises 50% en attente', '', null, '🎟️') : ''}
            </div></div>
            <!-- 4 ── État des abonnés (le funnel/rétention vit dans l'onglet Analyse) ── -->
            <div class="fin-cols">
                <div class="kpi-group"><div class="kpi-gtitle">👥 Abonnés — cliquer pour ouvrir la liste</div><div class="admin-cards fin-mini">
                    ${statusCard(n(counts.trialing), 'En essai', 'trialing', 'ok', '⏳')}
                    ${statusCard(n(counts.active), 'Actifs payants', 'active', 'ok', '👤')}
                    ${Number(f.mrr_unknown_n) > 0 ? card(n(f.mrr_unknown_n), 'Sans montant connu (manuel/store)', 'muted', null, '🗄️', 'Abonnés actifs dont le montant n\'est pas connu côté Norva (paiement manuel ou store mobile).') : ''}
                </div></div>
                <div class="admin-block"><h2>📊 MRR par plan, période & rail</h2><div class="scroll">
                    ${planRows ? `<table><thead><tr><th>Plan</th><th>Période</th><th>Rail</th><th class="num">Abonnés</th><th class="num">MRR</th></tr></thead><tbody>${planRows}</tbody></table>` : '<div class="ssub">Aucun abonnement payant.</div>'}
                </div></div>
            </div>
            </div>
            <!-- 🧾 Onglet Paiements : log opérationnel + export -->
            <div id="fin-tab-pay"${finShow('paiements')}>
                <div class="admin-block"><h2>🧾 Derniers paiements (50) <button id="fin-csv" class="mini-btn" title="Télécharger les 50 derniers paiements au format CSV">⬇ Exporter CSV</button></h2><div class="scroll">
                    ${payRows ? `<table><thead><tr><th>Date</th><th>Client</th><th>Rail</th><th>Pays</th><th>Type</th><th>Statut</th><th class="num">Montant</th></tr></thead><tbody>${payRows}</tbody></table>` : '<div class="ssub">Aucun paiement.</div>'}
                </div></div>
            </div>
            <!-- 📊 Onglet Analyse : funnel + rétention -->
            <div id="fin-tab-analyse"${finShow('analyse')}>
                ${paywallFunnelHtml}
                <div class="fin-cols">
                    <div class="admin-block"><h2>🔀 Funnel historique (30 j)</h2>
                        ${funnelData.length ? hbars(funnelData, '') : '<div class="ssub">Aucune donnée funnel sur 30 j.</div>'}
                    </div>
                    <div class="admin-block"><h2>🛑 Annulations & rétention</h2>
                        <div class="admin-cards fin-mini" style="margin-bottom:16px">
                            ${card(n(cancelsTotal), 'Annulations (total)', '', null, '🛑')}
                            ${card(n(savesTotal), 'Clients sauvés', savesTotal > 0 ? 'ok' : '', null, '💚', 'Clients ayant renoncé à annuler après une contre-offre.')}
                            ${saveRate != null ? card(saveRate + ' %', 'Taux de sauvetage', saveRate >= 20 ? 'ok' : '', null, '🎯') : ''}
                        </div>
                        ${reasonData.length ? `<div class="kpi-gtitle" style="margin:0 0 8px">Raisons d'annulation</div>${hbars(reasonData, 'warn')}` : '<div class="ssub">Aucune annulation enregistrée — les raisons s\'accumuleront ici.</div>'}
                    </div>
                </div>
            </div>
            <!-- 🇪🇺 Onglet TVA & conformité : le cockpit a sa propre page -->
            <div id="fin-tab-vat"${finShow('vat')}>
                <div class="admin-block" id="fin-vat"><h2>🇪🇺 TVA — préparation OSS</h2><div id="fin-vat-body"><div class="ssub">Chargement…</div></div></div>
            </div>`;

        // Bascule d'onglet : tous les conteneurs sont rendus, on ne fait que montrer/
        // cacher (l'état interne — trimestre TVA choisi, dépliant promo ouvert —
        // survit à la bascule). La sélection est reflétée dans l'URL
        // (#admin/finance[/promos|/paiements|/analyse|/vat]) → F5 / favori / lien
        // partagé restaurent l'onglet exact (this._route reste 'finance' pour les gardes).
        el.querySelectorAll('#fin-tabs .qv-chip').forEach(chip => chip.addEventListener('click', () => {
            const tab = FIN_TABS[chip.dataset.ftab] ? chip.dataset.ftab : 'overview';
            this._financeTab = tab;
            el.querySelectorAll('#fin-tabs .qv-chip').forEach(c => c.classList.toggle('active', c === chip));
            Object.entries(FIN_TABS).forEach(([t, id]) => {
                const node = document.getElementById(id);
                if (node) node.style.display = t === tab ? '' : 'none';
            });
            try { if (String(location.hash || '').startsWith('#admin')) history.replaceState(history.state, '', '#admin/finance' + (tab === 'overview' ? '' : '/' + tab)); } catch (_) { /* non-navigable */ }
        }));

        // Header status line: MRR · échecs · conversions + a "live" freshness badge.
        const tx = document.querySelector('#page-admin .crm-head-tx');
        if (tx) {
            let meta = tx.querySelector('.crm-head-meta');
            if (!meta) { meta = document.createElement('div'); meta.className = 'crm-head-meta'; tx.appendChild(meta); }
            meta.innerHTML =
                `<span class="crm-hpill"><b>${money(f.mrr_cents)}</b> MRR</span>` +
                `<span class="crm-hpill ${pastDue > 0 ? 'bad' : ''}"><b>${n(pastDue)}</b> paiement(s) en échec</span>` +
                `<span class="crm-hpill"><b>${n(f.conversions_7d)}</b> conversions 7 j</span>` +
                `<span class="crm-hlive"><span class="live-dot"></span>Données live${f.refreshed_at ? ' · maj ' + AdminPage.timeAgo(f.refreshed_at) : ''}</span>`;
        }

        // Status cards → Clients pre-filtered; CSV of the recent payments table.
        el.querySelectorAll('.fin-status').forEach(c => c.addEventListener('click', () => {
            // Opening a status view is a fresh filter: clear any leftover search/tag/country so
            // the count shown on the card matches the list the user lands on.
            this._users.billing = c.dataset.billing || '';
            this._users.search = '';
            this._users.tagId = '';
            this._users.country = '';
            this._users.page = 0;
            this._navigate('clients');
        }));
        const csv = document.getElementById('fin-csv');
        if (csv) csv.addEventListener('click', () => {
            const rows = Array.isArray(f.recent_payments) ? f.recent_payments : [];
            // CSV export: quote + neutralize spreadsheet formula injection (a leading =/+/-/@ makes
            // Excel/Sheets evaluate the cell). Prefix such values with a single quote.
            const q = (x) => {
                let s = String(x == null ? '' : x);
                if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
                return `"${s.replace(/"/g, '""')}"`;
            };
            const lines = [['date', 'email', 'rail', 'pays', 'type', 'statut', 'montant_cents', 'devise', 'pi_id', 'user_id'].map(q).join(',')]
                .concat(rows.map(p => [p.at, p.email, p.provider, p.country_code || '', p.kind, p.status, p.amount, p.currency, p.pi_id, p.user_id].map(q).join(',')));
            const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'norva-paiements.csv';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        });

        this._renderVatPanel(vat);
    }

    // ── Panneau TVA / OSS (page Finance) — cockpit de conformité ──
    // Périmètre : ventes web DIRECTES (rail Revolut) uniquement — sur les stores,
    // Google/Apple sont « fournisseurs présumés » (art. 9 bis, règl. UE 282/2011).
    // Niveau 3 : hero de statut, échéancier, assistant de dépôt champ-par-champ,
    // taux BCE FIGÉ par trimestre côté serveur (oss_fx_rates via admin_vat_fx_set) ;
    // tant qu'il n'est pas figé, les conversions EUR sont INDICATIVES et signalées.
    _renderVatPanel(vat) {
        const el = document.getElementById('fin-vat-body');
        if (!el) return;
        if (!vat) { el.innerHTML = '<div class="ssub">Rapport TVA indisponible — la fonction admin_vat_report n\'est pas encore déployée.</div>'; return; }
        const n = AdminPage.n, esc = AdminPage.esc, money = AdminPage.money;
        const EUR_PER_USD = 0.92; // fallback INDICATIF quand le taux BCE du trimestre n'est pas figé
        // fx serveur : figé à la clôture du trimestre (art. 369h) → chiffres DÉFINITIFS.
        const fx = vat.fx || null;
        const fxFixed = !!(fx && Number(fx.usd_eur_rate) > 0);
        const FX = fxFixed ? Number(fx.usd_eur_rate) : EUR_PER_USD;
        const eur = (usdCents) => (Math.round((Number(usdCents) || 0) * FX) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
        const ys = vat.year_summary || {};
        const THRESH_EUR_CENTS = 1000000; // 10 000 € — seuil UE des ventes B2C transfrontalières (année en cours ET précédente)
        const crossEurCents = Math.round((Number(ys.eu_cross_cents) || 0) * FX);
        const pctT = Math.min(100, Math.round(100 * crossEurCents / THRESH_EUR_CENTS));
        const nearThresh = pctT >= 80;
        // Franchise en base FR 2026 : 37 500 € (majoré 41 250 €). Base = opérations
        // localisées en France (art. 293 D CGI) : ventes web FR + ventes web autres-UE
        // tant que le seuil 10 k€ n'est pas franchi. Google Play EXCLU (B2B Irlande).
        // Détail complet : docs/TVA-OSS.md.
        const FR_THRESH_EUR_CENTS = 3750000, FR_THRESH_MAJ_EUR_CENTS = 4125000;
        const frBaseEurCents = Math.round(((Number(ys.fr_cents) || 0) + (Number(ys.eu_cross_cents) || 0)) * FX);
        const pctF = Math.min(100, Math.round(100 * frBaseEurCents / FR_THRESH_EUR_CENTS));
        const nearFr = frBaseEurCents >= 3500000; // alerte préparatoire ~35 000 €
        const overFrMaj = frBaseEurCents >= FR_THRESH_MAJ_EUR_CENTS;

        // Sélecteur de trimestre : 8 derniers trimestres, plus récent en premier.
        const nowD = new Date();
        let qy = nowD.getUTCFullYear(), qq = Math.floor(nowD.getUTCMonth() / 3) + 1;
        const qOpts = [];
        for (let i = 0; i < 8; i++) { qOpts.push([qy, qq]); qq -= 1; if (qq === 0) { qq = 4; qy -= 1; } }
        const qSel = qOpts.map(([y2, q2]) =>
            `<option value="${y2}-${q2}"${y2 === vat.year && q2 === vat.quarter ? ' selected' : ''}>T${q2} ${y2}</option>`).join('');

        const rows = Array.isArray(vat.rows) ? vat.rows : [];
        const corrections = Array.isArray(vat.corrections) ? vat.corrections : [];
        const tot = vat.totals || {};
        // Taux de TVA standard 2026 des 27 États UE (source TEDB — aucun changement de taux
        // standard en 2026 ; un abonnement streaming prend le taux standard partout). Grèce
        // = 'GR' côté carte/ledger (le portail OSS l'affiche 'EL'). Phase 3 : déplacer cette
        // table + le taux BCE réel côté serveur (admin_vat_report).
        const EU_VAT_RATES = { AT:20, BE:21, BG:20, HR:25, CY:19, CZ:21, DK:25, EE:24, FI:25.5, FR:20, DE:19, GR:24, HU:27, IE:23, IT:22, LV:21, LT:21, LU:17, MT:18, NL:21, PL:23, PT:23, RO:21, SK:23, SI:22, ES:21, SE:25 };
        const COUNTRY_FR = { AT:'Autriche', BE:'Belgique', BG:'Bulgarie', HR:'Croatie', CY:'Chypre', CZ:'Tchéquie', DK:'Danemark', EE:'Estonie', FI:'Finlande', DE:'Allemagne', GR:'Grèce (EL sur le portail)', HU:'Hongrie', IE:'Irlande', IT:'Italie', LV:'Lettonie', LT:'Lituanie', LU:'Luxembourg', MT:'Malte', NL:'Pays-Bas', PL:'Pologne', PT:'Portugal', RO:'Roumanie', SK:'Slovaquie', SI:'Slovénie', ES:'Espagne', SE:'Suède' };
        const eurCents = (usdCents) => Math.round((Number(usdCents) || 0) * FX);
        const eurFmt = (c) => (Number(c) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
        // Chaîne de calcul : net USD → base EUR → TVA due (taux du pays), UE hors France
        // uniquement. Les champs SERVEUR (rate_pct/base_eur_cents/vat_due_eur_cents,
        // présents quand le fx est figé) priment sur le calcul local.
        let ossBaseEur = 0, ossVatEur = 0;
        const rowsCalc = rows.map(r => {
            const cc = r.country_code, isEu = !!r.is_eu, isFr = cc === 'FR', unknown = cc === '??';
            const baseEur = (fxFixed && r.base_eur_cents != null) ? Number(r.base_eur_cents) : eurCents(r.net_cents);
            const rate = (r.rate_pct != null) ? Number(r.rate_pct) : ((isEu && !isFr) ? (EU_VAT_RATES[cc] ?? null) : null);
            const vatDue = (fxFixed && r.vat_due_eur_cents != null) ? Number(r.vat_due_eur_cents)
                : ((rate != null && isEu && !isFr) ? Math.round(baseEur * rate / 100) : 0);
            if (isEu && !isFr) { ossBaseEur += baseEur; ossVatEur += vatDue; }
            return { r, cc, isEu, isFr, unknown, baseEur, rate, vatDue };
        });
        const rowsHtml = rowsCalc.map(x => `<tr class="vat-cc-row" data-cc="${esc(x.cc)}" style="cursor:pointer" title="Voir les transactions de ce pays (registre)">
            <td>${x.unknown ? '<span class="ssub">Inconnu</span>' : AdminPage.flag(x.cc)}</td>
            <td>${x.isEu ? (x.isFr ? '<span class="ssub">France · franchise</span>' : '<span class="badge blue">UE · OSS</span>') : (x.unknown ? '<span class="ssub">—</span>' : '<span class="badge gray">hors UE</span>')}</td>
            <td class="num" title="${n(x.r.n_tx)} tx · brut ${money(x.r.gross_cents)}${Number(x.r.refunded_cents) > 0 ? ' · remb. −' + money(x.r.refunded_cents) : ''}">${money(x.r.net_cents)}</td>
            <td class="num">${eurFmt(x.baseEur)}</td>
            <td class="num">${x.rate != null ? x.rate.toLocaleString('fr-FR') + ' %' : '<span class="ssub">—</span>'}</td>
            <td class="num">${x.rate != null ? '<b>' + eurFmt(x.vatDue) + '</b>' : (x.isFr ? '<span class="ssub">franchise</span>' : x.unknown ? '<span class="ssub">?</span>' : '<span class="ssub">hors OSS</span>')}</td>
        </tr>`).join('');
        const vatFoot = `<tfoot><tr><td colspan="3">Total OSS — UE hors France</td><td class="num">${eurFmt(ossBaseEur)}</td><td class="num"></td><td class="num" style="color:#34d399"><b>${eurFmt(ossVatEur)}</b></td></tr></tfoot>`;

        // ── Statut + échéancier ────────────────────────────────────────────────
        const unknownN = Number(tot.unknown_n) || 0;
        const ossApplies = crossEurCents >= THRESH_EUR_CENTS
            || Math.round((Number(ys.eu_cross_prev_cents) || 0) * FX) >= THRESH_EUR_CENTS;
        // Prochaine échéance OSS : la déclaration du trimestre échu est due le dernier
        // jour du mois suivant (30/04, 31/07, 31/10, 31/01) — sans report week-end/férié.
        const tNow = new Date();
        const dlCands = [
            { d: new Date(Date.UTC(tNow.getUTCFullYear(), 0, 31)), q: 4, y: tNow.getUTCFullYear() - 1 },
            { d: new Date(Date.UTC(tNow.getUTCFullYear(), 3, 30)), q: 1, y: tNow.getUTCFullYear() },
            { d: new Date(Date.UTC(tNow.getUTCFullYear(), 6, 31)), q: 2, y: tNow.getUTCFullYear() },
            { d: new Date(Date.UTC(tNow.getUTCFullYear(), 9, 31)), q: 3, y: tNow.getUTCFullYear() },
            { d: new Date(Date.UTC(tNow.getUTCFullYear() + 1, 0, 31)), q: 4, y: tNow.getUTCFullYear() },
        ];
        const nextDl = dlCands.find(c => c.d > tNow);
        const dlDays = nextDl ? Math.ceil((nextDl.d - tNow) / 86400000) : null;
        const fmtD = (d) => d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
        // ── Profil d'entreprise + état des démarches (localStorage — mono-admin ; table
        // serveur au Lot B). Le profil pilote les modèles de courriers et les jauges.
        const PROFILE_FORMS = {
            micro: { label: 'Micro-entreprise (EI)', societe: false, micro: true },
            ei_reel: { label: 'EI au réel', societe: false, micro: false },
            eurl: { label: 'EURL', societe: true, sig: 'Le Gérant', micro: false },
            sasu: { label: 'SASU', societe: true, sig: 'Le Président', micro: false },
            sas_sarl: { label: 'SAS / SARL', societe: true, sig: 'Le représentant légal', micro: false },
        };
        let profile = { form: 'micro', name: '', siren: '', vat_number: '' };
        try { profile = { ...profile, ...(JSON.parse(localStorage.getItem('norva-vat-profile') || '{}')) }; } catch (_) { /* défaut */ }
        const pf = PROFILE_FORMS[profile.form] || PROFILE_FORMS.micro;
        let vatCk = {};
        try { vatCk = JSON.parse(localStorage.getItem('norva-vat-checklist') || '{}'); } catch (_) { /* défaut */ }

        // ── Action requise : UNE seule priorité à la fois (bloquant > légal > préparation). ──
        const statusBox = (color, ic, t, s, cta) => `<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;background:${color}14;border:1px solid ${color}55;border-radius:10px;padding:12px 14px;margin:10px 0 14px">
            <span style="font-size:22px;line-height:1">${ic}</span><div style="flex:1;min-width:230px"><div style="font-weight:700">${t}</div><div class="ssub" style="margin-top:2px">${s}</div></div>${cta || ''}</div>`;
        const ctaBtn = (id, label) => `<button id="${id}" class="mini-btn" style="font-weight:700">${label}</button>`;
        let heroHtml;
        if (unknownN > 0) {
            heroHtml = statusBox('#f87171', '⛔', 'Action requise : localiser les transactions sans pays',
                `${n(unknownN)} transaction(s) du trimestre sans pays (${money(tot.unknown_gross_cents)}) — la réglementation exige la localisation du client avant tout dépôt.`,
                ctaBtn('vat-cta-unknown', 'Voir les transactions'));
        } else if (ossApplies && !vatCk.oss) {
            heroHtml = statusBox('#fbbf24', '🇪🇺', 'Action requise : inscription au guichet OSS',
                'Le seuil de 10 000 € de ventes UE est franchi — l\'inscription conditionne le dépôt des déclarations (rétroactivité possible si demandée avant le 10 du mois suivant la première vente concernée).',
                ctaBtn('vat-cta-oss', 'Ouvrir la démarche'));
        } else if (ossApplies) {
            heroHtml = statusBox('#fbbf24', '🧾', `Déclaration OSS à préparer — échéance ${nextDl ? fmtD(nextDl.d) : '—'}${dlDays != null ? ` (dans ${dlDays} j)` : ''}`,
                `Montant à reverser (trimestre affiché) : <b>${eurFmt(ossVatEur)}</b>${fxFixed ? '' : ' — montant indicatif tant que le taux BCE n\'est pas figé'}.`,
                ctaBtn('vat-cta-declare', 'Ouvrir l\'assistant'));
        } else if (!vatCk.intracom) {
            heroHtml = statusBox('#7c93ff', '✉️', 'Une démarche à effectuer : numéro de TVA intracommunautaire',
                'Gratuit, ~10 minutes, sans effet sur la franchise en base. Requis pour les reversements Google Play (prestation B2B intra-UE) et préalable à la DES.',
                ctaBtn('vat-cta-intracom', 'Ouvrir la démarche'));
        } else if (nearThresh) {
            heroHtml = statusBox('#fbbf24', '📈', `Seuil UE en approche — ${pctT} % des 10 000 €`,
                'À anticiper : inscription au guichet OSS, ou régime PME UE (n° EX) pour maintenir l\'exonération. Les deux démarches sont prêtes ci-dessous.');
        } else {
            heroHtml = statusBox('#34d399', '✅', 'Aucune action requise',
                `Franchise en base active · OSS non applicable · surveillance automatique des seuils et échéances.${pf.micro ? ` Plafond micro 83 600 € également suivi.` : ''}`);
        }

        // ── Parcours de conformité (6 étapes de vie ; l'étape courante = 1ʳᵉ non acquise). ──
        const journeySteps = [
            { l: 'Localisation des ventes', done: true, w: 'capture active sur les 2 canaux' },
            { l: 'Mise en conformité', done: !!(vatCk.intracom && vatCk.uk), w: (vatCk.intracom && vatCk.uk) ? 'démarches effectuées' : 'démarches en cours' },
            { l: 'Premières ventes UE', done: Number(ys.eu_cross_cents) > 0, w: Number(ys.eu_cross_cents) > 0 ? 'en cours' : 'surveillance automatique' },
            { l: 'Seuil 10 000 €', done: ossApplies, w: ossApplies ? 'franchi' : 'alerte anticipée à 80 %' },
            { l: 'Guichet OSS', done: !!vatCk.oss, w: vatCk.oss ? 'inscrit' : 'guide prêt le moment venu' },
            { l: 'Déclarations trimestrielles', done: false, w: '30/04 · 31/07 · 31/10 · 31/01' },
        ];
        const nowIdx = journeySteps.findIndex(s => !s.done);
        const journeyHtml = `<div class="kpi-gtitle" style="margin:0 0 8px">Parcours de conformité</div>
            <div style="display:flex;gap:0;overflow-x:auto;margin-bottom:14px">${journeySteps.map((s, i) => `
                <div style="flex:1;min-width:104px;position:relative;text-align:center;padding-top:4px">
                    <div style="position:absolute;top:16px;left:${i === 0 ? '50%' : '0'};right:${i === journeySteps.length - 1 ? '50%' : '0'};height:2px;background:#2a2a38"></div>
                    <span style="position:relative;z-index:1;width:26px;height:26px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;${s.done ? 'background:rgba(52,211,153,.15);border:2px solid #34d399;color:#34d399' : i === nowIdx ? 'background:#7c93ff;border:2px solid #7c93ff;color:#0e0e13;box-shadow:0 0 0 4px rgba(124,147,255,.18)' : 'background:#181820;border:2px solid #2a2a38;color:#6b7280'}">${s.done ? '✓' : i + 1}</span>
                    <div style="font-size:11px;margin-top:6px;${i === nowIdx ? 'color:#f2f3f7;font-weight:700' : 'color:#9aa3b2'}">${s.l}</div>
                    <div style="font-size:10px;color:#6b7280;margin-top:1px">${s.w}</div>
                </div>`).join('')}</div>`;
        // ── Barre de profil (forme juridique + raison sociale/SIREN) ──────────────
        const inp = 'background:#0e0e13;border:1px solid #2a2a38;color:#f2f3f7;border-radius:8px;padding:7px 11px;font-size:12.5px';
        const profileBar = `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#181820;border:1px solid #2a2a38;border-radius:11px;padding:12px 14px;margin-bottom:8px">
            <span style="font-size:18px">🏢</span>
            <div style="flex:1;min-width:160px"><div style="font-weight:650;font-size:13px">Profil de l'entreprise</div><div class="ssub" style="font-size:12px">Adapte les courriers, les seuils et le parcours.</div></div>
            <input id="vat-prof-name" placeholder="Raison sociale" value="${esc(profile.name || '')}" style="${inp};width:140px"/>
            <input id="vat-prof-siren" placeholder="SIREN" value="${esc(profile.siren || '')}" style="${inp};width:100px"/>
            <input id="vat-prof-vat" placeholder="N° TVA intracom" value="${esc(profile.vat_number || '')}" title="Ex. FR12345678901 — renseigné une fois reçu ; sert à composer la référence de virement OSS" style="${inp};width:130px"/>
            <select id="vat-prof-form" style="${inp}">${Object.entries(PROFILE_FORMS).map(([k, vv]) => `<option value="${k}"${profile.form === k ? ' selected' : ''}>${esc(vv.label)}</option>`).join('')}</select>
        </div>`;

        // ── Démarches guidées (courriers pré-rédigés par statut, liens profonds) ───
        const openSelf = pf.micro ? 'Micro-entrepreneur' : 'Entrepreneur individuel';
        const intracomLetter = pf.societe
            ? `Bonjour,\n\nNotre société ${profile.name || '[Raison sociale]'}, ${pf.label} immatriculée sous le SIREN ${profile.siren || '[SIREN]'}, bénéficie de la franchise en base de TVA (art. 293 B du CGI). Elle fournit des prestations de services électroniques à un preneur assujetti établi dans l'Union européenne (Google Ireland — reversements de la plateforme Google Play).\n\nÀ ce titre, nous vous demandons l'attribution d'un numéro de TVA intracommunautaire, conformément à l'article 286 ter du CGI, sans remise en cause de la franchise en base.\n\nNous vous en remercions par avance.\n\n${pf.sig}`
            : `Bonjour,\n\n${openSelf} sous franchise en base de TVA (art. 293 B du CGI), je fournis des prestations de services électroniques à un preneur assujetti établi dans l'Union européenne (Google Ireland — reversements de la plateforme Google Play).\n\nÀ ce titre, je vous demande l'attribution d'un numéro de TVA intracommunautaire, conformément à l'article 286 ter du CGI, sans remise en cause de la franchise en base.\n\nJe vous en remercie par avance.`;
        const letters = { intracom: intracomLetter };
        const link = (url, label) => `<a href="${url}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;background:rgba(124,147,255,.13);border:1px solid rgba(124,147,255,.4);color:#a9bcff;border-radius:8px;padding:6px 12px;font-size:12.5px;font-weight:650;text-decoration:none">↗ ${label}</a>`;
        const gstep = (num, html) => `<div style="display:flex;gap:11px;margin:11px 0;align-items:flex-start"><span style="flex:none;width:23px;height:23px;border-radius:50%;background:#1e1e2a;border:1px solid #2a2a38;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#a9bcff">${num}</span><div style="padding-top:1px">${html}</div></div>`;
        const letterBox = (key) => `<div style="background:#0e0e13;border:1px dashed #2a2a38;border-radius:9px;padding:12px 12px 12px;margin-top:8px;position:relative;white-space:pre-wrap;font-size:12.5px;color:#9aa3b2;line-height:1.55"><button class="vat-letter mini-btn" data-letter="${key}" style="position:absolute;top:8px;right:8px">📋 Copier</button>${esc(letters[key])}</div>`;
        const doneBtn = (id, label) => `<button class="vat-done mini-btn" data-dem="${id}"${vatCk[id] ? ' style="background:#34d399;color:#0e0e13;border-color:#34d399"' : ''}>${vatCk[id] ? '✓ Effectué' : (label || '✓ Marquer comme effectué')}</button>`;
        const demarche = (id, ic, title, meta, locked, body) => `<details class="vat-dem" id="dem-${id}" style="border:1px solid #2a2a38;border-radius:11px;margin-top:10px;overflow:hidden;background:#181820">
            <summary style="display:flex;align-items:center;gap:12px;padding:13px 15px;cursor:pointer;font-weight:650;font-size:14px">
                <span style="width:28px;height:28px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;background:rgba(124,147,255,.14);font-size:15px">${ic}</span>
                <span>${title}</span><span class="ssub" style="font-size:12px;font-weight:500">${meta}</span>
                ${vatCk[id] ? '<span class="badge green" style="margin-left:auto">✓ Effectué</span>' : (locked ? '<span class="badge gray" style="margin-left:auto">🔒</span>' : '')}
            </summary>
            <div style="padding:2px 15px 15px;font-size:13.5px;color:#9aa3b2">${locked ? `<div class="ssub">${locked}</div>` : body}</div></details>`;
        const demarchesHtml = `<div class="kpi-gtitle" style="margin:16px 0 6px">Démarches</div>
            ${demarche('intracom', '✉️', 'Numéro de TVA intracommunautaire', '~10 min · gratuit · sans effet sur la franchise', null,
                gstep(1, `Connectez-vous à l'espace professionnel : ${link('https://cfspro-idp.impots.gouv.fr', 'impots.gouv.fr')}`)
                + gstep(2, `Rubrique <b>Messagerie sécurisée</b> → <b>Écrire</b> → thème « TVA » → « Demande de numéro de TVA intracommunautaire ».`)
                + gstep(3, `Courrier pré-rédigé pour votre statut (${esc(pf.label)}) — bouton copier :${letterBox('intracom')}`)
                + gstep(4, `Le numéro (FR + 11 caractères) est communiqué sous 1 à 2 semaines via la messagerie.`)
                + gstep(5, `Une fois reçu : ${doneBtn('intracom')} — la DES se débloquera.`))}
            ${demarche('des', '📮', 'Déclaration Européenne de Services (DES)', 'mensuelle · versements Google',
                vatCk.intracom ? null : 'Se débloque une fois le numéro de TVA intracommunautaire reçu (démarche ci-dessus), et dès le premier versement Google Play.',
                gstep(1, `Portail douane : ${link('https://www.douane.gouv.fr/service-en-ligne/declaration-europeenne-de-services-des', 'douane.gouv.fr / DES')}`)
                + gstep(2, `Une ligne par mois de versement — le montant sera pré-calculé ici depuis les relevés Play.`)
                + gstep(3, `Échéance : 10ᵉ jour ouvrable du mois suivant (750 € par déclaration manquante). ${doneBtn('des', '✓ DES en place')}`))}
            ${demarche('uk', '🇬🇧', 'Position Royaume-Uni', 'décision', null,
                `<div class="ssub">Au Royaume-Uni, la TVA (20 %) est due dès la première vente à un consommateur — aucun seuil pour un vendeur non établi. Deux options :</div>`
                + gstep('A', `Ne pas vendre au Royaume-Uni : blocage des clients britanniques au paiement (activable dans le checkout).`)
                + gstep('B', `S'immatriculer auprès de ${link('https://www.gov.uk/guidance/the-vat-rules-if-you-supply-digital-services-to-private-consumers', 'HMRC')} et déclarer la TVA UK.`)
                + `<div style="margin-top:10px">${doneBtn('uk', '✓ Position arrêtée')}</div>`)}
            ${demarche('oss', '🇪🇺', 'Inscription au guichet OSS', ossApplies ? 'action requise' : 'à l\'approche du seuil',
                ossApplies ? null : 'Se déverrouille à l\'approche des 10 000 € de ventes UE — inutile tant que vous êtes sous le seuil.',
                (() => {
                    // Comparatif OSS vs régime PME UE, avec les chiffres RÉELS : les prix Norva
                    // sont TTC de fait ($4.99 affiché) → sous OSS la TVA sort de la marge
                    // (part de TVA d'un prix TTC = t/(100+t)). Sous EX : 0 € jusqu'à 100 k€ UE.
                    const euYearEur = Math.round(Math.max(Number(ys.eu_cross_cents) || 0, Number(ys.eu_cross_prev_cents) || 0) * FX);
                    const euR = rowsCalc.filter(x => x.isEu && !x.isFr && x.rate != null && x.baseEur > 0);
                    const wRate = euR.length ? euR.reduce((s2, x) => s2 + x.rate * x.baseEur, 0) / euR.reduce((s2, x) => s2 + x.baseEur, 0) : 21;
                    const ossCost = Math.round(euYearEur * wRate / (100 + wRate));
                    const compare = `<div style="border:1px solid rgba(124,147,255,.35);background:rgba(124,147,255,.07);border-radius:9px;padding:11px 13px;margin:10px 0">
                        <b>⚖️ Comparatif pour votre cas</b> (prix inchangés — TTC de fait) :<br/>
                        ${euYearEur > 0
                            ? `• <b>OSS</b> : ≈ −${eurFmt(ossCost)}/an de marge sur ${eurFmt(euYearEur)} de ventes UE (taux moyen de votre mix : ${wRate.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %).<br/>`
                            : `• <b>OSS</b> : la TVA de chaque pays sortirait de votre marge (~17 à 27 % des ventes UE, prix TTC inchangés).<br/>`}
                        • <b>Régime PME UE (n° EX)</b> : 0 € de TVA jusqu'à 100 000 € de CA UE — un état trimestriel des CA en contrepartie.<br/>
                        <span class="ssub">Décision produit associée : absorber la TVA ou augmenter les prix UE. À arbitrer avec l'expert-comptable (TVA-OSS.md §2).</span></div>`;
                    return compare
                        + gstep(1, `${link('https://cfspro-idp.impots.gouv.fr', 'impots.gouv.fr')} → Mes services → Gérer mon guichet unique de TVA UE → « Je choisis le régime UE ».`)
                        + gstep(2, `Alternative : le <b>régime PME UE</b> (n° EX) — demande via le même espace professionnel ; exclusion immédiate au-delà de 100 k€ UE (notification sous 15 jours).`)
                        + gstep(3, `${doneBtn('oss', '✓ Inscrit à l\'OSS')}`);
                })())}
            ${demarche('switch', '🔄', 'Changement de forme juridique', 'guide de transition', null,
                `<div class="ssub">Un changement de statut crée une nouvelle personne morale (nouveau SIREN) : il faut refaire le numéro intracommunautaire, ré-inscrire l'OSS, basculer la DES sur le nouveau SIREN, et mettre à jour Revolut Merchant et Google Play Console. La franchise en base reste accessible en société (mêmes seuils — elle dépend du chiffre d'affaires, pas du statut). Modifiez alors le profil ci-dessus : jauges, courriers et échéances s'adaptent automatiquement.</div>`)}`;

        // Provision + prévision T+1 + ETA (RPC admin_vat_forecast — trimestre-indépendant).
        const fc = this._vatForecast || null;
        const provCents = Number(fc && fc.provision_eur_cents) || 0;
        const fcVat = Number(fc && fc.forecast_vat_eur_cents) || 0;
        const fcNq = (fc && fc.next_quarter) || null;
        const dlCard = (v, l, cls, tip) => `<div class="kpi ${cls || ''}"${tip ? ` title="${esc(tip)}"` : ''}><div class="kpi-hd"><div class="v" style="font-size:15px">${v}</div></div><div class="l">${l}</div></div>`;
        const deadlinesHtml = `<div class="kpi-gtitle" style="margin:0 0 8px">⏱ Prochaines échéances</div><div class="admin-cards fin-mini" style="margin-bottom:14px">
            ${dlCard(ossApplies && nextDl ? `${fmtD(nextDl.d)}` : 'Sans objet', ossApplies && nextDl ? `Déclaration OSS T${nextDl.q} ${nextDl.y} — dans ${dlDays} j` : 'OSS — sous le seuil 10 k€', ossApplies && dlDays != null && dlDays <= 14 ? 'alert' : '', 'Trimestrielle : 30/04, 31/07, 31/10, 31/01 — sans report, déclaration néant obligatoire une fois inscrit')}
            ${provCents > 0 ? dlCard(eurFmt(provCents), 'Provision TVA — collectée, non reversée', 'alert', 'TVA due cumulée des trimestres non encore déposés : de l\'argent à réserver, il ne vous appartient pas') : ''}
            ${ossApplies && fcVat > 0 && fcNq ? dlCard('≈ ' + eurFmt(fcVat), `TVA estimée T${fcNq.quarter} ${fcNq.year} (${AdminPage.n(fc.forecast_subscribers)} abonnés UE)`, '', 'Estimation déterministe : renouvellements des abonnés UE actifs × taux du pays (fx indicatif) — pas d\'extrapolation') : ''}
            ${dlCard('Mensuelle', 'DES (versements Google) — 10ᵉ jour ouvrable du mois suivant', '', 'Sans objet tant qu\'aucun versement Play ; ensuite obligatoire chaque mois de versement (douane.gouv.fr, 750 €/DES manquante)')}
            ${dlCard(eurFmt(Math.max(0, FR_THRESH_EUR_CENTS - frBaseEurCents)), 'Marge avant TVA française (franchise 37 500 €)', '', 'Base : ventes web localisées en France — dépassement en cours d\'année au-delà de 41 250 € = TVA dès le jour même')}
        </div>`;

        el.innerHTML = `
            ${profileBar}
            ${heroHtml}
            ${journeyHtml}
            ${deadlinesHtml}
            ${demarchesHtml}
            <details class="vat-expert" ${ossApplies ? 'open' : ''} style="margin-top:18px;border-top:1px solid #2a2a38;padding-top:12px">
            <summary style="cursor:pointer;font-size:12.5px;color:#6b7280;font-weight:650">Données détaillées &amp; déclaration ${ossApplies ? '' : '(mode expert)'}</summary>
            <div style="margin-top:12px">
            <div class="ssub">Périmètre : ventes web directes (Revolut). Les ventes Play/App Store sont déclarées par le store (fournisseur présumé) — hors OSS.</div>
            <div class="kpi-gtitle" style="margin:12px 0 6px">Seuil UE 10 000 € — B2C transfrontalier UE, ${esc(String(ys.year || vat.year))}</div>
            <div class="hbar" title="Ventes B2C vers d'autres pays UE (hors France) sur l'année civile">
                <div class="hbar-l">≈ ${eur(ys.eu_cross_cents)}</div>
                <div class="hbar-track"><div class="hbar-fill ${nearThresh ? 'warn' : ''}" style="width:${Math.max(2, pctT)}%"></div></div>
                <div class="hbar-v">${pctT} % du seuil</div>
            </div>
            <div class="ssub" style="margin-top:6px">${money(ys.eu_cross_cents)} bruts (1 $ ≈ ${FX.toLocaleString('fr-FR', { maximumFractionDigits: 4 })} €${fxFixed ? ', taux BCE figé' : ', indicatif'}) · année précédente : ${money(ys.eu_cross_prev_cents)}.${fc && fc.eta ? ` <b>Au rythme des 3 derniers mois : seuil atteint dans ~${AdminPage.n(fc.eta.months_min)} à ${AdminPage.n(fc.eta.months_max)} mois.</b>` : ''}
            Au-delà du seuil (année en cours OU précédente) : TVA du pays du client via l'OSS — ou régime PME UE (n° EX) pour rester exonéré. Voir docs/TVA-OSS.md.</div>
            <div class="kpi-gtitle" style="margin:12px 0 6px">Franchise en base FR — 37 500 € (majoré 41 250 €)</div>
            <div class="hbar" title="Base : ventes web localisées en France (clients FR + autres-UE tant que le seuil 10 k€ n'est pas franchi). Google Play exclu (B2B Irlande).">
                <div class="hbar-l">≈ ${(frBaseEurCents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</div>
                <div class="hbar-track"><div class="hbar-fill ${overFrMaj || nearFr ? 'warn' : ''}" style="width:${Math.max(2, pctF)}%"></div></div>
                <div class="hbar-v">${pctF} % du seuil${overFrMaj ? ' ⚠ majoré dépassé' : nearFr ? ' ⚠ ~35 k€' : ''}</div>
            </div>
            <div class="ssub" style="margin-top:4px">Année ${esc(String(ys.year || vat.year))} — 🇫🇷 France : <b>${money(ys.fr_cents)}</b> · 🌍 hors UE : ${money(ys.non_eu_cents)}${Number(ys.unknown_cents) > 0 ? ` · <span title="Transactions sans pays capturé — à résorber, la TVA exige la localisation">pays inconnu : <b>${money(ys.unknown_cents)}</b> ⚠</span>` : ''}</div>
            <div style="display:flex;gap:10px;align-items:center;margin:14px 0 8px;flex-wrap:wrap">
                <span class="kpi-gtitle" style="margin:0">Base par pays de consommation</span>
                <select id="vat-quarter" title="Trimestre (cadence de déclaration OSS)">${qSel}</select>
                ${fxFixed
                    ? `<span class="badge green" title="Taux BCE USD→EUR du dernier jour du trimestre, figé le ${esc(fx.fixed_at ? new Date(fx.fixed_at).toLocaleDateString('fr-FR') : '—')}">🔒 BCE ${FX.toLocaleString('fr-FR', { maximumFractionDigits: 4 })}</span>`
                    : (new Date(Date.UTC(vat.year, (vat.quarter - 1) * 3 + 3, 1)) <= new Date()
                        ? `<button id="vat-fx-btn" class="mini-btn" title="Trimestre clos : figer le taux BCE du dernier jour (les montants EUR deviennent définitifs)">🔒 Figer le taux BCE</button>`
                        : `<span class="badge gray" title="Le taux BCE définitif se fige à la clôture du trimestre">fx indicatif ${EUR_PER_USD.toLocaleString('fr-FR')}</span>`)}
                <button id="vat-csv" class="mini-btn" title="Exporter la base du trimestre par pays (CSV)">⬇ CSV</button>
                ${(rows.length || corrections.length) ? `<button id="vat-dossier" class="mini-btn" title="Dossier trimestriel autonome (HTML imprimable) : déclaration + registre + dépôts — pour l'expert-comptable ou une due diligence">🗂 Dossier T${vat.quarter}</button>` : ''}
                ${(ossVatEur > 0 || corrections.length) ? `<button id="vat-assist-btn" class="mini-btn" ${unknownN > 0 ? 'disabled title="Résolvez d\'abord les pays inconnus — la TVA exige la localisation"' : 'title="Guide champ par champ, dans l\'ordre du portail OSS"'}>🧾 Préparer la déclaration T${vat.quarter}</button>` : ''}
                ${ossApplies ? `<button id="vat-ics" class="mini-btn" title="Télécharger les 4 prochaines échéances OSS au format calendrier (.ics)">📅 .ics</button>` : ''}
            </div>
            ${rowsHtml ? `<div class="scroll"><table><thead><tr><th>Pays</th><th>Zone</th><th class="num">Net (USD)</th><th class="num">Base (EUR)</th><th class="num">Taux</th><th class="num">TVA due</th></tr></thead><tbody>${rowsHtml}</tbody>${vatFoot}</table></div>
            <div class="ssub" style="margin-top:6px">TVA due = base convertie × taux du pays. <b>Total à reverser via l'OSS</b> pour ${esc('T' + vat.quarter + ' ' + vat.year)} : <b style="color:#34d399">${eurFmt(ossVatEur)}</b>${Number(tot.unknown_n) > 0 ? ' — <span style="color:#fbbf24">⚠ incomplet (voir ci-dessous)</span>' : ''}.</div>`
                : '<div class="ssub">Aucune vente web sur ce trimestre.</div>'}
            ${corrections.length ? `<div class="kpi-gtitle" style="margin:12px 0 6px">Corrections OSS — remboursements de trimestres antérieurs</div>
            <div class="scroll"><table><thead><tr><th>Période d'origine</th><th>Pays</th><th class="num">À corriger</th></tr></thead><tbody>
            ${corrections.map(c => `<tr><td>T${esc(String(c.orig_quarter))} ${esc(String(c.orig_year))}</td><td>${c.country_code === '??' ? '<span class="ssub">Inconnu</span>' : AdminPage.flag(c.country_code)}</td><td class="num">−${money(c.refund_cents)}</td></tr>`).join('')}
            </tbody></table></div>
            <div class="ssub" style="margin-top:4px">À reporter dans la <b>rubrique corrections</b> de la déclaration OSS, sur la période d'origine (pas en négatif du trimestre courant — délai 3 ans).</div>` : ''}
            <div id="vat-tx" style="display:none;margin-top:10px;border:1px solid #2a2a38;border-radius:8px;padding:10px"></div>
            ${Number(tot.unknown_n) > 0 ? `<div class="ssub" style="margin-top:6px">⚠ <b>Total incomplet</b> : ${n(tot.unknown_n)} transaction(s) sans pays (${money(tot.unknown_gross_cents)}) — la TVA exige la localisation. À résoudre avant de déclarer. <button class="mini-btn" id="vat-tx-unknown">Voir les transactions sans pays</button></div>` : ''}
            ${rows.some(r => r.country_code === 'GB') ? `<div class="ssub" style="margin-top:6px">⚠ <b>Royaume-Uni</b> : seuil d'immatriculation NUL pour un vendeur non établi — TVA UK (20 %) due dès la 1ʳᵉ vente web B2C (immatriculation HMRC). Décision à prendre : bloquer les clients UK au checkout, ou s'immatriculer.</div>` : ''}
            ${rows.some(r => r.country_code === 'CH') ? `<div class="ssub" style="margin-top:6px">⚠ <b>Suisse</b> : des ventes CH existent — assujettissement TVA suisse (8,1 %) dès CHF 100 000 de chiffre d'affaires <b>mondial</b>. À surveiller avec l'expert-comptable (détail : docs/TVA-OSS.md).</div>` : ''}
            ${rows.some(r => r.country_code === 'NO') ? `<div class="ssub" style="margin-top:6px">⚠ <b>Norvège</b> : des ventes NO existent — régime VOEC dès NOK 50 000 de ventes B2C sur 12 mois glissants (déclarations trimestrielles). À surveiller (détail : docs/TVA-OSS.md).</div>` : ''}
            <div id="vat-assist" style="display:none;margin-top:14px;border:1px solid #2a2a38;border-radius:10px;padding:14px;background:rgba(124,147,255,.05)"></div>
            <div class="kpi-gtitle" style="margin:16px 0 6px">📓 Journal des dépôts <span class="ssub" style="font-weight:500">— votre registre (conservation 10 ans)</span></div>
            <div id="vat-filings"><div class="ssub">Chargement…</div></div>
            <div class="ssub" style="margin-top:10px">${fxFixed
                ? `Montants EUR <b>définitifs</b> — taux BCE ${FX.toLocaleString('fr-FR', { maximumFractionDigits: 4 })} figé au dernier jour du trimestre (art. 369h dir. 2006/112).`
                : `Conversion EUR <b>indicative</b> (1 $ ≈ ${EUR_PER_USD.toLocaleString('fr-FR')} €) : figez le taux BCE à la clôture du trimestre pour des montants définitifs (art. 369h dir. 2006/112).`}
            Taux de TVA standard : table serveur <code>eu_vat_standard_rates</code> (source TEDB — à rafraîchir avant chaque dépôt si un taux change). Rappel : les versements Google Play sont hors OSS (Google = fournisseur présumé) mais déclenchent une <b>DES mensuelle</b> + n° de TVA intracom. Détail : docs/TVA-OSS.md.</div>
            </div></details>`;

        // ── Profil : localStorage (cache instantané) + serveur (durable, multi-appareils) ──
        const pushProfile = (patch) => { try { this._rpc('admin_business_profile_set', { p_patch: patch }).catch(() => {}); } catch (_) { /* best-effort */ } };
        const saveProfile = (patch) => { try { localStorage.setItem('norva-vat-profile', JSON.stringify(profile)); } catch (_) { /* plein */ } if (patch) pushProfile(patch); };
        const pForm = document.getElementById('vat-prof-form');
        if (pForm) pForm.addEventListener('change', () => { profile.form = pForm.value; saveProfile({ legal_form: profile.form }); if (this._route === 'finance') this._renderVatPanel(vat); });
        const pName = document.getElementById('vat-prof-name');
        if (pName) pName.addEventListener('change', () => { profile.name = pName.value.trim(); saveProfile({ company_name: profile.name }); if (this._route === 'finance') this._renderVatPanel(vat); });
        const pSiren = document.getElementById('vat-prof-siren');
        if (pSiren) pSiren.addEventListener('change', () => { profile.siren = pSiren.value.trim(); saveProfile({ siren: profile.siren }); if (this._route === 'finance') this._renderVatPanel(vat); });
        const pVat = document.getElementById('vat-prof-vat');
        if (pVat) pVat.addEventListener('change', () => { profile.vat_number = pVat.value.trim().toUpperCase(); saveProfile({ vat_number: profile.vat_number }); if (this._route === 'finance') this._renderVatPanel(vat); });

        // Sync serveur au premier rendu de l'onglet : si le serveur a un profil, il fait
        // foi (→ localStorage + re-render) ; sinon on l'amorce depuis le cache local.
        if (!this._vatProfileSynced) {
            this._vatProfileSynced = true;
            this._rpc('admin_business_profile_get').then((p) => {
                if (!p || typeof p !== 'object') return;
                const hasServer = p.company_name || p.siren || p.vat_number || (p.demarches && Object.keys(p.demarches).length) || p.legal_form && p.legal_form !== 'micro';
                if (hasServer) {
                    const srvProf = { form: p.legal_form || 'micro', name: p.company_name || '', siren: p.siren || '', vat_number: p.vat_number || '' };
                    const srvDem = (p.demarches && typeof p.demarches === 'object') ? p.demarches : {};
                    const changed = JSON.stringify(srvProf) !== JSON.stringify({ form: profile.form, name: profile.name || '', siren: profile.siren || '', vat_number: profile.vat_number || '' })
                        || JSON.stringify(srvDem) !== JSON.stringify(vatCk);
                    if (changed) {
                        try { localStorage.setItem('norva-vat-profile', JSON.stringify(srvProf)); localStorage.setItem('norva-vat-checklist', JSON.stringify(srvDem)); } catch (_) { /* plein */ }
                        if (this._route === 'finance') this._renderVatPanel(vat);
                    }
                } else if (profile.name || profile.siren || profile.vat_number || Object.keys(vatCk).length || profile.form !== 'micro') {
                    pushProfile({ legal_form: profile.form, company_name: profile.name || '', siren: profile.siren || '', vat_number: profile.vat_number || '', demarches: vatCk });
                }
            }).catch(() => { /* serveur absent (pré-migration) → localStorage seul */ });
        }

        // ── Démarches : copie de courrier + « effectué » (localStorage + serveur) ────
        const saveCk = () => { try { localStorage.setItem('norva-vat-checklist', JSON.stringify(vatCk)); } catch (_) { /* plein */ } pushProfile({ demarches: vatCk }); };
        el.querySelectorAll('.vat-letter').forEach(b => b.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(letters[b.dataset.letter] || ''); this._toast('✓ Courrier copié dans le presse-papier', 'ok'); }
            catch (_) { this._toast('Copie impossible — sélectionnez le texte manuellement.', 'err'); }
        }));
        el.querySelectorAll('.vat-done').forEach(b => b.addEventListener('click', () => {
            const k = b.dataset.dem; vatCk[k] = !vatCk[k]; saveCk();
            if (this._route === 'finance') this._renderVatPanel(vat);
        }));

        // ── CTA de la carte « Action requise » → ouvre la bonne démarche/section ─────
        const openDem = (id) => { const d = document.getElementById('dem-' + id); if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'center' }); } };
        const wire = (btnId, fn) => { const b = document.getElementById(btnId); if (b) b.addEventListener('click', fn); };
        wire('vat-cta-intracom', () => openDem('intracom'));
        wire('vat-cta-oss', () => openDem('oss'));
        wire('vat-cta-unknown', () => { const d = document.querySelector('.vat-expert'); if (d) d.open = true; const u = document.getElementById('vat-tx-unknown'); if (u) { u.click(); u.scrollIntoView({ behavior: 'smooth', block: 'center' }); } });
        wire('vat-cta-declare', () => { const d = document.querySelector('.vat-expert'); if (d) d.open = true; const a = document.getElementById('vat-assist-btn'); if (a && !a.disabled) { a.click(); a.scrollIntoView({ behavior: 'smooth', block: 'center' }); } });

        const sel = document.getElementById('vat-quarter');
        if (sel) sel.addEventListener('change', async () => {
            const [y2, q2] = sel.value.split('-').map(Number);
            sel.disabled = true;
            try {
                const res = await this._rpc('admin_vat_report', { p_year: y2, p_quarter: q2 });
                if (this._route === 'finance') this._renderVatPanel(res);
            } catch (e) {
                sel.disabled = false;
                this._toast('Erreur rapport TVA : ' + e.message, 'err');
            }
        });
        const csvBtn = document.getElementById('vat-csv');
        if (csvBtn) csvBtn.addEventListener('click', () => {
            const q = (x) => {
                let s = String(x == null ? '' : x);
                if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
                return `"${s.replace(/"/g, '""')}"`;
            };
            const lines = [['pays', 'zone', 'devise', 'nb_transactions', 'brut_usd_cents', 'rembourse_usd_cents', 'net_usd_cents', 'base_eur_cents', 'taux_tva', 'tva_due_eur_cents', 'correction_de'].map(q).join(',')]
                .concat(rowsCalc.map(x => [x.cc, x.isEu ? (x.isFr ? 'FR_franchise' : 'UE_OSS') : (x.unknown ? '' : 'hors_UE'), x.r.currency, x.r.n_tx, x.r.gross_cents, x.r.refunded_cents, x.r.net_cents, x.baseEur, x.rate != null ? x.rate : '', x.vatDue, ''].map(q).join(',')))
                .concat(corrections.map(c => [c.country_code, 'correction', c.currency, '', '', c.refund_cents, '', '', '', '', `T${c.orig_quarter} ${c.orig_year}`].map(q).join(',')));
            const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `norva-tva-${vat.year}-T${vat.quarter}.csv`;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        });

        // ── Dossier trimestriel : HTML autonome imprimable (comptable / due diligence) ──
        // Un seul fichier, zéro dépendance : profil, déclaration par pays, corrections,
        // registre transaction par transaction, dépôts. Thème clair (imprimable en PDF
        // par le navigateur). Les métadonnées de calcul (fx, taux) sont incluses.
        const dossierBtn = document.getElementById('vat-dossier');
        if (dossierBtn) dossierBtn.addEventListener('click', async () => {
            dossierBtn.disabled = true;
            try {
                const [txRes, filRes] = await Promise.all([
                    this._rpc('admin_vat_transactions', { p_year: vat.year, p_quarter: vat.quarter }).catch(() => null),
                    this._rpc('admin_vat_filings', { p_year: vat.year, p_quarter: vat.quarter }).catch(() => null),
                ]);
                const txs = (txRes && Array.isArray(txRes.rows)) ? txRes.rows : [];
                const fils = Array.isArray(filRes) ? filRes : [];
                const dtL = (d) => d ? new Date(d).toLocaleString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
                const KINDS2 = { first_charge: '1ᵉʳ prélèvement', renewal: 'renouvellement', refund: 'remboursement' };
                const declRows = rowsCalc.map(x => `<tr><td>${x.unknown ? 'Inconnu' : esc(x.cc)}</td><td>${x.isEu ? (x.isFr ? 'France (franchise)' : 'UE — OSS') : (x.unknown ? '—' : 'hors UE')}</td><td class="r">${money(x.r.net_cents)}</td><td class="r">${eurFmt(x.baseEur)}</td><td class="r">${x.rate != null ? x.rate.toLocaleString('fr-FR') + ' %' : '—'}</td><td class="r">${x.rate != null ? eurFmt(x.vatDue) : '—'}</td></tr>`).join('');
                const corrRows = corrections.map(c => `<tr><td>T${esc(String(c.orig_quarter))} ${esc(String(c.orig_year))}</td><td>${esc(c.country_code)}</td><td class="r">−${money(c.refund_cents)}</td></tr>`).join('');
                const txRows = txs.map(x => `<tr><td>${esc(dtL(x.at))}</td><td>${esc(x.email || x.user_id)}</td><td>${KINDS2[x.kind] || esc(x.kind)}</td><td class="r">${x.kind === 'refund' ? '−' : ''}${money(x.amount)}</td><td>${esc(x.country_code || '—')}</td><td>${x.evidence === 'card_bin' ? 'BIN carte (art. 24f, c)' : '—'}</td></tr>`).join('');
                const filRows = fils.map(f2 => `<tr><td>${esc(dtL(f2.filed_at))}</td><td class="r">${f2.vat_eur_cents != null ? eurFmt(f2.vat_eur_cents) : '—'}</td><td>${f2.paid_at ? '✓ ' + esc(dtL(f2.paid_at)) : 'non marqué'}</td><td>${esc(f2.reference || '—')}</td><td>${esc(f2.document_path || '—')}</td></tr>`).join('');
                const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Norva — Dossier TVA T${vat.quarter} ${vat.year}</title><style>
                    body{font:13px/1.5 Arial,sans-serif;color:#111;margin:34px;max-width:900px}
                    h1{font-size:20px;margin:0 0 2px}h2{font-size:14px;margin:22px 0 8px;border-bottom:1px solid #ccc;padding-bottom:4px}
                    .sub{color:#555;font-size:12px;margin:0 0 4px}
                    table{border-collapse:collapse;width:100%;font-size:12px;margin-top:6px}
                    th{text-align:left;background:#f2f2f2;border:1px solid #ddd;padding:5px 8px}
                    td{border:1px solid #ddd;padding:5px 8px}td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}
                    tfoot td{font-weight:bold;background:#fafafa}
                    .note{font-size:11px;color:#666;margin-top:6px}
                    @media print{body{margin:12mm}}
                </style></head><body>
                <h1>Dossier TVA — T${vat.quarter} ${vat.year}</h1>
                <p class="sub">${esc(profile.name || 'Norva')}${profile.siren ? ' · SIREN ' + esc(profile.siren) : ''}${profile.vat_number ? ' · TVA ' + esc(profile.vat_number) : ''} · ${esc(pf.label)} · généré le ${esc(new Date().toLocaleString('fr-FR'))}</p>
                <p class="sub">Périmètre : ventes web directes (Revolut) — les ventes Play/App Store sont déclarées par le store (fournisseur présumé, art. 9 bis règl. UE 282/2011). Conversion : ${fxFixed ? `taux BCE ${FX.toLocaleString('fr-FR', { maximumFractionDigits: 4 })} figé au dernier jour du trimestre (art. 369h)` : `taux INDICATIF 1 $ ≈ ${FX.toLocaleString('fr-FR')} € — taux BCE non encore figé`}. Taux de TVA : standards (source TEDB).</p>
                <h2>1. Déclaration par pays de consommation</h2>
                <table><thead><tr><th>Pays</th><th>Zone</th><th class="r">Net (USD)</th><th class="r">Base (EUR)</th><th class="r">Taux</th><th class="r">TVA due</th></tr></thead>
                <tbody>${declRows || '<tr><td colspan="6">Aucune vente sur le trimestre.</td></tr>'}</tbody>
                <tfoot><tr><td colspan="3">Total OSS — UE hors France</td><td class="r">${eurFmt(ossBaseEur)}</td><td></td><td class="r">${eurFmt(ossVatEur)}</td></tr></tfoot></table>
                ${corrRows ? `<h2>2. Corrections de périodes antérieures</h2><table><thead><tr><th>Période d'origine</th><th>Pays</th><th class="r">Montant (USD)</th></tr></thead><tbody>${corrRows}</tbody></table><p class="note">À reporter dans la rubrique corrections de la déclaration OSS, sur la période d'origine (délai 3 ans).</p>` : ''}
                <h2>${corrRows ? '3' : '2'}. Registre des transactions (art. 63c — ${AdminPage.n(txRes && txRes.total)} transaction(s))</h2>
                <table><thead><tr><th>Date</th><th>Client</th><th>Type</th><th class="r">Montant (USD)</th><th>Pays</th><th>Preuve de localisation</th></tr></thead>
                <tbody>${txRows || '<tr><td colspan="6">Aucune transaction.</td></tr>'}</tbody></table>
                ${Number(txRes && txRes.total) > txs.length ? `<p class="note">Registre tronqué à ${txs.length} lignes (${AdminPage.n(txRes.total)} au total) — l'intégralité reste requêtable en base (cloud_billing_ledger).</p>` : ''}
                <h2>${corrRows ? '4' : '3'}. Dépôts enregistrés pour ce trimestre</h2>
                <table><thead><tr><th>Déposé le</th><th class="r">TVA reversée</th><th>Payé</th><th>Référence</th><th>Certificat (chemin)</th></tr></thead>
                <tbody>${filRows || '<tr><td colspan="5">Aucun dépôt enregistré.</td></tr>'}</tbody></table>
                <p class="note">Document généré par le cockpit TVA Norva. Montants sources en USD (cents du ledger) ; bases et TVA en EUR selon la conversion indiquée en tête. Conservation des registres : 10 ans (art. 63c règl. UE 282/2011).</p>
                </body></html>`;
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
                a.download = `norva-dossier-tva-${vat.year}-T${vat.quarter}.html`;
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(a.href), 5000);
                this._toast('✓ Dossier généré — imprimable en PDF depuis le navigateur', 'ok');
            } catch (e) { this._toast('Erreur dossier : ' + e.message, 'err'); }
            dossierBtn.disabled = false;
        });

        // ── Drill-down registre : les transactions derrière chaque ligne pays ──────
        // Couche de confiance : chaque ligne de la déclaration est vérifiable à la
        // transaction près (esprit du registre art. 63c), avec sa preuve de
        // localisation ; '??' liste les inconnues à résoudre (clic → fiche client).
        const txEl = document.getElementById('vat-tx');
        const loadTx = async (cc) => {
            if (!txEl) return;
            if (txEl.dataset.cc === cc && txEl.style.display !== 'none') { txEl.style.display = 'none'; return; }
            txEl.dataset.cc = cc;
            txEl.style.display = '';
            txEl.innerHTML = '<div class="ssub">Chargement…</div>';
            try {
                const res = await this._rpc('admin_vat_transactions', { p_year: vat.year, p_quarter: vat.quarter, p_country: cc });
                const list = (res && Array.isArray(res.rows)) ? res.rows : [];
                const dt2 = (d) => d ? new Date(d).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
                const KINDS = { first_charge: '1ᵉʳ prélèvement', renewal: 'renouvellement', refund: 'remboursement' };
                const trs = list.map(x => `<tr class="user-row" data-user-id="${esc(x.user_id)}" tabindex="0" style="cursor:pointer" title="Ouvrir la fiche client">
                    <td>${esc(dt2(x.at))}</td><td>${esc(x.email || x.user_id)}</td>
                    <td>${KINDS[x.kind] || esc(x.kind)}</td>
                    <td class="num">${x.kind === 'refund' ? '−' : ''}${money(x.amount)}</td>
                    <td>${AdminPage.flag(x.country_code)}</td>
                    <td>${x.evidence === 'card_bin' ? '<span class="badge blue" title="Pays d\'émission de la carte — élément de preuve fourni par Revolut (art. 24f, item c)">BIN carte</span>' : '<span class="badge amber" title="Aucune preuve de localisation capturée">aucune</span>'}</td>
                </tr>`).join('');
                txEl.innerHTML = `<div class="kpi-gtitle" style="margin:0 0 8px">Registre — ${cc === '??' ? 'transactions sans pays' : 'transactions ' + AdminPage.flag(cc)} · T${vat.quarter} ${vat.year} (${AdminPage.n(res.total)})</div>
                    ${trs ? `<div class="scroll"><table><thead><tr><th>Date</th><th>Client</th><th>Type</th><th class="num">Montant</th><th>Pays</th><th>Preuve</th></tr></thead><tbody>${trs}</tbody></table></div>` : '<div class="ssub">Aucune transaction.</div>'}
                    ${Number(res.total) > list.length ? `<div class="ssub" style="margin-top:4px">Affichage limité aux 500 plus récentes (${AdminPage.n(res.total)} au total).</div>` : ''}
                    ${cc === '??' ? '<div class="ssub" style="margin-top:6px">Pour résoudre : ouvrir la fiche du client (clic sur la ligne) — son prochain paiement re-capturera le pays automatiquement ; sinon, retrouver le pays de la carte sur l\'ordre dans le dashboard Revolut et le corriger en base.</div>' : ''}`;
            } catch (e) {
                txEl.innerHTML = `<div class="ssub">Registre indisponible : ${esc(e.message)}${/PGRST202/.test(String(e.message)) ? ' — déployez la migration 20260717170000 + NOTIFY pgrst.' : ''}</div>`;
            }
        };
        el.querySelectorAll('.vat-cc-row').forEach(tr => tr.addEventListener('click', () => loadTx(tr.dataset.cc)));
        const unkBtn = document.getElementById('vat-tx-unknown');
        if (unkBtn) unkBtn.addEventListener('click', () => loadTx('??'));

        // ── Journal des dépôts (le registre — durable, serveur) ─────────────────────
        const loadFilings = async () => {
            const fEl = document.getElementById('vat-filings');
            if (!fEl) return;
            try {
                const list = await this._rpc('admin_vat_filings', {});
                const arr = Array.isArray(list) ? list : [];
                if (!arr.length) { fEl.innerHTML = '<div class="ssub">Aucun dépôt enregistré. Après chaque déclaration, l\'assistant propose de l\'ajouter ici.</div>'; return; }
                const dt = (d) => d ? new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
                fEl.innerHTML = `<div class="scroll"><table><thead><tr><th>Période</th><th>Déposé le</th><th class="num">TVA reversée</th><th>Payé</th><th>Référence</th><th>Certificat</th></tr></thead><tbody>${arr.map(f => `<tr>
                    <td>T${esc(String(f.quarter))} ${esc(String(f.year))}</td>
                    <td>${esc(dt(f.filed_at))}</td>
                    <td class="num">${f.vat_eur_cents != null ? eurFmt(f.vat_eur_cents) : '—'}</td>
                    <td>${f.paid_at ? `<span class="badge green" title="Virement marqué payé">✓ ${esc(dt(f.paid_at))}</span>` : `<button class="mini-btn vat-paid" data-id="${esc(f.id)}" title="Marquer le virement OSS comme effectué (déclaré → payé → archivé)">💶 Marquer payé</button>`}</td>
                    <td class="ssub">${esc(f.reference || f.note || '—')}</td>
                    <td>${f.document_path ? `<button class="mini-btn vat-cert-dl" data-path="${esc(f.document_path)}" title="Télécharger le certificat de dépôt (bucket privé)">📄 PDF</button>` : '<span class="ssub">—</span>'}</td>
                </tr>`).join('')}</tbody></table></div>`;
                fEl.querySelectorAll('.vat-paid').forEach(b => b.addEventListener('click', async () => {
                    b.disabled = true;
                    try { await this._rpc('admin_vat_filing_mark_paid', { p_id: b.dataset.id }); this._toast('✓ Virement marqué payé — cycle complet (déclaré → payé → archivé)', 'ok'); loadFilings(); }
                    catch (e) { b.disabled = false; this._toast('Erreur : ' + e.message, 'err'); }
                }));
                // Bucket privé : téléchargement authentifié (fetch + blob) — pas d'URL publique.
                fEl.querySelectorAll('.vat-cert-dl').forEach(b => b.addEventListener('click', async () => {
                    b.disabled = true;
                    try {
                        const r = await fetch(`${this._sbUrl()}/storage/v1/object/vat-certificates/${b.dataset.path}`, {
                            headers: { apikey: this._sbKey(), Authorization: `Bearer ${this._token()}` },
                        });
                        if (!r.ok) throw new Error(String(r.status));
                        const blob = await r.blob();
                        const a = document.createElement('a');
                        a.href = URL.createObjectURL(blob);
                        a.download = `norva-certificat-${String(b.dataset.path).split('/').pop()}`;
                        document.body.appendChild(a); a.click(); a.remove();
                        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
                    } catch (e) { this._toast('Téléchargement impossible : ' + e.message, 'err'); }
                    b.disabled = false;
                }));
            } catch (e) {
                fEl.innerHTML = `<div class="ssub">Journal indisponible${/PGRST202/.test(String(e.message)) ? ' — déployez la migration 20260717180000 + NOTIFY pgrst.' : ' : ' + esc(e.message)}</div>`;
            }
        };
        loadFilings();

        // ── Assistant de dépôt : champ par champ, dans l'ordre du portail OSS ──
        const assistBtn = document.getElementById('vat-assist-btn');
        const assistEl = document.getElementById('vat-assist');
        if (assistBtn && assistEl) assistBtn.addEventListener('click', () => {
            if (assistEl.style.display !== 'none') { assistEl.style.display = 'none'; return; }
            const cp = (txt) => `<button class="mini-btn vat-copy" data-copy="${esc(txt)}" title="Copier la valeur">📋 ${esc(txt)}</button>`;
            const frVal = (c) => (Number(c) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
            const ossRows = rowsCalc.filter(x => x.isEu && !x.isFr && x.baseEur > 0);
            const steps = ossRows.map((x, i) => `<div style="margin:10px 0;padding:10px;border:1px solid #2a2a38;border-radius:8px">
                <b>Ligne ${i + 1} — ${AdminPage.flag(x.cc)} ${esc(COUNTRY_FR[x.cc] || x.cc)}</b><br/>
                <span class="ssub">Type d'opération :</span> Prestations de services ·
                <span class="ssub">Pays de consommation :</span> ${esc(COUNTRY_FR[x.cc] || x.cc)} ·
                <span class="ssub">Taux :</span> ${x.rate != null ? x.rate.toLocaleString('fr-FR') + ' %' : '—'}<br/>
                <span class="ssub">Base imposable (EUR) :</span> ${cp(frVal(x.baseEur))}
                <span class="ssub" style="margin-left:10px">TVA attendue (auto-calculée par le portail) :</span> <b>${eurFmt(x.vatDue)}</b>
            </div>`).join('');
            const corrSteps = corrections.length ? `<div style="margin:10px 0;padding:10px;border:1px solid #2a2a38;border-radius:8px">
                <b>Rubrique « Corrections de périodes précédentes »</b><br/>
                ${corrections.map(c => `<div class="ssub" style="margin-top:4px">Période T${esc(String(c.orig_quarter))} ${esc(String(c.orig_year))} · ${c.country_code === '??' ? 'Inconnu' : AdminPage.flag(c.country_code)} · montant à corriger : ${cp('-' + frVal(Math.round(Number(c.refund_cents) * (Number(c.orig_usd_eur_rate) || FX))))}${c.orig_usd_eur_rate ? '' : ' <span style="color:#fbbf24">(fx d\'origine non figé — indicatif)</span>'}</div>`).join('')}
            </div>` : '';
            // Référence de virement RÉELLE dès que le n° de TVA intracom est au profil.
            const vatNum = (profile.vat_number || '').replace(/\s+/g, '').toUpperCase();
            const payRef = vatNum ? `OSS/FR/${vatNum}/Q${vat.quarter}.${vat.year}` : null;
            assistEl.innerHTML = `
                <div style="font-weight:700;margin-bottom:4px">🧾 Déclaration OSS T${vat.quarter} ${vat.year} — pas à pas</div>
                ${fxFixed ? '' : `<div class="ssub" style="color:#fbbf24;margin-bottom:8px">⚠ Taux BCE non figé — montants INDICATIFS. Figez le taux (bouton 🔒) avant le dépôt réel.</div>`}
                <div class="ssub">1. Connectez-vous : <b>impots.gouv.fr</b> → Mes services → Démarches → <b>Guichet de TVA UE</b> → Déclarer (régime UE).</div>
                <div class="ssub" style="margin-top:4px">2. Saisissez une ligne par pays (les ventes France ne vont <b>jamais</b> dans l'OSS) :</div>
                ${steps || '<div class="ssub">Aucune ligne UE hors France ce trimestre.</div>'}
                ${corrSteps}
                <div class="ssub" style="margin-top:6px">3. Vérifiez le total : le portail doit afficher <b style="color:#34d399">${eurFmt(ossVatEur)}</b>.</div>
                <div class="ssub" style="margin-top:4px">4. Paiement : virement <b>en euros</b> au Pôle national TVA commerce en ligne. Motif = la référence unique de la déclaration${payRef ? ' :' : ` (format OSS/FR/&lt;votre n° TVA&gt;/Q${vat.quarter}.${vat.year} — <b>renseignez votre n° de TVA intracom dans le profil</b> pour l'obtenir ici).`}</div>
                ${payRef ? `<div class="ssub" style="margin-top:2px">Montant : ${cp(frVal(ossVatEur))} €  ·  Motif : ${cp(payRef)}</div>` : ''}
                <div class="ssub" style="margin-top:4px">Date de valeur = crédit du compte, virez en avance. Échéance : <b>${nextDl ? fmtD(nextDl.d) : '—'}</b>, sans report.</div>
                <div class="ssub" style="margin-top:4px">5. Archivez le certificat de dépôt (PDF téléchargé sur le portail) et enregistrez le dépôt au journal — l'ensemble constitue le registre (conservation 10 ans) :</div>
                <div style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                    <input id="vat-file-ref" placeholder="Référence / n° de certificat" value="${payRef ? esc(payRef) : ''}" style="${inp};width:210px"/>
                    <input id="vat-file-pdf" type="file" accept="application/pdf" title="Certificat de dépôt (PDF) — archivé dans le bucket privé vat-certificates" style="${inp};max-width:230px"/>
                    <button id="vat-file-save" class="mini-btn" style="font-weight:700">📓 Enregistrer ce dépôt au journal</button>
                </div>`;
            assistEl.style.display = '';
            assistEl.querySelectorAll('.vat-copy').forEach(b => b.addEventListener('click', async () => {
                try { await navigator.clipboard.writeText(b.dataset.copy); this._toast('✓ Copié : ' + b.dataset.copy, 'ok'); }
                catch (_) { this._toast('Copie impossible — sélectionnez manuellement.', 'err'); }
            }));
            const fileSave = document.getElementById('vat-file-save');
            if (fileSave) fileSave.addEventListener('click', async () => {
                fileSave.disabled = true;
                try {
                    // Certificat PDF (optionnel) : upload d'abord dans le bucket privé,
                    // puis la ligne de journal référence son chemin. Un échec d'upload
                    // bloque l'enregistrement (pas de ligne « avec certificat » mensongère).
                    let docPath = null;
                    const fInp = document.getElementById('vat-file-pdf');
                    const file = fInp && fInp.files && fInp.files[0];
                    if (file) {
                        if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) throw new Error('Le certificat doit être un PDF.');
                        docPath = `${vat.year}/T${vat.quarter}-${Date.now()}.pdf`;
                        const up = await fetch(`${this._sbUrl()}/storage/v1/object/vat-certificates/${docPath}`, {
                            method: 'POST',
                            headers: { apikey: this._sbKey(), Authorization: `Bearer ${this._token()}`, 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
                            body: file,
                        });
                        if (!up.ok) {
                            const d = await up.json().catch(() => ({}));
                            throw new Error('Upload du certificat impossible : ' + (d.message || d.error || up.status));
                        }
                    }
                    await this._rpc('admin_vat_filing_record', {
                        p_year: vat.year, p_quarter: vat.quarter, p_vat_eur_cents: ossVatEur,
                        p_reference: (document.getElementById('vat-file-ref') || {}).value || payRef || null, p_note: null,
                        p_document_path: docPath,
                    });
                    this._toast(docPath ? '✓ Dépôt + certificat archivés au journal' : '✓ Dépôt enregistré au journal (registre)', 'ok');
                    vatCk.declared = true; saveCk();
                    loadFilings();
                } catch (e) { fileSave.disabled = false; this._toast('Erreur : ' + e.message, 'err'); }
            });
        });

        // ── Figer le taux BCE du trimestre clos (suggestion ECB via frankfurter, l'humain valide) ──
        const fxBtn = document.getElementById('vat-fx-btn');
        if (fxBtn) fxBtn.addEventListener('click', async () => {
            fxBtn.disabled = true;
            const last = new Date(Date.UTC(vat.year, vat.quarter * 3, 0)); // dernier jour du trimestre
            const iso = last.toISOString().slice(0, 10);
            let sugg = '';
            try {
                // Taux de référence BCE (API frankfurter, données BCE). Simple suggestion : l'admin valide.
                const r = await fetch(`https://api.frankfurter.dev/v1/${iso}?base=USD&symbols=EUR`, { signal: AbortSignal.timeout(6000) });
                const d = await r.json();
                if (d && d.rates && d.rates.EUR) sugg = String(d.rates.EUR);
            } catch (_) { /* saisie manuelle */ }
            const raw = window.prompt(`Taux BCE USD→EUR publié le ${fmtD(last)} (dernier jour de T${vat.quarter} ${vat.year} — à défaut de publication ce jour-là, le jour de publication suivant).${sugg ? `\nSuggestion (BCE via frankfurter) : ${sugg}` : '\nSource : https://www.ecb.europa.eu (taux de référence USD)'}`, sugg);
            if (raw == null) { fxBtn.disabled = false; return; }
            const val = parseFloat(String(raw).replace(',', '.'));
            if (!Number.isFinite(val) || val <= 0.2 || val >= 5) { fxBtn.disabled = false; this._toast('Taux invalide.', 'err'); return; }
            try {
                await this._rpc('admin_vat_fx_set', { p_year: vat.year, p_quarter: vat.quarter, p_rate: val });
                const res = await this._rpc('admin_vat_report', { p_year: vat.year, p_quarter: vat.quarter });
                this._toast(`✓ Taux BCE T${vat.quarter} ${vat.year} figé : ${val}`, 'ok');
                if (this._route === 'finance') this._renderVatPanel(res);
            } catch (e) { fxBtn.disabled = false; this._toast('Erreur : ' + e.message, 'err'); }
        });

        // ── Export .ics des 4 prochaines échéances OSS ──
        const icsBtn = document.getElementById('vat-ics');
        if (icsBtn) icsBtn.addEventListener('click', () => {
            const evts = dlCands.filter(c => c.d > tNow).slice(0, 4);
            const pad = (x) => String(x).padStart(2, '0');
            const dstr = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
            const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Norva//TVA//FR']
                .concat(evts.flatMap(c => ['BEGIN:VEVENT',
                    `UID:norva-oss-${c.y}-q${c.q}@norva.tv`,
                    `DTSTART;VALUE=DATE:${dstr(c.d)}`,
                    `SUMMARY:Déclaration OSS T${c.q} ${c.y} — échéance (sans report)`,
                    'DESCRIPTION:Guichet TVA UE sur impots.gouv.fr — déclaration + virement EUR (motif = référence unique). Panneau TVA Norva : montants pré-calculés.',
                    'BEGIN:VALARM', 'TRIGGER:-P7D', 'ACTION:DISPLAY', `DESCRIPTION:OSS T${c.q} ${c.y} dans 7 jours`, 'END:VALARM',
                    'END:VEVENT']))
                .concat(['END:VCALENDAR']).join('\r\n');
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
            a.download = 'norva-echeances-oss.ics';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        });
    }

    // ── Page: Support (tickets list) ──
    async _pageSupport(filter) {
        this._setCrumb('Support');
        this._supportFilter = filter !== undefined ? filter : (this._supportFilter || 'needs_reply');
        // Tabs call this directly (not via _navigate), so _nav never bumps — use a dedicated token.
        const seq = (this._supportSeq = (this._supportSeq || 0) + 1);
        const ae = document.activeElement;
        const tabHadFocus = !!(ae && ae.classList && ae.classList.contains('sup-tab'));
        const v = this._view();
        // 'active' = tout non-fermé (le compteur `open` du RPC) ; 'pending' = status exact.
        // L'ancien onglet 'Ouverts' (status='open' strict) doublonnait « À répondre » et son
        // compteur (open+pending) ne correspondait pas à sa liste — remplacé par Actifs.
        const tabs = [['needs_reply', 'À répondre'], ['active', 'Actifs'], ['pending', 'En attente client'], ['closed', 'Fermés'], ['', 'Tous']];
        const countKey = { needs_reply: 'needs_reply', active: 'active', pending: 'pending_exact' }; // tab → admin_support_counts key (mêmes prédicats que la liste)
        if (this._supportFilter === 'open') this._supportFilter = 'active'; // état hérité d'une session avant le renommage
        v.innerHTML = `<div class="crm-page">
            <h1 class="crm-h1">🎫 Support</h1>
            <p class="crm-sub">Tickets clients — chaque message client envoie un email à support@norva.tv ; répondre ici trace le fil ET email le client.</p>
            <section id="sup-kpis" class="sup-kpis"><div class="ssub">Chargement…</div></section>
            <div class="support-tabs" role="tablist" aria-label="Filtrer les tickets">${tabs.map(t => {
                const sel = t[0] === this._supportFilter;
                const ck = countKey[t[0]];
                return `<button class="sup-tab" role="tab" aria-selected="${sel ? 'true' : 'false'}" tabindex="${sel ? '0' : '-1'}" data-filter="${t[0]}">${t[1]}${ck ? `<span class="tab-n" id="sup-count-${ck}">·</span>` : ''}</button>`;
            }).join('')}
            </div>
            <input class="sup-search" id="sup-search" type="search" placeholder="Rechercher : client, sujet, message…" autocomplete="off" value="${AdminPage.esc(this._supportSearch || '')}" aria-label="Rechercher un ticket" />
            <div id="sup-list" role="tabpanel" aria-label="Tickets — ${AdminPage.esc(this._supportFilter || 'tous')}"><div class="ssub">Chargement…</div></div>
            <div class="users-pager" id="sup-pager" style="display:none"><button id="sup-prev">← Précédents</button><span id="sup-range"></span><button id="sup-next">Suivants →</button></div>
        </div>`;
        // Server-side search (email / sujet / corps) — the old client-side filter only saw the
        // loaded page, so anything beyond it was silently unfindable.
        const searchEl = document.getElementById('sup-search');
        if (searchEl) searchEl.addEventListener('input', () => {
            clearTimeout(this._supSearchDeb);
            this._supSearchDeb = setTimeout(() => { this._supportSearch = searchEl.value.trim(); this._supportPage = 0; this._reloadSupportList(); }, 300);
        });
        const prev = document.getElementById('sup-prev'), next = document.getElementById('sup-next');
        if (prev) prev.addEventListener('click', () => { if (this._supportPage > 0) { this._supportPage--; this._reloadSupportList(); } });
        if (next) next.addEventListener('click', () => { this._supportPage++; this._reloadSupportList(); });
        const tabEls = Array.from(v.querySelectorAll('.sup-tab'));
        tabEls.forEach(b => b.addEventListener('click', () => this._pageSupport(b.dataset.filter)));
        // Roving focus + Arrow/Home/End on the tablist (activation follows focus).
        const tablist = v.querySelector('[role="tablist"]');
        if (tablist) tablist.addEventListener('keydown', (e) => {
            const cur = tabEls.indexOf(document.activeElement);
            if (cur < 0) return;
            let next = null;
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (cur + 1) % tabEls.length;
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (cur - 1 + tabEls.length) % tabEls.length;
            else if (e.key === 'Home') next = 0;
            else if (e.key === 'End') next = tabEls.length - 1;
            if (next === null) return;
            e.preventDefault();
            this._pageSupport(tabEls[next].dataset.filter);
        });
        // The innerHTML rebuild destroys the focused tab button — put focus back on the active tab.
        if (tabHadFocus) { const act = v.querySelector('.sup-tab[aria-selected="true"]'); if (act) act.focus(); }
        this._dressHeader();   // tabs call this method directly (not via _navigate) — re-dress the header
        this._refreshSupportBadge();
        this._loadSupportKpis();
        if (filter !== undefined) this._supportPage = 0; // tab switch resets pagination
        await this._reloadSupportList(seq);
        // Continuous refresh: a new ticket / client reply now shows up without re-navigating.
        // The interval self-guards on route + visibility (a stale one just no-ops), and is
        // cleared/recreated on each page entry so they never stack.
        clearInterval(this._supportPoll);
        this._supportPoll = setInterval(() => {
            if (this._route !== 'support' || document.visibilityState !== 'visible') return;
            this._refreshSupportBadge(); this._loadSupportKpis(); this._reloadSupportList();
        }, 60000);
    }

    // Fetch + render the current support page (filter × search × pagination). `seq` lets the
    // caller thread its supersede token; standalone calls (pager, search, poll) mint their own.
    async _reloadSupportList(seq) {
        if (seq === undefined) seq = (this._supportSeq = (this._supportSeq || 0) + 1);
        const PER = 50;
        const page = this._supportPage || 0;
        try {
            const res = await this._rpc('admin_support_list', {
                p_status: this._supportFilter || null, p_limit: PER, p_offset: page * PER,
                p_search: this._supportSearch || null,
            });
            if (seq !== this._supportSeq) return; // a newer tab switch / search superseded this fetch
            this._supportRows = (res && res.rows) || [];
            this._supportTotal = Number(res && res.total) || 0;
            this._renderSupportList(this._supportRows);
            // Pager: only shown when there is more than one page — total was previously ignored
            // and everything beyond a hard 100-cap was silently invisible.
            const pager = document.getElementById('sup-pager');
            if (pager) {
                const from = this._supportTotal ? page * PER + 1 : 0;
                const to = Math.min((page + 1) * PER, this._supportTotal);
                pager.style.display = this._supportTotal > PER ? 'flex' : 'none';
                const range = document.getElementById('sup-range');
                if (range) range.textContent = `${from}–${to} sur ${this._supportTotal}`;
                const prev = document.getElementById('sup-prev'), next = document.getElementById('sup-next');
                if (prev) prev.disabled = page === 0;
                if (next) next.disabled = to >= this._supportTotal;
            }
        } catch (e) {
            if (seq !== this._supportSeq) return;
            const el = document.getElementById('sup-list');
            if (el) el.innerHTML = `<div class="admin-err" role="alert">Erreur : ${AdminPage.esc(e.message)}</div>`;
        }
    }

    _renderSupportList(rows) {
        const el = document.getElementById('sup-list');
        if (!el) return;
        rows = Array.isArray(rows) ? rows : [];
        // Search happens server-side now (admin_support_list p_search) — rows arrive filtered.
        if (!rows.length) {
            el.innerHTML = this._supportSearch
                ? `<div class="card"><span class="badge gray">∅</span> Aucun ticket ne correspond à « ${AdminPage.esc(this._supportSearch)} ».</div>`
                : '<div class="card"><span class="badge green">✓</span> Aucun ticket dans cette vue.</div>';
            return;
        }
        const now = Date.now(), H = 3600e3;
        const ageH = (t) => (now - new Date(t.last_message_at).getTime()) / H;
        const awaiting = (t) => t.status !== 'closed' && t.last_from === 'user';
        const sla = (t) => { if (!awaiting(t)) return ''; const a = ageH(t); return a >= 48 ? '<span class="sla-chip red">&gt; 48 h</span>' : a >= 24 ? '<span class="sla-chip amber">&gt; 24 h</span>' : ''; };
        const rowCls = (t) => { if (!awaiting(t)) return ''; const a = ageH(t); return a >= 48 ? 'urgent' : a >= 24 ? 'warn' : ''; };
        const chip = (t) => t.status === 'closed' ? '<span class="badge gray">fermé</span>'
            : (t.last_from === 'user' ? '<span class="badge red">à répondre</span>' : '<span class="badge green">répondu</span>');
        // Priority chip only when it carries signal (non-normal) — the column existed in the
        // schema but was never surfaced anywhere in the UI.
        const prio = (t) => t.priority === 'high' ? '<span class="badge red" title="Priorité haute">⬆ haute</span>'
            : t.priority === 'low' ? '<span class="badge gray" title="Priorité basse">⬇ basse</span>' : '';
        el.innerHTML = `<div class="inbox">` + rows.map(t => `
            <div class="inbox-row ${rowCls(t)}" data-ticket-id="${AdminPage.esc(t.id)}" role="button" tabindex="0" aria-label="Ouvrir le ticket : ${AdminPage.esc(t.subject)}" title="Ouvrir le ticket">
                <div class="inbox-st">${chip(t)}${prio(t)}${sla(t)}</div>
                <div class="inbox-main">
                    <div class="inbox-subj">${AdminPage.esc(t.subject || '(sans sujet)')}</div>
                    <div class="inbox-prev">${AdminPage.esc(t.last_body || '')}</div>
                    <div class="inbox-cli">👤 ${AdminPage.esc(t.email || t.user_id || '—')}</div>
                </div>
                <div class="inbox-meta">
                    <div class="inbox-age">${AdminPage.esc(AdminPage.timeAgo(t.last_message_at))}</div>
                    <div class="inbox-msgs">${AdminPage.n(t.msg_count)} msg · ${t.last_from === 'user' ? 'client' : 'nous'}</div>
                </div>
            </div>`).join('') + `</div>`;
        // Keyboard activation comes from the root delegated keydown (Enter/Space → click on
        // [data-ticket-id]) — a per-row keydown here would double-fire the navigation.
        el.querySelectorAll('.inbox-row[data-ticket-id]').forEach(r => {
            r.addEventListener('click', () => this._navigate('ticket:' + r.dataset.ticketId));
        });
    }

    // ── Page: single ticket (thread + reply + status) ──
    async _pageTicket(ticketId, opts) {
        this._setCrumb('Support › ticket');
        const nav = this._nav;
        const v = this._view();
        v.innerHTML = `<div class="crm-page"><div id="ticket-body">
            <button class="crm-back" data-back="support">Retour aux tickets</button>
            <div class="ssub" style="margin-top:10px">Chargement…</div>
        </div></div>`;
        const back = v.querySelector('[data-back]');
        if (back) back.addEventListener('click', (e) => { e.stopPropagation(); this._navigate(this._ticketReturn || 'support'); });
        try {
            const d = await this._rpc('admin_support_ticket', { p_id: ticketId });
            if (this._nav !== nav) return; // navigated away while the ticket loaded — don't paint stale
            this._renderTicket(d || {}, opts);
        } catch (e) {
            if (this._nav !== nav) return;
            const b = document.getElementById('ticket-body');
            if (b) b.innerHTML = `<div class="admin-err" role="alert">Erreur : ${AdminPage.esc(e.message)}</div>`;
        }
    }

    _renderTicket(d, opts) {
        const body = document.getElementById('ticket-body');
        if (!body) return;
        // Unknown id → the RPC returns {ticket:null} without raising. Rendering an actionable
        // ghost shell here (empty subject, live reply box, Close button) sent replies with an
        // empty ticket_id → cryptic 404. Hard-stop on a real error state instead.
        if (!d || !d.ticket || !d.ticket.id) {
            body.innerHTML = `<button class="crm-back" data-back="support">Retour aux tickets</button>
                <div class="admin-err" role="alert" style="margin-top:12px">Ticket introuvable — il a peut-être été supprimé.</div>`;
            const bk = body.querySelector('[data-back]');
            if (bk) bk.addEventListener('click', () => this._navigate(this._ticketReturn || 'support'));
            return;
        }
        const t = d.ticket;
        const msgs = Array.isArray(d.messages) ? d.messages : [];
        this._setCrumb('Support › ' + (t.subject || 'ticket'));
        const closed = t.status === 'closed';
        const awaitingUs = !closed && t.last_from === 'user';
        const statusChip = closed ? '<span class="badge gray">fermé</span>'
            : (awaitingUs ? '<span class="badge red">à répondre</span>' : '<span class="badge green">répondu — en attente client</span>');
        const lastAgo = AdminPage.timeAgo(t.last_message_at || t.created_at);
        // Next-action banner: what does THIS ticket need now?
        const banner = closed
            ? `<div class="tk-banner gray">🔒 Ticket fermé.</div>`
            : (awaitingUs
                ? `<div class="tk-banner red">⏰ Réponse attendue de vous — le client attend depuis ${AdminPage.esc(lastAgo)}.</div>`
                : `<div class="tk-banner blue">✓ En attente du client — dernière réponse envoyée ${AdminPage.esc(lastAgo)}.</div>`);
        const initial = (e) => (String(e || '?').trim()[0] || '?').toUpperCase();
        // Class-based thread: client left, support/admin right, initials avatars.
        const thread = msgs.map(m => {
            const admin = !!m.from_admin;
            const who = admin ? (m.author_email || 'support') : (m.author_email || 'client');
            // Body sits in its own pre-wrap element with NO surrounding template whitespace,
            // otherwise the source indentation would leak into the rendered message.
            return `<div class="ticket-msg ticket-msg--${admin ? 'admin' : 'client'}"><div class="ticket-msg-h"><span class="tk-av">${admin ? '🛟' : AdminPage.esc(initial(who))}</span>${AdminPage.esc(who)} · ${AdminPage.esc(AdminPage.timeAgo(m.created_at))}</div><div class="ticket-msg-b">${AdminPage.esc(m.body)}</div></div>`;
        }).join('');
        // Quick-reply templates (replies email the client in English). The refund one is
        // deliberately in PRESENT tense ("we're processing") — sending this template does NOT
        // refund anything (the real action is the fiche's Rembourser button); the old past-tense
        // wording promised a refund that might never have been issued.
        const TEMPLATES = [
            ['💳 Paiement', "Hi,\n\nWe've looked into the payment issue on your account. "],
            ['✉️ Confirmation', "Hi,\n\nWe've just re-sent your confirmation email — please check your inbox (and spam). "],
            ['📡 Source', "Hi,\n\nAbout your source/playlist: "],
            ['↩︎ Remboursement', "Hi,\n\nWe're processing your refund — once issued it should appear on your statement within a few business days. "],
            ['❓ Infos', "Hi,\n\nCould you share a bit more detail (device, and a screenshot if possible) so we can help faster? "]
        ];
        this._ticketTemplates = TEMPLATES.map(x => x[1]);
        const filterLabel = { needs_reply: 'À répondre', open: 'Ouverts', pending: 'En attente', closed: 'Fermés', '': 'Tous' }[this._supportFilter || ''] || 'Support';
        const prioSel = `<select id="tk-priority" aria-label="Priorité du ticket" title="Priorité (visible dans la liste)" class="mini-btn" style="padding:4px 8px">
              <option value="low"${t.priority === 'low' ? ' selected' : ''}>⬇ basse</option>
              <option value="normal"${!t.priority || t.priority === 'normal' ? ' selected' : ''}>priorité normale</option>
              <option value="high"${t.priority === 'high' ? ' selected' : ''}>⬆ haute</option>
            </select>`;
        body.innerHTML = `
            <div class="tk-back-bar">
              <button class="crm-back" data-back="support">Retour · ${AdminPage.esc(this._ticketReturn && this._ticketReturn.startsWith('client:') ? 'Fiche client' : filterLabel)}</button>
              ${statusChip} ${prioSel}
            </div>
            <div class="fiche-head" style="margin-bottom:6px">
              <div><div class="fiche-title" style="font-size:18px">${AdminPage.esc(t.subject || '—')}</div>
              <div class="umeta"><a href="#" id="tk-client" style="color:#a9bcff">${AdminPage.esc(t.email || t.user_id || '')}</a>
                <span>· ouvert ${t.created_at ? AdminPage.esc(AdminPage.timeAgo(t.created_at)) : '—'}</span></div></div>
            </div>
            ${banner}
            <div class="tk-cols">
              <div>
                <div class="card" style="margin-bottom:14px"><div class="ticket-thread" role="log" aria-live="polite">${thread || '<div class="ssub">Aucun message.</div>'}</div></div>
                <div class="card">
                  <textarea id="tk-reply" class="ticket-reply" rows="3" maxlength="8000" aria-label="Réponse au client" aria-describedby="tk-count" placeholder="Répondre au client (le message part par email en anglais côté client — écris en anglais)…"></textarea>
                  <div class="field-row" style="display:flex;justify-content:space-between;align-items:baseline">
                    <div class="tk-templates">${TEMPLATES.map((tp, i) => `<button class="tk-tpl" data-tpl="${i}" title="Insérer un modèle">${AdminPage.esc(tp[0])}</button>`).join('')}</div>
                    <span class="ssub" id="tk-count" aria-live="polite" style="font-variant-numeric:tabular-nums">0 / 8000</span>
                  </div>
                  <div class="act-row" style="margin-top:8px">
                    <button class="act-btn" id="tk-send" style="background:#5b7cfa;border-color:#5b7cfa" title="Ctrl+Entrée">📤 Envoyer la réponse</button>
                    ${!closed ? '<button class="act-btn act-danger" id="tk-close">✔ Fermer le ticket</button>' : '<button class="act-btn act-unsuspend" id="tk-reopen">↺ Rouvrir</button>'}
                  </div>
                  <div class="ssub" style="margin-top:8px">Envoyer une réponse passe le ticket « en attente client » et lui envoie un email. Ctrl+Entrée pour envoyer.</div>
                </div>
              </div>
              <div class="card tk-ctx" id="tk-ctx">
                <h2 style="margin:0 0 12px">👤 Contexte client</h2>
                <div class="kv-row"><span class="kv-l">Email</span><span class="kv-v">${AdminPage.esc(t.email || '—')}</span></div>
                <div id="tk-ctx-billing"><div class="ssub" style="margin-top:8px">Chargement du contexte…</div></div>
                ${t.user_id ? `<button class="act-btn" id="tk-open-fiche" style="margin-top:14px;width:100%">Ouvrir la fiche 360° →</button>` : ''}
              </div>
            </div>`;
        const back = body.querySelector('[data-back]');
        if (back) back.addEventListener('click', (e) => { e.stopPropagation(); this._navigate(this._ticketReturn || 'support'); });
        const openFiche = document.getElementById('tk-open-fiche');
        if (openFiche && t.user_id) openFiche.addEventListener('click', () => this._navigate('client:' + t.user_id));
        // Templates: insert into the reply box (append, don't clobber a draft). When appending
        // to an existing draft, strip the template's "Hi," greeting — two clicks used to
        // produce "Hi,… Hi,…".
        body.querySelectorAll('.tk-tpl').forEach(b => b.addEventListener('click', () => {
            const ta = document.getElementById('tk-reply'); if (!ta) return;
            const tpl = this._ticketTemplates[Number(b.dataset.tpl)] || '';
            ta.value = ta.value ? (ta.value.replace(/\s*$/, '') + '\n\n' + tpl.replace(/^Hi,\s*/, '')) : tpl;
            ta.dispatchEvent(new Event('input'));
            ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length;
        }));
        // Reply char counter (the edge silently truncates at 8000 — maxlength + counter make
        // the limit visible) + Ctrl/Cmd+Enter to send.
        const replyTa = document.getElementById('tk-reply');
        const countEl = document.getElementById('tk-count');
        if (replyTa && countEl) {
            const upd = () => {
                countEl.textContent = replyTa.value.length + ' / 8000';
                countEl.style.color = replyTa.value.length >= 7200 ? '#fbbf24' : '';
            };
            replyTa.addEventListener('input', upd); upd();
            replyTa.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); document.getElementById('tk-send')?.click(); }
            });
        }
        // Priority selector → RPC + refresh (chip shows up in the inbox list).
        const prioEl = document.getElementById('tk-priority');
        if (prioEl) prioEl.addEventListener('change', async () => {
            prioEl.disabled = true;
            try { await this._rpc('admin_support_set_priority', { p_id: t.id, p_priority: prioEl.value }); this._toast('Priorité mise à jour.', 'ok'); }
            catch (e) { this._toast('Erreur priorité : ' + e.message, 'err'); }
            prioEl.disabled = false;
        });
        // Post-reply: land on the reply box instead of the top of a long thread.
        if (opts && opts.scrollReply && replyTa) setTimeout(() => replyTa.scrollIntoView({ block: 'center' }), 30);
        if (t.user_id) this._loadTicketContext(t.user_id);
        const client = document.getElementById('tk-client');
        if (client && t.user_id) client.addEventListener('click', (e) => { e.preventDefault(); this._navigate('client:' + t.user_id); });
        const send = document.getElementById('tk-send');
        if (send) send.addEventListener('click', async () => {
            const ta = document.getElementById('tk-reply');
            const text = ta ? ta.value.trim() : '';
            if (text.length < 2) { this._toast('Écris une réponse avant d\'envoyer.', 'err'); if (ta) ta.focus(); return; }
            send.disabled = true; send.textContent = 'Envoi…';
            try { await this._supportEdge('/admin/reply', { ticket_id: t.id, body: text }); this._toast('Réponse envoyée au client.', 'ok'); if (this._route === 'ticket:' + t.id) this._pageTicket(t.id, { scrollReply: true }); this._refreshSupportBadge(); }
            catch (e) { send.disabled = false; send.textContent = '📤 Envoyer la réponse'; this._toast('Échec de l\'envoi : ' + e.message, 'err'); }
        });
        const closeBtn = document.getElementById('tk-close');
        if (closeBtn) closeBtn.addEventListener('click', async () => {
            if (!await this._confirm('Fermer ce ticket ? Le client peut le rouvrir en répondant.', { okLabel: 'Fermer le ticket' })) return;
            closeBtn.disabled = true; closeBtn.textContent = '…';
            try { await this._supportEdge('/admin/status', { ticket_id: t.id, status: 'closed' }); if (this._route === 'ticket:' + t.id) this._pageTicket(t.id); this._refreshSupportBadge(); this._toast('Ticket fermé.', 'ok'); }
            catch (e) { closeBtn.disabled = false; closeBtn.textContent = '✔ Fermer le ticket'; this._toast('Erreur : ' + e.message, 'err'); }
        });
        const reopen = document.getElementById('tk-reopen');
        if (reopen) reopen.addEventListener('click', async () => {
            reopen.disabled = true; reopen.textContent = '…';
            try { await this._supportEdge('/admin/status', { ticket_id: t.id, status: 'open' }); this._toast('Ticket rouvert.', 'ok'); if (this._route === 'ticket:' + t.id) this._pageTicket(t.id); this._refreshSupportBadge(); }
            catch (e) { reopen.disabled = false; reopen.textContent = '↺ Rouvrir'; this._toast('Erreur : ' + e.message, 'err'); }
        });
    }

    // Ticket client-context sidebar: the payment state support needs without leaving the thread.
    async _loadTicketContext(userId) {
        const el = document.getElementById('tk-ctx-billing');
        if (!el) return;
        try {
            const b = await this._rpc('admin_user_billing', { p_user_id: userId }) || {};
            if (!el.isConnected) return; // ticket re-rendered / navigated away
            const p = b.projection || null, m = b.mapping || null;
            const subMap = { active: ['Actif payant', 'green'], trialing: ['En essai', 'blue'], past_due: ['Échec paiement', 'red'], grace: ['Échec paiement', 'red'], cancelled_at_period_end: ['Annulation prévue', 'amber'], expired: ['Expiré', 'gray'] };
            const sm = p ? (subMap[p.status] || [p.status || '—', 'gray']) : ['Gratuit', 'gray'];
            const row = (l, v) => `<div class="kv-row"><span class="kv-l">${l}</span><span class="kv-v">${v}</span></div>`;
            let html = row('Abonnement', `<span class="badge ${sm[1]}">${AdminPage.esc(sm[0])}</span>`);
            if (b.is_internal) html += row('Compte', '<span class="badge amber">interne</span>');
            if (m && m.plan) html += row('Plan', `${AdminPage.esc(m.plan)} · ${AdminPage.esc(m.period || '—')}`);
            if (p && p.country_code) html += row('Pays', AdminPage.flag(p.country_code));
            if (m && m.card_last4) html += row('Carte', `•••• ${AdminPage.esc(m.card_last4)}`);
            if (p && Number(p.dunning_stage) > 0) html += row('Dunning', `<span class="badge red">relance ${AdminPage.esc(String(p.dunning_stage))}/3</span>`);
            el.innerHTML = html;
        } catch (_) {
            if (el.isConnected) el.innerHTML = '<div class="ssub" style="margin-top:8px">Contexte client indisponible.</div>';
        }
    }

    async _supportEdge(path, bodyObj) {
        const res = await fetch(`${this._sbUrl()}/functions/v1/norva-support${path}`, {
            method: 'POST',
            headers: { apikey: this._sbKey(), Authorization: `Bearer ${this._token()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyObj || {})
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || String(res.status));
        return data;
    }

    // ── Page: Clients (list) ──
    _pageClients() {
        this._setCrumb('Clients');
        const v = this._view();
        v.innerHTML = `<div class="crm-page">
            <h1 class="crm-h1">👥 Clients</h1>
            <p class="crm-sub">Liste paginée — recherche, tri, clic pour la fiche 360°. Agrégation bornée par page (scalable).</p>
            <section id="admin-clients-kpis" class="admin-cards"><div class="ssub">Chargement…</div></section>
            <div id="admin-clients-charts" class="chart-row"></div>
            <div class="qv-row" id="admin-users-qv" role="tablist" aria-label="Vues rapides">
              ${[['', 'Tous'], ['active', 'Actifs payants'], ['trialing', 'Nouveaux essais'], ['past_due', 'Échec paiement'], ['cancel_pending', 'Annulation prévue'], ['expired', 'Expirés']]
                .map(([val, lbl]) => `<button class="qv-chip" data-billing="${val}" role="tab">${lbl}</button>`).join('')}
            </div>
            <div class="filter-bar">
              <div class="fb-h">🔎 Filtres & recherche</div>
              <div class="users-controls">
                <input id="admin-users-search" type="search" placeholder="Rechercher un email ou un UUID complet…" autocomplete="off" value="${AdminPage.esc(this._users.search)}" title="La recherche par identifiant exige l'UUID complet (l'email peut être partiel)" />
                <select id="admin-users-sort">
                  <option value="created_desc">Plus récents</option>
                  <option value="created_asc">Plus anciens</option>
                  <option value="active_desc">Dernière activité</option>
                  <option value="email_asc">Email A→Z</option>
                </select>
                <select id="admin-users-billing">
                  <option value="">Tous les abonnements</option>
                  <option value="trialing">En essai</option>
                  <option value="active">Actifs payants</option>
                  <option value="past_due">Échec paiement</option>
                  <option value="cancel_pending">Annulation prévue</option>
                  <option value="expired">Expirés</option>
                  <option value="free">Sans abonnement</option>
                </select>
                <select id="admin-users-country" title="Pays de paiement (storefront Play ou pays d'émission de la carte)"><option value="">Tous les pays de paiement</option><option value="??">Pays paiement inconnu</option></select>
                <select id="admin-users-tag"><option value="">Tous les segments</option></select>
                <button id="admin-users-csv" title="Exporter la liste filtrée en CSV (max 10 000 lignes)">⬇ Exporter CSV</button>
              </div>
            </div>
            <div id="admin-users-bulk"></div>
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
        const billSel = document.getElementById('admin-users-billing');
        if (billSel) {
            billSel.value = this._users.billing || '';
            billSel.addEventListener('change', () => { this._users.billing = billSel.value; this._users.page = 0; this._loadUsers(); this._syncQuickViews(); });
        }
        // Quick-view chips: one click = a business filter (mirrors the billing dropdown).
        document.querySelectorAll('#admin-users-qv .qv-chip').forEach(chip => chip.addEventListener('click', () => {
            this._users.billing = chip.dataset.billing || '';
            this._users.page = 0;
            const bs = document.getElementById('admin-users-billing'); if (bs) bs.value = this._users.billing;
            this._loadUsers(); this._syncQuickViews();
        }));
        this._syncQuickViews();
        const ctrySel = document.getElementById('admin-users-country');
        if (ctrySel) {
            this._fillCountryOptions(ctrySel);
            ctrySel.addEventListener('change', () => { this._users.country = ctrySel.value; this._users.page = 0; this._loadUsers(); });
        }
        const tagSel = document.getElementById('admin-users-tag');
        if (tagSel) {
            this._fillTagOptions(tagSel);
            tagSel.addEventListener('change', () => { this._users.tagId = tagSel.value; this._users.page = 0; this._loadUsers(); });
        }
        const csvBtn = document.getElementById('admin-users-csv');
        if (csvBtn) csvBtn.addEventListener('click', () => this._exportUsersCsv(csvBtn));
        const prev = document.getElementById('admin-users-prev');
        if (prev) prev.addEventListener('click', () => { if (this._users.page > 0) { this._users.page -= 1; this._loadUsers(); } });
        const next = document.getElementById('admin-users-next');
        if (next) next.addEventListener('click', () => {
            const s = this._users; if ((s.page + 1) * s.limit < s.total) { s.page += 1; this._loadUsers(); }
        });
        this._loadUsers();
        this._loadClientCharts();
    }

    // Clients insights: KPI cards + real daily-active area + connected/inactive donut.
    async _loadClientCharts() {
        const el = document.getElementById('admin-clients-charts');
        if (!el) return;
        const seq = (this._nav || 0);
        try {
            const [a, ov, sparksR] = await Promise.all([
                this._rpc('admin_activity_series', { p_days: 14 }),
                this._rpc('admin_overview').catch(() => null),
                this._rpc('admin_metric_sparks', { p_days: 14 }).catch(() => null)
            ]);
            if ((this._nav || 0) !== seq || this._route !== 'clients') return;
            const n = AdminPage.n;
            // KPI cards (icon + sparkline) — same treatment as the Cockpit.
            const kel = document.getElementById('admin-clients-kpis');
            if (kel && ov) {
                const S = (sparksR && sparksR.series) || {};
                const kc = (v, l, cls, key, icon) => AdminPage.kpiCard(v, l, cls, icon, key && Array.isArray(S[key]) ? AdminPage.spark(S[key], cls) : '');
                kel.innerHTML = [
                    kc(n(ov.users_total), 'Utilisateurs', ov.users_active_7d ? 'ok' : '', 'users_total', '👥'),
                    kc(n(ov.users_active_24h), 'Connectés 24 h', '', 'users_active_24h', '🕐'),
                    kc(n(ov.users_active_7d), 'Connectés 7 j', '', 'users_active_7d', '🗓️'),
                    kc(n(ov.users_watching_7d), 'Regardent 7 j', Number(ov.users_watching_7d) > 0 ? 'ok' : '', 'users_watching_7d', '👁️'),
                    kc(n(ov.users_new_7d), 'Nouveaux 7 j', Number(ov.users_new_7d) > 0 ? 'ok' : '', 'users_new_7d', '➕'),
                    kc(n(ov.users_new_30d), 'Nouveaux 30 j', '', 'users_new_30d', '📅')
                ].join('');
            } else if (kel) { kel.innerHTML = ''; }
            // Header status line: total · actifs 7 j · essais · échec paiement (real overview data).
            const tx = document.querySelector('#page-admin .crm-head-tx');
            if (tx && ov) {
                let meta = tx.querySelector('.crm-head-meta');
                if (!meta) { meta = document.createElement('div'); meta.className = 'crm-head-meta'; tx.appendChild(meta); }
                const pastDue = Number(ov.billing_past_due) || 0;
                meta.innerHTML =
                    `<span class="crm-hpill"><b>${n(ov.users_total)}</b> clients</span>` +
                    `<span class="crm-hpill"><b>${n(ov.users_active_7d)}</b> actifs 7 j</span>` +
                    `<span class="crm-hpill"><b>${n(ov.billing_trialing)}</b> en essai</span>` +
                    `<span class="crm-hpill ${pastDue > 0 ? 'bad' : ''}"><b>${n(pastDue)}</b> échec(s) paiement</span>`;
            }
            const ud = Array.isArray(a.users_daily) ? a.users_daily : [];
            const ld = Array.isArray(a.logins_daily) ? a.logins_daily : [];
            // Primary line = real login events (connexions); dashed overlay = watch activity.
            const pts = (ld.length ? ld : ud).map((d, i) => ({ label: (d.day || '').slice(5).replace('-', '/'), value: ld.length ? d.logins : d.active }));
            const overlay = ud.map(d => Number(d.active) || 0);
            const sp = a.users_split || { total: 0, connected: 0, inactive: 0 };
            const total = Number(sp.total) || 0, conn = Number(sp.connected) || 0, inact = Number(sp.inactive) || 0;
            const pct = v => total > 0 ? Math.round(100 * v / total) + ' %' : '—';
            el.innerHTML = `
                <div class="chart-panel">
                    <h2>Connexions & activité</h2><p class="chsub">Connexions (events de login) vs activité visionnage — 14 derniers jours</p>
                    ${AdminPage.area(pts, 'cli', overlay)}
                    <div class="ssub" style="margin-top:6px"><span style="display:inline-block;width:14px;height:3px;border-radius:2px;background:#8098ff;vertical-align:middle"></span> connexions&nbsp;&nbsp;<span style="display:inline-block;width:14px;height:0;border-top:2px dashed #8a93a6;vertical-align:middle"></span> visionnage</div>
                </div>
                <div class="chart-panel">
                    <h2>Répartition des utilisateurs</h2><p class="chsub">Statut des comptes (connexion ≤ 7 j)</p>
                    <div class="donut-wrap">
                        ${AdminPage.donut([{ value: conn, color: '#34d399' }, { value: inact, color: '#3a4356' }], total, 'Total')}
                        <div class="chart-legend">
                            <div class="lg"><span class="dotc" style="background:#34d399"></span>Connectés <b>${n(conn)}</b><span class="pct">${pct(conn)}</span></div>
                            <div class="lg"><span class="dotc" style="background:#3a4356"></span>Inactifs <b>${n(inact)}</b><span class="pct">${pct(inact)}</span></div>
                        </div>
                    </div>
                </div>`;
        } catch (_) {
            el.innerHTML = ''; // charts are a non-critical enhancement — never block the list
        }
    }

    async _loadUsers() {
        const el = document.getElementById('admin-users');
        const range = document.getElementById('admin-users-range');
        if (!el) return;
        const s = this._users;
        // Stale-response guard: fast typing / pager clicks fire overlapping fetches; only the
        // newest may paint. Also freeze the pager while a page is in flight.
        const seq = (this._usersSeq = (this._usersSeq || 0) + 1);
        const prev = document.getElementById('admin-users-prev');
        const next = document.getElementById('admin-users-next');
        if (prev) prev.disabled = true;
        if (next) next.disabled = true;
        if (range) range.textContent = '…';
        if (!el.children.length || el.querySelector('.admin-err')) el.innerHTML = '<div class="ssub">Chargement…</div>';
        try {
            let res;
            try {
                res = await this._rpc('admin_users_page', {
                    p_limit: s.limit, p_offset: s.page * s.limit, p_search: s.search || null,
                    p_sort: s.sort, p_tag_id: s.tagId || null, p_billing_status: s.billing || null,
                    p_country: s.country || null
                });
            } catch (e) {
                // PGRST202 = la DB n'a pas encore admin_users_page(p_country) — migration
                // 20260717120000 pas appliquée, ou cache de schéma PostgREST à recharger
                // (NOTIFY pgrst, 'reload schema'). Dégrader : liste sans le filtre pays.
                if (!String((e && e.message) || '').includes('PGRST202')) throw e;
                if (s.country) { s.country = ''; const cs = document.getElementById('admin-users-country'); if (cs) cs.value = ''; }
                res = await this._rpc('admin_users_page', {
                    p_limit: s.limit, p_offset: s.page * s.limit, p_search: s.search || null,
                    p_sort: s.sort, p_tag_id: s.tagId || null, p_billing_status: s.billing || null
                });
            }
            if (seq !== this._usersSeq) return; // superseded by a newer load
            const rows = (res && Array.isArray(res.rows)) ? res.rows : [];
            let attributionError = null;
            if (rows.length) {
                let attribution = [];
                try {
                    attribution = await this._rpc('admin_signup_attribution_batch', {
                        p_user_ids: rows.map(row => row.user_id)
                    });
                } catch (error) {
                    attributionError = error;
                }
                if (seq !== this._usersSeq) return;
                const byUser = new Map((Array.isArray(attribution) ? attribution : [])
                    .map(row => [row.user_id, row]));
                rows.forEach(row => {
                    row.signup_attribution = attributionError
                        ? { capture_stage: 'unavailable' }
                        : (byUser.get(row.user_id) || null);
                });
            }
            s.total = Number(res && res.total) || 0;
            if (res && Array.isArray(res.all_tags)) { this._allTags = res.all_tags; this._fillTagOptions(document.getElementById('admin-users-tag')); }
            if (res && Array.isArray(res.countries)) { this._countries = res.countries; this._fillCountryOptions(document.getElementById('admin-users-country')); }
            this._renderUsers(rows, attributionError);
            document.getElementById('admin-users-attribution-retry')?.addEventListener('click', () => this._loadUsers());
            this._renderBulkBar();
            const from = s.total === 0 ? 0 : s.page * s.limit + 1;
            const to = Math.min(s.total, (s.page + 1) * s.limit);
            if (range) range.textContent = `${AdminPage.n(from)}–${AdminPage.n(to)} sur ${AdminPage.n(s.total)}`;
            const prev2 = document.getElementById('admin-users-prev');
            const next2 = document.getElementById('admin-users-next');
            if (prev2) prev2.disabled = s.page <= 0;
            if (next2) next2.disabled = to >= s.total;
        } catch (e) {
            if (seq !== this._usersSeq) return;
            if (range) range.textContent = '';
            el.innerHTML = `<div class="admin-err" role="alert">Erreur : ${AdminPage.esc(e.message)}</div>`;
        }
    }

    _fillTagOptions(sel) {
        if (!sel) return;
        const cur = this._users.tagId || '';
        sel.innerHTML = '<option value="">Tous les segments</option>' +
            this._allTags.map(t => `<option value="${AdminPage.esc(t.id)}">${AdminPage.esc(t.label)}</option>`).join('');
        sel.value = cur;
    }

    // Country filter options: known countries (facet from admin_users_page) + the two
    // fixed entries. Emoji flags render fine in <option> on every modern browser.
    _fillCountryOptions(sel) {
        if (!sel) return;
        const cur = this._users.country || '';
        const list = Array.isArray(this._countries) ? this._countries : [];
        const flagTxt = (cc) => {
            const s = String(cc || '').toUpperCase();
            return /^[A-Z]{2}$/.test(s) ? String.fromCodePoint(...[...s].map(c => 0x1F1A5 + c.charCodeAt(0))) + ' ' + s : s;
        };
        sel.innerHTML = '<option value="">Tous les pays de paiement</option>' +
            list.map(c => `<option value="${AdminPage.esc(c.country_code)}">${AdminPage.esc(flagTxt(c.country_code))} (${AdminPage.n(c.n)})</option>`).join('') +
            '<option value="??">Pays paiement inconnu</option>';
        sel.value = cur;
        // A stale saved filter (country no longer present) must not silently stick.
        if (sel.value !== cur) { sel.value = ''; this._users.country = ''; }
    }

    // Highlight the quick-view chip matching the active billing filter.
    _syncQuickViews() {
        const cur = this._users.billing || '';
        document.querySelectorAll('#admin-users-qv .qv-chip').forEach(c =>
            c.classList.toggle('active', (c.dataset.billing || '') === cur));
    }

    _renderUsers(rows, attributionError = null) {
        const el = document.getElementById('admin-users');
        if (!el) return;
        if (!rows.length) { el.innerHTML = '<div class="ssub">Aucun utilisateur.</div>'; return; }
        const head = `<tr><th>Email</th><th>Abonnement</th><th>Pays paiement</th><th>Inscription</th><th>Rôle</th><th>Segments</th><th class="num">Sources</th><th>Inscrit</th><th>Dernière activité</th><th>Email vérifié</th></tr>`;
        const day = (d) => d ? new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
        const body = rows.map(r => {
            const role = r.role === 'admin' ? '<span class="badge amber">admin</span>' : '<span class="badge gray">user</span>';
            const driver = r.is_driver ? ' <span class="badge blue" title="Compte pilote d\'enrichissement">pilote</span>' : '';
            const internal = r.is_internal ? ' <span class="badge amber" title="Compte interne — exclu des stats finance">interne</span>' : '';
            const banned = r.banned ? ' <span class="badge red" title="Compte suspendu">suspendu</span>' : '';
            const conf = r.email_confirmed ? '<span class="badge green">✓</span>' : '<span class="badge red">non</span>';
            const tags = (Array.isArray(r.tags) ? r.tags : [])
                .map(t => `<span class="badge ${AdminPage.tagColor(t.color)}">${AdminPage.esc(t.label)}</span>`).join(' ') || '<span class="ssub">—</span>';
            const last = r.last_sign_in_at
                ? `<span title="${AdminPage.esc(new Date(r.last_sign_in_at).toLocaleString('fr-FR'))}">${AdminPage.esc(AdminPage.timeAgo(r.last_sign_in_at))}</span>`
                : '<span class="badge gray">jamais</span>';
            const ccTip = r.country_source === 'card' ? 'Pays d’émission de la carte (Revolut)' : r.country_source === 'store' ? 'Pays du storefront (Play/App Store)' : '';
            return `<tr class="user-row" data-user-id="${AdminPage.esc(r.user_id)}" data-email="${AdminPage.esc(r.email || '')}" tabindex="0" aria-label="Voir la fiche de ${AdminPage.esc(r.email || r.user_id)}" title="Voir la fiche">
                <td>${AdminPage.esc(r.email || '—')}${driver}${internal}${banned}</td>
                <td>${AdminPage.billingBadge(r.billing_status, r.plan_code)}</td>
                <td${ccTip ? ` title="${AdminPage.esc(ccTip)}"` : ''}>${AdminPage.flag(r.country_code)}</td>
                <td>${AdminPage.signupOriginHtml(r.signup_attribution)}</td>
                <td>${role}</td>
                <td>${tags}</td>
                <td class="num">${AdminPage.n(r.sources_count)}</td>
                <td>${AdminPage.esc(day(r.created_at))}</td>
                <td>${last}</td>
                <td>${conf}</td>
            </tr>`;
        }).join('');
        const warning = attributionError
            ? `<div class="admin-err" role="alert">Les données d’inscription sont momentanément indisponibles. Les autres colonnes restent fiables. <button class="mini-btn" id="admin-users-attribution-retry" type="button">Réessayer</button></div>`
            : '';
        el.innerHTML = `${warning}<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
    }

    // Bulk segment actions — only shown when a segment filter is active. Applies to EVERY client
    // bearing the tag (not just the current page); the RPC logs one timeline event per client.
    _renderBulkBar() {
        const el = document.getElementById('admin-users-bulk');
        if (!el) return;
        const tagId = this._users.tagId;
        if (!tagId) { el.innerHTML = ''; return; }
        const tag = this._allTags.find(t => t.id === tagId);
        const others = this._allTags.filter(t => t.id !== tagId);
        const opts = others.map(t => `<option value="${AdminPage.esc(t.id)}">${AdminPage.esc(t.label)}</option>`).join('');
        // Note: no count here on purpose. The bulk RPC acts on EVERY client bearing the tag,
        // whereas _users.total reflects the tag ∩ search ∩ billing filter — showing it would
        // understate the blast radius. The RPC reports the real count once it runs.
        el.innerHTML = `<div class="bulk-bar">
            <span>Actions sur <b>tous les clients</b> portant le segment <span class="badge ${AdminPage.tagColor(tag && tag.color)}">${AdminPage.esc(tag ? tag.label : '?')}</span> :</span>
            ${others.length ? `<select id="bulk-tag-select">${opts}</select><button id="bulk-apply-btn">＋ appliquer à tous</button>` : ''}
            <button id="bulk-remove-btn" class="danger">− retirer ce tag de tous</button>
        </div>`;
    }

    async _bulkTag(action) {
        const tagId = this._users.tagId;
        if (!tagId) return;
        const tag = this._allTags.find(t => t.id === tagId);
        const label = tag ? tag.label : '?';
        let other = null;
        if (action === 'apply') {
            const sel = document.getElementById('bulk-tag-select');
            other = sel ? sel.value : null;
            if (!other) return;
            const otherLabel = (this._allTags.find(t => t.id === other) || {}).label || '?';
            if (!await this._confirm(`Appliquer le tag « ${otherLabel} » à TOUS les clients portant le segment « ${label} » ?`)) return;
        } else {
            if (!await this._confirm(`Retirer le tag « ${label} » de TOUS les clients qui le portent ? (le tag lui-même est conservé)`, { danger: true, okLabel: 'Retirer' })) return;
        }
        try {
            const r = await this._rpc('admin_tag_bulk', { p_tag: tagId, p_action: action, p_other: other });
            this._toast(`✓ ${AdminPage.n(r && r.count)} client(s) ${action === 'apply' ? 'tagué(s)' : 'détagué(s)'}.`, 'ok');
            if (action === 'remove') { this._users.tagId = ''; const sel = document.getElementById('admin-users-tag'); if (sel) sel.value = ''; }
            this._users.page = 0;
            this._loadUsers();
        } catch (e) { this._toast('Erreur : ' + e.message, 'err'); }
    }

    // CSV export of the CURRENT filter (search + segment), up to 10k rows in one RPC call.
    async _exportUsersCsv(btn) {
        if (btn.disabled) return;
        const orig = btn.textContent;
        btn.disabled = true; btn.textContent = '…';
        try {
            let rows;
            try {
                rows = await this._rpc('admin_users_export', {
                    p_search: this._users.search || null,
                    p_tag_id: this._users.tagId || null,
                    p_billing_status: this._users.billing || null,
                    p_country: this._users.country || null
                });
            } catch (e) {
                // Même fallback pré-migration que _loadUsers (PGRST202 → sans p_country).
                if (!String((e && e.message) || '').includes('PGRST202')) throw e;
                rows = await this._rpc('admin_users_export', {
                    p_search: this._users.search || null,
                    p_tag_id: this._users.tagId || null,
                    p_billing_status: this._users.billing || null
                });
            }
            const list = Array.isArray(rows) ? rows : [];
            const attribution = list.length
                ? await this._rpc('admin_signup_attribution_batch', {
                    p_user_ids: list.map(row => row.user_id)
                })
                : [];
            const acquisitionByUser = new Map((Array.isArray(attribution) ? attribution : [])
                .map(row => [row.user_id, row]));
            list.forEach(row => { row.signup_attribution = acquisitionByUser.get(row.user_id) || null; });
            // Strict CSV: every field quoted, internal quotes doubled, CRLF lines, BOM for Excel.
            // A leading =/+/-/@ is neutralized with a single quote so Excel/Sheets can't evaluate
            // an attacker-controlled email/tag as a formula.
            const q = (v) => {
                let s = String(v == null ? '' : v);
                if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
                return `"${s.replace(/"/g, '""')}"`;
            };
            const header = ['email', 'statut_abo', 'plan', 'periode', 'montant_cents', 'pays_paiement', 'source_pays_paiement',
                'app_inscription', 'parcours_inscription', 'methode_inscription', 'pays_inscription', 'region_inscription',
                'source_localisation', 'integrite_attribution', 'etape_capture', 'role', 'suspendu', 'email_verifie',
                'inscrit', 'derniere_activite', 'sources', 'segments', 'user_id'];
            const lines = [header.map(q).join(',')].concat(list.map(r => [
                r.email, r.billing_status || 'free', r.plan_code || '', r.billing_period || '', r.amount_cents == null ? '' : r.amount_cents,
                r.country_code || '', r.country_source || '',
                r.signup_attribution?.signup_platform || '', r.signup_attribution?.signup_surface || '',
                r.signup_attribution?.signup_method || '', r.signup_attribution?.country_code || '',
                r.signup_attribution?.region_name || '', r.signup_attribution?.location_source || '',
                r.signup_attribution?.attribution_integrity || '', r.signup_attribution?.capture_stage || '',
                r.role, r.banned ? 'oui' : 'non', r.email_confirmed ? 'oui' : 'non',
                r.created_at || '', r.last_sign_in_at || '', r.sources_count, r.tags || '', r.user_id
            ].map(q).join(',')));
            const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            const d = new Date();
            a.download = `norva-clients-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.csv`;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
            btn.textContent = `✓ ${list.length}`;
            // The RPC caps at 10 000 rows — say so instead of silently truncating the export.
            const total = Number(this._users && this._users.total) || 0;
            if (total > list.length) this._toast(`Export tronqué : ${list.length} lignes sur ${total} (plafond serveur 10 000). Affine la recherche/le filtre pour le reste.`, 'err');
            setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
        } catch (e) {
            btn.textContent = '✗ erreur';
            this._toast('Export impossible : ' + e.message, 'err');
            setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
        }
    }

    // ── Page: Client detail (fiche 360°, full page) ──
    async _pageClientDetail(userId) {
        this._crmUser = userId;
        this._setCrumb('Clients › fiche');
        const v = this._view();
        v.innerHTML = `<div class="crm-page">
            <button class="crm-back">${AdminPage.routeLabel(this._ficheReturn || 'clients')}</button>
            <div id="fiche-body"><div class="ssub">Chargement…</div></div>
        </div>`;
        try {
            const d = await this._rpc('admin_user_detail', { p_user_id: userId });
            if (this._crmUser !== userId) return; // navigated to another client mid-fetch
            this._renderFiche(d);
            this._loadAcquisition(userId);   // signup app, journey and coarse edge location
            this._loadCrm(userId);         // relational panels (tags/notes/timeline), non-blocking
            this._loadBilling(userId);     // subscription & payments panel, non-blocking
            this._loadUserTickets(userId); // support tickets panel, non-blocking
        } catch (e) {
            if (this._crmUser !== userId) return;
            const b = document.getElementById('fiche-body');
            if (b) b.innerHTML = `<div class="admin-err" role="alert">Erreur : ${AdminPage.esc(e.message)}</div>`;
        }
    }

    // ── Fiche: subscription & payments panel (billing rail) ──
    // Signup acquisition is intentionally separate from billing country and the
    // user-selected catalogue region. It is coarse analytics only: Cloudflare edge
    // country/region/city, with no raw IP retained.
    async _loadAcquisition(userId) {
        const el = document.getElementById('fiche-acquisition');
        if (!el) return;
        try {
            const a = await this._rpc('admin_signup_attribution_detail', { p_user_id: userId });
            if (this._crmUser !== userId || !el.isConnected) return;
            if (!a || a.capture_stage === 'historical_backfill') {
                this._setFicheChip('fs-origin', '🧭', 'Non capturé', 'Origine inscription', 'warn');
                el.innerHTML = `<div class="ssub">Cette information n’existait pas encore au moment de cette inscription.</div>
                    <div class="acq-note">Norva ne reconstruit pas l’origine depuis un appareil utilisé plus tard et ne transforme pas la langue ou la région de catalogue en localisation.</div>`;
                return;
            }
            const pendingActive = a.capture_stage === 'pending'
                && Date.now() - new Date(a.signed_up_at || 0).getTime() <= 24 * 60 * 60 * 1000;
            if (a.capture_stage === 'pending' && !pendingActive) {
                this._setFicheChip('fs-origin', '🧭', 'Non capturé', 'Origine inscription', 'warn');
                el.innerHTML = `<div class="ssub">La fenêtre de capture s’est terminée sans contexte exploitable.</div>
                    <div class="acq-note">L’origine reste inconnue : Norva ne la reconstruit pas depuis une connexion ou un appareil utilisé plus tard.</div>`;
                return;
            }

            const platform = AdminPage.signupPlatformLabel(a.signup_platform);
            const surface = AdminPage.signupSurfaceLabel(a.signup_surface);
            const method = AdminPage.signupMethodLabel(a.signup_method);
            const location = AdminPage.signupLocationText(a);
            const row = (label, value) => `<div class="kv-row"><span class="kv-l">${AdminPage.esc(label)}</span><span class="kv-v">${value}</span></div>`;
            const platformClass = a.signup_platform === 'mobile_android' ? 'green'
                : a.signup_platform === 'web' ? 'blue' : 'gray';
            const originSummary = a.signup_platform === 'mobile_android' ? 'Android mobile'
                : a.signup_platform === 'web' ? 'Web' : 'Inconnu';
            this._setFicheChip('fs-origin', '🧭', AdminPage.esc(originSummary), 'Origine inscription',
                a.capture_stage === 'pending' ? 'warn' : 'ok');

            let html = row('App d’inscription', `<span class="badge ${platformClass}">${AdminPage.esc(platform)}</span>`);
            html += row('Parcours', `${AdminPage.esc(surface)}${a.signup_surface === 'tv_pairing' ? ' <span class="badge amber">écran compagnon</span>' : ''}`);
            html += row('Méthode', AdminPage.esc(method));
            html += row('Localisation réseau', location ? AdminPage.esc(location) : '<span class="ssub">Non disponible</span>');
            if (location) html += row('Précision', AdminPage.esc(AdminPage.signupLocationPrecision(a)));
            html += row('Fiabilité', a.attribution_integrity === 'client_handoff'
                ? '<span class="badge amber">signal analytique indicatif</span>'
                : '<span class="badge gray">non qualifiée</span>');
            if (a.captured_at) {
                html += row('Capturé le', AdminPage.esc(new Date(a.captured_at).toLocaleString('fr-FR')));
            }
            html += `<div class="acq-note">${a.location_source === 'cloudflare_edge'
                ? 'Estimation réseau approximative fournie par Cloudflare puis transmise par le client Norva. Elle n’est pas attestée comme une preuve. Aucune adresse IP brute n’est conservée ; ville et région sont masquées à 90 jours puis purgées sous 15 minutes.'
                : 'Aucune localisation réseau exploitable n’a été reçue.'}
                Ces données ne sont utilisées ni pour les droits, ni pour la facturation, ni comme preuve de résidence ou fiscale.</div>`;
            el.innerHTML = html;
        } catch (e) {
            if (this._crmUser !== userId || !el.isConnected) return;
            el.innerHTML = '<div class="ssub">Attribution d’inscription indisponible.</div>';
            this._setFicheChip('fs-origin', '🧭', '—', 'Origine inscription', 'warn');
        }
    }

    async _loadBilling(userId) {
        const el = document.getElementById('fiche-billing');
        if (!el) return;
        try {
            const b = await this._rpc('admin_user_billing', { p_user_id: userId }) || {};
            if (this._crmUser !== userId) return; // stale response for a client we've navigated away from
            this._renderBillingPanel(el, b, userId);
        } catch (e) {
            if (this._crmUser !== userId) return;
            el.innerHTML = `<div class="admin-err" role="alert">Erreur : ${AdminPage.esc(e.message)}</div>`;
            // The summary chip is only set by the successful render — resolve its "…" spinner too.
            this._setFicheChip('fs-sub', '💳', '—', 'Abonnement', 'alert');
        }
    }

    _renderBillingPanel(el, b, userId) {
        userId = userId || this._crmUser;
        const p = b.projection || null;
        const m = b.mapping || null;
        const pays = Array.isArray(b.payments) ? b.payments : [];
        const feedback = Array.isArray(b.cancel_feedback) ? b.cancel_feedback : [];
        const money = AdminPage.money, esc = AdminPage.esc;
        // Résumé-client "Abonnement" chip (payment risk surfaces red). Internal accounts get
        // their own label — a family/system VIP shown as "Actif payant" polluted the executive
        // read (it's a test/comp account, not revenue).
        const subMap = { active: ['Actif payant', 'ok'], trialing: ['En essai', 'ok'], past_due: ['Échec paiement', 'alert'], grace: ['Échec paiement', 'alert'], cancelled_at_period_end: ['Annulation prévue', 'warn'], expired: ['Expiré', 'alert'] };
        const sm = b.is_internal && p && p.status === 'active' ? ['VIP interne', '']
            : p ? (subMap[p.status] || [esc(p.status || '—'), '']) : ['Gratuit', ''];
        this._setFicheChip('fs-sub', b.is_internal ? '⭐' : '💳', sm[0], 'Abonnement', sm[1]);
        const dt = (d) => d ? new Date(d).toLocaleString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

        const row = (label, val) => `<div class="kv-row"><span class="kv-l">${label}</span><span class="kv-v">${val}</span></div>`;
        // Internal-account state + toggle: internal accounts (owner/family/tests) are EXCLUDED from
        // every finance metric and get permanent VIP access.
        const internalRow = row('Compte interne',
            (b.is_internal ? '<span class="badge amber">interne — exclu des stats</span> ' : '<span class="ssub">non</span> ') +
            `<button class="mini-btn" id="fiche-internal-toggle" data-on="${b.is_internal ? 'false' : 'true'}">${b.is_internal ? 'retirer' : '⭐ marquer interne'}</button>`);
        function wireInternalToggle(self) {
            const btn = document.getElementById('fiche-internal-toggle');
            if (!btn) return;
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                try { await self._rpc('admin_internal_toggle', { p_user_id: userId, p_on: btn.dataset.on === 'true' }); self._loadBilling(userId); }
                catch (e) { btn.disabled = false; self._toast('Erreur : ' + e.message, 'err'); }
            });
        }

        if (!p && !m && !pays.length) {
            el.innerHTML = internalRow + '<div class="ssub" style="margin-top:8px">Aucun abonnement ni paiement — compte gratuit.</div>';
            wireInternalToggle(this);
            return;
        }

        let details = internalRow;
        if (p) {
            details += row('Statut', AdminPage.billingBadge(p.status, p.plan_code) + (p.provider ? ` ${AdminPage.railBadge(p.provider)}` : ''));
            // La provenance porte le niveau de confiance : storefront (fiable) vs pays
            // d'émission de la carte (proxy ~95 % — expats/néobanques possibles).
            if (p.country_code) {
                const src = p.country_source === 'card' ? 'pays d\'émission carte' : p.country_source === 'store' ? 'storefront Play/App Store' : '';
                details += row('Pays', `${AdminPage.flag(p.country_code)}${src ? ` <span class="pacct">· ${src}</span>` : ''}`);
            }
            if (m && m.plan) details += row('Plan facturé', `${esc(m.plan)} · ${esc(m.period || '—')} · ${money(m.amount_cents)}`);
            // Mobile rails (Play/Apple) have no web-rail mapping — the recurring price/cadence lives
            // on the projection (stamped by the RevenueCat webhook).
            else if (p.mrr_cents != null) details += row('Plan facturé', `${esc(p.plan_code || 'plus')} · ${esc(p.bill_period || '—')} · ${money(p.mrr_cents)} <span class="pacct">(store)</span>`);
            if (p.trial_ends_at) details += row(new Date(p.trial_ends_at) > new Date() ? 'Essai jusqu\'au' : 'Essai terminé le', esc(dt(p.trial_ends_at)));
            if (p.current_period_end) details += row('Fin de période', esc(dt(p.current_period_end)));
            if (m && m.card_last4) details += row('Carte', `${m.card_brand ? esc(m.card_brand) + ' ' : ''}•••• ${esc(m.card_last4)}${m.card_exp ? ' · exp ' + esc(m.card_exp) : ''}`);
            if (Number(p.dunning_stage) > 0) details += row('Dunning', `<span class="badge red">relance ${esc(String(p.dunning_stage))}/3</span>${p.dunning_last_at ? ' · ' + esc(AdminPage.timeAgo(p.dunning_last_at)) : ''}`);
            if (m && m.discount_next_pct) details += row('Prochaine charge', `<span class="badge green">−${esc(String(m.discount_next_pct))} %</span> (contre-offre)`);
            else if (m && m.save_offer_used_at) details += row('Contre-offre', `utilisée ${esc(AdminPage.timeAgo(m.save_offer_used_at))}`);
            const mails = [];
            if (p.welcome_email_at) mails.push('welcome ' + AdminPage.timeAgo(p.welcome_email_at));
            if (p.trial_reminder_email_at) mails.push('rappel J-2 ' + AdminPage.timeAgo(p.trial_reminder_email_at));
            if (p.winback_email_at) mails.push('win-back ' + AdminPage.timeAgo(p.winback_email_at));
            if (mails.length) details += row('Emails lifecycle', esc(mails.join(' · ')));
        }

        const KIND_LABELS = { trial_setup: 'essai (carte)', first_charge: '1ᵉʳ prélèvement', renewal: 'renouvellement', plan_change: 'changement plan', resubscribe: 'réabonnement', card_update: 'MAJ carte', refund: 'remboursement' };
        // Payment status → business-readable FR label; raw provider status kept in a tooltip.
        const PAY_STATUS = { captured: 'Encaissé', authorized: 'Autorisé', to_capture: 'À encaisser', require_payment_method: 'Non finalisé', canceled: 'Annulé', refused: 'Refusé', expired: 'Expiré', disputed: 'Litige', refunded: 'Remboursé' };
        const payBadge = (s) => {
            const lbl = PAY_STATUS[s] || esc(s);
            const cls = s === 'captured' ? 'green' : (s === 'authorized' || s === 'to_capture') ? 'blue'
                : (s === 'require_payment_method') ? 'amber' : (s === 'refused' || s === 'disputed') ? 'red' : 'gray';
            return `<span class="badge ${cls}" title="Statut technique : ${esc(s)}">${lbl}</span>`;
        };
        // Show a rail column only when it adds signal: a mixed-rail history, or a single
        // non-Revolut rail (a pure Revolut history would just repeat "Revolut · web" on every row).
        const payProviders = new Set(pays.map(x => x.provider || 'revolut'));
        const showRailCol = payProviders.size > 1 || (payProviders.size === 1 && !payProviders.has('revolut'));
        // Refunds: enabled for captured Revolut charges (backend flags `refundable` = revolut +
        // captured + order_id present). The Stancer rail is retired; mobile rails refund in-store.
        // norva-admin /user/:id/refund calls Revolut's refund API + journals a ledger row.
        const canRefund = (x) => !!(x && x.refundable === true);
        const showRefundCol = pays.some(canRefund);
        const payRows = pays.map(x => `<tr>
            <td>${esc(dt(x.updated_at || x.created_at))}</td>
            ${showRailCol ? `<td>${AdminPage.railBadge(x.provider)}</td>` : ''}
            <td>${KIND_LABELS[x.kind] || esc(x.kind)}</td>
            <td>${payBadge(x.status)}</td>
            <td class="num">${money(x.amount)}${x.currency && String(x.currency).toLowerCase() !== 'usd' ? ` <span class="pacct">${esc(String(x.currency).toUpperCase())}</span>` : ''}</td>
            ${showRefundCol ? `<td class="num">${canRefund(x) ? `<button class="mini-btn refund-btn" data-pi="${esc(x.pi_id)}" data-amount="${Number(x.amount) || 0}" title="Rembourser ce paiement">↩︎ Rembourser</button>` : ''}</td>` : ''}
        </tr>`).join('');

        const REASONS = { too_expensive: 'trop cher', not_using: 'utilise pas assez', technical: 'problème technique', other: 'autre', skipped: 'non précisé' };
        const fbRows = feedback.map(x => `<div class="ssub" style="margin-top:6px">${x.action === 'saved' ? '💚 Contre-offre acceptée' : '🛑 Annulation'} — raison : <b style="color:#e8e8ee">${REASONS[x.reason] || esc(x.reason)}</b> · ${esc(AdminPage.timeAgo(x.created_at))}</div>`).join('');

        el.innerHTML = `${details}
            ${payRows ? `<div style="margin-top:14px"><div class="kpi-gtitle">Historique des paiements</div><div class="scroll"><table><thead><tr><th>Date</th>${showRailCol ? '<th>Rail</th>' : ''}<th>Type</th><th>Statut</th><th class="num">Montant</th>${showRefundCol ? '<th></th>' : ''}</tr></thead><tbody>${payRows}</tbody></table></div></div>` : ''}
            ${fbRows}`;
        wireInternalToggle(this);
        // Refund buttons → norva-admin /user/:id/refund (Revolut captured charges only).
        el.querySelectorAll('.refund-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const pi = btn.dataset.pi, amount = Number(btn.dataset.amount) || 0;
                if (!pi) return;
                if (!await this._confirm(`Rembourser ${money(amount)} à ce client ? Le remboursement part immédiatement chez Revolut — action irréversible.`, { danger: true, okLabel: 'Rembourser' })) return;
                const orig = btn.textContent;
                btn.disabled = true; btn.textContent = '…';
                try {
                    const res = await fetch(`${this._sbUrl()}/functions/v1/norva-admin/user/${userId}/refund`, {
                        method: 'POST',
                        headers: { apikey: this._sbKey(), Authorization: `Bearer ${this._token()}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ pi_id: pi })
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(data.error || String(res.status));
                    this._toast(data.message || 'Remboursement effectué.', 'ok');
                    this._loadBilling(userId);
                } catch (e) {
                    btn.disabled = false; btn.textContent = orig;
                    this._toast('Erreur remboursement : ' + e.message, 'err');
                }
            });
        });
    }

    // ── Fiche: support tickets panel (open first, newest first, click → thread) ──
    async _loadUserTickets(userId) {
        const el = document.getElementById('fiche-tickets');
        if (!el) return;
        try {
            const res = await this._rpc('admin_support_list', { p_user_id: userId, p_limit: 10, p_offset: 0 });
            if (this._crmUser !== userId) return; // navigated away mid-fetch
            const rows = (res && res.rows) || [];
            // Server-side count (open_total) — the old client-side filter only saw the 10 loaded
            // rows, so a heavy-ticket client's chip under-counted.
            const openCount = Number(res && res.open_total) || 0;
            this._setFicheChip('fs-tickets', '🎫', AdminPage.n(openCount), 'Tickets ouverts', openCount > 0 ? 'warn' : 'ok');
            if (!rows.length) { el.innerHTML = '<div class="ssub">Aucun ticket.</div>'; return; }
            const chip = (t) => t.status === 'closed' ? '<span class="badge gray">fermé</span>'
                : (t.last_from === 'user' ? '<span class="badge red">à répondre</span>' : '<span class="badge green">répondu</span>');
            el.innerHTML = rows.map(t => `
                <div class="tl-item" data-ticket-id="${AdminPage.esc(t.id)}" role="button" tabindex="0" style="cursor:pointer" title="Ouvrir le ticket">
                    ${chip(t)}
                    <span class="tl-sum" style="margin-left:8px"><b>${AdminPage.esc(t.subject)}</b>
                      <span class="pacct">· ${AdminPage.n(t.msg_count)} msg</span></span>
                    <span class="tl-at">${AdminPage.esc(AdminPage.timeAgo(t.last_message_at))}</span>
                </div>`).join('') +
                ((res.total > rows.length) ? `<div class="ssub" style="margin-top:8px">${AdminPage.n(res.total - rows.length)} autre(s) — voir la page Support.</div>` : '');
            el.querySelectorAll('[data-ticket-id]').forEach(r =>
                r.addEventListener('click', () => this._navigate('ticket:' + r.dataset.ticketId)));
        } catch (e) {
            if (this._crmUser !== userId) return;
            el.innerHTML = `<div class="admin-err" role="alert">Erreur : ${AdminPage.esc(e.message)}</div>`;
            this._setFicheChip('fs-tickets', '🎫', '—', 'Tickets ouverts', 'alert');
        }
    }

    // ── CRM relational panels (tags / notes / timeline) ──
    async _loadCrm(userId) {
        try {
            const crm = await this._rpc('admin_client_crm', { p_user_id: userId }) || {};
            if (this._crmUser !== userId) return; // stale response for a client we've left
            this._crm = crm;
            this._renderCrm();
        } catch (e) {
            if (this._crmUser !== userId) return;
            ['fiche-tags', 'fiche-notes', 'fiche-timeline'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.innerHTML = `<div class="admin-err" role="alert">Erreur : ${AdminPage.esc(e.message)}</div>`;
            });
            this._setFicheChip('fs-tags', '🏷️', '—', 'Segments', 'alert');
        }
    }

    _renderCrm() {
        const c = this._crm || {};
        const tags = Array.isArray(c.tags) ? c.tags : [];
        const all = Array.isArray(c.all_tags) ? c.all_tags : [];
        const notes = Array.isArray(c.notes) ? c.notes : [];
        const timeline = Array.isArray(c.timeline) ? c.timeline : [];
        const applied = new Set(tags.map(t => t.id));
        this._setFicheChip('fs-tags', '🏷️', AdminPage.n(tags.length), 'Segments', tags.length ? 'ok' : '');

        const tagsEl = document.getElementById('fiche-tags');
        if (tagsEl) {
            const cur = tags.length
                ? tags.map(t => `<span class="badge ${AdminPage.tagColor(t.color)} tag-chip">${AdminPage.esc(t.label)} <button class="crm-tag-remove" data-tag-id="${AdminPage.esc(t.id)}" aria-label="Retirer le tag ${AdminPage.esc(t.label)}" title="Retirer">×</button></span>`).join('')
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
            notesEl.innerHTML = `<div class="note-add"><textarea id="crm-note-input" rows="2" placeholder="Ex : client VIP, problème de paiement, demande support en cours…"></textarea><button class="crm-note-add">Ajouter</button></div>${list}`;
        }

        const tlEl = document.getElementById('fiche-timeline');
        if (tlEl) {
            const icon = (k) => ({ signup: '🎉', provider_added: '📡', sync: '🔄', sync_started: '▶️', sync_done: '✅', sync_failed: '⚠️', note_added: '📝', tag_added: '🏷️', tag_removed: '🏷️', resync: '↻', admin_action: '⚡', billing: '💳', trial_started: '🚀', cancelled: '🛑', saved: '💚' }[k] || '•');
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
            if (!await this._confirm(`Changer le rôle de cet utilisateur en « ${role} » ?`, { danger: role === 'admin', okLabel: 'Changer le rôle' })) return;
            path = `user/${uid}/role`; body = { role };
        } else if (btn.classList.contains('act-suspend')) {
            const suspend = btn.dataset.suspend === 'true';
            if (!await this._confirm(suspend ? 'Suspendre ce compte ? Il ne pourra plus se connecter.' : 'Réactiver ce compte ?', { danger: suspend, okLabel: suspend ? 'Suspendre' : 'Réactiver' })) return;
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
            if (data.message) this._toast(data.message, 'ok');
            this._navigate('client:' + uid);   // reload fiche to reflect the new state
        } catch (e) {
            btn.textContent = '✗ ' + AdminPage.esc(e.message);
            this._toast('Erreur : ' + e.message, 'err');
            setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000);
        }
    }

    async _crmMutate(fn, params) {
        try { await this._rpc(fn, params); await this._loadCrm(this._crmUser); }
        catch (e) { this._toast('Erreur : ' + e.message, 'err'); }
    }
    async _crmAddNote() {
        const ta = document.getElementById('crm-note-input');
        const body = ta ? ta.value.trim() : '';
        if (!body) { this._toast('La note est vide.', 'err'); if (ta) ta.focus(); return; }
        // admin_note_add inserts on every call — a fast double-click created the note twice.
        const btn = document.getElementById('crm-note-add');
        if (btn) { if (btn.disabled) return; btn.disabled = true; }
        try { await this._crmMutate('admin_note_add', { p_user_id: this._crmUser, p_body: body }); }
        finally { const b2 = document.getElementById('crm-note-add'); if (b2) b2.disabled = false; }
    }
    async _crmCreateTag() {
        const userId = this._crmUser; // pin: the prompts are async, the fiche could change under us
        const label = ((await this._prompt('Nom du tag / segment :')) || '').trim();
        if (!label) return;
        const raw = ((await this._prompt('Couleur : gray, green, red, amber ou blue', 'blue')) || 'blue').trim().toLowerCase();
        const color = ['gray', 'green', 'red', 'amber', 'blue'].includes(raw) ? raw : 'blue';
        try {
            const t = await this._rpc('admin_tag_create', { p_label: label, p_color: color });
            if (t && t.id) await this._rpc('admin_tag_toggle', { p_user_id: userId, p_tag_id: t.id, p_on: true });
            if (this._crmUser === userId) await this._loadCrm(userId);
        } catch (e) { this._toast('Erreur : ' + e.message, 'err'); }
    }

    // Update one résumé-client chip once its async panel has loaded.
    _setFicheChip(id, ic, val, l, cls) {
        const el = document.getElementById(id);
        if (!el) return;
        el.className = 'cs-item ' + (cls || '');
        el.innerHTML = `<div class="cs-ic">${ic}</div><div class="cs-tx"><div class="cs-v">${val}</div><div class="cs-l">${l}</div></div>`;
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
        // Common (non-destructive) vs sensitive (role change / suspension) actions, visually isolated.
        const commonActions = !u.email_confirmed
            ? `<div class="act-row"><button class="act-btn act-resend" data-user-id="${uid}">✉️ Renvoyer la confirmation</button></div>`
            : '<div class="ssub">Aucune action courante en attente.</div>';
        // Own account: don't offer self-demote / self-suspend at all (the edge refuses them
        // anyway, but the UI shouldn't propose an action that can only fail — or lock you out).
        const isSelf = uid && uid === this._meId();
        const sensitiveActions = isSelf
            ? `<div class="act-zone"><div class="act-zone-h">⚠️ Zone sensible</div>
               <div class="ssub">C'est votre propre compte — le changement de rôle et la suspension sont désactivés (anti-lock-out).</div></div>`
            : `<div class="act-zone">
            <div class="act-zone-h">⚠️ Zone sensible</div>
            <div class="act-row">
              <button class="act-btn act-role" data-user-id="${uid}" data-role="${roleTarget}">🔑 Passer ${roleTarget}</button>
              <button class="act-btn ${u.banned ? 'act-unsuspend' : 'act-danger'} act-suspend" data-user-id="${uid}" data-suspend="${u.banned ? 'false' : 'true'}">${u.banned ? '✅ Réactiver' : '⛔ Suspendre'}</button>
            </div>
        </div>`;

        // ── Résumé client (executive read) — sync chips now, async chips (💳/🎫/🏷️) filled on load ──
        const srcTotal = sources.length;
        const srcBad = sources.filter(s => s.incomplete === true || s.sync_error || s.sync_status === 'sync_error').length;
        const srcCls = srcBad > 0 ? 'alert' : (srcTotal ? 'ok' : '');
        const actAgo = u.last_sign_in_at ? AdminPage.timeAgo(u.last_sign_in_at) : 'jamais';
        const acctTxt = u.banned ? 'Suspendu' : (u.role === 'admin' ? 'Admin' : 'Actif');
        const acctCls = u.banned ? 'alert' : 'ok';
        const chip = (id, ic, val, l, cls) => `<div class="cs-item ${cls || ''}"${id ? ` id="${id}"` : ''}><div class="cs-ic">${ic}</div><div class="cs-tx"><div class="cs-v">${val}</div><div class="cs-l">${l}</div></div></div>`;
        const summary = `<div class="cockpit-summary fiche-summary">
            ${chip('fs-sub', '💳', '<span class="ssub">…</span>', 'Abonnement', '')}
            ${chip('fs-origin', '🧭', '<span class="ssub">…</span>', 'Origine inscription', '')}
            ${chip('', '🕐', AdminPage.esc(actAgo), 'Dernière activité', u.last_sign_in_at ? '' : 'warn')}
            ${chip('', '📡', AdminPage.n(srcTotal) + (srcBad ? ` <span class="pacct">· ${AdminPage.n(srcBad)} ⚠</span>` : ''), 'Sources', srcCls)}
            ${chip('fs-tickets', '🎫', '<span class="ssub">…</span>', 'Tickets ouverts', '')}
            ${chip('fs-tags', '🏷️', '<span class="ssub">…</span>', 'Segments', '')}
            ${chip('', '👤', acctTxt, 'Compte', acctCls)}
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
                <td class="num"><span class="bar"><i style="width:${Math.min(100, Number(r.resolved_pct) || 0)}%"></i></span>${AdminPage.n(r.resolved)} (${Number(r.resolved_pct) || 0}%)</td>
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
            ${summary}
            <div class="fiche-cols">
              <div class="fiche-col">
                <div class="admin-block"><h2>🧭 Inscription & localisation</h2><div id="fiche-acquisition" class="card"><div class="ssub">Chargement…</div></div></div>
                <div class="admin-block"><h2>💳 Abonnement & paiements</h2><div id="fiche-billing" class="card"><div class="ssub">Chargement…</div></div></div>
                <div class="admin-block"><h2>🎫 Tickets support</h2><div id="fiche-tickets" class="card"><div class="ssub">Chargement…</div></div></div>
                <div class="admin-block"><h2>🏷️ Tags & segments</h2><div id="fiche-tags" class="card"><div class="ssub">Chargement…</div></div></div>
                <div class="admin-block"><h2>📝 Notes internes</h2><div id="fiche-notes" class="card"><div class="ssub">Chargement…</div></div></div>
              </div>
              <div class="fiche-col">
                <div class="admin-block"><h2>📡 Sources (${sources.length})</h2><div class="scroll">${srcHtml}</div></div>
                <div class="admin-block"><h2>⚙️ Enrichissement audio par panel</h2><div class="scroll">${enrHtml}</div></div>
                <div class="admin-block"><h2>🕑 Timeline d'activité</h2><div id="fiche-timeline" class="card"><div class="ssub">Chargement…</div></div></div>
                <div class="admin-block"><h2>⚡ Actions</h2><div class="card"><div class="act-lbl">Actions courantes</div>${commonActions}${sensitiveActions}</div></div>
              </div>
            </div>`;
    }

    // ── Page: Norva Partners ──
    //
    // These views intentionally consume dedicated, redacted RPCs. They never
    // reuse the user dashboard, expose a public referral code, or render raw
    // provider/KYC payloads. Server capabilities remain the authority for every
    // Risk/Finance/Payout action.
    async _pagePartners() {
        const view = document.getElementById('crm-view');
        if (!view) return;
        this._partnersAbortAll();
        this._partnersPageGeneration = (this._partnersPageGeneration || 0) + 1;
        this._partnersCache.delete('capabilities');
        this._partnersCanManageCapabilities = false;
        this._partnersCanManageRelease = false;
        this._partnersCapabilities = { support: false, risk: false, finance: false };
        this._setCrumb('Partners');
        const status = this._partnersStatus || '';
        const search = this._partnersSearch || '';
        const validViews = ['overview', 'partners', 'risk', 'finance', 'configuration'];
        const returnedFromDiditCertification =
            this.app?.consumePartnersKycCertificationReturnNotice?.() === true;
        const diditRestore = returnedFromDiditCertification
            ? this._partnersConsumeKycCertificationReturnContext()
            : null;
        const restore = diditRestore || this._partnersRestoreContext;
        this._partnersRestoreContext = null;
        if (restore && validViews.includes(restore.view)) this._partnersView = restore.view;
        if (returnedFromDiditCertification) this._partnersView = 'risk';
        if (returnedFromDiditCertification) {
            this._partnersKycCertificationPollUntil = Date.now() + 60_000;
        }
        if (!validViews.includes(this._partnersView)) this._partnersView = 'overview';
        const tabs = [
            ['overview', 'Vue d’ensemble'],
            ['partners', 'Partenaires'],
            ['risk', 'Risque/KYC'],
            ['finance', 'Finance/Revolut'],
            ['configuration', 'Configuration']
        ].map(([key, label]) => `<button id="partners-tab-${key}" type="button"
            class="partners-workspace-tab" role="tab"
            aria-selected="${this._partnersView === key ? 'true' : 'false'}"
            aria-controls="partners-pane-${key}" tabindex="${this._partnersView === key ? '0' : '-1'}"
            data-partners-view="${key}">${label}</button>`).join('');
        const paneAttrs = (key) => `id="partners-pane-${key}" class="partners-pane" role="tabpanel"
            aria-labelledby="partners-tab-${key}" tabindex="-1"${this._partnersView === key ? '' : ' hidden'}`;
        view.innerHTML = `<div class="crm-page partners-admin-page">
          <h1 class="crm-h1">Norva Partners</h1>
          <p class="crm-sub">Comptes individuels, alertes et opérations financières — chaque donnée reste autoritative et sanitisée.</p>
          <div id="partners-admin-summary" class="cockpit-summary is-loading" aria-busy="true">
            <div class="ssub">Chargement des métriques autoritatives…</div>
          </div>
          <nav class="partners-workspace-nav" role="tablist" aria-orientation="horizontal" aria-label="Vues Norva Partners">${tabs}</nav>
          <p id="partners-view-status" class="partners-sr-only" role="status" aria-live="polite"></p>

          <section ${paneAttrs('overview')}>
            <section class="card partners-overview-list" aria-labelledby="partners-overview-title">
              <div class="partners-overview-list-head"><h2 id="partners-overview-title">Partenaires récents</h2>
                <button type="button" class="partners-action" data-partners-view="partners">Voir tous les partenaires</button>
              </div>
              <div id="partners-admin-list-preview" class="partners-overview-items" aria-busy="true"><div class="ssub">Chargement…</div></div>
            </section>
            <div id="partners-admin-priority" class="partners-priority-strip" aria-busy="true">
              <strong>Priorités opérationnelles</strong><span>Chargement des alertes…</span>
            </div>
            <section id="partners-admin-monitoring" class="partners-control-card" aria-busy="true">
              <div class="partners-control-head"><div><h2>Supervision</h2><p>Les anomalies nécessitant une action précèdent les services volontairement inactifs.</p></div></div>
              <div class="ssub">Chargement…</div>
            </section>
            <section id="partners-admin-analytics" class="partners-control-card" aria-busy="true">
              <div class="partners-control-head"><div><h2>Performance Partners sur 30 jours</h2><p>Acquisition, activation et valeur autoritative.</p></div></div>
              <div class="ssub">Chargement…</div>
            </section>
          </section>

          <section ${paneAttrs('partners')}>
            <section class="partners-control-card" aria-labelledby="partners-access-requests-title">
              <div class="partners-control-head">
                <div>
                  <h2 id="partners-access-requests-title">Demandes d’accès</h2>
                  <p>Demandes de découverte distinctes de l’inscription, du KYC et de l’activation du programme.</p>
                </div>
                <span id="partners-access-request-count" class="pill">—</span>
              </div>
              <div class="partners-admin-toolbar">
                <select id="partners-access-request-status" aria-label="Filtrer les demandes d’accès par statut">
                  ${[['requested', 'À examiner'], ['approved', 'Approuvées'], ['declined', 'Refusées'], ['all', 'Tous les statuts']]
                    .map(([value, label]) => `<option value="${value}"${this._partnersAccessRequestStatus === value ? ' selected' : ''}>${label}</option>`).join('')}
                </select>
              </div>
              <div id="partners-admin-access-requests" aria-busy="true">
                <div class="ssub">Chargement des demandes…</div>
              </div>
            </section>
            <div class="partners-pane-intro"><div><h2>Partenaires individuels</h2><p>Recherche et état contractuel, sans identifiant sensible visible.</p></div><span id="partners-admin-count" class="pill">—</span></div>
            <div class="partners-admin-toolbar" role="search" aria-label="Rechercher les partenaires">
              <input id="partners-admin-search" type="search" maxlength="64" value="${AdminPage.esc(search)}"
                placeholder="Clé partenaire (hexadécimale)" aria-label="Rechercher par clé partenaire"
                inputmode="text" pattern="[0-9a-f-]{1,64}" autocapitalize="none" spellcheck="false">
              <select id="partners-admin-status" aria-label="Filtrer les partenaires par statut">
                ${[['', 'Tous les statuts'], ['pending_verification', 'Vérification en attente'], ['active', 'Actifs'], ['held', 'En attente de décision'], ['suspended', 'Suspendus'], ['closed', 'Clôturés']]
                    .map(([value, label]) => `<option value="${value}"${status === value ? ' selected' : ''}>${label}</option>`).join('')}
              </select>
            </div>
            <div id="partners-admin-list" aria-busy="true"><div class="ssub">Chargement des comptes…</div></div>
          </section>

          <section ${paneAttrs('risk')}>
            <div class="partners-pane-intro"><div><h2>Risque et vérification</h2><p>KYC individuel, files de revue et décisions minimisées.</p></div></div>
            <div class="partners-ops-grid">
              <section id="partners-admin-kyc" class="partners-ops-card" aria-busy="true"><h2>KYC individuel</h2><p>Quota informatif et capacité réelle.</p><div class="ssub">Chargement…</div></section>
              <section id="partners-admin-kyc-certification" class="partners-ops-card" aria-busy="true"><h2>Validation finale Didit</h2><p>Contrôle ponctuel du parcours d’identité avant ouverture du KYC cash.</p><div class="ssub">Chargement…</div></section>
              <section id="partners-admin-risk" class="partners-ops-card" aria-busy="true"><h2>Risque</h2><p>Comptes et jobs nécessitant une décision autorisée.</p><div class="ssub">Chargement…</div></section>
            </div>
            <section id="partners-admin-kyc-human-reviews" class="partners-control-card" aria-busy="true">
              <div class="partners-control-head"><div><h2>Recours humains KYC</h2>
                <p>Demandes sanitisees, acces Didit audite et decision Risque/AAL2. Aucun document, e-mail, UUID utilisateur ou payload provider n'est affiche.</p></div></div>
              <div class="ssub">Chargement des demandes de recours...</div>
            </section>
            <section id="partners-admin-fiscal-profiles" class="partners-control-card" aria-busy="true">
              <div class="partners-control-head"><div><h2>Résidences fiscales à examiner</h2>
                <p>File sanitisée Support + Finance. Aucun identifiant fiscal, document, e-mail ou UUID interne n’est affiché.</p></div></div>
              <div class="ssub">Chargement…</div>
            </section>
          </section>

          <section ${paneAttrs('finance')}>
            <div class="partners-pane-intro"><div><h2>Finance et Revolut</h2><p>Les écarts et actions requises sont affichés avant les historiques sains.</p></div></div>
            <section id="partners-admin-aal2" class="partners-priority-strip partners-aal2-gate" aria-labelledby="partners-admin-aal2-title" hidden></section>
            <div class="partners-control-stack">
              <section id="partners-admin-payout-onboarding" class="partners-control-card" aria-busy="true">
                <div class="partners-control-head"><div><h2>Demandes de configuration de versement</h2>
                  <p>File sanitisée Revolut Business Basic. Aucune donnée bancaire, fiscale ou bénéficiaire n’est affichée.</p></div></div>
                <div class="ssub">Chargement…</div>
              </section>
              <section id="partners-admin-reconciliation-incidents" class="partners-control-card" aria-busy="true">
                <div id="partners-admin-incidents-status" class="partners-sr-only" role="status" aria-live="polite"></div>
                <div class="partners-control-head"><div><h2>Écarts de rapprochement Revolut</h2><p>File append-only priorisée, preuve fraîche et maker-checker Finance/AAL2.</p></div></div><div class="ssub">Chargement…</div>
              </section>
              <section id="partners-admin-returns" class="partners-control-card" aria-busy="true"><div class="partners-control-head"><div><h2>Retours et déblocages Revolut</h2></div></div><div class="ssub">Chargement…</div></section>
              <section id="partners-admin-manual-controls" class="partners-control-card" aria-busy="true"><div class="partners-control-head"><div><h2>Contrôles des lots manuels</h2></div></div><div class="ssub">Chargement…</div></section>
              <section id="partners-admin-late-completions" class="partners-control-card" aria-busy="true"><div class="partners-control-head"><div><h2>Paiements tardifs</h2></div></div><div class="ssub">Chargement…</div></section>
              <section id="partners-admin-finance" class="partners-ops-card" aria-busy="true"><h2>Ledger et worker</h2><p>Backlogs, maturation et cohérence du ledger interne.</p><div class="ssub">Chargement…</div></section>
              <section id="partners-admin-revolut" class="partners-control-card" aria-busy="true"><div class="partners-control-head"><div><h2>Revolut Business</h2><p>Production Basic en exécution manuelle.</p></div></div><div class="ssub">Chargement…</div></section>
              <section id="partners-admin-settlements" class="partners-control-card" aria-busy="true"><div class="partners-control-head"><div><h2>Rapprochement des versements</h2></div></div><div class="ssub">Chargement…</div></section>
              <section id="partners-admin-payouts" class="partners-ops-card" aria-busy="true"><h2>Cycles et lots manuels</h2><p>Préparation Norva, validation et paiement manuel Revolut.</p><div class="ssub">Chargement…</div></section>
            </div>
          </section>

          <section ${paneAttrs('configuration')}>
            <div class="partners-pane-intro"><div><h2>Configuration</h2><p>Capacités, programme, release et corridors. Tout reste fermé par défaut.</p></div></div>
            <div id="partners-admin-readiness" class="partners-admin-readiness" aria-busy="true"><div class="ssub">Chargement des capacités…</div></div>
            <section id="partners-admin-configuration" class="partners-control-card" aria-busy="true"><div class="partners-control-head"><div><h2>Programme, juridictions et release</h2></div></div><div class="ssub">Chargement…</div></section>
            <section id="partners-admin-routes" class="partners-control-card" aria-busy="true"><div class="partners-control-head"><div><h2>Corridors Revolut</h2><p>Recherche, filtres et pagination exhaustive.</p></div></div><div class="ssub">Chargement…</div></section>
          </section>
        </div>`;

        if (returnedFromDiditCertification) {
            setTimeout(() => this._toast(
                'Retour Didit reçu. La décision signée fait foi et peut arriver quelques secondes plus tard.',
                'ok'
            ), 0);
        }

        const force = this._partnersForceRefresh === true;
        this._partnersForceRefresh = false;
        const baseLoads = [
            this._partnersLoadOverview({ force }),
            this._partnersLoadView(this._partnersView, { force })
        ];
        const completion = Promise.allSettled(baseLoads);
        if (returnedFromDiditCertification) {
            this._partnersScheduleKycCertificationPoll(3_000);
        }
        if (restore) {
            const generation = this._partnersPageGeneration;
            completion.finally(() => setTimeout(() => {
                if (this._route !== 'partners' || generation !== this._partnersPageGeneration) return;
                const main = document.querySelector('#page-admin .crm-main');
                if (main) main.scrollTop = Number(restore.scrollTop) || 0;
                if (!this._partnersRestoreFocus(restore.focus)) {
                    document.getElementById(`partners-tab-${this._partnersView}`)?.focus?.({ preventScroll: true });
                }
            }, 0));
        }
        return completion;
    }

    _partnersCreateController() {
        const Controller = window.AbortController
            || (typeof AbortController !== 'undefined' ? AbortController : null);
        return Controller ? new Controller() : { signal: undefined, abort() {} };
    }

    _partnersAbortAll() {
        if (!(this._partnersRequests instanceof Map)) this._partnersRequests = new Map();
        this._partnersRequests.forEach((request) => {
            if (typeof request?.cancel === 'function') request.cancel();
            else request?.controller?.abort?.();
        });
        this._partnersRequests.clear();
    }

    async _partnersLoadModule(key, fn, params, render, options = {}) {
        if (!(this._partnersCache instanceof Map)) this._partnersCache = new Map();
        if (!(this._partnersRequests instanceof Map)) this._partnersRequests = new Map();
        // A forced refresh must never fall back to data from the previous
        // successful request after a timeout or an authoritative error.
        if (options.force) this._partnersCache.delete(key);
        if (!options.force && this._partnersCache.has(key)) {
            const cached = this._partnersCache.get(key);
            try {
                render(cached);
                return cached;
            } catch (_) {
                this._partnersCache.delete(key);
                this._partnersRenderModuleError(options.targetId, options.title, key);
                return null;
            }
        }
        const previous = this._partnersRequests.get(key);
        if (typeof previous?.cancel === 'function') previous.cancel();
        else previous?.controller?.abort?.();
        const controller = this._partnersCreateController();
        const token = ++this._partnersRequestSeq;
        const generation = this._partnersPageGeneration;
        let rejectCancellation;
        const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
        const request = {
            token,
            generation,
            controller,
            timedOut: false,
            cancelled: false,
            cancel() {
                if (this.cancelled) return;
                this.cancelled = true;
                this.controller?.abort?.();
                const error = new Error('partners_module_cancelled');
                error.name = 'AbortError';
                rejectCancellation(error);
            }
        };
        this._partnersRequests.set(key, request);
        const target = options.targetId && document.getElementById(options.targetId);
        if (target) target.setAttribute('aria-busy', 'true');
        const requestedTimeout = Number(options.timeoutMs);
        const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
            ? Math.min(requestedTimeout, 60_000) : 12_000;
        let rejectTimeout;
        const timeoutFailure = new Promise((_, reject) => { rejectTimeout = reject; });
        const timeout = setTimeout(() => {
            request.timedOut = true;
            controller.abort?.();
            const error = new Error('partners_module_timeout');
            error.name = 'TimeoutError';
            rejectTimeout(error);
        }, timeoutMs);
        try {
            const data = await Promise.race([
                this._rpc(fn, params, { signal: controller.signal }),
                cancellation,
                timeoutFailure
            ]);
            const current = this._partnersRequests.get(key);
            if (current?.token !== token || generation !== this._partnersPageGeneration
                || this._route !== 'partners') return null;
            this._partnersCache.set(key, data);
            if (this._partnersAal2FailedKeys.delete(key)
                && this._partnersAal2FailedKeys.size === 0) {
                this._partnersAal2Required = false;
                this._partnersRenderAal2Gate();
            }
            render(data);
            return data;
        } catch (error) {
            const current = this._partnersRequests.get(key);
            if (current?.token !== token || generation !== this._partnersPageGeneration
                || this._route !== 'partners') return null;
            const aborted = error?.name === 'AbortError' && !request.timedOut;
            if (!aborted) {
                this._partnersCache.delete(key);
                if (this._partnersIsAal2Error(error)) {
                    this._partnersAal2Required = true;
                    this._partnersAal2FailedKeys.add(key);
                    this._partnersRenderAal2Gate();
                }
                if (typeof options.onError === 'function') {
                    try { options.onError(); }
                    catch (_) { this._partnersRenderModuleError(options.targetId, options.title, key); }
                } else {
                    this._partnersRenderModuleError(options.targetId, options.title, key);
                }
            }
            return null;
        } finally {
            clearTimeout(timeout);
            if (this._partnersRequests.get(key)?.token === token) this._partnersRequests.delete(key);
        }
    }

    _partnersRenderModuleError(targetId, title, key) {
        const target = document.getElementById(targetId);
        if (!target) return;
        target.removeAttribute('aria-busy');
        target.innerHTML = `<div class="admin-err" role="status"><strong>${AdminPage.esc(title || 'Donnée')} : indisponible.</strong>
          <span>Aucune valeur n’est supposée et aucune action n’a été exécutée.</span>
          <button type="button" class="partners-action" data-partners-retry="${AdminPage.esc(key)}">Réessayer</button></div>`;
        if (key === 'accounts') {
            const preview = document.getElementById('partners-admin-list-preview');
            if (preview) {
                preview.removeAttribute('aria-busy');
                preview.innerHTML = '<div class="admin-err" role="status">Aperçu des partenaires indisponible.</div>';
            }
            const count = document.getElementById('partners-admin-count');
            if (count) count.textContent = 'inconnu';
        }
        if (key === 'monitoring') {
            const priority = document.getElementById('partners-admin-priority');
            if (priority) {
                priority.removeAttribute('aria-busy');
                priority.classList.add('is-alert');
                priority.innerHTML = '<strong>Priorités indisponibles</strong><span>Aucune conclusion de santé n’est déduite.</span>';
            }
        }
    }

    _partnersIsAal2Error(error) {
        const code = String(error?.payload?.code || error?.payload?.error_code || error?.code || '');
        return [400, 403].includes(Number(error?.status))
            && (/(requires\s+AAL2|AAL2\s+required|aal2_required)/i.test(String(error?.message || ''))
                || /aal2_required/i.test(code));
    }

    _partnersMfaFailureMessage(error) {
        const status = Number(error?.status || 0);
        const code = String(
            error?.payload?.error_code
            || error?.payload?.code
            || error?.code
            || ''
        ).toLowerCase();
        if (status === 401 || /authentication_required|session|jwt/.test(code)) {
            return 'Votre session a expiré. Reconnectez-vous avant de valider avec Authenticator.';
        }
        if (status === 429 || /rate|too_many|over_request/.test(code)) {
            return 'Trop de tentatives Authenticator. Attendez un instant avant de réessayer.';
        }
        if (/factor_unavailable|factor_not_found|mfa_disabled|not_enabled|hook/.test(code)) {
            return 'Authenticator n’est pas disponible pour ce compte. Vérifiez sa configuration de sécurité.';
        }
        if ([400, 422].includes(status)
            || /code_invalid|invalid_totp|otp_expired|verification_failed|elevation_failed/.test(code)) {
            return 'Code incorrect ou expiré. Aucun accès sensible n’a été ouvert.';
        }
        if (status >= 500 || status === 0 || /network|lock_timeout|challenge|unavailable/.test(code)) {
            return 'Le service Authenticator est momentanément indisponible. Aucun accès sensible n’a été ouvert.';
        }
        return 'La validation Authenticator a échoué. Aucun accès sensible n’a été ouvert.';
    }

    _partnersRenderAal2Gate() {
        const gate = document.getElementById('partners-admin-aal2');
        if (!gate) return;
        if (!this._partnersAal2Required) {
            gate.hidden = true;
            gate.innerHTML = '';
            return;
        }
        gate.hidden = false;
        gate.innerHTML = `<div><strong id="partners-admin-aal2-title">Validation renforcée requise</strong>
          <span>Cette session est connectée, mais les actions sensibles Partners restent verrouillées tant que le code à 6 chiffres de votre application Authenticator n’a pas élevé la session à AAL2.</span></div>
          <span class="partners-sr-only" role="status" aria-live="polite">Validation Authenticator requise pour les actions sensibles Partners.</span>
          <button type="button" class="partners-action" data-partners-action="aal2-elevate">Vérifier avec Authenticator</button>`;
    }

    async _partnersChooseMfaFactor(factors) {
        if (!Array.isArray(factors) || !factors.length) return null;
        if (factors.length === 1) return factors[0];
        const choices = factors.map((factor, index) => (
            `${index + 1} — ${String(factor?.label || `Authenticator ${index + 1}`).slice(0, 48)}`
        )).join(' · ');
        const selection = await this._modal({
            title: 'Choisir Authenticator',
            message: `Plusieurs facteurs vérifiés sont disponibles : ${choices}`,
            prompt: true,
            inputMode: 'numeric',
            autocomplete: 'off',
            maxLength: String(factors.length).length,
            pattern: '[0-9]+',
            inputLabel: `Numéro du facteur, de 1 à ${factors.length}`,
            okLabel: 'Continuer'
        });
        if (selection === null) return null;
        const index = Number(selection) - 1;
        if (!Number.isSafeInteger(index) || index < 0 || index >= factors.length) {
            this._toast('Choisissez le numéro d’un Authenticator affiché.', 'err');
            return null;
        }
        return factors[index];
    }

    async _partnersEnsureAal2() {
        const auth = window.NorvaAuth;
        if (!auth?.getMfaStatus || !auth?.challengeAndVerifyMfa) {
            this._toast('La validation Authenticator n’est pas disponible dans cette version. Rechargez Norva.', 'err');
            return false;
        }
        let status;
        try {
            status = await auth.getMfaStatus();
        } catch (error) {
            this._toast(this._partnersMfaFailureMessage(error), 'err');
            return false;
        }
        if (status?.currentLevel === 'aal2') {
            this._partnersAal2Required = false;
            this._partnersAal2FailedKeys.clear();
            this._partnersRenderAal2Gate();
            return true;
        }
        if (status?.nextLevel !== 'aal2' || !Array.isArray(status?.factors) || !status.factors.length) {
            this._toast('Aucun facteur TOTP vérifié n’est associé à ce compte Admin. Configurez Authenticator avant d’effectuer une action sensible Partners.', 'err');
            return false;
        }
        const factor = await this._partnersChooseMfaFactor(status.factors);
        if (!factor) return false;
        const code = await this._modal({
            title: 'Validation Authenticator',
            message: 'Saisissez le code actuel à 6 chiffres de votre application Authenticator. Norva ne conserve jamais ce code.',
            prompt: true,
            inputMode: 'numeric',
            autocomplete: 'one-time-code',
            maxLength: 6,
            pattern: '[0-9]{6}',
            inputLabel: 'Code Authenticator à 6 chiffres',
            okLabel: 'Vérifier et continuer'
        });
        if (code === null) return false;
        if (!/^\d{6}$/.test(code)) {
            this._toast('Saisissez exactement les 6 chiffres affichés par Authenticator.', 'err');
            return false;
        }
        try {
            await auth.challengeAndVerifyMfa({ code, factorId: factor.id });
        } catch (error) {
            this._toast(this._partnersMfaFailureMessage(error), 'err');
            return false;
        }
        this._partnersAal2Required = false;
        this._partnersAal2FailedKeys.clear();
        this._partnersRenderAal2Gate();
        return true;
    }

    async _partnersElevateAal2() {
        return (await this._partnersEnsureAal2())
            ? 'Session sécurisée à AAL2. Les actions sensibles Partners sont maintenant déverrouillées.'
            : false;
    }

    _partnersApplyCapabilities(data) {
        const valid = data?.schema_version === 1;
        this._partnersCanManageCapabilities = valid && data?.can_manage === true;
        this._partnersCanManageRelease = valid && data?.can_manage_release === true;
        this._partnersCapabilities = {
            support: valid && data?.capabilities?.support === true,
            risk: valid && data?.capabilities?.risk === true,
            finance: valid && data?.capabilities?.finance === true
        };
        const overview = this._partnersCache.get('overview');
        if (overview) this._renderPartnersAdminSummary(overview, data);
        else this._partnersRenderCapabilitiesArea(data);
        this._partnersRerenderCapabilityDependentModules();
    }

    _partnersRerenderCapabilityDependentModules() {
        const cached = (key) => this._partnersCache.get(key);
        if (cached('accessRequests')) this._renderPartnersAccessRequests(cached('accessRequests'));
        if (cached('kyc')) this._renderPartnersKycQuota(cached('kyc'));
        if (cached('kycCertification')) {
            this._renderPartnersKycCertification(cached('kycCertification'));
        }
        if (cached('risk')) this._renderPartnersRisk(cached('risk'));
        if (cached('fiscalProfiles')) this._renderPartnersFiscalProfiles(cached('fiscalProfiles'));
        if (cached('configuration')) this._renderPartnersConfiguration(cached('configuration'));
        if (cached('finance')) this._renderPartnersFinance(cached('finance'));
        if (cached('payoutOnboardingRequests')) {
            this._renderPartnersPayoutOnboardingRequests(cached('payoutOnboardingRequests'));
        }
        if (cached('revolut')) this._renderPartnersRevolutStatus(cached('revolut'));
        if (cached('settlements')) this._renderPartnersRevolutReconciliation(cached('settlements'));
        if (cached('returns')) this._renderPartnersRevolutReturns(cached('returns'));
        if (cached('manualControls')) this._renderPartnersRevolutManualControls(cached('manualControls'));
        if (cached('lateCompletions')) this._renderPartnersRevolutLateCompletions(cached('lateCompletions'));
        if (cached('incidents')) this._renderPartnersRevolutIncidents(cached('incidents'));
        if (cached('payoutCycles') || cached('manualBatches')) {
            this._renderPartnersPayouts(cached('payoutCycles'), cached('manualBatches'));
        }
    }

    async _partnersLoadCapabilities({ force = false } = {}) {
        if (!(this._partnersRequests instanceof Map)) this._partnersRequests = new Map();
        if (!(this._partnersCache instanceof Map)) this._partnersCache = new Map();
        const capabilityEpoch = (Number(this._partnersCapabilitiesEpoch) || 0) + 1;
        this._partnersCapabilitiesEpoch = capabilityEpoch;

        // Operators are subordinate to the capability envelope. Revoke their
        // pending response before refreshing authority so a transport that
        // ignores AbortSignal can never repaint stale controls afterwards.
        const pendingOperators = this._partnersRequests.get('capabilityOperators');
        if (typeof pendingOperators?.cancel === 'function') pendingOperators.cancel();
        else pendingOperators?.controller?.abort?.();
        this._partnersRequests.delete('capabilityOperators');
        if (force) {
            this._partnersCache.delete('capabilityOperators');
            this._partnersCapabilityOperators = undefined;
            this._partnersApplyCapabilities(null);
        }

        const data = await this._partnersLoadModule('capabilities', 'admin_partners_capabilities', {}, (data) => {
            if (capabilityEpoch !== this._partnersCapabilitiesEpoch) return;
            this._partnersApplyCapabilities(data);
        }, { force, targetId: 'partners-admin-readiness', title: 'Capacités Partners' });
        if (capabilityEpoch !== this._partnersCapabilitiesEpoch) return null;
        if (data?.schema_version !== 1 || data?.can_manage !== true) {
            this._partnersCapabilityOperators = [];
            this._partnersRenderCapabilitiesArea(data);
            return data;
        }
        this._partnersCapabilityOperators = undefined;
        this._partnersRenderCapabilitiesArea(data);
        await this._partnersLoadModule(
            'capabilityOperators',
            'admin_partners_capability_operators',
            {},
            (envelope) => {
                if (capabilityEpoch !== this._partnersCapabilitiesEpoch
                    || this._partnersCanManageCapabilities !== true
                    || this._partnersCache.get('capabilities') !== data) return;
                if (envelope?.schema_version !== 1 || !Array.isArray(envelope.operators)
                    || envelope.operators.some((operator) => !this._partnersValidCapabilityOperator(operator))) {
                    throw new Error('invalid_partners_capability_operators_response');
                }
                this._partnersCapabilityOperators = envelope.operators;
                this._partnersRenderCapabilitiesArea(data);
            },
            {
                force,
                targetId: '',
                title: 'Équipe opératrice Partners',
                onError: () => {
                    if (capabilityEpoch !== this._partnersCapabilitiesEpoch
                        || this._partnersCanManageCapabilities !== true
                        || this._partnersCache.get('capabilities') !== data) return;
                    this._partnersCapabilityOperators = null;
                    this._partnersRenderCapabilitiesArea(data);
                }
            }
        );
        if (capabilityEpoch !== this._partnersCapabilitiesEpoch) return null;
        return data;
    }

    _partnersLoadOverview({ force = false } = {}) {
        return this._partnersLoadModule('overview', 'admin_partners_overview', {}, (data) => {
            this._renderPartnersAdminSummary(data && typeof data === 'object' ? data : {}, this._partnersCache.get('capabilities'));
        }, { force, targetId: 'partners-admin-summary', title: 'Métriques Partners' });
    }

    async _partnersLoadAccessRequests({ force = false, preserveFocus = '' } = {}) {
        const data = await this._partnersLoadModule(
            'accessRequests',
            'admin_partners_access_requests',
            {
                p_limit: this._partnersAccessRequestLimit,
                p_offset: this._partnersAccessRequestPage * this._partnersAccessRequestLimit,
                p_status: this._partnersAccessRequestStatus,
                p_search: null
            },
            (raw) => {
                if (raw?.schema_version !== 1 || !Array.isArray(raw.items)
                    || !Number.isSafeInteger(raw.total) || raw.total < 0
                    || !Number.isSafeInteger(raw.limit) || raw.limit < 1 || raw.limit > 100
                    || !Number.isSafeInteger(raw.offset) || raw.offset < 0) {
                    throw new Error('invalid_partners_access_requests_response');
                }
                this._renderPartnersAccessRequests(raw);
            },
            {
                force,
                targetId: 'partners-admin-access-requests',
                title: 'Demandes d’accès'
            }
        );
        if (preserveFocus && this._route === 'partners' && this._partnersView === 'partners') {
            setTimeout(() => {
                let target = preserveFocus === 'status'
                    ? document.getElementById('partners-access-request-status')
                    : document.querySelector(`[data-partners-access-request-page="${preserveFocus}"]`);
                if ((!target || target.disabled) && ['prev', 'next'].includes(preserveFocus)) {
                    const fallback = preserveFocus === 'next' ? 'prev' : 'next';
                    target = document.querySelector(`[data-partners-access-request-page="${fallback}"]:not(:disabled)`)
                        || document.getElementById('partners-access-request-status');
                }
                this._partnersFocusElement(target);
            }, 0);
        }
        return data;
    }

    async _partnersLoadAccounts({ force = false, preserveFocus = '' } = {}) {
        const generation = this._partnersPageGeneration;
        const requestedView = this._partnersView;
        const data = await this._partnersLoadModule('accounts', 'admin_partners_accounts', {
            p_limit: this._partnersLimit,
            p_offset: this._partnersPage * this._partnersLimit,
            p_status: this._partnersStatus || null,
            p_search: this._partnersSearch || null
        }, (raw) => {
            if (raw?.schema_version !== 1 || !Array.isArray(raw.items)
                || !Number.isSafeInteger(raw.total) || raw.total < 0
                || !Number.isSafeInteger(raw.limit) || raw.limit < 1 || raw.limit > 100
                || !Number.isSafeInteger(raw.offset) || raw.offset < 0) {
                throw new Error('invalid_partners_accounts_response');
            }
            this._renderPartnersAdminAccounts(raw.items, raw.total);
        }, { force, targetId: 'partners-admin-list', title: 'Liste des partenaires' });
        if (preserveFocus && this._route === 'partners'
            && generation === this._partnersPageGeneration
            && requestedView === this._partnersView) setTimeout(() => {
            let target = preserveFocus === 'search' ? document.getElementById('partners-admin-search')
                : (preserveFocus === 'status' ? document.getElementById('partners-admin-status')
                    : document.querySelector(`[data-partners-account-page="${preserveFocus}"]`));
            if ((!target || target.disabled) && ['prev', 'next'].includes(preserveFocus)) {
                const fallback = preserveFocus === 'next' ? 'prev' : 'next';
                target = document.querySelector(`[data-partners-account-page="${fallback}"]:not(:disabled)`)
                    || document.getElementById('partners-admin-search');
            }
            this._partnersFocusElement(target);
        }, 0);
        return data;
    }

    _partnersLoadView(view, { force = false } = {}) {
        const load = (key, fn, params, render, targetId, title) => this._partnersLoadModule(
            key, fn, params, render, { force, targetId, title }
        );
        if (view === 'overview') return Promise.allSettled([
            this._partnersLoadCapabilities({ force }),
            this._partnersLoadAccounts({ force }),
            load('monitoring', 'admin_partners_monitoring', {}, (d) => this._renderPartnersMonitoring(d), 'partners-admin-monitoring', 'Supervision'),
            load('analytics', 'admin_partners_analytics', { p_days: 30 }, (d) => this._renderPartnersAnalytics(d), 'partners-admin-analytics', 'Performance Partners')
        ]);
        if (view === 'partners') return Promise.allSettled([
            this._partnersLoadCapabilities({ force }),
            this._partnersLoadAccessRequests({ force }),
            this._partnersLoadAccounts({ force })
        ]);
        if (view === 'risk') return Promise.allSettled([
            this._partnersLoadCapabilities({ force }),
            load('kyc', 'admin_partners_kyc_quota', {}, (d) => this._renderPartnersKycQuota(d), 'partners-admin-kyc', 'KYC individuel'),
            this._partnersLoadKycCertification({ force }),
            load('risk', 'admin_partners_risk_queue', { p_limit: 8, p_offset: 0, p_status: null }, (d) => this._renderPartnersRisk(d), 'partners-admin-risk', 'Risque'),
            load('kycHumanReviews', 'admin_partners_kyc_human_review_queue', { p_limit: 25, p_offset: 0, p_status: 'all' }, (d) => this._renderPartnersKycHumanReviews(d), 'partners-admin-kyc-human-reviews', 'Recours humains KYC'),
            this._partnersLoadFiscalProfiles({ force })
        ]);
        if (view === 'finance') return this._partnersLoadFinanceView({ force });
        if (view === 'configuration') return Promise.allSettled([
            this._partnersLoadCapabilities({ force }),
            load('configuration', 'admin_partners_configuration', {}, (d) => this._renderPartnersConfiguration(d), 'partners-admin-configuration', 'Configuration Partners'),
            load('revolut', 'admin_partners_revolut_payout_status', {}, (d) => this._renderPartnersRevolutStatus(d), 'partners-admin-routes', 'Corridors Revolut')
        ]);
        return Promise.resolve();
    }

    _partnersIsPagedEnvelope(data) {
        return data?.schema_version === 1
            && Number.isSafeInteger(data.total)
            && data.total >= 0
            && Array.isArray(data.items);
    }

    _partnersLoadKycCertification({ force = false } = {}) {
        return this._partnersLoadModule(
            'kycCertification',
            'admin_partners_kyc_certification_status',
            {},
            (data) => this._renderPartnersKycCertification(data),
            {
                force,
                targetId: 'partners-admin-kyc-certification',
                title: 'Validation finale Didit'
            }
        );
    }

    _partnersPersistKycCertificationReturnContext() {
        const main = document.querySelector('#page-admin .crm-main');
        const rawScrollTop = Math.round(Number(main?.scrollTop) || 0);
        const scrollTop = Math.max(0, Math.min(rawScrollTop, 1_000_000));
        sessionStorage.setItem(
            'norva-partners-kyc-certification-context-v1',
            JSON.stringify({
                version: 1,
                view: 'risk',
                scrollTop,
                focus: 'kyc_certification_card'
            })
        );
    }

    _partnersConsumeKycCertificationReturnContext() {
        const key = 'norva-partners-kyc-certification-context-v1';
        let raw = null;
        try {
            raw = sessionStorage.getItem(key);
            sessionStorage.removeItem(key);
        } catch (_) {
            return null;
        }
        if (!raw || raw.length > 256) return null;
        try {
            const value = JSON.parse(raw);
            const exactKeys = value && typeof value === 'object'
                && !Array.isArray(value)
                && Object.keys(value).sort().join('|')
                    === ['version', 'view', 'scrollTop', 'focus'].sort().join('|');
            if (!exactKeys
                || value.version !== 1
                || value.view !== 'risk'
                || value.focus !== 'kyc_certification_card'
                || !Number.isSafeInteger(value.scrollTop)
                || value.scrollTop < 0
                || value.scrollTop > 1_000_000) return null;
            return {
                view: 'risk',
                scrollTop: value.scrollTop,
                focus: {
                    id: 'partners-admin-kyc-certification',
                    data: {}
                }
            };
        } catch (_) {
            return null;
        }
    }

    _partnersClearKycCertificationReturnState() {
        try {
            sessionStorage.removeItem('norva-partners-kyc-certification-v1');
            sessionStorage.removeItem(
                'norva-partners-kyc-certification-context-v1'
            );
        } catch (_) {}
    }

    _partnersScheduleKycCertificationPoll(delayMs = 3_000) {
        clearTimeout(this._partnersKycCertificationPollTimer);
        this._partnersKycCertificationPollTimer = null;
        if (Date.now() >= this._partnersKycCertificationPollUntil
            || this._route !== 'partners'
            || this._partnersView !== 'risk') return;
        const generation = this._partnersPageGeneration;
        this._partnersKycCertificationPollTimer = setTimeout(async () => {
            this._partnersKycCertificationPollTimer = null;
            if (this._route !== 'partners' || this._partnersView !== 'risk'
                || generation !== this._partnersPageGeneration) return;
            const finalRead = Date.now() >= this._partnersKycCertificationPollUntil;
            await this._partnersLoadKycCertification({ force: true }).catch(() => {});
            if (finalRead) {
                this._partnersKycCertificationPollUntil = 0;
                return;
            }
            if (!this._partnersKycCertificationPollTimer) {
                this._partnersScheduleKycCertificationPoll(3_000);
            }
        }, Math.max(0, Math.min(Number(delayMs) || 0, 3_000)));
    }

    _partnersMarkKycCertificationUncertain() {
        this._partnersKycCertificationPollUntil = Math.max(
            this._partnersKycCertificationPollUntil,
            Date.now() + 60_000
        );
        this._partnersCache?.delete?.('kycCertification');
        this._partnersScheduleKycCertificationPoll(0);
        const error = new Error('didit_certification_result_uncertain');
        error.code = 'didit_certification_result_uncertain';
        return error;
    }

    async _partnersReadBoundedJsonResponse(response, signal, maxBytes = 16_384) {
        const abortError = () => {
            const error = new Error('didit_certification_request_aborted');
            error.name = 'AbortError';
            return error;
        };
        const awaitWithAbort = async (promise) => {
            if (signal?.aborted) throw abortError();
            if (!signal?.addEventListener) return promise;
            let rejectAbort;
            const aborted = new Promise((_, reject) => { rejectAbort = reject; });
            const onAbort = () => rejectAbort(abortError());
            signal.addEventListener('abort', onAbort, { once: true });
            try { return await Promise.race([promise, aborted]); }
            finally { signal.removeEventListener?.('abort', onAbort); }
        };
        const contentType = response?.headers?.get?.('Content-Type');
        if (contentType && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
            String(contentType)
        )) {
            throw new Error('invalid_didit_certification_content_type');
        }
        const declaredLength = response?.headers?.get?.('Content-Length');
        if (declaredLength !== null && declaredLength !== undefined
            && (!/^\d{1,8}$/.test(String(declaredLength))
                || Number(declaredLength) > maxBytes)) {
            try { await response?.body?.cancel?.(); } catch (_) {}
            throw new Error('invalid_didit_certification_response_size');
        }
        let text = '';
        const reader = response?.body?.getReader?.();
        if (reader) {
            const decoder = new TextDecoder('utf-8', { fatal: true });
            let total = 0;
            try {
                while (true) {
                    const chunk = await awaitWithAbort(reader.read());
                    if (chunk.done) break;
                    total += chunk.value?.byteLength || 0;
                    if (total > maxBytes) {
                        await reader.cancel?.().catch?.(() => {});
                        throw new Error('invalid_didit_certification_response_size');
                    }
                    text += decoder.decode(chunk.value, { stream: true });
                }
                text += decoder.decode();
            } finally {
                reader.releaseLock?.();
            }
        } else if (typeof response?.text === 'function') {
            text = await awaitWithAbort(response.text());
            if (new TextEncoder().encode(text).byteLength > maxBytes) {
                throw new Error('invalid_didit_certification_response_size');
            }
        } else if (typeof response?.json === 'function') {
            // Native fetch Responses always expose a byte stream or text().
            // This branch keeps deterministic unit-test doubles bounded too.
            const value = await awaitWithAbort(response.json());
            text = JSON.stringify(value);
            if (new TextEncoder().encode(text).byteLength > maxBytes) {
                throw new Error('invalid_didit_certification_response_size');
            }
        } else {
            throw new Error('invalid_didit_certification_response');
        }
        try { return JSON.parse(text); }
        catch (_) { throw new Error('invalid_didit_certification_response'); }
    }

    _partnersSanitizeKycCertificationPreflight(envelope) {
        const exactKeys = (value, expected) => value
            && typeof value === 'object'
            && !Array.isArray(value)
            && Object.keys(value).sort().join('|') === expected.slice().sort().join('|');
        const data = envelope?.data;
        const requirements = data?.requirements;
        const requirementKeys = [
            'privacy_approved', 'coverage_open', 'partners_membership_closed',
            'cash_payouts_closed', 'tv_relay_closed', 'revolut_api_closed',
            'aal2', 'fresh_aal2', 'provider_configured',
            'certification_window_open'
        ];
        if (!exactKeys(envelope, ['version', 'correlationId', 'data'])
            || envelope.version !== '2026-07-29'
            || !/^prt_[0-9a-f]{24}$/.test(String(envelope.correlationId || ''))
            || !exactKeys(data, [
                'schema_version', 'action', 'ready', 'requirements'
            ])
            || data.schema_version !== 1
            || data.action !== 'kyc_certification_preflight'
            || typeof data.ready !== 'boolean'
            || !exactKeys(requirements, requirementKeys)
            || requirementKeys.some((key) => typeof requirements[key] !== 'boolean')
            || (requirements.fresh_aal2 && !requirements.aal2)
            || data.ready !== requirementKeys.every((key) => requirements[key] === true)) {
            throw new Error('invalid_didit_certification_preflight');
        }
        return data;
    }

    async _partnersFetchKycCertificationPreflight() {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        try {
            const response = await fetch(
                `${this._sbUrl()}/functions/v1/norva-partners/kyc/certification/preflight`,
                {
                    method: 'GET',
                    headers: {
                        apikey: this._sbKey(),
                        Authorization: `Bearer ${this._token()}`
                    },
                    signal: controller.signal
                }
            );
            const envelope = await this._partnersReadBoundedJsonResponse(
                response,
                controller.signal,
                8_192
            );
            if (!response.ok) {
                const allowed = new Set([
                    'invalid_access_token', 'partners_action_not_allowed',
                    'partners_temporarily_unavailable'
                ]);
                const code = allowed.has(String(envelope?.error?.code || ''))
                    ? String(envelope.error.code)
                    : 'partners_temporarily_unavailable';
                const error = new Error(code);
                error.code = code;
                error.status = Number(response.status) || 0;
                throw error;
            }
            return this._partnersSanitizeKycCertificationPreflight(envelope);
        } catch (error) {
            if (error?.name === 'AbortError') {
                const timeoutError = new Error('didit_certification_preflight_timeout');
                timeoutError.code = 'didit_certification_preflight_timeout';
                throw timeoutError;
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    _partnersKycCertificationRequirementRows(preflight, factorAvailable) {
        const requirements = preflight?.requirements || {};
        return [
            {
                key: 'privacy_approved',
                ready: requirements.privacy_approved === true,
                label: 'Dossier Cash Privacy approuvé',
                detail: requirements.privacy_approved
                    ? 'AIPD, registre, notice et consentement sont enregistrés.'
                    : 'Le dossier Cash Privacy doit être approuvé dans Configuration.'
            },
            {
                key: 'coverage_open',
                ready: requirements.coverage_open === true,
                label: 'Certification de couverture encore ouverte',
                detail: requirements.coverage_open
                    ? 'La preuve Didit live peut encore être enregistrée.'
                    : 'La couverture a déjà été clôturée ; aucune nouvelle preuve ne peut partir.'
            },
            {
                key: 'partners_membership_closed',
                ready: requirements.partners_membership_closed === true,
                label: 'Adhésions Partners temporairement suspendues',
                detail: requirements.partners_membership_closed
                    ? 'Aucune adhésion ne peut intervenir pendant cette opération.'
                    : 'Suspendez brièvement les adhésions avant la certification.'
            },
            {
                key: 'cash_payouts_closed',
                ready: requirements.cash_payouts_closed === true,
                label: 'Virements live désactivés',
                detail: requirements.cash_payouts_closed
                    ? 'Aucun versement ne peut être déclenché pendant la certification.'
                    : 'Fermez la fenêtre de versement avant de continuer.'
            },
            {
                key: 'tv_relay_closed',
                ready: requirements.tv_relay_closed === true,
                label: 'Relais TV désactivé',
                detail: requirements.tv_relay_closed
                    ? 'Le parcours exceptionnel reste limité au Web Admin.'
                    : 'Désactivez le relais TV pour isoler la certification.'
            },
            {
                key: 'revolut_api_closed',
                ready: requirements.revolut_api_closed === true,
                label: 'API Revolut désactivée',
                detail: requirements.revolut_api_closed
                    ? 'Aucune automatisation bancaire ne peut intervenir.'
                    : 'Désactivez l’API Revolut avant de continuer.'
            },
            {
                key: 'provider_configured',
                ready: requirements.provider_configured === true,
                label: 'Configuration Didit live disponible',
                detail: requirements.provider_configured
                    ? 'Le workflow live et son callback sont chargés côté serveur.'
                    : 'La configuration Didit live doit être complétée côté serveur.'
            },
            {
                key: 'certification_window_open',
                ready: requirements.certification_window_open === true,
                label: 'Fenêtre de certification ouverte',
                detail: requirements.certification_window_open
                    ? 'Le coupe-circuit autorise uniquement cette certification.'
                    : 'Ouvrez la fenêtre supervisée avant de saisir des données.'
            },
            {
                key: 'factor_available',
                ready: factorAvailable === true,
                label: 'Application Authenticator disponible',
                detail: factorAvailable
                    ? 'Un facteur TOTP vérifié est associé à ce compte.'
                    : 'Configurez un facteur TOTP vérifié sur le compte Admin.'
            },
            {
                key: 'fresh_aal2',
                ready: requirements.fresh_aal2 === true,
                pending: requirements.fresh_aal2 !== true,
                label: 'Session Authenticator récente',
                detail: requirements.fresh_aal2
                    ? 'La session a été renforcée il y a moins de dix minutes.'
                    : 'Le code demandé ci-dessous renouvellera la session juste avant Didit.'
            }
        ];
    }

    async _partnersKycCertificationDialog({ preflight, resuming = false } = {}) {
        const auth = window.NorvaAuth;
        let factors = [];
        let mfaFailure = '';
        try {
            const status = await auth?.getMfaStatus?.();
            factors = Array.isArray(status?.factors)
                ? status.factors.filter((factor) => factor?.type === 'totp'
                    && typeof factor?.id === 'string' && factor.id.length > 0)
                : [];
        } catch (error) {
            mfaFailure = this._partnersMfaFailureMessage(error);
        }
        const rows = this._partnersKycCertificationRequirementRows(
            preflight,
            factors.length > 0
        );
        const hardBlockers = rows.filter((row) => !row.ready && !row.pending);
        const formAvailable = hardBlockers.length === 0 && factors.length > 0
            && auth?.challengeAndVerifyMfa;
        return new Promise((resolve) => {
            const root = document.getElementById('page-admin') || document.body;
            const shell = root.querySelector?.('.crm-shell');
            const previousFocus = document.activeElement;
            const uid = `partners-kyc-guide-${this._modalSeq = (this._modalSeq || 0) + 1}`;
            const back = document.createElement('div');
            back.className = 'crm-modal-back';
            back.setAttribute('role', 'dialog');
            back.setAttribute('aria-modal', 'true');
            back.setAttribute('aria-labelledby', `${uid}-title`);
            back.setAttribute('aria-describedby', `${uid}-intro`);
            const rowMarkup = rows.map((row) => {
                const state = row.ready ? 'Prêt' : (row.pending ? 'À valider' : 'À régler');
                const klass = row.ready ? 'is-ready' : (row.pending ? 'is-pending' : 'is-blocked');
                return `<li class="partners-kyc-guide-item ${klass}" data-kyc-requirement="${AdminPage.esc(row.key)}">
                    <span><strong>${AdminPage.esc(row.label)}</strong><small>${AdminPage.esc(row.detail)}</small></span>
                    <span class="partners-kyc-guide-state">${AdminPage.esc(state)}</span>
                  </li>`;
            }).join('');
            const factorMarkup = factors.length > 1
                ? `<div class="partners-kyc-guide-field">
                    <label for="${uid}-factor">Application Authenticator</label>
                    <select id="${uid}-factor">${factors.map((factor, index) => (
                        `<option value="${index}">${AdminPage.esc(factor.label || `Authenticator ${index + 1}`)}</option>`
                    )).join('')}</select>
                    <small>Choisissez l’application qui affichera le code à six chiffres.</small>
                  </div>`
                : '';
            const startFields = resuming ? '' : `
                <label class="partners-kyc-guide-consent" for="${uid}-consent">
                  <input id="${uid}-consent" type="checkbox" />
                  <span>J’accepte d’utiliser ma propre pièce d’identité et ma biométrie dans le parcours hébergé Didit. Cette opération peut consommer un crédit, mais ne crée aucun partenaire et n’active aucun paiement.</span>
                </label>
                <div class="partners-kyc-guide-field">
                  <label for="${uid}-confirmation">Confirmation de sécurité</label>
                  <input id="${uid}-confirmation" type="text" autocomplete="off" maxlength="16" spellcheck="false" placeholder="CERTIFIER DIDIT" />
                  <small>Saisissez exactement « CERTIFIER DIDIT ».</small>
                </div>
                <div class="partners-kyc-guide-field">
                  <label for="${uid}-justification">Motif enregistré dans l’audit</label>
                  <textarea id="${uid}-justification" maxlength="1000" rows="3">Certification live Didit supervisée avant ouverture du parcours KYC cash.</textarea>
                  <small>Décrivez brièvement pourquoi cette preuve est réalisée aujourd’hui.</small>
                </div>`;
            const formMarkup = formAvailable ? `
              <form class="partners-kyc-guide-form" novalidate>
                ${factorMarkup}${startFields}
                <div class="partners-kyc-guide-field">
                  <label for="${uid}-totp">Code Authenticator à 6 chiffres</label>
                  <input id="${uid}-totp" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" />
                  <small>Norva ne conserve jamais ce code.</small>
                </div>
              </form>` : '';
            const lead = formAvailable
                ? (resuming
                    ? 'Tous les prérequis externes sont prêts. Validez Authenticator pour reprendre la session Didit existante.'
                    : 'Tous les prérequis externes sont prêts. Consentement, confirmation, motif et Authenticator sont regroupés ici avant l’unique départ vers Didit.')
                : 'La certification ne peut pas démarrer. Réglez d’abord chaque élément marqué « À régler » ; aucun champ sensible n’est affiché.';
            back.innerHTML = `<section class="crm-modal is-wide partners-kyc-guide">
                <div class="partners-kyc-guide-head">
                  <h3 id="${uid}-title">${resuming ? 'Reprendre la vérification Didit' : 'Préparer la vérification Didit'}</h3>
                  <p id="${uid}-intro">${AdminPage.esc(lead)}</p>
                </div>
                ${mfaFailure ? `<div class="partners-kyc-guide-alert">${AdminPage.esc(mfaFailure)}</div>` : ''}
                <ul class="partners-kyc-guide-list" aria-label="Prérequis de sécurité">${rowMarkup}</ul>
                ${formMarkup}
                <div class="partners-kyc-guide-alert" role="alert" aria-live="assertive" hidden></div>
                <div class="mrow">
                  <button class="cancel" type="button">Fermer</button>
                  ${formAvailable ? `<button class="ok primary" type="button" disabled>${resuming ? 'Vérifier et reprendre Didit' : 'Vérifier et ouvrir Didit'}</button>` : ''}
                </div>
              </section>`;
            root.appendChild(back);
            if (shell) shell.setAttribute('inert', '');
            const modal = back.querySelector('.partners-kyc-guide');
            const cancelButton = back.querySelector('.cancel');
            const submitButton = back.querySelector('.ok');
            const factorSelect = back.querySelector(`#${uid}-factor`);
            const consent = back.querySelector(`#${uid}-consent`);
            const confirmation = back.querySelector(`#${uid}-confirmation`);
            const justification = back.querySelector(`#${uid}-justification`);
            const totp = back.querySelector(`#${uid}-totp`);
            const alert = back.querySelector('[role="alert"]');
            let busy = false;
            const focusables = () => Array.from(back.querySelectorAll(
                'input,select,textarea,button'
            )).filter((element) => !element.disabled && !element.hidden);
            const finish = (value) => {
                if (busy && value === null) return;
                document.removeEventListener('keydown', onKey, true);
                if (shell) shell.removeAttribute('inert');
                if (totp) totp.value = '';
                back.remove();
                try { previousFocus?.focus?.({ preventScroll: true }); } catch (_) {}
                resolve(value);
            };
            const valid = () => {
                if (!formAvailable || !/^\d{6}$/.test(String(totp?.value || '').trim())) {
                    return false;
                }
                if (resuming) return true;
                const reason = String(justification?.value || '').trim();
                return consent?.checked === true
                    && String(confirmation?.value || '').trim() === 'CERTIFIER DIDIT'
                    && reason.length >= 12 && reason.length <= 1000
                    && !/[\u0000-\u001f\u007f]/.test(reason);
            };
            const update = () => {
                if (submitButton) submitButton.disabled = busy || !valid();
                if (alert && !busy) alert.hidden = true;
            };
            const onKey = (event) => {
                if (event.key === 'Escape' || event.key === 'GoBack'
                    || event.key === 'BrowserBack') {
                    event.preventDefault();
                    finish(null);
                    return;
                }
                if (event.key === 'Tab') {
                    const available = focusables();
                    if (!available.length) return;
                    const first = available[0];
                    const last = available[available.length - 1];
                    if (event.shiftKey && (document.activeElement === first
                        || !back.contains(document.activeElement))) {
                        event.preventDefault();
                        last.focus();
                    } else if (!event.shiftKey && (document.activeElement === last
                        || !back.contains(document.activeElement))) {
                        event.preventDefault();
                        first.focus();
                    }
                }
            };
            const showError = (message) => {
                if (!alert) return;
                alert.textContent = message;
                alert.hidden = false;
                modal?.scrollTo?.({ top: modal.scrollHeight, behavior: 'smooth' });
            };
            const submit = async () => {
                if (busy || !valid()) return;
                busy = true;
                submitButton.disabled = true;
                submitButton.setAttribute('aria-busy', 'true');
                submitButton.textContent = 'Validation sécurisée…';
                const factorIndex = factorSelect ? Number(factorSelect.value) : 0;
                const factor = factors[factorIndex];
                try {
                    await auth.challengeAndVerifyMfa({
                        code: String(totp.value).trim(),
                        factorId: factor.id,
                        forceFresh: true
                    });
                    const refreshed = await this._partnersFetchKycCertificationPreflight();
                    if (!refreshed.ready) {
                        const error = new Error('didit_certification_prerequisites_changed');
                        error.code = 'didit_certification_prerequisites_changed';
                        throw error;
                    }
                    finish({
                        confirmation: resuming ? '' : 'CERTIFIER DIDIT',
                        justification: resuming
                            ? '' : String(justification.value || '').trim()
                    });
                } catch (error) {
                    busy = false;
                    if (totp) {
                        totp.value = '';
                        totp.focus();
                    }
                    submitButton.removeAttribute('aria-busy');
                    submitButton.textContent = resuming
                        ? 'Vérifier et reprendre Didit' : 'Vérifier et ouvrir Didit';
                    showError(error?.code === 'didit_certification_prerequisites_changed'
                        ? 'Un prérequis a changé pendant la validation. Fermez cette fenêtre, vérifiez la configuration puis recommencez.'
                        : this._partnersMfaFailureMessage(error));
                    update();
                }
            };
            back.querySelectorAll('input,select,textarea').forEach((element) => {
                element.addEventListener('input', update);
                element.addEventListener('change', update);
            });
            back.querySelector('form')?.addEventListener('submit', (event) => {
                event.preventDefault();
                void submit();
            });
            submitButton?.addEventListener('click', () => { void submit(); });
            cancelButton.addEventListener('click', () => finish(null));
            back.addEventListener('mousedown', (event) => {
                if (event.target === back) finish(null);
            });
            document.addEventListener('keydown', onKey, true);
            update();
            (formAvailable ? (consent || factorSelect || totp) : cancelButton)?.focus?.();
        });
    }

    _partnersIsDeterministicKycCertificationError(error) {
        return new Set([
            'didit_certification_disabled', 'provider_not_configured',
            'partners_action_not_allowed', 'invalid_access_token',
            'invalid_request', 'idempotency_key_reused'
        ]).has(String(error?.code || ''));
    }

    _partnersLoadFinanceView({ force = false } = {}) {
        const load = (key, fn, params, render, targetId, title, extra = {}) => this._partnersLoadModule(
            key, fn, params, render, { force, targetId, title, ...extra }
        );
        const renderPayoutCycles = (data) => {
            if (!this._partnersIsPagedEnvelope(data)) {
                throw new Error('invalid_partners_payout_cycles_response');
            }
            this._renderPartnersPayouts(data, this._partnersCache.get('manualBatches'));
        };
        const renderManualBatches = (data) => {
            if (!this._partnersIsPagedEnvelope(data)) {
                throw new Error('invalid_partners_manual_batches_response');
            }
            this._renderPartnersPayouts(this._partnersCache.get('payoutCycles'), data);
        };
        const payoutError = (key) => () => this._renderPartnersPayouts(
            key === 'payoutCycles' ? null : this._partnersCache.get('payoutCycles'),
            key === 'manualBatches' ? null : this._partnersCache.get('manualBatches'),
            { failedKey: key }
        );
        return Promise.allSettled([
            this._partnersLoadCapabilities({ force }),
            this._partnersLoadPayoutOnboardingRequests({ force }),
            load('finance', 'admin_partners_finance_overview', {}, (d) => this._renderPartnersFinance(d), 'partners-admin-finance', 'Ledger Partners'),
            load('payoutCycles', 'admin_partners_payout_cycles', { p_limit: 8, p_offset: 0, p_status: null }, renderPayoutCycles, 'partners-admin-payouts', 'Cycles de versement', { onError: payoutError('payoutCycles') }),
            load('revolut', 'admin_partners_revolut_payout_status', {}, (d) => this._renderPartnersRevolutStatus(d), 'partners-admin-revolut', 'Revolut Business'),
            load('manualBatches', 'admin_partners_revolut_manual_batches', { p_limit: 25, p_offset: 0, p_status: 'all' }, renderManualBatches, 'partners-admin-payouts', 'Lots manuels', { onError: payoutError('manualBatches') }),
            load('settlements', 'admin_partners_revolut_reconciliation_queue', { p_limit: 25, p_offset: 0, p_status: 'all' }, (d) => this._renderPartnersRevolutReconciliation(d), 'partners-admin-settlements', 'Rapprochement Revolut'),
            load('returns', 'admin_partners_revolut_return_queue', { p_limit: 25, p_offset: 0, p_status: 'all' }, (d) => this._renderPartnersRevolutReturns(d), 'partners-admin-returns', 'Retours Revolut'),
            load('manualControls', 'admin_partners_revolut_manual_controls_queue', { p_limit: 50, p_offset: 0, p_status: 'all' }, (d) => this._renderPartnersRevolutManualControls(d), 'partners-admin-manual-controls', 'Contrôles manuels'),
            load('lateCompletions', 'admin_partners_revolut_late_completion_queue', { p_limit: 50, p_offset: 0, p_status: 'all' }, (d) => this._renderPartnersRevolutLateCompletions(d), 'partners-admin-late-completions', 'Paiements tardifs'),
            this._partnersLoadIncidents({ force })
        ]);
    }

    async _partnersLoadPayoutOnboardingRequests({ force = false, preserveFocus = '' } = {}) {
        const generation = this._partnersPageGeneration;
        const requestedView = this._partnersView;
        const status = ['pending', 'in_progress', 'rejected', 'completed', 'all']
            .includes(this._partnersPayoutOnboardingStatus)
            ? this._partnersPayoutOnboardingStatus : 'pending';
        const search = String(this._partnersPayoutOnboardingSearch || '')
            .toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 64);
        const data = await this._partnersLoadModule(
            'payoutOnboardingRequests',
            'admin_partners_payout_onboarding_requests',
            {
                p_limit: this._partnersPayoutOnboardingLimit,
                p_offset: this._partnersPayoutOnboardingOffset,
                p_status: status,
                p_search: search || null
            },
            (value) => this._renderPartnersPayoutOnboardingRequests(value),
            {
                force,
                targetId: 'partners-admin-payout-onboarding',
                title: 'Demandes de configuration de versement'
            }
        );
        if (preserveFocus && this._route === 'partners'
            && generation === this._partnersPageGeneration
            && requestedView === this._partnersView) setTimeout(() => {
            let target = preserveFocus === 'search'
                ? document.getElementById('partners-payout-onboarding-search')
                : (preserveFocus === 'status'
                    ? document.getElementById('partners-payout-onboarding-status')
                    : Array.from(document.querySelectorAll('[data-partners-payout-onboarding-page]'))
                        .find((button) => button.dataset.partnersPayoutOnboardingPage === preserveFocus));
            if (target?.disabled && ['prev', 'next'].includes(preserveFocus)) {
                const fallback = preserveFocus === 'next' ? 'prev' : 'next';
                target = Array.from(document.querySelectorAll('[data-partners-payout-onboarding-page]'))
                    .find((button) => button.dataset.partnersPayoutOnboardingPage === fallback
                        && !button.disabled)
                    || document.getElementById('partners-payout-onboarding-search');
            }
            this._partnersFocusElement(target);
        }, 0);
        return data;
    }

    async _partnersLoadFiscalProfiles({ force = false, preserveFocus = '' } = {}) {
        const generation = this._partnersPageGeneration;
        const requestedView = this._partnersView;
        const status = ['pending', 'verified', 'rejected', 'expired', 'all']
            .includes(this._partnersFiscalStatus)
            ? this._partnersFiscalStatus : 'pending';
        const search = String(this._partnersFiscalSearch || '')
            .toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 64);
        const data = await this._partnersLoadModule(
            'fiscalProfiles',
            'admin_partners_fiscal_profiles',
            {
                p_limit: this._partnersFiscalLimit,
                p_offset: this._partnersFiscalOffset,
                p_status: status,
                p_search: search || null
            },
            (value) => this._renderPartnersFiscalProfiles(value),
            {
                force,
                targetId: 'partners-admin-fiscal-profiles',
                title: 'Résidences fiscales à examiner'
            }
        );
        if (preserveFocus && this._route === 'partners'
            && generation === this._partnersPageGeneration
            && requestedView === this._partnersView) setTimeout(() => {
            let target = preserveFocus === 'search'
                ? document.getElementById('partners-fiscal-search')
                : (preserveFocus === 'status'
                    ? document.getElementById('partners-fiscal-status')
                    : Array.from(document.querySelectorAll('[data-partners-fiscal-page]'))
                        .find((button) => button.dataset.partnersFiscalPage === preserveFocus));
            if (target?.disabled && ['prev', 'next'].includes(preserveFocus)) {
                const fallback = preserveFocus === 'next' ? 'prev' : 'next';
                target = Array.from(document.querySelectorAll('[data-partners-fiscal-page]'))
                    .find((button) => button.dataset.partnersFiscalPage === fallback
                        && !button.disabled)
                    || document.getElementById('partners-fiscal-search');
            }
            this._partnersFocusElement(target);
        }, 0);
        return data;
    }

    async _partnersLoadIncidents({ force = false, preserveFocus = '' } = {}) {
        const generation = this._partnersPageGeneration;
        const requestedView = this._partnersView;
        const filter = ['action_required', 'open', 'quarantined', 'resolved', 'all']
            .includes(this._partnersIncidentFilter) ? this._partnersIncidentFilter : 'action_required';
        const offset = Number.isSafeInteger(this._partnersIncidentOffset)
            && this._partnersIncidentOffset >= 0 ? this._partnersIncidentOffset : 0;
        const data = await this._partnersLoadModule(
            'incidents',
            'admin_partners_revolut_reconciliation_incidents',
            { p_limit: 25, p_offset: offset, p_status: filter },
            (value) => this._renderPartnersRevolutIncidents(value),
            { force, targetId: 'partners-admin-reconciliation-incidents', title: 'Écarts de rapprochement' }
        );
        if (preserveFocus && this._route === 'partners'
            && generation === this._partnersPageGeneration
            && requestedView === this._partnersView) setTimeout(() => {
            let target = preserveFocus === 'filter'
                ? document.getElementById('partners-revolut-incident-filter')
                : Array.from(document.querySelectorAll('[data-partners-action="revolut-incident-page"]'))
                    .find((button) => button.dataset.partnersPageDirection === preserveFocus);
            if (target?.disabled && ['prev', 'next'].includes(preserveFocus)) {
                const fallback = preserveFocus === 'next' ? 'prev' : 'next';
                target = Array.from(document.querySelectorAll('[data-partners-action="revolut-incident-page"]'))
                    .find((button) => button.dataset.partnersPageDirection === fallback && !button.disabled)
                    || document.getElementById('partners-revolut-incident-filter');
            }
            this._partnersFocusElement(target);
        }, 0);
        return data;
    }

    _partnersSelectView(view, { focusTab = false, restoreScroll = true } = {}) {
        const views = ['overview', 'partners', 'risk', 'finance', 'configuration'];
        if (!views.includes(view)) return;
        const main = document.querySelector('#page-admin .crm-main');
        if (!(this._partnersScrollByView instanceof Map)) this._partnersScrollByView = new Map();
        if (main && this._partnersView) this._partnersScrollByView.set(this._partnersView, main.scrollTop);
        this._partnersView = view;
        document.querySelectorAll('#page-admin .partners-workspace-tab').forEach((tab) => {
            const selected = tab.dataset.partnersView === view;
            tab.setAttribute('aria-selected', selected ? 'true' : 'false');
            tab.tabIndex = selected ? 0 : -1;
        });
        document.querySelectorAll('#page-admin .partners-pane').forEach((pane) => {
            pane.hidden = pane.id !== `partners-pane-${view}`;
        });
        const status = document.getElementById('partners-view-status');
        const active = document.getElementById(`partners-tab-${view}`);
        if (status && active) status.textContent = `Vue ${active.textContent.trim()} affichée`;
        this._partnersLoadView(view);
        setTimeout(() => {
            if (main && restoreScroll) main.scrollTop = this._partnersScrollByView.get(view) || 0;
            if (focusTab && this._partnersFocusElement(active)) {
                active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
            }
        }, 0);
    }

    _partnersCaptureFocus(element = document.activeElement) {
        if (!element) return null;
        const data = {};
        Object.keys(element.dataset || {})
            .filter((key) => (key.startsWith('partners') || key === 'partnerId')
                && !['partnersBusy', 'partnersEnabled'].includes(key))
            .forEach((key) => { data[key] = element.dataset[key]; });
        const fallback = element.closest?.('[id^="partners-admin-"],[id^="partners-pane-"]');
        const descriptor = { id: element.id || '', data };
        if (fallback?.id) descriptor.fallbackId = fallback.id;
        return descriptor;
    }

    _partnersFocusElement(target) {
        if (!target || target.disabled || target.closest?.('[hidden]')) return false;
        const tag = String(target.tagName || '').toLowerCase();
        const naturallyFocusable = ['a', 'button', 'input', 'select', 'textarea', 'summary']
            .includes(tag) || target.hasAttribute?.('tabindex');
        if (!naturallyFocusable) target.setAttribute?.('tabindex', '-1');
        target.focus?.({ preventScroll: true });
        return typeof target.focus === 'function';
    }

    _partnersRestoreFocus(descriptor) {
        if (!descriptor) return false;
        let target = descriptor.id ? document.getElementById(descriptor.id) : null;
        if (!target && descriptor.data && Object.keys(descriptor.data).length) {
            target = Array.from(document.querySelectorAll('[data-partners-action],[data-partners-retry],[data-partners-view],[data-partners-account-page],[data-partners-access-request-page],[data-partners-payout-onboarding-page],[data-partners-fiscal-page],[data-partners-route-page],[data-partners-policy-page],[data-partner-id]'))
                .find((candidate) => Object.entries(descriptor.data).every(([key, value]) => candidate.dataset[key] === value));
        }
        if (this._partnersFocusElement(target)) return true;
        const fallback = descriptor.fallbackId
            ? document.getElementById(descriptor.fallbackId) : null;
        return this._partnersFocusElement(fallback);
    }

    _partnersRememberContext(element) {
        const main = document.querySelector('#page-admin .crm-main');
        this._partnersRestoreContext = {
            view: this._partnersView,
            scrollTop: main?.scrollTop || 0,
            focus: this._partnersCaptureFocus(element)
        };
    }

    async _partnersRefreshVisibleView({ focusDescriptor = null } = {}) {
        if (this._route !== 'partners') return;
        const generation = this._partnersPageGeneration;
        const view = this._partnersView;
        const main = document.querySelector('#page-admin .crm-main');
        const scrollTop = main?.scrollTop || 0;
        const focus = focusDescriptor || this._partnersCaptureFocus();
        const loads = [
            this._partnersLoadOverview({ force: true }),
            this._partnersLoadView(view, { force: true })
        ];
        await Promise.allSettled(loads);
        if (this._route !== 'partners' || generation !== this._partnersPageGeneration
            || view !== this._partnersView) return;
        if (main) main.scrollTop = scrollTop;
        if (!this._partnersRestoreFocus(focus)) {
            document.getElementById(`partners-tab-${view}`)?.focus?.({ preventScroll: true });
        }
    }

    async _partnersRetryModule(key, element = document.activeElement) {
        const focus = this._partnersCaptureFocus(element);
        const load = (moduleKey, fn, params, render, targetId, title, extra = {}) => this._partnersLoadModule(
            moduleKey, fn, params, render, { force: true, targetId, title, ...extra }
        );
        const renderPayoutCycles = (data) => {
            if (!this._partnersIsPagedEnvelope(data)) {
                throw new Error('invalid_partners_payout_cycles_response');
            }
            this._renderPartnersPayouts(data, this._partnersCache.get('manualBatches'));
        };
        const renderManualBatches = (data) => {
            if (!this._partnersIsPagedEnvelope(data)) {
                throw new Error('invalid_partners_manual_batches_response');
            }
            this._renderPartnersPayouts(this._partnersCache.get('payoutCycles'), data);
        };
        const payoutError = (moduleKey) => () => this._renderPartnersPayouts(
            moduleKey === 'payoutCycles' ? null : this._partnersCache.get('payoutCycles'),
            moduleKey === 'manualBatches' ? null : this._partnersCache.get('manualBatches'),
            { failedKey: moduleKey }
        );
        const map = {
            overview: () => this._partnersLoadOverview({ force: true }),
            capabilities: () => this._partnersLoadCapabilities({ force: true }),
            capabilityOperators: () => this._partnersLoadCapabilities({ force: true }),
            accessRequests: () => this._partnersLoadAccessRequests({ force: true }),
            accounts: () => this._partnersLoadAccounts({ force: true }),
            monitoring: () => load('monitoring', 'admin_partners_monitoring', {}, (d) => this._renderPartnersMonitoring(d), 'partners-admin-monitoring', 'Supervision'),
            analytics: () => load('analytics', 'admin_partners_analytics', { p_days: 30 }, (d) => this._renderPartnersAnalytics(d), 'partners-admin-analytics', 'Performance Partners'),
            kyc: () => load('kyc', 'admin_partners_kyc_quota', {}, (d) => this._renderPartnersKycQuota(d), 'partners-admin-kyc', 'KYC individuel'),
            kycCertification: () => this._partnersLoadKycCertification({ force: true }),
            risk: () => load('risk', 'admin_partners_risk_queue', { p_limit: 8, p_offset: 0, p_status: null }, (d) => this._renderPartnersRisk(d), 'partners-admin-risk', 'Risque'),
            kycHumanReviews: () => load('kycHumanReviews', 'admin_partners_kyc_human_review_queue', { p_limit: 25, p_offset: 0, p_status: 'all' }, (d) => this._renderPartnersKycHumanReviews(d), 'partners-admin-kyc-human-reviews', 'Recours humains KYC'),
            fiscalProfiles: () => this._partnersLoadFiscalProfiles({ force: true }),
            configuration: () => load('configuration', 'admin_partners_configuration', {}, (d) => this._renderPartnersConfiguration(d), 'partners-admin-configuration', 'Configuration Partners'),
            revolut: () => load('revolut', 'admin_partners_revolut_payout_status', {}, (d) => this._renderPartnersRevolutStatus(d), this._partnersView === 'configuration' ? 'partners-admin-routes' : 'partners-admin-revolut', 'Revolut Business'),
            finance: () => load('finance', 'admin_partners_finance_overview', {}, (d) => this._renderPartnersFinance(d), 'partners-admin-finance', 'Ledger Partners'),
            payoutOnboardingRequests: () => this._partnersLoadPayoutOnboardingRequests({ force: true }),
            payoutCycles: () => load('payoutCycles', 'admin_partners_payout_cycles', { p_limit: 8, p_offset: 0, p_status: null }, renderPayoutCycles, 'partners-admin-payouts', 'Cycles de versement', { onError: payoutError('payoutCycles') }),
            manualBatches: () => load('manualBatches', 'admin_partners_revolut_manual_batches', { p_limit: 25, p_offset: 0, p_status: 'all' }, renderManualBatches, 'partners-admin-payouts', 'Lots manuels', { onError: payoutError('manualBatches') }),
            settlements: () => load('settlements', 'admin_partners_revolut_reconciliation_queue', { p_limit: 25, p_offset: 0, p_status: 'all' }, (d) => this._renderPartnersRevolutReconciliation(d), 'partners-admin-settlements', 'Rapprochement Revolut'),
            returns: () => load('returns', 'admin_partners_revolut_return_queue', { p_limit: 25, p_offset: 0, p_status: 'all' }, (d) => this._renderPartnersRevolutReturns(d), 'partners-admin-returns', 'Retours Revolut'),
            manualControls: () => load('manualControls', 'admin_partners_revolut_manual_controls_queue', { p_limit: 50, p_offset: 0, p_status: 'all' }, (d) => this._renderPartnersRevolutManualControls(d), 'partners-admin-manual-controls', 'Contrôles manuels'),
            lateCompletions: () => load('lateCompletions', 'admin_partners_revolut_late_completion_queue', { p_limit: 50, p_offset: 0, p_status: 'all' }, (d) => this._renderPartnersRevolutLateCompletions(d), 'partners-admin-late-completions', 'Paiements tardifs'),
            incidents: () => this._partnersLoadIncidents({ force: true })
        };
        const result = map[key]
            ? map[key]()
            : this._partnersLoadView(this._partnersView, { force: true });
        await Promise.resolve(result);
        if (!this._partnersRestoreFocus(focus)) {
            document.getElementById(`partners-tab-${this._partnersView}`)?.focus?.({ preventScroll: true });
        }
    }

    _renderPartnersAdminSummary(overview, capabilityEnvelope = null) {
        const el = document.getElementById('partners-admin-summary');
        const readiness = document.getElementById('partners-admin-readiness');
        if (!el || !readiness) return;
        const accountStatuses = overview.account_statuses && typeof overview.account_statuses === 'object'
            ? overview.account_statuses : {};
        const verificationStatuses = overview.verification_statuses && typeof overview.verification_statuses === 'object'
            ? overview.verification_statuses : {};
        const linkStatuses = overview.link_statuses && typeof overview.link_statuses === 'object'
            ? overview.link_statuses : {};
        const counts = {
            total: overview.accounts_total,
            active: accountStatuses.active,
            pending_verification: Number(verificationStatuses.pending || 0)
                + Number(verificationStatuses.not_started || 0),
            held: accountStatuses.held,
            suspended: accountStatuses.suspended,
            links_active: linkStatuses.active
        };
        const metric = (value, label, cls = '') => {
            const number = Number(value);
            const rendered = Number.isSafeInteger(number) && number >= 0 ? AdminPage.n(number) : '—';
            return `<div class="cs-item ${cls}"><div class="cs-tx"><div class="cs-v">${rendered}</div><div class="cs-l">${AdminPage.esc(label)}</div></div></div>`;
        };
        el.removeAttribute('aria-busy');
        el.classList?.remove('is-loading');
        el.innerHTML = [
            metric(counts.total, 'Comptes'),
            metric(counts.active, 'Actifs', 'ok'),
            metric(counts.pending_verification, 'KYC en attente', Number(counts.pending_verification) > 0 ? 'warn' : ''),
            metric(counts.held, 'En revue', Number(counts.held) > 0 ? 'warn' : ''),
            metric(counts.suspended, 'Suspendus', Number(counts.suspended) > 0 ? 'alert' : ''),
            metric(counts.links_active, 'Liens actifs', 'ok')
        ].join('');
        readiness.removeAttribute('aria-busy');
        const capabilities = capabilityEnvelope?.schema_version === 1
            && capabilityEnvelope.capabilities
            ? capabilityEnvelope.capabilities
            : (overview.readiness || {});
        const canManage = capabilityEnvelope?.schema_version === 1
            && capabilityEnvelope?.can_manage === true;
        this._partnersCanManageCapabilities = canManage;
        readiness.innerHTML = this._partnersCapabilityCards(
            capabilities,
            canManage,
            this._partnersCapabilityOperators
        );
    }

    _partnersValidCapabilityOperator(operator) {
        const operatorKey = /^op_[0-9a-f]{64}$/;
        return operator && typeof operator === 'object'
            && JSON.stringify(Object.keys(operator).sort())
                === JSON.stringify([
                    'account_active', 'capabilities', 'email', 'email_confirmed', 'is_admin',
                    'operator_key', 'totp_verified'
                ])
            && operatorKey.test(String(operator.operator_key || ''))
            && typeof operator.email === 'string'
            && operator.email.length > 0
            && operator.email.length <= 320
            && typeof operator.is_admin === 'boolean'
            && typeof operator.account_active === 'boolean'
            && typeof operator.email_confirmed === 'boolean'
            && typeof operator.totp_verified === 'boolean'
            && operator.capabilities && typeof operator.capabilities === 'object'
            && JSON.stringify(Object.keys(operator.capabilities).sort())
                === JSON.stringify(['finance', 'risk', 'support'])
            && ['support', 'risk', 'finance']
                .every((key) => typeof operator.capabilities[key] === 'boolean');
    }

    _partnersRenderCapabilitiesArea(capabilityEnvelope = this._partnersCache.get('capabilities')) {
        const readiness = document.getElementById('partners-admin-readiness');
        if (!readiness) return;
        const valid = capabilityEnvelope?.schema_version === 1
            && capabilityEnvelope?.capabilities
            && typeof capabilityEnvelope.capabilities === 'object';
        if (!valid) return;
        readiness.removeAttribute('aria-busy');
        readiness.innerHTML = this._partnersCapabilityCards(
            capabilityEnvelope.capabilities,
            capabilityEnvelope.can_manage === true,
            this._partnersCapabilityOperators
        );
    }

    _partnersCapabilityCards(capabilities, canManage = false, operators = undefined) {
        const hasRoleContract = ['support', 'risk', 'finance']
            .some((key) => typeof capabilities?.[key] === 'boolean');
        const rows = hasRoleContract
            ? [
                ['support', 'Support', 'Compte, contrat et historique pseudonymisé'],
                ['risk', 'Risque', 'Revue KYC, hold et fraude minimisée'],
                ['finance', 'Finance', 'Ledger, réconciliation et versements']
            ]
            : [
                ['fraud_workbench', 'Fraude et risque', 'Hold, release et contre-écritures'],
                ['financial_ledger', 'Ledger de commissions', 'Écritures financières et rapprochement'],
                ['payout_operations', 'Versements', 'Dry-run, approbation et envoi provider']
            ];
        const personalCards = rows.map(([key, label, copy]) => {
            const value = capabilities?.[key];
            const ready = value === true || value?.ready === true;
            const detail = ready
                ? (value?.label || 'Capacité serveur disponible')
                : (value?.label || capabilities?.reason || 'Non configuré — aucune action live exposée');
            return `<article class="partners-admin-cap${ready ? ' is-ready' : ''}">
                <strong>${AdminPage.esc(label)}</strong>
                <span>${AdminPage.esc(copy)}<br>${AdminPage.esc(detail)}</span>
            </article>`;
        }).join('');
        if (!canManage || !hasRoleContract) return personalCards;
        return `${personalCards}${this._partnersCapabilityOperatorsMarkup(operators)}`;
    }

    _partnersCapabilityOperatorsMarkup(operators) {
        let body;
        if (operators === undefined) {
            body = '<div class="ssub" role="status">Chargement des opérateurs autorisés…</div>';
        } else if (operators === null) {
            body = `<div class="admin-err" role="status">La liste des opérateurs est indisponible.
                <button type="button" class="partners-action" data-partners-retry="capabilityOperators">Réessayer</button></div>`;
        } else if (!operators.length) {
            body = '<div class="admin-err" role="status">Aucun compte Admin confirmé n’est disponible. Créez ou promouvez d’abord un second compte Admin, puis activez son TOTP.</div>';
        } else {
            const capabilityLabels = { support: 'Support', risk: 'Risque', finance: 'Finance' };
            const rows = operators.map((operator) => {
                const eligible = operator.is_admin
                    && operator.account_active
                    && operator.email_confirmed;
                const status = [
                    `<span class="partners-operator-chip${operator.is_admin ? ' is-ready' : ''}">${operator.is_admin ? 'Admin' : 'Rôle retiré'}</span>`,
                    `<span class="partners-operator-chip${operator.account_active ? ' is-ready' : ''}">${operator.account_active ? 'Compte actif' : 'Compte suspendu'}</span>`,
                    `<span class="partners-operator-chip${operator.email_confirmed ? ' is-ready' : ''}">${operator.email_confirmed ? 'E-mail confirmé' : 'E-mail non confirmé'}</span>`,
                    `<span class="partners-operator-chip${operator.totp_verified ? ' is-ready' : ''}">${operator.totp_verified ? 'TOTP vérifié' : 'TOTP requis'}</span>`
                ].join('');
                const actions = Object.entries(capabilityLabels).map(([key, label]) => {
                    const enabled = operator.capabilities[key] === true;
                    const canEnable = eligible && (key !== 'finance' || operator.totp_verified);
                    const disabled = !enabled && !canEnable;
                    const reason = !operator.account_active
                        ? 'Le compte est supprimé, suspendu ou banni.'
                        : (!eligible
                            ? 'Le compte doit être Admin et confirmé.'
                        : (key === 'finance' && !operator.totp_verified
                            ? 'Un TOTP vérifié est obligatoire pour Finance.'
                            : ''));
                    return `<button type="button" class="partners-action${enabled ? ' is-danger' : ' is-success'}"
                        data-partners-action="capability"
                        data-partners-capability="${key}"
                        data-partners-operator-key="${AdminPage.esc(operator.operator_key)}"
                        data-partners-operator-email="${AdminPage.esc(operator.email)}"
                        data-partners-enabled="${enabled ? 'false' : 'true'}"
                        aria-label="${enabled ? 'Retirer' : 'Activer'} la capacité ${label} pour ${AdminPage.esc(operator.email)}"
                        ${disabled ? `disabled title="${AdminPage.esc(reason)}"` : ''}>
                        ${enabled ? `Retirer ${label}` : `Activer ${label}`}
                    </button>`;
                }).join('');
                return `<tr>
                    <td data-label="Opérateur"><div class="partners-operator-identity"><strong>${AdminPage.esc(operator.email)}</strong>
                        <div class="partners-operator-status">${status}</div></div></td>
                    <td data-label="Capacités"><div class="partners-operator-actions">${actions}</div></td>
                </tr>`;
            }).join('');
            body = `<div class="partners-operator-table-wrap"><table class="partners-operator-table">
                <caption class="partners-sr-only">Capacités déléguées aux opérateurs Admin Partners</caption>
                <thead><tr><th>Opérateur</th><th>Capacités</th></tr></thead><tbody>${rows}</tbody>
            </table></div>`;
        }
        return `<section class="partners-operator-manager" aria-labelledby="partners-operator-manager-title">
            <div class="partners-operator-manager-head"><div>
                <h3 id="partners-operator-manager-title">Équipe opératrice et maker-checker</h3>
                <p>Les capacités ciblent un compte Admin précis. Finance exige un Authenticator vérifié et deux comptes opérateurs distincts avant tout lot réel.</p>
            </div></div>${body}</section>`;
    }

    _partnersOpsUnavailable(id, title) {
        const el = document.getElementById(id);
        if (!el) return;
        el.removeAttribute('aria-busy');
        el.innerHTML = `<h2>${AdminPage.esc(title)}</h2>
            <p>Observation autoritative indisponible. Aucun zéro n’est déduit d’une donnée absente.</p>
            <div class="admin-err" role="status">État inconnu ou capacité non accordée.</div>`;
    }

    _renderPartnersMonitoring(data) {
        const el = document.getElementById('partners-admin-monitoring');
        const priority = document.getElementById('partners-admin-priority');
        if (!el) return;
        if (data?.schema_version !== 1 || !Array.isArray(data.workers)
            || !Array.isArray(data.alerts) || !data.kyc_quota) {
            this._partnersOpsUnavailable('partners-admin-monitoring', 'Supervision');
            if (priority) {
                priority.removeAttribute('aria-busy');
                priority.classList.add('is-alert');
                priority.innerHTML = '<strong>Priorités indisponibles</strong><span>Aucune conclusion de santé n’est déduite.</span>';
            }
            return;
        }
        const workerLabels = {
            commission: 'Calcul des commissions',
            correction: 'Contre-corrections financières',
            maturation: 'Maturation J+45',
            reconciliation: 'Réconciliation shadow',
            revenuecat_transfer: 'Transferts RevenueCat'
        };
        const statusLabels = {
            healthy: 'Sain',
            degraded: 'Dégradé',
            blocked: 'Bloqué',
            stale: 'En retard',
            not_configured: 'Non configuré',
            unknown: 'Inconnu'
        };
        const orderedWorkers = data.workers.slice().sort((a, b) => {
            const rank = { blocked: 0, stale: 1, degraded: 2, unknown: 3, healthy: 4, not_configured: 5 };
            return (rank[String(a?.status)] ?? 3) - (rank[String(b?.status)] ?? 3);
        });
        const workers = orderedWorkers.map((worker) => {
            const status = ['healthy', 'degraded', 'blocked', 'stale', 'not_configured']
                .includes(String(worker?.status)) ? String(worker.status) : 'unknown';
            const healthy = status === 'healthy';
            const actionable = ['degraded', 'blocked', 'stale', 'unknown'].includes(status);
            const lastSeen = worker?.last_seen_at
                ? AdminPage.timeAgo(worker.last_seen_at) : 'jamais observé';
            return `<div class="partners-control-item">
                <span>${AdminPage.esc(workerLabels[worker?.worker] || worker?.worker || 'Worker')}
                  <small>${AdminPage.esc(lastSeen)}</small>
                </span>
                <span class="partners-state${healthy ? ' is-on' : (actionable ? ' is-alert' : '')}">${AdminPage.esc(statusLabels[status])}</span>
              </div>`;
        }).join('');
        const alertLabels = {
            revenuecat_transfer_dead_letter: 'Transferts RevenueCat en échec terminal',
            revenuecat_transfer_partial_aged: 'Transferts partiels depuis plus de 15 min',
            revenuecat_transfer_quarantined_aged: 'Transferts en quarantaine depuis plus de 15 min',
            revenuecat_transfer_partner_dead_letter: 'Observations Partners TRANSFER en échec terminal',
            worker_heartbeat_missing: 'Heartbeats de traitements attendus manquants'
        };
        const configuredWorkers = data.workers.filter((worker) => worker?.status !== 'not_configured');
        const actionableAlerts = data.alerts.filter((alert) => !(
            alert?.code === 'worker_heartbeat_missing' && configuredWorkers.length === 0
        ));
        const alerts = actionableAlerts.slice(0, 20).map((alert) =>
            `<div class="partners-control-item">
              <span>${AdminPage.esc(alertLabels[alert?.code] || String(alert?.code || 'alerte'))}</span>
              <span class="partners-state${alert?.severity === 'critical' ? ' is-alert' : ''}">${AdminPage.n(Number(alert?.count) || 0)} · ${AdminPage.esc(String(alert?.severity || 'warning'))}</span>
            </div>`
        ).join('');
        const actionableWorkers = data.workers.filter((worker) =>
            ['degraded', 'blocked', 'stale', 'unknown'].includes(String(worker?.status))
        );
        const inactiveWorkers = data.workers.filter((worker) => worker?.status === 'not_configured').length;
        const issueCount = actionableAlerts.reduce((sum, alert) => sum + Math.max(1, Number(alert?.count) || 0), 0)
            + actionableWorkers.length;
        const quotaUsed = Number.isSafeInteger(data.kyc_quota.used)
            ? data.kyc_quota.used : null;
        const quotaLimit = Number.isSafeInteger(data.kyc_quota.informational_limit)
            ? data.kyc_quota.informational_limit : null;
        el.removeAttribute('aria-busy');
        el.innerHTML = `<div class="partners-control-head">
            <div><h2>Supervision</h2><p>Chaque traitement critique doit publier un heartbeat récent. Le quota KYC reste informatif et ne coupe pas le parcours.</p></div>
            <span class="partners-state${issueCount ? ' is-alert' : ' is-on'}">${issueCount ? `${AdminPage.n(issueCount)} à traiter` : 'Aucun incident actif'}</span>
          </div>
          ${alerts ? `<div class="partners-ops-list" style="margin-top:10px">${alerts}</div>` : ''}
          <div class="partners-control-grid" style="margin-top:10px">${workers}</div>
          ${inactiveWorkers ? `<div class="ssub" style="margin-top:10px">${AdminPage.n(inactiveWorkers)} traitement(s) volontairement non configuré(s) — état informatif.</div>` : ''}
          <div class="ssub" style="margin-top:10px">KYC 30 j : ${quotaUsed === null ? 'inconnu' : AdminPage.n(quotaUsed)} / ${quotaLimit === null ? 'seuil inconnu' : `${AdminPage.n(quotaLimit)} (informatif)`}</div>`;
        if (priority) {
            priority.removeAttribute('aria-busy');
            priority.classList.toggle('is-alert', issueCount > 0);
            priority.innerHTML = issueCount > 0
                ? `<strong>${AdminPage.n(issueCount)} priorité(s) opérationnelle(s)</strong><span>Ouvrez Finance / Revolut ou Risque / KYC pour traiter les files concernées.</span>`
                : `<strong>Aucune anomalie opérationnelle active</strong><span>${inactiveWorkers ? `${AdminPage.n(inactiveWorkers)} traitement(s) non configuré(s) restent informatifs.` : 'Les traitements observés ne demandent aucune action.'}</span>`;
        }
    }

    _renderPartnersAnalytics(data) {
        const el = document.getElementById('partners-admin-analytics');
        if (!el) return;
        if (data?.schema_version !== 1 || !Number.isSafeInteger(data.window_days)
            || !Array.isArray(data.daily)) {
            this._partnersOpsUnavailable('partners-admin-analytics', 'Acquisition Partners');
            return;
        }
        const reasonLabels = {
            support_capability_required: 'Accès Support requis',
            risk_capability_required: 'Accès Risque requis',
            finance_capability_required: 'Accès Finance requis',
            referral_click_events_not_recorded: 'Les clics ne sont pas encore instrumentés',
            no_claims_in_window: 'Aucun claim dans cette fenêtre',
            no_attributions_in_window: 'Aucune attribution dans cette fenêtre',
            payout_operations_not_ready: 'Versements live non activés',
            authoritative_entitlement_and_billing_interval_history_not_modeled:
                'Historique d’abonnement autoritatif non disponible',
            authoritative_transfer_entitlement_contract_not_implemented:
                'Contrat d’entitlement TRANSFER non disponible',
            provider_fees_fx_infrastructure_and_other_costs_not_modeled:
                'Frais provider, change et infrastructure non modélisés',
            commission_processing_incomplete: 'Traitement des commissions incomplet',
            no_eligible_first_payout_observations: 'Aucun premier versement éligible'
        };
        const reason = (leaf) => reasonLabels[String(leaf?.reason || '')]
            || 'Mesure indisponible';
        const hasValue = (leaf) => leaf?.status === 'available'
            && Number.isFinite(Number(leaf.value));
        const stat = (leaf, label, formatter = (value) => AdminPage.n(value)) => {
            const available = hasValue(leaf);
            const rendered = available ? formatter(Number(leaf.value)) : '—';
            return `<div class="partners-ops-stat">
                <strong>${AdminPage.esc(rendered)}</strong>
                <span>${AdminPage.esc(label)}${available ? '' : `<small>${AdminPage.esc(reason(leaf))}</small>`}</span>
              </div>`;
        };
        const whole = (value) => AdminPage.n(Math.round(value));
        const percent = (value) => `${AdminPage.esc(value.toFixed(1))} %`;
        const days = (value) => `${AdminPage.esc(value.toFixed(2))} j`;
        const money = (value, currency, exponent) => {
            if (typeof value === 'number' && !Number.isSafeInteger(value)) {
                return '—';
            }
            const raw = String(value ?? '');
            const code = /^[A-Z]{3}$/.test(String(currency || ''))
                ? String(currency) : '—';
            const scale = Number.isSafeInteger(Number(exponent))
                && Number(exponent) >= 0 && Number(exponent) <= 6
                ? Number(exponent) : null;
            if (!/^-?\d+$/.test(raw) || scale === null) return `— ${code}`;
            const negative = raw.startsWith('-');
            const digits = raw.replace('-', '').padStart(scale + 1, '0');
            const integer = scale ? digits.slice(0, -scale) : digits;
            const fraction = scale ? `,${digits.slice(-scale)}` : '';
            const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
            return `${negative ? '−' : ''}${grouped}${fraction} ${code}`;
        };
        const unavailable = (section, title) => `<section class="partners-analytics-section">
            <h3>${AdminPage.esc(title)}</h3>
            <div class="admin-err" role="status">${AdminPage.esc(reason(section))}</div>
          </section>`;

        const funnel = data.funnel;
        const funnelHtml = funnel?.status === 'available'
            ? `<section class="partners-analytics-section">
                <h3>Acquisition attribuée</h3>
                <div class="partners-ops-stats">
                  ${stat(funnel.clicks, 'Clics')}
                  ${stat(funnel.claims_issued, 'Claims émis', whole)}
                  ${stat(funnel.attributions_created, 'Attributions', whole)}
                  ${stat(funnel.first_paid_referrals, 'Premiers paiements', whole)}
                  ${stat(funnel.claim_to_attribution_percent, 'Claim → attribution', percent)}
                  ${stat(funnel.attribution_to_first_payment_percent, 'Attribution → paiement', percent)}
                </div>
                <div class="partners-analytics-note">Cohorte fondée sur la date d’émission du claim. Les taux ne mélangent pas les fenêtres.</div>
              </section>`
            : unavailable(funnel, 'Acquisition attribuée');

        const activation = data.activation;
        const activationHtml = activation?.status === 'available'
            ? `<section class="partners-analytics-section">
                <h3>Activation partenaire</h3>
                <div class="partners-ops-stats">
                  ${stat(activation.account_activation_events, 'Événements d’activation', whole)}
                  ${stat(activation.distinct_accounts_activated, 'Comptes activés', whole)}
                  ${stat(activation.kyc_verified_sessions, 'KYC vérifiés', whole)}
                </div>
              </section>`
            : unavailable(activation, 'Activation partenaire');

        const risk = data.risk;
        const riskHtml = risk?.status === 'available'
            ? `<section class="partners-analytics-section">
                <h3>Risque et conformité</h3>
                <div class="partners-ops-stats">
                  ${stat(risk.kyc_terminal_sessions_in_window, 'KYC terminaux', whole)}
                  ${stat(risk.blocked_activation_accounts_current, 'Activations bloquées', whole)}
                  ${stat(risk.account_holds_current, 'Comptes en revue', whole)}
                  ${stat(risk.account_suspensions_current, 'Comptes suspendus', whole)}
                  ${stat(risk.attribution_holds_current, 'Attributions en revue', whole)}
                  ${stat(risk.quarantined_financial_facts_in_window, 'Faits en quarantaine', whole)}
                </div>
                <div class="partners-analytics-note">
                  ${hasValue(risk.quarantined_transfer_facts_total)
                    ? `${AdminPage.esc(whole(Number(risk.quarantined_transfer_facts_total.value)))} TRANSFER en quarantaine au total.`
                    : AdminPage.esc(reason(risk.transfer_entitlement))}
                </div>
              </section>`
            : unavailable(risk, 'Risque et conformité');

        const financial = data.financial;
        const financialRows = financial?.status === 'available'
            && Array.isArray(financial.rows)
            ? financial.rows.map((row) => {
                const rail = String(row?.rail || 'rail inconnu');
                const currency = String(row?.currency || '');
                const exponent = Number(row?.currency_exponent);
                const contribution = row?.contribution_after_partner_commission_minor;
                const contributionText = hasValue(contribution)
                    ? money(contribution.value, currency, exponent)
                    : reason(contribution);
                return `<div class="partners-ops-row">
                    <span>${AdminPage.esc(rail)} · ${AdminPage.esc(currency || 'devise inconnue')}
                      <small>${AdminPage.esc(whole(Number(row?.paid_event_count) || 0))} paiement(s) · ${AdminPage.esc(whole(Number(row?.refund_count) || 0))} remboursement(s) · ${AdminPage.esc(whole(Number(row?.chargeback_count) || 0))} chargeback(s)</small>
                    </span>
                    <strong>${AdminPage.esc(money(row?.net_eligible_revenue_minor, currency, exponent))}
                      <small>éligible net</small>
                    </strong>
                    <span>Commission partenaire nette
                      <small>Contribution après commission : ${AdminPage.esc(contributionText)}</small>
                    </span>
                    <strong>${AdminPage.esc(money(row?.net_partner_commission_minor, currency, exponent))}</strong>
                  </div>`;
            }).join('') : '';
        const financialHtml = financial?.status === 'available'
            ? `<section class="partners-analytics-section partners-analytics-wide">
                <h3>Économie par rail et devise</h3>
                <div class="partners-ops-list">${financialRows || '<div class="ssub">Aucun fait financier complet sur la période.</div>'}</div>
                <div class="partners-analytics-note">La marge brute reste volontairement indisponible tant que les frais provider, le change et les coûts d’infrastructure ne sont pas modélisés.</div>
              </section>`
            : unavailable(financial, 'Économie par rail et devise');

        const payout = data.payout_timing;
        const payoutHtml = payout?.status === 'available'
            ? `<section class="partners-analytics-section">
                <h3>Premiers versements</h3>
                <div class="partners-ops-stats">
                  ${stat(payout.first_settled_payouts, 'Premiers versements réglés', whole)}
                  ${stat(payout.median_days_activation_to_first_settled_payout, 'Médiane activation → versement', days)}
                  ${stat(payout.median_days_first_accrual_to_first_settled_payout, 'Médiane commission → versement', days)}
                </div>
              </section>`
            : unavailable(payout, 'Premiers versements');

        const retentionHtml = data.retention?.status === 'available'
            ? `<section class="partners-analytics-section">
                <h3>Rétention des filleuls</h3>
                <div class="partners-analytics-note">Mesure disponible.</div>
              </section>`
            : unavailable(data.retention, 'Rétention des filleuls');

        const daily = data.daily_status?.status === 'available'
            ? data.daily.slice(-30) : [];
        const max = Math.max(1, ...daily.map((row) =>
            (Number(row?.claims) || 0)
            + (Number(row?.attributions) || 0)
            + (Number(row?.kyc_verified) || 0)
            + (Number(row?.commission_entries) || 0)
        ));
        const bars = daily.map((row) => {
            const value = (Number(row?.claims) || 0)
                + (Number(row?.attributions) || 0)
                + (Number(row?.kyc_verified) || 0)
                + (Number(row?.commission_entries) || 0);
            const height = Math.max(4, Math.round(value * 100 / max));
            const title = `${row?.date || ''} · ${value} événement(s)`;
            return `<span style="height:${height}%" title="${AdminPage.esc(title)}" aria-label="${AdminPage.esc(title)}"></span>`;
        }).join('');
        el.removeAttribute('aria-busy');
        el.innerHTML = `<div class="partners-control-head">
            <div><h2>Performance Partners sur ${AdminPage.n(data.window_days)} jours</h2><p>Fenêtre UTC, cohortes explicites et montants exacts par devise. Une donnée absente reste indisponible, jamais zéro.</p></div>
          </div>
          ${bars
            ? `<div class="partners-mini-chart" role="img" aria-label="Activité quotidienne Partners sur ${AdminPage.n(data.window_days)} jours">${bars}</div>`
            : '<div class="admin-err" role="status">Série quotidienne indisponible pour cette capacité.</div>'}
          <div class="partners-analytics-grid">
            ${funnelHtml}
            ${activationHtml}
            ${riskHtml}
            ${payoutHtml}
            ${financialHtml}
            ${retentionHtml}
          </div>`;
    }

    _partnersHasCapabilities(...names) {
        return names.every((name) => this._partnersCapabilities?.[name] === true);
    }

    _partnersFormatMinor(value, currency, exponent = 2) {
        const amount = Number(value);
        const decimals = Number(exponent);
        const code = String(currency || '').toUpperCase();
        if (!Number.isSafeInteger(amount) || amount < 0
            || !Number.isInteger(decimals) || decimals < 0 || decimals > 6
            || !/^[A-Z]{3}$/.test(code)) return 'Montant indisponible';
        try {
            return new Intl.NumberFormat('fr-FR', {
                style: 'currency',
                currency: code,
                minimumFractionDigits: decimals,
                maximumFractionDigits: decimals
            }).format(amount / (10 ** decimals));
        } catch (_) {
            return `${AdminPage.n(amount)} ${code} en unités mineures`;
        }
    }

    _partnersCanUseConfigurationAction(action) {
        if (['program-create', 'program-activate'].includes(action)) {
            return this._partnersHasCapabilities('support', 'finance');
        }
        if (['country-create', 'country-availability'].includes(action)) {
            return this._partnersHasCapabilities('support', 'risk');
        }
        if (['kyc-policy', 'country-map'].includes(action)) {
            return this._partnersHasCapabilities('risk');
        }
        if (['currency', 'payout-provider'].includes(action)) {
            return this._partnersHasCapabilities('finance');
        }
        if (action === 'allowlist') {
            return this._partnersHasCapabilities('support')
                || this._partnersHasCapabilities('risk');
        }
        return false;
    }

    _partnersCanUseOperationalAction(action) {
        const required = {
            'account-action': ['risk'],
            'job-retry': ['finance'],
            'commission-reverse': ['finance', 'risk'],
            'payout-create': ['finance'],
            'payout-approve': ['finance'],
            'fiscal-review-public': ['support', 'finance']
        }[action];
        return Array.isArray(required) && this._partnersHasCapabilities(...required);
    }

    _partnersCanUseReleaseControl(kind, key, targetEnabled) {
        if (kind === 'gate') {
            if ([
                'legal_and_tax_approved',
                'individual_payout_coverage_confirmed',
                'financial_data_contract_approved',
                'shadow_reconciliation_clean',
                'backup_restore_verified',
                'payout_execution_adapter_verified',
                'manual_payout_workflow_verified',
                'revolut_api_adapter_verified'
            ].includes(key)) return this._partnersHasCapabilities('finance');
            if ([
                'membership_privacy_approved',
                'privacy_approved',
                'individual_verification_coverage_confirmed',
                'country_policy_approved',
                'tv_relay_security_verified'
            ].includes(key)) return this._partnersHasCapabilities('risk');
            return key === 'general_release_approved'
                && this._partnersCanManageRelease === true;
        }
        if (kind !== 'flag') return false;
        if (key === 'partners_shadow_mode') {
            return this._partnersHasCapabilities('finance');
        }
        if ([
            'partners_earnings_enabled',
            'partners_credit_redemptions_enabled'
        ].includes(key)) {
            return targetEnabled
                ? this._partnersHasCapabilities('finance')
                    && this._partnersCanManageRelease === true
                : this._partnersHasCapabilities('finance')
                    || this._partnersCanManageRelease === true
                    || this._partnersHasCapabilities('support');
        }
        if (key === 'partners_payouts_live') {
            return this._partnersHasCapabilities('finance')
                && this._partnersCanManageRelease === true;
        }
        if (key === 'partners_revolut_api_enabled') {
            return targetEnabled
                ? this._partnersHasCapabilities('finance')
                    && this._partnersCanManageRelease === true
                : this._partnersHasCapabilities('finance')
                    || this._partnersCanManageRelease === true;
        }
        if (key === 'partners_enabled') {
            return this._partnersCanManageRelease === true
                || (targetEnabled === false && this._partnersHasCapabilities('support'));
        }
        if (key === 'partners_invite_only') {
            return this._partnersCanManageRelease === true;
        }
        if (key === 'partners_cash_pilot_allowlist_only') {
            return targetEnabled
                ? this._partnersCanManageRelease === true
                    || this._partnersHasCapabilities('risk')
                    || this._partnersHasCapabilities('support')
                : this._partnersCanManageRelease === true
                    && this._partnersHasCapabilities('risk');
        }
        if (key === 'partners_tv_relay_enabled') {
            return targetEnabled
                ? this._partnersCanManageRelease === true
                    && this._partnersHasCapabilities('risk')
                : this._partnersCanManageRelease === true
                    || this._partnersHasCapabilities('risk')
                    || this._partnersHasCapabilities('support');
        }
        return false;
    }

    _renderPartnersRevolutStatus(data) {
        const el = document.getElementById('partners-admin-revolut');
        const routesEl = document.getElementById('partners-admin-routes');
        if (!el && !routesEl) return;
        const routesValid = Array.isArray(data?.routes) && data.routes.every((route) => (
            /^[A-Z]{2}$/.test(String(route?.country_code || ''))
            && /^[A-Z]{3}$/.test(String(route?.currency || ''))
            && ['active', 'disabled'].includes(String(route?.status || ''))
            && ['revolut_manual', 'revolut_api'].includes(String(route?.execution_adapter || ''))
            && (route?.updated_at == null || Number.isFinite(Date.parse(route.updated_at)))
        ));
        if (data?.schema_version !== 1
            || data?.provider !== 'revolut_business'
            || data?.production_mode !== 'revolut_manual'
            || data?.plan !== 'basic'
            || typeof data?.api_enabled !== 'boolean'
            || typeof data?.api_adapter_verified !== 'boolean'
            || !routesValid
            || !data?.counts || typeof data.counts !== 'object') {
            this._partnersOpsUnavailable(
                'partners-admin-revolut',
                'Revolut Business'
            );
            this._partnersOpsUnavailable(
                'partners-admin-routes',
                'Corridors Revolut'
            );
            return;
        }
        const countValue = (value) => Number.isSafeInteger(Number(value))
            && Number(value) >= 0 ? AdminPage.n(Number(value)) : 'inconnu';
        this._partnersRoutes = data.routes.map((route) => {
            const country = route.country_code;
            const currency = route.currency;
            const status = route.status;
            const adapter = route?.execution_adapter === 'revolut_api'
                ? 'API'
                : 'manuel Basic';
            return { country, currency, status, adapter, updatedAt: route?.updated_at || null };
        });
        if (el) {
            el.removeAttribute('aria-busy');
            el.innerHTML = `<div class="partners-control-head">
            <div><h2>Revolut Business · Basic</h2>
              <p>Production en mode manuel : Norva prépare et contrôle les lots, puis un opérateur Finance valide et paie dans Revolut. Aucun virement n’est déclenché automatiquement.</p>
            </div>
            <div class="partners-action-row">
              <span class="partners-state is-on">Production · manuel</span>
              <span class="partners-state${data.api_enabled ? ' is-alert' : ''}">Flag DB API ${data.api_enabled ? 'activé' : 'désactivé'}</span>
              <span class="partners-state${data.api_adapter_verified ? ' is-on' : ''}">Gate adaptateur API ${data.api_adapter_verified ? 'validé' : 'non validé'}</span>
            </div>
          </div>
          <div class="partners-ops-stats">
            <div class="partners-ops-stat"><strong>${countValue(data.counts.manual_batches_open)}</strong><span>lots manuels ouverts</span></div>
            <div class="partners-ops-stat"><strong>${countValue(data.counts.manual_statement_pending)}</strong><span>saisies en attente de relevé</span></div>
            <div class="partners-ops-stat"><strong>${countValue(data.counts.statement_matched_review_pending)}</strong><span>relevés à valider</span></div>
            <div class="partners-ops-stat"><strong>${countValue(data.counts.reconciliation_pending)}</strong><span>rapprochements sans incident</span></div>
            <div class="partners-ops-stat"><strong>${countValue(data.counts.manual_batches_exception)}</strong><span>lots en exception</span></div>
            <div class="partners-ops-stat"><strong>${countValue(data.counts.api_dead_letter)}</strong><span>API dead letter</span></div>
          </div>`;
        }
        this._renderPartnersRoutes();
    }

    _renderPartnersRoutes({ focusControl = '' } = {}) {
        const el = document.getElementById('partners-admin-routes');
        if (!el) return;
        const routes = Array.isArray(this._partnersRoutes) ? this._partnersRoutes.slice() : [];
        const search = String(this._partnersRouteSearch || '').toUpperCase();
        const status = ['all', 'active', 'disabled'].includes(this._partnersRouteStatus)
            ? this._partnersRouteStatus : 'all';
        const activeCount = routes.filter((route) => route.status === 'active').length;
        const disabledCount = routes.length - activeCount;
        const filtered = routes.filter((route) => {
            const matchesStatus = status === 'all' || route.status === status;
            const haystack = `${route.country} ${route.currency} ${route.adapter}`.toUpperCase();
            return matchesStatus && (!search || haystack.includes(search));
        }).sort((a, b) => {
            if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
            return `${a.country}-${a.currency}`.localeCompare(`${b.country}-${b.currency}`);
        });
        const pageCount = Math.max(1, Math.ceil(filtered.length / this._partnersRouteLimit));
        this._partnersRoutePage = Math.min(Math.max(0, this._partnersRoutePage), pageCount - 1);
        const start = this._partnersRoutePage * this._partnersRouteLimit;
        const page = filtered.slice(start, start + this._partnersRouteLimit);
        const rows = page.map((route) => `<li class="partners-control-item">
            <span><strong>${AdminPage.esc(route.country)} · ${AdminPage.esc(route.currency)}</strong>
              <small>Exécution ${AdminPage.esc(route.adapter)} · mise à jour ${route.updatedAt ? AdminPage.esc(AdminPage.timeAgo(route.updatedAt)) : 'indisponible'}</small>
            </span>
            <span class="partners-state${route.status === 'active' ? ' is-on' : ''}">${route.status === 'active' ? 'Route active' : 'Route désactivée'}</span>
          </li>`).join('');
        const first = filtered.length ? start + 1 : 0;
        const last = Math.min(start + this._partnersRouteLimit, filtered.length);
        el.removeAttribute('aria-busy');
        el.innerHTML = `<div class="partners-control-head"><div><h2>Corridors Revolut</h2>
            <p>Toutes les routes sont accessibles. Les routes actives sont toujours prioritaires.</p></div></div>
          <div class="partners-route-summary" role="group" aria-label="Résumé des corridors">
            <div class="partners-ops-stat"><strong>${AdminPage.n(routes.length)}</strong><span>corridors configurés</span></div>
            <div class="partners-ops-stat"><strong>${AdminPage.n(activeCount)}</strong><span>actifs</span></div>
            <div class="partners-ops-stat"><strong>${AdminPage.n(disabledCount)}</strong><span>désactivés</span></div>
          </div>
          <div class="partners-routes-toolbar" role="search" aria-label="Rechercher les corridors Revolut">
            <input id="partners-routes-search" type="search" value="${AdminPage.esc(this._partnersRouteSearch || '')}"
              maxlength="16" placeholder="Pays, devise ou exécution" aria-label="Rechercher un pays ou une devise">
            <select id="partners-routes-status" aria-label="Filtrer les corridors par état">
              <option value="all"${status === 'all' ? ' selected' : ''}>Tous les états</option>
              <option value="active"${status === 'active' ? ' selected' : ''}>Routes actives</option>
              <option value="disabled"${status === 'disabled' ? ' selected' : ''}>Routes désactivées</option>
            </select>
          </div>
          <p id="partners-routes-count" class="partners-sr-only" role="status" aria-live="polite">${AdminPage.n(filtered.length)} corridor(s), page ${AdminPage.n(this._partnersRoutePage + 1)} sur ${AdminPage.n(pageCount)}</p>
          <ul id="partners-routes-list" class="partners-route-list" role="list">${rows || '<li class="partners-empty-state"><strong>Aucun corridor</strong><span>Aucun corridor ne correspond à ces filtres.</span></li>'}</ul>
          <nav class="partners-pagination" aria-label="Pagination des corridors">
            <span class="partners-pagination-status">${AdminPage.n(first)}–${AdminPage.n(last)} sur ${AdminPage.n(filtered.length)}</span>
            <button type="button" class="partners-page-btn" data-partners-route-page="prev" aria-controls="partners-routes-list" aria-label="Page précédente des corridors"${this._partnersRoutePage === 0 ? ' disabled' : ''}>Précédente</button>
            <button type="button" class="partners-page-btn" data-partners-route-page="next" aria-controls="partners-routes-list" aria-label="Page suivante des corridors"${this._partnersRoutePage >= pageCount - 1 ? ' disabled' : ''}>Suivante</button>
          </nav>`;
        if (focusControl) setTimeout(() => {
            let target = focusControl === 'search' ? document.getElementById('partners-routes-search')
                : (focusControl === 'status' ? document.getElementById('partners-routes-status')
                    : document.querySelector(`[data-partners-route-page="${focusControl}"]`));
            if ((!target || target.disabled) && ['prev', 'next'].includes(focusControl)) {
                const fallback = focusControl === 'next' ? 'prev' : 'next';
                target = document.querySelector(`[data-partners-route-page="${fallback}"]:not(:disabled)`)
                    || document.getElementById('partners-routes-search');
            }
            if (this._partnersFocusElement(target) && focusControl === 'search') {
                const end = String(target.value || '').length;
                target.setSelectionRange?.(end, end);
            }
        }, 0);
    }

    _renderPartnersRevolutReconciliation(data) {
        const el = document.getElementById('partners-admin-settlements');
        if (!el) return;
        if (data?.schema_version !== 1 || !Number.isSafeInteger(data.total)
            || !Array.isArray(data.items)) {
            this._partnersOpsUnavailable(
                'partners-admin-settlements',
                'Rapprochement Revolut'
            );
            return;
        }
        const statusLabels = {
            matched: 'Correspondance exacte · revue requise',
            unmatched: 'Référence Norva inconnue',
            mismatch: 'Écart à résoudre',
            reviewed: 'Second opérateur Finance requis',
            confirmed: 'Confirmé',
            quarantined: 'Mis en quarantaine'
        };
        const discrepancyLabels = {
            unknown_reference: 'Référence Norva inconnue',
            amount_mismatch: 'Montant différent',
            currency_mismatch: 'Devise différente',
            transaction_mismatch: 'Transaction différente',
            execution_state_mismatch: 'État du lot incompatible',
            provider_not_completed: 'Transaction Revolut non terminée'
        };
        const rows = data.items.slice(0, 25).map((item) => {
            const statementRow = String(item?.statement_row_key || '');
            const review = String(item?.review_key || '');
            const reference = String(item?.reference || '');
            const currency = String(item?.currency || '');
            const destination = String(item?.destination_masked || '');
            const status = String(item?.effective_status || '');
            const validRow = /^rsr_[0-9a-f]{24}$/.test(statementRow);
            const validReview = /^rmr_[0-9a-f]{24}$/.test(review);
            const validReference = /^NORVA-[A-F0-9]{12}$/.test(reference);
            const validDestination = destination.length >= 4
                && destination.length <= 64
                && /[*•]/u.test(destination)
                && !/[\u0000-\u001f\u007f]/u.test(destination);
            const validMoney = Number.isSafeInteger(item?.amount_minor)
                && item.amount_minor > 0
                && /^[A-Z]{3}$/.test(currency);
            const actions = [];
            if (validRow && status === 'matched' && !review
                && this._partnersCapabilities.finance === true) {
                actions.push(`<button type="button" class="partners-action"
                    data-partners-action="revolut-reconciliation-review"
                    data-partners-statement-row="${AdminPage.esc(statementRow)}"
                    data-partners-reference="${AdminPage.esc(validReference ? reference : '')}"
                    data-partners-destination="${AdminPage.esc(validDestination ? destination : '')}"
                    data-partners-amount="${validMoney ? item.amount_minor : ''}"
                    data-partners-currency="${AdminPage.esc(validMoney ? currency : '')}">
                    Effectuer la revue
                  </button>`);
            }
            if (validReview && status === 'reviewed'
                && this._partnersCapabilities.finance === true) {
                actions.push(`<button type="button" class="partners-action is-success"
                    data-partners-action="revolut-reconciliation-confirm"
                    data-partners-review="${AdminPage.esc(review)}"
                    data-partners-reference="${AdminPage.esc(validReference ? reference : '')}"
                    data-partners-destination="${AdminPage.esc(validDestination ? destination : '')}"
                    data-partners-amount="${validMoney ? item.amount_minor : ''}"
                    data-partners-currency="${AdminPage.esc(validMoney ? currency : '')}">
                    Confirmer
                  </button>`);
                actions.push(`<button type="button" class="partners-action is-danger"
                    data-partners-action="revolut-reconciliation-quarantine"
                    data-partners-review="${AdminPage.esc(review)}">
                    Quarantaine
                  </button>`);
            }
            const observed = item?.observed_at
                ? AdminPage.timeAgo(item.observed_at)
                : 'date indisponible';
            const valueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(item?.value_date || ''))
                ? String(item.value_date)
                : 'indisponible';
            return `<div class="partners-ops-row">
              <span>${AdminPage.esc(validReference ? reference : 'Référence invalide')}
                <small>${validMoney
                    ? `${AdminPage.n(item.amount_minor)} ${AdminPage.esc(currency)} en unités mineures`
                    : 'Montant indisponible'} · valeur ${AdminPage.esc(valueDate)} · ${AdminPage.esc(observed)}
                    ${item?.discrepancy_code ? ` · ${AdminPage.esc(discrepancyLabels[item.discrepancy_code] || 'Écart non reconnu')}` : ''}
                    · destination attendue ${AdminPage.esc(validDestination ? destination : 'indisponible')} · à comparer dans Revolut</small>
              </span>
              <div class="partners-risk-actions">${actions.join('')
                  || `<span class="partners-state${['unmatched', 'mismatch', 'quarantined'].includes(status) ? ' is-alert' : ''}">${AdminPage.esc(statusLabels[status] || 'État indisponible')}</span>`}</div>
            </div>`;
        }).join('');
        el.removeAttribute('aria-busy');
        el.innerHTML = `<div class="partners-control-head">
            <div><h2>Journal normalisé · correspondances exactes</h2>
              <p>${AdminPage.n(data.total)} ligne(s) normalisée(s). Cette vue sert aux correspondances exactes historiques ; les écarts se résolvent exclusivement dans la file append-only ci-dessous. Le relevé brut n’est jamais conservé.</p>
            </div>
            ${this._partnersCapabilities.finance === true ? `<button type="button" class="partners-action"
              data-partners-action="revolut-statement-import">Importer un relevé CSV</button>` : ''}
          </div>
          <div class="partners-ops-list">${rows
              || '<div class="ssub">Aucun rapprochement à traiter.</div>'}</div>`;
    }

    _renderPartnersRevolutIncidents(data) {
        const sectionId = 'partners-admin-reconciliation-incidents';
        const el = document.getElementById(sectionId);
        if (!el) return;
        const filters = new Set([
            'action_required',
            'open',
            'quarantined',
            'resolved',
            'all'
        ]);
        const statuses = new Set(['open', 'quarantined', 'resolved']);
        const kinds = new Set([
            'unknown_reference',
            'provider_not_completed',
            'amount_mismatch',
            'currency_mismatch',
            'transaction_mismatch',
            'execution_state_mismatch'
        ]);
        const providerStates = new Set([
            'CREATED',
            'PENDING',
            'PROCESSING',
            'COMPLETED',
            'FAILED',
            'REVERTED',
            'CANCELLED'
        ]);
        const resolutionActions = new Set([
            'settle_exact',
            'remap_exact_and_settle',
            'release_after_return',
            'quarantine'
        ]);
        const safeCount = (value) => Number.isSafeInteger(value) && value >= 0;
        const requestedFilter = filters.has(this._partnersIncidentFilter)
            ? this._partnersIncidentFilter
            : 'action_required';
        const requestedOffset = Number.isSafeInteger(
            this._partnersIncidentOffset
        ) && this._partnersIncidentOffset >= 0
            ? this._partnersIncidentOffset
            : 0;
        if (data?.schema_version !== 1
            || !filters.has(String(data?.filter || ''))
            || data.filter !== requestedFilter
            || !safeCount(data?.total)
            || !safeCount(data?.action_required)
            || !Number.isSafeInteger(data?.limit)
            || data.limit < 1 || data.limit > 200
            || !safeCount(data?.offset)
            || data.offset !== requestedOffset
            || !Array.isArray(data?.items)
            || data.items.length > data.limit) {
            this._partnersReconciliationIncidents = new Map();
            this._partnersOpsUnavailable(
                sectionId,
                'Écarts de rapprochement Revolut'
            );
            return;
        }
        if (data.offset > 0 && data.items.length === 0
            && data.offset >= data.total) {
            this._partnersIncidentOffset = data.total > 0
                ? Math.floor((data.total - 1) / data.limit) * data.limit
                : 0;
            if (this._route === 'partners') this._partnersLoadIncidents({ force: true });
            return;
        }

        const normalized = [];
        const contexts = new Map();
        for (const raw of data.items) {
            const key = String(raw?.key || '');
            const status = String(raw?.status || '');
            const kind = String(raw?.kind || '');
            const reference = String(raw?.source_reference || '');
            const fingerprint = String(
                raw?.source_transaction_fingerprint || ''
            );
            const sourceState = String(raw?.source_state || '');
            const amount = Number(raw?.source_amount_minor);
            const currency = String(raw?.source_currency || '');
            const exponent = raw?.source_currency_exponent == null
                ? null
                : Number(raw.source_currency_exponent);
            const expectedReference = raw?.expected_reference == null
                ? null
                : String(raw.expected_reference);
            const expectedAmount = raw?.expected_amount_minor == null
                ? null
                : Number(raw.expected_amount_minor);
            const expectedCurrency = raw?.expected_currency == null
                ? null
                : String(raw.expected_currency);
            const expectedExponent = raw?.expected_currency_exponent == null
                ? null
                : Number(raw.expected_currency_exponent);
            const observedAt = String(raw?.observed_at || '');
            const valueDate = String(raw?.value_date || '');
            const eligible = Array.isArray(raw?.eligible_actions)
                ? raw.eligible_actions.map(String)
                : null;
            const uniqueEligible = eligible
                && new Set(eligible).size === eligible.length
                && eligible.every((value) => resolutionActions.has(value));
            const pendingRaw = raw?.pending_review;
            let pendingReview = null;
            if (pendingRaw != null) {
                const reviewKey = String(pendingRaw?.key || '');
                const proposedAction = String(
                    pendingRaw?.proposed_action || ''
                );
                const targetReference = pendingRaw?.target_reference == null
                    ? null
                    : String(pendingRaw.target_reference);
                const requestedAt = String(pendingRaw?.requested_at || '');
                if (!/^rir_[0-9a-f]{24}$/.test(reviewKey)
                    || !resolutionActions.has(proposedAction)
                    || (
                        targetReference !== null
                        && !/^NORVA-[A-F0-9]{12}$/.test(targetReference)
                    )
                    || (
                        (proposedAction === 'quarantine')
                        !== (targetReference === null)
                    )
                    || !Number.isFinite(Date.parse(requestedAt))) {
                    this._partnersReconciliationIncidents = new Map();
                    this._partnersOpsUnavailable(
                        sectionId,
                        'Écarts de rapprochement Revolut'
                    );
                    return;
                }
                pendingReview = {
                    key: reviewKey,
                    proposedAction,
                    targetReference,
                    requestedAt
                };
            }
            const aliasRaw = raw?.transaction_alias;
            let transactionAlias = null;
            if (aliasRaw != null) {
                const aliasKey = String(aliasRaw?.key || '');
                const superseded = aliasRaw
                    ?.superseded_transaction_fingerprint == null
                    ? null
                    : String(aliasRaw.superseded_transaction_fingerprint);
                const authoritative = String(
                    aliasRaw?.authoritative_transaction_fingerprint || ''
                );
                if (!/^rta_[0-9a-f]{24}$/.test(aliasKey)
                    || (
                        superseded !== null
                        && !/^[0-9a-f]{12}$/.test(superseded)
                    )
                    || !/^[0-9a-f]{12}$/.test(authoritative)) {
                    this._partnersReconciliationIncidents = new Map();
                    this._partnersOpsUnavailable(
                        sectionId,
                        'Écarts de rapprochement Revolut'
                    );
                    return;
                }
                transactionAlias = {
                    key: aliasKey,
                    superseded,
                    authoritative
                };
            }
            const resolution = raw?.resolution == null
                ? null
                : String(raw.resolution);
            const resolvedAt = raw?.resolved_at == null
                ? null
                : String(raw.resolved_at);
            const validExpected = (
                expectedReference === null
                && expectedAmount === null
                && expectedCurrency === null
                && expectedExponent === null
            ) || (
                /^NORVA-[A-F0-9]{12}$/.test(expectedReference || '')
                && Number.isSafeInteger(expectedAmount)
                && expectedAmount > 0
                && /^[A-Z]{3}$/.test(expectedCurrency || '')
                && (
                    expectedExponent === null
                    || (
                        Number.isInteger(expectedExponent)
                        && expectedExponent >= 0
                        && expectedExponent <= 6
                    )
                )
            );
            if (!/^rri_[0-9a-f]{24}$/.test(key)
                || contexts.has(key)
                || !statuses.has(status)
                || !Number.isInteger(raw?.priority)
                || raw.priority < 1 || raw.priority > 4
                || !kinds.has(kind)
                || !/^NORVA-[A-F0-9]{12}$/.test(reference)
                || !/^[0-9a-f]{12}$/.test(fingerprint)
                || !providerStates.has(sourceState)
                || !Number.isSafeInteger(amount) || amount < 1
                || !/^[A-Z]{3}$/.test(currency)
                || (
                    exponent !== null
                    && (
                        !Number.isInteger(exponent)
                        || exponent < 0 || exponent > 6
                    )
                )
                || !validExpected
                || !/^\d{4}-\d{2}-\d{2}$/.test(valueDate)
                || !Number.isFinite(Date.parse(observedAt))
                || !uniqueEligible
                || (status === 'resolved' && eligible.length !== 0)
                || (
                    resolution !== null
                    && !resolutionActions.has(resolution)
                )
                || (
                    resolvedAt !== null
                    && !Number.isFinite(Date.parse(resolvedAt))
                )
                || (
                    status === 'resolved'
                    && (
                        resolution === null
                        || resolution === 'quarantine'
                        || resolvedAt === null
                        || pendingReview !== null
                    )
                )
                || (
                    status !== 'resolved'
                    && (resolution !== null || resolvedAt !== null)
                )
                || (
                    transactionAlias !== null
                    && (
                        status !== 'resolved'
                        || resolution !== 'remap_exact_and_settle'
                    )
                )
                || (
                    status === 'resolved'
                    && resolution === 'remap_exact_and_settle'
                    && transactionAlias === null
                )) {
                this._partnersReconciliationIncidents = new Map();
                this._partnersOpsUnavailable(
                    sectionId,
                    'Écarts de rapprochement Revolut'
                );
                return;
            }
            const context = {
                key,
                status,
                priority: raw.priority,
                kind,
                reference,
                fingerprint,
                sourceState,
                amount,
                currency,
                exponent,
                expectedReference,
                expectedAmount,
                expectedCurrency,
                expectedExponent,
                observedAt,
                valueDate,
                eligibleActions: eligible,
                pendingReview,
                transactionAlias,
                resolution,
                resolvedAt
            };
            contexts.set(key, context);
            normalized.push(context);
        }
        this._partnersReconciliationIncidents = contexts;

        const kindLabels = {
            unknown_reference: 'Référence inconnue',
            provider_not_completed: 'Transaction non terminée',
            amount_mismatch: 'Montant différent',
            currency_mismatch: 'Devise différente',
            transaction_mismatch: 'Identité transaction différente',
            execution_state_mismatch: 'État d’exécution incompatible'
        };
        const actionLabels = {
            settle_exact: 'Comptabiliser exact',
            remap_exact_and_settle: 'Remapper et comptabiliser',
            release_after_return: 'Libérer après retour confirmé',
            quarantine: 'Quarantaine'
        };
        const statusLabels = {
            open: 'Action requise',
            quarantined: 'Quarantaine révisable',
            resolved: 'Résolu'
        };
        const formatMoney = (value, code, moneyExponent) => (
            Number.isInteger(moneyExponent)
                ? this._partnersFormatMinor(value, code, moneyExponent)
                : `${AdminPage.n(value)} ${AdminPage.esc(code)} en unités mineures`
        );
        const rows = normalized.map((item) => {
            const actions = [];
            if (this._partnersCapabilities.finance === true
                && item.status !== 'resolved') {
                if (item.pendingReview) {
                    actions.push(`<button type="button" class="partners-action is-success"
                      data-partners-action="revolut-incident-decide-approve"
                      data-partners-incident="${AdminPage.esc(item.key)}"
                      aria-label="Approuver le contrôle de ${AdminPage.esc(item.reference)}">
                      Approuver le contrôle 2/2
                    </button>`);
                    actions.push(`<button type="button" class="partners-action is-danger"
                      data-partners-action="revolut-incident-decide-quarantine"
                      data-partners-incident="${AdminPage.esc(item.key)}"
                      aria-label="Refuser le contrôle de ${AdminPage.esc(item.reference)} et placer en quarantaine">
                      Refuser · quarantaine
                    </button>`);
                } else {
                    for (const resolutionAction of item.eligibleActions) {
                        const cls = resolutionAction === 'quarantine'
                            || resolutionAction === 'release_after_return'
                            ? ' is-danger'
                            : ' is-success';
                        actions.push(`<button type="button" class="partners-action${cls}"
                          data-partners-action="revolut-incident-review"
                          data-partners-incident="${AdminPage.esc(item.key)}"
                          data-partners-resolution="${AdminPage.esc(resolutionAction)}"
                          aria-label="${AdminPage.esc(actionLabels[resolutionAction])} pour ${AdminPage.esc(item.reference)}">
                          ${AdminPage.esc(actionLabels[resolutionAction])}
                        </button>`);
                    }
                }
            }
            const expected = item.expectedReference
                ? ` · attendu ${AdminPage.esc(item.expectedReference)} · ${formatMoney(item.expectedAmount, item.expectedCurrency, item.expectedExponent)}`
                : '';
            const review = item.pendingReview
                ? `<small>Contrôle 1/2 enregistré : ${AdminPage.esc(actionLabels[item.pendingReview.proposedAction])}${item.pendingReview.targetReference ? ` vers ${AdminPage.esc(item.pendingReview.targetReference)}` : ''}. Un autre opérateur Finance doit décider.</small>`
                : '';
            const alias = item.transactionAlias
                ? `<small>Alias append-only · empreinte autoritaire ${AdminPage.esc(item.transactionAlias.authoritative)}</small>`
                : '';
            return `<div class="partners-ops-row">
              <span><strong>P${AdminPage.n(item.priority)} · ${AdminPage.esc(kindLabels[item.kind])}</strong>
                <small>${AdminPage.esc(item.reference)} · ${formatMoney(item.amount, item.currency, item.exponent)}${expected}</small>
                <small>État Revolut ${AdminPage.esc(item.sourceState)} · empreinte ${AdminPage.esc(item.fingerprint)} · valeur ${AdminPage.esc(item.valueDate)} · observé ${AdminPage.esc(AdminPage.timeAgo(item.observedAt))}</small>
                ${review}${alias}
              </span>
              <div class="partners-risk-actions">${actions.join('')
                  || `<span class="partners-state${item.status === 'resolved' ? ' is-on' : ' is-alert'}">${AdminPage.esc(statusLabels[item.status])}</span>`}</div>
            </div>`;
        }).join('');
        const selectedFilter = String(data.filter);
        const filterOptions = [
            ['action_required', 'À traiter'],
            ['open', 'Ouverts'],
            ['quarantined', 'Quarantaines'],
            ['resolved', 'Résolus'],
            ['all', 'Tous']
        ].map(([value, label]) => (
            `<option value="${value}"${selectedFilter === value ? ' selected' : ''}>${label}</option>`
        )).join('');
        const hasPrevious = data.offset > 0;
        const hasNext = data.offset + data.items.length < data.total;
        const previousOffset = Math.max(0, data.offset - data.limit);
        const nextOffset = data.offset + data.limit;
        el.removeAttribute('aria-busy');
        el.innerHTML = `<div class="partners-sr-only" role="status" aria-live="polite">${AdminPage.n(data.items.length)} écart(s) chargé(s), ${AdminPage.n(data.action_required)} action(s) requise(s)</div>
          <div class="partners-control-head">
            <div><h2>Écarts de rapprochement Revolut</h2>
              <p>${AdminPage.n(data.action_required)} action(s) requise(s) au total · ${AdminPage.n(data.total)} résultat(s) dans ce filtre. Une valeur indisponible n’est jamais convertie en zéro.</p>
            </div>
            <label class="ssub">État
              <select id="partners-revolut-incident-filter" aria-label="Filtrer les écarts Revolut">
                ${filterOptions}
              </select>
            </label>
          </div>
          <div id="partners-revolut-incidents-list" class="partners-ops-list">${rows
              || '<div class="ssub">Aucun incident dans ce filtre.</div>'}</div>
          <div class="partners-action-row" style="margin-top:12px">
            <button type="button" class="partners-action"
              data-partners-action="revolut-incident-page"
              data-partners-page-direction="prev" data-partners-offset="${previousOffset}"
              aria-controls="partners-revolut-incidents-list"${hasPrevious ? '' : ' disabled'}>Précédent</button>
            <span class="ssub" role="status" aria-live="polite" aria-atomic="true">Résultats ${data.items.length ? data.offset + 1 : 0}–${data.offset + data.items.length}</span>
            <button type="button" class="partners-action"
              data-partners-action="revolut-incident-page"
              data-partners-page-direction="next" data-partners-offset="${nextOffset}"
              aria-controls="partners-revolut-incidents-list"${hasNext ? '' : ' disabled'}>Suivant</button>
          </div>`;
    }

    _renderPartnersRevolutReturns(data) {
        const el = document.getElementById('partners-admin-returns');
        if (!el) return;
        if (data?.schema_version !== 1 || !Number.isSafeInteger(data.total)
            || !Array.isArray(data.items)) {
            this._partnersOpsUnavailable(
                'partners-admin-returns',
                'Retours et déblocages Revolut'
            );
            return;
        }
        const statusLabels = {
            pending: 'Revue Finance requise',
            reviewed: 'Décision d’un second opérateur requise',
            confirmed: 'Résolution confirmée',
            quarantined: 'Observation en quarantaine'
        };
        const kindLabels = {
            pre_settlement_release: 'Déblocage avant règlement',
            post_settlement_return: 'Retour après règlement'
        };
        const providerStates = {
            FAILED: 'Échec',
            DECLINED: 'Refusé',
            CANCELLED: 'Annulé',
            REVERTED: 'Retourné'
        };
        const rows = data.items.slice(0, 25).map((item) => {
            const observation = String(item?.observation_key || '');
            const review = String(item?.review_key || '');
            const reference = String(item?.reference || '');
            const destination = String(item?.destination_masked || '');
            const currency = String(item?.currency || '');
            const kind = String(item?.return_kind || '');
            const state = String(item?.provider_state || '').toUpperCase();
            const status = String(item?.status || '');
            const conclusion = String(item?.review_conclusion || '');
            const validObservation = /^rro_[0-9a-f]{24}$/.test(observation);
            const validReview = /^rrv_[0-9a-f]{24}$/.test(review);
            const validReference = /^NORVA-[A-F0-9]{12}$/.test(reference);
            const validDestination = destination.length >= 4
                && destination.length <= 64
                && /[*•]/u.test(destination)
                && !/[\u0000-\u001f\u007f]/u.test(destination);
            const validMoney = Number.isSafeInteger(item?.amount_minor)
                && item.amount_minor > 0
                && /^[A-Z]{3}$/.test(currency);
            const actions = [];
            if (validObservation && status === 'pending'
                && this._partnersCapabilities.finance === true) {
                actions.push(`<button type="button" class="partners-action"
                    data-partners-action="revolut-return-review-eligible"
                    data-partners-observation="${AdminPage.esc(observation)}"
                    data-partners-reference="${AdminPage.esc(validReference ? reference : '')}"
                    data-partners-destination="${AdminPage.esc(validDestination ? destination : '')}"
                    data-partners-amount="${validMoney ? item.amount_minor : ''}"
                    data-partners-currency="${AdminPage.esc(validMoney ? currency : '')}">
                    Valider la revue
                  </button>`);
                actions.push(`<button type="button" class="partners-action is-danger"
                    data-partners-action="revolut-return-review-quarantine"
                    data-partners-observation="${AdminPage.esc(observation)}">
                    Revue en quarantaine
                  </button>`);
            }
            if (validReview && status === 'reviewed'
                && this._partnersCapabilities.finance === true) {
                if (conclusion === 'eligible') {
                    actions.push(`<button type="button" class="partners-action is-success"
                        data-partners-action="revolut-return-decide-confirm"
                        data-partners-review="${AdminPage.esc(review)}"
                        data-partners-reference="${AdminPage.esc(validReference ? reference : '')}"
                        data-partners-destination="${AdminPage.esc(validDestination ? destination : '')}"
                        data-partners-amount="${validMoney ? item.amount_minor : ''}"
                        data-partners-currency="${AdminPage.esc(validMoney ? currency : '')}">
                        Confirmer la résolution
                      </button>`);
                } else if (conclusion === 'quarantine') {
                    actions.push(`<button type="button" class="partners-action is-danger"
                        data-partners-action="revolut-return-decide-quarantine"
                        data-partners-review="${AdminPage.esc(review)}">
                        Confirmer la quarantaine
                      </button>`);
                }
            }
            const observed = item?.observed_at
                ? AdminPage.timeAgo(item.observed_at)
                : 'date indisponible';
            return `<div class="partners-ops-row">
              <span>${AdminPage.esc(validReference ? reference : 'Référence invalide')}
                <small>${AdminPage.esc(kindLabels[kind] || 'Nature indéterminée')}
                  · ${AdminPage.esc(providerStates[state] || 'État provider inconnu')}
                  · ${validMoney
                    ? `${AdminPage.n(item.amount_minor)} ${AdminPage.esc(currency)} en unités mineures`
                    : 'montant indisponible'}
                  · observé ${AdminPage.esc(observed)}
                  · destination attendue ${AdminPage.esc(validDestination ? destination : 'indisponible')}</small>
              </span>
              <div class="partners-risk-actions">${actions.join('')
                  || `<span class="partners-state${['pending', 'reviewed', 'quarantined'].includes(status) ? ' is-alert' : ' is-on'}">${AdminPage.esc(statusLabels[status] || 'État indisponible')}</span>`}</div>
            </div>`;
        }).join('');
        el.removeAttribute('aria-busy');
        el.innerHTML = `<div class="partners-control-head">
            <div><h2>Retours et déblocages Revolut</h2>
              <p>${AdminPage.n(data.total)} observation(s) terminale(s). Une résolution confirmée crée une contre-écriture dédiée ; aucun paiement déjà confirmé n’est réécrit.</p>
            </div>
          </div>
          <div class="partners-ops-list">${rows
              || '<div class="ssub">Aucun retour ou déblocage à traiter.</div>'}</div>`;
    }

    _renderPartnersRevolutManualControls(data) {
        const el = document.getElementById('partners-admin-manual-controls');
        if (!el) return;
        this._partnersManualControls = new Map();
        if (data?.schema_version !== 1 || !Number.isSafeInteger(data.total)
            || !Array.isArray(data.items)) {
            this._partnersOpsUnavailable(
                'partners-admin-manual-controls',
                'Contrôles des lots manuels'
            );
            return;
        }
        const rows = data.items.slice(0, 50).map((item) => {
            const key = String(item?.key || '');
            const type = String(item?.type || '');
            const status = String(item?.status || '');
            const batchKey = String(item?.batch_key || '');
            const referenceSetHash = String(item?.reference_set_hash || '');
            const references = Array.isArray(item?.references)
                ? item.references.slice(0, 5000)
                : [];
            const validKey = type === 'batch_cancellation'
                ? /^rmc_[0-9a-f]{24}$/.test(key)
                : type === 'unmapped_release'
                    && /^ruq_[0-9a-f]{24}$/.test(key);
            const validReferences = references.length > 0
                && references.every((row) => (
                    /^NORVA-[A-F0-9]{12}$/.test(
                        String(row?.reference || '')
                    )
                    && Number.isSafeInteger(row?.amount_minor)
                    && row.amount_minor > 0
                    && /^[A-Z]{3}$/.test(String(row?.currency || ''))
                    && Number.isInteger(row?.currency_exponent)
                    && row.currency_exponent >= 0
                    && row.currency_exponent <= 6
                ));
            if (validKey && /^rmb_[0-9a-f]{24}$/.test(batchKey)
                && /^[0-9a-f]{64}$/.test(referenceSetHash)
                && validReferences
                && ['pending', 'confirmed', 'rejected'].includes(status)) {
                this._partnersManualControls.set(key, {
                    key,
                    type,
                    status,
                    batchKey,
                    referenceSetHash,
                    references: references.map((row) => row.reference)
                });
            }
            const canConfirm = status === 'pending'
                && this._partnersCapabilities.finance === true
                && this._partnersManualControls.has(key);
            const label = type === 'batch_cancellation'
                ? 'Annulation intégrale du lot'
                : 'Déblocage des virements non saisis';
            const eligible = item?.eligible_at
                ? new Date(item.eligible_at).toLocaleString('fr-FR')
                : 'immédiatement';
            return `<div class="partners-ops-row">
              <span>${AdminPage.esc(label)} · ${AdminPage.esc(batchKey || 'lot indisponible')}
                <small>${AdminPage.n(references.length)} référence(s) · demandé ${AdminPage.esc(item?.requested_at ? AdminPage.timeAgo(item.requested_at) : 'date indisponible')} · fenêtre de sûreté ${AdminPage.esc(eligible)}</small>
              </span>
              <div class="partners-risk-actions">${canConfirm
                    ? `<button type="button" class="partners-action is-danger"
                        data-partners-action="revolut-manual-control-confirm"
                        data-partners-control="${AdminPage.esc(key)}">
                        Contrôle indépendant et décision
                      </button>
                      <button type="button" class="partners-action"
                        data-partners-action="revolut-manual-control-reject"
                        data-partners-control="${AdminPage.esc(key)}">
                        Rejeter la demande
                      </button>`
                    : `<span class="partners-state${status === 'confirmed' ? ' is-on' : ' is-alert'}">${status === 'confirmed' ? 'Confirmé' : status === 'rejected' ? 'Rejeté · lot dégelé' : 'Second opérateur requis'}</span>`}
              </div>
            </div>`;
        }).join('');
        el.removeAttribute('aria-busy');
        el.innerHTML = `<div class="partners-control-head">
            <div><h2>Contrôles des lots manuels</h2>
              <p>${AdminPage.n(data.total)} contrôle(s). La preuve reste dans le registre Finance ; Norva n’en conserve que l’empreinte SHA‑256 et l’horodatage.</p>
            </div>
          </div>
          <div class="partners-ops-list">${rows
              || '<div class="ssub">Aucune annulation ou libération en attente.</div>'}</div>`;
    }

    _renderPartnersRevolutLateCompletions(data) {
        const el = document.getElementById('partners-admin-late-completions');
        if (!el) return;
        this._partnersLateCompletionContexts = new Map();
        if (data?.schema_version !== 1 || !Number.isSafeInteger(data.total)
            || !Array.isArray(data.items)) {
            this._partnersOpsUnavailable(
                'partners-admin-late-completions',
                'Paiements tardifs'
            );
            return;
        }
        const rows = data.items.slice(0, 50).map((item) => {
            const observation = String(item?.observation_key || '');
            const review = String(item?.review_key || '');
            const reference = String(item?.reference || '');
            const destination = String(item?.destination_masked || '');
            const currency = String(item?.currency || '');
            const status = String(item?.status || '');
            const conclusion = String(item?.review_conclusion || '');
            const validObservation = /^rlc_[0-9a-f]{24}$/.test(observation);
            const validReview = /^rlv_[0-9a-f]{24}$/.test(review);
            const validReference = /^NORVA-[A-F0-9]{12}$/.test(reference);
            const validDestination = destination.length >= 4
                && destination.length <= 64
                && /[*•]/u.test(destination)
                && !/[\u0000-\u001f\u007f]/u.test(destination);
            const validMoney = Number.isSafeInteger(item?.amount_minor)
                && item.amount_minor > 0
                && /^[A-Z]{3}$/.test(currency);
            const actions = [];
            const verificationContext = {
                reference,
                destination,
                amount: item?.amount_minor,
                currency
            };
            if (validObservation && validReference && validDestination
                && validMoney) {
                this._partnersLateCompletionContexts.set(
                    observation,
                    verificationContext
                );
            }
            if (validReview && validReference && validDestination
                && validMoney) {
                this._partnersLateCompletionContexts.set(
                    review,
                    verificationContext
                );
            }
            if (validObservation && status === 'pending'
                && this._partnersCapabilities.finance === true) {
                actions.push(`<button type="button" class="partners-action"
                    data-partners-action="revolut-late-review-eligible"
                    data-partners-observation="${AdminPage.esc(observation)}">
                    Revue éligible
                  </button>`);
                actions.push(`<button type="button" class="partners-action is-danger"
                    data-partners-action="revolut-late-review-quarantine"
                    data-partners-observation="${AdminPage.esc(observation)}">
                    Revue en quarantaine
                  </button>`);
            }
            if (validReview && status === 'reviewed'
                && this._partnersCapabilities.finance === true) {
                actions.push(`<button type="button" class="partners-action ${conclusion === 'eligible' ? 'is-success' : 'is-danger'}"
                    data-partners-action="${conclusion === 'eligible'
                        ? 'revolut-late-decide-confirm'
                        : 'revolut-late-decide-quarantine'}"
                    data-partners-review="${AdminPage.esc(review)}">
                    ${conclusion === 'eligible'
                        ? 'Confirmer la récupération'
                        : 'Confirmer la quarantaine'}
                  </button>`);
            }
            const recovered = status === 'confirmed'
                ? ` · débit disponible ${AdminPage.n(Number(item?.available_debit_minor) || 0)} · créance ${AdminPage.n(Number(item?.recovery_due_minor) || 0)}`
                : '';
            return `<div class="partners-ops-row">
              <span>${AdminPage.esc(validReference ? reference : 'Référence invalide')}
                <small>${validMoney
                    ? `${AdminPage.n(item.amount_minor)} ${AdminPage.esc(currency)} en unités mineures`
                    : 'montant indisponible'} · ${AdminPage.esc(String(item?.adapter || 'rail inconnu'))} · destination ${AdminPage.esc(validDestination ? destination : 'indisponible')} · observé ${AdminPage.esc(item?.observed_at ? AdminPage.timeAgo(item.observed_at) : 'date indisponible')}${recovered}</small>
              </span>
              <div class="partners-risk-actions">${actions.join('')
                    || `<span class="partners-state${['pending', 'reviewed', 'quarantined'].includes(status) ? ' is-alert' : ' is-on'}">${AdminPage.esc({
                        pending: 'Revue requise',
                        reviewed: 'Second opérateur requis',
                        confirmed: 'Récupération comptabilisée',
                        quarantined: 'Quarantaine maintenue'
                    }[status] || 'État indisponible')}</span>`}
              </div>
            </div>`;
        }).join('');
        el.removeAttribute('aria-busy');
        el.innerHTML = `<div class="partners-control-head">
            <div><h2>Paiements tardifs après déblocage</h2>
              <p>${AdminPage.n(data.total)} observation(s). Le ledger crée une écriture de récupération dédiée sans réécrire le déblocage historique.</p>
            </div>
          </div>
          <div class="partners-ops-list">${rows
              || '<div class="ssub">Aucun paiement tardif à traiter.</div>'}</div>`;
    }

    _renderPartnersConfiguration(data, { focusControl = '' } = {}) {
        const el = document.getElementById('partners-admin-configuration');
        if (!el) return;
        if (![1, 2].includes(Number(data?.schema_version)) || !Array.isArray(data.programs)
            || !Array.isArray(data.policies) || !data.configuration_counts) {
            this._partnersOpsUnavailable('partners-admin-configuration', 'Programme et release');
            return;
        }
        this._partnersConfiguration = data;
        const gates = Array.isArray(data.release_gates) ? data.release_gates : [];
        const manifests = Array.isArray(data.deployment_manifests)
            ? data.deployment_manifests : [];
        const counts = data.configuration_counts;
        const gateSatisfied = (key) => gates.some((gate) => (
            gate?.key === key && gate?.satisfied === true
        ));
        const programs = data.programs.map((program) => {
            const key = String(program?.version_key || '');
            const isDraft = program?.status === 'draft';
            const activationMissing = [
                !gateSatisfied('legal_and_tax_approved')
                    ? 'validation juridique et fiscale' : '',
                !gateSatisfied('membership_privacy_approved')
                    ? 'validation Privacy de l’adhésion' : ''
            ].filter(Boolean);
            let activationControl = '';
            if (isDraft && key) {
                if (activationMissing.length > 0) {
                    activationControl = `<span class="partners-state is-alert">Activation bloquée · Prérequis manquants : ${AdminPage.esc(activationMissing.join(', '))}</span>`;
                } else if (this._partnersCanUseConfigurationAction('program-activate')) {
                    activationControl = `<button type="button" class="partners-action is-success"
                    data-partners-action="program-activate" data-partners-key="${AdminPage.esc(key)}">Activer</button>`;
                }
            }
            return `<div class="partners-control-item">
                <span>${AdminPage.esc(key || 'Programme')}
                  <small>20 % · attribution ${AdminPage.n(Number(program?.attribution_window_days) || 0)} j · maturation J+${AdminPage.n(Number(program?.maturation_days) || 0)} · ${AdminPage.esc(String(program?.terms_version || 'terms inconnus'))}</small>
                </span>
                <div class="partners-risk-actions">
                  <span class="partners-state${program?.status === 'active' ? ' is-on' : ''}">${AdminPage.esc(String(program?.status || 'unknown'))}</span>
                  ${activationControl}
                </div>
              </div>`;
        }).join('');
        const policyPageCount = Math.max(1, Math.ceil(data.policies.length / this._partnersPolicyLimit));
        this._partnersPolicyPage = Math.min(Math.max(0, this._partnersPolicyPage), policyPageCount - 1);
        const policyStart = this._partnersPolicyPage * this._partnersPolicyLimit;
        const policyPage = data.policies.slice(policyStart, policyStart + this._partnersPolicyLimit);
        const policies = policyPage.map((policy) => {
            const programKey = String(policy?.program_version_key || '');
            const country = String(policy?.country_code || '');
            const subdivision = String(policy?.subdivision_code || '');
            const enabled = policy?.individual_available === true;
            const kyc = policy?.kyc_attempt_policy;
            const program = data.programs.find((candidate) => (
                String(candidate?.version_key || '') === programKey
            ));
            const programEffectiveAt = Date.parse(String(program?.effective_from || ''));
            const payoutCurrencies = Array.isArray(policy?.payout_currencies)
                ? policy.payout_currencies.filter((currency) => /^[A-Z]{3}$/.test(String(currency || '')))
                : [];
            const activeMappingCount = Number(counts.active_country_mappings);
            const activeCurrencyCount = Number(counts.active_currencies);
            const activePayoutCount = Number(counts.active_payout_providers);
            const openingMissing = [];
            if (!program || program.status !== 'active') {
                openingMissing.push('programme actif');
            } else if (!Number.isFinite(programEffectiveAt)) {
                openingMissing.push('date d’effet du programme disponible');
            } else if (programEffectiveAt > Date.now()) {
                openingMissing.push('date d’effet du programme atteinte');
            }
            if (kyc?.status !== 'active') openingMissing.push('politique KYC active');
            if (!Number.isSafeInteger(activeMappingCount) || activeMappingCount < 1) {
                openingMissing.push('mapping pays actif');
            }
            if (payoutCurrencies.length < 1) {
                openingMissing.push('devise de versement configurée');
            } else {
                if (!Number.isSafeInteger(activeCurrencyCount)
                    || activeCurrencyCount < payoutCurrencies.length) {
                    openingMissing.push('couverture des devises actives');
                }
                if (!Number.isSafeInteger(activePayoutCount)
                    || activePayoutCount < payoutCurrencies.length) {
                    openingMissing.push('couverture payout active');
                }
            }
            let availabilityControl = '';
            if (!enabled && openingMissing.length > 0) {
                availabilityControl = `<span class="partners-state is-alert">Ouverture bloquée · Prérequis manquants : ${AdminPage.esc(openingMissing.join(', '))}</span>`;
            } else if (this._partnersCanUseConfigurationAction('country-availability')) {
                availabilityControl = `<button type="button" class="partners-action${enabled ? ' is-danger' : ' is-success'}"
                    data-partners-action="country-availability"
                    data-partners-program="${AdminPage.esc(programKey)}"
                    data-partners-country="${AdminPage.esc(country)}"
                    data-partners-subdivision="${AdminPage.esc(subdivision)}"
                    data-partners-enabled="${enabled ? 'false' : 'true'}">${enabled ? 'Fermer' : 'Ouvrir'}</button>`;
            }
            return `<div class="partners-control-item">
                <span>${AdminPage.esc(country || '—')}${subdivision ? ` · ${AdminPage.esc(subdivision)}` : ''}
                  <small>${AdminPage.esc(programKey)} · majorité ${AdminPage.n(Number(policy?.minimum_age) || 0)} ans · ${AdminPage.esc((Array.isArray(policy?.payout_currencies) ? policy.payout_currencies : []).join(', ') || 'devise non configurée')} · KYC ${AdminPage.esc(String(kyc?.status || 'absent'))}</small>
                </span>
                <div class="partners-risk-actions">
                  ${this._partnersCanUseConfigurationAction('kyc-policy') ? `<button type="button" class="partners-action"
                    data-partners-action="kyc-policy"
                    data-partners-program="${AdminPage.esc(programKey)}"
                    data-partners-country="${AdminPage.esc(country)}"
                    data-partners-subdivision="${AdminPage.esc(subdivision)}">KYC</button>` : ''}
                  ${availabilityControl}
                </div>
              </div>`;
        }).join('');
        const flags = Array.isArray(data.release_flags) ? data.release_flags : [];
        const releaseFlagLabels = {
            partners_enabled: 'Adhésion et partage publics',
            partners_invite_only: 'Adhésion limitée aux invitations',
            partners_cash_pilot_allowlist_only: 'Virements cash limités à la cohorte pilote',
            partners_earnings_enabled: 'Attribution et commissions',
            partners_credit_redemptions_enabled: 'Conversion en accès Norva',
            partners_shadow_mode: 'Réconciliation shadow',
            partners_payouts_live: 'Préparation des lots cash live',
            partners_tv_relay_enabled: 'Relais Partners TV',
            partners_revolut_api_enabled: 'API Revolut Business'
        };
        const releaseGateLabels = {
            legal_and_tax_approved: 'Position juridique/fiscale et risque propriétaire',
            membership_privacy_approved: 'Privacy de l’adhésion publique',
            privacy_approved: 'AIPD Privacy du virement cash',
            country_policy_approved: 'Politique pays du virement cash',
            individual_verification_coverage_confirmed: 'Couverture KYC individuelle',
            individual_payout_coverage_confirmed: 'Couverture de versement individuel',
            financial_data_contract_approved: 'Contrat des données financières',
            shadow_reconciliation_clean: 'Réconciliation shadow sans écart',
            backup_restore_verified: 'Sauvegarde et restauration vérifiées',
            payout_execution_adapter_verified: 'Adaptateur de versement vérifié',
            manual_payout_workflow_verified: 'Workflow Revolut manuel vérifié',
            revolut_api_adapter_verified: 'Adaptateur API Revolut vérifié',
            tv_relay_security_verified: 'Sécurité du relais TV',
            general_release_approved: 'Release générale approuvée'
        };
        const releaseRows = [
            ...flags.map((flag) => ({
                action: 'release-flag',
                key: flag?.key,
                enabled: flag?.enabled === true,
                label: releaseFlagLabels[flag?.key]
                    ? `Flag · ${releaseFlagLabels[flag.key]}`
                    : `Flag · ${flag?.key || 'inconnu'}`
            })),
            ...gates.map((gate) => ({
                action: 'release-gate',
                key: gate?.key,
                enabled: gate?.satisfied === true,
                label: releaseGateLabels[gate?.key]
                    ? `Gate · ${releaseGateLabels[gate.key]}`
                    : `Gate · ${gate?.key || 'inconnu'}`,
                approvalStatus: String(gate?.approval_status || (
                    gate?.satisfied === true
                        ? 'current'
                        : (gate?.preproduction_satisfied === true
                            ? 'current_preproduction' : 'not_satisfied')
                )),
                provenance: gate?.approval_provenance
            }))
        ].filter((row) => /^[a-z0-9_]+$/.test(String(row.key || ''))).map((row) => {
            const kind = row.action === 'release-flag' ? 'flag' : 'gate';
            const targetEnabled = !row.enabled;
            const control = this._partnersCanUseReleaseControl(kind, row.key, targetEnabled)
                ? `<button type="button" class="partners-action${row.enabled ? ' is-danger' : ' is-success'}"
                    data-partners-action="${row.action}"
                    data-partners-key="${AdminPage.esc(row.key)}"
                    data-partners-enabled="${targetEnabled ? 'true' : 'false'}">${row.enabled
                        ? 'Désactiver'
                        : (kind === 'gate' ? 'Approuver avec preuves' : 'Activer')}</button>`
                : `<span class="partners-state${row.enabled ? ' is-on' : ''}">${row.enabled ? 'Actif' : 'Inactif'} · lecture seule</span>`;
            const approvalLabel = row.approvalStatus === 'current_preproduction'
                ? 'courante en préproduction uniquement · aucune autorité live'
                : row.approvalStatus;
            const provenance = kind === 'gate' && row.provenance
                ? `<small>Approbation ${AdminPage.esc(approvalLabel)} · package #${AdminPage.n(Number(row.provenance.package_version) || 0)} · ${AdminPage.esc(String(row.provenance.deployment_environment || 'environnement inconnu'))} · commit ${AdminPage.esc(String(row.provenance.source_commit_sha || '').slice(0, 12) || 'inconnu')} · expiration ${AdminPage.esc(AdminPage.timeAgo(row.provenance.expires_at))}</small>`
                : (kind === 'gate'
                    ? `<small>Approbation ${AdminPage.esc(row.approvalStatus || 'absente')} · aucune preuve courante</small>`
                    : '');
            return `<div class="partners-control-item">
              <span>${AdminPage.esc(row.label)}${provenance}</span>
              ${control}
            </div>`;
        }).join('');
        const configurationActions = [
            ['program-create', 'Nouveau programme'],
            ['country-create', 'Nouvelle juridiction'],
            ['country-map', 'Mapping pays'],
            ['currency', 'Devise'],
            ['payout-provider', 'Couverture Revolut'],
            ['allowlist', 'Pilote allowlist']
        ].filter(([action]) => this._partnersCanUseConfigurationAction(action))
            .map(([action, label]) => `<button type="button" class="partners-action"
                data-partners-action="${action}">${label}</button>`)
            .join('');
        const deploymentActions = this._partnersCanManageRelease === true
            ? '<button type="button" class="partners-action" data-partners-action="release-manifest">Enregistrer un manifeste de déploiement</button>'
            : '';
        const deploymentRows = manifests.map((manifest) => {
            const environment = String(manifest?.deployment_environment || '');
            const version = Number(manifest?.manifest_version);
            const manifestHash = String(manifest?.manifest_sha256 || '');
            const commit = String(manifest?.source_commit_sha || '');
            const rawKeys = Array.isArray(manifest?.document_keys)
                ? manifest.document_keys : [];
            const keys = rawKeys.filter((key) => (
                /^[a-z][a-z0-9_]{2,63}$/.test(String(key || ''))
            ));
            if (!['preproduction', 'production'].includes(environment)
                || !Number.isSafeInteger(version) || version < 1
                || !/^[0-9a-f]{64}$/.test(manifestHash)
                || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)
                || keys.length !== rawKeys.length) return '';
            return `<div class="partners-control-item">
              <span>${AdminPage.esc(environment)} · manifeste #${AdminPage.n(version)}
                <small>commit ${AdminPage.esc(commit.slice(0, 12))} · empreinte ${AdminPage.esc(manifestHash.slice(0, 12))}… · ${AdminPage.n(keys.length)} preuve(s) · ${AdminPage.esc(AdminPage.timeAgo(manifest.registered_at))}</small>
              </span>
              <span class="partners-state is-on">Courant</span>
            </div>`;
        }).filter(Boolean).join('');
        el.removeAttribute('aria-busy');
        el.innerHTML = `<div class="partners-control-head">
            <div><h2>Programme, juridictions et release</h2><p>Les mutations exigent une justification auditée et les dépendances restent contrôlées côté serveur.</p></div>
            <span class="partners-state">${AdminPage.n(data.programs.length)} programme(s) · ${AdminPage.n(data.policies.length)} juridiction(s)</span>
          </div>
          <div class="partners-action-row">
            ${configurationActions}${deploymentActions}${configurationActions || deploymentActions ? '' : '<span class="partners-state">Configuration en lecture seule pour vos capacités</span>'}
          </div>
          <div class="partners-ops-stats" style="margin-top:12px">
            <div class="partners-ops-stat"><strong>${AdminPage.n(Number(counts.active_country_mappings) || 0)}</strong><span>mappings pays actifs</span></div>
            <div class="partners-ops-stat"><strong>${AdminPage.n(Number(counts.active_currencies) || 0)}</strong><span>devises actives</span></div>
            <div class="partners-ops-stat"><strong>${AdminPage.n(Number(counts.active_payout_providers) || 0)}</strong><span>couvertures payout</span></div>
          </div>
          <section aria-labelledby="partners-programs-title">
            <div class="partners-control-head" style="margin-top:14px"><div><h3 id="partners-programs-title">Programmes</h3><p>${AdminPage.n(data.programs.length)} version(s) configurée(s)</p></div></div>
            <div class="partners-control-grid">${programs || '<div class="ssub">Aucun programme configuré.</div>'}</div>
          </section>
          <section aria-labelledby="partners-policies-title">
            <div class="partners-control-head" style="margin-top:14px"><div><h3 id="partners-policies-title">Juridictions</h3><p>Configuration paginée, sans tronquer la liste autoritative.</p></div></div>
            <div id="partners-policy-list" class="partners-control-grid">${policies || '<div class="ssub">Aucune juridiction configurée.</div>'}</div>
            <nav class="partners-pagination" aria-label="Pagination des juridictions">
              <span class="partners-pagination-status" role="status" aria-live="polite" aria-atomic="true">${data.policies.length ? AdminPage.n(policyStart + 1) : 0}–${AdminPage.n(Math.min(policyStart + this._partnersPolicyLimit, data.policies.length))} sur ${AdminPage.n(data.policies.length)}</span>
              <button type="button" class="partners-page-btn" data-partners-policy-page="prev" aria-controls="partners-policy-list" aria-label="Page précédente des juridictions"${this._partnersPolicyPage === 0 ? ' disabled' : ''}>Précédente</button>
              <button type="button" class="partners-page-btn" data-partners-policy-page="next" aria-controls="partners-policy-list" aria-label="Page suivante des juridictions"${this._partnersPolicyPage >= policyPageCount - 1 ? ' disabled' : ''}>Suivante</button>
            </nav>
          </section>
          <section aria-labelledby="partners-release-title">
            <div class="partners-control-head" style="margin-top:14px"><div><h3 id="partners-release-title">Release</h3><p>Chaque gate activée est liée à un manifeste, un commit, une juridiction et des preuves immuables.</p></div></div>
            <div class="partners-control-grid">${deploymentRows || '<div class="ssub">Aucun manifeste de déploiement courant. Enregistrez d’abord le déploiement préproduction.</div>'}</div>
            ${releaseRows ? `<div class="partners-control-grid">${releaseRows}</div>` : '<div class="ssub">États de release indisponibles dans ce déploiement.</div>'}
          </section>
          <div class="ssub" style="margin-top:10px">${AdminPage.n(Number(counts.active_allowlist_entries) || 0)} compte(s) pilote autorisé(s).</div>`;
        if (focusControl) setTimeout(() => {
            let target = document.querySelector(`[data-partners-policy-page="${focusControl}"]`);
            if ((!target || target.disabled) && ['prev', 'next'].includes(focusControl)) {
                const fallback = focusControl === 'next' ? 'prev' : 'next';
                target = document.querySelector(`[data-partners-policy-page="${fallback}"]:not(:disabled)`);
            }
            this._partnersFocusElement(target);
        }, 0);
    }

    _renderPartnersKycQuota(data) {
        const el = document.getElementById('partners-admin-kyc');
        if (!el) return;
        if (data?.schema_version !== 1
            || !Number.isSafeInteger(data.used)
            || !Number.isSafeInteger(data.informational_limit)
            || !Number.isSafeInteger(data.remaining)
            || typeof data.utilization_percent !== 'number'
            || data.blocking !== false) {
            this._partnersOpsUnavailable('partners-admin-kyc', 'KYC individuel');
            return;
        }
        const utilization = Math.max(0, Math.min(999, data.utilization_percent));
        el.removeAttribute('aria-busy');
        el.innerHTML = `<h2>KYC individuel</h2>
            <p>Fenêtre glissante de ${AdminPage.n(data.window_days)} jours. Le seuil gratuit est informatif et ne bloque jamais automatiquement la vérification 501.</p>
            <div class="partners-ops-stats">
              <div class="partners-ops-stat"><strong>${AdminPage.n(data.used)}</strong><span>utilisées</span></div>
              <div class="partners-ops-stat"><strong>${AdminPage.n(data.remaining)}</strong><span>gratuites restantes</span></div>
              <div class="partners-ops-stat"><strong>${AdminPage.esc(utilization.toFixed(1))}%</strong><span>du seuil informatif</span></div>
            </div>`;
    }

    _renderPartnersKycCertification(data) {
        const el = document.getElementById('partners-admin-kyc-certification');
        if (!el) return;
        const mutationActive = this._partnersRequests instanceof Map
            && this._partnersRequests.has('kycCertificationMutation');
        if (mutationActive && el.innerHTML) {
            // The initiating button already carries its busy state. A background
            // poll must not replace it, steal focus, or expose a second action.
            el.removeAttribute('aria-busy');
            this._partnersScheduleKycCertificationPoll(3_000);
            return;
        }
        const certification = data?.certification;
        const statuses = new Set([
            'reserved', 'pending', 'in_review', 'approved', 'declined',
            'expired', 'quarantined'
        ]);
        const reasons = new Set([
            'provider_environment_mismatch', 'provider_config_mismatch',
            'provider_workflow_mismatch', 'approved_checks_incomplete',
            'stale_event', 'binding_conflict'
        ]);
        const exactKeys = (value, expected) => value && typeof value === 'object'
            && !Array.isArray(value)
            && Object.keys(value).sort().join('|') === expected.slice().sort().join('|');
        const valid = data?.schema_version === 1
            && data?.action === 'kyc_certification_status'
            && (certification === null || (
                exactKeys(certification, [
                    'environment', 'expires_at', 'observed_at', 'reason',
                    'status', 'verified'
                ])
                && statuses.has(certification.status)
                && typeof certification.verified === 'boolean'
                && [null, 'sandbox', 'live'].includes(certification.environment)
                && Number.isFinite(Date.parse(String(certification.expires_at || '')))
                && Number.isFinite(Date.parse(String(certification.observed_at || '')))
                && (certification.reason === null || reasons.has(certification.reason))
                && (!certification.verified
                    || (certification.status === 'approved'
                        && certification.environment === 'live'))
                && ((certification.status === 'quarantined')
                    === (certification.reason !== null))
            ));
        if (!valid) {
            clearTimeout(this._partnersKycCertificationPollTimer);
            this._partnersKycCertificationPollTimer = null;
            this._partnersOpsUnavailable(
                'partners-admin-kyc-certification',
                'Validation finale Didit'
            );
            this._partnersScheduleKycCertificationPoll(3_000);
            return;
        }

        const active = certification
            && ['reserved', 'pending', 'in_review'].includes(certification.status);
        const labels = {
            reserved: 'Réservation en cours',
            pending: 'Vérification en cours',
            in_review: 'Revue Didit en cours',
            approved: certification?.verified
                ? 'Preuve live vérifiée'
                : 'Observation approuvée non autoritaire',
            declined: 'Vérification refusée',
            expired: 'Session expirée',
            quarantined: 'Observation mise en quarantaine'
        };
        const reasonLabels = {
            provider_environment_mismatch: 'environnement fournisseur incohérent',
            provider_config_mismatch: 'configuration fournisseur incohérente',
            provider_workflow_mismatch: 'workflow fournisseur incohérent',
            approved_checks_incomplete: 'contrôles obligatoires incomplets',
            stale_event: 'événement tardif ou périmé',
            binding_conflict: 'conflit de liaison ou de rejeu'
        };
        const environment = certification?.environment === 'live'
            ? 'Environnement live'
            : (certification?.environment === 'sandbox'
                ? 'Environnement sandbox · non autoritaire'
                : 'Environnement en attente');
        const checkingUnknownResult =
            Date.now() < this._partnersKycCertificationPollUntil;
        const canStart = this._partnersCapabilities.risk === true
            && !active
            && certification?.verified !== true
            && !checkingUnknownResult
            && !mutationActive;
        const canResume = this._partnersCapabilities.risk === true
            && ['reserved', 'pending'].includes(certification?.status)
            && !mutationActive;
        let action = canStart
            ? '<button type="button" class="partners-action" data-partners-action="kyc-certification-start">Préparer la certification</button>'
            : (canResume
                ? '<button type="button" class="partners-action" data-partners-action="kyc-certification-resume">Reprendre sur Didit</button>'
                : (active
                    ? '<span class="partners-state">Décision signée en attente</span>'
                    : '<span class="partners-state">Lecture seule</span>'));
        if (checkingUnknownResult && !active) {
            action = '<span class="partners-state">Norva v&eacute;rifie l&rsquo;&eacute;tat&hellip;</span>';
        }
        if (mutationActive) {
            action = '<span class="partners-state">Traitement s&eacute;curis&eacute; en cours&hellip;</span>';
        }
        const status = certification
            ? `<div class="partners-control-item partners-kyc-certification">
                <span><strong>${AdminPage.esc(labels[certification.status])}</strong>
                  <small>${AdminPage.esc(environment)} · observé ${AdminPage.esc(AdminPage.timeAgo(certification.observed_at))}${certification.reason ? ` · ${AdminPage.esc(reasonLabels[certification.reason])}` : ''}</small>
                </span>${action}
              </div>`
            : `<div class="partners-control-item partners-kyc-certification">
                <span><strong>Aucune certification enregistrée</strong>
                  <small>Cette validation concerne uniquement le futur parcours KYC cash. L’adhésion, le partage et les crédits Norva restent séparés.</small>
                </span>${action}
              </div>`;
        const signature = JSON.stringify([
            certification?.status || null,
            certification?.verified === true,
            certification?.environment || null,
            certification?.reason || null,
            certification?.expires_at || null,
            this._partnersCapabilities.risk === true,
            checkingUnknownResult,
            mutationActive
        ]);
        el.removeAttribute('aria-busy');
        if (el.dataset?.partnersKycSignature === signature) {
            this._partnersScheduleKycCertificationPoll(3_000);
            return;
        }
        const focused = document.activeElement;
        const focusWasInside = el.contains?.(focused) === true;
        const focusedAction = focusWasInside
            ? String(focused?.dataset?.partnersAction || '') : '';
        el.innerHTML = `<h2>Validation finale Didit</h2>
            <p>Norva affiche tous les prérequis avant toute saisie, puis regroupe le consentement, le motif et Authenticator dans une seule fenêtre. Une sandbox ne peut jamais valider la preuve live.</p>
            <aside class="partners-provider-disclosure" aria-label="Informations juridiques Didit">
              <strong>Avant d'utiliser votre identité réelle</strong>
              <span>Norva demande cette certification ponctuelle et Didit fournit le parcours hébergé. Consultez la <a href="/privacy.html#partners" target="_blank" rel="noopener">Privacy Norva</a>, la <a href="https://didit.me/terms/verification-privacy-notice/" target="_blank" rel="noopener noreferrer">notice de confidentialité Didit</a> et les <a href="https://didit.me/terms/identity-verification/" target="_blank" rel="noopener noreferrer">conditions Didit de vérification</a>.</span>
            </aside>
            <div role="status" aria-live="polite" aria-atomic="true">${status}</div>`;
        if (el.dataset) el.dataset.partnersKycSignature = signature;
        if (focusWasInside) {
            const generation = this._partnersPageGeneration;
            setTimeout(() => {
                if (this._route !== 'partners' || this._partnersView !== 'risk'
                    || generation !== this._partnersPageGeneration) return;
                const actionTarget = focusedAction
                    ? el.querySelector?.(`[data-partners-action="${focusedAction}"]`)
                    : null;
                this._partnersFocusElement(actionTarget || el);
            }, 0);
        }

        this._partnersScheduleKycCertificationPoll(3_000);
    }

    _renderPartnersFinance(data) {
        const el = document.getElementById('partners-admin-finance');
        if (!el) return;
        if (data?.schema_version !== 1 || !data.queues || !data.reconciliation
            || !Array.isArray(data.currencies)) {
            this._partnersOpsUnavailable('partners-admin-finance', 'Ledger et worker');
            return;
        }
        const queueRows = [
            ['Jobs en attente', data.queues.commission_pending],
            ['Retries', data.queues.commission_retry],
            ['Dead letter', data.queues.commission_dead_letter],
            ['Corrections en attente', data.queues.correction_pending],
            ['Corrections en retry', data.queues.correction_retry],
            ['Corrections en dead letter', data.queues.correction_dead_letter],
            ['Maturations dues', data.queues.maturation_due],
            ['Maturations en échec', data.queues.maturation_dead_letter]
        ];
        const currencies = data.currencies.slice(0, 8).map((row) => {
            const code = /^[A-Z]{3}$/.test(String(row?.currency || ''))
                ? row.currency : '—';
            return `<div class="partners-ops-row">
                <span>${AdminPage.esc(code)} · validation / disponible / clearing</span>
                <strong>${AdminPage.n(Number(row?.pending_minor) || 0)} · ${AdminPage.n(Number(row?.available_minor) || 0)} · ${AdminPage.n(Number(row?.payout_clearing_minor) || 0)}</strong>
            </div>`;
        }).join('');
        const lastRun = data.reconciliation.last_run_at
            ? AdminPage.timeAgo(data.reconciliation.last_run_at) : 'jamais observée';
        const financeActions = [
            this._partnersCanUseOperationalAction('job-retry')
                ? '<button type="button" class="partners-action" data-partners-action="job-retry">Relancer un dead letter</button>' : '',
            this._partnersCanUseOperationalAction('commission-reverse')
                ? '<button type="button" class="partners-action is-danger" data-partners-action="commission-reverse">Contre-écriture contrôlée</button>' : ''
        ].filter(Boolean).join('');
        el.removeAttribute('aria-busy');
        el.innerHTML = `<h2>Ledger et worker</h2>
            <p>Montants en unités mineures par devise. Aucune conversion ni taxe n’est inférée.</p>
            <div class="partners-action-row" style="margin-bottom:10px">
              ${financeActions || '<span class="partners-state">Lecture seule · capacité Finance requise</span>'}
            </div>
            <div class="partners-ops-stats">${queueRows.slice(0, 6).map(([label, value]) =>
                `<div class="partners-ops-stat"><strong>${AdminPage.n(Number(value) || 0)}</strong><span>${AdminPage.esc(label)}</span></div>`
            ).join('')}</div>
            <div class="partners-ops-list">
              ${queueRows.slice(6).map(([label, value]) => `<div class="partners-ops-row"><span>${AdminPage.esc(label)}</span><strong>${AdminPage.n(Number(value) || 0)}</strong></div>`).join('')}
              <div class="partners-ops-row"><span>Cohérence du ledger interne · ${AdminPage.esc(String(data.reconciliation.last_status || 'inconnue'))} · ${AdminPage.esc(lastRun)}</span><strong>${AdminPage.n(Number(data.reconciliation.mismatches) || 0)} écart(s)</strong></div>
              ${currencies || '<div class="ssub">Aucun solde financier observé.</div>'}
            </div>`;
    }

    _renderPartnersRisk(data) {
        const el = document.getElementById('partners-admin-risk');
        if (!el) return;
        if (data?.schema_version !== 1 || !Number.isSafeInteger(data.total)
            || !Array.isArray(data.items)) {
            this._partnersOpsUnavailable('partners-admin-risk', 'Risque');
            return;
        }
        const reasonLabels = {
            financial_fact_conflict: 'Conflit de faits financiers',
            risk_hold: 'Revue risque',
            suspended: 'Compte suspendu',
            dead_letter: 'Traitement en échec terminal',
            review: 'Revue requise'
        };
        const statusLabels = {
            held: 'En revue',
            suspended: 'Suspendu',
            active: 'Actif',
            closed: 'Clôturé'
        };
        const rows = data.items.slice(0, 8).map((item) => {
            const accountId = String(item?.account_id || '');
            const status = String(item?.status || '');
            const reason = reasonLabels[String(item?.reason || '')] || 'Revue opérationnelle';
            const actions = this._partnersCanUseOperationalAction('account-action')
                && /^prt_[0-9a-f]{24}$/.test(accountId)
                ? [
                    ...(status === 'held'
                        ? [['release', 'Libérer', 'is-success']]
                        : [['hold', 'Mettre en revue', '']]),
                    ...(status !== 'suspended'
                        ? [['suspend', 'Suspendre', 'is-danger']]
                        : []),
                    ['close', 'Clôturer', 'is-danger']
                ].map(([action, label, cls]) =>
                    `<button type="button" class="partners-action ${cls}"
                      data-partners-action="account-action"
                      data-partners-account="${AdminPage.esc(accountId)}"
                      data-partners-operation="${action}">${label}</button>`
                ).join('')
                : '';
            return `<div class="partners-ops-row">
              <span>${AdminPage.esc(accountId || 'Partenaire')} · ${AdminPage.esc(reason)}
                <small>${AdminPage.n(Number(item?.dead_letter_jobs) || 0)} échec(s) terminal(aux) · ${AdminPage.esc(statusLabels[status] || 'État inconnu')}</small>
              </span>
              <div class="partners-risk-actions">${actions || '<span class="partners-state">Lecture seule</span>'}</div>
            </div>`;
        }).join('');
        el.removeAttribute('aria-busy');
        el.innerHTML = `<h2>Risque</h2>
            <p>${AdminPage.n(data.total)} dossier(s) pseudonymisé(s). Les signaux réseau, documents et payloads provider ne sont pas affichés.</p>
            <div class="partners-ops-list">${rows || '<div class="ssub">Aucune revue en attente.</div>'}</div>`;
    }

    _renderPartnersKycHumanReviews(data) {
        const el = document.getElementById('partners-admin-kyc-human-reviews');
        if (!el) return;
        const expectedKeys = [
            'review_key',
            'account_id',
            'status',
            'reason',
            'resolution',
            'verification_status',
            'consent_status',
            'requested_at',
            'updated_at',
            'resolved_at'
        ].sort().join('|');
        const valid = data?.schema_version === 1
            && Number.isSafeInteger(data.total)
            && data.total >= 0
            && Array.isArray(data.items)
            && data.items.length <= 100
            && data.items.every((item) => item
                && typeof item === 'object'
                && !Array.isArray(item)
                && Object.keys(item).sort().join('|') === expectedKeys
                && /^khr_[0-9a-f]{24}$/.test(String(item.review_key || ''))
                && /^prt_[0-9a-f]{24}$/.test(String(item.account_id || ''))
                && ['requested', 'in_review', 'resolved'].includes(item.status)
                && ['identity_result_contested', 'age_result_contested',
                    'country_result_contested', 'verification_unavailable',
                    'other_result_contested'].includes(item.reason)
                && ['not_withdrawn', 'withdrawn'].includes(item.consent_status)
                && Number.isFinite(Date.parse(String(item.requested_at || '')))
                && Number.isFinite(Date.parse(String(item.updated_at || ''))));
        if (!valid) {
            this._partnersOpsUnavailable(
                'partners-admin-kyc-human-reviews',
                'Recours humains KYC'
            );
            return;
        }
        const reasonLabels = {
            identity_result_contested: 'Identite contestee',
            age_result_contested: 'Age conteste',
            country_result_contested: 'Pays conteste',
            verification_unavailable: 'Verification impossible',
            other_result_contested: 'Autre resultat conteste'
        };
        const statusLabels = {
            requested: 'A prendre en charge',
            in_review: 'Revue humaine en cours',
            resolved: 'Recours traite'
        };
        const resolutionLabels = {
            original_decision_upheld: 'Decision initiale maintenue',
            reverification_available: 'Nouvelle verification autorisee'
        };
        const canDecide = this._partnersCapabilities.risk === true;
        const rows = data.items.map((item) => {
            const key = String(item.review_key);
            const actions = [];
            if (canDecide && item.status !== 'resolved') {
                actions.push(`<button type="button" class="partners-action"
                    data-partners-action="kyc-human-review-locator"
                    data-partners-review-key="${AdminPage.esc(key)}"
                    data-partners-enabled="true">Ouvrir dans Didit</button>`);
            }
            if (canDecide && item.status === 'requested') {
                actions.push(`<button type="button" class="partners-action is-success"
                    data-partners-action="kyc-human-review-start"
                    data-partners-review-key="${AdminPage.esc(key)}"
                    data-partners-enabled="true">Prendre en charge</button>`);
            }
            if (canDecide && item.status === 'in_review') {
                actions.push(`<button type="button" class="partners-action"
                    data-partners-action="kyc-human-review-uphold"
                    data-partners-review-key="${AdminPage.esc(key)}"
                    data-partners-enabled="true">Maintenir</button>`);
                actions.push(`<button type="button" class="partners-action is-success"
                    data-partners-action="kyc-human-review-reverify"
                    data-partners-review-key="${AdminPage.esc(key)}"
                    data-partners-enabled="true">Autoriser un nouveau controle</button>`);
            }
            return `<article class="partners-ops-row" data-partners-review="${AdminPage.esc(key)}">
                <span><strong>${AdminPage.esc(key)}</strong> · ${AdminPage.esc(String(item.account_id))}
                  <small>${AdminPage.esc(reasonLabels[item.reason])} · ${AdminPage.esc(statusLabels[item.status])} · consentement ${AdminPage.esc(item.consent_status === 'withdrawn' ? 'retire' : 'non retire')} · ${AdminPage.esc(AdminPage.timeAgo(item.updated_at))}</small>
                  ${item.resolution ? `<small>${AdminPage.esc(resolutionLabels[item.resolution] || item.resolution)}</small>` : ''}
                </span>
                <div class="partners-risk-actions">${actions.join('') || '<span class="partners-state">Lecture seule</span>'}</div>
              </article>`;
        }).join('');
        el.removeAttribute('aria-busy');
        el.innerHTML = `<div class="partners-control-head"><div><h2>Recours humains KYC</h2>
            <p>${AdminPage.n(data.total)} demande(s) sanitisee(s). Le localisateur opaque n'est revele qu'apres MFA AAL2, capacite Risque, confirmation et justification auditee.</p></div></div>
            <div class="partners-ops-list">${rows || '<div class="ssub">Aucun recours KYC.</div>'}</div>`;
    }

    _renderPartnersPayouts(data, batchesData, { failedKey = '' } = {}) {
        const el = document.getElementById('partners-admin-payouts');
        if (!el) return;
        const displayCount = (value) => (
            Number.isSafeInteger(value) && value >= 0
                ? AdminPage.n(value)
                : '—'
        );
        this._partnersManualBatchControls = new Map();
        const cyclesAvailable = this._partnersIsPagedEnvelope(data);
        const batchesAvailable = this._partnersIsPagedEnvelope(batchesData);
        const cyclesInvalid = data != null && !cyclesAvailable;
        const batchesInvalid = batchesData != null && !batchesAvailable;
        const cyclesPending = !cyclesAvailable && !cyclesInvalid
            && failedKey !== 'payoutCycles'
            && this._partnersRequests?.has?.('payoutCycles');
        const batchesPending = !batchesAvailable && !batchesInvalid
            && failedKey !== 'manualBatches'
            && this._partnersRequests?.has?.('manualBatches');
        const cycleRows = (cyclesAvailable ? data.items : []).slice(0, 8).map((item) => {
            const mode = item?.live_execution === true ? 'live' : 'dry-run';
            const key = String(item?.key || '');
            const actions = [];
            if (this._partnersCapabilities.finance === true
                && /^pay_[0-9a-f]{24}$/.test(key)
                && item?.status === 'draft') {
                actions.push(`<button type="button" class="partners-action is-success"
                  data-partners-action="payout-approve"
                  data-partners-key="${AdminPage.esc(key)}">Approuver</button>`);
            }
            if (this._partnersCapabilities.finance === true
                && /^pay_[0-9a-f]{24}$/.test(key)
                && item?.status === 'approved'
                && item?.live_execution === true) {
                actions.push(`<button type="button" class="partners-action is-success"
                  data-partners-action="revolut-batch-prepare"
                  data-partners-key="${AdminPage.esc(key)}">Préparer le lot</button>`);
            }
            return `<div class="partners-ops-row">
                <span>${AdminPage.esc(key || 'Cycle')} · ${AdminPage.esc(String(item?.currency || '—'))} · ${AdminPage.esc(mode)}
                  <small>${displayCount(item?.total_minor)} unités mineures · ${displayCount(item?.item_count)} item(s)</small>
                </span>
                <div class="partners-risk-actions">${actions.join('')
                    || `<span class="partners-state">${AdminPage.esc(String(item?.status || 'unknown'))}</span>`}</div>
            </div>`;
        }).join('');
        const batchLabels = {
            prepared: 'Préparé',
            exported: 'Exporté',
            partially_submitted: 'Saisie partielle dans Revolut',
            submitted: 'Saisi dans Revolut',
            partially_reconciled: 'Rapprochement partiel',
            settled: 'Rapproché',
            exception: 'Exception',
            cancelled: 'Annulé'
        };
        const batchRows = (batchesAvailable ? batchesData.items : []).slice(0, 25).map((item) => {
            const key = String(item?.key || '');
            const cycleKey = String(item?.cycle_key || '');
            const status = String(item?.status || '');
            const currency = String(item?.currency || '');
            const exponent = Number(item?.currency_exponent);
            const validBatch = /^rmb_[0-9a-f]{24}$/.test(key);
            const validCycle = /^pay_[0-9a-f]{24}$/.test(cycleKey);
            const referenceSetHash = String(
                item?.reference_set_hash || ''
            );
            const unmappedReferences = Array.isArray(
                item?.unmapped_references
            ) ? item.unmapped_references.slice(0, 5000) : [];
            const validUnmapped = unmappedReferences.every((row) => (
                /^NORVA-[A-F0-9]{12}$/.test(
                    String(row?.reference || '')
                )
                && Number.isSafeInteger(row?.amount_minor)
                && row.amount_minor > 0
                && /^[A-Z]{3}$/.test(String(row?.currency || ''))
                && Number.isInteger(row?.currency_exponent)
                && row.currency_exponent >= 0
                && row.currency_exponent <= 6
            ));
            const cancellationPending = item?.cancellation?.status
                === 'pending';
            const unmappedPending = Array.isArray(item?.unmapped_requests)
                && item.unmapped_requests.some((request) => (
                    request?.status === 'pending'
                ));
            const sevenDaysElapsed = item?.exported_at
                && Number.isFinite(Date.parse(item.exported_at))
                && Date.now() >= Date.parse(item.exported_at)
                    + 7 * 24 * 60 * 60 * 1000;
            const canRequestCancellation = validBatch
                && /^[0-9a-f]{64}$/.test(referenceSetHash)
                && !item?.cancellation
                && Number(item?.mapped_count) === 0
                && Number(item?.submitted_count) === 0
                && (
                    status === 'prepared'
                    || (status === 'exported' && sevenDaysElapsed)
                );
            const canRequestUnmapped = validBatch
                && status === 'partially_submitted'
                && sevenDaysElapsed
                && !unmappedPending
                && validUnmapped
                && unmappedReferences.length > 0;
            if (canRequestCancellation || canRequestUnmapped) {
                this._partnersManualBatchControls.set(key, {
                    batchKey: key,
                    referenceSetHash,
                    unmappedReferences: unmappedReferences.map(
                        (row) => row.reference
                    )
                });
            }
            const actions = [];
            if (this._partnersCapabilities.finance === true && validBatch
                && !cancellationPending && !unmappedPending
                && ['prepared', 'exported', 'partially_submitted'].includes(status)) {
                const exportLabel = status === 'prepared'
                    ? 'Exporter le lot'
                    : (status === 'partially_submitted'
                        ? 'Télécharger le suivi'
                        : 'Réexporter');
                actions.push(`<button type="button" class="partners-action"
                  data-partners-action="revolut-batch-export"
                  data-partners-key="${AdminPage.esc(key)}"
                  data-partners-status="${AdminPage.esc(status)}">${exportLabel}</button>`);
            }
            if (this._partnersCapabilities.finance === true && validBatch
                && !cancellationPending && !unmappedPending
                && ['exported', 'partially_submitted'].includes(status)) {
                actions.push(`<button type="button" class="partners-action is-success"
                  data-partners-action="revolut-batch-submit"
                  data-partners-key="${AdminPage.esc(key)}">${status === 'partially_submitted'
                    ? 'Enregistrer la progression'
                    : 'Marquer saisi'}</button>`);
            }
            if (this._partnersCapabilities.finance === true
                && canRequestCancellation) {
                actions.push(`<button type="button" class="partners-action is-danger"
                  data-partners-action="revolut-manual-control-request-cancel"
                  data-partners-key="${AdminPage.esc(key)}">Demander l’annulation</button>`);
            }
            if (this._partnersCapabilities.finance === true
                && canRequestUnmapped) {
                actions.push(`<button type="button" class="partners-action is-danger"
                  data-partners-action="revolut-manual-control-request-unmapped"
                  data-partners-key="${AdminPage.esc(key)}">Libérer les non-saisis</button>`);
            }
            if (this._partnersCapabilities.finance === true
                && (cancellationPending || unmappedPending)) {
                actions.push('<span class="partners-state is-alert">Second contrôle Finance requis</span>');
            }
            const statusClass = ['exception', 'cancelled'].includes(status)
                ? ' is-alert'
                : (status === 'settled' ? ' is-on' : '');
            return `<div class="partners-ops-row">
                <span>${AdminPage.esc(validBatch ? key : 'Lot invalide')}
                  <small>${AdminPage.esc(validCycle ? cycleKey : 'cycle indisponible')} · ${this._partnersFormatMinor(item?.total_minor, currency, exponent)} · ${displayCount(item?.submitted_count)}/${displayCount(item?.item_count)} saisi(s) · ${displayCount(item?.settled_count)} rapproché(s)</small>
                </span>
                <div class="partners-risk-actions">${actions.join('')
                    || `<span class="partners-state${statusClass}">${AdminPage.esc(batchLabels[status] || 'État indisponible')}</span>`}</div>
              </div>`;
        }).join('');
        if (cyclesPending || batchesPending) el.setAttribute('aria-busy', 'true');
        else el.removeAttribute('aria-busy');
        el.innerHTML = `<h2>Cycles et lots Revolut manuels</h2>
            <p>Norva génère des références uniques, fige le lot et contrôle sa maturation. La validation et le paiement restent manuels dans Revolut Business Basic ; chaque mutation sensible exige Finance et AAL2 côté serveur.</p>
            <div class="partners-action-row" style="margin-bottom:10px">
              ${cyclesAvailable
                ? (this._partnersCapabilities.finance === true
                    ? '<button type="button" class="partners-action" data-partners-action="payout-create">Créer un cycle contrôlé</button>'
                    : '<span class="partners-state">Lecture seule · capacité Finance requise</span>')
                : `<span class="partners-state">${cyclesPending ? 'Cycles en cours de chargement' : 'Cycles indisponibles'}</span>`}
            </div>
            <div class="partners-control-head">
              <div><strong>Cycles</strong><p>${cyclesAvailable ? `${AdminPage.n(data.total)} cycle(s)` : (cyclesPending ? 'Chargement…' : 'Lecture indisponible')}</p></div>
            </div>
            <div class="partners-ops-list">${cycleRows
                || (cyclesAvailable
                    ? '<div class="ssub">Aucun cycle créé.</div>'
                    : (cyclesPending
                        ? '<div class="ssub" role="status">Chargement des cycles…</div>'
                        : '<div class="admin-err" role="status">Cycles indisponibles. <button type="button" class="partners-action" data-partners-retry="payoutCycles">Réessayer</button></div>'))}</div>
            <div class="partners-control-head" style="margin-top:14px">
              <div><strong>Lots manuels</strong><p>${batchesAvailable ? `${AdminPage.n(batchesData.total)} lot(s)` : (batchesPending ? 'Chargement…' : 'Lecture indisponible')}</p></div>
            </div>
            <div class="partners-ops-list">${batchRows
                || (batchesAvailable
                    ? '<div class="ssub">Aucun lot manuel préparé.</div>'
                    : (batchesPending
                        ? '<div class="ssub" role="status">Chargement des lots manuels…</div>'
                        : '<div class="admin-err" role="status">Lots manuels indisponibles. <button type="button" class="partners-action" data-partners-retry="manualBatches">Réessayer</button></div>'))}</div>`;
    }

    _renderPartnersFiscalProfiles(data) {
        const el = document.getElementById('partners-admin-fiscal-profiles');
        if (!el) return;
        const statuses = new Set(['missing', 'pending', 'verified', 'rejected', 'expired']);
        const exactRowKeys = [
            'country_code', 'partner_key', 'reviewed_at', 'status', 'submitted_at'
        ];
        const validEnvelope = data?.schema_version === 1
            && Number.isSafeInteger(data.total) && data.total >= 0
            && Number.isSafeInteger(data.limit) && data.limit >= 1 && data.limit <= 100
            && Number.isSafeInteger(data.offset) && data.offset >= 0
            && Array.isArray(data.items) && data.items.length <= data.limit;
        if (!validEnvelope) throw new Error('invalid_partners_fiscal_profiles_response');
        const rows = data.items.map((row) => {
            if (!row || typeof row !== 'object' || Array.isArray(row)
                || Object.keys(row).sort().join('|') !== exactRowKeys.join('|')) return null;
            const partnerKey = String(row.partner_key || '');
            const country = String(row.country_code || '');
            const status = String(row.status || '');
            const submittedAt = row.submitted_at === null
                ? null : String(row.submitted_at || '');
            const reviewedAt = row.reviewed_at === null
                ? null : String(row.reviewed_at || '');
            if (!/^prt_[0-9a-f]{24}$/.test(partnerKey)
                || !/^[A-Z]{2}$/.test(country)
                || !statuses.has(status)
                || (submittedAt !== null && !Number.isFinite(Date.parse(submittedAt)))
                || (reviewedAt !== null && !Number.isFinite(Date.parse(reviewedAt)))
                || (status === 'pending' && (submittedAt === null || reviewedAt !== null))
                || (status === 'verified' && (submittedAt === null || reviewedAt === null))) {
                return null;
            }
            return { partnerKey, country, status, submittedAt, reviewedAt };
        }).filter(Boolean);
        if (rows.length !== data.items.length) {
            throw new Error('invalid_partners_fiscal_profiles_items');
        }
        if (!rows.length && data.total > 0 && this._partnersFiscalOffset > 0) {
            this._partnersFiscalOffset = Math.max(
                0,
                this._partnersFiscalOffset - this._partnersFiscalLimit
            );
            void this._partnersLoadFiscalProfiles({ force: true });
            return;
        }
        const labels = {
            missing: 'À renouveler',
            pending: 'À examiner',
            verified: 'Validée',
            rejected: 'Rejetée',
            expired: 'Expirée'
        };
        const canReview = this._partnersCanUseOperationalAction('fiscal-review-public');
        const cards = rows.map((row) => {
            const actions = canReview && row.status === 'pending'
                ? `<div class="partners-action-row">
                    <button type="button" class="partners-action is-success"
                      data-partners-action="fiscal-review-public"
                      data-partners-partner-key="${AdminPage.esc(row.partnerKey)}"
                      data-partners-country="${AdminPage.esc(row.country)}"
                      data-partners-status="verified">Valider</button>
                    <button type="button" class="partners-action is-danger"
                      data-partners-action="fiscal-review-public"
                      data-partners-partner-key="${AdminPage.esc(row.partnerKey)}"
                      data-partners-country="${AdminPage.esc(row.country)}"
                      data-partners-status="rejected">Rejeter</button>
                    <button type="button" class="partners-action"
                      data-partners-onboarding-open-partner="${AdminPage.esc(row.partnerKey)}">Ouvrir la fiche</button>
                  </div>`
                : '<span class="partners-state">Aucune action en attente</span>';
            return `<article class="partners-control-item"
                data-partners-fiscal-partner-key="${AdminPage.esc(row.partnerKey)}">
                <div class="partners-access-request-main">
                  <strong>${AdminPage.esc(row.partnerKey)}</strong>
                  <span class="pill${row.status === 'pending' ? ' is-alert' : ''}">${AdminPage.esc(labels[row.status])}</span>
                </div>
                <p class="partners-access-request-copy">${AdminPage.esc(row.country)}${row.submittedAt ? ` · soumise ${AdminPage.esc(AdminPage.timeAgo(row.submittedAt))}` : ''}${row.reviewedAt ? ` · revue ${AdminPage.esc(AdminPage.timeAgo(row.reviewedAt))}` : ''}</p>
                ${actions}
              </article>`;
        }).join('');
        const first = data.total ? data.offset + 1 : 0;
        const last = Math.min(data.total, data.offset + rows.length);
        const hasPrevious = data.offset > 0;
        const hasNext = data.offset + rows.length < data.total;
        el.removeAttribute('aria-busy');
        el.innerHTML = `<div class="partners-control-head"><div>
              <h2>Résidences fiscales à examiner</h2>
              <p>File minimale Support + Finance · actions AAL2 · aucune donnée fiscale brute.</p>
            </div><span class="pill">${AdminPage.n(data.total)}</span></div>
            <div class="partners-admin-toolbar" role="search" aria-label="Filtrer les résidences fiscales">
              <input id="partners-fiscal-search" type="search" maxlength="64"
                value="${AdminPage.esc(this._partnersFiscalSearch)}"
                placeholder="Clé partenaire ou pays" aria-label="Rechercher une clé partenaire ou un pays"
                autocapitalize="none" autocomplete="off" spellcheck="false">
              <select id="partners-fiscal-status" aria-label="Filtrer les résidences fiscales par statut">
                ${[
                    ['pending', 'À examiner'],
                    ['verified', 'Validées'],
                    ['rejected', 'Rejetées'],
                    ['expired', 'Expirées'],
                    ['all', 'Tous les statuts']
                ].map(([value, label]) => `<option value="${value}"${this._partnersFiscalStatus === value ? ' selected' : ''}>${label}</option>`).join('')}
              </select>
            </div>
            <div class="partners-ops-list">${cards || '<div class="partners-empty-state"><strong>Aucune attestation</strong><span>Aucune résidence fiscale ne correspond à ce filtre.</span></div>'}</div>
            <p class="ssub">Cette file contient uniquement une clé partenaire opaque, un pays et des timestamps de revue.</p>
            <nav class="partners-pagination" aria-label="Pagination des résidences fiscales">
              <span class="partners-pagination-status" role="status" aria-live="polite" aria-atomic="true">${AdminPage.n(first)}–${AdminPage.n(last)} sur ${AdminPage.n(data.total)}</span>
              <button type="button" class="partners-page-btn" data-partners-fiscal-page="prev"
                aria-label="Page précédente des résidences fiscales"${hasPrevious ? '' : ' disabled'}>Précédente</button>
              <button type="button" class="partners-page-btn" data-partners-fiscal-page="next"
                aria-label="Page suivante des résidences fiscales"${hasNext ? '' : ' disabled'}>Suivante</button>
            </nav>`;
    }

    _renderPartnersPayoutOnboardingRequests(data) {
        const el = document.getElementById('partners-admin-payout-onboarding');
        if (!el) return;
        const statuses = new Set(['pending', 'in_progress', 'rejected', 'completed']);
        const reasonCodes = new Set([
            'route_unavailable',
            'beneficiary_setup_required',
            'identity_mismatch',
            'unsupported_destination',
            'compliance_review',
            'duplicate_request'
        ]);
        const validEnvelope = data?.schema_version === 1
            && Number.isSafeInteger(data.total) && data.total >= 0
            && Number.isSafeInteger(data.limit) && data.limit >= 1 && data.limit <= 100
            && Number.isSafeInteger(data.offset) && data.offset >= 0
            && Array.isArray(data.items) && data.items.length <= data.limit;
        if (!validEnvelope) throw new Error('invalid_partners_payout_onboarding_response');
        const rows = data.items.map((row) => {
            const requestKey = String(row?.request_key || '');
            const partnerKey = String(row?.partner_key || '');
            const country = String(row?.country_code || '');
            const currency = String(row?.currency || '');
            const status = String(row?.status || '');
            const revision = Number(row?.revision);
            const executionAdapter = String(row?.execution_adapter || '');
            const requestedAt = String(row?.requested_at || '');
            const updatedAt = String(row?.updated_at || '');
            const startedAt = row?.started_at === null ? null : String(row?.started_at || '');
            const rejectedAt = row?.rejected_at === null ? null : String(row?.rejected_at || '');
            const completedAt = row?.completed_at === null ? null : String(row?.completed_at || '');
            const reasonCode = row?.reason_code === null
                ? null : String(row?.reason_code || '');
            if (!/^por_[0-9a-f]{24}$/.test(requestKey)
                || !/^prt_[0-9a-f]{24}$/.test(partnerKey)
                || !/^[A-Z]{2}$/.test(country)
                || !/^[A-Z]{3}$/.test(currency)
                || !statuses.has(status)
                || !Number.isSafeInteger(revision) || revision < 1
                || executionAdapter !== 'revolut_manual'
                || !Number.isFinite(Date.parse(requestedAt))
                || !Number.isFinite(Date.parse(updatedAt))
                || (startedAt !== null && !Number.isFinite(Date.parse(startedAt)))
                || (rejectedAt !== null && !Number.isFinite(Date.parse(rejectedAt)))
                || (completedAt !== null && !Number.isFinite(Date.parse(completedAt)))
                || typeof row?.binding_ready !== 'boolean'
                || typeof row?.profile_ready !== 'boolean'
                || typeof row?.reconfiguration_required !== 'boolean'
                || (reasonCode !== null && !reasonCodes.has(reasonCode))
                || ((status === 'rejected') !== (reasonCode !== null))
                || (status === 'pending' && (
                    startedAt !== null || rejectedAt !== null || completedAt !== null
                ))
                || (status === 'in_progress' && (
                    startedAt === null || rejectedAt !== null || completedAt !== null
                ))
                || (status === 'rejected' && (
                    rejectedAt === null || completedAt !== null
                ))
                || (status === 'completed' && (
                    completedAt === null
                ))
                || (row.reconfiguration_required && status !== 'completed')
                || (status === 'completed'
                    && (!row.binding_ready || !row.profile_ready)
                    && !row.reconfiguration_required)) return null;
            return {
                requestKey,
                partnerKey,
                country,
                currency,
                status,
                revision,
                executionAdapter,
                requestedAt,
                updatedAt,
                startedAt,
                rejectedAt,
                completedAt,
                reasonCode,
                bindingReady: row.binding_ready,
                profileReady: row.profile_ready,
                reconfigurationRequired: row.reconfiguration_required
            };
        }).filter(Boolean);
        if (rows.length !== data.items.length) {
            throw new Error('invalid_partners_payout_onboarding_items');
        }
        if (!rows.length && data.total > 0 && this._partnersPayoutOnboardingOffset > 0) {
            this._partnersPayoutOnboardingOffset = Math.max(
                0,
                this._partnersPayoutOnboardingOffset - this._partnersPayoutOnboardingLimit
            );
            void this._partnersLoadPayoutOnboardingRequests({ force: true });
            return;
        }
        const labels = {
            pending: 'À examiner',
            in_progress: 'Configuration en cours',
            rejected: 'Rejetée',
            completed: 'Configurée'
        };
        const reasons = {
            route_unavailable: 'Corridor non disponible',
            beneficiary_setup_required: 'Bénéficiaire à configurer',
            identity_mismatch: 'Identité non concordante',
            unsupported_destination: 'Destination non prise en charge',
            compliance_review: 'Revue de conformité requise',
            duplicate_request: 'Demande déjà couverte'
        };
        const cards = rows.map((row) => {
            const completionHintId = `partners-onboarding-completion-${row.requestKey}`;
            const canComplete = row.status === 'in_progress'
                && row.bindingReady && row.profileReady;
            const canContact = this._partnersHasCapabilities('support', 'finance');
            const actions = this._partnersCapabilities.finance === true
                ? `<div class="partners-action-row">
                    ${row.status === 'pending' ? `<button type="button" class="partners-action is-success"
                      data-partners-action="payout-onboarding-decide"
                      data-partners-request-key="${AdminPage.esc(row.requestKey)}"
                      data-partners-decision="start">Commencer</button>` : ''}
                    ${['pending', 'in_progress'].includes(row.status) ? `<button type="button" class="partners-action is-danger"
                      data-partners-action="payout-onboarding-decide"
                      data-partners-request-key="${AdminPage.esc(row.requestKey)}"
                      data-partners-decision="reject">Rejeter</button>` : ''}
                    ${row.status === 'in_progress' ? `<button type="button" class="partners-action is-success"
                      data-partners-action="payout-onboarding-decide"
                      data-partners-request-key="${AdminPage.esc(row.requestKey)}"
                      data-partners-decision="complete"
                      data-partners-binding-ready="${row.bindingReady ? 'true' : 'false'}"
                      data-partners-profile-ready="${row.profileReady ? 'true' : 'false'}"
                      aria-describedby="${AdminPage.esc(completionHintId)}"${canComplete ? '' : ' disabled'}>Finaliser</button>` : ''}
                    ${row.status === 'in_progress' && canContact ? `<button type="button" class="partners-action"
                      data-partners-action="payout-onboarding-contact"
                      data-partners-request-key="${AdminPage.esc(row.requestKey)}">Contacter via le compte Norva</button>` : ''}
                    ${row.status === 'in_progress' && !row.bindingReady ? `<button type="button" class="partners-action"
                      data-partners-action="revolut-binding-propose-request"
                      data-partners-request-key="${AdminPage.esc(row.requestKey)}">Proposer le bénéficiaire</button>` : ''}
                    <button type="button" class="partners-action"
                      data-partners-onboarding-open-partner="${AdminPage.esc(row.partnerKey)}">Ouvrir la fiche</button>
                  </div>`
                : '<span class="partners-state">Capacité Finance requise</span>';
            return `<article class="partners-control-item partners-onboarding-item"
                data-partners-onboarding-request-key="${AdminPage.esc(row.requestKey)}">
                <div class="partners-access-request-main">
                  <strong>${AdminPage.esc(row.partnerKey)}</strong>
                  <span class="pill${row.reconfigurationRequired ? ' is-alert' : ''}">${AdminPage.esc(row.reconfigurationRequired ? 'Reconfiguration requise' : labels[row.status])}</span>
                </div>
                <p class="partners-access-request-copy">${AdminPage.esc(row.country)} · ${AdminPage.esc(row.currency)} · révision ${AdminPage.n(row.revision)} · demande ${AdminPage.esc(AdminPage.timeAgo(row.requestedAt))} · mise à jour ${AdminPage.esc(AdminPage.timeAgo(row.updatedAt))}</p>
                <p class="partners-access-request-copy">Binding ${row.bindingReady ? 'prêt' : 'en attente'} · profil ${row.profileReady ? 'prêt' : 'en attente'}${row.completedAt ? ` · finalisé ${AdminPage.esc(AdminPage.timeAgo(row.completedAt))}` : ''}</p>
                ${row.reconfigurationRequired ? '<p class="partners-access-request-copy" role="status">La configuration finalisée ne satisfait plus tous les contrôles actuels (policy, fiscalité, corridor ou destination). Une nouvelle demande sera proposée à l’utilisateur dès que son éligibilité le permet.</p>' : ''}
                ${row.status === 'in_progress' ? `<p class="partners-access-request-copy" id="${AdminPage.esc(completionHintId)}">${canComplete
                    ? 'Le binding actif et le profil vérifié permettent la finalisation contrôlée.'
                    : 'Finalisation verrouillée : un binding actif et un profil vérifié sont requis côté serveur.'}</p>` : ''}
                ${row.reasonCode ? `<p class="partners-access-request-copy">Motif sanitisé : ${AdminPage.esc(reasons[row.reasonCode] || 'Action Finance requise')}</p>` : ''}
                ${actions}
              </article>`;
        }).join('');
        const first = data.total ? data.offset + 1 : 0;
        const last = Math.min(data.total, data.offset + rows.length);
        const hasPrevious = data.offset > 0;
        const hasNext = data.offset + rows.length < data.total;
        el.removeAttribute('aria-busy');
        el.innerHTML = `<div class="partners-control-head"><div>
              <h2>Demandes de configuration de versement</h2>
              <p>Revolut Business Basic · file sanitisée · actions Finance protégées par AAL2.</p>
            </div><span class="pill">${AdminPage.n(data.total)}</span></div>
            <div class="partners-admin-toolbar" role="search" aria-label="Filtrer les demandes de versement">
              <input id="partners-payout-onboarding-search" type="search" maxlength="64"
                value="${AdminPage.esc(this._partnersPayoutOnboardingSearch)}"
                placeholder="Clé partenaire" aria-label="Rechercher une clé partenaire"
                autocapitalize="none" autocomplete="off" spellcheck="false">
              <select id="partners-payout-onboarding-status" aria-label="Filtrer les demandes par statut">
                ${[
                    ['pending', 'À examiner'],
                    ['in_progress', 'En cours'],
                    ['rejected', 'Rejetées'],
                    ['completed', 'Configurées'],
                    ['all', 'Tous les statuts']
                ].map(([value, label]) => `<option value="${value}"${this._partnersPayoutOnboardingStatus === value ? ' selected' : ''}>${label}</option>`).join('')}
              </select>
            </div>
            <div class="partners-ops-list">${cards || '<div class="partners-empty-state"><strong>Aucune demande</strong><span>Aucune demande de configuration ne correspond à ce filtre.</span></div>'}</div>
            <p class="ssub">La finalisation est dérivée du binding Revolut actif côté serveur. Cette file ne contient aucune donnée bancaire, fiscale ou bénéficiaire.</p>
            <nav class="partners-pagination" aria-label="Pagination des demandes de versement">
              <span class="partners-pagination-status" role="status" aria-live="polite" aria-atomic="true">${AdminPage.n(first)}–${AdminPage.n(last)} sur ${AdminPage.n(data.total)}</span>
              <button type="button" class="partners-page-btn" data-partners-payout-onboarding-page="prev"
                aria-label="Page précédente des demandes de versement"${hasPrevious ? '' : ' disabled'}>Précédente</button>
              <button type="button" class="partners-page-btn" data-partners-payout-onboarding-page="next"
                aria-label="Page suivante des demandes de versement"${hasNext ? '' : ' disabled'}>Suivante</button>
            </nav>`;
    }

    _renderPartnersAccessRequests(data) {
        const el = document.getElementById('partners-admin-access-requests');
        const count = document.getElementById('partners-access-request-count');
        if (!el) return;
        const statuses = new Set(['requested', 'approved', 'declined']);
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        const cleanRows = data.items.map((row) => {
            const requestId = String(row?.request_id || '');
            const subjectKey = String(row?.subject_key || '');
            const emailMasked = row?.email_masked === null ? null : String(row?.email_masked || '');
            const status = String(row?.status || '');
            const country = String(row?.country_code || '');
            const subdivision = row?.subdivision_code === null ? null : String(row?.subdivision_code || '');
            const requestedAt = String(row?.requested_at || '');
            const reviewedAt = row?.reviewed_at === null ? null : String(row?.reviewed_at || '');
            if (!uuid.test(requestId)
                || !/^[0-9a-f]{12}$/.test(subjectKey)
                || !statuses.has(status)
                || !/^[A-Z]{2}$/.test(country)
                || (subdivision !== null && (subdivision.length > 12
                    || !/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(subdivision)))
                || !Number.isFinite(Date.parse(requestedAt))
                || (reviewedAt !== null && !Number.isFinite(Date.parse(reviewedAt)))
                || (emailMasked !== null && (emailMasked.length < 3 || emailMasked.length > 254))) {
                return null;
            }
            return {
                requestId,
                subjectKey,
                emailMasked,
                status,
                country,
                subdivision,
                requestedAt,
                reviewedAt
            };
        }).filter(Boolean);
        if (cleanRows.length !== data.items.length) {
            throw new Error('invalid_partners_access_request_items');
        }

        el.removeAttribute('aria-busy');
        if (count) count.textContent = `${AdminPage.n(data.total)} demande${data.total === 1 ? '' : 's'}`;
        if (!cleanRows.length) {
            if (data.total > 0 && this._partnersAccessRequestPage > 0) {
                this._partnersAccessRequestPage -= 1;
                void this._partnersLoadAccessRequests({ force: true });
                return;
            }
            el.innerHTML = '<div class="partners-empty-state"><strong>Aucune demande</strong><span>Aucune demande ne correspond à ce filtre.</span></div>';
            return;
        }

        const statusLabels = {
            requested: 'À examiner',
            approved: 'Approuvée',
            declined: 'Refusée'
        };
        const rows = cleanRows.map((row) => {
            const jurisdiction = row.subdivision
                ? `${row.country} · ${row.subdivision}` : row.country;
            const reviewed = row.reviewedAt
                ? ` · décision ${AdminPage.timeAgo(row.reviewedAt)}` : '';
            const actions = row.status === 'requested' && this._partnersCapabilities.risk === true
                ? `<div class="partners-action-row">
                    <button type="button" class="partners-action is-success"
                      data-partners-action="access-request-approve"
                      data-partners-request-id="${AdminPage.esc(row.requestId)}"
                      data-partners-request-key="${AdminPage.esc(row.subjectKey)}">Approuver</button>
                    <button type="button" class="partners-action is-danger"
                      data-partners-action="access-request-decline"
                      data-partners-request-id="${AdminPage.esc(row.requestId)}"
                      data-partners-request-key="${AdminPage.esc(row.subjectKey)}">Refuser</button>
                  </div>`
                : '';
            return `<article class="partners-control-item partners-access-request-item">
                <div class="partners-access-request-main">
                  <strong>Demande ${AdminPage.esc(row.subjectKey)}</strong>
                  <span class="pill">${AdminPage.esc(statusLabels[row.status])}</span>
                </div>
                <p class="partners-access-request-copy">${AdminPage.esc(row.emailMasked || 'Email masqué indisponible')} · ${AdminPage.esc(jurisdiction)} · ${AdminPage.esc(AdminPage.timeAgo(row.requestedAt))}${AdminPage.esc(reviewed)}</p>
                ${actions}
              </article>`;
        }).join('');
        const pageCount = Math.max(1, Math.ceil(data.total / this._partnersAccessRequestLimit));
        this._partnersAccessRequestPage = Math.min(
            Math.max(0, this._partnersAccessRequestPage),
            pageCount - 1
        );
        const first = data.total ? this._partnersAccessRequestPage * this._partnersAccessRequestLimit + 1 : 0;
        const last = Math.min(data.total, first + cleanRows.length - 1);
        el.innerHTML = `<div class="partners-ops-list">${rows}</div>
          <nav class="partners-pagination" aria-label="Pagination des demandes d’accès">
            <span class="partners-pagination-status" role="status" aria-live="polite" aria-atomic="true">${AdminPage.n(first)}–${AdminPage.n(last)} sur ${AdminPage.n(data.total)}</span>
            <button type="button" class="partners-page-btn" data-partners-access-request-page="prev"
              aria-label="Page précédente des demandes"${this._partnersAccessRequestPage === 0 ? ' disabled' : ''}>Précédente</button>
            <button type="button" class="partners-page-btn" data-partners-access-request-page="next"
              aria-label="Page suivante des demandes"${this._partnersAccessRequestPage >= pageCount - 1 ? ' disabled' : ''}>Suivante</button>
          </nav>`;
    }

    _renderPartnersAdminAccounts(rows, total) {
        const el = document.getElementById('partners-admin-list');
        const preview = document.getElementById('partners-admin-list-preview');
        const count = document.getElementById('partners-admin-count');
        if (!el && !preview) return;
        if (count) count.textContent = `${AdminPage.n(total)} compte${total === 1 ? '' : 's'}`;
        if (el) el.removeAttribute('aria-busy');
        if (preview) preview.removeAttribute('aria-busy');
        if (!rows.length) {
            if (el) el.innerHTML = '<div class="partners-empty-state"><strong>Aucun partenaire</strong><span>Aucun compte ne correspond à ce filtre.</span></div>';
            if (preview) preview.innerHTML = '<div class="partners-empty-state"><strong>Aucun partenaire</strong><span>Les premiers comptes apparaîtront ici.</span></div>';
            return;
        }
        const labels = {
            active: 'Actif', pending_verification: 'Vérification en attente', held: 'En revue',
            suspended: 'Suspendu', closed: 'Clôturé', verified: 'Vérifiée', pending: 'En attente',
            invited: 'Invité', not_started: 'Non commencée', accepted: 'Accepté', rejected: 'Rejeté',
            current: 'À jour', none: 'Aucun', expired: 'Expiré', revoked: 'Révoqué', unknown: 'Inconnu'
        };
        const valueLabel = (value) => labels[String(value || 'unknown')] || 'Inconnu';
        const cleanRows = rows.map((row) => {
            const id = String(row.account_id || '');
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;
            const ref = String(row.partner_key || 'Partenaire');
            const accountStatus = valueLabel(row.status);
            const verification = valueLabel(row.verification_status);
            const contract = valueLabel(row.contract_status);
            const link = valueLabel(row.link_status || 'none');
            const created = row.created_at ? AdminPage.timeAgo(row.created_at) : '—';
            return { id, ref, accountStatus, verification, contract, link, created };
        }).filter(Boolean);
        if (cleanRows.length !== rows.length) throw new Error('invalid_partners_accounts_items');
        const tableRows = cleanRows.map((row) => `<tr class="partner-row" data-partner-id="${AdminPage.esc(row.id)}">
            <td><button type="button" class="partner-open" data-partner-id="${AdminPage.esc(row.id)}"
              aria-label="Ouvrir ${AdminPage.esc(row.ref)}, compte ${AdminPage.esc(row.accountStatus)}, identité ${AdminPage.esc(row.verification)}">${AdminPage.esc(row.ref)}</button></td>
            <td class="partner-meta">${AdminPage.esc(row.accountStatus)}</td>
            <td class="partner-meta">${AdminPage.esc(row.verification)}</td>
            <td class="partner-meta">${AdminPage.esc(row.contract)}</td>
            <td class="partner-meta">${AdminPage.esc(row.link)}</td>
            <td class="partner-meta">${AdminPage.esc(row.created)}</td>
          </tr>`).join('');
        const cards = cleanRows.map((row) => `<li><article class="partners-account-card">
            <header><h3>${AdminPage.esc(row.ref)}</h3><button type="button" class="partner-open"
              data-partner-id="${AdminPage.esc(row.id)}" aria-label="Ouvrir la fiche ${AdminPage.esc(row.ref)}">Ouvrir</button></header>
            <dl class="partners-account-facts">
              <div><dt>Compte</dt><dd>${AdminPage.esc(row.accountStatus)}</dd></div>
              <div><dt>Identité</dt><dd>${AdminPage.esc(row.verification)}</dd></div>
              <div><dt>Contrat</dt><dd>${AdminPage.esc(row.contract)}</dd></div>
              <div><dt>Lien</dt><dd>${AdminPage.esc(row.link)}</dd></div>
              <div><dt>Créé</dt><dd>${AdminPage.esc(row.created)}</dd></div>
            </dl>
          </article></li>`).join('');
        const pageCount = Math.max(1, Math.ceil(total / this._partnersLimit));
        this._partnersPage = Math.min(Math.max(0, this._partnersPage), pageCount - 1);
        const first = total ? this._partnersPage * this._partnersLimit + 1 : 0;
        const last = Math.min(total, first + cleanRows.length - 1);
        if (el) el.innerHTML = `<div id="partners-account-table-wrap" class="partners-table-wrap">
            <table class="partners-table"><caption>Comptes partenaires correspondant aux filtres</caption>
              <thead><tr><th scope="col">Partenaire</th><th scope="col">Compte</th><th scope="col">Identité</th><th scope="col">Contrat</th><th scope="col">Lien</th><th scope="col">Créé</th></tr></thead>
              <tbody>${tableRows}</tbody>
            </table>
          </div>
          <ul id="partners-account-cards" class="partners-account-cards" role="list">${cards}</ul>
          <nav class="partners-pagination" aria-label="Pagination des partenaires">
            <span class="partners-pagination-status" role="status" aria-live="polite" aria-atomic="true">${AdminPage.n(first)}–${AdminPage.n(last)} sur ${AdminPage.n(total)}</span>
            <button type="button" class="partners-page-btn" data-partners-account-page="prev" aria-controls="partners-account-table-wrap partners-account-cards" aria-label="Page précédente des partenaires"${this._partnersPage === 0 ? ' disabled' : ''}>Précédente</button>
            <button type="button" class="partners-page-btn" data-partners-account-page="next" aria-controls="partners-account-table-wrap partners-account-cards" aria-label="Page suivante des partenaires"${this._partnersPage >= pageCount - 1 ? ' disabled' : ''}>Suivante</button>
          </nav>`;
        if (preview) preview.innerHTML = cleanRows.slice(0, 6).map((row) => `<button type="button" class="partners-overview-item"
            data-partner-id="${AdminPage.esc(row.id)}" aria-label="Ouvrir la fiche ${AdminPage.esc(row.ref)}">
            <span>${AdminPage.esc(row.ref)}</span><small>${AdminPage.esc(row.accountStatus)} · ${AdminPage.esc(row.verification)}</small>
          </button>`).join('');
    }

    async _pagePartnerDetail(accountId) {
        const view = document.getElementById('crm-view');
        if (!view || !/^[0-9a-f-]{36}$/i.test(String(accountId || ''))) {
            this._navigate('partners');
            return;
        }
        const nav = this._nav;
        this._setCrumb('Partners · fiche individuelle');
        view.innerHTML = `<div class="crm-page">
            <button class="crm-back" type="button">← ${AdminPage.esc(AdminPage.routeLabel(this._ficheReturn || 'partners'))}</button>
            <h1 class="crm-h1">Fiche partenaire</h1>
            <p class="crm-sub">Chargement de la vue sanitisée…</p>
            <div id="partners-admin-detail" class="card" aria-busy="true"><div class="ssub">Chargement…</div></div>
        </div>`;
        try {
            const results = await Promise.allSettled([
                this._rpc('admin_partners_detail', { p_account_id: accountId }),
                this._rpc('admin_partners_capabilities')
            ]);
            if (nav !== this._nav || !this._route.startsWith('partner:')) return;
            if (results[0]?.status !== 'fulfilled') throw new Error('partner_detail_unavailable');
            if (results[1]?.status === 'fulfilled') {
                this._partnersApplyCapabilities(results[1].value);
            } else {
                // A direct/deep link must fail closed instead of inheriting a
                // capability snapshot left by a previous Partners view.
                this._partnersCanManageCapabilities = false;
                this._partnersCanManageRelease = false;
                this._partnersCapabilities = { support: false, risk: false, finance: false };
            }
            const raw = results[0].value;
            const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
            let revolut = null;
            if (this._partnersCapabilities.finance === true) {
                const profile = await Promise.allSettled([
                    this._rpc('admin_partners_revolut_profile_status', {
                        p_account_id: accountId
                    })
                ]);
                if (nav !== this._nav || !this._route.startsWith('partner:')) return;
                revolut = profile[0]?.status === 'fulfilled' ? profile[0].value : null;
            }
            this._renderPartnerDetail(data, revolut);
        } catch (_) {
            if (nav !== this._nav || !this._route.startsWith('partner:')) return;
            const el = document.getElementById('partners-admin-detail');
            if (el) el.innerHTML = '<div class="admin-err" role="alert">Cette fiche partenaire n’est pas disponible. Aucune donnée brute n’a été affichée.</div>';
        }
    }

    async _pagePartnerDetailByPublicId(accountPublicId) {
        const view = document.getElementById('crm-view');
        const partnerKey = String(accountPublicId || '').toLowerCase();
        if (!view || !/^prt_[0-9a-f]{24}$/.test(partnerKey)) {
            this._navigate('partners');
            return;
        }
        const route = `partner-public:${partnerKey}`;
        const nav = this._nav;
        this._setCrumb('Partners · fiche Finance');
        view.innerHTML = `<div class="crm-page">
            <button class="crm-back" type="button">← ${AdminPage.esc(AdminPage.routeLabel(this._ficheReturn || 'partners'))}</button>
            <h1 class="crm-h1">Fiche partenaire</h1>
            <p class="crm-sub">Vue sanitisée ouverte depuis la file Finance. Aucun identifiant interne n’est exposé.</p>
            <div id="partners-admin-detail" class="card" aria-busy="true"><div class="ssub">Chargement sécurisé…</div></div>
        </div>`;
        try {
            const capabilities = await this._rpc('admin_partners_capabilities');
            if (nav !== this._nav || this._route !== route) return;
            this._partnersApplyCapabilities(capabilities);
            if (this._partnersCapabilities.finance !== true) {
                throw new Error('partners_finance_capability_required');
            }
            if (!(await this._partnersEnsureAal2())) {
                if (nav !== this._nav || this._route !== route) return;
                const target = document.getElementById('partners-admin-detail');
                if (target) {
                    target.removeAttribute('aria-busy');
                    target.innerHTML = '<div class="admin-err" role="status">La fiche Finance reste verrouillée. Validez cette session avec Authenticator puis réessayez.</div>';
                }
                return;
            }
            const data = await this._rpc('admin_partners_detail_by_public_id', {
                p_account_public_id: partnerKey
            });
            if (nav !== this._nav || this._route !== route) return;
            if (data?.schema_version !== 1
                || data?.account?.account_public_id !== partnerKey
                || data?.account?.partner_key !== partnerKey) {
                throw new Error('invalid_partner_public_detail_response');
            }
            this._renderPartnerDetail(data, null);
        } catch (_) {
            if (nav !== this._nav || this._route !== route) return;
            const target = document.getElementById('partners-admin-detail');
            if (target) {
                target.removeAttribute('aria-busy');
                target.innerHTML = '<div class="admin-err" role="alert">Cette fiche Finance n’est pas disponible. Aucune donnée brute n’a été affichée.</div>';
            }
        }
    }

    _renderPartnerDetail(data, revolutEnvelope = null) {
        const el = document.getElementById('partners-admin-detail');
        if (!el) return;
        const account = data.account && typeof data.account === 'object' ? data.account : {};
        const policy = data.policy && typeof data.policy === 'object' ? data.policy : {};
        const link = data.link && typeof data.link === 'object' ? data.link : {};
        const fiscal = data.fiscal && typeof data.fiscal === 'object' ? data.fiscal : {};
        const events = Array.isArray(data.activity) ? data.activity.slice(0, 100) : [];
        const canManagePayout = this._partnersCapabilities.finance === true
            && /^[0-9a-f-]{36}$/i.test(String(account.account_id || ''));
        const payoutProfiles = revolutEnvelope?.schema_version === 1
            && Array.isArray(revolutEnvelope.profiles)
            ? revolutEnvelope.profiles.slice(0, 32)
            : [];
        const beneficiaryBindings = revolutEnvelope?.schema_version === 1
            && Array.isArray(revolutEnvelope.bindings)
            ? revolutEnvelope.bindings.slice(0, 64)
            : [];
        const fact = (label, value) => `<div><dt>${AdminPage.esc(label)}</dt><dd>${AdminPage.esc(value == null || value === '' ? '—' : value)}</dd></div>`;
        const payoutRows = payoutProfiles.map((profile) => {
            const currency = /^[A-Z]{3}$/.test(String(profile?.currency || ''))
                ? profile.currency : '—';
            const status = String(profile?.status || 'unknown');
            const destination = String(profile?.display_masked || 'Destination masquée indisponible');
            const paymentMethod = profile?.payment_method_configured === true
                ? 'Moyen de paiement API configuré'
                : 'Mode manuel uniquement';
            const binding = profile?.binding_verified === true
                && Number.isSafeInteger(Number(profile?.binding_version))
                ? `Binding vérifié · version ${AdminPage.n(Number(profile.binding_version))}`
                : 'Binding à vérifier';
            return `<div class="partners-event">
                <strong>${AdminPage.esc(currency)} · ${AdminPage.esc(status)}</strong>
                <span>${AdminPage.esc(destination)}</span>
                <span>${AdminPage.esc(paymentMethod)} · ${AdminPage.esc(binding)}</span>
            </div>`;
        }).join('');
        const bindingRows = beneficiaryBindings.map((binding) => {
            const key = String(binding?.key || '');
            const currency = String(binding?.currency || '');
            const status = String(binding?.status || 'unknown');
            const masked = String(
                binding?.display_masked || 'Destination masquée indisponible'
            );
            const validKey = /^rbb_[0-9a-f]{24}$/.test(key);
            const validCurrency = /^[A-Z]{3}$/.test(currency);
            const version = Number(binding?.version);
            const keyVersion = Number(binding?.fingerprint_key_version);
            const revocation = binding?.revocation
                && typeof binding.revocation === 'object'
                ? binding.revocation
                : null;
            const revocationKey = String(revocation?.key || '');
            let bindingActions = '';
            if (validKey && status === 'pending') {
                bindingActions = `<div class="partners-risk-actions">
                    <button type="button" class="partners-action is-success"
                      data-partners-action="revolut-binding-verify"
                      data-partners-binding="${AdminPage.esc(key)}">Vérifier</button>
                    <button type="button" class="partners-action is-danger"
                      data-partners-action="revolut-binding-reject"
                      data-partners-binding="${AdminPage.esc(key)}">Rejeter</button>
                  </div>`;
            } else if (validKey && status === 'active'
                && /^rbr_[0-9a-f]{24}$/.test(revocationKey)
                && revocation?.status === 'pending') {
                bindingActions = `<button type="button" class="partners-action is-danger"
                    data-partners-action="revolut-binding-revoke-confirm"
                    data-partners-binding="${AdminPage.esc(key)}"
                    data-partners-revocation="${AdminPage.esc(revocationKey)}">
                    Confirmer la révocation
                  </button>`;
            } else if (validKey && status === 'active' && !revocation) {
                bindingActions = `<button type="button" class="partners-action is-danger"
                    data-partners-action="revolut-binding-revoke-request"
                    data-partners-binding="${AdminPage.esc(key)}">
                    Demander la révocation
                  </button>`;
            } else {
                bindingActions = `<span class="partners-state${status === 'active' ? ' is-on' : status === 'rejected' || status === 'revoked' ? ' is-alert' : ''}">${AdminPage.esc(status)}</span>`;
            }
            return `<div class="partners-ops-row">
                <span>${AdminPage.esc(validCurrency ? currency : 'Devise inconnue')}
                  · binding ${AdminPage.esc(validKey ? key : 'invalide')}
                  <small>version ${Number.isSafeInteger(version) && version > 0 ? AdminPage.n(version) : '—'}
                    · clé HMAC ${Number.isSafeInteger(keyVersion) && keyVersion > 0 ? AdminPage.n(keyVersion) : '—'}
                    · ${AdminPage.esc(masked)}
                    · ${binding?.payment_method_configured === true ? 'API prête' : 'manuel Basic'}</small>
                </span>
                <div class="partners-risk-actions">${bindingActions}</div>
              </div>`;
        }).join('');
        const eventRows = events.map((event) => `<div class="partners-event">
            <strong>${AdminPage.esc(event.action || 'Événement')}</strong>
            <span>${AdminPage.esc(event.actor_type || 'Transition serveur auditée')}</span>
            <span>${event.occurred_at ? AdminPage.esc(AdminPage.timeAgo(event.occurred_at)) : '—'}</span>
        </div>`).join('');
        el.removeAttribute('aria-busy');
        el.innerHTML = `
            <div class="fiche-head">
              <div class="fiche-avatar">P</div>
              <div><div class="fiche-title">${AdminPage.esc(account.partner_key || 'Partenaire individuel')}</div>
              <div class="umeta">Aucune référence KYC provider, adresse e-mail, donnée bancaire ou identifiant interne n’est exposé dans cette vue. La référence partenaire affichée est publique et pseudonymisée.</div></div>
            </div>
            <div class="partners-detail-grid">
              <section class="section"><div class="sec-head"><h2>Compte et contrat</h2></div>
                <dl class="partners-checklist">
                  ${fact('Compte', account.status)}
                  ${fact('Identité', account.verification_status)}
                  ${fact('Contrat', account.contract_status)}
                  ${fact('Lien', link.status || 'none')}
                  ${fact('Résidence fiscale', fiscal.status || 'missing')}
                  ${fact('Juridiction', [
                      account.country_code || policy.country_code,
                      account.subdivision_code || policy.subdivision_code
                  ].filter(Boolean).join(' · '))}
                </dl>
              </section>
              <section class="section"><div class="sec-head"><h2>Capacités opérationnelles</h2></div>
                <div class="partners-admin-readiness">${this._partnersCapabilityCards(data.readiness || {})}</div>
              </section>
              ${canManagePayout ? `<section class="section">
                <div class="sec-head"><h2>Bénéficiaire Revolut</h2><span class="pill">${AdminPage.n(payoutProfiles.length)}</span></div>
                <div class="partners-event-list">${payoutRows || '<div class="ssub">Aucun profil de versement Revolut configuré.</div>'}</div>
                <div class="partners-ops-list" style="margin-top:12px">${bindingRows || '<div class="ssub">Aucune proposition de binding bénéficiaire.</div>'}</div>
                <p class="ssub">L’identifiant bénéficiaire et son empreinte restent secrets. Toute nouvelle proposition part de la demande publique sanitisée dans la file Finance, puis doit être activée par un second opérateur.</p>
              </section>` : ''}
            </div>
            <section class="section"><div class="sec-head"><h2>Historique audité</h2><span class="pill">${AdminPage.n(events.length)}</span></div>
              <div class="partners-event-list">${eventRows || '<div class="ssub">Aucun événement audité pour ce compte.</div>'}</div>
            </section>`;
    }

    async _partnersPrompt(message, defaultValue, validate, invalidMessage) {
        const raw = await this._prompt(message, defaultValue == null ? '' : String(defaultValue));
        if (raw === null) return null;
        const value = String(raw).trim();
        if (typeof validate === 'function' && !validate(value)) {
            this._toast(invalidMessage || 'Valeur invalide. Aucune action n’a été exécutée.', 'err');
            return null;
        }
        return value;
    }

    async _partnersPromptJson(message, defaultValue, validate, invalidMessage) {
        const raw = await this._modal({
            title: 'Preuve immuable',
            message,
            prompt: true,
            multiline: true,
            wide: true,
            rows: 12,
            maxLength: 12000,
            def: JSON.stringify(defaultValue || {}, null, 2),
            okLabel: 'Valider le manifeste'
        });
        if (raw === null) return null;
        try {
            const parsed = JSON.parse(String(raw));
            if (typeof validate === 'function' && !validate(parsed)) {
                throw new Error('invalid_json_contract');
            }
            return parsed;
        } catch (_) {
            this._toast(invalidMessage || 'JSON invalide. Aucune action n’a été exécutée.', 'err');
            return null;
        }
    }

    _partnersApprovalRequiredDocuments(gateKey) {
        const specialized = {
            membership_privacy_approved: [
                'membership_privacy_notice',
                'membership_records_of_processing',
                'membership_minimization_review'
            ],
            privacy_approved: [
                'biometric_consent',
                'dpia',
                'gdpr_self_assessment',
                'privacy_notice',
                'records_of_processing'
            ],
            legal_and_tax_approved: [
                'legal_tax_review',
                'owner_risk_acceptance',
                'partners_terms',
                'partners_disclosure',
                'tax_operating_policy'
            ],
            individual_verification_coverage_confirmed: ['kyc_certification'],
            individual_payout_coverage_confirmed: ['payout_coverage_review'],
            country_policy_approved: ['country_policy_review', 'payout_corridor_review'],
            financial_data_contract_approved: ['financial_contract_test'],
            shadow_reconciliation_clean: ['shadow_reconciliation_report'],
            backup_restore_verified: ['restore_rehearsal_proof'],
            payout_execution_adapter_verified: ['payout_execution_test'],
            manual_payout_workflow_verified: ['manual_payout_runbook_test'],
            revolut_api_adapter_verified: ['revolut_api_certification'],
            tv_relay_security_verified: ['tv_relay_security_review'],
            general_release_approved: ['release_readiness_report']
        }[String(gateKey || '')];
        return Array.isArray(specialized)
            ? ['approval_record', 'deployment_proof', ...specialized]
            : [];
    }

    _partnersEvidenceHashesValid(value, requiredKeys = []) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const entries = Object.entries(value);
        if (entries.length < 1 || entries.length > 64) return false;
        const hashes = [];
        for (const [key, hash] of entries) {
            if (!/^[a-z][a-z0-9_]{2,63}$/.test(key)
                || typeof hash !== 'string'
                || !/^[0-9a-f]{64}$/.test(hash)
                || /^0{64}$/.test(hash)) return false;
            hashes.push(hash);
        }
        return new Set(hashes).size === hashes.length
            && requiredKeys.every((key) => Object.hasOwn(value, key));
    }

    async _partnersJustification(label) {
        return this._partnersPrompt(
            `Justification auditée pour « ${label} » (12 à 1000 caractères) :`,
            '',
            (value) => value.length >= 12 && value.length <= 1000,
            'La justification doit contenir entre 12 et 1000 caractères.'
        );
    }

    async _partnersTypedConfirmation(expected) {
        return this._partnersPrompt(
            `Saisissez exactement cette confirmation :\n${expected}`,
            '',
            (value) => value === expected,
            'La confirmation ne correspond pas. Aucune action n’a été exécutée.'
        );
    }

    async _partnersPickTextFile(accept, maxBytes = 5_000_000) {
        return new Promise((resolve, reject) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = accept;
            input.hidden = true;
            let settled = false;
            const finish = (value, error = null) => {
                if (settled) return;
                settled = true;
                input.remove();
                if (error) reject(error);
                else resolve(value);
            };
            input.addEventListener('cancel', () => finish(null), { once: true });
            input.addEventListener('change', async () => {
                const file = input.files?.[0] || null;
                if (!file) {
                    finish(null);
                    return;
                }
                if (!Number.isSafeInteger(file.size) || file.size < 1
                    || file.size > maxBytes) {
                    finish(null, new Error('invalid_file_size'));
                    return;
                }
                try {
                    finish({
                        name: String(file.name || 'document'),
                        text: await file.text()
                    });
                } catch (_) {
                    finish(null, new Error('file_read_failed'));
                }
            }, { once: true });
            document.body.appendChild(input);
            input.click();
        });
    }

    async _partnersPickEvidenceHash() {
        return new Promise((resolve, reject) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.pdf,.png,.jpg,.jpeg,.webp,.csv,.tsv,.txt,application/pdf,image/png,image/jpeg,image/webp,text/plain,text/csv,text/tab-separated-values';
            input.hidden = true;
            let settled = false;
            const finish = (value, error = null) => {
                if (settled) return;
                settled = true;
                input.remove();
                if (error) reject(error);
                else resolve(value);
            };
            input.addEventListener('cancel', () => finish(null), { once: true });
            input.addEventListener('change', async () => {
                const file = input.files?.[0] || null;
                if (!file) {
                    finish(null);
                    return;
                }
                if (!Number.isSafeInteger(file.size) || file.size < 1
                    || file.size > 10_000_000) {
                    finish(null, new Error('invalid_evidence_file_size'));
                    return;
                }
                try {
                    finish({
                        hash: await this._partnersSha256Bytes(
                            await file.arrayBuffer()
                        ),
                        observedAt: new Date().toISOString()
                    });
                } catch (_) {
                    finish(null, new Error('evidence_hash_failed'));
                }
            }, { once: true });
            document.body.appendChild(input);
            input.click();
        });
    }

    _partnersSpreadsheetSafe(value) {
        const text = String(value ?? '');
        return /^[=+\-@]/.test(text) ? `'${text}` : text;
    }

    _partnersReadExactCrlfTsv(text, expectedHeader, expectedRows, errorCode) {
        if (typeof text !== 'string'
            || !text.endsWith('\r\n')
            || text.length < expectedHeader.length + 2
            || text.length > 5_000_000
            || /[\r\n]/.test(text.replace(/\r\n/g, ''))) {
            throw new Error(errorCode);
        }
        const lines = text.split('\r\n');
        if (lines.pop() !== ''
            || lines.shift() !== expectedHeader
            || lines.length !== expectedRows) {
            throw new Error(errorCode);
        }
        return lines.map((line) => line.split('\t'));
    }

    async _partnersValidateRevolutBatchExport(payload, expectedKey) {
        const batch = payload?.batch;
        const items = payload?.items;
        if (payload?.schema_version !== 1
            || payload?.action !== 'revolut_manual_batch_export'
            || typeof payload?.replayed !== 'boolean'
            || !batch || batch.key !== expectedKey
            || ![
                'exported',
                'partially_submitted',
                'submitted',
                'partially_reconciled',
                'settled',
                'exception'
            ].includes(
                String(batch.status || '')
            )
            || !Number.isSafeInteger(batch.item_count)
            || batch.item_count < 1 || batch.item_count > 5000
            || !Array.isArray(items) || items.length !== batch.item_count
            || !/^[0-9a-f]{64}$/.test(
                String(batch.canonical_manifest_hash || '')
            )
            || !/^[0-9a-f]{64}$/.test(String(batch.export_file_hash || ''))
            || batch.file_name !== `norva-revolut-${expectedKey}.tsv`) {
            throw new Error('invalid_manual_batch_export');
        }
        if (!payload.replayed && batch.status !== 'exported') {
            throw new Error('invalid_initial_manual_batch_export');
        }
        const batchCurrency = String(batch.currency || '');
        const batchExponent = Number(batch.currency_exponent);
        const batchTotal = Number(batch.total_minor);
        if (!/^[A-Z]{3}$/.test(batchCurrency)
            || !Number.isInteger(batchExponent)
            || batchExponent < 0 || batchExponent > 6
            || !Number.isSafeInteger(batchTotal) || batchTotal < 1) {
            throw new Error('invalid_manual_batch_totals');
        }
        const expectedHeader = 'norva_reference\tbeneficiary_token_ref\tdestination_masked\tamount_minor\tcurrency\tcurrency_exponent\tentered_in_revolut';
        const rows = this._partnersReadExactCrlfTsv(
            payload.tsv,
            expectedHeader,
            batch.item_count,
            'invalid_manual_batch_tsv'
        );
        const itemByReference = new Map();
        for (const item of items) {
            const reference = String(item?.reference || '');
            const executionKey = String(item?.execution_key || '');
            if (!/^NORVA-[A-F0-9]{12}$/.test(reference)
                || itemByReference.has(reference)
                || !/^rpe_[0-9a-f]{24}$/.test(executionKey)
                || typeof item?.entered_in_revolut !== 'boolean'
                || typeof item?.statement_matched !== 'boolean'
                || !/^[a-z][a-z0-9_]{1,63}$/.test(
                    String(item?.state || '')
                )) {
                throw new Error('invalid_manual_batch_item');
            }
            itemByReference.set(reference, item);
        }
        const canonicalRows = new Map();
        let computedTotal = 0;
        for (const columns of rows) {
            if (columns.length !== 7) {
                throw new Error('invalid_manual_batch_row');
            }
            const reference = String(columns[0] || '');
            const token = String(columns[1] || '');
            const masked = String(columns[2] || '');
            const amount = Number(columns[3]);
            const currency = String(columns[4] || '');
            const exponent = Number(columns[5]);
            const entered = String(columns[6] || '');
            const item = itemByReference.get(reference);
            if (!/^NORVA-[A-F0-9]{12}$/.test(reference)
                || canonicalRows.has(reference)
                || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                    token
                )
                || masked.length < 4 || masked.length > 64
                || /[\t\r\n\u0000-\u001f\u007f]/u.test(masked)
                || !Number.isSafeInteger(amount) || amount < 1
                || !/^[A-Z]{3}$/.test(currency)
                || !Number.isInteger(exponent) || exponent < 0 || exponent > 6
                || currency !== batchCurrency || exponent !== batchExponent
                || !Number.isSafeInteger(computedTotal + amount)
                || entered !== ''
                || !item
                || this._partnersSpreadsheetSafe(
                    item.destination_masked
                ) !== masked
                || Number(item.amount_minor) !== amount
                || String(item.currency || '') !== currency
                || Number(item.currency_exponent) !== exponent) {
                throw new Error('invalid_manual_batch_item');
            }
            computedTotal += amount;
            canonicalRows.set(reference, {
                columns: columns.slice(1, 6),
                enteredInRevolut: false
            });
        }
        if (computedTotal !== batchTotal
            || canonicalRows.size !== itemByReference.size) {
            throw new Error('invalid_manual_batch_total');
        }
        if (typeof TextEncoder !== 'function'
            || new TextEncoder().encode(payload.tsv).byteLength > 5_000_000
            || await this._partnersSha256Hex(payload.tsv)
            !== batch.export_file_hash) {
            throw new Error('manual_batch_export_hash_mismatch');
        }

        if (payload.replayed) {
            const progressHeader = 'norva_reference\tentered_in_revolut\tstatement_matched\tstate\treconciliation_status';
            const progressRows = this._partnersReadExactCrlfTsv(
                payload.progress_tsv,
                progressHeader,
                batch.item_count,
                'invalid_manual_batch_progress'
            );
            if (!/^[0-9a-f]{64}$/.test(
                String(batch.progress_file_hash || '')
            )
                || batch.progress_file_name
                    !== `norva-revolut-progress-${expectedKey}.tsv`
                || new TextEncoder().encode(payload.progress_tsv).byteLength
                    > 5_000_000
                || await this._partnersSha256Hex(payload.progress_tsv)
                    !== batch.progress_file_hash) {
                throw new Error('manual_batch_progress_hash_mismatch');
            }
            const progressByReference = new Map();
            for (const columns of progressRows) {
                if (columns.length !== 5) {
                    throw new Error('invalid_manual_batch_progress_row');
                }
                const reference = String(columns[0] || '');
                const entered = String(columns[1] || '');
                const matched = String(columns[2] || '');
                const state = String(columns[3] || '');
                const reconciliation = String(columns[4] || '');
                const item = itemByReference.get(reference);
                if (!item || progressByReference.has(reference)
                    || !['', 'YES'].includes(entered)
                    || !['', 'YES'].includes(matched)
                    || !/^[a-z][a-z0-9_]{1,63}$/.test(state)
                    || !/^[a-z][a-z0-9_]{1,63}$/.test(reconciliation)
                    || state !== String(item.state || '')
                    || item.entered_in_revolut !== (entered === 'YES')
                    || item.statement_matched !== (matched === 'YES')) {
                    throw new Error('invalid_manual_batch_progress_item');
                }
                progressByReference.set(reference, {
                    entered: entered === 'YES',
                    matched: matched === 'YES'
                });
                canonicalRows.get(reference).enteredInRevolut =
                    entered === 'YES';
            }
            if (progressByReference.size !== canonicalRows.size) {
                throw new Error('incomplete_manual_batch_progress');
            }
        } else if (batch.progress_file_hash != null
            || batch.progress_file_name != null
            || payload.progress_tsv != null) {
            throw new Error('unexpected_manual_batch_progress');
        }
        return {
            batch,
            canonicalRows,
            canonicalTsv: payload.tsv,
            canonicalFileName: batch.file_name,
            progressTsv: payload.replayed ? payload.progress_tsv : null,
            progressFileName: payload.replayed
                ? batch.progress_file_name
                : null
        };
    }

    _partnersParseRevolutSubmissionTsv(text, validatedExport) {
        const expected = validatedExport?.canonicalRows;
        if (!(expected instanceof Map) || !expected.size) {
            throw new Error('invalid_submission_template');
        }
        const normalized = String(text || '')
            .replace(/^\uFEFF/, '')
            .replace(/(?:\r?\n)+$/, '');
        const lines = normalized.split(/\r?\n/);
        const expectedHeader = 'norva_reference\tbeneficiary_token_ref\tdestination_masked\tamount_minor\tcurrency\tcurrency_exponent\tentered_in_revolut';
        if (lines.shift() !== expectedHeader || lines.length !== expected.size) {
            throw new Error('invalid_submission_file');
        }
        const seen = new Set();
        const transfers = lines.map((line) => {
            const columns = line.split('\t');
            if (columns.length !== 7) throw new Error('invalid_submission_row');
            const reference = String(columns[0] || '');
            const entered = String(columns[6] || '');
            const template = expected.get(reference);
            if (!template || seen.has(reference)
                || columns.slice(1, 6).some(
                    (value, index) => value !== template.columns[index]
                )
                || !['', 'YES'].includes(entered)
                || (template.enteredInRevolut && entered !== 'YES')) {
                throw new Error('invalid_submission_record');
            }
            seen.add(reference);
            if (entered !== 'YES') return null;
            return { reference };
        }).filter(Boolean);
        if (seen.size !== expected.size) throw new Error('incomplete_submission_file');
        if (!transfers.length) throw new Error('empty_submission_file');
        return transfers;
    }

    async _partnersSha256Hex(text) {
        if (typeof TextEncoder !== 'function') {
            throw new Error('secure_hash_unavailable');
        }
        return this._partnersSha256Bytes(
            new TextEncoder().encode(String(text))
        );
    }

    async _partnersSha256Bytes(value) {
        if (!window.crypto?.subtle) {
            throw new Error('secure_hash_unavailable');
        }
        const digest = await window.crypto.subtle.digest(
            'SHA-256',
            value
        );
        return Array.from(new Uint8Array(digest))
            .map((value) => value.toString(16).padStart(2, '0'))
            .join('');
    }

    _partnersDownloadText(filename, text, type) {
        const blob = new Blob([text], {
            type: type || 'text/tab-separated-values;charset=utf-8'
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.hidden = true;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    async _partnersImportRevolutStatement(csv) {
        const res = await fetch(
            `${this._sbUrl()}/functions/v1/norva-partners-revolut-payout/manual/statements`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this._token()}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ csv })
            }
        );
        if (!res.ok) throw new Error('revolut_statement_import_failed');
        const body = await res.json();
        const imported = body?.data?.import;
        if (body?.data?.schema_version !== 1
            || body?.data?.action !== 'revolut_statement_ingested'
            || !imported || typeof imported !== 'object') {
            throw new Error('invalid_revolut_statement_response');
        }
        const counts = [
            imported.accepted,
            imported.matched,
            imported.unmatched,
            imported.mismatch,
            imported.duplicate,
            body?.ignoredRows
        ].map(Number);
        if (counts.some((value) => !Number.isSafeInteger(value) || value < 0)) {
            throw new Error('invalid_revolut_statement_counts');
        }
        return {
            accepted: counts[0],
            matched: counts[1],
            unmatched: counts[2],
            mismatch: counts[3],
            duplicate: counts[4],
            ignored: counts[5]
        };
    }

    async _partnersProposeRevolutBeneficiary(proposal) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        let res;
        try {
            res = await fetch(
                `${this._sbUrl()}/functions/v1/norva-partners-revolut-payout/manual/beneficiaries/propose`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this._token()}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(proposal),
                    signal: controller.signal
                }
            );
        } finally {
            clearTimeout(timeout);
        }
        if (!res.ok) throw new Error('revolut_beneficiary_proposal_failed');
        const body = await res.json();
        const data = body?.data;
        const binding = data?.binding;
        if (data?.schema_version !== 1
            || data?.action !== 'revolut_beneficiary_binding_proposed'
            || !binding || typeof binding !== 'object'
            || !/^rbb_[0-9a-f]{24}$/.test(String(binding.key || ''))
            || !/^[A-Z]{3}$/.test(String(binding.currency || ''))
            || !Number.isSafeInteger(Number(binding.version))
            || Number(binding.version) < 1
            || !Number.isSafeInteger(Number(binding.fingerprint_key_version))
            || Number(binding.fingerprint_key_version) < 1
            || binding.status !== 'pending'
            || typeof binding.display_masked !== 'string'
            || binding.display_masked.length < 4
            || typeof binding.payment_method_configured !== 'boolean') {
            throw new Error('invalid_revolut_beneficiary_proposal_response');
        }
        return binding;
    }

    _partnersRandomUuid() {
        if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0'));
        return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
    }

    async _partnersAdminAction(button) {
        if (!button || button.disabled || button.dataset.partnersBusy === 'true') return;
        const previous = button.textContent;
        const focus = this._partnersCaptureFocus(button);
        button.dataset.partnersBusy = 'true';
        button.setAttribute('aria-disabled', 'true');
        button.setAttribute('aria-busy', 'true');
        button.textContent = 'Traitement…';
        try {
            const success = await this._runPartnersAdminAction(button);
            if (!success) return;
            this._toast(success, 'ok');
            if (this._route === 'partners') {
                if (['payout-onboarding-decide', 'payout-onboarding-contact',
                    'revolut-binding-propose-request'].includes(
                    button.dataset.partnersAction
                )) {
                    const main = document.querySelector('#page-admin .crm-main');
                    const scrollTop = main?.scrollTop || 0;
                    const requestKey = String(button.dataset.partnersRequestKey || '');
                    await this._partnersLoadPayoutOnboardingRequests({ force: true });
                    if (main) main.scrollTop = scrollTop;
                    const requestCard = Array.from(document.querySelectorAll(
                        '[data-partners-onboarding-request-key]'
                    )).find((card) => (
                        card.dataset.partnersOnboardingRequestKey === requestKey
                    ));
                    if (!this._partnersFocusElement(requestCard)) {
                        this._partnersFocusElement(document.getElementById(
                            'partners-admin-payout-onboarding'
                        ));
                    }
                } else if (button.dataset.partnersAction === 'fiscal-review-public') {
                    const main = document.querySelector('#page-admin .crm-main');
                    const scrollTop = main?.scrollTop || 0;
                    const partnerKey = String(button.dataset.partnersPartnerKey || '');
                    await this._partnersLoadFiscalProfiles({ force: true });
                    if (main) main.scrollTop = scrollTop;
                    const fiscalCard = Array.from(document.querySelectorAll(
                        '[data-partners-fiscal-partner-key]'
                    )).find((card) => (
                        card.dataset.partnersFiscalPartnerKey === partnerKey
                    ));
                    if (!this._partnersFocusElement(fiscalCard)) {
                        this._partnersFocusElement(document.getElementById(
                            'partners-admin-fiscal-profiles'
                        ));
                    }
                } else {
                    await this._partnersRefreshVisibleView({ focusDescriptor: focus });
                }
            } else if (this._route.startsWith('partner:')
                || this._route.startsWith('partner-public:')) {
                const main = document.querySelector('#page-admin .crm-main');
                const scrollTop = main?.scrollTop || 0;
                if (this._route.startsWith('partner-public:')) {
                    await this._pagePartnerDetailByPublicId(this._route.slice(15));
                } else {
                    await this._pagePartnerDetail(this._route.slice(8));
                }
                if (main) main.scrollTop = scrollTop;
                if (!this._partnersRestoreFocus(focus)) {
                    document.querySelector('#page-admin .crm-back')?.focus?.({ preventScroll: true });
                }
            }
        } catch (error) {
            const diditMessages = {
                didit_certification_result_uncertain: 'Résultat réseau incertain. Norva vérifie l’état avant toute nouvelle tentative.',
                didit_certification_disabled: 'La fenêtre supervisée Didit est fermée. Aucun parcours d’identité n’a été lancé.',
                provider_not_configured: 'La configuration Didit live n’est pas disponible. Aucun parcours d’identité n’a été lancé.',
                partners_action_not_allowed: 'Un prérequis de sécurité n’est plus satisfait. Rouvrez la préparation Didit pour voir l’état exact.',
                invalid_access_token: 'La session Admin a expiré. Reconnectez-vous avant de reprendre.',
                didit_certification_preflight_timeout: 'Le contrôle des prérequis a expiré. Aucun champ sensible ni parcours Didit n’a été ouvert.',
                invalid_didit_certification_preflight: 'La réponse de contrôle Didit est incohérente. L’opération reste fermée.'
            };
            this._toast(
                diditMessages[String(error?.code || error?.message || '')]
                    || 'Action refusée ou indisponible. Vérifiez vos capacités, les prérequis de release et l’état autoritatif.',
                'err'
            );
        } finally {
            if (button.isConnected) {
                delete button.dataset.partnersBusy;
                button.removeAttribute('aria-disabled');
                button.removeAttribute('aria-busy');
                button.textContent = previous;
            }
        }
    }

    async _runPartnersAdminAction(button) {
        const action = String(button.dataset.partnersAction || '');
        const enabled = button.dataset.partnersEnabled === 'true';
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        const slug = /^[a-z0-9][a-z0-9._-]{2,63}$/;
        const isoCountry = /^[A-Z]{2}$/;
        const currencyCode = /^[A-Z]{3}$/;
        const certificationAction = [
            'kyc-certification-start', 'kyc-certification-resume'
        ].includes(action);
        if (action === 'aal2-elevate') return this._partnersElevateAal2();
        if (!certificationAction && action !== 'revolut-incident-page'
            && !(await this._partnersEnsureAal2())) {
            return false;
        }
        if (['account-action', 'job-retry', 'commission-reverse', 'payout-create',
            'payout-approve', 'fiscal-review-public'].includes(action)
            && !this._partnersCanUseOperationalAction(action)) return false;

        if (certificationAction) {
            if (this._partnersCapabilities.risk !== true) return false;
            const resuming = action === 'kyc-certification-resume';
            const preflight = await this._partnersFetchKycCertificationPreflight();
            const guided = await this._partnersKycCertificationDialog({
                preflight,
                resuming
            });
            if (!guided) return false;
            const confirmation = guided.confirmation;
            const justification = guided.justification;

            // Prove that the same-tab callback marker can be written before
            // any provider-side effect. If private mode denies sessionStorage,
            // fail closed instead of creating a session the app cannot safely
            // classify on return.
            try {
                const storageKey = 'norva-partners-kyc-certification-v1';
                sessionStorage.setItem(storageKey, String(Date.now()));
                sessionStorage.removeItem(storageKey);
            } catch (_) {
                throw new Error('didit_certification_storage_unavailable');
            }

            if (!(this._partnersRequests instanceof Map)) {
                this._partnersRequests = new Map();
            }
            const requestKey = 'kycCertificationMutation';
            const previousRequest = this._partnersRequests.get(requestKey);
            if (typeof previousRequest?.cancel === 'function') previousRequest.cancel();
            else previousRequest?.controller?.abort?.();
            const controller = this._partnersCreateController();
            const token = ++this._partnersRequestSeq;
            const context = {
                route: this._route,
                view: this._partnersView,
                generation: this._partnersPageGeneration,
                token
            };
            const request = {
                ...context,
                controller,
                cancelled: false,
                cancel() {
                    if (this.cancelled) return;
                    this.cancelled = true;
                    this.controller?.abort?.();
                }
            };
            this._partnersRequests.set(requestKey, request);
            const contextIsCurrent = () => (
                this._partnersRequests.get(requestKey)?.token === context.token
                && this._route === context.route
                && this._route === 'partners'
                && this._partnersView === context.view
                && context.view === 'risk'
                && this._partnersPageGeneration === context.generation
            );
            const timeout = setTimeout(() => controller.abort?.(), 15_000);
            try {
                const response = await fetch(
                    `${this._sbUrl()}/functions/v1/norva-partners/kyc/certification${resuming ? '/resume' : ''}`,
                    {
                        method: 'POST',
                        headers: {
                            apikey: this._sbKey(),
                            Authorization: `Bearer ${this._token()}`,
                            'Content-Type': 'application/json',
                            ...(resuming ? {} : {
                                'Idempotency-Key': `didit-certification:${this._partnersRandomUuid()}`
                            })
                        },
                        body: JSON.stringify(resuming ? {} : {
                            language: 'fr',
                            consentVersion: 'partners-didit-certification-v1',
                            consentGranted: true,
                            capacityConfirmed: true,
                            confirmation,
                            justification
                        }),
                        signal: controller.signal
                    }
                );
                const envelope = await this._partnersReadBoundedJsonResponse(
                    response,
                    controller.signal
                );
                if (!response.ok) {
                    const allowed = new Set([
                        'didit_certification_disabled', 'provider_not_configured',
                        'partners_action_not_allowed', 'invalid_access_token',
                        'invalid_request', 'idempotency_key_reused',
                        'request_in_progress', 'rate_limited',
                        'provider_temporarily_unavailable',
                        'partners_temporarily_unavailable'
                    ]);
                    const code = allowed.has(String(envelope?.error?.code || ''))
                        ? String(envelope.error.code)
                        : 'partners_temporarily_unavailable';
                    const error = new Error(code);
                    error.code = code;
                    error.status = Number(response.status) || 0;
                    throw error;
                }
                const exactKeys = (value, expected) => value
                    && typeof value === 'object'
                    && !Array.isArray(value)
                    && Object.keys(value).sort().join('|')
                        === expected.slice().sort().join('|');
                const result = envelope?.data;
                const verification = result?.verification;
                let hostedUrl;
                const expiresAt = Date.parse(String(verification?.expires_at || ''));
                const now = Date.now();
                const maxHostedSessionTtlMs = 2 * 60 * 60 * 1_000;
                try {
                    hostedUrl = new URL(String(verification?.url || ''));
                } catch (_) {
                    throw new Error('invalid_didit_certification_url');
                }
                if (!exactKeys(envelope, ['version', 'correlationId', 'data'])
                    || envelope.version !== '2026-07-29'
                    || !/^prt_[0-9a-f]{24}$/.test(String(envelope.correlationId || ''))
                    || !exactKeys(result, [
                        'schema_version', 'action', 'replayed', 'verification'
                    ])
                    || result.schema_version !== 1
                    || result.action !== 'kyc_certification_session_created'
                    || typeof result.replayed !== 'boolean'
                    || !exactKeys(verification, [
                        'provider', 'status', 'url', 'expires_at'
                    ])
                    || verification.provider !== 'didit'
                    || !['not_started', 'in_progress', 'awaiting_user'].includes(
                        String(verification.status || '')
                    )
                    || hostedUrl.origin !== 'https://verify.didit.me'
                    || hostedUrl.username || hostedUrl.password
                    || !Number.isFinite(expiresAt)
                    || expiresAt <= now
                    || expiresAt > now + maxHostedSessionTtlMs) {
                    throw new Error('invalid_didit_certification_response');
                }
                if (!contextIsCurrent()) {
                    throw new Error('didit_certification_context_changed');
                }
                try {
                    this._partnersPersistKycCertificationReturnContext();
                    sessionStorage.setItem(
                        'norva-partners-kyc-certification-v1',
                        String(Date.now())
                    );
                } catch (error) {
                    this._partnersClearKycCertificationReturnState();
                    throw error;
                }
                if (!contextIsCurrent()) {
                    throw new Error('didit_certification_context_changed');
                }
                window.location.assign(hostedUrl.href);
                return false;
            } catch (error) {
                this._partnersClearKycCertificationReturnState();
                if (this._partnersIsDeterministicKycCertificationError(error)) {
                    throw error;
                }
                throw this._partnersMarkKycCertificationUncertain();
            } finally {
                clearTimeout(timeout);
                if (this._partnersRequests.get(requestKey)?.token === token) {
                    this._partnersRequests.delete(requestKey);
                }
            }
        }

        if (['kyc-human-review-locator', 'kyc-human-review-start',
            'kyc-human-review-uphold', 'kyc-human-review-reverify'].includes(action)) {
            if (!enabled || this._partnersCapabilities.risk !== true) return false;
            const reviewKey = String(button.dataset.partnersReviewKey || '');
            if (!/^khr_[0-9a-f]{24}$/.test(reviewKey)) return false;
            if (action === 'kyc-human-review-locator') {
                const confirmation = await this._partnersTypedConfirmation(`LOOKUP:${reviewKey}`);
                if (!confirmation) return false;
                const justification = await this._partnersJustification(
                    `consultation Didit du recours ${reviewKey}`
                );
                if (!justification) return false;
                const result = await this._rpc('admin_partners_kyc_human_review_locator', {
                    p_review_key: reviewKey,
                    p_confirmation: confirmation,
                    p_justification: justification
                });
                const lookup = result?.lookup;
                if (result?.schema_version !== 1
                    || result?.action !== 'kyc_human_review_locator_accessed'
                    || !lookup
                    || lookup.review_key !== reviewKey
                    || lookup.provider !== 'didit'
                    || !/^kyr_[0-9a-f]{24}$/.test(String(lookup.vendor_data || ''))) {
                    throw new Error('invalid_kyc_human_review_locator_response');
                }
                if (typeof navigator.clipboard?.writeText !== 'function') {
                    throw new Error('secure_clipboard_unavailable');
                }
                await navigator.clipboard.writeText(lookup.vendor_data);
                return 'Localisateur Didit opaque copie. Collez-le dans la console Didit; il n est ni affiche ni conserve par cette page.';
            }

            const actionMap = {
                'kyc-human-review-start': {
                    rpcAction: 'start',
                    confirmation: `START:${reviewKey}`,
                    label: `prise en charge du recours ${reviewKey}`
                },
                'kyc-human-review-uphold': {
                    rpcAction: 'resolve_upheld',
                    confirmation: `RESOLVE-UPHOLD:${reviewKey}`,
                    label: `maintien de la decision KYC pour ${reviewKey}`
                },
                'kyc-human-review-reverify': {
                    rpcAction: 'resolve_reverification',
                    confirmation: `RESOLVE-REVERIFY:${reviewKey}`,
                    label: `nouvelle verification KYC pour ${reviewKey}`
                }
            };
            const operation = actionMap[action];
            const confirmation = await this._partnersTypedConfirmation(operation.confirmation);
            if (!confirmation) return false;
            const justification = await this._partnersJustification(operation.label);
            if (!justification) return false;
            const evidence = operation.rpcAction === 'start'
                ? null
                : await this._partnersPickEvidenceHash();
            if (operation.rpcAction !== 'start' && !evidence) return false;
            const result = await this._rpc('admin_partners_kyc_human_review_decide', {
                p_review_key: reviewKey,
                p_action: operation.rpcAction,
                p_evidence_sha256: evidence?.hash || null,
                p_evidence_observed_at: evidence?.observedAt || null,
                p_confirmation: confirmation,
                p_justification: justification
            });
            const expectedAction = operation.rpcAction === 'start'
                ? 'kyc_human_review_started'
                : 'kyc_human_review_resolved';
            if (result?.schema_version !== 1
                || result?.action !== expectedAction
                || result?.review?.key !== reviewKey
                || !['in_review', 'resolved'].includes(result?.review?.status)) {
                throw new Error('invalid_kyc_human_review_decision_response');
            }
            return operation.rpcAction === 'start'
                ? 'Recours pris en charge par un operateur Risque.'
                : 'Recours resolu avec preuve locale hachee; aucun document n a ete envoye a Norva.';
        }

        if (['access-request-approve', 'access-request-decline'].includes(action)) {
            if (this._partnersCapabilities.risk !== true) return false;
            const requestId = String(button.dataset.partnersRequestId || '');
            const requestKey = String(button.dataset.partnersRequestKey || '');
            if (!uuid.test(requestId) || !/^[0-9a-f]{12}$/.test(requestKey)) return false;
            const approving = action === 'access-request-approve';
            const confirmed = await this._confirm(
                approving
                    ? `Approuver la demande ${requestKey} et ajouter ce compte à la liste pilote ? L’inscription, le KYC et les paiements resteront verrouillés par leurs propres contrôles.`
                    : `Refuser la demande ${requestKey} ? Aucun accès ni compte partenaire ne sera créé.`,
                {
                    danger: !approving,
                    okLabel: approving ? 'Approuver la demande' : 'Refuser la demande'
                }
            );
            if (!confirmed) return false;
            let expiresAt = null;
            if (approving) {
                const expiry = await this._partnersPrompt(
                    'Expiration facultative de l’invitation pilote au format ISO (vide = sans expiration) :',
                    '',
                    (value) => value === '' || (Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now()),
                    'Expiration invalide ou déjà passée.'
                );
                if (expiry === null) return false;
                expiresAt = expiry ? new Date(expiry).toISOString() : null;
            }
            const justification = await this._partnersJustification(
                `${approving ? 'approbation' : 'refus'} de la demande d’accès ${requestKey}`
            );
            if (!justification) return false;
            const result = await this._rpc('admin_partners_access_request_decide', {
                p_request_id: requestId,
                p_decision: approving ? 'approve' : 'decline',
                p_expires_at: expiresAt,
                p_justification: justification
            });
            if (result?.schema_version !== 1
                || result?.action !== 'access_request_decided'
                || result?.status !== (approving ? 'approved' : 'declined')
                || typeof result?.changed !== 'boolean'
                || typeof result?.allowlist_included !== 'boolean'
                || (approving && result.allowlist_included !== true)
                || (!approving && result.allowlist_included !== false)) {
                throw new Error('invalid_partners_access_request_decision_response');
            }
            return approving
                ? 'Demande approuvée, invitation pilote enregistrée et notification transactionnelle mise en file.'
                : 'Demande refusée sans créer d’accès partenaire ; notification transactionnelle mise en file.';
        }

        if (action === 'payout-onboarding-decide') {
            if (this._partnersCapabilities.finance !== true) return false;
            const requestKey = String(button.dataset.partnersRequestKey || '');
            const decision = String(button.dataset.partnersDecision || '');
            if (!/^por_[0-9a-f]{24}$/.test(requestKey)
                || !['start', 'reject', 'complete'].includes(decision)) return false;
            if (decision === 'complete'
                && (button.dataset.partnersBindingReady !== 'true'
                    || button.dataset.partnersProfileReady !== 'true')) {
                this._toast(
                    'La finalisation reste verrouillée tant que le binding actif et le profil vérifié ne sont pas prêts côté serveur.',
                    'err'
                );
                return false;
            }
            const labels = {
                start: 'commencer la configuration manuelle',
                reject: 'rejeter cette demande',
                complete: 'finaliser la configuration contrôlée'
            };
            const confirmed = await this._confirm(
                `Confirmer : ${labels[decision]} pour ${requestKey} ?`,
                {
                    danger: decision === 'reject',
                    okLabel: decision === 'start'
                        ? 'Commencer'
                        : (decision === 'reject' ? 'Rejeter' : 'Finaliser')
                }
            );
            if (!confirmed) return false;
            let reasonCode = null;
            if (decision === 'reject') {
                const reasons = [
                    ['route_unavailable', 'Corridor non disponible'],
                    ['beneficiary_setup_required', 'Bénéficiaire à configurer'],
                    ['identity_mismatch', 'Identité non concordante'],
                    ['unsupported_destination', 'Destination non prise en charge'],
                    ['compliance_review', 'Revue de conformité requise'],
                    ['duplicate_request', 'Demande déjà couverte']
                ];
                const choice = await this._partnersPrompt(
                    `Choisissez le motif contrôlé (1–6) : ${reasons.map(
                        ([, label], index) => `${index + 1} — ${label}`
                    ).join(' · ')}`,
                    '1',
                    (value) => /^[1-6]$/.test(value),
                    'Choisissez un nombre de 1 à 6.'
                );
                if (choice === null) return false;
                reasonCode = reasons[Number(choice) - 1][0];
            }
            const justification = await this._partnersJustification(
                `${labels[decision]} pour ${requestKey}`
            );
            if (!justification) return false;
            const result = await this._rpc(
                'admin_partners_payout_onboarding_request_decide',
                {
                    p_request_key: requestKey,
                    p_action: decision,
                    p_reason_code: reasonCode,
                    p_justification: justification
                }
            );
            const expectedStatus = {
                start: 'in_progress',
                reject: 'rejected',
                complete: 'completed'
            }[decision];
            if (result?.schema_version !== 1
                || result?.action !== 'payout_onboarding_decided'
                || typeof result?.changed !== 'boolean'
                || result?.request_key !== requestKey
                || !/^prt_[0-9a-f]{24}$/.test(String(result?.partner_key || ''))
                || result?.status !== expectedStatus) {
                throw new Error('invalid_partners_payout_onboarding_decision_response');
            }
            return {
                start: 'Configuration manuelle commencée. La demande reste traçable dans Finance.',
                reject: 'Demande rejetée avec un motif contrôlé et audité.',
                complete: 'Configuration finalisée après validation du binding et du profil.'
            }[decision];
        }

        if (action === 'payout-onboarding-contact') {
            if (!this._partnersHasCapabilities('support', 'finance')) return false;
            const requestKey = String(button.dataset.partnersRequestKey || '');
            if (!/^por_[0-9a-f]{24}$/.test(requestKey)) return false;
            const templates = [
                ['secure_setup_invitation', 'Invitation à démarrer la configuration sécurisée'],
                ['setup_follow_up', 'Relance de la configuration en cours'],
                ['reconfiguration_required', 'Nouvelle destination requise']
            ];
            const pendingContact = this._partnersContactKeys.get(requestKey) || null;
            let templateKey = pendingContact?.templateKey || '';
            if (!templateKey) {
                const choice = await this._partnersPrompt(
                    `Choisissez le modèle contrôlé (1–3) : ${templates.map(
                        ([, label], index) => `${index + 1} — ${label}`
                    ).join(' · ')}`,
                    '1',
                    (value) => /^[1-3]$/.test(value),
                    'Choisissez un nombre de 1 à 3.'
                );
                if (!choice) return false;
                templateKey = templates[Number(choice) - 1][0];
            }
            const templateLabel = templates.find(([key]) => key === templateKey)?.[1];
            if (!templateLabel) return false;
            const confirmed = await this._confirm(
                `${pendingContact ? 'Reprendre sans doublon' : 'Envoyer'} le modèle « ${templateLabel} » au canal vérifié pour ${requestKey} ? L’adresse e-mail ne sera pas révélée.`,
                { okLabel: pendingContact ? 'Reprendre' : 'Envoyer le message' }
            );
            if (!confirmed) return false;
            const idempotencyKey = pendingContact?.idempotencyKey
                || this._partnersRandomUuid();
            this._partnersContactKeys.set(requestKey, { templateKey, idempotencyKey });
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 20000);
            let result;
            try {
                result = await this._rpc(
                    'admin_partners_payout_onboarding_contact',
                    {
                        p_request_key: requestKey,
                        p_template_key: templateKey,
                        p_idempotency_key: idempotencyKey
                    },
                    { signal: controller.signal }
                );
            } finally {
                clearTimeout(timeout);
            }
            const exactKeys = ['action', 'changed', 'channel', 'contact_key',
                'delivery_state', 'partner_key', 'request_key', 'schema_version',
                'template_key'];
            if (!result || typeof result !== 'object' || Array.isArray(result)
                || Object.keys(result).sort().join('|') !== exactKeys.join('|')
                || result.schema_version !== 1
                || result.action !== 'payout_onboarding_contact_sent'
                || typeof result.changed !== 'boolean'
                || result.request_key !== requestKey
                || !/^poc_[0-9a-f]{24}$/.test(String(result.contact_key || ''))
                || result.channel !== 'verified_account_email'
                || result.template_key !== templateKey
                || !/^[a-z][a-z0-9_]{1,31}$/.test(String(result.delivery_state || ''))
                || !/^prt_[0-9a-f]{24}$/.test(String(result.partner_key || ''))) {
                throw new Error('invalid_partners_payout_onboarding_contact_response');
            }
            this._partnersContactKeys.delete(requestKey);
            return result.changed
                ? 'Message audité remis à la file du canal e-mail vérifié.'
                : 'Ce message avait déjà été enregistré ; aucun doublon n’a été créé.';
        }

        if (action === 'revolut-binding-propose-request') {
            if (this._partnersCapabilities.finance !== true) return false;
            const requestKey = String(button.dataset.partnersRequestKey || '');
            if (!/^por_[0-9a-f]{24}$/.test(requestKey)) return false;
            const beneficiaryToken = await this._partnersPrompt(
                'UUID opaque du bénéficiaire issu du registre Finance sécurisé (ou UUID counterparty Revolut pour le futur mode API) :',
                '',
                (value) => uuid.test(value),
                'L’identifiant doit être un UUID valide et déjà relié au bénéficiaire réel dans le registre Finance.'
            );
            if (!beneficiaryToken) return false;
            const paymentMethod = await this._partnersPrompt(
                'UUID du moyen de paiement Revolut (laisser vide sous Basic manuel) :',
                '',
                (value) => value === '' || uuid.test(value),
                'Le moyen de paiement doit être vide ou contenir un UUID valide.'
            );
            if (paymentMethod === null) return false;
            const destinationMasked = await this._partnersPrompt(
                'Libellé de contrôle masqué (ex. J. H. · FR76••••1234) :',
                '',
                (value) => value.length >= 4
                    && value.length <= 64
                    && /[*•]/.test(value)
                    && !/[\u0000-\u001f\u007f]/u.test(value)
                    && !/[0-9]{6,}/.test(value.replace(/[\s-]/g, '')),
                'Le libellé doit être masqué, sans identifiant bancaire complet.'
            );
            if (!destinationMasked) return false;
            const mappingEvidenceHash = await this._partnersPrompt(
                'SHA-256 (64 caractères hexadécimaux) de la preuve de correspondance archivée dans le registre Finance sécurisé :',
                '',
                (value) => /^[0-9a-f]{64}$/i.test(value),
                'L’empreinte de preuve doit être un SHA-256 hexadécimal.'
            );
            if (!mappingEvidenceHash) return false;
            const confirmation = await this._partnersTypedConfirmation(
                `PROPOSE-BENEFICIARY:${requestKey}`
            );
            if (!confirmation) return false;
            const justification = await this._partnersJustification(
                `proposition du bénéficiaire pour ${requestKey}`
            );
            if (!justification) return false;
            const binding = await this._partnersProposeRevolutBeneficiary({
                request_key: requestKey,
                beneficiary_token_ref: beneficiaryToken.toLowerCase(),
                beneficiary_payment_method_ref: paymentMethod
                    ? paymentMethod.toLowerCase()
                    : null,
                display_masked: destinationMasked,
                mapping_evidence_hash: mappingEvidenceHash.toLowerCase(),
                justification
            });
            return `Proposition ${binding.key} enregistrée depuis la demande publique. Un second opérateur Finance doit contrôler le registre sécurisé puis la vérifier ou la rejeter.`;
        }

        if (action === 'revolut-binding-verify'
            || action === 'revolut-binding-reject') {
            if (this._partnersCapabilities.finance !== true) return false;
            const bindingKey = String(button.dataset.partnersBinding || '');
            if (!/^rbb_[0-9a-f]{24}$/.test(bindingKey)) return false;
            const verify = action === 'revolut-binding-verify';
            const operation = verify ? 'VERIFY' : 'REJECT';
            const confirmation = await this._partnersTypedConfirmation(
                `${operation}:${bindingKey}`
            );
            if (!confirmation) return false;
            const justification = await this._partnersJustification(
                `${verify ? 'vérification' : 'rejet'} du binding ${bindingKey}`
            );
            if (!justification) return false;
            await this._rpc(
                verify
                    ? 'admin_partners_revolut_beneficiary_binding_verify'
                    : 'admin_partners_revolut_beneficiary_binding_reject',
                {
                    p_binding_key: bindingKey,
                    p_confirmation: confirmation,
                    p_justification: justification
                }
            );
            return verify
                ? 'Binding bénéficiaire vérifié par un second opérateur et profil activé.'
                : 'Proposition bénéficiaire rejetée sans activation du profil.';
        }

        if (action === 'revolut-binding-revoke-request'
            || action === 'revolut-binding-revoke-confirm') {
            if (this._partnersCapabilities.finance !== true) return false;
            const bindingKey = String(button.dataset.partnersBinding || '');
            if (!/^rbb_[0-9a-f]{24}$/.test(bindingKey)) return false;
            const confirm = action === 'revolut-binding-revoke-confirm';
            const revocationKey = String(
                button.dataset.partnersRevocation || ''
            );
            if (confirm && !/^rbr_[0-9a-f]{24}$/.test(revocationKey)) {
                return false;
            }
            const expected = confirm
                ? `CONFIRM-REVOKE:${revocationKey}`
                : `REQUEST-REVOKE:${bindingKey}`;
            const confirmation = await this._partnersTypedConfirmation(expected);
            if (!confirmation) return false;
            const justification = await this._partnersJustification(
                `${confirm ? 'confirmation' : 'demande'} de révocation du binding ${bindingKey}`
            );
            if (!justification) return false;
            await this._rpc(
                'admin_partners_revolut_beneficiary_binding_revoke',
                {
                    p_binding_key: bindingKey,
                    p_confirmation: confirmation,
                    p_justification: justification
                }
            );
            return confirm
                ? 'Binding révoqué par un second opérateur. Une nouvelle version vérifiée est obligatoire avant tout futur versement.'
                : 'Révocation demandée et profil immédiatement placé en vérification. Un second opérateur doit confirmer.';
        }

        if ([
            'revolut-return-review-eligible',
            'revolut-return-review-quarantine',
            'revolut-return-decide-confirm',
            'revolut-return-decide-quarantine'
        ].includes(action)) {
            if (this._partnersCapabilities.finance !== true) return false;
            const isReview = action.startsWith('revolut-return-review-');
            const isPositive = action.endsWith('-eligible')
                || action.endsWith('-confirm');
            const reference = String(button.dataset.partnersReference || '');
            const destination = String(button.dataset.partnersDestination || '');
            const amount = Number(button.dataset.partnersAmount);
            const currency = String(button.dataset.partnersCurrency || '');
            const hasVerificationContext = /^NORVA-[A-F0-9]{12}$/.test(reference)
                && destination.length >= 4
                && /[*•]/u.test(destination)
                && Number.isSafeInteger(amount) && amount > 0
                && /^[A-Z]{3}$/.test(currency);
            if (isPositive && !hasVerificationContext) {
                this._toast(
                    'Le contexte de contrôle du virement retourné est incomplet. Aucune résolution financière n’a été enregistrée.',
                    'err'
                );
                return false;
            }
            if (isReview) {
                const observation = String(
                    button.dataset.partnersObservation || ''
                );
                if (!/^rro_[0-9a-f]{24}$/.test(observation)) return false;
                const expected = `REVIEW:${observation}`;
                const confirmation = isPositive
                    ? await this._partnersPrompt(
                        `Contrôlez dans Revolut Business la référence ${reference}, la destination masquée ${destination}, le montant ${amount} ${currency} en unités mineures et l’état terminal.\n\nSaisissez ensuite exactement :\n${expected}`,
                        '',
                        (value) => value === expected,
                        'La confirmation ne correspond pas. Aucune revue n’a été enregistrée.'
                    )
                    : await this._partnersTypedConfirmation(expected);
                if (!confirmation) return false;
                const conclusion = isPositive ? 'eligible' : 'quarantine';
                const justification = await this._partnersJustification(
                    `${conclusion === 'eligible' ? 'revue du retour' : 'quarantaine du retour'} ${observation}`
                );
                if (!justification) return false;
                await this._rpc('admin_partners_revolut_return_review', {
                    p_observation_key: observation,
                    p_conclusion: conclusion,
                    p_confirmation: confirmation,
                    p_justification: justification
                });
                return conclusion === 'eligible'
                    ? 'Revue Finance enregistrée. Un second opérateur distinct doit confirmer la contre-écriture.'
                    : 'Revue en quarantaine enregistrée. Un second opérateur distinct doit confirmer la décision.';
            }
            const review = String(button.dataset.partnersReview || '');
            if (!/^rrv_[0-9a-f]{24}$/.test(review)) return false;
            const decision = isPositive ? 'confirmed' : 'quarantined';
            const expected = `${isPositive ? 'CONFIRM' : 'QUARANTINE'}:${review}`;
            const confirmation = isPositive
                ? await this._partnersPrompt(
                    `Contrôle final dans Revolut Business : vérifiez la référence ${reference}, la destination masquée ${destination}, le montant ${amount} ${currency} en unités mineures et l’absence de règlement utilisable.\n\nSaisissez ensuite exactement :\n${expected}`,
                    '',
                    (value) => value === expected,
                    'La confirmation ne correspond pas. Aucune contre-écriture n’a été créée.'
                )
                : await this._partnersTypedConfirmation(expected);
            if (!confirmation) return false;
            const justification = await this._partnersJustification(
                `${decision === 'confirmed' ? 'résolution du retour' : 'quarantaine définitive'} ${review}`
            );
            if (!justification) return false;
            await this._rpc('admin_partners_revolut_return_decide', {
                p_review_key: review,
                p_decision: decision,
                p_confirmation: confirmation,
                p_justification: justification
            });
            return decision === 'confirmed'
                ? 'Retour confirmé : la contre-écriture dédiée a été créée sans modifier l’historique du paiement.'
                : 'Observation maintenue en quarantaine sans contre-écriture.';
        }

        if ([
            'revolut-manual-control-request-cancel',
            'revolut-manual-control-request-unmapped'
        ].includes(action)) {
            if (this._partnersCapabilities.finance !== true) return false;
            const batchKey = String(button.dataset.partnersKey || '');
            const batch = this._partnersManualBatchControls?.get(batchKey);
            if (!batch) return false;
            const isCancellation = action.endsWith('-cancel');
            if (!isCancellation && !batch.unmappedReferences.length) {
                return false;
            }
            const evidence = await this._partnersPickEvidenceHash();
            if (!evidence || !/^[0-9a-f]{64}$/.test(evidence.hash)
                || !Number.isFinite(Date.parse(evidence.observedAt))) {
                return false;
            }
            const epoch = Math.floor(
                Date.parse(evidence.observedAt) / 1000
            );
            const expected = isCancellation
                ? `REQUEST-CANCEL:${batchKey}:${batch.referenceSetHash}:${evidence.hash}:${epoch}`
                : `REQUEST-RELEASE-UNMAPPED:${batchKey}:${evidence.hash}:${epoch}`;
            const confirmation = await this._partnersPrompt(
                `Vérifiez dans Revolut Business chaque référence concernée et conservez la preuve sélectionnée dans le registre Finance. Un second opérateur devra refaire une recherche indépendante.\n\nSaisissez ensuite exactement :\n${expected}`,
                '',
                (value) => value === expected,
                'La confirmation ne correspond pas. Aucune demande n’a été créée.'
            );
            if (!confirmation) return false;
            const justification = await this._partnersJustification(
                `${isCancellation ? 'demande d’annulation' : 'demande de libération des non-saisis'} ${batchKey}`
            );
            if (!justification) return false;
            if (isCancellation) {
                await this._rpc(
                    'admin_partners_revolut_manual_batch_cancel',
                    {
                        p_batch_key: batchKey,
                        p_reference_set_hash: batch.referenceSetHash,
                        p_provider_search_evidence_hash: evidence.hash,
                        p_provider_search_observed_at: evidence.observedAt,
                        p_confirmation: confirmation,
                        p_justification: justification
                    }
                );
                return 'Demande d’annulation enregistrée. Un second opérateur Finance doit refaire la recherche et confirmer.';
            }
            await this._rpc(
                'admin_partners_revolut_manual_batch_release_unmapped',
                {
                    p_batch_key: batchKey,
                    p_references: batch.unmappedReferences,
                    p_provider_search_evidence_hash: evidence.hash,
                    p_provider_search_observed_at: evidence.observedAt,
                    p_confirmation: confirmation,
                    p_justification: justification
                }
            );
            return 'Demande de libération enregistrée. Un second opérateur Finance doit refaire la recherche et confirmer.';
        }

        if (action === 'revolut-manual-control-reject') {
            if (this._partnersCapabilities.finance !== true) return false;
            const controlKey = String(button.dataset.partnersControl || '');
            const control = this._partnersManualControls?.get(controlKey);
            if (!control || control.status !== 'pending') return false;
            const confirmation = await this._partnersTypedConfirmation(
                `REJECT-CONTROL:${controlKey}`
            );
            if (!confirmation) return false;
            const justification = await this._partnersJustification(
                `rejet du contrôle Revolut ${controlKey}`
            );
            if (!justification) return false;
            await this._rpc(
                'admin_partners_revolut_manual_control_reject',
                {
                    p_control_key: controlKey,
                    p_confirmation: confirmation,
                    p_justification: justification
                }
            );
            return 'Demande rejetée par un second opérateur ; le lot est dégelé sans déplacement de fonds.';
        }

        if (action === 'revolut-manual-control-confirm') {
            if (this._partnersCapabilities.finance !== true) return false;
            const controlKey = String(button.dataset.partnersControl || '');
            const control = this._partnersManualControls?.get(controlKey);
            if (!control || control.status !== 'pending') return false;
            const evidence = await this._partnersPickEvidenceHash();
            if (!evidence || !/^[0-9a-f]{64}$/.test(evidence.hash)
                || !Number.isFinite(Date.parse(evidence.observedAt))) {
                return false;
            }
            const epoch = Math.floor(
                Date.parse(evidence.observedAt) / 1000
            );
            const confirmation = control.type === 'batch_cancellation'
                ? `CONFIRM-CANCEL:${control.key}:${evidence.hash}:${epoch}`
                : `CONFIRM-RELEASE-UNMAPPED:${control.key}:${evidence.hash}:${epoch}`;
            const typed = await this._partnersPrompt(
                `Effectuez maintenant une nouvelle recherche exacte et indépendante de toutes les références du contrôle dans Revolut Business. Conservez la preuve sélectionnée dans le registre Finance.\n\nSaisissez ensuite exactement :\n${confirmation}`,
                '',
                (value) => value === confirmation,
                'La confirmation ne correspond pas. Aucun fonds n’a été débloqué.'
            );
            if (!typed) return false;
            const justification = await this._partnersJustification(
                `second contrôle Revolut ${control.key}`
            );
            if (!justification) return false;
            if (control.type === 'batch_cancellation') {
                await this._rpc(
                    'admin_partners_revolut_manual_batch_cancel',
                    {
                        p_batch_key: control.batchKey,
                        p_reference_set_hash: control.referenceSetHash,
                        p_provider_search_evidence_hash: evidence.hash,
                        p_provider_search_observed_at: evidence.observedAt,
                        p_confirmation: typed,
                        p_justification: justification
                    }
                );
                return 'Annulation confirmée par un second opérateur ; les fonds non envoyés ont été remis à disposition.';
            }
            await this._rpc(
                'admin_partners_revolut_manual_batch_release_unmapped',
                {
                    p_batch_key: control.batchKey,
                    p_references: control.references,
                    p_provider_search_evidence_hash: evidence.hash,
                    p_provider_search_observed_at: evidence.observedAt,
                    p_confirmation: typed,
                    p_justification: justification
                }
            );
            return 'Références non saisies libérées après un second contrôle indépendant.';
        }

        if ([
            'revolut-late-review-eligible',
            'revolut-late-review-quarantine',
            'revolut-late-decide-confirm',
            'revolut-late-decide-quarantine'
        ].includes(action)) {
            if (this._partnersCapabilities.finance !== true) return false;
            const isReview = action.startsWith('revolut-late-review-');
            const key = String(isReview
                ? button.dataset.partnersObservation
                : button.dataset.partnersReview || '');
            if (isReview
                ? !/^rlc_[0-9a-f]{24}$/.test(key)
                : !/^rlv_[0-9a-f]{24}$/.test(key)) {
                return false;
            }
            const isPositive = action.endsWith('-eligible')
                || action.endsWith('-confirm');
            const context = this._partnersLateCompletionContexts?.get(key);
            if (isPositive && !context) {
                this._toast(
                    'Le contexte de contrôle du paiement tardif est incomplet. Aucune écriture financière n’a été créée.',
                    'err'
                );
                return false;
            }
            const expected = isReview
                ? `REVIEW-LATE:${key}`
                : `${isPositive ? 'CONFIRM-LATE' : 'QUARANTINE-LATE'}:${key}`;
            const confirmation = isPositive
                ? await this._partnersPrompt(
                    `Contrôlez dans Revolut Business la référence ${context.reference}, la destination masquée ${context.destination} et le montant ${context.amount} ${context.currency} en unités mineures.\n\nSaisissez ensuite exactement :\n${expected}`,
                    '',
                    (value) => value === expected,
                    'La confirmation ne correspond pas. Aucune écriture financière n’a été créée.'
                )
                : await this._partnersTypedConfirmation(expected);
            if (!confirmation) return false;
            const justification = await this._partnersJustification(
                `${isReview ? 'revue' : 'décision'} du paiement tardif ${key}`
            );
            if (!justification) return false;
            if (isReview) {
                await this._rpc(
                    'admin_partners_revolut_late_completion_review',
                    {
                        p_observation_key: key,
                        p_conclusion: isPositive
                            ? 'eligible'
                            : 'quarantine',
                        p_confirmation: confirmation,
                        p_justification: justification
                    }
                );
                return 'Revue du paiement tardif enregistrée ; un second opérateur Finance doit décider.';
            }
            await this._rpc(
                'admin_partners_revolut_late_completion_decide',
                {
                    p_review_key: key,
                    p_decision: isPositive
                        ? 'confirmed'
                        : 'quarantined',
                    p_confirmation: confirmation,
                    p_justification: justification
                }
            );
            return isPositive
                ? 'Paiement tardif confirmé et écriture de récupération créée.'
                : 'Paiement tardif maintenu en quarantaine ; le gel des versements reste actif.';
        }

        if (action === 'revolut-incident-page') {
            if (this._partnersCapabilities.finance !== true) return false;
            const offset = Number(button.dataset.partnersOffset);
            if (!Number.isSafeInteger(offset) || offset < 0) return false;
            const direction = button.dataset.partnersPageDirection === 'prev' ? 'prev' : 'next';
            this._partnersIncidentOffset = offset;
            if (this._route === 'partners') {
                await this._partnersLoadIncidents({ force: true, preserveFocus: direction });
            }
            return false;
        }

        if (action === 'revolut-incident-review') {
            if (this._partnersCapabilities.finance !== true) return false;
            const incidentKey = String(
                button.dataset.partnersIncident || ''
            );
            const resolution = String(
                button.dataset.partnersResolution || ''
            );
            const incident = this._partnersReconciliationIncidents?.get(
                incidentKey
            );
            if (!incident || incident.status === 'resolved'
                || incident.pendingReview
                || !incident.eligibleActions.includes(resolution)) {
                return false;
            }
            let targetReference = null;
            if (resolution === 'settle_exact'
                || resolution === 'release_after_return') {
                targetReference = incident.expectedReference
                    || incident.reference;
                if (!/^NORVA-[A-F0-9]{12}$/.test(targetReference)) {
                    return false;
                }
            } else if (resolution === 'remap_exact_and_settle') {
                targetReference = await this._partnersPrompt(
                    'Référence NORVA exacte de l’exécution non résolue à laquelle rattacher cette transaction :',
                    incident.expectedReference || '',
                    (value) => /^NORVA-[A-F0-9]{12}$/.test(value),
                    'La cible doit être une référence NORVA exacte.'
                );
                if (!targetReference) return false;
            } else if (resolution !== 'quarantine') {
                return false;
            }
            const justification = await this._partnersJustification(
                `revue de l’écart Revolut ${incidentKey}`
            );
            if (!justification) return false;
            const readyForEvidence = await this._confirm(
                'Effectuez maintenant la recherche exacte dans Revolut Business, exportez ou capturez sa preuve dans le registre Finance, puis sélectionnez ce fichier. Norva ne conservera que son SHA-256.',
                { okLabel: 'Choisir la preuve' }
            );
            if (!readyForEvidence) return false;
            const evidence = await this._partnersPickEvidenceHash();
            if (!evidence || !/^[0-9a-f]{64}$/.test(evidence.hash)
                || !Number.isFinite(Date.parse(evidence.observedAt))) {
                return false;
            }
            const observedAt = new Date(
                Math.floor(Date.parse(evidence.observedAt) / 1000) * 1000
            ).toISOString();
            const epoch = Math.floor(Date.parse(observedAt) / 1000);
            const targetToken = targetReference || 'NONE';
            const confirmation = [
                'REVIEW-RECON',
                incident.key,
                resolution.toUpperCase(),
                targetToken,
                incident.fingerprint,
                String(incident.amount),
                incident.currency,
                String(epoch)
            ].join(':');
            const typed = await this._partnersPrompt(
                `Conservez le fichier sélectionné dans le registre Finance ; Norva n’en transmet que le SHA-256. Cette preuve doit correspondre à la recherche Revolut que vous venez d’effectuer. Un autre opérateur devra refaire le contrôle avec une preuve différente.\n\nSaisissez exactement :\n${confirmation}`,
                '',
                (value) => value === confirmation,
                'La confirmation ne correspond pas. Aucun contrôle n’a été enregistré.'
            );
            if (!typed) return false;
            const result = await this._rpc(
                'admin_partners_revolut_reconciliation_incident_review',
                {
                    p_incident_key: incident.key,
                    p_action: resolution,
                    p_target_reference: targetReference || '',
                    p_provider_search_evidence_hash: evidence.hash,
                    p_provider_search_observed_at: observedAt,
                    p_confirmation: typed,
                    p_justification: justification
                }
            );
            const review = result?.review;
            if (result?.schema_version !== 1
                || result?.action
                    !== 'revolut_reconciliation_incident_reviewed'
                || typeof result?.replayed !== 'boolean'
                || !review
                || !/^rir_[0-9a-f]{24}$/.test(String(review.key || ''))
                || review.incident_key !== incident.key
                || review.proposed_action !== resolution
                || (review.target_reference || null)
                    !== (targetReference || null)) {
                throw new Error('invalid_reconciliation_incident_review');
            }
            return 'Contrôle 1/2 enregistré. Un autre opérateur Finance/AAL2 doit refaire une recherche indépendante et décider.';
        }

        if (action === 'revolut-incident-decide-approve'
            || action === 'revolut-incident-decide-quarantine') {
            if (this._partnersCapabilities.finance !== true) return false;
            const incidentKey = String(
                button.dataset.partnersIncident || ''
            );
            const incident = this._partnersReconciliationIncidents?.get(
                incidentKey
            );
            const review = incident?.pendingReview;
            if (!incident || incident.status === 'resolved' || !review) {
                return false;
            }
            const decision = action.endsWith('-approve')
                ? 'approved'
                : 'quarantined';
            const justification = await this._partnersJustification(
                `${decision === 'approved' ? 'approbation' : 'refus'} du contrôle Revolut ${review.key}`
            );
            if (!justification) return false;
            const readyForEvidence = await this._confirm(
                'Refaites maintenant une recherche indépendante dans Revolut Business, exportez ou capturez une nouvelle preuve dans le registre Finance, puis sélectionnez ce fichier. Elle doit être différente et plus récente que celle du premier opérateur.',
                { okLabel: 'Choisir la nouvelle preuve' }
            );
            if (!readyForEvidence) return false;
            const evidence = await this._partnersPickEvidenceHash();
            if (!evidence || !/^[0-9a-f]{64}$/.test(evidence.hash)
                || !Number.isFinite(Date.parse(evidence.observedAt))) {
                return false;
            }
            const observedAt = new Date(
                Math.floor(Date.parse(evidence.observedAt) / 1000) * 1000
            ).toISOString();
            const epoch = Math.floor(Date.parse(observedAt) / 1000);
            const confirmation = [
                'DECIDE-RECON',
                review.key,
                decision === 'approved' ? 'APPROVE' : 'QUARANTINE',
                review.proposedAction.toUpperCase(),
                review.targetReference || 'NONE',
                incident.fingerprint,
                String(incident.amount),
                incident.currency,
                String(epoch)
            ].join(':');
            const typed = await this._partnersPrompt(
                `Effectuez une nouvelle recherche indépendante dans Revolut et conservez le fichier sélectionné dans le registre Finance. Norva n’en transmet que le SHA-256.\n\nSaisissez exactement :\n${confirmation}`,
                '',
                (value) => value === confirmation,
                'La confirmation ne correspond pas. Aucune décision n’a été enregistrée.'
            );
            if (!typed) return false;
            const result = await this._rpc(
                'admin_partners_revolut_reconciliation_incident_decide',
                {
                    p_review_key: review.key,
                    p_decision: decision,
                    p_provider_search_evidence_hash: evidence.hash,
                    p_provider_search_observed_at: observedAt,
                    p_confirmation: typed,
                    p_justification: justification
                }
            );
            const resolved = result?.decision;
            const effectiveAction = decision === 'approved'
                ? review.proposedAction
                : 'quarantine';
            const expectedStatus = effectiveAction === 'quarantine'
                ? 'quarantined'
                : 'resolved';
            if (result?.schema_version !== 1
                || result?.action
                    !== 'revolut_reconciliation_incident_decided'
                || typeof result?.replayed !== 'boolean'
                || !resolved
                || !/^rid_[0-9a-f]{24}$/.test(String(resolved.key || ''))
                || resolved.incident_key !== incident.key
                || resolved.status !== expectedStatus
                || resolved.verdict !== decision
                || resolved.resolution !== effectiveAction
                || (resolved.target_reference || null)
                    !== (review.targetReference || null)) {
                throw new Error('invalid_reconciliation_incident_decision');
            }
            return decision === 'approved'
                ? 'Contrôle 2/2 approuvé. La résolution append-only autorisée a été appliquée.'
                : 'Proposition refusée et placée en quarantaine sans écriture financière ; un nouveau cycle de contrôle reste possible.';
        }

        if ([
            'revolut-reconciliation-review',
            'revolut-reconciliation-confirm',
            'revolut-reconciliation-quarantine'
        ].includes(action)) {
            if (this._partnersCapabilities.finance !== true) return false;
            if (action === 'revolut-reconciliation-review') {
                const statementRow = String(button.dataset.partnersStatementRow || '');
                if (!/^rsr_[0-9a-f]{24}$/.test(statementRow)) return false;
                const reference = String(button.dataset.partnersReference || '');
                const destination = String(button.dataset.partnersDestination || '');
                const amount = Number(button.dataset.partnersAmount);
                const currency = String(button.dataset.partnersCurrency || '');
                if (!/^NORVA-[A-F0-9]{12}$/.test(reference)
                    || destination.length < 4
                    || !Number.isSafeInteger(amount) || amount < 1
                    || !/^[A-Z]{3}$/.test(currency)) {
                    this._toast(
                        'Le contexte de contrôle du bénéficiaire est incomplet. Aucune revue n’a été enregistrée.',
                        'err'
                    );
                    return false;
                }
                const expectedReview = `REVIEW:${statementRow}`;
                const confirmation = await this._partnersPrompt(
                    `Contrôle dans Revolut Business : comparez la référence ${reference}, la destination masquée ${destination} et le montant ${amount} ${currency} en unités mineures.\n\nSaisissez ensuite exactement :\n${expectedReview}`,
                    '',
                    (value) => value === expectedReview,
                    'La confirmation ne correspond pas. Aucune revue n’a été enregistrée.'
                );
                if (!confirmation) return false;
                const justification = await this._partnersJustification(
                    `revue du rapprochement ${statementRow}`
                );
                if (!justification) return false;
                await this._rpc('admin_partners_revolut_reconciliation_review', {
                    p_statement_row_key: statementRow,
                    p_confirmation: confirmation,
                    p_justification: justification
                });
                return 'Revue Finance enregistrée. Un second opérateur Finance distinct doit maintenant décider.';
            }
            const review = String(button.dataset.partnersReview || '');
            if (!/^rmr_[0-9a-f]{24}$/.test(review)) return false;
            const operation = action === 'revolut-reconciliation-confirm'
                ? 'CONFIRM' : 'QUARANTINE';
            const expectedConfirmation = `${operation}:${review}`;
            const reference = String(button.dataset.partnersReference || '');
            const destination = String(button.dataset.partnersDestination || '');
            const amount = Number(button.dataset.partnersAmount);
            const currency = String(button.dataset.partnersCurrency || '');
            const hasVerificationContext = /^NORVA-[A-F0-9]{12}$/.test(reference)
                && destination.length >= 4
                && Number.isSafeInteger(amount) && amount > 0
                && /^[A-Z]{3}$/.test(currency);
            if (operation === 'CONFIRM' && !hasVerificationContext) {
                this._toast(
                    'Le contexte de contrôle du bénéficiaire est incomplet. Aucun règlement n’a été comptabilisé.',
                    'err'
                );
                return false;
            }
            const confirmation = operation === 'CONFIRM'
                ? await this._partnersPrompt(
                    `Contrôle final dans Revolut Business : vérifiez la référence ${reference}, la destination masquée ${destination} et le montant ${amount} ${currency} en unités mineures.\n\nSaisissez ensuite exactement :\n${expectedConfirmation}`,
                    '',
                    (value) => value === expectedConfirmation,
                    'La confirmation ne correspond pas. Aucun règlement n’a été comptabilisé.'
                )
                : await this._partnersTypedConfirmation(expectedConfirmation);
            if (!confirmation) return false;
            const justification = await this._partnersJustification(
                `${operation.toLowerCase()} du rapprochement ${review}`
            );
            if (!justification) return false;
            const decision = action === 'revolut-reconciliation-confirm'
                ? 'confirmed'
                : 'quarantined';
            await this._rpc('admin_partners_revolut_reconciliation_decide', {
                p_review_key: review,
                p_decision: decision,
                p_confirmation: confirmation,
                p_justification: justification
            });
            return decision === 'confirmed'
                ? 'Rapprochement confirmé et ledger de règlement créé.'
                : 'Rapprochement placé en quarantaine sans écriture de règlement.';
        }

        if (action === 'revolut-statement-import') {
            if (this._partnersCapabilities.finance !== true) return false;
            const file = await this._partnersPickTextFile(
                '.csv,.tsv,text/csv,text/tab-separated-values,text/plain',
                5_000_000
            );
            if (!file) return false;
            const imported = await this._partnersImportRevolutStatement(file.text);
            return `Relevé normalisé : ${AdminPage.n(imported.accepted)} ligne(s) Norva, ${AdminPage.n(imported.matched)} correspondance(s), ${AdminPage.n(imported.mismatch)} écart(s), ${AdminPage.n(imported.unmatched)} référence(s) inconnue(s), ${AdminPage.n(imported.duplicate)} doublon(s), ${AdminPage.n(imported.ignored)} ligne(s) hors Norva ignorée(s).`;
        }

        if (action === 'revolut-batch-prepare') {
            if (this._partnersCapabilities.finance !== true) return false;
            const cycleKey = String(button.dataset.partnersKey || '');
            if (!/^pay_[0-9a-f]{24}$/.test(cycleKey)) return false;
            const confirmation = await this._partnersTypedConfirmation(
                `PREPARE:${cycleKey}`
            );
            if (!confirmation) return false;
            const justification = await this._partnersJustification(
                `préparation du lot manuel ${cycleKey}`
            );
            if (!justification) return false;
            await this._rpc('admin_partners_revolut_manual_batch_prepare', {
                p_cycle_key: cycleKey,
                p_confirmation: confirmation,
                p_justification: justification
            });
            return 'Lot Revolut manuel préparé et références Norva figées.';
        }

        if (action === 'revolut-batch-export') {
            if (this._partnersCapabilities.finance !== true) return false;
            const batchKey = String(button.dataset.partnersKey || '');
            if (!/^rmb_[0-9a-f]{24}$/.test(batchKey)) return false;
            const isInitial = String(button.dataset.partnersStatus || '')
                === 'prepared';
            const confirmation = await this._partnersTypedConfirmation(
                `${isInitial ? 'EXPORT' : 'ACCESS-EXPORT'}:${batchKey}`
            );
            if (!confirmation) return false;
            const justification = await this._partnersJustification(
                `${isInitial ? 'export contrôlé' : 'accès contrôlé à l’export'} du lot ${batchKey}`
            );
            if (!justification) return false;
            const payload = await this._rpc(
                'admin_partners_revolut_manual_batch_export',
                {
                    p_batch_key: batchKey,
                    p_confirmation: confirmation,
                    p_justification: justification
                }
            );
            const validated = await this
                ._partnersValidateRevolutBatchExport(payload, batchKey);
            if (String(button.dataset.partnersStatus || '')
                === 'partially_submitted') {
                if (!validated.progressTsv) {
                    throw new Error('missing_manual_batch_progress');
                }
                this._partnersDownloadText(
                    validated.progressFileName,
                    validated.progressTsv,
                    'text/tab-separated-values;charset=utf-8'
                );
                return 'Progression Revolut vérifiée et téléchargée, sans jeton bénéficiaire.';
            }
            this._partnersDownloadText(
                validated.canonicalFileName,
                validated.canonicalTsv,
                'text/tab-separated-values;charset=utf-8'
            );
            return payload.replayed
                ? 'Export canonique réouvert et téléchargé après vérification de son empreinte.'
                : 'Lot exporté atomiquement et empreinte vérifiée. Saisissez chaque virement dans Revolut avec sa référence NORVA, puis inscrivez YES dans la dernière colonne. L’identifiant bancaire viendra uniquement du relevé.';
        }

        if (action === 'revolut-batch-submit') {
            if (this._partnersCapabilities.finance !== true) return false;
            const batchKey = String(button.dataset.partnersKey || '');
            if (!/^rmb_[0-9a-f]{24}$/.test(batchKey)) return false;
            const accessConfirmation = await this._partnersTypedConfirmation(
                `ACCESS-EXPORT:${batchKey}`
            );
            if (!accessConfirmation) return false;
            const accessJustification = await this._partnersJustification(
                `accès au lot avant enregistrement de la saisie ${batchKey}`
            );
            if (!accessJustification) return false;
            const payload = await this._rpc(
                'admin_partners_revolut_manual_batch_export',
                {
                    p_batch_key: batchKey,
                    p_confirmation: accessConfirmation,
                    p_justification: accessJustification
                }
            );
            const validated = await this
                ._partnersValidateRevolutBatchExport(payload, batchKey);
            const file = await this._partnersPickTextFile(
                '.tsv,text/tab-separated-values,text/plain',
                5_000_000
            );
            if (!file) return false;
            const transfers = this._partnersParseRevolutSubmissionTsv(
                file.text,
                validated
            );
            const confirmation = await this._partnersTypedConfirmation(
                `SUBMIT:${batchKey}`
            );
            if (!confirmation) return false;
            const justification = await this._partnersJustification(
                `confirmation de saisie Revolut du lot ${batchKey}`
            );
            if (!justification) return false;
            const result = await this._rpc(
                'admin_partners_revolut_manual_batch_mark_submitted',
                {
                p_batch_key: batchKey,
                p_transfers: transfers,
                p_confirmation: confirmation,
                p_justification: justification
                }
            );
            const resultBatch = result?.batch;
            const resultCounts = [
                resultBatch?.entered_count,
                resultBatch?.statement_matched_count,
                resultBatch?.released_count,
                resultBatch?.resolved_count,
                resultBatch?.remaining_count
            ].map(Number);
            if (result?.schema_version !== 2
                || ![
                    'revolut_manual_batch_submission_progressed',
                    'revolut_manual_batch_submitted'
                ].includes(String(result?.action || ''))
                || !resultBatch
                || resultBatch.key !== batchKey
                || resultCounts.some((value) => (
                    !Number.isSafeInteger(value) || value < 0
                ))
                || resultCounts[0] < 1
                || resultCounts[3] < resultCounts[0]
                || resultCounts[3] < resultCounts[2]
                || typeof resultBatch.completed !== 'boolean'
                || resultBatch.completed !== (resultCounts[4] === 0)) {
                throw new Error('invalid_manual_submission_response');
            }
            return resultBatch.completed === true
                ? `Saisie Revolut complète enregistrée : ${AdminPage.n(resultCounts[0])} virement(s) déclaré(s), ${AdminPage.n(resultCounts[1])} déjà rapproché(s) par relevé.`
                : `Progression enregistrée : ${AdminPage.n(resultCounts[0])} virement(s) saisi(s), ${AdminPage.n(resultCounts[1])} déjà rapproché(s), ${AdminPage.n(resultCounts[4])} restant(s).`;
        }

        if (action === 'capability') {
            if (this._partnersCanManageCapabilities !== true) return false;
            const capability = String(button.dataset.partnersCapability || '');
            const operatorKey = String(button.dataset.partnersOperatorKey || '');
            const subjectEmail = String(button.dataset.partnersOperatorEmail || 'votre compte Admin');
            if (!/^op_[0-9a-f]{64}$/.test(operatorKey)
                || !['support', 'risk', 'finance'].includes(capability)) return false;
            if (enabled) {
                const confirmed = await this._confirm(
                    `Activer la capacité ${capability} pour ${subjectEmail} ? Cette délégation est auditée et n’accorde jamais le rôle Admin à elle seule.`,
                    { okLabel: 'Activer la capacité' }
                );
                if (!confirmed) return false;
            }
            const justification = await this._partnersJustification(
                `${enabled ? 'activation' : 'retrait'} de la capacité ${capability} pour ${subjectEmail}`
            );
            if (!justification) return false;
            const result = await this._rpc('admin_partners_capability_set_by_operator_key', {
                p_operator_key: operatorKey,
                p_capability: capability,
                p_enabled: enabled,
                p_justification: justification
            });
            if (result?.schema_version !== 1
                || result?.action !== 'admin_capability_set'
                || result?.capability !== capability
                || result?.enabled !== enabled) {
                throw new Error('invalid_partners_capability_mutation_response');
            }
            return `Capacité ${capability} ${enabled ? 'activée' : 'retirée'} pour ${subjectEmail}.`;
        }

        if (action === 'release-manifest') {
            if (this._partnersCanManageRelease !== true) return false;
            const configuration = this._partnersConfiguration;
            if (![1, 2].includes(Number(configuration?.schema_version))) {
                throw new Error('partners_configuration_unavailable');
            }
            const current = Array.isArray(configuration.deployment_manifests)
                ? configuration.deployment_manifests.find((item) => (
                    item?.deployment_environment === 'preproduction'
                )) : null;
            const environment = await this._partnersPrompt(
                'Environnement exact du manifeste (preproduction ou production) :',
                'preproduction',
                (value) => ['preproduction', 'production'].includes(value),
                'Environnement invalide.'
            );
            if (!environment) return false;
            const commit = await this._partnersPrompt(
                'SHA complet du commit réellement déployé :',
                current?.source_commit_sha || '',
                (value) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value),
                'Le SHA du commit doit contenir exactement 40 ou 64 caractères hexadécimaux minuscules.'
            );
            if (!commit) return false;
            const deploymentKey = await this._partnersPrompt(
                'Clé immuable du déploiement (preuve, run ou invocation) :',
                current?.deployment_key || `${environment}-${commit.slice(0, 12)}`,
                (value) => value.length >= 3 && value.length <= 128
                    && /^[A-Za-z0-9][A-Za-z0-9._:/-]+$/.test(value),
                'Clé de déploiement invalide.'
            );
            if (!deploymentKey) return false;
            const deploymentHash = await this._partnersPrompt(
                'SHA-256 de la preuve immuable du déploiement :',
                '',
                (value) => /^[0-9a-f]{64}$/.test(value) && !/^0{64}$/.test(value),
                'Empreinte SHA-256 de déploiement invalide.'
            );
            if (!deploymentHash) return false;
            const documentHashes = await this._partnersPromptJson(
                'Associez chaque preuve documentaire à son SHA-256. deployment_proof est obligatoire. Les valeurs doivent provenir du registre privé contrôlé, jamais de texte inventé.',
                { deployment_proof: deploymentHash },
                (value) => this._partnersEvidenceHashesValid(value, ['deployment_proof']),
                'Le manifeste documentaire est invalide ou ne contient pas deployment_proof.'
            );
            if (!documentHashes) return false;
            if (documentHashes.deployment_proof !== deploymentHash) {
                this._toast('deployment_proof doit être identique à la preuve du déploiement.', 'err');
                return false;
            }
            const justification = await this._partnersJustification(
                `enregistrement du manifeste ${environment} ${commit.slice(0, 12)}`
            );
            if (!justification) return false;
            const confirmation = await this._partnersTypedConfirmation(
                `REGISTER-MANIFEST:${environment}:${commit}:${deploymentHash}`
            );
            if (!confirmation) return false;
            const result = await this._rpc(
                'admin_partners_deployment_manifest_register',
                {
                    p_deployment_environment: environment,
                    p_source_commit_sha: commit,
                    p_deployment_key: deploymentKey,
                    p_deployment_evidence_sha256: deploymentHash,
                    p_document_hashes: documentHashes,
                    p_justification: justification
                }
            );
            if (result?.schema_version !== 1
                || !['deployment_manifest_registered', 'deployment_manifest_unchanged']
                    .includes(String(result?.action || ''))
                || result?.deployment?.environment !== environment
                || result?.deployment?.source_commit_sha !== commit
                || result?.deployment?.deployment_key !== deploymentKey
                || result?.deployment?.deployment_evidence_sha256 !== deploymentHash
                || !/^[0-9a-f]{64}$/.test(String(result?.deployment?.manifest_sha256 || ''))) {
                throw new Error('invalid_partners_deployment_manifest_response');
            }
            return result.action === 'deployment_manifest_unchanged'
                ? 'Le manifeste courant était déjà enregistré à l’identique.'
                : `Manifeste ${environment} #${AdminPage.n(Number(result.deployment.manifest_version) || 0)} enregistré.`;
        }

        if (action === 'release-flag' || action === 'release-gate') {
            const key = String(button.dataset.partnersKey || '');
            if (!/^[a-z0-9_]+$/.test(key)) return false;
            const kind = action === 'release-flag' ? 'flag' : 'gate';
            if (!this._partnersCanUseReleaseControl(kind, key, enabled)) return false;
            if (action === 'release-gate' && enabled) {
                const configuration = this._partnersConfiguration;
                const manifests = Array.isArray(configuration?.deployment_manifests)
                    ? configuration.deployment_manifests : [];
                if (Number(configuration?.schema_version) !== 2 || manifests.length < 1) {
                    this._toast('Enregistrez d’abord un manifeste de déploiement courant pour l’environnement visé.', 'err');
                    return false;
                }
                const environment = await this._partnersPrompt(
                    'Environnement exact couvert : production peut autoriser le live ; preproduction sert uniquement aux preuves de readiness et à la certification Didit supervisée.',
                    manifests.some((item) => item?.deployment_environment === 'production')
                        ? 'production' : String(manifests[0]?.deployment_environment || ''),
                    (value) => manifests.some((item) => (
                        item?.deployment_environment === value
                    )),
                    'Aucun manifeste courant ne correspond à cet environnement.'
                );
                if (!environment) return false;
                const manifest = manifests.find((item) => (
                    item?.deployment_environment === environment
                ));
                const programDefault = configuration.programs.find((program) => (
                    program?.status === 'active'
                ))?.version_key || configuration.programs[0]?.version_key || '';
                const programKey = await this._partnersPrompt(
                    'Version exacte du programme approuvé :',
                    programDefault,
                    (value) => configuration.programs.some((program) => (
                        program?.version_key === value
                            && ['draft', 'active'].includes(program?.status)
                    )),
                    'Programme indisponible.'
                );
                if (!programKey) return false;
                const programPolicies = configuration.policies.filter((policy) => (
                    policy?.program_version_key === programKey
                ));
                const jurisdictions = await this._partnersPromptJson(
                    'Juridictions exactes couvertes. Le pilote France sans subdivision doit être [{"country_code":"FR","subdivision_code":null}].',
                    programPolicies.slice(0, 1).map((policy) => ({
                        country_code: policy.country_code,
                        subdivision_code: policy.subdivision_code || null
                    })),
                    (value) => Array.isArray(value) && value.length >= 1
                        && value.length <= 100
                        && value.every((scope) => {
                            if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return false;
                            const keys = Object.keys(scope);
                            return keys.includes('country_code') && keys.length <= 2
                                && /^[A-Z]{2}$/.test(String(scope.country_code || ''))
                                && (scope.subdivision_code == null
                                    || (/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(String(scope.subdivision_code))
                                        && String(scope.subdivision_code).length <= 12));
                        })
                        && new Set(value.map((scope) => (
                            `${scope.country_code}:${scope.subdivision_code || ''}`
                        ))).size === value.length,
                    'Périmètre de juridictions invalide ou dupliqué.'
                );
                if (!jurisdictions) return false;
                const required = this._partnersApprovalRequiredDocuments(key);
                if (required.length < 1) throw new Error('unknown_partners_gate_contract');
                const evidenceDefaults = Object.fromEntries(required.map((documentKey) => (
                    [documentKey, '']
                )));
                const documentHashes = await this._partnersPromptJson(
                    `Renseignez les SHA-256 des preuves requises : ${required.join(', ')}. Chaque hash doit aussi appartenir au manifeste courant.`,
                    evidenceDefaults,
                    (value) => this._partnersEvidenceHashesValid(value, required),
                    'Le package de preuves est incomplet ou invalide.'
                );
                if (!documentHashes) return false;
                const maximumValidityDays = key === 'legal_and_tax_approved'
                    ? 90
                    : 366;
                const expiresDefault = new Date(
                    Date.now() + 30 * 24 * 60 * 60 * 1000
                ).toISOString();
                const expiresAt = await this._partnersPrompt(
                    `Expiration ISO-8601 de cette approbation (maximum ${maximumValidityDays} jours) :`,
                    expiresDefault,
                    (value) => {
                        const at = Date.parse(value);
                        return Number.isFinite(at)
                            && at > Date.now() + 5 * 60 * 1000
                            && at <= Date.now()
                                + maximumValidityDays * 24 * 60 * 60 * 1000;
                    },
                    'Expiration invalide.'
                );
                if (!expiresAt) return false;
                const justification = await this._partnersJustification(
                    `approbation documentée de ${key}`
                );
                if (!justification) return false;
                const confirmation = await this._partnersTypedConfirmation(
                    `APPROVE-GATE:${key}:${programKey}:${environment}:${String(manifest.source_commit_sha || '')}`
                );
                if (!confirmation) return false;
                const result = await this._rpc(
                    'admin_partners_release_gate_approve',
                    {
                        p_gate_key: key,
                        p_program_version_key: programKey,
                        p_jurisdictions: jurisdictions,
                        p_document_hashes: documentHashes,
                        p_source_commit_sha: manifest.source_commit_sha,
                        p_deployment_environment: environment,
                        p_deployment_key: manifest.deployment_key,
                        p_deployment_evidence_sha256:
                            manifest.deployment_evidence_sha256,
                        p_expires_at: new Date(expiresAt).toISOString(),
                        p_justification: justification
                    }
                );
                if (result?.schema_version !== 1
                    || !['release_gate_approved', 'release_gate_approval_renewed']
                        .includes(String(result?.action || ''))
                    || result?.gate_key !== key
                    || result?.satisfied !== true
                    || result?.effective !== true
                    || result?.recorded_satisfied !== true
                    || !/^[0-9a-f]{64}$/.test(String(result?.approval?.package_sha256 || ''))
                    || result?.approval?.source_commit_sha !== manifest.source_commit_sha
                    || result?.approval?.deployment_environment !== environment) {
                    throw new Error('invalid_partners_release_gate_approval_response');
                }
                if (environment === 'preproduction') {
                    return `Gate ${key} prouvée pour la préproduction et la certification supervisée. L’autorité live reste fermée.`;
                }
                return result.action === 'release_gate_approval_renewed'
                    ? `Gate ${key} renouvelée en production avec un nouveau package de preuves.`
                    : `Gate ${key} approuvée en production avec un package de preuves immuable.`;
            }
            const confirmed = await this._confirm(
                `${enabled ? 'Activer' : 'Désactiver'} le ${kind} « ${key} » ? Les dépendances seront revérifiées dans la même transaction.`,
                { danger: !enabled, okLabel: enabled ? 'Activer' : 'Désactiver' }
            );
            if (!confirmed) return false;
            const justification = await this._partnersJustification(
                `${enabled ? 'activation' : 'désactivation'} de ${key}`
            );
            if (!justification) return false;
            await this._rpc('admin_partners_control', {
                p_action: action === 'release-flag' ? 'set_flag' : 'set_gate',
                p_key: key,
                p_enabled: enabled,
                p_justification: justification
            });
            return `${kind === 'flag' ? 'Flag' : 'Gate'} ${key} ${enabled ? 'activé' : 'désactivé'}.`;
        }

        if ([
            'program-create',
            'program-activate',
            'country-create',
            'kyc-policy',
            'country-availability',
            'country-map',
            'currency',
            'payout-provider',
            'allowlist'
        ].includes(action) && !this._partnersCanUseConfigurationAction(action)) {
            return false;
        }

        if (action === 'program-create') {
            const key = await this._partnersPrompt(
                'Clé version du programme (ex. individual-global-v1) :',
                'individual-global-v1',
                (value) => slug.test(value),
                'Clé de programme invalide.'
            );
            if (!key) return false;
            const thresholdsRaw = await this._partnersPrompt(
                'Seuils de versement par devise en unités mineures. Référence mondiale : 10,00 USD = {"USD":1000}. Ajoutez une valeur figée pour chaque devise de règlement autorisée ; aucune conversion implicite :',
                '{"USD":1000}',
                (value) => {
                    try {
                        const parsed = JSON.parse(value);
                        const entries = parsed && !Array.isArray(parsed) ? Object.entries(parsed) : [];
                        return entries.length > 0 && entries.length <= 32
                            && parsed.USD === 1000
                            && entries.every(([code, amount]) =>
                                currencyCode.test(code)
                                && Number.isSafeInteger(amount)
                                && amount > 0
                            );
                    } catch (_) { return false; }
                },
                'Seuils invalides : USD doit valoir exactement 1000 et chaque devise de règlement doit avoir un entier positif explicite.'
            );
            if (!thresholdsRaw) return false;
            const terms = await this._partnersPrompt(
                'Version des conditions Partners :',
                'partners-terms-global-frcash-p0-v3',
                (value) => slug.test(value),
                'Version des conditions invalide.'
            );
            if (!terms) return false;
            const disclosure = await this._partnersPrompt(
                'Version de la notice de transparence :',
                'partners-disclosure-v2',
                (value) => slug.test(value),
                'Version de notice invalide.'
            );
            if (!disclosure) return false;
            const effective = await this._partnersPrompt(
                'Date d’effet ISO 8601 :',
                new Date(Date.now() + 5 * 60 * 1000).toISOString(),
                (value) => Number.isFinite(Date.parse(value)),
                'Date d’effet invalide.'
            );
            if (!effective) return false;
            const justification = await this._partnersJustification(`création du programme ${key}`);
            if (!justification) return false;
            await this._rpc('admin_partners_program_create', {
                p_version_key: key,
                p_payout_thresholds: JSON.parse(thresholdsRaw),
                p_terms_version: terms,
                p_disclosure_version: disclosure,
                p_effective_from: new Date(effective).toISOString(),
                p_justification: justification
            });
            return `Programme ${key} créé en brouillon.`;
        }

        if (action === 'program-activate') {
            const key = String(button.dataset.partnersKey || '');
            if (!slug.test(key)) return false;
            const confirmation = await this._partnersTypedConfirmation(`ACTIVATE:${key}`);
            if (!confirmation) return false;
            const justification = await this._partnersJustification(`activation du programme ${key}`);
            if (!justification) return false;
            await this._rpc('admin_partners_program_activate', {
                p_version_key: key,
                p_confirmation: confirmation,
                p_justification: justification
            });
            return `Programme ${key} activé.`;
        }

        if (action === 'country-create') {
            const suggestedProgram = this._partnersConfiguration?.programs
                ?.find((program) => program.status === 'active')?.version_key
                || this._partnersConfiguration?.programs?.[0]?.version_key
                || 'individual-global-v1';
            const program = await this._partnersPrompt(
                'Clé du programme :',
                suggestedProgram,
                (value) => slug.test(value),
                'Clé de programme invalide.'
            );
            if (!program) return false;
            const country = await this._partnersPrompt(
                'Pays ISO alpha-2 (ex. US, GB, FR) :',
                '',
                (value) => isoCountry.test(value.toUpperCase()),
                'Code pays invalide.'
            );
            if (!country) return false;
            const subdivision = await this._partnersPrompt(
                'Subdivision ISO facultative (laisser vide pour tout le pays) :',
                '',
                (value) => {
                    const normalized = value.toUpperCase();
                    return value === '' || (
                        normalized.length <= 12
                        && /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(normalized)
                        && (
                            !normalized.includes('-')
                            || normalized.split('-', 1)[0] === country.toUpperCase()
                        )
                    );
                },
                'Subdivision invalide : 12 caractères maximum et, avec un tiret, le préfixe doit correspondre au pays.'
            );
            if (subdivision === null) return false;
            const ageRaw = await this._partnersPrompt(
                'Âge minimum légal pour cette juridiction :',
                '18',
                (value) => Number.isInteger(Number(value)) && Number(value) >= 18 && Number(value) <= 99,
                'Âge minimum invalide.'
            );
            if (!ageRaw) return false;
            const currenciesRaw = await this._partnersPrompt(
                'Devises de versement séparées par des virgules :',
                'USD',
                (value) => {
                    const values = value.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
                    return values.length > 0 && values.length <= 10
                        && values.every((code) => currencyCode.test(code))
                        && new Set(values).size === values.length;
                },
                'Liste de devises invalide : entre 1 et 10 codes ISO 4217 uniques.'
            );
            if (!currenciesRaw) return false;
            const payoutCurrencies = currenciesRaw.split(',')
                .map((item) => item.trim().toUpperCase())
                .filter(Boolean);
            const effective = await this._partnersPrompt(
                'Date d’effet ISO 8601 :',
                new Date(Date.now() + 5 * 60 * 1000).toISOString(),
                (value) => Number.isFinite(Date.parse(value)),
                'Date d’effet invalide.'
            );
            if (!effective) return false;
            const justification = await this._partnersJustification(`création de la juridiction ${country.toUpperCase()}`);
            if (!justification) return false;
            await this._rpc('admin_partners_country_policy_create', {
                p_program_version_key: program,
                p_country_code: country.toUpperCase(),
                p_subdivision_code: subdivision ? subdivision.toUpperCase() : null,
                p_minimum_age: Number(ageRaw),
                p_payout_currencies: payoutCurrencies,
                p_effective_from: new Date(effective).toISOString(),
                p_justification: justification
            });
            return `Juridiction ${country.toUpperCase()} créée, fermée par défaut.`;
        }

        if (action === 'kyc-policy') {
            const program = String(button.dataset.partnersProgram || '');
            const country = String(button.dataset.partnersCountry || '');
            const subdivision = String(button.dataset.partnersSubdivision || '');
            if (!slug.test(program) || !isoCountry.test(country)) return false;
            const maxAttempts = await this._partnersPrompt(
                'Tentatives KYC maximales dans la fenêtre :',
                '3',
                (value) => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 20,
                'Nombre de tentatives invalide.'
            );
            if (!maxAttempts) return false;
            const windowSeconds = await this._partnersPrompt(
                'Fenêtre glissante en secondes :',
                '2592000',
                (value) => Number.isInteger(Number(value)) && Number(value) >= 3600 && Number(value) <= 2592000,
                'Fenêtre KYC invalide.'
            );
            if (!windowSeconds) return false;
            const cooldownSeconds = await this._partnersPrompt(
                'Cooldown après limite, en secondes :',
                '86400',
                (value) => Number.isInteger(Number(value)) && Number(value) >= 60 && Number(value) <= 604800,
                'Cooldown invalide.'
            );
            if (!cooldownSeconds) return false;
            const justification = await this._partnersJustification(`politique KYC ${program}/${country}`);
            if (!justification) return false;
            await this._rpc('admin_partners_kyc_attempt_policy_set', {
                p_program_version_key: program,
                p_country_code: country,
                p_subdivision_code: subdivision || null,
                p_max_attempts: Number(maxAttempts),
                p_window_seconds: Number(windowSeconds),
                p_cooldown_seconds: Number(cooldownSeconds),
                p_status: 'active',
                p_justification: justification
            });
            return `Politique de tentatives KYC enregistrée pour ${country}.`;
        }

        if (action === 'country-availability') {
            const program = String(button.dataset.partnersProgram || '');
            const country = String(button.dataset.partnersCountry || '');
            const subdivision = String(button.dataset.partnersSubdivision || '');
            if (!slug.test(program) || !isoCountry.test(country)) return false;
            const confirmationValue = `${enabled ? 'ENABLE' : 'DISABLE'}:${program}:${country}:${subdivision || '*'}`;
            const confirmation = await this._partnersTypedConfirmation(confirmationValue);
            if (!confirmation) return false;
            const justification = await this._partnersJustification(
                `${enabled ? 'ouverture' : 'fermeture'} de ${country}`
            );
            if (!justification) return false;
            await this._rpc('admin_partners_country_policy_set_available', {
                p_program_version_key: program,
                p_country_code: country,
                p_subdivision_code: subdivision || null,
                p_enabled: enabled,
                p_confirmation: confirmation,
                p_justification: justification
            });
            return `Juridiction ${country} ${enabled ? 'ouverte' : 'fermée'}.`;
        }

        if (action === 'country-map') {
            const iso3 = await this._partnersPrompt(
                'Code pays ISO alpha-3 fourni par le provider :',
                '',
                (value) => /^[A-Z]{3}$/.test(value.toUpperCase()),
                'Code ISO alpha-3 invalide.'
            );
            if (!iso3) return false;
            const country = await this._partnersPrompt(
                'Code pays Norva ISO alpha-2 :',
                '',
                (value) => isoCountry.test(value.toUpperCase()),
                'Code ISO alpha-2 invalide.'
            );
            if (!country) return false;
            const justification = await this._partnersJustification(`mapping pays ${iso3.toUpperCase()}`);
            if (!justification) return false;
            await this._rpc('admin_partners_country_mapping_set', {
                p_iso3: iso3.toUpperCase(),
                p_country_code: country.toUpperCase(),
                p_status: 'active',
                p_justification: justification
            });
            return `Mapping ${iso3.toUpperCase()} → ${country.toUpperCase()} activé.`;
        }

        if (action === 'currency') {
            const currency = await this._partnersPrompt(
                'Code devise ISO 4217 :',
                'USD',
                (value) => currencyCode.test(value.toUpperCase()),
                'Code devise invalide.'
            );
            if (!currency) return false;
            const exponent = await this._partnersPrompt(
                'Nombre de décimales de la devise :',
                '2',
                (value) => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 6,
                'Exposant de devise invalide.'
            );
            if (exponent === null) return false;
            const justification = await this._partnersJustification(`configuration de ${currency.toUpperCase()}`);
            if (!justification) return false;
            await this._rpc('admin_partners_currency_set', {
                p_currency: currency.toUpperCase(),
                p_exponent: Number(exponent),
                p_status: 'active',
                p_justification: justification
            });
            return `Devise ${currency.toUpperCase()} activée.`;
        }

        if (action === 'payout-provider') {
            const country = await this._partnersPrompt(
                'Pays couvert par la route Revolut Basic manuelle (ISO alpha-2) :',
                '',
                (value) => isoCountry.test(value.toUpperCase()),
                'Code pays invalide.'
            );
            if (!country) return false;
            const currency = await this._partnersPrompt(
                'Devise couverte :',
                'USD',
                (value) => currencyCode.test(value.toUpperCase()),
                'Code devise invalide.'
            );
            if (!currency) return false;
            const operation = await this._partnersPrompt(
                'Action : ACTIVE ou DISABLED',
                'ACTIVE',
                (value) => ['ACTIVE', 'DISABLED'].includes(value.toUpperCase()),
                'État de route invalide.'
            );
            if (!operation) return false;
            const routeStatus = operation.toUpperCase() === 'ACTIVE'
                ? 'active' : 'disabled';
            const justification = await this._partnersJustification(
                `${routeStatus === 'active' ? 'activation' : 'désactivation'} de la route Revolut manuelle ${country.toUpperCase()}/${currency.toUpperCase()}`
            );
            if (!justification) return false;
            await this._rpc('admin_partners_payout_provider_set', {
                p_provider: 'revolut',
                p_country_code: country.toUpperCase(),
                p_currency: currency.toUpperCase(),
                p_status: routeStatus,
                p_justification: justification
            });
            return `Route Revolut Business Basic ${routeStatus === 'active' ? 'activée' : 'désactivée'} en mode manuel.`;
        }

        if (action === 'allowlist') {
            const subject = await this._partnersPrompt(
                'UUID Supabase du compte pilote (il ne sera pas affiché ensuite) :',
                '',
                (value) => uuid.test(value),
                'UUID utilisateur invalide.'
            );
            if (!subject) return false;
            const operation = await this._partnersPrompt(
                'Action : ENABLE ou DISABLE',
                'ENABLE',
                (value) => ['ENABLE', 'DISABLE'].includes(value.toUpperCase()),
                'Action allowlist invalide.'
            );
            if (!operation) return false;
            const country = await this._partnersPrompt(
                'Pays ISO alpha-2 facultatif :',
                '',
                (value) => value === '' || isoCountry.test(value.toUpperCase()),
                'Code pays invalide.'
            );
            if (country === null) return false;
            const subdivision = await this._partnersPrompt(
                'Subdivision facultative :',
                '',
                (value) => value === '' || /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(value.toUpperCase()),
                'Subdivision invalide.'
            );
            if (subdivision === null) return false;
            const expiry = await this._partnersPrompt(
                'Expiration ISO facultative (vide = sans expiration) :',
                '',
                (value) => value === '' || (Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now()),
                'Expiration invalide.'
            );
            if (expiry === null) return false;
            const allow = operation.toUpperCase() === 'ENABLE';
            if (allow
                ? !this._partnersHasCapabilities('risk')
                : !(this._partnersHasCapabilities('support')
                    || this._partnersHasCapabilities('risk'))) return false;
            const justification = await this._partnersJustification(
                `${allow ? 'ajout' : 'retrait'} de la liste pilote`
            );
            if (!justification) return false;
            await this._rpc('admin_partners_control', {
                p_action: 'set_allowlist',
                p_enabled: allow,
                p_justification: justification,
                p_subject_user_id: subject,
                p_country_code: country ? country.toUpperCase() : null,
                p_subdivision_code: subdivision ? subdivision.toUpperCase() : null,
                p_expires_at: expiry ? new Date(expiry).toISOString() : null
            });
            return `Compte pilote ${allow ? 'autorisé' : 'retiré'}.`;
        }

        if (action === 'account-action') {
            const account = String(button.dataset.partnersAccount || '');
            const operation = String(button.dataset.partnersOperation || '');
            if (!/^prt_[0-9a-f]{24}$/.test(account)
                || !['hold', 'release', 'suspend', 'close'].includes(operation)) return false;
            const expected = `${operation.toUpperCase()}:${account}`;
            const confirmation = await this._partnersTypedConfirmation(expected);
            if (!confirmation) return false;
            const justification = await this._partnersJustification(`${operation} du compte pseudonymisé ${account}`);
            if (!justification) return false;
            await this._rpc('admin_partners_account_action', {
                p_account_public_id: account,
                p_action: operation,
                p_confirmation: confirmation,
                p_justification: justification
            });
            return `Décision ${operation} appliquée au compte pseudonymisé.`;
        }

        if (action === 'job-retry') {
            const type = await this._partnersPrompt(
                'Type du job : commission, correction ou maturation',
                'commission',
                (value) => ['commission', 'correction', 'maturation'].includes(value.toLowerCase()),
                'Type de job invalide.'
            );
            if (!type) return false;
            const normalizedType = type.toLowerCase();
            const pattern = normalizedType === 'commission'
                ? /^job_[0-9a-f]{24}$/
                : normalizedType === 'correction'
                    ? /^crw_[0-9a-f]{24}$/
                    : /^mat_[0-9a-f]{24}$/;
            const key = await this._partnersPrompt(
                'Clé pseudonymisée du dead letter :',
                normalizedType === 'commission'
                    ? 'job_'
                    : normalizedType === 'correction' ? 'crw_' : 'mat_',
                (value) => pattern.test(value),
                'Clé de job invalide.'
            );
            if (!key) return false;
            const confirmation = await this._partnersTypedConfirmation(`RETRY:${key}`);
            if (!confirmation) return false;
            const justification = await this._partnersJustification(`retry du job ${key}`);
            if (!justification) return false;
            await this._rpc('admin_partners_job_retry', {
                p_job_key: key,
                p_job_type: normalizedType,
                p_confirmation: confirmation,
                p_justification: justification
            });
            return 'Dead letter replacé en retry.';
        }

        if (action === 'commission-reverse') {
            const key = await this._partnersPrompt(
                'Clé pseudonymisée de l’écriture à contrepasser :',
                'led_',
                (value) => /^led_[0-9a-f]{24}$/.test(value),
                'Clé d’écriture invalide.'
            );
            if (!key) return false;
            const confirmation = await this._partnersTypedConfirmation(`REVERSE:${key}`);
            if (!confirmation) return false;
            const justification = await this._partnersJustification(`contre-écriture ${key}`);
            if (!justification) return false;
            await this._rpc('admin_partners_commission_reverse', {
                p_entry_key: key,
                p_confirmation: confirmation,
                p_justification: justification
            });
            return 'Contre-écriture append-only enregistrée.';
        }

        if (action === 'payout-create') {
            const now = new Date();
            const previousStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
            const previousEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
            const dateOnly = (date) => date.toISOString().slice(0, 10);
            const start = await this._partnersPrompt(
                'Début de période (AAAA-MM-JJ) :',
                dateOnly(previousStart),
                (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)),
                'Date de début invalide.'
            );
            if (!start) return false;
            const end = await this._partnersPrompt(
                'Fin de période (AAAA-MM-JJ, antérieure à aujourd’hui) :',
                dateOnly(previousEnd),
                (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)),
                'Date de fin invalide.'
            );
            if (!end) return false;
            const currency = await this._partnersPrompt(
                'Devise du cycle :',
                'USD',
                (value) => currencyCode.test(value.toUpperCase()),
                'Devise invalide.'
            );
            if (!currency) return false;
            const mode = await this._partnersPrompt(
                'Mode : DRY pour simulation ou LIVE pour allocation réelle',
                'DRY',
                (value) => ['DRY', 'LIVE'].includes(value.toUpperCase()),
                'Mode de cycle invalide.'
            );
            if (!mode) return false;
            const normalizedMode = mode.toUpperCase();
            const expected = `CREATE:${start}:${end}:${currency.toUpperCase()}:${normalizedMode}`;
            const confirmation = await this._partnersTypedConfirmation(expected);
            if (!confirmation) return false;
            const justification = await this._partnersJustification(
                `création du cycle ${start}/${end}/${currency.toUpperCase()}/${normalizedMode}`
            );
            if (!justification) return false;
            await this._rpc('admin_partners_payout_cycle_create', {
                p_period_start: start,
                p_period_end: end,
                p_currency: currency.toUpperCase(),
                p_live_execution: normalizedMode === 'LIVE',
                p_confirmation: confirmation,
                p_justification: justification
            });
            return `Cycle ${normalizedMode === 'LIVE' ? 'live' : 'dry-run'} créé en brouillon.`;
        }

        if (action === 'payout-approve') {
            const key = String(button.dataset.partnersKey || '');
            if (!/^pay_[0-9a-f]{24}$/.test(key)) return false;
            const confirmation = await this._partnersTypedConfirmation(`APPROVE:${key}`);
            if (!confirmation) return false;
            const justification = await this._partnersJustification(`approbation du cycle ${key}`);
            if (!justification) return false;
            await this._rpc('admin_partners_payout_cycle_approve', {
                p_cycle_key: key,
                p_confirmation: confirmation,
                p_justification: justification
            });
            return 'Cycle de versement approuvé.';
        }

        if (action === 'fiscal-review-public') {
            const partnerKey = String(button.dataset.partnersPartnerKey || '');
            const country = String(button.dataset.partnersCountry || '');
            const status = String(button.dataset.partnersStatus || '');
            if (!/^prt_[0-9a-f]{24}$/.test(partnerKey) || !isoCountry.test(country)
                || !['verified', 'rejected'].includes(status)) return false;
            let provider = null;
            let reference = null;
            let form = null;
            if (status === 'verified') {
                provider = await this._partnersPrompt(
                    'Provider de vérification fiscale (aucun document brut) :',
                    'manual_review',
                    (value) => /^[a-z0-9][a-z0-9._-]{1,63}$/.test(value),
                    'Provider fiscal invalide.'
                );
                if (!provider) return false;
                reference = await this._partnersPrompt(
                    'Empreinte SHA-256 (64 caractères hexadécimaux) de la référence provider :',
                    '',
                    (value) => /^[0-9a-f]{64}$/.test(value.toLowerCase()),
                    'Empreinte provider invalide. Ne saisissez aucun identifiant fiscal brut.'
                );
                if (!reference) return false;
                form = await this._partnersPrompt(
                    'Type de formulaire fiscal facultatif (sans contenu ni identifiant) :',
                    '',
                    (value) => value.length <= 64 && !/[\u0000-\u001f\u007f]/u.test(value),
                    'Type de formulaire invalide.'
                );
                if (form === null) return false;
            }
            const justification = await this._partnersJustification(
                `${status === 'verified' ? 'validation' : 'rejet'} du profil fiscal`
            );
            if (!justification) return false;
            const result = await this._rpc('admin_partners_fiscal_review_by_public_id', {
                p_account_public_id: partnerKey,
                p_status: status,
                p_provider: provider,
                p_reference_hash: reference ? reference.toLowerCase() : null,
                p_tax_form_type: form || null,
                p_justification: justification
            });
            const keys = [
                'action', 'country_code', 'partner_key', 'schema_version', 'status'
            ];
            if (!result || typeof result !== 'object' || Array.isArray(result)
                || Object.keys(result).sort().join('|') !== keys.join('|')
                || result.schema_version !== 1
                || result.action !== 'fiscal_profile_reviewed'
                || result.partner_key !== partnerKey
                || result.country_code !== country
                || result.status !== status) {
                throw new Error('invalid_partners_fiscal_review_response');
            }
            return `Profil fiscal ${status === 'verified' ? 'validé' : 'rejeté'} sans donnée brute.`;
        }

        return false;
    }

    // ── Page: Providers ──
    async _pageProviders() {
        this._setCrumb('Sources', this._lastTs);
        const v = this._view();
        const filters = [['', 'Toutes'], ['problem', 'À traiter'], ['error', 'En erreur'], ['incomplete', 'Sync incomplète'], ['unresolved', 'Identité non résolue'], ['driver', 'Pilotes']];
        v.innerHTML = `<div class="crm-page">
            <h1 class="crm-h1">📡 Sources providers</h1>
            <p class="crm-sub">Source = playlist/compte client · identité = panel amont résolu (<a href="#" id="prov-goto-id" style="color:#a9bcff">voir Identités →</a>). Triage des sources en problème + volumétrie catalogue.</p>
            <section id="prov-kpis" class="kpi-groups"><div class="ssub">Chargement…</div></section>
            <div class="qv-row" id="prov-filters" role="tablist" aria-label="Filtres sources">
              ${filters.map(([val, lbl]) => `<button class="qv-chip" data-filter="${val}" role="tab">${lbl}</button>`).join('')}
            </div>
            <div class="src-toolbar">
              <input class="sup-search" id="prov-search" type="search" placeholder="Rechercher : provider, compte, identité, erreur…" autocomplete="off" value="${AdminPage.esc(this._provSearch || '')}" aria-label="Rechercher une source" />
              <button class="src-bulk" id="prov-bulk-resync" hidden>↻ Re-sync des erreurs</button>
            </div>
            <div id="admin-sources"><div class="ssub">Chargement…</div></div>
        </div>`;
        const goto = document.getElementById('prov-goto-id');
        if (goto) goto.addEventListener('click', (e) => { e.preventDefault(); this._navigate('identites'); });
        const search = document.getElementById('prov-search');
        if (search) search.addEventListener('input', () => { clearTimeout(this._provSearchDeb); this._provSearchDeb = setTimeout(() => { this._provSearch = search.value.trim(); this._renderSources(this._sources || []); }, 200); });
        document.querySelectorAll('#prov-filters .qv-chip').forEach(chip => chip.addEventListener('click', () => {
            this._provFilter = chip.dataset.filter || ''; this._syncProvFilters(); this._renderSources(this._sources || []);
        }));
        this._syncProvFilters();
        const bulk = document.getElementById('prov-bulk-resync');
        if (bulk) bulk.addEventListener('click', () => this._resyncAllErrors(bulk));
        try {
            const [sources, ov, sparks] = await Promise.all([
                this._rpc('admin_sources'),
                this._rpc('admin_overview'),
                this._rpc('admin_metric_sparks', { p_days: 14 }).catch(() => null) // sparklines non-critical
            ]);
            this._sources = Array.isArray(sources) ? sources : [];
            this._dressHeader();
            this._renderProvKpis(ov || {}, this._sources, sparks && sparks.series);
            this._renderSources(this._sources);
        } catch (e) {
            const el = document.getElementById('admin-sources');
            if (el) el.innerHTML = `<div class="admin-err" role="alert">Erreur : ${AdminPage.esc(e.message)}</div>`;
        }
    }

    _syncProvFilters() {
        const cur = this._provFilter || '';
        document.querySelectorAll('#prov-filters .qv-chip').forEach(c => c.classList.toggle('active', (c.dataset.filter || '') === cur));
    }

    async _resyncAllErrors(btn) {
        const errs = (this._sources || []).filter(s => s.sync_error || s.sync_status === 'sync_error');
        if (!errs.length) return;
        if (!await this._confirm(`Relancer un re-sync complet sur ${errs.length} source(s) en erreur ?`, { okLabel: 'Tout re-sync' })) return;
        const orig = btn.textContent; btn.disabled = true; btn.textContent = '…';
        let ok = 0;
        for (const s of errs) {
            try {
                const res = await fetch(`${this._sbUrl()}/functions/v1/norva-source-sync/admin/resync/${s.source_id}`, { method: 'POST', headers: { apikey: this._sbKey(), Authorization: `Bearer ${this._token()}`, 'Content-Type': 'application/json' }, body: '{}' });
                if (res.ok) ok++;
            } catch (_) { /* keep going — partial success is fine */ }
        }
        btn.textContent = `✓ ${ok}/${errs.length}`;
        this._toast(`Re-sync lancé sur ${ok}/${errs.length} source(s).`, ok === errs.length ? 'ok' : 'err');
        setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 4000);
    }

    _renderProvKpis(o, sources, sparks) {
        const el = document.getElementById('prov-kpis');
        if (!el) return;
        const S = sparks || {}, n = AdminPage.n;
        sources = Array.isArray(sources) ? sources : [];
        const total = sources.length;
        const err = sources.filter(s => s.sync_error || s.sync_status === 'sync_error').length;
        const inc = sources.filter(s => s.incomplete === true).length;
        const unres = sources.filter(s => !s.identity_name).length;
        const pct = total ? Math.round(100 * Math.max(0, total - err - inc) / total) : 100;
        const healthCls = err > 0 ? 'alert' : inc > 0 ? 'warn' : 'ok';
        const catalog = (Number(o.titles_movie) || 0) + (Number(o.titles_series) || 0);
        const card = (v, l, cls, key, icon) => {
            const spark = key && Array.isArray(S[key]) ? AdminPage.spark(S[key], cls === 'warn' ? '' : cls) : '';
            return `<div class="kpi ${cls || ''}"><div class="kpi-hd"><div class="v">${v}</div><span class="kpi-ic">${icon}</span></div><div class="l">${l}</div>${spark ? `<div class="kpi-spark">${spark}</div>` : ''}</div>`;
        };
        el.innerHTML = `<div class="kpi-group kpi-group--priority"><div class="kpi-gtitle">🩺 Santé des sources</div><div class="admin-cards">
            ${card(pct + ' %', 'Sources saines', healthCls, null, '🩺')}
            ${card(n(err), 'En erreur', err > 0 ? 'alert' : 'ok', 'sources_error', '⚠️')}
            ${card(n(inc), 'Sync incomplète', inc > 0 ? 'warn' : 'ok', 'sources_incomplete', '🔄')}
            ${card(n(unres), 'Identité non résolue', unres > 0 ? 'warn' : 'ok', null, '🧬')}
            ${card(n(total), 'Sources', '', 'sources_total', '🗂️')}
            ${card(n(catalog), 'Catalogue (titres)', '', null, '🎬')}
        </div></div>`;
        const tx = document.querySelector('#page-admin .crm-head-tx');
        if (tx) {
            let meta = tx.querySelector('.crm-head-meta');
            if (!meta) { meta = document.createElement('div'); meta.className = 'crm-head-meta'; tx.appendChild(meta); }
            meta.innerHTML =
                `<span class="crm-hpill"><b>${n(total)}</b> sources</span>` +
                `<span class="crm-hpill ${err > 0 ? 'bad' : ''}"><b>${n(err)}</b> en erreur</span>` +
                `<span class="crm-hpill"><b>${n(inc)}</b> sync incomplète(s)</span>` +
                `<span class="crm-hpill"><b>${n(o.identities_active)}</b> identités</span>`;
        }
    }

    // ── Page: Identités (canonical provider identities) ──
    async _pageIdentites() {
        this._setCrumb('Identités');
        const v = this._view();
        const filters = [['', 'Toutes'], ['mirror', 'Miroirs'], ['active', 'Actives'], ['multi', 'Multi-sources'], ['driver', 'Pilotes'], ['dormant', 'Dormantes 30 j']];
        v.innerHTML = `<div class="crm-page">
            <h1 class="crm-h1">🧬 Identités fournisseurs</h1>
            <p class="crm-sub">Une identité = un panel amont réel (dédup par empreinte de stream IDs). Plusieurs marques sur une même identité = revente miroir — le cache cross-user les fusionne.</p>
            <section id="id-kpis" class="kpi-groups"><div class="ssub">Chargement…</div></section>
            <div class="id-legend">
              <span class="lgd">🧬 <b>Identité</b> = panel amont réel</span>
              <span class="lgd">🏷️ <b>Marque</b> = revendeur détecté</span>
              <span class="lgd">📡 <b>Source</b> = playlist d'un client</span>
              <span class="lgd">🔁 <b>Miroir</b> = plusieurs marques → même panel</span>
            </div>
            <div class="qv-row" id="id-filters" role="tablist" aria-label="Filtres identités">
              ${filters.map(([val, lbl]) => `<button class="qv-chip" data-filter="${val}" role="tab">${lbl}</button>`).join('')}
            </div>
            <div class="src-toolbar">
              <input class="sup-search" id="id-search" type="search" placeholder="Rechercher : identité, marque, compte, source…" autocomplete="off" value="${AdminPage.esc(this._idSearch || '')}" aria-label="Rechercher une identité" />
            </div>
            <div id="admin-identities"><div class="ssub">Chargement…</div></div>
        </div>`;
        const search = document.getElementById('id-search');
        if (search) search.addEventListener('input', () => { clearTimeout(this._idSearchDeb); this._idSearchDeb = setTimeout(() => { this._idSearch = search.value.trim(); this._renderIdentities(this._identities || []); }, 200); });
        document.querySelectorAll('#id-filters .qv-chip').forEach(chip => chip.addEventListener('click', () => {
            this._idFilter = chip.dataset.filter || ''; this._syncIdFilters(); this._renderIdentities(this._identities || []);
        }));
        this._syncIdFilters();
        try {
            const ids = await this._rpc('admin_identities');
            this._identities = Array.isArray(ids) ? ids : [];
            this._dressHeader();
            this._renderIdentities(this._identities);
        } catch (e) {
            const el = document.getElementById('admin-identities');
            if (el) el.innerHTML = `<div class="admin-err" role="alert">Erreur : ${AdminPage.esc(e.message)}</div>`;
        }
    }

    _syncIdFilters() {
        const cur = this._idFilter || '';
        document.querySelectorAll('#id-filters .qv-chip').forEach(c => c.classList.toggle('active', (c.dataset.filter || '') === cur));
    }

    _renderIdentities(list) {
        const el = document.getElementById('admin-identities');
        if (!el) return;
        list = Array.isArray(list) ? list : [];
        const n = AdminPage.n, esc = AdminPage.esc;
        const now = Date.now(), D30 = 30 * 864e5;
        const brandsOf = (it) => Array.isArray(it.brands) ? it.brands : [];
        const sourcesOf = (it) => Array.isArray(it.sources) ? it.sources : [];
        const isMirror = (it) => brandsOf(it).length > 1;
        const isDormant = (it) => !it.last_seen || (now - new Date(it.last_seen).getTime()) > D30;
        const acctsOf = (it) => new Set(sourcesOf(it).map(s => s.user_id).filter(Boolean)).size;

        // ── Synthesis KPIs (computed from the live list) + header status line ──
        const kel = document.getElementById('id-kpis');
        if (kel) {
            const total = list.length;
            const active = list.filter(it => it.status === 'active').length;
            const mirrors = list.filter(isMirror).length;
            const srcTotal = list.reduce((a, it) => a + sourcesOf(it).length, 0);
            const brandTotal = list.reduce((a, it) => a + brandsOf(it).length, 0);
            const dormant = list.filter(isDormant).length;
            const card = (v, l, cls, icon) => `<div class="kpi ${cls || ''}"><div class="kpi-hd"><div class="v">${v}</div><span class="kpi-ic">${icon}</span></div><div class="l">${l}</div></div>`;
            kel.innerHTML = `<div class="kpi-group kpi-group--priority"><div class="kpi-gtitle">🧬 Graphe providers</div><div class="admin-cards">
                ${card(n(active), 'Identités actives', active > 0 ? 'ok' : '', '🧬')}
                ${card(n(mirrors), 'Miroirs multi-marques', mirrors > 0 ? 'warn' : 'ok', '🔁')}
                ${card(n(srcTotal), 'Sources rattachées', '', '📡')}
                ${card(n(brandTotal), 'Marques détectées', '', '🏷️')}
                ${card(n(dormant), 'Dormantes 30 j', dormant > 0 ? 'warn' : 'ok', '💤')}
                ${card(n(total), 'Identités', '', '🗂️')}
            </div></div>`;
            const tx = document.querySelector('#page-admin .crm-head-tx');
            if (tx) {
                let meta = tx.querySelector('.crm-head-meta');
                if (!meta) { meta = document.createElement('div'); meta.className = 'crm-head-meta'; tx.appendChild(meta); }
                meta.innerHTML =
                    `<span class="crm-hpill"><b>${n(active)}</b> actives</span>` +
                    `<span class="crm-hpill ${mirrors > 0 ? 'bad' : ''}"><b>${n(mirrors)}</b> miroirs</span>` +
                    `<span class="crm-hpill"><b>${n(srcTotal)}</b> sources</span>` +
                    `<span class="crm-hpill"><b>${n(brandTotal)}</b> marques</span>`;
            }
        }

        // ── Filter + search + mirror-first priority sort ──
        const f = this._idFilter || '';
        let view = list.filter(it => {
            if (f === 'mirror') return isMirror(it);
            if (f === 'active') return it.status === 'active';
            if (f === 'multi') return sourcesOf(it).length > 1;
            if (f === 'driver') return sourcesOf(it).some(s => s.is_driver);
            if (f === 'dormant') return isDormant(it);
            return true;
        });
        const q = (this._idSearch || '').toLowerCase();
        if (q) view = view.filter(it => {
            if (String(it.display_name || '').toLowerCase().includes(q)) return true;
            if (brandsOf(it).some(b => String(b || '').toLowerCase().includes(q))) return true;
            return sourcesOf(it).some(s => String(s.owner_email || '').toLowerCase().includes(q) || String(s.display_name || '').toLowerCase().includes(q));
        });
        // Priority: mirrors first, then most recent activity, then most sources.
        view = view.slice().sort((a, b) =>
            (isMirror(b) - isMirror(a)) ||
            (new Date(b.last_seen || 0).getTime() - new Date(a.last_seen || 0).getTime()) ||
            (sourcesOf(b).length - sourcesOf(a).length));

        if (!view.length) {
            el.innerHTML = `<div class="card"><span class="badge ${q || f ? 'gray' : 'green'}">${q || f ? '∅' : '✓'}</span> ${q || f ? 'Aucune identité ne correspond à ce filtre.' : 'Aucune identité résolue.'}</div>`;
            return;
        }

        el.innerHTML = view.map((it, idx) => {
            const brands = brandsOf(it), sources = sourcesOf(it);
            const dormant = isDormant(it);
            const status = it.status === 'active' ? '<span class="badge green">active</span>' : `<span class="badge gray">${esc(it.status || '—')}</span>`;
            const mirror = isMirror(it) ? ' <span class="badge amber" title="Plusieurs marques revendues pointent vers le même panel amont">🔁 miroir multi-marques</span>' : '';
            const brandChips = brands.map(b => `<span class="badge blue">${esc(b)}</span>`).join(' ');
            // Sources: compact rows; collapse beyond 5.
            const srcRow = (s) => {
                const cl = s.user_id ? ` class="user-row" data-user-id="${esc(s.user_id)}" tabindex="0" aria-label="Voir la fiche de ${esc(s.owner_email || s.display_name || '')}" title="Voir la fiche client"` : '';
                return `<tr${cl}>
                    <td>${esc(s.display_name)}</td>
                    <td><span class="pacct">${esc(s.owner_email || '—')}</span>${s.is_driver ? ' <span class="badge blue">pilote</span>' : ''}</td>
                    <td>${s.sync_status === 'ready' ? '<span class="badge green">ready</span>' : `<span class="badge gray">${esc(s.sync_status || '—')}</span>`}</td>
                    <td>${s.last_synced_at ? esc(AdminPage.timeAgo(s.last_synced_at)) : '—'}</td>
                </tr>`;
            };
            let srcTable;
            if (!sources.length) srcTable = '<div class="ssub">Aucune source ne porte cette identité.</div>';
            else {
                const head = '<thead><tr><th>Source</th><th>Compte</th><th>Statut</th><th>Dernier sync</th></tr></thead>';
                const shown = sources.slice(0, 5).map(srcRow).join('');
                const hidden = sources.slice(5).map(srcRow).join('');
                srcTable = `<div class="scroll"><table>${head}<tbody>${shown}${hidden ? `<tbody class="id-more" hidden data-idx="${idx}">${hidden}</tbody>` : ''}</table></div>` +
                    (hidden ? `<button class="id-actbtn id-more-btn" data-idx="${idx}" style="margin-top:8px">▾ Voir les ${n(sources.length - 5)} autres sources</button>` : '');
            }
            return `<div class="identity-card ${isMirror(it) ? 'mirror' : ''} ${dormant ? 'dormant' : ''}">
                <div class="identity-head">
                    <div class="id-ic">${AdminPage.provIcon(it.display_name)}</div>
                    <div class="identity-main">
                        <div class="identity-name">${esc(it.display_name)} ${status}${mirror}${dormant ? ' <span class="badge gray" title="Aucune activité depuis 30 j+">💤 dormante</span>' : ''}</div>
                        <div class="identity-stats"><b>${n(brands.length)}</b> marque(s) · <b>${n(sources.length)}</b> source(s) · <b>${n(acctsOf(it))}</b> compte(s) · <b>${n(it.key_count)}</b> clé(s) · actif ${it.last_seen ? esc(AdminPage.timeAgo(it.last_seen)) : '—'}</div>
                        ${brandChips ? `<div class="identity-brands">${brandChips}</div>` : ''}
                        <div class="identity-acts">
                            ${sources.length ? `<button class="id-actbtn id-filter-src" data-name="${esc(it.display_name)}">📡 Voir les sources</button>` : ''}
                            ${it.id ? `<button class="id-actbtn id-copy" data-id="${esc(it.id)}">⧉ Copier l'ID</button>` : ''}
                        </div>
                    </div>
                </div>
                ${srcTable}
            </div>`;
        }).join('');

        // Wire: expand sources, filter Sources on this identity, copy identity id.
        el.querySelectorAll('.id-more-btn').forEach(b => b.addEventListener('click', () => {
            const tb = el.querySelector(`tbody.id-more[data-idx="${b.dataset.idx}"]`);
            if (tb) { tb.hidden = false; b.remove(); }
        }));
        el.querySelectorAll('.id-filter-src').forEach(b => b.addEventListener('click', () => {
            this._provSearch = b.dataset.name || ''; this._provFilter = '';
            this._navigate('providers');
        }));
        el.querySelectorAll('.id-copy').forEach(b => b.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(b.dataset.id); this._toast('ID identité copié.', 'ok'); }
            catch (_) { this._toast('Copie impossible.', 'err'); }
        }));
    }

    // ── Page: Moteur (enrichment + crons) ──
    // Normalize the exact-file fleet RPC into the historical table shape. This keeps the renderers
    // small while preserving a strict marker: only rows carrying __engine_health_v1 may ever be
    // classified blocked/stalled. A missing RPC must degrade to "unknown", never manufacture an
    // outage from the obsolete cloud_titles.audio_probed_at counter.
    static normalizeEngineHealth(payload) {
        const available = !!payload && typeof payload === 'object'
            && Number(payload.schema_version) >= 1 && Array.isArray(payload.rows);
        if (!available) {
            return { available: false, schema_version: 0, flags: {}, scheduler: {}, summary: {}, rows: [] };
        }
        const rows = payload.rows.map(raw => {
            const r = raw && typeof raw === 'object' ? raw : {};
            const known = Math.max(0, Number(r.known_files) || 0);
            const never = Math.max(0, Number(r.never_probed_files) || 0);
            const rawProbed = Number(r.probed_files);
            const probed = Math.max(0, Number.isFinite(rawProbed)
                ? rawProbed
                : known - never);
            const recent = Math.max(0, Number(r.probed_files_24h) || 0);
            return {
                ...r,
                total: Math.max(0, Number(r.catalog_titles) || 0),
                resolved: Math.max(0, Number(r.resolved_titles) || 0),
                known_files: known,
                probed_files: probed,
                probed_pct: known ? Math.round(1000 * probed / known) / 10 : 0,
                never_probed: never,
                probed_24h: recent,
                resolved_24h: Math.max(0, Number(r.verified_files_24h) || 0),
                subtitle_found: Math.max(0, Number(r.subtitle_titles) || 0),
                eta_days: recent > 0 ? Math.ceil(never / recent) : null,
                __engine_health_v1: true
            };
        });
        return {
            available: true,
            schema_version: Number(payload.schema_version),
            generated_at: payload.generated_at || null,
            window_hours: Number(payload.window_hours) || 24,
            flags: payload.flags || {},
            scheduler: payload.scheduler || {},
            summary: payload.summary || {},
            rows
        };
    }

    // Canonical UI state. The server owns every detailed classification. Legacy coverage is still
    // rendered when the new RPC is unavailable, but it can never prove exact progress/completion.
    static engineState(r, healthAvailable = r?.__engine_health_v1 === true) {
        const canonical = !!r && healthAvailable === true;
        const allowed = new Set(['active', 'running', 'idle', 'complete', 'paused', 'blocked',
            'retry_wait', 'stalled', 'disabled', 'not_scheduled']);
        if (canonical) {
            const rawState = String(r.state || '').trim().toLowerCase().replace(/-/g, '_');
            return {
                kind: allowed.has(rawState) ? rawState : 'unknown',
                reason: String(r.reason || '').trim().toLowerCase().replace(/-/g, '_') || 'unknown',
                canonical: true
            };
        }
        if (Number(r?.probed_24h) > 0) {
            return { kind: 'active', reason: 'legacy_progressing', canonical: false };
        }
        return { kind: 'unknown', reason: 'legacy_unmeasured', canonical: false };
    }

    static engineReasonLabel(reason) {
        const labels = {
            progressing: 'progression confirmée',
            lease_active: 'traitement en cours',
            no_recent_probe: 'aucun fichier récent à traiter',
            complete: 'première passe terminée',
            exhausted: 'file de travail drainée',
            no_known_files: 'inventaire de fichiers en attente',
            enrichment_paused: 'pause globale demandée',
            episode_audio_scan_disabled: 'scan audio des épisodes désactivé',
            live_session: 'lecture utilisateur prioritaire',
            pregen_active: 'prégénération prioritaire',
            provider_account_busy: 'compte provider occupé',
            provider_background_busy: 'provider occupé par une autre tâche',
            footprint_budget: 'quota anti-ban atteint',
            rate_limited: 'rate-limit provider',
            circuit_open: 'circuit ouvert',
            authentication: 'authentification refusée',
            forbidden: 'accès provider interdit',
            worker_error: 'erreur du worker',
            retry_scheduled: 'nouvel essai planifié',
            queue_overdue: 'file de travail en retard',
            source_disabled: 'source désactivée',
            source_not_ready: 'source non prête',
            schedule_missing: 'planification absente',
            legacy_progressing: 'progression historique observée',
            legacy_unmeasured: 'état inconnu (legacy)',
            unknown: 'raison inconnue'
        };
        return labels[reason] || String(reason || 'raison inconnue').replace(/_/g, ' ');
    }

    static engineStateView(r) {
        const s = AdminPage.engineState(r);
        const stateLabels = {
            active: '▶ progression',
            running: '● en cours',
            idle: 'veille',
            complete: '✓ complet',
            paused: '⏸ pause',
            blocked: '⛔ bloqué',
            retry_wait: '⏳ nouvel essai',
            stalled: '⛔ bloqué',
            disabled: 'désactivé',
            not_scheduled: 'non planifié',
            unknown: '? état inconnu'
        };
        const badge = ['active', 'complete'].includes(s.kind) ? 'green'
            : s.kind === 'running' ? 'blue'
                : s.kind === 'retry_wait' ? 'amber'
                    : ['blocked', 'stalled', 'not_scheduled'].includes(s.kind) ? 'red' : 'gray';
        const incidentReasons = new Set(['rate_limited', 'circuit_open', 'authentication',
            'forbidden', 'worker_error']);
        const infoReasons = new Set(['live_session', 'pregen_active', 'provider_account_busy',
            'provider_background_busy', 'footprint_budget']);
        return {
            ...s,
            label: s.kind === 'unknown' && !s.canonical
                ? '? état inconnu (legacy)'
                : (stateLabels[s.kind] || stateLabels.unknown),
            reasonLabel: AdminPage.engineReasonLabel(s.reason),
            badge,
            actionable: ['blocked', 'stalled', 'not_scheduled'].includes(s.kind) || incidentReasons.has(s.reason),
            informational: infoReasons.has(s.reason)
        };
    }

    // Dynamic-fleet scheduler diagnostics can be newer than admin_cron_health. Return only
    // scheduler incidents not already represented by a failing legacy cron row.
    static engineSchedulerIssues(engineHealth, cronRows = []) {
        if (engineHealth?.available !== true) return [];
        const raw = engineHealth.scheduler;
        const schedulers = Array.isArray(raw)
            ? raw
            : raw && typeof raw === 'object' && Object.keys(raw).length ? [raw] : [];
        const legacyFailures = new Set((Array.isArray(cronRows) ? cronRows : [])
            .filter(r => Number(r.fails_24h) > 0 && String(r.last_status).toLowerCase() === 'failed')
            .map(r => String(r.jobname || '')));
        return schedulers.flatMap((scheduler, index) => {
            const jobname = String(scheduler?.jobname || `flotte dynamique ${index + 1}`);
            const issue = scheduler?.present === false ? 'schedule_missing'
                : scheduler?.active === false ? 'schedule_disabled'
                    : String(scheduler?.last_status || '').toLowerCase() === 'failed' ? 'schedule_failed'
                        : null;
            if (!issue || legacyFailures.has(jobname)) return [];
            return [{ ...scheduler, jobname, issue }];
        });
    }

    _enrichKind(r) { return AdminPage.engineState(r).kind; }

    async _pageMoteur() {
        this._setCrumb('Moteur', this._lastTs);
        const v = this._view();
        const filters = [['', 'Tout'], ['problem', 'À traiter'], ['progress', 'En cours'],
            ['waiting', 'En attente'], ['paused', 'En pause'], ['unknown', 'Inconnu'],
            ['low', 'Sondage < 60 %']];
        v.innerHTML = `<div class="crm-page">
            <h1 class="crm-h1">⚙️ Moteur d'enrichissement</h1>
            <p class="crm-sub">Couverture / sondage audio par panel · matching catalogue TMDB · orchestration des crons jour/nuit.</p>
            <section id="mot-health" class="kpi-groups"><div class="ssub">Chargement…</div></section>
            <div id="mot-incidents"></div>
            <div class="admin-block"><h2>📊 Enrichissement par panel</h2>
                <div class="qv-row" id="mot-filters" role="tablist" aria-label="Filtres enrichissement">
                  ${filters.map(([val, lbl]) => `<button class="qv-chip" data-filter="${val}" role="tab">${lbl}</button>`).join('')}
                </div>
                <div class="scroll"><div id="admin-enrich"><div class="ssub">Chargement…</div></div></div>
                <div class="mot-legend">
                  <span><b>Jamais sondé</b> = fichiers exacts sans analyse</span>
                  <span><b>Sondés / vérifiés 24h</b> = progression exacte de la flotte</span>
                  <span><b>Bloqué</b> = verdict serveur explicite, jamais déduit d'un compteur nul</span>
                  <span><b>En attente</b> = lecture, quota, rate-limit ou nouvel essai planifié</span>
                </div>
            </div>
            <div class="mot-cols">
                <div class="admin-block"><h2>🎯 Matching TMDB</h2><div class="ssub" style="margin-bottom:0">Backlogs drainés par les crons nocturnes (backfill-years 1000/j · search-match 3 600/j · revalidate 2 000/j) — ces compteurs doivent baisser de jour en jour.</div><section id="admin-tmdb" class="mot-tmdb"><div class="ssub">Chargement…</div></section></div>
                <div class="admin-block"><h2>⏱️ Crons</h2><div id="mot-cron-sum"></div><div class="scroll"><div id="admin-cron"><div class="ssub">Chargement…</div></div></div></div>
            </div>
        </div>`;
        document.querySelectorAll('#mot-filters .qv-chip').forEach(chip => chip.addEventListener('click', () => {
            this._motFilter = chip.dataset.filter || ''; this._syncMotFilters(); this._renderEnrich(this._enrich || []);
        }));
        this._syncMotFilters();
        // Independent section loads: a failure in one section must not blank the others.
        const [enrichR, cronR, ovR, engineR] = await Promise.allSettled([
            this._rpc('admin_enrichment_coverage'),
            this._rpc('admin_cron_health'),
            this._rpc('admin_overview'),
            this._rpc('admin_enrichment_engine_health')
        ]);
        const engineHealth = AdminPage.normalizeEngineHealth(
            engineR.status === 'fulfilled' ? engineR.value : null
        );
        const legacyEnrich = enrichR.status === 'fulfilled' && Array.isArray(enrichR.value) ? enrichR.value : [];
        const enrich = engineHealth.available ? engineHealth.rows : legacyEnrich;
        const cron = cronR.status === 'fulfilled' && Array.isArray(cronR.value) ? cronR.value : [];
        const ov = ovR.status === 'fulfilled' ? (ovR.value || {}) : {};
        this._enrich = enrich;
        this._engineHealth = engineHealth;
        this._dressHeader();
        const secErr = (id, r) => { const e = document.getElementById(id); if (e && r.status === 'rejected') { e.innerHTML = `<div class="admin-err" role="alert">Erreur : ${AdminPage.esc((r.reason && r.reason.message) || 'chargement')}</div>`; return true; } return false; };
        this._renderEngineHealth(enrich, cron, ov, engineHealth);
        this._renderIncidents(enrich, cron, engineHealth);
        if (engineHealth.available || !secErr('admin-enrich', enrichR)) this._renderEnrich(enrich);
        if (!secErr('admin-cron', cronR)) this._renderCron(cron);
        if (!secErr('admin-tmdb', ovR)) this._renderTmdb(ov);
    }

    _syncMotFilters() {
        const cur = this._motFilter || '';
        document.querySelectorAll('#mot-filters .qv-chip').forEach(c => c.classList.toggle('active', (c.dataset.filter || '') === cur));
    }

    // Fleet health and pg_cron transport health are deliberately separate signals.
    _renderEngineHealth(enrich, cron, ov, engineHealth) {
        const el = document.getElementById('mot-health');
        if (!el) return;
        const n = AdminPage.n;
        const exact = engineHealth?.available === true;
        const totalTitles = enrich.reduce((a, r) => a + (Number(r.total) || 0), 0);
        const resolvedTitles = enrich.reduce((a, r) => a + (Number(r.resolved) || 0), 0);
        const knownFiles = enrich.reduce((a, r) => a + (Number(r.known_files) || 0), 0);
        const probedFiles = enrich.reduce((a, r) => a + (Number(r.probed_files) || 0), 0);
        const coverage = exact
            ? (knownFiles ? Math.round(100 * probedFiles / knownFiles) : 0)
            : (totalTitles ? Math.round(100 * resolvedTitles / totalTitles) : 0);
        const neverProbed = enrich.reduce((a, r) => a + (Number(r.never_probed) || 0), 0);
        const stFound = enrich.reduce((a, r) => a + (Number(r.subtitle_found) || 0), 0);
        // Only canonical server states may increment this counter. Legacy zeros remain unknown.
        const fleetBlocked = enrich.filter(r => r.__engine_health_v1 === true
            && ['blocked', 'stalled'].includes(this._enrichKind(r))).length;
        const progressing = enrich.filter(r => ['active', 'running'].includes(this._enrichKind(r))).length;
        // KO = le DERNIER run est encore en échec ; échec suivi d'un run OK = récupéré (info, pas alerte).
        const cronKoNames = new Set(cron
            .filter(c => Number(c.fails_24h) > 0 && String(c.last_status).toLowerCase() === 'failed')
            .map(c => String(c.jobname || '')));
        AdminPage.engineSchedulerIssues(engineHealth, cron).forEach(s => cronKoNames.add(s.jobname));
        const cronKo = cronKoNames.size;
        const cronRec = cron.filter(c => Number(c.fails_24h) > 0 && String(c.last_status) !== 'failed').length;
        const covCls = coverage >= 90 ? 'ok' : coverage >= 60 ? 'warn' : 'alert';
        const tmdbBacklog = (Number(ov.tmdb_year_backlog) || 0) + (Number(ov.tmdb_unmatched) || 0) + (Number(ov.tmdb_unverified) || 0);
        const card = (v, l, cls, icon, title = '') => `<div class="kpi ${cls || ''}"${title ? ` title="${AdminPage.esc(title)}"` : ''}><div class="kpi-hd"><div class="v">${v}</div><span class="kpi-ic">${icon}</span></div><div class="l">${l}</div></div>`;
        const coverageDetail = exact
            ? `${n(probedFiles)} sondés sur ${n(knownFiles)} fichiers exacts connus. L'ancien indicateur portait sur des titres groupés et n'est pas comparable.`
            : 'Ancien indicateur par titres groupés ; ne mesure pas la file exacte.';
        el.innerHTML = `<div class="kpi-group kpi-group--priority"><div class="kpi-gtitle">🩺 Santé moteur</div><div class="admin-cards">
            ${card(coverage + ' %', exact ? 'Fichiers exacts sondés' : 'Couverture audio (legacy)', covCls, '🔊', coverageDetail)}
            ${card(n(fleetBlocked), 'Flotte bloquée', fleetBlocked > 0 ? 'alert' : 'ok', '⛔')}
            ${card(exact ? n(progressing) : '—', exact ? 'Lignes en progression' : 'Progression exacte indisponible', exact && progressing > 0 ? 'ok' : '', '▶️')}
            ${card(exact ? n(neverProbed) : '—', exact ? 'Fichiers jamais sondés' : 'File exacte indisponible', '', '🗄️')}
            ${card(n(stFound), 'Sous-titres trouvés', '', '💬')}
            ${card(n(cronKo), 'pg_cron KO', cronKo > 0 ? 'alert' : 'ok', '⏱️')}
        </div></div>`;
        const tx = document.querySelector('#page-admin .crm-head-tx');
        if (tx) {
            let meta = tx.querySelector('.crm-head-meta');
            if (!meta) { meta = document.createElement('div'); meta.className = 'crm-head-meta'; tx.appendChild(meta); }
            meta.innerHTML =
                `<span class="crm-hpill ${covCls === 'alert' ? 'bad' : ''}" title="${AdminPage.esc(coverageDetail)}"><b>${coverage} %</b> ${exact ? 'fichiers exacts' : 'audio legacy'}</span>` +
                `<span class="crm-hpill ${fleetBlocked > 0 ? 'bad' : ''}"><b>${n(fleetBlocked)}</b> flotte bloquée</span>` +
                `<span class="crm-hpill ${cronKo > 0 ? 'bad' : ''}"><b>${n(cronKo)}</b> pg_cron KO</span>` +
                (cronRec > 0 ? `<span class="crm-hpill"><b>${n(cronRec)}</b> échec(s) récupéré(s)</span>` : '') +
                (!exact ? '<span class="crm-hpill"><b>legacy</b> santé détaillée indisponible</span>' : '') +
                `<span class="crm-hpill"><b>${n(tmdbBacklog)}</b> backlog TMDB</span>`;
        }
    }

    // Consolidated exact-fleet incidents. Busy/viewer/footprint states are informational;
    // auth, rate-limit, circuit, worker and explicit blocked/stalled states are actionable.
    _renderIncidents(enrich, cron, engineHealth) {
        const el = document.getElementById('mot-incidents');
        if (!el) return;
        const esc = AdminPage.esc, n = AdminPage.n;
        const typeLbl = (r) => r.item_type === 'series' ? 'séries' : 'films';
        const inc = [];
        if (engineHealth?.available !== true) {
            inc.push({
                p: 4, cls: 'warn', actionable: false,
                t: '⚠ Santé détaillée indisponible',
                d: 'les anciens compteurs portent sur des titres groupés, pas sur les fichiers exacts. Ils ne permettent de conclure ni à une fin de file ni à un arrêt.'
            });
        } else {
            enrich.forEach(r => {
                const view = AdminPage.engineStateView(r);
                if (!view.actionable && !view.informational) return;
                const retry = r.next_retry_at
                    ? ` · prochain essai ${esc(new Date(r.next_retry_at).toLocaleString('fr-FR'))}` : '';
                const last = r.last_probe_at
                    ? ` · dernier progrès ${esc(AdminPage.timeAgo(r.last_probe_at))}` : '';
                const error = r.last_error ? ` · ${esc(String(r.last_error).slice(0, 140))}` : '';
                const detail = `${esc(view.reasonLabel)}${last}${retry}${error}`;
                const severe = ['blocked', 'stalled', 'not_scheduled'].includes(view.kind)
                    || ['authentication', 'forbidden', 'worker_error'].includes(view.reason);
                const prefix = severe ? '⛔' : view.actionable ? '⚠' : 'ℹ';
                inc.push({
                    p: severe ? 0 : view.actionable ? 1 : 3,
                    cls: severe ? '' : view.actionable ? 'warn' : 'gray',
                    actionable: view.actionable,
                    t: `${prefix} ${esc(view.reasonLabel)} · ${esc(r.panel)} (${typeLbl(r)})`,
                    d: detail
                });
            });
        }
        cron.filter(c => Number(c.fails_24h) > 0).forEach(c => inc.push(String(c.last_status).toLowerCase() === 'failed'
            ? { p: 0, cls: '', actionable: true, t: `⏱ pg_cron en échec · ${esc(c.jobname)}`, d: `${n(c.fails_24h)} échec(s) sur 24 h, dernier run KO` }
            : { p: 3, cls: 'gray', actionable: false, t: `⏱ Échec pg_cron récupéré · ${esc(c.jobname)}`, d: `${n(c.fails_24h)} échec(s) sur 24 h, dernier run OK — auto-réparé` }));
        AdminPage.engineSchedulerIssues(engineHealth, cron).forEach(scheduler => {
            const reason = scheduler.issue === 'schedule_missing' ? 'planification absente'
                : scheduler.issue === 'schedule_disabled' ? 'planification désactivée'
                    : 'dernier run en échec';
            const lastRun = scheduler.last_run_at
                ? ` · dernier run ${esc(AdminPage.timeAgo(scheduler.last_run_at))}` : '';
            const failures = Number(scheduler.failures_24h) > 0
                ? ` · ${n(scheduler.failures_24h)} échec(s) sur 24 h` : '';
            inc.push({
                p: 0, cls: '', actionable: true,
                t: `⏱ pg_cron dynamique · ${esc(scheduler.jobname)}`,
                d: `${reason}${lastRun}${failures}`
            });
        });
        if (!inc.length) { el.innerHTML = '<div class="mot-inc-ok">✓ Aucun incident moteur — flotte saine, pg_cron OK.</div>'; return; }
        inc.sort((a, b) => a.p - b.p);
        const actionable = inc.filter(i => i.actionable).length;
        const heading = actionable ? `🚨 Incidents moteur (${n(actionable)})` : 'ℹ️ État moteur';
        el.innerHTML = `<div class="kpi-gtitle" style="margin-bottom:10px">${heading}</div><div class="mot-inc">` +
            inc.map(i => `<div class="mot-inc-row ${i.cls}"><span class="mi-t">${i.t}</span> <span class="mi-d">— ${i.d}</span></div>`).join('') + `</div>`;
    }

    _renderTmdb(o) {
        const el = document.getElementById('admin-tmdb');
        if (!el) return;
        // Real drainage estimate from the nightly cron cadences (titles/day).
        const drain = (count, perDay) => { const c = Number(count) || 0; if (c === 0) return ''; const d = Math.ceil(c / perDay); return `<div class="mot-drain">~${AdminPage.n(d)} j au rythme actuel</div>`; };
        const card = (v, l, cls, icon, drainHtml) => `<div class="kpi ${cls || ''}"><div class="v">${AdminPage.n(v)}</div><div class="l">${l}</div>${drainHtml}<div class="mot-ic">${icon}</div></div>`;
        // These fields appear after the post-audit snapshot refresh; '—' until then.
        el.innerHTML = [
            card(o.tmdb_year_backlog, 'Années manquantes', Number(o.tmdb_year_backlog) === 0 ? 'ok' : '', '📅', drain(o.tmdb_year_backlog, 1000)),
            card(o.tmdb_unmatched, 'Non matchés TMDB', '', '🗄️', drain(o.tmdb_unmatched, 3600)),
            card(o.tmdb_unverified, 'À revalider', '', '🔄', drain(o.tmdb_unverified, 2000))
        ].join('');
    }

    // ── Page: Télémétrie (playback mode/surface/codec + media-cost shares) ──
    // Feeds the AX42+Railway vs GEX44 sizing with real numbers (docs §9.8/§10).
    async _pageTelemetrie() {
        this._setCrumb('Télémétrie', this._lastTs);
        const nav = this._nav;
        const v = this._view();
        v.innerHTML = `<div class="crm-page">
            <h1 class="crm-h1">📊 Télémétrie lecture</h1>
            <p class="crm-sub">Mode de lecture, surface & codec (30 j, tous users) — pour dimensionner l'étage média.</p>
            <div id="tlm-body"><div class="ssub">Chargement…</div></div>
        </div>`;
        try {
            const d = await this._rpc('admin_playback_telemetry', { p_days: 30 });
            if (this._nav !== nav) return;
            const body = document.getElementById('tlm-body');
            if (body) body.innerHTML = this._renderTelemetrie(d || {});
        } catch (e) {
            if (this._nav !== nav) return;
            const body = document.getElementById('tlm-body');
            if (body) body.innerHTML = `<div class="admin-err" role="alert">Erreur : ${AdminPage.esc(e.message)}</div>`;
        }
    }

    _renderTelemetrie(d) {
        const esc = AdminPage.esc;
        const pct = (x) => (x == null ? '—' : (Math.round(Number(x) * 1000) / 10).toFixed(1) + ' %');
        const cs = d.cost_shares || {};
        const ss = d.surface_shares || {};
        const win = d.window || {};
        const bar = (label, val, color, note) => {
            const w = Math.max(0, Math.min(100, Number(val || 0) * 100));
            return `<div class="tlm-row"><div class="tlm-lab">${esc(label)}</div>`
                + `<div class="tlm-track"><div class="tlm-fill" style="width:${w.toFixed(1)}%;background:${color}"></div></div>`
                + `<div class="tlm-val">${pct(val)}</div><div class="tlm-note">${esc(note || '')}</div></div>`;
        };
        const table = (obj) => {
            const entries = Object.entries(obj || {}).sort((a, b) => Number(b[1]) - Number(a[1]));
            if (!entries.length) return `<div class="ssub">Aucune donnée.</div>`;
            const tot = entries.reduce((s, kv) => s + Number(kv[1]), 0) || 1;
            return `<table class="tlm-tbl">` + entries.map((kv) =>
                `<tr><td>${esc(kv[0])}</td><td class="tlm-n">${Number(kv[1]).toLocaleString('fr-FR')}</td><td class="tlm-p">${pct(Number(kv[1]) / tot)}</td></tr>`).join('') + `</table>`;
        };
        return `<style>
        #page-admin .tlm-row{display:grid;grid-template-columns:118px 1fr 58px 1.1fr;gap:12px;align-items:center;margin:9px 0;font-size:13px;}
        #page-admin .tlm-lab{font-weight:600;color:var(--adm-tx);}
        #page-admin .tlm-track{height:11px;border-radius:6px;background:rgba(255,255,255,.06);overflow:hidden;}
        #page-admin .tlm-fill{height:100%;border-radius:6px;transition:width .4s;}
        #page-admin .tlm-val{text-align:right;font-variant-numeric:tabular-nums;color:var(--adm-tx);}
        #page-admin .tlm-note{color:var(--adm-tx3);font-size:11.5px;}
        #page-admin .tlm-tbl{width:100%;border-collapse:collapse;font-size:13px;}
        #page-admin .tlm-tbl td{padding:5px 8px;border-bottom:1px solid var(--adm-line2);}
        #page-admin .tlm-tbl .tlm-n,#page-admin .tlm-tbl .tlm-p{text-align:right;font-variant-numeric:tabular-nums;color:var(--adm-tx2);}
        #page-admin .tlm-2col{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
        @media(max-width:760px){#page-admin .tlm-row{grid-template-columns:88px 1fr 50px;}#page-admin .tlm-note{display:none;}#page-admin .tlm-2col{grid-template-columns:1fr;}}
        </style>
        <div class="admin-block">
          <h2>💸 Coût média par tier (${esc(String(win.days || 30))} j · ${Number(cs.sample || 0).toLocaleString('fr-FR')} lectures)</h2>
          ${bar('Transcode', cs.transcode, 'linear-gradient(90deg,#f87171,#ef4444)', 'Railway/GEX44 FFmpeg — egress + CPU (le + cher)')}
          ${bar('Engine', cs.engine, 'linear-gradient(90deg,#fbbf24,#f59e0b)', 'raw-pipe — egress métré, sans CPU')}
          ${bar('Relay', cs.relay, 'linear-gradient(90deg,#34d399,#10b981)', 'Cloudflare — quasi-gratuit')}
          ${bar('Direct', cs.direct, 'linear-gradient(90deg,#5b7cfa,#3b82f6)', 'natif — gratuit')}
          <div style="height:1px;background:var(--adm-line);margin:12px 0;"></div>
          ${bar('▶ Métré total', cs.metered, 'linear-gradient(90deg,#f87171,#fbbf24)', 'part qui coûte de l’egress (transcode + engine)')}
          <p class="ssub" style="margin-top:10px;">Baisser le métré = single-flight + fan-out Cloudflare + apps natives (direct). Voir STACK-AND-ROADMAP.md.</p>
        </div>
        <div class="tlm-2col">
          <div class="admin-block"><h2>🖥️ Surface</h2>
            ${bar('Navigateur', ss.browser, 'linear-gradient(90deg,#a855f7,#8b5cf6)', 'egress payé par Norva')}
            ${bar('App native', ss.native, 'linear-gradient(90deg,#5b7cfa,#3b82f6)', 'direct — 0 € egress')}
          </div>
          <div class="admin-block"><h2>🎞️ Codec / container</h2>${table(d.by_codec)}</div>
        </div>
        <div class="tlm-2col">
          <div class="admin-block"><h2>⚙️ Par mode</h2>${table(d.by_mode)}</div>
          <div class="admin-block"><h2>📱 Par surface</h2>${table(d.by_surface)}</div>
        </div>
        <p class="ssub">⚠️ Pré-lancement : surtout du testing dev (≈100 % navigateur, lourd en transcode). Devient représentatif avec de vrais users ; le codec se remplit sur les nouveaux events.</p>`;
    }

    // ── Page: Système (snapshot health + admin audit feed) ──
    async _pageSysteme() {
        this._setCrumb('Système', this._lastTs);
        const nav = this._nav;
        const v = this._view();
        v.innerHTML = `<div class="crm-page">
            <h1 class="crm-h1">🛡️ Système & Audit</h1>
            <p class="crm-sub">Santé de l'écosystème & infra temps réel · services · activité · logs · flags.</p>
            <div class="kpi-gtitle">🩺 Santé système</div>
            <section id="sys-health" class="admin-cards"><div class="ssub">Chargement…</div></section>
            <div id="sys-incidents"></div>
            <div class="sys-cols">
                <div class="admin-block"><h2>🧩 Services temps réel <button id="sys-infra-refresh" class="mini-btn" aria-label="Re-pinger l'infra" title="Re-ping">↻</button></h2><div id="sys-infra"><div class="ssub">Ping…</div></div></div>
                <div class="chart-panel"><h2>📊 Activité système — exécutions cron / jour</h2><p class="chsub">14 derniers jours · barres = exécutions, rouge = échecs</p><div id="sys-activity"><div class="ssub">Chargement…</div></div></div>
            </div>
            <div class="admin-block"><h2>📜 Logs récents — journal d'audit</h2>
                <div class="qv-row" id="sys-audit-filters" role="tablist" aria-label="Filtres audit">
                  ${[['', 'Tout'], ['admin', 'Admin'], ['sources', 'Sources'], ['billing', 'Billing'], ['support', 'Support']].map(([val, lbl]) => `<button class="qv-chip" data-filter="${val}" role="tab">${lbl}</button>`).join('')}
                </div>
                <input class="sup-search" id="sys-audit-search" type="search" placeholder="Rechercher : action, client, acteur…" autocomplete="off" aria-label="Rechercher dans l'audit" />
                <div id="sys-audit"><div class="ssub">Chargement…</div></div>
            </div>
            <div class="admin-block"><h2>💳 État billing / go-live <button id="sys-billing-refresh" class="mini-btn" aria-label="Re-vérifier l'état billing" title="Re-check">↻</button></h2><div id="sys-billing" class="admin-cards"><div class="ssub">Vérification…</div></div>
                <details class="sys-gl-details"><summary>📋 Voir la checklist go-live prod</summary><p class="ssub" style="margin:0">Bascule prod = poser les secrets Supabase (clé Revolut <code>sk_</code> prod, <code>REVOLUT_API_BASE=https://merchant.revolut.com</code>, <code>NORVA_BILLING_MODE=revenuecat</code>, <code>NORVA_ENTITLEMENTS_MODE=enforce</code>). Ce panneau doit alors passer tout au vert.</p></details>
            </div>
            <div class="admin-block"><h2>🚩 Feature flags</h2><div id="sys-flags"><div class="ssub">Chargement…</div></div></div>
        </div>`;
        // Audit filters (client-side over the loaded feed).
        document.querySelectorAll('#sys-audit-filters .qv-chip').forEach(chip => chip.addEventListener('click', () => {
            this._auditFilter = chip.dataset.filter || '';
            document.querySelectorAll('#sys-audit-filters .qv-chip').forEach(c => c.classList.toggle('active', c === chip));
            this._renderAudit((this._audit && this._audit.rows) || []);
        }));
        const asearch = document.getElementById('sys-audit-search');
        if (asearch) asearch.addEventListener('input', () => { clearTimeout(this._auditSearchDeb); this._auditSearchDeb = setTimeout(() => { this._auditSearch = asearch.value.trim(); this._renderAudit((this._audit && this._audit.rows) || []); }, 200); });
        const at = document.querySelector('#sys-audit-filters .qv-chip[data-filter="' + (this._auditFilter || '') + '"]');
        if (at) at.classList.add('active');
        try {
            const [o, act] = await Promise.all([
                this._rpc('admin_overview'),
                this._rpc('admin_activity_series', { p_days: 14 }).catch(() => null)
            ]);
            if (this._nav !== nav) return; // navigated away — don't overwrite the new page's crumb
            this._lastTs = o && o.refreshed_at ? o.refreshed_at : this._lastTs;
            this._setCrumb('Système', this._lastTs);
            this._sysOv = o; this._sysAct = act;
            this._renderSysHealth(o, act);
            this._renderSysActivity(act);
            this._renderSysIncidents();
        } catch (e) {
            if (this._nav !== nav) return;
            const el = document.getElementById('sys-health');
            if (el) el.innerHTML = `<div class="admin-err" role="alert">Erreur : ${AdminPage.esc(e.message)}</div>`;
        }
        if (this._nav !== nav) return;
        this._loadAudit(true);
        this._loadInfra();
        this._loadFlags();
    }

    // Consolidated system incidents (service down / cron KO / source en erreur / snapshot ancien /
    // billing en test) — rebuilt as each async source (overview, infra+billing) lands.
    _renderSysIncidents() {
        const el = document.getElementById('sys-incidents');
        if (!el) return;
        const n = AdminPage.n, o = this._sysOv || {}, d = this._sysInfra || null;
        const inc = [];
        const srcErr = Number(o.sources_error) || 0;
        const sd = (this._sysAct && Array.isArray(this._sysAct.system_daily)) ? this._sysAct.system_daily : [];
        const today = sd.length ? sd[sd.length - 1] : null;
        const tfail = today ? Number(today.failed) || 0 : 0;
        const fresh = o.refreshed_at && (Date.now() - new Date(o.refreshed_at).getTime()) < 12 * 60000;
        if (srcErr > 0) inc.push({ p: 0, cls: '', t: `📡 ${n(srcErr)} source(s) en erreur`, d: 'sync amont en échec', route: 'providers' });
        if (tfail > 0) inc.push({ p: 0, cls: '', t: `⏱ ${n(tfail)} cron(s) en échec aujourd'hui`, d: 'voir Moteur / activité', route: 'moteur' });
        if (o.refreshed_at && !fresh) inc.push({ p: 1, cls: 'warn', t: '📸 Snapshot ancien', d: `dernier refresh ${AdminPage.timeAgo(o.refreshed_at)}` });
        if (d) {
            const svc = [['Edge (API)', d.edge], ['Base de données', d.db], ['Gateway', d.gateway], ['Relay', d.relay]];
            svc.forEach(([label, s]) => { if (s && s.configured !== false && s.ok !== true) inc.push({ p: 0, cls: '', t: `🔴 Service down · ${label}`, d: String((s && s.error) || 'injoignable').slice(0, 80) }); });
            const b = d.billing || {};
            if (b.revolut_configured && b.revolut_sandbox) inc.push({ p: 2, cls: 'gray', t: '🧪 Billing en mode SANDBOX', d: 'go-live non basculé — normal avant lancement' });
        }
        if (!inc.length) { el.innerHTML = this._sysInfra ? '<div class="mot-inc-ok" style="margin:6px 0 22px">✓ Aucun incident système — services sains, crons OK.</div>' : ''; return; }
        inc.sort((a, b) => a.p - b.p);
        el.innerHTML = `<div class="kpi-gtitle" style="margin:6px 0 10px">🚨 Incidents système (${n(inc.length)})</div><div class="mot-inc" style="margin-bottom:22px">` +
            inc.map((i, k) => `<div class="mot-inc-row ${i.cls}"${i.route ? ` role="button" tabindex="0" data-inc-route="${i.route}" style="cursor:pointer"` : ''}><span class="mi-t">${i.t}</span> <span class="mi-d">— ${AdminPage.esc(i.d)}</span></div>`).join('') + `</div>`;
        el.querySelectorAll('[data-inc-route]').forEach(r => r.addEventListener('click', () => this._navigate(r.dataset.incRoute)));
    }

    // Système: real cron-activity bar chart (admin_activity_series.system_daily).
    _renderSysActivity(a) {
        const el = document.getElementById('sys-activity');
        if (!el) return;
        a = a || {};
        const sd = Array.isArray(a.system_daily) ? a.system_daily : [];
        if (!sd.length) { el.innerHTML = '<div class="ssub">Activité indisponible.</div>'; return; }
        const items = sd.map(d => ({ label: (d.day || '').slice(5).replace('-', '/'), value: d.runs, failed: d.failed }));
        const totFail = sd.reduce((s, d) => s + (Number(d.failed) || 0), 0);
        const chip = c => `<span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${c};vertical-align:middle"></span>`;
        el.innerHTML = AdminPage.bars(items, 'sys', { unit: 'exécutions' }) +
            `<div class="ssub" style="margin-top:8px">${chip('#6d7bf5')} exécutions&nbsp;&nbsp;${chip('#f87171')} échecs (${AdminPage.n(totFail)} sur 14 j) · survolez une barre pour le détail</div>`;
        AdminPage.wireBars(el);
    }

    // Keyset-paginated audit feed: each "Charger plus" fetches the batch strictly OLDER than the
    // last loaded row. Composite (created_at, id) cursor so events sharing an identical timestamp
    // (admin_tag_bulk writes one row per client at the same now()) aren't skipped at a boundary.
    async _loadAudit(reset) {
        const el = document.getElementById('sys-audit');
        if (!el) return;
        if (reset || !this._audit) this._audit = { rows: [], done: false };
        const a = this._audit;
        try {
            const lastRow = a.rows.length ? a.rows[a.rows.length - 1] : null;
            const batch = await this._rpc('admin_audit_feed', {
                p_limit: 80,
                p_before: lastRow ? lastRow.created_at : null,
                p_before_id: lastRow ? lastRow.id : null
            });
            const list = Array.isArray(batch) ? batch : [];
            a.rows = a.rows.concat(list);
            a.done = list.length < 80;
            this._renderAudit(a.rows);
        } catch (e) {
            el.innerHTML = `<div class="admin-err" role="alert">Erreur : ${AdminPage.esc(e.message)}</div>`;
        }
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
        } catch (e) { el.innerHTML = `<div class="admin-err" role="alert">Erreur : ${AdminPage.esc(e.message)}</div>`; }
    }

    _renderInfra(d) {
        const el = document.getElementById('sys-infra');
        if (!el) return;
        this._sysInfra = d;
        // Services as status cards (Edge / DB / Gateway / Relay) — the mockup's SERVICES panel, on real pings.
        // Status pill: CSS dot + label in an inline-flex, nowrap chip — the dot always stays
        // aligned with the text even when the service name wraps to two lines.
        const statusPill = (cls, txt) => `<span class="svc-badge ${cls}"><span class="dot"></span>${txt}</span>`;
        const svc = (label, s) => {
            s = s || {};
            if (s.configured === false) return `<div class="svc-card off"><div class="svc-h"><span class="svc-name">${AdminPage.esc(label)}</span>${statusPill('off', 'non configuré')}</div><div class="svc-lat">—</div></div>`;
            const up = s.ok === true;
            const err = !up && s.error ? `<div class="svc-err" title="${AdminPage.esc(String(s.error))}">${AdminPage.esc(String(s.error).slice(0, 60))}</div>` : '';
            const lat = up && s.ms != null ? AdminPage.n(s.ms) + ' ms' : (up ? 'sain' : 'down');
            return `<div class="svc-card ${up ? '' : 'down'}"><div class="svc-h"><span class="svc-name">${AdminPage.esc(label)}</span>${statusPill(up ? 'up' : 'down', up ? 'sain' : 'down')}</div><div class="svc-lat">${lat}</div>${err}</div>`;
        };
        const list = [['Edge (API)', d.edge], ['Base de données', d.db], ['Gateway', d.gateway], ['Relay', d.relay]];
        el.innerHTML = `<div class="svc-cards">${list.map(([l, s]) => svc(l, s)).join('')}</div>`;
        this._renderBillingState(d.billing);
        // Update the "services" header pill + rebuild the incidents zone with infra + billing signals.
        const down = list.filter(([, s]) => s && s.configured !== false && s.ok !== true).length;
        const pill = document.getElementById('sys-pill-svc');
        if (pill) { pill.classList.toggle('bad', down > 0); pill.innerHTML = down > 0 ? `<b>${AdminPage.n(down)}</b> service(s) down` : 'services <b>OK</b>'; }
        this._renderSysIncidents();
    }

    // Go-live cockpit: the billing gate flags (read from edge secrets server-side) + Revolut/Resend
    // reachability. Before the prod flip everything reads sandbox/legacy/observe; after the owner sets the
    // prod Revolut key + prod API base + enforce secrets, this panel turns green — the one place to verify the switch.
    _renderBillingState(b) {
        const el = document.getElementById('sys-billing');
        if (!el) return;
        b = b || {};
        const pill = (value, label, cls) => `<div class="kpi ${cls || ''}"><div class="v" style="font-size:17px">${value}</div><div class="l">${AdminPage.esc(label)}</div></div>`;
        const svc = (label, s) => {
            s = s || {};
            const up = s.ok === true;
            const err = !up && s.error ? ` <span class="al-err">${AdminPage.esc(String(s.error).slice(0, 90))}</span>` : '';
            return `<div class="kpi ${up ? 'ok' : 'alert'}"><div class="v" style="font-size:17px">${up ? `🟢 ${AdminPage.n(s.ms)} ms` : '🔴 down'}</div><div class="l">${AdminPage.esc(label)}${err}</div></div>`;
        };
        const live = b.revolut_mode === 'prod' && b.revolut_sandbox === false && b.revolut_configured === true;
        const keyState = !b.revolut_configured ? '⚪ absente' : (b.revolut_sandbox ? '🧪 sandbox' : '🟢 prod');
        const resendOk = b.resend_configured && b.resend && b.resend.ok;
        el.innerHTML = [
            pill(live ? '🟢 LIVE' : '🧪 SANDBOX', 'Mode Revolut', live ? 'ok' : ''),
            pill(keyState, 'Clé API', !b.revolut_configured ? 'alert' : (b.revolut_sandbox ? '' : 'ok')),
            pill(b.billing_mode === 'legacy' ? 'legacy' : AdminPage.esc(b.billing_mode || '—'), 'Billing mode', b.billing_mode && b.billing_mode !== 'legacy' ? 'ok' : ''),
            pill(b.entitlements_mode === 'enforce' ? '🔒 enforce' : '👁 observe', 'Enforcement', b.entitlements_mode === 'enforce' ? 'ok' : ''),
            pill(b.lifecycle_billing_live ? 'on' : 'off', 'Relances / reçus', b.lifecycle_billing_live ? 'ok' : ''),
            pill(b.webhook_secret_set ? 'posé' : '—', 'Webhook secret'),
            svc('API Revolut', b.revolut),
            pill(resendOk ? '🟢 configuré' : (b.resend_configured ? '🔴 injoignable' : '🔴 absent'), 'Resend (emails)', resendOk ? 'ok' : 'alert'),
        ].join('');
    }

    async _loadFlags() {
        const el = document.getElementById('sys-flags');
        if (!el) return;
        try {
            const flags = await this._rpc('admin_flags_list');
            this._renderFlags(Array.isArray(flags) ? flags : []);
        } catch (e) { el.innerHTML = `<div class="admin-err" role="alert">Erreur : ${AdminPage.esc(e.message)}</div>`; }
    }

    _renderFlags(flags) {
        const el = document.getElementById('sys-flags');
        if (!el) return;
        const rows = flags.map((f) => {
            const key = AdminPage.esc(f.key);
            const description = `${AdminPage.esc(f.description || '')}${f.updated_by ? ` · ${AdminPage.esc(f.updated_by)}` : ''}`;
            if (this._isManagedPartnersFlag(f.key)) {
                const state = f.enabled ? 'Activé' : 'Désactivé';
                return `<div class="flag-row flag-row--managed" data-managed-partners-flag="${key}"
                    role="group" aria-label="${key} — contrôle de release sécurisé, état ${state.toLowerCase()}, lecture seule">
                    <span class="flag-managed-signal ${f.enabled ? 'is-on' : ''}" aria-hidden="true"></span>
                    <div class="flag-meta">
                        <div class="flag-key">${key}</div>
                        <div class="flag-desc">${description}</div>
                        <div class="flag-managed-detail">
                            <span class="flag-managed-badge">Release gérée</span>
                            <span>Contrôle de release sécurisé · lecture seule dans cette vue</span>
                        </div>
                    </div>
                    <span class="flag-managed-state ${f.enabled ? 'is-on' : ''}"
                        aria-label="État actuel : ${state.toLowerCase()}">${state}</span>
                </div>`;
            }
            return `<div class="flag-row">
                <label class="switch"><input type="checkbox" class="flag-toggle" data-key="${key}" aria-label="Activer le flag ${key}" ${f.enabled ? 'checked' : ''}><span class="slider"></span></label>
                <div class="flag-meta"><div class="flag-key">${key}</div><div class="flag-desc">${description}</div></div>
                <button class="flag-del" data-key="${key}" aria-label="Supprimer le flag ${key}" title="Supprimer le flag">×</button>
            </div>`;
        }).join('');
        el.innerHTML = `${rows || '<div class="ssub">Aucun flag.</div>'}<div class="flag-add"><button class="flag-create tag-add-chip">＋ créer un flag</button></div>`;
    }

    _isManagedPartnersFlag(key) {
        return [
            'partners_enabled',
            'partners_invite_only',
            'partners_cash_pilot_allowlist_only',
            'partners_earnings_enabled',
            'partners_credit_redemptions_enabled',
            'partners_shadow_mode',
            'partners_payouts_live',
            'partners_revolut_api_enabled',
            'partners_tv_relay_enabled'
        ].includes(String(key || ''));
    }

    async _flagToggle(input) {
        if (this._isManagedPartnersFlag(input?.dataset?.key)) {
            this._toast('Ce flag Partners est piloté par le contrôle de release sécurisé.', 'err');
            this._loadFlags();
            return;
        }
        try { await this._rpc('admin_flag_set', { p_key: input.dataset.key, p_enabled: input.checked }); this._toast(`Flag « ${input.dataset.key} » ${input.checked ? 'activé' : 'désactivé'}.`, 'ok'); }
        catch (e) { input.checked = !input.checked; this._toast('Erreur : ' + e.message, 'err'); }
    }
    async _flagCreate() {
        const key = ((await this._prompt('Clé du flag (a-z, 0-9, _) :')) || '').trim().toLowerCase();
        if (!key) return;
        if (!/^[a-z0-9_]+$/.test(key)) { this._toast('Clé invalide : uniquement a-z, 0-9 et _.', 'err'); return; }
        const desc = ((await this._prompt('Description :')) || '').trim();
        try { await this._rpc('admin_flag_create', { p_key: key, p_description: desc || null }); this._loadFlags(); this._toast('Flag créé.', 'ok'); }
        catch (e) { this._toast('Erreur : ' + e.message, 'err'); }
    }

    // Real "santé système" gauge cards (no fake CPU/RAM — Norva has no machine metrics).
    // Global status from real alert signals; two real % gauges (crons OK, sources saines).
    _renderSysHealth(o, act) {
        o = o || {};
        const el = document.getElementById('sys-health');
        if (!el) return;
        const n = AdminPage.n;
        const srcErr = Number(o.sources_error) || 0, subFail = Number(o.gensubs_failed) || 0;
        const srcTot = Number(o.sources_total) || 0;
        const srcPct = srcTot > 0 ? Math.round(100 * (srcTot - srcErr) / srcTot) : 100;
        const sd = (act && Array.isArray(act.system_daily)) ? act.system_daily : [];
        const today = sd.length ? sd[sd.length - 1] : null;
        const runs = today ? Number(today.runs) || 0 : 0, tfail = today ? Number(today.failed) || 0 : 0;
        const cronPct = runs > 0 ? Math.round(100 * (runs - tfail) / runs) : 100;
        const fresh = o.refreshed_at && (Date.now() - new Date(o.refreshed_at).getTime()) < 12 * 60000;

        // Global status from ACTIONABLE signals only: a broken source or crons actively
        // failing = degraded; slightly-failing crons or a big subtitle backlog = attention.
        // (A handful of failed AI subtitles is normal — some videos can't be transcribed —
        // so it never degrades the whole system.)
        let statusTxt = 'Sain', statusCls = 'ok';
        if (srcErr > 0 || cronPct < 80) { statusTxt = 'Dégradé'; statusCls = 'alert'; }
        else if (cronPct < 96 || subFail > 50 || !fresh) { statusTxt = 'Attention'; statusCls = ''; }
        const statusTip = `Sources en erreur : ${n(srcErr)} · Crons OK 24 h : ${cronPct} % · ST IA échoués : ${n(subFail)} · Snapshot ${fresh ? 'à jour' : 'ancien'}`;

        const statusCard = `<div class="kpi ${statusCls}" title="${AdminPage.esc(statusTip)}"><div class="kpi-hd"><div class="v" style="font-size:22px">${statusTxt}</div><span class="kpi-ic">🛡️</span></div><div class="l">Statut global</div></div>`;
        const gauge = (pct, label, cls, icon) => `<div class="kpi ${cls}"><div class="kpi-hd"><div class="v">${pct} %</div><span class="kpi-ic">${icon}</span></div><div class="l">${label}</div><div class="kpi-bar"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div></div>`;
        const card = (v, l, cls, icon) => `<div class="kpi ${cls || ''}"><div class="kpi-hd"><div class="v">${v}</div><span class="kpi-ic">${icon}</span></div><div class="l">${l}</div></div>`;
        el.innerHTML = [
            statusCard,
            gauge(cronPct, 'Crons OK 24 h', cronPct >= 95 ? 'ok' : (cronPct >= 80 ? '' : 'alert'), '⏱️'),
            gauge(srcPct, 'Sources saines', srcPct >= 90 ? 'ok' : (srcPct >= 70 ? '' : 'alert'), '🗂️'),
            card(n(o.users_active_24h), 'Actifs 24 h', Number(o.users_active_24h) > 0 ? 'ok' : '', '👤'),
            card(AdminPage.esc(o.refreshed_at ? AdminPage.timeAgo(o.refreshed_at) : '—'), 'Dernier snapshot', fresh ? 'ok' : 'alert', '📸')
        ].join('');
        // Header status pills (services filled once the infra ping lands).
        const tx = document.querySelector('#page-admin .crm-head-tx');
        if (tx) {
            let meta = tx.querySelector('.crm-head-meta');
            if (!meta) { meta = document.createElement('div'); meta.className = 'crm-head-meta'; tx.appendChild(meta); }
            meta.innerHTML =
                `<span class="crm-hpill ${statusCls === 'alert' ? 'bad' : ''}"><b>${statusTxt}</b></span>` +
                `<span class="crm-hpill" id="sys-pill-svc">services <b>…</b></span>` +
                `<span class="crm-hpill ${cronPct < 80 ? 'bad' : ''}"><b>${cronPct} %</b> crons OK</span>` +
                `<span class="crm-hpill ${srcPct < 70 ? 'bad' : ''}"><b>${srcPct} %</b> sources</span>` +
                `<span class="crm-hpill ${o.refreshed_at && !fresh ? 'bad' : ''}">snapshot ${o.refreshed_at ? AdminPage.esc(AdminPage.timeAgo(o.refreshed_at)) : '—'}</span>`;
        }
    }

    _renderAudit(rows) {
        const el = document.getElementById('sys-audit');
        if (!el) return;
        rows = Array.isArray(rows) ? rows : [];
        const icon = (k) => ({ note_added: '📝', tag_added: '🏷️', tag_removed: '🏷️', admin_action: '⚡', resync: '↻', signup: '🎉', sync_started: '▶️', sync_done: '✅', sync_failed: '⚠️', billing: '💳', refund: '↩︎', trial_started: '🚀', cancelled: '🛑', saved: '💚' }[k] || '•');
        const cat = (k) => ['sync_started', 'sync_done', 'sync_failed', 'resync', 'provider_added'].includes(k) ? 'sources'
            : ['billing', 'refund', 'trial_started', 'cancelled', 'saved'].includes(k) ? 'billing'
            : /ticket|support|reply/.test(String(k)) ? 'support' : 'admin';
        const more = (this._audit && !this._audit.done)
            ? '<div style="margin-top:14px"><button id="sys-audit-more" class="tag-add-chip">⌄ Charger 80 de plus</button></div>' : '';
        // Filter by category + free-text search.
        const f = this._auditFilter || '';
        let view = f ? rows.filter(r => cat(r.kind) === f) : rows;
        const q = (this._auditSearch || '').toLowerCase();
        if (q) view = view.filter(r => [r.summary, r.client_email, r.actor].some(x => String(x || '').toLowerCase().includes(q)));
        if (!view.length) { el.innerHTML = `<div class="ssub">${(f || q) ? 'Aucun événement pour ce filtre.' : 'Aucune action enregistrée pour l\'instant.'}</div>` + more; return; }
        // Group by day.
        const dayKey = (d) => d ? new Date(d).toLocaleDateString('fr-FR', { weekday: 'long', day: '2-digit', month: 'long' }) : '—';
        const item = (e) => `<div class="tl-item audit-row"${e.user_id ? ` data-user-id="${AdminPage.esc(e.user_id)}" role="button" tabindex="0"` : ''}>
            <span class="tl-ic">${icon(e.kind)}</span>
            <span class="tl-sum">${AdminPage.esc(e.summary)}${e.client_email ? ` <span class="al-owner">· ${AdminPage.esc(e.client_email)}</span>` : ''}${e.actor ? ` <span class="ssub">par ${AdminPage.esc(e.actor)}</span>` : ''}</span>
            <span class="tl-at" title="${e.created_at ? AdminPage.esc(new Date(e.created_at).toLocaleString('fr-FR')) : ''}">${e.created_at ? AdminPage.esc(AdminPage.timeAgo(e.created_at)) : ''}</span>
        </div>`;
        let html = '', prevDay = null, buf = '';
        const flush = () => { if (buf) html += `<div class="tl">${buf}</div>`; buf = ''; };
        view.forEach(e => { const dk = dayKey(e.created_at); if (dk !== prevDay) { flush(); html += `<div class="audit-day">${AdminPage.esc(dk)}</div>`; prevDay = dk; } buf += item(e); });
        flush();
        el.innerHTML = html + more;
    }

    // ── shared renderers ──
    _renderOverview(o, sparks) {
        o = o || {};
        const el = document.getElementById('admin-overview');
        if (!el) return;
        const S = sparks || {};
        // card(value, label, cls, metricKey, icon) — icon top-right + real sparkline (if series present).
        const card = (v, l, cls, key, icon) => {
            const spark = key && Array.isArray(S[key]) ? AdminPage.spark(S[key], cls) : '';
            return `<div class="kpi ${cls || ''}">
                <div class="kpi-hd"><div class="v">${v}</div>${icon ? `<span class="kpi-ic">${icon}</span>` : ''}</div>
                <div class="l">${l}</div>
                ${spark ? `<div class="kpi-spark">${spark}</div>` : ''}
            </div>`;
        };
        const n = (x) => (x == null ? '—' : Number(x).toLocaleString('fr-FR'));
        const group = (title, cards) => `<div class="kpi-group"><div class="kpi-gtitle">${title}</div><div class="admin-cards">${cards.join('')}</div></div>`;
        const money = AdminPage.money;
        // Non-colour-only state chip for the priority health cards.
        const stateChip = (bad, crit) => `<span class="kpi-state ${bad ? (crit ? 'crit' : 'warn') : 'ok'}">${bad ? (crit ? 'Critique' : 'À traiter') : 'OK'}</span>`;
        // Priority card: like card() but can carry a state chip after the label.
        const pcard = (v, l, cls, key, icon, chip) => {
            const spark = key && Array.isArray(S[key]) ? AdminPage.spark(S[key], cls) : '';
            return `<div class="kpi ${cls || ''}"><div class="kpi-hd"><div class="v">${v}</div>${icon ? `<span class="kpi-ic">${icon}</span>` : ''}</div><div class="l">${l}${chip || ''}</div>${spark ? `<div class="kpi-spark">${spark}</div>` : ''}</div>`;
        };
        const pastDueBad = Number(o.billing_past_due) > 0, srcErrBad = Number(o.sources_error) > 0, cronBad = Number(o.cron_fails_24h) > 0;
        el.innerHTML = [
            // ── Signaux prioritaires — the 6 decision-critical KPIs, given visual dominance ──
            `<div class="kpi-group kpi-group--priority"><div class="kpi-gtitle">🚦 Signaux prioritaires</div><div class="admin-cards">${[
                pcard(money(o.billing_mrr_cents), 'MRR', Number(o.billing_mrr_cents) > 0 ? 'ok' : '', 'mrr_cents', '💲', ''),
                pcard(n(o.billing_active), 'Actifs payants', Number(o.billing_active) > 0 ? 'ok' : '', 'active_paying', '👤', ''),
                pcard(n(o.billing_past_due), 'Échecs paiement', pastDueBad ? 'alert' : 'ok', 'past_due', '🛡️', stateChip(pastDueBad, true)),
                pcard(n(o.billing_conversions_7d), 'Conversions 7 j', '', 'conversions_7d', '📈', ''),
                pcard(n(o.sources_error), 'Sources en erreur', srcErrBad ? 'alert' : 'ok', 'sources_error', '⚠️', stateChip(srcErrBad, false)),
                pcard(n(o.cron_fails_24h), 'Échecs cron 24 h', cronBad ? 'alert' : 'ok', 'cron_fails_24h', '⏱️', stateChip(cronBad, false))
            ].join('')}</div></div>`,
            group('💶 Revenus', [
                card(money(o.billing_mrr_cents), 'MRR', Number(o.billing_mrr_cents) > 0 ? 'ok' : '', 'mrr_cents', '💲'),
                card(n(o.billing_trialing), 'En essai', '', 'trialing', '⏳'),
                card(n(o.billing_active), 'Actifs payants', Number(o.billing_active) > 0 ? 'ok' : '', 'active_paying', '👤'),
                card(n(o.billing_past_due), 'Échecs paiement', Number(o.billing_past_due) > 0 ? 'alert' : 'ok', 'past_due', '🛡️'),
                card(n(o.billing_conversions_7d), 'Conversions 7 j', '', 'conversions_7d', '📈'),
                card(money(o.billing_collected_30d_cents), 'Encaissé 30 j', '', 'collected_30d_cents', '💰'),
                // Provision TVA (EUR) : TVA collectée non encore reversée — visible seulement
                // quand elle existe (0 sous franchise/seuil : rien à provisionner).
                ...(Number(o.vat_provision_eur_cents) > 0
                    ? [card((Number(o.vat_provision_eur_cents) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €',
                        'Provision TVA — à réserver, pas à vous', 'alert', null, '🏦')]
                    : [])
            ]),
            group('👥 Clients & croissance', [
                card(n(o.users_total), 'Utilisateurs', o.users_active_7d ? 'ok' : '', 'users_total', '👥'),
                // "Connectés" = last_sign_in_at (sessions persist — undercounts real activity);
                // "Regardent" = distinct watch-history users, the truthful activity signal.
                card(n(o.users_active_24h), 'Connectés 24 h', '', 'users_active_24h', '🕐'),
                card(n(o.users_active_7d), 'Connectés 7 j', '', 'users_active_7d', '🗓️'),
                card(n(o.users_watching_7d), 'Regardent 7 j', Number(o.users_watching_7d) > 0 ? 'ok' : '', 'users_watching_7d', '👁️'),
                card(n(o.users_new_7d), 'Nouveaux 7 j', Number(o.users_new_7d) > 0 ? 'ok' : '', 'users_new_7d', '➕'),
                card(n(o.users_new_30d), 'Nouveaux 30 j', '', 'users_new_30d', '📅'),
                // Top pays (clients facturés — payants + essais), depuis le cache (billing_countries).
                (Array.isArray(o.billing_countries) && o.billing_countries.length
                    ? card(AdminPage.flag(o.billing_countries[0].country_code),
                        `Top pays · ${n(o.billing_countries_n)} pays${Number(o.billing_country_unknown_n) > 0 ? ` · ${n(o.billing_country_unknown_n)} inconnu(s)` : ''}`,
                        '', null, '🌍')
                    : card('—', 'Top pays — en attente de clients', 'muted', null, '🌍'))
            ]),
            group('📡 Providers & catalogue', [
                card(n(o.sources_total), 'Sources', '', 'sources_total', '🗂️'),
                card(n(o.sources_incomplete), 'Sync incomplète', Number(o.sources_incomplete) > 0 ? 'alert' : 'ok', 'sources_incomplete', '🔄'),
                card(n(o.sources_error), 'Sources en erreur', Number(o.sources_error) > 0 ? 'alert' : 'ok', 'sources_error', '⚠️'),
                card(n(o.identities_active), 'Identités', '', 'identities_active', '🧬'),
                card(n(o.titles_movie), 'Films', '', 'titles_movie', '🎬'),
                card(n(o.titles_series), 'Séries', '', 'titles_series', '📺')
            ]),
            group('🎬 Sous-titres IA', [
                card(n(o.gensubs_ready), 'Prêts', 'ok', 'gensubs_ready', '✅'),
                card(n(o.gensubs_processing), 'En cours', '', 'gensubs_processing', '⏳'),
                card(n(o.gensubs_failed), 'Échoués', Number(o.gensubs_failed) > 0 ? 'alert' : '', 'gensubs_failed', '✖️')
            ]),
            group('⏱️ Crons', [
                card(n(o.cron_active), 'Actifs', 'ok', 'cron_active', '▶️'),
                card(n(o.cron_paused), 'En pause', '', 'cron_paused', '⏸️'),
                card(n(o.cron_fails_24h), 'Échecs 24 h', Number(o.cron_fails_24h) > 0 ? 'alert' : 'ok', 'cron_fails_24h', '⚠️')
            ])
        ].join('');
    }

    _renderSources(rows) {
        const el = document.getElementById('admin-sources');
        if (!el) return;
        rows = Array.isArray(rows) ? rows : [];
        const kind = (s) => (s.sync_error || s.sync_status === 'sync_error') ? 'err' : s.incomplete === true ? 'inc' : !s.identity_name ? 'unres' : 'ok';
        // Bulk re-sync button reflects the FULL set (independent of the current filter/search).
        const errCount = rows.filter(s => kind(s) === 'err').length;
        const bulk = document.getElementById('prov-bulk-resync');
        if (bulk) { bulk.hidden = errCount === 0; if (errCount) bulk.textContent = `↻ Re-sync ${errCount} erreur(s)`; }
        // Quick filter.
        const f = this._provFilter || '';
        let view = rows.filter(s => {
            const k = kind(s);
            if (f === 'problem') return k !== 'ok';
            if (f === 'error') return k === 'err';
            if (f === 'incomplete') return s.incomplete === true;
            if (f === 'unresolved') return !s.identity_name;
            if (f === 'driver') return s.is_driver === true;
            return true;
        });
        // Search across provider / account / identity / error.
        const q = (this._provSearch || '').toLowerCase();
        if (q) view = view.filter(s => [s.display_name, s.owner_email, s.identity_name, s.sync_error].some(x => String(x || '').toLowerCase().includes(q)));
        // Priority sort: errors → incomplete → unresolved → healthy, then account/name.
        const rank = { err: 0, inc: 1, unres: 2, ok: 3 };
        view = view.slice().sort((a, b) => (rank[kind(a)] - rank[kind(b)]) ||
            String(a.owner_email).localeCompare(String(b.owner_email)) || String(a.display_name).localeCompare(String(b.display_name)));
        if (!view.length) {
            el.innerHTML = `<div class="card"><span class="badge ${q || f ? 'gray' : 'green'}">${q || f ? '∅' : '✓'}</span> ${q || f ? 'Aucune source ne correspond à ce filtre.' : 'Aucune source.'}</div>`;
            return;
        }
        const n = AdminPage.n, esc = AdminPage.esc;
        const statusBadge = (s, k) => k === 'err' ? '<span class="badge red">erreur</span>'
            : k === 'inc' ? '<span class="badge amber">sync incomplète</span>'
            : `<span class="badge green">${esc(s.sync_status || 'ready')}</span>`;
        el.innerHTML = `<div class="src-rows">` + view.map(s => {
            const k = kind(s);
            const cat = `${n(s.movie_titles)} films · ${n(s.series_titles)} séries · ${n(s.media_items)} items`;
            const sync = s.last_synced_at ? AdminPage.timeAgo(s.last_synced_at) : 'jamais';
            const idHtml = s.identity_name ? `identité <b style="color:var(--adm-tx2)">${esc(s.identity_name)}</b>` : '<span class="badge gray">identité non résolue</span>';
            const acct = s.user_id
                ? `<span class="src-acct" data-user-id="${esc(s.user_id)}" title="Ouvrir la fiche client">👤 ${esc(s.owner_email || '—')}</span>`
                : `<span>👤 ${esc(s.owner_email || '—')}</span>`;
            return `<div class="src-row ${k}">
                <div class="src-st">${statusBadge(s, k)}${s.is_driver ? '<span class="badge blue">pilote</span>' : ''}<div class="src-prov" title="${esc(s.display_name)}">${esc(s.display_name)}</div></div>
                <div class="src-main">
                    ${acct} · <span class="src-id">${idHtml}</span>
                    ${s.sync_error ? `<div class="src-err" title="${esc(s.sync_error)}">⚠ ${esc(s.sync_error)}</div>` : ''}
                    <div class="src-cat">${cat}</div>
                </div>
                <div class="src-meta">
                    <div class="src-sync">sync ${esc(sync)}</div>
                    <div class="src-acts">
                        ${s.user_id ? `<button class="src-mini src-open" data-user-id="${esc(s.user_id)}" title="Ouvrir la fiche client">client →</button>` : ''}
                        <button class="resync-btn" data-source="${esc(s.source_id)}" title="Forcer un re-sync complet de cette source">↻ re-sync</button>
                    </div>
                </div>
            </div>`;
        }).join('') + `</div>`;
        // Account / open-client navigation (re-sync uses the delegated .resync-btn handler).
        el.querySelectorAll('.src-acct[data-user-id], .src-open[data-user-id]').forEach(a =>
            a.addEventListener('click', (e) => { e.stopPropagation(); this._navigate('client:' + a.dataset.userId); }));
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
            this._toast('Re-sync lancé.', 'ok');
            // Reset so the admin can re-trigger later (the sync itself runs server-side).
            setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3500);
        } catch (e) {
            btn.textContent = '✗ ' + AdminPage.esc(e.message || 'err');
            setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3500);
        }
    }

    _renderEnrich(rows) {
        const el = document.getElementById('admin-enrich');
        if (!el) return;
        rows = Array.isArray(rows) ? rows : [];
        const exact = this._engineHealth?.available === true;
        // Threshold-coloured coverage bar (green > 90 %, amber 60–90 %, red < 60 %).
        const barCell = (a, p) => {
            const pct = Math.max(0, Number(p) || 0);
            const bcls = pct >= 90 ? '' : pct >= 60 ? 'b-warn' : 'b-bad';
            return `<td class="num"><span class="bar ${bcls}"><i style="width:${Math.min(100, pct)}%"></i></span>${AdminPage.n(a)} (${pct}%)</td>`;
        };
        const latest = (...values) => {
            const valid = values.map(value => ({ value, time: new Date(value).getTime() }))
                .filter(x => x.value && Number.isFinite(x.time))
                .sort((a, b) => b.time - a.time);
            return valid[0]?.value || null;
        };
        const when = (value) => {
            if (!value || !Number.isFinite(new Date(value).getTime())) return '—';
            return `<span title="${AdminPage.esc(new Date(value).toLocaleString('fr-FR'))}">${AdminPage.esc(AdminPage.timeAgo(value))}</span>`;
        };
        // The server owns detailed fleet state. Legacy rows can only be active or unknown.
        const f = this._motFilter || '';
        let view = rows.filter(r => {
            const state = AdminPage.engineStateView(r);
            if (f === 'problem') return state.actionable;
            if (f === 'progress') return ['active', 'running'].includes(state.kind);
            if (f === 'waiting') return ['idle', 'retry_wait'].includes(state.kind);
            if (f === 'paused') return ['paused', 'disabled'].includes(state.kind);
            if (f === 'unknown') return state.kind === 'unknown';
            if (f === 'low') return (exact
                ? (Number(r.probed_pct) || 0)
                : (Number(r.resolved_pct) || 0)) < 60;
            return true;
        });
        const legacyNote = !exact
            ? '<div class="mot-legacy-note">Santé détaillée indisponible — les anciens compteurs portent sur des titres groupés, pas sur les fichiers exacts. Les colonnes exactes restent masquées afin de ne pas simuler une fin de file ou un arrêt.</div>'
            : '';
        if (!view.length) {
            el.innerHTML = `${legacyNote}<div class="card"><span class="badge ${f ? 'gray' : 'green'}">${f ? '∅' : '✓'}</span> ${f ? 'Aucun panel ne correspond à ce filtre.' : 'Aucune donnée.'}</div>`;
            return;
        }
        const rank = {
            blocked: 0, stalled: 0, not_scheduled: 1, retry_wait: 2, running: 3,
            active: 4, idle: 5, paused: 6, disabled: 7, unknown: 8, complete: 9
        };
        view = view.slice().sort((a, b) =>
            ((rank[AdminPage.engineStateView(a).kind] ?? 99) - (rank[AdminPage.engineStateView(b).kind] ?? 99)) ||
            String(a.owner_email).localeCompare(String(b.owner_email)) ||
            String(a.panel).localeCompare(String(b.panel)) ||
            ((a.item_type === 'series') ? 1 : 0) - ((b.item_type === 'series') ? 1 : 0));
        const head = `<tr>
            <th>Provider</th><th>Type</th><th class="num">Catalogue</th>
            <th class="num" title="Fichiers exacts connus">Fichiers connus</th>
            <th class="num">${exact ? 'Fichiers sondés' : 'Audio résolu (legacy)'}</th>
            <th class="num" title="Fichiers exacts sans analyse">Jamais sondé</th>
            <th class="num" title="Fichiers exacts analysés sur 24 h">Sondés 24h</th>
            <th class="num" title="Fichiers exacts avec audio vérifié sur 24 h">Vérifiés 24h</th>
            <th>État / raison</th><th>Dernier progrès</th><th>Prochain passage</th>
            <th class="num">ST trouvés</th>
        </tr>`;
        let prevGroup = null;
        const body = view.map(r => {
            const group = `${r.owner_email || ''}\u0000${r.panel || ''}`;
            const newGroup = group !== prevGroup;
            prevGroup = group;
            const state = AdminPage.engineStateView(r);
            // A completed worker may only have skipped work. Progress means an actual probe or
            // verification, never merely a completed worker run.
            const lastProgress = latest(r.last_probe_at, r.last_verified_at);
            const nextPass = r.next_retry_at || r.next_run_at || null;
            const eta = Number.isFinite(Number(r.eta_days)) && Number(r.eta_days) > 0
                ? ` · ETA ~${AdminPage.n(r.eta_days)} j`
                : '';
            const panelCell = newGroup
                ? `<td><div class="pname">${AdminPage.esc(r.panel)}</div><div class="pacct">${AdminPage.esc(r.owner_email || '')}</div></td>`
                : `<td></td>`;
            return `<tr class="${newGroup ? 'group-start' : ''} ${state.actionable ? 'mot-bad' : ''}">
            ${panelCell}
            <td>${r.item_type === 'series' ? 'séries' : 'films'}</td>
            <td class="num">${AdminPage.n(r.total)}</td>
            <td class="num">${exact ? AdminPage.n(r.known_files) : '—'}</td>
            ${barCell(exact ? r.probed_files : r.resolved, exact ? r.probed_pct : r.resolved_pct)}
            <td class="num">${exact ? AdminPage.n(r.never_probed) : '—'}</td>
            <td class="num">${exact ? AdminPage.n(r.probed_24h) : '—'}</td>
            <td class="num">${exact ? AdminPage.n(r.resolved_24h) : '—'}</td>
            <td>
                <span class="badge ${state.badge}" title="${AdminPage.esc(state.reasonLabel)}">${AdminPage.esc(state.label)}</span>
                <div class="mot-state-detail">${AdminPage.esc(state.reasonLabel)}${eta}</div>
            </td>
            <td>${when(lastProgress)}</td>
            <td>${when(nextPass)}</td>
            <td class="num">${AdminPage.n(r.subtitle_found)}</td>
        </tr>`;
        }).join('');
        el.innerHTML = `${legacyNote}<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
    }

    _renderCron(rows) {
        const el = document.getElementById('admin-cron');
        if (!el) return;
        // Summary above the table: active / paused / failing.
        const sum = document.getElementById('mot-cron-sum');
        if (sum) {
            const active = rows.filter(r => r.active !== false && Number(r.fails_24h) === 0).length;
            const paused = rows.filter(r => r.active === false).length;
            const failing = rows.filter(r => Number(r.fails_24h) > 0 && String(r.last_status) === 'failed').length;
            const recovered = rows.filter(r => Number(r.fails_24h) > 0 && String(r.last_status) !== 'failed').length;
            sum.innerHTML = `<div class="cron-sum">
                <span class="badge green">${AdminPage.n(active)} pg_cron actifs</span>
                <span class="badge gray">${AdminPage.n(paused)} pg_cron en pause</span>
                <span class="badge ${failing > 0 ? 'red' : 'gray'}">${AdminPage.n(failing)} pg_cron encore en échec</span>
                ${recovered > 0 ? `<span class="badge amber">${AdminPage.n(recovered)} pg_cron récupéré(s) 24 h</span>` : ''}
            </div>`;
        }
        if (!rows.length) { el.innerHTML = '<div class="ssub">Aucun cron déclaré.</div>'; return; }
        const winBadge = (w) => w === 'jour' ? '<span class="badge amber">☀️ jour</span>'
            : w === 'nuit' ? '<span class="badge blue">🌙 nuit</span>'
            : w === 'continu' ? '<span class="badge green">♾️ continu</span>'
            : w === 'maintenance' ? '<span class="badge red">maintenance</span>'
            : (w && w !== '—') ? `<span class="badge red">${AdminPage.esc(w)}</span>`
            : '<span class="badge gray">—</span>';
        // Group by window client-side (stable sort keeps the SQL's billing/lifecycle-first order
        // within each window) — the snapshot ORDER BY no longer guarantees window contiguity.
        const winRank = (w) => (w === 'jour' ? 0 : w === 'nuit' ? 1 : w === 'continu' ? 2 : 3);
        const sorted = rows.slice().sort((a, b) => winRank(a.window) - winRank(b.window));
        const head = `<tr><th>Fenêtre</th><th>Dimension</th><th>Job</th><th>Cadence</th><th>État</th><th>Dernier run</th><th class="num">Échecs 24h</th></tr>`;
        let prevWin = null;
        const body = sorted.map(r => {
            const paused = r.active === false;
            const failing = Number(r.fails_24h) > 0 && String(r.last_status) === 'failed';
            const recovered = Number(r.fails_24h) > 0 && !failing;
            const newGroup = r.window !== prevWin;
            prevWin = r.window;
            const state = paused ? `<span class="badge gray">pause</span>`
                : (failing ? `<span class="badge red">échecs</span>`
                : recovered ? `<span class="badge amber">récupéré</span>` : `<span class="badge green">actif</span>`);
            const last = r.last_run ? new Date(r.last_run).toLocaleString('fr-FR') : '—';
            return `<tr class="${newGroup ? 'group-start' : ''} ${failing ? 'bad' : ''}">
                <td>${winBadge(r.window)}</td>
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
    // Cents → "4,99 $" (USD, admin UI is French-formatted).
    static money(cents) {
        if (cents == null || !Number.isFinite(Number(cents))) return '—';
        return (Number(cents) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $';
    }
    // Subscription status → badge (label + colour). Plan appended when known.
    static billingBadge(status, planCode) {
        const plan = planCode === 'family' ? ' Family' : '';
        const map = {
            trialing: ['blue', 'essai' + plan],
            active: ['green', 'actif' + plan],
            past_due: ['red', 'échec paiement'],
            grace: ['red', 'échec paiement'],
            cancelled_at_period_end: ['amber', 'annulation prévue'],
            expired: ['gray', 'expiré']
        };
        const m = map[String(status || '').toLowerCase()];
        return m ? `<span class="badge ${m[0]}">${AdminPage.esc(m[1])}</span>` : '<span class="ssub">—</span>';
    }
    // Payment rail (provider) → human label + badge. Separates web (Revolut) from mobile stores.
    static railLabel(p) {
        const map = { revolut: 'Revolut · web', google_play: 'Google Play · mobile', apple_app_store: 'App Store · mobile', system: 'Comp / système', manual: 'Manuel', revenuecat: 'RevenueCat', web: 'Web', stripe: 'Stripe', stancer: 'Stancer · retiré' };
        return map[p] || (p ? AdminPage.esc(p) : '—');
    }
    static railBadge(p) {
        const cls = p === 'revolut' ? 'blue' : (p === 'google_play' || p === 'apple_app_store') ? 'green' : 'gray';
        return `<span class="badge ${cls}">${AdminPage.railLabel(p)}</span>`;
    }
    // Country (ISO alpha-2) → emoji flag + code. Sources: RevenueCat country_code (store,
    // haute confiance) ou pays d'émission de la carte Revolut (proxy ~95 %). '—' si inconnu.
    static flag(cc) {
        const s = String(cc || '').toUpperCase();
        if (!/^[A-Z]{2}$/.test(s)) return '<span class="ssub">—</span>';
        const emoji = String.fromCodePoint(...[...s].map(c => 0x1F1A5 + c.charCodeAt(0)));
        return `${emoji} ${s}`;
    }
    static signupPlatformLabel(value) {
        return ({ web: 'Navigateur web', mobile_android: 'App Android mobile' }[value] || 'Origine inconnue');
    }
    static signupSurfaceLabel(value) {
        return ({
            account: 'Compte',
            subscription: 'Abonnement',
            tv_pairing: 'Pairing TV'
        }[value] || 'Parcours inconnu');
    }
    static signupMethodLabel(value) {
        return ({
            email_password: 'Email + mot de passe',
            email_magic_link: 'Lien sécurisé par email',
            google: 'Google'
        }[value] || 'Méthode inconnue');
    }
    static signupLocationText(attribution) {
        const a = attribution || {};
        const cc = String(a.country_code || '').toUpperCase();
        let country = '';
        if (/^[A-Z]{2}$/.test(cc)) {
            const emoji = String.fromCodePoint(...[...cc].map(c => 0x1F1A5 + c.charCodeAt(0)));
            let name = cc;
            try { name = new Intl.DisplayNames(['fr'], { type: 'region' }).of(cc) || cc; } catch (_) { /* ISO fallback */ }
            country = `${emoji} ${name}`;
        }
        const parts = [a.city, a.region_name, country].map(v => String(v || '').trim()).filter(Boolean);
        return [...new Set(parts)].join(' · ');
    }
    static signupLocationPrecision(attribution) {
        const a = attribution || {};
        if (a.city) return 'Ville indicative · précision faible';
        if (a.region_name || a.region_code) return 'Région indicative';
        if (a.country_code) return 'Pays indicatif';
        return 'Non disponible';
    }
    static signupOriginHtml(attribution) {
        const a = attribution || {};
        if (a.capture_stage === 'unavailable') {
            return '<div class="signup-origin"><span class="badge red">Indisponible</span><span class="signup-origin-note">Réessayer le chargement</span></div>';
        }
        const historical = a.capture_stage === 'historical_backfill';
        if (historical) {
            return '<div class="signup-origin"><span class="badge gray">Non capturé</span><span class="signup-origin-note">Compte antérieur au suivi</span></div>';
        }
        const pending = a.capture_stage === 'pending';
        const pendingActive = pending
            && Date.now() - new Date(a.signed_up_at || 0).getTime() <= 24 * 60 * 60 * 1000;
        if (pending && !pendingActive) {
            return '<div class="signup-origin"><span class="badge gray">Non capturé</span><span class="signup-origin-note">Fenêtre de capture terminée</span></div>';
        }
        const platform = AdminPage.signupPlatformLabel(a.signup_platform);
        const platformClass = a.signup_platform === 'mobile_android' ? 'green'
            : a.signup_platform === 'web' ? 'blue' : 'gray';
        const location = AdminPage.signupLocationText(a);
        const surface = AdminPage.signupSurfaceLabel(a.signup_surface);
        return `<div class="signup-origin">
            <div class="signup-origin-main"><span class="badge ${platformClass}">${AdminPage.esc(platform)}</span>${a.signup_surface === 'tv_pairing' ? '<span class="badge amber">Pairing TV</span>' : ''}</div>
            ${location ? `<div class="signup-origin-loc">${AdminPage.esc(location)}</div>` : `<div class="signup-origin-loc">${pendingActive ? 'Capture en attente' : 'Localisation non disponible'}</div>`}
            <div class="signup-origin-note">${AdminPage.esc(surface)}${a.location_source === 'cloudflare_edge' ? ' · réseau indicatif' : ''}</div>
        </div>`;
    }
    // Deterministic decorative provider icon (varies by name, like the mockup).
    static provIcon(name) {
        const ic = ['📡', '🛰️', '🌐', '📺', '⭐', '👑', '🚀', '⚡', '🎬', '🔻'];
        const s = String(name || ''); let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return ic[h % ic.length];
    }

    // ── Inline-SVG charts (self-contained, no external deps) ──
    // Donut from [{value,color}] segments; center shows top/bottom text.
    static donut(segments, centerTop, centerBottom) {
        const total = segments.reduce((s, x) => s + (Number(x.value) || 0), 0);
        const R = 52, C = 2 * Math.PI * R, cx = 64, cy = 64, sw = 15;
        let off = 0;
        const arcs = (total > 0 ? segments : []).map(s => {
            const len = C * ((Number(s.value) || 0) / total);
            if (len <= 0) return '';
            const el = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${s.color}" stroke-width="${sw}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
            off += len; return el;
        }).join('');
        return `<svg viewBox="0 0 128 128" width="128" height="128" role="img" aria-hidden="true">
            <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="${sw}"/>
            ${arcs}
            <text x="${cx}" y="${cy - 1}" text-anchor="middle" font-size="27" font-weight="750" fill="#eef1f8">${AdminPage.esc(String(centerTop))}</text>
            <text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="10" fill="#98a2b8">${AdminPage.esc(String(centerBottom || ''))}</text>
        </svg>`;
    }

    // Area chart from [{label,value}] — gradient fill + line + last-point dot + 3 x-labels.
    // Optional `overlay` (array of numbers, same length) draws a faint secondary line.
    static area(points, id, overlay) {
        const w = 720, h = 200, pl = 10, pr = 10, pt = 16, pb = 26;
        const vals = points.map(p => Number(p.value) || 0);
        const ov = Array.isArray(overlay) ? overlay.map(x => Number(x) || 0) : null;
        const max = Math.max(1, ...vals, ...(ov || [])), n = points.length;
        const X = i => n <= 1 ? pl : pl + (w - pl - pr) * i / (n - 1);
        const Y = v => pt + (h - pt - pb) * (1 - v / max);
        const line = points.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(vals[i]).toFixed(1)}`).join(' ');
        const gid = 'ag' + (id || '');
        const areaP = n ? `${line} L${X(n - 1).toFixed(1)},${h - pb} L${X(0).toFixed(1)},${h - pb} Z` : '';
        const ovLine = (ov && n) ? ov.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ') : '';
        const lbl = n ? [0, Math.floor((n - 1) / 2), n - 1].map(i =>
            `<text x="${X(i).toFixed(1)}" y="${h - 8}" font-size="11" fill="#6b7488" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${AdminPage.esc(points[i] ? points[i].label : '')}</text>`).join('') : '';
        return `<svg class="chart-svg" viewBox="0 0 ${w} ${h}" role="img" aria-hidden="true">
            <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5b7cfa" stop-opacity=".40"/><stop offset="1" stop-color="#5b7cfa" stop-opacity="0"/></linearGradient></defs>
            <path d="${areaP}" fill="url(#${gid})"/>
            ${ovLine ? `<path d="${ovLine}" fill="none" stroke="#8a93a6" stroke-width="1.8" stroke-opacity=".55" stroke-dasharray="4 3" stroke-linejoin="round"/>` : ''}
            <path d="${line}" fill="none" stroke="#8098ff" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
            ${n ? `<circle cx="${X(n - 1).toFixed(1)}" cy="${Y(vals[n - 1]).toFixed(1)}" r="3.6" fill="#b9c6ff"/>` : ''}
            ${lbl}
        </svg>`;
    }

    // Vertical bars from [{label,value,failed}] — gradient bars with a red failed overlay.
    // Interactive grouped bar chart (value + optional failed overlay). Gridlines, a y-axis, a
    // dashed average line, and per-column hover hitboxes carrying data for the JS tooltip
    // (wired by wireBars). `opts.unit` labels the value in the tooltip.
    static bars(items, id, opts) {
        opts = opts || {};
        const unit = opts.unit || 'exécutions';
        const w = 720, h = 220, pl = 34, pr = 12, pt = 14, pb = 30;
        const plotH = h - pt - pb, plotW = w - pl - pr;
        const vals = items.map(b => Number(b.value) || 0);
        const rawMax = Math.max(1, ...vals), n = items.length || 1;
        // "Nice" axis max (~3 ticks) so gridlines land on round numbers.
        const rough = rawMax / 3, pow = Math.pow(10, Math.floor(Math.log10(rough) || 0));
        const nn = rough / pow, step = (nn < 1.5 ? 1 : nn < 3 ? 2 : nn < 7 ? 5 : 10) * pow;
        const niceMax = Math.max(step, Math.ceil(rawMax / step) * step);
        const avg = vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : 0;
        const Y = v => (h - pb) - plotH * (v / niceMax);
        const slot = plotW / n, barW = Math.min(46, slot * 0.62);
        const gid = 'bg' + (id || '');
        // Gridlines + y labels.
        let grid = '';
        for (let t = 0; t <= niceMax + 0.001; t += step) {
            const gy = Y(t).toFixed(1);
            grid += `<line x1="${pl}" y1="${gy}" x2="${w - pr}" y2="${gy}" stroke="rgba(255,255,255,.06)" stroke-width="1"/>` +
                `<text x="${pl - 7}" y="${(Number(gy) + 3.5).toFixed(1)}" font-size="10" fill="#6b7488" text-anchor="end">${AdminPage.n(t)}</text>`;
        }
        // Average line (dashed).
        const avgY = Y(avg).toFixed(1);
        const avgLine = avg > 0 ? `<line x1="${pl}" y1="${avgY}" x2="${w - pr}" y2="${avgY}" stroke="#7c8cf8" stroke-width="1" stroke-dasharray="4 4" opacity=".5"/>` +
            `<text x="${w - pr}" y="${(Number(avgY) - 5).toFixed(1)}" font-size="9.5" fill="#8f9bc4" text-anchor="end">moy. ${AdminPage.n(Math.round(avg))}</text>` : '';
        const cols = items.map((b, i) => {
            const val = Number(b.value) || 0, failed = Number(b.failed) || 0;
            const x = pl + slot * i + (slot - barW) / 2;
            const bh = plotH * (val / niceMax), y = (h - pb) - bh;
            const fh = failed > 0 ? Math.min(bh, Math.max(3, plotH * (failed / niceMax))) : 0;
            const rate = val > 0 ? Math.round(100 * failed / val) : 0;
            const main = val > 0 ? `<rect class="bar-main" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, bh).toFixed(1)}" fill="url(#${gid})" rx="4"/>` : '';
            const fail = fh > 0 ? `<rect class="bar-fail" x="${x.toFixed(1)}" y="${(h - pb - fh).toFixed(1)}" width="${barW.toFixed(1)}" height="${fh.toFixed(1)}" fill="#f87171" rx="3"/>` : '';
            // Full-height transparent hitbox so hovering anywhere in the column triggers the tooltip.
            const box = `<rect class="barbox" x="${(pl + slot * i).toFixed(1)}" y="${pt}" width="${slot.toFixed(1)}" height="${plotH}"/>`;
            const label = `<text x="${(x + barW / 2).toFixed(1)}" y="${h - 10}" font-size="11" fill="#6b7488" text-anchor="middle">${AdminPage.esc(b.label || '')}</text>`;
            return `<g class="bar-col" data-label="${AdminPage.esc(b.label || '')}" data-value="${val}" data-failed="${failed}" data-rate="${rate}">${main}${fail}${box}${label}</g>`;
        }).join('');
        return `<div class="chart-wrap"><svg class="chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Graphique : ${unit} par jour">
            <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8b7cff"/><stop offset="1" stop-color="#5b7cfa"/></linearGradient></defs>
            ${grid}${avgLine}
            <line x1="${pl}" y1="${h - pb}" x2="${w - pr}" y2="${h - pb}" stroke="rgba(255,255,255,.14)" stroke-width="1"/>
            ${cols}
        </svg><div class="chart-tip" data-unit="${AdminPage.esc(unit)}"></div></div>`;
    }

    // Wire hover tooltips + focus-dim for a bars() chart inside `root`.
    static wireBars(root) {
        const wrap = root && root.querySelector('.chart-wrap');
        if (!wrap) return;
        const svg = wrap.querySelector('svg'), tip = wrap.querySelector('.chart-tip');
        const unit = (tip && tip.dataset.unit) || 'exécutions';
        const cols = Array.from(wrap.querySelectorAll('.bar-col'));
        const show = (col, e) => {
            svg.classList.add('dim');
            cols.forEach(c => c.classList.toggle('hl', c === col));
            const d = col.dataset, r = wrap.getBoundingClientRect();
            const failed = Number(d.failed) || 0;
            tip.innerHTML = `<div class="tt-d">${AdminPage.esc(d.label)}</div>` +
                `<div class="tt-r"><span class="tt-dot" style="background:#7c8cf8"></span><b>${AdminPage.n(d.value)}</b> ${AdminPage.esc(unit)}</div>` +
                (failed > 0
                    ? `<div class="tt-r"><span class="tt-dot" style="background:#f87171"></span><b>${AdminPage.n(failed)}</b> échec(s) · ${d.rate}% KO</div>`
                    : `<div class="tt-r" style="color:#6ee7bf"><span class="tt-dot" style="background:#34d399"></span>aucun échec</div>`);
            let left = e.clientX - r.left; const top = e.clientY - r.top - 14;
            left = Math.max(58, Math.min(r.width - 58, left));
            tip.style.left = left + 'px'; tip.style.top = Math.max(30, top) + 'px';
            tip.classList.add('on');
        };
        cols.forEach(col => {
            const box = col.querySelector('.barbox');
            if (!box) return;
            box.addEventListener('mousemove', (e) => show(col, e));
            box.addEventListener('mouseenter', (e) => show(col, e));
        });
        wrap.addEventListener('mouseleave', () => {
            tip.classList.remove('on'); svg.classList.remove('dim');
            cols.forEach(c => c.classList.remove('hl'));
        });
    }

    // Shared KPI card (icon top-right + optional sparkline). `sparkSvg` is a pre-built
    // spark string (or ''). Used by Providers/Clients; Cockpit/Finance keep local closures.
    static kpiCard(value, label, cls, icon, sparkSvg) {
        return `<div class="kpi ${cls || ''}"><div class="kpi-hd"><div class="v">${value}</div>${icon ? `<span class="kpi-ic">${icon}</span>` : ''}</div><div class="l">${label}</div>${sparkSvg ? `<div class="kpi-spark">${sparkSvg}</div>` : ''}</div>`;
    }

    // Mini sparkline for a KPI card. Forward/back-fills nulls (missing readings) so a
    // metric with one point draws a flat line rather than a fake dip. Colour by state.
    static spark(values, cls) {
        let vals = (Array.isArray(values) ? values : []).map(v => v == null ? null : Number(v));
        let last = null; vals = vals.map(v => { if (v != null) { last = v; return v; } return last; });
        let next = null; for (let i = vals.length - 1; i >= 0; i--) { if (vals[i] != null) next = vals[i]; else vals[i] = next; }
        vals = vals.map(v => (v == null || !Number.isFinite(v)) ? 0 : v);
        if (vals.length < 2) return '';
        const w = 180, h = 40, pt = 5, pb = 5, pl = 2, pr = 2, n = vals.length;
        const max = Math.max(...vals), min = Math.min(...vals), rng = (max - min) || 1;
        const X = i => pl + (w - pl - pr) * i / (n - 1);
        const Y = v => pt + (h - pt - pb) * (1 - (v - min) / rng);
        const color = cls === 'alert' ? '#f87171' : cls === 'ok' ? '#34d399' : '#7c93ff';
        const line = vals.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
        const areaP = `${line} L${X(n - 1).toFixed(1)},${h - pb} L${X(0).toFixed(1)},${h - pb} Z`;
        const gid = 'sp' + Math.random().toString(36).slice(2, 8);
        return `<svg class="chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
            <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".30"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
            <path d="${areaP}" fill="url(#${gid})"/>
            <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
        </svg>`;
    }
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
        const y = Math.round(mo / 12);
        return `il y a ${y} an${y > 1 ? 's' : ''}`;
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
