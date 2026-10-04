// التعديل على صورة موجودة (صورة دزها المستخدم أو صورة رسمناها له) + فهم الطلب من المحادثة
// 1) Gemini يشوف الصورة ويقرا آخر المحادثة ويفهم «شيل هاي الشغلة» بالضبط شنو يقصد
// 2) نعدّل نفس الصورة: Gemini (إذا عنده حصة) ← Pollinations kontext (POLLINATIONS_API_KEY) ← مساحات Hugging Face (HF_TOKEN)
// 3) إذا كلهم ما ينفعون: نرسم نسخة جديدة قريبة من الصورة بالتعديل المطلوب (ونگول هذا للمستخدم بصراحة)
import { fileURLToPath } from "node:url";
import { GlobalFonts, createCanvas, loadImage } from "@napi-rs/canvas";
import { DIRECT, directText } from "./_direct.js";

const LITE = () => DIRECT.find((p) => p.id === "gemini")?.lite;
const SHARP = ["gemini-flash-latest", "gemini-3.8-flash", "gemini-3.7-flash"]; // تحديد الأماكن يحتاج النموذج الأدق
const toDataUrl = (bytes, mime) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

/** يقرا الصورة + آخر المحادثة + الرسالة الجديدة ويقرر: تعديل / سؤال عنها / صورة جديدة / شي ثاني */
export async function planImageFollowup({ bytes, mime, history = [], text }) {
  const convo = history.slice(-10).map((m) => `${m.role === "user" ? "المستخدم" : "المساعد"}: ${String(m.content).slice(0, 400)}`).join("\n");
  const prompt = `This image is the latest image in a Telegram chat (the user sent it or the assistant made it).
Recent conversation:
${convo || "(none)"}

New user message: "${text || "(sent the image with no text)"}"

Decide what the user wants, using the conversation and the image (they write in Iraqi Arabic; "هاي/هذا/الشغلة" refer to things in this image):
- "edit": change this same image (remove/add/replace/recolor something, change background, write text on it, fix it, make it like X…)
- "ask": a question or request about the image's content (what is this, describe, read the text, is it real…)
- "new": a completely new, unrelated image
- "other": not about the image
For "edit", also classify the kind of edit:
- "remove": only erase something (text, a name, a logo, a watermark, an object, a person…) and nothing else
- "replace_text": change some written text in the image into other text
- "add_text": write new text on the image
- "other": anything else (recolor, change background, add an object, style…)
Return ONLY JSON: {"action":"edit|ask|new|other","op":"remove|replace_text|add_text|other","target":"<remove: exactly which thing(s) to erase, in English, quoting any text exactly as written in the image and saying if it appears more than once; replace_text: the exact old text as written in the image; add_text: where to put the new text>","new_text":"<replace_text/add_text: the exact new text, in the language the user wants>","instruction":"<for edit: one precise English edit instruction that names exactly what to change and where in THIS image, and says to keep everything else identical>"}`;
  const out = await directText([{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: toDataUrl(bytes, mime) } }] }],
    { provider: "gemini", prefer: LITE(), max_tokens: 400, timeout: 25_000 });
  let j = {};
  try { j = JSON.parse((String(out).match(/\{[\s\S]*\}/) || ["{}"])[0]); } catch { /* نرجع other */ }
  const action = ["edit", "ask", "new", "other"].includes(j.action) ? j.action : "other";
  const op = ["remove", "replace_text", "add_text"].includes(j.op) ? j.op : "other";
  return { action, op, target: String(j.target || "").slice(0, 400), newText: String(j.new_text || "").slice(0, 200), instruction: String(j.instruction || "").slice(0, 800) };
}

// ── المحركات ──
const GEMINI_EDIT_MODELS = ["gemini-2.5-flash-image", "gemini-3.1-flash-image", "nano-banana-pro-preview", "gemini-3-pro-image"];
const cooldown = new Map();
const cooled = (k) => (cooldown.get(k) || 0) > Date.now();

