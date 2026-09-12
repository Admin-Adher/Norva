'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8').replace(/\r\n/g, '\n');
function copyPolicy() {
    const from = source.indexOf('function shouldCopyAudio(');
    const to = source.indexOf('\nfunction ', from + 1);
    return vm.runInNewContext('(' + source.slice(from, to) + ')', {
        isFiniteMkvVodSession: s => s.finiteMkv === true,
        videoModeForSession: s => s.videoMode,
        multiAudioHlsEnabled: () => false,
        normalizeCodecToken: v => String(v || '').toLowerCase(),
        selectedAudioTrackForSession: () => ({ codec: 'aac', profile: 'LC', channels: 2 }),
        isKnownUnsafeAudio: () => false,
        isKnownBrowserSafeAudio: () => true,
        nullableInt: v => Number(v)
    });
}
test('accurate encoded MKV seeks trim audio too, while origin and full-copy graphs stay unchanged', () => {
    const copy = copyPolicy();
    const s = { finiteMkv: true, seekOffset: 20, videoMode: 'encode', audioMode: 'copy' };
    assert.equal(copy(s), false);
    assert.equal(copy({ ...s, seekOffset: 0 }), true);
    assert.equal(copy({ ...s, finiteMkv: false }), true);
    assert.equal(copy({ ...s, videoMode: 'copy' }), true);
    assert.equal(copy({ ...s, finiteTsResumeAligned: true }), false);
});
test('native FFmpeg reproduces copied-audio preroll and validates frame-aligned encoded audio after an indexed MKV seek',
    { skip: process.env.NORVA_MKV_AUDIO_REAL_FFMPEG !== '1', timeout: 60000 }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-mkv-av-seek-'));
    function run(bin, args) {
        const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 20000 });
        assert.equal(r.status, 0, r.stderr); return r.stdout;
    }
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
    try {
        const input = path.join(dir, 'source.mkv');
        const subtitles=path.join(dir,'source.srt');
        fs.writeFileSync(subtitles,'1\n00:00:00,000 --> 00:00:39,000\nSynthetic fixture\n');
        run(ffmpeg, ['-v','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=30000/1001','-f','lavfi','-i',
            'sine=frequency=440:sample_rate=48000','-i',subtitles,'-t','40','-c:v','libx264','-threads','1','-preset','veryfast',
            '-g','250','-keyint_min','250','-sc_threshold','0','-bf','3','-c:a','aac','-ac','2','-c:s','srt',input]);
        const results = [];
        for (const audio of ['copy', 'aac']) {
            const output = path.join(dir, audio + '-0.ts');
            run(ffmpeg, ['-v','error','-y','-fflags','+genpts','-ss','20','-i',input,'-t','8','-map','0:v:0','-map','0:a:0',
                '-c:v','libx264','-threads','1','-preset','ultrafast','-g','48','-bf','0','-force_key_frames','expr:gte(t,n_forced*2)',
                '-c:a',audio,'-fps_mode','passthrough','-f','hls','-hls_time','2','-hls_playlist_type','event',
                '-hls_segment_filename',path.join(dir,audio+'-%d.ts'),path.join(dir,audio+'.m3u8'),
                '-map','0:s:0','-c:s','webvtt',path.join(dir,audio+'.vtt')]);
            const probe = JSON.parse(run(ffprobe,['-v','error','-show_entries','stream=codec_type,start_time','-of','json',output]));
            const video = Number(probe.streams.find(s=>s.codec_type==='video').start_time);
            const sound = Number(probe.streams.find(s=>s.codec_type==='audio').start_time);
            results.push({ audio, gapSeconds: video - sound });
            run(ffmpeg,['-v','error','-i',output,'-map','0:v:0','-frames:v','12','-f','null','-']);
        }
        console.log('MKV indexed seek A/V proof', JSON.stringify(results));
        assert.ok(results[0].gapSeconds > 1, 'reproduce audio copied before the requested video boundary');
        assert.ok(Math.abs(results[1].gapSeconds) < 0.1, 'both decoded tracks must start on the requested timeline');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
