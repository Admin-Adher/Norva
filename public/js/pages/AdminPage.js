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
        this._users = { page: 0, limit: 25, search: '', sort: 'created_desc', tagId: '', billing: '', total: 0 };
        this._allTags = [];
        this._usersDebounce = null;
        this._lastTs = null; // snapshot refreshed_at for the topbar
        this._supportRows = [];
        this._supportTotal = 0;
        this._supportAllRows = null;
        this._supportAllFilter = null;
        this._supportSearchSeq = 0;
        this._flagOps = new Map(); // key -> desired state; serialises rapid TV/keyboard toggles
        this._flagDeletes = new Set();
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
        // Grouped into sections (rendered as sidebar headers) for fast comprehension.
        return [
            { key: 'cockpit', label: 'Cockpit', icon: '🎯', section: 'Business' },
            { key: 'finance', label: 'Finance', icon: '💶', section: 'Business' },
            { key: 'clients', label: 'Clients', icon: '👥', section: 'Business' },
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
  --adm-card1:#171c2b;--adm-card2:#111624;
  --adm-panel:rgba(255,255,255,.022);
  --adm-line:rgba(255,255,255,.07);--adm-line2:rgba(255,255,255,.045);
  --adm-tx:#eef1f8;--adm-tx2:#a2adc2;--adm-tx3:#828da3;
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
#page-admin .crm-side-foot{margin-top:auto;padding:11px 12px;font-size:11px;color:var(--adm-tx3);line-height:1.5;background:rgba(255,255,255,.03);border:1px solid var(--adm-line2);border-radius:11px;}
#page-admin .crm-main{flex:1;min-width:0;overflow-y:auto;-webkit-overflow-scrolling:touch;background:radial-gradient(1100px 520px at 78% -8%,rgba(91,124,250,.10),transparent 60%),radial-gradient(760px 420px at 8% 0%,rgba(168,85,247,.06),transparent 55%),var(--adm-bg);}
#page-admin .crm-topbar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:14px;padding:13px 26px;background:rgba(10,13,22,.82);backdrop-filter:blur(10px);border-bottom:1px solid var(--adm-line);}
#page-admin .crm-crumb{font-size:15px;font-weight:700;color:var(--adm-tx);}
#page-admin .crm-spacer{flex:1;}
#page-admin #crm-refresh{background:linear-gradient(135deg,#5b7cfa,#7c6cf5);color:#fff;border:0;border-radius:10px;padding:9px 16px;cursor:pointer;font-weight:600;font-size:13px;box-shadow:0 6px 18px rgba(91,124,250,.32);transition:transform .12s,box-shadow .12s,filter .12s;}
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
#page-admin th,#page-admin td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--adm-line2);white-space:normal;overflow-wrap:anywhere;vertical-align:top;}
#page-admin :is(th.num,td.num,.badge,.resync-btn){white-space:nowrap;}
#page-admin thead th{border-bottom:1px solid var(--adm-line);}
#page-admin tbody tr:last-child td{border-bottom:0;}
#page-admin th{color:var(--adm-tx3);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.5px;}
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
#page-admin .scroll{max-width:100%;overflow-x:auto;overscroll-behavior-inline:contain;scrollbar-gutter:stable;-webkit-overflow-scrolling:touch;}
#page-admin .sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important;}
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
#page-admin .chart-svg .bar-col{outline:none;}
#page-admin .chart-svg .bar-col:focus-visible .barbox{fill:rgba(91,124,250,.14);stroke:#9eb2ff;stroke-width:2;vector-effect:non-scaling-stroke;}
#page-admin .chart-data{margin-top:10px;}
#page-admin .chart-data summary{display:inline-flex;align-items:center;min-height:36px;color:#a9bcff;cursor:pointer;font-size:12px;font-weight:650;}
#page-admin .chart-data table{margin-top:8px;}
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
#page-admin .mot-inc-row{display:flex;align-items:center;gap:10px;width:100%;background:var(--adm-panel);border:1px solid var(--adm-line);border-left:3px solid var(--adm-red);border-radius:10px;padding:10px 14px;font:inherit;font-size:13px;color:inherit;text-align:left;}
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
/* Support header KPI cards (big icon on the left, like the mockup) */
#page-admin .sup-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(176px,1fr));gap:14px;margin-bottom:20px;}
#page-admin .sup-card{display:flex;align-items:center;gap:14px;width:100%;background:linear-gradient(158deg,var(--adm-card1),var(--adm-card2));border:1px solid var(--adm-line);border-radius:14px;padding:16px 18px;box-shadow:0 2px 10px rgba(0,0,0,.22);font:inherit;color:inherit;text-align:left;}
#page-admin .sup-card .ic{width:46px;height:46px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;background:rgba(120,150,255,.12);border:1px solid rgba(120,150,255,.18);}
#page-admin .sup-card.ok .ic{background:rgba(52,211,153,.12);border-color:rgba(52,211,153,.2);}
#page-admin .sup-card.alert .ic{background:rgba(248,113,113,.12);border-color:rgba(248,113,113,.2);}
#page-admin .sup-card .v{font-size:26px;font-weight:750;line-height:1;color:var(--adm-tx);}
#page-admin .sup-card.ok .v{color:var(--adm-green);}
#page-admin .sup-card.alert .v{color:var(--adm-red);}
#page-admin .sup-card .l{font-size:12px;color:var(--adm-tx2);text-transform:uppercase;letter-spacing:.4px;margin-top:5px;}
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
#page-admin .sla-chip{font-size:11px;font-weight:700;letter-spacing:.3px;padding:2px 7px;border-radius:5px;text-transform:uppercase;}
#page-admin .sla-chip.red{background:rgba(248,113,113,.18);color:#fca5a5;}
#page-admin .sla-chip.amber{background:rgba(251,191,36,.18);color:#fcd34d;}
@media(max-width:640px){#page-admin .inbox-row{grid-template-columns:1fr auto;}#page-admin .inbox-st{flex-direction:row;grid-column:1/-1;}}
/* Ticket view: sticky back bar, state banner, class-based thread, context sidebar, templates */
#page-admin .tk-back-bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 0;margin-bottom:6px;background:linear-gradient(180deg,var(--adm-bg) 70%,transparent);}
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
#page-admin .qv-chip.active,#page-admin .qv-chip[aria-pressed="true"]{background:linear-gradient(135deg,rgba(91,124,250,.2),rgba(168,85,247,.16));border-color:rgba(120,150,255,.4);color:#fff;}
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
#page-admin .kpi-state{display:inline-block;margin-left:8px;font-size:11px;font-weight:700;letter-spacing:.4px;padding:2px 6px;border-radius:5px;vertical-align:middle;}
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
#page-admin .switch{position:relative;display:inline-grid;place-items:center;width:44px;height:44px;flex-shrink:0;}
#page-admin .switch input{position:absolute;inset:0;z-index:2;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;}
#page-admin .switch .slider{position:relative;width:40px;height:22px;background:#3a3a44;border-radius:22px;transition:.2s;pointer-events:none;}
#page-admin .switch .slider:before{content:"";position:absolute;height:16px;width:16px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.2s;}
#page-admin .switch input:checked+.slider{background:#3ecf8e;}
#page-admin .switch input:checked+.slider:before{transform:translateX(18px);}
#page-admin .switch input:focus-visible+.slider{outline:3px solid #7c96ff;outline-offset:3px;}
#page-admin .switch input[aria-disabled="true"]+.slider{opacity:.65;}
#page-admin .flag-row.is-pending .switch{pointer-events:none;}
#page-admin .flag-row.is-pending{opacity:.82;}
#page-admin .flag-status{display:block;min-height:1.3em;margin-top:3px;color:var(--adm-tx3);font-size:11.5px;}
/* Breadcrumb can be a long email — keep it on one line with ellipsis so it never pushes the topbar controls off-screen. */
#page-admin .crm-crumb{max-width:min(52vw,560px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
/* Timeline/audit summaries: flex child needs min-width:0 to actually ellipsis/wrap instead of overflowing. */
#page-admin .tl-sum{min-width:0;overflow-wrap:anywhere;}
/* Visible keyboard focus for the interactive rows/cards/tabs/nav. */
#page-admin [role="button"][tabindex="0"]:focus-visible,#page-admin tr.user-row[tabindex="0"]:focus-visible,#page-admin button:focus-visible,#page-admin input:focus-visible,#page-admin select:focus-visible,#page-admin textarea:focus-visible,#page-admin summary:focus-visible{outline:2px solid #7c96ff;outline-offset:2px;border-radius:6px;}
/* Toasts + modal confirm/prompt (replace native alert/confirm/prompt). Scoped under #page-admin so the tokens apply. */
#page-admin .crm-toasts{position:fixed;right:18px;bottom:18px;z-index:60;display:flex;flex-direction:column;gap:8px;max-width:min(92vw,380px);}
#page-admin .crm-toast{background:var(--color-bg-secondary,#16161c);border:1px solid var(--color-border,#2a2a38);border-left:3px solid #5b7cfa;border-radius:9px;padding:11px 14px;font-size:13px;color:var(--color-text-primary,#e8e8ee);box-shadow:0 10px 30px #0009;animation:crmtoast .2s ease both;}
#page-admin .crm-toast.ok{border-left-color:#3ecf8e;}
#page-admin .crm-toast.err{border-left-color:#ff6b6b;}
@keyframes crmtoast{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}
@media(prefers-reduced-motion:reduce){#page-admin .crm-toast,#page-admin .crm-modal-back{animation:none;}}
#page-admin .crm-modal-back{position:fixed;inset:0;z-index:70;background:#000b;display:flex;align-items:center;justify-content:center;overflow-y:auto;padding:max(20px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left));animation:crmtoast .15s ease both;}
#page-admin .crm-modal{background:var(--color-bg-secondary,#16161c);border:1px solid var(--color-border,#2a2a38);border-radius:14px;padding:20px 22px;max-width:440px;max-height:min(90vh,680px);overflow-y:auto;width:100%;box-shadow:0 24px 70px #000b;}
#page-admin .crm-modal h3{margin:0 0 8px;font-size:16px;color:var(--color-text-primary,#fff);}
#page-admin .crm-modal p{margin:0 0 16px;font-size:13.5px;color:var(--color-text-secondary,#9aa);line-height:1.55;white-space:pre-wrap;word-break:break-word;}
#page-admin .crm-modal-input{width:100%;background:var(--color-bg-primary,#0d0d0f);border:1px solid var(--color-border,#2a2a38);color:#fff;border-radius:8px;padding:9px 12px;font-size:14px;margin-bottom:16px;}
#page-admin .crm-modal .mrow{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;}
#page-admin .crm-modal button{border-radius:8px;padding:8px 15px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--color-border,#2a2a38);background:var(--color-bg-primary,#0d0d0f);color:var(--color-text-primary,#fff);}
#page-admin .crm-modal button.primary{background:#5b7cfa;border-color:#5b7cfa;color:#fff;}
#page-admin .crm-modal button.danger{background:#e50914;border-color:#e50914;color:#fff;}
/* Small text remains legible on dense admin screens and from a TV viewing distance. */
#page-admin :is(.crm-nav-sec,.crm-side-foot,.kpi-gtitle,.kpi .l,.badge,.pacct,.chsub,.crm-hpill,.crm-hlive,.mot-drain,.mot-legend,.sup-tab .tab-n,.inbox-cli,.inbox-msgs,.ticket-msg-h,.tk-tpl,.src-cat,.src-sync,.id-actbtn,.svc-badge,.svc-err,.audit-day,.act-zone-h,.act-lbl,.fb-h,.tag-add-chip,.note-meta,.crm-note-del,.tl-at,.cs-l,.alert-fam-h,.al-err){font-size:12px;line-height:1.4;}
#page-admin :is(.sla-chip,.kpi-state,.sev-chip){font-size:11px;line-height:1.3;}

/* Mobile/tablet: the secondary CRM navigation becomes a horizontal strip instead of
   consuming a permanent 60 px column. The app's own navigation remains untouched. */
@media(max-width:900px){
  #page-admin .crm-shell{flex-direction:column;min-height:0;}
  #page-admin .crm-sidebar{display:block;width:100%;flex:0 0 auto;padding:7px 10px;overflow:hidden;border-right:0;border-bottom:1px solid var(--adm-line);}
  #page-admin .crm-brand,#page-admin .crm-side-foot,#page-admin .crm-nav-sec{display:none;}
  #page-admin #crm-nav{display:flex;gap:5px;min-width:0;overflow-x:auto;overscroll-behavior-inline:contain;scroll-snap-type:x proximity;scrollbar-width:none;-webkit-overflow-scrolling:touch;}
  #page-admin #crm-nav::-webkit-scrollbar{display:none;}
  #page-admin .crm-nav-item{flex:0 0 auto;width:auto;min-width:86px;min-height:48px;justify-content:center;gap:7px;margin:0;padding:7px 10px;text-align:center;scroll-snap-align:center;}
  #page-admin .crm-nav-item .lb{display:inline;font-size:11.5px;}
  #page-admin .crm-nav-item.active::before{left:10px;right:10px;top:auto;bottom:0;width:auto;height:3px;border-radius:3px 3px 0 0;}
  #page-admin .crm-nav-item.has-alerts::after{content:"";position:absolute;top:6px;right:7px;width:8px;height:8px;border-radius:50%;background:#e50914;box-shadow:0 0 0 2px var(--color-bg-primary,#0d0d0f);}
  #page-admin .crm-main{width:100%;min-height:0;}
  #page-admin .crm-topbar{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;padding:8px 12px;}
  #page-admin .crm-spacer{display:none;}
  #page-admin .crm-crumb{grid-column:1;grid-row:1;min-width:0;max-width:none;}
  #page-admin #crm-ts{grid-column:1;grid-row:2;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:11px;}
  #page-admin #crm-refresh{grid-column:2;grid-row:1/3;min-width:44px;min-height:44px;align-self:center;}
  #page-admin .crm-page{padding:18px 14px 80px;}
  #page-admin .users-controls input{min-width:0;}
}

/* Every regular data table is progressively enhanced with data-label attributes by JS.
   On phones, rows become readable cards instead of an ultra-wide horizontal surface. */
@media(max-width:680px){
  #page-admin table.crm-responsive-table,#page-admin .crm-responsive-table tbody{display:block;width:100%;}
  #page-admin .crm-responsive-table thead{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;}
  #page-admin .crm-responsive-table tr{display:block;margin-bottom:10px;padding:7px;border:1px solid var(--adm-line);border-radius:12px;background:var(--adm-panel);}
  #page-admin .crm-responsive-table td{position:relative;display:block;min-height:34px;padding:7px 8px 7px calc(38% + 12px);border:0;white-space:normal!important;text-align:left!important;}
  #page-admin .crm-responsive-table td::before{content:attr(data-label);position:absolute;inset-inline-start:8px;width:34%;color:var(--adm-tx3);font-size:11px;font-weight:700;letter-spacing:.35px;text-transform:uppercase;}
  #page-admin .crm-responsive-table td[data-label=""],#page-admin .crm-responsive-table td[colspan]{padding-inline-start:8px;}
  #page-admin .crm-responsive-table td[data-label=""]::before,#page-admin .crm-responsive-table td[colspan]::before{content:none;}
  #page-admin .crm-responsive-table td[data-mobile-value]:empty::after{content:attr(data-mobile-value);}
  #page-admin .crm-responsive-table tbody[hidden]{display:none!important;}
  #page-admin .crm-page{padding-inline:10px;}
  #page-admin .admin-block,#page-admin .kpi-group,#page-admin .chart-panel{padding-inline:13px;}
  #page-admin .crm-modal{max-height:calc(100dvh - 32px);padding:18px 16px;}
}

@media(max-width:420px){
  #page-admin #crm-ts{display:none;}
  #page-admin #crm-refresh{grid-row:1;padding:9px 12px;font-size:0;}
  #page-admin #crm-refresh::before{content:"↻";font-size:18px;}
}

@media(max-width:900px),(pointer:coarse){
  #page-admin :is(button,input:not([type="checkbox"]),select,textarea,summary,[role="button"]){min-height:44px;touch-action:manipulation;}
  #page-admin :is(.flag-del,.mini-btn,.crm-tag-remove,.crm-note-del){min-width:44px;}
  #page-admin :is(input,select,textarea){font-size:16px;}
}

/* TV keeps Norva's permanent global rail. The CRM navigation is a horizontal secondary
   strip, preventing a second competing left rail and preserving D-pad focus order. */
html.tv-mode #page-admin .crm-shell{flex-direction:column;min-height:0;}
html.tv-mode #page-admin .crm-sidebar{display:block;width:100%;flex:0 0 auto;padding:8px 12px;overflow:hidden;border-right:0;border-bottom:1px solid var(--adm-line);}
html.tv-mode #page-admin .crm-brand,html.tv-mode #page-admin .crm-side-foot,html.tv-mode #page-admin .crm-nav-sec{display:none;}
html.tv-mode #page-admin #crm-nav{display:flex;gap:6px;overflow-x:auto;overscroll-behavior-inline:contain;scrollbar-width:none;}
html.tv-mode #page-admin #crm-nav::-webkit-scrollbar{display:none;}
html.tv-mode #page-admin .crm-nav-item{flex:0 0 auto;width:auto;min-width:112px;min-height:54px;justify-content:center;gap:8px;margin:0;padding:8px 13px;font-size:13px;}
html.tv-mode #page-admin .crm-nav-item .lb{display:inline;}
html.tv-mode #page-admin .crm-nav-item.active::before{left:12px;right:12px;top:auto;bottom:0;width:auto;height:3px;}
html.tv-mode #page-admin .crm-main{width:100%;min-height:0;}
html.tv-mode #page-admin .crm-nav-item:focus-visible{color:#07101f;background:#fff;box-shadow:inset 0 0 0 2px #fff,0 0 0 3px #2387ff!important;}
</style>
<div class="crm-shell">
  <aside class="crm-sidebar" aria-label="Navigation de l’administration">
    <div class="crm-brand"><svg class="crm-logo" viewBox="0 0 48 48" width="30" height="30" fill="none" aria-hidden="true"><defs><linearGradient id="ncg" x1="7" y1="5" x2="41" y2="43" gradientUnits="userSpaceOnUse"><stop stop-color="#5b8cff"/><stop offset="1" stop-color="#a855f7"/></linearGradient></defs><rect x="1.6" y="1.6" width="44.8" height="44.8" rx="13" fill="#0b1022" stroke="url(#ncg)" stroke-width="1.7"/><circle cx="24" cy="25.5" r="11.5" fill="none" stroke="url(#ncg)" stroke-width="2.2" opacity=".8"/><circle cx="24" cy="21" r="4.4" fill="url(#ncg)"/><path d="M16 33.4c0-4.4 3.6-7.2 8-7.2s8 2.8 8 7.2z" fill="url(#ncg)"/><circle cx="24" cy="14" r="3.2" fill="#8fb0ff"/><circle cx="14" cy="31" r="3.2" fill="#6f8dff"/><circle cx="34" cy="31" r="3.2" fill="#c084fc"/></svg><span>Norva CRM</span></div>
    <nav id="crm-nav" aria-label="Sections de l’administration">${nav}</nav>
    <div class="crm-side-foot">Admin · accès restreint<br>rôle app_metadata.role</div>
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
        this._installResponsiveTables(root);
        // Delegated handlers on the stable root: sidebar nav, refresh, re-sync buttons, client rows.
        root.addEventListener('click', (e) => {
            const navItem = e.target.closest('.crm-nav-item');
            if (navItem) { this._navigate(navItem.dataset.route); return; }
            const rf = e.target.closest('#crm-refresh');
            if (rf) { this._refreshCurrent(rf); return; }
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
        
