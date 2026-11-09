// Histogram tab of the table: views, bars, wind rose, calendar.
//
// Classic script, loaded with defer: all js/*.js files share one global scope
// and run in the order index.html lists them, after the page is parsed.

// ---- Histograms tab ----
// Same filters and summary as the table; the rows below the header are
// replaced by a stack of views, each of one unfiltered column. Views count
// sequences (runs of consecutive hours that pass the filters, see keepRuns),
// not hours: each sequence counts once, by the median of the column over its
// hours. Speeds are 1-kn histograms with the median marked, hours of day are
// bars, directions a 16-sector wind rose and days a calendar.
const HIST_COLOR = "#3987e5", HIST_SURFACE = "#1a2640";
const HIST_MUTED = "#8a99b5", HIST_GRID = "rgba(255,255,255,0.07)";
const FC_KEYS = ["fdir", "fw", "fg"], M_KEYS = ["mdir", "mw", "mg"];
const HIST_ORDER = ["mw", "mdir", "hour", "mg", "fw", "fdir", "fg", "day"];
const colByKey = Object.fromEntries(TBL_COLS.map((c) => [c.key, c]));
const colName = (k) => (FC_KEYS.includes(k) ? "Previsão · " : M_KEYS.includes(k) ? "Medido · " : "") + colByKey[k].label;
const histKind = (k) => colByKey[k].kind; // kn | dir | hour | day
const hist = { views: [] };
const f1 = (v) => v.toFixed(1).replace(".", ",");
const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);
const seqWord = (n) => `${n.toLocaleString("pt-BR")} sequência${n === 1 ? "" : "s"}`;

const isFiltered = (k) => filterActive(colByKey[k], tbl.filters[k]);
const availableKeys = () => HIST_ORDER.filter((k) => !isFiltered(k));

// The measured mean when the forecast is being filtered, the forecast mean
// when the measurement is (and the measured mean when neither or both).
function defaultKey(taken = []) {
  const fcOn = FC_KEYS.some(isFiltered), mOn = M_KEYS.some(isFiltered);
  const pref = mOn && !fcOn ? "fw" : "mw";
  const avail = availableKeys();
  if (avail.includes(pref) && !taken.includes(pref)) return pref;
  return avail.find((k) => !taken.includes(k)) ?? avail[0] ?? pref;
}

// ---- One value per sequence: the median ----
// Directions: the median of the angles unwrapped around their mean (so a
// run swinging through north isn't averaged to south), wrapped back.
function dirMedian(vals) {
  let u = 0, v = 0;
  for (const d of vals) { u += Math.sin(d * RAD); v += Math.cos(d * RAD); }
  const ref = u || v ? Math.atan2(u, v) / RAD : vals[0];
  const rel = vals.map((d) => ((((d - ref) % 360) + 540) % 360) - 180).sort((a, b) => a - b);
  return (((ref + quantile(rel, 0.5)) % 360) + 360) % 360;
}

// Hour and day are those of the run's middle time (rows are hourly and in
// time order, so the middle row, or the earlier of the two middle ones).
function runValue(run, key) {
  const kind = histKind(key);
  if (kind === "hour" || kind === "day") return run[Math.floor((run.length - 1) / 2)][key];
  const vals = run.map((r) => r[key]).filter((v) => v != null);
  if (!vals.length) return null;
  if (kind === "dir") return dirMedian(vals);
  return quantile(vals.sort((a, b) => a - b), 0.5);
}

