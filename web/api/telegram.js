// بوت تلكرام الرسمي للموقع: نفس قدرات الموقع (دردشة، صور بكتابة عربية صحيحة، بناء ونشر مواقع، Lovable)
// كل مستخدم بالبوت إله حساب بالموقع (tg:<id>) بنفس الحدود اليومية.
// يحتاج سر واحد بـ GitHub: TELEGRAM_BOT_TOKEN — والنشر التلقائي يربط الـ webhook وحده.
import { createHash } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { DIRECT, GPT_IDS, directConfigured, directText } from "./_direct.js";
import { ensembleAnswer } from "./_ensemble.js";
import { needsSearch, searchAnswer } from "./_search.js";
import { ImageError, generateImage } from "./_imagegen.js";
import { AR_SITE, detectIntent, stripLovable } from "./_intent.js";
import { applyOverlaysServer } from "./_overlay.js";
import { generateSiteHtml } from "./_sitegen.js";
import { DIALECT_NAMES, speak, transcribe } from "./_voice.js";
import { ensureVideoTable, wakeWorker } from "./video-jobs.js";
import { SITES_ORIGIN, estTokens, gateway, json, logUsage, randomId, sql, usageToday } from "./_lib.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || (TOKEN ? createHash("sha256").update(TOKEN).digest("hex").slice(0, 48) : "");
const SITE = (process.env.PUBLIC_URL || "https://almajhool-ai.vercel.app").replace(/\/$/, "");

const SYSTEM = "أنت «المبرمج المجهول AI»، مساعد ذكي جدًا داخل بوت تلكرام. إذا سألك أحد كيف تم بناؤك، أو أي نموذج أو شركة أو تقنية تستخدم، أو منو سواك، جوابك الوحيد: «تم بنائي بواسطة المبرمج المجهول» — بدون أي تفاصيل ثانية، ولا تذكر أبدًا أسماء نماذج أو شركات (مثل Google أو Gemini أو OpenAI أو غيرها) ولا تعطي روابط. الدقة أهم شي: لا تخترع أسماء أو تواريخ أو أرقام، وإذا المستخدم ذكر معلومة لا توافقه عليها إلا إذا متأكد إنها صحيحة، وإذا ما متأكد گول بصراحة. البوت يگدر يرد ببصمة صوتية حقيقية: لا تگول أبدًا إنك ما تگدر ترسل صوت أو بصمة، ولا تكتب «تخيل هاي بصمة». تفهم العربية الفصحى وكل اللهجات (العراقية والخليجية والشامية والمصرية وغيرها) والإنجليزية، حتى مع الأخطاء الإملائية. افهم قصد المستخدم حتى لو كان كلامه مختصرًا أو عاميًا، ورد بنفس لهجته. أجب بدقة ووضوح وباختصار مناسب لتلكرام: نقاط قصيرة، بدون جداول. البوت نفسه يرسم الصور (مثل: ارسملي…) ويبني المواقع وينشرها تلقائيًا ويعطي رابطها مباشرة (مثل: ابنيلي موقع…). لا تكتب كود مشاريع طويل ولا تطلب من المستخدم ينشر بنفسه على Vercel أو GitHub أبدًا: إذا يريد موقع، گله يكتب «ابنيلي موقع …» ويوصف شنو يريد، والبوت يبنيه وينشره ويعطيه الرابط.";

