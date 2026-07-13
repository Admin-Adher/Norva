/**
 * Norva profiles — Netflix-style "Who's watching?" + profile management.
 *
 * Self-contained overlay module. Exposes window.NorvaProfiles:
 *   - ensureSelected(): shows the picker at login when needed; resolves once a
 *     profile is active (auto-selects when there is only one).
 *   - openSwitcher(): re-open the picker to switch profile (reloads on pick).
 *   - openManage(): open straight into manage mode.
 *
 * The active profile id lives in cloudApi (localStorage, sent as the
 * x-norva-profile-id header), so favorites / history / continue-watching are
 * scoped per profile server-side.
 */
(function () {
  'use strict';

  const AVATAR_COUNT = 12;
  const PLACEHOLDER = '/img/avatars/placeholder.svg';
  // Android TV renders this WebView at ~853x480 CSS px — very SHORT. Everything
  // below is gated on IS_TV so phone/web stays byte-for-byte unchanged.
  const IS_TV = /NorvaTV-AndroidTV/i.test(navigator.userAgent || '');
  let stylesInjected = false;
  let overlayEl = null;
  let previouslyFocused = null;   // element to restore focus to when the switcher closes
  let resolveSelect = null;
  let fitRO = null;          // ResizeObserver that re-fits the panel
  let fitOnResize = null;    // window resize/orientation handler (IME show/hide, etc.)

  const state = { profiles: [], limit: 1, canCreate: false, mode: 'select', editing: null, pickedAvatar: 'avatar-01', cameFrom: 'select' };

  function profilesApi() { return window.NorvaCloud && window.NorvaCloud.profiles; }
  function isCloud() {
    try { return !!(window.API && window.API.isCloudMode && window.API.isCloudMode()) && !!profilesApi(); }
    catch (_) { return false; }
  }
  function avatarSrc(id) { return profilesApi() ? profilesApi().avatarUrl(id) : (PLACEHOLDER); }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function avatarImg(id, alt) {
    const img = document.createElement('img');
    img.alt = alt || '';
    img.addEventListener('error', () => {
      if (img.src.indexOf('placeholder.svg') === -1) img.src = PLACEHOLDER;
    });
    img.src = avatarSrc(id);
    return img;
  }

  function avatarIdAt(index) {
    return 'avatar-' + String((index % AVATAR_COUNT) + 1).padStart(2, '0');
  }

  // Netflix-style gating is per browser session: once a profile is chosen we
  // don't re-prompt on in-session reloads, but a new session/login shows it again.
  const SESSION_FLAG = 'norva-profile-session';
  function pickedThisSession() {
    try { return sessionStorage.getItem(SESSION_FLAG) === '1'; } catch (_) { return false; }
  }
  function markPickedThisSession() {
    try { sessionStorage.setItem(SESSION_FLAG, '1'); } catch (_) { }
  }

  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    if (/NorvaTV-AndroidTV/i.test(navigator.userAgent || '')) {
      document.documentElement.classList.add('tv');
    }
    const css = `
.np-overlay{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;padding:24px;background:radial-gradient(125% 125% at 50% -10%,#161b24 0%,#0a0c11 55%);overflow:auto;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;animation:np-fade .35s ease both}
@keyframes np-fade{from{opacity:0}to{opacity:1}}
@keyframes np-rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.np-panel{width:min(960px,100%);text-align:center;color:#f8fafc;animation:np-rise .42s cubic-bezier(.2,.7,.2,1) both}
.np-panel-edit{width:min(560px,100%)}
.np-brand{display:flex;align-items:center;justify-content:center;gap:10px;margin:0 0 22px}
.np-brand img{width:34px;height:34px;border-radius:9px;display:block;object-fit:contain}
.np-brand span{font-family:'Century Gothic',sans-serif;font-size:25px;font-weight:500;letter-spacing:-.03em;color:#fff;padding-top:2px}
.np-title{font-size:clamp(30px,4.6vw,50px);font-weight:800;letter-spacing:-.015em;margin:0 0 40px}
.np-panel-edit .np-title{margin-bottom:14px}
.np-subtitle{color:#9aa6bd;font-size:15px;line-height:1.45;margin:0 0 26px}
.np-grid{display:flex;flex-wrap:wrap;gap:30px;justify-content:center}
.np-card{background:transparent;border:0;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:14px;width:160px;padding:8px;border-radius:16px;transition:transform .22s ease}
.np-card:hover,.np-card:focus-visible{transform:scale(1.07)}
.np-card:focus-visible{outline:none}
.np-avatar{width:160px;height:160px;border-radius:14px;overflow:hidden;background:#11151d;border:3px solid transparent;position:relative;display:grid;place-items:center;transition:border-color .22s ease,box-shadow .22s ease}
.np-avatar img{width:100%;height:100%;object-fit:cover}
.np-card:hover .np-avatar,.np-card:focus-visible .np-avatar{border-color:#fff;box-shadow:0 14px 40px rgba(0,0,0,.6)}
.np-name{color:#94a1b8;font-size:17px;font-weight:600;transition:color .22s ease}
.np-card:hover .np-name,.np-card:focus-visible .np-name{color:#fff}
.np-avatar-add{font-size:66px;color:#5f6b85;font-weight:200;transition:color .22s ease}
.np-card:hover .np-avatar-add,.np-card:focus-visible .np-avatar-add{color:#cdd6e6}
.np-avatar-lg{width:128px;height:128px;margin:0 auto 20px}
.np-edit-badge{position:absolute;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.45);color:#fff;font-size:34px;opacity:0;transition:opacity .2s ease}
.np-card:hover .np-edit-badge,.np-card:focus-visible .np-edit-badge{opacity:1}
/* Locked profile (over the plan's profile cap after a downgrade) — kept, just not
   usable. Greyed with a padlock; clicking it opens an upgrade upsell. */
.np-locked{opacity:.6;filter:grayscale(.65)}
.np-locked .np-avatar{border-color:#2a3446}
.np-locked .np-name{color:#6b7688}
.np-lock-badge{position:absolute;top:8px;right:8px;width:30px;height:30px;border-radius:50%;background:rgba(8,10,15,.85);border:1px solid #3a4560;display:grid;place-items:center;font-size:14px;line-height:1}
.np-card:hover.np-locked,.np-card:focus-visible.np-locked,.np-card:focus.np-locked{opacity:.85}
.np-actions{display:flex;gap:12px;justify-content:center;margin-top:48px;flex-wrap:wrap}
.np-btn{min-height:48px;padding:0 26px;border-radius:8px;border:1px solid #344158;background:#1a2130;color:#dbe7ff;font:inherit;font-weight:700;cursor:pointer;transition:transform .15s ease,border-color .15s ease,background .15s ease}
.np-btn:hover{transform:translateY(-1px)}
.np-btn-primary{background:#5b7cfa;border-color:#5b7cfa;color:#fff}
.np-btn-primary:hover{background:#6f8bff}
.np-btn-danger{background:transparent;border-color:rgba(251,113,133,.6);color:#fecdd3}
.np-btn-ghost{background:transparent;letter-spacing:.06em;text-transform:uppercase;font-size:13px;color:#9aa6bd}
.np-btn-ghost:hover{border-color:#5a6b86;color:#fff}
.np-btn:focus-visible{outline:3px solid #b579ff;outline-offset:2px}
.np-input{width:100%;max-width:360px;margin:0 auto 18px;display:block;padding:12px 14px;border-radius:8px;border:1px solid #344158;background:#11151d;color:#f8fafc;font:inherit;font-size:16px;text-align:center}
.np-avatars-label{color:#a8b3c7;font-size:13px;margin-bottom:10px}
.np-avatars{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-bottom:18px}
.np-avatar-choice{width:64px;height:64px;border-radius:10px;overflow:hidden;background:#11151d;border:3px solid transparent;cursor:pointer;padding:0;transition:transform .15s ease,border-color .15s ease}
.np-avatar-choice:hover{transform:scale(1.08)}
.np-avatar-choice img{width:100%;height:100%;object-fit:cover}
.np-avatar-choice.np-picked{border-color:#5b7cfa}
.np-avatar-choice:focus-visible{outline:2px solid #b579ff;outline-offset:2px}
.np-status{min-height:18px;color:#fecdd3;font-size:13px;margin:6px 0}
.np-close{position:absolute;top:20px;right:20px;width:46px;height:46px;border-radius:50%;border:1px solid #344158;background:rgba(17,21,29,.8);color:#dbe7ff;font-size:18px;cursor:pointer;z-index:2;transition:background .15s ease,transform .15s ease}
.np-close:hover{background:#1a2130;transform:scale(1.06)}
.np-close:focus-visible{outline:3px solid #b579ff;outline-offset:2px}
@media (prefers-reduced-motion:reduce){.np-overlay,.np-panel{animation:none}.np-card,.np-avatar,.np-name,.np-btn,.np-close,.np-avatar-choice,.np-edit-badge{transition:none}}
/* ---------- Android TV (~853x480) — compact base + zero-scroll ----------
   The WebView is SHORT (~480px), so the TV layout SHRINKS (not enlarges), and a
   JS auto-fit (fitPanel) scales the panel down for any leftover overflow. Fonts
   track viewport height (vh) so they adapt to the screen automatically. */
/* Container can never scroll; also neutralises tvNavigation's scrollIntoView lurch. */
html.tv .np-overlay{padding:16px;overflow:hidden}
/* Kill the entry animation on TV: a running np-rise transform would fight the
   inline fit-scale for 0.42s (visible jump-then-shrink). */
html.tv .np-panel{animation:none;transform-origin:center center;will-change:transform;backface-visibility:hidden}
html.tv .np-panel-edit{width:min(760px,100%)}
html.tv .np-close{width:48px;height:48px;font-size:20px;top:14px;right:14px}
html.tv .np-brand{margin:0 0 10px;gap:8px}
html.tv .np-brand img{width:30px;height:30px}
html.tv .np-brand span{font-size:24px}
/* Title font tracks viewport HEIGHT — auto-adapts to the screen. */
html.tv .np-title{font-size:clamp(24px,4.4vh,34px);line-height:1.1;margin:0 0 18px}
html.tv .np-panel-edit .np-title{margin-bottom:10px}
html.tv .np-subtitle{font-size:14px;margin:0 0 14px}
/* Grid: compact cards (border-box so padding doesn't blow the row) keep up to 6
   on one row at 853px — 6*116 + 5*14 = 766 < ~821 available. */
html.tv .np-grid{gap:14px;flex-wrap:wrap}
html.tv .np-card{box-sizing:border-box;width:116px;gap:10px;padding:4px}
html.tv .np-avatar{width:112px;height:112px}
html.tv .np-avatar-add{font-size:50px}
/* Name: single-line ellipsis so rows stay aligned and long names never wrap. */
html.tv .np-name{font-size:16px;max-width:108px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;line-height:1.2}
/* Fix the specificity bug: html.tv .np-avatar (0,2,1) was beating .np-avatar-lg
   (0,1,0) on the shared "np-avatar np-avatar-lg" preview → it ballooned to 200px.
   This selector is (0,3,1) and wins → the preview returns to a compact size. */
html.tv .np-panel-edit .np-avatar-lg{width:104px;height:104px;margin:0 auto 12px}
html.tv .np-input{max-width:340px;margin:0 auto 12px;min-height:44px;font-size:16px}
html.tv .np-avatars-label{font-size:13px;margin-bottom:8px}
html.tv .np-avatars{gap:6px;margin-bottom:12px;flex-wrap:wrap}
html.tv .np-avatar-choice{width:48px;height:48px}
html.tv .np-status{min-height:16px;font-size:13px;margin:4px 0}
html.tv .np-actions{margin-top:18px;gap:10px;flex-wrap:nowrap}
html.tv .np-btn{min-height:46px;font-size:16px;padding:0 22px}
/* :focus fallback — some WebViews don't fire :focus-visible for programmatic
   D-pad focus, so the selected card would show NO ring. Restore it on :focus.
   Unified 1.06 lift across hover/focus-visible/focus so a WebView firing both
   doesn't jitter. */
html.tv .np-card:hover,html.tv .np-card:focus-visible,html.tv .np-card:focus{transform:scale(1.06)}
html.tv .np-card:focus{outline:none}
html.tv .np-card:focus .np-avatar{border-color:#fff;box-shadow:0 10px 30px rgba(0,0,0,.6)}
html.tv .np-card:focus .np-name{color:#fff}
html.tv .np-card:focus .np-avatar-add{color:#cdd6e6}
html.tv .np-btn:focus{outline:3px solid #b579ff;outline-offset:2px}
html.tv .np-avatar-choice:focus{outline:2px solid #b579ff;outline-offset:2px}
`;
    const style = el('style');
    style.id = 'norva-profiles-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function close() {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    document.removeEventListener('keydown', onKeydown);
    if (fitRO) { fitRO.disconnect(); fitRO = null; }
    if (fitOnResize) {
      window.removeEventListener('resize', fitOnResize);
      window.removeEventListener('orientationchange', fitOnResize);
      fitOnResize = null;
    }
    // Restore focus to whatever opened the switcher (nav avatar / "Switch profile"),
    // so keyboard & Android TV D-pad users aren't dumped on <body>.
    const toFocus = previouslyFocused;
    previouslyFocused = null;
    if (toFocus && typeof toFocus.focus === 'function') { try { toFocus.focus(); } catch (_) { /* noop */ } }
  }

  async function loadProfiles() {
    const res = await profilesApi().list();
    state.profiles = Array.isArray(res && res.profiles) ? res.profiles : [];
    state.limit = Number(res && res.limit) || state.profiles.length || 1;
    state.canCreate = Boolean(res && res.canCreate);
    return state.profiles;
  }

  function buildOverlay() {
    injectStyles();
    close();
    previouslyFocused = document.activeElement;   // capture the opener AFTER clearing any stale overlay
    overlayEl = el('div', 'np-overlay');
    overlayEl.setAttribute('role', 'dialog');
    overlayEl.setAttribute('aria-modal', 'true');
    document.body.appendChild(overlayEl);
    document.addEventListener('keydown', onKeydown);
    // Re-fit on any viewport change (e.g. the on-screen keyboard showing/hiding
    // shrinks the visible area) so the panel is always fully on-screen.
    if (IS_TV && !fitOnResize) {
      fitOnResize = () => fitPanel();
      window.addEventListener('resize', fitOnResize);
      window.addEventListener('orientationchange', fitOnResize);
    }
    render();
  }

  // Android TV auto-fit: after a render, scale the panel DOWN just enough to fit
  // the short (~480px) screen so nothing ever scrolls, on any profile count or
  // screen size. Measured at transform:'none' (offset dims are transform-free),
  // so repeated runs are idempotent and never feed the ResizeObserver a loop.
  function fitPanel() {
    if (!IS_TV || !overlayEl) return;
    const p = overlayEl.querySelector('.np-panel');
    if (!p) return;
    const apply = () => {
      p.style.transform = 'none';
      const h = p.offsetHeight, w = p.offsetWidth;
      if (!h || !w) return;
      // Budget = overlay content box. clientHeight/Width INCLUDE padding, so subtract
      // the overlay's own padding, then a small safety margin so no sub-pixel row clips.
      const cs = getComputedStyle(overlayEl);
      const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const availH = (overlayEl.clientHeight || window.innerHeight) - padY - 8;
      const availW = (overlayEl.clientWidth || window.innerWidth) - padX - 8;
      let f = Math.min(availH / h, availW / w, 1);
      if (f > 0.985) f = 1;    // snap near-1 to avoid needless fractional softening
      if (f < 0.5) f = 0.5;    // legibility floor
      p.style.transformOrigin = 'center center';
      p.style.transform = f < 1 ? ('scale(' + f.toFixed(3) + ')') : 'none';
    };
    apply();
    requestAnimationFrame(apply);   // 2nd pass once layout/images settle
  }

  // Re-fit if the panel's natural size changes (late font load, avatar swap).
  function observeFit() {
    if (!IS_TV || !overlayEl) return;
    if (fitRO) { fitRO.disconnect(); fitRO = null; }
    const p = overlayEl.querySelector('.np-panel');
    if (window.ResizeObserver && p) { fitRO = new ResizeObserver(fitPanel); fitRO.observe(p); }
  }

  function render() {
    if (!overlayEl) return;
    if (state.mode === 'setup') renderSetup();
    else if (state.mode === 'add' || state.mode === 'edit') renderEdit();
    else renderGrid();
    if (IS_TV) {
      observeFit();
      fitPanel();
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitPanel);
    }
  }

  // Land focus inside the overlay so a D-pad remote is immediately useful:
  // the name field when editing, otherwise the first profile card.
  function focusFirst() {
    setTimeout(() => {
      if (!overlayEl) return;
      // On TV, never land on the name <input> first — focusing it summons the
      // on-screen keyboard that covers half the 480px screen. Prefer a card /
      // picked avatar / primary button; the user opts into the IME by pressing OK.
      const target = (!IS_TV && overlayEl.querySelector('.np-input')) ||
        overlayEl.querySelector('.np-current') ||
        overlayEl.querySelector('.np-card') ||
        overlayEl.querySelector('.np-avatar-choice.np-picked') ||
        overlayEl.querySelector('.np-btn-primary') ||
        overlayEl.querySelector('button');
      if (target) { try { target.focus(); } catch (_) { } }
    }, 40);
  }

  // Step back one screen: add/edit → where we came from, manage → select,
  // select → close (unless this is the forced login pick, which has no exit).
  function handleOverlayBack() {
    if (state.mode === 'add' || state.mode === 'edit') {
      state.mode = state.cameFrom || 'select';
      render();
      return;
    }
    if (state.mode === 'manage') {
      state.mode = 'select';
      render();
      return;
    }
    if (resolveSelect) return; // forced "Who's watching?" — a profile must be picked
    close();
  }

  // ✕ button — Back/Escape target on TV (the modal-close class lets the TV
  // navigation's closeTopModal() find and invoke it) and a tap target on web.
  function addCloseButton() {
    if (state.mode === 'select' && resolveSelect) return; // no exit at the forced pick
    const btn = el('button', 'np-close modal-close', '✕');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Back');
    btn.onclick = handleOverlayBack;
    overlayEl.appendChild(btn);
  }

  // Web fallback for Escape (on TV the capture-phase handler in tvNavigation.js
  // gets there first and stops propagation, so this never double-fires).
  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    if (state.mode === 'select' && resolveSelect) return;
    e.preventDefault();
    handleOverlayBack();
  }

  function renderGrid() {
    const manage = state.mode === 'manage';
    overlayEl.innerHTML = '';
    const panel = el('div', 'np-panel');
    if (!manage) {
      const brand = el('div', 'np-brand');
      const brandLogo = el('img');
      brandLogo.src = '/img/norva-app-icon.png';
      brandLogo.alt = '';
      brand.appendChild(brandLogo);
      brand.appendChild(el('span', null, 'Norva'));
      panel.appendChild(brand);
    }
    panel.appendChild(el('h1', 'np-title', manage ? 'Manage profiles' : "Who's watching?"));

    const activeId = profilesApi().getActiveId();
    const grid = el('div', 'np-grid');
    state.profiles.forEach((p) => {
      // A locked profile stays editable/deletable in MANAGE (so the user can free a
      // slot), but in the picker it can't be selected — clicking it upsells instead.
      const showLock = !!p.locked;
      const card = el('button', 'np-card'
        + (manage ? ' np-card-manage' : '')
        + (showLock ? ' np-locked' : '')
        + (!manage && !showLock && p.id === activeId ? ' np-current' : ''));
      card.type = 'button';
      const av = el('div', 'np-avatar');
      av.appendChild(avatarImg(p.avatar_id, p.name));
      if (manage) av.appendChild(el('span', 'np-edit-badge', '✎'));
      else if (showLock) av.appendChild(el('span', 'np-lock-badge', '🔒'));
      card.appendChild(av);
      card.appendChild(el('span', 'np-name', p.name));
      card.addEventListener('click', () => {
        if (manage) { openEdit(p); return; }
        if (p.locked) { handleLockedProfile(p); return; }
        selectProfile(p);
      });
      grid.appendChild(card);
    });

    if (!manage && state.canCreate) {
      const add = el('button', 'np-card np-add');
      add.type = 'button';
      add.appendChild(el('div', 'np-avatar np-avatar-add', '+'));
      add.appendChild(el('span', 'np-name', 'Add profile'));
      add.addEventListener('click', openAdd);
      grid.appendChild(add);
    }
    panel.appendChild(grid);

    const actions = el('div', 'np-actions');
    const manageBtn = el('button', 'np-btn np-btn-ghost', manage ? 'Done' : 'Manage profiles');
    manageBtn.type = 'button';
    manageBtn.addEventListener('click', () => { state.mode = manage ? 'select' : 'manage'; render(); });
    actions.appendChild(manageBtn);
    panel.appendChild(actions);

    overlayEl.appendChild(panel);
    addCloseButton();
    focusFirst();
  }

  function openAdd() {
    state.mode = 'add';
    state.cameFrom = 'select';
    state.editing = null;
    state.pickedAvatar = avatarIdAt(state.profiles.length);
    render();
  }
  function openEdit(p) {
    state.mode = 'edit';
    state.cameFrom = 'manage';
    state.editing = p;
    state.pickedAvatar = p.avatar_id || 'avatar-01';
    render();
  }

  function renderEdit() {
    const isEdit = state.mode === 'edit';
    overlayEl.innerHTML = '';
    const panel = el('div', 'np-panel np-panel-edit');
    panel.appendChild(el('h1', 'np-title', isEdit ? 'Edit profile' : 'Add profile'));

    const preview = el('div', 'np-avatar np-avatar-lg');
    const previewImg = avatarImg(state.pickedAvatar, '');
    preview.appendChild(previewImg);
    panel.appendChild(preview);

    const nameInput = el('input', 'np-input');
    nameInput.type = 'text';
    nameInput.maxLength = 40;
    nameInput.placeholder = 'Profile name';
    nameInput.value = isEdit ? (state.editing.name || '') : '';
    panel.appendChild(nameInput);

    panel.appendChild(el('div', 'np-avatars-label', 'Choose an avatar'));
    const avatars = el('div', 'np-avatars');
    for (let i = 0; i < AVATAR_COUNT; i++) {
      const id = avatarIdAt(i);
      const choice = el('button', 'np-avatar-choice' + (id === state.pickedAvatar ? ' np-picked' : ''));
      choice.type = 'button';
      choice.appendChild(avatarImg(id, id));
      choice.addEventListener('click', () => {
        state.pickedAvatar = id;
        previewImg.src = avatarSrc(id);
        avatars.querySelectorAll('.np-avatar-choice').forEach((c) => c.classList.remove('np-picked'));
        choice.classList.add('np-picked');
      });
      avatars.appendChild(choice);
    }
    panel.appendChild(avatars);

    const status = el('div', 'np-status', '');
    panel.appendChild(status);

    const actions = el('div', 'np-actions');

    const save = el('button', 'np-btn np-btn-primary', isEdit ? 'Save' : 'Create');
    save.type = 'button';
    save.addEventListener('click', async () => {
      const name = (nameInput.value || '').trim();
      if (!name) { status.textContent = 'Please enter a name.'; nameInput.focus(); return; }
      save.disabled = true; status.textContent = 'Saving…';
      try {
        if (isEdit) await profilesApi().update(state.editing.id, { name, avatarId: state.pickedAvatar, setupCompleted: true });
        else await profilesApi().create({ name, avatarId: state.pickedAvatar });
        await loadProfiles();
        state.mode = isEdit ? 'manage' : 'select';
        render();
      } catch (e) {
        status.textContent = (e && e.message) || 'Could not save the profile.';
        save.disabled = false;
      }
    });
    actions.appendChild(save);

    if (isEdit && state.profiles.length > 1) {
      const del = el('button', 'np-btn np-btn-danger', 'Delete');
      del.type = 'button';
      del.addEventListener('click', async () => {
        // Native window.confirm() is a dead-end on a D-pad remote (its buttons
        // aren't reliably focusable and it sits outside the modal trap). On TV use
        // NorvaModal (focus-trapped, Back→cancel). Web keeps window.confirm — zero
        // change off-TV.
        let ok;
        if (IS_TV && window.NorvaModal && typeof window.NorvaModal.confirm === 'function') {
          ok = await window.NorvaModal.confirm('Its history and favorites will be removed.', {
            title: 'Delete this profile?', confirmLabel: 'Delete', cancelLabel: 'Cancel', danger: true,
          });
        } else {
          ok = window.confirm('Delete this profile? Its history and favorites will be removed.');
        }
        if (!ok) return;
        del.disabled = true; status.textContent = 'Deleting…';
        try {
          const wasActive = profilesApi().getActiveId() === state.editing.id;
          await profilesApi().remove(state.editing.id);
          await loadProfiles();
          if (wasActive) {
            // Deleting the ACTIVE profile leaves no scoped identity. Switch to a remaining
            // profile (reloads home / favorites / history under it + closes the overlay)
            // instead of leaving the app showing the deleted profile's data with an
            // unscoped id (the previous setActiveId('') did neither).
            const next = state.profiles[0];
            if (next) { selectProfile(next); return; }
            profilesApi().setActiveId('');
          }
          state.mode = 'manage';
          render();
        } catch (e) {
          status.textContent = (e && e.message) || 'Could not delete the profile.';
          del.disabled = false;
        }
      });
      actions.appendChild(del);
    }

    const cancel = el('button', 'np-btn np-btn-ghost', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { state.mode = isEdit ? 'manage' : 'select'; render(); });
    actions.appendChild(cancel);

    panel.appendChild(actions);
    overlayEl.appendChild(panel);
    addCloseButton();
    // TV: don't auto-raise the IME — land on the picked avatar / Save button.
    if (IS_TV) {
      setTimeout(() => {
        const t = panel.querySelector('.np-avatar-choice.np-picked') || panel.querySelector('.np-btn-primary');
        if (t) { try { t.focus(); } catch (_) { } }
      }, 0);
    } else {
      setTimeout(() => { try { nameInput.focus(); } catch (_) { } }, 0);
    }
  }

  // One-time first-run personalisation of the auto-provisioned default profile.
  function renderSetup() {
    const p = state.editing || {};
    overlayEl.innerHTML = '';
    const panel = el('div', 'np-panel np-panel-edit');

    const brand = el('div', 'np-brand');
    const brandLogo = el('img');
    brandLogo.src = '/img/norva-app-icon.png';
    brandLogo.alt = '';
    brand.appendChild(brandLogo);
    brand.appendChild(el('span', null, 'Norva'));
    panel.appendChild(brand);

    panel.appendChild(el('h1', 'np-title', 'Set up your profile'));
    panel.appendChild(el('div', 'np-subtitle', 'Pick a name and an avatar — you can change them anytime.'));

    const preview = el('div', 'np-avatar np-avatar-lg');
    const previewImg = avatarImg(state.pickedAvatar, '');
    preview.appendChild(previewImg);
    panel.appendChild(preview);

    const nameInput = el('input', 'np-input');
    nameInput.type = 'text';
    nameInput.maxLength = 40;
    nameInput.placeholder = 'Profile name';
    nameInput.value = p.name || '';
    panel.appendChild(nameInput);

    panel.appendChild(el('div', 'np-avatars-label', 'Choose an avatar'));
    const avatars = el('div', 'np-avatars');
    for (let i = 0; i < AVATAR_COUNT; i++) {
      const id = avatarIdAt(i);
      const choice = el('button', 'np-avatar-choice' + (id === state.pickedAvatar ? ' np-picked' : ''));
      choice.type = 'button';
      choice.appendChild(avatarImg(id, id));
      choice.addEventListener('click', () => {
        state.pickedAvatar = id;
        previewImg.src = avatarSrc(id);
        avatars.querySelectorAll('.np-avatar-choice').forEach((c) => c.classList.remove('np-picked'));
        choice.classList.add('np-picked');
      });
      avatars.appendChild(choice);
    }
    panel.appendChild(avatars);

    const status = el('div', 'np-status', '');
    panel.appendChild(status);

    const actions = el('div', 'np-actions');
    const save = el('button', 'np-btn np-btn-primary', "Let's go");
    save.type = 'button';
    const skip = el('button', 'np-btn np-btn-ghost', 'Skip for now');
    skip.type = 'button';

    save.addEventListener('click', async () => {
      const name = (nameInput.value || '').trim();
      if (!name) { status.textContent = 'Please enter a name.'; nameInput.focus(); return; }
      save.disabled = true; skip.disabled = true; status.textContent = 'Saving…';
      try {
        await profilesApi().update(p.id, { name, avatarId: state.pickedAvatar, setupCompleted: true });
        finishSetup(p.id);
      } catch (e) {
        status.textContent = (e && e.message) || 'Could not save your profile.';
        save.disabled = false; skip.disabled = false;
      }
    });
    actions.appendChild(save);

    skip.addEventListener('click', async () => {
      save.disabled = true; skip.disabled = true;
      try { await profilesApi().update(p.id, { setupCompleted: true }); } catch (_) { /* enter anyway */ }
      finishSetup(p.id);
    });
    actions.appendChild(skip);

    panel.appendChild(actions);
    overlayEl.appendChild(panel);
    // TV: don't auto-raise the IME — land on the picked avatar / "Let's go".
    if (IS_TV) {
      setTimeout(() => {
        const t = panel.querySelector('.np-avatar-choice.np-picked') || panel.querySelector('.np-btn-primary');
        if (t) { try { t.focus(); } catch (_) { } }
      }, 0);
    } else {
      setTimeout(() => { try { nameInput.focus(); } catch (_) { } }, 0);
    }
  }

  function finishSetup(profileId) {
    if (profileId) profilesApi().setActiveId(profileId);
    markPickedThisSession();
    if (resolveSelect) { const r = resolveSelect; resolveSelect = null; close(); r(true); }
    else { close(); }
  }

  // A locked profile is over the plan's profile cap (after a Family→Plus downgrade).
  // It stays intact but isn't usable until the account upgrades — clicking it is an
  // upsell moment. Purchases exist ONLY on mobile/web, never on Android TV, so on TV
  // we can't open a checkout — point the user to their phone/web instead.
  function handleLockedProfile(p) {
    if (IS_TV) {
      const msg = 'This profile is locked on your current plan. Upgrade to Norva Family from your phone or the web to unlock it — your profile is kept safe until then.';
      if (window.NorvaModal && typeof window.NorvaModal.alert === 'function') {
        window.NorvaModal.alert(msg, { title: 'Profile locked' });
      }
      return;
    }
    const back = encodeURIComponent(location.pathname + location.search);
    window.location.href = '/subscribe.html?returnTo=' + back;
  }

  function selectProfile(p) {
    if (p && p.locked) { handleLockedProfile(p); return; }
    profilesApi().setActiveId(p.id);
    markPickedThisSession();
    if (resolveSelect) {
      const r = resolveSelect; resolveSelect = null;
      close();
      r(true);
    } else {
      // Switcher: soft-switch in place (no full reload) so it feels instant.
      // setActiveId above already dropped the previous profile's caches; the app
      // shell refetches Home + refreshes the avatar. Hard-reload fallback if the
      // shell isn't present (e.g. opened outside the SPA).
      close();
      if (window.app && typeof window.app.applyProfileSwitch === 'function') {
        window.app.applyProfileSwitch(p.name);
      } else {
        window.location.reload();
      }
    }
  }

  // Public: ensure a profile is active before entering the app (login flow).
  async function ensureSelected() {
    if (!isCloud()) return true;
    let list;
    try { list = await loadProfiles(); } catch (_) { return true; } // fail open — never lock the app

    // First run: the lone auto-provisioned profile hasn't been personalised yet
    // → one-time "Set up your profile" screen (name + avatar), with Skip.
    if (list.length === 1 && !list[0].setup_completed) {
      state.editing = list[0];
      state.pickedAvatar = list[0].avatar_id || 'avatar-01';
      state.mode = 'setup';
      return new Promise((resolve) => {
        resolveSelect = resolve;
        buildOverlay();
      });
    }

    // One profile (already set up): auto-select, never gate.
    if (list.length <= 1) {
      if (list.length === 1) profilesApi().setActiveId(list[0].id);
      return true;
    }

    // Netflix-style: with several profiles show "Who's watching?" once per browser
    // session/login. The stored active id only pre-highlights the last pick — an
    // in-session reload keeps it, a new session/login shows the picker again.
    // Skip the picker only if the stored active profile is still valid AND NOT locked
    // — a Family→Plus downgrade can turn the last-used profile into a locked one, in
    // which case we must re-show "Who's watching?" so the user picks an active profile.
    const activeId = profilesApi().getActiveId();
    if (pickedThisSession() && activeId && list.some((p) => p.id === activeId && !p.locked)) return true;

    state.mode = 'select';
    return new Promise((resolve) => {
      resolveSelect = resolve;
      buildOverlay();
    });
  }

  async function openSwitcher() {
    if (!isCloud()) return;
    try { await loadProfiles(); } catch (_) { return; }
    resolveSelect = null; // switcher reloads on pick
    state.mode = 'select';
    buildOverlay();
  }

  async function openManage() {
    if (!isCloud()) return;
    try { await loadProfiles(); } catch (_) { return; }
    resolveSelect = null;
    state.mode = 'manage';
    buildOverlay();
  }

  // The active profile object (by stored active id, else the first profile).
  function activeProfile() {
    const api = profilesApi();
    const id = api && api.getActiveId ? api.getActiveId() : '';
    return state.profiles.find((p) => p.id === id) || state.profiles[0] || null;
  }

  // Always-visible navbar avatar → opens the switcher. Discoverable entry point
  // so users switch profile in one tap instead of digging into Settings. Also
  // doubles as a "who am I" indicator (shows the active profile's avatar).
  async function refreshNavAvatar() {
    const btn = document.getElementById('nav-profile');
    const img = document.getElementById('nav-profile-img');
    if (!btn || !img) return;
    if (!isCloud()) { btn.hidden = true; return; }
    if (!state.profiles.length) {
      try { await loadProfiles(); } catch (_) { btn.hidden = true; return; }
    }
    const p = activeProfile();
    if (!p) { btn.hidden = true; return; }
    img.onerror = () => { if (img.src.indexOf('placeholder.svg') === -1) img.src = PLACEHOLDER; };
    img.src = avatarSrc(p.avatar_id);
    img.alt = p.name || 'Profile';
    // Keep the mobile bottom-bar Profile tab's avatar in sync with the same image.
    const tabImg = document.getElementById('nav-account-img');
    if (tabImg) tabImg.src = avatarSrc(p.avatar_id);
    btn.title = p.name ? `${p.name} — switch profile` : 'Switch profile';
    btn.setAttribute('aria-label', p.name ? `Profile ${p.name}, switch profile` : 'Switch profile');
    if (!btn.dataset.wired) {
      btn.addEventListener('click', () => { openSwitcher(); });
      btn.dataset.wired = '1';
    }
    btn.hidden = false;
  }

  // Lightweight snapshot for the mobile account sheet (no overlay needed).
  function current() {
    const p = activeProfile();
    return {
      isCloud: isCloud(),
      name: p ? (p.name || '') : '',
      avatarUrl: p ? avatarSrc(p.avatar_id) : PLACEHOLDER,
      count: state.profiles.length,
    };
  }

  window.NorvaProfiles = { ensureSelected, openSwitcher, openManage, refreshNavAvatar, current };
})();
