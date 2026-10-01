"""Fenced language hydration + durable handoff. Drift checked, sequential replicas."""
import hashlib, json, pathlib, subprocess, time

ROOT = pathlib.Path('/home/adrien/.norva/selection-hydration-release-20261001')
EDGE = pathlib.Path('/home/adrien/.norva/owned-language-edge-rollout-20260928/functions')
BEFORE = {
    '_shared/vod-title-projection.ts': 'e208778844f876568b4bc8c32deef34d9db8a43448676f397d0f0d94bd060fd4',
    '_shared/selection-audio-results.mjs': 'b3927fb6ad7015b306ab757d48f7c08e3e035362d4bf905abb1d46c673fa619a',
    '_shared/selection-snapshot-tracks.mjs': 'cd9550adc515327db1001b397d3102abd703ab14841eb91b3f6aff67cbeb6a9d',
    'norva-source-sync/index.ts': '523ab7cbee6a1d87eb194c5e6e99ec4af6f08438fae0daf19c4530158aad5de5',
}

def sha(data):
    return hashlib.sha256(data.replace(b'\r\n', b'\n')).hexdigest()

def sql(query):
    r = subprocess.run(['docker','exec','-i','norva-db','psql','-X','-q','-At',
        '-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],
        input=query, text=True, capture_output=True, timeout=45)
    assert r.returncode == 0, r.stderr[-1200:]
    return r.stdout.strip()

def main():
    for relative, expected in BEFORE.items():
        assert sha((EDGE/relative).read_bytes()) == expected, 'Edge drift: '+relative
    assert sql("select count(*) from public.cloud_source_finalize_leases where lease_until>clock_timestamp();") == '0', 'wait for active finalizers'
    backup=ROOT/'before'
    backup.mkdir(mode=0o700,exist_ok=False)
    sql((ROOT/'supabase/migrations/20261001102000_finalize_release_heartbeat.sql').read_text()+"\nnotify pgrst, 'reload schema';")
    applied={}
    for relative in BEFORE:
        saved=backup/relative; saved.parent.mkdir(parents=True,exist_ok=True)
        saved.write_bytes((EDGE/relative).read_bytes())
        data=(ROOT/'supabase/functions'/relative).read_bytes()
        (EDGE/relative).write_bytes(data); applied[relative]=sha(data)
    for name in ['norva-edge-functions-2','norva-edge-functions']:
        subprocess.check_call(['docker','restart',name],stdout=subprocess.DEVNULL)
        assert subprocess.check_output(['docker','inspect','--format','{{.State.Running}}',name],text=True).strip()=='true'
        for relative, expected in applied.items():
            assert sha(subprocess.check_output(['docker','exec',name,'cat','/home/deno/functions/'+relative]))==expected
        print(json.dumps({'replica':name,'filesVerified':len(applied)}),flush=True)
    receipt={'appliedAtEpoch':time.time(),'files':applied}
    (ROOT/'receipt.safe.json').write_text(json.dumps(receipt))
    print(json.dumps(receipt),flush=True)

if __name__=='__main__': main()
