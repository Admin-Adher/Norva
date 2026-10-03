"""Align the worker's local-only deadline with the existing Gateway budget."""
import collections,hashlib,json,pathlib,subprocess,time
ROOT=pathlib.Path('/home/adrien/.norva/selection-inference-budget-20261003')
TARGET=pathlib.Path('/home/adrien/.norva/enrichment-pilot20-20260911/selection-live-functions/_shared/selection-audio-gateway.mjs')
NAME='norva-selection-audio-worker'
EXPECTED='c36825d2adfc827393e58e32bb5ce49b162b26ac11bf484d4a85459a8bd84ebd'
def sha(data):return hashlib.sha256(data.replace(b'\r\n',b'\n')).hexdigest()
def main():
 before=TARGET.read_bytes();assert sha(before)==EXPECTED,'Client module drift'
 after=(ROOT/'selection-audio-gateway.mjs').read_bytes()
 assert after.replace(b'\r\n',b'\n').replace(b"      // The Gateway allows 100 s of provider-free speech sampling/inference,\n      // with a 105 s handler deadline. A shorter client deadline aborted a\n      // valid local quality fallback and needlessly spent another retry.\n",b'').replace(b"action === 'infer' ? 110_000",b"action === 'infer' ? 60_000")==before.replace(b'\r\n',b'\n'),'Unexpected source delta'
 (ROOT/'client.before.mjs').write_bytes(before)
 diagnostics=collections.Counter()
 for name in ['norva-media-gateway','norva-resume-cache-pilot-20260916']:
  p=subprocess.run(['docker','logs','--since','2h',name],text=True,capture_output=True,timeout=15)
  for line in (p.stdout+p.stderr).splitlines():
   try:d=json.loads(line)
   except:continue
   if d.get('event')=='strict_lid_capture_diagnostic':
    diagnostics[(d.get('stage'),d.get('code'),int(d.get('elapsedMs',0)//10000)*10)]+=1
 subprocess.run(['docker','stop','--time','240',NAME],check=True,capture_output=True,timeout=250)
 state=json.loads(subprocess.check_output(['docker','inspect',NAME]))[0]['State'];assert state['ExitCode']==0,'Worker did not reach a drained checkpoint'
 try:
  TARGET.write_bytes(after)
  subprocess.run(['docker','start',NAME],check=True,capture_output=True,timeout=30)
  runtime=subprocess.check_output(['docker','exec',NAME,'cat','/worker/supabase/functions/_shared/selection-audio-gateway.mjs'])
  assert sha(runtime)==sha(after),'Mounted client did not update'
 except BaseException:
  TARGET.write_bytes(before);subprocess.run(['docker','start',NAME],capture_output=True,timeout=30);raise
 receipt={'atEpoch':time.time(),'beforeSha256':sha(before),'afterSha256':sha(after),'inferenceClientBudgetMs':110000,'serverLocalBudgetMs':100000,'serverHandlerDeadlineMs':105000,'workerRunning':True,
  'gatewayDiagnostics':[{'stage':a,'code':b,'elapsedBucketSeconds':c,'count':n} for (a,b,c),n in diagnostics.items()]}
 (ROOT/'deployment.safe.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
if __name__=='__main__':main()
