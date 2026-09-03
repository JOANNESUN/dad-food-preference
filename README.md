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
- Add/replace a photo for a seeded food using its displayed food ID

## Prototype photo storage decision
For this prototype only, compressed JPEGs are stored as Base64 text in D1. This keeps setup to one Cloudflare product while preserving a real database and real lazy-loading image endpoint.

For a larger/production library, move `image_base64` into Cloudflare R2 and keep only an object key or URL in D1.

## Setup

### 1. Install dependencies
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

### 7. Deploy
```bash
npm run deploy
```

Cloudflare will deploy both the Worker API and files in `public/` as Workers Static Assets.

## Data model
- `foods`: name, restaurant, compressed prototype photo
- `food_categories`: many-to-many tags
- `reactions`: every want/maybe/no response with timestamp

The app keeps the full reaction history rather than one boolean preference, because Dad's appetite can change from day to day.
