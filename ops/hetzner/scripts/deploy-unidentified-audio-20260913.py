"""Scoped filter rollout using the established two-replica drain/recovery guard.

Only read-only catalogue functions and two Edge files change. No audio jobs,
provider access, evidence rewrites or Gateway restart. Old containers retained.
"""
import importlib.util,json,os,pathlib,re,shutil,sys,tarfile,time
ROOT=pathlib.Path('/home/adrien/.norva/unidentified-audio-release-20260913')
PROOF=ROOT.parent/'unidentified-audio-proof-20260913/proof-v2.private.json'
MIGRATION='20260913140000_catalog_unidentified_audio_filter.sql'
FILES=('norva-catalog/index.ts','_shared/selection-provider-languages.mjs')
TARGETS=('cloud_catalog_unidentified_audio_variants','cloud_catalog_unidentified_audio_count','cloud_catalog_visible_title_ids_by_source_languages')
SUFFIX='unidentified-audio-20260913'
spec=importlib.util.spec_from_file_location('unknown_release_base',ROOT.parent/'scoped-capture-jobs-release-20260913/deploy-scoped-capture-jobs-20260913.py')
base=importlib.util.module_from_spec(spec);sys.modules[spec.name]=base;spec.loader.exec_module(base)
base.ROOT,base.__file__,base.MIGRATION=ROOT,__file__,MIGRATION
base.fleet.ROOT=ROOT
gw,require,save,saved=base.gw,base.require,base.save,base.saved
sql=base.fleet.sql
def definitions(names):
 return json.loads(sql("SELECT coalesce(jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid))),'[]'::jsonb) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ("+','.join(base.fleet.literal(n) for n in names)+");"))
def mapped(rows):return {r['signature']:r['definition'] for r in rows}
def verify_sql():
 require(mapped(definitions(TARGETS))==mapped(json.loads(PROOF.read_text())['definitions']),'sql_definition_mismatch')
 names=','.join(base.fleet.literal(n) for n in TARGETS)
 require(sql("SELECT NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ("+names+") AND (prosecdef OR provolatile<>'s' OR has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') OR NOT has_function_privilege('service_role',p.oid,'EXECUTE')));")=='t','sql_acl_mismatch')
def payload(kind):
 with tarfile.open(ROOT/(kind+'.tar')) as archive:
  entries=[e for e in archive.getmembers() if not e.isdir()]
  require(len(entries)==2 and {e.name for e in entries}=={'supabase/functions/'+p for p in FILES} and all(e.isfile() and 0<e.size<4000000 for e in entries),'archive_scope')
  return {e.name.removeprefix('supabase/functions/'):archive.extractfile(e).read().replace(b'\r\n',b'\n') for e in entries}
def stage():
 commit=sys.argv[2];require(re.fullmatch('[a-f0-9]{40}',commit) is not None,'commit_invalid')
 require(ROOT.is_dir() and not ROOT.is_symlink() and not (ROOT/'plan.private.json').exists(),'stage_not_fresh')
 proof=json.loads(PROOF.read_text());migration=(ROOT/MIGRATION).read_bytes().replace(b'\r\n',b'\n')
 require(proof.get('passed') and len(proof.get('checks',[]))>=21 and proof.get('network')=='none' and proof.get('fixtureRemoved') and proof.get('productionWrites')==0 and proof.get('migrationSha256')==base.sha(migration),'proof_mismatch')
 names=tuple(row['signature'].split('(')[0] for row in proof['before'])
 require(mapped(definitions(names))==mapped(proof['before']),'sql_baseline_drift')
 originals={name:gw.inspect(name) for name in base.SERVICES};roots=[base.lib.edge_root(c) for c in originals.values()]
 require(len(set(roots))==1,'replica_roots_differ')
 for c in originals.values():base.lib.edge_health(c)
 old=roots[0];before=base.edge.hashes(old);baseline,candidate=payload('base'),payload('candidate')
 for path in FILES:
  require((old/path).read_bytes().replace(b'\r\n',b'\n')==baseline[path] and baseline[path]!=candidate[path],'edge_baseline_drift')
 target=ROOT/'functions';shutil.copytree(old,target)
 for path in FILES:(target/path).write_bytes(candidate[path]);(target/path).chmod(0o644)
 after=base.edge.hashes(target)
 require(set(before)==set(after) and all(after[k]==v for k,v in before.items() if k not in FILES),'unrelated_edge_change')
 protected=[PROOF,ROOT/MIGRATION,ROOT/'base.tar',ROOT/'candidate.tar',pathlib.Path(__file__)]
 plan={'commit':commit,'stagedAt':time.time(),'containers':originals,'before':before,'after':after,'sqlBefore':proof['before'],
  'gateway':gw.inspect(),'gatewaySources':base.parent.source_snapshot(),'binaries':gw.binary_snapshot(),
  'runtime':gw.runtime_snapshot(gw.health()),'controls':base.core.base.r.controls(),'crons':base.core.base.r.crons(),
  'otherContainers':{'norva-selection-audio-worker':gw.inspect('norva-selection-audio-worker')['Id']},
  'protectedFiles':{str(p):base.sha(p.read_bytes()) for p in protected}}
 save('plan.private.json',plan);base.invariant(plan)
 for name in base.SERVICES:base.verify_edge(plan,name,False)
 print(json.dumps({'staged':True,'commit':commit,'edgeFiles':2,'productionUnchanged':True}))
