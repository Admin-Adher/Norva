const crypto = require('crypto');

const STRICT_LID_WINDOW_CHECKPOINT_PROTOCOL = 1;
const STRICT_LID_WINDOW_ENVELOPE_PROTOCOL = 1;
const STRICT_LID_WINDOW_RECEIPT_TTL_MS = 2 * 60 * 60 * 1000;
const STRICT_LID_WINDOW_RECEIPT_MAX_CHARS = 96 * 1024;
const STRICT_LID_WINDOW_RECEIPT_MAX_COUNT = 6;
const STRICT_LID_WINDOW_RECEIPTS_MAX_CHARS = (
    STRICT_LID_WINDOW_RECEIPT_MAX_CHARS * STRICT_LID_WINDOW_RECEIPT_MAX_COUNT
);
const STRICT_LID_WINDOW_MAX_SHINGLES = 4096;
const STRICT_LID_WINDOW_METHOD = 'whisper-strict-consensus-v4';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_64_RE = /^[a-f0-9]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const DISPOSITIONS = new Set(['accepted', 'weak', 'conflict', 'insufficient']);
const EVIDENCE_BASES = new Set(['whitespace-words', 'cjk-character-bigrams', 'insufficient']);
const HKDF_SALT = Buffer.from('norva-media-gateway/strict-lid/window-checkpoint/salt/v1', 'utf8');
const HKDF_INFO = Buffer.from('norva-media-gateway/strict-lid/window-checkpoint/aes-256-gcm/v1', 'utf8');

class StrictLidWindowCheckpointError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'StrictLidWindowCheckpointError';
        this.code = code;
    }
}

function fail(code, message) {
    throw new StrictLidWindowCheckpointError(code, message);
}

function finiteNumber(value, name, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        fail('STRICT_LID_WINDOW_BINDING_INVALID', `invalid ${name}`);
    }
    return value;
}

function safeInteger(value, name, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        fail('STRICT_LID_WINDOW_BINDING_INVALID', `invalid ${name}`);
    }
    return value;
}

function normalizedOptionalLanguage(value, name) {
    if (value === null || value === undefined || value === '') return null;
    const language = String(value).toLowerCase();
    if (!/^[a-z]{2,3}$/.test(language)) {
        fail('STRICT_LID_WINDOW_EVIDENCE_INVALID', `invalid ${name}`);
    }
    return language;
}

function normalizeStrictLidWindowBinding(input = {}) {
    const jobId = String(input.jobId || '').toLowerCase();
    const profileFingerprint = String(input.profileFingerprint || '').toLowerCase();
    const userId = String(input.userId || '');
    const method = String(input.method || '');
    const configDigest = String(input.configDigest || '').toLowerCase();
    const modelDigest = String(input.modelDigest || '').toLowerCase();
    if (!UUID_RE.test(jobId)) fail('STRICT_LID_WINDOW_BINDING_INVALID', 'invalid job id');
    if (!HEX_64_RE.test(profileFingerprint)) {
        fail('STRICT_LID_WINDOW_BINDING_INVALID', 'invalid profile fingerprint');
    }
    if (!userId || userId.length > 256) fail('STRICT_LID_WINDOW_BINDING_INVALID', 'invalid user id');
    if (method !== STRICT_LID_WINDOW_METHOD) fail('STRICT_LID_WINDOW_BINDING_INVALID', 'invalid method');
    if (!HEX_64_RE.test(configDigest)) fail('STRICT_LID_WINDOW_BINDING_INVALID', 'invalid config digest');
    if (!HEX_64_RE.test(modelDigest)) fail('STRICT_LID_WINDOW_BINDING_INVALID', 'invalid model digest');
    const windowCount = safeInteger(input.windowCount, 'window count', 4, 6);
    if (![4, 6].includes(windowCount)) fail('STRICT_LID_WINDOW_BINDING_INVALID', 'invalid window count');
    const windowOrdinal = safeInteger(input.windowOrdinal, 'window ordinal', 1, windowCount);
    return Object.freeze({
        protocol: STRICT_LID_WINDOW_CHECKPOINT_PROTOCOL,
        envelopeProtocol: STRICT_LID_WINDOW_ENVELOPE_PROTOCOL,
        jobId,
        profileFingerprint,
        userId,
        trackIndex: safeInteger(input.trackIndex, 'track index', 0, 1024),
        fileSizeBytes: safeInteger(input.fileSizeBytes, 'file size', 1, Number.MAX_SAFE_INTEGER),
        durationSeconds: finiteNumber(input.durationSeconds, 'duration', Number.MIN_VALUE, 86_400),
        windowOrdinal,
        windowCount,
        offsetMilliseconds: safeInteger(input.offsetMilliseconds, 'window offset', 0, 86_400_000),
        method,
        configDigest,
        modelDigest,
    });
}

