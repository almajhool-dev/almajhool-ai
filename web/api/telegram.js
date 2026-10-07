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
import { editImage, enhanceImage, planImageFollowup, preciseEdit, redrawPrompt, routeFollowup, verifyEdit, visionMessages } from "./_imageedit.js";
import { DIALECT_NAMES, speak, transcribe } from "./_voice.js";
import { dispatch, ensureVideoTable, wakeWorker } from "./video-jobs.js";
import { SITES_ORIGIN, estTokens, gateway, json, logUsage, randomId, sql, usageToday } from "./_lib.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || (TOKEN ? createHash("sha256").update(TOKEN).digest("hex").slice(0, 48) : "");
const SITE = (process.env.PUBLIC_URL || "https://almajhool-ai.vercel.app").replace(/\/$/, "");

const SYSTEM = "أنت «المبرمج المجهول AI»، مساعد ذكي جدًا داخل بوت تلكرام. إذا سألك أحد كيف تم بناؤك، أو أي نموذج أو شركة أو تقنية تستخدم، أو منو سواك، جوابك الوحيد: «تم بنائي بواسطة المبرمج المجهول» — بدون أي تفاصيل ثانية، ولا تذكر أبدًا أسماء نماذج أو شركات (مثل Google أو Gemini أو OpenAI أو غيرها) ولا تعطي روابط. الدقة أهم شي: لا تخترع أسماء أو تواريخ أو أرقام، وإذا المستخدم ذكر معلومة لا توافقه عليها إلا إذا متأكد إنها صحيحة، وإذا ما متأكد گول بصراحة. البوت يگدر يرد ببصمة صوتية حقيقية: لا تگول أبدًا إنك ما تگدر ترسل صوت أو بصمة، ولا تكتب «تخيل هاي بصمة». تفهم العربية الفصحى وكل اللهجات (العراقية والخليجية والشامية والمصرية وغيرها) والإنجليزية، حتى مع الأخطاء الإملائية. افهم قصد المستخدم حتى لو كان كلامه مختصرًا أو عاميًا، ورد بنفس لهجته. أجب بدقة ووضوح وباختصار مناسب لتلكرام: نقاط قصيرة، بدون جداول. البوت نفسه يرسم الصور (مثل: ارسملي…) ويبني المواقع وينشرها تلقائيًا ويعطي رابطها مباشرة (مثل: ابنيلي موقع…)، ويشوف الصور اللي يدزها المستخدم ويعدل عليها. لا تگول أبدًا إنك سويت أو دزيت صورة أو فيديو أو مقطع أو موقع أو ملف إلا إذا البوت فعلًا سواه، ولا تكتب أبدًا كلام بين أقواس مربعة [ ] (الأقواس بالمحادثة سجل يكتبه البوت نفسه لما ينفذ شي فعلًا). إذا المستخدم يريد مقطع فيديو گله يكتب «سويلي فيديو …» ويوصف شنو يريد. تذكّر كل المحادثة وارجع لها: إذا المستخدم أشار لشي گاله قبل أو لصورة دزها أو رسمناها (مثل «هاي» أو «الصورة» أو «نفس الشي»)، افهم قصده من المحادثة ولا تگول أبدًا إنه ما دز صورة أو إنك ما تتذكر. لا تكتب كود مشاريع طويل ولا تطلب من المستخدم ينشر بنفسه على Vercel أو GitHub أبدًا: إذا يريد موقع، گله يكتب «ابنيلي موقع …» ويوصف شنو يريد، والبوت يبنيه وينشره ويعطيه الرابط.";

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
// «سويلي فيديو/مقطع…»: إنشاء مقطع بالذكاء الاصطناعي من الوصف (مو رفع دقة مقطع)
const VIDEO_GEN = /(سوي|سوّي|سويلي|سوّيلي|اسوي|اعمل|اعملي|اعملّي|انشئ|أنشئ|انشأ|انشاء|إنشاء|حول|حوّل|حولها|حوّلها|خلي|خليها|خلّيها|صمم|صمّم|صمملي|ولد|ولّد|ولدلي|اصنع|ابي|أبي|اريد|أريد|بدي|عايز|make|create|generate)[^\n]{0,40}(فيديو|فديو|ڤيديو|مقطع|كليب|انيميشن|أنيميشن|video|clip|animation)/i;
const isVideoGen = (t) => VIDEO_GEN.test(t) && !/(دق[ةه]|ارفع|إرفع|وضح|وضّح|حسن|حسّن|upscale|enhance|موقع|متجر|تطبيق|لعب[ةه]|صفح[ةه]|website|site|app)/i.test(t);
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
  return j.result;
}

