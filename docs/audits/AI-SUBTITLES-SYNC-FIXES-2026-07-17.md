# Sous-titres IA + synchronisation multi-appareils — audits & correctifs (2026-07-17)

**Commit** : `f5201d7` — *feat(audits 17/07): application intégrale des plans ST-IA (7) + synchro multi-appareils (10)*
**Statut** : web/mobile déployés (Cloudflare, push→main) · edge redéployé (box) · 2 migrations appliquées · crons armés · **TV = AAB v19 à rebuilder**.

Ce document est la trace de référence de deux audits menés en workflow (fan-out lecteurs → synthèse → vérificateurs adverses) et de l'application **intégrale** de leurs recommandations. Il double le log de session `docs/roadmap/2026-07-16-session-log.md` §17 en apportant les ancres `fichier:fonction`, la logique de chaque garde, la vérification et une FAQ.

---

## 0. Contexte des deux audits

| Audit | Question du fondateur | Ampleur workflow | Livrable |
|---|---|---|---|
| **A — tunnel « Generate AI subtitles »** | « est-ce rapide pour apparaître ? emails fonctionnels ? multi-user du même provider instantané ? chiffres concrets par étape » | 8 agents (5 lecteurs + synthèse + 2 vérificateurs), ~636k tokens | funnel chronométré 9 étapes, 6 scénarios, verdict notif à 7 trous, verdict cross-user, 7 optimisations classées |
| **B — synchro multi-appareils** | « web/mobile/tv ont-ils une synchro des lectures VOD / continue watching optimale ? la TV se synchronisait mal (documenté) » | 9 agents (6 lecteurs + synthèse + 2 vérificateurs), ~912k tokens | matrice flux×plateforme, 4 P1 + 13 P2/P3, latences chiffrées, plan de fix |

Les deux audits ont produit des **verdicts vérifiés adversarialement** (chaque chiffre tracé à une constante `fichier:ligne`, chaque claim central attaqué). Le fondateur a demandé : « fait tout ça sans exception ». Les 7 + 10 correctifs ci-dessous sont l'implémentation complète.

---

## LOT A — tunnel sous-titres IA (7 correctifs)

### A1 — Feedback optimiste au clic *(client)*

- **Problème** : au clic sur « ✨ Generate AI subtitles », l'UI restait sur le chooser idle pendant la résolution de source + le(s) GET de cache (~0,3-1 s, pire sur edge froid). Seul trou muet du tunnel.
- **Fix** : `public/js/pages/WatchPage.js` → `_requestAiSubtitlesInner()`. On pose `aiSubtitleState='processing'` + `_aiStage='checking'` **avant** tout appel réseau, puis on `updateCaptionsTracks()`. Chaque chemin en aval remplace l'état honnêtement : cache hit→ready, erreur terminale→failed, rien→enqueue garde 'processing'.
- **Piège évité** : l'état optimiste aurait avalé l'enqueue. La décision « poursuivre le job existant vs enqueuer » se prend désormais sur le **status de la réponse cache** (`gotStatus`), pas sur `this.aiSubtitleState` (qui vaut toujours 'processing' à ce point).
- **Label** : `_aiProcessingLabelHtml()` → nouvel état `checking` = « ✨ Checking for existing subtitles… ».

### A2 — Deep link dans l'email *(edge + migration + client)*

- **Problème** : le bouton « Open Norva » de l'email pointait sur la racine du site. L'utilisateur devait retrouver son film à la main.
- **Fix edge** : `supabase/functions/norva-playback/index.ts`
  - `subtitleWatchRoute(sub)` : construit `movies/open:<sourceId>:<externalId>:<titre>` (film) ou `series/open:<sourceId>:<seriesId>:<titre>` (épisode). Les épisodes sont cachés par **id d'épisode** mais la fiche s'ouvre par **id de série** → d'où la colonne `series_id`.
  - `subtitleReadyEmailHtml(titleLabel, siteUrl, ctaUrl?)` : le bouton devient « Watch with AI subtitles » → `siteUrl/app.html#<route>`. Sans route valide, retombe sur « Open Norva » → racine.
