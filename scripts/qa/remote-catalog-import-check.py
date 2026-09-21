"""Read-only authenticated catalogue checks for the allowlisted internal Lion owner.

Run on the Gateway host. Uses only Python's standard library, local Docker and
psql. Credentials, account/source UUIDs, URLs and raw catalogue payloads never
leave this process. This checks catalogue requests, not playback or import jobs.
"""
import argparse
import base64
import hashlib
import hmac
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

BASE_URL = 'http://127.0.0.1:8000/functions/v1/norva-catalog/'
PILOT_CONTAINER = 'norva-resume-cache-pilot-20260916'
EPOCH_CODE = 'CATALOG_VISIBILITY_EPOCH_CHANGED'


class CheckError(Exception):
    """Static, safe diagnostic code; never include server stderr or payloads."""


def emit(row):
    print(json.dumps(row, ensure_ascii=True), flush=True)


def container_env(container):
    result = subprocess.run(['docker', 'inspect', container], text=True,
                            capture_output=True, timeout=20, check=False)
    if result.returncode:
        raise CheckError('container_unavailable')
    try:
        raw = json.loads(result.stdout)[0]['Config']['Env']
        return dict(value.split('=', 1) for value in raw if '=' in value)
    except (KeyError, IndexError, TypeError, ValueError):
        raise CheckError('container_configuration_invalid') from None


def sql(query):
    result = subprocess.run(
        ['docker', 'exec', '-i', 'norva-db', 'psql', '-X', '-q', '-v',
         'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-At'],
        input="begin read only; set local statement_timeout='30s';\n" + query +
              '\nrollback;', text=True, capture_output=True, timeout=40, check=False)
    if result.returncode:
        raise CheckError('catalogue_scope_query_failed')
    try:
        return json.loads(result.stdout)
    except (ValueError, TypeError):
        raise CheckError('catalogue_scope_response_invalid') from None


def resolve_sources(provider=None):
    owners = container_env(PILOT_CONTAINER).get('PRIVATE_RESUME_CACHE_OWNER_HASHES', '').split(',')
    if not owners or any(not re.fullmatch(r'[0-9a-f]{64}', value) for value in owners):
        raise CheckError('pilot_allowlist_invalid')
    hashes = ','.join("'" + value + "'" for value in owners)
    rows = sql("select coalesce(json_agg(s),'[]') from (select id,user_id from "
               "public.cloud_sources where display_name='Lion' and enabled and deleted_at is null "
               "and encode(extensions.digest(user_id::text,'sha256'),'hex') in (" + hashes + ")) s;")
    if not isinstance(rows, list) or len(rows) != 1:
        raise CheckError('internal_lion_scope_ambiguous')
    try:
        owner = str(uuid.UUID(rows[0]['user_id']))
    except (KeyError, ValueError, TypeError):
        raise CheckError('internal_owner_invalid') from None
    if hashlib.sha256(owner.encode()).hexdigest() not in owners:
        raise CheckError('internal_owner_not_allowlisted')
    sources = sql("select coalesce(json_agg(s),'[]') from (select id,display_name from "
                  "public.cloud_sources where user_id='" + owner + "'::uuid "
                  "and enabled and deleted_at is null order by display_name,id) s;")
    if not isinstance(sources, list) or not sources:
        raise CheckError('no_active_catalogues')
    for source in sources:
        source['id'] = str(uuid.UUID(source['id']))
    if provider:
        sources = [source for source in sources
                   if str(source.get('display_name', '')).casefold() == provider.casefold()]
        if len(sources) != 1:
            raise CheckError('provider_scope_missing_or_ambiguous')
    return owner, sources


def source_label(source, ordinal):
    name = str(source.get('display_name', '')).strip()
    # Display names are untrusted too: do not print email/URLs/IDs supplied as names.
    if (not name or len(name) > 64 or not re.fullmatch(r'[\w .()+-]+', name, re.UNICODE)
            or re.search(r'[0-9a-f]{8}-[0-9a-f-]{27}', name, re.I)):
        return 'Provider ' + str(ordinal)
    return name


def b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def auth_headers(owner, config):
    now = int(time.time())
    head = b64(b'{"alg":"HS256","typ":"JWT"}')
    body = b64(json.dumps({'sub': owner, 'aud': 'authenticated', 'role': 'authenticated',
                           'iat': now, 'exp': now + 300}, separators=(',', ':')).encode())
    message = head + '.' + body
    token = message + '.' + b64(hmac.new(config['JWT_SECRET'].encode(),
                                        message.encode(), hashlib.sha256).digest())
    return {'Authorization': 'Bearer ' + token, 'apikey': config['SUPABASE_ANON_KEY'],
            'Cache-Control': 'no-cache'}


