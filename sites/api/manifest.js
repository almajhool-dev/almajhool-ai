// manifest لكل موقع منشور — حتى يمكن تثبيته على الجوال كتطبيق من "إضافة إلى الشاشة الرئيسية"
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

export async function GET(request) {
  const slug = (new URL(request.url).searchParams.get("slug") || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const rows = slug ? await sql`SELECT title FROM sites WHERE slug = ${slug}` : [];
  if (!rows.length) return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
  const name = String(rows[0].title || "تطبيقي").slice(0, 45);
  return new Response(JSON.stringify({
    name, short_name: name.slice(0, 12), start_url: `/${slug}`, scope: `/${slug}`,
    display: "standalone", background_color: "#05070d", theme_color: "#05070d", dir: "rtl", lang: "ar",
    icons: [{ src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }],
  }), { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=300" } });
}