// ───── Telegram API ─────
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.error("telegram", method, j.description);
  return j.result;
}
const send = (chat_id, text, extra = {}) => tg("sendMessage", { chat_id, text: String(text).slice(0, 4096), disable_web_page_preview: false, ...extra });
const edit = (chat_id, message_id, text, extra = {}) => tg("editMessageText", { chat_id, message_id, text: String(text).slice(0, 4096), ...extra });
const action = (chat_id, a) => tg("sendChatAction", { chat_id, action: a });
// «اسأل شات جي بي تي …» / «بـ ChatGPT …»: الجواب من ChatGPT نفسه
const GPT_REQ = /^\s*(اسأل|اسال|سأل|خلي|خل|من|ب|بـ|بال|عن طريق|جاوبني\s+ب|جاوب\s+ب)?\s*(شات\s*جي\s*بي\s*تي|شات\s*جبت|شات\s*gpt|chat\s*gpt|gpt)\s*[:،,]?\s*/i;
// طلب رد صوتي بالكتابة: «دز بصمة»، «رد عليّ ببصمة»، «احچيلي بالصوت»…
const WANTS_VOICE = /(دز|ارسل|أرسل|سوي|سجل|سجّل|رد|ردلي|جاوب|جاوبني|احچي|احكي|احچيلي|احكيلي|سولف|تكلم|كلمني|اسمعني|سمعني|خليني اسمع|اريد|أريد|ابي|أبي)[^\n]{0,25}(بصم|بالصوت|صوت|فويس|ريكورد|voice)|^\s*(بصم[ةه]|بالصوت|صوتي[ةه]?|فويس|voice)\s*[!؟?.]*\s*$/i;
// أسئلة «شلون تم بناؤك / أي نموذج / منو سواك»: جواب ثابت بدون أي معلومة ثانية
const ABOUT = "تم بنائي بواسطة المبرمج المجهول 🤍";
const ASKS_ABOUT = new RegExp([
  "(بنا|بنى|صنع|سوى|سوا|سوّا|برمج|طور|طوّر|صمم|صمّم|انشأ|أنشأ|خلق|درب|درّب)(ك|كم)(\\s|$|[؟?!.])", // منو سواك / صنعك / برمجك
  "تم\\s+(بنا|بناء|بنائ|صنع|تطوير|برمج|انشاء|إنشاء|تدريب)", // كيف تم بناء هاذا النموذج
  "(اي|أي|شنو|شو|ما|ايش|إيش|وش)\\s+(هو\\s+|هي\\s+)?(النموذج|نموذج|الموديل|موديل|model|llm)",
  "(نموذجك|موديلك|مطورك|مبرمجك|صانعك|مصممك|مطوّرك)",
  "(من|منو|مين)\\s+(انت|إنت|أنت|أنتَ)(\\s|$|[؟?!.])",
  "gemini|جيميني|جمناي|جيمناي|جمني|chat\\s*gpt|شات\\s*جي|openai|claude|كلود|llama|deepseek|ديب\\s*سيك|grok|mistral",
  "who\\s+(made|built|created|developed|trained)\\s+you|what\\s+(ai|model|llm)\\s+(are|is)",
].join("|"), "i");
const linkButtons = (rows) => ({ reply_markup: { inline_keyboard: rows.map((r) => r.map(([text, url]) => ({ text, url }))) } });

async function sendPhoto(chat_id, buffer, mime, caption, extra = {}) {
  const fd = new FormData();
  fd.append("chat_id", String(chat_id));
  fd.append("photo", new Blob([buffer], { type: mime }), mime.includes("png") ? "image.png" : "image.jpg");
  if (caption) fd.append("caption", caption.slice(0, 1024));
  if (extra.reply_markup) fd.append("reply_markup", JSON.stringify(extra.reply_markup));
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: "POST", body: fd });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || "sendPhoto failed");
}

