/**
 * engine/graphics/registry.js — the approved graphic components. Pure.
 *
 * The planner may only place components listed here as `implemented`, with props that pass the
 * component's own check. Design lives in the component HTML (graphics/components/*.html), never in
 * the plan: a plan says "NumberCallout, value $10K/MO, label A MONTH", not colours or fonts. That is
 * what keeps every reel on-brand without the model inventing a look per video.
 *
 * `template` lists the only words a component may add that were not spoken (e.g. Label's "STEP").
 * Everything else in a callout must be derived from the transcript — validate.js enforces it.
 */

const words = (s) => String(s ?? "").trim().split(/\s+/).filter(Boolean);

export const COMPONENTS = {
  BigStatement: {
    status: "implemented",
    purpose: "A short bold claim — mostly the hook (\"START STACKING SKILLS\").",
    minHeight: 110, maxHeight: 260,
    template: [],
    check: (p) => {
      const n = words(p.text).length;
      return n >= 1 && n <= 5 ? null : `text must be 1–5 words (got ${n})`;
    },
    textOf: (p) => [p.text],
  },
  NumberCallout: {
    status: "implemented",
    purpose: "A number that matters (\"$10K/MO\", \"3 SKILLS\"); counts up when numeric. Value and label sit on one line below 170px, stacked above.",
    minHeight: 110, maxHeight: 300,
    template: [],
    check: (p) => {
      if (!/\d/.test(String(p.value ?? ""))) return "value must contain a number";
      if (String(p.value).length > 10) return "value too long (max 10 chars)";
      const n = words(p.label).length;
      return n <= 3 ? null : `label must be 0–3 words (got ${n})`;
    },
    textOf: (p) => [p.value, p.label ?? ""],
  },
  Label: {
    status: "implemented",
    purpose: "A small structural tag (\"STEP 1\", \"THE REAL PROBLEM\").",
    minHeight: 90, maxHeight: 160,
    template: ["step", "#", "no"],
    check: (p) => {
      const n = words(p.text).length;
      return n >= 1 && n <= 4 ? null : `text must be 1–4 words (got ${n})`;
    },
    textOf: (p) => [p.text],
  },
  // Registered so the plan schema and docs know them; the planner refuses them until built.
  BeforeAfter: { status: "planned", purpose: "Before → after contrast." },
  Comparison: { status: "planned", purpose: "Two options side by side." },
  Checklist: { status: "planned", purpose: "Up to 4 ticked items, revealed in time with speech." },
  Quote: { status: "planned", purpose: "A pulled quote with attribution." },
  SimpleChart: { status: "planned", purpose: "One bar/line chart of a spoken figure." },
  NotificationCard: { status: "planned", purpose: "Phone-style notification (e.g. a sale)." },
  ArrowHighlight: { status: "planned", purpose: "Arrow/box pointing at something on screen." },
  CTA: { status: "planned", purpose: "Call-to-action end card (text from member/voice-and-offer.md)." },
};

export const implementedComponents = () => Object.keys(COMPONENTS).filter((k) => COMPONENTS[k].status === "implemented");
