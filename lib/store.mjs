// Key/value storage used by the functions.
//
// On Netlify this is Netlify Blobs. Under `npm run dev` (LOCAL_DEV=1) it is a
// folder of JSON files in .dev-data/, so the whole app runs locally without
// Netlify and without @netlify/blobs (which needs Node >= 22.12).
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  };
}

function blobsStore(options) {
  const store = import("@netlify/blobs").then((m) => m.getStore(options));
  return {
    get: async (key, opts) => (await store).get(key, opts),
    setJSON: async (key, value) => (await store).setJSON(key, value),
  };
}

// Same call shape as @netlify/blobs' getStore({ name, consistency }).
// Only get(key, { type: "json" }) and setJSON(key, value) are supported.
export function getStore(options) {
  return LOCAL ? localStore(options.name) : blobsStore(options);
}