def get_payload(endpoint, params, headers, timeout):
    request = urllib.request.Request(BASE_URL + endpoint + '?' + urllib.parse.urlencode(params),
                                     headers=headers(), method='GET')
    try:
        response = urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read(16 * 1024 * 1024 + 1)
        if len(raw) > 16 * 1024 * 1024:
            raise CheckError('response_too_large')
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise CheckError('response_not_object')
        return response.code, data


class Campaign:
    def __init__(self, headers, attempts=4, timeout=90, page_size=36,
                 fetch=get_payload, writer=emit, sleep=time.sleep):
        self.headers, self.attempts, self.timeout = headers, attempts, timeout
        self.page_size, self.fetch, self.writer, self.sleep = page_size, fetch, writer, sleep
        self.rows = []

    def record(self, row):
        self.rows.append(row)
        self.writer(row)

    def skip(self, scope, kind, check, reason):
        self.record({'kind': 'check', 'scope': scope, 'type': kind,
                     'check': check, 'result': 'skip', 'reason': reason, 'seconds': 0})

    def request(self, scope, kind, check, endpoint, params, expected=None, require_items=False):
        started = time.monotonic()
        attempts, data, problem, status = [], None, None, None
        for attempt in range(self.attempts):
            attempt_start = time.monotonic()
            try:
                status, data = self.fetch(endpoint, params, self.headers, self.timeout)
                details = data.get('details')
                code = details.get('code') if isinstance(details, dict) else None
                entry = {'status': status, 'seconds': round(time.monotonic() - attempt_start, 3)}
                if status == 409 and code == EPOCH_CODE:
                    entry['errorCode'] = EPOCH_CODE
                attempts.append(entry)
                if status == 409 and code == EPOCH_CODE and attempt + 1 < self.attempts:
                    self.sleep((0.1, 0.3, 0.6)[min(attempt, 2)])
                    continue
                if status != 200:
                    problem = 'http_' + str(status)
                elif any(not isinstance(data.get(field), list) for field in (expected or [])):
                    problem = 'invalid_response_shape'
                elif require_items and not data.get('items'):
                    problem = 'advertised_results_missing'
            except (OSError, ValueError, CheckError, TimeoutError):
                # No exception text: network errors may contain auth-bearing URLs.
                problem = 'request_or_response_failed'
                attempts.append({'status': None, 'seconds': round(time.monotonic() - attempt_start, 3)})
            break
        row = {'kind': 'check', 'scope': scope, 'type': kind, 'check': check,
               'endpoint': endpoint, 'result': 'fail' if problem else 'pass',
               'status': status, 'seconds': round(time.monotonic() - started, 3),
               'attempts': attempts}
        if problem:
            row['reason'] = problem
        elif data is not None:
            for field in ('count', 'films'):
                if isinstance(data.get(field), (int, float)) and not isinstance(data[field], bool):
                    row[field] = data[field]
            for field in ('items', 'audio', 'subtitles', 'genres'):
                if isinstance(data.get(field), list):
                    row[field + 'Count'] = len(data[field])
            if isinstance(data.get('hasMore'), bool):
                row['hasMore'] = data['hasMore']
        self.record(row)
        return data if not problem else None

    def pages(self, label, kind, check, endpoint, params, advertised=False):
        params = dict(params, limit=self.page_size, offset=0)
        first = self.request(label, kind, check + '-page-1', endpoint, params,
                             expected=['items'], require_items=advertised)
        if first is None or not first.get('hasMore'):
            return
        # Flat grids advance by films, which can differ from version row count.
        advance = first.get('films', self.page_size) if endpoint == 'media-items' else self.page_size
        if not isinstance(advance, int) or isinstance(advance, bool) or advance <= 0:
            self.record({'kind': 'check', 'scope': label, 'type': kind, 'check': check + '-pagination',
                         'result': 'fail', 'reason': 'invalid_page_progress', 'seconds': 0})
            return
        self.request(label, kind, check + '-page-2', endpoint, dict(params, offset=advance),
                     expected=['items'], require_items=True)

    def run_scope(self, label, source_id, kind):
        base = {'type': kind, 'source': source_id}
        facets = self.request(label, kind, 'languages', 'media-language-facets', base,
                              expected=['audio', 'subtitles'])
        self.pages(label, kind, 'grid', 'media-items',
                   {'type': kind, 'sourceId': source_id, 'sort': 'default'})
        genres = self.request(label, kind, 'categories', 'media-genre-summary', base, expected=['genres'])
        if genres is not None:
            choices = [g for g in genres['genres'] if isinstance(g, dict)
                       and isinstance(g.get('count'), (int, float)) and g['count'] > 0
                       and not g.get('hidden') and re.fullmatch(r'[a-z0-9_-]{1,40}', str(g.get('bucket', '')))]
            if choices:
                choice = max(choices, key=lambda g: g['count'])
                self.pages(label, kind, 'category', 'media-genre-items',
                           dict(base, bucket=choice['bucket']), advertised=True)
            else:
                self.skip(label, kind, 'category', 'no_available_category')
        if facets is None:
            return
        for field, parameter in [('audio', 'audio'), ('subtitles', 'subs')]:
            choices = [f for f in facets[field] if isinstance(f, dict)
                       and isinstance(f.get('count'), (int, float)) and f['count'] > 0
                       and re.fullmatch(r'(?:catalog-)?[a-z]{2,8}', str(f.get('value', '')))
                       and f['value'] != 'unidentified']
            if not choices:
                self.skip(label, kind, field + '-filter', 'no_available_language')
                continue
            choice = max(choices, key=lambda f: f['count'])
            self.pages(label, kind, field + '-filter', 'media-genre-items',
                       dict(base, bucket='all', **{parameter: choice['value']}), advertised=True)

    def finish(self, started):
        failed = sum(row['result'] == 'fail' for row in self.rows)
        summary = {'kind': 'summary', 'result': 'fail' if failed else 'pass',
                   'checks': len(self.rows), 'passed': sum(r['result'] == 'pass' for r in self.rows),
                   'failed': failed, 'skipped': sum(r['result'] == 'skip' for r in self.rows),
                   'retries': sum(max(0, len(r.get('attempts', [])) - 1) for r in self.rows),
                   'seconds': round(time.monotonic() - started, 3),
                   'maxRequestSeconds': max((r['seconds'] for r in self.rows), default=0),
                   'readOnly': True}
        self.writer(summary)
        return 1 if failed else 0


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--provider', help='Exact provider display name; omit for all sources and global scope.')
    parser.add_argument('--attempts', type=int, choices=range(1, 5), default=4)
    parser.add_argument('--timeout', type=int, default=90)
    parser.add_argument('--page-size', type=int, default=36)
    parser.add_argument('--options-base64', help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.options_base64:
        try:
            options = json.loads(base64.b64decode(args.options_base64, validate=True))
            if not isinstance(options, dict) or set(options) - {'provider', 'attempts', 'timeout', 'page_size'}:
                raise ValueError()
            for key, value in options.items():
                setattr(args, key, value)
        except (ValueError, TypeError):
            raise CheckError('invalid_runner_options') from None
    if (type(args.attempts) is not int or not 1 <= args.attempts <= 4
            or type(args.timeout) is not int or not 5 <= args.timeout <= 120
            or type(args.page_size) is not int or not 1 <= args.page_size <= 120
            or args.provider is not None and (not isinstance(args.provider, str)
                                              or not 1 <= len(args.provider) <= 128)):
        raise CheckError('invalid_runner_options')
    return args


def main(argv=None):
    started = time.monotonic()
    try:
        args = parse_args(argv)
        owner, sources = resolve_sources(args.provider)
        config = container_env('norva-edge-functions')
        if not config.get('JWT_SECRET') or not config.get('SUPABASE_ANON_KEY'):
            raise CheckError('edge_auth_configuration_missing')
        campaign = Campaign(lambda: auth_headers(owner, config), args.attempts, args.timeout, args.page_size)
        scopes = ([{'id': '', 'display_name': 'All sources'}] if args.provider is None else []) + sources
        for ordinal, source in enumerate(scopes, 1):
            for kind in ('movie', 'series'):
                campaign.run_scope(source_label(source, ordinal), source['id'], kind)
        return campaign.finish(started)
    except CheckError as error:
        emit({'kind': 'summary', 'result': 'fail', 'reason': str(error), 'readOnly': True})
    except Exception:
        emit({'kind': 'summary', 'result': 'fail', 'reason': 'runner_setup_failed', 'readOnly': True})
    return 2


if __name__ == '__main__':
    sys.exit(main())
