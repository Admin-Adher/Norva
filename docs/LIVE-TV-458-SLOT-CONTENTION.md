# Live TV — incident 458 « max connections » & contention du slot provider (2026-07-10)

> Trace complète : symptôme, diagnostic (avec la fausse piste corrigée), actions
> immédiates, correctifs durables (crons + UX + layout), vérifications, et
> analyse de la cause racine (vérifiée par workflow adversarial).
> Docs liés : `PROVIDER-ANTIBAN-NINJA.md` (le ban Ninja du 03-07 et le principe
> « 1 connexion provider par identité »), `CRON-OPTIMIZATION-AUDIT.md` (l'audit
> des 35 crons), `OFFLINE-DOWNLOAD-CODECS.md` (pistes audio/sous-titres offline).

## 1. Symptôme

Le 10-07 en journée, la page **Live TV** du propriétaire : liste de chaînes
**vide** (« No channels »), erreurs **HTTP 458 max connections / Provider
connection slot busy** en console. En parallèle, le compte Ninja est **prêté au
père** (films/séries uniquement) — il ne doit jamais être interrompu. ~90 600
chaînes live existaient pourtant en base : ce n'était **pas** un problème de
données, mais un échec de chargement + un slot provider occupé.

## 2. Diagnostic — y compris la fausse piste (à garder en mémoire)

1. **Fausse piste corrigée** : premier réflexe = pauser les crons #95
   (`norva-revalidate-provider-ids`) et #10 (`norva-audio-langs-untagged`).
   **Erreur** — lecture du code ensuite :
   - **#95** appelle `norva-source-sync/cron/revalidate` qui valide contre
     **TMDB** (`validateTmdbCandidate`), jamais le provider → n'ouvre **aucun**
     slot. Le `conc=12` est de la concurrence TMDB, pas provider.
   - **#10** cible un **autre compte** (`c5be5ac4…`, source `super8k.top`,
     identité `x:f2e3ed06…`) — vérifié en base : cette identité n'existe **que**
     sur ce compte-là. En plus, le runner audio-backfill a un garde-fou
     `userHasLiveSession` (defer si session live) + circuit breaker.
   → Les deux ont été **réactivés**. Leçon : toujours lire le code du cron
   avant de désigner un coupable.
2. **Vrais coupables** : les 6 sondes audio par-provider du compte propriétaire
   (`7bdab1df…`), qui ouvrent un flux provider pour sonder la langue audio des
   VOD — sur des comptes provider à **1 connexion max** :

   | Cron | Provider | Ancien schedule |
   |---|---|---|
   | 62 | promax (`line.4k-beast.top`) | `1-59/3 6-23` (journée) |
   | 63 | opplex (`fun-fun2026.lol`) | `2-59/6 6-23` (journée) |
   | 64 | king365 (`r656.dad`) | `4-59/12 6-23` (journée) |
   | 65 | airysat (`mandara.cc`) | `5-59/30 6-23` (journée) |
   | 79 | **ninja** (`operator1.barfik.org`) | `4-59/12 * * * *` (**24 h/24 !**) |
   | 80 | **ninja-séries** | `9-59/12 * * * *` (**24 h/24 !**) |

   79/80 tournaient toutes les heures — le pire cas pour le compte prêté.

## 3. Actions sur les crons (état final)

1. **Relief immédiat** : pause des 6 sondes (`cron.alter_job(job_id := N,
   active := false)` — l'`UPDATE cron.job` direct est refusé au rôle
   `postgres` ; `alter_job` est SECURITY DEFINER).
2. **Durable** : reprogrammation des 6 sur la **fenêtre nuit `2-5` UTC**
   (04 h–08 h heure FR l'été) — même réactivées plus tard, elles ne
   croiseront plus le visionnage de journée/soirée.
3. **Décision du propriétaire (10-07)** : *« on peut laisser actif les crons
   sauf ceux de NINJA car mon père utilise uniquement NINJA »*. Avant de
   rebrancher, vérification que les 4 autres providers ne partagent **pas**
   l'identité Ninja (un rebrand = même slot) : les 5 `providerKey` sont
   **tous distincts** → réactivation sans risque pour le père.

   | Cron | Provider | Schedule | Actif |
   |---|---|---|---|
   | 62 | promax | `1-59/3 2-5 * * *` | ✅ oui |
   | 63 | opplex | `2-59/6 2-5 * * *` | ✅ oui |
   | 64 | king365 | `4-59/12 2-5 * * *` | ✅ oui |
   | 65 | airysat | `5-59/30 2-5 * * *` | ✅ oui |
   | **79** | **ninja** | `4-59/12 2-5 * * *` | 🔴 **non (prêt au père)** |
   | **80** | **ninja-séries** | `9-59/12 2-5 * * *` | 🔴 **non (prêt au père)** |
   | 10 | super8k (autre compte) | `*/3 6-23` | ✅ oui (identité isolée) |
   | 95 | revalidate TMDB | `2-59/4` | ✅ oui (zéro slot provider) |

   **Fin du prêt → réactiver ninja** :
   ```sql
   select cron.alter_job(job_id := 79, active := true);
   select cron.alter_job(job_id := 80, active := true);
   -- optionnel : les remettre en journée si le tagging nuit est trop lent
   -- select cron.alter_job(job_id := 79, schedule := '4-59/12 * * * *');
   ```

## 4. Correctifs front (commit `fc7467a`, déployés + vérifiés en live)

Le vécu utilisateur du 458 était catastrophique parce que le guide Live ne
distinguait pas « échec de chargement » de « catalogue vide » :

1. **État vide → récupérable** (`ChannelList.js`, `LiveGuideFusion.js`) :
   - `ChannelList` trace `loadError` / `hasLoadedOnce` ; le catch de
     `loadAllChannels()` (qui ne faisait que `console.error`) alimente
     désormais l'UI ; nouvelle méthode `reloadLive()`.
   - `LiveGuideFusion.render()` : panneau d'état dédié quand 0 chaîne chargée —
     spinner (« Loading your channels… ») pendant le premier chargement,
     **« Couldn't load your channels — Try again »** sur échec (bouton qui se
     désactive au tap), « No channels yet — Refresh » si vraiment vide.
     Basé sur la liste **brute** (pas la vue filtrée) pour qu'un groupe 100 %
     masqué garde le message « No channels in this group » normal.
2. **Layout téléphone** (`main.css`) : en paysage, un téléphone (>768 px)
   tombait dans le split 2 colonnes « tablette » (rail 190 px). L'app APK
   (`norva-phone-apk`) est désormais **épinglée en 1 colonne à toute largeur**
   (bandeau de groupes horizontal → aperçu → liste).
3. Vérifié **headless** (6 scénarios : loading/error/empty × web/phone,
   clic Retry = 1 seul appel + bouton désactivé) puis **en live** sur
   norva.tv après le déploiement Cloudflare. L'app téléphone charge norva.tv
   à distance → correctifs actifs **sans rebuild APK**.

## 5. Cause racine — analyse vérifiée (workflow adversarial, 14 agents)

<!-- SECTION COMPLÉTÉE APRÈS LE VERDICT DU WORKFLOW wf_21b929da-f47 -->

_(en cours de vérification au moment de la rédaction — voir §6)_

## 6. Suivi

- [ ] Intégrer le verdict du workflow `verify-provider-slot-root-cause` (§5).
- [ ] Décider : verrou « identité occupée » dans le chemin de sonde (fix
      blindé) — maintenant / plus tard / jamais, selon le verdict.
- [ ] Fin du prêt : réactiver crons 79/80 (SQL ci-dessus, §3).
