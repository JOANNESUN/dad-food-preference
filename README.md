# 爸爸想吃什麼？ — Cloudflare D1 prototype

Photo-first mobile web app/PWA-style prototype backed by Cloudflare D1.

## What works
- Dad mode: large food image, swipe left/right, previous/next buttons
- Reactions: 想吃 / 可以 / 不想吃
- Same reactions directly on every card in 「也可以看看」
- Infinite scrolling with no pagination UI
- Real lazy-loading: the food list API does **not** return image bytes; each image is fetched from `/api/foods/:id/image` only when the browser loads it
- Category filtering
- Add food with a required photo
- Add restaurant + categories
- Preference history + latest preference counts
- Seed data for 秀蘭小館 and 艋舺熱海 海鮮餐廳
- Shared-password gate over the whole API, remembered for a year per device
- Add/replace a photo by picking a dish from a list of everything still missing one

## Photo storage
Photos are compressed in the browser (max 900px, JPEG q0.68 — roughly 80-150 KB each) and stored as
BLOB bytes in the `foods.image_blob` column. Nothing else is needed: one D1 database holds both the
menu and the images.

The relevant D1 limits:

| Limit | Value | What it means here |
| --- | --- | --- |
| Max row size | 2 MB | A compressed photo is ~0.1 MB, so ~20x headroom per dish |
| Database size (Free) | 500 MB | Roughly 3,000+ photos |
| Database size (Paid) | 10 GB | Effectively unlimited for this use |

The upload endpoints accept Base64 (easiest thing for a browser canvas to produce) and decode it to
bytes server-side, so the stored image is the raw JPEG rather than 33%-larger Base64 text. The list
endpoint never returns image bytes — each photo is fetched from `/api/foods/:id/image` only when the
browser actually loads it.

Move to R2 only if the library grows past a few thousand photos.

## Shared password
The whole API sits behind one shared password. Photos are loaded by `<img src>`, which cannot send an
`Authorization` header, so the session is an **HttpOnly cookie** the browser attaches to every request,
image requests included.

The cookie holds an expiry plus an HMAC of that expiry, keyed by the password itself. There is no
session table: changing `APP_PASSWORD` re-keys the HMAC and signs every device out automatically.
The cookie lasts a year, so Dad types the password once per device and then never again.

If `APP_PASSWORD` is not set the API fails closed (HTTP 500) rather than serving everything openly.

Set it for the deployed Worker:

```bash
npx wrangler secret put APP_PASSWORD
```

For local development, put it in `.dev.vars` (gitignored, never committed):

```text
APP_PASSWORD=some-dev-password
```

## Setup

### 1. Install dependencies
Requires Node.js 22 or newer (current Wrangler will not run on Node 20).

```bash
npm install
```

### 2. Log in to Cloudflare
```bash
npx wrangler login
```

### 3. Create D1 in Asia Pacific
```bash
npm run db:create
```

Wrangler prints the new database UUID. Paste that UUID into `wrangler.jsonc` in place of:

```text
00000000-0000-0000-0000-000000000000
```

### 4. Create tables locally
```bash
npm run db:migrate:local
npm run db:seed:local
```

### 5. Run locally
```bash
npm run dev
```

### 6. Create tables + seed the real Cloudflare D1
```bash
npm run db:migrate:remote
npm run db:seed:remote
```

### 7. Set the shared password
```bash
npx wrangler secret put APP_PASSWORD
```

### 8. Deploy
```bash
npm run deploy
```

Cloudflare will deploy both the Worker API and files in `public/` as Workers Static Assets.

## Data model
- `foods`: name, restaurant, compressed photo bytes (`image_blob`)
- `food_categories`: many-to-many tags
- `reactions`: every want/maybe/no response with timestamp

The app keeps the full reaction history rather than one boolean preference, because Dad's appetite can change from day to day.
