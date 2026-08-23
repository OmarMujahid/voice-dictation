/* voice — dictation log (vanilla JS, no deps) */
"use strict";

const $ = (s, el = document) => el.querySelector(s);

// ---------------------------------------------------------------- theme roles
const ROLE_META = [
  ["bg",         "page",          "behind everything"],
  ["surface",    "surface",       "cards + recording pill"],
  ["surface2",   "surface 2",     "pill gradient end"],
  ["border",     "border",        "hairlines"],
  ["accent",     "accent",        "waveforms, highlights"],
  ["accentDeep", "accent deep",   "REC label, hovers"],
  ["text",       "text",          "transcripts"],
  ["textDim",    "text dim",      "timestamps, labels"],
  ["ball",       "volleyball",    "the ball + button text"],
];
const DEFAULT_COLORS = {
  bg: "#f8eddd", surface: "#fdf4eaf0", surface2: "#fceddff0",
  border: "#ff872e8c", accent: "#ff7b28", accentDeep: "#ed651b",
  text: "#322820", textDim: "#64564ad9", ball: "#ffffff",
};
const CSS_VAR = {
  bg: "--bg", surface: "--surface", surface2: "--surface2", border: "--border",
  accent: "--accent", accentDeep: "--accent-deep",
  text: "--text", textDim: "--text-dim", ball: "--ball",
};

// ---------------------------------------------------------------- state
const state = {
  items: [], query: "",
  themes: [], active: "karasuno",
  recording: false, recStartedAt: null,
  toggleInFlight: false,
};
const peaksCache = new Map();      // stem → Float32Array
const cardByStem = new Map();      // stem → <article>
let canvasColors = null;           // cached computed colors for canvas drawing

