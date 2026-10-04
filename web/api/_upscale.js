// رفع دقة وتوضيح أي صورة داخل سيرفر البوت نفسه (بدون خدمة خارجية): Real-ESRGAN (realesr-general-x4v3) بصيغة ONNX
// يوضّح النص والشعارات والمناظر والأشياء ويكبّر 4 مرات. الوجوه تتصلح قبلها بـ CodeFormer (بـ _imageedit.js)
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-web";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const MODEL = fileURLToPath(new URL("../models/realesr-general-x4v3.onnx", import.meta.url));
let session = null;
async function getSession() {
  if (!session) {
    ort.env.wasm.numThreads = 1;
    session = await ort.InferenceSession.create(fs.readFileSync(MODEL), { executionProviders: ["wasm"] });
  }
  return session;
}

/**
 * يكبّر الصورة ×4 ويوضّحها. الصور الكبيرة نصغّرها أول لحد maxPixels (الوقت يعتمد على عدد البكسلات: 512×512 ≈ نص دقيقة)
 * يرجع { bytes (JPEG), mime, w, h }
 */
export async function upscale4x(bytes, { maxPixels = 300_000 } = {}) {
  const im = await loadImage(bytes);
  const s = Math.min(1, Math.sqrt(maxPixels / (im.width * im.height)));
  const iw = Math.max(8, Math.round(im.width * s)), ih = Math.max(8, Math.round(im.height * s));
  const c = createCanvas(iw, ih), g = c.getContext("2d");
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, iw, ih); // صور شفافة: خلفية بيضة
  g.imageSmoothingQuality = "high";
  g.drawImage(im, 0, 0, iw, ih);
  const px = g.getImageData(0, 0, iw, ih).data, n = iw * ih;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { input[i] = px[i * 4] / 255; input[n + i] = px[i * 4 + 1] / 255; input[2 * n + i] = px[i * 4 + 2] / 255; }
  const sess = await getSession();
  const out = (await sess.run({ input: new ort.Tensor("float32", input, [1, 3, ih, iw]) })).output;
  const [, , oh, ow] = out.dims, od = out.data, m = ow * oh;
  const oc = createCanvas(ow, oh), og = oc.getContext("2d");
  const img = og.createImageData(ow, oh), d = img.data;
  const clamp = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));
  for (let i = 0; i < m; i++) { d[i * 4] = clamp(od[i]); d[i * 4 + 1] = clamp(od[m + i]); d[i * 4 + 2] = clamp(od[2 * m + i]); d[i * 4 + 3] = 255; }
  og.putImageData(img, 0, 0);
  return { bytes: oc.toBuffer("image/jpeg", 95), mime: "image/jpeg", w: ow, h: oh };
}
