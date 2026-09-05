/**
 * PairTvSheet — phone-WebView pairing flow opened from Home.
 *
 * The TV still creates and polls the code. This component only approves that
 * code for the signed-in cloud account through the existing NorvaCloud seam.
 */
(function () {
    'use strict';

    const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const PAIRING_CODE_LENGTH = 6;

    class PairTvSheet {
        constructor(app) {
            this.app = app;
            this.overlay = null;
            this.panel = null;
            this.form = null;
            this.input = null;
            this.submitButton = null;
            this.errorText = null;
            this.liveRegion = null;
            this.entryState = null;
            this.successState = null;
            this.scanRoot = null;
            this.scanVideo = null;
            this.scanStartButton = null;
            this.scanStream = null;
            this.scanTimer = null;
            this.scanDetector = null;
            this.scanning = false;
            this.requestEpoch = 0;
            this.submitting = false;
        }

        canOpen(options = {}) {
            if (this.app?.isTvMode?.() || this.app?.currentUser?.device) return false;
            const isCloudAccount = Boolean(
                this.app?.currentUser?.cloud || window.API?.isCloudMode?.()
            );
            if (!isCloudAccount) return false;
            if (options.force === true || options.code) return true;
            const isPhoneShell = Boolean(this.app?.isNativePhoneShell?.());
            const catalogReady = Boolean(this.app?.isCatalogReady?.());
            return isPhoneShell && catalogReady;
        }

        build() {
            if (this.overlay?.isConnected) return;

            const overlay = document.createElement('div');
            overlay.id = 'pair-tv-sheet';
            overlay.className = 'modal-overlay pair-tv-sheet';
            overlay.setAttribute('aria-hidden', 'true');
            overlay.setAttribute('inert', '');
            overlay.inert = true;
            overlay.innerHTML = `
                <section class="pair-tv-panel" role="dialog" aria-modal="true"
                    aria-labelledby="pair-tv-title" aria-describedby="pair-tv-description" tabindex="-1">
                    <div class="pair-tv-handle" aria-hidden="true"></div>

                    <div class="pair-tv-state pair-tv-entry-state">
                        <header class="pair-tv-header">
                            <img class="pair-tv-device-icon" src="/img/icons/norva-devices-simple.svg?v=1" alt="">
                            <div class="pair-tv-heading-copy">
                                <h2 id="pair-tv-title" data-i18n="ui_web_094534f82f99">Pair your TV</h2>
                                <p id="pair-tv-description" data-i18n="ui_web_f7da6385027b">Connect your TV to your Norva account.</p>
                            </div>
                            <button type="button" class="pair-tv-close modal-close" aria-label="Close Pair your TV" data-i18n-aria-label="ui_web_d8bfca33587b">
                                <img src="/img/icons/norva-close-simple.svg?v=1" alt="">
                            </button>
                        </header>

                        <ol class="pair-tv-steps" aria-label="Pairing instructions" data-i18n-aria-label="ui_web_e57f5717ecb9">
                            <li>
                                <span class="pair-tv-step-number" aria-hidden="true">1</span>
                                <span><strong data-i18n="ui_web_7c1bcfb43336">Open Norva on your TV and leave the pairing code on screen.</strong></span>
                            </li>
                            <li>
                                <span class="pair-tv-step-number" aria-hidden="true">2</span>
                                <span><strong data-i18n="ui_web_c666b2bc935f">Scan the QR or enter the 6-character code</strong></span>
                            </li>
                        </ol>

                        <div class="pair-tv-scan" hidden>
                            <video class="pair-tv-scan-video" playsinline muted autoplay></video>
                            <button type="button" class="pair-tv-scan-cancel" data-i18n="ui_web_298360e0b166">Cancel scan</button>
                        </div>

                        <form class="pair-tv-form" novalidate>
                            <label class="pair-tv-code-label" for="pair-tv-code" data-i18n="ui_web_39e5fa91923f">TV pairing code</label>
                            <input id="pair-tv-code" name="pairing-code" type="text"
                                inputmode="text" autocomplete="one-time-code" autocapitalize="characters"
                                spellcheck="false" maxlength="6"
                                pattern="[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}"
                                aria-describedby="pair-tv-code-error">
                            <p id="pair-tv-code-error" class="pair-tv-error" hidden></p>
                            <button type="button" class="pair-tv-scan-start" data-i18n="ui_web_5a99f6fa7e98">Scan QR</button>
                            <button type="submit" class="btn btn-primary pair-tv-submit" disabled data-i18n="ui_web_42038d054170">Pair TV</button>
                        </form>

                        <a class="pair-tv-store-link" href="https://play.google.com/store/apps/details?id=tv.norva.tv"
                            target="_blank" rel="noopener noreferrer" aria-label="Open Norva for Android TV on Google Play" data-i18n-aria-label="ui_web_22e7d6584d09">
                            <img src="/img/icons/google-play-mark.svg?v=1" alt="">
                            <span><strong data-i18n="ui_web_539a0c8817af">Need the TV app?</strong><small data-i18n="ui_web_31ee65efe5b4">Open Google Play</small></span>
                            <span aria-hidden="true">↗</span>
                        </a>
                        <p class="pair-tv-store-note" data-i18n="ui_web_ed79dfdea5f3">Google Play can install Norva on a compatible TV signed in to the same Google account.</p>

                        <button type="button" class="pair-tv-manage" data-pair-tv-manage data-i18n="ui_web_f585152ac494">Manage all devices</button>
                    </div>

                    <div class="pair-tv-state pair-tv-success-state" hidden>
                        <img class="pair-tv-success-icon" src="/img/icons/norva-check-circle-simple.svg?v=1" alt="">
                        <h2 id="pair-tv-success-title" tabindex="-1" data-i18n="ui_web_73b2e68cb23d">TV Connected</h2>
                        <p data-i18n="ui_web_487f72b2e898">Your screen is now linked and synced with your account.</p>
                        <button type="button" class="btn btn-primary pair-tv-done" data-i18n="ui_web_11a6767d5674">Done</button>
                        <button type="button" class="pair-tv-manage" data-pair-tv-manage data-i18n="ui_web_f585152ac494">Manage all devices</button>
                    </div>

                    <p class="pair-tv-announcement" role="status" aria-live="polite" aria-atomic="true"></p>
                </section>
            `;

            document.body.appendChild(overlay);
            this.overlay = overlay;
            this.panel = overlay.querySelector('.pair-tv-panel');
            this.form = overlay.querySelector('.pair-tv-form');
            this.input = overlay.querySelector('#pair-tv-code');
            this.submitButton = overlay.querySelector('.pair-tv-submit');
            this.errorText = overlay.querySelector('.pair-tv-error');
            this.liveRegion = overlay.querySelector('.pair-tv-announcement');
            this.entryState = overlay.querySelector('.pair-tv-entry-state');
            this.successState = overlay.querySelector('.pair-tv-success-state');
            this.scanRoot = overlay.querySelector('.pair-tv-scan');
            this.scanVideo = overlay.querySelector('.pair-tv-scan-video');
            this.scanStartButton = overlay.querySelector('.pair-tv-scan-start');

            overlay.querySelector('.modal-close')?.addEventListener('click', () => this.close());
            overlay.querySelector('.pair-tv-done')?.addEventListener('click', () => this.close());
            overlay.querySelectorAll('[data-pair-tv-manage]').forEach((button) => {
                button.addEventListener('click', () => this.manageDevices());
            });
            this.input.addEventListener('input', () => this.onInput());
            this.form.addEventListener('submit', (event) => {
                event.preventDefault();
                void this.submit();
            });
            this.scanStartButton?.addEventListener('click', () => { void this.startScan(); });
            overlay.querySelector('.pair-tv-scan-cancel')?.addEventListener('click', () => this.stopScan());
        }

        open(opener = null, options = {}) {
            if (!this.canOpen(options)) return false;
            this.build();

            if (this.overlay.classList.contains('active')) {
                if (options.code) {
                    this.input.value = this.normalizeCode(options.code);
                    this.onInput();
                }
                this.panel?.focus?.({ preventScroll: true });
                return true;
            }

            this.reset();
            if (options.code) {
                this.input.value = this.normalizeCode(options.code);
                this.onInput();
            }
            try { opener?.focus?.({ preventScroll: true }); } catch (_) { /* best effort */ }
            this.overlay.inert = false;
            this.overlay.removeAttribute('inert');
            this.overlay.removeAttribute('aria-hidden');
            this.overlay.classList.add('active');

            window.NorvaModal?.installHygiene?.(this.overlay, {
                onClose: () => this.close(),
                initialFocus: this.panel
            });
            if (this.scanStartButton) this.scanStartButton.hidden = !this.canScan();
            return true;
        }

        close() {
            if (!this.overlay?.classList.contains('active')) return false;
            this.stopScan();
            this.requestEpoch += 1;
            this.submitting = false;
            this.overlay.classList.remove('active');
            this.overlay.setAttribute('aria-hidden', 'true');
            this.overlay.setAttribute('inert', '');
            this.overlay.inert = true;
            return true;
        }

        reset() {
            this.stopScan();
            this.requestEpoch += 1;
            this.submitting = false;
            this.entryState.hidden = false;
            this.successState.hidden = true;
            this.panel.setAttribute('aria-labelledby', 'pair-tv-title');
            this.panel.setAttribute('aria-describedby', 'pair-tv-description');
            this.input.value = '';
            this.input.readOnly = false;
            this.input.removeAttribute('aria-invalid');
            this.submitButton.disabled = true;
            this.submitButton.removeAttribute('aria-busy');
            this.submitButton.textContent = (globalThis.NorvaI18n?.t("ui_web_42038d054170", { defaultValue: "Pair TV" }) ?? 'Pair TV');
            this.errorText.hidden = true;
            this.errorText.textContent = '';
            this.liveRegion.setAttribute('role', 'status');
            this.liveRegion.setAttribute('aria-live', 'polite');
            this.liveRegion.textContent = '';
        }

        canScan() {
            if (this.app?.isTvMode?.()) return false;
            return Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
        }

        codeFromScanPayload(raw) {
            const text = String(raw || '').trim();
            const query = text.match(/[?&]pair=([A-Za-z0-9]+)/i);
            if (query) {
                const fromQuery = this.normalizeCode(query[1]);
                if (fromQuery.length === PAIRING_CODE_LENGTH) return fromQuery;
            }
            return this.normalizeCode(text);
        }

        applyScannedCode(code) {
            const normalized = this.normalizeCode(code);
            if (normalized.length !== PAIRING_CODE_LENGTH) return false;
            this.input.value = normalized;
            this.onInput();
            this.liveRegion.setAttribute('role', 'status');
            this.liveRegion.setAttribute('aria-live', 'polite');
            this.liveRegion.textContent = (globalThis.NorvaI18n?.t("ui_web_e3ccb6540f73", { defaultValue: "Pairing code filled from the QR." }) ?? 'Pairing code filled from the QR.');
            return true;
        }

        async startScan() {
            if (this.scanning || this.submitting) return false;
            if (!this.canScan()) {
                this.showError((globalThis.NorvaI18n?.t("ui_web_f432388e2f96", { defaultValue: "Scan is not available on this device. Type the 6-character code." }) ?? 'Scan is not available on this device. Type the 6-character code.'));
                return false;
            }
            if (typeof window.BarcodeDetector !== 'function') {
                this.showError((globalThis.NorvaI18n?.t("ui_web_f432388e2f96", { defaultValue: "Scan is not available on this device. Type the 6-character code." }) ?? 'Scan is not available on this device. Type the 6-character code.'));
                return false;
            }

            this.clearError();
            this.scanning = true;
            if (this.scanRoot) this.scanRoot.hidden = false;
            if (this.scanStartButton) this.scanStartButton.hidden = true;
            this.liveRegion.setAttribute('role', 'status');
            this.liveRegion.setAttribute('aria-live', 'polite');
            this.liveRegion.textContent = (globalThis.NorvaI18n?.t("ui_web_2cdec21f05dd", { defaultValue: "Point your camera at the QR on the TV." }) ?? 'Point your camera at the QR on the TV.');

            try {
                this.scanDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
                this.scanStream = await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: { facingMode: { ideal: 'environment' } }
                });
                if (!this.scanning) {
                    this.stopScan();
                    return false;
                }
                if (this.scanVideo) {
                    this.scanVideo.srcObject = this.scanStream;
                    await this.scanVideo.play?.();
                }
                this.scanTimer = window.setInterval(() => { void this.readScanFrame(); }, 280);
                return true;
            } catch (_) {
                this.stopScan();
                this.showError((globalThis.NorvaI18n?.t("ui_web_339fa039ca55", { defaultValue: "Camera access is needed to scan. You can still type the code." }) ?? 'Camera access is needed to scan. You can still type the code.'));
                return false;
            }
        }

        async readScanFrame() {
            if (!this.scanning || !this.scanDetector || !this.scanVideo) return;
            try {
                const codes = await this.scanDetector.detect(this.scanVideo);
                const payload = codes && codes[0] && codes[0].rawValue;
                const code = this.codeFromScanPayload(payload);
                if (code.length !== PAIRING_CODE_LENGTH) return;
                this.stopScan();
                this.applyScannedCode(code);
            } catch (_) { /* keep scanning */ }
        }

        stopScan() {
            this.scanning = false;
            if (this.scanTimer) {
                window.clearInterval(this.scanTimer);
                this.scanTimer = null;
            }
            this.scanDetector = null;
            if (this.scanVideo) {
                try { this.scanVideo.pause?.(); } catch (_) { /* noop */ }
                this.scanVideo.srcObject = null;
            }
            if (this.scanStream) {
                this.scanStream.getTracks().forEach((track) => {
                    try { track.stop(); } catch (_) { /* noop */ }
                });
                this.scanStream = null;
            }
            if (this.scanRoot) this.scanRoot.hidden = true;
            if (this.scanStartButton) this.scanStartButton.hidden = !this.canScan();
        }

        normalizeCode(value) {
            const allowed = new Set(PAIRING_ALPHABET);
            return String(value || '')
                .toUpperCase()
                .split('')
                .filter(character => allowed.has(character))
                .join('')
                .slice(0, PAIRING_CODE_LENGTH);
        }

        onInput() {
            const normalized = this.normalizeCode(this.input.value);
            if (this.input.value !== normalized) this.input.value = normalized;
            this.clearError();
            this.submitButton.disabled = this.submitting || normalized.length !== PAIRING_CODE_LENGTH;
        }

        clearError(options = {}) {
            this.input.removeAttribute('aria-invalid');
            this.errorText.hidden = true;
            this.errorText.textContent = '';
            if (!options.keepAnnouncement) {
                this.liveRegion.setAttribute('role', 'status');
                this.liveRegion.setAttribute('aria-live', 'polite');
                this.liveRegion.textContent = '';
            }
        }

        showError(message) {
            this.input.setAttribute('aria-invalid', 'true');
            this.errorText.textContent = message;
            this.errorText.hidden = false;
            this.liveRegion.setAttribute('role', 'alert');
            this.liveRegion.setAttribute('aria-live', 'assertive');
            this.liveRegion.textContent = message;
        }

        errorMessageForStatus(status) {
            const safeStatus = Number(status);
            if (safeStatus === 401) {
                return (globalThis.NorvaI18n?.t("ui_web_00bd73ae9dae", { defaultValue: "Your session has expired. Sign in again, then retry pairing." }) ?? 'Your session has expired. Sign in again, then retry pairing.');
            }
            if (safeStatus === 402) {
                return (globalThis.NorvaI18n?.t("ui_web_46be7c40688e", { defaultValue: "Your device limit has been reached. Manage your devices before pairing this TV." }) ?? 'Your device limit has been reached. Manage your devices before pairing this TV.');
            }
            if (safeStatus === 409 || safeStatus === 410) {
                return (globalThis.NorvaI18n?.t("ui_web_329e9f578221", { defaultValue: "This code is no longer available. Generate a new one on your TV." }) ?? 'This code is no longer available. Generate a new one on your TV.');
            }
            if (safeStatus === 400 || safeStatus === 404) {
                return (globalThis.NorvaI18n?.t("ui_web_389e0a9880e5", { defaultValue: "Code not found. Check the 6 characters shown on your TV." }) ?? 'Code not found. Check the 6 characters shown on your TV.');
            }
            return (globalThis.NorvaI18n?.t("ui_web_e487dab95843", { defaultValue: "Could not connect to Norva. Check your connection and try again." }) ?? 'Could not connect to Norva. Check your connection and try again.');
        }

        async submit() {
            if (this.submitting) return false;

            const code = this.normalizeCode(this.input.value);
            if (code.length !== PAIRING_CODE_LENGTH) {
                const message = (globalThis.NorvaI18n?.t("ui_web_d4b68603f86b", { defaultValue: "Enter all 6 characters shown on your TV." }) ?? 'Enter all 6 characters shown on your TV.');
                this.showError(message);
                this.input.focus({ preventScroll: true });
                return false;
            }

            const approve = window.NorvaCloud?.pairing?.approve;
            if (typeof approve !== 'function') {
                this.showError(this.errorMessageForStatus(0));
                return false;
            }

            this.submitting = true;
            const requestEpoch = ++this.requestEpoch;
            this.clearError({ keepAnnouncement: false });
            this.input.readOnly = true;
            this.submitButton.disabled = true;
            this.submitButton.setAttribute('aria-busy', 'true');
            this.submitButton.textContent = (globalThis.NorvaI18n?.t("ui_web_72021eb70e91", { defaultValue: "Connecting…" }) ?? 'Connecting…');
            this.liveRegion.setAttribute('role', 'status');
            this.liveRegion.setAttribute('aria-live', 'polite');
            this.liveRegion.textContent = (globalThis.NorvaI18n?.t("ui_web_d2f38e01d299", { defaultValue: "Validating the code." }) ?? 'Validating the code.');

            try {
                await approve(code);
                if (requestEpoch !== this.requestEpoch || !this.overlay.classList.contains('active')) return false;

                this.submitting = false;
                this.input.value = '';
                this.submitButton.removeAttribute('aria-busy');
                this.entryState.hidden = true;
                this.successState.hidden = false;
                this.panel.setAttribute('aria-labelledby', 'pair-tv-success-title');
                this.panel.removeAttribute('aria-describedby');
                this.liveRegion.textContent = (globalThis.NorvaI18n?.t("ui_web_d60ad9fc0637", { defaultValue: "TV connected. Your screen is now linked and synced with your account." }) ?? 'TV connected. Your screen is now linked and synced with your account.');
                if (typeof window.CustomEvent === 'function') {
                    window.dispatchEvent?.(new window.CustomEvent('norva:devices-changed', {
                        detail: { reason: 'paired' }
                    }));
                }
                this.successState.querySelector('h2')?.focus?.({ preventScroll: true });
                return true;
            } catch (error) {
                if (requestEpoch !== this.requestEpoch || !this.overlay.classList.contains('active')) return false;

                this.submitting = false;
                this.input.readOnly = false;
                this.submitButton.removeAttribute('aria-busy');
                this.submitButton.textContent = (globalThis.NorvaI18n?.t("ui_web_42038d054170", { defaultValue: "Pair TV" }) ?? 'Pair TV');
                this.submitButton.disabled = this.input.value.length !== PAIRING_CODE_LENGTH;
                this.showError(this.errorMessageForStatus(error?.status));
                this.input.focus({ preventScroll: true });
                this.input.select?.();
                return false;
            }
        }

        manageDevices() {
            this.close();
            setTimeout(() => this.app?.openScreensSettings?.(), 0);
        }
    }

    window.PairTvSheet = PairTvSheet;
})();