function addView(key = null) {
  const view = { key, auto: key == null, kind: null, chart: null, draw: null, hit: null };
  const el = document.createElement("div");
  el.className = "hist-view";
  el.innerHTML = `<div class="hist-head"><h3></h3><div class="hist-ctrl">
      <select aria-label="Grandeza do histograma"></select>
      <button class="btn sm hist-x" title="Remover visualização" aria-label="Remover visualização">×</button></div></div>
    <div class="hist-body"></div><div class="hist-note"></div><div class="hist-tip" hidden></div>`;
  Object.assign(view, {
    el, title: el.querySelector("h3"), select: el.querySelector("select"), body: el.querySelector(".hist-body"),
    note: el.querySelector(".hist-note"), tip: el.querySelector(".hist-tip"),
  });
  view.select.addEventListener("change", () => { view.key = view.select.value; view.auto = false; renderHists(tbl.runs); });
  el.querySelector(".hist-x").addEventListener("click", () => removeView(view));
  // Redraw custom canvases on resize; skip while the tab is hidden (zero width).
  new ResizeObserver(() => view.draw && view.body.clientWidth > 0 && view.draw()).observe(view.body);
  document.getElementById("histViews").appendChild(el);
  hist.views.push(view);
  if (view.auto) view.key = defaultKey(hist.views.filter((v) => v !== view).map((v) => v.key));
  return view;
}

function removeView(view) {
  if (view.chart) view.chart.destroy();
  view.el.remove();
  hist.views = hist.views.filter((v) => v !== view);
  if (!hist.views.length) { addView(); renderHists(tbl.runs); }
}

function renderHists(runs) {
  if (!hist.views.length) addView();
  const avail = availableKeys();
  hist.views.forEach((view, i) => {
    // An automatic view follows the default; a chosen one falls back to it
    // once its column gets filtered.
    if (view.auto || !avail.includes(view.key)) {
      view.key = defaultKey(i === 0 ? [] : hist.views.slice(0, i).map((v) => v.key));
      view.auto = true;
    }
    view.select.innerHTML = avail.map((k) => `<option value="${k}"${k === view.key ? " selected" : ""}>${colName(k)}</option>`).join("");
    view.title.innerHTML = colName(view.key);
    renderView(view, runs);
  });
}

function setViewKind(view, kind) {
  if (view.kind === kind) return;
  if (view.chart) { view.chart.destroy(); view.chart = null; }
  view.body.innerHTML = "";
  view.body.className = `hist-body${kind === "dir" ? " rose" : ""}`;
  view.body.style.height = "";
  view.canvas = document.createElement("canvas");
  view.body.appendChild(view.canvas);
  view.draw = view.hit = null;
  view.kind = kind;
  if (kind === "dir" || kind === "day") {
    view.canvas.addEventListener("mousemove", (e) => {
      const r = view.canvas.getBoundingClientRect();
      const text = view.hit && view.hit(e.clientX - r.left, e.clientY - r.top);
      showTip(view, text, e);
    });
    view.canvas.addEventListener("mouseleave", () => showTip(view, null));
  }
}

function showTip(view, html, e) {
  if (!html) { view.tip.hidden = true; return; }
  view.tip.innerHTML = html;
  view.tip.hidden = false;
  const box = view.el.getBoundingClientRect();
  let x = e.clientX - box.left + 14, y = e.clientY - box.top + 14;
  x = Math.min(x, box.width - view.tip.offsetWidth - 6);
  view.tip.style.left = `${Math.max(6, x)}px`;
  view.tip.style.top = `${y}px`;
}

function renderView(view, runs) {
  const kind = histKind(view.key);
  setViewKind(view, kind);
  const empty = view.body.querySelector(".hist-empty");
  if (empty) empty.remove();
  if (!runs.length) {
    view.note.textContent = "";
    view.body.insertAdjacentHTML("beforeend", `<div class="hist-empty">Nenhuma sequência com esses filtros.</div>`);
  }
  if (kind === "kn") renderSpeed(view, runs);
  else if (kind === "hour") renderHours(view, runs);
  else if (kind === "dir") renderRose(view, runs);
  else renderCalendar(view, runs);
}

// ---- Bars (speeds, hours) ----
const barDataset = (data) => ({
  label: "sequências", data, backgroundColor: HIST_COLOR, hoverBackgroundColor: HIST_COLOR,
  borderColor: HIST_SURFACE, borderWidth: 1, borderRadius: 3, borderSkipped: "start",
  barPercentage: 1, categoryPercentage: 0.92,
});

