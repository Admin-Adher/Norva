const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

test('every web resume entry point preserves the saved second exactly', () => {
    const files = [
        ['public/js/pages/WatchPage.js', 'getResumeRestorePosition('],
        ['public/js/pages/MoviesPage.js', 'getResumeOffset('],
        ['public/js/pages/HomePage.js', 'getResumeOffset('],
        ['public/js/pages/SeriesPage.js', 'getResumeOffset('],
    ];

    for (const [file, anchor] of files) {
        const source = read(file);
        const marker = source.indexOf(`\n    ${anchor}`);
        assert.ok(marker >= 0, `${file} must expose its resume helper`);
        const start = marker + 1;
        const body = source.slice(start, source.indexOf('\n    }', start));
        assert.ok(!body.includes('- 3'), `${file} must not silently rewind three seconds`);
        assert.match(body, /return (?:rawPosition|position);/,
            `${file} must return the saved second unchanged`);
    }
});

test('lane recovery, audio switching, and cast handoff keep the visible timestamp', () => {
    const watch = read('public/js/pages/WatchPage.js');
    assert.ok(!watch.includes('Math.floor(this.getResumeSnapshotPosition()) -'),
        'recovery lanes must not rewind the saved snapshot');
    assert.ok(!watch.includes('Math.floor(this.getPlaybackPosition()) -'),
        'audio switches and file recovery must not rewind the visible playhead');
    assert.ok(!watch.includes('+ remote - 2'),
        'returning from Cast must preserve the receiver timestamp');
});

test('an in-flight backward seek persists its explicit target and converges immediately', () => {
    const watch = read('public/js/pages/WatchPage.js');
    const snapshotStart = watch.indexOf('    getResumeSnapshotPosition() {');
    const snapshotBody = watch.slice(snapshotStart, watch.indexOf('\n    }', snapshotStart));
    assert.ok(snapshotBody.indexOf('_pendingSeekTarget') < snapshotBody.indexOf('Math.max('),
        'the explicit target must win over the stale pre-seek video clock');

    const seekedStart = watch.indexOf("this.video?.addEventListener('seeked'");
    const seekedBody = watch.slice(seekedStart, watch.indexOf('\n        });', seekedStart));
    assert.ok(seekedBody.includes('saveProgress({ force: true })'),
        'the cloud position must update immediately after a seek');
});

test('subtitle windows jump directly to both backward and forward seek targets', () => {
    const watch = read('public/js/pages/WatchPage.js');
    const start = watch.indexOf('    async subtitleWindowTick(');
    const body = watch.slice(start, watch.indexOf('\n    attachSelectedProbeSubtitleTrack()', start));
    assert.ok(body.includes('const jumpedForward'));
    assert.ok(body.includes('force || seekedBack || jumpedForward'));
});
