"use strict";

const $ = (id) => document.getElementById(id);
const SEED_NAMES = new Set(["seed", "noise_seed"]);
const LABELS = {
  seed: "种子", noise_seed: "种子", steps: "步数", cfg: "CFG",
  sampler_name: "采样器", scheduler: "调度器", denoise: "降噪",
  width: "宽度", height: "高度", batch_size: "批次",
  ckpt_name: "模型", unet_name: "模型",
};
const STORE_NS = "comfywebui:";

const clientId = (crypto.randomUUID ? crypto.randomUUID() : Array.from({ length: 4 }, () =>
  Math.random().toString(16).slice(2, 10)).join("")).replace(/-/g, "");

const state = {
  workflow: null, promptId: null, running: false,
  previewUrl: null, workflows: [], historyImgs: store("history") ?? [], historyIdx: 0,
};

// ── Storage ────────────────────────────────────────────────────────────────
function store(key, value) {
  try {
    if (value === undefined) {
      const raw = localStorage.getItem(STORE_NS + key);
      return raw == null ? null : JSON.parse(raw);
    }
    localStorage.setItem(STORE_NS + key, JSON.stringify(value));
  } catch (_) {}
}

// ── Tab switching (mobile only) ────────────────────────────────────────────
function setTab(name) {
  document.body.dataset.tab = name;
  for (const btn of document.querySelectorAll(".tabs [data-tab]"))
    btn.setAttribute("aria-selected", btn.dataset.tab === name);
  if (name === "result") $("tab-dot").hidden = true;
}
document.querySelectorAll(".tabs [data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => setTab(btn.dataset.tab));
});

// ── Overlay / status ──────────────────────────────────────────────────────
function showOverlay(text, progress) {
  $("overlay").hidden = false;
  $("overlay-text").textContent = text;
  $("overlay-bar").style.width = progress == null ? "0%" : (progress * 100).toFixed(1) + "%";
}
function hideOverlay() { $("overlay").hidden = true; }

function showBanner(text, cls = "") {
  const el = $("banner");
  el.textContent = text; el.className = "banner" + (cls ? " " + cls : ""); el.hidden = !text;
}


// ── Form controls ──────────────────────────────────────────────────────────
function ctrlId(w) { return "w-" + w.node_id + "-" + w.widget; }

function makeControl(w) {
  let el;
  if (w.type === "combo") {
    el = document.createElement("select");
    const opts = Array.isArray(w.options) && w.options.length ? w.options : [w.value];
    const have = opts.includes(w.value);
    for (const opt of (have ? opts : [w.value, ...opts])) {
      const o = document.createElement("option");
      o.value = o.textContent = String(opt);
      el.appendChild(o);
    }
  } else if (w.type === "BOOLEAN") {
    el = document.createElement("input");
    el.type = "checkbox"; el.className = "switch";
  } else if (w.type === "INT" || w.type === "FLOAT") {
    el = document.createElement("input");
    el.type = "number"; el.inputMode = w.type === "INT" ? "numeric" : "decimal";
    if (w.min !== undefined) el.min = w.min;
    if (w.max !== undefined && w.max <= Number.MAX_SAFE_INTEGER) el.max = w.max;
    el.step = w.type === "INT" ? (w.step ?? 1) : "any";
  } else if (w.multiline || w.group === "positive" || w.group === "negative") {
    el = document.createElement("textarea");
    el.rows = w.group === "negative" ? 4 : 6;
  } else {
    el = document.createElement("input"); el.type = "text";
  }
  el.id = ctrlId(w);
  return el;
}

function setValue(el, w, value) {
  if (w.type === "BOOLEAN") el.checked = !!value;
  else el.value = value ?? "";
}

function readValue(el, w) {
  if (w.type === "BOOLEAN") return el.checked;
  if (w.type === "INT" || w.type === "FLOAT") return el.value === "" ? w.value : Number(el.value);
  if (w.type === "combo" && typeof w.value === "number") return Number(el.value);
  return el.value;
}

