// Offline fixture only: no provider connection, credentials, or production state.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { PrivateResumeHlsCache } = require('./private-resume-hls-cache');
const { privateResumeBinding } = require('./private-resume-binding');
const { captureSubtitleWindow } = require('./private-resume-subtitles');
const { parseResumeMediaPlaylist } = require('./private-resume-hls-cache');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-resume-fixture-'));
function ff(args) {
    const run = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-threads', '1', ...args], { encoding: 'utf8' });
    if (run.status) throw Error(run.stderr.slice(-3000));
}
function stamp(s) { return `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')},000`; }
const sub = Array.from({ length: 50 }, (_, i) => `${i + 1}\n${stamp(i * 4)} --> ${stamp(i * 4 + 3)}\nSOURCE SECOND ${i * 4}\n`).join('\n');
fs.writeFileSync(path.join(root, 'cues.srt'), sub);
ff(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-i', path.join(root, 'cues.srt'), '-t', '200', '-map', '0:v', '-map', '1:a', '-map', '2:s',
    '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-g', '40', '-c:a', 'aac', '-c:s', 'srt', path.join(root, 'source.mkv')]);
function output(folder, seek) {
    fs.mkdirSync(folder);
    ff(['-copyts', '-ss', String(Math.max(0, seek - 15)), '-i', path.join(root, 'source.mkv'), '-ss', String(seek), '-map', '0:v', '-map', '0:a',
        '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-g', '40', '-c:a', 'aac',
        '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_flags', 'independent_segments',
        '-hls_segment_filename', path.join(folder, 'segment-%03d.ts'), path.join(folder, 'video.m3u8'),
        '-ss', String(seek), '-map', '0:2', '-c:s', 'webvtt', '-f', 'segment', '-segment_time', '2', '-segment_start_number', '1',
        '-segment_list_size', '0', '-segment_list_type', 'm3u8', '-segment_list', path.join(folder, 'subtitle_0.m3u8'),
        path.join(folder, 'subtitle_0-%05d.vtt')]);
}
(async () => {
    const cold = path.join(root, 'cold'), next = path.join(root, 'next'), out = path.join(root, 'public');
    output(cold, 0); fs.mkdirSync(out);
    const renditions = [{ playlistName: 'subtitle_0.m3u8', streamIndex: 2 }];
    const cache = new PrivateResumeHlsCache();
    const fileSizeBytes = fs.statSync(path.join(root, 'source.mkv')).size;
    const binding = privateResumeBinding({ ownerKey: 'a'.repeat(64), sourceUrl: 'https://fixture.invalid/file', sourceId: 'fixture', sourceRevision: '1', fileSizeBytes });
    const observed = { fileSizeBytes, validator: { kind: 'etag', value: '"fixture-v1"' }, effectiveUrlIdentitySha256: 'b'.repeat(64) };
    const read = dir => async (name, limit) => { const bytes = fs.readFileSync(path.join(dir, name)); return bytes.length <= limit ? bytes : null; };
    const captured = await cache.capture({ binding, observed, position: 20, actualStartOffset: 0,
        playlist: fs.readFileSync(path.join(cold, 'video.m3u8'), 'utf8').replace('#EXT-X-ENDLIST', ''),
        subtitleRenditions: renditions, readAsset: read(cold) });
    if (!captured) throw Error('fixture capture rejected');
    const lease = cache.acquire(binding, 20, observed);
    output(next, lease.end);
    const continuation = fs.readFileSync(path.join(next, 'video.m3u8'), 'utf8');
    const graph = await captureSubtitleWindow({ renditions, videoSegments: parseResumeMediaPlaylist(continuation).segments,
        prefix: 'continuation', readAsset: read(next) });
    if (!graph) throw Error('fixture continuation subtitles rejected');
    const video = lease.playlist(continuation);
    const subtitle = lease.subtitlePlaylist('subtitle_0.m3u8', graph.playlists.get('subtitle_0.m3u8')) + '#EXT-X-ENDLIST\n';
    for (const name of [...video.matchAll(/^(resume-[^\n]+\.ts)$/gm)].map(m => m[1])) fs.writeFileSync(path.join(out, name), lease.asset(name));
    for (const name of [...subtitle.matchAll(/^(resume-[^\n]+\.vtt)$/gm)].map(m => m[1])) fs.writeFileSync(path.join(out, name), lease.asset(name));
    for (const [name, bytes] of graph.assets) fs.writeFileSync(path.join(out, name), bytes);
    for (const name of fs.readdirSync(next).filter(n => n.endsWith('.ts'))) fs.copyFileSync(path.join(next, name), path.join(out, name));
    fs.writeFileSync(path.join(out, 'video.m3u8'), video);
    fs.writeFileSync(path.join(out, 'subtitle_0.m3u8'), subtitle);
    fs.writeFileSync(path.join(out, 'playlist.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Fixture",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="subtitle_0.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,SUBTITLES="subs"\nvideo.m3u8\n');
    console.log(JSON.stringify({ root, public: out, start: lease.start, end: lease.end, cache: cache.publicStatus() }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
