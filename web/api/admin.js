// لوحة الأدمن: إحصاءات، مستخدمون، مواقع، صور، استهلاك — وإجراءات (إيقاف، حدود، صلاحيات، حذف)
import { HttpError, SITES_ORIGIN, json, requireAdmin, route, sql } from "./_lib.js";

export const GET = route(async (request) => {
  await requireAdmin(request);
  const view = new URL(request.url).searchParams.get("view") || "stats";

  if (view === "stats") {
    const [s] = await sql`
      SELECT (SELECT count(*) FROM app_users)::int AS users,
             (SELECT count(*) FROM app_users WHERE last_seen >= now() - interval '1 day')::int AS active_today,
             (SELECT count(*) FROM app_users WHERE created_at >= date_trunc('day', now()))::int AS new_today,
             (SELECT coalesce(sum(tokens), 0) FROM usage_events WHERE kind = 'chat' AND created_at >= date_trunc('day', now()))::bigint AS tokens_today,
             (SELECT coalesce(sum(tokens), 0) FROM usage_events WHERE kind = 'chat')::bigint AS tokens_total,
             (SELECT count(*) FROM usage_events WHERE kind = 'chat' AND created_at >= date_trunc('day', now()))::int AS requests_today,
             (SELECT count(*) FROM images)::int AS images,
             (SELECT count(*) FROM images WHERE created_at >= date_trunc('day', now()))::int AS images_today,
             (SELECT count(*) FROM sites)::int AS sites,
             (SELECT coalesce(sum(views), 0) FROM sites)::bigint AS site_views,
             (SELECT pg_database_size(current_database()))::bigint AS db_bytes`;
    const daily = await sql`
      SELECT to_char(d, 'MM-DD') AS day,
             coalesce(sum(e.tokens) FILTER (WHERE e.kind = 'chat'), 0)::bigint AS tokens,
             count(e.id) FILTER (WHERE e.kind = 'image')::int AS images,
             count(DISTINCT e.user_id)::int AS users
      FROM generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d
      LEFT JOIN usage_events e ON e.created_at >= d AND e.created_at < d + interval '1 day'
      GROUP BY d ORDER BY d`;
    const providers = await sql`
      SELECT coalesce(provider, '?') AS provider, count(*)::int AS requests, coalesce(sum(tokens), 0)::bigint AS tokens
      FROM usage_events WHERE kind = 'chat' AND created_at >= now() - interval '7 days'
      GROUP BY 1 ORDER BY 2 DESC`;
    return json({ stats: s, daily, providers });
  }

  if (view === "users") {
    const rows = await sql`
      SELECT u.id, u.email, u.name, u.image, u.role, u.banned, u.daily_tokens, u.daily_images, u.daily_sites,
             u.created_at, u.last_seen,
             coalesce(sum(e.tokens) FILTER (WHERE e.kind = 'chat' AND e.created_at >= date_trunc('day', now())), 0)::bigint AS tokens_today,
             coalesce(sum(e.tokens) FILTER (WHERE e.kind = 'chat'), 0)::bigint AS tokens_total,
             (SELECT count(*) FROM images i WHERE i.user_id = u.id)::int AS images,
             (SELECT count(*) FROM sites s WHERE s.user_id = u.id)::int AS sites
      FROM app_users u LEFT JOIN usage_events e ON e.user_id = u.id
      GROUP BY u.id ORDER BY u.last_seen DESC LIMIT 500`;
    return json(rows);
  }

  if (view === "sites") {
    const rows = await sql`
      SELECT s.slug, s.title, s.kind, s.views, s.created_at, s.updated_at, length(s.html)::int AS size, u.email
      FROM sites s LEFT JOIN app_users u ON u.id = s.user_id ORDER BY s.updated_at DESC LIMIT 300`;
    return json(rows.map((r) => ({ ...r, url: `${SITES_ORIGIN}/${r.slug}` })));
  }

  if (view === "images") {
    const rows = await sql`
      SELECT i.id, i.prompt, i.width, i.height, i.created_at, u.email
      FROM images i LEFT JOIN app_users u ON u.id = i.user_id ORDER BY i.created_at DESC LIMIT 120`;
    return json(rows.map((r) => ({ ...r, url: `/i/${r.id}` })));
  }

  throw new HttpError(400, "عرض غير معروف");
});

export const POST = route(async (request) => {
  const admin = await requireAdmin(request);
  const b = await request.json().catch(() => ({}));
  switch (b.action) {
    case "ban":
    case "unban":
      if (b.user_id === admin.id) throw new HttpError(400, "لا يمكنك إيقاف نفسك");
      await sql`UPDATE app_users SET banned = ${b.action === "ban"} WHERE id = ${b.user_id}`;
      break;
    case "limits":
      await sql`UPDATE app_users SET daily_tokens = ${Math.max(0, Number(b.tokens) || 0)},
                daily_images = ${Math.max(0, Number(b.images) || 0)}, daily_sites = ${Math.max(0, Number(b.sites) || 0)}
                WHERE id = ${b.user_id}`;
      break;
    case "role":
      if (!["user", "admin"].includes(b.role)) throw new HttpError(400, "صلاحية غير صحيحة");
      if (b.user_id === admin.id) throw new HttpError(400, "لا يمكنك تغيير صلاحيتك");
      await sql`UPDATE app_users SET role = ${b.role} WHERE id = ${b.user_id}`;
      break;
    case "delete_site":
      await sql`DELETE FROM sites WHERE slug = ${b.slug}`;
      break;
    case "delete_image":
      await sql`DELETE FROM images WHERE id = ${b.id}`;
      break;
    default:
      throw new HttpError(400, "إجراء غير معروف");
  }
  return json({ ok: true });
});
