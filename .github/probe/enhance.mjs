// تجربة: أي مساحة مجانية تحسّن الصور مثل Remini (توضيح الوجوه + رفع الدقة)
import fs from "fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { gradioEdit } from "./api/_imageedit.js";
const src = await loadImage(fs.readFileSync("face.jpg"));
// نصغّرها حتى تصير «صورة قديمة واطية الدقة» مثل اللي يدزها الناس
const c = createCanvas(160, Math.round(160 * src.height / src.width)); c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
const low = c.toBuffer("image/jpeg", 60);
fs.mkdirSync("../probe_out", { recursive: true }); fs.writeFileSync("../probe_out/0-low.jpg", low);
for (const sp of ["sczhou/CodeFormer", "Xintao/GFPGAN", "finegrain/finegrain-image-enhancer", "doevent/Face-Real-ESRGAN", "akhaliq/Real-ESRGAN", "tencentarc/gfpgan", "nightfury/Image_Face_Upscale_Restoration-GFPGAN", "jbilcke-hf/ai-clarity-upscaler", "gokaygokay/Tile-Upscaler"]) {
  const t = Date.now();
  try {
    const r = await gradioEdit(sp, low, "image/jpeg", "high quality, sharp, detailed");
    const im = await loadImage(r.bytes);
    const name = sp.replace(/\//g, "__") + ".png";
    fs.writeFileSync("../probe_out/" + name, r.bytes);
    console.log("ENH_OK  ", sp, ((Date.now() - t) / 1000).toFixed(1) + "s", `${im.width}x${im.height}`, r.bytes.length);
  } catch (e) { console.log("ENH_FAIL", sp, ((Date.now() - t) / 1000).toFixed(1) + "s", String(e.message).slice(0, 200)); }
}