// ---------------------------------------------------------------- utils
const esc = (s) => s.replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function fmtDur(s) {
  if (s == null) return "—";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
           : `${m}:${String(sec).padStart(2, "0")}`;
}
function fmtAirtime(s) {
  if (s < 60) return `${s}<small>s</small>`;
  if (s < 3600) return `${Math.round(s / 60)}<small>min</small>`;
  return `${Math.floor(s / 3600)}<small>h</small>${Math.round((s % 3600) / 60)}<small>m</small>`;
}
function fmtBytes(n) {
  if (n < 1 << 20) return `${Math.max(1, Math.round(n / 1024))}<small>KB</small>`;
  if (n < 1 << 30) return `${Math.round(n / (1 << 20))}<small>MB</small>`;
  return `${(n / (1 << 30)).toFixed(1)}<small>GB</small>`;
}
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
function dateLabel(iso) {
  const d = new Date(iso), now = new Date();
  const key = (x) => x.toDateString();
  if (key(d) === key(now)) return "TODAY";
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (key(d) === key(yest)) return "YESTERDAY";
  let label = `${DAYS[d.getDay()]} · ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (d.getFullYear() !== now.getFullYear()) label += ` ${d.getFullYear()}`;
  return label;
}
const timeHM = (iso) => iso.slice(11, 16);

let toastTimer = null;
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 4000 : 2400);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------- theming
function mergedColors(theme) {
  return { ...DEFAULT_COLORS, ...(theme?.colors || {}) };
}
function luminance(hex) {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function applyColors(colors) {
  const c = { ...DEFAULT_COLORS, ...colors };
  for (const [role, cssVar] of Object.entries(CSS_VAR)) {
    document.documentElement.style.setProperty(cssVar, c[role]);
  }
  document.documentElement.dataset.scheme = luminance(c.bg) < 0.45 ? "dark" : "light";
  canvasColors = null;
  redrawAllWaves();
}
function activeTheme() {
  return state.themes.find((t) => t.id === state.active);
}
function getCanvasColors() {
  if (!canvasColors) {
    const cs = getComputedStyle(document.documentElement);
    canvasColors = {
      accent: cs.getPropertyValue("--accent").trim(),
      accentDeep: cs.getPropertyValue("--accent-deep").trim(),
      dim: cs.getPropertyValue("--text-dim").trim(),
    };
  }
  return canvasColors;
}

// ---------------------------------------------------------------- waveforms
let audioCtx = null;
const decodeQueue = [];
let decodesActive = 0;
const MAX_DECODES = 3;
const MAX_DECODE_BYTES = 30 * 1024 * 1024;

function requestPeaks(stem) {
  if (peaksCache.has(stem) || decodeQueue.includes(stem)) return;
  decodeQueue.push(stem);
  pumpDecodes();
}
function pumpDecodes() {
  while (decodesActive < MAX_DECODES && decodeQueue.length) {
    const stem = decodeQueue.shift();
    decodesActive++;
    decodeStem(stem).finally(() => { decodesActive--; pumpDecodes(); });
  }
}
async function decodeStem(stem) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await (await fetch(`/api/audio/${stem}.wav`)).arrayBuffer();
    const audio = await audioCtx.decodeAudioData(buf);
    const data = audio.getChannelData(0);
    const COLS = 260;
    const step = Math.max(1, Math.floor(data.length / COLS));
    const stride = Math.max(1, Math.floor(step / 24));
    const peaks = new Float32Array(COLS);
    for (let c = 0; c < COLS; c++) {
      let max = 0;
      const end = Math.min((c + 1) * step, data.length);
      for (let i = c * step; i < end; i += stride) {
        const v = Math.abs(data[i]);
        if (v > max) max = v;
      }
      peaks[c] = max;
    }
    peaksCache.set(stem, peaks);
    const card = cardByStem.get(stem);
    if (card) revealWave(card, stem);
  } catch (e) {
    console.warn("waveform decode failed", stem, e);
  }
}
function revealWave(card, stem) {
  const t0 = performance.now(), DURATION = 380;
  const step = (now) => {
    const r = Math.min(1, (now - t0) / DURATION);
    drawWave(card, stem, currentProgress(stem), r);
    if (r < 1 && cardByStem.get(stem) === card) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function drawWave(card, stem, progress = 0, reveal = 1) {
  const canvas = $(".wave", card);
  const peaks = peaksCache.get(stem);
  if (!canvas || !peaks) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight || 56;
  if (!w) return;
  if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
  if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height, cy = H / 2;
  ctx.clearRect(0, 0, W, H);
  const colors = getCanvasColors();
  const n = peaks.length, colW = W / n;
  const barW = Math.max(colW * 0.62, 1.2 * dpr);
  const lastCol = Math.floor(n * reveal);
  for (let i = 0; i < lastCol; i++) {
    // Same envelope shaping as the native pill: gain 3.5, clamped.
    let amp = Math.min(peaks[i] * 3.5, 1) * (cy - 3 * dpr);
    amp = Math.max(amp, 0.9 * dpr);
    const played = (i + 0.5) / n <= progress;
    ctx.globalAlpha = played ? 1 : 0.5;
    ctx.fillStyle = played ? colors.accent : colors.dim;
    ctx.fillRect(i * colW, cy - amp, barW, amp * 2);
  }
  ctx.globalAlpha = 1;
  if (progress > 0 && progress < 1) {
    ctx.fillStyle = colors.accentDeep;
    ctx.fillRect(progress * W - 0.75 * dpr, 2 * dpr, 1.5 * dpr, H - 4 * dpr);
  }
}
function redrawAllWaves() {
  for (const [stem, card] of cardByStem) {
    if (peaksCache.has(stem)) drawWave(card, stem, currentProgress(stem));
  }
}
const waveObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) {
      const stem = e.target.closest(".card")?.dataset.stem;
      if (stem) { requestPeaks(stem); waveObserver.unobserve(e.target); }
    }
  }
}, { rootMargin: "300px" });

// ---------------------------------------------------------------- playback
const player = new Audio();
player.preload = "none";
let playingStem = null;
let rafId = null;

function itemDuration(stem) {
  const item = state.items.find((i) => i.name === stem);
  return item?.duration || player.duration || 0;
}
function currentProgress(stem) {
  if (stem !== playingStem) return 0;
  const d = itemDuration(stem);
  return d ? Math.min(player.currentTime / d, 1) : 0;
}
function progressLoop() {
  if (playingStem) {
    const card = cardByStem.get(playingStem);
    if (card) drawWave(card, playingStem, currentProgress(playingStem));
    rafId = requestAnimationFrame(progressLoop);
  }
}
function stopPlayback(redraw = true) {
  if (!playingStem) return;
  const prev = playingStem, prevCard = cardByStem.get(prev);
  playingStem = null;
  cancelAnimationFrame(rafId);
  player.pause();
  if (prevCard) {
    prevCard.classList.remove("playing");
    if (redraw && peaksCache.has(prev)) drawWave(prevCard, prev, 0);
  }
}
async function togglePlay(stem, card, seekRatio = null) {
  if (playingStem === stem && seekRatio === null) {
    if (player.paused) { await player.play().catch(() => {}); progressLoop(); }
    else { player.pause(); cancelAnimationFrame(rafId); }
    return;
  }
  if (playingStem === stem && seekRatio !== null) {
    player.currentTime = seekRatio * itemDuration(stem);
    if (player.paused) { await player.play().catch(() => {}); progressLoop(); }
    return;
  }
  stopPlayback();
  playingStem = stem;
  card.classList.add("playing");
  player.src = `/api/audio/${stem}.wav`;
  requestPeaks(stem);
  try {
    await player.play();
    if (seekRatio !== null) player.currentTime = seekRatio * itemDuration(stem);
    progressLoop();
  } catch (e) {
    stopPlayback();
    toast(`playback failed: ${e.message}`, true);
  }
}
player.addEventListener("ended", () => stopPlayback());

// ---------------------------------------------------------------- timeline
function matches(item, q) {
  if (!q) return true;
  return (item.text || "").toLowerCase().includes(q)
      || item.name.toLowerCase().includes(q)
      || dateLabel(item.ts).toLowerCase().includes(q);
}
function highlight(text, q) {
  if (!q) return esc(text);
  return esc(text).replace(new RegExp(escRe(esc(q)), "gi"), (m) => `<mark>${m}</mark>`);
}

function renderTimeline() {
  const timeline = $("#timeline");
  const tpl = $("#cardT");
  const q = state.query.trim().toLowerCase();
  const visible = state.items.filter((i) => matches(i, q));

  stopPlayback(false);
  cardByStem.clear();
  timeline.replaceChildren();

  $("#resultCount").textContent = q
    ? `${visible.length} / ${state.items.length}`
    : `${state.items.length} takes`;
  const empty = $("#empty");
  empty.hidden = visible.length > 0;
  if (!visible.length) {
    $("#emptyText").textContent = q
      ? `nothing matches “${state.query.trim()}”`
      : "nothing here yet — press the hotkey and start talking";
  }

  let lastDate = null, idx = 0;
  const frag = document.createDocumentFragment();
  for (const item of visible) {
    const dkey = item.ts.slice(0, 10);
    if (dkey !== lastDate) {
      lastDate = dkey;
      const chip = document.createElement("h2");
      chip.className = "dateChip";
      chip.textContent = dateLabel(item.ts);
      frag.appendChild(chip);
    }
    const card = tpl.content.firstElementChild.cloneNode(true);
    card.dataset.stem = item.name;
    card.style.setProperty("--i", Math.min(idx++, 20));
    $(".time", card).textContent = timeHM(item.ts);
    $(".dur", card).textContent = fmtDur(item.duration);

    const textEl = $(".text", card);
    if (item.text) {
      textEl.innerHTML = highlight(item.text, state.query.trim());
      if (item.text.length > 380) {
        textEl.classList.add("clampable");
        textEl.title = "click to expand";
        textEl.addEventListener("click", () => {
          if (String(window.getSelection())) return; // don't fight text selection
          textEl.classList.toggle("expanded");
        });
      }
    } else {
      textEl.classList.add("noText");
      textEl.textContent = item.hasAudio
        ? "no transcript — hit ↻ to transcribe" : "transcript missing";
    }

    const playBtn = $(".play", card);
    const canvas = $(".wave", card);
    if (item.hasAudio) {
      playBtn.addEventListener("click", () => togglePlay(item.name, card));
      canvas.addEventListener("click", (e) => {
        const r = canvas.getBoundingClientRect();
        togglePlay(item.name, card, (e.clientX - r.left) / r.width);
      });
      if (item.bytes <= MAX_DECODE_BYTES && item.duration) waveObserver.observe(canvas);
    } else {
      card.classList.add("noAudio");
      playBtn.disabled = true;
    }

    $(".copy", card).addEventListener("click", async () => {
      if (!item.text) return toast("no transcript to copy", true);
      await navigator.clipboard.writeText(item.text);
      toast("copied to clipboard");
    });
    $(".redo", card).addEventListener("click", (e) => retranscribe(item, e.currentTarget));
    $(".del", card).addEventListener("click", (e) => deleteItem(item, e.currentTarget));

    cardByStem.set(item.name, card);
    frag.appendChild(card);
    if (peaksCache.has(item.name)) {
      requestAnimationFrame(() => drawWave(card, item.name, 0));
    }
  }
  timeline.appendChild(frag);
}

async function refreshItems() {
  try {
    const data = await api("/api/items");
    state.items = data.items;
    $("#statCount").textContent = data.count;
    $("#statTime").innerHTML = fmtAirtime(data.seconds);
    $("#statBytes").innerHTML = fmtBytes(data.bytes);
    renderTimeline();
  } catch (e) {
    toast(`couldn't load items: ${e.message}`, true);
  }
}

