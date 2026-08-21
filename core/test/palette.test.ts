import { test } from "node:test";
import assert from "node:assert/strict";
import { PALETTE, PALETTE_COLS, PALETTE_ROWS, firstUnusedColor, hueDegrees } from "../src/palette.ts";
import type { BoxDef } from "../src/model.ts";

test("PALETTE: fills the declared grid exactly, with unique hexes and names", () => {
  assert.equal(PALETTE.length, PALETTE_COLS * PALETTE_ROWS);
  assert.equal(new Set(PALETTE.map((c) => c.hex)).size, PALETTE.length, "hexes are unique");
  assert.equal(new Set(PALETTE.map((c) => c.name)).size, PALETTE.length, "names are unique");
  for (const c of PALETTE) assert.match(c.hex, /^#[0-9A-Fa-f]{6}$/, c.name);
});

test("PALETTE: no reserved hues - the awaiting/permission status colours must stay unambiguous", () => {
  // STATUS_STYLES (model.ts) puts `awaiting` in magenta and `permission` in
  // red. A box border sharing either hue would hide the thing the status
  // mark exists to draw the eye to.
  for (const c of PALETTE) {
    const h = hueDegrees(c.hex);
    const nearRed = h < 20 || h > 340;
    const nearMagenta = h > 290 && h < 340;
    assert.ok(!nearRed, `${c.name} (${c.hex}, hue ${h.toFixed(1)}) is too close to red`);
    assert.ok(!nearMagenta, `${c.name} (${c.hex}, hue ${h.toFixed(1)}) is too close to magenta`);
  }
});

test("hueDegrees: primaries land where HSL says they should", () => {
  assert.equal(hueDegrees("#FF0000"), 0);
  assert.equal(hueDegrees("#00FF00"), 120);
  assert.equal(hueDegrees("#0000FF"), 240);
  assert.equal(hueDegrees("#808080"), 0, "a grey has no hue - the function must not throw or NaN");
});

test("firstUnusedColor: picks the first palette entry no box has claimed", () => {
  const used: BoxDef[] = [{ id: "a", label: "a", color: PALETTE[0].hex, path: null }];
  assert.equal(firstUnusedColor(used), PALETTE[1].hex);
  assert.equal(firstUnusedColor([]), PALETTE[0].hex);
});

test("firstUnusedColor: falls back to the first colour once every entry is taken", () => {
  const all: BoxDef[] = PALETTE.map((c, i) => ({ id: `b${i}`, label: `b${i}`, color: c.hex, path: null }));
  assert.equal(firstUnusedColor(all), PALETTE[0].hex);
});
