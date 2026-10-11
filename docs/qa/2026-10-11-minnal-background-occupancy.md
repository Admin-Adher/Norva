# Minnal : occupation auxiliaire et préparation du cache

## Périmètre

Copie exacte **Minnal Murali — MA/Dino, MPEG-TS**, 927 773 232 octets,
durée annoncée 9 558,8 secondes. La variante MKV du même titre n'est pas
le témoin de cet audit. Aucun identifiant ni accès fournisseur n'est publié.
La portée générale des caches reste active.

### État final après PR783 et PR784

Le refus Norva sur changement du seul chemin de livraison et la tentative
inutile de l'ancienne adresse sont corrigés et déployés. Les deux derniers
rejeux publics prouvent un chemin réellement renouvelé, quatre échantillons
fraîchement concordants et **8 Mio réutilisés** : reprises en **9,3 et 8,4 s**.
Chaque lecture dépasse deux minutes au-delà de sa fenêtre conservée, sans
pause ni erreur dans les relevés. Les limites d'échantillonnage et le détail
des vérifications figurent dans la dernière section. Les mesures initiales
ci-dessous décrivent les étapes antérieures et restent conservées.

## Reproduction de l'occupation sans lecture

Le 11 octobre, aucune session de lecture du propriétaire ou du même compte
fournisseur n'était active. Les derniers événements de visionnage étaient
anciens. Le worker de préfixes reportait chaque minute `account-presence`.

Le signal `gateway` avait plusieurs producteurs auxiliaires : des sondes de
langues et une tâche durable de vignettes du même propriétaire et de la même
source. Une observation sans PID média ne suffisait donc pas à déclarer toute
l'activité fantôme : des lots se relançaient entre les observations.

Une pause diagnostique bornée des nouvelles admissions, de 13:49:20 à
13:54:44 UTC, a laissé les tâches courantes se terminer sans supprimer de bail.
La file interne Gateway continuait à reprendre son travail. Une préemption
auxiliaire authentifiée attestait le drainage, puis de nouveaux lots
renouvelaient l'activité. Les admissions ont toutes été restaurées. La présence
d'une réservation à un instant sans PID n'est pas une preuve suffisante d'un
transport fantôme : les sondes et les lots changent entre deux relevés.

Le défaut de planification est concret : les lots de vignettes revenaient
après 60 secondes, tandis que le lecteur d'activité protège cinq minutes.
Le délai fournisseur existant de dix minutes n'était marqué qu'à la fin du
sprite complet. La file pouvait ainsi empêcher indéfiniment une fenêtre libre
pour le préfixe, alors que l'utilisateur avait fermé le lecteur.

À 14:40:28 UTC, l'occupation était réelle : un ffmpeg de vignettes lisait le
même compte fournisseur, alors qu'aucune lecture utilisateur n'était active.
Le mode durable général était actif. Les observations ne permettent donc pas
d'attribuer ce travail précis au chemin legacy.

## Correctifs PR776

- Le délai fournisseur existant s'applique après chaque fermeture confirmée
  d'un lot de vignettes, y compris un lot interrompu.
- L'assemblage local reste préemptible pour protéger le CPU, mais ne renouvelle
  plus l'occupation fournisseur puisqu'il n'a pas de transport source.
- La dernière barrière avant lancement du lot respecte aussi le quiesce de fond.
- Le nettoyage des extractions est idempotent. Une fermeture de processus
  confirmée fournit un nettoyage de secours ; une ancienne libération ne peut
  pas effacer le détenteur suivant.
- La grâce de libération ffprobe commence à sa sortie confirmée, indépendamment
  de pipes tardifs. Les résultats attendent toujours leur fermeture avant parse.
- Le transport de métadonnées non drainé reste excluant. Ni une demande de kill
  ni une erreur d'un processus vivant ne suffisent à libérer la réservation.
- Diagnostics authentifiés, bornés et opaques des détenteurs ; aucun argument
  de processus ou URL dans leur réponse.

## Vérification et déploiement