async function retranscribe(item, btn) {
  if (btn.classList.contains("working")) return;
  btn.classList.add("working");
  try {
    const res = await api("/api/retranscribe", { method: "POST", body: { name: item.name } });
    item.text = res.text;
    renderTimeline();
    toast(res.text ? "re-transcribed" : "transcribed empty (silence?)", !res.text);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.classList.remove("working");
  }
}

function deleteItem(item, btn) {
  if (!btn.classList.contains("confirm")) {
    const orig = btn.innerHTML;
    btn.classList.add("confirm");
    btn.textContent = "sure?";
    setTimeout(() => {
      if (btn.isConnected && btn.classList.contains("confirm")) {
        btn.classList.remove("confirm");
        btn.innerHTML = orig;
      }
    }, 3000);
    return;
  }
  api(`/api/item/${item.name}`, { method: "DELETE" })
    .then(() => {
      if (playingStem === item.name) stopPlayback(false);
      state.items = state.items.filter((i) => i.name !== item.name);
      peaksCache.delete(item.name);
      renderTimeline();
      refreshItems(); // refresh scoreboard totals
      toast("deleted");
    })
    .catch((e) => toast(e.message, true));
}

// ---------------------------------------------------------------- record + status
const recBtn = $("#recBtn");
let recTimerInterval = null;

