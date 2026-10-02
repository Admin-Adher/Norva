"""Restore exact pre-maintenance artwork without asserting an uncertain identity.

Only a formerly checked official image downgraded to a non-TMDB URL is eligible.
The same-ID association is preserved, including unresolved audit results. The
full compare-and-swap plan must pass the isolated rollback before production.
"""
import argparse
import json
from pathlib import Path
import subprocess
import time
from importlib.util import module_from_spec, spec_from_file_location

spec = spec_from_file_location('live_artwork_full', Path(__file__).with_name('audit-selection-exhaustive-20261002.py'))
full = module_from_spec(spec); spec.loader.exec_module(full)
audit = full.audit; ROOT = full.ROOT / 'live-artwork'
repair = full.module('live_artwork_repair', 'repair-selection-editorial-20261002.py')
QA_DATABASE = 'norva_selection_editorial_gap_qa_20261002'
QA_RELEASE = '5ba07e99-461c-42b2-9977-223c7bdce86c'


def plan():
    file = ROOT / 'reviewed-plan.json'
    if file.exists():
        return json.loads(file.read_text())
    before = json.loads((full.ROOT / 'final-data.private.json').read_text())
    inputs = json.loads((full.ROOT / 'inputs.json').read_text())
    current = json.loads(audit.sql("select jsonb_agg(t) from selection_shared_titles t where release_id='"
      + inputs[0]['release_id'] + "' and item_type in ('movie','series');"))
    by_key = {(r['item_type'], r['identity_key']): r for r in current}; changes = []
    for old in before:
        row = by_key[(old['item_type'], old['identity_key'])]
        if old['poster_url'] == row['poster_url'] or not (old['poster_url'] or '').startswith('https://image.tmdb.org/'):
            continue
        if (row['poster_url'] or '').startswith('https://image.tmdb.org/'):
            continue
        assert old['provider_tmdb_id'] == row['provider_tmdb_id'] and audit.poster_path(old['poster_url'])
        proof = json.loads((full.ROOT / 'artwork' / (audit.digest(old['poster_url']) + '.json')).read_text())
        assert proof['status'] == 'ok', 'Previous official image not checked'
        changes.append({'item_type': row['item_type'], 'identity_key': row['identity_key'], 'title': row['title'],
          'release_id': row['release_id'], 'manifest': inputs[0]['manifest_sha256'],
          'expected_id': row['provider_tmdb_id'], 'expected_poster': row['poster_url'],
          'expected_metadata': row['metadata'], 'poster': old['poster_url']})
    full.save(ROOT / 'before.private.json', [by_key[(c['item_type'], c['identity_key'])] for c in changes])
    full.save(file, changes)
    return changes


def statement(changes, qa=False):
    rows = [{**c, 'release_id': QA_RELEASE} if qa else c for c in changes]
    payload = json.dumps(rows, ensure_ascii=False).replace("'", "''")
    seed = """update public.selection_shared_titles set provider_tmdb_id=c->>'expected_id',
      poster_url=c->>'expected_poster',metadata=c->'expected_metadata'
      where release_id=(c->>'release_id')::uuid and item_type=c->>'item_type' and identity_key=c->>'identity_key';""" if qa else ''
    return """begin;set local lock_timeout='3s';set local request.jwt.claim.role='service_role';
    do $restore$ declare c jsonb; t public.selection_shared_titles; released uuid; owner_id uuid; n int:=0;
    begin
      if to_regprocedure('public.norva_selection_preferred_editorial_image(text,text)') is null then
        raise exception 'Install and validate official artwork preference first'; end if;
      for c in select value from jsonb_array_elements('""" + payload + """'::jsonb) loop
        released:=(c->>'release_id')::uuid;
        perform 1 from public.selection_shared_releases where id=released and published_at is not null
          and manifest_sha256=c->>'manifest' for update;
        if not found then raise exception 'Published manifest changed'; end if;
        """ + seed + """
        select * into t from public.selection_shared_titles where release_id=released
          and item_type=c->>'item_type' and identity_key=c->>'identity_key' for update;
        if t.title is distinct from c->>'title' or t.provider_tmdb_id is distinct from c->>'expected_id'
          or t.poster_url is distinct from c->>'expected_poster' or t.metadata is distinct from c->'expected_metadata'
          then raise exception 'Live artwork compare-and-swap changed'; end if;
        update public.selection_shared_titles set poster_url=c->>'poster'
          where release_id=released and item_type=t.item_type and identity_key=t.identity_key;
        n:=n+1;
      end loop;
      if n>0 then
        update public.selection_shared_releases set editorial_updated_at=clock_timestamp() where id=released;
        for owner_id in select distinct user_id from public.selection_shared_visible_enrollments where release_id=released loop
          perform public.norva_bump_user_catalog_visibility_epoch(owner_id);
          delete from public.cloud_catalog_facet_summary where user_id=owner_id;
        end loop;
      end if;
      raise notice 'PASS: % exact same-ID artwork restorations',n;
    end $restore$;
    """ + ('rollback;' if qa else 'commit;')


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--qa', action='store_true')
    parser.add_argument('--apply', action='store_true'); args = parser.parse_args()
    if (ROOT / 'applied.safe.json').exists():
        print('Completed live artwork receipt exists'); return
    changes = plan(); summary = {'changes': len(changes), 'planSha256': audit.digest(changes)}
    if args.qa:
        r = subprocess.run(['docker', 'exec', '-i', 'norva-db', 'psql', '-X', '-q', '-At',
          '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', QA_DATABASE],
          input=statement(changes, qa=True), text=True, capture_output=True, timeout=90)
        if r.returncode:
            raise RuntimeError(r.stderr[-2000:])
        full.save(ROOT / 'qa.safe.json', {**summary, 'passed': True, 'rollback': True})
    elif args.apply:
        proof = json.loads((ROOT / 'qa.safe.json').read_text())
        assert proof['passed'] and proof['planSha256'] == summary['planSha256']
        full.save(ROOT / 'before-files.safe.json', repair.immutable())
        audit.sql(statement(changes))
        assert repair.immutable() == json.loads((ROOT / 'before-files.safe.json').read_text())
        full.save(ROOT / 'applied.safe.json', {**summary, 'at': time.time()})
    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()
