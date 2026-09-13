# Rafraîchissement ponctuel du fichier Cruella audité

## Périmètre et statut

Procédure préparée, non exécutée en production. Les tests dédiés sont hors ligne : ils vérifient le contrôleur, les refus et la structure SQL, pas l'exécution réelle des triggers PostgreSQL. Le `dry-run` transactionnel ci-dessous reste obligatoire sur la base cible après autorisation.

Un seul fichier Selection peut recevoir `metadata.selectionFilenameAudio = {"version":1,"language":"es","urlSha256":"…"}`. Il s'agit d'une **déclaration issue du nom de fichier**, et non d'une langue audio écoutée, détectée ou vérifiée. L'empreinte lie la déclaration à l'URL importée ; elle ne constitue pas une empreinte du contenu vidéo.

| Identité figée | Valeur |
| --- | --- |
| Variante | `313ced4c-4f62-4330-bbe9-06dbf0882170` |
| Selection ID | `d8a0c11afb0d9c3fab417c01ffd31068f44abdb0e3ef5807db29e632bcc22968` |
| External ID | `norva-selection:movie:d8a0c11afb0d9c3fab417c01ffd31068f44abdb0e3ef5807db29e632bcc22968` |
| SHA-256 de l'URL | `6a36cde59f6925d16ba1db2f4f30f9ab8edb747ec9cdc1014601f8508e14d522` |
| Feed | `klysmgt-tested-vod` |
| Révision du manifeste | `selection-vod-20260906-v1` |
| Déclaration | `es` — Espagnol, suffixe explicite `.Latino.` |

Le manifeste audité utilise un réemballage terminal `.mkv.mp4 at Streamtape.com.mp4`. Le parseur partagé accepte ce cas borné tout en refusant les noms de pages `CastellanoLatinoSubtitulada` et les marqueurs contradictoires. La comparaison hors ligne des 2 316 entrées des manifestes change uniquement ce fichier.

Le synchroniseur `norva-source-sync` recalcule bien ce champ lors d'un import, mais son action est au niveau **source entière**. Il n'expose pas de rafraîchissement de métadonnée par variante. L'opérateur ponctuel reprend donc le protocole de la migration `20260909203657_selection_filename_audio_declarations.sql`, sans relancer une source entière.

## Contrat d'écriture et prérequis

- Déployer et vérifier les correctifs de parseur et de résolution des langues autorisés, ainsi que la relation `cloud_catalog_unidentified_audio_variants`. La simple présence du nouveau code Git n'est pas une preuve de déploiement.
- Utiliser le script revu `ops/hetzner/scripts/refresh-audited-selection-filename-language-20260913.py` sur l'hôte Linux autorisé. Son transport existant est `docker exec … psql -U postgres -d postgres` dans le conteneur explicitement vérifié ; il ne charge aucun fichier de secrets et ne contacte aucun fournisseur.
- Conserver les triggers catalogue actifs, les contrôles de transition, de suppression et les protections de génération. Une génération scellée, remplacée, invisible ou une époque modifiée provoque un refus, jamais un contournement.
- Disposer d'un répertoire d'état privé dédié et vide, hors dépôt : absolu, non symbolique, mode `0700`. Les reçus sont privés `0600`, créés exclusivement et non écrasés. Le plan expire après 30 minutes et est lié au SHA-256 du script.
- Vérifier d'abord le SQL sur une base de validation représentative si disponible. Les tests offline ne remplacent pas cette validation.

Dans une transaction courte (`lock_timeout=2s`, `statement_timeout=20s`), l'opérateur :

1. prend le verrou de compte normal, puis source, head/lifecycle, époque utilisateur, média et variante ;
2. compare le snapshot complet : génération visible, révisions head/config et époques source/utilisateur ;
3. compare propriétaire, source, titre, média, variante, type, identités du manifeste, hashes des deux URL `targetUrl` et deux `selectionPlaybackValidation.urlSha256` ;
4. compare le SHA-256 de chacune des métadonnées complètes et exige l'absence préalable de `selectionFilenameAudio` ;
5. appelle le proof helper existant et fournit les quatre champs `write_*` aux deux `UPDATE`, sous `service_role` dans une routine privilégiée temporaire révoquée des autres rôles ;
6. exige exactement un média et une variante, et vérifie que le seul contenu changé est la déclaration — hormis les timestamps et fences normaux ;
7. vérifie que les observations audio/sous-titres sont intégralement inchangées, que la variante rejoint la projection espagnole et sort de la relation « langue non identifiée » ;
8. incrémente une fois l'époque de visibilité utilisateur pour invalider les caches/paginations concernés.

