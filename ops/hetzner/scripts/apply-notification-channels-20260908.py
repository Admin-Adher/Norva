"""Apply reviewed channel policy without activating any audience or delivery."""
import hashlib,json,pathlib,subprocess,sys
ROOT=pathlib.Path(__file__).resolve().parent
mode=sys.argv[1];assert mode in ('preview','apply')
def sql(q):
 r=subprocess.run(['docker','exec','-i','norva-db','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],input=q,text=True,capture_output=True,timeout=60)
 if r.returncode:raise RuntimeError(r.stderr[-2500:])
 return r.stdout.strip()
names=['admin_update_behavioral_lifecycle_runtime','norva_behavioral_delivery_eligible',
 'norva_marketing_email_contact_allowed','norva_authorize_behavioral_push',
 'norva_behavioral_frequency_allowed_at','admin_marketing_system_automations']
predicate="n.nspname='public' and p.proname in ("+','.join("'"+name+"'" for name in names)+')'
acl="select jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,p.proowner,p.proacl,p.prosecdef,p.proconfig) order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where "+predicate
config="select jsonb_agg(jsonb_build_array(journey_key,step_key,channel,enabled,is_marketing) order by journey_key,step_key) from public.behavioral_lifecycle_steps"
before_acl=sql(acl);before_config=sql(config)
migration=(ROOT/'notifications-proof/20260908200759_complete_notification_channels.sql').read_text()
proof=json.loads((ROOT/'notification-sql-proof.json').read_text())
digest=hashlib.sha256(migration.replace('\r\n','\n').encode()).hexdigest()
assert proof['passed'] and proof['migration_sha256']==digest
if mode=='apply':
 assert not (ROOT/'database-applied.json').exists(),'Already applied; inspect instead of retrying'
 (ROOT/'functions-before.sql').write_text(sql("select pg_get_functiondef(p.oid)||';' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where "+predicate))
quote=lambda s:"'"+s.replace("'","''")+"'::jsonb"
checks="do $$begin if ("+acl+")<>"+quote(before_acl)+" then raise exception 'Existing function security changed';end if; if ("+config+")<>"+quote(before_config)+" then raise exception 'Migration changed active channels';end if;end$$;"
checks+="do $$begin if has_function_privilege('authenticated','public.norva_marketing_contact_allowed(uuid,uuid)','EXECUTE') then raise exception 'Private contact policy exposed';end if;end$$;notify pgrst,'reload schema';"
sql("begin;lock table public.behavioral_lifecycle_steps in share row exclusive mode;"+migration+checks+('commit;' if mode=='apply' else 'rollback;'))
result={'mode':mode,'passed':True,'migration_sha256':digest,'existing_acl_preserved':True,'channels_unchanged':True,'no_customer_messages_sent':True}
(ROOT/('database-applied.json' if mode=='apply' else 'database-preview.json')).write_text(json.dumps(result,indent=2))
print(json.dumps(result))
