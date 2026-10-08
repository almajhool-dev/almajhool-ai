import test from "node:test";
import assert from "node:assert/strict";
import { cleanPcm, derivedSecret, splitWords, smallTalkReply, joinPcm } from "./bridge.mjs";

test("derived Telegram secret is stable", () => {
  assert.equal(derivedSecret("123:abc"), derivedSecret("123:abc"));
  assert.equal(derivedSecret("123:abc").length, 48);
});

test("splits Haider text into max four words", () => {
  const parts = splitWords("هلا عيني الحمد لله زين وإنت شلونك شخبارك", 4);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.split(/\s+/).length <= 4));
});

test("small talk stays Iraqi and short", () => {
  assert.match(smallTalkReply("شلونك شخبارك؟"), /هلا عيني/);
  assert.match(smallTalkReply("السلام عليكم"), /وعليكم السلام/);
});

test("trims 320-second padded PCM to audible speech", () => {
  const rate = 24000;
  const samples = new Int16Array(rate * 320);
  for (let i = rate / 10; i < rate * 2.5; i++) samples[i] = Math.round(1400 * Math.sin(i / 8));
  const out = cleanPcm(new Uint8Array(samples.buffer), rate);
  assert.ok(out.rawDuration > 319);
  assert.ok(out.duration > 2 && out.duration < 4);
  assert.ok(out.pcm.length < samples.length / 50);
  assert.ok(out.peakAfter > 10000);
});

test("joins chunks with a short gap", () => {
  const a = new Int16Array(2400);
  const b = new Int16Array(2400);
  const out = joinPcm([a,b], 24000, 100);
  assert.equal(out.length, 2400 + 2400 + 2400);
});
