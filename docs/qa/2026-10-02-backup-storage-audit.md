# Audit du volume des sauvegardes Norva — 2 octobre 2026

Audit en lecture seule, terminé vers 09 h 45 Europe/Paris. Aucun objet, aucune base, aucune rétention ni aucun job modifiés. Pas de nouvelle restauration complète pendant cet audit.

## Résultat

Cloudflare affiche **403,34 GB** pour `norva-db-backups`. La base principale Hetzner mesure **46 856 809 619 octets**, soit 46,86 Go / 43,64 Gio. Ce bucket contient plusieurs points de restauration et leurs journaux, pas une seule copie de la base.

| Contenu | Volume observé | Preuve et rôle |
|---|---:|---|
| `selfhost/wal/` | 239,58 Gio ≈ **257,25 Go**, 15 337 objets | Inventaire rclone du watchdog à 06:41 UTC ; journaux de restauration à un instant donné |
| `selfhost/base/` | ≈ **50,86 Go** | Liste Cloudflare exhaustive : trois fichiers compressés, 15,71 + 15,77 + 19,38 GB |
| `selfhost/dumps/` | ≈ **75,55 Go** | Liste Cloudflare : quatorze archives chiffrées quotidiennes, du 19 septembre au 2 octobre |
| `db/` | ≈ **18,93 Go** | Quatre archives supplémentaires des 20–23 septembre, 4,49 + 4,75 + 4,77 + 4,92 GB |

Les sommes sont issues de tailles arrondies affichées et de relevés à des heures différentes. Leur total (≈402,59 Go) n'est pas un inventaire atomique au byte près du total Cloudflare. Ne pas interpréter la différence de ≈0,75 Go comme des fichiers parasites identifiés. Les 15 337 objets WAL n'ont pas été parcourus individuellement par le navigateur ; leur agrégat vient du contrôle serveur R2.

## Pourquoi autant de journaux

Le volume WAL R2 est passé de **43,81 Gio le 29 septembre à 06:41 UTC** à **239,58 Gio le 2 octobre à 06:41 UTC**, soit +195,77 Gio nets après les purges.

Le watchdog a mesuré des débits extrapolés de 225,73 puis 218,49 Gio/jour sur ses deux fenêtres de six heures précédant le contrôle du 2 octobre. Ces chiffres ne sont pas des volumes journaliers complets. Une mesure courte ultérieure, de 446 secondes, donnait 41,91 Mio, soit 7,93 Gio/jour extrapolés : elle ne prouve pas que le problème est durablement résolu.

Le script déployé `wal-sync.sh` copie les segments bruts vers R2. Chaque segment observé fait 16 777 216 octets. `wal_compression=zstd` et `checkpoint_timeout=30min` sont déjà configurés ; la compression PostgreSQL ne signifie pas que les objets archivés sont des fichiers gzip.

Test en mémoire, sans modifier les fichiers, sur trois segments locaux achevés : gzip niveau 1 donne respectivement 13 714 102, 14 879 752 et 15 262 472 octets, soit 18,3 %, 11,3 % et 9,0 % de réduction. Cet échantillon ne permet pas de prévoir le gain sur tout R2. Modifier le format d'archivage exigerait un parcours de restauration adapté et testé.

Les statistiques cumulées `pg_stat_statements` montrent d'importantes écritures de construction/réconciliation/enrichissement des catalogues. Elles ne permettent pas, seules, d'attribuer avec certitude le pic des dernières heures à une requête précise. Une attribution temporelle supplémentaire est nécessaire avant de modifier ces traitements.

## Rétention effective

- Trois sauvegardes physiques présentes : `base-20260930-041651`, `base-20261001-041850`, `base-20261002-041657`. Les journaux confirment le mode **streamé**, sans staging complet local. Le nom `basebackup-weekly.sh` est trompeur : l'exécution est quotidienne.
- Le journal du 2 octobre annonce la suppression de celle du 29 septembre ; elle est absente de la liste Cloudflare. L'avertissement `GetBucketVersioning 403` ne prouve donc pas un échec de cette suppression.
- Quatorze dumps logiques présents, conformément aux quatorze jours annoncés.
- Purge WAL du 2 octobre réussie à 02:26:29 UTC, seuil trois jours. Premier segment visible téléversé le 29 septembre à 02:30:19 UTC, cohérent avec ce seuil au moment de la purge. Une purge quotidienne laisse normalement vieillir certains objets au-delà de 72 heures avant son passage suivant.
- Cloudflare : seule règle de cycle de vie visible, **abandon des envois multipart incomplets après sept jours**. Aucune expiration indépendante des objets complets ; leur purge dépend des scripts. Aucun verrouillage de bucket. Accès public désactivé.

Ne pas supprimer les WAL récents arbitrairement : ils complètent les sauvegardes physiques. Une chaîne de restauration peut être rompue même si les fichiers de sauvegarde complète restent présents.

## Redondance confirmée et documentation obsolète

