"""Isolated parser/ACL proof on the installed PostgreSQL image; no provider I/O."""
import hashlib,json,os,pathlib,subprocess,time
ROOT=pathlib.Path('/home/adrien/.norva/provider-dubbed-proof-20260913')
NAME='norva-provider-dubbed-proof-20260913'
LABEL='provider-dubbed-proof-20260913'
def run(args,**kwargs):
    result=subprocess.run(args,capture_output=True,timeout=40,**kwargs)
    if result.returncode: raise RuntimeError('proof_command_failed')
    return result.stdout
def inspect(name):return json.loads(run(['docker','inspect',name]))[0]
def main():
    assert ROOT.is_dir() and not ROOT.is_symlink() and not (ROOT/'proof.private.json').exists()
    assert NAME not in run(['docker','ps','-a','--format','{{.Names}}']).decode().splitlines()
    image=inspect('norva-db')['Image'];created=None;proof=None
    fixture=(ROOT/'fixture.sql').read_bytes();migration=(ROOT/'20260913102000_provider_dubbed_language_target.sql').read_bytes().replace(b'\r\n',b'\n')
    try:
        created=run(['docker','run','-d','--name',NAME,'--label','norva.purpose='+LABEL,'--network','none',
            '--memory','512m','--cpus','0.5','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,size=384m,mode=1777',
            '--user','postgres','--entrypoint','/bin/sh',image,'-c',
            "initdb -D /tmp/proof -U postgres --auth=trust >/tmp/init.log 2>&1 && exec postgres -D /tmp/proof -k /tmp -c listen_addresses='' -c shared_buffers=32MB"]).decode().strip()
        for attempt in range(25):
            if subprocess.run(['docker','exec',created,'pg_isready','-h','/tmp','-U','postgres'],capture_output=True).returncode==0:break
            if attempt==24:raise RuntimeError('proof_start_timeout')
            time.sleep(1)
        result=subprocess.run(['docker','exec','-i',created,'psql','-h','/tmp','-U','postgres','-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1'],input=fixture,capture_output=True,timeout=40)
        (ROOT/'sql-test.log').write_bytes(result.stdout+result.stderr)
        if result.returncode:raise RuntimeError('sql_fixture_failed')
        proof=json.loads(result.stdout.decode().strip().splitlines()[-1])
        assert proof['passed'] is True and proof['cases']>=60
        proof.update(image=image,network='none',productionWrites=0,providerRequests=0,
            migrationSha256=hashlib.sha256(migration).hexdigest(),fixtureSha256=hashlib.sha256(fixture).hexdigest())
    finally:
        if created:
            item=inspect(created)
            assert item['Id']==created and item['Config']['Labels']['norva.purpose']==LABEL
            assert item['HostConfig']['NetworkMode']=='none' and not item['HostConfig'].get('Binds')
            run(['docker','stop','--time','20',created]);run(['docker','rm',created])
    proof['fixtureRemoved']=True
    with (ROOT/'proof.private.json').open('x') as out:json.dump(proof,out)
    print(json.dumps({k:v for k,v in proof.items() if k!='definitions'}))
if __name__=='__main__':
    os.umask(0o077)
    main()