function makeField(w, label) {
  const field = document.createElement("div");
  field.className = "field";
  const lab = document.createElement("label");
  lab.textContent = label;
  const el = makeControl(w);
  lab.htmlFor = el.id;

  // Prompt textareas
  if (w.group === "positive" || w.group === "negative") {
    field.classList.add("wide", "prompt", w.group);
    field.appendChild(lab); field.appendChild(el);
    return field;
  }

  // Boolean — toggle layout
  if (w.type === "BOOLEAN") {
    field.classList.add("check", "wide");
    field.appendChild(lab); field.appendChild(el);
    return field;
  }

  // Seed
  if (SEED_NAMES.has(w.widget) && w.type === "INT") {
    field.classList.add("wide");
    field.appendChild(lab);
    const row = document.createElement("div"); row.className = "input-group";
    const dice = document.createElement("button");
    dice.type = "button"; dice.className = "icon-btn"; dice.setAttribute("aria-label", "随机种子");
    dice.innerHTML = '<svg><use href="#i-dice"/></svg>';
    dice.onclick = () => { el.value = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER); saveForm(); };
    row.append(el, dice);
    const rndLabel = document.createElement("label"); rndLabel.className = "seed-random";
    const sw = document.createElement("input"); sw.type = "checkbox"; sw.className = "switch";
    sw.id = el.id + "-random"; sw.checked = true;
    rndLabel.append(sw, "每次生成随机");
    field.append(row, rndLabel);
    return field;
  }

  field.appendChild(lab);
  if (el.tagName === "TEXTAREA" || w.type === "STRING") field.classList.add("wide");
  field.appendChild(el);
  return field;
}

// ── Form render ────────────────────────────────────────────────────────────
function renderForm(wf) {
  $("prompt-params").textContent = "";
  $("common-params").textContent = "";
  $("other-params-body").textContent = "";

  const saved = store("values:" + wf.path) ?? {};
  const counts = {};
  for (const w of wf.widgets) {
    const key = w.group === "common" ? w.widget : w.group;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const suffix = (key, w) => counts[key] > 1 ? " · " + w.title : "";

  let otherCount = 0;
  for (const w of wf.widgets) {
    let target, label;
    if (w.group === "positive")      { target = $("prompt-params");   label = "正向提示词" + suffix("positive", w); }
    else if (w.group === "negative") { target = $("prompt-params");   label = "负向提示词" + suffix("negative", w); }
    else if (w.group === "common")   { target = $("common-params");   label = (LABELS[w.widget] ?? w.widget) + suffix(w.widget, w); }
    else                             { target = $("other-params-body"); label = (w.title !== w.widget ? w.title + " · " : "") + w.widget; otherCount++; }
    target.appendChild(makeField(w, label));
  }

  $("other-params").hidden = !otherCount;
  $("other-count").textContent = otherCount || "";
  $("common-wrap").hidden = !$("common-params").childElementCount;

  for (const w of wf.widgets) {
    const el = $(ctrlId(w)); if (!el) continue;
    const key = w.node_id + "/" + w.widget;
    setValue(el, w, key in saved ? saved[key] : w.value);
    const rnd = $(ctrlId(w) + "-random");
    if (rnd && ("random:" + key) in saved) rnd.checked = saved["random:" + key];
  }
  applyOtherFilter();
}

function saveForm() {
  const wf = state.workflow; if (!wf) return;
  const values = {};
  for (const w of wf.widgets) {
    const el = $(ctrlId(w)); if (!el) continue;
    const key = w.node_id + "/" + w.widget;
    values[key] = readValue(el, w);
    const rnd = $(ctrlId(w) + "-random");
    if (rnd) values["random:" + key] = rnd.checked;
  }
  store("values:" + wf.path, values);
}

function applyOtherFilter() {
  const q = ($("other-filter").value ?? "").toLowerCase();
  for (const field of $("other-params-body").querySelectorAll(".field")) {
    const lbl = field.querySelector("label")?.textContent.toLowerCase() ?? "";
    field.hidden = q.length > 0 && !lbl.includes(q);
  }
}

// ── Workflow list rendering (sidebar + picker) ─────────────────────────────
function renderWfList(containerId, workflows, activeCat, q) {
  const el = $(containerId); el.textContent = "";
  const lq = q.toLowerCase();
  const visible = workflows.filter((w) => {
    const matchCat = !activeCat || activeCat === "全部" || w.category === activeCat;
    const matchQ = !lq || w.name.toLowerCase().includes(lq) || (w.category || "").toLowerCase().includes(lq);
    return matchCat && matchQ;
  });
  if (!visible.length) {
    el.innerHTML = '<div class="empty">没有匹配的工作流</div>'; return;
  }
  for (const wf of visible) {
    const btn = document.createElement("button");
    btn.type = "button";
    if (state.workflow?.path === wf.path) btn.classList.add("current");
    btn.innerHTML = '<svg><use href="#i-layers"/></svg><span class="wf-text"><span class="wf-name"></span><span class="wf-cat"></span></span>';
    btn.querySelector(".wf-name").textContent = wf.name;
    btn.querySelector(".wf-cat").textContent = wf.category;
    btn.onclick = () => { closePicker(); loadWorkflow(wf.path); };
    el.appendChild(btn);
  }
}

function renderChips(containerId, workflows, activeCat, onSelect) {
  const el = $(containerId); el.textContent = "";
  const cats = ["全部", ...new Set(workflows.map((w) => w.category).filter(Boolean))].sort();
  for (const cat of cats) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.textContent = cat || "根目录";
    btn.className = cat === activeCat ? "active" : "";
    btn.onclick = () => onSelect(cat);
    el.appendChild(btn);
  }
}

