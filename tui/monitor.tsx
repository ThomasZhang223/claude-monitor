/**
 * The session dashboard.
 *
 * Reads state, renders boxes, and owns nothing else: every fact on screen comes
 * from core/, which is where the logic and the tests live. This file is layout,
 * animation and keys.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdin } from "ink";

import {
  BLINK_OFF_MS,
  BLINK_ON_MS,
  FLAG_ON,
  GIT_MS,
  GLYPH_W,
  MODES,
  MODE_ORDER,
  OPT_FLAG,
  OPT_WRAP,
  POLL_MS,
  PREVIEW_MS,
  PREVIEW_COLOR,
  PROMPT_MAX_CHARS,
  PROMPT_VISIBLE_LINES,
  SEGMENT_SEPARATOR,
  SPINNER_FRAMES,
  SPINNER_MS,
  STATUS_STYLES,
  USAGE_MS,
  type BoxDef,
  type BoxId,
  type Mode,
  type SessionRecord,
  type Status,
} from "../core/src/model.ts";
import {
  MAX_BOXES,
  configExists,
  defaultConfig,
  loadConfig,
  saveConfig,
  sanitizeBoxId,
  validateConfig,
  type Config,
} from "../core/src/config.ts";
import { PALETTE, PALETTE_COLS, PALETTE_ROWS, firstUnusedColor } from "../core/src/palette.ts";
import { layoutRow, rowBackground } from "../core/src/row.ts";
import { collectSessions } from "../core/src/collect.ts";
import { arrange, boxHeights, panelSplit, previewRows } from "../core/src/layout.ts";
import {
  boxRows,
  clampFocus,
  focusFor,
  focusedRecord,
  initialFocus,
  moveBox,
  moveRow,
  type Focus,
} from "../core/src/focus.ts";
import { autoRecap, readRecap, type AutoRecap, type Recap } from "../core/src/recap.ts";
import { buildMultiPreview, pickRecap, type PreviewLine, type Tone } from "../core/src/preview.ts";
import { classifyName, sanitizeLabel, suggestLabel, validateLabel } from "../core/src/naming.ts";
import { promptTailLines } from "../core/src/prompt.ts";
import { spawnSession } from "../core/src/spawn.ts";
import { attachSession, killSession } from "../core/src/attach.ts";
import { openInNewTerminal } from "../core/src/terminal.ts";
import {
  WRAP_TIMEOUT_MS,
  decideWrap,
  encodeWrap,
  wrapOrder,
  sendWrap,
  type WrapJob,
} from "../core/src/wrap.ts";
import { setOption, unsetOption } from "../core/src/tmux.ts";
import {
  fireNotification,
  paneLabelFor,
  planNotifications,
  type NotifyStateMap,
} from "../core/src/notify.ts";
import { currentBranch, isGitCapable, isGitRepo, worktreePathFor } from "../core/src/repos.ts";
import { append as appendHistory, recapChanged } from "../core/src/history.ts";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";
import {
  conversational,
  formatTokens,
  isSnapshotStale,
  modelShare,
  readUsageSnapshot,
  renderBar,
  shortModelLabel,
  snapshotAge,
  sumUsageAcrossTranscripts,
  type UsageSnapshot,
  type UsageTotals,
} from "../core/src/usage.ts";

// ---------------------------------------------------------------------------
// Title-in-border. Ink's borderStyle has no inset-title support, so the top
// edge is drawn as plain text and the body Box omits its own top border. The
// two must share an outer width or the corners will not line up.
// ---------------------------------------------------------------------------

function TitleBar({
  width,
  title,
  color,
  selected = false,
}: {
  width: number;
  title: string;
  color?: string;
  selected?: boolean;
}) {
  const inner = ` ${title} `;
  const fill = Math.max(0, width - 2 - 1 - inner.length);
  // The selected box's title is inverted rather than merely brightened. Which
  // box `n` will create in has to be unmistakable from across the screen, and a
  // colour difference alone is not — every box already has a colour.
  return (
    <Box>
      <Text color={color}>{"╭─"}</Text>
      <Text color={color} bold={selected} inverse={selected}>
        {inner}
      </Text>
      <Text color={color}>{`${"─".repeat(fill)}╮`}</Text>
    </Box>
  );
}

function Panel({
  width,
  height,
  title,
  color,
  selected,
  children,
}: {
  width: number;
  height: number;
  title: string;
  color?: string;
  selected?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Box flexDirection="column" width={width}>
      <TitleBar width={width} title={title} color={color} selected={selected} />
      <Box
        borderStyle="round"
        borderTop={false}
        borderColor={color}
        flexDirection="column"
        paddingX={1}
        width={width}
        height={Math.max(1, height - 1)}
        overflow="hidden"
      >
        {children}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Session rows
// ---------------------------------------------------------------------------

/**
 * One glyph slot. `status` is null for a slot with no pane behind it, which a
 * `q` session's second slot always is — it renders as blanks so the columns to
 * its right stay put.
 */
function StatusGlyph({
  status,
  boxColor,
  frame,
  blinkOn,
  backgroundColor,
}: {
  status: Status | null;
  boxColor: string;
  frame: number;
  blinkOn: boolean;
  backgroundColor?: string;
}) {
  if (status === null) {
    return <Text backgroundColor={backgroundColor}>{" ".repeat(GLYPH_W)}</Text>;
  }
  const style = STATUS_STYLES[status];
  // A working spinner takes its own box's colour, which is what ties a busy row
  // to its box at a glance. Every other status carries a semantic colour that
  // deliberately sits outside the box palette.
  const color = style.color ?? boxColor;
  const glyph = style.spin ? SPINNER_FRAMES[frame % SPINNER_FRAMES.length] : style.glyph;

  // Padded on both sides and bold. The status is the one thing on a row you scan
  // for across the whole dashboard, so it gets space of its own rather than
  // sitting flush against the name. Blinking hides the glyph but keeps the
  // padding, so the row never shifts sideways as it flashes.
  if (style.blink && !blinkOn) {
    return <Text backgroundColor={backgroundColor}>{" ".repeat(GLYPH_W)}</Text>;
  }
  return (
    <Text color={color} backgroundColor={backgroundColor} bold>
      {` ${glyph} `}
    </Text>
  );
}

function pad(s: string, n: number): string {
  const t = s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s;
  return t + " ".repeat(Math.max(0, n - t.length));
}

function SessionRow({
  record,
  width,
  boxColor,
  focused,
  frame,
  blinkOn,
}: {
  record: SessionRecord;
  width: number;
  boxColor: string;
  focused: boolean;
  frame: number;
  blinkOn: boolean;
}) {
  // Every width decision, and which pane each segment describes, comes from
  // core/src/row.ts - this component is markup only. The gaps around the pid
  // column live there too, so both sides of the arithmetic stay in one place.
  const { glyphs, segments, nameW, pidW, ctxW } = layoutRow(record, width);

  const ctx = record.contextPct === null ? "" : `${record.contextPct}%`;

  // Claude Code's own process id(s), NOT the tmux pane's - one per pane still
  // resolved, in pane order (plan then implement).
  const pids = record.panes
    .map((p) => p.claude?.pid)
    .filter((p): p is number => typeof p === "number");
  const pid = pids.join("/");

  // Breathing room around the pid column, matching row.ts's arithmetic.
  const NAME_PID_GAP = 3;
  const PID_DETAIL_GAP = 3;

  // The selector used to be just the "▸" glyph, easy to lose against a busy
  // screen. A tint of the box's own colour across the whole row makes "this is
  // the focused one" legible at a glance instead of a careful read of column 1,
  // and a flagged row goes brighter still - see row.ts's rowBackground.
  const bg = rowBackground(boxColor, focused, record.flagged) ?? undefined;

  return (
    <Box>
      <Text backgroundColor={bg}>{focused ? "▸" : " "}</Text>
      {glyphs.map((pane, i) => (
        <StatusGlyph
          key={i}
          status={pane?.status ?? null}
          boxColor={boxColor}
          frame={frame}
          blinkOn={blinkOn}
          backgroundColor={bg}
        />
      ))}
      <Text backgroundColor={bg}> </Text>
      <Text bold={focused} backgroundColor={bg}>{pad(record.label, nameW)}</Text>
      <Text backgroundColor={bg}>{" ".repeat(NAME_PID_GAP)}</Text>
      <Text dimColor backgroundColor={bg}>{pad(pid, pidW)}</Text>
      <Text backgroundColor={bg}>{" ".repeat(PID_DETAIL_GAP)}</Text>
      {segments.map((seg, i) => (
        <React.Fragment key={seg.paneIndex ?? `all-${i}`}>
          {i > 0 ? (
            <Text dimColor backgroundColor={bg}>{SEGMENT_SEPARATOR}</Text>
          ) : null}
          <Text color={boxColor} backgroundColor={bg}>{pad(seg.text, seg.width)}</Text>
        </React.Fragment>
      ))}
      <Text dimColor backgroundColor={bg}>{ctx.padStart(ctxW)}</Text>
    </Box>
  );
}

