/**
 * Shared box fixtures for the test suite, in place of the four compiled-in
 * boxes this tool used to hardcode: two boxes with a folder behind them and
 * one catch-all with `path: null`.
 */
import type { BoxDef } from "../../src/model.ts";

export const ALPHA: BoxDef = { id: "alpha", label: "alpha", color: "#7FFFD4", path: "/repo/alpha" };
export const BRAVO: BoxDef = { id: "bravo", label: "bravo", color: "#87CEFA", path: "/repo/bravo" };
export const GENERAL: BoxDef = { id: "general", label: "general", color: "#C9A227", path: null };

export const BOXES: readonly BoxDef[] = [ALPHA, BRAVO, GENERAL];
export const BOX_IDS: readonly string[] = BOXES.map((b) => b.id);
