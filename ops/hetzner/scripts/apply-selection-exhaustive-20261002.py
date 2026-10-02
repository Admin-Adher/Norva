"""Apply useful confirmed repairs after complete inventory coverage.

Every row is examined before any application. Small SQL transactions are an
internal implementation detail, not a title limit. No file or playback changes.
"""
import argparse
from collections import Counter
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import json
import time


def module(name, filename):
    spec = spec_from_file_location(name, Path(__file__).with_name(filename))
    result = module_from_spec(spec); spec.loader.exec_module(result); return result


exhaustive = module('full_apply_audit', 'audit-selection-exhaustive-20261002.py')
repair = module('full_apply_repair', 'repair-selection-editorial-20261002.py')
previous = module('full_apply_previous', 'apply-selection-source-proofs-20261002.py')
audit = exhaustive.audit; ROOT = exhaustive.ROOT


def good_artwork(url):
    if not url:
        return False
    file = ROOT / 'artwork' / (audit.digest(url) + '.json')
    if file.exists():
        result = json.loads(file.read_text())
    else:
        result = exhaustive.check_artwork(url); exhaustive.save(file, result)
    return result['status'] == 'ok'


def candidate_poster(api, row, result):
    details = result['details']; current = row['poster_url']
    path = audit.poster_path(current)
    if row['provider_tmdb_id'] == result['tmdbId'] and good_artwork(current):
        if (path and path == details.get('poster_path')) or result.get('posterIdentity') in ['confirmed_primary_image', 'confirmed_official_image']:
            return current
        if not path and current == row.get('manifest_poster'):
            return current
        if path:
            images = api.get(('tv' if row['item_type'] == 'series' else 'movie') + '/' + result['tmdbId'] + '/images')
            if any(p.get('file_path') == path for p in images.get('posters') or []):
                return current
    proposed = repair.image(details.get('poster_path'))
    if good_artwork(proposed):
        return proposed
    images = api.get(('tv' if row['item_type'] == 'series' else 'movie') + '/' + result['tmdbId'] + '/images')
    alternatives = [p for p in images.get('posters') or [] if exhaustive.deep.previous.valid_image(p.get('file_path'))
                    and 0.5 <= p.get('aspect_ratio', 0) <= 0.8]
    alternatives.sort(key=lambda p: (p.get('iso_639_1') in [details.get('original_language'), 'en', 'pt', 'fr'],
                                     p.get('vote_count', 0), p.get('height', 0)), reverse=True)
    for p in alternatives:
        url = repair.image(p['file_path'])
        if good_artwork(url):
            details['poster_path'] = p['file_path']
            return url
    # Never retain a prior film's poster when changing its identity.
    if row['provider_tmdb_id'] != result['tmdbId']:
        return None
    return current if good_artwork(current) else None