function SessionBox({
  def,
  width,
  height,
  records,
  focusedName,
  selected,
  frame,
  blinkOn,
}: {
  def: BoxDef;
  width: number;
  height: number;
  records: SessionRecord[];
  focusedName: string | null;
  /** The box the cursor is on: what `n` creates in, whether or not it has rows. */
  selected: boolean;
  frame: number;
  blinkOn: boolean;
}) {
  const inner = width - 4;
  const anySessions = records.length > 0;

  // A heading (and its rows) only renders for a class that actually has
  // sessions here - a box using one or two classes is tighter than one that
  // pays a header's worth of rows for every class it isn't using.
  const group = (mode: Mode) => {
    const rows = records.filter((r) => r.mode === mode);
    if (rows.length === 0) return null;
    return (
      <React.Fragment key={mode}>
        <Box>
          <Text color={def.color}>{MODES[mode].label}</Text>
        </Box>
        {rows.map((r) => (
          <SessionRow
            key={r.tmuxName}
            record={r}
            width={inner}
            boxColor={def.color}
            focused={r.tmuxName === focusedName}
            frame={frame}
            blinkOn={blinkOn}
          />
        ))}
      </React.Fragment>
    );
  };

  return (
    <Panel
      width={width}
      height={height}
      title={def.label}
      color={def.color}
      selected={selected}
    >
      {MODE_ORDER.map((mode) => group(mode))}
      {/* An empty box says so, and that is all. No per-box create hint: the
          footer already names the keys and colours them for the selected box,
          so repeating them inside every box you moved the cursor onto was
          chrome saying something the screen already said. */}
      {!anySessions ? <Text dimColor>{"(no sessions)"}</Text> : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Global usage header
// ---------------------------------------------------------------------------

function GlobalBox({
  width,
  height,
  snapshot,
  totals,
  now,
  sessionCount,
  awaiting,
}: {
  width: number;
  height: number;
  snapshot: UsageSnapshot | null;
  totals: UsageTotals | null;
  now: number;
  sessionCount: number;
  awaiting: number;
}) {
  const age = snapshotAge(snapshot, now);
  const stale = isSnapshotStale(age);
  // Grey the bars when the snapshot is old rather than showing a confident
  // wrong number: these figures are only as fresh as the last live session,
  // because they exist nowhere on disk outside a statusline render.
  const barColor = stale ? "gray" : undefined;

  const barW = Math.max(6, Math.min(12, Math.floor(width / 9)));
  const pct = (v: number | null) => (v === null ? "  ?" : `${String(Math.round(v)).padStart(3)}%`);

  const shares = totals ? modelShare(totals.byModel).slice(0, 3) : [];

  return (
    <Panel width={width} height={height} title="global">
      {/* Each stat is grouped into its own flex child, so space-evenly spreads
          the GAPS between "5h ...", "7d ...", "N sessions" etc. across the
          panel's width, rather than distributing space between every fragment
          that makes up one of them. */}
      <Box justifyContent="space-evenly">
        <Box>
          <Text dimColor>5h </Text>
          <Text color={barColor}>{renderBar((snapshot?.fiveHourPct ?? 0) / 100, barW)}</Text>
          <Text color={barColor}>{pct(snapshot?.fiveHourPct ?? null)}</Text>
        </Box>
        <Box>
          <Text dimColor>7d </Text>
          <Text color={barColor}>{renderBar((snapshot?.sevenDayPct ?? 0) / 100, barW)}</Text>
          <Text color={barColor}>{pct(snapshot?.sevenDayPct ?? null)}</Text>
        </Box>
        <Text dimColor>{sessionCount} sessions</Text>
        {awaiting > 0 ? <Text color="magenta">{`${awaiting} awaiting`}</Text> : null}
      </Box>
      {height > 3 && totals ? (
        <Box justifyContent="space-evenly">
          <Box>
            <Text dimColor>tokens </Text>
            <Text>{`today ${formatTokens(conversational(totals.today))}`}</Text>
          </Box>
          <Text>{`week ${formatTokens(conversational(totals.week))}`}</Text>
          <Text>{`total ${formatTokens(conversational(totals.allTime))}`}</Text>
          {/* Cache reads are ~97% of the raw count and would swamp everything
              above, so they are reported separately rather than folded in. */}
          <Text dimColor>{`+${formatTokens(totals.allTime.cacheRead)} cache reads`}</Text>
        </Box>
      ) : null}
      {height > 4 && shares.length > 0 ? (
        <Box justifyContent="space-evenly">
          {shares.map((s, i) => (
            <Box key={s.model}>
              {i === 0 ? <Text dimColor>models </Text> : null}
              <Text>
                {shortModelLabel(s.model)} {renderBar(s.fraction, 8)}{" "}
                {`${Math.round(s.fraction * 100)}%`.padStart(4)}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Panel>
  );
}

function formatAge(ms: number | null): string {
  if (ms === null) return "?";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** How a preview line is coloured, by where its text came from. A recap is the
 *  session's own voice and reads as normal text; a stand-in is visibly secondary,
 *  so a glance tells you which you are reading. Nothing in here is a colour that
 *  means "attention" — the preview is for reading, and the row above it is where
 *  status is signalled. */
const TONE_PROPS: Record<Tone, { color?: string; dim?: boolean }> = {
  recap: {},
  auto: { dim: true },
  hint: { dim: true },
};

function PreviewBody({ lines, width }: { lines: PreviewLine[]; width: number }) {
  return (
    <>
      {lines.map((line, i) => {
        const props = TONE_PROPS[line.tone];
        return (
          <Text key={i} color={props.color} dimColor={props.dim}>
            {line.text.slice(0, width)}
          </Text>
        );
      })}
    </>
  );
}

function PreviewBox({
  width,
  height,
  record,
  boxColor,
  panePreviews,
  now,
  hidden,
}: {
  width: number;
  height: number;
  record: SessionRecord | null;
  /** The focused session's box colour, resolved by the caller (config lives
   *  in Dashboard's state, not in a static lookup table any more). */
  boxColor: string;
  /** Up to two blocks — one per pane with a resolved Claude process, so a
   *  work session's plan and implement panes both show instead of whichever
   *  one a first-pane lookup happened to land on. `label` is null for a
   *  single-pane session (nothing to disambiguate) or the rare case where no
   *  pane resolved a Claude process at all. */
  panePreviews: Array<{ label: string | null; recap: Recap | null; auto: AutoRecap | null }>;
  now: number;
  hidden: boolean;
}) {
  if (hidden) return null;
  const title = record ? `preview · ${record.box}/${record.label}` : "preview";
  if (!record) {
    return (
      <Panel width={width} height={height} title={title} color={PREVIEW_COLOR}>
        <Text dimColor>
          {"No session in this box. Press n for a work session, N for a question."}
        </Text>
      </Panel>
    );
  }

  const textW = Math.max(8, width - 4);

  // What the session IS, on one line at the top, in its box's own colour — so
  // which box you are looking at is legible from the same glance that reads the
  // model and the context cost. Sourced from the per-session statusline snapshot,
  // so each field is absent until the session has drawn a status line once.
  const CTX_BAR_W = 10;
  // A placeholder the same length as the bar it stands in for, so the
  // fits-in-textW decision below is correct without having to measure JSX.
  const ctxPlaceholder =
    record.contextPct !== null ? `ctx ${"#".repeat(CTX_BAR_W)} ${record.contextPct}%` : null;
  const facts: string[] = [];
  if (record.model) facts.push(record.model);
  if (record.effort) facts.push(`${record.effort} effort`);
  if (ctxPlaceholder) facts.push(ctxPlaceholder);
  if (record.branch) facts.push(record.branch);
  if (record.runtimeMs !== null) facts.push(formatDuration(record.runtimeMs));
  // With two labeled blocks each stating its own age in its own subtitle, a
  // single shared age here would describe only one of them - so this only
  // appears for the single-block case, same as before.
  if (panePreviews.length === 1) {
    const pickedAt = pickRecap(panePreviews[0].recap, panePreviews[0].auto)?.at ?? null;
    if (pickedAt) facts.push(`recap ${formatAge(now - pickedAt)} ago`);
  }
  const factsJoined = facts.join("  ·  ");
  const factsFit = factsJoined.length <= textW;

  // Chrome above the summary: the facts line, the worktree, a blank separator,
  // and (for a single unlabeled block) the stand-in caveat when there is one.
  //
  // A Panel's usable interior is height - 2, not height - 1: one row goes to the
  // title bar and one to the bottom border. Budgeting for height - 1 overflowed
  // the box by a single line, and Ink resolves an overflowing column by drawing
  // children on top of each other — which showed up as one line printed over
  // another rather than as anything recognisable as a height problem.
  const factRows = facts.length > 0 ? 1 : 0;
  const worktreeRows = record.worktree ? 1 : 0;
  const interior = Math.max(0, height - 2);
  // One subtitle row per labeled block (a work session's panes); a single
  // unlabeled block reserves nothing here and carves its caveat line out
  // afterward instead, same as before this was ever more than one block.
  const hasLabels = panePreviews.some((p) => p.label !== null);
  const subtitleRows = hasLabels ? panePreviews.length : 0;
  // Everything left over goes to the summary bodies, so a taller window shows
  // more of them rather than the same truncated lines.
  const bodyRows = Math.max(0, interior - factRows - worktreeRows - 1 - subtitleRows);

  const blocks = buildMultiPreview(panePreviews, textW, bodyRows);
  // The single-unlabeled-block case's caveat sentence isn't accounted for
  // inside buildMultiPreview (only the labeled path renders a subtitle line),
  // so it comes out of that block's own already-fit lines instead.
  const displayBlocks =
    !hasLabels && blocks.length === 1 && blocks[0].standIn
      ? [{ ...blocks[0], lines: blocks[0].lines.slice(0, Math.max(0, bodyRows - 1)) }]
      : blocks;

  return (
    <Panel width={width} height={height} title={title} color={PREVIEW_COLOR}>
      {facts.length > 0 ? (
        factsFit ? (
          <Box>
            {facts.map((f, i) => (
              <React.Fragment key={i}>
                {i > 0 ? <Text dimColor>{"  ·  "}</Text> : null}
                {f === ctxPlaceholder ? (
                  <>
                    <Text color={boxColor}>{"ctx "}</Text>
                    <Text color={ctxBarColor(record.contextPct!)}>
                      {renderBar(record.contextPct! / 100, CTX_BAR_W)}
                    </Text>
                    <Text color={boxColor}>{` ${record.contextPct}%`}</Text>
                  </>
                ) : (
                  <Text color={boxColor}>{f}</Text>
                )}
              </React.Fragment>
            ))}
          </Box>
        ) : (
          // Rare (a very narrow window): fall back to the plain truncated line
          // rather than trying to cut a colour segment mid-bar.
          <Text color={boxColor}>{factsJoined.slice(0, textW)}</Text>
        )
      ) : null}
      {record.worktree ? <Text dimColor>{record.worktree.slice(0, textW)}</Text> : null}
      <Text> </Text>
      {displayBlocks.map((block, i) => (
        <React.Fragment key={block.label ?? i}>
          {block.label ? (
            <Text dimColor>
              {`▸ ${capitalize(block.label)}${
                block.recapAt !== null ? ` · ${formatAge(now - block.recapAt)} ago` : ""
              }`}
            </Text>
          ) : block.standIn ? (
            <Text dimColor>{"no recap yet - showing the last thing it said"}</Text>
          ) : null}
          <PreviewBody lines={block.lines} width={textW} />
        </React.Fragment>
      ))}
    </Panel>
  );
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** A rough traffic light for how full the context window is: plenty of room,
 *  getting full, nearly out. */
function ctxBarColor(pct: number): string {
  if (pct >= 80) return "red";
  if (pct >= 50) return "yellow";
  return "green";
}

/** Runtime in the compact form a status line would use. */
function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ---------------------------------------------------------------------------
// New-session wizard
//
// Only the name is required. Enter takes the default at every step, so the fast
// path is "type a name, Enter, Enter". A step machine rather than a text-input
// library, matching the prior art: Ink has no input widget and this needs none.
// ---------------------------------------------------------------------------

type WizardStep = "class" | "name" | "worktree" | "branch" | "prompt";
type WorktreeChoice = "new" | "adopt" | "none";

/**
 * Rows each step needs, borders and blank lines included.
 *
 * Declared out here because the dashboard has to reserve them before it lays
 * anything out, and it reserves only what the current step uses: a fixed
 * worst-case height would take a third of a 30-row terminal to show a prompt
 * with two lines in it.
 */
export function wizardRows(step: WizardStep): number {
  // Worst case per step, not typical case. An overlarge box leaves one blank row;
  // an undersized one makes Ink drop a line from the MIDDLE of the panel, which
  // is how the line previewing the tmux name disappeared while the hint below it
  // stayed put - a missing row reads as a wording bug, not a sizing one.
  //
  //   name step: border 2, title, blank, name, blank, name preview, note, blank,
  //              hint = 10. The note is "no folder behind this box" or the
  //              adopt warning; the two cannot both appear.
  //   class:     border 2, title, blank, one row per MODE_ORDER entry (4),
  //              blank, hint = 10 (same total as name - one heading row swaps
  //              for four picker rows, since the picker has no name preview).
  //   worktree:  the name-step 10 plus blank, heading, three options = 15.
  //   prompt:    the name-step 10 plus blank, heading, PROMPT_VISIBLE_LINES
  //              input rows, one counter row = 17.
  if (step === "class") return 10;
  if (step === "worktree") return 15;
  if (step === "prompt") return 10 + 2 + PROMPT_VISIBLE_LINES + 1;
  return 10;
}

interface WizardResult {
  label: string;
  slug: string;
  worktree: WorktreeChoice;
  mode: Mode;
  /** Typed at spawn time, empty by default. Drives the opening prompt (see
   *  openingPrompt); for a box with no folder, which otherwise has none, it
   *  becomes the opener outright. */
  extraPrompt: string;
}

function Wizard({
  box,
  mode,
  width,
  height,
  step,
  setStep,
  existingSessions,
  onConfirm,
  onCancel,
}: {
  box: BoxDef;
  /** The class to preset the picker to - and, when `step` starts past
   *  "class" (the `N` fast path), the class the wizard is locked to. */
  mode: Mode;
  /** Full width: the wizard is a panel in the stack, like the preview above it. */
  width: number;
  /** Fixed for the current step, so the box does not jitter as you type. */
  height: number;
  /** Owned by the dashboard, which needs it to reserve the rows this step uses. */
  step: WizardStep;
  setStep: (step: WizardStep) => void;
  existingSessions: ReadonlySet<string>;
  onConfirm: (r: WizardResult) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [classIdx, setClassIdx] = useState(() => Math.max(0, MODE_ORDER.indexOf(mode)));
  const currentMode = MODE_ORDER[classIdx];
  const [wtIdx, setWtIdx] = useState(() => (MODES[currentMode].worktree === "new" ? 0 : 2));
  const [promptValue, setPromptValue] = useState("");

  const slug = sanitizeLabel(value);
  const labelError = validateLabel(value);
  const wtPath = worktreePathFor(box, slug);

  // A box with no folder (or a folder that is not a git repo) has every
  // worktree option resolve to "no folder for this box" and the spawn fails
  // outright. Skip the step rather than offering three choices of which two
  // are impossible and the default is one of them.
  const gitCapable = isGitCapable(box);

  const classification = useMemo(() => {
    if (!slug || labelError) return null;
    return classifyName(slug, {
      box: box.id,
      mode: currentMode,
      existingSessions,
      worktree: wtPath ?? "",
      worktreeExists: (p) => {
        try {
          return p !== "" && fsSync.existsSync(p);
        } catch {
          return false;
        }
      },
    });
  }, [slug, labelError, box, currentMode, existingSessions, wtPath]);

  const sessionExists = classification?.kind === "session-exists";
  const canAdopt = classification?.kind === "adopt";
  // A live session of another class on the same slug already owns that tree and
  // that branch, so adopting would put two Claudes in one worktree. Offered as
  // "nothing to adopt" would be a lie in the other direction, so it names the
  // holder and refuses instead - see classifyName's heldBy.
  const heldBy = classification?.kind === "adopt" ? classification.heldBy : null;
  const options: { key: WorktreeChoice; label: string; hint: string }[] = [
    { key: "new", label: "new", hint: "off origin/main, fast-forwarded first" },
    {
      key: "adopt",
      label: "adopt",
      hint: heldBy
        ? `in use by ${heldBy}`
        : canAdopt
          ? "reuse the worktree already there"
          : "nothing to adopt",
    },
    { key: "none", label: "none", hint: "no git changes at all" },
  ];
  /** Adopting is only offered when there is something abandoned to adopt. */
  const adoptBlocked = (i: number) => options[i].key === "adopt" && (!canAdopt || heldBy !== null);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (step === "class") {
      if (key.upArrow) setClassIdx((i) => Math.max(0, i - 1));
      if (key.downArrow) setClassIdx((i) => Math.min(MODE_ORDER.length - 1, i + 1));
      if (key.return) {
        // The worktree step's own default depends on which class was just
        // picked, so it is set here rather than left at whatever class 0
        // started with.
        setWtIdx(MODES[currentMode].worktree === "new" ? 0 : 2);
        setStep("name");
      }
      return;
    }
    if (step === "name") {
      if (key.return) {
        if (labelError || sessionExists) return;
        // A box with no folder has no worktree step - go straight to the
        // prompt step, which for it is the only thing left to ask.
        setStep(gitCapable ? "worktree" : "prompt");
        return;
      }
      if (key.backspace || key.delete) {
        setValue((v) => v.slice(0, -1));
        return;
      }
      // Free-form: anything printable is accepted and sanitised for the tmux
      // name separately, so the label can read like a sentence.
      if (input && input >= " " && input !== "") setValue((v) => (v + input).slice(0, 60));
      return;
    }
    if (step === "worktree") {
      if (key.upArrow) setWtIdx((i) => Math.max(0, i - 1));
      if (key.downArrow) setWtIdx((i) => Math.min(options.length - 1, i + 1));
      if (key.backspace || key.delete) {
        setStep("name");
        return;
      }
      if (key.return) {
        // Refuse rather than silently downgrade the choice: picking "adopt" on a
        // tree another live session holds is the one selection here that can
        // corrupt work, and guideline is to fail loud instead of guessing which
        // of "new" or "none" was meant.
        if (adoptBlocked(wtIdx)) return;
        setStep("prompt");
      }
      return;
    }
    if (step === "prompt") {
      if (key.return) {
        onConfirm({
          label: value.trim(),
          slug,
          worktree: gitCapable ? options[wtIdx].key : "none",
          mode: currentMode,
          extraPrompt: promptValue.trim(),
        });
        return;
      }
      if (key.backspace || key.delete) {
        // Backspace edits the typed prompt first; only once it is already
        // empty does it fall back to re-picking the previous step, matching
        // the name step's own feel.
        if (promptValue === "") {
          setStep(gitCapable ? "worktree" : "name");
          return;
        }
        setPromptValue((v) => v.slice(0, -1));
        return;
      }
      // Generous but bounded, so a paste storm cannot run away.
      if (input && input >= " " && input !== "\x7f") {
        setPromptValue((v) => (v + input).slice(0, PROMPT_MAX_CHARS));
      }
      return;
    }
  });

  // The wizard's own interior, matching how SessionBox derives its inner width
  // from the panel it sits in (paddingX 1 and a 1-column border on each side).
  //
  // Wrapped one column short of that interior, because the caret is a real
  // character rendered after the last line: at exactly `promptWidth` the row
  // would need promptWidth + 1 columns, Ink would wrap it, and the step would
  // want one row more than wizardRows reserved for it - which under
  // overflow="hidden" silently clips the key hints off the bottom. Reachable at
  // every exact multiple of the wrap width (196 characters on a 200-column
  // terminal), so it is arithmetic rather than an edge case.
  const promptWidth = Math.max(10, width - 4);
  const tailLines = promptTailLines(promptValue, promptWidth - 1, PROMPT_VISIBLE_LINES);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={box.color}
      paddingX={1}
      width={width}
      height={height}
      overflow="hidden"
    >
      {step === "class" ? (
        <>
          <Text bold color={box.color}>
            {`new session · ${box.label}`}
          </Text>
          <Box marginTop={1} flexDirection="column">
            {MODE_ORDER.map((m, i) => (
              <Box key={m}>
                <Text color={i === classIdx ? box.color : undefined}>
                  {i === classIdx ? "▸ " : "  "}
                </Text>
                <Text bold={i === classIdx}>{MODES[m].label.padEnd(11)}</Text>
                <Text dimColor>{MODES[m].hint}</Text>
              </Box>
            ))}
          </Box>
        </>
      ) : (
        <>
          <Text bold color={box.color}>
            {`new ${MODES[currentMode].label} session · ${box.label}`}
          </Text>
          <Box marginTop={1}>
            <Text>{"name  "}</Text>
            <Text>{value}</Text>
            <Text inverse> </Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            {labelError ? (
              <Text color="red">{`⚠ ${labelError}`}</Text>
            ) : sessionExists ? (
              <Text color="red">
                {`⚠ session ${(classification as { tmuxName: string }).tmuxName} already exists - press Esc, then Enter on its row to re-attach`}
              </Text>
            ) : (
              <>
                <Text dimColor>{`→ ${slug ? `cc-${box.id}-${currentMode}-${slug}` : "(type a name)"}`}</Text>
                {!gitCapable ? (
                  <Text dimColor>{"no folder behind this box, so no worktree - ⏎ continues"}</Text>
                ) : null}
                {heldBy ? (
                  <Text color="red">
                    {`⚠ worktree ${wtPath} is in use by ${heldBy} - same slug, different class, one tree. Pick another name, or worktree "none".`}
                  </Text>
                ) : canAdopt ? (
                  <Text color="yellow">{`⚠ worktree ${wtPath} exists with no session - adopt it?`}</Text>
                ) : null}
              </>
            )}
          </Box>
          {step === "worktree" ? (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>worktree</Text>
              {options.map((o, i) => (
                <Box key={o.key}>
                  <Text color={i === wtIdx ? box.color : undefined}>
                    {i === wtIdx ? "▸ " : "  "}
                  </Text>
                  {/* A blocked option still renders, and the cursor can still
                      land on it - it just cannot be taken. Hiding it would make
                      ⏎ appear to do nothing with no visible reason why. */}
                  <Text bold={i === wtIdx} dimColor={adoptBlocked(i)}>
                    {o.label.padEnd(7)}
                  </Text>
                  <Text dimColor color={adoptBlocked(i) && i === wtIdx ? "red" : undefined}>
                    {o.hint}
                  </Text>
                </Box>
              ))}
            </Box>
          ) : null}
          {step === "prompt" ? (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>
                {box.path === null
                  ? "initial prompt (optional - becomes the opener)"
                  : "initial prompt (optional - the session's task)"}
              </Text>
              {tailLines.map((line, i) => (
                <Box key={i}>
                  <Text>{line}</Text>
                  {i === tailLines.length - 1 ? <Text inverse> </Text> : null}
                </Box>
              ))}
              <Box justifyContent="flex-end">
                <Text dimColor>{`${promptValue.length} / ${PROMPT_MAX_CHARS}`}</Text>
              </Box>
            </Box>
          ) : null}
        </>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          {step === "class"
            ? "↑↓ pick   ⏎ next   esc cancel"
            : step === "prompt"
              ? "⏎ create   ⌫ back   esc cancel"
              : step === "worktree"
                ? "↑↓ pick   ⏎ next   ⌫ back   esc cancel"
                : "⏎ next   esc cancel"}
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Box setup panel
//
// Edits config.json at runtime: which boxes exist, where they point, what
// colour they are, plus the notification toggle and branch prefix. It never
// creates a session. Reuses the wizard's step-machine shape: only the name is
// required to advance, Enter takes the current value, Escape backs out.
// ---------------------------------------------------------------------------

type SetupStep = "list" | "path" | "name" | "color";

/** Rows each step needs — see wizardRows's header for why this is declared
 *  rather than measured. */
export function setupRows(step: SetupStep): number {
  // list: border 2, title, blank, up to MAX_BOXES rows, blank, notifications
  //       line, branch-prefix line, one error line, blank, keys = 21.
  if (step === "list") return 2 + 1 + 1 + MAX_BOXES + 1 + 1 + 1 + 1 + 1 + 1;
  // color: border 2, title, blank, grid label, PALETTE_ROWS rows, selected
  //        name line, blank, keys = 15.
  if (step === "color") return 2 + 1 + 1 + 1 + PALETTE_ROWS + 1 + 1 + 1;
  // path / name: border 2, title, blank, field, blank, status/error line,
  //              blank, keys = 9.
  return 9;
}

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Live validation text for the path step. Mirrors what config.ts's
 *  validateConfig will itself decide at save time, so nothing shown here can
 *  contradict a save-time rejection. */
function pathStatusText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "empty: a catch-all box with no folder";
  const resolved = expandTilde(trimmed);
  if (!path.isAbsolute(resolved)) return "must be an absolute path (try starting with / or ~/)";
  let isDir = false;
  try {
    isDir = fsSync.statSync(resolved).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return "not found";
  return isGitRepo(resolved) ? "git repo · worktree features on" : "plain folder · no worktree";
}

function pathIsValid(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === "") return true;
  const resolved = expandTilde(trimmed);
  if (!path.isAbsolute(resolved)) return false;
  try {
    return fsSync.statSync(resolved).isDirectory();
  } catch {
    return false;
  }
}

function SetupPanel({
  config,
  width,
  height,
  step,
  setStep,
  liveSessionsFor,
  onSave,
  onClose,
}: {
  config: Config;
  width: number;
  height: number;
  step: SetupStep;
  setStep: (s: SetupStep) => void;
  /** tmux names of live sessions in a box, for the delete-refusal message. */
  liveSessionsFor: (boxId: string) => string[];
  /** Validates, persists and applies the candidate config. Returns an error
   *  message on rejection (config.ts's validateConfig threw), or null on
   *  success. */
  onSave: (next: Config) => string | null;
  onClose: () => void;
}) {
  const [cursor, setCursor] = useState(0);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [pathValue, setPathValue] = useState("");
  const [nameValue, setNameValue] = useState("");
  const [colorIdx, setColorIdx] = useState(0);
  const [prefixEdit, setPrefixEdit] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isAdd = editIdx === null;
  const boxCount = config.boxes.length;

  const startAdd = () => {
    setEditIdx(null);
    setPathValue("");
    setNameValue("");
    const defaultColor = firstUnusedColor(config.boxes);
    setColorIdx(Math.max(0, PALETTE.findIndex((c) => c.hex === defaultColor)));
    setError(null);
    setStep("path");
  };

  const startEdit = (i: number) => {
    const b = config.boxes[i];
    setEditIdx(i);
    setPathValue(b.path ?? "");
    setNameValue(b.label);
    setColorIdx(Math.max(0, PALETTE.findIndex((c) => c.hex === b.color)));
    setError(null);
    setStep("path");
  };

  const idPreview = isAdd ? sanitizeBoxId(nameValue) : config.boxes[editIdx ?? 0]?.id ?? "";
  const nameIsValid = isAdd
    ? nameValue.trim() !== "" && idPreview !== ""
    : nameValue.trim() !== "";

  const commitBox = () => {
    const box: BoxDef = {
      id: idPreview,
      label: nameValue.trim(),
      color: PALETTE[colorIdx].hex,
      path: pathValue.trim() ? expandTilde(pathValue.trim()) : null,
      // Carried through rather than re-entered: `worktreeRoot` is edited in
      // config.json, not here, so rebuilding the box from the panel's four
      // fields would silently drop it and start scattering worktrees again.
      worktreeRoot: editIdx !== null ? config.boxes[editIdx]?.worktreeRoot ?? null : null,
    };
    const boxes = isAdd
      ? [...config.boxes, box]
      : config.boxes.map((b, i) => (i === editIdx ? box : b));
    const err = onSave({ ...config, boxes });
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setStep("list");
  };

  useInput((input, key) => {
    if (step === "list") {
      if (key.escape) {
        onClose();
        return;
      }
      if (prefixEdit !== null) {
        if (key.return) {
          const err = onSave({ ...config, branchPrefix: prefixEdit });
          setError(err);
          if (!err) setPrefixEdit(null);
          return;
        }
        if (key.backspace || key.delete) {
          setPrefixEdit((v) => v!.slice(0, -1));
          return;
        }
        if (input && input >= " ") setPrefixEdit((v) => (v! + input).slice(0, 60));
        return;
      }
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) setCursor((c) => Math.min(Math.max(0, boxCount - 1), c + 1));
      if (input === "a") {
        if (boxCount >= MAX_BOXES) {
          setError(`already at the ${MAX_BOXES}-box ceiling`);
          return;
        }
        startAdd();
        return;
      }
      if (input === "e" && boxCount > 0) {
        startEdit(cursor);
        return;
      }
      if (input === "d" && boxCount > 0) {
        const target = config.boxes[cursor];
        const holders = liveSessionsFor(target.id);
        if (holders.length > 0) {
          setError(`cannot delete "${target.label}": live sessions ${holders.join(", ")}`);
          return;
        }
        const boxes = config.boxes.filter((_, i) => i !== cursor);
        const err = onSave({ ...config, boxes });
        if (err) setError(err);
        else {
          setError(null);
          setCursor((c) => Math.min(c, Math.max(0, boxes.length - 1)));
        }
        return;
      }
      if (input === "t") {
        const err = onSave({ ...config, notifications: !config.notifications });
        setError(err);
        return;
      }
      if (input === "b") {
        setPrefixEdit(config.branchPrefix);
        setError(null);
      }
      return;
    }

    if (key.escape) {
      setError(null);
      setStep("list");
      return;
    }

    if (step === "path") {
      if (key.return) {
        if (!pathIsValid(pathValue)) return;
        // A fresh add defaults the label to the folder's own basename, so the
        // common case ("point me at a folder") needs no typing at all beyond
        // Enter, Enter.
        if (isAdd && nameValue === "" && pathValue.trim()) {
          setNameValue(path.basename(expandTilde(pathValue.trim())));
        }
        setStep("name");
        return;
      }
      if (key.backspace || key.delete) {
        if (pathValue === "") {
          setStep("list");
          return;
        }
        setPathValue((v) => v.slice(0, -1));
        return;
      }
      if (input && input >= " ") setPathValue((v) => (v + input).slice(0, 200));
      return;
    }

    if (step === "name") {
      if (key.return) {
        if (!nameIsValid) return;
        setStep("color");
        return;
      }
      if (key.backspace || key.delete) {
        if (nameValue === "") {
          setStep("path");
          return;
        }
        setNameValue((v) => v.slice(0, -1));
        return;
      }
      if (input && input >= " ") setNameValue((v) => (v + input).slice(0, 40));
      return;
    }

    if (step === "color") {
      if (key.leftArrow) setColorIdx((i) => (i - 1 + PALETTE.length) % PALETTE.length);
      if (key.rightArrow) setColorIdx((i) => (i + 1) % PALETTE.length);
      if (key.upArrow) setColorIdx((i) => (i - PALETTE_COLS + PALETTE.length) % PALETTE.length);
      if (key.downArrow) setColorIdx((i) => (i + PALETTE_COLS) % PALETTE.length);
      if (key.backspace || key.delete) {
        setStep("name");
        return;
      }
      if (key.return) commitBox();
      return;
    }
  });

  if (step === "list") {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="white"
        paddingX={1}
        width={width}
        height={height}
        overflow="hidden"
      >
        <Text bold>setup</Text>
        <Box marginTop={1} flexDirection="column">
          {config.boxes.map((b, i) => (
            <Box key={b.id}>
              <Text>{i === cursor ? "▸ " : "  "}</Text>
              <Text color={b.color}>{"■ "}</Text>
              <Text bold={i === cursor}>{pad(b.label, 16)}</Text>
              <Text dimColor>{`  ${b.id.padEnd(13)}${b.path ?? "(no folder)"}`}</Text>
            </Box>
          ))}
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>{`notifications: ${config.notifications ? "on" : "off"}  (t to toggle)`}</Text>
          {prefixEdit !== null ? (
            <Box>
              <Text dimColor>{"branch prefix  "}</Text>
              <Text>{prefixEdit}</Text>
              <Text inverse> </Text>
            </Box>
          ) : (
            <Text dimColor>{`branch prefix: ${config.branchPrefix}  (b to edit)`}</Text>
          )}
        </Box>
        {error ? <Text color="red">{`⚠ ${error}`}</Text> : null}
        <Box marginTop={1}>
          <Text dimColor>
            {"↑↓ select   a add   e edit   d delete   t notifications   b branch prefix   esc close"}
          </Text>
        </Box>
      </Box>
    );
  }

  if (step === "color") {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="white"
        paddingX={1}
        width={width}
        height={height}
        overflow="hidden"
      >
        <Text bold>{`${isAdd ? "add" : "edit"} box · colour`}</Text>
        <Box marginTop={1} flexDirection="column">
          {Array.from({ length: PALETTE_ROWS }, (_, row) => (
            <Box key={row}>
              {PALETTE.slice(row * PALETTE_COLS, row * PALETTE_COLS + PALETTE_COLS).map(
                (c, col) => {
                  const idx = row * PALETTE_COLS + col;
                  return (
                    <Text key={c.hex} color={c.hex} inverse={idx === colorIdx}>
                      {"██ "}
                    </Text>
                  );
                },
              )}
            </Box>
          ))}
        </Box>
        <Text color={PALETTE[colorIdx].hex}>{PALETTE[colorIdx].name}</Text>
        {error ? <Text color="red">{`⚠ ${error}`}</Text> : null}
        <Box marginTop={1}>
          <Text dimColor>{"←→↑↓ pick   ⏎ save   ⌫ back   esc cancel"}</Text>
        </Box>
      </Box>
    );
  }

  // path / name
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="white"
      paddingX={1}
      width={width}
      height={height}
      overflow="hidden"
    >
      <Text bold>{`${isAdd ? "add box" : `edit ${config.boxes[editIdx ?? 0]?.label}`}`}</Text>
      <Box marginTop={1}>
        <Text>{step === "path" ? "path  " : "name  "}</Text>
        <Text>{step === "path" ? pathValue : nameValue}</Text>
        <Text inverse> </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {step === "path" ? (
          <Text dimColor={pathIsValid(pathValue)} color={pathIsValid(pathValue) ? undefined : "red"}>
            {pathStatusText(pathValue)}
          </Text>
        ) : (
          <>
            {isAdd ? (
              <Text dimColor>{`→ id: ${idPreview || "(type a name)"}`}</Text>
            ) : (
              <Text dimColor>{`id: ${idPreview} (fixed - delete and re-add to rename)`}</Text>
            )}
          </>
        )}
      </Box>
      {error ? <Text color="red">{`⚠ ${error}`}</Text> : null}
      <Box marginTop={1}>
        <Text dimColor>{"⏎ next   ⌫ back   esc cancel"}</Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/** How long the outcome of an action stays on the footer. Long enough to read
 *  after looking away, short enough that it never lies about the present. */
const NOTICE_MS = 8000;

/** `monitor setup` opens straight into the setup panel, for someone who would
 *  rather configure before looking at a dashboard. */
const FORCE_SETUP = process.argv[2] === "setup";

/** The terminal's size, with the same fallback the module bottom seeds. */
function readTermSize(): { cols: number; rows: number } {
  return { cols: process.stdout.columns ?? 200, rows: process.stdout.rows ?? 50 };
}

/** Erase the current frame. Assigned once the render instance exists; a no-op
 *  before then, which is when nothing has been drawn to erase. */
let clearFrame: () => void = () => {};

function Dashboard() {
  const { exit } = useApp();
  const [config, setConfig] = useState<Config>(() =>
    configExists() ? loadConfig() : defaultConfig(),
  );
  const [view, setView] = useState<"dash" | "wizard" | "confirm-kill" | "setup">(() =>
    !configExists() || FORCE_SETUP ? "setup" : "dash",
  );
  const [setupStep, setSetupStep] = useState<SetupStep>("list");
  const [records, setRecords] = useState<SessionRecord[]>([]);
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [totals, setTotals] = useState<UsageTotals | null>(null);
  const [frame, setFrame] = useState(0);
  const [blinkOn, setBlinkOn] = useState(true);
  const [focus, setFocus] = useState<Focus>(() => initialFocus(config.boxes.map((b) => b.id)));
  // Two separate things, deliberately. `error` is the live state of collection -
  // it is true until the next tick says otherwise, so the tick owns it. `notice`
  // is the outcome of something you just did, and the tick must NOT clear it: it
  // used to, so "no session in this box - press n" could be wiped a fraction of a
  // second after appearing, which reads as the key doing nothing at all.
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; at: number } | null>(null);
  const say = (text: string | null) => setNotice(text ? { text, at: Date.now() } : null);
  const [now, setNow] = useState(() => Date.now());
  const [wizardMode, setWizardMode] = useState<Mode>("work");
  // The wizard step lives here because its height depends on it, and the height
  // has to be known before the panels are laid out. `n` starts at the class
  // picker; `N` presets QUESTIONS and skips straight to naming, which is what
  // keeps its fast path (and smoke/keys.sh's assertions against it) untouched.
  const [wizardStep, setWizardStep] = useState<WizardStep>("class");
  const [busy, setBusy] = useState<string | null>(null);
  /** Up to two blocks for the preview panel — one per pane with a resolved
   *  Claude process, so a work session shows both plan and implement instead
   *  of whichever `panes.find()` happened to land on first. `label` is
   *  "plan"/"implement" for a work session, null for a single-pane session or
   *  the rare case where no pane has resolved a Claude process at all. */
  const [panePreviews, setPanePreviews] = useState<
    Array<{ label: string | null; recap: Recap | null; auto: AutoRecap | null }>
  >([]);
  const [showPreview, setShowPreview] = useState(true);
  const [branches, setBranches] = useState<Record<string, string>>({});
  /** Claude's own recap per session, for the rows. Keyed by tmux name. */
  const [rowRecaps, setRowRecaps] = useState<Record<string, string>>({});
  /** A just-created session to move the cursor onto, once the poll sees it. */
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  /** Sessions running /wrap, to be killed once each goes quiet. */
  const [wraps, setWraps] = useState<Record<string, WrapJob>>({});
  /** An `f` keypress not yet confirmed by the poll. `records` is up to 2s
   *  behind, and this codebase documents that lag as reading like "the key
   *  doing nothing at all" - so the intended value is shown immediately and
   *  folded over the real one in withBranches, the same self-clearing shape
   *  as droppedWraps below. */
  const [pendingFlags, setPendingFlags] = useState<Record<string, boolean>>({});

  const boxIds = useMemo(() => config.boxes.map((b) => b.id), [config.boxes]);
  const boxById = useMemo(() => new Map(config.boxes.map((b) => [b.id, b])), [config.boxes]);
  // Read fresh inside the poll tick without restarting its interval every
  // time the setup panel adds or removes a box.
  const boxIdsRef = useRef(boxIds);
  useEffect(() => {
    boxIdsRef.current = boxIds;
  }, [boxIds]);

  // Terminal size is state, not a value read during render, and a resize wipes
  // the frame before redrawing.
  //
  // Both halves are needed, and neither is obvious. Ink does listen for resize,
  // but its handler only recalculates yoga's layout and re-runs its writer — it
  // does not re-render React, so this component keeps handing back the OLD
  // explicit width/height until some unrelated state change happens to come
  // along. And its writer skips the write entirely when the frame string is
  // unchanged (`output !== lastOutput`), which after a resize it is. Meanwhile
  // the terminal has already reflowed the lines Ink believes it wrote, so its
  // erase count is off by however much the reflow moved them, and the next
  // partial repaint lands over the old frame: a border with a hole in it and a
  // bottom edge drawn across the legend.
  const [term, setTerm] = useState(readTermSize);
  useEffect(() => {
    const onResize = () => {
      clearFrame();
      setTerm(readTermSize());
    };
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);
  const { cols, rows } = term;

  // Main tick: four spawns total, regardless of session count.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const next = await collectSessions(boxIdsRef.current, { now: Date.now() });
        if (!alive) return;
        setRecords(next);
        setNow(Date.now());
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Desktop notifications on status transition. Per pane, not per session's
  // aggregated status - a work session's plan and implement panes run
  // independent Claude processes and notify independently. Runs off the same
  // `records` the main tick already produces, so this piggybacks the 2s poll
  // rather than adding one of its own. Default off; see config.notifications.
  const notifyState = useRef<NotifyStateMap>(new Map());
  useEffect(() => {
    const { nextState, fire } = planNotifications(notifyState.current, records, Date.now());
    notifyState.current = nextState;
    if (!config.notifications) return;
    for (const { record, pane } of fire) {
      void fireNotification(record, pane);
    }
  }, [records, config.notifications]);

  // Usage is slower-moving and costs a directory walk, so it gets its own tick.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const snap = await readUsageSnapshot();
        if (!alive) return;
        setSnapshot(snap);
      } catch (e) {
        if (alive) setError(`usage: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        const t = await sumUsageAcrossTranscripts({ now: Date.now() });
        if (alive) setTotals(t);
      } catch (e) {
        // Token totals are a nicety; never let them take the dashboard down,
        // but do say so rather than silently showing nothing.
        if (alive) setError(`totals: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    void tick();
    const id = setInterval(tick, USAGE_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setFrame((f) => f + 1), SPINNER_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let on = true;
    let timer: NodeJS.Timeout;
    const flip = () => {
      on = !on;
      setBlinkOn(on);
      timer = setTimeout(flip, on ? BLINK_ON_MS : BLINK_OFF_MS);
    };
    timer = setTimeout(flip, BLINK_ON_MS);
    return () => clearTimeout(timer);
  }, []);

  // Fold the slow-tick lookups into the records before rendering, so every
  // consumer sees one shape rather than three half-populated ones. A recap the
  // session published itself is never overwritten by the automatic one.
  const withBranches = useMemo(
    () =>
      records.map((r) => ({
        ...r,
        branch: branches[r.tmuxName] ?? r.branch,
        recap: r.recap ?? rowRecaps[r.tmuxName] ?? null,
        flagged: pendingFlags[r.tmuxName] ?? r.flagged,
      })),
    [records, branches, rowRecaps, pendingFlags],
  );

  const byBox = useMemo(() => {
    const m = new Map<BoxId, SessionRecord[]>();
    for (const id of boxIds) m.set(id, []);
    for (const r of withBranches) m.get(r.box)?.push(r);
    return m;
  }, [withBranches, boxIds]);

  /** Which boxes hold live sessions right now, for the setup panel's delete
   *  refusal. Keyed off the raw poll, not withBranches - a box being deleted
   *  is a config-time decision that has nothing to do with recap/branch
   *  enrichment. */
  const sessionsByBox = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const r of records) (m[r.box] ??= []).push(r.tmuxName);
    return m;
  }, [records]);

  // The cursor's own box is authoritative, so every box is selectable whether or
  // not it holds sessions — which is what makes `n` work on an empty box.
  const rowsInFocusedBox = useMemo(() => boxRows(withBranches, focus.box), [withBranches, focus.box]);
  const focused = focusedRecord(withBranches, focus);
  const focusedBox = boxById.get(focus.box) ?? config.boxes[0];

  // A session dying under the cursor must not leave the row index past the end.
  useEffect(() => {
    setFocus((f) => clampFocus(f, records));
  }, [records]);

  // A box removed in the setup panel must not leave the cursor pointing at a
  // box that no longer exists.
  useEffect(() => {
    setFocus((f) => (boxIds.includes(f.box) ? f : initialFocus(boxIds)));
  }, [boxIds]);

  // Land the cursor on a session we just created, so ⏎ attaches to the thing you
  // were in the middle of making.
  useEffect(() => {
    if (!pendingFocus) return;
    const next = focusFor(records, pendingFocus);
    if (next) {
      setFocus(next);
      setPendingFocus(null);
    }
  }, [records, pendingFocus]);

  const existingSessions = useMemo(
    () => new Set(records.map((r) => r.tmuxName)),
    [records],
  );

  // Mirror every recap change into the journal, which is what survives a reboot
  // once the tmux option holding it is gone.
  const seenRecaps = React.useRef(new Map<string, string | null>());
  useEffect(() => {
    for (const r of records) {
      const prev = seenRecaps.current.get(r.tmuxName) ?? null;
      if (recapChanged(prev, r.recap)) {
        appendHistory({
          at: Date.now(),
          event: "recap",
          tmuxName: r.tmuxName,
          box: r.box,
          mode: r.mode,
          label: r.label,
          worktree: r.worktree,
          recap: r.recap,
        });
      }
      seenRecaps.current.set(r.tmuxName, r.recap);
    }
  }, [records]);

  // Branches on a slow tick: one git call per worktree, which is too expensive
  // for the 2s poll but changes rarely enough that 30s is plenty.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const worktrees = records.filter((r) => r.worktree).map((r) => [r.tmuxName, r.worktree!]);
      const found: Record<string, string> = {};
      for (const [name, wt] of worktrees) {
        const b = await currentBranch(wt);
        if (b) found[name] = b;
      }
      if (alive) setBranches(found);
    };
    void tick();
    const id = setInterval(tick, GIT_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // Keyed on the set of worktrees, so adding a session refreshes promptly
    // without re-running on every 2s poll.
  }, [records.map((r) => r.worktree ?? "").join("|")]);

  // Claude's own recap for EVERY session, not just the focused one, so a row says
  // what its session is doing instead of showing a dash. Same slow tick as the
  // branches: a recap is only rewritten when a session goes idle, and this reads a
  // transcript tail per session, which is too much for the 2s poll.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      const found: Record<string, string> = {};
      for (const r of records) {
        const claude = r.panes.find((p) => p.claude)?.claude;
        if (!claude) continue;
        const auto = autoRecap(claude.cwd, claude.sessionId);
        if (auto?.source === "away") found[r.tmuxName] = auto.text;
      }
      if (alive) setRowRecaps(found);
    };
    tick();
    const id = setInterval(tick, GIT_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // Keyed on the sessions present, not on every poll: the tick is cheap but not
    // free, and the recaps it reads change on the order of minutes.
  }, [records.map((r) => r.tmuxName).join("|")]);

  // Everything the preview shows about the focused session, on its own tick.
  //
  // Two file reads and no tmux calls. capture-pane used to run here as a fallback
  // and it was actively harmful: the bottom of a pane is the status line HUD, so
  // the preview filled with context bars and "auto mode on" instead of anything
  // about the work.
  const focusedName = focused?.tmuxName ?? null;
  const focusedCreated = focused?.createdAt ?? null;
  const panesWithClaude = focused?.panes.filter((p) => p.claude) ?? [];
  // A stable string, not the pane/record objects themselves - `focused` is a
  // new reference every poll tick even when nothing about it changed, and
  // depending on it directly would re-run this effect every 2s instead of
  // only when a pane's Claude process actually changes identity.
  const paneClaudeKey = panesWithClaude
    .map((p) => `${p.paneIndex}:${p.claude!.cwd}:${p.claude!.sessionId}`)
    .join("|");

  useEffect(() => {
    if (!focusedName || !showPreview) {
      setPanePreviews([]);
      return;
    }
    let alive = true;
    const tick = () => {
      // A published recap is session-level (`cc-recap` does not distinguish
      // panes), so the same one is compared against each pane's own
      // away-summary - whichever is fresher wins for that pane.
      const published = readRecap(focusedName, { notBefore: focusedCreated });
      if (!alive) return;
      if (panesWithClaude.length === 0) {
        // No pane has a resolved Claude process at all (e.g. a dead session) -
        // still worth showing whatever was published before it died.
        setPanePreviews([{ label: null, recap: published, auto: null }]);
        return;
      }
      setPanePreviews(
        panesWithClaude.map((p) => ({
          label: focused ? paneLabelFor(focused, p.paneIndex) : null,
          recap: published,
          auto: autoRecap(p.claude!.cwd, p.claude!.sessionId),
        })),
      );
    };
    tick();
    const id = setInterval(tick, PREVIEW_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [focusedName, focusedCreated, paneClaudeKey, showPreview]);

  // A pending flag clears itself once the poll agrees with it, or once the
  // session it named is gone - the same self-clearing shape as droppedWraps
  // just below, for the same reason: records is up to a poll old, so nothing
  // else would ever remove the entry.
  useEffect(() => {
    setPendingFlags((p) => {
      if (Object.keys(p).length === 0) return p;
      let changed = false;
      const next = { ...p };
      for (const [tmuxName, wanted] of Object.entries(p)) {
        const record = records.find((r) => r.tmuxName === tmuxName);
        if (!record || record.flagged === wanted) {
          delete next[tmuxName];
          changed = true;
        }
      }
      return changed ? next : p;
    });
  }, [records]);

  const toggleFlag = (target: SessionRecord) => {
    const next = !target.flagged;
    setPendingFlags((p) => ({ ...p, [target.tmuxName]: next }));
    void (next ? setOption(target.tmuxName, OPT_FLAG, FLAG_ON) : unsetOption(target.tmuxName, OPT_FLAG)).then(
      (ok) => {
        if (ok) return;
        setPendingFlags((p) => {
          const copy = { ...p };
          delete copy[target.tmuxName];
          return copy;
        });
        say(`could not ${next ? "flag" : "unflag"} ${target.label}`);
      },
    );
  };

  /**
   * Sessions whose wrap we have deliberately stopped tracking.
   *
   * `records` is up to a poll old, so for one tick after we unset `@cc_wrap` the
   * option is still in the snapshot. Without this, dropping a job and then
   * re-adopting it from that stale copy would spin. Entries clear themselves
   * once the snapshot catches up.
   */
  const droppedWraps = useRef<Set<string>>(new Set());

  const dropWrap = (tmuxName: string) => {
    droppedWraps.current.add(tmuxName);
    setWraps((w) => {
      if (!w[tmuxName]) return w;
      const next = { ...w };
      delete next[tmuxName];
      return next;
    });
  };

  const kill = (target: SessionRecord) => {
    setBusy(`killing ${target.label}`);
    void killSession(target.tmuxName, {
      tmuxName: target.tmuxName,
      box: target.box,
      mode: target.mode,
      label: target.label,
      worktree: target.worktree,
      recap: target.recap,
    }).then((err) => {
      setBusy(null);
      // No unsetOption: the session is gone and took its options with it.
      dropWrap(target.tmuxName);
      if (err) say(err);
    });
  };

  /**
   * Send `/wrap` to one pane and let the poll loop advance to the next once it
   * goes quiet - or kill the session, if there is no next pane.
   *
   * The job is written to the tmux session as well as to state. A wrap runs for
   * minutes, and anything that ends this process in that window - a crash, or
   * simply relaunching to pick up an edit - used to drop the pending kill on the
   * floor with no notice. On the session it survives us.
   */
  const runWrapStep = (target: SessionRecord, pane: number, next: number | null) => {
    void sendWrap(target.tmuxName, pane).then((err) => {
      if (err) {
        say(err);
        return;
      }
      const pending = { pane, next, sentAt: Date.now() };
      void setOption(target.tmuxName, OPT_WRAP, encodeWrap(pending));
      setWraps((w) => ({
        ...w,
        [target.tmuxName]: { tmuxName: target.tmuxName, label: target.label, ...pending },
      }));
    });
  };

  /**
   * Start the wrap sequence: plan pane first, then implement.
   *
   * One pane at a time. Both panes of a work session wrapping at once would be
   * two Claudes writing into the same inbox simultaneously, which is a known
   * way to lose one of the two notes - and wrapping plan first means its note
   * exists before implement's wrap folds in whatever fixes and review rounds
   * happened after planning.
   */
  const startWrap = (target: SessionRecord) => {
    const order = wrapOrder(target.panes);
    const [pane, ...rest] = order;
    if (pane === undefined) {
      // Nothing alive in there to wrap, so there is nothing to wait for either.
      kill(target);
      return;
    }
    runWrapStep(target, pane, rest[0] ?? null);
  };

  // A wrap outlives the dashboard that started it. The job rides the tmux
  // session, so a relaunch mid-wrap - a crash, or just restarting to pick up an
  // edit - picks the wait back up instead of leaving a wrapped session alive
  // forever with nothing listening for it to go quiet.
  //
  // Watch only. The persisted job means `/wrap` was already sent; sending it
  // again would queue a second one behind the first and write the note twice.
  useEffect(() => {
    const stillPending = new Set(records.filter((r) => r.wrap).map((r) => r.tmuxName));
    for (const name of droppedWraps.current) {
      if (!stillPending.has(name)) droppedWraps.current.delete(name);
    }

    const now = Date.now();
    for (const record of records) {
      const pending = record.wrap;
      if (!pending) continue;
      if (wraps[record.tmuxName] || droppedWraps.current.has(record.tmuxName)) continue;
      if (now - pending.sentAt >= WRAP_TIMEOUT_MS) {
        // Old enough that the wrap is long over and the session may well have
        // been picked back up since. Report it rather than kill on a guess.
        droppedWraps.current.add(record.tmuxName);
        void unsetOption(record.tmuxName, OPT_WRAP);
        say(`${record.label}: dropped a stale pending wrap, session left alive`);
        continue;
      }
      setWraps((w) => ({
        ...w,
        [record.tmuxName]: { tmuxName: record.tmuxName, label: record.label, ...pending },
      }));
    }
  }, [records, wraps]);

  // Outstanding wraps, checked once per poll. A wrap that stalls leaves its
  // session alive: killing mid-wrap would destroy the note the wrap exists to
  // write, which is the whole point of doing this at all.
  useEffect(() => {
    const jobs = Object.values(wraps);
    if (jobs.length === 0) return;
    const now = Date.now();
    for (const job of jobs) {
      const record = records.find((r) => r.tmuxName === job.tmuxName);
      if (!record) {
        // Gone by other means - killed from a terminal, or the server restarted.
        dropWrap(job.tmuxName);
        continue;
      }
      // The pane THIS job is waiting on, not the session's worst-of-both-panes
      // status - the other pane sitting on a stale "awaiting" or "permission"
      // must not read as the wrap itself being stuck or errored.
      const paneStatus = record.panes.find((p) => p.paneIndex === job.pane)?.status ?? "dead";
      const step = decideWrap(job, paneStatus, now);
      if (step.kind === "kill") {
        if (job.next !== null) runWrapStep(record, job.next, null);
        else kill(record);
      } else if (step.kind === "giveup") {
        say(step.reason);
        // Unset as well as untrack, so the next dashboard does not adopt a job
        // this one already decided to abandon.
        void unsetOption(job.tmuxName, OPT_WRAP);
        dropWrap(job.tmuxName);
      }
    }
  }, [records, wraps]);

  // Ink's useInput needs raw mode, which is unavailable when stdin is piped or
  // redirected. Guarding lets the dashboard still render in that case (a smoke
  // test, or a terminal that does not hand over a TTY) instead of throwing.
  const { isRawModeSupported } = useStdin();
  const interactive = isRawModeSupported && Boolean(process.stdin.isTTY);
  useInput(
    (input, key) => {
      if (view === "confirm-kill") {
        if ((input === "y" || input === "w") && focused) {
          const target = focused;
          const wrapFirst = input === "w";
          setView("dash");
          if (wrapFirst) startWrap(target);
          else kill(target);
        } else {
          setView("dash");
        }
        return;
      }

      if (input === "q") {
        exit();
        return;
      }
      // Up/down walks the rows of the selected box; left/right steps between
      // boxes. Both always land somewhere, including on a box with no sessions.
      if (key.downArrow || input === "j") {
        setFocus((f) => moveRow(f, 1, rowsInFocusedBox.length));
      }
      if (key.upArrow || input === "k") {
        setFocus((f) => moveRow(f, -1, rowsInFocusedBox.length));
      }
      if (key.rightArrow || input === "l") setFocus((f) => moveBox(f, 1, boxIds));
      if (key.leftArrow || input === "h") setFocus((f) => moveBox(f, -1, boxIds));
      if (input === "p") setShowPreview((v) => !v);

      if (input === "n" || input === "N") {
        // N keeps its original meaning - preset to QUESTIONS and skip the
        // class step entirely - so the existing fast path, and the smoke test
        // that drives it, are untouched. n opens on the class picker.
        setWizardMode(input === "N" ? "q" : "work");
        setWizardStep(input === "N" ? "name" : "class");
        setView("wizard");
        return;
      }

      if (input === "S") {
        setSetupStep("list");
        setView("setup");
        return;
      }

      if (input === "f" && focused) {
        toggleFlag(focused);
        return;
      }

      if (key.return || input === "a") {
        if (!focused) {
          say(`no session in ${focusedBox.label} - press n to create one`);
          return;
        }
        if (input === "a") {
          // In-place: the dashboard gives up its own terminal until you detach.
          // Kept for the case where there is no window server to open into - over
          // ssh, or in a terminal this cannot drive.
          void attachSession(focused.tmuxName).then((err) => {
            if (err) say(err);
          });
          return;
        }
        // Default: a new window, so the board stays up next to the session
        // instead of being replaced by it.
        const target = focused;
        setBusy(`opening ${target.label}`);
        void openInNewTerminal(target.tmuxName).then((res) => {
          setBusy(null);
          if (!res.ok) say(res.error ?? "could not open a window");
          else say(res.note ?? null);
        });
        return;
      }

      if (input === "x" && focused) setView("confirm-kill");
    },
    // Only one handler may be live at a time. Ink delivers every keystroke to
    // every active useInput, so leaving this one on while the wizard or setup
    // panel is open sent the name you were typing here as well: an "x" opened
    // the kill prompt, a "q" quit the app outright, and Enter attached to
    // whatever the cursor was on instead of advancing the other panel's step.
    { isActive: interactive && view !== "wizard" && view !== "setup" },
  );

  const onWizardConfirm = (r: WizardResult) => {
    setView("dash");
    setBusy(`creating ${r.label}`);
    void spawnSession({
      box: focusedBox,
      mode: r.mode,
      label: r.label,
      slug: r.slug,
      worktree: r.worktree,
      branchPrefix: config.branchPrefix,
      extraPrompt: r.extraPrompt,
    }).then((res) => {
      if (!res.ok) {
        setBusy(null);
        say(res.error ?? "spawn failed");
        return;
      }
      setPendingFocus(res.tmuxName);
      say(res.notes.length > 0 ? res.notes.join(" · ") : null);
      // Creating a session means you want to be in it. The window opens straight
      // away rather than waiting for a second keystroke; the dashboard stays up
      // behind it either way, so this costs nothing if you would rather look at
      // the board first.
      setBusy(`opening ${r.label}`);
      void openInNewTerminal(res.tmuxName).then((open) => {
        setBusy(null);
        // A failure here is worth saying, but the session itself is fine and is
        // already listed - so it is a note, not a spawn failure.
        if (!open.ok) say(open.error ?? `created ${r.label}, but could not open a window`);
      });
    });
  };

  const onSetupSave = (next: Config): string | null => {
    try {
      const validated = validateConfig(next);
      saveConfig(validated);
      setConfig(validated);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  const layout = arrange(cols, rows, boxIds);
  const counts = Object.fromEntries(
    boxIds.map((id) => [id, (byBox.get(id) ?? []).length]),
  ) as Record<BoxId, number>;

  // A prompt gets its rows reserved before anything else is laid out, and only as
  // many as its current step needs - see wizardRows/setupRows.
  // Border 2, the question, the reassurance, a blank, the keys - plus one spare,
  // for the same reason wizardRows takes the worst case.
  const KILL_PROMPT_ROWS = 7;
  const modalRows =
    view === "wizard"
      ? wizardRows(wizardStep)
      : view === "setup"
        ? setupRows(setupStep)
        : view === "confirm-kill" && focused
          ? KILL_PROMPT_ROWS
          : 0;

  // Title row + 3 content rows (limits, tokens, models) + bottom border. Fixed
  // rather than scaled with terminal height: unlike the boxes below it, this
  // panel's content no longer grows past three lines, so giving it more would
  // only leave a blank row.
  const globalH = 5;
  const split = panelSplit(rows, globalH, showPreview ? previewRows(rows) : 0, modalRows);
  const previewH = split.previewRows;
  const heights = boxHeights(counts, boxIds, split.boxesRows, layout.mode);

  const awaiting = records.filter(
    (r) => r.status === "awaiting" || r.status === "permission",
  ).length;

  const wrapLabels = Object.values(wraps).map((w) => w.label);

  // A notice outlives a poll tick but not the screen: it fades on its own so the
  // footer does not accumulate stale outcomes. `now` advances on every tick, so
  // no extra timer is needed.
  const freshNotice = notice && now - notice.at < NOTICE_MS ? notice.text : null;
  const message = freshNotice ?? error;
  const messageIsError = freshNotice === null && error !== null;

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      {layout.rows.map((row, i) => {
        if (row.kind === "global") {
          return (
            <GlobalBox
              key="global"
              width={cols}
              height={globalH}
              snapshot={snapshot}
              totals={totals}
              now={now}
              sessionCount={records.length}
              awaiting={awaiting}
            />
          );
        }
        if (row.kind === "preview") {
          return (
            <PreviewBox
              key="preview"
              width={cols}
              height={previewH}
              record={focused}
              boxColor={focused ? boxById.get(focused.box)?.color ?? "white" : "white"}
              panePreviews={panePreviews}
              now={now}
              hidden={!showPreview}
            />
          );
        }
        const colWidth = Math.floor(cols / row.columns.length);
        return (
          <Box key={`boxes-${i}`} flexDirection="row">
            {row.columns.map((col, ci) => (
              <Box key={ci} flexDirection="column" width={colWidth}>
                {col.boxes.map((id) => {
                  const def = boxById.get(id);
                  if (!def) return null;
                  return (
                    <SessionBox
                      key={id}
                      def={def}
                      width={colWidth}
                      height={heights[id]}
                      records={byBox.get(id) ?? []}
                      focusedName={focused?.tmuxName ?? null}
                      selected={id === focus.box}
                      frame={frame}
                      blinkOn={blinkOn}
                    />
                  );
                })}
              </Box>
            ))}
          </Box>
        );
      })}

      {/* Prompts sit in the column, under the preview, as another panel in the
          stack — so the board and the preview stay readable while you type.
          flexShrink={0} is load-bearing: as an ordinary flex sibling inside a
          fixed-height frame the wizard was what Ink shrank, which silently ate
          the line previewing the tmux name it was about to create and drew its
          key hints into its own bottom border. Its rows are reserved in
          panelSplit above and it refuses to give them back. */}
      {view === "wizard" ? (
        <Box flexShrink={0}>
          <Wizard
            box={focusedBox}
            mode={wizardMode}
            width={cols}
            height={wizardRows(wizardStep)}
            step={wizardStep}
            setStep={setWizardStep}
            existingSessions={existingSessions}
            onConfirm={onWizardConfirm}
            onCancel={() => setView("dash")}
          />
        </Box>
      ) : null}

      {view === "setup" ? (
        <Box flexShrink={0}>
          <SetupPanel
            config={config}
            width={cols}
            height={setupRows(setupStep)}
            step={setupStep}
            setStep={setSetupStep}
            liveSessionsFor={(id) => sessionsByBox[id] ?? []}
            onSave={onSetupSave}
            onClose={() => setView("dash")}
          />
        </Box>
      ) : null}

      {view === "confirm-kill" && focused ? (
        <Box flexShrink={0}>
          <Box
            borderStyle="round"
            borderColor="red"
            paddingX={1}
            width={cols}
            height={KILL_PROMPT_ROWS}
            flexDirection="column"
          >
            <Text>{`Kill ${focused.label}?`}</Text>
            <Text dimColor>
              {"The tmux session only - the worktree and branch are left alone."}
            </Text>
            <Box marginTop={1}>
              <Text bold color="green">
                {"w"}
              </Text>
              <Text dimColor>{" wrap first, then kill when it goes quiet    "}</Text>
              <Text bold>{"y"}</Text>
              <Text dimColor>{" kill now    any key cancels"}</Text>
            </Box>
          </Box>
        </Box>
      ) : null}

      <Box>
        <Text dimColor>{" ↑↓ session  ←→ box  ⏎ new window  a attach here  f flag  "}</Text>
        {/* Name the target box: `n` acts on the selection, not on the cursor's
            session, and that is only obvious if it says so. */}
        <Text color={focusedBox.color}>{`n new in ${focusedBox.label}  N question`}</Text>
        <Text dimColor>{"  S setup  x kill  p preview  q quit"}</Text>
        {busy ? <Text color="yellow">{`  ${busy}...`}</Text> : null}
        {/* A wrap can run for minutes, so say what is being waited on rather than
            leaving a session that looks alive but is about to be killed. */}
        {wrapLabels.length > 0 ? (
          <Text color="green">{`  wrapping ${wrapLabels.join(", ")} before kill...`}</Text>
        ) : null}
        {message ? <Text color={messageIsError ? "red" : "yellow"}>{`  ${message}`}</Text> : null}
      </Box>

    </Box>
  );
}

// Ink derives layout width from process.stdout.columns. When that is unset -
// piped output, or a pty that does not report a size - ink@6 falls back to
// terminal-size, which leaks a /dev/tty handle per render until the process
// runs out of memory. The pinned ink@5 has no such fallback, but seed a size
// anyway so that path can never run and the UI still renders usefully when
// stdout is not a sized TTY.
if (!process.stdout.columns) {
  process.stdout.columns = 200;
  process.stdout.rows = 50;
}

const app = render(<Dashboard />);

// Wired after render, because the dashboard needs to wipe the frame on resize and
// only the render instance can: its `clear()` goes through Ink's own writer and
// resets the line bookkeeping, where writing an escape sequence ourselves would
// leave that bookkeeping pointing at rows we had just erased.
clearFrame = () => app.clear();
