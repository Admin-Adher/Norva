"""Two real sessions: global worker admission and per-file recovery do not conflict."""
import json,pathlib,subprocess,time
ROOT=pathlib.Path('/home/adrien/.norva/selection-audio-progress-20261003')
BASE=['docker','exec','-i','norva-db','psql','-X','-q','-At','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres']
def sql(q):
 p=subprocess.run(BASE,input=q,text=True,capture_output=True,timeout=50)
 if p.returncode:raise RuntimeError(p.stderr[-500:])
 return p.stdout.strip()
def main():
 migration=(ROOT/'supabase/migrations/20261003023000_selection_audio_recovery_file_lock.sql').read_text()
 sql(migration.replace('commit;','rollback;'))
 sql(migration)
 holder=subprocess.Popen(BASE,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 holder.stdin.write("begin;select pg_advisory_xact_lock(hashtextextended('selection-audio-global-worker-v1',0));select 'lock-held';select pg_sleep(25);rollback;\n");holder.stdin.close()
 while True:
  line=holder.stdout.readline()
  if line.strip()=='lock-held':break
  if not line:raise RuntimeError('Global lock fixture failed')
 started=time.time()
 proof=sql("""begin;set local statement_timeout='20s';set local request.jwt.claim.role='service_role';
 do $p$ declare j public.catalog_selection_audio_jobs%rowtype;n uuid;begin
 select * into j from public.catalog_selection_audio_jobs x where state='failed' and attempt_count=8
  and error_code in ('SELECTION_AUDIO_VIEWER_BUSY','SELECTION_AUDIO_CHECKPOINT_RESET_REQUIRED','SELECTION_AUDIO_CAPTURE_LOCAL_RETRY')
  and not exists(select 1 from public.catalog_selection_audio_recoveries r where r.external_id=x.external_id and r.url_sha256=x.url_sha256) limit 1;
 if j.id is null then raise exception 'NO_REAL_LOCK_PROOF';end if;
 n:=public.recover_selection_audio_job(j.id,j.completed_at,'2d02867c337f1a824e82908005fb14fd2c6d3388');
 if n=j.id then raise exception 'REPLACEMENT_ID_UNCHANGED';end if;
 end $p$;select 'independent-recovery-passed';rollback;""")
 assert proof=='independent-recovery-passed' and holder.poll() is None,'Recovery did not finish under held global admission'
 result={'twoSessionProof':True,'seconds':round(time.time()-started,3),'productionRecoveryUntouched':True}
 (ROOT/'recovery-lock.safe.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
 holder.wait(timeout=30)
if __name__=='__main__':main()
