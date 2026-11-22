/**
 * engine/llm/claude.js — the one way the kit asks Claude a question from code.
 *
 * It calls the member's own `claude` CLI (the Claude Code they already use), so there is no API key
 * to set up: the CLI's existing login is used. One attempt, a timeout, no tools, no MCP, a short
 * purpose-built system prompt. Callers cache answers and always have a non-LLM fallback.
 */
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

// An alias, not a pinned id, so an older installed CLI still resolves it. KIT_MODEL overrides.
export const MODEL = process.env.KIT_MODEL || "sonnet";

export function findClaude() {
  const fromPath = (() => { try { return execFileSync("/bin/sh", ["-c", "command -v claude"], { encoding: "utf8" }).trim(); } catch { return ""; } })();
  return [process.env.CLAUDE_BIN, fromPath, path.join(homedir(), ".local/bin/claude"), path.join(homedir(), ".claude/local/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]
    .filter(Boolean).find((p) => existsSync(p)) || "";
}

/** Read `claude auth status` output: true / false, or null when it can't be told (older CLI). */
export function parseAuthStatus(stdout) {
  try {
    const j = JSON.parse(String(stdout || "").trim());
    return typeof j.loggedIn === "boolean" ? j.loggedIn : null;
  } catch { return null; }
}

/** Run one tool-less prompt. Returns { text, costUsd }. Throws with a readable reason. */
export function runClaude({ system, prompt, timeoutMs = 120000, model = MODEL }) {
  const bin = findClaude();
  if (!bin) throw new Error("the `claude` command was not found — paste the Video Kit install line again to add Claude Code");
  // An empty scratch cwd so the call never picks up this repo's CLAUDE.md or skills.
  const cwd = mkdtempSync(path.join(tmpdir(), "kit-llm-"));
  try {
    const r = spawnSync(bin, ["-p", prompt, "--model", model, "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--system-prompt", system, "--output-format", "json"],
      { env: process.env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, cwd });
    if (r.error) throw new Error(r.error.code === "ETIMEDOUT" ? `claude timed out after ${timeoutMs / 1000}s` : r.error.message);
    let env = null;
    try { env = JSON.parse(r.stdout); } catch { /* not a JSON envelope */ }
    if (r.status !== 0 || env?.is_error || !env) {
      throw new Error(`claude exit ${r.status}: ${String(env?.result ?? r.stderr ?? r.stdout).trim().slice(0, 240)}`);
    }
    return { text: env.result, costUsd: env.total_cost_usd ?? null };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** Pull the first complete JSON object or array out of model output. */
export function parseJson(text) {
  const s = String(text || "");
  const start = s.search(/[[{]/);
  if (start < 0) throw new Error("model returned no JSON");
  const open = s[start], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(s.slice(start, i + 1));
  }
  throw new Error("model JSON was truncated");
}
