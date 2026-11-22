// Video Kit app — talks to engine/app/server.js on this Mac only.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const media = (p) => `/media?path=${encodeURIComponent(p)}`;

let state = null;
let chosenFile = null;          // absolute path of the recording to edit
let pendingScript = null;       // task id of a "write the script" task we're waiting for
const seenDone = new Set();

async function api(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-kit": "1" }, body: JSON.stringify(body ?? {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `request failed (${r.status})`);
  return j;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 3500);
}

function ask({ title, text = "", label = "", value = "", placeholder = "", ok = "OK", input = true }) {
  const d = $("#dlg");
  $("#dlg-title").textContent = title;
  $("#dlg-text").textContent = text;
  $("#dlg-label").textContent = label;
  $("#dlg-field").hidden = !input;
  const i = $("#dlg-input");
  i.value = value; i.placeholder = placeholder;
  $("#dlg-ok").textContent = ok;
  d.showModal();
  if (input) i.focus();
  return new Promise((res) => d.addEventListener("close", () => res(d.returnValue === "ok" ? (input ? i.value.trim() : true) : null), { once: true }));
}

// ── tabs ──
function showTab(name) {
  $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  $$(".tab-panel").forEach((p) => { p.hidden = p.dataset.panel !== name; });
}
$$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ── choosing a recording ──
const drop = $("#drop");
function setFile(path, label) {
  chosenFile = path;
  $("#vf-empty").hidden = Boolean(path || label);
  $("#vf-file").hidden = !(path || label);
  $("#file-name").textContent = label || (path ? path.split("/").pop() : "");
  drop.classList.toggle("ready", Boolean(path));
  $("#vf-tc").textContent = path ? "READY" : "00:00:00:00";
  $("#vf-tc").parentElement.querySelector(".vf-rec").lastChild.textContent = path ? "REC" : "STBY";
  $("#start").disabled = !path;
}
$("#file-clear").addEventListener("click", () => setFile(null));
$("#pick").addEventListener("click", async () => {
  try { const r = await api("/api/pick"); if (r.path) setFile(r.path); } catch (e) { toast(e.message); }
});
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (!/\.(mp4|mov|m4v|mkv|webm|avi|mts)$/i.test(f.name)) return toast("That isn't a video file. Drop an .mp4 or .mov.");
  upload(f);
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());

