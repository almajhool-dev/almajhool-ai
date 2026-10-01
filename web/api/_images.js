// توليد صور احتياطي بدون مفتاح — يُستخدم إذا فشلت البوابة (مثل خطأ Cloudflare 4006)
// ملف يبدأ بـ _ فلا يصبح مسارًا في Vercel
// مساحات Hugging Face العامة (Gradio) — تعمل بدون مفتاح (وبحصة أكبر إذا وُجد HF_TOKEN)
const SPACES = [
  // Z-Image Turbo: جودة عالية والتزام قوي بالوصف (أدق من FLUX schnell)
  { id: "z-image-turbo", base: "https://mrfakename-z-image-turbo.hf.space", api: "generate_image",
    data: (p, seed) => [p, 1024, 1024, 9, seed, false] },
  { id: "flux-schnell", base: "https://black-forest-labs-flux-1-schnell.hf.space", api: "infer",
    data: (p, seed) => [p, seed, false, 1024, 1024, 4] },
  { id: "sd3.5-turbo", base: "https://stabilityai-stable-diffusion-3-5-large-turbo.hf.space", api: "infer",
    data: (p, seed) => [p, "", seed, false, 1024, 1024, 0, 4] },
];

async function runSpace(sp, prompt, seed) {
  const headers = { "Content-Type": "application/json" };
  if (process.env.HF_TOKEN) headers.Authorization = `Bearer ${process.env.HF_TOKEN}`;
  const start = await fetch(`${sp.base}/gradio_api/call/${sp.api}`, {
    method: "POST", headers, body: JSON.stringify({ data: sp.data(prompt, seed) }), signal: AbortSignal.timeout(15_000) });
  const { event_id } = await start.json().catch(() => ({}));
  if (!start.ok || !event_id) throw new Error(`HTTP ${start.status}`);
  const res = await fetch(`${sp.base}/gradio_api/call/${sp.api}/${event_id}`, { headers, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  const all = [...text.matchAll(/event:\s*complete\s*\ndata:\s*(.+)/g)];
  const m = all[all.length - 1];
  if (!m) throw new Error((text.match(/event:\s*error\s*\ndata:\s*(.+)/)?.[1] || "no result").slice(0, 120));
  const out = JSON.parse(m[1])[0];
  const url = out?.url || (out?.path && `${sp.base}/gradio_api/file=${out.path}`);
  if (!url) throw new Error("no image url");
  return fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
}

export async function fallbackImage(prompt, gatewayError) {
  const errors = [String(gatewayError || "gateway").slice(0, 80)];
  const seed = Math.floor(Math.random() * 2_000_000_000);
  const enc = encodeURIComponent(prompt);
  const sources = [];
  if (process.env.HF_TOKEN) sources.push(["huggingface", () => fetch("https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell", {
    method: "POST", headers: { Authorization: `Bearer ${process.env.HF_TOKEN}`, "Content-Type": "application/json", Accept: "image/jpeg" },
    body: JSON.stringify({ inputs: prompt, parameters: { seed } }), signal: AbortSignal.timeout(40_000) })]);
  for (const sp of SPACES) sources.push([sp.id, () => runSpace(sp, prompt, seed)]);
  const polHeaders = process.env.POLLINATIONS_API_KEY ? { Authorization: `Bearer ${process.env.POLLINATIONS_API_KEY}` } : {};
  for (const model of ["flux", "turbo"]) sources.push([`pollinations-${model}`, () => fetch(
    `https://image.pollinations.ai/prompt/${enc}?width=1024&height=1024&seed=${seed}&nologo=true&model=${model}&referrer=almajhool-ai.vercel.app`,
    { headers: polHeaders, signal: AbortSignal.timeout(20_000) })]);
  for (const [provider, run] of sources) {
    try {
      const res = await run();
      const mime = (res.headers.get("content-type") || "").split(";")[0];
      if (!res.ok || !mime.startsWith("image/")) { errors.push(`${provider}: HTTP ${res.status}`); continue; }
      const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
      return { image: `data:${mime};base64,${b64}`, model: provider, provider, width: 1024, height: 1024 };
    } catch (e) { errors.push(`${provider}: ${String(e.message).slice(0, 80)}`); }
  }
  throw new Error("تعذّر توليد الصورة الآن، كل المصادر المجانية مشغولة. جرّب بعد دقيقة. (" + errors.join(" · ").slice(0, 300) + ")");
}


// ------------------------------------------------------------------ فهم الطلب العربي
// نماذج الصور لا تفهم العربية: نحوّل الوصف إلى برومبت إنجليزي قبل التوليد.
// 1) نموذج لغوي عبر البوابة (يفهم اللهجات ويحسّن الوصف) — 2) ترجمة Google المجانية بدون مفتاح — 3) الوصف كما هو
export const hasArabic = (s) => /[؀-ۿ]/.test(String(s || ""));

const IMG_SYSTEM = "You turn any image request (Arabic in any dialect, including Iraqi slang and typos, or English) into ONE vivid English prompt for a text-to-image model, max 70 words. Understand the user's real intent (e.g. 'صمم صور الامن السيبراني' = cybersecurity themed illustration). Remove words like 'draw me'/'ارسملي'/'سويلي'. Keep any text that must appear inside the image in quotes. Output only the prompt.";

export async function googleTranslate(text) {
  const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=" + encodeURIComponent(text);
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`translate HTTP ${res.status}`);
  const data = await res.json();
  return (data?.[0] || []).map((x) => x?.[0] || "").join("").trim();
}

/** chatFn(messages) → نص (اختياري، مثل البوابة) */
export async function toEnglishPrompt(prompt, chatFn) {
  if (!hasArabic(prompt)) return prompt;
  if (chatFn) {
    try {
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20_000));
      const t = String(await Promise.race([chatFn([{ role: "system", content: IMG_SYSTEM }, { role: "user", content: prompt }]), timeout]) || "")
        .trim().replace(/^["'`]+|["'`]+$/g, "");
      if (t && !hasArabic(t)) return t;
    } catch { /* ننتقل للترجمة */ }
  }
  try {
    const t = await googleTranslate(prompt);
    if (t) return `${t}, highly detailed, high quality`;
  } catch { /* نكمل بالوصف الأصلي */ }
  return prompt;
}

// ------------------------------------------------------------------ رسم مباشر بـ Gemini (يفهم الطلب ويرسمه بنفسه — أدق بكثير من FLUX)
const GEMINI_IMAGE_MODELS = ["gemini-2.5-flash-image", "gemini-3-pro-image-preview", "gemini-2.0-flash-preview-image-generation"];
const gemImgCooldown = new Map();

/** يرجع {image, model} أو يرمي خطأ. prompt يمكن أن يكون بالعربي مباشرة */
export async function geminiImage(prompt, apiKey = process.env.GEMINI_API_KEY) {
  const keys = String(apiKey || "").split(/[\s,]+/).filter(Boolean);
  if (!keys.length) throw new Error("no GEMINI_API_KEY");
  const custom = String(process.env.GEMINI_IMAGE_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const errors = [];
  for (const model of custom.length ? custom : GEMINI_IMAGE_MODELS) {
    for (const [ki, key] of keys.entries()) {
      const ck = `${ki}|${model}`;
      if ((gemImgCooldown.get(ck) || 0) > Date.now()) continue;
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: `Generate one high-quality image that follows this request exactly (the request may be in Arabic or Iraqi dialect; any text that must appear in the image should be written exactly as requested): ${prompt}` }] }],
            generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
          }),
          signal: AbortSignal.timeout(60_000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = data?.error?.message || `HTTP ${res.status}`;
          // حصة مجانية صفر/منتهية أو نموذج غير موجود: نوقفه فترة طويلة حتى ما نضيع وقت كل طلب
          gemImgCooldown.set(ck, Date.now() + (res.status === 429 || res.status === 404 || res.status === 400 ? 3 * 3600_000 : 60_000));
          errors.push(`${model}: ${msg.slice(0, 160)}`);
          continue;
        }
        const part = (data?.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data || p.inline_data?.data);
        const inline = part?.inlineData || part?.inline_data;
        if (!inline) { errors.push(`${model}: no image in response`); continue; }
        return { image: `data:${inline.mimeType || inline.mime_type || "image/png"};base64,${inline.data}`, model, provider: "gemini" };
      } catch (e) {
        gemImgCooldown.set(ck, Date.now() + 60_000);
        errors.push(`${model}: ${String(e.message).slice(0, 120)}`);
      }
    }
  }
  throw new Error(errors.join(" | "));
}
