// بوابة الذكاء المجانية — Cloudflare Worker
// 1) خادم MCP لكلود:            POST /mcp/<ACCESS_TOKEN>
// 2) API للوحة التحكم (CORS):   POST /api/chat  ·  POST /api/image  ·  GET /api/providers
//    (تتطلب Authorization: Bearer <ACCESS_TOKEN>)
// يتنقل تلقائيًا بين Cerebras → Groq → Gemini → OpenRouter عند انتهاء حصة أي منصة.

const PROVIDERS = [
  { id: "cerebras", url: "https://api.cerebras.ai/v1/chat/completions", keyVar: "CEREBRAS_API_KEY",
    modelVar: "CEREBRAS_MODEL", defaultModel: "gpt-oss-120b" },
  { id: "groq", url: "https://api.groq.com/openai/v1/chat/completions", keyVar: "GROQ_API_KEY",
    modelVar: "GROQ_MODEL", defaultModel: "openai/gpt-oss-120b" },
  { id: "gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    keyVar: "GEMINI_API_KEY", modelVar: "GEMINI_MODEL", defaultModel: "gemini-2.5-flash" },
  { id: "openrouter", url: "https://openrouter.ai/api/v1/chat/completions", keyVar: "OPENROUTER_API_KEY",
    modelVar: "OPENROUTER_MODEL", defaultModel: "openrouter/free" },
];

const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell"; // مجاني ضمن حصة Workers AI اليومية

const TOOLS = [
  {
    name: "ask_model",
    description: "Send a prompt to a free AI model. Tries providers in order and falls back automatically when one hits its limit.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The message to send" },
        system: { type: "string", description: "Optional system instruction" },
        provider: { type: "string", enum: ["auto", "cerebras", "groq", "gemini", "openrouter"] },
        max_tokens: { type: "number", description: "Max output tokens (default 2048)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "generate_image",
    description: "Generate an image from a text description (FLUX schnell on Cloudflare Workers AI, free daily quota).",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string", description: "Image description (English works best)" } },
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
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

async function callProvider(p, env, messages, maxTokens) {
  const key = env[p.keyVar];
  if (!key) throw new Error(`${p.id}: no API key set`);
  const res = await fetch(p.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: env[p.modelVar] || p.defaultModel, messages, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error(`${p.id}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${p.id}: empty response`);
  return { provider: p.id, model: data.model || env[p.modelVar] || p.defaultModel, text, usage: data.usage };
}

async function chat(env, { messages, provider = "auto", max_tokens = 2048 }) {
  const list = provider && provider !== "auto"
    ? PROVIDERS.filter((p) => p.id === provider)
    : PROVIDERS.filter((p) => env[p.keyVar]);
  if (!list.length) throw new Error("No provider keys configured on the gateway");
  const errors = [];
  for (const p of list) {
    try {
      return await callProvider(p, env, messages, Math.min(Number(max_tokens) || 2048, 16000));
    } catch (e) {
      errors.push(e.message); // حصة خلصت أو خطأ — ننتقل للتالي
    }
  }
  throw new Error("All providers failed:\n" + errors.join("\n"));
}

async function generateImage(env, prompt) {
  if (!env.AI) throw new Error("Workers AI binding (AI) is not configured — see wrangler.toml");
  const out = await env.AI.run(IMAGE_MODEL, { prompt: String(prompt).slice(0, 2000), steps: 6 });
  if (!out?.image) throw new Error("Image generation returned nothing");
  return out.image; // base64 JPEG
}

function providersInfo(env) {
  return PROVIDERS.map((p) => ({ id: p.id, configured: !!env[p.keyVar], model: env[p.modelVar] || p.defaultModel }))
    .concat([{ id: "workers-ai-image", configured: !!env.AI, model: IMAGE_MODEL }]);
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
        serverInfo: { name: "free-ai-gateway", version: "1.1.0" },
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
          const r = await chat(env, { messages, provider: args.provider, max_tokens: args.max_tokens });
          const footer = `\n\n— ${r.provider} / ${r.model}` + (r.usage ? ` / ${r.usage.total_tokens} tokens` : "");
          return rpc(msg.id, { content: [{ type: "text", text: r.text + footer }] });
        }
        if (name === "generate_image") {
          const b64 = await generateImage(env, args.prompt);
          return rpc(msg.id, { content: [{ type: "image", data: b64, mimeType: "image/jpeg" }] });
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
  if (path === "/api/health") return json({ ok: true, name: "free-ai-gateway", version: "1.1.0" });
  if ((request.headers.get("Authorization") || "") !== `Bearer ${env.ACCESS_TOKEN}`) {
    return json({ error: "unauthorized" }, 401);
  }
  try {
    if (path === "/api/providers") return json(providersInfo(env));
    if (path === "/api/chat" && request.method === "POST") {
      const body = await request.json();
      if (!Array.isArray(body.messages) || !body.messages.length) return json({ error: "messages required" }, 400);
      return json(await chat(env, body));
    }
    if (path === "/api/image" && request.method === "POST") {
      const { prompt } = await request.json();
      if (!prompt) return json({ error: "prompt required" }, 400);
      const b64 = await generateImage(env, prompt);
      return json({ image: `data:image/jpeg;base64,${b64}`, model: IMAGE_MODEL });
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.ACCESS_TOKEN) return new Response("ACCESS_TOKEN secret is not set", { status: 500 });
    if (url.pathname === `/mcp/${env.ACCESS_TOKEN}`) return handleMcp(request, env);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url.pathname);
    return new Response("Not found", { status: 404 });
  },
};
