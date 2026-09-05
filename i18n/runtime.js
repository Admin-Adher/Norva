import i18next from 'i18next';
import messages from './messages.json';
import webBase from './web.json';
import webExtra from './web-extra.json';
import webDynamic from './web-dynamic.json';
import webTail from './web-tail.json';
const webMessages = { ...webBase, ...webExtra, ...webDynamic, ...webTail };
import languagePolicy from './language.cjs';

const { normalize, resolve, locales } = languagePolicy;
const storageKey = 'norva-ui-language-v1';
const attributes = ['title', 'placeholder', 'aria-label', 'alt'];
const selector = '[data-i18n], ' + attributes.map(a => `[data-i18n-${a}]`).join(', ');
let preference = 'auto';
let current;
let nativeState = null;
const renderedLabels = new WeakMap();
const labelWhitespace = new WeakMap();
const renderedRich = new WeakMap();

function bridge() {
    return [window.NorvaLocaleNative, window.NorvaTVCloud, window.NodeCastNative].find(candidate =>
        candidate && typeof candidate.getUiLanguageState === 'function');
}
function readState() {
    try {
        const candidate = bridge();
        nativeState = candidate ? JSON.parse(candidate.getUiLanguageState()) : null;
        if (nativeState && typeof nativeState.preference === 'string') {
            preference = normalize(nativeState.preference) || 'auto';
            return;
        }
    } catch (_) { nativeState = null; }
    try { preference = normalize(localStorage.getItem(storageKey)) || 'auto'; } catch (_) { /* session default */ }
}
function deviceLanguages() {
    return Array.isArray(nativeState?.deviceLanguages) ? nativeState.deviceLanguages
        : (navigator.languages?.length ? Array.from(navigator.languages) : [navigator.language || 'en']);
}
const resources = Object.fromEntries(locales.map((locale, index) => [locale.code, {
    translation: { ...Object.fromEntries(Object.entries(messages).map(([key, values]) => [key, values[index]])),
        ...Object.fromEntries(Object.entries(webMessages).map(([key, values]) => [key, values[locale.code]])) },
}]));
readState();
current = resolve(preference, deviceLanguages());
i18next.init({ resources, lng: current, supportedLngs: locales.map(l => l.code),
    fallbackLng: 'en', load: 'currentOnly', initImmediate: false,
    // DOM writes use textContent/setAttribute. Never interpolate a translation into HTML.
    interpolation: { escapeValue: false }, returnEmptyString: false });

