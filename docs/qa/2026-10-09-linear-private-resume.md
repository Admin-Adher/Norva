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
