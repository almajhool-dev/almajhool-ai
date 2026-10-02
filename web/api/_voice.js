// البصمات (الرسائل الصوتية): فهم الصوت بأي لهجة + رد صوتي بنفس اللهجة
// الفهم: Gemini يسمع الصوت مباشرة. النطق: أصوات Microsoft Edge المجانية (فيها عراقي ar-IQ وخليجي ومصري وشامي…)
// واحتياط: صوت Google Translate.
import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { Mp3Encoder } from "@breezystack/lamejs";

const GEMINI_KEYS = () => String(process.env.GEMINI_API_KEY || "").split(/[\s,]+/).filter(Boolean);
const LISTEN_MODELS = () => {
  const custom = String(process.env.GEMINI_LISTEN_MODELS || process.env.GEMINI_MODELS || "").split(",").map((x) => x.trim()).filter(Boolean);
  return custom.length ? custom : [
    // كل نموذج إله حصة مجانية منفصلة: كل ما زادت النماذج، صعب تخلص الحصة وتعلگ البصمة
    "gemini-flash-latest", "gemini-3.8-flash", "gemini-flash-lite-latest", "gemini-3.7-flash", "gemini-3.6-flash",
    "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-3-flash-preview", "gemini-2.5-flash",
  ];
};
const gone = new Set(); // نماذج انشالت أو ما متاحة لهذا المفتاح — ما نرجعلها
const tired = new Map(); // نموذج خلصت حصته: نتركه 3 دقايق ونجرب غيره
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** يرجع { transcript, dialect } من ملف صوت (Buffer) */
export async function transcribe(audio, mime = "audio/ogg") {
  const prompt = `Listen to this voice message. Return ONLY JSON: {"transcript": "...", "dialect": "..."}
- transcript: exactly what the speaker said, in the original language and dialect, written in its own script (Arabic dialects in Arabic letters, keep dialect words as spoken, do not translate or correct to MSA).
- dialect: one of iraqi, gulf, saudi, egyptian, levantine, maghrebi, sudanese, yemeni, msa, english, other.`;
  const data = Buffer.from(audio).toString("base64");
  const errors = [];
  let retryDelay = 0;
  // محاولة وحدة: نموذج + مفتاح، بوقت محدود (أحيانًا نموذج يعلگ دقيقة كاملة)
  const once = async (model, key, ms) => {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ inline_data: { mime_type: mime, data } }, { text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(ms),
    }).catch((e) => { throw new Error(`${model}: ${e.name === "TimeoutError" ? "timeout" : e.message}`); });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 404) gone.add(model);
      if (r.status === 429) tired.set(model, Date.now() + 180_000);
      if (r.status === 429) retryDelay = Math.max(retryDelay, Number(String(JSON.stringify(j)).match(/"retryDelay":"(\d+)/)?.[1] || 8));
      throw new Error(`${model}: ${r.status} ${String(j?.error?.message || "").slice(0, 120)}`);
    }
    const text = (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    let out = {};
    try { out = JSON.parse((text.match(/\{[\s\S]*\}/) || ["{}"])[0]); }
    catch { // أحيانًا يرجع JSON مكسور: نطلع النص بنفسنا، وإذا بيه رموز \u مكسورة نجرب نموذج ثاني
      const m = text.match(/"transcript"\s*:\s*"([^"]*)"/);
      out = { transcript: m ? m[1] : text, dialect: text.match(/"dialect"\s*:\s*"(\w+)"/)?.[1] };
      if (/\\u0?6?\\|\\u0\b|^\s*\{/.test(out.transcript)) throw new Error(`${model}: bad json`);
    }
    // أحيانًا النموذج يرجع الحروف كرموز \u0623… بدل العربي: نرجعها حروف
    const transcript = String(out.transcript || "").replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).trim();
    if (!transcript) throw new Error(`${model}: empty`);
    return { transcript, dialect: String(out.dialect || "other").toLowerCase() };
  };
  for (let pass = 0; pass < 2; pass++) {
    const live = LISTEN_MODELS().filter((m) => !gone.has(m));
    const fresh = live.filter((m) => !(tired.get(m) > Date.now()));
    const tries = (fresh.length ? fresh : live).flatMap((m) => GEMINI_KEYS().map((k) => [m, k]));
    // أول نموذجين يسمعون بنفس الوقت وناخذ الأسرع، وبعدها الباقي واحد واحد
    try { return await Promise.any(tries.slice(0, 2).map(([m, k]) => once(m, k, 25_000))); }
    catch (e) { errors.push(...(e.errors || [e]).map((x) => x.message)); }
    for (const [m, k] of tries.slice(2)) {
      try { return await once(m, k, 25_000); } catch (e) { errors.push(e.message); }
    }
    // كلهم وصلوا حد الدقيقة: ننتظر مرة وحدة شوية ونعيد
    if (!retryDelay || retryDelay > 20) break;
    await sleep(retryDelay * 1000); retryDelay = 0;
  }
  throw new Error("ما گدرت أسمع البصمة: " + errors.slice(0, 6).join(" | "));
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

// ── Gemini TTS: يحچي اللهجة طبيعي مثل البشر (أوضح من الأصوات الجاهزة باللهجات) ──
const TTS_MODELS = () => {
  const custom = String(process.env.GEMINI_TTS_MODELS || "").split(",").map((x) => x.trim()).filter(Boolean);
  // بالتجربة (نطق ← استماع): 3.1 أكثر نطق عراقي طبيعي («آني، أگدر، كولي»)، و2.5 واضح وسريع
  return custom.length ? custom : ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-3.8-flash-tts", "gemini-2.5-pro-preview-tts"];
};
const TTS_STYLE = {
  iraqi: "Speak in a natural Iraqi Arabic (Baghdadi) accent, like a friendly young Iraqi man chatting with a friend",
  gulf: "Speak in a natural Gulf Arabic (Kuwaiti/Emirati) accent, like a friendly young man",
  saudi: "Speak in a natural Saudi Arabic (Najdi) accent, like a friendly young man",
  egyptian: "Speak in a natural Egyptian Arabic (Cairene) accent, like a friendly young man",
  levantine: "Speak in a natural Levantine Arabic (Syrian/Lebanese) accent, like a friendly young man",
  maghrebi: "Speak in a natural Moroccan Darija accent, like a friendly young man",
  sudanese: "Speak in a natural Sudanese Arabic accent, like a friendly young man",
  yemeni: "Speak in a natural Yemeni Arabic accent, like a friendly young man",
  msa: "Speak clear Modern Standard Arabic, warm and natural",
  english: "Speak in a natural, friendly American English voice",
};
function pcmToMp3(pcm, rate = 24000) {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const enc = new Mp3Encoder(1, rate, 64), out = [];
  for (let i = 0; i < samples.length; i += 1152) { const b = enc.encodeBuffer(samples.subarray(i, i + 1152)); if (b.length) out.push(Buffer.from(b)); }
  const end = enc.flush(); if (end.length) out.push(Buffer.from(end));
  return Buffer.concat(out);
}
const ttsGone = new Set();
export async function geminiTTS(text, dialect = "iraqi", { voiceName = "Charon", timeout = 60_000 } = {}) {
  const errors = [];
  for (const model of TTS_MODELS()) {
    if (ttsGone.has(model)) continue;
    for (const key of GEMINI_KEYS()) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: `${TTS_STYLE[dialect] || TTS_STYLE.iraqi}. Say exactly this, clearly and at a relaxed pace:\n${text}` }] }],
            generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } },
          }),
          signal: AbortSignal.timeout(timeout),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { errors.push(`${model}: ${r.status} ${String(j?.error?.message || "").slice(0, 100)}`); if (r.status === 404) ttsGone.add(model); continue; }
        const part = (j?.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data);
        if (!part) { errors.push(`${model}: no audio`); continue; }
        const rate = Number(String(part.inlineData.mimeType || "").match(/rate=(\d+)/)?.[1] || 24000);
        return pcmToMp3(Buffer.from(part.inlineData.data, "base64"), rate);
      } catch (e) { errors.push(`${model}: ${e.message}`); }
    }
  }
  throw new Error("gemini tts: " + errors.join(" | "));
}