function t(key, options) {
    const value = i18next.t(key, options);
    const original = options?.defaultValue;
    if (typeof original !== 'string') return value;
    // Preserve authored boundaries when an existing UI joins a label and a value.
    return original.match(/^\s*/)[0] + value.trim() + original.match(/\s*$/)[0];
}
// Serialize only dynamic values into an HTML attribute; translations still use textContent.
function args(values) {
    return JSON.stringify(values).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function elementArgs(element, attribute = '') {
    try {
        const parsed = JSON.parse(element.getAttribute('data-i18n' + (attribute ? '-' + attribute : '') + '-args') || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => /^p\d+$/.test(key)
            && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')));
    } catch (_) { return {}; }
}
function translateRich(element, key) {
    const slots = [...element.children].filter(child => child.matches('norva-slot[data-i18n-slot]'));
    if (!slots.length) return;
    const options = elementArgs(element);
    const values = slots.map(slot => slot.getAttribute('data-i18n-slot'));
    if (values.some(value => !/^p\d+$/.test(value)) || new Set(values).size !== values.length) return;
    const signature = JSON.stringify([current, key, options]);
    if (renderedRich.get(element) === signature) return;
    const nonce = Math.random().toString(36).slice(2);
    const markers = values.map(value => '\uFFF0' + nonce + value + '\uFFF1');
    values.forEach((value, index) => { options[value] = markers[index]; });
    const translated = t(key, options);
    if (markers.some(marker => !translated.includes(marker))) return;
    const fragment = document.createDocumentFragment();
    let remaining = translated;
    while (remaining.length) {
        let nearest = -1, slotIndex = -1;
        markers.forEach((marker, index) => { const at = remaining.indexOf(marker); if (at >= 0 && (nearest < 0 || at < nearest)) { nearest = at; slotIndex = index; } });
        if (nearest < 0) { fragment.append(document.createTextNode(remaining)); break; }
        fragment.append(document.createTextNode(remaining.slice(0, nearest)), slots[slotIndex]);
        remaining = remaining.slice(nearest + markers[slotIndex].length);
    }
    const focused = element.contains(document.activeElement) ? document.activeElement : null;
    element.replaceChildren(fragment);
    renderedRich.set(element, signature);
    if (focused?.isConnected) focused.focus({ preventScroll: true });
}
function translateElement(element) {
    if (element.closest('[translate="no"], [data-i18n-ignore]')) return;
    const key = element.getAttribute('data-i18n');
    if (key && i18next.exists(key) && element.hasAttribute('data-i18n-rich')) translateRich(element, key);
    // Labels with icons must mark a child span, never their interactive parent.
    if (key && i18next.exists(key) && element.children.length === 0) {
        if (!labelWhitespace.has(element)) labelWhitespace.set(element, [element.textContent.match(/^\s*/)[0], element.textContent.match(/\s*$/)[0]]);
        const [before, after] = labelWhitespace.get(element);
        const next = before + t(key, elementArgs(element)) + after;
        if (element.textContent !== next) element.textContent = next;
        renderedLabels.set(element, next);
    }
    for (const attribute of attributes) {
        const attributeKey = element.getAttribute(`data-i18n-${attribute}`);
        if (attributeKey && i18next.exists(attributeKey)) {
            const next = t(attributeKey, elementArgs(element, attribute));
            if (element.getAttribute(attribute) !== next) element.setAttribute(attribute, next);
        }
    }
}
function translate(root = document) {
    if (root.nodeType === 1 && root.matches(selector)) translateElement(root);
    root.querySelectorAll?.(selector).forEach(translateElement);
}
function refreshControls() {
    document.querySelectorAll('[data-ui-language-select]').forEach(select => {
        if (!select.options.length) {
            const automatic = document.createElement('option');
            automatic.value = 'auto';
            select.append(automatic);
            locales.forEach(locale => {
                const option = document.createElement('option');
                option.value = locale.code;
                option.textContent = locale.name;
                option.lang = locale.code;
                option.dir = locale.dir;
                select.append(option);
            });
        }
        select.options[0].textContent = t('ui_language_auto');
        select.value = preference;
    });
}
function apply() {
    current = resolve(preference, deviceLanguages());
    i18next.changeLanguage(current);
    document.documentElement.lang = current;
    document.documentElement.dir = current === 'ar' ? 'rtl' : 'ltr';
    translate();
    refreshControls();
}
function setPreference(value) {
    if (value !== 'auto' && !locales.some(l => l.code === value)) return false;
    try {
        const native = bridge();
        if (native) {
            if (typeof native.setUiLanguage !== 'function' || native.setUiLanguage(value) !== true) return false;
            // Native is authoritative; browser preferences must not leak across APK modes.
            nativeState = { ...nativeState, preference: value };
        } else {
            localStorage.setItem(storageKey, value);
        }
    } catch (_) { return false; }
    preference = value;
    apply();
    window.dispatchEvent(new CustomEvent('norva:languagechange', { detail: { language: current, preference } }));
    return true;
}
function refresh() {
    const previous = current;
    readState();
    apply();
    if (previous !== current) window.dispatchEvent(new CustomEvent('norva:languagechange', { detail: { language: current, preference } }));
}
window.NorvaI18n = Object.freeze({ t, args, translate, setPreference, refresh, locales,
    get language() { return current; }, get preference() { return preference; } });
apply();
document.addEventListener('DOMContentLoaded', () => {
    apply();
    // Only explicitly marked UI is translated. Provider titles, user text, URLs and
    // values are never scanned/replaced. Observe inserted labels and label updates.
    const observer = new MutationObserver(records => {
        const roots = new Set();
        for (const record of records) {
            if (record.type === 'childList') {
                record.addedNodes.forEach(node => { if (node.nodeType === 1) roots.add(node); });
                if (record.target.nodeType === 1 && record.target.matches(selector)) {
                    // A state transition owns its new copy. Do not restore the initial
                    // HTML label over a loading, success or error message.
                    const last = renderedLabels.get(record.target);
                    if (last !== undefined && record.target.textContent !== last) {
                        record.target.removeAttribute('data-i18n');
                        record.target.removeAttribute('data-i18n-args');
                        renderedLabels.delete(record.target);
                    } else roots.add(record.target);
                }
            } else if (record.target.nodeType === 1) roots.add(record.target);
        }
        roots.forEach(root => { if (root.isConnected) translate(root); });
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['data-i18n', 'data-i18n-args', ...attributes.flatMap(a => [`data-i18n-${a}`, `data-i18n-${a}-args`])] });
    document.addEventListener('change', event => {
        if (!event.target.matches('[data-ui-language-select]')) return;
        const saved = setPreference(event.target.value);
        refreshControls();
        const status = document.getElementById('ui-language-status');
        if (status) status.textContent = t(saved ? 'ui_language_saved' : 'ui_language_failed');
        // Recreate the SPA's cached view models in the chosen language. Its hash
        // already preserves the Settings section. Android recreates its Activity.
        if (saved && !bridge() && window.app) {
            try { sessionStorage.setItem('norva-ui-language-focus', '1'); } catch (_) {}
            window.setTimeout(() => window.location.reload(), 150);
        }
    });
});
window.addEventListener('languagechange', refresh);
// Restore keyboard focus after the SPA has finished its existing route recovery.
window.addEventListener('load', () => {
    let restore = false;
    try { restore = sessionStorage.getItem('norva-ui-language-focus') === '1'; sessionStorage.removeItem('norva-ui-language-focus'); } catch (_) {}
    if (!restore) return;
    const deadline = Date.now() + 10000;
    const focus = () => {
        const select = document.querySelector('[data-ui-language-select]');
        if (select?.getClientRects().length) select.focus({ preventScroll: false });
        else if (Date.now() < deadline) window.setTimeout(focus, 100);
    };
    focus();
});
window.addEventListener('pageshow', refresh);
window.addEventListener('storage', event => { if (event.key === storageKey || event.key === null) refresh(); });
