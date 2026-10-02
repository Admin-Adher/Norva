"""Refresh public Selection display fields; never rebuild an owner's inventory.

Run on the DB host. Upload the reviewed migration into ROOT first. Modes:
schema, backfill DONOR_USER DONOR_SOURCE, maintain, summary. A donor supplies
only a validated identity for an identical public file; all display data comes
from catalog_titles. Receipts contain aggregate counts, never credentials.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from uuid import UUID

ROOT = Path('/home/adrien/.norva/selection-editorial-refresh-20261002')
MIGRATION = '20261002150000_selection_shared_editorial_refresh.sql'


def sql(statement, timeout=90):
    result = subprocess.run(
        ['docker', 'exec', '-i', 'norva-db', 'psql', '-X', '-q', '-At',
         '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres'],
        input=statement, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(result.stderr[-2000:])
    return result.stdout.strip()


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def receipt(name, data):
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = ROOT / (name + '.safe.json')
    target.write_text(json.dumps(data, indent=2))
    os.chmod(target, 0o600)
    print(json.dumps(data), flush=True)


def immutable_files():
    return json.loads(sql("""select jsonb_build_object(
      'media',md5((select string_agg(md5(to_jsonb(m)::text),'' order by release_id,item_type,external_id)
        from public.selection_shared_media m)),
      'variants',md5((select string_agg(md5(to_jsonb(v)::text),'' order by release_id,item_type,external_id)
        from public.selection_shared_variants v)),
      'releases',md5((select string_agg(md5((to_jsonb(r)-'editorial_updated_at')::text),'' order by id)
        from public.selection_shared_releases r)));"""))


def summary():
    return json.loads(sql("""set statement_timeout='30s'; select jsonb_agg(stats) from (
      select item_type,count(*) titles,
        count(*) filter(where nullif(poster_url,'') is null) missing_posters,
        count(*) filter(where nullif(coalesce(metadata#>>'{i18n,fr,overview}',metadata#>>'{tmdb,overview}',
          metadata->>'overview',metadata->>'plot'),'') is null) missing_synopsis,
        count(*) filter(where cardinality(genre_buckets)=1 and 'autres'=any(genre_buckets)) only_other_genre,
        count(*) filter(where provider_tmdb_id is not null) tmdb_id
      from public.selection_shared_titles t join public.selection_shared_releases r on r.id=t.release_id
      where r.published_at is not null group by item_type order by item_type) stats;"""))


def schema():
    assert sql("select to_regprocedure('public.norva_refresh_selection_shared_editorial(uuid,text,text,text[],uuid,uuid,uuid)') is null;") == 't', 'Schema already installed'
    expected_functions = {'norva_selection_shared_publish_guard': 'e00b176cf69ac50de11773cf5f5ab52f',
                          'norva_get_visible_catalog_titles_by_ids': '5a9e42e47a3dbf6ed425af32bd034128'}
    expected_views = {'selection_shared_visible_titles': '28e0a49b49c0db49ed527933ac8ad9f9',
                      'cloud_catalog_visible_titles': '18fcbc778f282ea62e053481cbfda77e'}
    for name, digest in expected_functions.items():
        assert sql("select md5(pg_get_functiondef(oid)) from pg_proc where pronamespace='public'::regnamespace and proname=" + quote(name) + ';') == digest, 'Function contract drift: ' + name
    for name, digest in expected_views.items():
        assert sql('select md5(pg_get_viewdef(' + quote('public.' + name) + '::regclass,true));') == digest, 'View contract drift: ' + name
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    backup = ROOT / 'before'
    backup.mkdir(mode=0o700, exist_ok=False)
    definitions = sql("""select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('norva_selection_shared_publish_guard','norva_get_visible_catalog_titles_by_ids')
      order by p.proname;""")
    for view in ['selection_shared_visible_titles', 'cloud_catalog_visible_titles']:
        options = sql("select array_to_string(reloptions,',') from pg_class where oid=" + quote('public.' + view) + '::regclass;')
        definition = sql('select pg_get_viewdef(' + quote('public.' + view) + '::regclass,true);')
        definitions += '\ncreate or replace view public.' + view + (' with(' + options + ')' if options else '') + ' as\n' + definition + '\n'
    (backup / 'definitions.sql').write_text(definitions)
    rows = sql("select to_jsonb(t) from public.selection_shared_titles t order by release_id,item_type,identity_key;")
    (backup / 'public-titles.jsonl').write_text(rows + '\n')
    os.chmod(backup / 'definitions.sql', 0o600)
    os.chmod(backup / 'public-titles.jsonl', 0o600)
    before = immutable_files()
    migration = (ROOT / MIGRATION).read_bytes()
    sql(migration.decode('utf-8-sig'))
    assert immutable_files() == before, 'File manifest changed during schema install'
    receipt('schema', {'at': time.time(), 'migration': MIGRATION,
        'sha256': hashlib.sha256(migration.replace(b'\r\n', b'\n')).hexdigest(),
        'immutableFiles': before, 'backupDefinitionsSha256': hashlib.sha256(definitions.encode()).hexdigest()})


def backfill(donor_user, donor_source):
    donor_user, donor_source = str(UUID(donor_user)), str(UUID(donor_source))
    snapshot = json.loads(sql("set request.jwt.claim.role='service_role'; select public.norva_get_catalog_write_snapshot(" + quote(donor_source) + '::uuid,' + quote(donor_user) + '::uuid);'))
    assert snapshot.get('isCatalogVisible') is True, 'Donor source hidden'
    assert sql('select public.norva_selection_source_identity_valid(' + quote(donor_source) + '::uuid,' + quote(donor_user) + '::uuid);') == 't', 'Canonical source required'
    donor_generation = str(UUID(snapshot['generationId']))
    releases = json.loads(sql("select coalesce(jsonb_agg(jsonb_build_object('id',id,'manifest',manifest_sha256) order by published_at),'[]') from public.selection_shared_releases where published_at is not null;"))
    before, stats_before = immutable_files(), summary()
    all_receipts = []
    for release in releases:
        for item_type in ['movie', 'series']:
            keys = json.loads(sql('select coalesce(jsonb_agg(identity_key order by identity_key),\'[]\') from public.selection_shared_titles where release_id=' + quote(release['id']) + '::uuid and item_type=' + quote(item_type) + ';'))
            for offset in range(0, len(keys), 250):
                key_array = 'array[' + ','.join(quote(key) for key in keys[offset:offset + 250]) + ']::text[]'
                call = 'select public.norva_refresh_selection_shared_editorial(' + ','.join([
                    quote(release['id']) + '::uuid', quote(release['manifest']), quote(item_type), key_array,
                    quote(donor_user) + '::uuid', quote(donor_source) + '::uuid', quote(donor_generation) + '::uuid']) + ');'
                batch = json.loads(sql("set request.jwt.claim.role='service_role'; set statement_timeout='30s'; " + call))
                all_receipts.append(batch)
                print(json.dumps({'type': item_type, 'offset': offset, **batch}), flush=True)
    assert immutable_files() == before, 'Public files changed during editorial refresh'
    receipt('backfill-' + str(int(time.time())), {'at': time.time(), 'batches': all_receipts,
        'before': stats_before, 'after': summary(), 'immutableFiles': before})


def maintain():
    command = "set statement_timeout='30s'; set request.jwt.claim.role='service_role'; select public.norva_refresh_selection_shared_editorial_from_cache(250);"
    jobname = 'norva-selection-editorial-refresh'
    jobs = json.loads(sql('select coalesce(jsonb_agg(to_jsonb(j)),\'[]\') from cron.job j where jobname=' + quote(jobname) + ';'))
    assert not jobs or (len(jobs) == 1 and jobs[0]['database'] == 'postgres' and jobs[0]['username'] == 'supabase_admin'), 'Cron ownership/database drift'
    if jobs:
        sql('select cron.alter_job(' + str(jobs[0]['jobid']) + ',schedule:=\'11-59/15 * * * *\',command:=' + quote(command) + ',active:=true);')
    else:
        sql('select cron.schedule(' + quote(jobname) + ',\'11-59/15 * * * *\',' + quote(command) + ');')
    current = json.loads(sql('select jsonb_build_object(\'active\',active,\'schedule\',schedule,\'database\',database,\'commandMatches\',command=' + quote(command) + ') from cron.job where jobname=' + quote(jobname) + ';'))
    assert current['active'] and current['commandMatches'] and current['database'] == 'postgres', 'Maintenance activation failed'
    replay = json.loads(sql("set request.jwt.claim.role='service_role'; set statement_timeout='30s'; select public.norva_refresh_selection_shared_editorial_from_cache(250);"))
    receipt('maintenance', {'at': time.time(), 'job': current, 'replay': replay})


if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'schema':
        schema()
    elif mode == 'backfill':
        backfill(sys.argv[2], sys.argv[3])
    elif mode == 'maintain':
        maintain()
    elif mode == 'summary':
        print(json.dumps(summary()))
    else:
        raise ValueError('Expected schema, backfill, maintain or summary')
