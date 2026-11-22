/**
 * engine/app/server.js — the Video Kit app: a local web interface members open by double-clicking
 * "Video Kit.command". It only listens on 127.0.0.1, refuses requests from other sites, and never
 * serves files outside this kit's folders.
 *
 * Every action runs the same engine commands the CLI does (engine/cli.js), as tracked tasks with live
 * progress. Steps that need judgement or writing (publish copy, faceless videos, scripts) run the
 * member's own Claude Code headless (`claude -p`) inside the kit, so the kit's CLAUDE.md and skills apply.
 *
 *   node engine/app/server.js [--port 4777] [--no-open]
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, readJson, writeJsonAtomic, pathsFor } from "../storage/files.js";
import { findClaude } from "../llm/claude.js";

const ROOT = process.env.KIT_ROOT ? path.resolve(process.env.KIT_ROOT) : REPO_ROOT;
const KIT = REPO_ROOT;
const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");
const P = pathsFor(ROOT);
const TASKS_FILE = path.join(P.dataDir, "app-tasks.json");
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf("--port") + 1]) || Number(process.env.KIT_PORT) || 4777;
const MEDIA_ROOTS = [path.join(ROOT, "output"), path.join(ROOT, "projects")];
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mts)$/i;

// ── tasks ────────────────────────────────────────────────────────────────────
const tasks = new Map();
const persisted = readJson(TASKS_FILE, { tasks: [] }).tasks ?? [];
for (const t of persisted) tasks.set(t.id, { ...t, status: t.status === "running" ? "stopped" : t.status });
let saveTimer = null;
function saveTasks() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const list = [...tasks.values()].slice(-200).map(({ proc, ...t }) => ({ ...t, log: t.log.slice(-300) }));
    try { writeJsonAtomic(TASKS_FILE, { tasks: list }); } catch { /* output/ may not exist yet */ }
  }, 300);
}

const STAGES = [
  ["download", /downloading the reference/i], ["transcribe", /transcrib|whisper/i], ["analyse", /analyse:|reference:/i], ["breakdown", /breakdown: splitting/i], ["review", /checking each shot by eye/i],
  ["cut", /rough cut|timing:/i], ["plan", /plan v\d|planner/i], ["render", /render v\d|graphic g\d/i], ["check", /^\s*(S|L)\d{3} — |QA —|Reference analysed/],
];

function newTask(kind, title, meta = {}) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const t = { id, kind, title, meta, status: "running", stage: null, log: [], startedAt: new Date().toISOString(), endedAt: null, result: null };
  tasks.set(id, t);
  saveTasks();
  return t;
}

function addLog(t, line) {
  const s = line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
  if (!s.trim()) return;
  t.log.push(s);
  for (const [name, re] of STAGES) if (re.test(s)) t.stage = name;
  saveTasks();
}

/** Run one command as part of a task; resolves with { code, out }. */
function run(t, cmd, cmdArgs, { env = {}, cwd = KIT } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, cmdArgs, { cwd, env: { ...process.env, KIT_ROOT: ROOT, ...env } });
    t.proc = p;
    let out = "", buf = "";
    const onData = (d) => {
      const s = d.toString();
      out += s;
      buf += s;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const l of lines) addLog(t, l.replace(/^\s*· /, ""));
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("close", (code) => { if (buf) addLog(t, buf); t.proc = null; resolve({ code, out }); });
    p.on("error", (e) => { addLog(t, `could not start ${cmd}: ${e.message}`); resolve({ code: 1, out }); });
  });
}

function finish(t, status, result = null) {
  t.status = status;
  t.endedAt = new Date().toISOString();
  t.result = result;
  t.stage = status === "failed" ? t.stage : "done";
  saveTasks();
}

const kit = (t, ...a) => run(t, process.execPath, [path.join(KIT, "engine", "cli.js"), ...a]);
const statusOf = (code) => (code === 0 ? "done" : code === 3 ? "needs_review" : "failed");

/** Claude Code headless inside the kit — the member's own login. */
function claudeTask(t, prompt, { tools = "Bash,Read,Write,Edit,Glob,Grep,Skill" } = {}) {
  const bin = findClaude();
  if (!bin) { addLog(t, "Claude Code is not installed — see SOP 00."); return Promise.resolve({ code: 1, out: "" }); }
  return run(t, bin, ["-p", prompt, "--allowedTools", tools, "--output-format", "text"], { cwd: ROOT === KIT ? KIT : ROOT });
}

