// «كل النماذج مرة وحدة»: نسأل كل مصادر الذكاء المتصلة بنفس اللحظة، وبعدها نموذج قوي يكتب
// جواب واحد نهائي من أفضل ما بأجوبتهم. أي مصدر جديد ينضاف لـ DIRECT (أو EXTRA_PROVIDERS) يشارك تلقائيًا.
import { DIRECT, directChat, directConfigured, directText } from "./_direct.js";
import { estTokens, gateway } from "./_lib.js";

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

async function gatewayDraft(messages, max_tokens) {
  const r = await gateway("/api/chat", { messages, max_tokens });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.text) throw new Error(d.error || `gateway HTTP ${r.status}`);
  return { text: d.text, by: `${d.provider || "gateway"}/${d.model || ""}` };
}

/** يرجع مسودات من كل المصادر بالتوازي: [{ text, by }] */
export async function collectDrafts(messages, { timeout = 22_000, max_tokens = 1500 } = {}) {
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
  const done = await Promise.allSettled(jobs);
  const seen = new Set();
  return done.filter((r) => r.status === "fulfilled" && r.value.text?.trim())
    .map((r) => r.value)
    .filter((d) => { const k = d.text.trim().slice(0, 200); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** رسائل الجواب النهائي: سؤال المستخدم + أجوبة النماذج */
export function synthesisMessages(messages, drafts) {
  const last = messages[messages.length - 1];
  const candidates = drafts.map((d, i) => `### الإجابة ${i + 1}\n${d.text.slice(0, 5000)}`).join("\n\n");
  return [
    ...messages.slice(0, -1),
    { role: "user", content: `${typeof last.content === "string" ? last.content : JSON.stringify(last.content)}\n\n---\n(ملاحظة داخلية للمساعد: هذي إجابات مقترحة من ${drafts.length} نماذج ذكاء اصطناعي مختلفة على رسالتي الأخيرة. اكتب أنت الجواب النهائي الأفضل والأدق: خذ أصح وأفضل ما فيها، صحح أي غلط أو تناقض، وكمّل الناقص. لا تذكر إن اكو إجابات أو نماذج أخرى. جاوب بنفس لغتي ولهجتي.)\n\n${candidates}` },
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
