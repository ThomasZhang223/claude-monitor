# claude-monitor (`monitor`)

A TUI dashboard over tmux-hosted Claude Code sessions. One word, from any
directory, shows every live session grouped into boxes you define — one per
folder you work in — with a global usage header and a preview of whatever is
waiting on you.

## Why

Running many concurrent Claude Code sessions across several projects (one
worktree per issue) has two problems:

1. **No overview.** Which sessions exist, on what branch, doing what — and
   crucially, which one is blocked waiting on *me*? A finished session is
   invisible until you go look.
2. **Context ballooning.** A session that does research -> plan -> implement
   -> review -> merge in one thread burns through its context. Splitting plan
   from implement fixes this, but only if spawning the pair is one keystroke
   and the approved plan crosses over to the implementation pane
   automatically.

`monitor` is a standalone tool that observes whatever folders you point it at,
so it lives in none of them.

## Prerequisites

- `tmux` — sessions are real tmux sessions; the dashboard is a view over them.
- `node` (18+) and `claude` (Claude Code) on `PATH`.
- `git`, for any box you point at a repository. A box with no folder needs none.
- Optional: `terminal-notifier` (`brew install terminal-notifier`) for desktop
  notifications, and `jq` for the plan-handoff hook. Both fail open if missing.

## Install

```sh
git clone <this-repo> ~/claude-monitor
ln -s ~/claude-monitor/bin/monitor ~/.local/bin/monitor
ln -s ~/claude-monitor/bin/monitor-attach ~/.local/bin/monitor-attach
ln -s ~/claude-monitor/bin/cc-recap ~/.local/bin/cc-recap
```

The symlink name is yours to choose — if you already have a `monitor` on
`PATH`, link these under a different name instead. Nothing in the repo assumes
the command is called `monitor`; only the `bin/` filenames and the
`~/.local/share/claude-monitor` state directory are fixed.

Make sure `~/.local/bin` (or wherever you linked to) is on `PATH`.

## First run

```sh
monitor
```

With no `config.json` yet, this opens straight into the **setup panel**
instead of an empty dashboard. Press `a` to add a box: give it a path (or
leave it empty for a catch-all box with no folder), a name, and a colour.
`esc` returns to the dashboard. Run `monitor setup` any time afterward to
reopen the panel directly, without looking at the dashboard first.

## How it works

