"""Exercise activation transactions only in the existing networkless schema clone.

No production SQL, provider I/O, deployment, table reset or source data copy.
The proof toggles only the clone's synthetic metadata flag and restores its bit.
"""
import hashlib, importlib.util, json, os, pathlib, re, subprocess, sys, types

ROOT=pathlib.Path('/home/adrien/.norva/post-vod-owned-language-activation-proof-20260914')
NAME='norva-unknown-first-language-proof-20260914'
PURPOSE='unknown-first-language-proof-20260914'

def require(ok,code):
    if not ok:raise RuntimeError(code)

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module);return module

def execute(query,expect_error=False):
    result=subprocess.run(['docker','exec','-i',NAME,'psql','-h','/tmp','-U','postgres','-d','postgres',
        '-X','-qAt','-v','ON_ERROR_STOP=1'],input=query,text=True,capture_output=True,timeout=45)
    if expect_error:
        require(result.returncode!=0,'expected_guard_did_not_reject');return
    if result.returncode:
        (ROOT/'proof-error.private.txt').write_text(result.stderr)
        raise RuntimeError('synthetic_query_failed')
    return result.stdout.strip()

def main():
    os.umask(0o077);sys.dont_write_bytecode=True
    require(ROOT.is_dir() and not ROOT.is_symlink() and ROOT.stat().st_mode&0o077==0,'private_root_required')
    require(len(sys.argv)==2 and re.fullmatch('[a-f0-9]{64}',sys.argv[1]),'operator_sha_required')
    path=ROOT/'activate-owned-language-metadata-20260914.py'
    require(path.is_file() and not path.is_symlink() and hashlib.sha256(path.read_bytes()).hexdigest()==sys.argv[1],
        'tested_operator_binding')
    raw=subprocess.run(['docker','inspect',NAME],capture_output=True,text=True,check=True,timeout=20)
    state=json.loads(raw.stdout)[0]
    require(state['Name']=='/'+NAME and state['HostConfig']['NetworkMode']=='none'
        and state['Config']['Labels']['norva.purpose']==PURPOSE and state['State']['Running'],'synthetic_container_only')
    op=load('synthetic_activation',path)
    # These two pinned files contain definitions only at import time. Their SQL
    # query methods are never invoked; all execution above uses NAME, not norva-db.
    adapter_path=ROOT.parent/'unknown-first-language-edge-20260914/deploy-unknown-first-language-edge.py'
    sql_path=ROOT.parent/'unknown-first-language-pipeline-20260914/deploy-unknown-first-language-pipeline.py'
    for p,d in ((adapter_path,'0b6c11ae7b8b32832450045040800e5df183c62ead6d9d565718a9de137eaef9'),
        (sql_path,'be293c9b1ccdf4cf06a0e49e308eff45eea39a898383031e67403d3080865a6d')):
        require(p.is_file() and not p.is_symlink() and hashlib.sha256(p.read_bytes()).hexdigest()==d,'schema_signature_source_drift')
    adapter=load('synthetic_signatures',adapter_path);signatures=load('synthetic_sql_signatures',sql_path)
    query=op.schema_query(adapter,signatures)
    sql=types.SimpleNamespace(query=execute)
    row=op.flag_row(sql);flags=json.loads(execute('select jsonb_object_agg(key,enabled) from public.admin_feature_flags;'))
    require(row['enabled'] is False and flags[op.FLAG] is False,'synthetic_flag_must_start_off')
    proof={'flag':row,'flags':flags,'schemaSha256':op.fingerprint(sql,query),'marker':'owned-language:'+'a'*32}
    checks=0
    execute(op.transaction(proof,query,False));require(op.flag_row(sql)==row,'rehearsal_rollback_changed_row');checks+=1
    for changed in ({**proof,'schemaSha256':'0'*64},{**proof,'flag':{**row,'xmin':'0'}},
        {**proof,'flags':{**flags,'synthetic_unrelated_drift':True}}):
        execute(op.transaction(changed,query,True),expect_error=True)
        require(op.flag_row(sql)==row,'rejected_transaction_mutated_flag');checks+=1
    enabled=json.loads(execute(op.transaction(proof,query,True)))
    require(op.activation_owned(enabled,proof) and op.flag_row(sql)==enabled,'enable_commit_not_verified');checks+=1
    require(json.loads(execute('select jsonb_object_agg(key,enabled) from public.admin_feature_flags;'))=={**flags,op.FLAG:True},
        'other_flag_changed');checks+=1
    execute(op.transaction(proof,query,True),expect_error=True)
    require(op.flag_row(sql)==enabled,'repeated_enable_changed_row');checks+=1
    execute(op.transaction(proof,query,True,rollback_row={**enabled,'xmin':'0'}),expect_error=True)
    require(op.flag_row(sql)==enabled,'stale_rollback_changed_row');checks+=1
    disabled=json.loads(execute(op.transaction(proof,query,True,rollback_row=enabled)))
    require(disabled['enabled'] is False and disabled['updatedBy']==proof['marker']+':rollback'
        and op.flag_row(sql)==disabled,'owned_rollback_failed');checks+=1
    require(json.loads(execute('select jsonb_object_agg(key,enabled) from public.admin_feature_flags;'))==flags,'flags_not_restored');checks+=1
    require(op.fingerprint(sql,query)==proof['schemaSha256'],'schema_changed');checks+=1
    result={'passed':True,'checks':checks,'operatorSha256':sys.argv[1],'network':'none','productionWrites':0,
        'providerRequests':0,'syntheticFlagRestored':True}
    with (ROOT/('proof-'+sys.argv[1]+'.private.json')).open('x') as file:json.dump(result,file,indent=2)
    print(json.dumps(result))

if __name__=='__main__':
    try:main()
    except Exception as error:
        code=str(error)
        print(json.dumps({'passed':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code) else type(error).__name__}))
        sys.exit(1)
