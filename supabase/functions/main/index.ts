// Self-host edge-runtime router (from supabase/docker/volumes/functions/main).
// ONLY used by the Hetzner self-host stack, NOT the managed Supabase project
// (managed routes each function itself). ops/hetzner/docker-compose.supabase.yml
// mounts this whole dir at /home/deno/functions and starts edge-runtime with
// `--main-service /home/deno/functions/main`, so every /functions/v1/<name>
// request hits THIS worker, which parses <name> and spins up a per-function
// worker at /home/deno/functions/<name>. e.g. /functions/v1/norva-catalog ->
// norva-catalog/index.ts. Keep in sync with upstream on stack upgrades.
import * as jose from 'jsr:@panva/jose@6'

console.log('main function started')

const JWT_SECRET = Deno.env.get('JWT_SECRET')
const SUPABASE_JWKS = parseJwks(Deno.env.get('SUPABASE_JWKS'))
const VERIFY_JWT = Deno.env.get('VERIFY_JWT') === 'true'

// --- Worker pool (audit capacité 2026-07-17, voir le bloc dans le handler) ---
// Taille de pool par fonction USER-FACING chaude. Tout ce qui n'est pas listé =
// 1 worker (comportement historique) — notamment norva-source-sync, dont la
// chaîne discover/finalize par self-invoke suppose un isolate stable.
// 6+4+4 isolates × ~1 cœur pèsent au pire ~14 des 16 threads de l'AX42 — les
// crons/le reste gardent de la place, et la RAM (256 MB × 14 max) est négligeable
// sur 61 GB.
const HOT_POOL_SIZES: Record<string, number> = {
  'norva-cloud': 6,
  'norva-catalog': 4,
  'norva-playback': 4,
}
const workerPools = new Map<string, { slots: ({ worker: { fetch(r: Request): Promise<Response> } } | null)[]; next: number }>()
// Hoisted une fois : l'env ne change pas pendant la vie du conteneur (l'ancien
// code refaisait Deno.env.toObject() + map à CHAQUE requête).
const ENV_VARS = Object.entries(Deno.env.toObject())

// NOTE:(kallebysantos) We don't check for valid keys but just the bare array parsing,
// let this for 'jose' lib verification
export function parseJwks(raw: string | undefined): jose.JSONWebKeySet | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.keys && Array.isArray(parsed.keys)) {
      return parsed as jose.JSONWebKeySet
    }
    return null
  } catch {
    return null
  }
}

/**
 * Extract JWT token from Authorization header
 *
 * Parses the Authorization header to extract the Bearer token.
 * Expects format: "Bearer <token>"
 *
 * @param req - The HTTP request object
 * @returns The JWT token string
 * @throws Error if Authorization header is missing or malformed
 */
function getAuthToken(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader) {
    throw new Error('Missing authorization header')
  }
  const [bearer, token] = authHeader.split(' ')
  if (bearer !== 'Bearer') {
    throw new Error(`Auth header is not 'Bearer {token}'`)
  }
  return token
}

async function isValidLegacyJWT(jwt: string): Promise<boolean> {
  if (!JWT_SECRET) {
    console.error('JWT_SECRET not available for HS256 token verification')
    return false
  }

  const encoder = new TextEncoder();
  const secretKey = encoder.encode(JWT_SECRET);

  try {
    await jose.jwtVerify(jwt, secretKey);
  } catch (e) {
    console.error('Symmetric Legacy JWT verification error', e);
    return false;
  }
  return true;
}

async function isValidJWT(jwt: string): Promise<boolean> {
  if (!SUPABASE_JWKS) {
    console.error('JWKS not available for ES256/RS256 token verification')
    return false
  }

  try {
    const localJwks = jose.createLocalJWKSet(SUPABASE_JWKS);
    await jose.jwtVerify(jwt, localJwks);
  } catch (e) {
    console.error('Asymmetric JWT verification error', e);
    return false
  }

  return true;
}

/**
 * Verify JWT token, handling both legacy (HS256) and newer (ES256/RS256) algorithms
 *
 * This function automatically detects the algorithm used in the token and applies
 * the appropriate verification method:
 * - HS256: Uses JWT_SECRET (symmetric key)
 * - ES256/RS256: Uses JWKS endpoint (asymmetric public keys)
 *
 * This fix ensures compatibility with both legacy tokens and newer asymmetric tokens,
 * resolving the "Key for the ES256 algorithm must be of type CryptoKey" error.
 *
 * @param jwt - The JWT token string to verify
 * @returns Promise resolving to true if verification succeeds, false otherwise
 */