async function sendDocument(chat_id, buffer, mime, filename, caption) {
  const fd = new FormData();
  fd.append("chat_id", String(chat_id));
  fd.append("document", new Blob([buffer], { type: mime }), filename);
  if (caption) fd.append("caption", caption.slice(0, 1024));
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, { method: "POST", body: fd });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || "sendDocument failed");
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
  // آخر صورة بالمحادثة (دزها المستخدم أو رسمناها) + آخر شي اشتغلنا عليه (صورة لو موقع) حتى نفهم «عدّل/شيل/غيّر»
  await sql`ALTER TABLE tg_chats ADD COLUMN IF NOT EXISTS last_image_id text`;
  await sql`ALTER TABLE tg_chats ADD COLUMN IF NOT EXISTS last_kind text`;
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

// ───── الذاكرة ─────
const MEMORY = 40; // آخر 40 رسالة (20 سؤال وجواب) يتذكرها البوت، وفيها الصور والمواقع اللي سواها
const recent = (state) => (Array.isArray(state.history) ? state.history.slice(-MEMORY) : []);
async function remember(chat_id, state, items, extra = {}) {
  const next = [...recent(state), ...items.map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }))].slice(-MEMORY);
  state.history = next;
  await sql`UPDATE tg_chats SET history = ${JSON.stringify(next)}::jsonb,
            last_image_id = COALESCE(${extra.image ?? null}, last_image_id), last_kind = COALESCE(${extra.kind ?? null}, last_kind)
            WHERE chat_id = ${chat_id}`;
  if (extra.image) state.last_image_id = extra.image;
  if (extra.kind) state.last_kind = extra.kind;
}
const SITE_BASE = () => (process.env.SITE_URL || "https://almajhool-ai.vercel.app").replace(/\/$/, "");
async function storeImage(user, bytes, mime, prompt, model, w = null, h = null) {
  const id = randomId(12);
  await sql`INSERT INTO images (id, user_id, prompt, model, mime, data, width, height)
            VALUES (${id}, ${user.id}, ${String(prompt).slice(0, 2000)}, ${model}, ${mime}, ${bytes}, ${w}, ${h})`;
  return id;
}
async function loadImage(id) {
  if (!id) return null;
  const [row] = await sql`SELECT id, mime, data, prompt FROM images WHERE id = ${id}`;
  return row ? { id: row.id, mime: row.mime, bytes: Buffer.from(row.data), prompt: row.prompt } : null;
}

// ───── القدرات ─────
async function doChat(chat_id, user, state, text, { voice, provider = "auto" } = {}) {
  const usage = await usageToday(user.id);
  if (user.role !== "admin" && usage.tokens >= user.daily_tokens) return send(chat_id, "وصلت حدك اليومي من التوكنات. يتجدد غدًا 🌙");
  await action(chat_id, voice ? "record_voice" : "typing");
  const history = recent(state);
  // البصمة: الرد ينقرى بصوت، فلازم يكون كلام محكي بنفس لهجة المتكلم
  const system = voice ? `${SYSTEM}\nالمستخدم دزلك بصمة صوتية وردك راح يتحول لصوت حيدر: رد باللهجة العراقية العامية الطبيعية دائمًا، مو بالفصحى، حتى لو المستخدم حچى بلهجة ثانية. استخدم مفردات عراقية يومية وبسيطة مثل كلام الناس الحقيقي. خلي الرد قصير من جملتين إلى أربع جمل، واستخدم فواصل ونقاط طبيعية حتى تكون الوقفات واضحة. لا تمدد الحروف، لا تكرر الكلمات، ولا تستخدم رموز غريبة أو إيموجي أو روابط أو كود.` : SYSTEM;
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
  answer = String(answer).replace(/^\s*\[[^\]\n]{3,300}\]\s*$/gm, "").replace(/\n{3,}/g, "\n\n").trim() || answer; // ما نخلي النموذج يدّعي إنه سوى شي
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
  await remember(chat_id, state, [{ role: "user", content: text }, { role: "assistant", content: answer }]);
  await logUsage(user.id, "chat", estTokens(JSON.stringify(messages)) + estTokens(answer), "telegram", null);
}

