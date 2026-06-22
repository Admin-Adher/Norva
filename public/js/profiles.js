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

  const state = { profiles: [], limit: 1, canCreate: false, mode: 'select', editing: null, pickedAvatar: 'avatar-01' };

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

  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    if (/NorvaTV-AndroidTV/i.test(navigator.userAgent || '')) {
      document.documentElement.classList.add('tv');
    }
    const css = `
.np-overlay{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;padding:24px;background:#090b10;overflow:auto;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
.np-panel{width:min(900px,100%);text-align:center;color:#f8fafc}
.np-panel-edit{width:min(560px,100%)}
.np-title{font-size:clamp(26px,4vw,40px);font-weight:800;margin:0 0 28px}
.np-grid{display:flex;flex-wrap:wrap;gap:24px;justify-content:center}
.np-card{background:transparent;border:0;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:10px;width:140px;padding:8px;border-radius:14px}
.np-avatar{width:140px;height:140px;border-radius:14px;overflow:hidden;background:#11151d;border:3px solid transparent;position:relative;display:grid;place-items:center}
.np-avatar img{width:100%;height:100%;object-fit:cover}
.np-card:hover .np-avatar,.np-card:focus-visible .np-avatar{border-color:#fff}
.np-card:focus-visible{outline:none}
.np-name{color:#a8b3c7;font-size:16px;font-weight:600}
.np-card:hover .np-name,.np-card:focus-visible .np-name{color:#fff}
.np-avatar-add{font-size:64px;color:#6b7690;font-weight:300}
.np-avatar-lg{width:120px;height:120px;margin:0 auto 18px}
.np-edit-badge{position:absolute;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.45);color:#fff;font-size:34px}
.np-actions{display:flex;gap:12px;justify-content:center;margin-top:36px;flex-wrap:wrap}
.np-btn{min-height:46px;padding:0 22px;border-radius:8px;border:1px solid #344158;background:#1a2130;color:#dbe7ff;font:inherit;font-weight:700;cursor:pointer}
.np-btn-primary{background:#5b7cfa;border-color:#5b7cfa;color:#fff}
.np-btn-danger{background:transparent;border-color:rgba(251,113,133,.6);color:#fecdd3}
.np-btn-ghost{background:transparent}
.np-btn:focus-visible{outline:3px solid #b579ff;outline-offset:2px}
.np-input{width:100%;max-width:360px;margin:0 auto 18px;display:block;padding:12px 14px;border-radius:8px;border:1px solid #344158;background:#11151d;color:#f8fafc;font:inherit;font-size:16px;text-align:center}
.np-avatars-label{color:#a8b3c7;font-size:13px;margin-bottom:10px}
.np-avatars{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-bottom:18px}
.np-avatar-choice{width:64px;height:64px;border-radius:10px;overflow:hidden;background:#11151d;border:3px solid transparent;cursor:pointer;padding:0}
.np-avatar-choice img{width:100%;height:100%;object-fit:cover}
.np-avatar-choice.np-picked{border-color:#5b7cfa}
.np-avatar-choice:focus-visible{outline:2px solid #b579ff;outline-offset:2px}
.np-status{min-height:18px;color:#fecdd3;font-size:13px;margin:6px 0}
html.tv .np-avatar{width:184px;height:184px}
html.tv .np-card{width:184px}
html.tv .np-title{font-size:46px}
html.tv .np-btn{min-height:58px;font-size:18px}
`;
    const style = el('style');
    style.id = 'norva-profiles-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function close() {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
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
    render();
  }

  function render() {
    if (!overlayEl) return;
    if (state.mode === 'add' || state.mode === 'edit') renderEdit();
    else renderGrid();
  }

  function renderGrid() {
    const manage = state.mode === 'manage';
    overlayEl.innerHTML = '';
    const panel = el('div', 'np-panel');
    panel.appendChild(el('h1', 'np-title', manage ? 'Manage profiles' : "Who's watching?"));

    const grid = el('div', 'np-grid');
    state.profiles.forEach((p) => {
      const card = el('button', 'np-card' + (manage ? ' np-card-manage' : ''));
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
  }

  function openAdd() {
    state.mode = 'add';
    state.editing = null;
    state.pickedAvatar = avatarIdAt(state.profiles.length);
    render();
  }
  function openEdit(p) {
    state.mode = 'edit';
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
    setTimeout(() => { try { nameInput.focus(); } catch (_) { } }, 0);
  }

  function selectProfile(p) {
    profilesApi().setActiveId(p.id);
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

    const activeId = profilesApi().getActiveId();
    if (activeId && list.some((p) => p.id === activeId)) return true;
    if (list.length <= 1) {
      if (list.length === 1) profilesApi().setActiveId(list[0].id);
      return true;
    }
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
