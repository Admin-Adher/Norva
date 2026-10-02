"""One-off reviewed cleanup. Default: inventory only; never touches selfhost/.

Preserves the latest legacy archive and requires recent main backups plus
same-day logical replacements for each reviewed deletion. No credential output.
"""
import argparse
import datetime as dt
import json
import os
import re

BUCKET = 'norva-db-backups'
RETAIN = 'db/norva-db-20260923-083731.tar.gz.age'
DELETE = (
    'db/norva-db-20260920-083758.tar.gz.age',
    'db/norva-db-20260921-085951.tar.gz.age',
    'db/norva-db-20260922-083514.tar.gz.age',
)


def inventory(s3, prefix):
    return [obj for page in s3.get_paginator('list_objects_v2').paginate(
        Bucket=BUCKET, Prefix=prefix) for obj in page.get('Contents', [])]


def plan(s3, now):
    old = {o['Key']: o for o in inventory(s3, 'db/')}
    dumps = inventory(s3, 'selfhost/dumps/')
    bases = inventory(s3, 'selfhost/base/')
    if RETAIN not in old or old[RETAIN]['Size'] < 1_000_000_000:
        raise RuntimeError('Retained legacy archive missing or unexpectedly small')
    good_dumps = [o for o in dumps if o['Key'].endswith('.tar.gz.age') and o['Size'] >= 1_000_000_000]
    good_bases = [o for o in bases if o['Key'].endswith('/base.tar.gz') and o['Size'] >= 1_000_000_000]
    for group, minimum in [(good_dumps, 14), (good_bases, 3)]:
        if len(group) < minimum or now - max(o['LastModified'] for o in group) > dt.timedelta(hours=36):
            raise RuntimeError('Main backup coverage/freshness gate failed')
    candidates = []
    for key in DELETE:
        if key not in old:
            continue  # An already completed run is safe to repeat.
        day = key.split('norva-db-')[1][:8]
        if not any('/norva-selfhost-' + day + '-' in o['Key'] for o in good_dumps):
            raise RuntimeError('Same-day replacement missing: ' + day)
        head = s3.head_object(Bucket=BUCKET, Key=key)
        if head['ContentLength'] != old[key]['Size'] or head['ETag'] != old[key]['ETag']:
            raise RuntimeError('Object changed during inventory')
        candidates.append(old[key])
    return candidates, {'retained_legacy': RETAIN, 'logical_count': len(good_dumps), 'physical_count': len(good_bases)}


def run(s3, apply=False):
    now = dt.datetime.now(dt.timezone.utc)
    if not apply:
        # Follow-up audit: read-only accounting, including WAL upload dates.
        all_objects = inventory(s3, '')
        groups = {}
        for prefix in ('db/', 'selfhost/dumps/', 'selfhost/base/', 'selfhost/wal/'):
            objects = [o for o in all_objects if o['Key'].startswith(prefix)]
            groups[prefix] = {
                'count': len(objects), 'bytes': sum(o['Size'] for o in objects),
                'oldest_upload': min((o['LastModified'] for o in objects), default=None),
                'newest_upload': max((o['LastModified'] for o in objects), default=None),
                'older_than_3_days_count': sum(now - o['LastModified'] > dt.timedelta(days=3) for o in objects),
                'older_than_3_days_bytes': sum(o['Size'] for o in objects if now - o['LastModified'] > dt.timedelta(days=3)),
            }
        wal_objects = [o for o in all_objects if o['Key'].startswith('selfhost/wal/')]
        wal_days = {}
        history = []
        for obj in wal_objects:
            day = obj['LastModified'].date().isoformat()
            entry = wal_days.setdefault(day, {'count': 0, 'bytes': 0})
            entry['count'] += 1
            entry['bytes'] += obj['Size']
            if obj['Key'].endswith('.backup') and obj['Size'] <= 65536:
                content = s3.get_object(Bucket=BUCKET, Key=obj['Key'])['Body'].read().decode('utf-8')
                fields = {}
                for line in content.splitlines():
                    name, sep, value = line.partition(': ')
                    if sep and name in ('START WAL LOCATION', 'STOP WAL LOCATION', 'START TIME', 'STOP TIME', 'LABEL'):
                        fields[name] = value
                history.append({'key': obj['Key'], 'fields': fields})
        retained_bases = [o['Key'].split('/')[2] for o in all_objects
                          if o['Key'].startswith('selfhost/base/') and o['Key'].endswith('/base.tar.gz')]
        oldest_base = min(retained_bases, default='')
        matched = [h for h in history if h['fields'].get('LABEL') in
                   ('norva-' + oldest_base, 'norva-weekly-' + oldest_base.removeprefix('base-'))]
        before_base = None
        if len(matched) == 1:
            start = re.search(r'file ([0-9A-F]{24})', matched[0]['fields'].get('START WAL LOCATION', ''))
            if start:
                floor = start.group(1)
                obsolete = [o for o in wal_objects if re.fullmatch(r'[0-9A-F]{24}', o['Key'].split('/')[-1])
                            and o['Key'].split('/')[-1][:8] == floor[:8] and o['Key'].split('/')[-1] < floor]
                before_base = {'oldest_retained_base': oldest_base, 'start_segment': floor,
                               'count': len(obsolete), 'bytes': sum(o['Size'] for o in obsolete)}
        print(json.dumps({'read_only_storage_audit': True, 'time': now.isoformat(),
                          'bucket_bytes': sum(o['Size'] for o in all_objects),
                          'bucket_count': len(all_objects), 'groups': groups,
                          'wal_by_upload_day': wal_days, 'backup_history': history,
                          'wal_before_oldest_retained_base': before_base}, default=str))
    candidates, proof = plan(s3, now)
    result = {'time': now.isoformat(), 'apply': apply, 'proof': proof,
              'objects': [{'key': o['Key'], 'bytes': o['Size'], 'etag': o['ETag']} for o in candidates],
              'bytes': sum(o['Size'] for o in candidates)}
    # Persist the exact reviewed set BEFORE mutation; workflow uploads this manifest.
    with open('legacy-cleanup-manifest.json', 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2)
    if apply:
        for obj in candidates:
            key = obj['Key']
            if key not in DELETE or not key.startswith('db/'):
                raise RuntimeError('Deletion outside explicit allowlist')
            head = s3.head_object(Bucket=BUCKET, Key=key)
            if head['ETag'] != obj['ETag'] or head['ContentLength'] != obj['Size']:
                raise RuntimeError('Object changed before deletion')
            s3.delete_object(Bucket=BUCKET, Key=key)
        remaining = {o['Key'] for o in inventory(s3, 'db/')}
        if RETAIN not in remaining or remaining.intersection(DELETE):
            raise RuntimeError('Post-cleanup verification failed')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    import boto3
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if os.environ['R2_BUCKET'] != BUCKET:
        raise RuntimeError('Unexpected bucket')
    client = boto3.client('s3', endpoint_url='https://' + os.environ['R2_ACCOUNT_ID'] + '.r2.cloudflarestorage.com',
                          aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
                          aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'], region_name='auto')
    run(client, args.apply)
