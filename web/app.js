/* المبرمج المجهول AI — لوحة التحكم (بدون مكتبات خارجية) */
"use strict";

// ------------------------------------------------------------------ الإعدادات
const store = {
  get(k, d = "") { try { return localStorage.getItem("almajhool." + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("almajhool." + k, v); } catch { /* تخزين غير متاح */ } },
};
const S = {
  engineUrl: store.get("engineUrl"),
  engineKey: store.get("engineKey"),
  gwUrl: store.get("gwUrl"),
  gwToken: store.get("gwToken"),
};
const state = { engineOk: false, gwOk: false, providers: [], models: [], datasets: [], runs: [], activeRun: null };

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
const fix = (n, d = 4) => (n == null ? "—" : Number(n).toFixed(d));
function bytes(n) {
  if (n == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function shortTokens(n) {
  if (!n) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = "toast"), 3500);
}

// ------------------------------------------------------------------ الاتصال
async function engineFetch(path, opts = {}) {
  if (!S.engineUrl) throw new Error("المحرك غير مضبوط");
  const headers = { ...(opts.headers || {}) };
  if (S.engineKey) headers.Authorization = "Bearer " + S.engineKey;
  if (opts.json !== undefined) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(opts.json); }
  const res = await fetch(S.engineUrl.replace(/\/$/, "") + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
  return data;
}
async function gwFetch(path, body) {
  if (!S.gwUrl) throw new Error("البوابة غير مضبوطة — أضف رابطها في الإعدادات");
  const res = await fetch(S.gwUrl.replace(/\/$/, "") + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + S.gwToken, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** استدعاء نموذج لغوي: engine = "gw:auto" | "gw:groq" | "model:v1.1" | "model:base" */
async function llm(messages, engine, maxTokens = 2048) {
  if (engine.startsWith("model:")) {
    const r = await engineFetch("/v1/chat/completions", {
      method: "POST", json: { model: engine.slice(6), messages, max_tokens: maxTokens, temperature: 0.7 },
    });
    return { text: r.choices[0].message.content, label: "نموذجي " + r.model };
  }
  const r = await gwFetch("/api/chat", { messages, provider: engine.slice(3) || "auto", max_tokens: maxTokens });
  return { text: r.text, label: `${r.provider} · ${r.model}` };
}

async function checkConnections() {
  // إذا كانت اللوحة مخدومة من الباكند نفسه نستخدمه تلقائيًا
  if (!S.engineUrl && !/github\.io$|vercel\.app$/.test(location.hostname) && location.protocol.startsWith("http")) {
    try {
      const r = await fetch("api/health");
      if (r.ok) { S.engineUrl = location.origin + location.pathname.replace(/\/[^/]*$/, ""); }
    } catch { /* لا شيء */ }
  }
  state.engineOk = false; state.gwOk = false;
  if (S.engineUrl) { try { await engineFetch("/api/health"); state.engineOk = true; } catch { } }
  if (S.gwUrl) {
    try { state.providers = await gwFetch("/api/providers"); state.gwOk = true; } catch { state.providers = []; }
  }
  for (const id of ["#dot-engine", "#dot-engine-2"]) $(id).className = "dot " + (S.engineUrl ? (state.engineOk ? "on" : "off") : "");
  for (const id of ["#dot-gateway", "#dot-gateway-2"]) $(id).className = "dot " + (S.gwUrl ? (state.gwOk ? "on" : "off") : "");
  $("#conn-label").textContent = state.engineOk ? "المحرك متصل" : state.gwOk ? "وضع التجربة — البوابة المجانية" : "غير متصل — افتح الإعدادات";
  $("#engine-offline").hidden = state.engineOk;
  $("#engine-dash").hidden = !state.engineOk && state.gwOk;
  $("#img-engine").textContent = state.gwOk ? "عبر البوابة المجانية (Cloudflare)" : "وضع احتياطي (Pollinations)";
  if (state.gwOk) {
    fetch(S.gwUrl + "/api/health").then((r) => r.json()).then((h) => ($("#gw-version").textContent = "v" + h.version)).catch(() => {});
    const sdxl = state.providers.some((p) => p.id === "image-sdxl");
    $("#img-model").querySelector('[value="sdxl"]').disabled = !sdxl;
  }
  renderProviders(); renderUsage();
  await refreshModels();
  fillEngineSelects();
}

function fillEngineSelects() {
  const opts = [];
  if (state.gwOk) {
    opts.push(["gw:auto", "البوابة المجانية — تلقائي"]);
    for (const p of state.providers) if (p.configured && p.kind !== "image" && !p.id.endsWith("-image")) opts.push(["gw:" + p.id, `${p.id} — ${p.model}`]);
  }
  if (state.engineOk) {
    for (const m of [...state.models].reverse()) opts.push(["model:" + m.version, `نموذجي ${m.version}`]);
    opts.push(["model:base", "النموذج الأساسي (قبل التدريب)"]);
  }
  if (!opts.length) opts.push(["", "لا يوجد محرك متصل — افتح الإعدادات"]);
  for (const sel of [$("#chat-engine"), $("#build-engine")]) {
    const cur = sel.value;
    sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
    if (opts.some(([v]) => v === cur)) sel.value = cur;
  }
}

// ------------------------------------------------------------------ التبويبات
function showTab(name) {
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
  if (name === "dashboard" || name === "train" || name === "data") refreshAll();
  window.scrollTo({ top: 0 });
}
$$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-goto]");
  if (g) { e.preventDefault(); showTab(g.dataset.goto); }
});

// ------------------------------------------------------------------ اللوحة
function card(label, value, sub = "") {
  return `<div class="card"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${esc(sub)}</div></div>`;
}
const STATE_AR = { loading: ["تحميل", "b-amber"], training: ["يتدرب", "b-cyan"], saving: ["حفظ", "b-amber"],
  evaluating: ["تقييم", "b-amber"], completed: ["اكتمل", "b-green"], stopped: ["متوقف", "b-muted"],
  failed: ["فشل", "b-red"], interrupted: ["انقطع — قابل للاستكمال", "b-red"] };
const badge = (s) => { const [t, c] = STATE_AR[s] || [s || "—", "b-muted"]; return `<span class="badge ${c}">${esc(t)}</span>`; };

