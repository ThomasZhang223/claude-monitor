/**
 * The stylesheets, checked for the mistakes CSS makes silently.
 *
 * CSS has no compiler and fails without complaint: `color: var(--gone)` is not
 * an error, it simply does nothing, and the element renders in whatever it
 * inherited. That is exactly how "open" PRs stopped being green — a variable
 * was deleted during a recolour and one stylesheet still referenced it. No
 * test, no typecheck and no console message said a word.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const WEB = path.resolve(fileURLToPath(import.meta.url), "../../web");
const sheets = fs.readdirSync(WEB).filter((f) => f.endsWith(".css"));
const css = sheets.map((f) => fs.readFileSync(path.join(WEB, f), "utf8")).join("\n");

/** `--name:` on the left of a colon defines it. */
function defined(text: string): Set<string> {
  return new Set([...text.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
}

/** `var(--name)` uses it. */
function used(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/var\((--[a-z0-9-]+)\s*(?:,[^)]*)?\)/gi)) out.set(m[1], m[0]);
  return out;
}

test("css: every variable used is defined somewhere", () => {
  const have = defined(css);
  const missing = [...used(css).keys()].filter((v) => !have.has(v));
  assert.deepEqual(missing, [], `undefined CSS variables: ${missing.join(", ")}`);
});

test("css: every PR phase has a colour, in one place", () => {
  // The phases the UI can render, from prs.ts's PrPhase. A phase with no rule
  // renders in the inherited colour and looks deliberate.
  const have = defined(css);
  for (const phase of ["open", "draft", "queued", "merged", "closed"]) {
    assert.ok(have.has(`--pr-${phase}`), `--pr-${phase} is not defined`);
    assert.match(css, new RegExp(`\\.ph-${phase}\\b`), `.ph-${phase} has no rule`);
  }
  assert.match(css, /\.ph-unknown\b/, "and an un-looked-up PR is styled too");
});

/**
 * Resolve a token to a colour, following `var()` aliases.
 *
 * The palette is two layers now: a Calder scale of real values, and the names
 * the dashboard uses aliased onto it (`--pr-open-text: var(--success-active)`).
 * Reading only the first layer would have made these checks pass on any alias
 * at all, which is worse than not having them.
 */
function colour(name: string, depth = 0): [number, number, number] {
  const m = css.match(new RegExp(`${name}:\\s*([^;]+);`, "i"));
  assert.ok(m, `${name} is defined`);
  const value = m![1].trim();
  const alias = /^var\((--[a-z0-9-]+)\)$/i.exec(value);
  if (alias) {
    assert.ok(depth < 5, `${name} aliases in a circle`);
    return colour(alias[1], depth + 1);
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) as [number, number, number];
  // The neutral scale is one ink at several alphas — rgba(22,39,58,α) — so a
  // resolver that only understood hex would fail on every grey in the palette.
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(value);
  assert.ok(rgba, `${name} resolves to a colour, got ${value}`);
  return [Number(rgba![1]), Number(rgba![2]), Number(rgba![3])];
}

test("css: open is green, since that is what open means", () => {
  const [r, g, b] = colour("--pr-open-text");
  assert.ok(g > r && g > b, `open resolves to rgb(${r},${g},${b}), which is not green`);
});

test("css: merged is the accent, and closed does not read as open", () => {
  // Merged was purple on the dark palette. The Calder scale has one blue, and
  // the design maps merged onto it; what matters is that the three stay
  // distinguishable from each other and that closed never reads as open.
  assert.deepEqual(colour("--pr-merged-text"), colour("--accent"), "merged is the accent");
  const [cr, cg, cb] = colour("--pr-closed-text");
  assert.ok(!(cg > cr && cg > cb), "closed must not read as open");
  assert.notDeepEqual(colour("--pr-merged-text"), colour("--pr-open-text"));
  assert.notDeepEqual(colour("--pr-closed-text"), colour("--pr-open-text"));
});

test("css: an alias chain still lands on a real colour", () => {
  // Every semantic name the dashboard uses must resolve, or a card renders
  // with no colour at all and nothing says why.
  for (const name of ["--needs-you", "--working", "--panel", "--ask-badge"]) {
    assert.equal(colour(name).length, 3, name);
  }
});

test("css: no stylesheet defines its own PR phase colours", () => {
  // The strip used to key off `state` while the cards keyed off `phase`, which
  // is how one of them ended up with no colour at all.
  assert.ok(!/\.st\.(OPEN|MERGED|CLOSED|DRAFT)/.test(css), "a second, state-keyed scheme is back");
});

test("css: the picker reuses the board's error colour, not a second red", () => {
  // The palette means something: the error family is "it needs YOU". A picker
  // with its own near-red would put two reds on one card meaning slightly
  // different things, which is how a semantic scheme stops being one.
  const rules = (css.match(/\.ask\w*[^{]*\{[^}]*\}/g) ?? []).join("");
  assert.match(rules, /background:\s*var\(--error-bg\)/, "the panel is the error tint");
  assert.match(rules, /border:\s*1px solid var\(--error-border\)/);
  const literals = rules.match(/#[0-9a-fA-F]{3,8}/g) ?? [];
  assert.deepEqual(literals, [], `picker rules should use tokens, found ${literals.join(", ")}`);
});

test("css: the PR strip has no renderer or scheme of its own", () => {
  // The strip and the dashboard card share `prBlock` and the `.prs` / `.pr` /
  // `.ph-*` classes. A private strip style is the first sign a second renderer
  // has grown back — which is how it ended up printing CI summaries as
  // full-width bars while the card showed pills.
  assert.ok(!/\.prtitle/.test(css), "no strip-only title style");
  assert.ok(!/\.prstrip\s+\.(ck|st)\b/.test(css), "no strip-only check/state style");
  assert.ok(/\.prstrip\s*\{/.test(css), "the strip still exists as a container");
});
