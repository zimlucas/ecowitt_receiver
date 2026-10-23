// History statistics (wind rose, wind by hour) and the 30-min bundle loader.
//
// Classic script, loaded with defer: all js/*.js files share one global scope
// and run in the order index.html lists them, after the page is parsed.

// ---- Wind statistics ----
// Built from the whole history at 30-min resolution (the same chunks the
// chart uses; past weeks come from the caches). Daylight samples only (sun
// above the horizon), grouped by local day. A day is "valid" when the mean
// wind stayed >= the minimum for at least 1 h in a row (two consecutive
// 30-min samples). On the valid days of the selected months, the rose shows
// where the readings >= minimum came from, and the hour chart the spread of
// the wind at each hour.
const CLIM_STEP = 1800;
const CLIM_RUN = 2; // consecutive 30-min samples = 1 h
const CLIM_MIN_SAMPLES = 4; // hours with fewer samples are left out
const CLIM_SURFACE = "#1a2640"; // panel background, for the gaps between rose sectors
const clim = { started: false, days: null, months: new Set(), timer: null, rose: null, hour: null, stats: [], counts: [] };

// A calendar month counts only when the history covers all of it (not the
// station's first, partial month nor the current one); otherwise it would
// weigh a few days as if they were the whole month.
function fullMonth(year, month) {
  return new Date(year, month, 1).getTime() / 1000 >= sinceSec
    && new Date(year, month + 1, 1).getTime() / 1000 <= nowSec();
}

// Daylight samples of full months, grouped by local day (rebuilt when 30-min
// chunks arrive).
function climDays() {
  if (clim.days) return clim.days;
  const byDay = new Map();
  for (const s of chunkStarts("30min", sinceSec, nowSec())) {
    const c = chunks["30min"].get(s);
    if (!c) continue;
    c.clim ??= c.points.filter((p) => p.wind_knots != null && sunElevation(p.ts, station.lat, station.lon) > 0);
    for (const p of c.clim) {
      const d = new Date(p.ts * 1000);
      if (!fullMonth(d.getFullYear(), d.getMonth())) continue;
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      let day = byDay.get(key);
      if (!day) byDay.set(key, (day = { month: d.getMonth(), samples: new Map() }));
      day.samples.set(p.ts, { ts: p.ts, wind: p.wind_knots, dir: p.dir, hour: d.getHours() }); // dedupes chunk edges
    }
  }
  clim.days = [...byDay.values()].map((day) => ({
    month: day.month,
    samples: [...day.samples.values()].sort((a, b) => a.ts - b.ts),
  }));
  return clim.days;
}

function validDay(day, min) {
  let run = 0, prev = null;
  for (const s of day.samples) {
    run = s.wind < min ? 0 : run > 0 && s.ts - prev <= CLIM_STEP * 1.5 ? run + 1 : 1;
    if (run >= CLIM_RUN) return true;
    prev = s.ts;
  }
  return false;
}

