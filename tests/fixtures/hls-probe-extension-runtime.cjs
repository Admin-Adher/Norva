// Run inside an isolated Gateway image with --network none. Uses loopback only.
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const run = promisify(execFile);

(async () => {
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=64x64:rate=10',
    '-t', '1', '-c:v', 'libx264', '-f', 'mpegts', '/tmp/segment.ts']);
  const segment = fs.readFileSync('/tmp/segment.ts');
  execFileSync('ffmpeg', ['-v', 'error', '-i', '/tmp/segment.ts', '-c', 'copy', '/tmp/movie.mp4']);
  const mp4 = fs.readFileSync('/tmp/movie.mp4');
  const playlist = (uri) => `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1,\n${uri}\n#EXT-X-ENDLIST\n`;
  const server = http.createServer((req, res) => {
    if (req.url === '/movie.mp4') { res.end(mp4); }
    else if (['/index.m3u8', '/local.m3u8', '/extensionless.m3u8'].includes(req.url)) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end(playlist(req.url === '/local.m3u8' ? 'file:///tmp/segment.ts' : req.url === '/extensionless.m3u8' ? '/segment' : '/segment.jpg'));
    } else { res.setHeader('Content-Type', 'video/mp2t'); res.end(segment); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const probe = async (path, options) => {
    try {
      const { stdout } = await run('ffprobe', ['-v', 'error', ...options,
        '-show_streams', '-of', 'json', base + path], { timeout: 5000 });
      return { ok: JSON.parse(stdout).streams.some(s => s.codec_type === 'video') };
    } catch (e) {
      return { ok: false, extensionRejected: /extension/i.test(e.stderr || ''),
        protocolRejected: /not on whitelist/i.test(e.stderr || '') };
    }
  };
  try {
    const restricted = ['-protocol_whitelist', 'http,https,tcp,tls,httpproxy,crypto', '-extension_picky', '0'];
    const baseline = await probe('/index.m3u8', []);
    const compatible = await probe('/index.m3u8', restricted);
    const localFile = await probe('/local.m3u8', restricted);
    const extensionless = await probe('/extensionless.m3u8', restricted);
    const ordinaryMp4 = await probe('/movie.mp4', restricted);
    console.log(JSON.stringify({ baseline, compatible, localFile, extensionless, ordinaryMp4 }));
    assert.equal(baseline.ok, false);
    assert.equal(baseline.extensionRejected, true);
    assert.equal(compatible.ok, true);
    assert.equal(localFile.ok, false);
    assert.equal(localFile.protocolRejected, true);
    assert.equal(extensionless.ok, true);
    assert.equal(ordinaryMp4.ok, true);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
