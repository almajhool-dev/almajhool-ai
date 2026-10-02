// فهم نوع الطلب (صورة / موقع / تعديل / Lovable / دردشة) — نفس قواعد الواجهة بـ app.js
export const AR_ASK = /(^|\s)(شلون|كيف|ليش|لماذا|شنو|شو|ما هو|ما هي|ماهو|وش|ايش|إيش|اشرح|اشرحلي|هل)(\s|$)/;
export const AR_WANT = /(سوي|سوّي|اسوي|سويلي|سوّيلي|سولي|اعمل|اعملي|اعملّي|إعمل|ابني|ابنِ|ابنيلي|صمم|صمّم|صممي|صمملي|صمّملي|اريد|أريد|اريدك|ابي|أبي|ابغى|أبغى|عايز|عاوز|بدي|انشئ|أنشئ|اصنع|حضر|حضّر|جهز|جهّز|اكتب|create|make|build|design|generate)/i;
export const AR_DRAW = /(ارسم|إرسم|ارسملي|ارسمي|ارسمني|draw|paint|صور(ة|ه)? ل|صوره ل|لوگو|لوجو|لوغو|logo|شعار|خلفية|خلفيه|wallpaper|بوستر|poster|غلاف|ثمبنيل|thumbnail|أفاتار|افتار|avatar)/i;
export const AR_IMG = /(صور(ة|ه)|صورة|image|picture|photo|رسمة|رسمه)/i;
export const AR_SITE = [
  ["game", /(لعب(ة|ه)|game)/i],
  ["dashboard", /(لوح(ة|ه) تحكم|داشبورد|dashboard|لوح(ة|ه) تحليلات)/i],
  ["landing", /(صفح(ة|ه) هبوط|لاندنج|landing)/i],
  ["webapp", /(تطبيق|ابلكيشن|\bapp\b|حاسب(ة|ه)|آل(ة|ه) حاسب(ة|ه))/i],
  ["website", /(موقع|متجر|ستور|store|website|site|بورتفوليو|portfolio|مدون(ة|ه)|صفح(ة|ه) (ويب|شخصي(ة|ه)))/i],
];
// تعديل على الموقع المفتوح: «غيّر اللون»، «ضيف قسم»، «شيل الزر»، «خلي الخط أكبر»…
export const AR_EDIT_WORD = /^(غير|غيّر|بدل|بدّل|ضيف|أضف|اضف|زيد|زيّد|زوّد|زود|شيل|احذف|امسح|خلي|خلّي|كبر|كبّر|صغر|صغّر|عدل|عدّل|حسن|حسّن|صلح|صلّح|رتب|رتّب|حرك|حرّك|change|add|remove|fix|make)(ه|ها|هم|لي|يلي|يها|يه)?$/i;
const AR_EDIT = /(غير|غيّر|بدل|بدّل|ضيف|أضف|اضف|زيد|زوّد|شيل|احذف|امسح|خلي|خلّي|كبر|كبّر|صغر|صغّر|عدل|عدّل|حسن|حسّن|صلح|صلّح|رتب|رتّب|حرك|حرّك|ترجم الموقع|change|add|remove|make it|fix)/i;
export const isEditRequest = (t) => {
  // فعل التعديل لازم يكون أول كلمة (أو بعد كلمة مثل «ممكن/بعد/هسه/رجاءً»)، والسؤال («منو حسن…») مو تعديل
  const words = String(t).trim().split(/\s+/).slice(0, 2).map((w) => w.replace(/^(و|ف)(?=..)/, "").replace(/[،,.!؟?]+$/, ""));
  if (/^(منو|مين|شنو|شو|وين|متى|شكد|كم|ليش|شلون|كيف|هل)$/.test(words[0] || "")) return false;
  if (AR_EDIT_WORD.test(words[0] || "")) return true;
  return /^(ممكن|بعد|هسه|هسة|رجاء|رجاءً|لطفا|لطفاً|اريد|أريد|ابي|أبي|please|pls)$/i.test(words[0] || "") && AR_EDIT_WORD.test((words[1] || "").replace(/^[تي](?=...)/, ""));
};
const AR_NEW = /(موقع جديد|مشروع جديد|تطبيق جديد|لعبة جديدة|من جديد|new site|new project)/i;
export const LOVABLE = /lovable|ل[وا]?ف[يا]?ب[ي]?ل/i;

export const stripLovable = (request) => String(request).replace(/\s*(?:ب|بـ|بل|بال|ب ال|على|علئ|عن طريق|من|في|ب منصة|بمنصة)?\s*(?:منص[ةه]\s*)?(?:lovable|ل[وا]?ف[يا]?ب[ي]?ل)/gi, " ").trim();
export function lovableUrl(request) {
  const req = stripLovable(request);
  const prompt = `${req}\n\nBuild this as a complete, beautiful, responsive website. All visible text must be in Arabic with a right-to-left (RTL) layout and a good Arabic font (e.g. Cairo or Tajawal). Fill every section with realistic content (no lorem ipsum).`;
  return `https://lovable.dev/?autosubmit=true#prompt=${encodeURIComponent(prompt.slice(0, 20000))}`;
}

export function detectIntent(text, hasProject = false) {
  const full = text.trim();
  // الطلبات الطويلة (مواصفات موقع كاملة) نحكم عليها من بدايتها، والسؤال («شلون…») بس بالرسائل القصيرة
  if (full.length < 300 ? AR_ASK.test(full) : AR_ASK.test(full.slice(0, 60))) return { type: "chat" };
  const t = full.slice(0, 400);
  if (LOVABLE.test(t) && !AR_DRAW.test(t)) return { type: "lovable" };
  // «أنشئ لي موقع… (وبعدها شعار وصور…)»: اللي ينذكر أول بالطلب هو اللي يحدد، موقع لو صورة
  const head = full.slice(0, 150);
  if (AR_WANT.test(head) && !/(ارسم|إرسم|draw|paint)/i.test(head)) {
    const firstImg = head.search(AR_IMG);
    for (const [kind, re] of AR_SITE) {
      const at = head.search(re);
      if (at >= 0 && (firstImg < 0 || at < firstImg)) return { type: "site", kind };
    }
  }
  if (AR_DRAW.test(t) || (AR_WANT.test(t) && AR_IMG.test(t))) return { type: "image" };
  if (AR_WANT.test(t) || AR_NEW.test(t)) for (const [kind, re] of AR_SITE) if (re.test(t)) return { type: "site", kind };
  // تعديل الموقع: فعل التعديل لازم يكون كلمة مستقلة بأول الكلام (مو جزء من اسم مثل «الزيدي» ← «زيد»)
  if (hasProject && isEditRequest(t)) return { type: "edit" };
  return { type: "chat" };
}
