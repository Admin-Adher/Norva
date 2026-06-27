function sanitizeErrorMessage(value) {
    return String(value || '')
        .replace(/https?:\/\/[^\s'"<>]+/gi, '[stream URL]')
        .replace(/([?&](?:username|password|pass)=)[^&\s]+/gi, '$1[redacted]')
        .replace(/\/(live|movie|series)\/[^/\s]+\/[^/\s]+\//gi, '/$1/[user]/[password]/')
        .trim();
}

function classifyUpstreamError(value) {
    const sanitized = sanitizeErrorMessage(value);
    const text = sanitized.toLowerCase();

    if (/user[_\s-]*multi[_\s-]*ip|multi[_\s-]*ip|max(?:imum)? connections?|active connections?|connection limit|same account.*ip|account sharing/.test(text)) {
        return {
            code: 'UPSTREAM_MULTI_IP',
            upstreamStatus: 429,
            terminal: true,
            friendly: 'The provider says this IPTV account already has one active connection. Stop other playback attempts, wait 1–2 minutes for the provider slot to release, then retry from one device.',
            details: sanitized
        };
    }

    if (/429|too many requests|many requests|rate limit|ratelimit/.test(text)) {
        return {
            code: 'UPSTREAM_RATE_LIMIT',
            upstreamStatus: 429,
            terminal: true,
            friendly: 'The provider is rate limiting this stream (429 Too Many Requests). Close other players, wait a bit, then try again.',
            details: sanitized
        };
    }

    if (/401|unauthorized/.test(text)) {
        return {
            code: 'UPSTREAM_UNAUTHORIZED',
            upstreamStatus: 401,
            terminal: true,
            friendly: 'The provider refused the stream (401 Unauthorized). Your IPTV account may be blocked, expired, or limited to one connection.',
            details: sanitized
        };
    }

    if (/403|forbidden/.test(text)) {
        return {
            code: 'UPSTREAM_FORBIDDEN',
            upstreamStatus: 403,
            terminal: true,
            friendly: 'Access denied by the provider (403).',
            details: sanitized
        };
    }

    if (/404|not found/.test(text)) {
        return {
            code: 'UPSTREAM_NOT_FOUND',
            upstreamStatus: 404,
            terminal: true,
            friendly: 'Stream not found on the provider (404). This title may have been removed.',
            details: sanitized
        };
    }

    if (/416|requested range not satisfiable|range not satisfiable/.test(text)) {
        return {
            code: 'UPSTREAM_RANGE_REJECTED',
            upstreamStatus: 416,
            terminal: true,
            friendly: 'The provider refused the requested resume/seek position. Restart from the beginning or try another version.',
            details: sanitized
        };
    }

    if (/5\d\d|5xx server error|service unavailable|server error reply/.test(text)) {
        return {
            code: 'UPSTREAM_UNAVAILABLE',
            upstreamStatus: 503,
            terminal: true,
            friendly: 'The provider is temporarily unavailable for this stream. Try another version or retry in a moment.',
            details: sanitized
        };
    }

    if (/file ended prematurely|output file is empty|nothing was encoded|received no packets|cannot determine format/.test(text)) {
        return {
            code: 'UPSTREAM_UNAVAILABLE',
            upstreamStatus: null,
            terminal: true,
            friendly: 'The provider returned an incomplete stream at this position. Try a nearby timestamp or another version.',
            details: sanitized
        };
    }

    if (/4xx client error|error opening input|invalid data|stream ends prematurely|i\/o error|connection reset|connection refused/.test(text)) {
        return {
            code: 'UPSTREAM_REFUSED',
            upstreamStatus: null,
            terminal: true,
            friendly: 'The provider closed or refused this stream. Try another version or wait before retrying.',
            details: sanitized
        };
    }

    return {
        code: 'UPSTREAM_ERROR',
        upstreamStatus: null,
        terminal: false,
        friendly: 'Playback failed.',
        details: sanitized
    };
}

function normalizeUpstreamError(value) {
    const raw = value && value.message ? value.message : value;
    return classifyUpstreamError(raw);
}

module.exports = {
    classifyUpstreamError,
    normalizeUpstreamError,
    sanitizeErrorMessage
};
