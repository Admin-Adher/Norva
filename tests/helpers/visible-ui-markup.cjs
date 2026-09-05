'use strict';
// Business markup assertions ignore only localization metadata and transparent text wrappers.
// Roles, controls, escapes, user data and every other attribute remain untouched.
module.exports = html => html.replace(/<\/?norva-i18n\b[^>]*>/g, '')
  .replace(/\sdata-i18n(?:-[a-z-]+)?="[^"]*"/g, '');
