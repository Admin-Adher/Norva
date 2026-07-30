# Norva Partners — preuve technique des surfaces juridiques

Vérification UTC : `2026-07-30T07:53:15Z`

Commit source : `9a672d3da3de4d659c668ab78ec2490766c70355`

Déploiement Cloudflare Pages : `1bac72df.norva-web.pages.dev`

Cette preuve confirme uniquement la publication et le contenu distinctif des
surfaces publiques. Elle ne constitue ni une approbation juridique ou fiscale,
ni une autorisation d'ouvrir le pilote.

## Résultat externe

| URL | Marqueur distinctif observé | SHA-256 de la réponse déployée |
| --- | --- | --- |
| `https://norva.tv/partners-terms.html` | `<title>Norva — Partners Terms</title>` et `<h1>Norva Partners Terms</h1>` | `d1ee0e1f6d3231c0641bf15b74bbd176d8e8a1bfe50b2b2b58fc80abfb22da32` |
| `https://norva.tv/privacy.html` | `<title>Norva — Privacy Policy</title>` et disclosure Didit | `b5d6c25a91392886582aeaaac9d330f179585bfa1884aae3dfa023b5c0fd93b4` |
| `https://norva.tv/terms.html` | `<title>Norva — Terms of Service</title>` et section `Optional Norva Partners programme` | `4b52071a1004166d60b67913dc7331f8b3561d6886d5c347bf39928365b96ecc` |
| `https://norva.tv/privacy` | même contenu distinctif Privacy, réponse `200` | voir réponse canonique `privacy.html` |
| `https://norva.tv/terms` | même contenu distinctif Terms, réponse `200` | voir réponse canonique `terms.html` |

Les réponses déployées diffèrent octet pour octet des fichiers source parce que
le workflow de publication minifie les styles, recalcule les versions d'assets
et injecte le CSS avant l'envoi à Cloudflare Pages. Les empreintes source sont
conservées séparément :

| Fichier source | SHA-256 |
| --- | --- |
| `public/partners-terms.html` | `3b760bc0225df1113108d937ff5f3d431cab685beae9639bfd9d9d8f193d01e2` |
| `public/privacy.html` | `830a696f081633e848c55bc747e1e6553238745609a43aa97269d5868bb1666b` |
| `public/terms.html` | `a7fad2dc248d66e226190a9898da7b69dceb44c63b016445ce903defe287ac98` |

## Contrôle de fermeture

La route `https://norva.tv/r/AbCdEfGhIjKlMnOpQrStUvWxYz012345` a répondu
`503 Service Unavailable` avec `Cache-Control: private, no-store`,
`Retry-After: 60` et sans cookie. Cela prouve que le code Cloudflare Pages de
résolution est publié et reste fail-closed tant que sa configuration et son
backend self-hosted ne sont pas reliés.

## Rejeu

Utiliser une valeur de cache-busting et ne jamais inclure de code de parrainage
réel :

```bash
curl -fsSL -H 'Cache-Control: no-cache' \
  'https://norva.tv/partners-terms.html?release=<commit>'
curl -fsSL -H 'Cache-Control: no-cache' \
  'https://norva.tv/privacy.html?release=<commit>'
curl -fsSL -H 'Cache-Control: no-cache' \
  'https://norva.tv/terms.html?release=<commit>'
```
