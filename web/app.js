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

const clientId = (crypto.randomUUID ? crypto.randomUUID() : Array.from({ length: 4 }, () => Math.random().toString(16).slice(2, 10)).join("")).replace(/-/g, "");

const state = { workflow: null, promptId: null, running: false, previewUrl: null, workflows: [] };

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

// ── Status / progress ─────────────────────────────────────────────────────
function setStatus(text, cls = "") {
  $("status").textContent = text;
  $("status").className = cls;
}

function setProgress(fraction) {
  $("progress").hidden = fraction === null;
  $("progress-bar").style.width = ((fraction ?? 0) * 100).toFixed(1) + "%";
}

// ── Form control helpers ──────────────────────────────────────────────────
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
    el.type = "checkbox";
  } else if (w.type === "INT" || w.type === "FLOAT") {
    el = document.createElement("input");
    el.type = "number";
    el.inputMode = w.type === "INT" ? "numeric" : "decimal";
    if (w.min !== undefined) el.min = w.min;
    if (w.max !== undefined && w.max <= Number.MAX_SAFE_INTEGER) el.max = w.max;
    el.step = w.type === "INT" ? (w.step ?? 1) : "any";
  } else if (w.multiline || w.group === "positive" || w.group === "negative") {
    el = document.createElement("textarea");
    el.rows = w.group === "negative" ? 3 : 5;
  } else {
    el = document.createElement("input");
    el.type = "text";
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

  if (w.type === "BOOLEAN") {
    field.classList.add("check");
    field.append(el, lab);
    return field;
  }
  field.appendChild(lab);

  if (SEED_NAMES.has(w.widget) && w.type === "INT") {
    field.classList.add("wide");
    const row = document.createElement("div"); row.className = "seed-row";
    const dice = document.createElement("button");
    dice.type = "button"; dice.textContent = "🎲"; dice.setAttribute("aria-label", "随机种子");
    dice.onclick = () => { el.value = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER); saveForm(); };
    row.append(el, dice);
    const rndLabel = document.createElement("label"); rndLabel.className = "seed-random";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.id = el.id + "-random"; cb.checked = true;
    rndLabel.append(cb, "每次生成随机");
    field.append(row, rndLabel);
    return field;
  }

  if (el.tagName === "TEXTAREA" || w.type === "STRING") field.classList.add("wide");
  field.appendChild(el);
  return field;
}

// ── Form render ───────────────────────────────────────────────────────────
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
  // Workflows with several samplers or prompts get the node title appended to tell them apart.
  const suffix = (key, w) => (counts[key] > 1 ? " · " + w.title : "");

  for (const w of wf.widgets) {
    let target, label;
    if (w.group === "positive") { target = $("prompt-params"); label = "正向提示词" + suffix("positive", w); }
    else if (w.group === "negative") { target = $("prompt-params"); label = "负向提示词" + suffix("negative", w); }
    else if (w.group === "common") { target = $("common-params"); label = (LABELS[w.widget] ?? w.widget) + suffix(w.widget, w); }
    else { target = $("other-params-body"); label = (w.title !== w.widget ? w.title + " · " : "") + w.widget; }
    target.appendChild(makeField(w, label));
  }

  $("other-params").hidden = !$("other-params-body").childElementCount;

  for (const w of wf.widgets) {
    const el = $(ctrlId(w));
    if (!el) continue;
    const key = w.node_id + "/" + w.widget;
    setValue(el, w, key in saved ? saved[key] : w.value);
    const rnd = $(ctrlId(w) + "-random");
    if (rnd && ("random:" + key) in saved) rnd.checked = saved["random:" + key];
  }

  applyOtherFilter();
}

