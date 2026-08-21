/**
 * Named colours a box can take.
 *
 * A 6-column x 8-row grid (48 colours), hue-ordered so the setup panel's
 * arrow-key picker moves through a sensible rainbow rather than a random
 * jumble. Deliberately excludes the red and magenta families: those are
 * STATUS_STYLES' `permission` and `awaiting` colours (model.ts), and a box
 * border sharing a status colour would hide the thing a status mark exists to
 * draw the eye to.
 */
import type { BoxDef } from "./model.ts";

export interface PaletteColor {
  name: string;
  hex: string;
}

export const PALETTE_COLS = 6;
export const PALETTE_ROWS = 8;

export const PALETTE: readonly PaletteColor[] = [
  // amber / orange
  { name: "amber", hex: "#C9A227" },
  { name: "gold", hex: "#D4AF37" },
  { name: "tangerine", hex: "#E8871E" },
  { name: "peach", hex: "#F4A460" },
  { name: "apricot", hex: "#E8B084" },
  { name: "honey", hex: "#E4B343" },
  // yellow
  { name: "lemon", hex: "#D9CA3A" },
  { name: "mustard", hex: "#C4A518" },
  { name: "wheat", hex: "#D8C08A" },
  { name: "sand", hex: "#CBB273" },
  { name: "straw", hex: "#C7BA57" },
  { name: "banana", hex: "#E0D06E" },
  // green
  { name: "lime", hex: "#8FBF3F" },
  { name: "mint", hex: "#4ADE80" },
  { name: "jade", hex: "#2ECC71" },
  { name: "moss", hex: "#6B8E4E" },
  { name: "sage", hex: "#8FA97C" },
  { name: "emerald", hex: "#159E77" },
  // teal / aqua
  { name: "aqua", hex: "#7FFFD4" },
  { name: "teal", hex: "#3FBFBF" },
  { name: "seafoam", hex: "#7FD9AE" },
  { name: "turquoise", hex: "#3BC5C0" },
  { name: "cyan", hex: "#5FCFE0" },
  { name: "spruce", hex: "#4F9A94" },
  // blue
  { name: "skyblue", hex: "#87CEFA" },
  { name: "azure", hex: "#4A90D9" },
  { name: "cornflower", hex: "#6495ED" },
  { name: "cobalt", hex: "#3B6FC9" },
  { name: "steel", hex: "#6C8EBF" },
  { name: "denim", hex: "#4E7AB5" },
  // indigo / periwinkle
  { name: "periwinkle", hex: "#8A9EE8" },
  { name: "indigo", hex: "#6C6CE5" },
  { name: "iris", hex: "#8F87E0" },
  { name: "slate", hex: "#7B87A8" },
  { name: "twilight", hex: "#6E71A8" },
  { name: "bluebell", hex: "#8CA0D7" },
  // violet (stopping short of the magenta/fuchsia band)
  { name: "lavender", hex: "#B0A4E3" },
  { name: "lilac", hex: "#C1A2CD" },
  { name: "wisteria", hex: "#9B85C4" },
  { name: "amethyst", hex: "#A374D5" },
  { name: "grape", hex: "#8F6BB5" },
  { name: "plum", hex: "#8073A5" },
  // neutral / brown (rounding out the grid without touching red or magenta)
  { name: "clay", hex: "#B5876B" },
  { name: "terracotta", hex: "#BC8264" },
  { name: "sienna", hex: "#9C7048" },
  { name: "umber", hex: "#8A6642" },
  { name: "taupe", hex: "#A89684" },
  { name: "stone", hex: "#9C9483" },
] as const;

/**
 * Standard HSL hue in degrees, [0, 360). Exported so palette.test.ts can
 * assert every entry sits outside the reserved bands rather than trusting the
 * grouping comments above to stay accurate as entries are edited.
 */
export function hueDegrees(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/** The first palette colour no box in `boxes` already uses — the setup
 *  panel's default cursor position when adding a new box. Falls back to the
 *  first colour outright once every entry is taken (a 13th box is refused by
 *  config.ts's MAX_BOXES long before that could happen with this palette). */
export function firstUnusedColor(boxes: readonly BoxDef[]): string {
  const used = new Set(boxes.map((b) => b.color));
  return PALETTE.find((c) => !used.has(c.hex))?.hex ?? PALETTE[0].hex;
}
