const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const admin = fs.readFileSync(
  path.join(root, 'public/js/pages/AdminPage.js'),
  'utf8',
);

test('Admin Partners constrains Configuration cards to the responsive pane', () => {
  assert.ok(admin.includes(
    '#page-admin .partners-pane > *{width:100%;min-width:0;max-width:100%;box-sizing:border-box;}',
  ));
  assert.ok(admin.includes(
    '#page-admin .partners-control-card{min-width:0;max-width:100%;',
  ));
  assert.ok(admin.includes(
    '#page-admin .partners-control-item{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;max-width:100%;',
  ));
});

test('Admin Partners avoids crushed labels at compact desktop widths', () => {
  assert.match(
    admin,
    /@media\(max-width:1180px\)\{\s*#page-admin \.partners-control-grid\{grid-template-columns:1fr;\}\s*\}/,
  );
  assert.ok(admin.includes(
    '#page-admin .partners-risk-actions{display:flex;flex:0 1 auto;flex-wrap:wrap;justify-content:flex-end;gap:6px;min-width:0;max-width:100%;}',
  ));
  assert.ok(admin.includes(
    '#page-admin .partners-control-head > .partners-state,#page-admin .partners-action-row > .partners-state,#page-admin .partners-risk-actions .partners-state{max-width:100%;white-space:normal;overflow-wrap:anywhere;line-height:1.35;text-align:left;}',
  ));
});

test('Admin Partners bounds the guided Didit dialog inside its real responsive pane', () => {
  assert.ok(admin.includes(
    '#page-admin .partners-kyc-guide{max-height:min(860px,100%,calc(100dvh',
  ));
  assert.ok(admin.includes(
    '#page-admin .partners-kyc-guide{max-height:min(100%,calc(100dvh',
  ));
  assert.match(
    admin,
    /#page-admin \.partners-kyc-guide\{[^}]*min-height:0;[^}]*overflow-y:auto;/,
  );
  assert.match(
    admin,
    /@media\(max-width:700px\)[\s\S]*#page-admin \.partners-kyc-guide\{[^}]*min-height:0;/,
  );
});
