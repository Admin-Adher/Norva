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

## Preuve Android exécutée

La fixture existante `tests/fixtures/mobile-live-search.js` vérifie désormais le
clic du vrai bouton dans `verifyRender()`, appelé par
`tv.norva.phone.LiveSearchScopeInstrumentedTest`. Seule la frontière de lecture
est remplacée par un enregistrement du choix : aucun fournisseur, session ni
vidéo. Les vrais contrôleurs, le HTML et les événements DOM sont utilisés.

La même classe vérifie recherche TF1, conservation du focus et du vrai clavier,
réponses bornées à la source et les deux ordres Sources/Catégories. Les quatre
configurations téléphone **trois boutons / gestes × police 1.0 / 1.3** ont réussi
le 30 septembre 2026, sans test ignoré. Le reçu final atteste `complete=true`,
`failure=null`, `cleanupError=null` : l'émulateur QA est arrêté et son plafond
restauré à 2 CPU. Un contrôle `validate` distinct après le rejeu confirme cet état.

Les APK app et instrumentation proviennent du même job réussi `110046628580`,
Build `36761806338`, tête PR513 `18fc35acfe8cc35ab29772f413bf5d0469216afc` :
artefacts `11118663240` et `11118438570`. Leurs archives et contenus ont été
vérifiés par SHA256, et leur certificat de signature est identique. Le guide et
la fixture extraits du test APK correspondent exactement aux sources après
normalisation LF : `1377a11a11…` et `5339498cd7…`.

- Manifeste : `6dfbc51e965c35f15b7b69ce3d35b4780f3bacd8f6d1c8d690678f2987509dcd`.
- Opérateur local ciblé : `cc325dcb049fedd8f8e578a82f0493ac4d01006f5c0987d1b9566fc22d4faab9` ;
  huit tests de verdict strict et d'expurgation réussis.
- Reçu privé : `/home/adrien/.norva/live-preview-host-proof-20260930/run-20260930T185949Z/result.json`.
- SHA du reçu : `fff8850bea7ffde0ae9803433f21f567da9278354be1cb5140cba64011583188`.
- Seize captures conservées ; inspection visuelle d'une capture par configuration :
  champ et focus visibles, clavier réel, cible TF1 cohérente et barre de navigation
  Android attendue. Il s'agit du catalogue local QA, sans fournisseur.

La première CI `36761441190` a refusé le digest généré obsolète du guide dans
`i18n/asset-manifest.json`, avant toute compilation Android. Le générateur officiel
a actualisé ce seul digest ; son mode `--check` et les contrats cloud du nouveau
Build ont ensuite réussi. Ce premier run n'est pas compté comme une preuve Android.

**Limites :** ce rejeu atteste le contrat UI avec les vrais contrôleurs dans le
WebView Android ; il ne certifie ni la lecture du fournisseur, ni la performance
FPS globale, ni toute la suite Android. Aucune lecture ni commande ADB physique
n'a été lancée pendant cette sous-tâche. Le déploiement est géré séparément.
