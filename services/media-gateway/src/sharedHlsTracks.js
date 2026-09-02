'use strict';

const fs = require('node:fs');
const path = require('node:path');

const fsp = fs.promises;
const DEFAULT_MAX_SUBTITLE_RENDITIONS = 8;
const TEXT_SUBTITLE_CODECS = new Set([
    'ass',
    'movtext',
    'srt',
    'ssa',
    'subrip',
    'text',
    'webvtt',
]);

class SharedHlsTrackError extends Error {
    constructor(code, message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = 'SharedHlsTrackError';
        this.code = code;
    }
}

function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeToken(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeLanguage(value) {
    const normalized = String(value || 'und').trim().replace(/_/g, '-').toLowerCase();
    return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(normalized) ? normalized : 'und';
}

function normalizeStreamIndex(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 4095 ? parsed : null;
}

function cleanLabel(value, fallback, maximum = 96) {
    const cleaned = String(value || '')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/["\\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return (cleaned || fallback).slice(0, maximum);
}

function uniqueLabels(tracks, kind) {
    const counts = new Map();
    return tracks.map((track, index) => {
        const language = normalizeLanguage(track.language ?? track.lang);
        const fallback = language === 'und'
            ? `${kind} ${index + 1}`
            : language.toUpperCase();
        const base = cleanLabel(track.title ?? track.name ?? track.label, fallback);
        const normalized = base.toLocaleLowerCase('en-US');
        const prior = counts.get(normalized) || 0;
        counts.set(normalized, prior + 1);
        return prior === 0 ? base : cleanLabel(`${base} ${prior + 1}`, fallback);
    });
}

function subtitleSourceTracks(profileValue) {
    const profile = record(profileValue);
    if (Array.isArray(profile.subtitles)) return profile.subtitles;
    if (Array.isArray(profile.subtitleTracks)) return profile.subtitleTracks;
    if (Array.isArray(profile.subtitle_tracks)) return profile.subtitle_tracks;
    return null;
}

function isExactTextSubtitle(trackValue) {
    const track = record(trackValue);
    const codec = normalizeToken(track.codec ?? track.codecName ?? track.codec_name);
    const declaredKind = normalizeToken(track.subtitleType ?? track.subtitle_type ?? track.kind);
    const textKind = declaredKind === 'text' || TEXT_SUBTITLE_CODECS.has(codec);
    return track.extractable === true && textKind && TEXT_SUBTITLE_CODECS.has(codec);
}

function buildExactSubtitleHlsPlan(profileValue, options = {}) {
    const maxRenditions = Number.isInteger(options.maxRenditions)
        ? options.maxRenditions
        : DEFAULT_MAX_SUBTITLE_RENDITIONS;
    if (maxRenditions < 1 || maxRenditions > 32) {
        throw new SharedHlsTrackError('SUBTITLE_HLS_LIMIT_INVALID', 'subtitle HLS limit is invalid');
    }
    const sourceTracks = subtitleSourceTracks(profileValue);
    const base = {
        protocol: 1,
        enabled: false,
        cacheEligible: false,
        reason: 'profile-incomplete',
        maxRenditions,
        sourceTrackCount: Array.isArray(sourceTracks) ? sourceTracks.length : 0,
        renditions: [],
    };
    if (!sourceTracks) return base;
    if (sourceTracks.length === 0) {
        return { ...base, cacheEligible: true, reason: 'no-subtitles' };
    }
    if (!sourceTracks.every(isExactTextSubtitle)) {
        return { ...base, reason: 'unsupported-or-inexact-subtitle' };
    }
    const streamIndexes = sourceTracks.map((track) => normalizeStreamIndex(track?.index ?? track?.streamIndex));
    if (streamIndexes.some((index) => !Number.isInteger(index)) || new Set(streamIndexes).size !== streamIndexes.length) {
        return { ...base, reason: 'invalid-subtitle-stream-index' };
    }
    const labels = uniqueLabels(sourceTracks, 'Subtitle');
    const requestedStreamIndex = normalizeStreamIndex(options.requestedStreamIndex);
    const prioritizedSourceIndexes = [];
    const selectedSourceIndexes = new Set();
    const addSourceIndex = (sourceIndex) => {
        if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= sourceTracks.length) return;
        if (selectedSourceIndexes.has(sourceIndex)) return;
        selectedSourceIndexes.add(sourceIndex);
        prioritizedSourceIndexes.push(sourceIndex);
    };

    // Subtitle-heavy files cannot fan every track out without making startup
    // unpredictable. Build one deterministic playback cohort instead: the
    // viewer's requested absolute stream, then default/forced tracks, then one
    // track per language before duplicate variants. The full exact list remains
    // metadata-visible while this bounded cohort switches in the current HLS.
    if (Number.isInteger(requestedStreamIndex)) {
        addSourceIndex(streamIndexes.indexOf(requestedStreamIndex));
    }
    sourceTracks.forEach((track, sourceIndex) => {
        if (track?.default === true) addSourceIndex(sourceIndex);
    });
    sourceTracks.forEach((track, sourceIndex) => {
        if (track?.forced === true) addSourceIndex(sourceIndex);
    });
    const representedLanguages = new Set(
        prioritizedSourceIndexes.map((sourceIndex) => normalizeLanguage(
            sourceTracks[sourceIndex]?.language ?? sourceTracks[sourceIndex]?.lang,
        )),
    );
    sourceTracks.forEach((track, sourceIndex) => {
        const language = normalizeLanguage(track?.language ?? track?.lang);
        if (representedLanguages.has(language)) return;
        representedLanguages.add(language);
        addSourceIndex(sourceIndex);
    });
    sourceTracks.forEach((track, sourceIndex) => addSourceIndex(sourceIndex));

    const cohortSourceIndexes = prioritizedSourceIndexes.slice(0, maxRenditions);
    const renditions = cohortSourceIndexes.map((sourceIndex, hlsIndex) => {
        const raw = sourceTracks[sourceIndex];
        const track = record(raw);
        const sourceCodec = normalizeToken(track.codec ?? track.codecName ?? track.codec_name);
        return Object.freeze({
            hlsIndex,
            streamIndex: streamIndexes[sourceIndex],
            language: normalizeLanguage(track.language ?? track.lang),
            title: labels[sourceIndex],
            sourceCodec,
            outputCodec: 'webvtt',
            default: track.default === true,
            forced: track.forced === true,
            hearingImpaired: track.hearingImpaired === true || track.hearing_impaired === true,
            playlistName: `subtitle_${hlsIndex}.m3u8`,
            segmentPattern: `subtitle_${hlsIndex}-%05d.vtt`,
        });
    });
    return Object.freeze({
        ...base,
        enabled: true,
        cacheEligible: sourceTracks.length <= maxRenditions,
        reason: sourceTracks.length <= maxRenditions ? 'enabled' : 'enabled-partial',
        renditions: Object.freeze(renditions),
    });
}

function exactSubtitleOutputArgs(planValue, outputDirectory, postInputSeek = []) {
    const plan = record(planValue);
    if (plan.enabled !== true || !Array.isArray(plan.renditions)) return [];
    return plan.renditions.flatMap((rendition) => [
        ...postInputSeek,
        '-map', `0:${rendition.streamIndex}`,
        '-c:s', 'webvtt',
        '-f', 'segment',
        '-segment_time', '2',
        '-segment_list_flags', '+live',
        '-segment_list_size', '0',
        '-segment_list_type', 'm3u8',
        '-segment_format', 'webvtt',
        '-segment_list', path.join(outputDirectory, rendition.playlistName),
        path.join(outputDirectory, rendition.segmentPattern),
    ]);
}

function escapeHlsQuoted(value) {
    return String(value || '').replace(/[\r\n"\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

function hlsAttribute(name, value) {
    return `${name}="${escapeHlsQuoted(value)}"`;
}

function appendAttribute(line, name, value) {
    const pattern = new RegExp(`(?:^|,)${name}=(?:"[^"]*"|[^,]*)`, 'i');
    if (pattern.test(line.replace(/^#EXT-X-[^:]+:/, ''))) return line;
    return `${line},${hlsAttribute(name, value)}`;
}

function exactAudioName(planValue, renditionValue) {
    const plan = record(planValue);
    const renditions = Array.isArray(plan.audioRenditions) ? plan.audioRenditions : [];
    const rendition = record(renditionValue);
    const hlsIndex = Number(rendition.hlsIndex);
    const language = normalizeLanguage(rendition.language);
    const base = language === 'und' ? `Audio ${hlsIndex + 1}` : language.toUpperCase();
    const priorWithLanguage = renditions
        .slice(0, hlsIndex)
        .filter((candidate) => normalizeLanguage(candidate?.language) === language)
        .length;
    if (language === 'und') return `Audio ${priorWithLanguage + 1}`;
    return priorWithLanguage > 0 ? `${base} ${priorWithLanguage + 1}` : base;
}

function rewriteAudioMediaLine(line, audioPlanValue) {
    const plan = record(audioPlanValue);
    if (plan.enabled !== true || !Array.isArray(plan.audioRenditions)) return line;
    const attributes = line.replace(/^#EXT-X-MEDIA:/i, '');
    if (attributes === line || !/(?:^|,)TYPE=AUDIO(?:,|$)/i.test(attributes)) return line;
    const uriMatch = /(?:^|,)URI="audio_(\d+)\.m3u8"/i.exec(attributes);
    if (!uriMatch) return line;
    const hlsIndex = Number(uriMatch[1]);
    const rendition = plan.audioRenditions[hlsIndex];
    if (!rendition || rendition.hlsIndex !== hlsIndex) return line;
    const name = exactAudioName(plan, rendition);
    let rewritten = line.replace(/(?:^|,)NAME="[^"]*"/i, (match) => (
        `${match.startsWith(',') ? ',' : ''}${hlsAttribute('NAME', name)}`
    ));
    rewritten = appendAttribute(rewritten, 'X-NORVA-STREAM-INDEX', rendition.streamIndex);
    return rewritten;
}

function subtitleMediaLine(rendition) {
    const attributes = [
        'TYPE=SUBTITLES',
        hlsAttribute('GROUP-ID', 'norva_subtitles'),
        hlsAttribute('NAME', rendition.title),
        `DEFAULT=${rendition.default === true ? 'YES' : 'NO'}`,
        `AUTOSELECT=${rendition.language !== 'und' || rendition.default === true || rendition.forced === true ? 'YES' : 'NO'}`,
        `FORCED=${rendition.forced === true ? 'YES' : 'NO'}`,
        hlsAttribute('LANGUAGE', rendition.language),
        hlsAttribute('URI', rendition.playlistName),
        hlsAttribute('X-NORVA-STREAM-INDEX', rendition.streamIndex),
    ];
    if (rendition.hearingImpaired === true) {
        attributes.push(hlsAttribute('CHARACTERISTICS', 'public.accessibility.transcribes-spoken-dialog'));
    }
    return `#EXT-X-MEDIA:${attributes.join(',')}`;
}

function rewriteExactHlsMaster(masterValue, options = {}) {
    const subtitlePlan = record(options.subtitlePlan);
    const lines = String(masterValue || '').split(/\r?\n/);
    if (lines[0]?.trim() !== '#EXTM3U') {
        throw new SharedHlsTrackError('HLS_MASTER_INVALID', 'HLS master is invalid');
    }
    const withoutNorvaSubtitles = lines
        .filter((line) => {
            const attributes = line.replace(/^#EXT-X-MEDIA:/i, '');
            return attributes === line
                || !/(?:^|,)TYPE=SUBTITLES(?:,|$)/i.test(attributes)
                || !/(?:^|,)GROUP-ID="norva_subtitles"(?:,|$)/i.test(attributes);
        })
        .map((line) => rewriteAudioMediaLine(line, options.audioPlan));
    if (subtitlePlan.enabled !== true || !Array.isArray(subtitlePlan.renditions)) {
        return withoutNorvaSubtitles.join('\n');
    }
    const firstVariant = withoutNorvaSubtitles.findIndex((line) => /^#EXT-X-STREAM-INF:/i.test(line));
    if (firstVariant < 0) {
        throw new SharedHlsTrackError('HLS_MASTER_VARIANT_MISSING', 'HLS master has no video variant');
    }
    withoutNorvaSubtitles.splice(
        firstVariant,
        0,
        ...subtitlePlan.renditions.map(subtitleMediaLine),
    );
    return withoutNorvaSubtitles.map((line) => (
        /^#EXT-X-STREAM-INF:/i.test(line)
            ? appendAttribute(line, 'SUBTITLES', 'norva_subtitles')
            : line
    )).join('\n');
}

function isWithin(root, candidate) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeFlatName(value) {
    const name = String(value || '');
    return name === path.basename(name) && /^[a-z0-9][a-z0-9._-]*$/i.test(name) ? name : null;
}

async function validateSubtitlePlaylist(outputDirectory, rendition) {
    const playlistName = safeFlatName(rendition.playlistName);
    if (!playlistName) throw new SharedHlsTrackError('SUBTITLE_PLAYLIST_NAME_INVALID', 'subtitle playlist name is invalid');
    const playlistPath = path.resolve(outputDirectory, playlistName);
    if (!isWithin(outputDirectory, playlistPath)) {
        throw new SharedHlsTrackError('SUBTITLE_PLAYLIST_ESCAPED', 'subtitle playlist escaped output root');
    }
    const text = await fsp.readFile(playlistPath, 'utf8').catch((cause) => {
        throw new SharedHlsTrackError('SUBTITLE_PLAYLIST_MISSING', 'subtitle playlist is missing', { cause });
    });
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines[0] !== '#EXTM3U' || !lines.includes('#EXT-X-ENDLIST')) {
        throw new SharedHlsTrackError('SUBTITLE_PLAYLIST_INCOMPLETE', 'subtitle playlist is incomplete');
    }
    const segments = lines.filter((line) => !line.startsWith('#'));
    if (!segments.length) {
        throw new SharedHlsTrackError('SUBTITLE_PLAYLIST_EMPTY', 'subtitle playlist has no exact WebVTT segment');
    }
    for (const segment of segments) {
        const name = safeFlatName(segment);
        if (!name || !name.toLowerCase().endsWith('.vtt')) {
            throw new SharedHlsTrackError('SUBTITLE_SEGMENT_NAME_INVALID', 'subtitle segment name is invalid');
        }
        const segmentPath = path.resolve(outputDirectory, name);
        if (!isWithin(outputDirectory, segmentPath)) {
            throw new SharedHlsTrackError('SUBTITLE_SEGMENT_ESCAPED', 'subtitle segment escaped output root');
        }
        const stat = await fsp.stat(segmentPath).catch((cause) => {
            throw new SharedHlsTrackError('SUBTITLE_SEGMENT_MISSING', 'subtitle segment is missing', { cause });
        });
        if (!stat.isFile() || stat.size <= 6) {
            throw new SharedHlsTrackError('SUBTITLE_SEGMENT_INVALID', 'subtitle segment is invalid');
        }
    }
}

async function finalizeExactHlsTrackGraph(options = {}) {
    const outputDirectory = path.resolve(String(options.outputDirectory || ''));
    const masterPath = path.resolve(String(options.masterPath || ''));
    if (!outputDirectory || !isWithin(outputDirectory, masterPath)) {
        throw new SharedHlsTrackError('HLS_OUTPUT_ROOT_INVALID', 'HLS output root is invalid');
    }
    const subtitlePlan = record(options.subtitlePlan);
    if (subtitlePlan.enabled === true) {
        await Promise.all(subtitlePlan.renditions.map((rendition) => (
            validateSubtitlePlaylist(outputDirectory, rendition)
        )));
    }
    if (options.masterRequired !== true) return { rewritten: false, subtitleRenditions: 0 };
    const master = await fsp.readFile(masterPath, 'utf8');
    const rewritten = rewriteExactHlsMaster(master, {
        audioPlan: options.audioPlan,
        subtitlePlan,
    });
    const tempPath = `${masterPath}.norva-${process.pid}-${Date.now()}.tmp`;
    try {
        await fsp.writeFile(tempPath, rewritten, { encoding: 'utf8', flag: 'wx' });
        await fsp.rename(tempPath, masterPath);
    } finally {
        await fsp.unlink(tempPath).catch(() => {});
    }
    return {
        rewritten: rewritten !== master,
        subtitleRenditions: subtitlePlan.enabled === true ? subtitlePlan.renditions.length : 0,
    };
}

module.exports = {
    DEFAULT_MAX_SUBTITLE_RENDITIONS,
    SharedHlsTrackError,
    buildExactSubtitleHlsPlan,
    exactAudioName,
    exactSubtitleOutputArgs,
    finalizeExactHlsTrackGraph,
    rewriteExactHlsMaster,
};
