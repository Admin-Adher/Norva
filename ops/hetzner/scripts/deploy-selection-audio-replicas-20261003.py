"""Use both existing production replicas for fresh jobs; retain exact local capture affinity."""
import importlib.util,json,pathlib,subprocess,time,urllib.request
ROOT=pathlib.Path('/home/adrien/.norva/selection-audio-progress-20261003')
spec=importlib.util.spec_from_file_location('prior','/home/adrien/.norva/selection-audio-audit-20261003/deploy-selection-startup-20261001.py')
prior=importlib.util.module_from_spec(spec);spec.loader.exec_module(prior);prior.ROOT=ROOT
NAME='norva-selection-audio-worker';TARGET=pathlib.Path('/home/adrien/.norva/enrichment-pilot20-20260911/selection-live-runner/selection-audio-worker.mjs')
EXPECTED='9a3f97f60f88a09303a26a85d3ced9ad8ee24e6a50f77aa4bcb7d2cc3296b5fb'
def run(*args):return subprocess.check_output(args,timeout=65)
def main():
 old=prior.inspect(NAME);before=TARGET.read_bytes();assert prior.sha(before)==EXPECTED,'Worker drift'
 prior.save(ROOT/'worker-replicas.before.private.json',json.dumps(old).encode());prior.save(ROOT/'worker-replicas.before.mjs',before)
 a,b=[prior.inspect(n) for n in ['norva-media-gateway','norva-resume-cache-pilot-20260916']]
 ae,be=[dict(v.split('=',1) for v in d['Config']['Env']) for d in [a,b]]
 assert ae['GATEWAY_TOKEN']==be['GATEWAY_TOKEN'],'Replica authentication mismatch'
 for key in set(ae)|set(be):
  if key.startswith('WHISPER_') and key!='WHISPER_VAD_BIN':assert ae.get(key)==be.get(key),'Inference configuration mismatch'
 engines=[json.load(urllib.request.urlopen('http://127.0.0.1:%s/health'%p))['languageDetectEngine'] for p in [8081,18086]]
 for key in ['modelSha256','binarySha256','commit','vadModelSha256','speechSamplerBinarySha256','speechSamplerRuntimeVerified']:
  assert engines[0][key]==engines[1][key],'Receipt runtime mismatch'
 urls=['http://norva-media-gateway:8080','http://norva-resume-cache-pilot-20260916:8080']
 script='console.log(JSON.stringify(await Promise.all('+json.dumps(urls)+'.map(async u=>({ok:(await fetch(u+"/health")).ok})))));'
 assert all(x['ok'] for x in json.loads(run('docker','exec',NAME,'node','--input-type=module','-e',script))),'Peer unreachable'
 env=dict(v.split('=',1) for v in old['Config']['Env']);assert env['MEDIA_GATEWAY_URL']==urls[0] and env.get('SELECTION_AUDIO_GATEWAY_URLS') is None
 run('docker','stop','--time','45',NAME);assert prior.inspect(NAME)['State']['ExitCode']==0,'Worker drain failed'
 backup=NAME+'-before-two-replicas-20261003';run('docker','rename',NAME,backup)
 created=False
 try:
  TARGET.write_bytes((ROOT/'ops/hetzner/services/selection-audio-worker.mjs').read_bytes())
  config=dict(old['Config']);config['Image']=old['Image'];config['Env']=old['Config']['Env']+['SELECTION_AUDIO_GATEWAY_URLS='+json.dumps(urls)]
  config['HostConfig']=old['HostConfig'];config['NetworkingConfig']={'EndpointsConfig':{n:{'Aliases':[NAME]} for n in old['NetworkSettings']['Networks']}}
  prior.docker_post('/containers/create?name='+NAME,config);created=True;run('docker','start',NAME)
  assert prior.inspect(NAME)['State']['Running']
  assert prior.sha(run('docker','exec',NAME,'cat','/worker/ops/hetzner/services/selection-audio-worker.mjs'))==prior.sha(TARGET.read_bytes())
 except BaseException:
  if created:run('docker','stop','--time','45',NAME);run('docker','rm',NAME)
  TARGET.write_bytes(before);run('docker','rename',backup,NAME);run('docker','start',NAME);raise
 receipt={'atEpoch':time.time(),'workerSha256':prior.sha(TARGET.read_bytes()),'routeCount':2,'replicaRuntimeIdentical':True,'legacyCaptureRoutePreserved':True}
 (ROOT/'worker-replicas.safe.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
if __name__=='__main__':main()
