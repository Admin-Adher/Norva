# Démarrage VOD : qualification des rafales, 9 octobre 2026

## Problème démontré

La comparaison précédente de Severance S1E1 a montré un démarrage MAX OTT
autorisé sur une production de 4,004 secondes de vidéo en 170,993408 ms.
Le débit annoncé était plafonné à 20× et le lecteur démarrait avec 6 secondes
de réserve. La lecture s'interrompait ensuite vers 24 secondes.
Voir `2026-10-09-severance-version-comparison.md` (PR737).

Cette observation prouve une qualification Norva trop courte. Elle n'attribue
pas la lenteur ultérieure au stockage fournisseur ou au relais.

## Correctif et périmètre

PR738 intégrée par `a74920cd1b29d249546fbea8d685fab3666ac869`, tête
`46dcd5954ae4163f5e4bebd796383cf47110edbc`.

- Nouveau réglage Gateway désactivé par défaut, avec liste explicite de
  propriétaires. Activation sur le seul compte pilote existant.
- Si le graphe satisfait l'ancienne condition de débit mais que la production
  a été observée pendant moins de six secondes, le Gateway retourne
  `encode-rate-observation-too-short`, inéligible et sans réserve réduite.
- La normalisation Edge existante conserve ce motif. WatchPage peut ensuite
  qualifier les nouvelles arrivées sur deux intervalles successifs d'au moins
  trois secondes chacun. Les segments longs adaptent ces intervalles à leur
  demi-durée. Chacun doit atteindre 2×, avec plusieurs ajouts contigus, image
  décodée et ajout récent.
- La réserve adaptative existante reste `max(12 s, deux segments)`. Une réserve
  déjà chargée de 96 secondes, les fichiers courts complets et les chemins
  de cache attestés gardent leur admission existante. Les annulations,
  changements de lecteur, pauses volontaires et changements de position
  invalident l'observation selon les gardes existantes.

Aucun codec, modèle audio, compte fournisseur, route, quota ou niveau de
concurrence n'est modifié. La mesure ne garantit pas le débit futur. Un ancien
client recevant le nouveau motif garde la réserve conservatrice habituelle.

## Vérifications avant activation

- 95 tests ciblés locaux réussis, un test FFmpeg optionnel ignoré. Les 15 tests
  complémentaires de segments longs recoupent ce groupe.
- CI finale : 6 176 réussites et 31 ignorés sur 6 207 tests ; zéro échec.
- Matrice Android `37924042240` : six configurations réussies, gestes/trois
  boutons et polices 1/1,3 sur téléphone, deux configurations TV. Le scénario
  `GatewayLateRecoveryInstrumentedTest` passe dans les quatre WebView réelles
  (17,275–17,655 s pour le scénario entier). Ce n'est pas une certification
  du décodage TV ni de la qualité à l'écoute.
- Canary Gateway : utilisateur 1000, GPU réel, réseau `none`, stockage séparé,
  zéro requête fournisseur. Santé, encodage synthétique et neuf tests ciblés
  réussis ; 59 tests non sélectionnés. Canary arrêté et retiré.

Incidents de vérification conservés : le premier contrôle CI échoue sur le
manifeste i18n non régénéré, corrigé par `cb246378d`. Le premier banc canary
omet deux fichiers Web requis par la fixture ; leur ajout corrige le banc,
sans modifier l'image produit. Sa première sortie enfant n'avait pas été
conservée par le wrapper. Deux matrices Android sur les têtes remplacées sont
annulées ; la matrice finale ci-dessus passe sans relance.

## Déploiement

Image `sha256:ea9594c68c27ded59edd2c1748893f758820705ab74eb521add99411ad702c40`,
sources Gateway du commit `6e32c622098fd5f4d27671c7ce760bccf3518aa8`.
Les commits suivants de PR738 changent uniquement le lecteur, ses tests et le
manifeste d'assets. Arbre source
`207bcbae32fff6286bf3120c6ac8ffd2e21852c573f554c83c310f532830585a`.

Les 94 fichiers Gateway sont comparés : seul `src/index.js` change, 93 sont
conservés, permissions contrôlées. Deux nouvelles valeurs d'environnement
activent ce contrôle pour le seul propriétaire pilote ; les autres réglages
sont conservés. Les 194 fichiers Edge et leurs processus restent inchangés.

Pause des admissions le 9 octobre de **11:44:40,615427 à 11:45:01,581212 UTC**
(20,965785 s), drainage naturel sans bail forcé. Gateways démarrés à
11:44:57,294581 et 11:44:59,842647 UTC. Worker, cron et admissions restaurés ;
dispatcher permanent conservé. Santé et toutes les empreintes vérifiées à
11:45:41 UTC. Cette intervention n'est pas décrite comme sans interruption.

## Mesures publiques

Mesures depuis le clic, sur les copies exactes de S1E1, via les claims ordinaires
et une seule lecture à la fois. La première image est distinguée de
`play_started`. Les pauses de fin d'essai sont volontaires. Les libellés de
langue identifient le choix du catalogue et ne créent pas de confirmation audio.