function setRecordingUI(recording) {
  state.recording = recording;
  recBtn.classList.toggle("recording", recording);
  $("#recTimer").hidden = !recording;
  clearInterval(recTimerInterval);
  if (recording) {
    if (!state.recStartedAt) state.recStartedAt = Date.now();
    recTimerInterval = setInterval(() => {
      $("#recTimer").textContent = fmtDur((Date.now() - state.recStartedAt) / 1000);
    }, 400);
  } else {
    state.recStartedAt = null;
  }
}
function setStatus(text, dotClass) {
  $("#statusText").textContent = text;
  $("#statusDot").className = `dot ${dotClass || ""}`;
}

async function pollStatus() {
  if (state.toggleInFlight || document.hidden) return;
  let st;
  try {
    st = await api("/api/status");
  } catch {
    setStatus("gui server unreachable", "off");
    return;
  }
  recBtn.disabled = !st.daemon;
  recBtn.classList.toggle("busy", !!st.busy);
  if (!st.daemon) {
    setRecordingUI(false);
    setStatus("daemon offline", "off");
    return;
  }
  if (st.busy) {
    if (state.recording) { setRecordingUI(false); scheduleItemRefresh(); }
    setStatus("transcribing…", "busy");
    return;
  }
  if (st.recording && !state.recording) setRecordingUI(true);
  if (!st.recording && state.recording) { setRecordingUI(false); scheduleItemRefresh(); }
  setStatus(st.recording ? "recording" : `idle · model ${st.model}`, st.recording ? "rec" : "");
}
function scheduleItemRefresh() {
  refreshItems();
  setTimeout(refreshItems, 3000);
}

