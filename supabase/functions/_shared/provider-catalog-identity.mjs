// Credential candidates must be compared without copying their catalogue into
// an audit/API payload. This module keeps raw provider identifiers transient:
// only bounded counts, overlap metrics, and boolean secondary signals leave the
// comparator.

export const PROVIDER_CATALOG_IDENTITY_ALGORITHM_VERSION =
  "xtream-type-streamid-sha256-bottom256-jaccard-manifest-v2";
export const PROVIDER_CATALOG_IDENTITY_SAMPLE_SIZE = 256;
export const PROVIDER_CATALOG_IDENTITY_MIN_IDS = 32;
export const PROVIDER_CATALOG_IDENTITY_MAX_IDS_PER_KIND = 100_000;
export const PROVIDER_CATALOG_IDENTITY_MAX_TOTAL_IDS = 200_000;

export const PROVIDER_CATALOG_IDENTITY_DECISIONS = Object.freeze({
  SAME_CATALOG: "SAME_CATALOG",
  DIFFERENT_CATALOG: "DIFFERENT_CATALOG",
  AMBIGUOUS: "AMBIGUOUS",
});

const SAME_CATALOG_THRESHOLD = 0.5;
const MAX_EXTERNAL_ID_LENGTH = 256;
const MAX_TYPED_EXTERNAL_ID_LENGTH = MAX_EXTERNAL_ID_LENGTH + "series:".length;
const MAX_CANONICAL_IDENTITY_LENGTH = 256;
const MAX_HOST_LENGTH = 2_048;
const MAX_SOURCE_TYPE_LENGTH = 64;
const MAX_CATEGORIES = 256;
const MAX_CATEGORY_LENGTH = 160;

