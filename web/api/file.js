// /i/<id> → ملف الصورة (رابط ثابت قابل للمشاركة والتحميل)
import { sql } from "./_lib.js";

export async function GET(request) {
  const url = new URL(request.url);
  const id = (url.searchParams.get("id") || "").replace(/[^a-f0-9]/g, "");
  if (!id) return new Response("Not found", { status: 404 });
  const rows = await sql`SELECT mime, data FROM images WHERE id = ${id}`;
  if (!rows.length) return new Response("Not found", { status: 404 });
  const { mime, data } = rows[0];
  const headers = { "Content-Type": mime, "Cache-Control": "public, max-age=31536000, immutable" };
  if (url.searchParams.get("dl")) {
    headers["Content-Disposition"] = `attachment; filename="almajhool-ai-${id.slice(0, 8)}.${mime.includes("png") ? "png" : "jpg"}"`;
  }
  return new Response(data, { headers });
}
