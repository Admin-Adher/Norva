# Reprise récente multipiste : réutilisation des entrées

## Périmètre

Première itération PR684, extension de PR682 : les MKV multipistes pouvaient conserver jusqu'à 8 Mio d'entrées reçues lors de la lecture, à la sortie normale. À la reprise, les quatre prélèvements frais (256 Kio), la taille exacte, la cible et les liaisons privées doivent correspondre. Le broker neuf reçoit alors les plages conservées avant le démarrage ordinaire. Le graphe HLS complet est reconstruit, avec toutes les pistes audio et sous-titres. Aucune fenêtre HLS multipiste n'est assemblée depuis le cache, aucune politique de démarrage rapide n'est fabriquée.

Les entrées utilisent le même budget global de cache et une réservation avant copie, TTL dix minutes, révocation par propriétaire. Le pilote reste limité à Adrien. Aucune modification de concurrence, route, bail, quarantaine, seuil de lecture, codec ou client. La preuve par prélèvements reste partielle : elle ne certifie pas tous les octets du fichier.

## Code et vérifications

PR684, code ba66439b8fd1864e82566b709d4eefab454f3fff, fusion 29ae6d6bbeb7d29d38ca7fef96f3e79092729f86. 64 tests ciblés réussis. Groupe élargi : 191 réussis, cinq ignorés et un test historique de loopback TS annulé après dépassement de 8 s. Un seul rerun ciblé, inchangé, réussit en 182 ms ; ne pas effacer le premier dépassement. Groupes recoupés. Sept nouveaux tests : fraîcheur, cible/taille/échantillons, isolation, expiration, mémoire, annulation, restitution du broker et conservation du graphe sur hit/miss.

Canary sous UID1000/GPU réel/réseau none/stockage séparé : vingt tests réussis, zéro média fournisseur ; santé et 86 empreintes concordantes. Canary arrêté et retiré. Le premier script local de préparation d'opérateurs avait une erreur de quoting PowerShell/Python, sans mutation distante ; corrigé par script Python sauvegardé.

## Déploiement du 7 octobre, 01:09 Paris

Image sha256:edad2e6c535e1b8342b714ad73602b1430dbf058f5d52e00c1260d39baa4b034 ; arbre 80c6dab531648a54196a3956e5d9578092687a01f794b610b62981f416b8cb9b. Deux fichiers Gateway modifiés, 84 conservés. Edge/Web/Android inchangés. Pause UTC 23:09:22.001620–23:09:32.652363 le 6 octobre, drainage naturel sans bail forcé. Deux Gateways remplacés ; admissions, cron et worker restaurés, même dispatcher conservé. Vérification à 23:09:42.050317 : deux Gateways sains, 86 empreintes concordantes. Démarrages 23:09:28.380260442 et 23:09:30.928115811. Marqueur apply2 consommé dans le nouveau dossier opérateur ; ne pas le rejouer.

## Essais réels

Les mesures des deux itérations sont consignées ci-dessous.

## Limite indépendante : Conclave

Le contrôle précédent avait quatre prélèvements et une taille concordants, mais une empreinte de cible différente. Le normaliseur exclut déjà les valeurs de paramètres ; il conserve schéma/hôte/chemin/noms des paramètres. Aucun assouplissement de ce contrôle dans PR684, et aucune cause précise du changement de cible nouvellement prouvée. Le repli normal avait réussi. Cette extension concerne les entrées multipistes et ne doit pas être présentée comme une accélération de Conclave.

Reçus : `.codex-artifacts/recent-multiaudio-input-20261007/` et `.codex-artifacts/recent-resume-integration-20261006/multi-input-*.safe.json`. Aucun identifiant ou accès fournisseur publié.

## Extension PR685 : corps utile dans le plafond existant

L'essai PR684 avait réellement réinjecté 8 388 608 octets après une validation de 4 911 ms. Les trois pistes audio et deux sous-titres étaient conservés. Cependant, la reprise à 1617 s demandait encore 38 543 octets de cues en fin de fichier, puis les données près de 469 Mo (environ 4,6 s par plage de 2 Mio). La première image arrivait en 20,663 s, contre 18,327 s lors de la lecture sans cache à 1559 s ; le démarrage effectif arrivait 23,177 s après création de session contre 35,768 s. Positions différentes, donc pas de gain causal uniforme. La lecture atteignait 113,765 s relatives, readyState 4, sans erreur. Ce résultat ne suffisait pas à qualifier cette reprise de rapide.

PR685 conserve donc, pour les seules entrées multipistes, jusqu'au plafond par fichier déjà configuré de 64 Mio : cues déjà reçues en priorité, en-têtes, puis plages de corps récentes. Le budget agrégé reste 256 Mio, les copies sont réservées avant allocation, les entrées HLS restent à 8 Mio. Aucune lecture fournisseur supplémentaire à la fermeture. Quatre prélèvements frais, taille, cible et profil complet restent exigés. Aucun seuil de réserve, encodeur, codec ou parcours client changé.

