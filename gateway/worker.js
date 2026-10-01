// بوابة الذكاء المجانية v4 — Cloudflare Worker
// تجمع كل مصادر الذكاء الاصطناعي المجانية (بمفتاح وبدون مفتاح) في نقطة واحدة،
// وتوزّع الطلبات عليها بالتناوب، وتتخطى أي مصدر وصل حده مؤقتًا، وتنتقل للتالي تلقائيًا.
// كل متغير مفتاح يقبل عدة مفاتيح مفصولة بفاصلة (مفاتيح فريقك/مشاريعك) وتُستخدم بالتناوب.
// EXTRA_PROVIDERS (JSON) يضيف أي مزود متوافق مع OpenAI بدون تعديل الكود.
//
// 1) خادم MCP لكلود:            POST /mcp/<ACCESS_TOKEN>
// 2) API (CORS):                 POST /api/chat (يدعم stream) · POST /api/image · GET /api/providers
//    (تتطلب Authorization: Bearer <ACCESS_TOKEN>)

const VERSION = "4.0.0";

// tier 1 = نماذج قوية · tier 2 = مصادر احتياطية بدون مفتاح · Workers AI = آخر احتياط
// keyless: يعمل بدون أي مفتاح · key: اسم المتغير في Cloudflare · models: تُجرّب بالتناوب (يمكن تجاوزها بـ <ID>_MODELS)
const PROVIDERS = [
  { id: "cerebras", tier: 1, url: "https://api.cerebras.ai/v1", key: "CEREBRAS_API_KEY", usage: true, maxOut: 32000,
    models: ["gpt-oss-120b", "qwen-3-235b-a22b-instruct-2507"], cap: "≈1,000,000 توكن/يوم", signup: "https://cloud.cerebras.ai" },
  { id: "groq", tier: 1, url: "https://api.groq.com/openai/v1", key: "GROQ_API_KEY", usage: true, maxOut: 32000,
    models: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"], cap: "≈200K–500K توكن/يوم", signup: "https://console.groq.com/keys" },
  { id: "gemini", tier: 1, url: "https://generativelanguage.googleapis.com/v1beta/openai", key: "GEMINI_API_KEY", maxOut: 65000,
    models: ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"], cap: "≈250–1500 طلب/يوم", signup: "https://aistudio.google.com/apikey" },
  { id: "nvidia", tier: 1, url: "https://integrate.api.nvidia.com/v1", key: "NVIDIA_API_KEY", maxOut: 16000,
    models: ["meta/llama-3.3-70b-instruct", "qwen/qwen3-235b-a22b", "nvidia/llama-3.3-nemotron-super-49b-v1"], cap: "≈10,000 طلب/يوم لكل نموذج", signup: "https://build.nvidia.com" },
  { id: "mistral", tier: 1, url: "https://api.mistral.ai/v1", key: "MISTRAL_API_KEY", maxOut: 32000,
    models: ["mistral-medium-latest", "mistral-small-latest"], cap: "رصيد مجاني شهري", signup: "https://console.mistral.ai/api-keys" },
  { id: "zai", tier: 1, url: "https://api.z.ai/api/paas/v4", key: "ZAI_API_KEY", maxOut: 16000,
    models: ["glm-4.7-flash", "glm-4.5-flash"], cap: "مجاني دائم (طلب واحد بنفس اللحظة)", signup: "https://z.ai/manage-apikey/apikey-list" },
  { id: "openrouter", tier: 1, url: "https://openrouter.ai/api/v1", key: "OPENROUTER_API_KEY", usage: true, maxOut: 32000, routerList: true,
    models: ["nvidia/nemotron-3-super-120b-a12b:free", "qwen/qwen3.8-27b:free", "google/gemma-4-31b-it:free"],
    headers: { "HTTP-Referer": "https://almajhool-ai.vercel.app", "X-Title": "Almajhool AI" },
    cap: "50 طلب/يوم (1000 مع شحن 10$)", signup: "https://openrouter.ai/keys" },
  { id: "kilo", tier: 1, url: "https://api.kilo.ai/api/gateway", key: "KILO_API_KEY", keyless: true, maxOut: 16000,
    models: ["nvidia/nemotron-3-ultra-550b-a55b:free", "qwen/qwen3.8-27b:free", "poolside/laguna-s-2.1:free"], cap: "≈200 طلب/ساعة بدون مفتاح" },
  { id: "llm7", tier: 2, url: "https://api.llm7.io/v1", key: "LLM7_API_KEY", keyless: true, maxOut: 8000,
    models: ["GLM-5.3-Flash"], cap: "≈60 طلب/ساعة بدون مفتاح", signup: "https://token.llm7.io" },
  { id: "ovh", tier: 2, url: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", key: "OVH_API_KEY", keyless: true, maxOut: 8000,
    models: ["Meta-Llama-3_3-70B-Instruct", "gpt-oss-120b", "Qwen3.5-397B-A17B", "Mistral-Small-3.2-24B-Instruct-2506"],
    cap: "2 طلب/دقيقة لكل نموذج بدون مفتاح" },
  { id: "pollinations", tier: 2, url: "https://text.pollinations.ai/openai", key: "POLLINATIONS_API_KEY", keyless: true, maxOut: 8000,
    models: ["openai"], cap: "بدون مفتاح (حدود غير معلنة)" },
  // ---- v4: مصادر مجانية إضافية (كلها متوافقة مع OpenAI — غيّر النماذج بـ <ID>_MODELS إذا تبدّلت)
  { id: "github", tier: 1, url: "https://models.github.ai/inference", key: "GITHUB_MODELS_TOKEN", maxOut: 4000,
    models: ["openai/gpt-4.1", "openai/gpt-4o", "deepseek/DeepSeek-V3-0324", "meta/Llama-4-Maverick-17B-128E-Instruct-FP8"],
    cap: "≈50–150 طلب/يوم لكل نموذج (توكن GitHub عادي بصلاحية models)", signup: "https://github.com/settings/personal-access-tokens" },
  { id: "sambanova", tier: 1, url: "https://api.sambanova.ai/v1", key: "SAMBANOVA_API_KEY", usage: true, maxOut: 16000,
    models: ["DeepSeek-V3.1", "Meta-Llama-3.3-70B-Instruct", "gpt-oss-120b"], cap: "طبقة مجانية بحدود بالدقيقة", signup: "https://cloud.sambanova.ai/apis" },
  { id: "cohere", tier: 1, url: "https://api.cohere.ai/compatibility/v1", key: "COHERE_API_KEY", maxOut: 8000,
    models: ["command-a-03-2025", "command-r-plus"], cap: "مفتاح تجريبي ≈1000 طلب/شهر", signup: "https://dashboard.cohere.com/api-keys" },
  { id: "cloudflare", tier: 1, url: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1", key: "CLOUDFLARE_API_TOKEN",
    needs: ["CLOUDFLARE_ACCOUNT_ID"], maxOut: 8000,
    models: ["@cf/openai/gpt-oss-120b", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/qwen/qwen3-30b-a3b-fp8"],
    cap: "10K neurons/يوم لحساب Cloudflare إضافي", signup: "https://dash.cloudflare.com/profile/api-tokens" },
  { id: "huggingface", tier: 2, url: "https://router.huggingface.co/v1", key: "HF_TOKEN", maxOut: 8000,
    models: ["openai/gpt-oss-120b", "deepseek-ai/DeepSeek-V3.1", "Qwen/Qwen3-235B-A22B-Instruct-2507"], cap: "رصيد مجاني شهري صغير", signup: "https://huggingface.co/settings/tokens" },
  { id: "scaleway", tier: 2, url: "https://api.scaleway.ai/v1", key: "SCALEWAY_API_KEY", maxOut: 8000,
    models: ["gpt-oss-120b", "llama-3.3-70b-instruct", "qwen3-235b-a22b-instruct-2507"], cap: "أول 1,000,000 توكن مجانًا", signup: "https://console.scaleway.com/iam/api-keys" },
  { id: "vercel", tier: 2, url: "https://ai-gateway.vercel.sh/v1", key: "AI_GATEWAY_API_KEY", usage: true, maxOut: 16000,
    models: ["openai/gpt-oss-120b", "google/gemini-2.5-flash", "deepseek/deepseek-v3.1"], cap: "رصيد 5$ مجاني شهريًا", signup: "https://vercel.com/dashboard/ai-gateway" },
  { id: "nebius", tier: 2, url: "https://api.studio.nebius.com/v1", key: "NEBIUS_API_KEY", maxOut: 8000,
    models: ["openai/gpt-oss-120b", "deepseek-ai/DeepSeek-V3-0324", "meta-llama/Llama-3.3-70B-Instruct"], cap: "رصيد ترحيبي مجاني", signup: "https://studio.nebius.com/settings/api-keys" },
  { id: "hyperbolic", tier: 2, url: "https://api.hyperbolic.xyz/v1", key: "HYPERBOLIC_API_KEY", maxOut: 8000,
    models: ["openai/gpt-oss-120b", "meta-llama/Llama-3.3-70B-Instruct", "deepseek-ai/DeepSeek-V3"], cap: "رصيد ترحيبي مجاني", signup: "https://app.hyperbolic.xyz/settings" },
];

/** مزودون إضافيون من المتغير EXTRA_PROVIDERS:
 *  [{"id":"myapi","url":"https://host/v1","key":"MYAPI_KEY","models":["model-a"],"cap":"..."}] */
let extraCache = null;
function allProviders(env) {
  if (extraCache && extraCache.raw === env.EXTRA_PROVIDERS) return extraCache.list;
  let extra = [];
  try {
    const parsed = JSON.parse(env.EXTRA_PROVIDERS || "[]");
    extra = (Array.isArray(parsed) ? parsed : [])
      .filter((x) => x && x.id && x.url && Array.isArray(x.models) && x.models.length)
      .filter((x) => !PROVIDERS.some((p) => p.id === x.id))
      .map((x) => ({ tier: 2, maxOut: 8000, ...x, extra: true }));
  } catch { /* JSON غير صالح: نتجاهله */ }
  extraCache = { raw: env.EXTRA_PROVIDERS, list: [...PROVIDERS, ...extra] };
  return extraCache.list;
}

// نموذج نصي على Cloudflare نفسه — يعمل بدون أي مفتاح ضمن الحصة اليومية المجانية
const WORKERS_AI_TEXT = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const IMAGE_MODELS = {
  flux: { id: "@cf/black-forest-labs/flux-1-schnell", label: "FLUX.1 schnell", sizes: false },
  sdxl: { id: "@cf/bytedance/stable-diffusion-xl-lightning", label: "SDXL Lightning", sizes: true },
};

const TOOLS = [
  {
    name: "ask_model",
    description: "Send a prompt to free AI models. Spreads load across many free providers and falls back automatically when one hits its limit.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The message to send" },
        system: { type: "string", description: "Optional system instruction" },
        provider: { type: "string", description: `auto (default) or a provider id: ${PROVIDERS.map((p) => p.id).join(", ")}, workers-ai` },
        max_tokens: { type: "number", description: "Max output tokens (default 4096)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "generate_image",
    description: "Generate an image from a text description (free daily quota on Cloudflare Workers AI).",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Image description (English works best)" },
        model: { type: "string", enum: ["flux", "sdxl"] },
      },
      required: ["prompt"],
    },
  },
  { name: "list_providers", description: "List all providers, their status and free capacity.",
    inputSchema: { type: "object", properties: {} } },
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Expose-Headers": "X-Provider, X-Model",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

// ------------------------------------------------------------------ حالة التوجيه (لكل نسخة من الـ Worker)
const cooldown = new Map(); // "provider|model" أو "provider" → وقت انتهاء الإيقاف المؤقت
const stats = new Map();    // provider → { ok, fail, tokens, last_error, last_ok }
let rr = 0;                 // عدّاد التناوب

const now = () => Date.now();
const cooled = (k) => (cooldown.get(k) || 0) > now();
function stat(id) {
  if (!stats.has(id)) stats.set(id, { ok: 0, fail: 0, tokens: 0, last_error: null, last_ok: null });
  return stats.get(id);
}
function markFail(p, model, status, msg, retryAfter, ki = -1) {
  const s = stat(p); s.fail++; s.last_error = `${status || ""} ${String(msg || "").slice(0, 160)}`.trim();
  const who = ki >= 0 ? `${p}#${ki}` : p; // مع عدة مفاتيح نوقف المفتاح المعني فقط
  let ms = 30_000, scope = `${p}|${model}`;
  if (status === 429) { ms = Math.max(15_000, (Number(retryAfter) || 60) * 1000); if (ki >= 0) scope = `${who}|${model}`; }
  else if (status === 401 || status === 403) { ms = 10 * 60_000; scope = who; } // مفتاح خاطئ: نوقفه
  else if (status === 400 || status === 404 || status === 422) ms = 10 * 60_000; // النموذج غير موجود/مرفوض
  cooldown.set(scope, now() + ms);
}
function markOk(p, tokens) { const s = stat(p); s.ok++; s.tokens += tokens || 0; s.last_ok = new Date().toISOString(); }

// المتغير قد يحمل عدة مفاتيح: "k1,k2,k3" — كل مفتاح له إيقاف مؤقت خاص به
const keysOf = (p, env) => String((p.key && env[p.key]) || "").split(/[\s,]+/).filter(Boolean);
const keyOf = (p, env) => keysOf(p, env)[0] || null;
const needsOk = (p, env) => (p.needs || []).every((v) => env[v]);
const isConfigured = (p, env) => needsOk(p, env) && (keysOf(p, env).length > 0 || !!p.keyless);
const urlOf = (p, env) => p.url.replace(/\{(\w+)\}/g, (_, v) => env[v] || "");
/** يختار مفتاحًا غير موقوف بالتناوب (أو null لمزود بدون مفتاح) — undefined يعني كل المفاتيح موقوفة */
function pickKey(p, env, turn, model) {
  const keys = keysOf(p, env);
  if (!keys.length) return p.keyless ? { key: null, ki: -1 } : undefined;
  for (let i = 0; i < keys.length; i++) {
    const ki = (turn + i) % keys.length;
    if (!cooled(`${p.id}#${ki}`) && !cooled(`${p.id}#${ki}|${model}`)) return { key: keys[ki], ki };
  }
  return undefined;
}
const modelsOf = (p, env) => {
  const custom = (env[`${p.id.toUpperCase()}_MODELS`] || "").split(",").map((x) => x.trim()).filter(Boolean);
  return custom.length ? custom : p.models;
};
function rotate(arr, n) { if (!arr.length) return arr; const k = n % arr.length; return [...arr.slice(k), ...arr.slice(0, k)]; }

/** يبني قائمة المحاولات: (مزود، نموذج) — الأقوى أولًا وبالتناوب لتوزيع الضغط */
function plan(env, provider) {
  const turn = rr++;
  const available = allProviders(env).filter((p) => isConfigured(p, env) && !cooled(p.id));
  let chosen;
  if (provider && provider !== "auto") chosen = available.filter((p) => p.id === provider);
  else {
    const t1 = rotate(available.filter((p) => p.tier === 1), turn);
    const t2 = rotate(available.filter((p) => p.tier === 2), turn);
    chosen = [...t1, ...t2];
  }
  const attempts = [];
  for (const p of chosen) {
    const models = rotate(modelsOf(p, env), turn).filter((m) => !cooled(`${p.id}|${m}`));
    const withKey = (m) => { const k = pickKey(p, env, turn, m); return k === undefined ? null : { p, model: m, turn, ...k }; };
    if (p.routerList) { const a = models.length && withKey(models[0]); if (a) attempts.push({ ...a, models: models.slice(0, 3) }); }
    else for (const m of models.slice(0, 2)) { const a = withKey(m); if (a) attempts.push(a); }
  }
  if (env.AI && (!provider || provider === "auto" || provider === "workers-ai") && !cooled("workers-ai")) {
    attempts.push({ p: { id: "workers-ai" }, model: env.WORKERS_AI_MODEL || WORKERS_AI_TEXT });
  }
  // نحتفظ بآخر احتياط (Workers AI) حتى لو كثرت المصادر
  const last = attempts[attempts.length - 1];
  const capped = attempts.slice(0, 11);
  if (last?.p.id === "workers-ai" && !capped.includes(last)) capped.push(last);
  return capped;
}

function sanitizeMessages(messages) {
  return messages
    .filter((m) => m && typeof m.content === "string" && ["system", "user", "assistant"].includes(m.role))
    .map((m) => ({ role: m.role, content: m.content }));
}

async function fetchWithTimeout(url, init, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// ------------------------------------------------------------------ مزود متوافق مع OpenAI
async function callOpenAI({ p, model, models, key }, env, messages, maxTokens, stream, temperature) {
  const body = { model, messages, max_tokens: Math.min(maxTokens, p.maxOut || 8000) };
  if (models) body.models = models;
  if (temperature != null) body.temperature = temperature;
  if (stream) { body.stream = true; if (p.usage) body.stream_options = { include_usage: true }; }
  const headers = { "Content-Type": "application/json", ...(p.headers || {}) };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetchWithTimeout(`${urlOf(p, env)}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) }, 45_000);
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    const err = new Error(`${p.id}/${model}: HTTP ${res.status} ${text}`);
    err.status = res.status; err.retryAfter = res.headers.get("retry-after");
    throw err;
  }
  return res;
}

// ------------------------------------------------------------------ Workers AI (نص)
async function callWorkersAI(env, model, messages, maxTokens, stream, temperature) {
  const input = { messages, max_tokens: Math.min(maxTokens, 8000) };
  if (temperature != null) input.temperature = temperature;
  if (!stream) {
    const out = await env.AI.run(model, input);
    const text = out?.response ?? out?.choices?.[0]?.message?.content;
    if (!text) throw new Error("workers-ai: empty response");
    return { provider: "workers-ai", model, text, usage: out.usage, finish_reason: out.finish_reason || "stop" };
  }
  const raw = await env.AI.run(model, { ...input, stream: true });
  // نحوّل صيغة Workers AI ({response}) إلى صيغة OpenAI حتى يكون للواجهة مصدر واحد
  const enc = new TextEncoder(), dec = new TextDecoder();
  let buf = "";
  const ts = new TransformStream({
    transform(chunk, ctrl) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const data = s.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          const out = { choices: [{ index: 0, delta: { content: j.response ?? j.choices?.[0]?.delta?.content ?? "" }, finish_reason: null }] };
          if (j.usage) out.usage = j.usage;
          ctrl.enqueue(enc.encode(`data: ${JSON.stringify(out)}\n\n`));
        } catch { /* سطر ناقص */ }
      }
    },
    flush(ctrl) {
      ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`));
      ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
    },
  });
  return { stream: raw.pipeThrough(ts) };
}

