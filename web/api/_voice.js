// البصمات (الرسائل الصوتية): فهم الصوت بأي لهجة + رد صوتي بنفس اللهجة
// الفهم: Gemini يسمع الصوت مباشرة. النطق: أصوات Microsoft Edge المجانية (فيها عراقي ar-IQ وخليجي ومصري وشامي…)
// واحتياط: صوت Google Translate.
import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";

const GEMINI_KEYS = () => String(process.env.GEMINI_API_KEY || "").split(/[\s,]+/).filter(Boolean);
const LISTEN_MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-2.5-flash-lite", "gemini-2.0-flash"];

/** يرجع { transcript, dialect } من ملف صوت (Buffer) */
export async function transcribe(audio, mime = "audio/ogg") {
  const prompt = `Listen to this voice message. Return ONLY JSON: {"transcript": "...", "dialect": "..."}
- transcript: exactly what the speaker said, in the original language and dialect, written in its own script (Arabic dialects in Arabic letters, keep dialect words as spoken, do not translate or correct to MSA).
- dialect: one of iraqi, gulf, saudi, egyptian, levantine, maghrebi, sudanese, yemeni, msa, english, other.`;
  const errors = [];
  for (const model of LISTEN_MODELS) {
    for (const key of GEMINI_KEYS()) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ inline_data: { mime_type: mime, data: Buffer.from(audio).toString("base64") } }, { text: prompt }] }],
            generationConfig: { temperature: 0, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
          }),
          signal: AbortSignal.timeout(60_000),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { errors.push(`${model}: ${r.status} ${String(j?.error?.message || "").slice(0, 120)}`); continue; }
        const text = (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
        let out = {};
        try { out = JSON.parse((text.match(/\{[\s\S]*\}/) || ["{}"])[0]); } catch { out = { transcript: text }; }
        const transcript = String(out.transcript || "").trim();
        if (transcript) return { transcript, dialect: String(out.dialect || "other").toLowerCase() };
        errors.push(`${model}: empty`);
      } catch (e) { errors.push(`${model}: ${e.message}`); }
    }
  }
  throw new Error("ما گدرت أسمع البصمة: " + errors.slice(0, 3).join(" | "));
}

// صوت لكل لهجة (أصوات رجالية افتراضيًا)
export const VOICES = {
  iraqi: "ar-IQ-BasselNeural", gulf: "ar-KW-FahedNeural", saudi: "ar-SA-HamedNeural", egyptian: "ar-EG-ShakirNeural",
  levantine: "ar-SY-LaithNeural", maghrebi: "ar-MA-JamalNeural", sudanese: "ar-SA-HamedNeural", yemeni: "ar-YE-SalehNeural",
  msa: "ar-SA-HamedNeural", english: "en-US-AndrewNeural", other: "ar-IQ-BasselNeural",
};
export const DIALECT_NAMES = {
  iraqi: "اللهجة العراقية", gulf: "اللهجة الخليجية", saudi: "اللهجة السعودية", egyptian: "اللهجة المصرية", levantine: "اللهجة الشامية",
  maghrebi: "اللهجة المغاربية", sudanese: "اللهجة السودانية", yemeni: "اللهجة اليمنية", msa: "العربية الفصحى", english: "English", other: "نفس لغة ولهجة المتكلم",
};

// ── Microsoft Edge Read Aloud (مجاني) ──
const TRUSTED = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM = "143.0.3650.75";
function secMsGec() {
  let ticks = Math.floor(Date.now() / 1000) + 11644473600;
  ticks -= ticks % 300;
  return createHash("sha256").update(`${BigInt(ticks) * 10000000n}${TRUSTED}`).digest("hex").toUpperCase();
}
const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&apos;").replace(/"/g, "&quot;");

export function edgeTTS(text, voice = "ar-IQ-BasselNeural", { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED}`
      + `&ConnectionId=${randomUUID().replace(/-/g, "")}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM}`;
    const major = CHROMIUM.split(".")[0];
    const ws = new WebSocket(url, {
      headers: {
        Pragma: "no-cache", "Cache-Control": "no-cache",
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
        "Accept-Encoding": "gzip, deflate, br", "Accept-Language": "en-US,en;q=0.9",
        Cookie: `muid=${randomUUID().replace(/-/g, "").toUpperCase()};`,
      },
    });
    const chunks = [];
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("edge tts timeout")); }, timeout);
    const done = (err) => { clearTimeout(timer); try { ws.close(); } catch { } if (err) reject(err); else if (chunks.length) resolve(Buffer.concat(chunks)); else reject(new Error("edge tts: no audio")); };
    ws.on("open", () => {
      const ts = new Date().toString();
      ws.send(`X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`);
      const lang = voice.split("-").slice(0, 2).join("-");
      ws.send(`X-RequestId:${randomUUID().replace(/-/g, "")}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n`
        + `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'><voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${xmlEscape(text)}</prosody></voice></speak>`);
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.from(data);
        const headLen = buf.readUInt16BE(0);
        const head = buf.subarray(2, 2 + headLen).toString();
        if (head.includes("Path:audio")) chunks.push(buf.subarray(2 + headLen));
      } else if (String(data).includes("Path:turn.end")) done();
    });
    ws.on("unexpected-response", (_req, res) => done(new Error(`edge tts HTTP ${res.statusCode}`)));
    ws.on("error", (e) => done(e));
    ws.on("close", () => done());
  });
}

// ── احتياط: Google Translate TTS (فصحى تقريبًا، 200 حرف لكل جزء) ──
export async function googleTTS(text, lang = "ar") {
  const parts = [];
  let rest = String(text).replace(/\s+/g, " ").trim();
  while (rest) {
    let cut = rest.length <= 190 ? rest.length : Math.max(rest.lastIndexOf(" ", 190), rest.lastIndexOf("،", 190), rest.lastIndexOf(".", 190));
    if (cut <= 0) cut = 190;
    parts.push(rest.slice(0, cut)); rest = rest.slice(cut).trim();
  }
  const out = [];
  for (const p of parts.slice(0, 12)) {
    const r = await fetch(`https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${lang}&q=${encodeURIComponent(p)}`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`google tts HTTP ${r.status}`);
    out.push(Buffer.from(await r.arrayBuffer()));
  }
  return Buffer.concat(out);
}

/** يرجع MP3 (Buffer) للنص بصوت مناسب للهجة */
export async function speak(text, dialect = "iraqi") {
  const clean = String(text).replace(/[*_#`>|]/g, " ").replace(/https?:\/\/\S+/g, "").replace(/\p{Extended_Pictographic}/gu, "").replace(/\s+/g, " ").trim().slice(0, 2500);
  if (!clean) throw new Error("نص فارغ");
  const voice = VOICES[dialect] || VOICES.other;
  try { return { audio: await edgeTTS(clean, voice), voice }; }
  catch (e) {
    console.error("edge tts", e.message);
    if (voice !== VOICES.iraqi && voice.startsWith("ar-")) { try { return { audio: await edgeTTS(clean, VOICES.iraqi), voice: VOICES.iraqi }; } catch { } }
    return { audio: await googleTTS(clean, dialect === "english" ? "en" : "ar"), voice: "google" };
  }
}
