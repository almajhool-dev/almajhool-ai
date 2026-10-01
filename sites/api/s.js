// يخدم المواقع والتطبيقات المنشورة: almajhool-sites.vercel.app/<slug>
// نطاق منفصل عن الموقع الرئيسي حتى لا يستطيع كود أي مستخدم الوصول لجلسات الآخرين.
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);
const MAIN = (process.env.MAIN_ORIGIN || "https://almajhool-ai.vercel.app").replace(/\/$/, "");

const page = (title, body, status) => new Response(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#05070d;color:#dbe7ff;font-family:system-ui,sans-serif;text-align:center}
a{color:#00f0ff}h1{color:#00f0ff;text-shadow:0 0 12px #00f0ff}</style></head><body><div>${body}</div></body></html>`,
  { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

export async function GET(request) {
  const url = new URL(request.url);
  const slug = (url.searchParams.get("slug") || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!slug) {
    return page("المبرمج المجهول AI", `<h1>◢◣ المبرمج المجهول AI</h1><p>هنا تُنشر المواقع والتطبيقات المبنية بالذكاء الاصطناعي.</p><p><a href="${MAIN}">ابنِ موقعك الآن ←</a></p>`, 200);
  }
  const rows = await sql`UPDATE sites SET views = views + 1 WHERE slug = ${slug} RETURNING html, title, kind`;
  if (!rows.length) return page("غير موجود", `<h1>404</h1><p>هذا الموقع غير موجود أو تم حذفه.</p><p><a href="${MAIN}">المبرمج المجهول AI</a></p>`, 404);
  let { html, title } = rows[0];
  const safeTitle = String(title || "").replace(/[<>"&]/g, "");
  // قابل للتثبيت على الجوال كتطبيق (PWA) + شارة صغيرة باسم المنصة
  const head = `<link rel="manifest" href="/${slug}/manifest.json"><meta name="theme-color" content="#05070d">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<link rel="apple-touch-icon" href="/icon.png"><link rel="icon" href="/icon.png">`;
  const badge = `<a href="${MAIN}" target="_blank" rel="noopener" style="position:fixed;bottom:10px;left:10px;z-index:2147483647;background:rgba(5,7,13,.85);color:#00f0ff;border:1px solid rgba(0,240,255,.4);border-radius:99px;padding:5px 10px;font:12px system-ui,sans-serif;text-decoration:none;backdrop-filter:blur(6px)">◢◣ صُنع بـ المبرمج المجهول AI</a>`;
  if (!/<meta[^>]+viewport/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => `${m}<meta name="viewport" content="width=device-width,initial-scale=1">`);
  html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${head}</head>`) : head + html;
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${badge}</body>`) : html + badge;
  return new Response(html, { headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=0, s-maxage=30",
    "X-Robots-Tag": "noindex",
    "X-Site-Title": encodeURIComponent(safeTitle),
  } });
}