def build_plan():
    rows = json.loads((ROOT / 'inputs.json').read_text())
    qualified = json.loads((ROOT / 'qualified.safe.json').read_text())
    assert qualified['allRowsExamined'] and qualified['rows'] == len(rows), 'Finish every title first'
    years = json.loads((ROOT / 'years.safe.json').read_text())
    assert years['allRowsExamined'] and years['rows'] == len(rows) and years['completedTasks'] == years['eligibleTasks']
    api = audit.Tmdb(); changes = []; skips = Counter(); checks = []
    for row in rows:
        r = json.loads((ROOT / 'qualified' / exhaustive.receipt(row)).read_text())
        narrowed = ROOT / 'year-review' / exhaustive.receipt(row)
        if narrowed.exists():
            n = json.loads(narrowed.read_text())
            if n['status'] in ['matched', 'verified_existing']:
                r = n
        assert r['inputHash'] == audit.digest(row) and r.get('sourceProofVersion') == 4
        if r['status'] not in ['matched', 'verified_existing']:
            skips[r.get('reason') or 'unresolved'] += 1; continue
        md = row['metadata']; plot = (md.get('tmdb') or {}).get('overview') or md.get('overview') or md.get('plot')
        available = r.get('metadataCheck') or {}; poster_status = None
        if row['poster_url']:
            f = ROOT / 'artwork' / (audit.digest(row['poster_url']) + '.json')
            assert f.exists(), 'Finish all artwork checks first'
            poster_status = json.loads(f.read_text())['status']
        needs = (row['provider_tmdb_id'] != r['tmdbId'] or not row['poster_url'] or poster_status != 'ok'
          or (audit.poster_path(row['poster_url']) and r.get('posterIdentity') not in ['confirmed_primary_image', 'confirmed_official_image']
              and audit.poster_path(row['poster_url']) != r['details'].get('poster_path'))
          or not available.get('hasFallbackSynopsis') or available.get('missingAvailableTranslations')
          or available.get('issues') or not (md.get('tmdb') or {}).get('genres'))
        if not needs:
            skips['verified_no_repair_needed'] += 1; continue
        reassessment = None
        if r['tmdbId'] in ((md.get('tmdbSearchReview') or {}).get('rejectedTmdbIds') or []):
            if r['evidence'] not in ['source_media_year_alias', 'source_series_season_alias',
                                     'source_alias_file_duration', 'source_original_provider_id']:
                skips['previous_rejection_still_needs_independent_proof'] += 1; continue
            reassessment = {'reason': 'independent_public_manifest_reassessment',
                            'previousReview': md['tmdbSearchReview'], 'sourceProofSha256': audit.digest(r)}
        change = repair.build_change(row, r)
        same = row['provider_tmdb_id'] == r['tmdbId']
        if same:
            # Keep available curated language fallbacks; official translations
            # replace only the locales that the API actually supplies.
            old_i18n = dict(md.get('i18n') or {})
            for lang, data in change['editorial']['i18n'].items():
                old_i18n[lang] = {**old_i18n.get(lang, {}), **data}
            change['editorial']['i18n'] = old_i18n
            if not change['editorial']['tmdb'].get('overview') and plot and not available.get('issues'):
                change['editorial']['tmdb']['overview'] = plot
        change['poster'] = candidate_poster(api, row, r)
        # A known broken image must not be resurrected by a catalogue coalesce.
        if row['poster_url'] and not change['poster']:
            checks.append({'title': row['title'], 'reason': 'no_verified_replacement_artwork'})
            if same:
                change['poster'] = row['poster_url']
        if r['evidence'] in ['source_media_year_alias', 'source_series_season_alias']:
            seen = set(); proof = []
            for u in r['unitProof']:
                key = audit.digest([u['provider_year'], u.get('source_unit'), u.get('provider_group')])
                if key not in seen:
                    seen.add(key); proof.append(u)
            assert len(proof) <= 40
            change['sourceUnits'] = proof
            if r['evidence'] == 'source_series_season_alias':
                change['officialSeasons'] = [{'season_number': s['season_number'], 'air_date': s.get('air_date')}
                                             for s in r['details'].get('seasons') or []]
        if r['evidence'] == 'source_alias_file_duration':
            change.update({'sourceTitleLabel': row['title'], 'expectedTargetUrl': r['expectedTargetUrl'],
                           'fileDurationSeconds': r['durationProof']['seconds']})
        if r['evidence'] == 'source_original_provider_id':
            change['originalIdUnits'] = r['originalIdUnits']
        if r['evidence'] == 'source_poster_confirmed' and r.get('originalPosterUnits'):
            change['originalPosterUnits'] = r['originalPosterUnits']
        if r['evidence'] == 'source_image_filename_exact_alias':
            change.update({'expectedManifestPoster': row['manifest_poster'],
                           'sourceImageLabel': next(v for k, v in r['aliasProof'] if k == 'image_filename')})
        if reassessment:
            change['rejectionReassessment'] = reassessment
        next_plot = change['editorial']['tmdb'].get('overview')
        useful = (not same or change['poster'] != row['poster_url']
          or not plot and next_plot or available.get('missingAvailableTranslations')
          or available.get('issues') or not (md.get('tmdb') or {}).get('genres') and change['editorial']['tmdb'].get('genres'))
        if not useful:
            skips['verified_but_no_official_metadata_available'] += 1; continue
        change.update({'releaseId': row['release_id'], 'manifestSha256': row['manifest_sha256']})
        changes.append(change)
    assert len(rows) == qualified['total']
    summary = {'inventoryRows': len(rows), 'changes': len(changes), 'skips': dict(skips),
      'newOrCorrectedIds': sum(c['expectedId'] != c['tmdbId'] for c in changes),
      'newPosters': sum(not c['expectedPoster'] and bool(c['poster']) for c in changes),
      'replacedPosters': sum(bool(c['expectedPoster']) and c['poster'] != c['expectedPoster'] for c in changes),
      'reassessments': sum(bool(c.get('rejectionReassessment')) for c in changes),
      'artworkStillUnresolved': checks, 'inputSha256': audit.digest(rows), 'planSha256': audit.digest(changes)}
    file = ROOT / 'reviewed-plan.json'
    if file.exists():
        assert audit.digest(json.loads(file.read_text())) == audit.digest(changes), 'Reviewed plan changed'
    else:
        exhaustive.save(file, changes)
    exhaustive.save(ROOT / 'plan.safe.json', summary); print(json.dumps(summary), flush=True)
    return changes, summary