async function geminiEdit(bytes, mime, instruction) {
  const keys = String(process.env.GEMINI_API_KEY || "").split(/[\s,]+/).filter(Boolean);
  const errors = [];
  for (const model of GEMINI_EDIT_MODELS) for (const [ki, key] of keys.entries()) {
    const ck = `g${ki}|${model}`;
    if (cooled(ck)) continue;
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ inline_data: { mime_type: mime, data: Buffer.from(bytes).toString("base64") } }, { text: instruction }] }],
          generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { // بدون حصة مجانية (429) أو ما موجود: نتركه 3 ساعات
        cooldown.set(ck, Date.now() + ([429, 404, 400, 403].includes(res.status) ? 3 * 3600_000 : 60_000));
        errors.push(`${model}: ${res.status}`); continue;
      }
      const p = (d?.candidates?.[0]?.content?.parts || []).find((x) => x.inlineData?.data || x.inline_data?.data);
      const inl = p?.inlineData || p?.inline_data;
      if (inl) return { bytes: Buffer.from(inl.data, "base64"), mime: inl.mimeType || inl.mime_type || "image/png", provider: model };
      errors.push(`${model}: no image`);
    } catch (e) { cooldown.set(ck, Date.now() + 60_000); errors.push(`${model}: ${e.message}`); }
  }
  throw new Error(errors.join(" | ") || "gemini: no key");
}

async function pollinationsEdit(publicUrl, instruction) {
  const key = process.env.POLLINATIONS_API_KEY;
  if (!key || !publicUrl) throw new Error("pollinations: no key");
  const errors = [];
  for (const model of ["kontext", "nanobanana", "seedream"]) {
    if (cooled(`p|${model}`)) continue;
    for (const base of ["https://gen.pollinations.ai/image", "https://image.pollinations.ai/prompt"]) {
      try {
        const url = `${base}/${encodeURIComponent(instruction.slice(0, 1500))}?model=${model}&image=${encodeURIComponent(publicUrl)}&nologo=true&referrer=almajhool-ai.vercel.app`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(120_000) });
        const ct = (res.headers.get("content-type") || "").split(";")[0];
        if (res.ok && ct.startsWith("image/")) return { bytes: Buffer.from(await res.arrayBuffer()), mime: ct, provider: `pollinations-${model}` };
        errors.push(`${model}@${base.split("/")[2]}: ${res.status} ${(await res.text().catch(() => "")).slice(0, 80)}`);
        if (res.status === 402 || res.status === 403) cooldown.set(`p|${model}`, Date.now() + 3600_000);
      } catch (e) { errors.push(`${model}: ${e.message}`); }
    }
  }
  throw new Error(errors.join(" | "));
}

// مساحات Hugging Face لتعديل الصور (Gradio). نقرا وصف الواجهة ونعبي القيم حسب نوع كل حقل
const SPACES = ["multimodalart/Qwen-Image-Edit-Fast", "black-forest-labs/FLUX.1-Kontext-Dev", "Qwen/Qwen-Image-Edit"];
const spaceHost = (id) => `https://${id.toLowerCase().replace(/[/._]/g, "-")}.hf.space`;

export async function gradioEdit(space, bytes, mime, instruction) {
  const base = spaceHost(space);
  const auth = process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {};
  const info = await (await fetch(`${base}/gradio_api/info`, { headers: auth, signal: AbortSignal.timeout(20_000) })).json();
  const [ep, spec] = Object.entries(info.named_endpoints || {})[0] || [];
  if (!ep) throw new Error("no endpoint");
  const fd = new FormData();
  fd.append("files", new Blob([bytes], { type: mime }), mime.includes("png") ? "image.png" : "image.jpg");
  const up = await fetch(`${base}/gradio_api/upload`, { method: "POST", headers: auth, body: fd, signal: AbortSignal.timeout(30_000) });
  const [path] = await up.json();
  if (!path) throw new Error(`upload ${up.status}`);
  const file = { path, meta: { _type: "gradio.FileData" }, orig_name: "image.png", mime_type: mime };
  const args = (spec.parameters || []).map((p) => {
    const comp = String(p.component || "").toLowerCase(), name = String(p.parameter_name || p.label || "").toLowerCase();
    if (comp === "gallery") return [{ image: file, caption: null }];
    if (comp.includes("image")) return file;
    if (comp === "textbox" || /prompt|instruction/.test(name)) return instruction;
    if (/rewrite|enhance/.test(name)) return false;
    return p.parameter_default ?? null;
  });
  const start = await fetch(`${base}/gradio_api/call/${ep.replace(/^\//, "")}`, {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ data: args }), signal: AbortSignal.timeout(20_000) });
  const { event_id } = await start.json().catch(() => ({}));
  if (!event_id) throw new Error(`call ${start.status}`);
  const stream = await (await fetch(`${base}/gradio_api/call/${ep.replace(/^\//, "")}/${event_id}`, { headers: auth, signal: AbortSignal.timeout(150_000) })).text();
  const done = [...stream.matchAll(/event:\s*complete\s*\ndata:\s*(.+)/g)].pop();
  if (!done) throw new Error((stream.match(/event:\s*error\s*\ndata:\s*(.+)/)?.[1] || "no result").slice(0, 160));
  const find = (v) => { // أول صورة بالنتيجة (ممكن تكون داخل قائمة أو gallery)
    if (!v) return null;
    if (Array.isArray(v)) { for (const x of v) { const f = find(x); if (f) return f; } return null; }
    if (typeof v === "object") return v.url || (v.path && `${base}/gradio_api/file=${v.path}`) || find(v.image);
    return null;
  };
  const url = find(JSON.parse(done[1]));
  if (!url) throw new Error("no image in result");
  const img = await fetch(url, { headers: auth, signal: AbortSignal.timeout(30_000) });
  const ct = (img.headers.get("content-type") || "image/png").split(";")[0];
  if (!img.ok || !ct.startsWith("image/")) throw new Error(`download ${img.status}`);
  return { bytes: Buffer.from(await img.arrayBuffer()), mime: ct, provider: space };
}

