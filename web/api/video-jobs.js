// طابور رفع دقة المقاطع: البوت يضيف المقطع هنا، وأجهزة GitHub المجانية تاخذه وتعالجه وتدزه للمستخدم.
// الحماية: مفتاح العامل مشتق من توكن البوت (موجود بأسرار GitHub وبـ Vercel) — ما يحتاج سر جديد.
import { createHash } from "node:crypto";
import { json, sql } from "./_lib.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const WORKER_KEY = TOKEN ? createHash("sha256").update(`${TOKEN}:video-worker`).digest("hex").slice(0, 48) : "";

let ready = false;
export async function ensureVideoTable() {
  if (ready) return;
  await sql`CREATE TABLE IF NOT EXISTS video_jobs (id text PRIMARY KEY, user_id text NOT NULL, chat_id bigint NOT NULL, message_id bigint NOT NULL,
    file_id text NOT NULL, file_size bigint, duration int, width int, height int, status text NOT NULL DEFAULT 'pending', status_message_id bigint,
    error text, created_at timestamptz NOT NULL DEFAULT now(), claimed_at timestamptz, finished_at timestamptz)`;
  ready = true;
}

/** يطلب من GitHub يبدي المعالجة فورًا (إذا اكو مفتاح). بدونه: الجدولة كل 5 دقايق تلگاه */
export async function wakeWorker() {
  const token = process.env.GH_DISPATCH_TOKEN;
  if (!token) return false;
  const repo = process.env.GH_REPO || "almajhool-dev/almajhool-ai";
  const r = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "almajhool-ai" },
    body: JSON.stringify({ event_type: "upscale" }),
  }).catch((e) => { console.error("wakeWorker:", e?.message); return null; });
  if (r && !r.ok) console.error("wakeWorker: GitHub HTTP", r.status, (await r.text().catch(() => "")).slice(0, 200));
  return !!r?.ok;
}

export async function POST(request) {
  if (!WORKER_KEY || request.headers.get("x-worker-key") !== WORKER_KEY) return json({ error: "forbidden" }, 403);
  await ensureVideoTable();
  const body = await request.json().catch(() => ({}));
  if (body.action === "claim") {
    // ناخذ أقدم مقطع ينتظر (أو وحد علگ بالمعالجة أكثر من 7 ساعات)
    const rows = await sql`UPDATE video_jobs SET status = 'processing', claimed_at = now()
      WHERE id = (SELECT id FROM video_jobs WHERE status = 'pending' OR (status = 'processing' AND claimed_at < now() - interval '7 hours')
                  ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, chat_id, message_id, file_id, file_size, duration, width, height, status_message_id`;
    return json({ job: rows[0] || null });
  }
  if (body.action === "finish" && body.id) {
    await sql`UPDATE video_jobs SET status = ${body.ok ? "done" : "failed"}, error = ${body.error ? String(body.error).slice(0, 500) : null}, finished_at = now() WHERE id = ${body.id}`;
    return json({ ok: true });
  }
  return json({ error: "bad request" }, 400);
}

export async function GET() {
  return json({ worker: WORKER_KEY ? "ready" : "missing TELEGRAM_BOT_TOKEN" });
}
