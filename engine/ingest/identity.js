/**
 * engine/ingest/identity.js — S identity: one S### per short-form piece, for life.
 *
 * S IDs are a separate namespace from long-form V numbers and live in their own registry
 * (output/registry.json).
 *
 * Identity is the CONTENT, not the filename: the key is sha256(source) plus an optional
 * normalised range, so the same recording re-run (renamed, re-downloaded, moved) reuses its S and
 * gains a new version instead of silently minting a duplicate. A different range of the same
 * recording is a different piece and gets its own S.
 *
 * Mirrors the live V registry discipline (scripts/lib/content-sync/registry.js): every change goes
 * through updateRegistry() — lock, re-read, mutate a copy, validate against the previous copy,
 * atomic write. A registry that does not parse is never overwritten.
 */
import fs from "node:fs";
import path from "node:path";
import { withLockSync } from "../storage/lock.js";
import { writeJsonAtomic } from "../storage/files.js";

export const REGISTRY_VERSION = 1;
export const SHORT_TYPES = ["reel", "ad", "long"];
/** Long-form edits get L### IDs, short-form S### — separate counters in one registry. */
export const prefixFor = (type) => (type === "long" ? "L" : "S");
export const STATUSES = ["registered", "analysing", "planned", "rendering", "qc", "COMPLETE", "NEEDS_REVIEW", "FAILED"];
const ID_RE = /^[SL]\d{3,}$/;

export const formatId = (n, prefix = "S") => `${prefix}${String(n).padStart(3, "0")}`;
export const idNumber = (id) => Number(String(id).slice(1));

/** "12.5-71" / "12.5:71" / {start,end} → "12.500-71.000", or null for no range. */
export function normaliseRange(range) {
  if (range === null || range === undefined || range === "") return null;
  let a, b;
  if (typeof range === "object") ({ start: a, end: b } = range);
  else {
    const m = String(range).trim().match(/^(\d+(?:\.\d+)?)\s*[-:]\s*(\d+(?:\.\d+)?)$/);
    if (!m) throw rangeError(`range "${range}" is not "start-end" in seconds`);
    a = Number(m[1]); b = Number(m[2]);
  }
  if (!(Number.isFinite(a) && Number.isFinite(b)) || a < 0 || b <= a) throw rangeError(`range ${a}-${b} must satisfy 0 <= start < end`);
  return `${a.toFixed(3)}-${b.toFixed(3)}`;
}

function rangeError(msg) { const e = new Error(msg); e.code = "BAD_RANGE"; return e; }

export const identityKey = (sha256, range = null, type = null) => `${sha256}|${normaliseRange(range) ?? "full"}${type === "long" ? "|long" : ""}`;

const emptyRegistry = () => ({ version: REGISTRY_VERSION, shorts: {}, keys: {} });
const clone = (o) => JSON.parse(JSON.stringify(o));

export function loadRegistry(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return emptyRegistry(); throw e; }
  try {
    const reg = JSON.parse(raw);
    if (!reg || typeof reg !== "object" || !reg.shorts || !reg.keys) throw new Error("missing shorts/keys");
    return reg;
  } catch (e) {
    const err = new Error(`S registry ${file} is unreadable (${e.message}) — refusing to touch it. Fix or restore it by hand.`);
    err.code = "REGISTRY_CORRUPT";
    throw err;
  }
}

