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
  if (!S.engineUrl && !location.hostname.endsWith("github.io") && location.protocol.startsWith("http")) {
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
  $("#img-engine").textContent = state.gwOk ? "FLUX عبر البوابة المجانية" : "وضع احتياطي (Pollinations)";
  await refreshModels();
  fillEngineSelects();
}

function fillEngineSelects() {
  const opts = [];
  if (state.gwOk) {
    opts.push(["gw:auto", "البوابة المجانية — تلقائي"]);
    for (const p of state.providers) if (p.configured && p.id !== "workers-ai-image") opts.push(["gw:" + p.id, `${p.id} — ${p.model}`]);
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

// ------------------------------------------------------------------ الدردشة
function md(text) {
  const parts = String(text).split(/```(\w*)\n?([\s\S]*?)```/g);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 0) {
      out += esc(parts[i]).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
    } else if (i % 3 === 2) out += `<pre>${esc(parts[i])}</pre>`;
  }
  return out;
}
const chatHistory = [];
function addMsg(role, html, meta = "") {
  const d = document.createElement("div"); d.className = "msg " + role;
  d.innerHTML = `<div class="bubble">${html}${meta ? `<span class="meta">${esc(meta)}</span>` : ""}</div>`;
  $("#chat-log").appendChild(d); $("#chat-log").scrollTop = 1e9; return d;
}
$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ta = $("#chat-text"); const text = ta.value.trim(); if (!text) return;
  const engine = $("#chat-engine").value; if (!engine) return toast("اضبط البوابة أو المحرك في الإعدادات", true);
  ta.value = ""; addMsg("user", md(text)); chatHistory.push({ role: "user", content: text });
  const pending = addMsg("assistant", '<span class="typing"></span>');
  try {
    const sys = { role: "system", content: "أنت «المبرمج المجهول AI»، مساعد ذكي يتحدث العربية والإنجليزية، متخصص في البرمجة والأمن الرقمي وتحليل السوشيال ميديا. أجب بدقة ووضوح وبلغة السؤال." };
    const r = await llm([sys, ...chatHistory.slice(-20)], engine, 2048);
    chatHistory.push({ role: "assistant", content: r.text });
    pending.querySelector(".bubble").innerHTML = md(r.text) + `<span class="meta">${esc(r.label)}</span>`;
  } catch (err) {
    pending.querySelector(".bubble").innerHTML = `<span class="b-red">${esc(err.message)}</span>`;
    chatHistory.pop();
  }
  $("#chat-log").scrollTop = 1e9;
});
$("#chat-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#chat-form").requestSubmit(); }
});