function upload(file) {
  setFile(null, file.name);
  $("#upload").hidden = false;
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/upload?name=${encodeURIComponent(file.name)}`);
  xhr.setRequestHeader("x-kit", "1");
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const p = Math.round((e.loaded / e.total) * 100);
    $("#upload-fill").style.width = `${p}%`;
    $("#upload-pct").textContent = `${p}%`;
  };
  xhr.onload = () => {
    $("#upload").hidden = true;
    const j = JSON.parse(xhr.responseText || "{}");
    if (xhr.status !== 200) { setFile(null); return toast(j.error || "Couldn't copy that file in."); }
    setFile(j.path, file.name);
  };
  xhr.onerror = () => { $("#upload").hidden = true; setFile(null); toast("Couldn't copy that file in. Try Choose from my Mac."); };
  xhr.send(file);
}

$("#edit-form").addEventListener("change", () => {
  const mode = new FormData($("#edit-form")).get("mode");
  $("#count-field").hidden = !(mode === "both" || mode === "shorts");
});
$("#edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!chosenFile) return;
  const fd = new FormData(e.target);
  try {
    await api("/api/edit", { file: chosenFile, mode: fd.get("mode"), style: fd.get("style") || null, count: Number(fd.get("count") || 3) });
    toast("Started. You can leave this open, or close the tab and come back.");
    setFile(null);
    refresh();
  } catch (err) { toast(err.message); }
});

// ── faceless ──
$("#idea-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state?.claude) return toast("Claude Code isn't installed on this Mac. See SOP 00.");
  const fd = new FormData(e.target);
  try {
    const t = await api("/api/script", { idea: fd.get("idea"), format: fd.get("format"), style: fd.get("style") || null });
    pendingScript = t.id;
    $("#write-script").disabled = true;
    $("#write-script").textContent = "Writing…";
    refresh();
  } catch (err) { toast(err.message); }
});
$("#script-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const idea = new FormData($("#idea-form"));
  const fd = new FormData(e.target);
  try {
    await api("/api/faceless", { slug: e.target.dataset.slug, script: fd.get("script"), format: idea.get("format"), voice: fd.get("voice"), style: idea.get("style") || null });
    toast("Making your video. This takes a few minutes.");
    e.target.hidden = true;
    $("#idea-form").reset();
    refresh();
  } catch (err) { toast(err.message); }
});

// ── styles ──
$("#style-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const breakdown = fd.get("breakdown") === "on";
    await api("/api/style", { source: fd.get("source"), name: fd.get("name"), breakdown });
    toast(breakdown ? "Studying the video shot by shot. This takes a few minutes." : "Studying the video. This takes about a minute.");
    e.target.reset();
    refresh();
  } catch (err) { toast(err.message); }
});

// ── profile ──
$("#profile-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  try {
    await api("/api/profile", body);
    $("#profile-saved").textContent = "Saved. Every new video uses it.";
    await refresh();
    if (!wasOnboarded) { wasOnboarded = true; showTab("edit"); toast("You're set. Drop your first recording."); }
  } catch (err) { toast(err.message); }
});
let wasOnboarded = true;

// ── setup ──
$("#setup-run").addEventListener("click", async () => { try { await api("/api/setup"); refresh(); } catch (e) { toast(e.message); } });
$("#setup-recheck").addEventListener("click", () => refresh(true));

// ── rendering ──
const FLAG_WORDS = {
  speech_edges: "Listen at these cuts. One may clip a word",
  unreviewed_retake: "Possible repeated take left in",
  word_survival: "A word may be missing from the captions",
  caption_density: "Some captions flash by quickly",
  face_vs_text: "Text may be close to your face",
  round_trip: "Captions may have a wrong word",
  loudness: "Volume is off target",
  true_peak: "Volume peaks a little high",
  planner: "Used the standard editor (Claude was busy)",
  captions_visible: "Captions may not be visible",
  duplicate_phrase: "A phrase may be repeated",
};
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
/** A QA finding in the member's words: what to do and where, never dB or check names. */
function plainFlag(f) {
  const times = [...String(f.detail).matchAll(/at (\d+(?:\.\d+)?)s/g)].map((m) => mmss(Number(m[1])));
  const where = times.length ? ` around ${[...new Set(times)].slice(0, 4).join(", ")}` : "";
  if (f.id === "speech_edges") return `Listen${where}: a cut may clip a word. If it does, use “Ask for a change”.`;
  if (f.id === "unreviewed_retake") {
    const t = String(f.detail).match(/(\d+(?:\.\d+)?)s repeated/);
    return `Possible repeated take${t ? ` in your recording at ${mmss(Number(t[1]))}` : ""}. Listen, then ask to remove the first take if it's a repeat.`;
  }
  return `${FLAG_WORDS[f.id] ?? "Have a look"}${where}.`;
}

const STRIPS = {
  edit: ["transcribe", "cut", "plan", "render", "check"],
  style: ["download", "transcribe", "analyse", "breakdown", "review", "check"],
  thumbnail: ["render", "check"],
  setup: [],
};
const LABEL = { transcribe: "Listen", cut: "Cut", plan: "Plan", render: "Render", check: "Check", download: "Fetch", analyse: "Study", breakdown: "Shots", review: "Eye check" };
const STATUS_TEXT = { running: "Working", done: "Ready", needs_review: "Needs a look", failed: "Didn't finish", stopped: "Stopped", COMPLETE: "Ready to post", NEEDS_REVIEW: "Needs a look", FAILED: "Didn't finish" };

function strip(t) {
  const st = t.kind === "style" && !t.meta?.breakdown ? ["download", "transcribe", "analyse", "check"] : STRIPS[t.kind];
  if (!st || !st.length) return "";
  const at = t.status === "running" ? st.indexOf(t.stage) : st.length;
  return `<div class="strip" style="grid-template-columns:repeat(${st.length},1fr)">${st.map((s, i) => `<i class="${i < at ? "done" : i === at ? "now" : ""}">${LABEL[s]}</i>`).join("")}</div>`;
}

// Redraw a section only when its data changed, so playing videos and open details aren't reset.
const sigs = {};
function changed(key, data) { const s = JSON.stringify(data); if (sigs[key] === s) return false; sigs[key] = s; return true; }