function renderOverview(o) {
  const ds = o?.dataset?.stats || {};
  const run = o?.training?.run;
  const st = run?.status || {};
  const gpu = o?.system?.gpus?.[0];
  $("#stat-cards").innerHTML = [
    card("Tokens الكلي", shortTokens(ds.total_tokens), num(ds.total_tokens)),
    card("ملفات الداتاسيت", num(ds.files), `${num(ds.docs)} مستند`),
    card("حجم الداتاسيت", bytes(ds.bytes), "بعد الترميز"),
    card("إصدار الداتاسيت", o?.dataset?.current_version || "—", `${o?.dataset?.versions || 0} إصدار`),
    card("إصدار النموذج", o?.model?.active || "—", o?.model?.base || ""),
    card("حالة التدريب", (STATE_AR[st.state] || [st.state || "لا يوجد"])[0], run?.run_id || ""),
    card("Training Loss", fix(st.loss), st.eval_loss != null ? `eval ${fix(st.eval_loss)}` : ""),
    card("Steps", st.step != null ? `${num(st.step)} / ${num(st.max_steps)}` : "—", ""),
    card("Epoch", st.epoch != null ? fix(st.epoch, 2) : "—", ""),
    card("Checkpoint الحالي", st.checkpoint || "—", `${o?.checkpoints ?? 0} محفوظ`),
    card("VRAM", gpu ? `${bytes(gpu.vram_used)} / ${bytes(gpu.vram_total)}` : "—", gpu?.name || "لا يوجد GPU"),
    card("RAM", o?.system?.ram ? `${o.system.ram.percent}%` : "—", o?.system?.ram ? bytes(o.system.ram.total) : ""),
  ].join("");
  state.lastMetrics = o?.training?.metrics || [];
  drawLoss(state.lastMetrics);
  $("#loss-meta").textContent = run ? `${run.run_id} → ${run.target_version || ""}` : "";
  renderResources(o?.system);
  renderEvals(o?.evaluations || []);
}

function meter(label, used, total, text) {
  const pct = total ? Math.min(100, (used / total) * 100) : 0;
  return `<div class="meter"><div class="meter-top"><span>${esc(label)}</span><span class="mono">${esc(text)}</span></div><div class="bar"><span style="width:${pct.toFixed(1)}%"></span></div></div>`;
}
function renderResources(sys) {
  if (!sys) { $("#resources").innerHTML = `<p class="muted">يظهر عند اتصال المحرك.</p>`; return; }
  const parts = [];
  for (const g of sys.gpus || []) {
    parts.push(meter(`GPU ${g.name} — ${g.util}% · ${g.temp}°C`, g.vram_used, g.vram_total, `${bytes(g.vram_used)} / ${bytes(g.vram_total)}`));
  }
  if (!(sys.gpus || []).length) parts.push(`<p class="muted">لا يوجد GPU على هذا الجهاز — التدريب يحتاج GPU.</p>`);
  if (sys.ram) parts.push(meter("RAM", sys.ram.used, sys.ram.total, `${bytes(sys.ram.used)} / ${bytes(sys.ram.total)}`));
  if (sys.disk) parts.push(meter("Disk", sys.disk.used, sys.disk.total, `${bytes(sys.disk.used)} / ${bytes(sys.disk.total)}`));
  if (sys.cpu_percent != null) parts.push(meter("CPU", sys.cpu_percent, 100, `${sys.cpu_percent}%`));
  $("#resources").innerHTML = parts.join("");
}
const VERDICT = { improved: ["تحسّن", "b-green"], regressed: ["تراجع", "b-red"], unchanged: ["بلا تغيير", "b-muted"], mixed: ["مختلط", "b-amber"], unknown: ["غير معروف", "b-muted"] };
function renderEvals(list) {
  const pct = (x) => (x == null ? "—" : Math.round(x * 100) + "%");
  $("#eval-table tbody").innerHTML = list.length ? list.map((e) => {
    const [t, c] = VERDICT[e.verdict] || [e.verdict, "b-muted"];
    return `<tr><td class="mono">${esc(e.model_version)}</td><td class="mono">${esc(e.compared_to)}</td>
      <td class="mono">${fix(e.perplexity_before, 2)} → ${fix(e.perplexity_after, 2)}</td>
      <td class="mono">${pct(e.keyword_score_before)} → ${pct(e.keyword_score_after)}</td>
      <td><span class="badge ${c}">${esc(t)}</span></td></tr>`;
  }).join("") : `<tr><td colspan="5" class="muted">لا توجد نتائج بعد — تُحسب تلقائيًا بعد كل تدريب.</td></tr>`;
}

function drawLoss(metrics) {
  const cv = $("#loss-chart"); const ctx = cv.getContext("2d");
  const dpr = window.devicePixelRatio || 1; const w = cv.clientWidth; const h = 220;
  cv.width = w * dpr; cv.height = h * dpr; ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
  const train = metrics.filter((m) => m.loss != null).map((m) => [m.step, m.loss]);
  const evl = metrics.filter((m) => m.eval_loss != null).map((m) => [m.step, m.eval_loss]);
  const all = [...train, ...evl];
  ctx.font = "12px Cairo, sans-serif"; ctx.fillStyle = "#7d8cab";
  if (!all.length) { ctx.textAlign = "center"; ctx.fillText("لا توجد بيانات تدريب بعد", w / 2, h / 2); return; }
  const pad = { l: 44, r: 12, t: 12, b: 24 };
  const xs = all.map((p) => p[0]); const ys = all.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs) || 1, y0 = Math.min(...ys) * 0.95, y1 = Math.max(...ys) * 1.02;
  const X = (x) => pad.l + ((x - x0) / (x1 - x0 || 1)) * (w - pad.l - pad.r);
  const Y = (y) => pad.t + (1 - (y - y0) / (y1 - y0 || 1)) * (h - pad.t - pad.b);
  ctx.strokeStyle = "rgba(0,240,255,.08)"; ctx.lineWidth = 1; ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const yv = y0 + ((y1 - y0) * i) / 4; const yy = Y(yv);
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
    ctx.fillText(yv.toFixed(2), pad.l - 6, yy + 4);
  }
  ctx.textAlign = "center"; ctx.fillText(`step ${x0}`, pad.l + 20, h - 6); ctx.fillText(`step ${x1}`, w - pad.r - 24, h - 6);
  const line = (pts, color) => {
    if (!pts.length) return;
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.shadowColor = color; ctx.shadowBlur = 8; ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)))); ctx.stroke(); ctx.shadowBlur = 0;
    if (pts.length === 1) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(X(pts[0][0]), Y(pts[0][1]), 3, 0, 7); ctx.fill(); }
  };
  line(train, "#00f0ff"); line(evl, "#b026ff");
  ctx.fillStyle = "#00f0ff"; ctx.textAlign = "left"; ctx.fillText("● train", pad.l + 4, pad.t + 10);
  ctx.fillStyle = "#b026ff"; ctx.fillText("● eval", pad.l + 60, pad.t + 10);
}

