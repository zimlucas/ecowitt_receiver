// Local development server:  npm run dev  ->  http://localhost:8888
//
// Runs the dashboard and the Netlify functions on this machine, with no Netlify
// account or CLI needed:
//   - serves the static site (index.html) from the repo root;
//   - routes /api/* and /.netlify/functions/* to netlify/functions/*.mjs, using
//     the [[redirects]] declared in netlify.toml;
//   - reads credentials from .env (real Ecowitt data);
//   - stores state in .dev-data/ instead of Netlify Blobs (see lib/store.mjs);
//   - DRY_RUN=1 by default: nothing is posted to Windy / WU / Windguru.
//     Start with DRY_RUN=0 in .env to really post (careful!);
//   - runs the scheduled functions (poller every 5 min, archiver hourly) on
//     start and then on their schedule.
import { createServer } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

try {
  process.loadEnvFile(".env");
} catch {
  console.warn("No .env found - copy .env.example to .env and fill in the Ecowitt keys.");
}
process.env.LOCAL_DEV = "1";
process.env.DRY_RUN ??= "1";

const PORT = Number(process.env.PORT || 8888);
const FUNCTIONS_DIR = path.join(ROOT, "netlify", "functions");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
// Never serve these over HTTP, even locally.
const PRIVATE = /^\/(\.env|\.git|\.dev-data|node_modules|lib|netlify|dev)(\/|$)|\.mjs$/;

// [[redirects]] from netlify.toml: from = "/api/x" -> to = "/.netlify/functions/x".
async function loadRedirects() {
  const toml = await readFile(path.join(ROOT, "netlify.toml"), "utf8");
  const map = new Map();
  for (const block of toml.split("[[redirects]]").slice(1)) {
    const from = block.match(/from\s*=\s*"([^"]+)"/)?.[1];
    const to = block.match(/to\s*=\s*"([^"]+)"/)?.[1];
    if (from && to) map.set(from, to);
  }
  return map;
}

async function loadFunction(name) {
  const file = path.join(FUNCTIONS_DIR, `${name}.mjs`);
  await stat(file);
  return import(pathToFileURL(file).href);
}

async function toWebRequest(req, url) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = Object.entries(req.headers).filter(
    ([k]) => !["connection", "keep-alive", "transfer-encoding", "upgrade", "host"].includes(k),
  );
  return new Request(url, {
    method: req.method,
    headers: headers.flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])),
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
}

async function sendWebResponse(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function runFunction(name, req, url, res) {
  let mod;
  try {
    mod = await loadFunction(name);
  } catch {
    res.writeHead(404).end(`function not found: ${name}`);
    return;
  }
  const request = await toWebRequest(req, url);
  const started = Date.now();

  // Background functions answer 202 right away and keep running.
  if (name.endsWith("-background")) {
    res.writeHead(202).end();
    Promise.resolve(mod.default(request))
      .then(() => console.log(`  ${name} finished in ${Date.now() - started} ms`))
      .catch((err) => console.error(`  ${name} failed:`, err));
    return;
  }

  try {
    const response = await mod.default(request);
    console.log(`  ${name} ${response.status} in ${Date.now() - started} ms`);
    await sendWebResponse(res, response);
  } catch (err) {
    console.error(`  ${name} threw:`, err);
    res.writeHead(500).end(String(err));
  }
}

async function serveStatic(pathname, res) {
  if (PRIVATE.test(pathname)) {
    res.writeHead(404).end();
    return;
  }
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}

// Scheduled functions (those exporting config.schedule): each runs once on
// start, then on an interval approximating its cron expression.
function scheduleMinutes(cron) {
  if (cron === "@hourly") return 60;
  if (cron === "@daily") return 1440;
  const every = cron.match(/^\*\/(\d+) \* \* \* \*$/);
  if (every) return Number(every[1]);
  if (/^\d+ \* \* \* \*$/.test(cron)) return 60;
  return 1440;
}

async function runScheduled(name) {
  try {
    const mod = await loadFunction(name);
    const response = await mod.default(new Request(`http://localhost:${port}/.netlify/functions/${name}`));
    console.log(`  ${name} -> ${await response.text()}`);
  } catch (err) {
    console.error(`  ${name} failed:`, err);
  }
}

async function startSchedules() {
  const files = (await readdir(FUNCTIONS_DIR)).filter((f) => f.endsWith(".mjs"));
  let delay = 0;
  for (const file of files) {
    const name = file.slice(0, -4);
    const schedule = (await loadFunction(name)).config?.schedule;
    if (!schedule) continue;
    const minutes = scheduleMinutes(schedule);
    console.log(`Scheduled: ${name} (${schedule}) every ${minutes} min`);
    // Stagger the first runs so they don't hit Ecowitt at the same moment.
    setTimeout(() => {
      runScheduled(name);
      setInterval(() => runScheduled(name), minutes * 60 * 1000);
    }, delay);
    delay += 5000;
  }
}

const redirects = await loadRedirects();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const target = redirects.get(url.pathname) || url.pathname;
  const fn = target.match(/^\/\.netlify\/functions\/([\w-]+)$/);
  try {
    if (fn) await runFunction(fn[1], req, new URL(target + url.search, url), res);
    else await serveStatic(url.pathname, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

// If the port is taken (e.g. another dev server still running), say so and use
// the next free one instead of crashing.
let port = PORT;
server.on("error", (err) => {
  if (err.code === "EADDRINUSE" && port < PORT + 10) {
    console.warn(`Port ${port} is in use (another dev server running?) - trying ${port + 1}.`);
    server.listen(++port);
  } else {
    console.error(err.message);
    process.exit(1);
  }
});
server.on("listening", () => {
  console.log(`Dev server: http://localhost:${port}`);
  console.log(`DRY_RUN=${process.env.DRY_RUN} (${process.env.DRY_RUN === "1" ? "uploads are skipped" : "UPLOADS ARE REAL"})`);
  startSchedules();
});
server.listen(port);
