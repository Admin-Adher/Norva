"""Read-only, bounded pilot evidence. No provider I/O, writes, tokens or transcripts in output."""
import datetime
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import urllib.request

ROOT = pathlib.Path('/home/adrien/.norva/strict-lid-adaptive-evidence-20260910')
SERVICE = 'norva-media-gateway'
STATES = frozenset(('queued', 'running', 'retry_wait', 'finalizing', 'completed', 'verified',
                    'failed', 'cancelled', 'pending', 'not_started'))
ERRORS = frozenset('''LANGUAGE_VALIDATION_ACCESS_REVOKED LANGUAGE_VALIDATION_ATTEMPT_LIMIT
LANGUAGE_VALIDATION_BACKGROUND_UNAVAILABLE LANGUAGE_VALIDATION_BODY_INVALID LANGUAGE_VALIDATION_CACHE_BUSY
LANGUAGE_VALIDATION_CACHE_MISMATCH LANGUAGE_VALIDATION_CACHE_REQUIRED LANGUAGE_VALIDATION_CACHE_SEED_FAILED
LANGUAGE_VALIDATION_CHECKPOINT_FAILED LANGUAGE_VALIDATION_CHECKPOINT_RESET_REQUIRED LANGUAGE_VALIDATION_CODEC_AUDIO_INVALID
LANGUAGE_VALIDATION_CODEC_PROFILE_REQUIRED LANGUAGE_VALIDATION_CONCURRENCY_LIMIT LANGUAGE_VALIDATION_CURSOR_MISMATCH
LANGUAGE_VALIDATION_DURATION_INVALID LANGUAGE_VALIDATION_DURATION_TOO_SHORT LANGUAGE_VALIDATION_FAILED
LANGUAGE_VALIDATION_FINALIZE_FAILED LANGUAGE_VALIDATION_FINALIZE_MISMATCH LANGUAGE_VALIDATION_GATEWAY_ERROR
LANGUAGE_VALIDATION_GATEWAY_RESPONSE_INVALID LANGUAGE_VALIDATION_GATEWAY_TIMEOUT LANGUAGE_VALIDATION_GATEWAY_TRANSPORT
LANGUAGE_VALIDATION_IDENTITY_CHANGED LANGUAGE_VALIDATION_IDENTITY_REQUIRED LANGUAGE_VALIDATION_JOB_BUSY
LANGUAGE_VALIDATION_JOB_INVALID LANGUAGE_VALIDATION_NO_PROGRESS_QUARANTINED LANGUAGE_VALIDATION_PLAYBACK_ACTIVE
LANGUAGE_VALIDATION_PREEMPTION_DRAIN_FAILED LANGUAGE_VALIDATION_PROFILE_CHANGED LANGUAGE_VALIDATION_PROVIDER_ATTEMPT_JOURNAL_ERROR
LANGUAGE_VALIDATION_PROVIDER_ATTEMPT_REJECTED LANGUAGE_VALIDATION_PROVIDER_INVALID LANGUAGE_VALIDATION_PROVIDER_LEASE_BUSY
LANGUAGE_VALIDATION_PROVIDER_LEASE_ERROR LANGUAGE_VALIDATION_PROVIDER_LEASE_VERIFY_ERROR LANGUAGE_VALIDATION_QUEUE_EXPIRED
LANGUAGE_VALIDATION_RATE_LIMITED LANGUAGE_VALIDATION_RETRY_LATER LANGUAGE_VALIDATION_STRICT_CONSENSUS_PENDING
LANGUAGE_VALIDATION_TASK_BUDGET_EXHAUSTED LANGUAGE_VALIDATION_TASK_FAILED LANGUAGE_VALIDATION_VIEWER_PREEMPTED
LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_FAILED LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_INVALID LANGUAGE_VALIDATION_WINDOW_CLAIMS_INVALID
LANGUAGE_VALIDATION_WINDOW_CURSOR_INVALID LANGUAGE_VALIDATION_WINDOW_RECEIPTS_INVALID LANGUAGE_VALIDATION_WINDOW_RESET_FAILED
PROFILE_CHANGED PROVIDER_BUSY PROVIDER_ACCOUNT_BUSY PROVIDER_AUTH_FAILED PROXY_AUTH_FAILED'''.split())
HEALTH_COUNTS = ('activeSessions', 'activeStrictLidBrokers', 'whisperInferenceActive',
                 'backgroundCpuProcessCount', 'rawPumpCount', 'viewerStartupReservations',
                 'viewerSessionStartupAdmissions', 'transcribeQueueDepth', 'ocrQueueDepth', 'translateQueueDepth')