**126 tests ciblés réussis**, sans test ignoré. Contrats CI réussis sur
`934596a343a77356c9fbf7c7ff68527b7f2309cc`, run `38145896825`, job
`114489046778`. Canary sans réseau et encodage VAAPI réussis.

PR776 fusionnée dans `e849ed9ad04d02a90ed02f1259cd62541b92bf0f`.
Déploiement des deux Gateways de **14:10:35 à 14:12:25 UTC** (16:12 Paris),
après drainage naturel et attestation auxiliaire positive. L'image est
`sha256:0111072421a63f8998330144cfe8fe021951cbbe0177de566c8e69911142a324`.
Environnements, routage, budget 256 Mio/64 Mio et portée générale conservés.
Retour arrière retenu ; admissions et workers restaurés.

À 14:13:04 UTC : aucune lecture/pompe, aucun broker LID ou détenteur de
réservation de ce compte. La tâche de vignettes est différée, sans opération
active. Le dernier signal est encore protégé cinq minutes ; il n'est pas
supprimé artificiellement. La préparation et les mesures publiques suivent.

## Complément PR777

Le chemin legacy possède le même défaut de sortie anticipée : son retour après
préemption ne marquait pas le délai fournisseur. Il est corrigé aussi, sans
prétendre que ce chemin explique à lui seul l'activité réelle ci-dessus.
Une erreur d'un enfant vivant conserve désormais sa réservation jusqu'à sa
fermeture confirmée.

**128 tests ciblés réussis**, sans test ignoré. Contrats CI réussis sur
`29f62bd6d67abfc3fa75c1001f8d155bb268f61f`, run `38147682790`, job
`114494363516`. Canary et encodage VAAPI réussis. PR777 fusionnée dans
`f75eff8f402264249c5451a6485f82a8c93a7e78`.

Déploiement des deux Gateways de **14:40:43 à 14:41:04 UTC**, image
`sha256:2a6c52c38ca1a6c22efdbb3ab506ab637327f0f39ea0b72c38e8657a2bff0b43`.
Environnements, routage, budgets et portée générale conservés. Admissions
restaurées, retour arrière retenu.

Un contrôle borné de préparation suspend les nouvelles admissions de langues
pendant que le worker de préfixes reste actif. Les protections de présence,
les baux et la vérification de fichier restent appliqués. Ce contrôle ne prouve
pas à lui seul l'équité automatique entre tous les travaux de fond. Aucun
cache préparé ni délai de reprise n'est encore revendiqué à ce stade.

## Présence passive : reproduction et PR778

Le contrôle suivant a révélé une cause indépendante : après expiration du signal
fournisseur, `presence` le remplaçait et était renouvelée sans lecture active.
L'Accueil ouvert rafraîchit l'historique toutes les 30 secondes ; la route Cloud
comptait chaque GET authentifié comme une nouvelle utilisation. Les notifications
de contenu ont le même effet. L'onglet n'a pas été fermé pour masquer ce défaut.

PR778 exclut uniquement les GET de synchronisation d'historique et d'inbox de
cette écriture, pour les utilisateurs et les appareils associés. Le heartbeat
idle connu reste exclu. Boot, navigation catalogue, mutations et routes inconnues
gardent le signal protecteur. Il n'existe pas de nouveau paramètre client pour
contourner l'admission. Les baux, TTL et contrôles de transport sont conservés.

**42 tests ciblés réussis**, dont un rejeu logique de dix minutes de polling.
Contrats CI réussis sur `c15191fffff83ae6a682499e76379ffc9fa9e9ca`, run
`38149322067`, job `114499237004`. Canary Cloud/Playback sain, zéro demande
fournisseur. PR778 fusionnée dans `b22f2708b9449b8ccd639c819d9b12cd29dcd25b`.

Déploiement des deux Edge de **15:00:50 à 15:01:08 UTC**, empreinte Cloud
`3227e3bd33f48f99b84e6a26f21b600e981553fdfaeeaf99bb3374c96d3c3df0`.
Une seule fonction changée : `norva-cloud/index.ts`. Les Gateways n'ont pas
redémarré ; environnements, cache, routage et portée générale sont conservés.
Le rejeu poursuit l'expiration naturelle du dernier signal et la préparation.

