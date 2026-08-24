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

Required on every platform:

| Tool | Why |
|---|---|
| `tmux` | Sessions are real tmux sessions. The dashboard is a view over them. |
| `node` 18+ | The dashboard runs on `tsx`, with no build step. |
| `claude` | Claude Code itself, on `PATH`. |
| `git` | Needed for any box you point at a repository. A box with no folder needs none. |

Optional. Each one fails open, so a missing one degrades a single feature and
never breaks the dashboard:

| Tool | What it buys |
|---|---|
| `jq` | The plan-handoff hook. Without it, an approved plan does not cross to the implementation pane. |
| `terminal-notifier` (macOS) | Desktop notifications. |
| `notify-send` (Linux) | Desktop notifications. |
| `xdotool` (Linux) | Lets `⏎` raise a session's existing window. Without it, `⏎` reports that one is already open and opens nothing. |

## Platform support

**macOS and Linux are supported.** Windows is supported through WSL2 only.

- **macOS.** `⏎` opens a window in Terminal.app, and raises an existing one by
  tty. This is the platform the tool was written on.
- **Linux.** Verified on GNOME/X11. `⏎` opens a window in the first emulator it
  finds on `PATH`: ghostty, WezTerm, kitty, Alacritty, gnome-terminal, Konsole,
  xfce4-terminal, xterm, then `x-terminal-emulator`. The order is preference,
  not `PATH` order. `$CLAUDE_MONITOR_TERMINAL` names one explicitly, or gives a
  full command template containing `{}` for an emulator that list has never
  heard of.
  - Wayland is untried. `xdotool` is X11-only, so under Wayland `⏎` declines to
    raise an already-open window rather than opening a duplicate. A second tmux
    client would clamp the session to the smaller window for both.
- **Windows, through WSL2.** Inside WSL2 this is a Linux box, so the Linux
  instructions below apply unchanged. See the WSL2 notes for the one setting
  that needs adding. This route is reasoned from the code rather than tested:
  the Linux support it rests on was verified on real hardware, but nobody has
  yet run the dashboard inside WSL2. Treat it as untested until someone does.
- **Native Windows is not supported, and is not a small gap.** tmux is the
  state store and has no native Windows build; all 18 shell-out sites compose
  commands for a POSIX shell, with quoting that `cmd.exe` reads as literal
  characters; and the six entry points and hooks are bash scripts. Running any
  of it outside a POSIX environment would mean rewriting the shell layer, not
  adding a branch.

## Install

The install is the same on macOS, Linux, and WSL2. Only the prerequisites and
the shell file you write `PATH` into differ, so those are split out below.

### 1. Clone

```sh
git clone https://github.com/ThomasZhang223/claude-monitor.git ~/claude-monitor
```

### 2. Install the prerequisites

**macOS**

```sh
brew install tmux node git jq terminal-notifier
```

**Linux (Debian/Ubuntu) and WSL2**

```sh
sudo apt update
sudo apt install -y tmux nodejs git jq libnotify-bin xdotool
```

Check the node version before you go on. Older Ubuntu releases package a
`nodejs` below the 18 minimum, and you need a newer one from NodeSource or a
version manager if `node --version` comes back under 18.

Install `claude` itself by whichever route you already use. Check every
prerequisite resolved:

```sh
for b in tmux node git claude; do command -v "$b" || echo "MISSING: $b"; done
```

### 3. Symlink the three entry points

`~/.local/bin` may not exist yet, and `ln` will not create it:

```sh
mkdir -p ~/.local/bin
ln -s ~/claude-monitor/bin/monitor        ~/.local/bin/monitor
ln -s ~/claude-monitor/bin/monitor-attach ~/.local/bin/monitor-attach
ln -s ~/claude-monitor/bin/cc-recap       ~/.local/bin/cc-recap
```

The symlink name is yours to choose. If you already have a `monitor` on `PATH`,
link these under a different name instead. Nothing in the repo assumes the
command is called `monitor`. Only the `bin/` filenames and the
`~/.local/share/claude-monitor` state directory are fixed.

Keep `monitor-attach` linked even if you never run it by hand. Clicking a
desktop notification runs it.

### 4. Put `~/.local/bin` on `PATH`

**macOS** — zsh is the default shell:

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

**Linux and WSL2** — bash is the usual default:

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

If your shell is neither, write the same `export` line into its own startup
file. Confirm it took:

```sh
command -v monitor
```

### 5. WSL2 only: name a terminal for `⏎`

A WSL2 box usually has none of the nine Linux emulators installed, so `⏎`
reports that it cannot open a window and points you at `a` to attach in place.
Everything else works without this step.

To make `⏎` open a real Windows Terminal window, give it a command template.
The `{}` is replaced with the shell-quoted attach command:

```sh
echo "export CLAUDE_MONITOR_TERMINAL='wt.exe wsl.exe -- sh -c {}'" >> ~/.bashrc
source ~/.bashrc
```

Two WSL2 limits worth knowing before you rely on it:

- `xdotool` cannot see a Windows window, so `⏎` on a session that is already
  open reports "already open in another window" instead of raising it.
- Desktop notifications need a notification daemon inside WSL2. Without one,
  `notify-send` is missing or silent, and the dashboard says so once and
  carries on.

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
    { "id": "app",     "label": "app",     "color": "#7FFFD4", "path": "/Users/me/code/app" },
    {
      "id": "umbrella",
      "label": "umbrella",
      "color": "#87CEFA",
      "path": "/Users/me/code/umbrella",
      "worktreeRoot": "/Users/me/worktrees"
    }
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
- `worktreeRoot` — optional, an absolute directory to collect this box's
  worktrees in. Worktrees default to a sibling of the box's folder
  (`<folder>_<slug>`), which is wrong whenever those siblings must not be
  polluted: an umbrella checkout sits among the repos it coordinates, and a box
  on `~/src` would drop worktrees straight into your home directory. The
  directory is created on first use. Edit it in `config.json`, not in the setup
  panel — the panel carries the existing value through rather than dropping it.

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
| `⏎` | Open the cursor's session in a new terminal window (raises it if already open) |
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
