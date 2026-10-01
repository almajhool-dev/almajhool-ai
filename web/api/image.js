// الصور: توليد + حفظ دائم في قاعدة البيانات + قائمة صوري + حذف
import { fallbackImage, toEnglishPrompt } from "./_images.js";
import { directConfigured, directText } from "./_direct.js";
import { HttpError, gateway, json, logUsage, randomId, requireUser, route, sql, usageToday } from "./_lib.js";


export const POST = route(async (request) => {
  const user = await requireUser(request);
  const { prompt, model = "flux", width, height, negative_prompt } = await request.json().catch(() => ({}));
  if (!prompt || String(prompt).length < 2) throw new HttpError(400, "اكتب وصف الصورة");
  const usage = await usageToday(user.id);
  if (user.role !== "admin" && usage.images >= user.daily_images) {
    throw new HttpError(429, `وصلت حدك اليومي (${user.daily_images} صورة). يتجدد غدًا.`);
  }
  // نماذج الصور لا تفهم العربية: نترجم ونحسّن الوصف هنا على الخادم (لا يُحسب من حد التوكنات)
  const english = (await toEnglishPrompt(String(prompt).slice(0, 2000), async (messages) => {
    if (directConfigured().length) {
      try { return await directText(messages, { max_tokens: 300, temperature: 0.4 }); } catch { /* نجرب البوابة */ }
    }
    const r = await gateway("/api/chat", { messages, max_tokens: 300, temperature: 0.4 });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d.text;
  })).slice(0, 2000);
  let data = {};
  try {
    const r = await gateway("/api/image", { prompt: english, model, width, height, negative_prompt });
    data = await r.json().catch(() => ({}));
    if (!r.ok) data = { error: data.error || `HTTP ${r.status}` };
  } catch (e) { data = { error: e.message }; }
  // البوابة فشلت (مثلًا خلصت حصة Cloudflare اليومية 4006)؟ نولّد مباشرة من مصدر مجاني بدون مفتاح
  if (!data.image) {
    try { data = await fallbackImage(english.slice(0, 1500), data.error); }
    catch (e) { throw new HttpError(502, e.message); }
  }
  const [meta, b64] = data.image.split(",");
  const mime = meta.slice(5, meta.indexOf(";")) || "image/jpeg";
  const bytes = Buffer.from(b64, "base64");
  const id = randomId(12);
  const w = data.width || (model === "sdxl" ? Number(width) || 1024 : 1024);
  const h = data.height || (model === "sdxl" ? Number(height) || 1024 : 1024);
  await sql`INSERT INTO images (id, user_id, prompt, model, mime, data, width, height)
            VALUES (${id}, ${user.id}, ${String(prompt).slice(0, 2000)}, ${data.model || model}, ${mime}, ${bytes}, ${w}, ${h})`;
  await logUsage(user.id, "image", 0, data.provider || "workers-ai", data.model || model);
  return json({ id, url: `/i/${id}`, prompt, understood: english !== String(prompt) ? english : null,
    provider: data.provider || null, width: w, height: h, created_at: new Date().toISOString() });
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
