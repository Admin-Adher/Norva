# Reprises récentes — essais de sept copies sur quatre sources

7 octobre 2026, 08:27–08:59 Paris (06:27–06:59 UTC). Audit de lecture réel dans le navigateur Codex, sur le compte pilote, avec la version Gateway PR691 déjà déployée. Aucun code applicatif, déploiement, réglage de production ou garde fournisseur modifié pendant cet audit. L'extension générale reste préparée et désactivée.

## Résultat

Sept copies distinctes : cinq films et deux épisodes, quatre sources, formats effectifs MKV, MP4, TS et AVI. Vingt et une sessions ont été créées : dix-neuf avec `play_started`, une erreur et une restauration audio immédiatement quittée avant lecture. Ces nombres sont des sessions, pas vingt et un fichiers validés.

Le pilote démontre un nouveau succès sur **Silo MULTI-SUB S1E1** : reprise en 6,390 s, 18 407 876 octets de source conservés réutilisés après vérification fraîche, puis lecture au-delà de deux minutes et poursuite des acquisitions ordinaires. En revanche, **la fluidité et la rapidité ne sont pas validées pour tous les cas** : Normal 4K et Severance restent lents, Ash TS n'offre pas de timeline utilisable dans cet essai, Beach Party AVI échoue.

## Mesures

Les délais du tableau sont mesurés de la **création de session serveur à l'événement `play_started`**, et non du clic utilisateur. Le JSON conserve séparément le TTFF client, les dates et les positions. Une première image disponible peut précéder largement le démarrage effectif. Les départs, sauts et reprises utilisent des positions différentes : ne pas en déduire un multiplicateur causal de performance.

| Copie exacte | Source / format effectif | Premier départ mesuré | Saut avant / arrière hors tampon | Fermer puis reprendre | Résultat |
|---|---|---:|---:|---:|---|
| Normal (2026), 4K HDR, HEVC / E-AC-3 | Strng / MKV | 48,484 s à 73 s | Petit saut dans le tampon seulement | 118,302 s à 103 s | Lecture ensuite progressive ; délai inacceptable, aucun succès de cache démontré |
| Le moment de vérité / Karate Kid (1984), H.264 / MP3 | Norva Selection / MKV | 2,553 s à zéro | 7,047 / 4,131 s | 2,368 s à 255 s | Reprise ordinaire rapide ; plus de deux minutes observées après le retour arrière |
| X-Men 2, H.264 / AAC | Norva Selection / MP4 | 13,487 s à zéro | 4,842 / 5,118 s | 4,165 s à 69 s | Lectures courtes progressives ; pas de cache récent démontré |
| Ash (2025), variante BG, H.264 / AAC | Dino / TS | 9,032 s à zéro | Non réalisable : timeline désactivée | Aucun bouton Reprendre après sortie | Lecture progressive environ une minute ; pas de validation des sauts |
| Beach Party, variante EN | MAX OTT / AVI déclaré | Échec à 75,836 s | Non testé | Aucune relance | `gateway_502`, aucun `first_frame` ni `play_started` |
| Severance / Dissociation FR S1E1, deux pistes E-AC-3 | Strng / MKV | 5,869 s à zéro | 32,404 / 25,274 s | 43,874 s à 72 s | Repart mais lent ; plus de deux minutes, dont changement audio EN puis retour FR |
| Silo MULTI-SUB S1E1, E-AC-3, 42 sous-titres source | MAX OTT / MKV | 4,206 s à zéro | 20,204 / 22,002 s | **6,390 s à 77 s, cache confirmé** | Plus de deux minutes après reprise ; alimentation fournisseur poursuivie |

Pour Severance et Silo, la fiche de série affiche MP4, mais les sessions d'épisode utilisent MKV. Le tableau retient le format réellement demandé au Gateway. Les titres d'épisode ne sont pas présents dans la jointure de l'audit catalogue : leur correspondance est établie par l'UI, la source, la chronologie et l'empreinte stable de la copie dans les reçus. Les codecs catalogue des films sont ceux du profil courant au relevé, pas une reconstruction historique de chaque profil.

## Cache : preuve et limites

