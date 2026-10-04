// التعديل على صورة موجودة (صورة دزها المستخدم أو صورة رسمناها له) + فهم الطلب من المحادثة
// 1) Gemini يشوف الصورة ويقرا آخر المحادثة ويفهم «شيل هاي الشغلة» بالضبط شنو يقصد
// 2) نعدّل نفس الصورة: Gemini (إذا عنده حصة) ← Pollinations kontext (POLLINATIONS_API_KEY) ← مساحات Hugging Face (HF_TOKEN)
// 3) إذا كلهم ما ينفعون: نرسم نسخة جديدة قريبة من الصورة بالتعديل المطلوب (ونگول هذا للمستخدم بصراحة)
import { DIRECT, directText } from "./_direct.js";

const LITE = () => DIRECT.find((p) => p.id === "gemini")?.lite;
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
Return ONLY JSON: {"action":"edit|ask|new|other","instruction":"<for edit: one precise English edit instruction that names exactly what to change and where in THIS image, and says to keep everything else identical>"}`;
  const out = await directText([{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: toDataUrl(bytes, mime) } }] }],
    { provider: "gemini", prefer: LITE(), max_tokens: 400, timeout: 25_000 });
  let j = {};
  try { j = JSON.parse((String(out).match(/\{[\s\S]*\}/) || ["{}"])[0]); } catch { /* نرجع other */ }
  const action = ["edit", "ask", "new", "other"].includes(j.action) ? j.action : "other";
  return { action, instruction: String(j.instruction || "").slice(0, 800) };
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

/** يعدّل نفس الصورة. يرجع { bytes, mime, provider } أو يرمي خطأ بكل المحاولات */
export async function editImage({ bytes, mime, instruction, publicUrl }) {
  const errors = [];
  for (const [name, run] of [
    ["gemini", () => geminiEdit(bytes, mime, instruction)],
    ["pollinations", () => pollinationsEdit(publicUrl, instruction)],
    ["huggingface", () => hfEdit(bytes, mime, instruction)],
  ]) {
    try { return await run(); } catch (e) { errors.push(`${name}: ${String(e.message).slice(0, 200)}`); }
  }
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
