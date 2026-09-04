// Aggregate-only supervisor. A reachable HTTP port is not a ready LID engine.
export function strictLidHealth(db, gateway, now = Date.now()) {
  const reasons = [];
  if (!db || db.contract !== 'strict-lid-runtime:v1') reasons.push('database-health-unavailable');
  else {
    if (db.audioEnabled !== true) reasons.push('audio-lid-disabled');
    if (db.legacyEnabled !== false) reasons.push('legacy-cascade-enabled');
    if (db.workerHealthy !== true) reasons.push('validation-worker-unhealthy');
    if (Number(db.staleJobs) > 0) reasons.push('validation-jobs-stalled');
  }
  const engine = gateway?.languageDetectEngine;
  if (gateway?.ok !== true || engine?.runtimeVerified !== true ||
      gateway?.strictLidProviderDrainProtocol !== 1 ||
      gateway?.strictLidWindowCheckpointProtocol !== 1 ||
      gateway?.strictLidTranscriptDiversityProtocol !== 1 ||
      gateway?.strictLidInference?.protocol !== 1) reasons.push('strict-engine-unavailable');
  const inference = gateway?.strictLidInference;
  if (inference?.circuitOpen === true) reasons.push('vad-degraded-full-whisper-active');
  if (inference && Number(inference.lastBaselineFailureAt) > Number(inference.lastBaselineSuccessAt) &&
      now - Number(inference.lastBaselineFailureAt) < 15 * 60000) reasons.push('full-whisper-failure');
  return { contract: 'strict-lid-runtime:v1', mode: 'permanent-strict-multi-window',
    expiryRequired: false, state: reasons.length ? 'degraded' : 'ready', reasons,
    fallback: 'full-whisper-same-local-wav',
    activeJobs: Number.isSafeInteger(db?.activeJobs) ? db.activeJobs : null,
    staleJobs: Number.isSafeInteger(db?.staleJobs) ? db.staleJobs : null };
}
