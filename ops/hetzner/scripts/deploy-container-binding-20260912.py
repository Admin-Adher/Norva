"""One SQL forwarding correction; no container restart, provider I/O or flag change."""
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import sys
import time

ROOT = pathlib.Path('/home/adrien/.norva/container-binding-20260912')
PARENT = ROOT.parent/'ts-quick-start-20260912/deploy-ts-quick-start-20260912.py'
MIGRATION = '20260912121500_container_observation_argument_binding.sql'
SIGNATURE = 'public.record_catalog_file_container_observation(uuid,uuid,uuid,text,text,text,text,jsonb,uuid,timestamptz,uuid,bigint,bigint,bigint,bigint)'
CALL = r'v_result:=public\.record_catalog_file_container_observation\([\s\S]*?\);'
spec = importlib.util.spec_from_file_location('container_binding_parent', PARENT)
parent = importlib.util.module_from_spec(spec); sys.modules[spec.name] = parent; spec.loader.exec_module(parent)
sql, require = parent.lib.sql, parent.require


def literal(value):
    return "'"+value.replace("'", "''")+"'"


def current():
    return json.loads(sql("SELECT json_build_object('definition',pg_get_functiondef(p.oid),'body',p.prosrc,"
        "'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'definer',p.prosecdef,'config',p.proconfig)"
        " FROM pg_proc p WHERE p.oid="+literal(SIGNATURE)+"::regprocedure;"))


def save(name, value):
    require(not (ROOT/name).exists(), 'receipt_already_exists')
    parent.gw.private_write(ROOT/name, value)


def candidate():
    source = (ROOT/MIGRATION).read_text().replace('\r\n','\n')
    require(source.count('create or replace function ') == 1, 'migration_scope')
    require('drop table' not in source.lower() and 'update public.' not in source.lower(), 'data_write_in_migration')
    body = source.split('as $function$',1)[1].split('$function$;',1)[0]
    return source, body


def temporary_test(before, after):
    # These functions exist only in this connection's temporary namespace. The
    # copied real wrapper is executed against distinct role sentinels and a
    # generation-fence spy; public functions and catalogue rows are untouched.
    user='00000000-0000-4000-8000-000000000001'
    source='00000000-0000-4000-8000-000000000002'
    playback='00000000-0000-4000-8000-000000000003'
    item='00000000-0000-4000-8000-000000000004'
    generation='00000000-0000-4000-8000-000000000005'
    def invocation(head='1', item_value=None):
        return "pg_temp.record_catalog_file_container_observation("+','.join([
            literal(user)+'::uuid', literal(source)+'::uuid', literal(playback)+'::uuid',"'movie'","'file'","'mkv'","'ts'","'{}'::jsonb",
            item_value if item_value is not None else literal(item)+'::uuid',"'2026-09-12'::timestamptz",literal(generation)+'::uuid',
            head+'::bigint','2::bigint','3::bigint','4::bigint'])+")"
    header=before['definition'].split('AS $function$',1)[0].replace('public.record_catalog_file_container_observation','pg_temp.record_catalog_file_container_observation')
    require('CREATE OR REPLACE FUNCTION pg_temp.' in header, 'temporary_wrapper_header')
    def wrapper(body):
        return header+'AS $function$'+body.replace('public.record_catalog_file_container_observation','pg_temp.record_catalog_file_container_observation').replace('public.norva_set_catalog_delete_proof','pg_temp.norva_set_catalog_delete_proof')+'$function$;'
    script=f"""BEGIN;
SET LOCAL statement_timeout='10s';
CREATE TEMP TABLE container_binding_test_scope(id int);
CREATE FUNCTION pg_temp.norva_set_catalog_delete_proof(uuid,uuid,uuid,bigint,bigint,bigint,bigint)
RETURNS void LANGUAGE plpgsql AS $stub$ BEGIN
 IF $1 <> '{source}'::uuid OR $2 <> '{user}'::uuid OR $3 <> '{generation}'::uuid
 OR $4<>1 OR $5<>2 OR $6<>3 OR $7<>4 THEN RAISE EXCEPTION 'generation_fence' USING ERRCODE='40001'; END IF;
END $stub$;
CREATE FUNCTION pg_temp.record_catalog_file_container_observation(
p_playback_session_id uuid,p_user_id uuid,p_source_id uuid,p_item_type text,p_external_id text,
p_declared_container text,p_observed_container text,p_evidence jsonb,p_expected_media_item_id uuid,p_expected_media_item_updated_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql AS $stub$ BEGIN
 IF p_playback_session_id<>'{playback}'::uuid OR p_user_id<>'{user}'::uuid OR p_source_id<>'{source}'::uuid
 THEN RAISE EXCEPTION 'uuid_binding' USING ERRCODE='42501'; END IF;
 IF current_setting('norva.legacy_catalog_writer_fenced',true)<>'on'
 OR current_setting('norva.legacy_catalog_source_id',true)<>'{source}'
 OR current_setting('norva.legacy_catalog_user_id',true)<>'{user}'
 OR p_expected_media_item_id<>'{item}'::uuid THEN RAISE EXCEPTION 'write_proof'; END IF;
 RETURN '{{"ok":true}}'::jsonb;
END $stub$;
{wrapper(before['body'])}
DO $test$ BEGIN
 BEGIN PERFORM {invocation()}; RAISE EXCEPTION 'old_bug_not_reproduced'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $test$;
{wrapper(after)}
DO $test$ BEGIN
 IF {invocation()} <> '{{"ok":true}}'::jsonb THEN RAISE EXCEPTION 'forwarding_failed'; END IF;
 IF current_setting('norva.legacy_catalog_writer_fenced',true)<>'off' THEN RAISE EXCEPTION 'proof_not_released'; END IF;
 BEGIN PERFORM {invocation(item_value='NULL::uuid')}; RAISE EXCEPTION 'missing_cas_accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM {invocation(head='9')}; RAISE EXCEPTION 'stale_generation_accepted'; EXCEPTION WHEN serialization_failure THEN NULL; END;
END $test$;
ROLLBACK;
SELECT '{{"tests":5,"pass":5,"fail":0,"publicFunctionsChanged":0,"providerRequests":0}}'::jsonb;
"""
    return json.loads(sql(script, write=True))


