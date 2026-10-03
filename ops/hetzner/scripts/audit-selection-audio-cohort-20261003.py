"""Read-only exact-file accounting for the 530-title user-requested cohort.

Input identities come from the earlier public audit; media URLs remain on host.
Each count uses one database snapshot. No transcript, credential or URL is exported.
"""
import collections,datetime,hashlib,json,pathlib,subprocess
ROOT=pathlib.Path('/home/adrien/.norva/selection-audio-audit-20261003')
def main():
 identities=json.loads((ROOT/'baseline-530-identities.safe.json').read_text())
 baseline=json.loads((ROOT/'baseline-554.private.json').read_text())
 requested=set(identities['externalIds']);rows=[r for r in baseline['rows'] if r['external_id'] in requested]
 assert len(rows)==533 and len(requested)==533,'Cohort identity mismatch'
 assert len({r['title_id'] for r in rows})==530,'Cohort title mismatch'
 first=rows[0]
 q="""with unknown as materialized(select * from cloud_catalog_unidentified_audio_variants('%s','movie','%s'))
 select jsonb_build_object('currentTitles',(select count(distinct title_id) from unknown),'currentFiles',(select count(*) from unknown),
 'externalIds',(select jsonb_agg(v.external_id) from unknown x join cloud_catalog_visible_title_variants v on v.id=x.variant_id and v.title_id=x.title_id),
 'jobs',(select jsonb_agg(j) from catalog_selection_audio_jobs j));"""%(first['user_id'],first['source_id'])
 p=subprocess.run(['docker','exec','-i','norva-db','psql','-X','-q','-At','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],input="set statement_timeout='30s';"+q,text=True,capture_output=True,timeout=40)
 if p.returncode:raise RuntimeError('Cohort snapshot failed')
 snapshot=json.loads(p.stdout);unknown=set(snapshot['externalIds'] or []);jobs={(j['external_id'],j['url_sha256']):j for j in snapshot['jobs']};out=[]
 for r in rows:
  j=jobs.get((r['external_id'],hashlib.sha256(r['playback_hint']['targetUrl'].encode()).hexdigest()),{});result=j.get('result') or {};tracks=result.get('audioTracks') or []
  languages=sorted({t.get('lang') or t.get('language') for t in tracks if (t.get('lang') or t.get('language')) not in [None,'und','un','unknown','mul','zxx']})
  state=j.get('state','no_job');remaining=r['external_id'] in unknown
  reason='identified' if not remaining else 'no_audited_job' if state=='no_job' else ('awaiting_publication' if languages else 'analysis_inconclusive') if state=='completed' else state+':'+str(j.get('error_code') or 'processing')
  out.append({'externalId':r['external_id'],'providerTitle':r['raw_title'],'stillUnidentified':remaining,'classification':reason,'jobState':state,'errorCode':j.get('error_code'),'attempts':j.get('attempt_count'),'resultLanguages':languages,'resultVerified':result.get('verified'),'completedAt':j.get('completed_at')})
 identified={r['title_id'] for r in rows if r['external_id'] not in unknown};remaining={r['title_id'] for r in rows if r['external_id'] in unknown}
 report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'baselineAt':identities['at'],'baselineTitles':530,'baselineFiles':533,
 'currentUnidentifiedTitles':snapshot['currentTitles'],'currentUnidentifiedFiles':snapshot['currentFiles'],'cohortTitlesNowIdentified':len(identified-remaining),'cohortFilesNowIdentified':sum(not r['stillUnidentified'] for r in out),
 'classifications':dict(collections.Counter(r['classification'] for r in out)),'identifiedLanguages':dict(collections.Counter(l for r in out if not r['stillUnidentified'] for l in r['resultLanguages'])),'files':out}
 (ROOT/'cohort-530.safe.json').write_text(json.dumps(report,indent=2,ensure_ascii=False));print(json.dumps({k:v for k,v in report.items() if k!='files'}))
if __name__=='__main__':main()
