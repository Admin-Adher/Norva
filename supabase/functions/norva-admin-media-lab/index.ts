import { createClient } from "npm:@supabase/supabase-js@2";
import {
  MEDIA_LAB_PROTOCOL,
  parseMediaLabRunRequest,
  projectMediaLabRunnerState,
} from "../_shared/media-lab-contract.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
const LAB_ENABLED = Deno.env.get("NORVA_MEDIA_LAB_ENABLED") === "true";
const RUNNER_URL = (Deno.env.get("NORVA_MEDIA_LAB_RUNNER_URL") ?? "").trim().replace(/\/+$/, "");
const RUNNER_TOKEN = Deno.env.get("NORVA_MEDIA_LAB_RUNNER_TOKEN") ?? "";
const ACTOR_HMAC_KEY_HEX = (Deno.env.get("NORVA_MEDIA_LAB_ACTOR_HMAC_KEY") ?? "").trim().toLowerCase();
const MAX_REQUEST_BYTES = 512;
const MAX_RUNNER_RESPONSE_BYTES = 64 * 1024;
const RUNNER_TIMEOUT_MS = 12_000;

if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("Missing Supabase service configuration");

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  "https://norva.tv",
  "https://www.norva.tv",
  "https://app.norva.tv",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:4173",
]);

function configuredOrigins(): Set<string> {
  const raw = (Deno.env.get("NORVA_ADMIN_ALLOWED_ORIGINS") ?? "")
    .split(",").map((entry) => entry.trim()).filter(Boolean);
  const origins = raw.length ? raw : [...DEFAULT_ALLOWED_ORIGINS];
  return new Set(origins.filter((entry) => entry !== "*"));
}

function acceptedOrigin(req: Request): string | null {
  const origin = req.headers.get("Origin");
  if (!origin) return null;
  return configuredOrigins().has(origin) ? origin : null;
}

function responseHeaders(origin: string | null): HeadersInit {
  return {
    ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin",
  };
}

function json(origin: string | null, value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: responseHeaders(origin) });
}

function safeRunnerConfiguration(): { url: string; token: string; actorKey: Uint8Array } | null {
  if (!LAB_ENABLED || RUNNER_TOKEN.length < 32 || /[\u0000\r\n]/.test(RUNNER_TOKEN) ||
      !/^[a-f0-9]{64}$/.test(ACTOR_HMAC_KEY_HEX)) return null;
  let parsed: URL;
  try { parsed = new URL(RUNNER_URL); } catch (_) { return null; }
  // This bearer is dedicated to the Docker-private Lab. Never forward it to
  // a public or merely configurable origin if an operator mistypes the env.
  if (parsed.protocol !== "http:" || parsed.hostname !== "norva-media-lab-runner" ||
      parsed.port !== "8093" || parsed.pathname !== "/" || parsed.username ||
      parsed.password || parsed.search || parsed.hash) return null;
  return {
    url: parsed.toString().replace(/\/+$/, ""),
    token: RUNNER_TOKEN,
    actorKey: Uint8Array.from(ACTOR_HMAC_KEY_HEX.match(/../g)!.map((byte) => Number.parseInt(byte, 16))),
  };
}

function bearerToken(req: Request): string | null {
  const match = /^Bearer ([^\s]{16,8192})$/.exec(req.headers.get("Authorization") ?? "");
  return match ? match[1] : null;
}

async function requireAdmin(req: Request): Promise<{ id: string } | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  const user = data?.user;
  if (error || !user || user.app_metadata?.role !== "admin") return null;
  return { id: user.id };
}

async function actorDigest(userId: string, keyBytes: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`norva-media-lab-actor-v1\0${userId}`),
  ));
  return btoa(String.fromCharCode(...signature)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function readBoundedJson(response: Response): Promise<unknown | null> {
  if (!response.body) return null;
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_RUNNER_RESPONSE_BYTES) {
    await response.body.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      total += value.length;
      if (total > MAX_RUNNER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch (_) { return null; }
}

function routeName(req: Request): string | null {
  const segments = new URL(req.url).pathname.split("/").filter(Boolean);
  const index = segments.lastIndexOf("norva-admin-media-lab");
  if (index < 0) return null;
  const tail = segments.slice(index + 1).join("/");
  return tail === "run" || tail === "current" ? tail : null;
}

async function strictJsonBody(req: Request): Promise<unknown | null> {
  const declared = Number(req.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return null;
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_REQUEST_BYTES) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

Deno.serve(async (req: Request) => {
  const originHeader = req.headers.get("Origin");
  const origin = acceptedOrigin(req);
  if (originHeader && !origin) return json(null, { protocol: MEDIA_LAB_PROTOCOL, error: "origin-not-allowed" }, 403);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(origin) });

  const route = routeName(req);
  if (!route || (route === "run" && req.method !== "POST") ||
      (route === "current" && !["GET", "DELETE"].includes(req.method))) {
    return json(origin, { protocol: MEDIA_LAB_PROTOCOL, error: "not-found" }, 404);
  }
  const user = await requireAdmin(req);
  if (!user) return json(origin, { protocol: MEDIA_LAB_PROTOCOL, error: "admin-required" }, 403);
  const config = safeRunnerConfiguration();
  if (!config) return json(origin, { protocol: MEDIA_LAB_PROTOCOL, error: "lab-disabled" }, 503);

  let runRequest: ReturnType<typeof parseMediaLabRunRequest> = null;
  if (route === "run") {
    runRequest = parseMediaLabRunRequest(await strictJsonBody(req));
    if (!runRequest) return json(origin, { protocol: MEDIA_LAB_PROTOCOL, error: "invalid-request" }, 400);
  }

  const actor = await actorDigest(user.id, config.actorKey);
  const runnerPath = route === "run" ? "/v1/current" : "/v1/current";
  let runnerResponse: Response;
  try {
    runnerResponse = await fetch(`${config.url}${runnerPath}`, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        "X-Norva-Lab-Actor": actor,
        ...(runRequest ? { "Content-Type": "application/json" } : {}),
      },
      body: runRequest ? JSON.stringify(runRequest) : undefined,
      signal: AbortSignal.timeout(RUNNER_TIMEOUT_MS),
    });
  } catch (_) {
    return json(origin, { protocol: MEDIA_LAB_PROTOCOL, error: "lab-runner-unavailable" }, 503);
  }

  if (req.method === "DELETE" && runnerResponse.status === 204) {
    await runnerResponse.body?.cancel().catch(() => {});
    return new Response(null, { status: 204, headers: responseHeaders(origin) });
  }
  const projected = projectMediaLabRunnerState(await readBoundedJson(runnerResponse));
  if (!projected) return json(origin, { protocol: MEDIA_LAB_PROTOCOL, error: "lab-runner-invalid-response" }, 502);
  if (!runnerResponse.ok) {
    return runnerResponse.status === 409 && projected.state === "busy"
      ? json(origin, projected, 409)
      : json(origin, { protocol: MEDIA_LAB_PROTOCOL, error: "lab-runner-refused" }, 503);
  }
  return json(origin, projected, req.method === "POST" ? 202 : 200);
});