// ── state ────────────────────────────────────────────────────────────────────
// The setup check takes a few seconds (it asks Homebrew), so it runs in the background and the page
// shows "Checking this Mac…" until it lands. Items are tagged by who can fix them: the app can install
// tools; disk space, Homebrew (needs the Mac password), Chrome and Claude Code need the member.
let setupCache = { checking: true, ready: false, missing: [], notes: [] };
let setupRunning = false;
function refreshSetup() {
  if (setupRunning) return;
  setupRunning = true;
  const p = spawn("/bin/bash", [path.join(KIT, "setup.sh"), "--check"], { cwd: KIT });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  p.on("close", (code) => {
    const text = out.replace(/\x1b\[[0-9;]*m/g, "");
    const missing = text.split("\n").filter((l) => /^\s*✗/.test(l)).map((l) => l.replace(/^\s*✗\s*/, "").trim())
      .map((m) => ({ text: m, you: /free|Homebrew|Chrome|Claude Code/i.test(m) }));
    const notes = text.split("\n").filter((l) => /^\s*!/.test(l)).map((l) => l.replace(/^\s*!\s*/, "").trim());
    setupCache = { at: Date.now(), checking: false, ready: code === 0, missing, notes };
    setupRunning = false;
  });
}
function setupStatus(force = false) {
  if (force || (!setupCache.checking && Date.now() - setupCache.at > 120000)) refreshSetup();
  return setupCache;
}
refreshSetup();

function profile() {
  const brand = readJson(path.join(P.memberDir, "brand.json"), null);
  const lex = readJson(path.join(P.memberDir, "lexicon.json"), null);
  let voice = null;
  try { voice = fs.readFileSync(path.join(P.memberDir, "voice-and-offer.md"), "utf8"); } catch { /* not onboarded */ }
  const field = (h) => voice?.match(new RegExp(`## ${h}\\n([\\s\\S]*?)(?=\\n## |$)`))?.[1]?.trim() ?? "";
  return {
    onboarded: Boolean(brand && voice),
    name: field("Creator"), audience: field("Audience"), offer: field("Offer"), cta: field("Call to action"),
    tone: field("Tone"), never: field("Never say"), proof: field("Proof I can mention"), platforms: field("Platforms"),
    terms: (lex?.allowlist ?? []).join(", "), accent: brand?.accent ?? "#FF4A1C", font: brand?.captionFont ?? "Avenir Next Heavy",
    currency: brand?.currency ?? "$", channel: brand?.name ?? "",
  };
}

function jobs() {
  const reg = readJson(P.registry, { shorts: {} });
  return Object.values(reg.shorts).map((s) => {
    const dir = P.jobDir(s.id), v = s.current_version;
    const exists = (f) => fs.existsSync(path.join(dir, f));
    const qc = v ? readJson(path.join(dir, `qc.v${v}.json`), null) : null;
    const flags = (qc?.checks ?? []).filter((c) => c.status === "fail" || c.status === "warn").map((c) => ({ id: c.id, status: c.status, detail: c.detail }));
    return {
      id: s.id, type: s.type, status: s.status, version: v, source: s.source?.filename, range: s.range, updated: s.updated_at ?? s.created_at,
      video: v && exists(`renders/v${v}.mp4`) ? path.join(dir, `renders/v${v}.mp4`) : null,
      captions: v && exists(`renders/v${v}.srt`) ? path.join(dir, `renders/v${v}.srt`) : null,
      preview: v && exists(`preview.v${v}.jpg`) ? path.join(dir, `preview.v${v}.jpg`) : null,
      thumbnail: exists("thumbnail/thumbnail.png") ? path.join(dir, "thumbnail/thumbnail.png") : null,
      publishPack: exists("publish-pack.md") ? path.join(dir, "publish-pack.md") : null,
      style: s.profile?.id?.startsWith("REF_") ? s.profile.id.replace(/^REF_/, "").replace(/_(LONG|SHORT)$/, "") : null,
      flags,
    };
  }).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

function styles() {
  const dir = path.join(P.dataDir, "references");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, "style.json"))).map((d) => {
    const s = readJson(path.join(dir, d, "style.json"));
    let brief = "";
    try { brief = fs.readFileSync(path.join(dir, d, "STYLE.md"), "utf8"); } catch { /* none */ }
    const report = s.breakdown?.report && fs.existsSync(path.join(dir, d, s.breakdown.report)) ? `/files/references/${encodeURIComponent(d)}/${s.breakdown.report}` : null;
    return { name: d, report, reviewed: Boolean(s.breakdown?.reviewed), title: s.reference?.title, channel: s.reference?.channel, format: s.reference?.format, analysedAt: s.analysed_at, brief,
      facts: [
        s.captions?.present ? `${s.captions.wordsPerLine}-word captions, ${s.captions.uppercaseShare >= 0.6 ? "UPPERCASE" : "lowercase"}` : "no burned captions",
        `${Math.round(s.speech?.wordsPerMin ?? 0) || "?"} words/min`, `${s.editing?.cutsPerMin ?? "?"} cuts/min`, `${s.editing?.zoomCutsPerMin ?? 0} zooms/min`,
        s.music?.likely ? "background music/noise" : "no music bed",
      ] };
  });
}