HEALTH_FLAGS = ('transcribeBusy', 'ocrBusy', 'translateBusy', 'lidBenchmarkBusy', 'viewerPlaybackActiveLocally')
LOG_OUTCOMES = frozenset(('not-run', 'analyzed', 'selected', 'silence', 'no-vad-speech',
                         'insufficient-evidence', 'accepted', 'conflict', 'invalid-audio', 'failed',
                         'timed-out', 'aborted', 'preempted', 'budget-exhausted'))
QUALITY_COUNTS = ('qualityFallbackRuns', 'qualityFallbackRecoveredSamples', 'qualityFallbackConflictSamples',
                  'qualityFallbackFailures', 'qualityFallbackBudgetExhaustions')


def run(args, data=None, timeout=30):
    value = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    if value.returncode:
        raise RuntimeError('readonly_command_failed')
    return value.stdout


def require(condition):
    if not condition:
        raise RuntimeError('readonly_binding_validation_failed')


def count(value, maximum=100000):
    return value if type(value) is int and 0 <= value <= maximum else None


def timestamp(value):
    if value is None:
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.astimezone(datetime.timezone.utc).isoformat() if parsed.tzinfo else None
    except (ValueError, TypeError, AttributeError):
        return None


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def read_job(row):
    if not row.get('job'):
        return None
    require(bool(re.fullmatch(r'[a-f0-9-]{36}', row['job'])))
    # Every exact row remains internal and bound to the approved account/profile/provider.
    query = """BEGIN READ ONLY; SET LOCAL statement_timeout='10s';
SELECT jsonb_build_object('id',j.id,'uid',j.requested_by,'fingerprint',j.profile_fingerprint,
'fileSize',j.file_size_bytes,'profile',j.profile_snapshot,'indices',j.expected_audio_indices,
'trackPosition',j.next_track_position,'state',j.state,'lastError',j.error_code,'retryAt',j.retry_at,
'updatedAt',j.updated_at,'attempts',j.provider_attempt_count,'window',j.strict_lid_window_position,
'windows',j.strict_lid_window_count,'receipts',j.strict_lid_window_tokens,
'verified',j.verified_at IS NOT NULL,'quarantined',j.quarantined_at IS NOT NULL,
'cacheVerified',EXISTS(SELECT 1 FROM public.catalog_file_tracks c
 WHERE c.server_host=j.identity_key AND c.item_type=j.item_type AND c.external_id=j.external_id
 AND c.audio_lang_verified_at IS NOT NULL),
'cacheLanguages',coalesce((SELECT jsonb_agg(DISTINCT coalesce(nullif(t->>'lang',''),t->>'language'))
 FROM public.catalog_file_tracks c CROSS JOIN LATERAL jsonb_array_elements(
 CASE WHEN jsonb_typeof(c.audio_tracks)='array' THEN c.audio_tracks ELSE '[]'::jsonb END) t
 WHERE c.server_host=j.identity_key AND c.item_type=j.item_type AND c.external_id=j.external_id
 AND c.audio_lang_verified_at IS NOT NULL),'[]'::jsonb))
FROM public.catalog_file_audio_validation_jobs j
WHERE j.id=""" + literal(row['job']) + "::uuid AND j.requested_by=" + literal(row['user_id']) + "::uuid" \
        + ' AND j.profile_fingerprint=' + literal(row['fingerprint']) \
        + ' AND j.identity_key=' + literal(row['identity_key']) \
        + " AND j.item_type='movie' AND j.external_id=" + literal(row['external_id']) \
        + " AND EXISTS(SELECT 1 FROM public.admin_internal_accounts a WHERE a.user_id=j.requested_by); ROLLBACK;"
    raw = run(['docker', 'exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=on', '-i',
               'norva-db', 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres',
               '-v', 'ON_ERROR_STOP=1'], query.encode(), 20).decode().strip()
    require(bool(raw))
    return json.loads(raw)


