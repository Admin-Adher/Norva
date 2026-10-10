# Préchargement privé de la première minute

## Demande et périmètre

Implémenter sur le pilote une préparation des 60 premières secondes lorsque le
compte fournisseur est libre, avec priorité à toute lecture utilisateur.
Extension du Gateway et du cache de reprise déployés ; aucun AVPlayer/libmedia,
aucune interface ou application native modifiée.

## Code

- Entrée opérateur Edge authentifiée, coordonnées du catalogue uniquement.
- Résolution hors réseau de fichiers Xtream détenus, profil exact complet et
  revalidation de visibilité, génération, révision et droits.
- Présence/activité récente bloque la préparation ; deux verrous distribués
  existants protègent le compte et la sonde fournisseur.
- Même parcours FFmpeg que la lecture ordinaire, budget de 110 secondes,
  contrôle toutes les deux secondes, une préparation au maximum.
- Préemption utilisateur raccordée aux deux routes de drainage existantes.
  Exclusion conservée si fermeture non confirmée.
- Préfixe séparé de la reprise, dans son budget mémoire actuel ; aucune éviction
  d'une reprise pour réserver de la mémoire au travail de fond.
- 60 secondes finalisées depuis zéro, identité et sous-titres vérifiés. Un fichier
  partiel n'est jamais publié comme un film terminé. TTL et revalidation existants.
- Runner serialisé sur une file privée de huit fichiers maximum, refresh borné,
  arrêt propre et journaux sans identifiants ni accès fournisseur.

## Validation locale

28 tests dédiés au préfixe, admission Edge et runner réussis. La suite ciblée
inclut aussi le cache de reprise, les sous-titres, l'annulation des préparations
et les règles de préemption existantes. Les contrôles de syntaxe passent.

Une première suite locale globale sans dépendances a échoué pour modules absents.
Les dépendances ont ensuite été installées sans scripts d'installation. Trois
harnesses de la suite globale nécessitaient le nouveau coordinateur lors de
l'extraction des routes : corrigés, leurs six essais réussissent.
La validation globale CI reste à confirmer.

## Essais réels, canary isolé

Les essais utilisent l'entrée opérateur Edge complète, la base actuelle et des
copies réelles du catalogue. Gateway et Edge temporaires privés, mêmes moteurs
et paramètres de production ; aucun routage utilisateur modifié.

- **Vice-versa 2** : profil `gateway_inband` avec inventaire incomplet
  (`metadataComplete=false`) ; préparation refusée avant connexion fournisseur.
- **Conclave** : une synchronisation du catalogue récente reporte la préparation.
  Aucun événement de lecture récent, aucune session utilisateur active. Ce signal
  d'activité ne signifie pas que l'utilisateur regarde un film.
- **Abduct** : tentative clôturée en 57,3 s, capture refusée
  (`asset-unavailable-or-budget`). Pompes, encodeurs, sessions et réservations
  mémoire à zéro après clôture. Le motif doit être précisé avant activation.

Les traces privées et les réponses agrégées sont dans
`.codex-artifacts/startup-cache-20261010/`, hors Git. Aucun accès fournisseur
ni identifiant de compte n'est inclus dans ce rapport.

## État et critères d'activation

**Non activé en production. Aucun gain de démarrage réel annoncé.**
Avant activation : réussite de la CI, capture réelle d'un préfixe, revalidation
et consommation depuis zéro, réception au-delà du raccord, pistes et sous-titres
préservés, puis interruption d'un travail de fond par une lecture réelle avec
preuve de fermeture de la connexion précédente.

Le pilote ne précharge pas tout le catalogue. Le budget mémoire et les TTL
existants imposent une sélection bornée. Une source durablement trop lente
épuisera le préfixe ; cette préparation ne multiplie pas son débit réseau.

Runbook : `ops/hetzner/media/startup-cache.md`.
