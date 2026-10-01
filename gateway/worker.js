// بوابة الذكاء المجانية v2 — Cloudflare Worker
// 1) خادم MCP لكلود:            POST /mcp/<ACCESS_TOKEN>
// 2) API للوحة التحكم (CORS):   POST /api/chat (يدعم stream) · POST /api/image · GET /api/providers
//    (تتطلب Authorization: Bearer <ACCESS_TOKEN>)
// ترتيب التنقل التلقائي: Cerebras → Groq → Gemini → OpenRouter → Workers AI (بدون مفتاح)

const VERSION = "2.0.0";

const PROVIDERS = [
  { id: "cerebras", url: "https://api.cerebras.ai/v1/chat/completions", keyVar: "CEREBRAS_API_KEY",
    modelVar: "CEREBRAS_MODEL", defaultModel: "gpt-oss-120b", maxOut: 32000, usageOpt: true },
  { id: "groq", url: "https://api.groq.com/openai/v1/chat/completions", keyVar: "GROQ_API_KEY",
    modelVar: "GROQ_MODEL", defaultModel: "openai/gpt-oss-120b", maxOut: 32000, usageOpt: true },
  { id: "gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    keyVar: "GEMINI_API_KEY", modelVar: "GEMINI_MODEL", defaultModel: "gemini-2.5-flash", maxOut: 65000 },
  { id: "openrouter", url: "https://openrouter.ai/api/v1/chat/completions", keyVar: "OPENROUTER_API_KEY",
    modelVar: "OPENROUTER_MODEL", defaultModel: "openrouter/free", maxOut: 32000, usageOpt: true,
    extraHeaders: { "HTTP-Referer": "https://almajhool-ai.vercel.app", "X-Title": "Almajhool AI" } },
];

// نموذج نصي على Cloudflare نفسه — يعمل بدون أي مفتاح ضمن الحصة اليومية المجانية
const WORKERS_AI_TEXT = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const IMAGE_MODELS = {
  flux: { id: "@cf/black-forest-labs/flux-1-schnell", label: "FLUX.1 schnell", sizes: false },
  sdxl: { id: "@cf/bytedance/stable-diffusion-xl-lightning", label: "SDXL Lightning", sizes: true },
};

const TOOLS = [
  {
    name: "ask_model",
    description: "Send a prompt to a free AI model. Tries providers in order and falls back automatically when one hits its limit.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The message to send" },
        system: { type: "string", description: "Optional system instruction" },
        provider: { type: "string", enum: ["auto", "cerebras", "groq", "gemini", "openrouter", "workers-ai"] },
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
  { name: "list_providers", description: "List configured providers and their models.",
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

function providerChain(env, provider) {
  const all = [...PROVIDERS.filter((p) => env[p.keyVar]).map((p) => p.id), ...(env.AI ? ["workers-ai"] : [])];
  if (provider && provider !== "auto") return all.includes(provider) ? [provider] : [];
  return all;
}

function sanitizeMessages(messages) {
  return messages
    .filter((m) => m && typeof m.content === "string" && ["system", "user", "assistant"].includes(m.role))
    .map((m) => ({ role: m.role, content: m.content }));
}

// ------------------------------------------------------------------ مزودات متوافقة مع OpenAI
async function callOpenAI(p, env, messages, maxTokens, stream, temperature) {
  const body = { model: env[p.modelVar] || p.defaultModel, messages, max_tokens: Math.min(maxTokens, p.maxOut) };
  if (temperature != null) body.temperature = temperature;
  if (stream) {
    body.stream = true;
    if (p.usageOpt) body.stream_options = { include_usage: true };
  }
  const res = await fetch(p.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${env[p.keyVar]}`, "Content-Type": "application/json", ...(p.extraHeaders || {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${p.id}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return { res, model: body.model };
}

// ------------------------------------------------------------------ Workers AI (نص)
async function callWorkersAI(env, messages, maxTokens, stream, temperature) {
  const model = env.WORKERS_AI_MODEL || WORKERS_AI_TEXT;
  const input = { messages, max_tokens: Math.min(maxTokens, 8000) };
  if (temperature != null) input.temperature = temperature;
  if (!stream) {
    const out = await env.AI.run(model, input);
    const text = out?.response ?? out?.choices?.[0]?.message?.content;
    if (!text) throw new Error("workers-ai: empty response");
    return { provider: "workers-ai", model, text, usage: out.usage, finish_reason: out.finish_reason || "stop" };
  }
  const raw = await env.AI.run(model, { ...input, stream: true });
  // نحوّل صيغة Workers AI ({response}) إلى صيغة OpenAI حتى تتعامل الواجهة مع مصدر واحد
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = "";
  const ts = new TransformStream({
    transform(chunk, ctrl) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const data = s.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          const piece = j.response ?? j.choices?.[0]?.delta?.content ?? "";
          const out = { choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] };
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
  return { stream: raw.pipeThrough(ts), model };
}

// ------------------------------------------------------------------ الدردشة مع التنقل التلقائي
async function chat(env, { messages, provider = "auto", max_tokens = 4096, temperature, stream = false }) {
  messages = sanitizeMessages(messages || []);
  if (!messages.length) throw new Error("messages required");
  const maxTokens = Math.max(1, Math.min(Number(max_tokens) || 4096, 65000));
  const chain = providerChain(env, provider);
  if (!chain.length) throw new Error("No provider configured on the gateway");
  const errors = [];
  for (const id of chain) {
    try {
      if (id === "workers-ai") {
        const r = await callWorkersAI(env, messages, maxTokens, stream, temperature);
        if (!stream) return r;
        return new Response(r.stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
          "X-Provider": "workers-ai", "X-Model": r.model, ...CORS } });
      }
      const p = PROVIDERS.find((x) => x.id === id);
      const { res, model } = await callOpenAI(p, env, messages, maxTokens, stream, temperature);
      if (stream) {
        return new Response(res.body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
          "X-Provider": id, "X-Model": model, ...CORS } });
      }
      const data = await res.json();
      const choice = data?.choices?.[0];
      const text = choice?.message?.content;
      if (!text) throw new Error(`${id}: empty response`);
      return { provider: id, model: data.model || model, text, usage: data.usage, finish_reason: choice.finish_reason };
    } catch (e) {
      errors.push(e.message); // حصة خلصت أو خطأ — ننتقل للتالي
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
    const out = await env.AI.run(m.id, { prompt, negative_prompt: negative_prompt || undefined,
      width: clamp(width), height: clamp(height) });
    const buf = out instanceof ReadableStream ? await new Response(out).arrayBuffer() : out;
    return { image: `data:image/png;base64,${toBase64(buf)}`, model: m.id, seed: s };
  }
  const out = await env.AI.run(m.id, { prompt, steps: 8, seed: s });
  if (!out?.image) throw new Error("Image generation returned nothing");
  return { image: `data:image/jpeg;base64,${out.image}`, model: m.id, seed: s };
}

function providersInfo(env) {
  return [
    ...PROVIDERS.map((p) => ({ id: p.id, kind: "text", configured: !!env[p.keyVar], model: env[p.modelVar] || p.defaultModel })),
    { id: "workers-ai", kind: "text", configured: !!env.AI, model: env.WORKERS_AI_MODEL || WORKERS_AI_TEXT },
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
          const text = providersInfo(env).map((p) => `${p.id}: ${p.configured ? "✅" : "❌"} — ${p.model}`).join("\n");
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
      const body = await request.json();
      const r = await chat(env, body);
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
