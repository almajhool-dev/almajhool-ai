// معلومات حديثة ودقيقة: Gemini يبحث بـ Google (Grounding) قبل ما نجاوب على أسئلة الحقائق والأحداث الحالية
// (أسماء المسؤولين، الأسعار، الأخبار، التواريخ…) — لأن معلومات النماذج تقف عند تاريخ قديم.

import { directText } from "./_direct.js";

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

// ── بحث مجاني بدون مفتاح: أخبار Google (RSS) + ويكيبيديا عربي وإنكليزي ──
const decode = (s) => String(s || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/<[^>]+>/g, "").trim();
const UA = { "User-Agent": "Mozilla/5.0 (compatible; AlmajhoolAI/1.0; +https://almajhool-ai.vercel.app)" };

async function googleNews(query, lang = "ar") {
  const loc = lang === "ar" ? "hl=ar&gl=IQ&ceid=IQ:ar" : "hl=en-US&gl=US&ceid=US:en";
  const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${loc}`, { headers: UA, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`news HTTP ${r.status}`);
  const xml = await r.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8).map((m) => ({
    title: decode(m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1]),
    date: decode(m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]),
    source: decode(m[1].match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1]),
    uri: decode(m[1].match(/<link>([\s\S]*?)<\/link>/)?.[1]),
  })).filter((x) => x.title);
}

async function wikipedia(query, lang = "ar", pages = 2) {
  const base = `https://${lang}.wikipedia.org/w/api.php`;
  const sr = await fetch(`${base}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${pages}&format=json&origin=*`, { headers: UA, signal: AbortSignal.timeout(8000) });
  const titles = ((await sr.json())?.query?.search || []).map((x) => x.title);
  if (!titles.length) return [];
  const ex = await fetch(`${base}?action=query&prop=extracts|info&inprop=url&exintro=1&explaintext=1&exchars=1800&titles=${encodeURIComponent(titles.join("|"))}&format=json&origin=*`, { headers: UA, signal: AbortSignal.timeout(8000) });
  return Object.values((await ex.json())?.query?.pages || {}).map((p) => ({ title: p.title, text: p.extract || "", uri: p.fullurl, touched: p.touched })).filter((p) => p.text);
}

/** نصوص من الإنترنت الآن (أخبار + ويكيبيديا) حول السؤال — بدون أي مفتاح */
export async function webContext(question, { queries } = {}) {
  const q = String(question).replace(/[؟?!.،]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  const qs = queries?.length ? queries : [q];
  const jobs = [];
  for (const x of qs.slice(0, 2)) {
    jobs.push(googleNews(x, /[\u0600-\u06FF]/.test(x) ? "ar" : "en").then((items) => ({ kind: "news", items })));
    jobs.push(wikipedia(x, /[\u0600-\u06FF]/.test(x) ? "ar" : "en").then((items) => ({ kind: "wiki", items })));
  }
  const parts = (await Promise.allSettled(jobs)).filter((r) => r.status === "fulfilled").map((r) => r.value);
  const news = parts.filter((p) => p.kind === "news").flatMap((p) => p.items);
  const wiki = parts.filter((p) => p.kind === "wiki").flatMap((p) => p.items);
  const lines = [];
  if (news.length) lines.push("أحدث الأخبار:", ...news.slice(0, 10).map((n) => `- ${n.title} (${n.source || "مصدر"}، ${n.date ? new Date(n.date).toISOString().slice(0, 10) : "بدون تاريخ"})`));
  if (wiki.length) lines.push("", "من ويكيبيديا:", ...wiki.slice(0, 3).map((w) => `## ${w.title}\n${w.text.slice(0, 1500)}`));
  return { text: lines.join("\n"), sources: [...news.slice(0, 3), ...wiki.slice(0, 2)].map((x) => ({ title: x.title, uri: x.uri })), count: news.length + wiki.length };
}

/** يرجع { text, sources: [{title, uri}], model } — جواب مبني على نتائج بحث Google الحالية */
export async function groundedAnswer(question, { history = [], timeout = 25_000 } = {}) {
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

let groundingOffUntil = 0; // بحث Gemini المدمج مو مجاني لكل المفاتيح: إذا رجع 429 نوقفه ساعة ونعتمد على البحث المجاني

/**
 * جواب دقيق من الإنترنت الآن: نكتب عبارات بحث ← أخبار Google + ويكيبيديا ← نموذج يجاوب من النتائج بس.
 * يرجع { text, sources, model, searched }
 */
export async function searchAnswer(question, { history = [], timeout = 25_000 } = {}) {
  if (process.env.GEMINI_GROUNDING !== "0" && Date.now() > groundingOffUntil) {
    try { return await groundedAnswer(question, { history, timeout: Math.min(timeout, 15_000) }); }
    catch (e) { if (/429|quota/i.test(e.message)) groundingOffUntil = Date.now() + 3_600_000; }
  }
  const today = new Date().toISOString().slice(0, 10);
  let queries = [];
  try {
    const q = await directText([{ role: "user", content: `تاريخ اليوم ${today}. اكتب عبارتين بحث قصيرتين (وحدة عربي فصحى ووحدة إنكليزي) حتى ألقى أحدث معلومة دقيقة لهذا السؤال بأخبار Google وويكيبيديا. سطرين بس بدون ترقيم.\nالسؤال: ${question}` }],
      { max_tokens: 120, timeout: 10_000, prefer: ["gemini-flash-lite-latest", "gemini-2.5-flash-lite"] });
    queries = q.split("\n").map((x) => x.replace(/^[\s\-*\d.•"«]+|["»]+$/g, "").trim()).filter((x) => x.length > 2).slice(0, 2);
  } catch { /* نبحث بالسؤال نفسه */ }
  const ctx = await webContext(question, { queries: queries.length ? queries : undefined });
  if (!ctx.count) throw new Error("search: no web results");
  const context = history.slice(-4).map((m) => `${m.role === "user" ? "المستخدم" : "المساعد"}: ${String(m.content).slice(0, 500)}`).join("\n");
  const text = await directText([
    { role: "system", content: `تاريخ اليوم ${today}. أنت باحث دقيق جدًا. جاوب فقط اعتمادًا على «نتائج البحث» الحديثة اللي تحت، مو على معلوماتك القديمة (معلوماتك ممكن تكون قديمة). الأخبار الأحدث تاريخًا هي الأصح للمناصب والأحداث. إذا المستخدم ذكر معلومة: أكدها إذا النتائج تأكدها، وصححها بأدب إذا النتائج تگول غير شي. إذا النتائج ما تكفي، گول بصراحة إنك ما متأكد. جاوب بنفس لغة ولهجة المستخدم وباختصار.` },
    { role: "user", content: `${context ? `سياق المحادثة:\n${context}\n\n` : ""}نتائج البحث (${today}):\n${ctx.text.slice(0, 9000)}\n\nرسالة المستخدم: ${question}` },
  ], { max_tokens: 1200, timeout: 30_000 });
  return { text, sources: ctx.sources, model: "web-search", searched: true, queries };
}