function quantile(sorted, q) {
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function computeClimate(min, months) {
  const perMonth = new Map(months.map((m) => [m, { days: 0, valid: 0 }]));
  const sectors = new Array(16).fill(0);
  const byHour = Array.from({ length: 24 }, () => ({ winds: [], days: 0 }));
  let readings = 0;
  for (const day of climDays()) {
    const m = perMonth.get(day.month);
    if (!m) continue;
    m.days += 1;
    if (!validDay(day, min)) continue;
    m.valid += 1;
    const hours = new Set();
    for (const s of day.samples) {
      byHour[s.hour].winds.push(s.wind);
      hours.add(s.hour);
      if (s.wind >= min && s.dir != null) { sectors[compassIndex(s.dir)] += 1; readings += 1; }
    }
    for (const h of hours) byHour[h].days += 1;
  }
  const stats = [];
  byHour.forEach(({ winds, days }, hour) => {
    if (winds.length < CLIM_MIN_SAMPLES) return;
    winds.sort((a, b) => a - b);
    stats.push({
      hour, days, n: winds.length,
      p05: quantile(winds, 0.05), p125: quantile(winds, 0.125), p50: quantile(winds, 0.5),
      p875: quantile(winds, 0.875), p95: quantile(winds, 0.95),
    });
  });
  return { perMonth, sectors, readings, stats };
}

function ensureClimCharts() {
  if (clim.rose) return;
  const muted = "#8a99b5", grid = "rgba(255,255,255,0.07)";
  clim.rose = new Chart(document.getElementById("roseChart"), {
    type: "polarArea",
    data: { labels: COMPASS, datasets: [{ data: [], backgroundColor: "rgba(74,168,255,0.78)",
      hoverBackgroundColor: "#4aa8ff", borderColor: CLIM_SURFACE, borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: { r: {
        startAngle: -11.25, // centre each sector on its direction (N at the top)
        beginAtZero: true, grid: { color: grid }, angleLines: { display: true, color: grid },
        ticks: { color: muted, backdropColor: "transparent", maxTicksLimit: 5, callback: (v) => `${v}%`, z: 1 },
        pointLabels: { display: true, centerPointLabels: true, color: muted, font: { size: 11 } },
      } },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          title: (items) => (items.length ? `Vento de ${items[0].label}` : ""),
          label: (it) => `${it.raw.toFixed(1)}% das leituras (${clim.counts[it.dataIndex]})`,
        } },
      },
    },
  });

  const band = (label, fill, color) => ({ label, data: [], fill, backgroundColor: color,
    borderWidth: 0, pointRadius: 0, pointHoverRadius: 0, tension: 0.3 });
  clim.hour = new Chart(document.getElementById("hourChart"), {
    type: "line",
    data: { labels: [], datasets: [
      band("p95", 1, "rgba(74,168,255,0.18)"),
      band("p05", false, "transparent"),
      band("p875", 3, "rgba(74,168,255,0.38)"),
      band("p125", false, "transparent"),
      { label: "Mediana", data: [], borderColor: "#4aa8ff", backgroundColor: "#4aa8ff", borderWidth: 2,
        pointRadius: 3, pointHoverRadius: 5, fill: false, tension: 0.3 },
      { label: "Mínimo", data: [], borderColor: "#ffae57", borderWidth: 1.5, borderDash: [6, 4],
        pointRadius: 0, pointHoverRadius: 0, fill: false },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: muted, maxRotation: 0 }, grid: { color: grid } },
        y: { min: 0, title: { display: true, text: "nós", color: muted },
             ticks: { color: muted, stepSize: 5 }, grid: { color: "rgba(255,255,255,0.05)" } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: (it) => it.datasetIndex === 4,
          callbacks: {
            title: (items) => {
              const s = items.length && clim.stats[items[0].dataIndex];
              return s ? `${pad2(s.hour)}h–${pad2(s.hour + 1)}h` : "";
            },
            label: (it) => `Mediana: ${it.parsed.y.toFixed(1)} nós`,
            afterBody: (items) => {
              const s = items.length && clim.stats[items[0].dataIndex];
              if (!s) return [];
              return [
                `75% dos dias: ${s.p125.toFixed(1)}–${s.p875.toFixed(1)} nós`,
                `90% dos dias: ${s.p05.toFixed(1)}–${s.p95.toFixed(1)} nós`,
                `${s.days} dia${s.days === 1 ? "" : "s"}, ${s.n} leituras`,
              ];
            },
          },
        },
      },
    },
  });
}

function selectedMonths() {
  return clim.months.size ? [...clim.months].sort((a, b) => a - b) : MONTHS.map((_, i) => i);
}

function renderMonthButtons() {
  const row = document.getElementById("climMonths");
  if (!row.children.length) {
    const add = (label, month) => {
      const b = document.createElement("button");
      b.className = "btn sm";
      b.textContent = label;
      b.addEventListener("click", () => toggleMonth(month));
      row.appendChild(b);
    };
    add("Todos", null);
    MONTHS.forEach((m, i) => add(m[0].toUpperCase() + m.slice(1), i));
  }
  [...row.children].forEach((b, i) => {
    const on = i === 0 ? clim.months.size === 0 : clim.months.has(i - 1);
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on);
  });
}

// "Todos" clears the selection; months toggle on and off (none = all).
function toggleMonth(month) {
  if (month === null) clim.months.clear();
  else if (clim.months.has(month)) clim.months.delete(month);
  else clim.months.add(month);
  if (clim.months.size === 12) clim.months.clear();
  renderMonthButtons();
  renderClimate();
}

function scheduleClimate() {
  if (!clim.started || clim.timer) return;
  clim.timer = setTimeout(() => { clim.timer = null; renderClimate(); }, 250);
}