function canonicalBindingBytes(binding) {
    return Buffer.from(JSON.stringify(normalizeStrictLidWindowBinding(binding)), 'utf8');
}

function deriveWindowKey(secret) {
    const source = Buffer.from(String(secret || ''), 'utf8');
    if (source.length < 16) fail('STRICT_LID_WINDOW_KEY_INVALID', 'window receipt key unavailable');
    return Buffer.from(crypto.hkdfSync('sha256', source, HKDF_SALT, HKDF_INFO, 32));
}

function windowKeyId(key) {
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function boundedEvidenceInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 100_000) {
        fail('STRICT_LID_WINDOW_EVIDENCE_INVALID', `invalid ${name}`);
    }
    return value;
}

function normalizeStrictLidWindowEvidence(input, binding) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        fail('STRICT_LID_WINDOW_EVIDENCE_INVALID', 'invalid evidence');
    }
    const disposition = String(input.disposition || '');
    if (!DISPOSITIONS.has(disposition)) {
        fail('STRICT_LID_WINDOW_EVIDENCE_INVALID', 'invalid disposition');
    }
    const diversity = input.diversity && typeof input.diversity === 'object'
        ? input.diversity
        : {};
    const fingerprint = String(diversity.fingerprint || '').toLowerCase();
    if (!HEX_64_RE.test(fingerprint)) {
        fail('STRICT_LID_WINDOW_EVIDENCE_INVALID', 'invalid diversity fingerprint');
    }
    if (!Array.isArray(diversity.shingles) || diversity.shingles.length > STRICT_LID_WINDOW_MAX_SHINGLES) {
        fail('STRICT_LID_WINDOW_EVIDENCE_INVALID', 'invalid diversity shingles');
    }
    const shingles = diversity.shingles.map((raw) => {
        if (typeof raw !== 'string' || raw.length < 1 || raw.length > 12) {
            fail('STRICT_LID_WINDOW_EVIDENCE_INVALID', 'invalid diversity shingle');
        }
        return raw;
    });
    const result = input.result && typeof input.result === 'object' && !Array.isArray(input.result)
        ? input.result
        : {};
    if (
        result.method !== STRICT_LID_WINDOW_METHOD
        || result.verified !== false
        || result.validationStatus !== 'pending'
        || result.consensus !== 0
    ) {
        fail('STRICT_LID_WINDOW_EVIDENCE_INVALID', 'invalid strict evidence state');
    }
    const evidenceBasis = String(result.transcriptEvidenceBasis || '');
    if (!EVIDENCE_BASES.has(evidenceBasis)) {
        fail('STRICT_LID_WINDOW_EVIDENCE_INVALID', 'invalid transcript evidence basis');
    }
    const transcriptAgrees = result.transcriptAgrees;
    if (![true, false, null].includes(transcriptAgrees)) {
        fail('STRICT_LID_WINDOW_EVIDENCE_INVALID', 'invalid transcript agreement');
    }
    const offset = finiteNumber(result.offset, 'result offset', 0, 86_400);
    if (Math.round(offset * 1000) !== binding.offsetMilliseconds) {
        fail('STRICT_LID_WINDOW_EVIDENCE_INVALID', 'result offset does not match binding');
    }
    const normalizedResult = Object.freeze({
        language: normalizedOptionalLanguage(result.language, 'language'),
        candidate: normalizedOptionalLanguage(result.candidate, 'candidate'),
        confidence: finiteNumber(result.confidence, 'confidence', 0, 1),
        confident: result.confident === true,
        verified: false,
        validationStatus: 'pending',
        method: STRICT_LID_WINDOW_METHOD,
        consensus: 0,
        whisperLang: normalizedOptionalLanguage(result.whisperLang, 'whisper language'),
        transcriptLang: normalizedOptionalLanguage(result.transcriptLang, 'transcript language'),
        transcriptAgrees,
        minProbability: finiteNumber(result.minProbability, 'minimum probability', 0, 1),
        wordCount: boundedEvidenceInteger(result.wordCount, 'word count'),
        uniqueWordCount: boundedEvidenceInteger(result.uniqueWordCount, 'unique word count'),
        transcriptEvidenceBasis: evidenceBasis,
        scriptCharacterCount: boundedEvidenceInteger(result.scriptCharacterCount, 'script character count'),
        uniqueScriptCharacterCount: boundedEvidenceInteger(
            result.uniqueScriptCharacterCount,
            'unique script character count',
        ),
        uniqueScriptBigramCount: boundedEvidenceInteger(
            result.uniqueScriptBigramCount,
            'unique script bigram count',
        ),
        scriptDensity: finiteNumber(result.scriptDensity, 'script density', 0, 1),
        offset,
    });
    if (disposition === 'accepted' && (
        normalizedResult.language === null
        || normalizedResult.confident !== true
        || normalizedResult.confidence < 0.95
        || normalizedResult.wordCount < 12
        || normalizedResult.uniqueWordCount < 8
    )) {
        fail('STRICT_LID_WINDOW_EVIDENCE_INVALID', 'accepted evidence is below the strict floor');
    }
    if (disposition !== 'accepted' && (
        normalizedResult.language !== null
        || normalizedResult.confident !== false
    )) {
        fail('STRICT_LID_WINDOW_EVIDENCE_INVALID', 'non-accepted evidence cannot carry a language');
    }
    if (disposition === 'conflict' && normalizedResult.transcriptAgrees !== false) {
        fail('STRICT_LID_WINDOW_EVIDENCE_INVALID', 'conflicting evidence requires disagreement');
    }
    return Object.freeze({
        disposition,
        diversity: Object.freeze({ fingerprint, shingles: Object.freeze(shingles) }),
        result: normalizedResult,
    });
}

