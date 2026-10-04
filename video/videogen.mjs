// إنشاء مقطع بالذكاء الاصطناعي من وصف — يشتغل على أجهزة GitHub ويدز المقطع للمستخدم بتلكرام
// البيانات توصل من البوت: { chat_id, reply_to, status_message_id, prompt (إنكليزي), request (كلام المستخدم) }
//
// الطريقة الأساسية (بدون أي حساب أو مفتاح جديد): «فيلم قصير»
//   Gemini يكتب قصة من 4 مشاهد ← كل مشهد يترسم بالذكاء الاصطناعي ← حركة كاميرا سينمائية وانتقالات ناعمة
//   ← تعليق صوتي عراقي + نص عربي على الشاشة
// وإذا اكو HF_TOKEN: نجرب أول نماذج التحريك الكامل (Wan / LTX) على GPU المجاني
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { GlobalFonts, createCanvas } from "@napi-rs/canvas";
import { directText } from "./api/_direct.js";
import { bestImage, fallbackImage } from "./api/_images.js";
import { speak } from "./api/_voice.js";
import { gradioRun } from "./api/_videogen.js";

const BOT = process.env.TELEGRAM_BOT_TOKEN;
const job = JSON.parse(process.env.JOB || "{}") || {};
if (!job.chat_id && process.env.TEST_IMAGE_URL) job.image_url = process.env.TEST_IMAGE_URL; // تجربة: مقطع من صورة
const request = job.request || process.env.TEST_PROMPT || "أسد يركض بالصحرا وقت الغروب";
const W = 1080, H = 1080, FPS = 30, FADE = 0.6;
const DIR = "vg"; fs.mkdirSync(DIR, { recursive: true });

