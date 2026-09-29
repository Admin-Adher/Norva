const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/api.js'), 'utf8');
const start = source.indexOf('    async function sourcePatchFromLocal(');
const end = source.indexOf('\n    }', start) + 6;
const context = {listSources: async () => [{cloudId:'owned-source', type:'xtream'}]};
vm.runInNewContext(source.slice(start, end), context);
test('source rename preceding credential repair respects the server allowlist', async () => {
    for (const data of [{displayName:'Provider'}, {name:'Provider'}, {display_name:'Provider'}]) {
        const patch = await context.sourcePatchFromLocal('owned-source', data);
        assert.deepEqual(JSON.parse(JSON.stringify(patch)), {displayName:'Provider'});
    }
});
