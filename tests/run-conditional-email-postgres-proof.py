"""Operator proof driver: synthetic SQL in a bounded, networkless disposable DB.

PAYLOAD is a base64 JSON list of {name,content}, provided over SSH stdin.
It never runs SQL against norva-db and never starts an email process.
"""
import base64
import hashlib
import json
import os
import socket
import subprocess
import time

name = 'norva-conditional-email-proof-20260906'
image = 'supabase/postgres:17.6.1.136'
fixtures = json.loads(base64.b64decode(PAYLOAD))
assert socket.gethostname() == 'norva-db' and os.geteuid() == 1000


def run(args, data=None, check=True):
    result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=45)
    if check and result.returncode:
        raise RuntimeError(result.stderr[-3000:])
    return result


assert name not in run(['docker', 'ps', '-a', '--format', '{{.Names}}']).stdout.splitlines()
run(['docker', 'image', 'inspect', image])
created = False
try:
    run(['docker', 'run', '-d', '--name', name,
         '--label', 'norva.purpose=conditional-email-synthetic-proof',
         '--network', 'none', '--memory', '512m', '--cpus', '1', '--pids-limit', '128',
         '--tmpfs', '/tmp:rw,nosuid,size=384m,mode=1777',
         '--user', 'postgres', '--entrypoint', '/bin/sh', image, '-c',
         "initdb -D /tmp/proof -U postgres --auth=trust >/tmp/init.log 2>&1 && "
         "exec postgres -D /tmp/proof -k /tmp -c listen_addresses='' -c shared_buffers=32MB"])
    created = True
    for attempt in range(25):
        if run(['docker', 'exec', name, 'pg_isready', '-h', '/tmp', '-U', 'postgres'], check=False).returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError('Disposable PostgreSQL not ready')
    for fixture in fixtures:
        content = fixture['content'].replace('\r\n', '\n')
        result = run(['docker', 'exec', '-i', name, 'psql', '-X', '-h', '/tmp',
                      '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], content,
                     check=not fixture.get('expected_error'))
        if fixture.get('expected_error'):
            assert result.returncode != 0 and fixture['expected_error'] in result.stderr, 'Expected refusal missing'
        print(json.dumps({'fixture': fixture['name'], 'passed': True,
                          'sha256': hashlib.sha256(content.encode()).hexdigest(),
                          'result': result.stdout[-4000:] if fixture['name'] == 'final-guard-hashes'
                          else result.stdout[-400:]}), flush=True)
finally:
    if created:
        metadata = json.loads(run(['docker', 'inspect', name]).stdout)[0]
        assert metadata['Config']['Labels']['norva.purpose'] == 'conditional-email-synthetic-proof'
        assert metadata['HostConfig']['NetworkMode'] == 'none'
        run(['docker', 'rm', '-f', name])
        print(json.dumps({'disposableContainerRemoved': name, 'productionDatabaseTouched': False}), flush=True)
