"""Reviewed Selection batches and public probe route; drift checks and rollback images."""
import importlib.util, json, pathlib, subprocess, sys, time

ROOT=pathlib.Path('/home/adrien/.norva/selection-batching-release-20261001')
spec=importlib.util.spec_from_file_location('prior',ROOT/'ops/hetzner/scripts/deploy-selection-startup-20261001.py')
prior=importlib.util.module_from_spec(spec); spec.loader.exec_module(prior)
prior.ROOT=ROOT
prior.BASE='sha256:a39587ca3c5a1fca4257471d23c26e4c48bda8ef3e9460ccf67bbc79ec398567'
prior.GATEWAY_BEFORE='60dd6f15d931ab8ad38748e7ba4133064b914961531404c269e0aef34f51676e'
BEFORE={
    '_shared/selection-audio-results.mjs':'eedc251c2094bbf858354b0ce3250c57635a249ff3bb0be0c34c6d576bb64072',
    '_shared/selection-initial-import.mjs':'6a593eed7d2d6c5e8c1eb56bf5f628a91634159294d0e86f07f00f84424bd1fe',
    '_shared/selection-snapshot-tracks.mjs':'e44215ee03c9b22e8811aba50312fccd9ee50bca04a82cba3d3fca9be32e91c8',
    '_shared/selection-hydration-batches.mjs':None,
    'norva-source-sync/index.ts':'9d32ebc3f14eb5b7553abc0690656036451a8cae4f4801f3b6848f2bb9e11f1c',
}

def edge():
    for f,expected in BEFORE.items():
        p=prior.EDGE/f
        assert (prior.sha(p.read_bytes()) if p.exists() else None)==expected,'Edge drift: '+f
    assert prior.sql('select count(*) from cloud_source_finalize_leases where lease_until>clock_timestamp();')=='0'
    backup=ROOT/'edge-before';backup.mkdir(mode=0o700,exist_ok=False)
    prior.sql((ROOT/'supabase/migrations/20261001113000_selection_snapshot_batch_bound.sql').read_text())
    applied={}
    for f in BEFORE:
        p=prior.EDGE/f
        if p.exists():
            saved=backup/f;saved.parent.mkdir(parents=True,exist_ok=True);saved.write_bytes(p.read_bytes())
        p.write_bytes((ROOT/'supabase/functions'/f).read_bytes());applied[f]=prior.sha(p.read_bytes())
    for name in ['norva-edge-functions-2','norva-edge-functions']:
        prior.run('docker','restart',name)
        assert prior.inspect(name)['State']['Running']
        for f,digest in applied.items():
            assert prior.sha(prior.run('docker','exec',name,'cat','/home/deno/functions/'+f))==digest
        print(json.dumps({'replica':name,'verified':len(applied)}),flush=True)
    receipt={'appliedAtEpoch':time.time(),'files':applied}
    (ROOT/'edge-receipt.safe.json').write_text(json.dumps(receipt));print(json.dumps(receipt))

def build():
    for name in ['norva-media-gateway','norva-resume-cache-pilot-20260916']:
        assert prior.inspect(name)['Image']==prior.BASE,'Gateway image drift'
        assert prior.sha(prior.run('docker','exec',name,'cat','/app/src/index.js'))==prior.GATEWAY_BEFORE
        assert prior.sha(prior.run('docker','exec',name,'cat','/app/src/public-vod-route.js'))=='9288f313391d681d591d154526365c9690aa116a14df31fb5c63dd6dc65f680b'
    tag='norva-selection-batching-base:20261001'
    prior.run('docker','tag',prior.BASE,tag)
    (ROOT/'Dockerfile').write_text('FROM '+tag+'\nCOPY services/media-gateway/src/index.js services/media-gateway/src/public-vod-route.js /app/src/\n')
    subprocess.check_call(['docker','build','--pull=false','-t','norva-selection-batching:20261001',str(ROOT)],stdout=sys.stderr)
    image=json.loads(prior.run('docker','image','inspect','norva-selection-batching:20261001'))[0]['Id']
    (ROOT/'image.safe.json').write_text(json.dumps({'image':image}));print(json.dumps({'image':image}))

if __name__=='__main__':
    mode=sys.argv[1]
    if mode=='build':build()
    elif mode=='edge':edge()
    elif mode in ('main','pilot'):
        image=json.loads((ROOT/'image.safe.json').read_text())['image']
        name,port=('norva-media-gateway',8081) if mode=='main' else ('norva-resume-cache-pilot-20260916',18086)
        prior.replace_gateway(name,port,image)
        assert prior.sha(prior.run('docker','exec',name,'cat','/app/src/public-vod-route.js'))==prior.sha((ROOT/'services/media-gateway/src/public-vod-route.js').read_bytes())
    else:raise ValueError('Expected build, edge, main or pilot')
