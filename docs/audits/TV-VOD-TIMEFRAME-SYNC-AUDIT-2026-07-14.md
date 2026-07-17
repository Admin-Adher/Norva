# Audit TV — synchronisation timeframe VOD (2026-07-14)

## Symptôme

Sur Android TV / shell TV natif, la lecture VOD est déléguée à ExoPlayer. La position finale revient ensuite au WebView via `window.__norvaNative.onProgress()`. Le problème observé est que la barre / timeframe de reprise peut être incorrecte ou perdre la durée, surtout sur certains flux VOD où ExoPlayer ne remonte pas une durée fiable.

## Chemin vérifié

1. `standalone.js` remplace `WatchPage.play()` dans les shells natifs et lance le player Android avec `playVideoJson()` / `playVideoResumable*()`.
2. `clients/android-tv/.../PlayerActivity.finish()` renvoie `positionSeconds` et `durationSeconds` à `MainActivity`.
3. `MainActivity.onActivityResult()` appelle `window.__norvaNative.onProgress(sourceId, itemType, itemId, pos, dur)`.
4. `standalone.js` persiste ensuite la progression dans l'historique (`API.history.save`).

## Cause racine

Le seed initial de l'historique avait souvent une `durationHint` issue du catalogue, mais le callback natif `onProgress()` faisait confiance à `durationSeconds` renvoyé par ExoPlayer. Quand ExoPlayer renvoyait `0` / durée inconnue, la sauvegarde finale pouvait remplacer la durée utile par `0`, ce qui casse le pourcentage visuel de reprise / timeframe côté TV et autres supports.

Autre effet : le callback natif envoyait très peu de métadonnées (`sourceId` seulement). Sur certains stores locaux / chemins non mergeants, cela pouvait appauvrir la ligne d'historique.

## Correctif appliqué

- `standalone.js` garde maintenant en mémoire, au lancement d'un VOD natif, la durée catalogue (`durationHint`) et les métadonnées utiles du titre.
- `__norvaNative.onProgress()` utilise désormais `durationSeconds` si ExoPlayer le fournit, sinon retombe sur la `durationHint` capturée avant le lancement natif.
- La sauvegarde finale renvoie aussi un petit bloc `data` cohérent (`title`, `poster`, saison/épisode, `containerExtension`, `durationHint`) pour éviter d'écraser la ligne avec une donnée vide.
- Cache-buster `standalone.js` incrémenté dans `app.html`.

## Limites restantes

- ~~La progression TV reste essentiellement persistée à la fermeture du player natif. Pour un sync quasi temps réel façon Netflix entre appareils pendant que le player TV est encore ouvert, il faudrait un heartbeat natif périodique vers le WebView ou vers l'API cloud.~~ **Levée le 2026-07-17** (versionCode 19) : `PlayerActivity.maybePersistProgress` relaie la position toutes les ~45 s vers la WebView de `MainActivity` (`relayNativeHeartbeat` → `__norvaNative.onProgress`), qui réutilise intégralement le chemin d'écriture cloud existant. Même session : le filet SharedPreferences n'est plus purgé par `finish()` mais consommé à la CONFIRMATION du save (`onProgressSaved(token)`), et le flush post-crash retry au lieu de consommer-perdre. Voir `docs/roadmap/2026-07-16-session-log.md` §17.
- Ce correctif cible la justesse du timeframe enregistré après sortie / changement d'épisode, pas l'affichage interne ExoPlayer pendant la lecture.
- Le `durationHint` capturé en mémoire de page ne survit pas à un reload WebView pendant une lecture native ; depuis le 2026-07-17, `onProgress` n'écrase plus jamais un hint connu par un 0 (le merge serveur préserve la valeur d'un save antérieur).
