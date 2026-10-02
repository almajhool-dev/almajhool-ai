// نماذج متصلة مباشرة بالموقع (بدون المرور بالبوابة) — مفاتيحها في متغيرات Vercel
// تُضاف المفاتيح في أسرار GitHub، والنشر التلقائي يمررها للموقع.
// كل متغير يقبل عدة مفاتيح مفصولة بفاصلة، وتُجرّب بالتناوب.

// كل مصادر الذكاء المجانية بمكان واحد. أي مصدر مفتاحه موجود (أو ما يحتاج مفتاح) يشتغل تلقائيًا،
// ويشارك بـ«كل النماذج مرة وحدة» (_ensemble.js). أي مصدر جديد يُضاف بسطر هنا، أو بدون كود عن طريق
// السر EXTRA_PROVIDERS: [{"id":"x","url":"https://host/v1","key":"X_API_KEY","models":["m1","m2"]}]
const BASE = [
  {
    id: "gemini", label: "Google Gemini", key: "GEMINI_API_KEY",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    // كل نموذج إله حصة مجانية منفصلة: إذا واحد وصل حده ننتقل للي بعده
    models: ["gemini-flash-latest", "gemini-3.8-flash", "gemini-flash-lite-latest", "gemini-3.5-flash", "gemini-2.5-flash-lite"],
    // نماذج Gemini «تفكّر» قبل الرد: نخلي التفكير قليل حتى ما يستهلك كل التوكنات ويطلع الرد فارغ
    extra: { reasoning_effort: "low" },
    minTokens: 1024, lite: ["gemini-flash-lite-latest", "gemini-2.5-flash-lite"],
  },
  {
    // بالتجربة: Nemotron Ultra يجاوب عراقي ممتاز
    id: "openrouter", label: "OpenRouter (Nemotron Ultra 550B…)", key: "OPENROUTER_API_KEY",
    url: "https://openrouter.ai/api/v1/chat/completions",
    models: ["nvidia/nemotron-3-ultra-550b-a55b:free", "nvidia/nemotron-3-super-120b-a12b:free", "qwen/qwen3.8-27b:free", "google/gemma-4-31b-it:free"],
    headers: { "HTTP-Referer": "https://almajhool-ai.vercel.app", "X-Title": "Almajhool AI" }, drafts: 2,
  },
  { id: "chatgpt", label: "ChatGPT (OpenAI عبر Pollinations)", key: "POLLINATIONS_API_KEY",
    url: "https://gen.pollinations.ai/v1/chat/completions", models: ["openai", "openai-fast"] },
  { id: "chatgpt-groq", label: "Groq (OpenAI GPT-OSS 120B)", key: "GROQ_API_KEY",
    url: "https://api.groq.com/openai/v1/chat/completions", models: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "openai/gpt-oss-20b"] },
  { id: "cerebras", label: "Cerebras", key: "CEREBRAS_API_KEY",
    url: "https://api.cerebras.ai/v1/chat/completions", models: ["gpt-oss-120b", "qwen-3-235b-a22b-instruct-2507"] },
  { id: "nvidia", label: "NVIDIA", key: "NVIDIA_API_KEY",
    url: "https://integrate.api.nvidia.com/v1/chat/completions", models: ["meta/llama-3.3-70b-instruct", "qwen/qwen3-235b-a22b", "nvidia/llama-3.3-nemotron-super-49b-v1"] },
  { id: "mistral", label: "Mistral", key: "MISTRAL_API_KEY",
    url: "https://api.mistral.ai/v1/chat/completions", models: ["mistral-medium-latest", "mistral-small-latest"] },
  { id: "zai", label: "Z.ai GLM", key: "ZAI_API_KEY",
    url: "https://api.z.ai/api/paas/v4/chat/completions", models: ["glm-4.7-flash", "glm-4.5-flash"] },
  { id: "sambanova", label: "SambaNova", key: "SAMBANOVA_API_KEY",
    url: "https://api.sambanova.ai/v1/chat/completions", models: ["DeepSeek-V3.1", "Meta-Llama-3.3-70B-Instruct", "gpt-oss-120b"] },
  { id: "cohere", label: "Cohere", key: "COHERE_API_KEY",
    url: "https://api.cohere.ai/compatibility/v1/chat/completions", models: ["command-a-03-2025", "command-r-plus"] },
  { id: "huggingface", label: "Hugging Face", key: "HF_TOKEN",
    url: "https://router.huggingface.co/v1/chat/completions", models: ["openai/gpt-oss-120b", "deepseek-ai/DeepSeek-V3.1", "Qwen/Qwen3-235B-A22B-Instruct-2507"] },
  { id: "vercel-ai", label: "Vercel AI Gateway", key: "AI_GATEWAY_API_KEY",
    url: "https://ai-gateway.vercel.sh/v1/chat/completions", models: ["openai/gpt-oss-120b", "deepseek/deepseek-v3.1"] },
  // بدون أي مفتاح (حدود أقل) — تشارك بالأجوبة حتى لو ما ضفت ولا مفتاح
  { id: "kilo", label: "Kilo (بدون مفتاح)", key: "KILO_API_KEY", keyless: true,
    url: "https://api.kilo.ai/api/gateway/chat/completions", models: ["nvidia/nemotron-3-ultra-550b-a55b:free", "qwen/qwen3.8-27b:free", "poolside/laguna-s-2.1:free"] },
  { id: "llm7", label: "LLM7 (بدون مفتاح)", key: "LLM7_API_KEY", keyless: true,
    url: "https://api.llm7.io/v1/chat/completions", models: ["GLM-5.3-Flash"] },
  { id: "ovh", label: "OVH (بدون مفتاح)", key: "OVH_API_KEY", keyless: true,
    url: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions", models: ["gpt-oss-120b", "Qwen3.5-397B-A17B", "Meta-Llama-3_3-70B-Instruct"] },
];

function extraProviders() {
  try {
    const list = JSON.parse(process.env.EXTRA_PROVIDERS || "[]");
    return (Array.isArray(list) ? list : []).filter((x) => x?.id && x?.url && Array.isArray(x.models) && x.models.length)
      .filter((x) => !BASE.some((p) => p.id === x.id))
      .map((x) => ({ ...x, label: x.label || x.id, url: /\/chat\/completions$/.test(x.url) ? x.url : x.url.replace(/\/$/, "") + "/chat/completions", key: x.key || `${String(x.id).toUpperCase()}_API_KEY` }));
  } catch { return []; }
}
export const DIRECT = [...BASE, ...extraProviders()];
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
            headers: { ...(keys[ki] ? { Authorization: `Bearer ${keys[ki]}` } : {}), ...(p.headers || {}), "Content-Type": "application/json" },
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
