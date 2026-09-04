import i18next from 'i18next';
import messages from './messages.json';
import languagePolicy from './language.cjs';

const { normalize, resolve, locales } = languagePolicy;
const storageKey = 'norva-ui-language-v1';
const attributes = ['title', 'placeholder', 'aria-label', 'alt'];
const selector = '[data-i18n], ' + attributes.map(a => `[data-i18n-${a}]`).join(', ');
let preference = 'auto';
let current;
let nativeState = null;

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
    translation: Object.fromEntries(Object.entries(messages).map(([key, values]) => [key, values[index]])),
}]));
readState();
current = resolve(preference, deviceLanguages());
i18next.init({ resources, lng: current, supportedLngs: locales.map(l => l.code),
    fallbackLng: 'en', load: 'currentOnly', initImmediate: false,
    // DOM writes use textContent/setAttribute. Never interpolate a translation into HTML.
    interpolation: { escapeValue: false }, returnEmptyString: false });

function t(key, options) { return i18next.t(key, options); }
function translateElement(element) {
    if (element.closest('[translate="no"], [data-i18n-ignore]')) return;
    const key = element.getAttribute('data-i18n');
    // Labels with icons must mark a child span, never their interactive parent.
    if (key && i18next.exists(key) && element.children.length === 0) {
        const next = t(key);
        if (element.textContent !== next) element.textContent = next;
    }
    for (const attribute of attributes) {
        const attributeKey = element.getAttribute(`data-i18n-${attribute}`);
        if (attributeKey && i18next.exists(attributeKey)) {
            const next = t(attributeKey);
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
window.NorvaI18n = Object.freeze({ t, translate, setPreference, refresh, locales,
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
                if (record.target.nodeType === 1 && record.target.matches(selector)) roots.add(record.target);
            } else if (record.target.nodeType === 1) roots.add(record.target);
        }
        roots.forEach(root => { if (root.isConnected) translate(root); });
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['data-i18n', ...attributes.map(a => `data-i18n-${a}`)] });
    document.addEventListener('change', event => {
        if (!event.target.matches('[data-ui-language-select]')) return;
        const saved = setPreference(event.target.value);
        refreshControls();
        const status = document.getElementById('ui-language-status');
        if (status) status.textContent = t(saved ? 'ui_language_saved' : 'ui_language_failed');
    });
});
window.addEventListener('languagechange', refresh);
window.addEventListener('pageshow', refresh);
window.addEventListener('storage', event => { if (event.key === storageKey || event.key === null) refresh(); });
