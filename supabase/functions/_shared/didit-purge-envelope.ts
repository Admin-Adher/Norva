import { sha256Hex, timingSafeEqualText, utf8 } from "./partners-crypto.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_VERSION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,15}$/;
const SESSION_HASH_PATTERN = /^[0-9a-f]{64}$/;
const ENVELOPE_PATTERN =
  /^v1\.([a-z0-9][a-z0-9_-]{0,15})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,384})$/;

export type DiditPurgeKeyring = Readonly<{
  activeVersion: string;
  keys: ReadonlyMap<string, Uint8Array>;
}>;

export class DiditPurgeEnvelopeError extends Error {
  constructor() {
    super("Invalid Didit purge envelope");
    this.name = "DiditPurgeEnvelopeError";
  }
}

export function loadDiditPurgeKeyring(
  get: (name: string) => string | undefined,
): DiditPurgeKeyring | null {
  const rawKeys = get("NORVA_PARTNERS_DIDIT_PURGE_KEYS_JSON");
  const activeVersion = get(
    "NORVA_PARTNERS_DIDIT_PURGE_ACTIVE_KEY_VERSION",
  );
  if (!rawKeys || !activeVersion) return null;
  if (
    rawKeys.length > 4_096 ||
    !KEY_VERSION_PATTERN.test(activeVersion)
  ) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawKeys);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return null;
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 4) return null;
  const keys = new Map<string, Uint8Array>();
  try {
    for (const [version, encoded] of entries) {
      if (
        !KEY_VERSION_PATTERN.test(version) ||
        typeof encoded !== "string" ||
        encoded.length !== 43
      ) {
        return null;
      }
      const decoded = decodeBase64Url(encoded);
      if (decoded.byteLength !== 32) return null;
      keys.set(version, decoded);
    }
  } catch {
    return null;
  }
  if (!keys.has(activeVersion)) return null;
  return { activeVersion, keys };
}

export async function diditProviderSessionHash(
  providerSessionId: string,
): Promise<string> {
  const canonical = canonicalSessionId(providerSessionId);
  return await sha256Hex(`norva:didit:session:v1:${canonical}`);
}

export async function encryptDiditPurgeEnvelope(
  providerSessionId: string,
  providerSessionHash: string,
  keyring: DiditPurgeKeyring,
): Promise<string> {
  const canonical = canonicalSessionId(providerSessionId);
  assertSessionHash(providerSessionHash);
  const expectedHash = await diditProviderSessionHash(canonical);
  if (!timingSafeEqualText(expectedHash, providerSessionHash)) {
    throw new DiditPurgeEnvelopeError();
  }
  const rawKey = keyring.keys.get(keyring.activeVersion);
  if (!rawKey) throw new DiditPurgeEnvelopeError();

  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesKey(rawKey, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: ownedBuffer(nonce),
      additionalData: ownedBuffer(aad(providerSessionHash)),
      tagLength: 128,
    },
    key,
    ownedBuffer(utf8(canonical)),
  );
  return [
    "v1",
    keyring.activeVersion,
    encodeBase64Url(nonce),
    encodeBase64Url(new Uint8Array(ciphertext)),
  ].join(".");
}

export async function decryptDiditPurgeEnvelope(
  envelope: string,
  providerSessionHash: string,
  keyring: DiditPurgeKeyring,
): Promise<string> {
  assertSessionHash(providerSessionHash);
  if (typeof envelope !== "string" || envelope.length > 512) {
    throw new DiditPurgeEnvelopeError();
  }
  const match = envelope.match(ENVELOPE_PATTERN);
  if (!match) throw new DiditPurgeEnvelopeError();
  const rawKey = keyring.keys.get(match[1]);
  if (!rawKey) throw new DiditPurgeEnvelopeError();

  try {
    const nonce = decodeBase64Url(match[2]);
    const ciphertext = decodeBase64Url(match[3]);
    if (nonce.byteLength !== 12 || ciphertext.byteLength < 17) {
      throw new DiditPurgeEnvelopeError();
    }
    const key = await importAesKey(rawKey, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ownedBuffer(nonce),
        additionalData: ownedBuffer(aad(providerSessionHash)),
        tagLength: 128,
      },
      key,
      ownedBuffer(ciphertext),
    );
    const sessionId = canonicalSessionId(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
    );
    const observedHash = await diditProviderSessionHash(sessionId);
    if (!timingSafeEqualText(observedHash, providerSessionHash)) {
      throw new DiditPurgeEnvelopeError();
    }
    return sessionId;
  } catch (error) {
    if (error instanceof DiditPurgeEnvelopeError) throw error;
    throw new DiditPurgeEnvelopeError();
  }
}

function canonicalSessionId(value: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new DiditPurgeEnvelopeError();
  }
  return value.toLowerCase();
}

function assertSessionHash(value: string): void {
  if (!SESSION_HASH_PATTERN.test(value)) {
    throw new DiditPurgeEnvelopeError();
  }
}

function aad(providerSessionHash: string): Uint8Array {
  return utf8(`norva:partners:didit-purge:v1:${providerSessionHash}`);
}

async function importAesKey(
  raw: Uint8Array,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    ownedBuffer(raw),
    { name: "AES-GCM" },
    false,
    usages,
  );
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/g,
    "",
  );
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new DiditPurgeEnvelopeError();
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