### Complément PR779 : vérification automatique des sources

Le contrôle réel de PR778 a révélé un troisième lecteur passif :
`pollCatalogChanges()` rafraîchit la liste des sources toutes les cinq secondes,
y compris lorsque les imports sont terminés. Ce GET de données Cloud renouvelait
encore la présence. PR779 l'exclut aussi, pour le compte et les appareils.
Les détails, tests, modifications et suppressions de source gardent la protection.

Les mêmes **42 tests ciblés** passent avec ces deux routes supplémentaires.
Contrats CI réussis sur `e1b93c07c19a9809c9cff0ebd91fbf41c9ea6878`, run
`38149723608`, job `114500466257`. Canary sain, zéro demande fournisseur.
PR779 fusionnée dans `ec18660924bffed5ede3284656960f7fe3b080f0`.

Les deux Edge sont actualisées de **15:06:32 à 15:06:36 UTC**, empreinte Cloud
`91cf2f85976cf3c43deae7452a4055bf2b6dd111e8787d7c1e945be79613432a`.
Environnements et Gateways sont conservés. À 15:06:45, aucun détenteur
d'extraction n'est présent et la dernière présence a 29 secondes.

### Complément PR780 : guide et favoris périodiques

Les journaux d'accès établissent le producteur restant, à 15:10:46,
15:15:46 et 15:20:46 UTC : quatre POST `sources/:id/epg` et un GET
`favorites`. `EpgGuide` lit le guide toutes les cinq minutes, avec POST pour
les sélections de chaînes, puis relit les favoris. Cette lecture ne représente
pas une interaction du spectateur. Le signal renouvelé juste avant expiration
empêchait encore le préfixe, voire annulait sa préparation déjà engagée.

PR780 exclut ces lectures exactes de la présence, pour le propriétaire et les
appareils associés. Les requêtes XMLTV réelles gardent leurs baux de transport,
le ledger Gateway et la revalidation de source ; seules les données mises en
cache ou les sélections vides ne créent plus une présence fictive. Les tests de
connexion, sync, mutations, boot et requêtes inconnues restent protégés.

**66 tests ciblés réussis**, sans test ignoré. Ils couvrent dix minutes de
rafraîchissements passifs, les mutations, les transports EPG interrompus ou
différés, ainsi que les gardes du préchargement.

Contrats CI réussis sur `9bef9f25a5981f818361894ffb9000ae39386467`, run
`38151076581`, job `114504485275`. Canary Cloud/Playback sain et zéro demande
fournisseur. PR780 fusionnée dans `7756bf1193bdb8fecb0341788597a033fbbd520c`.
Déploiement des deux Edge de **15:26:06 à 15:26:10 UTC**, empreinte Cloud
`d1af7d1cc6fcbe07ada00e683cdd1f6a5a0910dac71f651a2749286eeb678c1e`.
Les Gateways, caches, environnements et portée générale sont conservés.

## Préparation réelle et reprise publique après PR780

De 15:26:26 à 15:33:11 UTC, une pause bornée des admissions de fond permet
d'isoler le préchargement. Le worker de préfixes reste actif avec ses gardes
ordinaires : aucune activité ni réservation n'est effacée. Après fermeture du
dernier lot auxiliaire, le signal fournisseur expire naturellement.

À 15:30:46, les lectures automatiques du guide et des favoris continuent sans
renouveler la présence. À **15:32:30**, le compte est libre, sans détenteur de
transport. À **15:33:03**, le worker publie `prefix-ready` pour le Minnal TS
exact : sa première minute a bien été préparée. À **15:33:11**, toutes les
admissions et tâches suspendues sont restaurées.

Cette préparation contrôlée prouve le fonctionnement du préchargement. Elle
ne mesure pas l'équité entre toutes les tâches de fond en charge normale.
Les lectures publiques suivantes utilisent les admissions habituelles.

