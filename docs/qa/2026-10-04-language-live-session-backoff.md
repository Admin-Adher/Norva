# Campagne audio : temporisation pendant une lecture

## Contrôle à 08:34 Paris (06:34 UTC)

La cohorte reste intégralement visible : **14 473 versions distinctes contrôlées**,
**5 165 identifiées**, **51 586 encore inconnues**. Le contrôle global successif
compte 51 581 variantes / 40 082 fiches inconnues. Le gain utilise les sommes
par source, sans assimiler ces requêtes successives à une photographie atomique.

Depuis 05:20:36 UTC : **+1 516 contrôles en 73 min 59 s**, environ **1 229
contrôles techniques/h**, et **+420 identifications**. Ce débit ne mesure pas
la reconnaissance vocale et ne prédit pas sa date de clôture.

L'audit strict compte **27 validations réussies** avec preuve complète, inchangé,
et **60 analyses complètes indéterminées** rattachées au profil courant (+7
depuis 05:20, +3 depuis 05:50). Aucun de ces résultats n'est relancé. Les trois
nouvelles clôtures indéterminées depuis 05:50 concernent Selection (deux) et
Dino (une). Aucune nouvelle validation réussie ne prouve encore la finalisation
SQL complète après le correctif de sélection des destinataires de 05:45.

Les captures ont repris après ce correctif : sept travaux des quatre sources
ont une progression fournisseur ultérieure. Cette requête porte sur les sources
contrôlées, pas seulement sur le manifeste ; elle n'augmente donc pas le
compteur de versions distinctes de la cohorte. Aucun nouveau diagnostic SQL de
finalisation depuis les deux erreurs 57014 de 05:11 ; l'historique demeure.

## Défaut de relance confirmé

Entre 05:45:39 et 06:38:52, **472 réponses `live-session`**, toutes avec zéro
tentative fournisseur, sont enregistrées : Dino 136, MAX OTT 183, Selection 5,
Strng 148. Les intervalles médians sont proches de trois secondes pour les
trois grands catalogues. Il s'agit de demandes d'admission inutiles, pas de
sondes supplémentaires.

`recordResult` bloquait bien les deux voies pour une lecture active, mais
`delayFor` ne reconnaissait pas le code `live-session`. Une réponse réelle
`processed=1, attempted=0, deferred=1` tombait dans le délai de succès de
**1 500 ms**, au lieu des **180 000 ms** utilisés pour une occupation fournisseur.
L'ancien test omettait `processed`, donc ne reproduisait pas le cas de production.

Correction limitée : ajouter `live-session` aux causes de temporisation de trois
minutes. Aucun appel de lecture, garde SQL, bail, seuil, quarantaine, compteur
ou parallélisme n'est modifié. Les autres catalogues continuent d'être éligibles.

## Vérification et déploiement

- Régression reproduite avant correction avec la réponse complète observée.
- **21 tests réussis** : dispatcher et lots de métadonnées. Le nouveau cas
  couvre les champs `skipped`/`code`, les deux voies, leur indisponibilité avant
  échéance, la reprise après échéance et la progression d'une autre source.
- Déploiement terminé à **06:38:47 UTC**. L'arrêt gracieux avait commencé à
  06:38:20 ; le dispatcher a terminé sa requête puis quitté avec code zéro.
  Aucun appel en vol ne restait à son arrêt. Les compteurs sont conservés.
- Seul le dispatcher est redémarré ; les deux Gateways, les Edge et le cron
  strict restent en fonctionnement. Programme précédent et état conservés
  dans une sauvegarde privée horodatée.
- SHA-256 du programme lu dans le conteneur après reprise :
  `63cec784a790e3c60e676dd50b68ad6889054c454cdc61b9f05c70584efc82d1`.

À 06:35, les Gateways sont sains, capacité deux/deux, admission et cron actifs,
STOP absent. L'ancien finaliseur Strng conserve son report au 5 octobre
02:22:08 UTC et ses huit tentatives. Un travail MAX OTT sans capture a un bail
expiré depuis 06:27 ; sa reprise naturelle doit être suivie, sans forcer ce bail.

La campagne reste **en cours**. Le nombre de lots `processed>0` dans l'ancien
rapport de santé inclut les reports : il ne constitue pas un débit de sondes.
Preuves : `2026-10-04-language-campaign-heartbeat-0834.json`.

## Contrôle après reprise

À **06:41:33 UTC**, dispatcher sain, huit nouveaux événements dont cinq lots
avec tentatives, aucun échec HTTP. Une capture stricte Selection a progressé à
06:41:15. Les Gateways restent sains. Aucun nouveau report `live-session` dans
cette courte fenêtre : le délai est couvert par la régression reproduite, mais
son application au prochain report réel reste à observer. Il n'est pas affirmé
que l'absence de reports après fermeture du lecteur soit un effet du correctif.
Un bail expiré de capture Strng et celui de MAX OTT restent en attente du
sélecteur normal ; aucun n'est forcé. Le finaliseur Strng ancien conserve son
délai jusqu'au 5 octobre.
