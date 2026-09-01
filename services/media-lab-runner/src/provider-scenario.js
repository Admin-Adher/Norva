'use strict';

const ALLOWED_STATUS_CODES = new Set([407, 408, 429, 458, 500, 502, 503, 504]);
const MAX_DELAY_MS = 60_000;
const MAX_BANDWIDTH_BYTES_PER_SECOND = 1024 * 1024 * 1024;
const MAX_DISCONNECT_AFTER_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_DISCONNECT_COUNT = 32;
const MAX_STATUS_SEQUENCE = 32;

class ProviderScenarioError extends Error {
    constructor(code) {
        super(code);
        this.name = 'ProviderScenarioError';
        this.code = code;
    }
}

function isPlainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function boundedInteger(value, field, minimum, maximum) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
        throw new ProviderScenarioError(`MEDIA_LAB_PROVIDER_SCENARIO_${field.toUpperCase()}_INVALID`);
    }
    return number;
}

function normalizeStatusSequence(value) {
    if (!Array.isArray(value) || value.length > MAX_STATUS_SEQUENCE) {
        throw new ProviderScenarioError('MEDIA_LAB_PROVIDER_SCENARIO_STATUS_SEQUENCE_INVALID');
    }
    const statuses = value.map((status) => boundedInteger(status, 'status_sequence', 100, 599));
    if (statuses.some((status) => !ALLOWED_STATUS_CODES.has(status))) {
        throw new ProviderScenarioError('MEDIA_LAB_PROVIDER_SCENARIO_STATUS_SEQUENCE_INVALID');
    }
    return Object.freeze(statuses);
}

function normalizeProviderScenario(fixtureProvider = {}, override = null) {
    if (!isPlainRecord(fixtureProvider)) {
        throw new ProviderScenarioError('MEDIA_LAB_PROVIDER_FIXTURE_SCENARIO_INVALID');
    }
    if (override !== null && !isPlainRecord(override)) {
        throw new ProviderScenarioError('MEDIA_LAB_PROVIDER_SCENARIO_INVALID');
    }
    const supportedKeys = new Set([
        'delayMs',
        'bandwidthBytesPerSecond',
        'statusSequence',
        'disconnectAfterBytes',
        'disconnectCount',
    ]);
    if (override && Object.keys(override).some((key) => !supportedKeys.has(key))) {
        throw new ProviderScenarioError('MEDIA_LAB_PROVIDER_SCENARIO_SHAPE_INVALID');
    }

    const first458 = fixtureProvider.first458 === true;
    const statusSequence = override && Object.hasOwn(override, 'statusSequence')
        ? normalizeStatusSequence(override.statusSequence)
        : Object.freeze(first458 ? [458] : []);
    const delayMs = boundedInteger(
        override?.delayMs ?? fixtureProvider.delayMs ?? 0,
        'delay_ms',
        0,
        MAX_DELAY_MS,
    );
    const bandwidthBytesPerSecond = boundedInteger(
        override?.bandwidthBytesPerSecond ?? 0,
        'bandwidth_bytes_per_second',
        0,
        MAX_BANDWIDTH_BYTES_PER_SECOND,
    );
    const disconnectAfterBytes = boundedInteger(
        override?.disconnectAfterBytes ?? 0,
        'disconnect_after_bytes',
        0,
        MAX_DISCONNECT_AFTER_BYTES,
    );
    const disconnectCount = boundedInteger(
        override?.disconnectCount ?? (disconnectAfterBytes > 0 ? 1 : 0),
        'disconnect_count',
        0,
        MAX_DISCONNECT_COUNT,
    );
    if ((disconnectAfterBytes === 0) !== (disconnectCount === 0)) {
        throw new ProviderScenarioError('MEDIA_LAB_PROVIDER_SCENARIO_DISCONNECT_INVALID');
    }

    return Object.freeze({
        protocol: 1,
        delayMs,
        bandwidthBytesPerSecond,
        statusSequence,
        disconnectAfterBytes,
        disconnectCount,
    });
}

module.exports = Object.freeze({
    ALLOWED_STATUS_CODES,
    ProviderScenarioError,
    normalizeProviderScenario,
});
