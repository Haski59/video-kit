/**
 * engine/storage/temp.js — disposable working space for one run.
 *
 * Everything bulky and reproducible (16 kHz wav, sampled frames, graphic PNG sequences, the cut
 * audio, partial renders) lives here and is deleted when the run ends — on success, on failure,
 * and on SIGINT/SIGTERM, because `finally` does not run when a signal kills the process. Only the
 * lightweight durable artefacts go to output/<ID>/.
 *
 * Each run dir carries a lock naming its pid, so the start-of-run sweep only removes directories
 * that are both old and abandoned — never a concurrent run's working space.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLock, lockHeld } from "./lock.js";

export const TEMP_PREFIX = "video-kit";
export const tempBase = (base = os.tmpdir()) => path.join(base, TEMP_PREFIX);

const live = new Set();
let handlersInstalled = false;

function installSignalHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(sig, () => {
      for (const t of live) t.cleanup();
      process.exit(128 + (os.constants.signals[sig] ?? 1));
    });
  }
}

/**
 * Create a run's temp dir. Returns { dir, file(name), cleanup(), keep }.
 * `keep: true` (--keep-temp) leaves the directory for inspection and says so.
 */
export function createRunTemp(label, { base = os.tmpdir(), keep = false } = {}) {
  const root = tempBase(base);
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, `${label}-`));
  const release = acquireLock(path.join(dir, ".run.lock"), { label });
  let cleaned = false;
  const t = {
    dir,
    keep,
    file: (name) => path.join(dir, name),
    sub: (name) => { const d = path.join(dir, name); fs.mkdirSync(d, { recursive: true }); return d; },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      live.delete(t);
      release?.();
      if (!keep) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  live.add(t);
  installSignalHandlers();
  return t;
}

/** Remove abandoned run dirs older than maxAgeMs. Never touches a dir whose lock is live. */
export function sweepStale({ base = os.tmpdir(), maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  const root = tempBase(base);
  const removed = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return removed; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    let age = 0;
    try { age = Date.now() - fs.statSync(dir).mtimeMs; } catch { continue; }
    if (age < maxAgeMs) continue;
    if (lockHeld(path.join(dir, ".run.lock"))) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}
