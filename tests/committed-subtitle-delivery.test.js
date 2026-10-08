'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { committedSubtitleOutputArgs, readCommittedSubtitle, readBoundedFile } = require('../services/media-gateway/src/committed-subtitle-delivery');
const { MAX_BYTES } = require('../services/media-gateway/src/committed-subtitle-snapshot');
const vtt = 'WEBVTT\n\n00:00:02.000 --> 00:00:04.000\nHello\n\n';
const journal = '#tb 0: 1/1000\n#media_type 0: subtitle\n#codec_id 0: webvtt\n0, 2000, 2000, 2000, 5, 0x058701f4\n';
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-subtitle-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'committed_2.vtt'), vtt);
    await fs.writeFile(path.join(root, 'committed_2.commit'), journal);
    return root;
}
test('committed snapshot survives a real disk round trip; uncommitted suffix is not published', async t => {
    const root = await fixture(t);
    assert.equal(await readCommittedSubtitle(root, 2, () => {}), vtt.slice(0, -1));
    await fs.appendFile(path.join(root, 'committed_2.vtt'), '00:00:09.000 --> 00:00:12.000\nPar');
    assert.equal(await readCommittedSubtitle(root, 2, () => {}), vtt.slice(0, -1));
});
test('revocation between journal and VTT prevents the response', async t => {
    const root = await fixture(t); let current = true;
    const io = { open: async file => { const h = await fs.open(file); if (file.endsWith('.vtt')) current = false; return h; } };
    await assert.rejects(readCommittedSubtitle(root, 2, () => { if (!current) throw Error('revoked'); }, io), /revoked/);
});
test('bounded reads reject oversized files without allocating their size', async t => {
    const root = await fixture(t); const file = path.join(root, 'large');
    const h = await fs.open(file, 'w'); await h.truncate(MAX_BYTES + 1); await h.close();
    await assert.rejects(readBoundedFile(file, () => {}), /LIMIT/);
});
test('truncation during a read fails closed and closes the descriptor', async () => {
    let closed = false;
    const io = { open: async () => ({ stat: async () => ({ isFile: () => true, size: 10 }),
        read: async () => ({ bytesRead: 0 }), close: async () => { closed = true; } }) };
    await assert.rejects(readBoundedFile('fixture', () => {}, io), /TRUNCATED/);
    assert.equal(closed, true);
});
test('missing or changed packet journal never publishes unverified text', async t => {
    const root = await fixture(t);
    await fs.writeFile(path.join(root, 'committed_2.commit'), journal.replace('058701f4', '00000000'));
    await assert.rejects(readCommittedSubtitle(root, 2, () => {}), /PENDING/);
    await assert.rejects(readCommittedSubtitle(root, 3, () => {}), { code: 'ENOENT' });
    await assert.rejects(readCommittedSubtitle(root, '../2', () => {}), /INDEX/);
});
test('tee preserves seek and map; path parser metacharacters are refused', () => {
    const args = committedSubtitleOutputArgs([{ streamIndex: 2 }], '/proof/output/session', ['-ss', '3']);
    assert.deepEqual(args.slice(0, 8), ['-ss', '3', '-map', '0:2', '-c:s', 'webvtt', '-f', 'tee']);
    assert.match(args[8], /webvtt:flush_packets=1.*\|\[f=framecrc:flush_packets=1\]/);
    for (const root of ['/x|file', '/x:y', "/x'y", '/x[y]']) assert.throws(() => committedSubtitleOutputArgs([{ streamIndex: 2 }], root), /PATH/);
});
