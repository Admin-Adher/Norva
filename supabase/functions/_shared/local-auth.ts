// Vérification JWT locale — délestage de GoTrue sur les chemins chauds.
//
// Contexte (test de charge k6 du 2026-07-17) : chaque requête de fonction
// faisait un aller-retour interne GET /auth/v1/user (Kong → GoTrue) pour
// valider le bearer. À ~130 req/s, GoTrue s'est effondré (67k HTTP 500 sur un
// run, latence /user 30 ms → 126 ms) et chaque 500 devenait un « 401 Invalid
// bearer token » côté client — pendant que Postgres s'ennuyait. Cet
// aller-retour n'apporte AUCUNE autorisation supplémentaire aux endpoints
// adossés à PostgREST : PostgREST re-vérifie lui-même signature + exp du même
// JWT sur chaque requête DB (c'est le mécanisme RLS).
//
// Compromis assumé (identique au VERIFY_JWT natif de Supabase managé) : un
// token signé et non expiré reste accepté jusqu'à son exp (≤1 h) même si la
// session est révoquée côté GoTrue entre-temps. Les chemins sensibles
// (admin, suppression de compte, billing) gardent leur getUser/getUserById.
import * as jose from "jsr:@panva/jose@6";

export type LocalUser = { id: string; email?: string };

const JWT_SECRET = Deno.env.get("JWT_SECRET") ?? "";
const secretKey = JWT_SECRET ? new TextEncoder().encode(JWT_SECRET) : null;

// Verdicts :
//  - LocalUser   → token utilisateur valide (signature, exp, aud, role, sub OK).
//  - "invalid"   → verdict local DÉFINITIF : pas un JWT (token device, chaîne
//                  quelconque) ou JWT HS256 invalide/expiré. Inutile d'appeler
//                  GoTrue — il partage le même secret et dirait pareil.
//  - "fallback"  → indécidable localement (alg asymétrique futur, ou
//                  JWT_SECRET absent de l'env) : l'appelant garde son
//                  db.auth.getUser historique.
export async function verifyUserJwtLocally(
  token: string,
): Promise<LocalUser | "invalid" | "fallback"> {
  let alg: string | undefined;
  try {
    ({ alg } = jose.decodeProtectedHeader(token));
  } catch {
    return "invalid";
  }
  if (alg !== "HS256" || !secretKey) return "fallback";

  try {
    const { payload } = await jose.jwtVerify(token, secretKey, {
      audience: "authenticated",
      clockTolerance: 5,
    });
    const sub = typeof payload.sub === "string" ? payload.sub : "";
    // La clé anon et la service_role key sont signées avec le MÊME secret mais
    // role=anon/service_role et sans sub : ce ne sont pas des identités user.
    if (!sub || payload.role !== "authenticated") return "invalid";
    const email = typeof payload.email === "string" && payload.email ? payload.email : undefined;
    return { id: sub, email };
  } catch {
    return "invalid";
  }
}