function faceless() {
  const dir = path.join(ROOT, "projects");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, "script.txt"))).map((d) => {
    const video = path.join(dir, d, `${d}.mp4`);
    return { slug: d, script: fs.readFileSync(path.join(dir, d, "script.txt"), "utf8"), video: fs.existsSync(video) ? video : null,
      updated: fs.statSync(path.join(dir, d)).mtime.toISOString() };
  }).sort((a, b) => b.updated.localeCompare(a.updated));
}

function freeGb() {
  try { const s = fs.statfsSync(ROOT); return Number(((Number(s.bavail) * Number(s.bsize)) / 2 ** 30).toFixed(1)); } catch { return null; }
}

// ── actions ──────────────────────────────────────────────────────────────────
const slug = (s) => String(s || "video").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "video";

async function startEdit({ file, mode = "both", style = null, count = 3 }) {
  if (!file || !fs.existsSync(file)) throw new Error("that file is no longer there — choose it again");
  const name = path.basename(file);
  const t = newTask("edit", { both: "Long video + shorts", long: "Long video", shorts: "Shorts", short: "Short" }[mode] + ` · ${name}`, { file, mode, style });
  (async () => {
    const st = style ? ["--style", style] : [];
    let worst = 0;
    if (mode === "long" || mode === "both") { const r = await kit(t, "long", file, ...st); worst = Math.max(worst, r.code); if (r.code === 1) return finish(t, "failed"); }
    if (mode === "shorts" || mode === "both") { const r = await kit(t, "clips", file, "--count", String(count), ...st); worst = Math.max(worst, r.code); }
    if (mode === "short") { const r = await kit(t, "short", file, ...st); worst = Math.max(worst, r.code); }
    finish(t, worst === 1 ? "failed" : worst === 3 ? "needs_review" : "done");
  })();
  return t;
}

async function startReference({ source, name, breakdown = false }) {
  const t = newTask("style", `${breakdown ? "Learn style + breakdown" : "Learn style"} · ${name || source}`, { source, breakdown });
  (async () => {
    const r = breakdown ? await kit(t, "breakdown", source, "--name", name || "style", "--review") : await kit(t, "reference", source, "--name", name || "style");
    finish(t, statusOf(r.code));
  })();
  return t;
}

async function startThumbnail({ id, text }) {
  const t = newTask("thumbnail", `Thumbnail · ${id} · “${text}”`, { id });
  (async () => { const r = await kit(t, "thumbnail", id, "--text", text); finish(t, statusOf(r.code)); })();
  return t;
}

async function startCopy({ id }) {
  const t = newTask("copy", `Post copy · ${id}`, { id });
  (async () => {
    const r = await claudeTask(t, `Run /publish-pack for job ${id} (output/${id}). Write output/${id}/publish-pack.md. The member is using the app, not chat: do not ask questions; use their profile. End with a 3-line summary.`);
    finish(t, r.code === 0 && fs.existsSync(path.join(P.jobDir(id), "publish-pack.md")) ? "done" : "failed");
  })();
  return t;
}

async function startFix({ id, request }) {
  const t = newTask("fix", `Change · ${id} · “${request.slice(0, 60)}”`, { id });
  (async () => {
    const r = await claudeTask(t, `The member wants this change to job ${id}: "${request}". Follow the /longform (or /shorts) skill's "Fixing things" section: use \`npm run -s kit -- where\` and --keep/--cut/--from as needed, re-run the edit, check QA. Don't ask questions. End with what changed in 2 lines.`);
    finish(t, r.code === 0 ? "done" : "failed");
  })();
  return t;
}

async function startScript({ idea, format, style }) {
  const t = newTask("script", `Script · ${idea.slice(0, 60)}`, { idea, format, style });
  (async () => {
    const s = slug(idea.split(/\s+/).slice(0, 6).join(" "));
    const r = await claudeTask(t, `Follow the /faceless skill, steps 1–2 only: write the spoken script for a ${format === "landscape" ? "landscape 2–4 minute" : "vertical 30–60 second"} faceless video about: "${idea}".${style ? ` Use the structure in output/references/${style}/STYLE.md.` : ""} Save it to projects/${s}/script.txt and stop — do not voice or render. Don't ask questions.`, { tools: "Read,Write,Glob,Grep,Skill" });
    const file = path.join(ROOT, "projects", s, "script.txt");
    finish(t, r.code === 0 && fs.existsSync(file) ? "done" : "failed", { slug: s });
  })();
  return t;
}

