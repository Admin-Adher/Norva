'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_PACKETS = 1_000_000;
const H264_CLOSED_IDS = new Set([
    'h264-closed-aac',
    'h264-closed-ac3',
    'h264-multi-audio',
    'h264-pgs',
    'h264-no-etag',
]);

function verificationError(id, reason) {
    return new Error(`MEDIA_LAB_FIXTURE_VERIFICATION_FAILED:${id}:${reason}`);
}

function capture(binary, args, errorCode) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            shell: false,
        });
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let overflow = false;
        const append = (current, chunk) => {
            if (overflow) return current;
            if (current.length + chunk.length > MAX_CAPTURE_BYTES) {
                overflow = true;
                try { child.kill('SIGKILL'); } catch (_) {}
                return current;
            }
            return Buffer.concat([current, chunk]);
        };
        child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
        child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
        child.once('error', reject);
        child.once('close', (code, signal) => {
            if (overflow) {
                reject(new Error(`${errorCode}:OUTPUT_TOO_LARGE`));
                return;
            }
            if (code !== 0) {
                const detail = stderr.toString('utf8').replace(/[\r\n]+/g, ' ').slice(0, 240);
                reject(new Error(`${errorCode}:${code ?? signal}:${detail}`));
                return;
            }
            resolve(stdout.toString('utf8'));
        });
    });
}

function parseSafeInteger(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function rationalRate(value) {
    if (typeof value !== 'string') return null;
    const match = /^(\d+)\/(\d+)$/.exec(value);
    if (!match) return null;
    const numerator = Number(match[1]);
    const denominator = Number(match[2]);
    if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) return null;
    return numerator / denominator;
}

function visibleVideoStreams(streams) {
    return streams.filter((stream) => stream?.codec_type === 'video'
        && stream?.disposition?.attached_pic !== 1
        && stream?.disposition?.timed_thumbnails !== 1
        && stream?.disposition?.still_image !== 1);
}

function requireCondition(condition, id, reason) {
    if (!condition) throw verificationError(id, reason);
}

function requireVideo(video, id, expected) {
    requireCondition(video.codec_name === expected.codec, id, 'video-codec');
    if (expected.profile) requireCondition(video.profile === expected.profile, id, 'video-profile');
    if (expected.pixFmt) requireCondition(video.pix_fmt === expected.pixFmt, id, 'video-pix-fmt');
    if (expected.level !== undefined) requireCondition(video.level === expected.level, id, 'video-level');
    if (expected.width !== undefined) requireCondition(video.width === expected.width, id, 'video-width');
    if (expected.height !== undefined) requireCondition(video.height === expected.height, id, 'video-height');
    if (expected.minimumFps !== undefined) {
        const fps = rationalRate(video.avg_frame_rate) ?? rationalRate(video.r_frame_rate);
        requireCondition(fps !== null && fps >= expected.minimumFps, id, 'video-frame-rate');
    }
}

function requireAudio(audioStreams, id, expected) {
    requireCondition(audioStreams.length === expected.length, id, 'audio-count');
    expected.forEach((item, index) => {
        const actual = audioStreams[index];
        requireCondition(actual?.codec_name === item.codec, id, `audio-${index}-codec`);
        if (item.profile) requireCondition(actual.profile === item.profile, id, `audio-${index}-profile`);
        if (item.channels !== undefined) {
            requireCondition(actual.channels === item.channels, id, `audio-${index}-channels`);
        }
    });
}

function expectedShape(id) {
    const h264 = { codec: 'h264', profile: 'High', pixFmt: 'yuv420p' };
    const aac = { codec: 'aac', profile: 'LC', channels: 2 };
    switch (id) {
    case 'h264-closed-aac':
    case 'h264-open-gop':
    case 'h264-bad-timestamps':
    case 'h264-no-etag':
        return { video: { ...h264, level: 41, width: 640, height: 360 }, audio: [aac], subtitles: [] };
    case 'h264-closed-ac3':
        return {
            video: { ...h264, level: 41, width: 640, height: 360 },
            audio: [{ codec: 'ac3', channels: 6 }],
            subtitles: [],
        };
    case 'h264-multi-audio':
        return {
            video: { ...h264, level: 41, width: 640, height: 360 },
            audio: [{ codec: 'aac' }, { codec: 'ac3' }, { codec: 'aac' }],
            subtitles: [],
        };
    case 'hevc-eac3-cold':
    case 'hevc-full-cache':
        return {
            video: {
                codec: 'hevc', profile: 'Main 10', pixFmt: 'yuv420p10le', width: 1280, height: 720,
            },
            audio: [{ codec: 'eac3', channels: 6 }],
            subtitles: [],
        };
    case 'h264-level52':
        return {
            video: {
                ...h264, level: 52, width: 1920, height: 1080, minimumFps: 119,
            },
            audio: [aac],
            subtitles: [],
        };
    case 'h264-pgs':
        return {
            video: { ...h264, level: 41, width: 640, height: 360 },
            audio: [aac],
            subtitles: ['hdmv_pgs_subtitle'],
        };
    default:
        throw verificationError(id, 'unknown-fixture');
    }
}

