/**
 * S identity: allocation, duplicate prevention, ranges, version allocation, invariants, races.
 * npm run test:shorts
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { registerShort, allocateVersion, updateShort, normaliseRange, identityKey, loadRegistry, formatId } from "../engine/ingest/identity.js";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmpReg = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "s-id-")), "data", "shorts", "registry.json");
const sha = (c) => c.repeat(64).slice(0, 64);
const src = (c, extra = {}) => ({ sha256: sha(c), filename: `${c}.mov`, ...extra });

test("first source becomes S001, the next S002", () => {
  const f = tmpReg();
  assert.equal(registerShort({ registryFile: f, source: src("a") }).id, "S001");
  assert.equal(registerShort({ registryFile: f, source: src("b") }).id, "S002");
  assert.equal(formatId(1234), "S1234");
});

test("the same source never mints a duplicate S ID — it is reused, even under another filename", () => {
  const f = tmpReg();
  const a = registerShort({ registryFile: f, source: src("a") });
  const again = registerShort({ registryFile: f, source: src("a", { filename: "renamed copy.mov", original_path: "/elsewhere/renamed copy.mov" }) });
  assert.equal(again.id, a.id);
  assert.equal(again.reused, true);
  assert.equal(Object.keys(loadRegistry(f).shorts).length, 1);
});

test("a different range of the same recording is a different piece with its own S", () => {
  const f = tmpReg();
  const full = registerShort({ registryFile: f, source: src("a") }).id;
  const r1 = registerShort({ registryFile: f, source: src("a"), range: "10-40" }).id;
  const r1b = registerShort({ registryFile: f, source: src("a"), range: "10.0:40" }).id;
  assert.notEqual(full, r1);
  assert.equal(r1, r1b, "range normalisation makes 10-40 and 10.0:40 the same key");
});

test("normaliseRange validates and canonicalises", () => {
  assert.equal(normaliseRange(null), null);
  assert.equal(normaliseRange("1-2.5"), "1.000-2.500");
  assert.equal(normaliseRange({ start: 3, end: 4 }), "3.000-4.000");
  assert.throws(() => normaliseRange("5-2"), /BAD_RANGE|start < end/);
  assert.throws(() => normaliseRange("abc"), /not "start-end"/);
  assert.equal(identityKey(sha("a")), `${sha("a")}|full`);
});

test("versions allocate 1,2,3 per S and are never reused", () => {
  const f = tmpReg();
  const { id } = registerShort({ registryFile: f, source: src("a") });
  assert.deepEqual([allocateVersion(f, id), allocateVersion(f, id), allocateVersion(f, id)], [1, 2, 3]);
});

test("an approved version cannot be changed and versions/IDs cannot be deleted", () => {
  const f = tmpReg();
  const { id } = registerShort({ registryFile: f, source: src("a") });
  allocateVersion(f, id);
  updateShort(f, id, (s) => { Object.assign(s.versions[0], { render: "renders/v1.mp4", plan: "edit-plan.v1.json", approved: true }); });
  assert.throws(() => updateShort(f, id, (s) => { s.versions[0].render = "renders/other.mp4"; }), /approved and cannot be changed/);
  assert.throws(() => updateShort(f, id, (s) => { s.versions = []; }), /would be removed/);
  assert.throws(() => updateShort(f, id, (s) => { s.source.sha256 = sha("z"); }), /change source|invariant/);
});

test("forceId refuses to attach a different source to an existing S", () => {
  const f = tmpReg();
  registerShort({ registryFile: f, source: src("a") });
  assert.throws(() => registerShort({ registryFile: f, source: src("b"), forceId: "S001" }), /different source/);
  assert.throws(() => registerShort({ registryFile: f, source: src("a"), forceId: "S009" }), /already S001/);
});

test("a corrupt registry is refused, never overwritten", () => {
  const f = tmpReg();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "{ not json");
  assert.throws(() => registerShort({ registryFile: f, source: src("a") }), (e) => e.code === "REGISTRY_CORRUPT");
  assert.equal(fs.readFileSync(f, "utf8"), "{ not json");
});

test("type must be reel or ad", () => {
  assert.throws(() => registerShort({ registryFile: tmpReg(), source: src("a"), type: "vlog" }), /reel\|ad/);
});

test("three processes registering at once get unique, gap-free S IDs", async () => {
  const f = tmpReg();
  const child = (tag) => new Promise((res, rej) => {
    const p = spawn(process.execPath, [path.join(HERE, "fixtures", "alloc-child.mjs"), f, tag, "8"]);
    let out = ""; p.stdout.on("data", (d) => { out += d; });
    p.on("exit", (code) => (code === 0 ? res(JSON.parse(out)) : rej(new Error(`child exit ${code}`))));
  });
  const ids = (await Promise.all(["a", "b", "c"].map(child))).flat();
  assert.equal(new Set(ids).size, 24);
  const nums = ids.map((x) => Number(x.slice(1))).sort((a, b) => a - b);
  assert.deepEqual(nums, Array.from({ length: 24 }, (_, i) => i + 1));
});
