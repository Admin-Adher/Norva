"""Networkless SQL proof, never a deployment or production-data mutation.

Copies schema and installed function definitions only using read-only SQL.
The synthetic PostgreSQL container has no network, ports or production mounts.
"""
import concurrent.futures
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import time

ROOT = pathlib.Path('/home/adrien/.norva/enrichment-pipeline-proof-20260911')
HELPER = ROOT.parent / 'automatic-vod-language-fleet-20260911/deploy-automatic-vod-language-fleet-20260911.py'
spec = importlib.util.spec_from_file_location('fixture_helpers', HELPER)
fleet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fleet)
fleet.ROOT = ROOT
fleet.PROOF = 'norva-enrichment-metadata-proof-20260911'
fleet.LABEL = 'enrichment-metadata-proof-20260911'
fleet.TABLES += ('catalog_vod_language_sweeps', 'catalog_vod_language_intake', 'catalog_language_capacity', 'catalog_selection_audio_jobs')
fleet.TABLES = tuple(dict.fromkeys(fleet.TABLES + ('provider_file_probe_leases', 'provider_account_language_validation_leases', 'cloud_media_items', 'cloud_playback_sessions')))
fleet.HELPERS += ('vod_language_profile_is_exact', 'catalog_language_execution_available',
    'catalog_language_queue_available', 'norva_credential_require_service_role', 'norva_selection_source_identity_valid', 'selection_audio_job_owners')
fleet.TARGETS += ('start_catalog_file_audio_validation_job', 'claim_catalog_file_audio_validation_job',
    'list_due_catalog_file_audio_validation_jobs', 'claim_catalog_vod_language_file', 'finish_catalog_vod_language_file',
    'report_catalog_language_capacity', 'finish_catalog_file_audio_validation_provider_attempt')
fleet.TARGETS += ('claim_selection_audio_job',)
fleet.TARGETS += ('claim_provider_file_probe','release_provider_file_probe','claim_provider_account_language_validation','release_provider_account_language_validation')
MIGRATION = '20260911182400_enrichment_metadata_lane.sql'


