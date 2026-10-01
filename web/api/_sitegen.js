// بناء موقع كامل على الخادم (لبوت تلكرام) — نفس تعليمات المتصفح بالموقع
import { directChat, directConfigured } from "./_direct.js";
import { gateway } from "./_lib.js";

export const KIND = {
  website: "a complete, multi-section, production-ready website",
  webapp: "a mobile-first web application with real, fully working functionality and persistent state (localStorage)",
  game: "a fully playable, polished browser game with touch AND keyboard controls, score, levels and game-over/restart",
  dashboard: "a rich admin/analytics dashboard with charts drawn on <canvas> (no chart libraries needed) and realistic sample data",
  landing: "a high-converting landing page with hero, features, social proof, FAQ and clear call-to-action",
};

export function extractHtml(text) {
  const m = text.match(/```(?:html)?\s*([\s\S]*?)(?:```|$)/i);
  let code = m ? m[1] : text;
  const i = code.search(/<!doctype html|<html/i);
  if (i > 0) code = code.slice(i);
  return code.trim();
}

async function complete(messages) {
  if (directConfigured().length) {
    try {
      const { res } = await directChat({ messages, max_tokens: 32000, temperature: 0.4, stream: false, timeout: 200_000 });
      const j = await res.json();
      return { text: j?.choices?.[0]?.message?.content || "", finish: j?.choices?.[0]?.finish_reason };
    } catch (e) { console.error("sitegen direct", e.message); }
  }
  const r = await gateway("/api/chat", { messages, max_tokens: 32000, temperature: 0.4 });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return { text: d.text || "", finish: d.finish_reason };
}

/** يرجع HTML كامل. currentHtml: إذا موجود يعدّل عليه بدل ما يبني جديد */
export async function generateSiteHtml(req, kind = "website", currentHtml = "") {
  const system = `You are a world-class front-end engineer and UI designer. Build ${KIND[kind] || KIND.website}.
Rules:
- Output ONE complete self-contained HTML file inside a single \`\`\`html code block — inline <style> and <script>, no build step.
- Production quality: responsive (mobile first), accessible, modern polished design with smooth micro-interactions, real working features (no placeholder TODOs, no lorem ipsum unless asked).
- If the request is in Arabic, all UI text must be Arabic with dir="rtl" and the "Cairo" font from Google Fonts.
- External resources only from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, fonts.googleapis.com. Use https://picsum.photos/seed/<word>/W/H for images.
- Do not explain anything — output only the code block.`;
  const base = currentHtml
    ? [{ role: "system", content: system }, { role: "user", content: `Current file:\n\`\`\`html\n${currentHtml}\n\`\`\`\nApply this change and return the FULL updated file: ${req}` }]
    : [{ role: "system", content: system }, { role: "user", content: req }];
  let full = "", messages = base;
  for (let round = 1; ; round++) {
    const r = await complete(messages);
    full += r.text;
    const unfinished = r.finish === "length" || (!/<\/html>\s*(```)?\s*$/i.test(full.trim()) && /<html|<!doctype/i.test(full));
    if (!unfinished || round >= 4) break;
    messages = [...base, { role: "assistant", content: full },
      { role: "user", content: "Continue EXACTLY from where you stopped. Do not repeat anything and do not restart the code block — output only the remaining code." }];
  }
  let html = extractHtml(full);
  if (!/<html|<body|<div/i.test(html)) throw new Error("النموذج ما رجع كود صالح — جرّب مرة ثانية");
  if (!/<\/html>/i.test(html)) html += "\n</body></html>";
  return html;
}