- **Fix migration** : `20260717150000` ajoute `source_id text` + `series_id text` sur `catalog_generated_subtitle_notifications`.
- **Fix client** : `WatchPage.toggleAiNotify()` envoie `seriesId` pour les épisodes (`itemType==='series'`).
- **Fix routage boot** : `public/js/app.js`
  - `init()` stashe `this._openFicheRoute` quand le hash est `#movies/open:…` / `#series/open:…`.
  - `openFicheFromRoute(pageName)` : décode `open:<sourceId>:<id>:<titre>`, convertit le **UUID cloud → alias local** (`window.API.localSourceIdFor`), et ouvre via `openByItem` (le même resolver que la recherche globale → fiche pleine, pas creuse). Best-effort.
  - `public/js/api.js` expose `localSourceId` sur CloudAdapter + `API.localSourceIdFor(cloudId)` (l'inverse de `resolveCloudSourceId`).

### A3 — Opt-in vérifie le statut (ferme la race + rattrape les orphelins) *(edge)*

- **Problème** : le client poll toutes les 20-60 s. Un opt-in APRÈS le callback de fin créait un pending irrésoluble (le dispatch ne tire qu'une fois, au callback terminal) → chip 🔔 mensongère.
- **Fix** : `setGeneratedSubtitleNotify()` lit la row cache AVANT de s'abonner :
  - `ready + speech` → email envoyé **immédiatement** (+ cloche) + row `sent`. Retour `{ok:true, already:'ready', emailed}`.
  - `ready sans speech` / `failed` → **refus honnête** `{ok:false, reason}` → le client révoque la chip.
  - sinon → abonnement `pending` classique.
- **Anti-spam** : l'envoi immédiat n'est atteignable que dans la fenêtre de course (la chip ne s'affiche qu'en état 'processing' côté client) → non exploitable.

### A4 — Poll adaptatif (backoff) *(client)*

- **Problème** : poll fixe 20 s pendant jusqu'à 2 h → jusqu'à 360 GET par job et par client, même quand rien ne peut changer (attente deferred, file d'attente).
- **Fix** : `WatchPage.startAiSubtitlePolling()` réécrit en chaîne `setTimeout` (plus `setInterval`) avec `delayMs()` :
  - `deferred` → 60 s ; `stage vide + queuePos>0` → 60 s ; sinon (extraction/transcription, les partiels arrivent) → 20 s.
  - Sur 2 h d'attente deferred : ~120 GET au lieu de ~360, sans retarder un seul partiel.
- **Garde `_aiPollGen`** : jeton de génération incrémenté par `stopAiSubtitlePolling()`. Un état terminal appelle stop **depuis l'intérieur d'un tick** → sans le bump, le tick se reprogrammerait. Chaque tick vérifie `_aiPollGen === gen` avant et après le fetch.

### A5 — Cron de purge notifications *(migration)*

- **Problème** : la table `catalog_generated_subtitle_notifications` n'avait aucun TTL → accumulation indéfinie.
- **Fix** : `20260717150000` crée le cron `norva-gen-sub-notif-prune` (`25 3 * * *`) : `delete … where created_at < now() - interval '30 days'`. 30 j >> toute fenêtre utile (les fenêtres se comptent en heures).

### A6 — Les échecs résolvent les pending *(edge + migration)*

- **Problème** : tout `ready`/`failed` qui n'arrivait pas par le callback laissait les abonnements `pending` orphelins pour toujours. Cause racine : le reaper SQL flippait `failed` en base sans dispatch, et les échecs d'enqueue (gateway ≠ 202) idem.
- **Fix edge** : les 4 chemins terminaux appellent maintenant `dispatchSubtitleNotifications(…, status:'failed')` :
  - `transcribeEnqueue` (gateway ≠ 202), `ocrEnqueue` (idem), `translateEnqueue` (idem), et `resolvePendingTranslations.failPending` (chaînage traduction mort).
- **Fix migration** : le reaper `norva-generated-subtitle-reaper` est ré-émis via `cron.schedule` (upsert par jobname). Il fauche les jobs morts (`processing > 2h`, `pending-transcript > 24h`) ET, via CTE `reaped → resolved → insert`, résout les souscriptions `pending` en `failed` + insère l'événement cloche `subtitle_failed` dans `cloud_content_events`.

### A7 — Cloche in-app *(edge + client)*

- **Problème** : la cloche navbar ne recevait jamais d'événement sous-titres. Onglet fermé + pas d'opt-in email = l'utilisateur n'apprend jamais le résultat.
- **Fix edge** : `insertSubtitleBellEvents(db, subs, outcome)` insère une row `cloud_content_events` par souscripteur, kind `subtitle_ready|subtitle_empty|subtitle_failed`, avec `payload.watch = <route deep link>` sur ready. Appelée depuis `dispatchSubtitleNotifications` (ready, empty, failed).
- **Fix client** : `public/js/app.js` → `toggleNotifications()` rend les entrées avec `payload.watch` comme des liens `<a data-watch>` cliquables → navigation **in-app** (via `openFicheFromRoute`, pas de reload), pattern identique aux entrées support.

---

## LOT B — synchronisation multi-appareils (10 correctifs)

### B1 — Carte Continue Watching périmée (P1) *(client web + TV natif)*

- **Problème** : le lookup serveur de position ne tournait QUE si l'offset transmis valait 0. Une carte Home avec un `resumeTime>0` périmé (warm-DOM 60 s + cache hist 20 s, voire peinture SWR 7 j) court-circuitait la position serveur plus fraîche d'un autre appareil. → *« je regarde 40 min sur la TV, je clique la carte sur mon téléphone → reprise 40 min en arrière »*.
- **Fix web** : `WatchPage._fetchServerResumeInfo(content)` (nouveau) distingue « le serveur a RÉPONDU 0 » (fini/retiré ailleurs → redémarre honnêtement) de « on n'a pas pu demander » (offline / vieux backend → garde l'offset carte). `loadContent()` consulte TOUJOURS le serveur sauf cible de seek explicite (restore de session), et préfère sa réponse.
- **Fix TV natif** : `public/js/utils/standalone.js` → override `WatchPage.prototype.play` utilise `_fetchServerResumeInfo` (même logique : answered→prend, sinon garde l'offset carte).

### B2 — Filet SharedPreferences durable (P1) *(Android TV)*

- **Problème** : à la fermeture du player, `finish()` PURGEAIT le filet SharedPreferences **avant** que la position soit livrée à la WebView, et l'envoi cloud était fire-and-forget sans retry. Déclencheurs de perte : WebView redirigée vers cloud-pair.html (token révoqué), PiP fermée, échec réseau au moment exact de la sortie.
- **Fix** : `PlayerActivity.java`
  - `finish()` PERSISTE la position finale (`writePendingProgress`) au lieu de la purger. `gracefulResultEmitted` empêche onPause/onStop de réécrire une position plus vieille par-dessus.
  - `writePendingProgress(pos, dur)` stocke aussi `savedAt` (epoch de capture) + `token`.
  - `MainActivity.java` : le record n'est **consommé qu'à la confirmation** du save cloud. Pont `onProgressSaved(token)` sur les deux bridges (`NativeBridge` + `CloudBridge`) → `confirmProgressSaved(token)` (ne clear que si le token courant matche — un save plus récent survit à une vieille confirmation).
  - `pumpPendingProgress()` : retry 20×/1,5 s façon deep-link ; staleness 7 j (un record indélivrable — TV déconnectée, 401 permanent — s'auto-purge).
  - `standalone.js` → `onProgress(…, savedAtMs, token)` : envoie `watchedAt = capturedAt`, et sur succès du save appelle `bridge.onProgressSaved(token)`.
- **Bonus** : le retour de sélection de variante ne jette plus la position (`onActivityResult` early-return → `flushPendingNativeProgress()` avant `return`).

### B3 — webAppReady honnête (P1) *(Android TV)*

- **Problème** : `webAppReady` passait à `true` sur N'IMPORTE quel `onPageFinished` (cloud-pair.html, page d'erreur) et n'était jamais remis à `false` → le flush consommait-perdait des positions contre une page sans bridge.
- **Fix** : `MainActivity.java`
  - `onPageStarted` → `webAppReady = false` (navigation = bridge parti).
  - `onPageFinished` → `webAppReady = isAppShellUrl(url)` seulement.
  - `isAppShellUrl(url)` : vrai uniquement pour `…/app.html` (norva.tv) ou la racine/`index.html` d'un serveur embarqué/LAN. cloud-pair.html, landing et pages d'erreur exclues.

### B4 — Heartbeat cloud pendant la lecture native TV (P1) *(Android TV)*

- **Problème** : la position ne partait au cloud qu'à la fermeture du player natif → le mobile/web voyait la position d'AVANT le lancement TV pendant des heures. « Limite actée » de l'audit du 14/07.
- **Fix** : `PlayerActivity.maybePersistProgress()` relaie la position toutes les ~45 s (`lastCloudRelayMs`, VOD only — pas de channel) vers `MainActivity.current.relayNativeHeartbeat(…)`, qui évalue `__norvaNative.onProgress` dans la WebView. Réutilise **intégralement** le chemin d'écriture cloud existant (standalone.js → /device/history), zéro nouveau endpoint. `MainActivity.current` = instance statique (single-instance, cleared en `onDestroy`).
- **Doc** : `docs/audits/TV-VOD-TIMEFRAME-SYNC-AUDIT-2026-07-14.md` « Limites restantes » barré + daté.

### B5 — Garde temporelle serveur (P2) *(edge + clients)*

- **Problème** : LWW par ordre d'arrivée Postgres, sans garde. Deux appareils heartbeatant le même titre → un paquet retardé pouvait FAIRE RÉGRESSER une position plus récente.
- **Fix edge** : `norva-cloud/index.ts` → `saveHistory()`. Le client envoie `watchedAt` (capture du tick). Si `incomingWatchedAt < existingWatchedAt` et pas `force` → `stale=true` → progress/completed/watched_at préservés de l'existant. Force saves (pause/seek/exit) passent toujours. Clients legacy sans `watchedAt` → comportement inchangé (LWW).
- **Fix clients** : `WatchPage.saveProgress()` envoie `watchedAt: new Date().toISOString()` (+ `force:true` sur force saves) ; `standalone.js` envoie la capture native (`savedAtMs`).

### B6 — DELETE historique par clés (P2) *(edge + client)*

- **Problème** : le retrait d'une entrée d'historique faisait un list-then-find (limite 500) sur le cache hist 20 s → une entrée écrite par un autre appareil était ratée → suppression silencieusement sans effet, la carte revenait au reload. (Même bug déjà corrigé pour les favoris en 7cd1219.)
- **Fix edge** : `norva-cloud/index.ts` → `deleteHistoryByKeys(req, url, userId, db)` : DELETE par `(profile, itemType, itemId)` + `source_id.eq.X OR source_id.is.null` (purge aussi les orphelins null-source du même titre). Validation UUID sur sourceId (protège le filtre `.or()`). Routes câblées dans les deux scopes (user + device).
- **Fix client** : `cloudApi.js` → `history.removeByKeys` (user + device) ; `api.js` → `handleHistory` DELETE keyed quand `itemId` fourni + `API.history.remove(itemId, keys)` ; `SeriesPage.setEpisodeWatched` (unwatch) passe les clés + mark-watched envoie `completed:true`.

### B7 — Récentes live : re-pull + merge (P2) *(client)*

- **Problème** : `syncRecentChannelsFromCloud` tournait UNE fois par session (`_recentsSyncedOnce`) et le pull ÉCRASAIT le miroir localStorage entier → une TV allumée en continu ne voyait jamais les zaps du mobile ; des récentes locales plus fraîches écrasées au boot.
- **Fix** : `components/ChannelList.js`
  - `maybeSyncRecentsFromCloud(force)` : TTL 5 min + listener `focus` + `setInterval` 10 min (une TV ne refocus jamais).
  - `syncRecentChannelsFromCloud()` MERGE par fraîcheur (`at` = timestamp sur chaque entrée, local et cloud) au lieu d'écraser.
  - `rememberRecentChannel` stampe `at: Date.now()`.

### B8 — Parité data TV : nextEpisode + préférences (P2) *(client)*

- **Problème** : le chemin natif TV n'écrivait jamais `playbackPreferences` ni `nextEpisode` → un binge sur TV n'alimentait pas la carte « up next » des autres appareils, et les pistes audio/sous-titres choisies ne suivaient pas.
- **Fix** : `standalone.js` → `WatchPage.prototype.play` calcule `nextEpisode` depuis le payload de lancement (`content.seriesInfo`, la même logique que `WatchPage.getNextEpisode` mais sur l'état de lancement, l'override natif ne set pas l'état d'instance) et l'inclut dans le blob `data` du seed + du save. `playbackPreferences` idem quand présent.
- **Anti-régression** : `durationHint` n'est plus jamais envoyé à 0 (ExoPlayer reporte parfois 0, la meta meurt au reload WebView) → il ne clobber plus un bon hint persisté (le serveur merge shallow).

### B9 — Signal profil verrouillé (P2/P3) *(edge + client)*

- **Problème** : après un downgrade, `resolveProfileId` rabattait SILENCIEUSEMENT un profil verrouillé sur le défaut → les deux profils semblaient « désynchronisés » sans aucun signal.
- **Fix edge** : `norva-cloud/index.ts` — `WeakSet<Request> lockedProfileFallbacks` marqué dans `resolveProfileId` quand un header profil verrouillé est rabattu ; le wrapper `Deno.serve` pose `x-norva-profile-fallback: locked` sur la réponse (exposé CORS via `Access-Control-Expose-Headers`).
- **Fix client** : `cloudApi.js` → `requestToBase` lit ce header et affiche un toast une-fois (« This profile is locked by your current plan — showing the main profile instead »).

### B10 — completed préservé + hub local + doublons NULL (P3) *(edge + hub + migration)*

- **completed préservé** *(edge)* : `saveHistory` — `completed` n'est plus reset à `false` par heartbeat. Préservé de l'existant sauf si le body le mentionne ; un VRAI re-watch (`incomingProgress ≥ 60 s`) l'efface honnêtement, un clic accidentel (<60 s) non. Le mark-watched manuel de SeriesPage envoie `completed:true` explicite.
- **hub local** *(server/routes/history.js)* : le POST MERGE désormais `data` (préserve le blob riche quand le delta-heartbeat l'omet) et préserve `duration` — avant, `data = excluded.data` écrasait le blob par `{}` dès le 2e tick en mode self-hosted.
- **doublons source_id NULL** *(migration 20260717160000)* : le renouvellement d'une source orphelinait ses lignes en `source_id=NULL`, et l'index unique traitait les NULL comme distincts → l'upsert ne matchait jamais ces lignes. Fix : dédoublonnage (la plus récente survit) + index unique `NULLS NOT DISTINCT` (PG15+) → l'ON CONFLICT de saveHistory matche enfin les orphelins.

---

## Migrations

| Fichier | Objet | Rôle box | Vérification |
|---|---|---|---|
| `20260717150000_subtitle_notify_v2.sql` | colonnes source_id/series_id + reaper ré-émis (résout pending + cloche) + purge 30 j | **supabase_admin** (touche cron.*) | PG16 jetable : reaped→resolved→insert (job vivant intact, morts résolus + cloche) |
| `20260717160000_watch_history_null_source_dedupe.sql` | dédoublonnage NULL + index NULLS NOT DISTINCT | postgres | PG16 jetable : upsert matche l'orphelin (999 sans nouvelle row) |

Résultat prod (2026-07-17) : première migration OK (`ALTER TABLE`/`COMMENT`×2/`DO`). Seconde : `DELETE 0` (aucun doublon NULL en prod — l'index est posé en prévention). Crons confirmés : reaper `0 * * * *` + purge `25 3 * * *`, tous deux `active=t`.

---

## Fichiers modifiés (commit f5201d7)

```
clients/android-tv/app/build.gradle                    versionCode 18→19, 3.8.5→3.8.6-hybrid
clients/android-tv/.../MainActivity.java               webAppReady honnête, pump confirmé, relais heartbeat, onProgressSaved
clients/android-tv/.../PlayerActivity.java             finish() persiste, writePendingProgress+token, relais 45s
public/js/pages/WatchPage.js       (v122)              A1/A4 optimiste+poll, B1 _fetchServerResumeInfo, B5 watchedAt, seriesId
public/js/app.js                   (v45)               A2/A7 openFicheFromRoute + cloche cliquable
public/js/api.js                   (v71)               localSourceIdFor, DELETE keyed history
public/js/cloudApi.js              (v48)               removeByKeys, toast profil verrouillé
public/js/components/ChannelList.js (v45)              B7 re-pull + merge récentes
public/js/pages/SeriesPage.js      (v48)               B6 unwatch keyed + completed:true
public/js/utils/standalone.js      (v8)                B1/B2/B5/B8 TV natif
server/routes/history.js                               B10 merge hub local
supabase/functions/norva-playback/index.ts             A2/A3/A6/A7 deep link, ready-check, dispatch échecs, cloche
supabase/functions/norva-cloud/index.ts                B5/B6/B9/B10 garde, DELETE keyed, signal profil, completed
supabase/migrations/20260717150000_subtitle_notify_v2.sql
supabase/migrations/20260717160000_watch_history_null_source_dedupe.sql
```

## Vérification

- `deno check` norva-playback + norva-cloud : **0 nouvelle erreur** (3+3 pré-existantes identiques sur l'arbre propre, confirmé par `git stash`).
- `node --check` sur les 8 JS touchés : OK.
- `javac -proc:none` MainActivity + PlayerActivity : 0 erreur de syntaxe (bruit SDK Android seul, attendu hors gradle).
- 2 migrations rejouées sur Postgres 16 jetable avec fixtures.
- Smoke headless Chromium sur le vrai `WatchPage.prototype` : optimiste→enqueue non avalé, label « Checking… », cadences 60/20/60 s, stop-in-tick sans re-schedule.

---

## FAQ (questions du fondateur, réponses vérifiées dans le code)

**Q : Deux users du même provider cliquent EN MÊME TEMPS sur le même titre ?**
Une seule transcription, garantie par écriture atomique (pas par la chance). Le GET du cache partagé fait qu'en général le 2e voit `processing` et suit le job. En simultanéité parfaite, les deux atteignent la RPC `claim_generated_subtitle_job` (`ON CONFLICT … WHERE` en une instruction) → **exactement un gagnant**. Le perdant reçoit `won=false` → réutilise le job. Conséquences : 1 seule connexion provider, 1 slot whisper, le gagnant consomme 1 événement de budget, **le perdant 0** (l'événement n'est enregistré qu'après le 202 gateway). Les deux voient les partiels (chacun a cliqué), les deux ont le résultat, chacun son email s'il a opté. Vaut aussi entre comptes différents du même panel (c'est le partage cross-user).

**Q : Le bouton devient « Checking… », mais si je change de page et reviens, reste-t-il bloqué / peut-on recliquer (=bug) ?**
Non bloqué. À la réouverture, l'état IA est remis à `idle` (`WatchPage` ligne ~3433, `aiSubtitleState = aiSameTitle ? 'ready' : 'idle'`), puis le probe automatique (`_ensureAiCacheProbe`) interroge le cache : `processing` → l'état honnête revient (« Queued… »/« Extracting… ») et le poll reprend. On ne revoit « Generate » qu'une fraction de seconde. **Si on reclique avant** que le probe réponde : le GET voit `processing` → rattachement au job, **aucun enqueue**. Et même un enqueue dans la micro-fenêtre serait refusé par la claim RPC (job vivant, TTL 90 min). Zéro seconde génération, zéro budget, zéro seconde lecture provider. Le seul « défaut » est cosmétique (revoir brièvement « Generate »), pas fonctionnel.

---

## Reste ouvert

- **AAB TV v19** (3.8.6-hybrid) à builder — porte B2/B3/B4 (code natif).
- Rotation du token Telegram exposé (@BotFather + `ops/hetzner/.env` + `/etc/norva-netdata/health_alarm_notify.conf`).
- Angles morts cross-user connus (non bloquants, documentés dans l'audit A) : dérive temporelle de l'échantillon d'identité figé (régénération si catalogue >2×) ; épisodes non mesurés en prod pour le partage.
