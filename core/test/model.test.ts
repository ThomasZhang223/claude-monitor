import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODES,
  MODE_ORDER,
  STATUS_STYLES,
  NEEDS_USER,
  formatSessionName,
  parseSessionName,
  isMode,
  needsUser,
  type Status,
} from "../src/model.ts";
import { ALPHA, BOX_IDS } from "./fixtures/boxes.ts";

test("session name: round-trips, for every class old and new", () => {
  for (const box of BOX_IDS) {
    for (const mode of MODE_ORDER) {
      const original = { box, mode, slug: "plt1836" };
      const parsed = parseSessionName(formatSessionName(original));
      assert.deepEqual(parsed, original, `${box}/${mode}`);
    }
  }
});

test("isMode: accepts every class in MODE_ORDER and nothing else", () => {
  for (const mode of MODE_ORDER) assert.ok(isMode(mode), mode);
  assert.equal(isMode("question"), false, "the token is q, not the spelled-out role");
  assert.equal(isMode(""), false);
});

test("MODES: every entry's own id matches its key, and MODE_ORDER lists exactly the MODES keys", () => {
  for (const mode of MODE_ORDER) assert.equal(MODES[mode].id, mode);
  assert.deepEqual(new Set(MODE_ORDER), new Set(Object.keys(MODES)));
});

test("session name: a slug may contain hyphens", () => {
  // Splitting on the FIRST three delimiters only is what allows this — the
  // free-form label "ec2 always-on spike" sanitises to a hyphenated slug.
  const name = formatSessionName({ box: ALPHA.id, mode: "work", slug: "ec2-always-on-spike" });
  assert.equal(name, "cc-alpha-work-ec2-always-on-spike");
  assert.deepEqual(parseSessionName(name), {
    box: ALPHA.id,
    mode: "work",
    slug: "ec2-always-on-spike",
  });
});

test("session name: rejects anything that is not ours", () => {
  const rejected = [
    "devbox_localstack",              // an unrelated local session
    "monitor-sample-alpha",           // some other tool's own sessions
    "cc-alpha-work",                  // no slug
    "cc-Alpha-work-thing",            // box token is not lowercase alnum
    "cc-alpha-badmode-thing",         // unknown mode
    "xx-alpha-work-thing",            // wrong prefix
    "",
  ];
  for (const name of rejected) {
    assert.equal(parseSessionName(name), null, `rejects ${JSON.stringify(name)}`);
  }
});

test("parseSessionName: validates box SHAPE only - membership in the configured set is tmux.ts's job", () => {
  // Any [a-z0-9]+ token parses, whether or not it names a box that currently
  // exists in config.json - see tmux.ts's parseSessionsOutput, "the only
  // place that filtering happens".
  assert.deepEqual(parseSessionName("cc-nosuchbox-work-thing"), {
    box: "nosuchbox",
    mode: "work",
    slug: "thing",
  });
});

test("STATUS_STYLES: covers every status with a glyph and a label", () => {
  const all: Status[] = ["working", "awaiting", "permission", "idle", "error", "dead"];
  for (const s of all) {
    const style = STATUS_STYLES[s];
    assert.ok(style, `style for ${s}`);
    assert.ok(style.glyph.length > 0, `glyph for ${s}`);
    assert.ok(style.label.length > 0, `label for ${s}`);
  }
});

test("STATUS_STYLES: only `working` inherits its box colour", () => {
  assert.equal(STATUS_STYLES.working.color, null);
  for (const s of ["awaiting", "permission", "idle", "error", "dead"] as Status[]) {
    assert.notEqual(STATUS_STYLES[s].color, null, `${s} has an explicit colour`);
  }
});

test("only user-blocking statuses blink", () => {
  for (const [status, style] of Object.entries(STATUS_STYLES)) {
    if (style.blink) {
      assert.ok(needsUser(status as Status), `${status} blinks only if it needs the user`);
    }
  }
});

test("needsUser: matches NEEDS_USER and excludes the quiet states", () => {
  for (const s of NEEDS_USER) assert.ok(needsUser(s));
  assert.equal(needsUser("working"), false);
  assert.equal(needsUser("idle"), false);
  assert.equal(needsUser("dead"), false);
});
