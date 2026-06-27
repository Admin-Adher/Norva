import { createClient } from "npm:@supabase/supabase-js@2";

// norva-tmdb-origlang - service-gated backfill that fills catalog_titles.original_language from
// TMDB (the title's source language, e.g. 'ja' for an anime, 'en' for a US show). Used by the
// player to resolve a VOSTFR/VO ("original" version) audio track to its REAL language instead of
// a bare "Default"/"VO". Hits TMDB only (NOT the IPTV provider), so the provider lock is
// irrelevant. Gated by NORVA_BACKFILL_TOKEN; driven by pg_cron. Self-contained on purpose.

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
const BACKFILL_TOKEN = Deno.env.get("NORVA_BACKFILL_TOKEN") ?? "";
const TMDB_KEY =
  Deno.env.get("NORVA_TMDB_API_KEY") ?? Deno.env.get("TMDB_API_KEY") ?? Deno.env.get("TMDB_READ_TOKEN") ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Missing SUPABASE_URL or service key");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!BACKFILL_TOKEN || token !== BACKFILL_TOKEN) return json({ error: "Unauthorized" }, 401);
    if (!TMDB_KEY) return json({ error: "TMDB key not configured" }, 503);

    const body = (await req.json().catch(() => ({}))) as JsonRecord;
    const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 500);
    const ids = Array.isArray(body.ids) ? body.ids.map((v) => String(v)) : null;
    return json(await backfill(limit, ids));
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "backfill failed" }, 500);
  }
});

async function backfill(limit: number, ids: string[] | null) {
  // Test path: explicit tmdb ids (any state). Default: rows still missing original_language.
  const query = ids && ids.length
    ? supabase.from("catalog_titles").select("item_type, provider_tmdb_id").in("provider_tmdb_id", ids)
    : supabase.from("catalog_titles").select("item_type, provider_tmdb_id")
        .is("original_language", null).not("provider_tmdb_id", "is", null).limit(limit);
  const { data: rows, error } = await query;
  if (error) return { error: error.message };
  const targets = (rows ?? []).filter((r) => /^\d+$/.test(String((r as JsonRecord).provider_tmdb_id)));

  let updated = 0, missing = 0, failed = 0;
  let lastError: string | null = null;
  for (const r of targets) {
    const itemType = String((r as JsonRecord).item_type);
    const tmdbId = String((r as JsonRecord).provider_tmdb_id);
    try {
      const lang = await tmdbOriginalLanguage(itemType, tmdbId);
      if (lang) {
        const { error: upErr } = await supabase.from("catalog_titles")
          .update({ original_language: lang })
          .eq("item_type", itemType).eq("provider_tmdb_id", tmdbId);
        if (upErr) { failed++; lastError = upErr.message; } else updated++;
      } else {
        missing++;
      }
    } catch (e) {
      failed++;
      lastError = e instanceof Error ? e.message : String(e);
    }
    await sleep(60); // gentle on TMDB (well under its rate limit)
  }
  return { attempted: targets.length, updated, missing, failed, lastError };
}

async function tmdbOriginalLanguage(itemType: string, tmdbId: string): Promise<string | null> {
  const endpoint = itemType === "series" ? "tv" : "movie";
  const url = new URL(`https://api.themoviedb.org/3/${endpoint}/${encodeURIComponent(tmdbId)}`);
  const headers: Record<string, string> = {};
  if (TMDB_KEY.startsWith("eyJ")) headers.Authorization = `Bearer ${TMDB_KEY}`;
  else url.searchParams.set("api_key", TMDB_KEY);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const resp = await fetch(url.toString(), { signal: ctrl.signal, headers });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    const lang = data && typeof data === "object" ? (data as JsonRecord).original_language : null;
    const code = String(lang ?? "").toLowerCase().trim();
    return /^[a-z]{2,3}$/.test(code) ? code : null;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
