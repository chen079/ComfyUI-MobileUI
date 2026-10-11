"use strict";

const $ = (id) => document.getElementById(id);
const SEED_NAMES = new Set(["seed", "noise_seed"]);
const LABELS = {
  seed: "种子", noise_seed: "种子", steps: "步数", cfg: "CFG",
  sampler_name: "采样器", scheduler: "调度器", denoise: "降噪",
  width: "宽度", height: "高度", batch_size: "批次",
  ckpt_name: "模型", unet_name: "模型",
};

// crypto.randomUUID is unavailable on plain-HTTP LAN origins.
const clientId = (crypto.randomUUID ? crypto.randomUUID() : Array.from({ length: 4 }, () => Math.random().toString(16).slice(2, 10)).join("")).replace(/-/g, "");

const state = { workflow: null, promptId: null, running: false, previewUrl: null };

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem("mobileui:" + key));
    localStorage.setItem("mobileui:" + key, JSON.stringify(value));
  } catch (e) {
    return null;
  }
}

function setStatus(text, cls = "") {
  $("status").textContent = text;
  $("status").className = cls;
}

function setProgress(fraction) {
  $("progress").hidden = fraction === null;
  $("progress-bar").style.width = ((fraction || 0) * 100).toFixed(1) + "%";
}

function ctrlId(w) {
  return "w-" + w.node_id + "-" + w.widget;
}

async function getJSON(url, options) {
  const res = await fetch(url, options);
  let body = null;
  try { body = await res.json(); } catch (e) { /* non-JSON body */ }
  return { ok: res.ok, status: res.status, body };
}

function randomSeed() {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

function makeControl(w) {
  let el;
  if (w.type === "combo") {
    el = document.createElement("select");
    const options = w.options.includes(w.value) ? w.options : [w.value, ...w.options];
    for (const opt of options) {
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
    el.step = w.type === "INT" ? (w.step || 1) : "any";
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
    const row = document.createElement("div");
    row.className = "seed-row";
    const dice = document.createElement("button");
    dice.type = "button";
    dice.textContent = "🎲";
    dice.setAttribute("aria-label", "随机种子");
    dice.onclick = () => { el.value = randomSeed(); saveForm(); };
    row.append(el, dice);

    const rnd = document.createElement("label");
    rnd.className = "seed-random";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = el.id + "-random";
    cb.checked = true;
    rnd.append(cb, "每次生成随机");
    field.append(row, rnd);
    return field;
  }

  if (el.tagName === "TEXTAREA" || w.type === "STRING") field.classList.add("wide");
  field.appendChild(el);
  return field;
}

function renderForm(wf) {
  const promptBox = $("prompt-params");
  const common = $("common-params");
  const other = $("other-params-body");
  promptBox.textContent = common.textContent = other.textContent = "";

  const saved = store("values:" + wf.id) || {};
  const widgets = wf.widgets;
  const groupOrder = { positive: 0, negative: 1 };

  widgets
    .filter((w) => w.group === "positive" || w.group === "negative")
    .sort((a, b) => groupOrder[a.group] - groupOrder[b.group])
    .forEach((w) => {
      const label = w.group === "positive" ? "正向提示词" : "负向提示词";
      promptBox.appendChild(makeField(w, label));
    });

  const commonCount = {};
  for (const w of widgets) if (w.group === "common") commonCount[w.widget] = (commonCount[w.widget] || 0) + 1;

  for (const w of widgets) {
    if (w.group === "common") {
      let label = LABELS[w.widget] || w.widget;
      if (commonCount[w.widget] > 1) label += " · " + w.title;
      common.appendChild(makeField(w, label));
    } else if (w.group === "other") {
      other.appendChild(makeField(w, w.title + " · " + w.widget));
    }
  }
  $("other-params").hidden = !other.childElementCount;

  for (const w of widgets) {
    const el = $(ctrlId(w));
    const key = w.node_id + "/" + w.widget;
    setValue(el, w, key in saved ? saved[key] : w.value);
    const rnd = $(ctrlId(w) + "-random");
    if (rnd && "random:" + key in saved) rnd.checked = saved["random:" + key];
  }
}

function saveForm() {
  const wf = state.workflow;
  if (!wf) return;
  const values = {};
  for (const w of wf.widgets) {
    const el = $(ctrlId(w));
    if (!el) continue;
    const key = w.node_id + "/" + w.widget;
    values[key] = readValue(el, w);
    const rnd = $(ctrlId(w) + "-random");
    if (rnd) values["random:" + key] = rnd.checked;
  }
  store("values:" + wf.id, values);
}

async function loadWorkflow(id) {
  $("run-btn").disabled = true;
  setStatus("加载中…");
  const res = await getJSON("/mobileui/api/workflows/" + encodeURIComponent(id));
  if (!res.ok) {
    setStatus((res.body && res.body.error) || "加载工作流失败", "error");
    return;
  }
  state.workflow = res.body;
  store("last", id);
  renderForm(res.body);
  setStatus("");
  $("run-btn").disabled = false;
}

async function loadList() {
  let res;
  try {
    res = await getJSON("/mobileui/api/workflows");
  } catch (e) {
    setStatus("无法连接 ComfyUI：" + e.message, "error");
    return;
  }
  const list = res.body || [];
  const sel = $("workflow-select");
  sel.textContent = "";
  if (!list.length) {
    setStatus("workflows 目录中没有工作流。\n请在 ComfyUI 中用「导出 (API)」保存 JSON 到\ncustom_nodes/ComfyUI-MobileUI/workflows/", "error");
    return;
  }
  for (const wf of list) {
    const o = document.createElement("option");
    o.value = wf.id;
    o.textContent = wf.name;
    sel.appendChild(o);
  }
  const last = store("last");
  if (list.some((wf) => wf.id === last)) sel.value = last;
  await loadWorkflow(sel.value);
}

function buildPrompt() {
  const wf = state.workflow;
  const prompt = structuredClone(wf.prompt);
  for (const w of wf.widgets) {
    const el = $(ctrlId(w));
    const rnd = $(ctrlId(w) + "-random");
    if (rnd && rnd.checked) el.value = randomSeed();
    prompt[w.node_id].inputs[w.widget] = readValue(el, w);
  }
  saveForm();
  return prompt;
}

function formatSubmitError(body) {
  if (!body) return "提交失败";
  const lines = [];
  if (body.error) lines.push(body.error.message || String(body.error));
  for (const [nodeId, ne] of Object.entries(body.node_errors || {})) {
    for (const e of ne.errors || []) {
      lines.push(`[${ne.class_type || nodeId}] ${e.message}${e.details ? "：" + e.details : ""}`);
    }
  }
  return lines.join("\n") || "提交失败";
}

function setRunning(running) {
  state.running = running;
  const btn = $("run-btn");
  btn.textContent = running ? "中断" : "生成";
  btn.classList.toggle("stop", running);
  $("workflow-select").disabled = running;
  if (!running) {
    state.promptId = null;
    setProgress(null);
  }
}

function showPreview(blob) {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(blob);
  $("result").innerHTML = "";
  const img = document.createElement("img");
  img.src = state.previewUrl;
  $("result").appendChild(img);
}

function showImages(outputs) {
  const result = $("result");
  result.innerHTML = "";
  for (const out of Object.values(outputs || {})) {
    for (const im of out.images || []) {
      const params = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder || "", type: im.type || "output" });
      const url = "/api/view?" + params;
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      const img = document.createElement("img");
      img.src = url;
      img.loading = "lazy";
      a.appendChild(img);
      result.appendChild(a);
    }
  }
  return result.childElementCount;
}

