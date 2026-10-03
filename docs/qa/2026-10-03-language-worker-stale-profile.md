# Reprise des analyses vocales bloquées par un ancien profil

## Constat du 3 octobre 2026

Le contrôle des métadonnées avance, mais plusieurs analyses strictes ne reprennent pas malgré une échéance dépassée. À 20:17 UTC, le premier candidat du répartiteur est un travail automatique inchangé depuis 10:50 UTC. Son profil diffère du profil exact observé en cache. Le contrôle `guard_catalog_validation_observed_profile` rejette son passage à `running` avec PT409 ; l'erreur annule la transaction sans retirer le travail de la tête de file.

Les autres candidats comprennent une capture Selection valide, un travail MAX OTT et un finaliseur Dino dont le bail a expiré à 19:16. Le répartiteur normal en prend deux. Un candidat obsolète consomme ainsi une place à chaque minute sans avancer. Les tâches cron s'exécutent et les Gateways sont sains : il ne s'agit pas d'un arrêt du service.

## Correction

La migration `20261003202000_retire_obsolete_language_worker_claims.sql` ajoute une clôture ciblée à l'admission du travail. Après les contrôles de terminalité, d'échéance et de bail actif, un travail obsolète sans bail vivant devient `failed / PROFILE_CHANGED`. Ses preuves, positions et compteurs sont conservés. Les tables de cache, certificats et langues ne sont pas modifiées.

Les travaux actifs, renouvellements de baux, reports futurs, quarantaines et cas sans observation contradictoire restent protégés. Le déclencheur de contrôle du profil reste actif pour les courses concurrentes. Le parcours normal conserve ses limites de capacité et ses contrôles d'identité, de propriétaire et de fichier.

## Preuves avant/après

- Copie fraîche du schéma de production dans un PostgreSQL **sans réseau et sans données utilisateur**.
- Échec d'origine PT409 reproduit avec le vrai mécanisme d'admission et le vrai déclencheur.
- **23 contrôles SQL réussis** après correction : différences de signature, date, description du profil et taille ; bail actif, report futur, quarantaine ; finaliseur expiré et preuves conservées ; état de file ; capacité ; travail valide ; cache inchangé ; contrôle PT409 toujours appliqué ; accès privé à la fonction.
- Les jeux synthétiques sont annulés par transaction. Aucun média fournisseur ni modèle vocal n'est appelé par ces tests.

## Déploiement et suivi

Code : PR 609, commit `a80a469ad`. Le contrôle de référence compare la fonction complète avant publication et vérifie la définition attendue dans la même transaction. Aucune purge ou relance de travail n'est nécessaire ; le prochain passage du worker retire naturellement les travaux devenus obsolètes.

Déploiement confirmé dans la base partagée à **20:28:46 UTC**, sans redémarrage. La définition déployée a pour SHA-256 `8064e236b5325f5b121cfb92389ede46cfe633531bcf490813086cb98fea085b` ; elle correspond exactement au candidat testé. La définition précédente et le reçu sont conservés dans le répertoire privé de déploiement. Les deux routes Edge utilisent cette base.

À **20:34:08 UTC**, deux anciens travaux ont été clôturés automatiquement avec `PROFILE_CHANGED` dans la file globale. Ils ne sont pas comptés comme des médias sondés ni des langues identifiées. Le candidat resté inchangé depuis 10:50 a disparu de la liste due. Celui de 10:52, dont le profil reste valide, a reçu une nouvelle tentative à 20:30, puis un report explicite `PROVIDER_ACCOUNT_BUSY` ; il ne bloque plus silencieusement la tête de file.

Deux variantes de la cohorte ont enregistré une **nouvelle progression fournisseur après le déploiement**, la plus récente à 20:33:19. Aucun travail de cette cohorte n'est encore passé à `verified` dans cette courte fenêtre après publication. À 20:32, le total depuis le début de campagne est huit vérifications strictes terminées avec toutes les preuves de pistes attendues : Strng 1, Selection 2, Dino 2, MAX OTT 3. Le finaliseur Dino a réussi à **20:22, avant ce correctif** ; sa réussite ne doit donc pas être attribuée à cette modification.

Santé à 20:33 : deux Gateways HTTP 200, zéro erreur HTTP du dispatcher depuis 18:01:46, zéro diagnostic d'expiration SQL depuis la recréation des Edge à 19:23, admissions ouvertes, cron strict actif, marqueur STOP absent. Les limites réseau restent à deux travaux ; les reports fournisseur restent respectés. Le conteneur PostgreSQL de preuve a été arrêté après les tests.

Les douze contrôles GitHub du commit `a80a469ad` ont réussi, dont contrats cloud, types Edge, base jetable et compilations/tests Android. La suite « base jetable » ne rejoue pas cette nouvelle migration ; les **23 contrôles sur copie fraîche du schéma** constituent sa preuve SQL spécifique.

La reprise est donc observée, mais ce correctif ne certifie ni un débit vocal soutenu ni la clôture de toute la campagne. Il ne justifie pas une nouvelle tentative aveugle des analyses déjà inconclusives ou mises en quarantaine. Preuves agrégées avant/après : `2026-10-03-language-campaign-heartbeat-2012.json`.

## Confirmation à 21:12 UTC

La PR 609 est intégrée dans `be86445f99e7ae16be9bb107622bbf478fe545a4`. Le contrôle suivant compte dix variantes ayant progressé auprès du fournisseur après déploiement, dont **une nouvelle validation réussie Dino à 21:05:51**. Le total de travaux stricts vérifiés de la cohorte passe à neuf. Quatre travaux ont également atteint un consensus indéterminé après publication ; ces résultats ne sont pas présentés comme des identifications réussies.

La liste des candidats progresse et ne contient plus l'ancien travail obsolète de 10:50. Les reports normaux de capacité et d'occupation fournisseur restent présents. Le dispatcher et les deux Gateways sont sains, sans nouvelle expiration SQL détectée. Aucune nouvelle modification du fonctionnement de production lors de ce contrôle. Preuve : `2026-10-03-language-campaign-heartbeat-2112.json`.
