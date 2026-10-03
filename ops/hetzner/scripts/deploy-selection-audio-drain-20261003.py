"""Publish only the two reviewed pre-probe refusals, with idle gates and rollback."""
import importlib.util,json,pathlib,subprocess,time

ROOT=pathlib.Path('/home/adrien/.norva/selection-audio-audit-20261003')
spec=importlib.util.spec_from_file_location('prior',ROOT/'deploy-selection-startup-20261001.py')
prior=importlib.util.module_from_spec(spec);spec.loader.exec_module(prior)
prior.ROOT=ROOT
names=[('norva-media-gateway',8081),('norva-resume-cache-pilot-20260916',18086)]
EXPECTED='1c7c6674c817dfd3ca79e37540ed4e3b991efa582b8994469ed81bd0f0ffd1bb'
WORKER='norva-selection-audio-worker'

def main():
    base=prior.inspect(names[0][0])['Image']
    before=prior.run('docker','exec',names[0][0],'cat','/app/src/index.js').replace(b'\r\n',b'\n')
    after=(ROOT/'services/media-gateway/src/index.js').read_bytes().replace(b'\r\n',b'\n')
    for status,message,code in [(409,'active playback','account_busy'),(429,'background extraction','background_busy')]:
        old="return res.status(%s).json({ error: 'Account busy (%s)', code: '%s' });"%(status,message,code)
        new="return res.status(%s).json({ error: 'Account busy (%s)', code: '%s',\n                ...await providerProbeDrainAttestation(providerDrainState) });"%(status,message,code)
        assert before.count(old.encode())==1,'Refusal source drift'
        before=before.replace(old.encode(),new.encode())
    assert before==after,'Unexpected source changes'
    for name,port in names:
        assert prior.inspect(name)['Image']==base,'Replica image drift'
        assert prior.sha(prior.run('docker','exec',name,'cat','/app/src/index.js'))==EXPECTED,'Replica source drift'
    target=ROOT/'services/media-gateway/src/index.js';target.write_bytes(after)
    prior.BASE=base;prior.GATEWAY_BEFORE=EXPECTED
    tag='norva-selection-audio-drain-base:20261003'
    prior.run('docker','tag',base,tag)
    (ROOT/'Dockerfile').write_text('FROM '+tag+'\nCOPY services/media-gateway/src/index.js /app/src/index.js\n')
    subprocess.check_call(['docker','build','--pull=false','-t','norva-selection-audio-drain:20261003',str(ROOT)])
    image=json.loads(prior.run('docker','image','inspect','norva-selection-audio-drain:20261003'))[0]['Id']
    stopped=False
    try:
        prior.run('docker','stop','--time','45',WORKER);stopped=True
        assert prior.inspect(WORKER)['State']['ExitCode']==0,'Worker did not drain cleanly'
        for name,port in names:prior.replace_gateway(name,port,image)
    finally:
        if stopped:prior.run('docker','start',WORKER)
    receipt={'atEpoch':time.time(),'beforeSha256':EXPECTED,'afterSha256':prior.sha(after),
        'image':image,'replicas':[n for n,p in names],'workerResumed':prior.inspect(WORKER)['State']['Running']}
    (ROOT/'gateway-deployment.safe.json').write_text(json.dumps(receipt));print(json.dumps(receipt))

if __name__=='__main__':main()
