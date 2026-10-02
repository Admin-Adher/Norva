"""Audit malformed public TMDB poster endpoints missed by NULL-only counts.

Reuse the same official-API alias proof and CAS writer as the main audit. An
unidentified file gets no invented poster. Requires sibling audit/repair modules.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import time


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result


audit = module('selection_empty_art_audit', 'audit-selection-tmdb-20261002.py')
repair = module('selection_empty_art_repair', 'repair-selection-editorial-20261002.py')
ROOT = audit.ROOT / 'empty-artwork'


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--apply', action='store_true'); args = parser.parse_args()
    ROOT.mkdir(mode=0o700, exist_ok=True)
    assert not args.apply or not (ROOT / 'applied.safe.json').exists(), 'Already repaired; retain receipt'
    rows = json.loads(audit.sql("""select jsonb_agg(x) from(select t.release_id,r.manifest_sha256,t.item_type,t.identity_key,
      t.title,t.provider_tmdb_id,t.poster_url,t.metadata,t.poster_url manifest_poster
      from selection_shared_titles t join selection_shared_releases r on r.id=t.release_id
      where r.published_at is not null and t.poster_url ~* '^https?://image[.]tmdb[.]org'
       and t.poster_url !~* '^https?://image[.]tmdb[.]org/t/p/[a-z0-9_-]+/[a-z0-9._-]+[.](jpg|png|webp)([?#].*)?$'
      order by t.item_type,t.identity_key)x;""")) or []
    assert len(rows) <= 100, 'Bounded supplemental audit required'
    api = audit.Tmdb(); changes, statuses = [], {}
    for row in rows:
        result = audit.audit_row(api, row)
        statuses[result['status']] = statuses.get(result['status'], 0) + 1
        assert result['status'] != 'request_error', 'No authoritative API proof'
        (ROOT / (audit.digest([row['item_type'], row['identity_key']]) + '.json')).write_text(json.dumps(result, ensure_ascii=False))
        change = repair.build_change(row, result)
        if change:
            changes.append(change)
    plan = {'at': time.time(), 'apply': args.apply, 'candidates': len(rows), 'changes': len(changes),
            'statuses': statuses, 'requests': api.requests, 'planSha256': audit.digest(changes)}
    (ROOT / 'plan.json').write_text(json.dumps(changes, ensure_ascii=False))
    (ROOT / 'summary.safe.json').write_text(json.dumps(plan, indent=2))
    print(json.dumps(plan), flush=True)
    if not args.apply or not changes:
        return
    before = repair.immutable()
    backup = ROOT / 'before-public-titles.json'; assert not backup.exists(), 'Interrupted apply requires review'
    backup.write_text(json.dumps(rows, ensure_ascii=False)); backup.chmod(0o600)
    by_release = {}
    for row in changes:
        original = next(x for x in rows if x['identity_key'] == row['identityKey'] and x['item_type'] == row['itemType'])
        by_release.setdefault((original['release_id'], original['manifest_sha256']), []).append(row)
    receipts = []
    for (release, manifest), batch in by_release.items():
        payload = json.dumps(batch, ensure_ascii=False).replace("'", "''")
        receipts.append(json.loads(audit.sql("set request.jwt.claim.role='service_role'; select public.norva_apply_selection_editorial_audit('"
             + release + "','" + manifest + "','" + payload + "'::jsonb);")))
    assert repair.immutable() == before, 'Shared files/variants changed'
    plan.update({'receipts': receipts, 'immutable': before})
    (ROOT / 'applied.safe.json').write_text(json.dumps(plan, indent=2))
    print(json.dumps(receipts))


if __name__ == '__main__':
    main()