function encodeBase64Url(value) {
    return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value, name) {
    if (!BASE64URL_RE.test(value)) fail('STRICT_LID_WINDOW_RECEIPT_INVALID', `invalid ${name}`);
    try {
        const decoded = Buffer.from(value, 'base64url');
        if (encodeBase64Url(decoded) !== value) {
            fail('STRICT_LID_WINDOW_RECEIPT_INVALID', `invalid ${name}`);
        }
        return decoded;
    } catch (_) {
        fail('STRICT_LID_WINDOW_RECEIPT_INVALID', `invalid ${name}`);
    }
}

function createStrictLidWindowReceipt({
    secret,
    binding: rawBinding,
    evidence: rawEvidence,
    nowMs = Date.now(),
    randomBytesImpl = crypto.randomBytes,
} = {}) {
    const binding = normalizeStrictLidWindowBinding(rawBinding);
    const evidence = normalizeStrictLidWindowEvidence(rawEvidence, binding);
    const issuedAtMs = safeInteger(Math.floor(nowMs), 'issued at', 0, Number.MAX_SAFE_INTEGER);
    const expiresAtMs = issuedAtMs + STRICT_LID_WINDOW_RECEIPT_TTL_MS;
    const key = deriveWindowKey(secret);
    const kid = windowKeyId(key);
    const iv = Buffer.from(randomBytesImpl(12));
    if (iv.length !== 12) fail('STRICT_LID_WINDOW_KEY_INVALID', 'invalid receipt nonce');
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(canonicalBindingBytes(binding));
    const plaintext = Buffer.from(JSON.stringify({
        envelopeProtocol: STRICT_LID_WINDOW_ENVELOPE_PROTOCOL,
        issuedAtMs,
        expiresAtMs,
        evidence,
    }), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    plaintext.fill(0);
    const receipt = `v1.${kid}.${encodeBase64Url(iv)}.${encodeBase64Url(ciphertext)}.${encodeBase64Url(tag)}`;
    if (receipt.length > STRICT_LID_WINDOW_RECEIPT_MAX_CHARS) {
        fail('STRICT_LID_WINDOW_RECEIPT_TOO_LARGE', 'window receipt exceeds its size limit');
    }
    return receipt;
}

function openStrictLidWindowReceipt({
    secret,
    receipt,
    binding: rawBinding,
    nowMs = Date.now(),
} = {}) {
    if (typeof receipt !== 'string' || receipt.length < 16 || receipt.length > STRICT_LID_WINDOW_RECEIPT_MAX_CHARS) {
        fail('STRICT_LID_WINDOW_RECEIPT_INVALID', 'invalid window receipt');
    }
    const parts = receipt.split('.');
    if (parts.length !== 5 || parts[0] !== 'v1' || !/^[a-f0-9]{16}$/.test(parts[1])) {
        fail('STRICT_LID_WINDOW_RECEIPT_INVALID', 'invalid window receipt envelope');
    }
    const binding = normalizeStrictLidWindowBinding(rawBinding);
    const key = deriveWindowKey(secret);
    if (parts[1] !== windowKeyId(key)) {
        fail('STRICT_LID_WINDOW_RECEIPT_INCOMPATIBLE', 'window receipt key changed');
    }
    const iv = decodeBase64Url(parts[2], 'receipt nonce');
    const ciphertext = decodeBase64Url(parts[3], 'receipt ciphertext');
    const tag = decodeBase64Url(parts[4], 'receipt tag');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 2) {
        fail('STRICT_LID_WINDOW_RECEIPT_INVALID', 'invalid window receipt envelope');
    }
    let plaintext = null;
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
        decipher.setAAD(canonicalBindingBytes(binding));
        decipher.setAuthTag(tag);
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        const decoded = JSON.parse(plaintext.toString('utf8'));
        if (
            !decoded || typeof decoded !== 'object' || Array.isArray(decoded)
            || decoded.envelopeProtocol !== STRICT_LID_WINDOW_ENVELOPE_PROTOCOL
            || !Number.isSafeInteger(decoded.issuedAtMs)
            || !Number.isSafeInteger(decoded.expiresAtMs)
            || decoded.expiresAtMs - decoded.issuedAtMs !== STRICT_LID_WINDOW_RECEIPT_TTL_MS
            || decoded.issuedAtMs > Math.floor(nowMs) + 30_000
            || decoded.expiresAtMs <= Math.floor(nowMs)
        ) {
            fail('STRICT_LID_WINDOW_RECEIPT_EXPIRED', 'window receipt expired or has invalid lifetime');
        }
        return normalizeStrictLidWindowEvidence(decoded.evidence, binding);
    } catch (error) {
        if (error instanceof StrictLidWindowCheckpointError) throw error;
        fail('STRICT_LID_WINDOW_RECEIPT_INVALID', 'window receipt authentication failed');
    } finally {
        plaintext?.fill?.(0);
    }
}

