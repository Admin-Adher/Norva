/**
 * Norva MKV Strategy Lab.
 *
 * Admin-only QA surface for comparing deterministic routing contracts before a
 * controlled media fixture is allowed to touch the Gateway. This module never
 * accepts a provider URL, account identifier or arbitrary media input.
 */
(function registerMkvStrategyLab(global) {
    'use strict';

    const PROTOCOL = 1;
    const MAX_RUNTIME_MS = 10 * 60 * 1000;
    const PIPELINES = Object.freeze([
        'cache-hit',
        'video-copy-audio-copy',
        'video-copy-audio-transcode',
        'video-transcode',
        'terminal-458'
    ]);

    const STRATEGIES = Object.freeze([
        Object.freeze({ id: 'auto', label: (globalThis.NorvaI18n?.t("ui_web_3964d2bd0f74", { defaultValue: "Auto Norva" }) ?? 'Auto Norva'), note: (globalThis.NorvaI18n?.t("ui_web_c1b226f359c5", { defaultValue: "Cache valide, puis fast-path attesté, sinon fallback historique." }) ?? 'Cache valide, puis fast-path attesté, sinon fallback historique.') }),
        Object.freeze({ id: 'legacy', label: (globalThis.NorvaI18n?.t("ui_web_2cba3231471f", { defaultValue: "Historique sûr" }) ?? 'Historique sûr'), note: (globalThis.NorvaI18n?.t("ui_web_ed8ce12cd3f2", { defaultValue: "Réencodage vidéo et audio, avec le buffer profond actuel." }) ?? 'Réencodage vidéo et audio, avec le buffer profond actuel.') }),
        Object.freeze({ id: 'h264-fast', label: (globalThis.NorvaI18n?.t("ui_web_e1f6635854fb", { defaultValue: "Remux H.264" }) ?? 'Remux H.264'), note: (globalThis.NorvaI18n?.t("ui_web_c95325e7abd0", { defaultValue: "Copie vidéo uniquement avec identité, GOP, timestamps et compatibilité prouvés." }) ?? 'Copie vidéo uniquement avec identité, GOP, timestamps et compatibilité prouvés.') }),
        Object.freeze({ id: 'audio-only', label: (globalThis.NorvaI18n?.t("ui_web_b2f52e6880a7", { defaultValue: "Audio seul" }) ?? 'Audio seul'), note: (globalThis.NorvaI18n?.t("ui_web_ce9c2f182469", { defaultValue: "Copie vidéo attestée et conversion AAC de la piste audio." }) ?? 'Copie vidéo attestée et conversion AAC de la piste audio.') }),
        Object.freeze({ id: 'full-cache', label: (globalThis.NorvaI18n?.t("ui_web_2ef573d54ba3", { defaultValue: "Cache HLS complet" }) ?? 'Cache HLS complet'), note: (globalThis.NorvaI18n?.t("ui_web_c154b7e078d6", { defaultValue: "Lecture privée déjà matérialisée, sans fournisseur ni FFmpeg sur le hit." }) ?? 'Lecture privée déjà matérialisée, sans fournisseur ni FFmpeg sur le hit.') })
    ]);

    const FIXTURES = Object.freeze([
        fixture({
            id: 'h264-closed-aac', short: 'H.264 + AAC', title: (globalThis.NorvaI18n?.t("ui_web_c6b83e7e2f0d", { defaultValue: "H.264 High, GOP fermé, AAC-LC" }) ?? 'H.264 High, GOP fermé, AAC-LC'),
            video: 'H.264 High 4.1 · 360p24', audio: 'AAC-LC · stéréo', gop: (globalThis.NorvaI18n?.t("ui_web_8c19bcfc4d66", { defaultValue: "IDR toutes les 2 s" }) ?? 'IDR toutes les 2 s'),
            validator: (globalThis.NorvaI18n?.t("ui_web_7210ad7362dd", { defaultValue: "ETag fort stable" }) ?? 'ETag fort stable'), subtitles: (globalThis.NorvaI18n?.t("ui_web_4679b3b12de0", { defaultValue: "Aucun" }) ?? 'Aucun'), closedGop: true, strongEtag: true, trainingRequired: true,
            expected: { pipeline: 'video-copy-audio-copy', reason: 'mkv-h264-copy-ready', under10: true }
        }),
        fixture({
            id: 'h264-closed-ac3', short: 'H.264 + AC-3', title: (globalThis.NorvaI18n?.t("ui_web_1eab5748f7df", { defaultValue: "H.264 High, GOP fermé, AC-3" }) ?? 'H.264 High, GOP fermé, AC-3'),
            video: 'H.264 High 4.1 · 360p24', audio: 'AC-3 · 5.1', audioCodec: 'ac3', audioChannels: 6,
            gop: (globalThis.NorvaI18n?.t("ui_web_8c19bcfc4d66", { defaultValue: "IDR toutes les 2 s" }) ?? 'IDR toutes les 2 s'), validator: (globalThis.NorvaI18n?.t("ui_web_7210ad7362dd", { defaultValue: "ETag fort stable" }) ?? 'ETag fort stable'), subtitles: (globalThis.NorvaI18n?.t("ui_web_4679b3b12de0", { defaultValue: "Aucun" }) ?? 'Aucun'), closedGop: true, strongEtag: true, trainingRequired: true,
            expected: { pipeline: 'video-copy-audio-transcode', reason: 'mkv-h264-copy-ready', under10: true }
        }),
        fixture({
            id: 'h264-open-gop', short: (globalThis.NorvaI18n?.t("ui_web_7acac0c5dc77", { defaultValue: "Open GOP" }) ?? 'Open GOP'), title: (globalThis.NorvaI18n?.t("ui_web_406417507956", { defaultValue: "H.264 avec images clés non-IDR" }) ?? 'H.264 avec images clés non-IDR'),
            video: 'H.264 High 4.1 · 360p24', audio: 'AAC-LC · stéréo', gop: (globalThis.NorvaI18n?.t("ui_web_dc34dba6a498", { defaultValue: "Open GOP · K ≠ IDR" }) ?? 'Open GOP · K ≠ IDR'),
            validator: (globalThis.NorvaI18n?.t("ui_web_7210ad7362dd", { defaultValue: "ETag fort stable" }) ?? 'ETag fort stable'), subtitles: (globalThis.NorvaI18n?.t("ui_web_4679b3b12de0", { defaultValue: "Aucun" }) ?? 'Aucun'), closedGop: false, strongEtag: true,
            expected: { pipeline: 'video-transcode', reason: 'open-gop', under10: true }
        }),
        fixture({
            id: 'h264-multi-audio', short: (globalThis.NorvaI18n?.t("ui_web_8a471a6524fa", { defaultValue: "Multi-audio" }) ?? 'Multi-audio'), title: (globalThis.NorvaI18n?.t("ui_web_f8c2f046b451", { defaultValue: "H.264 avec trois pistes audio" }) ?? 'H.264 avec trois pistes audio'),
            video: 'H.264 High 4.1 · 360p24', audio: 'AAC + AC-3 + AAC · mono', audioTracks: 3,
            gop: (globalThis.NorvaI18n?.t("ui_web_8c19bcfc4d66", { defaultValue: "IDR toutes les 2 s" }) ?? 'IDR toutes les 2 s'), validator: (globalThis.NorvaI18n?.t("ui_web_7210ad7362dd", { defaultValue: "ETag fort stable" }) ?? 'ETag fort stable'), subtitles: (globalThis.NorvaI18n?.t("ui_web_4679b3b12de0", { defaultValue: "Aucun" }) ?? 'Aucun'), closedGop: true, strongEtag: true,
            expected: { pipeline: 'video-transcode', reason: 'multi-audio', under10: true }
        }),
        fixture({
            id: 'hevc-eac3-cold', short: (globalThis.NorvaI18n?.t("ui_web_1338de3ec167", { defaultValue: "HEVC froid" }) ?? 'HEVC froid'), title: (globalThis.NorvaI18n?.t("ui_web_190e8d7e41f9", { defaultValue: "HEVC Main 10 et E-AC-3" }) ?? 'HEVC Main 10 et E-AC-3'),
            video: (globalThis.NorvaI18n?.t("ui_web_ed47bb803d72", { defaultValue: "HEVC Main 10 · 720p24" }) ?? 'HEVC Main 10 · 720p24'), videoCodec: 'hevc', width: 1280, height: 720,
            audio: 'E-AC-3 · 5.1', audioCodec: 'eac3', audioChannels: 6, gop: (globalThis.NorvaI18n?.t("ui_web_e57e99872603", { defaultValue: "Variable" }) ?? 'Variable'),
            validator: (globalThis.NorvaI18n?.t("ui_web_7210ad7362dd", { defaultValue: "ETag fort stable" }) ?? 'ETag fort stable'), subtitles: (globalThis.NorvaI18n?.t("ui_web_4679b3b12de0", { defaultValue: "Aucun" }) ?? 'Aucun'), closedGop: false, strongEtag: true,
            expected: { pipeline: 'video-transcode', reason: 'video-codec', under10: true }
        }),
        fixture({
            id: 'h264-level52', short: 'H.264 extrême', title: (globalThis.NorvaI18n?.t("ui_web_338ef9f99a85", { defaultValue: "H.264 Level 5.2, cadence élevée" }) ?? 'H.264 Level 5.2, cadence élevée'),
            video: 'H.264 High 5.2 · 1080p120', width: 1920, height: 1080,
            fps: 120, level: 5.2, refs: 1, audio: 'AAC-LC · stéréo', gop: (globalThis.NorvaI18n?.t("ui_web_3643e3cb1175", { defaultValue: "IDR toutes les 1 s" }) ?? 'IDR toutes les 1 s'),
            validator: (globalThis.NorvaI18n?.t("ui_web_7210ad7362dd", { defaultValue: "ETag fort stable" }) ?? 'ETag fort stable'), subtitles: (globalThis.NorvaI18n?.t("ui_web_4679b3b12de0", { defaultValue: "Aucun" }) ?? 'Aucun'), closedGop: true, strongEtag: true,
            expected: { pipeline: 'video-transcode', reason: 'web-compatibility', under10: true }
        }),
        fixture({
            id: 'h264-bad-timestamps', short: (globalThis.NorvaI18n?.t("ui_web_58b8e5460046", { defaultValue: "Timestamps KO" }) ?? 'Timestamps KO'), title: (globalThis.NorvaI18n?.t("ui_web_df143dca89ae", { defaultValue: "H.264 avec discontinuité PTS/DTS" }) ?? 'H.264 avec discontinuité PTS/DTS'),
            video: 'H.264 High 4.1 · 360p24', audio: 'AAC-LC · stéréo', gop: (globalThis.NorvaI18n?.t("ui_web_8c19bcfc4d66", { defaultValue: "IDR toutes les 2 s" }) ?? 'IDR toutes les 2 s'),
            validator: (globalThis.NorvaI18n?.t("ui_web_7210ad7362dd", { defaultValue: "ETag fort stable" }) ?? 'ETag fort stable'), subtitles: (globalThis.NorvaI18n?.t("ui_web_4679b3b12de0", { defaultValue: "Aucun" }) ?? 'Aucun'), closedGop: true, timestampsValid: false, strongEtag: true,
            expected: { pipeline: 'video-transcode', reason: 'invalid-timestamps', under10: true }
        }),
        fixture({
            id: 'h264-pgs', short: (globalThis.NorvaI18n?.t("ui_web_39cb24881044", { defaultValue: "Sous-titres PGS" }) ?? 'Sous-titres PGS'), title: (globalThis.NorvaI18n?.t("ui_web_06f9c37b7dc3", { defaultValue: "H.264 sûr avec sous-titres bitmap" }) ?? 'H.264 sûr avec sous-titres bitmap'),
            video: 'H.264 High 4.1 · 360p24', audio: 'AAC-LC · stéréo', gop: (globalThis.NorvaI18n?.t("ui_web_8c19bcfc4d66", { defaultValue: "IDR toutes les 2 s" }) ?? 'IDR toutes les 2 s'),
            validator: (globalThis.NorvaI18n?.t("ui_web_7210ad7362dd", { defaultValue: "ETag fort stable" }) ?? 'ETag fort stable'), subtitles: (globalThis.NorvaI18n?.t("ui_web_40f0c8323fe1", { defaultValue: "PGS · OCR asynchrone" }) ?? 'PGS · OCR asynchrone'), closedGop: true, strongEtag: true, trainingRequired: true,
            expected: { pipeline: 'video-copy-audio-copy', reason: 'mkv-h264-copy-ready', under10: true, warning: 'subtitle-async' }
        }),
        fixture({
            id: 'h264-no-etag', short: (globalThis.NorvaI18n?.t("ui_web_6cabe08cea51", { defaultValue: "Sans ETag fort" }) ?? 'Sans ETag fort'), title: (globalThis.NorvaI18n?.t("ui_web_5106fd8c0c34", { defaultValue: "H.264 sûr, identité fournisseur faible" }) ?? 'H.264 sûr, identité fournisseur faible'),
            video: 'H.264 High 4.1 · 360p24', audio: 'AAC-LC · stéréo', gop: (globalThis.NorvaI18n?.t("ui_web_8c19bcfc4d66", { defaultValue: "IDR toutes les 2 s" }) ?? 'IDR toutes les 2 s'),
            validator: (globalThis.NorvaI18n?.t("ui_web_fb2fade6bb98", { defaultValue: "ETag faible + Last-Modified" }) ?? 'ETag faible + Last-Modified'), subtitles: (globalThis.NorvaI18n?.t("ui_web_4679b3b12de0", { defaultValue: "Aucun" }) ?? 'Aucun'), closedGop: true, strongEtag: false,
            expected: { pipeline: 'video-transcode', reason: 'strong-etag-required', under10: true }
        }),
        fixture({
            id: 'hevc-full-cache', short: (globalThis.NorvaI18n?.t("ui_web_1fc2a5aeab5f", { defaultValue: "HEVC en cache" }) ?? 'HEVC en cache'), title: (globalThis.NorvaI18n?.t("ui_web_6efb86c06f68", { defaultValue: "HEVC préfabriqué en HLS complet" }) ?? 'HEVC préfabriqué en HLS complet'),
            video: (globalThis.NorvaI18n?.t("ui_web_3620cf21d4e6", { defaultValue: "HEVC Main 10 720p · sortie H.264 cache" }) ?? 'HEVC Main 10 720p · sortie H.264 cache'), videoCodec: 'hevc', width: 1280, height: 720,
            audio: (globalThis.NorvaI18n?.t("ui_web_25f94b6b507a", { defaultValue: "E-AC-3 source · sortie AAC" }) ?? 'E-AC-3 source · sortie AAC'), audioCodec: 'eac3', audioChannels: 6, gop: (globalThis.NorvaI18n?.t("ui_web_10fbec399e0e", { defaultValue: "Cache attesté" }) ?? 'Cache attesté'),
            validator: (globalThis.NorvaI18n?.t("ui_web_28c285b9abe5", { defaultValue: "Identité cache valide" }) ?? 'Identité cache valide'), subtitles: (globalThis.NorvaI18n?.t("ui_web_4679b3b12de0", { defaultValue: "Aucun" }) ?? 'Aucun'), cacheHit: true, cacheValid: true,
            expected: { pipeline: 'cache-hit', reason: 'complete-cache-hit', under10: true }
        }),
        fixture({
            id: 'provider-458', short: 'HTTP 458', title: (globalThis.NorvaI18n?.t("ui_web_467691b0f4ab", { defaultValue: "Compte fournisseur déjà occupé" }) ?? 'Compte fournisseur déjà occupé'),
            video: 'H.264 High 4.1 · 360p24', audio: 'AAC-LC · stéréo', gop: (globalThis.NorvaI18n?.t("ui_web_67afd925c7db", { defaultValue: "Non ouvert" }) ?? 'Non ouvert'),
            validator: (globalThis.NorvaI18n?.t("ui_web_98ab209e4fc3", { defaultValue: "Non lu" }) ?? 'Non lu'), subtitles: (globalThis.NorvaI18n?.t("ui_web_98ab209e4fc3", { defaultValue: "Non lu" }) ?? 'Non lu'), http458: true,
            expected: { pipeline: 'terminal-458', reason: 'provider-busy-terminal', under10: false }
        })
    ]);

    function fixture(input) {
        return Object.freeze({
            container: 'matroska', videoCodec: 'h264', width: 640, height: 360,
            fps: 24, level: 4.1, refs: 1, audioCodec: 'aac', audioChannels: 2,
            audioTracks: 1, closedGop: false, timestampsValid: true, strongEtag: false,
            cacheHit: false, cacheValid: false, http458: false, startAtSeconds: 0, trainingRequired: false,
            ...input,
            expected: Object.freeze({ ...input.expected })
        });
    }

    function cloneFixture(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function strategyById(id) {
        return STRATEGIES.find((strategy) => strategy.id === id) || null;
    }

    function fixtureById(id) {
        return FIXTURES.find((item) => item.id === id) || null;
    }

    function fastPathRejection(item) {
        if (item.container !== 'matroska') return 'container';
        if (item.videoCodec !== 'h264') return 'video-codec';
        if (item.startAtSeconds !== 0) return 'seek';
        if (item.audioTracks !== 1) return 'multi-audio';
        if (item.width > 1920 || item.height > 1080 || item.fps > 60 || item.level > 4.2 || item.refs > 8) return 'web-compatibility';
        if (!item.closedGop) return 'open-gop';
        if (!item.timestampsValid) return 'invalid-timestamps';
        if (!item.strongEtag) return 'strong-etag-required';
        return null;
    }

    function legacyResult(item, reason) {
        return result({
            pipeline: 'video-transcode', reason: reason || 'legacy-safe-fallback', targetBufferSeconds: 96,
            providerGets: 1, ffmpegSpawns: 1, expectedUnder10Seconds: false,
            videoAction: 'Réencoder H.264', audioAction: 'Réencoder AAC'
        });
    }

    function vaapiTranscodeResult(item, reason) {
        return result({
            pipeline: 'video-transcode', reason: reason || 'vaapi-transcode-ready', targetBufferSeconds: 6,
            providerGets: 1, ffmpegSpawns: 1, expectedUnder10Seconds: true,
            videoAction: 'Réencoder en H.264 VAAPI', audioAction: 'Convertir en AAC'
        });
    }

    function result(input) {
        return Object.freeze({
            protocol: PROTOCOL,
            pipeline: input.pipeline,
            reason: input.reason,
            targetBufferSeconds: input.targetBufferSeconds,
            providerGets: input.providerGets,
            ffmpegSpawns: input.ffmpegSpawns,
            retriesAfter458: input.retriesAfter458 || 0,
            expectedUnder10Seconds: input.expectedUnder10Seconds === true,
            videoAction: input.videoAction,
            audioAction: input.audioAction,
            warning: input.warning || null
        });
    }

    function evaluateFixture(fixtureId, strategyId) {
        const item = fixtureById(fixtureId);
        const strategy = strategyById(strategyId);
        if (!item || !strategy) throw new Error('UNKNOWN_LAB_CASE');
        if (item.http458) {
            return result({
                pipeline: 'terminal-458', reason: 'provider-busy-terminal', targetBufferSeconds: null,
                providerGets: 1, ffmpegSpawns: 0, retriesAfter458: 0, expectedUnder10Seconds: false,
                videoAction: 'Aucune lecture', audioAction: 'Aucune lecture'
            });
        }
        if (strategy.id === 'legacy') return legacyResult(item);
        if (strategy.id === 'full-cache') {
            if (item.cacheHit && item.cacheValid) {
                return result({
                    pipeline: 'cache-hit', reason: 'complete-cache-hit', targetBufferSeconds: 4,
                    providerGets: 0, ffmpegSpawns: 0, expectedUnder10Seconds: true,
                    videoAction: 'Servir HLS privé', audioAction: 'Servir HLS privé'
                });
            }
            return vaapiTranscodeResult(item, 'complete-cache-miss');
        }
        if (strategy.id === 'auto' && item.cacheHit && item.cacheValid) return evaluateFixture(item.id, 'full-cache');

        const rejection = fastPathRejection(item);
        if (rejection) return vaapiTranscodeResult(item, rejection);
        const audioCopySafe = item.audioCodec === 'aac' && item.audioChannels <= 2;
        const forceAudio = strategy.id === 'audio-only';
        const copyAudio = strategy.id !== 'audio-only' && audioCopySafe;
        return result({
            pipeline: copyAudio ? 'video-copy-audio-copy' : 'video-copy-audio-transcode',
            reason: 'mkv-h264-copy-ready', targetBufferSeconds: 6, providerGets: item.trainingRequired ? 2 : 1, ffmpegSpawns: 1,
            expectedUnder10Seconds: true, videoAction: 'Copier H.264',
            audioAction: copyAudio ? 'Copier AAC-LC' : (forceAudio ? 'Forcer AAC' : 'Convertir AAC'),
            warning: item.expected.warning || null
        });
    }

    function sanitizeRuntimeResult(value) {
        if (!value || typeof value !== 'object') throw new Error('INVALID_RUNTIME_RESULT');
        if (value.protocol !== PROTOCOL) throw new Error('INVALID_RUNTIME_RESULT');
        const pipeline = PIPELINES.includes(value.pipeline) ? value.pipeline : null;
        const status = ['pass', 'fail', 'blocked', 'cancelled'].includes(value.status) ? value.status : null;
        const reason = safeToken(value.reason, 64);
        if (!pipeline || !status || !reason) throw new Error('INVALID_RUNTIME_RESULT');
        return Object.freeze({
            protocol: PROTOCOL,
            status,
            pipeline,
            reason,
            ttffMs: safeMetric(value.ttffMs, MAX_RUNTIME_MS),
            manifestReadyMs: safeMetric(value.manifestReadyMs, MAX_RUNTIME_MS),
            firstSegmentMs: safeMetric(value.firstSegmentMs, MAX_RUNTIME_MS),
            bufferedAheadSeconds: safeMetric(value.bufferedAheadSeconds, 3600),
            productionRateX: safeMetric(value.productionRateX, 100),
            browserBufferRateX: safeMetric(value.browserBufferRateX, 100),
            rebufferCount: safeMetric(value.rebufferCount, 1000, true),
            rebufferMs: safeMetric(value.rebufferMs, MAX_RUNTIME_MS),
            providerGets: safeMetric(value.providerGets, 10, true),
            maximumConcurrentProviderGets: safeMetric(value.maximumConcurrentProviderGets, 10, true),
            ffmpegSpawns: safeMetric(value.ffmpegSpawns, 10, true),
            analyzerSpawns: safeMetric(value.analyzerSpawns, 10, true),
            http458: safeMetric(value.http458, 10, true),
            retriesAfter458: safeMetric(value.retriesAfter458, 10, true),
            seekPassed: value.seekPassed === true,
            audioPassed: value.audioPassed === true,
            cleanupPassed: value.cleanupPassed === true
        });
    }

    function safeToken(value, maxLength) {
        if (typeof value !== 'string') return null;
        const text = value;
        return /^[a-z0-9][a-z0-9._-]*$/.test(text) && text.length <= maxLength ? text : null;
    }

    function safeMetric(value, maximum, integer) {
        if (value === null || value === undefined) return null;
        if (typeof value !== 'number') throw new Error('INVALID_RUNTIME_RESULT');
        const number = value;
        if (!Number.isFinite(number) || number < 0 || number > maximum) throw new Error('INVALID_RUNTIME_RESULT');
        if (integer && !Number.isInteger(number)) throw new Error('INVALID_RUNTIME_RESULT');
        return integer ? number : Math.round(number * 1000) / 1000;
    }

    function esc(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function pipelineLabel(value) {
        return ({
            'cache-hit': (globalThis.NorvaI18n?.t("ui_web_441832356a7f", { defaultValue: "Cache HLS" }) ?? 'Cache HLS'),
            'video-copy-audio-copy': (globalThis.NorvaI18n?.t("ui_web_c12f36905d8f", { defaultValue: "Copie vidéo + audio" }) ?? 'Copie vidéo + audio'),
            'video-copy-audio-transcode': (globalThis.NorvaI18n?.t("ui_web_c652a457406a", { defaultValue: "Copie vidéo + audio AAC" }) ?? 'Copie vidéo + audio AAC'),
            'video-transcode': (globalThis.NorvaI18n?.t("ui_web_7b0da78519f0", { defaultValue: "Transcodage complet" }) ?? 'Transcodage complet'),
            'terminal-458': (globalThis.NorvaI18n?.t("ui_web_f2cc84b0eb4c", { defaultValue: "Arrêt terminal 458" }) ?? 'Arrêt terminal 458')
        })[value] || (globalThis.NorvaI18n?.t("ui_web_27336a867f1a", { defaultValue: "Indéterminé" }) ?? 'Indéterminé');
    }

    function reasonLabel(value) {
        return ({
            'mkv-h264-copy-ready': (globalThis.NorvaI18n?.t("ui_web_18981a407b14", { defaultValue: "Preuve complète acceptée" }) ?? 'Preuve complète acceptée'),
            'complete-cache-hit': (globalThis.NorvaI18n?.t("ui_web_0036ed1cb5b1", { defaultValue: "Cache complet attesté" }) ?? 'Cache complet attesté'),
            'complete-cache-miss': (globalThis.NorvaI18n?.t("ui_web_3a71ab75b36d", { defaultValue: "Cache absent, fallback sûr" }) ?? 'Cache absent, fallback sûr'),
            'legacy-safe-fallback': (globalThis.NorvaI18n?.t("ui_web_5f58d972282f", { defaultValue: "Pipeline historique demandé" }) ?? 'Pipeline historique demandé'),
            'container': (globalThis.NorvaI18n?.t("ui_web_feee4f444f2b", { defaultValue: "Conteneur non éligible" }) ?? 'Conteneur non éligible'),
            'video-codec': (globalThis.NorvaI18n?.t("ui_web_3659ef84bf94", { defaultValue: "Codec vidéo à convertir" }) ?? 'Codec vidéo à convertir'),
            'seek': (globalThis.NorvaI18n?.t("ui_web_21d22262cbd4", { defaultValue: "Démarrage hors position zéro" }) ?? 'Démarrage hors position zéro'),
            'multi-audio': (globalThis.NorvaI18n?.t("ui_web_650ccf6bf0fd", { defaultValue: "Topologie multi-audio" }) ?? 'Topologie multi-audio'),
            'web-compatibility': (globalThis.NorvaI18n?.t("ui_web_2ec28be0f994", { defaultValue: "Profil Web hors enveloppe" }) ?? 'Profil Web hors enveloppe'),
            'open-gop': (globalThis.NorvaI18n?.t("ui_web_60ccae147e35", { defaultValue: "GOP non autonome" }) ?? 'GOP non autonome'),
            'invalid-timestamps': (globalThis.NorvaI18n?.t("ui_web_60a9c2a35af5", { defaultValue: "Timestamps non fiables" }) ?? 'Timestamps non fiables'),
            'strong-etag-required': (globalThis.NorvaI18n?.t("ui_web_8338ae291423", { defaultValue: "Identité fichier insuffisante" }) ?? 'Identité fichier insuffisante'),
            'provider-busy-terminal': (globalThis.NorvaI18n?.t("ui_web_0a70089eac86", { defaultValue: "Premier HTTP 458 terminal" }) ?? 'Premier HTTP 458 terminal')
        })[value] || value;
    }

    class MkvStrategyLabPage {
        constructor(options) {
            const config = options || {};
            this.runtime = config.runtime && config.runtime.protocol === PROTOCOL ? config.runtime : null;
            this.root = null;
            this.mode = 'contract';
            this.selectedFixtureId = FIXTURES[0].id;
            this.results = new Map();
            this.abortController = null;
            this.runtimeDrainPromise = null;
            this.running = false;
            this.runEpoch = 0;
            this.runReturnFocusAction = null;
            this._onClick = (event) => this.handleClick(event);
            this._onChange = (event) => this.handleChange(event);
        }

        static get protocol() { return PROTOCOL; }
        static get fixtures() { return FIXTURES.map(cloneFixture); }
        static get strategies() { return STRATEGIES.map((item) => ({ ...item })); }
        static evaluateFixture(fixtureId, strategyId) { return evaluateFixture(fixtureId, strategyId); }
        static sanitizeRuntimeResult(value) { return sanitizeRuntimeResult(value); }

        mount(root) {
            if (!root || typeof root.addEventListener !== 'function') throw new Error('MKV_LAB_ROOT_REQUIRED');
            this.unmount();
            this.root = root;
            this.root.classList.add('mkv-lab-host');
            this.root.addEventListener('click', this._onClick);
            this.root.addEventListener('change', this._onChange);
            this.render();
            this.root.querySelector?.('[data-lab-heading]')?.focus?.({ preventScroll: true });
        }

        unmount() {
            this.runEpoch += 1;
            this.abortController?.abort();
            this.abortController = null;
            for (const [id, state] of this.results) {
                if (state?.status === 'running' || state?.status === 'queued') {
                    this.results.set(id, { status: 'cancelled', reason: 'cancelled' });
                }
            }
            this.running = false;
            if (this.root) {
                this.root.removeEventListener('click', this._onClick);
                this.root.removeEventListener('change', this._onChange);
                this.root.classList.remove('mkv-lab-host');
            }
            this.root = null;
        }

        handleChange(event) {
            const control = event.target?.closest?.('[data-lab-mode]');
            if (!control || this.running) return;
            const next = control.value;
            if (next === 'media' && !this.runtime) return;
            if (!['contract', 'media'].includes(next)) return;
            this.mode = next;
            this.results.clear();
            this.render({ type: 'mode', value: next });
        }

        handleClick(event) {
            const action = event.target?.closest?.('[data-lab-action]');
            if (!action || !this.root?.contains(action)) return;
            const kind = action.dataset.labAction;
            if (kind === 'select' && !this.running) {
                const selected = fixtureById(action.dataset.fixtureId);
                if (!selected) return;
                this.selectedFixtureId = selected.id;
                this.render({ type: 'fixture', fixtureId: selected.id });
            } else if (kind === 'run-one' && !this.running) {
                this.runReturnFocusAction = 'run-one';
                void this.runFixtures([this.selectedFixtureId]);
            } else if (kind === 'run-suite' && !this.running) {
                this.runReturnFocusAction = 'run-suite';
                void this.runFixtures(FIXTURES.map((item) => item.id));
            } else if (kind === 'cancel' && this.running) {
                this.abortController?.abort();
            }
        }

        async runFixtures(ids) {
            if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => !fixtureById(id))) {
                throw new Error('UNKNOWN_LAB_CASE');
            }
            this.abortController?.abort();
            this.abortController = new AbortController();
            const signal = this.abortController.signal;
            const epoch = ++this.runEpoch;
            this.running = true;
            for (const id of ids) this.results.set(id, { status: 'queued' });
            this.render({ type: 'action', action: 'cancel' });
            try {
                for (const id of ids) {
                    if (signal.aborted || epoch !== this.runEpoch) break;
                    this.results.set(id, { status: 'running' });
                    this.render({ type: 'action', action: 'cancel' });
                    const startedAt = Date.now();
                    const run = this.mode === 'media'
                        ? await this.runMediaFixture(id, signal)
                        : await this.runContractFixture(id, signal);
                    if (signal.aborted || epoch !== this.runEpoch) break;
                    this.results.set(id, { ...run, elapsedMs: Math.max(0, Date.now() - startedAt) });
                    this.render({ type: 'action', action: 'cancel' });
                    if (run.status === 'cancelled') {
                        this.abortController?.abort();
                        break;
                    }
                }
            } catch (_) {
                if (epoch === this.runEpoch) {
                    const active = ids.find((id) => this.results.get(id)?.status === 'running');
                    if (active) this.results.set(active, { status: signal.aborted ? 'cancelled' : 'failed', reason: signal.aborted ? 'cancelled' : 'runtime-unavailable' });
                }
            } finally {
                if (epoch === this.runEpoch) {
                    if (signal.aborted) {
                        for (const id of ids) {
                            const state = this.results.get(id);
                            if (state?.status === 'running' || state?.status === 'queued') this.results.set(id, { status: 'cancelled', reason: 'cancelled' });
                        }
                    }
                    this.running = false;
                    this.abortController = null;
                    const returnAction = this.runReturnFocusAction || 'run-one';
                    this.runReturnFocusAction = null;
                    this.render({ type: 'action', action: returnAction });
                }
            }
        }

        async runContractFixture(id, signal) {
            await Promise.resolve();
            if (signal.aborted) return { status: 'cancelled', reason: 'cancelled' };
            const item = fixtureById(id);
            const strategies = STRATEGIES.map((strategy) => ({
                strategyId: strategy.id,
                ...evaluateFixture(id, strategy.id)
            }));
            const auto = strategies.find((entry) => entry.strategyId === 'auto');
            const pass = auto.pipeline === item.expected.pipeline
                && auto.reason === item.expected.reason
                && auto.expectedUnder10Seconds === item.expected.under10;
            return { status: pass ? 'passed' : 'failed', reason: pass ? 'contract-match' : 'contract-drift', strategies };
        }

        async runMediaFixture(id, signal) {
            const fixture = fixtureById(id);
            if (!fixture) throw new Error('UNKNOWN_LAB_CASE');
            if (!this.runtime || this.runtime.protocol !== PROTOCOL || typeof this.runtime.runCase !== 'function') {
                throw new Error('RUNTIME_UNAVAILABLE');
            }
            if (this.runtimeDrainPromise) throw new Error('RUNTIME_STILL_DRAINING');
            let timeoutId = null;
            let abortListener = null;
            const request = Object.freeze({ protocol: PROTOCOL, fixtureId: fixture.id });
            const runtimeCall = Promise.resolve().then(() => this.runtime.runCase(request, Object.freeze({ signal })));
            let drainPromise = null;
            drainPromise = runtimeCall.then(() => undefined, () => undefined).finally(() => {
                if (this.runtimeDrainPromise === drainPromise) this.runtimeDrainPromise = null;
            });
            this.runtimeDrainPromise = drainPromise;
            const abortPromise = new Promise((_, reject) => {
                abortListener = () => reject(new Error('RUNTIME_ABORTED'));
                if (signal.aborted) abortListener();
                else signal.addEventListener('abort', abortListener, { once: true });
            });
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    if (this.abortController?.signal === signal) this.abortController.abort();
                    reject(new Error('RUNTIME_TIMEOUT'));
                }, MAX_RUNTIME_MS);
            });
            let raw;
            try {
                raw = await Promise.race([
                    runtimeCall,
                    abortPromise,
                    timeoutPromise
                ]);
            } finally {
                if (timeoutId !== null) clearTimeout(timeoutId);
                if (abortListener) signal.removeEventListener('abort', abortListener);
            }
            const observed = sanitizeRuntimeResult(raw);
            if (observed.status === 'blocked' || observed.status === 'cancelled') {
                return { status: observed.status, reason: observed.reason, observed };
            }
            const expected = fixture.expected;
            const concurrencySafe = Number.isInteger(observed.maximumConcurrentProviderGets)
                && observed.maximumConcurrentProviderGets <= 1;
            const latencySafe = expected.under10
                ? Number.isFinite(observed.ttffMs) && observed.ttffMs <= 10000
                : true;
            const http458Safe = expected.pipeline === 'terminal-458'
                ? observed.http458 === 1
                : observed.http458 === 0;
            const expectedProviderGets = expected.pipeline === 'cache-hit' ? 0 : (fixture.trainingRequired ? 2 : 1);
            const expectedMaximumConcurrentProviderGets = expectedProviderGets > 0 ? 1 : 0;
            const expectedFfmpegSpawns = ['cache-hit', 'terminal-458'].includes(expected.pipeline) ? 0 : 1;
            const resourceSafe = observed.providerGets === expectedProviderGets
                && observed.maximumConcurrentProviderGets === expectedMaximumConcurrentProviderGets
                && observed.ffmpegSpawns === expectedFfmpegSpawns;
            const playbackProofSafe = expected.pipeline === 'terminal-458'
                || (observed.seekPassed === true && observed.audioPassed === true);
            const fluiditySafe = expected.pipeline === 'terminal-458'
                || (observed.rebufferCount === 0 && observed.rebufferMs === 0);
            const pass = observed.status === 'pass' && observed.pipeline === expected.pipeline
                && observed.reason === expected.reason && resourceSafe
                && observed.retriesAfter458 === 0 && concurrencySafe && latencySafe
                && http458Safe && playbackProofSafe && fluiditySafe && observed.cleanupPassed === true;
            return { status: pass ? 'passed' : 'failed', reason: pass ? 'media-match' : 'media-drift', observed };
        }

        render(focusIntent) {
            if (!this.root) return;
            const scrollState = this.captureScrollState();
            const selected = fixtureById(this.selectedFixtureId) || FIXTURES[0];
            const selectedState = this.results.get(selected.id) || null;
            const completed = [...this.results.values()].filter((state) => state.status === 'passed').length;
            const failed = [...this.results.values()].filter((state) => state.status === 'failed').length;
            const blocked = [...this.results.values()].filter((state) => state.status === 'blocked').length;
            const cancelled = [...this.results.values()].filter((state) => state.status === 'cancelled').length;
            const statusText = this.running
                ? (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_3293ff95fd22", {defaultValue: "Campagne en cours · {{p0}} validé{{p1}}", p0:(completed),p1:(completed === 1 ? '' : 's')}) : `Campagne en cours · ${completed} validé${completed === 1 ? '' : 's'}`)
                : (this.results.size
                    ? `${completed} validé${completed === 1 ? '' : 's'} · ${failed} échec${failed === 1 ? '' : 's'} · ${blocked} bloqué${blocked === 1 ? '' : 's'} · ${cancelled} annulé${cancelled === 1 ? '' : 's'}`
                    : (globalThis.NorvaI18n?.t("ui_web_bbbbebd1d211", { defaultValue: "Prêt · aucune lecture lancée" }) ?? 'Prêt · aucune lecture lancée'));

            this.root.innerHTML = `<div class="crm-page mkv-lab" aria-busy="${this.running}">
                <header class="crm-head mkv-lab__head">
                    <div class="crm-head-ic mkv-lab__head-icon"><img src="/img/icons/norva-movies.svg" alt=""></div>
                    <div class="crm-head-tx">
                        <div class="mkv-lab__eyebrow" data-i18n="ui_web_65b05c15c2ea" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p1":(PROTOCOL)}) || "{}")}">QA interne · protocole ${PROTOCOL}</div>
                        <h1 class="crm-h1" data-lab-heading tabindex="-1" data-i18n="ui_web_352b26a1b737">Laboratoire de démarrage MKV</h1>
                        <p class="crm-sub" data-i18n="ui_web_58f27f73e878">Compare le pipeline historique, la copie H.264, la conversion audio et le cache complet sur des cas bornés et reproductibles.</p>
                    </div>
                </header>

                <section class="mkv-lab__guardrail" aria-label="Garanties de la campagne" data-i18n-aria-label="ui_web_8008edf588e1">
                    <span data-i18n="ui_web_2839e8dad281">Aucune URL libre</span><span data-i18n="ui_web_3c0ef2a380fc">1 flux fournisseur maximum</span><span data-i18n="ui_web_23d214e400f5">Premier 458 terminal</span><span data-i18n="ui_web_2f3d90c5c86e">Résultats sans identifiant sensible</span>
                </section>

                <section class="mkv-lab__toolbar" aria-label="Contrôles de campagne" data-i18n-aria-label="ui_web_ee75b3913b75">
                    <fieldset class="mkv-lab__mode" ${this.running ? 'disabled' : ''}>
                        <legend data-i18n="ui_web_0e46ecb9a427">Type de test</legend>
                        <label class="${this.running ? 'is-disabled' : ''}"><input type="radio" name="mkv-lab-mode" data-lab-mode value="contract" ${this.mode === 'contract' ? 'checked' : ''}><norva-i18n data-i18n="ui_web_37d65ff61847"> Contrat hors ligne</norva-i18n></label>
                        <label class="${this.runtime && !this.running ? '' : 'is-disabled'}"><input type="radio" name="mkv-lab-mode" data-lab-mode value="media" ${this.mode === 'media' ? 'checked' : ''} ${this.runtime ? '' : 'disabled'}><norva-i18n data-i18n="ui_web_0a4a69ee0dd1"> Mesure média</norva-i18n></label>
                    </fieldset>
                    <div class="mkv-lab__actions">
                        ${this.running
                            ? '<button type="button" class="mkv-lab__button mkv-lab__button--danger" data-lab-action="cancel" data-i18n="ui_web_f83ef9140ede">Arrêter la campagne</button>'
                            : `<button type="button" class="mkv-lab__button mkv-lab__button--secondary" data-lab-action="run-one" data-i18n="ui_web_8e5f7e1bd85c">Tester ce cas</button>
                               <button type="button" class="mkv-lab__button mkv-lab__button--primary" data-lab-action="run-suite" data-i18n="ui_web_0952c64d9afa" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p0":(FIXTURES.length)}) || "{}")}">Tester les ${FIXTURES.length} cas</button>`}
                    </div>
                    <div class="mkv-lab__status" role="status" aria-live="polite"><span class="mkv-lab__status-dot ${this.running ? 'is-running' : ''}"></span>${esc(statusText)}</div>
                </section>

                ${!this.runtime ? `<div class="mkv-lab__notice" role="note"><strong data-i18n="ui_web_81e8a2dc87d6">Mesure média verrouillée.</strong><norva-i18n data-i18n="ui_web_03b5fd516076"> Le runner serveur de fixtures n’est pas installé dans ce build. Le mode actif vérifie le contrat de routage sans ouvrir de vidéo ni de connexion fournisseur.</norva-i18n></div>` : ''}

                <div class="mkv-lab__workspace">
                    <aside class="mkv-lab__fixtures" aria-label="Cas de test MKV" data-i18n-aria-label="ui_web_76f3e0950186">
                        <div class="mkv-lab__section-title"><span data-i18n="ui_web_367e585e786c">Corpus contrôlé</span><strong>${FIXTURES.length}</strong></div>
                        <div class="mkv-lab__fixture-list" data-lab-scroll="fixtures">${FIXTURES.map((item) => this.fixtureButton(item)).join('')}</div>
                    </aside>
                    <section class="mkv-lab__bench" aria-label="Banc de stratégies VOD" data-i18n-aria-label="ui_web_25395c713e40">
                        ${this.renderSelected(selected, selectedState)}
                    </section>
                </div>
            </div>`;
            this.restoreScrollState(scrollState);
            this.restoreFocus(focusIntent);
        }

        captureScrollState() {
            if (!this.root?.querySelector) return null;
            const fixtures = this.root.querySelector('[data-lab-scroll="fixtures"]');
            const strategies = this.root.querySelector('[data-lab-scroll="strategies"]');
            return {
                fixturesTop: Number.isFinite(fixtures?.scrollTop) ? fixtures.scrollTop : null,
                strategiesLeft: Number.isFinite(strategies?.scrollLeft) ? strategies.scrollLeft : null
            };
        }

        restoreScrollState(state) {
            if (!state || !this.root?.querySelector) return;
            const fixtures = this.root.querySelector('[data-lab-scroll="fixtures"]');
            const strategies = this.root.querySelector('[data-lab-scroll="strategies"]');
            if (fixtures && state.fixturesTop !== null) fixtures.scrollTop = state.fixturesTop;
            if (strategies && state.strategiesLeft !== null) strategies.scrollLeft = state.strategiesLeft;
        }

        restoreFocus(intent) {
            if (!intent || !this.root?.querySelector) return;
            let selector = null;
            if (intent.type === 'action' && ['cancel', 'run-one', 'run-suite'].includes(intent.action)) {
                selector = `[data-lab-action="${intent.action}"]`;
            } else if (intent.type === 'mode' && ['contract', 'media'].includes(intent.value)) {
                selector = `[data-lab-mode][value="${intent.value}"]`;
            } else if (intent.type === 'fixture' && fixtureById(intent.fixtureId)) {
                selector = `[data-lab-action="select"][data-fixture-id="${intent.fixtureId}"]`;
            }
            if (!selector) return;
            this.root.querySelector(selector)?.focus?.({ preventScroll: true });
        }

        fixtureButton(item) {
            const state = this.results.get(item.id);
            const selected = item.id === this.selectedFixtureId;
            const status = state?.status || 'idle';
            return `<button type="button" class="mkv-lab__fixture ${selected ? 'is-selected' : ''}" data-lab-action="select" data-fixture-id="${esc(item.id)}" aria-pressed="${selected}" ${this.running ? 'disabled' : ''}>
                <span class="mkv-lab__fixture-state is-${esc(status)}" aria-hidden="true"></span>
                <span><strong>${esc(item.short)}</strong><small>${esc(item.title)}</small></span>
                <span class="mkv-lab__fixture-outcome ${item.expected.under10 ? 'is-fast' : ''}">${item.expected.under10 ? '&lt;10 s visé' : 'fallback'}</span>
            </button>`;
        }

        renderSelected(item, state) {
            const rows = STRATEGIES.map((strategy) => {
                const planned = evaluateFixture(item.id, strategy.id);
                const measured = state?.strategies?.find((entry) => entry.strategyId === strategy.id) || planned;
                return `<tr>
                    <th scope="row"><strong>${esc(strategy.label)}</strong><small>${esc(strategy.note)}</small></th>
                    <td><span class="mkv-lab__pipeline is-${esc(measured.pipeline)}">${esc(pipelineLabel(measured.pipeline))}</span></td>
                    <td>${esc(reasonLabel(measured.reason))}</td>
                    <td>${measured.targetBufferSeconds === null ? '—' : `${esc(measured.targetBufferSeconds)} s`}</td>
                    <td>${esc(measured.providerGets)}</td>
                    <td>${measured.expectedUnder10Seconds ? '<strong class="mkv-lab__yes" data-i18n="ui_web_0a90407639c4">Oui</strong>' : '<span class="mkv-lab__no" data-i18n="ui_web_60b251b0a0be">Non garanti</span>'}</td>
                </tr>`;
            }).join('');
            const stateMarkup = state ? `<span class="mkv-lab__run-state is-${esc(state.status)}">${esc(({ queued: (globalThis.NorvaI18n?.t("ui_web_2f6c8477e92b", { defaultValue: "En attente" }) ?? 'En attente'), running: (globalThis.NorvaI18n?.t("ui_web_797f5dcd0217", { defaultValue: "En cours" }) ?? 'En cours'), passed: (globalThis.NorvaI18n?.t("ui_web_14d22432eb6d", { defaultValue: "Validé" }) ?? 'Validé'), failed: (globalThis.NorvaI18n?.t("ui_web_fdf3f6d53c9e", { defaultValue: "Échec" }) ?? 'Échec'), blocked: (globalThis.NorvaI18n?.t("ui_web_43645bfc3bda", { defaultValue: "Bloqué" }) ?? 'Bloqué'), cancelled: (globalThis.NorvaI18n?.t("ui_web_58524ce81f34", { defaultValue: "Annulé" }) ?? 'Annulé') })[state.status] || state.status)}</span>` : '<span class="mkv-lab__run-state" data-i18n="ui_web_2b1f05fae2c8">Non exécuté</span>';
            const observed = state?.observed;
            const metric = (label, value) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
            const milliseconds = (value) => Number.isFinite(value) ? `${Math.round(value)} ms` : '—';
            const rate = (value) => Number.isFinite(value) ? `${Number(value).toFixed(2)}×` : '—';
            const runtimeMetrics = observed ? `<section class="mkv-lab__metrics" aria-label="Mesures média réelles" data-i18n-aria-label="ui_web_57806821b78c">
                ${metric('TTFF', milliseconds(observed.ttffMs))}
                ${metric((globalThis.NorvaI18n?.t("ui_web_3c99f1f33643", { defaultValue: "Manifest" }) ?? 'Manifest'), milliseconds(observed.manifestReadyMs))}
                ${metric((globalThis.NorvaI18n?.t("ui_web_5de108bac6f7", { defaultValue: "Premier segment" }) ?? 'Premier segment'), milliseconds(observed.firstSegmentMs))}
                ${metric((globalThis.NorvaI18n?.t("ui_web_2fe1b110968d", { defaultValue: "Débit production" }) ?? 'Débit production'), rate(observed.productionRateX))}
                ${metric((globalThis.NorvaI18n?.t("ui_web_e118af8e8a16", { defaultValue: "Croissance buffer Web" }) ?? 'Croissance buffer Web'), rate(observed.browserBufferRateX))}
                ${metric((globalThis.NorvaI18n?.t("ui_web_dfad502ec48d", { defaultValue: "Rebuffer" }) ?? 'Rebuffer'), `${observed.rebufferCount ?? '—'} · ${milliseconds(observed.rebufferMs)}`)}
                ${metric('GET / concurrence', `${observed.providerGets ?? '—'} / ${observed.maximumConcurrentProviderGets ?? '—'}`)}
                ${metric('FFmpeg / analyseur', `${observed.ffmpegSpawns ?? '—'} / ${observed.analyzerSpawns ?? '—'}`)}
                ${metric('458 / retry', `${observed.http458 ?? '—'} / ${observed.retriesAfter458 ?? '—'}`)}
                ${metric((globalThis.NorvaI18n?.t("ui_web_68b55e18fa78", { defaultValue: "Seek · audio · cleanup" }) ?? 'Seek · audio · cleanup'), `${observed.seekPassed ? 'OK' : '—'} · ${observed.audioPassed ? 'OK' : '—'} · ${observed.cleanupPassed ? 'OK' : 'KO'}`)}
            </section>` : '';
            return `<article class="mkv-lab__case">
                <div class="mkv-lab__case-head">
                    <div><div class="mkv-lab__case-kicker" data-i18n="ui_web_f3b4a4be252b" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p0":(esc(item.id))}) || "{}")}">Fixture ${esc(item.id)}</div><h2>${esc(item.title)}</h2></div>
                    ${stateMarkup}
                </div>
                <dl class="mkv-lab__facts">
                    <div><dt data-i18n="ui_web_ffda1e938e47">Vidéo</dt><dd>${esc(item.video)}</dd></div>
                    <div><dt data-i18n="ui_web_bc1b88907d3b">Audio</dt><dd>${esc(item.audio)}</dd></div>
                    <div><dt data-i18n="ui_web_60b73d9fa917">GOP</dt><dd>${esc(item.gop)}</dd></div>
                    <div><dt data-i18n="ui_web_3711bc6ff06c">Identité</dt><dd>${esc(item.validator)}</dd></div>
                    <div><dt data-i18n="ui_web_b4463f5175c6">Sous-titres</dt><dd>${esc(item.subtitles)}</dd></div>
                </dl>
                ${item.expected.warning === 'subtitle-async' ? '<div class="mkv-lab__warning" data-i18n="ui_web_462583a621cf">La vidéo peut démarrer vite, mais les sous-titres bitmap restent une opération OCR asynchrone distincte.</div>' : ''}
                ${runtimeMetrics}
                <div class="mkv-lab__table-wrap" data-lab-scroll="strategies" tabindex="0" role="region" aria-label="Comparaison des stratégies, défilement horizontal" data-i18n-aria-label="ui_web_70d16f24a140">
                    <table class="mkv-lab__table">
                        <caption data-i18n="ui_web_da8e1db77b70">Comparaison déterministe des stratégies pour cette fixture</caption>
                        <thead><tr><th data-i18n="ui_web_c12194f6fb30">Stratégie</th><th data-i18n="ui_web_37e1c775f452">Pipeline</th><th data-i18n="ui_web_d2dc9dcff2a0">Décision</th><th data-i18n="ui_web_e44193fd2d21">Buffer</th><th data-i18n="ui_web_14e30cd163c7">GET</th><th>&lt;10 s</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
                <section class="mkv-lab__expected" aria-label="Verdict attendu" data-i18n-aria-label="ui_web_dfa729322126">
                    <div><span data-i18n="ui_web_ab37996be5e6">Décision automatique attendue</span><strong>${esc(pipelineLabel(item.expected.pipeline))}</strong></div>
                    <div><span data-i18n="ui_web_c89ac8f0d41a">Motif</span><strong>${esc(reasonLabel(item.expected.reason))}</strong></div>
                    <div><span data-i18n="ui_web_7d9201525b56">Objectif</span><strong>${item.expected.under10 ? (globalThis.NorvaI18n?.t("ui_web_ee417ee2042a", { defaultValue: "Démarrage 6–10 s" }) ?? 'Démarrage 6–10 s') : (globalThis.NorvaI18n?.t("ui_web_64c90c1b4d1e", { defaultValue: "Fluidité avant vitesse" }) ?? 'Fluidité avant vitesse')}</strong></div>
                </section>
            </article>`;
        }
    }

    Object.freeze(MkvStrategyLabPage.prototype);
    global.MkvStrategyLabPage = Object.freeze(MkvStrategyLabPage);
})(window);
