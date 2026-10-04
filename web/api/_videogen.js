// إنشاء مقاطع فيديو بالذكاء الاصطناعي من وصف (مجاني عبر مساحات Hugging Face — Gradio)
const spaceHost = (id) => `https://${id.toLowerCase().replace(/[/._]/g, "-")}.hf.space`;

/** يشغّل مساحة Gradio: أول خانة نص = الوصف، الصورة (إذا اكو) بأول خانة صورة، والباقي قيمها الافتراضية. يرجع رابط الملف الناتج */
export async function gradioRun(space, { prompt, image, overrides = {}, timeout = 280_000 }) {
  const base = spaceHost(space);
  const auth = process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {};
  const info = await (await fetch(`${base}/gradio_api/info`, { headers: auth, signal: AbortSignal.timeout(20_000) })).json();
  const eps = Object.entries(info.named_endpoints || {});
  const [ep, spec] = eps.find(([name]) => /generate|infer|run|predict|text_to_video|t2v/i.test(name)) || eps[0] || [];
  if (!ep) throw new Error("no endpoint");
  let file = null;
  if (image) {
    const fd = new FormData();
    fd.append("files", new Blob([image.bytes], { type: image.mime }), "image.png");
    const [path] = await (await fetch(`${base}/gradio_api/upload`, { method: "POST", headers: auth, body: fd, signal: AbortSignal.timeout(30_000) })).json();
    file = { path, meta: { _type: "gradio.FileData" }, orig_name: "image.png", mime_type: image.mime };
  }
  let textUsed = false;
  const args = (spec.parameters || []).map((p) => {
    const comp = String(p.component || "").toLowerCase(), name = String(p.parameter_name || p.label || "").toLowerCase();
    for (const [re, v] of Object.entries(overrides)) if (new RegExp(re, "i").test(name)) return v;
    if (comp.includes("image")) return file;
    if (comp === "textbox" && !/negative/.test(name) && !textUsed) { textUsed = true; return prompt; }
    return p.parameter_default ?? null;
  });
  const start = await fetch(`${base}/gradio_api/call/${ep.replace(/^\//, "")}`, {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ data: args }), signal: AbortSignal.timeout(20_000) });
  const { event_id } = await start.json().catch(() => ({}));
  if (!event_id) throw new Error(`call ${start.status}`);
  const stream = await (await fetch(`${base}/gradio_api/call/${ep.replace(/^\//, "")}/${event_id}`, { headers: auth, signal: AbortSignal.timeout(timeout) })).text();
  const done = [...stream.matchAll(/event:\s*complete\s*\ndata:\s*(.+)/g)].pop();
  if (!done) throw new Error((stream.match(/event:\s*error\s*\ndata:\s*(.+)/)?.[1] || "no result").slice(0, 200));
  const find = (v) => {
    if (!v) return null;
    if (Array.isArray(v)) { for (const x of v) { const f = find(x); if (f) return f; } return null; }
    if (typeof v === "object") return v.url || (v.path && `${base}/gradio_api/file=${v.path}`) || find(v.video) || find(v.value);
    return null;
  };
  const url = find(JSON.parse(done[1]));
  if (!url) throw new Error("no file in result: " + done[1].slice(0, 160));
  return { url, auth, endpoint: ep };
}
