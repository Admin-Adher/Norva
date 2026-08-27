type ErrorLike = { code?: unknown } | null | undefined;

// PT409 is Norva's application-level optimistic-concurrency contract.  It is
// translated by PostgREST to HTTP 409 and, unlike PostgreSQL's engine-owned
// 40001 serialization_failure, is never eligible for an implicit transaction
// replay.  Keep 40001 during the rolling deployment so older database
// definitions and genuine engine serialization failures remain fail-closed.
export function isStaleDatabaseConflict(error: ErrorLike): boolean {
  const code = typeof error?.code === "string" ? error.code.toUpperCase() : "";
  return code === "PT409" || code === "40001";
}