// Dashed median marker on a 1-kn histogram.
const medianPlugin = {
  id: "histMedian",
  afterDatasetsDraw(chart) {
    const m = chart.$median;
    if (!m) return;
    const { ctx, chartArea: a, scales: { x } } = chart;
    const w = x.getPixelForValue(1) - x.getPixelForValue(0);
    const px = x.getPixelForValue(0) - w / 2 + (m.value - m.b0) * w;
    ctx.save();
    ctx.strokeStyle = "rgba(232,238,249,0.85)";
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, a.top + 14); ctx.lineTo(px, a.bottom); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#e8eef9";
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = px > a.right - 90 ? "right" : "left";
    ctx.fillText(`mediana ${f1(m.value)}`, px + (ctx.textAlign === "left" ? 5 : -5), a.top + 10);
    ctx.restore();
  },
};

function barChart(view, labels, counts, tooltip, xTitle) {
  const data = { labels, datasets: [barDataset(counts)] };
  if (view.chart) {
    view.chart.data = data;
    view.chart.options.plugins.tooltip.callbacks = tooltip;
    view.chart.options.scales.x.title.text = xTitle;
    view.chart.update("none");
    return;
  }
  view.chart = new Chart(view.canvas, {
    type: "bar", data, plugins: [medianPlugin],
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { grid: { display: false }, ticks: { color: HIST_MUTED, maxRotation: 0, autoSkipPadding: 6 },
             title: { display: true, text: xTitle, color: HIST_MUTED } },
        y: { beginAtZero: true, grid: { color: HIST_GRID }, ticks: { color: HIST_MUTED, precision: 0 },
             title: { display: true, text: "sequências", color: HIST_MUTED } },
      },
      plugins: { legend: { display: false }, tooltip: { callbacks: tooltip } },
    },
  });
}

function renderSpeed(view, runs) {
  const key = view.key;
  const vals = runs.map((run) => runValue(run, key)).filter((v) => v != null).sort((a, b) => a - b);
  if (!vals.length) { view.chart && (view.chart.$median = null); barChart(view, [], [], {}, "nós"); return; }
  const b0 = Math.floor(vals[0]), n = Math.floor(vals[vals.length - 1]) - b0 + 1;
  const counts = new Array(n).fill(0);
  for (const v of vals) counts[Math.floor(v) - b0] += 1;
  const atLeast = (x) => vals.length - posOf({ values: vals }, x); // values sorted ascending
  const median = quantile(vals, 0.5);
  barChart(view, counts.map((_, i) => String(b0 + i)), counts, {
    title: (items) => (items.length ? `${b0 + items[0].dataIndex}–${b0 + items[0].dataIndex + 1} nós` : ""),
    label: (it) => `${seqWord(it.raw)} (${pct(it.raw, vals.length)}%)`,
    footer: (items) => (items.length
      ? `${pct(atLeast(b0 + items[0].dataIndex), vals.length)}% das sequências com mediana ≥ ${b0 + items[0].dataIndex}` : ""),
  }, `${colName(key)}, mediana da sequência (nós)`);
  view.chart.$median = { value: median, b0 };
  view.chart.update("none");
  view.title.innerHTML = `${colName(key)}<span class="stat">mediana ${f1(median)} · metade entre ${f1(quantile(vals, 0.25))} e ${f1(quantile(vals, 0.75))} nós</span>`;
  view.note.textContent = "Faixas de 1 nó. Cada sequência conta uma vez, pela mediana dessa coluna nas horas dela.";
}

function renderHours(view, runs) {
  const counts = new Array(24).fill(0);
  for (const run of runs) counts[runValue(run, "hour")] += 1;
  barChart(view, counts.map((_, h) => `${pad2(h)}h`), counts, {
    title: (items) => (items.length ? `${pad2(items[0].dataIndex)}h` : ""),
    label: (it) => `${seqWord(it.raw)} (${pct(it.raw, runs.length)}%)`,
  }, "hora do meio da sequência");
  view.chart.$median = null;
  view.chart.update("none");
  const best = counts.reduce((b, v, h) => (v > counts[b] ? h : b), 0);
  view.title.innerHTML = `Hora do dia${runs.length ? `<span class="stat">mais sequências às ${pad2(best)}h (${pct(counts[best], runs.length)}%)</span>` : ""}`;
  view.note.textContent = "Em que hora do dia fica o meio de cada sequência.";
}

