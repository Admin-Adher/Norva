export const MEDIA_LAB_PROTOCOL = 1;

export const MEDIA_LAB_FIXTURE_IDS = Object.freeze([
  "h264-closed-aac",
  "h264-closed-ac3",
  "h264-open-gop",
  "h264-multi-audio",
  "hevc-eac3-cold",
  "h264-level52",
  "h264-bad-timestamps",
  "h264-pgs",
  "h264-no-etag",
  "hevc-full-cache",
  "provider-458",
]);

const FIXTURE_IDS = new Set(MEDIA_LAB_FIXTURE_IDS);
const STATES = new Set(["idle", "busy", "running", "complete"]);
const RESULT_STATUSES = new Set(["pass", "fail", "blocked", "cancelled"]);
const PIPELINES = new Set([
  "cache-hit",
  "video-copy-audio-copy",
  "video-copy-audio-transcode",
  "video-transcode",
  "terminal-458",
]);

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeToken(value, maxLength = 80) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength &&
      /^[a-z0-9][a-z0-9._-]*$/.test(value)
    ? value
    : null;
}

function safeMetric(value, max, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) return null;
  if (integer && !Number.isInteger(value)) return null;
  return value;
}

export function isMediaLabFixtureId(value) {
  return typeof value === "string" && FIXTURE_IDS.has(value);
}

export function parseMediaLabRunRequest(value) {
  if (!exactKeys(value, ["protocol", "fixtureId"]) ||
      value.protocol !== MEDIA_LAB_PROTOCOL || !isMediaLabFixtureId(value.fixtureId)) {
    return null;
  }
  return Object.freeze({ protocol: MEDIA_LAB_PROTOCOL, fixtureId: value.fixtureId });
}

export function projectMediaLabResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.protocol !== MEDIA_LAB_PROTOCOL) return null;
  const status = RESULT_STATUSES.has(value.status) ? value.status : null;
  const reason = safeToken(value.reason);
  const pipeline = PIPELINES.has(value.pipeline) ? value.pipeline : null;
  if (!status || !reason || !pipeline) return null;

  const metrics = {
    ttffMs: safeMetric(value.ttffMs, 10 * 60 * 1_000),
    manifestReadyMs: safeMetric(value.manifestReadyMs, 10 * 60 * 1_000),
    firstSegmentMs: safeMetric(value.firstSegmentMs, 10 * 60 * 1_000),
    bufferedAheadSeconds: safeMetric(value.bufferedAheadSeconds, 3_600),
    productionRateX: safeMetric(value.productionRateX, 100),
    browserBufferRateX: safeMetric(value.browserBufferRateX, 100),
    rebufferCount: safeMetric(value.rebufferCount, 1_000, true),
    rebufferMs: safeMetric(value.rebufferMs, 10 * 60 * 1_000),
    providerGets: safeMetric(value.providerGets, 10, true),
    maximumConcurrentProviderGets: safeMetric(value.maximumConcurrentProviderGets, 10, true),
    ffmpegSpawns: safeMetric(value.ffmpegSpawns, 10, true),
    analyzerSpawns: safeMetric(value.analyzerSpawns, 10, true),
    http458: safeMetric(value.http458, 10, true),
    retriesAfter458: safeMetric(value.retriesAfter458, 10, true),
  };
  if ((status === "pass" || status === "fail") && Object.values(metrics).some((metric) => metric === null)) return null;

  return Object.freeze({
    protocol: MEDIA_LAB_PROTOCOL,
    status,
    pipeline,
    reason,
    ...metrics,
    seekPassed: value.seekPassed === true,
    audioPassed: value.audioPassed === true,
    cleanupPassed: value.cleanupPassed === true,
  });
}

export function projectMediaLabRunnerState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.protocol !== MEDIA_LAB_PROTOCOL) return null;
  const state = STATES.has(value.state) ? value.state : null;
  if (!state) return null;
  if (state === "idle" || state === "busy") return Object.freeze({ protocol: MEDIA_LAB_PROTOCOL, state });
  if (!isMediaLabFixtureId(value.fixtureId)) return null;
  if (state === "running") {
    return Object.freeze({ protocol: MEDIA_LAB_PROTOCOL, state, fixtureId: value.fixtureId });
  }
  const result = projectMediaLabResult(value.result);
  return result
    ? Object.freeze({ protocol: MEDIA_LAB_PROTOCOL, state, fixtureId: value.fixtureId, result })
    : null;
}
