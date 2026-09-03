const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const allowedReactions = new Set(["want", "maybe", "no"]);
const allowedCategories = new Set(["早餐","午餐","晚餐","點心","高蛋白","纖維","軟質","湯品","海鮮"]);

const MAX_BASE64_LENGTH = 1400000; // ~1.05 MB of JPEG, still half of D1's 2 MB row limit

function base64ToBytes(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// D1 hands BLOB columns back as an ArrayBuffer on some runtimes and a plain
// array of byte values on others, so normalise before building the Response.
function blobToBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return new Uint8Array(value);
  return null;
}

// Shared by createFood and updatePhoto: validate the posted photo, return bytes.
async function readPhoto(request) {
  const body = await request.json().catch(() => null);
  if (!body) return { error: json({ error: "Invalid JSON" }, 400) };
  const imageMime = String(body.imageMime || "").trim();
  const imageBase64 = String(body.imageBase64 || "").trim();
  if (!imageBase64 || !imageMime.startsWith("image/")) {
    return { error: json({ error: "A food photo is required" }, 400) };
  }
  if (imageBase64.length > MAX_BASE64_LENGTH) {
    return { error: json({ error: "Photo is too large after compression" }, 413) };
  }
  let bytes;
  try {
    bytes = base64ToBytes(imageBase64);
  } catch {
    return { error: json({ error: "Photo could not be decoded" }, 400) };
  }
  return { body, imageMime, bytes };
}

// --- Shared-password gate -------------------------------------------------
// Photos are loaded by <img src>, which cannot carry an Authorization header,
// so the session lives in an HttpOnly cookie that the browser attaches to every
// request, image requests included. The cookie holds an expiry plus an HMAC of
// that expiry keyed by the password itself: changing APP_PASSWORD therefore
// signs everyone out automatically, with no session table to keep.
const SESSION_COOKIE = "dadfood_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 365; // Dad signs in once a year

const toHex = buffer => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function signExpiry(secret, expiry) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(expiry))));
}

// Both arguments are fixed-length hex digests, so this compares in constant time.
function equalDigests(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request, cookieName) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === cookieName) return rest.join("=");
  }
  return null;
}

async function hasValidSession(request, secret) {
  const [expiryRaw, signature] = String(readCookie(request, SESSION_COOKIE) || "").split(".");
  const expiry = Number(expiryRaw);
  if (!signature || !Number.isFinite(expiry) || expiry <= Math.floor(Date.now() / 1000)) return false;
  return equalDigests(signature, await signExpiry(secret, expiry));
}

async function login(request, env, secret) {
  const body = await request.json().catch(() => null);
  const password = String(body?.password || "");
  if (!password) return json({ error: "請輸入密碼" }, 400);
  if (!equalDigests(await sha256Hex(password), await sha256Hex(secret))) {
    return json({ error: "密碼不對" }, 401);
  }
  const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = `${expiry}.${await signExpiry(secret, expiry)}`;
  const response = json({ ok: true });
  response.headers.append(
    "set-cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`
  );
  return response;
}