async function hfEdit(bytes, mime, instruction) {
  const errors = [];
  for (const sp of SPACES) {
    if (cooled(`h|${sp}`)) continue;
    try { return await gradioEdit(sp, bytes, mime, instruction); }
    catch (e) { errors.push(`${sp}: ${String(e.message).slice(0, 120)}`); cooldown.set(`h|${sp}`, Date.now() + 10 * 60_000); }
  }
  throw new Error(errors.join(" | "));
}

/**
 * يعدّل نفس الصورة بنماذج التعديل. verify(نتيجة) ← هل انعمل صح؟ نرجع أول نتيجة تنجح بالفحص،
 * وإذا ولا وحدة نجحت نرجع آخر نتيجة ويا verified=false. يرمي خطأ إذا ولا نموذج اشتغل.
 */
export async function editImage({ bytes, mime, instruction, publicUrl, verify }) {
  const errors = [];
  let unverified = null;
  for (const [name, run] of [
    ["gemini", () => geminiEdit(bytes, mime, instruction)],
    ["pollinations", () => pollinationsEdit(publicUrl, instruction)],
    ["huggingface", () => hfEdit(bytes, mime, instruction)],
  ]) {
    try {
      const out = await run();
      if (!verify) return { ...out, verified: true };
      const v = await verify(out).catch(() => ({ ok: true }));
      if (v.ok) return { ...out, verified: true };
      errors.push(`${name}: not done (${v.problem})`);
      unverified = { ...out, verified: false, problem: v.problem };
    } catch (e) { errors.push(`${name}: ${String(e.message).slice(0, 200)}`); }
  }
  if (unverified) return unverified;
  throw new Error(errors.join(" || "));
}

/** احتياط: وصف دقيق للصورة بالإنكليزي ويا التعديل، حتى نرسم نسخة جديدة قريبة منها */
export async function redrawPrompt({ bytes, mime, instruction }) {
  return directText([{ role: "user", content: [
    { type: "text", text: `Describe this image in rich detail as a single English text-to-image prompt (subjects, appearance, clothing, colors, setting, lighting, camera angle, style), then apply this change: "${instruction}". Output only the final prompt.` },
    { type: "image_url", image_url: { url: toDataUrl(bytes, mime) } },
  ] }], { provider: "gemini", prefer: LITE(), max_tokens: 600, timeout: 30_000 });
}

/** سؤال عن الصورة ويا كل المحادثة (Gemini يشوف الصورة) */
export function visionMessages(system, history, text, bytes, mime) {
  return [{ role: "system", content: system }, ...history,
    { role: "user", content: [{ type: "text", text: text || "شنو بهاي الصورة؟" }, { type: "image_url", image_url: { url: toDataUrl(bytes, mime) } }] }];
}

// ───────── التعديل الدقيق (بدون تخمين): Gemini يحدد المكان بالضبط، وإحنا نمسح ونكتب بأنفسنا ─────────
let fontReady = false;
function ensureFont() {
  if (fontReady) return;
  GlobalFonts.registerFromPath(fileURLToPath(new URL("../fonts/maj-arabic.ttf", import.meta.url)), "MajArabicEdit");
  fontReady = true;
}