// ------------------------------------------------------------------ تحديث البيانات
async function refreshModels() {
  if (!state.engineOk) { state.models = []; return; }
  try { state.models = (await engineFetch("/api/models")).versions; } catch { state.models = []; }
}

async function refreshAll() {
  if (!state.engineOk) { renderOverview(null); renderTables(); return; }
  try {
    const [o, ds, runs, ms, bks] = await Promise.all([
      engineFetch("/api/overview"), engineFetch("/api/datasets"), engineFetch("/api/runs"),
      engineFetch("/api/models"), engineFetch("/api/backups"),
    ]);
    state.datasets = ds; state.runs = runs; state.models = ms.versions; state.activeModel = ms.active; state.backups = bks;
    state.activeRun = runs.slice().reverse().find((r) => ["loading", "training", "saving", "evaluating"].includes(r.status?.state)) || null;
    renderOverview(o); renderTables(); fillEngineSelects();
    if (state.activeRun) pollLog();
  } catch (e) { toast("تعذّر تحديث اللوحة: " + e.message, true); }
}

function renderTables() {
  $("#ds-table tbody").innerHTML = state.datasets.length ? state.datasets.slice().reverse().map((v) => `<tr>
    <td class="mono">${esc(v.version)}</td><td class="mono">${esc(v.parent || "—")}</td>
    <td class="mono">${num(v.stats.total_tokens)}</td><td class="mono">${num(v.stats.docs)}</td>
    <td class="mono">${num(v.stats.files)}</td><td class="mono">${bytes(v.stats.bytes)}</td>
    <td class="mono">${esc((v.created || "").slice(0, 16).replace("T", " "))}</td><td>${esc(v.note)}</td></tr>`).join("")
    : `<tr><td colspan="8" class="muted">لا توجد بيانات بعد — أضف أول ملف بالأعلى.</td></tr>`;

  const dsSel = $("#sel-dataset");
  dsSel.innerHTML = state.datasets.slice().reverse().map((v) => `<option value="${esc(v.version)}">${esc(v.version)} — ${shortTokens(v.stats.total_tokens)} tokens</option>`).join("") || `<option value="">لا توجد داتاسيت</option>`;
  const mSel = $("#sel-model");
  mSel.innerHTML = `<option value="">النموذج الأساسي (تدريب جديد)</option>` +
    state.models.slice().reverse().map((m) => `<option value="${esc(m.version)}">مواصلة ${esc(m.version)}</option>`).join("");
  const rSel = $("#sel-resume");
  rSel.innerHTML = `<option value="">تدريب جديد</option>` + state.runs.filter((r) => ["stopped", "interrupted", "failed"].includes(r.status?.state))
    .reverse().map((r) => `<option value="${esc(r.run_id)}">استكمال ${esc(r.run_id)} (${esc(r.status.checkpoint || "بدون checkpoint")})</option>`).join("");

  $("#runs-table tbody").innerHTML = state.runs.length ? state.runs.slice().reverse().map((r) => {
    const s = r.status || {};
    return `<tr><td class="mono">${esc(r.run_id)}</td><td>${badge(s.state)}</td><td class="mono">${num(s.step)} / ${num(s.max_steps)}</td>
    <td class="mono">${fix(s.loss)}</td><td class="mono">${esc(r.dataset_version || "")}</td><td class="mono">${esc(s.model_version || r.target_version || "")}</td>
    <td>${s.error ? `<span class="b-red" title="${esc(s.error)}">⚠</span>` : ""}</td></tr>`;
  }).join("") : `<tr><td colspan="7" class="muted">لا توجد عمليات تدريب بعد.</td></tr>`;

  $("#models-table tbody").innerHTML = state.models.length ? state.models.slice().reverse().map((m) => {
    const [t, c] = VERDICT[m.eval?.verdict] || ["—", "b-muted"];
    const act = m.version === state.activeModel;
    return `<tr><td class="mono">${esc(m.version)} ${act ? '<span class="badge b-cyan">نشط</span>' : ""}</td>
    <td class="mono">${esc(m.parent || "base")}</td><td class="mono">${esc(m.dataset_version)}</td>
    <td class="mono">${fix(m.final_eval_loss)}</td><td><span class="badge ${c}">${esc(t)}</span></td>
    <td>${act ? "" : `<button class="btn small" data-activate="${esc(m.version)}">تفعيل</button>`}</td></tr>`;
  }).join("") : `<tr><td colspan="6" class="muted">لا توجد إصدارات بعد.</td></tr>`;

  $("#backups-table tbody").innerHTML = (state.backups || []).length ? state.backups.slice().reverse().map((b) => `<tr>
    <td class="mono">${esc(b.archive)}</td><td class="mono">${bytes(b.bytes)}</td>
    <td><button class="btn small" data-restore="${esc(b.archive)}">استعادة</button></td></tr>`).join("")
    : `<tr><td colspan="3" class="muted">لا توجد نسخ بعد.</td></tr>`;

  $("#btn-stop").hidden = !state.activeRun;
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-activate]");
  if (a) {
    try { await engineFetch(`/api/models/${a.dataset.activate}/activate`, { method: "POST" }); toast("تم التفعيل"); refreshAll(); }
    catch (err) { toast(err.message, true); }
  }
  const r = e.target.closest("[data-restore]");
  if (r && confirm(`استعادة ${r.dataset.restore}؟ الحالة الحالية تُحفظ بمجلد منفصل ولا تُحذف.`)) {
    try { const res = await engineFetch(`/api/backups/${r.dataset.restore}/restore`, { method: "POST" }); toast("تمت الاستعادة — الحالة السابقة: " + res.previous_state_saved_to); refreshAll(); }
    catch (err) { toast(err.message, true); }
  }
});

