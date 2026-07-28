'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CONTROL_SOURCE = fs.readFileSync(
    path.join(ROOT, 'public/js/components/TitleRatingControl.js'),
    'utf8'
);

function fakeClassList() {
    const values = new Set();
    return {
        add: (...names) => names.forEach((name) => values.add(name)),
        remove: (...names) => names.forEach((name) => values.delete(name)),
        toggle: (name, force) => {
            if (force === true) values.add(name);
            else if (force === false) values.delete(name);
            else if (values.has(name)) values.delete(name);
            else values.add(name);
        },
        contains: (name) => values.has(name),
    };
}

function fakeElement() {
    const attributes = new Map();
    const listeners = new Map();
    return {
        classList: fakeClassList(),
        dataset: {},
        hidden: false,
        disabled: false,
        textContent: '',
        title: '',
        setAttribute(name, value) {
            attributes.set(name, String(value));
        },
        getAttribute(name) {
            return attributes.has(name) ? attributes.get(name) : null;
        },
        addEventListener(type, listener) {
            const group = listeners.get(type) || new Set();
            group.add(listener);
            listeners.set(type, group);
        },
        removeEventListener(type, listener) {
            listeners.get(type)?.delete(listener);
        },
        click() {
            for (const listener of listeners.get('click') || []) listener({ currentTarget: this });
        },
    };
}

function loadControl({
    online = true,
    document: documentStub,
    CustomEvent: CustomEventStub,
} = {}) {
    const context = {
        window: {},
        navigator: { onLine: online },
        setTimeout,
        clearTimeout,
        console,
    };
    if (documentStub) context.document = documentStub;
    if (CustomEventStub) context.CustomEvent = CustomEventStub;
    vm.runInNewContext(CONTROL_SOURCE, context, {
        filename: 'public/js/components/TitleRatingControl.js',
    });
    return context.window.TitleRatingControl;
}

function harness(api, options) {
    const TitleRatingControl = loadControl(options);
    const elements = {
        root: fakeElement(),
        upButton: fakeElement(),
        downButton: fakeElement(),
        status: fakeElement(),
        retryButton: fakeElement(),
    };
    const control = new TitleRatingControl({
        ...elements,
        getApi: () => api,
        requestTimeoutMs: options?.requestTimeoutMs,
    });
    return { control, ...elements };
}

