// معلومات حديثة ودقيقة: Gemini يبحث بـ Google (Grounding) قبل ما نجاوب على أسئلة الحقائق والأحداث الحالية
// (أسماء المسؤولين، الأسعار، الأخبار، التواريخ…) — لأن معلومات النماذج تقف عند تاريخ قديم.

const KEYS = () => String(process.env.GEMINI_API_KEY || "").split(/[\s,]+/).filter(Boolean);
const MODELS = () => {
  const custom = String(process.env.GEMINI_SEARCH_MODELS || "").split(",").map((x) => x.trim()).filter(Boolean);
  return custom.length ? custom : ["gemini-flash-latest", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-2.5-flash-lite", "gemini-flash-lite-latest"];
};
const gone = new Set();

// سؤال عن حقيقة/معلومة/حدث (أو المستخدم يذكر معلومة لازم نتحقق منها) — مو سوالف أو تحية
const FACTUAL = /(منو|مين|من هو|من هي|شنو|شو|ايش|إيش|وين|متى|شوكت|شكد|كم|اسم|رئيس|رئاس|وزير|وزار|حكوم|برلمان|نائب|محافظ|سفير|ملك|أمير|امير|سعر|اسعار|أسعار|دولار|دينار|صرف|بورص|ذهب|نفط|اخبار|أخبار|خبر|حدث|صار|اليوم|امبارح|البارحة|باچر|الحالي|الحاليه|الحالية|لحالي|حاليا|حالياً|هسه|هسة|الآن|الان|آخر|اخر|احدث|أحدث|جديد|نتيج|مباراة|مباريات|دوري|كأس|منتخب|طقس|الجو|درجة الحرارة|انتخاب|قانون|عطل[ةه]|دوام|راتب|رواتب|تاريخ|سنة|عام|20\d\d|who|what|when|where|which|price|news|latest|current|today|president|minister|score)/i;
const SMALLTALK = /^(هلا|هلو|مرحبا|السلام|سلام|شلونك|شخبارك|صباح|مساء|تسلم|شكرا|شكراً|مشكور|اوك|تمام|زين|حلو|ههه+|😂|❤️)/i;

export function needsSearch(text) {
  const t = String(text || "").trim();
  if (t.length < 4 || t.length > 1500) return false;
  if (SMALLTALK.test(t) && t.length < 25) return false;
  return FACTUAL.test(t);
}

/** يرجع { text, sources: [{title, uri}], model } — جواب مبني على نتائج بحث Google الحالية */
export async function searchAnswer(question, { history = [], timeout = 25_000 } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const context = history.slice(-4).map((m) => `${m.role === "user" ? "المستخدم" : "المساعد"}: ${String(m.content).slice(0, 600)}`).join("\n");
  const prompt = `تاريخ اليوم ${today}. ابحث بـ Google وجاوب على رسالة المستخدم بدقة عالية جدًا اعتمادًا على أحدث النتائج الموثوقة فقط.
- اذكر الأسماء والتواريخ والأرقام بالضبط مثل ما بالمصادر الحديثة.
- إذا المستخدم ذكر معلومة، تحقق منها: إذا صحيحة أكدها، وإذا غلط صححها بأدب مع المعلومة الصحيحة.
- إذا المصادر ما تأكد شي، گول إنك ما متأكد بدل ما تخمن.
- جاوب بنفس لغة ولهجة المستخدم وباختصار.
${context ? `\nسياق المحادثة:\n${context}\n` : ""}
رسالة المستخدم: ${question}`;
  const errors = [];
  for (const model of MODELS()) {
    if (gone.has(model)) continue;
    for (const key of KEYS()) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.2 } }),
          signal: AbortSignal.timeout(timeout),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { errors.push(`${model}: ${r.status} ${String(j?.error?.message || "").slice(0, 100)}`); if (r.status === 404) gone.add(model); continue; }
        const cand = j?.candidates?.[0];
        const text = (cand?.content?.parts || []).map((p) => p.text || "").join("").trim();
        if (!text) { errors.push(`${model}: empty`); continue; }
        const sources = (cand?.groundingMetadata?.groundingChunks || []).map((c) => c.web).filter(Boolean)
          .map((w) => ({ title: w.title || "", uri: w.uri || "" })).slice(0, 5);
        return { text, sources, model, searched: !!cand?.groundingMetadata };
      } catch (e) { errors.push(`${model}: ${e.message}`); }
    }
  }
  throw new Error("search: " + errors.join(" | "));
}