async function doImage(chat_id, user, text, state) {
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
  const id = await storeImage(user, bytes, mime, text, r.data.model || "flux", r.w, r.h);
  await logUsage(user.id, "image", 0, r.data.provider || "workers-ai", r.data.model || "flux");
  const caption = `تفضل 🎨${fixedText ? `\n✍️ كتبت: ${r.overlays.map((o) => o.text).join("، ")}` : ""}`;
  await sendPhoto(chat_id, bytes, mime, caption);
  if (status) await tg("deleteMessage", { chat_id, message_id: status.message_id });
  if (state) await remember(chat_id, state, [{ role: "user", content: text }, { role: "assistant", content: `[رسمت الصورة المطلوبة ودزيتها: ${r.english.slice(0, 300)}]` }], { image: id, kind: "image" });
}

// ───── الصور: سؤال عنها أو تعديل عليها ─────
async function doVision(chat_id, user, state, img, text, { voice } = {}) {
  await action(chat_id, voice ? "record_voice" : "typing");
  const history = recent(state);
  let answer;
  try { answer = await directText(visionMessages(SYSTEM, history, text, img.bytes, img.mime), { provider: "gemini", max_tokens: 1500, timeout: 45_000 }); }
  catch (e) { console.error("vision", e.message); return send(chat_id, "ما گدرت أشوف الصورة هسه، جرّب بعد شوية 🙏"); }
  let spoken = false;
  if (voice) {
    try { const { audio } = await speak(answer, voice); await sendVoice(chat_id, audio, cleanText(answer).slice(0, 1000)); spoken = true; }
    catch (e) { console.error("voice reply", e.message); }
  }
  if (!spoken) await sendLong(chat_id, answer);
  await remember(chat_id, state, [{ role: "user", content: `[عن الصورة] ${text || "شنو بهاي الصورة؟"}` }, { role: "assistant", content: answer }], { kind: "image" });
}

