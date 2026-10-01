// كتابة النص العربي الصحيح فوق الصورة على الخادم (للبوت) — نفس رسم المتصفح بالموقع:
// شريط اسم مطرّز على البدلات، أو طباعة مباشرة على اللوحات والجدران
import { fileURLToPath } from "node:url";
import { GlobalFonts, createCanvas, loadImage } from "@napi-rs/canvas";

let fontReady = false;
function ensureFont() {
  if (fontReady) return;
  GlobalFonts.registerFromPath(fileURLToPath(new URL("../fonts/maj-arabic.ttf", import.meta.url)), "MajArabic");
  fontReady = true;
}
const FAMILY = "MajArabic";

const shade = (hex, p) => {
  const n = parseInt(String(hex).slice(1), 16) || 0, f = (v) => Math.max(0, Math.min(255, Math.round(v + (p > 0 ? 255 - v : v) * p)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
};

function drawNameTape(ctx, o, x, y, w, h) {
  if (h > w / 3) { const nh = w / 4.2; y += (h - nh) / 2; h = nh; }
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2); ctx.rotate(((o.angle || 0) * Math.PI) / 180);
  const L = -w / 2, T = -h / 2, r = Math.min(h * 0.1, 5);
  const tape = () => { ctx.beginPath(); ctx.roundRect(L, T, w, h, r); };
  ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = Math.max(2, h * 0.15); ctx.shadowOffsetY = Math.max(1, h * 0.05);
  const g = ctx.createLinearGradient(0, T, 0, T + h);
  g.addColorStop(0, shade(o.bg, 0.1)); g.addColorStop(1, shade(o.bg, -0.15));
  tape(); ctx.fillStyle = g; ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.save(); tape(); ctx.clip();
  ctx.strokeStyle = "rgba(255,255,255,.05)"; ctx.lineWidth = 1;
  for (let yy = T + 1; yy < T + h; yy += Math.max(2, h * 0.06)) { ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(L + w, yy); ctx.stroke(); }
  ctx.restore();
  const inset = Math.max(1.5, h * 0.1);
  ctx.setLineDash([Math.max(2, h * 0.09), Math.max(1.5, h * 0.06)]);
  ctx.strokeStyle = shade(o.bg, 0.3); ctx.lineWidth = Math.max(0.8, h * 0.035);
  ctx.strokeRect(L + inset, T + inset, w - inset * 2, h - inset * 2);
  ctx.setLineDash([]);
  let size = h * 0.6;
  const font = (sz) => `bold ${sz}px ${FAMILY}`;
  ctx.font = font(size);
  while (ctx.measureText(o.text).width > w * 0.82 && size > 6) { size -= 0.5; ctx.font = font(size); }
  ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.direction = "rtl";
  ctx.shadowColor = "rgba(0,0,0,.55)"; ctx.shadowBlur = Math.max(1, size * 0.06); ctx.shadowOffsetY = Math.max(0.5, size * 0.04);
  const tg = ctx.createLinearGradient(0, -size / 2, 0, size / 2);
  tg.addColorStop(0, shade(o.fg, 0.15)); tg.addColorStop(1, shade(o.fg, -0.18));
  ctx.fillStyle = tg; ctx.fillText(o.text, 0, size * 0.06);
  ctx.restore();
}

function drawPrint(c, ctx, o, x, y, w, h) {
  const pad = Math.max(6, h * 0.3);
  const rx = Math.max(0, Math.floor(x - pad)), ry = Math.max(0, Math.floor(y - pad));
  const rw = Math.min(c.width - rx, Math.ceil(w + pad * 2)), rh = Math.min(c.height - ry, Math.ceil(h + pad * 2));
  if (rw < 4 || rh < 4) return;
  const orig = createCanvas(rw, rh); orig.getContext("2d").drawImage(c, rx, ry, rw, rh, 0, 0, rw, rh);
  if (o.existing !== false) {
    // نمسح الحروف الغلط بلون السطح من فوگ وجوه، بحواف ناعمة
    const top = Math.max(2, Math.floor(y - ry)), bottom = Math.max(2, Math.floor(ry + rh - (y + h)));
    const cols = Math.max(2, Math.round(rw / Math.max(3, h * 0.5)));
    const small = createCanvas(cols, 2), sctx = small.getContext("2d");
    sctx.drawImage(c, rx, ry, rw, Math.min(top, rh), 0, 0, cols, 1);
    sctx.drawImage(c, rx, ry + rh - Math.min(bottom, rh), rw, Math.min(bottom, rh), 0, 1, cols, 1);
    const patch = createCanvas(rw, rh), pctx = patch.getContext("2d");
    pctx.drawImage(small, 0, 0, rw, rh);
    const px = pctx.getImageData(0, 0, rw, rh);
    for (let i = 0; i < px.data.length; i += 4) { const n = (Math.random() - 0.5) * 10; px.data[i] += n; px.data[i + 1] += n; px.data[i + 2] += n; }
    pctx.putImageData(px, 0, 0);
    const f = Math.max(3, pad * 0.8), mask = createCanvas(rw, rh), mctx = mask.getContext("2d");
    mctx.shadowColor = "#000"; mctx.shadowBlur = f; mctx.shadowOffsetX = rw + 50;
    mctx.fillRect(f - rw - 50, f, rw - f * 2, rh - f * 2);
    pctx.globalCompositeOperation = "destination-in"; pctx.drawImage(mask, 0, 0);
    ctx.drawImage(patch, rx, ry);
  }
  const t = createCanvas(rw, rh), tctx = t.getContext("2d");
  let size = h * 0.82;
  const font = (sz) => `bold ${sz}px ${FAMILY}`;
  tctx.font = font(size);
  while (tctx.measureText(o.text).width > w * 0.94 && size > 8) { size -= 1; tctx.font = font(size); }
  tctx.translate(rw / 2, rh / 2); tctx.rotate(((o.angle || 0) * Math.PI) / 180);
  tctx.fillStyle = o.fg; tctx.textAlign = "center"; tctx.textBaseline = "middle"; tctx.direction = "rtl";
  tctx.fillText(o.text, 0, size * 0.05);
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.globalCompositeOperation = "source-atop"; tctx.globalAlpha = 0.22;
  tctx.drawImage(orig, 0, 0);
  ctx.globalAlpha = 0.95; ctx.drawImage(t, rx, ry); ctx.globalAlpha = 1;
}

/** يرجع صورة PNG (Buffer) فيها الكتابة الصحيحة، من صورة (data URL أو Buffer) وأماكن الكتابة */
export async function applyOverlaysServer(image, overlays) {
  ensureFont();
  const src = typeof image === "string" ? Buffer.from(image.split(",")[1], "base64") : image;
  const img = await loadImage(src);
  const c = createCanvas(img.width, img.height), ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  for (const o of overlays || []) {
    const [y0, x0, y1, x1] = o.box;
    const x = (x0 / 1000) * c.width, y = (y0 / 1000) * c.height, w = ((x1 - x0) / 1000) * c.width, h = ((y1 - y0) / 1000) * c.height;
    if (o.style !== "print") drawNameTape(ctx, o, x, y, w, h);
    else drawPrint(c, ctx, o, x, y, w, h);
  }
  return c.toBuffer("image/png");
}
