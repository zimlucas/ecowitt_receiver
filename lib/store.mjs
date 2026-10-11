// Key/value storage used by the functions.
//
// On Netlify this is Netlify Blobs. Under `npm run dev` (LOCAL_DEV=1) it is a
// folder of JSON files in .dev-data/, so the whole app runs locally without
// Netlify and without @netlify/blobs (which needs Node >= 22.12).
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const LOCAL = process.env.LOCAL_DEV === "1";
const LOCAL_DIR = path.resolve(".dev-data");

function localStore(name) {
  const dir = path.join(LOCAL_DIR, name);
  const file = (key) => path.join(dir, `${encodeURIComponent(key)}.json`);
  return {
    async get(key) {
      try {
        return JSON.parse(await readFile(file(key), "utf8"));
      } catch {
        return null;
      }
    },
    async setJSON(key, value) {
      await mkdir(dir, { recursive: true });
      await writeFile(file(key), JSON.stringify(value));
    },
    async list({ prefix = "" } = {}) {
      const names = await readdir(dir).catch(() => []);
      const keys = names.filter((n) => n.endsWith(".json")).map((n) => decodeURIComponent(n.slice(0, -5)));
      return { blobs: keys.filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}

function blobsStore(options) {
  const store = import("@netlify/blobs").then((m) => m.getStore(options));
  return {
    get: async (key, opts) => (await store).get(key, opts),
    setJSON: async (key, value) => (await store).setJSON(key, value),
    list: async (opts) => (await store).list(opts),
  };
}

// Same call shape as @netlify/blobs' getStore({ name, consistency }). Supported:
// get(key, { type: "json" }), setJSON(key, value), list({ prefix }) -> { blobs: [{ key }] }.
export function getStore(options) {
  return LOCAL ? localStore(options.name) : blobsStore(options);
}
