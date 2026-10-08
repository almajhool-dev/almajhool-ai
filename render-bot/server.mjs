import http from "node:http";
import {
  derivedSecret, safeEqual, handleVoiceMessage, forwardLegacy, tg
} from "./bridge.mjs";

const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const sawtakKey = String(process.env.SAWTAK_API_KEY || "").trim();
const port = Number(process.env.PORT || 10000);
const seen = new Set();

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}
async function bodyJson(req) {
  const parts = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > 2_000_000) throw new Error("body too large");
    parts.push(c);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
}
async function setWebhook(base) {
  if (!token || !base) return;
  const url = base.replace(/\/$/, "") + "/telegram";
  const result = await tg(token, "setWebhook", {
    url,
    secret_token: derivedSecret(token),
    allowed_updates: ["message"],
    drop_pending_updates: false,
  });
  console.log("Webhook set:", url, result);
}
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || "/", "http://localhost");
    if (req.method === "GET" && u.pathname === "/health") {
      return send(res, 200, {
        ok: true,
        telegram: !!token,
        sawtak: !!sawtakKey,
        host: process.env.RENDER_EXTERNAL_HOSTNAME || null,
      });
    }
    if (req.method === "POST" && u.pathname === "/setup") {
      const b = await bodyJson(req);
      if (!token || !safeEqual(String(b.token || ""), token)) return send(res, 401, { ok:false });
      const base = "https://" + String(req.headers.host || "").replace(/[^a-zA-Z0-9.:-]/g, "");
      await setWebhook(base);
      return send(res, 200, { ok:true, webhook: base + "/telegram" });
    }
    if (req.method === "POST" && u.pathname === "/telegram") {
      if (!token || !sawtakKey) return send(res, 503, { ok:false, error:"not configured" });
      const got = String(req.headers["x-telegram-bot-api-secret-token"] || "");
      if (!safeEqual(got, derivedSecret(token))) return send(res, 401, { ok:false });
      const update = await bodyJson(req);
      if (Number.isFinite(update?.update_id)) {
        if (seen.has(update.update_id)) return send(res, 200, { ok:true, duplicate:true });
        seen.add(update.update_id);
        if (seen.size > 1000) seen.delete(seen.values().next().value);
      }
      const msg = update?.message;
      if (msg?.voice || msg?.audio) {
        void handleVoiceMessage(msg, { token, sawtakKey }).catch((e) => console.error("voice task", e?.message));
      } else {
        void forwardLegacy(update, token).catch((e) => console.error("legacy", e?.message));
      }
      return send(res, 200, { ok:true });
    }
    return send(res, 404, { ok:false });
  } catch (e) {
    console.error("request", String(e?.message || e).slice(0,300));
    return send(res, 500, { ok:false });
  }
});
server.listen(port, "0.0.0.0", async () => {
  console.log("voice bridge listening", port);
  const host = String(process.env.RENDER_EXTERNAL_HOSTNAME || "").trim();
  if (token && sawtakKey && host) {
    try { await setWebhook("https://" + host); }
    catch (e) { console.error("setWebhook", String(e?.message || e).slice(0,300)); }
  }
});
