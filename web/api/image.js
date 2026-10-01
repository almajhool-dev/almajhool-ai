// الصور: توليد + حفظ دائم في قاعدة البيانات + قائمة صوري + حذف
import { ImageError, generateImage } from "./_imagegen.js";
import { HttpError, json, logUsage, randomId, requireUser, route, sql, usageToday } from "./_lib.js";


export const POST = route(async (request) => {
  const user = await requireUser(request);
  const { prompt, model = "flux", width, height, negative_prompt } = await request.json().catch(() => ({}));
  if (!prompt || String(prompt).length < 2) throw new HttpError(400, "اكتب وصف الصورة");
  const usage = await usageToday(user.id);
  if (user.role !== "admin" && usage.images >= user.daily_images) {
    throw new HttpError(429, `وصلت حدك اليومي (${user.daily_images} صورة). يتجدد غدًا.`);
  }
  let r;
  try { r = await generateImage({ prompt, model, width, height, negative_prompt }); }
  catch (e) { if (e instanceof ImageError) throw new HttpError(502, e.message); throw e; }
  const { data, english, overlays, mime, bytes, w, h } = r;
  const id = randomId(12);
  await sql`INSERT INTO images (id, user_id, prompt, model, mime, data, width, height)
            VALUES (${id}, ${user.id}, ${String(prompt).slice(0, 2000)}, ${data.model || model}, ${mime}, ${bytes}, ${w}, ${h})`;
  await logUsage(user.id, "image", 0, data.provider || "workers-ai", data.model || model);
  return json({ id, url: `/i/${id}`, prompt, understood: english !== String(prompt) ? english : null,
    provider: data.provider || null, candidates: data.candidates || 1, overlays, width: w, height: h, created_at: new Date().toISOString() });
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

// حفظ النسخة المصححة (بعد كتابة النص العربي فوق الصورة في المتصفح)
export const PUT = route(async (request) => {
  const user = await requireUser(request);
  const { id, image } = await request.json().catch(() => ({}));
  const m = String(image || "").match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!id || !m) throw new HttpError(400, "صورة غير صالحة");
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length > 8 * 1024 * 1024) throw new HttpError(413, "الصورة كبيرة");
  const rows = await sql`UPDATE images SET data = ${bytes}, mime = ${m[1]} WHERE id = ${String(id)} AND user_id = ${user.id} RETURNING id`;
  if (!rows.length) throw new HttpError(404, "الصورة غير موجودة");
  return json({ id, url: `/i/${id}?v=2` });
});
