# Live : identité du bouton Regarder

## Observation et diagnostic

Sur le mobile après passage de Toutes les sources à Strng, le bandeau affichait
BE: TF1 HD alors que le premier résultat était Arabic 24/7. L'essai suivant a
lancé Arabic. Les captures de contrôle sont conservées dans le dossier privé
`android-tf1-final-20260930`. Aucun message d'erreur JavaScript pertinent n'a été
trouvé dans le log du processus : le timing exact de ce cas physique reste
indéterminé.

L'audit de main `df78b3062ea439e84ba54cb285d8107904cb01b4` a néanmoins reproduit
un défaut précis : le bouton affiché ne portait aucune identité et son handler
lisait `currentChannel` au moment du clic. Un changement de sélection entre le
rendu et l'activation remplaçait donc silencieusement la chaîne demandée. De
plus, `render()` publiait cette nouvelle sélection avant de finir le HTML : un
échec de rendu pouvait laisser l'ancien bandeau associé à la nouvelle cible.

## Correctif

- Le bouton porte la chaîne, le type de source et l'identifiant de source de son
  propre rendu. Le handler résout exactement cette identité dans le catalogue
  courant, puis vérifie le filtre de source.
- Une identité disparue ou issue d'une autre source ne lance aucune chaîne de
  remplacement ; le guide est actualisé.
- La sélection n'est publiée qu'après remplacement réussi du DOM correspondant.
- La préférence pour une variante saine de la même famille reste active.
- Les identifiants numériques `0` sont conservés explicitement avant échappement.

Aucun changement de Java produit, de filtre, d'API, de droits ou de transport.

## Vérification locale

Le nouveau fichier `tests/live-preview-play-intent.test.js` utilise les vraies
méthodes du guide et de la liste, la véritable sortie HTML du bouton et le handler
installé par `init()`. Avant le correctif, quatre scénarios échouaient : TF1
remplacé par Arabic, cible absente remplacée par la première ligne, collision
d'identité entre types de source et sélection publiée malgré échec de rendu.
Le scénario de variante saine était déjà réussi.

Après correctif : **32 tests réussis, aucun skip**, dont les cinq nouveaux cas,
avec ces fichiers :

```text
node --test tests/live-preview-play-intent.test.js tests/live-source-selection.test.js tests/live-browse-intent.test.js tests/live-loading-feedback.test.js
```

`git diff --check` est propre.

## Preuve Android préparée, non encore exécutée

La fixture existante `tests/fixtures/mobile-live-search.js` vérifie désormais le
clic du vrai bouton dans `verifyRender()`, appelé par
`tv.norva.phone.LiveSearchScopeInstrumentedTest`. Seule la frontière de lecture
est remplacée par un enregistrement du choix : aucun fournisseur, session ni
vidéo. Les vrais contrôleurs, le HTML et les événements DOM sont utilisés.

La même classe vérifie déjà recherche TF1, conservation du focus et du clavier,
réponses bornées à la source et les deux ordres Sources/Catégories. La suite
ciblée doit être exécutée après reconstruction de l'APK test, dans les quatre
configurations téléphone (gestes/trois boutons, police 1.0/1.3), par exemple avec
`NORVA_ANDROID_TEST_CLASS=tv.norva.phone.LiveSearchScopeInstrumentedTest` dans le
runner QA existant. Les APK précédents embarquent leurs anciens assets ; ils ne
permettent pas d'attester ce nouveau JavaScript sans reconstruction.

**Limite actuelle : aucune validation Android de ce patch et aucun déploiement
n'ont encore été effectués.** Aucune lecture ni commande ADB physique n'a été
lancée pendant cette sous-tâche.
