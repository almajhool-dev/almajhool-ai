import test from "node:test";
import assert from "node:assert/strict";

process.env.SAWTAK_API_KEY = "test-key";

const sawtak = await import("./_sawtak.js");
const { sawtakVoiceIdFromList, sawtakTTSRaw, sawtakTranscribe, prepareIraqiTTS, splitIraqiTTS, sawtakTTSJoined } = sawtak;

test("selects the ready Haider Iraqi voice", () => {
  const id = sawtakVoiceIdFromList({
    data: [
      { id: "old", name: "حيدر", status: "processing" },
      { id: "haider-ready", name: "حيدر", status: "ready", dialect: "Iraqi", gender: "male" },
      { id: "other", name: "سرمد", status: "ready" },
    ],
  });
  assert.equal(id, "haider-ready");
});

test("Sawtak TTS requests Haider and returns raw PCM plus sample rate", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousVoice = process.env.SAWTAK_HAIDER_VOICE_ID;
  process.env.SAWTAK_HAIDER_VOICE_ID = "haider-ready";

  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), "https://api.sawtakarabi.ai/v1/audio/speech");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer test-key");
    const body = JSON.parse(init.body);
    assert.equal(body.voice, "haider-ready");
    assert.equal(body.model, "arabic-tts-1");
    assert.equal(body.response_format, "pcm");
    assert.equal(body.sample_rate, 24000);
    assert.equal(body.normalize_text, true);
    assert.equal(body.enhance_pronunciation, true);
    assert.equal(body.temperature, 0.35);
    assert.equal(body.input, "هلو شلونك.");

    const pcm = new Uint8Array([0, 0, 1, 0, 2, 0, 3, 0]);
    return new Response(pcm, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream", "X-Sample-Rate": "24000" },
    });
  };

  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousVoice == null) delete process.env.SAWTAK_HAIDER_VOICE_ID;
    else process.env.SAWTAK_HAIDER_VOICE_ID = previousVoice;
  });

  const out = await sawtakTTSRaw("هلو شلونك");
  assert.equal(out.sampleRate, 24000);
  assert.deepEqual([...out.pcm], [0, 0, 1, 0, 2, 0, 3, 0]);
});

test("Sawtak STT sends Telegram voice audio and returns Iraqi transcript", async (t) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), "https://api.sawtakarabi.ai/v1/audio/transcriptions");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer test-key");
    assert.ok(init.body instanceof FormData);
    assert.equal(init.body.get("model"), "arabic asr");
    assert.equal(init.body.get("response_format"), "json");
    assert.equal(init.body.get("language"), "ar");
    const file = init.body.get("file");
    assert.ok(file instanceof Blob);
    assert.equal(file.type, "audio/ogg");
    return Response.json({ text: "هلو شلونك شخبارك" });
  };
  t.after(() => { globalThis.fetch = previousFetch; });

  const heard = await sawtakTranscribe(new Uint8Array([1, 2, 3, 4]), "audio/ogg");
  assert.deepEqual(heard, { transcript: "هلو شلونك شخبارك", dialect: "iraqi" });
});


test("prepares Iraqi speech text for clear pacing", () => {
  assert.equal(prepareIraqiTTS("هلووووو شلونك"), "هلوو شلونك.");
  const long = "هلو عيني شلونك اليوم ان شاء الله كلشي تمام وياك وامورك زينة وماكو شي يضوجك";
  const out = prepareIraqiTTS(long);
  assert.ok(out.includes("، "));
  assert.ok(out.endsWith("."));
  assert.ok(!out.includes("وووو"));
});


test("splits long Iraqi replies into short speech chunks", () => {
  const text = "هلو عيني شلونك اليوم؟ آني حاضر وياك وكلشي تمام. إذا تريد أي شي گلي وأنا أساعدك هسه بدون ما أطول عليك بالحچي.";
  const chunks = splitIraqiTTS(text, 55);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((part) => part.length <= 55));
  assert.equal(chunks.join(" ").replace(/\s+/g, " ").trim(), prepareIraqiTTS(text).replace(/\s+/g, " ").trim());
});


test("keeps a normal Telegram voice reply in one Sawtak request", async (t) => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body });
    const pcm = new Uint8Array([0,0,1,0,2,0,3,0]);
    return new Response(pcm, { status: 200, headers: { "X-Sample-Rate": "24000" } });
  };
  t.after(() => { globalThis.fetch = previousFetch; });

  const phrase = "هلو عيني شلونك، آني حاضر وياك وكلشي تمام، وإذا تريد أي شي گلي وأنا أساعدك هسه. ";
  const text = phrase.repeat(5).trim();
  assert.ok(text.length > 260 && text.length < 900);
  const out = await sawtakTTSJoined(text, { retries: 0 });
  assert.equal(calls.length, 1);
  assert.ok(out.pcm.byteLength > 0);
});


test("normalizes quiet PCM before Telegram MP3", async () => {
  const { pcmToMp3 } = await import("./_voice.js");
  const samples = new Int16Array(24000);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(i / 12) * 1200);
  const pcm = new Uint8Array(samples.buffer);
  const mp3 = pcmToMp3(pcm, 24000);
  assert.ok(mp3.byteLength > 1000);
});