async function startFaceless({ slug: s, script, format, voice, style }) {
  const dir = path.join(ROOT, "projects", s);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "script.txt"), script.trim() + "\n");
  const t = newTask("faceless", `Faceless video · ${s}`, { slug: s });
  (async () => {
    const r = await claudeTask(t, `Follow the /faceless skill from step 3 for projects/${s}: the member APPROVED projects/${s}/script.txt — use it word for word. Format: ${format === "landscape" ? "landscape 1920x1080" : "vertical 1080x1920"}. Voice: ${voice}.${style ? ` Style: output/references/${style}/STYLE.md.` : ""} Final file: projects/${s}/${s}.mp4. Run kit qa. Don't ask questions. End with the QA status and what to check.`);
    const ok = fs.existsSync(path.join(dir, `${s}.mp4`));
    finish(t, r.code === 0 && ok ? (/NEEDS_REVIEW/.test(r.out) ? "needs_review" : "done") : "failed", { slug: s });
  })();
  return t;
}

function saveProfile(p) {
  fs.mkdirSync(P.memberDir, { recursive: true });
  const base = readJson(path.join(KIT, "config", "brand.default.json"));
  const font = p.font || "Avenir Next Heavy";
  const fam = font.replace(/\s+(Heavy|Bold|Black|Demi Bold|Medium)$/i, "");
  writeJsonAtomic(path.join(P.memberDir, "brand.json"), { ...base, name: p.channel || p.name || "My Channel", accent: p.accent || base.accent,
    captionFont: font, fontFamily: fam, cssFont: `'${fam}',-apple-system,sans-serif`, currency: p.currency || "$" });
  const terms = String(p.terms || "").split(",").map((x) => x.trim()).filter(Boolean);
  const lexBase = readJson(path.join(KIT, "config", "lexicon.default.json"));
  writeJsonAtomic(path.join(P.memberDir, "lexicon.json"), { ...lexBase,
    prompt: `A talking-head video by ${p.name || "the creator"} about ${p.audience ? `helping ${p.audience}` : "business"}.`,
    replacements: { ...lexBase.replacements, ...Object.fromEntries(terms.filter((x) => !/\s/.test(x)).map((x) => [x.toLowerCase(), x])) },
    phrases: { ...lexBase.phrases, ...Object.fromEntries(terms.filter((x) => /\s/.test(x)).map((x) => [x.toLowerCase(), x])) },
    allowlist: [...new Set([...lexBase.allowlist, ...terms.flatMap((x) => x.split(/\s+/))])] });
  const md = [`# Voice and offer`, "", `## Creator\n${p.name || ""}${p.channel ? ` (${p.channel})` : ""}`, "", `## Audience\n${p.audience || ""}`, "", `## Offer\n${p.offer || ""}`, "",
    `## Call to action\n${p.cta || ""}`, "", `## Tone\n${p.tone || ""}`, "", `## Never say\n${p.never || ""}`, "", `## Proof I can mention\n${p.proof || ""}`, "", `## Platforms\n${p.platforms || ""}`, ""].join("\n");
  fs.writeFileSync(path.join(P.memberDir, "voice-and-offer.md"), md);
  fs.mkdirSync(path.join(KIT, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(KIT, ".agents", "product-marketing.md"), `# Product marketing context\n\n${md.replace(/^# Voice and offer\n/, "")}`);
}

function pickFile() {
  const r = spawnSync("/usr/bin/osascript", ["-e", 'POSIX path of (choose file with prompt "Choose a recording" of type {"public.movie"})'], { encoding: "utf8" });
  if (r.status !== 0) return null; // cancelled
  return r.stdout.trim();
}

// ── http ─────────────────────────────────────────────────────────────────────
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".mp4": "video/mp4", ".srt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".json": "application/json" };

const send = (res, code, body, type = "application/json") => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };

function inside(file, roots) { const f = path.resolve(file); return roots.some((r) => f === r || f.startsWith(r + path.sep)); }

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(new Error("request too large")); req.destroy(); } else parts.push(c); });
    req.on("end", () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {}); } catch (e) { reject(e); } });
  });
}

