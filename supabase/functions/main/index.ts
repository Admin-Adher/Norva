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

// --- Worker pool par ALIAS de chemin (audit capacité 2026-07-17, v2) -----------
// Un isolate V8 est monothread : avec UN worker par fonction, norva-cloud
// plafonnait à ~32 req/s sur UN cœur (k6 : 82 % de rejets à 1000 VUs). La v1 du
// pool gardait des HANDLES de workers — un handle mort ne se rafraîchit pas dans
// ce runtime, chaque erreur déclenchait un forceCreate de plus (constaté : ~660
// recréations par slot pendant le run STRESS → effondrement en timeouts). La v2
// travaille AVEC la sémantique upstream : chaque fonction chaude a N-1 modules
// « lane » d'une ligne (norva-cloud--p2..p6 → import du vrai index.ts) ; un
// chemin distinct = un worker distinct que le RUNTIME gère (création par
// requête, dédoublonnage par chemin, respawn transparent d'un worker recyclé).
// Le routeur fait un simple round-robin d'alias — zéro état conservé.
// Tout ce qui n'est pas listé garde le mono-worker historique (crons,
// norva-source-sync et sa chaîne self-invoke, webhooks).
const HOT_POOL_SIZES: Record<string, number> = {
  'norva-cloud': 6,
  'norva-catalog': 4,
  'norva-playback': 4,
}
const rrCounters = new Map<string, number>()
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

  // Round-robin des lanes : lane 0 = le dossier réel, lanes 1..N-1 = les modules
  // alias --p2..--pN (voir HOT_POOL_SIZES). Un compteur par service suffit —
  // aucun handle de worker n'est conservé (la leçon de la v1).
  const poolSize = HOT_POOL_SIZES[service_name] ?? 1
  let laneName = service_name
  if (poolSize > 1) {
    const n = (rrCounters.get(service_name) ?? 0) + 1
    rrCounters.set(service_name, n)
    const lane = n % poolSize
    if (lane > 0) laneName = `${service_name}--p${lane + 1}`
  }
  const servicePath = `/home/deno/functions/${laneName}`

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
  // Les lanes chaudes brassent du gros JSON sous concurrence — un peu plus d'air
  // que les 150 MB historiques (la RAM totale reste négligeable sur 61 GB).
  const memoryLimitMb = poolSize > 1 ? 256 : 150

  try {
    // Sémantique upstream STRICTE : create() à chaque requête — le runtime rend le
    // worker vivant de ce chemin ou en respawne un, sans handle à périmer chez nous.
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb,
      workerTimeoutMs,
      noModuleCache,
      importMapPath,
      envVars: ENV_VARS,
    })
    return await worker.fetch(req)
  } catch (e) {
    const error = { msg: e.toString() }
    return new Response(JSON.stringify(error), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
