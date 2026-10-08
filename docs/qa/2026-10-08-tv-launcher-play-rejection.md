# Norva TV — correction du lanceur après refus Google Play

## Motif et périmètre

Google a refusé TV **3.8.25-hybrid (38)** pour le rendu de l'icône dans le lanceur. La version 35 déjà publiée restait disponible. Le bundle 38 référençait l'ancien drawable et n'utilisait pas la ressource adaptative existante. La capture Google montre le contour de la tuile coupé par le masque circulaire. Les tailles 512×512 et 320×180 étaient correctes; elles ne suffisaient pas à garantir le cadrage. La bannière sans nom était également à corriger selon les [directives Android TV](https://developer.android.com/design/ui/tv/guides/system/tv-app-icon-guidelines).

## Correctif TV 39

PR 719, code final `d0bf2709ff6261eee9ecbab4337a697a54fd0cdd` :

- Le manifeste référence `@mipmap/ic_launcher`, avec fallback pour les systèmes antérieurs à Android 8.
- Le logo Norva existant est cadré dans l'icône adaptative avec un retrait de 8 %; le fond remplit le masque sans arc de contour découpé.
- La bannière xhdpi de 320×180 associe le vrai logo au nom Norva, dont le tracé provient de la police Outfit déjà utilisée. Aucun nouveau logo ou palette.
- Version TV **3.8.26-hybrid (39)**. Aucun nouveau bundle téléphone envoyé.

Le test instrumenté charge les ressources via PackageManager, contrôle l'icône adaptative, les masques circulaire/carré arrondi, l'opacité de la bannière et la présence du nom. Il ouvre ensuite le véritable lanceur AndroidTV, utilise le focus D-pad du volet Apps et retrouve Norva. La capture finale montre la bannière effectivement chargée. Contrôle aux tailles de police 1.0 et 1.3.

## Bundle signé et compatibilité

Build signé `37832566469`, code produit `8903dc8b8`. Le commit final ne change ensuite que l'attente de capture de l'instrumentation; aucun code de release n'est différent. AAB SHA-256 : `4202cdbbea536b01df371f5be379453eb188e0ef203aa205c6eb715a032f43c9`.

Signature cryptographique et digests du bundle vérifiés, certificat identique à la précédente version, bibliothèques du décodeur identiques sur les quatre ABI, fixture absente du manifeste et du DEX. La classe de récupération native est toujours présente.

**Contrainte rencontrée pendant l'import :** Google refuse le premier bundle 39 de minSdk 23 parce que la protection automatique active exige API 24. La protection n'a pas été désactivée. Le bundle a été reconstruit avec **Android 7 minimum (API 24)**, puis accepté par Play. Le premier import rejeté a été retiré du brouillon; aucun autre code de version n'a été consommé. Le second bundle est celui retenu ci-dessus.

Conséquence observée dans Play : **3 065 modèles compatibles contre3 076**, soit 11 modèles exclus. Les installations existantes sur ces anciens modèles gardent leur ancienne version mais ne recevront pas celle-ci; ce changement n'est pas présenté comme neutre. Play indique deux installations actives ciblées. Le déploiement demandé reste 100 %, dans les pays déjà configurés; publication gérée désactivée.

Les deux autres avertissements sont l'absence de fichier de désobscurcissement et de symboles natifs de diagnostic facultatifs. Ils ne bloquent pas l'import. Les notes de version décrivent uniquement le rendu du lanceur et sont présentes dans les neuf langues existantes.

## Contrôles et incidents de test conservés

Contrats cloud, base jetable, contrats/Edge, parcours simulés, tests Android et paquets Phone/TV/Windows réussissent sur la tête finale. Les deux tests de branding TV sont réussis. La première matrice complète de cette tête conserve trois échecs : consentement D-pad TV 1.0 (`denied` au lieu de `granted`), interruption Phone gestes 1.0 après 11/77 tests avec erreurs de renderer, et assertion de délai existante 1 784 ms pour Phone trois boutons 1.3. Un seul rerun des trois jobs a été demandé, sans modifier les seuils ou le code. Le rerun TV 1.0 et Phone gestes 1.0 réussit; les deux configurations TV et trois configurations Phone sont donc réussies à 22:03 Paris. Le dernier job Phone trois boutons 1.3 réussit également au relevé de 22:06 Paris : les six configurations sont finalement réussies après cet unique rerun. Les résultats initiaux sont conservés.

Les échecs précédents restent conservés : assertion textuelle attendant 38, clic du harnais sur un parent non cliquable du lanceur, capture prématurée avant chargement des images. Seuls les tests concernés ont été corrigés; les dernières captures utilisent la vraie navigation D-pad et attendent le chargement de l'image.

## État de publication

PR 719 est intégrée par `94b8ef64e175e89fb20849d735ec15231d7074c1`. À **22:03 Paris**, la Console confirme **Norva TV 3.8.26 (39) en cours d'examen**, pour déploiement complet après approbation. Les vérifications rapides sont terminées. Ce n'est pas encore une disponibilité sur Google Play. La capture `tv39-in-review.png` conserve cet état. Aucun déploiement Gateway ni changement du traitement audio n'est inclus dans cette correction.

Reçus et captures : `.codex-artifacts/tv-icon-policy-20261008/`. L'icône circulaire et le lanceur réel sont conservés sous `emulator-current-font13/captures/`.