Code 1fe1af00c3bc80fc32ff51c8f10af215544ea678 ; fusion d8f7e2cbd5b15be1d676195edb2407e8ac11fefc. 52 tests ciblés réussis, deux tests de broker HTTP réel réussis (groupes recoupés). Canary réseau none/UID1000/GPU : 22 tests réussis, zéro requête fournisseur, stockage séparé et fichiers synthétiques nettoyés. Canary arrêté et retiré.

Déploiement : image sha256:59ccc86a6dae39c89605ca725d0731f5b41d9b042c25f294229409616bdb03b1, arbre 9a3719fda74b26bd0c663b3c91eb2442cbb9a291a1a87dc65b938dd9a718415b. Trois fichiers changés, 83 conservés sur 86. Pause UTC 23:20:34.431307–23:20:55.378205 le 6 octobre (7 octobre 01:20 Paris), drainage naturel, aucun bail forcé. Edge/Web inchangés. Les admissions, cron et worker sont restaurés, même dispatcher conservé. Santé et toutes les empreintes vérifiées à 23:21:04 UTC. Pilote toujours limité au propriétaire autorisé.

## Mesures PR685 sur la même copie de Breaking Bad S1E3

| Essai | Position | Première image | Session créée → lecture | Validation fraîche | Octets réinjectés |
| --- | ---: | ---: | ---: | ---: | ---: |
| Sans cache | 1730 s | 19,907 s | 24,367 s | — | 0 |
| Reprise récente 1 | 1789 s | 10,546 s | 11,359 s | 6,845 s | 31 628 469 |
| Reprise récente 2 | 1902 s | 7,942 s | 8,867 s | 4,479 s | 66 953 103 |

Le temps serveur passe de 17,112 s à 7,902 puis 5,551 s ; la préparation FFmpeg de 8,801 s à 1,013 puis 1,018 s. Le TTFF est le compteur client ; session → lecture utilise les événements serveur, avec une origine différente. Les positions diffèrent ; ce tableau ne constitue pas un benchmark à position constante ni une garantie de délai pour tous les fichiers. Les trois pistes audio et deux sous-titres sont préparés dans les trois cas.

La reprise 1 progresse de 5,922 à 37,191 puis 61,076 et 112,839 secondes relatives, readyState 4, non pausée, sans erreur. Les lectures fournisseur ordinaires reprennent au-delà des plages conservées, sans nouvelle lecture d'en-tête ou de cues observée dans cette reprise. Le broker poursuit ses plages séquentielles ; aucun gel n'est observé aux relevés. Le compteur DOM ne certifie pas chaque image affichée.

Sur les trois sorties PR685, les analyses locales sans réseau d'un segment vidéo (48 images) donnent un intervalle maximal de 42 ms, zéro intervalle supérieur à 100 ms et zéro diagnostic de décodage. La piste audio de sortie contrôlée est AAC-LC, stéréo, 48 kHz. Il s'agit de segments limités, pas d'une écoute humaine ni d'une certification de tout l'épisode. Aucun échantillon fournisseur diagnostique supplémentaire n'a été téléchargé.

Les cinq checks de PR684 et les cinq de PR685 sont tous réussis, paquets Android Phone/TV et Windows compris. Aucun changement d'interface ou de code natif Android ; aucune nouvelle matrice d'émulateurs revendiquée. Les anciens correctifs du Robot Sauvage restent présents dans les 83 fichiers conservés. Conclave conserve son repli normal lorsque la cible ne concorde pas ; aucune accélération nouvelle revendiquée pour cette copie.

La reprise 2 progresse de 11,303 à 60,600 puis 103,233 et 135,090 secondes relatives, toujours readyState 4, non pausée, sans erreur. Le broker relit normalement au-delà de 576 716 800 octets tandis que la lecture continue ; vingt plages fournisseur étaient terminées dans le dernier audit de continuité. Deuxième essai de plus de deux minutes, sans blocage observé. Les essais sont arrêtés par retour à Séries, avec fermeture ordinaire de la lecture. Les deux Gateways sont sains, aucune session restante dans leurs états au contrôle final.

Preuves supplémentaires : `.codex-artifacts/recent-multiaudio-body-20261007/receipts/`, `browser-observations.safe.json`, `breaking-warm2.png`, et les fichiers `multi-body-*.safe.json` dans le dossier d'audit d'intégration. Les libellés d'observation sont indicatifs : le premier relevé nommé « two-minutes » correspond exactement à 112,839 s, pas à 120 s. Le second essai atteint bien 135,090 s. Aucun lecteur utilisateur n'a été remplacé pendant ces essais.
