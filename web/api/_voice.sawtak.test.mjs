import test from "node:test";
import assert from "node:assert/strict";

process.env.SAWTAK_API_KEY = "test-key";

const voice = await import("./_voice.js");
const { sawtakVoiceIdFromList, sawtakTTS, sawtakTranscribe } = voice;

test("selects the ready Haider Iraqi voice", () => {
  const id = sawtakVoiceIdFromList({
    items: [
      { id: "old", name: "حيدر", status: "processing" },
      { id: "haider-ready", name: "حيدر", status: "ready", dialect: "iraqi", gender: "male" },
      { id: "other", name: "سرمد", status: "ready" },
    ],
  });
  assert.equal(id, "haider-ready");
});

test("Sawtak TTS requests Haider and returns Telegram-ready MP3 bytes", async (t) => {
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
    assert.equal(body.enhance_pronunciation, true);
    assert.equal(body.input, "هلو شلونك");

    const pcm = new Int16Array(2400);
    return new Response(pcm.buffer, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream", "X-Sample-Rate": "24000" },
    });
  };

  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousVoice == null) delete process.env.SAWTAK_HAIDER_VOICE_ID;
    else process.env.SAWTAK_HAIDER_VOICE_ID = previousVoice;
  });

  const audio = await sawtakTTS("هلو شلونك");
  assert.ok(Buffer.isBuffer(audio));
  assert.ok(audio.length > 0);
});

test("Sawtak STT sends Telegram voice audio and returns the transcript", async (t) => {
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

  const heard = await sawtakTranscribe(Buffer.from([1, 2, 3, 4]), "audio/ogg");
  assert.deepEqual(heard, { transcript: "هلو شلونك شخبارك", dialect: "iraqi" });
});
