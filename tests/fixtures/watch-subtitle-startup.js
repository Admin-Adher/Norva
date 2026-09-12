/* Offline Android WebView QA. Uses the actual WatchPage renderer, no account or media I/O. */
window.ProviderVersionCardsQA = window.CatalogLanguageQA = (() => {
    let page, expected, selected;
    function mount(kind) {
        const host = document.getElementById('qa-host');
        host.innerHTML = '<video hidden></video><div id="qa-captions" class="captions-list"></div>';
        const video = host.querySelector('video');
        const native = video.addTextTrack('subtitles', 'Subtitle 1', 'dut');
        native.mode = 'showing';
        const useNative = /series/.test(kind);
        page = Object.create(WatchPage.prototype);
        Object.assign(page, {
            captionsList: host.querySelector('#qa-captions'), video, subtitleTracks: [], selectedSubtitleStreamIndex: null,
            hls: useNative ? null : { subtitleTrack: 0, subtitleTracks: [{ name: 'Subtitle 1', lang: 'dut', attrs: { 'X-NORVA-STREAM-INDEX': '2' } }] },
            _hlsOwnsExactSubtitles: !useNative, _canRequestAiSubtitles: () => false,
            burnedSubtitleIntel: () => null, getOcrableSubtitleTracks: () => [],
            getSubtitleStyle: () => ({ scale: 1, bgLabel: 'Dark', colorLabel: 'White' }),
            selectCaptionTrack: (source, index, streamIndex) => { selected = { source, index, streamIndex }; },
        });
        expected = page.getLanguageDisplayName('nl'); selected = null;
        page.updateCaptionsTracks();
        return kind;
    }
    function verify() {
        const row = page.captionsList.querySelector('[data-source="hls"],[data-source="native"]');
        if (!row || row.textContent !== expected || /Subtitle 1/.test(row.textContent)) throw Error('declared Dutch not localized');
        if (!row.classList.contains('active')) throw Error('selected track lost');
        if (row.scrollWidth > row.clientWidth + 1) throw Error('clipped subtitle label');
        if (row.getBoundingClientRect().height < 44) throw Error('small subtitle target');
        const before = page.getCurrentSubtitlePreference();
        if (before.label !== expected || before.index !== 0 || before.language !== 'dut') throw Error('saved subtitle identity changed');
        row.focus(); if (document.activeElement !== row) throw Error('subtitle not focusable'); row.click();
        if (selected?.index !== 0 || selected.source !== row.dataset.source) throw Error('wrong subtitle selected');
        if (selected.source === 'hls' && selected.streamIndex !== 2) throw Error('source stream index changed');
        const policy = page.gatewayStartupBufferOptions({ protocol: 2, eligible: false, reason: 'encode-rate-below-minimum',
            pipeline: 'video-transcode', observedEncodeRateX: 1.58, minimumEncodeRateX: 2, targetBufferSeconds: null });
        if (!policy.adaptive || policy.minimumSeconds !== 96) throw Error('adaptive policy or slow-source safety missing');
        if (page.gatewayStartupBufferOptions(null).adaptive) throw Error('unknown source admitted');
        return { locale: NorvaI18n.language, label: expected, source: selected.source, width: innerWidth };
    }
    return { mount, verify };
})();
