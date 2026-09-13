"""Dormant SQL + two-replica Edge rollout, with retained-container recovery.

No approval is inserted and no flag, acquisition limit or Gateway module changes.
"""
import fcntl
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import time

ROOT=pathlib.Path('/home/adrien/.norva/scoped-capture-jobs-release-20260913')
PARENT=ROOT.parent/'passive-qos-diagnostics-20260913'
PROOF=ROOT.parent/'scoped-capture-jobs-proof-20260913/proof.private.json'
MIGRATION='20260913053000_scoped_language_capture_jobs.sql'
SERVICES=('norva-edge-functions','norva-edge-functions-2')
FILE='norva-playback/index.ts'
OLD='    const { data: captureEnabled, error: captureFlagError } = await db.rpc("catalog_language_capture_pipeline_enabled");'
NEW='    const { data: captureEnabled, error: captureFlagError } = await db.rpc(\n      "catalog_language_capture_pipeline_enabled_for_job", { p_job_id: jobId },\n    );'


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    result=importlib.util.module_from_spec(spec);sys.modules[name]=result;spec.loader.exec_module(result)
    return result


parent=load('scoped_capture_release_parent',PARENT/'deploy-passive-qos-diagnostics-20260913.py')
fleet=load('scoped_capture_release_fleet',ROOT.parent/'automatic-vod-language-fleet-20260911/deploy-automatic-vod-language-fleet-20260911.py')
fleet.ROOT=ROOT
gw,require,core=parent.gw,parent.require,parent.op
edge,lib=fleet.edge,fleet.lib


def save(name,value):gw.private_write(ROOT/name,value)
def saved(name):return json.loads(gw.safe_file(ROOT,name).read_text())
def sha(data):return hashlib.sha256(data).hexdigest()


def updated_edge_source(live,baseline,candidate):
    normalize=lambda value:value.replace(b'\r\n',b'\n')
    live,baseline,candidate=map(normalize,(live,baseline,candidate))
    require(live==baseline,'edge_baseline_drift')
    require(live.count(OLD.encode())==1 and live.replace(OLD.encode(),NEW.encode())==candidate,'edge_patch_scope')
    return candidate


def functions():
    return json.loads(fleet.sql("SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid))) "
        "FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN "
        "('catalog_language_capture_pipeline_enabled_for_job','authorize_catalog_language_capture_job','revoke_catalog_language_capture_job','checkpoint_catalog_file_audio_capture');"))


def invariant(plan):
    require(core.base.r.controls()==plan['controls'],'flags_or_quarantine_changed')
    current=gw.inspect();require(current['Id']==plan['gateway']['Id'],'gateway_changed')
    gw.assert_clone(plan['gateway'],current,plan['gateway']['Config']['Image'])
    require(parent.source_snapshot()==plan['gatewaySources'] and gw.binary_snapshot()==plan['binaries'],'gateway_source_or_binary_changed')
    gw.assert_runtime(gw.health(),plan['runtime'])
    for name,identity in plan['otherContainers'].items():require(gw.inspect(name)['Id']==identity,'unrelated_container_changed')
    for name,digest in plan['protectedFiles'].items():require(sha(pathlib.Path(name).read_bytes())==digest,'protected_evidence_changed')


def verify_edge(plan,name,candidate):
    current=gw.inspect(name);original=plan['containers'][name]
    expected_id=saved(name+'-receipt.private.json')['candidateContainer'] if candidate else original['Id']
    require(current['Id']==expected_id,'edge_container_not_owned')
    expected=lib.edge_expected(original,ROOT/'functions') if candidate else original
    gw.assert_clone(expected,current,original['Config']['Image'])
    require(current['Image']==original['Image'] and current['State']['Running'] and not current['State']['OOMKilled'],'edge_image_or_state_changed')
    require(edge.hashes(lib.edge_root(current))==plan['after' if candidate else 'before'],'edge_tree_changed')
    lib.edge_health(current)


