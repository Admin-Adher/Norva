# Test de charge — « la box tient-elle 1000 users simultanés ? »

Valide sous burst réel le seul composant que l'audit du 2026-07-17 n'a pas pu
chiffrer au repos : **edge-runtime** (les isolates Deno de norva-cloud), derrière
la chaîne complète Caddy → Kong → PostgREST → Postgres. Tout le reste est déjà
dimensionné (box à ~2 % de charge, pool PostgREST 40, cache hit 99,94 %).

## 1. Règles d'or

- **Jamais depuis la box** (ça mesurerait le loopback et volerait le CPU mesuré).
  Depuis ton PC (fibre) ou un VPS jetable. `dig api.norva.tv` doit répondre l'IP
  de la box (pas de proxy Cloudflare devant — Caddy fait le TLS lui-même).
- **Heure creuse** (nuit UTC), et préviens-toi toi-même : netdata va légitimement
  râler sur Telegram pendant le palier.
- Toujours **SMOKE d'abord** (50 VUs, 3 min), full ensuite. `Ctrl+C` arrête net.
- Le scénario d'écriture (`WRITE=1`) exige le **compte de test** — jamais ton
  compte perso (il écrit des entrées d'historique `k6-*`).

## 2. Préparation (5 min)

```bash
# installer k6 (Linux/macOS — https://k6.io/docs/get-started/installation/)
sudo gpg -k && sudo apt-get install -y k6   # ou : brew install k6

# APIKEY = la clé publishable (anon) — celle du front (Studio → Settings → API)
export APIKEY='eyJ...'

# TOKEN = access_token d'un COMPTE DE TEST connecté sur https://norva.tv/app.html :
# DevTools → Application → Local Storage → norva-cloud-session → access_token
# (expire ~1 h : à re-copier juste avant le run)
export TOKEN='eyJ...'
```

## 3. Les trois runs, dans l'ordre

```bash
cd ops/loadtest

# 1) SMOKE — 50 VUs lecture, 3 min : vérifie que tout est câblé
k6 run -e SMOKE=1 -e APIKEY="$APIKEY" -e TOKEN="$TOKEN" k6-capacity.js

# 2) FULL lecture — 1000 VUs qui browsent (boot + history + favorites), ~16 min
k6 run -e APIKEY="$APIKEY" -e TOKEN="$TOKEN" k6-capacity.js

# 3) FULL + écritures — ajoute 100 heartbeats/s (le vrai profil « 1000 viewers »)
k6 run -e APIKEY="$APIKEY" -e TOKEN="$TOKEN" -e WRITE=1 k6-capacity.js
```

Variables : `USERS=500` pour viser moins, `BASE_URL=` pour un autre environnement,
`STRESS=1` pour l'ancien mode torture (cold start /boot complet à CHAQUE itération —
un plafond de stress ~5-10× plus brutal que 1000 vrais users, pas un modèle réaliste).
Depuis le 17/07 le mode par défaut est RÉALISTE : boot 1× par session (par VU) puis
navigation légère — combiné à WRITE=1, c'est LE profil « 1000 users réels ».

## 4. Pendant le run — sur la box, dans un autre terminal

```bash
watch -n 5 'docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" | head -6; uptime'
```

Les trois jauges qui comptent : CPU de `norva-edge-functions` (le sujet du test),
CPU de `norva-db`, et la charge machine (16 threads → inquiétant au-delà de ~12).

## 5. Lire le verdict

k6 imprime ses seuils à la fin :

- ✅ `http_req_failed rate<0.01` et `p(95)<500ms` verts au palier 1000 VUs
  → **la box tient 1000 users simultanés, dossier clos.**
- ❌ p95 lecture qui s'envole mais DB CPU bas → edge-runtime sature : le levier
  est un conteneur `functionsN` de plus + une target dans l'upstream
  `edge-functions-pool` de `volumes/api/kong.yml` (~+95 req/s par conteneur —
  voir le commentaire du service `functions2` dans le compose).
- ❌ 401 massifs alors que le token est frais, avec des 500 sur
  `GET /auth/v1/user` dans les logs Kong → GoTrue sature. Résolu le 17/07
  (vérif JWT locale `_shared/local-auth.ts` + `GOTRUE_DB_MAX_POOL_SIZE`) ;
  si ça revient, vérifier que `JWT_SECRET` est bien dans l'env des fonctions
  (sinon elles retombent en silence sur l'aller-retour GoTrue).
- ❌ erreurs 5xx avec `norva-db` CPU haut → revenir me voir avec la sortie k6 +
  le `docker stats` : on regardera les requêtes lentes (`pg_stat_statements`).

Piège vécu : un `docker stats` pris APRÈS la fin du run ne montre rien (tout
retombe en secondes) — photographier le palier vers la minute 8-10, et re-copier
un token frais juste avant chaque run (expiration 1 h ; les 5 dernières minutes
du run du 17/07 étaient 100 % 403 à cause d'un token réutilisé).

## 6. Nettoyage après un run WRITE=1

```bash
docker exec -i norva-db psql -U postgres -d postgres -c \
  "delete from public.cloud_watch_history where item_id like 'k6-%';"
```

(Les lignes sont cantonnées au compte de test, source_id NULL — rien d'autre à
purger. Les seuils du script sont volontairement plus stricts que l'expérience
réelle perçue : un p95 à 600 ms « échouerait » le test mais resterait invisible
pour un humain — c'est une marge, pas une falaise.)
