"""Install existing cache keys while all playback rollout flags remain off.

The receiver private key stays on the deployment host. Input is an OAEP sealed
artifact, never a plaintext secret file. No secret is printed on failure.
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import subprocess
import time
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

LABEL = b'norva-media-cache-runtime-v1'
STAGE = pathlib.Path('/home/adrien/.norva/media-cache-runtime-20260924')
KEYS = ['NORVA_MEDIA_CACHE_WORKER_URL', 'NORVA_MEDIA_CACHE_WORKER_TOKEN',
        'NORVA_MEDIA_CACHE_TICKET_HMAC_KEY', 'NORVA_MEDIA_CACHE_COORDINATION_HMAC_KEY']


def unseal(private_pem, ciphertext, now_ms):
    private = serialization.load_pem_private_key(private_pem, password=None)
    raw = private.decrypt(ciphertext, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),
                          algorithm=hashes.SHA256(), label=LABEL))
    data = json.loads(raw)
    if set(data) != {'schema', 'issuedAt', 'ticketKey', 'coordinationKey'} or data['schema'] != 1:
        raise ValueError('invalid envelope')
    issued = data['issuedAt']
    if isinstance(issued, bool) or not isinstance(issued, (int, float)) or not 0 <= now_ms-issued <= 900000:
        raise ValueError('expired or future envelope')
    values = [data['ticketKey'], data['coordinationKey']]
    if not all(isinstance(v, str) and re.fullmatch('[0-9a-f]{64}', v) for v in values) or values[0] == values[1]:
        raise ValueError('invalid keys')
    return data


def sql(query):
    result = subprocess.run(['docker', 'exec', '-i', 'norva-db', 'psql', '-X', '-At',
                             '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres'],
                            input=query, capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError('runtime configuration transaction failed')
    return result.stdout.strip()


def provision(ciphertext_path, apply=False):
    private_path = STAGE/'recipient-private.pem'
    if private_path.stat().st_mode & 0o077:
        raise RuntimeError('receiver private key permissions are too broad')
    sealed = pathlib.Path(ciphertext_path).read_bytes()
    data = unseal(private_path.read_bytes(), sealed, time.time()*1000)
    gateway = json.loads(subprocess.check_output(['docker', 'inspect', 'norva-media-gateway']))[0]
    env = dict(v.split('=', 1) for v in gateway['Config']['Env'] if '=' in v)
    token = env.get('NORVA_MEDIA_CACHE_WORKER_TOKEN', '')
    url = env.get('NORVA_MEDIA_CACHE_WORKER_URL', '').rstrip('/')
    if url != 'https://media-cache.norva.tv' or not re.fullmatch('[A-Za-z0-9_-]{32,256}', token):
        raise RuntimeError('unexpected existing Gateway cache configuration')
    if len(set([data['ticketKey'], data['coordinationKey'], token, env.get('NORVA_MEDIA_CACHE_MANIFEST_HMAC_KEY')])) != 4:
        raise RuntimeError('cache keys must be distinct')
    values = [url, token, data['ticketKey'], data['coordinationKey']]
    key_list = ','.join("'"+k+"'" for k in KEYS)
    previous = json.loads(sql("select coalesce(json_agg(t),'[]'::json) from (select key,value from public.cloud_runtime_config where key in ("+key_list+")) t;"))
    if any(row['value'] for row in previous):
        raise RuntimeError('runtime keys already present; review before replacement')
    if not apply:
        return {'validated': True, 'applied': False, 'keys': KEYS}
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    with os.fdopen(os.open(STAGE/('before-'+stamp+'.json'), os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600), 'w') as f:
        json.dump(previous, f)
    rows = ','.join("('"+k+"','"+v+"')" for k,v in zip(KEYS, values))
    # Values are validated above and cannot contain SQL delimiters. Guard flags
    # and pre-existing key values again inside the transaction before changing keys.
    sql("""begin;
set local log_statement='none';
set local log_min_error_statement='panic';
set local lock_timeout='3s';
set local statement_timeout='5s';
lock table public.cloud_runtime_config in share row exclusive mode;
do $$ begin
 if exists(select 1 from public.cloud_runtime_config where
   (key in ('NORVA_MEDIA_CACHE_ENABLED','NORVA_MEDIA_CACHE_SINGLEFLIGHT_ENABLED','NORVA_MEDIA_CACHE_LIVE_JOIN_ENABLED') and value <> 'false')
   or (key='NORVA_MEDIA_CACHE_CANARY_STAGE' and value <> 'off')
   or (key='NORVA_MEDIA_CACHE_CANARY_USER_HASHES' and value <> '')) then
  raise exception 'Cache rollout must remain off during provisioning';
 end if;
 if exists(select 1 from public.cloud_runtime_config where key in ("""+key_list+""") and value <> '') then
  raise exception 'Runtime keys changed since validation';
 end if;
end $$;
insert into public.cloud_runtime_config(key,value) values """+rows+" on conflict(key) do update set value=excluded.value; commit;")
    receipt = {'applied': True, 'at': stamp, 'keys': KEYS, 'activationChanged': False,
               'sealedSha256': hashlib.sha256(sealed).hexdigest()}
    (STAGE/('receipt-'+stamp+'.json')).write_text(json.dumps(receipt, indent=2))
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('sealed_file')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        print(json.dumps(provision(args.sealed_file, args.apply)))
    except Exception:
        print(json.dumps({'ok': False, 'error': 'Provisioning refused or failed; secrets withheld.'}))
        raise SystemExit(1)
