"""One bounded scheduling repair; preserve job IDs, profiles and retry debits.

Only pre-repair waits in the immutable 530-title cohort are eligible. No running,
completed or terminal analysis is reset. Compare-and-swap protects live workers.
"""
import datetime,hashlib,json,pathlib,subprocess
ROOT=pathlib.Path('/home/adrien/.norva/selection-audio-audit-20261003')
REPAIR_CUTOFF='2026-10-03T03:38:00Z'
ERRORS=['SELECTION_AUDIO_CHECKPOINT_RESET_REQUIRED','SELECTION_AUDIO_VIEWER_BUSY','SELECTION_AUDIO_CAPACITY_BUSY']
def sql(query):
 p=subprocess.run(['docker','exec','-i','norva-db','psql','-X','-q','-At','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],input="set statement_timeout='30s';set lock_timeout='2s';"+query,text=True,capture_output=True,timeout=40)
 if p.returncode:raise RuntimeError('Scheduling repair rejected')
 return p.stdout.strip()
def main():
 identities=json.loads((ROOT/'baseline-530-identities.safe.json').read_text());assert len(identities['externalIds'])==533
 ids=json.dumps(identities['externalIds']);codes="'{"+','.join(ERRORS)+"}'::text[]"
 candidate=json.loads(sql("select coalesce(jsonb_agg(j),'[]') from catalog_selection_audio_jobs j where external_id in(select jsonb_array_elements_text($ids$%s$ids$::jsonb)) and state='retry_wait' and lease_token is null and attempt_count between 1 and 7 and error_code=any(%s) and updated_at<'%s'::timestamptz and next_attempt_at>clock_timestamp();"%(ids,codes,REPAIR_CUTOFF)))
 stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
 archive=ROOT/('expedited-waits-'+stamp+'.private.json');archive.write_text(json.dumps(candidate));archive.chmod(0o600)
 checks=[{'id':r['id'],'updatedAt':r['updated_at'],'nextAttemptAt':r['next_attempt_at'],'attempts':r['attempt_count'],'error':r['error_code']} for r in candidate]
 # Row locks/CAS remain short. The worker's normal admission authority still
 # decides whether a job can run; this only removes the old error backoff.
 q="""begin;with inputs as(select * from jsonb_to_recordset($rows$%s$rows$::jsonb) as x(id uuid,"updatedAt" timestamptz,"nextAttemptAt" timestamptz,attempts integer,error text)),changed as(
 update catalog_selection_audio_jobs j set next_attempt_at=clock_timestamp(),updated_at=clock_timestamp() from inputs i where j.id=i.id and j.state='retry_wait' and j.lease_token is null and j.updated_at=i."updatedAt" and j.next_attempt_at=i."nextAttemptAt" and j.attempt_count=i.attempts and j.error_code=i.error and j.error_code=any(%s) and j.updated_at<'%s'::timestamptz returning j.error_code,j.attempt_count)
 select jsonb_build_object('changed',count(*),'retryDebitsUnchanged',true,'errors',coalesce(jsonb_agg(error_code),'[]')) from changed;commit;"""%(json.dumps(checks),codes,REPAIR_CUTOFF)
 result=json.loads(sql(q));counts={e:result['errors'].count(e) for e in ERRORS};receipt={'at':stamp,'candidateCount':len(candidate),'changed':result['changed'],'counts':counts,'retryDebitsUnchanged':True,'jobsAndEvidenceUnchanged':True,'preRepairOnly':REPAIR_CUTOFF,'archiveSha256':hashlib.sha256(archive.read_bytes()).hexdigest()}
 (ROOT/('expedited-waits-'+stamp+'.safe.json')).write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
if __name__=='__main__':main()
