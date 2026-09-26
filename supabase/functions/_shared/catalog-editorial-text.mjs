// The old Selection importer put this exact three-line source attribution in
// plot. Retain provenance in storage, but never present it as editorial copy.
export function isSelectionSourceAttribution(value) {
  if (typeof value !== 'string') return false;
  const lines = value.trim().split(/\r?\n/).map(line => line.trim());
  return lines.length === 3 && Boolean(lines[0])
    && /^https:\/\/github\.com\/[^\s]+$/i.test(lines[1])
    && /^https:\/\/norva\.tv\/catalog\/credits\.html\/?$/i.test(lines[2]);
}

export function isEditorialTextField(field) {
  return field === 'overview' || field === 'description' || field === 'plot';
}
