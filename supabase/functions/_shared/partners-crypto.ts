const UTF8 = new TextEncoder();

export function utf8(value: string): Uint8Array {
  return UTF8.encode(value);
}

export function bytesToHex(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function randomHex(byteLength: number): string {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    byteLength > 1_024
  ) {
    throw new Error("Invalid random byte length");
  }
  return bytesToHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Hex(
  value: string | Uint8Array,
): Promise<string> {
  const bytes = typeof value === "string" ? utf8(value) : value;
  return bytesToHex(
    await crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes)),
  );
}

export async function hmacSha256Hex(
  secret: string,
  value: string | Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    ownedArrayBuffer(utf8(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = typeof value === "string" ? utf8(value) : value;
  return bytesToHex(
    await crypto.subtle.sign("HMAC", key, ownedArrayBuffer(bytes)),
  );
}

export function timingSafeEqualText(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function ownedArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
