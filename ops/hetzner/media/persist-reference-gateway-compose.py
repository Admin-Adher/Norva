"""Persist only the production image in the existing protected Compose override."""
import datetime
import json
import os
import pathlib
import re
import subprocess

root = pathlib.Path('/home/adrien/.norva/gateway-reference-rollout')
root.mkdir(parents=True, exist_ok=True, mode=0o700)
project = pathlib.Path('/home/adrien/.norva/nodemaven-switch-20260919')
override = project / 'override.yml'
envfile = project / '.env.media-vaapi'
base = project / 'docker-compose.vaapi.yml'
manifest = {'candidateImage':'sha256:dbfaaea9a69b41d58543f00086427963a3d75e7bafd1e8e7718a27547ab67118'}
live = json.loads(subprocess.check_output(['docker', 'inspect', 'norva-media-gateway']))[0]
assert live['Image'] == manifest['candidateImage'] and live['State']['Running']
assert not override.is_symlink() and override.parent.resolve() == project.resolve()
assert not envfile.is_symlink() and not base.is_symlink()
old = override.read_bytes()
pattern = rb'(?m)^(    image: )sha256:[a-f0-9]{64}(\r?\n)'
matches = list(re.finditer(pattern, old))
assert len(matches) == 1, 'unexpected_gateway_image_declarations'
new = re.sub(pattern, lambda match: match.group(1) + manifest['candidateImage'].encode()
             + match.group(2), old, count=1)
assert new != old
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = root / ('compose-override-before-' + stamp + '.yml')
assert not backup.exists(), 'backup_already_exists'
backup.write_bytes(old)
backup.chmod(0o600)
tmp = override.with_name('override.yml.reference.tmp')
assert not tmp.exists()
tmp.write_bytes(new)
tmp.chmod(0o600)
os.replace(tmp, override)
try:
    args = ['docker', 'compose', '--env-file', str(envfile), '-f', str(base),
            '-f', str(override), 'config', '--format', 'json']
    rendered = json.loads(subprocess.check_output(args, stderr=subprocess.PIPE))['services']['gateway']
    assert rendered['image'] == live['Image']
    env = dict(item.split('=', 1) for item in live['Config']['Env'])
    assert {key: str(value) for key, value in rendered['environment'].items()} == env
    live_mounts = {(item['Source'], item['Destination']) for item in live['Mounts']}
    compose_mounts = {(item['source'], item['target']) for item in rendered.get('volumes', [])}
    assert compose_mounts == live_mounts
except Exception:
    tmp.write_bytes(old)
    tmp.chmod(0o600)
    os.replace(tmp, override)
    raise
print(json.dumps({'composePersisted': True, 'imageId': live['Image'],
                  'environmentVerified': True, 'mountsVerified': True,
                  'backup': backup.name}))
