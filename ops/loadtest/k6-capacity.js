// =============================================================================
// k6-capacity.js — test de charge « 1000 users simultanés » sur la box Hetzner
// =============================================================================
// Modélise 1000 utilisateurs RÉELS (pas 1000 req/s aveugles) :
//   - scénario `browse`     : montée progressive jusqu'à USERS VUs, chacun fait le
//     cold start /boot puis lit history/favorites avec un temps de lecture humain
//     (5-15 s) — ~2 req/s pour 20 VUs, ~100 req/s à 1000 VUs.
//   - scénario `heartbeats` : (WRITE=1 + TOKEN requis) USERS/10 écritures/s de
//     progression — la charge d'écriture dominante d'un parc de viewers (1 POST
//     /10 s par lecture en cours), items `k6-<VU>` sur le COMPTE DE TEST, sans
//     sourceId (aucune source réelle touchée). Nettoyage : voir README.
//
// La chaîne traversée est la vraie prod : Caddy (TLS) → Kong → edge-runtime
// (norva-cloud) → PostgREST → Postgres. C'est exactement le chemin que 1000
// vrais users emprunteraient — les flux vidéo, eux, ne passent pas par la box.
//
// Usage (depuis TA machine, jamais depuis la box — voir README.md) :
//   smoke (50 VUs, 3 min)  : k6 run -e SMOKE=1 -e APIKEY=... k6-capacity.js
//   lecture seule 1000 VUs : k6 run -e APIKEY=... -e TOKEN=... k6-capacity.js
//   complet avec écritures : k6 run -e APIKEY=... -e TOKEN=... -e WRITE=1 k6-capacity.js
// =============================================================================
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = (__ENV.BASE_URL || 'https://api.norva.tv').replace(/\/+$/, '');
const APIKEY = __ENV.APIKEY || ''; // clé publishable (anon) — la même que le front
const TOKEN = __ENV.TOKEN || '';   // access_token du COMPTE DE TEST (README §2)
const WRITE = __ENV.WRITE === '1';
const USERS = Number(__ENV.USERS || 1000);
const SMOKE = __ENV.SMOKE === '1';

const target = SMOKE ? Math.min(50, USERS) : USERS;

const scenarios = {
  browse: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: SMOKE ? '30s' : '5m', target },          // montée douce
      { duration: SMOKE ? '2m' : '10m', target },          // palier
      { duration: '30s', target: 0 },
    ],
    exec: 'browse',
    gracefulRampDown: '10s',
  },
};
if (WRITE && TOKEN) {
  scenarios.heartbeats = {
    executor: 'constant-arrival-rate',
    rate: Math.max(1, Math.round(target / 10)), // 1000 users → 100 heartbeats/s
    timeUnit: '1s',
    duration: SMOKE ? '2m' : '10m',
    preAllocatedVUs: Math.min(300, Math.max(20, Math.round(target / 4))),
    startTime: SMOKE ? '30s' : '3m',            // démarre une fois le palier browse posé
    exec: 'heartbeat',
  };
}

export const options = {
  scenarios,
  thresholds: {
    // Critères de réussite : <1 % d'erreurs, p95 lecture <500 ms, p95 écriture <400 ms.
    http_req_failed: ['rate<0.01'],
    'http_req_duration{kind:read}': ['p(95)<500', 'p(99)<1500'],
    'http_req_duration{kind:write}': ['p(95)<400', 'p(99)<1200'],
  },
};

const headers = () => ({
  'Content-Type': 'application/json',
  ...(APIKEY ? { apikey: APIKEY } : {}),
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
});

export function browse() {
  if (TOKEN) {
    // Le vrai cold start de l'app : l'agrégat /boot (profil+profils+entitlements+
    // sources+trial en un appel) — l'endpoint le plus lourd du parcours réel.
    const boot = http.get(`${BASE}/functions/v1/norva-cloud/boot`, { headers: headers(), tags: { kind: 'read', ep: 'boot' } });
    check(boot, { 'boot 200': (r) => r.status === 200 });
    sleep(1 + Math.random() * 2);
    const hist = http.get(`${BASE}/functions/v1/norva-cloud/history?limit=60`, { headers: headers(), tags: { kind: 'read', ep: 'history' } });
    check(hist, { 'history 200': (r) => r.status === 200 });
    const fav = http.get(`${BASE}/functions/v1/norva-cloud/favorites`, { headers: headers(), tags: { kind: 'read', ep: 'favorites' } });
    check(fav, { 'favorites 200': (r) => r.status === 200 });
  } else {
    // Sans token : /health traverse quand même toute la chaîne (Caddy→Kong→
    // edge-runtime→lecture DB) — utile pour un premier smoke sans compte.
    const h = http.get(`${BASE}/functions/v1/norva-cloud/health`, { headers: headers(), tags: { kind: 'read', ep: 'health' } });
    check(h, { 'health 200': (r) => r.status === 200 });
  }
  sleep(5 + Math.random() * 10); // temps de lecture humain entre deux actions
}

export function heartbeat() {
  // Sans sourceId → source_id NULL côté serveur (autorisé) : aucune source réelle
  // touchée, l'item k6-<VU> reste cantonné au compte de test. La garde temporelle
  // watchedAt (audit 17/07) est exercée au passage.
  const payload = JSON.stringify({
    id: `k6-${__VU}`,
    type: 'movie',
    progress: Math.floor(Math.random() * 5000),
    duration: 5400,
    watchedAt: new Date().toISOString(),
    data: { title: `k6 load test ${__VU}` },
  });
  const r = http.post(`${BASE}/functions/v1/norva-cloud/history`, payload, { headers: headers(), tags: { kind: 'write', ep: 'heartbeat' } });
  check(r, { 'heartbeat 2xx': (x) => x.status >= 200 && x.status < 300 });
}
