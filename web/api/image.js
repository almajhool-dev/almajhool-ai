// الصور: توليد + حفظ دائم في قاعدة البيانات + قائمة صوري + حذف
import { HttpError, gateway, json, logUsage, randomId, requireUser, route, sql, usageToday } from "./_lib.js";


export const POST = route(async (request) => {
  const user = await requireUser(request);
  const { prompt, model = "flux", width, height, negative_prompt } = await request.json().catch(() => ({}));
  if (!prompt || String(prompt).length < 2) throw new HttpError(400, "اكتب وصف الصورة");
  const usage = await usageToday(user.id);
  if (user.role !== "admin" && usage.images >= user.daily_images) {
    throw new HttpError(429, `وصلت حدك اليومي (${user.daily_images} صورة). يتجدد غدًا.`);
  }
  const r = await gateway("/api/image", { prompt: String(prompt).slice(0, 2000), model, width, height, negative_prompt });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.image) throw new HttpError(502, data.error || "فشل توليد الصورة");
  const [meta, b64] = data.image.split(",");
  const mime = meta.slice(5, meta.indexOf(";")) || "image/jpeg";
  const bytes = Buffer.from(b64, "base64");
  const id = randomId(12);
  const w = model === "sdxl" ? Number(width) || 1024 : 1024;
  const h = model === "sdxl" ? Number(height) || 1024 : 1024;
  await sql`INSERT INTO images (id, user_id, prompt, model, mime, data, width, height)
            VALUES (${id}, ${user.id}, ${String(prompt).slice(0, 2000)}, ${data.model || model}, ${mime}, ${bytes}, ${w}, ${h})`;
  await logUsage(user.id, "image", 0, "workers-ai", data.model || model);
  return json({ id, url: `/i/${id}`, prompt, width: w, height: h, created_at: new Date().toISOString() });
});

export const GET = route(async (request) => {
  const user = await requireUser(request);
  const rows = await sql`SELECT id, prompt, width, height, created_at FROM images
                         WHERE user_id = ${user.id} ORDER BY created_at DESC LIMIT 100`;
  return json(rows.map((r) => ({ ...r, url: `/i/${r.id}` })));
});

export const DELETE = route(async (request) => {
  const user = await requireUser(request);
  const id = new URL(request.url).searchParams.get("id");
  const rows = user.role === "admin"
    ? await sql`DELETE FROM images WHERE id = ${id} RETURNING id`
    : await sql`DELETE FROM images WHERE id = ${id} AND user_id = ${user.id} RETURNING id`;
  if (!rows.length) throw new HttpError(404, "الصورة غير موجودة");
  return json({ deleted: id });
});