function verifyProbeEvidence(id, probe, { idrPacketCount = null } = {}) {
    requireCondition(probe && typeof probe === 'object' && !Array.isArray(probe), id, 'probe-json');
    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    const packets = Array.isArray(probe.packets) ? probe.packets : [];
    requireCondition(packets.length > 0 && packets.length <= MAX_PACKETS, id, 'packet-count');

    const videos = visibleVideoStreams(streams);
    const audio = streams.filter((stream) => stream?.codec_type === 'audio');
    const subtitles = streams.filter((stream) => stream?.codec_type === 'subtitle');
    requireCondition(videos.length === 1, id, 'video-count');
    const video = videos[0];
    requireCondition(Number.isSafeInteger(video.index) && video.index >= 0, id, 'video-index');

    const shape = expectedShape(id);
    requireVideo(video, id, shape.video);
    requireAudio(audio, id, shape.audio);
    requireCondition(subtitles.length === shape.subtitles.length, id, 'subtitle-count');
    shape.subtitles.forEach((codec, index) => {
        requireCondition(subtitles[index]?.codec_name === codec, id, `subtitle-${index}-codec`);
    });

    const videoPackets = packets.filter((packet) => parseSafeInteger(packet?.stream_index) === video.index);
    requireCondition(videoPackets.length > 0, id, 'video-packets');
    const dtsValues = videoPackets.map((packet) => parseSafeInteger(packet.dts)).filter((value) => value !== null);
    requireCondition(dtsValues.length >= 2, id, 'video-dts');
    const firstUnsafeDtsIndex = dtsValues.findIndex((value, index) => index > 0 && value <= dtsValues[index - 1]);
    const timestampsStrict = firstUnsafeDtsIndex === -1;
    if (id === 'h264-bad-timestamps') requireCondition(!timestampsStrict, id, 'timestamp-defect-missing');
    else requireCondition(timestampsStrict, id, 'unexpected-timestamp-defect');

    const keyframeCount = videoPackets.filter((packet) => String(packet.flags || '').includes('K')).length;
    if (video.codec_name === 'h264') {
        requireCondition(Number.isSafeInteger(idrPacketCount) && idrPacketCount >= 1, id, 'idr-count');
        if (H264_CLOSED_IDS.has(id)) {
            requireCondition(keyframeCount >= 2 && keyframeCount === idrPacketCount, id, 'closed-gop');
        } else if (id === 'h264-open-gop') {
            requireCondition(keyframeCount >= 2 && idrPacketCount < keyframeCount, id, 'open-gop');
        }
    }

    return Object.freeze({
        protocol: 1,
        kind: 'norva-media-lab-fixture-attestation-v1',
        video: Object.freeze({
            codec: video.codec_name,
            profile: video.profile || null,
            level: Number.isSafeInteger(video.level) ? video.level : null,
            pixFmt: video.pix_fmt || null,
            width: video.width,
            height: video.height,
            streamIndex: video.index,
            avgFrameRate: video.avg_frame_rate || null,
        }),
        audio: Object.freeze(audio.map((stream) => Object.freeze({
            codec: stream.codec_name,
            profile: stream.profile || null,
            channels: Number.isSafeInteger(stream.channels) ? stream.channels : null,
        }))),
        subtitles: Object.freeze(subtitles.map((stream) => stream.codec_name)),
        videoPacketCount: videoPackets.length,
        keyframeCount,
        idrPacketCount: video.codec_name === 'h264' ? idrPacketCount : null,
        timestampsStrict,
        timestampDefectObserved: !timestampsStrict,
    });
}

async function probeJson(ffprobePath, filePath) {
    const stdout = await capture(ffprobePath, [
        '-v', 'error',
        '-show_streams',
        '-show_packets',
        '-show_entries',
        'stream=index,codec_type,codec_name,profile,level,pix_fmt,width,height,refs,r_frame_rate,avg_frame_rate,channels,channel_layout:stream_disposition=attached_pic,timed_thumbnails,still_image:packet=stream_index,pts,dts,flags',
        '-of', 'json',
        filePath,
    ], 'FFPROBE_FIXTURE_VERIFICATION_FAILED');
    try { return JSON.parse(stdout); } catch (_) {
        throw new Error('FFPROBE_FIXTURE_VERIFICATION_FAILED:INVALID_JSON');
    }
}

async function h264IdrPacketCount(ffmpegPath, filePath) {
    const stdout = await capture(ffmpegPath, [
        '-hide_banner', '-nostdin', '-loglevel', 'error',
        '-i', filePath,
        '-map', '0:V:0',
        '-c:v', 'copy',
        '-bsf:v', 'h264_mp4toannexb,filter_units=pass_types=5',
        '-f', 'framecrc',
        '-',
    ], 'FFMPEG_IDR_VERIFICATION_FAILED');
    return stdout.split(/\r?\n/).filter((line) => /^\s*0\s*,/.test(line)).length;
}

function inferFfprobePath(ffmpegPath) {
    const configured = String(process.env.MEDIA_LAB_FFPROBE_PATH || '').trim();
    if (configured) return configured;
    const base = path.basename(ffmpegPath).toLowerCase();
    if (base === 'ffmpeg' || base === 'ffmpeg.exe') {
        return path.join(path.dirname(ffmpegPath), base.endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe');
    }
    return 'ffprobe';
}

async function verifyFixture({ id, filePath, ffmpegPath, ffprobePath = inferFfprobePath(ffmpegPath) }) {
    const probe = await probeJson(ffprobePath, filePath);
    const videos = visibleVideoStreams(Array.isArray(probe.streams) ? probe.streams : []);
    const idrPacketCount = videos.length === 1 && videos[0].codec_name === 'h264'
        ? await h264IdrPacketCount(ffmpegPath, filePath)
        : null;
    return verifyProbeEvidence(id, probe, { idrPacketCount });
}

module.exports = Object.freeze({
    inferFfprobePath,
    verifyFixture,
    verifyProbeEvidence,
});
