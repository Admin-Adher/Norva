'use strict';

// No provider URL, stderr or transcript leaves this classifier. Existing typed
// 458/proxy-auth/preemption errors take precedence; no new transport retry here.
function classifyCodecProbeFailure(error) {
    if (/^[A-Za-z0-9_-]{1,100}$/.test(error?.code || '') && !['ETIMEDOUT', 'ECONNRESET', 'ENOENT'].includes(error.code)) {
        return error.code;
    }
    const message = `${error?.message || ''}\n${error?.ffprobeLog || ''}`.toLowerCase();
    if (/\b(401|403)\b/.test(message)) return 'codec_probe_access_denied';
    if (/\b(404|410)\b/.test(message)) return 'codec_probe_file_unavailable';
    if (/timeout|timed out/.test(message)) return 'codec_probe_timeout';
    if (/invalid json/.test(message)) return 'codec_probe_invalid_response';
    if (/invalid data|moov atom|could not find codec|end of file/.test(message)) return 'codec_probe_invalid_media';
    if (error?.code === 'ENOENT') return 'codec_probe_runtime_unavailable';
    if (/connection|network|resolve|i\/o error|\b5\d\d\b/.test(message)) return 'codec_probe_transport_failed';
    return 'codec_probe_failed';
}

module.exports = { classifyCodecProbeFailure };
