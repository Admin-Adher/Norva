"""Measure public Selection coverage; translations and fallback are distinct.

--refresh replays the bounded common-cache maintenance before measuring. No
private owner data is fetched. Stored URLs are checked structurally, not claimed
to have all returned a successful HTTP image response.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time
import urllib.parse

ROOT = Path('/home/adrien/.norva/selection-tmdb-audit-20261002')
LANGUAGES = {'en': 'en', 'fr': 'fr', 'pt-BR': 'pt', 'es': 'es', 'hi': 'hi',
             'tr': 'tr', 'bn': 'bn', 'ar': 'ar', 'id': 'id', 'fil': 'tl'}


def sql(q):
    p = subprocess.run(['docker', 'exec', '-i', 'norva-db', 'psql', '-X', '-q', '-At',
                        '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres'],
                       input="set statement_timeout='30s';set request.jwt.claim.role='service_role';" + q,
                       text=True, capture_output=True, timeout=40)
    if p.returncode:
        raise RuntimeError(p.stderr[-1000:])
    return p.stdout.strip()


def text(value):
    return isinstance(value, str) and bool(value.strip())


def has_synopsis(row):
    md = row.get('metadata') or {}
    return any(text(v) for v in [(md.get('i18n', {}).get(k) or {}).get('overview') for k in ['fr', 'en']]
               + [(md.get('tmdb') or {}).get('overview'), md.get('overview'), md.get('plot')])


def malformed_tmdb(url):
    parsed = urllib.parse.urlsplit(url or '')
    if parsed.hostname != 'image.tmdb.org':
        return False
    parts = parsed.path.split('/')
    # TMDB also serves cropped size names, e.g. w600_and_h900_bestv2.
    return not (len(parts) == 5 and parts[1:3] == ['t', 'p'] and parts[3]
                and re.fullmatch(r'[A-Za-z0-9._-]+\.(?:jpg|png|webp)', parts[4], re.I))


def main():
    p = argparse.ArgumentParser(); p.add_argument('--refresh', action='store_true'); args = p.parse_args()
    replays = []
    if args.refresh:
        for i in range(10):
            receipt = json.loads(sql('select public.norva_refresh_selection_shared_editorial_from_cache(250);'))
            replays.append(receipt)
            if receipt['updatedTitles'] == 0:
                break
        assert replays[-1]['updatedTitles'] == 0, 'Common maintenance still has pending work'
    raw = sql("""select to_jsonb(t) from public.selection_shared_titles t where release_id=(
       select id from public.selection_shared_releases where published_at is not null order by published_at desc limit 1)
       order by item_type,identity_key;""") + '\n'
    rows = [json.loads(line) for line in raw.split('\n') if line.strip()]
    counts = []
    for item_type in ['movie', 'series']:
        group = [r for r in rows if r['item_type'] == item_type]
        missing = sum(not text(r.get('poster_url')) for r in group)
        malformed = sum(malformed_tmdb(r.get('poster_url')) for r in group)
        counts.append({'item_type': item_type, 'titles': len(group), 'missing_poster': missing,
                       'malformed_tmdb_poster': malformed, 'missing_or_malformed_poster': missing + malformed,
                       'missing_synopsis': sum(not has_synopsis(r) for r in group),
                       'missing_tmdb_id': sum(not r.get('provider_tmdb_id') for r in group)})
    languages = []
    for lang, key in LANGUAGES.items():
        localized = lambda r: text((r.get('metadata', {}).get('i18n', {}).get(key) or {}).get('overview'))
        languages.append({'lang': lang, 'movie_localized': sum(localized(r) for r in rows if r['item_type'] == 'movie'),
                          'series_localized': sum(localized(r) for r in rows if r['item_type'] == 'series')})
    result = {'at': time.time(), 'counts': counts, 'languages': languages, 'maintenanceReplays': replays,
              'publicSnapshotSha256': hashlib.sha256(raw.encode()).hexdigest()}
    (ROOT / 'final-public-titles.jsonl').write_text(raw)
    (ROOT / 'final.safe.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == '__main__':
    main()