| Essai public | Délai observé depuis le clic | Réutilisation et continuation |
| --- | --- | --- |
| Redémarrer à zéro | Première progression échantillonnée à 31,1 s ; échantillonnage initial seulement à 21 s | Aucun contrôle du préfixe enregistré ; pause de chargement durable observée vers 201 s de vidéo |
| Reprise à 203 s | Première progression échantillonnée à 23,8 s | Cache récent trouvé, mais validation refusée (relais 502, amont 509). Repli normal ; 163 s de progression atteints |
| Reprise à 367 s | Première progression échantillonnée à 19,9 s | Cache trouvé puis refusé pour changement du chemin de livraison. Repli normal ; 383 s de progression atteints |

Les deux reprises positives n'ont pas utilisé les fragments du cache. Elles
n'ont pas présenté d'attente dans les fenêtres échantillonnées après démarrage,
mais ces fenêtres comportent des interruptions de mesure : elles ne prouvent
pas une absence exhaustive de gels. Trois segments de la première reprise
contiennent de l'AAC-LC décodé sans erreur ; aucune validation à l'écoute du
film entier n'est revendiquée. Les lectures sont fermées normalement.

## Raccord d'identité du préfixe

Le contrôle du code révèle un défaut supplémentaire : la préparation ajoute
la variante du catalogue à `vodIdentityKey`, alors que la session publique
construit cette clé avec `variantId=null`. Le même fichier peut donc être
préparé sous une clé introuvable lors de sa lecture. L'ancien test ne comparait
pas la valeur réellement fournie par la session publique.

PR781 aligne le stockage du préfixe sur l'identité publique exacte
propriétaire/source/type/fichier/URL. Le permis de préparation conserve la
variante appartenant au compte, l'empreinte du profil, la révision de source et
le hash de cible. Une variante changée reste refusée. Les quatre échantillons
de revalidation, la taille et la cible de livraison restent exigés.

**80 tests ciblés réussis, un test optionnel existant ignoré.** Le canary Edge
vérifie Cloud et Playback sans demande fournisseur. Contrats CI réussis sur
`40051ade221757fb4d39b4623aa6e4aaf71446cc`, run `38153245734`, job
`114510861895`. PR781 fusionnée dans `59c86c1ba64832f0ec8762b1784d027fc5337ab4`.

Les deux Edge sont déployées de **15:57:51 à 15:58:06 UTC**. Une seule fonction
change : `norva-playback/index.ts`, empreinte
`d036c6e17df970a45998f4c7d0730a0eb4cd20e1809ffd6ff2fdabd401b20f90`.
Les Gateways ne redémarrent pas ; caches, environnements et portée générale
sont conservés.

### Préparation et lectures publiques après PR781

Le deuxième contrôle borné s'étend de **15:58:11 à 16:09:19 UTC**. Il garde les
baux et le délai d'activité, sans effacement forcé. Le remplacement Edge
interrompt une requête de préparation déjà engagée ; le worker la déclare
`transport-unconfirmed` puis applique son délai de retry. Aucun détenteur de
transport ne reste ouvert dans les relevés.

À 16:03:06, la sonde du profil exact est terminée et le worker annonce
`profile-refreshed`. Après expiration de la protection temporaire liée à cette
sonde, il prépare le préfixe et publie **`prefix-ready` à 16:09:09 UTC**. Toutes
les admissions suspendues sont restaurées à **16:09:19**. Le cache de Minnal
est donc réellement préparé avec l'identité corrigée.

| Lecture publique après correction | Observation | Cache |
| --- | --- | --- |
| Reprise à 751 s | Première progression échantillonnée à 19,6 s | Fenêtre récente expirée ; préparation normale |
| Recommencer à zéro | Encore en attente à 24,8 s ; première progression ensuite échantillonnée à 101 s, après un trou de mesure | **Préfixe désormais trouvé**. Revalidation de l'adresse conservée refusée : 502/amont 509, zéro échantillon validé. Repli normal |
| Reprise à 185 s après cette lecture | **35,5 s** avant la première progression échantillonnée | Cache récent trouvé ; chemin de livraison différent, cache écarté |

