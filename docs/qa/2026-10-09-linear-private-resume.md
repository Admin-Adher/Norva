# Reprise privée après une lecture linéaire sans validateur

## Défaut établi

Le dernier contrôle de Severance S1E1 anglais (Strng) conservait environ 99 secondes de vidéo devant le lecteur, mais produisait zéro entrée réutilisable. PR745 avait supprimé l'exclusion systématique d'un producteur de cache complet abandonné. Le second refus, `unverified-input`, reste distinct : le chemin linéaire ne collecte pas les échantillons du broker de plages. Sa réponse sans validateur ne permet donc pas la revalidation privée existante.

## Correctif en validation

Le flux déjà ouvert observe passivement les octets transmis au décodeur : premier échantillon de 64 Kio et trois échantillons d'une fenêtre locale entièrement observée de 2 Mio. Une seule fenêtre de travail et quatre échantillons sont conservés. Aucun nouvel appel fournisseur pendant cette collecte.

Ces échantillons ne sont ni une réponse HTTP complète, ni des données source rejouables, ni une empreinte du fichier entier. Ils ne servent qu'au mécanisme privé existant, limité au pilote propriétaire : taille exacte, identité/source/génération/profil, cible, quatre plages fraîches concordantes à la reprise, dix minutes de validité. La réserve, les pistes et la couverture des sous-titres restent exigées.

Une fermeture volontaire attend le drainage avant transmission des preuves au cache. Coupure, timeout, trou, changement de taille/cible/route, second transport et révocation refusent la collecte. L'annulation ordinaire de la prélecture par le contrôleur de démarrage est distinguée d'une erreur réseau, même lorsque les deux contrôleurs se ferment successivement.

Le fichier incomplet n'est jamais publié dans le stockage partagé. Les octets source d'une réponse incomplète ne sont pas insérés dans le cache d'entrée. Le cache HLS conserve uniquement ses segments finalisés avec ses gardes existantes.

## Contrôles acquis

- 141 tests locaux réussis, un contrôle Linux ignoré sur Windows.
- Premier banc sans validateur : refus reproduit. La fixture de contrôle avait aussi omis un média synthétique requis ; ajoutée au paquet de preuve.
- Test complet Gateway/FFmpeg isolé sans réseau extérieur : variante forte et variante sans validateur conservent et revalident une fenêtre de 44 secondes. Zéro publication partielle, ancien ticket révoqué, maximum une connexion fournisseur.
- Un essai prolongé avec l'option FFmpeg `-xerror` signale un paquet de transport corrompu au raccord, également avec le validateur fort. Qualification du raccord prolongé en cours ; ne pas transformer ce résultat en garantie de fluidité.

## Limites à la création de ce rapport

Relecture réelle après correction et déploiement non réalisés. Aucun nouveau gain sur Severance ou Normal annoncé. Les cas qui ne possèdent pas une couverture HLS complète des pistes restent exclus ; cette collecte d'échantillons ne fabrique pas de sous-titres manquants.

## Suite du 9 octobre — premier déploiement et obstacle restant

PR747 (20d60c05686a7a48eb11da20357921e1ca1d02ca) est intégrée. Son code est déployé sur les deux Gateways, image `sha256:341e1fbd073bd4af634042228554c721118fa29cd1ecd73a90adcb87ae0635c9`, le 9 octobre à 17:24 UTC. Admission suspendue de 17:22:11.393719 à 17:24:56.167341 pendant le drainage ordinaire et le remplacement. Aucune lease forcée, aucun Edge remplacé ; crons, worker et dispatcher restaurés. 94 empreintes vérifiées, deux sources modifiées, 92 préservées. Pilote propriétaire inchangé.

Deux relectures réelles de Severance S1E1 anglais Strng ont confirmé la collecte de quatre échantillons après fermeture normale, mais toujours zéro entrée réutilisable. Le premier essai demande zéro au serveur ; sa télémétrie commence pourtant vers 13 secondes et le buffer présente un trou. Ce n'est pas une mesure certifiée de lecture depuis zéro. Clic à première image environ 6,9 secondes, clic à lecture environ 13 secondes, positions à traiter séparément.

La deuxième lecture révèle le refus suivant : environ 90 secondes de vidéo disponible, mais seulement 31,928 secondes cumulées dans les durées EXTINF des sous-titres, dont les répliques sont espacées. Le cache ne certifie pas la couverture commune. La dernière réplique ne prouve pas l'exhaustivité des sous-titres ; cette garde reste inchangée. Le code `unverified-input` appartient au dernier repli tenté, il ne décrit pas toute la chaîne des refus.

### Repli privé vers les octets observés — deuxième correctif

Pour les lectures avec sous-titres exacts ou plusieurs pistes audio, la collecte conserve maintenant les huit premiers Mio et la dernière fenêtre complète de deux Mio déjà livrés au décodeur. Le suffixe local incomplet est exclu. Ces intervalles sont privés ; ils ne constituent ni une réponse HTTP complète, ni une copie entière publiable. La reprise relit quatre plages fraîches et vérifie les mêmes identités, profil, génération, taille, route et cible, avec le TTL existant. Une rupture réseau invalide tous les intervalles, même si la lecture reprend ensuite. La fermeture volontaire doit être drainée avant transmission au cache.

Le repli réutilise le décodeur ordinaire avec toutes les pistes lorsque le graphe HLS ne peut être certifié. Aucune nouvelle requête fournisseur pour collecter ces octets ; mémoire supplémentaire bornée à dix Mio conservés plus deux Mio de travail par session concernée. Le stockage privé garde ses budgets existants. Aucune publication partielle partagée ni extension du pilote.

Banc Gateway/FFmpeg isolé, réseau extérieur absent : 211 tests réussis, un ignoré. Scénarios validateur fort et absent : fenêtre HLS réutilisée ; scénario sans validateur avec sous-titres espacés : HLS refusé, entrée privée conservée puis réellement réutilisée, première et future répliques retrouvées après lecture jusqu'à EOF. Ancien accès révoqué, maximum une connexion source. Un premier contrôle cherchait la réplique de 65 secondes après seulement 55 secondes décodées ; l'assertion a été corrigée pour aller jusqu'à EOF. Cette preuve ne certifie pas leur publication progressive avant EOF.

Les contrôles audio de 55 secondes neutralisent les timestamps du sink PCM pour distinguer erreurs de décodage et horloges ; ils ne prouvent pas la continuité sonore. Les tests navigateur précédents traversaient le cache, mais avaient des intervalles de frames d'environ 1,08 à 1,29 seconde. Aucun gel nul, écoute parfaite ou nouveau gain réel n'est annoncé.

Le deuxième correctif reste à déployer et à relire sur la copie réelle. Reçus locaux : `.codex-artifacts/linear-private-resume-20261009/`, notamment `input-eof-subtitles.safe.json`, `coverage-running.safe.json`, `coverage-later.safe.json`, `second-closed.safe.json`.