`ops/hetzner/backup/BACKUPS.md` décrit `db/` comme figé avant la migration de juillet et son ancien workflow comme supprimé. **Ce constat n'est plus vrai.**

Le workflow actuel `.github/workflows/backup-db-to-r2.yml` est programmé quotidiennement et appelle sur Hetzner `ops/hetzner/scripts/19-backup-db-to-r2.sh`. Il sauvegarde la même base `postgres` dans `db/`, en parallèle du nightly principal dans `selfhost/dumps/`.

L'API GitHub confirme les succès des 20–23 septembre, puis **huit échecs programmés consécutifs du 24 septembre au 1er octobre**. Dernier run : https://github.com/Admin-Adher/Norva/actions/runs/36847560649 . Le job commence à 10:11:36 UTC, atteint la compression à 10:14:55, puis échoue à 10:21:38 avec `Run Command Timeout`. L'envoi n'est pas atteint. La rétention de trois jours de ce script n'est exécutée qu'après l'envoi : les quatre anciens objets restent donc stockés.

Ces **18,93 Go** sont une sauvegarde logique supplémentaire de la même base, à des instants différents, et non des doublons binaires certifiés. Leur périmètre est moins complet que le nightly principal : le script ne sauvegarde pas les données `auth`/`storage` et exclut les ACL du dump de schéma. Candidat prioritaire à une rationalisation après validation du plan de restauration principal. Aucun objet supprimé ici.

## Données QA et poids de la base

La sauvegarde physique englobe le cluster, donc aussi cinq bases QA :

| Base | Octets |
|---|---:|
| `norva_selection_shared_qa_20261001` | 280 554 643 |
| `norva_language_remediation_test_20260913` | 60 547 599 |
| `norva_lang_learning_qa_20260910_v1` | 10 920 463 |
| `norva_lang_qa_20260910_v1` | 8 233 487 |
| `norva_ops_alert_qa_20261002` | 7 883 923 |

Total **368 140 115 octets**, moins de 0,8 % de la base principale avant compression. Leur existence n'explique pas les 403 Go. Aucune suppression sans vérifier leurs dépendances et la conservation des preuves QA.

Relations importantes, index et TOAST inclus : media_items ≈9,49 Go, titles ≈8,82 Go, variants ≈6,46 Go, snapshots des propriétaires ≈5,56 Go, catalog_titles ≈3,70 Go, projections de générations ≈2,82 Go. Les instantanés et projections sont utilisés par le code applicatif ; leur nom ne suffit pas à les déclarer jetables.

`pgstattuple_approx`, lecture bornée à 25 secondes par table, a mesuré pour les heaps principaux :

| Table | Tuples morts | Espace libre approximatif |
|---|---:|---:|
| cloud_titles | 0,505 % | 18,72 % |
| cloud_media_items | 0,104 % | 10,62 % |
| cloud_title_variants | 0,042 % | 10,50 % |

Cela ne mesure pas tous les index/TOAST et ne permet pas de conclure « aucun bloat ». Le reindex automatique du 1er octobre a déjà récupéré **1 261 068 288 octets** sur dix index. Pas de preuve justifiant une reconstruction massive immédiate.

## Fiabilité : autre défaut découvert

Le nightly du 1er octobre a enregistré un timeout de connexion pendant l'étape « reference exports (crons as replayable SQL, extensions) », puis a terminé avec succès. Les commandes auxiliaires sont tolérantes aux erreurs (`|| true`). Le journal ne permet pas d'identifier lequel des exports est incomplet. La présence et la taille vérifiée de l'archive ne certifient donc pas la complétude de cet export auxiliaire.

Les dumps principaux ne sont pas déclarés corrompus sur cette seule base. Il faut rendre obligatoires les exports nécessaires à une restauration, contrôler leur contenu, puis rejouer une restauration isolée. La documentation rapporte un exercice réussi le 21 août avec `pg_verifybackup`; il n'a pas été rejoué aujourd'hui sur ces nouveaux objets.

## Priorités proposées

1. Consolider un seul pipeline logique complet, traiter le workflow redondant et ses 18,93 Go, mettre la documentation en cohérence. Ne pas simplement augmenter son timeout pour recréer deux backups quotidiens.
2. Attribuer les pics WAL à des deltas de requêtes/jobs sur une même fenêtre ; corriger les écritures répétées réellement identifiées. Conserver la chaîne PITR.
3. Faire échouer clairement une sauvegarde dont un export indispensable manque ; valider une restauration récente avant tout nettoyage.
4. Évaluer ensuite la cible pgBackRest déjà décrite dans BACKUPS.md (compression, incrémentaux, rétention intégrée), avec test de restauration. Aucun gain chiffré global garanti sur l'échantillon actuel.

**Conclusion :** le volume est principalement expliqué par les journaux de restauration récents. Une redondance d'environ 19 Go et des défauts de maintenance/documentation sont confirmés. L'audit n'établit pas que les 257 Go de WAL soient supprimables ni que toutes les écritures qui les ont produits soient nécessaires.
