// Sawtak Arabi client for Telegram voice notes.
// Sawtak voice lookup, TTS and STT all use SAWTAK_API_KEY.
const BASE = "https://api.sawtakarabi.ai/v1";
let cachedHaiderId = "";

const apiKey = () => String(process.env.SAWTAK_API_KEY || "").trim();

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
  const pinned = String(process.env.SAWTAK_HAIDER_VOICE_ID || "").trim();
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
  const input = String(text || "").trim();
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
