/**
 * engine/storage/files.js — atomic JSON, hashing and the repo paths the subsystem owns.
 *
 * Every durable artefact is written tmp-then-rename so a killed process never leaves a half-written
 * JSON that a later stage would trust. Paths are resolved from a `root` argument (never a fixed
 * path) so tests can point the whole subsystem at a temp directory.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/** Repo root of THIS checkout (worktree or main). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The member's own file if /setup has written it, else the kit default. */
const memberOr = (root, memberFile, defaultFile) => {
  const m = path.join(root, "member", memberFile);
  return fs.existsSync(m) ? m : path.join(root, "config", defaultFile);
};

export function pathsFor(root = REPO_ROOT) {
  return {
    root,
    dataDir: path.join(root, "output"),
    registry: path.join(root, "output", "registry.json"),
    profilesDir: path.join(root, "config", "profiles"),
    lexicon: memberOr(root, "lexicon.json", "lexicon.default.json"),
    brand: memberOr(root, "brand.json", "brand.default.json"),
    memberDir: path.join(root, "member"),
    assetsManifest: path.join(root, "member", "assets.json"),
    jobDir: (id) => path.join(root, "output", id),
  };
}

export function readJson(file, fallback = undefined) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {
    if (fallback !== undefined && e.code === "ENOENT") return fallback;
    throw e;
  }
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

/** Stable JSON (sorted keys) so hashes don't depend on property order. */
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export const sha256Text = (s) => createHash("sha256").update(s).digest("hex");
export const hashObject = (o) => sha256Text(stableStringify(o));

/** sha256 of a file, streamed (a 4 GB master must not be read into memory). */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    fs.createReadStream(file).on("error", reject).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex")));
  });
}

/** Size + mtime + sha256 — what "the source was not touched" is measured against. */
export async function fingerprint(file) {
  const st = fs.statSync(file);
  return { size: st.size, mtimeMs: Math.round(st.mtimeMs), sha256: await sha256File(file) };
}

/** Free bytes on the volume holding `dir`. */
export function freeBytes(dir) {
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}