def verify_sql():
    proof=json.loads(PROOF.read_text())
    by_signature=lambda rows:{row['signature']:row['definition'] for row in rows}
    require(by_signature(functions())==by_signature(proof['after']),'sql_definition_mismatch')
    security=json.loads(fleet.sql("SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),'acl',p.proacl)) "
        "FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN "
        "('norva_credential_require_service_role','catalog_language_capture_pipeline_enabled','checkpoint_catalog_file_audio_capture');"))
    security_map=lambda rows:{row['signature']:(row['owner'],row['acl']) for row in rows}
    require(security_map(security)==security_map(proof['before']),'existing_sql_security_changed')
    require(fleet.sql("SELECT count(*) FROM public.catalog_language_capture_job_pilots;")=='0','unexpected_pilot_approval')
    result=fleet.sql("SELECT NOT has_table_privilege('authenticated','public.catalog_language_capture_job_pilots','SELECT') "
        "AND NOT has_table_privilege('service_role','public.catalog_language_capture_job_pilots','INSERT') "
        "AND (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.catalog_language_capture_job_pilots'::regclass) "
        "AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' "
        "AND p.proname IN ('catalog_language_capture_pipeline_enabled_for_job','authorize_catalog_language_capture_job','revoke_catalog_language_capture_job') "
        "AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE')));")
    require(result=='t','sql_privileges_mismatch')


def stage():
    commit=sys.argv[2];require(re.fullmatch('[a-f0-9]{40}',commit) is not None,'commit_invalid')
    require(ROOT.is_dir() and not ROOT.is_symlink() and not (ROOT/'plan.private.json').exists(),'stage_not_fresh')
    parent.verify()
    prior=ROOT.parent/'passive-qos-canary-r2-20260913'
    closed=json.loads((prior/'closed.private.json').read_text())
    require(closed.get('restored') is True and closed.get('cronsRestored') is True,'passive_canary_not_closed')
    proof=json.loads(PROOF.read_text());migration=gw.safe_file(ROOT,MIGRATION).read_text().replace('\r\n','\n')
    require(proof.get('passed') is True and len(proof.get('checks',[]))>=38 and proof.get('network')=='none'
        and proof.get('productionWrites')==0 and proof.get('providerRequests')==0 and proof.get('fixtureRemoved') is True
        and proof.get('migrationSha256')==sha(migration.encode()),'sql_proof_mismatch')
    originals={name:gw.inspect(name) for name in SERVICES};roots=[lib.edge_root(c) for c in originals.values()]
    require(len(set(roots))==1,'replica_trees_differ');old=roots[0]
    payloads={}
    for kind in ('base','candidate'):
        with tarfile.open(ROOT/(kind+'.tar')) as archive:
            entries=[e for e in archive.getmembers() if not e.isdir()]
            require(len(entries)==1 and entries[0].name=='supabase/functions/'+FILE
                and entries[0].isfile() and 0<entries[0].size<4000000,'archive_scope')
            payloads[kind]=archive.extractfile(entries[0]).read()
    changed=updated_edge_source((old/FILE).read_bytes(),payloads['base'],payloads['candidate'])
    before=edge.hashes(old);target=ROOT/'functions';shutil.copytree(old,target)
    (target/FILE).write_bytes(changed);(target/FILE).chmod(0o644)
    after=edge.hashes(target)
    require(set(after)==set(before) and all(after[name]==digest for name,digest in before.items() if name!=FILE),'unrelated_edge_patch')
    parent_plan=parent.op.saved('plan.private.json')
    paths=[pathlib.Path(name) for name in parent_plan['protectedFiles']]
    paths += [PROOF,pathlib.Path(__file__),ROOT/'base.tar',ROOT/'candidate.tar',ROOT/MIGRATION]
    paths += [prior/name for name in ('plan.private.json','receipt.private.json','closed.private.json')]
    plan={'commit':commit,'stagedAt':time.time(),'containers':originals,'before':before,'after':after,
        'gateway':gw.inspect(),'gatewaySources':parent.source_snapshot(),'binaries':gw.binary_snapshot(),
        'runtime':gw.runtime_snapshot(gw.health()),'controls':core.base.r.controls(),'crons':core.base.r.crons(),
        'otherContainers':{name:identity for name,identity in parent_plan['otherContainers'].items() if name not in SERVICES},
        'protectedFiles':{str(name):sha(name.read_bytes()) for name in paths},'sqlBefore':proof['before']}
    save('plan.private.json',plan);invariant(plan)
    for name in SERVICES:verify_edge(plan,name,False)
    print(json.dumps({'staged':True,'commit':commit,'edgeFiles':1,'approvals':0,'productionUnchanged':True}))


