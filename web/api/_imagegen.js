// توليد صورة كاملة (فهم الطلب ← أفضل رسمة ← أماكن الكتابة العربية) — مشترك بين الموقع وبوت تلكرام
import { bestImage, fallbackImage, locateTexts, requestedTexts, toEnglishPrompt } from "./_images.js";
import { directConfigured, directText } from "./_direct.js";
import { gateway } from "./_lib.js";

export class ImageError extends Error {}

/** يرجع { data, english, overlays, mime, bytes, w, h } */
export async function generateImage({ prompt, model = "flux", width, height, negative_prompt }) {
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
  try { data = await bestImage(english, String(prompt).slice(0, 1000), hasGemini ? gem({ max_tokens: 50, prefer: ["gemini-flash-lite-latest", "gemini-2.5-flash-lite"], timeout: 45_000 }) : null, [viaGateway]); }
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
    catch (e) { throw new ImageError(e.message); }
  }
  // الكتابة العربية المطلوبة داخل الصورة: Gemini يحدد مكانها، والمتصفح يكتبها صح فوق الحروف المخربطة
  let overlays = [];
  const texts = requestedTexts(english, prompt);
  if (texts.length && hasGemini) {
    try { overlays = await locateTexts(data.image, texts, String(prompt).slice(0, 500), gem({ max_tokens: 400, timeout: 45_000 })); }
    catch (e) { console.error("locateTexts", e.message); }
  }
  const [meta, b64] = data.image.split(",");
  const mime = meta.slice(5, meta.indexOf(";")) || "image/jpeg";
  const bytes = Buffer.from(b64, "base64");
  const w = data.width || (data.provider === "z-image-turbo" ? 1280 : model === "sdxl" ? Number(width) || 1024 : 1024);
  const h = data.height || (data.provider === "z-image-turbo" ? 1280 : model === "sdxl" ? Number(height) || 1024 : 1024);
  return { data, english, overlays, mime, bytes, w, h };
}
