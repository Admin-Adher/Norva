"""Fill every available official synopsis hidden by duplicate regional locales.

Reuses the completed full identity evidence. Existing populated language fields,
files, artwork and owners are preserved; exact metadata CAS still applies.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import time
from importlib.util import module_from_spec, spec_from_file_location

spec = spec_from_file_location('translations_apply', Path(__file__).with_name('apply-selection-exhaustive-20261002.py'))
apply = module_from_spec(spec); spec.loader.exec_module(apply)
full = apply.exhaustive; audit = apply.audit; ROOT = full.ROOT / 'translations'


def plan():
    inputs = json.loads((full.ROOT / 'inputs.json').read_text())
    actual = json.loads(audit.sql("select jsonb_agg(t) from selection_shared_titles t where release_id='"
      + inputs[0]['release_id'] + "' and item_type in ('movie','series');"))
    current = {(r['item_type'], r['identity_key']): r for r in actual}
    assert len(current) == len(inputs)
    changes = []; locales = Counter()
    for original in inputs:
        proof = full.final_receipt(original)
        row = {**original, **current[(original['item_type'], original['identity_key'])]}
        if proof['status'] not in ['matched', 'verified_existing']:
            continue
        assert row['provider_tmdb_id'] == proof['tmdbId']
        metadata = row['metadata']; translations = audit.official_translations(proof['details'])
        old = metadata.get('i18n') or {}; merged = dict(old); changed = False
        for lang, data in translations.items():
            if lang not in full.LANGUAGES or not data.get('overview') or (old.get(lang) or {}).get('overview'):
                continue
            merged[lang] = {**data, **old.get(lang, {})}
            merged[lang]['overview'] = data['overview']
            locales[lang] += 1; changed = True
        if not changed:
            continue
        change = apply.repair.build_change(row, proof)
        change['editorial']['i18n'] = merged
        change['editorial']['tmdb'] = dict(metadata.get('tmdb') or change['editorial']['tmdb'])
        if not change['editorial']['tmdb'].get('overview'):
            fallback = next((translations.get(lang, {}).get('overview') for lang in
              ['fr', 'en', proof['details'].get('original_language'), 'pt'] if translations.get(lang, {}).get('overview')), None)
            if fallback:
                change['editorial']['tmdb']['overview'] = fallback
        change.update({'poster': row['poster_url'], 'backdrop': row['backdrop_url'],
                       'year': row['release_year'], 'originalTitle': row['original_title']})
        apply.attach_proofs(change, row, proof); changes.append(change)
    summary = {'inventoryRows': len(inputs), 'allRowsExamined': True, 'changes': len(changes),
               'newSynopsisTranslations': sum(locales.values()), 'byLocale': dict(locales), 'planSha256': audit.digest(changes)}
    if (ROOT / 'reviewed-plan.json').exists():
        assert audit.digest(json.loads((ROOT / 'reviewed-plan.json').read_text())) == audit.digest(changes)
    else:
        full.save(ROOT / 'reviewed-plan.json', changes)
    full.save(ROOT / 'plan.safe.json', summary); print(json.dumps(summary), flush=True)
    return changes, summary


def restore_season_counts():
    """Reconcile only the public field removed by the former allowlist."""
    root = ROOT / 'fields'
    if (root / 'applied.safe.json').exists():
        return
    original = json.loads((ROOT / 'reviewed-plan.json').read_text())
    assert 'number_of_seasons' in audit.sql("select pg_get_functiondef('public.norva_selection_public_editorial_metadata(jsonb)'::regprocedure);")
    rows = json.loads(audit.sql("select jsonb_agg(t) from selection_shared_titles t where release_id='" + original[0]['releaseId'] + "';"))
    current = {(r['item_type'], r['identity_key']): r for r in rows}; changes = []
    inputs = json.loads((full.ROOT / 'inputs.json').read_text())
    by_key = {(r['item_type'], r['identity_key']): r for r in inputs}
    for old in original:
        expected = old['editorial']['tmdb'].get('number_of_seasons')
        if expected is None:
            continue
        key = (old['itemType'], old['identityKey']); row = current[key]
        proof = full.final_receipt(by_key[key])
        assert expected == proof['details']['number_of_seasons'] and row['provider_tmdb_id'] == proof['tmdbId']
        if (row['metadata'].get('tmdb') or {}).get('number_of_seasons') == expected:
            continue
        change = {**old, 'expectedMetadata': row['metadata'], 'expectedPoster': row['poster_url'],
                  'expectedId': row['provider_tmdb_id'], 'editorial': {
                    **old['editorial'], 'i18n': row['metadata'].get('i18n') or {},
                    'tmdb': {**row['metadata']['tmdb'], 'number_of_seasons': expected}}}
        changes.append(change)
    full.save(root / 'reviewed-plan.json', changes)
    before = apply.repair.immutable(); full.save(root / 'before-apply.private.json', [current[(c['itemType'], c['identityKey'])] for c in changes])
    receipts = []
    for offset in range(0, len(changes), 25):
        batch = changes[offset:offset+25]; payload = json.dumps(batch, ensure_ascii=False).replace("'", "''")
        result = json.loads(audit.sql("set request.jwt.claim.role='service_role';select norva_apply_selection_editorial_audit('"
          + batch[0]['releaseId'] + "','" + batch[0]['manifestSha256'] + "','" + payload + "'::jsonb);"))
        assert result['updatedTitles'] == len(batch); receipts.append(result)
    assert before == apply.repair.immutable()
    full.save(root / 'applied.safe.json', {'changes': len(changes), 'planSha256': audit.digest(changes),
      'receipts': receipts, 'immutable': before, 'at': time.time()})
    print(json.dumps({'restoredPublicSeasonCounts': len(changes)}), flush=True)


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--apply', action='store_true')
    parser.add_argument('--refresh-owners', action='store_true')
    parser.add_argument('--restore-season-counts', action='store_true'); args = parser.parse_args()
    if args.restore_season_counts:
        restore_season_counts(); return
    if args.refresh_owners:
        apply.previous.ROOT = ROOT; apply.previous.refresh_owners(); return
    if (ROOT / 'applied.safe.json').exists():
        print('Completed translation receipt exists'); return
    changes, summary = plan()
    if not args.apply:
        return
    assert json.loads((full.ROOT / 'sql-reassessment-proof.safe.json').read_text())['passed']
    proof = json.loads((ROOT / 'sql-proof.safe.json').read_text())
    assert proof['passed'] and proof['testedPlanSha256'] == summary['planSha256']
    before = apply.repair.immutable()
    pairs = json.dumps([{'itemType': c['itemType'], 'identityKey': c['identityKey']} for c in changes]).replace("'", "''")
    query = "select to_jsonb(t) from selection_shared_titles t join jsonb_to_recordset('" + pairs + "'::jsonb) as c(\"itemType\" text,\"identityKey\" text) on t.item_type=c.\"itemType\" and t.identity_key=c.\"identityKey\" where t.release_id='" + changes[0]['releaseId'] + "';"
    backup = ROOT / 'before-apply.private.jsonl'
    assert not backup.exists(); backup.write_text(audit.sql(query)+'\n'); backup.chmod(0o600)
    receipts = []
    for offset in range(0, len(changes), 25):
        batch = changes[offset:offset+25]; payload = json.dumps(batch, ensure_ascii=False).replace("'", "''")
        result = json.loads(audit.sql("set request.jwt.claim.role='service_role';set lock_timeout='3s';select public.norva_apply_selection_editorial_audit('"
          + batch[0]['releaseId'] + "','" + batch[0]['manifestSha256'] + "','" + payload + "'::jsonb);"))
        assert result['updatedTitles'] == len(batch)
        receipts.append(result); full.save(ROOT / 'apply-progress.safe.json', receipts)
        print(json.dumps({'done': offset+len(batch), **result}), flush=True)
    assert before == apply.repair.immutable()
    full.save(ROOT / 'applied.safe.json', {**summary, 'receipts': receipts, 'immutable': before, 'at': time.time()})


if __name__ == '__main__':
    main()