RECEIPT_PROGRAM = r"""
const fs=require('fs'),crypto=require('crypto'),vm=require('vm');
let phase='input';
function main(){
const input=JSON.parse(fs.readFileSync(0,'utf8'));
phase='source-hashes';
for(const [name,expected] of Object.entries(input.sourceHashes)){
 if(!/^[a-z0-9.-]+\.js$/.test(name))throw Error('source');
 const raw=fs.readFileSync('/app/src/'+name,'utf8').replace(/\r\n/g,'\n');
 if(crypto.createHash('sha256').update(raw).digest('hex')!==expected)throw Error('source');
}
const source=fs.readFileSync('/app/src/index.js','utf8').replace(/\r\n/g,'\n');
const checkpoint=require('/app/src/strict-lid-window-checkpoint');
const {strictLidTimelineOffsets,resolveStrictLidConsensus}=require('/app/src/strict-lid-batch');
const e=input.engine;
phase='runtime-digests';
function digest(file){const value=fs.readFileSync(file,'utf8').trim().toLowerCase();
 if(!/^[a-f0-9]{64}$/.test(value))throw Error('digest');return value;}
const build={model:digest('/opt/whisper/model.sha256'),binary:digest('/opt/whisper/bin.sha256'),
 vadModel:digest('/opt/whisper/vad-model.sha256'),vadBinary:digest('/opt/whisper/vad-bin.sha256')};
if(e.runtimeVerified!==true||e.vadRuntimeVerified!==true||e.speechSamplerRuntimeVerified!==true
 ||e.strictLidSpeechSelectionProtocol!==1||e.modelSha256!==build.model||e.binarySha256!==build.binary
 ||e.vadModelSha256!==build.vadModel||e.speechSamplerBinarySha256!==build.vadBinary)throw Error('runtime');
function functionText(name){const start=source.indexOf('\nfunction '+name+'('),end=source.indexOf('\n}\n',start);
 if(start<0||end<start)throw Error('function');return source.slice(start+1,end+2);}
const context={crypto, WHISPER_MODEL_SHA256:e.modelSha256,WHISPER_MODEL_BUILD_SHA256:build.model,
 WHISPER_BIN_SHA256:e.binarySha256,WHISPER_BIN_BUILD_SHA256:build.binary,
 STRICT_LID_WINDOW_CHECKPOINT_PROTOCOL:checkpoint.STRICT_LID_WINDOW_CHECKPOINT_PROTOCOL,
 STRICT_LID_WINDOW_ENVELOPE_PROTOCOL:checkpoint.STRICT_LID_WINDOW_ENVELOPE_PROTOCOL,
 STRICT_LID_WINDOW_METHOD:checkpoint.STRICT_LID_WINDOW_METHOD,
 WHISPER_CPP_COMMIT:process.env.WHISPER_CPP_COMMIT||null,
 WHISPER_STRICT_CONSENSUS:4,STRICT_LID_SAMPLE_DURATION_CAP_SECONDS:20,
 WHISPER_VAD_BIN_SHA256:e.speechSamplerBinarySha256,WHISPER_VAD_MODEL_SHA256:e.vadModelSha256,
 WHISPER_SPEECH_SAMPLER_RUNTIME_VERIFIED:e.speechSamplerRuntimeVerified,
 process:{env:{WHISPER_STRICT_MIN_PROBABILITY:process.env.WHISPER_STRICT_MIN_PROBABILITY,
 WHISPER_STRICT_MIN_WORDS:process.env.WHISPER_STRICT_MIN_WORDS,
 WHISPER_STRICT_MIN_UNIQUE_WORDS:process.env.WHISPER_STRICT_MIN_UNIQUE_WORDS}}};
const settingsStart=source.indexOf('const WHISPER_STRICT_CONSENSUS = 4;');
const settingsEnd=source.indexOf('// Keep the complete strict Gateway request',settingsStart);
if(settingsStart<0||settingsEnd<settingsStart)throw Error('settings');
phase='runtime-binding';
// Use the actual pinned runtime settings and pure binding function, not a historical copy.
const runtime=vm.runInNewContext(functionText('clampInt')+'\n'+source.slice(settingsStart,settingsEnd)+'\n'
 +functionText('strictLidWindowRuntimeBinding')+'\nstrictLidWindowRuntimeBinding();',context,{timeout:1000});
const row=input.row,job=input.job,profile=row.profile;
phase='job-binding';
if(job.id!==row.job||job.uid!==row.user_id||job.fingerprint!==row.fingerprint
 ||Number(job.fileSize)!==Number(profile.fileSizeBytes)||!Array.isArray(job.indices)||job.indices.length!==1
 ||Number(job.indices[0])!==Number(profile.audioTracks?.[0]?.index)
 ||Number(job.profile.durationSeconds)!==Number(profile.durationSeconds))throw Error('binding');
phase='receipt-input';
// This observer may read an unfinished prefix, never finalize or certify it. Each
// individual receipt still passes the unmodified authenticated runtime opener below.
const receipts=job.receipts;
if(!Array.isArray(receipts)||receipts.length>checkpoint.STRICT_LID_WINDOW_RECEIPT_MAX_COUNT
 ||receipts.some(r=>typeof r!=='string'||r.length>checkpoint.STRICT_LID_WINDOW_RECEIPT_MAX_CHARS))throw Error('receipt');
if(receipts.length!==job.window||![4,6].includes(job.windows))throw Error('cursor');
const offsets=strictLidTimelineOffsets(Number(profile.durationSeconds),20);
if(!offsets||offsets.length!==job.windows)throw Error('windows');
const now=Date.now(),updatedAt=Date.parse(job.updatedAt);
const oldByDbAge=Number.isFinite(updatedAt)&&updatedAt+checkpoint.STRICT_LID_WINDOW_RECEIPT_TTL_MS<=now;
const allowedErrors=new Set(['STRICT_LID_WINDOW_RECEIPT_EXPIRED','STRICT_LID_WINDOW_RECEIPT_INVALID',
 'STRICT_LID_WINDOW_RECEIPT_INCOMPATIBLE','STRICT_LID_WINDOW_EVIDENCE_INVALID','STRICT_LID_WINDOW_BINDING_INVALID']);
const authenticatedEvidence=[];
const metrics=receipts.map((receipt,index)=>{
 if(oldByDbAge)return {window:index+1,status:'expired',opened:false};
 try{
  // Default Date.now() enforces the real TTL. Never backdate, decode manually, or bypass expiry.
  const evidence=checkpoint.openStrictLidWindowReceipt({secret:process.env.GATEWAY_TOKEN||process.env.NORVA_MEDIA_GATEWAY_TOKEN||'',
   receipt,binding:{jobId:job.id,profileFingerprint:job.fingerprint,userId:job.uid,
    trackIndex:Number(job.indices[0]),fileSizeBytes:Number(job.fileSize),durationSeconds:Number(profile.durationSeconds),
    windowOrdinal:index+1,windowCount:job.windows,offsetMilliseconds:Math.round(offsets[index]*1000),
    method:checkpoint.STRICT_LID_WINDOW_METHOD,configDigest:runtime.configDigest,modelDigest:runtime.modelDigest,selectionProtocol:1}});
  const r=evidence.result,s=evidence.selection;
  authenticatedEvidence.push(evidence);
  return {window:index+1,status:'authenticated',disposition:evidence.disposition,
   language:r.language,candidate:r.candidate,
   selection:s.selector==='silero-vad-max-speech-v1'?'vad':'anchor-fallback',speechMilliseconds:s.speechMilliseconds,
   wordCount:r.wordCount,uniqueWordCount:r.uniqueWordCount,probability:r.confidence,
   transcriptAgrees:r.transcriptAgrees,qualityFallbackConflict:r.qualityFallbackConflict===true};
 }catch(error){const code=allowedErrors.has(error?.code)?error.code:'RECEIPT_UNAVAILABLE';
  return {window:index+1,status:code==='STRICT_LID_WINDOW_RECEIPT_EXPIRED'?'expired':'unavailable',code};}
});
const consensus=resolveStrictLidConsensus(authenticatedEvidence,4);
return {status:'checked',metrics,consensus:{complete:authenticatedEvidence.length===job.windows,
 acceptedLanguageCount:consensus.votes.size,maxConsensus:Math.max(0,...consensus.votes.values()),
 languageVotes:[...consensus.votes].map(([language,votes])=>({language,votes})),
 repeatedEvidence:consensus.repeatedSpeechSampleCount,missingDiversity:consensus.missingDiversitySampleCount,
 rejectedConflict:consensus.rejectedSpeechSampleCount,
 wouldVerifyComplete:authenticatedEvidence.length===job.windows&&consensus.verified===true}};
}
try{process.stdout.write(JSON.stringify(main()));}catch(_){process.stdout.write(JSON.stringify({status:'runtime-or-binding-unavailable',stage:phase,metrics:[]}));}
"""


