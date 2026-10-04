# Titres fournisseur, synopsis et doublon Lost

Contrôle du 4 octobre 2026, heures UTC. Périmètre : les cartes signalées dans le compte contrôlé, et correctif générique des réponses catalogue. Ce rapport ne certifie pas la complétude éditoriale de tous les catalogues.

## Résultat vérifié

- Le navigateur Codex affichait deux cartes **Lost on a Mountain in Maine**, avec 4 et 11 versions.
- Après le correctif serveur de 14:46, une seule carte affiche **15 versions**, année 2024. La fiche affiche son synopsis français et les quinze choix de fichiers. Le choix anglais MAX OTT précédemment utilisé est conservé ; aucun nouveau démarrage vidéo n'a été déclenché pendant ce contrôle.
- Les fiches **Long Lost** et **Lost in Mobius** affichent aussi leurs synopsis. Long Lost est en français. Mobius dispose d'un synopsis de secours anglais, aucune traduction française n'étant fournie dans les détails TMDB vérifiés.
- Les préfixes compacts `EN|`, `IR|`, `AR|` sont retirés de l'affichage. Le complément prend également en charge `IN| TAMIL|` sans transformer les mots réels comme `THOR | Love and Thunder`.

## Cause du doublon et correction

Quatre projections actives du même fournisseur possèdent la même identité TMDB 1197619 et la même génération. Leur association exacte avec chaque fichier existe déjà. Cependant, le second raccordement du serveur cherchait à nouveau par identité TMDB et génération : plusieurs candidats rendaient ce raccordement ambigu. Le serveur omettait alors année et synopsis, tandis que la grille formait un groupe sans année et un autre groupe daté.

Le raccordement conserve maintenant sa preuve exacte **propriétaire → fichier → variante visible → titre actif** hors du JSON public, et la réutilise. L'identité éditoriale validée est exposée dans les champs publics déjà autorisés. Les gardes de visibilité, de génération et de propriétaire restent appliquées ; aucun rapprochement flou de titres ou suppression de variante n'a été ajouté.

| Contrôle réel | Avant | Canary | Edge 1 | Edge 2 |
| --- | ---: | ---: | ---: | ---: |
| Versions Lost renvoyées pour la recherche affichée | 15 | 15 | 15 | 15 |
| Sans année | 4 | 0 | 0 | 0 |
| Sans synopsis | 4 | 0 | 0 | 0 |
| Identité éditoriale publique attendue | 0 | 15 | 15 | 15 |
| Durée de la réponse | 553 ms | 894 ms | 820 ms | 876 ms |

Ces temps sont des mesures ponctuelles, pas un benchmark de charge. La comparaison des coordonnées de fichiers, liens de lecture et langues est identique avant/après. Reçu : `2026-10-04-flat-movie-duplicate-proof.json`.

## Métadonnées et titres

Six projections auparavant `provider_unverified` ont été revérifiées avec le moteur de correspondance existant. Les six correspondent par affiche exacte (`poster_path_confirmed`, confiance 0,923) : trois Lost Maine, deux Lost in Mobius et une Long Lost. Le résultat a été écrit à 14:23:38 par le RPC existant avec contrôle de propriétaire, époque de visibilité, génération et date du payload. Une preuve transactionnelle a été annulée volontairement avant application ; la première tentative de preuve avait rencontré le délai de verrou de deux secondes, sans forcer le verrou.

Les titres bruts et les coordonnées de fichiers sont conservés. Les informations TMDB ne deviennent jamais une preuve de langue audio. Reçu détaillé : `2026-10-04-compact-provider-titles.json`.

## Versions et vérifications

- PR 628 : code `3db74fcc8ec1880761607173429f334e6f2847ba`, manifeste d'assets corrigé dans `5d70a2cbbdaeb4f56ee7304d577a2b4faa6fa6af`, fusion `f2749bb5b311de8bf0ced622064dbd17afdfb077`. Déploiement Cloudflare `37209340300` réussi. Deux helpers Edge déployés à 14:25.
- PR 629 : nettoyage imbriqué `1fc727d0b`, raccordement exact et preuve Android `f7732a8f33bcb45cf7e0cbed705364596a7d9794`. Les trois fichiers Edge sont déployés sur les deux répliques à 14:46 ; hashes dans le reçu.
- Régression reproduite contre le code antérieur : le titre reste `Provider B raw` avec plusieurs projections du même film. Après correction, les 25 tests ciblés de contrat public, propriété éditoriale, préfixes et politique de recherche réussissent.
- Émulateurs Android du code final : workflow `37210333416`, six tâches réussies. Téléphone : gestes/trois boutons, polices 1,0/1,3, WebView de production avec préfixes imbriqués et regroupement de quinze versions sans changer les langues/identifiants. TV : test D-pad existant à 1,0/1,3. Aucun téléphone physique détecté lors de ces contrôles ; aucun rejeu natif vidéo revendiqué.
- La matrice automatique complète `37210315089` a été annulée au profit de cette matrice ciblée. Sur le premier correctif, un émulateur hors ligne avant zéro test avait nécessité une reprise réussie. Le premier pipeline avait aussi relevé un manifeste d'assets périmé, corrigé avant intégration.
- Le lancement local beaucoup plus large a rencontré des erreurs de temporisation, d'outillage Bash/archives sous Windows ; il n'est pas présenté comme réussi. Les contrats CI Linux du code final ont réussi.
- Vérification de l'interface par arbre d'accessibilité réel : une carte, bouton quinze versions, synopsis et choix des fichiers. La capture d'écran du navigateur a échoué deux fois ; aucune capture après correction n'est jointe comme preuve visuelle.

## Exploitation et limites

Les nouvelles admissions ont été suspendues du 14:46:05,506 au 14:46:13,783 pour remplacer successivement les Edge, puis restaurées. Aucun bail, délai ni compteur n'a été forcé. Canary arrêté, dispatcher global permanent actif, STOP absent, cron actif, deux Gateways HTTP 200 / ok après déploiement. Aucun appel média fournisseur pour ces corrections éditoriales.

Les saccades des copies MULTI-SUB restent une investigation distincte : l'autre copie anglaise fluide est une alternative validée par l'utilisateur, pas la réparation des copies corrompues. Les langues encore indéterminées restent indéterminées ; aucune langue n'a été inventée dans cette correction. Les deux entrées de reprise de Lost correspondent aux fichiers précédemment joués et n'ont pas été fusionnées ni effacées.
