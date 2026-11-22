/**
 * engine/planner/heuristic.js — deterministic editorial selection. Pure.
 *
 * Produces a SELECTION (which candidates get a punch-in, a graphic, emphasis) — never times or
 * pixels; plan.js turns a selection into an executable plan under the profile's rules. The LLM
 * planner returns the same selection shape, so the two are interchangeable and the heuristic is
 * always available as the fallback.
 *
 * CC style: the hook may be strong (push-in + bold text when the hook has a short punchy clause);
 * after it, emphasis only where the content earns it — numbers, list steps, the payoff line.
 */

const STRENGTH_ORDER = { number: 0, list: 1, payoff: 2, contrast: 3 };

export function selectHeuristic({ candidates, profile }) {
  const sel = { planner: "heuristic", hook: null, punch_ins: [], graphics: [], emphasis: [], notes: [] };
  const hook = candidates.find((c) => c.type === "hook");
  if (hook) {
    const keyOk = hook.key && hook.key.words >= 2 && hook.key.words <= 5;
    sel.hook = {
      candidate: hook.id,
      punch: { preset: profile.punchIns.hookPreset, reason: "hook push-in on the opening line" },
      graphic: keyOk && profile.graphics.allowed.includes("BigStatement")
        ? { component: "BigStatement", props: { text: hook.key.text }, reason: `hook key phrase "${hook.key.text}"` } : null,
    };
  }
  const hookEnd = hook ? hook.out_end : 0;
  const body = candidates
    .filter((c) => c.type !== "hook" && c.out_start >= hookEnd - 1e-6)
    .sort((a, b) => (STRENGTH_ORDER[a.type] - STRENGTH_ORDER[b.type]) || (a.out_start - b.out_start));

  for (const c of body) {
    const preset = c.type === "payoff" ? (profile.punchIns.presets.PUNCH_EASE_108 ? "PUNCH_EASE_108" : profile.punchIns.bodyPreset) : profile.punchIns.bodyPreset;
    sel.punch_ins.push({ candidate: c.id, preset, reason: `${c.type}: "${c.text.slice(0, 60)}"` });
    if (c.suggestion && profile.graphics.allowed.includes(c.suggestion.component)) {
      sel.graphics.push({ candidate: c.id, component: c.suggestion.component, props: c.suggestion.props, reason: `${c.type} callout for "${c.text.slice(0, 40)}"` });
    }
    if (Number.isInteger(c.keyword)) sel.emphasis.push({ candidate: c.id, word: c.keyword });
  }
  return sel;
}
