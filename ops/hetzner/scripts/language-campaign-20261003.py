"""Server-side scoped campaign operations. Output is aggregate-only; secrets stay in memory."""
import datetime, hashlib, json, os, pathlib, subprocess, sys, uuid

ROOT = pathlib.Path('/home/adrien/.norva/all-unknown-language-20261003')
def inspect(name):
    return json.loads(subprocess.check_output(['docker', 'inspect', name], text=True))[0]
def sql(query):
    result = subprocess.run(['docker', 'exec', '-i', 'norva-db', 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
        input="set default_transaction_read_only=on;set statement_timeout='90s';set lock_timeout='2s';set jit=off;\n" + query,
        text=True, capture_output=True, timeout=180)
    if result.returncode:
        # Never print a query containing tenant identifiers or a provider response.
        raise RuntimeError('Read-only campaign SQL failed: ' + result.stderr.splitlines()[0][:180])
    return [json.loads(line) for line in result.stdout.splitlines() if line.startswith(('{', '['))]
def save(file, value):
    tmp = file.with_suffix('.tmp')
    tmp.write_text(json.dumps(value), encoding='utf-8'); tmp.chmod(0o600); tmp.replace(file)
def prepare():
    ROOT.mkdir(mode=0o700, exist_ok=True); (ROOT/'state').mkdir(mode=0o700, exist_ok=True)
    if (ROOT/'manifest.json').exists():
        print(json.dumps({'prepared': True, 'reusedManifest': True})); return
    sources = sql("""with owners as (select user_id from public.cloud_catalog_visible_sources group by user_id
      having bool_or(display_name='Dino') and bool_or(display_name='MAX OTT'))
      select jsonb_build_object('id',s.id,'userId',s.user_id,'label',s.display_name,'xtream',s.source_type='xtream')
      from public.cloud_catalog_visible_sources s join owners o on o.user_id=s.user_id where (select count(*) from owners)=1;""")
    assert len(sources)==4, 'Unexpected owner/source scope'
    started=datetime.datetime.now(datetime.timezone.utc).isoformat(); manifest=[]
    for source in sources:
        user=str(uuid.UUID(source['userId'])); sid=str(uuid.UUID(source['id']))
        rows=sql(f"""with u as materialized (select * from public.cloud_catalog_unidentified_audio_variants('{user}','movie','{sid}'))
          select jsonb_build_object('variantId',v.id,'titleId',v.title_id,'sourceId',v.source_id,'generationId',v.generation_id,
            'externalId',v.external_id,'hadProfile',v.codec_profile is not null)
          from u join public.cloud_catalog_visible_title_variants v on v.id=u.variant_id and v.user_id='{user}' and v.source_id='{sid}';""")
        manifest.extend(rows)
        print(json.dumps({'source':source['label'],'initialUnknownVariants':len(rows)}),flush=True)
    assert len(manifest)>10000 and len({r['variantId'] for r in manifest})==len(manifest)
    save(ROOT/'manifest.json',{'startedAt':started,'sources':sources,'variants':manifest})
    save(ROOT/'campaign.json',{'edgeUrl':'http://norva-edge-functions:9000/norva-playback/audio-backfill','sources':sources})
    print(json.dumps({'startedAt':started,'variants':len(manifest),'cards':len({r['titleId'] for r in manifest}),
      'manifestSha256':hashlib.sha256((ROOT/'manifest.json').read_bytes()).hexdigest()}))
def start():
    assert (ROOT/'manifest.json').exists() and (ROOT/'language-campaign.mjs').exists()
    existing=subprocess.run(['docker','inspect','norva-language-campaign'],capture_output=True,text=True)
    if existing.returncode==0:
        print(json.dumps({'existing':True,'running':json.loads(existing.stdout)[0]['State']['Running']}));return
    edge=inspect('norva-edge-functions'); env=dict(v.split('=',1) for v in edge['Config']['Env'])
    token=env['NORVA_BACKFILL_TOKEN']; assert token and '\n' not in token
    envfile=ROOT/'worker.env'; envfile.write_text('NORVA_BACKFILL_TOKEN='+token+'\n');envfile.chmod(0o600)
    image=json.loads(subprocess.check_output(['docker','image','inspect','node:22-alpine'],text=True))[0]['Id']
    args=['docker','run','-d','--name','norva-language-campaign','--restart','unless-stopped','--init',
      '--user',str(os.getuid())+':'+str(os.getgid()),'--network','norva_default','--read-only','--cap-drop','ALL',
      '--security-opt','no-new-privileges:true','--pids-limit','64','--memory','512m','--cpus','0.5',
      '--stop-timeout','200','--log-opt','max-size=5m','--log-opt','max-file=3','--env-file',str(envfile),
      '--mount','type=bind,src='+str(ROOT/'language-campaign.mjs')+',dst=/worker/main.mjs,readonly',
      '--mount','type=bind,src='+str(ROOT/'campaign.json')+',dst=/config/campaign.json,readonly',
      '--mount','type=bind,src='+str(ROOT/'state')+',dst=/state',
      '--health-cmd',"node -e \"const s=JSON.parse(require('fs').readFileSync('/state/health.json'));process.exit(Date.now()-s.at<90000?0:1)\"",
      '--health-interval','30s','--health-timeout','5s','--health-start-period','30s',image,'node','/worker/main.mjs']
    subprocess.run(args,check=True,capture_output=True,text=True)
    print(json.dumps({'started':True,'image':image,'workerSha256':hashlib.sha256((ROOT/'language-campaign.mjs').read_bytes()).hexdigest()}))
def observe():
    manifest=json.loads((ROOT/'manifest.json').read_text()); report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
      'startedAt':manifest['startedAt'],'initialVariants':len(manifest['variants']),'sources':[]}
    for s in manifest['sources']:
        user=str(uuid.UUID(s['userId'])); sid=str(uuid.UUID(s['id']))
        cohort=[r for r in manifest['variants'] if r['sourceId']==sid]
        ids=json.dumps([str(uuid.UUID(r['variantId'])) for r in cohort])
        q=f"""with cohort as materialized(select value::uuid id from jsonb_array_elements_text('{ids}'::jsonb)),
u as materialized(select * from public.cloud_catalog_unidentified_audio_variants('{user}','movie','{sid}')),
v as materialized(select v.id,v.codec_profile from public.cloud_catalog_visible_title_variants v join cohort c on c.id=v.id where v.user_id='{user}' and v.source_id='{sid}'),
ij as materialized(select i.* from public.catalog_vod_language_intake i join cohort c on c.id=i.variant_id where i.user_id='{user}' and i.source_id='{sid}'),
j as materialized(select j.* from public.catalog_file_audio_validation_jobs j join cohort c on c.id=j.variant_id where j.requested_by='{user}' and j.source_id='{sid}')
select jsonb_build_object('currentUnknownVariants',(select count(*) from u),'currentUnknownCards',(select count(distinct title_id) from u),
'cohortStillUnknown',(select count(*) from u join cohort c on c.id=u.variant_id),
'cohortVisible',(select count(*) from v),'cohortWithProfile',(select count(*) from v where codec_profile is not null and codec_profile<>'{{}}'::jsonb),
'cohortWithAudioTracks',(select count(*) from v where jsonb_typeof(codec_profile->'audioTracks')='array' and codec_profile->'audioTracks'<>'[]'::jsonb),
'intakeStates',(select coalesce(jsonb_object_agg(state,n),'{{}}'::jsonb) from (select state,count(*) n from ij group by state) x),
'intakeCodes',(select coalesce(jsonb_object_agg(code,n),'{{}}'::jsonb) from (select coalesce(last_code,'none') code,count(*) n from ij group by last_code) x),
'strictStates',(select coalesce(jsonb_object_agg(state,n),'{{}}'::jsonb) from (select state,count(*) n from j group by state) x),
'strictCompletedWindows',(select coalesce(sum(strict_lid_window_position),0) from j),
'lastStrictProviderProgress',(select max(last_provider_progress_at) from j),
'recentIntake',(select count(*) from ij where updated_at>='{manifest['startedAt']}'::timestamptz));"""
        values=sql(q)[0]; values['source']=s['label'];values['initialUnknownVariants']=len(cohort)
        values['cohortNowIdentified']=values['cohortVisible']-values['cohortStillUnknown']
        values['cohortChangedOrRemoved']=len(cohort)-values['cohortVisible']
        report['sources'].append(values)
    owner=str(uuid.UUID(manifest['sources'][0]['userId']))
    report['currentGlobal']=sql(f"with u as materialized(select * from public.cloud_catalog_unidentified_audio_variants('{owner}','movie',null)) select jsonb_build_object('unknownVariants',count(*),'unknownCards',count(distinct title_id)) from u;")[0]
    statefile=ROOT/'state/state.json'
    if statefile.exists():
        state=json.loads(statefile.read_text())
        report['dispatcher']=[{'source':s['label'],**{k:v for k,v in state['sources'].get(s['id'],{}).items() if k in ['calls','totals','lastResult','lastAt','failures']}} for s in manifest['sources']]
    status=subprocess.run(['docker','inspect','norva-language-campaign'],capture_output=True,text=True)
    if status.returncode==0:
        st=json.loads(status.stdout)[0]['State'];report['container']={'running':st['Running'],'health':st.get('Health',{}).get('Status'),'restartCount':json.loads(status.stdout)[0]['RestartCount']}
    save(ROOT/'latest.safe.json',report); print(json.dumps(report,ensure_ascii=False))
if __name__=='__main__':
    try:
        mode=sys.argv[1]; assert mode in ['prepare','start','observe']; globals()[mode]()
    except Exception as error:
        print(json.dumps({'error':type(error).__name__,'message':str(error)[:180] if isinstance(error,(RuntimeError,AssertionError)) else 'Operation failed; inspect locally without exposing secrets'})); sys.exit(1)