/** يجرّب نفس النموذج بكل مفاتيح المزود: إن وصل مفتاح حده (429) أو رُفض (401/403) ننتقل للمفتاح التالي فورًا */
async function callWithKeys(a, env, messages, maxTokens, stream, temperature) {
  for (let tries = 0; ; tries++) {
    if (a.ki >= 0) { const k = pickKey(a.p, env, a.turn + tries, a.model); if (!k) throw new Error(`${a.p.id}: all keys cooling down`); Object.assign(a, k); }
    try { return await callOpenAI(a, env, messages, maxTokens, stream, temperature); }
    catch (e) {
      const keyIssue = [401, 403, 429].includes(e.status);
      if (a.ki < 0 || !keyIssue || tries + 1 >= keysOf(a.p, env).length) throw e;
      markFail(a.p.id, a.model, e.status, e.message, e.retryAfter, a.ki);
    }
  }
}

const sseHeaders = (provider, model) => ({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
  "X-Provider": provider, "X-Model": model, ...CORS });

// ------------------------------------------------------------------ الدردشة: توزيع + تنقل تلقائي
async function chat(env, { messages, provider = "auto", max_tokens = 4096, temperature, stream = false }) {
  messages = sanitizeMessages(messages || []);
  if (!messages.length) throw new Error("messages required");
  const maxTokens = Math.max(1, Math.min(Number(max_tokens) || 4096, 65000));
  const attempts = plan(env, provider);
  if (!attempts.length) throw new Error("No provider available right now — all are cooling down, try again in a minute");
  const errors = [];
  for (const a of attempts) {
    const id = a.p.id;
    try {
      if (id === "workers-ai") {
        const r = await callWorkersAI(env, a.model, messages, maxTokens, stream, temperature);
        markOk(id, r.usage?.total_tokens);
        if (!stream) return r;
        return new Response(r.stream, { headers: sseHeaders(id, a.model) });
      }
      const res = await callWithKeys(a, env, messages, maxTokens, stream, temperature);
      if (stream) { markOk(id); return new Response(res.body, { headers: sseHeaders(id, a.model) }); }
      const data = await res.json();
      const choice = data?.choices?.[0];
      const text = choice?.message?.content;
      if (!text) { markFail(id, a.model, 0, "empty response (reasoning used all tokens?)", null, a.ki); errors.push(`${id}: empty`); continue; }
      markOk(id, data.usage?.total_tokens);
      return { provider: id, model: data.model || a.model, text, usage: data.usage, finish_reason: choice.finish_reason };
    } catch (e) {
      markFail(id, a.model, e.status || (e.name === "AbortError" ? 504 : 0), e.message, e.retryAfter, a.ki ?? -1);
      if (id === "workers-ai") cooldown.set("workers-ai", now() + 60_000);
      errors.push(e.message.slice(0, 160));
    }
  }
  throw new Error("All providers failed:\n" + errors.join("\n"));
}

