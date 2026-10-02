"""Build/apply a public editorial audit. Defaults to a plan, not database writes.

Upload beside audit-selection-tmdb-20261002.py on the host. Apply only after
the versioned SQL migration and rollback tests have succeeded. The SQL RPC
compares the exact audited inputs, locks the release and preserves file keys.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import time

spec = importlib.util.spec_from_file_location('selection_audit', Path(__file__).with_name('audit-selection-tmdb-20261002.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
ROOT = audit.ROOT


def image(path, size='w500'):
    return 'https://image.tmdb.org/t/p/' + size + path if path and path.startswith('/') else None


def usable_provider_poster(value):
    if not value or not value.startswith(('https://', 'http://')):
        return None
    if 'image.tmdb.org' in value and not audit.poster_path(value):
        return None
    return value


def build_change(row, result):
    if result['status'] not in ['matched', 'verified_existing']:
        if result['status'] != 'unresolved' or not result.get('oldRejected'):
            return None
        poster = usable_provider_poster(row['manifest_poster'])
        # A poster derived from the rejected association cannot survive as proof.
        if audit.poster_path(poster):
            poster = None
        payload = {'action': 'quarantine', 'tmdbId': None, 'evidence': 'old_id_rejected',
                   'editorial': {'tmdbValidation': {'valid': False, 'confidence': 0,
                                                  'reason': 'public_title_alias_mismatch'}},
                   'poster': poster, 'backdrop': None, 'year': audit.title_year(row['title']),
                   'originalTitle': row['title']}
    else:
        details = result['details']
        i18n = {}
        for t in (details.get('translations') or {}).get('translations', []):
            lang, data = t.get('iso_639_1'), t.get('data') or {}
            if isinstance(lang, str) and len(lang) == 2 and lang.isalpha():
                localized = {k: v.strip() for k, v in {'title': data.get('title') or data.get('name'),
                                                      'overview': data.get('overview')}.items() if isinstance(v, str) and v.strip()}
                if localized:
                    i18n[lang] = localized
        original_language = details.get('original_language')
        overview = next((v.strip() for v in [details.get('overview'), i18n.get('fr', {}).get('overview'),
                                            i18n.get('en', {}).get('overview'), i18n.get(original_language, {}).get('overview'),
                                            i18n.get('pt', {}).get('overview')]
                         if isinstance(v, str) and v.strip()), None)
        date = details.get('release_date') or details.get('first_air_date') or ''
        year = int(date[:4]) if len(date) >= 4 and date[:4].isdigit() else None
        canonical = details.get('title') or details.get('name') or row['title']
        tmdb = {k: v for k, v in {'id': details['id'], 'title': canonical,
            'original_title': details.get('original_title') or details.get('original_name'), 'overview': overview,
            'runtime': details.get('runtime'), 'vote_average': details.get('vote_average'),
            'poster_path': details.get('poster_path'), 'backdrop_path': details.get('backdrop_path'),
            'release_date': details.get('release_date'), 'first_air_date': details.get('first_air_date'),
            'genres': [g['name'] for g in details.get('genres', [])], 'status': details.get('status'),
            'matched': True, 'confidence': 1 if audit.title_year(row['title']) else 0.923}.items() if v is not None}
        validation = {'valid': True, 'title': canonical, 'year': str(year) if year else None,
                      'confidence': tmdb['confidence'], 'reason': 'poster_path_confirmed'
                      if result['evidence'] == 'source_poster_confirmed' else 'public_exact_alias_review'}
        payload = {'action': 'verified', 'tmdbId': result['tmdbId'], 'evidence': result['evidence'],
                   'editorial': {'tmdb': tmdb, 'i18n': i18n, 'tmdbValidation': validation},
                   'poster': image(details.get('poster_path')) or usable_provider_poster(row['poster_url']),
                   'backdrop': image(details.get('backdrop_path'), 'w780'), 'year': year,
                   'originalTitle': details.get('original_title') or details.get('original_name') or canonical}
    return {**payload, 'itemType': row['item_type'], 'identityKey': row['identity_key'],
            'expectedTitle': row['title'], 'expectedId': row['provider_tmdb_id'],
            'expectedPoster': row['poster_url'], 'expectedMetadata': row['metadata']}


def immutable():
    return json.loads(audit.sql("""select jsonb_build_object(
      'media',md5((select string_agg(md5(to_jsonb(m)::text),'' order by release_id,item_type,external_id) from selection_shared_media m)),
      'variants',md5((select string_agg(md5(to_jsonb(v)::text),'' order by release_id,item_type,external_id) from selection_shared_variants v)),
      'release',md5((select string_agg(md5((to_jsonb(r)-'editorial_updated_at')::text),'' order by id) from selection_shared_releases r)));"""))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    inputs = json.loads((ROOT / 'inputs.json').read_text())
    assert (ROOT / 'audit.safe.json').exists(), 'Complete the audit first'
    changes, by_release, statuses = [], {}, {}
    for row in inputs:
        file = ROOT / 'results' / (audit.digest([row['item_type'], row['identity_key']]) + '.json')
        result = json.loads(file.read_text())
        assert result['inputHash'] == audit.digest(row), 'Stale audit receipt'
        statuses[result['status']] = statuses.get(result['status'], 0) + 1
        change = build_change(row, result)
        if change:
            changes.append(change)
            by_release.setdefault((row['release_id'], row['manifest_sha256']), []).append(change)
    plan = {'at': time.time(), 'changes': changes, 'audit': statuses, 'sha256': audit.digest(changes)}
    file = ROOT / 'plan.json'; file.write_text(json.dumps(plan, ensure_ascii=False)); file.chmod(0o600)
    summary = {'apply': args.apply, 'changes': len(changes), 'verified': sum(c['action'] == 'verified' for c in changes),
               'quarantine': sum(c['action'] == 'quarantine' for c in changes), 'audit': statuses, 'planSha256': plan['sha256']}
    print(json.dumps(summary), flush=True)
    if not args.apply:
        return
    assert not (ROOT / 'applied.safe.json').exists(), 'Already applied; use the receipt'
    before = immutable()
    backup = ROOT / 'before-apply-public-titles.jsonl'
    assert not backup.exists(), 'Interrupted apply needs receipt review'
    backup.write_text(audit.sql('select to_jsonb(t) from selection_shared_titles t order by release_id,item_type,identity_key;') + '\n')
    backup.chmod(0o600)
    owned_backup = ROOT / 'before-apply-owned-editorial.jsonl'
    owned_backup.write_text(audit.sql("""select to_jsonb(t) from cloud_titles t where exists(
      select 1 from cloud_title_variants v join selection_shared_visible_enrollments e
       on e.user_id=v.user_id and e.source_id=v.source_id and e.generation_id=v.generation_id
       where v.user_id=t.user_id and v.title_id=t.id) order by t.user_id,t.id;""") + '\n')
    owned_backup.chmod(0o600)
    receipts = []
    for (release, manifest), rows in by_release.items():
        for offset in range(0, len(rows), 50):
            batch = json.dumps(rows[offset:offset + 50], ensure_ascii=False).replace("'", "''")
            q = "set request.jwt.claim.role='service_role'; set lock_timeout='3s'; select public.norva_apply_selection_editorial_audit('" + release + "'::uuid,'" + manifest + "','" + batch + "'::jsonb);"
            receipt = json.loads(audit.sql(q))
            receipts.append(receipt)
            (ROOT / 'apply-progress.safe.json').write_text(json.dumps(receipts, indent=2))
            print(json.dumps({'offset': offset, **receipt}), flush=True)
    assert immutable() == before, 'File or release manifest changed'
    summary.update({'receipts': receipts, 'immutable': before, 'finishedAt': time.time()})
    (ROOT / 'applied.safe.json').write_text(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
