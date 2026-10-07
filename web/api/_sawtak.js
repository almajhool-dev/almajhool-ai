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

// Haider currently behaves reliably when punctuation is removed from the text sent to Sawtak.
// Keep punctuation in the LLM answer, but synthesize a plain-space version.
export function prepareSawtakInput(text) {
  return prepareIraqiTTS(text)
    .replace(/[.!?,،؛;:؟…]+/gu, " ")
    .replace(/[\-–—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanSawtakPcm(audio, sampleRate = 24000, {
  paddingMs = 180,
  targetPeak = 24000,
  maxGain = 12,
} = {}) {
  const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio || 0);
  const count = Math.floor(bytes.byteLength / 2);
  if (!count || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("Sawtak PCM is empty");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
  let peak = 0;
  for (let i = 0; i < count; i++) peak = Math.max(peak, Math.abs(view.getInt16(i * 2, true)));
  if (!peak) throw new Error("Sawtak PCM contains only silence");

  // Adaptive threshold: high enough to ignore Sawtak's padded near-zero tail,
  // low enough to preserve soft consonants at the beginning/end of Iraqi speech.
  const threshold = Math.max(20, Math.min(160, Math.round(peak * 0.035)));
  let first = -1, last = -1;
  for (let i = 0; i < count; i++) {
    if (Math.abs(view.getInt16(i * 2, true)) >= threshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0 || last < first) throw new Error("Sawtak PCM has no audible speech");

  const pad = Math.round(sampleRate * Math.max(0, paddingMs) / 1000);
  const start = Math.max(0, first - pad);
  const end = Math.min(count, last + pad + 1);
  const gain = Math.max(1, Math.min(maxGain, targetPeak / peak));

  const out = new ArrayBuffer((end - start) * 2);
  const outView = new DataView(out);
  let peakAfter = 0;
  for (let i = start, j = 0; i < end; i++, j++) {
    const value = Math.max(-32768, Math.min(32767, Math.round(view.getInt16(i * 2, true) * gain)));
    outView.setInt16(j * 2, value, true);
    peakAfter = Math.max(peakAfter, Math.abs(value));
  }

  return {
    pcm: new Uint8Array(out),
    duration: (end - start) / sampleRate,
    rawDuration: count / sampleRate,
    gain,
    peakBefore: peak,
    peakAfter,
  };
}

export function splitSawtakWords(text, maxWords = 4) {
  const clean = prepareSawtakInput(text);
  if (!clean) return [];
  const words = clean.split(/\s+/).filter(Boolean);
  const size = Math.max(2, Math.min(6, Number(maxWords) || 4));
  const out = [];
  for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size).join(" "));
  return out;
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
  const input = prepareSawtakInput(text);
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
  const rawPcm = new Uint8Array(await r.arrayBuffer());
  if (!rawPcm.byteLength) throw new Error("sawtak tts: empty audio");
  const cleaned = cleanSawtakPcm(rawPcm, sampleRate);
  console.log("sawtak audio", {
    rawSeconds: Number(cleaned.rawDuration.toFixed(2)),
    seconds: Number(cleaned.duration.toFixed(2)),
    gain: Number(cleaned.gain.toFixed(2)),
    peakBefore: cleaned.peakBefore,
    peakAfter: cleaned.peakAfter,
  });
  return { pcm: cleaned.pcm, sampleRate, voice, duration: cleaned.duration, rawDuration: cleaned.rawDuration };
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


export async function sawtakTTSJoined(text, { timeout = 75_000, retries = 1, maxWords = 4 } = {}) {
  const chunks = splitSawtakWords(text, maxWords);
  if (!chunks.length) throw new Error("Sawtak TTS text is empty");

  const synthOne = async (chunk) => {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await sawtakTTSRaw(chunk, { timeout });
        const words = chunk.split(/\s+/).filter(Boolean).length;
        const minSeconds = Math.max(0.65, words * 0.28);
        if (result.rawDuration > 30 && result.duration < minSeconds) {
          throw new Error(`Sawtak truncated chunk: ${result.duration.toFixed(2)}s for ${words} words`);
        }
        return result;
      } catch (e) {
        lastError = e;
        if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 450 * (attempt + 1)));
      }
    }
    throw lastError || new Error("Sawtak TTS failed");
  };

  // Sawtak's documented account concurrency is 5. Keep at most 5 short chunks in flight.
  const parts = [];
  for (let i = 0; i < chunks.length; i += 5) {
    const batch = await Promise.all(chunks.slice(i, i + 5).map(synthOne));
    parts.push(...batch);
  }

  const sampleRate = parts[0]?.sampleRate || 24000;
  const voice = parts[0]?.voice || DEFAULT_HAIDER_VOICE_ID;
  const silence = new Uint8Array(Math.round(sampleRate * 0.10) * 2);
  const total = parts.reduce((n, p) => n + p.pcm.byteLength, 0) + Math.max(0, parts.length - 1) * silence.byteLength;
  const pcm = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    pcm.set(parts[i].pcm, offset);
    offset += parts[i].pcm.byteLength;
    if (i < parts.length - 1) {
      pcm.set(silence, offset);
      offset += silence.byteLength;
    }
  }

  return { pcm, sampleRate, voice, duration: pcm.byteLength / 2 / sampleRate, chunks: chunks.length };
}
