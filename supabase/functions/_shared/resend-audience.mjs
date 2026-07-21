const DEFAULT_BASE_URL = "https://api.resend.com";
const USER_AGENT = "Norva-Resend-Projection/2.0";

async function responsePayload(response) {
  const text = (await response.text().catch(() => "")).slice(0, 4096);
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return { message: text }; }
}

function payloadMessage(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.error === "string") return payload.error;
  return "";
}

function isCreateConflict(status, payload) {
  if (status !== 409 && status !== 422) return false;
  const diagnostic = [
    payload?.name,
    payload?.code,
    payloadMessage(payload),
  ].filter((value) => typeof value === "string").join(" ");
  // Resend does not document every 409 as a duplicate-contact response. Only
  // reconcile a create conflict when the response explicitly identifies an
  // already-existing/duplicate contact; generic concurrency or idempotency
  // conflicts must remain visible and be retried by the durable outbox later.
  return /\bcontact\b/i.test(diagnostic) && /already[\s_-]*(?:exist|present)|duplicate/i.test(diagnostic);
}

function retryDelayMs(response, attempt) {
  const raw = response?.headers?.get?.("retry-after") ?? "";
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(10_000, seconds * 1000);
  return Math.min(4_000, 400 * (2 ** attempt));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createRequester({ apiKey, fetchImpl, baseUrl, timeoutMs, minIntervalMs }) {
  const root = String(baseUrl).replace(/\/+$/, "");
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
  let lastStartedAt = 0;

  return async function request(method, path, body) {
    const since = Date.now() - lastStartedAt;
    if (since < minIntervalMs) await wait(minIntervalMs - since);
    lastStartedAt = Date.now();

    // A timed-out or 5xx POST may already have been applied remotely. Repeating
    // it here could create an ambiguous duplicate mutation. The durable worker
    // will reconcile state on its next lease instead. Safe reads/updates keep a
    // small bounded retry budget.
    const maxAttempts = method === "POST" ? 1 : 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const timeout = typeof AbortSignal?.timeout === "function"
          ? AbortSignal.timeout(timeoutMs)
          : undefined;
        const response = await fetchImpl(`${root}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          ...(timeout ? { signal: timeout } : {}),
        });
        const payload = await responsePayload(response);
        if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts - 1) {
          await wait(retryDelayMs(response, attempt));
          lastStartedAt = Date.now();
          continue;
        }
        return {
          ok: response.ok,
          status: response.status,
          payload,
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
          error: response.ok ? null : (payloadMessage(payload) || `Resend HTTP ${response.status}`),
        };
      } catch (error) {
        if (attempt < maxAttempts - 1) {
          await wait(400 * (2 ** attempt));
          lastStartedAt = Date.now();
          continue;
        }
        return {
          ok: false,
          status: null,
          payload: null,
          retryable: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  };
}

function safeProperties(properties) {
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return {};
  return Object.fromEntries(Object.entries(properties)
    .filter(([key, value]) => /^[a-z][a-z0-9_]{0,49}$/.test(key) &&
      (typeof value === "string" || typeof value === "number"))
    .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 500) : value]));
}

/**
 * Reconcile one Norva contact against Resend's current global Contacts model.
 * Segments are Norva-owned operational cohorts; the single public Topic carries
 * the user's explicit marketing preference. The global unsubscribe remains the
 * fail-closed master switch for Broadcasts.
 */
export async function syncResendContactProjection({
  apiKey,
  email,
  unsubscribed,
  firstName = null,
  properties = {},
  desiredSegmentIds = [],
  managedSegmentIds = [],
  topicId,
  topicSubscription = "opt_out",
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 12_000,
  minIntervalMs = 275,
}) {
  if (!apiKey || !email || !topicId || typeof fetchImpl !== "function") {
    return { ok: false, retryable: false, httpStatus: null, result: null, error: "Resend contact projection is not configured" };
  }
  const desiredIds = [...new Set(desiredSegmentIds.filter(Boolean).map(String))];
  const managedIds = new Set(managedSegmentIds.filter(Boolean).map(String));
  if (desiredIds.some((id) => !managedIds.has(id))) {
    return { ok: false, retryable: false, httpStatus: null, result: null, error: "Unknown desired Resend segment" };
  }

  const request = createRequester({ apiKey, fetchImpl, baseUrl, timeoutMs, minIntervalMs });
  const encodedEmail = encodeURIComponent(String(email).trim().toLowerCase());
  const contactPatch = {
    unsubscribed: Boolean(unsubscribed),
    // An explicit empty value clears stale personalization once this worker is
    // enabled on Norva's dedicated team.
    first_name: firstName ? String(firstName).slice(0, 160) : "",
    properties: safeProperties(properties),
  };
  const steps = [];

  let patch = await request("PATCH", `/contacts/${encodedEmail}`, contactPatch);
  let contactId = patch.payload?.id ?? null;
  if (!patch.ok && patch.status === 404) {
    const create = await request("POST", "/contacts", {
      email: String(email).trim().toLowerCase(),
      ...contactPatch,
      segments: desiredIds.map((id) => ({ id })),
      topics: [{ id: topicId, subscription: topicSubscription === "opt_in" ? "opt_in" : "opt_out" }],
    });
    steps.push({ operation: "create", status: create.status });
    if (create.ok) {
      return { ok: true, httpStatus: create.status, result: { operation: "create", steps }, error: null };
    }
    if (!isCreateConflict(create.status, create.payload)) {
      return { ok: false, retryable: create.retryable, httpStatus: create.status, result: { operation: "create", steps }, error: create.error };
    }
    patch = await request("PATCH", `/contacts/${encodedEmail}`, contactPatch);
    contactId = patch.payload?.id ?? null;
    steps.push({ operation: "patch_after_create_conflict", status: patch.status });
  } else {
    steps.push({ operation: "patch", status: patch.status });
  }
  if (patch.ok && !contactId) {
    // Be tolerant of API/SDK response-shape drift: the contact identifier is
    // required for segment membership endpoints, and Retrieve accepts email.
    const retrieve = await request("GET", `/contacts/${encodedEmail}`);
    steps.push({ operation: "retrieve_contact", status: retrieve.status });
    if (retrieve.ok) contactId = retrieve.payload?.id ?? null;
    else {
      return {
        ok: false,
        retryable: retrieve.retryable,
        httpStatus: retrieve.status,
        result: { operation: "retrieve_contact", steps },
        error: retrieve.error || "Resend did not return a contact id",
      };
    }
  }
  if (!patch.ok || !contactId) {
    return {
      ok: false,
      retryable: patch.retryable,
      httpStatus: patch.status,
      result: { operation: "patch", steps },
      error: patch.error || "Resend did not return a contact id",
    };
  }

  const encodedContact = encodeURIComponent(String(contactId));
  const currentIds = new Set();
  let after = null;
  for (let page = 0; page < 50; page++) {
    const path = `/contacts/${encodedContact}/segments?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`;
    const memberships = await request("GET", path);
    steps.push({ operation: "list_segments", status: memberships.status, page: page + 1 });
    if (!memberships.ok) {
      return { ok: false, retryable: memberships.retryable, httpStatus: memberships.status, result: { steps }, error: memberships.error };
    }
    const rows = Array.isArray(memberships.payload?.data) ? memberships.payload.data : [];
    for (const row of rows) {
      const id = String(row?.id ?? "");
      if (id) currentIds.add(id);
    }
    if (!memberships.payload?.has_more) break;
    const cursor = String(rows.at(-1)?.id ?? "");
    if (!cursor || cursor === after) {
      return { ok: false, retryable: false, httpStatus: memberships.status, result: { steps }, error: "Invalid Resend segment cursor" };
    }
    after = cursor;
    if (page === 49) {
      return { ok: false, retryable: false, httpStatus: memberships.status, result: { steps }, error: "Resend segment pagination limit exceeded" };
    }
  }
  const desiredSet = new Set(desiredIds);
  for (const id of managedIds) {
    if (desiredSet.has(id) === currentIds.has(id)) continue;
    const method = desiredSet.has(id) ? "POST" : "DELETE";
    const change = await request(method, `/contacts/${encodedContact}/segments/${encodeURIComponent(id)}`);
    steps.push({ operation: method === "POST" ? "add_segment" : "remove_segment", segment_id: id, status: change.status });
    // An already-absent delete is an acceptable terminal state. Failed adds are
    // deliberately not swallowed: the next durable reconciliation will first
    // re-list memberships and discover an add that actually succeeded remotely.
    const idempotent = method === "DELETE" && change.status === 404;
    if (!change.ok && !idempotent) {
      return { ok: false, retryable: change.retryable, httpStatus: change.status, result: { steps }, error: change.error };
    }
  }

  // Resend's contact-topic endpoint expects the subscriptions array as the
  // top-level JSON body (unlike contact creation, where it is the `topics`
  // property of the contact payload).
  const topics = await request("PATCH", `/contacts/${encodedContact}/topics`, [
    { id: topicId, subscription: topicSubscription === "opt_in" ? "opt_in" : "opt_out" },
  ]);
  steps.push({ operation: "update_topic", status: topics.status });
  if (!topics.ok) {
    return { ok: false, retryable: topics.retryable, httpStatus: topics.status, result: { steps }, error: topics.error };
  }
  return { ok: true, httpStatus: topics.status, result: { operation: "reconcile", steps }, error: null };
}

/**
 * Temporary backwards-compatible legacy helper. New production code must use
 * syncResendContactProjection; this remains only so an in-flight old worker can
 * finish safely during a rolling deployment.
 */
export async function syncResendAudienceContact({
  apiKey,
  audienceId,
  email,
  unsubscribed,
  firstName = null,
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 12_000,
}) {
  if (!apiKey || !audienceId || !email || typeof fetchImpl !== "function") {
    return { ok: false, httpStatus: null, result: null, error: "Resend audience sync is not configured" };
  }
  const request = createRequester({ apiKey, fetchImpl, baseUrl, timeoutMs, minIntervalMs: 0 });
  const collection = `/audiences/${encodeURIComponent(audienceId)}/contacts`;
  const contact = `${collection}/${encodeURIComponent(email)}`;
  const desired = {
    unsubscribed: Boolean(unsubscribed),
    ...(firstName ? { first_name: String(firstName).slice(0, 160) } : {}),
  };
  const firstPatch = await request("PATCH", contact, desired);
  if (firstPatch.ok) return { ok: true, httpStatus: firstPatch.status, result: { operation: "patch", response: firstPatch.payload }, error: null };
  if (firstPatch.status !== 404) return { ok: false, httpStatus: firstPatch.status, result: { operation: "patch", response: firstPatch.payload }, error: firstPatch.error };
  const create = await request("POST", collection, { email, ...desired });
  if (create.ok) return { ok: true, httpStatus: create.status, result: { operation: "create", response: create.payload }, error: null };
  if (!isCreateConflict(create.status, create.payload)) return { ok: false, httpStatus: create.status, result: { operation: "create", response: create.payload }, error: create.error };
  const conflictPatch = await request("PATCH", contact, desired);
  return conflictPatch.ok
    ? { ok: true, httpStatus: conflictPatch.status, result: { operation: "patch_after_create_conflict", response: conflictPatch.payload }, error: null }
    : { ok: false, httpStatus: conflictPatch.status, result: { operation: "patch_after_create_conflict", response: conflictPatch.payload }, error: conflictPatch.error };
}
