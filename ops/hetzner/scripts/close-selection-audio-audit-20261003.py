"""Safe exact-file outcome for every file in the immutable 554-title baseline."""
import collections,datetime,hashlib,json,pathlib,subprocess
ROOT=pathlib.Path('/home/adrien/.norva/selection-audio-audit-20261003')

def query(sql):
    p=subprocess.run(['docker','exec','-i','norva-db','psql','-X','-q','-At','-v','ON_ERROR_STOP=1',
      '-U','supabase_admin','-d','postgres'],input="set statement_timeout='30s';"+sql,text=True,capture_output=True,timeout=40)
    if p.returncode:raise RuntimeError(p.stderr[-500:])
    return json.loads(p.stdout)

def langs(tracks):
    return sorted({t.get('lang') or t.get('language') for t in tracks or []
      if (t.get('lang') or t.get('language')) not in (None,'und','un','unknown','mul','zxx')})

def main():
    baseline=json.loads((ROOT/'baseline-554.private.json').read_text())
    first=baseline['rows'][0]
    snapshot=query("""with unknown as materialized(select * from
      cloud_catalog_unidentified_audio_variants('%s','movie','%s'))
      select jsonb_build_object('titles',(select count(distinct title_id) from unknown),
        'files',(select count(*) from unknown),'externalIds',(select jsonb_agg(v.external_id)
          from unknown x join cloud_catalog_visible_title_variants v on v.id=x.variant_id and v.title_id=x.title_id),
        'jobs',(select jsonb_agg(j) from catalog_selection_audio_jobs j));"""%(first['user_id'],first['source_id']))
    current=snapshot
    unknown=set(snapshot['externalIds'] or [])
    jobs=snapshot['jobs']
    jobs={(j['external_id'],j['url_sha256']):j for j in jobs}
    rows=[]
    for r in baseline['rows']:
        digest=hashlib.sha256(r['playback_hint']['targetUrl'].encode()).hexdigest()
        j=jobs.get((r['external_id'],digest),{})
        result=j.get('result') or {}
        remaining=r['external_id'] in unknown
        state=j.get('state','no_job')
        reason=('identified' if not remaining else 'no_audited_job' if state=='no_job'
          else ('awaiting_publication' if langs(result.get('audioTracks')) else 'analysis_inconclusive') if state=='completed'
          else state+':'+str(j.get('error_code') or 'processing'))
        rows.append({'externalId':r['external_id'],'providerTitle':r['raw_title'],
          'stillUnidentified':remaining,'classification':reason,'jobState':state,
          'errorCode':j.get('error_code'),'attempts':j.get('attempt_count'),
          'resultLanguages':langs(result.get('audioTracks')),
          'resultVerified':result.get('verified'),'completedAt':j.get('completed_at')})
    report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
      'baselineTitles':baseline['titles'],'baselineFiles':len(rows),
      'currentUnidentifiedTitles':current['titles'],'currentUnidentifiedFiles':current['files'],
      'identifiedFilesFromBaseline':sum(not r['stillUnidentified'] for r in rows),
      'classifications':dict(collections.Counter(r['classification'] for r in rows)),
      'identifiedLanguages':dict(collections.Counter(l for r in rows if not r['stillUnidentified'] for l in r['resultLanguages'])),
      'files':rows}
    (ROOT/'exhaustive-554.safe.json').write_text(json.dumps(report,indent=2,ensure_ascii=False))
    print(json.dumps({k:v for k,v in report.items() if k!='files'}))

if __name__=='__main__':main()
