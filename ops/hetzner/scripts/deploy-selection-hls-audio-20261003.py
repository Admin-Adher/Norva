"""Deploy the single reviewed HLS extraction delta, with idle gates and rollback copies."""
import importlib.util,json,pathlib,subprocess,time
ROOT=pathlib.Path('/home/adrien/.norva/selection-hls-audio-20261003')
spec=importlib.util.spec_from_file_location('prior','/home/adrien/.norva/selection-audio-audit-20261003/deploy-selection-startup-20261001.py');prior=importlib.util.module_from_spec(spec);spec.loader.exec_module(prior);prior.ROOT=ROOT
EXPECTED='c94762b2d2d860e120a009824dd203c147da26519e0db52acc575afaad81423d';WORKER='norva-selection-audio-worker'
NAMES=[('norva-media-gateway',8081),('norva-resume-cache-pilot-20260916',18086)]
def main():
 base=prior.inspect(NAMES[0][0])['Image'];before=prior.run('docker','exec',NAMES[0][0],'cat','/app/src/index.js').replace(b'\r\n',b'\n');after=(ROOT/'services/media-gateway/src/index.js').read_bytes().replace(b'\r\n',b'\n')
 anchor=b"            '-probesize', '2000000', '-analyzeduration', '3000000',\n            ...(startOffset > 0 ? ['-ss', String(startOffset)] : []),"
 addition=b"            ...(!strictLoopback ? codecProbeInputOptions(url) : []),\n"
 assert before.count(anchor)==1 and before.replace(anchor,anchor.replace(b'            ...(startOffset',addition+b'            ...(startOffset'))==after,'Unexpected source change'
 for name,port in NAMES:assert prior.inspect(name)['Image']==base and prior.sha(prior.run('docker','exec',name,'cat','/app/src/index.js'))==EXPECTED,'Replica drift'
 prior.BASE=base;prior.GATEWAY_BEFORE=EXPECTED;tag='norva-selection-hls-audio-base:20261003';prior.run('docker','tag',base,tag)
 (ROOT/'Dockerfile').write_text('FROM '+tag+'\nCOPY services/media-gateway/src/index.js /app/src/index.js\n')
 subprocess.check_call(['docker','build','--pull=false','-t','norva-selection-hls-audio:20261003',str(ROOT)])
 image=json.loads(prior.run('docker','image','inspect','norva-selection-hls-audio:20261003'))[0]['Id']
 fixture=(ROOT/'tests/fixtures/hls-audio-extraction-runtime.cjs').read_bytes()
 proof=subprocess.run(['docker','run','--rm','-i','--network','none','--entrypoint','node',image,'-'],input=fixture,capture_output=True,timeout=30)
 assert proof.returncode==0 and json.loads(proof.stdout)['nestedLocalFileDenied'],'Real extraction fixture failed'
 stopped=False
 try:
  prior.run('docker','stop','--time','45',WORKER);stopped=True;assert prior.inspect(WORKER)['State']['ExitCode']==0,'Worker drain failed'
  for name,port in NAMES:prior.replace_gateway(name,port,image)
 finally:
  if stopped:prior.run('docker','start',WORKER)
 receipt={'atEpoch':time.time(),'image':image,'beforeSha256':EXPECTED,'afterSha256':prior.sha(after),'replicas':[n for n,p in NAMES],'realExtractionProof':json.loads(proof.stdout),'workerRunning':prior.inspect(WORKER)['State']['Running']}
 (ROOT/'deployment.safe.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
if __name__=='__main__':main()