// ------------------------------------------------------------------ الصور
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function generateImage(env, { prompt, model = "flux", width, height, negative_prompt, seed }) {
  if (!env.AI) throw new Error("Workers AI binding (AI) is not configured");
  const m = IMAGE_MODELS[model] || IMAGE_MODELS.flux;
  prompt = String(prompt || "").slice(0, 2000);
  if (!prompt) throw new Error("prompt required");
  const s = Number.isInteger(seed) ? seed : Math.floor(Math.random() * 1e9);
  if (m.sizes) {
    const clamp = (v) => Math.max(256, Math.min(2048, Math.round((Number(v) || 1024) / 64) * 64));
    const out = await env.AI.run(m.id, { prompt, negative_prompt: negative_prompt || undefined, width: clamp(width), height: clamp(height) });
    const buf = out instanceof ReadableStream ? await new Response(out).arrayBuffer() : out;
    return { image: `data:image/png;base64,${toBase64(buf)}`, model: m.id, seed: s };
  }
  const out = await env.AI.run(m.id, { prompt, steps: 8, seed: s });
  if (!out?.image) throw new Error("Image generation returned nothing");
  return { image: `data:image/jpeg;base64,${out.image}`, model: m.id, seed: s };
}

function providersInfo(env) {
  const left = (k) => Math.max(0, Math.round(((cooldown.get(k) || 0) - now()) / 1000));
  return [
    ...allProviders(env).map((p) => ({
      id: p.id, kind: "text", tier: p.tier, configured: isConfigured(p, env), keyless: !!p.keyless,
      has_key: !!keyOf(p, env), keys: keysOf(p, env).length, key_var: [p.key, ...(p.needs || [])].filter(Boolean).join(" + "), model: modelsOf(p, env)[0], models: modelsOf(p, env),
      cap: p.cap, signup: p.signup || null, cooldown_s: left(p.id), stats: stat(p.id),
    })),
    { id: "workers-ai", kind: "text", tier: 3, configured: !!env.AI, keyless: true, model: env.WORKERS_AI_MODEL || WORKERS_AI_TEXT,
      cap: "احتياطي Cloudflare (≈10K neurons/يوم)", cooldown_s: left("workers-ai"), stats: stat("workers-ai") },
    ...Object.entries(IMAGE_MODELS).map(([k, m]) => ({ id: "image-" + k, kind: "image", configured: !!env.AI, model: m.id, label: m.label, sizes: m.sizes })),
  ];
}