// إنشاء مقطع بالذكاء الاصطناعي: نكتب وصف إنكليزي ممتاز ونبعثه لأجهزة GitHub، وهي تسويه وتدزه للمستخدم
async function doVideoGen(chat_id, user, state, text, reply_to, imageId) {
  const status = await send(chat_id, "🎬 دا أجهز المقطع… ياخذ تقريبًا 1–3 دقايق، وراح يوصلك هنا.");
  let prompt = text;
  try {
    prompt = String(await directText([
      { role: "system", content: "Turn the user's request (any language or dialect) into ONE vivid English text-to-video prompt, max 70 words: main subject and its look, the action/motion, setting, camera movement, lighting and style. Keep every detail the user asked for. Output only the prompt." },
      ...recent(state).slice(-4), { role: "user", content: text },
    ], { provider: "gemini", max_tokens: 300, timeout: 25_000 })).trim().replace(/^["']|["']$/g, "") || text;
  } catch (e) { console.error("video prompt", e.message); }
  const ok = await dispatch("videogen", { chat_id, reply_to, status_message_id: status?.message_id, prompt: prompt.slice(0, 900), request: text.slice(0, 300),
    image_url: imageId ? `${SITE_BASE()}/i/${imageId}` : undefined });
  if (!ok && status) await edit(chat_id, status.message_id, "خدمة إنشاء المقاطع ما تشتغل هسه 🙏 جرّب بعد شوية.");
  await logUsage(user.id, "videogen", 0, "github", "videogen").catch(() => {});
  await remember(chat_id, state, [{ role: "user", content: text }, { role: "assistant", content: `[دا أسوي مقطع فيديو بالذكاء الاصطناعي: ${prompt.slice(0, 200)}]` }]);
}

// تحسين الصورة مثل Remini: نرجعها أوضح وبدقة أعلى (صورة للعرض + ملف بالدقة الكاملة)
async function doEnhance(chat_id, user, state, img, request = "") {
  const usage = await usageToday(user.id);
  if (user.role !== "admin" && usage.images >= user.daily_images) return send(chat_id, `وصلت حدك اليومي (${user.daily_images} صورة). يتجدد غدًا 🌙`);
  const status = await send(chat_id, "✨ دا أوضّح الصورة وأرفع دقتها…");
  const tick = setInterval(() => action(chat_id, "upload_photo").catch(() => {}), 4500); action(chat_id, "upload_photo");
  try {
    const out = await enhanceImage({ bytes: img.bytes, mime: img.mime });
    const id = await storeImage(user, out.bytes, out.mime, `[تحسين] ${request}`, out.provider, out.w, out.h);
    await logUsage(user.id, "image", 0, out.provider, "enhance");
    await sendPhoto(chat_id, out.bytes, out.mime, `✨ وضّحتها ورفعت دقتها (${out.w}×${out.h})\nإذا تريد تعديل عليها گلي.`);
    await sendDocument(chat_id, out.bytes, out.mime, `enhanced-${out.w}x${out.h}.png`, "📎 النسخة الكاملة بدون ضغط").catch((e) => console.error("doc", e.message));
    if (status) await tg("deleteMessage", { chat_id, message_id: status.message_id });
    await remember(chat_id, state, [{ role: "user", content: `[طلب تعديل على الصورة] ${request || "وضّح الصورة وارفع دقتها"}` },
      { role: "assistant", content: `[عدّلت الصورة ودزيتها: وضّحتها ورفعت دقتها إلى ${out.w}×${out.h}]` }], { image: id, kind: "image" });
  } catch (e) {
    console.error("enhance", e.message);
    if (status) await edit(chat_id, status.message_id, "خدمة توضيح الصور مشغولة هسه 🙏 جرّب بعد دقيقة.");
  } finally { clearInterval(tick); }
}

async function doImageEdit(chat_id, user, state, img, request, plan = {}) {
  const usage = await usageToday(user.id);
  if (user.role !== "admin" && usage.images >= user.daily_images) return send(chat_id, `وصلت حدك اليومي (${user.daily_images} صورة). يتجدد غدًا 🌙`);
  const status = await send(chat_id, "🪄 دا أعدّل على الصورة…");
  const tick = setInterval(() => action(chat_id, "upload_photo").catch(() => {}), 4500); action(chat_id, "upload_photo");
  try {
    const how = plan.instruction || request;
    const check = (after) => verifyEdit({ before: img, after, instruction: how });
    let out = null, caption = "تفضل، عدّلتها ✨", note = "";
    // 1) مسح/تبديل/إضافة كتابة: نحدد المكان بالضبط ونعدّل بأنفسنا (بدون تخمين نموذج رسم)
    try {
      out = await preciseEdit({ bytes: img.bytes, mime: img.mime, plan });
      if (out && plan.op !== "add_text") { // نتأكد ما بقى شي، وإذا بقى نعيد مرة على النتيجة
        const v = await check(out).catch(() => ({ ok: true }));
        if (!v.ok) {
          const again = await preciseEdit({ bytes: out.bytes, mime: out.mime, plan }).catch(() => null);
          if (again) out = again;
        }
      }
    } catch (e) { console.error("precise edit", e.message); out = null; }
    // 2) باقي التعديلات: نماذج التعديل، وكل نتيجة يفحصها Gemini قبل ما ندزها
    if (!out) {
      try {
        out = await editImage({ bytes: img.bytes, mime: img.mime, instruction: how, publicUrl: `${SITE_BASE()}/i/${img.id}`, verify: check });
        if (!out.verified) { caption = "هذا أقرب شي گدرت أسويه 🙏 إذا مو مثل ما تريد، وضّحلي أكثر شنو أغيّر وبأي مكان."; note = " (مو مضبوط 100%)"; }
      } catch (e) {
        console.error("image edit", e.message);
        // 3) ما اكو محرك تعديل متاح هسه: نرسم نسخة جديدة قريبة من الصورة بالتعديل المطلوب
        const prompt = await redrawPrompt({ bytes: img.bytes, mime: img.mime, instruction: how });
        const r = await generateImage({ prompt });
        out = { bytes: r.bytes, mime: r.mime, provider: r.data.provider || "redraw" };
        caption = "تفضل 🎨 (رسمتها من جديد قريبة من صورتك ويا التعديل اللي طلبته)"; note = " (نسخة مرسومة من جديد)";
      }
    }
    const id = await storeImage(user, out.bytes, out.mime, `[تعديل] ${request}`, out.provider);
    await logUsage(user.id, "image", 0, out.provider, out.provider);
    await sendPhoto(chat_id, out.bytes, out.mime, caption);
    if (status) await tg("deleteMessage", { chat_id, message_id: status.message_id });
    await remember(chat_id, state, [{ role: "user", content: `[طلب تعديل على الصورة] ${request}` },
      { role: "assistant", content: `[عدّلت الصورة ودزيتها${note}: ${how.slice(0, 300)}]` }], { image: id, kind: "image" });
  } catch (e) {
    console.error("image edit/redraw", e.message);
    if (status) await edit(chat_id, status.message_id, "ما گدرت أعدّل الصورة هسه، جرّب مرة ثانية بعد شوية 🙏");
  } finally { clearInterval(tick); }
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
  await remember(chat_id, state, [{ role: "user", content: text }, { role: "assistant", content: `[${current ? "عدّلت الموقع" : "بنيت الموقع ونشرته"}: ${url}]` }], { kind: "site" });
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
🎙 دز بصمة وأرد عليك بالعراقي بصوت حيدر
📷 دز صورة وأوضّحها وأرفع دقتها، أو اطلب أي تعديل عليها
🎥 اكتب: سويلي فيديو … وأسويلك مقطع بالذكاء الاصطناعي
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

// الصورة بآخر 6 رسائل (دزها، رسمناها، عدلناها، أو سألنا عنها) = المستخدم بعده يحچي عليها
const imageIsRecent = (state) => state.last_kind === "image" &&
  recent(state).slice(-6).some((m) => /^\[(دزيت صورة|رسمت|عدّلت الصورة|عن الصورة|طلب تعديل على الصورة)/.test(String(m.content)));

/** يرجع true إذا تعامل وية الطلب (تعديل/سؤال/صورة جديدة)، وfalse إذا الكلام مو عن الصورة */
async function imageFollowup(chat_id, user, state, img, text, { voice, fromPhoto } = {}) {
  let plan;
  try { plan = await planImageFollowup({ bytes: img.bytes, mime: img.mime, history: recent(state), text }); }
  catch (e) { console.error("image plan", e.message); plan = { action: fromPhoto ? "ask" : "other" }; }
  if (plan.action === "edit") { await doImageEdit(chat_id, user, state, img, text, plan); return true; }
  if (plan.action === "enhance") { await doEnhance(chat_id, user, state, img, text); return true; }
  if (plan.action === "video") { await doVideoGen(chat_id, user, state, text, undefined, img.id); return true; }
  if (plan.action === "ask" || (fromPhoto && plan.action === "other")) { await doVision(chat_id, user, state, img, text, { voice }); return true; }
  if (plan.action === "new") { await doImage(chat_id, user, text, state); return true; }
  return false;
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
  // صورة دزها المستخدم (كصورة أو كملف)
  const photo = msg.photo?.length ? msg.photo[msg.photo.length - 1]
    : (msg.document && /^image\//.test(msg.document.mime_type || "") ? msg.document : null);
  if (!text && !media && !photo) return send(chat_id, "اكتب طلبك أو دز بصمة 🎙");
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
  if (photo) { // نحفظ الصورة كآخر صورة بالمحادثة، وبعدها أي «شيل/غيّر/شنو هاي» يرجع إلها
    if ((photo.file_size || 0) > 20 * 1024 * 1024) return send(chat_id, "الصورة كبيرة كلش (أكثر من 20 ميگا)، دزها كصورة عادية مو كملف 🙏");
    await action(chat_id, "typing");
    const file = await tg("getFile", { file_id: photo.file_id });
    if (!file?.file_path) return send(chat_id, "ما گدرت أحمّل الصورة، دزها مرة ثانية 🙏");
    const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    const mime = msg.photo ? "image/jpeg" : (photo.mime_type || "image/jpeg");
    const id = await storeImage(user, bytes, mime, "[صورة من المستخدم]", "upload", photo.width || null, photo.height || null);
    if (!text) { // صورة بدون كلام: نوضّحها ونرفع دقتها مباشرة (مثل Remini)، وبعدها يگدر يطلب أي تعديل
      await remember(chat_id, state, [{ role: "user", content: "[دزيت صورة]" }], { image: id, kind: "image" });
      return doEnhance(chat_id, user, state, { id, bytes, mime });
    }
    await remember(chat_id, state, [{ role: "user", content: "[دزيت صورة]" }], { image: id, kind: "image" });
    return imageFollowup(chat_id, user, state, { id, bytes, mime }, text, { voice: null, fromPhoto: true });
  }
  if (/^\/(start|help)\b/i.test(text)) return send(chat_id, WELCOME);
  let provider = "auto";
  if (GPT_REQ.test(text) && text.replace(GPT_REQ, "").trim().length > 2) { provider = [...GPT_IDS, "gemini"]; text = text.replace(GPT_REQ, "").trim(); }
  if (provider === "auto" && ASKS_ABOUT.test(text)) {
    if (voice) { try { return await sendVoice(chat_id, (await speak("تم بنائي بواسطة المبرمج المجهول", voice)).audio, ABOUT); } catch { } }
    return send(chat_id, ABOUT);
  }
  if (/^\/new\b/i.test(text)) {
    await sql`UPDATE tg_chats SET history = '[]'::jsonb, site_slug = NULL, last_image_id = NULL, last_kind = NULL WHERE chat_id = ${chat_id}`;
    return send(chat_id, "✨ بدينا من جديد. اكتب طلبك.");
  }
  // آخر شي اشتغلنا عليه صورة (أو المستخدم ذكر «الصورة»): نشوف الصورة ويا المحادثة ونفهم شيريد منها
  if (state.last_image_id && provider === "auto" && (imageIsRecent(state) || /(ال)?صور(ة|ه)|بالصور|image|photo/i.test(text))) {
    const img = await loadImage(state.last_image_id);
    if (img) {
      const handled = await imageFollowup(chat_id, user, state, img, text, { voice });
      if (handled) return;
    }
  }
  if (provider === "auto" && isVideoGen(text)) return doVideoGen(chat_id, user, state, text, msg.message_id);
  let intent = detectIntent(text, !!state.site_slug);
  // رسالة قصيرة («حوله»، «سويها»، «اي يلا») بعد ما انعرض شي: نفهم من المحادثة شنو ينطلب وننفذه فعلًا
  if (provider === "auto" && intent.type === "chat" && text.length <= 40 && recent(state).length >= 2) {
    try {
      const r = await routeFollowup({ history: recent(state), text });
      if (r.action === "video") return doVideoGen(chat_id, user, state, r.request, msg.message_id);
      if (r.action === "image") return doImage(chat_id, user, r.request, state);
      if (r.action === "site") { const it = detectIntent(r.request); return doSite(chat_id, user, state, r.request, it.kind || "website", false); }
    } catch (e) { console.error("route", e.message); }
  }
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
  if (intent.type === "image") return doImage(chat_id, user, text, state);
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
