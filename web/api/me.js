// معلومات المستخدم الحالي + استهلاكه اليوم + حدوده + المزودات المتاحة
import { getUser, gateway, json, route, usageToday } from "./_lib.js";
import { directConfigured } from "./_direct.js";

let providersCache = { at: 0, data: [] };

export const GET = route(async (request) => {
  const user = await getUser(request);
  if (!user) return json({ user: null });
  if (Date.now() - providersCache.at > 20_000) {
    try {
      const r = await gateway("/api/providers");
      if (r.ok) providersCache = { at: Date.now(), data: await r.json() };
    } catch { /* البوابة غير متاحة مؤقتًا */ }
  }
  // النماذج المتصلة مباشرة بالموقع تظهر أولًا (وتحل محل نفس المزود في البوابة)
  const direct = directConfigured().map((p) => ({ id: p.id, kind: "text", tier: 1, configured: true, has_key: true,
    model: (process.env[`${p.id.toUpperCase()}_MODELS`] || "").split(",")[0].trim() || p.models[0], cap: "متصل مباشرة بالموقع", direct: true }));
  const allProviders = [...direct, ...providersCache.data.filter((g) => !direct.some((d) => d.id === g.id))];
  return json({
    user: { id: user.id, email: user.email, name: user.name, image: user.image, role: user.role, banned: user.banned },
    limits: { tokens: user.daily_tokens, images: user.daily_images, sites: user.daily_sites },
    usage: await usageToday(user.id),
    // الأدمن يرى تفاصيل كل المصادر (السعة، الحالة، الإحصاءات)، والمستخدم العادي يرى الأساسيات فقط
    providers: user.role === "admin" ? allProviders
      : allProviders.map(({ id, kind, configured, model, sizes }) => ({ id, kind, configured, model, sizes })),
  });
});