async function sendVoice(chat_id, buffer, caption) {
  const fd = new FormData();
  fd.append("chat_id", String(chat_id));
  fd.append("voice", new Blob([buffer], { type: "audio/mpeg" }), "reply.mp3");
  if (caption) fd.append("caption", caption.slice(0, 1024));
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendVoice`, { method: "POST", body: fd });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || "sendVoice failed");
}

/** نص طويل يتقسم على عدة رسائل، ونشيل رموز Markdown حتى يطلع نظيف */
const cleanText = (text) => String(text || "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#{1,6}\s*/gm, "").replace(/^\s*[-*]\s+/gm, "• ").trim();
async function sendLong(chat_id, text) {
  const clean = cleanText(text) || "…";
  for (let i = 0; i < clean.length; i += 4000) await send(chat_id, clean.slice(i, i + 4000));
}

// ───── المستخدم والحالة ─────
let tablesReady = false;
async function ensureTables() {
  if (tablesReady) return;
  await sql`CREATE TABLE IF NOT EXISTS tg_updates (update_id bigint PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS tg_chats (chat_id bigint PRIMARY KEY, user_id text NOT NULL, history jsonb NOT NULL DEFAULT '[]'::jsonb,
            site_slug text, updated_at timestamptz NOT NULL DEFAULT now())`;
  tablesReady = true;
}

async function tgUser(from) {
  const id = `tg:${from.id}`;
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || "مستخدم تلكرام";
  const [u] = await sql`INSERT INTO app_users (id, email, name, role) VALUES (${id}, ${from.username ? `@${from.username}` : null}, ${name}, 'user')
                        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, last_seen = now() RETURNING *`;
  u.daily_tokens = Math.max(Number(u.daily_tokens) || 0, Number(process.env.MIN_DAILY_TOKENS) || 1_000_000);
  u.daily_images = Math.max(Number(u.daily_images) || 0, Number(process.env.MIN_DAILY_IMAGES) || 100);
  return u;
}

async function chatState(chat_id, user_id) {
  const [s] = await sql`INSERT INTO tg_chats (chat_id, user_id) VALUES (${chat_id}, ${user_id})
                        ON CONFLICT (chat_id) DO UPDATE SET updated_at = now() RETURNING *`;
  return s;
}

// ───── القدرات ─────
async function doChat(chat_id, user, state, text, { voice, provider = "auto" } = {}) {
  const usage = await usageToday(user.id);
  if (user.role !== "admin" && usage.tokens >= user.daily_tokens) return send(chat_id, "وصلت حدك اليومي من التوكنات. يتجدد غدًا 🌙");
  await action(chat_id, voice ? "record_voice" : "typing");
  const history = Array.isArray(state.history) ? state.history.slice(-12) : [];
  // البصمة: الرد ينقرى بصوت، فلازم يكون كلام محكي بنفس لهجة المتكلم
  const system = voice ? `${SYSTEM}\nالمستخدم دزلك بصمة صوتية وردك راح يتحول لصوت: رد بـ${DIALECT_NAMES[voice] || DIALECT_NAMES.iraqi} دائمًا (حتى لو هو حچى بلهجة ثانية)، بكلام طبيعي محكي وقصير (أقل من 80 كلمة)، بدون نقاط أو رموز أو إيموجي أو روابط أو كود.` : SYSTEM;
  const messages = [{ role: "system", content: system }, ...history, { role: "user", content: text }];
  let answer = "";
  try {
    if (!directConfigured().length) throw new Error("no direct");
    const factual = needsSearch(text);
    // رد سريع: البصمة (لازم تكون فورية) والسوالف القصيرة — نموذج سريع واحد بدل انتظار كل النماذج
    const quick = provider === "auto" && !factual && (voice || (text.length < 60 && !/\n/.test(text)));
    if (quick) {
      try { answer = await directText(messages, { max_tokens: voice ? 600 : 1500, timeout: 15_000, prefer: DIRECT.find((p) => p.id === "gemini")?.lite }); }
      catch (e) { console.error("quick", e.message); }
    }
    // سؤال عن حقيقة بالبصمة: نجاوب من البحث مباشرة (أسرع من تجميع كل النماذج)
    if (!answer && voice && factual && provider === "auto") {
      try { answer = (await searchAnswer(text, { history })).text; } catch (e) { console.error("search", e.message); }
    }
    if (!answer && provider === "auto") {
      // كل النماذج المتصلة تجاوب بنفس اللحظة، وبعدها نطلع جواب واحد قوي منهم
      try { answer = (await ensembleAnswer(messages, { draftTimeout: voice ? 12_000 : 15_000 })).text; }
      catch (e) { console.error("ensemble", e.message); }
    }
    // إذا تجميع النماذج ما نجح وسؤاله عن حقيقة: نجاوب من بحث Google مباشرة
    if (!answer && provider === "auto" && needsSearch(text)) {
      try { answer = (await searchAnswer(text, { history })).text; } catch (e) { console.error("search", e.message); }
    }
    if (!answer) answer = await directText(messages, { max_tokens: 4096, timeout: 60_000, provider });
  } catch {
    const r = await gateway("/api/chat", { messages, max_tokens: 4096 });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return send(chat_id, "صار خلل بالنماذج، جرّب بعد شوية 🙏");
    answer = d.text || "";
  }
  let spoken = false;
  if (voice) {
    try {
      await action(chat_id, "record_voice");
      const { audio } = await speak(answer, voice);
      const caption = cleanText(answer);
      await sendVoice(chat_id, audio, caption.length <= 1000 ? caption : "");
      spoken = true;
    } catch (e) { console.error("voice reply", e.message); }
  }
  if (!spoken) await sendLong(chat_id, answer);
  const next = [...history, { role: "user", content: text.slice(0, 4000) }, { role: "assistant", content: answer.slice(0, 4000) }].slice(-12);
  await sql`UPDATE tg_chats SET history = ${JSON.stringify(next)}::jsonb WHERE chat_id = ${chat_id}`;
  await logUsage(user.id, "chat", estTokens(JSON.stringify(messages)) + estTokens(answer), "telegram", null);
}

async function doImage(chat_id, user, text) {
  const usage = await usageToday(user.id);
  if (user.role !== "admin" && usage.images >= user.daily_images) return send(chat_id, `وصلت حدك اليومي (${user.daily_images} صورة). يتجدد غدًا 🌙`);
  const status = await send(chat_id, "🎨 جاري رسم الصورة… (تاخذ تقريبًا نص دقيقة)");
  await action(chat_id, "upload_photo");
  let r;
  try { r = await generateImage({ prompt: text }); }
  catch (e) {
    if (status) await edit(chat_id, status.message_id, `ما گدرت أرسمها هسه: ${e instanceof ImageError ? e.message : "خلل مؤقت"}\nجرّب مرة ثانية بعد شوية.`);
    return;
  }
  let { bytes, mime } = r;
  const fixedText = r.overlays.length > 0;
  if (fixedText) {
    try { bytes = await applyOverlaysServer(r.data.image, r.overlays); mime = "image/png"; }
    catch (e) { console.error("overlay", e.message); }
  }
  const id = randomId(12);
  await sql`INSERT INTO images (id, user_id, prompt, model, mime, data, width, height)
            VALUES (${id}, ${user.id}, ${text.slice(0, 2000)}, ${r.data.model || "flux"}, ${mime}, ${bytes}, ${r.w}, ${r.h})`;
  await logUsage(user.id, "image", 0, r.data.provider || "workers-ai", r.data.model || "flux");
  const caption = `تفضل 🎨${fixedText ? `\n✍️ كتبت: ${r.overlays.map((o) => o.text).join("، ")}` : ""}`;
  await sendPhoto(chat_id, bytes, mime, caption);
  if (status) await tg("deleteMessage", { chat_id, message_id: status.message_id });
}

async function doSite(chat_id, user, state, text, kind, isEdit) {
  let current = null;
  if (isEdit && state.site_slug) {
    [current] = await sql`SELECT slug, html FROM sites WHERE slug = ${state.site_slug} AND user_id = ${user.id}`;
  }
  if (!current) {
    const usage = await usageToday(user.id);
    if (user.role !== "admin" && usage.sites >= user.daily_sites) return send(chat_id, `وصلت حدك اليومي (${user.daily_sites} موقع). يتجدد غدًا 🌙`);
  }
  const status = await send(chat_id, current ? "✎ رحت أعدّل موقعك… (دقيقة أو دقيقتين)" : "⌘ رحت أبني موقعك وأنشره… (دقيقة إلى 3 دقايق)");
  const typing = setInterval(() => action(chat_id, "typing"), 5000); action(chat_id, "typing");
  let html;
  try { html = await generateSiteHtml(text, kind || "website", current?.html || ""); }
  catch (e) {
    clearInterval(typing);
    if (status) await edit(chat_id, status.message_id, `ما گدرت أكمل البناء: ${e.message}\nجرّب مرة ثانية.`);
    return;
  }
  clearInterval(typing);
  const title = (html.match(/<title>([^<]{1,120})<\/title>/i)?.[1] || text).slice(0, 120);
  let slug = current?.slug;
  if (slug) {
    await sql`UPDATE sites SET html = ${html}, title = ${title}, prompt = ${text.slice(0, 4000)}, updated_at = now() WHERE slug = ${slug}`;
  } else {
    const a = "abcdefghjkmnpqrstuvwxyz23456789";
    slug = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => a[b % a.length]).join("");
    await sql`INSERT INTO sites (slug, user_id, title, kind, html, prompt) VALUES (${slug}, ${user.id}, ${title}, ${kind || "website"}, ${html}, ${text.slice(0, 4000)})`;
    await logUsage(user.id, "publish");
  }
  await sql`UPDATE tg_chats SET site_slug = ${slug} WHERE chat_id = ${chat_id}`;
  const url = `${SITES_ORIGIN || SITE + "/s"}/${slug}`;
  const msg = `${current ? "✅ عدّلت موقعك ونشرت التحديث على نفس الرابط!" : "✅ موقعك جاهز ومنشور!"}\n${url}\n\nاكتب أي تعديل هنا، مثل: «غيّر اللون للأزرق» أو «ضيف قسم آراء العملاء».\nوإذا تريد موقع جديد: /new`;
  if (status) await tg("deleteMessage", { chat_id, message_id: status.message_id });
  await send(chat_id, msg);
}

async function queueVideo(msg, video) {
  const chat_id = msg.chat.id;
  const user = await tgUser(msg.from);
  if (user.banned) return send(chat_id, "تم إيقاف حسابك من قبل الإدارة.");
  await ensureVideoTable();
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM video_jobs WHERE user_id = ${user.id} AND created_at >= date_trunc('day', now())`;
  const limit = Number(process.env.DAILY_VIDEOS) || 10;
  if (user.role !== "admin" && n >= limit) return send(chat_id, `وصلت حدك اليومي (${limit} مقاطع). يتجدد غدًا 🌙`);
  const [{ q }] = await sql`SELECT count(*)::int AS q FROM video_jobs WHERE status IN ('pending', 'processing')`;
  const mins = Math.max(4, Math.round(4 + ((video.duration || 30) / 60) * 3));
  const instant = !!process.env.GH_DISPATCH_TOKEN;
  const status = await send(chat_id, `🎬 استلمت المقطع وراح أرفع دقته بالذكاء الاصطناعي وأدزه إلك أول ما يخلص.\n⏳ الوقت المتوقع تقريبًا ${instant ? mins : mins + 5}–${instant ? mins * 2 : mins * 2 + 10} دقيقة${q ? ` (قبله ${q} بالطابور)` : ""}. راح أحدّثك هنا بكل مرحلة، وتگدر تكمل شغلك بالبوت عادي.`);
  await sql`INSERT INTO video_jobs (id, user_id, chat_id, message_id, file_id, file_size, duration, width, height, status_message_id)
    VALUES (${randomId(8)}, ${user.id}, ${chat_id}, ${msg.message_id}, ${video.file_id}, ${video.file_size || null}, ${video.duration || null},
            ${video.width || null}, ${video.height || null}, ${status?.message_id || null})`;
  await wakeWorker();
}

const WELCOME = `أهلًا وسهلًا بيك بـ «المبرمج المجهول AI» 👋

اكتب طلبك وأنا أسويه لك:
🎨 تريد صورة؟ اكتب: صمملي صورة …
🌐 تريد موقع؟ اكتب: ابنيلي موقع … وأدزلك رابطه جاهز
🎙 دز بصمة وأرد عليك بصوت وبنفس لهجتك
🎬 دز مقطع فيديو وأرفع دقته وأرجعه إلك
💬 أو اسألني أي سؤال`;

// بصمة: علامة «يسجل بصمة…» تبقى ظاهرة طول ما نشتغل (تلكرام يشيلها بعد 5 ثواني)، حتى المستخدم يعرف إن الرد جاي
async function handle(update) {
  const msg = update.message;
  const chat_id = msg?.chat?.id;
  if (!chat_id || msg.chat.type !== "private" || !(msg.voice || msg.audio || msg.video_note) || msg.text || msg.caption) return handleMessage(update);
  action(chat_id, "record_voice").catch(() => {});
  const tick = setInterval(() => action(chat_id, "record_voice").catch(() => {}), 4500);
  try { return await handleMessage(update); } finally { clearInterval(tick); }
}

async function handleMessage(update) {
  const msg = update.message;
  if (!msg?.from || msg.from.is_bot) return;
  const chat_id = msg.chat.id;
  let text = (msg.text || msg.caption || "").trim();
  if (msg.chat.type !== "private") { // بالمجموعات: فقط إذا ناداه أحد بـ /ai
    if (!/^\/ai(@\w+)?\s/i.test(text)) return;
    text = text.replace(/^\/ai(@\w+)?\s+/i, "");
  }
  // مقطع فيديو: نرفع دقته بالذكاء الاصطناعي على أجهزة GitHub ونرجعه
  const video = msg.chat.type === "private"
    ? (msg.video || msg.animation || (msg.document && /^video\//.test(msg.document.mime_type || "") ? msg.document : null)) : null;
  if (video) return queueVideo(msg, video);
  const media = msg.chat.type === "private" ? (msg.voice || msg.audio || msg.video_note) : null;
  if (!text && !media) return send(chat_id, "اكتب طلبك أو دز بصمة 🎙");
  const user = await tgUser(msg.from);
  if (user.banned) return send(chat_id, "تم إيقاف حسابك من قبل الإدارة.");
  const state = await chatState(chat_id, user.id);
  let voice = null;
  if (media && !text) { // بصمة: نسمعها ونحولها لكلام، ونعرف لهجته حتى نرد بنفسها
    if ((media.file_size || 0) > 20 * 1024 * 1024 || (media.duration || 0) > 600) return send(chat_id, "البصمة طويلة كلش، دز وحدة أقصر من 10 دقايق 🙏");
    await action(chat_id, "typing");
    const file = await tg("getFile", { file_id: media.file_id });
    if (!file?.file_path) return send(chat_id, "ما گدرت أحمّل البصمة، دزها مرة ثانية 🙏");
    const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`);
    const audio = Buffer.from(await r.arrayBuffer());
    const mime = msg.voice ? "audio/ogg" : msg.video_note ? "video/mp4" : (media.mime_type || "audio/mpeg");
    let heard;
    try { heard = await transcribe(audio, mime); }
    catch (e) { console.error(e.message); return send(chat_id, "ما گدرت أسمع البصمة زين، دزها مرة ثانية أو اكتب طلبك 🙏"); }
    text = heard.transcript; voice = "iraqi"; // الرد بالبصمة دائمًا بالعراقي (هذا اللي يريده صاحب البوت)، مهما كانت لهجة المتكلم
  }
  if (/^\/(start|help)\b/i.test(text)) return send(chat_id, WELCOME);
  let provider = "auto";
  if (GPT_REQ.test(text) && text.replace(GPT_REQ, "").trim().length > 2) { provider = [...GPT_IDS, "gemini"]; text = text.replace(GPT_REQ, "").trim(); }
  if (provider === "auto" && ASKS_ABOUT.test(text)) {
    if (voice) { try { return await sendVoice(chat_id, (await speak("تم بنائي بواسطة المبرمج المجهول", voice)).audio, ABOUT); } catch { } }
    return send(chat_id, ABOUT);
  }
  if (/^\/new\b/i.test(text)) {
    await sql`UPDATE tg_chats SET history = '[]'::jsonb, site_slug = NULL WHERE chat_id = ${chat_id}`;
    return send(chat_id, "✨ بدينا من جديد. اكتب طلبك.");
  }
  const intent = detectIntent(text, !!state.site_slug);
  if (intent.type === "lovable") { // بالبوت نبنيه وننشره مباشرة بدل ما نحوله لمنصة ثانية
    const req = stripLovable(text);
    return doSite(chat_id, user, state, req, (AR_SITE.find(([, re]) => re.test(req)) || ["website"])[0], false);
  }
  // «نطيني رابط الموقع» بعد ما وصف موقع بالدردشة: نبني آخر طلب موقع كتبه
  if (intent.type === "chat" && !state.site_slug && /رابط|لينك|link/i.test(text) && /موقع|الموقع|site/i.test(text)) {
    const prev = (Array.isArray(state.history) ? state.history : []).filter((m) => m.role === "user").reverse()
      .map((m) => ({ m, i: detectIntent(m.content) })).find((x) => x.i.type === "site");
    if (prev) return doSite(chat_id, user, state, prev.m.content, prev.i.kind, false);
  }
  if (intent.type === "image") return doImage(chat_id, user, text);
  if (intent.type === "site") return doSite(chat_id, user, state, text, intent.kind, false);
  if (intent.type === "edit") return doSite(chat_id, user, state, text, null, true);
  if (!voice && WANTS_VOICE.test(text)) voice = "iraqi"; // طلب بصمة بالكتابة: نرد بصوت عراقي
  return doChat(chat_id, user, state, text, { voice, provider });
}

export async function POST(request) {
  if (!TOKEN) return json({ error: "TELEGRAM_BOT_TOKEN not set" }, 503);
  if (request.headers.get("x-telegram-bot-api-secret-token") !== SECRET) return json({ error: "forbidden" }, 403);
  const update = await request.json().catch(() => null);
  if (!update?.update_id) return json({ ok: true });
  await ensureTables();
  // تلكرام يعيد إرسال نفس التحديث إذا تأخرنا: ننفذ كل تحديث مرة وحدة بس
  const fresh = await sql`INSERT INTO tg_updates (update_id) VALUES (${update.update_id}) ON CONFLICT DO NOTHING RETURNING update_id`;
  if (!fresh.length) return json({ ok: true });
  // نرد على تلكرام فورًا ونكمل الشغل الطويل (صور ومواقع) بالخلفية
  waitUntil(handle(update).catch(async (e) => {
    console.error("telegram handle", e);
    const chat_id = update.message?.chat?.id;
    if (chat_id) await send(chat_id, "صار خلل مؤقت، جرّب مرة ثانية 🙏").catch(() => {});
  }));
  return json({ ok: true });
}

export async function GET() {
  return json({ bot: TOKEN ? "configured" : "missing TELEGRAM_BOT_TOKEN" });
}
