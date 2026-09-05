/**
 * Premium, profile-scoped Like / Not for me control shared by Movies and Series.
 *
 * The control owns the complete async state machine. Reads are context-tokened so a
 * late response can never paint another title, while writes are serialized and keep
 * draining until the server has received the viewer's latest intent.
 */
(function () {
    'use strict';

    const VALID_RATINGS = new Set([-1, 0, 1]);
    const SAVED_MESSAGE_MS = 1600;
    const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
    function normalizedRating(value) {
        const rating = Number(value);
        return VALID_RATINGS.has(rating) ? rating : 0;
    }

    function createOperationId() {
        try {
            const cryptoApi = globalThis.crypto;
            if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
            if (typeof cryptoApi?.getRandomValues === 'function') {
                const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
                bytes[6] = (bytes[6] & 0x0f) | 0x40;
                bytes[8] = (bytes[8] & 0x3f) | 0x80;
                const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
                return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}`
                    + `-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}`
                    + `-${hex.slice(10).join('')}`;
            }
        } catch (_) { /* compatible fallback below */ }

        // Older WebViews without Web Crypto still need a request-stable UUID-shaped
        // idempotency key. Entropy is only used for uniqueness, never for security.
        const seed = `${Date.now()}-${Math.random()}-${Math.random()}`;
        let cursor = 0;
        const nibble = () => {
            const code = seed.charCodeAt(cursor++ % seed.length);
            return (code + cursor + Math.floor(Math.random() * 16)) & 0xf;
        };
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
            const value = nibble();
            return (token === 'x' ? value : ((value & 0x3) | 0x8)).toString(16);
        });
    }

    function normalizedContext(context) {
        if (!context) return null;
        const sourceId = String(context.sourceId ?? context.source_id ?? '').trim();
        const itemId = String(context.itemId ?? context.item_id ?? '').trim();
        const itemType = String(context.itemType ?? context.item_type ?? '').trim();
        if (!sourceId || !itemId || !itemType) return null;
        return {
            sourceId,
            itemId,
            itemType,
            label: String(context.label || '').trim(),
            key: `${sourceId}\u0000${itemType}\u0000${itemId}`,
        };
    }

    function isOfflineError(error) {
        try {
            if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
        } catch (_) { /* no browser navigator in a unit-test harness */ }
        const signal = `${error?.name || ''} ${error?.message || ''}`.toLowerCase();
        return /network|offline|failed to fetch|load failed|connection|econn/.test(signal);
    }

    class TitleRatingControl {
        constructor({
            root,
            upButton,
            downButton,
            status,
            retryButton,
            getApi = () => window.NorvaCloud?.ratings,
            createOperationId: operationIdFactory = createOperationId,
            requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
        } = {}) {
            this.root = root || null;
            this.upButton = upButton || null;
            this.downButton = downButton || null;
            this.status = status || null;
            this.retryButton = retryButton || null;
            this.getApi = getApi;
            this.createOperationId = operationIdFactory;
            this.requestTimeoutMs = Number.isFinite(Number(requestTimeoutMs))
                ? Math.max(50, Number(requestTimeoutMs))
                : DEFAULT_REQUEST_TIMEOUT_MS;

            this.context = null;
            this.phase = 'idle';
            this.confirmedRating = 0;
            this.desiredRating = 0;
            this.confirmedRevision = 0;
            this._contextVersion = 0;
            this._intentSequence = 0;
            this._latestIntent = null;
            this._retryOperation = null;
            this._saveLoop = null;
            this._retry = null;
            this._errorStage = '';
            this._savedTimer = null;
            this._destroyed = false;
            this._deferred = false;

            this._onUp = () => this.choose(1);
            this._onDown = () => this.choose(-1);
            this._onRetry = () => this.retry();
            this.upButton?.addEventListener('click', this._onUp);
            this.downButton?.addEventListener('click', this._onDown);
            this.retryButton?.addEventListener('click', this._onRetry);

            this.render();
        }

        static fromIds({
            rootId,
            upId,
            downId,
            statusId,
            retryId,
            getApi,
            createOperationId,
        } = {}) {
            return new TitleRatingControl({
                root: document.getElementById(rootId),
                upButton: document.getElementById(upId),
                downButton: document.getElementById(downId),
                status: document.getElementById(statusId),
                retryButton: document.getElementById(retryId),
                getApi,
                createOperationId,
            });
        }

        destroy() {
            this._destroyed = true;
            this._contextVersion += 1;
            clearTimeout(this._savedTimer);
            this.upButton?.removeEventListener('click', this._onUp);
            this.downButton?.removeEventListener('click', this._onDown);
            this.retryButton?.removeEventListener('click', this._onRetry);
        }

        /**
         * A TV catalogue preview is intentionally cheap. Hide this title-level control
         * until the viewer commits into the fiche, preventing the previous title's state
         * from flashing while the D-pad flies over posters.
         */
        defer(context) {
            this._contextVersion += 1;
            clearTimeout(this._savedTimer);
            this._deferred = true;
            this.context = normalizedContext(context);
            this.phase = 'idle';
            this.confirmedRating = 0;
            this.desiredRating = 0;
            this.confirmedRevision = 0;
            this._latestIntent = null;
            this._retryOperation = null;
            this._retry = null;
            this._errorStage = '';
            if (this.root) this.root.hidden = true;
            this.render();
        }

        async load(context) {
            const nextContext = normalizedContext(context);
            const version = ++this._contextVersion;
            clearTimeout(this._savedTimer);
            this._deferred = false;
            this.context = nextContext;
            this.confirmedRating = 0;
            this.desiredRating = 0;
            this.confirmedRevision = 0;
            this._latestIntent = null;
            this._retryOperation = null;
            this._retry = null;
            this._errorStage = '';
            if (this.root) this.root.hidden = false;

            if (!nextContext) {
                this.phase = 'error';
                this._errorStage = 'load';
                this.render();
                return 0;
            }

            const api = this.getApi?.();
            if (!api || (typeof api.getExact !== 'function' && typeof api.get !== 'function')) {
                this.phase = 'error';
                this._errorStage = 'unavailable';
                this.render();
                return 0;
            }

            this.phase = 'loading';
            this.render();

            try {
                const result = typeof api.getExact === 'function'
                    ? await this._withTimeout(api.getExact(nextContext), 'load')
                    : await this._withTimeout(api.get(nextContext), 'load');
                if (!this._isCurrent(version, nextContext.key)) return 0;
                const rating = normalizedRating(result?.rating);
                const revision = this._normalizeRevision(
                    result?.clientRevision ?? result?.revision
                );
                this.confirmedRating = rating;
                this.desiredRating = rating;
                this.confirmedRevision = revision;
                this.phase = 'idle';
                this.render();
                return rating;
            } catch (error) {
                if (!this._isCurrent(version, nextContext.key)) return 0;
                this.phase = isOfflineError(error) ? 'offline' : 'error';
                this._errorStage = 'load';
                this._retry = { kind: 'load', context: nextContext };
                this.render();
                return 0;
            }
        }

        choose(value) {
            const rating = normalizedRating(value);
            if (!this.context || !rating || this._destroyed || this._loadIsBlocked()) return;

            const next = this.desiredRating === rating ? 0 : rating;
            this.desiredRating = next;
            this._retryOperation = null;
            this._latestIntent = {
                operationId: String(this.createOperationId?.() || createOperationId()),
                rating: next,
                expectedRevision: null,
                sourceId: this.context.sourceId,
                itemId: this.context.itemId,
                itemType: this.context.itemType,
                contextVersion: this._contextVersion,
                contextKey: this.context.key,
                sequence: ++this._intentSequence,
            };
            this._retry = null;
            this._errorStage = '';
            this.phase = 'saving';
            clearTimeout(this._savedTimer);
            this.render();
            this._startSaveLoop();
        }

        retry() {
            const retry = this._retry;
            if (!retry || !this.context || retry.context?.key !== this.context.key) return;
            this._retry = null;
            this._errorStage = '';
            if (retry.kind === 'load') {
                this.load(retry.context);
                return;
            }
            const operation = retry.operation;
            if (!operation || operation.contextKey !== this.context.key) return;
            this._retryOperation = operation;
            this.desiredRating = this._latestIntent?.contextKey === this.context.key
                ? this._latestIntent.rating
                : operation.rating;
            this.phase = 'saving';
            this.render();
            this._startSaveLoop();
        }

        _loadIsBlocked() {
            return this.phase === 'loading'
                || ((this.phase === 'error' || this.phase === 'offline')
                    && [
                        'load',
                        'unavailable',
                        'profile_locked',
                        'profile_unavailable',
                        'identity',
                    ].includes(this._errorStage));
        }

        _isCurrent(version, key) {
            return !this._destroyed
                && version === this._contextVersion
                && this.context?.key === key;
        }

        _normalizeRevision(value) {
            const revision = Number(value);
            return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
        }

        _withTimeout(task, stage) {
            let timer = null;
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const error = new Error(`Rating ${stage || 'request'} timed out`);
                    error.code = 'RATING_REQUEST_TIMEOUT';
                    reject(error);
                }, this.requestTimeoutMs);
            });
            return Promise.race([Promise.resolve(task), timeout])
                .finally(() => {
                    if (timer !== null) clearTimeout(timer);
                });
        }

        _startSaveLoop() {
            const version = this._contextVersion;
            const key = this.context?.key;
            if (!key) return null;

            // A request for a previous fiche may still be in flight (or may never
            // settle). It must never gate the viewer's choice on the newly opened
            // title. Only reuse a loop when it belongs to this exact context token.
            if (this._saveLoop?.version === version && this._saveLoop?.key === key) {
                return this._saveLoop.promise;
            }

            const loop = { version, key, promise: null };
            loop.promise = this._drainSaves(version, key)
                .finally(() => {
                    if (this._saveLoop !== loop) return;
                    this._saveLoop = null;
                    if (!this._destroyed
                        && this.context?.key
                        && (this._retryOperation || this._latestIntent)
                        && !this._retry) {
                        this._startSaveLoop();
                    }
                });
            this._saveLoop = loop;
            return loop.promise;
        }

        async _drainSaves(version, key) {
            while (this._isCurrent(version, key)) {
                const operation = this._retryOperation || this._latestIntent;
                if (!operation
                    || operation.contextVersion !== version
                    || operation.contextKey !== key) {
                    return;
                }
                if (operation.expectedRevision === null) {
                    operation.expectedRevision = this.confirmedRevision;
                }
                const api = this.getApi?.();
                if (!api || typeof api.set !== 'function') {
                    this._failSave(
                        operation,
                        new Error('Ratings are unavailable'),
                        version,
                        key
                    );
                    return;
                }

                this.phase = 'saving';
                this.render();
                try {
                    const result = await this._withTimeout(api.set({
                        sourceId: operation.sourceId,
                        itemId: operation.itemId,
                        itemType: operation.itemType,
                        rating: operation.rating,
                        operationId: operation.operationId,
                        expectedRevision: operation.expectedRevision,
                    }), 'save');

                    const conflict = this._conflictSnapshot(result);
                    if (!this._isCurrent(version, key)) {
                        if (!conflict) {
                            const staleRevision = this._normalizeRevision(
                                result?.revision ?? result?.clientRevision
                            ) || (operation.expectedRevision + 1);
                            const staleRating = result && Object.prototype.hasOwnProperty.call(result, 'rating')
                                ? normalizedRating(result.rating)
                                : operation.rating;
                            if (staleRating === operation.rating && result?.applied !== false) {
                                this._dispatchRatingChanged(operation, staleRating, staleRevision);
                                this._refreshCurrentAfterStaleSave();
                            }
                        }
                        return;
                    }

                    if (conflict) {
                        this._reconcileConflict(conflict, version, key);
                        return;
                    }

                    const resultRevision = this._normalizeRevision(
                        result?.revision ?? result?.clientRevision
                    ) || (operation.expectedRevision + 1);
                    const resultRating = result && Object.prototype.hasOwnProperty.call(result, 'rating')
                        ? normalizedRating(result.rating)
                        : operation.rating;

                    // A successful CAS must confirm the value that was sent. Any
                    // surprising authoritative value is treated exactly like a
                    // conflict: paint the server and require a fresh viewer choice.
                    if (resultRating !== operation.rating) {
                        this._reconcileConflict({
                            rating: resultRating,
                            revision: resultRevision,
                        }, version, key);
                        return;
                    }

                    this.confirmedRevision = resultRevision;
                    this.confirmedRating = resultRating;
                    this._dispatchRatingChanged(operation, resultRating, resultRevision);

                    if (this._retryOperation === operation) this._retryOperation = null;
                    if (this._latestIntent === operation) this._latestIntent = null;
                } catch (error) {
                    if (!this._isCurrent(version, key)) return;
                    const conflict = this._conflictSnapshot(error);
                    if (conflict) {
                        this._reconcileConflict(conflict, version, key);
                        return;
                    }
                    this._failSave(operation, error, version, key);
                    return;
                }

                if (!this._isCurrent(version, key)) return;
                const nextOperation = this._retryOperation || this._latestIntent;
                if (nextOperation) {
                    this.desiredRating = nextOperation.rating;
                    this.phase = 'saving';
                    this.render();
                    continue;
                }

                this.desiredRating = this.confirmedRating;
                this.phase = 'saved';
                this._errorStage = '';
                this._retry = null;
                this.render();
                this._scheduleIdle(version, key);
            }
        }

        _failSave(operation, error, version, key) {
            if (!this._isCurrent(version, key)) return;
            // Honest UI: restore the last server-confirmed choice and offer a retry of
            // the failed intent. The control never leaves an unsaved choice highlighted.
            this.desiredRating = this.confirmedRating;
            this._retryOperation = null;
            this.phase = isOfflineError(error) ? 'offline' : 'error';
            this._errorStage = this._terminalSaveErrorStage(error) || 'save';
            if (this._errorStage !== 'save' && this._latestIntent === operation) {
                this._latestIntent = null;
            }
            this._retry = this._errorStage === 'save'
                ? {
                    kind: 'save',
                    operation,
                    context: this.context,
                }
                : null;
            this.render();
        }

        _errorCode(value) {
            const payload = value?.payload && typeof value.payload === 'object'
                ? value.payload
                : value;
            return String(
                payload?.code
                ?? payload?.details?.code
                ?? value?.code
                ?? ''
            ).trim().toLowerCase();
        }

        _terminalSaveErrorStage(error) {
            const code = this._errorCode(error);
            if (code === 'profile_locked') return 'profile_locked';
            if (code === 'profile_unavailable') return 'profile_unavailable';
            if ([
                'rating_identity_invalid',
                'rating_source_not_found',
                'title_identity_unavailable',
            ].includes(code)) return 'identity';
            return '';
        }

        _conflictSnapshot(value) {
            const payload = value?.payload && typeof value.payload === 'object'
                ? value.payload
                : value;
            const code = this._errorCode(value);
            const hasAuthoritativeState = [
                payload?.rating,
                payload?.currentRating,
                payload?.current_rating,
            ].some((candidate) => candidate !== undefined)
                && [
                    payload?.revision,
                    payload?.clientRevision,
                    payload?.currentRevision,
                    payload?.current_revision,
                ].some((candidate) => candidate !== undefined);
            const isConflict = payload?.applied === false
                || payload?.conflict === true
                || (code.includes('conflict') && hasAuthoritativeState);
            if (!isConflict) return null;
            return {
                rating: normalizedRating(
                    payload?.rating ?? payload?.currentRating ?? payload?.current_rating
                ),
                revision: this._normalizeRevision(
                    payload?.revision
                    ?? payload?.clientRevision
                    ?? payload?.currentRevision
                    ?? payload?.current_revision
                ),
            };
        }

        _reconcileConflict(snapshot, version, key) {
            if (!this._isCurrent(version, key)) return;
            this.confirmedRating = normalizedRating(snapshot?.rating);
            this.confirmedRevision = Math.max(
                this.confirmedRevision,
                this._normalizeRevision(snapshot?.revision)
            );
            this.desiredRating = this.confirmedRating;
            this._retryOperation = null;
            this._latestIntent = null;
            this.phase = 'error';
            this._errorStage = 'conflict';
            this._retry = null;
            this.render();
        }

        _dispatchRatingChanged(operation, rating, revision) {
            try {
                if (typeof document === 'undefined' || typeof document.dispatchEvent !== 'function') return;
                const detail = {
                    sourceId: operation.sourceId || '',
                    itemId: operation.itemId || '',
                    itemType: operation.itemType || '',
                    rating,
                    revision,
                    operationId: operation.operationId,
                };
                const EventCtor = globalThis.CustomEvent || window.CustomEvent;
                if (typeof EventCtor !== 'function') return;
                document.dispatchEvent(new EventCtor('norva:title-rating-changed', { detail }));
            } catch (_) { /* cache invalidation event is best-effort */ }
        }

        _refreshCurrentAfterStaleSave() {
            if (this._destroyed || this._deferred || !this.context || this.phase === 'saving') return;
            const currentContext = { ...this.context };
            Promise.resolve().then(() => {
                if (this._destroyed
                    || this._deferred
                    || !this.context
                    || this.context.key !== currentContext.key
                    || this.phase === 'saving') return;
                this.load(currentContext);
            });
        }

        _scheduleIdle(version, key) {
            clearTimeout(this._savedTimer);
            this._savedTimer = setTimeout(() => {
                if (!this._isCurrent(version, key) || this.phase !== 'saved') return;
                this.phase = 'idle';
                this.render();
            }, SAVED_MESSAGE_MS);
        }

        _statusMessage() {
            if (this.phase === 'loading') return (globalThis.NorvaI18n?.t("ui_web_c765a3fba77a", { defaultValue: "Loading your preference…" }) ?? 'Loading your preference…');
            if (this.phase === 'saving') return (globalThis.NorvaI18n?.t("ui_web_23e39291d613", { defaultValue: "Saving…" }) ?? 'Saving…');
            if (this.phase === 'saved') return (globalThis.NorvaI18n?.t("ui_web_c250ed40f3a9", { defaultValue: "Preference saved." }) ?? 'Preference saved.');
            if (this.phase === 'offline') {
                return this._errorStage === 'save'
                    ? (globalThis.NorvaI18n?.t("ui_web_a35fbedc0891", { defaultValue: "You’re offline. Your previous choice was restored." }) ?? 'You’re offline. Your previous choice was restored.')
                    : (globalThis.NorvaI18n?.t("ui_web_a8e50cd190bd", { defaultValue: "You’re offline. Reconnect to load your preference." }) ?? 'You’re offline. Reconnect to load your preference.');
            }
            if (this.phase === 'error') {
                if (this._errorStage === 'unavailable') return (globalThis.NorvaI18n?.t("ui_web_d7b57dca1379", { defaultValue: "Sign in to save your preference." }) ?? 'Sign in to save your preference.');
                if (this._errorStage === 'conflict') {
                    return (globalThis.NorvaI18n?.t("ui_web_6c88a48c1c70", { defaultValue: "Your preference changed on another device. Choose again." }) ?? 'Your preference changed on another device. Choose again.');
                }
                if (this._errorStage === 'profile_locked') {
                    return (globalThis.NorvaI18n?.t("ui_web_dd600f1b1cb1", { defaultValue: "This profile is locked. Switch profiles or update your plan." }) ?? 'This profile is locked. Switch profiles or update your plan.');
                }
                if (this._errorStage === 'profile_unavailable') {
                    return (globalThis.NorvaI18n?.t("ui_web_d07f31251d9f", { defaultValue: "This profile is no longer available. Choose another profile." }) ?? 'This profile is no longer available. Choose another profile.');
                }
                if (this._errorStage === 'identity') {
                    return (globalThis.NorvaI18n?.t("ui_web_5af4b77b5fa4", { defaultValue: "This title changed in your catalog. Reopen it and try again." }) ?? 'This title changed in your catalog. Reopen it and try again.');
                }
                return this._errorStage === 'save'
                    ? (globalThis.NorvaI18n?.t("ui_web_bc71ce80ca6b", { defaultValue: "Couldn’t save. Your previous choice was restored." }) ?? 'Couldn’t save. Your previous choice was restored.')
                    : (globalThis.NorvaI18n?.t("ui_web_d816f3b0d966", { defaultValue: "Couldn’t load your preference." }) ?? 'Couldn’t load your preference.');
            }
            return '';
        }

        _buttonLabel(rating) {
            if (rating === 1) {
                return this.desiredRating === 1 ? (globalThis.NorvaI18n?.t("ui_web_daac3bde7c99", { defaultValue: "Remove Like" }) ?? 'Remove Like') : (globalThis.NorvaI18n?.t("ui_web_e96aa02e91fd", { defaultValue: "Like this title" }) ?? 'Like this title');
            }
            return this.desiredRating === -1 ? (globalThis.NorvaI18n?.t("ui_web_c198943da380", { defaultValue: "Remove Not for me" }) ?? 'Remove Not for me') : (globalThis.NorvaI18n?.t("ui_web_d81123b5e9a4", { defaultValue: "Not for me" }) ?? 'Not for me');
        }

        render() {
            const busy = this.phase === 'loading' || this.phase === 'saving';
            const blocked = !this.context || this._loadIsBlocked();
            const hasRetry = Boolean(this._retry);

            if (this.root) {
                this.root.dataset.state = this.phase;
                this.root.setAttribute('aria-busy', String(busy));
                this.root.classList.toggle('has-feedback', Boolean(this._statusMessage()));
            }

            for (const [button, rating] of [[this.upButton, 1], [this.downButton, -1]]) {
                if (!button) continue;
                const selected = this.desiredRating === rating;
                const label = this._buttonLabel(rating);
                button.disabled = blocked;
                button.classList.toggle('active', selected);
                button.classList.toggle('is-selected', selected);
                button.setAttribute('aria-pressed', String(selected));
                button.setAttribute('aria-label', label);
                button.title = label;
            }

            if (this.status) this.status.textContent = this._statusMessage();
            if (this.retryButton) {
                this.retryButton.hidden = !hasRetry;
                this.retryButton.disabled = !hasRetry;
            }
        }
    }

    window.TitleRatingControl = TitleRatingControl;
})();
