const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const allowedReactions = new Set(["want", "maybe", "no"]);
const allowedCategories = new Set(["早餐","午餐","晚餐","點心","甜食","高蛋白","纖維","軟質","湯品","海鮮","冷食"]);

function base64ToBytes(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function listFoods(url, env) {
  const limit = clamp(Number(url.searchParams.get("limit") || 12), 1, 24);
  const cursorRaw = Number(url.searchParams.get("cursor") || 0);
  const cursor = Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : null;
  const category = (url.searchParams.get("category") || "").trim();

  const conditions = [];
  const binds = [];
  if (cursor) { conditions.push("f.id < ?"); binds.push(cursor); }
  if (category) {
    conditions.push("EXISTS (SELECT 1 FROM food_categories fc WHERE fc.food_id=f.id AND fc.category=?)");
    binds.push(category);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT f.id, f.name, f.restaurant, f.created_at,
      CASE WHEN f.image_base64 IS NOT NULL AND length(f.image_base64) > 0 THEN 1 ELSE 0 END AS has_photo,
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
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "Invalid JSON" }, 400);
  const name = String(body.name || "").trim();
  const restaurant = String(body.restaurant || "").trim();
  const imageMime = String(body.imageMime || "").trim();
  const imageBase64 = String(body.imageBase64 || "").trim();
  const tags = Array.isArray(body.tags) ? [...new Set(body.tags.map(String).filter(x => allowedCategories.has(x)))] : [];

  if (!name || name.length > 80) return json({ error: "Food name is required" }, 400);
  if (!imageBase64 || !imageMime.startsWith("image/")) return json({ error: "A food photo is required" }, 400);
  if (imageBase64.length > 700000) return json({ error: "Photo is too large after compression" }, 413);

  const insert = await env.DB.prepare(
    "INSERT INTO foods(name, restaurant, image_mime, image_base64) VALUES(?,?,?,?) RETURNING id"
  ).bind(name, restaurant.slice(0, 120), imageMime, imageBase64).first();
  const id = insert.id;
  if (tags.length) {
    await env.DB.batch(tags.map(tag => env.DB.prepare(
      "INSERT OR IGNORE INTO food_categories(food_id, category) VALUES(?,?)"
    ).bind(id, tag)));
  }
  return json({ id }, 201);
}

async function updatePhoto(id, request, env) {
  const body = await request.json().catch(() => null);
  const imageMime = String(body?.imageMime || "").trim();
  const imageBase64 = String(body?.imageBase64 || "").trim();
  if (!imageBase64 || !imageMime.startsWith("image/")) return json({ error: "A food photo is required" }, 400);
  if (imageBase64.length > 700000) return json({ error: "Photo is too large after compression" }, 413);
  const result = await env.DB.prepare("UPDATE foods SET image_mime=?, image_base64=? WHERE id=?")
    .bind(imageMime, imageBase64, id).run();
  if (!result.meta?.changes) return json({ error: "Food not found" }, 404);
  return json({ ok: true });
}

async function getImage(id, env) {
  const row = await env.DB.prepare("SELECT image_mime, image_base64 FROM foods WHERE id=?").bind(id).first();
  if (!row?.image_base64) return new Response("Not found", { status: 404 });
  return new Response(base64ToBytes(row.image_base64), {
    headers: {
      "content-type": row.image_mime || "image/jpeg",
      "cache-control": "public, max-age=86400"
    }
  });
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
      if (request.method === "GET" && url.pathname === "/api/foods") return listFoods(url, env);
      if (request.method === "POST" && url.pathname === "/api/foods") return createFood(request, env);
      if (request.method === "GET" && url.pathname === "/api/history") return history(env);
      if (request.method === "GET" && url.pathname === "/api/stats") return stats(env);

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
