// Hour-by-hour table: rows, range filters, sequences, rendering, summary.
//
// Classic script, loaded with defer: all js/*.js files share one global scope
// and run in the order index.html lists them, after the page is parsed.

// ---- Hour-by-hour table: forecast vs measured ----
// One row per forecast hour that has a measurement: the forecast at hh:00
// next to the station's 30-min readings of hh-1:30 and hh:00 (the hour the
// forecast gust covers). Built from the same 30-min chunks as the
// statistics and the forecast already loaded for the chart. Each column has
// a min/max range filter; the summary describes the measured wind of the
// rows left, which answers "when the forecast looked like this, what did
// the station get?".
const TBL_PAGE = 200;
const TBL_COLS = [
  { key: "day", label: "Dia", kind: "day" },
  { key: "hour", label: "Hora", kind: "hour", min: 0, max: 23, step: 1 },
  { key: "fdir", label: "Direção", kind: "dir", sep: true },
  { key: "fw", label: "Médio", kind: "kn", fine: [5, 15] },
  { key: "fg", label: "Rajada", kind: "kn", fine: [10, 25] },
  { key: "mdir", label: "Direção", kind: "dir", sep: true },
  { key: "mw", label: "Médio", kind: "kn", fine: [5, 15] },
  { key: "mg", label: "Rajada", kind: "kn", fine: [10, 25] },
];
for (const c of TBL_COLS) if (c.kind === "dir") Object.assign(c, { min: 0, max: 360, step: 5 });
const tbl = { rows: null, filtered: [], limit: TBL_PAGE, sort: { key: "ts", desc: true }, built: false, timer: null, filters: {}, tab: "table" };