function executionError(status) {
  for (const [event, data] of (status && status.messages) || []) {
    if (event === "execution_error") return `[${data.node_type}] ${data.exception_message}`;
    if (event === "execution_interrupted") return "已中断";
  }
  return "执行失败";
}

async function pollHistory(promptId) {
  while (state.promptId === promptId) {
    let entry;
    try {
      const res = await getJSON("/api/history/" + promptId);
      entry = res.body && res.body[promptId];
    } catch (e) { /* transient network error, keep polling */ }

    if (entry && entry.status && entry.status.completed !== undefined) {
      if (entry.status.status_str === "success") {
        const n = showImages(entry.outputs);
        setStatus(n ? "完成" : "完成（没有图片输出，工作流中需要 SaveImage / PreviewImage 节点）", n ? "ok" : "error");
      } else {
        setStatus(executionError(entry.status), "error");
      }
      setRunning(false);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function run() {
  if (state.running) {
    const promptId = state.promptId;
    if (!promptId) return;
    const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    // /interrupt only affects the running prompt; also drop it if it is still queued.
    await post("/api/queue", { delete: [promptId] });
    await post("/api/interrupt", { prompt_id: promptId });
    const queue = await getJSON("/api/queue");
    const pending = (queue.body && queue.body.queue_pending) || [];
    const running = (queue.body && queue.body.queue_running) || [];
    if (![...pending, ...running].some((item) => item[1] === promptId)) {
      // Removed before it started: no history entry will ever appear.
      setRunning(false);
      setStatus("已取消");
    } else {
      setStatus("正在中断…");
    }
    return;
  }

  setRunning(true);
  setStatus("提交中…");
  let res;
  try {
    res = await getJSON("/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: buildPrompt(), client_id: clientId }),
    });
  } catch (e) {
    setRunning(false);
    setStatus("网络错误：" + e.message, "error");
    return;
  }
  if (!res.ok) {
    setRunning(false);
    setStatus(formatSubmitError(res.body), "error");
    return;
  }
  state.promptId = res.body.prompt_id;
  setStatus("排队中…");
  setProgress(0);
  pollHistory(state.promptId);
}

function connectSocket() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws?clientId=${clientId}`);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (ev) => {
    if (!state.running) return;
    if (typeof ev.data !== "string") {
      // Binary event 1 = preview image: [event u32][image type u32][bytes]
      const view = new DataView(ev.data);
      if (view.getUint32(0) === 1) {
        const mime = view.getUint32(4) === 2 ? "image/png" : "image/jpeg";
        showPreview(new Blob([ev.data.slice(8)], { type: mime }));
      }
      return;
    }
    const msg = JSON.parse(ev.data);
    const data = msg.data || {};
    if (data.prompt_id && data.prompt_id !== state.promptId) return;
    if (msg.type === "execution_start") {
      setStatus("运行中…");
    } else if (msg.type === "progress") {
      setProgress(data.value / data.max);
      setStatus(`运行中… ${data.value}/${data.max}`);
    }
  };
  ws.onclose = () => setTimeout(connectSocket, 2000);
}

$("workflow-select").onchange = (e) => loadWorkflow(e.target.value);
$("params-form").addEventListener("change", saveForm);
$("run-btn").onclick = run;

connectSocket();
loadList();
