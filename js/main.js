// Backfill button, status polling and rendering, start-up.
//
// Classic script, loaded with defer: all js/*.js files share one global scope
// and run in the order index.html lists them, after the page is parsed.

// ---- Backfill ----
function renderBackfill(bf) {
  const el = document.getElementById("bfStatus");
  if (!bf) { el.textContent = "Nenhum reenvio executado ainda."; return; }
  if (bf.running) {
    el.textContent = `Em andamento… ${bf.posted}/${bf.total} pontos enviados (${bf.failed} falhas).`;
  } else if (bf.finished_at) {
    el.textContent = `Último reenvio (${bf.days}d): ${bf.posted} enviados, ${bf.failed} falhas — ${ago(bf.finished_at)}.`
      + (bf.error ? ` Erro: ${bf.error}` : "");
  } else {
    el.textContent = "Nenhum reenvio executado ainda.";
  }
}

async function runBackfill() {
  const input = document.getElementById("bfCode");
  const code = (input.value || "").trim();
  if (code !== "1709") {
    alert("Código incorreto. Digite o código de 4 dígitos para reenviar o histórico.");
    input.focus();
    return;
  }
  input.value = "";
  const btn = document.getElementById("bfBtn");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Iniciando…";
  try { await fetch("/.netlify/functions/backfill-background?days=2", { method: "POST" }); } catch (e) {}
  setTimeout(() => { btn.textContent = original; btn.disabled = false; refresh(true); }, 5000);
}

const fmt = (v, digits = 1) =>
  v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toFixed(digits);

