"""Read-only, sanitized evidence for the existing bounded internal test plan.

Never prints provider URLs, credentials, catalogue/account identifiers, opaque
receipts or transcripts. No database, job, flag or container mutation.
"""
import datetime
import hashlib
import json
import pathlib
import subprocess
import urllib.request

root = pathlib.Path('/home/adrien/.norva/strict-lid-extraction-20260910')

def run(args):
    result = subprocess.run(args, capture_output=True, timeout=30)
    assert result.returncode == 0, 'Read-only evidence command failed'
    return result.stdout

plan = json.loads((root / 'batch-v2.private.json').read_text())
assert 3 <= len(plan) <= 4
providers = list(dict.fromkeys(row['identity_key'] for row in plan))
assert len(providers) == 3
status = json.loads(run(['python3', str(root / 'batch.py'), 'status']))
for row in status:
    sample = next(sample for sample in plan if sample['sample'] == row['sample'])
    row['provider'] = chr(ord('A') + providers.index(sample['identity_key']))

container = json.loads(run(['docker', 'inspect', 'norva-media-gateway']))[0]
original = json.loads((root / 'diagnostic' / 'original-inspect.private.json').read_text())
env = dict(value.split('=', 1) for value in container['Config']['Env'] if '=' in value)
ip = container['NetworkSettings']['Networks']['norva_default']['IPAddress']
health = json.load(urllib.request.urlopen('http://' + ip + ':' + env.get('PORT', '8080') + '/health', timeout=10))
health_fields = ['ok', 'version', 'activeSessions', 'activeStrictLidBrokers',
                 'whisperInferenceActive', 'backgroundCpuProcessCount', 'rawPumpCount',
                 'viewerStartupReservations', 'viewerSessionStartupAdmissions',
                 'viewerPlaybackActiveLocally', 'transcribeQueueDepth', 'transcribeBusy']
safe_health = {key: health.get(key) for key in health_fields}
safe_health['runtimeVerified'] = health.get('languageDetectEngine', {}).get('runtimeVerified')
safe_health['activeWavExtractions'] = health.get('languageWavExtraction', {}).get('active')

event_fields = {
    'strict_lid_provider_failure': ['protocol', 'mode', 'stage', 'errorType', 'errorCode', 'reason',
                                  'upstreamStatus', 'timeout', 'elapsedMs', 'progressBytes',
                                  'validatorKind', 'targetIdentityMatch'],
    'strict_lid_extraction_window': ['windowOrdinal', 'elapsedMs', 'timeoutMs', 'providerFetches', 'outcome'],
    'strict_lid_unverified': ['extractedWindowCount', 'evaluatedWindowCount', 'acceptedSampleCount',
                            'acceptedLanguageCount', 'maxConsensus', 'rejectedConflictCount',
                            'ignoredWeakCount', 'repeatedCount', 'missingDiversityCount',
                            'insufficientSpeechSampleCount', 'batchOutcome', 'pendingReason', 'verified'],
}
events = []
for revision, name in [('before-pinning', 'norva-media-gateway-lid-rollback-fix3'),
                       ('after-pinning', 'norva-media-gateway')]:
    result = subprocess.run(['docker', 'logs', '--timestamps', '--since', '2026-09-10T18:44:00Z',
                             '--tail', '4000', name], capture_output=True, timeout=15)
    assert result.returncode == 0, 'Diagnostic logs unavailable'
    for line in (result.stdout + result.stderr).decode('utf-8', 'replace').splitlines():
        try:
            timestamp, body = line.split(' ', 1)
            value = json.loads(body)
            name = value.get('event')
            if name not in event_fields:
                continue
            events.append({'revision': revision, 'at': timestamp, 'event': name,
                           **{key: value.get(key) for key in event_fields[name]}})
        except (ValueError, AttributeError):
            pass
events.sort(key=lambda event: event['at'])

source = run(['docker', 'exec', 'norva-media-gateway', 'cat', '/app/src/index.js'])
proof = {
    'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'sourceSha256Lf': hashlib.sha256(source.replace(b'\r\n', b'\n')).hexdigest(),
    'environmentMatchesInitial': sorted(original['Config']['Env']) == sorted(container['Config']['Env']),
    'distinctProviders': len(providers), 'filesAttempted': len(plan),
    'internalAccountsOnly': True, 'status': status, 'health': safe_health, 'events': events,
}
print(json.dumps(proof, indent=2))
