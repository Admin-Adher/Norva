/**
 * NorvaModal — one small, promise-based dialog service to replace native
 * alert()/confirm() across the app (which are unstyleable, untranslatable and
 * unusable on Android TV / with a D-pad).
 *
 *   await NorvaModal.confirm('Delete this source?', { danger: true }) → boolean
 *   await NorvaModal.alert('Something went wrong')                    → true
 *   NorvaModal.toast('Saved', 'success')                             → transient toast
 *
 * Design goals it satisfies (from the Settings audit): a single system, a real
 * focus trap, focus restore on close, Escape / TV Back to cancel, CSP-safe (no
 * inline handlers, textContent for all caller strings), and big TV-safe buttons.
 */
(function () {
    'use strict';

    const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

    function focusablesIn(root) {
        return Array.from(root.querySelectorAll(FOCUSABLE))
            .filter(el => !el.disabled && el.offsetParent !== null);
    }

    function open(opts) {
        const {
            title = '',
            message = '',
            confirmLabel = 'OK',
            cancelLabel = null,   // null → alert (single button)
            danger = false
        } = opts || {};

        return new Promise((resolve) => {
            const prevFocus = document.activeElement;

            const overlay = document.createElement('div');
            overlay.className = 'norva-modal-overlay';
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');

            const card = document.createElement('div');
            card.className = 'norva-modal' + (danger ? ' is-danger' : '');
            overlay.appendChild(card);

            if (title) {
                const h = document.createElement('div');
                h.className = 'norva-modal-title';
                h.textContent = title;
                overlay.setAttribute('aria-label', title);
                card.appendChild(h);
            }

            const body = document.createElement('div');
            body.className = 'norva-modal-message';
            body.textContent = message;
            card.appendChild(body);

            const actions = document.createElement('div');
            actions.className = 'norva-modal-actions';
            card.appendChild(actions);

            let cancelBtn = null;
            if (cancelLabel != null) {
                cancelBtn = document.createElement('button');
                cancelBtn.type = 'button';
                cancelBtn.className = 'norva-modal-btn norva-modal-cancel';
                cancelBtn.textContent = cancelLabel;
                actions.appendChild(cancelBtn);
            }

            const confirmBtn = document.createElement('button');
            confirmBtn.type = 'button';
            confirmBtn.className = 'norva-modal-btn norva-modal-confirm' + (danger ? ' is-danger' : '');
            confirmBtn.textContent = confirmLabel;
            actions.appendChild(confirmBtn);

            let settled = false;
            function close(result) {
                if (settled) return;
                settled = true;
                document.removeEventListener('keydown', onKey, true);
                overlay.remove();
                // Restore focus to whatever opened the dialog (keyboard/TV continuity).
                try { if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus(); } catch (_) { /* noop */ }
                resolve(result);
            }

            function onKey(e) {
                if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') {
                    e.preventDefault();
                    e.stopPropagation();
                    close(false);
                    return;
                }
                if (e.key === 'Tab') {
                    const f = focusablesIn(overlay);
                    if (!f.length) return;
                    const first = f[0];
                    const last = f[f.length - 1];
                    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
                }
            }

            confirmBtn.addEventListener('click', () => close(true));
            if (cancelBtn) cancelBtn.addEventListener('click', () => close(false));
            // Backdrop click cancels (treated as "no" — never the destructive action).
            overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });

            document.body.appendChild(overlay);
            document.addEventListener('keydown', onKey, true);

            // Default focus: for a destructive confirm, land on Cancel so a stray
            // Enter / OK press never deletes; otherwise focus the primary button.
            // setTimeout (not rAF) so focus lands even in WebViews that throttle frames.
            setTimeout(() => {
                const target = (danger && cancelBtn) ? cancelBtn : confirmBtn;
                try { target.focus(); } catch (_) { /* noop */ }
            }, 0);
        });
    }

    /**
     * Attach the same hygiene NorvaModal guarantees (Escape/Back close, Tab focus-trap,
     * focus capture + restore) to a PRE-EXISTING app modal whose content is app-owned
     * (the shared #modal, #edit-user-modal, …). These are shown by adding the `active`
     * class and hidden by removing it.
     *
     * Call it right after the modal is shown. It is idempotent per open, and — crucially —
     * a MutationObserver on the modal's class tears the listeners down as soon as ANY path
     * removes `active` (a Cancel button, a backdrop click, OR tvNavigation.closeTopModal on
     * TV), so nothing leaks or double-binds across re-opens.
     *   opts.onClose     — invoked to close (default: remove `active`); wire your close fn.
     *   opts.initialFocus— element to focus on open (default: first focusable).
     *   opts.restoreFocus— set false to skip restoring focus to the opener on close.
     */
    function installModalHygiene(modalEl, opts = {}) {
        if (!modalEl || modalEl.__hygieneOn) return;
        modalEl.__hygieneOn = true;
        const prevFocus = document.activeElement;
        const requestClose = () => {
            if (typeof opts.onClose === 'function') opts.onClose();
            else modalEl.classList.remove('active');
        };
        function onKey(e) {
            if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') {
                e.preventDefault(); e.stopPropagation(); requestClose(); return;
            }
            if (e.key === 'Tab') {
                const f = focusablesIn(modalEl);
                if (!f.length) return;
                const first = f[0], last = f[f.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        }
        const onBackdrop = (e) => { if (e.target === modalEl) requestClose(); };
        const teardown = () => {
            document.removeEventListener('keydown', onKey, true);
            modalEl.removeEventListener('mousedown', onBackdrop);
            classObserver.disconnect();
            modalEl.__hygieneOn = false;
            if (opts.restoreFocus !== false) {
                try { if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus(); } catch (_) { /* noop */ }
            }
        };
        const classObserver = new MutationObserver(() => {
            if (!modalEl.classList.contains('active')) teardown();
        });
        classObserver.observe(modalEl, { attributes: true, attributeFilter: ['class'] });
        document.addEventListener('keydown', onKey, true);
        modalEl.addEventListener('mousedown', onBackdrop);
        setTimeout(() => {
            const t = opts.initialFocus || focusablesIn(modalEl)[0];
            try { t?.focus(); } catch (_) { /* noop */ }
        }, 30);
    }

    const NorvaModal = {
        /** Attach Escape/Back close + Tab focus-trap + focus restore to an app-owned #modal. */
        installHygiene: installModalHygiene,
        /** Yes/no decision. Resolves true on confirm, false on cancel/Escape/backdrop. */
        confirm(message, opts = {}) {
            return open({
                title: opts.title || 'Please confirm',
                message,
                confirmLabel: opts.confirmLabel || 'Confirm',
                cancelLabel: opts.cancelLabel || 'Cancel',
                danger: !!opts.danger
            });
        },
        /** Single-button notice. Resolves true when dismissed. */
        alert(message, opts = {}) {
            return open({
                title: opts.title || '',
                message,
                confirmLabel: opts.confirmLabel || 'OK',
                cancelLabel: null,
                danger: !!opts.danger
            });
        },
        /** Transient feedback — reuses the app's toast host; falls back to alert(). */
        toast(message, type = 'info', opts = {}) {
            const app = window.app;
            if (app && typeof app.showToast === 'function') {
                return app.showToast(message, Object.assign({ type }, opts));
            }
            return this.alert(message);
        }
    };

    window.NorvaModal = NorvaModal;
})();