// ---- Custom canvases (rose, calendar) ----
function prepCanvas(view, height) {
  const dpr = window.devicePixelRatio || 1;
  const w = view.body.clientWidth, h = height ?? view.body.clientHeight;
  if (height != null) view.body.style.height = `${height}px`;
  view.canvas.width = Math.round(w * dpr);
  view.canvas.height = Math.round(h * dpr);
  view.canvas.style.width = `${w}px`;
  view.canvas.style.height = `${h}px`;
  const ctx = view.canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function niceStep(x) {
  const p = 10 ** Math.floor(Math.log10(x)), f = x / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

// Wind rose: sector area = share of the sequences whose median direction
// falls in it (radius on a square-root scale, so one dominant sector
// doesn't flatten the rest).
function renderRose(view, runs) {
  const key = view.key;
  const counts = new Array(16).fill(0);
  let total = 0;
  for (const run of runs) {
    const d = runValue(run, key);
    if (d == null) continue;
    counts[compassIndex(d)] += 1;
    total += 1;
  }
  const who = key === "fdir" ? "previsto" : "medido";
  let geo = null;
  view.draw = () => {
    const { ctx, w, h } = prepCanvas(view);
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 30;
    geo = { cx, cy, R };
    if (!total) return;
    const maxPct = Math.max(...counts) / total * 100;
    const step = niceStep(maxPct / 4), top = Math.ceil(maxPct / step) * step;
    const radius = (p) => R * Math.sqrt(p / top);
    const rad = (deg) => (deg - 90) * RAD;
    ctx.strokeStyle = HIST_GRID;
    ctx.lineWidth = 1;
    for (let i = 0; i < 16; i++) {
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.lineTo(cx + R * Math.cos(rad(i * 22.5)), cy + R * Math.sin(rad(i * 22.5))); ctx.stroke();
    }
    for (let p = step; p <= top + 1e-9; p += step) {
      ctx.beginPath(); ctx.arc(cx, cy, radius(p), 0, 2 * Math.PI); ctx.stroke();
    }
    for (let i = 0; i < 16; i++) {
      const r1 = radius((counts[i] / total) * 100);
      if (r1 <= 0) continue;
      const a0 = rad(i * 22.5 - 10.5), a1 = rad(i * 22.5 + 10.5);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r1, a0, a1);
      ctx.closePath();
      ctx.fillStyle = HIST_COLOR;
      ctx.fill();
      ctx.strokeStyle = HIST_SURFACE;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    // Ring labels just inside each ring, beside the north spoke.
    ctx.fillStyle = HIST_MUTED;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "left";
    for (let p = step; p <= top + 1e-9; p += step) ctx.fillText(`${Number(p.toFixed(1))}%`, cx + 4, cy - radius(p) + 12);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    COMPASS.forEach((name, i) => {
      const main = i % 2 === 0;
      ctx.fillStyle = main ? "#e8eef9" : HIST_MUTED;
      ctx.font = `${main ? 600 : 400} ${main ? 12 : 10}px system-ui, sans-serif`;
      ctx.fillText(name, cx + (R + 16) * Math.cos(rad(i * 22.5)), cy + (R + 16) * Math.sin(rad(i * 22.5)));
    });
    ctx.textBaseline = "alphabetic";
  };
  view.hit = (x, y) => {
    if (!geo || !total) return null;
    const dx = x - geo.cx, dy = y - geo.cy, dist = Math.hypot(dx, dy);
    if (dist > geo.R + 24 || dist < 4) return null;
    const i = Math.round(((Math.atan2(dx, -dy) / RAD + 360) % 360) / 22.5) % 16;
    return `<b>Vento ${who} de ${COMPASS[i]}</b> (${i * 22.5}°)<br>${seqWord(counts[i])} · ${pct(counts[i], total)}%`;
  };
  view.draw();
  const best = counts.reduce((b, v, i) => (v > counts[b] ? i : b), 0);
  view.title.innerHTML = `${colName(key)}${total ? `<span class="stat">de onde vem · mais de ${COMPASS[best]} (${pct(counts[best], total)}%)</span>` : ""}`;
  view.note.textContent = `Área de cada fatia: parte das sequências cuja direção ${key === "fdir" ? "prevista" : "medida"} mediana cai naquele setor (16 setores).`;
}

// Calendar: one cell per day (weeks across, Monday on top); strength = how
// many sequences have their middle on that day.
function renderCalendar(view, runs) {
  const byDay = new Map();
  for (const run of runs) {
    const dn = runValue(run, "day");
    const d = byDay.get(dn) || { n: 0, hours: 0, max: 0 };
    d.n += 1;
    d.hours += run.length;
    for (const r of run) d.max = Math.max(d.max, r.mw);
    byDay.set(dn, d);
  }
  const first = colByKey.day.min, last = colByKey.day.max;
  const row = (dn) => (new Date(dn * 864e5).getUTCDay() + 6) % 7; // Monday = 0
  const start = first - row(first);
  const weeks = Math.floor((last - start) / 7) + 1;
  const maxN = Math.max(1, ...[...byDay.values()].map((d) => d.n));
  const LEFT = 30, TOP = 18;
  let geo = null;
  view.draw = () => {
    const w = view.body.clientWidth;
    const cell = Math.max(6, Math.min(22, Math.floor((w - LEFT - 4) / weeks)));
    const height = TOP + 7 * cell + 6;
    const { ctx } = prepCanvas(view, height);
    geo = { cell };
    const gap = cell > 10 ? 3 : 2;
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = HIST_MUTED;
    ctx.textBaseline = "middle";
    ["seg", "", "qua", "", "sex", "", "dom"].forEach((t, i) => t && ctx.fillText(t, 0, TOP + i * cell + (cell - gap) / 2));
    ctx.textBaseline = "alphabetic";
    for (let dn = first; dn <= last; dn++) {
      const wk = Math.floor((dn - start) / 7), x = LEFT + wk * cell, y = TOP + row(dn) * cell;
      const date = new Date(dn * 864e5);
      if (date.getUTCDate() === 1 || dn === first) {
        ctx.fillStyle = HIST_MUTED;
        ctx.fillText(MONTHS[date.getUTCMonth()], x, TOP - 6);
      }
      const d = byDay.get(dn);
      ctx.globalAlpha = d ? 0.35 + 0.65 * (d.n / maxN) : 1;
      ctx.fillStyle = d ? HIST_COLOR : "rgba(255,255,255,0.05)";
      ctx.beginPath();
      ctx.roundRect(x, y, cell - gap, cell - gap, Math.min(3, cell / 5));
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  };
  view.hit = (x, y) => {
    if (!geo) return null;
    const wk = Math.floor((x - LEFT) / geo.cell), rw = Math.floor((y - TOP) / geo.cell);
    if (wk < 0 || rw < 0 || rw > 6) return null;
    const dn = start + wk * 7 + rw;
    if (dn < first || dn > last) return null;
    const d = byDay.get(dn), date = new Date(dn * 864e5);
    const label = `<b>${WEEKDAYS[date.getUTCDay()]} ${dayLabel(dn)}</b>`;
    return d ? `${label}<br>${seqWord(d.n)} · ${d.hours} h<br>maior médio medido: ${f1(d.max)} nós`
      : `${label}<br>nenhuma sequência`;
  };
  view.draw();
  view.title.innerHTML = `Dia<span class="stat">${byDay.size} dias com sequências</span>`;
  view.note.textContent = "Intensidade: quantas sequências têm o meio naquele dia.";
}

function setTab(tab) {
  tbl.tab = tab;
  document.querySelectorAll(".tbl-tabs [data-tab]").forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on);
  });
  document.getElementById("histTable").classList.toggle("hist-mode", tab === "hist");
  document.getElementById("histPanel").hidden = tab !== "hist";
  renderTable();
}

document.querySelectorAll(".tbl-tabs [data-tab]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
document.getElementById("histAdd").addEventListener("click", () => { addView(); renderHists(tbl.runs); });