def activate(plan,name):
 base.invariant(plan);verify_sql();base.verify_edge(plan,name,False);base.idle();require(base.process_alive('watch'),'guard_missing')
 other=base.SERVICES[1] if name==base.SERVICES[0] else base.SERVICES[0];base.lib.edge_health(gw.inspect(other))
 original=plan['containers'][name];expected=base.lib.edge_expected(original,ROOT/'functions')
 created=gw.docker_api('POST','/containers/create?name='+name+'-'+SUFFIX+'-candidate',gw.clone_payload(expected,original['Config']['Image']))
 save(name+'-receipt.private.json',{'candidateContainer':created['Id'],'candidateName':name+'-'+SUFFIX+'-candidate'})
 gw.assert_clone(expected,gw.inspect(created['Id']),original['Config']['Image'])
 base.idle();require(base.process_alive('watch'),'guard_missing')
 gw.run(['docker','stop','--time','20',original['Id']]);gw.run(['docker','rename',original['Id'],name+'-'+SUFFIX+'-retained'])
 gw.run(['docker','rename',created['Id'],name]);gw.run(['docker','start',created['Id']])
 for attempt in range(25):
  try:base.verify_edge(plan,name,True);return
  except Exception:
   if attempt==24:raise
   time.sleep(1)
def recover(plan):
 require(not base.process_alive('run'),'runner_still_active');base.idle();base.invariant(plan)
 for name in reversed(base.SERVICES):
  if not (ROOT/(name+'-receipt.private.json')).exists():continue
  receipt=saved(name+'-receipt.private.json');inventory=gw.docker_api('GET','/containers/json?all=true')
  owners=[row['Id'] for row in inventory if '/'+name in row.get('Names',[])]
  require(len(owners)<=1 and (not owners or owners[0] in (plan['containers'][name]['Id'],receipt['candidateContainer'])),'foreign_edge_alias')
  if not owners or owners[0]!=plan['containers'][name]['Id']:base.edge.restore(name,plan,receipt)
  base.verify_edge(plan,name,False)
 installed=len(definitions(TARGETS))==3
 if installed:verify_sql()
 base.core.base.r.alter_crons(plan,False);require(base.core.base.r.crons()==plan['crons'],'cron_restore_missing')
 save('closed.private.json',{'at':time.time(),'updated':False,'sqlApplied':installed,'cronsRestored':True,'oldEdgeRestored':True})
base.stage,base.verify_sql,base.activate,base.recover=stage,verify_sql,activate,recover
if __name__=='__main__':
 os.umask(0o077)
 try:
  phase=sys.argv[1];require(phase in ('stage','launch','run','watch','status'),'invalid_phase');getattr(base,phase)()
 except Exception as error:
  code=str(error);print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code) else 'unidentified_release_failed'}));sys.exit(1)