def safe_metrics(row, job, engine, hashes):
    if not job.get('receipts'):
        return {'status': 'no-current-receipts', 'metrics': []}
    require(isinstance(job['receipts'], list) and len(job['receipts']) <= 6)
    value = json.loads(run(['docker', 'exec', '-i', SERVICE, 'node', '-e', RECEIPT_PROGRAM],
                          json.dumps({'row': row, 'job': job, 'engine': engine, 'sourceHashes': hashes}).encode(), 15))
    return value


def read_global_logs():
    # Docker writes some service log lines on stderr, so collect both streams deliberately.
    result = subprocess.run(['docker', 'logs', '--since', '2026-09-10T19:46:00Z', '--tail', '4000', SERVICE],
                            capture_output=True, timeout=15)
    require(result.returncode == 0)
    counts = {key: 0 for key in sorted(LOG_OUTCOMES)}
    for line in (result.stdout + result.stderr).decode('utf-8', 'replace').splitlines():
        try:
            value = json.loads(line)
            if value.get('event') == 'strict_lid_audio_evidence' and value.get('outcome') in LOG_OUTCOMES:
                counts[value['outcome']] += 1
        except (ValueError, AttributeError):
            pass
    return {'scope': 'whole-gateway-not-attributed-to-pilot', 'since': '2026-09-10T19:46:00Z',
            'boundedLastLines': 4000, 'audioEvidenceOutcomes': counts}


