const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflowPath = path.join(
  __dirname,
  '..',
  '.github',
  'workflows',
  'blog-autopublish.yml',
);

test('blog auto-publish runs once per Europe/Paris editorial slot', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  assert.match(workflow, /cron:\s*['"]5 6,20 \* \* \*['"]/);
  assert.match(workflow, /timezone:\s*['"]Europe\/Paris['"]/);
  assert.doesNotMatch(workflow, /cron:\s*['"]5 4,5,18,19 \* \* \*['"]/);
});
