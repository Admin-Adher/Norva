"""Drift-checked audio queue repair; zero viewer interruption and private rollback copies."""
import importlib.util,json,os,pathlib,subprocess,time
ROOT=pathlib.Path('/home/adrien/.norva/selection-audio-progress-20261003')
OLD=pathlib.Path('/home/adrien/.norva/selection-audio-audit-20261003')
spec=importlib.util.spec_from_file_location('prior',OLD/'deploy-selection-startup-20261001.py')
prior=importlib.util.module_from_spec(spec);spec.loader.exec_module(prior);prior.ROOT=ROOT
WORKER='norva-selection-audio-worker'
GATEWAYS=[('norva-media-gateway',8081),('norva-resume-cache-pilot-20260916',18086)]
def run(*args):return subprocess.check_output(args,timeout=60)
def sql(query):
 p=subprocess.run(['docker','exec','-i','norva-db','psql','-X','-q','-At','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],input=query,text=True,capture_output=True,timeout=60)
 if p.returncode:raise RuntimeError(p.stderr[-800:])
 return p.stdout.strip()
def main():
 expected=json.loads((ROOT/'expected.safe.json').read_text())
 base=prior.inspect(GATEWAYS[0][0])['Image'];prior.BASE=base;prior.GATEWAY_BEFORE=expected['services/media-gateway/src/index.js']
 for name,port in GATEWAYS:
  assert prior.inspect(name)['Image']==base,'Gateway image drift'
  for rel in ['services/media-gateway/src/index.js','services/media-gateway/src/strict-lid-window-checkpoint.js']:
   assert prior.sha(run('docker','exec',name,'cat','/app/src/'+pathlib.Path(rel).name))==expected[rel],'Gateway source drift'
 targets={
 'ops/hetzner/services/selection-audio-worker.mjs':pathlib.Path('/home/adrien/.norva/enrichment-pilot20-20260911/selection-live-runner/selection-audio-worker.mjs'),
 'supabase/functions/_shared/selection-audio-gateway.mjs':pathlib.Path('/home/adrien/.norva/enrichment-pilot20-20260911/selection-live-functions/_shared/selection-audio-gateway.mjs')}
 for rel,path in targets.items():
  assert prior.sha(path.read_bytes())==expected[rel],'Worker/client drift'
  prior.save(ROOT/(path.name+'.before.private'),path.read_bytes())
 migrations=[(ROOT/'supabase/migrations'/n).read_text() for n in [
  '20261003020000_selection_audio_partial_priority.sql','20261003021000_selection_audio_repair_recovery.sql']]
 dry='begin;set local request.jwt.claim.role=\'service_role\';'+''.join(m.replace('begin;','').replace('commit;','') for m in migrations)
 dry+="""
 do $proof$ declare old_job public.catalog_selection_audio_jobs%rowtype; replacement uuid; replay uuid; rejected boolean:=false; begin
  if has_function_privilege('authenticated','public.claim_selection_audio_job()','execute') or
    has_function_privilege('anon','public.recover_selection_audio_job(uuid,timestamptz,text)','execute') then raise exception 'CLIENT_ACL_REGRESSION'; end if;
  select * into old_job from public.catalog_selection_audio_jobs j where state='failed' and attempt_count=8
    and error_code in ('SELECTION_AUDIO_VIEWER_BUSY','SELECTION_AUDIO_CHECKPOINT_RESET_REQUIRED','SELECTION_AUDIO_CAPTURE_LOCAL_RETRY')
    and not exists(select 1 from public.catalog_selection_audio_recoveries r where r.external_id=j.external_id and r.url_sha256=j.url_sha256)
    order by completed_at desc limit 1;
  if old_job.id is null then raise exception 'NO_REAL_RECOVERY_PROOF';end if;
  begin perform public.recover_selection_audio_job(old_job.id,old_job.completed_at,repeat('0',40));
  exception when sqlstate '55000' then rejected:=true;end;
  if not rejected then raise exception 'WRONG_REPAIR_ACCEPTED';end if;
  replacement:=public.recover_selection_audio_job(old_job.id,old_job.completed_at,'2d02867c337f1a824e82908005fb14fd2c6d3388');
  replay:=public.recover_selection_audio_job(old_job.id,old_job.completed_at,'2d02867c337f1a824e82908005fb14fd2c6d3388');
  if replacement is distinct from replay or not exists(select 1 from public.catalog_selection_audio_jobs where id=replacement and state='queued' and attempt_count=0)
    or not exists(select 1 from public.catalog_selection_audio_recoveries where original_job_id=old_job.id and original_job->>'state'='failed') then raise exception 'RECOVERY_PROOF_FAILED';end if;
 end $proof$;select 'rollback-proof-passed';rollback;
 """
 assert sql(dry)=='rollback-proof-passed','SQL repair rollback proof failed'
 prior.run('docker','tag',base,'norva-selection-audio-progress-base:20261003')
 (ROOT/'Dockerfile').write_text('FROM norva-selection-audio-progress-base:20261003\nCOPY services/media-gateway/src/index.js /app/src/index.js\nCOPY services/media-gateway/src/strict-lid-window-checkpoint.js /app/src/strict-lid-window-checkpoint.js\n')
 subprocess.check_call(['docker','build','--pull=false','-t','norva-selection-audio-progress:20261003',str(ROOT)])
 image=json.loads(run('docker','image','inspect','norva-selection-audio-progress:20261003'))[0]['Id']
 stopped=False;modified=[]
 try:
  run('docker','stop','--time','45',WORKER);stopped=True
  assert prior.inspect(WORKER)['State']['ExitCode']==0,'Worker drain failed'
  for name,port in GATEWAYS:prior.idle(port)
  for name,port in GATEWAYS:prior.replace_gateway(name,port,image)
  for rel,target in targets.items():
   target.write_bytes((ROOT/rel).read_bytes());modified.append(target)
  sql(''.join(migrations)+"notify pgrst,'reload schema';")
  run('docker','start',WORKER);stopped=False
  for rel,target in targets.items():
   deployed=run('docker','exec',WORKER,'cat','/worker/'+rel)
   assert prior.sha(deployed)==prior.sha((ROOT/rel).read_bytes()),'Worker source mismatch'
 except BaseException:
  for target in modified:target.write_bytes((ROOT/(target.name+'.before.private')).read_bytes())
  if stopped:run('docker','start',WORKER)
  raise
 receipt={'atEpoch':time.time(),'image':image,'gateways':[n for n,p in GATEWAYS],
  'sourceHashes':{r:prior.sha((ROOT/r).read_bytes()) for r in expected},'sqlRollbackProof':True,'workerRunning':prior.inspect(WORKER)['State']['Running']}
 (ROOT/'deployment.safe.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
if __name__=='__main__':main()
