import { Mp3Encoder } from "@breezystack/lamejs";

const SAMPLE_RATE = 24000;
const HAIDER = "380ef7b6-ffea-52fd-89bd-d661a9b01bcc";
const SAWTAK = "https://api.sawtakarabi.ai/v1";
const LEGACY = "https://almajhool-ai.vercel.app/api/telegram";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function webhookSecret(token) {
  return (await sha256Hex(token)).slice(0, 48);
}
function eq(a, b) {
  a = String(a || ""); b = String(b || "");
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
function stripPunctuation(t) {
  return String(t || "").replace(/[\p{P}\p{S}]/gu, " ").replace(/\s+/g, " ").trim();
}
function splitWords(text, maxWords = 4) {
  const w = stripPunctuation(text).split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < w.length; i += maxWords) out.push(w.slice(i, i + maxWords).join(" "));
  return out;
}
function cleanPcm(raw, rate = SAMPLE_RATE) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw || 0);
  const n = Math.floor(bytes.byteLength / 2);
  if (!n) throw new Error("empty pcm");
  const v = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(v.getInt16(i * 2, true)));
  if (!peak) throw new Error("silent pcm");
  const th = Math.max(20, Math.min(160, Math.round(peak * 0.035)));
  let first = -1, last = -1;
  for (let i = 0; i < n; i++) if (Math.abs(v.getInt16(i * 2, true)) >= th) { if (first < 0) first = i; last = i; }
  if (first < 0) throw new Error("no speech");
  const pad = Math.round(rate * 0.18);
  const s = Math.max(0, first - pad), e = Math.min(n, last + pad + 1);
  const gain = Math.max(1, Math.min(12, 24000 / peak));
  const out = new Int16Array(e - s);
  for (let i = s, j = 0; i < e; i++, j++) {
    out[j] = Math.max(-32768, Math.min(32767, Math.round(v.getInt16(i * 2, true) * gain)));
  }
  return { pcm: out, duration: out.length / rate, rawDuration: n / rate };
}
function joinPcm(parts, gapMs = 100) {
  const gap = Math.round(SAMPLE_RATE * gapMs / 1000);
  const total = parts.reduce((n, p) => n + p.length, 0) + gap * Math.max(0, parts.length - 1);
  const out = new Int16Array(total);
  let off = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], off);
    off += parts[i].length;
    if (i < parts.length - 1) off += gap;
  }
  return out;
}
function mp3(pcm) {
  const enc = new Mp3Encoder(1, SAMPLE_RATE, 64), parts = [];
  for (let i = 0; i < pcm.length; i += 1152) {
    const b = enc.encodeBuffer(pcm.subarray(i, i + 1152));
    if (b.length) parts.push(new Uint8Array(b));
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Uint8Array(tail));
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
async function sawtakChunk(text, env) {
  let last;
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(SAWTAK + "/audio/speech", {
        method: "POST",
        headers: { Authorization: "Bearer " + env.SAWTAK_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "arabic-tts-1", voice: HAIDER, input: text,
          response_format: "pcm", sample_rate: SAMPLE_RATE,
          normalize_text: true, enhance_pronunciation: true, temperature: 0.35
        }),
        signal: AbortSignal.timeout(90000),
      });
      if (!r.ok) throw new Error("Sawtak " + r.status + " " + (await r.text()).slice(0, 160));
      const raw = new Uint8Array(await r.arrayBuffer());
      const c = cleanPcm(raw, Number(r.headers.get("x-sample-rate") || SAMPLE_RATE));
      const words = text.split(/\s+/).length;
      if (c.rawDuration > 30 && c.duration < Math.max(0.45, words * 0.18)) throw new Error("Sawtak truncated");
      return c;
    } catch (e) {
      last = e;
      if (a < 3) await sleep(700 * (a + 1));
    }
  }
  throw last;
}
async function synthesize(text, env) {
  const chunks = splitWords(text, 4).slice(0, 6);
  if (!chunks.length) throw new Error("empty speech");
  const results = new Array(chunks.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= chunks.length) return;
      results[i] = await sawtakChunk(chunks[i], env);
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, chunks.length) }, worker));
  const pcm = joinPcm(results.map((x) => x.pcm));
  return { audio: mp3(pcm), duration: pcm.length / SAMPLE_RATE };
}
async function tg(token, method, body) {
  const r = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error("Telegram " + method + ": " + (j.description || r.status));
  return j.result;
}
async function downloadVoice(token, id) {
  const f = await tg(token, "getFile", { file_id: id });
  const r = await fetch("https://api.telegram.org/file/bot" + token + "/" + f.file_path);
  if (!r.ok) throw new Error("voice download " + r.status);
  return new Uint8Array(await r.arrayBuffer());
}
async function transcribeGemini(audio, env) {
  const keys = [env.GEMINI_API_KEY, env.GEMINI_API_KEY_2, env.GEMINI_API_KEY_3, env.GEMINI_API_KEY_4]
    .flatMap((x) => String(x || "").split(/[\s,]+/)).filter(Boolean);
  if (!keys.length) throw new Error("Gemini key missing");
  const data = btoa(String.fromCharCode(...audio));
  const models = ["gemini-flash-latest", "gemini-2.5-flash"];
  const prompt = 'رجّع JSON فقط: {"transcript":"..."} واكتب الكلام مثل ما انحچى باللهجة نفسها بدون تحويله للفصحى.';
  const errors = [];
  for (const model of models) for (const key of keys) {
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ inline_data: { mime_type: "audio/ogg", data } }, { text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" }
        }),
        signal: AbortSignal.timeout(25000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { errors.push(model + ":" + r.status); continue; }
      const s = (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
      const o = JSON.parse((s.match(/\{[\s\S]*\}/) || ["{}"])[0]);
      const t = String(o.transcript || "").trim();
      if (t) return t;
    } catch (e) { errors.push(e.message); }
  }
  throw new Error("transcribe failed " + errors.slice(0, 4).join(" | "));
}
function smallTalk(t) {
  const x = String(t || "").trim();
  if (/السلام|سلام/u.test(x)) return "وعليكم السلام هلا بيك عيني شلونك شخبارك";
  if (/شلونك|شخبارك|هلا|هلو/u.test(x)) return "هلا عيني الحمد لله زين وإنت شلونك شخبارك";
  return "";
}
async function replyText(transcript, env) {
  const canned = smallTalk(transcript);
  if (canned) return canned;
  try {
    const out = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        { role: "system", content: "احچي عراقي عامي طبيعي فقط، بدون فصحى إلا المصطلحات الضرورية. رد بجملة أو جملتين قصيرات، بحد أقصى 24 كلمة. استخدم مفردات عراقية مثل هسه، تگدر، گلي، أسويلك. لا تستخدم سأفعل، يمكنك، ماذا تريد، بالتأكيد." },
        { role: "user", content: transcript.slice(0, 2500) }
      ],
      max_tokens: 120,
      temperature: 0.5
    });
    let t = String(out?.response || out?.choices?.[0]?.message?.content || "").replace(/\s+/g, " ").trim();
    if (t) return t.split(/\s+/).slice(0, 24).join(" ");
  } catch (e) { console.log("AI", e.message); }
  return "هلا عيني وصلتني بصمتك گلي طلبك بشكل أقصر وأجاوبك";
}
async function sendVoice(token, chatId, audio, duration) {
  const f = new FormData();
  f.append("chat_id", String(chatId));
  f.append("voice", new Blob([audio], { type: "audio/mpeg" }), "reply.mp3");
  f.append("duration", String(Math.max(1, Math.ceil(duration))));
  const r = await fetch("https://api.telegram.org/bot" + token + "/sendVoice", { method: "POST", body: f });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error("sendVoice " + (j.description || r.status));
}
async function sendText(token, chatId, text) {
  return tg(token, "sendMessage", { chat_id: chatId, text });
}
async function handleVoice(msg, env) {
  const chat = msg?.chat?.id, id = msg?.voice?.file_id || msg?.audio?.file_id;
  if (!chat || !id) return;
  try {
    await tg(env.TELEGRAM_BOT_TOKEN, "sendChatAction", { chat_id: chat, action: "record_voice" }).catch(() => {});
    const audio = await downloadVoice(env.TELEGRAM_BOT_TOKEN, id);
    const transcript = await transcribeGemini(audio, env);
    const reply = await replyText(transcript, env);
    const out = await synthesize(reply, env);
    await sendVoice(env.TELEGRAM_BOT_TOKEN, chat, out.audio, out.duration);
  } catch (e) {
    console.log("voice error", String(e?.message || e).slice(0, 240));
    try {
      const out = await synthesize("صار خلل بسيط بالبصمة دزها مرة ثانية", env);
      await sendVoice(env.TELEGRAM_BOT_TOKEN, chat, out.audio, out.duration);
    } catch {
      await sendText(env.TELEGRAM_BOT_TOKEN, chat, "صار خلل بالبصمة هسه، دزها مرة ثانية.").catch(() => {});
    }
  }
}
async function forwardLegacy(update, env) {
  const secret = await webhookSecret(env.TELEGRAM_BOT_TOKEN);
  await fetch(LEGACY, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify(update),
    signal: AbortSignal.timeout(5000)
  }).catch(() => {});
}
export default {
  async fetch(request, env, ctx) {
    const u = new URL(request.url);
    if (u.pathname === "/health") {
      return Response.json({ ok: true, telegram: !!env.TELEGRAM_BOT_TOKEN, sawtak: !!env.SAWTAK_API_KEY, gemini: !!env.GEMINI_API_KEY });
    }
    if (u.pathname !== "/telegram" || request.method !== "POST") return new Response("Not found", { status: 404 });
    if (!env.TELEGRAM_BOT_TOKEN || !env.SAWTAK_API_KEY) return new Response("not configured", { status: 503 });
    const want = await webhookSecret(env.TELEGRAM_BOT_TOKEN);
    const got = request.headers.get("x-telegram-bot-api-secret-token") || "";
    if (!eq(got, want)) return new Response("unauthorized", { status: 401 });
    let update;
    try { update = await request.json(); } catch { return new Response("bad json", { status: 400 }); }
    const msg = update?.message;
    if (msg?.voice || msg?.audio) ctx.waitUntil(handleVoice(msg, env));
    else ctx.waitUntil(forwardLegacy(update, env));
    return Response.json({ ok: true });
  }
};
