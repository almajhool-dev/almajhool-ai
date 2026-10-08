import { createHash, timingSafeEqual } from "node:crypto";
import { Mp3Encoder } from "@breezystack/lamejs";

export const SAMPLE_RATE = 24000;
export const HAIDER_VOICE_ID = "380ef7b6-ffea-52fd-89bd-d661a9b01bcc";
export const SAWTAK_BASE = "https://api.sawtakarabi.ai/v1";
export const LEGACY_WEBHOOK = "https://almajhool-ai.vercel.app/api/telegram";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function derivedSecret(token) {
  return createHash("sha256").update(String(token)).digest("hex").slice(0, 48);
}
export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && timingSafeEqual(x, y);
}
export function stripPunctuation(text) {
  return String(text || "")
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function splitWords(text, maxWords = 4) {
  const words = stripPunctuation(text).split(/\s+/).filter(Boolean);
  const size = Math.max(2, Math.min(6, Number(maxWords) || 4));
  const out = [];
  for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size).join(" "));
  return out;
}
export function cleanPcm(raw, sampleRate = SAMPLE_RATE, {
  paddingMs = 180,
  targetPeak = 24000,
  maxGain = 12,
} = {}) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw || 0);
  const count = Math.floor(bytes.byteLength / 2);
  if (!count) throw new Error("empty PCM");
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);

  let peak = 0;
  for (let i = 0; i < count; i++) peak = Math.max(peak, Math.abs(view.getInt16(i * 2, true)));
  if (!peak) throw new Error("silent PCM");

  const threshold = Math.max(20, Math.min(160, Math.round(peak * 0.035)));
  let first = -1, last = -1;
  for (let i = 0; i < count; i++) {
    if (Math.abs(view.getInt16(i * 2, true)) >= threshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0 || last < first) throw new Error("no audible speech");

  const pad = Math.round(sampleRate * Math.max(0, paddingMs) / 1000);
  const start = Math.max(0, first - pad);
  const end = Math.min(count, last + pad + 1);
  const gain = Math.max(1, Math.min(maxGain, targetPeak / peak));

  const out = new Int16Array(end - start);
  let peakAfter = 0;
  for (let i = start, j = 0; i < end; i++, j++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(view.getInt16(i * 2, true) * gain)));
    out[j] = v;
    peakAfter = Math.max(peakAfter, Math.abs(v));
  }
  return {
    pcm: out,
    duration: out.length / sampleRate,
    rawDuration: count / sampleRate,
    gain,
    peakBefore: peak,
    peakAfter,
  };
}
export function joinPcm(parts, sampleRate = SAMPLE_RATE, gapMs = 100) {
  const gap = Math.round(sampleRate * gapMs / 1000);
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
export function encodeMp3(pcm, sampleRate = SAMPLE_RATE) {
  const enc = new Mp3Encoder(1, sampleRate, 64);
  const blocks = [];
  for (let i = 0; i < pcm.length; i += 1152) {
    const b = enc.encodeBuffer(pcm.subarray(i, i + 1152));
    if (b.length) blocks.push(Buffer.from(b));
  }
  const tail = enc.flush();
  if (tail.length) blocks.push(Buffer.from(tail));
  return Buffer.concat(blocks);
}

async function sawtakChunk(text, key, { timeout = 90000, retries = 3 } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(SAWTAK_BASE + "/audio/speech", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "arabic-tts-1",
          voice: HAIDER_VOICE_ID,
          input: text,
          response_format: "pcm",
          sample_rate: SAMPLE_RATE,
          normalize_text: true,
          enhance_pronunciation: true,
          temperature: 0.35,
        }),
        signal: AbortSignal.timeout(timeout),
      });
      if (!r.ok) {
        const e = new Error("Sawtak TTS HTTP " + r.status + ": " + (await r.text()).slice(0, 240));
        e.status = r.status;
        e.retryAfterMs = Math.max(0, Number(r.headers.get("retry-after") || 0) * 1000);
        throw e;
      }
      const raw = new Uint8Array(await r.arrayBuffer());
      const cleaned = cleanPcm(raw, Number(r.headers.get("x-sample-rate") || SAMPLE_RATE));
      const words = text.trim().split(/\s+/).length;
      const minSeconds = Math.max(0.55, words * 0.22);
      if (cleaned.rawDuration > 30 && cleaned.duration < minSeconds) {
        throw new Error("Sawtak truncated chunk");
      }
      return cleaned;
    } catch (e) {
      last = e;
      if (attempt >= retries) break;
      const wait = e?.status === 429
        ? Math.max(e.retryAfterMs || 0, Math.min(20000, 3000 * (2 ** attempt)))
        : 700 * (attempt + 1);
      await sleep(wait);
    }
  }
  throw last || new Error("Sawtak TTS failed");
}

export async function synthesizeHaider(text, key, { maxWords = 4, concurrency = 2 } = {}) {
  const chunks = splitWords(text, maxWords);
  if (!chunks.length) throw new Error("empty TTS text");
  const results = new Array(chunks.length);
  const workers = Math.max(1, Math.min(2, concurrency));
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= chunks.length) return;
      results[i] = await sawtakChunk(chunks[i], key);
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, chunks.length) }, worker));
  const pcm = joinPcm(results.map((x) => x.pcm));
  const duration = pcm.length / SAMPLE_RATE;
  return { audio: encodeMp3(pcm), duration, chunks: chunks.length };
}

