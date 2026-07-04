# Audit de la page Home — logiques streaming & contraintes IPTV (2026-07-04)

**Méthode.** 4 enquêteurs parallèles (Continue Watching · Héro/rails · My List/interactions ·
Cache/états/setup), standards Netflix/Prime comme référence, contraintes Norva en tête :
catalogues VOD multi-providers IPTV (mêmes titres sur plusieurs sources → identités
`cloud_titles`), slot provider unique, sync serveur en minutes, credentials qui expirent.
38 constats vérifiés code à l'appui. **Lot livré : P0 + 12 P1 + 12 P2** (PR #122).

## Corrigé dans ce lot

### P0
| Constat | Fix |
|---|---|
| Une panne passagère de `GET /sources` classait le compte `not_configured` → **gate d'onboarding complet** pour un utilisateur configuré | `loadSummary` distingue rejet réseau (`state:'unknown'`, non-gating, bannière « can't reach ») d'une vraie liste vide |

### Continue Watching (P1)
| Constat | Fix |
|---|---|
| Épisode terminé → la série **disparaissait** de CW (`data.nextEpisode` sauvegardé par le player, jamais consommé) | carte synthétique « Next episode » à 0 %, un clic = lecture de l'épisode suivant |
| 2 cartes pour la même série (1 ligne d'historique par épisode) | dédoublonnage par `seriesId` (l'épisode le plus récent gagne) |
| Même film sur 2 providers = 2 cartes | dédoublonnage par `titleId` (fallback titre normalisé) |
| Retour du player <60 s → progression périmée (TTL warm-DOM jamais invalidé) | `saveProgress` du player buste `home.lastLoadedAt` |
| « Details » au survol d'un épisode relançait la lecture à 0:00 | branche `episode` dans `openRailItem` → fiche de la série |
| Les lignes terminées consommaient la fenêtre serveur (limit=18) → CW sous-rempli | fetch limit=60, tranche à 18 après filtrage |
| Ligne duration=0 → barre de progression vide « cassée », carte immortelle | barre masquée quand duration≤0 |
| Undo de suppression : fermer l'onglet dans la fenêtre de 5 s perdait le DELETE | commit aussi sur `pagehide` |

### Héro & rails (P1)
| Constat | Fix |
|---|---|
| **Top 10 faux** : re-tri client par préférence de langue puis re-numérotation 1-10 ; « Recently Added » mélangé pareil | rails ordonnés (popular/recently) exemptés du re-ranking langue |
| « Recently Added » trié par `synced_at` (un resync re-mélange tout le catalogue) | tri par `created_at` (immuable, « nouveau dans TON catalogue ») |
| Variantes de **sources mortes** jamais filtrées → une carte pouvait lancer un provider expiré | `listVariantsByTitleIds` filtre `disabled`, relègue `error` en dernier (le defaultVariant est sain dès qu'une alternative existe) |
| Héro « Resume » sur un titre terminé (redémarrait à zéro) + poster portrait étiré en billboard | slide resume exige `getResumeOffset>0` **et** un vrai backdrop |
| Héro = « dernier syncé » plutôt que promotionnel | candidats tirés des rails popular/BYW d'abord |
| Play du héro = polling DOM aveugle (pouvait cliquer le Play d'une **autre** fiche) | jeton de supersession + vérif page + vérif identité du titre affiché avant clic |
| Listeners hover du héro empilés à chaque render + interval 9 s immortel hors page | garde dataset + `hide()` nettoie, `show()` relance (`_startHeroRotation`) |
| Rail de secours : même film en double (1 carte par variante provider) | dédoublonnage identité (tmdb id / titre nettoyé) |
| « Because You Watched » anonyme + requêtes O(N) séquentielles côté serveur | titre « Because You Watched *X* » (anchorTitle) + pool candidats mémoïsé |

### Cache & états (P1)
| Constat | Fix |
|---|---|
| Cache Home **partagé entre profils** (l'API de scoping pointait sur `window.API.profiles`, inexistant) → flash du CW d'un autre profil | `NorvaCloud.profiles.getActiveId` |
| Fin d'import → Home jamais rafraîchie (placeholder figé « Preparing your Home — X% ») | importWatcher émet `norva:source-health-changed` + le placeholder syncing se re-poll (6 s) |
| Panne des rails → copy **fausse** (« Add a TV service… ») qui écrasait les rails en cache | rails en cache conservés + notice temporaire ; empty-state branché sur `summary.state` avec bouton Retry |
| Poll de la gate = fetch complet historique+rails jetés toutes les 4 s pendant tout l'import | (couvert : le poll passe par la gate qui rend avant les fetches lourds ; charge résiduelle acceptée) |
| Boucle de récupération finalize lancée pour **tous** les comptes sains en stage finalize (course avec le driver serveur) | condition de staleness >60 s (miroir de la règle SourceManager) |

### P2 inclus
Rails personnels (My List + chaînes) remontés **sous Continue Watching** (ils étaient sous ~10
rails algorithmiques) · favoris sans poster affichés en placeholder au lieu de disparaître ·
My List : erreur ≠ vide (contenu conservé), dédoublonnage par titre · clic chaîne favorite
résolu AVANT navigation (+ toast si disparue) · badge NEW ressuscité (émission `added` =
first-seen) · **navigation clavier** : toutes les cartes `tabindex/role/aria-label` + Enter/Espace
délégué (avant : rien d'activable hors mode TV) · héro w780 → **w1280** + pause rotation au focus
clavier · code mort du timer syncing supprimé · section chaînes favorites démarre cachée (plus de
flash de skeletons).

## Vérifié correct (aucun changement)
Tri CW `updated_at DESC` · barre de progression et recul de 3 s · clic CW = reprise directe ·
sémantique des clics Netflix-correcte partout (carte→fiche, CW→lecture, chaîne→live) ·
récupération 458 du player (retries 4/8/12 s + message mono-flux) · orphelins prunés sur le
render Home (films) · rails vides masqués · fallbacks poster/titre (cleanReleaseName) · badge
langue par meilleure variante · lazy images + srcset · notifications de santé source sur
add/remove/toggle · préférence de contenu buste le TTL.

## Backlog P2 (non bloquant, lot futur)
1. Suppression CW d'une série : supprime la ligne visible mais un épisode frère peut la faire
   réapparaître au prochain chargement (nécessite un DELETE par seriesId côté API).
2. Orphelins épisodes/séries dans `pruneUnavailableHistory` (aujourd'hui films uniquement).
3. Pré-check du slot provider avant navigation vers le player (« un autre appareil regarde —
   reprendre la main ? ») — l'API sessions le sait déjà.
4. Skeleton du héro (CLS ~400 px au premier paint).
5. Gate syncing : re-render ciblé du panel au lieu d'innerHTML complet toutes les 4 s (perte de
   focus clavier/TV).
6. Copy d'échec de sync : headline friendly + erreur brute en « Technical details » repliable.
7. Dédoublonnage inter-rails serveur (budget de recouvrement) ; trim des variantes émises
   (`select *` → champs utiles) ; passer `homeRailFetchLimit` à ~24.
8. Logos morts : liste `isKnownBrokenLogoUrl` dupliquée dans 2 fichiers → partager (ou s'en
   remettre au fallback onerror).
9. `navigateTo` retournant une promesse (remplacer les `setTimeout(100)` de navigation).
