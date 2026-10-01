// معلومات المستخدم الحالي + استهلاكه اليوم + حدوده + المزودات المتاحة
import { getUser, gateway, json, route, usageToday } from "./_lib.js";

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
  return json({
    user: { id: user.id, email: user.email, name: user.name, image: user.image, role: user.role, banned: user.banned },
    limits: { tokens: user.daily_tokens, images: user.daily_images, sites: user.daily_sites },
    usage: await usageToday(user.id),
    // الأدمن يرى تفاصيل كل المصادر (السعة، الحالة، الإحصاءات)، والمستخدم العادي يرى الأساسيات فقط
    providers: user.role === "admin" ? providersCache.data
      : providersCache.data.map(({ id, kind, configured, model, sizes }) => ({ id, kind, configured, model, sizes })),
  });
});