$("#btn-backup").addEventListener("click", async () => {
  try { const j = await engineFetch("/api/backups", { method: "POST" }); toast("بدأ إنشاء النسخة…"); waitJob(j.job_id, null, () => refreshAll()); }
  catch (e) { toast(e.message, true); }
});

// ------------------------------------------------------------------ رفع البيانات
const fileInput = $("#file-input"); const drop = $("#drop");
fileInput.addEventListener("change", () => ($("#file-names").textContent = [...fileInput.files].map((f) => `${f.name} (${bytes(f.size)})`).join(" · ")));
["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("over")));
drop.addEventListener("drop", (e) => { e.preventDefault(); fileInput.files = e.dataTransfer.files; fileInput.dispatchEvent(new Event("change")); });

function waitJob(id, logEl, done) {
  const tick = async () => {
    try {
      const j = await engineFetch("/api/jobs/" + id);
      if (logEl) logEl.textContent = JSON.stringify(j.report || j.progress || j, null, 2);
      if (j.state === "done") { toast("اكتمل ✓"); done && done(j); return; }
      if (j.state === "failed") { toast("فشل: " + j.error, true); return; }
    } catch (e) { if (logEl) logEl.textContent = e.message; }
    setTimeout(tick, 1500);
  };
  tick();
}

$("#btn-upload").addEventListener("click", async () => {
  if (!state.engineOk) return toast("المحرك غير متصل — شغّل الباكند أولًا", true);
  if (!fileInput.files.length) return toast("اختر ملفات أولًا", true);
  const fd = new FormData();
  for (const f of fileInput.files) fd.append("files", f);
  fd.append("note", $("#data-note").value);
  const log = $("#upload-log"); log.hidden = false; log.textContent = "جارٍ الرفع…";
  try {
    const j = await engineFetch("/api/datasets/upload", { method: "POST", body: fd });
    log.textContent = "تم الرفع — جارٍ التنظيف وإزالة التكرار والترميز…";
    waitJob(j.job_id, log, () => { fileInput.value = ""; $("#file-names").textContent = ""; refreshAll(); });
  } catch (e) { log.textContent = e.message; toast(e.message, true); }
});

// ------------------------------------------------------------------ التدريب
$("#train-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.engineOk) return toast("المحرك غير متصل", true);
  const f = new FormData(e.target); const body = {};
  for (const [k, v] of f.entries()) if (v !== "") body[k] = ["epochs", "learning_rate"].includes(k) ? parseFloat(v) : /^\d+$/.test(v) ? parseInt(v) : v;
  const payload = body.resume_run ? { resume_run: body.resume_run } : body;
  try {
    const r = await engineFetch("/api/train", { method: "POST", json: payload });
    toast("بدأ التدريب: " + r.run_id + (r.gpus > 1 ? ` على ${r.gpus} GPUs` : ""));
    setTimeout(refreshAll, 1500);
  } catch (err) { toast(err.message, true); }
});
$("#btn-stop").addEventListener("click", async () => {
  if (!state.activeRun) return;
  await engineFetch(`/api/train/${state.activeRun.run_id}/stop`, { method: "POST" });
  toast("سيُحفظ checkpoint ثم يتوقف التدريب");
});
async function pollLog() {
  if (!state.activeRun) return;
  try {
    const r = await engineFetch(`/api/train/${state.activeRun.run_id}/log?tail=60`);
    const el = $("#train-log"); el.hidden = false; el.textContent = r.log; el.scrollTop = el.scrollHeight;
  } catch { }
}

// ------------------------------------------------------------------ عداد التوكنات
const today = () => new Date().toISOString().slice(0, 10);
const usage = (() => {
  let u = {};
  try { u = JSON.parse(store.get("usage", "{}")) || {}; } catch { u = {}; }
  if (u.day !== today()) u = { ...u, day: today(), today: 0, reqToday: 0, imgToday: 0 };
  return Object.assign({ total: 0, requests: 0, images: 0, sites: 0, today: 0, reqToday: 0, imgToday: 0 }, u);
})();
const estTokens = (s) => Math.ceil(String(s || "").length / 3.2);
function addUsage({ tokens = 0, requests = 0, images = 0, sites = 0 }) {
  if (usage.day !== today()) Object.assign(usage, { day: today(), today: 0, reqToday: 0, imgToday: 0 });
  usage.today += tokens; usage.total += tokens; usage.requests += requests; usage.reqToday += requests;
  usage.images += images; usage.imgToday += images; usage.sites += sites;
  store.set("usage", JSON.stringify(usage));
  renderUsage();
}
function renderUsage() {
  $("#usage-chip").textContent = "⚡ " + shortTokens(usage.today);
  if (!$("#usage-cards")) return;
  $("#usage-cards").innerHTML = [
    card("توكنات اليوم", shortTokens(usage.today), num(usage.today)),
    card("توكنات الكلي", shortTokens(usage.total), num(usage.total)),
    card("طلبات اليوم", num(usage.reqToday), `${num(usage.requests)} الكلي`),
    card("صور اليوم", num(usage.imgToday), `${num(usage.images)} الكلي`),
    card("مواقع مبنية", num(usage.sites), ""),
    card("المزودات النشطة", String(state.providers.filter((p) => p.configured && p.kind === "text").length), "نصية"),
  ].join("");
  const pct = Math.min(100, (usage.today / 1e7) * 100);
  $("#budget-bar").style.width = pct.toFixed(2) + "%";
  $("#budget-text").textContent = `${num(usage.today)} / 10,000,000`;
}
// سعة يومية تقريبية لكل مزود مجاني — للعرض فقط، الأرقام الرسمية تتغير
const CAPACITY = { cerebras: "≈1M توكن/يوم", groq: "≈200K توكن/يوم", gemini: "≈250–1500 طلب/يوم",
  openrouter: "50 طلب/يوم (1000 مع شحن 10$)", "workers-ai": "≈10K neurons/يوم", "image-flux": "ضمن حصة Cloudflare", "image-sdxl": "ضمن حصة Cloudflare" };