recBtn.addEventListener("click", async () => {
  if (state.toggleInFlight) return;
  // The daemon types the transcript into the focused window — make sure that
  // isn't our search box.
  document.activeElement?.blur();
  state.toggleInFlight = true;
  const wasRecording = state.recording;
  if (wasRecording) {
    setRecordingUI(false);
    recBtn.classList.add("busy");
    setStatus("transcribing…", "busy");
  }
  try {
    const res = await api("/api/toggle", { method: "POST" });
    if (res.raw === "RECORDING") {
      state.recStartedAt = Date.now();
      setRecordingUI(true);
      setStatus("recording", "rec");
    } else {
      const raw = res.raw || "";
      if (raw.startsWith("OK")) toast(`typed ${raw.slice(3)}`);
      else if (raw.startsWith("TOO_SHORT")) toast("too short — kept the audio", true);
      else if (raw.startsWith("EMPTY")) toast("heard nothing in that one", true);
      else if (raw) toast(raw, raw.startsWith("ERROR"));
      scheduleItemRefresh();
    }
  } catch (e) {
    toast(e.message, true);
  } finally {
    state.toggleInFlight = false;
    recBtn.classList.remove("busy");
    pollStatus();
  }
});

// ---------------------------------------------------------------- themes UI
const drawer = $("#drawer"), backdrop = $("#backdrop");
let editing = null;

function openDrawer() {
  backdrop.hidden = false;
  requestAnimationFrame(() => { drawer.classList.add("open"); backdrop.classList.add("open"); });
}
function closeDrawer() {
  drawer.classList.remove("open");
  backdrop.classList.remove("open");
  setTimeout(() => { backdrop.hidden = true; }, 260);
  closeEditor();
}
$("#themesBtn").addEventListener("click", openDrawer);
$("#drawerClose").addEventListener("click", closeDrawer);
backdrop.addEventListener("click", closeDrawer);

const PILL_WAVE_POINTS = "0,9 6,7 12,11 18,4 24,13 30,8 36,5 42,12 48,7 54,10 60,3 66,12 72,8 78,6 84,11 90,9 96,5 102,12 108,8";
function pillPreviewHTML(colors) {
  const c = { ...DEFAULT_COLORS, ...colors };
  const vars = `--p-bg:${c.bg};--p-surface:${c.surface};--p-surface2:${c.surface2};` +
    `--p-border:${c.border};--p-accent:${c.accent};--p-accent-deep:${c.accentDeep};` +
    `--p-text:${c.text};--p-ball:${c.ball}`;
  return `<div class="pillStage" style="${vars}"><div class="pillPreview">
    <svg class="pBall" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28"/>
      <g class="seams"><path d="M6 32 C 18 48, 46 48, 58 32"/>
      <path d="M6 32 C 18 48, 46 48, 58 32" transform="rotate(120 32 32)"/>
      <path d="M6 32 C 18 48, 46 48, 58 32" transform="rotate(240 32 32)"/></g></svg>
    <span class="pRec">REC</span><span class="pTime">0:07</span>
    <svg class="pWave" viewBox="0 0 110 18" preserveAspectRatio="none"><polyline points="${PILL_WAVE_POINTS}"/></svg>
  </div></div>`;
}

function renderThemeGrid() {
  const grid = $("#themeGrid");
  grid.replaceChildren();
  for (const theme of state.themes) {
    const div = document.createElement("div");
    div.className = "themeCard" + (theme.id === state.active ? " active" : "");
    div.innerHTML = pillPreviewHTML(theme.colors) + `
      <div class="themeCardRow">
        <span class="tName">${esc(theme.name)}</span>
        ${theme.builtin ? '<span class="tTag">builtin</span>' : ""}
        <span class="grow"></span>
        <button class="ghost mini edit">edit</button>
        ${!theme.builtin ? '<button class="ghost mini kill">✕</button>' : ""}
      </div>`;
    div.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      setActiveTheme(theme);
    });
    $(".edit", div).addEventListener("click", () => openEditor(theme, theme.builtin));
    $(".kill", div)?.addEventListener("click", async () => {
      try {
        await api(`/api/themes/${theme.id}`, { method: "DELETE" });
        await loadThemes(false);
        renderThemeGrid();
        toast("theme deleted");
      } catch (e) { toast(e.message, true); }
    });
    grid.appendChild(div);
  }
}

