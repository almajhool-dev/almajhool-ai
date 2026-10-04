// تجربة حقيقية: محادثة فيها اسم «المجهول» + صورة بزونة. البوت يفهم الطلب، يعدّل بدقة، ويتأكد من النتيجة
import fs from "fs";
import { GlobalFonts, createCanvas } from "@napi-rs/canvas";
import { planImageFollowup, preciseEdit, editImage, enhanceImage, routeFollowup, verifyEdit, visionMessages } from "./api/_imageedit.js";
import { loadImage } from "@napi-rs/canvas";
import { directText } from "./api/_direct.js";
GlobalFonts.registerFromPath("fonts/maj-arabic.ttf", "A");
const c = createCanvas(720, 540), g = c.getContext("2d");
g.fillStyle = "#f2f3f5"; g.fillRect(0, 0, 720, 540);
const bubble = (y, name, msg, color) => {
  g.fillStyle = "#ffffff"; g.beginPath(); g.roundRect(120, y, 560, 110, 18); g.fill();
  g.fillStyle = "#222"; g.beginPath(); g.arc(70, y + 40, 32, 0, 7); g.fill();
  g.direction = "rtl"; g.textAlign = "right";
  g.fillStyle = color; g.font = "bold 30px A"; g.fillText(name, 655, y + 42);
  g.fillStyle = "#333"; g.font = "26px A"; g.fillText(msg, 655, y + 88);
};
bubble(40, "المجهول", "هلا شلونكم شباب؟", "#1a73e8");
bubble(200, "أحمد علي", "تمام الحمد لله", "#d93025");
bubble(360, "المجهول", "يلا نلتقي باچر", "#1a73e8");
const chat = { bytes: c.toBuffer("image/png"), mime: "image/png" };
const gc = createCanvas(720, 900), gg = gc.getContext("2d");
const gr = gg.createLinearGradient(0, 0, 720, 900); gr.addColorStop(0, "#0f2027"); gr.addColorStop(0.5, "#2c5364"); gr.addColorStop(1, "#1fa2a6");
gg.fillStyle = gr; gg.fillRect(0, 0, 720, 900);
gg.fillStyle = "#000"; gg.beginPath(); gg.arc(150, 300, 90, 0, 7); gg.fill();
gg.fillStyle = "#fff"; gg.font = "bold 44px A"; gg.direction = "rtl"; gg.textAlign = "right"; gg.fillText("المجهول", 650, 320); gg.fillText("أحمد", 650, 600);
const grad = { bytes: gc.toBuffer("image/png"), mime: "image/png" };
const cat = { bytes: fs.readFileSync("cat.jpg"), mime: "image/jpeg" };
fs.mkdirSync("../out", { recursive: true });
fs.writeFileSync("../out/chat-0.png", chat.bytes);
const history = [{ role: "user", content: "[دزيت صورة]" }, { role: "assistant", content: "وصلتني الصورة 👌 شتريد أسوي بيها؟" }];
let bad = 0;
for (const [img, text, file] of [[chat, "شيل اسم المجهول", "chat-remove"], [chat, "غير اسم المجهول الى أبو علي", "chat-replace"], [chat, "اكتب فوگ كلمة بغداد", "chat-add"], [cat, "شيل الشغلة الحمرة اللي فوگ", "cat-remove"], [grad, "شيل الصورة السودة واسم المجهول", "grad-remove"], [chat, "وضحها وارفع دقتها", "-plan-only"]]) {
  const t = Date.now();
  const plan = await planImageFollowup({ ...img, history, text });
  if (file === "-plan-only") { const ok = plan.action === "enhance"; if (!ok) bad++; console.log(ok ? "PLAN_ENHANCE_OK " : "PLAN_ENHANCE_BAD", text, "=>", plan.action); continue; }
  let out = await preciseEdit({ ...img, plan }).catch((e) => (console.log("  precise error", e.message), null));
  let how = out ? out.provider : "";
  if (!out) { out = await editImage({ ...img, instruction: plan.instruction, verify: (a) => verifyEdit({ before: img, after: a, instruction: plan.instruction }) }); how = out.provider + (out.verified ? "" : " (unverified)"); }
  const v = await verifyEdit({ before: img, after: out, instruction: plan.instruction });
  if (!v.ok) bad++;
  fs.writeFileSync(`../out/${file}.png`, out.bytes);
  console.log(v.ok ? "EDIT_OK  " : "EDIT_BAD ", ((Date.now() - t) / 1000).toFixed(1) + "s", "|", text, "| plan:", plan.action, plan.op, JSON.stringify(plan.target).slice(0, 90), plan.newText, "| via", how, v.ok ? "" : "| " + v.problem);
}
const memo = await planImageFollowup({ ...chat, history: [...history, { role: "user", content: "اكتبلي خطة مشروع منصة SaaS" }, { role: "assistant", content: "هاي الخطة: ..." }], text: "تذكر قبل شويه شكتلك تسويلي" });
console.log(memo.action === "other" ? "MEMORY_OK " : "MEMORY_BAD", memo.action);
{ // تحسين مثل Remini: صورة وجه صغيرة ومضغوطة ← أوضح وأكبر
  const face = await loadImage(fs.readFileSync("face.jpg")); const fc = createCanvas(160, Math.round(160 * face.height / face.width));
  fc.getContext("2d").drawImage(face, 0, 0, fc.width, fc.height); const low = fc.toBuffer("image/jpeg", 60);
  const t = Date.now();
  try { const e = await enhanceImage({ bytes: low, mime: "image/jpeg" }); fs.writeFileSync("../out/face-0.jpg", low); fs.writeFileSync("../out/face-enhanced.png", e.bytes);
    console.log("ENHANCE_OK", ((Date.now() - t) / 1000).toFixed(1) + "s", `${fc.width}x${fc.height} -> ${e.w}x${e.h}`, "via", e.provider); }
  catch (e) { bad++; console.log("ENHANCE_FAIL", e.message.slice(0, 300)); }
}
{ // صورة بدون وجه (بزونة صغيرة ومضغوطة): Real-ESRGAN لازم يوضحها ويكبرها
  const im = await loadImage(cat.bytes); const cc = createCanvas(200, 200); cc.getContext("2d").drawImage(im, 0, 0, 200, 200);
  const low = cc.toBuffer("image/jpeg", 50), t = Date.now();
  try { const e = await enhanceImage({ bytes: low, mime: "image/jpeg" }); fs.writeFileSync("../out/cat-low.jpg", low); fs.writeFileSync("../out/cat-enhanced.jpg", e.bytes);
    console.log("ENHANCE_OK", ((Date.now() - t) / 1000).toFixed(1) + "s", `200x200 -> ${e.w}x${e.h}`, "via", e.provider); }
  catch (e) { bad++; console.log("ENHANCE_FAIL", e.message.slice(0, 300)); }
}
{ // نفس محادثة المستخدم الحقيقية: «انشاء مقطع علئ هاذه صوره» ← عرض ← «حوله» لازم يصير فيديو
  const h = [{ role: "user", content: "[دزيت صورة]" }, { role: "user", content: "[عن الصورة] انشاء مقطع علئ هاذه صوره" },
             { role: "assistant", content: "حبيبي، الصورة بيها لقطات لأسد يركض بالصحراء. اگدر أحولك هاي الصور إلى مقطع فيديو متحرك، تريد؟" }];
  const r = await routeFollowup({ history: h, text: "حوله" });
  console.log(r.action === "video" ? "ROUTE_OK " : "ROUTE_BAD", r.action, "|", r.request); if (r.action !== "video") bad++;
  const r2 = await routeFollowup({ history: h, text: "شكرا حبيبي" });
  console.log(r2.action === "chat" ? "ROUTE_OK " : "ROUTE_BAD", r2.action, "| شكرا حبيبي"); if (r2.action !== "chat") bad++;
  const p = await planImageFollowup({ ...cat, history: [], text: "انشاء مقطع علئ هاذه صوره" });
  console.log(p.action === "video" ? "PLAN_VIDEO_OK " : "PLAN_VIDEO_BAD", p.action); if (p.action !== "video") bad++;
}
const ans = await directText(visionMessages("رد باللهجة العراقية وباختصار.", history, "منو الأسماء اللي بالمحادثة؟", chat.bytes, chat.mime), { provider: "gemini", max_tokens: 200 });
console.log("VISION |", ans.replace(/\s+/g, " ").slice(0, 200));
if (bad > 1) process.exitCode = 1;
