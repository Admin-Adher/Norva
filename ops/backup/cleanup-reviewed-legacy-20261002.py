"""One-off reviewed cleanup. Default: inventory only; never touches selfhost/.

Preserves the latest legacy archive and requires recent main backups plus
same-day logical replacements for each reviewed deletion. No credential output.
"""
import argparse
import datetime as dt
import json
import os

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
