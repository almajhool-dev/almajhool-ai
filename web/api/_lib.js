// أدوات مشتركة لكل دوال الخادم (Vercel Functions) — الملفات التي تبدأ بـ _ لا تُنشر كمسارات
import { neon } from "@neondatabase/serverless";
import { handleAuthProxyRequest } from "@neondatabase/auth/server";

export const sql = neon(process.env.DATABASE_URL);

const AUTH_BASE = process.env.NEON_AUTH_BASE_URL;
const COOKIE_SECRET = process.env.NEON_AUTH_COOKIE_SECRET;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
export const SITES_ORIGIN = (process.env.SITES_ORIGIN || "").replace(/\/$/, "");

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** يغلف أي دالة بمعالجة أخطاء موحدة */
export function route(fn) {
  return async (request) => {
    try {
      return await fn(request);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "خطأ في الخادم" }, 500);
    }
  };
}

/** يمرر طلبات تسجيل الدخول إلى Neon Auth عبر نطاق موقعنا (كوكيز من الطرف الأول — تعمل في Brave وSafari) */
export function authProxy(request, path) {
  return handleAuthProxyRequest({ request, path, baseUrl: AUTH_BASE, cookieSecret: COOKIE_SECRET, sameSite: "lax" });
}

/** يرجع المستخدم الحالي من الجلسة (أو null) ويحدّث سجله في app_users */
export async function getUser(request) {
  const cookie = request.headers.get("cookie") || "";
  if (!cookie.includes("neon-auth")) return null;
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("content-type");
  const url = new URL("/api/auth/get-session", request.url);
  const res = await authProxy(new Request(url, { method: "GET", headers }), "get-session");
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const u = data?.user;
  if (!u?.id) return null;
  const isAdminEmail = ADMIN_EMAILS.includes(String(u.email || "").toLowerCase());
  const rows = await sql`
    INSERT INTO app_users (id, email, name, image, role)
    VALUES (${u.id}, ${u.email}, ${u.name}, ${u.image}, ${isAdminEmail ? "admin" : "user"})
    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, image = EXCLUDED.image,
      last_seen = now(), role = CASE WHEN ${isAdminEmail} THEN 'admin' ELSE app_users.role END
    RETURNING *`;
  return rows[0];
}

export async function requireUser(request) {
  const user = await getUser(request);
  if (!user) throw new HttpError(401, "سجّل الدخول أولًا");
  if (user.banned) throw new HttpError(403, "تم إيقاف حسابك من قبل الإدارة");
  return user;
}

export async function requireAdmin(request) {
  const user = await requireUser(request);
  if (user.role !== "admin") throw new HttpError(403, "هذه الصفحة للإدارة فقط");
  return user;
}

export async function usageToday(userId) {
  const [r] = await sql`
    SELECT coalesce(sum(tokens) FILTER (WHERE kind = 'chat'), 0)::int AS tokens,
           count(*) FILTER (WHERE kind = 'chat')::int AS requests,
           count(*) FILTER (WHERE kind = 'image')::int AS images,
           count(*) FILTER (WHERE kind = 'publish')::int AS sites
    FROM usage_events WHERE user_id = ${userId} AND created_at >= date_trunc('day', now())`;
  return r;
}

export async function logUsage(userId, kind, tokens = 0, provider = null, model = null) {
  await sql`INSERT INTO usage_events (user_id, kind, tokens, provider, model) VALUES (${userId}, ${kind}, ${tokens}, ${provider}, ${model})`;
}

/** استدعاء البوابة (Cloudflare Worker) — رابطها وكلمة سرها محفوظة على الخادم فقط */
export function gateway(path, body) {
  const base = (process.env.GATEWAY_URL || "").replace(/\/$/, "");
  return fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${process.env.GATEWAY_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export const randomId = (bytes = 12) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
export const estTokens = (s) => Math.ceil(String(s || "").length / 3.2);
