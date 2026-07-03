# Provider anti-ban — incident Ninja & mode faible empreinte (2026-07-03)

## Incident

La ligne « ⏸ à l'arrêt » des **séries Ninja** au dashboard (ETA « ~12 664 j ») a révélé, après
diagnostic, que le compte provider Ninja (`operator1.barfik.org`) renvoyait **401 Unauthorized**.
Le revendeur a confirmé :

> « Le compte avait reçu un **bannissement automatique pour comportement suspect**. Il envoyait
> beaucoup de requêtes au serveur, il y a peut-être eu un **partage de compte** ou une **forte
> consommation des ressources**. Je vous en ai donné un de remplacement. »

**Le ban a très probablement été déclenché par le crawl d'enrichissement de Norva lui-même.**

## Diagnostic — pourquoi les films *paraissaient* sains mais tout était cassé

- `operator1.barfik.org` up & rapide (401 en ~0,5 s) → pas un timeout ni l'IP.
- Films Ninja (24 h) : **7 410 sondés, 0 résolus** → 100 % d'échec, mais **stampés** quand même
  (le chemin film `relayEmpty → markProbed`, `norva-playback/index.ts:3858`) → le dashboard
  affichait un débit « sain » mensonger (7 410/j « sondé », 0,4 % résolu au total).
- Séries : chemin `noTarget` (`index.ts:3807`) **ne stampe pas** → pool jamais drainé → ETA absurde
  mais **honnête**. Ce sont les séries qui ont dit la vérité.
- Les identifiants **stockés en base étaient périmés** (username `s3jfe2tutsvl`, rejeté 401). Un
  login de remplacement (`jf3l5j3245`) testé : `auth:1`, **Active**, `get_series` = 42 135,
  `get_series_info` = épisodes OK. Le provider est vivant ; c'est bien l'ancien login qui était banni.

## Les 3 vecteurs de ban (mappés aux mots du revendeur)

| Revendeur | Cause Norva | Preuve |
|---|---|---|
| « partage de compte » | Compte `max_connections:1` vu depuis **3 classes d'IP** : probes films → **Cloudflare** (`norva-relay.workers.dev`), metadata/series-info → **proxy résidentiel** gateway (Railway), lecture user → IP maison. | `norva-relay:103`, `media-gateway:12-40` |
| « beaucoup de requêtes » | **~7 410 probes films/jour** + séries + syncs catalogue (un humain en fait une poignée). | DB `probed_24h` |
| « forte consommation » | Milliers d'ouvertures de connexion/jour ; le **mutex de fond exclut la lecture** (`media-gateway:1034`) et les probes passent par un **service séparé** (Cloudflare, verrou distinct) → probe possible **pendant** une lecture = 2 connexions simultanées. | `media-gateway:1027-1034` |

Note : le probe film ne tire qu'un **byte-range** (léger en bande passante) — le problème est le
**nombre de requêtes + le multi-IP + la concurrence**, pas la conso brute.

## Mesure immédiate prise (2026-07-03) — lazy-only

Les **4 crons de fond Ninja** ont été **désactivés live** (`cron.unschedule`) :
`norva-audio-airo-ninja` (61), `norva-audio-airo-ninja-series` (66), `norva-subtitle-airo-ninja`
(67), `norva-whisper-airo-ninja` (73). → **0 crawl de fond** ; lecture / sync / catalogue intacts.
Le nouveau compte peut être branché sans reproduire le comportement qui a banni l'ancien.
(Noté aussi dans `supabase/functions/ENRICHMENT_CRON_SETUP.md`.)

## Mode « faible empreinte » — plan (à livrer avant de ré-activer le crawl Ninja)

Cible : rendre le crawl **indiscernable d'un foyer normal** sur un provider anti-abus.

1. **Une seule IP résidentielle pour TOUT le provider** — router les probes films par le **proxy
   résidentiel de la gateway** (comme la metadata), plus par le worker Cloudflare. Le compte
   n'apparaît que depuis **une IP maison stable, sticky-par-compte** → tue le signal multi-IP.
   *(Levier le plus décisif.)*
2. **Cap de débit strict + jitter** par provider marqué « anti-abus » — quelques dizaines de
   probes/heure max, étalées, quiet-hours. Le cache persiste → ça se complète lentement et
   invisiblement (au lieu de 7 410/j).
3. **Concurrence 1 réelle, lecture incluse** — un seul accès provider à la fois, **jamais** un probe
   pendant une lecture, unifié relay + gateway, + cooldown entre requêtes.
4. **Metadata-first / lazy** — préférer `get_vod_info` / `get_series_info` (JSON, ressemble à de la
   navigation) et n'ouvrir un flux que sur **lecture réelle** ou en dernier recours.
5. **Profil « empreinte » par provider** — flag `low_footprint` sur la source ; crawl agressif
   conservé seulement pour les providers qui le tolèrent (super8k, apdxes…).

## Checklist de ré-activation Ninja

- [ ] Identifiants remplacés dans l'app (ré-encrypte `config_ciphertext` + re-sync).
- [ ] Mode faible empreinte livré (points 1-3 au minimum) + testé.
- [ ] Re-scheduler les crons Ninja **en version domptée** (cadence réduite) depuis `ENRICHMENT_CRON_SETUP.md`.
- [ ] Surveiller `active_cons` / 401 côté provider + `résolu_24h > 0` au dashboard pendant 48 h.

## Bug dashboard connexe (révélé par cet incident)

`sondé_24h` élevé + **`résolu_24h = 0`** = signal « provider mort », aujourd'hui **invisible** (les
films affichent un débit sain grâce au stamp-sur-échec). À remonter comme alarme, en plus du
garde-fou d'ETA (cf. réflexion dashboard).