async function setActiveTheme(theme) {
  try {
    await api("/api/theme", { method: "POST", body: { id: theme.id } });
    state.active = theme.id;
    applyColors(theme.colors);
    renderThemeGrid();
    toast(`theme: ${theme.name} — pill follows on next recording`);
  } catch (e) { toast(e.message, true); }
}

// -------- editor
function splitHex(v) {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v || "");
  if (!m) return { hex: "#888888", alpha: 100 };
  return { hex: `#${m[1]}`, alpha: m[2] ? Math.round(parseInt(m[2], 16) / 2.55) : 100 };
}
function joinHex(hex, alpha) {
  return alpha >= 100 ? hex.toLowerCase()
    : hex.toLowerCase() + Math.round(alpha * 2.55).toString(16).padStart(2, "0");
}
function openEditor(theme, asCopy) {
  editing = {
    id: asCopy ? null : theme.id,
    colors: mergedColors(theme),
  };
  $("#editorTitle").textContent = asCopy ? `new theme — based on ${theme.name}` : `edit ${theme.name}`;
  $("#themeName").value = asCopy ? `${theme.name} custom` : theme.name;
  const rows = $("#colorRows");
  rows.replaceChildren();
  for (const [role, label, desc] of ROLE_META) {
    const { hex, alpha } = splitHex(editing.colors[role]);
    const row = document.createElement("div");
    row.className = "colorRow";
    row.innerHTML = `
      <label>${label}<small>${desc}</small></label>
      <input type="color" value="${hex}" data-role="${role}">
      <input type="number" min="0" max="100" value="${alpha}" data-role="${role}" title="opacity %">`;
    rows.appendChild(row);
  }
  rows.oninput = () => {
    for (const [role] of ROLE_META) {
      const hex = $(`input[type="color"][data-role="${role}"]`).value;
      const alpha = Math.min(100, Math.max(0, +$(`input[type="number"][data-role="${role}"]`).value || 0));
      editing.colors[role] = joinHex(hex, alpha);
    }
    $("#editorStage").outerHTML = pillPreviewHTML(editing.colors).replace('class="pillStage"', 'class="pillStage" id="editorStage"');
    applyColors(editing.colors); // live preview on the whole page
  };
  $("#editorStage").outerHTML = pillPreviewHTML(editing.colors).replace('class="pillStage"', 'class="pillStage" id="editorStage"');
  $("#editor").hidden = false;
  $("#themeName").focus();
}
function closeEditor() {
  if (!editing) return;
  editing = null;
  $("#editor").hidden = true;
  applyColors(mergedColors(activeTheme())); // undo live preview
}
$("#cancelEdit").addEventListener("click", closeEditor);
$("#saveTheme").addEventListener("click", async () => {
  if (!editing) return;
  const name = $("#themeName").value.trim();
  if (!name) return toast("give it a name", true);
  try {
    const body = { name, colors: editing.colors };
    if (editing.id) body.id = editing.id;
    const res = await api("/api/themes", { method: "POST", body });
    await api("/api/theme", { method: "POST", body: { id: res.id } });
    state.active = res.id;
    editing = null;
    $("#editor").hidden = true;
    await loadThemes(); // applies active colors
    renderThemeGrid();
    toast(`saved — ${name} is live`);
  } catch (e) { toast(e.message, true); }
});

async function loadThemes(apply = true) {
  const data = await api("/api/themes");
  state.themes = data.themes;
  state.active = data.active;
  if (apply) applyColors(mergedColors(activeTheme()));
}

// ---------------------------------------------------------------- search + keys
let searchTimer = null;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = e.target.value;
    renderTimeline();
  }, 130);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (editing) closeEditor();
    else if (drawer.classList.contains("open")) closeDrawer();
    return;
  }
  if (e.key === "/" && !e.target.closest("input, textarea")) {
    e.preventDefault();
    $("#search").focus();
  }
});

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(redrawAllWaves, 150);
});

// ---------------------------------------------------------------- init
(async function init() {
  try { await loadThemes(); } catch { /* defaults already in CSS */ }
  renderThemeGrid();
  await refreshItems();
  pollStatus();
  setInterval(pollStatus, 2500);
})();
