// نماذج متصلة مباشرة بالموقع (بدون المرور بالبوابة) — مفاتيحها في متغيرات Vercel
// تُضاف المفاتيح في أسرار GitHub، والنشر التلقائي يمررها للموقع.
// كل متغير يقبل عدة مفاتيح مفصولة بفاصلة، وتُجرّب بالتناوب.

export const DIRECT = [
  {
    id: "gemini", label: "Google Gemini", key: "GEMINI_API_KEY",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    models: ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"],
  },
];

const keysOf = (p) => String(process.env[p.key] || "").split(/[\s,]+/).filter(Boolean);
const modelsOf = (p) => {
  const custom = String(process.env[`${p.id.toUpperCase()}_MODELS`] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return custom.length ? custom : p.models;
};
export const directConfigured = () => DIRECT.filter((p) => keysOf(p).length);

// إيقاف مؤقت لكل (مفتاح، نموذج) بعد 429 أو خطأ — يعيش ما دامت نسخة الدالة شغالة
const cooldown = new Map();
const cooled = (k) => (cooldown.get(k) || 0) > Date.now();
let turn = 0;

/** يرجع Response من أول مزود ينجح (SSE عند stream) مع {provider, model}، أو يرمي خطأ */
export async function directChat({ messages, provider = "auto", max_tokens = 4096, temperature, stream = true }) {
  const list = directConfigured().filter((p) => provider === "auto" || provider === p.id);
  const errors = [];
  const t = turn++;
  for (const p of list) {
    const keys = keysOf(p);
    for (const model of modelsOf(p)) {
      for (let i = 0; i < keys.length; i++) {
        const ki = (t + i) % keys.length;
        const ck = `${p.id}#${ki}|${model}`;
        if (cooled(ck)) continue;
        try {
          const body = { model, messages, max_tokens: Math.min(Number(max_tokens) || 4096, 32000), stream };
          if (temperature != null) body.temperature = temperature;
          const res = await fetch(p.url, {
            method: "POST",
            headers: { Authorization: `Bearer ${keys[ki]}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
          });
          if (res.ok) return { res, provider: p.id, model };
          const text = (await res.text()).slice(0, 200);
          cooldown.set(ck, Date.now() + (res.status === 429 ? 60_000 : res.status === 404 || res.status === 400 ? 600_000 : 30_000));
          errors.push(`${p.id}/${model}: HTTP ${res.status} ${text}`);
        } catch (e) {
          cooldown.set(ck, Date.now() + 30_000);
          errors.push(`${p.id}/${model}: ${e.message}`);
        }
      }
    }
  }
  throw new Error(errors.join(" | ") || "no direct provider configured");
}

/** نص كامل بدون بث (للترجمة والمهام القصيرة) */
export async function directText(messages, opts = {}) {
  const { res } = await directChat({ messages, ...opts, stream: false });
  const j = await res.json();
  const text = j?.choices?.[0]?.message?.content;
  if (!text) throw new Error("empty response");
  return text;
}