const tg = async (method, body) => {
  if (!BOT || !job.chat_id) return null;
  const r = await fetch(`https://api.telegram.org/bot${BOT}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json().catch(() => null);
};
const say = (text) => job.status_message_id ? tg("editMessageText", { chat_id: job.chat_id, message_id: job.status_message_id, text }) : null;
const ff = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });
const dur = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim()) || 0;
const parseJson = (t) => { try { return JSON.parse((String(t).match(/\{[\s\S]*\}/) || ["{}"])[0]); } catch { return {}; } };

// ── تحريك كامل (يحتاج HF_TOKEN) ──
async function motionVideo() {
  const spaces = ["zerogpu-aoti/wan2-2-fp8da-aoti-faster", "Lightricks/ltx-video-distilled", "multimodalart/wan2-1-fast"];
  for (const sp of spaces) {
    try {
      const r = await gradioRun(sp, { prompt: job.prompt || request, timeout: 15 * 60_000 });
      const v = await fetch(r.url, { headers: r.auth }); const buf = Buffer.from(await v.arrayBuffer());
      if (v.ok && buf.length > 10_000) { console.log("MOTION_OK", sp); return buf; }
    } catch (e) { console.log("MOTION_FAIL", sp, String(e.message).slice(0, 200)); }
  }
  return null;
}

// ── فيلم قصير: قصة ← صور ← حركة + صوت + نص ──
// صورة دزها المستخدم («سوي مقطع من هاي الصورة»): تصير أول مشهد، والقصة تكمل منها بنفس الشكل
let userImage = null, imageDesc = "";
async function loadUserImage() {
  if (!job.image_url) return;
  const r = await fetch(job.image_url, { headers: { "User-Agent": "Mozilla/5.0 (almajhool-ai video bot)" }, signal: AbortSignal.timeout(30_000) });
  const ct = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
  if (!r.ok || !ct.startsWith("image/")) { console.log("user image", r.status); return; }
  userImage = `data:${ct};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`;
  imageDesc = String(await directText([{ role: "user", content: [
    { type: "text", text: "Describe this image precisely in English for an image generator: main subject(s) and their exact look, setting, colors, lighting and visual style. One paragraph." },
    { type: "image_url", image_url: { url: userImage } },
  ] }], { provider: "gemini", max_tokens: 400, timeout: 40_000 }).catch(() => ""));
  console.log("USER_IMAGE", imageDesc.slice(0, 300));
}

async function storyboard() {
  const out = await directText([{ role: "user", content: `اكتب قصة مقطع فيديو قصير (4 مشاهد ورا بعض) لهذا الطلب: «${request}»
${userImage ? `المقطع يبدي من صورة المستخدم (المشهد الأول هو الصورة نفسها، وصفها: ${imageDesc}). المشاهد الثانية تكمل القصة بنفس الشخصيات ونفس الستايل بالضبط.` : ""}
${job.prompt ? `(وصف إنكليزي مساعد: ${job.prompt})` : ""}
رجّع JSON فقط:
{"style_en":"<one visual style for all scenes: e.g. cinematic photorealistic, golden hour, 35mm>",
 "character_en":"<exact look of the main subject(s), repeated in every scene so they look the same>",
 "scenes":[{"visual_en":"<English image prompt for this scene: subject + action + setting + camera framing>","caption_ar":"<نص قصير على الشاشة، 2-5 كلمات>","narration_ar":"<جملة تعليق صوتي باللهجة العراقية، 6-14 كلمة>"}]}
المشاهد لازم تكمل بعضها كقصة (بداية، تطور، ذروة، نهاية)، وكلها عن الطلب نفسه بالضبط.` }],
  { provider: "gemini", max_tokens: 1200, timeout: 60_000 });
  const j = parseJson(out);
  const scenes = (j.scenes || []).filter((s) => s?.visual_en).slice(0, 5);
  if (scenes.length < 2) throw new Error("storyboard failed: " + String(out).slice(0, 200));
  return { style: j.style_en || "cinematic, highly detailed", character: j.character_en || "", scenes };
}

// المشاهد تترسم وحدة ورا وحدة (الطلبات المجانية بنفس اللحظة تنرفض)، وبنفس الـ seed حتى يبقى الستايل واحد
const SEED = Math.floor(Math.random() * 1e9);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollinations(prompt) {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 1500))}?width=1024&height=1024&seed=${SEED}&nologo=true&model=flux&referrer=almajhool-ai.vercel.app`;
  const res = await fetch(url, { headers: process.env.POLLINATIONS_API_KEY ? { Authorization: `Bearer ${process.env.POLLINATIONS_API_KEY}` } : {}, signal: AbortSignal.timeout(120_000) });
  const ct = (res.headers.get("content-type") || "").split(";")[0];
  if (!res.ok || !ct.startsWith("image/")) throw new Error(`pollinations ${res.status}`);
  return `data:${ct};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
}
async function sceneImage(prompt) {
  for (let a = 0; a < 3; a++) {
    try { return await pollinations(prompt); } catch (e) { console.log("pollinations", a, e.message); await sleep(4000 * (a + 1)); }
  }
  try { const r = await bestImage(prompt, request, null); if (r?.image) return r.image; } catch (e) { console.log("bestImage", String(e.message).slice(0, 160)); }
  return (await fallbackImage(prompt)).image;
}

function captionPng(text, file) {
  GlobalFonts.registerFromPath("fonts/maj-arabic.ttf", "MajArabicVG");
  const c = createCanvas(W, H), g = c.getContext("2d");
  if (text) {
    let size = 64; g.font = `bold ${size}px MajArabicVG`;
    while (size > 30 && g.measureText(text).width > W * 0.86) { size -= 2; g.font = `bold ${size}px MajArabicVG`; }
    const bh = size * 1.9, y = H - bh - 60;
    const grad = g.createLinearGradient(0, y - 40, 0, H);
    grad.addColorStop(0, "rgba(0,0,0,0)"); grad.addColorStop(0.35, "rgba(0,0,0,0.55)"); grad.addColorStop(1, "rgba(0,0,0,0.75)");
    g.fillStyle = grad; g.fillRect(0, y - 40, W, H - y + 40);
    g.direction = "rtl"; g.textAlign = "center"; g.textBaseline = "middle";
    g.shadowColor = "rgba(0,0,0,0.8)"; g.shadowBlur = 12;
    g.fillStyle = "#ffffff"; g.fillText(text, W / 2, y + bh / 2);
  }
  fs.writeFileSync(file, c.toBuffer("image/png"));
}

async function storyVideo() {
  await loadUserImage().catch((e) => console.log("user image", e.message));
  const sb = await storyboard();
  console.log("STORY", JSON.stringify(sb).slice(0, 600));
  // الأصوات كلها بنفس الوقت، والصور وحدة ورا وحدة
  const voiceJobs = sb.scenes.map((s) => s.narration_ar ? speak(s.narration_ar, "iraqi").then((v) => v.audio).catch((e) => (console.log("tts", e.message), null)) : null);
  const images = [];
  for (const [i, s] of sb.scenes.entries()) {
    await say(`🎨 دا أرسم المشهد ${i + 1} من ${sb.scenes.length}…`);
    if (i === 0 && userImage) { images.push(userImage); continue; }
    images.push(await sceneImage(`${s.visual_en}. ${sb.character}. Style: ${sb.style}. No text, no letters, no watermark.`));
  }
  const parts = await Promise.all(sb.scenes.map(async (s, i) => {
    const [img, voice] = [images[i], await voiceJobs[i]];
    const imgFile = `${DIR}/s${i}.png`;
    fs.writeFileSync(`${DIR}/s${i}.raw`, Buffer.from(img.split(",")[1], "base64"));
    ff(["-i", `${DIR}/s${i}.raw`, "-vf", `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2}`, imgFile]);
    let voiceFile = null, d = 4;
    if (voice) { voiceFile = `${DIR}/v${i}.mp3`; fs.writeFileSync(voiceFile, voice); d = Math.max(4, dur(voiceFile) + 0.9); }
    captionPng(s.caption_ar || "", `${DIR}/c${i}.png`);
    return { imgFile, voiceFile, d };
  }));
  await say("🎞 دا أركّب المقطع (حركة كاميرا + صوت + كتابة)…");
  // كل مشهد: زوم سينمائي بطيء (داخل/خارج بالتناوب) + الكتابة
  parts.forEach((p, i) => {
    const frames = Math.round(p.d * FPS);
    const z = i % 2 === 0 ? `min(1+0.10*on/${frames},1.10)` : `max(1.10-0.10*on/${frames},1.0)`;
    const x = i % 3 === 2 ? `(iw-iw/zoom)*on/${frames}` : `iw/2-(iw/zoom/2)`;
    ff(["-loop", "1", "-i", p.imgFile, "-i", `${DIR}/c${i}.png`, "-filter_complex",
      `[0]zoompan=z='${z}':x='${x}':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}[v];[v][1]overlay=0:0,format=yuv420p[o]`,
      "-map", "[o]", "-frames:v", String(frames), "-c:v", "libx264", "-preset", "medium", "-crf", "19", `${DIR}/p${i}.mp4`]);
  });
  // انتقالات ناعمة بين المشاهد
  const inputs = parts.flatMap((_, i) => ["-i", `${DIR}/p${i}.mp4`]);
  let chain = "", last = "[0:v]", offset = 0;
  for (let i = 1; i < parts.length; i++) {
    offset += parts[i - 1].d - FADE;
    chain += `${last}[${i}:v]xfade=transition=fade:duration=${FADE}:offset=${offset.toFixed(3)}[x${i}];`;
    last = `[x${i}]`;
  }
  const total = parts.reduce((a, p) => a + p.d, 0) - FADE * (parts.length - 1);
  // التعليق الصوتي: كل جملة تبدي ويا مشهدها
  const aIn = [], aChain = [];
  let start = 0;
  parts.forEach((p, i) => {
    if (p.voiceFile) { aIn.push("-i", p.voiceFile); const k = parts.length + aIn.length / 2 - 1; aChain.push(`[${k}:a]adelay=${Math.round((start + 0.35) * 1000)}:all=1[a${i}]`); }
    start += p.d - FADE;
  });
  const voices = aChain.map((s) => s.match(/\[a\d+\]$/)[0]);
  const audio = voices.length ? `;${aChain.join(";")};${voices.join("")}amix=inputs=${voices.length}:normalize=0,apad[aout]` : "";
  const out = "generated.mp4";
  ff([...inputs, ...aIn, "-filter_complex", `${chain.replace(/;$/, "")}${parts.length > 1 ? "" : "[0:v]null[x0]"}${audio}`,
    "-map", parts.length > 1 ? last : "[x0]", ...(voices.length ? ["-map", "[aout]", "-c:a", "aac", "-b:a", "160k"] : []),
    "-t", total.toFixed(2), "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
  return fs.readFileSync(out);
}

let buf = null, kind = "story";
try {
  if (process.env.HF_TOKEN) { await say("🎬 دا أسوي المقطع بالتحريك الكامل… ⏳"); buf = await motionVideo(); if (buf) kind = "motion"; }
  if (!buf) buf = await storyVideo();
} catch (e) { console.log("VIDEO_ERROR", e.stack || e.message); }
if (!buf) { await say("ما گدرت أسوي المقطع هسه 🙏 جرّب مرة ثانية بعد شوية."); process.exit(job.chat_id ? 0 : 1); }
fs.writeFileSync("generated.mp4", buf);
console.log("VIDEO_DONE", kind, buf.length, "bytes");
if (job.chat_id) {
  const fd = new FormData();
  fd.append("chat_id", String(job.chat_id));
  fd.append("video", new Blob([buf], { type: "video/mp4" }), "ai-video.mp4");
  fd.append("caption", `🎬 تفضل، هذا المقطع اللي طلبته${job.request ? `:\n«${String(job.request).slice(0, 200)}»` : ""}`);
  fd.append("supports_streaming", "true");
  if (job.reply_to) fd.append("reply_to_message_id", String(job.reply_to));
  const r = await (await fetch(`https://api.telegram.org/bot${BOT}/sendVideo`, { method: "POST", body: fd })).json().catch(() => ({}));
  if (!r.ok) { console.log("SEND_FAIL", r.description); await say("خلص المقطع بس ما گدرت أدزه 🙏 جرّب مرة ثانية."); process.exit(0); }
  if (job.status_message_id) await tg("deleteMessage", { chat_id: job.chat_id, message_id: job.status_message_id });
}