function renderProviders() {
  $("#gw-panel").hidden = !state.gwOk;
  if (!state.gwOk) return;
  $("#provider-list").innerHTML = state.providers.map((p) => `<div class="prov ${p.configured ? "ok" : ""}">
    <span class="dot ${p.configured ? "on" : ""}"></span><b>${esc(p.id)}</b>
    <span class="muted mono">${esc(p.model)}</span><small class="muted">${esc(CAPACITY[p.id] || "")}${p.configured ? "" : " — أضف المفتاح لتفعيله"}</small></div>`).join("");
}

// ------------------------------------------------------------------ البث (Streaming)
/** يقرأ SSE بصيغة OpenAI. onDelta(textSoFar, piece, thinking) */
async function readSSE(res, onDelta) {
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = "", text = "", finish = null, usageInfo = null, thinking = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const data = s.slice(5).trim();
      if (data === "[DONE]") continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      if (j.usage) usageInfo = j.usage;
      const ch = j.choices?.[0];
      if (!ch) continue;
      if (ch.finish_reason) finish = ch.finish_reason;
      const piece = ch.delta?.content || "";
      const reasoning = ch.delta?.reasoning || ch.delta?.reasoning_content;
      if (piece) { text += piece; thinking = false; onDelta?.(text, piece, false); }
      else if (reasoning && !thinking) { thinking = true; onDelta?.(text, "", true); }
    }
  }
  return { text, finish, usage: usageInfo };
}

/** استدعاء نموذج مع بث: engine = "gw:auto" | "gw:groq" | "model:v1.1" */
async function llmStream(messages, engine, { maxTokens = 4096, onDelta, signal, temperature } = {}) {
  let res, label;
  if (engine.startsWith("model:")) {
    const headers = { "Content-Type": "application/json" };
    if (S.engineKey) headers.Authorization = "Bearer " + S.engineKey;
    res = await fetch(S.engineUrl + "/v1/chat/completions", { method: "POST", headers, signal,
      body: JSON.stringify({ model: engine.slice(6), messages, max_tokens: maxTokens, temperature: temperature ?? 0.7, stream: true }) });
    label = "نموذجي " + engine.slice(6);
  } else {
    if (!S.gwUrl) throw new Error("البوابة غير مضبوطة — أضف رابطها في الإعدادات");
    res = await fetch(S.gwUrl + "/api/chat", { method: "POST", signal,
      headers: { Authorization: "Bearer " + S.gwToken, "Content-Type": "application/json" },
      body: JSON.stringify({ messages, provider: engine.slice(3) || "auto", max_tokens: maxTokens, temperature, stream: true }) });
  }
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || e.detail || `HTTP ${res.status}`);
  }
  const ctype = res.headers.get("content-type") || "";
  let out;
  if (ctype.includes("event-stream")) out = await readSSE(res, onDelta);
  else { // بوابة قديمة (v1) لا تدعم البث
    const j = await res.json(); out = { text: j.text, finish: j.finish_reason, usage: j.usage }; onDelta?.(out.text, out.text, false);
  }
  if (!label) label = `${res.headers.get("x-provider") || "gateway"} · ${res.headers.get("x-model") || ""}`;
  const tokens = out.usage?.total_tokens || estTokens(messages.map((m) => m.content).join("")) + estTokens(out.text);
  addUsage({ tokens, requests: 1 });
  return { ...out, label };
}

// ------------------------------------------------------------------ Markdown
function md(text) {
  const parts = String(text).split(/```(\w*)\n?([\s\S]*?)(?:```|$)/g);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 0) {
      out += esc(parts[i])
        .replace(/^### (.*)$/gm, "<h4>$1</h4>").replace(/^## (.*)$/gm, "<h3>$1</h3>").replace(/^# (.*)$/gm, "<h3>$1</h3>")
        .replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
        .replace(/^\s*[-*] (.*)$/gm, "• $1").replace(/\n/g, "<br>");
    } else if (i % 3 === 2) {
      const lang = parts[i - 1] || "code";
      out += `<div class="codebox"><div class="codebar"><span>${esc(lang)}</span><button class="copy-code" type="button">نسخ</button></div><pre>${esc(parts[i])}</pre></div>`;
    }
  }
  return out;
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest(".copy-code");
  if (!b) return;
  try { await navigator.clipboard.writeText(b.closest(".codebox").querySelector("pre").textContent); b.textContent = "✓ تم"; setTimeout(() => (b.textContent = "نسخ"), 1500); }
  catch { toast("تعذّر النسخ", true); }
});

