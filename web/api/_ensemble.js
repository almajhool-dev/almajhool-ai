// «كل النماذج مرة وحدة»: نسأل كل مصادر الذكاء المتصلة بنفس اللحظة، وبعدها نموذج قوي يكتب
// جواب واحد نهائي من أفضل ما بأجوبتهم. أي مصدر جديد ينضاف لـ DIRECT (أو EXTRA_PROVIDERS) يشارك تلقائيًا.
import { DIRECT, directChat, directConfigured, directText } from "./_direct.js";
import { estTokens, gateway } from "./_lib.js";
import { needsSearch, searchAnswer } from "./_search.js";

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

async function gatewayDraft(messages, max_tokens) {
  const r = await gateway("/api/chat", { messages, max_tokens });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.text) throw new Error(d.error || `gateway HTTP ${r.status}`);
  return { text: d.text, by: `${d.provider || "gateway"}/${d.model || ""}` };
}

/** يرجع مسودات من كل المصادر بالتوازي: [{ text, by }] */
export async function collectDrafts(messages, { timeout = 22_000, max_tokens = 1500, enough = 3, grace = 4000 } = {}) {
  const jobs = [];
  for (const p of directConfigured()) {
    // Gemini: مسودته من النموذج الخفيف حتى نخلي حصة القوي للجواب النهائي
    const prefer = p.lite;
    jobs.push(withTimeout(directText(messages, { provider: p.id, max_tokens, timeout, prefer }).then((text) => ({ text, by: p.id })), timeout + 3000));
    // بعض المصادر بيها أكثر من نموذج قوي (مثل Nemotron Ultra وSuper): مسودة ثانية من نموذجها الثاني
    if ((p.drafts || 1) > 1 && p.models[1]) {
      jobs.push(withTimeout(directText(messages, { provider: p.id, max_tokens, timeout, prefer: [p.models[1]] }).then((text) => ({ text, by: `${p.id}:${p.models[1].split("/").pop()}` })), timeout + 3000));
    }
  }
  if (process.env.GATEWAY_URL) jobs.push(withTimeout(gatewayDraft(messages, max_tokens), timeout + 3000));
  // سؤال عن حقيقة أو حدث حالي: بحث Google بنفس اللحظة (معلومات اليوم، مو معلومات النموذج القديمة)
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const question = typeof lastUser?.content === "string" ? lastUser.content : "";
  let searchJob = null;
  if (process.env.GEMINI_API_KEY && needsSearch(question)) {
    searchJob = withTimeout(searchAnswer(question, { history: messages.filter((m) => m.role !== "system").slice(0, -1) }), 28_000)
      .then((r) => ({ text: r.text, by: "google-search", search: true, sources: r.sources }));
    jobs.push(searchJob);
  }
  // ننتظر الكل، بس إذا وصلت «enough» أجوبة ننتظر الباقين شوية بس (grace) حتى ما يأخرنا نموذج بطيء
  const got = [];
  await new Promise((resolve) => {
    let pending = jobs.length, graceTimer = null, searchDone = !searchJob;
    if (!pending) return resolve();
    const hard = setTimeout(resolve, Math.max(timeout + 3500, searchJob ? 29_000 : 0));
    const finish = () => { clearTimeout(hard); clearTimeout(graceTimer); resolve(); };
    // ما نبدي العد التنازلي إلا بعد ما يرجع البحث (هو الأهم لأسئلة الحقائق)
    const maybeGrace = () => { if (got.length >= enough && !graceTimer && searchDone) graceTimer = setTimeout(finish, grace); };
    searchJob?.then(() => {}, () => {}).finally(() => { searchDone = true; maybeGrace(); });
    for (const j of jobs) {
      j.then((v) => { if (v?.text?.trim()) got.push(v); }, () => {}).finally(() => {
        pending -= 1;
        if (!pending) return finish();
        maybeGrace();
      });
    }
  });
  got.sort((a, b) => (b.search ? 1 : 0) - (a.search ? 1 : 0));
  const seen = new Set();
  return got
    .filter((d) => { const k = d.text.trim().slice(0, 200); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** رسائل الجواب النهائي: سؤال المستخدم + أجوبة النماذج */
export function synthesisMessages(messages, drafts) {
  const last = messages[messages.length - 1];
  const today = new Date().toISOString().slice(0, 10);
  const candidates = drafts.map((d, i) => d.search
    ? `### معلومات من بحث Google اليوم (${today}) — الأحدث والأصح للأسماء والتواريخ والأحداث والأرقام\n${d.text.slice(0, 6000)}`
    : `### الإجابة ${i + 1}\n${d.text.slice(0, 5000)}`).join("\n\n");
  const hasSearch = drafts.some((d) => d.search);
  return [
    ...messages.slice(0, -1),
    { role: "user", content: `${typeof last.content === "string" ? last.content : JSON.stringify(last.content)}\n\n---\n(ملاحظة داخلية للمساعد: هذي إجابات مقترحة من ${drafts.length} نماذج ذكاء اصطناعي مختلفة على رسالتي الأخيرة. اكتب أنت الجواب النهائي الأفضل والأدق: خذ أصح وأفضل ما فيها، صحح أي غلط أو تناقض، وكمّل الناقص.${hasSearch ? " معلومات بحث Google هي المرجع لأي اسم أو تاريخ أو حدث أو رقم حالي: إذا تعارضت ويا باقي الإجابات (اللي معلوماتها قديمة) اعتمد على البحث. وإذا أنا ذكرت معلومة، أكدها إذا البحث يأكدها، وصححها بأدب إذا البحث يگول غير شي." : ""} لا تخترع معلومات، وإذا مو متأكد گول. لا تذكر إن اكو إجابات أو نماذج أخرى. جاوب بنفس لغتي ولهجتي.)\n\n${candidates}` },
  ];
}

/**
 * الجواب النهائي من كل النماذج.
 * stream=true يرجع { res, provider, model, drafts, draftTokens } (Response بث) — للموقع
 * stream=false يرجع { text, model, drafts, draftTokens } — للبوت
 */
export async function ensembleAnswer(messages, { stream = false, max_tokens = 4096, temperature, draftTimeout = 22_000, minDrafts = 2 } = {}) {
  const drafts = await collectDrafts(messages, { timeout: draftTimeout });
  if (drafts.length < minDrafts) throw new Error(`ensemble: only ${drafts.length} drafts`);
  const synth = synthesisMessages(messages, drafts);
  const draftTokens = drafts.reduce((n, d) => n + estTokens(d.text), 0);
  const names = drafts.map((d) => d.by.split("/")[0]).join(" + ");
  if (stream) {
    const { res, model } = await directChat({ messages: synth, max_tokens, temperature, stream: true, timeout: 60_000 });
    return { res, provider: "ensemble", model: `${model} <- ${names}`, drafts, draftTokens };
  }
  const text = await directText(synth, { max_tokens, temperature, timeout: 60_000 });
  return { text, model: names, drafts, draftTokens };
}

export const ensembleSources = () => [...directConfigured().map((p) => p.id), ...(process.env.GATEWAY_URL ? ["gateway"] : [])];
export { DIRECT };