// ── Sidebar (desktop) ──────────────────────────────────────────────────────
let sideCat = "全部", sideQ = "";
function refreshSidebar() {
  renderChips("side-cats", state.workflows, sideCat, (cat) => { sideCat = cat; refreshSidebar(); });
  renderWfList("side-list", state.workflows, sideCat, sideQ);
}
$("side-search").oninput = (e) => { sideQ = e.target.value; refreshSidebar(); };

// ── Picker (mobile/tablet) ─────────────────────────────────────────────────
let pickerCat = "全部";
function openPicker() {
  renderChips("picker-cats", state.workflows, pickerCat, (cat) => { pickerCat = cat; renderWfList("picker-list", state.workflows, pickerCat, $("picker-search").value); });
  $("picker-search").value = "";
  renderWfList("picker-list", state.workflows, pickerCat, "");
  $("picker").hidden = false; $("picker-search").focus();
  document.addEventListener("keydown", onPickerKey);
}
function closePicker() { $("picker").hidden = true; document.removeEventListener("keydown", onPickerKey); }
function onPickerKey(e) { if (e.key === "Escape") closePicker(); }
$("picker-search").oninput = (e) => renderWfList("picker-list", state.workflows, pickerCat, e.target.value);
$("picker-close").onclick = closePicker;
$("picker").onclick = (e) => { if (e.target === $("picker")) closePicker(); };
$("workflow-btn").onclick = openPicker;