// ------------------------------------------------------------------ الدردشة
const MODES = {
  general: "أنت «المبرمج المجهول AI»، مساعد ذكي يتحدث العربية (واللهجة العراقية عند الحاجة) والإنجليزية. أجب بدقة ووضوح وبلغة السؤال، ونظّم الإجابة بعناوين ونقاط عند الحاجة.",
  coder: "أنت «المبرمج المجهول AI» بوضع المبرمج الخبير. اكتب كودًا كاملًا جاهزًا للتشغيل بدون اختصارات أو TODO، مع شرح مختصر بالعربية، واستخدم أفضل الممارسات والأمان.",
  security: "أنت «المبرمج المجهول AI» بوضع خبير الأمن السيبراني الدفاعي. ساعد في حماية الحسابات والأنظمة، شرح الثغرات وطرق الوقاية، والاستجابة للحوادث. لا تساعد في اختراق حسابات أو أنظمة الآخرين.",
  social: "أنت «المبرمج المجهول AI» بوضع خبير المحتوى والسوشيال ميديا. اكتب أفكار وسكربتات وكابشنات جذابة لتيك توك وانستغرام ويوتيوب، مع هاشتاغات وتوقيت نشر مناسب.",
  translator: "أنت مترجم محترف. ترجم النص بين العربية والإنجليزية (أو اللغة المطلوبة) بدقة وأسلوب طبيعي، وأعطِ الترجمة فقط ما لم يُطلب شرح.",
  teacher: "أنت «المبرمج المجهول AI» بوضع المعلّم. اشرح خطوة بخطوة بأمثلة بسيطة، ثم لخّص بنقاط، واطرح سؤالًا قصيرًا للتأكد من الفهم.",
};
const chats = (() => { try { return JSON.parse(store.get("chats", "[]")) || []; } catch { return []; } })();
let currentChat = null, chatAbort = null;
function saveChats() {
  while (chats.length > 40) chats.shift();
  for (let i = 0; i < chats.length; i++) {
    try { store.set("chats", JSON.stringify(chats)); return; } catch { chats.shift(); }
  }
}
function newChat() {
  currentChat = { id: Date.now().toString(36), title: "محادثة جديدة", mode: $("#chat-mode").value || "general", messages: [] };
  chats.push(currentChat); saveChats(); renderChatList(); renderChat();
}
function renderChatList() {
  $("#chat-list").innerHTML = chats.slice().reverse().map((c) => `<option value="${c.id}">${esc(c.title)}</option>`).join("");
  if (currentChat) $("#chat-list").value = currentChat.id;
}
function renderChat() {
  const log = $("#chat-log"); log.innerHTML = "";
  if (!currentChat.messages.length) {
    addMsg("assistant", md("أهلًا! أنا **المبرمج المجهول AI** 👋\nاختار الوضع اللي يناسبك من فوق، واسألني أي شي — برمجة، أمن رقمي، محتوى، ترجمة."));
  }
  for (const m of currentChat.messages) addMsg(m.role, m.role === "user" ? esc(m.content).replace(/\n/g, "<br>") : md(m.content), m.meta);
  $("#chat-mode").value = currentChat.mode || "general";
  $("#chat-suggestions").hidden = currentChat.messages.length > 0;
}
function addMsg(role, html, meta = "") {
  const d = document.createElement("div"); d.className = "msg " + role;
  d.innerHTML = `<div class="bubble"><div class="content">${html}</div>${meta ? `<span class="meta">${esc(meta)}</span>` : ""}</div>`;
  $("#chat-log").appendChild(d); $("#chat-log").scrollTop = 1e9; return d;
}
$("#chat-list").addEventListener("change", (e) => { currentChat = chats.find((c) => c.id === e.target.value); renderChat(); });
$("#btn-new-chat").addEventListener("click", newChat);
$("#btn-del-chat").addEventListener("click", () => {
  if (!confirm("حذف هذه المحادثة؟")) return;
  chats.splice(chats.indexOf(currentChat), 1); saveChats();
  if (!chats.length) newChat(); else { currentChat = chats[chats.length - 1]; renderChatList(); renderChat(); }
});
$("#chat-mode").addEventListener("change", (e) => { currentChat.mode = e.target.value; saveChats(); });
$("#chat-suggestions").addEventListener("click", (e) => {
  const b = e.target.closest("[data-q]"); if (!b) return;
  $("#chat-text").value = b.dataset.q; $("#chat-form").requestSubmit();
});

async function sendChat(text) {
  const engine = $("#chat-engine").value; if (!engine) return toast("اضبط البوابة أو المحرك في الإعدادات", true);
  if (!currentChat.messages.length) currentChat.title = text.slice(0, 40);
  currentChat.messages.push({ role: "user", content: text }); saveChats(); renderChatList();
  addMsg("user", esc(text).replace(/\n/g, "<br>"));
  $("#chat-suggestions").hidden = true;
  const bubble = addMsg("assistant", '<span class="typing"></span>');
  const content = bubble.querySelector(".content");
  const btn = $("#btn-send"); btn.textContent = "■ إيقاف"; btn.classList.add("danger");
  chatAbort = new AbortController();
  let partial = "";
  try {
    const sys = { role: "system", content: MODES[currentChat.mode] || MODES.general };
    const history = currentChat.messages.slice(-24).map(({ role, content }) => ({ role, content }));
    let raf = 0;
    const r = await llmStream([sys, ...history], engine, {
      maxTokens: 8192, signal: chatAbort.signal,
      onDelta: (t, _p, thinking) => {
        partial = t;
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          content.innerHTML = thinking && !t ? '<span class="muted">🤔 يفكّر…</span>' : md(t) + '<span class="typing"></span>';
          $("#chat-log").scrollTop = 1e9;
        });
      },
    });
    cancelAnimationFrame(raf);
    const meta = r.label + (r.finish === "length" ? " · (انقطع — اكتب «كمّل»)" : "");
    currentChat.messages.push({ role: "assistant", content: r.text, meta });
    content.innerHTML = md(r.text);
    bubble.querySelector(".bubble").insertAdjacentHTML("beforeend", `<span class="meta">${esc(meta)}</span>`);
  } catch (err) {
    if (err.name === "AbortError") {
      if (partial) currentChat.messages.push({ role: "assistant", content: partial, meta: "أُوقف" });
      content.innerHTML = md(partial || "") + '<span class="meta">أُوقف</span>';
    } else {
      content.innerHTML = `<span class="b-red">${esc(err.message)}</span>`;
      currentChat.messages.pop();
    }
  }
  saveChats();
  chatAbort = null; btn.textContent = "إرسال"; btn.classList.remove("danger");
  $("#chat-log").scrollTop = 1e9;
}
$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (chatAbort) { chatAbort.abort(); return; }
  const ta = $("#chat-text"); const text = ta.value.trim(); if (!text) return;
  ta.value = ""; ta.style.height = "";
  sendChat(text);
});
$("#chat-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#chat-form").requestSubmit(); }
});
$("#chat-text").addEventListener("input", (e) => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px"; });

// ------------------------------------------------------------------ الصور
const gallery = (() => { try { return JSON.parse(store.get("gallery", "[]")) || []; } catch { return []; } })();
function saveGallery() {
  while (gallery.length > 12) gallery.pop();
  while (gallery.length) {
    try { store.set("gallery", JSON.stringify(gallery)); return; } catch { gallery.pop(); }
  }
  store.set("gallery", "[]");
}
function shotEl(item) {
  const box = document.createElement("div"); box.className = "shot";
  box.innerHTML = `<img alt="${esc(item.prompt)}" src="${item.src}" loading="lazy" style="aspect-ratio:${item.w || 1}/${item.h || 1}">
    <div class="cap"><span title="${esc(item.prompt)}">${esc(item.prompt)}</span>
    <a href="${item.src}" download="almajhool-ai-${Date.now()}.${item.src.startsWith("data:image/png") ? "png" : "jpg"}" title="تحميل">⬇</a></div>`;
  box.querySelector("img").addEventListener("click", () => window.open(URL.createObjectURL(dataUrlToBlob(item.src)), "_blank", "noopener"));
  return box;
}
function dataUrlToBlob(u) {
  if (!u.startsWith("data:")) return new Blob([u]);
  const [meta, b64] = u.split(","); const bin = atob(b64); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: meta.slice(5, meta.indexOf(";")) });
}
function renderGallery() { const g = $("#gallery"); g.innerHTML = ""; gallery.forEach((it) => g.appendChild(shotEl(it))); }
$("#img-model").addEventListener("change", () => { $("#img-size").disabled = $("#img-model").value !== "sdxl"; });
$("#img-size").disabled = true;
$("#btn-clear-gallery").addEventListener("click", () => { if (confirm("مسح كل الصور من المعرض؟")) { gallery.length = 0; saveGallery(); renderGallery(); } });