def apply_sql(plan):
    require(not (ROOT/'sql.private.json').exists(),'sql_already_recorded')
    statements=[]
    for item in plan['sqlBefore']:
        statements.append("IF md5(pg_get_functiondef("+fleet.literal(item['signature'])+"::regprocedure))<>"+
            fleet.literal(hashlib.md5(item['definition'].encode()).hexdigest())+" THEN RAISE EXCEPTION 'SQL baseline drift'; END IF;")
    migration=gw.safe_file(ROOT,MIGRATION).read_text().replace('\r\n','\n')
    needle="set local statement_timeout = '30s';"
    require(migration.count(needle)==1,'sql_guard_anchor_missing')
    migration=migration.replace(needle,needle+'\nDO $guard$ BEGIN '+''.join(statements)+' END $guard$;',1)
    save('sql-attempt.private.json',{'at':time.time(),'migrationSha256':sha(migration.encode())})
    fleet.sql(migration,write=True);verify_sql()
    save('sql.private.json',{'at':time.time(),'applied':True,'approvals':0,'flagsUnchanged':True})


def idle():core.base.previous.d.idle()


def activate(plan,name):
    invariant(plan);verify_sql();verify_edge(plan,name,False);idle();require(process_alive('watch'),'guard_missing')
    other=SERVICES[1] if name==SERVICES[0] else SERVICES[0];lib.edge_health(gw.inspect(other))
    original=plan['containers'][name];expected=lib.edge_expected(original,ROOT/'functions')
    created=gw.docker_api('POST','/containers/create?name='+name+'-scoped-capture-candidate-20260913',gw.clone_payload(expected,original['Config']['Image']))
    receipt={'candidateContainer':created['Id'],'candidateName':name+'-scoped-capture-candidate-20260913'}
    save(name+'-receipt.private.json',receipt);gw.assert_clone(expected,gw.inspect(created['Id']),original['Config']['Image'])
    idle();require(process_alive('watch'),'guard_missing')
    gw.run(['docker','stop','--time','20',original['Id']]);gw.run(['docker','rename',original['Id'],name+'-scoped-capture-retained-20260913'])
    gw.run(['docker','rename',created['Id'],name]);gw.run(['docker','start',created['Id']])
    for attempt in range(25):
        try:verify_edge(plan,name,True);return
        except Exception:
            if attempt==24:raise
            time.sleep(1)


def process_alive(phase):
    marker=ROOT/(phase+'.private.json')
    if not marker.exists():return False
    row=saved(marker.name);proc=pathlib.Path('/proc')/str(row['pid'])
    try:
        args=(proc/'cmdline').read_bytes().split(b'\0')
        return str(pathlib.Path(__file__).resolve()).encode() in args and phase.encode() in args \
            and (proc/'stat').read_text().rsplit(')',1)[1].split()[19]==row['startTicks']
    except (OSError,IndexError):return False


def spawn(phase):
    with (ROOT/(phase+'.log')).open('x') as out:
        child=subprocess.Popen([sys.executable,str(pathlib.Path(__file__).resolve()),phase],stdin=subprocess.DEVNULL,
            stdout=out,stderr=subprocess.DEVNULL,start_new_session=True)
    ticks=(pathlib.Path('/proc')/str(child.pid)/'stat').read_text().rsplit(')',1)[1].split()[19]
    save(phase+'.private.json',{'pid':child.pid,'startTicks':ticks})


