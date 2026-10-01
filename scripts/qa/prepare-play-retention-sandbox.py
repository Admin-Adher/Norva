"""Run over SSH stdin on the Norva operator host. Creates ONLY disposable QA resources.

No host port, production database writes, mail worker, push worker or cron runner.
The generated server-side config expires after four hours and is never printed.
"""
import base64, datetime, hashlib, hmac, json, os, pathlib, secrets, subprocess, time, uuid

DB = 'norva-play-retention-qa-db'
REST = 'norva-play-retention-qa-rest'
NETWORK = 'norva-play-retention-qa'
DATABASE = 'norva_play_retention_qa'
SOURCE = 'norva-play-retention-proof-20260925'
OWNER = '6055c1e8-9f4b-48a2-b9c4-2a08cdfcb05f'
STAGE = pathlib.Path('/home/adrien/.norva/play-retention-qa-20261001')
LABEL = 'google-play-retention-isolated-qa'

def run(args, data=None, check=True):
    p = subprocess.run(args, input=data, text=True, capture_output=True, timeout=90)
    if check and p.returncode:
        raise RuntimeError(p.stderr[-1800:])
    return p

def sql(statement):
    assert DB != 'norva-db' and DATABASE == 'norva_play_retention_qa'
    return run(['docker','exec','-i',DB,'psql','-X','-q','-At','-v','ON_ERROR_STOP=1',
                '-U','postgres','-d',DATABASE], statement).stdout.strip()

assert os.geteuid() == 1000
existing = run(['docker','ps','-a','--format','{{.Names}}']).stdout.splitlines()
assert DB not in existing and REST not in existing, 'QA resources already exist; inspect before replacing'
assert NETWORK not in run(['docker','network','ls','--format','{{.Name}}']).stdout.splitlines()
assert SOURCE in existing
source_info = json.loads(run(['docker','inspect',SOURCE]).stdout)[0]
assert source_info['HostConfig']['NetworkMode'] == 'none'
schema = run(['docker','exec',SOURCE,'pg_dump','-U','postgres','-d','play_retention_20261001',
              '--schema-only','--no-owner','--no-privileges']).stdout
roles = run(['docker','exec',SOURCE,'psql','-U','postgres','-d','postgres','-Atc',
             "select rolname from pg_roles where rolname not like 'pg_%' and rolname<>'postgres'"]).stdout.splitlines()