$("#img-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  let prompt = $("#img-prompt").value.trim(); if (!prompt) return;
  const model = $("#img-model").value, count = +$("#img-count").value, style = $("#img-style").value;
  const [w, h] = model === "sdxl" ? $("#img-size").value.split("x").map(Number) : [1, 1];
  const btn = $("#btn-img"); btn.disabled = true;
  const placeholders = Array.from({ length: count }, () => {
    const b = document.createElement("div"); b.className = "shot loading"; b.style.aspectRatio = `${w}/${h}`;
    b.innerHTML = '<span class="spinner"></span>'; $("#gallery").prepend(b); return b;
  });
  try {
    if ($("#img-translate").checked && state.gwOk) {
      try {
        const r = await llmStream([{ role: "system", content: "Rewrite the user's image idea as one vivid, specific English prompt for a text-to-image model (max 70 words). Keep any text the user wants written in the image in quotes. Output only the prompt." }, { role: "user", content: prompt }], "gw:auto", { maxTokens: 300 });
        if (r.text.trim()) prompt = r.text.trim().replace(/^["']|["']$/g, "");
      } catch { /* نكمل بالوصف الأصلي */ }
    }
    const full = style ? `${prompt}, ${style}` : prompt;
    await Promise.all(placeholders.map(async (box, i) => {
      try {
        let src;
        if (state.gwOk) {
          src = (await gwFetch("/api/image", { prompt: full, model, width: w, height: h, negative_prompt: "blurry, low quality, watermark, deformed" })).image;
        } else {
          src = `https://image.pollinations.ai/prompt/${encodeURIComponent(full)}?width=${w > 1 ? w : 1024}&height=${h > 1 ? h : 1024}&nologo=true&seed=${Date.now() % 1e6 + i}`;
          await new Promise((ok, bad) => { const im = new Image(); im.onload = ok; im.onerror = () => bad(new Error("تعذّر تحميل الصورة")); im.src = src; });
        }
        const item = { src, prompt: full, w, h, t: Date.now() };
        gallery.unshift(item);
        box.replaceWith(shotEl(item));
        addUsage({ images: 1 });
      } catch (err) { box.innerHTML = `<span class="b-red small">${esc(err.message)}</span>`; }
    }));
    saveGallery();
  } finally { btn.disabled = false; }
});

// ------------------------------------------------------------------ بناء المواقع
const KIND = {
  website: "a complete, multi-section, production-ready website",
  webapp: "a mobile-first web application with real, fully working functionality and persistent state (localStorage)",
  game: "a fully playable, polished browser game with touch AND keyboard controls, score, levels and game-over/restart",
  dashboard: "a rich admin/analytics dashboard with charts drawn on <canvas> (no chart libraries needed) and realistic sample data",
  landing: "a high-converting landing page with hero, features, social proof, FAQ and clear call-to-action",
};
const build = (() => {
  let saved = {}; try { saved = JSON.parse(store.get("build", "{}")) || {}; } catch { }
  return { versions: saved.versions || [], idx: saved.idx ?? -1, abort: null };
})();
const currentCode = () => build.versions[build.idx]?.code || "";
function saveBuild() {
  const keep = build.versions.slice(-8);
  const idx = Math.min(build.idx, keep.length - 1);
  try { store.set("build", JSON.stringify({ versions: keep, idx })); } catch { try { store.set("build", JSON.stringify({ versions: keep.slice(-2), idx: Math.min(idx, 1) })); } catch { } }
}
function extractHtml(text) {
  const m = text.match(/```(?:html)?\s*([\s\S]*?)(?:```|$)/i);
  let code = m ? m[1] : text;
  const i = code.search(/<!doctype html|<html/i);
  if (i > 0) code = code.slice(i);
  return code.trim();
}
function setPreview() {
  const code = currentCode();
  $("#preview").srcdoc = code;
  $("#code-view").textContent = code;
  for (const id of ["#btn-download", "#btn-copy", "#btn-newtab"]) $(id).disabled = !code;
  $("#btn-undo").disabled = build.idx <= 0;
  $("#btn-redo").disabled = build.idx >= build.versions.length - 1;
  $("#build-meta").textContent = code ? `${(code.length / 1024).toFixed(1)} KB · ${code.split("\n").length} سطر` : "";
  $("#build-version").textContent = build.versions.length ? `الإصدار ${build.idx + 1} / ${build.versions.length}` : "";
  $("#btn-build").textContent = code ? "✎ عدّل" : "⌘ ابنِ";
  $("#build-prompt").placeholder = code ? "اكتب التعديل المطلوب… مثال: أضف وضع فاتح وزر واتساب عائم" : "صف المشروع…";
}
$("#build-templates").addEventListener("click", (e) => {
  const b = e.target.closest("[data-q]"); if (!b) return;
  if (currentCode() && !confirm("هذا يبدأ مشروع جديد. متأكد؟")) return;
  build.versions = []; build.idx = -1; setPreview();
  $("#build-kind").value = b.dataset.kind; $("#build-prompt").value = b.dataset.q; $("#build-form").requestSubmit();
});