def launch():
    plan=saved('plan.private.json');invariant(plan)
    require(time.time()-plan['stagedAt']<300 and core.base.r.crons()==plan['crons'],'stage_expired_or_cron_drift')
    save('begin.private.json',{'at':time.time(),'deadline':time.time()+600})
    spawn('watch');require(process_alive('watch'),'guard_missing');spawn('run')
    print(json.dumps({'launched':True,'guardAlive':True,'approvals':0}))


def run():
    plan=saved('plan.private.json')
    try:
        invariant(plan);core.base.r.alter_crons(plan,True)
        while time.time()<saved('begin.private.json')['deadline']-120:
            try:idle();break
            except Exception:time.sleep(5)
        else:raise RuntimeError('work_drain_deadline')
        require(process_alive('watch'),'guard_missing');invariant(plan);apply_sql(plan)
        for name in SERVICES:activate(plan,name)
        invariant(plan);verify_sql()
        for name in SERVICES:verify_edge(plan,name,True)
        core.base.r.alter_crons(plan,False);require(core.base.r.crons()==plan['crons'],'cron_restore_missing')
        save('closed.private.json',{'at':time.time(),'updated':True,'sqlApplied':True,'cronsRestored':True,'approvals':0})
    except Exception:
        save('failed.private.json',{'at':time.time(),'requiresRecovery':True});raise


def recover(plan):
    require(not process_alive('run'),'runner_still_active');idle();invariant(plan)
    for name in reversed(SERVICES):
        path=ROOT/(name+'-receipt.private.json')
        if not path.exists():continue
        receipt=saved(path.name)
        inventory=gw.docker_api('GET','/containers/json?all=true')
        owners=[row['Id'] for row in inventory if '/'+name in row.get('Names',[])]
        require(len(owners)<=1 and (not owners or owners[0] in (plan['containers'][name]['Id'],receipt['candidateContainer'])),'foreign_edge_alias')
        if not owners or owners[0]!=plan['containers'][name]['Id']:
            edge.restore(name,plan,receipt)
        verify_edge(plan,name,False)
    core.base.r.alter_crons(plan,False);require(core.base.r.crons()==plan['crons'],'cron_restore_missing')
    applied=False
    if (ROOT/'sql-attempt.private.json').exists():
        # A lost response is not proof of rollback. Inspect the atomic DDL.
        exists=fleet.sql("SELECT to_regclass('public.catalog_language_capture_job_pilots') IS NOT NULL;")=='t'
        if exists:verify_sql();applied=True
    save('closed.private.json',{'at':time.time(),'updated':False,'sqlApplied':applied,
        'cronsRestored':True,'approvals':0,'oldEdgeRestored':True})


def watch():
    begin=saved('begin.private.json');plan=saved('plan.private.json')
    while time.time()<begin['deadline']+7200:
        if (ROOT/'closed.private.json').exists():return
        failed=(ROOT/'failed.private.json').exists() or time.time()>begin['deadline'] or (time.time()>begin['at']+15 and not process_alive('run'))
        if failed:
            try:
                with (ROOT/'recovery.lock').open('a') as lock:
                    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);recover(plan);return
            except Exception:pass
        time.sleep(5)
    save('requires-review.private.json',{'at':time.time(),'code':'recovery_waiting_for_owned_idle_state'})


def status():
    plan=saved('plan.private.json');invariant(plan)
    closed=saved('closed.private.json') if (ROOT/'closed.private.json').exists() else None
    if closed and closed.get('updated'):
        verify_sql()
        for name in SERVICES:verify_edge(plan,name,True)
    print(json.dumps({'at':time.time(),'commit':plan['commit'],'closed':closed,'runnerAlive':process_alive('run'),
        'guardAlive':process_alive('watch'),'cronsRestored':core.base.r.crons()==plan['crons'],
        'gatewayUnchanged':True,'flagsAndQuarantinesUnchanged':True}))


if __name__=='__main__':
    os.umask(0o077)
    try:
        phase=sys.argv[1];require(phase in ('stage','launch','run','watch','status'),'invalid_phase');globals()[phase]()
    except Exception as error:
        code=str(error);print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code)
            else 'scoped_capture_release_failed'}));raise SystemExit(1)