// ------------------------------------------------------------------ الصور
$("#img-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  let prompt = $("#img-prompt").value.trim(); if (!prompt) return;
  const box = document.createElement("div"); box.className = "shot loading"; box.textContent = "جارٍ التوليد…";
  $("#gallery").prepend(box);
  try {
    if ($("#img-translate").checked && state.gwOk) {
      try {
        const r = await llm([{ role: "system", content: "Rewrite the user's image idea as one vivid English prompt for an image model (max 60 words). Output only the prompt." }, { role: "user", content: prompt }], "gw:auto", 200);
        prompt = r.text.trim().replace(/^["']|["']$/g, "");
      } catch { /* نكمل بالوصف الأصلي */ }
    }
    let src;
    if (state.gwOk) src = (await gwFetch("/api/image", { prompt })).image;
    else src = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${Date.now() % 1e6}`;
    const img = new Image(); img.alt = prompt; img.src = src;
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error("تعذّر تحميل الصورة")); });
    box.className = "shot"; box.textContent = "";
    box.appendChild(img);
    const cap = document.createElement("div"); cap.className = "cap";
    cap.innerHTML = `<span title="${esc(prompt)}">${esc(prompt)}</span>`;
    const dl = document.createElement("a"); dl.textContent = "⬇"; dl.href = src; dl.download = "almajhool-ai.jpg"; dl.target = "_blank"; dl.rel = "noopener";
    cap.appendChild(dl); box.appendChild(cap);
  } catch (err) { box.className = "shot loading"; box.innerHTML = `<span class="b-red">${esc(err.message)}</span>`; }
});

// ------------------------------------------------------------------ بناء المواقع
const KIND = {
  website: "a complete multi-section website",
  webapp: "a mobile-first web application with real working functionality and state",
  game: "a fully playable browser game with controls for both touch and keyboard",
  dashboard: "an admin dashboard with charts drawn on <canvas> and realistic sample data",
  landing: "a high-converting landing page",
};
const build = { code: "", history: [] };
function extractHtml(text) {
  const m = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  let code = m ? m[1] : text;
  const i = code.search(/<!doctype html|<html/i);
  if (i > 0) code = code.slice(i);
  return code.trim();
}
function setPreview(code) {
  build.code = code;
  $("#preview").srcdoc = code;
  $("#code-view").textContent = code;
  for (const id of ["#btn-download", "#btn-copy", "#btn-newtab"]) $(id).disabled = !code;
  $("#build-meta").textContent = code ? `${(code.length / 1024).toFixed(1)} KB` : "";
  $("#btn-build").textContent = code ? "✎ عدّل" : "⌘ ابنِ";
  $("#build-prompt").placeholder = code ? "اكتب التعديل المطلوب… مثال: أضف وضع فاتح وزر واتساب عائم" : "صف المشروع…";
}
$("#build-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const req = $("#build-prompt").value.trim(); if (!req) return;
  const engine = $("#build-engine").value; if (!engine) return toast("اضبط البوابة أو المحرك في الإعدادات", true);
  const kind = $("#build-kind").value;
  const system = `You are an expert front-end engineer. Build ${KIND[kind]}.
Rules: output ONE complete self-contained HTML file inside a single \`\`\`html code block — inline <style> and <script>, no build step.
Make it production quality: responsive (mobile first), accessible, polished modern design, real working interactions (no placeholder "TODO").
If the request is in Arabic, the page content must be Arabic with dir="rtl" and the Cairo font from Google Fonts.
External resources are allowed only from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com and fonts.googleapis.com. Use https://picsum.photos for placeholder images.
Do not explain — output only the code block.`;
  const messages = build.code
    ? [{ role: "system", content: system }, { role: "user", content: `Current file:\n\`\`\`html\n${build.code}\n\`\`\`\nApply this change and return the FULL updated file: ${req}` }]
    : [{ role: "system", content: system }, { role: "user", content: req }];
  const btn = $("#btn-build"); btn.disabled = true;
  $("#build-status").textContent = "جارٍ البناء… قد يستغرق دقيقة";
  try {
    const r = await llm(messages, engine, 12000);
    const code = extractHtml(r.text);
    if (!/<html|<body|<div/i.test(code)) throw new Error("النموذج لم يرجع HTML صالحًا — جرّب محركًا آخر");
    build.history.push({ req, code });
    setPreview(code);
    $("#build-prompt").value = "";
    $("#build-status").textContent = `✓ ${r.label}`;
  } catch (err) { $("#build-status").innerHTML = `<span class="b-red">${esc(err.message)}</span>`; }
  btn.disabled = false;
});
$$(".seg button").forEach((b) => b.addEventListener("click", () => {
  $$(".seg button").forEach((x) => x.classList.toggle("active", x === b));
  const code = b.dataset.view === "code";
  $("#preview").hidden = code; $("#code-view").hidden = !code;
}));
$("#btn-download").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([build.code], { type: "text/html" }));
  a.download = "almajhool-project.html"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$("#btn-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(build.code); toast("تم نسخ الكود"); } catch { toast("تعذّر النسخ", true); }
});
$("#btn-newtab").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([build.code], { type: "text/html" }));
  window.open(url, "_blank", "noopener");
});
$("#btn-reset").addEventListener("click", () => { build.history = []; setPreview(""); $("#build-status").textContent = ""; });

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
setPreview("");
checkConnections().then(refreshAll);
setInterval(() => {
  const active = $(".tab.active")?.id;
  if (state.engineOk && ["tab-dashboard", "tab-train"].includes(active)) refreshAll();
}, 8000);
window.addEventListener("resize", () => drawLoss(state.lastMetrics || []));
