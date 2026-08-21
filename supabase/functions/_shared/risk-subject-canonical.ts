// Canonical form of every risk subject, computed before it is ever keyed.
//
// This exists because the velocity store counts identifiers, not addresses, and
// two spellings of one address must produce one identifier. IPv6 is where that
// bites: 2001:db8::1 and 2001:0db8:0000:0000:0000:0000:0000:0001 are the same
// host, and HMAC-ing the raw strings would file them as two different networks —
// which is not a crash, not a test failure, and not visible in any log. It would
// simply make the engine quietly worse at the job it exists for, and would
// poison the very distribution the observe phase is meant to measure.
//
// Every dimension goes through here. A value this module cannot parse returns
// null, and the caller drops that one signal rather than counting a wrong
// subject: a missing signal costs a little accuracy, a wrong subject costs a
// real user.
//
// IP output is deliberately the fully expanded form rather than the shortest
// one. Compression has rules (leftmost longest run of zeros, and only one ::)
// that are easy to implement subtly wrong; expansion has none. The value is
// never displayed, only hashed, so legibility buys nothing and ambiguity costs
// everything.

export type RiskSubjectDimension =
  | "ip"
  | "ip_subnet_24"
  | "ip_subnet_64"
  | "asn"
  | "email"
  | "device"
  | "user_agent";

/** Reject leading zeros: 010.1.1.1 is read as octal by some resolvers and as
 * decimal by others, so it has no single meaning worth counting. */
function parseIpv4(input: string): Uint8Array | null {
  const parts = input.trim().split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(parts[i])) return null;
    const value = Number(parts[i]);
    if (value > 255) return null;
    out[i] = value;
  }
  return out;
}

function parseIpv6(input: string): Uint8Array | null {
  let text = input.trim().toLowerCase();
  // A zone index identifies a local interface, never a peer: 2001:db8::1%eth0
  // and 2001:db8::1 are one address as far as the internet is concerned.
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (!text) return null;

  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes the two hextets it encodes,
  // so it collapses onto the identical ::ffff:102:304 spelling.
  if (text.includes(".")) {
    const colon = text.lastIndexOf(":");
    if (colon < 0) return null;
    const v4 = parseIpv4(text.slice(colon + 1));
    if (!v4) return null;
    const high = ((v4[0] << 8) | v4[1]).toString(16);
    const low = ((v4[2] << 8) | v4[3]).toString(16);
    text = `${text.slice(0, colon + 1)}${high}:${low}`;
  }

  const double = text.indexOf("::");
  let head: string[];
  let tail: string[];
  if (double >= 0) {
    if (text.indexOf("::", double + 1) >= 0) return null;
    head = text.slice(0, double) ? text.slice(0, double).split(":") : [];
    tail = text.slice(double + 2) ? text.slice(double + 2).split(":") : [];
    // :: must stand for at least one group, so the explicit ones cannot fill it.
    if (head.length + tail.length > 7) return null;
  } else {
    head = text.split(":");
    tail = [];
    if (head.length !== 8) return null;
  }

  const groups = [
    ...head,
    ...new Array(8 - head.length - tail.length).fill("0"),
    ...tail,
  ];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    const value = Number.parseInt(groups[i], 16);
    out[i * 2] = value >> 8;
    out[i * 2 + 1] = value & 0xff;
  }
  return out;
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * One canonical string per subject, or null when the value cannot be parsed.
 *
 * Subnet dimensions take the FULL address and mask it here. Callers never do
 * network arithmetic: one place owns it, and one place is where it gets tested.
 *
 * The family prefix keeps an IPv4 address and an IPv4-mapped IPv6 address from
 * silently sharing a counter, and keeps a /24 from ever colliding with a /64.
 */
export function canonicalizeRiskSubject(
  dimension: RiskSubjectDimension,
  value: string,
): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  switch (dimension) {
    case "ip": {
      const v4 = parseIpv4(raw);
      if (v4) return `4:${hex(v4)}`;
      const v6 = parseIpv6(raw);
      return v6 ? `6:${hex(v6)}` : null;
    }
    case "ip_subnet_24": {
      // IPv4 only. Masking is done on the bytes, never by cutting the text at
      // the last dot — 1.2.3.4 and 1.2.3.40 share a /24 and must not be told
      // apart by string surgery.
      const v4 = parseIpv4(raw);
      if (!v4) return null;
      const masked = new Uint8Array([v4[0], v4[1], v4[2], 0]);
      return `4/24:${hex(masked)}`;
    }
    case "ip_subnet_64": {
      // IPv6 only, and a /64 rather than a /48: one LAN is one subscriber,
      // whereas a /48 can be a whole carrier region.
      const v6 = parseIpv6(raw);
      if (!v6) return null;
      const masked = new Uint8Array(16);
      masked.set(v6.subarray(0, 8), 0);
      return `6/64:${hex(masked)}`;
    }
    case "asn": {
      const digits = raw.toLowerCase().replace(/^as/, "");
      if (!/^[0-9]{1,10}$/.test(digits)) return null;
      const value32 = Number(digits);
      // 32-bit ASNs are the whole space; anything larger is not an ASN.
      if (!Number.isSafeInteger(value32) || value32 > 4294967295) return null;
      return `asn:${value32}`;
    }
    case "email": {
      // Lowercased only, matching what the auth layer stores. Local-part
      // folding — Gmail dots, plus-tags — is a provider-specific policy call
      // and is deliberately not decided here.
      const email = raw.toLowerCase();
      const at = email.lastIndexOf("@");
      if (at <= 0 || at === email.length - 1) return null;
      return `email:${email}`;
    }
    case "device":
      // Opaque by contract: this is our own cookie value, and any transformation
      // could only lose information.
      return `device:${raw}`;
    case "user_agent":
      // Collapse runs of whitespace so a proxy reformatting the header does not
      // fork the counter, but change nothing else.
      return `ua:${raw.replace(/\s+/g, " ")}`;
    default:
      return null;
  }
}
