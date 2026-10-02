"""Audit public Selection metadata against TMDB, without writing the database.

Run on the DB host; the existing Edge credential stays in process memory.
API receipts are public movie data. Failed requests are not cached as misses.
Resume is safe: candidate inputs and each response have content hashes.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path('/home/adrien/.norva/selection-tmdb-audit-20261002')
SYNOPSIS = """coalesce(nullif(btrim(t.metadata#>>'{i18n,fr,overview}'),''),
 nullif(btrim(t.metadata#>>'{i18n,en,overview}'),''),nullif(btrim(t.metadata#>>'{tmdb,overview}'),''),
 nullif(btrim(t.metadata->>'overview'),''),nullif(btrim(t.metadata->>'plot'),''))"""


def sql(statement):
    r = subprocess.run(['docker', 'exec', '-i', 'norva-db', 'psql', '-X', '-q', '-At',
                        '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres'],
                       input="set statement_timeout='30s';" + statement,
                       text=True, capture_output=True, timeout=40)
    if r.returncode:
        raise RuntimeError(r.stderr[-2000:])
    return r.stdout.strip()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def clean_title(value):
    text = str(value or '').replace('\u2019', "'")
    text = re.sub(r'^(?:[A-Z]{2}|4K|8K)(?:-[A-Z0-9]+)*\s+[-|▎]\s+', '', text)
    # Preserve lexical subtitles, numbers and Roman sequel markers.
    text = re.sub(r'[\[({]([^\])}]*)[\])}]', lambda m: ' ' if re.fullmatch(
        r'(?:19\d{2}|20\d{2}|Telugu|Tamil|Malayalam|Hindi|Kannada|English|Multi Audio|Dubbed|HDRip|WEB.DL|1080p|720p|4K|HD)',
        m[1].strip(), re.I) else ' ' + m[1] + ' ', text)
    text = re.sub(r'\b(?:4k|uhd|2160p|1080p|720p|480p|fhd|hd|sd|hdrip|brrip|bdrip|web[ .-]?(?:dl|rip)|blu[ .-]?ray|vostfr|truefrench)\b', ' ', text, flags=re.I)
    text = re.sub(r'\s+(?:Telugu|Tamil|Malayalam|Hindi|Kannada|English)(?:\s+Dubbed)?\s*$', ' ', text, flags=re.I)
    text = re.sub(r'\s+(?:19|20)\d{2}\s*$', ' ', text)
    return ' '.join(''.join(c if c.isalnum() or c.isspace() or c == '+' else ' ' for c in text).split())


def normalized(value):
    text = clean_title(str(value or '').replace("'", '').replace('\u2019', ''))
    return ''.join(c for c in unicodedata.normalize('NFKD', text.lower()) if not unicodedata.combining(c))


def title_year(value):
    raw = str(value or '')
    hit = re.search(r'\((19\d{2}|20\d{2})\)', raw)
    if hit and hit.start() > 0:
        return int(hit[1])
    raw = re.sub(r'\b(?:Telugu|Tamil|Malayalam|Hindi|Kannada|English|Dubbed|HDRip|1080p|720p)\b', ' ', raw, flags=re.I).strip()
    hit = re.search(r'\s+(19\d{2}|20\d{2})$', raw)
    return int(hit[1]) if hit else None


def year_ok(year, details):
    date = details.get('release_date') or details.get('first_air_date') or ''
    return not year or (len(date) >= 4 and abs(year - int(date[:4])) <= 1)


def aliases(details):
    values = [details.get(k) for k in ['title', 'name', 'original_title', 'original_name']]
    values += [(t.get('data') or {}).get('title') or (t.get('data') or {}).get('name')
               for t in (details.get('translations') or {}).get('translations', [])]
    alt = details.get('alternative_titles') or {}
    values += [t.get('title') for t in alt.get('titles', []) + alt.get('results', [])]
    return [v for v in values if isinstance(v, str) and v.strip()]


def exact_match(title, details, year=None):
    return year_ok(year, details) and normalized(title) in {normalized(v) for v in aliases(details)}


def poster_path(value):
    try:
        url = urllib.parse.urlsplit(value or '')
        hit = re.fullmatch(r'/t/p/[^/]+(/[A-Za-z0-9._-]+\.(?:jpg|png|webp))', url.path)
        return hit[1] if url.hostname == 'image.tmdb.org' and hit else None
    except ValueError:
        return None


def unique_match(title, year, candidates, poster=None):
    confirmed = [d for d in candidates if poster and d.get('poster_path') == poster and year_ok(year, d)]
    if len({d['id'] for d in confirmed}) == 1:
        return confirmed[0], 'source_poster_confirmed'
    exact = [d for d in candidates if exact_match(title, d, year)]
    if len({d['id'] for d in exact}) == 1:
        return exact[0], 'unique_exact_title_year' if year else 'unique_exact_title'
    return None, 'ambiguous' if exact or len(confirmed) > 1 else 'no_exact_match'


class Tmdb:
    def __init__(self):
        # This host's IPv6 TMDB path stalls; its independently checked IPv4
        # path answers in ~135 ms. Scope the transport choice to this operator.
        resolve = socket.getaddrinfo
        socket.getaddrinfo = lambda host, port, family=0, type=0, proto=0, flags=0: resolve(
            host, port, socket.AF_INET, type, proto, flags)
        info = json.loads(subprocess.run(['docker', 'inspect', 'norva-edge-functions'],
                                        text=True, capture_output=True, check=True).stdout)[0]
        env = dict(v.split('=', 1) for v in info['Config']['Env'])
        self.key = next((env.get(k) for k in ['NORVA_TMDB_API_KEY', 'TMDB_API_KEY', 'TMDB_READ_TOKEN'] if env.get(k)), None)
        assert self.key, 'Existing TMDB credential unavailable'
        self.lock = threading.Lock()
        self.next_request = 0
        self.requests = 0
        self.cache = ROOT / 'public-api'
        self.cache.mkdir(mode=0o700, parents=True, exist_ok=True)

    def get(self, endpoint, **params):
        receipt_key = digest([endpoint, params])
        file = self.cache / (receipt_key + '.json')
        if file.exists():
            return json.loads(file.read_text())
        params = dict(params)
        headers = {'Accept': 'application/json', 'User-Agent': 'Norva-public-editorial-audit/1'}
        if self.key.startswith('eyJ'):
            headers['Authorization'] = 'Bearer ' + self.key
        else:
            params['api_key'] = self.key
        url = 'https://api.themoviedb.org/3/' + endpoint + '?' + urllib.parse.urlencode(params)
        for attempt in range(3):
            with self.lock:
                wait = max(0, self.next_request - time.monotonic())
                if wait:
                    time.sleep(wait)
                self.next_request = time.monotonic() + 0.125  # 8 rps across workers
                self.requests += 1
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=12) as r:
                    payload = json.load(r)
                file.write_text(json.dumps(payload, ensure_ascii=False))
                file.chmod(0o600)
                return payload
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return {'missing': True}
                if e.code not in [429, 500, 502, 503, 504]:
                    raise RuntimeError('TMDB HTTP ' + str(e.code)) from None
            except (TimeoutError, OSError):
                pass
            if attempt < 2:
                time.sleep(0.5 * (2 ** attempt))
        raise RuntimeError('TMDB request failed; not an authoritative miss')

    def details(self, kind, ident):
        return self.get(('tv' if kind == 'series' else 'movie') + '/' + str(ident),
                        language='en-US', append_to_response='translations,alternative_titles')

    def search(self, kind, title, year):
        results = {}
        query = clean_title(title)
        locales = ['pt-BR', 'en-US', 'fr-FR']
        for label, locale in [('Tamil', 'ta-IN'), ('Telugu', 'te-IN'), ('Hindi', 'hi-IN'), ('Malayalam', 'ml-IN'), ('Kannada', 'kn-IN')]:
            if re.search(r'\b' + label + r'\b', title, re.I):
                locales.insert(0, locale)
        for locale in dict.fromkeys(locales):
            for page in range(1, 4):
                data = self.get('search/' + ('tv' if kind == 'series' else 'movie'), query=query,
                                language=locale, include_adult='false', page=page)
                assert isinstance(data.get('results'), list), 'Invalid TMDB search'
                for result in data['results']:
                    results.setdefault(result['id'], []).append(result)
                if page >= data.get('total_pages', 1):
                    break
            # The first locale already returns all exact compact candidates,
            # including homonyms. Other locales are useful for alias rescue,
            # not for repeatedly downloading the same identity set.
            if any(exact_match(title, result, year) for versions in results.values() for result in versions):
                break
        # Fetch compact exact candidates and the first three alias candidates.
        ranked = sorted(results, key=lambda ident: (
            any(normalized(title) in {normalized(x.get('title') or x.get('name')), normalized(x.get('original_title') or x.get('original_name'))}
                and year_ok(year, x) for x in results[ident]), -list(results).index(ident)), reverse=True)
        exact_ids = [ident for ident in ranked if any(exact_match(title, x, year) for x in results[ident])]
        ids = list(dict.fromkeys(exact_ids + ranked[:3]))[:12]
        details = [self.details(kind, ident) for ident in ids]
        # Avoid choosing a film solely because a capped result set hid its homonym.
        return details, len(exact_ids) > 12


def audit_row(api, row):
    record = {'itemType': row['item_type'], 'identityKey': row['identity_key'], 'title': row['title'],
              'expectedId': row['provider_tmdb_id'], 'inputHash': digest(row)}
    try:
        year = title_year(row['title'])  # Never use a year inherited from the old TMDB match.
        old = api.details(row['item_type'], row['provider_tmdb_id']) if row['provider_tmdb_id'] else None
        if old and exact_match(row['title'], old, year):
            record.update({'status': 'verified_existing', 'tmdbId': str(old['id']), 'details': old,
                           'evidence': 'existing_id_exact_alias'})
            return record
        candidates, truncated = api.search(row['item_type'], row['title'], year)
        # Only an unassociated manifest poster is independent evidence.
        poster = poster_path(row['manifest_poster']) if not old else None
        chosen, reason = unique_match(row['title'], year, candidates, poster)
        if chosen and not truncated:
            record.update({'status': 'matched', 'tmdbId': str(chosen['id']), 'details': chosen, 'evidence': reason})
        else:
            record.update({'status': 'unresolved', 'reason': 'truncated_candidates' if truncated else reason,
                           'candidateIds': [str(d.get('id')) for d in candidates if d.get('id')],
                           'oldRejected': bool(old and not exact_match(row['title'], old, year))})
    except Exception as e:
        record.update({'status': 'request_error', 'reason': str(e)[:160] if isinstance(e, RuntimeError) else type(e).__name__})
    return record


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, default=2000)
    args = parser.parse_args()
    assert 1 <= args.limit <= 2000
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    query = """select jsonb_agg(x) from (select t.release_id,r.manifest_sha256,t.item_type,t.identity_key,
      t.title,t.provider_tmdb_id,t.poster_url,t.metadata,
      (select v.poster_url from selection_shared_variants v where v.release_id=t.release_id
       and v.item_type=t.item_type and v.identity_key=t.identity_key and v.poster_url is not null
       order by external_id limit 1) manifest_poster
      from selection_shared_titles t join selection_shared_releases r on r.id=t.release_id
      where r.published_at is not null and (t.provider_tmdb_id is null or nullif(t.poster_url,'') is null
       or """ + SYNOPSIS + """ is null or coalesce((t.metadata#>>'{tmdbValidation,confidence}')::numeric,0)<0.9)
      order by t.item_type,t.title limit """ + str(args.limit) + ') x;'
    rows = json.loads(sql(query)) or []
    input_file = ROOT / 'inputs.json'
    if input_file.exists():
        assert digest(json.loads(input_file.read_text())) == digest(rows), 'Audit input changed; use a fresh receipt directory'
    else:
        input_file.write_text(json.dumps(rows, ensure_ascii=False)); input_file.chmod(0o600)
    output = ROOT / 'results'
    output.mkdir(mode=0o700, exist_ok=True)
    api = Tmdb()
    stats = {}
    done = 0
    def worker(row):
        file = output / (digest([row['item_type'], row['identity_key']]) + '.json')
        if file.exists():
            existing = json.loads(file.read_text())
            if existing['inputHash'] == digest(row) and existing['status'] != 'request_error':
                return existing
        result = audit_row(api, row)
        file.write_text(json.dumps(result, ensure_ascii=False)); file.chmod(0o600)
        return result
    print(json.dumps({'auditOnly': True, 'candidates': len(rows)}), flush=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        for future in as_completed([pool.submit(worker, row) for row in rows]):
            result = future.result()
            stats[result['status']] = stats.get(result['status'], 0) + 1
            done += 1
            if done % 50 == 0 or done == len(rows):
                print(json.dumps({'done': done, 'requests': api.requests, 'stats': stats}), flush=True)
    (ROOT / 'audit.safe.json').write_text(json.dumps({'at': time.time(), 'candidates': len(rows), 'stats': stats, 'requests': api.requests}, indent=2))


if __name__ == '__main__':
    main()