const parseJson = (out, fallback) => { try { return JSON.parse((String(out).match(/[[{][\s\S]*[\]}]/) || [""])[0]); } catch { return fallback; } };

/** Gemini يرجع مكان كل شي مطلوب بالصورة: [{x0,y0,x1,y1,color}] بالبكسل */
export async function locateTargets({ bytes, mime, target, w, h }) {
  const out = await directText([{ role: "user", content: [
    { type: "text", text: `Find every place in this image that matches: "${target}".
Return ONLY a JSON array, one item per occurrence: [{"box_2d":[ymin,xmin,ymax,xmax],"color":"#rrggbb"}]
- box_2d: coordinates normalized to 0-1000, tight around the whole thing (all letters of the text / the whole object), not around the surrounding container.
- color: the main color of that text or object.
Return [] if it is not in the image.` },
    { type: "image_url", image_url: { url: toDataUrl(bytes, mime) } },
  ] }], { provider: "gemini", prefer: SHARP, max_tokens: 800, timeout: 40_000 });
  const arr = parseJson(out, []);
  return (Array.isArray(arr) ? arr : []).map((it) => {
    const b = it?.box_2d || it?.box || [];
    if (b.length !== 4) return null;
    const [y0, x0, y1, x1] = b.map(Number);
    const box = { x0: Math.max(0, Math.floor((Math.min(x0, x1) / 1000) * w)), y0: Math.max(0, Math.floor((Math.min(y0, y1) / 1000) * h)),
      x1: Math.min(w, Math.ceil((Math.max(x0, x1) / 1000) * w)), y1: Math.min(h, Math.ceil((Math.max(y0, y1) / 1000) * h)),
      color: /^#[0-9a-f]{6}$/i.test(it.color || "") ? it.color : null };
    return box.x1 - box.x0 >= 2 && box.y1 - box.y0 >= 2 ? box : null;
  }).filter(Boolean);
}

/** يمسح المناطق: خلفية سادة (محادثات، لقطات شاشة) ← نفس لون الخلفية بالضبط؛ خلفية مزخرفة/صورة ← نعبيها من أطرافها */
export function eraseRegions(ctx, w, h, boxes) {
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  const jobs = [];
  for (const b of boxes) {
    const pad = Math.max(2, Math.round((b.y1 - b.y0) * 0.15));
    const padX = pad + Math.round((b.x1 - b.x0) * 0.06); // الكلمات العربية تمتد يمين ويسار أكثر من المربع أحيانًا
    const X0 = Math.max(0, b.x0 - padX), Y0 = Math.max(0, b.y0 - pad), X1 = Math.min(w, b.x1 + padX), Y1 = Math.min(h, b.y1 + pad);
    // حلقة البكسلات حول المنطقة: منها نعرف لون الخلفية
    const ring = [], R = Math.max(3, pad);
    for (let y = Math.max(0, Y0 - R); y < Math.min(h, Y1 + R); y++) for (let x = Math.max(0, X0 - R); x < Math.min(w, X1 + R); x++) {
      if (x >= X0 && x < X1 && y >= Y0 && y < Y1) continue;
      const i = (y * w + x) * 4; ring.push([d[i], d[i + 1], d[i + 2]]);
    }
    if (!ring.length) continue;
    const med = [0, 1, 2].map((c) => ring.map((p) => p[c]).sort((a, z) => a - z)[ring.length >> 1]);
    const close = ring.filter((p) => Math.abs(p[0] - med[0]) + Math.abs(p[1] - med[1]) + Math.abs(p[2] - med[2]) < 30).length / ring.length;
    const flat = close > 0.8;
    // صورة حقيقية ومنطقة كبيرة (مو كتابة صغيرة): التعبئة تطلع مموهة، فنخليها لنموذج التعديل
    if (!flat && ((Y1 - Y0) > h * 0.1 || (X1 - X0) * (Y1 - Y0) > w * h * 0.05)) return false;
    jobs.push({ X0, Y0, X1, Y1, med, flat });
  }
  for (const { X0, Y0, X1, Y1, med, flat } of jobs) {
    if (flat) { // خلفية سادة: نلونها بنفس اللون بالضبط
      for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) { const i = (y * w + x) * 4; d[i] = med[0]; d[i + 1] = med[1]; d[i + 2] = med[2]; }
      continue;
    }
    // خلفية مو سادة: نعبي المنطقة من أطرافها للداخل (انتشار تدريجي) حتى تندمج ويا اللي حواليها
    const bw = X1 - X0, bh = Y1 - Y0;
    const buf = new Float32Array(bw * bh * 3);
    const at = (x, y, c) => {
      if (x < X0 || x >= X1 || y < Y0 || y >= Y1) { const cx = Math.min(w - 1, Math.max(0, x)), cy = Math.min(h - 1, Math.max(0, y)); return d[(cy * w + cx) * 4 + c]; }
      return buf[((y - Y0) * bw + (x - X0)) * 3 + c];
    };
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) for (let c = 0; c < 3; c++) buf[(y * bw + x) * 3 + c] = med[c];
    const iters = Math.min(400, Math.max(60, Math.max(bw, bh) * 2));
    for (let k = 0; k < iters; k++) for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) for (let c = 0; c < 3; c++)
      buf[((y - Y0) * bw + (x - X0)) * 3 + c] = (at(x - 1, y, c) + at(x + 1, y, c) + at(x, y - 1, c) + at(x, y + 1, c)) / 4;
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
      const i = (y * w + x) * 4, j = ((y - Y0) * bw + (x - X0)) * 3, n = (Math.random() - 0.5) * 6; // شوية حبيبات حتى ما تبين ناعمة زيادة
      d[i] = buf[j] + n; d[i + 1] = buf[j + 1] + n; d[i + 2] = buf[j + 2] + n;
    }
  }
  ctx.putImageData(img, 0, 0);
  return true;
}