TypeScript + React + [Ink](https://github.com/vadimdemedes/ink) v5, run via
`tsx`, no build step. `core/` is pure logic covered by unit tests; `tui/` is
layout, animation and keybindings only.

- **`config.json`, beside the code**, holds your boxes (id, label, colour,
  folder path), the branch prefix, and the notification toggle. It is
  gitignored — see [Configuration](#configuration) below.
- **tmux is the state store.** Session names encode box + mode
  (`cc-<box>-<mode>-<slug>`), and live metadata (label, recap, worktree,
  created-at, plan) rides on tmux user options, which die exactly when the
  session does — nothing to go stale or orphan.
- **Status detection is layered, most-authoritative source first:** Claude
  Code's own `~/.claude/sessions/<pid>.json`, then pid liveness, then the
  session's own transcript mtime, then hook-written status files, and only
  last a pane-text scrape for permission prompts.
- **One keystroke spawns a plan|implement pane pair.** A box with a folder
  behind it gets a fresh git worktree, fast-forwarded off `origin/main` first;
  a box with no folder starts at your home directory.
- **Plan handoff is automatic.** A `PostToolUse` hook on `ExitPlanMode` reads
  the approved plan and nudges the implementation pane to start on it, so
  approving a plan in the left pane is enough to kick off the right one.
- **Desktop notifications** on per-pane status transitions (not just a
  worst-of-both session summary), off by default — turn them on in the setup
  panel. Clicking one raises the right terminal window instead of opening a
  duplicate.
- **Usage tracking** via a statusline wrapper (`hooks/statusline-tee.sh`),
  since 5-hour/7-day rate-limit percentages only ever arrive in a live
  session's statusline payload and are discarded once whatever renders your
  status line has drawn them.

## Configuration

`config.json` lives in the repo root, next to the code — not under
`~/.config` — so `import.meta.url` resolves it wherever the repo is cloned. It
is gitignored; `config.example.json` documents the shape:

```json
{
  "version": 1,
  "branchPrefix": "cc",
  "notifications": false,
  "boxes": [
    { "id": "general", "label": "general", "color": "#C9A227", "path": null },
    { "id": "app",     "label": "app",     "color": "#7FFFD4", "path": "/Users/me/code/app" }
  ]
}
```

- `id` — `[a-z0-9]{1,12}`, no hyphens (session names split on `-`). Immutable
  once created; renaming means deleting the box and adding it again.
- `label` — free text, shown as the box's title.
- `color` — `#RRGGBB`. The setup panel's colour grid deliberately excludes red
  and magenta, which are the permission/awaiting status colours.
- `path` — an absolute path to an existing directory, or `null` for a
  catch-all box with no folder. A box whose folder is a git repository gets
  worktree support automatically; a plain folder does not.

Everything else (whether a box is git-capable, a session's worktree path, its
branch) is derived at use time from `path`, never stored, so nothing here can
go stale.

Edit the config by hand or through the setup panel (`S` from the dashboard, or
`monitor setup`) — both write the same file, and a save from the panel
re-renders the dashboard immediately, no restart needed.

`$CLAUDE_MONITOR_CONFIG` overrides the config path — set by every test and
smoke script, so none of them ever touch your real boxes.

## Layout

```
bin/       Entry points (monitor, monitor-attach, cc-recap)
core/      Pure logic: config, tmux parsing, status detection, spawning
tui/       Ink TUI: dashboard, wizard, setup panel, preview pane
hooks/     Shell hooks wired into ~/.claude/settings.json (plan handoff,
           statusline tee, session status)
smoke/     Real tmux/git/Claude-process end-to-end tests (see smoke/README.md)
```

## Hook wiring

Add to `~/.claude/settings.json` (paths point at wherever you cloned this
repo):

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/claude-monitor/hooks/statusline-tee.sh"
  },
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "~/claude-monitor/hooks/session-status.sh working" }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "~/claude-monitor/hooks/session-status.sh working" }] }],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "~/claude-monitor/hooks/session-status.sh working" }] },
      { "matcher": "ExitPlanMode", "hooks": [{ "type": "command", "command": "~/claude-monitor/hooks/plan-handoff.sh" }] }
    ],
    "Stop": [{ "hooks": [{ "type": "command", "command": "~/claude-monitor/hooks/session-status.sh awaiting" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "~/claude-monitor/hooks/session-status.sh ended" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "~/claude-monitor/hooks/session-status.sh notification" }] }]
  }
}
```

If you already run your own statusline renderer, set
`$CLAUDE_MONITOR_STATUSLINE` to its path (or drop a script at
`~/.claude/hooks/statusline-inner.sh`) and `statusline-tee.sh` delegates to it
after publishing the usage data this tool reads — usage and rate-limit
tracking work with no inner statusline at all, delegation exists only so you
keep seeing your own.

## Keybindings

| Key | Action |
|---|---|
| `↑↓` / `j k` | Move within the selected box |
| `←→` / `h l` | Move between boxes |
| `⏎` | Open the cursor's session in a new terminal window |
| `a` | Attach in place (gives up the dashboard's own terminal until you detach) |
| `n` | New session in the selected box (class picker first) |
| `N` | New QUESTIONS session, straight to naming |
| `f` | Flag/unflag the cursor's session |
| `x` | Kill (with an option to `/wrap` first) |
| `p` | Toggle the preview pane |
| `S` | Open the setup panel |
| `q` | Quit the dashboard (sessions keep running) |

## Usage

```sh
bin/monitor          # launch the dashboard
bin/monitor setup    # launch straight into the setup panel
```

Sessions are real tmux sessions, so they outlive both the dashboard and the
terminal that launched it — killing the dashboard never kills your work.

## Testing

```sh
npm --prefix core test    # unit tests
npm run typecheck         # core/ + tui/
npm run smoke             # real tmux/worktree/Claude-process e2e (see smoke/README.md)
```

Unit tests cover pure logic against an injectable exec seam. The smoke suite
exists because the input layer and hook payloads have repeatedly broken in
ways unit tests with synthetic fixtures did not catch — see `smoke/README.md`
for the specific bugs each one guards against.
