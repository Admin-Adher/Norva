const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(process.argv[2]);
const hls = path.resolve(__dirname, '../../public/js/vendor/hls-1.7.3.min.js');
http.createServer((req, res) => {
    if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(`<!doctype html><title>Norva — reprise synthétique</title>
<style>body{background:#080b11;color:white;font:18px sans-serif}video{width:640px;display:block}pre{white-space:pre-wrap}</style>
<h1>Test local vidéo + sous-titres</h1><button id="start">Lire la reprise</button><video controls muted></video><pre id="status"></pre>
<script src="/hls.js"></script><script>
const video=document.querySelector('video'),status=document.querySelector('#status');
window.proof={events:[],cues:[],samples:[]};
for(const e of ['playing','waiting','error'])video.addEventListener(e,()=>proof.events.push({e,time:video.currentTime,wall:performance.now()}));
video.textTracks.addEventListener('addtrack',e=>{e.track.addEventListener('cuechange',()=>{for(const c of e.track.activeCues||[])proof.cues.push({time:video.currentTime,text:c.text,start:c.startTime,end:c.endTime})})});
document.querySelector('#start').onclick=()=>{proof.started=performance.now();const h=new Hls({startPosition:4,enableWorker:false});window.fixtureHls=h;
h.loadSource('/playlist.m3u8');h.attachMedia(video);h.on(Hls.Events.MANIFEST_PARSED,()=>{h.subtitleTrack=0;video.play()});
h.on(Hls.Events.ERROR,(_,d)=>proof.events.push({e:'hls',detail:d.details,fatal:d.fatal,time:video.currentTime}));
setInterval(()=>{proof.samples.push({wall:performance.now(),time:video.currentTime,paused:video.paused});status.textContent=JSON.stringify({time:video.currentTime,events:proof.events,cues:proof.cues.slice(-3)},null,2)},250)};
</script>`);
    }
    const name = req.url.slice(1);
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) { res.statusCode = 400; return res.end(); }
    const file = name === 'hls.js' ? hls : path.join(root, name);
    res.setHeader('Content-Type', name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : name.endsWith('.vtt') ? 'text/vtt' : name.endsWith('.js') ? 'text/javascript' : 'video/mp2t');
    const stream = fs.createReadStream(file); stream.on('error',()=>{res.statusCode=404;res.end()});stream.pipe(res);
}).listen(Number(process.argv[3] || 18479),'127.0.0.1',()=>console.log('Fixture ready'));
