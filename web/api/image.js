// الصور: توليد + حفظ دائم في قاعدة البيانات + قائمة صوري + حذف
import { HttpError, gateway, json, logUsage, randomId, requireUser, route, sql, usageToday } from "./_lib.js";


async function fallbackImage(prompt, gatewayError) {
  const errors = [String(gatewayError || "gateway").slice(0, 160)];
  const seed = Math.floor(Math.random() * 1e9);
  const sources = [];
  if (process.env.HF_TOKEN) sources.push(["huggingface", () => fetch("https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell", {
    method: "POST", headers: { Authorization: `Bearer ${process.env.HF_TOKEN}`, "Content-Type": "application/json", Accept: "image/jpeg" },
    body: JSON.stringify({ inputs: prompt, parameters: { seed } }), signal: AbortSignal.timeout(50_000) })]);
  sources.push(["pollinations", () => fetch(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&seed=${seed}&nologo=true&model=flux`,
    { headers: process.env.POLLINATIONS_API_KEY ? { Authorization: `Bearer ${process.env.POLLINATIONS_API_KEY}` } : {}, signal: AbortSignal.timeout(50_000) })]);
  for (const [provider, run] of sources) {
    try {
      const res = await run();
      const mime = (res.headers.get("content-type") || "").split(";")[0];
      if (!res.ok || !mime.startsWith("image/")) { errors.push(`${provider}: HTTP ${res.status}`); continue; }
      const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
      return { image: `data:${mime};base64,${b64}`, model: provider + "/flux", provider, width: 1024, height: 1024 };
    } catch (e) { errors.push(`${provider}: ${e.message}`); }
  }
  throw new HttpError(502, "تعذّر توليد الصورة الآن من كل المصادر، جرّب بعد دقيقة. (" + errors.join(" · ").slice(0, 300) + ")");
}

export const POST = route(async (request) => {
  const user = await requireUser(request);
  const { prompt, model = "flux", width, height, negative_prompt } = await request.json().catch(() => ({}));
  if (!prompt || String(prompt).length < 2) throw new HttpError(400, "اكتب وصف الصورة");
  const usage = await usageToday(user.id);
  if (user.role !== "admin" && usage.images >= user.daily_images) {
    throw new HttpError(429, `وصلت حدك اليومي (${user.daily_images} صورة). يتجدد غدًا.`);
  }
  let data = {};
  try {
    const r = await gateway("/api/image", { prompt: String(prompt).slice(0, 2000), model, width, height, negative_prompt });
    data = await r.json().catch(() => ({}));
    if (!r.ok) data = { error: data.error || `HTTP ${r.status}` };
  } catch (e) { data = { error: e.message }; }
  // البوابة فشلت (مثلًا خلصت حصة Cloudflare اليومية 4006)؟ نولّد مباشرة من مصدر مجاني بدون مفتاح
  if (!data.image) data = await fallbackImage(String(prompt).slice(0, 1500), data.error);
  const [meta, b64] = data.image.split(",");
  const mime = meta.slice(5, meta.indexOf(";")) || "image/jpeg";
  const bytes = Buffer.from(b64, "base64");
  const id = randomId(12);
  const w = data.width || (model === "sdxl" ? Number(width) || 1024 : 1024);
  const h = data.height || (model === "sdxl" ? Number(height) || 1024 : 1024);
  await sql`INSERT INTO images (id, user_id, prompt, model, mime, data, width, height)
            VALUES (${id}, ${user.id}, ${String(prompt).slice(0, 2000)}, ${data.model || model}, ${mime}, ${bytes}, ${w}, ${h})`;
  await logUsage(user.id, "image", 0, data.provider || "workers-ai", data.model || model);
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