- **Silo** : `recentMultiAudioInputHit=true`, mode `partial-subtitles`, 18 407 876 octets injectés et validation fraîche de 4 012 ms. Huit rendus de sous-titres préparés parmi les 42 pistes source, même politique existante avant/après ; aucune attestation de couverture des 42 pistes. Aucun cache HLS partiel présenté comme complet.
- La lecture passe de 33,145 s à 122,445 s en 89,300 s d'observation, `paused=false`, `readyState=4`, sans erreur DOM. Le court extrait local décodé est H.264 / AAC-LC, sans erreur imprimée.
- Le broker poursuit avec neuf fenêtres fournisseur terminées et une active au relevé, dont des plages de 8 Mio au-delà de la première zone conservée. La reprise ne reste donc pas confinée au préchargement initial. Aucun appel média opérateur parallèle n'a été ajouté ; ces lectures sont celles du pipeline normal.
- **Normal** : une entrée d'entrée conservée existe après la première sortie, mais la réouverture n'a pas de marqueur de validation/réutilisation récent. La raison exacte de cette absence n'est pas déterminée par les reçus. Le serveur est prêt en 9,562 s lors de la seconde lecture, puis le client attend une réserve : à 06:31:03 UTC, 50 s sont chargées mais le lecteur reste arrêté ; à 06:31:57, environ 98 s sont chargées et la lecture commence. La politique adaptative reçue est inéligible. Ce délai ne doit pas être imputé entièrement au fournisseur ou au temps FFmpeg.
- Les reprises de Karate Kid et X-Men utilisent le chemin ordinaire. Le compteur de capture après ces essais indique `sliding-playlist-unbound-clock`. Ce refus protège la correspondance temporelle d'une playlist glissante ; il ne faut pas supprimer cette garde pour fabriquer un succès de cache.
- Sur Severance, les compteurs montrent aussi un refus `unverified-identity` ; aucun succès de cache n'est revendiqué. Les compteurs sont cumulatifs et leur dernier motif ne permet pas d'attribuer chaque refus à chaque session.
- À la fin, le cache secondaire annonce un hit et un input hit ; le Gateway principal reste sans hit. Les plafonds 256 Mio agrégés et 64 Mio par entrée sont inchangés. Aucun essai de charge de tous les propriétaires n'est réalisé.

## Autres limites révélées

### AVI Beach Party

Une seule tentative de la copie exacte. Le profil n'est pas acquis, la préparation ne produit aucun segment au relevé intermédiaire, puis la session échoue. Les logs bornés à 06:44–06:45:40 montrent un timeout puis `Connection refused` à 06:45:23, au moment de l'erreur. Le point réseau précis et la cause interne ne sont pas établis. Ceci ne démontre ni une panne de tous les AVI ni un fichier nécessairement corrompu. Le message visible reste générique, avec Réessayer ; aucune alternative choisie automatiquement.

### TS Ash

Le TS est lu et décodé, mais la barre `Position de lecture` est désactivée et aucune durée totale fiable n'est présentée. La durée du média HTML représente la fenêtre HLS disponible, pas une durée totale vérifiée. Une tentative clavier ne trouve donc aucun slider accessible ; elle ne constitue pas un saut effectué. Le contrôle de dix secondes n'a pas abouti non plus après masquage des contrôles. Pas de deuxième ouverture ni de faux résultat de reprise.

### Portée de la fluidité et de l'audio

Les sorties locales déjà produites ont été inspectées sans nouvelle connexion fournisseur : H.264 et AAC-LC 48 kHz stéréo, intervalles des images échantillonnées autour de 42 ms et aucun diagnostic de décodage dans les échantillons réussis. Un premier prélèvement Severance a trouvé zéro fichier car la nouvelle sortie n'était pas prête ; il est conservé comme absence de mesure, puis un échantillon ultérieur a réussi.

Le navigateur charge toujours `hls-1.7.3.min.js?v=1`. La lecture et le changement de piste E-AC-3 source → AAC-LC de sortie ont été exercés sur Severance. Le retour au français juste avant de quitter a créé une session aussitôt expirée sans `play_started` : elle est exclue des lectures réussies et des échecs média.

Les observations DOM espacées et les courts extraits décodés ne certifient pas l'absence de micro-saccades sur tout un film. Les compteurs d'images perdues ne sont pas disponibles dans ces observations. Aucune acceptation humaine à l'écoute, synchronisation labiale exhaustive, certification HDR/couleur, lecture intégrale ou validation native Android/TV n'est revendiquée.

## État final et suites

À 08:59 Paris, deux Gateways sains, zéro session active, image `sha256:2736371da88c24789dd760a86260ed8d0632f5dd7b59c2eef8ca531ac446fc99`, démarrages 02:26:07/10 UTC inchangés. Le navigateur est revenu à Films, toutes sources, recherche vide. Les lectures sont restées séquentielles et les gardes ordinaires ont été respectées. Aucun bail, quota, délai, quarantaine ou route modifié ; aucune automatisation réactivée.

Le drapeau d'extension à tous les propriétaires reste false. Avant de considérer la généralisation validée, traiter les délais de réserve de Normal, comprendre les absences de réutilisation sur les cas lents, améliorer la couverture temporelle sûre du cache HLS glissant et investiguer le TS sans durée ainsi que l'erreur AVI. Ces points sont ouverts ; ce rapport n'annonce aucun correctif nouveau.

Preuves : JSON voisin et reçus sous `.codex-artifacts/recent-resume-matrix-20261007/`. Captures `silo-reopen.png` et `silo-after-two-minutes.png`, 36 observations DOM horodatées et reçus d'événements. Les scripts de collecte sont en lecture seule ; aucune URL média, donnée d'accès, transcription ou identité de compte n'est exportée dans le rapport.
