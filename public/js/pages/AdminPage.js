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
            { key: 'finance', label: 'Finance', icon: '💶' },
            { key: 'clients', label: 'Clients', icon: '👥' },
            { key: 'support', label: 'Support', icon: '🎫' },
            { key: 'providers', label: 'Providers', icon: '📡' },
            { key: 'identites', label: 'Identités', icon: '🧬' },
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
            `<button class="crm-nav-item" data-route="${n.key}" title="${n.label}" aria-label="${n.label}"><span class="ic" aria-hidden="true">${n.icon}</span><span class="lb">${n.label}</span></button>`).join('');
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
#page-admin th,#page-admin td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--adm-line2);white-space:nowrap;}
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
/* Système: health gauge bar + Services ‖ Activité two-column */
#page-admin .kpi-bar{height:7px;border-radius:4px;background:rgba(255,255,255,.08);overflow:hidden;margin-top:11px;}
#page-admin .kpi-bar>i{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,#5b7cfa,#8b7cff);}
#page-admin .kpi.ok .kpi-bar>i{background:linear-gradient(90deg,#34d399,#22c1a6);}
#page-admin .kpi.alert .kpi-bar>i{background:linear-gradient(90deg,#f87171,#ef4444);}
#page-admin .sys-cols{display:grid;grid-template-columns:0.95fr 1.6fr;gap:16px;margin-bottom:18px;align-items:stretch;}
#page-admin .sys-cols > *{margin-bottom:0;min-width:0;}
@media(max-width:1000px){#page-admin .sys-cols{grid-template-columns:1fr;}}
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
#page-admin .crm-back{background:none;border:0;color:#a9bcff;cursor:pointer;font-size:13px;padding:0;margin-bottom:12px;}
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
#page-admin .user-row:focus-visible,#page-admin .alert-card:focus-visible,#page-admin .audit-row:focus-visible,#page-admin .tl-item[data-ticket-id]:focus-visible,#page-admin .fin-status:focus-visible,#page-admin .sup-tab:focus-visible,#page-admin .crm-nav-item:focus-visible,#page-admin .crm-back:focus-visible{outline:2px solid #7c96ff;outline-offset:-2px;border-radius:6px;}
/* Toasts + modal confirm/prompt (replace native alert/confirm/prompt). Scoped under #page-admin so the tokens apply. */
#page-admin .crm-toasts{position:fixed;right:18px;bottom:18px;z-index:60;display:flex;flex-direction:column;gap:8px;max-width:min(92vw,380px);}
#page-admin .crm-toast{background:var(--color-bg-secondary,#16161c);border:1px solid var(--color-border,#2a2a38);border-left:3px solid #5b7cfa;border-radius:9px;padding:11px 14px;font-size:13px;color:var(--color-text-primary,#e8e8ee);box-shadow:0 10px 30px #0009;animation:crmtoast .2s ease both;}
#page-admin .crm-toast.ok{border-left-color:#3ecf8e;}
#page-admin .crm-toast.err{border-left-color:#ff6b6b;}
@keyframes crmtoast{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}
@media(prefers-reduced-motion:reduce){#page-admin .crm-toast,#page-admin .crm-modal-back{animation:none;}}
#page-admin .crm-modal-back{position:fixed;inset:0;z-index:70;background:#000b;display:flex;align-items:center;justify-content:center;padding:20px;animation:crmtoast .15s ease both;}
#page-admin .crm-modal{background:var(--color-bg-secondary,#16161c);border:1px solid var(--color-border,#2a2a38);border-radius:14px;padding:20px 22px;max-width:440px;width:100%;box-shadow:0 24px 70px #000b;}
#page-admin .crm-modal h3{margin:0 0 8px;font-size:16px;color:var(--color-text-primary,#fff);}
#page-admin .crm-modal p{margin:0 0 16px;font-size:13.5px;color:var(--color-text-secondary,#9aa);line-height:1.55;white-space:pre-wrap;word-break:break-word;}
#page-admin .crm-modal-input{width:100%;background:var(--color-bg-primary,#0d0d0f);border:1px solid var(--color-border,#2a2a38);color:#fff;border-radius:8px;padding:9px 12px;font-size:14px;margin-bottom:16px;}
#page-admin .crm-modal .mrow{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;}
#page-admin .crm-modal button{border-radius:8px;padding:8px 15px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--color-border,#2a2a38);background:var(--color-bg-primary,#0d0d0f);color:var(--color-text-primary,#fff);}
#page-admin .crm-modal button.primary{background:#5b7cfa;border-color:#5b7cfa;color:#fff;}
#page-admin .crm-modal button.danger{background:#e50914;border-color:#e50914;color:#fff;}
@media(max-width:900px){
  #page-admin .crm-sidebar{width:60px;padding:14px 8px;}
  #page-admin .crm-nav-item .lb,#page-admin .crm-brand span:last-child,#page-admin .crm-side-foot{display:none;}
  #page-admin .crm-nav-item{justify-content:center;gap:0;position:relative;}
  /* .lb (with its ticket count) is hidden on the rail — surface a red dot on the icon instead. */
  #page-admin .crm-nav-item.has-alerts::after{content:"";position:absolute;top:8px;right:12px;width:8px;height:8px;border-radius:50%;background:#e50914;box-shadow:0 0 0 2px var(--color-bg-primary,#0d0d0f);}
  #page-admin .crm-page{padding:20px 16px 80px;}
  #page-admin .crm-topbar{padding:12px 16px;}
  #page-admin .crm-crumb{max-width:56vw;}
  #page-admin .users-controls input{min-width:0;}
}
</style>
<div class="crm-shell">
  <aside class="crm-sidebar">
    <div class="crm-brand"><svg class="crm-logo" viewBox="0 0 48 48" width="30" height="30" fill="none" aria-hidden="true"><defs><linearGradient id="ncg" x1="7" y1="5" x2="41" y2="43" gradientUnits="userSpaceOnUse"><stop stop-color="#5b8cff"/><stop offset="1" stop-color="#a855f7"/></linearGradient></defs><rect x="1.6" y="1.6" width="44.8" height="44.8" rx="13" fill="#0b1022" stroke="url(#ncg)" stroke-width="1.7"/><circle cx="24" cy="25.5" r="11.5" fill="none" stroke="url(#ncg)" stroke-width="2.2" opacity=".8"/><circle cx="24" cy="21" r="4.4" fill="url(#ncg)"/><path d="M16 33.4c0-4.4 3.6-7.2 8-7.2s8 2.8 8 7.2z" fill="url(#ncg)"/><circle cx="24" cy="14" r="3.2" fill="#8fb0ff"/><circle cx="14" cy="31" r="3.2" fill="#6f8dff"/><circle cx="34" cy="31" r="3.2" fill="#c084fc"/></svg><span>Norva CRM</span></div>
    <nav id="crm-nav">${nav}</nav>
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
        // Delegated handlers on the stable root: sidebar nav, refresh, re-sync buttons, client rows.
        root.addEventListener('click', (e) => {
            const navItem = e.target.closest('.crm-nav-item');
            if (navItem) { this._navigate(navItem.dataset.route); return; }
            const rf = e.target.closest('#crm-refresh');
            if (rf) { rf.disabled = true; rf.textContent = '↻ …'; this._navigate(this._route); setTimeout(() => { rf.disabled = false; rf.textContent = '↻ Rafraîchir'; }, 600); return; }
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
            if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
            const el = e.target.closest('.user-row,.alert-card[data-user-id],.alert-card[data-route],.audit-row[data-user-id],[data-ticket-id],.fin-status');
            if (el && e.target === el) { e.preventDefault(); el.click(); }
        });
        // Feature-flag switches fire 'change', not 'click' — delegate separately.
        root.addEventListener('change', (e) => {
            const ft = e.target.closest('.flag-toggle');
            if (ft) this._flagToggle(ft);
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
        const mapped = route.startsWith('client') ? 'clients' : (route.startsWith('ticket') ? 'support' : route);
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
            el.innerHTML = [
                card(n(c.open), 'Tickets ouverts', '', '🎫', 'open'),
                card(n(c.needs_reply), 'À répondre', Number(c.needs_reply) > 0 ? 'alert' : 'ok', '⏳', 'needs_reply'),
                card(n(c.in_progress), 'En cours', '', '🔄', 'pending'),
                card(n(c.resolved_7d), 'Résolus 7 j', 'ok', '✅', 'closed'),
                card(n(c.resolved_30d), 'Résolus 30 j', '', '📅')
            ].join('');
            el.querySelectorAll('.sup-card[data-filter]').forEach(cd => cd.addEventListener('click', () => this._pageSupport(cd.dataset.filter)));
            // Tab counts + urgency dot on "À répondre".
            const setCount = (k, val) => { const s = document.getElementById('sup-count-' + k); if (s) s.textContent = AdminPage.n(val); };
            setCount('needs_reply', c.needs_reply); setCount('open', c.open); setCount('in_progress', c.in_progress);
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
            const promptHtml = o.prompt ? `<input type="text" class="crm-modal-input" aria-labelledby="${uid}d" value="${AdminPage.esc(o.def || '')}" />` : '';
            back.innerHTML = `<div class="crm-modal"><h3 id="${uid}t">${AdminPage.esc(o.title || 'Confirmation')}</h3><p id="${uid}d">${AdminPage.esc(o.message)}</p>${promptHtml}
                <div class="mrow"><button class="cancel" type="button">Annuler</button><button class="ok ${o.danger ? 'danger' : 'primary'}" type="button">${AdminPage.esc(o.okLabel || 'OK')}</button></div></div>`;
            root.appendChild(back);
            if (shell) shell.setAttribute('inert', ''); // background can't be reached by pointer/tab/AT
            const input = back.querySelector('.crm-modal-input');
            const okBtn = back.querySelector('.ok');
            const cancelBtn = back.querySelector('.cancel');
            const cancelVal = o.prompt ? null : false;
            const okVal = () => o.prompt ? (input ? input.value.trim() : '') : true;
            const focusables = () => Array.from(back.querySelectorAll('input,button')).filter(el => !el.disabled);
            const finish = (val) => {
                document.removeEventListener('keydown', onKey, true);
                if (shell) shell.removeAttribute('inert');
                back.remove();
                if (prev && prev.focus) { try { prev.focus(); } catch (_) { /* gone */ } }
                resolve(val);
            };
            const onKey = (e) => {
                if (e.key === 'Escape') { e.preventDefault(); finish(cancelVal); return; }
                if (e.key === 'Tab') {
                    const f = focusables(); if (!f.length) return;
                    const first = f[0], last = f[f.length - 1], a = document.activeElement;
                    if (e.shiftKey && (a === first || !back.contains(a))) { e.preventDefault(); last.focus(); }
                    else if (!e.shiftKey && (a === last || !back.contains(a))) { e.preventDefault(); first.focus(); }
                    return;
                }
                if (e.key === 'Enter') {
                    if (document.activeElement === cancelBtn) return; // let Enter cancel when Cancel is focused
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
        return ({ clients: 'Retour aux clients', finance: 'Retour à la finance', cockpit: 'Retour au cockpit',
            systeme: 'Retour au système', identites: 'Retour aux identités', providers: 'Retour aux providers',
            moteur: 'Retour au moteur', support: 'Retour au support' })[route] || 'Retour';
    }

    _navigate(route) {
        const from = this._route;
        // Remember where a fiche was opened from so its back button returns there (not always Clients).
        // Keep the original entry across chained fiche→fiche hops (source row → another fiche).
        if (route.startsWith('client:') && from && !from.startsWith('client:')) this._ficheReturn = from;
        this._route = route;
        this._nav = (this._nav || 0) + 1; // monotonic token — stale async page/panel loads bail on mismatch
        this._setActiveNav(route);
        const main = document.querySelector('#page-admin .crm-main');
        if (main) { main.scrollTop = 0; main.focus({ preventScroll: true }); } // reset scroll + move focus into content (a11y)
        if (route === 'cockpit') this._pageCockpit();
        else if (route === 'finance') this._pageFinance();
        else if (route === 'clients') this._pageClients();
        else if (route === 'support') this._pageSupport();
        else if (route.startsWith('ticket:')) this._pageTicket(route.slice(7));
        else if (route.startsWith('client:')) this._pageClientDetail(route.slice(7));
        else if (route === 'providers') this._pageProviders();
        else if (route === 'identites') this._pageIdentites();
        else if (route === 'moteur') this._pageMoteur();
        else if (route === 'systeme') this._pageSysteme();
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
        const warnings = (Number(o.cron_fails_24h) > 0 ? 1 : 0) + (Number(o.gensubs_failed) > 50 ? 1 : 0);
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
        if (Number(o.cron_fails_24h) > 0) fam.crons.push(sysCard('red', 'À traiter', o.cron_fails_24h, 'échec(s) cron sur 24 h', 'systeme'));
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
            const [f, sparks] = await Promise.all([
                this._rpc('admin_finance'),
                this._rpc('admin_metric_sparks', { p_days: 14 }).catch(() => null) // sparklines are non-critical
            ]);
            this._renderFinance(f || {}, sparks && sparks.series);
        } catch (e) {
            const el = document.getElementById('fin-body');
            if (el) el.innerHTML = `<div class="admin-err" role="alert">Erreur : ${AdminPage.esc(e.message)}</div>`;
        }
    }

    _renderFinance(f, sparks) {
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
                return `<div class="hbar"><div class="hbar-l" title="${esc(r.label)}">${esc(r.label)}</div>` +
                    `<div class="hbar-track"><div class="hbar-fill ${cls || ''}" style="width:${pct}%"></div></div>` +
                    `<div class="hbar-v">${n(val)}</div></div>`;
            }).join('')}</div>`;
        };

        const FUNNEL_ORDER = ['signup', 'source_added', 'first_play', 'checkout_open', 'trial_start', 'trial_convert', 'renewal', 'cancel', 'save', 'winback_return'];
        const FUNNEL_LABELS = { signup: 'Inscriptions', source_added: '1ʳᵉ source ajoutée', first_play: '1ʳᵉ lecture', checkout_open: 'Checkout ouvert', trial_start: 'Essai démarré', trial_convert: 'Essai → payant', renewal: 'Renouvellements', cancel: 'Annulations', save: 'Clients sauvés', winback_return: 'Retours win-back' };
        const funnelMap = {};
        (Array.isArray(f.funnel_30d) ? f.funnel_30d : []).forEach(r => { funnelMap[r.stage] = r.users; });
        const funnelData = FUNNEL_ORDER.filter(s => funnelMap[s] != null).map(s => ({ label: FUNNEL_LABELS[s] || s, v: funnelMap[s] }));

        const REASONS = { too_expensive: 'Trop cher', not_using: 'Utilise pas assez', technical: 'Problème technique', other: 'Autre', skipped: 'Non précisé' };
        const reasonData = (Array.isArray(f.cancel_reasons) ? f.cancel_reasons : []).map(r => ({ label: REASONS[r.reason] || r.reason, v: r.n }));
        const savesTotal = Number(f.saves_total) || 0;
        const cancelsTotal = Number(f.cancels_total) || 0;
        const saveRate = (savesTotal + cancelsTotal) > 0 ? Math.round(100 * savesTotal / (savesTotal + cancelsTotal)) : null;

        const KIND_LABELS = { trial_setup: 'essai (carte)', first_charge: '1ᵉʳ prélèvement', renewal: 'renouvellement', plan_change: 'changement plan', resubscribe: 'réabonnement', card_update: 'MAJ carte' };
        // Payment status → business-readable FR label; raw provider status kept in a tooltip.
        const PAY_STATUS = { captured: 'Encaissé', authorized: 'Autorisé', to_capture: 'À encaisser', require_payment_method: 'Non finalisé', canceled: 'Annulé', refused: 'Refusé', expired: 'Expiré', disputed: 'Litige' };
        const payBadge = (s) => {
            const lbl = PAY_STATUS[s] || esc(s);
            const cls = s === 'captured' ? 'green' : (s === 'authorized' || s === 'to_capture') ? 'blue'
                : (s === 'require_payment_method') ? 'amber' : (s === 'refused' || s === 'disputed') ? 'red' : 'gray';
            return `<span class="badge ${cls}" title="Statut technique : ${esc(s)}">${lbl}</span>`;
        };

        // Payment rail (web vs mobile store) — the KPI dimension that separates Stancer-web
        // revenue from Google Play / App Store mobile revenue.
        const railBadge = AdminPage.railBadge;

        // Merge per-rail MRR/subscribers (by_rail) with per-rail cash collected (collected_by_rail).
        const railMap = {};
        const railBucket = (k) => (railMap[k] || (railMap[k] = { provider: k, n: 0, mrr_cents: 0, unknown_n: 0, collected_cents: 0, collected_n: 0 }));
        (Array.isArray(f.by_rail) ? f.by_rail : []).forEach(r => {
            const b = railBucket(r.provider); b.n = Number(r.n) || 0; b.mrr_cents = Number(r.mrr_cents) || 0; b.unknown_n = Number(r.unknown_n) || 0;
        });
        (Array.isArray(f.collected_by_rail) ? f.collected_by_rail : []).forEach(r => {
            const b = railBucket(r.provider); b.collected_cents = Number(r.cents) || 0; b.collected_n = Number(r.n) || 0;
        });
        const railList = Object.values(railMap).sort((a, b) => (b.mrr_cents - a.mrr_cents) || (b.collected_cents - a.collected_cents));
        const railRows = railList.map(r => `<tr>
            <td>${railBadge(r.provider)}</td>
            <td class="num">${n(r.n)}</td>
            <td class="num">${money(r.mrr_cents)}${r.unknown_n > 0 ? ` <span class="pacct" title="Abonnés sans montant connu">+${n(r.unknown_n)} ?</span>` : ''}</td>
            <td class="num">${money(r.collected_cents)}</td>
        </tr>`).join('');

        const payRows = (Array.isArray(f.recent_payments) ? f.recent_payments : []).map(p => `<tr class="user-row" data-user-id="${esc(p.user_id)}" tabindex="0" aria-label="Voir la fiche de ${esc(p.email || p.user_id)}" title="Voir la fiche">
            <td>${esc(day(p.at))}</td><td>${esc(p.email || p.user_id)}</td>
            <td>${railBadge(p.provider)}</td>
            <td>${KIND_LABELS[p.kind] || esc(p.kind)}</td><td>${payBadge(p.status)}</td>
            <td class="num">${money(p.amount)}${p.currency && String(p.currency).toLowerCase() !== 'usd' ? ` <span class="pacct">${esc(String(p.currency).toUpperCase())}</span>` : ''}</td>
        </tr>`).join('');

        // Revenue-risk signals (drives the risk-zone accent + header pill).
        const pastDue = Number(counts.past_due) || 0, cancelPending = Number(counts.cancel_pending) || 0, expired = Number(counts.expired) || 0;
        const anyRisk = pastDue > 0 || cancelPending > 0;
        // Total amount shown as a label note (a bare "4 199,60 $" would read as one number in fr-FR).
        const amtNote = (c) => ` <span class="pacct">· ${money(c)}</span>`;

        el.innerHTML = `
            <!-- 1 ── Résumé financier : les 5 métriques dominantes, en tête ── -->
            <div class="kpi-group kpi-group--priority"><div class="kpi-gtitle">💶 Résumé financier</div><div class="admin-cards">
                ${card(money(f.mrr_cents), 'MRR', Number(f.mrr_cents) > 0 ? 'ok' : '', 'mrr_cents', '💲')}
                ${card(money(f.arr_cents), 'ARR', '', 'arr', '📈')}
                ${card(money(f.collected_30d_cents), 'Encaissé 30 j', Number(f.collected_30d_cents) > 0 ? 'ok' : '', 'collected_30d_cents', '💰')}
                ${card(n(f.conversions_7d), 'Conversions 7 j', '', 'conversions_7d', '📊')}
                ${card(money(f.mrr_trial_cents), 'MRR potentiel essais', 'muted', null, '⏳', 'Revenu mensuel projeté si tous les essais en cours se convertissent — non encore encaissé.')}
            </div></div>
            <!-- 2 ── Risque revenu : tout ce qui menace le revenu, regroupé ── -->
            <div class="kpi-group kpi-group--risk ${anyRisk ? 'has-risk' : ''}"><div class="kpi-gtitle">⚠️ Risque revenu — cliquer un statut pour ouvrir la liste</div><div class="admin-cards">
                ${statusCard(n(pastDue), 'Échecs paiement', 'past_due', pastDue > 0 ? 'alert' : 'ok', '💳', stateChip(pastDue > 0, true))}
                ${statusCard(n(cancelPending), 'Annulations prévues', 'cancel_pending', cancelPending > 0 ? 'alert' : 'ok', '📅', stateChip(cancelPending > 0, false))}
                ${statusCard(n(expired), 'Expirés', 'expired', '', '⛔')}
                ${card(n(up.trial_charges_48h_n), 'Essais à prélever < 48 h' + amtNote(up.trial_charges_48h_cents), '', null, '⏰')}
                ${card(n(up.renewals_7d_n), 'Renouvellements < 7 j' + amtNote(up.renewals_7d_cents), '', null, '🔁')}
                ${Number(f.discounts_pending) > 0 ? card(n(f.discounts_pending), 'Remises 50% en attente', '', null, '🎟️') : ''}
            </div></div>
            <!-- 3 ── Analyse ── -->
            <div class="fin-cols">
                <div class="kpi-group"><div class="kpi-gtitle">👥 Abonnés — cliquer pour ouvrir la liste</div><div class="admin-cards fin-mini">
                    ${statusCard(n(counts.trialing), 'En essai', 'trialing', 'ok', '⏳')}
                    ${statusCard(n(counts.active), 'Actifs payants', 'active', 'ok', '👤')}
                    ${Number(f.mrr_unknown_n) > 0 ? card(n(f.mrr_unknown_n), 'Sans montant connu (manuel/store)', 'muted', null, '🗄️', 'Abonnés actifs dont le montant n\'est pas connu côté Norva (paiement manuel ou store mobile).') : ''}
                </div></div>
                <div class="admin-block"><h2>💳 Revenu par rail — web (Stancer) vs mobile (stores mobiles)</h2><div class="scroll">
                    ${railRows ? `<table><thead><tr><th>Rail</th><th class="num">Abonnés</th><th class="num">MRR</th><th class="num">Encaissé 30 j</th></tr></thead><tbody>${railRows}</tbody></table>` : '<div class="ssub">Aucun abonnement — la répartition Stancer / Google Play / App Store s\'affichera ici dès les premiers paiements.</div>'}
                </div></div>
            </div>
            <div class="fin-cols">
                <div class="admin-block"><h2>📊 MRR par plan, période & rail</h2><div class="scroll">
                    ${planRows ? `<table><thead><tr><th>Plan</th><th>Période</th><th>Rail</th><th class="num">Abonnés</th><th class="num">MRR</th></tr></thead><tbody>${planRows}</tbody></table>` : '<div class="ssub">Aucun abonnement payant.</div>'}
                </div></div>
                <div class="admin-block"><h2>🔀 Funnel de conversion (30 j)</h2>
                    ${funnelData.length ? hbars(funnelData, '') : '<div class="ssub">Aucune donnée funnel sur 30 j.</div>'}
                </div>
            </div>
            <div class="admin-block"><h2>🛑 Annulations & rétention</h2>
                <div class="admin-cards fin-mini" style="margin-bottom:16px">
                    ${card(n(cancelsTotal), 'Annulations (total)', '', null, '🛑')}
                    ${card(n(savesTotal), 'Clients sauvés', savesTotal > 0 ? 'ok' : '', null, '💚', 'Clients ayant renoncé à annuler après une contre-offre.')}
                    ${saveRate != null ? card(saveRate + ' %', 'Taux de sauvetage', saveRate >= 20 ? 'ok' : '', null, '🎯') : ''}
                </div>
                ${reasonData.length ? `<div class="kpi-gtitle" style="margin:0 0 8px">Raisons d'annulation</div>${hbars(reasonData, 'warn')}` : '<div class="ssub">Aucune annulation enregistrée — les raisons s\'accumuleront ici.</div>'}
            </div>
            <!-- 4 ── Ops : log opérationnel + export ── -->
            <div class="admin-block"><h2>🧾 Derniers paiements (50) <button id="fin-csv" class="mini-btn" title="Télécharger les 50 derniers paiements au format CSV">⬇ Exporter CSV</button></h2><div class="scroll">
                ${payRows ? `<table><thead><tr><th>Date</th><th>Client</th><th>Rail</th><th>Type</th><th>Statut</th><th class="num">Montant</th></tr></thead><tbody>${payRows}</tbody></table>` : '<div class="ssub">Aucun paiement.</div>'}
            </div></div>`;

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
            // Opening a status view is a fresh filter: clear any leftover search/tag so the count
            // shown on the card matches the list the user lands on.
            this._users.billing = c.dataset.billing || '';
            this._users.search = '';
            this._users.tagId = '';
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
            const lines = [['date', 'email', 'rail', 'type', 'statut', 'montant_cents', 'devise', 'pi_id', 'user_id'].map(q).join(',')]
                .concat(rows.map(p => [p.at, p.email, p.provider, p.kind, p.status, p.amount, p.currency, p.pi_id, p.user_id].map(q).join(',')));
            const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'norva-paiements.csv';
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
        const tabs = [['needs_reply', 'À répondre'], ['open', 'Ouverts'], ['pending', 'En attente'], ['closed', 'Fermés'], ['', 'Tous']];
        const countKey = { needs_reply: 'needs_reply', open: 'open', pending: 'in_progress' }; // tab → admin_support_counts key
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
        </div>`;
        const searchEl = document.getElementById('sup-search');
        if (searchEl) searchEl.addEventListener('input', () => {
            clearTimeout(this._supSearchDeb);
            this._supSearchDeb = setTimeout(() => { this._supportSearch = searchEl.value.trim(); this._renderSupportList(this._supportRows || []); }, 200);
        });
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
        try {
            const res = await this._rpc('admin_support_list', { p_status: this._supportFilter || null, p_limit: 100, p_offset: 0 });
            if (seq !== this._supportSeq) return; // a newer tab switch superseded this fetch
            this._supportRows = (res && res.rows) || [];
            this._renderSupportList(this._supportRows);
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
        // Client-side search across client email, subject and last message body.
        const q = (this._supportSearch || '').toLowerCase();
        if (q) rows = rows.filter(t => [t.email, t.user_id, t.subject, t.last_body].some(x => String(x || '').toLowerCase().includes(q)));
        if (!rows.length) {
            el.innerHTML = q
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
        el.innerHTML = `<div class="inbox">` + rows.map(t => `
            <div class="inbox-row ${rowCls(t)}" data-ticket-id="${AdminPage.esc(t.id)}" role="button" tabindex="0" aria-label="Ouvrir le ticket : ${AdminPage.esc(t.subject)}" title="Ouvrir le ticket">
                <div class="inbox-st">${chip(t)}${sla(t)}</div>
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
        el.querySelectorAll('.inbox-row[data-ticket-id]').forEach(r => {
            r.addEventListener('click', () => this._navigate('ticket:' + r.dataset.ticketId));
            r.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._navigate('ticket:' + r.dataset.ticketId); } });
        });
    }

    // ── Page: single ticket (thread + reply + status) ──
    async _pageTicket(ticketId) {
        this._setCrumb('Support › ticket');
        const nav = this._nav;
        const v = this._view();
        v.innerHTML = `<div class="crm-page"><div id="ticket-body">
            <button class="crm-back" data-back="support">← Retour aux tickets</button>
            <div class="ssub" style="margin-top:10px">Chargement…</div>
        </div></div>`;
        const back = v.querySelector('[data-back]');
        if (back) back.addEventListener('click', (e) => { e.stopPropagation(); this._navigate('support'); });
        try {
            const d = await this._rpc('admin_support_ticket', { p_id: ticketId });
            if (this._nav !== nav) return; // navigated away while the ticket loaded — don't paint stale
            this._renderTicket(d || {});
        } catch (e) {
            if (this._nav !== nav) return;
            const b = document.getElementById('ticket-body');
            if (b) b.innerHTML = `<div class="admin-err" role="alert">Erreur : ${AdminPage.esc(e.message)}</div>`;
        }
    }

    _renderTicket(d) {
        const body = document.getElementById('ticket-body');
        if (!body) return;
        const t = d.ticket || {};
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
        // Quick-reply templates (replies email the client in English).
        const TEMPLATES = [
            ['💳 Paiement', "Hi,\n\nWe've looked into the payment issue on your account. "],
            ['✉️ Confirmation', "Hi,\n\nWe've just re-sent your confirmation email — please check your inbox (and spam). "],
            ['📡 Source', "Hi,\n\nAbout your source/playlist: "],
            ['↩︎ Remboursement', "Hi,\n\nWe've processed your refund; it should appear on your statement within a few business days. "],
            ['❓ Infos', "Hi,\n\nCould you share a bit more detail (device, and a screenshot if possible) so we can help faster? "]
        ];
        this._ticketTemplates = TEMPLATES.map(x => x[1]);
        const filterLabel = { needs_reply: 'À répondre', open: 'Ouverts', pending: 'En attente', closed: 'Fermés', '': 'Tous' }[this._supportFilter || ''] || 'Support';
        body.innerHTML = `
            <div class="tk-back-bar">
              <button class="crm-back" data-back="support">← Retour · ${AdminPage.esc(filterLabel)}</button>
              ${statusChip}
            </div>
            <div class="fiche-head" style="margin-bottom:6px">
              <div><div class="fiche-title" style="font-size:18px">${AdminPage.esc(t.subject || '—')}</div>
              <div class="umeta"><a href="#" id="tk-client" style="color:#a9bcff">${AdminPage.esc(t.email || t.user_id || '')}</a>
                <span>· ouvert ${t.created_at ? AdminPage.esc(AdminPage.timeAgo(t.created_at)) : '—'}</span></div></div>
            </div>
            ${banner}
            <div class="tk-cols">
              <div>
                <div class="card" style="margin-bottom:14px"><div class="ticket-thread">${thread || '<div class="ssub">Aucun message.</div>'}</div></div>
                <div class="card">
                  <textarea id="tk-reply" class="ticket-reply" rows="3" placeholder="Répondre au client (le message part par email en anglais côté client — écris en anglais)…"></textarea>
                  <div class="tk-templates">${TEMPLATES.map((tp, i) => `<button class="tk-tpl" data-tpl="${i}" title="Insérer un modèle">${AdminPage.esc(tp[0])}</button>`).join('')}</div>
                  <div class="act-row" style="margin-top:8px">
                    <button class="act-btn" id="tk-send" style="background:#5b7cfa;border-color:#5b7cfa">📤 Envoyer la réponse</button>
                    ${!closed ? '<button class="act-btn act-danger" id="tk-close">✔ Fermer le ticket</button>' : '<button class="act-btn act-unsuspend" id="tk-reopen">↺ Rouvrir</button>'}
                  </div>
                  <div class="ssub" style="margin-top:8px">Envoyer une réponse passe le ticket « en attente client » et lui envoie un email.</div>
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
        if (back) back.addEventListener('click', (e) => { e.stopPropagation(); this._navigate('support'); });
        const openFiche = document.getElementById('tk-open-fiche');
        if (openFiche && t.user_id) openFiche.addEventListener('click', () => this._navigate('client:' + t.user_id));
        // Templates: insert into the reply box (append, don't clobber a draft).
        body.querySelectorAll('.tk-tpl').forEach(b => b.addEventListener('click', () => {
            const ta = document.getElementById('tk-reply'); if (!ta) return;
            const tpl = this._ticketTemplates[Number(b.dataset.tpl)] || '';
            ta.value = ta.value ? (ta.value.replace(/\s*$/, '') + '\n\n' + tpl) : tpl;
            ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length;
        }));
        if (t.user_id) this._loadTicketContext(t.user_id);
        const client = document.getElementById('tk-client');
        if (client && t.user_id) client.addEventListener('click', (e) => { e.preventDefault(); this._navigate('client:' + t.user_id); });
        const send = document.getElementById('tk-send');
        if (send) send.addEventListener('click', async () => {
            const ta = document.getElementById('tk-reply');
            const text = ta ? ta.value.trim() : '';
            if (text.length < 2) { this._toast('Écris une réponse avant d\'envoyer.', 'err'); if (ta) ta.focus(); return; }
            send.disabled = true; send.textContent = 'Envoi…';
            try { await this._supportEdge('/admin/reply', { ticket_id: t.id, body: text }); if (this._route === 'ticket:' + t.id) this._pageTicket(t.id); this._refreshSupportBadge(); }
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
            try { await this._supportEdge('/admin/status', { ticket_id: t.id, status: 'open' }); if (this._route === 'ticket:' + t.id) this._pageTicket(t.id); this._refreshSupportBadge(); }
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
                <input id="admin-users-search" type="search" placeholder="Rechercher un email ou un ID…" autocomplete="off" value="${AdminPage.esc(this._users.search)}" />
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
            const res = await this._rpc('admin_users_page', {
                p_limit: s.limit, p_offset: s.page * s.limit, p_search: s.search || null,
                p_sort: s.sort, p_tag_id: s.tagId || null, p_billing_status: s.billing || null
            });
            if (seq !== this._usersSeq) return; // superseded by a newer load
            const rows = (res && Array.isArray(res.rows)) ? res.rows : [];
            s.total = Number(res && res.total) || 0;
            if (res && Array.isArray(res.all_tags)) { this._allTags = res.all_tags; this._fillTagOptions(document.getElementById('admin-users-tag')); }
            this._renderUsers(rows);
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

    // Highlight the quick-view chip matching the active billing filter.
    _syncQuickViews() {
        const cur = this._users.billing || '';
        document.querySelectorAll('#admin-users-qv .qv-chip').forEach(c =>
            c.classList.toggle('active', (c.dataset.billing || '') === cur));
    }

    _renderUsers(rows) {
        const el = document.getElementById('admin-users');
        if (!el) return;
        if (!rows.length) { el.innerHTML = '<div class="ssub">Aucun utilisateur.</div>'; return; }
        const head = `<tr><th>Email</th><th>Abonnement</th><th>Rôle</th><th>Segments</th><th class="num">Sources</th><th>Inscrit</th><th>Dernière activité</th><th>Email vérifié</th></tr>`;
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
            return `<tr class="user-row" data-user-id="${AdminPage.esc(r.user_id)}" data-email="${AdminPage.esc(r.email || '')}" tabindex="0" aria-label="Voir la fiche de ${AdminPage.esc(r.email || r.user_id)}" title="Voir la fiche">
                <td>${AdminPage.esc(r.email || '—')}${driver}${internal}${banned}</td>
                <td>${AdminPage.billingBadge(r.billing_status, r.plan_code)}</td>
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
            const rows = await this._rpc('admin_users_export', {
                p_search: this._users.search || null,
                p_tag_id: this._users.tagId || null,
                p_billing_status: this._users.billing || null
            });
            const list = Array.isArray(rows) ? rows : [];
            // Strict CSV: every field quoted, internal quotes doubled, CRLF lines, BOM for Excel.
            // A leading =/+/-/@ is neutralized with a single quote so Excel/Sheets can't evaluate
            // an attacker-controlled email/tag as a formula.
            const q = (v) => {
                let s = String(v == null ? '' : v);
                if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
                return `"${s.replace(/"/g, '""')}"`;
            };
            const header = ['email', 'statut_abo', 'plan', 'periode', 'montant_cents', 'role', 'suspendu', 'email_verifie', 'inscrit', 'derniere_activite', 'sources', 'segments', 'user_id'];
            const lines = [header.map(q).join(',')].concat(list.map(r => [
                r.email, r.billing_status || 'free', r.plan_code || '', r.billing_period || '', r.amount_cents == null ? '' : r.amount_cents,
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
            <button class="crm-back">← ${AdminPage.routeLabel(this._ficheReturn || 'clients')}</button>
            <div id="fiche-body"><div class="ssub">Chargement…</div></div>
        </div>`;
        try {
            const d = await this._rpc('admin_user_detail', { p_user_id: userId });
            if (this._crmUser !== userId) return; // navigated to another client mid-fetch
            this._renderFiche(d);
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
        }
    }

    _renderBillingPanel(el, b, userId) {
        userId = userId || this._crmUser;
        const p = b.projection || null;
        const m = b.mapping || null;
        const pays = Array.isArray(b.payments) ? b.payments : [];
        const feedback = Array.isArray(b.cancel_feedback) ? b.cancel_feedback : [];
        const money = AdminPage.money, esc = AdminPage.esc;
        // Résumé-client "Abonnement" chip (payment risk surfaces red).
        const subMap = { active: ['Actif payant', 'ok'], trialing: ['En essai', 'ok'], past_due: ['Échec paiement', 'alert'], grace: ['Échec paiement', 'alert'], cancelled_at_period_end: ['Annulation prévue', 'warn'], expired: ['Expiré', 'alert'] };
        const sm = p ? (subMap[p.status] || [esc(p.status || '—'), '']) : ['Gratuit', ''];
        this._setFicheChip('fs-sub', '💳', sm[0], 'Abonnement', sm[1]);
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
            if (m && m.plan) details += row('Plan facturé', `${esc(m.plan)} · ${esc(m.period || '—')} · ${money(m.amount_cents)}`);
            // Mobile rails (Play/Apple) have no Stancer mapping — the recurring price/cadence lives
            // on the projection (stamped by the RevenueCat webhook).
            else if (p.mrr_cents != null) details += row('Plan facturé', `${esc(p.plan_code || 'plus')} · ${esc(p.bill_period || '—')} · ${money(p.mrr_cents)} <span class="pacct">(store)</span>`);
            if (p.trial_ends_at) details += row(new Date(p.trial_ends_at) > new Date() ? 'Essai jusqu\'au' : 'Essai terminé le', esc(dt(p.trial_ends_at)));
            if (p.current_period_end) details += row('Fin de période', esc(dt(p.current_period_end)));
            if (m && m.card_last4) details += row('Carte', `•••• ${esc(m.card_last4)}${m.card_exp ? ' · exp ' + esc(m.card_exp) : ''}`);
            if (Number(p.dunning_stage) > 0) details += row('Dunning', `<span class="badge red">relance ${esc(String(p.dunning_stage))}/3</span>${p.dunning_last_at ? ' · ' + esc(AdminPage.timeAgo(p.dunning_last_at)) : ''}`);
            if (m && m.discount_next_pct) details += row('Prochaine charge', `<span class="badge green">−${esc(String(m.discount_next_pct))} %</span> (contre-offre)`);
            else if (m && m.save_offer_used_at) details += row('Contre-offre', `utilisée ${esc(AdminPage.timeAgo(m.save_offer_used_at))}`);
            const mails = [];
            if (p.welcome_email_at) mails.push('welcome ' + AdminPage.timeAgo(p.welcome_email_at));
            if (p.trial_reminder_email_at) mails.push('rappel J-2 ' + AdminPage.timeAgo(p.trial_reminder_email_at));
            if (p.winback_email_at) mails.push('win-back ' + AdminPage.timeAgo(p.winback_email_at));
            if (mails.length) details += row('Emails lifecycle', esc(mails.join(' · ')));
        }

        const KIND_LABELS = { trial_setup: 'essai (carte)', first_charge: '1ᵉʳ prélèvement', renewal: 'renouvellement', plan_change: 'changement plan', resubscribe: 'réabonnement', card_update: 'MAJ carte' };
        // Payment status → business-readable FR label; raw provider status kept in a tooltip.
        const PAY_STATUS = { captured: 'Encaissé', authorized: 'Autorisé', to_capture: 'À encaisser', require_payment_method: 'Non finalisé', canceled: 'Annulé', refused: 'Refusé', expired: 'Expiré', disputed: 'Litige' };
        const payBadge = (s) => {
            const lbl = PAY_STATUS[s] || esc(s);
            const cls = s === 'captured' ? 'green' : (s === 'authorized' || s === 'to_capture') ? 'blue'
                : (s === 'require_payment_method') ? 'amber' : (s === 'refused' || s === 'disputed') ? 'red' : 'gray';
            return `<span class="badge ${cls}" title="Statut technique : ${esc(s)}">${lbl}</span>`;
        };
        // Show a rail column only when it adds signal: a mixed-rail history, or a single
        // non-Stancer rail (a pure Stancer history would just repeat "Stancer · web" on every row).
        const payProviders = new Set(pays.map(x => x.provider || 'stancer'));
        const showRailCol = payProviders.size > 1 || (payProviders.size === 1 && !payProviders.has('stancer'));
        // A row is refundable when it's a captured Stancer charge carrying an authoritative
        // paym_ id (refundable flag). The action column only appears if at least one qualifies.
        const canRefund = (x) => x.status === 'captured' && x.refundable && (!x.provider || x.provider === 'stancer');
        const showRefundCol = pays.some(canRefund);
        const payRows = pays.map(x => `<tr>
            <td>${esc(dt(x.updated_at || x.created_at))}</td>
            ${showRailCol ? `<td>${AdminPage.railBadge(x.provider)}</td>` : ''}
            <td>${KIND_LABELS[x.kind] || esc(x.kind)}</td>
            <td>${payBadge(x.status)}</td>
            <td class="num">${money(x.amount)}</td>
            ${showRefundCol ? `<td class="num">${canRefund(x) ? `<button class="mini-btn refund-btn" data-pi="${esc(x.pi_id)}" data-amount="${Number(x.amount) || 0}" title="Rembourser ce paiement">↩︎ Rembourser</button>` : ''}</td>` : ''}
        </tr>`).join('');

        const REASONS = { too_expensive: 'trop cher', not_using: 'utilise pas assez', technical: 'problème technique', other: 'autre', skipped: 'non précisé' };
        const fbRows = feedback.map(x => `<div class="ssub" style="margin-top:6px">${x.action === 'saved' ? '💚 Contre-offre acceptée' : '🛑 Annulation'} — raison : <b style="color:#e8e8ee">${REASONS[x.reason] || esc(x.reason)}</b> · ${esc(AdminPage.timeAgo(x.created_at))}</div>`).join('');

        el.innerHTML = `${details}
            ${payRows ? `<div style="margin-top:14px"><div class="kpi-gtitle">Historique des paiements</div><div class="scroll"><table><thead><tr><th>Date</th>${showRailCol ? '<th>Rail</th>' : ''}<th>Type</th><th>Statut</th><th class="num">Montant</th>${showRefundCol ? '<th></th>' : ''}</tr></thead><tbody>${payRows}</tbody></table></div></div>` : ''}
            ${fbRows}`;
        wireInternalToggle(this);
        el.querySelectorAll('.refund-btn').forEach(b => b.addEventListener('click', () => this._refundPayment(b, userId)));
    }

    // Refund a Stancer charge from the fiche → norva-stancer /admin/refund (admin-JWT-gated).
    // Full refund by default; the edge route sends the refund to Stancer, marks the ledger,
    // revokes access, and journals an admin_events row. Reloads the panel on success.
    async _refundPayment(btn, userId) {
        const pi = btn.dataset.pi;
        if (!pi || btn.disabled) return;
        const cents = Number(btn.dataset.amount) || 0;
        const amt = (cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if (!await this._confirm(`Rembourser ${amt} $ à ce client ?\n\nLe remboursement est envoyé à Stancer et l'accès du client sera révoqué immédiatement.`, { danger: true, okLabel: 'Rembourser' })) return;
        const orig = btn.textContent;
        btn.disabled = true; btn.textContent = '…';
        try {
            const res = await fetch(`${this._sbUrl()}/functions/v1/norva-stancer/admin/refund`, {
                method: 'POST',
                headers: { apikey: this._sbKey(), Authorization: `Bearer ${this._token()}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ pi_id: pi })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) throw new Error(data.error || String(res.status));
            this._toast(`Remboursé ${amt} $${data.revoked ? ' · accès révoqué' : ''} (${AdminPage.esc(data.refund_id || '')})`, 'ok');
            this._loadBilling(userId);
        } catch (e) {
            btn.disabled = false; btn.textContent = orig;
            this._toast('Erreur remboursement : ' + e.message, 'err');
        }
    }

    // ── Fiche: support tickets panel (open first, newest first, click → thread) ──
    async _loadUserTickets(userId) {
        const el = document.getElementById('fiche-tickets');
        if (!el) return;
        try {
            const res = await this._rpc('admin_support_list', { p_user_id: userId, p_limit: 10, p_offset: 0 });
            if (this._crmUser !== userId) return; // navigated away mid-fetch
            const rows = (res && res.rows) || [];
            const openCount = rows.filter(t => t.status !== 'closed').length;
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
        await this._crmMutate('admin_note_add', { p_user_id: this._crmUser, p_body: body });
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
        const sensitiveActions = `<div class="act-zone">
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
        v.innerHTML = `<div class="crm-page">
            <h1 class="crm-h1">🧬 Identités fournisseurs</h1>
            <p class="crm-sub">Une identité = un panel amont réel (dédup par empreinte de stream IDs). Plusieurs marques sur une même identité = revente miroir — le cache cross-user les fusionne.</p>
            <div id="admin-identities"><div class="ssub">Chargement…</div></div>
        </div>`;
        try {
            const ids = await this._rpc('admin_identities');
            this._renderIdentities(Array.isArray(ids) ? ids : []);
        } catch (e) {
            const el = document.getElementById('admin-identities');
            if (el) el.innerHTML = `<div class="admin-err" role="alert">Erreur : ${AdminPage.esc(e.message)}</div>`;
        }
    }

    _renderIdentities(list) {
        const el = document.getElementById('admin-identities');
        if (!el) return;
        if (!list.length) { el.innerHTML = '<div class="ssub">Aucune identité résolue.</div>'; return; }
        el.innerHTML = list.map(it => {
            const brands = Array.isArray(it.brands) ? it.brands : [];
            const sources = Array.isArray(it.sources) ? it.sources : [];
            const status = it.status === 'active' ? '<span class="badge green">active</span>'
                : `<span class="badge gray">${AdminPage.esc(it.status || '—')}</span>`;
            const mirror = brands.length > 1
                ? ' <span class="badge amber" title="Plusieurs marques revendues pointent vers le même panel amont">miroir multi-marques</span>' : '';
            const brandChips = brands.map(b => `<span class="badge blue">${AdminPage.esc(b)}</span>`).join(' ');
            const rows = sources.map(s => {
                const clickable = s.user_id ? ` class="user-row" data-user-id="${AdminPage.esc(s.user_id)}" tabindex="0" aria-label="Voir la fiche de ${AdminPage.esc(s.owner_email || s.display_name || '')}" title="Voir la fiche client"` : '';
                return `<tr${clickable}>
                    <td>${AdminPage.esc(s.display_name)}</td>
                    <td><span class="pacct">${AdminPage.esc(s.owner_email || '—')}</span>${s.is_driver ? ' <span class="badge blue">pilote</span>' : ''}</td>
                    <td>${s.sync_status === 'ready' ? '<span class="badge green">ready</span>' : `<span class="badge gray">${AdminPage.esc(s.sync_status || '—')}</span>`}</td>
                    <td>${s.last_synced_at ? AdminPage.esc(AdminPage.timeAgo(s.last_synced_at)) : '—'}</td>
                </tr>`;
            }).join('');
            const srcTable = sources.length
                ? `<div class="scroll"><table><thead><tr><th>Source</th><th>Compte</th><th>Statut</th><th>Dernier sync</th></tr></thead><tbody>${rows}</tbody></table></div>`
                : '<div class="ssub">Aucune source ne porte cette identité.</div>';
            return `<div class="card" style="margin-bottom:16px">
                <div style="display:flex;gap:13px;align-items:flex-start;margin-bottom:12px">
                    <div class="id-ic">${AdminPage.provIcon(it.display_name)}</div>
                    <div style="min-width:0;flex:1">
                        <div class="pname" style="font-size:16px">${AdminPage.esc(it.display_name)} ${status}${mirror}</div>
                        <div class="pacct">${AdminPage.n(it.key_count)} clé${Number(it.key_count) > 1 ? 's' : ''} provider · vue ${it.first_seen ? AdminPage.esc(AdminPage.timeAgo(it.first_seen)) : '—'} · dernière activité ${it.last_seen ? AdminPage.esc(AdminPage.timeAgo(it.last_seen)) : '—'}</div>
                        ${brandChips ? `<div class="tag-row" style="margin-top:8px">${brandChips}</div>` : ''}
                    </div>
                </div>
                ${srcTable}
            </div>`;
        }).join('');
    }

    // ── Page: Moteur (enrichment + crons) ──
    async _pageMoteur() {
        this._setCrumb('Moteur', this._lastTs);
        const v = this._view();
        v.innerHTML = `<div class="crm-page">
            <h1 class="crm-h1">⚙️ Moteur d'enrichissement</h1>
            <p class="crm-sub">Couverture par panel (comptes pilotes) + matching TMDB + crons jour/nuit.</p>
            <div class="admin-block"><h2>📊 Enrichissement par panel</h2><div class="scroll"><div id="admin-enrich"><div class="ssub">Chargement…</div></div></div></div>
            <div class="mot-cols">
                <div class="admin-block"><h2>🎯 Matching TMDB</h2><div class="ssub" style="margin-bottom:0">Backlogs drainés par les crons nocturnes (backfill-years 1000/j · search-match 3 600/j · revalidate 2 000/j) — ces compteurs doivent baisser de jour en jour.</div><section id="admin-tmdb" class="mot-tmdb"><div class="ssub">Chargement…</div></section></div>
                <div class="admin-block"><h2>⏱️ Crons</h2><div class="scroll"><div id="admin-cron"><div class="ssub">Chargement…</div></div></div></div>
            </div>
        </div>`;
        try {
            const [enrich, cron, ov] = await Promise.all([
                this._rpc('admin_enrichment_coverage'),
                this._rpc('admin_cron_health'),
                this._rpc('admin_overview')
            ]);
            this._renderEnrich(Array.isArray(enrich) ? enrich : []);
            this._renderCron(Array.isArray(cron) ? cron : []);
            this._renderTmdb(ov || {});
        } catch (e) {
            const msg = `<div class="admin-err" role="alert">Erreur : ${AdminPage.esc(e.message)}</div>`;
            const en = document.getElementById('admin-enrich');
            const cr = document.getElementById('admin-cron');
            const tm = document.getElementById('admin-tmdb');
            if (en) en.innerHTML = msg;
            if (cr) cr.innerHTML = msg;   // all three sections share the fetch — show the failure in each
            if (tm) tm.innerHTML = msg;
        }
    }

    _renderTmdb(o) {
        const el = document.getElementById('admin-tmdb');
        if (!el) return;
        const card = (v, l, cls, icon) => `<div class="kpi ${cls || ''}"><div class="v">${AdminPage.n(v)}</div><div class="l">${l}</div><div class="mot-ic">${icon}</div></div>`;
        // These fields appear after the post-audit snapshot refresh; '—' until then.
        el.innerHTML = [
            card(o.tmdb_year_backlog, 'Années manquantes', Number(o.tmdb_year_backlog) === 0 ? 'ok' : '', '📅'),
            card(o.tmdb_unmatched, 'Non matchés TMDB', '', '🗄️'),
            card(o.tmdb_unverified, 'À revalider', '', '🔄')
        ].join('');
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
            <div class="sys-cols">
                <div class="admin-block"><h2>🧩 Services temps réel <button id="sys-infra-refresh" class="mini-btn" aria-label="Re-pinger l'infra" title="Re-ping">↻</button></h2><div class="scroll"><div id="sys-infra"><div class="ssub">Ping…</div></div></div></div>
                <div class="chart-panel"><h2>📊 Activité système — exécutions cron / jour</h2><p class="chsub">14 derniers jours · barres = exécutions, rouge = échecs</p><div id="sys-activity"><div class="ssub">Chargement…</div></div></div>
            </div>
            <div class="admin-block"><h2>📜 Logs récents — journal d'audit</h2><div id="sys-audit"><div class="ssub">Chargement…</div></div></div>
            <div class="admin-block"><h2>💳 État billing / go-live <button id="sys-billing-refresh" class="mini-btn" aria-label="Re-vérifier l'état billing" title="Re-check">↻</button></h2><div id="sys-billing" class="admin-cards"><div class="ssub">Vérification…</div></div><p class="ssub" style="margin-top:8px">Bascule prod = poser les secrets Supabase (clé <code>sprod_</code>, <code>NORVA_STANCER_MODE=live</code>, <code>NORVA_BILLING_MODE=revenuecat</code>, <code>NORVA_ENTITLEMENTS_MODE=enforce</code>). Ce panneau doit alors passer tout au vert.</p></div>
            <div class="admin-block"><h2>🚩 Feature flags</h2><div id="sys-flags"><div class="ssub">Chargement…</div></div></div>
        </div>`;
        try {
            const [o, act] = await Promise.all([
                this._rpc('admin_overview'),
                this._rpc('admin_activity_series', { p_days: 14 }).catch(() => null)
            ]);
            if (this._nav !== nav) return; // navigated away — don't overwrite the new page's crumb
            this._lastTs = o && o.refreshed_at ? o.refreshed_at : this._lastTs;
            this._setCrumb('Système', this._lastTs);
            this._renderSysHealth(o, act);
            this._renderSysActivity(act);
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
        el.innerHTML = AdminPage.bars(items, 'sys') +
            `<div class="ssub" style="margin-top:8px">${chip('#6d7bf5')} exécutions&nbsp;&nbsp;${chip('#f87171')} échecs (${AdminPage.n(totFail)} sur 14 j)</div>`;
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
        // Services table (Service | Statut | Latence) — the mockup's SERVICES panel, on real pings.
        const row = (label, s) => {
            s = s || {};
            if (s.configured === false) return `<tr><td>${AdminPage.esc(label)}</td><td><span class="badge gray">non configuré</span></td><td class="num">—</td></tr>`;
            const up = s.ok === true;
            const badge = up ? '<span class="badge green">🟢 sain</span>' : '<span class="badge red">🔴 down</span>';
            const err = !up && s.error ? `<div class="al-err">${AdminPage.esc(String(s.error).slice(0, 80))}</div>` : '';
            const status = up && s.status != null ? ` <span class="pacct">${AdminPage.esc(String(s.status))}</span>` : '';
            return `<tr class="${up ? '' : 'bad'}"><td>${AdminPage.esc(label)}${err}</td><td>${badge}${status}</td><td class="num">${up && s.ms != null ? AdminPage.n(s.ms) + ' ms' : '—'}</td></tr>`;
        };
        el.innerHTML = `<table><thead><tr><th>Service</th><th>Statut</th><th class="num">Latence</th></tr></thead><tbody>${[row('Edge (API)', d.edge), row('Base de données', d.db), row('Gateway', d.gateway), row('Relay', d.relay)].join('')}</tbody></table>`;
        this._renderBillingState(d.billing);
    }

    // Go-live cockpit: the billing gate flags (read from edge secrets server-side) + Stancer/Resend
    // reachability. Before the prod flip everything reads TEST/legacy/observe; after the owner sets the
    // sprod_ key + live/enforce secrets, this panel turns green — the one place to verify the switch.
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
        const live = b.stancer_mode === 'live' && b.stancer_test_key === false && b.stancer_configured === true;
        const keyState = !b.stancer_configured ? '⚪ absente' : (b.stancer_test_key ? '🧪 stest_' : '🟢 sprod_');
        const resendOk = b.resend_configured && b.resend && b.resend.ok;
        el.innerHTML = [
            pill(live ? '🟢 LIVE' : '🧪 TEST', 'Mode Stancer', live ? 'ok' : ''),
            pill(keyState, 'Clé API', !b.stancer_configured ? 'alert' : (b.stancer_test_key ? '' : 'ok')),
            pill((b.footprint_currency || 'eur').toUpperCase(), 'Empreinte carte'),
            pill(b.billing_mode === 'legacy' ? 'legacy' : AdminPage.esc(b.billing_mode || '—'), 'Billing mode', b.billing_mode && b.billing_mode !== 'legacy' ? 'ok' : ''),
            pill(b.entitlements_mode === 'enforce' ? '🔒 enforce' : '👁 observe', 'Enforcement', b.entitlements_mode === 'enforce' ? 'ok' : ''),
            pill(b.lifecycle_billing_live ? 'on' : 'off', 'Relances / reçus', b.lifecycle_billing_live ? 'ok' : ''),
            pill(b.webhook_token_set ? 'posé' : '—', 'Webhook token'),
            svc('API Stancer', b.stancer),
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
        const rows = flags.map(f => `<div class="flag-row">
            <label class="switch"><input type="checkbox" class="flag-toggle" data-key="${AdminPage.esc(f.key)}" aria-label="Activer le flag ${AdminPage.esc(f.key)}" ${f.enabled ? 'checked' : ''}><span class="slider"></span></label>
            <div class="flag-meta"><div class="flag-key">${AdminPage.esc(f.key)}</div><div class="flag-desc">${AdminPage.esc(f.description || '')}${f.updated_by ? ` · ${AdminPage.esc(f.updated_by)}` : ''}</div></div>
            <button class="flag-del" data-key="${AdminPage.esc(f.key)}" aria-label="Supprimer le flag ${AdminPage.esc(f.key)}" title="Supprimer le flag">×</button>
        </div>`).join('');
        el.innerHTML = `${rows || '<div class="ssub">Aucun flag.</div>'}<div class="flag-add"><button class="flag-create tag-add-chip">＋ créer un flag</button></div>`;
    }

    async _flagToggle(input) {
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
    }

    _renderAudit(rows) {
        const el = document.getElementById('sys-audit');
        if (!el) return;
        if (!rows.length) { el.innerHTML = '<div class="ssub">Aucune action enregistrée pour l\'instant.</div>'; return; }
        const icon = (k) => ({ note_added: '📝', tag_added: '🏷️', tag_removed: '🏷️', admin_action: '⚡', resync: '↻', signup: '🎉', sync_started: '▶️', sync_done: '✅', sync_failed: '⚠️' }[k] || '•');
        const more = (this._audit && !this._audit.done)
            ? '<div style="margin-top:12px"><button id="sys-audit-more" class="tag-add-chip">⌄ Charger plus</button></div>' : '';
        el.innerHTML = '<div class="tl">' + rows.map(e => `<div class="tl-item audit-row"${e.user_id ? ` data-user-id="${AdminPage.esc(e.user_id)}" role="button" tabindex="0"` : ''}>
            <span class="tl-ic">${icon(e.kind)}</span>
            <span class="tl-sum">${AdminPage.esc(e.summary)}${e.client_email ? ` <span class="al-owner">· ${AdminPage.esc(e.client_email)}</span>` : ''}${e.actor ? ` <span class="ssub">par ${AdminPage.esc(e.actor)}</span>` : ''}</span>
            <span class="tl-at" title="${e.created_at ? AdminPage.esc(new Date(e.created_at).toLocaleString('fr-FR')) : ''}">${e.created_at ? AdminPage.esc(AdminPage.timeAgo(e.created_at)) : ''}</span>
        </div>`).join('') + '</div>' + more;
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
                card(money(o.billing_collected_30d_cents), 'Encaissé 30 j', '', 'collected_30d_cents', '💰')
            ]),
            group('👥 Clients & croissance', [
                card(n(o.users_total), 'Utilisateurs', o.users_active_7d ? 'ok' : '', 'users_total', '👥'),
                // "Connectés" = last_sign_in_at (sessions persist — undercounts real activity);
                // "Regardent" = distinct watch-history users, the truthful activity signal.
                card(n(o.users_active_24h), 'Connectés 24 h', '', 'users_active_24h', '🕐'),
                card(n(o.users_active_7d), 'Connectés 7 j', '', 'users_active_7d', '🗓️'),
                card(n(o.users_watching_7d), 'Regardent 7 j', Number(o.users_watching_7d) > 0 ? 'ok' : '', 'users_watching_7d', '👁️'),
                card(n(o.users_new_7d), 'Nouveaux 7 j', Number(o.users_new_7d) > 0 ? 'ok' : '', 'users_new_7d', '➕'),
                card(n(o.users_new_30d), 'Nouveaux 30 j', '', 'users_new_30d', '📅')
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
        if (!rows.length) { el.innerHTML = '<div class="ssub">Aucune donnée.</div>'; return; }
        const barCell = (a, p) => `<td class="num"><span class="bar"><i style="width:${Math.min(100, Number(p) || 0)}%"></i></span>${AdminPage.n(a)} (${Number(p) || 0}%)</td>`;
        const eta = (r) => {
            if (Number(r.never_probed) === 0) {
                const undPct = Math.max(0, Math.round((100 - (Number(r.resolved_pct) || 0)) * 10) / 10);
                return `<span class="badge green" title="1ʳᵉ passe de sondage terminée : chaque titre a été sondé au moins une fois. Les ~${undPct}% non résolus sont « und » dans le conteneur (aucune langue déclarée) — seul whisper peut les résoudre.">✓ sondé</span>`;
            }
            if (Number(r.probed_24h) >= 20 && Number(r.resolved_24h) === 0) return `<span class="badge red" title="Sondé ${AdminPage.n(r.probed_24h)} en 24 h mais 0 langue résolue — provider probablement muet / identifiants morts / banni (le signal qui a manqué pour l'incident Ninja).">⚠ provider muet</span>`;
            if (Number(r.probed_24h) === 0) return '<span class="badge red">⏸ à l\'arrêt</span>';
            if (Number.isFinite(Number(r.eta_days)) && Number(r.eta_days) > 365) return `<span class="badge gray" title="~${AdminPage.n(r.eta_days)} j au rythme actuel — débit quasi nul, chiffre non actionnable.">≫ 1 an</span>`;
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
            const failing = Number(r.fails_24h) > 0;
            const newGroup = r.window !== prevWin;
            prevWin = r.window;
            const state = paused ? `<span class="badge gray">pause</span>`
                : (failing ? `<span class="badge red">échecs</span>` : `<span class="badge green">actif</span>`);
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
    // Payment rail (provider) → human label + badge. Separates web (Stancer) from mobile stores.
    static railLabel(p) {
        const map = { stancer: 'Stancer · web', google_play: 'Google Play · mobile', apple_app_store: 'App Store · mobile', system: 'Comp / système', manual: 'Manuel', revenuecat: 'RevenueCat', web: 'Web', stripe: 'Stripe' };
        return map[p] || (p ? AdminPage.esc(p) : '—');
    }
    static railBadge(p) {
        const cls = p === 'stancer' ? 'blue' : (p === 'google_play' || p === 'apple_app_store') ? 'green' : 'gray';
        return `<span class="badge ${cls}">${AdminPage.railLabel(p)}</span>`;
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
    static bars(items, id) {
        const w = 720, h = 210, pl = 10, pr = 10, pt = 16, pb = 28;
        const vals = items.map(b => Number(b.value) || 0);
        const max = Math.max(1, ...vals), n = items.length || 1;
        const slot = (w - pl - pr) / n, barW = Math.min(48, slot * 0.6);
        const gid = 'bg' + (id || '');
        const rects = items.map((b, i) => {
            const x = pl + slot * i + (slot - barW) / 2;
            const bh = (h - pt - pb) * ((Number(b.value) || 0) / max), y = h - pb - bh;
            const fh = b.failed ? (h - pt - pb) * ((Number(b.failed) || 0) / max) : 0;
            const fail = fh > 0 ? `<rect x="${x.toFixed(1)}" y="${(h - pb - fh).toFixed(1)}" width="${barW.toFixed(1)}" height="${fh.toFixed(1)}" fill="#f87171" rx="3"/>` : '';
            return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, bh).toFixed(1)}" fill="url(#${gid})" rx="4"/>${fail}
                <text x="${(x + barW / 2).toFixed(1)}" y="${h - 9}" font-size="11" fill="#6b7488" text-anchor="middle">${AdminPage.esc(b.label || '')}</text>`;
        }).join('');
        return `<svg class="chart-svg" viewBox="0 0 ${w} ${h}" role="img" aria-hidden="true">
            <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8b7cff"/><stop offset="1" stop-color="#5b7cfa"/></linearGradient></defs>
            ${rects}
        </svg>`;
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
