"""Offline synthetic SQL proof; production schema reads only, no provider I/O."""
import hashlib,importlib.util,json,os,pathlib,subprocess,sys,time
ROOT=pathlib.Path('/home/adrien/.norva/unidentified-audio-proof-20260913')
NAME='norva-unidentified-audio-proof-20260913'
MIGRATION='20260913140000_catalog_unidentified_audio_filter.sql'
PARENT=ROOT.parent/'automatic-vod-language-fleet-20260911/deploy-automatic-vod-language-fleet-20260911.py'
spec=importlib.util.spec_from_file_location('unknown_proof_fleet',PARENT)
fleet=importlib.util.module_from_spec(spec);spec.loader.exec_module(fleet);fleet.ROOT=ROOT
FUNCTIONS=('norva_canonical_language_code','cloud_catalog_effective_audio_languages',
 'cloud_catalog_provider_title_ids_by_source_languages','cloud_catalog_visible_title_ids_by_source_languages','cloud_catalog_visible_title_language_page')
def run(args,**kwargs):
 r=subprocess.run(args,capture_output=True,timeout=45,**kwargs)
 if r.returncode:raise RuntimeError('proof_command_failed')
 return r.stdout
def main():
 assert ROOT.is_dir() and not ROOT.is_symlink() and not (ROOT/'proof-v2.private.json').exists()
 assert NAME not in run(['docker','ps','-a','--format','{{.Names}}']).decode().splitlines()
 names=','.join(fleet.literal(n) for n in FUNCTIONS)
 defs=json.loads(fleet.sql("SELECT jsonb_agg(jsonb_build_object('name',p.proname,'signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid)) ORDER BY p.proname,p.pronargs desc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ("+names+");"))
 assert len(defs)==6
 ordered=[row['definition']+';' for name in FUNCTIONS for row in defs if row['name']==name]
 migration=(ROOT/MIGRATION).read_bytes().replace(b'\r\n',b'\n')
 fixture=(ROOT/'fixture.sql').read_text().replace('-- DEFINITIONS','\n'.join(ordered)).replace('-- MIGRATION',migration.decode())
 image=json.loads(run(['docker','inspect','norva-db']))[0]['Image'];created=None
 try:
  created=run(['docker','run','-d','--name',NAME,'--label','norva.purpose='+NAME,'--network','none','--memory','512m','--cpus','0.5','--pids-limit','128',
   '--tmpfs','/tmp:rw,nosuid,size=384m,mode=1777','--user','postgres','--entrypoint','/bin/sh',image,'-c',
   "initdb -D /tmp/proof -U postgres --auth=trust >/tmp/init.log 2>&1 && exec postgres -D /tmp/proof -k /tmp -c listen_addresses='' -c shared_buffers=32MB"]).decode().strip()
  for attempt in range(25):
   if subprocess.run(['docker','exec',created,'pg_isready','-h','/tmp','-U','postgres'],capture_output=True).returncode==0:break
   if attempt==24:raise RuntimeError('proof_start_timeout')
   time.sleep(1)
  result=subprocess.run(['docker','exec','-i',created,'psql','-h','/tmp','-U','postgres','-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1'],input=fixture.encode(),capture_output=True,timeout=45)
  (ROOT/'sql-test.log').write_bytes(result.stdout+result.stderr)
  if result.returncode:raise RuntimeError('sql_fixture_failed')
  proof=json.loads(result.stdout.decode().strip().splitlines()[-1]);assert proof['passed'] and len(proof['checks'])>=21
  proof.update(before=defs,image=image,network='none',productionWrites=0,providerRequests=0,migrationSha256=hashlib.sha256(migration).hexdigest())
 finally:
  if created:
   item=json.loads(run(['docker','inspect',created]))[0]
   assert item['Id']==created and item['Config']['Labels']['norva.purpose']==NAME and item['HostConfig']['NetworkMode']=='none' and not item['HostConfig'].get('Binds')
   run(['docker','stop','--time','20',created]);run(['docker','rm',created])
 proof['fixtureRemoved']=True
 with (ROOT/'proof-v2.private.json').open('x') as output:json.dump(proof,output)
 print(json.dumps({k:v for k,v in proof.items() if k not in ('definitions','before')}))
if __name__=='__main__':
 os.umask(0o077);main()
