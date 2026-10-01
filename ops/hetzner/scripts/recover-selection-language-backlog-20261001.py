"""One-time replay of old infrastructure failures, after the exact-file canaries pass.

Keeps completed/inconclusive analyses and proved file defects unchanged. Normal
worker admission, owner checks, viewer preemption and attempt bounds still apply.
"""
import json, os, pathlib, subprocess

ROOT=pathlib.Path('/home/adrien/.norva')
def sql(query):
    r=subprocess.run(['docker','exec','-i','norva-db','psql','-X','-q','-At','-v','ON_ERROR_STOP=1',
        '-U','supabase_admin','-d','postgres'],input=query,text=True,capture_output=True,timeout=30)
    assert r.returncode==0,r.stderr[-800:]
    return r.stdout.strip()

def main():
    canaries=[json.loads((ROOT/'selection-language-canary-20261001.json').read_text()),
        *json.loads((ROOT/'selection-language-sample-20261001.json').read_text())]
    # UUIDs originate from the saved database rows, never arbitrary user input.
    import uuid
    ids=','.join("'%s'"%uuid.UUID(c['id']) for c in canaries)
    assert sql("select count(*) from catalog_selection_audio_jobs where id in ("+ids+") and state='completed' "
        "and cardinality(cloud_file_track_languages(result->'audioTracks'))>0;")==str(len(canaries)), 'canary language proof incomplete'
    backup=ROOT/'selection-language-backlog-before-20261001.private.json'
    assert not backup.exists(),'recovery already attempted; inspect the durable receipt before retrying'
    predicate="state='failed' and error_code='SELECTION_AUDIO_GATEWAY_REJECTED' and attempt_count=8 and updated_at<'2026-09-11T00:00:00Z'"
    rows=json.loads(sql("select coalesce(jsonb_agg(j),'[]') from catalog_selection_audio_jobs j where "+predicate+';'))
    assert 0<len(rows)<=514,'unexpected backlog scope'
    fd=os.open(backup,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(fd,'w') as f:json.dump(rows,f)
    ids=','.join("'%s'"%uuid.UUID(r['id']) for r in rows)
    result=sql("begin;set local lock_timeout='3s';set local statement_timeout='20s';"
        "with changed as (update catalog_selection_audio_jobs set state='queued',attempt_count=0,"
        "next_attempt_at=clock_timestamp(),lease_token=null,lease_until=null,profile='{}',progress='{}',"
        "error_code=null,completed_at=null,updated_at=clock_timestamp() where "+predicate+
        " and id in ("+ids+") returning id) select count(*) from changed;commit;")
    receipt={'requeued':int(result),'selected':len(rows),'completedAnalysesReplayed':0,'knownFileDefectsReplayed':0}
    (ROOT/'selection-language-backlog-recovery-20261001.safe.json').write_text(json.dumps(receipt))
    print(json.dumps(receipt))

if __name__=='__main__':main()
