'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'public/js/pages/AdminPage.js'), 'utf8');

function loadCloseHelper(document) {
    const source = app.match(/function closeAdminModalForNativeBack\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(source, 'the Admin native Back helper must remain independently testable');
    return vm.runInNewContext(`(${source})`, { document });
}

test('Android Back closes an Admin dialog through its Cancel control', () => {
    let cancelClicks = 0;
    const cancelButton = { click: () => { cancelClicks += 1; } };
    const modal = {
        querySelector(selector) {
            assert.equal(selector, 'button.cancel');
            return cancelButton;
        }
    };
    const closeAdminModalForNativeBack = loadCloseHelper({
        querySelector(selector) {
            assert.equal(selector, '#page-admin .crm-modal-back');
            return modal;
        }
    });

    assert.equal(closeAdminModalForNativeBack(), true);
    assert.equal(cancelClicks, 1);
});

test('Admin Back bridge delegates when no Admin dialog is open', () => {
    const closeAdminModalForNativeBack = loadCloseHelper({ querySelector: () => null });
    assert.equal(closeAdminModalForNativeBack(), false);

    const adminCheck = app.indexOf("if (closeAdminModalForNativeBack()) return 'handled';");
    const fallback = app.indexOf('norvaHandleBackFallback()', adminCheck);
    assert.ok(adminCheck >= 0, 'Admin dialogs must be checked by the native Back bridge');
    assert.ok(fallback > adminCheck, 'other dialogs and route history must remain delegated');
});

test('Cancel retains the existing Admin focus-restoration lifecycle', () => {
    assert.match(admin, /cancelBtn\.addEventListener\('click', \(\) => finish\(cancelVal\)\)/);
    assert.match(admin, /if \(prev && prev\.focus\) \{ try \{ prev\.focus\(\); \}/);
});
