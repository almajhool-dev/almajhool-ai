// نماذج متصلة مباشرة بالموقع (بدون المرور بالبوابة) — مفاتيحها في متغيرات Vercel
// تُضاف المفاتيح في أسرار GitHub، والنشر التلقائي يمررها للموقع.
// كل متغير يقبل عدة مفاتيح مفصولة بفاصلة، وتُجرّب بالتناوب.

export const DIRECT = [
  {
    id: "gemini", label: "Google Gemini", key: "GEMINI_API_KEY",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    // كل نموذج إله حصة مجانية منفصلة: إذا واحد وصل حده ننتقل للي بعده
    models: ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-2.5-flash-lite", "gemini-2.0-flash"],
    // نماذج Gemini «تفكّر» قبل الرد: نخلي التفكير قليل حتى ما يستهلك كل التوكنات ويطلع الرد فارغ
    extra: { reasoning_effort: "low" },
    minTokens: 1024,
  },
  // ChatGPT ونماذج OpenAI مجانًا — كل واحد يحتاج مفتاح مجاني (أي واحد منهم يكفي)
  {
    id: "chatgpt", label: "ChatGPT (OpenAI GPT-5.4 nano عبر Pollinations)", key: "POLLINATIONS_API_KEY",
    url: "https://gen.pollinations.ai/v1/chat/completions",
    models: ["openai", "openai-fast"],
  },
  {
    id: "chatgpt-groq", label: "ChatGPT (OpenAI GPT-OSS 120B عبر Groq)", key: "GROQ_API_KEY",
    url: "https://api.groq.com/openai/v1/chat/completions",
    models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
  },
  {
    // OpenRouter: نماذج قوية مجانية (Nemotron Ultra 550B، Qwen 3.8، Gemma 4، Inkling…) + موجّه تلقائي لأحسن نموذج مجاني
    id: "openrouter", label: "OpenRouter (نماذج مجانية قوية)", key: "OPENROUTER_API_KEY",
    url: "https://openrouter.ai/api/v1/chat/completions",
    models: ["openrouter/free", "nvidia/nemotron-3-ultra-550b-a55b:free", "qwen/qwen3.8-27b:free", "google/gemma-4-31b-it:free", "thinkingmachines/inkling:free", "nvidia/nemotron-3-super-120b-a12b:free"],
  },
];

export const GPT_IDS = ["chatgpt", "chatgpt-groq"];

const keysOf = (p) => {
  const keys = String(process.env[p.key] || "").split(/[\s,]+/).filter(Boolean);
  return keys.length ? keys : p.keyless ? [""] : [];
};
const modelsOf = (p) => {
  const custom = String(process.env[`${p.id.toUpperCase().replace(/-/g, "_")}_MODELS`] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return custom.length ? custom : p.models;
};
export const directConfigured = () => DIRECT.filter((p) => keysOf(p).length);

// إيقاف مؤقت لكل (مفتاح، نموذج) بعد 429 أو خطأ — يعيش ما دامت نسخة الدالة شغالة
const cooldown = new Map();
const cooled = (k) => (cooldown.get(k) || 0) > Date.now();
let turn = 0;

/** يرجع Response من أول مزود ينجح (SSE عند stream) مع {provider, model}، أو يرمي خطأ */
export async function directChat({ messages, provider = "auto", max_tokens = 4096, temperature, stream = true, prefer, timeout = 30_000 }) {
  const list = directConfigured().filter((p) => provider === "auto" || provider === p.id || (Array.isArray(provider) && provider.includes(p.id)));
  const errors = [];
  const t = turn++;
  for (const p of list) {
    const keys = keysOf(p);
    // prefer: نماذج نفضّلها لهذي المهمة (مثلًا lite للمهام الصغيرة حتى نوفر حصة النموذج الأقوى)
    const all = modelsOf(p);
    const order = prefer ? [...prefer.filter((m) => all.includes(m)), ...all.filter((m) => !prefer.includes(m))] : all;
    for (const model of order) {
      for (let i = 0; i < keys.length; i++) {
        const ki = (t + i) % keys.length;
        const ck = `${p.id}#${ki}|${model}`;
        if (cooled(ck)) continue;
        try {
          const body = { model, messages, ...(p.extra || {}), stream,
            max_tokens: Math.max(p.minTokens || 0, Math.min(Number(max_tokens) || 4096, 32000)) };
          if (temperature != null) body.temperature = temperature;
          const res = await fetch(p.url, {
            method: "POST",
            headers: { ...(keys[ki] ? { Authorization: `Bearer ${keys[ki]}` } : {}), "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeout),
          });
          // بعض الخدمات ترجع 200 بنص عادي (مثل «OK») لمن تكون معطلة: نعتبره فشل حتى ما يطلع جواب فارغ
          const ctype = res.headers.get("content-type") || "";
          if (res.ok && /json|event-stream/i.test(ctype)) return { res, provider: p.id, model };
          if (res.ok) { cooldown.set(ck, Date.now() + 600_000); errors.push(`${p.id}/${model}: unexpected ${ctype || "response"}`); continue; }
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
  // محاولتين: إذا رجع رد فارغ (التفكير استهلك التوكنات) نعيد بحد أكبر
  for (const extra of [0, 4096]) {
    const { res, provider, model } = await directChat({ messages, ...opts, max_tokens: (Number(opts.max_tokens) || 1024) + extra, stream: false });
    const j = await res.json();
    const text = j?.choices?.[0]?.message?.content;
    if (text && text.trim()) return text;
    if (!extra) continue;
    throw new Error(`empty response from ${provider}/${model} (finish_reason: ${j?.choices?.[0]?.finish_reason})`);
  }
}
