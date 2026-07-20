'use strict';

const LANGUAGE_RE = /^[a-z]{2,3}$/;
const POLICY_VERSION = 'lid-cascade-v1';
const PROTOCOL_VERSION = 2;
const ROUTES = Object.freeze([
    'fast-consensus',
    'whisper-tiebreak',
    'full-transcript-fallback',
    'pending-no-speech',
    'pending-disagreement',
]);

function canonicalLanguage(value) {
    const language = String(value || '').trim().toLowerCase();
    if (language === 'iw') return 'he';
    if (language === 'jw') return 'jv';
    return LANGUAGE_RE.test(language) ? language : null;
}

function finiteThreshold(value, min, max) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max
        ? number
        : null;
}

function calibrationFromEnv(env = process.env) {
    const revision = String(env.LID_CALIBRATION_REVISION || '')
        .replace(/[\u0000-\u001f\u007f]+/g, '')
        .trim()
        .slice(0, 120);
    const ecapaMinProbability = finiteThreshold(
        env.LID_ECAPA_MIN_PROBABILITY,
        0,
        1,
    );
    const ecapaMinMargin = finiteThreshold(env.LID_ECAPA_MIN_MARGIN, 0, 1);
    const ecapaMaxEntropy = finiteThreshold(env.LID_ECAPA_MAX_ENTROPY, 0, 20);
    return Object.freeze({
        revision: revision || null,
        ecapaMinProbability,
        ecapaMinMargin,
        ecapaMaxEntropy,
        fastEligible: Boolean(
            revision
            && ecapaMinProbability !== null
            && ecapaMinMargin !== null
            && ecapaMaxEntropy !== null
        ),
    });
}

function engineLanguage(result, field) {
    if (result?.ok !== true) return null;
    return canonicalLanguage(result[field]);
}

function calibratedAgreement(ecapa, sherpa, calibration) {
    if (calibration?.fastEligible !== true) return null;
    const ecapaLanguage = engineLanguage(ecapa, 'candidateLanguage');
    const sherpaLanguage = engineLanguage(sherpa, 'lang');
    if (!ecapaLanguage || ecapaLanguage !== sherpaLanguage) return null;
    if (
        !Number.isFinite(ecapa.probability)
        || !Number.isFinite(ecapa.margin)
        || !Number.isFinite(ecapa.entropy)
        || ecapa.probability < calibration.ecapaMinProbability
        || ecapa.margin < calibration.ecapaMinMargin
        || ecapa.entropy > calibration.ecapaMaxEntropy
    ) {
        return null;
    }
    return ecapaLanguage;
}

function whisperTiebreakLanguage(
    whisper,
    ecapa,
    sherpa,
    calibration,
    minProbability = 0.95,
) {
    if (calibration?.fastEligible !== true || whisper?.ok !== true) return null;
    const language = canonicalLanguage(whisper.lang);
    const probability = Number(whisper.prob ?? whisper.probability);
    if (!language || !Number.isFinite(probability) || probability < minProbability) {
        return null;
    }
    const engineLanguages = new Set([
        engineLanguage(ecapa, 'candidateLanguage'),
        engineLanguage(sherpa, 'lang'),
    ].filter(Boolean));
    return engineLanguages.has(language) ? language : null;
}

function fullFallbackLanguage(
    whisper,
    minProbability = 0.75,
    minWords = 4,
    minUniqueWords = 2,
) {
    if (whisper?.ok !== true) return null;
    const language = canonicalLanguage(whisper.lang);
    const probability = Number(whisper.prob);
    const wordCount = Number(whisper.wordCount);
    const uniqueWordCount = Number(whisper.uniqueWordCount);
    if (
        !language
        || !Number.isFinite(probability)
        || probability < minProbability
        || !Number.isSafeInteger(wordCount)
        || wordCount < minWords
        || !Number.isSafeInteger(uniqueWordCount)
        || uniqueWordCount < minUniqueWords
    ) {
        return null;
    }
    return language;
}

function routeConfidence(route, ecapa, whisperDetectOnly, whisperFull) {
    let value = null;
    if (route === 'fast-consensus') value = ecapa?.probability;
    else if (route === 'whisper-tiebreak') {
        value = whisperDetectOnly?.prob ?? whisperDetectOnly?.probability;
    } else if (route === 'full-transcript-fallback') {
        value = whisperFull?.prob ?? whisperFull?.probability;
    }
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= 1
        ? Math.round(number * 1_000_000) / 1_000_000
        : null;
}

module.exports = {
    POLICY_VERSION,
    PROTOCOL_VERSION,
    ROUTES,
    calibratedAgreement,
    calibrationFromEnv,
    canonicalLanguage,
    finiteThreshold,
    fullFallbackLanguage,
    routeConfidence,
    whisperTiebreakLanguage,
};
