"""Apply the reviewed notice schema with delivery off; activate separately."""
import hashlib,json,pathlib,subprocess,sys,time
ROOT=pathlib.Path(__file__).resolve().parent
assert ROOT==pathlib.Path('/home/adrien/.norva/customer-notices-20260909')
mode=sys.argv[1];assert mode in ('preview','apply','activate','verify')
def sql(q):
 r=subprocess.run(['docker','exec','-i','norva-db','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],input=q,text=True,capture_output=True,timeout=60)
 if r.returncode:raise RuntimeError(r.stderr[-2500:])
 return r.stdout.strip()
def write(name,value):
 (ROOT/name).write_text(json.dumps(value,indent=2));print(json.dumps(value))
migration=(ROOT/'notice-proof/20260909070224_complete_customer_service_notices.sql').read_text().replace('\r\n','\n')
sha=hashlib.sha256(migration.encode()).hexdigest()
unchanged="""select jsonb_build_object(
 'runtime',(select to_jsonb(r) from public.behavioral_lifecycle_runtime r),
 'journeys',(select jsonb_agg(to_jsonb(j) order by journey_key) from public.behavioral_lifecycle_journeys j),
 'steps',(select jsonb_agg(to_jsonb(s) order by journey_key,step_key,channel) from public.behavioral_lifecycle_steps s),
 'provider',(select to_jsonb(r) from public.cloud_provider_access_rollout r),
 'prices',(select jsonb_agg(to_jsonb(p) order by plan,period) from public.billing_prices p),
 'flags',(select jsonb_agg(to_jsonb(f) order by key) from public.admin_feature_flags f));"""
checks="""do $$begin
 if has_schema_privilege('authenticated','norva_notices','USAGE')
 or has_function_privilege('authenticated','public.norva_observe_customer_incident(text,boolean)','EXECUTE')
 or has_function_privilege('anon','public.norva_observe_customer_incident(text,boolean)','EXECUTE')
 or has_function_privilege('service_role','norva_notices.password_verification_attempt(jsonb)','EXECUTE')
 then raise exception 'notice ACL exposure';end if;
 if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='norva_notices' and c.relkind='r' and not c.relrowsecurity)
 then raise exception 'notice RLS missing';end if;
 if (select count(*) from pg_trigger where tgname in ('norva_suspicious_login_notice_trg','norva_customer_price_notice_trg') and tgenabled='O')<>2
 then raise exception 'notice trigger missing';end if;
end $$;"""
if mode in ('preview','apply'):
 proof=json.loads((ROOT/'notice-proof/proof-summary.json').read_text())
 assert proof['passed'] and proof['migration_sha256']==sha and time.time()-proof['timestamp']<7200
 before=sql(unchanged)
 baseline=sql("select jsonb_build_object('owner',proowner,'acl',proacl,'security',prosecdef,'config',proconfig) from pg_proc where oid='public.admin_marketing_system_automations()'::regprocedure;")
 if mode=='apply':
  assert not(ROOT/'database-applied.json').exists()
  (ROOT/'inventory-before.sql').write_text(sql("select pg_get_functiondef('public.admin_marketing_system_automations()'::regprocedure)||';';"))
 sql('begin;'+migration+checks+"do $$begin if exists(select 1 from norva_notices.runtime where security_enabled or incidents_enabled or prices_enabled) then raise exception 'unexpected activation';end if;end$$;"+('commit;' if mode=='apply' else 'rollback;'))
 assert sql(unchanged)==before,'Unrelated runtime changed'
 assert sql("select jsonb_build_object('owner',proowner,'acl',proacl,'security',prosecdef,'config',proconfig) from pg_proc where oid='public.admin_marketing_system_automations()'::regprocedure;")==baseline
 write('database-applied.json' if mode=='apply' else 'database-preview.json',{'passed':True,'mode':mode,'migration_sha256':sha,'unrelated_runtime_preserved':True,'existing_admin_acl_preserved':True,'delivery_activated':False})
elif mode=='activate':
 assert json.loads((ROOT/'database-applied.json').read_text())['migration_sha256']==sha
 assert not(ROOT/'activation.json').exists()
 assert all(json.loads((ROOT/(s+'-deployed.json')).read_text())['healthy'] for s in ['functions','functions2','auth'])
 before=sql(unchanged)
 sql('begin;'+checks+"update norva_notices.runtime set security_enabled=true,incidents_enabled=true,prices_enabled=true,activated_at=clock_timestamp() where singleton and not security_enabled and not incidents_enabled and not prices_enabled;commit;")
 assert sql(unchanged)==before
 state=json.loads(sql('select to_jsonb(r) from norva_notices.runtime r;'))
 assert all(state[k] for k in ['security_enabled','incidents_enabled','prices_enabled'])
 write('activation.json',{'passed':True,'mode':mode,'runtime':state,'unrelated_runtime_preserved':True,'historical_events_replayed':False})
else:
 sql('begin read only;'+checks+'rollback;')
 result=json.loads(sql("""select jsonb_build_object('runtime',(select to_jsonb(r) from norva_notices.runtime r),
 'open_incidents',(select count(*) from norva_notices.incidents where resolved_at is null),
 'password_observations',(select count(*) from norva_notices.password_attempts),
 'price_events',(select count(*) from norva_notices.price_events),
 'notice_states',(select jsonb_agg(x) from (select flow,state,count(*) from public.cloud_branded_email_outbox where flow in ('security_suspicious_login','service_incident','service_recovered','billing_price_change') group by flow,state)x));"""))
 write('live-verification.json',result)
