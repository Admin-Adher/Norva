# Fan-out CDN Cloudflare devant l'origine média (GEX44)

> Le but : **le CDN Cloudflare cache les segments HLS `.ts` au edge**, pour que 1000 viewers d'une
> même chaîne partagent **un seul** fetch vers l'origine GEX44. C'est ce qui dissout le mur
> « 1 box = ~200 viewers » (§9.8). Sans ça, chaque viewer tape l'origine → le port 1 Gbit/s sature.

## Deux façons de router l'egress viewer par Cloudflare

Norva a **déjà** un Worker relay (`services/norva-relay`) qui fait transiter les octets par
Cloudflare (egress Workers non-facturé au Go). Deux options complémentaires :

### Option A — ❌ cache dans le Worker relay : NE fan-out PAS (ne pas faire)
Intuitif mais faux : `rewriteHlsPlaylist` re-signe chaque segment avec le **token par viewer**, donc
2 viewers d'une même chaîne ont des **URLs différentes** → clés de cache différentes → aucun partage.
Voir `CODE-PATCHES.md` patch #2. → Utiliser **Option B**. (Le Worker relay reste utile pour la VOD
propre et le live-hls relayable, mais pas comme mécanisme de fan-out du transcode.)

### Option B — un domaine média proxifié (orange-cloud) devant le GEX44
Pour servir directement l'origine HLS du GEX44 via le CDN Cloudflare :

1. **DNS** : créer `media.norva.tv` → IP du GEX44, **proxy activé (nuage orange)**.
2. **TLS** : mode « Full (strict) » ; certificat origine Cloudflare installé sur le reverse-proxy du GEX44 (Caddy/nginx devant le `:8080`).
3. **Cache Rule** (Dashboard → Caching → Cache Rules), pour le path des segments :

   | Champ | Valeur |
   |---|---|
   | When incoming requests match | `URI Path ends with ".ts"` OR `".m4s"` |
   | Eligible for cache | **Yes** (Cache eligibility: Eligible) |
   | Edge TTL | **Override: 6 seconds** (≈ durée d'un segment live ; VOD peut aller plus haut) |
   | Cache key | inclure le token de path si présent, mais garder le nom de segment stable |

   Les **manifests** (`.m3u8`) : cache très court ou **Bypass** en live (ils changent chaque segment) ; en VOD un `s-maxage` court est OK.

4. **Vérifier le fan-out** : 2 viewers de la même chaîne → le 2ᵉ segment renvoie
   `cf-cache-status: HIT`. Si `MISS`/`DYNAMIC` partout → la Cache Rule ou les headers d'origine
   (`Cache-Control`) ne rendent pas les segments cacheables (voir patch #2).

## ⚠️ TOS §2.8 (vidéo) — à savoir avant l'échelle Po

Servir de **gros volumes de vidéo** sur les plans self-serve Cloudflare (Free/Pro) peut heurter la
**section 2.8 des TOS**. À l'échelle (centaines de To → Po/mois), prévoir soit un plan
**Business/Enterprise**, soit **Cloudflare Stream** (facturé à la minute stockée + livrée). Ça
reste **radicalement** moins cher que l'egress Railway ($0.05/Go), mais **pas** littéralement
gratuit-infini. → Instrumenter le volume egress dès les premiers milliers de viewers.

## Chaînes live populaires = single-flight + cache = la clé

Le gain maximal vient de la **combinaison** :
- **single-flight** côté origine (1 ffmpeg par flux unique, `CODE-PATCHES.md` patch #1),
- **cache edge** des segments (ci-dessus),
- **relay-hls opt-in** activé (patch #3) pour que le live éligible passe par le relay quasi-gratuit.

→ 3000 viewers sur 35 chaînes = **35 transcodes** (1 GEX44) + le CDN sert les 3000. Sans ces 3
leviers, ce serait 3000 transcodes = impossible.