La reprise à zéro atteint 184 secondes de progression ; la dernière reprise
atteint 130 secondes. Les dernières fenêtres de mesure progressent sans
attente. Les trous entre fenêtres atteignent environ 76 et 86 secondes : une
fluidité exhaustive n'est pas revendiquée. Le délai exact du redémarrage à
zéro ne peut pas être établi avec cette interruption de mesure.

Pour la dernière reprise, le Gateway passe **1,65 s** à revérifier le cache,
puis **32,17 s** à préparer la lecture normale. Son entrée de validation
confirme un même protocole et hôte, mais un chemin différent. La vérification
précise du fichier reste requise ; aucune attribution certaine au fournisseur
ou au relais n'est tirée de ce refus.

Trois segments de cette dernière lecture contiennent du H.264 et de l'AAC-LC
stéréo 48 kHz, décodé sans erreur. La qualité à l'écoute n'est pas validée.

**Conclusion :** l'occupation indéfinie par polling passif et le mauvais
raccord d'identité sont corrigés et déployés. Le préchargement de Minnal est
prouvé deux fois, dont une avec la bonne clé. **Aucune lecture depuis ce cache
ni reprise rapide n'est validée dans ces nouveaux essais**, car la livraison
conservée est refusée ou change de chemin. La préparation normale fonctionne
mais reste variable et lente.

À la clôture, zéro session de lecture et zéro raw pump sur les deux Gateways,
Cloud/Playback sains, admissions de fond restaurées et worker de préfixes actif.
Une validation de fond est à nouveau admise normalement. La portée générale
reste active ; aucune route fournisseur ni budget n'est modifié.

## Preuves

Reçus sanitaires privés dans `.codex-artifacts/startup-cache-20261010/` :
`minnal-busy-drain.remote.py.safe.json`,
`minnal-background-drain.remote.py.safe.json`,
`minnal-storyboard-state.remote.py.safe.json`,
`busy-stage.safe.json`, `busy-apply.remote.py.safe.json`,
`minnal-post-cleanup.remote.py.safe.json`.

Préparation et présence : `minnal-idle-after-passive-poll.safe.json`,
`presence-route-no-renewal.safe.json`, `minnal-prefix-prepared.safe.json`,
`minnal-identity-prefix-control.remote.py.safe.json`,
`minnal-identity-progress.remote.py.safe.json`.

Déploiement et rejeux : `identity-stage.safe.json`,
`identity-apply.remote.py.safe.json`, `minnal-public-after-occupancy.safe.json`,
`minnal-zero-identity-server.safe.json`, `minnal-warm-identity-server.safe.json`,
`minnal-warm-identity-audio.safe.json`, `final-status.remote.py.safe.json`.
Les captures locales restent hors Git, avec les identifiants et accès privés.

## Suite — livraison renouvelée et reprise réelle, 11 octobre

### Défaut Norva et correction PR783

La première réponse fraîche était rejetée sur le seul changement de chemin
CDN, avant de comparer les quatre échantillons du fichier. Un chemin de
livraison transitoire était donc traité comme une identité permanente.

PR783 autorise la fin des quatre vérifications lorsque seul le chemin change
sur le même protocole, hôte et forme de requête. L'acquisition du cache exige
toujours la liaison privée exacte compte/source/révision/profil, la taille
exacte, les quatre plages et leurs empreintes identiques. TTL original de
dix minutes, révocation et plafonds mémoire restent inchangés. Il s'agit
toujours d'une preuve partielle récente, jamais d'une empreinte du fichier
entier. Les entrées à ETag fort restent liées à leur cible exacte.

Après un 509 confirmé d'une adresse conservée, le validateur peut fermer et
drainer cette connexion, puis ouvrir la source d'origine une seule fois sur
le même trajet et sous le même claim. Le budget total reste de huit secondes.
Les fixtures HTTP prouvent un seul lecteur amont actif, la fermeture avant
réouverture et le refus d'une plage modifiée malgré une nouvelle adresse.

**273 tests ciblés réussis, cinq contrôles optionnels existants ignorés.**
Contrats CI réussis sur `ecbe1f4195c1174cb5e7212e0adca876527715e1`, run
`38156195567`, job `114519570113`. PR783 fusionnée dans
`adc62611c5c92139bb6f403923e741823f6bd000`.

