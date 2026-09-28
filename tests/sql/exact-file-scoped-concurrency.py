"""Two real database connections against the disposable synthetic fixture only."""
import concurrent.futures
import subprocess
import sys

container = sys.argv[1]
if not container.startswith('norva-exact-scoped-qa'):
    raise SystemExit('Expected isolated QA container')

def sql(query):
    return subprocess.check_output(['docker', 'exec', '-i', container, 'psql', '-X',
        '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], input=query, text=True)

sql("""
update public.catalog_language_exact_file_rollout set basis_points=10000;
update public.provider_account_language_validation_leases set expires_at=now()+interval '2 minutes';
""")
def claim(external_id):
    return sql("""
begin;
set local request.jwt.claim.role='service_role';
select public.claim_provider_exact_file_probe_for_source(
 '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
 'source:00000000-0000-4000-8000-000000000001','movie', '%s', repeat('a',64),'holder',180);
select pg_sleep(0.4);
commit;
""" % external_id).strip()

with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    results = list(pool.map(claim, ['a', 'b']))
assert sorted(results) == ['f', 't'], results
assert sql('select count(*) from public.provider_exact_file_probe_leases;').strip() == '1'
print('PASS exact_simultaneous_account_exclusion')
