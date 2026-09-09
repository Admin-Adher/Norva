"""Exercise real GoTrue v2.189.0 and notice SQL on an isolated Docker network.

No live user, password, database, SMTP or Postal is used. No published ports.
Input files are in a sibling notice-proof directory; output contains test HTML.
"""
import base64, hashlib, hmac, json, pathlib, secrets, subprocess, time, urllib.request, urllib.error

ROOT = pathlib.Path(__file__).resolve().parent / 'notice-proof'
NETWORK = 'norva-notices-proof-20260909'
DB = NETWORK + '-db'
AUTH = NETWORK + '-auth'
LABEL = 'customer-notices-proof-20260909'

def run(args, data=None, check=True):
    p = subprocess.run(args, input=data, text=True, capture_output=True, timeout=60)
    if check and p.returncode:
        raise RuntimeError('command failed: ' + args[0] + '\n' + p.stderr[-1500:])
    return p

def sql(query):
    return run(['docker','exec','-i',DB,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','/tmp','-U','postgres','-d','postgres'], query).stdout

def inspect(name):
    return json.loads(run(['docker','inspect',name]).stdout)[0]

def wait_db():
    for _ in range(25):
        if run(['docker','exec',DB,'pg_isready','-h','/tmp','-U','postgres'],check=False).returncode == 0:
            return
        time.sleep(1)
    raise RuntimeError('fixture database unavailable')

secret = secrets.token_hex(32)
password = secrets.token_urlsafe(30)
auth_env = {
    'GOTRUE_API_HOST':'0.0.0.0','GOTRUE_API_PORT':'9999',
    'API_EXTERNAL_URL':'http://example.test','GOTRUE_SITE_URL':'http://example.test',
    'GOTRUE_DB_DRIVER':'postgres','GOTRUE_DB_DATABASE_URL':f'postgres://supabase_auth_admin@{DB}:5432/postgres?sslmode=disable',
    'GOTRUE_JWT_SECRET':secret,'GOTRUE_JWT_EXP':'3600','GOTRUE_JWT_AUD':'authenticated',
    'GOTRUE_JWT_ADMIN_ROLES':'service_role','GOTRUE_JWT_DEFAULT_GROUP_NAME':'authenticated',
    'GOTRUE_EXTERNAL_EMAIL_ENABLED':'true','GOTRUE_MAILER_AUTOCONFIRM':'true',
    'GOTRUE_RATE_LIMIT_TOKEN_REFRESH':'1000','GOTRUE_RATE_LIMIT_VERIFY':'1000',
    'GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED':'false',
}

def start_auth():
    args=['docker','run','-d','--name',AUTH,'--label','norva.purpose='+LABEL,'--network',NETWORK,
          '--memory','256m','--cpus','1','--pids-limit','128']
    for k,v in auth_env.items(): args += ['-e',k+'='+v]
    run(args+['supabase/gotrue:v2.189.0'])
    address='http://'+inspect(AUTH)['NetworkSettings']['Networks'][NETWORK]['IPAddress']+':9999'
    for _ in range(30):
        if not inspect(AUTH)['State']['Running']: break
        try:
            urllib.request.urlopen(address+'/health',timeout=2).read()
            return address
        except Exception: time.sleep(1)
    # Fixture contains generated credentials only; avoid echoing the environment.
    logs=run(['docker','logs','--tail','8',AUTH],check=False)
    raise RuntimeError('fixture Auth unavailable: '+(logs.stderr+logs.stdout)[-1600:].replace(secret,'[redacted]').replace(password,'[redacted]'))

def jwt():
    def enc(x):return base64.urlsafe_b64encode(json.dumps(x,separators=(',',':')).encode()).rstrip(b'=')
    content=enc({'alg':'HS256','typ':'JWT'})+b'.'+enc({'role':'service_role','aud':'authenticated','exp':int(time.time())+600})
    return (content+b'.'+base64.urlsafe_b64encode(hmac.new(secret.encode(),content,hashlib.sha256).digest()).rstrip(b'=')).decode()

def post(address,path,payload,admin=False):
    headers={'Content-Type':'application/json'}
    if admin:headers['Authorization']='Bearer '+jwt()
    request=urllib.request.Request(address+path,data=json.dumps(payload).encode(),headers=headers)
    try:
        response=urllib.request.urlopen(request,timeout=10)
        return response.status,json.load(response)
    except urllib.error.HTTPError as error:
        return error.code,json.load(error)

created=[]
try:
    assert not run(['docker','network','inspect',NETWORK],check=False).returncode == 0, 'fixture network exists'
    run(['docker','network','create','--internal','--label','norva.purpose='+LABEL,NETWORK]);created.append('network')
    run(['docker','run','-d','--name',DB,'--label','norva.purpose='+LABEL,'--network',NETWORK,
         '--memory','768m','--cpus','1','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,size=512m,mode=1777',
         '--user','postgres','--entrypoint','/bin/sh','supabase/postgres:17.6.1.136','-c',
         "initdb -D /tmp/proof -U postgres --auth=trust >/tmp/init.log 2>&1 && echo 'host all all 0.0.0.0/0 trust' >> /tmp/proof/pg_hba.conf && exec postgres -D /tmp/proof -k /tmp -c listen_addresses='*' -c shared_buffers=32MB"])
    created.append(DB);wait_db()
    sql('create role supabase_auth_admin login; create role anon; create role authenticated; create role service_role; create schema auth authorization supabase_auth_admin; alter role supabase_auth_admin set search_path=auth; grant all on database postgres to supabase_auth_admin;')
    created.append(AUTH);address=start_auth()
    sql((ROOT/'customer-notices.bootstrap.sql').read_text())
    for file in ['20260626131645_norva_branded_email_helpers.sql','20260721235400_branded_email_delivery_outbox.sql','20260908140448_branded_email_images.sql']:
        contents=(ROOT/file).read_text().replace('\r\n','\n')
        names={'20260626131645_norva_branded_email_helpers.sql':['norva_html_escape'],
               '20260721235400_branded_email_delivery_outbox.sql':['norva_html_fragment_to_text','norva_branded_email_text','norva_enqueue_branded_email'],
               '20260908140448_branded_email_images.sql':['norva_branded_email_html']}[file]
        for name in names:
            import re
            match=re.search(r'create (?:or replace )?function public\.'+name+r'\(',contents,re.I)
            assert match, name
            body=contents[match.start():]
            tag=re.search(r'\bas\s+(\$[a-zA-Z_]*\$)',body,re.I)
            assert tag,name
            end=body.index(tag.group(1),tag.end())+len(tag.group(1))+1
            sql(body[:end])
    sql((ROOT/'20260909070224_complete_customer_service_notices.sql').read_text())
    result=sql((ROOT/'customer-notices.integration.sql').read_text())
    assert 'CUSTOMER_NOTICES_SQL_PROOF_OK' in result
    print('CUSTOMER_NOTICES_SQL_PROOF_OK',flush=True)
    for line in result.splitlines():
        if line.startswith('{"rendered_notices"'):
            for row in json.loads(line)['rendered_notices']:
                (ROOT/(row['flow']+'.html')).write_text(row['html'])
                (ROOT/(row['flow']+'.txt')).write_text(row['body'])
    sql('update norva_notices.runtime set security_enabled=true;')
    run(['docker','rm','-f',AUTH]);created.remove(AUTH)
    auth_env.update({'GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED':'true',
                     'GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_URI':'pg-functions://postgres/norva_notices/password_verification_attempt'})
    created.append(AUTH);address=start_auth()
    status,user=post(address,'/admin/users',{'email':'auth-notice-proof@example.test','password':password,'email_confirm':True},True)
    assert status==200, 'fixture create-user status '+str(status)
    for _ in range(5):
        status,_=post(address,'/token?grant_type=password',{'email':user['email'],'password':'incorrect-fixture-password'})
        assert status==400,'failed password response changed: '+str(status)
    assert sql("select count(*) from public.cloud_branded_email_outbox").strip()=='0','failed-only message emitted'
    status,_=post(address,'/token?grant_type=password',{'email':user['email'],'password':password})
    assert status==200,'valid password rejected: '+str(status)
    count=sql("select count(*) from public.cloud_branded_email_outbox where flow='security_suspicious_login'").strip()
    assert count=='1','real GoTrue confirmation failed to enqueue: '+count
    for _ in range(5):post(address,'/token?grant_type=password',{'email':user['email'],'password':'incorrect-fixture-password'})
    status,_=post(address,'/token?grant_type=password',{'email':user['email'],'password':password})
    assert status==200 and sql('select count(*) from public.cloud_branded_email_outbox').strip()=='1','cooldown/login regression'
    print(json.dumps({'gotrue':'v2.189.0','real_failed_attempts':10,'real_successful_logins':2,'security_notices':1,'cooldown':True,'network_internal':True,'ports_published':False}),flush=True)
    print('CUSTOMER_NOTICES_AUTH_PROOF_OK',flush=True)
    (ROOT/'proof-summary.json').write_text(json.dumps({'passed':True,'gotrue':'v2.189.0','timestamp':time.time(),
        'migration_sha256':hashlib.sha256((ROOT/'20260909070224_complete_customer_service_notices.sql').read_bytes().replace(b'\r\n',b'\n')).hexdigest(),
        'sql_sha256':hashlib.sha256((ROOT/'customer-notices.integration.sql').read_bytes().replace(b'\r\n',b'\n')).hexdigest()}))
finally:
    for name in reversed(created):
        if name=='network':
            network=json.loads(run(['docker','network','inspect',NETWORK]).stdout)[0]
            assert network['Internal'] and network['Labels']['norva.purpose']==LABEL
            run(['docker','network','rm',NETWORK])
        else:
            obj=inspect(name)
            assert obj['Config']['Labels']['norva.purpose']==LABEL and NETWORK in obj['NetworkSettings']['Networks']
            run(['docker','rm','-f',name])