const MD5_SHIFTS = Object.freeze([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);
const MD5_CONSTANTS = Object.freeze(Array.from(
  { length: 64 },
  (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x1_0000_0000) >>> 0,
));

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rotateLeft(value, bits) {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function littleEndianHex(word) {
  let result = "";
  for (let byte = 0; byte < 4; byte += 1) {
    result += ((word >>> (byte * 8)) & 0xff).toString(16).padStart(2, "0");
  }
  return result;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Portable RFC 1321 MD5 over UTF-8. WebCrypto deliberately does not expose MD5. */
export function portableMd5Hex(value) {
  if (typeof value !== "string") throw new TypeError("md5_value_must_be_string");
  if (value.length > MAX_TYPED_EXTERNAL_ID_LENGTH) throw new RangeError("md5_value_too_long");

  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const message = new Uint8Array(paddedLength);
  message.set(input);
  message[input.length] = 0x80;

  const bitLength = input.length * 8;
  const bitLengthLow = bitLength >>> 0;
  const bitLengthHigh = Math.floor(bitLength / 0x1_0000_0000) >>> 0;
  const lengthView = new DataView(message.buffer);
  lengthView.setUint32(paddedLength - 8, bitLengthLow, true);
  lengthView.setUint32(paddedLength - 4, bitLengthHigh, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < message.length; offset += 64) {
    const words = new Uint32Array(16);
    const view = new DataView(message.buffer, offset, 64);
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(index * 4, true);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let mixed;
      let wordIndex;
      if (index < 16) {
        mixed = (b & c) | (~b & d);
        wordIndex = index;
      } else if (index < 32) {
        mixed = (d & b) | (~d & c);
        wordIndex = ((5 * index) + 1) % 16;
      } else if (index < 48) {
        mixed = b ^ c ^ d;
        wordIndex = ((3 * index) + 5) % 16;
      } else {
        mixed = c ^ (b | ~d);
        wordIndex = (7 * index) % 16;
      }

      const previousD = d;
      d = c;
      c = b;
      const sum = (a + mixed + MD5_CONSTANTS[index] + words[wordIndex]) >>> 0;
      b = (b + rotateLeft(sum, MD5_SHIFTS[index])) >>> 0;
      a = previousD;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  return littleEndianHex(a0) + littleEndianHex(b0) + littleEndianHex(c0) + littleEndianHex(d0);
}

function normalizedExternalId(value) {
  if (typeof value !== "string") throw new TypeError("external_id_must_be_string");
  const normalized = value.normalize("NFC").trim();
  if (!normalized) throw new TypeError("external_id_must_not_be_empty");
  if (normalized.length > MAX_EXTERNAL_ID_LENGTH) throw new RangeError("external_id_too_long");
  if (/\p{Cc}/u.test(normalized)) throw new TypeError("external_id_contains_control_character");
  return normalized;
}

function boundedIdList(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field}_must_be_an_array`);
  if (value.length > PROVIDER_CATALOG_IDENTITY_MAX_IDS_PER_KIND) {
    throw new RangeError(`${field}_too_large`);
  }
  return value;
}

function bottomMd5Sample(evidence) {
  if (!isRecord(evidence)) throw new TypeError("catalog_evidence_must_be_an_object");
  const movieIds = boundedIdList(evidence.movieExternalIds, "movie_external_ids");
  const seriesIds = boundedIdList(evidence.seriesExternalIds, "series_external_ids");
  if (movieIds.length + seriesIds.length > PROVIDER_CATALOG_IDENTITY_MAX_TOTAL_IDS) {
    throw new RangeError("catalog_evidence_too_large");
  }

  const uniqueIds = new Set();
  for (const rawId of movieIds) uniqueIds.add(`movie:${normalizedExternalId(rawId)}`);
  for (const rawId of seriesIds) uniqueIds.add(`series:${normalizedExternalId(rawId)}`);

  const ranked = [];
  for (const externalId of uniqueIds) {
    ranked.push({ digest: portableMd5Hex(externalId), externalId });
  }
  ranked.sort((left, right) =>
    compareCodeUnits(left.digest, right.digest) ||
    compareCodeUnits(left.externalId, right.externalId));

  return {
    uniqueCount: uniqueIds.size,
    ids: ranked.slice(0, PROVIDER_CATALOG_IDENTITY_SAMPLE_SIZE)
      .map((entry) => entry.externalId),
  };
}

function strongCanonicalIdentity(evidence) {
  const value = evidence.canonicalIdentity;
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new TypeError("canonical_identity_must_be_an_object");
  if (value.strength !== "strong" && value.strength !== "weak") {
    throw new TypeError("canonical_identity_strength_invalid");
  }
  if (typeof value.id !== "string") throw new TypeError("canonical_identity_id_must_be_string");
  const id = value.id.normalize("NFC").trim();
  if (!id || id.length > MAX_CANONICAL_IDENTITY_LENGTH || /\p{Cc}/u.test(id)) {
    throw new TypeError("canonical_identity_id_invalid");
  }
  return value.strength === "strong" ? id : null;
}

function declaredComplete(evidence) {
  if (evidence.sampleComplete === undefined) return false;
  if (typeof evidence.sampleComplete !== "boolean") {
    throw new TypeError("sample_complete_must_be_boolean");
  }
  return evidence.sampleComplete;
}

function contentManifestChecksum(evidence) {
  const value = evidence.contentManifestChecksum;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new TypeError("content_manifest_checksum_must_be_a_string");
  const checksum = value.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(checksum)) {
    throw new TypeError("content_manifest_checksum_invalid");
  }
  return checksum;
}

function normalizedHost(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_HOST_LENGTH) {
    throw new TypeError("host_invalid");
  }
  const raw = value.trim();
  if (!raw || /\p{Cc}/u.test(raw)) throw new TypeError("host_invalid");
  try {
    const parsed = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    return hostname ? `${hostname}${parsed.port ? `:${parsed.port}` : ""}` : null;
  } catch (_) {
    throw new TypeError("host_invalid");
  }
}

function normalizedSourceType(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_SOURCE_TYPE_LENGTH) {
    throw new TypeError("source_type_invalid");
  }
  const normalized = value.normalize("NFC").trim().toLowerCase();
  if (!normalized || /\p{Cc}/u.test(normalized)) throw new TypeError("source_type_invalid");
  return normalized;
}

function normalizedCategories(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new TypeError("categories_must_be_an_array");
  if (value.length > MAX_CATEGORIES) throw new RangeError("categories_too_large");
  const result = new Set();
  for (const entry of value) {
    if (typeof entry !== "string") throw new TypeError("category_must_be_string");
    const normalized = entry.normalize("NFC").trim().toLowerCase();
    if (!normalized || normalized.length > MAX_CATEGORY_LENGTH || /\p{Cc}/u.test(normalized)) {
      throw new TypeError("category_invalid");
    }
    result.add(normalized);
  }
  return result;
}

function jaccard(left, right) {
  const leftSet = left instanceof Set ? left : new Set(left);
  const rightSet = right instanceof Set ? right : new Set(right);
  let overlap = 0;
  for (const value of leftSet) if (rightSet.has(value)) overlap += 1;
  const union = leftSet.size + rightSet.size - overlap;
  return { overlap, union, score: union === 0 ? 0 : overlap / union };
}

function secondarySignals(current, candidate) {
  const currentHost = normalizedHost(current.host);
  const candidateHost = normalizedHost(candidate.host);
  const currentType = normalizedSourceType(current.sourceType);
  const candidateType = normalizedSourceType(candidate.sourceType);
  const currentCategories = normalizedCategories(current.categories);
  const candidateCategories = normalizedCategories(candidate.categories);
  const categoryMetric = currentCategories && candidateCategories
    ? jaccard(currentCategories, candidateCategories).score
    : null;

  return Object.freeze({
    hostMatch: currentHost && candidateHost ? currentHost === candidateHost : null,
    sourceTypeMatch: currentType && candidateType ? currentType === candidateType : null,
    categorySimilarity: categoryMetric,
  });
}

/**
 * Compare current and candidate movie+series catalogues.
 *
 * Raw identifiers, identity values, and manifest checksums are intentionally
 * absent from the returned object. SAME requires an independently computed,
 * exact content-manifest checksum match in addition to typed ID overlap. The
 * legacy registry identity is only a contradiction veto, never positive proof.
 */
export function compareProviderCatalogIdentity(input) {
  if (!isRecord(input)) throw new TypeError("identity_comparison_must_be_an_object");
  const current = input.current;
  const candidate = input.candidate;
  if (!isRecord(current) || !isRecord(candidate)) {
    throw new TypeError("identity_comparison_sides_must_be_objects");
  }

  const currentSample = bottomMd5Sample(current);
  const candidateSample = bottomMd5Sample(candidate);
  const similarity = jaccard(currentSample.ids, candidateSample.ids);
  const currentIdentity = strongCanonicalIdentity(current);
  const candidateIdentity = strongCanonicalIdentity(candidate);
  const strongIdentityConflict = Boolean(
    currentIdentity && candidateIdentity && currentIdentity !== candidateIdentity,
  );
  const currentComplete = declaredComplete(current);
  const candidateComplete = declaredComplete(candidate);
  const currentManifestChecksum = contentManifestChecksum(current);
  const candidateManifestChecksum = contentManifestChecksum(candidate);
  const manifestChecksumMatch = Boolean(
    currentManifestChecksum &&
    candidateManifestChecksum &&
    currentManifestChecksum === candidateManifestChecksum,
  );
  const enoughEvidence =
    currentSample.uniqueCount >= PROVIDER_CATALOG_IDENTITY_MIN_IDS &&
    candidateSample.uniqueCount >= PROVIDER_CATALOG_IDENTITY_MIN_IDS;

  let decision = PROVIDER_CATALOG_IDENTITY_DECISIONS.AMBIGUOUS;
  if (
    enoughEvidence &&
    currentComplete &&
    candidateComplete &&
    similarity.score >= SAME_CATALOG_THRESHOLD &&
    manifestChecksumMatch &&
    !strongIdentityConflict
  ) {
    decision = PROVIDER_CATALOG_IDENTITY_DECISIONS.SAME_CATALOG;
  }

  return Object.freeze({
    algorithmVersion: PROVIDER_CATALOG_IDENTITY_ALGORITHM_VERSION,
    decision,
    sampleSizeCurrent: currentSample.ids.length,
    sampleSizeCandidate: candidateSample.ids.length,
    uniqueIdCountCurrent: currentSample.uniqueCount,
    uniqueIdCountCandidate: candidateSample.uniqueCount,
    overlapCount: similarity.overlap,
    unionCount: similarity.union,
    similarityScore: similarity.score,
    evidenceComplete: Object.freeze({
      current: currentComplete,
      candidate: candidateComplete,
    }),
    contentManifest: Object.freeze({
      currentPresent: Boolean(currentManifestChecksum),
      candidatePresent: Boolean(candidateManifestChecksum),
      matching: manifestChecksumMatch,
    }),
    strongCanonicalIdentity: Object.freeze({
      currentPresent: Boolean(currentIdentity),
      candidatePresent: Boolean(candidateIdentity),
      contradictory: strongIdentityConflict,
    }),
    secondarySignals: secondarySignals(current, candidate),
  });
}
