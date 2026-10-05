"""Run only against a disposable, networkless schema clone with synthetic rows.

The owner/source fixture from provider-audio-metadata-catchup.sql must be
committed first. A second database session holds the real global admission
lock; the claim must yield without writing a cursor or consuming an attempt.
"""
import json, subprocess, sys, time

name = sys.argv[1]
info = json.loads(subprocess.check_output(['docker', 'inspect', name]))[0]
assert info['HostConfig']['NetworkMode'] == 'none', 'networked_database_forbidden'
assert 'proof' in name, 'production_database_forbidden'
cmd = ['docker', 'exec', '-i', name, 'psql', '-h', '/tmp', '-X', '-qAt',
       '-U', 'postgres', '-v', 'ON_ERROR_STOP=1']
holder = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True)
try:
    holder.stdin.write("begin; select pg_advisory_xact_lock(hashtextextended('catalog-language-admission',0)); select 'held';\n")
    holder.stdin.flush()
    while holder.stdout.readline().strip() != 'held':
        assert holder.poll() is None, 'holder_failed'
    started = time.monotonic()
    result = subprocess.run(cmd, input="""
      begin; set local statement_timeout='1500ms';
      set local request.jwt.claim.role='service_role';
      select public.claim_catalog_provider_audio_metadata(
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002');
      select jsonb_build_object('sweeps', (select count(*) from catalog_provider_audio_metadata_sweeps),
        'retries', (select count(*) from catalog_provider_audio_metadata_retries));
      rollback;
    """, capture_output=True, text=True, timeout=5)
    elapsed = round((time.monotonic() - started) * 1000, 3)
    if '--baseline' in sys.argv:
        assert result.returncode != 0 and 'statement timeout' in result.stderr
        print(json.dumps({'baselineTimeoutReproduced': True, 'elapsedMs': elapsed}))
    else:
        assert result.returncode == 0, result.stderr
        rows = [json.loads(x) for x in result.stdout.splitlines() if x.startswith('{')]
        assert rows == [{'hasMore': True, 'skipped': 'metadata-capacity'}, {'sweeps': 0, 'retries': 0}], rows
        print(json.dumps({'passed': True, 'checks': 3, 'elapsedMs': elapsed,
                          'cursorWrites': 0, 'providerRequests': 0}))
finally:
    holder.stdin.write('rollback;\n\\q\n')
    holder.stdin.flush()
    holder.communicate(timeout=5)