/** يكتب نص (عربي أو غيره) داخل مربع بخط واضح */
export function drawText(ctx, text, b, color) {
  ensureFont();
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  let size = Math.max(10, bh * 0.85);
  ctx.font = `bold ${size}px MajArabicEdit`;
  while (size > 8 && ctx.measureText(text).width > bw * 1.05) { size -= 1; ctx.font = `bold ${size}px MajArabicEdit`; }
  ctx.fillStyle = color || "#111111";
  ctx.direction = /[؀-ۿ]/.test(text) ? "rtl" : "ltr";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, b.x0 + bw / 2, b.y0 + bh / 2 + size * 0.05);
}

/** Gemini يقارن قبل وبعد: انعمل التعديل صح وباقي الصورة نفسها؟ */
export async function verifyEdit({ before, after, instruction }) {
  const out = await directText([{ role: "user", content: [
    { type: "text", text: `Image 1 is the original, image 2 is the edited result. The requested edit was: "${instruction}".
Was the edit done correctly and completely (nothing requested is left), with the rest of the image kept the same? Return ONLY JSON: {"ok":true|false,"problem":"<short, if not ok>"}` },
    { type: "image_url", image_url: { url: toDataUrl(before.bytes, before.mime) } },
    { type: "image_url", image_url: { url: toDataUrl(after.bytes, after.mime) } },
  ] }], { provider: "gemini", prefer: SHARP, max_tokens: 200, timeout: 40_000 });
  const j = parseJson(out, {});
  return { ok: j.ok === true, problem: String(j.problem || "") };
}

/**
 * تعديل دقيق بدون نموذج رسم: مسح شي، تبديل كتابة، أو إضافة كتابة.
 * يرجع { bytes, mime, provider } أو null إذا ما لگينا المكان (وقتها نجرب نماذج التعديل).
 */
export async function preciseEdit({ bytes, mime, plan }) {
  if (!["remove", "replace_text", "add_text"].includes(plan.op) || !plan.target) return null;
  if (plan.op !== "remove" && !plan.newText) return null;
  const im = await loadImage(bytes);
  const w = im.width, h = im.height;
  const what = plan.op === "add_text" ? `the best empty area for new text: ${plan.target}` : plan.target;
  let boxes = await locateTargets({ bytes, mime, target: what, w, h });
  if (!boxes.length) return null;
  const canvas = createCanvas(w, h), ctx = canvas.getContext("2d");
  ctx.drawImage(im, 0, 0);
  if (plan.op === "add_text") boxes = boxes.slice(0, 1);
  else if (!eraseRegions(ctx, w, h, boxes)) return null;
  if (plan.op !== "remove") for (const b of boxes) drawText(ctx, plan.newText, b, b.color);
  return { bytes: canvas.toBuffer("image/png"), mime: "image/png", provider: `precise-${plan.op}`, boxes: boxes.length };
}