Canary isolé sain, tests du renouvellement réussis dans l'image et encodage
VAAPI validé. Déploiement des deux Gateways de **16:39:13 à 16:39:38 UTC**,
image `sha256:f7d41b741bbd1067152955d32bc685dd9d4747411ef6c75f5793a932d256f67d`.
Admissions de fond restaurées ; environnements, portée générale et budgets
conservés. Le redémarrage vide les caches mémoire : le premier rejeu est froid.

### Deux reprises publiques après PR783

Même copie TS de Minnal, depuis les boutons publics de la fiche, après fermeture
par Accueil. Les positions diffèrent des essais précédents.

| Rejeu | Position absolue demandée | Première progression depuis le clic | Cache réellement utilisé |
| --- | --- | --- | --- |
| Préparation froide après redémarrage | 336 s | 21,0 s | Non |
| Première reprise | 469 s | **5,4 s** | Quatre plages fraîches concordantes ; **8 Mio** d'entrée réinjectés ; 49 s de vidéo en réserve |
| Deuxième reprise | 723 s | **6,3 s** | Quatre plages fraîches concordantes ; **8 Mio** d'entrée réinjectés ; 49 s de vidéo en réserve |

Les deux reprises atteignent respectivement **256,7 et 208,5 s** sur leur
timeline locale, donc dépassent largement les fenêtres conservées et reçoivent
la continuation. Aucun arrêt ni erreur dans les échantillons relevés. Les
adresses conservées restent valides dans ces deux essais : la branche de
renouvellement de chemin n'y est pas encore éprouvée sur source réelle.

Les démarrages sont échantillonnés dès le clic, environ chaque seconde. Les
mesures sont ensuite réparties en fenêtres, avec des trous maximaux de
82 et 50 s ; aucune fluidité exhaustive n'est revendiquée durant ces trous.
Les compteurs d'images ne sont pas disponibles dans cette surface navigateur.

### Éviter la livraison périmée : PR784

PR783 sécurisait le renouvellement, mais essayait encore d'abord l'adresse
conservée. PR784 ouvre directement la source canonique pour une fenêtre HLS
autorisant le renouvellement de chemin. Les quatre échantillons suivants
restent lus sur la cible fraîche épinglée ; les en-têtes et cette cible sont
transmis à la continuation. Le parcours ancien, sans cette autorisation,
conserve sa vérification liée à la cible. La règle ne fait pas confiance à
une nouvelle URL : elle permet d'effectuer les preuves avant décision.

**274 tests ciblés réussis, cinq contrôles optionnels existants ignorés.**
Contrats CI réussis sur `850c16687c51e3d76c89cb1d26bee5f726abf4bd`, run
`38157334595`, job `114522909719`. PR784 fusionnée dans
`c64ccdff2919dd0daa3318171b06193fa025d18e`. Canary sain, tests du
renouvellement exécutés dans l'image et encodage VAAPI validé.

Les deux Gateways utilisent depuis **16:56:22–16:56:57 UTC** l'image
`sha256:bf01e53f69bafcf2a0d3f81d9dc0358e57948c69804b2c4878dff6a06abfc63d`.
Les environnements, budgets, trajets et portée générale sont conservés.
La restauration des admissions et les images de retour arrière sont vérifiées.

### Renouvellement réel du chemin : deux reprises publiques

Même copie MPEG-TS, avec fermeture par Accueil, réouverture par Films puis
Reprendre. Aucun historique ni bail n'est supprimé pour fabriquer un résultat.
Le premier démarrage après le second redémarrage est froid : **17,0 s**.

| Rejeu | Position absolue demandée | Première progression depuis le clic | Validation du cache |
| --- | --- | --- | --- |
| Première reprise après PR784 | 980 s | **9,3 s** | Chemin différent, taille identique, **4/4 empreintes concordantes**, 8 Mio réinjectés, fenêtre vidéo 49,0 s |
| Seconde reprise après PR784 | 1 411 s | **8,4 s** | Chemin différent, taille identique, **4/4 empreintes concordantes**, 8 Mio réinjectés, fenêtre vidéo 50,0 s |

