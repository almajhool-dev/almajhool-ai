// توليد صور احتياطي بدون مفتاح — يُستخدم إذا فشلت البوابة (مثل خطأ Cloudflare 4006)
// ملف يبدأ بـ _ فلا يصبح مسارًا في Vercel
// مساحات Hugging Face العامة (Gradio) — تعمل بدون مفتاح (وبحصة أكبر إذا وُجد HF_TOKEN)
const SPACES = [
  // Z-Image Turbo: جودة عالية والتزام قوي بالوصف (أدق من FLUX schnell)
  { id: "z-image-turbo", base: "https://mrfakename-z-image-turbo.hf.space", api: "generate_image",
    data: (p, seed) => [p, 1280, 1280, 9, seed, false] },
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
// العربي المسموح بالوصف هو النص المطلوب كتابته داخل الصورة فقط (بين علامتي تنصيص)
const arabicOutsideQuotes = (s) => hasArabic(String(s || "").replace(/["“”«»][^"“”«»]*["“”«»]/g, ""));

const IMG_SYSTEM = `You are an expert prompt engineer for state-of-the-art text-to-image models.
Turn the user's request (Arabic in any dialect incl. Iraqi slang and typos, or English) into ONE rich English prompt of 80-140 words.
Rules:
- Keep EVERY detail the user asked for (subject, count, colors, clothing, pose, place, style, mood). Never drop or contradict any of them; never add unrelated subjects.
- Start with the main subject and what it is doing, then: specific visual attributes and materials, setting/background, composition and camera (shot type, angle, lens), lighting, color palette, art style or medium, and quality cues (highly detailed, sharp focus, intricate textures).
- If no style is given, choose the one that best fits the request (e.g. photorealistic for real things, clean vector for logos).
- Logos/icons: centered, clean background, simple bold shapes.
- Text inside the image only if asked: put it in double quotes exactly as written (keep Arabic as Arabic), say where it appears (e.g. an embroidered patch on the chest), and keep it short.
- Flags, uniforms, emblems and landmarks: describe their real colors, layout and symbols precisely in words (exact stripes, colors and emblem of the named flag), so the image model draws them correctly.
- Output only the prompt, no preface.`;

export async function googleTranslate(text) {
  const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=" + encodeURIComponent(text);
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`translate HTTP ${res.status}`);
  const data = await res.json();
  return (data?.[0] || []).map((x) => x?.[0] || "").join("").trim();
}

/** chatFn(messages) → نص (اختياري، مثل البوابة) */
export async function toEnglishPrompt(prompt, chatFn) {
  // مع Gemini نحسّن كل طلب (عربي أو إنجليزي)؛ بدونه نترجم العربي فقط
  if (!chatFn && !hasArabic(prompt)) return prompt;
  if (chatFn) {
    try {
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20_000));
      const t = String(await Promise.race([chatFn([{ role: "system", content: IMG_SYSTEM }, { role: "user", content: prompt }]), timeout]) || "")
        .trim().replace(/^["'`]+|["'`]+$/g, "");
      if (t && !arabicOutsideQuotes(t) && t.length > 10) return t;
    } catch { /* ننتقل للترجمة */ }
  }
  if (!hasArabic(prompt)) return prompt;
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

// ------------------------------------------------------------------ أفضل صورة: نرسم نسختين بالتوازي ويختار Gemini الأقرب للطلب
async function spaceImage(sp, prompt, seed) {
  let res;
  try { res = await runSpace(sp, prompt, seed); } catch (e) { throw new Error(`${sp.id}: ${e.message}`); }
  const mime = (res.headers.get("content-type") || "").split(";")[0];
  if (!res.ok || !mime.startsWith("image/")) throw new Error(`${sp.id}: HTTP ${res.status}`);
  return { image: `data:${mime};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`, provider: sp.id, model: sp.id };
}

/** judgeFn(messages) → نص (نموذج يرى الصور، مثل Gemini). يرجع رقم الصورة الأفضل (0-based) */
async function pickBest(candidates, request, judgeFn) {
  const content = [{ type: "text", text:
    `User's image request (may be Arabic/Iraqi dialect): "${request}"\n` +
    `Compare the ${candidates.length} images below. Which one follows the request most faithfully (every requested subject, detail, color, style and composition) and has the best quality and fewest defects (deformed hands/faces, garbled text, artifacts)? Answer with only the image number.` }];
  candidates.forEach((c, i) => {
    content.push({ type: "text", text: `Image ${i + 1}:` });
    content.push({ type: "image_url", image_url: { url: c.image } });
  });
  const answer = String(await judgeFn([{ role: "user", content }]) || "");
  const n = parseInt((answer.match(/\d+/) || [])[0], 10);
  return n >= 1 && n <= candidates.length ? n - 1 : 0;
}

export async function bestImage(prompt, request, judgeFn) {
  const seed = Math.floor(Math.random() * 2_000_000_000);
  const z = SPACES.find((s) => s.id === "z-image-turbo");
  const f = SPACES.find((s) => s.id === "flux-schnell");
  // حصة GPU المجانية في Hugging Face صغيرة (≈90 ثانية لكل صورة)، فالرسم المتعدد يستهلكها أسرع.
  // BEST_OF=1 (الافتراضي): صورة وحدة بأقوى نموذج. BEST_OF=2 أو 3: عدة نسخ ويختار Gemini الأفضل (يحتاج HF_TOKEN بحصة أكبر).
  const n = Math.max(1, Math.min(3, Number(process.env.BEST_OF) || 1));
  const jobs = [spaceImage(z, prompt, seed), spaceImage(f, prompt, seed + 104729), spaceImage(z, prompt, seed + 7919)].slice(0, n);
  const settled = await Promise.allSettled(jobs);
  const results = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const errors = settled.filter((r) => r.status === "rejected").map((r) => String(r.reason?.message || r.reason).slice(0, 160));
  if (!results.length) throw new Error("best-of: no candidate succeeded: " + errors.join(" | "));
  if (results.length === 1 || !judgeFn) return { ...results[0], candidates: results.length, errors };
  try {
    const i = await pickBest(results, request || prompt, judgeFn);
    return { ...results[i], candidates: results.length, judged: true };
  } catch { return { ...results[0], candidates: results.length }; }
}
