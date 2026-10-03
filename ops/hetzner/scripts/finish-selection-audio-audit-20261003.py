"""Read-only runtime and HLS evidence closure for the requested audio cohort.

No database write, provider request or worker restart. Private media URLs, raw
model output and receipt contents stay on the server. This is accounting, not a
claim that queued/inconclusive files have an identified language.
"""
import collections,datetime,hashlib,json,pathlib,runpy,subprocess,urllib.request
ROOT=pathlib.Path('/home/adrien/.norva/selection-audio-audit-20261003')
GATEWAYS=['norva-media-gateway','norva-resume-cache-pilot-20260916']
WORKER='norva-selection-audio-worker'

def run(args,stdin=None):
 p=subprocess.run(args,input=stdin,text=True,capture_output=True,timeout=40)
 if p.returncode:raise RuntimeError('Read-only evidence operation failed')
 return p.stdout

def sha(text):return hashlib.sha256(text.replace('\r\n','\n').encode()).hexdigest()

def main():
 runpy.run_path('/home/adrien/.norva/audit-selection-audio-cohort-20261003.py',run_name='__main__')
 cohort=json.loads((ROOT/'cohort-530.safe.json').read_text())
 containers={name:json.loads(run(['docker','inspect',name]))[0] for name in GATEWAYS+[WORKER]}
 environments={name:dict(item.split('=',1) for item in container['Config']['Env']) for name,container in containers.items()}
 gateway_hashes={name:sha(run(['docker','exec',name,'cat','/app/src/index.js'])) for name in GATEWAYS}
 worker_hash=sha(run(['docker','exec',WORKER,'cat','/worker/ops/hetzner/services/selection-audio-worker.mjs']))
 client_path='/worker/supabase/functions/_shared/selection-audio-gateway.mjs'
 client_hash=sha(run(['docker','exec',WORKER,'cat',client_path]))
 a,b=[environments[name] for name in GATEWAYS]
 runtime={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'images':{name:containers[name]['Image'] for name in GATEWAYS},
  'gatewaySourceHashes':gateway_hashes,'gatewaySourceEqual':len(set(gateway_hashes.values()))==1,
  'workerSourceHash':worker_hash,'clientSourceHash':client_hash,'workerRunning':containers[WORKER]['State']['Running'],
  'workerStartedAt':containers[WORKER]['State']['StartedAt'],'workerRestartCount':containers[WORKER]['RestartCount'],
  'receiptSecretEqual':a.get('GATEWAY_TOKEN')==b.get('GATEWAY_TOKEN'),
  'whisperEnvironmentDifferentKeys':[k for k in sorted(set(a)|set(b)) if k.startswith('WHISPER_') and a.get(k)!=b.get(k)],
  'whisperInferenceSettingsEqual':all(a.get(k)==b.get(k) for k in set(a)|set(b) if k.startswith('WHISPER_') and k!='WHISPER_VAD_BIN'),
  'workerConcurrency':environments[WORKER].get('SELECTION_AUDIO_CONCURRENCY'),
  'captureEnabled':environments[WORKER].get('SELECTION_CAPTURE_PIPELINE_ENABLED')}
 engines=[json.load(urllib.request.urlopen('http://127.0.0.1:%s/health'%port,timeout=5))['languageDetectEngine'] for port in [8081,18086]]
 engine_fields=['modelSha256','binarySha256','commit','vadModelSha256','speechSamplerBinarySha256','speechSamplerRuntimeVerified']
 runtime['effectiveInferenceRuntimeEqual']=all(engines[0].get(k)==engines[1].get(k) and engines[0].get(k) is not None for k in engine_fields)
 runtime['effectiveInferenceRuntime']={k:engines[0].get(k) for k in engine_fields}
 sql="""set statement_timeout='15s';select jsonb_build_object(
 'routes',(select jsonb_agg(x) from(select progress->>'gatewayRoute' route,state,count(*) from catalog_selection_audio_jobs where progress ? 'gatewayRoute' group by 1,2)x),
 'diagnosticJobs',(select count(*) from catalog_selection_audio_jobs where state='completed' and jsonb_array_length(coalesce(result->'verification'->'unidentifiedTracks','[]'))>0),
 'functions',(select jsonb_object_agg(p.proname,md5(pg_get_functiondef(p.oid))) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('claim_selection_audio_job','recover_selection_audio_job','selection_audio_job_owners','seed_selection_audio_jobs','defer_selection_audio_admission')));"""
 db=json.loads(run(['docker','exec','-i','norva-db','psql','-X','-q','-At','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],sql))
 hls=[]
 for name,kind in [('hls-audit.safe.json','six-disjoint-20-second-windows'),('hls-speech-audit.safe.json','six-60-second-regions-with-20-second-VAD-selection')]:
  for row in json.loads((ROOT/name).read_text()):
   inference=row.get('inference') or row.get('result') or {}
   evidence=inference.get('evidence') or []
   hls.append({'externalId':row['externalId'],'title':row['title'],'audit':kind,'seconds':row['seconds'],
    'inferenceSucceeded':inference.get('ok') is True,'verified':inference.get('verified') is True,
    'evaluatedWindows':len(evidence),'dispositions':dict(collections.Counter(s.get('disposition','missing') for s in evidence))})
 closure={'at':runtime['at'],'cohortSummary':{k:v for k,v in cohort.items() if k!='files'},'runtime':runtime,'databaseEvidence':db,'nativeHlsAudits':hls,
  'incompleteFreshProbe':json.loads((ROOT/'incomplete-probe.safe.json').read_text()),
  'scope':'All 533 exact file identities reconciled; queued/retry/inconclusive are not identified audio.'}
 (ROOT/'closure-530.safe.json').write_text(json.dumps(closure,indent=2,ensure_ascii=False))
 print(json.dumps(closure,ensure_ascii=False))

if __name__=='__main__':main()
