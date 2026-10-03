"""Publish the reviewed checkpointed worker shutdown and narrowly recover old aborts."""
import hashlib,json,pathlib,subprocess,time
ROOT=pathlib.Path('/home/adrien/.norva/selection-worker-drain-20261003');NAME='norva-selection-audio-worker'
TARGET=pathlib.Path('/home/adrien/.norva/enrichment-pilot20-20260911/selection-live-runner/selection-audio-worker.mjs')
EXPECTED='5a9aef8ca3ce9990795a7f0df928cf88b7d22ec54d666ea7ec276ba4861c05d8'
def sha(data):return hashlib.sha256(data.replace(b'\r\n',b'\n')).hexdigest()
def sql(query):
 p=subprocess.run(['docker','exec','-i','norva-db','psql','-X','-q','-At','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],input=query,text=True,capture_output=True,timeout=55)
 if p.returncode:raise RuntimeError('Shutdown migration rejected')
 return p.stdout.strip()
def main():
 before=TARGET.read_bytes();assert sha(before)==EXPECTED,'Worker drift';(ROOT/'worker.before.mjs').write_bytes(before)
 migration=(ROOT/'20261003024000_selection_audio_shutdown_recovery.sql').read_text()
 assert sql(migration.replace('commit;',"select not has_function_privilege('authenticated','public.recover_selection_audio_job(uuid,timestamptz,text)','execute');rollback;"))=='t','Client ACL proof failed'
 subprocess.run(['docker','stop','--time','45',NAME],check=True,capture_output=True,timeout=55)
 state=json.loads(subprocess.check_output(['docker','inspect',NAME]))[0]['State'];assert state['ExitCode']==0,'Old worker did not drain'
 changed=False
 try:
  TARGET.write_bytes((ROOT/'selection-audio-worker.mjs').read_bytes());changed=True
  sql(migration+"notify pgrst,'reload schema';")
  subprocess.run(['docker','start',NAME],check=True,capture_output=True,timeout=30)
  deployed=subprocess.check_output(['docker','exec',NAME,'cat','/worker/ops/hetzner/services/selection-audio-worker.mjs']);assert sha(deployed)==sha(TARGET.read_bytes())
 except BaseException:
  if changed:TARGET.write_bytes(before)
  subprocess.run(['docker','start',NAME],capture_output=True,timeout=30);raise
 receipt={'atEpoch':time.time(),'beforeSha256':EXPECTED,'afterSha256':sha(TARGET.read_bytes()),'workerRunning':json.loads(subprocess.check_output(['docker','inspect',NAME]))[0]['State']['Running'],'safeShutdownRevision':'ad790c1a41b07434dc8bb595388e6365b0dc3c67','clientRecoveryDenied':True}
 (ROOT/'deployment.safe.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
if __name__=='__main__':main()
