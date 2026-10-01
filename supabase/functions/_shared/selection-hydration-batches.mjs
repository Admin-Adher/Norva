// Match the SQL manifest limits, including UTF-8 bytes rather than characters.
// Keep room for JSON separators and reject an individually oversized manifest
// through the normal RPC validation instead of silently omitting its evidence.
export function* selectionHydrationBatches(files) {
  const encoder = new TextEncoder();
  let batch = [], bytes = 2;
  for (const file of files) {
    const size = encoder.encode(JSON.stringify(file)).length + 1;
    if (batch.length && (batch.length === 250 || bytes + size > 240000)) {
      yield batch; batch = []; bytes = 2;
    }
    batch.push(file); bytes += size;
  }
  if (batch.length) yield batch;
}