Témoin avant activation, clic **11:36:57,061 UTC / 13:36:57 Paris** : anglais
Strng, première image **4,201 s**, lecture **4,107 s**. À 11:39:24,195 UTC,
temps média **143,019876 s**, lecture active, état 4, aucune erreur, réserve
jusqu'à 264,056333 s. Pause volontaire puis retour catalogue ; session expirée.
Identité, source et empreinte de cible identiques au témoin anglais précédent.

Publication Web Cloudflare `37925610025` réussie à **11:46:50 UTC**.
Le navigateur charge réellement `WatchPage.4d38af8388afddc7.js` et conserve
`hls-1.7.3.min.js?v=1`. Aucun bundle Google Play supplémentaire.

| Copie / état | Clic (Paris) | Première image | Lecture effective | Observation finale |
| --- | --- | ---: | ---: | --- |
| Anglais Strng avant | 13:36:57,061 | 4,201 s | 4,107 s | 143,020 s de progression, sans interruption observée |
| Même anglais après | 13:48:08,892 | 6,060 s | 12,138 s | 134,941 s de progression, sans interruption observée |
| Français MAX OTT après | 13:51:57,064 | 4,500 s | Absente | À +130,821 s : position zéro, seulement 44,024 s disponibles |

La légère inversion des deux événements du témoin avant est conservée : ils
proviennent de télémétries distinctes, sans arrondir ou réordonner les reçus.
Les deux essais anglais et l'essai MAX sont reliés en base aux mêmes identités,
sources et empreintes de cible que leurs références antérieures. Il s'agit de
trois démarrages depuis zéro, séquentiels, sur le même Gateway secondaire,
VAAPI et slot HTTP. Aucun hit du cache HLS privé n'est revendiqué.

### Effet sur la copie saine

L'anglais après activation reçoit bien `encode-rate-observation-too-short` :
sa première production n'avait duré que **255,990 ms**, contre 258,990 ms
au témoin. La lecture commence **6,079 s après la première image**. Le temps
Gateway passe aussi de 2,001 à 3,342 s entre ces deux essais ; l'écart total
de 8,031 s depuis le clic ne doit donc pas être imputé intégralement au garde.

La position progresse de 27,572 à 77,970 puis 134,941 s, `paused=false`,
`readyState=4`, aucune erreur aux relevés. Pause volontaire en fin d'essai.
**Le contrôle ajoute une attente réelle sur cette copie saine : la conservation
des démarrages sous dix secondes n'est pas validée.** Il n'y a ni échantillonnage
exhaustif de toutes les images ni nouvelle validation sonore.

### Effet sur MAX OTT

Le Gateway annonce 19,344× sur **206,992 ms**, motif désormais inéligible.
Le lecteur ne transforme pas cette rafale en départ prématuré. Les relevés
successifs restent à zéro, `paused=true`, état 4, aucune erreur, avec des fins
de buffer de 24,044, 28,048 puis 44,024 s. Aucun clic de lecture forcé ni
abaissement de réserve. Retour au catalogue après le dernier relevé.

Entre les audits **11:52:07,821709 et 11:54:19,388923 UTC**, le transport reçoit
42 457 984 octets supplémentaires en 131,573 s, soit environ **2,58 Mbit/s**.
Les deltas de phases sont 130,837 s d'attente `provider-read`, 0,271 s
`downstream-write` et 0,464 s de traitement local. Ce relevé situe l'essentiel
de l'attente dans l'arrivée des données ; il ne départage pas le relais et la
livraison fournisseur. **Cette copie n'est pas réparée et n'a pas démarré.**

## Clôture et décision

À **13:54:59 Paris**, les trois sessions de test sont expirées. Deux Gateways
sains, zéro session/pompe et zéro claim vivant du propriétaire ; pool partagé
0/8. Admissions ouvertes, cron actif, worker et dispatcher actifs ; canary
absent. Le filtre Strng et la version FR Strng initiale sont restaurés avant
fermeture de l'onglet temporaire, sans nouvelle lecture. Les onglets utilisateur
restent ouverts et l'historique ordinaire des essais est conservé.

Le défaut de qualification d'une rafale est corrigé, mais **le compromis de
démarrage n'est pas encore optimal**. Le pilote reste limité au seul compte
déjà autorisé. Aucun élargissement : MAX attend toujours les données et le
témoin sain démarre moins vite. La suite doit améliorer la discrimination
entre réception durable et production instantanée sans généraliser un seuil
de réserve plus faible. Aucun nouveau gain de cache ni correctif AAC annoncé.

## Preuves et limites

Reçus privés/sûrs sous `.codex-artifacts/startup-observation-pilot-20261009/` :
tests, canary, manifeste, déploiement, XML Android, captures et audits de session.
Ne pas rejouer les marqueurs de déploiement consommés. Les lectures réelles
ne certifient ni tout l'épisode, ni toutes les versions, ni la qualité à l'écoute.
