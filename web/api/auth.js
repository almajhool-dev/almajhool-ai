// /api/auth/<path> → Neon Auth (عبر إعادة توجيه في vercel.json: /api/auth/:path* → /api/auth?__p=:path*)
import { authProxy } from "./_lib.js";

async function handler(request) {
  const url = new URL(request.url);
  const path = url.searchParams.get("__p") || url.pathname.replace(/^\/api\/auth\/?/, "");
  url.searchParams.delete("__p");
  url.pathname = "/api/auth/" + path;
  const init = { method: request.method, headers: request.headers };
  if (!["GET", "HEAD"].includes(request.method)) init.body = await request.text();
  return authProxy(new Request(url, init), path);
}

export { handler as GET, handler as POST };
