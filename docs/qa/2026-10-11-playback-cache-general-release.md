# Ouverture générale du cache et des reprises VOD

## Autorisation et portée

Le 11 octobre, après le rapport du pilote, l'utilisateur accepte les résultats
et demande explicitement le déploiement général. PR772 est intégrée par
`f7cc6c322df3eeb4af321ce02dfcb28f58510e3c`. La source déployée est
`5587e74400ba7703db1bce6b3c6c348b3d5cad89`.

Les deux Gateways reçoivent les correctifs MP4, MKV/TS et les flags généraux
explicites du cache récent, de la conservation du décodeur, de l'observation
durable du démarrage et de l'éligibilité au préfixe. Les deux réplicas Edge
reçoivent le même flag général du préfixe. Les comptes actuels et futurs sont
éligibles sans inscription manuelle dans une liste pilote.

Cette ouverture ne crée pas un cache partagé entre comptes : propriétaire,
source, révision, taille, pistes et preuves courantes restent obligatoires.
Les quatre prélèvements frais demeurent nécessaires pour réutiliser les données
récentes sans validateur fort. Les métadonnées temporelles TS orientent une
recherche ; elles n'autorisent pas les octets conservés.

La file de préchargement reste celle des deux fichiers sélectionnés du pilote.
L'éligibilité générale n'envoie pas automatiquement tout le catalogue en
préparation. Le préfixe HLS n'est toujours pas une minute MP4 native préparée.

## Vérification et déploiement

- 122 tests ciblés de portée, admission, révocation et isolation réussis.
- CI code `38140786338`, job contrats `114474053885` : **6 419 tests réussis,
  35 ignorés**, ainsi que 41 contrats SQL dans le groupe distinct.
- Les quatre jobs, contrats et paquets Windows/Android Phone/Android TV, sont
  réussis au contrôle après déploiement. Aucun paquet client n'est publié ici.
- Canary final sans réseau : empreintes des sources exactes, santé et encodage
  GPU réussis, zéro requête fournisseur.
- Image commune aux deux Gateways :
  `sha256:a6ab99e72f5dad18f0bcff9726ced0ced4304e57778df36ddbede328e92a30ae`.
- Déploiement de **12:55:55,751 à 12:56:14,063 UTC** (14:55–14:56 Paris).
  Le travail en vol est drainé naturellement. Aucun bail forcé.
- Les deux réplicas Edge gardent leur image et leurs fonctions courantes ;
  seule `startupCacheOwnerAllowed` est modifiée dans la fonction de lecture.
  Les réglages et routes existants restent exacts. Le WatchPage public de PR773
  est conservé ; aucun ancien frontend ou arbre Edge n'est republié.

Les Gateways principal et secondaire annoncent chacun les quatre portées
`all-authenticated-owners`. Leurs fonctions réellement déployées acceptent
24 identités synthétiques valides hors liste pilote et refusent les valeurs
invalides. Même contrôle sur les deux fonctions Edge déployées. Ce sont des
contrôles d'éligibilité, **pas 24 lectures sur des comptes clients**.

Les budgets HLS restent **256 Mio par Gateway, 64 Mio par fichier**, agrégés
indépendamment du nombre de comptes. La cache d'entrée, ses limites et ses TTL
restent inchangés. Environ 32,8 Gio disponibles sur l'hôte au contrôle de 13:06
UTC : marge observée, pas certification de charge simultanée générale.

## Relectures publiques après déploiement

Lecteur Norva public, compte de test existant, une lecture à la fois. Les caches
mémoire sont initialement vides après la recréation des services. Mesure de
progression confirmée : deux observations successives espacées de deux secondes
au plus, ready >= 3, non pausées, sans erreur, avec temps vidéo croissant.

| Essai | Progression confirmée | Observation |
|---|---:|---|
| Vermines MP4, sans cache après redémarrage | 51,3 s, borne de confirmation | Un trou d'échantillonnage entre 30 et 50 s empêche de donner le délai réel exact. La vidéo progresse ensuite. |
| Vermines MP4, réouverture avec cache | **8,7 s** | **18 337 990 octets** réinjectés, 76 hits, puis **33 588 071 octets nouveaux** reçus. |
| Vermines, saut avant de 10 s | Non confirmé durant les 3 s observées | Ready1 et position stationnaire ; un saut arrière est ensuite demandé. Ce saut ne valide pas une reprise fluide. |
| Vermines, saut arrière de 10 s | **1,3 s**, puis irrégularités | Huit observations ready < 3 et quatre intervalles stationnaires après la première progression ; aucune erreur vidéo. Plus de **140 s de vidéo** progressent au total après ce saut. |
| Minnal Murali, MPEG-TS exact, reprise à 9 077 s sans cache | **54,7 s** | Gateway prêt en 43,5 s. Après démarrage, les 29 observations montrent progression/ready4, sans pause ou erreur. Ce lancement froid reste lent. |

Les dernières fenêtres de Vermines montrent la continuation avec des données
nouvelles au-delà du cache, mais les irrégularités initiales interdisent de
qualifier l'ensemble de cet essai de parfaitement fluide. Les trous entre les
fenêtres de mesure ne sont pas considérés comme des secondes contrôlées.

Le MPEG-TS est bien la copie de **927 773 232 octets**, pas l'autre version MKV
groupée sous le même titre. Trois segments déjà produits sont contrôlés, sans
nouvel accès fournisseur : H.264 High et AAC-LC 48 kHz stéréo, décodage audio
sans erreur. Cela ne remplace pas une validation perceptive du son.

La réouverture MPEG-TS avec cache n'est pas rejouée ici : la progression de fin
de film sort ce titre de la liste des reprises. Les preuves privées HLS en
6,4 s du pilote précédent restent consignées dans le rapport de récupération
TS ; elles ne sont pas présentées comme une nouvelle mesure de cette ouverture
générale. Ni essai de charge globale, ni garantie de rapidité de toute source.

## Clôture et retour arrière

Les lectures sont fermées par navigation normale vers l'Accueil et l'onglet de
test est fermé. Les quatre services sont sains, zéro session média, zéro pompe
et zéro claim cloud actif. Admissions/cron/workers restaurés ; un travail
légitime du dispatcher reste en vol au contrôle, sans suppression de son bail.

Les quatre conteneurs antérieurs sont conservés sous le suffixe
`-rollback-general-20261011`, arrêtés. Les configurations et portées pilotes
privées sont sauvegardées. Le retour arrière restaure ces configurations et
montages après drainage naturel ; aucune suppression d'identité ou ouverture
de connexion parallèle n'est nécessaire. Les flags restent persistants dans
les configurations Docker après redémarrage. Pour une recréation, reprendre
les valeurs explicites de `ops/hetzner/playback-cache-general.env.example`.

Preuves locales privées/sanitaires :
`.codex-artifacts/startup-cache-20261010/general-{stage,apply,status,native}.remote.py.safe.json`
(le reçu stage est `general-stage.safe.json`),
`general-public-replay.safe.json`, `general-replay-summary.safe.json`,
`general-minnal-cold.gateway.safe.json`, `general-minnal-audio.safe.json` et
`general-final-health.safe.json`. Aucun accès fournisseur ni jeton publié.

**Conclusion : extension générale exécutée avec budgets et garde-fous conservés.
Les limites de réception, les ouvertures sans cache et certaines interruptions
restent observables ; ce déploiement n'annonce pas leur disparition.**