/** Invariants. `prev` is the registry as it was on disk before this change. */
export function validateRegistry(reg, prev = null) {
  const fail = (m) => { const e = new Error(`S registry invariant: ${m}`); e.code = "REGISTRY_INVARIANT"; throw e; };
  for (const [id, s] of Object.entries(reg.shorts)) {
    if (!ID_RE.test(id) || s.id !== id) fail(`bad id ${id}`);
    if (!SHORT_TYPES.includes(s.type)) fail(`${id} has type "${s.type}"`);
    if (!STATUSES.includes(s.status)) fail(`${id} has status "${s.status}"`);
    if (!s.source?.sha256) fail(`${id} has no source sha256`);
    if (reg.keys[s.key] !== id) fail(`${id} key ${s.key} does not map back to it`);
    const vs = (s.versions ?? []).map((v) => v.v);
    if (new Set(vs).size !== vs.length) fail(`${id} has duplicate version numbers`);
  }
  for (const [key, id] of Object.entries(reg.keys)) if (!reg.shorts[id]) fail(`key ${key} points at missing ${id}`);
  if (prev) {
    for (const [id, p] of Object.entries(prev.shorts)) {
      const n = reg.shorts[id];
      if (!n) fail(`${id} would be removed — S IDs are never deleted`);
      if (n.key !== p.key) fail(`${id} would change identity key`);
      if (n.source.sha256 !== p.source.sha256) fail(`${id} would change source`);
      for (const pv of p.versions ?? []) {
        const nv = (n.versions ?? []).find((v) => v.v === pv.v);
        if (!nv) fail(`${id} v${pv.v} would be removed`);
        if (pv.approved && (nv.render !== pv.render || nv.plan !== pv.plan)) fail(`${id} v${pv.v} is approved and cannot be changed`);
      }
    }
    for (const [key, id] of Object.entries(prev.keys)) if (reg.keys[key] !== id) fail(`key ${key} would move from ${id}`);
  }
}

/** The only way to change the registry. fn(reg) mutates a fresh copy and may return a value. */
export function updateRegistry(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLockSync(`${file}.lock`, () => {
    const prev = loadRegistry(file);
    const reg = clone(prev);
    const out = fn(reg);
    validateRegistry(reg, prev);
    if (JSON.stringify(reg) !== JSON.stringify(prev)) {
      reg.updated_at = new Date().toISOString();
      writeJsonAtomic(file, reg);
    }
    return out === undefined ? undefined : clone(out);
  });
}

/**
 * Find or create the S for this source (+range). Returns { id, reused, record }.
 * `forceId` attaches to an existing S explicitly (must match the source).
 */
export function registerShort({ registryFile, source, type = "reel", range = null, profile, forceId = null, now = new Date() }) {
  if (!SHORT_TYPES.includes(type)) throw new Error(`type must be one of ${SHORT_TYPES.join("|")}, got "${type}"`);
  if (!source?.sha256) throw new Error("registerShort: source.sha256 is required");
  const key = identityKey(source.sha256, range, type);
  return updateRegistry(registryFile, (reg) => {
    const existing = reg.keys[key];
    if (forceId && existing && existing !== forceId) throw new Error(`${forceId} requested but this source+range is already ${existing}`);
    if (forceId && !existing) {
      const s = reg.shorts[forceId];
      if (!s) throw new Error(`${forceId} does not exist`);
      throw new Error(`${forceId} belongs to a different source/range (${s.key}) — refusing to attach`);
    }
    if (existing) {
      const rec = reg.shorts[existing];
      rec.source.last_seen_path = source.original_path ?? rec.source.last_seen_path;
      return { id: existing, reused: true, record: rec };
    }
    const prefix = prefixFor(type);
    const max = Object.keys(reg.shorts).filter((x) => x.startsWith(prefix)).reduce((m, id) => Math.max(m, idNumber(id)), 0);
    const id = formatId(max + 1, prefix);
    const rec = {
      id, key, type,
      source: { ...source },
      range: normaliseRange(range),
      status: "registered",
      profile: profile ?? null,
      transcript_path: null,
      current_version: 0,
      versions: [],
      created_at: now.toISOString(),
    };
    reg.shorts[id] = rec;
    reg.keys[key] = id;
    return { id, reused: false, record: rec };
  });
}

/** Allocate the next version number for an S, under the registry lock. */
export function allocateVersion(registryFile, id, { now = new Date() } = {}) {
  return updateRegistry(registryFile, (reg) => {
    const s = reg.shorts[id];
    if (!s) throw new Error(`allocateVersion: ${id} not in registry`);
    const v = (s.versions ?? []).reduce((m, x) => Math.max(m, x.v), 0) + 1;
    s.versions.push({ v, plan: null, render: null, qc_status: null, created_at: now.toISOString(), approved: false });
    return v;
  });
}

/** Apply fn(record) to one S under the lock. */
export function updateShort(registryFile, id, fn) {
  return updateRegistry(registryFile, (reg) => {
    const s = reg.shorts[id];
    if (!s) throw new Error(`updateShort: ${id} not in registry`);
    return fn(s);
  });
}
