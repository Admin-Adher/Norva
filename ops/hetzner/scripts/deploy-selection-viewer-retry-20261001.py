"""Scoped, drift-checked worker patch. Provider work drains before replacement."""
import hashlib, json, os, pathlib, subprocess, time

ROOT=pathlib.Path('/home/adrien/.norva/selection-viewer-retry-20261001')
TARGET=pathlib.Path('/home/adrien/.norva/enrichment-pilot20-20260911/selection-live-runner/selection-audio-worker.mjs')
EXPECTED='67f1426120e1039dd7e5a2fc902f57f85a565729b6065dd3fc3aef49030c8d5d'
NAME='norva-selection-audio-worker'
def digest(data):return hashlib.sha256(data.replace(b'\r\n',b'\n')).hexdigest()
def run(*args):return subprocess.check_output(args,timeout=60)

before=TARGET.read_bytes()
assert digest(before)==EXPECTED,'worker drift'
after=(ROOT/'selection-audio-worker.mjs').read_bytes().replace(b'\r\n',b'\n')
assert b"'SELECTION_AUDIO_VIEWER_BUSY'].includes(error.code)" in after
assert b'&& error.providerDrained === true' in after
backup=ROOT/'selection-audio-worker.before.mjs'
fd=os.open(backup,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
with os.fdopen(fd,'wb') as file:file.write(before)
stopped=False
try:
    # SIGTERM aborts the owned background work, checkpoints it, and awaits the
    # task pool. Neither Gateway nor any viewer process is restarted.
    run('docker','stop','--time','45',NAME);stopped=True
    state=json.loads(run('docker','inspect',NAME))[0]['State']
    assert state['ExitCode']==0,'worker did not drain cleanly'
    TARGET.write_bytes(after)
    run('docker','start',NAME);stopped=False
    assert json.loads(run('docker','inspect',NAME))[0]['State']['Running']
    assert digest(run('docker','exec',NAME,'cat','/worker/ops/hetzner/services/selection-audio-worker.mjs'))==digest(after)
except BaseException:
    TARGET.write_bytes(before)
    if stopped:run('docker','start',NAME)
    raise
receipt={'appliedAtEpoch':time.time(),'worker':NAME,'sha256':digest(after),'drained':True}
(ROOT/'receipt.safe.json').write_text(json.dumps(receipt))
print(json.dumps(receipt))
