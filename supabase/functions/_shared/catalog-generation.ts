// Catalog generation fencing shared by every catalog writer.
//
// Normal refreshes may write only the snapshotted ACTIVE head. Credential
// candidates use a distinct BUILDING context whose durable job lease is checked
// again by database triggers on every row. There is deliberately no implicit
// "current generation" fallback: a caller must opt into one of these contexts.

type JsonRecord = Record<string, unknown>;

export type SupabaseGenerationClient = {
  rpc: (name: string, args?: JsonRecord) => PromiseLike<{ data?: unknown; error?: unknown }>;
};

export type ActiveCatalogGeneration = {
  kind: "active";
  generationId: string;
  headRevision: string;
  configRevision: string;
  sourceVisibilityEpoch: string;
  userVisibilityEpoch: string;
};

export type BuildingCatalogGeneration = {
  kind: "building";
  generationId: string;
  transitionId: string;
  jobId: string;
  attempt: number;
  leaseOwner: string;
};

export type CatalogGenerationWriteContext =
  | ActiveCatalogGeneration
  | BuildingCatalogGeneration;

export class CatalogGenerationSupersededError extends Error {
  readonly code = "CATALOG_GENERATION_SUPERSEDED";

  constructor(message = "Catalog generation changed while work was running") {
    super(message);
    this.name = "CatalogGenerationSupersededError";
  }
}

export async function readActiveCatalogGenerationSnapshot(
  db: SupabaseGenerationClient,
  sourceId: string,
  userId: string,
): Promise<ActiveCatalogGeneration> {
  const { data, error } = await db.rpc("norva_get_catalog_write_snapshot", {
    p_source_id: sourceId,
    p_user_id: userId,
  });
  if (error) throw new CatalogGenerationSupersededError("Catalog generation snapshot is unavailable");
  const value = recordOrEmpty(Array.isArray(data) ? data[0] : data);
  const catalogVisible = booleanValue(
    value.isCatalogVisible ?? value.is_catalog_visible ?? value.catalogVisible ?? value.catalog_visible,
  );
  const snapshot: ActiveCatalogGeneration = {
    kind: "active",
    generationId: uuidValue(value.generationId ?? value.generation_id),
    headRevision: revisionValue(value.headRevision ?? value.head_revision),
    configRevision: revisionValue(value.configRevision ?? value.config_revision),
    sourceVisibilityEpoch: revisionValue(
      value.sourceVisibilityEpoch ?? value.source_visibility_epoch ?? value.visibilityEpoch ?? value.visibility_epoch,
    ),
    userVisibilityEpoch: revisionValue(value.userVisibilityEpoch ?? value.user_visibility_epoch),
  };
  if (
    catalogVisible !== true ||
    !snapshot.generationId || !snapshot.headRevision || !snapshot.configRevision ||
    !snapshot.sourceVisibilityEpoch || !snapshot.userVisibilityEpoch
  ) {
    throw new CatalogGenerationSupersededError("Catalog generation is not an active visible head");
  }
  return snapshot;
}

export async function assertActiveCatalogGenerationCurrent(
  db: SupabaseGenerationClient,
  sourceId: string,
  userId: string,
  expected: ActiveCatalogGeneration,
): Promise<void> {
  const current = await readActiveCatalogGenerationSnapshot(db, sourceId, userId);
  if (
    current.generationId !== expected.generationId ||
    current.headRevision !== expected.headRevision ||
    current.configRevision !== expected.configRevision ||
    current.sourceVisibilityEpoch !== expected.sourceVisibilityEpoch ||
    current.userVisibilityEpoch !== expected.userVisibilityEpoch
  ) {
    throw new CatalogGenerationSupersededError();
  }
}

export function catalogGenerationFields(
  context: CatalogGenerationWriteContext,
): JsonRecord {
  assertCatalogGenerationContext(context);
  if (context.kind === "active") {
    return {
      generation_id: context.generationId,
      ingest_job_id: null,
      ingest_attempt: null,
      ingest_lease_owner: null,
      write_head_revision: context.headRevision,
      write_config_revision: context.configRevision,
      write_source_visibility_epoch: context.sourceVisibilityEpoch,
      write_user_visibility_epoch: context.userVisibilityEpoch,
    };
  }
  return {
    generation_id: context.generationId,
    ingest_job_id: context.jobId,
    ingest_attempt: context.attempt,
    ingest_lease_owner: context.leaseOwner,
    write_head_revision: null,
    write_config_revision: null,
    write_source_visibility_epoch: null,
    write_user_visibility_epoch: null,
  };
}

