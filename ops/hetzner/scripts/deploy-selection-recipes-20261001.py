"""Additive Selection recipe rollout. Run from the uploaded reviewed worktree."""
import hashlib, json, pathlib, subprocess, time, urllib.request

ROOT = pathlib.Path('/home/adrien/.norva/selection-recipes-release-20261001')
EDGE = pathlib.Path('/home/adrien/.norva/owned-language-edge-rollout-20260928/functions')
BEFORE = {
    '_shared/vod-title-projection.ts': 'ed3ed6b45ffe0bd44777731e6cb69cb2e87de7bd9fbc9a758c98c980b97d71b6',
    'norva-cloud/index.ts': '0bfd9fe5fa3243b0ff822e1af5d9afde921243b70b7061169b6765e1c6f3295d',
    'norva-source-sync/index.ts': 'f1a458cea42c96d396c16c66ef00ebe34b40a63106d65292a5d921b374aa4799',
    '_shared/selection-title-recipes.mjs': None,
}

def sha(data):
    return hashlib.sha256(data.replace(b'\r\n', b'\n')).hexdigest()

def sql(query):
    result = subprocess.run(['docker', 'exec', '-i', 'norva-db', 'psql', '-X', '-q', '-At',
        '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres'],
        input=query, text=True, capture_output=True, timeout=45)
    assert result.returncode == 0, result.stderr[-1500:]
    return result.stdout.strip()

def main():
    for relative, expected in BEFORE.items():
        path = EDGE / relative
        assert (sha(path.read_bytes()) if path.exists() else None) == expected, 'Edge drift: ' + relative
    migration = (ROOT / 'supabase/migrations/20261001100000_selection_title_recipes.sql').read_text()
    acl = "select not has_table_privilege('authenticated','public.selection_title_recipes','select') and not has_table_privilege('anon','public.selection_title_recipes','select');"
    assert sql(migration.rsplit('commit;', 1)[0] + acl + 'rollback;') == 't', 'Recipe ACL failed'
    sql(migration + "\nnotify pgrst, 'reload schema';")
    backup = ROOT / 'before'
    backup.mkdir(mode=0o700, exist_ok=False)
    applied = {}
    for relative in BEFORE:
        path = EDGE / relative
        if path.exists():
            saved = backup / relative
            saved.parent.mkdir(parents=True, exist_ok=True)
            saved.write_bytes(path.read_bytes())
        data = (ROOT / 'supabase/functions' / relative).read_bytes()
        path.write_bytes(data)
        applied[relative] = sha(data)
    for name in ['norva-edge-functions-2', 'norva-edge-functions']:
        subprocess.check_call(['docker', 'restart', name], stdout=subprocess.DEVNULL)
        running = subprocess.check_output(['docker', 'inspect', '--format', '{{.State.Running}}', name], text=True).strip()
        assert running == 'true'
        for relative, expected in applied.items():
            actual = subprocess.check_output(['docker', 'exec', name, 'cat', '/home/deno/functions/' + relative])
            assert sha(actual) == expected, 'Replica mismatch'
        print(json.dumps({'replica': name, 'filesVerified': len(applied)}), flush=True)
    assert sql(acl) == 't'
    receipt = {'appliedAtEpoch': time.time(), 'files': applied, 'publicReadDenied': True}
    (ROOT / 'receipt.safe.json').write_text(json.dumps(receipt))
    print(json.dumps(receipt), flush=True)

if __name__ == '__main__':
    main()