const DONE_TEXT = {
  edit: "Finished. Your videos are below.", style: "Learned. Pick it from the Style menu when you make videos.",
  thumbnail: "Thumbnail is on the video's card.", copy: "Post copy is ready. Open it from the video's card.",
  fix: "Change made. The video's card has the new version.", script: "Script ready to edit.", faceless: "Your video is ready below.", setup: "Setup finished.",
};
/** One plain line per task: what's happening now, or what came out of it. No file paths. */
function taskLine(t) {
  if (t.status === "running") {
    const claude = ["copy", "fix", "script", "faceless"].includes(t.kind);
    const last = String(t.last || "").replace(/\/(private|Users)\/\S+/g, "…").replace(/\.\.\/\S+/g, "").slice(0, 140);
    return `${claude ? "Claude is working on it" : t.kind === "setup" ? "Installing" : "Working"}… ${last}`;
  }
  if (t.status === "failed") return "It didn't finish. Open Details to see why.";
  if (t.status === "stopped") return "Stopped.";
  if (t.status === "needs_review") return t.kind === "edit" ? "Finished, but something needs a look. See the notes on the video's card." : "Finished. Have a look before you use it.";
  return DONE_TEXT[t.kind] ?? "Done.";
}

function renderTasks() {
  $("#tally").classList.toggle("live", state.tasks.some((t) => t.status === "running"));
  const open = new Set($$("#tasks details[open]").map((d) => d.dataset.id));
  const list = state.tasks.filter((t) => t.status === "running" || (Date.now() - Date.parse(t.endedAt || t.startedAt)) < 10 * 60 * 1000);
  $("#queue").hidden = !list.length;
  if (!changed("tasks", list)) return;
  $("#tasks").innerHTML = list.map((t) => `
    <li class="task">
      <div class="task-head"><span class="pill ${t.status}">${STATUS_TEXT[t.status] ?? t.status}</span><b>${esc(t.title)}</b>
        ${t.status === "running" && !["copy", "fix", "script", "faceless"].includes(t.kind) ? `<button class="btn small" data-stop="${t.id}">Stop</button>` : ""}</div>
      ${strip(t)}
      <div class="last">${esc(taskLine(t))}</div>
      <details data-id="${t.id}" ${open.has(t.id) ? "open" : ""}><summary class="hint">Details</summary><pre>${esc(t.log.join("\n"))}</pre></details>
    </li>`).join("");
  $$("[data-stop]").forEach((b) => b.addEventListener("click", () => api("/api/stop", { id: b.dataset.stop }).then(refresh)));
}

function jobCard(j) {
  const kind = j.type === "long" ? "Long video" : "Short";
  const flags = j.status === "NEEDS_REVIEW" ? j.flags.filter((f) => f.status === "fail") : [];
  return `<article class="job">
    ${j.video ? `<video controls preload="metadata" src="${media(j.video)}#t=0.5"></video>` : ""}
    <div class="body">
      <div class="title"><span class="id">${j.id}</span><span class="pill ${j.status}">${STATUS_TEXT[j.status] ?? j.status}</span></div>
      <div class="src">${kind}${j.style ? ` · ${esc(j.style)} style` : ""} · from ${esc(j.source)}</div>
      ${flags.length ? `<ul class="flags">${flags.map((f) => `<li>${esc(plainFlag(f))}</li>`).join("")}</ul>` : ""}
      ${j.thumbnail ? `<img class="thumb" alt="Thumbnail for ${j.id}" src="${media(j.thumbnail)}&v=${encodeURIComponent(j.updated ?? "")}">` : ""}
      <div class="btns">
        ${j.video ? `<button class="btn small" data-reveal="${esc(j.video)}">Show in Finder</button>` : ""}
        ${j.captions ? `<button class="btn small" data-reveal="${esc(j.captions)}">Captions file</button>` : ""}
        ${j.type === "long" ? `<button class="btn small" data-thumb="${j.id}">${j.thumbnail ? "New thumbnail" : "Make thumbnail"}</button>` : ""}
        ${j.publishPack ? `<a class="btn small" target="_blank" href="${media(j.publishPack)}">Post copy</a>` : `<button class="btn small" data-copy="${j.id}">Write post copy</button>`}
        <button class="btn small" data-fix="${j.id}">Ask for a change</button>
      </div>
    </div>
  </article>`;
}

