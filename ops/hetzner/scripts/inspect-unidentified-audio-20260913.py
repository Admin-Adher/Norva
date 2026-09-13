"""Read-only cost check of the proposed predicate on the largest catalogue.
No file metadata, identity, credentials, audio or provider request is emitted.
"""
import importlib.util,json,pathlib,sys,time
ROOT=pathlib.Path('/home/adrien/.norva/unidentified-audio-proof-20260913')
spec=importlib.util.spec_from_file_location('unknown_cost',ROOT/'prove-unidentified-audio-20260913.py')
proof=importlib.util.module_from_spec(spec);spec.loader.exec_module(proof)
sql=proof.fleet.sql
user=sql('SELECT user_id::text FROM public.cloud_titles GROUP BY user_id ORDER BY count(*) DESC LIMIT 1;')
predicate=(ROOT/proof.MIGRATION).read_text().split('as $f$')[1].split('$f$;')[0]
for kind in ('movie','series'):
 query=predicate.replace('p_user_id',proof.fleet.literal(user)+'::uuid').replace('p_item_type',proof.fleet.literal(kind)).replace('p_source_id','null::uuid')
 if 'plan' in sys.argv:
  result=sql('EXPLAIN (FORMAT JSON) SELECT count(distinct title_id) FROM ('+query+') unidentified;')
  (ROOT/(kind+'-plan.private.json')).write_text(result)
  def walk(p,depth=0):
   print(json.dumps({'type':kind,'depth':depth,'node':p['Node Type'],'rows':p.get('Plan Rows'),'cost':p.get('Total Cost'),'relation':p.get('Relation Name'),'index':p.get('Index Name')}))
   for child in p.get('Plans',[]):walk(child,depth+1)
  walk(json.loads(result)[0]['Plan']);continue
 start=time.monotonic();result=sql('SELECT jsonb_build_object(\'titles\',count(distinct title_id),\'versions\',count(*)) FROM ('+query+') unidentified;')
 print(json.dumps({'type':kind,'counts':json.loads(result),'elapsedMs':round((time.monotonic()-start)*1000),'readOnly':True}),flush=True)
