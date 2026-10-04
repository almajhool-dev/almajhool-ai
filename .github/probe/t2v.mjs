// تجربة: أي نموذج فيديو مجاني يشتغل هسه
import fs from "fs";
import { gradioRun } from "./api/_videogen.js";
const prompt = "A golden retriever puppy running happily on a sunny beach, waves in the background, cinematic, smooth camera tracking";
fs.mkdirSync("../probe_out", { recursive: true });
for (const sp of ["zerogpu-aoti/wan2-2-fp8da-aoti-faster", "multimodalart/wan2-1-fast", "Lightricks/ltx-video-distilled", "Wan-AI/Wan2.2-5B", "Heartsync/wan2_2-T2V-14B-fast", "rahul7star/Wan2.2-T2V-A14B", "alexnasa/Wan2.2-T2V", "jbilcke-hf/ai-video-generator"]) {
  const t = Date.now();
  try {
    const r = await gradioRun(sp, { prompt });
    const v = await fetch(r.url, { headers: r.auth }); const buf = Buffer.from(await v.arrayBuffer());
    const name = sp.replace(/\//g, "__") + ".mp4"; fs.writeFileSync("../probe_out/" + name, buf);
    console.log("T2V_OK  ", sp, r.endpoint, ((Date.now() - t) / 1000).toFixed(0) + "s", buf.length, v.headers.get("content-type"));
  } catch (e) { console.log("T2V_FAIL", sp, ((Date.now() - t) / 1000).toFixed(0) + "s", String(e.message).slice(0, 200)); }
}
