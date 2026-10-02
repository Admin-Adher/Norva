"""Reference rollout with a verified, persistent, deferred storyboard handoff.

No running job is stopped. The existing provider quiesce lease expires after
30 seconds without renewal. All viewer/CPU/cloud-session gates stay enforced.
"""
import copy
import importlib.util
import json
import pathlib
import subprocess
import sys
import time
import urllib.request


def deferred_health(health, checkpoint_count, persistent):
    h = copy.deepcopy(health)
    q = h.get('transcribeQueueDepth')
    assert type(q) is int and q > 0, 'no_deferred_queue'
    assert persistent and type(checkpoint_count) is int and checkpoint_count == q, 'checkpoint_count_mismatch'
    d = h.get('storyboardDurability', {})
    assert d.get('protocol') == 2 and d.get('enabled') is True and d.get('pending') == q, 'durability_not_attested'
    f = h.get('languageForegroundWork', {})
    assert f == dict(protocol=1, busy=False, activeOperations=0, admissionChecks=0,
                     pendingPriorityJobs=0, deferredBackgroundJobs=q), 'work_not_deferred'
    assert h.get('ocrQueueDepth') == 0 and h.get('translateQueueDepth') == 0, 'other_queue_present'
    h['transcribeBusy'] = False
    return h


CHECKPOINT = r"""
const fs=require('fs/promises'),crypto=require('crypto'),path=require('path');
const {StoryboardStore}=require('./src/storyboard-store');
(async()=>{const store=new StoryboardStore(process.env.STORYBOARD_PRIVATE_DIR,
process.env.GATEWAY_TOKEN||process.env.NORVA_MEDIA_GATEWAY_TOKEN);
const jobs=await store.load();const proof=[];
for(const j of jobs){if(j.durable!==true||j.kind!=='storyboard'||j.prio!==1)throw Error('invalid');
const bytes=await fs.readFile(path.join(store.dir(j.jobId),'job.json'));
proof.push(crypto.createHash('sha256').update(bytes).digest('hex'));}
console.log(JSON.stringify({count:jobs.length,digests:proof.sort()}));})().catch(()=>process.exit(1));
"""


def main():
    spec = importlib.util.spec_from_file_location('reference', pathlib.Path(__file__).with_name('rollout-reference-gateway.py'))
    r = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(r)
    node = sys.argv[1]
    assert node in r.NODES
    original = r.inspect(node)
    token = r.env(original)['GATEWAY_TOKEN']
    base = 'http://127.0.0.1:' + str(r.NODES[node])

    def request(route, body=None):
        req = urllib.request.Request(base + route, data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=15) as response:
            return json.load(response)

    lease = request('/provider-quiesce/begin', {'reason': 'verified durable storyboard deployment handoff'})['token']
    original_health = r.health
    last_proof = None

    def guarded_health(name, container, debug=False):
        nonlocal last_proof
        h = original_health(name, container, debug)
        if debug or r.inspect(name)['Id'] != original['Id'] or not h.get('transcribeBusy'):
            return h
        status = request('/provider-quiesce/renew', {'token': lease})
        assert status.get('held') and status.get('activeMetadataRequests') == 0, 'metadata_not_drained'
        directory = r.env(original).get('STORYBOARD_PRIVATE_DIR', '')
        persistent = any(m.get('RW') and directory.startswith(m['Destination'].rstrip('/') + '/')
                         for m in original['Mounts'])
        proof = json.loads(subprocess.check_output(['docker', 'exec', original['Id'], 'node', '-e', CHECKPOINT], text=True))
        h = deferred_health(h, proof['count'], persistent)
        last_proof = proof
        return h

    r.health = guarded_health
    try:
        deadline = time.monotonic() + 180
        while True:
            request('/provider-quiesce/renew', {'token': lease})
            try:
                r.idle(node, original, expected_version=int(sys.argv[sys.argv.index('--current-version') + 1]))
                break
            except AssertionError as error:
                if time.monotonic() >= deadline:
                    raise
                print(json.dumps({'waiting': str(error)}), flush=True)
                time.sleep(10)
        r.main()
        current = r.inspect(node)
        if '--apply' in sys.argv and last_proof is not None:
            after = json.loads(subprocess.check_output(['docker', 'exec', current['Id'], 'node', '-e', CHECKPOINT], text=True))
            assert after == last_proof, 'checkpoint_handoff_drift'
            print(json.dumps({'durableCheckpointHandoff': True, 'jobs': after['count']}))
    finally:
        if r.inspect(node)['Id'] == original['Id']:
            try:
                request('/provider-quiesce/cancel', {'token': lease})
            except Exception:
                print(json.dumps({'quiesceRelease': 'lease auto-expires within 30 seconds'}))


if __name__ == '__main__':
    main()