Dans les deux cas, `sameTarget: false`, `accepted-path-renewal` et
`privateResumeWindowHit: true` attestent le changement réel et l'acquisition
du cache. `recentDeliveryTargetUsed: false` confirme le départ canonique.
Il n'y a pas de refus de livraison dans ces deux validations. Les vérifications
prennent **7,018 et 6,501 s**, comprises dans le délai annoncé depuis le clic.
Ce délai reste soumis à l'arrivée des quatre lectures réseau ; ce n'est pas
une reprise instantanée ni un résultat garanti sur toute livraison.

Les timelines locales atteignent **180,3 et 177,8 s**, soit plus de deux minutes
au-delà des fenêtres réutilisées. De nouvelles données sont reçues et la réserve
continue d'avancer. Aucune paire d'échantillons espacés de trois secondes au
maximum ne montre un arrêt de progression ; aucune erreur vidéo n'est relevée.
Les trous maximaux entre fenêtres de mesure sont respectivement **56,8 et
14,6 s** : aucune certification de chaque image ou absence de pause pendant
ces trous n'est revendiquée. Les compteurs de frames restent indisponibles.

Après la première reprise, le bouton public de recul de dix secondes est
contrôlé : lecture active à la position attendue au premier relevé, **0,693 s**
après la demande. Le saut avant est demandé ensuite, mais l'interruption de
collecte empêche d'en établir le délai : les mesures ne reprennent qu'environ
196 s plus tard. Elles montrent ensuite 35 s de progression sans erreur.
Ces sauts visent la vidéo déjà chargée ; ils ne prouvent pas une accélération
d'un saut hors cache.

Trois segments locaux de la première reprise contiennent du H.264 High et de
l'AAC-LC stéréo 48 kHz. Décodage audio sans erreur, sans nouvelle connexion
fournisseur pour ce contrôle. Cela ne remplace pas une validation à l'écoute.

### Conclusion et clôture

La livraison change réellement de chemin tout en conservant les quatre plages
échantillonnées. Le défaut Norva était de rejeter ce changement avant comparaison,
puis de privilégier une URL transitoire conservée. Ces deux défauts sont corrigés
en production générale. La cause interne des précédents 509 chez le fournisseur
ou le relais n'est pas établie ; le nouveau parcours évite ce détour sans changer
de route, d'IP ou de compte.

Les reprises depuis le cache réel sont démontrées. Un démarrage froid, une entrée
expirée ou un fichier dont les plages diffèrent reprend toujours le parcours
normal, sans promesse du même délai. La minute préparée à zéro n'a pas été
rééprouvée dans ces derniers rejeux à positions positives.

À la clôture : **zéro session et zéro raw pump sur les deux Gateways**, Cloud et
Playback sains, admissions normales (`enrichment_paused: false`), dispatcher non
arrêté, worker audio et worker de préfixes conservés. Aucun compte n'est retiré
du déploiement général. L'onglet créé pour les essais est fermé ; les onglets
de l'utilisateur restent ouverts.

### Preuves supplémentaires

Dans `.codex-artifacts/startup-cache-20261010/` :

- `delivery-stage.safe.json`, `delivery-apply.remote.py.safe.json`,
  `canonical-stage.safe.json`, `canonical-apply.remote.py.safe.json` ;
- `minnal-delivery-public.safe.json`, `minnal-delivery-final-analysis.safe.json` ;
- `minnal-delivery-resume1-server.safe.json`,
  `minnal-delivery-resume2-server.safe.json` ;
- `minnal-canonical-resume1-server.safe.json`,
  `minnal-canonical-resume2-server.safe.json` ;
- `minnal-canonical-resume1-audio.safe.json`, `final-status.remote.py.safe.json`.

Captures locales hors Git : `minnal-canonical-resume1.png` et
`minnal-canonical-resume2.png`. La seconde est prise en pause volontaire à la
fin de l'essai, après le contrôle de continuation.