// الأصوات الجاهزة (Edge) ما تعرف «گ» و«چ» و«ڤ»: نحولها لأقرب حرف عربي حتى ما يتكسر النطق
export const normalizeForTTS = (t) => String(t).replace(/گ/g, "ك").replace(/چ/g, "تش").replace(/ڤ/g, "ف").replace(/پ/g, "ب");

/** يرجع MP3 (Buffer) للنص بصوت مناسب للهجة */
export async function speak(text, dialect = "iraqi") {
  const clean = String(text).replace(/[*_#`>|]/g, " ").replace(/https?:\/\/\S+/g, "").replace(/\p{Extended_Pictographic}/gu, "").replace(/\s+/g, " ").trim().slice(0, 2500);
  if (!clean) throw new Error("نص فارغ");
  // 1) Gemini يحچي اللهجة طبيعي  2) أصوات Edge  3) Google
  try { return { audio: await geminiTTS(clean, dialect), voice: "gemini" }; }
  catch (e) { console.error("gemini tts", e.message); }
  const voice = VOICES[dialect] || VOICES.other;
  const edgeText = normalizeForTTS(clean);
  try { return { audio: await edgeTTS(edgeText, voice), voice }; }
  catch (e) {
    console.error("edge tts", e.message);
    if (voice !== VOICES.iraqi && voice.startsWith("ar-")) { try { return { audio: await edgeTTS(edgeText, VOICES.iraqi), voice: VOICES.iraqi }; } catch { } }
    return { audio: await googleTTS(clean, dialect === "english" ? "en" : "ar"), voice: "google" };
  }
}