assert all(all(c.isalnum() or c=='_' for c in role) for role in roles)
created = []
try:
    STAGE.mkdir(parents=True, exist_ok=True)
    os.chmod(STAGE,0o700)
    run(['docker','network','create','--internal','--label','norva.purpose='+LABEL,NETWORK])
    created.append(('network',NETWORK))
    password, secret = secrets.token_urlsafe(32), secrets.token_urlsafe(48)
    (STAGE/'db.env').write_text('POSTGRES_PASSWORD='+password+'\nPOSTGRES_DB='+DATABASE+'\n')
    os.chmod(STAGE/'db.env',0o600)
    run(['docker','run','-d','--name',DB,'--network',NETWORK,'--label','norva.purpose='+LABEL,
         '--memory','768m','--cpus','1','--pids-limit','160','--tmpfs','/var/lib/postgresql/data:rw,nosuid,size=512m',
         '--env-file',str(STAGE/'db.env'),'postgres:15-alpine'])
    created.append(('container',DB))
    for attempt in range(30):
        if run(['docker','exec',DB,'psql','-h','127.0.0.1','-U','postgres','-d',DATABASE,'-Atc','select 1'],check=False).returncode==0: break
        time.sleep(1)
    else: raise RuntimeError('QA database did not start')
    sql('\n'.join('create role "'+r+'";' for r in roles))
    sql(schema)
    started = datetime.datetime.now(datetime.timezone.utc)
    end = started + datetime.timedelta(hours=4)
    config = {'mode':'isolated-google-play-retention','userId':OWNER,'runId':str(uuid.uuid4()),
              'url':'http://'+REST+':3000','createdAt':started.isoformat(),'expiresAt':end.isoformat()}
    marker = {'environment':'SANDBOX','productionWrites':False,**{k:config[k] for k in ['runId','userId','expiresAt']}}
    # The only environment change is in this empty isolated clone. Real incoming
    # receipt environment fields remain SANDBOX; no receipt is relabelled.
    sql("""do $qa$ declare f regprocedure; d text; begin
      foreach f in array array['public.norva_play_retention_eligible(uuid,uuid)'::regprocedure,
        'public.norva_play_retention_purchase()'::regprocedure] loop
        select pg_get_functiondef(f) into d;
        if position('PRODUCTION' in d)=0 then raise exception 'Environment guard missing'; end if;
        execute replace(d,'''PRODUCTION''','''SANDBOX''');
      end loop; end $qa$;""")
    sql("""set session_replication_role=replica;
      insert into auth.users(id,email,email_confirmed_at,created_at)
      values ('%s','sandbox-retention@example.test',now(),now());
      insert into public.cloud_profiles(id,display_name,locale) values ('%s','QA Google Play','fr');
      insert into public.cloud_play_retention_policy(singleton,enabled,communications_enabled) values(true,true,false)
        on conflict(singleton) do update set enabled=true,communications_enabled=false;
      set session_replication_role=origin;
      alter role service_role bypassrls;
      grant usage on schema public to service_role;
      grant all on all tables in schema public to service_role;
      grant all on all sequences in schema public to service_role;
      grant execute on all functions in schema public to service_role;
      create role qa_authenticator login password '%s';
      grant service_role to qa_authenticator;
      create function public.norva_play_qa_identity() returns jsonb language plpgsql as $fn$
      begin
        if current_database()<>'norva_play_retention_qa' then raise exception 'Not isolated'; end if;
        return '%s'::jsonb;
      end $fn$;
      revoke all on function public.norva_play_qa_identity() from public;
      grant execute on function public.norva_play_qa_identity() to service_role;
      alter table public.cloud_entitlement_events add constraint sandbox_qa_only check(
        user_id='%s'::uuid and provider='revenuecat' and (payload->>'environment') is not distinct from 'SANDBOX');
      """ % (OWNER,OWNER,password,json.dumps(marker),OWNER))
    enc=lambda x:base64.urlsafe_b64encode(json.dumps(x,separators=(',',':')).encode()).decode().rstrip('=')
    token=enc({'alg':'HS256','typ':'JWT'})+'.'+enc({'role':'service_role','exp':int(end.timestamp())})
    token+='.'+base64.urlsafe_b64encode(hmac.new(secret.encode(),token.encode(),hashlib.sha256).digest()).decode().rstrip('=')
    config['key']=token
    (STAGE/'rest.env').write_text('PGRST_DB_URI=postgresql://qa_authenticator:'+password+'@'+DB+':5432/'+DATABASE+
        '\nPGRST_DB_SCHEMAS=public\nPGRST_JWT_SECRET='+secret+'\nPGRST_SERVER_PORT=3000\n')
    os.chmod(STAGE/'rest.env',0o600)
    run(['docker','run','-d','--name',REST,'--network',NETWORK,'--label','norva.purpose='+LABEL,
         '--memory','192m','--cpus','0.5','--pids-limit','96','--env-file',str(STAGE/'rest.env'),'postgrest/postgrest:v14.12'])
    created.append(('container',REST))
    (STAGE/'play-retention-qa.config.json').write_text(json.dumps(config))
    os.chmod(STAGE/'play-retention-qa.config.json',0o600)
    (STAGE/'schema.sha256').write_text(hashlib.sha256(schema.encode()).hexdigest())
    print(json.dumps({'ready':True,'database':DATABASE,'networkInternal':True,'hostPorts':False,
      'productionWrites':False,'communications':False,'expiresAt':config['expiresAt'],'runId':config['runId']}))
except Exception:
    for kind,name in reversed(created):
        if kind=='container':
            info=json.loads(run(['docker','inspect',name]).stdout)[0]
            assert info['Config']['Labels']['norva.purpose']==LABEL
            run(['docker','rm','-f',name])
        else: run(['docker','network','rm',name])
    raise
