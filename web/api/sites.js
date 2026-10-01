// المواقع والتطبيقات المنشورة: نشر/تحديث، قائمة مواقعي، حذف
import { HttpError, SITES_ORIGIN, json, logUsage, requireUser, route, sql, usageToday } from "./_lib.js";

const MAX_HTML = 3 * 1024 * 1024;

function makeSlug() {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => a[b % a.length]).join("");
}

export const POST = route(async (request) => {
  const user = await requireUser(request);
  const { html, title, kind, prompt, slug } = await request.json().catch(() => ({}));
  if (!html || html.length < 50) throw new HttpError(400, "لا يوجد كود للنشر");
  if (html.length > MAX_HTML) throw new HttpError(413, "الموقع أكبر من 3MB");
  const cleanTitle = String(title || "مشروع المبرمج المجهول").slice(0, 120);

  if (slug) { // تحديث موقع منشور سابقًا لنفس المستخدم
    const rows = await sql`UPDATE sites SET html = ${html}, title = ${cleanTitle}, kind = ${kind}, prompt = ${prompt}, updated_at = now()
                           WHERE slug = ${slug} AND user_id = ${user.id} RETURNING slug`;
    if (rows.length) return json({ slug, url: `${SITES_ORIGIN}/${slug}`, updated: true });
  }
  const usage = await usageToday(user.id);
  if (user.role !== "admin" && usage.sites >= user.daily_sites) {
    throw new HttpError(429, `وصلت حدك اليومي (${user.daily_sites} نشر). يتجدد غدًا.`);
  }
  const newSlug = makeSlug();
  await sql`INSERT INTO sites (slug, user_id, title, kind, html, prompt)
            VALUES (${newSlug}, ${user.id}, ${cleanTitle}, ${kind}, ${html}, ${String(prompt || "").slice(0, 4000)})`;
  await logUsage(user.id, "publish");
  return json({ slug: newSlug, url: `${SITES_ORIGIN}/${newSlug}`, updated: false });
});

export const GET = route(async (request) => {
  const user = await requireUser(request);
  const rows = await sql`SELECT slug, title, kind, views, created_at, updated_at, length(html)::int AS size
                         FROM sites WHERE user_id = ${user.id} ORDER BY updated_at DESC LIMIT 100`;
  return json(rows.map((r) => ({ ...r, url: `${SITES_ORIGIN}/${r.slug}` })));
});

export const DELETE = route(async (request) => {
  const user = await requireUser(request);
  const slug = new URL(request.url).searchParams.get("slug");
  const rows = user.role === "admin"
    ? await sql`DELETE FROM sites WHERE slug = ${slug} RETURNING slug`
    : await sql`DELETE FROM sites WHERE slug = ${slug} AND user_id = ${user.id} RETURNING slug`;
  if (!rows.length) throw new HttpError(404, "الموقع غير موجود");
  return json({ deleted: slug });
});