Les triggers normaux peuvent aussi actualiser la projection de langues et la révision de génération ; ce sont leurs effets attendus, non un contournement. Aucun `audio_verified`, codec, piste, job, retry, flag, cron ou état de quarantaine n'est modifié par le script.

## Commandes après autorisation

Depuis la racine du checkout déployé, utiliser un nouveau répertoire d'état privé. Le nom du conteneur doit être celui vérifié sur l'hôte ; l'exemple conserve `norva-db`.

```bash
STATE_DIR="$(mktemp -d /var/tmp/norva-cruella-filename-20260913.XXXXXX)"
chmod 700 "$STATE_DIR"
python3 ops/hetzner/scripts/refresh-audited-selection-filename-language-20260913.py prepare --state-dir "$STATE_DIR" --container norva-db
python3 ops/hetzner/scripts/refresh-audited-selection-filename-language-20260913.py dry-run --state-dir "$STATE_DIR" --container norva-db
python3 ops/hetzner/scripts/refresh-audited-selection-filename-language-20260913.py status --state-dir "$STATE_DIR" --container norva-db
```

`prepare` et `status` sont en lecture seule. `dry-run` réalise les écritures et leurs triggers **dans une transaction annulée**, puis relit et exige le même état qu'avant. Il peut prendre des verrous brefs, mais doit retourner `dry_run_passed:true`, `persisted_rows:0`. Avant application, le statut doit encore donner `matches_unidentified:true` et les deux déclarations absentes. Un reçu de dry-run valide est exigé pour appliquer.

Uniquement si ces contrôles sont passés, dans les 30 minutes, et si l'application de cet unique fichier est autorisée :

```bash
python3 ops/hetzner/scripts/refresh-audited-selection-filename-language-20260913.py apply --state-dir "$STATE_DIR" --container norva-db --acknowledge apply-only-audited-cruella-filename-declaration
python3 ops/hetzner/scripts/refresh-audited-selection-filename-language-20260913.py status --state-dir "$STATE_DIR" --container norva-db
```

Résultat attendu : `applied:true`, `variants:1`, `language:"es"`, `provider_requests:0`. La relecture doit confirmer `declaration_on_media:true`, `declaration_on_variant:true`, `matches_spanish:true`, `matches_unidentified:false`. Le reçu interne conserve les nombres exacts, le snapshot et les hashes, jamais les URL complètes.

Vérifier ensuite la carte de cette **variante** après rafraîchissement du catalogue : « Espagnol » et absence du filtre inconnu. Le titre regroupé peut néanmoins rester dans ce filtre si un autre fichier du même titre demeure non identifié ; ne pas confondre variante corrigée et titre entièrement résolu.

## Refus et réponse incertaine

- Changement d'identité, de génération, de hash, de métadonnée, de déclaration existante ou de résultat de langue : arrêt. Ne pas modifier les constantes ou supprimer les gardes pour forcer le passage. Réauditer l'état courant.
- `prior_apply_intent_no_retry` ou `apply_uncertain_no_retry` : **ne pas relancer l'application**, ne pas supprimer le reçu, ne pas changer de répertoire pour contourner l'interdiction. Exécuter seulement `status`, puis faire examiner l'état transactionnel et le résultat par l'opérateur responsable. Une déconnexion peut survenir après le `COMMIT`.
- Même en cas d'échec apparent d'un dry-run, ne pas démarrer d'application sans son reçu de réussite et sa relecture identique. Toute nouvelle tentative nécessite un plan revu si le précédent a expiré ou si l'état a changé.
- Si les deux déclarations exactes existent déjà et la projection est cohérente, `prepare` retourne `already_applied:true` sans écriture. Un état partiel reste bloqué pour examen.

## Vérification offline

```bash
python3 tests/selection-filename-refresh-operator.test.py
node --test tests/selection-filename-audio.test.js tests/selection-filename-audio-repackaged.test.js
```

Les tests Python utilisent uniquement des réponses simulées ; aucune base, URL fournisseur ou clé n'est ouverte. Ils couvrent les identités/hashs, fences, nombre exact de cibles, expiration, refus d'état modifié, rollback relu, consentement CLI, reçus immuables et absence de relance après résultat incertain.