// ── Workflow load ──────────────────────────────────────────────────────────
async function loadWorkflow(path) {
  $("run-btn").disabled = true;
  let res;
  try { res = await fetch("/webui/api/workflow?path=" + encodeURIComponent(path)); }
  catch (e) { showBanner("网络错误：" + e.message, "error"); return; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { showBanner(data.error ?? "加载工作流失败", "error"); return; }
  state.workflow = data;
  store("last", path);
  const meta = state.workflows.find((w) => w.path === path) ?? {};
  // Topbar (mobile)
  $("top-cat").textContent = meta.category ?? "";
  $("top-name").textContent = meta.name ?? path;
  // Panel head (desktop)
  $("panel-cat").textContent = meta.category ?? "";
  $("panel-name").textContent = meta.name ?? path;
  renderForm(data);
  refreshSidebar();
  showBanner("");
  $("run-btn").disabled = false;
}

async function loadList() {
  let res;
  try { res = await fetch("/webui/api/workflows"); }
  catch (e) { showBanner("无法连接 ComfyUI：" + e.message, "error"); return; }
  state.workflows = await res.json().catch(() => []);
  if (!state.workflows.length) {
    showBanner("没有找到任何工作流。请在 ComfyUI 中保存至少一个工作流后刷新。", "error"); return;
  }
  refreshSidebar();
  const last = store("last");
  const first = state.workflows.find((w) => w.path === last) ?? state.workflows[0];
  if (first) await loadWorkflow(first.path);
}

// ── Build prompt ───────────────────────────────────────────────────────────
function formatDate(fmt, d) {
  const p = { d: d.getDate(), M: d.getMonth() + 1, h: d.getHours(), m: d.getMinutes(), s: d.getSeconds() };
  return fmt.replace(/dd?|MM?|hh?|mm?|ss?|yyy?y?/g, (t) => {
    if (t === "yy") return String(d.getFullYear()).substring(2);
    if (t === "yyyy") return String(d.getFullYear());
    return t[0] in p ? String(p[t[0]]).padStart(t.length, "0") : t;
  });
}

function applyTextReplacements(prompt, text) {
  const now = new Date();
  return text.replace(/%([^%]+)%/g, (match, token) => {
    const split = token.split(".");
    if (split.length !== 2) return split[0].startsWith("date:") ? formatDate(split[0].substring(5), now) : match;
    const node = Object.values(prompt).find((n) => n._meta?.title === split[0])
      ?? Object.values(prompt).find((n) => n.class_type === split[0]);
    const value = node?.inputs[split[1]];
    if (value === undefined || Array.isArray(value)) return match;
    return String(value).replaceAll(/[/?<>\\:*|"\x00-\x1F\x7F]/g, "_");
  });
}

function buildPrompt() {
  const wf = state.workflow;
  const prompt = JSON.parse(JSON.stringify(wf.prompt));
  for (const w of wf.widgets) {
    const el = $(ctrlId(w)); if (!el) continue;
    const rnd = $(ctrlId(w) + "-random");
    if (rnd?.checked) el.value = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    prompt[w.node_id].inputs[w.widget] = readValue(el, w);
  }
  for (const node of Object.values(prompt)) {
    const prefix = node.inputs.filename_prefix;
    if (typeof prefix === "string" && prefix.includes("%"))
      node.inputs.filename_prefix = applyTextReplacements(prompt, prefix);
  }
  saveForm();
  return prompt;
}

function formatSubmitError(body) {
  if (!body) return "提交失败";
  const lines = [];
  if (body.error) lines.push(body.error.message ?? String(body.error));
  for (const [id, ne] of Object.entries(body.node_errors ?? {}))
    for (const e of ne.errors ?? [])
      lines.push(`[${ne.class_type ?? id}] ${e.message}${e.details ? "：" + e.details : ""}`);
  return lines.join("\n") || "提交失败";
}

// ── Canvas helpers ─────────────────────────────────────────────────────────
function showCanvasEmpty() {
  $("canvas-empty").hidden = false;
  $("canvas-img").hidden = true;
}

function setRunning(on) {
  state.running = on;
  $("run-icon").querySelector("use").setAttribute("href", on ? "#i-stop" : "#i-sparkle");
  $("run-label").textContent = on ? "中断" : "生成";
  $("run-btn").classList.toggle("stop", on);
  if (!on) { state.promptId = null; hideOverlay(); }
}

function showPreview(blob) {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(blob);
  const img = $("canvas-img");
  img.src = state.previewUrl; img.className = "preview"; img.hidden = false;
  $("canvas-empty").hidden = true;
  showOverlay($("overlay-text").textContent, null);
}

function showMainImage(url) {
  const img = $("canvas-img");
  img.src = url; img.className = ""; img.hidden = false;
  $("canvas-empty").hidden = true;
}

const HISTORY_MAX = 60;
function pushHistory(urls) {
  state.historyImgs = [...urls, ...state.historyImgs.filter((u) => !urls.includes(u))].slice(0, HISTORY_MAX);
  state.historyIdx = 0;
  store("history", state.historyImgs);
  renderHistory();
}

function renderHistory() {
  const strip = $("history"); strip.textContent = "";
  $("history-wrap").hidden = !state.historyImgs.length;
  state.historyImgs.forEach((url, i) => {
    const btn = document.createElement("button");
    btn.type = "button"; if (i === state.historyIdx) btn.classList.add("active");
    const img = document.createElement("img"); img.src = url; img.loading = "lazy";
    btn.appendChild(img);
    btn.onclick = () => { state.historyIdx = i; showMainImage(url); renderHistory(); };
    strip.appendChild(btn);
  });
}

$("history-clear").onclick = () => { state.historyImgs = []; state.historyIdx = 0; store("history", []); renderHistory(); showCanvasEmpty(); };
$("canvas-img").onclick = () => {
  if ($("canvas-img").classList.contains("preview")) return;
  openViewer(state.historyImgs[state.historyIdx], state.historyImgs);
};

// ── Viewer ─────────────────────────────────────────────────────────────────
let viewerUrls = [], viewerIdx = 0;

function openViewer(url, urls = [url]) {
  viewerUrls = urls; viewerIdx = urls.indexOf(url);
  updateViewer(); $("viewer").hidden = false;
  document.addEventListener("keydown", onViewerKey);
}
function closeViewer() {
  $("viewer").hidden = true; document.removeEventListener("keydown", onViewerKey);
}
function updateViewer() {
  const url = viewerUrls[viewerIdx];
  $("viewer-img").src = url;
  $("viewer-download").href = url;
  $("viewer-open").href = url;
  $("viewer-count").textContent = viewerUrls.length > 1 ? `${viewerIdx + 1} / ${viewerUrls.length}` : "";
  $("viewer-prev").hidden = viewerUrls.length < 2;
  $("viewer-next").hidden = viewerUrls.length < 2;
}
function onViewerKey(e) {
  if (e.key === "Escape") closeViewer();
  else if (e.key === "ArrowLeft") { viewerIdx = (viewerIdx - 1 + viewerUrls.length) % viewerUrls.length; updateViewer(); }
  else if (e.key === "ArrowRight") { viewerIdx = (viewerIdx + 1) % viewerUrls.length; updateViewer(); }
}
$("viewer-close").onclick = closeViewer;
$("viewer").onclick = (e) => { if (e.target === $("viewer")) closeViewer(); };
$("viewer-prev").onclick = (e) => { e.stopPropagation(); viewerIdx = (viewerIdx - 1 + viewerUrls.length) % viewerUrls.length; updateViewer(); };
$("viewer-next").onclick = (e) => { e.stopPropagation(); viewerIdx = (viewerIdx + 1) % viewerUrls.length; updateViewer(); };

// ── Results ────────────────────────────────────────────────────────────────
function showImages(outputs) {
  const allUrls = [];
  for (const out of Object.values(outputs ?? {}))
    for (const im of out.images ?? []) {
      const params = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder ?? "", type: im.type ?? "output" });
      allUrls.push("/api/view?" + params);
    }
  if (!allUrls.length) return 0;
  showMainImage(allUrls[0]);
  pushHistory(allUrls);
  if (document.body.dataset.tab !== "result") $("tab-dot").hidden = false;
  return allUrls.length;
}

// ── Execution error ────────────────────────────────────────────────────────
function executionError(status) {
  for (const [event, data] of (status?.messages ?? [])) {
    if (event === "execution_error") return `[${data.node_type}] ${data.exception_message}`;
    if (event === "execution_interrupted") return "已中断";
  }
  return "执行失败";
}

// ── Poll ───────────────────────────────────────────────────────────────────
async function pollHistory(promptId) {
  while (state.promptId === promptId) {
    let entry;
    try {
      const r = await fetch("/api/history/" + promptId);
      const h = await r.json().catch(() => ({}));
      entry = h[promptId];
    } catch (_) {}
    if (entry?.status?.completed !== undefined) {
      hideOverlay();
      if (entry.status.status_str === "success") {
        const n = showImages(entry.outputs);
        showBanner(n ? "" : "完成，但没有图片输出（工作流需要 SaveImage 节点）", n ? "" : "error");
      } else {
        showBanner(executionError(entry.status), "error");
        showCanvasEmpty();
      }
      setRunning(false); return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ── Run ────────────────────────────────────────────────────────────────────
async function run() {
  if (state.running) {
    const pid = state.promptId; if (!pid) return;
    const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await post("/api/queue", { delete: [pid] });
    await post("/api/interrupt", { prompt_id: pid });
    const q = await fetch("/api/queue").then((r) => r.json()).catch(() => ({}));
    const all = [...(q.queue_running ?? []), ...(q.queue_pending ?? [])];
    if (!all.some((item) => item[1] === pid)) { setRunning(false); hideOverlay(); showBanner("已取消"); }
    else showOverlay("正在中断…", null);
    return;
  }
  setTab("result");
  setRunning(true); showBanner(""); showOverlay("提交中…", 0);
  let res, body;
  try {
    res = await fetch("/api/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: buildPrompt(), client_id: clientId }) });
    body = await res.json().catch(() => ({}));
  } catch (e) { setRunning(false); hideOverlay(); showBanner("网络错误：" + e.message, "error"); return; }
  if (!res.ok) { setRunning(false); hideOverlay(); showBanner(formatSubmitError(body), "error"); return; }
  state.promptId = body.prompt_id;
  showOverlay("排队中…", 0);
  pollHistory(state.promptId);
}

// ── WebSocket ─────────────────────────────────────────────────────────────
function connectSocket() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws?clientId=${clientId}`);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (ev) => {
    if (!state.running) return;
    if (typeof ev.data !== "string") {
      const view = new DataView(ev.data);
      if (view.getUint32(0) === 1) {
        const mime = view.getUint32(4) === 2 ? "image/png" : "image/jpeg";
        showPreview(new Blob([ev.data.slice(8)], { type: mime }));
      }
      return;
    }
    const msg = JSON.parse(ev.data); const data = msg.data ?? {};
    if (data.prompt_id && data.prompt_id !== state.promptId) return;
    if (msg.type === "execution_start") showOverlay("运行中…", 0);
    else if (msg.type === "progress") {
      showOverlay(`${data.value} / ${data.max}`, data.value / data.max);
    }
  };
  ws.onclose = () => setTimeout(connectSocket, 2000);
}

// ── Keyboard shortcuts ─────────────────────────────────────────────────────
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !$("run-btn").disabled) { e.preventDefault(); run(); }
});

// ── Wire-up ───────────────────────────────────────────────────────────────
$("params-form").addEventListener("change", saveForm);
$("run-btn").onclick = run;
$("other-filter").oninput = applyOtherFilter;

renderHistory();
if (state.historyImgs.length) showMainImage(state.historyImgs[0]);
connectSocket();
loadList();
