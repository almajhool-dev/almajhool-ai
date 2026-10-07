// Sawtak Arabi client for Telegram voice notes.
// Sawtak voice lookup, TTS and STT all use SAWTAK_API_KEY.
const BASE = "https://api.sawtakarabi.ai/v1";
let cachedHaiderId = "";
const DEFAULT_HAIDER_VOICE_ID = "380ef7b6-ffea-52fd-89bd-d661a9b01bcc";

const apiKey = () => String(process.env.SAWTAK_API_KEY || "").trim();

export function prepareIraqiTTS(text) {
  let s = String(text || "")
    .replace(/\r?\n+/g, ". ")
    .replace(/([؟!.,،])(?:\s*\1)+/g, "$1")
    .replace(/([\u0621-\u064A\u066E-\u06D3])\1{2,}/gu, "$1$1")
    .replace(/\s+/g, " ")
    .trim();

  if (!s) return "";

  const words = s.split(/\s+/);
  if (!/[.؟!،]/u.test(s) && words.length > 12) {
    const chunks = [];
    for (let i = 0; i < words.length; i += 12) chunks.push(words.slice(i, i + 12).join(" "));
    s = chunks.join("، ");
  }

  if (!/[.!؟!]$/u.test(s)) s += ".";
  return s;
}

export function splitIraqiTTS(text, maxChars = 260) {
  const clean = prepareIraqiTTS(text);
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const pieces = clean.match(/[^.؟!،]+[.؟!،]?/gu) || [clean];
  const out = [];
  let current = "";

  const pushWords = (segment) => {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let part = "";
    for (const word of words) {
      const next = part ? part + " " + word : word;
      if (next.length > maxChars && part) {
        out.push(part.trim());
        part = word;
      } else {
        part = next;
      }
    }
    if (part) return part.trim();
    return "";
  };

  for (const raw of pieces) {
    const piece = raw.trim();
    if (!piece) continue;
    const next = current ? current + " " + piece : piece;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    if (current) out.push(current.trim());
    if (piece.length <= maxChars) current = piece;
    else current = pushWords(piece);
  }
  if (current) out.push(current.trim());
  return out.filter(Boolean);
}

function rowsOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.voices)) return payload.voices;
  return [];
}

export function sawtakVoiceIdFromList(payload, preferredName = "حيدر") {
  const wanted = String(preferredName || "حيدر").trim();
  const rows = rowsOf(payload);
  const exact = rows.find((v) => String(v?.name || "").trim() === wanted && String(v?.status || "").toLowerCase() === "ready");
  return exact?.id || exact?.voice_id || "";
}

async function errorText(r) {
  const text = await r.text().catch(() => "");
  try {
    const j = JSON.parse(text);
    return String(j?.error?.message || j?.detail || j?.message || text).slice(0, 500);
  } catch {
    return text.slice(0, 500);
  }
}

export async function sawtakHaiderVoiceId({ timeout = 10_000 } = {}) {
  const pinned = String(process.env.SAWTAK_HAIDER_VOICE_ID || DEFAULT_HAIDER_VOICE_ID).trim();
  if (pinned) return pinned;
  if (cachedHaiderId) return cachedHaiderId;

  const key = apiKey();
  if (!key) throw new Error("SAWTAK_API_KEY not set");
  const url = new URL(`${BASE}/voices`);
  url.searchParams.set("search", "حيدر");
  url.searchParams.set("limit", "10");
  url.searchParams.set("sharing_status", "public");
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`sawtak voices HTTP ${r.status}: ${await errorText(r)}`);
  const j = await r.json();
  const id = sawtakVoiceIdFromList(j, "حيدر");
  if (id) {
    cachedHaiderId = id;
    return id;
  }
  throw new Error("Sawtak voice حيدر not found or not ready");
}

export async function sawtakTTSRaw(text, { timeout = 45_000 } = {}) {
  const key = apiKey();
  if (!key) throw new Error("SAWTAK_API_KEY not set");
  const input = prepareIraqiTTS(text);
  if (!input) throw new Error("Sawtak TTS text is empty");

  const voice = await sawtakHaiderVoiceId({ timeout: Math.min(timeout, 10_000) });
  const r = await fetch(`${BASE}/audio/speech`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "arabic-tts-1",
      voice,
      input,
      response_format: "pcm",
      sample_rate: 24000,
      normalize_text: true,
      enhance_pronunciation: true,
      temperature: 0.35,
    }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`sawtak tts HTTP ${r.status}: ${await errorText(r)}`);
  const sampleRate = Number(r.headers.get("x-sample-rate") || 24000);
  const pcm = new Uint8Array(await r.arrayBuffer());
  if (!pcm.byteLength) throw new Error("sawtak tts: empty audio");
  return { pcm, sampleRate, voice };
}

function extForMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("ogg")) return "ogg";
  if (m.includes("wav")) return "wav";
  if (m.includes("mp4") || m.includes("m4a")) return "m4a";
  if (m.includes("webm")) return "webm";
  return "mp3";
}

export async function sawtakTranscribe(audio, mime = "audio/ogg", { timeout = 45_000 } = {}) {
  const key = apiKey();
  if (!key) throw new Error("SAWTAK_API_KEY not set");
  const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
  if (!bytes.byteLength) throw new Error("Sawtak STT audio is empty");

  const fd = new FormData();
  fd.append("model", "arabic asr");
  fd.append("language", "ar");
  fd.append("response_format", "json");
  fd.append("file", new Blob([bytes], { type: mime }), `voice.${extForMime(mime)}`);

  const r = await fetch(`${BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: fd,
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`sawtak stt HTTP ${r.status}: ${await errorText(r)}`);
  const j = await r.json().catch(() => ({}));
  const transcript = String(j?.text || "").trim();
  if (!transcript) throw new Error("sawtak stt: empty transcript");
  return { transcript, dialect: "iraqi" };
}


export async function sawtakTTSJoined(text, { timeout = 45_000, retries = 1, maxChars = 260 } = {}) {
  const chunks = splitIraqiTTS(text, maxChars);
  if (!chunks.length) throw new Error("Sawtak TTS text is empty");

  const parts = [];
  let sampleRate = 24000;
  let voice = DEFAULT_HAIDER_VOICE_ID;

  for (const chunk of chunks) {
    let result = null;
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        result = await sawtakTTSRaw(chunk, { timeout });
        break;
      } catch (e) {
        lastError = e;
        if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }
    if (!result) throw lastError || new Error("Sawtak TTS failed");
    sampleRate = result.sampleRate || sampleRate;
    voice = result.voice || voice;
    parts.push(result.pcm);
  }

  const silence = new Uint8Array(Math.round(sampleRate * 0.12) * 2);
  const total = parts.reduce((n, p) => n + p.byteLength, 0) + Math.max(0, parts.length - 1) * silence.byteLength;
  const pcm = new Uint8Array(total);
  let offset = 0;
  parts.forEach((part, i) => {
    pcm.set(part, offset);
    offset += part.byteLength;
    if (i < parts.length - 1) {
      pcm.set(silence, offset);
      offset += silence.byteLength;
    }
  });
  return { pcm, sampleRate, voice };
}
