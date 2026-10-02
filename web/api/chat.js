// الدردشة: يتحقق من الجلسة والحصة، يمرر للبوابة، ويبث الرد (SSE) ويسجّل التوكنات المستهلكة
import { HttpError, estTokens, gateway, logUsage, requireUser, route, usageToday } from "./_lib.js";
import { DIRECT, directChat, directConfigured, directText } from "./_direct.js";


export const POST = route(async (request) => {
  const user = await requireUser(request);
  const body = await request.json().catch(() => ({}));
  const messages = Array.isArray(body.messages) ? body.messages.slice(-40) : [];
  if (!messages.length) throw new HttpError(400, "الرسالة فارغة");
  const usage = await usageToday(user.id);
  if (user.role !== "admin" && usage.tokens >= user.daily_tokens) {
    throw new HttpError(429, `وصلت حدك اليومي (${user.daily_tokens.toLocaleString("en-US")} توكن). يتجدد غدًا.`);
  }
  const promptTokens = estTokens(messages.map((m) => m?.content).join(""));
  const want = body.provider || "auto";
  const req = { messages, provider: want, temperature: body.temperature,
    max_tokens: Math.min(Number(body.max_tokens) || 4096, 32000), stream: true };
  let upstream = null, provider = null, model = null, directError = null;
  // 0) وضع «كل النماذج»: نسأل عدة نماذج بالتوازي، وبعدها Gemini يكتب أفضل جواب من مسوداتهم
  let draftTokens = 0;
  if (body.ensemble === true && want === "auto" && directConfigured().length && JSON.stringify(messages).length < 24000) {
    try {
      const r = await ensemble(messages, req);
      upstream = r.res; provider = r.provider; model = r.model; draftTokens = r.draftTokens;
    } catch (e) { directError = e.message; }
  }
  // 1) النماذج المتصلة مباشرة بالموقع (مثل Gemini) — أولًا في الوضع التلقائي أو عند اختيارها
  const isDirect = DIRECT.some((p) => p.id === want);
  if (!upstream && (want === "auto" || isDirect) && directConfigured().length) {
    try { ({ res: upstream, provider, model } = await directChat(req)); }
    catch (e) { directError = e.message; }
  }
  // 2) البوابة (كل المصادر المجانية الأخرى) — أو احتياط إذا فشل المباشر
  if (!upstream) {
    upstream = await gateway("/api/chat", { ...req, provider: isDirect ? "auto" : want });
    if (!upstream.ok) {
      const e = await upstream.json().catch(() => ({}));
      throw new HttpError(502, e.error || directError || "البوابة لم ترد");
    }
    provider = upstream.headers.get("x-provider");
    model = upstream.headers.get("x-model");
  }
  const headers = { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
    "X-Provider": provider || "", "X-Model": model || "" };

  // بوابة v1 لا تبث — نحول ردها إلى حدث SSE واحد
  if (!(upstream.headers.get("content-type") || "").includes("event-stream")) {
    const j = await upstream.json();
    await logUsage(user.id, "chat", j.usage?.total_tokens || promptTokens + estTokens(j.text), j.provider, j.model);
    const ev = { choices: [{ delta: { content: j.text }, finish_reason: j.finish_reason || "stop" }], usage: j.usage };
    return new Response(`data: ${JSON.stringify(ev)}\n\ndata: [DONE]\n\n`, {
      headers: { ...headers, "X-Provider": j.provider || "", "X-Model": j.model || "" } });
  }

  // نمرر البث كما هو، ونحسب الاستهلاك من آخر حدث usage (أو تقديرًا من طول النص)
  const dec = new TextDecoder();
  let buf = "", chars = 0, reported = 0;
  const counter = new TransformStream({
    transform(chunk, ctrl) {
      ctrl.enqueue(chunk);
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          const j = JSON.parse(line.slice(5));
          chars += (j.choices?.[0]?.delta?.content || "").length;
          if (j.usage?.total_tokens) reported = j.usage.total_tokens;
        } catch { /* [DONE] أو سطر ناقص */ }
      }
    },
    async flush() {
      try { await logUsage(user.id, "chat", (reported || promptTokens + Math.ceil(chars / 3.2)) + draftTokens, provider, model); }
      catch (e) { console.error("usage log failed", e); }
    },
  });
  return new Response(upstream.body.pipeThrough(counter), { headers });
});

// ------------------------------------------------------------------ تجميع إجابات عدة نماذج
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
async function gatewayDraft(messages) {
  const r = await gateway("/api/chat", { messages, provider: "auto", max_tokens: 2048, stream: false });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.text) throw new Error(d.error || `HTTP ${r.status}`);
  return { text: d.text, by: `${d.provider || "gateway"}/${d.model || ""}` };
}
async function ensemble(messages, req) {
  // مسودات من مصادر مختلفة بالتوازي (البوابة تتناوب بين مزوداتها، فكل طلب يروح لمزود مختلف)
  const jobs = [
    withTimeout(gatewayDraft(messages), 25_000),
    withTimeout(gatewayDraft(messages), 25_000),
    // مسودة ثالثة من Gemini lite (حصة منفصلة) حتى نوفر حصة النموذج الأقوى للجواب النهائي
    withTimeout(directText(messages, { max_tokens: 2048, prefer: ["gemini-flash-lite-latest", "gemini-2.5-flash-lite"] }).then((text) => ({ text, by: "gemini-lite" })), 25_000),
    // مسودة من ChatGPT (نماذج OpenAI مجانًا)
    withTimeout(directText(messages, { max_tokens: 2048, provider: ["chatgpt", "chatgpt-free"], timeout: 25_000 }).then((text) => ({ text, by: "chatgpt" })), 28_000),
  ];
  const drafts = (await Promise.allSettled(jobs)).filter((r) => r.status === "fulfilled" && r.value.text?.trim()).map((r) => r.value);
  // نحذف المسودات المكررة من نفس المزود
  const seen = new Set();
  const unique = drafts.filter((d) => (seen.has(d.by) ? false : seen.add(d.by)));
  if (unique.length < 2) throw new Error("ensemble: not enough drafts");
  const last = messages[messages.length - 1];
  const candidates = unique.map((d, i) => `### الإجابة ${i + 1}\n${d.text.slice(0, 6000)}`).join("\n\n");
  const synth = [
    ...messages.slice(0, -1),
    { role: "user", content: `${last.content}\n\n---\n(ملاحظة داخلية للمساعد: هذي إجابات مقترحة من عدة نماذج ذكاء اصطناعي على رسالتي الأخيرة. اكتب أنت الجواب النهائي الأفضل: خذ أصح وأفضل ما فيها، صحح أي غلط، ولا تذكر إن اكو إجابات أخرى. جاوب بنفس لغتي ولهجتي.)\n\n${candidates}` },
  ];
  const { res, model } = await directChat({ ...req, messages: synth, stream: true });
  return { res, provider: "ensemble", model: `${model} <- ${unique.map((d) => d.by.split("/")[0]).join(" + ")}`,
    draftTokens: unique.reduce((n, d) => n + estTokens(d.text), 0) };
}