function renderClimate() {
  if (!clim.started || !station) return;
  ensureClimCharts();
  const min = Number(document.getElementById("climMin").value);
  const months = selectedMonths();
  const { perMonth, sectors, readings, stats } = computeClimate(min, months);

  // Loading progress: past weeks arrive nearest first.
  const starts = chunkStarts("30min", sinceSec, nowSec());
  const loaded = starts.filter((s) => chunks["30min"].has(s)).length;
  const loading = loaded < starts.length;
  document.getElementById("climBusy").hidden = !loading;
  document.getElementById("climBusyText").textContent = `carregando histórico ${loaded}/${starts.length} semanas…`;
  document.querySelectorAll(".clim-panel .chart-wrap").forEach((el) => el.classList.toggle("dim", loading));

  // Valid days per selected month.
  const parts = [];
  let valid = 0, total = 0;
  for (const [m, c] of perMonth) {
    valid += c.valid; total += c.days;
    parts.push(c.days ? `${MONTHS[m]} <b>${c.valid}</b> de ${c.days} dias` : `${MONTHS[m]} sem dados`);
  }
  if (perMonth.size > 1) parts.push(`total <b>${valid}</b> de ${total} dias`);
  document.getElementById("climDays").innerHTML =
    `<span>Dias com ≥ ${min} nós por 1 h ou mais:</span>` + parts.map((p) => `<span>${p}</span>`).join("");

  const empty = loading && !total ? "Carregando…"
    : `Nenhum dia com ≥ ${min} nós por 1 h seguida nos meses selecionados.`;

  clim.counts = sectors;
  clim.rose.data.datasets[0].data = sectors.map((n) => (readings ? (n / readings) * 100 : 0));
  clim.rose.update("none");
  const roseEmpty = document.getElementById("roseEmpty");
  roseEmpty.hidden = readings > 0;
  roseEmpty.textContent = empty;

  clim.stats = stats;
  const ds = clim.hour.data.datasets;
  clim.hour.data.labels = stats.map((s) => `${pad2(s.hour)}h`);
  ["p95", "p05", "p875", "p125", "p50"].forEach((k, i) => { ds[i].data = stats.map((s) => s[k]); });
  ds[5].data = stats.map(() => min);
  const top = Math.max(min, ...stats.map((s) => s.p95));
  clim.hour.options.scales.y.max = Math.max(15, Math.ceil((top + 0.5) / 5) * 5);
  clim.hour.update("none");
  const hourEmpty = document.getElementById("hourEmpty");
  hourEmpty.hidden = stats.length > 0;
  hourEmpty.textContent = empty;
}

// Loads every 30-min week since the first day: the closed ones in one
// bundle, then whatever it didn't cover (the current week; every week if
// the bundle failed) one by one, newest first and behind whatever the
// main chart needs.
async function startClimate() {
  if (clim.started || !sinceSec || !station) return;
  clim.started = true;
  renderClimate();
  bundleReady = loadBundle();
  await bundleReady;
  bundleReady = true;
  const starts = chunkStarts("30min", sinceSec, nowSec()).reverse();
  starts.forEach((s, i) => requestChunk("30min", s, 300 + i));
  renderClimate();
}

// null = not asked yet, a promise while loading, true once done (or failed).
// 30-min requests that the bundle would answer wait for it.
let bundleReady = null;
const afterBundle = () => (bundleReady === true ? Promise.resolve() : bundleReady || Promise.resolve());

// Start of the last final 30-min week (same rule as lib/chunks.mjs isFinal).
function lastFinalWeek() {
  const { res, chunk: size } = LEVELS["30min"];
  let s = alignChunk("30min", nowSec());
  while (s + size + res + 3600 > nowSec()) s -= size;
  return s;
}

// The bundle (lib/bundle.mjs) split back into the weekly chunks everything
// else reads. Never changes, so the browser keeps it.
async function loadBundle() {
  try {
    const res = await fetch(`/api/history?bundle=30min&upto=${lastFinalWeek()}&v=${HISTORY_VERSION}`);
    if (!res.ok) return;
    const b = await res.json();
    const weeks = new Map();
    let ts = b.ts0;
    for (let i = 0; i < b.dt.length; i++) {
      ts += b.dt[i];
      const s = alignChunk("30min", ts);
      if (!weeks.has(s)) weeks.set(s, []);
      weeks.get(s).push({
        ts, wind_knots: b.w[i] == null ? null : b.w[i] / 10, gust_knots: b.g[i] == null ? null : b.g[i] / 10,
        dir: b.d[i], solar: b.s[i],
      });
    }
    const fetchedAt = Date.now();
    for (let s = b.from; s <= b.upto; s += b.size) {
      const chunk = { points: weeks.get(s) || [], final: true, fetchedAt };
      const job = jobs.get(`30min:${s}`);
      if (job) {
        const i = queue.indexOf(job);
        if (i >= 0) queue.splice(i, 1);
        storeChunk(job, chunk);
      } else {
        chunks["30min"].set(s, chunk);
      }
    }
    onChunkLoaded("30min");
  } catch (e) {
    // Fall back to week-by-week loading.
  }
}

renderMonthButtons();
document.getElementById("climMin").addEventListener("input", (e) => {
  document.getElementById("climMinVal").textContent = `${e.target.value} nós`;
  renderClimate();
  renderTable();
});
