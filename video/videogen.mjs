// إنشاء مقطع بالذكاء الاصطناعي من وصف — يشتغل على أجهزة GitHub (ما عنده حد وقت السيرفر) ويدز المقطع للمستخدم بتلكرام
// البيانات توصل من البوت: { chat_id, reply_to, status_message_id, prompt (إنكليزي), request (كلام المستخدم) }
import fs from "node:fs";
import { gradioRun } from "./api/_videogen.js";

const BOT = process.env.TELEGRAM_BOT_TOKEN;
const job = JSON.parse(process.env.JOB || "{}") || {};
// أقوى نماذج الفيديو المجانية (تحتاج HF_TOKEN لحصة GPU المجانية). نجرب بالترتيب
const SPACES = (process.env.VIDEO_SPACES || "zerogpu-aoti/wan2-2-fp8da-aoti-faster,Lightricks/ltx-video-distilled,multimodalart/wan2-1-fast").split(",").map((s) => s.trim()).filter(Boolean);

const tg = async (method, body) => {
  if (!BOT || !job.chat_id) return null;
  const r = await fetch(`https://api.telegram.org/bot${BOT}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json().catch(() => null);
};
const say = (text) => job.status_message_id ? tg("editMessageText", { chat_id: job.chat_id, message_id: job.status_message_id, text }) : null;

const prompt = job.prompt || process.env.TEST_PROMPT || "A cute puppy running on a sunny beach, cinematic";
const errors = [];
let out = null;
for (const sp of SPACES) {
  const t = Date.now();
  try {
    await say(`🎬 دا أسوي المقطع… (${SPACES.indexOf(sp) + 1}/${SPACES.length}) ⏳`);
    const r = await gradioRun(sp, { prompt, timeout: 15 * 60_000 });
    const v = await fetch(r.url, { headers: r.auth });
    const buf = Buffer.from(await v.arrayBuffer());
    if (!v.ok || buf.length < 10_000) throw new Error(`download ${v.status} ${buf.length}B`);
    out = { buf, space: sp };
    console.log("VIDEO_OK", sp, ((Date.now() - t) / 1000).toFixed(0) + "s", buf.length);
    break;
  } catch (e) { errors.push(`${sp}: ${String(e.message).slice(0, 200)}`); console.log("VIDEO_FAIL", sp, ((Date.now() - t) / 1000).toFixed(0) + "s", String(e.message).slice(0, 300)); }
}
if (!out) {
  await say(process.env.HF_TOKEN
    ? "ما گدرت أسوي المقطع هسه 🙏 نماذج الفيديو المجانية مزدحمة أو خلصت حصة اليوم. جرّب بعد شوية."
    : "إنشاء المقاطع يحتاج تفعيل من صاحب البوت (مفتاح Hugging Face المجاني) 🙏");
  console.log("ERRORS", errors.join(" || "));
  process.exit(job.chat_id ? 0 : 1);
}
fs.writeFileSync("generated.mp4", out.buf);
if (job.chat_id) {
  const fd = new FormData();
  fd.append("chat_id", String(job.chat_id));
  fd.append("video", new Blob([out.buf], { type: "video/mp4" }), "ai-video.mp4");
  fd.append("caption", `🎬 تفضل، هذا المقطع اللي طلبته${job.request ? `:\n«${String(job.request).slice(0, 200)}»` : ""}`);
  fd.append("supports_streaming", "true");
  if (job.reply_to) fd.append("reply_to_message_id", String(job.reply_to));
  const r = await (await fetch(`https://api.telegram.org/bot${BOT}/sendVideo`, { method: "POST", body: fd })).json().catch(() => ({}));
  if (!r.ok) { console.log("SEND_FAIL", r.description); await say("خلص المقطع بس ما گدرت أدزه 🙏 جرّب مرة ثانية."); process.exit(0); }
  if (job.status_message_id) await tg("deleteMessage", { chat_id: job.chat_id, message_id: job.status_message_id });
}
