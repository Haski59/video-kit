/**
 * engine/storage/lock.js — cross-process locks for the S registry and per-job runs.
 *
 * Ported from the live scripts/lib/content-sync/lock.js (2026-09-13), which exists because two
 * overlapping runs once both allocated V56. The lock body is written to a temp file and hard-linked
 * into place; link() is atomic and fails with EEXIST, so exactly one process wins and the lock file
 * is never visible half-written. A lock left by a crashed run is reclaimed once its pid is dead or
 * it is older than staleMs.
 */
import fs from "node:fs";
import path from "node:path";

const STALE_MS = 2 * 60 * 60 * 1000;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

export function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** Returns a release() function, or null if another live process holds the lock. */
export function acquireLock(file, meta = {}, { staleMs = STALE_MS } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), ...meta });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, body);
      try { fs.linkSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
      return () => { try { if (readLock(file)?.pid === process.pid) fs.unlinkSync(file); } catch { /* already gone */ } };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let raw;
      try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
      let held = null; try { held = JSON.parse(raw); } catch { /* unreadable */ }
      let ageMs = 0;
      try { ageMs = Date.now() - fs.statSync(file).mtimeMs; } catch { continue; }
      const stale = held
        ? !pidAlive(held.pid) || Date.now() - new Date(held.started_at).getTime() > staleMs
        : ageMs > 60 * 1000;
      if (!stale) return null;
      // Reclaim by renaming to a unique name: only one reclaimer's rename can succeed. If the file we
      // moved is not the stale lock we judged, another process got there first — put it back.
      const moved = `${file}.stale.${process.pid}.${Date.now()}`;
      try { fs.renameSync(file, moved); } catch { return null; }
      let movedRaw = null;
      try { movedRaw = fs.readFileSync(moved, "utf8"); } catch { /* vanished */ }
      if (movedRaw !== raw) {
        try { fs.linkSync(moved, file); } catch { /* lost the race */ }
        fs.rmSync(moved, { force: true });
        return null;
      }
      fs.rmSync(moved, { force: true });
    }
  }
  return null;
}

export function lockHeld(file, { staleMs = STALE_MS } = {}) {
  const held = readLock(file);
  return !!held && pidAlive(held.pid) && Date.now() - new Date(held.started_at).getTime() <= staleMs;
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Hold a short lock around fn(), waiting up to waitMs. For read-modify-write sections. */
export function withLockSync(file, fn, { waitMs = 30000, meta = {} } = {}) {
  const until = Date.now() + waitMs;
  let release = acquireLock(file, meta);
  while (!release) {
    if (Date.now() > until) {
      const e = new Error(`timed out waiting for ${path.basename(file)}`);
      e.code = "LOCK_TIMEOUT";
      throw e;
    }
    sleepSync(25 + Math.floor(Math.random() * 50));
    release = acquireLock(file, meta);
  }
  try { return fn(); } finally { release(); }
}
