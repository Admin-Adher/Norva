# Norva — Passage à l'échelle : playbook produit

> **But de ce fichier** : une vue **unique et lisible** de *ce qu'on construit maintenant*
> pour que Norva scale proprement, et de *la séquence exacte à dérouler le jour où les
> users arrivent*. C'est le **point d'entrée** ; le détail technique & la reprise sont dans
> [`scaling-status.md`](./scaling-status.md), le design du cache global dans
> [`global-title-cache-design.md`](./global-title-cache-design.md).
>
> _Dernière mise à jour : 2026-06-24._

---

## Philosophie (les 2 règles qui évitent les embûches)

1. **Tout se construit en additif, maintenant, désactivé.** Chaque optimisation de scale
   est posée (table, fonction, flag) **sans rien changer au comportement live** — flag OFF,
   best-effort, réversible. Le code risqué existe et est **vérifié**, mais dort.
2. **On active par déclencheur _mesuré_, jamais par anticipation.** Une optim qui a 0 %
   de bénéfice aujourd'hui (1 catalogue) mais 100 % du risque ne se branche **que** quand
   une requête de mesure prouve que le gain est là. On ne paie jamais le risque avant le gain.

> Conséquence : le jour où les users arrivent, le travail = **basculer des interrupteurs
> déjà testés**, pas écrire/migrer dans l'urgence.

---

## Où on en est — la posture par couche

| Couche | Scale aujourd'hui ? | Ce qui est posé (dormant / additif) |
|---|---|---|
| **Lecture / relais** | ✅ déjà | Cloudflare edge (**zéro egress**), socket TCP pour nœuds IP-brute, cache hint socket, cache `get_vod_info` 24h |
| **Métadonnées titres** | ⚠️ per-user | `catalog_titles` (cache global) : fondation + dual-write + backfill + **read derrière flag OFF** + harnais de vérif |
| **Langues audio** | ⚠️ per-user (lu) · ✅ partagé | `audio_languages` dans le cache global (RPC union) + **catalog-first fill AUTO à l'onboarding** → un nouvel user hérite des langues déjà connues, 0 appel fournisseur |
| **Menus / facettes** | ✅ caché | Memo LRU 60 s sur les 25 count-queries/appel |
| **Crawl audio** | ✅ | Progression (`audio_probed_at`) + cron gentil (respecte le rate-limit fournisseur) |
| **Observabilité** | ✅ émis | Logs `norva-relay-upstream-error` + webhook optionnel + `/provider-playback-check` |

**En clair** : la **lecture**, les **menus** et l'**observabilité** scalent déjà. Les
**métadonnées** et l'**audio** ont leur version scalable **construite et prouvée**, mais sont
encore **lus depuis le per-user** (flag OFF) tant qu'il n'y a pas de recoupement multi-users.

---

## Jour J — la séquence propre quand les users arrivent

À dérouler **dans cet ordre**. Chaque étape est indépendante, additive et réversible.

### 1. Mesurer le déclencheur (recoupement des catalogues)
```sql
select count(*) as rows,
       count(distinct (item_type, provider_tmdb_id)) as distinct_titles,
       round(count(*)::numeric
             / nullif(count(distinct (item_type, provider_tmdb_id)), 0), 2) as overlap
from public.cloud_titles
where provider_tmdb_id is not null and provider_tmdb_id <> '' and provider_tmdb_id !~ '^(tt)?0+$';
```
`overlap` ≫ 1 (typiquement 10-100 pour des users d'un même pays) → le cache global vaut le
coup. **Aujourd'hui = `1.00` (1 user) → ne rien basculer.**

### 2. ✅ Catalog-fill à l'onboarding — FAIT (automatique)
La projection de sync (`_shared/vod-title-projection.ts`) appelle `fill_user_audio_for_titles`
sur chaque batch de titres → un nouvel user **hérite instantanément** des langues déjà
sondées par les autres users du même fournisseur, **sans toucher le fournisseur**. Aucune
action requise : dès qu'un fournisseur est couvert, le user suivant démarre rempli. (C'est
aussi la protection n°1 contre le rate-limit : un fichier déjà connu n'est jamais re-sondé.)
Le 2-3 jours de découverte n'est donc payé **qu'une fois** par catalogue de fournisseur.

### 3. Basculer la lecture du cache global (le gros levier ÷10-100)
Quand `overlap` ≫ 1 :
1. `POST norva-playback/catalog-mirror-verify` → attendre `clean:true` sur une fenêtre.
2. Poser le secret **`NORVA_CATALOG_READ_SOURCE=catalog_titles`** sur `norva-catalog`.
3. Surveiller la grille/les rails ; **réversible** en retirant le secret.
→ divise par **10-100** l'enrichissement TMDB **et** le stockage métadonnées.

### 4. Amincir `cloud_titles`
Une fois les reads stables sur le cache global : retirer les colonnes métadonnées migrées
(garder identité + lien per-user + `variant_count`). Récupère le stockage dupliqué.

### 5. Activer le monitoring fournisseur
Poser le secret **`MONITOR_WEBHOOK`** sur le relais (alertes échantillonnées par host).
Optionnel à plus grande échelle : Logpush / Workers Analytics Engine pour des dashboards et
des seuils par fournisseur.

### 6. Lancer le harnais multi-fournisseurs (avant & pendant le lancement)
`POST norva-playback/provider-playback-check` régulièrement → un `206` attendu par host.
Un non-206 = un fournisseur dont l'auth/redirect a cassé, repéré **avant** les users.

### 7. Enrichissement global incrémental (à l'échelle du catalogue)
Brancher **TMDB changes API** (refresh des titres au `tmdb_synced_at` vieux) + **daily id
exports** TMDB → opèrent **une fois pour tous** sur `catalog_titles`, pas par-user.

---

## Coûts à surveiller à l'échelle
- **TMDB** : c'est LE poste qui explose sans cache. ÷10-100 dès l'étape 3 (lecture du cache
  global). À surveiller : appels d'enrichissement + revalidation + traductions.
- **Bande passante lecture** : **zéro egress** (relais Cloudflare) → ne scale pas en coût.
  Le fournisseur sert les octets ; le vrai risque est son **rate-limit** (mitigé par le
  catalog-fill étape 2 + le crawl gentil).
- **Stockage DB** : dédupliqué par le cache global (étape 3) + le thinning (étape 4).

---

## Garde-fous (valables quoi qu'il arrive)
- `provider_tmdb_id = '0' / ''` = sentinelle no-match → **jamais** une clé ni une identité.
- Années de sortie **plafonnées** à `[1900, année courante + 1]`.
- Ids TMDB fournisseur = fiables pour l'**identité** ; la validation TMDB ne gate que la
  confiance dans les **métadonnées**.
- Toute écriture vers le cache global est **best-effort** (try/catch) — ne casse jamais le
  chemin per-user.

## Liens
- [`scaling-status.md`](./scaling-status.md) — état détaillé, chemins de code, reprise.
- [`global-title-cache-design.md`](./global-title-cache-design.md) — design du cache de titres global.
- [`performance-status.md`](./performance-status.md) — optim du démarrage (boot) + **runbook anti-saturation DB** (charge de fond vs premier-plan).
