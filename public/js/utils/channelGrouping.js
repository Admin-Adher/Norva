/**
 * Channel grouping + country ordering.
 *
 * Providers ship the same channel many times with quality/codec/country
 * decorations ("TF1 HD", "4K | TF1", "FR | TF1 [H265]"...). This module
 * canonicalises each raw name, groups the variants into one logical channel,
 * and (for the user's country) orders them by the national channel number.
 *
 * It is intentionally framework-agnostic and side-effect free so the same
 * logic can later run server-side at sync time. Exposed as window.ChannelGrouping.
 */
(function () {
    'use strict';

    // Real channel logos from the public tv-logos repo (raw.githubusercontent,
    // CDN-backed, reliable) — used when the provider's logo host is dead/empty
    // (the FR nationals all point to the now-defunct aptvpix.net).
    const LOGO_BASE = 'https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/france/';

    // National line-ups. `kind: 'national'` channels are ordered by `lcn` and
    // pinned to the top. `aliases` must be the *canonical core* after
    // normalisation (lowercase, de-accented, quality/codec/country stripped).
    const COUNTRY_LINEUPS = {
        FR: [
            { key: 'tf1', lcn: 1, name: 'TF1', aliases: ['tf1'], logo: LOGO_BASE + 'tf1-fr.png' },
            { key: 'france2', lcn: 2, name: 'France 2', aliases: ['france 2'], logo: LOGO_BASE + 'france-2-fr.png' },
            { key: 'france3', lcn: 3, name: 'France 3', aliases: ['france 3'], logo: LOGO_BASE + 'france-3-fr.png' },
            { key: 'france4', lcn: 4, name: 'France 4', aliases: ['france 4'], logo: LOGO_BASE + 'france-4-fr.png' },
            { key: 'france5', lcn: 5, name: 'France 5', aliases: ['france 5'], logo: LOGO_BASE + 'france-5-fr.png' },
            { key: 'm6', lcn: 6, name: 'M6', aliases: ['m6'], logo: LOGO_BASE + 'm6-fr.png' },
            { key: 'arte', lcn: 7, name: 'Arte', aliases: ['arte'], logo: LOGO_BASE + 'arte-fr.png' },
            { key: 'c8', lcn: 8, name: 'C8', aliases: ['c8'], logo: LOGO_BASE + 'c8-fr.png' },
            { key: 'w9', lcn: 9, name: 'W9', aliases: ['w9'], logo: LOGO_BASE + 'w9-fr.png' },
            { key: 'tmc', lcn: 10, name: 'TMC', aliases: ['tmc'], logo: LOGO_BASE + 'tmc-fr.png' },
            { key: 'tfx', lcn: 11, name: 'TFX', aliases: ['tfx'], logo: LOGO_BASE + 'tfx-fr.png' },
            { key: 'nrj12', lcn: 12, name: 'NRJ 12', aliases: ['nrj 12', 'nrj12'], logo: LOGO_BASE + 'nrj-12-fr.png' },
            { key: 'lcp', lcn: 13, name: 'LCP', aliases: ['lcp', 'public senat'], logo: LOGO_BASE + 'lcp-fr.png' },
            { key: 'bfmtv', lcn: 15, name: 'BFM TV', aliases: ['bfm tv', 'bfmtv'], logo: LOGO_BASE + 'bfm-tv-fr.png' },
            { key: 'cnews', lcn: 16, name: 'CNews', aliases: ['cnews'], logo: LOGO_BASE + 'c-news-fr.png' },
            { key: 'cstar', lcn: 17, name: 'CStar', aliases: ['cstar'], logo: LOGO_BASE + 'c-star-fr.png' },
            { key: 'gulli', lcn: 18, name: 'Gulli', aliases: ['gulli'], logo: LOGO_BASE + 'gulli-fr.png' },
            { key: 'tf1sf', lcn: 19, name: 'TF1 Séries Films', aliases: ['tf1 series films', 'tf1 series film', 'tf1 series et films'], logo: LOGO_BASE + 'tf1-series-films-fr.png' },
            { key: 'lequipe', lcn: 21, name: "L'Équipe", aliases: ['l equipe', 'lequipe'], logo: LOGO_BASE + 'lequipe-fr.png' },
            { key: '6ter', lcn: 22, name: '6ter', aliases: ['6ter'], logo: LOGO_BASE + '6ter-fr.png' },
            { key: 'rmcstory', lcn: 23, name: 'RMC Story', aliases: ['rmc story'], logo: LOGO_BASE + 'rmc-story-fr.png' },
            { key: 'rmcdecouverte', lcn: 24, name: 'RMC Découverte', aliases: ['rmc decouverte'], logo: LOGO_BASE + 'rmc-decouverte-fr.png' },
            { key: 'cherie25', lcn: 25, name: 'Chérie 25', aliases: ['cherie 25', 'cherie25'] },
            { key: 'lci', lcn: 26, name: 'LCI', aliases: ['lci'], logo: LOGO_BASE + 'lci-fr.png' },
            { key: 'franceinfo', lcn: 27, name: 'Franceinfo', aliases: ['france info', 'franceinfo'], logo: LOGO_BASE + 'franceinfo-fr.png' }
        ]
    };

    const QUALITY_TOKENS = { '4k': '4K', 'uhd': '4K', 'hdr': 'HDR', 'fhd': 'FHD', 'superhd': 'Super HD', 'hd': 'HD', 'sd': 'SD' };
    const CODEC_TOKENS = new Set(['h265', 'hevc', 'h264', 'avc']);
    // Country prefixes that mark a *foreign* feed (not the user's national channel).
    const FOREIGN_PREFIXES = new Set(['ar', 'br', 'ca', 'de', 'it', 'pl', 'es', 'us', 'uk', 'nl', 'be', 'ch', 'pt', 'ro', 'tr', 'ru', 'gr', 'dz', 'ma', 'tn', 'sa', 'ae', 'qa', 'al', 'rs', 'bg', 'hu', 'cz', 'in', 'pk']);

    /** Decode circled / styled unicode letters to plain ASCII, then strip diacritics. */
    function destyle(s) {
        let out = '';
        for (const ch of String(s || '')) {
            const c = ch.codePointAt(0);
            if (c >= 0x24B6 && c <= 0x24CF) out += String.fromCharCode(65 + (c - 0x24B6));        // Ⓐ–Ⓩ
            else if (c >= 0x24D0 && c <= 0x24E9) out += String.fromCharCode(97 + (c - 0x24D0));   // ⓐ–ⓩ
            else if (c >= 0x1D400 && c <= 0x1D419) out += String.fromCharCode(65 + (c - 0x1D400)); // bold A–Z
            else if (c >= 0x1D41A && c <= 0x1D433) out += String.fromCharCode(97 + (c - 0x1D41A)); // bold a–z
            else out += ch;
        }
        return out.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    }

    /**
     * Parse a raw channel name into its canonical core + quality/codec/country signals.
     * @returns {{coreStr:string, quals:string[], codec:boolean, foreign:string|null}}
     */
    function parseName(raw) {
        let work = destyle(raw).toLowerCase();
        let prefix = '';
        const pm = work.match(/^([a-z0-9 \-]+?)\s*\|\s*/);
        if (pm) { prefix = pm[1].trim(); work = work.slice(pm[0].length); }
        // Detect the codec BEFORE stripping brackets — providers tag it as
        // "[H265]", and stripping first would lose the signal (collapsing an
        // H265 feed and an H264 feed into one deduped label).
        const codecHint = /\b(h265|hevc)\b/.test(work) || /\b(h265|hevc)\b/.test(prefix);
        work = work.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');

        const quals = [];
        let codec = codecHint, foreign = null;
        prefix.split(/[^a-z0-9]+/).filter(Boolean).forEach(t => {
            if (QUALITY_TOKENS[t]) quals.push(QUALITY_TOKENS[t]);
            else if (t === 'fr' || t === 'kids') { /* fr / kids-fr → keep */ }
            else if (FOREIGN_PREFIXES.has(t)) foreign = t;
        });

        const core = [];
        work.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).forEach(t => {
            if (QUALITY_TOKENS[t]) quals.push(QUALITY_TOKENS[t]);
            else if (CODEC_TOKENS.has(t)) codec = (t === 'h265' || t === 'hevc') || codec;
            else core.push(t);
        });
        return { coreStr: core.join(' '), quals, codec, foreign };
    }

    function qualityLabel(p) {
        let base = 'HD';
        if (p.quals.includes('4K')) base = '4K';
        else if (p.quals.includes('FHD')) base = 'FHD';
        else if (p.quals.includes('Super HD')) base = 'Super HD';
        else if (p.quals.includes('HD')) base = 'HD';
        else if (p.quals.includes('SD')) base = 'SD';
        if (p.quals.includes('HDR')) base += ' HDR';
        if (p.codec) base += ' · H265';
        return base;
    }

    // Lower rank = higher quality. Used for ordering + default pick.
    function rankOf(label) {
        if (label.startsWith('4K')) return 0;
        if (label.startsWith('Super HD') || label.startsWith('FHD')) return 1;
        if (label.startsWith('HD')) return 2;
        if (label.startsWith('SD')) return 3;
        return 2;
    }

    function buildAliasMap(country) {
        const lineup = COUNTRY_LINEUPS[country] || [];
        const map = {};
        lineup.forEach(d => d.aliases.forEach(a => { map[a] = d; }));
        return { lineup, map };
    }

    function healthRank(ch) {
        const m = (ch.playbackMode || ch.playback_mode || 'unknown');
        if (m === 'broken' || m === 'hs') return 3;
        if (m === 'directHls' || m === 'transcoding' || m === 'ok') return 0;
        return 1; // unknown
    }

    /**
     * Pick the default variant: best quality that is healthy (or unknown),
     * capped at FHD — never auto-open in 4K. Falls back to best available.
     */
    function pickDefault(variants) {
        const ok = variants.filter(v => v.healthRank < 3);
        const pool = (ok.length ? ok : variants).slice();
        // candidates capped at FHD (rank >= 1); prefer them, else allow 4K.
        const capped = pool.filter(v => v.rank >= 1);
        const list = (capped.length ? capped : pool);
        list.sort((a, b) => (a.healthRank - b.healthRank) || (a.rank - b.rank));
        return list[0] || variants[0] || null;
    }

    /**
     * Build the ordered list of variants for the next-best fallback chain,
     * starting after `current` (best healthy first).
     */
    function fallbackOrder(variants, currentStreamId) {
        return variants
            .filter(v => String(v.streamId) !== String(currentStreamId))
            .sort((a, b) => (a.healthRank - b.healthRank) || (a.rank - b.rank));
    }

    function variantFrom(ch, p) {
        const label = qualityLabel(p);
        return {
            label,
            rank: rankOf(label),
            healthRank: healthRank(ch),
            streamId: ch.streamId != null ? ch.streamId : (ch.stream_id != null ? ch.stream_id : ch.id),
            sourceId: ch.sourceId || ch.source_id,
            raw: ch.name || ch.title || '',
            channel: ch
        };
    }

    function dedupeVariants(variants) {
        const seen = new Set(); const out = [];
        for (const v of variants.slice().sort((a, b) => a.rank - b.rank)) {
            if (seen.has(v.label)) continue;
            seen.add(v.label); out.push(v);
        }
        return out;
    }

    /**
     * Classify a non-national FR-ish name into a regional destination
     * (own content) vs. a multiplex/overflow feed (ephemeral).
     */
    function classifyExtra(coreStr) {
        if (/\b(corse|via stella|noa|alsace|bretagne|paris ile|cote d azur|aquitaine|occitanie|nord|grand est|africa|afrique)\b/.test(coreStr)) return 'regional';
        if (/\b(live|event|foot|sport|multiplex|hd \d+|\d+)$/.test(coreStr) || /\blive\b/.test(coreStr)) return 'multiplex';
        return 'regional';
    }

    /**
     * Group a flat channel list into logical channels for a country.
     * @returns {{primary:Object[], regional:Object[], multiplex:Object[], other:Object[]}}
     *   primary  – national channels, ordered by lcn, each {key,name,lcn,variants[],defaultVariant}
     *   regional – sub-channels with own content (own logical entries)
     *   multiplex– overflow/event feeds (collapsed by default)
     *   other    – everything else, untouched (kept for the rest of the list)
     */
    function group(channels, country) {
        const { lineup, map } = buildAliasMap(country);
        const groups = {};       // key -> logical channel
        const regional = [];
        const multiplex = [];
        const other = [];

        for (const ch of (channels || [])) {
            const name = ch.name || ch.title || '';
            const p = parseName(name);
            if (p.foreign) { other.push(ch); continue; }
            const d = map[p.coreStr];
            if (d) {
                if (!groups[d.key]) groups[d.key] = { key: d.key, name: d.name, lcn: d.lcn, country, logo: d.logo || null, variants: [] };
                groups[d.key].variants.push(variantFrom(ch, p));
                continue;
            }
            // not an exact national match — is it a sub-channel of a known one?
            let parent = null;
            for (const d2 of lineup) {
                if (d2.aliases.some(a => p.coreStr.startsWith(a + ' '))) { parent = d2; break; }
            }
            if (parent) {
                const kind = classifyExtra(p.coreStr);
                const entry = { name: name.replace(/^[^|]*\|\s*/, '').trim() || name, parentKey: parent.key, parentName: parent.name, country, variants: [variantFrom(ch, p)], channel: ch };
                (kind === 'multiplex' ? multiplex : regional).push(entry);
            } else {
                other.push(ch);
            }
        }

        const primary = Object.values(groups)
            .map(g => {
                g.variants = dedupeVariants(g.variants);
                g.defaultVariant = pickDefault(g.variants);
                return g;
            })
            .sort((a, b) => a.lcn - b.lcn);

        return { primary, regional, multiplex, other };
    }

    /**
     * Find every variant of the logical channel that `channel` belongs to,
     * searching the full catalog. Used by the player to build its quality menu
     * without requiring the whole list to be pre-grouped.
     * @returns {{name:string, variants:Object[], defaultVariant:Object}|null}
     */
    function variantsForChannel(channel, allChannels, country) {
        const { map } = buildAliasMap(country);
        const p = parseName(channel.name || channel.title || '');
        const d = !p.foreign ? map[p.coreStr] : null;
        const sameSource = (c) => (c.sourceId || c.source_id) === (channel.sourceId || channel.source_id);

        let variants;
        if (d) {
            variants = (allChannels || []).filter(c => {
                if (!sameSource(c)) return false;
                const pp = parseName(c.name || c.title || '');
                return !pp.foreign && map[pp.coreStr] === d;
            }).map(c => variantFrom(c, parseName(c.name || c.title || '')));
        } else {
            // Unknown channel: group purely by canonical core (generic dedupe).
            variants = (allChannels || []).filter(c => {
                if (!sameSource(c)) return false;
                const pp = parseName(c.name || c.title || '');
                return !pp.foreign && pp.coreStr === p.coreStr;
            }).map(c => variantFrom(c, parseName(c.name || c.title || '')));
        }

        variants = dedupeVariants(variants);
        if (!variants.length) return null;
        return {
            name: d ? d.name : (channel.name || channel.title || '').replace(/^[^|]*\|\s*/, '').trim(),
            logo: d ? (d.logo || null) : null,
            variants,
            defaultVariant: pickDefault(variants)
        };
    }

    /**
     * Curated real logo for a raw or canonical channel name, or null if the
     * channel isn't a known national channel for the country.
     */
    function logoForName(name, country) {
        const { map } = buildAliasMap(country);
        const p = parseName(name);
        if (p.foreign) return null;
        const d = map[p.coreStr];
        return (d && d.logo) || null;
    }

    window.ChannelGrouping = {
        COUNTRY_LINEUPS,
        destyle,
        parseName,
        qualityLabel,
        group,
        variantsForChannel,
        logoForName,
        pickDefault,
        fallbackOrder
    };
})();
