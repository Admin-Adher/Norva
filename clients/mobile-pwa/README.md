# Norva — Mobile PWA

A Progressive Web App for iPhone and Android that pairs with your Norva hub.

## Deploy to Vercel

1. Fork or push this folder as a Vercel project root, or deploy the monorepo and set the **Root Directory** to `clients/mobile-pwa`.
2. Click **Deploy** — no build step required (pure static files).
3. Your PWA will be live at `https://your-project.vercel.app`.

### Optional: Supabase cloud pairing

If your hub uses Supabase, add these environment variables in the Vercel project settings (Settings → Environment Variables):

| Variable | Description |
|---|---|
| `VITE_SUPABASE_URL` | Your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Your Supabase anon/public key |

These are exposed to the frontend if you add a thin `env.js` loader. The PWA works without them for local-network pairing.

## How to use

### Install as a PWA

**iPhone (Safari):** Open the deployed URL → tap the Share button → "Add to Home Screen".

**Android (Chrome):** Open the URL → tap the menu → "Add to Home Screen" or "Install app".

### Pair with your TV

1. On the Norva hub TV interface, open the pairing screen — it shows a QR code.
2. Open the Norva PWA on your phone.
3. Tap **Scan QR Code from TV** and point the camera at the TV's QR code.
4. The app parses the `norva://pair?hub=<url>&code=<code>` URL from the QR.
5. Tap **Approve Pairing** — the phone calls the hub's `/api/pair/approve` endpoint.
6. The hub loads in the full-screen browse view.

### Manual connection

If scanning isn't available, tap **Connect to Hub** and type your hub's local IP address (e.g. `http://192.168.1.20:3000`).

### Deep link handling

The QR code encodes a `norva://pair` URI. On Android, the native app in `clients/android-phone` registers this scheme and handles it natively. On iOS/web, jsQR parses the QR image directly from the camera stream.

## Project structure

```
clients/mobile-pwa/
  index.html      — single-page app (all screens, vanilla JS)
  manifest.json   — PWA manifest
  sw.js           — service worker (offline cache)
  icon-192.svg    — app icon 192×192
  icon-512.svg    — app icon 512×512
  vercel.json     — Vercel routing + headers config
  README.md       — this file
```
