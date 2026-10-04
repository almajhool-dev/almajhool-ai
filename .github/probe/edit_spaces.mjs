// تجربة: أي مساحة تعديل صور تشتغل مجانًا وأيها يشيل اسم من صورة محادثة بدقة
import fs from "fs";
import { GlobalFonts, createCanvas } from "@napi-rs/canvas";
import { gradioEdit } from "./api/_imageedit.js";
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
const src = c.toBuffer("image/png");
fs.mkdirSync("../probe_out", { recursive: true }); fs.writeFileSync("../probe_out/0-source.png", src);
const instruction = "Remove the blue name text 'المجهول' from both chat bubbles (top bubble and bottom bubble), filling with the white bubble background. Keep everything else exactly identical, including all other text.";
for (const sp of ["Qwen/Qwen-Image-Edit-2509", "Qwen/Qwen-Image-Edit-2511", "akhaliq/Qwen-Image-Edit-2509", "prithivMLmods/Qwen-Image-Edit-2509-LoRAs-Fast", "linoyts/Qwen-Image-Edit-Rapid-AIO", "multimodalart/Qwen-Image-Edit-Fast", "Qwen/Qwen-Image-Edit", "black-forest-labs/FLUX.1-Kontext-Dev"]) {
  const t = Date.now();
  try {
    const r = await gradioEdit(sp, src, "image/png", instruction);
    const name = sp.replace(/\//g, "__") + (r.mime.includes("png") ? ".png" : ".jpg");
    fs.writeFileSync("../probe_out/" + name, r.bytes);
    console.log("SPACE_OK  ", sp, ((Date.now() - t) / 1000).toFixed(1) + "s", r.bytes.length, "->", name);
  } catch (e) { console.log("SPACE_FAIL", sp, ((Date.now() - t) / 1000).toFixed(1) + "s", String(e.message).slice(0, 220)); }
}