export async function transcribeSawtak(audio, key, mime = "audio/ogg") {
  const form = new FormData();
  form.append("model", "arabic asr");
  form.append("language", "ar");
  form.append("response_format", "json");
  form.append("file", new Blob([audio], { type: mime }), "voice.ogg");
  const r = await fetch(SAWTAK_BASE + "/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: "Bearer " + key },
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error("Sawtak STT HTTP " + r.status + ": " + (await r.text()).slice(0, 240));
  const j = await r.json();
  const text = String(j?.text || "").trim();
  if (!text) throw new Error("empty transcript");
  return text;
}

const SMALL_TALK = /^(?:هلا|هلو|السلام|سلام|شلونك|شخبارك|شلونكم|شخباركم|صباح الخير|مساء الخير|هاي|hello|hi)(?:\s|$|[؟?!.,،])/iu;
export function smallTalkReply(text) {
  const t = String(text || "").trim();
  if (!SMALL_TALK.test(t)) return "";
  if (/السلام|سلام/u.test(t)) return "وعليكم السلام هلا بيك عيني شلونك شخبارك";
  return "هلا عيني الحمد لله زين وإنت شلونك شخبارك";
}

const AI_PROVIDERS = [
  { url: "https://api.kilo.ai/api/gateway/chat/completions", model: "qwen/qwen3.8-27b:free" },
  { url: "https://api.llm7.io/v1/chat/completions", model: "GLM-5.3-Flash" },
  { url: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions", model: "Qwen3.5-397B-A17B" },
];
export async function generateIraqiReply(text) {
  const canned = smallTalkReply(text);
  if (canned) return canned;

  const system = "إنت مساعد عراقي. احچي عراقي عامي طبيعي فقط، مو فصحى، إلا المصطلحات التقنية الضرورية. رد بجملة أو جملتين قصيرات وواضحات، بدون إيموجي ولا روابط. لا تستخدم: سأفعل، يمكنك، ماذا تريد، بالتأكيد، سوف. استخدم: أسويلك، تگدر، شتريد، إي، هسه، گلي.";
  let last = "";
  for (const p of AI_PROVIDERS) {
    try {
      const r = await fetch(p.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: p.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: String(text).slice(0, 3000) },
          ],
          max_tokens: 180,
          temperature: 0.55,
          stream: false,
        }),
        signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) { last = p.model + " HTTP " + r.status; continue; }
      const j = await r.json();
      const out = String(j?.choices?.[0]?.message?.content || "").replace(/\s+/g, " ").trim();
      if (out) return out.split(/(?<=[.!؟!])\s+/u).slice(0,2).join(" ").slice(0,420);
    } catch (e) { last = e.message; }
  }
  console.error("AI providers failed", last);
  return "هلا عيني وصلتني بصمتك بس هسه الرد الذكي متعطل شوي، جرّب دز سؤالك كتابة.";
}

export async function tg(token, method, body) {
  const r = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error("Telegram " + method + ": " + (j.description || r.status));
  return j.result;
}
export async function downloadVoice(token, fileId) {
  const file = await tg(token, "getFile", { file_id: fileId });
  if (!file?.file_path) throw new Error("Telegram file path missing");
  const r = await fetch("https://api.telegram.org/file/bot" + token + "/" + file.file_path, {
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error("Telegram file download HTTP " + r.status);
  return new Uint8Array(await r.arrayBuffer());
}
export async function sendMessage(token, chatId, text) {
  return tg(token, "sendMessage", { chat_id: chatId, text: String(text).slice(0,4096) });
}
export async function sendVoice(token, chatId, audio, duration) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("voice", new Blob([audio], { type: "audio/mpeg" }), "reply.mp3");
  if (Number.isFinite(duration) && duration > 0) form.append("duration", String(Math.max(1, Math.ceil(duration))));
  const r = await fetch("https://api.telegram.org/bot" + token + "/sendVoice", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error("Telegram sendVoice: " + (j.description || r.status));
  return j.result;
}
export async function forwardLegacy(update, token) {
  const r = await fetch(LEGACY_WEBHOOK, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": derivedSecret(token),
    },
    body: JSON.stringify(update),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error("legacy webhook HTTP " + r.status);
}

export async function handleVoiceMessage(msg, { token, sawtakKey }) {
  const chatId = msg?.chat?.id;
  const fileId = msg?.voice?.file_id || msg?.audio?.file_id;
  if (!chatId || !fileId) return;
  try {
    await tg(token, "sendChatAction", { chat_id: chatId, action: "record_voice" }).catch(() => {});
    const audio = await downloadVoice(token, fileId);
    const transcript = await transcribeSawtak(audio, sawtakKey, "audio/ogg");
    const reply = await generateIraqiReply(transcript);
    const out = await synthesizeHaider(reply, sawtakKey);
    await sendVoice(token, chatId, out.audio, out.duration);
  } catch (e) {
    console.error("voice", String(e?.message || e).slice(0,300));
    try {
      const fallback = await synthesizeHaider("هلا عيني صار خلل بالبصمة هسه، دزها مرة ثانية", sawtakKey);
      await sendVoice(token, chatId, fallback.audio, fallback.duration);
    } catch {
      await sendMessage(token, chatId, "صار خلل بالبصمة هسه، دزها مرة ثانية.").catch(() => {});
    }
  }
}