def main():
    require, run, sql = fleet.require, fleet.gw.run, fleet.sql
    require(ROOT.is_dir() and not ROOT.is_symlink(), 'proof_directory_invalid')
    require(fleet.PROOF not in run(['docker', 'ps', '-a', '--format', '{{.Names}}']).decode().splitlines(), 'proof_exists')
    before = fleet.definitions()
    created = None
    try:
        created = run(['docker', 'run', '-d', '--name', fleet.PROOF, '--label', 'norva.purpose=' + fleet.LABEL,
            '--network', 'none', '--memory', '512m', '--cpus', '1', '--pids-limit', '128',
            '--tmpfs', '/tmp:rw,nosuid,size=384m,mode=1777', '--user', 'postgres', '--entrypoint', '/bin/sh',
            'supabase/postgres:17.6.1.136', '-c',
            "initdb -D /tmp/proof -U postgres --auth=trust >/tmp/init.log 2>&1 && exec postgres -D /tmp/proof -k /tmp -c listen_addresses='' -c shared_buffers=32MB"]).decode().strip()
        for _ in range(25):
            if subprocess.run(['docker', 'exec', fleet.PROOF, 'pg_isready', '-h', '/tmp', '-U', 'postgres'], capture_output=True).returncode == 0:
                break
            time.sleep(1)
        sql(fleet.fixture_schema() + '''
ALTER TABLE public.catalog_file_audio_validation_jobs ADD PRIMARY KEY(id);
CREATE UNIQUE INDEX metadata_fixture_active_file ON public.catalog_file_audio_validation_jobs(identity_key,item_type,external_id)
WHERE state IN ('queued','running','retry_wait','finalizing');
ALTER TABLE public.catalog_vod_language_sweeps ADD PRIMARY KEY(source_id);
ALTER TABLE public.catalog_vod_language_intake ADD PRIMARY KEY(variant_id);
ALTER TABLE public.catalog_language_capacity ADD PRIMARY KEY(singleton);
ALTER TABLE public.catalog_selection_audio_jobs ADD PRIMARY KEY(external_id,url_sha256);
ALTER TABLE public.catalog_selection_audio_jobs ADD UNIQUE(id);
ALTER TABLE public.provider_file_probe_leases ADD PRIMARY KEY(identity_key);
ALTER TABLE public.provider_account_language_validation_leases ADD PRIMARY KEY(provider_account_hash);
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT '{}'::jsonb$$;
INSERT INTO public.admin_feature_flags(key,enabled) VALUES('adaptive_language_admission_enabled',false);
''', True)
        # Execute the older quota/claim tests against the installed definitions
        # first; apply only the new migration to this synthetic fixture.
        sql(fleet.artifact('language-adaptive-admission.sql'), True)
        sql(fleet.artifact(MIGRATION), True)
        sql(fleet.artifact('enrichment-metadata-lane.sql'), True)
        sql(fleet.artifact('20260911191032_strict_lid_capture_handoff.sql'), True)
        sql(fleet.artifact('strict-lid-capture-handoff.sql'), True)
        sql(fleet.artifact('20260911200200_selection_audio_capture_handoff.sql'), True)
        sql(fleet.artifact('selection-audio-capture-handoff.sql'), True)
        sql(fleet.artifact('20260911204152_selection_parallel_capture_admission.sql'), True)
        sql(fleet.artifact('selection-parallel-capture-admission.sql'), True)
        def selection_claim(_):
            return sql("SET request.jwt.claim.role='service_role'; SELECT public.claim_selection_audio_job() IS NOT NULL;", True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            selection_results = list(pool.map(selection_claim, range(4)))
        # Try-advisory claims may reject racing callers; refill sequentially to
        # prove the absolute capacity while the four-client race cannot exceed it.
        require(sum(r.endswith('t') for r in selection_results) <= 2, 'concurrent_selection_ceiling_failed')
        selection_claim(0)
        selection_claim(0)
        sql("SELECT public.metadata_assert((SELECT count(*)=2 FROM public.catalog_selection_audio_jobs WHERE state='running' AND lease_until>clock_timestamp()),'selection_parallel_concurrent_ceiling');", True)
        sql(fleet.artifact('20260911204928_exact_file_account_enrichment_admission.sql'), True)
        sql(fleet.artifact('exact-file-account-enrichment-admission.sql'), True)
        for digit in ('6','7','8'):
            sql("SET request.jwt.claim.role='service_role'; SELECT public.claim_provider_account_language_validation(repeat('"+digit+"',64),'exact-race-"+digit+"',180);", True)
        def exact_claim(spec):
            identity, file, digit = spec
            return sql("SET request.jwt.claim.role='service_role'; SELECT public.claim_provider_exact_file_probe('"+identity+"','movie','"+file+"',repeat('"+digit+"',64),'exact-race-"+digit+"',180);", True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            same_account = list(pool.map(exact_claim,[('exact-account-race','1','6'),('exact-account-race','2','6')]))
        require(same_account.count('t') == 1 and same_account.count('f') == 1, 'concurrent_exact_mono_account_failed')
        sql("SET request.jwt.claim.role='service_role'; SELECT public.release_provider_exact_file_probe('exact-account-race','movie','1','exact-race-6'); SELECT public.release_provider_exact_file_probe('exact-account-race','movie','2','exact-race-6');", True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            same_file = list(pool.map(exact_claim,[('exact-file-race','1','6'),('exact-file-race','1','7')]))
        require(same_file.count('t') == 1 and same_file.count('f') == 1, 'concurrent_exact_file_dedup_failed')
        def rolling_claim(n):
            return exact_claim(('exact-rolling-race','1','8')) if n else sql("SELECT public.claim_provider_file_probe('exact-rolling-race','old-worker',180);", True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            rolling = list(pool.map(rolling_claim,[0,1]))
        require(rolling.count('t') == 1 and rolling.count('f') == 1, 'concurrent_rolling_probe_barrier_failed')
        sql("SELECT public.metadata_assert(true,'exact_concurrent_mono_account'); SELECT public.metadata_assert(true,'exact_concurrent_file_dedup'); SELECT public.metadata_assert(true,'exact_concurrent_rolling_barrier');", True)
        sql("SELECT public.report_catalog_language_metadata_capacity(2,'capacity-available',clock_timestamp());", True)

        def claim(n):
            return sql("SELECT public.claim_catalog_vod_language_file('00000000-0000-0000-0000-000000000001',"
                "'10000000-0000-0000-0000-0000000000" + str(n) + "')->>'variantId' IS NOT NULL;", True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(claim, [93, 94, 95, 96]))
        require(results.count('t') == 2 and results.count('f') == 2, 'concurrent_metadata_ceiling_failed')
        sql("SELECT public.metadata_assert((SELECT count(*)=2 FROM public.catalog_vod_language_intake WHERE state='leased'),'concurrent_metadata_exact_ceiling');", True)
        checks = json.loads(sql("SELECT jsonb_agg(label ORDER BY label) FROM (SELECT label FROM public.quota_proof_checks UNION ALL SELECT label FROM public.metadata_proof_checks) x;", True))
        require(fleet.definitions() == before, 'production_function_drift')
        receipt = {'passed': True, 'checks': checks, 'providerRequests': 0, 'productionWrites': 0,
            'migrationSha256': hashlib.sha256(fleet.artifact(MIGRATION).encode()).hexdigest(),
            'captureMigrationSha256': hashlib.sha256(fleet.artifact('20260911191032_strict_lid_capture_handoff.sql').encode()).hexdigest(),
            'selectionCaptureMigrationSha256': hashlib.sha256(fleet.artifact('20260911200200_selection_audio_capture_handoff.sql').encode()).hexdigest(),
            'selectionParallelMigrationSha256': hashlib.sha256(fleet.artifact('20260911204152_selection_parallel_capture_admission.sql').encode()).hexdigest(),
            'exactFileAdmissionMigrationSha256': hashlib.sha256(fleet.artifact('20260911204928_exact_file_account_enrichment_admission.sql').encode()).hexdigest(),
            'limitations': ['synthetic data', 'visibility wrapper', 'production row triggers not copied']}
        fleet.save('proof-' + str(time.time_ns()) + '.json', receipt)
        print(json.dumps({**receipt, 'checks': len(checks)}))
    finally:
        if created:
            c = fleet.gw.inspect(fleet.PROOF)
            require(c['Id'] == created and c['HostConfig']['NetworkMode'] == 'none'
                and c['Config']['Labels']['norva.purpose'] == fleet.LABEL, 'fixture_scope_changed')
            run(['docker', 'rm', '-f', created])


if __name__ == '__main__':
    main()