// ------------------------------------------------------------------ MCP
function rpc(id, result) { return Response.json({ jsonrpc: "2.0", id, result }); }
function rpcError(id, code, message) { return Response.json({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handleMcp(request, env) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let msg;
  try { msg = await request.json(); } catch { return rpcError(null, -32700, "Parse error"); }
  if (msg.id === undefined) return new Response(null, { status: 202 });

  switch (msg.method) {
    case "initialize":
      return rpc(msg.id, {
        protocolVersion: msg.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "free-ai-gateway", version: VERSION },
      });
    case "ping": return rpc(msg.id, {});
    case "tools/list": return rpc(msg.id, { tools: TOOLS });
    case "tools/call": {
      const { name, arguments: args = {} } = msg.params || {};
      try {
        if (name === "list_providers") {
          const text = providersInfo(env).map((p) => `${p.id}: ${p.configured ? "✅" : "❌"} — ${p.model}${p.cap ? ` (${p.cap})` : ""}`).join("\n");
          return rpc(msg.id, { content: [{ type: "text", text }] });
        }
        if (name === "ask_model") {
          const messages = [];
          if (args.system) messages.push({ role: "system", content: args.system });
          messages.push({ role: "user", content: args.prompt });
          const r = await chat(env, { messages, provider: args.provider, max_tokens: args.max_tokens || 4096 });
          const footer = `\n\n— ${r.provider} / ${r.model}` + (r.usage?.total_tokens ? ` / ${r.usage.total_tokens} tokens` : "");
          return rpc(msg.id, { content: [{ type: "text", text: r.text + footer }] });
        }
        if (name === "generate_image") {
          const r = await generateImage(env, { prompt: args.prompt, model: args.model });
          const [meta, data] = r.image.split(",");
          return rpc(msg.id, { content: [{ type: "image", data, mimeType: meta.slice(5, meta.indexOf(";")) }] });
        }
        return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
      } catch (e) {
        return rpc(msg.id, { content: [{ type: "text", text: e.message }], isError: true });
      }
    }
    default: return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

// ------------------------------------------------------------------ HTTP API
async function handleApi(request, env, path) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (path === "/api/health") return json({ ok: true, name: "free-ai-gateway", version: VERSION });
  if ((request.headers.get("Authorization") || "") !== `Bearer ${env.ACCESS_TOKEN}`) {
    return json({ error: "unauthorized" }, 401);
  }
  try {
    if (path === "/api/providers") return json(providersInfo(env));
    if (path === "/api/chat" && request.method === "POST") {
      const r = await chat(env, await request.json());
      return r instanceof Response ? r : json(r);
    }
    if (path === "/api/image" && request.method === "POST") {
      return json(await generateImage(env, await request.json()));
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.ACCESS_TOKEN) return new Response("ACCESS_TOKEN is not set", { status: 500 });
    if (url.pathname === `/mcp/${env.ACCESS_TOKEN}`) return handleMcp(request, env);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url.pathname);
    if (url.pathname === "/") return new Response(`free-ai-gateway v${VERSION}`, { headers: CORS });
    return new Response("Not found", { status: 404 });
  },
};
