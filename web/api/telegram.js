// بوت تلكرام الرسمي للموقع: نفس قدرات الموقع (دردشة، صور بكتابة عربية صحيحة، بناء ونشر مواقع، Lovable)
// كل مستخدم بالبوت إله حساب بالموقع (tg:<id>) بنفس الحدود اليومية.
// يحتاج سر واحد بـ GitHub: TELEGRAM_BOT_TOKEN — والنشر التلقائي يربط الـ webhook وحده.
import { createHash } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { directConfigured, directText } from "./_direct.js";
import { ImageError, generateImage } from "./_imagegen.js";
import { detectIntent, lovableUrl } from "./_intent.js";
import { applyOverlaysServer } from "./_overlay.js";
import { generateSiteHtml } from "./_sitegen.js";
import { SITES_ORIGIN, estTokens, gateway, json, logUsage, randomId, sql, usageToday } from "./_lib.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || (TOKEN ? createHash("sha256").update(TOKEN).digest("hex").slice(0, 48) : "");
const SITE = (process.env.PUBLIC_URL || "https://almajhool-ai.vercel.app").replace(/\/$/, "");

const SYSTEM = "أنت «المبرمج المجهول AI»، مساعد ذكي جدًا داخل بوت تلكرام. تفهم العربية الفصحى وكل اللهجات (العراقية والخليجية والشامية والمصرية وغيرها) والإنجليزية، حتى مع الأخطاء الإملائية. افهم قصد المستخدم حتى لو كان كلامه مختصرًا أو عاميًا، ورد بنفس لهجته. أجب بدقة ووضوح وباختصار مناسب لتلكرام: نقاط قصيرة، بدون جداول. البوت نفسه يرسم الصور (مثل: ارسملي…) ويبني المواقع وينشرها تلقائيًا ويعطي رابطها مباشرة (مثل: ابنيلي موقع…). لا تكتب كود مشاريع طويل ولا تطلب من المستخدم ينشر بنفسه على Vercel أو GitHub أبدًا: إذا يريد موقع، گله يكتب «ابنيلي موقع …» ويوصف شنو يريد، والبوت يبنيه وينشره ويعطيه الرابط.";

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
// تلكرام يرفض أزرار الروابط الطويلة جدًا (والرسالة كلها تفشل): نقصّر طلب Lovable إذا طال
const lovableLink = (text) => { const u = lovableUrl(text); return u.length <= 2000 ? u : lovableUrl(String(text).slice(0, 220)); };
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

/** نص طويل يتقسم على عدة رسائل، ونشيل رموز Markdown حتى يطلع نظيف */
async function sendLong(chat_id, text) {
  const clean = String(text || "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#{1,6}\s*/gm, "").replace(/^\s*[-*]\s+/gm, "• ").trim() || "…";
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
async function doChat(chat_id, user, state, text) {
  const usage = await usageToday(user.id);
  if (user.role !== "admin" && usage.tokens >= user.daily_tokens) return send(chat_id, "وصلت حدك اليومي من التوكنات. يتجدد غدًا 🌙");
  await action(chat_id, "typing");
  const history = Array.isArray(state.history) ? state.history.slice(-12) : [];
  const messages = [{ role: "system", content: SYSTEM }, ...history, { role: "user", content: text }];
  let answer = "";
  try {
    if (!directConfigured().length) throw new Error("no direct");
    answer = await directText(messages, { max_tokens: 4096, timeout: 60_000 });
  } catch {
    const r = await gateway("/api/chat", { messages, max_tokens: 4096 });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return send(chat_id, "صار خلل بالنماذج، جرّب بعد شوية 🙏");
    answer = d.text || "";
  }
  await sendLong(chat_id, answer);
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
  await sendPhoto(chat_id, bytes, mime, caption, linkButtons([[["⬇ الصورة بجودة كاملة", `${SITE}/i/${id}`]]]));
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
  await send(chat_id, msg, linkButtons([[["↗ افتح الموقع", url]], [["💜 ابنيه بـ Lovable", lovableLink(text)]]]));
}

const WELCOME = `أهلًا بيك بالبوت الرسمي لـ «المبرمج المجهول AI» 👋
كل شي تسويه بالموقع تگدر تسويه هنا، بس اكتب طلبك:

💬 اسأل أي سؤال: شلون أتعلم البرمجة؟
🎨 صورة: ارسملي أسد لابس تاج ذهبي
✍️ صورة بيها كتابة: صمم صورة رجل دفاع مدني ومكتوب على صدره "علي محمد"
🌐 موقع: ابنيلي موقع مطعم عراقي
✎ تعديل الموقع: غيّر اللون للأزرق
💜 Lovable: ابنيلي موقع متجر بلفيبل

/new — تبدأ من جديد (موقع ومحادثة جديدة)
🔗 الموقع: ${SITE}`;

async function handle(update) {
  const msg = update.message;
  if (!msg?.from || msg.from.is_bot) return;
  const chat_id = msg.chat.id;
  let text = (msg.text || msg.caption || "").trim();
  if (msg.chat.type !== "private") { // بالمجموعات: فقط إذا ناداه أحد بـ /ai
    if (!/^\/ai(@\w+)?\s/i.test(text)) return;
    text = text.replace(/^\/ai(@\w+)?\s+/i, "");
  }
  if (!text) return send(chat_id, "اكتب طلبك كنص (مثلًا: ارسملي قطة، أو ابنيلي موقع) ✍️");
  const user = await tgUser(msg.from);
  if (user.banned) return send(chat_id, "تم إيقاف حسابك من قبل الإدارة.");
  const state = await chatState(chat_id, user.id);
  if (/^\/(start|help)\b/i.test(text)) return send(chat_id, WELCOME, linkButtons([[["🌐 افتح الموقع", SITE]]]));
  if (/^\/new\b/i.test(text)) {
    await sql`UPDATE tg_chats SET history = '[]'::jsonb, site_slug = NULL WHERE chat_id = ${chat_id}`;
    return send(chat_id, "✨ بدينا من جديد. اكتب طلبك.");
  }
  const intent = detectIntent(text, !!state.site_slug);
  if (intent.type === "lovable") {
    return send(chat_id, "💜 جهزت طلبك لمنصة Lovable. اضغط الزر وسجّل دخول بحسابك المجاني، وراح يبدأ يبني الموقع تلقائيًا.\nإذا خلص رصيد Lovable اليومي، اكتب طلبك بدون كلمة لفيبل وأبنيه لك هنا مجانًا.",
      linkButtons([[["💜 ابنيه بـ Lovable", lovableLink(text)]]]));
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
  return doChat(chat_id, user, state, text);
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
