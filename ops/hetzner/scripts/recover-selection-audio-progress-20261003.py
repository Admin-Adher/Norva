"""Recover only exact baseline files failed by the reviewed bugs, once per file."""
import collections,json,pathlib,subprocess,time
ROOT=pathlib.Path('/home/adrien/.norva/selection-audio-audit-20261003')
REV='2d02867c337f1a824e82908005fb14fd2c6d3388'
def sql(query):
 p=subprocess.run(['docker','exec','-i','norva-db','psql','-X','-q','-At','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],input="set statement_timeout='45s';set request.jwt.claim.role='service_role';"+query,text=True,capture_output=True,timeout=55)
 if p.returncode:raise RuntimeError(p.stderr[-400:])
 return p.stdout.strip()
def main():
 baseline=json.loads((ROOT/'baseline-554.private.json').read_text())['rows']
 allowed={r['external_id'] for r in baseline}
 # Production source receipt must prove this exact repair was actually deployed.
 deployed=json.loads(pathlib.Path('/home/adrien/.norva/selection-audio-progress-20261003/deployment.safe.json').read_text())
 assert deployed['sqlRollbackProof'] and deployed['workerRunning']
 jobs=json.loads(sql("select coalesce(jsonb_agg(j),'[]') from public.catalog_selection_audio_jobs j where state='failed' and attempt_count=8 and error_code in ('SELECTION_AUDIO_VIEWER_BUSY','SELECTION_AUDIO_CHECKPOINT_RESET_REQUIRED','SELECTION_AUDIO_CAPTURE_LOCAL_RETRY') and not exists(select 1 from public.catalog_selection_audio_recoveries r where r.external_id=j.external_id and r.url_sha256=j.url_sha256);"))
 out=collections.Counter();private=[]
 for j in jobs:
  if j['external_id'] not in allowed:continue
  # Job ID/completed-at CAS and canonical seeder verify the current exact URL,
  # active owners and generation again. Never bulk-update attempt_count.
  try:
   result=sql("select public.recover_selection_audio_job('%s','%s','%s');"%(j['id'],j['completed_at'],REV))
   private.append({'prior':j,'replacement':result});out[j['error_code']]+=1
  except RuntimeError as error:
   if 'SELECTION_RECOVERY_BUSY' in str(error):
    time.sleep(1);continue
   raise
  if sum(out.values())%25==0:print(json.dumps({'recovered':sum(out.values())}),flush=True)
 (ROOT/'recovered-progress.private.json').write_text(json.dumps(private));(ROOT/'recovered-progress.private.json').chmod(0o600)
 receipt={'atEpoch':time.time(),'repairRevision':REV,'recovered':sum(out.values()),'byPriorReason':dict(out)}
 (ROOT/'recovered-progress.safe.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
if __name__=='__main__':main()