function renderJobs() {
  $("#jobs-empty").hidden = state.jobs.length > 0;
  if (!changed("jobs", state.jobs)) return;
  $("#jobs").innerHTML = state.jobs.map(jobCard).join("");
  bindJobButtons($("#jobs"));
}

function bindJobButtons(root) {
  $$("[data-reveal]", root).forEach((b) => b.addEventListener("click", () => api("/api/reveal", { path: b.dataset.reveal }).catch((e) => toast(e.message))));
  $$("[data-thumb]", root).forEach((b) => b.addEventListener("click", async () => {
    const text = await ask({ title: "Thumbnail text", text: "2–4 words that say what the video is about at a glance.", label: "Words on the thumbnail", placeholder: "STOP CHASING CLIENTS", ok: "Make thumbnail" });
    if (!text) return;
    if (text.split(/\s+/).length > 4) return toast("Keep it to 4 words or fewer so it reads in one second.");
    api("/api/thumbnail", { id: b.dataset.thumb, text }).then(() => { toast("Making the thumbnail…"); refresh(); }).catch((e) => toast(e.message));
  }));
  $$("[data-copy]", root).forEach((b) => b.addEventListener("click", () => {
    if (!state.claude) return toast("Claude Code isn't installed on this Mac. See SOP 00.");
    api("/api/copy", { id: b.dataset.copy }).then(() => { toast("Claude is writing your titles, description and captions…"); refresh(); }).catch((e) => toast(e.message));
  }));
  $$("[data-fix]", root).forEach((b) => b.addEventListener("click", async () => {
    if (!state.claude) return toast("Claude Code isn't installed on this Mac. See SOP 00.");
    const request = await ask({ title: `Change ${b.dataset.fix}`, text: "Say what to change, with the time if you can.", label: "What should change?", placeholder: "Keep the bit at 2:03, it was cut by mistake", ok: "Make the change" });
    if (request) api("/api/fix", { id: b.dataset.fix, request }).then(() => { toast("Working on your change…"); refresh(); }).catch((e) => toast(e.message));
  }));
}

function renderFaceless() {
  $("#faceless-empty").hidden = state.faceless.some((f) => f.video);
  const facelessChanged = changed("faceless", state.faceless);
  if (facelessChanged) $("#faceless-list").innerHTML = state.faceless.filter((f) => f.video).map((f) => `<article class="job">
      <video controls preload="none" src="${media(f.video)}"></video>
      <div class="body"><div class="title"><span class="id">${esc(f.slug)}</span></div>
      <div class="src">${esc(f.script.slice(0, 140))}…</div>
      <div class="btns"><button class="btn small" data-reveal="${esc(f.video)}">Show in Finder</button></div></div></article>`).join("");
  if (facelessChanged) bindJobButtons($("#faceless-list"));
  if (pendingScript) {
    const t = state.tasks.find((x) => x.id === pendingScript);
    if (t && t.status !== "running") {
      pendingScript = null;
      $("#write-script").disabled = false;
      $("#write-script").textContent = "Write the script";
      const f = t.result?.slug && state.faceless.find((x) => x.slug === t.result.slug);
      if (t.status === "done" && f) {
        const form = $("#script-form");
        form.hidden = false;
        form.dataset.slug = f.slug;
        form.script.value = f.script.trim();
        form.script.focus();
      } else toast("Claude couldn't write the script. Open Details in the task to see why.");
    }
  }
}

function renderStyles() {
  $("#styles-empty").hidden = state.styles.length > 0;
  if (!changed("styles", state.styles)) return;
  $("#styles").innerHTML = state.styles.map((s) => `<article class="style">
    <p class="eyebrow">${esc(s.format)} · learned ${esc((s.analysedAt || "").slice(0, 10))}</p>
    <h2>${esc(s.name)}</h2>
    <p class="hint">From “${esc(s.title)}”${s.channel ? ` by ${esc(s.channel)}` : ""}</p>
    <ul class="facts">${s.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
    ${s.report ? `<p><a class="btn small" target="_blank" href="${s.report}">Open the shot-by-shot breakdown</a>${s.reviewed ? "" : ' <span class="hint">(not checked by eye)</span>'}</p>` : ""}
    <details><summary class="hint">Full style brief</summary><pre>${esc(s.brief)}</pre></details>
  </article>`).join("");
  const opts = `<option value="">Kit default</option>${state.styles.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join("")}`;
  for (const sel of [$("#style-select"), ...$$(".style-list")]) { const v = sel.value; sel.innerHTML = opts; sel.value = v; }
}