function saveForm() {
  const wf = state.workflow;
  if (!wf) return;
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

// ── Workflow picker ────────────────────────────────────────────────────────
function buildPicker(workflows, activeCat, q) {
  const cats = ["全部", ...new Set(workflows.map((w) => w.category).filter(Boolean))].sort();
  const chips = $("picker-cats");
  chips.textContent = "";
  for (const cat of cats) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.textContent = cat || "根目录";
    btn.className = cat === activeCat ? "active" : "";
    btn.onclick = () => buildPicker(workflows, cat, q);
    chips.appendChild(btn);
  }

  const lq = q.toLowerCase();
  const visible = workflows.filter((w) => {
    const matchCat = !activeCat || activeCat === "全部" || w.category === activeCat;
    const matchQ = !lq || w.name.toLowerCase().includes(lq) || (w.category || "").toLowerCase().includes(lq);
    return matchCat && matchQ;
  });

  const list = $("picker-list");
  list.textContent = "";
  if (!visible.length) {
    const li = document.createElement("li"); li.innerHTML = '<span class="empty">没有匹配的工作流</span>';
    list.appendChild(li); return;
  }
  for (const wf of visible) {
    const li = document.createElement("li");
    if (state.workflow?.path === wf.path) li.classList.add("current");
    li.innerHTML = `<span>${wf.name}</span>${wf.category ? `<span class="meta">${wf.category}</span>` : ""}`;
    li.onclick = () => { closePicker(); loadWorkflow(wf.path); };
    list.appendChild(li);
  }
}

let pickerCat = "全部";
function openPicker() {
  buildPicker(state.workflows, pickerCat, "");
  $("picker-search").value = "";
  $("picker").hidden = false;
  $("picker-search").focus();
  document.addEventListener("keydown", onPickerKey);
}
function closePicker() {
  $("picker").hidden = true;
  document.removeEventListener("keydown", onPickerKey);
}
function onPickerKey(e) { if (e.key === "Escape") closePicker(); }

$("picker-search").oninput = (e) => buildPicker(state.workflows, pickerCat, e.target.value);
$("picker-close").onclick = closePicker;
$("picker").onclick = (e) => { if (e.target === $("picker")) closePicker(); };
$("workflow-btn").onclick = openPicker;

// ── Workflow load ─────────────────────────────────────────────────────────
async function loadWorkflow(path) {
  $("run-btn").disabled = true;
  setStatus("加载中…");
  let res;
  try { res = await fetch("/webui/api/workflow?path=" + encodeURIComponent(path)); }
  catch (e) { setStatus("网络错误：" + e.message, "error"); return; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { setStatus((data.error ?? "加载工作流失败"), "error"); return; }
  state.workflow = data;
  store("last", path);
  const { name, category } = state.workflows.find((w) => w.path === path) ?? {};
  $("workflow-category").textContent = category ?? "";
  $("workflow-name").textContent = name ?? path;
  renderForm(data);
  setStatus("");
  $("run-btn").disabled = false;
}

async function loadList() {
  let res;
  try { res = await fetch("/webui/api/workflows"); }
  catch (e) { setStatus("无法连接 ComfyUI：" + e.message, "error"); return; }
  state.workflows = (await res.json().catch(() => []));
  if (!state.workflows.length) {
    setStatus("没有找到任何工作流。请在 ComfyUI 中保存至少一个工作流后刷新。", "error");
    return;
  }
  const last = store("last");
  const first = state.workflows.find((w) => w.path === last) ?? state.workflows[0];
  if (first) await loadWorkflow(first.path);
}

// ── Submit / run ──────────────────────────────────────────────────────────
// Same token rules as the frontend's formatDate / applyTextReplacements.
function formatDate(fmt, d) {
  const parts = { d: d.getDate(), M: d.getMonth() + 1, h: d.getHours(), m: d.getMinutes(), s: d.getSeconds() };
  return fmt.replace(/dd?|MM?|hh?|mm?|ss?|yyy?y?/g, (t) => {
    if (t === "yy") return String(d.getFullYear()).substring(2);
    if (t === "yyyy") return String(d.getFullYear());
    return t[0] in parts ? String(parts[t[0]]).padStart(t.length, "0") : t;
  });
}

function applyTextReplacements(prompt, text) {
  const now = new Date();
  return text.replace(/%([^%]+)%/g, (match, token) => {
    const split = token.split(".");
    if (split.length !== 2) return split[0].startsWith("date:") ? formatDate(split[0].substring(5), now) : match;
    const node = Object.values(prompt).find((n) => n._meta?.title === split[0]) ?? Object.values(prompt).find((n) => n.class_type === split[0]);
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
    if (typeof prefix === "string" && prefix.includes("%")) node.inputs.filename_prefix = applyTextReplacements(prompt, prefix);
  }
  saveForm();
  return prompt;
}

function formatSubmitError(body) {
  if (!body) return "提交失败";
  const lines = [];
  if (body.error) lines.push(body.error.message ?? String(body.error));
  for (const [id, ne] of Object.entries(body.node_errors ?? {})) {
    for (const e of ne.errors ?? [])
      lines.push(`[${ne.class_type ?? id}] ${e.message}${e.details ? "：" + e.details : ""}`);
  }
  return lines.join("\n") || "提交失败";
}

function setRunning(on) {
  state.running = on;
  $("run-btn").textContent = on ? "中断" : "生成";
  $("run-btn").classList.toggle("stop", on);
  if (!on) { state.promptId = null; setProgress(null); }
}

// ── Preview and result display ────────────────────────────────────────────
function showPreview(blob) {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(blob);
  const prev = $("preview"); prev.hidden = false; prev.textContent = "";
  const img = document.createElement("img"); img.src = state.previewUrl;
  prev.appendChild(img);
}

function showImages(outputs) {
  const result = $("result");
  result.textContent = "";
  let first = true;
  for (const out of Object.values(outputs ?? {})) {
    for (const im of out.images ?? []) {
      const params = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder ?? "", type: im.type ?? "output" });
      const url = "/api/view?" + params;
      const wrap = document.createElement("div");
      if (first) { wrap.className = "latest"; first = false; }
      const img = document.createElement("img");
      img.src = url; img.loading = "lazy";
      img.onclick = () => openViewer(url);
      wrap.appendChild(img); result.appendChild(wrap);
    }
  }
  $("preview").hidden = true;
  return result.childElementCount;
}

