"""Safe, read-only worker/Gateway identity diagnostics; no credentials emitted."""
import hashlib,json,pathlib,subprocess
ROOT=pathlib.Path('/home/adrien/.norva/selection-audio-audit-20261003')
def run(cmd):
    p=subprocess.run(cmd,text=True,capture_output=True,timeout=20)
    assert p.returncode==0,p.stderr[-400:]
    return p.stdout
def digest(value):return hashlib.sha256(value.encode()).hexdigest()
names=['norva-media-gateway','norva-resume-cache-pilot-20260916','norva-selection-audio-worker']
data={n:json.loads(run(['docker','inspect',n]))[0] for n in names}
env={n:dict(v.split('=',1) for v in d['Config']['Env']) for n,d in data.items()}
out={'workerGateway':env[names[2]].get('MEDIA_GATEWAY_URL'),'concurrency':env[names[2]].get('SELECTION_AUDIO_CONCURRENCY'),
 'captureEnabled':env[names[2]].get('SELECTION_CAPTURE_PIPELINE_ENABLED'),'gatewayDifferences':{},'hashes':{}}
a,b=env[names[0]],env[names[1]]
for key in sorted(set(a)|set(b)):
    if key.startswith('WHISPER_') and a.get(key)!=b.get(key):
        out['gatewayDifferences'][key]={'mainHash':digest(a.get(key,'')),'pilotHash':digest(b.get(key,''))}
for name in names:
    path='/worker/ops/hetzner/services/selection-audio-worker.mjs' if name==names[2] else '/app/src/index.js'
    out['hashes'][name]=digest(run(['docker','exec',name,'cat',path]).replace('\r\n','\n'))
out['sameReceiptSecret']=a.get('GATEWAY_TOKEN')==b.get('GATEWAY_TOKEN')
(ROOT/'runtime.safe.json').write_text(json.dumps(out,indent=2));print(json.dumps(out))
