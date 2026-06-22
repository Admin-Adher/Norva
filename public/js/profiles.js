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
  let stylesInjected = false;
  let overlayEl = null;
  let resolveSelect = null;

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
html.tv .np-close{width:58px;height:58px;font-size:22px}
html.tv .np-avatar{width:200px;height:200px}
html.tv .np-card{width:200px}
html.tv .np-card:hover,html.tv .np-card:focus-visible{transform:scale(1.09)}
html.tv .np-title{font-size:54px}
html.tv .np-brand img{width:44px;height:44px}
html.tv .np-brand span{font-size:32px}
html.tv .np-name{font-size:20px}
html.tv .np-btn{min-height:60px;font-size:18px}
`;
    const style = el('style');
    style.id = 'norva-profiles-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function close() {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    document.removeEventListener('keydown', onKeydown);
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
    overlayEl = el('div', 'np-overlay');
    overlayEl.setAttribute('role', 'dialog');
    overlayEl.setAttribute('aria-modal', 'true');
    document.body.appendChild(overlayEl);
    document.addEventListener('keydown', onKeydown);
    render();
  }

  function render() {
    if (!overlayEl) return;
    if (state.mode === 'add' || state.mode === 'edit') renderEdit();
    else renderGrid();
  }

  // Land focus inside the overlay so a D-pad remote is immediately useful:
  // the name field when editing, otherwise the first profile card.
  function focusFirst() {
    setTimeout(() => {
      if (!overlayEl) return;
      const target = overlayEl.querySelector('.np-input') ||
        overlayEl.querySelector('.np-current') ||
        overlayEl.querySelector('.np-card') ||
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
      const card = el('button', 'np-card' + (manage ? ' np-card-manage' : '') + (!manage && p.id === activeId ? ' np-current' : ''));
      card.type = 'button';
      const av = el('div', 'np-avatar');
      av.appendChild(avatarImg(p.avatar_id, p.name));
      if (manage) av.appendChild(el('span', 'np-edit-badge', '✎'));
      card.appendChild(av);
      card.appendChild(el('span', 'np-name', p.name));
      card.addEventListener('click', () => { manage ? openEdit(p) : selectProfile(p); });
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
        if (isEdit) await profilesApi().update(state.editing.id, { name, avatarId: state.pickedAvatar });
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
        if (!window.confirm('Delete this profile? Its history and favorites will be removed.')) return;
        del.disabled = true; status.textContent = 'Deleting…';
        try {
          await profilesApi().remove(state.editing.id);
          if (profilesApi().getActiveId() === state.editing.id) profilesApi().setActiveId('');
          await loadProfiles();
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
    setTimeout(() => { try { nameInput.focus(); } catch (_) { } }, 0);
  }

  function selectProfile(p) {
    profilesApi().setActiveId(p.id);
    markPickedThisSession();
    if (resolveSelect) {
      const r = resolveSelect; resolveSelect = null;
      close();
      r(true);
    } else {
      // Switcher: reload so every surface refetches with the new profile.
      close();
      window.location.reload();
    }
  }

  // Public: ensure a profile is active before entering the app (login flow).
  async function ensureSelected() {
    if (!isCloud()) return true;
    let list;
    try { list = await loadProfiles(); } catch (_) { return true; } // fail open — never lock the app

    // One profile: auto-select, never gate.
    if (list.length <= 1) {
      if (list.length === 1) profilesApi().setActiveId(list[0].id);
      return true;
    }

    // Netflix-style: with several profiles show "Who's watching?" once per browser
    // session/login. The stored active id only pre-highlights the last pick — an
    // in-session reload keeps it, a new session/login shows the picker again.
    const activeId = profilesApi().getActiveId();
    if (pickedThisSession() && activeId && list.some((p) => p.id === activeId)) return true;

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

  window.NorvaProfiles = { ensureSelected, openSwitcher, openManage };
})();