function serveFile(req, res, file) {
  const st = fs.statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0, end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${st.size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "content-type": type, "content-length": st.size, "accept-ranges": "bytes" });
    fs.createReadStream(file).pipe(res);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    // Only this app's own pages may call it (stops other websites from driving the kit).
    const host = String(req.headers.host || "");
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, { error: "forbidden host" });
    if (req.method !== "GET" && (req.headers["x-kit"] !== "1" || (req.headers.origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.origin)))) return send(res, 403, { error: "forbidden" });

    if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/ui/"))) {
      const f = url.pathname === "/" ? path.join(UI, "index.html") : path.join(UI, url.pathname.slice(4));
      if (!inside(f, [UI]) || !fs.existsSync(f)) return send(res, 404, "not found", "text/plain");
      return serveFile(req, res, f);
    }
    // Reports with their own images/links (rea-video breakdowns), served by path so relative links work.
    if (req.method === "GET" && url.pathname.startsWith("/files/")) {
      const f = path.join(P.dataDir, decodeURIComponent(url.pathname.slice(7)));
      if (!inside(f, [P.dataDir]) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(res, 404, "not found", "text/plain");
      return serveFile(req, res, f);
    }
    if (req.method === "GET" && url.pathname === "/media") {
      const f = url.searchParams.get("path");
      if (!f || !inside(f, MEDIA_ROOTS) || !fs.existsSync(f)) return send(res, 404, "not found", "text/plain");
      return serveFile(req, res, f);
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      return send(res, 200, { setup: setupStatus(url.searchParams.get("recheck") === "1"), profile: profile(), jobs: jobs(), styles: styles(), faceless: faceless(), freeGb: freeGb(),
        claude: Boolean(findClaude()),
        tasks: [...tasks.values()].slice(-40).reverse().map(({ proc, log, ...t }) => ({ ...t, last: log.slice(-1)[0] ?? "", log: log.slice(-60) })) });
    }
    if (req.method === "POST" && url.pathname === "/api/upload") {
      // Raw file body (drag and drop). Saved to projects/<name>/ — the original on their Mac is untouched.
      const name = path.basename(url.searchParams.get("name") || "recording.mp4").replace(/[^\w.\- ]+/g, "_");
      if (!VIDEO_EXT.test(name)) return send(res, 400, { error: "That isn't a video file. Drop an .mp4 or .mov." });
      const dir = path.join(ROOT, "projects", slug(name.replace(/\.[^.]+$/, "")));
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, name);
      const out = fs.createWriteStream(`${dest}.part`);
      req.pipe(out);
      out.on("finish", () => { fs.renameSync(`${dest}.part`, dest); send(res, 200, { path: dest }); });
      out.on("error", (e) => send(res, 500, { error: e.message }));
      return;
    }
    const body = req.method === "POST" ? await readBody(req) : {};
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "POST /api/pick": { const f = pickFile(); return send(res, 200, { path: f }); }
      case "POST /api/edit": return send(res, 200, await startEdit(body));
      case "POST /api/style": return send(res, 200, await startReference(body));
      case "POST /api/thumbnail": return send(res, 200, await startThumbnail(body));
      case "POST /api/copy": return send(res, 200, await startCopy(body));
      case "POST /api/fix": return send(res, 200, await startFix(body));
      case "POST /api/script": return send(res, 200, await startScript(body));
      case "POST /api/faceless": return send(res, 200, await startFaceless(body));
      case "POST /api/profile": saveProfile(body); return send(res, 200, { ok: true, profile: profile() });
      case "POST /api/setup": {
        const t = newTask("setup", "Install what's missing", {});
        (async () => { const r = await run(t, "/bin/bash", [path.join(KIT, "setup.sh")]); refreshSetup(); finish(t, r.code === 0 ? "done" : "failed"); })();
        return send(res, 200, t);
      }
      case "POST /api/reveal": {
        if (!body.path || !inside(body.path, MEDIA_ROOTS)) return send(res, 400, { error: "not a kit file" });
        spawnSync("/usr/bin/open", ["-R", body.path]);
        return send(res, 200, { ok: true });
      }
      case "POST /api/stop": {
        const t = tasks.get(body.id);
        if (t?.proc) t.proc.kill("SIGINT");
        return send(res, 200, { ok: true });
      }
      default: return send(res, 404, { error: "unknown action" });
    }
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") { console.log(`Video Kit is already running: http://127.0.0.1:${PORT}`); if (!args.includes("--no-open")) spawnSync("/usr/bin/open", [`http://127.0.0.1:${PORT}`]); process.exit(0); }
  throw e;
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Video Kit is running at http://127.0.0.1:${PORT}\nKeep this window open while you use it. Close it to stop.`);
  if (!args.includes("--no-open")) spawnSync("/usr/bin/open", [`http://127.0.0.1:${PORT}`]);
});