$("#build-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (build.abort) { build.abort.abort(); return; }
  const req = $("#build-prompt").value.trim(); if (!req) return;
  const engine = $("#build-engine").value; if (!engine) return toast("اضبط البوابة أو المحرك في الإعدادات", true);
  const kind = $("#build-kind").value; const budget = +$("#build-size").value;
  const system = `You are a world-class front-end engineer and UI designer. Build ${KIND[kind]}.
Rules:
- Output ONE complete self-contained HTML file inside a single \`\`\`html code block — inline <style> and <script>, no build step.
- Production quality: responsive (mobile first), accessible, modern polished design with smooth micro-interactions, real working features (no placeholder TODOs, no lorem ipsum unless asked).
- If the request is in Arabic, all UI text must be Arabic with dir="rtl" and the "Cairo" font from Google Fonts.
- External resources only from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, fonts.googleapis.com. Use https://picsum.photos/seed/<word>/W/H for images.
- Do not explain anything — output only the code block.`;
  const code = currentCode();
  const base = code
    ? [{ role: "system", content: system }, { role: "user", content: `Current file:\n\`\`\`html\n${code}\n\`\`\`\nApply this change and return the FULL updated file: ${req}` }]
    : [{ role: "system", content: system }, { role: "user", content: req }];
  const btn = $("#btn-build"); btn.textContent = "■ إيقاف"; btn.classList.add("danger");
  build.abort = new AbortController();
  let full = "", label = "", rounds = 0;
  const status = $("#build-status");
  try {
    let messages = base;
    for (;;) {
      rounds++;
      const r = await llmStream(messages, engine, {
        maxTokens: Math.min(budget, 32000), signal: build.abort.signal, temperature: 0.4,
        onDelta: (t, _p, thinking) => {
          status.textContent = thinking && !t ? "🤔 يخطط للمشروع…" : `✍ يكتب الكود… ${(full.length + t.length).toLocaleString("en-US")} حرف${rounds > 1 ? ` (جزء ${rounds})` : ""}`;
        },
      });
      full += r.text; label = r.label;
      // إكمال تلقائي إذا انقطع الكود بسبب حد التوكنات
      const unfinished = r.finish === "length" || (!/<\/html>\s*(```)?\s*$/i.test(full.trim()) && /<html|<!doctype/i.test(full));
      if (!unfinished || rounds >= 6 || full.length > budget * 4) break;
      status.textContent = `↻ الكود طويل — أكمل الجزء ${rounds + 1}…`;
      messages = [...base, { role: "assistant", content: full },
        { role: "user", content: "Continue EXACTLY from where you stopped. Do not repeat anything and do not restart the code block — output only the remaining code." }];
    }
    let html = extractHtml(full);
    if (!/<html|<body|<div/i.test(html)) throw new Error("النموذج لم يرجع HTML صالحًا — جرّب محركًا آخر");
    if (!/<\/html>/i.test(html)) html += "\n</body></html>";
    build.versions = build.versions.slice(0, build.idx + 1);
    build.versions.push({ req, code: html, t: Date.now() });
    build.idx = build.versions.length - 1;
    saveBuild(); setPreview(); addUsage({ sites: 1 });
    $("#build-prompt").value = "";
    status.textContent = `✓ ${label}${rounds > 1 ? ` · ${rounds} أجزاء` : ""}`;
  } catch (err) {
    status.innerHTML = err.name === "AbortError" ? "أُوقف البناء." : `<span class="b-red">${esc(err.message)}</span>`;
  }
  build.abort = null; btn.classList.remove("danger"); setPreview();
});
$("#btn-undo").addEventListener("click", () => { if (build.idx > 0) { build.idx--; saveBuild(); setPreview(); } });
$("#btn-redo").addEventListener("click", () => { if (build.idx < build.versions.length - 1) { build.idx++; saveBuild(); setPreview(); } });
$$("#tab-builder .preview-panel .seg:not(#device-seg) button").forEach((b) => b.addEventListener("click", () => {
  $$("#tab-builder .preview-panel .seg:not(#device-seg) button").forEach((x) => x.classList.toggle("active", x === b));
  const isCode = b.dataset.view === "code";
  $(".frame-wrap").hidden = isCode; $("#code-view").hidden = !isCode;
}));
$$("#device-seg button").forEach((b) => b.addEventListener("click", () => {
  $$("#device-seg button").forEach((x) => x.classList.toggle("active", x === b));
  $("#preview").style.maxWidth = b.dataset.device;
}));
$("#btn-download").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([currentCode()], { type: "text/html" }));
  a.download = "almajhool-project.html"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$("#btn-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(currentCode()); toast("تم نسخ الكود"); } catch { toast("تعذّر النسخ", true); }
});
$("#btn-newtab").addEventListener("click", () => {
  window.open(URL.createObjectURL(new Blob([currentCode()], { type: "text/html" })), "_blank", "noopener");
});
$("#btn-reset").addEventListener("click", () => {
  if (currentCode() && !confirm("بدء مشروع جديد؟ الإصدارات الحالية تنمسح.")) return;
  build.versions = []; build.idx = -1; saveBuild(); setPreview(); $("#build-status").textContent = "";
});

// ------------------------------------------------------------------ الإعدادات
$("#set-engine-url").value = S.engineUrl; $("#set-engine-key").value = S.engineKey;
$("#set-gw-url").value = S.gwUrl; $("#set-gw-token").value = S.gwToken;
$("#btn-save").addEventListener("click", async () => {
  S.engineUrl = $("#set-engine-url").value.trim().replace(/\/$/, "");
  S.engineKey = $("#set-engine-key").value.trim();
  S.gwUrl = $("#set-gw-url").value.trim().replace(/\/$/, "");
  S.gwToken = $("#set-gw-token").value.trim();
  for (const k of Object.keys(S)) store.set(k, S[k]);
  const log = $("#settings-log"); log.hidden = false; log.textContent = "جارٍ الاختبار…";
  await checkConnections();
  log.textContent = [
    `Engine:  ${S.engineUrl ? (state.engineOk ? "connected ✓" : "unreachable ✗") : "not set"}`,
    `Gateway: ${S.gwUrl ? (state.gwOk ? "connected ✓" : "unreachable / wrong token ✗") : "not set"}`,
    ...state.providers.map((p) => `  ${p.configured ? "✓" : "✗"} ${p.id} — ${p.model}`),
  ].join("\n");
  refreshAll();
});

// ------------------------------------------------------------------ التشغيل
setPreview();
renderGallery();
renderUsage();
if (chats.length) { currentChat = chats[chats.length - 1]; renderChatList(); renderChat(); } else newChat();
checkConnections().then(refreshAll);
setInterval(() => {
  const active = $(".tab.active")?.id;
  if (state.engineOk && ["tab-dashboard", "tab-train"].includes(active)) refreshAll();
}, 8000);
window.addEventListener("resize", () => drawLoss(state.lastMetrics || []));
