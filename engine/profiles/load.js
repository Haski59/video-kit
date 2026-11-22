/**
 * engine/profiles/load.js — editing profiles are data, not scattered code.
 *
 * A profile declares every behaviour the planner may use (pacing, captions, punch-in presets,
 * graphics, safe zones, hook rules, audio targets). The loader refuses placeholders and anything
 * structurally incomplete, and returns a {id, version, hash} reference that is stamped into every
 * edit plan — so "source + profile version + edit plan" always explains how a render was made.
 */
import fs from "node:fs";
import path from "node:path";
import { hashObject, pathsFor } from "../storage/files.js";

const REQUIRED_SECTIONS = ["output", "pacing", "silence", "retakes", "reframe", "captions", "punchIns", "graphics",
  "broll", "transitions", "sfx", "music", "safeZones", "hook", "density", "audio", "qc"];

/** Strip documentation keys so editing a comment does not change the behavioural hash. */
function stripDocs(v) {
  if (Array.isArray(v)) return v.map(stripDocs);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith("_")).map(([k, x]) => [k, stripDocs(x)]));
  }
  return v;
}

function readBrand(root) {
  try { return JSON.parse(fs.readFileSync(pathsFor(root).brand, "utf8")); } catch { return null; }
}

/** The member's brand sets caption font and colours; the profile keeps every timing/layout rule. */
export function applyBrand(profile, brand) {
  if (!brand) return profile;
  const c = { ...profile.captions };
  if (brand.captionFont) c.font = brand.captionFont;
  if (brand.accent) c.emphasisColour = brand.accent;
  if (brand.captionColour) c.primaryColour = brand.captionColour;
  return { ...profile, captions: c };
}

export function listProfiles(root) {
  const dirs = [pathsFor(root).profilesDir, path.join(pathsFor(root).memberDir, "profiles")].filter((d) => fs.existsSync(d));
  return dirs.flatMap((dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f))).map((file) => {
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    return { id: p.id, version: p.version, status: p.status, types: p.types };
  });
}

export function loadProfile(id, { root, type = null } = {}) {
  if (!/^[A-Z0-9_]+$/.test(String(id))) throw new Error(`profile id "${id}" is not a valid profile name`);
  // A member's generated profiles (kit reference) live in member/profiles and win over the kit's own.
  const memberFile = path.join(pathsFor(root).memberDir, "profiles", `${id}.json`);
  const file = fs.existsSync(memberFile) ? memberFile : path.join(pathsFor(root).profilesDir, `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`profile ${id} not found (${file})`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (raw.id !== id) throw new Error(`profile file ${file} declares id "${raw.id}", expected "${id}"`);
  if (raw.status === "placeholder") {
    const e = new Error(`profile ${id} is a documented placeholder and is not implemented yet — use SHORT_TALKING_HEAD or LONG_TALKING_HEAD`);
    e.code = "PROFILE_PLACEHOLDER";
    throw e;
  }
  if (raw.status !== "active") throw new Error(`profile ${id} has status "${raw.status}" — only "active" profiles can edit`);
  const missing = REQUIRED_SECTIONS.filter((s) => !raw[s]);
  if (missing.length) throw new Error(`profile ${id} is missing section(s): ${missing.join(", ")}`);
  if (type && !raw.types.includes(type)) throw new Error(`profile ${id} does not support type "${type}" (supports ${raw.types.join(", ")})`);
  const presets = raw.punchIns.presets ?? {};
  for (const [name, p] of Object.entries(presets)) {
    if (!["cut", "ease"].includes(p.kind)) throw new Error(`profile ${id} preset ${name} has kind "${p.kind}"`);
    if (!(p.scale >= 1 && p.scale <= raw.punchIns.maxScale)) throw new Error(`profile ${id} preset ${name} scale ${p.scale} exceeds maxScale ${raw.punchIns.maxScale}`);
  }
  for (const k of ["hookPreset", "bodyPreset", "cutPreset"]) {
    if (raw.punchIns[k] && !presets[raw.punchIns[k]]) throw new Error(`profile ${id} ${k} names unknown preset ${raw.punchIns[k]}`);
  }
  const profile = applyBrand(stripDocs(raw), readBrand(root));
  return { profile, ref: { id, version: raw.version, hash: hashObject(profile).slice(0, 16) } };
}
