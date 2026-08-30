const path = require('path');

const VIDEO_ENCODER_PROTOCOL = 1;
const SOFTWARE_BACKEND = 'software';
const VAAPI_BACKEND = 'vaapi';
const DEFAULT_VAAPI_DEVICE = '/dev/dri/renderD128';
// Modern Mesa/AMD VAAPI drivers advertise a 128x128 minimum H.264 encode
// surface. Keep the boot preflight representative of that portable floor so a
// healthy encoder is not rejected by an obsolete 64x64 probe.
const VAAPI_PREFLIGHT_SURFACE_SIZE = 128;

function videoEncoderConfigError(code) {
    const error = new Error(`Invalid media video encoder configuration (${code})`);
    error.code = code;
    return error;
}

function resolveVideoEncoderConfig(env = process.env, fileSystem = null) {
    const rawBackend = String(env.MEDIA_GATEWAY_VIDEO_ENCODER || SOFTWARE_BACKEND)
        .trim()
        .toLowerCase();
    const backend = rawBackend === 'libx264' ? SOFTWARE_BACKEND : rawBackend;
    if (backend !== SOFTWARE_BACKEND && backend !== VAAPI_BACKEND) {
        throw videoEncoderConfigError('VIDEO_ENCODER_BACKEND_INVALID');
    }
    if (backend === SOFTWARE_BACKEND) {
        return Object.freeze({
            protocol: VIDEO_ENCODER_PROTOCOL,
            backend,
            hardware: false,
            device: null,
            preflight: 'not-required',
        });
    }

    const device = String(env.MEDIA_GATEWAY_VAAPI_DEVICE || DEFAULT_VAAPI_DEVICE).trim();
    if (!device || !path.posix.isAbsolute(device) || !device.startsWith('/dev/dri/')) {
        throw videoEncoderConfigError('VIDEO_ENCODER_VAAPI_DEVICE_INVALID');
    }
    if (fileSystem) {
        let stat;
        try {
            stat = fileSystem.statSync(device);
        } catch (_) {
            throw videoEncoderConfigError('VIDEO_ENCODER_VAAPI_DEVICE_MISSING');
        }
        if (typeof stat?.isCharacterDevice === 'function' && !stat.isCharacterDevice()) {
            throw videoEncoderConfigError('VIDEO_ENCODER_VAAPI_DEVICE_NOT_CHARACTER');
        }
    }
    return Object.freeze({
        protocol: VIDEO_ENCODER_PROTOCOL,
        backend,
        hardware: true,
        device,
        preflight: 'required',
    });
}

function preflightVideoEncoder(config, options = {}) {
    if (!config || config.backend !== VAAPI_BACKEND) {
        return Object.freeze({ ready: true, status: 'software-ready' });
    }
    const spawnSync = options.spawnSync;
    const ffmpegPath = String(options.ffmpegPath || 'ffmpeg');
    if (typeof spawnSync !== 'function') {
        throw videoEncoderConfigError('VIDEO_ENCODER_PREFLIGHT_UNAVAILABLE');
    }
    let result;
    try {
        result = spawnSync(ffmpegPath, [
            '-hide_banner',
            '-v', 'error',
            '-nostdin',
            '-y',
            '-vaapi_device', config.device,
            '-f', 'lavfi',
            '-i', `color=c=black:s=${VAAPI_PREFLIGHT_SURFACE_SIZE}x${VAAPI_PREFLIGHT_SURFACE_SIZE}:r=1`,
            '-frames:v', '1',
            '-vf', 'format=nv12,hwupload',
            '-c:v', 'h264_vaapi',
            '-f', 'null',
            '-',
        ], {
            timeout: 15_000,
            windowsHide: true,
            stdio: 'ignore',
        });
    } catch (_) {
        throw videoEncoderConfigError('VIDEO_ENCODER_VAAPI_PREFLIGHT_SPAWN_FAILED');
    }
    if (result?.error?.code === 'ETIMEDOUT') {
        throw videoEncoderConfigError('VIDEO_ENCODER_VAAPI_PREFLIGHT_TIMEOUT');
    }
    if (result?.status !== 0) {
        throw videoEncoderConfigError('VIDEO_ENCODER_VAAPI_PREFLIGHT_FAILED');
    }
    return Object.freeze({ ready: true, status: 'vaapi-ready' });
}

function videoEncoderInputArgs(config, encodeVideo) {
    if (!encodeVideo || config?.backend !== VAAPI_BACKEND) return [];
    return ['-vaapi_device', config.device];
}

function videoEncoderOutputArgs(config, options = {}) {
    const forceAligned = options.forceAligned === true;
    const targetSeconds = Number(options.targetSeconds);
    const boundedTargetSeconds = Number.isFinite(targetSeconds) && targetSeconds >= 1 && targetSeconds <= 10
        ? targetSeconds
        : 4;
    if (config?.backend === VAAPI_BACKEND) {
        // Decode stays in software for broad old-codec compatibility. Only the
        // final colorspace conversion/upload and H.264 encode use the iGPU.
        // A keyframe request at every segment boundary keeps HLS fragments
        // independently decodable without relying on scene-cut heuristics.
        return [
            '-vf', 'format=nv12,hwupload',
            '-c:v', 'h264_vaapi',
            '-profile:v', 'high',
            '-qp', '23',
            '-g', '48',
            '-bf', '0',
            '-force_key_frames', `expr:gte(t,n_forced*${boundedTargetSeconds})`,
        ];
    }
    return [
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-profile:v', 'high',
        '-pix_fmt', 'yuv420p',
        '-crf', '23',
        '-g', '48',
        '-sc_threshold', '0',
        ...(forceAligned
            ? ['-force_key_frames', `expr:gte(t,n_forced*${boundedTargetSeconds})`]
            : []),
    ];
}

function publicVideoEncoderStatus(config, preflight) {
    return {
        protocol: VIDEO_ENCODER_PROTOCOL,
        backend: config?.backend === VAAPI_BACKEND ? VAAPI_BACKEND : SOFTWARE_BACKEND,
        hardware: config?.backend === VAAPI_BACKEND,
        ready: preflight?.ready === true,
        preflight: String(preflight?.status || 'unknown'),
        deviceConfigured: config?.backend === VAAPI_BACKEND,
        decode: config?.backend === VAAPI_BACKEND ? 'software-compatible' : 'software',
        outputCodec: 'h264',
    };
}

module.exports = {
    DEFAULT_VAAPI_DEVICE,
    SOFTWARE_BACKEND,
    VAAPI_BACKEND,
    VIDEO_ENCODER_PROTOCOL,
    preflightVideoEncoder,
    publicVideoEncoderStatus,
    resolveVideoEncoderConfig,
    videoEncoderInputArgs,
    videoEncoderOutputArgs,
};
