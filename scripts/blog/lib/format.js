'use strict';

/**
 * Small formatting helpers shared by the blog builder. No dependencies — the
 * repo deliberately hand-rolls its build tooling (see scripts/minify-css.js,
 * scripts/hash-asset-versions.js), and the blog pipeline follows the same rule.
 */

/** Escape text for safe insertion into HTML *text* nodes. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape text for safe insertion into a double-quoted HTML *attribute*. */
function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Escape a value for insertion into a JSON-LD string (JSON.stringify handles it). */
function jsonLd(obj) {
  // Guard against a literal </script> closing the inline JSON-LD block early.
  return JSON.stringify(obj, null, 2).replace(/<\//g, '<\\/');
}

/** GitHub-style heading slug for in-page anchors. */
function slugifyHeading(text) {
  return String(text)
    .toLowerCase()
    .replace(/<[^>]+>/g, '')       // strip any inline HTML tags
    .replace(/&[a-z]+;/g, '')      // strip entities
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Human-readable date ("14 July 2026") for the given instant, rendered in the
 * editorial time zone (Europe/Paris) so the visible date matches the calendar.
 */
function formatDisplayDate(instant, timeZone = 'Europe/Paris') {
  const date = instant instanceof Date ? instant : new Date(instant);
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone,
    }).formatToParts(date);
    const get = (t) => parts.find((p) => p.type === t)?.value || '';
    return `${get('day')} ${get('month')} ${get('year')}`.trim();
  } catch (_) {
    // Fallback if the ICU time zone is unavailable.
    return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  }
}

/** Estimate reading minutes from plain text at ~200 words per minute. */
function estimateReadingMinutes(text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

module.exports = {
  escapeHtml,
  escapeAttr,
  jsonLd,
  slugifyHeading,
  formatDisplayDate,
  estimateReadingMinutes,
};