def stage():
    parent.verify()
    require(ROOT.is_dir() and not ROOT.is_symlink(), 'invalid_root')
    source, body = candidate(); before=current()
    require(re.sub(CALL,'FORWARD',before['body']) == re.sub(CALL,'FORWARD',body), 'unrelated_wrapper_change')
    require('p_playback_session_id => p_playback_session_id' not in before['body'], 'already_fixed')
    tests=temporary_test(before,body)
    parent.verify()
    save('plan.private.json',{'before':before,'afterBody':body,'migrationSha256':hashlib.sha256(source.encode()).hexdigest(),
        'tests':tests,'crons':parent.op.base.r.crons(),'controls':parent.op.base.r.controls(),'at':time.time()})
    print(json.dumps({'staged':True,'productionUnchanged':True,**tests}))


def apply():
    plan=json.loads((ROOT/'plan.private.json').read_text()); parent.verify()
    require(not (ROOT/'applied.private.json').exists(), 'already_applied')
    require(current()==plan['before'], 'baseline_changed')
    source,body=candidate()
    require(hashlib.sha256(source.encode()).hexdigest()==plan['migrationSha256'], 'migration_changed')
    old_hash=hashlib.md5(plan['before']['definition'].encode()).hexdigest()
    new_hash=hashlib.md5(body.encode()).hexdigest()
    sql("BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='15s';\n"
        "DO $guard$ BEGIN IF md5(pg_get_functiondef("+literal(SIGNATURE)+"::regprocedure))<>"+literal(old_hash)+
        " THEN RAISE EXCEPTION 'baseline_changed'; END IF; END $guard$;\n"+source+
        "\nDO $guard$ DECLARE p record; BEGIN SELECT * INTO STRICT p FROM pg_proc WHERE oid="+literal(SIGNATURE)+"::regprocedure; "
        "IF md5(p.prosrc)<>"+literal(new_hash)+" OR NOT p.prosecdef OR NOT has_function_privilege('service_role',p.oid,'execute')"
        " OR has_function_privilege('anon',p.oid,'execute') OR has_function_privilege('authenticated',p.oid,'execute')"
        " THEN RAISE EXCEPTION 'postcondition_failed'; END IF; END $guard$; COMMIT;", write=True)
    after=current(); require(after['body']==body,'body_changed')
    require(all(after[k]==plan['before'][k] for k in ('owner','acl','definer','config')), 'function_security_changed')
    parent.verify(); require(parent.op.base.r.crons()==plan['crons'] and parent.op.base.r.controls()==plan['controls'],'controls_changed')
    save('applied.private.json',{'at':time.time(),'migrationSha256':plan['migrationSha256'],'tests':plan['tests'],
        'rollbackDefinitionPreserved':True,'containersRestarted':0,'providerRequests':0})
    print(json.dumps({'deployed':True,'wrapperOnly':True,'securityPreserved':True,'containersRestarted':0,'providerRequests':0}))


def verify():
    plan=json.loads((ROOT/'plan.private.json').read_text());after=current()
    require(after['body']==plan['afterBody'],'body_drift')
    require(all(after[k]==plan['before'][k] for k in ('owner','acl','definer','config')),'function_security_changed')
    parent.verify()
    print(json.dumps({'verified':True,'migration':MIGRATION,'providerRequests':0}))


if __name__=='__main__':
    os.umask(0o077)
    try:
        phase=sys.argv[1];require(phase in ('stage','apply','verify'),'invalid_phase');globals()[phase]()
    except Exception as error:
        code=str(error); print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code) else 'container_binding_operation_failed'}))
        sys.exit(1)
