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
};
const state = { engineOk: false, gwOk: false, me: null, providers: [], models: [], datasets: [], runs: [], activeRun: null };
const isAdmin = () => state.me?.user?.role === "admin";

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
/** طلب إلى خادم الموقع نفسه (الجلسة عبر الكوكيز) */
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method, credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showLogin(); throw new Error(data.error || "سجّل الدخول أولًا"); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ------------------------------------------------------------------ تسجيل الدخول
const VERIFIER = "neon_auth_session_verifier";
function showLogin() { document.body.classList.add("logged-out"); }
async function signInGoogle() {
  const btn = $("#btn-google"); btn.disabled = true; btn.querySelector("span").textContent = "جارٍ التحويل إلى Google…";
  try {
    const res = await fetch("/api/auth/sign-in/social", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "google", callbackURL: location.origin + "/" }),
    });
    const j = await res.json();
    if (!j.url) throw new Error(j.message || j.error || "تعذّر بدء تسجيل الدخول");
    location.href = j.url;
  } catch (e) { toast(e.message, true); btn.disabled = false; btn.querySelector("span").textContent = "المتابعة باستخدام Google"; }
}
async function signOut() {
  await fetch("/api/auth/sign-out", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  location.replace("/");
}
async function loadMe() {
  // العودة من Google: نبدّل رمز التحقق بجلسة (كوكيز على نطاق موقعنا)
  const params = new URLSearchParams(location.search);
  if (params.has(VERIFIER)) {
    await fetch(`/api/auth/get-session?${VERIFIER}=${encodeURIComponent(params.get(VERIFIER))}`, { credentials: "same-origin" }).catch(() => {});
    params.delete(VERIFIER);
    history.replaceState(null, "", location.pathname + (params.toString() ? "?" + params : "") + location.hash);
  }
  const me = await fetch("/api/me", { credentials: "same-origin" }).then((r) => r.json()).catch(() => ({ user: null }));
  state.me = me.user ? me : null;
  state.providers = me.providers || [];
  state.gwOk = !!me.user && state.providers.some((p) => p.configured);
  return state.me;
}
function renderAccount() {
  const u = state.me.user;
  document.body.classList.remove("logged-out");
  document.body.classList.toggle("is-admin", isAdmin());
  $("#acct-avatar").src = u.image || "icon-192.png";
  $("#acct-name").textContent = u.name || u.email;
  $("#acct-email").textContent = u.email;
  $("#acct-role").textContent = isAdmin() ? "أدمن" : "مستخدم";
  if (state.providers.some((p) => p.id === "image-sdxl")) $("#img-model").querySelector('[value="sdxl"]').disabled = false;
  renderUsage(); renderProviders(); fillEngineSelects();
}
$("#btn-google").addEventListener("click", signInGoogle);
$("#acct-btn").addEventListener("click", (e) => { e.stopPropagation(); $("#acct-menu").hidden = !$("#acct-menu").hidden; });
document.addEventListener("click", () => { $("#acct-menu").hidden = true; });
$("#btn-logout").addEventListener("click", signOut);

async function checkEngine() {
  state.engineOk = false;
  if (isAdmin() && S.engineUrl) { try { await engineFetch("/api/health"); state.engineOk = true; } catch { } }
  for (const id of ["#dot-engine", "#dot-engine-2"]) $(id).className = "dot " + (S.engineUrl ? (state.engineOk ? "on" : "off") : "");
  $("#dot-gateway").className = "dot " + (state.gwOk ? "on" : "off");
  $("#conn-label").textContent = state.engineOk ? "المحرك متصل" : state.gwOk ? "جاهز — الذكاء الاصطناعي متصل" : "البوابة غير متاحة حاليًا";
  $("#engine-offline").hidden = state.engineOk || !isAdmin();
  $("#engine-dash").hidden = !state.engineOk;
  $("#img-engine").textContent = "الصور تُحفظ في حسابك تلقائيًا";
  await refreshModels();
  fillEngineSelects();
}

function fillEngineSelects() {
  const opts = [];
  if (state.gwOk) {
    opts.push(["gw:auto", "⚡ تلقائي (أفضل متاح)"]);
    for (const p of state.providers) if (p.configured && p.kind !== "image" && !p.id.startsWith("image-")) opts.push(["gw:" + p.id, `${p.id} — ${p.model}`]);
  }
  if (state.engineOk) {
    for (const m of [...state.models].reverse()) opts.push(["model:" + m.version, `نموذجي ${m.version}`]);
    opts.push(["model:base", "النموذج الأساسي (قبل التدريب)"]);
  }
  if (!opts.length) opts.push(["gw:auto", "⚡ تلقائي"]);
  for (const sel of [$("#chat-engine"), $("#build-engine")]) {
    const cur = sel.value;
    sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
    if (opts.some(([v]) => v === cur)) sel.value = cur;
  }
}

// ------------------------------------------------------------------ التبويبات
const ADMIN_TABS = ["data", "train", "settings", "admin"];
function showTab(name) {
  if (ADMIN_TABS.includes(name) && !isAdmin()) name = "chat";
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
  if (["dashboard", "train", "data"].includes(name)) { refreshAll(); refreshMe(); }
  if (name === "image") loadGallery();
  if (name === "builder") loadMySites();
  if (name === "admin") loadAdmin();
  store.set("tab", name);
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

// ------------------------------------------------------------------ الاستهلاك (من الخادم)
const estTokens = (s) => Math.ceil(String(s || "").length / 3.2);
async function refreshMe() {
  try {
    const me = await fetch("/api/me", { credentials: "same-origin" }).then((r) => r.json());
    if (me.user) { state.me = me; state.providers = me.providers || state.providers; renderUsage(); renderProviders(); }
  } catch { /* لا شيء */ }
}
function renderUsage() {
  const me = state.me; if (!me) return;
  const u = me.usage, L = me.limits, admin = isAdmin();
  $("#usage-chip").textContent = "⚡ " + shortTokens(u.tokens);
  $("#usage-cards").innerHTML = [
    card("توكنات اليوم", shortTokens(u.tokens), admin ? "بدون حد (أدمن)" : `من ${shortTokens(L.tokens)}`),
    card("طلبات اليوم", num(u.requests), ""),
    card("صور اليوم", num(u.images), admin ? "بدون حد" : `من ${L.images}`),
    card("نشر اليوم", num(u.sites), admin ? "بدون حد" : `من ${L.sites}`),
  ].join("");
  const goal = admin ? 1e7 : L.tokens;
  $("#budget-label").textContent = admin ? "هدف اليوم: 10,000,000 توكن" : `حدّك اليومي: ${num(L.tokens)} توكن`;
  $("#budget-bar").style.width = Math.min(100, (u.tokens / goal) * 100).toFixed(2) + "%";
  $("#budget-text").textContent = `${num(u.tokens)} / ${num(goal)}`;
}
function renderProviders() {
  $("#provider-panel").hidden = !isAdmin();
  if (!isAdmin()) return;
  const text = state.providers.filter((p) => p.kind === "text");
  const on = text.filter((p) => p.configured);
  $("#provider-summary").innerHTML = `<b class="neon">${on.length}</b> مصدر شغّال من أصل ${text.length} — كل مصدر تضيف مفتاحه يزيد السعة اليومية`;
  $("#provider-list").innerHTML = text.map((p) => {
    const st = p.stats || {};
    const status = !p.configured ? '<span class="badge b-muted">يحتاج مفتاح</span>'
      : p.cooldown_s > 0 ? `<span class="badge b-amber">استراحة ${p.cooldown_s}ث</span>`
      : '<span class="badge b-green">شغّال</span>';
    const tier = p.tier === 1 ? "قوي" : p.tier === 2 ? "احتياطي" : "طوارئ";
    return `<div class="prov ${p.configured ? "ok" : ""}">
      <span class="dot ${p.configured ? "on" : ""}"></span><b>${esc(p.id)}</b>${status}
      <small class="muted">${esc(tier)} · ${p.keyless && !p.has_key ? "بدون مفتاح · " : ""}${p.keys > 1 ? `${num(p.keys)} مفاتيح · ` : ""}${esc(p.cap || "")}</small>
      <span class="muted mono">${esc(p.model || "")}</span>
      ${p.configured ? `<small class="muted mono">✓ ${num(st.ok || 0)} · ✗ ${num(st.fail || 0)} · ${shortTokens(st.tokens || 0)} توكن${st.last_error && st.fail ? ` · آخر خطأ: ${esc(String(st.last_error).slice(0, 60))}` : ""}</small>`
        : `<small>${p.signup ? `<a href="${esc(p.signup)}" target="_blank" rel="noopener">سجّل واحصل على المفتاح ↗</a> · ` : ""}اسم المتغير: <code>${esc(p.key_var || "")}</code></small>`}
    </div>`;
  }).join("") || '<p class="muted">البوابة لا ترد — تحقق من GATEWAY_URL.</p>';
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
async function llmStream(messages, engine, { maxTokens = 4096, onDelta, signal, temperature, ensemble = false } = {}) {
  let res, label;
  if (engine.startsWith("model:")) {
    const headers = { "Content-Type": "application/json" };
    if (S.engineKey) headers.Authorization = "Bearer " + S.engineKey;
    res = await fetch(S.engineUrl + "/v1/chat/completions", { method: "POST", headers, signal,
      body: JSON.stringify({ model: engine.slice(6), messages, max_tokens: maxTokens, temperature: temperature ?? 0.7, stream: true }) });
    label = "نموذجي " + engine.slice(6);
  } else {
    res = await fetch("/api/chat", { method: "POST", signal, credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, provider: engine.slice(3) || "auto", max_tokens: maxTokens, temperature, ensemble }) });
    if (res.status === 401) showLogin();
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
  if (state.me) { state.me.usage.tokens += tokens; state.me.usage.requests += 1; renderUsage(); }
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
        .replace(/!\[([^\]\n]*)\]\(((?:https?:\/\/|\/)[^\s)"<>]+)\)/g, '<a href="$2" target="_blank" rel="noopener"><img class="chat-img" src="$2" alt="$1" loading="lazy"></a>')
        .replace(/(^|[\s>])(https?:\/\/[^\s<"]+)/g, '$1<a class="build-link" href="$2" target="_blank" rel="noopener">$2</a>')
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
  general: "أنت «المبرمج المجهول AI»، مساعد ذكي جدًا يفهم العربية الفصحى وكل اللهجات (العراقية والخليجية والشامية والمصرية وغيرها) والإنجليزية، حتى مع الأخطاء الإملائية. افهم قصد المستخدم حتى لو كان كلامه مختصرًا أو عاميًا، ورد بنفس لهجته. أجب بدقة ووضوح، ونظّم الإجابة بعناوين ونقاط عند الحاجة. هذا الموقع يستطيع أيضًا توليد الصور وبناء مواقع وتطبيقات ونشرها برابط: إذا طلب المستخدم شيئًا من ذلك أخبره أن يكتب طلبه مباشرة مثل «ارسملي…» أو «سويلي موقع…».",
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
  $("#side-chats").innerHTML = chats.slice().reverse().map((c) =>
    `<button type="button" class="side-item ${c === currentChat ? "active" : ""}" data-chat="${c.id}">💬 ${esc(c.title)}</button>`).join("");
}
function renderChat() {
  const log = $("#chat-log"); log.innerHTML = "";
  if (!currentChat.messages.length) {
    log.innerHTML = `<div class="hero">
      <h2>شنو تريد نسوي اليوم؟ <span class="neon">✦</span></h2>
      <p>اكتب طلبك بالعربي وأنا أسويه: أبني موقع وأنشره برابط، أرسم صورة، أو أجاوب على أي سؤال.</p>
      <div class="hero-chips">
        <button type="button" data-q="ابنيلي موقع متجر عطور فخم بثيم أسود وذهبي، فيه منتجات وسلة مشتريات">🌐 متجر عطور</button>
        <button type="button" data-q="ابنيلي صفحة هبوط لدورة أمن سيبراني، فيها محاور الدورة وآراء الطلاب وزر تسجيل واتساب">🎓 صفحة دورة</button>
        <button type="button" data-q="سويلي تطبيق ملاحظات ومهام بالعربي مع وضع داكن وحفظ تلقائي">📱 تطبيق مهام</button>
        <button type="button" data-q="سويلي لعبة ثعبان بإضاءة نيون مع نقاط ومستويات">🎮 لعبة</button>
        <button type="button" data-q="ارسملي أسد لابس تاج ذهبي، بستايل واقعي، خلفية صحراء وقت الغروب">🎨 صورة أسد</button>
        <button type="button" data-q="اشرحلي شلون أحمي حسابي بالانستغرام من الاختراق">💬 سؤال</button>
      </div></div>`;
  }
  for (const m of currentChat.messages) addMsg(m.role, m.role === "user" ? esc(m.content).replace(/\n/g, "<br>") : md(m.content), m.meta);
  $("#chat-mode").value = currentChat.mode || "general";
  $("#chat-suggestions").hidden = currentChat.messages.length > 0;
}
function addMsg(role, html, meta = "") {
  $("#chat-log .hero")?.remove();
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

// ------------------------------------------------------------------ فهم الطلب تلقائيًا: صورة؟ موقع؟ أو دردشة
// يفهم الفصحى واللهجات (سويلي، اريد، ابي، ابغى، عايز…) ويتجاهل الأسئلة مثل «شلون أسوي موقع؟»
const AR_ASK = /(^|\s)(شلون|كيف|ليش|لماذا|شنو|شو|ما هو|ما هي|ماهو|وش|ايش|إيش|اشرح|اشرحلي|هل)(\s|$)/;
const AR_WANT = /(سوي|سوّي|اسوي|سويلي|سوّيلي|سولي|اعمل|اعملي|اعملّي|إعمل|ابني|ابنِ|ابنيلي|صمم|صمّم|صممي|صمملي|صمّملي|اريد|أريد|اريدك|ابي|أبي|ابغى|أبغى|عايز|عاوز|بدي|انشئ|أنشئ|اصنع|حضر|حضّر|جهز|جهّز|اكتب|create|make|build|design|generate)/i;
const AR_DRAW = /(ارسم|إرسم|ارسملي|ارسمي|ارسمني|draw|paint|صور(ة|ه)? ل|صوره ل|لوگو|لوجو|لوغو|logo|شعار|خلفية|خلفيه|wallpaper|بوستر|poster|غلاف|ثمبنيل|thumbnail|أفاتار|افتار|avatar)/i;
const AR_IMG = /(صور(ة|ه)|صورة|image|picture|photo|رسمة|رسمه)/i;
const AR_SITE = [
  ["game", /(لعب(ة|ه)|game)/i],
  ["dashboard", /(لوح(ة|ه) تحكم|داشبورد|dashboard|لوح(ة|ه) تحليلات)/i],
  ["landing", /(صفح(ة|ه) هبوط|لاندنج|landing)/i],
  ["webapp", /(تطبيق|ابلكيشن|\bapp\b|حاسب(ة|ه)|آل(ة|ه) حاسب(ة|ه))/i],
  ["website", /(موقع|متجر|ستور|store|website|site|بورتفوليو|portfolio|مدون(ة|ه)|صفح(ة|ه) (ويب|شخصي(ة|ه)))/i],
];
// تعديل على الموقع المفتوح: «غيّر اللون»، «ضيف قسم»، «شيل الزر»، «خلي الخط أكبر»…
const AR_EDIT = /(غير|غيّر|بدل|بدّل|ضيف|أضف|اضف|زيد|زوّد|شيل|احذف|امسح|خلي|خلّي|كبر|كبّر|صغر|صغّر|عدل|عدّل|حسن|حسّن|صلح|صلّح|رتب|رتّب|حرك|حرّك|ترجم الموقع|change|add|remove|make it|fix)/i;
const AR_NEW = /(موقع جديد|مشروع جديد|تطبيق جديد|لعبة جديدة|من جديد|new site|new project)/i;
function detectIntent(text, hasProject = false) {
  const t = text.trim();
  if (t.length > 1500 || AR_ASK.test(t)) return { type: "chat" };
  if (AR_DRAW.test(t) || (AR_WANT.test(t) && AR_IMG.test(t))) return { type: "image" };
  if (AR_WANT.test(t) || AR_NEW.test(t)) for (const [kind, re] of AR_SITE) if (re.test(t)) {
    // «سويلي موقع…» وعندك مشروع: إذا قال «جديد» نبدأ مشروع جديد، وإلا نعتبره طلب موقع جديد أيضًا
    return { type: "site", kind, fresh: true };
  }
  if (hasProject && AR_EDIT.test(t)) return { type: "edit" };
  return { type: "chat" };
}

// يكتب النص العربي الصحيح فوق مكانه بالصورة (الخط والتشكيل العربي من المتصفح نفسه، فيطلع صحيح 100%)
let overlayFont;
function loadOverlayFont() {
  return overlayFont ||= (async () => {
    try {
      const f = new FontFace("MajArabic", 'url("/fonts/maj-arabic.woff2") format("woff2")', { weight: "100 900" });
      await f.load(); document.fonts.add(f);
      return '"MajArabic"';
    } catch { return '"Noto Naskh Arabic", Tahoma, sans-serif'; }
  })();
}
const shade = (hex, p) => {
  const n = parseInt(String(hex).slice(1), 16) || 0, f = (v) => Math.max(0, Math.min(255, Math.round(v + (p > 0 ? 255 - v : v) * p)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
};
// شريط اسم مخيّط على البدلة (مثل بدلات الشرطة والدفاع المدني والجيش): قماش غامق، خياطة على الحواف، وحروف مطرّزة
function drawNameTape(ctx, o, x, y, w, h, family) {
  if (h > w / 3) { const nh = w / 4.2; y += (h - nh) / 2; h = nh; } // نسبة الشريط الحقيقية
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2); ctx.rotate(((o.angle || 0) * Math.PI) / 180);
  const L = -w / 2, T = -h / 2, r = Math.min(h * 0.1, 5);
  const tape = () => { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(L, T, w, h, r) : ctx.rect(L, T, w, h); };
  ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = Math.max(2, h * 0.15); ctx.shadowOffsetY = Math.max(1, h * 0.05);
  const g = ctx.createLinearGradient(0, T, 0, T + h);
  g.addColorStop(0, shade(o.bg, 0.1)); g.addColorStop(1, shade(o.bg, -0.15));
  tape(); ctx.fillStyle = g; ctx.fill();
  ctx.shadowColor = "transparent";
  // نسيج القماش
  ctx.save(); tape(); ctx.clip();
  ctx.strokeStyle = "rgba(255,255,255,.05)"; ctx.lineWidth = 1;
  for (let yy = T + 1; yy < T + h; yy += Math.max(2, h * 0.06)) { ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(L + w, yy); ctx.stroke(); }
  ctx.restore();
  // خياطة الحواف
  const inset = Math.max(1.5, h * 0.1);
  ctx.setLineDash([Math.max(2, h * 0.09), Math.max(1.5, h * 0.06)]);
  ctx.strokeStyle = shade(o.bg, 0.3); ctx.lineWidth = Math.max(0.8, h * 0.035);
  ctx.strokeRect(L + inset, T + inset, w - inset * 2, h - inset * 2);
  ctx.setLineDash([]);
  // الحروف المطرّزة
  let size = h * 0.6;
  const font = (sz) => `bold ${sz}px ${family}`;
  ctx.font = font(size);
  while (ctx.measureText(o.text).width > w * 0.82 && size > 6) { size -= 0.5; ctx.font = font(size); }
  ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.direction = "rtl";
  ctx.shadowColor = "rgba(0,0,0,.55)"; ctx.shadowBlur = Math.max(1, size * 0.06); ctx.shadowOffsetY = Math.max(0.5, size * 0.04);
  const tg = ctx.createLinearGradient(0, -size / 2, 0, size / 2);
  tg.addColorStop(0, shade(o.fg, 0.15)); tg.addColorStop(1, shade(o.fg, -0.18));
  ctx.fillStyle = tg; ctx.fillText(o.text, 0, size * 0.06);
  ctx.restore();
}
async function applyOverlays(url, overlays) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  // خط عربي كامل بملف واحد من موقعنا: خط Google مقسّم لملفات، وبعض متصفحات الجوال
  // تخلط بين الملفات على الـcanvas فتطلع «بي» كأنها bi
  const family = await loadOverlayFont();
  const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
  const canvas = (w, h) => { const k = document.createElement("canvas"); k.width = Math.max(1, Math.round(w)); k.height = Math.max(1, Math.round(h)); return k; };
  for (const o of overlays) {
    const [y0, x0, y1, x1] = o.box;
    const x = (x0 / 1000) * c.width, y = (y0 / 1000) * c.height, w = ((x1 - x0) / 1000) * c.width, h = ((y1 - y0) / 1000) * c.height;
    const pad = Math.max(6, h * 0.3);
    const rx = Math.max(0, Math.floor(x - pad)), ry = Math.max(0, Math.floor(y - pad));
    const rw = Math.min(c.width - rx, Math.ceil(w + pad * 2)), rh = Math.min(c.height - ry, Math.ceil(h + pad * 2));
    if (rw < 4 || rh < 4) continue;
    if (o.style !== "print") { drawNameTape(ctx, o, x, y, w, h, family); continue; }

    const orig = canvas(rw, rh); orig.getContext("2d").drawImage(c, rx, ry, rw, rh, 0, 0, rw, rh);
    // ١) إذا الرسام كتب حروف غلط نمسحها: نملي مكانها بلون القماش من فوگ وجوه (بدون ما ناخذ الحروف نفسها)، بدون مربع أو ملصق
    const patch = canvas(rw, rh), pctx = patch.getContext("2d");
    if (o.existing !== false) {
      const top = Math.max(2, Math.floor(y - ry)), bottom = Math.max(2, Math.floor(ry + rh - (y + h)));
      const cols = Math.max(2, Math.round(rw / Math.max(3, h * 0.5)));
      const small = canvas(cols, 2), sctx = small.getContext("2d"); sctx.imageSmoothingQuality = "high";
      sctx.drawImage(c, rx, ry, rw, Math.min(top, rh), 0, 0, cols, 1);
      sctx.drawImage(c, rx, ry + rh - Math.min(bottom, rh), rw, Math.min(bottom, rh), 0, 1, cols, 1);
      pctx.imageSmoothingQuality = "high"; pctx.drawImage(small, 0, 0, rw, rh);
      // حبيبات خفيفة حتى يشبه نسيج القماش مو لون مسطح
      const px = pctx.getImageData(0, 0, rw, rh);
      for (let i = 0; i < px.data.length; i += 4) { const n = (Math.random() - 0.5) * 10; px.data[i] += n; px.data[i + 1] += n; px.data[i + 2] += n; }
      pctx.putImageData(px, 0, 0);
      const f = Math.max(3, pad * 0.8), mask = canvas(rw, rh), mctx = mask.getContext("2d");
      mctx.shadowColor = "#000"; mctx.shadowBlur = f; mctx.shadowOffsetX = rw + 50;
      mctx.fillRect(f - rw - 50, f, rw - f * 2, rh - f * 2);
      pctx.globalCompositeOperation = "destination-in"; pctx.drawImage(mask, 0, 0);
      ctx.drawImage(patch, rx, ry);
    }

    // ٢) نطبع النص نفسه على السطح: بلون الحبر، مايل وية السطح، وياخذ ظلال وطيّات القماش من الصورة الأصلية
    const t = canvas(rw, rh), tctx = t.getContext("2d");
    let size = h * 0.82;
    const font = (sz) => `bold ${sz}px ${family}`;
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
  return c.toDataURL("image/png");
}
/** يصحح الكتابة إذا الخادم رجع أماكنها، ويحفظ النسخة المصححة بحسابك. يرجع رابط الصورة النهائي */
async function fixImageText(item) {
  if (!item.overlays?.length) return item.url;
  try {
    const fixed = await applyOverlays(item.url, item.overlays);
    const r = await api("/api/image", { method: "PUT", body: { id: item.id, image: fixed } });
    item.url = r.url; item.fixedText = true;
    return r.url;
  } catch (e) { console.warn("overlay failed", e); return item.url; }
}

async function chatImage(text) {
  currentChat.messages.push({ role: "user", content: text }); saveChats(); renderChatList();
  addMsg("user", esc(text).replace(/\n/g, "<br>"));
  const bubble = addMsg("assistant", '<span class="muted">🎨 جاري رسم الصورة…</span> <span class="typing"></span>');
  const content = bubble.querySelector(".content");
  const prompt = text; // الخادم يفهم الطلب (Gemini) ويحوله لوصف دقيق قبل الرسم
  try {
    const item = await api("/api/image", { method: "POST", body: { prompt, model: "flux", width: 1, height: 1, negative_prompt: "blurry, low quality, watermark, deformed" } });
    if (item.overlays?.length) { content.innerHTML = '<span class="muted">✍️ أصحح الكتابة العربية بالصورة…</span> <span class="typing"></span>'; await fixImageText(item); }
    content.innerHTML = `<p>تفضل 🎨</p><a href="${esc(item.url)}" target="_blank" rel="noopener"><img class="chat-img" src="${esc(item.url)}" alt="${esc(text)}"></a>
      ${item.understood ? `<small class="muted" dir="ltr">🧠 فهمت طلبك هيج: ${esc(item.understood)}</small>` : ""}
      ${item.provider ? `<small class="muted">🖌 رسمها: ${esc(item.provider)}${item.candidates > 1 ? ` · Gemini اختارها من ${item.candidates} صور` : ""}</small>` : ""}
      ${item.fixedText ? `<small class="muted">✍️ صححت الكتابة العربية: ${esc(item.overlays.map((o) => o.text).join("، "))}</small>`
        : /(مكتوب|اكتب|كتابة|كتابه|عليها|عليه اسم|باسم|نص)/.test(text) ? `<p class="small-print" style="color:var(--amber)">⚠️ إذا الكتابة طلعت غلط، حط النص اللي تريده بين علامتي تنصيص، مثل: مكتوب عليها "شرطة النجدة"</p>` : ""}
      <p class="row"><a class="btn small" href="${esc(item.url)}?dl=1">⬇ حفظ</a> <button class="btn small" type="button" data-share="${esc(item.url)}">🔗 مشاركة</button></p>`;
    currentChat.messages.push({ role: "assistant", content: `![${text}](${item.url})`, meta: "صورة · FLUX" });
    galleryLoaded = false;
    if (state.me) { state.me.usage.images++; renderUsage(); }
  } catch (err) {
    content.innerHTML = `<span class="b-red">${esc(err.message)}</span>`;
  }
  saveChats(); $("#chat-log").scrollTop = 1e9;
}

async function chatSite(text, kind, { fresh = true } = {}) {
  if (fresh) { build.versions = []; build.idx = -1; build.slug = null; saveBuild(); setPreview(); }
  currentChat.messages.push({ role: "user", content: text }); saveChats(); renderChatList();
  addMsg("user", esc(text).replace(/\n/g, "<br>"));
  const bubble = addMsg("assistant", `<div class="build-steps">${fresh ? "⌘ رحت أبني مشروعك…" : "✎ رحت أعدّل موقعك…"} <span class="typing"></span></div>`);
  const content = bubble.querySelector(".content");
  const btn = $("#btn-send"); btn.textContent = "■"; btn.classList.add("danger");
  chatAbort = new AbortController();
  try {
    const r = await generateSite(text, kind, { signal: chatAbort.signal, onStatus: (s) => {
      content.innerHTML = `<div class="build-steps">${esc(s)} <span class="typing"></span></div>`; $("#chat-log").scrollTop = 1e9;
    } });
    content.innerHTML = `<div class="build-steps">✓ خلص البناء — جاري النشر برابط… <span class="typing"></span></div>`;
    let url = null;
    try { url = await publishCurrent(); } catch (e) { toast("ما كدرت أنشره: " + e.message, true); }
    const msg = url
      ? `${fresh ? "✅ موقعك جاهز ومنشور!" : "✅ عدّلت موقعك ونشرت التحديث على نفس الرابط!"}\n${url}\nاطلب أي تعديل هنا، مثل: «غيّر اللون للأزرق» أو «ضيف قسم آراء العملاء».`
      : `${fresh ? "✅ موقعك جاهز!" : "✅ عدّلت موقعك!"} شوفه بالمعاينة، واضغط «🚀 نشر» حتى تاخذ رابط.`;
    currentChat.messages.push({ role: "assistant", content: msg, meta: r.label });
    content.innerHTML = md(msg) + buildCardHtml(url);
  } catch (err) {
    content.innerHTML = err.name === "AbortError" ? "أُوقف البناء." : `<span class="b-red">${esc(err.message)}</span>`;
  }
  saveChats(); chatAbort = null; btn.textContent = "↑"; btn.classList.remove("danger");
  $("#chat-log").scrollTop = 1e9;
}
function buildCardHtml(url) {
  return `<div class="build-card"><div class="row">
    <button class="btn small" type="button" data-open-preview>👁 المعاينة</button>
    ${url ? `<a class="btn small primary" href="${esc(url)}" target="_blank" rel="noopener">↗ افتح الموقع</a>
    <button class="btn small" type="button" data-copy="${esc(url)}">⧉ نسخ الرابط</button>` : ""}
  </div></div>`;
}

async function sendChat(text) {
  const engine = $("#chat-engine").value; if (!engine) return toast("اضبط البوابة أو المحرك في الإعدادات", true);
  if (currentChat.mode !== "translator") {
    const intent = detectIntent(text, !!currentCode());
    if (!currentChat.messages.length) currentChat.title = text.slice(0, 40);
    if (intent.type === "image") return chatImage(text);
    if (intent.type === "site") return chatSite(text, intent.kind, { fresh: true });
    if (intent.type === "edit") return chatSite(text, null, { fresh: false });
  }
  if (!currentChat.messages.length) currentChat.title = text.slice(0, 40);
  currentChat.messages.push({ role: "user", content: text }); saveChats(); renderChatList();
  addMsg("user", esc(text).replace(/\n/g, "<br>"));
  $("#chat-suggestions").hidden = true;
  const bubble = addMsg("assistant", '<span class="typing"></span>');
  const content = bubble.querySelector(".content");
  const btn = $("#btn-send"); btn.textContent = "■"; btn.classList.add("danger");
  chatAbort = new AbortController();
  let partial = "";
  try {
    const sys = { role: "system", content: MODES[currentChat.mode] || MODES.general };
    const history = currentChat.messages.slice(-24).map(({ role, content }) => ({ role, content }));
    let raf = 0;
    content.innerHTML = '<span class="muted">🧠 أسأل عدة نماذج وأجمع أفضل جواب…</span> <span class="typing"></span>';
    const r = await llmStream([sys, ...history], engine, {
      maxTokens: 8192, signal: chatAbort.signal, ensemble: engine === "gw:auto",
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
  chatAbort = null; btn.textContent = "↑"; btn.classList.remove("danger");
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

// ------------------------------------------------------------------ الصور (محفوظة في الحساب)
let galleryLoaded = false;
function shotEl(item) {
  const box = document.createElement("div"); box.className = "shot";
  box.innerHTML = `<img alt="${esc(item.prompt)}" src="${item.url}" loading="lazy" style="aspect-ratio:${item.width || 1}/${item.height || 1}">
    <div class="cap"><span title="${esc(item.prompt)}">${esc(item.prompt)}</span>
      <a href="${item.url}?dl=1" title="حفظ في الجهاز">⬇</a>
      <button type="button" class="icon-btn" data-share="${item.url}" title="مشاركة / نسخ الرابط">🔗</button>
      <button type="button" class="icon-btn" data-del-img="${item.id}" title="حذف">🗑</button></div>`;
  box.querySelector("img").addEventListener("click", () => window.open(item.url, "_blank", "noopener"));
  return box;
}
async function loadGallery(force = false) {
  if (galleryLoaded && !force) return;
  try {
    const items = await api("/api/image");
    const g = $("#gallery"); g.innerHTML = "";
    items.forEach((it) => g.appendChild(shotEl(it)));
    $("#gallery-empty").hidden = items.length > 0;
    galleryLoaded = true;
  } catch (e) { toast(e.message, true); }
}
document.addEventListener("click", async (e) => {
  const sh = e.target.closest("[data-share]");
  if (sh) {
    const url = new URL(sh.dataset.share, location.origin).href;
    try { if (navigator.share) await navigator.share({ url }); else { await navigator.clipboard.writeText(url); toast("تم نسخ رابط الصورة"); } } catch { }
  }
  const del = e.target.closest("[data-del-img]");
  if (del && confirm("حذف الصورة نهائيًا؟")) {
    try { await api("/api/image?id=" + del.dataset.delImg, { method: "DELETE" }); del.closest(".shot").remove(); toast("تم الحذف"); }
    catch (err) { toast(err.message, true); }
  }
});
$("#img-model").addEventListener("change", () => { $("#img-size").disabled = $("#img-model").value !== "sdxl"; });
$("#img-size").disabled = true;

$("#img-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  let prompt = $("#img-prompt").value.trim(); if (!prompt) return;
  const model = $("#img-model").value, count = +$("#img-count").value, style = $("#img-style").value;
  const [w, h] = model === "sdxl" ? $("#img-size").value.split("x").map(Number) : [1, 1];
  const btn = $("#btn-img"); btn.disabled = true;
  $("#gallery-empty").hidden = true;
  const placeholders = Array.from({ length: count }, () => {
    const b = document.createElement("div"); b.className = "shot loading"; b.style.aspectRatio = `${w}/${h}`;
    b.innerHTML = '<span class="spinner"></span>'; $("#gallery").prepend(b); return b;
  });
  try {
    if (false && $("#img-translate").checked) { // صار على الخادم (Gemini) — أدق ولا يُحسب من التوكنات
      try {
        const r = await llmStream([{ role: "system", content: "Rewrite the user's image idea as one vivid, specific English prompt for a text-to-image model (max 70 words). Keep any text the user wants written in the image in quotes. Output only the prompt." }, { role: "user", content: prompt }], "gw:auto", { maxTokens: 300 });
        if (r.text.trim()) prompt = r.text.trim().replace(/^["']|["']$/g, "");
      } catch { /* نكمل بالوصف الأصلي */ }
    }
    const full = style ? `${prompt}, ${style}` : prompt;
    await Promise.all(placeholders.map(async (box) => {
      try {
        const item = await api("/api/image", { method: "POST", body: { prompt: full, model, width: w, height: h, negative_prompt: "blurry, low quality, watermark, deformed" } });
        await fixImageText(item);
        box.replaceWith(shotEl(item));
        if (item.understood) toast("🧠 فهمت طلبك: " + item.understood.slice(0, 140));
        if (state.me) { state.me.usage.images++; renderUsage(); }
      } catch (err) { box.innerHTML = `<span class="b-red small">${esc(err.message)}</span>`; }
    }));
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
  return { versions: saved.versions || [], idx: saved.idx ?? -1, slug: saved.slug || null, url: saved.url || null, abort: null };
})();
const currentCode = () => build.versions[build.idx]?.code || "";
function saveBuild() {
  const keep = build.versions.slice(-8);
  const idx = Math.min(build.idx, keep.length - 1);
  try { store.set("build", JSON.stringify({ versions: keep, idx, slug: build.slug, url: build.url })); } catch { try { store.set("build", JSON.stringify({ versions: keep.slice(-2), idx: Math.min(idx, 1), slug: build.slug, url: build.url })); } catch { } }
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
  document.body.classList.toggle("has-project", !!code);
  if ($("#preview").srcdoc !== code) $("#preview").srcdoc = code;
  $("#sp-title").textContent = code ? `${(code.match(/<title>([^<]{1,80})<\/title>/i)?.[1] || "مشروعك").trim()} · إصدار ${build.idx + 1}/${build.versions.length}` : "المعاينة";
  $("#sp-undo").disabled = build.idx <= 0;
  $("#sp-redo").disabled = build.idx >= build.versions.length - 1;
  $("#sp-url").hidden = !build.url;
  if (build.url) { $("#sp-url-a").href = build.url; $("#sp-url-a").textContent = build.url.replace(/^https?:\/\//, ""); $("#sp-open").href = build.url; }
  else $("#sp-open").removeAttribute("href");
  $("#code-view").textContent = code;
  for (const id of ["#btn-download", "#btn-copy", "#btn-newtab", "#btn-publish"]) $(id).disabled = !code;
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
  build.versions = []; build.idx = -1; build.slug = null; $("#publish-box").hidden = true; setPreview();
  $("#build-kind").value = b.dataset.kind; $("#build-prompt").value = b.dataset.q; $("#build-form").requestSubmit();
});

// يخمّن نوع المشروع من الطلب
function kindFor(text) {
  for (const [kind, re] of AR_SITE) if (re.test(text)) return kind;
  return "website";
}
/** يبني (أو يعدّل) المشروع ويضيفه كإصدار جديد — يُستخدم من الدردشة ومن قسم البناء */
async function generateSite(req, kind, { signal, onStatus, engine = "gw:auto", budget = 32000 } = {}) {
  kind = kind || kindFor(req);
  const system = `You are a world-class front-end engineer and UI designer. Build ${KIND[kind] || KIND.website}.
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
  let full = "", label = "", rounds = 0, messages = base;
  for (;;) {
    rounds++;
    const r = await llmStream(messages, engine, {
      maxTokens: Math.min(budget, 32000), signal, temperature: 0.4,
      onDelta: (t, _p, thinking) => onStatus?.(thinking && !t ? "🤔 يخطط للمشروع…" : `✍ يكتب الكود… ${(full.length + t.length).toLocaleString("en-US")} حرف${rounds > 1 ? ` (جزء ${rounds})` : ""}`),
    });
    full += r.text; label = r.label;
    // إكمال تلقائي إذا انقطع الكود بسبب حد التوكنات
    const unfinished = r.finish === "length" || (!/<\/html>\s*(```)?\s*$/i.test(full.trim()) && /<html|<!doctype/i.test(full));
    if (!unfinished || rounds >= 6 || full.length > budget * 4) break;
    onStatus?.(`↻ الكود طويل — أكمل الجزء ${rounds + 1}…`);
    messages = [...base, { role: "assistant", content: full },
      { role: "user", content: "Continue EXACTLY from where you stopped. Do not repeat anything and do not restart the code block — output only the remaining code." }];
  }
  let html = extractHtml(full);
  if (!/<html|<body|<div/i.test(html)) throw new Error("النموذج لم يرجع HTML صالحًا — جرّب مرة ثانية");
  if (!/<\/html>/i.test(html)) html += "\n</body></html>";
  build.versions = build.versions.slice(0, build.idx + 1);
  build.versions.push({ req, code: html, t: Date.now(), kind });
  build.idx = build.versions.length - 1;
  saveBuild(); setPreview();
  return { html, label, rounds };
}
/** ينشر الإصدار الحالي (أو يحدّث نفس الرابط) ويرجع الرابط */
async function publishCurrent() {
  const code = currentCode(); if (!code) throw new Error("ما في مشروع");
  const v = build.versions[build.idx];
  const title = (code.match(/<title>([^<]{1,120})<\/title>/i)?.[1] || build.versions[0]?.req || "مشروعي").trim().slice(0, 120);
  const r = await api("/api/sites", { method: "POST", body: { html: code, title, kind: v?.kind || kindFor(v?.req || ""), prompt: v?.req, slug: build.slug || undefined } });
  build.slug = r.slug; build.url = r.url; saveBuild();
  showPublished(r.url);
  if (state.me && !r.updated) { state.me.usage.sites++; renderUsage(); }
  sitesLoaded = false;
  return r.url;
}

$("#build-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (build.abort) { build.abort.abort(); return; }
  const req = $("#build-prompt").value.trim(); if (!req) return;
  const engine = $("#build-engine").value || "gw:auto";
  const btn = $("#btn-build"); btn.textContent = "■ إيقاف"; btn.classList.add("danger");
  build.abort = new AbortController();
  const status = $("#build-status");
  try {
    const r = await generateSite(req, $("#build-kind").value, { engine, budget: +$("#build-size").value, signal: build.abort.signal,
      onStatus: (t) => { status.textContent = t; } });
    $("#build-prompt").value = "";
    status.textContent = `✓ ${r.label}${r.rounds > 1 ? ` · ${r.rounds} أجزاء` : ""}`;
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
  build.versions = []; build.idx = -1; build.slug = null; saveBuild(); setPreview(); $("#build-status").textContent = "";
  $("#publish-box").hidden = true;
});

// ------------------------------------------------------------------ النشر برابط حقيقي
function showPublished(url) {
  build.url = url; setPreview();
  $("#publish-box").hidden = false;
  $("#publish-url").value = url;
  $("#publish-open").href = url;
  $("#publish-qr").src = "https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=8&data=" + encodeURIComponent(url);
}
$("#btn-publish").addEventListener("click", async () => {
  const btn = $("#btn-publish"); btn.disabled = true; btn.textContent = "⏳ جارٍ النشر…";
  try { const had = !!build.slug; await publishCurrent(); toast(had ? "تم تحديث الموقع المنشور ✓" : "تم النشر ✓ الرابط جاهز"); loadMySites(true); }
  catch (e) { toast(e.message, true); }
  btn.disabled = false; btn.textContent = "🚀 انشر واحصل على رابط";
});
$("#publish-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#publish-url").value); toast("تم نسخ الرابط"); } catch { $("#publish-url").select(); }
});
$("#publish-share").addEventListener("click", async () => {
  const url = $("#publish-url").value;
  try { if (navigator.share) await navigator.share({ title: "موقعي", url }); else { await navigator.clipboard.writeText(url); toast("تم نسخ الرابط"); } } catch { }
});
var sitesLoaded = false;
async function loadMySites(force = false) {
  if (sitesLoaded && !force) return;
  try {
    const sites = await api("/api/sites");
    sitesLoaded = true;
    $("#my-sites").innerHTML = sites.length ? sites.map((s) => `<div class="site-row">
      <div><b>${esc(s.title || s.slug)}</b><small class="muted mono">${esc(s.url.replace(/^https?:\/\//, ""))} · 👁 ${num(s.views)}</small></div>
      <div class="row-actions"><a class="btn small" href="${esc(s.url)}" target="_blank" rel="noopener">فتح ↗</a>
      <button class="btn small" data-copy="${esc(s.url)}">نسخ</button>
      <button class="btn small danger" data-del-site="${esc(s.slug)}">🗑</button></div></div>`).join("")
      : '<p class="muted">ما نشرت أي موقع بعد — ابنِ موقعًا واضغط «انشر».</p>';
  } catch (e) { $("#my-sites").innerHTML = `<p class="b-red">${esc(e.message)}</p>`; }
}
document.addEventListener("click", async (e) => {
  const c = e.target.closest("[data-copy]");
  if (c) { try { await navigator.clipboard.writeText(c.dataset.copy); toast("تم نسخ الرابط"); } catch { } }
  const d = e.target.closest("[data-del-site]");
  if (d && confirm("حذف هذا الموقع المنشور؟ الرابط سيتوقف عن العمل.")) {
    try {
      await api("/api/sites?slug=" + d.dataset.delSite, { method: "DELETE" });
      if (build.slug === d.dataset.delSite) { build.slug = null; saveBuild(); $("#publish-box").hidden = true; }
      loadMySites(true); toast("تم الحذف");
    } catch (err) { toast(err.message, true); }
  }
});


// ------------------------------------------------------------------ لوحة الأدمن
let adminView = "stats";
const dt = (s) => (s ? new Date(s).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "—");
async function loadAdmin(view = adminView) {
  if (!isAdmin()) return;
  adminView = view;
  $$("#admin-seg button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  const box = $("#admin-body");
  box.innerHTML = '<div class="center"><span class="spinner"></span></div>';
  try {
    const data = await api("/api/admin?view=" + view);
    if (view === "stats") renderAdminStats(data);
    if (view === "users") renderAdminUsers(data);
    if (view === "sites") renderAdminSites(data);
    if (view === "images") renderAdminImages(data);
  } catch (e) { box.innerHTML = `<p class="b-red">${esc(e.message)}</p>`; }
}
$$("#admin-seg button").forEach((b) => b.addEventListener("click", () => loadAdmin(b.dataset.view)));

function renderAdminStats({ stats: s, daily, providers }) {
  $("#admin-body").innerHTML = `
    <div class="cards">
      ${card("المستخدمون", num(s.users), `${num(s.new_today)} جديد اليوم`)}
      ${card("نشطون اليوم", num(s.active_today), "")}
      ${card("توكنات اليوم", shortTokens(+s.tokens_today), num(s.tokens_today))}
      ${card("توكنات الكلي", shortTokens(+s.tokens_total), num(s.tokens_total))}
      ${card("طلبات اليوم", num(s.requests_today), "")}
      ${card("الصور", num(s.images), `${num(s.images_today)} اليوم`)}
      ${card("المواقع المنشورة", num(s.sites), `👁 ${num(s.site_views)} زيارة`)}
      ${card("حجم قاعدة البيانات", bytes(+s.db_bytes), "من 512 MB مجانًا")}
    </div>
    <div class="budget"><div class="meter-top"><span>هدف اليوم: 10,000,000 توكن</span><span class="mono">${num(s.tokens_today)}</span></div>
      <div class="bar"><span style="width:${Math.min(100, (s.tokens_today / 1e7) * 100).toFixed(2)}%"></span></div></div>
    <h3 class="sub-h">التوكنات آخر 14 يوم</h3>
    <canvas id="admin-chart" height="200"></canvas>
    <h3 class="sub-h">المزودات (آخر 7 أيام)</h3>
    <div class="table-wrap"><table><thead><tr><th>المزود</th><th>طلبات</th><th>توكنات</th></tr></thead><tbody>
      ${providers.map((p) => `<tr><td class="mono">${esc(p.provider)}</td><td class="mono">${num(p.requests)}</td><td class="mono">${num(p.tokens)}</td></tr>`).join("") || '<tr><td colspan="3" class="muted">لا يوجد بعد</td></tr>'}
    </tbody></table></div>`;
  drawBars($("#admin-chart"), daily.map((d) => d.day), daily.map((d) => +d.tokens));
}

function drawBars(cv, labels, values) {
  const ctx = cv.getContext("2d"); const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = 200; cv.width = w * dpr; cv.height = h * dpr; ctx.scale(dpr, dpr);
  const pad = { l: 46, r: 8, t: 10, b: 26 }; const max = Math.max(1, ...values);
  const bw = (w - pad.l - pad.r) / values.length;
  ctx.font = "11px Cairo, sans-serif"; ctx.fillStyle = "#7d8cab"; ctx.textAlign = "right";
  for (let i = 0; i <= 3; i++) {
    const v = (max * i) / 3, y = pad.t + (1 - i / 3) * (h - pad.t - pad.b);
    ctx.fillText(shortTokens(Math.round(v)), pad.l - 6, y + 4);
    ctx.strokeStyle = "rgba(0,240,255,.08)"; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
  }
  values.forEach((v, i) => {
    const bh = (v / max) * (h - pad.t - pad.b); const x = pad.l + i * bw + bw * 0.15; const y = h - pad.b - bh;
    const g = ctx.createLinearGradient(0, y, 0, h - pad.b); g.addColorStop(0, "#00f0ff"); g.addColorStop(1, "#b026ff");
    ctx.fillStyle = g; ctx.fillRect(x, y, bw * 0.7, Math.max(bh, v ? 2 : 0));
    if (i % 2 === 0 || values.length < 8) { ctx.fillStyle = "#7d8cab"; ctx.textAlign = "center"; ctx.fillText(labels[i], x + bw * 0.35, h - 8); }
  });
}

function renderAdminUsers(users) {
  $("#admin-body").innerHTML = `<p class="muted">${num(users.length)} مستخدم — اضغط «حدود» لتغيير الحصة اليومية لأي مستخدم.</p>
    <div class="table-wrap"><table class="admin-table"><thead><tr>
      <th>المستخدم</th><th>الصلاحية</th><th>توكنات اليوم / الكلي</th><th>صور</th><th>مواقع</th><th>الحدود اليومية</th><th>آخر نشاط</th><th></th>
    </tr></thead><tbody>${users.map((u) => `<tr>
      <td><div class="user-cell"><img src="${esc(u.image || "icon-192.png")}" alt=""><div><b>${esc(u.name || "—")}</b><small class="muted">${esc(u.email)}</small></div></div></td>
      <td>${u.role === "admin" ? '<span class="badge b-cyan">أدمن</span>' : '<span class="badge b-muted">مستخدم</span>'} ${u.banned ? '<span class="badge b-red">موقوف</span>' : ""}</td>
      <td class="mono">${shortTokens(+u.tokens_today)} / ${shortTokens(+u.tokens_total)}</td>
      <td class="mono">${num(u.images)}</td><td class="mono">${num(u.sites)}</td>
      <td class="mono small-print">${shortTokens(u.daily_tokens)} · ${u.daily_images}🖼 · ${u.daily_sites}🚀</td>
      <td class="mono small-print">${dt(u.last_seen)}</td>
      <td class="row-actions">
        <button class="btn small" data-act="limits" data-id="${esc(u.id)}" data-t="${u.daily_tokens}" data-i="${u.daily_images}" data-s="${u.daily_sites}">حدود</button>
        <button class="btn small ${u.banned ? "" : "danger"}" data-act="${u.banned ? "unban" : "ban"}" data-id="${esc(u.id)}">${u.banned ? "تفعيل" : "إيقاف"}</button>
        <button class="btn small" data-act="role" data-id="${esc(u.id)}" data-role="${u.role === "admin" ? "user" : "admin"}">${u.role === "admin" ? "إزالة أدمن" : "جعله أدمن"}</button>
      </td></tr>`).join("")}</tbody></table></div>`;
}

function renderAdminSites(sites) {
  $("#admin-body").innerHTML = `<div class="table-wrap"><table><thead><tr><th>الموقع</th><th>صاحبه</th><th>👁</th><th>الحجم</th><th>آخر تحديث</th><th></th></tr></thead><tbody>
    ${sites.map((s) => `<tr><td><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.slug)}</a><br><small class="muted mono">${esc(s.slug)}</small></td>
      <td class="small-print">${esc(s.email || "—")}</td><td class="mono">${num(s.views)}</td><td class="mono">${bytes(s.size)}</td>
      <td class="mono small-print">${dt(s.updated_at)}</td>
      <td><button class="btn small danger" data-act="delete_site" data-slug="${esc(s.slug)}">حذف</button></td></tr>`).join("") || '<tr><td colspan="6" class="muted">لا توجد مواقع بعد</td></tr>'}
  </tbody></table></div>`;
}

function renderAdminImages(images) {
  $("#admin-body").innerHTML = `<div class="gallery">${images.map((i) => `<div class="shot">
    <img src="${esc(i.url)}" alt="${esc(i.prompt)}" loading="lazy" style="aspect-ratio:${i.width || 1}/${i.height || 1}">
    <div class="cap"><span title="${esc(i.prompt)}">${esc(i.email || "")}</span>
      <a href="${esc(i.url)}?dl=1" title="تحميل">⬇</a>
      <button class="icon-btn" data-act="delete_image" data-img="${esc(i.id)}" title="حذف">🗑</button></div></div>`).join("") || '<p class="muted">لا توجد صور بعد</p>'}</div>`;
}

$("#admin-body").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act; let body = { action: act };
  if (act === "limits") {
    const t = prompt("حد التوكنات اليومي:", b.dataset.t); if (t === null) return;
    const i = prompt("حد الصور اليومي:", b.dataset.i); if (i === null) return;
    const s = prompt("حد النشر اليومي:", b.dataset.s); if (s === null) return;
    body = { ...body, user_id: b.dataset.id, tokens: +t, images: +i, sites: +s };
  } else if (act === "ban" || act === "unban") {
    if (act === "ban" && !confirm("إيقاف هذا المستخدم؟ لن يستطيع استخدام الموقع.")) return;
    body.user_id = b.dataset.id;
  } else if (act === "role") {
    if (!confirm(b.dataset.role === "admin" ? "إعطاء صلاحية أدمن كاملة لهذا المستخدم؟" : "إزالة صلاحية الأدمن؟")) return;
    body = { ...body, user_id: b.dataset.id, role: b.dataset.role };
  } else if (act === "delete_site") {
    if (!confirm("حذف هذا الموقع المنشور؟")) return; body.slug = b.dataset.slug;
  } else if (act === "delete_image") {
    if (!confirm("حذف هذه الصورة؟")) return; body.id = b.dataset.img;
  }
  try { await api("/api/admin", { method: "POST", body }); toast("تم ✓"); loadAdmin(); }
  catch (err) { toast(err.message, true); }
});

// ------------------------------------------------------------------ الإعدادات (المحرك — للأدمن)
$("#set-engine-url").value = S.engineUrl; $("#set-engine-key").value = S.engineKey;
$("#btn-save").addEventListener("click", async () => {
  S.engineUrl = $("#set-engine-url").value.trim().replace(/\/$/, "");
  S.engineKey = $("#set-engine-key").value.trim();
  for (const k of Object.keys(S)) store.set(k, S[k]);
  const log = $("#settings-log"); log.hidden = false; log.textContent = "جارٍ الاختبار…";
  await checkEngine();
  log.textContent = `Engine: ${S.engineUrl ? (state.engineOk ? "connected ✓" : "unreachable ✗") : "not set"}`;
  refreshAll();
});

// ------------------------------------------------------------------ التشغيل
(async function boot() {
  setPreview();
  const me = await loadMe();
  document.body.classList.remove("booting");
  if (!me) { showLogin(); return; }
  renderAccount();
  if (chats.length) { currentChat = chats[chats.length - 1]; renderChatList(); renderChat(); } else newChat();
  if (build.slug && currentCode()) loadMySites();
  showTab("chat");
  await checkEngine();
  refreshAll();
})();
setInterval(() => {
  const active = $(".tab.active")?.id;
  if (state.engineOk && ["tab-dashboard", "tab-train"].includes(active)) refreshAll();
}, 8000);
window.addEventListener("resize", () => drawLoss(state.lastMetrics || []));
$("#btn-refresh-prov").addEventListener("click", refreshMe);

// ------------------------------------------------------------------ الاستوديو: كل شي من الدردشة
function openPreview() { document.body.classList.add("preview-open"); }
function closePreview() { document.body.classList.remove("preview-open"); }
function openClassic(tab) { document.body.classList.add("classic"); closeMenu(); showTab(tab); }
function closeClassic() { document.body.classList.remove("classic"); showTab("chat"); }
function openMenu() { renderChatList(); $("#side-menu").hidden = false; }
function closeMenu() { $("#side-menu").hidden = true; }
$("#btn-menu").addEventListener("click", openMenu);
$("#btn-menu-close").addEventListener("click", closeMenu);
$("#side-menu").addEventListener("click", (e) => {
  if (e.target.id === "side-menu") return closeMenu();
  const c = e.target.closest("[data-chat]");
  if (c) { currentChat = chats.find((x) => x.id === c.dataset.chat); renderChatList(); renderChat(); closeMenu(); closeClassic(); return; }
  const m = e.target.closest("[data-menu]"); if (!m) return;
  if (m.dataset.menu === "new") { closeMenu(); freshStart(); return; }
  openClassic(m.dataset.menu);
});
$("#btn-back-chat").addEventListener("click", closeClassic);
function freshStart() {
  // محادثة جديدة = مشروع جديد (المواقع المنشورة تبقى بقسم «مواقعي»)
  build.versions = []; build.idx = -1; build.slug = null; build.url = null; saveBuild(); setPreview(); closePreview();
  closeClassic(); newChat(); $("#chat-text").focus();
}
$("#btn-new-top").addEventListener("click", freshStart);
$("#sp-close").addEventListener("click", closePreview);
$("#sp-undo").addEventListener("click", () => { if (build.idx > 0) { build.idx--; saveBuild(); setPreview(); } });
$("#sp-redo").addEventListener("click", () => { if (build.idx < build.versions.length - 1) { build.idx++; saveBuild(); setPreview(); } });
$("#sp-publish").addEventListener("click", async () => {
  const b = $("#sp-publish"); b.disabled = true; b.textContent = "⏳…";
  try { const had = !!build.slug; const url = await publishCurrent(); toast(had ? "تم تحديث الموقع ✓" : "تم النشر ✓"); try { await navigator.clipboard.writeText(url); } catch { } }
  catch (e) { toast(e.message, true); }
  b.disabled = false; b.textContent = "🚀 نشر";
});
$("#sp-copy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(build.url); toast("تم نسخ الرابط"); } catch { } });
$$("#sp-device button").forEach((b) => b.addEventListener("click", () => {
  $$("#sp-device button").forEach((x) => x.classList.toggle("active", x === b));
  $("#preview").style.maxWidth = b.dataset.w;
}));
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-open-preview]")) openPreview();
  const q = e.target.closest(".hero-chips [data-q]");
  if (q) { $("#chat-text").value = q.dataset.q; $("#chat-form").requestSubmit(); }
});
