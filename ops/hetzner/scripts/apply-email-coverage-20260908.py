"""Preview or apply notification coverage with exact-anchor and ACL guards."""
import hashlib,json,pathlib,subprocess,sys
ROOT=pathlib.Path(__file__).resolve().parent
mode=sys.argv[1];assert mode in ('preview','apply')
def sql(q):
 p=subprocess.run(['docker','exec','-i','norva-db','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],input=q,text=True,capture_output=True,timeout=60)
 if p.returncode:raise RuntimeError(p.stderr[-2500:])
 return p.stdout.strip()
names=['admin_update_behavioral_lifecycle_runtime','admin_update_behavioral_lifecycle_journey',
 'admin_behavioral_lifecycle_overview','norva_behavioral_journey_relevant','norva_behavioral_delivery_eligible',
 'norva_enqueue_lifecycle_email','norva_claim_behavioral_deliveries']
predicate="n.nspname='public' and p.proname in ("+','.join("'"+n+"'" for n in names)+')'
acl_query="select jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,p.proowner,p.proacl,p.prosecdef,p.proconfig) order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where "+predicate+';'
old_acl=sql(acl_query)
migration=(ROOT/'coverage-proof/20260908183015_complete_email_coverage.sql').read_text()
if mode=='apply':
 assert not (ROOT/'database-applied.json').exists(),'Already applied; inspect before retry'
 (ROOT/'functions-before.sql').write_text(sql("select pg_get_functiondef(p.oid)||';' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where "+predicate+';'))
checks="""
do $$begin
 if has_function_privilege('anon','public.norva_enqueue_account_security_notice(uuid,text,text)','EXECUTE')
 or has_function_privilege('authenticated','public.norva_pending_renewal_email_quotes(integer)','EXECUTE') then raise exception 'service ACL exposed';end if;
 if (select count(*) from pg_trigger where tgname in ('norva_mfa_factor_notice_trg','norva_identity_notice_trg','norva_phone_notice_trg') and tgenabled='O')<>3 then raise exception 'security triggers missing';end if;
 if exists(select 1 from public.behavioral_lifecycle_steps where step_key in ('day_one_email','day_three_email','new_content_week_email') and journey_key in ('catalog_ready_no_first_play','continue_watching') and enabled) then raise exception 'migration unexpectedly activated new audience';end if;
end$$;
notify pgrst,'reload schema';
"""
result=sql('begin;'+migration+checks+('commit;' if mode=='apply' else 'rollback;'))
assert sql(acl_query)==old_acl,'Existing ACL or security mode changed'
proof={'mode':mode,'passed':True,'migration_sha256':hashlib.sha256(migration.replace('\r\n','\n').encode()).hexdigest(),'existing_acl_preserved':True,'automatic_customer_activation':False}
(ROOT/('database-applied.json' if mode=='apply' else 'database-preview.json')).write_text(json.dumps(proof,indent=2))
print(json.dumps(proof))
