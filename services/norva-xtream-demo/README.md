# norva-xtream-demo — test Xtream source for the Play foreground-service video

**TEST ONLY.** A minimal Xtream-Codes-compatible Cloudflare Worker that exposes
**one legal, freely licensed movie** so you can add it to Norva, download it, and
record the `FOREGROUND_SERVICE_DATA_SYNC` demonstration video Google Play requires.
It serves no third-party or copyrighted content.

## Attribution (required — CC BY 3.0)

> **Big Buck Bunny** (2008) © **Blender Foundation** — licensed **Creative Commons
> Attribution 3.0** ([CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)) —
> https://peach.blender.org

CC BY 3.0 allows commercial use; you must credit the author and note any changes.
This Worker does not modify the film — it proxies the original bytes. The visible
movie title in Norva carries the credit. The separately distributed soundtrack has
different, more restrictive terms — not relevant to playing the full film.

## Deploy (Cloudflare)

```bash
cd services/norva-xtream-demo
npx wrangler deploy
```
Wrangler prints the public URL, e.g. `https://norva-xtream-demo.<your-subdomain>.workers.dev`.
(Use the Cloudflare account that owns your other Norva Workers: `npx wrangler whoami`.)

## Add it to Norva (test account adrienhernandez20@gmail.com)

Add a **new Xtream source** with:

| Field | Value |
|---|---|
| Server URL | `https://norva-xtream-demo.<your-subdomain>.workers.dev` |
| Username | `demo` (any value works) |
| Password | `demo` (any value works) |

The source connects (`user_info.auth = 1`), syncs, and the catalog shows one movie:
**Big Buck Bunny (2008) — Blender Foundation — CC BY 3.0** under the category
*Demo — CC BY 3.0*.

## Record the Play video (what the reviewer must see)

1. Open the movie's detail page → tap **Download**.
2. Show the **foreground notification** with download progress.
3. Press **Home** (background the app) → show the download **keeps going** via the
   persistent notification.
4. 20–40 seconds is enough. Upload it **unlisted to YouTube** and paste the link
   into the Play Console foreground-service declaration.

## After approval

Delete this test source in Norva and tear down the Worker:
```bash
npx wrangler delete
```

## How it maps to Norva's Xtream client (for maintainers)

Verified against `supabase/functions/_shared/xtream-sync.ts` and
`norva-cloud` `validateCloudSource`:

- `GET /player_api.php?username&password[&action]`
  - *(no action / `account_info`)* → `{ user_info: { auth: 1, status: "Active", … }, server_info }`
  - `get_vod_categories` → `[{ category_id, category_name }]`
  - `get_vod_streams` → `[{ stream_id, name, container_extension, category_id, stream_icon, added }]`
  - `get_vod_info` → `{ info, movie_data }`
  - `get_live_* / get_series_*` → `[]`
- `GET /movie/{user}/{pass}/{stream_id}.mp4` → the movie bytes, Range/HEAD aware
  (proxied so it works whether Norva streams direct or via the media gateway).
