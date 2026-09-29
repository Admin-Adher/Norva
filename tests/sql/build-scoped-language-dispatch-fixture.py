"""Build a synthetic scheduling fixture from the installed function lineage."""
from pathlib import Path
import sys
root = Path(__file__).resolve().parents[2]
def read(name):
    return (root / name).read_text(encoding='utf-8')
base = read('supabase/migrations/20260911123735_lid_adaptive_quota.sql')
start = base.index('create or replace function public.list_due_catalog_file_audio_validation_jobs(')
end = base.index('$fn$;', start) + len('$fn$;')
function = base[start:end]
# Reproduce the two existing exact-file migration edits before testing the new
# migration; do not handwrite an alternate scheduler in the fixture.
function = function.replace('partition by j.identity_key order by',
    'partition by j.identity_key,(case when public.catalog_language_exact_file_admission_enabled() then j.source_id else null end) order by')
function = function.replace('where active.identity_key=j.identity_key and active.state',
    'where active.identity_key=j.identity_key and (not public.catalog_language_exact_file_admission_enabled() or active.source_id=j.source_id) and active.state')
setup = '''
create table public.fixture_modes(source_id uuid primary key, user_id uuid, enabled boolean);
create table public.fixture_legacy(enabled boolean);
insert into public.fixture_legacy values(false);
create function public.catalog_language_exact_file_admission_enabled() returns boolean
language sql stable as $$ select enabled from public.fixture_legacy $$;
-- Real scoped ownership/visibility/rollout tests live in exact-file-scoped.sql.
-- This fixture tests only dispatch's use of that existing predicate.
create function public.catalog_language_exact_file_enabled_for_source(u uuid,s uuid) returns boolean
language sql stable as $$ select exists(select 1 from public.fixture_modes where source_id=s and user_id=u and enabled) $$;
create table public.catalog_file_audio_validation_jobs(
id uuid primary key,requested_by uuid,source_id uuid,identity_key text,request_origin text,
retry_at timestamptz,lease_expires_at timestamptz,created_at timestamptz,state text,quarantined_at timestamptz);
'''
sys.stdout.buffer.write(('\n'.join([setup,function,
    read('supabase/migrations/20260929003500_scoped_language_dispatch.sql'),
    read('tests/sql/scoped-language-dispatch.sql')])).encode('utf-8'))
