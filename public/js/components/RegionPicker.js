/**
 * RegionPicker — a searchable, keyboard-accessible combobox for the "Your region" setting.
 *
 * It enhances a hidden native <select id="setting-country"> (the value store the existing
 * Settings.js wiring reads/writes and listens to). The picker:
 *   - populates the <select> with every region (js/utils/regions.js), so `select.value = code`
 *     always resolves;
 *   - renders a button (flag + name), a search box and a role="listbox" of regions
 *     (countries A-Z, then market bundles);
 *   - on pick, sets select.value and dispatches a native `change` (so the source-resync in
 *     Settings.js fires unchanged).
 *
 * Follows the ARIA editable-combobox pattern: the SEARCH INPUT is the combobox (it holds
 * focus and carries aria-expanded / aria-activedescendant); the button is a secondary opener.
 * Global API: window.RegionPicker = { initAll(), init(container), syncButton(selectEl) }.
 * Degrades safely: if NorvaRegions is missing it exposes the native <select> as a real,
 * usable dropdown.
 */
(function () {
    'use strict';

    function regionsData() {
        return (typeof window !== 'undefined' && window.NorvaRegions) || null;
    }

    function fillNativeSelect(selectEl, data) {
        if (selectEl.dataset.regionFilled === '1') return;
        const groups = [
            { label: 'Countries', items: data.list().filter((r) => r.kind === 'country') },
            { label: 'Regions', items: data.list().filter((r) => r.kind === 'bundle') }
        ];
        const frag = document.createDocumentFragment();
        for (const g of groups) {
            if (!g.items.length) continue;
            const og = document.createElement('optgroup');
            og.label = g.label;
            for (const r of g.items) {
                const opt = document.createElement('option');
                opt.value = r.code;
                opt.textContent = `${r.flag} ${r.name}`;
                og.appendChild(opt);
            }
            frag.appendChild(og);
        }
        selectEl.innerHTML = '';
        selectEl.appendChild(frag);
        selectEl.dataset.regionFilled = '1';
    }

    // If regions.js failed to load, fall back to a plain, usable native <select> populated
    // from cloudApi's own (legacy) region list, instead of a frozen combobox.
    function degradeToNativeSelect(selectEl, btn, pop) {
        if (!selectEl) return;
        selectEl.removeAttribute('aria-hidden');
        selectEl.removeAttribute('tabindex');
        selectEl.style.cssText = 'position:static;width:auto;height:auto;clip:auto;opacity:1;pointer-events:auto;margin:0;';
        if (!selectEl.options.length) {
            const legacy = (window.NorvaCloud && window.NorvaCloud.regions && window.NorvaCloud.regions.list())
                || [{ key: 'FR', label: 'France' }, { key: 'US', label: 'United States' }, { key: 'INTERNATIONAL', label: 'International' }];
            for (const r of legacy) selectEl.add(new Option(r.label, r.key));
        }
        if (btn) btn.style.display = 'none';
        if (pop) pop.hidden = true;
    }

    function init(container) {
        const data = regionsData();
        const selectEl = container.querySelector('.region-picker-native');
        const btn = container.querySelector('[data-region-btn]');
        const valueEl = container.querySelector('[data-region-value]');
        const pop = container.querySelector('[data-region-pop]');
        const search = container.querySelector('[data-region-search]');
        const listEl = container.querySelector('[data-region-list]');
        if (!data || !selectEl || !btn || !valueEl || !pop || !search || !listEl) {
            degradeToNativeSelect(selectEl, btn, pop);
            return;
        }

        fillNativeSelect(selectEl, data);

        let activeIdx = -1;   // index into the currently-rendered options
        let rendered = [];    // [{ code, el }]

        const syncButton = () => {
            const code = selectEl.value;
            const r = data.byCode(code);
            valueEl.textContent = r ? `${r.flag} ${r.name}` : `${data.flag(code)} ${data.label(code) || 'International'}`;
        };

        const renderList = (query) => {
            const current = selectEl.value;
            let matches = data.search(query);
            // Keep an out-of-catalogue saved preference (e.g. an uncurated ISO code)
            // re-selectable rather than making it vanish from the list.
            if (current && !matches.some((r) => r.code === current) && !data.byCode(current)) {
                const q = String(query || '').trim().toLowerCase();
                if (!q || current.toLowerCase().includes(q)) {
                    matches = [{ code: current, name: data.label(current), flag: data.flag(current), kind: 'country' }].concat(matches);
                }
            }
            listEl.innerHTML = '';
            rendered = [];
            if (!matches.length) {
                const li = document.createElement('li');
                li.className = 'region-picker-empty';
                li.textContent = 'No match';
                listEl.appendChild(li);
                activeIdx = -1;
                search.removeAttribute('aria-activedescendant');
                return;
            }
            let lastKind = null;
            const frag = document.createDocumentFragment();
            matches.forEach((r) => {
                if (r.kind !== lastKind) {
                    lastKind = r.kind;
                    const head = document.createElement('li');
                    head.className = 'region-picker-group';
                    head.setAttribute('role', 'presentation');
                    head.textContent = r.kind === 'bundle' ? 'Regions' : 'Countries';
                    frag.appendChild(head);
                }
                const li = document.createElement('li');
                li.className = 'region-picker-option';
                li.id = `region-opt-${r.code}`;
                li.setAttribute('role', 'option');
                li.setAttribute('aria-selected', String(r.code === current));
                li.dataset.code = r.code;
                li.innerHTML = '<span class="region-picker-opt-flag"></span><span class="region-picker-opt-name"></span>';
                li.querySelector('.region-picker-opt-flag').textContent = r.flag;
                li.querySelector('.region-picker-opt-name').textContent = r.name;
                if (r.code === current) li.classList.add('is-current');
                frag.appendChild(li);
                rendered.push({ code: r.code, el: li });
            });
            listEl.appendChild(frag);
            activeIdx = rendered.findIndex((x) => x.code === current);
            if (activeIdx < 0) activeIdx = 0;
            highlight();
        };

        const highlight = () => {
            rendered.forEach((x, i) => x.el.classList.toggle('is-active', i === activeIdx));
            const active = rendered[activeIdx];
            if (active) {
                search.setAttribute('aria-activedescendant', active.el.id);
                active.el.scrollIntoView({ block: 'nearest' });
            } else {
                search.removeAttribute('aria-activedescendant');
            }
        };

        // position:fixed relative to the button so no overflow ancestor can clip the popover.
        const positionPopover = () => {
            const rect = btn.getBoundingClientRect();
            pop.style.left = 'auto';
            pop.style.right = Math.max(8, Math.round(window.innerWidth - rect.right)) + 'px';
            const popH = pop.offsetHeight || 360;
            const spaceBelow = window.innerHeight - rect.bottom;
            if (spaceBelow < popH + 12 && rect.top > spaceBelow) {
                pop.style.top = 'auto';
                pop.style.bottom = Math.round(window.innerHeight - rect.top + 6) + 'px';
            } else {
                pop.style.bottom = 'auto';
                pop.style.top = Math.round(rect.bottom + 6) + 'px';
            }
        };
        const onReposition = () => positionPopover();

        const open = () => {
            if (!pop.hidden) return;
            pop.hidden = false;               // reveal first so offsetHeight is real
            renderList('');
            positionPopover();
            btn.setAttribute('aria-expanded', 'true');
            search.setAttribute('aria-expanded', 'true');
            search.value = '';
            search.focus();
            window.addEventListener('scroll', onReposition, true);
            window.addEventListener('resize', onReposition);
        };
        const close = () => {
            if (pop.hidden) return;
            pop.hidden = true;
            btn.setAttribute('aria-expanded', 'false');
            search.setAttribute('aria-expanded', 'false');
            search.removeAttribute('aria-activedescendant');
            window.removeEventListener('scroll', onReposition, true);
            window.removeEventListener('resize', onReposition);
        };

        const choose = (code) => {
            if (btn.disabled) return;
            if (!code || code === selectEl.value) { close(); btn.focus(); return; }
            selectEl.value = code;
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            syncButton();
            close();
            btn.focus();
        };

        btn.addEventListener('click', () => (pop.hidden ? open() : close()));
        search.addEventListener('input', () => renderList(search.value));
        // Keep focus in the search box when clicking options (so focusout doesn't pre-close).
        pop.addEventListener('mousedown', (e) => { if (e.target !== search) e.preventDefault(); });

        search.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); if (rendered.length) { activeIdx = Math.min(activeIdx + 1, rendered.length - 1); highlight(); } }
            else if (e.key === 'ArrowUp') { e.preventDefault(); if (rendered.length) { activeIdx = Math.max(activeIdx - 1, 0); highlight(); } }
            else if (e.key === 'Home') { e.preventDefault(); activeIdx = 0; highlight(); }
            else if (e.key === 'End') { e.preventDefault(); activeIdx = rendered.length - 1; highlight(); }
            else if (e.key === 'Enter') { e.preventDefault(); if (rendered[activeIdx]) choose(rendered[activeIdx].code); }
            else if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
        });

        listEl.addEventListener('click', (e) => {
            const opt = e.target.closest('.region-picker-option');
            if (opt && opt.dataset.code) choose(opt.dataset.code);
        });

        document.addEventListener('click', (e) => {
            if (!container.contains(e.target)) close();
        });
        // Tab (or any focus move) out of the picker closes it.
        container.addEventListener('focusout', (e) => {
            if (!container.contains(e.relatedTarget)) close();
        });
        // Reflect programmatic value changes (Settings.js applyResolution) on the button.
        selectEl.addEventListener('change', syncButton);

        container.__regionSync = syncButton;
        syncButton();
    }

    function initAll() {
        document.querySelectorAll('[data-region-picker]').forEach((c) => {
            if (c.dataset.regionInit === '1') return;
            c.dataset.regionInit = '1';
            init(c);
        });
    }

    // Refresh a picker's button after a programmatic `select.value = …` (no change event).
    function syncButton(selectEl) {
        const container = selectEl && selectEl.closest ? selectEl.closest('[data-region-picker]') : null;
        if (container && typeof container.__regionSync === 'function') container.__regionSync();
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initAll);
        } else {
            initAll();
        }
    }

    window.RegionPicker = { init, initAll, syncButton };
})();