function logout() {
  const response = json({ ok: true });
  response.headers.append("set-cookie", `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  return response;
}

async function listFoods(url, env) {
  const limit = clamp(Number(url.searchParams.get("limit") || 12), 1, 24);
  const cursorRaw = Number(url.searchParams.get("cursor") || 0);
  const cursor = Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : null;
  const category = (url.searchParams.get("category") || "").trim();
  const restaurant = (url.searchParams.get("restaurant") || "").trim();

  const conditions = [];
  const binds = [];
  if (cursor) { conditions.push("f.id < ?"); binds.push(cursor); }
  if (restaurant) { conditions.push("f.restaurant = ?"); binds.push(restaurant); }
  if (category) {
    conditions.push("EXISTS (SELECT 1 FROM food_categories fc WHERE fc.food_id=f.id AND fc.category=?)");
    binds.push(category);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT f.id, f.name, f.restaurant, f.created_at,
      CASE WHEN f.image_blob IS NOT NULL AND length(f.image_blob) > 0 THEN 1 ELSE 0 END AS has_photo,
      (SELECT reaction FROM reactions r WHERE r.food_id=f.id ORDER BY r.id DESC LIMIT 1) AS latest_reaction,
      (SELECT COUNT(*) FROM reactions r WHERE r.food_id=f.id AND r.reaction='want') AS want_count,
      (SELECT COUNT(*) FROM reactions r WHERE r.food_id=f.id AND r.reaction='maybe') AS maybe_count,
      (SELECT COUNT(*) FROM reactions r WHERE r.food_id=f.id AND r.reaction='no') AS no_count
    FROM foods f
    ${where}
    ORDER BY f.id DESC
    LIMIT ?`;

  const result = await env.DB.prepare(sql).bind(...binds, limit + 1).all();
  const rows = result.results || [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  let categories = [];
  if (page.length) {
    const placeholders = page.map(() => "?").join(",");
    const categoryResult = await env.DB.prepare(
      `SELECT food_id, category FROM food_categories WHERE food_id IN (${placeholders}) ORDER BY food_id DESC`
    ).bind(...page.map(x => x.id)).all();
    categories = categoryResult.results || [];
  }

  const byFood = new Map();
  for (const row of categories) {
    if (!byFood.has(row.food_id)) byFood.set(row.food_id, []);
    byFood.get(row.food_id).push(row.category);
  }

  const items = page.map(row => ({
    ...row,
    has_photo: Boolean(row.has_photo),
    tags: byFood.get(row.id) || [],
    image_url: row.has_photo ? `/api/foods/${row.id}/image` : null
  }));
  return json({ items, nextCursor: hasMore ? page[page.length - 1].id : null });
}

async function createFood(request, env) {
  const photo = await readPhoto(request);
  if (photo.error) return photo.error;
  const body = photo.body;
  const name = String(body.name || "").trim();
  const restaurant = String(body.restaurant || "").trim();
  const tags = Array.isArray(body.tags) ? [...new Set(body.tags.map(String).filter(x => allowedCategories.has(x)))] : [];

  if (!name || name.length > 80) return json({ error: "Food name is required" }, 400);

  const insert = await env.DB.prepare(
    "INSERT INTO foods(name, restaurant, image_mime, image_blob) VALUES(?,?,?,?) RETURNING id"
  ).bind(name, restaurant.slice(0, 120), photo.imageMime, photo.bytes).first();
  const id = insert.id;
  if (tags.length) {
    await env.DB.batch(tags.map(tag => env.DB.prepare(
      "INSERT OR IGNORE INTO food_categories(food_id, category) VALUES(?,?)"
    ).bind(id, tag)));
  }
  return json({ id }, 201);
}

async function updatePhoto(id, request, env) {
  const photo = await readPhoto(request);
  if (photo.error) return photo.error;
  const result = await env.DB.prepare("UPDATE foods SET image_mime=?, image_blob=? WHERE id=?")
    .bind(photo.imageMime, photo.bytes, id).run();
  if (!result.meta?.changes) return json({ error: "Food not found" }, 404);
  return json({ ok: true });
}

async function getImage(id, env) {
  const row = await env.DB.prepare("SELECT image_mime, image_blob FROM foods WHERE id=?").bind(id).first();
  const bytes = row ? blobToBytes(row.image_blob) : null;
  if (!bytes?.length) return new Response("Not found", { status: 404 });
  return new Response(bytes, {
    headers: {
      "content-type": row.image_mime || "image/jpeg",
      "cache-control": "public, max-age=86400"
    }
  });
}

// Powers the add-photo picker. By default it lists only dishes that still have
// no photo; with ?all=1 it lists every dish so an existing photo can be replaced.
async function photoPicker(env, url) {
  const all = url.searchParams.get("all") === "1";
  const where = all ? "" : "WHERE image_blob IS NULL OR length(image_blob) = 0";
  const result = await env.DB.prepare(`
    SELECT id, name, restaurant,
      CASE WHEN image_blob IS NOT NULL AND length(image_blob) > 0 THEN 1 ELSE 0 END AS has_photo
    FROM foods
    ${where}
    ORDER BY restaurant, id
  `).all();
  const items = (result.results || []).map(r => ({ ...r, has_photo: Boolean(r.has_photo) }));
  return json({ items });
}

// One random dish, so the app opens on something different each visit.
// Honours the same filters as the list so the hero always matches the view.
async function randomFood(url, env) {
  const category = (url.searchParams.get("category") || "").trim();
  const restaurant = (url.searchParams.get("restaurant") || "").trim();
  const conditions = [];
  const binds = [];
  if (restaurant) { conditions.push("f.restaurant = ?"); binds.push(restaurant); }
  if (category) {
    conditions.push("EXISTS (SELECT 1 FROM food_categories fc WHERE fc.food_id=f.id AND fc.category=?)");
    binds.push(category);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const row = await env.DB.prepare(`
    SELECT f.id, f.name, f.restaurant, f.created_at,
      CASE WHEN f.image_blob IS NOT NULL AND length(f.image_blob) > 0 THEN 1 ELSE 0 END AS has_photo,
      (SELECT reaction FROM reactions r WHERE r.food_id=f.id ORDER BY r.id DESC LIMIT 1) AS latest_reaction
    FROM foods f ${where} ORDER BY RANDOM() LIMIT 1
  `).bind(...binds).first();
  if (!row) return json({ item: null });
  const tags = await env.DB.prepare("SELECT category FROM food_categories WHERE food_id=?").bind(row.id).all();
  return json({ item: {
    ...row,
    has_photo: Boolean(row.has_photo),
    tags: (tags.results || []).map(t => t.category),
    image_url: row.has_photo ? `/api/foods/${row.id}/image` : null
  } });
}

// Restaurants for the header dropdown, in the order they were added.
async function restaurants(env) {
  const result = await env.DB.prepare(`
    SELECT restaurant, COUNT(*) AS n FROM foods
    WHERE restaurant <> ''
    GROUP BY restaurant
    ORDER BY MIN(id)
  `).all();
  return json({ items: result.results || [] });
}

async function addReaction(id, request, env) {
  const body = await request.json().catch(() => null);
  const reaction = String(body?.reaction || "");
  if (!allowedReactions.has(reaction)) return json({ error: "Invalid reaction" }, 400);
  const food = await env.DB.prepare("SELECT id FROM foods WHERE id=?").bind(id).first();
  if (!food) return json({ error: "Food not found" }, 404);
  await env.DB.prepare("INSERT INTO reactions(food_id, reaction) VALUES(?,?)").bind(id, reaction).run();
  return json({ ok: true }, 201);
}

async function history(env) {
  const result = await env.DB.prepare(`
    SELECT r.id, r.food_id, r.reaction, r.created_at, f.name, f.restaurant
    FROM reactions r JOIN foods f ON f.id=r.food_id
    ORDER BY r.id DESC LIMIT 100
  `).all();
  return json({ items: result.results || [] });
}

async function stats(env) {
  const result = await env.DB.prepare(`
    WITH latest AS (
      SELECT r.food_id, r.reaction FROM reactions r
      JOIN (SELECT food_id, MAX(id) AS max_id FROM reactions GROUP BY food_id) x ON x.max_id=r.id
    )
    SELECT
      SUM(CASE WHEN reaction='want' THEN 1 ELSE 0 END) AS want,
      SUM(CASE WHEN reaction='maybe' THEN 1 ELSE 0 END) AS maybe,
      SUM(CASE WHEN reaction='no' THEN 1 ELSE 0 END) AS no
    FROM latest
  `).first();
  return json({ want: Number(result?.want || 0), maybe: Number(result?.maybe || 0), no: Number(result?.no || 0) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      // Fail closed: without a configured password the API stays shut rather
      // than silently serving everything to anyone who finds the URL.
      const secret = env.APP_PASSWORD;
      if (!secret) return json({ error: "APP_PASSWORD is not configured" }, 500);

      if (request.method === "POST" && url.pathname === "/api/login") return login(request, env, secret);
      if (request.method === "POST" && url.pathname === "/api/logout") return logout();

      // Looking at food and reacting to it is open, so Dad never meets a login
      // screen. Only the endpoints that change the library need the password.
      const isAdmin = await hasValidSession(request, secret);
      if (url.pathname === "/api/session") return json({ admin: isAdmin });

      const changesLibrary =
        (request.method === "POST" && url.pathname === "/api/foods") ||
        (request.method === "PUT" && /^\/api\/foods\/\d+\/image$/.test(url.pathname)) ||
        url.pathname === "/api/foods/needs-photo";
      if (changesLibrary && !isAdmin) return json({ error: "需要密碼" }, 401);

      if (request.method === "GET" && url.pathname === "/api/foods") return listFoods(url, env);
      if (request.method === "POST" && url.pathname === "/api/foods") return createFood(request, env);
      if (request.method === "GET" && url.pathname === "/api/history") return history(env);
      if (request.method === "GET" && url.pathname === "/api/stats") return stats(env);
      if (request.method === "GET" && url.pathname === "/api/restaurants") return restaurants(env);
      if (request.method === "GET" && url.pathname === "/api/foods/random") return randomFood(url, env);
      if (request.method === "GET" && url.pathname === "/api/foods/needs-photo") return photoPicker(env, url);

      let match = url.pathname.match(/^\/api\/foods\/(\d+)\/image$/);
      if (request.method === "GET" && match) return getImage(Number(match[1]), env);
      if (request.method === "PUT" && match) return updatePhoto(Number(match[1]), request, env);

      match = url.pathname.match(/^\/api\/foods\/(\d+)\/reactions$/);
      if (request.method === "POST" && match) return addReaction(Number(match[1]), request, env);
      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error(error);
      return json({ error: "Server error", detail: String(error?.message || error) }, 500);
    }
  }
};
