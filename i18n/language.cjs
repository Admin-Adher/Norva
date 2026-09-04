'use strict';
const locales = require('./locales.json');
const supported = new Map(locales.map(locale => [locale.code.toLowerCase(), locale.code]));
function normalize(value) {
    if (typeof value !== 'string') return '';
    const tag = value.trim().replace(/_/g, '-').toLowerCase();
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(tag)) return '';
    if (supported.has(tag)) return supported.get(tag);
    const base = tag.split('-')[0];
    if (base === 'pt') return 'pt-BR';
    if (base === 'tl') return 'fil';
    if (base === 'in') return 'id';
    return supported.get(base) || '';
}
function resolve(preference, deviceLanguages) {
    if (preference !== 'auto' && normalize(preference)) return normalize(preference);
    for (const value of Array.isArray(deviceLanguages) ? deviceLanguages : []) {
        const language = normalize(value);
        if (language) return language;
    }
    return 'en';
}
module.exports = { normalize, resolve, locales };