const dayLabel = (dn) => { const d = new Date(dn * 864e5); return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${String(d.getUTCFullYear()).slice(2)}`; };
const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

function vectorMean(samples) {
  let u = 0, v = 0;
  for (const s of samples) {
    if (s.dir == null) continue;
    u += s.wind_knots * Math.sin(s.dir * RAD);
    v += s.wind_knots * Math.cos(s.dir * RAD);
  }
  return u || v ? (Math.atan2(u, v) / RAD + 360) % 360 : null;
}

function tblBuildRows() {
  const pts = new Map(); // ts -> point (chunk edges repeat a point)
  for (const s of chunkStarts("30min", sinceSec, nowSec())) {
    const c = chunks["30min"].get(s);
    if (c) for (const p of c.points) if (p.wind_knots != null) pts.set(p.ts, p);
  }
  const byHour = new Map();
  for (const p of pts.values()) {
    const h = Math.ceil(p.ts / 3600) * 3600; // hh:30 -> next hour, hh:00 -> itself
    if (!byHour.has(h)) byHour.set(h, []);
    byHour.get(h).push(p);
  }
  const rows = [];
  for (const f of fc.hours) {
    const m = byHour.get(f.ts);
    if (!m || f.ts > nowSec()) continue;
    const d = new Date(f.ts * 1000);
    const gusts = m.map((p) => p.gust_knots).filter((g) => g != null);
    rows.push({
      ts: f.ts, day: dayNumber(d), hour: d.getHours(), wd: d.getDay(),
      sun: sunElevation(f.ts - 900, station.lat, station.lon) > 0,
      fdir: f.dir, fw: f.wind_knots, fg: f.gust_knots,
      mdir: vectorMean(m), mw: m.reduce((a, p) => a + p.wind_knots, 0) / m.length,
      mg: gusts.length ? Math.max(...gusts) : null,
    });
  }
  tbl.rows = rows;
}

// ---- Range filters ----
// Moving a slider turns its filter on; the checkbox next to the range
// switches it off (and back on) without losing the slider positions.
//
// Sliders move over a list of values (c.values), one per position. Wind
// columns step 0.1 kn inside their band of interest (`fine`) and 0.5
// outside it, up to the highest value recorded rounded up, so the fine
// band gets most of the track.
function scaleValues(c, top) {
  const out = [];
  if (c.kind !== "kn") {
    for (let v = c.min; v <= c.max; v += c.step) out.push(v);
    return out;
  }
  const [a, b] = c.fine.map((v) => v * 10);
  for (let t = 0; t <= top * 10; t += t >= a && t < b ? 1 : 5) out.push(t / 10); // tenths: no float drift
  return out;
}

// Slider position of a value (the nearest one at or above it).
function posOf(c, v) {
  const i = c.values.findIndex((x) => x >= v - 1e-9);
  return i < 0 ? c.values.length - 1 : i;
}

// (Re)scale a column; a filter keeps its range, and one open at the top
// stays open at the new top.
function setScale(c, values) {
  const f = tbl.filters[c.key];
  const full = f && fullRange(c, f), open = f && f.hi === c.max;
  c.values = values;
  c.min = values[0];
  c.max = values[values.length - 1];
  if (!f) return;
  f.loEl.max = f.hiEl.max = values.length - 1;
  if (full) { f.lo = c.min; f.hi = c.max; }
  else {
    if (open) f.hi = c.max;
    f.lo = c.values[posOf(c, f.lo)];
    f.hi = c.values[posOf(c, f.hi)];
  }
  f.loEl.value = posOf(c, f.lo);
  f.hiEl.value = posOf(c, f.hi);
  paintSlider(c);
}

// Wind columns end at the highest value recorded, rounded up (34.1 -> 35).
function updateScales() {
  for (const c of TBL_COLS) {
    if (c.kind !== "kn") continue;
    let top = 0;
    for (const r of tbl.rows) if (r[c.key] > top) top = r[c.key];
    top = Math.max(Math.ceil(top), c.fine[1]);
    if (top !== c.max) setScale(c, scaleValues(c, top));
  }
}

function fullRange(c, f) { return f.lo === c.min && f.hi === c.max; }
const filterActive = (c, f) => f.enabled && !fullRange(c, f);

function passes(c, f, v) {
  if (!filterActive(c, f)) return true;
  if (v == null) return false;
  if (c.kind === "dir" && f.lo > f.hi) return v >= f.lo || v <= f.hi; // wraps through north
  if (c.kind === "kn") return v >= f.lo && (f.hi === c.max || v <= f.hi); // top = no upper limit
  return v >= f.lo && v <= f.hi;
}

function rangeText(c, f) {
  if (fullRange(c, f)) return "todos";
  const one = (v) => c.kind === "day" ? dayLabel(v) : c.kind === "hour" ? `${pad2(v)}h`
    : c.kind === "dir" ? `${v}° ${compassPt(v)}` : Number.isInteger(v) ? String(v) : v.toFixed(1).replace(".", ",");
  if (c.kind === "kn" && f.hi === c.max) return `≥ ${one(f.lo)}`;
  if (c.kind === "kn" && f.lo === c.min) return `≤ ${one(f.hi)}`;
  return `${one(f.lo)} – ${one(f.hi)}`;
}

function paintSlider(c) {
  const f = tbl.filters[c.key];
  const last = c.values.length - 1;
  const pct = (v) => (posOf(c, v) / last) * 100;
  const a = pct(Math.min(f.lo, f.hi)), b = pct(Math.max(f.lo, f.hi));
  const full = fullRange(c, f), active = filterActive(c, f);
  const on = active || full ? "var(--accent)" : "var(--idle)", off = "var(--line)";
  f.track.style.background = c.kind === "dir" && f.lo > f.hi
    ? `linear-gradient(to right, ${on} 0 ${a}%, ${off} ${a}% ${b}%, ${on} ${b}% 100%)`
    : `linear-gradient(to right, ${off} 0 ${a}%, ${on} ${a}% ${b}%, ${off} ${b}% 100%)`;
  f.txt.textContent = rangeText(c, f);
  f.chk.checked = active;
  f.chk.disabled = full;
  f.val.classList.toggle("on", active);
  f.val.classList.toggle("off", !active && !full);
  // The upper thumb stays grabbable when both sit at the right end.
  f.loEl.style.zIndex = posOf(c, f.lo) > last / 2 ? 3 : 2;
}

function buildTableHead() {
  const today = dayNumber(new Date(nowSec() * 1000));
  const first = dayNumber(new Date((sinceSec + 12 * 3600) * 1000));
  Object.assign(TBL_COLS[0], { min: first, max: today, step: 1 });
  for (const c of TBL_COLS) setScale(c, scaleValues(c, c.fine ? c.fine[1] : null));
  const cols = document.querySelector("#histTable tr.cols");
  const filters = document.querySelector("#histTable tr.filters");
  for (const c of TBL_COLS) {
    const th = document.createElement("th");
    if (c.sep) th.className = "sep";
    const b = document.createElement("button");
    b.className = "sort";
    b.dataset.key = c.key === "day" ? "ts" : c.key;
    b.addEventListener("click", () => setSort(b.dataset.key));
    th.appendChild(b);
    cols.appendChild(th);

    const fth = document.createElement("th");
    if (c.sep) fth.className = "sep";
    const val = document.createElement("label");
    val.className = "dual-val";
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.setAttribute("aria-label", `Filtro ${c.label} ligado`);
    const txt = document.createElement("span");
    val.append(chk, txt);
    const dual = document.createElement("div");
    dual.className = "dual";
    const track = document.createElement("div");
    track.className = "dual-track";
    const mk = (v, label) => {
      const i = document.createElement("input");
      Object.assign(i, { type: "range", min: 0, max: c.values.length - 1, step: 1, value: v });
      i.setAttribute("aria-label", `${label} ${c.label}`);
      return i;
    };
    const loEl = mk(0, "mínimo"), hiEl = mk(c.values.length - 1, "máximo");
    dual.append(track, loEl, hiEl);
    fth.append(val, dual);
    filters.appendChild(fth);
    const f = (tbl.filters[c.key] = { lo: c.min, hi: c.max, enabled: false, loEl, hiEl, track, val, chk, txt });
    const changed = () => {
      paintSlider(c);
      tbl.limit = TBL_PAGE;
      scheduleTableRender();
    };
    const onInput = (which) => {
      let lo = Number(loEl.value), hi = Number(hiEl.value); // positions
      // Only direction ranges may cross (they wrap through north).
      if (c.kind !== "dir" && lo > hi) {
        if (which === "lo") lo = hi; else hi = lo;
        loEl.value = lo; hiEl.value = hi;
      }
      f.lo = c.values[lo]; f.hi = c.values[hi];
      f.enabled = true;
      changed();
    };
    loEl.addEventListener("input", () => onInput("lo"));
    hiEl.addEventListener("input", () => onInput("hi"));
    chk.addEventListener("change", () => { f.enabled = chk.checked; changed(); });
    paintSlider(c);
  }
  updateSortLabels();
  tbl.built = true;
}

function resetFilters() {
  for (const c of TBL_COLS) {
    const f = tbl.filters[c.key];
    f.lo = c.min; f.hi = c.max; f.enabled = false;
    f.loEl.value = 0; f.hiEl.value = c.values.length - 1;
    paintSlider(c);
  }
  document.getElementById("tblRun").value = 1;
  document.getElementById("tblRunVal").textContent = "1 h";
  tbl.limit = TBL_PAGE;
  renderTable();
}

function setSort(key) {
  tbl.sort = tbl.sort.key === key ? { key, desc: !tbl.sort.desc } : { key, desc: key === "ts" };
  updateSortLabels();
  renderTable();
}

function updateSortLabels() {
  document.querySelectorAll("#histTable .sort").forEach((b, i) => {
    const on = b.dataset.key === tbl.sort.key;
    b.innerHTML = `${TBL_COLS[i].label}${on ? `<span class="ar">${tbl.sort.desc ? "↓" : "↑"}</span>` : ""}`;
  });
}

// ---- Render ----
const dirCell = (v) => v == null ? `<td class="sep na">—</td>`
  : `<td class="sep"><span class="dir-arrow" style="transform:rotate(${(Math.round(v) + 180) % 360}deg)">↑</span>${Math.round(v)}° ${compassPt(v)}</td>`;
const knCell = (v) => v == null ? `<td class="kn na">—</td>`
  : `<td class="kn" style="background:rgba(74,168,255,${Math.min(0.5, v / 60).toFixed(3)})">${v.toFixed(1)}</td>`;

// Rows (in time order) that sit in runs of at least `n` consecutive hours.
// Each kept row gets its run number, so the table can shade runs alternately.
function keepRuns(rows, n) {
  const out = [];
  let runs = 0, start = 0;
  for (let i = 1; i <= rows.length; i++) {
    if (i < rows.length && rows[i].ts - rows[i - 1].ts === 3600) continue;
    if (i - start >= n) {
      runs += 1;
      for (let j = start; j < i; j++) { rows[j].run = runs; out.push(rows[j]); }
    }
    start = i;
  }
  return { rows: out, runs };
}

function renderTable() {
  if (!tbl.rows || !tbl.built) return;
  const sun = document.getElementById("tblSun").checked;
  const minRun = Number(document.getElementById("tblRun").value);
  const passing = tbl.rows.filter((r) => (!sun || r.sun) &&
    TBL_COLS.every((c) => passes(c, tbl.filters[c.key], r[c.key])));
  const { rows, runs } = keepRuns(passing, minRun); // tbl.rows is in time order
  const { key, desc } = tbl.sort;
  rows.sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1; // blanks last
    return desc ? y - x : x - y;
  });
  tbl.filtered = rows;
  renderTableSummary(rows, minRun > 1 ? runs : null);

  const more = document.getElementById("tblMore");
  if (tbl.tab === "hist") {
    more.hidden = true;
    renderHists(rows);
    return;
  }
  const html = [];
  for (const r of rows.slice(0, tbl.limit)) {
    const seq = `seq${r.run % 2}`;
    html.push(`<tr><td class="${seq}">${WEEKDAYS[r.wd]} ${dayLabel(r.day)}</td><td class="${seq}">${pad2(r.hour)}h</td>`,
      dirCell(r.fdir), knCell(r.fw), knCell(r.fg), dirCell(r.mdir), knCell(r.mw), knCell(r.mg), `</tr>`);
  }
  document.querySelector("#histTable tbody").innerHTML = html.join("");
  more.hidden = rows.length <= tbl.limit;
  more.textContent = `Mostrar mais (${(rows.length - tbl.limit).toLocaleString("pt-BR")} restantes)`;
}

function renderTableSummary(rows, runs) {
  const el = document.getElementById("tblSummary");
  if (!rows.length) { el.innerHTML = "<span>Nenhuma hora com esses filtros.</span>"; return; }
  const min = Number(document.getElementById("climMin").value);
  const mw = rows.map((r) => r.mw).sort((a, b) => a - b);
  const mg = rows.map((r) => r.mg).filter((v) => v != null).sort((a, b) => a - b);
  const days = new Map();
  for (const r of rows) days.set(r.day, (days.get(r.day) || false) || r.mw >= min);
  const goodDays = [...days.values()].filter(Boolean).length;
  const strong = rows.filter((r) => r.mw >= min).length;
  const f1 = (v) => v.toFixed(1).replace(".", ",");
  el.innerHTML = [
    `<b>${rows.length.toLocaleString("pt-BR")}</b> horas em <b>${days.size}</b> dias` +
      (runs != null ? ` (${runs} sequência${runs === 1 ? "" : "s"})` : ""),
    `medido médio: mediana <b>${f1(quantile(mw, 0.5))}</b> (metade entre ${f1(quantile(mw, 0.25))} e ${f1(quantile(mw, 0.75))})`,
    mg.length ? `rajada medida: mediana <b>${f1(quantile(mg, 0.5))}</b>` : "",
    `médio ≥ ${min} nós em <b>${Math.round((100 * strong) / rows.length)}%</b> das horas`,
    `dias com alguma dessas horas ≥ ${min}: <b>${goodDays}</b> de ${days.size}`,
  ].filter(Boolean).map((s) => `<span>${s}</span>`).join("");
}

let tblFrame = 0;
function scheduleTableRender() {
  if (tblFrame) return;
  tblFrame = requestAnimationFrame(() => { tblFrame = 0; renderTable(); });
}

// Data arrives in pieces (30-min weeks, newest first; the forecast in two
// requests): rebuild the rows at most every 400 ms.
function scheduleTable() {
  if (tbl.timer || !station || !sinceSec) return;
  tbl.timer = setTimeout(() => {
    tbl.timer = null;
    if (!tbl.built) buildTableHead();
    tblBuildRows();
    updateScales();
    renderTable();
    const starts = chunkStarts("30min", sinceSec, nowSec());
    const loaded = starts.filter((s) => chunks["30min"].has(s)).length;
    const busy = loaded < starts.length || !fc.full;
    document.getElementById("tblBusy").hidden = !busy;
    document.getElementById("tblBusyText").textContent = loaded < starts.length
      ? `carregando histórico ${loaded}/${starts.length} semanas…` : "carregando previsão…";
  }, 400);
}

document.getElementById("tblSun").addEventListener("change", () => { tbl.limit = TBL_PAGE; renderTable(); });
document.getElementById("tblRun").addEventListener("input", (e) => {
  document.getElementById("tblRunVal").textContent = `${e.target.value} h`;
  tbl.limit = TBL_PAGE;
  scheduleTableRender();
});
document.getElementById("tblReset").addEventListener("click", resetFilters);
document.getElementById("tblMore").addEventListener("click", () => { tbl.limit += TBL_PAGE; renderTable(); });
