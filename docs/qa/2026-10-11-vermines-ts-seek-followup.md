# Vermines et Minnal — contrôle de reprise du 11 octobre

## Périmètre

Lecteur public Norva, compte propriétaire du pilote uniquement. Même copie
Vermines MP4 / MAX OTT et Minnal Murali MPEG-TS / Dino. Mesures de progression
sur `#watch-video`, distinctes de la première image et des pauses volontaires
utilisées pour afficher les commandes. Les positions varient : aucun comparatif
de débit à position identique ni garantie globale ne découle de ces essais.

## Corrections

- PR768 : conserver les paquets précédant la requête de fin TS même si cette
  requête attendait pendant la lecture initiale. 168 tests ciblés réussis,
  six optionnels ignorés. Déployée sur le Gateway pilote à 05:58 UTC.
- PR769 : utiliser le délai fournisseur existant de 2,5 secondes plutôt que
  les six secondes destinées à un appareil distant, uniquement sur le pilote
  et après confirmation de révocation de tous les anciens transports MP4
  Gateway. Toute preuve absente ou nettoyage en erreur conserve six secondes.
  43 tests ciblés réussis ; contrats CI réussis ; deux réplicas Edge sains
  après déploiement à 06:02 UTC.
- PR770 : grâce initiale bornée de 500 ms pour la continuation spéculative TS
  du pilote, y compris après attente derrière une requête plus récente.
  174 tests ciblés réussis, six optionnels ignorés ; contrats CI réussis.

## Vermines

Le précédent essai de reprise à 05:27 avait consacré 6000 ms à la grâce de
remplacement dans une préparation Edge de 7815 ms. Le correctif vise ce chemin.
Les nouvelles fermetures normales n'ont pas nécessité de remplacement :
préparations Edge de 406 et 304 ms, délai de remplacement nul. Elles ne
mesurent donc pas directement le gain de PR769.

À 06:02, première image à 49,958 s. Réouverture à 990 s : première image
à 17,967 s, première progression observée à 18,173 s. Plusieurs pauses
initiales sont réellement présentes. Le transport a réutilisé 6 750 208
octets de données récentes ; la présence du cache ne suffit pas à rendre
cette reprise fluide. Une plage de 1 Mio a demandé 11,784 s dans la lecture
précédente ; le trajet exact responsable n'est pas départagé.

Après constitution de réserve, saut arrière de dix secondes : progression
dès le relevé à 0,280 s. La vidéo passe ensuite de 1021,131 à 1162,269 s
en environ 141 s. Les trois blocs échantillonnés restent readyState 4, sans
erreur ni temps figé ; les intervalles entre blocs ne sont pas une mesure
continue. Ce résultat ne supprime pas les interruptions initiales.

## Minnal après PR768

Saut hors cache à 3383 s : première image télémétrée 35,317 s après la
demande serveur, préparation Gateway 33,229 s. La requête de fin inclut
bien les 256 Kio précédents et évite la requête arrière redondante. Mais
le démultiplexeur effectue encore une longue recherche de positions TS.
Deux continuations spéculatives sont interrompues ; chacune impose encore
le délai normal de libération. Cette trace motive PR770.

Le bloc contrôlé après démarrage progresse de 24,230 à 50,085 s en 25,85 s,
sans état inférieur à 3 ; la fermeture normale intervient à 91,906 s.
Ce saut ne valide pas un gain global par rapport aux 21 secondes antérieures.

## Minnal après PR770

Déploiement propriétaire terminé à 06:13:52 UTC, image
`sha256:ae31d0f3fdfec93da1361ec0e073d16cd502fbbfc3e599e279cd6e5722b240a4`.
Gateway principal et routage inchangés. Réouverture après remplacement du
processus : progression observée à 15,504 s. Ce remplacement ne constitue
pas un essai de cache chaud.

Nouveau saut hors cache à 4444 s : progression observée à 20,993 s depuis
l'action de timeline. Préparation Gateway 15,177 s, premier segment 12,881 s.
Le contrôle des traces montre zéro requête fournisseur interrompue et la
disparition de la continuation initiale inutile. Des recherches successives
de positions restent nécessaires. L'index persistant n'est pas utilisé avec
les preuves de fichier actuelles ; sa validation n'est pas contournée.
Les positions et conditions réseau diffèrent : pas de gain comparatif global
revendiqué face au saut antérieur à 3383 s.

De 41,641 à 87,949 s après le raccord, la progression suit 46,316 secondes
murales sans readyState inférieur à 3, pause, erreur ni temps figé.
Un second bloc de 115,906 à 154,606 s reste également continu. Fermeture
normale après plus de deux minutes et demie de média depuis le saut.

Réouverture à 4599 s : première progression observée en **4,526 s**.
Hit du cache HLS confirmé, 49,032 s devant la reprise, 8 Mio d'entrée
réutilisés et quatre échantillons frais acceptés. Préparation 2,984 s,
validation 2,943 s, continuation prête en 11,878 s. Il s'agit bien d'une
reprise couverte ; ce résultat ne qualifie pas le saut hors cache à 21 s.

## Preuves

Fichiers locaux ignorés dans `.codex-artifacts/startup-cache-20261010/` :
`speed-window-apply.remote.py.safe.json`, `speed-ts-after.safe.json`,
`speed-mp4-edge.safe.json`, `speed-edge-phases.remote.py.safe.json`,
`speed-vermines-closed.safe.json`, `speed-edge-tests.log`,
`speed-ts-grace-tests.log`, `speed-grace-stage.safe.json`.
Également `speed-grace-apply.remote.py.safe.json`, `speed-ts-final.safe.json`
et `speed-ts-warm-final.safe.json` pour le dernier déploiement et les replays.
Identifiants et accès privés exclus du rapport. Aucune validation à l'écoute
ni certification de chaque image n'est revendiquée.

### Admission du dernier déploiement

Le premier contrôle de drainage attendait également deux réservations de
catalogue d'autres comptes, sans transport actif sur le pilote. Leur propriétaire
ne figure dans aucune des deux listes du pilote (startup et reprise récente).
Le contrôle de mise à jour du seul Gateway pilote a donc été précisé pour
conserver ces réservations étrangères et vérifier les réservations de son
propre périmètre. Aucun bail n'est effacé ni écourté ; les connexions publiques
et les pompes actives restent des conditions bloquantes.
