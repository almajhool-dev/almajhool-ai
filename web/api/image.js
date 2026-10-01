// الصور: توليد + حفظ دائم في قاعدة البيانات + قائمة صوري + حذف
import { bestImage, fallbackImage, locateTexts, requestedTexts, toEnglishPrompt } from "./_images.js";
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
  const hasGemini = directConfigured().length > 0;
  const gem = (opts) => (messages) => directText(messages, opts);
  // 1) Gemini يفهم الطلب ويكتب وصفًا غنيًا بالتفاصيل (أو ترجمة Google إذا ما متوفر)
  const english = (await toEnglishPrompt(String(prompt).slice(0, 2000), hasGemini
    ? gem({ max_tokens: 600, temperature: 0.5 })
    : async (messages) => {
      const r = await gateway("/api/chat", { messages, max_tokens: 600, temperature: 0.5 });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      return d.text;
    })).slice(0, 2000);
  // 2) نرسم عدة نسخ بنماذج قوية ويختار Gemini الأقرب لطلبك
  let data = {};
  const viaGateway = async (p) => {
    const r = await gateway("/api/image", { prompt: p, model, width, height, negative_prompt });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.image) throw new Error("gateway: " + String(d.error || r.status).slice(0, 120));
    return { ...d, provider: d.provider || "workers-ai" };
  };
  try { data = await bestImage(english, String(prompt).slice(0, 1000), hasGemini ? gem({ max_tokens: 50 }) : null, [viaGateway]); }
  catch (e) { data = { error: e.message }; }
  // 3) احتياط: البوابة ثم باقي المصادر المجانية
  if (!data.image) {
    try {
      const r = await gateway("/api/image", { prompt: english, model, width, height, negative_prompt });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.image) data = d;
    } catch { /* نكمل */ }
  }
  if (!data.image) {
    try { data = await fallbackImage(english.slice(0, 1500), data.error); }
    catch (e) { throw new HttpError(502, e.message); }
  }
  // الكتابة العربية المطلوبة داخل الصورة: Gemini يحدد مكانها، والمتصفح يكتبها صح فوق الحروف المخربطة
  let overlays = [];
  const texts = requestedTexts(english, prompt);
  if (texts.length && hasGemini) {
    try { overlays = await locateTexts(data.image, texts, String(prompt).slice(0, 500), gem({ max_tokens: 400 })); }
    catch (e) { console.error("locateTexts", e.message); }
  }
  const [meta, b64] = data.image.split(",");
  const mime = meta.slice(5, meta.indexOf(";")) || "image/jpeg";
  const bytes = Buffer.from(b64, "base64");
  const id = randomId(12);
  const w = data.width || (data.provider === "z-image-turbo" ? 1280 : model === "sdxl" ? Number(width) || 1024 : 1024);
  const h = data.height || (data.provider === "z-image-turbo" ? 1280 : model === "sdxl" ? Number(height) || 1024 : 1024);
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