export function catalogGenerationRpcFence(context: ActiveCatalogGeneration): JsonRecord {
  assertCatalogGenerationContext(context);
  return {
    p_generation_id: context.generationId,
    p_head_revision: context.headRevision,
    p_config_revision: context.configRevision,
    p_source_visibility_epoch: context.sourceVisibilityEpoch,
    p_user_visibility_epoch: context.userVisibilityEpoch,
  };
}

// During a DB-first/Edge-first rolling deployment, a new named overload can be
// absent from Postgres or from PostgREST's schema cache. Only those two exact
// conditions may use the legacy routine; permission, validation and ABA errors
// must remain fail-closed.
export function isRollingRpcUnavailable(error: unknown): boolean {
  const code = stringValue(recordOrEmpty(error).code).toUpperCase();
  return code === "42883" || code === "PGRST202";
}

export async function callActiveCatalogGenerationRpc(
  db: SupabaseGenerationClient,
  name: string,
  args: JsonRecord,
  context: ActiveCatalogGeneration,
): Promise<{ data?: any; error?: any }> {
  const fenced = await db.rpc(name, { ...args, ...catalogGenerationRpcFence(context) });
  if (!fenced.error || !isRollingRpcUnavailable(fenced.error)) return fenced;
  return await db.rpc(name, args);
}

export function withCatalogGeneration<T extends JsonRecord>(
  row: T,
  context: CatalogGenerationWriteContext,
): T & JsonRecord {
  return { ...row, ...catalogGenerationFields(context) };
}

export function withCatalogGenerationRows<T extends JsonRecord>(
  rows: T[],
  context: CatalogGenerationWriteContext,
): Array<T & JsonRecord> {
  const fields = catalogGenerationFields(context);
  return rows.map((row) => ({ ...row, ...fields }));
}

export function assertCatalogGenerationContext(
  context: CatalogGenerationWriteContext,
): void {
  if (!context || !uuidValue(context.generationId)) {
    throw new Error("Explicit catalog generation is required");
  }
  if (context.kind === "active") {
    if (
      !revisionValue(context.headRevision) || !revisionValue(context.configRevision) ||
      !revisionValue(context.sourceVisibilityEpoch) || !revisionValue(context.userVisibilityEpoch)
    ) {
      throw new Error("Complete active catalog generation snapshot is required");
    }
    return;
  }
  if (
    context.kind !== "building" || !uuidValue(context.transitionId) || !uuidValue(context.jobId) ||
    !Number.isInteger(context.attempt) || context.attempt < 1 || context.attempt > 2_147_483_647 ||
    !context.leaseOwner.trim() || context.leaseOwner.length > 160
  ) {
    throw new Error("Complete building catalog generation lease is required");
  }
}

export function isCatalogGenerationSuperseded(error: unknown): boolean {
  if (error instanceof CatalogGenerationSupersededError) return true;
  const value = recordOrEmpty(error);
  const code = stringValue(value.code).toUpperCase();
  const message = stringValue(value.message ?? error).toLowerCase();
  return ["40001", "42501", "CATALOG_GENERATION_SUPERSEDED", "SOURCE_CATALOG_CHANGED"].includes(code) ||
    /catalog generation (?:write lease|snapshot|head|is not an active|changed)|active catalog row does not match source head/.test(message);
}

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function booleanValue(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (typeof value === "string" && /^(true|false)$/i.test(value.trim())) {
    return value.trim().toLowerCase() === "true";
  }
  return null;
}

function revisionValue(value: unknown): string {
  if (typeof value === "bigint") return value >= 0n ? value.toString() : "";
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return value.trim().replace(/^0+(?=\d)/, "");
  }
  return "";
}

function uuidValue(value: unknown): string {
  const text = stringValue(value).toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)
    ? text
    : "";
}