function validateStrictLidWindowReceiptsInput(receipts, expectedCount) {
    if (![4, 6].includes(expectedCount) || !Array.isArray(receipts) || receipts.length !== expectedCount) {
        fail('STRICT_LID_WINDOW_RECEIPTS_INVALID', 'complete ordered window receipts are required');
    }
    let totalChars = 0;
    for (const receipt of receipts) {
        if (typeof receipt !== 'string' || receipt.length > STRICT_LID_WINDOW_RECEIPT_MAX_CHARS) {
            fail('STRICT_LID_WINDOW_RECEIPTS_INVALID', 'invalid window receipt collection');
        }
        totalChars += receipt.length;
    }
    if (totalChars > STRICT_LID_WINDOW_RECEIPTS_MAX_CHARS) {
        fail('STRICT_LID_WINDOW_RECEIPTS_INVALID', 'window receipt collection exceeds its size limit');
    }
    return Object.freeze([...receipts]);
}

module.exports = {
    STRICT_LID_WINDOW_CHECKPOINT_PROTOCOL,
    STRICT_LID_WINDOW_ENVELOPE_PROTOCOL,
    STRICT_LID_WINDOW_METHOD,
    STRICT_LID_WINDOW_RECEIPT_MAX_CHARS,
    STRICT_LID_WINDOW_RECEIPT_MAX_COUNT,
    STRICT_LID_WINDOW_RECEIPT_TTL_MS,
    StrictLidWindowCheckpointError,
    createStrictLidWindowReceipt,
    normalizeStrictLidWindowBinding,
    openStrictLidWindowReceipt,
    validateStrictLidWindowReceiptsInput,
};
