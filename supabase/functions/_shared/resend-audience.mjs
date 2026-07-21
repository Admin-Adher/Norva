const DEFAULT_BASE_URL = "https://api.resend.com";

async function responsePayload(response) {
  const text = (await response.text().catch(() => "")).slice(0, 4096);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return { message: text };
  }
}

function payloadMessage(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.error === "string") return payload.error;
  return "";
}

function isCreateConflict(status, payload) {
  if (status === 409) return true;
  if (status !== 422) return false;
  return /already\s+exist|duplicate|conflict/i.test(payloadMessage(payload));
}

/**
 * Reconcile one desired contact state against a Resend Audience.
 *
 * PATCH is authoritative for existing contacts. A missing contact is created, and
 * the create-race case (another worker/contact source won between PATCH and POST)
 * is resolved by retrying PATCH. The caller alone decides when DB state is marked
 * synced, and must do so only when this function returns ok=true.
 * @param {{
 *   apiKey: string,
 *   audienceId: string,
 *   email: string,
 *   unsubscribed: boolean,
 *   firstName?: string | null,
 *   fetchImpl?: typeof globalThis.fetch,
 *   baseUrl?: string,
 *   timeoutMs?: number,
 * }} options
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

  const root = String(baseUrl).replace(/\/+$/, "");
  const collectionUrl = `${root}/audiences/${encodeURIComponent(audienceId)}/contacts`;
  const contactUrl = `${collectionUrl}/${encodeURIComponent(email)}`;
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const desired = {
    unsubscribed: Boolean(unsubscribed),
    ...(firstName ? { first_name: String(firstName).slice(0, 160) } : {}),
  };

  const request = async (method, url, body) => {
    try {
      const timeout = typeof AbortSignal?.timeout === "function"
        ? AbortSignal.timeout(timeoutMs)
        : undefined;
      const response = await fetchImpl(url, {
        method,
        headers,
        body: JSON.stringify(body),
        ...(timeout ? { signal: timeout } : {}),
      });
      const payload = await responsePayload(response);
      return {
        ok: response.ok,
        status: response.status,
        payload,
        error: response.ok ? null : (payloadMessage(payload) || `Resend HTTP ${response.status}`),
      };
    } catch (error) {
      return {
        ok: false,
        status: null,
        payload: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const firstPatch = await request("PATCH", contactUrl, desired);
  if (firstPatch.ok) {
    return {
      ok: true,
      httpStatus: firstPatch.status,
      result: { operation: "patch", response: firstPatch.payload },
      error: null,
    };
  }
  if (firstPatch.status !== 404) {
    return {
      ok: false,
      httpStatus: firstPatch.status,
      result: { operation: "patch", response: firstPatch.payload },
      error: firstPatch.error,
    };
  }

  const create = await request("POST", collectionUrl, { email, ...desired });
  if (create.ok) {
    return {
      ok: true,
      httpStatus: create.status,
      result: { operation: "create", response: create.payload },
      error: null,
    };
  }
  if (!isCreateConflict(create.status, create.payload)) {
    return {
      ok: false,
      httpStatus: create.status,
      result: { operation: "create", initial_patch_status: 404, response: create.payload },
      error: create.error,
    };
  }

  const conflictPatch = await request("PATCH", contactUrl, desired);
  return conflictPatch.ok
    ? {
      ok: true,
      httpStatus: conflictPatch.status,
      result: {
        operation: "patch_after_create_conflict",
        create_status: create.status,
        response: conflictPatch.payload,
      },
      error: null,
    }
    : {
      ok: false,
      httpStatus: conflictPatch.status,
      result: {
        operation: "patch_after_create_conflict",
        create_status: create.status,
        response: conflictPatch.payload,
      },
      error: conflictPatch.error,
    };
}
