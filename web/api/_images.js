// توليد صور احتياطي بدون مفتاح — يُستخدم إذا فشلت البوابة (مثل خطأ Cloudflare 4006)
// ملف يبدأ بـ _ فلا يصبح مسارًا في Vercel
// مساحات Hugging Face العامة (Gradio) — تعمل بدون مفتاح (وبحصة أكبر إذا وُجد HF_TOKEN)
const SPACES = [
  { id: "flux-schnell", base: "https://black-forest-labs-flux-1-schnell.hf.space", api: "infer",
    data: (p, seed) => [p, seed, false, 1024, 1024, 4] },
  { id: "sd3.5-turbo", base: "https://stabilityai-stable-diffusion-3-5-large-turbo.hf.space", api: "infer",
    data: (p, seed) => [p, "", seed, false, 1024, 1024, 0, 4] },
];

async function runSpace(sp, prompt, seed) {
  const headers = { "Content-Type": "application/json" };
  if (process.env.HF_TOKEN) headers.Authorization = `Bearer ${process.env.HF_TOKEN}`;
  const start = await fetch(`${sp.base}/gradio_api/call/${sp.api}`, {
    method: "POST", headers, body: JSON.stringify({ data: sp.data(prompt, seed) }), signal: AbortSignal.timeout(15_000) });
  const { event_id } = await start.json().catch(() => ({}));
  if (!start.ok || !event_id) throw new Error(`HTTP ${start.status}`);
  const res = await fetch(`${sp.base}/gradio_api/call/${sp.api}/${event_id}`, { headers, signal: AbortSignal.timeout(45_000) });
  const text = await res.text();
  const m = text.match(/event:\s*complete\s*\ndata:\s*(.+)/);
  if (!m) throw new Error((text.match(/event:\s*error\s*\ndata:\s*(.+)/)?.[1] || "no result").slice(0, 120));
  const out = JSON.parse(m[1])[0];
  const url = out?.url || (out?.path && `${sp.base}/gradio_api/file=${out.path}`);
  if (!url) throw new Error("no image url");
  return fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
}

export async function fallbackImage(prompt, gatewayError) {
  const errors = [String(gatewayError || "gateway").slice(0, 80)];
  const seed = Math.floor(Math.random() * 2_000_000_000);
  const enc = encodeURIComponent(prompt);
  const sources = [];
  if (process.env.HF_TOKEN) sources.push(["huggingface", () => fetch("https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell", {
    method: "POST", headers: { Authorization: `Bearer ${process.env.HF_TOKEN}`, "Content-Type": "application/json", Accept: "image/jpeg" },
    body: JSON.stringify({ inputs: prompt, parameters: { seed } }), signal: AbortSignal.timeout(40_000) })]);
  for (const sp of SPACES) sources.push([sp.id, () => runSpace(sp, prompt, seed)]);
  const polHeaders = process.env.POLLINATIONS_API_KEY ? { Authorization: `Bearer ${process.env.POLLINATIONS_API_KEY}` } : {};
  for (const model of ["flux", "turbo"]) sources.push([`pollinations-${model}`, () => fetch(
    `https://image.pollinations.ai/prompt/${enc}?width=1024&height=1024&seed=${seed}&nologo=true&model=${model}&referrer=almajhool-ai.vercel.app`,
    { headers: polHeaders, signal: AbortSignal.timeout(20_000) })]);
  for (const [provider, run] of sources) {
    try {
      const res = await run();
      const mime = (res.headers.get("content-type") || "").split(";")[0];
      if (!res.ok || !mime.startsWith("image/")) { errors.push(`${provider}: HTTP ${res.status}`); continue; }
      const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
      return { image: `data:${mime};base64,${b64}`, model: provider, provider, width: 1024, height: 1024 };
    } catch (e) { errors.push(`${provider}: ${String(e.message).slice(0, 80)}`); }
  }
  throw new Error("تعذّر توليد الصورة الآن، كل المصادر المجانية مشغولة. جرّب بعد دقيقة. (" + errors.join(" · ").slice(0, 300) + ")");
}