def apply(changes, summary):
    assert json.loads((ROOT / 'sql-reassessment-proof.safe.json').read_text())['passed']
    definition = audit.sql("select pg_get_functiondef('public.norva_apply_selection_editorial_audit(uuid,text,jsonb)'::regprocedure);")
    assert 'independent_public_manifest_reassessment' in definition
    if (ROOT / 'applied.safe.json').exists():
        print('Use completed application receipt'); return
    before_file = ROOT / 'immutable-before.json'
    if not before_file.exists():
        exhaustive.save(before_file, repair.immutable())
    before = json.loads(before_file.read_text())
    progress = ROOT / 'apply-progress.safe.json'
    receipts = json.loads(progress.read_text()) if progress.exists() else []
    completed = sum(r['updatedTitles'] for r in receipts)
    assert completed <= len(changes) and (completed % 25 == 0 or completed == len(changes))
    backup = ROOT / 'before-apply'; backup.mkdir(mode=0o700, exist_ok=True)
    if not (backup / 'public-titles.jsonl').exists():
        pairs = json.dumps([{'itemType': c['itemType'], 'identityKey': c['identityKey']} for c in changes]).replace("'", "''")
        q = "select to_jsonb(t) from selection_shared_titles t join jsonb_to_recordset('" + pairs + "'::jsonb) as c(\"itemType\" text,\"identityKey\" text) on t.item_type=c.\"itemType\" and t.identity_key=c.\"identityKey\" where t.release_id='" + changes[0]['releaseId'] + "' order by t.item_type,t.identity_key;"
        (backup / 'public-titles.jsonl').write_text(audit.sql(q)+'\n'); (backup / 'public-titles.jsonl').chmod(0o600)
    for offset in range(completed, len(changes), 25):
        batch = changes[offset:offset+25]; payload = json.dumps(batch, ensure_ascii=False).replace("'", "''")
        r = json.loads(audit.sql("set request.jwt.claim.role='service_role';set lock_timeout='3s';select public.norva_apply_selection_editorial_audit('"
          + batch[0]['releaseId'] + "','" + batch[0]['manifestSha256'] + "','" + payload + "'::jsonb);"))
        assert r['updatedTitles'] == len(batch)
        receipts.append(r); exhaustive.save(progress, receipts); print(json.dumps({'done': offset+len(batch), **r}), flush=True)
    assert before == repair.immutable(), 'Public file inventory changed'
    exhaustive.save(ROOT / 'applied.safe.json', {**summary, 'receipts': receipts, 'immutable': before, 'at': time.time()})


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--apply', action='store_true')
    parser.add_argument('--refresh-owners', action='store_true'); args = parser.parse_args()
    if args.refresh_owners:
        previous.ROOT = ROOT; previous.refresh_owners(); return
    changes, summary = build_plan()
    if args.apply:
        apply(changes, summary)


if __name__ == '__main__':
    main()