def main():
    plan = json.loads((ROOT / 'pilot.private.json').read_text())
    release = json.loads((ROOT / 'candidate-1/plan.private.json').read_text())
    rows = plan['rows']
    require(plan.get('protocol') == 1 and 1 <= len(rows) <= 3)
    require([row['sample'] for row in rows] == list(range(1, len(rows) + 1)))
    require(plan.get('expectedIndexSha256') == release['candidateSources']['index.js'])
    require(len({row['identity_key'] for row in rows}) == len(rows))
    container = json.loads(run(['docker', 'inspect', SERVICE]))[0]
    env = dict(value.split('=', 1) for value in container['Config']['Env'] if '=' in value)
    ip = container['NetworkSettings']['Networks']['norva_default']['IPAddress']
    with urllib.request.urlopen('http://' + ip + ':' + env.get('PORT', '8080') + '/health', timeout=10) as response:
        health = json.load(response)
    require(health.get('ok') is True and health.get('version') == 167)
    raw = run(['docker', 'exec', SERVICE, 'cat', '/app/src/index.js'])
    require(hashlib.sha256(raw.replace(b'\r\n', b'\n')).hexdigest() == plan['expectedIndexSha256'])
    engine = health.get('languageDetectEngine') or {}
    samples = []
    for row in rows:
        job = read_job(row)
        if job is None:
            samples.append({'sample': row['sample'], 'state': 'not_started'})
            continue
        require(isinstance(job.get('receipts'), list) and len(job['receipts']) <= 6)
        receipt_proof = safe_metrics(row, job, engine, release['candidateSources'])
        metrics = receipt_proof['metrics']
        authenticated = [entry for entry in metrics if entry.get('status') == 'authenticated']
        sample = {'sample': row['sample'], 'state': job['state'] if job.get('state') in STATES else 'other',
                  'lastError': job['lastError'] if job.get('lastError') in ERRORS else ('OTHER' if job.get('lastError') else None),
                  'nextRetryAt': timestamp(job.get('retryAt')), 'updatedAt': timestamp(job.get('updatedAt')),
                  'providerAttempts': count(job.get('attempts'), 256), 'window': count(job.get('window'), 6),
                  'windows': count(job.get('windows'), 6), 'verified': job.get('verified') is True,
                  'cacheVerified': job.get('cacheVerified') is True,
                  'cacheAudioLanguages': sorted({value.lower() for value in job.get('cacheLanguages', [])
                                                if isinstance(value, str) and re.fullmatch(r'[a-zA-Z]{2,3}', value)
                                                and value.lower() != 'und'}),
                  'quarantined': job.get('quarantined') is True, 'receiptCount': len(job['receipts']),
                  'receiptStatus': receipt_proof['status'], 'authenticatedReceiptCount': len(authenticated),
                  'receiptDiagnosticStage': receipt_proof.get('stage'),
                  'consensus': receipt_proof.get('consensus'),
                  **{disposition: sum(entry['disposition'] == disposition for entry in authenticated)
                     for disposition in ('accepted', 'weak', 'insufficient', 'conflict')},
                  'selectionVad': sum(entry['selection'] == 'vad' for entry in authenticated),
                  'selectionFallback': sum(entry['selection'] == 'anchor-fallback' for entry in authenticated),
                  'expiredReceiptCount': sum(entry.get('status') == 'expired' for entry in metrics),
                  'metrics': metrics}
        samples.append(sample)
    safe_health = {'ok': True, 'version': 167,
                   **{key: count(health.get(key)) for key in HEALTH_COUNTS},
                   **{key: health.get(key) if type(health.get(key)) is bool else None for key in HEALTH_FLAGS},
                   'activeWavExtractions': count(health.get('languageWavExtraction', {}).get('active')),
                   'runtimeVerified': engine.get('runtimeVerified') is True,
                   'speechSamplerRuntimeVerified': engine.get('speechSamplerRuntimeVerified') is True}
    quality = health.get('strictLidInference') or {}
    safe_health['qualityFallback'] = {'scope': 'whole-gateway-since-restart-not-attributed-to-pilot',
                                     **{key: count(quality.get(key)) for key in QUALITY_COUNTS}}
    result = {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'readOnly': True,
              'distinctProviders': len(rows), 'samples': samples, 'health': safe_health,
              'receiptMetricsAreCurrentRetainedReceiptsOnly': True,
              'receiptExpiryNeverBypassed': True, 'globalLogs': read_global_logs()}
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'ok': False, 'error': 'readonly_proof_unavailable'}), file=sys.stderr)
        sys.exit(1)