function mediaContext(overrides = {}) {
    return {
        sourceId: 'source-a',
        itemId: '42',
        itemType: 'movie',
        label: 'Example',
        ...overrides,
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('loads the exact rating and exposes a true toggle state to assistive technology', async () => {
    const api = {
        getExact: async () => ({ rating: 1 }),
        set: async () => ({ rating: 1 }),
    };
    const { control, root, upButton, downButton, status } = harness(api);

    await control.load(mediaContext());

    assert.equal(root.dataset.state, 'idle');
    assert.equal(root.getAttribute('aria-busy'), 'false');
    assert.equal(upButton.getAttribute('aria-pressed'), 'true');
    assert.equal(downButton.getAttribute('aria-pressed'), 'false');
    assert.equal(upButton.getAttribute('aria-label'), 'Remove Like');
    assert.equal(status.textContent, '');
    control.destroy();
});

test('serializes rapid choices so the latest viewer intent wins', async () => {
    const writes = [];
    const api = {
        getExact: async () => ({ rating: 0, revision: 4 }),
        set: (body) => {
            const pending = deferred();
            writes.push({ body, pending });
            return pending.promise;
        },
    };
    const { control, upButton, downButton } = harness(api);
    await control.load(mediaContext());

    control.choose(1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body.rating, 1);
    assert.equal(writes[0].body.expectedRevision, 4);
    assert.match(writes[0].body.operationId, /^[0-9a-f-]{36}$/i);
    assert.equal(Object.hasOwn(writes[0].body, 'clientRevision'), false);
    control.choose(-1);
    assert.equal(upButton.getAttribute('aria-pressed'), 'false');
    assert.equal(downButton.getAttribute('aria-pressed'), 'true');

    writes[0].pending.resolve({ applied: true, rating: 1, revision: 5 });
    await flush();
    assert.equal(writes.length, 2);
    assert.equal(writes[1].body.rating, -1);
    assert.equal(writes[1].body.expectedRevision, 5);
    assert.notEqual(writes[1].body.operationId, writes[0].body.operationId);

    writes[1].pending.resolve({ applied: true, rating: -1, revision: 6 });
    await flush();
    assert.equal(control.confirmedRating, -1);
    assert.equal(control.confirmedRevision, 6);
    assert.equal(control.desiredRating, -1);
    assert.equal(control.phase, 'saved');
    control.destroy();
});

test('ignores a late rating read from a previously opened title', async () => {
    const reads = new Map();
    const api = {
        getExact: ({ itemId }) => {
            const pending = deferred();
            reads.set(itemId, pending);
            return pending.promise;
        },
        set: async () => ({ rating: 0 }),
    };
    const { control, upButton, downButton } = harness(api);

    const first = control.load(mediaContext({ itemId: 'first' }));
    const second = control.load(mediaContext({ itemId: 'second' }));
    reads.get('second').resolve({ rating: -1 });
    await second;
    reads.get('first').resolve({ rating: 1 });
    await first;

    assert.equal(control.context.itemId, 'second');
    assert.equal(upButton.getAttribute('aria-pressed'), 'false');
    assert.equal(downButton.getAttribute('aria-pressed'), 'true');
    control.destroy();
});

test('a hanging save on an old title never blocks the newly opened title', async () => {
    const writes = [];
    const firstWrite = deferred();
    const api = {
        getExact: async ({ itemId }) => ({
            rating: itemId === 'second' && writes.some((write) => write.itemId === 'second') ? 1 : 0,
            revision: itemId === 'second' && writes.some((write) => write.itemId === 'second') ? 1 : 0,
        }),
        set: (body) => {
            writes.push(body);
            if (body.itemId === 'first') return firstWrite.promise;
            return Promise.resolve({
                applied: true,
                rating: body.rating,
                revision: body.expectedRevision + 1,
            });
        },
    };
    const { control, upButton } = harness(api);

    await control.load(mediaContext({ itemId: 'first' }));
    control.choose(1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].itemId, 'first');

    await control.load(mediaContext({ itemId: 'second' }));
    control.choose(1);
    await flush();

    assert.equal(writes.length, 2, 'the new context starts its own save loop immediately');
    assert.equal(writes[1].itemId, 'second');
    assert.equal(control.context.itemId, 'second');
    assert.equal(control.confirmedRating, 1);
    assert.equal(upButton.getAttribute('aria-pressed'), 'true');

    firstWrite.resolve({
        applied: true,
        rating: 1,
        revision: writes[0].expectedRevision + 1,
    });
    await flush();
    assert.equal(control.context.itemId, 'second');
    assert.equal(control.confirmedRating, 1, 'the stale save cannot repaint the current title');
    control.destroy();
});

test('a late confirmed save invalidates Home and reconciles the newly opened fiche', async () => {
    const events = [];
    const reads = [];
    const firstWrite = deferred();
    class FakeCustomEvent {
        constructor(type, options = {}) {
            this.type = type;
            this.detail = options.detail;
        }
    }
    const api = {
        getExact: async (context) => {
            reads.push(context.itemId);
            return context.itemId === 'second'
                ? { rating: -1, revision: 9 }
                : { rating: 0, revision: 0 };
        },
        set: () => firstWrite.promise,
    };
    const { control } = harness(api, {
        document: {
            dispatchEvent(event) {
                events.push(event);
            },
        },
        CustomEvent: FakeCustomEvent,
    });

    await control.load(mediaContext({ itemId: 'first' }));
    control.choose(1);
    await control.load(mediaContext({ itemId: 'second' }));
    firstWrite.resolve({ applied: true, rating: 1, revision: 1 });
    await flush();
    await flush();

    assert.equal(events.length, 1);
    assert.equal(events[0].detail.itemId, 'first');
    assert.equal(events[0].detail.rating, 1);
    assert.equal(reads.filter((itemId) => itemId === 'second').length, 2);
    assert.equal(control.context.itemId, 'second');
    assert.equal(control.confirmedRating, -1);
    assert.equal(control.confirmedRevision, 9);
    control.destroy();
});

test('a late confirmed save never reveals or fetches a deferred TV preview', async () => {
    const events = [];
    const reads = [];
    const firstWrite = deferred();
    class FakeCustomEvent {
        constructor(type, options = {}) {
            this.type = type;
            this.detail = options.detail;
        }
    }
    const api = {
        getExact: async (context) => {
            reads.push(context.itemId);
            return { rating: 0, revision: 0 };
        },
        set: () => firstWrite.promise,
    };
    const { control, root } = harness(api, {
        document: {
            dispatchEvent(event) {
                events.push(event);
            },
        },
        CustomEvent: FakeCustomEvent,
    });

    await control.load(mediaContext({ itemId: 'committed-fiche' }));
    control.choose(1);
    control.defer(mediaContext({ itemId: 'dpad-preview' }));
    firstWrite.resolve({ applied: true, rating: 1, revision: 1 });
    await flush();
    await flush();

    assert.equal(events.length, 1, 'Home still receives the confirmed stale-save invalidation');
    assert.equal(events[0].detail.itemId, 'committed-fiche');
    assert.deepEqual(reads, ['committed-fiche'], 'D-pad preview never triggers a rating read');
    assert.equal(control.context.itemId, 'dpad-preview');
    assert.equal(root.hidden, true, 'title controls remain hidden until fiche commit');
    control.destroy();
});

test('a lost network response retries the exact same idempotent CAS operation', async () => {
    const writes = [];
    const api = {
        getExact: async () => ({ rating: 1, revision: 7 }),
        set: async (body) => {
            writes.push({ ...body });
            if (writes.length === 1) throw new TypeError('Failed to fetch');
            return { applied: true, rating: -1, revision: 8 };
        },
    };
    const { control, upButton, downButton, status, retryButton } = harness(api);
    await control.load(mediaContext());

    control.choose(-1);
    await flush();
    assert.equal(control.phase, 'offline');
    assert.equal(upButton.getAttribute('aria-pressed'), 'true');
    assert.equal(downButton.getAttribute('aria-pressed'), 'false');
    assert.match(status.textContent, /previous choice was restored/i);
    assert.equal(retryButton.hidden, false);

    retryButton.click();
    await flush();
    assert.equal(writes.length, 2);
    assert.equal(writes[0].operationId, writes[1].operationId);
    assert.equal(writes[0].expectedRevision, 7);
    assert.equal(writes[1].expectedRevision, 7);
    assert.equal(Object.hasOwn(writes[1], 'clientRevision'), false);
    assert.equal(control.confirmedRating, -1);
    assert.equal(downButton.getAttribute('aria-pressed'), 'true');
    control.destroy();
});

test('bounds hanging rating reads and writes with recoverable honest states', async () => {
    const never = deferred();
    const api = {
        getExact: () => never.promise,
        set: () => never.promise,
    };
    const readHarness = harness(api, { requestTimeoutMs: 50 });
    await readHarness.control.load(mediaContext());
    assert.equal(readHarness.control.phase, 'error');
    assert.match(readHarness.status.textContent, /couldn’t load/i);
    assert.equal(readHarness.retryButton.hidden, false);
    readHarness.control.destroy();

    const writeHarness = harness({
        getExact: async () => ({ rating: 0, revision: 0 }),
        set: () => never.promise,
    }, { requestTimeoutMs: 50 });
    await writeHarness.control.load(mediaContext());
    writeHarness.control.choose(1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(writeHarness.control.phase, 'error');
    assert.match(writeHarness.status.textContent, /previous choice was restored/i);
    assert.equal(writeHarness.retryButton.hidden, false);
    assert.equal(writeHarness.upButton.getAttribute('aria-pressed'), 'false');
    writeHarness.control.destroy();
});

test('a confirmed CAS save emits one cache-invalidation event with authoritative state', async () => {
    const events = [];
    class FakeCustomEvent {
        constructor(type, options = {}) {
            this.type = type;
            this.detail = options.detail;
        }
    }
    const api = {
        getExact: async () => ({ rating: 0, revision: 2 }),
        set: async (body) => ({
            applied: true,
            rating: body.rating,
            revision: 3,
        }),
    };
    const { control } = harness(api, {
        document: {
            dispatchEvent(event) {
                events.push(event);
            },
        },
        CustomEvent: FakeCustomEvent,
    });
    await control.load(mediaContext());

    control.choose(1);
    await flush();

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'norva:title-rating-changed');
    assert.equal(events[0].detail.rating, 1);
    assert.equal(events[0].detail.revision, 3);
    assert.match(events[0].detail.operationId, /^[0-9a-f-]{36}$/i);
    control.destroy();
});

test('a CAS conflict paints the server once and requires a brand-new viewer choice', async () => {
    const writes = [];
    const api = {
        getExact: async () => ({ rating: 0, revision: 4 }),
        set: async (body) => {
            writes.push({ ...body });
            if (writes.length === 1) {
                return {
                    applied: false,
                    rating: -1,
                    revision: 5,
                };
            }
            return {
                applied: true,
                rating: 1,
                revision: 6,
            };
        },
    };
    const { control, upButton, downButton, retryButton, status } = harness(api);
    await control.load(mediaContext());

    control.choose(1);
    await flush();

    assert.equal(writes.length, 1, 'a stale intention is never replayed automatically');
    assert.equal(control.phase, 'error');
    assert.equal(control.confirmedRating, -1);
    assert.equal(control.confirmedRevision, 5);
    assert.equal(upButton.getAttribute('aria-pressed'), 'false');
    assert.equal(downButton.getAttribute('aria-pressed'), 'true');
    assert.equal(retryButton.hidden, true);
    assert.match(status.textContent, /changed on another device.*choose again/i);

    control.choose(1);
    await flush();
    assert.equal(writes.length, 2);
    assert.equal(writes[1].expectedRevision, 5);
    assert.notEqual(writes[1].operationId, writes[0].operationId);
    assert.equal(control.confirmedRating, 1);
    assert.equal(control.confirmedRevision, 6);
    control.destroy();
});

test('a non-CAS 409 keeps the confirmed choice and shows the actionable profile state', async () => {
    let writes = 0;
    const api = {
        getExact: async () => ({ rating: 1, revision: 4 }),
        set: async () => {
            writes += 1;
            const error = new Error('conflict');
            error.status = 409;
            error.payload = {
                message: 'Active profile is locked by the current plan',
                details: { code: 'profile_locked' },
            };
            throw error;
        },
    };
    const { control, upButton, downButton, retryButton, status } = harness(api);
    await control.load(mediaContext());

    control.choose(-1);
    await flush();

    assert.equal(control.phase, 'error');
    assert.equal(control.confirmedRating, 1);
    assert.equal(control.confirmedRevision, 4);
    assert.equal(upButton.getAttribute('aria-pressed'), 'true');
    assert.equal(downButton.getAttribute('aria-pressed'), 'false');
    assert.equal(upButton.disabled, true);
    assert.equal(retryButton.hidden, true);
    assert.match(status.textContent, /profile is locked/i);
    assert.doesNotMatch(status.textContent, /another device/i);
    await flush();
    await flush();
    assert.equal(writes, 1, 'a terminal profile error must never hot-loop');
    control.destroy();
});

test('exposes a distinct offline loading state with a reachable retry', async () => {
    const api = {
        getExact: async () => {
            throw new TypeError('Failed to fetch');
        },
        set: async () => ({ rating: 0 }),
    };
    const { control, root, upButton, retryButton, status } = harness(api, { online: false });

    await control.load(mediaContext());

    assert.equal(root.dataset.state, 'offline');
    assert.equal(upButton.disabled, true);
    assert.equal(retryButton.hidden, false);
    assert.match(status.textContent, /offline/i);
    control.destroy();
});

test('SPA contract uses the shared control, semantic states and source-aware reads', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/app.html'), 'utf8');
    const cloudApi = fs.readFileSync(path.join(ROOT, 'public/js/cloudApi.js'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'public/css/main.css'), 'utf8');
    const movies = fs.readFileSync(path.join(ROOT, 'public/js/pages/MoviesPage.js'), 'utf8');
    const series = fs.readFileSync(path.join(ROOT, 'public/js/pages/SeriesPage.js'), 'utf8');

    assert.match(html, /components\/TitleRatingControl\.js\?v=2/);
    assert.equal(html.includes('👍'), false);
    assert.equal(html.includes('👎'), false);
    assert.match(html, /id="movie-thumb-up"[\s\S]*aria-pressed="false"/);
    assert.match(html, /title-rating-icon-up/);
    assert.match(html, /title-rating-icon-down/);
    assert.match(html, /id="series-rating-status"[\s\S]*aria-live="polite"/);
    assert.match(cloudApi, /getExact:\s*getExactRating/);
    assert.match(cloudApi, /dualGet\('\/ratings', \{ sourceId, itemId, itemType \}\)/);
    assert.match(CONTROL_SOURCE, /operationId:\s*operation\.operationId/);
    assert.match(CONTROL_SOURCE, /expectedRevision:\s*operation\.expectedRevision/);
    assert.match(CONTROL_SOURCE, /norva:title-rating-changed/);
    assert.match(CONTROL_SOURCE, /_withTimeout\(api\.set\(/);
    assert.doesNotMatch(CONTROL_SOURCE, /Number\(value\?\.status\) === 409/);
    assert.doesNotMatch(CONTROL_SOURCE, /clientRevision:\s*targetRevision/);
    assert.match(movies, /TitleRatingControl\?\.fromIds/);
    assert.match(movies, /ratingControl\?\.defer\(this\.ratingContext\(movie\)\)/);
    assert.match(
        movies,
        /sourceId:\s*movie\.cloudSourceId\s*\|\|\s*movie\.cloud_source_id/,
        'movie ratings use the account-scoped cloud source UUID',
    );
    assert.match(series, /TitleRatingControl\?\.fromIds/);
    assert.match(
        series,
        /sourceId:\s*series\.cloudSourceId\s*\|\|\s*series\.cloud_source_id/,
        'series ratings use the account-scoped cloud source UUID',
    );
    assert.match(css, /html\.tv-mode #page-movies \.title-rating-buttons/);
    assert.doesNotMatch(
        css,
        /#movie-thumb-up,[\s\S]{0,120}#movie-thumb-down[\s\S]{0,120}display:\s*none/
    );
});
