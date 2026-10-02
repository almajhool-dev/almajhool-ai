// الدردشة: يتحقق من الجلسة والحصة، يمرر للبوابة، ويبث الرد (SSE) ويسجّل التوكنات المستهلكة
import { HttpError, estTokens, gateway, logUsage, requireUser, route, usageToday } from "./_lib.js";
import { DIRECT, directChat, directConfigured } from "./_direct.js";
import { ensembleAnswer } from "./_ensemble.js";


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
  // 0) وضع «كل النماذج»: نسأل كل النماذج المتصلة بالتوازي، وبعدها نموذج قوي يكتب جواب واحد من أفضل ما بمسوداتهم
  let draftTokens = 0;
  if (body.ensemble === true && want === "auto" && directConfigured().length && JSON.stringify(messages).length < 24000) {
    try {
      const r = await ensembleAnswer(messages, { stream: true, max_tokens: req.max_tokens, temperature: req.temperature });
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