async function isValidHybridJWT(jwt: string): Promise<boolean> {
  const { alg: jwtAlgorithm } = jose.decodeProtectedHeader(jwt)

  if (jwtAlgorithm === 'HS256') {
    console.log(`Legacy token type detected, attempting ${jwtAlgorithm} verification.`)

    return await isValidLegacyJWT(jwt)
  }

  if (jwtAlgorithm === 'ES256' || jwtAlgorithm === 'RS256') {
    return await isValidJWT(jwt)
  }

  return false;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'OPTIONS' && VERIFY_JWT) {
    try {
      const token = getAuthToken(req)
      const isValidJWT = await isValidHybridJWT(token);

      if (!isValidJWT) {
        return new Response(JSON.stringify({ msg: 'Invalid JWT' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    } catch (e) {
      console.error(e)
      return new Response(JSON.stringify({ msg: e.toString() }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }

  const url = new URL(req.url)
  const { pathname } = url
  const path_parts = pathname.split('/')
  const service_name = path_parts[1]

  if (!service_name || service_name === '') {
    const error = { msg: 'missing function name in request' }
    return new Response(JSON.stringify(error), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const servicePath = `/home/deno/functions/${service_name}`

  // Must comfortably exceed the sync engine's per-isolate work budget
  // (SYNC_DRIVE_BUDGET_MS = 90s in _shared/xtream-sync.ts, and the 90s finalize
  // loop deadline in norva-source-sync). Those loops run ~90s of work and THEN
  // self-invoke the next isolate; if the worker is recycled before that hand-off
  // lands, the discover/finalize chain breaks and the watchdog re-runs the same
  // slice forever (observed on a 275k catalogue: "wall clock duration warning"
  // every minute, finalize frozen on building_titles). 60s < 90s was the bug.
  // 180s = 90s budget + margin for a slow final batch + the self-invoke fetch.
  const workerTimeoutMs = 3 * 60 * 1000
  const noModuleCache = false
  const importMapPath = null

  // Worker POOL (audit capacité 2026-07-17) : un isolate V8 est monothread — avec
  // UN worker par fonction, norva-cloud plafonnait à ~32 req/s authentifiées sur
  // UN cœur pendant que les 15 autres dormaient (k6 1000 VUs : 82 % de rejets en
  // 500/401, débit de succès constant à 31,5/s sur deux runs). Les fonctions
  // user-facing chaudes reçoivent N isolates round-robin (N cœurs utilisables,
  // mémoire par worker relevée — elles brassent du gros JSON) ; tout le reste
  // (crons, sync self-invoke, webhooks) garde exactement l'ancien comportement
  // mono-worker. Un worker recyclé (timeout 180 s) est respawné en transparence.
  const poolSize = HOT_POOL_SIZES[service_name] ?? 1
  const memoryLimitMb = poolSize > 1 ? 256 : 150

  const createWorker = () =>
    EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb,
      workerTimeoutMs,
      noModuleCache,
      importMapPath,
      envVars: ENV_VARS,
      // Several LIVE isolates for one servicePath need forceCreate; the default
      // (reuse-by-path) is kept for pool size 1 — the exact pre-pool semantics.
      forceCreate: poolSize > 1,
    })

  let pool = workerPools.get(servicePath)
  if (!pool) {
    pool = { slots: new Array(poolSize).fill(null), next: 0 }
    workerPools.set(servicePath, pool)
  }
  const slot = pool.next
  pool.next = (pool.next + 1) % pool.slots.length

  try {
    if (!pool.slots[slot]) {
      console.error(`creating worker ${slot + 1}/${pool.slots.length} for ${servicePath}`)
      pool.slots[slot] = { worker: await createWorker() }
    }
    try {
      return await pool.slots[slot]!.worker.fetch(req)
    } catch (workerErr) {
      // Dead/recycled worker → one transparent respawn+retry, but never replay a
      // request whose body was already consumed (a POST half-read by the dying
      // worker must fail loudly, not double-apply).
      if (req.bodyUsed) throw workerErr
      pool.slots[slot] = { worker: await createWorker() }
      return await pool.slots[slot]!.worker.fetch(req)
    }
  } catch (e) {
    pool.slots[slot] = null // next hit on this slot respawns from scratch
    const error = { msg: e.toString() }
    return new Response(JSON.stringify(error), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