let profileFilled = false;
function renderProfile() {
  const p = state.profile;
  if (profileFilled) return;
  profileFilled = true;
  const f = $("#profile-form");
  for (const k of ["name", "channel", "audience", "offer", "cta", "tone", "never", "proof", "terms", "platforms", "currency", "font"]) if (f[k] && p[k]) f[k].value = p[k];
  if (p.accent) f.accent.value = p.accent;
}

function renderSetup() {
  const s = state.setup;
  const installing = state.tasks.some((t) => t.kind === "setup" && t.status === "running");
  $("#setup").hidden = s.ready && !installing;
  if (s.checking) {
    $("#setup-title").textContent = "Checking this Mac…";
    $("#setup-lede").textContent = "Making sure the video tools are installed. This takes a few seconds.";
    $("#setup-missing").innerHTML = "";
    $("#setup-run").hidden = true; $("#setup-recheck").hidden = true; $("#setup-hint").innerHTML = "";
    return;
  }
  const appCan = s.missing.filter((m) => !m.you), you = s.missing.filter((m) => m.you);
  $("#setup-title").textContent = appCan.length ? "Let's set up this Mac" : "One thing to sort out first";
  $("#setup-lede").textContent = appCan.length ? "The kit needs a few free tools. This happens once and takes about 15 minutes." : "The kit can't fix this one for you:";
  $("#setup-missing").innerHTML = s.missing.map((m) => `<li>${esc(m.text)}${m.you ? " <b>(you)</b>" : ""}</li>`).join("");
  $("#setup-run").hidden = !appCan.length;
  $("#setup-recheck").hidden = false;
  $("#setup-run").disabled = installing;
  $("#setup-run").textContent = installing ? "Installing…" : "Install what's missing";
  const hints = [];
  if (you.some((m) => /Homebrew/.test(m.text))) hints.push("Homebrew asks for your Mac password, so it can't be installed from here. Open <b>Terminal</b>, paste the command from SOP 00, then click <b>Check again</b>.");
  if (you.some((m) => /free/.test(m.text))) hints.push("Free up space: empty the Bin, delete old exports, or move footage to an external drive. Then click <b>Check again</b>.");
  if (you.some((m) => /Chrome|Claude Code/.test(m.text))) hints.push("Install it using the link above, then click <b>Check again</b>.");
  $("#setup-hint").innerHTML = hints.join("<br>");
}

function renderMeta() {
  const g = state.freeGb;
  $("#meta").innerHTML = `${state.profile.name ? `<span>${esc(state.profile.name.split("(")[0].trim())}</span>` : ""}<span class="${g !== null && g < 10 ? "warn" : ""}">${g ?? "?"} GB free</span>${state.claude ? "" : '<span class="warn">Claude Code not found</span>'}`;
}

function announce() {
  for (const t of state.tasks) {
    if (t.status === "running" || seenDone.has(t.id)) continue;
    seenDone.add(t.id);
    if (!refresh.first && Date.now() - Date.parse(t.endedAt) < 15000) toast(`${t.title}: ${STATUS_TEXT[t.status] ?? t.status}`);
  }
}

async function refresh(recheck = false) {
  try {
    const r = await fetch(`/api/state${recheck === true ? "?recheck=1" : ""}`);
    state = await r.json();
  } catch { $("#meta").innerHTML = '<span class="warn">The kit has stopped. Double-click Video Kit to start it again.</span>'; return; }
  renderSetup(); renderMeta(); renderTasks(); renderJobs(); renderFaceless(); renderStyles(); renderProfile(); announce();
  if (refresh.first) {
    refresh.first = false;
    wasOnboarded = state.profile.onboarded;
    if (!state.profile.onboarded) { $("#profile-title").textContent = "First, tell the kit about you"; showTab("profile"); }
  }
}
refresh.first = true;

async function loop() {
  await refresh();
  const busy = state?.tasks?.some((t) => t.status === "running") || state?.setup?.checking;
  setTimeout(loop, busy ? 1500 : 5000);
}
loop();
