"""Stage bounded inconclusive diagnostics while the worker is safely paused."""
import hashlib,json,pathlib,subprocess,time
ROOT=pathlib.Path('/home/adrien/.norva/selection-audio-diagnostics-20261003')
TARGETS={
 'selection-audio-worker.mjs':('/home/adrien/.norva/enrichment-pilot20-20260911/selection-live-runner/selection-audio-worker.mjs','c20bd2dbfe9ad2599f53e5250c9cd5cc3088f35cd89666cd11bec8b750e9b120'),
 'selection-audio-gateway.mjs':('/home/adrien/.norva/enrichment-pilot20-20260911/selection-live-functions/_shared/selection-audio-gateway.mjs','ec5bbe6ee132d48b2e0250ca9a07887124cbf5c68824cd6371e5df648be7f8c8')}
def sha(data):return hashlib.sha256(data.replace(b'\r\n',b'\n')).hexdigest()
def main():
 state=json.loads(subprocess.check_output(['docker','inspect','norva-selection-audio-worker']))[0]['State']
 assert not state['Running'] and state['ExitCode']==0,'A drained worker checkpoint is required'
 before={};after={}
 for name,(path,expected) in TARGETS.items():
  before[name]=pathlib.Path(path).read_bytes();assert sha(before[name])==expected,'Source drift'
  after[name]=(ROOT/name).read_bytes();(ROOT/(name+'.before')).write_bytes(before[name])
 try:
  for name,(path,_) in TARGETS.items():pathlib.Path(path).write_bytes(after[name])
 except BaseException:
  for name,(path,_) in TARGETS.items():pathlib.Path(path).write_bytes(before[name])
  raise
 receipt={'atEpoch':time.time(),'workerPausedCleanly':True,'newClaimNotStarted':True,'hashes':{name:sha(after[name]) for name in TARGETS},'beforeHashes':{name:sha(before[name]) for name in TARGETS}}
 (ROOT/'deployment.safe.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
if __name__=='__main__':main()