function ago(iso) {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `há ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  return `há ${Math.round(m / 60)}h`;
}

function setConditions(d) {
  if (!d) return;
  document.getElementById("temp").innerHTML = `${fmt(d.temp_c)}<span class="unit"> °C</span>`;
  document.getElementById("dew").textContent = `Ponto de orvalho ${fmt(d.dewpt_c)} °C`;
  document.getElementById("hum").innerHTML = `${fmt(d.humidity, 0)}<span class="unit"> %</span>`;
  const windMs = d.wind_ms != null ? d.wind_ms : (d.wind_knots != null ? d.wind_knots * 0.514444 : null);
  const windKmh = d.wind_kmh != null ? d.wind_kmh : (d.wind_knots != null ? d.wind_knots * 1.852 : null);
  const gustMs = d.gust_ms != null ? d.gust_ms : (d.gust_knots != null ? d.gust_knots * 0.514444 : null);
  const gustKmh = d.gust_kmh != null ? d.gust_kmh : (d.gust_knots != null ? d.gust_knots * 1.852 : null);
  document.getElementById("wind").innerHTML = `${fmt(d.wind_knots)}<span class="unit"> nós</span>`;
  document.getElementById("windms").textContent = `${fmt(windMs, 1)} m/s`;
  document.getElementById("windkmh").textContent = `${fmt(windKmh, 1)} km/h`;
  document.getElementById("gust").innerHTML = `${fmt(d.gust_knots)}<span class="unit"> nós</span>`;
  document.getElementById("gustms").textContent = `${fmt(gustMs, 1)} m/s`;
  document.getElementById("gustkmh").textContent = `${fmt(gustKmh, 1)} km/h`;
  document.getElementById("dir").innerHTML =
    `${fmt(d.wind_direction, 0)}<span class="unit">° ${d.wind_compass || ""}</span>`;
  const arrow = document.getElementById("dirArrow");
  if (d.wind_direction != null) {
    arrow.style.transform = `rotate(${(Number(d.wind_direction) + 180) % 360}deg)`;
    arrow.style.opacity = "1";
  } else {
    arrow.style.opacity = "0.3";
  }
  document.getElementById("press").innerHTML = `${fmt(d.pressure_hpa)}<span class="unit"> hPa</span>`;
  document.getElementById("solar").innerHTML = `${fmt(d.solar, 0)}<span class="unit"> W/m²</span>`;
  document.getElementById("uv").textContent = fmt(d.uv, 0);
}

function setMonitor(svc, post, log) {
  const card = document.querySelector(`.mon[data-svc="${svc}"]`);
  const pill = card.querySelector("[data-pill]");
  const msg = card.querySelector("[data-msg]");
  const strip = card.querySelector("[data-strip]");

  if (post) {
    const ok = post.ok;
    pill.className = `pill ${ok ? "ok" : "fail"}`;
    pill.textContent = ok ? "OK" : "FALHOU";
    msg.textContent = `HTTP ${post.code} · ${post.message || ""} · ${ago(post.at)}`;
  }

  strip.innerHTML = "";
  (log || []).slice(-30).forEach((entry) => {
    const t = document.createElement("span");
    t.className = `tick ${entry[svc] ? "ok" : "fail"}`;
    t.title = `${new Date(entry.at).toLocaleString()} — ${entry[svc] ? "OK" : "falhou"}`;
    strip.appendChild(t);
  });
}

// ---- Status polling ----
// The status only changes when the poller runs (every 5 min, UTC), and the
// CDN keeps it until just after the next run. So the page asks again right
// after that run, every 20 s while the current run hasn't landed yet,
// every 5 s (skipping the CDN copy) while a backfill runs, and not at all
// while the tab is hidden. In between, a local timer keeps the "há X min"
// texts current without asking.
const STATUS_SETTLE_MS = 25e3; // after the next cycle mark (the CDN copy lives until +20 s)
const STATUS_RETRY_MS = 20e3;
const BACKFILL_POLL_MS = 5e3;
let statusTimer = null;
let lastStatus = null;

function nextStatusDelay(data) {
  if (data.backfill?.running) return BACKFILL_POLL_MS;
  const cycle = (data.cycle_sec || 300) * 1000;
  const now = Date.now() + clockOffset * 1000;
  const mark = Math.floor(now / cycle) * cycle;
  const at = data.latest?.at ? Date.parse(data.latest.at) : 0;
  if (at < mark) return STATUS_RETRY_MS; // this cycle's run hasn't landed yet
  return mark + cycle + STATUS_SETTLE_MS - now;
}

function scheduleStatus(delay) {
  clearTimeout(statusTimer);
  statusTimer = document.hidden ? null : setTimeout(refresh, Math.max(1000, delay));
}

async function refresh(fresh = false) {
  try {
    const data = await getStatus(fresh || !!lastStatus?.backfill?.running);
    lastStatus = data;
    renderStatus(data);
    scheduleStatus(nextStatusDelay(data));
  } catch (err) {
    document.getElementById("updated").textContent = "erro ao carregar";
    document.getElementById("liveDot").style.background = "var(--fail)";
    scheduleStatus(STATUS_RETRY_MS);
  }
}

function renderStatus(data) {
  if (data.station) {
    document.getElementById("stationName").textContent = data.station.name || "Estação Meteorológica";
    if (data.station.lat != null && data.station.lon != null) {
      document.getElementById("coords").textContent =
        `${Number(data.station.lat).toFixed(5)}, ${Number(data.station.lon).toFixed(5)}`;
    }
  }

  const liveIso = data.latest?.at || data.status?.updated_at;
  document.getElementById("updated").textContent = `Atualizado ${ago(liveIso)}`;
  const stale = liveIso ? (Date.now() - new Date(liveIso).getTime()) > 7 * 60 * 1000 : true;
  document.getElementById("liveDot").style.background = stale ? "var(--fail)" : "var(--ok)";

  const banner = document.getElementById("banner");
  if (!data.latest && !data.status) {
    banner.style.display = "block";
    banner.innerHTML =
      "Ainda não há dados. A função agendada roda a cada 5 minutos e o primeiro envio acontece poucos minutos após o deploy. " +
      "Em <em>Deploy Previews</em> as funções agendadas não rodam — publique o deploy de produção.";
  } else {
    banner.style.display = "none";
  }

  setConditions(data.latest?.display || data.status?.weather);

  const posts = data.status?.posts || {};
  setMonitor("windy", posts.windy, data.log);
  setMonitor("wunderground", posts.wunderground, data.log);
  setMonitor("windguru", posts.windguru, data.log);

  if (data.status) {
    document.getElementById("cycleNote").textContent =
      `Último ciclo de envio ${ago(data.status.updated_at)}.`;
  }
  renderBackfill(data.backfill);
  const tail = (data.recent || []).filter((p) => p.ts).sort((a, b) => a.ts - b.ts);
  const tailChanged = tail.at(-1)?.ts !== liveTail.at(-1)?.ts;
  liveTail = tail;
  advanceChart(tailChanged);
}

document.getElementById("bfBtn").addEventListener("click", runBackfill);
document.getElementById("zoomWord").addEventListener("click", toggleRefMode);
document.querySelectorAll("[data-range]").forEach((b) =>
  b.addEventListener("click", () => selectView(b.dataset.range)));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) scheduleStatus(0); // clears the timer
  else refresh();
});

refresh();
selectView("24h");
// "há X min" texts and the chart's right edge move on between status reads.
setInterval(() => { if (lastStatus && !document.hidden) renderStatus(lastStatus); }, 30000);
