const committedSources = new WeakMap();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Called only after this authenticated request has successfully inserted a row.
// This is an identity receipt, never permission to display the source or replay
// its creation. The client must reconcile it through a fresh authorized read.
export function bindCommittedSourceCreationReceipt(req, sourceId) {
  if (req.method === "POST" && typeof sourceId === "string" && UUID.test(sourceId)) {
    committedSources.set(req, sourceId);
  }
}

export async function finalizeSourceCreationReceiptResponse(req, finalize) {
  try {
    const response = await finalize();
    const sourceId = committedSources.get(req);
    if (!sourceId || response.status !== 409) return response;
    const payload = await response.clone().json().catch(() => null);
    if (payload?.details?.code !== "CATALOG_VISIBILITY_MUTATION_OUTCOME_UNKNOWN") return response;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.set("content-type", "application/json; charset=utf-8");
    return new Response(JSON.stringify({
      ...payload,
      details: {
        ...payload.details,
        sourceCreationReceipt: { contract: "source-creation-receipt-v1", sourceId },
      },
    }), { status: response.status, statusText: response.statusText, headers });
  } finally {
    committedSources.delete(req);
  }
}