function executionError(status) {
  for (const [event, data] of (status?.messages ?? [])) {
    if (event === "execution_error") return `[${data.node_type}] ${data.exception_message}`;
    if (event === "execution_interrupted") return "已中断";
  }
  return "执行失败";
}

async function pollHistory(promptId) {
  while (state.promptId === promptId) {
    let entry;
    try {
      const r = await fetch("/api/history/" + promptId);
      const h = await r.json().catch(() => ({}));
      entry = h[promptId];
    } catch (_) { /* transient; keep polling */ }
    if (entry?.status?.completed !== undefined) {
      if (entry.status.status_str === "success") {
        const n = showImages(entry.outputs);
        setStatus(n ? "完成" : "完成（没有图片输出，工作流需要 SaveImage 节点）", n ? "ok" : "error");
      } else {
        setStatus(executionError(entry.status), "error");
      }
      setRunning(false); return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function run() {
  if (state.running) {
    const pid = state.promptId; if (!pid) return;
    const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await post("/api/queue", { delete: [pid] });
    await post("/api/interrupt", { prompt_id: pid });
    const q = await fetch("/api/queue").then((r) => r.json()).catch(() => ({}));
    const all = [...(q.queue_running ?? []), ...(q.queue_pending ?? [])];
    if (!all.some((item) => item[1] === pid)) { setRunning(false); setStatus("已取消"); }
    else setStatus("正在中断…");
    return;
  }
  setRunning(true); setStatus("提交中…");
  let res, body;
  try {
    res = await fetch("/api/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: buildPrompt(), client_id: clientId }) });
    body = await res.json().catch(() => ({}));
  } catch (e) { setRunning(false); setStatus("网络错误：" + e.message, "error"); return; }
  if (!res.ok) { setRunning(false); setStatus(formatSubmitError(body), "error"); return; }
  state.promptId = body.prompt_id;
  setStatus("排队中…"); setProgress(0);
  $("result").textContent = "";
  pollHistory(state.promptId);
}

// ── Image viewer ──────────────────────────────────────────────────────────
function openViewer(url) {
  $("viewer-img").src = url;
  $("viewer").hidden = false;
  document.addEventListener("keydown", onViewerKey);
}
function closeViewer() {
  $("viewer").hidden = true;
  document.removeEventListener("keydown", onViewerKey);
}
function onViewerKey(e) { if (e.key === "Escape") closeViewer(); }
$("viewer").onclick = closeViewer;

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
    if (msg.type === "execution_start") setStatus("运行中…");
    else if (msg.type === "progress") {
      setProgress(data.value / data.max);
      setStatus(`运行中… ${data.value}/${data.max}`);
    }
  };
  ws.onclose = () => setTimeout(connectSocket, 2000);
}

// ── Wire-up ───────────────────────────────────────────────────────────────
$("params-form").addEventListener("change", saveForm);
$("run-btn").onclick = run;
$("other-filter").oninput = applyOtherFilter;

connectSocket();
loadList();
