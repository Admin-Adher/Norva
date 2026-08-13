const encoder = new TextEncoder();
const decoder = new TextDecoder();
const AAD = encoder.encode("norva-relay-coordinator-route-v1");
const ROUTE_PATTERN = /^[A-Za-z0-9_-]{95}$/;

export function isSealedRelayCoordinatorRoute(value) {
  return ROUTE_PATTERN.test(String(value || "").trim());
}

export async function sealRelayCoordinatorRoute(secret, coordinatorKey) {
  const value = String(coordinatorKey || "").trim();
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("Invalid relay coordinator route input");
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await coordinatorEncryptionKey(secret, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: AAD },
    key,
    encoder.encode(value),
  ));
  const packed = new Uint8Array(iv.length + encrypted.length);
  packed.set(iv);
  packed.set(encrypted, iv.length);
  return base64Url(packed);
}

export async function openRelayCoordinatorRoute(secret, route) {
  if (!secret || !isSealedRelayCoordinatorRoute(route)) {
    throw new Error("Invalid sealed relay coordinator route");
  }
  const packed = base64UrlBytes(route);
  const iv = packed.slice(0, 12);
  const ciphertext = packed.slice(12);
  const key = await coordinatorEncryptionKey(secret, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: AAD },
    key,
    ciphertext,
  );
  const value = decoder.decode(decrypted);
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("Invalid relay coordinator key");
  }
  return value;
}

async function coordinatorEncryptionKey(secret, usages) {
  const material = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`norva-relay-coordinator-key-v1:${secret}`),
  );
  return await crypto.subtle.importKey("raw", material, "AES-GCM", false, usages);
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
